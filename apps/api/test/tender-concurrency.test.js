import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, ok, signup, start, stop, pool, publishedTender, supplierEntity, part, buyerSide, inAt, goodDraft, closeNow, world, bids, evaluate, awardAll } from './tender-helpers.js';

before(start);
after(stop);

test('alternatives are only allowed where the tender allows them, and each entity keeps one proposal per alternative', async () => {
  const w = await world({ allow_alternatives: true }, [['A', 100000]]);
  const s = w.sup.A;
  const start = (alt) => call('POST', `/tenders/${w.t.id}/proposals`, { token: s.user.token, body: { entity_id: s.ent.id, lots: ['L1', 'L2'], alt_key: alt } });
  const base = ok(await start('base'), 201), alt = ok(await start('alt1'), 201), again = ok(await start('alt1'), 201);
  assert.notEqual(base.id, alt.id); assert.equal(alt.id, again.id, 'the same alternative is the same proposal');
  const noAlt = await world({}, [['A', 100000]]);
  assert.equal((await call('POST', `/tenders/${noAlt.t.id}/proposals`, { token: noAlt.sup.A.user.token, body: { entity_id: noAlt.sup.A.ent.id, lots: ['L1'], alt_key: 'alt1' } })).status, 400);
});

test('concurrency: retried and parallel submissions never duplicate, a race with the deadline is decided by server time, uploads stop at close', async () => {
  const w = await world({}, [['A', 100000]]);
  const s = w.sup.A;
  const pr = ok(await call('POST', `/tenders/${w.t.id}/proposals`, { token: s.user.token, body: { entity_id: s.ent.id, lots: ['L1', 'L2'] } }), 201);
  ok(await call('PATCH', `/proposals/${pr.id}/draft`, { token: s.user.token, body: { draft_version: pr.draft_version, ...goodDraft(1000) } }));
  const submit = (key) => call('POST', `/proposals/${pr.id}/submit`, { token: s.user.token, body: { idempotency_key: key, declaration: true } });
  const same = await Promise.all(Array.from({ length: 6 }, () => submit('parallel-same-key')));
  assert.ok(same.every((r) => r.status === 200), JSON.stringify(same.map((r) => r.status)));
  assert.equal(new Set(same.map((r) => r.body.receipt_no)).size, 1, 'six parallel retries, one receipt');
  const diff = await Promise.all(Array.from({ length: 4 }, (_, i) => submit(`parallel-diff-key-${i}`)));
  assert.ok(diff.every((r) => r.status === 200));
  const versions = (await pool.query('SELECT version FROM proc_submissions WHERE proposal_id=$1 ORDER BY version', [pr.id])).rows.map((r) => r.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5], 'versions are gapless and unique under parallel load');
  // a race with the deadline: every accepted receipt predates the close instant; everything after is refused
  await pool.query("UPDATE proc_projects SET closes_at = clock_timestamp() + interval '700 milliseconds' WHERE id=$1", [w.t.id]);
  const rs = [];
  const fire = async (delay, n) => { await new Promise((r) => setTimeout(r, delay)); const r = await submit(`race-key-${n}`); rs.push({ status: r.status, at: new Date(), body: r.body }); };
  await Promise.all([0, 150, 300, 450, 600, 750, 900, 1050].map((d, n) => fire(d, n)));
  const closes = new Date((await pool.query('SELECT closes_at FROM proc_projects WHERE id=$1', [w.t.id])).rows[0].closes_at);
  assert.ok(rs.some((r) => r.status === 200) && rs.some((r) => r.status === 409), 'the window both accepted and refused');
  for (const r of rs.filter((x) => x.status === 200)) assert.ok(new Date(r.body.submitted_at) < closes, 'an accepted proposal was committed before the close instant');
  for (const r of rs.filter((x) => x.status === 409)) assert.match(r.body.error.message, /deadline has passed/);
  assert.equal(rs.filter((x) => x.status === 200).length, (await pool.query("SELECT count(*)::int AS n FROM proc_submissions WHERE proposal_id=$1 AND idempotency_key LIKE 'race-key-%'", [pr.id])).rows[0].n, 'every 200 has a durable row; no 409 left one behind');
  // delayed upload after the close
  const up = await call('PUT', `/proposals/${pr.id}/files?envelope=technical&name=late.pdf`, { token: s.user.token, raw: Buffer.from('%PDF-1.4\n%%EOF') });
  assert.equal(up.status, 409);
});

