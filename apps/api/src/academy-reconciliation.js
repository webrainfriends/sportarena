// Academy cost & revenue reconciliation (#787). Detects, per organisation, every cost or revenue record that is unlinked, unmatched, at risk of being counted
// twice, or in dispute, and keeps them in the SHARED Finance queue (fin_recon_items, domain 'academy_cost'). It reads the canonical records (approved payroll,
// confirmed venue bookings, supplier requests, the Finance ledger, charges) and writes only queue items and append-only attribution decisions. It creates no
// invoice, payment, settlement or payroll row, and never alters a canonical record: a person's correction is a decision that the P&L applies on read.
import { many, one } from './db.js';
import { payrollCost, venueCost, supplierCost, paymentFeeCost, mergeCosts, loadDecisions, allocationVersion, decisionKey, venueBranches } from './academy-cost-sources.js';

export const KINDS = {
  cost_unlinked: { label: 'Cost has no programme', source: 'cost', actions: ['attribute', 'overhead', 'dispute', 'resolve', 'note'] },
  revenue_unlinked: { label: 'Charge has no programme', source: 'revenue', actions: ['attribute', 'dispute', 'resolve', 'note'] },
  double_count_risk: { label: 'Could be counted twice', source: 'cost', actions: ['keep_canonical', 'keep_manual', 'dispute', 'resolve', 'note'] },
  supplier_unmatched: { label: 'Supplier work delivered, no cost recorded', source: 'supplier', actions: ['record_cost', 'dispute', 'resolve', 'note'] },
  supplier_variance: { label: 'Supplier cost differs from the quote', source: 'supplier', actions: ['dispute', 'resolve', 'note'] },
  venue_unbooked: { label: 'Sessions with no confirmed booking', source: 'venue', actions: ['dispute', 'resolve', 'note'] },
  payroll_unpriced: { label: 'Approved timesheets with no pay rate', source: 'payroll', actions: ['dispute', 'resolve', 'note'] },
  currency_mismatch: { label: 'Cost currency differs from programme currency', source: 'cost', actions: ['dispute', 'resolve', 'note'] },
  payment_unrecorded: { label: 'Payment not in the ledger', source: 'revenue', actions: ['dispute', 'resolve', 'note'] },
  refund_drift: { label: 'Refund differs from the ledger', source: 'revenue', actions: ['dispute', 'resolve', 'note'] },
  amount_drift: { label: 'Amount differs from the ledger', source: 'revenue', actions: ['dispute', 'resolve', 'note'] },
};
export const ACADEMY_KINDS = ['cost_unlinked', 'revenue_unlinked', 'double_count_risk', 'supplier_unmatched', 'supplier_variance', 'venue_unbooked', 'payroll_unpriced', 'currency_mismatch'];
/** Kinds whose condition is re-checked over the whole sweep window: they close themselves when the records agree again. */
const WINDOWED = new Set(['venue_unbooked', 'payroll_unpriced']);
const VARIANCE_PCT = 20;
const N = (v) => Number(v ?? 0);
const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
export const defaultWindow = () => ({ from: new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10), to: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) });   // planned sessions in the next 30 days matter too

