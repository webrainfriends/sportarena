// Team member finance (issue #516): dues and season fees, match fees, shared expenses and fundraising. A contribution ledger, not a bank account.
// Obligations are team_charges raised from a batch; money arrives either through the canonical checkout (payments, purpose_type team_charge /
// team_contribution) or as an offline receipt a manager records (cash / UPI / bank). Members see their own obligations and, only if the team allows
// it, aggregate totals - never other members' balances and never anything about player rates or payouts (those capabilities are separate and untouched).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit, mustFind } from '../helpers.js';
import { notify } from '../notify.js';
import { isSupportedCurrency } from '../currency.js';
import { hasOrgGrant } from '../org-access.js';
import { isYouth, YOUTH_SQL } from '../youth.js';
import { canManageTeam } from './teams.js';
import { attendanceScope } from './team-workspace.js';
import { adjust, applyReceipt, openReason, raiseBatch, raiseTeamDues, sealReason, splitShares } from '../team-money.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-01');
const minor = z.coerce.number().int().min(1).max(1_000_000_000).describe('amount in minor units (paise / cents)');
const key = z.string().min(8).max(64).describe('any unique string; a retry with the same key changes nothing');
const METHODS = ['cash', 'upi', 'bank', 'card', 'other'];

/** Managers, and finance staff of the team's organisation. They reconcile; ordinary members never get this. */
async function financeStaff(user, team) {
  return (await canManageTeam(user, team)) || (await hasOrgGrant(user, team.organisation_id, ['owner', 'admin', 'finance']));
}
async function mustRun(user, teamId) {
  const team = await mustFind('teams', teamId);
  if (!(await financeStaff(user, team))) throw forbidden('Only the team owner, managers or the organisation\'s finance staff can do this');
  return team;
}
const activeMember = (teamId, userId) => one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [teamId, userId]);
/** An active member, or a verified guardian of an active young member: the two kinds of person who can owe or give. */
async function involved(teamId, userId) {
  if (await activeMember(teamId, userId)) return 'member';
  const g = await one(
    `SELECT 1 FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN guardian_links l ON l.child_id=tm.user_id
      WHERE tm.team_id=$1 AND tm.status='active' AND l.guardian_id=$2 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ${YOUTH_SQL}`, [teamId, userId]);
  return g ? 'guardian' : null;
}
const mustBeInvolved = async (user, team) => {
  const how = await involved(team.id, user.id);
  if (!how && !(await financeStaff(user, team))) throw forbidden('Team members and guardians of young members only');
  return how;
};

const CHARGE_SQL = `SELECT ch.id AS charge_id, ch.team_id, ch.batch_id, b.kind, b.title, b.currency, b.split_mode, b.event_id, b.fixture_id, ch.due_on::text AS due_on, ch.amount_minor, ch.adjusted_minor, ch.settled_minor,
                           (ch.amount_minor - ch.adjusted_minor - ch.settled_minor) AS balance_minor, ch.status, ch.paid_at, ch.created_at,
                           (ch.status='awaiting_payment' AND ch.due_on IS NOT NULL AND ch.due_on < current_date) AS overdue, ch.member_id, ch.payer_id`;

// ------------------------------------------------------------------------------------------------------------------ settings
cap({
  name: 'set_team_finance_settings', method: 'PATCH', path: '/teams/:id/finance-settings', tag: 'Team finance',
  summary: 'Choose what members can see of the team\'s money. By default each member sees only their own obligations; turn on members_see_totals to also show team-level totals (never names or other people\'s balances). Owner/managers.',
  input: z.object({ id, members_see_totals: z.boolean() }),
  async handler({ user }, i) {
    await mustRun(user, i.id);
    return one(`INSERT INTO team_finance_settings(team_id, members_see_totals, updated_by) VALUES ($1,$2,$3) ON CONFLICT (team_id) DO UPDATE SET members_see_totals=$2, updated_by=$3, updated_at=now() RETURNING team_id, members_see_totals, updated_at`, [i.id, i.members_see_totals, user.id]);
  },
});

