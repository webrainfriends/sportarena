// Recurring collections & dunning. The business workflow around money that is owed repeatedly (academy fees, club dues, memberships).
// It owns no money: what is owed lives in academy_charges (and user_plans for venue memberships), the document in invoices, cash in payments,
// and a part payment / waiver is a row against the charge (academy-invoices.js). This module raises one charge per billing period, follows every
// unpaid charge through a dunning lifecycle, and reports on it. Every step is idempotent: unique keys decide, so a retry or a concurrent run adds nothing.
import { many, one, tx } from './db.js';
import { notify } from './notify.js';
import { encrypt, decrypt } from './crypto.js';
import { guardiansOf, guardianLink, isYouth } from './youth.js';
import { addMonths } from './sponsor-schedule.js';
import { insertCharges } from './academy.js';
import { syncChargeInvoice } from './academy-invoices.js';
import { ageing } from './academy-finance.js';

export const STATES = ['upcoming', 'due', 'attempted', 'paid', 'failed', 'retrying', 'overdue', 'escalated', 'resolved', 'waived', 'cancelled'];
export const OPEN_STATES = ['upcoming', 'due', 'attempted', 'failed', 'retrying', 'overdue', 'escalated'];
export const CLOSED_STATES = ['paid', 'resolved', 'waived', 'cancelled'];

/** What an organisation or venue gets until it chooses otherwise. Late fees and suspension are off: they are decisions, not defaults. */
export const DEFAULT_POLICY = {
  reminder_offsets: [-3, 0, 3, 7, 14], grace_days: 3, retry_days: [1, 3, 5], escalate_after_days: 21,
  late_fee_enabled: false, late_fee_minor: 0, late_fee_currency: null, late_fee_after_days: 7, late_fee_basis: null,
  suspension_enabled: false, suspend_after_days: 30,
};
export async function policyFor(c, ownerType, ownerId) {
  const r = (await c.query('SELECT * FROM collection_policies WHERE owner_type=$1 AND owner_id=$2', [ownerType, ownerId])).rows[0];
  return r ? { ...DEFAULT_POLICY, ...r, customised: true } : { ...DEFAULT_POLICY, customised: false };
}

const dayNo = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 864e5); };
export const daysBetween = (from, to) => dayNo(to) - dayNo(from);
export const todayStr = () => new Date().toISOString().slice(0, 10);

const sealNote = (t) => encrypt(t, 'collection_events.note');
export const openNote = (s) => (s ? decrypt(s, 'collection_events.note') : null);
export const sealReason = (t) => encrypt(t, 'charge_adjustments.reason');
export const openReason = (s) => (s ? decrypt(s, 'charge_adjustments.reason') : null);

/** Append a fact to the case history. `dedupe` makes it happen at most once; returns true only for the call that wrote it. */
export async function addEvent(c, caseId, kind, { actor = null, data = {}, note = null, dedupe = null } = {}) {
  const r = await c.query(
    'INSERT INTO collection_events(case_id, kind, actor_id, data, note_enc, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (case_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id',
    [caseId, kind, actor, JSON.stringify(data), note ? sealNote(note) : null, dedupe]);
  return r.rowCount > 0;
}

// ---------------------------------------------------------------------------------------------------------------- who is told
/**
 * Who a payment message goes to: the payer on the charge. A young person is never messaged directly - when the charge belongs to a young athlete,
 * the payer must still be a currently verified guardian, otherwise the athlete's current guardians are told instead (the live relationship decides).
 */
export async function payersToTell(c, ch) {
  const athlete = ch.athlete_id ?? (ch.enrolment_id ? (await c.query('SELECT user_id FROM org_enrolments WHERE id=$1', [ch.enrolment_id])).rows[0]?.user_id : ch.application_id ? (await c.query('SELECT athlete_id FROM academy_applications WHERE id=$1', [ch.application_id])).rows[0]?.athlete_id : null);
  if (!athlete || !(await isYouth(athlete, c))) return [ch.payer_id];
  if (ch.payer_id !== athlete && (await guardianLink(ch.payer_id, athlete, c))) return [ch.payer_id];
  return guardiansOf(athlete, c);
}