/** Everything that needs a person, over [from, to], plus how many cost lines each canonical source contributed and how many of those are flagged. */
export async function detect(orgId, { from, to } = defaultWindow()) {
  const decisions = await loadDecisions(orgId);
  const decided = (t, id) => decisions.get(decisionKey(t, id));
  const [payroll, venue, supplier, fees, vb] = await Promise.all([payrollCost(orgId, from, to, decisions), venueCost(orgId, from, to), supplierCost(orgId, from, to, decisions), paymentFeeCost(orgId, from, to, decisions), venueBranches(orgId)]);
  const items = [];
  const add = (i) => items.push({ currency: null, amount_minor: null, branch_id: null, on_date: null, detail: {}, ...i });

  // 1. cost no canonical record could tie to a programme (approved payroll adjustments / timesheets with no programme, delivered supplier work)
  const loose = new Map();
  for (const d of [...payroll.rows, ...supplier.rows].filter((x) => !x.programme_id && !x.overhead_method)) {
    const k = decisionKey(d.source_type, d.source_id);
    if (!loose.has(k)) loose.set(k, { ...d, amount_minor: 0 });
    loose.get(k).amount_minor += d.amount_minor;
  }
  for (const d of loose.values()) {
    add({ kind: 'cost_unlinked', dedupe_key: `cost_unlinked:${d.source_type}:${d.source_id}:${d.currency}`, source_type: d.source_type, source_id: d.source_id, currency: d.currency, amount_minor: d.amount_minor, branch_id: d.branch_id ?? null, on_date: dayOf(d.on_date),
      detail: { category: d.category, label: d.label ?? (d.adjustment ? 'Payroll adjustment' : 'Approved timesheets without a programme'), venue_id: d.venue_id ?? null, invoice_ref: d.invoice_ref ?? null, on_date: dayOf(d.on_date) } });
  }

  // 2. charges no record could tie to a programme
  const charges = await many(
    `SELECT ch.id, ch.currency, ch.kind, ch.due_on, ch.amount_minor FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
      WHERE ch.organisation_id=$1 AND ch.due_on BETWEEN $2 AND $3 AND ch.status <> 'cancelled' AND coalesce(e.programme_id, a.programme_id) IS NULL`, [orgId, from, to]);
  for (const c of charges) if (!decided('academy_charge', c.id)) add({ kind: 'revenue_unlinked', dedupe_key: `revenue_unlinked:${c.id}`, source_type: 'academy_charge', source_id: c.id, currency: c.currency, amount_minor: N(c.amount_minor), on_date: dayOf(c.due_on), detail: { charge_kind: c.kind, on_date: dayOf(c.due_on) } });

  // 3. double-count risk: a manual entry that a canonical record already covers
  const manual = await many('SELECT * FROM academy_cost_entries WHERE organisation_id=$1 AND voided_at IS NULL AND incurred_on BETWEEN $2 AND $3 ORDER BY incurred_on, id', [orgId, from, to]);
  const live = manual.filter((m) => !['keep_canonical', 'keep_manual'].includes(decided('academy_cost_entry', m.id)?.decision));
  const derivedAll = [...payroll.rows, ...venue.rows, ...supplier.rows, ...fees.rows];
  const { superseded } = mergeCosts(live, derivedAll);
  for (const m of superseded) {
    const sup = supplier.rows.find((d) => m.category === 'other_direct' && d.currency === m.currency && d.amount_minor === N(m.amount_minor) && Math.abs(new Date(d.on_date) - new Date(m.incurred_on)) <= 45 * 864e5);
    add({ kind: 'double_count_risk', dedupe_key: `double_count_risk:${m.id}`, source_type: sup ? 'academy_supplier_request' : 'academy_cost_entry', source_id: sup ? sup.source_id : m.id, currency: m.currency, amount_minor: N(m.amount_minor), on_date: dayOf(m.incurred_on),
      detail: { manual_entry_id: m.id, manual_description: m.description, manual_category: m.category, programme_id: m.programme_id, canonical: sup ? { source_type: sup.source_type, source_id: sup.source_id, amount_minor: sup.amount_minor } : { covers: `${m.category} for this programme and currency` }, held_out_minor: N(m.amount_minor), on_date: dayOf(m.incurred_on) } });
  }

  // 4/5. supplier work with no final cost, or a final cost far from the quote
  const reqs = await many(
    `SELECT q.id, q.title, q.status, q.currency, q.estimated_cost_minor, q.actual_cost_minor, q.venue_id, s.name AS supplier, coalesce(q.delivered_at, q.updated_at)::date AS on_date
       FROM academy_supplier_requests q JOIN academy_suppliers s ON s.id=q.supplier_id
      WHERE q.organisation_id=$1 AND q.status IN ('delivered','done') AND coalesce(q.delivered_at, q.updated_at)::date BETWEEN $2 AND $3`, [orgId, from, to]);
  for (const q of reqs) {
    const branch = q.venue_id ? vb.get(q.venue_id) ?? null : null;
    const base = { source_type: 'academy_supplier_request', source_id: q.id, currency: q.currency, branch_id: branch, on_date: dayOf(q.on_date) };
    if (q.actual_cost_minor == null || N(q.actual_cost_minor) === 0) add({ ...base, kind: 'supplier_unmatched', dedupe_key: `supplier_unmatched:${q.id}`, amount_minor: q.estimated_cost_minor == null ? null : N(q.estimated_cost_minor), detail: { title: q.title, supplier: q.supplier, status: q.status, quote_minor: q.estimated_cost_minor == null ? null : N(q.estimated_cost_minor), on_date: dayOf(q.on_date) } });
    else if (q.estimated_cost_minor != null && N(q.estimated_cost_minor) > 0 && Math.abs(N(q.actual_cost_minor) - N(q.estimated_cost_minor)) * 100 > VARIANCE_PCT * N(q.estimated_cost_minor))
      add({ ...base, kind: 'supplier_variance', dedupe_key: `supplier_variance:${q.id}:${q.actual_cost_minor}`, amount_minor: N(q.actual_cost_minor) - N(q.estimated_cost_minor), detail: { title: q.title, supplier: q.supplier, quote_minor: N(q.estimated_cost_minor), actual_minor: N(q.actual_cost_minor), variance_pct: Math.round(((N(q.actual_cost_minor) - N(q.estimated_cost_minor)) / N(q.estimated_cost_minor)) * 1000) / 10, on_date: dayOf(q.on_date) } });
  }

  // 6. sessions with no confirmed priced booking (venue cost missing, not zero)
  const progs = new Map((await many('SELECT id, title FROM academy_programmes WHERE organisation_id=$1', [orgId])).map((p) => [p.id, p.title]));
  for (const [pid, count] of venue.unbooked_by_programme) if (pid) add({ kind: 'venue_unbooked', dedupe_key: `venue_unbooked:${pid}`, source_type: 'academy_programme', source_id: pid, detail: { programme: progs.get(pid) ?? null, sessions: count, window: { from, to } } });

  // 7. approved payroll runs that left timesheets unpriced (pay cost missing, not zero)
  const runs = await many(`SELECT id, currency, period_start, period_end, jsonb_array_length(unpriced) AS n FROM academy_payroll_runs WHERE organisation_id=$1 AND status='approved' AND period_start <= $3 AND period_end >= $2 AND jsonb_array_length(unpriced) > 0`, [orgId, from, to]);
  for (const r of runs) add({ kind: 'payroll_unpriced', dedupe_key: `payroll_unpriced:${r.id}`, source_type: 'academy_payroll_run', source_id: r.id, currency: r.currency, detail: { timesheets: r.n, period_start: dayOf(r.period_start), period_end: dayOf(r.period_end) } });

  // 8. a manual cost in a different currency from the programme it is booked to (reported in its own currency, never summed)
  const mism = await many(
    `SELECT m.id, m.currency, m.amount_minor, m.incurred_on, m.description, pv.currency AS programme_currency, p.title FROM academy_cost_entries m JOIN academy_programmes p ON p.id=m.programme_id
       JOIN LATERAL (SELECT currency FROM academy_programme_versions v WHERE v.programme_id=p.id ORDER BY version DESC LIMIT 1) pv ON true
      WHERE m.organisation_id=$1 AND m.voided_at IS NULL AND m.incurred_on BETWEEN $2 AND $3 AND pv.currency IS NOT NULL AND pv.currency <> m.currency`, [orgId, from, to]);
  for (const m of mism) add({ kind: 'currency_mismatch', dedupe_key: `currency_mismatch:${m.id}`, source_type: 'academy_cost_entry', source_id: m.id, currency: m.currency, amount_minor: N(m.amount_minor), on_date: dayOf(m.incurred_on), detail: { programme: m.title, programme_currency: m.programme_currency, entry_currency: m.currency, description: m.description, on_date: dayOf(m.incurred_on) } });

  // coverage: how many distinct canonical cost lines each source contributed, and how many of them an item points at
  const flagged = new Set(items.filter((i) => i.source_id).flatMap((i) => [decisionKey(i.source_type, i.source_id), i.detail.manual_entry_id ? decisionKey('academy_cost_entry', i.detail.manual_entry_id) : null]).filter(Boolean));
  const cov = (label, rows) => { const keys = new Set(rows.map((r) => decisionKey(r.source_type, r.source_id))); return { source: label, lines: keys.size, flagged: [...keys].filter((k) => flagged.has(k)).length }; };
  const coverage = [cov('payroll', payroll.rows), cov('venue', venue.rows), cov('supplier', supplier.rows), cov('payment_fee', fees.rows), cov('manual', manual.map((m) => ({ source_type: 'academy_cost_entry', source_id: m.id })))];
  return { window: { from, to }, items, coverage, alloc_version: await allocationVersion(orgId) };
}

