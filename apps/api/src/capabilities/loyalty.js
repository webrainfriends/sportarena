// Loyalty & referral engine (issue #509): programmes owned by the platform, a venue, an organisation (academy / club), a coach or an event;
// versioned published rules; an append-only ledger; redemption on canonical bills; referrals; liability reporting. See docs/loyalty.md.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { canManage } from '../booking/engine.js';
import { orgRole, hasOrgGrant } from '../org-access.js';
import { isSupportedCurrency, toMajor } from '../currency.js';
import { notify } from '../notify.js';
import { rulesSchema, parseRules, checkScope, EARN_EVENTS, EARN_SHORT, REDEEM_PURPOSES, OWNER_EVENTS, OWNER_PURPOSES } from '../rewards/rules.js';
import { loadProgramme, openLots, balanceOf, award, draw, openLot, lockMember, liability, fundingRoom, earningLive, eligible, redeemable } from '../rewards/ledger.js';
import { redeem, quote } from '../rewards/redeem.js';
import * as referrals from '../rewards/referrals.js';

const TAG = 'Loyalty';
const OWNER_KINDS = ['platform', 'venue', 'organisation', 'coach', 'event'];
const KIND_LABEL = { earn: 'Earned', bonus: 'Bonus', restore: 'Restored', adjust: 'Adjustment', exchange_in: 'Exchanged in', redeem: 'Spent', clawback: 'Taken back', expire: 'Expired', exchange_out: 'Exchanged out', legacy_use: 'Used before the unified ledger' };
/** Read-only handle that runs the engine's helpers on the pool (they take a client-like object). */
const db = { query: async (q, a) => { const rows = await many(q, a); return { rows, rowCount: rows.length }; } };
const member = { user_id: id.optional(), user_handle: z.string().min(3).max(24).optional() };
const findMember = async (c, i) => {
  if (!i.user_id && !i.user_handle) throw badRequest('Choose the member (user_id or user_handle)');
  const t = (await c.query(i.user_id ? 'SELECT id FROM users WHERE id=$1' : 'SELECT id FROM users WHERE handle=$1', [i.user_id ?? i.user_handle.toLowerCase()])).rows[0];
  if (!t) throw notFound('User');
  return t;
};
const dayStart = (d) => (d ? new Date(`${d}T00:00:00Z`) : null);
const dayAfter = (d) => (d ? new Date(new Date(`${d}T00:00:00Z`).getTime() + 86_400_000) : null);

const OWNER_NAME = `CASE p.owner_kind WHEN 'venue' THEN (SELECT name FROM venues WHERE id=p.owner_id) WHEN 'organisation' THEN (SELECT name FROM organisations WHERE id=p.owner_id)
  WHEN 'coach' THEN (SELECT display_name FROM users WHERE id=p.owner_id) WHEN 'event' THEN (SELECT name FROM events WHERE id=p.owner_id) ELSE 'Gotmygame' END`;
const PROGRAMME_COLS = `p.id, p.owner_kind, p.owner_id, p.slug, p.name, p.unit, p.currency, p.funding_owner, p.sponsorship_id, p.status, p.current_version, p.created_at, ${OWNER_NAME} AS owner_name`;

