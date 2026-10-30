// Delegated sponsor roles in the modules that used to look only at sponsors.owner_id (#339): event requests, event vendors, education introductions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0, tennis;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sd_${n}`, display_name: `Deleg ${n}`, email: `sd${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const notes = async (u, kind) => (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind=$2', [u.id, kind])).rows[0].n;

/** A brand under a confirmed entity with one person per role; returns the brand, the owner and the team by role. */
const brandWithTeam = async () => {
  const owner = await signup(['sponsor']);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Brand ${++n}` } }), 201);
  const idn = must(await api('POST', `/sponsors/${b.id}/identity`, { token: owner.token, body: { sponsor_type: 'company', legal_name: `Brand ${n} Ltd` } }));
  const team = {};
  for (const role of ['manager', 'evaluator', 'finance', 'viewer']) {
    const u = await signup(['athlete']);
    const inv = must(await api('POST', `/sponsor-entities/${idn.entity_id}/representatives`, { token: owner.token, body: { user_id: u.id, role } }), 201);
    must(await api('POST', `/sponsor-representatives/${inv.id}/response`, { token: u.token, body: { accept: true } }));
    team[role] = { ...u, rep: inv.id };
  }
  return { brand: b, owner, team };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  tennis = (await api('GET', '/sports')).body.find((s) => s.slug === 'tennis');
});
after(async () => { server.close(); await pool.end(); });

test('event sponsorship request: the brand team is told and answers it; viewers and evaluators cannot; revoked staff lose it at once', async () => {
  const { brand, owner, team } = await brandWithTeam();
  const org = await signup(['organizer']), rival = await signup(['sponsor']);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Open ${++n}`, sports: ['athletics'], starts_on: day(40), ends_on: day(42) } }), 201);
  const rq = must(await api('POST', `/events/${ev.id}/requests`, { token: org.token, body: { kind: 'sponsor', sponsor_id: brand.id, offer_cents: 100000, message: 'Title sponsor?' } }), 201);
  assert.deepEqual([await notes(owner, 'event_request'), await notes(team.manager, 'event_request'), await notes(team.evaluator, 'event_request'), await notes(team.viewer, 'event_request')], [1, 1, 0, 0], 'only people who can answer are told');
  const respond = (u) => api('POST', `/event-requests/${rq.id}/respond`, { token: u.token, body: { response: 'accept' } });
  for (const u of [team.viewer, team.evaluator, team.finance, rival]) assert.ok([403, 404].includes((await respond(u)).status), 'no authority, no answer');
  must(await api('POST', `/sponsor-representatives/${team.manager.rep}/remove`, { token: owner.token, body: {} }));
  assert.ok([403, 404].includes((await respond(team.manager)).status), 'revoked staff lose access immediately');
  const inviter = await signup(['athlete']);
  must(await api('POST', `/sponsor-entities/${(await pool.query('SELECT entity_id FROM sponsors WHERE id=$1', [brand.id])).rows[0].entity_id}/representatives`, { token: owner.token, body: { user_id: inviter.id, role: 'approver' } }), 201);
  const inv = (await pool.query("SELECT id FROM sponsor_representatives WHERE user_id=$1", [inviter.id])).rows[0];
  must(await api('POST', `/sponsor-representatives/${inv.id}/response`, { token: inviter.token, body: { accept: true } }));
  must(await respond(inviter));
});

test('event vendor invitation for a brand: the team is told; manager accepts, evaluator and viewer cannot', async () => {
  const { brand, owner, team } = await brandWithTeam();
  const org = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Cup ${++n}`, sports: ['athletics'], starts_on: day(40), ends_on: day(42) } }), 201);
  const v = must(await api('POST', `/events/${ev.id}/vendors`, { token: org.token, body: { kind: 'sponsor', sponsor_id: brand.id, fee_cents: 50000 } }), 201);
  assert.deepEqual([await notes(owner, 'event_vendor'), await notes(team.manager, 'event_vendor'), await notes(team.evaluator, 'event_vendor'), await notes(team.finance, 'event_vendor')], [1, 1, 0, 0]);
  const respond = (u) => api('POST', `/event-vendors/${v.id}/respond`, { token: u.token, body: { accept: true } });
  for (const u of [team.viewer, team.evaluator, team.finance]) assert.equal((await respond(u)).status, 404);
  assert.equal((await respond(team.manager)).status, 200);
});

test('institution introductions: manager, approver and evaluator see them and are told; finance, viewers and outsiders do not', async () => {
  const { brand, owner, team } = await brandWithTeam();
  const co = await signup(['athlete']), ath = await signup(['athlete']), outsider = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: co.token, body: { name: `Hilltop ${++n}`, kind: 'college', city: 'Pune' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/institution`, { token: co.token, body: { about: 'Sports degrees', website: 'https://hilltop.example', country: 'India', contact_email: 'a@hilltop.example', contact_phone: '+91 20 5550 0000', listed: true } }));
  const prog = must(await api('POST', `/organisations/${org.id}/programmes`, { token: co.token, body: { title: 'BSc Sports Science', kind: 'degree', mode: 'on_campus', sport_ids: [tennis.id], duration_months: 36, fee_minor: 250000, currency: 'INR', next_intake_on: '2027-07-01', apply_url: 'https://hilltop.example/apply' } }), 201);
  const e = must(await api('POST', '/enquiries', { token: ath.token, body: { organisation_id: org.id, programme_id: prog.id, message: 'Hi' } }), 201);
  must(await api('PATCH', `/enquiries/${e.id}/consent`, { token: ath.token, body: { sponsor_consent: true } }));
  must(await api('POST', `/enquiries/${e.id}/sponsor-links`, { token: co.token, body: { sponsor_id: brand.id } }), 201);
  assert.deepEqual([await notes(owner, 'sponsor_introduction'), await notes(team.manager, 'sponsor_introduction'), await notes(team.evaluator, 'sponsor_introduction'), await notes(team.finance, 'sponsor_introduction'), await notes(team.viewer, 'sponsor_introduction')], [1, 1, 1, 0, 0]);
  const list = (u) => api('GET', `/sponsors/${brand.id}/introductions`, { token: u.token });
  for (const u of [owner, team.manager, team.evaluator]) assert.equal(must(await list(u)).length, 1);
  for (const u of [team.finance, team.viewer, outsider, ath]) assert.equal((await list(u)).status, 403);
  must(await api('POST', `/sponsor-representatives/${team.evaluator.rep}/remove`, { token: owner.token, body: {} }));
  assert.equal((await list(team.evaluator)).status, 403, 'revoked staff lose it immediately');
});
