// Academy uniforms, kits & equipment issuance (#798): the rules. Stock, money, suppliers and guardians are never copied - this module only decides who may
// hand what to whom and writes the canonical records: `inventory_items` + `pos_stock_moves` (stock and its append-only ledger), `academy_charges` ->
// `invoices` (what a family owes), `supply_orders` (replenishment). Everything is checked on the server for REST, OpenAPI and MCP alike.
import { tx, pool } from './db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { audit } from './helpers.js';
import { notify } from './notify.js';
import { opsAccess } from './academy-ops.js';
import { requireApproved } from './org-access.js';
import { posRole } from './pos/access.js';
import { drawStock, restoreStock } from './pos/sale.js';
import { balanceOf, cancelUnpaidCharges, creditChargeInvoice, syncChargeInvoice } from './academy-invoices.js';
import { guardiansOf, isYouth } from './youth.js';
import { refundPartial } from './payments/service.js';
import { restoreForPurpose } from './rewards/redeem.js';
import { reverseActivity } from './rewards/activity.js';

/** Statuses in which the athlete holds the kit (or is about to). */
export const HELD = ['reserved', 'issued', 'writeoff_pending'];

// ------------------------------------------------------------------ who may do what
/**
 * need: 'read' (requirements and stock, no money or fit notes for coaches), 'issue' (hand over, take back, fit, scan - staff holding the `kit` permission and the desk
 * staff of one of the academy's venues; they see what the item they hand over costs, never the academy's finances), 'manage' (entitlements, orders, approvals - owners, admins and staff holding the `kit_admin` permission).
 * Outsiders get a 404 so the academy's existence is not leaked. Read live on every call, so revoking access takes effect immediately.
 */
export async function kitAccess(user, orgId, { need = 'read', venueId = null, c } = {}) {
  const write = need !== 'read';
  let a = null;
  try { a = await opsAccess(user, orgId, { write, c }); } catch (e) {
    if (!(e instanceof AppError) || e.status !== 404 || !venueId || need === 'manage') throw e;
  }
  const q = c ?? pool;
  const deskVenue = async () => {
    if (!venueId) return null;
    const v = (await q.query('SELECT id, organisation_id FROM venues WHERE id=$1', [venueId])).rows[0];
    if (!v || v.organisation_id !== orgId) return null;
    try { return (await posRole(user, venueId, q)).role; } catch { return null; }
  };
  if (a) {
    const manage = a.admin || a.has('kit_admin');
    if (manage) return { a, level: 'manage', manage: true, issue: true, admin: a.admin, money: true, finance: true, org: a.org };
    if (need === 'manage') throw forbidden('You do not have kit management access to this academy');
    if (a.has('kit')) return { a, level: 'kit', manage: false, issue: true, admin: false, money: true, finance: false, org: a.org };
    const desk = await deskVenue();
    if (desk) return { a, level: 'desk', manage: false, issue: true, admin: false, money: true, finance: false, org: a.org };
    if (need === 'issue') throw forbidden('You do not have kit access to this academy');
    if (a.has('roster') || a.has('schedule') || a.has('attendance')) return { a, level: 'view', manage: false, issue: false, admin: false, money: false, finance: false, org: a.org };
    throw forbidden('You do not have kit access to this academy');
  }
  const desk = await deskVenue();
  if (!desk) throw notFound('Organisation');
  const org = (await q.query('SELECT * FROM organisations WHERE id=$1', [orgId])).rows[0];
  if (write) { if (org.status !== 'active') throw conflict('This organisation is archived and read-only'); await requireApproved(org, q); }
  return { a: null, level: 'desk', manage: false, issue: true, admin: false, money: true, finance: false, org };
}

// ------------------------------------------------------------------ small helpers
const today = () => new Date().toISOString().slice(0, 10);

export async function academyCurrency(c, orgId) {
  return (await c.query('SELECT currency FROM academy_profiles WHERE organisation_id=$1', [orgId])).rows[0]?.currency ?? 'GBP';
}

export async function orgVenue(c, orgId, venueId) {
  const v = (await c.query('SELECT id, name, currency, organisation_id FROM venues WHERE id=$1 AND organisation_id=$2', [venueId, orgId])).rows[0];
  if (!v) throw notFound('Venue');
  return v;
}

export async function lockEnrolment(c, orgId, enrolmentId) {
  const e = (await c.query(
    `SELECT e.*, k.organisation_id, k.team_id, k.name AS cohort_name FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id
      WHERE e.id=$1 AND k.organisation_id=$2 FOR UPDATE OF e`, [enrolmentId, orgId])).rows[0];
  if (!e) throw notFound('Enrolment');
  return e;
}

