// Standard country rulebooks (#568 follow-up) ride on the compliance policy layer: packs in, laws wait for a second administrator.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, admin, admin2, user;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const mk = async (h, roles) => { const row = (await pool.query('INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,$2,\'x\',\'x\',$1) RETURNING id', [h, roles])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles }) }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  admin = await mk('rb_root', ['admin']); admin2 = await mk('rb_root2', ['admin']); user = await mk('rb_user', ['athlete']);
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('the eight priority countries each ship six standard rules, readable by any signed-in person, none by a stranger', async () => {
  const l = must(await api('GET', '/compliance/rulebooks', { token: user.token }));
  assert.deepEqual(l.items.map((x) => x.code).sort(), ['AU', 'CA', 'GB', 'IN', 'LK', 'MY', 'SG', 'US']);
  assert.ok(l.items.every((x) => x.rules === 6));
  const gb = must(await api('GET', '/compliance/rulebooks/gb', { token: user.token }));
  assert.equal(gb.format, 'sportarena.compliance-rules/1'); assert.equal(gb.rules.length, 6);
  assert.ok(gb.rules.every((r) => r.source_title && r.approval_owner.includes('review') && r.obligations[0].country === 'GB'));
  assert.equal((await api('GET', '/compliance/rulebooks/ZZ', { token: user.token })).status, 404);
  assert.equal((await api('GET', '/compliance/rulebooks')).status, 401);
});

test('installing is platform-admin only, checked like any pack, idempotent, and laws wait for a second administrator', async () => {
  assert.equal((await api('POST', '/compliance/rulebooks/IN/install', { token: user.token })).status, 404);
  const first = must(await api('POST', '/compliance/rulebooks/IN/install', { token: admin.token }), 201);
  assert.equal(first.created.length, 6);
  const pending = first.created.filter((x) => x.approval_status === 'pending_approval').map((x) => x.code).sort();
  assert.deepEqual(pending, ['std_in_child_protection_checks', 'std_in_event_privacy', 'std_in_event_permit'].sort());
  const again = must(await api('POST', '/compliance/rulebooks/IN/install', { token: admin.token }), 201);
  assert.equal(again.created.length, 0); assert.equal(again.skipped.length, 6);

  const listed = must(await api('GET', '/compliance/requirements?scope_kind=platform', { token: admin.token }));
  const reqs = listed.requirements.filter((r) => r.code.startsWith('std_in_'));
  assert.equal(reqs.length, 6);
  const std = reqs.find((r) => r.code === 'std_in_public_liability');
  assert.equal(std.classification, 'recommended_standard'); assert.equal(std.approval_status, 'approved');
  // the writer cannot approve their own laws; a second administrator can
  const law = reqs.find((r) => r.code === 'std_in_event_permit');
  assert.equal((await api('POST', `/compliance/requirements/${law.id}/approval`, { token: admin.token, body: { decision: 'approve' } })).status, 403);
  must(await api('POST', `/compliance/requirements/${law.id}/approval`, { token: admin2.token, body: { decision: 'approve' } }));
});

test('an installed rule applies only to its country: an Indian event is asked for the permit, a British one is not', async () => {
  const owner = await mk('rb_owner', ['organizer']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Rulebook Club', kind: 'club' } }), 201);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0].id;
  const ev = async (country) => {
    const e = (await pool.query("INSERT INTO events(name, sport_id, organizer_id, organisation_id, kind, status, starts_on) VALUES ('RB Event',$1,$2,$3,'tournament','draft',current_date+30) RETURNING id", [sport, owner.id, org.id])).rows[0].id;
    await pool.query("UPDATE addresses SET is_default=false WHERE owner_id=$1", [org.id]);
    await pool.query("INSERT INTO addresses(owner_kind, owner_id, kind, country, is_default) VALUES ('organisation',$1,'billing',$2,true)", [org.id, country]);
    return e;
  };
  const india = await ev('IN');
  const r = must(await api('POST', '/compliance/evaluate', { token: owner.token, body: { subject_kind: 'event', subject_id: india, consequence: 'event_open' } }));
  assert.ok(r.items.some((i) => i.requirement.name.includes('Police and local-authority')), 'the Indian permit is asked for');
  const britain = await ev('GB');
  const g = must(await api('POST', '/compliance/evaluate', { token: owner.token, body: { subject_kind: 'event', subject_id: britain, consequence: 'event_open' } }));
  assert.ok(!g.items.some((i) => i.requirement.name.includes('Police and local-authority')), 'not in force in Britain');
});
