// Recurring collections & dunning (issue #511) - one capability definition per action; REST, OpenAPI and MCP share it.
// This is the finance desk's view of money that is owed repeatedly. It never holds money of its own: the charge, the invoice and the payment stay
// canonical (academy_charges / invoices / payments, and user_plans for venue memberships). Authorisation, validation, encryption of internal notes and
// audit logging are enforced here on the server; outsiders get a 404 so existence is not leaked.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { financeStaff, openReason as openTeamReason } from '../team-money.js';
import { venueTeam, notify } from '../notify.js';
import { guardianLink, guardiansOf, isYouth } from '../youth.js';
import { encrypt } from '../crypto.js';
import { STAFF_MONEY } from '../academy.js';
import { applyAdjustment } from '../academy-invoices.js';
import {
  DEFAULT_POLICY, STATES, OPEN_STATES, policyFor, ensureCases, addEvent, openNote, sealReason, openReason, buildDueDates, raiseForSchedule, collectionsReport,
  suspend, lift, todayStr, daysBetween, payersToTell,
} from '../collections.js';

const TAG = 'Collections';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const cur = z.string().regex(/^[A-Z]{3}$/);
const owner = { organisation_id: id.optional(), venue_id: id.optional(), team_id: id.optional() };
const oneOwner = (i) => { if ([i.organisation_id, i.venue_id, i.team_id].filter(Boolean).length !== 1) throw badRequest('Give exactly one of organisation_id, venue_id or team_id'); };