// ------------------------------------------------------------------------------------------------------------------ dues, season and match fees
cap({
  name: 'create_team_charges', method: 'POST', path: '/teams/:id/charges', tag: 'Team finance', status: 201,
  summary: 'Raise a dues, season-fee or match-fee charge. Everyone chosen owes the same amount_minor. Choose who with audience: all_active (the roster), selected_squad or rsvp_going (for an event_id / fixture_id), or members (member_ids). A young member is charged to a verified guardian; if none exists they are listed in `skipped`, never charged to the child. Payers are notified once. Owner/managers.',
  input: z.object({
    id, kind: z.enum(['dues', 'season_fee', 'match_fee']), title: z.string().trim().min(1).max(120), amount_minor: minor, due_on: day.optional(),
    audience: z.enum(['all_active', 'selected_squad', 'rsvp_going', 'members']).default('all_active'), member_ids: z.array(id).max(200).optional(),
    event_id: id.optional(), fixture_id: id.optional(), include_staff: z.boolean().default(false).describe('also charge coaches, managers and physios on the roster'), idempotency_key: key,
  }),
  async handler({ user }, i) {
    const team = await mustRun(user, i.id);
    if (!isSupportedCurrency(team.currency)) throw badRequest('Unsupported team currency');
    if (i.kind === 'match_fee' && !i.event_id && !i.fixture_id) throw badRequest('A match fee needs the event_id or fixture_id it is for');
    const scope = i.event_id || i.fixture_id ? await attendanceScope(team, { event_id: i.event_id, fixture_id: i.fixture_id }) : null;
    if ((i.audience === 'selected_squad' || i.audience === 'rsvp_going') && !scope) throw badRequest(`${i.audience} needs an event_id or fixture_id`);
    if (i.audience === 'members' && !i.member_ids?.length) throw badRequest('Choose at least one member');
    return tx(async (c) => {
      const prior = (await c.query('SELECT id FROM team_charge_batches WHERE team_id=$1 AND idempotency_key=$2', [i.id, i.idempotency_key])).rows[0];
      if (prior) return batchView(c, prior.id, { skipped: [] });
      const staff = i.include_staff ? '' : " AND m.role IN ('captain','player')";
      let ids;
      if (i.audience === 'all_active') ids = (await c.query(`SELECT m.user_id FROM team_members m WHERE m.team_id=$1 AND m.status='active'${staff} ORDER BY m.user_id`, [i.id])).rows;
      else if (i.audience === 'members') ids = (await c.query("SELECT m.user_id FROM team_members m WHERE m.team_id=$1 AND m.status='active' AND m.user_id = ANY($2) ORDER BY m.user_id", [i.id, i.member_ids])).rows;
      else if (i.audience === 'selected_squad') ids = (await c.query("SELECT q.user_id FROM team_squads q JOIN team_members m ON m.team_id=q.team_id AND m.user_id=q.user_id AND m.status='active' WHERE q.team_id=$1 AND q.event_id IS NOT DISTINCT FROM $2 AND q.fixture_id IS NOT DISTINCT FROM $3 AND q.status IN ('selected','confirmed') ORDER BY q.user_id", [i.id, scope.event_id, scope.fixture_id])).rows;
      else ids = (await c.query("SELECT a.user_id FROM team_attendance a JOIN team_members m ON m.team_id=a.team_id AND m.user_id=a.user_id AND m.status='active' WHERE a.team_id=$1 AND a.event_id IS NOT DISTINCT FROM $2 AND a.fixture_id IS NOT DISTINCT FROM $3 AND a.rsvp='going' ORDER BY a.user_id", [i.id, scope.event_id, scope.fixture_id])).rows;
      if (!ids.length) throw unprocessable('Nobody matches that choice yet - nothing was charged');
      const batch = (await c.query(
        `INSERT INTO team_charge_batches(team_id, kind, title, currency, total_minor, split_mode, due_on, event_id, fixture_id, idempotency_key, created_by) VALUES ($1,$2,$3,$4,$5,'fixed',$6,$7,$8,$9,$10) RETURNING *, due_on::text AS due_text`,
        [i.id, i.kind, i.title, team.currency, i.amount_minor * ids.length, i.due_on ?? null, scope?.event_id ?? null, scope?.fixture_id ?? null, i.idempotency_key, user.id])).rows[0];
      const out = await raiseBatch(c, { team, batch, members: ids.map((r) => ({ user_id: r.user_id, amount_minor: i.amount_minor })), actor: user.id });
      await c.query('UPDATE team_charge_batches SET total_minor=$2 WHERE id=$1', [batch.id, out.charges.reduce((t, x) => t + Number(x.amount_minor), 0)]);
      await audit(c, user.id, 'create_team_charges', 'team_charge_batches', batch.id);
      return batchView(c, batch.id, out);
    });
  },
});

async function batchView(c, batchId, out) {
  const b = (await c.query('SELECT id AS batch_id, team_id, kind, title, currency, total_minor, split_mode, due_on::text AS due_on, event_id, fixture_id, paid_by, status, created_at FROM team_charge_batches WHERE id=$1', [batchId])).rows[0];
  return { ...b, charges_raised: (await c.query('SELECT count(*)::int AS n FROM team_charges WHERE batch_id=$1', [batchId])).rows[0].n, skipped: out.skipped ?? [] };
}

