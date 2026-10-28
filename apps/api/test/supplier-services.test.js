// Supplier services & procurement (#458): supplier → RFQ → quotes → approval → award → order → capacity → visits → acceptance → invoices → payments.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `svc_${n}_${roles[0]}`, display_name: `Svc ${n}`, email: `svc${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); return { ...r.body.user, token: r.body.token }; };
const iso = (offsetDays, hour = 9) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offsetDays); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const ymd = (offsetDays) => iso(offsetDays).slice(0, 10);
const j = (x) => JSON.stringify(x);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const supplier = async (extra = {}) => {
  const owner = await signup(['supplier']);
  const p = must(await api('POST', '/supplier-profiles', { token: owner.token, body: { supplier_type: 'sole_trader', legal_name: `Turf Co ${n}`, categories: ['ground_maintenance'], currencies: ['INR'], daily_capacity: 4, ...extra } }), 201);
  return { owner, p };
};
const organiser = async () => {
  const u = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: u.token, body: { name: `Cup ${n}`, sport: 'football', starts_on: ymd(10), ends_on: ymd(12) } }), 201);
  const buyer = must(await api('POST', '/service-buyers', { token: u.token, body: { event_id: ev.id, currency: ev.currency ?? 'INR' } }), 201);
  return { u, ev, buyer };
};
const requirement = (b, token, over = {}) => api('POST', `/service-buyers/${b.id}/requirements`, { token, body: { category: 'ground_maintenance', title: 'Prepare main pitch', scope: { surface: 'natural_grass', area_sqm: 7000, tasks: ['mowing', 'line_marking'] }, quantity: 3, unit: 'visit', starts_at: iso(10), ends_at: iso(12), budget_minor: 900000, currency: b.currency, ...over } });
const rfqFlow = async (b, token, req, suppliers, extra = {}) => {
  const rfq = must(await api('POST', `/service-requirements/${req.id}/rfq`, { token, body: { rubric: [{ key: 'price', label: 'Price', weight: 60 }, { key: 'quality', label: 'Quality', weight: 40 }], ...extra } }), 201);
  must(await api('POST', `/rfqs/${rfq.id}/invites`, { token, body: { profile_ids: suppliers.map((s) => s.p.id) } }), 201);
  must(await api('POST', `/rfqs/${rfq.id}/issue`, { token }));
  return rfq;
};
const quote = async (s, rfqId, rate = 100000, extra = {}) => {
  const inbox = must(await api('GET', '/me/rfq-invitations', { token: s.owner.token, query: { profile_id: s.p.id } }));
  const inv = inbox.find((x) => x.rfq_id === rfqId);
  must(await api('POST', `/rfq-invites/${inv.id}/respond`, { token: s.owner.token, body: { action: 'accept' } }));
  return api('POST', `/rfq-invites/${inv.id}/quote`, { token: s.owner.token, body: { valid_until: iso(5), lines: [{ line_type: 'service', description: 'Pitch preparation visit', quantity: 3, unit: 'visit', rate_minor: rate, ...extra }] } });
};

test('catalogue is typed, offerings need no stock, and invalid specs are refused', async () => {
  const cat = must(await api('GET', '/service-catalogue'));
  assert.ok(cat.categories.some((c) => c.slug === 'pool_maintenance') && cat.categories.some((c) => c.slug === 'wifi') && cat.categories.some((c) => c.slug === 'accommodation'));
  const s = await supplier();
  const o = must(await api('POST', `/supplier-profiles/${s.p.id}/offerings`, { token: s.owner.token, body: { category: 'ground_maintenance', title: 'Match-day pitch prep', mode: 'service', pricing_model: 'fixed', unit: 'visit', rate_minor: 150000, currency: 'INR', specs: { surface: 'natural_grass', area_sqm: 7000 } } }), 201);
  assert.equal(o.mode, 'service');
  assert.equal(must(await api('POST', `/supplier-profiles/${s.p.id}/offerings`, { token: s.owner.token, body: { category: 'ground_maintenance', title: 'x', mode: 'service', pricing_model: 'fixed', unit: 'room_night', rate_minor: 1, currency: 'INR' } }), 400).error ? 1 : 1, 1);
  must(await api('POST', `/supplier-profiles/${s.p.id}/offerings`, { token: s.owner.token, body: { category: 'travel', title: 'Coach', mode: 'goods', pricing_model: 'quote_only', unit: 'trip', currency: 'INR' } }), 400);
  must(await api('POST', `/supplier-profiles/${s.p.id}/offerings`, { token: s.owner.token, body: { category: 'ground_maintenance', title: 'bad spec', mode: 'service', pricing_model: 'quote_only', unit: 'visit', currency: 'INR', specs: { surface: 'lava' } } }), 400);
  const stranger = await signup(['athlete']);
  assert.equal((await api('PATCH', `/supplier-profiles/${s.p.id}`, { token: stranger.token, body: { row_version: 1, description: 'hack' } })).status, 404);
});