/** Who runs a programme. Outsiders get a 404, never a hint that it exists. Money rules (publish, adjust, pause) need an owner/admin; finance may read. */
async function canRun(c, user, p, write) {
  if (isAdmin(user)) return true;
  if (p.owner_kind === 'venue') return canManage(user, p.owner_id, c);
  if (p.owner_kind === 'organisation') { const r = await orgRole(user, p.owner_id, c); return !!r && (write ? ['owner', 'admin'] : ['owner', 'admin', 'finance']).includes(r); }
  if (p.owner_kind === 'coach') return p.owner_id === user.id;
  if (p.owner_kind === 'event') {
    const ev = (await c.query('SELECT organizer_id, organisation_id FROM events WHERE id=$1', [p.owner_id])).rows[0];
    return !!ev && (ev.organizer_id === user.id || await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c));
  }
  return false;
}
async function mustRun(c, user, programmeId, { write = false, lock = false } = {}) {
  const p = (await c.query(`SELECT * FROM loyalty_programmes WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [programmeId])).rows[0];
  if (!p || !(await canRun(c, user, p, write))) throw notFound('Programme');
  return p;
}

/** A sponsor funds a programme only through an active sponsorship agreement that names this owner as its recipient, in the programme's currency. */
async function checkSponsorship(c, user, p, sponsorshipId) {
  const s = (await c.query("SELECT id, target_type, target_id, currency, status, ends_on FROM sponsorships WHERE id=$1", [sponsorshipId])).rows[0];
  if (!s || s.status !== 'active') throw badRequest('That sponsorship is not an active agreement');
  if (s.ends_on && new Date(s.ends_on) < new Date(new Date().toDateString())) throw badRequest('That sponsorship has ended');
  if (s.currency !== p.currency) throw badRequest(`The sponsorship is in ${s.currency}; the programme is in ${p.currency}`);
  let ok = isAdmin(user) && p.owner_kind === 'platform';
  if (p.owner_kind === 'event') ok = s.target_type === 'event' && s.target_id === p.owner_id;
  if (p.owner_kind === 'organisation') ok = (s.target_type === 'organisation' && s.target_id === p.owner_id) || (s.target_type === 'event' && !!(await c.query('SELECT 1 FROM events WHERE id=$1 AND organisation_id=$2', [s.target_id, p.owner_id])).rowCount);
  if (p.owner_kind === 'venue') ok = s.target_type === 'organisation' && !!(await c.query('SELECT 1 FROM venues WHERE id=$1 AND organisation_id=$2', [p.owner_id, s.target_id])).rowCount;
  if (!ok) throw forbidden('That sponsorship agreement does not name this programme owner as its recipient');
  return s;
}

const summary = (p) => {
  const r = p.rules;
  return {
    earn: r.earn.map((e) => ({ key: e.key, event: e.event, event_label: EARN_EVENTS[e.event], label: e.label ?? null, mode: e.mode, percent_bp: e.percent_bp ?? null, points: e.points ?? null, min_spend_minor: e.min_spend_minor })),
    redeem: { max_redeem_bp: r.redeem.max_redeem_bp, min_points: r.redeem.min_points, purposes: r.redeem.purposes.map((x) => ({ key: x, label: REDEEM_PURPOSES[x] })), restore_on_cancel: r.redeem.restore_on_cancel },
    expiry_months: r.expiry_months, referral: r.referral.enabled ? { qualifying_event: r.referral.qualifying_event, qualifying_label: EARN_EVENTS[r.referral.qualifying_event], referrer_points: r.referral.referrer_points, invitee_points: r.referral.invitee_points, min_spend_minor: r.referral.min_spend_minor, holdback_days: r.referral.holdback_days } : null,
    youth: r.eligibility.youth,
  };
};

// ================================================================================================================ member: balances
cap({
  name: 'get_loyalty', method: 'GET', path: '/me/loyalty', tag: TAG,
  summary: 'Your points and credits, one balance per programme (a venue, academy, coach, event or the platform). 1 point = 1 minor unit of the programme currency. Balances never mix between programmes.',
  handler: ({ user }) => many(
    `SELECT ${PROGRAMME_COLS}, CASE WHEN p.owner_kind='venue' THEN p.owner_id END AS venue_id, (SELECT emoji FROM venues WHERE id=p.owner_id AND p.owner_kind='venue') AS emoji,
            sum(l.remaining)::int AS points, sum(l.remaining)::int AS value_minor,
            coalesce(sum(l.remaining) FILTER (WHERE l.expires_at < now() + interval '30 days'), 0)::int AS expiring_soon, min(l.expires_at) AS next_expiry
       FROM loyalty_lots_open l JOIN loyalty_programmes p ON p.id=l.programme_id
      WHERE l.user_id=$1 AND l.remaining > 0 AND l.expires_at > now() GROUP BY p.id ORDER BY points DESC, p.name`, [user.id]),
});

cap({
  name: 'loyalty_history', method: 'GET', path: '/me/loyalty/history', tag: TAG,
  summary: 'Your statement for one programme or all: what you earned and why, what you spent where, what expired or was taken back, newest first. Includes the earlier venue statement from before the unified ledger.',
  input: z.object({ programme_id: id.optional(), venue_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT g.id, g.programme_id, p.name AS programme_name, CASE WHEN p.owner_kind='venue' THEN p.owner_id END AS venue_id, g.kind, g.delta, g.reason AS note, g.rule_key, g.source_type, g.source_id,
              g.expires_at, g.funding_owner, g.created_at, p.currency
         FROM loyalty_ledger g JOIN loyalty_programmes p ON p.id=g.programme_id
        WHERE g.user_id=$1 AND ($2::uuid IS NULL OR g.programme_id=$2) AND ($3::uuid IS NULL OR (p.owner_kind='venue' AND p.owner_id=$3))
        ORDER BY g.created_at DESC, g.seq DESC LIMIT $4 OFFSET $5`, [user.id, i.programme_id ?? null, i.venue_id ?? null, i.limit, i.offset]);
    const earlier = i.offset === 0 && !i.programme_id ? await many(
      `SELECT e.id, NULL::uuid AS programme_id, v.name AS programme_name, e.venue_id, e.kind, e.delta, e.note, e.created_at, v.currency, true AS earlier
         FROM loyalty_events e JOIN venues v ON v.id=e.venue_id WHERE e.user_id=$1 AND ($2::uuid IS NULL OR e.venue_id=$2) ORDER BY e.created_at DESC LIMIT 100`, [user.id, i.venue_id ?? null]) : [];
    return [...rows.map((r) => ({ ...r, label: KIND_LABEL[r.kind] ?? r.kind })), ...earlier.map((r) => ({ ...r, label: KIND_LABEL[r.kind] ?? r.kind }))];
  },
});

cap({
  name: 'get_loyalty_programme', method: 'GET', path: '/loyalty/programmes/:id', tag: TAG,
  summary: 'A programme in plain words: how you earn, what you can spend it on, when it expires — plus your own balance and lots with their expiry dates. Draft programmes are only visible to the people who run them.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await loadProgramme(db, i.id);
    if (!p) throw notFound('Programme');
    const runs = await canRun(db, user, p, false);
    if (p.status === 'draft' && !runs) throw notFound('Programme');
    const lots = await openLots(db, p.id, user.id);
    const owner = await one(`SELECT ${OWNER_NAME} AS owner_name FROM loyalty_programmes p WHERE p.id=$1`, [p.id]);
    return { id: p.id, name: p.name, owner_kind: p.owner_kind, owner_id: p.owner_id, owner_name: owner.owner_name, unit: p.unit, currency: p.currency, status: p.status, version: p.version, funding_owner: p.funding_owner,
      starts_at: p.starts_at, ends_at: p.ends_at, ...(p.rules ? summary(p) : {}), can_manage: runs, my_points: lots.reduce((s, l) => s + l.remaining, 0),
      my_lots: lots.map((l) => ({ points: l.remaining, expires_at: l.expires_at, earned_at: l.created_at, kind: l.kind })) };
  },
});