/** The finance desk of an organisation (owner / admin / finance) or of a venue (its owner and staff). Anyone else gets a 404. */
async function deskFor(user, i, { write = false, c } = {}) {
  oneOwner(i);
  if (i.organisation_id) { await orgFor(user, i.organisation_id, STAFF_MONEY, { write, c }); return { type: 'organisation', id: i.organisation_id }; }
  if (i.team_id) {
    const t = (await (c ?? pool).query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
    if (!t || !(isAdmin(user) || (await financeStaff(user, t)))) throw notFound('Team');   // the team's owner, managers and finance staff; anyone else gets a 404
    return { type: 'team', id: t.id };
  }
  const v = (await (c ?? pool).query('SELECT id FROM venues WHERE id=$1', [i.venue_id])).rows[0];
  if (!v || !(isAdmin(user) || (await venueTeam(c ?? null, v.id)).includes(user.id))) throw notFound('Venue');
  return { type: 'venue', id: v.id };
}
const deskOfCase = async (user, cs, opts) => deskFor(user, { [{ organisation: 'organisation_id', venue: 'venue_id', team: 'team_id' }[cs.owner_type]]: cs.owner_id }, opts);

// ---------------------------------------------------------------------------------------------------- policy
cap({
  name: 'get_collection_policy', method: 'GET', path: '/collections/policy', tag: TAG,
  summary: 'How this organisation (or venue) chases money (owner/admin/finance, or venue team): reminder cadence, grace days, retry schedule after a failed payment, escalation, and the optional late fee and suspension rules. `customised: false` means the built-in defaults apply. Late fees and suspension are always off until someone chooses them.',
  input: z.object({ ...owner }),
  async handler({ user }, i) { const d = await deskFor(user, i); return { ...(await policyFor(pool, d.type, d.id)), defaults: DEFAULT_POLICY }; },
});

const offsets = z.array(z.number().int().min(-30).max(90)).min(1).max(12);
cap({
  name: 'set_collection_policy', method: 'PATCH', path: '/collections/policy', tag: TAG,
  summary: 'Change the collections policy (organisation owner/admin/finance, or venue team). reminder_offsets are days from the due date (-3 = three days before). A late fee needs an amount and the contractual basis for it; suspension pauses access to future sessions only and is reversed when the money is paid or waived - it never removes enrolment, attendance or health records. Late fees and suspension apply to academy / club charges, not venue memberships.',
  input: z.object({ ...owner, reminder_offsets: offsets.optional(), grace_days: z.number().int().min(0).max(60).optional(), retry_days: z.array(z.number().int().min(1).max(30)).max(6).optional(),
    escalate_after_days: z.number().int().min(1).max(365).optional(), late_fee_enabled: z.boolean().optional(), late_fee_minor: z.number().int().min(0).max(100_000_000).optional(), late_fee_currency: cur.optional(),
    late_fee_after_days: z.number().int().min(1).max(365).optional(), late_fee_basis: z.string().trim().min(10).max(300).optional(), suspension_enabled: z.boolean().optional(), suspend_after_days: z.number().int().min(1).max(365).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const d = await deskFor(user, i, { write: true, c });
    const { organisation_id, venue_id, team_id, ...patch } = i;
    if (d.type !== 'organisation' && (patch.late_fee_enabled || patch.suspension_enabled)) throw unprocessable('Late fees and suspension apply to academy and club charges, not to venue memberships or team dues');
    const cur_ = await policyFor(c, d.type, d.id);
    const next = { ...cur_, ...patch };
    next.reminder_offsets = [...new Set(next.reminder_offsets)].sort((a, b) => a - b);
    if (next.late_fee_enabled && (!(next.late_fee_minor > 0) || !next.late_fee_basis || !next.late_fee_currency)) throw unprocessable('A late fee needs an amount, its currency and the contractual basis it rests on');
    await c.query(
      `INSERT INTO collection_policies(owner_type, owner_id, reminder_offsets, grace_days, retry_days, escalate_after_days, late_fee_enabled, late_fee_minor, late_fee_currency, late_fee_after_days, late_fee_basis, suspension_enabled, suspend_after_days, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (owner_type, owner_id) DO UPDATE SET reminder_offsets=$3, grace_days=$4, retry_days=$5, escalate_after_days=$6, late_fee_enabled=$7, late_fee_minor=$8, late_fee_currency=$9, late_fee_after_days=$10, late_fee_basis=$11, suspension_enabled=$12, suspend_after_days=$13, updated_by=$14, updated_at=now()`,
      [d.type, d.id, next.reminder_offsets, next.grace_days, next.retry_days, next.escalate_after_days, next.late_fee_enabled, next.late_fee_minor, next.late_fee_currency, next.late_fee_after_days, next.late_fee_basis, next.suspension_enabled, next.suspend_after_days, user.id]);
    await audit(c, user.id, 'set_collection_policy', { organisation: 'organisations', venue: 'venues', team: 'teams' }[d.type], d.id);
    return { ...(await policyFor(c, d.type, d.id)), defaults: DEFAULT_POLICY };
  }),
});

// ---------------------------------------------------------------------------------------------------- the desk
const CASE_COLS = `cs.id, cs.state, cs.source_type, cs.source_id, cs.due_on::text AS due_on, (current_date - cs.due_on) AS days_past_due, cs.currency, cs.attempts, cs.failed_attempts, cs.last_attempt_at, cs.last_reminder_at,
  cs.promised_on::text AS promised_on, cs.hold_until::text AS hold_until, cs.next_action, cs.next_action_on::text AS next_action_on, cs.had_trouble, cs.opened_at, cs.closed_at, cs.payer_id`;

cap({
  name: 'list_collection_cases', method: 'GET', path: '/collections/cases', tag: TAG,
  summary: 'The collections work queue (organisation owner/admin/finance, or venue team): every due, failed, overdue and escalated payment with the amount, balance, attempts, reminder history, promise to pay, hold and next action, most overdue first. Cases are opened for unpaid charges (and venue membership renewals) automatically. Totals are per currency and are never added across currencies. Internal notes are not in the list.',
  input: z.object({ ...owner, state: z.string().max(120).optional().describe('comma-separated states, or "open" (default) / "closed" / "all"'), currency: cur.optional(), q: z.string().trim().max(60).optional().describe('part of the payer or athlete name'),
    needs_action: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional().describe('only cases with no promise or hold'), ...page, limit: z.coerce.number().int().min(1).max(100).default(50) }),
  async handler({ user }, i) {
    const d = await deskFor(user, i);
    await tx((c) => ensureCases(c, d.type, d.id));
    const wanted = !i.state || i.state === 'open' ? OPEN_STATES : i.state === 'closed' ? ['paid', 'resolved', 'waived', 'cancelled'] : i.state === 'all' ? STATES : i.state.split(',').map((x) => x.trim()).filter((x) => STATES.includes(x));
    if (!wanted.length) throw badRequest('Unknown state');
    const args = [d.type, d.id, wanted, i.currency ?? null, i.q ? `%${i.q.replace(/[%_]/g, '')}%` : null, i.needs_action ?? null];
    const filter = `cs.owner_type=$1 AND cs.owner_id=$2 AND cs.state = ANY($3) AND ($4::text IS NULL OR cs.currency=$4) AND ($6::boolean IS NULL OR ((cs.promised_on IS NULL OR cs.promised_on < current_date) AND (cs.hold_until IS NULL OR cs.hold_until < current_date)) = $6)`;
    const items = d.type === 'organisation'
      ? await many(
        `SELECT ${CASE_COLS}, ch.kind, ch.amount_minor, ch.settled_minor, ch.adjusted_minor, ch.amount_minor - ch.settled_minor - ch.adjusted_minor AS balance_minor,
                pu.display_name AS payer_name, au.display_name AS athlete_name, au.id AS athlete_id, pr.title AS programme,
                EXISTS (SELECT 1 FROM payment_plans pp WHERE pp.charge_id=ch.id AND pp.status='active') AS has_plan,
                EXISTS (SELECT 1 FROM entitlement_suspensions xs WHERE xs.enrolment_id=ch.enrolment_id AND xs.status='active') AS suspended,
                (SELECT i.number FROM invoices i WHERE i.academy_charge_id=ch.id AND i.kind='invoice' AND i.status IN ('open','paid') LIMIT 1) AS invoice_number
           FROM collection_cases cs JOIN academy_charges ch ON ch.id=cs.source_id JOIN users pu ON pu.id=cs.payer_id
           LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id JOIN users au ON au.id=coalesce(e.user_id, a.athlete_id)
           LEFT JOIN academy_programmes pr ON pr.id=coalesce(e.programme_id, a.programme_id)
          WHERE ${filter} AND ($5::text IS NULL OR pu.display_name ILIKE $5 OR au.display_name ILIKE $5)
          ORDER BY (cs.state IN ('escalated','overdue')) DESC, cs.due_on, cs.id LIMIT $7 OFFSET $8`, [...args, i.limit, i.offset])
      : d.type === 'team'
      ? await many(
        `SELECT ${CASE_COLS}, b.kind, ch.amount_minor, ch.settled_minor, ch.adjusted_minor, ch.amount_minor - ch.settled_minor - ch.adjusted_minor AS balance_minor,
                pu.display_name AS payer_name, mu.display_name AS athlete_name, mu.id AS athlete_id, b.title AS programme, false AS has_plan, false AS suspended,
                (SELECT i.number FROM invoices i WHERE i.team_charge_id=ch.id AND i.kind='invoice' AND i.status IN ('open','paid') LIMIT 1) AS invoice_number
           FROM collection_cases cs JOIN team_charges ch ON ch.id=cs.source_id JOIN team_charge_batches b ON b.id=ch.batch_id JOIN users pu ON pu.id=cs.payer_id JOIN users mu ON mu.id=ch.member_id
          WHERE ${filter} AND ($5::text IS NULL OR pu.display_name ILIKE $5 OR mu.display_name ILIKE $5)
          ORDER BY (cs.state IN ('escalated','overdue')) DESC, cs.due_on, cs.id LIMIT $7 OFFSET $8`, [...args, i.limit, i.offset])
      : await many(
        `SELECT ${CASE_COLS}, 'membership' AS kind, up.price_cents AS amount_minor, 0 AS settled_minor, 0 AS adjusted_minor, CASE WHEN up.status='awaiting_payment' THEN up.price_cents ELSE 0 END AS balance_minor,
                pu.display_name AS payer_name, pu.display_name AS athlete_name, pu.id AS athlete_id, up.name AS programme, false AS has_plan, false AS suspended, NULL::text AS invoice_number
           FROM collection_cases cs JOIN user_plans up ON up.id=cs.source_id JOIN users pu ON pu.id=cs.payer_id
          WHERE ${filter} AND ($5::text IS NULL OR pu.display_name ILIKE $5)
          ORDER BY (cs.state IN ('escalated','overdue')) DESC, cs.due_on, cs.id LIMIT $7 OFFSET $8`, [...args, i.limit, i.offset]);
    const totals = await many(
      d.type === 'organisation'
        ? `SELECT cs.currency, count(*)::int AS cases, coalesce(sum(ch.amount_minor - ch.settled_minor - ch.adjusted_minor),0)::bigint AS balance_minor,
                  coalesce(sum(ch.amount_minor - ch.settled_minor - ch.adjusted_minor) FILTER (WHERE cs.state IN ('overdue','escalated')),0)::bigint AS overdue_minor
             FROM collection_cases cs JOIN academy_charges ch ON ch.id=cs.source_id WHERE cs.owner_type='organisation' AND cs.owner_id=$1 AND cs.state = ANY($2) GROUP BY 1 ORDER BY 1`
        : d.type === 'team'
        ? `SELECT cs.currency, count(*)::int AS cases, coalesce(sum(ch.amount_minor - ch.settled_minor - ch.adjusted_minor),0)::bigint AS balance_minor,
                  coalesce(sum(ch.amount_minor - ch.settled_minor - ch.adjusted_minor) FILTER (WHERE cs.state IN ('overdue','escalated')),0)::bigint AS overdue_minor
             FROM collection_cases cs JOIN team_charges ch ON ch.id=cs.source_id WHERE cs.owner_type='team' AND cs.owner_id=$1 AND cs.state = ANY($2) GROUP BY 1 ORDER BY 1`
        : `SELECT cs.currency, count(*)::int AS cases, coalesce(sum(up.price_cents),0)::bigint AS balance_minor, coalesce(sum(up.price_cents) FILTER (WHERE cs.state IN ('overdue','escalated')),0)::bigint AS overdue_minor
             FROM collection_cases cs JOIN user_plans up ON up.id=cs.source_id WHERE cs.owner_type='venue' AND cs.owner_id=$1 AND cs.state = ANY($2) GROUP BY 1 ORDER BY 1`, [d.id, OPEN_STATES]);
    const states = await many('SELECT state, count(*)::int AS n FROM collection_cases WHERE owner_type=$1 AND owner_id=$2 GROUP BY 1 ORDER BY 1', [d.type, d.id]);
    return { items, totals, states: Object.fromEntries(states.map((s) => [s.state, s.n])), owner: d };
  },
});

cap({
  name: 'get_collection_case', method: 'GET', path: '/collections/cases/:id', tag: TAG,
  summary: 'One collections case in full (organisation owner/admin/finance, or venue team): the charge or renewal behind it with its receipts, waivers and concessions, any payment plan, the recurring schedule and mandate state (the mandate is a permission to collect, not a payment), access suspension, and the complete history of reminders, attempts, promises and internal notes. Reading the internal notes is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cs = await one('SELECT *, due_on::text AS due_s, promised_on::text AS promised_s, hold_until::text AS hold_s FROM collection_cases WHERE id=$1', [i.id]);
    if (!cs) throw notFound('Case');
    await deskOfCase(user, cs);
    await audit(null, user.id, 'read_collection_case', 'collection_cases', cs.id);
    const events = (await many('SELECT e.id, e.kind, e.data, e.note_enc, e.created_at, u.display_name AS actor FROM collection_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.case_id=$1 ORDER BY e.created_at, e.id', [cs.id]))
      .map(({ note_enc, ...e }) => ({ ...e, note: openNote(note_enc) }));
    let source = null, receipts = [], adjustments = [], plan = null, schedule = null, suspension = null;
    if (cs.source_type === 'academy_charge') {
      source = await one(
        `SELECT ch.id, ch.kind, ch.due_on::text AS due_on, ch.currency, ch.gross_minor, ch.discount_minor, ch.funded_minor, ch.funding_source, ch.tax_minor, ch.amount_minor, ch.settled_minor, ch.adjusted_minor,
                ch.amount_minor - ch.settled_minor - ch.adjusted_minor AS balance_minor, ch.status, ch.paid_at, ch.enrolment_id, ch.parent_charge_id, pu.display_name AS payer_name, au.display_name AS athlete_name, au.id AS athlete_id, pr.title AS programme,
                (SELECT i.id FROM invoices i WHERE i.academy_charge_id=ch.id AND i.kind='invoice' AND i.status IN ('open','paid') LIMIT 1) AS invoice_id,
                (SELECT i.number FROM invoices i WHERE i.academy_charge_id=ch.id AND i.kind='invoice' AND i.status IN ('open','paid') LIMIT 1) AS invoice_number
           FROM academy_charges ch JOIN users pu ON pu.id=ch.payer_id LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
           JOIN users au ON au.id=coalesce(e.user_id, a.athlete_id) LEFT JOIN academy_programmes pr ON pr.id=coalesce(e.programme_id, a.programme_id) WHERE ch.id=$1`, [cs.source_id]);
      receipts = await many('SELECT id, amount_minor, method, payment_id, created_at FROM charge_receipts WHERE charge_id=$1 ORDER BY created_at, id', [cs.source_id]);
      adjustments = (await many('SELECT x.id, x.kind, x.amount_minor, x.reason_enc, x.created_at, u.display_name AS actor FROM charge_adjustments x JOIN users u ON u.id=x.actor_id WHERE x.charge_id=$1 ORDER BY x.created_at, x.id', [cs.source_id]))
        .map(({ reason_enc, ...x }) => ({ ...x, reason: openReason(reason_enc) }));
      plan = await one("SELECT id, status, instalments, balance_minor, approved_at FROM payment_plans WHERE charge_id=$1 ORDER BY approved_at DESC LIMIT 1", [cs.source_id]);
      schedule = await one(`SELECT s.id, s.label, s.kind, s.status, s.mandate_status, (s.mandate_ref IS NOT NULL) AS has_mandate, p.period_no, cardinality(s.due_dates) AS periods FROM billing_schedule_periods p JOIN billing_schedules s ON s.id=p.schedule_id WHERE p.charge_id=$1`, [cs.source_id]);
      if (source?.enrolment_id) suspension = await one("SELECT id, status, reason, starts_at, lifted_at, lift_reason FROM entitlement_suspensions WHERE enrolment_id=$1 ORDER BY starts_at DESC LIMIT 1", [source.enrolment_id]);
    } else if (cs.source_type === 'team_charge') {
      source = await one(
        `SELECT ch.id, b.kind, ch.due_on::text AS due_on, b.currency, ch.amount_minor, ch.settled_minor, ch.adjusted_minor, ch.amount_minor - ch.settled_minor - ch.adjusted_minor AS balance_minor, ch.status, ch.paid_at,
                pu.display_name AS payer_name, mu.display_name AS athlete_name, mu.id AS athlete_id, b.title AS programme,
                (SELECT i.id FROM invoices i WHERE i.team_charge_id=ch.id AND i.kind='invoice' AND i.status IN ('open','paid') LIMIT 1) AS invoice_id,
                (SELECT i.number FROM invoices i WHERE i.team_charge_id=ch.id AND i.kind='invoice' AND i.status IN ('open','paid') LIMIT 1) AS invoice_number
           FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id JOIN users pu ON pu.id=ch.payer_id JOIN users mu ON mu.id=ch.member_id WHERE ch.id=$1`, [cs.source_id]);
      receipts = await many("SELECT id, amount_minor, method, payment_id, created_at FROM team_charge_entries WHERE charge_id=$1 AND kind='receipt' ORDER BY created_at, id", [cs.source_id]);
      adjustments = (await many("SELECT x.id, x.kind, x.amount_minor, x.reason_enc, x.created_at, u.display_name AS actor FROM team_charge_entries x JOIN users u ON u.id=x.actor_id WHERE x.charge_id=$1 AND x.kind IN ('reduction','waiver') ORDER BY x.created_at, x.id", [cs.source_id]))
        .map(({ reason_enc, ...x }) => ({ ...x, reason: openTeamReason(reason_enc) }));
    } else {
      source = await one("SELECT up.id, up.name, up.currency, up.price_cents AS amount_minor, up.status, up.expires_at FROM user_plans up WHERE up.id=$1", [cs.source_id]);
    }
    if (events.some((e) => e.note) || adjustments.some((a) => a.reason)) await audit(null, user.id, 'read_collection_notes', 'collection_cases', cs.id);
    const { due_s, promised_s, hold_s, ...rest } = cs;
    return { ...rest, due_on: due_s, promised_on: promised_s, hold_until: hold_s, days_past_due: daysBetween(due_s, todayStr()), source, receipts, adjustments, payment_plan: plan, schedule, suspension, events, policy: await policyFor(pool, cs.owner_type, cs.owner_id) };
  },
});

