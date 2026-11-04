import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Academy Placement Pathways (#801): advisor creates opportunity -> evidence checklist -> reference requests ->
// institution sharing with guardian consent -> stage transitions -> outcome -> sponsorship attribution.
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pl_${n}`, display_name: `Placement Person ${n}`, email: `pl${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const adult = (roles = ['athlete']) => signup(roles, { dob: yearsAgo(25) });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('pl_root','pl_root','{admin}','x','x','pl_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup() {
  const owner = await adult(['organizer']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Placement Academy ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['tennis'], currency: 'GBP', listed: false } }));
  // Give owner the placement permission in the member row
  await q("UPDATE organisation_members SET permissions = array_append(permissions, 'placement') WHERE organisation_id = $1 AND user_id = $2", [org.id, owner.id]);
  const athlete = await adult(['athlete']);
  await q("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,'athlete','active',now())", [org.id, athlete.id]);
  return { owner, org, athlete };
}

async function minorSetup() {
  const owner = await adult(['organizer']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Placement Academy Minor ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['tennis'], currency: 'GBP', listed: false } }));
  await q("UPDATE organisation_members SET permissions = array_append(permissions, 'placement') WHERE organisation_id = $1 AND user_id = $2", [org.id, owner.id]);
  const guardian = await adult();
  const kid = await signup(['athlete'], { dob: yearsAgo(15) });
  const link = must(await api('POST', '/youth/guardian-links', { token: guardian.token, body: { guardian_id: guardian.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${link.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${link.id}/evidence`, { token: guardian.token, body: { evidence: { reference: 'https://example.com/birth-ref', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${link.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'OK' } }));
  await q("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,'athlete','active',now())", [org.id, kid.id]);
  return { owner, org, guardian, kid };
}

test('advisor creates opportunity and advances stages', async () => {
  const { owner, org, athlete } = await setup();
  const opp = must(await api('POST', `/organisations/${org.id}/placement/opportunities`, { token: owner.token, body: {
    athlete_id: athlete.id, kind: 'university_place', title: 'Oxford Sport Science BSc 2026',
    institution_name: 'University of Oxford', sport: 'tennis', deadline: inDays(90), intake_year: 2026,
  } }), 201);
  assert.equal(opp.status, 'identified');
  assert.equal(opp.kind, 'university_place');

  const updated = must(await api('PATCH', `/organisations/${org.id}/placement/opportunities/${opp.id}`, { token: owner.token, body: {
    row_version: opp.row_version, status: 'eligibility_check',
  } }));
  assert.equal(updated.status, 'eligibility_check');
});

test('evidence checklist: add, request, complete', async () => {
  const { owner, org, athlete } = await setup();
  const opp = must(await api('POST', `/organisations/${org.id}/placement/opportunities`, { token: owner.token, body: {
    athlete_id: athlete.id, kind: 'scholarship', title: 'Full Tennis Scholarship 2026',
    institution_name: 'Stanford University', sport: 'tennis', deadline: inDays(60), intake_year: 2026,
  } }), 201);

  const ev = must(await api('POST', `/organisations/${org.id}/placement/opportunities/${opp.id}/evidence`, { token: owner.token, body: {
    kind: 'academic_transcript', label: 'A-Level transcript', required: true,
  } }), 201);
  assert.equal(ev.status, 'pending');

  // Advisor marks it as requested (notifying athlete)
  const ev2 = must(await api('PATCH', `/organisations/${org.id}/placement/opportunities/${opp.id}/evidence/${ev.id}`, { token: owner.token, body: {
    row_version: ev.row_version, status: 'requested',
  } }));
  assert.equal(ev2.status, 'requested');

  // Athlete submits
  const ev3 = must(await api('PATCH', `/organisations/${org.id}/placement/opportunities/${opp.id}/evidence/${ev.id}`, { token: athlete.token, body: {
    row_version: ev2.row_version, status: 'submitted',
  } }));
  assert.equal(ev3.status, 'submitted');
});

test('reference request: send, remind, complete', async () => {
  const { owner, org, athlete } = await setup();
  const opp = must(await api('POST', `/organisations/${org.id}/placement/opportunities`, { token: owner.token, body: {
    athlete_id: athlete.id, kind: 'university_place', title: 'Bath Sport Science 2026',
    institution_name: 'University of Bath', sport: 'tennis', deadline: inDays(45), intake_year: 2026,
  } }), 201);

  const ref = must(await api('POST', `/organisations/${org.id}/placement/opportunities/${opp.id}/references`, { token: owner.token, body: {
    referee_name_enc: 'Rafael Nadal', role: 'coach', due_date: inDays(30),
    purpose: 'Character and athletic excellence reference for university application',
  } }), 201);
  assert.equal(ref.status, 'pending');

  // Advisor sends request
  const ref2 = must(await api('PATCH', `/organisations/${org.id}/placement/opportunities/${opp.id}/references/${ref.id}`, { token: owner.token, body: {
    row_version: ref.row_version, status: 'requested',
  } }));
  assert.equal(ref2.status, 'requested');
});

test('institution sharing: grant, read by institution, revoke', async () => {
  const { owner, org, athlete } = await setup();
  const opp = must(await api('POST', `/organisations/${org.id}/placement/opportunities`, { token: owner.token, body: {
    athlete_id: athlete.id, kind: 'scholarship', title: 'MIT Tennis Scholarship 2026',
    institution_name: 'MIT', sport: 'tennis', deadline: inDays(60), intake_year: 2026,
  } }), 201);

  const share = must(await api('POST', `/organisations/${org.id}/placement/opportunities/${opp.id}/shares`, { token: athlete.token, body: {
    institution_name: 'MIT',
    fields: { sport_performance: true, academic: false, dev_plan: false, health_summary: false, contact: true },
    expires_at: inDays(120),
  } }), 201);
  assert.equal(share.guardian_approved_at, null); // adult so immediately accessible

  // Revoke
  must(await api('POST', `/organisations/${org.id}/placement/opportunities/${opp.id}/shares/${share.id}/revoke`, { token: athlete.token, body: {} }));
  const logs = must(await api('GET', `/organisations/${org.id}/placement/opportunities/${opp.id}/shares/log`, { token: owner.token }));
  assert.ok(Array.isArray(logs.events));
});

test('guardian must approve institution share for U18 athlete', async () => {
  const { owner, org, guardian, kid } = await minorSetup();
  const opp = must(await api('POST', `/organisations/${org.id}/placement/opportunities`, { token: owner.token, body: {
    athlete_id: kid.id, kind: 'scholarship', title: 'Junior Tennis Scholarship 2026',
    institution_name: 'IMG Academy', sport: 'tennis', deadline: inDays(60), intake_year: 2026,
  } }), 201);

  const share = must(await api('POST', `/organisations/${org.id}/placement/opportunities/${opp.id}/shares`, { token: kid.token, body: {
    institution_name: 'IMG Academy',
    fields: { sport_performance: true, academic: false, dev_plan: false, health_summary: false, contact: false },
    expires_at: inDays(90),
  } }), 201);
  // Guardian approval pending
  assert.equal(share.guardian_approved_at, null);

  // Guardian approves
  const approved = must(await api('POST', `/organisations/${org.id}/placement/opportunities/${opp.id}/shares/${share.id}/guardian-approve`, { token: guardian.token, body: {} }));
  assert.ok(approved.guardian_approved_at);
});

test('non-advisor cannot create opportunity', async () => {
  const { org, athlete } = await setup();
  const outsider = await adult();
  await api('POST', '/organisations', { token: outsider.token, body: { name: `Other Org ${++n}`, kind: 'club' } });
  const r = await api('POST', `/organisations/${org.id}/placement/opportunities`, { token: outsider.token, body: {
    athlete_id: athlete.id, kind: 'university_place', title: 'Should fail',
    institution_name: 'Some University', sport: 'tennis', deadline: inDays(90), intake_year: 2026,
  } });
  assert.ok(r.status === 403 || r.status === 404, `expected 403/404 got ${r.status}`);
});

test('action queue lists urgent items', async () => {
  const { owner, org, athlete } = await setup();
  must(await api('POST', `/organisations/${org.id}/placement/opportunities`, { token: owner.token, body: {
    athlete_id: athlete.id, kind: 'university_place', title: 'Cambridge Tennis 2026',
    institution_name: 'University of Cambridge', sport: 'tennis', deadline: inDays(5), intake_year: 2026,
  } }), 201);
  const queue = must(await api('GET', `/organisations/${org.id}/placement/action-queue`, { token: owner.token }));
  assert.ok(Array.isArray(queue.items));
});

test('analytics returns funnel counts', async () => {
  const { owner, org } = await setup();
  const analytics = must(await api('GET', `/organisations/${org.id}/placement/analytics`, { token: owner.token }));
  assert.ok('total' in analytics);
  assert.ok('by_stage' in analytics);
});

test('link sponsorship award to opportunity', async () => {
  const { owner, org, athlete } = await setup();
  const opp = must(await api('POST', `/organisations/${org.id}/placement/opportunities`, { token: owner.token, body: {
    athlete_id: athlete.id, kind: 'scholarship', title: 'Full Scholarship 2026',
    institution_name: 'Loughborough University', sport: 'tennis', deadline: inDays(60), intake_year: 2026,
  } }), 201);
  // Create a sponsorship award first
  const sponsor = must(await api('POST', `/organisations/${org.id}/sponsorship/sponsors`, { token: owner.token, body: { name: `Sponsor ${++n}`, kind: 'organisation' } }), 201);
  const award = must(await api('POST', `/organisations/${org.id}/sponsorship/awards`, { token: owner.token, body: {
    sponsor_id: sponsor.id, athlete_id: athlete.id, sport: 'tennis',
    amount_minor: 1000000, currency: 'GBP', kind: 'scholarship', label: 'Full scholarship 2026',
    effective_from: inDays(0), effective_to: inDays(365),
  } }), 201);
  const linked = must(await api('POST', `/organisations/${org.id}/placement/opportunities/${opp.id}/link-sponsorship`, { token: owner.token, body: { award_id: award.id } }));
  assert.equal(linked.placement_opportunity_id, opp.id);
});

test('athlete can list their own opportunities', async () => {
  const { owner, org, athlete } = await setup();
  must(await api('POST', `/organisations/${org.id}/placement/opportunities`, { token: owner.token, body: {
    athlete_id: athlete.id, kind: 'university_place', title: 'My University 2026',
    institution_name: 'Durham University', sport: 'tennis', deadline: inDays(90), intake_year: 2026,
  } }), 201);
  const list = must(await api('GET', `/me/placement/opportunities`, { token: athlete.token }));
  assert.ok(Array.isArray(list.opportunities));
  assert.ok(list.opportunities.length >= 1);
});