// ================================================================================================================ member: spending
cap({
  name: 'list_redeemable_programmes', method: 'GET', path: '/loyalty/options', tag: TAG,
  summary: 'At checkout: which of your balances can pay (part of) this bill, and how much each could cover right now — after each programme\'s cap and the bill\'s remaining amount. Nothing is spent.',
  input: z.object({ purpose_type: z.enum(Object.keys(REDEEM_PURPOSES)), purpose_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const mine = (await c.query('SELECT DISTINCT programme_id FROM loyalty_lots_open WHERE user_id=$1 AND remaining > 0 AND expires_at > now()', [user.id])).rows;
      const out = [];
      for (const m of mine) {
        const p = await loadProgramme(c, m.programme_id);
        if (!redeemable(p) || !p.rules.redeem.purposes.includes(i.purpose_type)) continue;
        let q;
        try { q = await quote(c, user, { programmeId: p.id, purposeType: i.purpose_type, purposeId: i.purpose_id }); } catch { continue; }
        if (!(q.usable > 0)) continue;
        out.push({ programme_id: p.id, name: p.name, owner_kind: p.owner_kind, currency: p.currency, balance: q.balance, usable_points: q.usable, usable_value_minor: q.usable, max_redeem_bp: q.max_redeem_bp });
      }
      return out;
    });
  },
});

cap({
  name: 'redeem_points', method: 'POST', path: '/loyalty/redeem', tag: TAG,
  summary: 'Pay (part of) a bill with your points: a venue booking invoice, an academy fee or a coaching session. Atomic with the bill (it takes the same lock a card checkout does), capped by the programme, oldest-expiry points first. If points cover everything the bill is paid; otherwise the card is asked only for what is left. A retry with the same request_key changes nothing.',
  input: z.object({ programme_id: id, purpose_type: z.enum(Object.keys(REDEEM_PURPOSES)), purpose_id: id, points: z.number().int().min(1).optional(), request_key: z.string().min(8).max(80).optional() }),
  handler: ({ user }, i) => tx((c) => redeem(c, user, { programmeId: i.programme_id, purposeType: i.purpose_type, purposeId: i.purpose_id, points: i.points, requestKey: i.request_key })),
});

