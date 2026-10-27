// Tender zone follow-ups: contract terms (renewals, notice, milestones), site-visit document acknowledgements, the published reserve-bidder
// rule and separately approved public award notices. Every test creates its own people and tenders; nothing is seeded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, ok, signup, start, stop, pool, buyerSide, publishedTender, inAt, dateOf, closeNow, world, bids, evaluate, awardAll } from './tender-helpers.js';

before(start);
after(stop);

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const frameworkTerms = { contract_type: 'framework', ceiling_minor: 4000000, renewal_options: 2, renewal_term_months: 6, renewal_ceiling_minor: 1000000, notice_days: 14, milestones: [{ name: 'Pitches ready', due_on: dateOf(41), description: 'Both pitches signed off' }] };

test('contract terms are validated, carried onto each order, and renewals, notice and milestones follow the published rules', async () => {
  // validation: a renewal needs a term, and a milestone must sit inside the preparation-to-teardown window
  const b = await buyerSide();
  const d = ok(await call('POST', '/rfps', { token: b.owner.token, body: { kind: 'rfp', title: 'Terms check tender', category: 'Ground maintenance', organisation_id: b.org.id, timezone: 'Asia/Kolkata' } }), 201);
  ok(await call('PATCH', `/rfps/${d.id}`, { token: b.owner.token, body: { row_version: d.row_version, scope: 'Scope', service_start: dateOf(40), service_end: dateOf(45), closes_at: inAt(10), contract_type: 'framework', ceiling_minor: 100000, renewal_options: 2, milestones: [{ name: 'Too early', due_on: dateOf(5) }] } }));
  const v = ok(await call('POST', `/rfps/${d.id}/validate`, { token: b.owner.token }));
  assert.ok(v.issues.some((x) => x.field === 'renewal_term_months' && x.severity === 'error'), 'a renewal without a term is refused');
  assert.ok(v.issues.some((x) => x.field === 'milestones' && /outside/.test(x.message)), 'a milestone outside the service window is refused');

  const w = await world(frameworkTerms);
  await bids(w); await evaluate(w);
  const { award } = await awardAll(w, 'highest_score', w.sup.A.user);
  assert.equal(award.lines.length, 2);
  const orders = ok(await call('GET', `/procurement-orders?project_id=${w.t.id}`, { token: w.chair.token }));
  assert.equal(orders.length, 2, 'one order per accepted lot');
  const o = ok(await call('GET', `/procurement-orders/${orders[0].id}`, { token: w.chair.token }));
  assert.equal(o.terms.renewal_options, 2); assert.equal(o.terms.renewal_term_months, 6); assert.equal(o.terms.notice_days, 14);
  assert.equal(o.terms.milestones.length, 1); assert.equal(o.terms.milestones[0].status, 'planned');
  assert.ok(o.terms.renewal_ceiling_minor > 0 && o.ceiling_minor > 0);

  // milestones: only the buying team records them, a waiver needs a reason; the record is not acceptance or payment
  const m = o.terms.milestones[0];
  assert.equal((await call('POST', `/procurement-milestones/${m.id}/update`, { token: w.sup.A.user.token, body: { status: 'completed' } })).status, 403);
  assert.equal((await call('POST', `/procurement-milestones/${m.id}/update`, { token: w.chair.token, body: { status: 'waived' } })).status, 400);
  assert.equal(ok(await call('POST', `/procurement-milestones/${m.id}/update`, { token: w.chair.token, body: { status: 'completed', note: 'Signed off on site' } })).status, 'completed');

  // renewal: numbered, idempotent, extends the period and adds the published ceiling, and only the buying team can exercise it
  assert.equal((await call('POST', `/procurement-orders/${o.id}/renew`, { token: w.sup.A.user.token, body: { renewal_no: 1 } })).status, 403);
  assert.equal((await call('POST', `/procurement-orders/${o.id}/renew`, { token: w.chair.token, body: { renewal_no: 2 } })).status, 409, 'renewals are taken in order');
  const before = (await pool.query('SELECT service_end::text AS se, ceiling_minor::bigint AS c FROM proc_orders WHERE id=$1', [o.id])).rows[0];
  const r1 = ok(await call('POST', `/procurement-orders/${o.id}/renew`, { token: w.chair.token, body: { renewal_no: 1 } }));
  const replay = ok(await call('POST', `/procurement-orders/${o.id}/renew`, { token: w.chair.token, body: { renewal_no: 1 } }));
  assert.equal(replay.replayed, true);
  const after = (await pool.query("SELECT service_end::text AS se, ceiling_minor::bigint AS c, renewals_used, (service_end = (($1::date) + interval '6 months')::date) AS ok FROM proc_orders WHERE id=$2", [before.se, o.id])).rows[0];
  assert.ok(after.ok, 'the service period moved by the published renewal term'); assert.equal(after.renewals_used, 1);
  assert.equal(Number(after.c), Number(before.c) + Number(r1.added_ceiling_minor)); assert.ok(Number(r1.added_ceiling_minor) > 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_order_renewals WHERE order_id=$1', [o.id])).rows[0].n, 1, 'the retry did not renew twice');
  await assert.rejects(pool.query('UPDATE proc_order_renewals SET n=9 WHERE order_id=$1', [o.id]), /append-only/, 'renewal history is immutable');

  // the notice period: too late to renew once it has begun
  await pool.query("UPDATE proc_orders SET service_end = current_date + 3 WHERE id=$1", [o.id]);
  const late = await call('POST', `/procurement-orders/${o.id}/renew`, { token: w.chair.token, body: { renewal_no: 2 } });
  assert.equal(late.status, 409); assert.match(late.body.error.message, /notice period/);

  // notice of non-renewal stops renewals; one notice per order; a reason is required
  const o2 = orders[1];
  assert.equal((await call('POST', `/procurement-orders/${o2.id}/notice`, { token: w.sup.A.user.token, body: { kind: 'not_renew', reason: 'short' } })).status, 400);
  const outsider = await signup('outsider', ['supplier']);
  assert.equal((await call('POST', `/procurement-orders/${o2.id}/notice`, { token: outsider.token, body: { kind: 'not_renew', reason: 'I am not a party to this order' } })).status, 404);
  const n1 = ok(await call('POST', `/procurement-orders/${o2.id}/notice`, { token: w.sup.A.user.token, body: { kind: 'not_renew', reason: 'We cannot staff a second season' } }), 201);
  assert.equal(n1.notice_kind, 'not_renew');
  assert.equal((await call('POST', `/procurement-orders/${o2.id}/renew`, { token: w.chair.token, body: { renewal_no: 1 } })).status, 409);
  assert.equal((await call('POST', `/procurement-orders/${o2.id}/notice`, { token: w.chair.token, body: { kind: 'terminate', reason: 'Second notice attempt here' } })).status, 409);

  // termination: after it takes effect no call-off can be placed
  const o1b = ok(await call('GET', `/procurement-orders/${orders[0].id}`, { token: w.chair.token }));
  assert.ok(o1b.terms.renewals.length === 1);
  await pool.query("UPDATE proc_orders SET service_end = $2 WHERE id=$1", [o.id, dateOf(45)]);
  ok(await call('POST', `/procurement-orders/${o.id}/call-offs`, { token: w.chair.token, body: { amount_minor: 1000, description: 'Before any notice', service_date: dateOf(41) } }), 201);
  const t1 = ok(await call('POST', `/procurement-orders/${o.id}/notice`, { token: w.chair.token, body: { kind: 'terminate', reason: 'The event was moved to another venue' } }), 201);
  assert.equal(t1.notice_kind, 'terminate');
  const blocked = await call('POST', `/procurement-orders/${o.id}/call-offs`, { token: w.chair.token, body: { amount_minor: 1000, description: 'After the notice takes effect', service_date: dateOf(42) } });
  assert.equal(blocked.status, 409); assert.match(blocked.body.error.message, /termination notice/);
  const detail = ok(await call('GET', `/procurement-orders/${o.id}`, { token: w.sup.A.user.token }));
  assert.equal(detail.terms.notice.kind, 'terminate', 'the supplier sees the notice');
});

test('site-visit documents: suppliers acknowledge them, a bid cannot pass without it, and the record is permanent', async () => {
  const w = await world({ site_visit_at: inAt(3), site_visit_mandatory: false }, [['A', 100000], ['B', 90000]]);
  const up = (q, token = w.owner.token) => call('PUT', `/rfps/${w.t.id}/files?${q}`, { token, raw: pdf });
  assert.equal((await up('audience=public&visit_pack=true&name=bad.pdf')).status, 400, 'a visit document is for participants who accepted the terms');
  const doc = ok(await up('audience=participants&visit_pack=true&name=site-safety.pdf'), 201);
  assert.equal(doc.visit_pack, true);
  const plain = ok(await up('audience=participants&name=scope.pdf'), 201);
  assert.equal(plain.visit_pack, false);
  assert.equal((await call('POST', `/rfps/${w.t.id}/visit-documents`, { token: w.sup.A.user.token, body: { file_id: plain.id, visit_pack: true } })).status, 404, 'a supplier cannot mark documents');

  // the notice lists the document and what this entity has acknowledged
  const notice = ok(await call('GET', `/tenders/${w.t.id}`, { token: w.sup.A.user.token }));
  assert.equal(notice.files.find((f) => f.id === doc.id).visit_pack, true);
  assert.deepEqual(notice.visit_acks, []);

  // an unacknowledged document blocks the submit checklist and the submit itself
  const A = w.sup.A, B = w.sup.B;
  for (const s of [A, B]) {
    const pr = ok(await call('POST', `/tenders/${w.t.id}/proposals`, { token: s.user.token, body: { entity_id: s.ent.id, lots: ['L1', 'L2'] } }), 201);
    s.pid = pr.id;
    ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: s.user.token, body: { draft_version: pr.draft_version, technical: { answers: { approach: 'A method statement with a trained crew.', safeguarding: true }, evidence: {}, subcontractors: [], attachments: [] }, commercial: { lines: [{ lot_code: 'L1', qty: '2', unit: 'site', rate_minor: s.price * 5, tax_bp: 1800, discount_bp: 0, tax_inclusive: false }, { lot_code: 'L2', qty: '36', unit: 'person-shift', rate_minor: s.price, tax_bp: 1800, discount_bp: 0, tax_inclusive: false }], answers: {}, validity_days: 60, attachments: [] } } }));
  }
  const chk = ok(await call('POST', `/proposals/${A.pid}/validate`, { token: A.user.token }));
  assert.ok(JSON.stringify(chk).includes(`visit_doc_${doc.id}`), 'the checklist names the document');
  const refused = await call('POST', `/proposals/${A.pid}/submit`, { token: A.user.token, body: { idempotency_key: 'visit-a-1', declaration: true } });
  assert.ok(refused.status >= 400 && refused.status < 500, 'submit is refused until the document is acknowledged');

  // only a member of the entity can acknowledge, and it needs accepted terms
  const stranger = await signup('stranger', ['supplier']);
  assert.ok([403, 404].includes((await call('POST', `/tenders/${w.t.id}/visit-documents/acknowledge`, { token: stranger.token, body: { entity_id: A.ent.id } })).status));
  const ackA = ok(await call('POST', `/tenders/${w.t.id}/visit-documents/acknowledge`, { token: A.user.token, body: { entity_id: A.ent.id } }));
  assert.equal(ackA.acknowledged, 1); assert.deepEqual(ackA.outstanding, []);
  assert.equal(ok(await call('POST', `/tenders/${w.t.id}/visit-documents/acknowledge`, { token: A.user.token, body: { entity_id: A.ent.id } })).acknowledged, 0, 'acknowledging again changes nothing');
  assert.equal((await pool.query('SELECT sha256 FROM proc_visit_acks WHERE entity_id=$1', [A.ent.id])).rowCount, 1);
  await assert.rejects(pool.query('DELETE FROM proc_visit_acks WHERE entity_id=$1', [A.ent.id]), /append-only/);
  ok(await call('POST', `/proposals/${A.pid}/submit`, { token: A.user.token, body: { idempotency_key: 'visit-a-2', declaration: true } }));
  assert.equal((await call('POST', `/rfps/${w.t.id}/visit-documents`, { token: w.owner.token, body: { file_id: doc.id, visit_pack: false } })).status, 409, 'an acknowledged document stays marked');

  // buyers see who acknowledged
  const parts = ok(await call('GET', `/rfps/${w.t.id}/participants`, { token: w.owner.token }));
  const pa = parts.find((x) => x.entity_id === A.ent.id), pb = parts.find((x) => x.entity_id === B.ent.id);
  assert.equal(pa.visit_documents_acknowledged, 1); assert.equal(pb.visit_documents_acknowledged, 0); assert.equal(pa.visit_documents, 1);

  // a document that existed when B submitted but was never acknowledged fails the qualification gate (B is let through by backdating the file)
  ok(await call('POST', `/tenders/${w.t.id}/visit-documents/acknowledge`, { token: B.user.token, body: { entity_id: B.ent.id } }));
  ok(await call('POST', `/proposals/${B.pid}/submit`, { token: B.user.token, body: { idempotency_key: 'visit-b-1', declaration: true } }));
  await pool.query("INSERT INTO proc_files(project_id, uploaded_by, audience, name, mime, bytes, sha256, stored, visit_pack, created_at) SELECT $1, $2, 'participants', 'late-induction.pdf', 'application/pdf', 10, 'x', 'x', true, (SELECT min(submitted_at) FROM proc_submissions WHERE project_id=$1) - interval '1 minute'", [w.t.id, w.owner.id]);
  await closeNow(w.t.id);
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'technical' } }));
  const gates = (await pool.query("SELECT proposal_id, result, reason FROM proc_gates WHERE gate_key='visit_documents'")).rows;
  assert.equal(gates.length, 2); assert.ok(gates.every((g) => g.result === 'fail' && /late-induction/.test(g.reason)), 'both bids lack the older document');
});

