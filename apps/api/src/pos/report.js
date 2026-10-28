// Front-desk reporting. Every figure is read from the canonical records (invoices, credit notes, payments, stock) and the sale lines that point at them;
// the report also shows its own reconciliation, so a total that has drifted from the invoices is visible rather than hidden.
import { many, one } from '../db.js';
import { mustBeManager } from './access.js';

export async function posReport(user, { venue_id, from, to, shift_id }) {
  await mustBeManager(user, venue_id);
  const p = [venue_id, from ?? null, to ?? null, shift_id ?? null];
  const scope = `s.venue_id=$1 AND ($2::timestamptz IS NULL OR s.created_at >= $2) AND ($3::timestamptz IS NULL OR s.created_at < $3) AND ($4::uuid IS NULL OR s.shift_id=$4)`;
  const venue = await one('SELECT currency, tax_name FROM venues WHERE id=$1', [venue_id]);
  const counts = await one(`SELECT count(*) FILTER (WHERE s.status='paid')::int AS sales, count(*) FILTER (WHERE s.status='awaiting_payment')::int AS awaiting, count(*) FILTER (WHERE s.status='void')::int AS voided,
      count(*) FILTER (WHERE s.status='paid' AND s.discount_approved_by IS NOT NULL)::int AS approved_discounts FROM pos_sales s WHERE ${scope}`, p);
  // money figures are summed from the sale lines of paid sales - the same lines the invoices were issued from - and proven against the invoices below
  const sums = await one(`SELECT coalesce(sum(l.unit_price_cents * l.qty),0)::bigint AS gross_cents, coalesce(sum(l.discount_cents),0)::bigint AS discount_cents, coalesce(sum(l.tax_cents),0)::bigint AS tax_cents, coalesce(sum(l.total_cents),0)::bigint AS sales_cents
      FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id WHERE s.status='paid' AND ${scope}`, p);
  const totals = { ...counts, ...sums };
  const refunds = await one(
    `SELECT coalesce(sum(i.total_cents),0)::bigint AS refunded_cents, coalesce(sum(i.tax_cents),0)::bigint AS refunded_tax_cents, count(*)::int AS credit_notes
       FROM invoices i JOIN pos_sales s ON s.id = coalesce(i.pos_sale_id, (SELECT x.id FROM pos_sales x WHERE x.reservation_id=i.reservation_id AND x.venue_id=i.venue_id LIMIT 1))
      WHERE i.kind='credit_note' AND ${scope}`, p);
  const byCategory = await many(
    `SELECT l.category, sum(l.qty)::int AS qty, sum(l.total_cents)::bigint AS total_cents, sum(l.tax_cents)::bigint AS tax_cents, sum(l.discount_cents)::bigint AS discount_cents, sum(l.returned_qty)::int AS returned_qty,
            sum(((l.total_cents - l.tax_cents) * (l.qty - l.returned_qty) / l.qty) - l.unit_cost_cents * (l.qty - l.returned_qty)) FILTER (WHERE l.unit_cost_cents IS NOT NULL AND l.unit_cost_cents > 0)::bigint AS margin_cents,
            count(*) FILTER (WHERE l.unit_cost_cents IS NOT NULL AND l.unit_cost_cents > 0)::int AS lines_with_cost, count(*)::int AS lines
       FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id WHERE s.status='paid' AND ${scope} GROUP BY l.category ORDER BY sum(l.total_cents) DESC`, p);
  const byMethod = await many(
    `SELECT pp.method, coalesce(sum(pp.amount_cents) FILTER (WHERE pp.kind='payment'),0)::bigint AS taken_cents, coalesce(sum(pp.amount_cents) FILTER (WHERE pp.kind='refund'),0)::bigint AS returned_cents,
            count(*) FILTER (WHERE pp.kind='payment')::int AS payments
       FROM pos_sale_payments pp JOIN pos_sales s ON s.id=pp.sale_id WHERE pp.status='confirmed' AND ${scope} GROUP BY pp.method ORDER BY 2 DESC`, p);
  const byStaff = await many(
    `SELECT u.id, u.display_name AS cashier, count(*)::int AS sales, sum(s.total_cents)::bigint AS total_cents, coalesce(sum(s.discount_cents),0)::bigint AS discount_cents
       FROM pos_sales s JOIN users u ON u.id=s.cashier_id WHERE s.status='paid' AND ${scope} GROUP BY u.id, u.display_name ORDER BY 4 DESC`, p);
  const byShift = await many(
    `SELECT sh.id, sh.opened_at, sh.closed_at, sh.status, sh.expected_cash_cents, sh.counted_cash_cents, sh.variance_cents, sh.review_status, count(s.id)::int AS sales, coalesce(sum(s.total_cents),0)::bigint AS total_cents
       FROM pos_shifts sh LEFT JOIN pos_sales s ON s.shift_id=sh.id AND s.status='paid' WHERE sh.venue_id=$1 AND ($4::uuid IS NULL OR sh.id=$4)
        AND ($2::timestamptz IS NULL OR sh.opened_at >= $2) AND ($3::timestamptz IS NULL OR sh.opened_at < $3) GROUP BY sh.id ORDER BY sh.opened_at DESC LIMIT 100`, p);
  // reconciliation: what the sales say was owed, against the money confirmed at the desk plus credit applied to the invoices
  const rec = await one(
    `SELECT coalesce((SELECT sum(l.total_cents) FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id WHERE s.status='paid' AND ${scope}),0)::bigint AS owed_cents,
            coalesce((SELECT sum(pp.amount_cents) FROM pos_sale_payments pp JOIN pos_sales s ON s.id=pp.sale_id WHERE s.status='paid' AND pp.kind='payment' AND pp.status='confirmed' AND ${scope}),0)::bigint AS received_cents,
            coalesce((SELECT sum(ic.amount_cents) FROM invoice_credits ic JOIN pos_sale_invoices psi ON psi.invoice_id=ic.invoice_id JOIN pos_sales s ON s.id=psi.sale_id WHERE s.status='paid' AND ${scope}),0)::bigint AS credits_cents,
            coalesce((SELECT sum(l.total_cents) FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id WHERE s.status='paid' AND l.kind IN ('item','rental','deposit','plan','booking') AND ${scope}),0)::bigint AS billed_cents,
            coalesce((SELECT sum(i.total_cents) FROM invoices i JOIN pos_sale_invoices psi ON psi.invoice_id=i.id JOIN pos_sales s ON s.id=psi.sale_id WHERE s.status='paid' AND i.kind='invoice' AND i.status='paid' AND psi.role <> 'collected' AND ${scope}),0)::bigint AS invoiced_cents`, p);
  const open = await one(
    `SELECT (SELECT count(*) FROM pos_sale_payments pp JOIN pos_sales s ON s.id=pp.sale_id WHERE pp.method='online' AND pp.status='pending' AND ${scope})::int AS online_pending,
            (SELECT count(*) FROM pos_shifts WHERE venue_id=$1 AND review_status='pending')::int AS variances_to_review,
            (SELECT count(*) FROM invoices i WHERE i.venue_id=$1 AND i.kind='credit_note' AND i.refund_status IN ('manual','failed') AND (i.pos_sale_id IS NOT NULL OR i.reservation_id IN (SELECT reservation_id FROM pos_sales WHERE venue_id=$1 AND reservation_id IS NOT NULL)))::int AS refunds_for_desk,
            (SELECT count(*) FROM pos_rentals WHERE venue_id=$1 AND status='issued' AND due_at < now())::int AS rentals_overdue`, p);
  const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v]));
  const diff = Number(rec.owed_cents) - Number(rec.received_cents) - Number(rec.credits_cents);
  const invDiff = Number(rec.billed_cents) - Number(rec.invoiced_cents);
  return {
    currency: venue.currency, period: { from: from ?? null, to: to ?? null, shift_id: shift_id ?? null },
    totals: num(totals), refunds: num(refunds), net_cents: Number(totals.sales_cents) - Number(refunds.refunded_cents),
    by_category: byCategory.map(num), by_method: byMethod.map(num), by_staff: byStaff.map(num), by_shift: byShift.map(num),
    open_items: open,
    reconciliation: { ...num(rec), difference_cents: diff, invoice_difference_cents: invDiff, reconciled: diff === 0 && invDiff === 0, note: 'owed = sale lines of paid sales; received = confirmed payments; credits = wallet / points / pass applied to the same invoices; invoiced = what the numbered invoices say. A non-zero difference means a record has drifted and needs a look.' },
  };
}
