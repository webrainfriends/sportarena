import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

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
  const r = await api('POST', '/auth/register', { body: { handle: `br_${n}_${roles[0]}`, display_name: `Branch ${n}`, email: `br${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const BACKFILL = readFileSync(new URL('../migrations/154_campus_hierarchy_branches.sql', import.meta.url), 'utf8');

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function academy() {
  const owner = await signup(['venue_manager']), mgr = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Branch Academy ${n}`, kind: 'academy', city: 'Madrid' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: mgr.handle, role: 'staff' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: mgr.token, body: { accept: true } }));
  const venue = async (name) => { const v = ok(await api('POST', '/venues', { token: owner.token, body: { name: `${name} ${n}`, city: 'Madrid', timezone: 'UTC', currency: 'EUR' } }), 201); ok(await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'venue', asset_id: v.id } })); return v; };
  const prog = async (title) => ok(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: `${title} ${n}`, format: 'squad_pathway', capacity: 20 } }), 201);
  return { owner, mgr, org, venue, prog };
}
const branch = (a, body) => api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { idempotency_key: `bk-${Math.random().toString(36).slice(2)}-${Date.now()}`, ...body } });
const overview = async (a) => ok(await api('GET', `/organisations/${a.org.id}/campuses`, { token: a.owner.token }));
const unitOf = (o, name) => o.units.find((u) => u.name === name);
const progBranch = async (id) => (await pool.query('SELECT branch_id FROM academy_programmes WHERE id=$1', [id])).rows[0].branch_id;