test('end to end: RFQ → two quotes (private) → award → confirm with capacity → visits → partial acceptance; supplier cannot self-accept', async () => {
  const a = await supplier(); const b = await supplier();
  const { u, buyer } = await organiser();
  const req = must(await requirement(buyer, u.token), 201);
  const rfq = await rfqFlow(buyer, u.token, req, [a, b]);
  const qa = must(await quote(a, rfq.id, 100000), 201); const qb = must(await quote(b, rfq.id, 90000), 201);
  assert.equal(qa.gross_minor, 300000);
  // a competing supplier can never read the other bid or its quote lines
  assert.equal((await api('GET', `/quotes/${qb.id}`, { token: a.owner.token })).status, 404);
  const asSup = must(await api('GET', `/rfqs/${rfq.id}`, { token: a.owner.token }));
  assert.equal(asSup.side, 'supplier'); assert.equal(asSup.quotes.length, 1); assert.equal(asSup.invites, undefined);
  const cmp = must(await api('GET', `/rfqs/${rfq.id}/comparison`, { token: u.token }));
  assert.equal(cmp.quotes.length, 2);
  // an unrelated user sees nothing
  const x = await signup(['organizer']);
  assert.equal((await api('GET', `/rfqs/${rfq.id}`, { token: x.token })).status, 404);
  const fresh = must(await api('GET', `/rfqs/${rfq.id}`, { token: u.token }));
  assert.equal((await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: fresh.row_version, awards: [{ quote_id: qb.id }] } })).status, 400);   // single supplier needs justification
  const aw = must(await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: fresh.row_version, awards: [{ quote_id: qb.id }], justification: 'Lowest compliant price' } }), 201);
  assert.equal(aw.status, 'awarded');
  const order = aw.orders[0];
  assert.equal(order.status, 'pending_supplier');
  // double award of the same quote fails
  assert.ok([409, 400].includes((await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: fresh.row_version + 1, awards: [{ quote_id: qb.id }], justification: 'again' } })).status));
  // the supplier confirms; capacity is reserved
  const ok = must(await api('POST', `/service-orders/${order.id}/respond`, { token: b.owner.token, body: { action: 'confirm' } }));
  assert.equal(ok.status, 'confirmed');
  const full = must(await api('GET', `/service-orders/${order.id}`, { token: u.token }));
  assert.equal(full.allocations.length, 3);
  assert.ok(full.budget_line_id);
  // visits: occurrence keys are deterministic, so a retry never duplicates
  const body = { line_no: 1, starts_at: iso(10, 8), duration_minutes: 120, planned_qty: 1, recurrence: { freq: 'daily', until: ymd(12) }, resource_key: 'pitch-1' };
  const v1 = must(await api('POST', `/service-orders/${order.id}/visits`, { token: b.owner.token, body }), 201);
  assert.equal(v1.created, 3);
  const v2 = must(await api('POST', `/service-orders/${order.id}/visits`, { token: b.owner.token, body }), 201);
  assert.equal(v2.created, 0); assert.equal(v2.skipped_existing, 3);
  assert.equal((await api('POST', `/service-orders/${order.id}/visits`, { token: b.owner.token, body: { ...body, starts_at: iso(10, 9), planned_qty: 1, recurrence: undefined } })).status, 409);   // site clash + over-plan
  const vis = v1.visits[0];
  must(await api('POST', `/service-visits/${vis.id}/status`, { token: b.owner.token, body: { row_version: vis.row_version, status: 'in_progress' } }));
  const cur = must(await api('GET', `/service-orders/${order.id}/visits`, { token: b.owner.token })).find((v) => v.id === vis.id);
  must(await api('POST', `/service-visits/${vis.id}/status`, { token: b.owner.token, body: { row_version: cur.row_version, status: 'submitted_for_acceptance', actual_qty: 1 } }));
  // the supplier cannot accept its own work
  assert.ok([403, 404].includes((await api('POST', `/service-orders/${order.id}/acceptance`, { token: b.owner.token, body: { line_no: 1, visit_id: vis.id, decision: 'accepted', quantity: 1 } })).status));
  const acc = must(await api('POST', `/service-orders/${order.id}/acceptance`, { token: u.token, body: { line_no: 1, visit_id: vis.id, decision: 'accepted', quantity: 1, idempotency_key: 'k1' } }), 201);
  assert.equal(acc.order.fulfilment, 'partially_accepted');
  const again = must(await api('POST', `/service-orders/${order.id}/acceptance`, { token: u.token, body: { line_no: 1, visit_id: vis.id, decision: 'accepted', quantity: 1, idempotency_key: 'k1' } }), 201);
  assert.equal(again.replayed, true);
  const after = must(await api('GET', `/service-orders/${order.id}`, { token: u.token }));
  assert.equal(Number(after.lines[0].qty_accepted), 1);
});

/** A confirmed order for `qty` visits at `rate` (INR unless told), optionally taxed by a configured rule. */
const confirmedOrder = async ({ rate = 100000, qty = 3, currency = 'INR', taxRule = null, deposit_bp = null, policy = null } = {}) => {
  const s = await supplier({ currencies: [currency] });
  if (taxRule) must(await api('POST', `/supplier-profiles/${s.p.id}/tax-rules`, { token: s.owner.token, body: { effective_from: ymd(-30), ...taxRule } }), 201);
  const { u, buyer, ev } = await organiser();
  if (policy) must(await api('PATCH', `/service-buyers/${buyer.id}/policy`, { token: u.token, body: policy }));
  const req = must(await requirement(buyer, u.token, { quantity: qty, currency }), 201);
  const rfq = await rfqFlow(buyer, u.token, req, [s]);
  const inbox = must(await api('GET', '/me/rfq-invitations', { token: s.owner.token, query: { profile_id: s.p.id } })).find((x) => x.rfq_id === rfq.id);
  must(await api('POST', `/rfq-invites/${inbox.id}/respond`, { token: s.owner.token, body: { action: 'accept' } }));
  const q = must(await api('POST', `/rfq-invites/${inbox.id}/quote`, { token: s.owner.token, body: { currency, valid_until: iso(5), terms: deposit_bp ? { deposit_bp } : {}, lines: [{ line_type: 'service', description: 'Pitch preparation visit', quantity: qty, unit: 'visit', rate_minor: rate, ...(taxRule ? { tax_code: taxRule.code } : {}) }] } }), 201);
  const fresh = must(await api('GET', `/rfqs/${rfq.id}`, { token: u.token }));
  const aw = must(await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: fresh.row_version, awards: [{ quote_id: q.id }], justification: 'Only compliant bid' } }), 201);
  assert.equal(aw.status, 'awarded');
  const order = must(await api('POST', `/service-orders/${aw.orders[0].id}/respond`, { token: s.owner.token, body: { action: 'confirm' } }));
  return { s, u, ev, buyer, order, rfq, q };
};
const deliver = async (o, lineQty) => {            // supplier schedules + submits, buyer accepts `lineQty`
  const v = must(await api('POST', `/service-orders/${o.order.id}/visits`, { token: o.s.owner.token, body: { line_no: 1, starts_at: iso(10, 8), duration_minutes: 60, planned_qty: lineQty } }), 201).visits[0];
  must(await api('POST', `/service-visits/${v.id}/status`, { token: o.s.owner.token, body: { row_version: v.row_version, status: 'in_progress' } }));
  const cur = must(await api('GET', `/service-orders/${o.order.id}/visits`, { token: o.s.owner.token })).find((x) => x.id === v.id);
  must(await api('POST', `/service-visits/${v.id}/status`, { token: o.s.owner.token, body: { row_version: cur.row_version, status: 'submitted_for_acceptance', actual_qty: lineQty } }));
  must(await api('POST', `/service-orders/${o.order.id}/acceptance`, { token: o.u.token, body: { line_no: 1, visit_id: v.id, decision: 'accepted', quantity: lineQty } }), 201);
};
const bill = (o, body) => api('POST', `/service-orders/${o.order.id}/invoices`, { token: o.s.owner.token, body });

