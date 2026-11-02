import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
process.env.PLATFORM_APPROVALS = 'on'; // the production behaviour: reviews on, undefined limits refuse
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, admin;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const reg = async (email = `plan${++n}@example.com`) => {
  const handle = `plan_${++n}`;
  const r = await api('POST', '/auth/register', { body: { handle, display_name: handle, email, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user.id, handle };
};
const mk = async (path, body, token = admin.token) => { const r = await api('POST', path, { token, body }); assert.ok(r.status < 300, `${path} ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const approve = (id) => api('POST', `/admin/commercial/organisations/${id}/decision`, { token: admin.token, body: { decision: 'approve' } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await reg('rraja.edge@gmail.com');
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id = $1", [admin.id]);
});
after(async () => { server.close(); await pool.end(); });

test('a new organisation is pending: its owner can finish the profile but nothing else until the platform approves', async () => {
  const owner = await reg();
  const created = await api('POST', '/organisations', { token: owner.token, body: { name: 'Harbour Sports Group', kind: 'company' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.approval_status, 'pending');
  const org = created.body.id;
  assert.equal((await api('PATCH', `/organisations/${org}`, { token: owner.token, body: { description: 'Umbrella for our academies' } })).status, 200, 'profile stays editable');
  const blocked = await api('POST', '/teams', { token: owner.token, body: { name: 'Harbour U12', sport: 'football', organisation_id: org } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error?.code ?? blocked.body.code, 'pending_approval');

  const queue = await api('GET', '/admin/commercial/organisation-reviews', { token: admin.token });
  assert.equal(queue.status, 200);
  assert.ok(queue.body.some((r) => r.id === org), 'it is in the review queue');
  assert.equal((await api('GET', '/admin/commercial/organisation-reviews', { token: owner.token })).status, 403, 'only the platform admin sees the queue');
  assert.equal((await api('POST', `/admin/commercial/organisations/${org}/decision`, { token: owner.token, body: { decision: 'approve' } })).status, 403, 'an owner cannot approve itself');
  assert.equal((await api('POST', `/admin/commercial/organisations/${org}/decision`, { token: admin.token, body: { decision: 'reject' } })).status, 400, 'a rejection needs a reason');
  assert.equal((await approve(org)).status, 200);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='org_approve' AND entity_id=$1", [org])).rowCount, 'the decision is audited');
});

test('the plan limits academies, teams and staff for the whole organisation, and nothing is allowed without a plan', async () => {
  const owner = await reg(), a = await reg(), b = await reg();
  const org = (await api('POST', '/organisations', { token: owner.token, body: { name: 'Lakeside Group', kind: 'company' } })).body.id;
  await approve(org);
  const academy = (body) => api('POST', '/organisations', { token: owner.token, body: { name: 'Lakeside Academy', kind: 'academy', parent_organisation_id: org, ...body } });

  // no plan defined: an undefined limit refuses instead of meaning unlimited
  assert.equal((await academy()).status, 402);
  assert.equal((await api('POST', `/organisations/${org}/members`, { token: owner.token, body: { person: a.handle, role: 'coach' } })).status, 402);

  const key = `plan_${Date.now()}`;
  await mk('/admin/commercial/products', { key, name: 'Org plans', family: 'other' });
  await mk('/admin/commercial/plans', { product_key: key, key: `${key}_base`, name: 'Group', eligible_actors: ['organisation'] });
  const v = await mk(`/admin/commercial/plans/${key}_base/versions`, { billing_interval: 'monthly', effective_from: '2026-01-01', amount_minor: 1000, entitlements: [{ key: 'academies', limit_value: 1 }, { key: 'teams', limit_value: 1 }, { key: 'staff_seats', limit_value: 2 }] });
  await mk(`/admin/commercial/versions/${v.id}/publish`, {});
  await mk('/admin/commercial/subscriptions', { subject_type: 'organisation', subject_id: org, plan_key: `${key}_base`, mark_paid: true });

  const first = await academy({ academy: { sports: ['football'], focus: 'development', currency: 'INR' } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.parent_organisation_id, org);
  assert.equal(first.body.approval_status, 'pending', 'a new academy is reviewed too');
  assert.deepEqual((await pool.query('SELECT sports, currency FROM academy_profiles WHERE organisation_id=$1', [first.body.id])).rows[0], { sports: ['football'], currency: 'INR' });
  const second = await academy({ name: 'Lakeside Academy North' });
  assert.equal(second.status, 402); assert.equal(second.body.error?.code ?? second.body.code, 'limit_reached');

  // teams count across the umbrella
  assert.equal((await api('POST', '/teams', { token: owner.token, body: { name: 'Lakeside A', sport: 'football', organisation_id: org } })).status, 201);
  assert.equal((await api('POST', '/teams', { token: owner.token, body: { name: 'Lakeside B', sport: 'football', organisation_id: org } })).status, 402);

  // staff: the owner is one seat; anyone tagged anywhere in the tree is covered; an invitation reserves a seat
  assert.equal((await api('POST', `/organisations/${org}/members`, { token: owner.token, body: { person: a.handle, role: 'coach' } })).status, 201);
  const over = await api('POST', `/organisations/${org}/members`, { token: owner.token, body: { person: b.handle, role: 'finance' } });
  assert.equal(over.status, 402); assert.equal(over.body.error?.code ?? over.body.code, 'limit_reached');

  const plan = await api('GET', `/organisations/${org}/plan`, { token: owner.token });
  assert.equal(plan.status, 200);
  const by = Object.fromEntries(plan.body.limits.map((l) => [l.key, l]));
  assert.deepEqual([by.academies.used, by.teams.used, by.staff_seats.used], [1, 1, 2]);
  assert.deepEqual([by.academies.limit, by.teams.limit, by.staff_seats.limit], [1, 1, 2]);
  assert.equal((await api('GET', `/organisations/${org}/plan`, { token: b.token })).status, 404, 'outsiders learn nothing');
});

test('an academy stays out of public search and cannot be listed until the platform approves it', async () => {
  const owner = await reg();
  const org = (await api('POST', '/organisations', { token: owner.token, body: { name: 'Pending Academy', kind: 'academy', academy: { sports: ['tennis'] } } })).body;
  assert.equal(org.approval_status, 'pending');
  const profile = (await api('GET', `/organisations/${org.id}/academy`, { token: owner.token })).body;
  const listed = await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: profile.row_version, listed: true } });
  assert.equal(listed.status, 409); assert.equal(listed.body.error?.code ?? listed.body.code, 'pending_approval');
  assert.equal((await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: profile.row_version, timezone: 'Asia/Kolkata' } })).status, 200, 'the profile can be completed while waiting');
  assert.equal((await approve(org.id)).status, 200);
  const after = (await api('GET', `/organisations/${org.id}/academy`, { token: owner.token })).body;
  assert.equal((await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: after.row_version, listed: true } })).status, 200);
  assert.equal((await api('POST', `/admin/commercial/organisations/${org.id}/decision`, { token: admin.token, body: { decision: 'suspend', note: 'Checking documents' } })).status, 200);
  assert.equal((await api('POST', '/teams', { token: owner.token, body: { name: 'Suspended FC', sport: 'football', organisation_id: org.id } })).status, 409, 'a suspended organisation is read-only');
  assert.equal((await pool.query('SELECT status FROM organisations WHERE id=$1', [org.id])).rows[0].status, 'active', 'nothing is deleted or archived');
});

test('existing organisations are grandfathered as approved by the migration default', async () => {
  const col = (await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name='organisations' AND column_name='approval_status'")).rows[0];
  assert.match(col.column_default, /approved/);
});
