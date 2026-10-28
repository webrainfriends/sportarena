// Procurement chain (issue #520): one traceable view from buyer demand to supplier performance across the two sourcing routes
// (direct RFQ in Supplier services #458, formal tender in the Tender zone #460), plus the facts the chain needs that neither module had:
// linking an older tender order to its service order, a buyer rating after fulfilment, and an evidence-based supplier performance record.
// Nothing here creates a second order, ledger or score: every figure is read from the canonical record named in `canonical`.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { anySide, orderSide, q1 } from '../svc/orders.js';
import { supplierAccess, buyerAccess, log } from '../svc/access.js';
import { buyerRoles, can, getProject, auditLog } from '../tender/core.js';
import { ensureServiceOrder, commitTenderOrder } from '../svc/from-tender.js';
import { supplierAudience } from './svc-rfq.js';

const TAG = 'Procurement chain';
/** Fewer observations than this are shown but flagged: a rate over three jobs is an anecdote, not a record. */
export const MIN_SAMPLE = 5;

const stage = (key, label, status, summary, canonical = null, facts = {}) => ({ key, label, status, summary, canonical, facts });
const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

/** Every stage of one service order, from the demand that started it to what the supplier's record now says. Sides only see their own facts. */
export async function chainOf(o, { buy, sup }) {
  const stages = [];
  const isTender = o.source === 'tender' && o.proc_order_id;
  const po = isTender ? await one('SELECT * FROM proc_orders WHERE id=$1', [o.proc_order_id]) : null;
  const project = po ? await one('SELECT id, ref, title, status, contract_type, cost_basis, event_id, closes_at FROM proc_projects WHERE id=$1', [po.project_id]) : null;
  const rfq = o.rfq_id ? await one('SELECT id, title, status, requirement_id, audience FROM svc_rfqs WHERE id=$1', [o.rfq_id]) : null;
  const req = o.requirement_id ? await one('SELECT id, title, status, category, budget_minor, starts_at, ends_at FROM svc_requirements WHERE id=$1', [o.requirement_id]) : null;

  // 1 demand / 2 sourcing / 3 supplier response / 4 evaluation / 5 award — competing bids are never part of what a supplier sees
  if (isTender) {
    stages.push(stage('demand', 'Demand', 'done', project.event_id ? 'Sourcing need linked to an event' : 'Sourcing need', { entity: 'tender', id: project.id }, { event_id: project.event_id }));
    const bids = buy ? await one("SELECT count(*)::int AS n FROM proc_proposals WHERE project_id=$1 AND status='submitted'", [project.id]) : null;
    stages.push(stage('sourcing', 'Tender', 'done', `${project.ref} · ${project.title}`, { entity: 'tender', id: project.id }, { route: 'tender', contract_type: project.contract_type, status: project.status }));
    stages.push(stage('response', 'Bids', 'done', buy ? `${bids.n} bid(s) received` : 'Your bid was received', { entity: 'tender', id: project.id }, buy ? { bids_received: bids.n } : {}));
    const line = await one('SELECT status, qty, amount_minor, currency, responded_at FROM proc_award_lines WHERE id=$1', [po.award_line_id]);
    stages.push(stage('evaluation', 'Evaluation', 'done', 'Scored by the evaluation committee on the published rubric; the ranking is committed and audited', { entity: 'tender', id: project.id }));
    stages.push(stage('award', 'Award', line?.status === 'accepted' ? 'done' : 'active', `Award line ${line?.status}`, { entity: 'proc_award_line', id: po.award_line_id }, { amount_minor: Number(line?.amount_minor), currency: line?.currency }));
  } else if (rfq) {
    stages.push(stage('demand', 'Demand', 'done', req ? `${req.title}` : 'Requirement', req ? { entity: 'svc_requirement', id: req.id } : null, req ? { category: req.category, budget_minor: req.budget_minor !== null ? Number(req.budget_minor) : null } : {}));
    const q = buy ? await one("SELECT count(DISTINCT profile_id)::int AS n FROM svc_quotes WHERE rfq_id=$1 AND status NOT IN ('draft')", [rfq.id]) : null;
    stages.push(stage('sourcing', 'RFQ', 'done', `${rfq.title} (${rfq.audience === 'published' ? 'published' : 'direct invitation'})`, { entity: 'svc_rfq', id: rfq.id }, { route: 'rfq', status: rfq.status }));
    stages.push(stage('response', 'Quotes', 'done', buy ? `${q.n} supplier(s) quoted` : 'Your quote was received', { entity: 'svc_rfq', id: rfq.id }, buy ? { suppliers_quoted: q.n } : {}));
    const ev = buy ? await one('SELECT count(*)::int AS n FROM svc_evaluations WHERE rfq_id=$1', [rfq.id]) : null;
    stages.push(stage('evaluation', 'Evaluation', 'done', buy ? `${ev.n} evaluation(s) recorded` : 'Evaluated by the buyer', { entity: 'svc_rfq', id: rfq.id }));
    stages.push(stage('award', 'Award', 'done', o.approval_id ? 'Awarded after a separate approval' : 'Awarded', { entity: 'svc_quote', id: o.quote_id }));
  } else {
    stages.push(stage('demand', 'Demand', 'done', 'Direct order'));
  }

  // 6 order / 7 fulfilment
  stages.push(stage('order', 'Order', ['cancelled', 'rejected', 'terminated'].includes(o.status) ? 'gap' : 'done', `${o.number} · ${o.status}`, { entity: 'svc_order', id: o.id }, { source: o.source, net_minor: Number(o.net_minor), tax_minor: Number(o.tax_minor), gross_minor: Number(o.gross_minor), currency: o.currency, contract_order_id: o.proc_order_id }));
  const lines = await many("SELECT line_type, qty_ordered::float AS ordered, qty_accepted::float AS accepted, qty_invoiced::float AS invoiced FROM svc_order_lines WHERE order_id=$1 AND status='active'", [o.id]);
  const ordered = sum(lines, 'ordered'), accepted = sum(lines, 'accepted'), invoiced = sum(lines, 'invoiced');
  const goods = lines.some((l) => l.line_type === 'goods');
  stages.push(stage('fulfilment', goods ? 'Receiving & acceptance' : 'Delivery & acceptance', accepted >= ordered && ordered > 0 ? 'done' : accepted > 0 ? 'active' : 'pending',
    `${accepted} of ${ordered} accepted`, { entity: 'svc_order', id: o.id }, { ordered, accepted, invoiced, fulfilment: o.fulfilment, supply: goods ? 'goods' : 'service' }));

  // 8 invoice / 9 payment — invoice approval is controlled by what the buyer accepted
  const invs = await many("SELECT id, doc_type, supplier_number, gross_minor, paid_minor, match_status FROM svc_invoices WHERE order_id=$1 AND status='issued' AND doc_type IN ('invoice','debit_note')", [o.id]);
  const exceptions = invs.filter((x) => x.match_status === 'exception').length;
  stages.push(stage('invoice', 'Invoice & matching', invs.length ? (exceptions ? 'active' : 'done') : 'pending', invs.length ? `${invs.length} issued · ${exceptions} awaiting a matching decision` : 'No invoice yet',
    { entity: 'svc_invoice', id: invs[0]?.id ?? null }, { issued: invs.length, billed_minor: sum(invs, 'gross_minor'), matched: invs.filter((x) => x.match_status === 'matched').length, exceptions, billing: o.billing }));
  stages.push(stage('payment', 'Payment', o.settlement === 'paid' ? 'done' : o.settlement === 'partially_paid' ? 'active' : 'pending', `Settlement: ${o.settlement}`, { entity: 'svc_invoice', id: invs[0]?.id ?? null }, { paid_minor: sum(invs, 'paid_minor'), settlement: o.settlement }));

  // 10 event budget — the commitment is the order's single budget line; actuals are its recorded payments
  if (o.event_id && (buy || sup)) {
    const line = await one("SELECT id, committed_cents, planned_cents, status FROM event_budget_lines WHERE svc_order_id=$1 ORDER BY (status='void'), created_at DESC LIMIT 1", [o.id]);
    const actual = line ? Number((await one('SELECT coalesce(sum(amount_cents),0)::bigint AS s FROM event_budget_payments WHERE line_id=$1 AND voided_at IS NULL', [line.id])).s) : 0;
    stages.push(stage('budget', 'Event budget', line ? (line.status === 'void' ? 'gap' : 'done') : 'gap', line ? (line.status === 'void' ? 'Commitment released (line kept on record)' : 'Committed on the event budget') : 'Not committed (event budget is in another currency)',
      { entity: 'event_budget_line', id: line?.id ?? null }, buy ? { committed_minor: line ? Number(line.committed_cents) : 0, actual_minor: actual, remaining_commitment_minor: line && line.status !== 'void' ? Math.max(0, Number(line.committed_cents) - actual) : 0, status: line?.status ?? null } : {}));
  }
  // 11 performance
  const rating = await one('SELECT stars, created_at FROM svc_order_ratings WHERE order_id=$1', [o.id]);
  const inc = await one('SELECT count(*)::int AS n FROM svc_incidents WHERE order_id=$1', [o.id]);
  stages.push(stage('performance', 'Supplier performance', rating ? 'done' : 'pending', rating ? `Rated ${rating.stars}/5 by the buyer` : 'Not rated yet', { entity: 'svc_order', id: o.id }, { issues: inc.n, rating: rating?.stars ?? null }));
  return { order_id: o.id, number: o.number, route: isTender ? 'tender' : rfq ? 'rfq' : 'direct', sides: [buy && 'buyer', sup && 'supplier'].filter(Boolean), stages };
}