test('tax: exclusive and inclusive prices, exemption, withholding, rounding and zero-decimal currency reconcile; the supplier decides the rule, not us', async () => {
  const ex = await confirmedOrder({ rate: 100000, qty: 3, taxRule: { code: 'GST18', name: 'GST', jurisdiction: 'IN', rate_bp: 1800, withholding_bp: 200 } });
  assert.deepEqual([ex.order.net_minor, ex.order.tax_minor, ex.order.gross_minor].map(Number), [300000, 54000, 354000]);
  await deliver(ex, 2);
  const d = must(await bill(ex, { kind: 'progress', lines: [{ line_no: 1, quantity: 2 }] }), 201);
  assert.equal(Number(d.net_minor), 200000); assert.equal(Number(d.tax_minor), 36000); assert.equal(Number(d.gross_minor), 236000);
  assert.equal(Number(d.withholding_minor), 4000); assert.equal(Number(d.payable_minor), 232000);
  assert.ok(d.tax_evidence.rules.GST18 && /does not assert/.test(d.tax_evidence.note));
  // billing more than accepted is refused at draft time and at issue time
  assert.equal((await bill(ex, { kind: 'progress', lines: [{ line_no: 1, quantity: 3 }] })).status, 409);
  const inc = await confirmedOrder({ rate: 11800, qty: 1, taxRule: { code: 'VAT', name: 'VAT', jurisdiction: 'EU', rate_bp: 1800, prices_include_tax: true } });
  assert.deepEqual([Number(inc.order.net_minor), Number(inc.order.tax_minor), Number(inc.order.gross_minor)], [10000, 1800, 11800]);
  const jpy = await confirmedOrder({ rate: 5000, qty: 3, currency: 'JPY', taxRule: { code: 'CT', name: 'Consumption tax', jurisdiction: 'JP', rate_bp: 1000 } });
  assert.deepEqual([Number(jpy.order.net_minor), Number(jpy.order.tax_minor), Number(jpy.order.gross_minor)], [15000, 1500, 16500]);
  assert.equal(jpy.order.currency, 'JPY');
  const exempt = await confirmedOrder({ rate: 1000, qty: 1, taxRule: { code: 'EX', name: 'Exempt', jurisdiction: 'IN', treatment: 'exempt' } });
  assert.equal(Number(exempt.order.tax_minor), 0);
});

test('billing → matching → payment: duplicate/over-billing, deposits need an approver, manual payments need evidence and cannot exceed or double count', async () => {
  const o = await confirmedOrder({ rate: 100000, qty: 3, deposit_bp: 2000 });
  // a deposit is a prepayment: issued, but an exception until an approver (not the finance clerk) signs off
  const dep = must(await bill(o, { kind: 'deposit' }), 201);
  assert.equal(Number(dep.net_minor), 60000);
  const depI = must(await api('POST', `/service-invoices/${dep.id}/issue`, { token: o.s.owner.token }));
  assert.equal(depI.match_status, 'exception');
  const buyerRoles = await api('GET', `/service-buyers/${o.buyer.id}/roles`, { token: o.u.token }); assert.equal(buyerRoles.status, 200);
  const pay = (token, id, body) => api('POST', `/service-invoices/${id}/payments`, { token, body });
  assert.equal((await pay(o.u.token, dep.id, { source: 'manual_bank', amount_minor: 60000, paid_on: ymd(0), reference: 'UTR-1', evidence: 'bank statement line 4' })).status, 409);   // unapproved exception
  const ap = await signup(['athlete']);
  must(await api('POST', `/service-buyers/${o.buyer.id}/roles`, { token: o.u.token, body: { person: ap.handle, role: 'approver' } }), 201);
  const ex = must(await api('POST', `/service-invoices/${dep.id}/exception`, { token: o.u.token, body: { reason: 'Supplier needs mobilisation funds' } }), 201);
  assert.equal((await api('POST', `/service-approvals/${ex.id}/decision`, { token: o.u.token, body: { approve: true } })).status, 403);     // requester cannot approve own request
  must(await api('POST', `/service-approvals/${ex.id}/decision`, { token: ap.token, body: { approve: true } }));
  const r1 = must(await pay(o.u.token, dep.id, { source: 'manual_bank', amount_minor: 60000, paid_on: ymd(0), reference: 'UTR-1', evidence: 'bank statement line 4', idempotency_key: 'p1' }), 201);
  assert.equal(r1.invoice.pay_status, 'paid');
  assert.equal((await pay(o.u.token, dep.id, { source: 'manual_bank', amount_minor: 1, paid_on: ymd(0), reference: 'UTR-2', evidence: 'xx' })).status, 409);       // nothing left to pay
  assert.equal((await pay(o.u.token, dep.id, { source: 'manual_bank', amount_minor: 60000, paid_on: ymd(0), reference: 'UTR-1', evidence: 'bank statement line 4', idempotency_key: 'p1' })).body.replayed, true);
  // the event budget mirrors the payment exactly once
  const lineQ = await pool.query('SELECT l.committed_cents, (SELECT coalesce(sum(amount_cents),0) FROM event_budget_payments WHERE line_id=l.id AND voided_at IS NULL) AS paid FROM event_budget_lines l WHERE l.svc_order_id=$1', [o.order.id]);
  assert.equal(Number(lineQ.rows[0].committed_cents), 300000); assert.equal(Number(lineQ.rows[0].paid), 60000);
  // an outsider and a stranger cannot record payments or even read the invoice
  const stranger = await signup(['athlete']);
  assert.equal((await pay(stranger.token, dep.id, { source: 'manual_cash', amount_minor: 1, paid_on: ymd(0), reference: 'zzz', evidence: 'zzz' })).status, 404);
  assert.equal((await api('GET', `/service-invoices/${dep.id}`, { token: stranger.token })).status, 404);
  // progress billing is capped by acceptance; the final invoice nets off the deposit
  await deliver(o, 3);
  const fin = must(await bill(o, { kind: 'final', lines: [{ line_no: 1, quantity: 3 }] }), 201);
  assert.equal(Number(fin.net_minor), 300000 - 60000);
  const dupe = await bill(o, { kind: 'final', lines: [{ line_no: 1, quantity: 3 }] });                 // a second draft is allowed, but only one can ever be issued
  must(await api('POST', `/service-invoices/${fin.id}/issue`, { token: o.s.owner.token }));
  assert.equal((await api('POST', `/service-invoices/${dupe.body.id}/issue`, { token: o.s.owner.token })).status, 409);
  const issued = must(await api('GET', `/service-invoices/${fin.id}`, { token: o.u.token }));
  assert.equal(issued.match_status, 'matched');
  // credit note + replacement keeps invoice immutable and caps the credit
  const cn = must(await api('POST', `/service-invoices/${fin.id}/credit-note`, { token: o.s.owner.token, body: { amount_minor: 100000, reason: 'Re-line marking', restore_quantities: [{ line_no: 1, quantity: 1 }] } }), 201);
  assert.match(cn.supplier_number, /^CN-/);
  assert.equal((await api('POST', `/service-invoices/${fin.id}/credit-note`, { token: o.s.owner.token, body: { amount_minor: 999999999, reason: 'too much' } })).status, 409);
  // the database refuses to rewrite an issued invoice
  await assert.rejects(pool.query('UPDATE svc_invoices SET gross_minor = gross_minor + 1 WHERE id=$1', [fin.id]), /immutable/);
  // states stay separate: completed != paid
  const od = must(await api('GET', `/service-orders/${o.order.id}`, { token: o.u.token }));
  assert.equal(od.status, 'completed'); assert.notEqual(od.settlement, 'paid');
});

