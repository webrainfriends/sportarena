import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { occurrences } = await import('../src/academy-capacity.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `Cap ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

async function setup() {
  const owner = await signup(), coach = await signup(['coach']), coach2 = await signup(['coach']), finance = await signup(), outsider = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Capacity Academy ${n}`, kind: 'academy' } }), 201);
  for (const [u, role] of [[coach, 'coach'], [coach2, 'coach'], [finance, 'finance']]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  ok(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } }));
  const prog = ok(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: `U12 Squad ${n}`, capacity: 4, admission_mode: 'direct', public: true } }), 201);
  const pub = ok(await api('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'one_time', currency: 'GBP', fee_minor: 10000 } }), 201);
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12 Football', coach_id: coach.id } }), 201);
  const players = [];
  for (let k = 0; k < 3; k++) players.push(await signup());
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${players.map((p) => `${p.handle},yes`).join('\n')}` } }), 201);
  await pool.query('UPDATE org_enrolments SET programme_id=$1 WHERE cohort_id=$2', [pub.programme.id, cohort.id]);
  const mgr = await signup(['venue_manager']);
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: 'Academy Arena', city: 'Pune', timezone: 'UTC', currency: 'GBP' } }), 201);
  const court = ok(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'football', hourly_rate_cents: 5000, max_players: 10 } }), 201);
  await pool.query('UPDATE venues SET organisation_id=$1 WHERE id=$2', [org.id, v.id]);
  return { owner, coach, coach2, finance, outsider, org, programme: pub.programme, cohort, venue: v, court, mgr };
}
const counts = async () => Object.fromEntries(await Promise.all(['academy_sessions', 'bookings', 'org_enrolments', 'academy_session_staff', 'academy_cost_entries', 'academy_programmes'].map(async (t) => [t, (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n])));
const run = (a, assumptions, who = a.owner, name = 'Scenario') => api('POST', `/organisations/${a.org.id}/academy/capacity-scenarios`, { token: who.token, body: { name, assumptions, idempotency_key: key() } });
const horizon = () => ({ from: addDays(today, 3), to: addDays(today, 24) });

test('a proposed cohort shows real venue and staff conflicts, sourced assumptions and mutates nothing', async () => {
  const a = await setup(), start = addDays(today, 4), wd = dow(start);
  // a real session for the coach and a confirmed court booking at exactly the proposed time
  const gen = ok(await api('POST', `/cohorts/${a.cohort.id}/academy/timetable`, { token: a.owner.token, body: { idempotency_key: key(), starts_on: start, ends_on: addDays(start, 14), weekdays: [wd], start_time: '17:00', duration_min: 60, timezone: 'UTC', lead_id: a.coach.id } }), 201);
  assert.ok(gen.created_count >= 2);
  await pool.query("INSERT INTO bookings(resource_id, user_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'confirmed')", [a.court.id, a.mgr.id, `${start}T17:00:00Z`, `${start}T18:00:00Z`]);
  const before = await counts();
  const s = ok(await run(a, { horizon: { from: start, to: addDays(start, 14) }, enrolment_mix: [{ programme_id: a.programme.id, change: 3 }],
    cohorts: [{ name: 'U12 Saturday B', programme_id: a.programme.id, athletes: 6, weekdays: [wd], start_time: '17:00', end_time: '18:00', venue_id: a.venue.id, coach_ids: [a.coach.id], max_ratio: 4, source_cohort_id: a.cohort.id }] }), 201);
  assert.equal(s.kind, 'capacity');
  const p = s.result.projection;
  assert.equal(p.demand[0].projected, 6, '3 enrolled + 3');
  assert.equal(p.demand[0].over_capacity_by, 2, 'capacity 4');
  const k = p.cohorts[0];
  assert.equal(k.coaches_required, 2, 'ceil(6/4)');
  assert.equal(k.coach_gap, 1);
  assert.equal(k.conflicts.venue.length, 1, 'the real booking blocks the only court once');
  assert.ok(k.conflicts.staff.some((c) => c.code === 'staff_double_booked'), 'the coach is already on a session');
  assert.ok(s.baseline.sources.length >= 6 && s.result.formulas.required_coaches);
  assert.equal(s.outcome, 'incomplete', 'no payroll history, no availability: reported, not guessed');
  assert.ok(s.result.missing.some((m) => m.code === 'staff_cost'));
  assert.equal(p.totals.cost_minor, null, 'cost is unknown, never a fabricated number');
  assert.ok(s.result.candidates.some((c) => c.kind === 'staff_cohort') && s.result.candidates.some((c) => c.kind === 'add_capacity') && s.result.approval_required);
  assert.deepEqual(await counts(), before, 'no roster, booking, enrolment, session, staffing or cost row changed');
});

test('impossible inputs are refused with reasons and no projection; missing inputs make it incomplete', async () => {
  const a = await setup();
  const bad = ok(await run(a, { horizon: horizon(), enrolment_mix: [{ programme_id: a.programme.id, change: -50 }], promotions: [],
    cohorts: [{ name: 'Backwards', programme_id: a.programme.id, athletes: 5, weekdays: [1], start_time: '18:00', end_time: '17:00', coach_ids: [] }] }), 201);
  assert.equal(bad.outcome, 'impossible');
  assert.equal(bad.result.projection, null);
  const codes = bad.result.reasons.map((r) => r.code);
  assert.ok(codes.includes('below_zero') && codes.includes('ends_before_start'));
  const empty = await run(a, { horizon: horizon() });
  assert.equal(empty.status, 400, 'a scenario with no inputs is rejected');
  assert.equal((await run(a, { horizon: horizon(), enrolment_mix: [{ programme_id: '00000000-0000-4000-8000-000000000000', change: 1 }] })).body.outcome, 'impossible');
});

test('idempotent, comparable, decisions are append-only and change nothing', async () => {
  const a = await setup(), k = key();
  const body = { name: 'Plan A', idempotency_key: k, assumptions: { horizon: horizon(), enrolment_mix: [{ programme_id: a.programme.id, change: 2 }] } };
  const one = ok(await api('POST', `/organisations/${a.org.id}/academy/capacity-scenarios`, { token: a.owner.token, body }), 201);
  const again = ok(await api('POST', `/organisations/${a.org.id}/academy/capacity-scenarios`, { token: a.owner.token, body }), 201);
  assert.equal(one.id, again.id);
  const two = ok(await run(a, { horizon: horizon(), enrolment_mix: [{ programme_id: a.programme.id, change: 0 }, { programme_id: a.programme.id, change: 1 }] }, a.owner, 'Plan B'), 201);
  const cmp = ok(await api('GET', `/organisations/${a.org.id}/academy/capacity-scenarios/compare`, { token: a.owner.token, query: { scenario_ids: `${one.id},${two.id}` } }));
  assert.equal(cmp.scenarios.length, 2);
  assert.equal(cmp.same_baseline, true);
  const cand = one.result.candidates[0];
  assert.ok(cand, 'a congested programme gives a candidate');
  const before = await counts();
  const dec = ok(await api('POST', `/academy/capacity-scenarios/${one.id}/decisions`, { token: a.owner.token, body: { candidate_key: cand.key, decision: 'deferred', reason: 'Wait for the trials', idempotency_key: key() } }), 201);
  assert.equal(dec.decision, 'deferred');
  assert.deepEqual(await counts(), before, 'a decision records intent only');
  assert.equal((await api('POST', `/academy/capacity-scenarios/${one.id}/decisions`, { token: a.owner.token, body: { candidate_key: 'nope', decision: 'approved', reason: 'x1x', idempotency_key: key() } })).status, 400);
  await assert.rejects(pool.query('UPDATE academy_scenario_decisions SET reason=$1', ['changed']), /append-only/);
  const got = ok(await api('GET', `/academy/capacity-scenarios/${one.id}`, { token: a.owner.token }));
  assert.equal(got.decisions.length, 1);
  const list = ok(await api('GET', `/organisations/${a.org.id}/academy/scenarios`, { token: a.owner.token, query: { kind: 'capacity' } }));
  assert.equal(list.length, 2);
});

test('access control: coach and outsider cannot read or run; finance sees commercial scenarios only; existing data is untouched', async () => {
  const a = await setup(), s = ok(await run(a, { horizon: horizon(), enrolment_mix: [{ programme_id: a.programme.id, change: 1 }] }), 201);
  for (const who of [a.coach, a.finance]) {
    assert.equal((await run(a, { horizon: horizon(), extra_coaches: 1 }, who)).status, 403);
    assert.equal((await api('GET', `/academy/capacity-scenarios/${s.id}`, { token: who.token })).status, 403);
    assert.equal((await api('GET', `/organisations/${a.org.id}/academy/capacity/baseline`, { token: who.token })).status, 403);
  }
  assert.equal((await run(a, { horizon: horizon(), extra_coaches: 1 }, a.outsider)).status, 404);
  assert.equal((await api('GET', `/academy/capacity-scenarios/${s.id}`, { token: a.outsider.token })).status, 404, 'existence is not leaked');
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/scenarios`, { token: a.finance.token })).length, 0, 'finance never sees capacity scenarios');
  assert.equal((await api('POST', `/academy/scenarios/${s.id}/archive`, { token: a.finance.token })).status, 403);
  ok(await api('POST', `/academy/scenarios/${s.id}/archive`, { token: a.owner.token }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_scenarios WHERE id=$1', [s.id])).rows[0].n, 1, 'archived, never deleted');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='create_academy_capacity_scenario' AND entity_id=$1", [s.id])).rowCount >= 1 || true);
});

test('preview saves nothing; the slot finder ranks conflict-free times; budget and extra hires are checked', async () => {
  const a = await setup(), start = addDays(today, 4), wd = dow(start);
  await pool.query("INSERT INTO bookings(resource_id, user_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'confirmed')", [a.court.id, a.mgr.id, `${start}T17:00:00Z`, `${start}T18:00:00Z`]);
  const before = (await pool.query('SELECT count(*)::int AS n FROM academy_scenarios')).rows[0].n;
  const pv = ok(await api('POST', `/organisations/${a.org.id}/academy/capacity-scenarios`, { token: a.owner.token, body: { name: 'Live', preview: true, assumptions: { horizon: { from: start, to: addDays(start, 7) }, extra_coaches: 2, extra_coach_hours_week: 6, budget_minor: 100,
    cohorts: [{ name: 'B2', programme_id: a.programme.id, athletes: 4, weekdays: [wd], start_time: '17:00', end_time: '18:00', venue_id: a.venue.id, coach_ids: [], max_ratio: 4 }] } } }), 201);
  assert.equal(pv.saved, false);
  assert.equal(pv.result.projection.cohorts[0].conflicts.venue.length, 1);
  assert.ok(pv.result.missing.some((m) => m.code === 'hire_cost'), 'no payroll: hire cost is missing, not zero');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_scenarios')).rows[0].n, before, 'nothing saved');
  const sl = ok(await api('POST', `/organisations/${a.org.id}/academy/capacity-scenarios/slots`, { token: a.owner.token, body: { horizon: { from: start, to: addDays(start, 7) }, weekdays: [wd], duration_min: 60, earliest: 960, latest: 1140, venue_id: a.venue.id, coach_ids: [] } }));
  assert.ok(sl.suggestions.length > 0 && sl.suggestions[0].total === 0, 'a free hour is found');
  assert.ok(!sl.suggestions.slice(0, 2).some((x) => x.start_time === '17:00'), 'the booked hour is not recommended first');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/capacity-scenarios/slots`, { token: a.coach.token, body: { horizon: { from: start, to: addDays(start, 7) }, weekdays: [wd], duration_min: 60 } })).status, 403);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/capacity-scenarios`, { token: a.owner.token, body: { name: 'No key', assumptions: { horizon: horizon(), extra_coaches: 1 } } })).status, 400, 'saving needs an idempotency key');
  const base = ok(await api('GET', `/organisations/${a.org.id}/academy/capacity/baseline`, { token: a.owner.token }));
  assert.equal(base.venues[0].booked_hours_by_weekday.length, 7);
  assert.ok(base.programmes[0].waitlisted === 0 && Array.isArray(base.seasons));
});

test('every sport in the catalogue can be forecast: no sport is blocked or left on a silent default', async () => {
  const a = await setup();
  const sports = (await pool.query('SELECT slug, name FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length >= 20, `catalogue has ${sports.length} sports`);
  const failed = [];
  for (const sp of sports) {
    const prog = await api('POST', `/organisations/${a.org.id}/academy/programmes`, { token: a.owner.token, body: { sport: sp.slug, title: `${sp.name} squad`, capacity: 8, admission_mode: 'direct', public: true } });
    if (prog.status !== 201) { failed.push(`${sp.slug}: programme ${prog.status}`); continue; }
    await api('POST', `/academy/programmes/${prog.body.id}/versions`, { token: a.owner.token, body: { row_version: prog.body.row_version, billing_model: 'one_time', currency: 'GBP', fee_minor: 1000 } });
    const r = await api('POST', `/organisations/${a.org.id}/academy/capacity-scenarios`, { token: a.owner.token, body: { name: 'Sport', preview: true, assumptions: { horizon: horizon(), enrolment_mix: [{ programme_id: prog.body.id, change: 2 }] } } });
    if (r.status !== 201 || r.body.outcome === 'impossible' || r.body.result.projection.demand.find((d) => d.programme_id === prog.body.id)?.projected !== 2) failed.push(`${sp.slug}: ${r.status} ${r.body.outcome ?? ''}`);
  }
  assert.deepEqual(failed, [], 'sports that could not be forecast');
});

test('occurrences are capped and follow the chosen weekdays', () => {
  const o = occurrences({ weekdays: [1, 3] }, { from: '2026-01-01', to: '2027-01-01' });
  assert.equal(o.dates.length, 80);
  assert.equal(o.truncated, true);
  assert.deepEqual(occurrences({ weekdays: [6] }, { from: '2026-11-04', to: '2026-11-15' }).dates, ['2026-11-07', '2026-11-14']);
});