cap({
  name: 'get_procurement_chain', method: 'GET', path: '/service-orders/:id/chain', tag: TAG,
  summary: 'The whole commercial chain of one order in one place: demand → RFQ or tender → bids → evaluation → award → order → delivery/receiving and acceptance → invoice and matching → payment → event budget (committed and actual) → supplier performance. Each stage names the canonical record it comes from. A supplier sees only its own side (never competing bids); the buyer sees counts, not other suppliers’ prices.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const o = await one('SELECT * FROM svc_orders WHERE id=$1', [i.id]);
    if (!o) throw notFound('Order');
    const { sup, buy } = await tx((c) => anySide(user, o, c));
    return chainOf(o, { buy, sup });
  },
});

cap({
  name: 'get_procurement_order_chain', method: 'GET', path: '/procurement-orders/:id/chain', tag: TAG,
  summary: 'The same chain, opened from a tender order. An older tender order that has no service order yet is shown with a gap at delivery; link_procurement_order_to_service_order fixes it without losing anything.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const po = await one('SELECT * FROM proc_orders WHERE id=$1', [i.id]);
    if (!po) throw notFound('Order');
    const p = await getProject(po.project_id);
    const roles = await buyerRoles(user, p);
    const supplier = !!(await one("SELECT 1 AS x FROM supplier_entity_members WHERE entity_id=$1 AND user_id=$2 AND status='active'", [po.entity_id, user.id]));
    if (!roles.length && !supplier) throw notFound('Order');
    if (!po.svc_order_id) return { order_id: null, number: po.ref, route: 'tender', sides: [roles.length && 'buyer', supplier && 'supplier'].filter(Boolean), unlinked: true,
      stages: [{ key: 'order', label: 'Order', status: 'active', summary: `${po.ref} · ${po.status}`, canonical: { entity: 'proc_order', id: po.id }, facts: {} }, { key: 'fulfilment', label: 'Delivery & acceptance', status: 'gap', summary: 'Not linked to a service order yet', canonical: null, facts: {} }] };
    const o = await one('SELECT * FROM svc_orders WHERE id=$1', [po.svc_order_id]);
    return chainOf(o, { buy: roles.length ? {} : null, sup: supplier ? {} : null });
  },
});

