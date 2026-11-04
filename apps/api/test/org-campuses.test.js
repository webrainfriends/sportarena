import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');

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
  const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `Camp ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const today = new Date().toISOString().slice(0, 10);
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** A real single-campus academy built through the public API: an owner, a coach, a venue, a team, a programme, a cohort with one athlete and a fee. */
async function academy() {
  const owner = await signup(['venue_manager']), coach = await signup(['coach']), kid = await signup(), outsider = await signup(['venue_manager']);
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Hierarchy Academy ${n}`, kind: 'academy', city: 'Pune' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: coach.handle, role: 'coach' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: coach.token, body: { accept: true } }));
  const venue = ok(await api('POST', '/venues', { token: owner.token, body: { name: `North Ground ${n}`, city: 'Pune', timezone: 'UTC', currency: 'INR' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'venue', asset_id: venue.id } }));
  const prog = ok(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: `U12 ${n}`, format: 'term_course', age_min: 9, age_max: 12, capacity: 24, coach_ids: [coach.id] } }), 201);
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `U12 Football ${n}`, coach_id: coach.id } }), 201);
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kid.handle},yes` } }), 201);
  return { owner, coach, kid, outsider, org, venue, prog, cohort };
}
const unit = async (a, body) => ok(await api('POST', `/organisations/${a.org.id}/units`, { token: a.owner.token, body: { valid_from: day(-60), ...body } }), 201);
const overview = (a, who = a.owner, q = '') => api('GET', `/organisations/${a.org.id}/campuses${q}`, { token: who.token });
const row = (o, id) => o.units.find((u) => u.id === id);

test('a single-campus academy is unchanged until it opts in, and adoption changes no record', async () => {
  const a = await academy();
  const before = await overview(a); const o0 = ok(before);
  assert.equal(o0.setup_done, false); assert.deepEqual(o0.units, []);
  const snap = async () => JSON.stringify([
    (await pool.query('SELECT id, name, organisation_id FROM venues WHERE id=$1', [a.venue.id])).rows,
    (await pool.query('SELECT id, status, programme_id FROM org_enrolments ORDER BY id')).rows,
    (await pool.query('SELECT id, title, status, organisation_id FROM academy_programmes WHERE organisation_id=$1', [a.org.id])).rows,
    (await pool.query('SELECT * FROM org_cohorts WHERE organisation_id=$1 ORDER BY id', [a.org.id])).rows,
  ]);
  const pre = await snap();
  const dry = ok(await api('POST', `/organisations/${a.org.id}/campuses/adopt`, { token: a.owner.token, body: { name: 'Pune Campus', country: 'IN', dry_run: true } }), 201);
  assert.equal(dry.dry_run, true); assert.equal(dry.changes_to_records, 0); assert.equal(dry.will_point.venue, 1); assert.equal(dry.will_point.programme, 1); assert.equal(dry.will_point.cohort, 1); assert.equal(dry.athletes_following, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_units WHERE organisation_id=$1', [a.org.id])).rows[0].n, 0, 'a dry run writes nothing');
  const done = ok(await api('POST', `/organisations/${a.org.id}/campuses/adopt`, { token: a.owner.token, body: { name: 'Pune Campus', country: 'IN', idempotency_key: 'adopt-0001-key' } }), 201);
  assert.equal(await snap(), pre, 'every existing record is byte-identical');
  const again = ok(await api('POST', `/organisations/${a.org.id}/campuses/adopt`, { token: a.owner.token, body: { name: 'Pune Campus', idempotency_key: 'adopt-0001-key' } }), 201);
  assert.equal(again.replayed, true); assert.equal(again.change_id, done.change_id);
  assert.equal((await api('POST', `/organisations/${a.org.id}/campuses/adopt`, { token: a.owner.token, body: { name: 'Second' } })).status, 409, 'cannot adopt twice');
  const o1 = ok(await overview(a)); const c1 = row(o1, done.unit.id);
  assert.equal(o1.setup_done, true); assert.equal(c1.metrics.venues, 1); assert.equal(c1.metrics.athletes, 1); assert.equal(c1.metrics.programmes, 0, 'draft programmes are not counted as live'); assert.ok(c1.metrics.staff >= 2);
  // rollback restores the pre-adoption state exactly
  const rb = ok(await api('POST', `/organisations/${a.org.id}/unit-changes/${done.change_id}/rollback`, { token: a.owner.token, body: { reason: 'test' } }));
  assert.equal(rb.rolled_back, true); assert.equal(rb.retired_default_campus, done.unit.id);
  assert.equal(await snap(), pre);
  assert.equal(ok(await overview(a)).units.length, 0, 'the default campus is archived and hidden');
  assert.equal((await api('POST', `/organisations/${a.org.id}/unit-changes/${done.change_id}/rollback`, { token: a.owner.token, body: {} })).status, 409, 'rolled back once only');
});

test('tree rules: region > campus > sport department, immutable ids, codes unique, lifecycle without deletion', async () => {
  const a = await academy();
  const asia = await unit(a, { kind: 'region', name: 'Asia', country: 'IN' });
  const pune = await unit(a, { kind: 'campus', name: 'Pune', parent_id: asia.id, code: 'PNQ', city: 'Pune', timezone: 'Asia/Kolkata' });
  assert.equal(pune.country, 'IN', 'country inherited from the region');
  const foot = await unit(a, { kind: 'department', name: 'Football', parent_id: pune.id, sport: 'football' });
  const bad = (body) => api('POST', `/organisations/${a.org.id}/units`, { token: a.owner.token, body });
  assert.equal((await bad({ kind: 'department', name: 'Orphan', sport: 'tennis' })).status, 400, 'a department needs a campus');
  assert.equal((await bad({ kind: 'campus', name: 'Under campus', parent_id: pune.id })).status, 400);
  assert.equal((await bad({ kind: 'region', name: 'Under dept', parent_id: foot.id })).status, 400);
  assert.equal((await bad({ kind: 'department', name: 'No sport', parent_id: pune.id })).status, 400, 'sport is required');
  assert.equal((await bad({ kind: 'campus', name: 'Dup code', code: 'pnq' })).status, 409);
  const cycle = await api('PATCH', `/organisations/${a.org.id}/units/${asia.id}`, { token: a.owner.token, body: { parent_id: foot.id } });
  assert.equal(cycle.status, 400);
  // a campus can move to another region and keeps its id, departments and links
  const eu = await unit(a, { kind: 'region', name: 'Europe', country: 'ES' });
  const moved = ok(await api('PATCH', `/organisations/${a.org.id}/units/${pune.id}`, { token: a.owner.token, body: { parent_id: eu.id } }));
  assert.equal(moved.id, pune.id); assert.equal(moved.parent_id, eu.id);
  const d = ok(await api('GET', `/organisations/${a.org.id}/units/${foot.id}`, { token: a.owner.token }));
  assert.deepEqual(d.path.map((p) => p.name), ['Europe', 'Pune', 'Football']);
  // optimistic concurrency
  assert.equal((await api('PATCH', `/organisations/${a.org.id}/units/${pune.id}`, { token: a.owner.token, body: { name: 'Pune 2', row_version: 1 } })).status, 409);
  // an archive is refused while anything is still on the unit; then it is a soft archive
  ok(await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: a.owner.token, body: { to_unit_id: pune.id, items: [{ object_type: 'venue', object_ids: [a.venue.id] }] } }), 201);
  assert.equal((await api('PATCH', `/organisations/${a.org.id}/units/${pune.id}`, { token: a.owner.token, body: { status: 'archived' } })).status, 409);
  const sus = ok(await api('PATCH', `/organisations/${a.org.id}/units/${foot.id}`, { token: a.owner.token, body: { status: 'suspended' } }));
  assert.equal(sus.status, 'suspended');
  assert.equal((await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: a.owner.token, body: { to_unit_id: foot.id, items: [{ object_type: 'cohort', object_ids: [a.cohort.id] }] } })).status, 409, 'nothing can be placed on a suspended unit');
  ok(await api('PATCH', `/organisations/${a.org.id}/units/${foot.id}`, { token: a.owner.token, body: { status: 'archived' } }));
  assert.equal((await pool.query('SELECT status, archived_at IS NOT NULL AS stamped FROM org_units WHERE id=$1', [foot.id])).rows[0].stamped, true, 'archived, not deleted');
  assert.equal((await api('PATCH', `/organisations/${a.org.id}/units/${foot.id}`, { token: a.owner.token, body: { name: 'Renamed' } })).status, 409, 'archived is read-only');
});

/** Run a transfer to completion through the default process (both campuses agree), the owner overriding each step with a reason. */
const transfer = async (a, body, who = a.owner) => {
  const r = ok(await api('POST', `/organisations/${a.org.id}/transfers`, { token: who.token, body: { reason_code: 'relocation', ...body } }), 201);
  return r;
};
const approveAll = async (a, tid, who = a.owner) => {
  let state;
  for (let n = 0; n < 8; n++) {
    const t = ok(await api('GET', `/organisations/${a.org.id}/transfers/${tid}`, { token: who.token }));
    const step = t.steps.find((s) => s.can_act);
    if (!step) return t;
    const body = step.kind === 'checklist' ? { decision: 'complete', items_done: step.items.map((_, i) => i) } : { decision: 'approve', note: 'Approved by the academy owner' };
    state = ok(await api('POST', `/organisations/${a.org.id}/transfers/${tid}/steps/${step.id}`, { token: who.token, body }));
  }
  return state;
};

test('transfer: identity, history, charges and contracts stay put; only the effective-dated pointer moves; it takes the configured process and can be rolled back', async () => {
  const a = await academy();
  const pune = await unit(a, { kind: 'campus', name: 'Pune', code: 'PNQ' }), goa = await unit(a, { kind: 'campus', name: 'Goa', code: 'GOI' });
  ok(await api('POST', `/organisations/${a.org.id}/academy/staff/${a.coach.id}`, { token: a.owner.token, body: { job_title: 'Head coach', template: 'custom', engagement_type: 'employee' } }));
  const enrolment = (await pool.query('SELECT id FROM org_enrolments WHERE cohort_id=$1', [a.cohort.id])).rows[0].id;
  await pool.query("INSERT INTO academy_charges(enrolment_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, amount_minor) VALUES ($1,$2,$3,1,'tuition',$4,'INR',500000,500000)", [enrolment, a.org.id, a.kid.id, day(-3)]);
  const place = async (type, ids) => ok(await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: a.owner.token, body: { to_unit_id: pune.id, items: [{ object_type: type, object_ids: ids }], effective_on: day(-30) } }), 201);
  await place('cohort', [a.cohort.id]); await place('staff', [a.coach.id]);
  const eng = JSON.stringify((await pool.query('SELECT * FROM org_staff_engagements WHERE user_id=$1', [a.coach.id])).rows);
  const rows = async () => JSON.stringify([(await pool.query('SELECT id, user_id, cohort_id, status FROM org_enrolments WHERE cohort_id=$1', [a.cohort.id])).rows, (await pool.query('SELECT id, amount_minor, status FROM academy_charges WHERE organisation_id=$1', [a.org.id])).rows]);
  const ids = await rows();

  // placing is for unplaced objects only; moving what is placed is a transfer
  assert.equal((await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: a.owner.token, body: { to_unit_id: goa.id, items: [{ object_type: 'cohort', object_ids: [a.cohort.id] }] } })).status, 409);

  const dry = ok(await api('POST', `/organisations/${a.org.id}/transfers`, { token: a.owner.token, body: { object_type: 'cohort', object_ids: [a.cohort.id], to_unit_id: goa.id, reason_code: 'relocation', dry_run: true } }), 201);
  assert.equal(dry.dry_run, true); assert.equal(dry.from.name, 'Pune'); assert.equal(dry.to.name, 'Goa'); assert.equal(dry.process.configured, false);
  assert.deepEqual(dry.process.steps.map((x) => x.role), ['source_director', 'destination_director']);
  assert.equal(dry.stays_attached.athletes, 1); assert.equal(dry.stays_attached.open_charges, 1);
  assert.equal(ok(await overview(a)).units.find((u) => u.id === pune.id).metrics.athletes, 1, 'a preview changes nothing');

  const t = await transfer(a, { object_type: 'cohort', object_ids: [a.cohort.id], to_unit_id: goa.id, note: 'Whole squad relocates for the new term', idempotency_key: 'transfer-key-0001' });
  assert.equal(t.status, 'in_progress');
  assert.equal(ok(await api('POST', `/organisations/${a.org.id}/transfers`, { token: a.owner.token, body: { object_type: 'cohort', object_ids: [a.cohort.id], to_unit_id: goa.id, reason_code: 'relocation', idempotency_key: 'transfer-key-0001' } }), 201).replayed, true);
  assert.equal(row(ok(await overview(a)), pune.id).metrics.athletes, 1, 'nothing moves while approvals are pending');
  const detail = ok(await api('GET', `/organisations/${a.org.id}/transfers/${t.transfer_id}`, { token: a.owner.token }));
  assert.equal(detail.note, 'Whole squad relocates for the new term');
  assert.ok(detail.steps.every((x) => x.can_act), 'both approvals sit in stage 1 and are open together');
  assert.equal((await pool.query('SELECT note_enc FROM org_transfers WHERE id=$1', [t.transfer_id])).rows[0].note_enc.includes('squad'), false, 'the note is stored encrypted');
  // an owner overriding must say why
  assert.equal((await api('POST', `/organisations/${a.org.id}/transfers/${t.transfer_id}/steps/${detail.steps[0].id}`, { token: a.owner.token, body: { decision: 'approve' } })).status, 400);
  const done = await approveAll(a, t.transfer_id);
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(await rows(), ids, 'enrolment and fee rows are identical');
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM org_staff_engagements WHERE user_id=$1', [a.coach.id])).rows), eng, 'the staff engagement is untouched');
  const o = ok(await overview(a));
  assert.equal(row(o, goa.id).metrics.athletes, 1); assert.equal(row(o, pune.id).metrics.athletes, 0);
  assert.equal(row(o, goa.id).metrics.money[0].overdue_minor, 500000, 'fees follow the athlete to the new campus');
  assert.equal(o.totals.athletes, 1, 'the consolidated total counts the athlete once');
  const links = (await pool.query("SELECT unit_id, effective_from::text AS f, effective_to::text AS t FROM org_unit_links WHERE object_type='cohort' AND object_id=$1 ORDER BY effective_from", [a.cohort.id])).rows;
  assert.equal(links.length, 2); assert.equal(links[0].t, today); assert.equal(links[1].t, null);
  assert.equal(row(ok(await overview(a, a.owner, `?as_of=${day(-10)}`)), pune.id).metrics.athletes, 1, 'history: last week the athlete was in Pune');
  assert.ok(ok(await api('GET', `/organisations/${a.org.id}/transfers/${t.transfer_id}`, { token: a.owner.token })).timeline.some((e) => e.action === 'transfer_completed'));

  // one athlete moves on his own (his link wins over the cohort's), back to Pune
  const one = await transfer(a, { object_type: 'enrolment', object_ids: [enrolment], to_unit_id: pune.id });
  assert.equal((await approveAll(a, one.transfer_id)).status, 'completed');
  const o2 = ok(await overview(a)); assert.equal(row(o2, pune.id).metrics.athletes, 1); assert.equal(row(o2, goa.id).metrics.athletes, 0);
  // the coach transfer carries the engagement count in its preview
  const sdry = ok(await api('POST', `/organisations/${a.org.id}/transfers`, { token: a.owner.token, body: { object_type: 'staff', object_ids: [a.coach.id], to_unit_id: goa.id, reason_code: 'relocation', dry_run: true } }), 201);
  assert.equal(sdry.stays_attached.engagements, 1);
  // a transfer is cancelled, and a completed one is rolled back through its change set
  const c2 = await transfer(a, { object_type: 'staff', object_ids: [a.coach.id], to_unit_id: goa.id });
  ok(await api('POST', `/organisations/${a.org.id}/transfers/${c2.transfer_id}/cancel`, { token: a.owner.token, body: { reason: 'Plans changed' } }));
  assert.equal((await api('POST', `/organisations/${a.org.id}/transfers/${c2.transfer_id}/cancel`, { token: a.owner.token, body: {} })).status, 409);
  assert.equal(row(ok(await overview(a)), pune.id).metrics.coaches, 1, 'the cancelled transfer moved nobody');
  const first = ok(await api('GET', `/organisations/${a.org.id}/transfers/${t.transfer_id}`, { token: a.owner.token }));
  const rb = ok(await api('POST', `/organisations/${a.org.id}/unit-changes/${first.change_id}/rollback`, { token: a.owner.token, body: { reason: 'Squad stays' } }));
  assert.equal(rb.rolled_back, true);
  assert.equal(row(ok(await overview(a)), pune.id).metrics.athletes, 1);
});

test('negative paths: wrong tenant, wrong object, wrong destination, past-dated clashes', async () => {
  const a = await academy(), b = await academy();
  const pune = await unit(a, { kind: 'campus', name: 'Pune' }), foot = await unit(a, { kind: 'department', name: 'Football', parent_id: pune.id, sport: 'football' });
  const mv = (body, who = a.owner) => api('POST', `/organisations/${a.org.id}/unit-moves`, { token: who.token, body });
  assert.equal((await mv({ to_unit_id: pune.id, items: [{ object_type: 'venue', object_ids: [b.venue.id] }] })).status, 400, 'another academy\'s venue cannot be placed');
  assert.equal((await mv({ to_unit_id: foot.id, items: [{ object_type: 'venue', object_ids: [a.venue.id] }] })).status, 400, 'a venue sits on a campus, not a department');
  assert.equal((await mv({ to_unit_id: pune.id, items: [{ object_type: 'venue', object_ids: [a.venue.id] }] }, a.outsider)).status, 404, 'outsiders learn nothing');
  assert.equal((await api('GET', `/organisations/${a.org.id}/campuses`, { token: a.outsider.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/campuses`, { token: a.coach.token })).status, 404, 'a plain member without a campus role has no campus view');
  assert.equal((await mv({ to_unit_id: pune.id, items: [{ object_type: 'venue', object_ids: [a.venue.id] }], effective_on: day(-400) })).status, 400, 'cannot start before the unit existed');
  ok(await mv({ to_unit_id: pune.id, items: [{ object_type: 'venue', object_ids: [a.venue.id] }] }), 201);
  const goa = await unit(a, { kind: 'campus', name: 'Goa' });
  assert.equal((await mv({ to_unit_id: goa.id, items: [{ object_type: 'venue', object_ids: [a.venue.id] }], effective_on: day(-1) })).status, 409, 'cannot back-date before the current link began');
  assert.equal((await api('POST', `/organisations/${a.org.id}/units`, { token: a.coach.token, body: { kind: 'campus', name: 'Sneaky' } })).status, 404);
  assert.equal((await api('POST', `/organisations/${a.org.id}/units`, { token: a.owner.token, body: { kind: 'campus', name: 'x' } })).status, 400);
});

