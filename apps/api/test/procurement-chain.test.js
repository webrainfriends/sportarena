// Procurement chain (#520): a tender award converges on ONE service order, and everything downstream (delivery or receiving, acceptance,
// invoice matching, payment, event budget, rating, performance) runs on it. One services tender and one goods tender, end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, ok, signup, start, stop, pool, world, bids, evaluate, awardAll, supplierEntity, part, goodDraft, closeNow, lots, rubric, questions, dateOf, inAt } from './tender-helpers.js';

before(start);
after(stop);

const orderOf = async (w, lot = 'L1') => {
  const list = ok(await call('GET', `/procurement-orders?project_id=${w.t.id}`, { token: w.owner.token }));
  return ok(await call('GET', `/procurement-orders/${list.find((o) => o.lot_code === lot).id}`, { token: w.owner.token }));
};
const sv = async (path, token, method = 'GET', body) => call(method, path, { token, body });
const keyOf = (chain, k) => chain.stages.find((s) => s.key === k);

test('services tender: award → one service order → delivery → acceptance → matched invoice → payment → rating → chain and performance', async () => {
  const w = await world({}, [['A', 100000], ['B', 90000]]);
  await bids(w); await evaluate(w, { marks: { A: [9, 8], B: [6, 6] } });
  await awardAll(w, 'highest_score', w.sup.A.user);
  const po = await orderOf(w);
  assert.ok(po.service_order?.id, 'a tender order always has its service order');
  const so = ok(await sv(`/service-orders/${po.service_order.id}`, w.owner.token));
  assert.equal(so.source, 'tender'); assert.equal(so.status, 'confirmed'); assert.equal(so.proc_order_id, po.id);
  assert.ok(!so.terms.capacity_warning, so.terms.capacity_warning); // a profile created from a tender has no daily cap, so no calendar rows are needed; capped profiles reserve as usual
  assert.equal(so.lines.length, 1); assert.equal(so.lines[0].line_type, 'service'); assert.equal(Number(so.lines[0].qty_ordered), 2);
  // the order is priced from the winning bid's own lines (tax from the bid), not re-typed
  assert.equal(Number(so.net_minor), 500000 * 2); assert.equal(Number(so.tax_minor), 180000); assert.equal(Number(so.gross_minor), 1180000);
  // exactly one service order per accepted award line, however often it is asked for
  const again = ok(await sv(`/procurement-orders/${po.id}/service-order`, w.owner.token, 'POST', {}));
  assert.equal(again.id, so.id); assert.equal(again.created, false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM svc_orders WHERE proc_order_id=$1', [po.id])).rows[0].n, 1);
  // the contract record cannot be started or completed by hand: delivery is the service order's job
  assert.equal((await sv(`/procurement-orders/${po.id}/update`, w.sup.A.user.token, 'POST', { action: 'start' })).status, 409);

  // delivery: the supplier schedules and reports, the buyer (not the supplier) accepts
  const visit = ok(await sv(`/service-orders/${so.id}/visits`, w.sup.A.user.token, 'POST', { line_no: 1, starts_at: inAt(41, 8), duration_minutes: 60, planned_qty: 2 }), 201).visits[0];
  ok(await sv(`/service-visits/${visit.id}/status`, w.sup.A.user.token, 'POST', { row_version: visit.row_version, status: 'in_progress' }));
  const cur = ok(await sv(`/service-orders/${so.id}/visits`, w.sup.A.user.token)).find((v) => v.id === visit.id);
  ok(await sv(`/service-visits/${visit.id}/status`, w.sup.A.user.token, 'POST', { row_version: cur.row_version, status: 'submitted_for_acceptance', actual_qty: 2 }));
  assert.ok([403, 404].includes((await sv(`/service-orders/${so.id}/acceptance`, w.sup.A.user.token, 'POST', { line_no: 1, visit_id: visit.id, decision: 'accepted', quantity: 2 })).status), 'the supplier cannot accept its own work');
  // invoicing before acceptance is refused; after acceptance it matches
  const early = await sv(`/service-orders/${so.id}/invoices`, w.sup.A.user.token, 'POST', { kind: 'progress', lines: [{ line_no: 1, quantity: 2 }] });
  assert.equal(early.status, 409, 'cannot bill work the buyer has not accepted');
  ok(await sv(`/service-orders/${so.id}/acceptance`, w.owner.token, 'POST', { line_no: 1, visit_id: visit.id, decision: 'accepted', quantity: 2 }), 201);
  const inv = ok(await sv(`/service-orders/${so.id}/invoices`, w.sup.A.user.token, 'POST', { kind: 'final', lines: [{ line_no: 1, quantity: 2 }] }), 201);
  const issued = ok(await sv(`/service-invoices/${inv.id}/issue`, w.sup.A.user.token, 'POST'));
  assert.equal(issued.match_status, 'matched');
  ok(await sv(`/service-invoices/${inv.id}/payments`, w.owner.token, 'POST', { source: 'manual_bank', amount_minor: Number(issued.payable_minor), paid_on: dateOf(0), reference: 'UTR-520', evidence: 'bank statement line 9', idempotency_key: 'pay-520' }), 201);

  // chain: buyer sees counts, the supplier sees only its own side
  const buyerChain = ok(await sv(`/service-orders/${so.id}/chain`, w.owner.token));
  assert.deepEqual(buyerChain.stages.map((s) => s.key), ['demand', 'sourcing', 'response', 'evaluation', 'award', 'order', 'fulfilment', 'invoice', 'payment', 'performance']);
  assert.equal(buyerChain.route, 'tender'); assert.equal(keyOf(buyerChain, 'response').facts.bids_received, 2);
  assert.equal(keyOf(buyerChain, 'fulfilment').status, 'done'); assert.equal(keyOf(buyerChain, 'invoice').facts.matched, 1); assert.equal(keyOf(buyerChain, 'payment').status, 'done');
  const supplierChain = ok(await sv(`/service-orders/${so.id}/chain`, w.sup.A.user.token));
  assert.equal(keyOf(supplierChain, 'response').facts.bids_received, undefined, 'a supplier never learns how many competitors bid');
  assert.ok(!JSON.stringify(supplierChain).includes('Supplier B'));
  // the same chain is reachable from the tender order
  assert.equal(ok(await sv(`/procurement-orders/${po.id}/chain`, w.owner.token)).order_id, so.id);
  // losing supplier B and an outsider get nothing
  const stranger = await signup('stranger', ['athlete']);
  for (const tok of [w.sup.B.user.token, stranger.token]) { assert.equal((await sv(`/service-orders/${so.id}/chain`, tok)).status, 404); assert.equal((await sv(`/procurement-orders/${po.id}/chain`, tok)).status, 404); assert.equal((await sv(`/service-orders/${so.id}`, tok)).status, 404); }

  // rating: buyer side only, once, append-only; then performance carries n and flags thin evidence
  assert.equal((await sv(`/service-orders/${so.id}/rating`, w.sup.A.user.token, 'POST', { stars: 5 })).status, 404, 'a supplier cannot rate itself');
  ok(await sv(`/service-orders/${so.id}/rating`, w.owner.token, 'POST', { stars: 4, comment: 'Pitches ready on time' }), 201);
  assert.equal((await sv(`/service-orders/${so.id}/rating`, w.owner.token, 'POST', { stars: 1 })).status, 409);
  await assert.rejects(pool.query('UPDATE svc_order_ratings SET stars=1'), /append-only/);
  const prof = so.profile_id;
  const perf = ok(await sv(`/supplier-profiles/${prof}/performance`, w.sup.A.user.token));
  const dim = (k) => perf.dimensions.find((d) => d.key === k);
  assert.equal(perf.scope, 'supplier'); assert.equal(dim('buyer_rating').value, 4); assert.equal(dim('buyer_rating').n, 1); assert.equal(dim('buyer_rating').reliable, false);
  assert.equal(dim('acceptance').value, 1); assert.equal(dim('acceptance').n, 1); assert.ok(!('score' in perf) && !('overall' in perf), 'no composite score');
  assert.equal(dim('no_show').n, 1);
  const buyerPerf = ok(await sv(`/supplier-profiles/${prof}/performance?buyer_id=${so.buyer_id}`, w.owner.token));
  assert.equal(buyerPerf.scope, 'buyer'); assert.equal(buyerPerf.orders.total, 2, 'both lots of the tender are orders with this buyer');
  assert.equal((await sv(`/supplier-profiles/${prof}/performance`, w.owner.token)).status, 404, 'a buyer cannot read the supplier-wide record');
  assert.equal((await sv(`/supplier-profiles/${prof}/performance?buyer_id=${so.buyer_id}`, stranger.token)).status, 404);
  // the contract record follows the delivery record
  assert.equal((await orderOf(w)).service_order.settlement, 'paid');
});

/** A one-supplier tender for an event whose lots are goods or services; resolves to the accepted order. */
async function eventTender({ supply_kind, budgetCap = null }) {
  const owner = await signup('organiser', ['organizer']), approver = await signup('apprev', ['organizer']);
  const ev = ok(await call('POST', '/events', { token: owner.token, body: { name: 'District cup', sport: 'cricket', starts_on: dateOf(40), ends_on: dateOf(45) } }), 201);
  const t = ok(await call('POST', '/rfps', { token: owner.token, body: { title: 'Cup supplies', category: 'Equipment', event_id: ev.id } }), 201);
  ok(await call('POST', `/rfps/${t.id}/members`, { token: owner.token, body: { handle: approver.handle, role: 'approver' } }));
  ok(await call('PATCH', `/rfps/${t.id}`, { token: owner.token, body: { row_version: t.row_version, scope: 'Supply the cup.', service_start: dateOf(40), service_end: dateOf(45), closes_at: inAt(10), lots: lots.map((l) => ({ ...l, supply_kind })), questions, rubric: rubric({ weights: { technical: 50, commercial: 50 } }), quorum: 1, envelope_mode: 'sealed_single', budget_minor: 6000000 } }));
  const ap = ok(await call('POST', `/rfps/${t.id}/request-approval`, { token: owner.token }));
  ok(await call('POST', `/approvals/${ap.id}/decide`, { token: approver.token, body: { decision: 'approve' } }));
  ok(await call('POST', `/rfps/${t.id}/publish`, { token: owner.token }));
  const chair = await signup('chair', ['organizer']), tech = await signup('tech', ['organizer']);
  for (const [u, role] of [[chair, 'chair'], [tech, 'technical_evaluator']]) ok(await call('POST', `/rfps/${t.id}/members`, { token: owner.token, body: { handle: u.handle, role } }));
  const su = await signup('supplierG', ['supplier']), se = await supplierEntity(su, 'Cup Supplies Ltd');
  await part(su, t, se);
  const pr = ok(await call('POST', `/tenders/${t.id}/proposals`, { token: su.token, body: { entity_id: se.id, lots: ['L1', 'L2'] } }), 201);
  ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: su.token, body: { draft_version: pr.draft_version, ...goodDraft(100000) } }));
  ok(await call('POST', `/proposals/${pr.id}/submit`, { token: su.token, body: { idempotency_key: `g-${pr.id}`, declaration: true } }));
  await closeNow(t.id);
  ok(await call('POST', `/rfps/${t.id}/open`, { token: owner.token, body: { envelope: 'technical' } }));
  ok(await call('POST', `/rfps/${t.id}/conflicts`, { token: tech.token, body: { has_conflict: false } }));
  ok(await call('POST', `/rfps/${t.id}/assignments`, { token: owner.token, body: { assignments: [{ handle: tech.handle, section: 'technical' }] } }));
  for (const c of ['scope', 'safety']) ok(await call('POST', `/rfps/${t.id}/scores`, { token: tech.token, body: { proposal_id: pr.id, criterion_key: c, score: 8, rationale: `Scored ${c} from the evidence`, lock: true } }), 201);
  ok(await call('POST', `/rfps/${t.id}/ranking/commit`, { token: chair.token, body: {} }), 201);
  const sc = ok(await call('POST', `/rfps/${t.id}/scenarios`, { token: chair.token, body: { kind: 'highest_score' } }), 201);
  const rec = ok(await call('POST', `/rfps/${t.id}/awards`, { token: chair.token, body: { scenario_id: sc.id, rationale: 'Only eligible bidder, within the event budget.' } }), 201);
  ok(await call('POST', `/approvals/${rec.approval_id}/decide`, { token: approver.token, body: { decision: 'approve' } }));
  ok(await call('POST', `/awards/${rec.id}/notify`, { token: chair.token, body: {} }));
  const award = ok(await call('GET', `/awards/${rec.id}`, { token: chair.token }));
  return { owner, su, ev, t, award };
}