/** Does this entitlement apply to the enrolment (programme, cohort or squad)? */
export const applies = (ent, e) => (ent.scope_type === 'programme' ? ent.scope_id === e.programme_id : ent.scope_type === 'cohort' ? ent.scope_id === e.cohort_id : ent.scope_id === e.team_id);

/** The people who hear about an athlete's kit: the verified guardians of a young person, otherwise the athlete. Generic wording, never names or amounts. */
export async function tellAthlete(c, athleteId, orgId, kind, title, dedupe) {
  const to = (await isYouth(athleteId, c)) ? await guardiansOf(athleteId, c) : [athleteId];
  for (const uid of to) await notify(c, uid, { kind: `academy_kit_${kind}`, title, body: 'Open Gotmygame to see the details.', data: { organisation_id: orgId, athlete_id: athleteId, tab: 'kit' }, dedupe_key: `academy:kit:${kind}:${dedupe}:${uid}` });
}

async function payerOf(c, e) {
  const prior = (await c.query('SELECT payer_id FROM academy_charges WHERE enrolment_id=$1 ORDER BY seq LIMIT 1', [e.id])).rows[0];
  if (prior) return prior.payer_id;
  if (await isYouth(e.user_id, c)) {
    const g = (await guardiansOf(e.user_id, c))[0];
    if (!g) throw conflict('This young person has no verified guardian to bill. Add a guardian before charging for kit.');
    return g;
  }
  return e.user_id;
}

/** A canonical academy charge for kit (`kit`) or a refundable deposit (`kit_deposit`). Collected at the desk, online or by the family exactly like any other fee. */
async function raiseCharge(c, e, { kind, amount, label, issueId }) {
  const payer = await payerOf(c, e);
  const currency = await academyCurrency(c, e.organisation_id);
  const seq = (await c.query('SELECT coalesce(max(seq), -1) + 1 AS n FROM academy_charges WHERE enrolment_id=$1', [e.id])).rows[0].n;
  const ch = (await c.query(
    `INSERT INTO academy_charges(enrolment_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, amount_minor, terms, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,'awaiting_payment') RETURNING *`,
    [e.id, e.organisation_id, payer, seq, kind, today(), currency, amount, JSON.stringify({ label, kit_issue_id: issueId })])).rows[0];
  await syncChargeInvoice(c, ch.id);
  return ch;
}

async function addEvent(c, issue, actorId, kind, data = {}) {
  await c.query('INSERT INTO academy_kit_events(organisation_id, issue_id, kind, actor_id, data) VALUES ($1,$2,$3,$4,$5)', [issue.organisation_id, issue.id, kind, actorId, JSON.stringify(data)]);
}

const itemLabel = (it) => `${it.name}${it.size_label ? ` (${it.size_label})` : ''}`;

// ------------------------------------------------------------------ choosing the stock row
async function resolveItem(c, ent, e, i, venueId) {
  if (i.item_id) {
    const it = (await c.query('SELECT * FROM inventory_items WHERE id=$1 AND venue_id=$2 AND archived_at IS NULL', [i.item_id, venueId])).rows[0];
    if (!it) throw notFound('Item');
    return it;
  }
  if (!ent) throw badRequest('Choose the item to issue');
  let size = i.size_label ?? null;
  if (ent.size_required && !size) {
    size = (await c.query('SELECT size_label FROM academy_kit_sizes WHERE organisation_id=$1 AND athlete_id=$2 AND slot=$3 AND superseded_at IS NULL', [e.organisation_id, e.user_id, ent.kit_slot ?? ent.style_key])).rows[0]?.size_label ?? null;
    if (!size) throw new AppError(422, 'size_required', 'This athlete has no size on file for this kit yet. Record the fitting first.', { slot: ent.kit_slot ?? ent.style_key });
  }
  const it = (await c.query(
    `SELECT * FROM inventory_items WHERE venue_id=$1 AND style_key=$2 AND archived_at IS NULL AND ($3::text IS NULL OR lower(size_label)=lower($3)) ORDER BY quantity DESC LIMIT 1`, [venueId, ent.style_key, ent.size_required ? size : null])).rows[0];
  if (!it) throw new AppError(409, 'no_stock_row', ent.size_required ? `This venue does not stock ${ent.style_key} in size ${size}.` : `This venue does not stock ${ent.style_key}.`, { style_key: ent.style_key, size_label: size });
  return it;
}

async function pickUnit(c, item, { unit_id, serial_no }) {
  const row = unit_id || serial_no
    ? (await c.query(`SELECT * FROM inventory_units WHERE item_id=$1 AND ${unit_id ? 'id' : 'serial_no'}=$2 FOR UPDATE`, [item.id, unit_id ?? serial_no])).rows[0]
    : (await c.query("SELECT * FROM inventory_units WHERE item_id=$1 AND status='in_stock' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED", [item.id])).rows[0];
  if (!row) throw conflict(`No unit of ${item.name} is in stock`);
  if (row.status !== 'in_stock') throw conflict(`That unit is ${row.status.replace('_', ' ')}`);
  return row;
}