test('existing branches become campuses without touching a branch row: venues, programmes, manager, archived ones, idempotent', async () => {
  const a = await academy();
  const v1 = await a.venue('North'), v2 = await a.venue('South'), p1 = await a.prog('U14'), p2 = await a.prog('U16'), p3 = await a.prog('Legacy');
  // branch rows exactly as main created them (no campus yet): written straight into the table
  const mk = async (name, extra) => (await pool.query('INSERT INTO academy_branches(organisation_id, name, city, venue_ids, code, manager_id, opened_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [a.org.id, name, 'Madrid', extra.venues ?? [], extra.code ?? null, extra.manager ?? null, extra.opened ?? null, a.owner.id])).rows[0].id;
  const north = await mk('Madrid North', { venues: [v1.id, v2.id], code: 'MAD-N', manager: a.mgr.id, opened: day(-200) }), south = await mk('Madrid South', { venues: [v2.id], code: 'mad-n' });
  const old = await mk('Closed Branch', { code: 'OLD' }); await pool.query('UPDATE academy_branches SET archived_at=now(), archived_by=$2 WHERE id=$1', [old, a.owner.id]);
  await pool.query('UPDATE academy_programmes SET branch_id=$2 WHERE id=$1', [p1.id, north]); await pool.query('UPDATE academy_programmes SET branch_id=$2 WHERE id=$1', [p2.id, south]); await pool.query('UPDATE academy_programmes SET branch_id=$2 WHERE id=$1', [p3.id, old]);
  const before = JSON.stringify((await pool.query('SELECT id, name, city, venue_ids, code, manager_id, archived_at IS NOT NULL AS arch FROM academy_branches WHERE organisation_id=$1 ORDER BY id', [a.org.id])).rows);
  const progs = JSON.stringify((await pool.query('SELECT id, branch_id FROM academy_programmes WHERE organisation_id=$1 ORDER BY id', [a.org.id])).rows);

  await pool.query(BACKFILL);
  assert.equal(JSON.stringify((await pool.query('SELECT id, name, city, venue_ids, code, manager_id, archived_at IS NOT NULL AS arch FROM academy_branches WHERE organisation_id=$1 ORDER BY id', [a.org.id])).rows), before, 'branch rows are untouched');
  assert.equal(JSON.stringify((await pool.query('SELECT id, branch_id FROM academy_programmes WHERE organisation_id=$1 ORDER BY id', [a.org.id])).rows), progs, 'programme grouping is untouched');
  const o = await overview(a);
  assert.equal(o.setup_done, true);
  const N = unitOf(o, 'Madrid North'), S = unitOf(o, 'Madrid South');
  assert.equal(N.kind, 'campus'); assert.equal(N.code, 'MAD-N'); assert.equal(N.metrics.venues, 2); assert.equal(N.metrics.programmes, 0, 'draft programmes are not counted as live');
  assert.equal(S.code, null, 'a duplicate code is left off the later campus'); assert.equal(S.metrics.venues, 0, 'a venue two branches list goes to the earlier one');
  assert.equal(o.units.find((u) => u.name === 'Closed Branch'), undefined, 'an archived branch is an archived campus, hidden by default');
  assert.equal((await pool.query("SELECT status FROM org_units WHERE legacy_branch_id=$1", [old])).rows[0].status, 'archived');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM org_unit_links l JOIN org_units u ON u.id=l.unit_id WHERE u.legacy_branch_id=$1 AND l.effective_to IS NULL", [old])).rows[0].n, 0, 'an archived campus has no open links');
  const det = ok(await api('GET', `/organisations/${a.org.id}/units/${N.id}`, { token: a.owner.token }));
  assert.deepEqual(det.assets.programme.map((x) => x.object_id), [p1.id]); assert.equal(det.roles.find((r) => r.role === 'director').user_id, a.mgr.id, 'the branch manager is the campus director');
  assert.equal(det.unit.valid_from, day(-200), 'the opening date is the campus start');
  // the manager now sees exactly that campus
  const mo = ok(await api('GET', `/organisations/${a.org.id}/campuses`, { token: a.mgr.token })); assert.deepEqual(mo.units.filter((u) => !u.context_only).map((u) => u.name), ['Madrid North']);
  // running it again adds nothing
  const counts = async () => JSON.stringify((await pool.query('SELECT (SELECT count(*) FROM org_units) u, (SELECT count(*) FROM org_unit_links) l, (SELECT count(*) FROM org_unit_roles) r, (SELECT count(*) FROM org_unit_changes) c')).rows[0]);
  const c1 = await counts(); await pool.query(BACKFILL); assert.equal(await counts(), c1, 'idempotent');
  // the branch endpoints and the branch report read exactly what they read before
  const lst = ok(await api('GET', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token }));
  assert.equal(lst.branches.length, 3); assert.equal(lst.branches.find((b) => b.id === north).programmes.length, 1);
});

test('the branch endpoints write through to the campus tree: create, rename, venues, manager, programme placement, archive', async () => {
  const a = await academy();
  const v1 = await a.venue('Alpha'), v2 = await a.venue('Beta'), p = await a.prog('Elite');
  const b = ok(await branch(a, { name: 'Valencia', city: 'Valencia', venue_ids: [v1.id], code: 'VLC', manager_id: a.mgr.id }), 201);
  assert.ok(b.unit_id, 'a branch created through the old endpoint has its campus');
  let o = await overview(a); const U = unitOf(o, 'Valencia');
  assert.equal(U.id, b.unit_id); assert.equal(U.metrics.venues, 1); assert.equal(U.city, 'Valencia'); assert.equal(U.code, 'VLC');
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/units/${U.id}`, { token: a.owner.token })).roles[0].user_id, a.mgr.id);
  // rename + change venues + clear manager
  ok(await api('POST', `/academy/branches/${b.id}`, { token: a.owner.token, body: { name: 'Valencia Centro', venue_ids: [v2.id], manager_id: null } }));
  o = await overview(a); const U2 = unitOf(o, 'Valencia Centro'); assert.equal(U2.id, U.id, 'same campus id'); assert.equal(U2.metrics.venues, 1);
  const det = ok(await api('GET', `/organisations/${a.org.id}/units/${U.id}`, { token: a.owner.token }));
  assert.deepEqual(det.assets.venue.map((x) => x.object_id), [v2.id]); assert.equal(det.roles.length, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM org_unit_links WHERE unit_id=$1 AND object_type='venue' AND effective_to IS NOT NULL", [U.id])).rows[0].n, 1, 'the venue pointer that ended is kept as history');
  // placing a programme through the old endpoint puts it on the campus
  ok(await api('POST', `/academy/programmes/${p.id}/branch`, { token: a.owner.token, body: { branch_id: b.id } }));
  assert.deepEqual(ok(await api('GET', `/organisations/${a.org.id}/units/${U.id}`, { token: a.owner.token })).assets.programme.map((x) => x.object_id), [p.id]);
  ok(await api('POST', `/academy/programmes/${p.id}/branch`, { token: a.owner.token, body: { branch_id: null } }));
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/units/${U.id}`, { token: a.owner.token })).assets.programme.length, 0);
  // archive: the campus is archived, its links end, the branch keeps its programmes for past reports
  ok(await api('POST', `/academy/programmes/${p.id}/branch`, { token: a.owner.token, body: { branch_id: b.id } }));
  ok(await api('POST', `/academy/branches/${b.id}/archive`, { token: a.owner.token }));
  assert.equal((await pool.query('SELECT status FROM org_units WHERE id=$1', [U.id])).rows[0].status, 'archived');
  assert.equal(await progBranch(p.id), b.id, 'the programme stays on the archived branch');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM org_unit_links WHERE unit_id=$1 AND effective_to IS NULL", [U.id])).rows[0].n, 0);
  // negative path stays exactly as before
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.mgr.token, body: { name: 'Nope', idempotency_key: 'nope-0000-key' } })).status, 403);
});

