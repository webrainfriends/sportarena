import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MEDIA_DIR = process.env.MEDIA_DIR ?? `${process.env.TMPDIR ?? '/tmp'}/sa-insurance-test-media`;
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `pn_${n}_${roles[0]}`, display_name: `Agency ${n}`, email: `pn${n}@example.com`, password: 'correct-horse-battery', roles } }); return { id: r.body.user.id, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id }) }; };
const insurer = async (name, extra = {}) => { const u = await signup(['insurer']); const ins = must(await api('POST', '/insurance/my-insurer', { token: u.token, body: { name, ...extra } }), 201); return { ...u, insurer: ins }; };
const plan = (who, body) => api('POST', '/insurance/plans', { token: who.token, body: { name: 'Plan', cover_for: 'individual', premium_cents: 50000, coverage_cents: 500000, ...body } });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const put = (token, qs, body, type = 'application/pdf') => fetch(`${base}/api/v1/insurance/documents?${new URLSearchParams(qs)}`, { method: 'PUT', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': type }, body });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('pn_root');
});
after(async () => { server.close(); await pool.end(); });

const provider = async (role = 'physio', profile = {}) => {
  const u = await signup([role]);
  must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role } }), 201);
  must(await api('POST', '/me/provider-profile', { token: u.token, body: { provider_type: role, city: 'Mumbai', ...profile } }));
  await pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days')", [role, u.id]);
  return u;
};
test('insurance panel: both sides agree, terms per cover kind/plan, lookup through own/team/event cover, expiry, credential and history', async () => {
  const ins = await insurer('Panel Cover'), other = await insurer('Other Cover');
  const doc = await provider('physio'), doc2 = await provider('doctor', { city: 'Pune' }), plain = await signup(['athlete']);
  const indPlan = must(await plan(ins, { name: 'Personal', cover_for: 'individual' }), 201);
  const teamPlan = must(await plan(ins, { name: 'Squad', cover_for: 'team' }), 201);
  const otherPlan = must(await plan(other, { name: 'Elsewhere', cover_for: 'individual' }), 201);

  // consent from both sides
  assert.equal((await api('POST', '/insurance/panel', { token: plain.token, body: { provider_id: doc.id } })).status, 403, 'insurers only');
  assert.equal((await api('POST', '/insurance/panel', { token: ins.token, body: { provider_id: plain.id } })).status, 400, 'must be a provider');
  assert.equal((await api('POST', '/insurance/panel', { token: ins.token, body: { provider_id: doc.id, plan_ids: [otherPlan.id] } })).status, 400, "another insurer's plan");
  const inv = must(await api('POST', '/insurance/panel', { token: ins.token, body: { provider_id: doc.id, cashless: true, network_ref: 'EMP-77', cover_types: ['individual', 'team'] } }), 201);
  assert.equal((await api('POST', '/insurance/panel', { token: ins.token, body: { provider_id: doc.id } })).status, 409, 'one live link');
  assert.equal(must(await api('GET', `/insurance/insurers/${ins.insurer.id}/panel`)).length, 0, 'not listed until the provider accepts');
  assert.equal((await api('POST', `/insurance/panel/${inv.id}/respond`, { token: doc2.token, body: { accept: true } })).status, 403, 'only the invited provider answers');
  assert.equal((await api('POST', `/insurance/panel/${inv.id}/respond`, { token: ins.token, body: { accept: true } })).status, 403, 'the proposer cannot answer for the other side');
  assert.equal(must(await api('POST', `/insurance/panel/${inv.id}/respond`, { token: doc.token, body: { accept: true } })).status, 'active');
  // a provider-initiated request needs insurer approval and the insurer sets the terms
  const req = must(await api('POST', '/insurance/panel/requests', { token: doc2.token, body: { insurer_id: ins.insurer.id, network_ref: 'D-9' } }), 201);
  assert.equal(must(await api('GET', `/insurance/insurers/${ins.insurer.id}/panel`)).length, 1);
  const appr = must(await api('POST', `/insurance/panel/${req.id}/respond`, { token: ins.token, body: { accept: true, cashless: false, cover_types: ['event'], plan_ids: [teamPlan.id] } }));
  assert.deepEqual([appr.status, appr.cover_types, appr.cashless], ['active', ['event'], false]);
  assert.equal(must(await api('GET', `/providers/${doc.id}/insurers`))[0].insurer, 'Panel Cover');
  assert.equal(must(await api('GET', `/insurance/insurers/${ins.insurer.id}/panel`, { query: { cashless: 'true' } })).length, 1, 'cashless filter');

  // lookup: nothing without cover
  const me = await signup(['athlete']);
  assert.deepEqual(must(await api('GET', '/insurance/covered-providers', { token: me.token })), { covers: [], providers: [] });
  // own individual policy -> only providers whose terms include individual cover
  must(await api('POST', '/insurance/policies', { token: me.token, body: { plan_id: indPlan.id, months: 12 } }), 201);
  let r = must(await api('GET', '/insurance/covered-providers', { token: me.token }));
  assert.deepEqual(r.providers.map((p) => p.id), [doc.id], 'doc2 is panel-only for events/Squad plan');
  assert.equal(r.providers[0].cashless, true); assert.equal(r.providers[0].covered_by[0].cover_for, 'individual');
  assert.ok(!JSON.stringify(r).includes('SA-'), 'no policy numbers');
  // team cover through membership
  const cap1 = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: cap1.token, body: { name: 'Panel FC', sport: 'football' } }), 201);
  must(await api('POST', '/insurance/policies', { token: cap1.token, body: { plan_id: teamPlan.id, subject_id: team.id, months: 12 } }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, me.id]);
  r = must(await api('GET', '/insurance/covered-providers', { token: me.token }));
  assert.deepEqual(r.providers.map((p) => p.id), [doc.id], 'team cover: doc2 only covers events, doc covers team');
  assert.equal(r.providers[0].covered_by.length, 2);
  assert.equal(must(await api('GET', '/insurance/covered-providers', { token: me.token, query: { city: 'Pune' } })).providers.length, 0);
  // event cover: doc2 serves events on the Squad plan only, so an event policy on another plan does not match
  assert.equal(must(await api('GET', '/insurance/covered-providers', { token: plain.token })).providers.length, 0, 'not covered, nothing listed');

  // terms update, validity, credential
  must(await api('PATCH', `/insurance/panel/${inv.id}`, { token: ins.token, body: { valid_to: '2000-01-01' } }));
  assert.equal(must(await api('GET', '/insurance/covered-providers', { token: me.token })).providers.length, 0, 'expired validity drops out');
  must(await api('PATCH', `/insurance/panel/${inv.id}`, { token: ins.token, body: { valid_to: null } }));
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE subject_id=$1", [doc.id]);
  assert.equal(must(await api('GET', '/insurance/covered-providers', { token: me.token })).providers.length, 0, 'lapsed credential drops out live');
  assert.equal(must(await api('GET', `/providers/${doc.id}/insurers`)).length, 0);
  await pool.query("UPDATE verification_cases SET status='approved' WHERE subject_id=$1", [doc.id]);

  // ending keeps the row and history; only the two sides may end it
  assert.equal((await api('POST', `/insurance/panel/${inv.id}/end`, { token: other.token })).status, 404);
  must(await api('POST', `/insurance/panel/${inv.id}/end`, { token: doc.token, body: { reason: 'moving practice' } }));
  assert.equal(must(await api('GET', '/insurance/covered-providers', { token: me.token })).providers.length, 0);
  const mine = must(await api('GET', '/insurance/panel/mine', { token: doc.token }));
  assert.deepEqual(mine.find((m) => m.id === inv.id).history.map((h) => h.action), ['invited', 'accepted', 'terms_updated', 'terms_updated', 'ended']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM insurer_panel_members')).rows[0].n, 2, 'nothing deleted');
  // after ending, a fresh invitation is possible again
  must(await api('POST', '/insurance/panel', { token: ins.token, body: { provider_id: doc.id } }), 201);
});
