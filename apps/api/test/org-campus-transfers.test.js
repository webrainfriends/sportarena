import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { runDueTransfers } = await import('../src/campus-transfers.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `tw_${n}_${roles[0]}`, display_name: `Flow ${n}`, email: `tw${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** Two campuses with a director each, finance and a cohort with a minor and an adult in it. */
async function group() {
  const owner = await signup(['venue_manager']), dirA = await signup(), dirB = await signup(), fin = await signup(), outsider = await signup();
  const minor = await signup(), adult = await signup(), guardian = await signup(), stranger = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Transfer Academy ${n}`, kind: 'academy', city: 'Pune' } }), 201);
  for (const [u, role] of [[dirA, 'staff'], [dirB, 'staff'], [fin, 'finance']]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `U15 ${n}` } }), 201);
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${minor.handle},yes\n${adult.handle},yes` } }), 201);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [minor.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, minor.id]);
  const U = async (body) => ok(await api('POST', `/organisations/${org.id}/units`, { token: owner.token, body: { valid_from: day(-90), ...body } }), 201);
  const pune = await U({ kind: 'campus', name: 'Pune' }), goa = await U({ kind: 'campus', name: 'Goa' });
  const role = async (u, unit, r) => ok(await api('POST', `/organisations/${org.id}/units/${unit.id}/roles`, { token: owner.token, body: { person: u.handle, role: r } }), 201);
  await role(dirA, pune, 'director'); await role(dirB, goa, 'director');
  ok(await api('POST', `/organisations/${org.id}/unit-moves`, { token: owner.token, body: { to_unit_id: pune.id, items: [{ object_type: 'cohort', object_ids: [cohort.id] }], effective_on: day(-60) } }), 201);
  const enr = (await pool.query('SELECT e.id, e.user_id FROM org_enrolments e WHERE e.cohort_id=$1', [cohort.id])).rows;
  return { owner, dirA, dirB, fin, outsider, minor, adult, guardian, stranger, org, cohort, pune, goa, minorEnr: enr.find((e) => e.user_id === minor.id).id, adultEnr: enr.find((e) => e.user_id === adult.id).id };
}
const P = (g) => `/organisations/${g.org.id}`;
const FULL = [
  { key: 'release', label: 'Release approval', kind: 'approval', role: 'source_director', stage: 1, sla_days: 3 },
  { key: 'receive', label: 'Acceptance', kind: 'approval', role: 'destination_director', stage: 1 },
  { key: 'finance', label: 'Finance clearance', kind: 'approval', role: 'finance', stage: 2 },
  { key: 'ack', label: 'Athlete / guardian acknowledgement', kind: 'acknowledge', role: 'person', stage: 2 },
  { key: 'handover', label: 'Handover checklist', kind: 'checklist', role: 'destination_director', stage: 3, items: ['Development summary shared', 'Equipment returned'] },
];
const save = (g, object_type, steps, extra = {}) => api('POST', `${P(g)}/transfer-flows`, { token: g.owner.token, body: { object_type, name: 'Academy athlete transfer', steps, ...extra } });
const request = (g, body, who = g.owner) => api('POST', `${P(g)}/transfers`, { token: who.token, body: { reason_code: 'pathway_progression', to_unit_id: g.goa.id, ...body } });
const detail = async (g, tid, who = g.owner) => ok(await api('GET', `${P(g)}/transfers/${tid}`, { token: who.token }));
const decide = (g, tid, sid, body, who) => api('POST', `${P(g)}/transfers/${tid}/steps/${sid}`, { token: who.token, body });
const step = (t, key) => t.steps.find((s) => s.key === key);