test('goods tender on an event: one commitment on the event budget, receiving controls billing, cancelling releases it, history is kept', async () => {
  const g = await eventTender({ supply_kind: 'goods' });
  // two competing acceptance requests per line still create one service order and one budget line each
  await Promise.all(g.award.lines.flatMap((l) => [0, 1].map(() => call('POST', `/award-lines/${l.id}/respond`, { token: g.su.token, body: { action: 'accept' } }))));
  const orders = ok(await call('GET', `/procurement-orders?project_id=${g.t.id}`, { token: g.owner.token }));
  assert.equal(orders.length, 2); assert.ok(orders.every((o) => o.svc_order_id));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM svc_orders WHERE source=\'tender\' AND event_id=$1', [g.ev.id])).rows[0].n, 2);
  const lines = (await pool.query("SELECT id, committed_cents::int AS c, status, svc_order_id, proc_order_id FROM event_budget_lines WHERE event_id=$1 AND proc_order_id IS NOT NULL", [g.ev.id])).rows;
  assert.equal(lines.length, 2, 'one commitment per order, owned by the service order'); assert.ok(lines.every((l) => l.status === 'committed' && l.svc_order_id));
  assert.equal(lines.reduce((a, l) => a + l.c, 0), 4600000, 'the tender is priced net, so the net award is committed');
  const so = ok(await call('GET', `/service-orders/${orders[0].svc_order_id}`, { token: g.owner.token }));
  assert.equal(so.lines[0].line_type, 'goods');
  // receiving gates the invoice
  const first = await call('POST', `/service-orders/${so.id}/invoices`, { token: g.su.token, body: { kind: 'progress', lines: [{ line_no: 1, quantity: 1 }] } });
  assert.equal(first.status, 409, 'nothing received yet, nothing can be billed');
  ok(await call('POST', `/service-orders/${so.id}/acceptance`, { token: g.owner.token, body: { line_no: 1, decision: 'accepted', quantity: 1 } }), 201);
  const inv = ok(await call('POST', `/service-orders/${so.id}/invoices`, { token: g.su.token, body: { kind: 'progress', lines: [{ line_no: 1, quantity: 1 }] } }), 201);
  assert.equal((await call('POST', `/service-orders/${so.id}/invoices`, { token: g.su.token, body: { kind: 'progress', lines: [{ line_no: 1, quantity: 2 }] } })).status, 409, 'cannot bill more than was received');
  const issued = ok(await call('POST', `/service-invoices/${inv.id}/issue`, { token: g.su.token }));
  assert.equal(issued.match_status, 'matched');
  ok(await call('POST', `/service-invoices/${inv.id}/payments`, { token: g.owner.token, body: { source: 'manual_bank', amount_minor: Number(issued.payable_minor), paid_on: dateOf(0), reference: 'UTR-G1', evidence: 'bank slip' } }), 201);
  // budget: committed minus actual is what is still committed; the payment is mirrored once
  const chain = ok(await call('GET', `/service-orders/${so.id}/chain`, { token: g.owner.token }));
  const b = chain.stages.find((s) => s.key === 'budget');
  assert.equal(b.facts.committed_minor, Number(so.net_minor)); assert.equal(b.facts.actual_minor, Number(issued.payable_minor)); assert.equal(b.facts.remaining_commitment_minor, Number(so.net_minor) - Number(issued.payable_minor));
  assert.equal(chain.stages.find((s) => s.key === 'fulfilment').facts.supply, 'goods');
  // the other order has accepted nothing, so cancelling it releases its commitment; the line stays on record as void
  const other = orders.find((o) => o.svc_order_id !== so.id);
  ok(await call('POST', `/procurement-orders/${other.id}/update`, { token: g.owner.token, body: { action: 'cancel', reason: 'Event scope reduced' } }));
  assert.equal((await pool.query("SELECT status FROM event_budget_lines WHERE svc_order_id=$1", [other.svc_order_id])).rows[0].status, 'void');
  assert.equal((await pool.query('SELECT status FROM svc_orders WHERE id=$1', [other.svc_order_id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM proc_orders WHERE id=$1', [other.id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM svc_activity WHERE entity_id=$1', [other.svc_order_id])).rows[0].n > 0, true, 'history is kept');
  // an order with accepted work cannot simply be cancelled
  assert.equal((await call('POST', `/procurement-orders/${orders.find((o) => o.svc_order_id === so.id).id}/update`, { token: g.owner.token, body: { action: 'cancel', reason: 'Too late to cancel' } })).status, 409);
});

