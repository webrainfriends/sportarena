// Mutually accepted amendments of an accepted sponsorship agreement (#296).
// An amendment is a PROPOSAL (new full set of contribution lines, period, optional payee allocations and an effective date). It changes nothing
// until the other side accepts the exact revision. Acceptance writes a new numbered terms version and re-plans only the FUTURE dues that nothing
// has happened to; fulfilled, part-paid, dispatched, submitted and past dues stay exactly as they are. Nothing is deleted.
import { buildSchedule } from './sponsor-schedule.js';
import { loadLines, saveLines, generateObligations, logHistory, recordVersion } from './sponsor-agreements.js';
import { snapshotIdentity } from './sponsor-identity-access.js';
import { resolveAllocations, writeAllocations, ORG_TARGETS } from './sponsor-beneficiaries.js';
import { assertFits, convert, storedRate } from './sponsorship-budgets.js';
import { badRequest, conflict, unprocessable } from './errors.js';

/** SQL: something has already happened to the due `o` (money reported / confirmed / in checkout, goods dispatched, evidence submitted). */
export const ACTIVITY = `(EXISTS (SELECT 1 FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status IN ('reported','confirmed','awaiting_payment'))
  OR EXISTS (SELECT 1 FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status <> 'rejected')
  OR EXISTS (SELECT 1 FROM sponsorship_submissions s WHERE s.obligation_id=o.id AND s.status <> 'revision_requested'))`;

const COMPARED = ['kind', 'label', 'currency', 'amount_cents', 'total_cents', 'estimate_cents', 'quantity', 'unit', 'cadence', 'first_due_on', 'instalments', 'custom_dates', 'promoter', 'terms'];
const norm = (l) => JSON.stringify(COMPARED.map((k) => (k === 'terms' ? l[k] ?? {} : l[k] ?? null)));
const sameLines = (a, b) => a.length === b.length && a.every((l, n) => norm(l) === norm(b[n]));
const row = (o) => ({ id: o.id, label: o.label, kind: o.kind, due_on: o.due_on, amount_cents: o.amount_cents == null ? null : Number(o.amount_cents), currency: o.currency, quantity: o.quantity, status: o.status, version: o.version });

export const today = async (c) => (await c.query('SELECT current_date::text AS d')).rows[0].d;

/** The current accepted terms of a deal, in the shape a proposal takes. */
export const currentTerms = async (c, d) => ({ lines: await loadLines(c, d.id, d.accepted_version), starts_on: d.starts ?? null, ends_on: d.ends ?? null, timezone: d.timezone ?? null });

/**
 * What accepting a proposal would do to the dues, before anyone agrees to it. `retained` dues (earlier than the effective date) are never touched;
 * `replaced` are future dues nothing has happened to (they are cancelled and re-planned); `locked` are future dues that already have money, goods
 * or evidence against them or are fulfilled: they cannot be replaced, so the proposal is blocked until the effective date is after them.
 */