// ================================================================================================================ programmes: setup
cap({
  name: 'list_loyalty_programmes', method: 'GET', path: '/loyalty/programmes', tag: TAG,
  summary: 'Programmes by view: "mine" = the ones you run (venue team, organisation owner/admin/finance, coach, event organiser, platform admin; filter by owner_kind + owner_id); "public" = every published programme of an owner; "referrals" = running programmes that reward invites, to pick one to share.',
  input: z.object({ view: z.enum(['mine', 'public', 'referrals']).default('mine'), owner_kind: z.enum(OWNER_KINDS).optional(), owner_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(`SELECT ${PROGRAMME_COLS} FROM loyalty_programmes p WHERE ($1::text IS NULL OR p.owner_kind=$1) AND ($2::uuid IS NULL OR p.owner_id=$2) AND ($3::text <> 'referrals' OR p.status='active') ORDER BY p.created_at DESC LIMIT 300`, [i.owner_kind ?? null, i.owner_id ?? null, i.view]);
    const out = [];
    for (const p of rows) {
      const runs = await canRun(db, user, p, false);
      if (i.view === 'mine') { if (runs) out.push({ ...p, can_manage: true }); continue; }
      if (p.status === 'draft' || !p.current_version) continue;
      const full = await loadProgramme(db, p.id);
      if (i.view === 'referrals' && !full.rules.referral.enabled) continue;
      out.push({ ...p, can_manage: runs, ...summary(full) });
    }
    return out.slice(i.offset, i.offset + i.limit);
  },
});

cap({
  name: 'list_fundable_sponsorships', method: 'GET', path: '/loyalty/fundable-sponsorships', tag: TAG,
  summary: 'Active sponsorship agreements that can fund a programme for this owner (the agreement must name the owner as its recipient). Used to pick the funder when starting a sponsor-funded programme.',
  input: z.object({ owner_kind: z.enum(OWNER_KINDS), owner_id: id.optional() }),
  async handler({ user }, i) {
    const draft = { owner_kind: i.owner_kind, owner_id: i.owner_kind === 'platform' ? null : (i.owner_id ?? (i.owner_kind === 'coach' ? user.id : null)) };
    if (!(await canRun(db, user, draft, true))) throw notFound('Owner');
    const rows = await many("SELECT s.id, sp.name AS sponsor_name, s.amount_cents, s.currency, s.starts_on, s.ends_on FROM sponsorships s JOIN sponsors sp ON sp.id=s.sponsor_id WHERE s.status='active' AND s.currency IS NOT NULL ORDER BY s.created_at DESC LIMIT 200");
    const out = [];
    for (const s of rows) { try { await checkSponsorship(db, user, { ...draft, currency: s.currency }, s.id); out.push(s); } catch { /* not for this owner */ } }
    return out;
  },
});

cap({
  name: 'create_loyalty_programme', method: 'POST', path: '/loyalty/programmes', tag: TAG, status: 201,
  summary: 'Start a loyalty programme for a venue, organisation (academy/club), coach, event — or the platform (platform admins). It begins as a draft; publish rules to run it. Funding is the owner\'s own unless the platform or an active sponsorship agreement funds it. Balances stay separate per programme.',
  input: z.object({
    owner_kind: z.enum(OWNER_KINDS), owner_id: id.optional(), name: z.string().trim().min(2).max(80), unit: z.enum(['points', 'credits']).default('points'),
    currency: z.string().length(3).transform((x) => x.toUpperCase()).refine(isSupportedCurrency, 'Unsupported currency').optional(),
    funding_owner: z.enum(['owner', 'platform', 'sponsor']).default('owner'), sponsorship_id: id.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ownerId = i.owner_kind === 'platform' ? null : (i.owner_kind === 'coach' ? (i.owner_id ?? user.id) : i.owner_id);
      if (i.owner_kind !== 'platform' && !ownerId) throw badRequest('owner_id is required');
      let currency = i.currency;
      if (i.owner_kind === 'venue') { const v = (await c.query('SELECT currency FROM venues WHERE id=$1', [ownerId])).rows[0]; if (!v) throw notFound('Venue'); currency = v.currency; }
      if (i.owner_kind === 'event') { const e = (await c.query('SELECT currency FROM events WHERE id=$1', [ownerId])).rows[0]; if (!e) throw notFound('Event'); currency = e.currency ?? currency; }
      if (i.owner_kind === 'organisation' && !(await c.query('SELECT 1 FROM organisations WHERE id=$1', [ownerId])).rowCount) throw notFound('Organisation');
      if (!currency) throw badRequest('Choose the currency this programme is in');
      const draft = { owner_kind: i.owner_kind, owner_id: ownerId, currency, funding_owner: i.funding_owner, sponsorship_id: i.sponsorship_id ?? null };
      if (!(await canRun(c, user, draft, true))) throw i.owner_kind === 'platform' ? forbidden('Only the platform team can run a platform programme') : notFound(i.owner_kind === 'coach' ? 'Coach' : 'Owner');
      if (i.funding_owner === 'platform' && !isAdmin(user)) throw forbidden('Only the platform team can fund a programme from the platform');
      if (i.funding_owner === 'sponsor') { if (!i.sponsorship_id) throw badRequest('Choose the sponsorship agreement that funds this programme'); await checkSponsorship(c, user, draft, i.sponsorship_id); }
      else if (i.sponsorship_id) throw badRequest('A sponsorship only applies to a sponsor-funded programme');
      const slug = i.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'programme';
      try {
        const p = (await c.query('INSERT INTO loyalty_programmes(owner_kind, owner_id, slug, name, unit, currency, funding_owner, sponsorship_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [i.owner_kind, ownerId, slug, i.name, i.unit, currency, i.funding_owner, i.sponsorship_id ?? null, user.id])).rows[0];
        await audit(c, user.id, 'create_loyalty_programme', 'loyalty_programmes', p.id);
        return p;
      } catch (e) { if (e.code === '23505') throw conflict('This owner already has a programme with that name'); throw e; }
    });
  },
});

cap({
  name: 'publish_loyalty_programme', method: 'POST', path: '/loyalty/programmes/:id/publish', tag: TAG,
  summary: 'Publish a new immutable version of a programme\'s rules (earning rules, redemption rules, expiry, caps, eligibility, referral reward, campaign dates). It applies to activity from now on; every ledger row keeps the version it was earned under, so history never changes. The first publish switches a draft on.',
  input: z.object({ id, rules: rulesSchema, starts_on: z.string().date().optional(), ends_on: z.string().date().optional(), note: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await mustRun(c, user, i.id, { write: true, lock: true });
      if (p.status === 'ended') throw conflict('This programme has ended');
      const rules = parseRules(i.rules);
      const bad = checkScope(p.owner_kind, rules);
      if (bad) throw badRequest(bad);
      if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('The campaign cannot end before it starts');
      if (p.funding_owner === 'sponsor') await checkSponsorship(c, user, p, p.sponsorship_id);
      const version = (p.current_version ?? 0) + 1;
      await c.query('INSERT INTO loyalty_programme_versions(programme_id, version, rules, starts_at, ends_at, note, published_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [p.id, version, JSON.stringify(rules), dayStart(i.starts_on), dayAfter(i.ends_on), i.note ?? null, user.id]);
      await c.query("UPDATE loyalty_programmes SET current_version=$2, status = CASE WHEN status='draft' THEN 'active' ELSE status END WHERE id=$1", [p.id, version]);
      await audit(c, user.id, 'publish_loyalty_programme', 'loyalty_programmes', p.id);
      return { id: p.id, version, status: p.status === 'draft' ? 'active' : p.status };
    });
  },
});

cap({
  name: 'set_loyalty_programme_status', method: 'POST', path: '/loyalty/programmes/:id/status', tag: TAG,
  summary: 'Pause (stop new earning; members can still spend and points still expire), resume, or end a programme (no new earning; balances stay spendable until they expire). Ending cannot be undone.',
  input: z.object({ id, action: z.enum(['pause', 'resume', 'end']), reason: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await mustRun(c, user, i.id, { write: true, lock: true });
      if (!p.current_version) throw conflict('Publish rules first');
      const next = { pause: 'paused', resume: 'active', end: 'ended' }[i.action];
      if (p.status === 'ended') throw conflict('This programme has ended');
      if (i.action === 'resume' && p.status !== 'paused') throw conflict('Only a paused programme can resume');
      if (i.action === 'resume' && p.funding_owner === 'sponsor') await checkSponsorship(c, user, p, p.sponsorship_id);
      await c.query('UPDATE loyalty_programmes SET status=$2 WHERE id=$1', [p.id, next]);
      await audit(c, user.id, `loyalty_programme_${i.action}`, 'loyalty_programmes', p.id);
      return { id: p.id, status: next };
    });
  },
});

cap({
  name: 'get_loyalty_programme_admin', method: 'GET', path: '/loyalty/programmes/:id/admin', tag: TAG,
  summary: 'The team\'s view of a programme: current rules, every published version, funding and status.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const raw = await mustRun(db, user, i.id);
    const p = await loadProgramme(db, raw.id);
    const versions = await many('SELECT version, rules, starts_at, ends_at, note, published_at, published_by FROM loyalty_programme_versions WHERE programme_id=$1 ORDER BY version DESC', [raw.id]);
    const owner = await one(`SELECT ${OWNER_NAME} AS owner_name FROM loyalty_programmes p WHERE p.id=$1`, [raw.id]);
    return { ...raw, owner_name: owner.owner_name, rules: p.rules, starts_at: p.starts_at, ends_at: p.ends_at, versions, can_write: await canRun(db, user, raw, true),
      choices: { events: OWNER_EVENTS[raw.owner_kind].map((k) => ({ key: k, label: EARN_EVENTS[k], short: EARN_SHORT[k] })), purposes: OWNER_PURPOSES[raw.owner_kind].map((k) => ({ key: k, label: REDEEM_PURPOSES[k] })) } };
  },
});

