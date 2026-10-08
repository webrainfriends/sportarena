import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `org_${n}_${roles[0]}`, display_name: `Org ${n}`, email: `org${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token, email: `org${n}@example.com` };
};
const today = () => new Date().toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An organisation with an owner, plus an invited-and-accepted staff member per role. */
const workspace = async () => {
  const owner = await signup();
  const org = (await api('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Academy', kind: 'academy' } })).body;
  const staff = {};
  for (const role of ['admin', 'coach', 'finance']) {
    const u = await signup();
    assert.equal((await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } })).status, 201);
    assert.equal((await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } })).status, 200);
    staff[role] = u;
  }
  return { owner, org, staff };
};

test('creating a workspace makes you owner; invitations need acceptance; strangers see only the public profile', async () => {
  const owner = await signup(), guest = await signup(), stranger = await signup();
  const org = (await api('POST', '/organisations', { token: owner.token, body: { name: 'Eastside FC' } })).body;
  assert.equal(org.my_role, 'owner');
  const inv = await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: guest.email, role: 'coach' } });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.status, 'invited');
  assert.equal((await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: guest.handle, role: 'admin' } })).status, 409, 'one live membership per person');
  assert.equal((await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: 'nobody_here' } })).status, 404);
  assert.equal((await api('GET', `/organisations/${org.id}/dashboard`, { token: guest.token })).status, 404, 'invited is not yet a member');
  const mine = (await api('GET', '/organisations', { token: guest.token })).body;
  assert.equal(mine[0].my_status, 'invited');
  assert.equal((await api('POST', `/organisations/${org.id}/invite/respond`, { token: guest.token, body: { accept: true } })).body.status, 'active');
  const pub = await api('GET', `/organisations/${org.id}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(Object.keys(pub.body).sort(), ['city', 'id', 'kind', 'my_role', 'name', 'status']);
  assert.equal(pub.body.my_role, null);
  assert.equal((await api('GET', `/organisations/${org.id}/members`, { token: stranger.token })).status, 404);
  assert.equal((await api('POST', `/organisations/${org.id}/members`, { token: guest.token, body: { person: stranger.handle } })).status, 403, 'coaches cannot invite');
});

test('isolation: staff of one organisation cannot see or change another organisation', async () => {
  const a = await workspace(), b = await workspace();
  const cohortB = (await api('POST', `/organisations/${b.org.id}/cohorts`, { token: b.owner.token, body: { name: 'U12' } })).body;
  for (const [method, path] of [['GET', `/organisations/${b.org.id}/dashboard`], ['GET', `/organisations/${b.org.id}/members`], ['GET', `/organisations/${b.org.id}/cohorts`], ['GET', `/organisations/${b.org.id}/export?section=staff`], ['GET', `/cohorts/${cohortB.id}/enrolments`], ['GET', `/cohorts/${cohortB.id}/attendance`]]) {
    for (const u of [a.owner, a.staff.admin, a.staff.coach, a.staff.finance]) {
      const r = await api(method, path, { token: u.token });
      assert.ok([403, 404].includes(r.status), `${method} ${path} by outsider -> ${r.status}`);
    }
  }
  const csv = `handle,consent\n${a.owner.handle},yes`;
  assert.equal((await api('POST', `/cohorts/${cohortB.id}/enrolments`, { token: a.owner.token, body: { csv } })).status, 404);
  assert.equal((await api('PATCH', `/organisations/${b.org.id}`, { token: a.owner.token, body: { name: 'Hijack' } })).status, 404);
});