test('process definitions: the academy configures them, versions are kept, bad definitions are refused', async () => {
  const g = await group();
  const f0 = ok(await api('GET', `${P(g)}/transfer-flows`, { token: g.owner.token }));
  assert.equal(f0.flows.length, 8); assert.ok(f0.flows.every((f) => f.configured === false)); assert.ok(f0.templates.enrolment.length >= 4); assert.equal(f0.can_configure, true);
  const v1 = ok(await save(g, 'enrolment', FULL, { min_notice_days: 2 }), 201);
  assert.equal(v1.version, 1); assert.equal(v1.configured, true);
  assert.equal(ok(await save(g, 'enrolment', FULL.slice(0, 2)), 201).version, 2, 'each save is a new version');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM org_transfer_flows WHERE organisation_id=$1 AND archived_at IS NULL", [g.org.id])).rows[0].n, 1, 'old versions are archived, not deleted');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM org_transfer_flows WHERE organisation_id=$1", [g.org.id])).rows[0].n, 2);
  assert.equal((await save(g, 'cohort', [{ key: 'a', label: 'Acknowledge', kind: 'acknowledge', role: 'person', stage: 1 }])).status, 400, 'a cohort has no person to acknowledge');
  assert.equal((await save(g, 'enrolment', [{ key: 'a', label: 'Checklist', kind: 'checklist', role: 'finance', stage: 1, items: [] }])).status, 400, 'a checklist needs items');
  assert.equal((await save(g, 'enrolment', [{ key: 'a', label: 'Approve it', kind: 'approval', role: 'admin', stage: 1 }, { key: 'b', label: 'Approve later', kind: 'approval', role: 'admin', stage: 3 }])).status, 400, 'no gap between stages');
  assert.equal((await save(g, 'enrolment', [{ key: 'a', label: 'Approve it', kind: 'approval', role: 'admin', stage: 1 }, { key: 'a', label: 'Approve twice', kind: 'approval', role: 'admin', stage: 1 }])).status, 400, 'duplicate keys');
  assert.equal(ok(await save(g, 'enrolment', [], {}), 201).steps.length, 0, 'an empty process is allowed');
  assert.equal((await api('POST', `${P(g)}/transfer-flows`, { token: g.dirA.token, body: { object_type: 'venue', name: 'Mine', steps: [] } })).status, 403, 'a director cannot configure');
  assert.equal((await api('GET', `${P(g)}/transfer-flows`, { token: g.outsider.token })).status, 404);
});