test('a spend cap on the event budget blocks acceptance, and nothing is half-created', async () => {
  const g = await eventTender({ supply_kind: 'service' });
  await pool.query("INSERT INTO event_budgets(event_id, currency, spend_cap_cents) VALUES ($1,'INR',900000) ON CONFLICT (event_id) DO UPDATE SET spend_cap_cents=900000", [g.ev.id]);
  const r = await call('POST', `/award-lines/${g.award.lines[0].id}/respond`, { token: g.su.token, body: { action: 'accept' } });
  assert.equal(r.status, 409); assert.match(JSON.stringify(r.body), /spend cap/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM svc_orders WHERE event_id=$1', [g.ev.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_orders WHERE project_id=$1', [g.t.id])).rows[0].n, 0);
});

test('performance is sample-size aware: thin evidence is shown but flagged, and no dimension is a hidden score', async () => {
  const w = await world({}, [['A', 100000]]);
  await bids(w); await evaluate(w, { marks: { A: [9, 8] } });
  await awardAll(w, 'highest_score', w.sup.A.user);
  const so = (await orderOf(w)).service_order;
  const prof = (await pool.query('SELECT profile_id FROM svc_orders WHERE id=$1', [so.id])).rows[0].profile_id;
  const perf = ok(await sv(`/supplier-profiles/${prof}/performance`, w.sup.A.user.token));
  assert.equal(perf.min_sample, 5);
  for (const d of perf.dimensions) { assert.ok(d.definition && 'n' in d); assert.equal(d.reliable, d.n >= 5); if (d.n === 0) assert.equal(d.value, null, 'no evidence is null, never a flattering zero'); }
  assert.ok(perf.dimensions.length >= 8);
});