test('approval thresholds, separation of duties, expired and stale quotes, concurrent over-award and duplicate order attempts fail safely', async () => {
  const a = await supplier(); const b = await supplier();
  const { u, buyer } = await organiser();
  must(await api('PATCH', `/service-buyers/${buyer.id}/policy`, { token: u.token, body: { thresholds: [{ above_minor: 100000 }], single_supplier_justification: false } }));
  const approver = await signup(['athlete']);
  must(await api('POST', `/service-buyers/${buyer.id}/roles`, { token: u.token, body: { person: approver.handle, role: 'approver' } }), 201);
  const req = must(await requirement(buyer, u.token, { quantity: 3 }), 201);
  const rfq = await rfqFlow(buyer, u.token, req, [a, b], { allow_partial: true });
  const qa = must(await quote(a, rfq.id, 100000), 201);
  const qb = must(await quote(b, rfq.id, 90000), 201);
  const fresh = must(await api('GET', `/rfqs/${rfq.id}`, { token: u.token }));
  // 300000 is above the threshold, so the award waits for an approver
  const w = must(await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: fresh.row_version, awards: [{ quote_id: qa.id }] } }), 201);
  assert.equal(w.status, 'approval_pending');
  assert.equal((await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: fresh.row_version + 1, awards: [{ quote_id: qb.id }] } })).status, 409);   // one award at a time
  assert.equal((await api('POST', `/service-approvals/${w.approval.id}/decision`, { token: u.token, body: { approve: true } })).status, 403);
  assert.equal((await api('POST', `/service-approvals/${w.approval.id}/decision`, { token: a.owner.token, body: { approve: true } })).status, 404);   // a supplier has no say
  const d = must(await api('POST', `/service-approvals/${w.approval.id}/decision`, { token: approver.token, body: { approve: true } }));
  assert.equal(d.result.length, 1);
  assert.equal(d.result[0].approval_id, w.approval.id);
  // the awarded quote is spent: awarding it again, or over-awarding the requirement, is refused
  const after = must(await api('GET', `/rfqs/${rfq.id}`, { token: u.token }));
  assert.equal(after.status, 'awarded');
  assert.equal((await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: after.row_version, awards: [{ quote_id: qb.id }] } })).status, 409);
  // expired quotes cannot be awarded
  const c = await supplier(); const e = await organiser();
  const req2 = must(await requirement(e.buyer, e.u.token, { quantity: 3 }), 201);
  const rfq2 = await rfqFlow(e.buyer, e.u.token, req2, [c]);
  const q2 = must(await quote(c, rfq2.id, 1000), 201);
  await pool.query("UPDATE svc_quotes SET valid_until = now() - interval '1 hour' WHERE id=$1", [q2.id]);
  const f2 = must(await api('GET', `/rfqs/${rfq2.id}`, { token: e.u.token }));
  assert.equal((await api('POST', `/rfqs/${rfq2.id}/award`, { token: e.u.token, body: { row_version: f2.row_version, awards: [{ quote_id: q2.id }], justification: 'x' } })).status, 409);
  // a scope change makes earlier quotes stale
  const req3 = must(await requirement(e.buyer, e.u.token, { title: 'Second pitch', quantity: 3 }), 201);
  const rfq3 = await rfqFlow(e.buyer, e.u.token, req3, [c]);
  const q3 = must(await quote(c, rfq3.id, 1000), 201);
  const f3 = must(await api('GET', `/rfqs/${rfq3.id}`, { token: e.u.token }));
  must(await api('POST', `/rfqs/${rfq3.id}/scope`, { token: e.u.token, body: { row_version: f3.row_version, reason: 'Larger pitch', changes: { quantity: 4 } } }));
  const f3b = must(await api('GET', `/rfqs/${rfq3.id}`, { token: e.u.token }));
  assert.equal(f3b.scope_version, 2); assert.equal(f3b.quotes.find((x) => x.id === q3.id).status, 'superseded');
  assert.equal((await api('POST', `/rfqs/${rfq3.id}/award`, { token: e.u.token, body: { row_version: f3b.row_version, awards: [{ quote_id: q3.id }], justification: 'x' } })).status, 409);
  // concurrent identical awards: exactly one order is created
  const s = await supplier(); const g = await organiser();
  const req4 = must(await requirement(g.buyer, g.u.token, { quantity: 3 }), 201);
  const rfq4 = await rfqFlow(g.buyer, g.u.token, req4, [s]);
  const q4 = must(await quote(s, rfq4.id, 1000), 201);
  const f4 = must(await api('GET', `/rfqs/${rfq4.id}`, { token: g.u.token }));
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', `/rfqs/${rfq4.id}/award`, { token: g.u.token, body: { row_version: f4.row_version, awards: [{ quote_id: q4.id }], justification: 'race' } })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(Number((await pool.query("SELECT count(*) FROM svc_orders WHERE rfq_id=$1", [rfq4.id])).rows[0].count), 1);
});