test('a campus made in the campus screens appears as a branch, and placing or transferring a programme keeps the branch report column right', async () => {
  const a = await academy(); const p = await a.prog('Pathway');
  const U = async (body) => ok(await api('POST', `/organisations/${a.org.id}/units`, { token: a.owner.token, body: { valid_from: day(-60), ...body } }), 201);
  const bcn = await U({ kind: 'campus', name: 'Barcelona', code: 'BCN', city: 'Barcelona' }), mad = await U({ kind: 'campus', name: 'Madrid', code: 'MAD', city: 'Madrid' });
  const lst = ok(await api('GET', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token }));
  assert.deepEqual(lst.branches.map((b) => b.name).sort(), ['Barcelona', 'Madrid'], 'campuses are visible to the branch screens');
  const bBcn = lst.branches.find((b) => b.name === 'Barcelona');
  assert.equal(bBcn.code, 'BCN');
  // placing the programme on a campus sets its branch
  ok(await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: a.owner.token, body: { to_unit_id: bcn.id, items: [{ object_type: 'programme', object_ids: [p.id] }], effective_on: day(-30) } }), 201);
  assert.equal(await progBranch(p.id), bBcn.id);
  // a transfer (the configured process: both campuses agree) moves it, and the branch follows on the effective date
  const t = ok(await api('POST', `/organisations/${a.org.id}/transfers`, { token: a.owner.token, body: { object_type: 'programme', object_ids: [p.id], to_unit_id: mad.id, reason_code: 'reorganisation' } }), 201);
  for (let i = 0; i < 4; i++) { const d = ok(await api('GET', `/organisations/${a.org.id}/transfers/${t.transfer_id}`, { token: a.owner.token })); const s = d.steps.find((x) => x.can_act); if (!s) break; ok(await api('POST', `/organisations/${a.org.id}/transfers/${t.transfer_id}/steps/${s.id}`, { token: a.owner.token, body: { decision: 'approve', note: 'Approved by the academy owner' } })); }
  const bMad = ok(await api('GET', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token })).branches.find((b) => b.name === 'Madrid');
  assert.equal(await progBranch(p.id), bMad.id, 'the branch P&L column follows the transfer');
  // renaming or archiving the campus is mirrored
  ok(await api('PATCH', `/organisations/${a.org.id}/units/${bcn.id}`, { token: a.owner.token, body: { name: 'Barcelona Sant Andreu' } }));
  assert.ok(ok(await api('GET', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token })).branches.some((b) => b.name === 'Barcelona Sant Andreu'));
  ok(await api('PATCH', `/organisations/${a.org.id}/units/${bcn.id}`, { token: a.owner.token, body: { status: 'archived' } }));
  assert.ok(ok(await api('GET', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token })).branches.find((b) => b.id === bBcn.id).archived_at, 'archiving the campus archives the branch');
});

test('setting up campuses for an academy with no branches puts every programme on the main campus, and the rollback restores the grouping exactly', async () => {
  const a = await academy(); const p1 = await a.prog('One'), p2 = await a.prog('Two');
  const grouping = async () => JSON.stringify((await pool.query('SELECT id, branch_id FROM academy_programmes WHERE organisation_id=$1 ORDER BY id', [a.org.id])).rows);
  const before = await grouping();
  const done = ok(await api('POST', `/organisations/${a.org.id}/campuses/adopt`, { token: a.owner.token, body: { name: 'Main campus' } }), 201);
  const bMain = ok(await api('GET', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token })).branches.find((b) => b.name === 'Main campus');
  assert.ok(bMain, 'the main campus is the academy\'s one branch'); assert.equal(await progBranch(p1.id), bMain.id); assert.equal(await progBranch(p2.id), bMain.id);
  ok(await api('POST', `/organisations/${a.org.id}/unit-changes/${done.change_id}/rollback`, { token: a.owner.token, body: {} }));
  assert.equal(await grouping(), before, 'programmes are back to no branch');
  assert.ok(ok(await api('GET', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token })).branches.find((b) => b.id === bMain.id).archived_at, 'the mirrored branch is archived, not deleted');
});