test('branch-scoped access: a manager sees only their campus; a cross-campus admin sees all with attribution; revocation is immediate', async () => {
  const a = await academy();
  const pune = await unit(a, { kind: 'campus', name: 'Pune' }), goa = await unit(a, { kind: 'campus', name: 'Goa' });
  const goaVenue = ok(await api('POST', '/venues', { token: a.owner.token, body: { name: 'Goa Beach Arena', city: 'Goa', timezone: 'UTC', currency: 'INR' } }), 201);
  ok(await api('POST', `/organisations/${a.org.id}/assets`, { token: a.owner.token, body: { kind: 'venue', asset_id: goaVenue.id } }));
  ok(await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: a.owner.token, body: { to_unit_id: pune.id, items: [{ object_type: 'venue', object_ids: [a.venue.id] }, { object_type: 'cohort', object_ids: [a.cohort.id] }] } }), 201);
  ok(await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: a.owner.token, body: { to_unit_id: goa.id, items: [{ object_type: 'venue', object_ids: [goaVenue.id] }] } }), 201);

  const dir = await signup(), fin = await signup(), aud = await signup();
  for (const [u, role] of [[dir, 'staff'], [fin, 'staff'], [aud, 'staff']]) {
    ok(await api('POST', `/organisations/${a.org.id}/members`, { token: a.owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${a.org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  const grant = (u, unit_id, role, extra = {}) => api('POST', `/organisations/${a.org.id}/units/${unit_id}/roles`, { token: a.owner.token, body: { person: u.handle, role, ...extra } });
  const dirRole = ok(await grant(dir, pune.id, 'director'), 201);
  ok(await grant(fin, pune.id, 'finance'), 201); ok(await grant(aud, pune.id, 'auditor'), 201);
  assert.equal((await grant(a.outsider, pune.id, 'coach')).status, 400, 'not an active member');
  assert.equal((await grant(dir, pune.id, 'director')).status, 409, 'duplicates are refused');

  const md = ok(await overview(a, dir));
  assert.equal(md.scope.all, false); assert.equal(md.scope.partial, true);
  assert.deepEqual(md.units.map((u) => u.name), ['Pune']); assert.equal(md.totals.venues, 1, 'totals only cover what the manager may see');
  assert.equal(md.unassigned, null);
  assert.equal((await api('GET', `/organisations/${a.org.id}/units/${goa.id}`, { token: dir.token })).status, 404, 'another campus is not even acknowledged');
  const all = ok(await overview(a)); assert.equal(all.totals.venues, 2); assert.deepEqual(all.units.map((u) => [u.name, u.metrics.venues]).sort(), [['Goa', 1], ['Pune', 1]]);

  // finance sees money but no athlete names; auditor sees the trail but no money
  const fd = ok(await api('GET', `/organisations/${a.org.id}/units/${pune.id}`, { token: fin.token }));
  assert.equal(fd.people_visible, false); assert.ok(fd.assets.staff.every((s) => s.label === 'Restricted'));
  assert.ok(ok(await overview(a, fin)).units[0].metrics.money, 'finance sees fees');
  assert.equal(ok(await overview(a, aud)).units[0].metrics.money, undefined, 'auditor sees no money');
  assert.equal((await api('GET', `/organisations/${a.org.id}/campus-audit?unit_id=${pune.id}`, { token: fin.token })).status, 403);
  assert.ok(ok(await api('GET', `/organisations/${a.org.id}/campus-audit?unit_id=${pune.id}`, { token: aud.token })).length > 0);
  assert.equal((await api('PATCH', `/organisations/${a.org.id}/units/${pune.id}`, { token: aud.token, body: { name: 'Hack' } })).status, 403);

  // the director manages inside the branch only
  const kid = await signup();
  ok(await api('POST', `/organisations/${a.org.id}/members`, { token: a.owner.token, body: { person: kid.handle, role: 'staff' } }), 201); ok(await api('POST', `/organisations/${a.org.id}/invite/respond`, { token: kid.token, body: { accept: true } }));
  ok(await api('POST', `/organisations/${a.org.id}/units/${pune.id}/roles`, { token: dir.token, body: { person: kid.handle, role: 'coach' } }), 201);
  assert.equal((await api('POST', `/organisations/${a.org.id}/units/${pune.id}/roles`, { token: dir.token, body: { person: kid.handle, role: 'director' } })).status, 403, 'a director cannot appoint directors');
  assert.equal((await api('POST', `/organisations/${a.org.id}/units/${goa.id}/roles`, { token: dir.token, body: { person: kid.handle, role: 'coach' } })).status, 404);
  const dep = ok(await api('POST', `/organisations/${a.org.id}/units`, { token: dir.token, body: { kind: 'department', name: 'Tennis', parent_id: pune.id, sport: 'tennis' } }), 201);
  assert.equal(dep.parent_id, pune.id);
  assert.equal((await api('POST', `/organisations/${a.org.id}/units`, { token: dir.token, body: { kind: 'campus', name: 'Mine now' } })).status, 403);
  assert.equal((await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: dir.token, body: { to_unit_id: goa.id, items: [{ object_type: 'venue', object_ids: [a.venue.id] }] } })).status, 404, 'cannot send things to a branch they cannot see');
  assert.equal((await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: dir.token, body: { to_unit_id: pune.id, items: [{ object_type: 'venue', object_ids: [goaVenue.id] }] } })).status, 404, 'cannot pull things out of a branch they cannot see');

  // revocation is immediate
  ok(await api('DELETE', `/organisations/${a.org.id}/units/${pune.id}/roles/${dirRole.id}`, { token: a.owner.token }));
  assert.equal((await overview(a, dir)).status, 404);
  const list = ok(await api('GET', `/organisations/${a.org.id}/campus-audit`, { token: a.owner.token }));
  assert.ok(list.some((e) => e.action === 'role_ended') && list.some((e) => e.action === 'role_granted'));
});