test('reserve bidders: a published rule decides whether a declined lot may go to the next ranked bidder, always with a fresh approval', async () => {
  // rule "none": the declined lot is not offered to anyone else
  const n = await world({}, [['A', 100000], ['B', 90000], ['C', 50000]]);
  await bids(n); await evaluate(n);
  const first = await awardAll(n, 'highest_score');
  const aLines = first.award.lines.filter((l) => l.entity_id === n.sup.A.ent.id);
  assert.equal(aLines.length, 2);
  ok(await call('POST', `/award-lines/${aLines.find((l) => l.lot_code === 'L1').id}/respond`, { token: n.sup.A.user.token, body: { action: 'accept' } }));
  ok(await call('POST', `/award-lines/${aLines.find((l) => l.lot_code === 'L2').id}/respond`, { token: n.sup.A.user.token, body: { action: 'decline', reason: 'We lost our crew' } }));
  const opt0 = ok(await call('GET', `/rfps/${n.t.id}/reserve`, { token: n.chair.token }));
  assert.equal(opt0.reserve_policy, 'none'); assert.equal(opt0.lots.length, 1); assert.equal(opt0.lots[0].allowed, false);
  const blocked = await call('POST', `/rfps/${n.t.id}/scenarios`, { token: n.chair.token, body: { kind: 'highest_score' } });
  assert.equal(blocked.status, 409); assert.match(blocked.body.error.message, /published rule/);

  // rule "next_ranked": only the next eligible bidder in ranking order, never one who already had the lot
  const w = await world({ reserve_policy: 'next_ranked' }, [['A', 100000], ['B', 90000], ['C', 50000]]);
  await bids(w); await evaluate(w);
  const a1 = await awardAll(w, 'highest_score');
  const aw = a1.award.lines.filter((l) => l.entity_id === w.sup.A.ent.id);
  ok(await call('POST', `/award-lines/${aw.find((l) => l.lot_code === 'L1').id}/respond`, { token: w.sup.A.user.token, body: { action: 'accept' } }));
  const declined = aw.find((l) => l.lot_code === 'L2');
  ok(await call('POST', `/award-lines/${declined.id}/respond`, { token: w.sup.A.user.token, body: { action: 'decline', reason: 'We lost our crew' } }));
  const opt = ok(await call('GET', `/rfps/${w.t.id}/reserve`, { token: w.chair.token }));
  assert.equal(opt.reserve_policy, 'next_ranked'); assert.equal(opt.lots[0].lot, 'L2'); assert.equal(opt.lots[0].allowed, true);
  assert.equal(opt.lots[0].previous[0].reason, 'We lost our crew');
  assert.equal(opt.lots[0].next.entity_id, w.sup.B.ent.id, 'C is ineligible, so B is the next bidder in ranking order');
  assert.notEqual(opt.lots[0].next.entity_id, w.sup.A.ent.id);
  assert.equal((await call('GET', `/rfps/${w.t.id}/reserve`, { token: w.sup.B.user.token })).status, 404, 'suppliers never see reserve options');

  const sc = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'highest_score' } }), 201);
  assert.deepEqual(sc.allocation.map((x) => [x.lot, x.entity]), [['L2', w.sup.B.ent.id]]);
  assert.equal(sc.reserve[0].lot, 'L2');
  const rec = ok(await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: sc.id, rationale: 'Lot L2 goes to the next ranked bidder after the first declined.' } }), 201);
  assert.equal((await call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: {} })).status, 409, 'not issued before the fresh approval');
  assert.equal((await call('POST', `/approvals/${rec.approval_id}/decide`, { token: w.chair.token, body: { decision: 'approve' } })).status, 403, 'the requester cannot approve');
  ok(await call('POST', `/approvals/${rec.approval_id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  ok(await call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: {} }));
  const second = ok(await call('GET', `/awards/${rec.id}`, { token: w.chair.token }));
  assert.equal(second.lines.length, 1); assert.equal(second.lines[0].reserve_of, declined.id, 'the reserve line points at the line it replaces');
  const done = ok(await call('POST', `/award-lines/${second.lines[0].id}/respond`, { token: w.sup.B.user.token, body: { action: 'accept' } }));
  assert.ok(done.order.ref);
  assert.equal((await pool.query('SELECT status FROM proc_projects WHERE id=$1', [w.t.id])).rows[0].status, 'awarded');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_orders WHERE project_id=$1', [w.t.id])).rows[0].n, 2, 'one order per lot, none duplicated');
});

test('public award notices are separately approved, allowlisted, immutable and withdrawable', async () => {
  // policy off: nothing can be published
  const off = await world({}, [['A', 100000], ['B', 90000]]);
  assert.equal((await call('POST', `/rfps/${off.t.id}/award-publication`, { token: off.chair.token, body: { fields: ['supplier'] } })).status, 409);

  const w = await world({ disclosure: { rank: false, bidder_count: false, award_public: true } }, [['A', 100000], ['B', 90000]]);
  assert.equal((await call('POST', `/rfps/${w.t.id}/award-publication`, { token: w.chair.token, body: { fields: ['supplier'] } })).status, 409, 'nothing accepted yet');
  await bids(w); await evaluate(w);
  const { rec } = await awardAll(w, 'highest_score', w.sup.A.user);
  assert.equal((await pool.query('SELECT status FROM proc_projects WHERE id=$1', [w.t.id])).rows[0].status, 'awarded');
  const outsider = await signup('outsider', ['supplier']);
  const notice = async (u) => ok(await call('GET', `/tenders/${w.t.id}`, { token: u.token }));
  assert.equal((await notice(outsider)).public_award, null, 'an award alone is not public');

  // request: the chair chooses fields; it needs a different approver
  assert.equal((await call('POST', `/rfps/${w.t.id}/award-publication`, { token: w.sup.B.user.token, body: { fields: ['supplier'] } })).status, 404, 'a supplier cannot request it');
  const req = ok(await call('POST', `/rfps/${w.t.id}/award-publication`, { token: w.chair.token, body: { fields: ['supplier', 'lots', 'award_date'] } }), 201);
  assert.equal(req.status, 'approval_pending');
  assert.equal((await notice(outsider)).public_award, null, 'not public while waiting for approval');
  assert.equal((await call('POST', `/rfps/${w.t.id}/award-publication`, { token: w.chair.token, body: { fields: ['supplier'] } })).status, 409, 'one notice at a time');
  assert.equal((await call('POST', `/approvals/${req.approval_id}/decide`, { token: w.chair.token, body: { decision: 'approve' } })).status, 403);
  ok(await call('POST', `/approvals/${req.approval_id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  const pub = (await notice(outsider)).public_award;
  assert.ok(pub); assert.equal(pub.tender.ref.startsWith('TND-'), true);
  assert.deepEqual(pub.awards.map((a) => a.supplier).sort(), ['Supplier A Ltd', 'Supplier A Ltd']);
  assert.ok(pub.awards.every((a) => a.lot && !('amount_minor' in a)), 'the contract value was not chosen, so it never appears');
  assert.ok(pub.award_date && !pub.service_period);
  const text = JSON.stringify(await notice(outsider));
  assert.ok(!/Supplier B Ltd/.test(text), 'a losing bidder never appears');
  assert.ok(!/score|rank|price/i.test(JSON.stringify(pub)), 'no scores, ranks or prices in the public record');
  await assert.rejects(pool.query("UPDATE proc_award_publications SET record='{}' WHERE project_id=$1", [w.t.id]), /cannot be edited/, 'the published record is fixed');

  // withdraw (reason needed), then a corrected notice with the value is requested, rejected once, then approved
  assert.equal((await call('POST', `/award-publications/${req.id}/withdraw`, { token: w.chair.token, body: { reason: 'short' } })).status, 400);
  ok(await call('POST', `/award-publications/${req.id}/withdraw`, { token: w.chair.token, body: { reason: 'Wrong award date was shown' } }));
  assert.equal((await notice(outsider)).public_award, null);
  const r2 = ok(await call('POST', `/rfps/${w.t.id}/award-publication`, { token: w.chair.token, body: { fields: ['supplier', 'value'] } }), 201);
  ok(await call('POST', `/approvals/${r2.approval_id}/decide`, { token: w.approver.token, body: { decision: 'reject', reason: 'Contract values stay confidential' } }));
  assert.equal((await pool.query('SELECT status FROM proc_award_publications WHERE id=$1', [r2.id])).rows[0].status, 'rejected');
  assert.equal((await notice(outsider)).public_award, null);
  const r3 = ok(await call('POST', `/rfps/${w.t.id}/award-publication`, { token: w.chair.token, body: { fields: ['supplier', 'value'] } }), 201);
  ok(await call('POST', `/approvals/${r3.approval_id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  const withValue = (await notice(outsider)).public_award;
  assert.ok(withValue.awards.every((a) => a.amount_minor > 0 && a.currency === 'INR'), 'the value appears only because it was chosen and approved');
  const list = ok(await call('GET', `/rfps/${w.t.id}/award-publications`, { token: w.chair.token }));
  assert.deepEqual(list.map((x) => x.status).sort(), ['published', 'rejected', 'withdrawn']);
  assert.equal((await call('GET', `/rfps/${w.t.id}/award-publications`, { token: outsider.token })).status, 404);
  assert.ok(rec.id);
});

test('tender pack documents: upload while drafting, amend by replacing, keep the history, and lock the pack after approval', async () => {
  const b = await buyerSide();
  const d = ok(await call('POST', '/rfps', { token: b.owner.token, body: { kind: 'rfp', title: 'Documents tender', category: 'Ground maintenance', organisation_id: b.org.id, timezone: 'Asia/Kolkata' } }), 201);
  const put = (q, token = b.owner.token, id = d.id) => call('PUT', `/rfps/${id}/files?${q}`, { token, raw: pdf });

  // upload while creating; a stranger cannot
  const v1 = ok(await put('audience=participants&visit_pack=true&name=scope-v1.pdf'), 201);
  assert.equal(v1.visit_pack, true); assert.equal(v1.replaces_id, null);
  const stranger = await signup('stranger', ['supplier']);
  assert.ok([403, 404].includes((await put('audience=participants&name=x.pdf', stranger.token)).status));

  // amend: the replacement inherits who it is for, points at the file it replaces, and the old one is archived (not deleted)
  const v2 = ok(await put(`name=scope-v2.pdf&replaces=${v1.id}`), 201);
  assert.equal(v2.replaces_id, v1.id); assert.equal(v2.audience, 'participants'); assert.equal(v2.visit_pack, true, 'it is still a site-visit document');
  const cur = ok(await call('GET', `/rfps/${d.id}/documents`, { token: b.owner.token }));
  assert.equal(cur.editable, true); assert.deepEqual(cur.documents.map((x) => x.name), ['scope-v2.pdf']);
  const full = ok(await call('GET', `/rfps/${d.id}/documents?include_archived=true`, { token: b.owner.token }));
  assert.deepEqual(full.documents.map((x) => [x.name, x.current]), [['scope-v1.pdf', false], ['scope-v2.pdf', true]]);
  assert.equal(full.documents[1].replaces_id, v1.id);
  const hist = (await pool.query('SELECT name, archived_at IS NOT NULL AS archived, replaces_id FROM proc_files WHERE project_id=$1 ORDER BY created_at', [d.id])).rows;
  assert.deepEqual(hist.map((x) => [x.name, x.archived]), [['scope-v1.pdf', true], ['scope-v2.pdf', false]], 'the earlier version is kept');
  assert.equal((await put('name=again.pdf&replaces=' + v1.id)).status, 404, 'an already replaced document cannot be replaced again');
  assert.equal((await put('name=odd.pdf&visit_pack=true&audience=public')).status, 400);

  // archive from a draft keeps it in the history; a supplier cannot
  const extra = ok(await put('audience=public&name=public-note.pdf'), 201);
  assert.ok([403, 404].includes((await call('POST', `/rfps/${d.id}/documents/${extra.id}/archive`, { token: stranger.token })).status));
  ok(await call('POST', `/rfps/${d.id}/documents/${extra.id}/archive`, { token: b.owner.token }));
  assert.deepEqual(ok(await call('GET', `/rfps/${d.id}/documents`, { token: b.owner.token })).documents.map((x) => x.name), ['scope-v2.pdf']);

  // after approval the pack cannot lose or swap a document: add the amended one and issue an addendum
  const t = await publishedTender(b);
  const base = ok(await put('audience=participants&name=pack.pdf', b.owner.token, t.id), 201);
  assert.equal((await put(`name=pack-v2.pdf&replaces=${base.id}`, b.owner.token, t.id)).status, 409);
  assert.equal((await call('POST', `/rfps/${t.id}/documents/${base.id}/archive`, { token: b.owner.token })).status, 409);
  assert.equal((await put('audience=participants&name=extra-annex.pdf', b.owner.token, t.id)).status, 201, 'a new document can still be added');
  const published = ok(await call('GET', `/rfps/${t.id}/documents`, { token: b.owner.token }));
  assert.equal(published.editable, false); assert.equal(published.documents.length, 2);
});
