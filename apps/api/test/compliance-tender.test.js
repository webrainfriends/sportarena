// A tender award is a compliance gate (#568 on #595): the buyer's own rulebook governs the suppliers it awards to, a supplier answers it from the
// tender, and the award is refused (and the refusal kept) until every awarded supplier is clear.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, ok, pool, start, stop, world, bids, evaluate } from './tender-helpers.js';

before(start);
after(stop);

test('an award is refused until the awarded supplier has answered the buyer\'s rule, then goes through; the refusal is kept in the decision trail', async () => {
  const w = await world({}, [['A', 100000]]);
  await bids(w, { cBad: false });
  await evaluate(w, { marks: { A: [9, 8] } });

  const rule = ok(await call('POST', '/compliance/requirements', { token: w.owner.token, body: {
    scope_kind: 'organisation', scope_id: w.org.id, name: 'Supplier conduct declaration', category: 'declaration', subject_kind: 'person', method: 'declaration',
    statement: 'I confirm our crew follow the buyer\'s conduct code.', classification: 'contractual' } }), 201);
  ok(await call('POST', `/compliance/requirements/${rule.id}/obligations`, { token: w.owner.token, body: { roles: ['supplier'], consequences: ['tender_award'] } }), 201);

  const sc = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'highest_score' } }), 201);
  const refused = await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: sc.id, rationale: 'Best scoring compliant bidder covering every lot.' } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.details.code, 'compliance_blocked');
  assert.equal(refused.body.error.details.blockers[0].rule, 'Supplier conduct declaration');

  const kept = (await pool.query("SELECT consequence, blocked FROM comp_decisions WHERE consequence='tender_award'")).rows;
  assert.ok(kept.length >= 1 && kept.every((d) => d.blocked));

  // the supplier answers from the tender (it is not in the supplier's own scope, so the tender is how the rule reaches them)
  ok(await call('POST', '/compliance/records', { token: w.sup.A.user.token, body: { requirement_id: rule.id, confirm: true, statement_version: 1, tender_id: w.t.id } }), 201);
  ok(await call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: sc.id, rationale: 'Best scoring compliant bidder covering every lot.' } }), 201);
});

test('someone who is not in the tender cannot answer its rules', async () => {
  const w = await world({}, [['A', 100000]]);
  const rule = ok(await call('POST', '/compliance/requirements', { token: w.owner.token, body: { scope_kind: 'organisation', scope_id: w.org.id, name: 'Conduct', category: 'declaration', subject_kind: 'person', method: 'declaration', statement: 'I agree.' } }), 201);
  ok(await call('POST', `/compliance/requirements/${rule.id}/obligations`, { token: w.owner.token, body: { roles: ['supplier'], consequences: ['tender_award'] } }), 201);
  const r = await call('POST', '/compliance/records', { token: w.chair.token, body: { requirement_id: rule.id, confirm: true, statement_version: 1, tender_id: w.t.id } });
  assert.ok([403, 404, 409].includes(r.status), JSON.stringify(r.body));
});