test('policies inherit down the tree, can be overridden and cleared; values are typed', async () => {
  const a = await academy();
  const region = await unit(a, { kind: 'region', name: 'India', country: 'IN' });
  const pune = await unit(a, { kind: 'campus', name: 'Pune', parent_id: region.id });
  const dep = await unit(a, { kind: 'department', name: 'Cricket', parent_id: pune.id, sport: 'cricket' });
  const set = (unit_id, key, value) => api('POST', `/organisations/${a.org.id}/units/${unit_id}/policies`, { token: a.owner.token, body: { key, value } });
  ok(await set(region.id, 'currency', 'inr')); ok(await set(region.id, 'refund_window_days', 14));
  assert.equal((await set(region.id, 'attendance_min_pct', 140)).status, 400); assert.equal((await set(region.id, 'currency', 'ZZZ')).status, 400); assert.equal((await set(region.id, 'youth_pickup_required', 'yes')).status, 400);
  let eff = ok(await api('GET', `/organisations/${a.org.id}/units/${dep.id}`, { token: a.owner.token })).policies;
  assert.deepEqual([eff.currency.value, eff.currency.inherited, eff.currency.from_name], ['INR', true, 'India']);
  ok(await set(pune.id, 'refund_window_days', 7));
  eff = ok(await api('GET', `/organisations/${a.org.id}/units/${dep.id}`, { token: a.owner.token })).policies;
  assert.deepEqual([eff.refund_window_days.value, eff.refund_window_days.from_name], [7, 'Pune']);
  ok(await api('DELETE', `/organisations/${a.org.id}/units/${pune.id}/policies/refund_window_days`, { token: a.owner.token }));
  eff = ok(await api('GET', `/organisations/${a.org.id}/units/${dep.id}`, { token: a.owner.token })).policies;
  assert.equal(eff.refund_window_days.value, 14);
  assert.equal((await api('DELETE', `/organisations/${a.org.id}/units/${pune.id}/policies/refund_window_days`, { token: a.owner.token })).status, 404);
  const trail = ok(await api('GET', `/organisations/${a.org.id}/campus-audit?action=policy_cleared`, { token: a.owner.token }));
  assert.equal(trail[0].detail.was, 7, 'the cleared value stays in the audit trail');
});