const reason = z.string().trim().min(3).max(300);
cap({
  name: 'act_on_collection_case', method: 'POST', path: '/collections/cases/:id/actions', tag: TAG,
  summary: 'Human work on a collections case (organisation owner/admin/finance, or venue team). note: add an internal note (encrypted, never sent to the payer). promise: record the payer\'s promise to pay by a date; reminders pause until it passes and a broken promise is recorded. hold / release_hold: pause reminders, late fees and suspension until a date, with a reason (at most 90 days). next_action: set the follow-up. suspend: pause access to future sessions (only where the policy allows suspension). reinstate: restore access now and hold the case for a while. None of these change what is owed.',
  input: z.object({ id, action: z.enum(['note', 'promise', 'hold', 'release_hold', 'next_action', 'suspend', 'reinstate']), note: z.string().trim().min(1).max(1000).optional(), promised_on: day.optional(), until: day.optional(), reason: reason.optional(),
    next_action: z.string().trim().min(2).max(160).optional(), next_action_on: day.optional(), idempotency_key: z.string().min(8).max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cs = (await c.query('SELECT * FROM collection_cases WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cs) throw notFound('Case');
    await deskOfCase(user, cs, { write: true, c });
    const today = todayStr();
    const closed = !OPEN_STATES.includes(cs.state);
    if (closed && i.action !== 'note') throw conflict('This case is closed. You can still add a note.');
    const key = (k) => (i.idempotency_key ? `${k}:${i.idempotency_key}` : null);
    const need = (v, msg) => { if (v === undefined || v === '') throw badRequest(msg); return v; };
    const within = (d, max, what) => { if (d < today) throw unprocessable(`${what} cannot be in the past`); if (daysBetween(today, d) > max) throw unprocessable(`${what} can be at most ${max} days ahead`); return d; };
    let data = {};
    switch (i.action) {
      case 'note': await addEvent(c, cs.id, 'note', { actor: user.id, note: need(i.note, 'Write the note'), dedupe: key('note') }); break;
      case 'promise': {
        const on = within(need(i.promised_on, 'Give the date the payer promised to pay by'), 60, 'The promise date');
        await c.query('UPDATE collection_cases SET promised_on=$2 WHERE id=$1', [cs.id, on]);
        await addEvent(c, cs.id, 'promise', { actor: user.id, data: { promised_on: on }, note: i.note, dedupe: key('promise') }); data = { promised_on: on }; break;
      }
      case 'hold': {
        const until = within(need(i.until, 'Give the date the hold lasts until'), 90, 'The hold');
        need(i.reason, 'Say why the case is on hold');
        await c.query('UPDATE collection_cases SET hold_until=$2 WHERE id=$1', [cs.id, until]);
        await addEvent(c, cs.id, 'hold', { actor: user.id, data: { until }, note: i.reason, dedupe: key('hold') }); data = { hold_until: until }; break;
      }
      case 'release_hold':
        await c.query('UPDATE collection_cases SET hold_until=NULL, promised_on=NULL WHERE id=$1', [cs.id]);
        await addEvent(c, cs.id, 'hold_released', { actor: user.id, note: i.reason, dedupe: key('release') }); break;
      case 'next_action':
        await c.query('UPDATE collection_cases SET next_action=$2, next_action_on=$3 WHERE id=$1', [cs.id, need(i.next_action, 'Say what happens next'), i.next_action_on ?? null]);
        await addEvent(c, cs.id, 'next_action', { actor: user.id, data: { next_action: i.next_action, on: i.next_action_on ?? null }, dedupe: key('next') }); break;
      case 'suspend': case 'reinstate': {
        if (cs.source_type !== 'academy_charge') throw unprocessable('Access can only be paused for an academy or club enrolment');
        const ch = (await c.query('SELECT enrolment_id, organisation_id FROM academy_charges WHERE id=$1', [cs.source_id])).rows[0];
        if (!ch?.enrolment_id) throw unprocessable('This charge is not tied to an enrolment, so there is no access to pause');
        need(i.reason, 'Say why');
        if (i.action === 'suspend') {
          if (!(await policyFor(c, cs.owner_type, cs.owner_id)).suspension_enabled) throw unprocessable('Suspension is not switched on in the collections policy');
          const sid = await suspend(c, { enrolmentId: ch.enrolment_id, orgId: ch.organisation_id, caseId: cs.id, reason: i.reason, actor: user.id });
          if (!sid) throw conflict('Access is already paused');
          await addEvent(c, cs.id, 'suspended', { actor: user.id, data: { suspension_id: sid, automatic: false }, note: i.reason, dedupe: `suspended:${sid}` });
        } else {
          const l = await lift(c, ch.enrolment_id, { reason: i.reason, actor: user.id });
          if (!l) throw conflict('Access is not paused');
          const until = within(i.until ?? new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10), 90, 'The hold after reinstating');
          await c.query('UPDATE collection_cases SET hold_until=$2 WHERE id=$1', [cs.id, until]);
          await addEvent(c, cs.id, 'reinstated', { actor: user.id, data: { automatic: false, hold_until: until }, note: i.reason, dedupe: `reinstated:${l.id}` });
          for (const uid of await payersToTell(c, { enrolment_id: ch.enrolment_id, payer_id: cs.payer_id })) await notify(c, uid, { kind: 'collections_access_restored', title: 'Access restored', body: 'Open Gotmygame to see the details.', data: { organisation_id: ch.organisation_id }, dedupe_key: `coll:reinstated:${l.id}:${uid}` });
        }
        break;
      }
    }
    await audit(c, user.id, `collection_${i.action}`, 'collection_cases', cs.id);
    return { id: cs.id, action: i.action, ...data };
  }),
});

// ---------------------------------------------------------------------------------------------------- waivers, concessions, plans
cap({
  name: 'adjust_academy_charge', method: 'POST', path: '/academy-charges/:id/adjustments', tag: 'Academy',
  summary: 'Waive or reduce what is still owed on an unpaid academy / club charge (owner/admin/finance). A waiver forgives it; a concession is a goodwill reduction. It is an explicit, attributed adjustment against the charge - the price and the numbered invoice are not edited - and the balance (amount - received - adjustments) always reconciles. When the balance reaches zero the charge becomes waived (nothing was paid) or paid (it was part paid). The reason is internal and encrypted. A retry with the same key adds nothing.',
  input: z.object({ id, kind: z.enum(['waiver', 'concession']), amount_minor: z.number().int().min(1), reason, idempotency_key: z.string().min(8).max(80) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ch = (await c.query('SELECT organisation_id FROM academy_charges WHERE id=$1', [i.id])).rows[0];
    if (!ch) throw notFound('Charge');
    await orgFor(user, ch.organisation_id, STAFF_MONEY, { write: true, c });
    const r = await applyAdjustment(c, i.id, { kind: i.kind, amountMinor: i.amount_minor, reasonEnc: sealReason(i.reason), actor: user.id, key: i.idempotency_key });
    const cs = (await c.query("SELECT id FROM collection_cases WHERE source_type='academy_charge' AND source_id=$1", [i.id])).rows[0];
    if (cs && !r.replay) await addEvent(c, cs.id, i.kind, { actor: user.id, data: { amount_minor: i.amount_minor, balance_minor: r.balance_minor }, note: i.reason, dedupe: `adj:${r.adjustment_id}` });
    await audit(c, user.id, 'adjust_academy_charge', 'academy_charges', i.id);
    return r;
  }),
});

const instalment = z.object({ due_on: day, amount_minor: z.number().int().min(1) });
cap({
  name: 'approve_payment_plan', method: 'POST', path: '/academy-charges/:id/payment-plan', tag: TAG, status: 201,
  summary: 'Approve a payment plan for an overdue or unpaid charge (owner/admin/finance): 2-12 dated instalments that add up to exactly the balance. The charge and its invoice are unchanged; reminders then follow the next instalment instead of the original due date, and a missed instalment (beyond the grace days) breaks the plan and returns the case to the original due date. One active plan per charge.',
  input: z.object({ id, instalments: z.array(instalment).min(2).max(12), note: z.string().trim().max(500).optional(), idempotency_key: z.string().min(8).max(80) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ch = (await c.query('SELECT * FROM academy_charges WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!ch) throw notFound('Charge');
    await orgFor(user, ch.organisation_id, STAFF_MONEY, { write: true, c });
    const prior = (await c.query('SELECT id, status, instalments, balance_minor FROM payment_plans WHERE charge_id=$1 AND idempotency_key=$2', [ch.id, i.idempotency_key])).rows[0];
    if (prior) return { ...prior, replay: true };
    if (ch.status !== 'awaiting_payment') throw conflict('Only an unpaid charge can have a payment plan');
    const balance = Number(ch.amount_minor) - Number(ch.settled_minor) - Number(ch.adjusted_minor);
    const list = [...i.instalments].sort((a, b) => a.due_on.localeCompare(b.due_on));
    const today = todayStr();
    if (list[0].due_on < today) throw unprocessable('The first instalment cannot be in the past');
    if (daysBetween(today, list.at(-1).due_on) > 366) throw unprocessable('A payment plan can run for at most a year');
    if (new Set(list.map((x) => x.due_on)).size !== list.length) throw unprocessable('Each instalment needs its own date');
    const total = list.reduce((t, x) => t + x.amount_minor, 0);
    if (total !== balance) throw unprocessable(`The instalments add up to ${total} but ${balance} is still owed. They must add up exactly.`, { balance_minor: balance, instalments_minor: total });
    if ((await c.query("SELECT 1 FROM payment_plans WHERE charge_id=$1 AND status='active'", [ch.id])).rowCount) throw conflict('This charge already has an active payment plan. Cancel it first.');
    const plan = (await c.query(
      'INSERT INTO payment_plans(charge_id, instalments, balance_minor, settled_at_approval, note_enc, approved_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status, instalments, balance_minor',
      [ch.id, JSON.stringify(list), balance, Number(ch.settled_minor) + Number(ch.adjusted_minor), encrypt(i.note ?? null, 'payment_plans.note'), user.id, i.idempotency_key])).rows[0];
    await planEvent(c, ch.id, user.id, 'plan_approved', { plan_id: plan.id, instalments: list.length, balance_minor: balance });
    for (const uid of await payersToTell(c, { ...ch, athlete_id: null })) await notify(c, uid, { kind: 'collections_plan', title: 'A payment plan was agreed', body: 'Open Gotmygame to see the dates.', data: { organisation_id: ch.organisation_id, charge_id: ch.id }, dedupe_key: `coll:plan:${plan.id}:${uid}` });
    await audit(c, user.id, 'approve_payment_plan', 'academy_charges', ch.id);
    return { ...plan, replay: false };
  }),
});
async function planEvent(c, chargeId, actor, kind, data) {
  const cs = (await c.query("SELECT id FROM collection_cases WHERE source_type='academy_charge' AND source_id=$1", [chargeId])).rows[0];
  if (cs) await addEvent(c, cs.id, kind, { actor, data, dedupe: `${kind}:${data.plan_id}` });
}

cap({
  name: 'cancel_payment_plan', method: 'POST', path: '/payment-plans/:id/cancel', tag: TAG,
  summary: 'Cancel an active payment plan (owner/admin/finance). The charge goes back to its original due date; nothing already received is touched.',
  input: z.object({ id, reason }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT p.*, ch.organisation_id FROM payment_plans p JOIN academy_charges ch ON ch.id=p.charge_id WHERE p.id=$1 FOR UPDATE OF p', [i.id])).rows[0];
    if (!p) throw notFound('Payment plan');
    await orgFor(user, p.organisation_id, STAFF_MONEY, { write: true, c });
    if (p.status !== 'active') throw conflict('This plan is not active');
    await c.query("UPDATE payment_plans SET status='cancelled' WHERE id=$1", [p.id]);
    await planEvent(c, p.charge_id, user.id, 'plan_cancelled', { plan_id: p.id });
    await audit(c, user.id, 'cancel_payment_plan', 'payment_plans', p.id);
    return { id: p.id, status: 'cancelled' };
  }),
});

// ---------------------------------------------------------------------------------------------------- billing schedules
/** Who may be billed for an athlete: an adult athlete themself; for a young person only a currently verified guardian (or the payer already billing that enrolment). */
async function chooseBiller(c, athleteId, payerId) {
  if (!(await isYouth(athleteId, c))) {
    if (payerId && payerId !== athleteId) throw unprocessable('An adult is billed directly. Leave the payer empty.');
    return athleteId;
  }
  const guardians = await guardiansOf(athleteId, c);
  if (payerId) { if (!(await guardianLink(payerId, athleteId, c))) throw unprocessable('The payer must be a currently verified guardian of this young person'); return payerId; }
  if (guardians.length === 1) return guardians[0];
  throw unprocessable(guardians.length ? 'Choose which guardian is billed' : 'This young person has no verified guardian to bill. Link a guardian first.', { guardians });
}

cap({
  name: 'create_billing_schedule', method: 'POST', path: '/billing-schedules', tag: TAG, status: 201,
  summary: 'Set up a recurring fee on an enrolment (academy programme or club / team cohort), owner/admin/finance: monthly, term, season or custom dates. The amount, tax and every future due date are frozen now; each period raises exactly one charge (and one numbered invoice) a few days before it is due, however many times the worker runs. A young person is billed to a verified guardian, never to the child. Optionally reference a provider mandate: it is stored as a permission to collect, separate from invoice and payment state, and until a provider adapter can execute it the invoice is simply raised and payment requested. An enrolment whose programme already renews through a subscription plan is refused so nothing is billed twice.',
  input: z.object({ organisation_id: id, enrolment_id: id, payer_id: id.optional(), kind: z.enum(['monthly', 'term', 'season', 'custom']), label: z.string().trim().min(2).max(80), currency: cur, amount_minor: z.number().int().min(1).max(100_000_000_00),
    tax_rate_bp: z.number().int().min(0).max(5000).default(0), first_due_on: day.optional(), periods: z.number().int().min(1).max(60).optional(), every_months: z.number().int().min(1).max(12).optional(), due_dates: z.array(day).min(1).max(60).optional(),
    raise_days_before: z.number().int().min(0).max(60).default(7), mandate_ref: z.string().trim().min(8).max(80).optional(), idempotency_key: z.string().min(8).max(80) }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.organisation_id, STAFF_MONEY, { write: true, c });
    const prior = (await c.query('SELECT * FROM billing_schedules WHERE created_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
    if (prior) return { ...scheduleView(prior), replay: true };
    const e = (await c.query('SELECT e.*, k.organisation_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1 FOR UPDATE OF e', [i.enrolment_id])).rows[0];
    if (!e || e.organisation_id !== i.organisation_id) throw notFound('Enrolment');
    if (!['enrolled', 'paused'].includes(e.status)) throw conflict('Only a current enrolment can be billed');
    if (e.programme_id) {
      const v = (await c.query('SELECT currency FROM academy_programme_versions WHERE id=$1', [e.version_id])).rows[0];
      if (v && v.currency !== i.currency) throw unprocessable(`This programme is priced in ${v.currency}`);
    }
    if ((await c.query("SELECT 1 FROM user_plans WHERE enrolment_id=$1 AND auto_renew AND status IN ('active','awaiting_payment') LIMIT 1", [e.id])).rowCount) throw conflict('This enrolment already renews through a subscription plan, which raises its own charges. A schedule would bill it twice.');
    if ((await c.query("SELECT 1 FROM billing_schedules WHERE enrolment_id=$1 AND status IN ('active','paused')", [e.id])).rowCount) throw conflict('This enrolment already has a recurring schedule. End or change that one instead.');
    if (!i.due_dates?.length && (!i.first_due_on || !i.periods)) throw badRequest('Give the due dates, or the first due date and how many periods');
    const dates = buildDueDates(i);
    const today = todayStr();
    if (dates[0] < today) throw unprocessable('Due dates must be today or later');
    const payer = await chooseBiller(c, e.user_id, i.payer_id);
    const tax = { rate_bp: i.tax_rate_bp };
    const s = (await c.query(
      `INSERT INTO billing_schedules(organisation_id, enrolment_id, payer_id, label, kind, currency, amount_minor, tax_rate_bp, due_dates, raise_days_before, mandate_ref, mandate_status, terms, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [i.organisation_id, e.id, payer, i.label, i.kind, i.currency, i.amount_minor, i.tax_rate_bp, dates, i.raise_days_before, i.mandate_ref ?? null, i.mandate_ref ? 'pending' : 'none', JSON.stringify({ ...tax, frozen_at: new Date().toISOString() }), i.idempotency_key, user.id])).rows[0];
    const raised = await raiseForSchedule(c, s.id, { today });
    await audit(c, user.id, 'create_billing_schedule', 'billing_schedules', s.id);
    return { ...scheduleView(s), raised_now: raised, replay: false };
  }),
});
const scheduleView = ({ mandate_ref, due_dates, due_texts, terms, idempotency_key, created_by, ...s }) => ({ ...s, due_dates: due_texts ?? due_dates.map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d)), has_mandate: !!mandate_ref, terms });

cap({
  name: 'list_billing_schedules', method: 'GET', path: '/billing-schedules', tag: TAG,
  summary: 'Recurring fee schedules of an organisation (owner/admin/finance): the frozen amount and due dates, how many periods have been raised, the athlete and payer, and the mandate state (none / pending / active / failed / revoked), which is a permission to collect and not a payment.',
  input: z.object({ organisation_id: id, enrolment_id: id.optional(), status: z.enum(['active', 'paused', 'ended']).optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, STAFF_MONEY);
    return many(
      `SELECT s.id, s.enrolment_id, s.label, s.kind, s.status, s.currency, s.amount_minor, s.tax_rate_bp, s.due_dates::text[] AS due_dates, s.raise_days_before, s.mandate_status, (s.mandate_ref IS NOT NULL) AS has_mandate, s.created_at, s.ended_at, s.ended_reason,
              (SELECT count(*)::int FROM billing_schedule_periods p WHERE p.schedule_id=s.id) AS periods_raised, au.display_name AS athlete_name, pu.display_name AS payer_name
         FROM billing_schedules s JOIN org_enrolments e ON e.id=s.enrolment_id JOIN users au ON au.id=e.user_id JOIN users pu ON pu.id=s.payer_id
        WHERE s.organisation_id=$1 AND ($2::uuid IS NULL OR s.enrolment_id=$2) AND ($3::text IS NULL OR s.status=$3) ORDER BY s.created_at DESC, s.id LIMIT $4 OFFSET $5`, [i.organisation_id, i.enrolment_id ?? null, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'update_billing_schedule', method: 'PATCH', path: '/billing-schedules/:id', tag: TAG,
  summary: 'Pause, resume or end a recurring schedule, or link / unlink a provider mandate reference (owner/admin/finance). Nothing is deleted: periods already raised keep their charges and invoices, an ended schedule simply raises no more. The mandate state itself is reported by the payment provider, never set by hand.',
  input: z.object({ id, action: z.enum(['pause', 'resume', 'end', 'link_mandate', 'unlink_mandate']), reason: reason.optional(), mandate_ref: z.string().trim().min(8).max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = (await c.query('SELECT * FROM billing_schedules WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!s) throw notFound('Schedule');
    await orgFor(user, s.organisation_id, STAFF_MONEY, { write: true, c });
    if (s.status === 'ended') throw conflict('This schedule has ended');
    let r;
    switch (i.action) {
      case 'pause': r = await c.query("UPDATE billing_schedules SET status='paused' WHERE id=$1 AND status='active' RETURNING *", [s.id]); break;
      case 'resume': r = await c.query("UPDATE billing_schedules SET status='active' WHERE id=$1 AND status='paused' RETURNING *", [s.id]); break;
      case 'end': if (!i.reason) throw badRequest('Say why it ends'); r = await c.query("UPDATE billing_schedules SET status='ended', ended_at=now(), ended_reason=$2 WHERE id=$1 RETURNING *", [s.id, i.reason]); break;
      case 'link_mandate': if (!i.mandate_ref) throw badRequest('Give the mandate reference'); r = await c.query("UPDATE billing_schedules SET mandate_ref=$2, mandate_status='pending' WHERE id=$1 RETURNING *", [s.id, i.mandate_ref]); break;
      case 'unlink_mandate': r = await c.query("UPDATE billing_schedules SET mandate_ref=NULL, mandate_status='none' WHERE id=$1 RETURNING *", [s.id]); break;
    }
    if (!r.rowCount) throw conflict(`The schedule is ${s.status}, so it cannot be ${i.action === 'pause' ? 'paused' : 'resumed'}`);
    await audit(c, user.id, `${i.action}_billing_schedule`, 'billing_schedules', s.id);
    return scheduleView({ ...r.rows[0], due_texts: (await c.query('SELECT due_dates::text[] AS d FROM billing_schedules WHERE id=$1', [s.id])).rows[0].d });
  }),
});

// ---------------------------------------------------------------------------------------------------- reporting
cap({
  name: 'get_collections_report', method: 'GET', path: '/collections/report', tag: TAG,
  summary: 'Collections report for an organisation (owner/admin/finance): per currency (never summed across currencies) billed, collected, waived and conceded, outstanding and overdue, ageing buckets, recovered amount and recovery time, payment and auto-debit failure rates, and a forecast of what falls due in 30 / 60 / 90 days. `reconciles` is true only when charge totals equal their receipts and adjustments, online receipts equal paid payments, and every paid charge has a paid invoice.',
  input: z.object({ organisation_id: id, from: day.optional(), to: day.optional(), as_of: day.optional().describe('the date outstanding, ageing and forecast are measured from (default today)') }),
  async handler({ user }, i) {
    await orgFor(user, i.organisation_id, STAFF_MONEY);
    await audit(null, user.id, 'read_collections_report', 'organisations', i.organisation_id);
    const to = i.to ?? todayStr();
    return collectionsReport(i.organisation_id, { from: i.from ?? new Date(Date.parse(to) - 90 * 864e5).toISOString().slice(0, 10), to, today: i.as_of ?? todayStr() });
  },
});
