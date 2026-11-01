import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: 'http://127.0.0.1:1', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { backfillYouth } = await import('../src/youth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const inst = (offsetDays) => new Date(Date.now() + offsetDays * 864e5).toISOString();
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ff_${n}_${roles[0]}`, display_name: `Fam ${n}`, email: `ff${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const kid = (age = 12) => signup(['athlete'], { dob: yearsAgo(age) });
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };

async function verifiedGuardian(parent, child, extra = {}) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  return must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match', ...extra } }));
}
const allow = async (parent, child, purpose) => must(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose } }), 201);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ff_root','ff_root','{admin}','x','x','ff_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  await backfillYouth();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** A guardian, a child on a team that is entered in a competition with one fixture, and the team's manager. */
async function household() {
  const org = await signup(['organizer']), mgr = await signup(['athlete']), mgr2 = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Bats ${++n}`, sport: 'cricket' } }), 201);
  const rival = must(await api('POST', '/teams', { token: mgr2.token, body: { name: `Rivals ${++n}`, sport: 'cricket' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Cup ${n}`, sport: 'cricket', starts_on: day(5), ends_on: day(30) } }), 201);
  for (const [t, tok] of [[team, mgr.token], [rival, mgr2.token]]) {
    const en = must(await api('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } }), 201);
    must(await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }));
  }
  const fx = must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: team.id, away_team_id: rival.id, scheduled_at: inst(3) } }), 201);
  const parent = await signup(), c1 = await kid(12);
  const link = await verifiedGuardian(parent, c1);
  await allow(parent, c1, 'participation');
  must(await api('POST', `/teams/${team.id}/members`, { token: mgr.token, body: { user_id: c1.id } }), 201);
  return { org, mgr, mgr2, team, rival, ev, fx, parent, c1, link };
}
const dash = async (h, who = h.parent) => must(await api('GET', '/me/family', { token: who.token }));

test('a child on a trip shows a trip-consent to-do that clears when the guardian consents, and not for anyone else', async () => {
  const h = await household();
  const trip = must(await api('POST', '/trips', { token: h.mgr.token, body: { name: `Away ${n}`, team_id: h.team.id, origin: 'Mumbai', destination: 'Delhi', timezone: 'Asia/Kolkata', depart_at: inst(9), return_at: inst(12), event_ids: [h.ev.id], idempotency_key: `trip-${n}-${Date.now()}` } }), 201);
  must(await api('POST', `/trips/${trip.id}/party`, { token: h.mgr.token, body: { user_id: h.c1.id, role: 'athlete' } }), 201);
  let d = await dash(h);
  const t = d.todo.find((x) => x.kind === 'trip_consent');
  assert.ok(t, 'trip consent is asked');
  assert.equal(t.action.trip_id, trip.id); assert.equal(t.action.child_id, h.c1.id);
  assert.equal(d.dependents[0].trips[0].consent_current, false);
  assert.deepEqual(await dash(h, await signup()).then((x) => x.todo), []);
  must(await api('POST', `/trips/${trip.id}/party/${t.action.participant_id}/consent`, { token: h.parent.token, body: { decision: 'grant' } }));
  d = await dash(h);
  assert.equal(d.todo.filter((x) => x.kind === 'trip_consent').length, 0);
  assert.equal(d.dependents[0].trips[0].consent_current, true);
  // ending the link takes the child (and the consent that depended on it) off the dashboard
  must(await api('POST', `/youth/guardian-links/${h.link.id}/revoke`, { token: h.parent.token, body: { reason: 'test' } }));
  assert.deepEqual((await dash(h)).dependents, []);
});

/** An academy with a one-time fee, the child enrolled by the guardian, who is therefore the payer. */
async function enrolled(h) {
  const owner = await signup(['organizer']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Acad ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['cricket'], currency: 'GBP', listed: true } }));
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'cricket', title: `U12 ${n}`, capacity: 10, admission_mode: 'direct', public: true } }), 201);
  must(await api('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'one_time', currency: 'GBP', fee_minor: 12000 } }), 201);
  await allow(h.parent, h.c1, 'participation');
  const enq = must(await api('POST', `/academy/programmes/${prog.id}/applications`, { token: h.parent.token, body: { athlete_id: h.c1.id } }), 201);
  must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: h.parent.token, body: { row_version: enq.row_version, answers: {} } }));
  return { owner, org };
}

