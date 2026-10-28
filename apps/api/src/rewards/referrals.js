// Referrals: revocable codes with attribution -> an invited person claims one -> a qualifying event they complete -> a holdback -> the reward.
// Self-referral and referral rings are refused; duplicate-account signals and bursts are held for a person to review. Nothing here rewards a signup alone.
import { randomBytes } from 'node:crypto';
import { audit } from '../helpers.js';
import { conflict, notFound } from '../errors.js';
import { isYouth } from '../youth.js';
import { notify } from '../notify.js';
import { award, loadProgramme, earningLive, clawBack } from './ledger.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(randomBytes(8), (x) => ALPHABET[x % ALPHABET.length]).join('');
export const normaliseCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const requireReferralProgramme = async (c, programmeId) => {
  const p = await loadProgramme(c, programmeId);
  if (!p) throw notFound('Programme');
  if (!p.rules?.referral.enabled || !earningLive(p)) throw conflict('This programme is not running referrals right now');
  return p;
};

export async function createCode(c, user, { programmeId, campaign, source, maxUses, expiresAt }) {
  const p = await requireReferralProgramme(c, programmeId);
  if (await isYouth(user.id, c)) throw conflict('Young people cannot invite others by public code');
  const have = Number((await c.query('SELECT count(*) AS n FROM loyalty_referral_codes WHERE programme_id=$1 AND referrer_id=$2 AND revoked_at IS NULL', [programmeId, user.id])).rows[0].n);
  if (have >= 20) throw conflict('You already have 20 live codes in this programme; revoke one first');
  for (let tries = 0; tries < 5; tries++) {
    const row = (await c.query(
      `INSERT INTO loyalty_referral_codes(programme_id, referrer_id, code, campaign, source, max_uses, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [p.id, user.id, newCode(), campaign ?? null, source ?? null, maxUses ?? null, expiresAt ?? null])).rows[0];
    if (row) return row;
  }
  throw conflict('Could not generate a code; try again');
}

export async function revokeCode(c, user, codeId) {
  const row = (await c.query('UPDATE loyalty_referral_codes SET revoked_at = now() WHERE id=$1 AND referrer_id=$2 AND revoked_at IS NULL RETURNING *', [codeId, user.id])).rows[0];
  if (!row) throw notFound('Code');
  return row;
}

/** Everyone `userId` was (transitively) invited by, nearest first. A ring exists if the person being invited is among them. */
async function ancestors(c, programmeId, userId) {
  const { rows } = await c.query(
    `WITH RECURSIVE up(user_id, depth) AS (
       SELECT referrer_id, 1 FROM loyalty_referrals WHERE programme_id=$1 AND invitee_id=$2 AND status NOT IN ('blocked','void')
       UNION SELECT r.referrer_id, up.depth + 1 FROM up JOIN loyalty_referrals r ON r.programme_id=$1 AND r.invitee_id = up.user_id AND r.status NOT IN ('blocked','void') WHERE up.depth < 12)
     SELECT DISTINCT user_id FROM up`, [programmeId, userId]);
  return new Set(rows.map((r) => r.user_id));
}

/** Signals that two accounts are one person: a shared device (strong), or the same network within a day of each other's sign-up (weak). */
async function duplicateSignals(c, a, b) {
  const flags = [];
  const dev = (await c.query('SELECT 1 FROM sync_devices x JOIN sync_devices y ON y.device_id = x.device_id WHERE x.user_id=$1 AND y.user_id=$2 LIMIT 1', [a, b])).rowCount;
  if (dev) flags.push('shared_device');
  const net = (await c.query(
    `SELECT 1 FROM auth_sessions x JOIN auth_sessions y ON y.ip = x.ip AND y.user_agent = x.user_agent WHERE x.user_id=$1 AND y.user_id=$2 AND x.ip IS NOT NULL LIMIT 1`, [a, b])).rowCount;
  if (net) flags.push('shared_network');
  return flags;
}

/** An invited person enters a code. Returns the referral (status 'registered', or 'held' when it needs a person's review). Refused outright: self-referral, rings, repeats. */
export async function claim(c, user, rawCode) {
  const code = (await c.query('SELECT * FROM loyalty_referral_codes WHERE code=$1', [normaliseCode(rawCode)])).rows[0];
  if (!code || code.revoked_at || (code.expires_at && code.expires_at < new Date())) throw notFound('Code');
  const p = await requireReferralProgramme(c, code.programme_id);
  const rule = p.rules.referral;
  if (code.referrer_id === user.id) { await audit(c, user.id, 'loyalty_referral_self_blocked', 'loyalty_referral_codes', code.id); throw conflict('You cannot use your own code'); }
  if (await isYouth(user.id, c) || await isYouth(code.referrer_id, c)) throw conflict('Referral rewards are not available to young people');
  const me = (await c.query('SELECT created_at FROM users WHERE id=$1', [user.id])).rows[0];
  if (Date.now() - new Date(me.created_at).getTime() > rule.claim_window_days * 86_400_000) throw conflict(`Codes must be entered within ${rule.claim_window_days} days of signing up`);
  if ((await c.query('SELECT 1 FROM loyalty_referrals WHERE programme_id=$1 AND invitee_id=$2', [p.id, user.id])).rowCount) throw conflict('You have already used a referral code here');
  if (code.max_uses) {
    const used = Number((await c.query("SELECT count(*) AS n FROM loyalty_referrals WHERE code_id=$1 AND status <> 'blocked'", [code.id])).rows[0].n);
    if (used >= code.max_uses) throw conflict('That code has been used the most times it allows');
  }
  const total = Number((await c.query("SELECT count(*) AS n FROM loyalty_referrals WHERE programme_id=$1 AND referrer_id=$2 AND status NOT IN ('blocked','void')", [p.id, code.referrer_id])).rows[0].n);
  if (total >= rule.max_referrals_per_member) throw conflict('This member has reached the referral limit for this programme');
  // rings: the person being invited already (transitively) invited the referrer, or the two invited each other
  if ((await ancestors(c, p.id, code.referrer_id)).has(user.id)) {
    await audit(c, user.id, 'loyalty_referral_ring_blocked', 'loyalty_referral_codes', code.id);
    throw conflict('That code cannot be used: it would make a referral loop');
  }
  const flags = await duplicateSignals(c, code.referrer_id, user.id);
  const day = Number((await c.query("SELECT count(*) AS n FROM loyalty_referrals WHERE programme_id=$1 AND referrer_id=$2 AND created_at > now() - interval '1 day'", [p.id, code.referrer_id])).rows[0].n);
  if (day >= rule.daily_velocity_flag) flags.push('velocity');
  // a shared network alone is recorded but not held (households, offices and campuses share one); a shared device or a burst is held for a person to review
  const hold = flags.some((f) => f !== 'shared_network');
  const row = (await c.query(
    'INSERT INTO loyalty_referrals(programme_id, code_id, referrer_id, invitee_id, status, flags, version) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [p.id, code.id, code.referrer_id, user.id, hold ? 'held' : 'registered', flags, p.version])).rows[0];
  return row;
}

/** An activity just happened for `a.userId`: does it qualify one of their open referrals? */
export async function qualifyReferrals(c, a, { inScope }) {
  const { rows } = await c.query("SELECT * FROM loyalty_referrals WHERE invitee_id=$1 AND status IN ('registered','held') AND qualified_at IS NULL", [a.userId]);
  for (const r of rows) {
    const p = await loadProgramme(c, r.programme_id, { version: r.version });
    const rule = p?.rules.referral;
    if (!rule?.enabled || rule.qualifying_event !== a.type || !inScope(p, a) || (a.amountMinor ?? 0) < rule.min_spend_minor) continue;
    if (a.currency && a.currency !== p.currency) continue;
    const release = new Date(Date.now() + rule.holdback_days * 86_400_000);
    await c.query('UPDATE loyalty_referrals SET qualified_at=now(), qualifying_source_type=$2, qualifying_source_id=$3, release_at=$4, status = CASE WHEN status=\'held\' THEN \'held\' ELSE \'qualified\' END WHERE id=$1', [r.id, a.sourceType, String(a.sourceId), release]);
    if (r.status === 'registered' && rule.holdback_days === 0) await releaseReferral(c, r.id);
  }
}

/** Pay both sides. Re-checks eligibility and the live programme at release; rewards are keyed by referral so a retry pays once. */
export async function releaseReferral(c, referralId) {
  const r = (await c.query("SELECT * FROM loyalty_referrals WHERE id=$1 AND status IN ('qualified') FOR UPDATE", [referralId])).rows[0];
  if (!r) return false;
  const p = await loadProgramme(c, r.programme_id);               // the live programme: a paused or ended one no longer issues
  const rule = p.rules.referral;
  if (!earningLive(p)) return false;
  let any = false;
  for (const [side, userId, points] of [['referrer', r.referrer_id, rule.referrer_points], ['invitee', r.invitee_id, rule.invitee_points]]) {
    if (points <= 0) continue;
    const { row } = await award(c, p, { userId, points, ruleKey: 'referral', sourceType: 'referral', sourceId: r.id, key: `referral:${r.id}:${side}`, reason: side === 'referrer' ? 'A friend you invited took part' : 'Welcome reward for joining through an invite' });
    if (row) { any = true; await notify(c, userId, { kind: 'loyalty_earned', title: `You earned ${row.delta} ${p.unit} · ${p.name}`, body: side === 'referrer' ? 'Someone you invited completed their first qualifying activity.' : 'Thanks for joining through an invite.', data: { programme_id: p.id }, dedupe_key: `loyalty:${row.id}` }); }
  }
  await c.query("UPDATE loyalty_referrals SET status='rewarded', rewarded_at=now() WHERE id=$1", [r.id]);
  return any;
}

/** Worker sweep: release rewards whose holdback has passed and whose qualifying payment is still standing. */
export async function releaseDueReferrals(c) {
  const { rows } = await c.query("SELECT id FROM loyalty_referrals WHERE status='qualified' AND release_at <= now() ORDER BY release_at LIMIT 200");
  let n = 0;
  for (const r of rows) if (await releaseReferral(c, r.id)) n++;
  return n;
}

/** The thing that qualified a referral was refunded in full: a waiting reward is cancelled, a paid one is taken back as far as it is unspent. */
export async function voidReferralsFor(c, sourceType, sourceId) {
  const { rows } = await c.query("SELECT * FROM loyalty_referrals WHERE qualifying_source_type=$1 AND qualifying_source_id=$2 AND status IN ('qualified','held','rewarded')", [sourceType, String(sourceId)]);
  for (const r of rows) {
    if (r.status === 'rewarded') await clawBack(c, { sourceType: 'referral', sourceId: r.id, ratioNum: 1, ratioDen: 1, key: `clawback:referral:${r.id}`, reason: 'The qualifying payment was refunded' });
    await c.query("UPDATE loyalty_referrals SET status='void', flags = array_append(flags, 'qualifying_payment_refunded') WHERE id=$1", [r.id]);
  }
  return rows.length;
}

/** A programme manager reviews a held referral (flagged by a duplicate-account or velocity signal). */
export async function review(c, user, referralId, decision, note) {
  const r = (await c.query("SELECT * FROM loyalty_referrals WHERE id=$1 AND status='held' FOR UPDATE", [referralId])).rows[0];
  if (!r) throw notFound('Held referral');
  if (decision === 'reject') {
    await c.query("UPDATE loyalty_referrals SET status='blocked', reviewed_by=$2, review_note=$3 WHERE id=$1", [r.id, user.id, note]);
  } else {
    const next = r.qualified_at ? 'qualified' : 'registered';
    await c.query('UPDATE loyalty_referrals SET status=$4, reviewed_by=$2, review_note=$3 WHERE id=$1', [r.id, user.id, note, next]);
    if (next === 'qualified' && (!r.release_at || r.release_at <= new Date())) await releaseReferral(c, r.id);
  }
  await audit(c, user.id, `loyalty_referral_${decision}`, 'loyalty_referrals', r.id);
  return (await c.query('SELECT * FROM loyalty_referrals WHERE id=$1', [r.id])).rows[0];
}