test('filters, picker search and region roll-up never double count', async () => {
  const a = await academy();
  const asia = await unit(a, { kind: 'region', name: 'Asia', country: 'IN' }), pune = await unit(a, { kind: 'campus', name: 'Pune', parent_id: asia.id });
  const foot = await unit(a, { kind: 'department', name: 'Football', parent_id: pune.id, sport: 'football' });
  ok(await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: a.owner.token, body: { to_unit_id: pune.id, items: [{ object_type: 'venue', object_ids: [a.venue.id] }] } }), 201);
  ok(await api('POST', `/organisations/${a.org.id}/unit-moves`, { token: a.owner.token, body: { to_unit_id: foot.id, items: [{ object_type: 'cohort', object_ids: [a.cohort.id] }] } }), 201);
  const o = ok(await overview(a));
  assert.equal(row(o, foot.id).metrics.athletes, 1); assert.equal(row(o, pune.id).metrics.athletes, 1); assert.equal(row(o, asia.id).metrics.athletes, 1); assert.equal(o.totals.athletes, 1);
  assert.deepEqual(ok(await overview(a, a.owner, '?kind=campus')).units.map((u) => u.name), ['Pune']);
  assert.deepEqual(ok(await overview(a, a.owner, `?region_id=${asia.id}&kind=department`)).units.map((u) => u.name), ['Football']);
  assert.deepEqual(o.countries, ['IN']); assert.deepEqual(o.sports, ['football']);
  const un = ok(await api('GET', `/organisations/${a.org.id}/campus-candidates?object_type=venue&unplaced_only=true`, { token: a.owner.token })); assert.equal(un.total, 0);
  const found = ok(await api('GET', `/organisations/${a.org.id}/campus-candidates?object_type=cohort&q=u12`, { token: a.owner.token })); assert.equal(found.total, 1); assert.equal(found.items[0].on[0].name, 'Football');
  assert.equal((await api('GET', `/organisations/${a.org.id}/campus-candidates?object_type=venue`, { token: a.outsider.token })).status, 404);
});

test('MCP and OpenAPI expose every campus capability from the one definition', async () => {
  const names = capabilities.filter((c) => c.tag === 'Campuses').map((c) => c.name);
  for (const want of ['get_campus_overview', 'get_org_unit', 'create_org_unit', 'update_org_unit', 'move_org_unit_objects', 'list_org_unit_changes', 'rollback_org_unit_change', 'adopt_single_campus', 'grant_org_unit_role', 'end_org_unit_role', 'set_org_unit_policy', 'clear_org_unit_policy', 'list_org_unit_audit', 'list_org_unit_candidates']) assert.ok(names.includes(want), want);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(spec.paths['/organisations/{id}/campuses'], 'in OpenAPI');
  assert.ok(spec.paths['/organisations/{id}/unit-moves']);
  const owner = await signup(['venue_manager']);
  const tools = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const text = await tools.text();
  assert.ok(text.includes('get_campus_overview') && text.includes('move_org_unit_objects'), 'in MCP tools/list');
});