/** Open an item for everything detected that is not already open, disputed or settled by a person; close open items whose records agree again. Idempotent. */
export async function sweep(orgId, window = defaultWindow()) {
  const d = await detect(orgId, window);
  let opened = 0;
  for (const i of d.items) {
    const r = await one(
      `INSERT INTO fin_recon_items(kind, dedupe_key, currency, amount_minor, detail, organisation_id, domain, source_type, source_id, branch_id)
       SELECT $1,$2,$3,$4,$5,$6,'academy_cost',$7,$8,$9 WHERE NOT EXISTS (SELECT 1 FROM fin_recon_items x WHERE x.dedupe_key=$2 AND x.organisation_id=$6)
       ON CONFLICT (dedupe_key) WHERE status='open' DO NOTHING RETURNING id`,
      [i.kind, i.dedupe_key, i.currency, i.amount_minor, JSON.stringify(i.detail), orgId, i.source_type, i.source_id, i.branch_id]);
    if (r) opened++;
  }
  const keys = d.items.map((i) => i.dedupe_key);
  const closed = (await many(
    `UPDATE fin_recon_items SET status='resolved', resolution=$5, resolved_at=now(), updated_at=now(), history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', null, 'action', 'auto_resolved', 'reason', $5::text))
      WHERE organisation_id=$1 AND domain='academy_cost' AND status='open' AND NOT (dedupe_key = ANY($2))
        AND (kind = ANY($6) OR (detail->>'on_date') BETWEEN $3 AND $4) RETURNING id`,
    [orgId, keys, window.from, window.to, 'Consistent again after reconciliation', [...WINDOWED]])).length;
  return { window: d.window, detected: d.items.length, opened, closed, cut_off_at: new Date().toISOString() };
}