test('academy fees appear as pay-in-place rows with the totals, and only to the guardian who is the payer', async () => {
  const h = await household();
  const a = await enrolled(h);
  const d = await dash(h);
  const row = d.dependents[0].fees.find((f) => f.source === 'academy');
  assert.ok(row, 'academy charge listed');
  assert.deepEqual(row.purpose, { purpose_type: 'academy_charge', purpose_id: row.charge_id }, 'payable from the dashboard');
  assert.equal(d.due.find((x) => x.currency === 'GBP').due_minor, 12000);
  const todo = d.todo.find((x) => x.kind === 'payment');
  assert.equal(todo.action.source, 'academy'); assert.equal(todo.amount.minor, 12000);
  // the payer starts checkout; a stranger is refused; nothing leaks to a stranger's dashboard
  const r = await api('POST', '/payments', { token: h.parent.token, body: { purpose_type: 'academy_charge', purpose_id: row.charge_id, provider: 'stripe' } });
  assert.notEqual(r.status, 403, 'not a scope or ownership refusal');
  assert.equal((await api('POST', '/payments', { token: (await signup()).token, body: { purpose_type: 'academy_charge', purpose_id: row.charge_id, provider: 'stripe' } })).status, 403);
  assert.deepEqual((await dash(h, await signup())).due, []);
  assert.ok(a.org.id);
});

test('custody scopes: a guardian without pay/register/consent/rsvp/calendar scope is blocked server-side and the dashboard says so', async () => {
  const h = await household();
  const a = await enrolled(h);
  must(await api('POST', `/teams/${h.team.id}/attendance/request`, { token: h.mgr.token, body: { fixture_id: h.fx.id } }));
  must(await api('POST', `/events/${h.ev.id}/registration/policy`, { token: h.org.token, body: { rules: {}, expected_version: 0 } }), 201);
  const co = await signup(); await verifiedGuardian(co, h.c1, { exceptional: true });
  const links = must(await api('GET', '/youth/guardian-links', { token: co.token }));
  const coLink = links.find((l) => l.child_id === h.c1.id);
  assert.deepEqual(coLink.scopes.sort(), ['calendar', 'consent', 'pay', 'register', 'rsvp', 'travel_consent'], 'existing and new links keep full authority');
  // a co-guardian cannot narrow another guardian; the primary guardian can; the co-guardian can reduce only themselves
  assert.equal((await api('PATCH', `/youth/guardian-links/${h.link.id}/scopes`, { token: co.token, body: { scopes: [] } })).status, 404);
  assert.equal((await api('PATCH', `/youth/guardian-links/${coLink.id}/scopes`, { token: (await signup()).token, body: { scopes: [] } })).status, 404);
  const narrowed = must(await api('PATCH', `/youth/guardian-links/${coLink.id}/scopes`, { token: h.parent.token, body: { scopes: ['calendar'] } }));
  assert.deepEqual(narrowed.scopes, ['calendar']);
  assert.equal((await api('PATCH', `/youth/guardian-links/${coLink.id}/scopes`, { token: co.token, body: { scopes: ['calendar', 'pay'] } })).status, 403, 'cannot widen own authority');
  // blocked: RSVP, register, consent, pay
  const t = (r) => r.body.error?.code ?? r.body.code;
  const rsvp = await api('POST', `/teams/${h.team.id}/attendance`, { token: co.token, body: { fixture_id: h.fx.id, rsvp: 'going', for_user_id: h.c1.id } });
  assert.equal(rsvp.status, 403); assert.equal(t(rsvp), 'guardian_scope_required');
  assert.equal((await api('POST', `/events/${h.ev.id}/registrations`, { token: co.token, body: { team_id: h.team.id, user_id: h.c1.id } })).status, 403);
  assert.equal((await api('POST', `/youth/children/${h.c1.id}/consents`, { token: co.token, body: { purpose: 'media' } })).status, 403);
  const charge = (await dash(h)).dependents[0].fees[0].charge_id;
  // co-guardian is not the payer here, so pay is refused either way; the scope check applies once they are
  await pool.query('UPDATE academy_charges SET payer_id=$2 WHERE id=$1', [charge, co.id]);
  assert.equal(t(await api('POST', '/payments', { token: co.token, body: { purpose_type: 'academy_charge', purpose_id: charge, provider: 'stripe' } })), 'guardian_scope_required');
  // withdrawing a permission stays open to a restricted guardian
  must(await api('DELETE', `/youth/children/${h.c1.id}/consents/participation`, { token: co.token }));
  // dashboard: the co-guardian sees their children but the to-dos are marked blocked, and no calendar scope hides upcoming
  const cd = await dash(h, co);
  assert.deepEqual(cd.dependents[0].scopes, ['calendar']);
  assert.ok(cd.todo.length && cd.todo.every((x) => x.kind === 'renew_link' || x.blocked === 'scope'));
  // restoring scopes restores the actions
  must(await api('PATCH', `/youth/guardian-links/${coLink.id}/scopes`, { token: h.parent.token, body: { scopes: ['calendar', 'consent', 'rsvp'] } }));
  must(await api('POST', `/youth/children/${h.c1.id}/consents`, { token: co.token, body: { purpose: 'media' } }), 201);
  assert.ok(a.org.id);
});

