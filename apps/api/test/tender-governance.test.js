import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, ok, signup, start, stop, pool, buyerSide, publishedTender, supplierEntity, part, inAt, dateOf, goodDraft, closeNow, world, bids, evaluate, awardAll, orgWith } from './tender-helpers.js';
import { sendTenderReminders } from '../src/capabilities/tender-reports.js';

before(start);
after(stop);

test('delegated authority: a mandate lets a member author tenders, revocation and role removal apply on the next request', async () => {
  const owner = await signup('boss', ['organizer']), delegate = await signup('delegate', ['organizer']), plain = await signup('plainmember', ['organizer']);
  const org = await orgWith(owner, [{ user: delegate, role: 'finance' }, { user: plain, role: 'finance' }]);
  const create = (u) => call('POST', '/rfps', { token: u.token, body: { title: 'Delegated tender', category: 'Crew', organisation_id: org.id } });
  assert.equal((await create(plain)).status, 403);
  assert.equal((await call('POST', '/procurement/mandates', { token: delegate.token, body: { organisation_id: org.id, handle: delegate.handle, role: 'author' } })).status, 403, 'a member cannot grant themselves authority');
  const m = ok(await call('POST', '/procurement/mandates', { token: owner.token, body: { organisation_id: org.id, handle: delegate.handle, role: 'procurement_admin' } }), 201);
  const t = ok(await create(delegate), 201);
  assert.ok(ok(await call('GET', `/rfps/${t.id}`, { token: delegate.token })).my_roles.includes('owner'));
  ok(await call('POST', `/procurement/mandates/${m.id}/revoke`, { token: owner.token }));
  assert.equal((await create(delegate)).status, 403, 'revocation takes effect at once');
  assert.ok((await pool.query('SELECT revoked_at FROM proc_mandates WHERE id=$1', [m.id])).rows[0].revoked_at, 'the mandate row is kept for history');
  // a mandate with an expiry stops working after it
  ok(await call('POST', '/procurement/mandates', { token: owner.token, body: { organisation_id: org.id, handle: delegate.handle, role: 'author', expires_at: inAt(1) } }), 201);
  assert.equal((await create(delegate)).status, 201);
  await pool.query("UPDATE proc_mandates SET expires_at = now() - interval '1 minute' WHERE user_id=$1", [delegate.id]);
  assert.equal((await create(delegate)).status, 403);
});

test('conflicts: supplier-affiliated people cannot join or act on the buying team for that tender, and revoked reviewers lose access immediately', async () => {
  const w = await world({}, [['A', 100000], ['B', 90000]]);
  await bids(w, { cBad: false });
  const insider = await signup('insider', ['organizer']);
  ok(await call('POST', `/supplier-entities/${w.sup.A.ent.id}/members`, { token: w.sup.A.user.token, body: { handle: insider.handle, role: 'contributor' } }));
  assert.equal((await call('POST', `/rfps/${w.t.id}/members`, { token: w.owner.token, body: { handle: insider.handle, role: 'technical_evaluator' } })).status, 409, 'an affiliated person cannot be added as an evaluator');
  const late = await signup('lateinsider', ['organizer']);
  ok(await call('POST', `/rfps/${w.t.id}/members`, { token: w.owner.token, body: { handle: late.handle, role: 'technical_evaluator' } }));
  ok(await call('POST', `/supplier-entities/${w.sup.A.ent.id}/members`, { token: w.sup.A.user.token, body: { handle: late.handle, role: 'contributor' } }));
  await closeNow(w.t.id);
  for (const u of [w.opener, w.owner]) ok(await call('POST', `/rfps/${w.t.id}/open`, { token: u.token, body: { envelope: 'technical' } }));
  ok(await call('POST', `/rfps/${w.t.id}/conflicts`, { token: late.token, body: { has_conflict: false } }));
  const rb = await call('GET', `/rfps/${w.t.id}/proposals/${w.sup.A.pid}/content?envelope=technical`, { token: late.token });
  assert.equal(rb.status, 403); assert.match(rb.body.error.message, /work for this supplier/, 'a reviewer who works for the bidder cannot read or grade it');
  // a declared conflict with one supplier excludes the reviewer from that supplier only; revocation is immediate
  ok(await call('POST', `/rfps/${w.t.id}/conflicts`, { token: w.tech.token, body: { has_conflict: true, entity_id: w.sup.B.ent.id, note: 'I previously worked for this supplier' } }));
  ok(await call('POST', `/rfps/${w.t.id}/assignments`, { token: w.owner.token, body: { assignments: [{ handle: w.tech.handle, section: 'technical' }] } }));
  assert.equal((await call('GET', `/rfps/${w.t.id}/proposals/${w.sup.B.pid}/content?envelope=technical`, { token: w.tech.token })).status, 403);
  assert.equal((await call('GET', `/rfps/${w.t.id}/proposals/${w.sup.A.pid}/content?envelope=technical`, { token: w.tech.token })).status, 200);
  ok(await call('POST', `/rfps/${w.t.id}/members`, { token: w.owner.token, body: { handle: w.tech.handle, role: 'technical_evaluator', revoke: true } }));
  assert.ok([403, 404].includes((await call('GET', `/rfps/${w.t.id}/proposals/${w.sup.A.pid}/content?envelope=technical`, { token: w.tech.token })).status), 'a revoked reviewer is out on the next read');
  const note = await pool.query("SELECT 1 FROM notifications WHERE kind='tender_role' AND user_id=$1", [w.tech.id]);
  assert.equal(note.rowCount, 1);
});