// ------------------------------------------------------------------ issue
export async function issueKit(user, ctx, orgId, i) {
  const { c } = ctx;
  if (i.client_ref) {
    const dup = (await c.query('SELECT id FROM academy_kit_issues WHERE organisation_id=$1 AND client_ref=$2', [orgId, i.client_ref])).rows[0];
    if (dup) return { ...(await issueView(c, dup.id, { money: ctx.money })), replayed: true };
  }
  const e = await lockEnrolment(c, orgId, i.enrolment_id);
  if (i.client_ref) {          // a twin of this request may have committed while we waited for the enrolment lock
    const twin = (await c.query('SELECT id FROM academy_kit_issues WHERE organisation_id=$1 AND client_ref=$2', [orgId, i.client_ref])).rows[0];
    if (twin) return { ...(await issueView(c, twin.id, { money: ctx.money })), replayed: true };
  }
  if (!['enrolled', 'paused'].includes(e.status)) throw conflict('Kit is issued to athletes with a live enrolment');
  const venue = await orgVenue(c, orgId, i.venue_id);
  if (ctx.a && !ctx.manage) {         // staff limited to some sports or groups can only hand kit to those athletes
    const sport = e.programme_id ? (await c.query('SELECT sport FROM academy_programmes WHERE id=$1', [e.programme_id])).rows[0]?.sport : undefined;
    if (!ctx.a.scopeOk({ sport, cohort_id: e.cohort_id })) throw forbidden('This athlete is outside your scope');
  }
  let ent = null;
  if (i.entitlement_id) {
    ent = (await c.query('SELECT * FROM academy_kit_entitlements WHERE id=$1 AND organisation_id=$2', [i.entitlement_id, orgId])).rows[0];
    if (!ent) throw notFound('Entitlement');
    if (ent.archived_at) throw conflict('This entitlement is archived');
    if (!applies(ent, e)) throw conflict('This entitlement does not cover that athlete\'s programme, group or squad');
    if (ent.fulfil_venue_id && ent.fulfil_venue_id !== venue.id) throw conflict('This kit is collected at a different venue');
    const have = (await c.query(
      `SELECT coalesce(sum(qty),0)::int AS n FROM academy_kit_issues WHERE enrolment_id=$1 AND entitlement_id=$2 AND status = ANY($3)
          AND ($4::int IS NULL OR issued_at IS NULL OR issued_at >= now() - make_interval(months => $4))`, [e.id, ent.id, HELD, ent.replace_after_months])).rows[0].n;
    if (have + i.qty > ent.qty) throw new AppError(409, 'entitlement_exhausted', `This athlete is entitled to ${ent.qty} and already has ${have}.`, { entitled: ent.qty, held: have });
  } else if (!ctx.manage) throw forbidden('Only a kit manager can issue kit outside an entitlement');
  const item = await resolveItem(c, ent, e, i, venue.id);
  if (item.serialised && i.qty !== 1) throw badRequest('Serial-numbered kit is issued one unit at a time');
  let unit = null;
  const issue = (await c.query(
    `INSERT INTO academy_kit_issues(organisation_id, enrolment_id, athlete_id, entitlement_id, item_id, venue_id, qty, status, client_ref, issued_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$10) RETURNING *`, [orgId, e.id, e.user_id, ent?.id ?? null, item.id, venue.id, i.qty, i.client_ref ?? null, user.id, i.note ?? null])).rows[0];
  await drawStock(c, venue.id, item.id, i.qty, { reason: 'kit_issue', actor: user, kitIssueId: issue.id, note: ent?.name ?? i.note ?? null });
  if (item.serialised) {
    unit = await pickUnit(c, item, i);
    await c.query("UPDATE inventory_units SET status='issued' WHERE id=$1", [unit.id]);
    await c.query('UPDATE academy_kit_issues SET unit_id=$2 WHERE id=$1', [issue.id, unit.id]);
  }
  // what the family owes (fee and/or refundable deposit) goes on the canonical academy charge; stock was already taken under the row lock
  let chargeId = null, depositId = null;
  const label = `Kit · ${itemLabel(item)}`;
  if (ent?.mode === 'charged') {
    const amount = Number(ent.price_minor ?? item.sell_price_cents ?? 0) * i.qty;
    if (amount > 0) chargeId = (await raiseCharge(c, e, { kind: 'kit', amount, label, issueId: issue.id })).id;
  }
  if (ent?.mode === 'deposit') {
    const amount = Number(ent.deposit_minor ?? item.deposit_cents ?? 0) * i.qty;
    if (amount > 0) depositId = (await raiseCharge(c, e, { kind: 'kit_deposit', amount, label: `Refundable deposit · ${itemLabel(item)}`, issueId: issue.id })).id;
  }
  const mustPayFirst = !!ent?.require_payment && (chargeId || depositId);
  const out = (await c.query(
    `UPDATE academy_kit_issues SET charge_id=$2, deposit_charge_id=$3, status=$4::text, issued_at=CASE WHEN $4::text='issued' THEN now() END,
            due_back_at=CASE WHEN $4::text='issued' AND $5::int IS NOT NULL THEN now() + make_interval(days => $5::int) END WHERE id=$1 RETURNING *`,
    [issue.id, chargeId, depositId, mustPayFirst ? 'reserved' : 'issued', ent?.return_days ?? null])).rows[0];
  await addEvent(c, out, user.id, mustPayFirst ? 'reserved' : 'issued', { item_id: item.id, qty: i.qty, unit_id: unit?.id ?? null, entitlement_id: ent?.id ?? null, charge_id: chargeId, deposit_charge_id: depositId });
  await audit(c, user.id, mustPayFirst ? 'kit_reserve' : 'kit_issue', 'academy_kit_issues', out.id);
  if (!mustPayFirst) await tellAthlete(c, e.user_id, orgId, 'issued', 'Kit handed over', out.id);
  return issueView(c, out.id, { money: ctx.money });
}

