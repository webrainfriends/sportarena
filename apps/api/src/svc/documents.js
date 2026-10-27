// Source-authoritative snapshots for every supplier-services document. Each loader checks access live (also on every download), reads figures from the
// canonical records and returns a plain structure for documents/service-render.js. Nothing here changes, pays, signs or sends anything.
import { many, one, pool } from '../db.js';
import { notFound } from '../errors.js';
import { fmt } from './money.js';
import { supplierDashboard, buyerDashboard, exportRows } from './reports.js';
import { supplierAccess, buyerAccess } from './access.js';
import { isYouth } from '../youth.js';

const fm = (m, cur) => `${cur} ${fmt(Number(m), cur)}`;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const dt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');
const R = { a: 'right' };
const supplierLines = (p) => [p.legal_name, p.trading_name && p.trading_name !== p.legal_name ? `t/a ${p.trading_name}` : null, p.billing_address, p.tax_registration && `Tax ID: ${p.tax_registration}`];
const either = async (user, o) => {
  let ok = null;
  try { ok = { side: 'supplier', acc: await supplierAccess(user, o.profile_id, null, pool) }; } catch { /* maybe buyer */ }
  if (!ok) { try { ok = { side: 'buyer', acc: await buyerAccess(user, o.buyer_id, null, pool) }; } catch { /* no */ } }
  if (!ok) throw notFound('Document');
  return ok;
};
const orderCtx = async (id) => {
  const o = await one('SELECT * FROM svc_orders WHERE id=$1', [id]);
  if (!o) throw notFound('Document');
  const [p, b, lines, rfq] = await Promise.all([one('SELECT * FROM svc_profiles WHERE id=$1', [o.profile_id]), one('SELECT * FROM svc_buyers WHERE id=$1', [o.buyer_id]), many('SELECT * FROM svc_order_lines WHERE order_id=$1 ORDER BY line_no', [o.id]), o.rfq_id ? one('SELECT title, scope FROM svc_rfqs WHERE id=$1', [o.rfq_id]) : null]);
  return { o, p, b, lines, rfq };
};
const orderRows = (lines, cur) => lines.map((l) => [String(l.line_no), `${l.description}${l.milestone ? ` [${l.milestone}]` : ''}`, `${Number(l.qty_ordered)} ${l.unit}`, fm(l.rate_minor, cur), `${Number(l.qty_accepted)}`, `${Number(l.qty_invoiced)}`]);
const ORDER_COLS = [{ t: '#', w: 4 }, { t: 'Description', w: 38 }, { t: 'Ordered', w: 14 }, { t: 'Rate', w: 16, a: 'right' }, { t: 'Accepted', w: 11, a: 'right' }, { t: 'Invoiced', w: 11, a: 'right' }];
const scopeKv = (s) => [['Category', s.category], ['Quantity', `${s.quantity} ${s.unit}`], ['Starts', dt(s.starts_at)], ['Ends', dt(s.ends_at)], ['Headcount', s.headcount ?? ''], ['Site access', s.site_access ?? ''], ...Object.entries(s.scope ?? {}).map(([k, v]) => [k.replace(/_/g, ' '), Array.isArray(v) ? v.join(', ') : String(v)]), ...(s.acceptance_criteria?.length ? [['Acceptance criteria', s.acceptance_criteria.join('; ')]] : [])].filter(([, v]) => v !== '' && v != null);