/** The queue summary: counts and amounts by status, kind and currency (never summed across currencies), coverage by source, provenance. */
export async function summary(orgId, window = defaultWindow()) {
  const d = await detect(orgId, window);
  const rows = await many(
    `SELECT x.kind, x.status, x.currency, count(*)::int AS n, coalesce(sum(x.amount_minor),0)::bigint AS minor FROM fin_recon_items x
      WHERE ${SCOPE_SQL} GROUP BY 1,2,3 ORDER BY 1,2,3`, [orgId]);
  const by = (st) => rows.filter((r) => r.status === st);
  const count = (arr) => arr.reduce((s, r) => s + r.n, 0);
  const lines = d.coverage.reduce((s, c) => s + c.lines, 0), flagged = d.coverage.reduce((s, c) => s + c.flagged, 0);
  const held = new Map();
  for (const r of by('open').filter((r) => r.kind === 'double_count_risk' && r.currency)) held.set(r.currency, (held.get(r.currency) ?? 0) + N(r.minor));
  return {
    cut_off_at: new Date().toISOString(), window: d.window, cost_allocation_version: d.alloc_version,
    counts: { open: count(by('open')), disputed: count(by('disputed')), resolved: count(by('resolved')) },
    by_kind: Object.keys(KINDS).map((k) => ({ kind: k, label: KINDS[k].label, open: count(by('open').filter((r) => r.kind === k)), disputed: count(by('disputed').filter((r) => r.kind === k)) })).filter((k) => k.open || k.disputed),
    held_out_by_currency: [...held].map(([currency, minor]) => ({ currency, minor })).sort((a, b) => a.currency.localeCompare(b.currency)),
    coverage: { lines, flagged, matched_pct: lines ? Math.round(((lines - flagged) / lines) * 1000) / 10 : null, by_source: d.coverage.map((c) => ({ ...c, matched_pct: c.lines ? Math.round(((c.lines - c.flagged) / c.lines) * 1000) / 10 : null })) },
    currency_policy: 'Amounts are per currency and never summed across currencies.',
    definitions: { matched: 'A cost line is matched when it comes from exactly one canonical record and no open item points at it.', unmatched: 'Delivered supplier work with no final cost, or a charge or cost no record ties to a programme.', double_count_risk: 'Two records that could describe the same money. The canonical record is counted and the other is held out until a person decides.', unknown: 'A figure no canonical record supports is shown as unknown, never as zero.' },
  };
}

