// Supplier-services background work. Every step is idempotent (status guards and notification dedupe keys), so a retried or concurrent run cannot double up.
import { tx } from '../db.js';
import { notify } from '../notify.js';
import { supplierAudience, buyerAudience } from '../capabilities/svc-rfq.js';

/** Quotes past their validity become expired (the supplier is told once); RFQs whose quote deadline passed with nothing to evaluate stay open for the buyer to close. */
export async function expireQuotes() {
  return tx(async (c) => {
    const due = (await c.query("UPDATE svc_quotes SET status='expired' WHERE status IN ('submitted','shortlisted') AND valid_until < now() RETURNING id, profile_id, rfq_id")).rows;
    for (const q of due) for (const u of await supplierAudience(c, q.profile_id)) await notify(c, u, { kind: 'svc_quote_expired', title: 'A quote expired', body: 'One of your quotes passed its validity date. Open Gotmygame to submit a new version.', data: { rfq_id: q.rfq_id }, dedupe_key: `svc:qexp:${q.id}:${u}` });
    return due.length;
  });
}
/** Tomorrow's visits: a reminder to the supplier's scheduler/owner and the buyer's acceptors. No crew names, minors or amounts in the text. */
export async function remindVisits() {
  return tx(async (c) => {
    const due = (await c.query("SELECT v.id, v.starts_at, o.id AS order_id, o.profile_id, o.buyer_id, o.number FROM svc_visits v JOIN svc_orders o ON o.id=v.order_id WHERE v.status IN ('planned','confirmed','scheduled') AND o.status IN ('confirmed','in_progress') AND v.starts_at >= now() + interval '12 hours' AND v.starts_at < now() + interval '36 hours' LIMIT 500")).rows;
    for (const v of due) {
      const users = [...await supplierAudience(c, v.profile_id), ...await buyerAudience(c, v.buyer_id, ['acceptor'])];
      for (const u of new Set(users)) await notify(c, u, { kind: 'svc_visit_reminder', title: 'A service visit is coming up', body: `Order ${v.number} has a visit tomorrow.`, data: { order_id: v.order_id, visit_id: v.id }, dedupe_key: `svc:remind:${v.id}:${u}` });
    }
    return due.length;
  });
}
/** Overdue invoices: tell the buyer's finance team once per invoice and due date. */
export async function remindOverdueInvoices() {
  return tx(async (c) => {
    const due = (await c.query("SELECT s.id, s.buyer_id, s.supplier_number, coalesce(s.due_on, s.issued_at::date) AS due FROM svc_invoices s WHERE s.status='issued' AND s.doc_type='invoice' AND s.payable_minor - s.credited_minor - s.paid_minor > 0 AND coalesce(s.due_on, s.issued_at::date + 30) < current_date LIMIT 500")).rows;
    for (const i of due) for (const u of await buyerAudience(c, i.buyer_id, ['finance'])) await notify(c, u, { kind: 'svc_invoice_overdue', title: 'An invoice is overdue', body: `Invoice ${i.supplier_number} is past its due date.`, data: { svc_invoice_id: i.id }, dedupe_key: `svc:overdue:${i.id}:${u}` });
    return due.length;
  });
}
export const runServiceSweeps = async () => ({ quotes_expired: await expireQuotes(), visit_reminders: await remindVisits(), overdue_notices: await remindOverdueInvoices() });
