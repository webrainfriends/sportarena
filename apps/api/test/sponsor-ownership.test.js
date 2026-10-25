// Brand ownership transfer (#340): sponsors.owner_id moves between staff of the brand's organisation or between individuals,
// under a row lock, with the last-manager guard, stale-revision 409, notifications, audit and untouched deals/contacts.
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
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `so_${n}_${roles[0]}`, display_name: `Owner ${n}`, email: `so${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100', ...extra } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const join = async (org, owner, role, extra = {}) => {
  const u = await signup();
  must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role, ...extra } }), 201);
  must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  return u;
};
/** An organisation with a brand (created by `creator`, an evaluator-free sponsor) linked to it, plus staff in a few roles. */
const corporate = async () => {
  const boss = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: boss.token, body: { name: `Acme ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: boss.token, body: { name: `Brand ${n}`, contact_name: 'Pat Contact', contact_email: 'pat@example.com' } }), 201);
  must(await api('POST', `/organisations/${org.id}/assets`, { token: boss.token, body: { kind: 'sponsor', asset_id: b.id } }));
  const staff = { manager: await join(org, boss, 'manager'), finance: await join(org, boss, 'finance'), evaluator: await join(org, boss, 'evaluator'), coach: await join(org, boss, 'coach') };
  return { boss, org, b, staff };
};
const rev = async (w, u = w.boss) => must(await api('GET', `/sponsors/${w.b.id}/ownership`, { token: u.token })).owner_rev;
const hand = async (w, from, to, extra = {}) => api('POST', `/sponsors/${w.b.id}/transfer`, { token: from.token, body: { to_user_id: to.id, expected_rev: extra.rev ?? await rev(w, from), ...extra.body } });
const ownerOf = async (w) => (await pool.query('SELECT owner_id FROM sponsors WHERE id=$1', [w.b.id])).rows[0].owner_id;
const roleOf = async (w, u) => (await pool.query("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [w.org.id, u.id])).rows[0]?.role;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('an organisation brand moves to a staff member; the previous owner keeps a manager-equivalent role; history, contacts and audit are kept', async () => {
  const w = await corporate();
  const deal = (await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, proposed_by) VALUES ($1,'athlete',$2,1000,$3) RETURNING id", [w.b.id, w.staff.coach.id, w.boss.id])).rows[0];
  const before = must(await api('GET', `/sponsors/${w.b.id}/ownership`, { token: w.boss.token }));
  assert.equal(before.owner.id, w.boss.id); assert.equal(before.can_transfer, true); assert.equal(before.owner_rev, 1);
  // the finance person (a non-manager) cannot even look at the ownership page, and an outsider does not learn the brand exists
  assert.equal((await api('GET', `/sponsors/${w.b.id}/ownership`, { token: w.staff.finance.token })).status, 403);
  const stranger = await signup(['sponsor']);
  assert.equal((await api('POST', `/sponsors/${w.b.id}/transfer`, { token: stranger.token, body: { to_user_id: stranger.id, expected_rev: 1 } })).status, 404);
  // a manager who is neither the owner nor organisation owner/admin may not hand it over
  assert.equal((await hand(w, w.staff.manager, w.staff.manager)).status, 403);
  // targets must be sponsor-carrying staff of the organisation: a coach, an outsider, the owner themself are refused
  assert.equal((await hand(w, w.boss, w.staff.coach)).status, 422);
  assert.equal((await hand(w, w.boss, stranger)).status, 422);
  assert.equal((await hand(w, w.boss, w.boss)).status, 400);
  const r = must(await hand(w, w.boss, w.staff.finance));
  assert.equal(r.owner_id, w.staff.finance.id); assert.equal(r.owner_rev, 2); assert.equal(r.previous_owner_role, 'owner');
  assert.equal(await ownerOf(w), w.staff.finance.id);
  assert.equal(await roleOf(w, w.boss), 'owner', 'a stronger organisation role is left alone');
  // the new owner is now a manager of the brand (reads contacts, audited); a brand-side finance role no longer limits them
  const view = must(await api('GET', `/sponsors/${w.b.id}`, { token: w.staff.finance.token }));
  assert.equal(view.contact_name, 'Pat Contact'); assert.equal(view.my_role, 'manager');
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_pii' AND entity_id=$2", [w.staff.finance.id, w.b.id])).rowCount, 1);
  assert.equal((await api('GET', `/sponsors/${w.b.id}`, { token: w.staff.evaluator.token })).body.contact_name, undefined, 'contacts stay manager-only');
  // the audit entry, the hand-over record and the notifications
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='transfer_sponsor_ownership' AND entity_id=$2", [w.boss.id, w.b.id])).rowCount, 1);
  const hist = must(await api('GET', `/sponsors/${w.b.id}/ownership`, { token: w.boss.token })).history;
  assert.equal(hist.length, 1); assert.equal(hist[0].rev, 2);
  const got = async (u, kind = 'sponsor_ownership') => (await pool.query('SELECT count(*)::int AS c FROM notifications WHERE user_id=$1 AND kind=$2', [u.id, kind])).rows[0].c;
  assert.equal(await got(w.staff.finance), 1); assert.equal(await got(w.staff.manager), 1);
  assert.equal(await got(w.boss), 0, 'the person who did it is not notified');
  // nothing was removed: the deal, the encrypted contacts and the organisation link are as before
  assert.equal((await pool.query('SELECT 1 FROM sponsorships WHERE id=$1', [deal.id])).rowCount, 1);
  const row = (await pool.query('SELECT contact_name_enc, organisation_id FROM sponsors WHERE id=$1', [w.b.id])).rows[0];
  assert.ok(row.contact_name_enc && !row.contact_name_enc.includes('Pat')); assert.equal(row.organisation_id, w.org.id);
});