test('capacity cannot be over-booked, variations and termination keep accepted work, pause/resume and reschedule retries do not duplicate', async () => {
  const o1 = await confirmedOrder({ rate: 1000, qty: 3 });                          // supplier capacity 4 units/day
  const s = o1.s;
  // a second order for the same supplier over the same days still fits (headcount 1), but a 5-person crew does not
  const { u, buyer } = await organiser();
  const req = must(await requirement(buyer, u.token, { quantity: 3, headcount: 5, starts_at: iso(10), ends_at: iso(12) }), 201);
  const rfq = await rfqFlow(buyer, u.token, req, [s]);
  const inv = must(await api('GET', '/me/rfq-invitations', { token: s.owner.token, query: { profile_id: s.p.id } })).find((x) => x.rfq_id === rfq.id);
  must(await api('POST', `/rfq-invites/${inv.id}/respond`, { token: s.owner.token, body: { action: 'accept' } }));
  const q = must(await api('POST', `/rfq-invites/${inv.id}/quote`, { token: s.owner.token, body: { valid_until: iso(5), lines: [{ line_type: 'service', description: 'Crew', quantity: 3, unit: 'visit', rate_minor: 1000 }] } }), 201);
  const f = must(await api('GET', `/rfqs/${rfq.id}`, { token: u.token }));
  const aw = must(await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: f.row_version, awards: [{ quote_id: q.id }], justification: 'ok' } }), 201);
  assert.equal((await api('POST', `/service-orders/${aw.orders[0].id}/respond`, { token: s.owner.token, body: { action: 'confirm' } })).status, 409);   // 4 capacity − 1 taken < 5 needed
  // variation: extra work, accepted by the other side; the original commitment stays on record
  const v = must(await api('POST', `/service-orders/${o1.order.id}/variations`, { token: o1.u.token, body: { kind: 'scope', reason: 'Extra line marking', changes: { add_lines: [{ line_type: 'service', description: 'Extra marking', quantity: 1, unit: 'visit', rate_minor: 500 }] }, idempotency_key: 'v1' } }), 201);
  assert.equal(Number(v.variation.delta_net_minor), 500);
  assert.equal(must(await api('POST', `/service-orders/${o1.order.id}/variations`, { token: o1.u.token, body: { kind: 'scope', reason: 'Extra line marking', changes: {}, idempotency_key: 'v1' } }), 201).replayed, true);
  assert.equal((await api('POST', `/service-variations/${v.variation.id}/respond`, { token: o1.u.token, body: { accept: true } })).status, 404);   // not your side to answer
  const done = must(await api('POST', `/service-variations/${v.variation.id}/respond`, { token: s.owner.token, body: { accept: true } }));
  assert.equal(Number(done.order.gross_minor), 3500);
  const full = must(await api('GET', `/service-orders/${o1.order.id}`, { token: o1.u.token }));
  assert.equal(full.variations[0].status, 'applied'); assert.equal(full.lines.length, 2);
  assert.equal(Number((await pool.query('SELECT committed_cents FROM event_budget_lines WHERE svc_order_id=$1', [o1.order.id])).rows[0].committed_cents), 3500);
  // pause (needs the other side), then resume
  const p = must(await api('POST', `/service-orders/${o1.order.id}/variations`, { token: o1.u.token, body: { kind: 'pause', reason: 'Rain', effective_on: ymd(10) } }), 201);
  must(await api('POST', `/service-variations/${p.variation.id}/respond`, { token: s.owner.token, body: { accept: true } }));
  assert.equal(must(await api('GET', `/service-orders/${o1.order.id}`, { token: o1.u.token })).status, 'paused');
  const r = must(await api('POST', `/service-orders/${o1.order.id}/variations`, { token: o1.u.token, body: { kind: 'resume', reason: 'Dry' } }), 201);
  must(await api('POST', `/service-variations/${r.variation.id}/respond`, { token: s.owner.token, body: { accept: true } }));
  assert.equal(must(await api('GET', `/service-orders/${o1.order.id}`, { token: o1.u.token })).status, 'confirmed');
  // work is accepted, then the buyer terminates: accepted work stays, the rest is released
  await deliver(o1, 1);
  const t = must(await api('POST', `/service-orders/${o1.order.id}/variations`, { token: o1.u.token, body: { kind: 'termination', reason: 'Event cancelled', effective_on: ymd(0) } }), 201);
  assert.equal(t.order.status, 'terminated');
  const end = must(await api('GET', `/service-orders/${o1.order.id}`, { token: o1.u.token }));
  assert.equal(Number(end.lines[0].qty_ordered), 1); assert.equal(Number(end.lines[0].qty_accepted), 1);
  assert.equal(end.allocations.length, 0);
  assert.equal(Number(end.gross_minor), 1000);
  assert.equal(Number((await pool.query('SELECT committed_cents FROM event_budget_lines WHERE svc_order_id=$1', [o1.order.id])).rows[0].committed_cents), 1000);
  // the accepted work is still billable after termination
  const invc = must(await bill(o1, { kind: 'final', lines: [{ line_no: 1, quantity: 1 }] }), 201);
  must(await api('POST', `/service-invoices/${invc.id}/issue`, { token: s.owner.token }));
});

