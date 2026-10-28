// The loyalty ledger. Append-only: balances are always derived from rows (never from a mutable counter), every write carries an idempotency
// key, and a member's writes in one programme are serialised by an advisory lock (with a database trigger as the backstop).
// A row with delta > 0 opens a lot (earn, restore, bonus, adjust, exchange_in); a row with delta < 0 draws a lot down.
import { parseRules } from './rules.js';
import { isYouth } from '../youth.js';

const lock = (c, programmeId, userId) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`loyalty:${programmeId}:${userId}`]);
export const lockMember = lock;

const DAY = 86_400_000;
const windowStart = (per, now = new Date()) => {
  if (per === 'day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (per === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (per === 'year') return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return new Date(0);
};

/** A programme with its published rules. `at` picks a historical version (default: the current one). */
export async function loadProgramme(c, programmeId, { version } = {}) {
  const p = (await c.query('SELECT * FROM loyalty_programmes WHERE id=$1', [programmeId])).rows[0];
  if (!p) return null;
  const v = (await c.query('SELECT * FROM loyalty_programme_versions WHERE programme_id=$1 AND version=$2', [programmeId, version ?? p.current_version])).rows[0];
  return { ...p, rules: v ? parseRules(v.rules) : null, version: v?.version ?? null, starts_at: v?.starts_at ?? null, ends_at: v?.ends_at ?? null };
}

/** Earning is live: published, active, and inside the campaign window. (Redeeming existing balances is allowed in more states, see redeemable.) */
export const earningLive = (p, now = new Date()) => !!p && p.status === 'active' && p.version != null && (!p.starts_at || p.starts_at <= now) && (!p.ends_at || p.ends_at > now);
export const redeemable = (p) => !!p && p.version != null && ['active', 'paused', 'ended'].includes(p.status);

export async function openLots(c, programmeId, userId, { includeExpired = false } = {}) {
  return (await c.query(
    `SELECT * FROM loyalty_lots_open WHERE programme_id=$1 AND user_id=$2 AND remaining > 0 ${includeExpired ? '' : 'AND expires_at > now()'} ORDER BY expires_at, created_at, id`, [programmeId, userId])).rows;
}

export const balanceOf = async (c, programmeId, userId) => Number((await c.query('SELECT coalesce(sum(remaining),0) AS n FROM loyalty_lots_open WHERE programme_id=$1 AND user_id=$2 AND remaining > 0 AND expires_at > now()', [programmeId, userId])).rows[0].n);

const COLS = 'programme_id, user_id, kind, delta, lot_id, expires_at, version, rule_key, source_type, source_id, funding_owner, sponsorship_id, idempotency_key, reason, actor_id';
async function insert(c, r) {
  const row = (await c.query(
    `INSERT INTO loyalty_ledger (${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [r.programmeId, r.userId, r.kind, r.delta, r.lotId ?? null, r.expiresAt ?? null, r.version ?? null, r.ruleKey ?? null, r.sourceType ?? null, r.sourceId == null ? null : String(r.sourceId),
      r.fundingOwner ?? null, r.sponsorshipId ?? null, r.key, r.reason ?? null, r.actorId ?? null])).rows[0];
  return row ?? null;
}

/** Open a lot. Returns the new row, or null when this idempotency key was already used (a replay does nothing). */
export async function openLot(c, o) {
  await lock(c, o.programmeId, o.userId);
  return insert(c, { ...o, delta: o.points, expiresAt: o.expiresAt });
}

/**
 * Draw `points` from a member's lots, earliest expiry first (or from the given lots). One ledger row per lot, keyed `${key}:${lotId}`.
 * Returns { taken, rows, replayed }. A replay (the key was used before) returns what was taken then and writes nothing.
 */
export async function draw(c, { programmeId, userId, points, kind, key, sourceType, sourceId, reason, actorId, lots, ruleKey, version }) {
  await lock(c, programmeId, userId);
  const prior = (await c.query('SELECT * FROM loyalty_ledger WHERE starts_with(idempotency_key, $1) ORDER BY seq', [`${key}:`])).rows;
  if (prior.length) return { taken: prior.reduce((s, r) => s - r.delta, 0), rows: prior, replayed: true };
  const pool_ = lots ?? await openLots(c, programmeId, userId);
  let left = points; const rows = [];
  for (const l of pool_) {
    if (left <= 0) break;
    const take = Math.min(left, l.remaining);
    if (take <= 0) continue;
    const r = await insert(c, { programmeId, userId, kind, delta: -take, lotId: l.id, key: `${key}:${l.id}`, sourceType, sourceId, reason, actorId, ruleKey, version, fundingOwner: l.funding_owner });
    if (r) { rows.push(r); left -= take; }
  }
  return { taken: points - left, rows, replayed: false };
}

/** Points ever issued by the programme (earn, bonus, adjust): the figure a budget cap is held against. Restores and exchanges are not new issuance. */
export const issuedTotal = async (c, programmeId) => Number((await c.query("SELECT coalesce(sum(delta),0) AS n FROM loyalty_ledger WHERE programme_id=$1 AND delta > 0 AND kind IN ('earn','bonus','adjust')", [programmeId])).rows[0].n);
const issuedSince = async (c, programmeId, userId, since, ruleKey) => Number((await c.query(
  "SELECT coalesce(sum(delta),0) AS n FROM loyalty_ledger WHERE programme_id=$1 AND user_id=$2 AND delta > 0 AND kind IN ('earn','bonus') AND created_at >= $3 AND ($4::text IS NULL OR rule_key=$4)", [programmeId, userId, since, ruleKey ?? null])).rows[0].n);

/** Is a sponsor-funded programme still backed by an active sponsorship, and is there budget left? Returns the remaining points or Infinity. */
export async function fundingRoom(c, p) {
  if (p.funding_owner !== 'sponsor') return Infinity;
  const s = (await c.query("SELECT amount_cents, currency, status, ends_on FROM sponsorships WHERE id=$1", [p.sponsorship_id])).rows[0];
  if (!s || s.status !== 'active' || (s.ends_on && new Date(s.ends_on) < new Date(new Date().toDateString())) || s.currency !== p.currency) return 0;
  return Math.max(0, Number(s.amount_cents) - await issuedTotal(c, p.id));
}

/** Can this person take part? Young people follow the programme's youth rule, and only through a live guardian link. */
export async function eligible(c, p, userId) {
  if (await isYouth(userId, c)) {
    if (p.rules.eligibility.youth !== 'guardian_linked') return 'youth';
    const link = (await c.query("SELECT 1 FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [userId])).rowCount;
    if (!link) return 'youth_no_guardian';
  }
  return null;
}

const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };

/**
 * Issue points under a programme's published rules. Refuses (returns { row: null, reason }) when earning is not live, the member is not
 * eligible, a cap is reached, or the sponsor funding is gone. Idempotent per key.
 */
export async function award(c, p, { userId, points, kind = 'earn', ruleKey, sourceType, sourceId, key, reason, actorId, ignoreCaps = false }) {
  if (!(points > 0)) return { row: null, reason: 'nothing_to_award' };
  if (!earningLive(p)) return { row: null, reason: 'programme_not_live' };
  const why = await eligible(c, p, userId);
  if (why) return { row: null, reason: why };
  await lock(c, p.id, userId);
  const rule = p.rules.earn.find((r) => r.key === ruleKey);
  let n = points;
  if (!ignoreCaps) {
    if (rule?.max_points_per_award) n = Math.min(n, rule.max_points_per_award);
    if (rule?.member_cap) n = Math.min(n, rule.member_cap.points - await issuedSince(c, p.id, userId, windowStart(rule.member_cap.per), ruleKey));
    if (p.rules.caps.member_points_per_month) n = Math.min(n, p.rules.caps.member_points_per_month - await issuedSince(c, p.id, userId, windowStart('month')));
    if (p.rules.caps.programme_points_total) n = Math.min(n, p.rules.caps.programme_points_total - await issuedTotal(c, p.id));
  }
  n = Math.min(n, await fundingRoom(c, p));
  if (!(n > 0)) return { row: null, reason: 'cap_reached' };
  const row = await openLot(c, { programmeId: p.id, userId, kind, points: n, expiresAt: addMonths(new Date(), p.rules.expiry_months), version: p.version, ruleKey, sourceType, sourceId, key, reason, actorId, fundingOwner: p.funding_owner, sponsorshipId: p.sponsorship_id });
  return row ? { row } : { row: null, reason: 'already_awarded' };
}

/** Take back what an earn source gave (refund / cancelled booking), as far as those points are still there. Never chases spent points into the negative. */
export async function clawBack(c, { sourceType, sourceId, ratioNum, ratioDen, key, reason }) {
  const earned = (await c.query("SELECT * FROM loyalty_ledger WHERE source_type=$1 AND source_id=$2 AND kind='earn' ORDER BY seq", [sourceType, String(sourceId)])).rows;
  let total = 0;
  for (const e of earned) {
    const want = ratioDen > 0 ? Math.floor((e.delta * Math.min(ratioNum, ratioDen)) / ratioDen) : e.delta;
    const already = Number((await c.query("SELECT coalesce(-sum(delta),0) AS n FROM loyalty_ledger WHERE lot_id=$1 AND kind='clawback'", [e.id])).rows[0].n);
    const need = Math.min(want - already, e.delta);
    if (need <= 0) continue;
    await lock(c, e.programme_id, e.user_id);
    const left = Number((await c.query('SELECT remaining FROM loyalty_lots_open WHERE id=$1', [e.id])).rows[0].remaining);
    const take = Math.min(need, left);
    if (take <= 0) continue;
    const r = await draw(c, { programmeId: e.programme_id, userId: e.user_id, points: take, kind: 'clawback', key: `${key}:${e.id}:${already}`, sourceType, sourceId, reason, lots: [{ id: e.id, remaining: left, funding_owner: e.funding_owner }] });
    total += r.taken;
  }
  return total;
}

/** Zero out lots past their expiry, one 'expire' row per lot. Idempotent. Returns the points expired. */
export async function expireDue(c) {
  const due = (await c.query('SELECT * FROM loyalty_lots_open WHERE remaining > 0 AND expires_at <= now() ORDER BY expires_at LIMIT 2000')).rows;
  let total = 0;
  for (const l of due) {
    const r = await draw(c, { programmeId: l.programme_id, userId: l.user_id, points: l.remaining, kind: 'expire', key: `expire:${l.id}`, reason: 'Points expired', lots: [l] });
    total += r.taken;
  }
  return total;
}

/** Programme-level liability view: what has been issued, spent, expired (breakage), reversed, and what is still owed. 1 point = 1 minor unit. */
export async function liability(c, programmeId, { from, to } = {}) {
  const flow = (await c.query(
    `SELECT coalesce(sum(delta) FILTER (WHERE kind IN ('earn','bonus','adjust','exchange_in') AND delta > 0),0)::bigint AS issued,
            coalesce(sum(delta) FILTER (WHERE kind='restore'),0)::bigint AS restored,
            coalesce(-sum(delta) FILTER (WHERE kind='redeem'),0)::bigint AS redeemed,
            coalesce(-sum(delta) FILTER (WHERE kind='clawback'),0)::bigint AS clawed_back,
            coalesce(-sum(delta) FILTER (WHERE kind='expire'),0)::bigint AS expired,
            coalesce(-sum(delta) FILTER (WHERE kind='exchange_out'),0)::bigint AS exchanged_out,
            coalesce(-sum(delta) FILTER (WHERE kind='adjust' AND delta < 0),0)::bigint AS adjusted_down
       FROM loyalty_ledger WHERE programme_id=$1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)`, [programmeId, from ?? null, to ?? null])).rows[0];
  const out = (await c.query(
    `SELECT count(DISTINCT user_id)::int AS members, coalesce(sum(remaining),0)::bigint AS points,
            coalesce(sum(remaining) FILTER (WHERE expires_at < now() + interval '30 days'),0)::bigint AS expiring_30d,
            coalesce(sum(remaining) FILTER (WHERE funding_owner='sponsor'),0)::bigint AS sponsor_funded,
            coalesce(sum(remaining) FILTER (WHERE funding_owner='platform'),0)::bigint AS platform_funded,
            coalesce(sum(remaining) FILTER (WHERE funding_owner='owner'),0)::bigint AS owner_funded
       FROM loyalty_lots_open WHERE programme_id=$1 AND remaining > 0 AND expires_at > now()`, [programmeId])).rows[0];
  const issued = Number(flow.issued) + Number(flow.restored);
  const closed = Number(flow.expired);
  return {
    issued: Number(flow.issued), restored: Number(flow.restored), redeemed: Number(flow.redeemed), clawed_back: Number(flow.clawed_back), expired: Number(flow.expired),
    exchanged_out: Number(flow.exchanged_out), adjusted_down: Number(flow.adjusted_down),
    outstanding: { members: out.members, points: Number(out.points), value_minor: Number(out.points), expiring_30d: Number(out.expiring_30d), by_funding: { owner: Number(out.owner_funded), platform: Number(out.platform_funded), sponsor: Number(out.sponsor_funded) } },
    breakage_bp: issued > 0 ? Math.round((closed / issued) * 10000) : 0,
  };
}
export { DAY };