// ------------------------------------------------------------------------------------------------------------------ split expenses
cap({
  name: 'create_team_expense', method: 'POST', path: '/teams/:id/expenses', tag: 'Team finance', status: 201,
  summary: 'Record a team expense and split it. split: equal, weights (give a weight per participant) or exact (give each share; they must add up). Shares are rounded to the paise the same way every time (participants ordered by id, cumulative rounding) and always add up to the total. Members not listed are excluded. paid_by is the member who fronted the money: their own share is settled at once and the ledger shows what they are owed back. Owner/managers.',
  input: z.object({
    id, title: z.string().trim().min(1).max(120), total_minor: minor, split: z.enum(['equal', 'weights', 'exact']).default('equal'),
    participants: z.array(z.object({ user_id: id, weight: z.coerce.number().int().min(1).max(1000).optional(), amount_minor: z.coerce.number().int().min(0).max(1_000_000_000).optional() })).min(1).max(200),
    paid_by: id.optional(), due_on: day.optional(), idempotency_key: key,
  }),
  async handler({ user }, i) {
    const team = await mustRun(user, i.id);
    if (new Set(i.participants.map((p) => p.user_id)).size !== i.participants.length) throw badRequest('Each participant can be listed once');
    return tx(async (c) => {
      const prior = (await c.query('SELECT id FROM team_charge_batches WHERE team_id=$1 AND idempotency_key=$2', [i.id, i.idempotency_key])).rows[0];
      if (prior) return batchView(c, prior.id, { skipped: [] });
      const ids = i.participants.map((p) => p.user_id);
      const ok = (await c.query("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND user_id = ANY($2)", [i.id, ids])).rows.map((r) => r.user_id);
      if (ok.length !== ids.length) throw badRequest('Every participant must be an active member of the team');
      if (i.paid_by && !(await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [i.id, i.paid_by])).rowCount) throw badRequest('paid_by must be an active member');
      if (i.split === 'weights' && i.participants.some((p) => !p.weight)) throw badRequest('Give every participant a weight');
      if (i.split === 'exact' && i.participants.some((p) => p.amount_minor == null)) throw badRequest('Give every participant an amount');
      const shares = splitShares(i.total_minor, ids, { mode: i.split, weights: Object.fromEntries(i.participants.map((p) => [p.user_id, p.weight])), exact: Object.fromEntries(i.participants.map((p) => [p.user_id, p.amount_minor])) });
      const batch = (await c.query(
        `INSERT INTO team_charge_batches(team_id, kind, title, currency, total_minor, split_mode, due_on, paid_by, idempotency_key, created_by) VALUES ($1,'expense',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *, due_on::text AS due_text`,
        [i.id, i.title, team.currency, i.total_minor, i.split, i.due_on ?? null, i.paid_by ?? null, i.idempotency_key, user.id])).rows[0];
      const out = await raiseBatch(c, { team, batch, actor: user.id, members: shares.filter(([, a]) => a > 0).map(([u, a]) => ({ user_id: u, amount_minor: a, settled_minor: u === i.paid_by ? a : 0 })) });
      await audit(c, user.id, 'create_team_expense', 'team_charge_batches', batch.id);
      return batchView(c, batch.id, out);
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ reading
cap({
  name: 'list_my_team_charges', method: 'GET', path: '/me/team-charges', tag: 'Team finance',
  summary: 'What you owe to your teams (as a member, or as the guardian who pays for a young member), newest first. Each open charge carries the purpose_type / purpose_id to pass to create_payment.',
  input: z.object({ status: z.enum(['awaiting_payment', 'paid', 'waived', 'cancelled']).optional(), team_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `${CHARGE_SQL}, t.name AS team_name, t.emoji, mu.display_name AS member_name FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id JOIN teams t ON t.id=ch.team_id JOIN users mu ON mu.id=ch.member_id
        WHERE ch.payer_id=$1 AND ($2::text IS NULL OR ch.status=$2) AND ($3::uuid IS NULL OR ch.team_id=$3) ORDER BY (ch.status='awaiting_payment') DESC, ch.due_on NULLS LAST, ch.created_at DESC LIMIT $4 OFFSET $5`,
      [user.id, i.status ?? null, i.team_id ?? null, i.limit, i.offset]);
    return rows.map(({ member_id, payer_id, ...r }) => ({ ...r, for_member: member_id === user.id ? null : r.member_name, member_name: undefined, purpose: r.status === 'awaiting_payment' ? { purpose_type: 'team_charge', purpose_id: r.charge_id } : null }));
  },
});

cap({
  name: 'list_team_charges', method: 'GET', path: '/teams/:id/charges', tag: 'Team finance',
  summary: 'Every charge of the team with who owes what and what is still open. Owner/managers and the organisation\'s finance staff only.',
  input: z.object({ id, status: z.enum(['awaiting_payment', 'paid', 'waived', 'cancelled']).optional(), kind: z.enum(['dues', 'season_fee', 'match_fee', 'expense']).optional(), member_id: id.optional(), batch_id: id.optional(), ...page }),
  async handler({ user }, i) {
    await mustRun(user, i.id);
    return many(
      `${CHARGE_SQL}, mu.display_name AS member_name, pu.display_name AS payer_name FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id JOIN users mu ON mu.id=ch.member_id JOIN users pu ON pu.id=ch.payer_id
        WHERE ch.team_id=$1 AND ($2::text IS NULL OR ch.status=$2) AND ($3::text IS NULL OR b.kind=$3) AND ($4::uuid IS NULL OR ch.member_id=$4) AND ($5::uuid IS NULL OR ch.batch_id=$5)
        ORDER BY ch.created_at DESC, mu.display_name LIMIT $6 OFFSET $7`, [i.id, i.status ?? null, i.kind ?? null, i.member_id ?? null, i.batch_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_team_charge', method: 'GET', path: '/team-charges/:charge_id', tag: 'Team finance',
  summary: 'One charge with every step that changed it (raised, receipts, reductions, waivers). The payer sees amounts and dates; managers also see the recorded reasons and notes (that read is audit-logged).',
  input: z.object({ charge_id: id }),
  async handler({ user }, i) {
    const ch = await one(`${CHARGE_SQL}, t.name AS team_name FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id JOIN teams t ON t.id=ch.team_id WHERE ch.id=$1`, [i.charge_id]);
    if (!ch) throw notFound('Charge');
    const team = await mustFind('teams', ch.team_id);
    const staff = await financeStaff(user, team);
    if (!staff && ch.payer_id !== user.id) throw notFound('Charge');   // not yours: it does not exist as far as you can tell
    const entries = await many('SELECT e.id, e.kind, e.amount_minor, e.method, e.payment_id, e.reason_enc, e.created_at, u.display_name AS actor FROM team_charge_entries e LEFT JOIN users u ON u.id=e.actor_id WHERE e.charge_id=$1 ORDER BY e.created_at, e.id', [i.charge_id]);
    if (staff && entries.some((e) => e.reason_enc)) await audit(null, user.id, 'read_pii', 'team_charge_entries', i.charge_id);
    const { member_id, payer_id, ...rest } = ch;
    return { ...rest, for_member: member_id === payer_id ? null : (await one('SELECT display_name FROM users WHERE id=$1', [member_id])).display_name,
      entries: entries.map(({ reason_enc, ...e }) => ({ ...e, note: staff ? openReason(reason_enc) : null })),
      purpose: ch.status === 'awaiting_payment' && ch.payer_id === user.id ? { purpose_type: 'team_charge', purpose_id: ch.charge_id } : null };
  },
});

cap({
  name: 'get_my_team_finance', method: 'GET', path: '/teams/:id/my-finance', tag: 'Team finance',
  summary: 'The money side of a team for a member or guardian: what you owe, the open fundraisers, and - only if the team allows it - team-level totals (no names, no other balances).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const team = await mustFind('teams', i.id);
    const relation = (await mustBeInvolved(user, team)) ?? 'staff';
    const mine = await many(
      `${CHARGE_SQL}, mu.display_name AS member_name FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id JOIN users mu ON mu.id=ch.member_id WHERE ch.team_id=$1 AND ch.payer_id=$2 ORDER BY (ch.status='awaiting_payment') DESC, ch.due_on NULLS LAST, ch.created_at DESC LIMIT 100`, [i.id, user.id]);
    const settings = await one('SELECT members_see_totals FROM team_finance_settings WHERE team_id=$1', [i.id]);
    const totals = settings?.members_see_totals ? await one(
      `SELECT coalesce(sum(amount_minor - adjusted_minor) FILTER (WHERE status <> 'cancelled'),0)::bigint AS due_minor, coalesce(sum(settled_minor) FILTER (WHERE status <> 'cancelled'),0)::bigint AS collected_minor,
              count(DISTINCT member_id) FILTER (WHERE status='paid')::int AS members_paid, count(DISTINCT member_id) FILTER (WHERE status='awaiting_payment')::int AS members_open FROM team_charges WHERE team_id=$1`, [i.id]) : null;
    const fundraisers = await many(
      `${FUND_SQL} WHERE f.team_id=$1 AND f.status='active' ORDER BY f.created_at DESC`, [i.id]).then((rows) => rows.map(withProgress));
    return {
      team_id: team.id, currency: team.currency, relation, can_manage: await financeStaff(user, team), can_give: !(await isYouth(user.id)),
      charges: mine.map(({ member_id, payer_id, ...r }) => ({ ...r, for_member: member_id === user.id ? null : r.member_name, member_name: undefined, purpose: r.status === 'awaiting_payment' ? { purpose_type: 'team_charge', purpose_id: r.charge_id } : null })),
      owed_minor: mine.filter((r) => r.status === 'awaiting_payment').reduce((t, r) => t + Number(r.balance_minor), 0),
      totals, fundraisers,
    };
  },
});

cap({
  name: 'get_team_ledger', method: 'GET', path: '/teams/:id/ledger', tag: 'Team finance',
  summary: 'The team\'s contribution ledger for reconciliation: totals by kind, who is behind, expenses members are owed back, fundraising progress, and a check that every online payment and offline receipt matches a charge. Owner/managers and finance staff. Contains no player rates or payouts.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const team = await mustRun(user, i.id);
    const byKind = await many(
      `SELECT b.kind, count(*)::int AS charges, coalesce(sum(ch.amount_minor),0)::bigint AS raised_minor, coalesce(sum(ch.adjusted_minor),0)::bigint AS adjusted_minor, coalesce(sum(ch.settled_minor),0)::bigint AS settled_minor,
              coalesce(sum(ch.amount_minor - ch.adjusted_minor - ch.settled_minor) FILTER (WHERE ch.status='awaiting_payment'),0)::bigint AS outstanding_minor
         FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id WHERE ch.team_id=$1 AND ch.status <> 'cancelled' GROUP BY b.kind ORDER BY b.kind`, [i.id]);
    const members = await many(
      `SELECT ch.member_id, u.display_name, coalesce(sum(ch.amount_minor - ch.adjusted_minor - ch.settled_minor) FILTER (WHERE ch.status='awaiting_payment'),0)::bigint AS outstanding_minor,
              count(*) FILTER (WHERE ch.status='awaiting_payment' AND ch.due_on < current_date)::int AS overdue
         FROM team_charges ch JOIN users u ON u.id=ch.member_id WHERE ch.team_id=$1 GROUP BY ch.member_id, u.display_name HAVING coalesce(sum(ch.amount_minor - ch.adjusted_minor - ch.settled_minor) FILTER (WHERE ch.status='awaiting_payment'),0) > 0 ORDER BY 3 DESC, 2 LIMIT 200`, [i.id]);
    const reimburse = await many(
      `SELECT b.id AS batch_id, b.title, b.total_minor, b.paid_by, u.display_name AS paid_by_name,
              coalesce(sum(ch.settled_minor) FILTER (WHERE ch.member_id <> b.paid_by),0)::bigint AS collected_from_others_minor,
              coalesce(sum(ch.amount_minor - ch.adjusted_minor - ch.settled_minor) FILTER (WHERE ch.status='awaiting_payment'),0)::bigint AS still_to_collect_minor
         FROM team_charge_batches b JOIN users u ON u.id=b.paid_by JOIN team_charges ch ON ch.batch_id=b.id WHERE b.team_id=$1 AND b.kind='expense' AND b.status='active' GROUP BY b.id, u.display_name ORDER BY b.created_at DESC LIMIT 50`, [i.id]);
    const online = await one(
      `SELECT coalesce(sum(e.amount_minor) FILTER (WHERE p.status='paid'),0)::bigint AS paid_minor, coalesce(sum(e.amount_minor) FILTER (WHERE p.status='refunded'),0)::bigint AS refunded_minor
         FROM team_charge_entries e JOIN team_charges ch ON ch.id=e.charge_id JOIN payments p ON p.id=e.payment_id WHERE ch.team_id=$1 AND e.kind='receipt'`, [i.id]);
    const offline = await one("SELECT coalesce(sum(e.amount_minor),0)::bigint AS minor FROM team_charge_entries e JOIN team_charges ch ON ch.id=e.charge_id WHERE ch.team_id=$1 AND e.kind='receipt' AND e.payment_id IS NULL AND e.method <> 'fronted'", [i.id]);
    const drift = await many(
      `SELECT ch.id AS charge_id, ch.settled_minor, coalesce((SELECT sum(amount_minor) FROM team_charge_entries e WHERE e.charge_id=ch.id AND e.kind='receipt'),0)::bigint AS receipts_minor
         FROM team_charges ch WHERE ch.team_id=$1 AND ch.settled_minor <> coalesce((SELECT sum(amount_minor) FROM team_charge_entries e WHERE e.charge_id=ch.id AND e.kind='receipt'),0)`, [i.id]);
    const unapplied = await many(
      `SELECT p.id AS payment_id, p.amount_cents FROM payments p JOIN team_charges ch ON ch.id=p.purpose_id WHERE p.purpose_type='team_charge' AND p.status='paid' AND ch.team_id=$1
          AND NOT EXISTS (SELECT 1 FROM team_charge_entries e WHERE e.payment_id=p.id)`, [i.id]);
    const funds = (await many(`${FUND_SQL} WHERE f.team_id=$1 ORDER BY f.created_at DESC LIMIT 50`, [i.id])).map(withProgress);
    const settings = await one('SELECT members_see_totals FROM team_finance_settings WHERE team_id=$1', [i.id]);
    return {
      team_id: team.id, currency: team.currency, members_see_totals: !!settings?.members_see_totals, by_kind: byKind, behind: members, expenses_owed_back: reimburse, fundraisers: funds,
      reconciliation: { online_received_minor: online.paid_minor, online_refunded_minor: online.refunded_minor, offline_received_minor: offline.minor, charge_balance_drift: drift, paid_online_not_applied: unapplied,
        ok: !drift.length && !unapplied.length && Number(online.refunded_minor) === 0 },
    };
  },
});

// ------------------------------------------------------------------------------------------------------------------ adjusting and receiving
cap({
  name: 'adjust_team_charge', method: 'POST', path: '/team-charges/:charge_id/adjustments', tag: 'Team finance',
  summary: 'Reduce one member\'s charge (amount_minor) or waive what is left (kind waiver). The original amount stays; the change is a row with who did it and why, and the payer is told. Owner/managers and finance staff.',
  input: z.object({ charge_id: id, kind: z.enum(['reduction', 'waiver']), amount_minor: minor.optional(), reason: z.string().trim().min(3).max(300), idempotency_key: key }),
  async handler({ user }, i) {
    const ch = await one('SELECT team_id FROM team_charges WHERE id=$1', [i.charge_id]);
    if (!ch) throw notFound('Charge');
    await mustRun(user, ch.team_id);
    if (i.kind === 'reduction' && !i.amount_minor) throw badRequest('Say how much to take off');
    const r = await tx((c) => adjust(c, i.charge_id, { kind: i.kind, amount: i.amount_minor, reason: i.reason, actor: user.id, key: i.idempotency_key }));
    await audit(null, user.id, 'adjust_team_charge', 'team_charges', i.charge_id);
    return one(`${CHARGE_SQL} FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id WHERE ch.id=$1`, [r.charge.id]);
  },
});

cap({
  name: 'record_team_payment', method: 'POST', path: '/team-charges/:charge_id/payments', tag: 'Team finance',
  summary: 'Record money received outside the app against a charge: cash, UPI, bank transfer or card, full or part. amount_minor cannot exceed what is still owed. Idempotent per key. Owner/managers and finance staff.',
  input: z.object({ charge_id: id, amount_minor: minor, method: z.enum(METHODS), note: z.string().trim().max(300).optional().describe('e.g. the UPI reference'), idempotency_key: key }),
  async handler({ user }, i) {
    const ch = await one('SELECT team_id FROM team_charges WHERE id=$1', [i.charge_id]);
    if (!ch) throw notFound('Charge');
    await mustRun(user, ch.team_id);
    const ok = await tx((c) => applyReceipt(c, i.charge_id, { amount: i.amount_minor, method: i.method, actor: user.id, key: i.idempotency_key, note: i.note }));
    if (!ok) throw conflict('That cannot be recorded: the charge is closed or the amount is more than is still owed');
    await audit(null, user.id, 'record_team_payment', 'team_charges', i.charge_id);
    return one(`${CHARGE_SQL} FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id WHERE ch.id=$1`, [i.charge_id]);
  },
});

cap({
  name: 'cancel_team_charge', method: 'POST', path: '/team-charges/:charge_id/cancel', tag: 'Team finance',
  summary: 'Cancel a charge raised by mistake. Only a charge with nothing paid on it; the row is kept as cancelled. Owner/managers and finance staff.',
  input: z.object({ charge_id: id, reason: z.string().trim().min(3).max(300) }),
  async handler({ user }, i) {
    const ch = await one('SELECT team_id FROM team_charges WHERE id=$1', [i.charge_id]);
    if (!ch) throw notFound('Charge');
    await mustRun(user, ch.team_id);
    return tx(async (c) => {
      const r = (await c.query("UPDATE team_charges SET status='cancelled' WHERE id=$1 AND status='awaiting_payment' AND settled_minor=0 RETURNING id", [i.charge_id])).rowCount;
      if (!r) throw conflict('Only an unpaid charge with nothing received can be cancelled');
      await c.query("INSERT INTO team_charge_entries(charge_id, kind, reason_enc, actor_id, idempotency_key) VALUES ($1,'cancelled',$2,$3,'cancelled')", [i.charge_id, sealReason(i.reason), user.id]);
      await audit(c, user.id, 'cancel_team_charge', 'team_charges', i.charge_id);
      return (await c.query(`${CHARGE_SQL} FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id WHERE ch.id=$1`, [i.charge_id])).rows[0];
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ recurring dues
const PLAN = 'SELECT id AS plan_id, team_id, title, currency, amount_minor, every_months, next_on::text AS next_on, due_days, ends_on::text AS ends_on, status, created_at FROM team_dues_plans';
cap({
  name: 'create_team_dues_plan', method: 'POST', path: '/teams/:id/dues-plans', tag: 'Team finance', status: 201,
  summary: 'Charge every active player the same dues every N months (monthly, quarterly, a season). The worker raises one charge per member per period - never twice - and reminds payers before and after the due date. Owner/managers.',
  input: z.object({ id, title: z.string().trim().min(1).max(120), amount_minor: minor, every_months: z.coerce.number().int().min(1).max(12), starts_on: day, due_days: z.coerce.number().int().min(0).max(60).default(7), ends_on: day.optional() }),
  async handler({ user }, i) {
    const team = await mustRun(user, i.id);
    if (i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
    const p = await one('INSERT INTO team_dues_plans(team_id, title, currency, amount_minor, every_months, next_on, due_days, ends_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [i.id, i.title, team.currency, i.amount_minor, i.every_months, i.starts_on, i.due_days, i.ends_on ?? null, user.id]);
    await audit(null, user.id, 'create_team_dues_plan', 'team_dues_plans', p.id);
    await raiseTeamDues();   // a plan that starts today or earlier charges now; the worker handles every later period
    return one(`${PLAN} WHERE id=$1`, [p.id]);
  },
});
cap({
  name: 'list_team_dues_plans', method: 'GET', path: '/teams/:id/dues-plans', tag: 'Team finance', summary: 'The team\'s recurring dues plans. Owner/managers and finance staff.', input: z.object({ id }),
  async handler({ user }, i) { await mustRun(user, i.id); return many(`${PLAN} WHERE team_id=$1 ORDER BY created_at DESC`, [i.id]); },
});
cap({
  name: 'update_team_dues_plan', method: 'PATCH', path: '/team-dues-plans/:plan_id', tag: 'Team finance',
  summary: 'Pause, resume or end a recurring dues plan. Charges already raised stay as they are.', input: z.object({ plan_id: id, status: z.enum(['active', 'paused', 'ended']) }),
  async handler({ user }, i) {
    const p = await one('SELECT team_id, status FROM team_dues_plans WHERE id=$1', [i.plan_id]);
    if (!p) throw notFound('Dues plan');
    await mustRun(user, p.team_id);
    if (p.status === 'ended') throw conflict('This plan has ended; create a new one');
    await one('UPDATE team_dues_plans SET status=$2 WHERE id=$1 RETURNING id', [i.plan_id, i.status]);
    return one(`${PLAN} WHERE id=$1`, [i.plan_id]);
  },
});

// ------------------------------------------------------------------------------------------------------------------ fundraising
const FUND_SQL = `SELECT f.id AS fundraiser_id, f.team_id, f.title, f.purpose, f.currency, f.target_minor, f.closes_on::text AS closes_on, f.status, f.approved_at, f.sponsorship_id, f.created_at,
                         coalesce((SELECT sum(c.amount_minor) FROM team_contributions c WHERE c.fundraiser_id=f.id AND c.status='paid'),0)::bigint AS raised_minor,
                         (SELECT count(DISTINCT c.contributor_id)::int FROM team_contributions c WHERE c.fundraiser_id=f.id AND c.status='paid') AS contributors
                    FROM team_fundraisers f`;
const withProgress = (f) => ({ ...f, percent: Math.min(100, Math.floor((Number(f.raised_minor) * 100) / Number(f.target_minor))) });

cap({
  name: 'create_team_fundraiser', method: 'POST', path: '/teams/:id/fundraisers', tag: 'Team finance', status: 201,
  summary: 'Start a member fundraiser with a target and a stated purpose. Gifts are contributions paid through the canonical checkout or recorded by a manager. When the team owner creates it, it opens at once; when a manager does, the owner approves the purpose first. A fundraiser is not sponsorship: pass sponsorship_id only to link an agreed sponsorship of this team on purpose.',
  input: z.object({ id, title: z.string().trim().min(1).max(120), purpose: z.string().trim().min(3).max(500), target_minor: minor, closes_on: day.optional(), sponsorship_id: id.optional() }),
  async handler({ user }, i) {
    const team = await mustRun(user, i.id);
    if (i.sponsorship_id && !(await one("SELECT 1 FROM sponsorships WHERE id=$1 AND target_type='team' AND target_id=$2 AND status IN ('proposed','active')", [i.sponsorship_id, i.id]))) throw badRequest('That sponsorship is not an agreement with this team');
    const auto = team.owner_id === user.id;
    const f = await one(
      `INSERT INTO team_fundraisers(team_id, title, purpose, currency, target_minor, closes_on, status, approved_by, approved_at, sponsorship_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [i.id, i.title, i.purpose, team.currency, i.target_minor, i.closes_on ?? null, auto ? 'active' : 'draft', auto ? user.id : null, auto ? new Date() : null, i.sponsorship_id ?? null, user.id]);
    await audit(null, user.id, 'create_team_fundraiser', 'team_fundraisers', f.id);
    if (!auto) await notify(null, team.owner_id, { kind: 'team_fundraiser_approval', title: `${team.name}: approve a fundraiser`, body: i.title.slice(0, 140), data: { team_id: team.id, fundraiser_id: f.id }, dedupe_key: `team_fundraiser:approve:${f.id}` });
    return withProgress(await one(`${FUND_SQL} WHERE f.id=$1`, [f.id]));
  },
});

cap({
  name: 'decide_team_fundraiser', method: 'POST', path: '/teams/:id/fundraisers/:fundraiser_id/decision', tag: 'Team finance',
  summary: 'Approve a draft fundraiser (the team owner), or close / cancel one. Closing stops new gifts; paid gifts are kept. Cancelling also withdraws gifts that were never paid.',
  input: z.object({ id, fundraiser_id: id, action: z.enum(['approve', 'close', 'cancel']) }),
  async handler({ user }, i) {
    const team = await mustRun(user, i.id);
    const f = await one('SELECT * FROM team_fundraisers WHERE id=$1 AND team_id=$2', [i.fundraiser_id, i.id]);
    if (!f) throw notFound('Fundraiser');
    if (i.action === 'approve') {
      if (team.owner_id !== user.id && !user.roles?.includes('admin')) throw forbidden('The team owner approves a fundraiser\'s purpose');
      if (f.status !== 'draft') throw conflict('Only a draft fundraiser needs approval');
      await one("UPDATE team_fundraisers SET status='active', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING id", [f.id, user.id]);
    } else {
      if (!['draft', 'active'].includes(f.status)) throw conflict(`This fundraiser is already ${f.status}`);
      await tx(async (c) => {
        await c.query('UPDATE team_fundraisers SET status=$2 WHERE id=$1', [f.id, i.action === 'close' ? 'closed' : 'cancelled']);
        await c.query("UPDATE team_contributions SET status='cancelled' WHERE fundraiser_id=$1 AND status='awaiting_payment'", [f.id]);
      });
    }
    await audit(null, user.id, `${i.action}_team_fundraiser`, 'team_fundraisers', f.id);
    return withProgress(await one(`${FUND_SQL} WHERE f.id=$1`, [f.id]));
  },
});

cap({
  name: 'list_team_fundraisers', method: 'GET', path: '/teams/:id/fundraisers', tag: 'Team finance',
  summary: 'The team\'s fundraisers with target and progress. Members and guardians see the open ones; managers see drafts and closed ones too.', input: z.object({ id }),
  async handler({ user }, i) {
    const team = await mustFind('teams', i.id);
    const staff = await financeStaff(user, team);
    if (!staff) await mustBeInvolved(user, team);
    return (await many(`${FUND_SQL} WHERE f.team_id=$1 AND ($2 OR f.status='active') ORDER BY f.created_at DESC LIMIT 50`, [i.id, staff])).map(withProgress);
  },
});

cap({
  name: 'get_team_fundraiser', method: 'GET', path: '/teams/:id/fundraisers/:fundraiser_id', tag: 'Team finance',
  summary: 'One fundraiser: purpose, target, progress and your own gifts. Managers also see every gift with its giver (anonymous gifts are still shown to managers for reconciliation, never to members).',
  input: z.object({ id, fundraiser_id: id }),
  async handler({ user }, i) {
    const team = await mustFind('teams', i.id);
    const staff = await financeStaff(user, team);
    if (!staff) await mustBeInvolved(user, team);
    const f = await one(`${FUND_SQL} WHERE f.id=$1 AND f.team_id=$2`, [i.fundraiser_id, i.id]);
    if (!f || (!staff && f.status !== 'active')) throw notFound('Fundraiser');
    const gifts = await many(
      `SELECT c.id AS contribution_id, c.amount_minor, c.status, c.method, c.paid_at, c.created_at, c.anonymous, c.contributor_id, u.display_name FROM team_contributions c JOIN users u ON u.id=c.contributor_id
        WHERE c.fundraiser_id=$1 AND ($2 OR c.contributor_id=$3) AND c.status <> 'cancelled' ORDER BY c.created_at DESC LIMIT 200`, [i.fundraiser_id, staff, user.id]);
    return { ...withProgress(f), contributions: gifts.map(({ contributor_id, display_name, ...g }) => ({ ...g, mine: contributor_id === user.id, from: staff || contributor_id === user.id ? display_name : null, purpose: g.status === 'awaiting_payment' && contributor_id === user.id ? { purpose_type: 'team_contribution', purpose_id: g.contribution_id } : null })) };
  },
});

cap({
  name: 'contribute_to_team_fundraiser', method: 'POST', path: '/teams/:id/fundraisers/:fundraiser_id/contributions', tag: 'Team finance', status: 201,
  summary: 'Give to an open fundraiser. Returns the contribution with purpose_type / purpose_id to pass to create_payment; it counts towards the target once paid. Members and the guardians of young members can give (a young person gives through a guardian). Retries with the same key return the same gift.',
  input: z.object({ id, fundraiser_id: id, amount_minor: minor, anonymous: z.boolean().default(false), idempotency_key: key }),
  async handler({ user }, i) {
    const team = await mustFind('teams', i.id);
    await mustBeInvolved(user, team);
    if (await isYouth(user.id)) throw forbidden('A guardian gives on behalf of a young person');
    const f = await one('SELECT * FROM team_fundraisers WHERE id=$1 AND team_id=$2', [i.fundraiser_id, i.id]);
    if (!f) throw notFound('Fundraiser');
    if (f.status !== 'active' || (f.closes_on && new Date(f.closes_on) < new Date(new Date().toISOString().slice(0, 10)))) throw conflict('This fundraiser is not taking gifts');
    const c = await one(
      `INSERT INTO team_contributions(fundraiser_id, contributor_id, amount_minor, anonymous, idempotency_key) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (fundraiser_id, contributor_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id, amount_minor, status, anonymous, created_at`,
      [i.fundraiser_id, user.id, i.amount_minor, i.anonymous, i.idempotency_key]);
    return { contribution_id: c.id, ...c, id: undefined, currency: f.currency, purpose: c.status === 'awaiting_payment' ? { purpose_type: 'team_contribution', purpose_id: c.id } : null };
  },
});

cap({
  name: 'record_team_contribution', method: 'POST', path: '/teams/:id/fundraisers/:fundraiser_id/recorded-contributions', tag: 'Team finance', status: 201,
  summary: 'Record a gift received outside the app (cash, UPI, bank) from a member or guardian. Counts towards the target at once. Idempotent per key. Owner/managers and finance staff.',
  input: z.object({ id, fundraiser_id: id, contributor_id: id, amount_minor: minor, method: z.enum(METHODS), anonymous: z.boolean().default(false), idempotency_key: key }),
  async handler({ user }, i) {
    const team = await mustRun(user, i.id);
    const f = await one('SELECT * FROM team_fundraisers WHERE id=$1 AND team_id=$2', [i.fundraiser_id, i.id]);
    if (!f) throw notFound('Fundraiser');
    if (f.status !== 'active') throw conflict('This fundraiser is not taking gifts');
    if (!(await involved(team.id, i.contributor_id))) throw badRequest('The giver must be a member or a guardian of a young member');
    if (await isYouth(i.contributor_id)) throw badRequest('A young person gives through a guardian');
    const c = await one(
      `INSERT INTO team_contributions(fundraiser_id, contributor_id, amount_minor, anonymous, method, status, paid_at, recorded_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,'paid',now(),$6,$7)
       ON CONFLICT (fundraiser_id, contributor_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id, amount_minor, status, method, paid_at`,
      [i.fundraiser_id, i.contributor_id, i.amount_minor, i.anonymous, i.method, user.id, i.idempotency_key]);
    await audit(null, user.id, 'record_team_contribution', 'team_contributions', c.id);
    return { contribution_id: c.id, ...c, id: undefined, currency: f.currency };
  },
});
