// Academy OS: cost & revenue reconciliation (#787). One work queue, shared with the Finance console (fin_recon_items): unlinked, unmatched, double-count-risk and
// disputed academy cost/revenue entries, each traceable to the canonical record behind it, with a human decision that is audited and append-only. A decision
// never edits a canonical record and creates no invoice, payment, settlement or payroll row. See docs/academy-cost-reconciliation.md.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor, lockOrg } from '../org-access.js';
import { STAFF_MONEY } from '../academy.js';
import { isSupportedCurrency } from '../currency.js';
import { KINDS, SCOPE_SQL, defaultWindow, summary, sweep, trace } from '../academy-reconciliation.js';

const TAG = 'Academy';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const win = (i) => ({ from: i.from ?? defaultWindow().from, to: i.to ?? defaultWindow().to });
const STATUS = ['open', 'disputed', 'resolved'];
const DECISIONS = ['attribute', 'overhead', 'keep_canonical', 'keep_manual', 'record_cost', 'dispute', 'resolve', 'note'];

cap({
  name: 'get_academy_cost_reconciliation', method: 'GET', path: '/organisations/:id/academy/reconciliation', tag: TAG,
  summary: 'Reconciliation summary for the academy (owner/admin/finance): open, disputed and resolved items, by kind; how many cost lines each canonical source contributed (approved payroll, confirmed venue bookings, delivered supplier requests, payment-provider fees, management entries) and what share is matched; amounts held out as double-count risks per currency (never summed across currencies); and the provenance of the figures (basis, cut-off time, cost-allocation version). Read-only.',
  input: z.object({ id, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    return summary(i.id, win(i));
  },
});

cap({
  name: 'run_academy_reconciliation', method: 'POST', path: '/organisations/:id/academy/reconciliation/run', tag: TAG,
  summary: 'Check the academy\'s cost and revenue records now (owner/admin/finance): opens a queue item for every cost with no programme, charge with no programme, record that could be counted twice, delivered supplier work with no cost or a cost far from its quote, sessions with no confirmed booking, approved timesheets with no pay rate and cost in a different currency from its programme; items whose records agree again close themselves. Idempotent: running it twice opens nothing new. It reads canonical records and writes only queue items.',
  input: z.object({ id, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY, { write: true });
    const r = await sweep(i.id, win(i));
    await audit(null, user.id, 'run_academy_reconciliation', 'organisations', i.id);
    return r;
  },
});

const ITEM_SQL = `SELECT x.id, x.kind, x.status, x.domain, x.currency, x.amount_minor, x.detail, x.source_type, x.source_id, x.payment_id, x.branch_id, b.name AS branch, x.resolution, x.resolved_at, x.created_at, x.updated_at
   FROM fin_recon_items x LEFT JOIN academy_branches b ON b.id = x.branch_id`;
const decorate = (r) => ({ ...r, amount_minor: r.amount_minor == null ? null : Number(r.amount_minor), label: KINDS[r.kind]?.label ?? r.kind, allowed_decisions: r.status === 'resolved' ? [] : (KINDS[r.kind]?.actions ?? ['dispute', 'resolve', 'note']).filter((a) => !(r.status === 'disputed' && a === 'dispute')) });

cap({
  name: 'list_academy_recon_items', method: 'GET', path: '/organisations/:id/academy/reconciliation/items', tag: TAG,
  summary: 'The academy\'s reconciliation work queue (owner/admin/finance), newest first: academy cost and revenue items plus the payment exceptions of its academy charges, all from the shared Finance queue. Filter by status, kind, branch or currency. Each item says which decisions are allowed.',
  input: z.object({ id, status: z.enum(STATUS).default('open'), kind: z.enum(Object.keys(KINDS)).optional(), branch_id: id.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    const rows = await many(
      `${ITEM_SQL} WHERE ${SCOPE_SQL} AND x.status=$2 AND ($3::text IS NULL OR x.kind=$3) AND ($4::uuid IS NULL OR x.branch_id=$4) AND ($5::text IS NULL OR x.currency=$5)
        ORDER BY x.created_at DESC, x.id LIMIT $6 OFFSET $7`, [i.id, i.status, i.kind ?? null, i.branch_id ?? null, i.currency ?? null, i.limit, i.offset]);
    return rows.map(decorate);
  },
});

cap({
  name: 'get_academy_recon_item', method: 'GET', path: '/academy/reconciliation/items/:id', tag: TAG,
  summary: 'One reconciliation item with the canonical records behind it, the decisions recorded against its source and its history (owner/admin/finance). An item of another organisation is a 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const x = await one(`${ITEM_SQL} WHERE x.id=$1`, [i.id]);
    const orgId = x?.domain === 'academy_cost' ? (await one('SELECT organisation_id FROM fin_recon_items WHERE id=$1', [i.id])).organisation_id : null;
    const scoped = orgId ?? (x?.payment_id ? (await one("SELECT ch.organisation_id FROM payments p JOIN academy_charges ch ON ch.id=p.purpose_id AND p.purpose_type='academy_charge' WHERE p.id=$1", [x.payment_id]))?.organisation_id : null);
    if (!x || !scoped) throw notFound('Reconciliation item');
    await orgFor(user, scoped, STAFF_MONEY);
    const item = decorate(x);
    const full = await one('SELECT history FROM fin_recon_items WHERE id=$1', [x.id]);
    const decisions = x.source_id ? await many('SELECT a.id, a.decision, a.programme_id, a.cohort_id, a.overhead_method, a.reason, a.version, a.created_at, u.display_name AS by FROM academy_cost_attributions a JOIN users u ON u.id=a.created_by WHERE a.organisation_id=$1 AND a.source_type=$2 AND a.source_id=$3 ORDER BY a.version DESC', [scoped, x.source_type, x.source_id]) : [];
    await audit(null, user.id, 'read_academy_recon_item', 'fin_recon_items', x.id);
    return { ...item, trace: await trace(scoped, { ...x, detail: x.detail }), decisions, history: full.history };
  },
});

const body = z.object({
  id, decision: z.enum(DECISIONS), reason: z.string().trim().min(3).max(500),
  programme_id: id.optional(), cohort_id: id.optional(), method: z.enum(['participants', 'revenue_share']).optional(),
  amount_minor: z.number().int().min(1).max(1e12).optional(), currency: z.string().length(3).toUpperCase().optional(), invoice_ref: z.string().trim().min(1).max(80).optional(),
});

cap({
  name: 'act_on_academy_recon_item', method: 'POST', path: '/academy/reconciliation/items/:id/act', tag: TAG,
  summary: 'Decide a reconciliation item (owner/admin/finance), always with a written reason, audited and kept on record. attribute: tie a cost or charge to a programme (and cohort); overhead: spread a cost by participants or revenue share; keep_canonical / keep_manual: choose which of two overlapping records the P&L counts; record_cost: enter the final cost of delivered supplier work; dispute: park it as disputed; resolve: accept it as it is; note: add a note. The canonical record is never edited and no invoice, payment or payroll row is created: the P&L applies the decision when it reads. A resolved item cannot be acted on again (409). The server enforces which decisions each kind allows.',
  input: body,
  handler: ({ user }, i) => tx(async (c) => {
    const x = (await c.query('SELECT * FROM fin_recon_items WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!x) throw notFound('Reconciliation item');
    let orgId = x.organisation_id;
    if (!orgId && x.payment_id) orgId = (await c.query("SELECT ch.organisation_id FROM payments p JOIN academy_charges ch ON ch.id=p.purpose_id AND p.purpose_type='academy_charge' WHERE p.id=$1", [x.payment_id])).rows[0]?.organisation_id;
    if (!orgId) throw notFound('Reconciliation item');
    await orgFor(user, orgId, STAFF_MONEY, { write: true, c });
    if (x.status === 'resolved') throw conflict('This item is already resolved');
    const allowed = KINDS[x.kind]?.actions ?? ['dispute', 'resolve', 'note'];
    if (!allowed.includes(i.decision)) throw badRequest(`A "${KINDS[x.kind]?.label ?? x.kind}" item cannot be decided with ${i.decision.replace('_', ' ')}`);
    if (i.decision === 'dispute' && x.status === 'disputed') throw conflict('This item is already disputed');
    await lockOrg(c, orgId);
    let version = Number((await c.query('SELECT coalesce(max(version),0)::bigint AS v FROM academy_cost_attributions WHERE organisation_id=$1', [orgId])).rows[0].v);   // each decision row is one step of the allocation version
    const record = (type, sid, decision, extra = {}) => c.query(
      'INSERT INTO academy_cost_attributions(organisation_id, source_type, source_id, decision, programme_id, cohort_id, overhead_method, recon_item_id, reason, version, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [orgId, type, sid, decision, extra.programme_id ?? null, extra.cohort_id ?? null, extra.method ?? null, x.id, i.reason, ++version, user.id]);
    let status = x.status, resolution = null;
    const d = i.decision;
    if (d === 'attribute') {
      if (!i.programme_id) throw badRequest('Choose the programme');
      if (!(await c.query('SELECT 1 FROM academy_programmes WHERE id=$1 AND organisation_id=$2', [i.programme_id, orgId])).rowCount) throw badRequest('That programme is not in this academy');
      if (i.cohort_id && !(await c.query('SELECT 1 FROM org_cohorts WHERE id=$1 AND organisation_id=$2 AND programme_id=$3', [i.cohort_id, orgId, i.programme_id])).rowCount) throw badRequest('That cohort does not belong to the chosen programme');
      await record(x.source_type, x.source_id, 'programme', { programme_id: i.programme_id, cohort_id: i.cohort_id });
      status = 'resolved'; resolution = `Attributed: ${i.reason}`;
    } else if (d === 'overhead') {
      if (!i.method) throw badRequest('Choose how to spread it: participants or revenue share');
      await record(x.source_type, x.source_id, 'overhead', { method: i.method });
      status = 'resolved'; resolution = `Treated as overhead (${i.method.replace('_', ' ')}): ${i.reason}`;
    } else if (d === 'keep_canonical' || d === 'keep_manual') {
      const mid = x.detail?.manual_entry_id;
      if (!mid) throw badRequest('This item has no manual entry to decide about');
      await record('academy_cost_entry', mid, d);
      if (d === 'keep_manual' && x.source_type === 'academy_supplier_request') await record('academy_supplier_request', x.source_id, 'keep_manual');
      status = 'resolved'; resolution = `${d === 'keep_canonical' ? 'Canonical record kept, manual entry left out' : 'Manual entry kept, canonical record left out'}: ${i.reason}`;
    } else if (d === 'record_cost') {
      if (!i.amount_minor) throw badRequest('Enter the final cost');
      const q = (await c.query('SELECT * FROM academy_supplier_requests WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [x.source_id, orgId])).rows[0];
      if (!q) throw notFound('Supplier request');
      const currency = i.currency ?? q.currency;
      if (!currency) throw badRequest('Choose a currency');
      if (!isSupportedCurrency(currency)) throw badRequest('Unsupported currency');
      if (q.currency && currency !== q.currency && q.estimated_cost_minor != null) throw conflict(`The quote is in ${q.currency}; the final cost must be in the same currency (money in different currencies is never summed)`);
      await c.query('UPDATE academy_supplier_requests SET actual_cost_minor=$2, currency=$3, invoice_ref=coalesce($4, invoice_ref), delivered_at=coalesce(delivered_at, now()), row_version=row_version+1, updated_at=now() WHERE id=$1', [q.id, i.amount_minor, currency, i.invoice_ref ?? null]);
      status = 'resolved'; resolution = `Final cost recorded: ${i.reason}`;
    } else if (d === 'dispute') { status = 'disputed'; }
    else if (d === 'resolve') { status = 'resolved'; resolution = i.reason; }
    const hist = JSON.stringify([{ at: new Date().toISOString(), by: user.id, action: d, reason: i.reason, ...(i.programme_id ? { programme_id: i.programme_id } : {}), ...(i.amount_minor ? { amount_minor: i.amount_minor } : {}) }]);
    const r = (await c.query(
      `UPDATE fin_recon_items SET status=$2, resolution=coalesce($3, resolution), resolved_by=CASE WHEN $2='resolved' THEN $4 ELSE resolved_by END, resolved_at=CASE WHEN $2='resolved' THEN now() ELSE resolved_at END, history = history || $5::jsonb, updated_at=now(), organisation_id=coalesce(organisation_id,$6) WHERE id=$1 RETURNING *`,
      [x.id, status, resolution, user.id, hist, orgId])).rows[0];
    await audit(c, user.id, `academy_recon_${d}`, 'fin_recon_items', x.id);
    return decorate({ ...r, branch: null });
  }),
});