test('calendar scope gates the combined calendar and dashboard upcoming', async () => {
  const h = await household();
  const co = await signup(); await verifiedGuardian(co, h.c1, { exceptional: true });
  const coLink = must(await api('GET', '/youth/guardian-links', { token: co.token })).find((l) => l.child_id === h.c1.id);
  assert.ok(must(await api('GET', '/me/family/schedule', { token: co.token, query: { from: day(0), to: day(10) } })).items.some((x) => x.person.id === h.c1.id));
  must(await api('PATCH', `/youth/guardian-links/${coLink.id}/scopes`, { token: h.parent.token, body: { scopes: ['pay'] } }));
  assert.ok(!must(await api('GET', '/me/family/schedule', { token: co.token, query: { from: day(0), to: day(10) } })).items.some((x) => x.person.id === h.c1.id));
  assert.deepEqual((await dash(h, co)).dependents[0].upcoming, []);
});

test('an organisation can reserve scopes for the primary guardian, only tightening, with history kept', async () => {
  const h = await household();
  const a = await enrolled(h);
  const co = await signup(); await verifiedGuardian(co, h.c1, { exceptional: true });
  const charge = (await dash(h)).dependents[0].fees[0].charge_id;
  await pool.query('UPDATE academy_charges SET payer_id=$2 WHERE id=$1', [charge, co.id]);
  const pay = (tok) => api('POST', '/payments', { token: tok, body: { purpose_type: 'academy_charge', purpose_id: charge, provider: 'stripe' } });
  assert.notEqual((await pay(co.token)).status, 403, 'allowed before any policy');
  assert.equal((await api('POST', `/organisations/${a.org.id}/guardian-policy`, { token: co.token, body: { primary_only_scopes: ['pay'] } })).status, 404, 'only the organisation');
  const p1 = must(await api('POST', `/organisations/${a.org.id}/guardian-policy`, { token: a.owner.token, body: { primary_only_scopes: ['pay'], note: 'Billing contact only' } }), 201);
  assert.equal(p1.version, 1); assert.deepEqual(p1.primary_only_scopes, ['pay']);
  assert.equal((await pay(co.token)).body.error?.code ?? (await pay(co.token)).body.code, 'guardian_scope_required', 'second guardian blocked by the academy');
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/guardian-policy`, { token: a.owner.token })).primary_only_scopes[0], 'pay');
  await pool.query('UPDATE academy_charges SET payer_id=$2 WHERE id=$1', [charge, h.parent.id]);
  assert.notEqual((await pay(h.parent.token)).status, 403, 'the primary guardian still pays');
  const p2 = must(await api('POST', `/organisations/${a.org.id}/guardian-policy`, { token: a.owner.token, body: { primary_only_scopes: [] } }), 201);
  assert.equal(p2.version, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_guardian_policies WHERE organisation_id=$1', [a.org.id])).rows[0].n, 2, 'history is kept, not deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_guardian_policies WHERE organisation_id=$1 AND retired_at IS NULL', [a.org.id])).rows[0].n, 1);
});

test('entered-only events are left off the family calendar unless asked for, but a real RSVP request still shows', async () => {
  const h = await household();
  const q = { from: day(0), to: day(40) };
  let cal = must(await api('GET', '/me/family/schedule', { token: h.parent.token, query: q }));
  assert.ok(!cal.items.some((x) => x.source_type === 'event'), 'no unanswerable entered-event rows');
  const all = must(await api('GET', '/me/family/schedule', { token: h.parent.token, query: { ...q, include_entries: 'true' } }));
  assert.ok(all.items.some((x) => x.source_type === 'event' && x.person.id === h.c1.id), 'still available on request');
  must(await api('POST', `/teams/${h.team.id}/attendance/request`, { token: h.mgr.token, body: { event_id: h.ev.id } }));
  cal = must(await api('GET', '/me/family/schedule', { token: h.parent.token, query: q }));
  assert.ok(cal.items.some((x) => x.source_type === 'event' && x.person.id === h.c1.id), 'asked for an answer, so it shows');
  assert.ok(cal.items.some((x) => x.kind === 'match'), 'matches always show');
});

test('MCP and OpenAPI expose the new guardian authority capabilities', async () => {
  const h = await household();
  const tools = (await rpc('tools/list', {}, h.parent.token)).tools.map((x) => x.name);
  for (const name of ['set_guardian_link_scopes', 'get_org_guardian_policy', 'set_org_guardian_policy']) assert.ok(tools.includes(name), name);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(spec.paths['/youth/guardian-links/{id}/scopes'] && spec.paths['/organisations/{id}/guardian-policy']);
});

test('only the primary guardian sees the other guardians and what each may do', async () => {
  const h = await household();
  const co = await signup(); await verifiedGuardian(co, h.c1, { exceptional: true });
  const mine = (await dash(h)).dependents[0];
  assert.equal(mine.primary, true);
  assert.deepEqual(mine.co_guardians.map((x) => x.guardian_id), [co.id]);
  const theirs = (await dash(h, co)).dependents[0];
  assert.equal(theirs.primary, false); assert.deepEqual(theirs.co_guardians, []);
});