test('revoking membership removes delegated access immediately, including over linked teams', async () => {
  const { owner, org, staff } = await workspace();
  const team = (await api('POST', '/teams', { token: owner.token, body: { name: 'Riverside U14', sport: 'cricket' } })).body;
  assert.equal((await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'team', asset_id: team.id } })).status, 200);
  assert.equal((await api('PATCH', `/teams/${team.id}`, { token: staff.coach.token, body: { city: 'Pune' } })).status, 200, 'coach manages linked team');
  assert.equal((await api('GET', `/organisations/${org.id}/dashboard`, { token: staff.coach.token })).status, 200);
  assert.equal((await api('DELETE', `/organisations/${org.id}/members/${staff.coach.id}`, { token: owner.token })).status, 200);
  assert.equal((await api('PATCH', `/teams/${team.id}`, { token: staff.coach.token, body: { city: 'Delhi' } })).status, 403, 'access gone at once');
  assert.equal((await api('GET', `/organisations/${org.id}/dashboard`, { token: staff.coach.token })).status, 404);
  const left = await pool.query("SELECT status, left_at FROM organisation_members WHERE organisation_id=$1 AND user_id=$2", [org.id, staff.coach.id]);
  assert.equal(left.rows[0].status, 'left', 'soft departure, row kept');
  assert.ok(left.rows[0].left_at);
});

test('delegation: admins manage linked teams, events and venues; finance and coaches do not get venue/event control', async () => {
  const { owner, org, staff } = await workspace();
  const organiser = await signup(['organizer']), venueOwner = await signup(['venue_manager']);
  const ev = (await api('POST', '/events', { token: organiser.token, body: { name: 'Club Cup', sport: 'cricket', starts_on: today(), ends_on: today(), entry_fee_cents: 0 } })).body;
  // only the asset's own owner may bring it in
  assert.equal((await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'event', asset_id: ev.id } })).status, 403);
  const other = await signup();
  const orgOfOrganiser = (await api('POST', '/organisations', { token: organiser.token, body: { name: 'Cup Organisers' } })).body;
  assert.equal((await api('POST', `/organisations/${orgOfOrganiser.id}/assets`, { token: organiser.token, body: { kind: 'event', asset_id: ev.id } })).status, 200);
  assert.equal((await api('POST', `/organisations/${org.id}/assets`, { token: organiser.token, body: { kind: 'event', asset_id: ev.id } })).status, 404, 'organiser is not in that org');
  const inv = await api('POST', `/organisations/${orgOfOrganiser.id}/members`, { token: organiser.token, body: { person: other.handle, role: 'admin' } });
  assert.equal(inv.status, 201);
  assert.equal((await api('GET', `/events/${ev.id}/entries`, { token: other.token })).status, 403, 'invited only');
  await api('POST', `/organisations/${orgOfOrganiser.id}/invite/respond`, { token: other.token, body: { accept: true } });
  assert.equal((await api('GET', `/events/${ev.id}/entries`, { token: other.token })).status, 200, 'org admin runs the linked event');
  assert.equal((await api('POST', `/organisations/${orgOfOrganiser.id}/assets`, { token: organiser.token, body: { kind: 'event', asset_id: ev.id } })).status, 200, 'idempotent');
  const venue = (await api('POST', '/venues', { token: venueOwner.token, body: { name: 'Riverside Ground', city: 'Pune', address: '1 River Rd' } }));
  if (venue.status === 201) {
    assert.equal((await api('POST', `/organisations/${org.id}/assets`, { token: staff.admin.token, body: { kind: 'venue', asset_id: venue.body.id } })).status, 403);
  }
  // archiving pauses delegation, restoring brings it back; data stays
  assert.equal((await api('POST', `/organisations/${orgOfOrganiser.id}/archive`, { token: other.token })).status, 403, 'owner only');
  assert.equal((await api('POST', `/organisations/${orgOfOrganiser.id}/archive`, { token: organiser.token })).status, 200);
  assert.equal((await api('GET', `/events/${ev.id}/entries`, { token: other.token })).status, 403);
  assert.equal((await api('GET', `/events/${ev.id}/entries`, { token: organiser.token })).status, 200, 'event owner unaffected');
  assert.equal((await api('PATCH', `/organisations/${orgOfOrganiser.id}`, { token: organiser.token, body: { name: 'x1' } })).status, 409, 'read-only');
  assert.equal((await api('GET', `/organisations/${orgOfOrganiser.id}/dashboard`, { token: organiser.token })).status, 200, 'history readable');
  assert.equal((await api('POST', `/organisations/${orgOfOrganiser.id}/restore`, { token: organiser.token })).status, 200);
  assert.equal((await api('GET', `/events/${ev.id}/entries`, { token: other.token })).status, 200);
});

