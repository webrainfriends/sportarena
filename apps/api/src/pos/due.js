// Settlement core of a front-desk sale. A sale owns no money: it points at the canonical invoices (court booking, goods, a collected invoice) and
// academy charges that hold it. What is still owed is always read from those records, and a sale is finished only when every one of them is paid.
// Kept free of payment-provider imports so the payments service can call it without a cycle.
import { markInvoicePaid, paidHooks } from '../booking/invoices.js';
import { activateUserPlan } from '../booking/plans.js';
import { fulfilChargePaid } from '../academy-invoices.js';

/** What the sale's records say is still unpaid, and how much of that has been received at the desk. */
export async function saleDue(c, saleId) {
  const inv = (await c.query(
    `SELECT i.id, i.total_cents - i.credits_cents AS due FROM pos_sale_invoices psi JOIN invoices i ON i.id=psi.invoice_id WHERE psi.sale_id=$1 AND i.kind='invoice' AND i.status='open'`, [saleId])).rows;
  const charges = (await c.query(
    `SELECT ch.id, ch.amount_minor - ch.settled_minor - ch.adjusted_minor - coalesce((SELECT sum(i.credits_cents) FROM invoices i WHERE i.academy_charge_id=ch.id AND i.kind='invoice' AND i.status='open'), 0) AS due
       FROM pos_sale_lines l JOIN academy_charges ch ON ch.id=l.charge_id WHERE l.sale_id=$1 AND l.kind='academy_charge' AND ch.status='awaiting_payment'`, [saleId])).rows;
  const outstanding = inv.reduce((s, r) => s + Number(r.due), 0) + charges.reduce((s, r) => s + Number(r.due), 0);
  const received = Number((await c.query("SELECT coalesce(sum(amount_cents),0) AS n FROM pos_sale_payments WHERE sale_id=$1 AND kind='payment' AND status='confirmed'", [saleId])).rows[0].n);
  return { invoices: inv, charges, outstanding, received, total: Math.max(0, outstanding - received) };
}

/** The label stored on the invoices: the one tender that paid, or 'mixed'. */
async function methodLabel(c, saleId) {
  const { rows } = await c.query("SELECT DISTINCT method FROM pos_sale_payments WHERE sale_id=$1 AND kind='payment' AND status='confirmed'", [saleId]);
  if (!rows.length) return 'other';
  if (rows.length > 1) return 'mixed';
  return { cash: 'cash', card_terminal: 'card', upi_manual: 'upi', bank_manual: 'bank', other_manual: 'other', online: 'online' }[rows[0].method] ?? 'other';
}

/** If every record of the sale is paid, the sale is paid: plans start, the sale closes. Idempotent. */
export async function finishIfSettled(c, saleId) {
  const sale = (await c.query('SELECT * FROM pos_sales WHERE id=$1 FOR UPDATE', [saleId])).rows[0];
  if (!sale || sale.status !== 'awaiting_payment') return false;
  const open = (await c.query(
    `SELECT (SELECT count(*) FROM pos_sale_invoices psi JOIN invoices i ON i.id=psi.invoice_id WHERE psi.sale_id=$1 AND i.kind='invoice' AND i.status='open')
          + (SELECT count(*) FROM pos_sale_lines l JOIN academy_charges ch ON ch.id=l.charge_id WHERE l.sale_id=$1 AND l.kind='academy_charge' AND ch.status='awaiting_payment') AS n`, [saleId])).rows[0].n;
  if (Number(open) > 0) return false;
  for (const { user_plan_id } of (await c.query("SELECT DISTINCT user_plan_id FROM pos_sale_lines WHERE sale_id=$1 AND user_plan_id IS NOT NULL", [saleId])).rows) await activateUserPlan(c, user_plan_id);
  await c.query("UPDATE pos_sales SET status='paid', paid_at=now() WHERE id=$1", [saleId]);
  // equipment that was held for this sale is now the customer's to collect (handing it over is a separate, recorded step)
  return true;
}

/** Settle the sale if what has been received covers what is owed. Marks every record paid in one transaction. */
export async function applyIfCovered(c, saleId, { by } = {}) {
  const sale = (await c.query('SELECT * FROM pos_sales WHERE id=$1 FOR UPDATE', [saleId])).rows[0];
  if (!sale || sale.status !== 'awaiting_payment') return false;
  const due = await saleDue(c, saleId);
  if (due.total > 0) return false;
  const method = await methodLabel(c, saleId);
  for (const i of due.invoices) await markInvoicePaid(c, i.id, { method, by });
  for (const ch of due.charges) await fulfilChargePaid(c, ch.id, { method });
  return finishIfSettled(c, saleId);
}

/** Provider says the sale's online payment is paid. False = it can no longer be applied (sale void / already covered): the caller refunds it. */
export async function confirmOnlineSalePayment(c, saleId, payment) {
  const sale = (await c.query('SELECT * FROM pos_sales WHERE id=$1 FOR UPDATE', [saleId])).rows[0];
  if (!sale || sale.status !== 'awaiting_payment') return false;
  const due = await saleDue(c, saleId);
  if (Number(payment.amount_cents) > due.total) return false;   // cash arrived meanwhile: never take more than is owed
  const upd = await c.query("UPDATE pos_sale_payments SET status='confirmed', confirmed_at=now() WHERE payment_id=$1 AND kind='payment' AND status IN ('pending','failed') RETURNING id", [payment.id]);
  if (!upd.rowCount) {
    await c.query("INSERT INTO pos_sale_payments(sale_id, shift_id, method, status, amount_cents, payment_id, recorded_by, confirmed_at) VALUES ($1,NULL,'online','confirmed',$2,$3,$4,now())", [saleId, payment.amount_cents, payment.id, sale.cashier_id]);
  }
  await applyIfCovered(c, saleId, { by: sale.cashier_id });
  return true;
}

// Whatever pays one of the sale's invoices (the desk, a customer using points / wallet / a pass, a venue override) can be the payment that finishes the sale.
paidHooks.push(async (c, inv) => {
  const { rows } = await c.query('SELECT sale_id FROM pos_sale_invoices WHERE invoice_id=$1', [inv.id]);
  for (const r of rows) await finishIfSettled(c, r.sale_id);
});

/** The front-desk sale a credit note belongs to: its own (goods) or the sale that held the booking it credits. */
export const saleOfCreditNote = async (q, cn) => (await q(
  'SELECT s.id FROM pos_sales s WHERE s.id=$1 OR (s.reservation_id IS NOT NULL AND s.reservation_id=$2 AND s.venue_id=$3) LIMIT 1', [cn.pos_sale_id ?? null, cn.reservation_id ?? null, cn.venue_id])).rows[0]?.id ?? null;
