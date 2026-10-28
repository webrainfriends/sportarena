// One commitment, one payment: an event-linked order owns exactly one event budget line (reusing the budget line of a linked supplier event request),
// and every recorded payment mirrors to exactly one budget payment. Nothing here is counted again through finance.
import { finalizeRequest } from '../event-planning.js';

const BUDGET_CATEGORY = { ground_maintenance: 'venue', pitch_maintenance: 'venue', pool_maintenance: 'venue', cleaning: 'venue', event_crew: 'staff', security: 'staff', electrical: 'equipment', wifi: 'equipment', equipment_rental: 'equipment', travel: 'transport', logistics: 'transport', accommodation: 'other', catering: 'catering' };
const catOf = (o) => BUDGET_CATEGORY[o.category] ?? 'other';
/** What an order commits on the event budget: its gross by default; a tender priced on a net basis commits its net award (terms.commit_basis). */
export const committedOf = (order) => Number(order.terms?.commit_basis === 'net' ? order.net_minor : order.gross_minor);

/** Commit the order on the event budget (event currency only; other currencies are never converted silently). Returns the line or null. */
export async function commitOrder(c, order, actor, { budgetCategory = null, currencyChecked = false } = {}) {
  if (!order.event_id) return null;
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [order.event_id])).rows[0];
  if (!ev || (!currencyChecked && (ev.currency ?? 'INR') !== order.currency)) return null;
  const cat = (await c.query("SELECT scope->>'category' AS category, event_request_id FROM svc_rfqs WHERE id=$1", [order.rfq_id])).rows[0] ?? {};
  const committed = committedOf(order);
  let line = (await c.query("SELECT * FROM event_budget_lines WHERE svc_order_id=$1 AND status <> 'void' FOR UPDATE", [order.id])).rows[0];
  if (line) {
    line = (await c.query("UPDATE event_budget_lines SET committed_cents=$2, planned_cents=greatest(planned_cents,$2), status='committed' WHERE id=$1 RETURNING *", [line.id, committed])).rows[0];
  } else if (cat.event_request_id) {
    const r = (await c.query('SELECT * FROM event_requests WHERE id=$1 FOR UPDATE', [cat.event_request_id])).rows[0];
    if (r && r.status !== 'finalized') await finalizeRequest(c, ev, r, actor, { price: committed });
    line = (await c.query("SELECT * FROM event_budget_lines WHERE request_id=$1 AND status <> 'void' FOR UPDATE", [cat.event_request_id])).rows[0];
    if (line) line = (await c.query("UPDATE event_budget_lines SET svc_order_id=$2, committed_cents=$3, planned_cents=greatest(planned_cents,$3), status='committed' WHERE id=$1 RETURNING *", [line.id, order.id, committed])).rows[0];
  }
  if (!line) {
    line = (await c.query("INSERT INTO event_budget_lines(event_id, direction, category, name, planned_cents, committed_cents, status, svc_order_id, created_by) VALUES ($1,'expense',$2,$3,$4,$4,'committed',$5,$6) RETURNING *",
      [ev.id, budgetCategory ?? catOf(cat), `${order.number} — service order`.slice(0, 120), committed, order.id, actor.id])).rows[0];
  }
  await c.query('UPDATE svc_orders SET budget_line_id=$2 WHERE id=$1', [order.id, line.id]);
  return line;
}
/** Re-point the committed amount after a variation / termination (never below what was already paid). */
export async function recommit(c, order, committedMinor) {
  const line = (await c.query("SELECT * FROM event_budget_lines WHERE svc_order_id=$1 AND status <> 'void' FOR UPDATE", [order.id])).rows[0];
  if (!line) return null;
  return (await c.query("UPDATE event_budget_lines SET committed_cents=$2, planned_cents=greatest(planned_cents,$2) WHERE id=$1 RETURNING *", [line.id, committedMinor])).rows[0];
}
export async function voidCommitment(c, order) {
  await c.query("UPDATE event_budget_lines SET status='void' WHERE svc_order_id=$1 AND status <> 'void' AND request_id IS NULL", [order.id]);
  await c.query("UPDATE event_budget_lines SET committed_cents=0 WHERE svc_order_id=$1 AND request_id IS NOT NULL", [order.id]);
}
/** Mirror a recorded payment onto the budget, once. Void mirrors the void. */
export async function mirrorPayment(c, order, pay, actor) {
  const line = (await c.query("SELECT * FROM event_budget_lines WHERE svc_order_id=$1 AND status <> 'void'", [order.id])).rows[0];
  if (!line) return null;
  return (await c.query(
    `INSERT INTO event_budget_payments(event_id, line_id, amount_cents, paid_on, method, reference, note, recorded_by, svc_payment_id)
     VALUES ($1,$2,$3,$4,$5,$6,'Service order payment',$7,$8) ON CONFLICT (svc_payment_id) WHERE svc_payment_id IS NOT NULL DO NOTHING RETURNING *`,
    [line.event_id, line.id, pay.amount_minor, pay.paid_on, pay.source === 'manual_cash' ? 'cash' : pay.source === 'provider' ? 'card' : 'bank', pay.reference ?? null, actor.id, pay.id])).rows[0] ?? null;
}
export const unmirrorPayment = (c, payId, actor, reason) => c.query('UPDATE event_budget_payments SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE svc_payment_id=$1 AND voided_at IS NULL', [payId, actor.id, reason]);