export async function impactOf(c, d, p) {
  const dues = (await c.query(
    `SELECT o.id, o.version, l.label, o.kind, o.due_on::text AS due_on, o.amount_cents, o.currency, o.quantity, o.status, (o.status = 'scheduled' AND NOT ${ACTIVITY}) AS untouched
       FROM sponsorship_obligations o JOIN sponsorship_lines l ON l.id=o.line_id WHERE o.sponsorship_id=$1 AND o.status <> 'cancelled' ORDER BY o.due_on, o.id`, [d.id])).rows;
  const retained = [], replaced = [], locked = [];
  for (const o of dues) (o.due_on < p.effective_from ? retained : o.untouched ? replaced : locked).push(row(o));
  const plan = buildSchedule(p.lines, { starts_on: p.starts_on, ends_on: p.ends_on });
  const added = plan.occurrences.filter((o) => o.due_on >= p.effective_from).map((o) => ({ label: o.label, kind: o.kind, due_on: o.due_on, amount_cents: o.amount_cents ?? null, currency: o.currency ?? null, quantity: o.quantity ?? null }));
  const sum = (list) => { const t = {}; for (const o of list) if (o.kind === 'money') t[o.currency] = (t[o.currency] ?? 0) + Number(o.amount_cents); return t; };
  const before = sum(dues.map(row)), after = sum([...retained, ...locked, ...added]);
  const totals = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map((currency) => ({ currency, before_cents: before[currency] ?? 0, after_cents: after[currency] ?? 0, delta_cents: (after[currency] ?? 0) - (before[currency] ?? 0) }));
  const blocked = locked.length ? `${locked.length} due${locked.length === 1 ? '' : 's'} on or after ${p.effective_from} already ${locked.length === 1 ? 'has' : 'have'} a payment, delivery, evidence or fulfilment, so ${locked.length === 1 ? 'it' : 'they'} cannot be replaced. Choose an effective date after ${locked[locked.length - 1].due_on}.` : null;
  return { effective_from: p.effective_from, retained_count: retained.length, retained, replaced, locked, added, ignored_before_effective: plan.occurrences.length - added.length, totals, estimated_not_cash: plan.estimated_not_cash, blocked };
}

/** A proposal that changes nothing is refused, so the other side is never asked to agree to a no-op. */
export async function assertChanges(c, d, p) {
  const cur = await currentTerms(c, d);
  if (sameLines(cur.lines, p.lines) && cur.starts_on === p.starts_on && cur.ends_on === p.ends_on && !p.allocations && (cur.timezone ?? null) === (p.timezone ?? null)) throw badRequest('This proposal does not change anything');
}

/** Normalise and check a proposal against the live agreement. Returns the stored shape (period and timezone resolved). */
export async function checkProposal(c, ctx, i) {
  const { d } = ctx;
  if (d.status !== 'active' || !d.accepted_version) throw conflict(`Only an active, accepted agreement can be amended (this one is ${d.status})`);
  const starts = i.starts_on ?? d.starts ?? null, ends = i.ends_on ?? d.ends ?? null;
  if (starts && ends && ends < starts) throw badRequest('ends_on is before starts_on');
  if (i.effective_from < await today(c)) throw badRequest('The effective date cannot be in the past: dues that are already due are never rewritten');
  buildSchedule(i.lines, { starts_on: starts, ends_on: ends }); // validates every line and the whole schedule
  const p = { lines: i.lines, starts_on: starts, ends_on: ends, timezone: i.timezone ?? d.timezone ?? null, effective_from: i.effective_from, allocations: null };
  if (i.allocations) {
    if (!ORG_TARGETS.includes(d.target_type)) throw badRequest('Payee allocations only apply to organisation and group agreements');
    if (ctx.role !== 'recipient') throw badRequest('Only the organisation can propose who is paid');
    p.allocations = (await resolveAllocations(c, d, ctx.beneficiary.orgId, i.allocations)).wanted.map(({ key, keep, ...a }) => a);
  }
  await assertChanges(c, d, p);
  const impact = await impactOf(c, d, p);
  if (impact.blocked) throw conflict(impact.blocked, { code: 'locked_dues', locked: impact.locked });
  if (d.budget_id && i.lines.some((l) => l.kind === 'money')) {
    const cash = [...new Set(i.lines.filter((l) => l.kind === 'money').map((l) => l.currency))];
    if (cash.length !== 1 || (d.currency && cash[0] !== d.currency)) throw unprocessable('A budget-controlled agreement needs money lines in exactly one currency, the one it was agreed in');
  }
  return { p, impact };
}

/**
 * Apply an accepted amendment. Runs inside the caller's transaction with the sponsorship row locked, so two acceptances can never both apply and a
 * failure anywhere rolls the whole thing back. Returns the new terms version.
 */