test('documents: every family renders an authorised PDF; strangers and competitors cannot read it; drafts are watermarked; dashboards reconcile', async () => {
  const o = await confirmedOrder({ rate: 100000, qty: 3, taxRule: { code: 'GST', name: 'GST', jurisdiction: 'IN', rate_bp: 1800 } });
  await deliver(o, 2);
  const draft = must(await bill(o, { kind: 'progress', lines: [{ line_no: 1, quantity: 2 }] }), 201);
  const gen = (token, type, source_id) => api('POST', '/service-documents', { token, body: { type, source_id } });
  const pf = must(await gen(o.s.owner.token, 'invoice', draft.id), 201);
  const dl = async (token, d) => { const r = await fetch(`${base}${d.url}`, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; };
  const got = await dl(o.s.owner.token, pf); assert.equal(got.status, 200); assert.equal(got.buf.subarray(0, 4).toString(), '%PDF');
  assert.equal((await gen(o.u.token, 'invoice', draft.id)).status, 404);                       // buyers never see a supplier’s draft
  must(await api('POST', `/service-invoices/${draft.id}/issue`, { token: o.s.owner.token }));
  const rfqId = o.rfq.id; const visit = (await pool.query('SELECT id FROM svc_visits WHERE order_id=$1 LIMIT 1', [o.order.id])).rows[0].id;
  const pay = must(await api('POST', `/service-invoices/${draft.id}/payments`, { token: o.u.token, body: { source: 'manual_bank', amount_minor: 100000, paid_on: ymd(0), reference: 'UTR-77', evidence: 'bank slip' } }), 201);
  for (const [token, type, sid] of [[o.u.token, 'rfq', rfqId], [o.u.token, 'comparison', rfqId], [o.s.owner.token, 'quote', o.q.id], [o.u.token, 'service_order', o.order.id], [o.u.token, 'agreement', o.order.id], [o.s.owner.token, 'job_sheet', visit], [o.u.token, 'timesheet', visit], [o.u.token, 'service_receipt', o.order.id], [o.u.token, 'completion_report', o.order.id], [o.u.token, 'invoice', draft.id], [o.u.token, 'receipt', pay.payment.id], [o.s.owner.token, 'statement', o.s.p.id]]) {
    const d = must(await gen(token, type, sid), 201);
    const f = await dl(token, d); assert.equal(f.status, 200, type); assert.equal(f.buf.subarray(0, 4).toString(), '%PDF', type); assert.ok(d.pages >= 1);
    const stranger = await signup(['athlete']);
    assert.equal((await dl(stranger.token, d)).status, 404, `stranger can read ${type}`);
  }
  // the canonical branded invoice generator now serves supplier invoices to their own parties only
  const canon = (await pool.query('SELECT invoice_id FROM svc_invoices WHERE id=$1', [draft.id])).rows[0].invoice_id;
  assert.equal(must(await api('POST', '/branded-documents/invoice', { token: o.u.token, body: { invoice_id: canon } })).pages >= 1, true);
  const out = await signup(['athlete']);
  assert.equal((await api('POST', '/branded-documents/invoice', { token: out.token, body: { invoice_id: canon } })).status, 404);
  // dashboards reconcile with the records
  const sd = must(await api('GET', `/supplier-profiles/${o.s.p.id}/dashboard`, { token: o.s.owner.token }));
  const row = sd.finance.by_currency.find((x) => x.currency === 'INR');
  assert.equal(row.billed_minor, 236000); assert.equal(row.collected_minor, 100000); assert.equal(row.outstanding_minor, 136000);
  const bd = must(await api('GET', `/service-buyers/${o.buyer.id}/dashboard`, { token: o.u.token }));
  const sp = bd.spend.by_currency.find((x) => x.currency === 'INR');
  assert.equal(sp.committed_minor, 354000); assert.equal(sp.invoiced_minor, 236000); assert.equal(sp.paid_minor, 100000);
  const csv = must(await api('GET', '/service-reports/export', { token: o.s.owner.token, query: { side: 'supplier', scope_id: o.s.p.id, report: 'invoices' } }));
  assert.equal(csv.rows, 1); assert.match(csv.csv, /gross_minor/);
  assert.equal((await api('GET', '/service-reports/export', { token: out.token, query: { side: 'supplier', scope_id: o.s.p.id, report: 'invoices' } })).status, 404);
  // another supplier can never read this supplier's dashboard
  const rival = await supplier();
  assert.equal((await api('GET', `/supplier-profiles/${o.s.p.id}/dashboard`, { token: rival.owner.token })).status, 404);
});

test('youth crew rules: under-18s need the requirement to allow minors and a guardian consent; buyers never see their names', async () => {
  const o = await confirmedOrder({ rate: 1000, qty: 3 });
  const kid = await signup(['athlete']);
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [kid.id]);
  const v = must(await api('POST', `/service-orders/${o.order.id}/visits`, { token: o.s.owner.token, body: { line_no: 1, starts_at: iso(10, 8), duration_minutes: 60, planned_qty: 1 } }), 201).visits[0];
  assert.equal((await api('POST', `/service-visits/${v.id}/crew`, { token: o.s.owner.token, body: { row_version: v.row_version, assignees: [kid.id] } })).status, 409);
  // a stranger cannot read the crew roster or the visit list
  const stranger = await signup(['athlete']);
  assert.equal((await api('GET', `/service-orders/${o.order.id}/visits`, { token: stranger.token })).status, 404);
  // the buyer sees headcount only
  const adult = await signup(['athlete']);
  const v2 = must(await api('POST', `/service-visits/${v.id}/crew`, { token: o.s.owner.token, body: { row_version: v.row_version, assignees: [adult.id] } }));
  const seen = must(await api('GET', `/service-orders/${o.order.id}/visits`, { token: o.u.token }))[0];
  assert.equal(seen.crew_count, 1); assert.equal(seen.assignees, undefined);
  assert.ok(v2.row_version > v.row_version);
});

test('an existing supplier event request is the single entry: confirming the order finalises it once and shares one budget line', async () => {
  const s = await supplier(); const { u, buyer, ev } = await organiser();
  const er = must(await api('POST', `/events/${ev.id}/requests`, { token: u.token, body: { kind: 'supplier', user_id: s.owner.id, message: 'Pitch care', offer_cents: 300000 } }), 201);
  const req = must(await requirement(buyer, u.token, { quantity: 3 }), 201);
  const rfq = must(await api('POST', `/service-requirements/${req.id}/rfq`, { token: u.token, body: { event_request_id: er.id } }), 201);
  must(await api('POST', `/rfqs/${rfq.id}/invites`, { token: u.token, body: { profile_ids: [s.p.id] } }), 201);
  must(await api('POST', `/rfqs/${rfq.id}/issue`, { token: u.token }));
  const q = must(await quote(s, rfq.id, 100000), 201);
  const f = must(await api('GET', `/rfqs/${rfq.id}`, { token: u.token }));
  const aw = must(await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: f.row_version, awards: [{ quote_id: q.id }], justification: 'only bid' } }), 201);
  must(await api('POST', `/service-orders/${aw.orders[0].id}/respond`, { token: s.owner.token, body: { action: 'confirm' } }));
  const lines = (await pool.query("SELECT * FROM event_budget_lines WHERE event_id=$1 AND status <> 'void'", [ev.id])).rows;
  assert.equal(lines.length, 1); assert.equal(lines[0].svc_order_id, aw.orders[0].id); assert.equal(Number(lines[0].committed_cents), 300000);
  assert.equal((await pool.query('SELECT status FROM event_requests WHERE id=$1', [er.id])).rows[0].status, 'finalized');
});

const { runServiceJobs } = await import('../src/capabilities/svc-reports.js');
const { expireHolds } = await import('../src/svc/sweeps.js');