test('awards and call-offs: parallel issue and parallel call-offs cannot over-commit', async () => {
  const w = await world({ contract_type: 'framework', ceiling_minor: 1000000 }, [['A', 100000]]);
  await bids(w, { keys: ['A'] });
  await evaluate(w, { keys: ['A'], marks: { A: [9, 8] } });
  const sc = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'single_supplier' } }), 201);
  const rec = ok(await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: sc.id, rationale: 'Only eligible bidder covering every lot.' } }), 201);
  assert.equal((await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: sc.id, rationale: 'A second award for the same tender at once.' } })).status, 409, 'one award in flight at a time');
  ok(await call('POST', `/approvals/${rec.approval_id}/decide`, { token: w.approver.token, body: { decision: 'approve' } }));
  const issued = await Promise.all([1, 2, 3].map(() => call('POST', `/awards/${rec.id}/notify`, { token: w.chair.token, body: {} })));
  assert.deepEqual(issued.map((r) => r.status).sort(), [200, 409, 409], 'exactly one notice is issued');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_award_lines WHERE award_id=$1', [rec.id])).rows[0].n, 2);
  const award = ok(await call('GET', `/awards/${rec.id}`, { token: w.chair.token }));
  for (const l of award.lines) ok(await call('POST', `/award-lines/${l.id}/respond`, { token: w.sup.A.user.token, body: { action: 'accept' } }));
  const orders = ok(await call('GET', `/procurement-orders?project_id=${w.t.id}`, { token: w.owner.token }));
  const o = orders[0], ceiling = Number(o.ceiling_minor);
  const offs = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', `/procurement-orders/${o.id}/call-offs`, { token: w.owner.token, body: { amount_minor: Math.floor(ceiling * 0.3), description: `Parallel call-off ${i}`, idempotency_key: `parallel-off-${i}` } })));
  assert.equal(offs.filter((r) => r.status === 201).length, 3, 'only three 30% call-offs fit under the ceiling');
  const used = (await pool.query("SELECT coalesce(sum(amount_minor),0)::bigint AS s FROM proc_calloffs WHERE order_id=$1 AND status='approved'", [o.id])).rows[0].s;
  assert.ok(Number(used) <= ceiling);
});

test('restricted tenders: access is requested, approved by the buying team and only then can a supplier bid; notifications reach participants only', async () => {
  const { owner, approver, org } = await buyerSide();
  const t = await publishedTender({ owner, approver, org, over: { publication: 'restricted' } });
  const sup = await signup('restrictedsup', ['supplier']), ent = await supplierEntity(sup, 'Request Ltd'), outsider = await signup('outsider', ['athlete']);
  assert.ok(ok(await call('GET', '/tenders', { token: sup.token })).some((c) => c.id === t.id), 'restricted tenders are listed to suppliers as cards');
  const card = ok(await call('GET', `/tenders/${t.id}`, { token: sup.token })); assert.equal(card.restricted_view, true); assert.equal(card.notice, undefined, 'no scope, lots or documents before approval');
  assert.equal((await call('GET', `/tenders/${t.id}`, { token: outsider.token })).status, 404, 'a person without a supplier entity cannot see a restricted tender');
  ok(await call('POST', `/tenders/${t.id}/participation`, { token: sup.token, body: { entity_id: ent.id, action: 'request' } }));
  assert.equal((await call('POST', `/tenders/${t.id}/participation`, { token: sup.token, body: { entity_id: ent.id, action: 'accept_terms' } })).status, 200);
  assert.equal((await call('POST', `/tenders/${t.id}/proposals`, { token: sup.token, body: { entity_id: ent.id, lots: ['L1'] } })).status, 403, 'a pending request is not admission');
  ok(await call('POST', `/rfps/${t.id}/invites`, { token: owner.token, body: { decide: [{ entity_id: ent.id, decision: 'approve' }] } }));
  const full = ok(await call('GET', `/tenders/${t.id}`, { token: sup.token })); assert.ok(full.notice.scope);
  ok(await call('POST', `/tenders/${t.id}/proposals`, { token: sup.token, body: { entity_id: ent.id, lots: ['L1'] } }), 201);
  ok(await call('POST', `/rfps/${t.id}/addenda`, { token: owner.token, body: { summary: 'Clarification only', reason: 'Answer to a question', changes: {} } }), 201);
  const n = (await pool.query("SELECT user_id FROM notifications WHERE kind='tender_addendum' AND (data->>'project_id')=$1", [t.id])).rows.map((r) => r.user_id);
  assert.ok(n.includes(sup.id) && !n.includes(outsider.id), 'only participants are told about the addendum');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='tender_addendum' AND (data->>'project_id')=$1 AND user_id=$2", [t.id, sup.id])).rows[0].n, 1, 'notifications are not duplicated');
});