/** Money staff of an organisation: owner, admin and finance members. */
export const moneyStaff = async (c, orgId) => (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin','finance') ORDER BY user_id", [orgId])).rows.map((r) => r.user_id);

// ---------------------------------------------------------------------------------------------------------------- cases
/**
 * Open a case for every unpaid charge / membership renewal of an owner that has none. Set-based and idempotent (unique source).
 * Venue renewals only: the first purchase of a plan is a checkout, not a recurring collection.
 */
export async function ensureCases(c, ownerType, ownerId) {
  if (ownerType === 'organisation') {
    const r = await c.query(
      `INSERT INTO collection_cases(owner_type, owner_id, source_type, source_id, payer_id, currency, due_on, state)
       SELECT 'organisation', ch.organisation_id, 'academy_charge', ch.id, ch.payer_id, ch.currency, ch.due_on,
              CASE WHEN ch.due_on > current_date THEN 'upcoming' WHEN ch.due_on + 3 >= current_date THEN 'due' ELSE 'overdue' END
         FROM academy_charges ch WHERE ch.organisation_id=$1 AND ch.status='awaiting_payment' AND ch.amount_minor > 0
       ON CONFLICT (source_type, source_id) DO NOTHING`, [ownerId]);
    return r.rowCount;
  }
  if (ownerType === 'team') {
    // a team charge with a due date; late fees and suspension do not apply to teams, reminders, retries and escalation do
    const r = await c.query(
      `INSERT INTO collection_cases(owner_type, owner_id, source_type, source_id, payer_id, currency, due_on, state)
       SELECT 'team', ch.team_id, 'team_charge', ch.id, ch.payer_id, b.currency, ch.due_on,
              CASE WHEN ch.due_on > current_date THEN 'upcoming' WHEN ch.due_on + 3 >= current_date THEN 'due' ELSE 'overdue' END
         FROM team_charges ch JOIN team_charge_batches b ON b.id=ch.batch_id
        WHERE ch.team_id=$1 AND ch.status='awaiting_payment' AND ch.due_on IS NOT NULL AND ch.amount_minor - ch.adjusted_minor - ch.settled_minor > 0
       ON CONFLICT (source_type, source_id) DO NOTHING`, [ownerId]);
    return r.rowCount;
  }
  const r = await c.query(
    `INSERT INTO collection_cases(owner_type, owner_id, source_type, source_id, payer_id, currency, due_on, state)
     SELECT 'venue', up.venue_id, 'venue_plan', up.id, up.user_id, up.currency, prev.expires_at::date,
            CASE WHEN prev.expires_at::date > current_date THEN 'upcoming' WHEN prev.expires_at::date + 3 >= current_date THEN 'due' ELSE 'overdue' END
       FROM user_plans up JOIN user_plans prev ON prev.id=up.renews_id
      WHERE up.venue_id=$1 AND up.status='awaiting_payment' AND up.renews_id IS NOT NULL
     ON CONFLICT (source_type, source_id) DO NOTHING`, [ownerId]);
  return r.rowCount;
}

async function facts(c, cs) {
  if (cs.source_type === 'academy_charge') {
    const ch = (await c.query(
      `SELECT ch.*, ch.due_on::text AS due_s, ch.amount_minor - ch.settled_minor - ch.adjusted_minor AS balance_minor, coalesce(e.user_id, a.athlete_id) AS athlete_id
         FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id WHERE ch.id=$1 FOR UPDATE OF ch`, [cs.source_id])).rows[0];
    if (!ch) return null;
    const closed = { paid: 'paid', refunded: 'paid', waived: 'waived', cancelled: 'cancelled' }[ch.status] ?? null;
    return { ch, closed, balance: Number(ch.balance_minor), billed: Number(ch.amount_minor), dueOn: ch.due_s, enrolmentId: ch.enrolment_id, orgId: ch.organisation_id, payerId: ch.payer_id };
  }
  if (cs.source_type === 'team_charge') {
    const tc = (await c.query(
      `SELECT ch.*, ch.due_on::text AS due_s, ch.amount_minor - ch.settled_minor - ch.adjusted_minor AS balance_minor, t.name AS team_name, b.title
         FROM team_charges ch JOIN teams t ON t.id=ch.team_id JOIN team_charge_batches b ON b.id=ch.batch_id WHERE ch.id=$1 FOR UPDATE OF ch`, [cs.source_id])).rows[0];
    if (!tc) return null;
    const closed = { paid: 'paid', waived: 'waived', cancelled: 'cancelled' }[tc.status] ?? null;
    return { ch: null, tc, closed, balance: Number(tc.balance_minor), billed: Number(tc.amount_minor), dueOn: tc.due_s, enrolmentId: null, orgId: null, payerId: tc.payer_id };
  }
  const up = (await c.query(
    `SELECT up.*, prev.expires_at::date::text AS due_s FROM user_plans up LEFT JOIN user_plans prev ON prev.id=up.renews_id WHERE up.id=$1 FOR UPDATE OF up`, [cs.source_id])).rows[0];
  if (!up) return null;
  const closed = up.status === 'awaiting_payment' ? null : ['active', 'used_up', 'expired'].includes(up.status) ? 'paid' : 'cancelled';
  return { ch: null, up, closed, balance: closed ? 0 : Number(up.price_cents), billed: Number(up.price_cents), dueOn: up.due_s ?? String(cs.due_on).slice(0, 10), enrolmentId: null, orgId: null, payerId: up.user_id };
}

/** The instalment that is next to be paid under an approved plan (or null). Breaks the plan when an instalment is missed beyond the grace days. */
async function planDue(c, f, policy, today, cs) {
  if (!f.ch) return null;
  const plan = (await c.query("SELECT * FROM payment_plans WHERE charge_id=$1 AND status='active'", [f.ch.id])).rows[0];
  if (!plan) return null;
  if (f.balance === 0) { await c.query("UPDATE payment_plans SET status='completed' WHERE id=$1", [plan.id]); return null; }
  let paid = Number(f.ch.settled_minor) + Number(f.ch.adjusted_minor) - Number(plan.settled_at_approval);
  const list = plan.instalments;
  let next = null;
  for (const it of list) { if (paid >= Number(it.amount_minor)) paid -= Number(it.amount_minor); else { next = it; break; } }
  if (!next) return null;
  if (daysBetween(next.due_on, today) > policy.grace_days) {
    await c.query("UPDATE payment_plans SET status='broken' WHERE id=$1", [plan.id]);
    await addEvent(c, cs.id, 'plan_broken', { data: { plan_id: plan.id, missed_on: next.due_on }, dedupe: `plan_broken:${plan.id}` });
    return null;
  }
  return next.due_on;
}

/** Read the payments made for this source and write each attempt into the case history exactly once. Returns the number of payments still in flight. */
async function syncAttempts(c, cs, today) {
  const type = cs.source_type === 'academy_charge' ? 'academy_charge' : cs.source_type === 'team_charge' ? 'team_charge' : 'venue_plan';
  const pays = (await c.query('SELECT id, status, created_at, paid_at FROM payments WHERE purpose_type=$1 AND purpose_id=$2 ORDER BY created_at, id', [type, cs.source_id])).rows;
  let inflight = 0, attempts = 0, failed = 0, lastAt = null;
  for (const p of pays) {
    if (p.status === 'pending') {
      if (Date.now() - new Date(p.created_at).getTime() < 24 * 3600e3) inflight++;
      if (await addEvent(c, cs.id, 'attempt_started', { data: { payment_id: p.id }, dedupe: `pay:${p.id}:started` })) { attempts++; lastAt = p.created_at; }
    } else if (p.status === 'failed') {
      await addEvent(c, cs.id, 'attempt_started', { data: { payment_id: p.id }, dedupe: `pay:${p.id}:started` }) && attempts++;
      if (await addEvent(c, cs.id, 'attempt_failed', { data: { payment_id: p.id }, dedupe: `pay:${p.id}:failed` })) { failed++; lastAt = new Date(); }
    } else if (p.status === 'paid' || p.status === 'refunded') {
      if (await addEvent(c, cs.id, 'attempt_started', { data: { payment_id: p.id }, dedupe: `pay:${p.id}:started` })) attempts++;
      await addEvent(c, cs.id, 'payment_received', { data: { payment_id: p.id }, dedupe: `pay:${p.id}:paid` });
    }
  }
  if (attempts || failed) await c.query('UPDATE collection_cases SET attempts=attempts+$2, failed_attempts=failed_attempts+$3, last_attempt_at=coalesce($4, last_attempt_at), had_trouble = had_trouble OR $3 > 0 WHERE id=$1', [cs.id, attempts, failed, lastAt]);
  return inflight;
}

// ---------------------------------------------------------------------------------------------------------------- mandates
// A mandate (issue #498) is a provider permission to collect, not a payment. Execution is pluggable: until a provider adapter registers an executor,
// nothing pretends to auto-debit - the invoice stays unpaid and the payer is asked to pay.
const executors = new Map();
export const registerMandateExecutor = (provider, fn) => (fn ? executors.set(provider, fn) : executors.delete(provider));
const executorFor = () => executors.values().next().value ?? null;

async function autoDebit(c, cs, f, policy, today) {
  if (!f.ch) return;
  const s = (await c.query('SELECT s.* FROM billing_schedule_periods p JOIN billing_schedules s ON s.id=p.schedule_id WHERE p.charge_id=$1', [f.ch.id])).rows[0];
  if (!s || !s.mandate_ref || s.mandate_status !== 'active') return;
  const past = (await c.query("SELECT count(*)::int AS n, max(created_at) AS last FROM collection_events WHERE case_id=$1 AND kind IN ('auto_debit_started','auto_debit_failed')", [cs.id])).rows[0];
  const k = past.n;
  if (k > policy.retry_days.length) return;
  if (k > 0 && daysBetween(new Date(past.last).toISOString().slice(0, 10), today) < policy.retry_days[k - 1]) return;
  const run = executorFor();
  if (!run) { await addEvent(c, cs.id, 'auto_debit_unavailable', { data: { reason: 'no provider adapter is connected' }, dedupe: 'ad_unavailable' }); return; }
  let res;
  try { res = await run({ mandateRef: s.mandate_ref, chargeId: f.ch.id, amountMinor: f.balance, currency: f.ch.currency, idempotencyKey: `case:${cs.id}:attempt:${k}` }); } catch (e) { res = { ok: false, reason: String(e.message).slice(0, 160) }; }
  if (res?.ok) {
    await addEvent(c, cs.id, 'auto_debit_started', { data: { provider_ref: res.ref ?? null }, dedupe: `ad:${k}` });
    await c.query('UPDATE collection_cases SET attempts=attempts+1, last_attempt_at=now() WHERE id=$1', [cs.id]);
  } else {
    await addEvent(c, cs.id, 'auto_debit_failed', { data: { reason: res?.reason ?? 'declined' }, dedupe: `ad:${k}` });
    await c.query('UPDATE collection_cases SET attempts=attempts+1, failed_attempts=failed_attempts+1, last_attempt_at=now(), had_trouble=true WHERE id=$1', [cs.id]);
    if (res?.mandateInvalid) await c.query("UPDATE billing_schedules SET mandate_status='failed' WHERE id=$1", [s.id]);
  }
}

// ---------------------------------------------------------------------------------------------------------------- suspension
/** Is this enrolment's access paused for non-payment? Read by check-in and by the access pass list. */
export const isSuspended = async (c, enrolmentId) => !!enrolmentId && (await c.query("SELECT 1 FROM entitlement_suspensions WHERE enrolment_id=$1 AND status='active'", [enrolmentId])).rowCount > 0;
export const SUSPENDED_SQL = (alias = 'e') => `EXISTS (SELECT 1 FROM entitlement_suspensions xs WHERE xs.enrolment_id=${alias}.id AND xs.status='active')`;

export async function suspend(c, { enrolmentId, orgId, caseId = null, reason, actor = null }) {
  const r = await c.query(
    "INSERT INTO entitlement_suspensions(enrolment_id, organisation_id, case_id, reason, started_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (enrolment_id) WHERE status='active' DO NOTHING RETURNING id", [enrolmentId, orgId, caseId, reason, actor]);
  return r.rows[0]?.id ?? null;
}
export async function lift(c, enrolmentId, { reason, actor = null }) {
  const r = await c.query("UPDATE entitlement_suspensions SET status='lifted', lifted_at=now(), lifted_by=$2, lift_reason=$3 WHERE enrolment_id=$1 AND status='active' RETURNING id, case_id", [enrolmentId, actor, reason]);
  return r.rows[0] ?? null;
}
/** Access comes back on its own once nothing on the enrolment is past the suspension threshold any more (paid, waived or cancelled). */
async function reinstateIfClear(c, enrolmentId, orgId, policy, today) {
  if (!enrolmentId) return;
  const still = (await c.query(
    "SELECT 1 FROM academy_charges ch WHERE ch.enrolment_id=$1 AND ch.status='awaiting_payment' AND ch.amount_minor - ch.settled_minor - ch.adjusted_minor > 0 AND ch.due_on <= $2::date - $3::int LIMIT 1", [enrolmentId, today, policy.suspend_after_days])).rowCount;
  if (still) return;
  const l = await lift(c, enrolmentId, { reason: 'No payment is overdue any more' });
  if (l) {
    const e = (await c.query('SELECT k.organisation_id, e.user_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1', [enrolmentId])).rows[0];
    const ch = { enrolment_id: enrolmentId, payer_id: null, athlete_id: e?.user_id };
    const cs = l.case_id ? (await c.query('SELECT payer_id FROM collection_cases WHERE id=$1', [l.case_id])).rows[0] : null;
    for (const uid of await payersToTell(c, { ...ch, payer_id: cs?.payer_id ?? e?.user_id })) {
      await notify(c, uid, { kind: 'collections_access_restored', title: 'Access restored', body: 'Open Gotmygame to see the details.', data: { organisation_id: orgId }, dedupe_key: `coll:reinstated:${l.id}:${uid}` });
    }
    if (l.case_id) await addEvent(c, l.case_id, 'reinstated', { data: { automatic: true }, dedupe: `reinstated:${l.id}` });
  }
}

// ---------------------------------------------------------------------------------------------------------------- lifecycle
/** Who to tell about this case, and what a tapped notification opens. A team charge is told to its payer; a young member's is told to their guardians, never the child. */
const tellWho = (f) => (f.tc ? { payer_id: f.tc.payer_id, athlete_id: f.tc.member_id } : { ...(f.ch ?? { payer_id: f.payerId }), athlete_id: f.ch?.athlete_id });
const dataOf = (cs, f) => (f.tc ? { team_id: cs.owner_id, charge_id: f.tc.id } : f.ch ? { organisation_id: f.orgId, charge_id: f.ch.id } : { venue_id: cs.owner_id, user_plan_id: cs.source_id });
const BODY = (f, text) => (f.tc ? `${f.tc.team_name}: ${f.tc.title}. ${text}` : text);
/** The people who run a team's money: its owner and managers / captains. */
const teamStaff = async (c, teamId) => (await c.query(
  `SELECT owner_id AS user_id FROM teams WHERE id=$1 UNION SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND role IN ('captain','manager')`, [teamId])).rows.map((r) => r.user_id);
const TITLE = (offset) => (offset < 0 ? 'A payment is coming up' : offset === 0 ? 'A payment is due' : 'A payment is overdue');

async function lateFee(c, cs, f, policy, today) {
  if (!f.ch || f.ch.kind === 'late_fee' || !policy.late_fee_enabled || Number(policy.late_fee_minor) <= 0 || f.ch.currency !== policy.late_fee_currency) return;   // a fee in one currency is never added to a charge in another
  if (daysBetween(f.dueOn, today) < policy.late_fee_after_days) return;
  const seq = f.ch.enrolment_id ? (await c.query('SELECT coalesce(max(seq), -1) + 1 AS n FROM academy_charges WHERE enrolment_id=$1', [f.ch.enrolment_id])).rows[0].n : 0;
  const made = await c.query(
    `INSERT INTO academy_charges(enrolment_id, application_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, amount_minor, terms, status, parent_charge_id)
     VALUES ($1,$2,$3,$4,$5,'late_fee',$6,$7,$8,$8,$9,'awaiting_payment',$10) ON CONFLICT (parent_charge_id) WHERE kind = 'late_fee' DO NOTHING RETURNING id`,
    [f.ch.enrolment_id, f.ch.enrolment_id ? null : f.ch.application_id, f.ch.organisation_id, f.ch.payer_id, seq, today, f.ch.currency, Number(policy.late_fee_minor), JSON.stringify({ basis: policy.late_fee_basis, late_charge_id: f.ch.id }), f.ch.id]);
  if (!made.rowCount) return;
  await syncChargeInvoice(c, made.rows[0].id);
  await addEvent(c, cs.id, 'late_fee_added', { data: { charge_id: made.rows[0].id, amount_minor: Number(policy.late_fee_minor) }, dedupe: `late_fee:${f.ch.id}` });
}

/** Move one open case forward. Everything it writes is keyed, so running it twice in a row (or on two workers) changes nothing the second time. */
export async function advanceCase(c, caseId, { today = todayStr() } = {}) {
  const cs = (await c.query('SELECT *, due_on::text AS due_s FROM collection_cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
  if (!cs || CLOSED_STATES.includes(cs.state)) return null;
  const f = await facts(c, { ...cs, due_on: cs.due_s });
  if (!f) return null;
  const policy = await policyFor(c, cs.owner_type, cs.owner_id);

  // the canonical record decides whether the case is still open
  if (f.closed) {
    const state = f.closed === 'paid' ? (cs.had_trouble ? 'resolved' : 'paid') : f.closed;
    await c.query('UPDATE collection_cases SET state=$2, closed_at=now(), next_action=NULL, next_action_on=NULL WHERE id=$1', [cs.id, state]);
    await addEvent(c, cs.id, 'state_change', { data: { from: cs.state, to: state, recovered: state === 'resolved' }, dedupe: `closed:${state}` });
    if (cs.owner_type === 'organisation') await reinstateIfClear(c, f.enrolmentId, cs.owner_id, policy, today);
    return state;
  }

  const inflight = await syncAttempts(c, cs, today);
  const fresh = (await c.query('SELECT *, promised_on::text AS promised_s, hold_until::text AS hold_s FROM collection_cases WHERE id=$1', [cs.id])).rows[0];
  const planned = await planDue(c, f, policy, today, cs);
  const dueEff = planned ?? f.dueOn;
  const d = daysBetween(dueEff, today);
  const held = !!fresh.hold_s && fresh.hold_s >= today;
  const promised = !!fresh.promised_s && fresh.promised_s >= today;
  if (fresh.promised_s && !promised && !held) await addEvent(c, cs.id, 'promise_broken', { data: { promised_on: fresh.promised_s }, dedupe: `promise_broken:${fresh.promised_s}` });
  const quiet = held || promised;

  // 1. ask the mandate first (when there is one and an adapter exists), otherwise the payer is asked to pay below
  if (!quiet && d >= 0 && !inflight) await autoDebit(c, cs, f, policy, today);
  const now = (await c.query('SELECT * FROM collection_cases WHERE id=$1', [cs.id])).rows[0];

  // 2. the state follows the facts: money in flight, then how late, then failed payments, then due / upcoming
  const retryDays = policy.retry_days;
  const k = now.failed_attempts;
  const lastFail = now.last_attempt_at ? new Date(now.last_attempt_at).toISOString().slice(0, 10) : null;
  let state;
  if (inflight) state = 'attempted';
  else if (d > policy.escalate_after_days) state = 'escalated';
  else if (d > policy.grace_days) state = 'overdue';
  else if (k > 0 && k <= retryDays.length) {
    state = (await c.query("SELECT 1 FROM collection_events WHERE case_id=$1 AND dedupe_key=$2", [cs.id, `retry:${k}`])).rowCount ? 'retrying' : 'failed';
  } else if (d >= 0) state = 'due';
  else state = 'upcoming';

  // 3. a failed payment is followed by a request to pay again, on the policy's retry days (each once)
  if (!quiet && k > 0 && k <= retryDays.length && lastFail && daysBetween(lastFail, today) >= retryDays[k - 1] && !inflight) {
    if (await addEvent(c, cs.id, 'retry_requested', { data: { attempt: k }, dedupe: `retry:${k}` })) {
      state = 'retrying';
      for (const uid of await payersToTell(c, tellWho(f))) {
        await notify(c, uid, { kind: 'collections_retry', title: 'Your payment did not go through', body: BODY(f, 'Open Gotmygame to try again.'), data: dataOf(cs, f), dedupe_key: `coll:retry:${cs.id}:${k}:${uid}` });
      }
    }
  }

  // 4. one reminder per cadence step, the latest one that has come due (a missed step is not replayed)
  let reached = null;
  if (!quiet && !inflight) {
    const due = policy.reminder_offsets.filter((o) => d >= o).sort((a, b) => b - a)[0];
    if (due !== undefined) {
      const sent = (await c.query("SELECT max((data->>'offset')::int) AS o FROM collection_events WHERE case_id=$1 AND kind='reminder_sent' AND data->>'due_on'=$2", [cs.id, dueEff])).rows[0].o;
      if (sent == null || sent < due) {
        let n = 0;
        for (const uid of await payersToTell(c, tellWho(f))) {
          const made = await notify(c, uid, { kind: 'collections_reminder', title: TITLE(due), body: BODY(f, 'Open Gotmygame to see the details and pay.'), data: dataOf(cs, f), dedupe_key: `coll:rem:${cs.id}:${due}:${dueEff}:${uid}`, ...(f.ch ? { comm: { use_case: due > 0 ? 'fee_overdue' : 'fee_due' } } : {}) });
          if (made) n++;
        }
        if (await addEvent(c, cs.id, 'reminder_sent', { data: { offset: due, due_on: dueEff, recipients: n }, dedupe: `rem:${due}:${dueEff}` })) reached = new Date();
      }
    }
  }

  // 5. consequences, only when nobody has asked for time
  if (!quiet && cs.owner_type === 'organisation') {
    await lateFee(c, cs, f, policy, today);
    if (policy.suspension_enabled && f.enrolmentId && d >= policy.suspend_after_days) {
      const sid = await suspend(c, { enrolmentId: f.enrolmentId, orgId: cs.owner_id, caseId: cs.id, reason: `Payment ${d} days overdue` });
      if (sid && await addEvent(c, cs.id, 'suspended', { data: { suspension_id: sid, automatic: true }, dedupe: `suspended:${sid}` })) {
        for (const uid of await payersToTell(c, { ...f.ch, athlete_id: f.ch.athlete_id })) {
          await notify(c, uid, { kind: 'collections_suspended', title: 'Access is paused until payment is made', body: 'Open Gotmygame to see the details.', data: { organisation_id: cs.owner_id, charge_id: f.ch.id }, dedupe_key: `coll:susp:${sid}:${uid}` });
        }
      }
    }
  }
  if (!held && state === 'escalated' && (cs.owner_type === 'organisation' || cs.owner_type === 'team')) {
    if (await addEvent(c, cs.id, 'escalated', { data: { days_past_due: d }, dedupe: 'escalated' })) {
      for (const uid of await (cs.owner_type === 'team' ? teamStaff(c, cs.owner_id) : moneyStaff(c, cs.owner_id))) {
        await notify(c, uid, { kind: 'collections_escalated', title: 'A payment needs your attention', body: BODY(f, 'Open the collections desk to see what is overdue.'), data: cs.owner_type === 'team' ? { team_id: cs.owner_id, charge_id: f.tc.id, case_id: cs.id } : { organisation_id: cs.owner_id, case_id: cs.id }, dedupe_key: `coll:esc:${cs.id}:${uid}` });
      }
    }
  }

  const trouble = ['overdue', 'escalated', 'failed', 'retrying'].includes(state);
  if (state !== cs.state || reached || (trouble && !cs.had_trouble)) {
    await c.query('UPDATE collection_cases SET state=$2, had_trouble = had_trouble OR $3, last_reminder_at = coalesce($4, last_reminder_at), due_on=$5 WHERE id=$1', [cs.id, state, trouble, reached, f.dueOn]);
    if (state !== cs.state) await addEvent(c, cs.id, 'state_change', { data: { from: cs.state, to: state }, dedupe: `state:${cs.state}>${state}:${dueEff}:${k}` });
  }
  return state;
}

/** Worker step: open cases for what is unpaid, then advance every open case. Bounded per run; the next run carries on. */
export async function runCollections({ today = todayStr(), limit = 300, ownerId = null } = {}) {
  const owners = await many(
    `SELECT t, id FROM (SELECT DISTINCT 'organisation' AS t, organisation_id AS id FROM academy_charges WHERE status='awaiting_payment' AND amount_minor > 0
      UNION SELECT DISTINCT 'venue', venue_id FROM user_plans WHERE status='awaiting_payment' AND renews_id IS NOT NULL AND venue_id IS NOT NULL
      UNION SELECT DISTINCT 'team', team_id FROM team_charges WHERE status='awaiting_payment' AND due_on IS NOT NULL) o WHERE $1::uuid IS NULL OR id=$1`, [ownerId]);
  for (const o of owners) await tx((c) => ensureCases(c, o.t, o.id));
  const open = await many('SELECT id FROM collection_cases WHERE state = ANY($1) AND ($3::uuid IS NULL OR owner_id=$3) ORDER BY due_on, id LIMIT $2', [OPEN_STATES, limit, ownerId]);
  let n = 0;
  for (const cs of open) { await tx((c) => advanceCase(c, cs.id, { today })); n++; }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------- schedules
/** The charge kind a schedule raises: an instalment of a programme, or dues for a club / team cohort. */
const chargeKind = (e) => (e.programme_id ? 'instalment' : 'dues');

export function buildDueDates({ kind, first_due_on, periods, every_months, due_dates }) {
  if (due_dates?.length) return [...new Set(due_dates)].sort();
  const step = every_months ?? { monthly: 1, term: 3, season: 6, custom: 1 }[kind];
  const out = [];
  for (let n = 0; n < periods; n++) out.push(addMonths(first_due_on, n * step));
  return out;
}

/** Raise the charge for every period of one schedule that is due within its raise window and has none yet. One period, one charge, however many runs. */
export async function raiseForSchedule(c, scheduleId, { today = todayStr() } = {}) {
  const s = (await c.query('SELECT *, due_dates::text[] AS due_texts FROM billing_schedules WHERE id=$1 FOR UPDATE SKIP LOCKED', [scheduleId])).rows[0];
  if (!s || s.status !== 'active') return 0;
  const e = (await c.query('SELECT e.*, k.organisation_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1 FOR UPDATE OF e', [s.enrolment_id])).rows[0];
  if (!e || !['enrolled', 'paused'].includes(e.status)) {
    await c.query("UPDATE billing_schedules SET status='ended', ended_at=now(), ended_reason='enrolment_ended' WHERE id=$1", [s.id]);
    return 0;
  }
  const dates = s.due_texts;
  let made = 0;
  for (const [n, due] of dates.entries()) {
    if (daysBetween(today, due) > s.raise_days_before) break;
    const p = await c.query('INSERT INTO billing_schedule_periods(schedule_id, period_no, due_on) VALUES ($1,$2,$3) ON CONFLICT (schedule_id, period_no) DO NOTHING RETURNING id', [s.id, n + 1, due]);
    if (!p.rowCount) continue;                                       // another run already raised this period
    const seq = (await c.query('SELECT coalesce(max(seq), -1) + 1 AS n FROM academy_charges WHERE enrolment_id=$1', [s.enrolment_id])).rows[0].n;
    const amount = Number(s.amount_minor), rate = Number(s.tax_rate_bp);
    const [ch] = await insertCharges(c, { enrolmentId: s.enrolment_id, orgId: s.organisation_id, payerId: s.payer_id, seqStart: seq, rows: [{
      kind: chargeKind(e), due_on: due, currency: s.currency, gross_minor: amount, discount_minor: 0, funded_minor: 0, tax_minor: Math.round((amount * rate) / (10000 + rate)), amount_minor: amount,
      terms: { billing_model: 'schedule', schedule_id: s.id, period_no: n + 1, of: dates.length, label: s.label, tax_rate_bp: rate } }] });
    await c.query('UPDATE billing_schedule_periods SET charge_id=$2 WHERE id=$1', [p.rows[0].id, ch.id]);
    made++;
  }
  return made;
}

/** Worker step: raise the charges of every active schedule that has a period coming due. */
export async function raiseScheduledCharges({ today = todayStr(), limit = 500, ownerId = null } = {}) {
  const ids = await many("SELECT s.id FROM billing_schedules s WHERE s.status='active' AND ($2::uuid IS NULL OR s.organisation_id=$2) AND (SELECT count(*) FROM billing_schedule_periods p WHERE p.schedule_id=s.id) < cardinality(s.due_dates) ORDER BY s.id LIMIT $1", [limit, ownerId]);
  let n = 0;
  for (const s of ids) n += await tx((c) => raiseForSchedule(c, s.id, { today }));
  return n;
}

// ---------------------------------------------------------------------------------------------------------------- reports
const N = (v) => Number(v ?? 0);

/** Everything the finance desk needs to judge collections, per currency (never summed across currencies), derived from charges, receipts, adjustments and payments. */
export async function collectionsReport(orgId, { from, to, today = todayStr() } = {}) {
  const cur = new Map();
  const row = (k) => { if (!cur.has(k)) cur.set(k, { currency: k, billed_minor: 0, collected_minor: 0, waived_minor: 0, conceded_minor: 0, outstanding_minor: 0, overdue_minor: 0, recovered_minor: 0, buckets: null, forecast: { next_30_minor: 0, next_60_minor: 0, next_90_minor: 0 }, scheduled_not_yet_raised_minor: 0, payment_attempts: { total: 0, failed: 0 }, auto_debit: { attempts: 0, failed: 0 }, recovery_days: { cases: 0, average: null } }); return cur.get(k); };

  for (const r of await many(`SELECT currency, coalesce(sum(amount_minor),0) AS v FROM academy_charges WHERE organisation_id=$1 AND due_on BETWEEN $2 AND $3 AND status <> 'cancelled' GROUP BY 1`, [orgId, from, to])) row(r.currency).billed_minor = N(r.v);
  for (const r of await many(`SELECT ch.currency, coalesce(sum(x.amount_minor),0) AS v FROM charge_receipts x JOIN academy_charges ch ON ch.id=x.charge_id WHERE ch.organisation_id=$1 AND x.created_at::date BETWEEN $2 AND $3 GROUP BY 1`, [orgId, from, to])) row(r.currency).collected_minor = N(r.v);
  for (const r of await many(`SELECT ch.currency, x.kind, coalesce(sum(x.amount_minor),0) AS v FROM charge_adjustments x JOIN academy_charges ch ON ch.id=x.charge_id WHERE ch.organisation_id=$1 AND x.created_at::date BETWEEN $2 AND $3 GROUP BY 1, 2`, [orgId, from, to])) row(r.currency)[r.kind === 'waiver' ? 'waived_minor' : 'conceded_minor'] = N(r.v);

  // what is still owed on the report date: the same figure the desk lists, so the two reconcile (the ageing buckets come from the one receivables ageing, below)
  const open = await many(
    `SELECT ch.currency, ch.due_on::text AS due, ch.amount_minor - ch.settled_minor - ch.adjusted_minor AS balance FROM academy_charges ch
      WHERE ch.organisation_id=$1 AND ch.status='awaiting_payment' AND ch.amount_minor - ch.settled_minor - ch.adjusted_minor > 0`, [orgId]);
  for (const r of open) {
    const x = row(r.currency), bal = N(r.balance), d = daysBetween(r.due, today);
    x.outstanding_minor += bal;
    if (d > 0) x.overdue_minor += bal;
    const ahead = -d;
    if (ahead < 0) continue;                                         // already late: that is overdue, not forecast
    if (ahead <= 30) x.forecast.next_30_minor += bal; else if (ahead <= 60) x.forecast.next_60_minor += bal; else if (ahead <= 90) x.forecast.next_90_minor += bal;
  }
  // charges the schedules will raise later: scheduled, not yet owed
  for (const s of await many("SELECT s.currency, s.amount_minor, s.due_dates::text[] AS due_texts, (SELECT count(*)::int FROM billing_schedule_periods p WHERE p.schedule_id=s.id) AS raised FROM billing_schedules s WHERE s.organisation_id=$1 AND s.status='active'", [orgId])) {
    s.due_texts.slice(s.raised).forEach((iso) => {
      const x = row(s.currency); x.scheduled_not_yet_raised_minor += N(s.amount_minor);
      const ahead = daysBetween(today, iso);
      if (ahead >= 0 && ahead <= 30) x.forecast.next_30_minor += N(s.amount_minor); else if (ahead > 30 && ahead <= 60) x.forecast.next_60_minor += N(s.amount_minor); else if (ahead > 60 && ahead <= 90) x.forecast.next_90_minor += N(s.amount_minor);
    });
  }
  // recovery: cases that went overdue or failed and were then paid in the period
  for (const r of await many(
    `SELECT cs.currency, count(*)::int AS n, coalesce(sum(coalesce((SELECT sum(x.amount_minor) FROM charge_receipts x WHERE x.charge_id=cs.source_id),0)),0) AS amount,
            avg(cs.closed_at::date - cs.due_on) AS days
       FROM collection_cases cs WHERE cs.owner_type='organisation' AND cs.owner_id=$1 AND cs.state='resolved' AND cs.closed_at::date BETWEEN $2 AND $3 GROUP BY 1`, [orgId, from, to])) {
    const x = row(r.currency); x.recovered_minor = N(r.amount); x.recovery_days = { cases: r.n, average: r.days == null ? null : Math.round(Number(r.days) * 10) / 10 };
  }
  for (const r of await many(
    `SELECT pay.currency, count(*)::int AS total, count(*) FILTER (WHERE pay.status='failed')::int AS failed FROM payments pay JOIN academy_charges ch ON ch.id=pay.purpose_id
      WHERE pay.purpose_type='academy_charge' AND ch.organisation_id=$1 AND pay.created_at::date BETWEEN $2 AND $3 AND pay.status IN ('paid','refunded','failed') GROUP BY 1`, [orgId, from, to])) row(r.currency).payment_attempts = { total: r.total, failed: r.failed };
  for (const r of await many(
    `SELECT cs.currency, count(*) FILTER (WHERE ev.kind IN ('auto_debit_started','auto_debit_failed'))::int AS attempts, count(*) FILTER (WHERE ev.kind='auto_debit_failed')::int AS failed
       FROM collection_events ev JOIN collection_cases cs ON cs.id=ev.case_id WHERE cs.owner_type='organisation' AND cs.owner_id=$1 AND ev.created_at::date BETWEEN $2 AND $3 GROUP BY 1`, [orgId, from, to])) row(r.currency).auto_debit = { attempts: r.attempts, failed: r.failed };

  // proof the figures rest on facts: the running totals on charges equal their receipts / adjustments, online receipts equal the paid payments, paid charges have paid invoices
  const checks = await one(
    `SELECT
       (SELECT count(*)::int FROM academy_charges ch WHERE ch.organisation_id=$1 AND ch.settled_minor <> coalesce((SELECT sum(x.amount_minor) FROM charge_receipts x WHERE x.charge_id=ch.id),0)) AS receipts_mismatch,
       (SELECT count(*)::int FROM academy_charges ch WHERE ch.organisation_id=$1 AND ch.adjusted_minor <> coalesce((SELECT sum(x.amount_minor) FROM charge_adjustments x WHERE x.charge_id=ch.id),0)) AS adjustments_mismatch,
       (SELECT count(*)::int FROM charge_receipts x JOIN academy_charges ch ON ch.id=x.charge_id JOIN payments p ON p.id=x.payment_id WHERE ch.organisation_id=$1 AND p.status NOT IN ('paid','refunded')) AS receipts_without_paid_payment,
       (SELECT count(*)::int FROM academy_charges ch WHERE ch.organisation_id=$1 AND ch.status='paid' AND ch.amount_minor > 0 AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.academy_charge_id=ch.id AND i.kind='invoice' AND i.status='paid')) AS paid_without_paid_invoice`, [orgId]);
  const aged = new Map((await ageing(orgId, today, { lines: 0 })).currencies.map((a) => [a.currency, a]));
  for (const x of cur.values()) x.buckets = aged.get(x.currency)?.buckets ?? Object.fromEntries(['not_yet_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'].map((b) => [b, { count: 0, amount_minor: 0 }]));
  const currencies = [...cur.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((x) => ({
    ...x, collection_rate_pct: x.billed_minor ? Math.round((x.collected_minor / x.billed_minor) * 1000) / 10 : null,
    payment_failure_rate_pct: x.payment_attempts.total ? Math.round((x.payment_attempts.failed / x.payment_attempts.total) * 1000) / 10 : null,
    auto_debit_failure_rate_pct: x.auto_debit.attempts ? Math.round((x.auto_debit.failed / x.auto_debit.attempts) * 1000) / 10 : null,
  }));
  return {
    period: { from, to }, as_of: today, currencies,
    reconciles: !checks.receipts_mismatch && !checks.adjustments_mismatch && !checks.receipts_without_paid_payment && !checks.paid_without_paid_invoice,
    checks,
    definitions: {
      ageing: 'Balance still owed by days past due, from the receivables ageing (get_academy_receivables), so both always agree.', billed: 'Charges due in the period (cancelled excluded).', collected: 'Receipts recorded in the period (online and desk).', waived_and_conceded: 'Adjustments recorded in the period.',
      outstanding: 'Balance still owed on unpaid charges today: amount - received - waived or conceded.', overdue: 'The part of outstanding that is past its due date.',
      recovered: 'Receipts on charges that went overdue or failed and were then paid, closed in the period.', forecast: 'Balances not yet due that fall due in the next 30 / 60 / 90 days plus schedule periods not yet raised. It is what is scheduled, not a prediction of cash.',
      failure_rate: 'Failed payments as a share of paid and failed payments. Auto-debit attempts are counted separately and only when a provider adapter ran them.',
    },
  };
}