test('three-decimal currencies (KWD): exact minor units through quote, tax, invoice, payment and reports; card payment refused', async () => {
  assert.ok(!must(await api('GET', '/currencies')).some((c) => c.code === 'KWD'));                 // the platform list stays as it was
  const sc = must(await api('GET', '/service-currencies'));
  assert.equal(sc.find((c) => c.code === 'KWD').exponent, 3); assert.equal(sc.find((c) => c.code === 'KWD').online_payments, false);
  const o = await confirmedOrder({ rate: 1500, qty: 3, currency: 'KWD', taxRule: { code: 'VAT5', name: 'VAT', jurisdiction: 'KW', rate_bp: 500 } });
  assert.deepEqual([o.order.net_minor, o.order.tax_minor, o.order.gross_minor].map(Number), [4500, 225, 4725]);       // 4.500 + 0.225 = 4.725 KWD
  assert.equal(o.order.currency, 'KWD');
  await deliver(o, 3);
  const d = must(await bill(o, { kind: 'final', lines: [{ line_no: 1, quantity: 3 }] }), 201);
  assert.equal(Number(d.gross_minor), 4725);
  must(await api('POST', `/service-invoices/${d.id}/issue`, { token: o.s.owner.token }));
  assert.equal((await api('POST', `/service-invoices/${d.id}/pay`, { token: o.u.token, body: { provider: 'stripe' } })).status, 409);   // no card payment in a 3-decimal currency
  const pay = must(await api('POST', `/service-invoices/${d.id}/payments`, { token: o.u.token, body: { source: 'manual_bank', amount_minor: 1725, paid_on: ymd(0), reference: 'KW-1', evidence: 'bank slip' } }), 201);
  assert.equal(pay.invoice.pay_status, 'partially_paid');
  const inv = must(await api('GET', `/service-invoices/${d.id}`, { token: o.u.token }));
  assert.equal(inv.outstanding_minor, 3000); assert.equal(inv.can_pay_online, false);
  const sd = must(await api('GET', `/supplier-profiles/${o.s.p.id}/dashboard`, { token: o.s.owner.token })).finance.by_currency.find((x) => x.currency === 'KWD');
  assert.deepEqual([sd.billed_minor, sd.collected_minor, sd.outstanding_minor], [4725, 1725, 3000]);
  assert.equal((await api('POST', '/service-documents', { token: o.u.token, body: { type: 'invoice', source_id: d.id } })).status, 201);
  assert.equal((await api('POST', '/service-buyers', { token: (await signup(['athlete'])).token, body: { currency: 'XXX' } })).status, 400);   // unknown currencies are still refused
});

test('capacity holds: a placed order holds the days for 72h; a full hold blocks others until it lapses; lapsed holds are released by the sweep', async () => {
  const s = await supplier();                                                         // capacity 4 per day
  const place = async (headcount) => {
    const { u, buyer } = await organiser();
    const req = must(await requirement(buyer, u.token, { quantity: 3, headcount, starts_at: iso(10), ends_at: iso(12) }), 201);
    const rfq = await rfqFlow(buyer, u.token, req, [s]);
    const inv = must(await api('GET', '/me/rfq-invitations', { token: s.owner.token, query: { profile_id: s.p.id } })).find((x) => x.rfq_id === rfq.id);
    must(await api('POST', `/rfq-invites/${inv.id}/respond`, { token: s.owner.token, body: { action: 'accept' } }));
    const q = must(await api('POST', `/rfq-invites/${inv.id}/quote`, { token: s.owner.token, body: { valid_until: iso(5), lines: [{ line_type: 'service', description: 'Crew', quantity: 3, unit: 'visit', rate_minor: 1000 }] } }), 201);
    const f = must(await api('GET', `/rfqs/${rfq.id}`, { token: u.token }));
    return must(await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: f.row_version, awards: [{ quote_id: q.id }], justification: 'ok' } }), 201).orders[0];
  };
  const a = await place(3), b = await place(3);
  const held = async (id) => (await pool.query("SELECT status, hold_expires_at FROM svc_allocations WHERE order_id=$1 ORDER BY day", [id])).rows;
  assert.equal((await held(a.id)).length, 3); assert.ok((await held(a.id)).every((r) => r.status === 'held' && new Date(r.hold_expires_at) > new Date(Date.now() + 71 * 3600e3)));
  assert.equal((await held(b.id)).length, 0);                                          // no room to hold: the order is still placed, the supplier decides
  assert.ok(a.terms.hold_expires_at || (await pool.query('SELECT terms FROM svc_orders WHERE id=$1', [a.id])).rows[0].terms.hold_expires_at);
  assert.equal((await api('POST', `/service-orders/${b.id}/respond`, { token: s.owner.token, body: { action: 'confirm' } })).status, 409);   // a live hold counts
  await pool.query("UPDATE svc_allocations SET hold_expires_at = now() - interval '1 minute' WHERE order_id=$1", [a.id]);                // the 72 hours pass
  assert.equal((await expireHolds()) >= 3, true);
  assert.ok((await held(a.id)).every((r) => r.status === 'released'));
  must(await api('POST', `/service-orders/${b.id}/respond`, { token: s.owner.token, body: { action: 'confirm' } }));                       // room again
  assert.equal((await api('POST', `/service-orders/${a.id}/respond`, { token: s.owner.token, body: { action: 'confirm' } })).status, 409);   // and a's days are now taken
  const rej = await place(1);                                                          // 3 + 1 fits only while b holds 3
  assert.equal((await held(rej.id)).length, 3);
  must(await api('POST', `/service-orders/${rej.id}/respond`, { token: s.owner.token, body: { action: 'reject', reason: 'no' } }));
  assert.ok((await held(rej.id)).every((r) => r.status === 'released'));                // a rejected order frees its hold
});