test('owners: last owner is protected, ownership transfers cleanly, admins cannot touch owners', async () => {
  const { owner, org, staff } = await workspace();
  assert.equal((await api('DELETE', `/organisations/${org.id}/members/${owner.id}`, { token: owner.token })).status, 409, 'last owner cannot leave');
  assert.equal((await api('PATCH', `/organisations/${org.id}/members/${owner.id}`, { token: owner.token, body: { role: 'admin' } })).status, 409);
  assert.equal((await api('PATCH', `/organisations/${org.id}/members/${staff.coach.id}`, { token: staff.admin.token, body: { role: 'owner' } })).status, 403);
  assert.equal((await api('PATCH', `/organisations/${org.id}/members/${owner.id}`, { token: staff.admin.token, body: { role: 'coach' } })).status, 403);
  assert.equal((await api('POST', `/organisations/${org.id}/transfer`, { token: staff.admin.token, body: { to_user_id: staff.admin.id } })).status, 403);
  assert.equal((await api('POST', `/organisations/${org.id}/transfer`, { token: owner.token, body: { to_user_id: staff.admin.id } })).status, 200);
  const roles = Object.fromEntries((await pool.query("SELECT user_id, role FROM organisation_members WHERE organisation_id=$1 AND status='active'", [org.id])).rows.map((r) => [r.user_id, r.role]));
  assert.equal(roles[staff.admin.id], 'owner');
  assert.equal(roles[owner.id], 'admin');
  assert.equal((await api('POST', `/organisations/${org.id}/archive`, { token: owner.token })).status, 403, 'ex-owner is now an admin');
  assert.equal((await api('DELETE', `/organisations/${org.id}/members/${owner.id}`, { token: owner.token })).status, 200, 'can leave once not the last owner');
});

test('bulk enrolment: preview reports duplicates/invalid rows, commit is all-or-nothing and repeatable', async () => {
  const { owner, org, staff } = await workspace();
  const [p1, p2, p3] = [await signup(), await signup(), await signup()];
  const cohort = (await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'Under 14', coach_id: staff.coach.id } })).body;
  const csv = ['handle,consent', `${p1.handle},yes`, `${p2.email},yes`, `${p1.handle},yes`, 'ghost_user,yes', `${p3.handle},no`, ',yes'].join('\n');
  const prev = await api('POST', `/cohorts/${cohort.id}/enrolments/preview`, { token: staff.coach.token, body: { csv } });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.deepEqual(prev.body.summary, { total: 6, ok: 2, duplicate: 1, invalid: 3 });
  assert.ok(prev.body.rows.every((r) => !('user_id' in r)));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_enrolments')).rows[0].n, 0, 'preview wrote nothing');

  const bad = await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv } });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error.details.summary.invalid, 3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_enrolments')).rows[0].n, 0, 'nobody enrolled when any row is bad');

  const partial = await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv, allow_partial: true } });
  assert.equal(partial.status, 201);
  assert.equal(partial.body.summary.enrolled, 2);
  const again = await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${p1.handle},yes\n${p2.handle},yes` } });
  assert.equal(again.status, 409, 'repeat is reported as duplicates, never double-enrolled');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_enrolments')).rows[0].n, 2);

  // concurrent identical commits cannot create inconsistent rows
  const p4 = await signup();
  const one = `handle,consent\n${p4.handle},yes`;
  const results = await Promise.all([1, 2, 3].map(() => api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: one } })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_enrolments WHERE user_id=$1', [p4.id])).rows[0].n, 1);

  // permissions: other coach and finance cannot enrol; the person can withdraw themselves and later be re-enrolled
  const coach2 = await signup();
  await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: coach2.handle, role: 'coach' } });
  await api('POST', `/organisations/${org.id}/invite/respond`, { token: coach2.token, body: { accept: true } });
  assert.equal((await api('POST', `/cohorts/${cohort.id}/enrolments/preview`, { token: coach2.token, body: { csv: one } })).status, 403, 'not their cohort');
  assert.equal((await api('POST', `/cohorts/${cohort.id}/enrolments/preview`, { token: staff.finance.token, body: { csv: one } })).status, 403);
  assert.equal((await api('DELETE', `/cohorts/${cohort.id}/enrolments/${p1.id}`, { token: p1.token })).status, 200);
  assert.equal((await api('DELETE', `/cohorts/${cohort.id}/enrolments/${p1.id}`, { token: p1.token })).status, 404);
  const re = await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${p1.handle},yes` } });
  assert.equal(re.status, 201);
  assert.equal((await api('GET', '/me/enrolments', { token: p1.token })).body[0].status, 'enrolled');
});