test('a weaker previous owner is raised to manager and keeps working; a department-scoped member cannot receive the brand', async () => {
  const w = await corporate();
  // the creator is a plain evaluator in the organisation now (an organisation owner demoted them)
  const creator = w.staff.manager;
  await pool.query('UPDATE sponsors SET owner_id=$2 WHERE id=$1', [w.b.id, creator.id]);
  await pool.query("UPDATE organisation_members SET role='evaluator' WHERE organisation_id=$1 AND user_id=$2", [w.org.id, creator.id]);
  const dept = must(await api('POST', `/organisations/${w.org.id}/departments`, { token: w.boss.token, body: { name: 'Marketing' } }), 201);
  const scoped = await join(w.org, w.boss, 'finance', { department_id: dept.id });
  assert.equal((await hand(w, w.boss, scoped)).status, 422, 'an owner manages the whole brand');
  // an organisation owner hands it from the creator to a finance colleague
  const r = must(await hand(w, w.boss, w.staff.finance));
  assert.equal(r.previous_owner_id, creator.id); assert.equal(r.previous_owner_role, 'manager');
  assert.equal(await roleOf(w, creator), 'manager');
  assert.equal(must(await api('GET', `/sponsors/${w.b.id}`, { token: creator.token })).my_role, 'manager');
});

test('an individual brand moves between sponsors; the previous owner loses access; young people and non-sponsors are refused', async () => {
  const a = await signup(['sponsor']), b = await signup(['sponsor']), plain = await signup(['athlete']);
  const brand = must(await api('POST', '/sponsors', { token: a.token, body: { name: 'Solo', contact_name: 'Sam' } }), 201);
  const w = { b: brand };
  assert.equal((await hand(w, a, plain)).status, 422, 'needs the sponsor role');
  await pool.query("UPDATE users SET roles=roles||'{athlete}' WHERE id=$1", [b.id]);
  const minor = await signup(['sponsor'], { dob: yearsAgo(14) });
  assert.equal((await hand(w, a, minor)).status, 422, 'a young person cannot own a brand');
  must(await hand(w, a, b));
  assert.equal(await ownerOf(w), b.id);
  assert.equal((await api('GET', `/sponsors/${brand.id}`, { token: a.token })).body.contact_name, undefined);
  assert.equal((await api('GET', `/sponsors/${brand.id}/ownership`, { token: a.token })).status, 403);
  assert.equal(must(await api('GET', `/sponsors/${brand.id}`, { token: b.token })).contact_name, 'Sam');
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM sponsor_owner_transfers WHERE sponsor_id=$1', [brand.id])).rows[0].c, 1);
});

test('a brand under a sponsor entity cannot be handed over here, and an archived organisation is read-only for its admins', async () => {
  const w = await corporate();
  const admin = await join(w.org, w.boss, 'admin');
  await pool.query("UPDATE organisations SET status='archived' WHERE id=$1", [w.org.id]);
  assert.equal((await hand(w, admin, w.staff.finance, { rev: 1 })).status, 409);
  await pool.query("UPDATE organisations SET status='active' WHERE id=$1", [w.org.id]);
  must(await hand(w, admin, w.staff.finance)); // an organisation admin may hand over a brand they do not own
  const e = (await pool.query("INSERT INTO sponsor_entities(sponsor_type, legal_name, created_by) VALUES ('company','Acme Ltd',$1) RETURNING id", [w.boss.id])).rows[0];
  await pool.query('UPDATE sponsors SET entity_id=$2 WHERE id=$1', [w.b.id, e.id]);
  assert.equal((await hand(w, w.staff.finance, w.staff.manager, { rev: 2 })).status, 409);
});

test('stale revisions are rejected (409), even after the brand went A to B and back to A', async () => {
  const w = await corporate();
  const seen = await rev(w);
  must(await hand(w, w.boss, w.staff.manager, { rev: seen }));
  must(await hand(w, w.staff.manager, w.boss));
  assert.equal(await ownerOf(w), w.boss.id, 'the owner is the same person again');
  assert.equal((await hand(w, w.boss, w.staff.finance, { rev: seen })).status, 409, 'the revision moved on');
  assert.equal(await rev(w), 3);
});

test('concurrent hand-overs: exactly one wins, the others get 409, and the brand always has one manager-owner', async () => {
  const w = await corporate();
  const seen = await rev(w);
  const targets = [w.staff.manager, w.staff.finance, w.staff.evaluator];
  const results = await Promise.all(targets.map((t) => hand(w, w.boss, t, { rev: seen })));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409], JSON.stringify(results.map((r) => r.body)));
  const winner = results.findIndex((r) => r.status === 200);
  assert.equal(await ownerOf(w), targets[winner].id);
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM sponsor_owner_transfers WHERE sponsor_id=$1', [w.b.id])).rows[0].c, 1);
  assert.equal(await rev(w, targets[winner]), 2);
});

test('a hand-over racing the target leaving the organisation never leaves a non-member as owner of an organisation brand', async () => {
  const w = await corporate();
  const seen = await rev(w);
  const [t, leave] = await Promise.all([hand(w, w.boss, w.staff.finance, { rev: seen }), api('DELETE', `/organisations/${w.org.id}/members/${w.staff.finance.id}`, { token: w.boss.token })]);
  assert.equal(leave.status, 200);
  const active = (await pool.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [w.org.id, w.staff.finance.id])).rowCount;
  if (t.status === 200) assert.equal(await ownerOf(w), w.staff.finance.id); // handed over first, then they left: still the owner and manager
  else { assert.equal(t.status, 422); assert.equal(await ownerOf(w), w.boss.id); assert.equal(active, 0); }
});