export async function applyAmendment(c, ctx, am, actor) {
  const { d } = ctx;
  const p = { lines: am.lines, starts_on: am.starts_on, ends_on: am.ends_on, effective_from: am.effective_from };
  if (am.effective_from < await today(c)) throw conflict('The effective date has passed; ask for the proposal to be revised with a later date', { code: 'effective_date_passed' });
  const impact = await impactOf(c, d, p);
  if (impact.blocked) throw conflict(`${impact.blocked} Ask for the proposal to be revised.`, { code: 'locked_dues', locked: impact.locked });
  if (d.budget_id) { // only extra cash needs headroom; a reduction frees budget on its own
    const t = impact.totals[0];
    if (impact.totals.length > 1) throw unprocessable('A budget-controlled agreement needs money in exactly one currency');
    if (t && t.delta_cents > 0) {
      const b = (await c.query('SELECT currency FROM sponsorship_budgets WHERE id=$1', [d.budget_id])).rows[0];
      await assertFits(c, d.budget_id, convert(t.delta_cents, t.currency, b.currency, await storedRate(c, d.budget_fx_rate_id)), { what: 'This amendment' });
    }
  }
  const v = d.terms_version + 1;
  await saveLines(c, d.id, v, am.lines);
  const sponsorUser = am.proposed_side === 'sponsor' ? am.proposed_by : actor.id; // the brand's signatory is whoever on the sponsor side agreed
  await snapshotIdentity(c, d.id, v, ctx.sp.id, sponsorUser);
  await recordVersion(c, d.id, v, am.proposed_side, am.proposed_by, { reason: am.reason, starts: am.starts_on, ends: am.ends_on, tz: am.timezone });
  await c.query('UPDATE sponsorship_versions SET signed_off_by=$3, signed_off_at=now(), effective_from=$4, amendment_id=$5 WHERE sponsorship_id=$1 AND version=$2', [d.id, v, actor.id, am.effective_from, am.id]);
  const gone = (await c.query(
    `UPDATE sponsorship_obligations o SET status='cancelled', cancelled_at=now(), cancelled_by_amendment=$2
      WHERE o.id = ANY($1::uuid[]) AND o.status='scheduled' AND NOT ${ACTIVITY} RETURNING o.id`, [impact.replaced.map((o) => o.id), am.id])).rowCount;
  if (gone !== impact.replaced.length) throw conflict('Some dues changed while this was being applied; nothing was changed. Try again.');
  const cash = impact.totals.length === 1 ? impact.totals[0] : null;
  await c.query('UPDATE sponsorships SET terms_version=$2, accepted_version=$2, terms_side=$3, starts_on=$4, ends_on=$5, timezone=$6, amount_cents=$7, currency=$8 WHERE id=$1',
    [d.id, v, am.proposed_side, am.starts_on, am.ends_on, am.timezone, cash ? cash.after_cents : 0, cash ? cash.currency : null]);
  const made = await generateObligations(c, d.id);
  if (made !== impact.added.length) throw conflict('The schedule did not match the preview; nothing was changed. Try again.');
  await c.query('UPDATE sponsorship_obligations SET created_by_amendment=$2 WHERE sponsorship_id=$1 AND version=$3', [d.id, am.id, v]);
  if (am.allocations) {
    if (am.base_allocation_rev !== d.allocation_rev) throw conflict('The payee allocations changed since this was proposed; ask for the proposal to be revised', { code: 'allocations_changed' });
    const { wanted } = await resolveAllocations(c, { ...d, terms_version: v }, ctx.beneficiary.orgId, am.allocations);
    await writeAllocations(c, { ...d, terms_version: v }, wanted, actor.id);
  }
  await logHistory(c, d.id, v, actor.id, 'amendment_accepted', `Amendment ${am.seq}: ${impact.replaced.length} due${impact.replaced.length === 1 ? '' : 's'} replaced by ${made}, effective ${am.effective_from}`);
  return { version: v, replaced: impact.replaced.length, created: made, impact };
}