/** Queue rows of one organisation: its academy cost/revenue items and the payment exceptions of its academy charges, in one list. */
export const SCOPE_SQL = `(x.organisation_id = $1 OR (x.payment_id IS NOT NULL AND EXISTS (SELECT 1 FROM payments p JOIN academy_charges ch ON ch.id = p.purpose_id AND p.purpose_type = 'academy_charge' WHERE p.id = x.payment_id AND ch.organisation_id = $1)))`;

/** The canonical records behind an item, so a person can see exactly what they are deciding about. */
export async function trace(orgId, item) {
  const out = [];
  const t = item.source_type, id = item.source_id;
  if (t === 'academy_payroll_line') {
    const r = await one('SELECT l.id, l.gross_minor, l.paid_minor, r.id AS run_id, r.period_start, r.period_end, r.status, r.currency, u.display_name FROM academy_payroll_lines l JOIN academy_payroll_runs r ON r.id=l.run_id LEFT JOIN users u ON u.id=l.user_id WHERE l.id=$1 AND r.organisation_id=$2', [id, orgId]);
    if (r) out.push({ source_type: t, source_id: id, label: 'Approved payroll line', summary: { person: r.display_name, run: r.run_id, period: `${dayOf(r.period_start)} – ${dayOf(r.period_end)}`, status: r.status, currency: r.currency, gross_minor: N(r.gross_minor) } });
  } else if (t === 'academy_payroll_run') {
    const r = await one('SELECT id, period_start, period_end, status, currency, jsonb_array_length(unpriced) AS unpriced FROM academy_payroll_runs WHERE id=$1 AND organisation_id=$2', [id, orgId]);
    if (r) out.push({ source_type: t, source_id: id, label: 'Approved payroll run', summary: { period: `${dayOf(r.period_start)} – ${dayOf(r.period_end)}`, status: r.status, currency: r.currency, unpriced_timesheets: r.unpriced } });
  } else if (t === 'academy_supplier_request') {
    const r = await one('SELECT q.*, s.name AS supplier, v.name AS venue FROM academy_supplier_requests q JOIN academy_suppliers s ON s.id=q.supplier_id LEFT JOIN venues v ON v.id=q.venue_id WHERE q.id=$1 AND q.organisation_id=$2', [id, orgId]);
    if (r) out.push({ source_type: t, source_id: id, label: 'Supplier request', summary: { title: r.title, supplier: r.supplier, venue: r.venue, status: r.status, currency: r.currency, quote_minor: r.estimated_cost_minor == null ? null : N(r.estimated_cost_minor), actual_minor: r.actual_cost_minor == null ? null : N(r.actual_cost_minor), invoice_ref: r.invoice_ref, delivered_at: r.delivered_at } });
  } else if (t === 'academy_charge') {
    const r = await one('SELECT id, kind, status, currency, due_on, amount_minor, gross_minor FROM academy_charges WHERE id=$1 AND organisation_id=$2', [id, orgId]);
    if (r) out.push({ source_type: t, source_id: id, label: 'Academy charge', summary: { kind: r.kind, status: r.status, currency: r.currency, due_on: dayOf(r.due_on), amount_minor: N(r.amount_minor), gross_minor: N(r.gross_minor) } });
  } else if (t === 'academy_programme') {
    const r = await one('SELECT id, title, sport FROM academy_programmes WHERE id=$1 AND organisation_id=$2', [id, orgId]);
    if (r) out.push({ source_type: t, source_id: id, label: 'Programme', summary: { title: r.title, sport: r.sport } });
  }
  const mid = item.detail?.manual_entry_id ?? (t === 'academy_cost_entry' ? id : null);
  if (mid) {
    const m = await one('SELECT id, category, currency, amount_minor, incurred_on, description, source_ref, voided_at FROM academy_cost_entries WHERE id=$1 AND organisation_id=$2', [mid, orgId]);
    if (m) out.push({ source_type: 'academy_cost_entry', source_id: m.id, label: 'Management cost entry', summary: { category: m.category, currency: m.currency, amount_minor: N(m.amount_minor), incurred_on: dayOf(m.incurred_on), description: m.description, reference: m.source_ref, voided: !!m.voided_at } });
  }
  if (item.payment_id) out.push({ source_type: 'payment', source_id: item.payment_id, label: 'Payment (Finance ledger)', summary: { detail: item.detail } });
  return out;
}