cap({
  name: 'link_procurement_order_to_service_order', method: 'POST', path: '/procurement-orders/:id/service-order', tag: TAG,
  summary: 'Buying team with order authority: give a tender order that was accepted before this chain existed its service order, so delivery, acceptance, invoices and payments run in one place. Idempotent. An existing budget commitment is taken over by the service order, never duplicated; nothing is deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const po = (await c.query('SELECT * FROM proc_orders WHERE id=$1', [i.id])).rows[0];
      if (!po) throw notFound('Order');
      const p = await getProject(po.project_id, c);
      if (!can(await buyerRoles(user, p, c), 'order')) throw notFound('Order');
      if (['cancelled'].includes(po.status)) throw conflict('The order is cancelled');
      const { order, created } = await ensureServiceOrder(c, po.id, user);
      if (created) {
        const { line } = await commitTenderOrder(c, order, p, undefined, user);
        await auditLog(c, p.id, user.id, 'service_order_linked', { order_id: po.id, service_order_id: order.id, budget_line_id: line?.id ?? null });
      }
      return { ...order, created };
    });
  },
});

cap({
  name: 'rate_service_order', method: 'POST', path: '/service-orders/:id/rating', tag: TAG, status: 201,
  summary: 'Buyer (acceptor or purchaser): rate the supplier on a delivered order, 1–5 with an optional comment. Allowed once something was accepted; one rating per order; it is append-only and never edited. It feeds the supplier performance record as one dimension with its sample size, not as a hidden score.',
  input: z.object({ id, stars: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = (await c.query('SELECT * FROM svc_orders WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!o) throw notFound('Order');
      const { buy } = await orderSide(user, o, { buyer: ['acceptor', 'purchaser'], supplier: false }, c);
      if (!buy) throw notFound('Order');
      const acc = (await c.query("SELECT coalesce(sum(qty_accepted),0)::float AS a FROM svc_order_lines WHERE order_id=$1 AND status='active'", [o.id])).rows[0].a;
      if (acc <= 0) throw conflict('Rate a supplier after something was accepted');
      const row = (await c.query('INSERT INTO svc_order_ratings(order_id, profile_id, buyer_id, rated_by, stars, comment) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (order_id) DO NOTHING RETURNING *', [o.id, o.profile_id, o.buyer_id, user.id, i.stars, i.comment ?? null])).rows[0];
      if (!row) throw conflict('This order was already rated');
      await log(c, 'order', o.id, user.id, 'rated', { stars: i.stars });
      for (const u of await supplierAudience(c, o.profile_id)) await notify(c, u, { kind: 'svc_order_rated', title: 'A buyer rated an order', body: `Order ${o.number} was rated.`, data: { order_id: o.id }, dedupe_key: `svc:rated:${o.id}:${u}` });
      return { id: row.id, order_id: o.id, stars: row.stars, created_at: row.created_at };
    });
  },
});

/**
 * Facts about a supplier over a set of orders. Every dimension carries its sample size and a plain definition; none is combined into a score.
 * scope: { profileId, buyerId? } — a buyer only ever gets facts from its own orders, so no buyer reads another buyer's experience.
 */
export async function performanceOf({ profileId, buyerId = null }) {
  const a = [profileId, buyerId];
  const w = 'o.profile_id=$1 AND ($2::uuid IS NULL OR o.buyer_id=$2)';
  const [orders] = await many(`SELECT count(*)::int AS n, count(*) FILTER (WHERE o.status NOT IN ('cancelled','rejected','terminated','pending_supplier','changes_proposed'))::int AS live, count(DISTINCT o.buyer_id)::int AS buyers FROM svc_orders o WHERE ${w}`, a);
  const [vis] = await many(`SELECT count(*) FILTER (WHERE v.status IN ('submitted_for_acceptance','accepted','partially_accepted','rework','rejected'))::int AS reached,
      count(*) FILTER (WHERE v.status IN ('submitted_for_acceptance','accepted','partially_accepted') AND v.updated_at <= v.ends_at + interval '24 hours')::int AS on_time,
      count(*) FILTER (WHERE v.status IN ('rework','rejected'))::int AS rework, count(*) FILTER (WHERE v.status='no_show')::int AS no_show, count(*)::int AS visits
    FROM svc_visits v JOIN svc_orders o ON o.id=v.order_id WHERE ${w} AND v.status <> 'cancelled'`, a);
  const [acc] = await many(`SELECT count(*) FILTER (WHERE x.decision='accepted')::int AS accepted, count(*) FILTER (WHERE x.decision='rejected')::int AS rejected FROM svc_acceptances x JOIN svc_orders o ON o.id=x.order_id WHERE ${w}`, a);
  const [inc] = await many(`SELECT count(*)::int AS n FROM svc_incidents x JOIN svc_orders o ON o.id=x.order_id WHERE ${w} AND x.kind IN ('incident','exception')`, a);
  const [inv] = await many(`SELECT count(*)::int AS issued, count(*) FILTER (WHERE s.match_status IN ('exception','exception_approved'))::int AS disputed FROM svc_invoices s JOIN svc_orders o ON o.id=s.order_id WHERE ${w} AND s.status='issued' AND s.doc_type='invoice'`, a);
  const [resp] = await many(`SELECT count(*) FILTER (WHERE v.responded_at IS NOT NULL)::int AS n, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (v.responded_at - v.created_at))/3600) FILTER (WHERE v.responded_at IS NOT NULL)::numeric, 1)::float AS median_hours
    FROM svc_invites v JOIN svc_rfqs r ON r.id=v.rfq_id WHERE v.profile_id=$1 AND ($2::uuid IS NULL OR r.buyer_id=$2) AND r.status <> 'draft'`, a);
  const [rate] = await many(`SELECT count(*)::int AS n, round(avg(r.stars)::numeric, 2)::float AS avg FROM svc_order_ratings r JOIN svc_orders o ON o.id=r.order_id WHERE ${w}`, a);
  const dim = (key, label, value, n, unit, definition) => ({ key, label, value: n ? value : null, n, unit, definition, reliable: n >= MIN_SAMPLE, note: n === 0 ? 'No evidence yet' : n < MIN_SAMPLE ? `Only ${n} observation(s); fewer than ${MIN_SAMPLE} is shown for information, not as a track record` : null });
  return {
    orders: { total: orders.n, delivered_or_live: orders.live, buyers: orders.buyers }, min_sample: MIN_SAMPLE,
    dimensions: [
      dim('on_time_delivery', 'On-time delivery', vis.reached ? vis.on_time / vis.reached : 0, vis.reached, 'ratio', 'Visits submitted for acceptance no later than 24 hours after their planned end ÷ visits that reached submission'),
      dim('acceptance', 'Accepted first time', (acc.accepted + acc.rejected) ? acc.accepted / (acc.accepted + acc.rejected) : 0, acc.accepted + acc.rejected, 'ratio', 'Acceptance decisions that accepted ÷ all acceptance decisions (accepted + rejected)'),
      dim('rework', 'Rework or rejection', vis.visits ? vis.rework / vis.visits : 0, vis.visits, 'ratio', 'Visits sent back for rework or rejected ÷ visits held'),
      dim('no_show', 'No-shows', vis.visits ? vis.no_show / vis.visits : 0, vis.visits, 'ratio', 'Visits recorded as a no-show ÷ visits held'),
      dim('issues', 'Issues per order', orders.n ? inc.n / orders.n : 0, orders.n, 'count_per_order', 'Incidents and exceptions reported ÷ orders'),
      dim('invoice_disputes', 'Invoices needing a matching decision', inv.issued ? inv.disputed / inv.issued : 0, inv.issued, 'ratio', 'Issued invoices that did not match accepted work (exception or approved exception) ÷ issued invoices'),
      dim('response_time', 'Median response time to invitations', resp.median_hours, resp.n, 'hours', 'Hours from an RFQ invitation to the supplier’s reply'),
      dim('buyer_rating', 'Buyer rating', rate.avg, rate.n, 'stars_1_5', 'Average of buyers’ 1–5 ratings, one per order'),
    ],
    method: 'Facts only. Each dimension is computed from the order, visit, acceptance, invoice and rating records; there is no combined or hidden score, and promoted or subscribed placement never changes any figure.',
  };
}

cap({
  name: 'get_supplier_performance', method: 'GET', path: '/supplier-profiles/:id/performance', tag: TAG,
  summary: 'Evidence-based supplier performance: on-time delivery, first-time acceptance, rework, no-shows, issues per order, invoice matching exceptions, response time and buyer rating — each with its sample size, definition and a reliability flag (fewer than 5 observations is shown but marked). The supplier sees all its own orders; a buyer (pass buyer_id) sees only the facts from its own orders. No composite score.',
  input: z.object({ id, buyer_id: id.optional() }),
  async handler({ user }, i) {
    if (i.buyer_id) {
      await buyerAccess(user, i.buyer_id, ['purchaser', 'requester', 'evaluator', 'approver', 'acceptor', 'finance']);
      if (!(await one('SELECT 1 AS x FROM svc_orders WHERE profile_id=$1 AND buyer_id=$2 LIMIT 1', [i.id, i.buyer_id])) && !(await one('SELECT 1 AS x FROM svc_invites v JOIN svc_rfqs r ON r.id=v.rfq_id WHERE v.profile_id=$1 AND r.buyer_id=$2 LIMIT 1', [i.id, i.buyer_id]))) throw notFound('Supplier');
      return { profile_id: i.id, scope: 'buyer', ...(await performanceOf({ profileId: i.id, buyerId: i.buyer_id })) };
    }
    await supplierAccess(user, i.id, ['owner', 'finance', 'sales', 'scheduler', 'supervisor']);
    return { profile_id: i.id, scope: 'supplier', ...(await performanceOf({ profileId: i.id })) };
  },
});