export const LOADERS = {
  async rfq(user, id) {
    const r = await one('SELECT r.*, b.name AS buyer_name FROM svc_rfqs r JOIN svc_buyers b ON b.id=r.buyer_id WHERE r.id=$1', [id]);
    if (!r) throw notFound('Document');
    let ok = false;
    try { await buyerAccess(user, r.buyer_id, null, pool); ok = true; } catch { /* maybe invited */ }
    if (!ok) { const ids = (await many("SELECT profile_id FROM svc_invites WHERE rfq_id=$1", [r.id])).map((x) => x.profile_id); let inv = false; for (const pid of ids) { try { await supplierAccess(user, pid, null, pool); inv = true; break; } catch { /* next */ } } if (!inv || r.status === 'draft') throw notFound('Document'); }
    const clar = await many('SELECT body, author_side, created_at FROM svc_clarifications WHERE rfq_id=$1 AND shared ORDER BY created_at', [r.id]);
    return { type: 'rfq', version: r.scope_version, doc: { title: 'Request for quotation', number: r.title, status: `${r.status} · scope v${r.scope_version}`, watermark: r.status === 'draft' ? 'DRAFT' : null, parties: [{ label: 'Buyer', lines: [r.buyer_name] }],
      sections: [{ heading: 'Scope', kind: 'kv', rows: scopeKv(r.scope) }, { heading: 'Deadlines', kind: 'kv', rows: [['Invitations', dt(r.invite_deadline)], ['Questions', dt(r.question_deadline)], ['Quotes', dt(r.quote_deadline)], ['Currency', r.currency]].filter(([, v]) => v) },
        ...(r.rubric?.length ? [{ heading: 'Evaluation rubric', kind: 'table', columns: [{ t: 'Criterion', w: 4 }, { t: 'Weight', w: 1, a: 'right' }], rows: r.rubric.map((x) => [x.label, `${x.weight}`]) }] : []),
        ...(clar.length ? [{ heading: 'Clarifications (shared with all suppliers)', kind: 'table', columns: [{ t: 'From', w: 1 }, { t: 'Text', w: 5 }], rows: clar.map((x) => [x.author_side, x.body]) }] : [])] } };
  },
  async comparison(user, id) {
    const r = await one('SELECT r.*, b.name AS buyer_name FROM svc_rfqs r JOIN svc_buyers b ON b.id=r.buyer_id WHERE r.id=$1', [id]);
    if (!r) throw notFound('Document');
    await buyerAccess(user, r.buyer_id, ['evaluator', 'requester', 'purchaser', 'approver'], pool);
    const qs = await many(`SELECT DISTINCT ON (q.profile_id) q.*, coalesce(p.trading_name, p.legal_name) AS supplier FROM svc_quotes q JOIN svc_profiles p ON p.id=q.profile_id WHERE q.rfq_id=$1 AND q.status <> 'draft' ORDER BY q.profile_id, q.version DESC`, [r.id]);
    const ev = await many('SELECT quote_id, avg(total)::float AS score FROM svc_evaluations WHERE rfq_id=$1 GROUP BY quote_id', [r.id]);
    const ord = await many("SELECT q.id, o.number FROM svc_orders o JOIN svc_quotes q ON q.id=o.quote_id WHERE o.rfq_id=$1 AND o.status NOT IN ('cancelled','rejected','terminated')", [r.id]);
    return { type: 'comparison', version: r.scope_version, doc: { title: 'Quote comparison & award summary', number: r.title, status: r.status, parties: [{ label: 'Buyer', lines: [r.buyer_name] }],
      sections: [{ heading: 'Quotes (each currency shown as quoted; never added together)', kind: 'table', columns: [{ t: 'Supplier', w: 20 }, { t: 'v', w: 3 }, { t: 'Net', w: 14, a: 'right' }, { t: 'Tax', w: 12, a: 'right' }, { t: 'Gross', w: 14, a: 'right' }, { t: 'Status', w: 12 }, { t: 'Score', w: 8, a: 'right' }, { t: 'Order', w: 14 }],
        rows: qs.map((q) => [q.supplier, String(q.version), fm(q.net_minor, q.currency), fm(q.tax_minor, q.currency), fm(q.gross_minor, q.currency), q.status, ev.find((e) => e.quote_id === q.id)?.score?.toFixed(1) ?? '—', ord.find((o) => o.id === q.id)?.number ?? '']) }] } };
  },
  async quote(user, id) {
    const q = await one('SELECT q.*, r.title, r.buyer_id FROM svc_quotes q JOIN svc_rfqs r ON r.id=q.rfq_id WHERE q.id=$1', [id]);
    if (!q) throw notFound('Document');
    let ok = false;
    try { await supplierAccess(user, q.profile_id, null, pool); ok = true; } catch { /* buyer? */ }
    if (!ok) { await buyerAccess(user, q.buyer_id, ['requester', 'evaluator', 'purchaser', 'approver'], pool); if (q.status === 'draft') throw notFound('Document'); }
    const [p, lines] = await Promise.all([one('SELECT * FROM svc_profiles WHERE id=$1', [q.profile_id]), many('SELECT * FROM svc_quote_lines WHERE quote_id=$1 ORDER BY line_no', [q.id])]);
    return { type: 'quote', version: q.version, doc: { title: 'Quotation', number: `${q.title} · v${q.version}`, status: `${q.status} · valid until ${day(q.valid_until)}`, watermark: q.status === 'draft' ? 'DRAFT' : null, parties: [{ label: 'Supplier', lines: supplierLines(p) }],
      sections: [{ heading: 'Lines', kind: 'table', columns: [{ t: '#', w: 3 }, { t: 'Description', w: 30 }, { t: 'Qty', w: 11 }, { t: 'Rate', w: 13, a: 'right' }, { t: 'Net', w: 13, a: 'right' }, { t: 'Tax', w: 11, a: 'right' }, { t: 'Gross', w: 13, a: 'right' }], rows: lines.map((l) => [String(l.line_no), `${l.description}${l.milestone ? ` [${l.milestone}]` : ''}`, `${Number(l.quantity)} ${l.unit}`, fm(l.rate_minor, q.currency), fm(l.net_minor, q.currency), fm(l.tax_minor, q.currency), fm(l.gross_minor, q.currency)]) },
        { heading: 'Terms', kind: 'kv', rows: Object.entries(q.terms).filter(([k, v]) => v != null && k !== 'covers_quantity' && k !== 'decision_reason').map(([k, v]) => [k.replace(/_/g, ' '), Array.isArray(v) ? v.join('; ') : String(v)]) }],
      totals: [['Net', fm(q.net_minor, q.currency)], ['Tax', fm(q.tax_minor, q.currency)], ['Total', fm(q.gross_minor, q.currency), true]], footnote: q.prices_include_tax ? 'Prices include tax.' : 'Prices exclude tax.' } };
  },
  async service_order(user, id) {
    const { o, p, b, lines, rfq } = await orderCtx(id); await either(user, o);
    return { type: 'service_order', version: o.row_version, doc: { title: 'Purchase / service order', number: o.number, status: `${o.status} · fulfilment ${o.fulfilment} · billing ${o.billing} · settlement ${o.settlement}`, watermark: ['pending_supplier', 'changes_proposed'].includes(o.status) ? 'UNCONFIRMED' : null,
      parties: [{ label: 'Supplier', lines: supplierLines(p) }, { label: 'Buyer', lines: [b.name] }],
      sections: [{ heading: `Order for: ${rfq?.title ?? ''}`, kind: 'table', columns: ORDER_COLS, rows: orderRows(lines, o.currency) }, ...(o.terms?.cancellation ? [{ heading: 'Cancellation', kind: 'text', text: o.terms.cancellation }] : [])],
      totals: [['Net', fm(o.net_minor, o.currency)], ['Tax', fm(o.tax_minor, o.currency)], ['Total', fm(o.gross_minor, o.currency), true]], footnote: 'Quote version and scope version are bound to this order.' } };
  },
  async agreement(user, id) {
    const { o, p, b, lines, rfq } = await orderCtx(id); await either(user, o);
    const acts = await many("SELECT action, created_at, detail FROM svc_activity WHERE entity='order' AND entity_id=$1 AND action LIKE 'agreement_ack_%' ORDER BY id", [o.id]);
    return { type: 'agreement', version: o.row_version, doc: { title: 'Service agreement / statement of work', number: o.number, status: `agreement: ${o.agreement_status.replace(/_/g, ' ')}`, watermark: o.agreement_status === 'fully_signed' ? null : 'NOT FULLY AGREED',
      parties: [{ label: 'Supplier', lines: supplierLines(p) }, { label: 'Buyer', lines: [b.name] }],
      sections: [{ heading: 'Scope of work', kind: 'kv', rows: scopeKv(rfq?.scope ?? {}) }, { heading: 'Deliverables and price', kind: 'table', columns: ORDER_COLS, rows: orderRows(lines, o.currency) }, { heading: 'Terms', kind: 'kv', rows: Object.entries(o.terms ?? {}).filter(([k, v]) => v != null && !['covers_quantity', 'justification'].includes(k) && typeof v !== 'object').map(([k, v]) => [k.replace(/_/g, ' '), String(v)]) },
        { heading: 'Acknowledgements', kind: 'table', columns: [{ t: 'Side', w: 2 }, { t: 'Typed name', w: 4 }, { t: 'When', w: 4 }], rows: acts.map((a) => [a.action.replace('agreement_ack_', ''), a.detail.typed_name, dt(a.created_at)]) }],
      footnote: 'Acknowledgements are recorded by signed-in users. They are not qualified electronic signatures, and an uploaded signature image is not treated as one.' } };
  },
  async job_sheet(user, id) {
    const v = await one('SELECT v.*, o.number, o.profile_id, o.buyer_id, o.currency FROM svc_visits v JOIN svc_orders o ON o.id=v.order_id WHERE v.id=$1', [id]);
    if (!v) throw notFound('Document');
    const { side } = await either(user, v);
    const names = side === 'supplier' ? (await many('SELECT display_name FROM users WHERE id = ANY($1)', [v.assignees])).map((x) => x.display_name) : [`${v.assignees.length} crew assigned`];
    return { type: 'job_sheet', version: v.row_version, doc: { title: 'Work order / job sheet', number: `${v.number} · ${day(v.starts_at)}`, status: v.status, parties: [], sections: [
      { kind: 'kv', rows: [['Site', v.site_label ?? ''], ['Resource', v.resource_key ?? ''], ['Starts', dt(v.starts_at)], ['Ends', dt(v.ends_at)], ['Planned quantity', `${Number(v.planned_qty)}`], ['Actual quantity', v.actual_qty == null ? '' : `${Number(v.actual_qty)}`], ['Crew', names.join(', ')]].filter(([, x]) => x !== '') },
      { heading: 'Checklist', kind: 'table', columns: [{ t: 'Task', w: 8 }, { t: 'Done', w: 1 }], rows: (v.checklist ?? []).map((x) => [x.task, x.done ? 'yes' : 'no']) },
      ...(v.readings?.length ? [{ heading: 'Recorded readings (evidence only — not a certification)', kind: 'table', columns: [{ t: 'Reading', w: 5 }, { t: 'Value', w: 2, a: 'right' }], rows: v.readings.map((x) => [x.name, `${x.value} ${x.unit}`]) }] : [])] } };
  },
  async timesheet(user, id) {
    const v = await one('SELECT v.*, o.number, o.profile_id, o.buyer_id FROM svc_visits v JOIN svc_orders o ON o.id=v.order_id WHERE v.id=$1', [id]);
    if (!v) throw notFound('Document');
    const { side } = await either(user, v);
    const rows = await many('SELECT a.*, u.display_name FROM svc_attendance a LEFT JOIN users u ON u.id=a.user_id WHERE a.visit_id=$1 ORDER BY a.created_at', [v.id]);
    const out = [];
    for (const a of rows) { const minor = a.user_id ? await isYouth(a.user_id) : false; out.push([side === 'buyer' && minor ? 'Crew member (under 18)' : (a.display_name ?? a.name ?? ''), a.status, dt(a.checked_in_at), dt(a.checked_out_at), a.hours == null ? '' : `${Number(a.hours)}`]); }
    return { type: 'timesheet', version: v.row_version, doc: { title: 'Attendance & timesheet', number: `${v.number} · ${day(v.starts_at)}`, status: v.status, parties: [], sections: [{ kind: 'table', columns: [{ t: 'Person', w: 8 }, { t: 'Status', w: 4 }, { t: 'In', w: 6 }, { t: 'Out', w: 6 }, { t: 'Hours', w: 3, a: 'right' }], rows: out }] } };
  },
  async service_receipt(user, id) {
    const { o, p, b, lines } = await orderCtx(id); await either(user, o);
    const acc = await many('SELECT a.*, l.line_no, l.description FROM svc_acceptances a JOIN svc_order_lines l ON l.id=a.line_id WHERE a.order_id=$1 ORDER BY a.created_at', [o.id]);
    return { type: 'service_receipt', version: acc.length, doc: { title: 'Delivery / service receipt', number: o.number, status: `${acc.filter((x) => x.decision === 'accepted').length} accepted · ${acc.filter((x) => x.decision === 'rejected').length} rejected`, parties: [{ label: 'Supplier', lines: supplierLines(p) }, { label: 'Buyer', lines: [b.name] }],
      sections: [{ heading: 'Acceptance decisions', kind: 'table', columns: [{ t: 'When', w: 6 }, { t: 'Line', w: 10 }, { t: 'Decision', w: 5 }, { t: 'Qty', w: 3, a: 'right' }, { t: 'Reason / rework due', w: 10 }], rows: acc.map((a) => [dt(a.created_at), `${a.line_no} ${a.description}`, a.decision, `${Number(a.quantity)}`, [a.reason, a.rework_due && `rework by ${day(a.rework_due)}`].filter(Boolean).join(' · ')]) },
        { heading: 'Totals by line', kind: 'table', columns: ORDER_COLS, rows: orderRows(lines, o.currency) }] } };
  },
  async completion_report(user, id) {
    const { o, p, b, lines, rfq } = await orderCtx(id); await either(user, o);
    const [visits, inc] = await Promise.all([many("SELECT status, count(*)::int AS n FROM svc_visits WHERE order_id=$1 GROUP BY status", [o.id]), many('SELECT kind, detail, created_at FROM svc_incidents WHERE order_id=$1 ORDER BY created_at', [o.id])]);
    return { type: 'completion_report', version: o.row_version, doc: { title: 'Completion report', number: o.number, status: `${o.status} · fulfilment ${o.fulfilment}`, parties: [{ label: 'Supplier', lines: supplierLines(p) }, { label: 'Buyer', lines: [b.name] }],
      sections: [{ kind: 'kv', rows: [['Scope', rfq?.title ?? ''], ...visits.map((v) => [`Visits ${v.status}`, String(v.n)])] }, { heading: 'Delivered against order', kind: 'table', columns: ORDER_COLS, rows: orderRows(lines, o.currency) }, ...(inc.length ? [{ heading: 'Incidents & exceptions', kind: 'table', columns: [{ t: 'Kind', w: 2 }, { t: 'Detail', w: 8 }, { t: 'When', w: 4 }], rows: inc.map((x) => [x.kind, x.detail, dt(x.created_at)]) }] : [])],
      footnote: 'This report records work delivered and accepted. It does not certify a venue, pool or installation as safe or compliant.' } };
  },
  async invoice(user, id) {
    const s = await one('SELECT * FROM svc_invoices WHERE id=$1', [id]);
    if (!s) throw notFound('Document');
    let ok = false;
    try { await supplierAccess(user, s.profile_id, ['owner', 'finance', 'sales'], pool); ok = true; } catch { /* buyer? */ }
    if (!ok) { if (s.status === 'draft') throw notFound('Document'); await buyerAccess(user, s.buyer_id, ['finance', 'purchaser', 'approver', 'requester'], pool); }
    const [p, b, o] = await Promise.all([one('SELECT * FROM svc_profiles WHERE id=$1', [s.profile_id]), one('SELECT * FROM svc_buyers WHERE id=$1', [s.buyer_id]), one('SELECT number FROM svc_orders WHERE id=$1', [s.order_id])]);
    const title = { invoice: 'Tax invoice', proforma: 'Pro forma invoice', credit_note: 'Credit note', debit_note: 'Debit note' }[s.doc_type];
    const ev = s.tax_evidence ?? {};
    return { type: 'invoice', version: 1, doc: { title, number: s.status === 'draft' ? 'DRAFT' : s.supplier_number, status: `${s.status} · order ${o.number}${s.po_reference ? ` · PO ${s.po_reference}` : ''}${s.due_on ? ` · due ${day(s.due_on)}` : ''}`, issued_at: s.issued_at, watermark: s.status === 'draft' ? 'DRAFT' : s.doc_type === 'proforma' ? 'PRO FORMA' : s.status === 'void' ? 'VOID' : null,
      parties: [{ label: 'From', lines: supplierLines(p) }, { label: 'Bill to', lines: [b.name] }],
      sections: [{ kind: 'table', columns: [{ t: 'Description', w: 30 }, { t: 'Qty', w: 10 }, { t: 'Rate', w: 12, a: 'right' }, { t: 'Net', w: 12, a: 'right' }, { t: 'Tax', w: 10, a: 'right' }, { t: 'Gross', w: 12, a: 'right' }], rows: s.lines.map((l) => [l.description, `${l.quantity} ${l.unit}`, fm(l.rate_minor, s.currency), fm(l.net_minor, s.currency), `${fm(l.tax_minor, s.currency)}${l.tax_code ? ` (${l.tax_code})` : ''}`, fm(l.gross_minor, s.currency)]) },
        ...(s.service_period ? [{ heading: 'Service period', kind: 'text', text: String(s.service_period) }] : [])],
      totals: [['Net', fm(s.net_minor, s.currency)], ['Tax', fm(s.tax_minor, s.currency)], ['Total', fm(s.gross_minor, s.currency), true], ...(Number(s.withholding_minor) ? [['Withholding (buyer deducts)', `- ${fm(s.withholding_minor, s.currency)}`], ['Payable', fm(s.payable_minor, s.currency), true]] : []), ...(s.doc_type === 'invoice' && s.status === 'issued' ? [['Paid', fm(s.paid_minor, s.currency)], ['Outstanding', fm(Number(s.payable_minor) - Number(s.credited_minor) - Number(s.paid_minor), s.currency), true]] : [])],
      footnote: [s.prices_include_tax ? 'Prices include tax.' : 'Prices exclude tax.', ev.reverse_charge ? 'Reverse charge: the buyer accounts for the tax.' : null, 'Tax treatment is the supplier’s own configuration; Gotmygame does not assert it is correct for any jurisdiction and does not file e-invoices.', s.doc_type === 'proforma' ? 'This is a pro forma invoice and is not a tax invoice.' : null].filter(Boolean).join(' ') } };
  },
  async receipt(user, id) {
    const pay = await one('SELECT p.*, s.supplier_number, s.profile_id, s.buyer_id, s.order_id FROM svc_payments p JOIN svc_invoices s ON s.id=p.svc_invoice_id WHERE p.id=$1', [id]);
    if (!pay) throw notFound('Document');
    let ok = false;
    try { await supplierAccess(user, pay.profile_id, ['owner', 'finance'], pool); ok = true; } catch { /* buyer? */ }
    if (!ok) await buyerAccess(user, pay.buyer_id, ['finance'], pool);
    const p = await one('SELECT * FROM svc_profiles WHERE id=$1', [pay.profile_id]); const b = await one('SELECT name FROM svc_buyers WHERE id=$1', [pay.buyer_id]);
    return { type: 'receipt', version: 1, doc: { title: 'Payment receipt', number: pay.reference ?? pay.id.slice(0, 8), status: `${pay.status} · ${pay.source.replace('_', ' ')}`, watermark: pay.status === 'voided' ? 'VOID' : null, issued_at: pay.created_at, parties: [{ label: 'Received by', lines: supplierLines(p) }, { label: 'Paid by', lines: [b.name] }],
      sections: [{ kind: 'kv', rows: [['Invoice', pay.supplier_number], ['Paid on', day(pay.paid_on)], ['Amount', fm(pay.amount_minor, pay.currency)], ['Reference', pay.reference ?? ''], ['Payout to supplier', pay.payout_state.replace('_', ' ')]] }], footnote: 'A manual record is evidence of a payment made outside the platform; it does not itself move money. Supplier payout is shown honestly: manual_pending means no transfer has been recorded.' } };
  },
  async statement(user, id) {
    const { profile } = await supplierAccess(user, id, ['owner', 'finance'], pool);
    const rows = await many("SELECT * FROM svc_invoices WHERE profile_id=$1 AND status='issued' AND doc_type IN ('invoice','credit_note','debit_note') ORDER BY currency, issued_at, id", [id]);
    const cur = [...new Set(rows.map((r) => r.currency))];
    return { type: 'statement', version: rows.length, doc: { title: 'Statement of account', number: profile.legal_name, status: 'per currency', parties: [{ label: 'Supplier', lines: supplierLines(profile) }],
      sections: cur.map((c) => { let bal = 0; return { heading: c, kind: 'table', columns: [{ t: 'Date', w: 4 }, { t: 'Document', w: 7 }, { t: 'Type', w: 4 }, { t: 'Amount', w: 6, a: 'right' }, { t: 'Paid', w: 6, a: 'right' }, { t: 'Balance', w: 6, a: 'right' }], rows: rows.filter((r) => r.currency === c).map((r) => { const sg = r.doc_type === 'credit_note' ? -1 : 1; bal += sg * Number(r.gross_minor) - (sg === 1 ? Number(r.paid_minor) : 0); return [day(r.issued_at), r.supplier_number, r.doc_type.replace('_', ' '), fm(sg * Number(r.gross_minor), c), sg === 1 ? fm(r.paid_minor, c) : '', fm(bal, c)]; }) }; }) } };
  },
};

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const periodLine = (i) => `${i.from ?? 'all time'} to ${i.to ?? 'today'} · UTC · currencies are never combined`;
/** A supplier dashboard as a document: the same figures the dashboard shows, laid out for print. */
export async function supplierReportDoc(profileId, i = {}) {
  const [p, x] = await Promise.all([one('SELECT * FROM svc_profiles WHERE id=$1', [profileId]), supplierDashboard(profileId, i)]);
  return { title: 'Supplier performance & finance report', number: p.legal_name, status: periodLine(i), parties: [{ label: 'Supplier', lines: supplierLines(p) }], sections: [
    { heading: 'Enquiries and quotes', kind: 'kv', rows: [['RFQs invited', x.enquiries.rfqs_invited], ['Responded', `${x.enquiries.responded} (${pct(x.enquiries.response_rate)})`], ['Average response (hours)', x.enquiries.avg_response_hours ?? '—'], ['Quotes submitted / awarded', `${x.quotes.submitted} / ${x.quotes.awarded}`], ['Quote conversion', pct(x.quotes.conversion)]] },
    { heading: 'Open pipeline', kind: 'table', columns: [{ t: 'Currency', w: 2 }, { t: 'Quotes', w: 2, a: 'right' }, { t: 'Gross', w: 4, a: 'right' }], rows: x.quotes.pipeline.map((r) => [r.currency, String(r.quotes), fm(r.gross_minor, r.currency)]) },
    { heading: 'Orders by state', kind: 'table', columns: [{ t: 'State', w: 4 }, { t: 'Currency', w: 2 }, { t: 'Orders', w: 2, a: 'right' }, { t: 'Gross', w: 4, a: 'right' }], rows: x.orders.by_state.map((r) => [r.status, r.currency, String(r.orders), fm(r.gross_minor, r.currency)]) },
    { heading: 'Delivery', kind: 'kv', rows: [['Visits', x.delivery.visits], ['On time', pct(x.delivery.on_time_rate)], ['Rework', pct(x.delivery.rework_rate)], ['No-show', pct(x.delivery.no_show_rate)], ['Cancelled', pct(x.delivery.cancellation_rate)], ['Utilisation', pct(x.delivery.utilisation)]] },
    { heading: 'Billed, collected, outstanding', kind: 'table', columns: [{ t: 'Currency', w: 2 }, { t: 'Billed', w: 4, a: 'right' }, { t: 'Collected', w: 4, a: 'right' }, { t: 'Outstanding', w: 4, a: 'right' }], rows: x.finance.by_currency.map((r) => [r.currency, fm(r.billed_minor, r.currency), fm(r.collected_minor, r.currency), fm(r.outstanding_minor, r.currency)]) },
    { heading: 'Ageing of unpaid balances', kind: 'table', columns: [{ t: 'Currency', w: 2 }, { t: 'Not due', w: 3, a: 'right' }, { t: '1–30', w: 3, a: 'right' }, { t: '31–60', w: 3, a: 'right' }, { t: '61–90', w: 3, a: 'right' }, { t: '90+', w: 3, a: 'right' }], rows: x.finance.ageing.map((r) => [r.currency, ...['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'].map((k) => fm(r[k], r.currency))]) },
    { heading: 'Tax summary', kind: 'table', columns: [{ t: 'Currency', w: 2 }, { t: 'Tax code', w: 3 }, { t: 'Net', w: 4, a: 'right' }, { t: 'Tax', w: 4, a: 'right' }], rows: x.finance.tax.map((r) => [r.currency, r.tax_code, fm(r.net_minor, r.currency), fm(r.tax_minor, r.currency)]) },
  ], footnote: `${x.definitions.quote_conversion}. ${x.definitions.billed}. Tax figures are the supplier’s own configuration, not an assertion of any jurisdiction’s rules.` };
}
export async function buyerReportDoc(buyerId, i = {}) {
  const [b, x] = await Promise.all([one('SELECT * FROM svc_buyers WHERE id=$1', [buyerId]), buyerDashboard(buyerId, i)]);
  return { title: 'Procurement report', number: b.name, status: periodLine(i), parties: [{ label: 'Buyer', lines: [b.name] }], sections: [
    { heading: 'Coverage and sourcing', kind: 'kv', rows: [['Requirements', x.coverage.requirements], ['Covered', `${x.coverage.covered} (${pct(x.coverage.rate)})`], ['RFQs', x.sourcing.rfqs], ['Suppliers invited / responded', `${x.sourcing.suppliers_invited} / ${x.sourcing.suppliers_responded}`], ['Invoice exceptions (open / approved)', `${x.invoices.open_exceptions} / ${x.invoices.approved_exceptions}`]] },
    { heading: 'Planned, committed, invoiced, paid', kind: 'table', columns: [{ t: 'Currency', w: 2 }, { t: 'Planned', w: 4, a: 'right' }, { t: 'Committed', w: 4, a: 'right' }, { t: 'Invoiced', w: 4, a: 'right' }, { t: 'Paid', w: 4, a: 'right' }, { t: 'Outstanding', w: 4, a: 'right' }], rows: x.spend.by_currency.map((r) => [r.currency, ...['planned_minor', 'committed_minor', 'invoiced_minor', 'paid_minor', 'outstanding_minor'].map((k) => fm(r[k], r.currency))]) },
    { heading: 'Savings against other comparable quotes', kind: 'table', columns: [{ t: 'Currency', w: 2 }, { t: 'RFQs', w: 2, a: 'right' }, { t: 'Saved', w: 4, a: 'right' }], rows: x.spend.savings.map((r) => [r.currency, String(r.rfqs), fm(r.saved_minor, r.currency)]) },
    { heading: 'Award rationale', kind: 'table', columns: [{ t: 'Order', w: 4 }, { t: 'Amount', w: 3, a: 'right' }, { t: 'Why', w: 8 }], rows: x.sourcing.award_rationale.map((r) => [r.number, fm(r.gross_minor, r.currency), r.justification ?? '']) },
    { heading: 'Supplier delivery performance', kind: 'table', columns: [{ t: 'Supplier', w: 6 }, { t: 'Orders', w: 2, a: 'right' }, { t: 'Visits', w: 2, a: 'right' }, { t: 'Accepted', w: 2, a: 'right' }, { t: 'Rework', w: 2, a: 'right' }, { t: 'No-show', w: 2, a: 'right' }, { t: 'Incidents', w: 2, a: 'right' }], rows: x.supplier_performance.map((r) => [r.supplier, String(r.orders), String(r.visits), String(r.accepted), String(r.rework), String(r.no_show), String(r.incidents)]) },
    { heading: 'Recurring maintenance cost', kind: 'table', columns: [{ t: 'Category', w: 5 }, { t: 'Currency', w: 2 }, { t: 'Orders', w: 2, a: 'right' }, { t: 'Gross', w: 4, a: 'right' }], rows: x.recurring_maintenance.map((r) => [label2(r.category), r.currency, String(r.orders), fm(r.gross_minor, r.currency)]) },
  ], footnote: `${x.definitions.savings}.` };
}
const label2 = (s) => String(s ?? '').replace(/_/g, ' ');
LOADERS.supplier_report = async (user, id, params = {}) => { await supplierAccess(user, id, ['owner', 'finance'], pool); return { type: 'supplier_report', version: 1, doc: await supplierReportDoc(id, params) }; };
LOADERS.buyer_report = async (user, id, params = {}) => { await buyerAccess(user, id, ['finance', 'purchaser'], pool); return { type: 'buyer_report', version: 1, doc: await buyerReportDoc(id, params) }; };
/** A table report (orders, invoices, payments, tax) as a document, for the PDF export format. */
export async function tableReportDoc(report, scope, rows) {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const name = scope.side === 'supplier' ? (await one('SELECT legal_name AS n FROM svc_profiles WHERE id=$1', [scope.id]))?.n : (await one('SELECT name AS n FROM svc_buyers WHERE id=$1', [scope.id]))?.n;
  const shown = (v, c) => (v == null ? '' : /_minor$/.test(c) ? String(v) : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  return { title: `${report[0].toUpperCase()}${report.slice(1)} report`, number: name, status: `${rows.length} rows · amounts in minor units of each row's currency`, sections: [{ kind: 'table', columns: cols.map((c) => ({ t: label2(c), w: 1 })), rows: rows.slice(0, 2000).map((r) => cols.map((c) => shown(r[c], c))) }], footnote: rows.length > 2000 ? 'Showing the first 2,000 rows; use CSV or XLSX for the complete list.' : undefined };
}
export const DOC_TYPES = Object.keys(LOADERS);