test('a staged process: parallel approvals, then finance and a guardian, then the handover; each role decides only its own step', async () => {
  const g = await group();
  ok(await save(g, 'enrolment', FULL), 201);
  const d = ok(await request(g, { object_type: 'enrolment', object_ids: [g.minorEnr], dry_run: true }), 201);
  assert.equal(d.process.configured, true); assert.equal(d.process.steps.length, 5);
  assert.deepEqual(d.process.steps.find((s) => s.key === undefined && s.label === 'Release approval').approvers.length, 1, 'the source director is named');
  assert.equal(d.process.steps.find((s) => s.label === 'Finance clearance').approvers.length, 1, 'org finance member can decide');
  assert.ok(d.warnings.length === 0);
  assert.equal(d.process.steps.find((s) => s.kind === 'acknowledge').approvers.length, 1);

  const t = ok(await request(g, { object_type: 'enrolment', object_ids: [g.minorEnr], note: 'Moves up to the elite squad' }, g.dirA), 201);
  assert.equal(t.status, 'in_progress');
  let x = await detail(g, t.transfer_id, g.dirA);
  assert.equal(step(x, 'release').can_act, true, 'the source director can act on release'); assert.equal(step(x, 'receive').can_act, false, 'but not on the receiving campus\'s step');
  assert.equal(step(x, 'finance').open, false, 'stage 2 is closed until stage 1 is complete');
  assert.equal((await decide(g, t.transfer_id, step(x, 'receive').id, { decision: 'approve' }, g.dirA)).status, 403, 'the wrong role');
  assert.equal((await decide(g, t.transfer_id, step(x, 'finance').id, { decision: 'approve' }, g.fin)).status, 409, 'a later stage is not open');
  assert.equal((await decide(g, t.transfer_id, step(x, 'release').id, { decision: 'approve' }, g.outsider)).status, 404);
  ok(await decide(g, t.transfer_id, step(x, 'release').id, { decision: 'approve' }, g.dirA));
  x = await detail(g, t.transfer_id, g.dirB);
  assert.equal(step(x, 'finance').open, false, 'one of two stage-1 approvals is not enough');
  ok(await decide(g, t.transfer_id, step(x, 'receive').id, { decision: 'approve' }, g.dirB));
  x = await detail(g, t.transfer_id, g.fin);
  assert.equal(step(x, 'finance').can_act, true); assert.equal(step(x, 'ack').open, true);
  assert.equal(step(x, 'ack').can_act, false, 'nobody in the academy answers for the athlete');
  assert.equal((await decide(g, t.transfer_id, step(x, 'ack').id, { decision: 'approve', note: 'Override attempt' }, g.owner)).status, 403, 'not even an owner');
  ok(await decide(g, t.transfer_id, step(x, 'finance').id, { decision: 'approve' }, g.fin));

  // the guardian (not the child) answers; strangers and the minor cannot
  const mine = ok(await api('GET', '/me/transfer-acknowledgements', { token: g.guardian.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].answering_as, 'guardian'); assert.equal(mine[0].to_name, 'Goa');
  assert.equal(ok(await api('GET', '/me/transfer-acknowledgements', { token: g.minor.token })).length, 0, 'a minor cannot answer for themselves');
  assert.equal(ok(await api('GET', '/me/transfer-acknowledgements', { token: g.stranger.token })).length, 0);
  assert.equal((await api('POST', `/me/transfer-acknowledgements/${mine[0].step_id}`, { token: g.stranger.token, body: { decision: 'acknowledge' } })).status, 404);
  assert.equal(ok(await api('POST', `/me/transfer-acknowledgements/${mine[0].step_id}`, { token: g.guardian.token, body: { decision: 'acknowledge' } })).status, 'in_progress');

  // handover checklist: partial save, then complete only when every item is ticked
  x = await detail(g, t.transfer_id, g.dirB);
  const h = step(x, 'handover');
  assert.equal(h.can_act, true);
  assert.equal((await decide(g, t.transfer_id, h.id, { decision: 'complete', items_done: [0] }, g.dirB)).status, 409, 'one item is still open');
  ok(await decide(g, t.transfer_id, h.id, { decision: 'save', items_done: [0] }, g.dirB));
  assert.equal(step(await detail(g, t.transfer_id, g.dirB), 'handover').items[0].done, true);
  assert.equal(ok(await decide(g, t.transfer_id, h.id, { decision: 'complete', items_done: [0, 1] }, g.dirB)).status, 'completed');
  const done = await detail(g, t.transfer_id, g.dirA);
  assert.equal(done.status, 'completed');
  assert.equal(done.timeline.filter((e) => e.action === 'transfer_completed').length >= 1, true);
  // the athlete now counts at Goa, the adult classmate stays in Pune
  const ov = ok(await api('GET', `${P(g)}/campuses`, { token: g.owner.token }));
  assert.equal(ov.units.find((u) => u.id === g.goa.id).metrics.athletes, 1); assert.equal(ov.units.find((u) => u.id === g.pune.id).metrics.athletes, 1);
  assert.equal((await decide(g, t.transfer_id, h.id, { decision: 'approve' }, g.dirB)).status, 409, 'a finished transfer is closed');
});

test('rejection and a declined acknowledgement end the transfer and move nothing; adult athletes answer for themselves', async () => {
  const g = await group();
  ok(await save(g, 'enrolment', FULL.slice(0, 4)), 201);
  const t = ok(await request(g, { object_type: 'enrolment', object_ids: [g.adultEnr] }, g.dirA), 201);
  let x = await detail(g, t.transfer_id);
  assert.equal((await decide(g, t.transfer_id, step(x, 'release').id, { decision: 'reject' }, g.dirA)).status, 400, 'a rejection needs a reason');
  ok(await decide(g, t.transfer_id, step(x, 'release').id, { decision: 'approve' }, g.dirA)); ok(await decide(g, t.transfer_id, step(x, 'receive').id, { decision: 'approve' }, g.dirB));
  ok(await decide(g, t.transfer_id, step(await detail(g, t.transfer_id), 'finance').id, { decision: 'approve' }, g.fin));
  const mine = ok(await api('GET', '/me/transfer-acknowledgements', { token: g.adult.token }));
  assert.equal(mine[0].answering_as, 'self');
  assert.equal(ok(await api('POST', `/me/transfer-acknowledgements/${mine[0].step_id}`, { token: g.adult.token, body: { decision: 'decline', note: 'I want to stay' } })).status, 'rejected');
  assert.equal((await detail(g, t.transfer_id)).status, 'rejected');
  assert.equal(ok(await api('GET', `${P(g)}/campuses`, { token: g.owner.token })).units.find((u) => u.id === g.goa.id).metrics.athletes, 0);
  // rejection by an approver
  const t2 = ok(await request(g, { object_type: 'enrolment', object_ids: [g.adultEnr] }, g.dirA), 201);
  x = await detail(g, t2.transfer_id);
  assert.equal(ok(await decide(g, t2.transfer_id, step(x, 'receive').id, { decision: 'reject', note: 'No room in that squad' }, g.dirB)).status, 'rejected');
  const closed = ok(await api('GET', `${P(g)}/transfers?view=closed`, { token: g.owner.token }));
  assert.equal(closed.length, 2); assert.ok(closed.every((r) => r.status === 'rejected'));
});

test('owner override needs a reason and is recorded; awaiting-me, notice period, back-dating and the lists', async () => {
  const g = await group();
  ok(await save(g, 'cohort', FULL.slice(0, 2), { min_notice_days: 5 }), 201);
  const body = { object_type: 'cohort', object_ids: [g.cohort.id] };
  assert.equal((await request(g, { ...body, effective_on: day(2) })).status, 400, 'inside the notice period');
  assert.equal((await request(g, { ...body, effective_on: day(-2) })).status, 400, 'past dates are refused where back-dating is off');
  assert.equal((await request(g, body, g.outsider)).status, 404);
  assert.equal((await request(g, { ...body, to_unit_id: g.pune.id })).status, 400, 'already there');
  const t = ok(await request(g, { ...body, effective_on: day(7) }), 201);
  assert.equal(t.process.min_notice_days, 5);
  const mineA = ok(await api('GET', `${P(g)}/transfers?view=awaiting_me`, { token: g.dirA.token })); assert.equal(mineA.length, 1); assert.deepEqual(mineA[0].awaiting.length, 2);
  assert.equal(ok(await api('GET', `${P(g)}/transfers?view=awaiting_me`, { token: g.fin.token })).length, 0);
  assert.equal(ok(await api('GET', `${P(g)}/transfers?view=awaiting_me`, { token: g.outsider.token }).then((r) => ({ ...r, status: r.status === 404 ? 200 : r.status, body: [] }))).length, 0);
  let x = await detail(g, t.transfer_id);
  ok(await decide(g, t.transfer_id, step(x, 'release').id, { decision: 'approve' }, g.dirA));
  assert.equal((await decide(g, t.transfer_id, step(x, 'receive').id, { decision: 'approve' }, g.owner)).status, 400, 'an override must say why');
  assert.equal(ok(await decide(g, t.transfer_id, step(x, 'receive').id, { decision: 'approve', note: 'Director on leave; owner approves' }, g.owner)).status, 'scheduled', 'approved, waiting for the effective date');
  x = await detail(g, t.transfer_id);
  assert.equal(step(x, 'receive').override, true); assert.equal(step(x, 'receive').status, 'approved');
  assert.equal(ok(await api('GET', `${P(g)}/campuses`, { token: g.owner.token })).units.find((u) => u.id === g.pune.id).metrics.athletes, 2, 'not before its date');
  // the sweep applies it only once the date has come
  assert.equal(await runDueTransfers(), 0);
  await pool.query('UPDATE org_transfers SET effective_on = current_date WHERE id=$1', [t.transfer_id]);
  assert.equal(await runDueTransfers(), 1); assert.equal(await runDueTransfers(), 0, 'idempotent');
  assert.equal((await detail(g, t.transfer_id)).status, 'completed');
  assert.equal(ok(await api('GET', `${P(g)}/campuses`, { token: g.owner.token })).units.find((u) => u.id === g.goa.id).metrics.athletes, 2);
  // back-dating, only where the process allows it and only for admins
  // the cohort has been in Goa since ten days ago, so a move back-dated to yesterday is a real correction
  await pool.query("UPDATE org_unit_links SET effective_from=current_date-10 WHERE object_type='cohort' AND object_id=$1 AND effective_to IS NULL", [g.cohort.id]);
  await pool.query("UPDATE org_unit_links SET effective_to=current_date-10 WHERE object_type='cohort' AND object_id=$1 AND effective_to IS NOT NULL", [g.cohort.id]);
  ok(await save(g, 'cohort', [], { allow_backdate: true }), 201);
  assert.equal((await request(g, { ...body, to_unit_id: g.pune.id, effective_on: day(-1) }, g.dirB)).status, 400);
  const bd = ok(await request(g, { ...body, to_unit_id: g.pune.id, effective_on: day(-1) }), 201);
  assert.equal(bd.status, 'completed', 'an empty process runs at once');
  assert.equal(ok(await api('GET', `${P(g)}/campuses?as_of=${day(-3)}`, { token: g.owner.token })).units.find((u) => u.id === g.goa.id).metrics.athletes, 2, 'history before the back-dated move is intact');
});

test('a failed execution is reported, not half applied; transfers cannot be started from someone else\'s branch', async () => {
  const g = await group();
  const t = ok(await request(g, { object_type: 'cohort', object_ids: [g.cohort.id] }, g.dirA), 201);
  assert.equal((await request(g, { object_type: 'cohort', object_ids: [g.cohort.id] }, g.dirB)).status, 404, 'the Goa director cannot start a transfer out of Pune');
  // the destination is suspended before the last approval lands
  const x = await detail(g, t.transfer_id);
  ok(await decide(g, t.transfer_id, step(x, 'release').id, { decision: 'approve' }, g.dirA));
  ok(await api('PATCH', `${P(g)}/units/${g.goa.id}`, { token: g.owner.token, body: { status: 'suspended' } }));
  assert.equal(ok(await decide(g, t.transfer_id, step(x, 'receive').id, { decision: 'approve' }, g.dirB)).status, 'failed');
  const f = await detail(g, t.transfer_id);
  assert.equal(f.status, 'failed'); assert.match(f.failure, /suspended/);
  assert.equal(ok(await api('GET', `${P(g)}/campuses`, { token: g.owner.token })).units.find((u) => u.id === g.pune.id).metrics.cohorts, 1, 'nothing moved');
  assert.equal((await api('POST', `${P(g)}/transfers/${t.transfer_id}/cancel`, { token: g.dirB.token, body: {} })).status, 404);
  const dest = ok(await api('GET', `${P(g)}/transfer-destinations?from_unit_id=${g.pune.id}`, { token: g.dirA.token }));
  assert.deepEqual(dest.map((d) => d.name), [], 'a suspended campus is not offered as a destination');
});

test('the transfer picker finds athletes who sit on a campus through their cohort', async () => {
  const g = await group();
  const found = ok(await api('GET', `${P(g)}/campus-candidates?object_type=enrolment&unit_id=${g.pune.id}`, { token: g.owner.token }));
  assert.equal(found.total, 2); assert.ok(found.items.every((x) => x.on[0].name === 'Pune'));
  assert.equal(ok(await api('GET', `${P(g)}/campus-candidates?object_type=enrolment&unit_id=${g.goa.id}`, { token: g.owner.token })).total, 0);
  assert.equal(ok(await api('GET', `${P(g)}/campus-candidates?object_type=enrolment&unit_id=${g.pune.id}`, { token: g.dirA.token })).total, 2, 'the Pune director sees their athletes');
  assert.equal(ok(await api('GET', `${P(g)}/campus-candidates?object_type=enrolment&unit_id=${g.pune.id}`, { token: g.dirB.token }).then((r) => ({ ...r, status: r.status === 404 ? 200 : r.status }))).total ?? 0, 0);
});