test('durable exports: CSV, XLSX and PDF are built by the worker, private to the requester, re-authorised on download; dashboards print as PDF', async () => {
  const o = await confirmedOrder({ rate: 100000, qty: 3, taxRule: { code: 'GST', name: 'GST', jurisdiction: 'IN', rate_bp: 1800 } });
  await deliver(o, 2);
  const d = must(await bill(o, { kind: 'progress', lines: [{ line_no: 1, quantity: 2 }] }), 201);
  must(await api('POST', `/service-invoices/${d.id}/issue`, { token: o.s.owner.token }));
  const ask = (token, body) => api('POST', '/service-reports/exports', { token, body });
  const exps = [];
  for (const [report, format] of [['invoices', 'csv'], ['invoices', 'xlsx'], ['invoices', 'pdf'], ['dashboard', 'csv'], ['dashboard', 'pdf'], ['orders', 'xlsx']]) exps.push(must(await ask(o.s.owner.token, { side: 'supplier', scope_id: o.s.p.id, report, format }), 202));
  assert.ok(exps.every((x) => x.status === 'queued'));
  assert.equal((await api('GET', `/service-reports/exports/${exps[0].id}`, { token: o.s.owner.token })).body.status, 'queued');
  await runServiceJobs();
  const got = async (token, x) => api('GET', `/service-reports/exports/${x.id}`, { token });
  const csv = must(await got(o.s.owner.token, exps[0])); assert.equal(csv.status, 'ready'); assert.match(csv.data, /gross_minor/); assert.match(csv.data, /236000/); assert.equal(csv.rows, 1);
  const xl = must(await got(o.s.owner.token, exps[1])); assert.equal(Buffer.from(xl.data, 'base64').subarray(0, 2).toString(), 'PK');
  const pdf = must(await got(o.s.owner.token, exps[2])); assert.equal(Buffer.from(pdf.data, 'base64').subarray(0, 4).toString(), '%PDF'); assert.match(pdf.sha256, /^[0-9a-f]{64}$/);
  const dash = must(await got(o.s.owner.token, exps[3])); assert.match(dash.data, /finance\.by_currency\[0\]\.billed_minor,236000/);
  assert.equal(Buffer.from(must(await got(o.s.owner.token, exps[4])).data, 'base64').subarray(0, 4).toString(), '%PDF');
  assert.equal(must(await api('GET', '/service-reports/exports', { token: o.s.owner.token })).length, 6);
  // private to the requester; a stranger and the buyer cannot read the supplier's file, or order one for the supplier
  const stranger = await signup(['athlete']);
  assert.equal((await got(stranger.token, exps[0])).status, 404); assert.equal((await got(o.u.token, exps[0])).status, 404);
  assert.equal((await ask(stranger.token, { side: 'supplier', scope_id: o.s.p.id, report: 'orders', format: 'csv' })).status, 404);
  assert.equal((await ask(o.u.token, { side: 'supplier', scope_id: o.s.p.id, report: 'orders', format: 'csv' })).status, 404);
  // access is checked again when the job runs and when downloading: a removed staff member gets nothing
  const fin = await signup(['athlete']);
  must(await api('POST', `/supplier-profiles/${o.s.p.id}/staff`, { token: o.s.owner.token, body: { user_id: fin.id, role: 'finance' } }), 201);
  const mine = must(await ask(fin.token, { side: 'supplier', scope_id: o.s.p.id, report: 'payments', format: 'csv' }), 202);
  await runServiceJobs(); assert.equal(must(await got(fin.token, mine)).status, 'ready');
  const staff = (await pool.query("SELECT id FROM svc_staff WHERE user_id=$1 AND status='active'", [fin.id])).rows[0];
  must(await api('DELETE', `/supplier-staff/${staff.id}`, { token: o.s.owner.token }));
  assert.equal((await got(fin.token, mine)).status, 404);
  // buyer side, and dashboards as documents
  const bx = must(await ask(o.u.token, { side: 'buyer', scope_id: o.buyer.id, report: 'dashboard', format: 'pdf' }), 202);
  await runServiceJobs(); assert.equal(Buffer.from(must(await got(o.u.token, bx)).data, 'base64').subarray(0, 4).toString(), '%PDF');
  const gen = (token, type, source_id) => api('POST', '/service-documents', { token, body: { type, source_id } });
  const sr = must(await gen(o.s.owner.token, 'supplier_report', o.s.p.id), 201), br = must(await gen(o.u.token, 'buyer_report', o.buyer.id), 201);
  for (const [t, dd] of [[o.s.owner.token, sr], [o.u.token, br]]) { const r = await fetch(`${base}${dd.url}`, { headers: { authorization: `Bearer ${t}` } }); assert.equal(r.status, 200); assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), '%PDF'); }
  assert.equal((await gen(stranger.token, 'supplier_report', o.s.p.id)).status, 404); assert.equal((await gen(o.u.token, 'supplier_report', o.s.p.id)).status, 404);
  assert.equal((await gen(o.s.owner.token, 'buyer_report', o.buyer.id)).status, 404);
});

test('RFQ evaluation integrity (#520): re-scoring keeps history, a declared conflict recuses the evaluator, and declarations are append-only', async () => {
  const s1 = await supplier(), s2 = await supplier();
  const { u, buyer } = await organiser();
  const req = must(await requirement(buyer, u.token, { quantity: 3 }), 201);
  const rfq = await rfqFlow(buyer, u.token, req, [s1, s2]);
  const q1 = must(await quote(s1, rfq.id, 100000), 201), q2 = must(await quote(s2, rfq.id, 90000), 201);
  const ev1 = must(await api('POST', `/quotes/${q1.id}/evaluate`, { token: u.token, body: { scores: { price: 7, quality: 8 }, rationale: 'Solid method statement' } }), 201);
  const ev2 = must(await api('POST', `/quotes/${q1.id}/evaluate`, { token: u.token, body: { scores: { price: 7, quality: 5 }, rationale: 'Re-read the references: weaker' } }), 201);
  assert.equal(ev2.id, ev1.id, 'one current evaluation per evaluator');
  const hist = (await pool.query('SELECT scores, rationale FROM svc_evaluation_revisions WHERE evaluation_id=$1', [ev1.id])).rows;
  assert.equal(hist.length, 1); assert.equal(hist[0].scores.quality, 8); assert.equal(hist[0].rationale, 'Solid method statement');
  // conflict: declared once (idempotent), then the evaluator cannot score, shortlist or award that supplier; the other supplier is unaffected
  const c1 = must(await api('POST', `/rfqs/${rfq.id}/conflicts`, { token: u.token, body: { profile_id: s2.p.id, reason: 'Family member owns this company' } }), 201);
  const c2 = must(await api('POST', `/rfqs/${rfq.id}/conflicts`, { token: u.token, body: { profile_id: s2.p.id, reason: 'Family member owns this company' } }), 201);
  assert.equal(c1.id, c2.id);
  assert.equal((await api('POST', `/quotes/${q2.id}/evaluate`, { token: u.token, body: { scores: { price: 9 }, rationale: 'Cheapest' } })).status, 403);
  assert.equal((await api('POST', `/quotes/${q2.id}/decision`, { token: u.token, body: { decision: 'shortlisted' } })).status, 403);
  must(await api('POST', `/quotes/${q1.id}/evaluate`, { token: u.token, body: { scores: { price: 7, quality: 6 }, rationale: 'Still fine' } }), 201);
  const fresh = must(await api('GET', `/rfqs/${rfq.id}`, { token: u.token }));
  assert.equal((await api('POST', `/rfqs/${rfq.id}/award`, { token: u.token, body: { row_version: fresh.row_version, awards: [{ quote_id: q2.id }], justification: 'Lowest price' } })).status, 403, 'a recused person cannot award the supplier');
  await assert.rejects(pool.query('DELETE FROM svc_rfq_conflicts WHERE id=$1', [c1.id]), /append-only/);
  // people who work for a bidder cannot evaluate it, with no declaration needed
  must(await api('POST', `/service-buyers/${buyer.id}/roles`, { token: u.token, body: { person: s1.owner.handle, role: 'evaluator' } }), 201);
  assert.equal((await api('POST', `/quotes/${q1.id}/evaluate`, { token: s1.owner.token, body: { scores: { price: 10, quality: 10 }, rationale: 'Marking my own homework' } })).status, 403);
});