// ================================================================================================================ programmes: reporting & members
cap({
  name: 'loyalty_liability', method: 'GET', path: '/loyalty/programmes/:id/liability', tag: TAG,
  summary: 'Liability and breakage: points issued, restored, spent, taken back and expired in a date range, plus what is outstanding right now (members, points, money value, what expires within 30 days, and who funds it — owner, platform or sponsor).',
  input: z.object({ id, from: z.string().date().optional(), to: z.string().date().optional() }),
  async handler({ user }, i) {
    const p = await mustRun(db, user, i.id);
    return { programme_id: p.id, currency: p.currency, status: p.status, ...await liability(db, p.id, { from: dayStart(i.from), to: dayAfter(i.to) }) };
  },
});

cap({
  name: 'list_loyalty_members', method: 'GET', path: '/loyalty/programmes/:id/members', tag: TAG,
  summary: 'Members of one programme with their balance and next expiry. Visible only to the people who run that programme — never across businesses.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const p = await mustRun(db, user, i.id);
    return many(
      `SELECT u.id AS user_id, u.handle, u.display_name, sum(l.remaining)::int AS points, min(l.expires_at) AS next_expiry,
              (SELECT max(created_at) FROM loyalty_ledger g WHERE g.programme_id=$1 AND g.user_id=u.id) AS last_activity
         FROM loyalty_lots_open l JOIN users u ON u.id=l.user_id WHERE l.programme_id=$1 AND l.remaining > 0 AND l.expires_at > now() GROUP BY u.id ORDER BY points DESC, u.display_name LIMIT $2 OFFSET $3`, [p.id, i.limit, i.offset]);
  },
});