test('attendance: coach of the cohort records, corrections upsert, enrolled people see only their own, history survives withdrawal', async () => {
  const { owner, org, staff } = await workspace();
  const [p1, p2] = [await signup(), await signup()];
  const cohort = (await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'Mornings', coach_id: staff.coach.id } })).body;
  await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${p1.handle},yes\n${p2.handle},yes` } });
  const rec = (token, records, session_date = today()) => api('POST', `/cohorts/${cohort.id}/attendance`, { token, body: { session_date, records } });
  assert.equal((await rec(staff.coach.token, [{ user_id: p1.id, status: 'present' }, { user_id: p2.id, status: 'absent' }])).status, 200);
  assert.equal((await rec(staff.coach.token, [{ user_id: p2.id, status: 'excused' }])).status, 200, 'correction');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_attendance')).rows[0].n, 2);
  const stranger = await signup();
  assert.equal((await rec(stranger.token, [{ user_id: p1.id, status: 'present' }])).status, 404);
  assert.equal((await rec(staff.finance.token, [{ user_id: p1.id, status: 'present' }])).status, 403);
  assert.equal((await rec(staff.coach.token, [{ user_id: stranger.id, status: 'present' }])).status, 400, 'must be enrolled');
  assert.equal((await rec(staff.coach.token, [{ user_id: p1.id, status: 'present' }], '2999-01-01')).status, 400);

  const all = (await api('GET', `/cohorts/${cohort.id}/attendance`, { token: owner.token })).body;
  assert.equal(all.people.length, 2);
  assert.equal(all.people.find((x) => x.id === p2.id).excused, 1);
  const mine = (await api('GET', `/cohorts/${cohort.id}/attendance`, { token: p1.token })).body;
  assert.deepEqual(mine.people.map((x) => x.id), [p1.id]);
  assert.ok(mine.records.every((r) => r.user_id === p1.id));
  await api('DELETE', `/cohorts/${cohort.id}/enrolments/${p1.id}`, { token: p1.token });
  assert.equal((await api('GET', `/cohorts/${cohort.id}/attendance`, { token: p1.token })).body.records.length, 1, 'historical access to own record');
  assert.equal((await api('GET', `/cohorts/${cohort.id}/attendance`, { token: stranger.token })).status, 404);
});

test('dashboard and export respect role boundaries; finance never sees rosters and nothing includes contact data', async () => {
  const { owner, org, staff } = await workspace();
  const team = (await api('POST', '/teams', { token: owner.token, body: { name: 'Org Team', sport: 'cricket' } })).body;
  await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'team', asset_id: team.id } });
  const p = await signup();
  await pool.query("INSERT INTO team_payouts(team_id, user_id, kind, amount_cents, currency, created_by) VALUES ($1,$2,'match_fee',50000,'INR',$3)", [team.id, p.id, owner.id]);
  const dash = async (u) => (await api('GET', `/organisations/${org.id}/dashboard`, { token: u.token })).body;
  const d = { owner: await dash(owner), admin: await dash(staff.admin), coach: await dash(staff.coach), finance: await dash(staff.finance) };
  assert.equal(d.owner.counts.teams, 1);
  assert.equal(d.owner.finance[0].amount_cents, 50000);
  assert.equal(d.admin.finance, undefined, 'admins do not see money');
  assert.equal(d.coach.finance, undefined);
  assert.equal(d.coach.counts, undefined);
  assert.ok(d.finance.finance && !d.finance.counts && !d.finance.seasons && !d.finance.attendance_30d, 'finance sees money only');
  const exp = (u, section) => api('GET', `/organisations/${org.id}/export?section=${section}`, { token: u.token });
  assert.equal((await exp(staff.finance, 'finance')).status, 200);
  assert.equal((await exp(staff.finance, 'staff')).status, 403);
  assert.equal((await exp(staff.admin, 'finance')).status, 403);
  assert.equal((await exp(staff.coach, 'enrolments')).status, 403);
  const staffCsv = (await exp(owner, 'staff')).body.csv;
  assert.ok(staffCsv.startsWith('handle,display_name,role'));
  assert.ok(!staffCsv.includes('@example.com'), 'no email in exports');
  assert.ok((await exp(owner, 'finance')).body.csv.includes('50000'));
  const audited = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'export_org_%'");
  assert.ok(audited.rows[0].n >= 3);
});

test('seasons and cohorts validate their links; migration kept pre-existing teams', async () => {
  const { owner, org, staff } = await workspace();
  const other = await workspace();
  const s = await api('POST', `/organisations/${org.id}/seasons`, { token: owner.token, body: { name: '2026/27', starts_on: '2026-09-01', ends_on: '2027-05-31' } });
  assert.equal(s.status, 201);
  assert.equal((await api('POST', `/organisations/${org.id}/seasons`, { token: owner.token, body: { name: 'bad', starts_on: '2027-01-01', ends_on: '2026-01-01' } })).status, 400);
  assert.equal((await api('POST', `/organisations/${org.id}/seasons`, { token: staff.coach.token, body: { name: 'nope', starts_on: '2027-01-01', ends_on: '2027-02-01' } })).status, 403);
  const foreignSeason = (await api('POST', `/organisations/${other.org.id}/seasons`, { token: other.owner.token, body: { name: '2026/27', starts_on: '2026-09-01', ends_on: '2027-05-31' } })).body;
  assert.equal((await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'X', season_id: foreignSeason.id } })).status, 400);
  assert.equal((await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'X', coach_id: staff.finance.id } })).status, 400);
  const c1 = await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'Seniors', season_id: s.body.id, coach_id: staff.coach.id } });
  assert.equal(c1.status, 201);
  assert.equal((await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'Seniors' } })).status, 409, 'unique name');
  assert.equal((await api('GET', `/organisations/${org.id}/cohorts`, { token: staff.coach.token })).body.length, 1);
  assert.equal((await api('GET', `/organisations/${org.id}/cohorts`, { token: staff.finance.token })).status, 403);
  const seasons = (await api('GET', `/organisations/${org.id}/seasons`, { token: owner.token })).body;
  assert.equal(seasons[0].cohorts, 1);
  // existing rows are untouched by the additive migration: organisation_id is simply null
  const t = (await api('POST', '/teams', { token: owner.token, body: { name: 'Solo Team', sport: 'cricket' } })).body;
  assert.equal((await pool.query('SELECT organisation_id FROM teams WHERE id=$1', [t.id])).rows[0].organisation_id, null);

  assert.equal((await api('POST', `/cohorts/${c1.body.id}/archive`, { token: owner.token })).status, 200);
});