test('schedule and qualification: scheduled publication stays hidden, a mandatory site visit gates submission, credentials are rechecked before the award', async () => {
  const b = await buyerSide();
  const sched = await publishedTender({ owner: b.owner, approver: b.approver, org: b.org, over: { publish_at: inAt(1) } });
  const sup = await signup('schedsup', ['supplier']); await supplierEntity(sup, 'Scheduled Ltd');
  assert.ok(!ok(await call('GET', '/tenders', { token: sup.token })).some((x) => x.id === sched.id), 'a scheduled tender is not shown yet');
  assert.equal((await call('GET', `/tenders/${sched.id}`, { token: sup.token })).status, 404);
  await pool.query("UPDATE proc_projects SET publish_at = now() - interval '1 minute' WHERE id=$1", [sched.id]);
  assert.equal((await call('GET', `/tenders/${sched.id}`, { token: sup.token })).status, 200, 'visible from the stated time');
  // mandatory site visit + required insurance
  const w = await world({ site_visit_at: inAt(2), site_visit_mandatory: true, required_credentials: [{ kind: 'insurance', title: 'Public liability insurance', verified_required: false }] }, [['A', 100000]]);
  const s = w.sup.A;
  const el = ok(await call('GET', `/tenders/${w.t.id}/eligibility?entity_id=${s.ent.id}`, { token: s.user.token }));
  assert.equal(el.meets_requirements, false); assert.equal(el.checks[0].state, 'missing');
  const cred = ok(await call('POST', `/supplier-entities/${s.ent.id}/credentials`, { token: s.user.token, body: { kind: 'insurance', title: 'Public liability', valid_to: dateOf(400) } }), 201);
  assert.equal(ok(await call('GET', `/tenders/${w.t.id}/eligibility?entity_id=${s.ent.id}`, { token: s.user.token })).meets_requirements, true);
  const pr = ok(await call('POST', `/tenders/${w.t.id}/proposals`, { token: s.user.token, body: { entity_id: s.ent.id, lots: ['L1', 'L2'] } }), 201);
  ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: s.user.token, body: { draft_version: pr.draft_version, ...goodDraft(1000) } }));
  const submit = () => call('POST', `/proposals/${pr.id}/submit`, { token: s.user.token, body: { idempotency_key: `visit-${Math.random().toString(36).slice(2)}`, declaration: true } });
  const blocked = await submit(); assert.equal(blocked.status, 422); assert.ok(blocked.body.error.details.items.some((i) => i.key === 'site_visit'));
  ok(await call('POST', `/rfps/${w.t.id}/site-visit`, { token: w.owner.token, body: { entity_id: s.ent.id, attended: true } }));
  ok(await submit()); s.pid = pr.id;
  await evaluate(w, { keys: ['A'], marks: { A: [9, 8] } });
  const sc = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'single_supplier' } }), 201);
  const rec = ok(await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: sc.id, rationale: 'Only eligible bidder with valid insurance.' } }), 201);
  ok(await call('POST', `/approvals/${rec.approval_id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  await pool.query("UPDATE supplier_credentials SET valid_to = current_date - 1 WHERE id=$1", [cred.id]);
  const refused = await call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: {} });
  assert.equal(refused.status, 409); assert.ok(refused.body.error.details.problems.some((p) => /expires/.test(p)), 'an expired certificate blocks the award notice');
  await pool.query("UPDATE supplier_credentials SET valid_to = current_date + 400 WHERE id=$1", [cred.id]);
  ok(await call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: {} }));
});

test('outcomes and reporting: public award fields only when disclosed, reports exclude withdrawn bids and cancelled orders, exports never carry sealed content', async () => {
  const w = await world({ disclosure: { rank: false, bidder_count: false, award_public: true } }, [['A', 100000], ['B', 90000]]);
  await bids(w);
  assert.ok(!JSON.stringify(ok(await call('GET', '/procurement/reports/export?scope=buyer&format=csv', { token: w.owner.token }))).match(/trained crew|rate_minor/), 'exports carry no sealed content before the opening');
  await call('POST', `/proposals/${w.sup.B.pid}/withdraw`, { token: w.sup.B.user.token, body: {} });
  await evaluate(w, { keys: ['A'], marks: { A: [9, 8] } });
  const rep0 = ok(await call('GET', '/procurement/reports?scope=buyer', { token: w.owner.token }));
  assert.equal(rep0.participation.submitted, 1, 'withdrawn proposals are not counted as submitted');
  const { award } = await awardAll(w, 'single_supplier', w.sup.A.user);
  assert.equal(ok(await call('GET', `/tenders/${w.t.id}`, { token: w.sup.B.user.token })).public_award, null, 'an award alone is not public');
  // the chair chooses the fields and a different approver approves the notice; only then is anything public
  const req = ok(await call('POST', `/rfps/${w.t.id}/award-publication`, { token: w.chair.token, body: { fields: ['supplier'] } }), 201);
  ok(await call('POST', `/approvals/${req.approval_id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  const pub = ok(await call('GET', `/tenders/${w.t.id}`, { token: w.sup.B.user.token }));
  assert.deepEqual(pub.public_award.awards.map((x) => Object.keys(x).sort()), [['supplier'], ['supplier']], 'only the approved fields are public');
  assert.ok(!JSON.stringify(pub).includes('4600000'), 'no amounts are public');
  const order = ok(await call('GET', `/procurement-orders?project_id=${w.t.id}`, { token: w.owner.token }))[0];
  const before = ok(await call('GET', '/procurement/reports?scope=buyer', { token: w.owner.token })).spend.committed_minor.INR;
  ok(await call('POST', `/procurement-orders/${order.id}/update`, { token: w.owner.token, body: { action: 'cancel', reason: 'Event cancelled by the venue' } }));
  const after = ok(await call('GET', '/procurement/reports?scope=buyer', { token: w.owner.token })).spend.committed_minor.INR ?? 0;
  assert.ok(after < before, 'a cancelled order leaves the committed total');
  // a tender with the default policy publishes nothing
  const w2 = await world({}, [['A', 100000]]); await bids(w2, { keys: ['A'] }); await evaluate(w2, { keys: ['A'], marks: { A: [9, 8] } }); await awardAll(w2, 'single_supplier', w2.sup.A.user);
  const sup = await signup('observer', ['supplier']); await supplierEntity(sup, 'Observer Ltd');
  assert.equal(ok(await call('GET', `/tenders/${w2.t.id}`, { token: sup.token })).public_award, null);
});

test('notifications and cache rules: deadline reminders once, evaluator assignment, sealed responses are never cacheable', async () => {
  const w = await world({}, [['A', 100000], ['B', 90000]]);
  await bids(w, { keys: ['A'] });
  await pool.query("UPDATE proc_projects SET closes_at = now() + interval '12 hours' WHERE id=$1", [w.t.id]);
  const n1 = await sendTenderReminders(), n2 = await sendTenderReminders();
  assert.ok(n1 >= 1 && n2 === 0, 'reminders go once to people who have not submitted');
  const got = await pool.query("SELECT user_id FROM notifications WHERE kind='tender_deadline' AND (data->>'project_id')=$1", [w.t.id]);
  assert.deepEqual(got.rows.map((r) => r.user_id), [w.sup.B.user.id], 'the supplier who already submitted is not nagged');
  await bids(w, { keys: ['B'] });
  await evaluate(w, { keys: ['A', 'B'], marks: { A: [9, 8], B: [6, 6] }, commit: false });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='tender_assignment' AND user_id=$1", [w.tech.id])).rows[0].n, 1, 'the reviewer is told of the assignment');
  ok(await call('POST', `/rfps/${w.t.id}/conflicts`, { token: w.chair.token, body: { has_conflict: false } }));
  const r = await call('GET', `/rfps/${w.t.id}/proposals/${w.sup.A.pid}/content?envelope=technical`, { token: w.chair.token });
  assert.equal(r.status, 200); assert.match(r.headers.get('cache-control'), /no-store/);
  const rec = await call('GET', `/proposals/${w.sup.A.pid}/receipt`, { token: w.sup.A.user.token }); assert.match(rec.headers.get('cache-control'), /no-store/);
});

test('cancel and reissue keep the original and copy only structure', async () => {
  const b = await buyerSide();
  const t = await publishedTender({ owner: b.owner, approver: b.approver, org: b.org });
  assert.equal((await call('POST', `/rfps/${t.id}/reissue`, { token: b.owner.token, body: { reason: 'Reissue while still live' } })).status, 409);
  ok(await call('POST', `/rfps/${t.id}/schedule`, { token: b.owner.token, body: { action: 'cancel', reason: 'Scope changed completely' } }));
  const n = ok(await call('POST', `/rfps/${t.id}/reissue`, { token: b.owner.token, body: { reason: 'Reissued with a new scope' } }), 201);
  assert.equal(n.parent_id, t.id); assert.equal(n.status, 'draft'); assert.notEqual(n.ref, t.ref);
  assert.equal(ok(await call('GET', `/rfps/${n.id}`, { token: b.owner.token })).lots.length, 2, 'lots are copied');
  assert.equal((await pool.query("SELECT status FROM proc_projects WHERE id=$1", [t.id])).rows[0].status, 'cancelled', 'the original keeps its status and history');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_approvals WHERE project_id=$1', [n.id])).rows[0].n, 0, 'approvals are never copied');
});