cap({
  name: 'adjust_loyalty_points', method: 'POST', path: '/loyalty/programmes/:id/adjust', tag: TAG,
  summary: 'Programme team: give a member goodwill points (positive) or correct a balance (negative), with a written reason. Append-only and audit-logged; limited to the programme\'s budget and its sponsor funding. A sponsor cannot issue points — only the people who run the programme can.',
  input: z.object({ id, ...member, points: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, 'points cannot be zero'), reason: z.string().trim().min(3).max(200), idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await mustRun(c, user, i.id, { write: true });
      const target = await findMember(c, i);
      if (!target) throw notFound('User');
      const prog = await loadProgramme(c, p.id);
      if (!prog.version) throw conflict('Publish rules first');
      const key = `adjust:${p.id}:${target.id}:${i.idempotency_key ?? `${user.id}:${Date.now()}:${Math.random()}`}`;
      if (i.points > 0) {
        const why = await eligible(c, prog, target.id);
        if (why) throw conflict('That member cannot take part in this programme');
        const room = await fundingRoom(c, prog);
        if (room < i.points) throw conflict('The programme\'s funding does not cover that many points');
        if (prog.rules.caps.programme_points_total) {
          const left = prog.rules.caps.programme_points_total - Number((await c.query("SELECT coalesce(sum(delta),0) AS n FROM loyalty_ledger WHERE programme_id=$1 AND delta > 0 AND kind IN ('earn','bonus','adjust')", [p.id])).rows[0].n);
          if (left < i.points) throw conflict('That would exceed the programme budget');
        }
        const exp = new Date(); exp.setUTCMonth(exp.getUTCMonth() + prog.rules.expiry_months);
        const row = await openLot(c, { programmeId: p.id, userId: target.id, kind: 'adjust', points: i.points, expiresAt: exp, version: prog.version, key, reason: i.reason, actorId: user.id, fundingOwner: p.funding_owner, sponsorshipId: p.sponsorship_id });
        await audit(c, user.id, 'adjust_loyalty_points', 'loyalty_programmes', p.id);
        if (row) await notify(c, target.id, { kind: 'loyalty_earned', title: `${p.name} gave you ${i.points} ${p.unit}`, body: `${i.reason} — worth ${p.currency} ${toMajor(i.points, p.currency)}.`, data: { programme_id: p.id } });
        return { ok: true, points: i.points, replayed: !row };
      }
      await lockMember(c, p.id, target.id);
      const out = await draw(c, { programmeId: p.id, userId: target.id, points: -i.points, kind: 'adjust', key, reason: i.reason, actorId: user.id, version: prog.version });
      if (out.taken <= 0) throw conflict('That member has no points to take');
      await audit(c, user.id, 'adjust_loyalty_points', 'loyalty_programmes', p.id);
      return { ok: true, points: -out.taken, replayed: out.replayed };
    });
  },
});

cap({
  name: 'award_loyalty_challenge', method: 'POST', path: '/loyalty/programmes/:id/challenges/award', tag: TAG,
  summary: 'Programme team: award a member for completing a sponsored challenge (a rule with the "sponsored challenge" event). Needs the evidence reference you verified; one award per member per challenge and reference. Sponsors fund the programme but cannot call this.',
  input: z.object({ id, rule_key: z.string(), ...member, evidence_ref: z.string().trim().min(3).max(120) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const raw = await mustRun(c, user, i.id, { write: true });
      const p = await loadProgramme(c, raw.id);
      const rule = p.rules?.earn.find((r) => r.key === i.rule_key && r.event === 'sponsored_challenge');
      if (!rule) throw badRequest('That programme has no such challenge');
      const target = await findMember(c, i);
      if (!target) throw notFound('User');
      const { row, reason } = await award(c, p, { userId: target.id, points: rule.points, ruleKey: rule.key, sourceType: 'challenge', sourceId: `${rule.key}:${i.evidence_ref}`, key: `challenge:${p.id}:${rule.key}:${target.id}:${i.evidence_ref}`, reason: rule.label ?? 'Challenge completed', actorId: user.id });
      if (!row && reason !== 'already_awarded') throw conflict(`Not awarded: ${reason.replace(/_/g, ' ')}`);
      if (row) { await audit(c, user.id, 'award_loyalty_challenge', 'loyalty_programmes', p.id); await notify(c, target.id, { kind: 'loyalty_earned', title: `You earned ${row.delta} ${p.unit} · ${p.name}`, body: rule.label ?? 'Challenge completed', data: { programme_id: p.id } }); }
      return { awarded: !!row, points: row?.delta ?? 0 };
    });
  },
});

// ================================================================================================================ referrals
cap({
  name: 'create_referral_code', method: 'POST', path: '/loyalty/programmes/:id/referral-codes', tag: TAG, status: 201,
  summary: 'Make a referral code/link for a programme that runs referrals, tagged with a campaign and source so you can see what works. You can revoke it any time. Young people cannot create public codes.',
  input: z.object({ id, campaign: z.string().trim().min(1).max(60).optional(), source: z.string().trim().min(1).max(60).optional(), max_uses: z.number().int().min(1).max(10000).optional(), expires_on: z.string().date().optional() }),
  handler: ({ user }, i) => tx((c) => referrals.createCode(c, user, { programmeId: i.id, campaign: i.campaign, source: i.source, maxUses: i.max_uses, expiresAt: dayAfter(i.expires_on) })),
});

cap({
  name: 'list_my_referral_codes', method: 'GET', path: '/me/referral-codes', tag: TAG,
  summary: 'Your referral codes with how each is doing: people who signed up, qualified, and were rewarded.',
  handler: ({ user }) => many(
    `SELECT k.id, k.programme_id, p.name AS programme_name, k.code, k.campaign, k.source, k.max_uses, k.expires_at, k.revoked_at, k.created_at,
            count(r.id)::int AS signed_up, count(r.id) FILTER (WHERE r.qualified_at IS NOT NULL AND r.status <> 'void')::int AS qualified, count(r.id) FILTER (WHERE r.status='rewarded')::int AS rewarded
       FROM loyalty_referral_codes k JOIN loyalty_programmes p ON p.id=k.programme_id LEFT JOIN loyalty_referrals r ON r.code_id=k.id AND r.status <> 'blocked'
      WHERE k.referrer_id=$1 GROUP BY k.id, p.name ORDER BY k.created_at DESC`, [user.id]),
});

cap({
  name: 'revoke_referral_code', method: 'DELETE', path: '/referral-codes/:id', tag: TAG,
  summary: 'Revoke one of your referral codes. People who already claimed it keep their referral; no new claims are possible.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx((c) => referrals.revokeCode(c, user, i.id)),
});