/** A reserved item leaves the desk once what the family owes for it is paid (the same canonical charges the desk and the family portal collect). */
export async function handoverKit(user, ctx, orgId, issueId) {
  const { c } = ctx;
  const iss = await lockIssue(c, orgId, issueId);
  if (iss.status === 'issued') return issueView(c, iss.id, { money: ctx.money });
  if (iss.status !== 'reserved') throw conflict(`This kit is ${iss.status.replace('_', ' ')}`);
  for (const cid of [iss.charge_id, iss.deposit_charge_id].filter(Boolean)) {
    const ch = (await c.query('SELECT * FROM academy_charges WHERE id=$1', [cid])).rows[0];
    if (ch.status === 'awaiting_payment' && balanceOf(ch) > 0) throw new AppError(409, 'kit_payment_required', 'Collect the payment before handing this kit over.', { charge_id: cid, balance_minor: balanceOf(ch), currency: ch.currency });
  }
  const ent = iss.entitlement_id ? (await c.query('SELECT return_days FROM academy_kit_entitlements WHERE id=$1', [iss.entitlement_id])).rows[0] : null;
  await c.query(`UPDATE academy_kit_issues SET status='issued', issued_at=now(), issued_by=$2, due_back_at=CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3) END WHERE id=$1`, [iss.id, user.id, ent?.return_days ?? null]);
  await addEvent(c, iss, user.id, 'issued', { after_payment: true });
  await audit(c, user.id, 'kit_handover', 'academy_kit_issues', iss.id);
  await tellAthlete(c, iss.athlete_id, orgId, 'issued', 'Kit handed over', iss.id);
  return issueView(c, iss.id, { money: ctx.money });
}

