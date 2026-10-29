import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
const { call, ok, start, stop, pool, world, bids, evaluate, dateOf } = await import('./tender-helpers.js');

before(start);
after(stop);

const platformAdmin = async (handle, email) => {
  const r = ok(await call('POST', '/auth/register', { body: { handle, display_name: handle, email, password: 'correct-horse-battery', roles: ['athlete'] } }), 201);
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [r.user.id]);
  return { id: r.user.id, token: r.token };
};

test('procurement: an award cannot be recommended until the rules in force are met for every supplier it would award; supplier credentials are the evidence', async () => {
  const a1 = await platformAdmin('pcmp_one', 'rraja.edge@gmail.com'), a2 = await platformAdmin('pcmp_two', 'rrajas1978@icloud.com');
  const w = await world({}, [['A', 100000], ['B', 90000]]);
  await bids(w, { cBad: false });
  await evaluate(w, { marks: { A: [9, 8], B: [6, 6] } });
  const made = ok(await call('POST', '/compliance/rules', { token: a1.token, body: {
    key: 'proc.pli.test', scope: 'platform', domains: ['procurement'], topic: 'proc.pli', title: 'Supplier public liability cover', classification: 'regulatory', effective_from: dateOf(-3),
    approval_owner: 'Procurement counsel', applies: { roles: ['supplier'] }, requirements: [{ key: 'pli', kind: 'insurance', label: 'Public liability insurance', holder: 'supplier_entity' }] } }), 201);
  ok(await call('POST', `/compliance/versions/${made.version_id}/decision`, { token: a2.token, body: { decision: 'approve' } }));
  const sc = ok(await call('POST', `/rfps/${w.t.id}/scenarios`, { token: w.chair.token, body: { kind: 'highest_score' } }), 201);
  const rec = () => call('POST', `/rfps/${w.t.id}/awards`, { token: w.chair.token, body: { scenario_id: sc.id, rationale: 'Best scoring compliant bidder covering every lot.' } });
  const refused = await rec();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.details.code, 'compliance_blocked');
  assert.match(refused.body.error.details.blockers[0].reason, /Public liability insurance/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_awards WHERE project_id=$1', [w.t.id])).rows[0].n, 0, 'no award was created');
  // the engine reads supplier credentials where they live; it does not copy them
  const awarded = [...new Set((await pool.query('SELECT result FROM proc_scenarios WHERE id=$1', [sc.id])).rows[0].result.allocation.map((x) => x.entity))];
  assert.ok(awarded.length >= 1);
  for (const e of awarded) await pool.query("INSERT INTO supplier_credentials(entity_id, kind, title, status, valid_to) VALUES ($1,'insurance','Public liability','declared',$2)", [e, dateOf(300)]);
  assert.equal((await rec()).status, 409, 'a declared credential is not a verified one');
  await pool.query("UPDATE supplier_credentials SET status='verified', verified_by=$1, verified_at=now() WHERE entity_id = ANY($2)", [w.owner.id, awarded]);
  ok(await rec(), 201);
  const log = ok(await call('GET', `/compliance/decisions?subject_type=supplier_entity&subject_id=${awarded[0]}&tender_id=${w.t.id}`, { token: w.owner.token }));
  assert.ok(log.length >= 1 && log.some((d) => d.trigger === 'award_recommend'));
  // an expired credential is non-compliant, not silently accepted
  await pool.query("UPDATE supplier_credentials SET valid_to = current_date - 1 WHERE entity_id = ANY($1)", [awarded]);
  const again = ok(await call('POST', '/compliance/evaluate', { token: w.owner.token, body: { subject_type: 'supplier_entity', subject_id: awarded[0], tender_id: w.t.id, domain: 'procurement' } }), 200);
  assert.equal(again.results.find((r) => r.key === 'proc.pli.test').status, 'non_compliant');
});