cap({
  name: 'claim_referral_code', method: 'POST', path: '/referrals/claim', tag: TAG, status: 201,
  summary: 'Enter a friend\'s referral code (within the programme\'s sign-up window). Nothing is rewarded yet: it pays out only after you complete the programme\'s qualifying action and its holdback passes. Your own code, loops and repeats are refused; suspicious ones are held for review.',
  input: z.object({ code: z.string().trim().min(4).max(24) }),
  async handler({ user }, i) {
    const r = await tx((c) => referrals.claim(c, user, i.code));
    const p = await loadProgramme(db, r.programme_id);
    return { id: r.id, programme_id: r.programme_id, programme_name: p.name, status: r.status === 'held' ? 'under_review' : 'registered', qualifying_event: p.rules.referral.qualifying_event ? EARN_EVENTS[p.rules.referral.qualifying_event] : null };
  },
});

cap({
  name: 'list_my_referrals', method: 'GET', path: '/me/referrals', tag: TAG,
  summary: 'People you invited and where each stands (signed up, qualified, rewarded, under review), plus the invite that brought you in. Names appear only once a friend is rewarded.',
  async handler({ user }) {
    const made = await many(
      `SELECT r.id, r.programme_id, p.name AS programme_name, r.status, r.qualified_at, r.release_at, r.rewarded_at, r.created_at, CASE WHEN r.status='rewarded' THEN u.display_name END AS friend_name
         FROM loyalty_referrals r JOIN loyalty_programmes p ON p.id=r.programme_id JOIN users u ON u.id=r.invitee_id WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT 200`, [user.id]);
    const mine = await many('SELECT r.id, r.programme_id, p.name AS programme_name, r.status, r.created_at FROM loyalty_referrals r JOIN loyalty_programmes p ON p.id=r.programme_id WHERE r.invitee_id=$1 ORDER BY r.created_at DESC', [user.id]);
    return { invited: made.map((r) => ({ ...r, status: r.status === 'held' ? 'under_review' : r.status })), joined_through: mine.map((r) => ({ ...r, status: r.status === 'held' ? 'under_review' : r.status })) };
  },
});