export async function lockIssue(c, orgId, issueId) {
  const iss = (await c.query('SELECT * FROM academy_kit_issues WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [issueId, orgId])).rows[0];
  if (!iss) throw notFound('Kit issue');
  return iss;
}

async function putBack(c, user, iss, reason) {
  await restoreStock(c, iss.venue_id, iss.item_id, iss.qty, { kitIssueId: iss.id, reason, actor: user });
  if (iss.unit_id) await c.query("UPDATE inventory_units SET status='in_stock' WHERE id=$1", [iss.unit_id]);
}

/** Give up a reserved item before it left the desk: the stock goes back, the unpaid charges are cancelled. */
export async function cancelReserved(user, ctx, orgId, issueId) {
  const { c } = ctx;
  const iss = await lockIssue(c, orgId, issueId);
  if (iss.status !== 'reserved') throw conflict('Only a reserved item can be cancelled');
  await putBack(c, user, iss, 'kit_cancel');
  const ids = [iss.charge_id, iss.deposit_charge_id].filter(Boolean);
  if (ids.length) await cancelUnpaidCharges(c, 'id = ANY($1) AND settled_minor = 0', [ids]);
  await c.query("UPDATE academy_kit_issues SET status='cancelled' WHERE id=$1", [iss.id]);
  await addEvent(c, iss, user.id, 'cancelled');
  await audit(c, user.id, 'kit_cancel', 'academy_kit_issues', iss.id);
  return issueView(c, iss.id, { money: ctx.money });
}

// ------------------------------------------------------------------ the deposit follows the kit
/**
 * What happens to the refundable deposit when kit comes back (forfeit 0) or is written off (forfeit up to the whole deposit). Nothing here is a second ledger:
 * an unpaid deposit is cancelled with its invoice; a paid one is refunded through the canonical credit note, and a deposit paid online also needs the
 * provider refund, which the caller performs after the transaction commits (returned as `provider_refund`).
 */
export async function settleDeposit(c, iss, { forfeit = 0, key }) {
  if (!iss.deposit_charge_id) return null;
  const ch = (await c.query('SELECT * FROM academy_charges WHERE id=$1 FOR UPDATE', [iss.deposit_charge_id])).rows[0];
  const total = Number(ch.amount_minor);
  const kept = Math.min(forfeit, total);
  if (ch.status === 'awaiting_payment' && Number(ch.settled_minor) === 0) {
    await cancelUnpaidCharges(c, 'id = $1', [ch.id]);
    return { action: 'cancelled_unpaid', refund_minor: 0, forfeit_minor: 0, currency: ch.currency };
  }
  if (ch.status !== 'paid') throw new AppError(409, 'deposit_not_settled', 'Collect or waive the rest of this deposit before the kit is closed.', { charge_id: ch.id, balance_minor: balanceOf(ch) });
  const refund = total - kept;
  if (refund <= 0) return { action: 'forfeited', refund_minor: 0, forfeit_minor: kept, currency: ch.currency };
  const online = (await c.query("SELECT * FROM payments WHERE purpose_type='academy_charge' AND purpose_id=$1 AND status IN ('paid','refunded') ORDER BY paid_at DESC NULLS LAST LIMIT 1", [ch.id])).rows[0] ?? null;
  if (online) return { action: 'refund_online', refund_minor: refund, forfeit_minor: kept, currency: ch.currency, provider_refund: { payment: online, charge_id: ch.id, amount: refund, key } };
  const note = await creditChargeInvoice(c, ch.id, refund, key);                     // paid at the desk: the credit note is the record, the cash goes back across the desk
  if (kept === 0) await c.query("UPDATE academy_charges SET status='refunded' WHERE id=$1", [ch.id]);
  return { action: 'refund_at_desk', refund_minor: refund, forfeit_minor: kept, currency: ch.currency, credit_note: note?.number ?? null };
}

/**
 * A deposit paid online is refunded through the provider, which cannot sit inside our transaction: it runs after the kit is closed, under an idempotency key,
 * and finishes exactly as `refund_academy_charge` does (credit note, loyalty reversal, charge status). A failure leaves the kit closed and the refund retryable.
 */
export async function finishProviderRefund(user, deposit, issueId, orgId) {
  const pr = deposit?.provider_refund;
  if (!pr) return deposit;
  let given = 0;
  try { given = await refundPartial(pr.payment, pr.amount, pr.key); } catch (e) {
    await tx(async (c) => { await c.query('INSERT INTO academy_kit_events(organisation_id, issue_id, kind, actor_id, data) VALUES ($1,$2,$3,$4,$5)', [orgId, issueId, 'deposit_refund_failed', user.id, JSON.stringify({ charge_id: pr.charge_id, amount_minor: pr.amount, error: String(e.message).slice(0, 200) })]); });
    const { provider_refund, ...rest } = deposit;
    return { ...rest, action: 'refund_pending', error: 'The provider refund did not go through. Retry it from the charge (refund_academy_charge).' };
  }
  await tx(async (c) => {
    const after = (await c.query('SELECT * FROM payments WHERE id=$1', [pr.payment.id])).rows[0];
    if (given > 0) {
      await creditChargeInvoice(c, pr.charge_id, given, pr.key);
      const done = Number(after.refunded_cents), card = Number(after.amount_cents);
      await restoreForPurpose(c, 'academy_charge', pr.charge_id, { fraction: { num: done, den: card }, reason: 'Kit deposit refunded' });
      await reverseActivity(c, { sourceType: 'academy_charge', sourceId: pr.charge_id, refundedMinor: done, totalMinor: card, reason: 'Kit deposit refunded' });
    }
    if (Number(after.refunded_cents) >= Number(after.amount_cents)) await c.query("UPDATE academy_charges SET status='refunded' WHERE id=$1", [pr.charge_id]);
    await c.query('INSERT INTO academy_kit_events(organisation_id, issue_id, kind, actor_id, data) VALUES ($1,$2,$3,$4,$5)', [orgId, issueId, 'deposit_refunded', user.id, JSON.stringify({ charge_id: pr.charge_id, refunded_minor: given })]);
  });
  const { provider_refund, ...rest } = deposit;
  return { ...rest, refunded_minor: given };
}

// ------------------------------------------------------------------ return, exchange
export async function returnKit(user, ctx, orgId, issueId, i) {
  const { c } = ctx;
  const iss = await lockIssue(c, orgId, issueId);
  if (iss.status === 'returned') throw conflict('This kit was already returned');
  if (iss.status !== 'issued') throw conflict(`This kit is ${iss.status.replace('_', ' ')}, not with the athlete`);
  if (i.condition === 'damaged') return startWriteoff(user, ctx, iss, { kind: 'damaged', note: i.note ?? 'Returned damaged', returning: true });
  await putBack(c, user, iss, 'kit_return');
  const deposit = await settleDeposit(c, iss, { forfeit: 0, key: `kit-return:${iss.id}` });
  await c.query("UPDATE academy_kit_issues SET status='returned', returned_at=now(), returned_by=$2, return_condition=$3, note=coalesce($4,note) WHERE id=$1", [iss.id, user.id, i.condition, i.note ?? null]);
  await addEvent(c, iss, user.id, 'returned', { condition: i.condition, deposit: deposit && { action: deposit.action, refund_minor: deposit.refund_minor } });
  await audit(c, user.id, 'kit_return', 'academy_kit_issues', iss.id);
  await tellAthlete(c, iss.athlete_id, orgId, 'returned', 'Kit returned', iss.id);
  return { ...(await issueView(c, iss.id, { money: ctx.money })), deposit, _provider_refund: deposit?.provider_refund ?? null };
}

/** Swap for another size or item in one transaction: the old one goes back to the shelf, the new one comes off it, the charges stay with the entitlement. */
export async function exchangeKit(user, ctx, orgId, issueId, i) {
  const { c } = ctx;
  if (i.client_ref) {
    const dup = (await c.query('SELECT id FROM academy_kit_issues WHERE organisation_id=$1 AND client_ref=$2', [orgId, i.client_ref])).rows[0];
    if (dup) return { ...(await issueView(c, dup.id, { money: ctx.money })), replayed: true };
  }
  const old = await lockIssue(c, orgId, issueId);
  if (old.status !== 'issued') throw conflict(`Only kit with the athlete can be exchanged (this is ${old.status.replace('_', ' ')})`);
  const oldItem = (await c.query('SELECT * FROM inventory_items WHERE id=$1', [old.item_id])).rows[0];
  let target = null;
  if (i.item_id) target = (await c.query('SELECT * FROM inventory_items WHERE id=$1 AND venue_id=$2 AND archived_at IS NULL', [i.item_id, old.venue_id])).rows[0];
  else if (i.size_label) target = (await c.query('SELECT * FROM inventory_items WHERE venue_id=$1 AND style_key IS NOT DISTINCT FROM $2 AND lower(size_label)=lower($3) AND archived_at IS NULL ORDER BY quantity DESC LIMIT 1', [old.venue_id, oldItem.style_key, i.size_label])).rows[0];
  if (!target) throw new AppError(409, 'no_stock_row', 'This venue does not stock that size.', { size_label: i.size_label ?? null });
  if (target.id === old.item_id && !oldItem.serialised) throw badRequest('Choose a different size or item');
  const next = (await c.query(
    `INSERT INTO academy_kit_issues(organisation_id, enrolment_id, athlete_id, entitlement_id, item_id, venue_id, qty, status, charge_id, deposit_charge_id, client_ref, exchange_of, issued_at, issued_by, due_back_at, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9,$10,$11,now(),$12,$13,$14) RETURNING *`,
    [orgId, old.enrolment_id, old.athlete_id, old.entitlement_id, target.id, old.venue_id, old.qty, old.charge_id, old.deposit_charge_id, i.client_ref ?? null, old.id, user.id, old.due_back_at, i.reason ?? null])).rows[0];
  // lock both stock rows in a fixed order first, so two desks exchanging crosswise cannot deadlock
  await c.query('SELECT id FROM inventory_items WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[old.item_id, target.id]]);
  await drawStock(c, old.venue_id, target.id, old.qty, { reason: 'kit_exchange_out', actor: user, kitIssueId: next.id, note: i.reason ?? null });
  if (target.serialised) {
    const unit = await pickUnit(c, target, i);
    await c.query("UPDATE inventory_units SET status='issued' WHERE id=$1", [unit.id]);
    await c.query('UPDATE academy_kit_issues SET unit_id=$2 WHERE id=$1', [next.id, unit.id]);
  }
  await restoreStock(c, old.venue_id, old.item_id, old.qty, { kitIssueId: old.id, reason: 'kit_exchange_in', actor: user, note: i.reason ?? null });
  if (old.unit_id) await c.query("UPDATE inventory_units SET status='in_stock' WHERE id=$1", [old.unit_id]);
  await c.query("UPDATE academy_kit_issues SET status='exchanged', returned_at=now(), returned_by=$2, return_condition='good' WHERE id=$1", [old.id, user.id]);
  await addEvent(c, old, user.id, 'exchanged', { to_issue_id: next.id, from_size: oldItem.size_label, to_size: target.size_label, reason: i.reason ?? null });
  await addEvent(c, next, user.id, 'issued', { exchange_of: old.id });
  await audit(c, user.id, 'kit_exchange', 'academy_kit_issues', next.id);
  return issueView(c, next.id, { money: ctx.money });
}

// ------------------------------------------------------------------ damaged / lost: a request, then a manager decides
async function startWriteoff(user, ctx, iss, { kind, note, returning = false }) {
  const { c } = ctx;
  await c.query("UPDATE academy_kit_issues SET status='writeoff_pending', writeoff_kind=$2, writeoff_note=$3, writeoff_requested_by=$4::uuid, writeoff_decision=NULL, writeoff_decided_by=NULL, writeoff_decided_at=NULL, returned_at=CASE WHEN $5::boolean THEN now() END, returned_by=CASE WHEN $5::boolean THEN $4::uuid END, return_condition=CASE WHEN $5::boolean THEN 'damaged' END WHERE id=$1", [iss.id, kind, note, user.id, returning]);
  await addEvent(c, iss, user.id, 'writeoff_requested', { kind, note, returning });
  await audit(c, user.id, 'kit_writeoff_request', 'academy_kit_issues', iss.id);
  return issueView(c, iss.id, { money: ctx.money });
}

export async function requestWriteoff(user, ctx, orgId, issueId, i) {
  const iss = await lockIssue(ctx.c, orgId, issueId);
  if (iss.status !== 'issued') throw conflict(`Only kit with the athlete can be reported ${i.kind} (this is ${iss.status.replace('_', ' ')})`);
  return startWriteoff(user, ctx, iss, { kind: i.kind, note: i.note });
}

/**
 * Approve or reject a damaged/lost report. Approving takes the unit out of circulation (damaged: counted as damaged stock; lost: gone) and settles the deposit:
 * forfeit_minor (default the whole deposit) is kept, the rest is refunded. A replacement fee can be raised on the canonical charge. Rejecting a lost report puts the kit back with
 * the athlete; rejecting a damaged return puts the unit back on the shelf. The decider cannot be the reporter unless they are an owner/admin (flagged).
 */
export async function decideWriteoff(user, ctx, orgId, issueId, i) {
  const { c } = ctx;
  const iss = await lockIssue(c, orgId, issueId);
  if (iss.status !== 'writeoff_pending') throw conflict('There is nothing waiting for a decision on this kit');
  const self = iss.writeoff_requested_by === user.id;
  if (self && !ctx.admin) throw forbidden('A different manager must decide this report');
  let deposit = null, replacement = null;
  if (i.decision === 'approved') {
    if (iss.writeoff_kind === 'damaged') await c.query('UPDATE inventory_items SET damaged_qty = damaged_qty + $2 WHERE id=$1', [iss.item_id, iss.qty]);
    if (iss.unit_id) await c.query('UPDATE inventory_units SET status=$2 WHERE id=$1', [iss.unit_id, iss.writeoff_kind === 'damaged' ? 'damaged' : 'lost']);
    const dep = iss.deposit_charge_id ? Number((await c.query('SELECT amount_minor FROM academy_charges WHERE id=$1', [iss.deposit_charge_id])).rows[0].amount_minor) : 0;
    const forfeit = Math.min(dep, i.forfeit_minor ?? dep);
    deposit = await settleDeposit(c, iss, { forfeit, key: `kit-writeoff:${iss.id}` });
    if (i.replacement_minor) {
      const e = await lockEnrolment(c, orgId, iss.enrolment_id);
      const it = (await c.query('SELECT name, size_label FROM inventory_items WHERE id=$1', [iss.item_id])).rows[0];
      replacement = await raiseCharge(c, e, { kind: 'kit', amount: i.replacement_minor, label: `Replacement · ${itemLabel(it)}`, issueId: iss.id });
    }
    await c.query("UPDATE academy_kit_issues SET status='written_off', writeoff_decision='approved', writeoff_decided_by=$2, writeoff_decided_at=now(), forfeit_minor=$3, note=coalesce($4,note) WHERE id=$1", [iss.id, user.id, deposit?.forfeit_minor ?? 0, i.note ?? null]);
    await tellAthlete(c, iss.athlete_id, orgId, 'writeoff', 'Kit report decided', iss.id);
  } else {
    const returning = iss.return_condition === 'damaged';
    if (returning) {
      await putBack(c, user, iss, 'kit_return');
      deposit = await settleDeposit(c, iss, { forfeit: 0, key: `kit-return:${iss.id}` });
    }
    await c.query("UPDATE academy_kit_issues SET status=$2, writeoff_decision='rejected', writeoff_decided_by=$3, writeoff_decided_at=now(), note=coalesce($4,note), return_condition=CASE WHEN $2='returned' THEN 'worn' ELSE return_condition END WHERE id=$1", [iss.id, returning ? 'returned' : 'issued', user.id, i.note ?? null]);
  }
  await addEvent(c, iss, user.id, `writeoff_${i.decision}`, { kind: iss.writeoff_kind, self_approved: self, forfeit_minor: deposit?.forfeit_minor ?? 0, replacement_charge_id: replacement?.id ?? null, note: i.note ?? null });
  await audit(c, user.id, self ? `kit_writeoff_${i.decision}_self` : `kit_writeoff_${i.decision}`, 'academy_kit_issues', iss.id);
  return { ...(await issueView(c, iss.id, { money: ctx.money })), deposit, replacement_charge_id: replacement?.id ?? null, _provider_refund: deposit?.provider_refund ?? null };
}

// ------------------------------------------------------------------ views
const ISSUE_SQL = `SELECT i.id, i.enrolment_id, i.athlete_id, u.display_name AS athlete, i.entitlement_id, ent.name AS entitlement, i.item_id, it.name AS item, it.style_key, it.size_label, it.kit_slot, it.barcode,
    i.unit_id, un.serial_no, i.venue_id, v.name AS venue, i.qty, i.status, i.issued_at, i.due_back_at, i.returned_at, i.return_condition, i.writeoff_kind, i.writeoff_note, i.writeoff_decision, i.writeoff_decided_at,
    i.exchange_of, i.charge_id, i.deposit_charge_id, i.forfeit_minor, i.created_at, (i.status='issued' AND i.due_back_at IS NOT NULL AND i.due_back_at < now()) AS overdue,
    cu.display_name AS issued_by_name
  FROM academy_kit_issues i JOIN users u ON u.id=i.athlete_id JOIN inventory_items it ON it.id=i.item_id JOIN venues v ON v.id=i.venue_id
  LEFT JOIN academy_kit_entitlements ent ON ent.id=i.entitlement_id LEFT JOIN inventory_units un ON un.id=i.unit_id LEFT JOIN users cu ON cu.id=i.issued_by`;

/** money=false (coaches, desk viewers) removes every amount and payment status: kit requirements are visible without payment data. */
export async function chargeInfo(q, ids) {
  const rows = ids.length ? (await q.query('SELECT id, kind, amount_minor, settled_minor, adjusted_minor, currency, status, due_on FROM academy_charges WHERE id = ANY($1)', [ids])).rows : [];
  return new Map(rows.map((r) => [r.id, { id: r.id, kind: r.kind, amount_minor: Number(r.amount_minor), balance_minor: balanceOf(r), currency: r.currency, status: r.status, due_on: r.due_on }]));
}

export async function issueView(q, id, { money = false } = {}) {
  const r = (await q.query(`${ISSUE_SQL} WHERE i.id=$1`, [id])).rows[0];
  if (!r) throw notFound('Kit issue');
  return (await decorate(q, [r], { money }))[0];
}

export async function decorate(q, rows, { money = false } = {}) {
  const ch = money ? await chargeInfo(q, rows.flatMap((r) => [r.charge_id, r.deposit_charge_id]).filter(Boolean)) : new Map();
  return rows.map(({ charge_id, deposit_charge_id, forfeit_minor, ...r }) => (money ? { ...r, forfeit_minor: Number(forfeit_minor), charge: ch.get(charge_id) ?? null, deposit: ch.get(deposit_charge_id) ?? null } : r));
}

export async function listIssues(q, orgId, f, { money }) {
  const rows = (await q.query(
    `${ISSUE_SQL} WHERE i.organisation_id=$1 AND ($2::text IS NULL OR i.status=$2) AND ($3::uuid IS NULL OR i.athlete_id=$3) AND ($4::uuid IS NULL OR i.venue_id=$4)
        AND (NOT coalesce($5,false) OR (i.status='issued' AND i.due_back_at IS NOT NULL AND i.due_back_at < now())) AND ($6::text IS NULL OR u.display_name ILIKE '%'||$6||'%' OR it.name ILIKE '%'||$6||'%')
      ORDER BY (i.status='writeoff_pending') DESC, i.created_at DESC LIMIT $7 OFFSET $8`,
    [orgId, f.status ?? null, f.athlete_id ?? null, f.venue_id ?? null, f.overdue ?? null, f.q ?? null, f.limit, f.offset])).rows;
  return decorate(q, rows, { money });
}