cap({
  name: 'list_programme_referrals', method: 'GET', path: '/loyalty/programmes/:id/referrals', tag: TAG,
  summary: 'Programme team: referrals in this programme, including those held for review (shared device, bursts) with the reason. Filter by status.',
  input: z.object({ id, status: z.enum(['registered', 'qualified', 'rewarded', 'held', 'blocked', 'void']).optional(), ...page }),
  async handler({ user }, i) {
    const p = await mustRun(db, user, i.id);
    return many(
      `SELECT r.id, r.status, r.flags, r.qualified_at, r.release_at, r.rewarded_at, r.review_note, r.created_at, k.campaign, k.source, a.handle AS referrer_handle, b.handle AS invitee_handle
         FROM loyalty_referrals r JOIN loyalty_referral_codes k ON k.id=r.code_id JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.invitee_id
        WHERE r.programme_id=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`, [p.id, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'review_referral', method: 'POST', path: '/loyalty/referrals/:id/review', tag: TAG,
  summary: 'Programme team: approve or reject a referral that was held for review. Approving lets it qualify and pay out normally; rejecting blocks it. Audit-logged with your note.',
  input: z.object({ id, decision: z.enum(['approve', 'reject']), note: z.string().trim().min(3).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT programme_id FROM loyalty_referrals WHERE id=$1', [i.id])).rows[0];
      if (!r) throw notFound('Referral');
      await mustRun(c, user, r.programme_id, { write: true });
      return referrals.review(c, user, i.id, i.decision, i.note);
    });
  },
});

// ================================================================================================================ explicit exchange between programmes
cap({
  name: 'propose_loyalty_exchange', method: 'POST', path: '/loyalty/exchange-rules', tag: TAG, status: 201,
  summary: 'Balances never move between programmes unless both owners agree. Propose letting members exchange points from one programme into another (same currency) at a rate; the other owner must approve. rate_bp 10000 = 1:1.',
  input: z.object({ from_programme_id: id, to_programme_id: id, rate_bp: z.number().int().min(1).max(100000).default(10000), max_points_per_member_month: z.number().int().min(1).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const from = await mustRun(c, user, i.from_programme_id, { write: true });
      const to = (await c.query('SELECT * FROM loyalty_programmes WHERE id=$1', [i.to_programme_id])).rows[0];
      if (!to) throw notFound('Programme');
      if (to.currency !== from.currency) throw badRequest('Programmes in different currencies cannot be exchanged');
      const row = (await c.query('INSERT INTO loyalty_exchange_rules(from_programme, to_programme, rate_bp, max_points_per_member_month, proposed_by, from_approved_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *', [from.id, to.id, i.rate_bp, i.max_points_per_member_month ?? null, user.id])).rows[0];
      await audit(c, user.id, 'propose_loyalty_exchange', 'loyalty_exchange_rules', row.id);
      return row;
    });
  },
});

cap({
  name: 'decide_loyalty_exchange', method: 'POST', path: '/loyalty/exchange-rules/:id/decision', tag: TAG,
  summary: 'The receiving programme\'s owner approves (the rule goes live) or ends an exchange rule. Either owner can end a live rule at any time; points already exchanged stay where they are.',
  input: z.object({ id, decision: z.enum(['approve', 'end']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM loyalty_exchange_rules WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Exchange rule');
      const to = (await c.query('SELECT * FROM loyalty_programmes WHERE id=$1', [r.to_programme])).rows[0];
      const from = (await c.query('SELECT * FROM loyalty_programmes WHERE id=$1', [r.from_programme])).rows[0];
      const toOk = await canRun(c, user, to, true), fromOk = await canRun(c, user, from, true);
      if (!toOk && !fromOk) throw notFound('Exchange rule');
      if (i.decision === 'approve') {
        if (!toOk) throw forbidden('Only the receiving programme\'s owner can approve');
        if (r.status !== 'proposed') throw conflict('That rule is not waiting for approval');
        await c.query("UPDATE loyalty_exchange_rules SET status='active', to_approved_by=$2 WHERE id=$1", [r.id, user.id]);
      } else {
        await c.query("UPDATE loyalty_exchange_rules SET status='ended' WHERE id=$1 AND status <> 'ended'", [r.id]);
      }
      await audit(c, user.id, `loyalty_exchange_${i.decision}`, 'loyalty_exchange_rules', r.id);
      return one('SELECT * FROM loyalty_exchange_rules WHERE id=$1', [r.id]);
    });
  },
});

cap({
  name: 'list_loyalty_exchanges', method: 'GET', path: '/loyalty/exchange-rules', tag: TAG,
  summary: 'Live exchange rules available to you as a member (from a programme where you hold points), and rules proposed or live for programmes you run.',
  async handler({ user }) {
    const member = await many(
      `SELECT x.id, x.rate_bp, x.max_points_per_member_month, f.id AS from_programme_id, f.name AS from_name, t.id AS to_programme_id, t.name AS to_name, t.currency
         FROM loyalty_exchange_rules x JOIN loyalty_programmes f ON f.id=x.from_programme JOIN loyalty_programmes t ON t.id=x.to_programme
        WHERE x.status='active' AND EXISTS (SELECT 1 FROM loyalty_lots_open l WHERE l.programme_id=f.id AND l.user_id=$1 AND l.remaining > 0 AND l.expires_at > now())`, [user.id]);
    const all = await many(`SELECT x.*, f.name AS from_name, t.name AS to_name, f.owner_kind AS from_kind, f.owner_id AS from_owner, t.owner_kind AS to_kind, t.owner_id AS to_owner FROM loyalty_exchange_rules x JOIN loyalty_programmes f ON f.id=x.from_programme JOIN loyalty_programmes t ON t.id=x.to_programme ORDER BY x.created_at DESC LIMIT 200`);
    const run = [];
    for (const x of all) if (await canRun(db, user, { owner_kind: x.from_kind, owner_id: x.from_owner }, false) || await canRun(db, user, { owner_kind: x.to_kind, owner_id: x.to_owner }, false)) run.push(x);
    return { available: member, managed: run };
  },
});

cap({
  name: 'exchange_loyalty_points', method: 'POST', path: '/loyalty/exchange', tag: TAG,
  summary: 'Exchange points from one programme into another under a live exchange rule both owners approved. Atomic: the points leave one balance and open a lot in the other (with that programme\'s own expiry).',
  input: z.object({ rule_id: id, points: z.number().int().min(1), request_key: z.string().min(8).max(80) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query("SELECT * FROM loyalty_exchange_rules WHERE id=$1 AND status='active'", [i.rule_id])).rows[0];
      if (!r) throw notFound('Exchange rule');
      const to = await loadProgramme(c, r.to_programme);
      if (!earningLive(to)) throw conflict('The receiving programme is not open right now');
      const why = await eligible(c, to, user.id);
      if (why) throw forbidden('Your account cannot take part in the receiving programme');
      if (r.max_points_per_member_month) {
        const used = Number((await c.query("SELECT coalesce(-sum(delta),0) AS n FROM loyalty_ledger WHERE programme_id=$1 AND user_id=$2 AND kind='exchange_out' AND created_at >= date_trunc('month', now()) AND source_id=$3", [r.from_programme, user.id, r.id])).rows[0].n);
        if (used + i.points > r.max_points_per_member_month) throw conflict('That is over the monthly exchange limit for this rule');
      }
      const key = `exchange:${user.id}:${i.request_key}`;
      const out = await draw(c, { programmeId: r.from_programme, userId: user.id, points: i.points, kind: 'exchange_out', key, sourceType: 'exchange', sourceId: r.id, reason: 'Exchanged into another programme' });
      if (out.replayed) return { points_out: out.taken, replayed: true };
      if (out.taken < i.points) throw conflict('You do not have that many points');
      const got = Math.floor((i.points * r.rate_bp) / 10000);
      if (got <= 0) throw conflict('That is too few points to exchange at this rate');
      const exp = new Date(); exp.setUTCMonth(exp.getUTCMonth() + to.rules.expiry_months);
      await openLot(c, { programmeId: to.id, userId: user.id, kind: 'exchange_in', points: got, expiresAt: exp, version: to.version, sourceType: 'exchange', sourceId: r.id, key: `${key}:in`, reason: 'Exchanged from another programme', fundingOwner: to.funding_owner, sponsorshipId: to.sponsorship_id });
      return { points_out: out.taken, points_in: got, to_programme_id: to.id };
    });
  },
});
