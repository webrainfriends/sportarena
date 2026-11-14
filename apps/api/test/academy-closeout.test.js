// Academy OS 3/3 close-out (#395): P&L now reads approved payroll and confirmed venue bookings, delivery signals come from Academy OS 2/3
// sessions, programmes group into branches. Reconciliation, supersession, isolation and "missing is not zero" are asserted against real tables.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const must = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const today = new Date().toISOString().slice(0, 10);
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const dob = new Date(Date.now() - 30 * 365.25 * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cl_${n}_${roles[0]}`, display_name: `Cl ${n}`, email: `cl${n}@example.com`, password: 'correct-horse-battery', roles, dob } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An academy with an owner, finance and a coach, one published programme and one cohort linked to it. */
async function academy(title = 'U12 Football') {
  const owner = await signup(), finance = await signup(), coach = await signup(['coach']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Closeout ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'INR', listed: true } }));
  for (const [u, role] of [[finance, 'finance'], [coach, 'coach']]) {
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title, capacity: 20, admission_mode: 'direct', public: true } }), 201);
  const cohort = must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `${title} cohort`, coach_id: coach.id } }), 201);
  await pool.query('UPDATE org_cohorts SET programme_id=$2 WHERE id=$1', [cohort.id, prog.id]);
  return { owner, finance, coach, org, programme: prog, cohort };
}
const session = async (a, { status = 'published', day = today, hour = 10, programme = a.programme } = {}) => (await pool.query(
  `INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, title, starts_at, ends_at, status, created_by)
   VALUES ($1,$2,$3,'Training', ($4::date + make_interval(hours => $5)) AT TIME ZONE 'UTC', ($4::date + make_interval(hours => $5 + 1)) AT TIME ZONE 'UTC', $6, $7) RETURNING *`,
  [a.org.id, a.cohort.id, programme.id, day, hour, status, a.owner.id])).rows[0];
/** A venue + court priced per hour in INR, and a booking of it for a session through the canonical engine. */
async function court(rate = 50000) {
  const mgr = await signup(['venue_manager']);
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Arena ${++n}`, city: 'Pune', timezone: 'UTC', currency: 'INR' } }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: mgr.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '00:00', closes: '23:59' })) } }));
  const res = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court A', sport: 'football', hourly_rate_cents: rate, max_players: 10 } }), 201);
  return { mgr, venue: v, resource: res };
}
/** An approved payroll run (the canonical shape written by the payroll capability) with one line per timesheet. */
async function approvedRun(a, { currency = 'INR', sheets, status = 'approved', unpriced = [] }) {
  const run = (await pool.query("INSERT INTO academy_payroll_runs(organisation_id, currency, period_start, period_end, idempotency_key, unpriced, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [a.org.id, currency, addDays(today, -10), addDays(today, 10), key(), JSON.stringify(unpriced), a.finance.id])).rows[0];
  const detail = sheets.map((s) => ({ timesheet_id: s.id, work_date: s.work_date, amount_minor: s.amount }));
  const total = sheets.reduce((x, s) => x + s.amount, 0);
  const line = (await pool.query("INSERT INTO academy_payroll_lines(run_id, user_id, base_minor, gross_minor, detail) VALUES ($1,$2,$3,$3,$4) RETURNING *", [run.id, a.coach.id, total, JSON.stringify(detail)])).rows[0];
  await pool.query('UPDATE academy_payroll_runs SET total_minor=$2 WHERE id=$1', [run.id, total]);
  for (const s of sheets) await pool.query("UPDATE academy_timesheets SET payroll_run_id=$2 WHERE id=$1", [s.id, run.id]);
  if (status !== 'draft') await pool.query("UPDATE academy_payroll_runs SET status=$2, approved_at=now(), approved_by=$3 WHERE id=$1", [run.id, status, a.finance.id]);
  return { run, line };
}
const sheet = async (a, sess, amount, programmeId = a.programme.id) => {
  const t = (await pool.query("INSERT INTO academy_timesheets(organisation_id, user_id, session_id, work_date, minutes, status, programme_id) VALUES ($1,$2,$3,$4,60,'approved',$5) RETURNING *", [a.org.id, a.coach.id, sess?.id ?? null, today, programmeId])).rows[0];
  return { id: t.id, work_date: today, amount };
};
const pnl = async (a, who = a.finance, q = '') => must(await api('GET', `/organisations/${a.org.id}/academy/pnl?from=${addDays(today, -30)}&to=${addDays(today, 30)}${q}`, { token: who.token }));
const inr = (r) => r.currencies.find((c) => c.currency === 'INR');

test('staff cost is read from APPROVED payroll only, attributed by timesheet programme; drafts and unpriced are never counted as cost', async () => {
  const a = await academy();
  const s1 = await session(a), s2 = await session(a, { hour: 12 });
  const t1 = await sheet(a, s1, 600000), t2 = await sheet(a, s2, 400000);
  await approvedRun(a, { sheets: [t1], status: 'draft' });
  assert.equal((await pnl(a)).currencies.length, 0, 'a draft payroll run is not cost yet');

  const { run, line } = await approvedRun(a, { sheets: [t2], unpriced: [{ timesheet_id: '00000000-0000-0000-0000-000000000000', reason: 'no compensation term' }] });
  const p = await pnl(a);
  const row = inr(p).programmes[0];
  assert.equal(row.staff_cost_minor, 400000, 'only the approved run');
  assert.equal(row.sources.payroll_lines, 1);
  assert.equal(p.cost_sources.payroll_unpriced_timesheets, 1, 'an unpriced timesheet is reported as missing, not zero');
  assert.equal(inr(p).totals.staff_cost_minor, 400000);

  // drill-down lists the payroll line as its canonical source
  const lines = must(await api('GET', `/organisations/${a.org.id}/academy/pnl/lines?programme_id=${a.programme.id}&currency=INR&from=${addDays(today, -30)}&to=${addDays(today, 30)}`, { token: a.finance.token }));
  assert.ok(lines.canonical_costs.some((c) => c.source_type === 'academy_payroll_line' && c.source_id === line.id && c.amount_minor === 400000 && c.payroll_run_id === run.id));
});

test('timesheets with no programme and pay adjustments stay visible as unattributed staff cost, deducted from the organisation result only', async () => {
  const a = await academy();
  const t = await sheet(a, null, 250000, null);
  await approvedRun(a, { sheets: [t] });
  const p = await pnl(a);
  assert.equal(inr(p).totals.unattributed_cost_minor, 250000);
  assert.equal(inr(p).totals.operating_result_minor, -250000, 'the cost is real and reduces the organisation result');
  assert.equal(inr(p).programmes.length, 0, 'it is not silently pushed into a programme');
  const filtered = await pnl(a, a.finance, `&programme_id=${a.programme.id}`);
  assert.equal(filtered.currencies.length, 0);
});

test('venue cost is the confirmed booking line split exactly across the sessions sharing it; cancelled and unbooked sessions are not guessed', async () => {
  const a = await academy();
  const c = await court(50001); // odd price so the split has a remainder
  const day = addDays(today, 2);
  const s1 = await session(a, { day }), s2 = await session(a, { day, hour: 14 }), unbooked = await session(a, { day, hour: 16 });
  must(await api('POST', `/academy/sessions/${s1.id}/venue`, { token: a.owner.token, body: { resource_id: c.resource.id } }), 201);
  must(await api('POST', `/academy/sessions/${s2.id}/venue`, { token: a.owner.token, body: { resource_id: c.resource.id } }), 201);
  const p = await pnl(a);
  const row = inr(p).programmes[0];
  assert.equal(row.venue_cost_minor, 100002, 'each session books one hour at 50001');
  assert.equal(row.sources.venue_bookings, 2);
  assert.equal(row.venue_sessions_unbooked, 1, 'the session with no booking is flagged');
  assert.equal(p.cost_sources.venue_sessions_unbooked, 1);
  assert.equal(unbooked.status, 'published');

  // sharing one booking line: two sessions on the same line must add back to the booking price exactly
  const { venueCost } = await import('../src/academy-cost-sources.js');
  const live = await venueCost(a.org.id, addDays(today, -30), addDays(today, 30));
  const byBooking = new Map();
  for (const r of live.rows) byBooking.set(r.source_id, (byBooking.get(r.source_id) ?? 0) + r.amount_minor);
  const prices = (await pool.query('SELECT id, price_cents FROM bookings WHERE id = ANY($1::uuid[])', [[...byBooking.keys()]])).rows;
  for (const b of prices) assert.equal(byBooking.get(b.id), Number(b.price_cents), 'shares reconcile to the booking price');

  // cancelling a session takes its cost out of the period
  await pool.query("UPDATE academy_sessions SET status='cancelled' WHERE id=$1", [s2.id]);
  assert.equal(inr(await pnl(a)).programmes[0].venue_cost_minor, 50001);
});

test('a canonical source replaces manual cost entries for the same programme and category so nothing is double counted; other categories stay manual', async () => {
  const a = await academy();
  const t = await sheet(a, null, 300000);
  const manual = async (category, amount) => must(await api('POST', `/organisations/${a.org.id}/academy/cost-entries`, { token: a.finance.token, body: { category, programme_id: a.programme.id, currency: 'INR', amount_minor: amount, incurred_on: today, description: `manual ${category}`, idempotency_key: key() } }), 201);
  const staffEntry = await manual('staff', 999999), other = await manual('other_direct', 70000);
  assert.equal(inr(await pnl(a)).programmes[0].staff_cost_minor, 999999, 'before payroll exists the manual entry stands');
  await approvedRun(a, { sheets: [t] });
  const p = await pnl(a);
  const row = inr(p).programmes[0];
  assert.equal(row.staff_cost_minor, 300000, 'payroll wins');
  assert.equal(row.other_direct_cost_minor, 70000, 'a category with no canonical source stays manual');
  assert.equal(p.cost_sources.manual_entries_superseded, 1);
  const lines = must(await api('GET', `/organisations/${a.org.id}/academy/pnl/lines?programme_id=${a.programme.id}&currency=INR&from=${addDays(today, -30)}&to=${addDays(today, 30)}`, { token: a.finance.token }));
  const flagged = lines.cost_entries.find((c) => c.source_id === staffEntry.id);
  assert.equal(flagged.superseded_by_canonical, true, 'the set-aside entry stays visible');
  assert.equal(lines.cost_entries.find((c) => c.source_id === other.id).superseded_by_canonical, false);
});

test('currencies are never summed: INR payroll and a USD run produce separate blocks', async () => {
  const a = await academy();
  await approvedRun(a, { sheets: [await sheet(a, null, 100000, null)] });
  await approvedRun(a, { currency: 'USD', sheets: [await sheet(a, null, 5000, null)] });
  const p = await pnl(a);
  assert.deepEqual(p.currencies.map((c) => [c.currency, c.totals.unattributed_cost_minor]), [['INR', 100000], ['USD', 5000]]);
});

test('branches: owner-managed, org-isolated, archived not deleted; P&L by branch is the exact sum of its programmes with an explicit Unassigned group', async () => {
  const a = await academy('U12 Football'), b = await academy('Other Academy Programme');
  const p2 = must(await api('POST', `/organisations/${a.org.id}/academy/programmes`, { token: a.owner.token, body: { sport: 'football', title: 'U16 Football', capacity: 20, admission_mode: 'direct', public: true } }), 201);
  const c = await court();
  const north = must(await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'North', city: 'Pune', venue_ids: [c.venue.id], idempotency_key: key() } }), 201);
  const k = key();
  const again = await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'South', idempotency_key: k } });
  assert.equal(again.status, 201);
  assert.equal(must(await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'South', idempotency_key: k } }), 201).id, again.body.id, 'idempotent');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'north', idempotency_key: key() } })).status, 409, 'names are unique among live branches');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.finance.token, body: { name: 'Finance Branch', idempotency_key: key() } })).status, 403, 'finance can read branches, not manage them');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.coach.token, body: { name: 'Coach Branch', idempotency_key: key() } })).status, 403);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'Ghost venue', venue_ids: ['00000000-0000-0000-0000-000000000000'], idempotency_key: key() } })).status, 400);
  // another academy cannot see, edit or use it: existence is not leaked
  assert.equal((await api('POST', `/academy/branches/${north.id}`, { token: b.owner.token, body: { name: 'Stolen' } })).status, 404);
  assert.equal((await api('POST', `/academy/programmes/${b.programme.id}/branch`, { token: b.owner.token, body: { branch_id: north.id } })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/branches`, { token: b.owner.token })).status, 404);

  must(await api('POST', `/academy/programmes/${a.programme.id}/branch`, { token: a.owner.token, body: { branch_id: north.id } }));
  // two programmes with cost in the same currency: one in North, one unassigned
  await approvedRun(a, { sheets: [await sheet(a, null, 100000)] });
  await pool.query("INSERT INTO academy_cost_entries(organisation_id, category, programme_id, currency, amount_minor, incurred_on, description, created_by) VALUES ($1,'staff',$2,'INR',40000,$3,'manual staff',$4)", [a.org.id, p2.id, today, a.owner.id]);
  const p = inr(await pnl(a));
  const total = p.programmes.reduce((s, r) => s + r.operating_result_minor, 0);
  assert.equal(p.by_branch.reduce((s, x) => s + x.operating_result_minor, 0), total, 'branches reconcile to the programme rows');
  assert.deepEqual(p.by_branch.map((x) => x.name), ['North', 'Unassigned']);
  const only = inr(await pnl(a, a.finance, `&branch_id=${north.id}`));
  assert.equal(only.programmes.length, 1);
  assert.equal(only.programmes[0].programme_id, a.programme.id);

  // the executive home carries the same grouping and the unattributed amount
  const home = must(await api('GET', `/organisations/${a.org.id}/academy/executive`, { token: a.owner.token }));
  assert.ok(home.finance.currencies[0].by_branch.length === 2);

  // archive keeps the data and the programme's grouping; it cannot take new programmes
  must(await api('POST', `/academy/branches/${north.id}/archive`, { token: a.owner.token }));
  assert.equal(must(await api('POST', `/academy/branches/${north.id}/archive`, { token: a.owner.token })).id, north.id, 'archiving twice is a no-op');
  assert.equal((await api('POST', `/academy/programmes/${p2.id}/branch`, { token: a.owner.token, body: { branch_id: north.id } })).status, 409);
  const list = must(await api('GET', `/organisations/${a.org.id}/academy/branches`, { token: a.finance.token }));
  const nb = list.branches.find((x) => x.id === north.id);
  assert.ok(nb.archived_at && nb.programmes.length === 1 && nb.venues.length === 1);
  assert.equal(list.unassigned_programmes.some((x) => x.id === p2.id), true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_branches WHERE id=$1', [north.id])).rows[0].n, 1, 'nothing is deleted');
});

test('executive home delivery reads Academy OS 2/3 sessions: cancelled, completed and staffing exceptions; missing is not zero elsewhere', async () => {
  const a = await academy();
  await session(a, { status: 'completed', day: addDays(today, -3) });
  await session(a, { status: 'cancelled', day: addDays(today, -2) });
  await session(a, { status: 'published', day: addDays(today, -1), hour: 9 });
  const home = must(await api('GET', `/organisations/${a.org.id}/academy/executive?from=${addDays(today, -10)}&to=${today}`, { token: a.owner.token }));
  const d = home.delivery;
  assert.equal(d.sessions_cancelled, 1); assert.equal(d.sessions_completed, 1); assert.equal(d.sessions_scheduled, 2);
  assert.equal(d.cancellation_rate_pct, 33.3);
  assert.equal(d.staffing_exceptions, 2, 'both non-cancelled sessions have no lead coach under the configured minimum');
  assert.equal(d.link.tab, 'ops');
  // the ops board and the home agree because they share one implementation
  const ops = must(await api('GET', `/organisations/${a.org.id}/academy/analytics?from=${addDays(today, -10)}&to=${today}`, { token: a.owner.token }));
  assert.equal(ops.staffing_exceptions.length, d.staffing_exceptions);
});

// ------------------------------------------------------------------ decision follow-through
async function decided(a, decision, { enrolmentStatus = 'graduated' } = {}) {
  const ath = await signup();
  const e = (await pool.query("INSERT INTO org_enrolments(cohort_id, user_id, status, programme_id, consent_at, enrolled_by) VALUES ($1,$2,$3,$4,now(),$5) RETURNING *", [a.cohort.id, ath.id, enrolmentStatus, a.programme.id, a.owner.id])).rows[0];
  const pw = (await pool.query("INSERT INTO academy_pathways(organisation_id, sport, title, status, current_version, created_by) VALUES ($1,'football','Pathway','active',1,$2) RETURNING *", [a.org.id, a.owner.id])).rows[0];
  const v = (await pool.query("INSERT INTO academy_pathway_versions(pathway_id, version, levels, created_by) VALUES ($1,1,'[]',$2) RETURNING *", [pw.id, a.owner.id])).rows[0];
  const d = (await pool.query("INSERT INTO academy_progression_decisions(organisation_id, athlete_id, pathway_id, version_id, decision, from_level, to_level, reason, decided_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,'a','a','because',$6,$7) RETURNING *", [a.org.id, ath.id, pw.id, v.id, decision, a.owner.id, key()])).rows[0];
  return { ath, enrolment: e, decision: d };
}
const follow = (a, d, body, who = a.owner) => api('POST', `/academy/decisions/${d.id}/follow-through`, { token: who.token, body });

test('follow-through: a graduation issues the canonical certificate once; the action must match the decision; coaches cannot trigger it', async () => {
  const a = await academy();
  const g = await decided(a, 'graduate');
  assert.equal((await follow(a, g.decision, { action: 'invite_squad', team_id: '00000000-0000-0000-0000-000000000000' })).status, 409, 'a squad invite does not follow a graduation');
  assert.equal((await follow(a, g.decision, { action: 'issue_certificate', enrolment_id: g.enrolment.id }, a.coach)).status, 403, 'coaches recommend, admissions staff carry out');
  const other = await academy('Other');
  const stranger = await decided(other, 'graduate');
  assert.equal((await follow(a, g.decision, { action: 'issue_certificate', enrolment_id: stranger.enrolment.id })).status, 400, 'not this athlete\'s enrolment');
  const first = must(await follow(a, g.decision, { action: 'issue_certificate', enrolment_id: g.enrolment.id, title: 'U12 Graduate' }), 201);
  assert.equal(first.target_type, 'credential');
  const again = must(await follow(a, g.decision, { action: 'issue_certificate', enrolment_id: g.enrolment.id, title: 'U12 Graduate' }), 201);
  assert.equal(again.replayed, true); assert.equal(again.target_id, first.target_id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM credentials WHERE enrolment_id=$1', [g.enrolment.id])).rows[0].n, 1, 'exactly one certificate, issued by the canonical flow');
  const both = await Promise.all([follow(a, (await decided(a, 'graduate')).decision, { action: 'issue_certificate', enrolment_id: g.enrolment.id }), follow(a, g.decision, { action: 'issue_certificate', enrolment_id: g.enrolment.id })]);
  assert.ok(both.every((r) => r.status === 201 || r.status === 400));
  const list = must(await api('GET', `/academy/decisions/${g.decision.id}/follow-ups`, { token: a.coach.token }));
  assert.deepEqual(list.map((x) => x.kind), ['issue_certificate']);
  await assert.rejects(pool.query('DELETE FROM academy_decision_follow_ups'), /append-only/);
});

test('follow-through: a squad invite goes through the canonical team invitation (pending acceptance); a cohort move uses the enrolment transfer', async () => {
  const a = await academy();
  const sq = await decided(a, 'invite_squad', { enrolmentStatus: 'enrolled' });
  const team = must(await api('POST', '/teams', { token: a.owner.token, body: { name: 'Academy Squad', sport: 'football' } }), 201);
  const r = must(await follow(a, sq.decision, { action: 'invite_squad', team_id: team.id }), 201);
  assert.equal(r.target_type, 'team_invitation');
  const m = (await pool.query('SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2', [team.id, sq.ath.id])).rows[0];
  assert.equal(m.status, 'invited', 'the athlete still has to accept; nothing joins automatically');

  const mv = await decided(a, 'move_programme', { enrolmentStatus: 'enrolled' });
  const to = must(await api('POST', `/organisations/${a.org.id}/cohorts`, { token: a.owner.token, body: { name: 'U14 cohort' } }), 201);
  await pool.query('UPDATE org_cohorts SET programme_id=$2 WHERE id=$1', [to.id, a.programme.id]);
  const moved = await follow(a, mv.decision, { action: 'move_cohort', enrolment_id: mv.enrolment.id, to_cohort_id: to.id, reason: 'Progressed' });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal((await pool.query('SELECT status FROM org_enrolments WHERE id=$1', [mv.enrolment.id])).rows[0].status, 'transferred', 'the canonical transfer ran; this feature did not rewrite the enrolment row');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_enrolments WHERE user_id=$1 AND cohort_id=$2 AND status=$3', [mv.ath.id, to.id, 'enrolled'])).rows[0].n, 1, 'the athlete now has a live enrolment in the new cohort');
  assert.equal((await follow(a, mv.decision, { action: 'move_cohort', enrolment_id: mv.enrolment.id, to_cohort_id: to.id })).body.replayed, true, 'a retry does not transfer twice');
});

// ------------------------------------------------------------------ PDF packs
const download = async (who, docId) => {
  const r = await fetch(`${base}/api/v1/branded-documents/${docId}/file`, { headers: { authorization: `Bearer ${who.token}` } });
  return { status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), bytes: Buffer.from(await r.arrayBuffer()) };
};
async function withProgress(a) {
  const g = await decided(a, 'promote', { enrolmentStatus: 'enrolled' });
  const rub = (await pool.query("INSERT INTO coaching_rubrics(coach_id, name) VALUES ($1,'Tech') RETURNING id", [a.coach.id])).rows[0];
  await pool.query("INSERT INTO coaching_observations(coach_id, athlete_id, note, visibility, obs_type) VALUES ($1,$2,'PRIVATE-COACH-NOTE-XYZ','coach_only','progress')", [a.coach.id, g.ath.id]).catch(() => {});
  void rub;
  return g;
}

test('progress report PDF: staff, the athlete\'s coach and the athlete may issue and download it; strangers get 404; identical content is one document; private notes never appear', async () => {
  const a = await academy();
  const g = await withProgress(a);
  const path = `/organisations/${a.org.id}/academy/athletes/${g.ath.id}/progress-report`;
  const made = must(await api('POST', path, { token: a.owner.token, body: {} }), 201);
  assert.equal(made.family, 'academy_progress_report');
  assert.equal(must(await api('POST', path, { token: a.owner.token, body: {} }), 201).id, made.id, 'a retry returns the same document');
  assert.equal(must(await api('POST', path, { token: a.owner.token, body: {} }), 201).duplicate, true);
  const pdf = await download(a.owner, made.id);
  assert.equal(pdf.status, 200); assert.match(pdf.type, /pdf/); assert.match(pdf.disposition, /attachment/); assert.equal(pdf.bytes.subarray(0, 4).toString(), '%PDF');
  must(await api('POST', path, { token: a.coach.token, body: {} }), 201);
  assert.equal((await download(g.ath, made.id)).status, 200, 'the athlete can open their own report');

  const stranger = await signup(), otherOrg = await academy('Elsewhere');
  assert.equal((await api('POST', path, { token: stranger.token, body: {} })).status, 404);
  assert.equal((await api('POST', path, { token: otherOrg.owner.token, body: {} })).status, 404, 'another academy cannot report on this athlete');
  assert.equal((await api('POST', path, { token: a.finance.token, body: {} })).status, 404, 'finance does not get coaching progress');
  assert.equal((await download(stranger, made.id)).status, 404);
  assert.equal((await download(a.finance, made.id)).status, 404);

  const { progressSnapshot } = await import('../src/capabilities/academy-packs.js');
  const snap = await progressSnapshot(a.org.id, g.ath.id);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('PRIVATE-COACH-NOTE-XYZ'), 'private coach notes are never printed');
  assert.ok(text.includes('never combined into one score'));
  assert.ok(!/amount|invoice|fee/i.test(snap.sections.map((s) => s.title).join(' ')), 'no fee sections');

  // access is re-checked on every download: remove the coach and they lose the file
  await pool.query("UPDATE org_cohorts SET coach_id=NULL WHERE id=$1", [a.cohort.id]);
  assert.equal((await api('POST', path, { token: a.coach.token, body: {} })).status, 404);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='generate_academy_progress_pdf'")).rows[0].n >= 1, true);
});

test('finance pack and management review PDFs: role-limited, per currency, never statutory, with cost gaps stated; downloads re-check the role live', async () => {
  const a = await academy();
  await approvedRun(a, { sheets: [await sheet(a, null, 120000, a.programme.id)], unpriced: [{ timesheet_id: '00000000-0000-0000-0000-000000000000', reason: 'no term' }] });
  const q = { from: addDays(today, -30), to: addDays(today, 30) };
  const fin = must(await api('POST', `/organisations/${a.org.id}/academy/finance-pack`, { token: a.finance.token, body: q }), 201);
  assert.equal(fin.family, 'academy_finance_pack');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/finance-pack`, { token: a.coach.token, body: q })).status, 403, 'coaches never get the finance pack');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/management-review`, { token: a.finance.token, body: q })).status, 403, 'finance does not get the people/outcomes review');
  const mgmt = must(await api('POST', `/organisations/${a.org.id}/academy/management-review`, { token: a.owner.token, body: q }), 201);
  assert.equal((await download(a.finance, fin.id)).status, 200);
  assert.equal((await download(a.owner, fin.id)).status, 200);
  assert.equal((await download(a.coach, fin.id)).status, 404);
  assert.equal((await download(a.finance, mgmt.id)).status, 404);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/finance-pack`, { token: a.owner.token, body: { from: q.to, to: q.from } })).status, 400);

  const { financeSnapshot, managementSnapshot } = await import('../src/capabilities/academy-packs.js');
  const fs = JSON.stringify(await financeSnapshot(a.org.id, q.from, q.to));
  assert.ok(fs.includes('not statutory or audited accounts'));
  assert.ok(fs.includes('Approved payroll timesheets with no pay term'));
  assert.ok(fs.includes('INR 1200'), 'payroll cost shown in its own currency');
  const mSnap = await managementSnapshot(a.org.id, 'owner', q.from, q.to);
  const ms = JSON.stringify(mSnap);
  assert.ok(!/diagnos|treatment|medication|clinical note|strategy/i.test(ms), 'no clinical detail or legal strategy');
  const legal = mSnap.sections.flatMap((s) => s.items ?? []).find((x) => x.title === 'Open legal matters');
  assert.match(legal.value, /^\d+$|^Not available$/, 'legal appears only as a count');

  // the finance member leaves: the very same download is refused at once
  await pool.query("UPDATE organisation_members SET status='left' WHERE organisation_id=$1 AND user_id=$2", [a.org.id, a.finance.id]);
  assert.equal((await download(a.finance, fin.id)).status, 404);
  const list = must(await api('GET', `/organisations/${a.org.id}/academy/documents?kind=finance`, { token: a.owner.token }));
  assert.equal(list.length, 1);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/documents?kind=finance`, { token: a.coach.token })).status, 403);
});

// ------------------------------------------------------------------ leadership insights
test('trend: monthly revenue / cost / result per currency with the prior window and change; branch filter; role-limited', async () => {
  const a = await academy();
  const month = today.slice(0, 7);
  await approvedRun(a, { sheets: [await sheet(a, null, 120000, a.programme.id)] });
  await approvedRun(a, { currency: 'USD', sheets: [await sheet(a, null, 5000, a.programme.id)] });
  await pool.query("INSERT INTO academy_cost_entries(organisation_id, category, programme_id, currency, amount_minor, incurred_on, description, created_by) VALUES ($1,'other_direct',$2,'INR',30000,$3,'Equipment',$4)", [a.org.id, a.programme.id, today, a.owner.id]);
  const q = `from=${addDays(today, -60)}&to=${today}`;
  const t = must(await api('GET', `/organisations/${a.org.id}/academy/pnl/trend?${q}`, { token: a.finance.token }));
  assert.deepEqual(t.currencies.map((c) => c.currency), ['INR', 'USD'], 'currencies stay apart');
  const inr = t.currencies[0];
  const m = inr.months.find((x) => x.month === month);
  assert.equal(m.staff_minor, 120000); assert.equal(m.other_minor, 30000); assert.equal(m.result_minor, -150000);
  assert.equal(inr.totals.result_minor, -150000); assert.equal(inr.cost_complete, true);
  assert.equal(inr.prior.result_minor, 0); assert.equal(inr.change_pct.cost, null, 'no prior cost: the change is unknown, not infinite');
  assert.ok(inr.months.length >= 2 && inr.months.every((x, k, arr) => !k || x.month > arr[k - 1].month), 'months are ordered and continuous');
  const north = must(await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'North', idempotency_key: key() } }), 201);
  const filtered = must(await api('GET', `/organisations/${a.org.id}/academy/pnl/trend?${q}&branch_id=${north.id}`, { token: a.owner.token }));
  assert.equal(filtered.currencies.length, 0, 'a branch with no programmes has no figures');
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/pnl/trend?${q}`, { token: a.coach.token })).status, 403);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/pnl/trend?from=${today}&to=${addDays(today, -1)}`, { token: a.owner.token })).status, 400);
  const other = await academy('Elsewhere');
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/pnl/trend?${q}`, { token: other.owner.token })).status, 404);
});

test('branch scorecard: each status is a stated rule over a measured figure; finance sees money only; the manager must be a member', async () => {
  const a = await academy();
  const mgr = await signup(['coach']);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'Ghost', manager_id: mgr.id, idempotency_key: key() } })).status, 400, 'a manager outside the academy is refused');
  must(await api('POST', `/organisations/${a.org.id}/members`, { token: a.owner.token, body: { person: mgr.handle, role: 'coach' } }), 201);
  must(await api('POST', `/organisations/${a.org.id}/invite/respond`, { token: mgr.token, body: { accept: true } }));
  const north = must(await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'Madrid North', code: 'MAD-N', manager_id: mgr.id, address: 'Calle 1', opened_on: addDays(today, -400), athlete_target: 10, city: 'Madrid', idempotency_key: key() } }), 201);
  assert.equal(north.code, 'MAD-N');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'Bad code', code: 'no spaces!', idempotency_key: key() } })).status, 400);
  must(await api('POST', `/academy/programmes/${a.programme.id}/branch`, { token: a.owner.token, body: { branch_id: north.id } }));
  await pool.query('UPDATE academy_programmes SET capacity=20 WHERE id=$1', [a.programme.id]);
  for (let k = 0; k < 8; k++) { const u = await signup(); await pool.query("INSERT INTO org_enrolments(cohort_id, user_id, status, programme_id, consent_at, enrolled_by) VALUES ($1,$2,'enrolled',$3,now(),$4)", [a.cohort.id, u.id, a.programme.id, a.owner.id]); }
  const sess = [await session(a, { status: 'completed', day: addDays(today, -3) }), await session(a, { status: 'completed', day: addDays(today, -2) }), await session(a, { status: 'cancelled', day: addDays(today, -1) })];
  const ids = (await pool.query("SELECT user_id FROM org_enrolments WHERE cohort_id=$1", [a.cohort.id])).rows.map((r) => r.user_id);
  for (const u of ids) await pool.query("INSERT INTO academy_attendance(session_id, user_id, status, marked_by) VALUES ($1,$2,$3,$4)", [sess[0].id, u, 'present', a.coach.id]);
  const q = `from=${addDays(today, -10)}&to=${today}`;
  const sc = must(await api('GET', `/organisations/${a.org.id}/academy/branch-scorecard?${q}`, { token: a.owner.token }));
  const row = sc.branches.find((b) => b.branch_id === north.id);
  assert.equal(row.manager.name, mgr.display_name); assert.equal(row.code, 'MAD-N');
  assert.equal(row.people.athletes, 8); assert.equal(row.people.target_pct, 80);
  assert.equal(row.people.utilisation.value, 40); assert.equal(row.people.utilisation.status, 'amber', '8 of 20 places = 40%: the amber band starts at 40');
  assert.equal(row.delivery.attendance.marked, 8); assert.equal(row.delivery.attendance.value, 100); assert.equal(row.delivery.attendance.status, 'green');
  assert.equal(row.delivery.cancelled, 1); assert.equal(row.delivery.cancellation.value, 33.3); assert.equal(row.delivery.cancellation.status, 'red');
  assert.ok(row.delivery.staffing.exceptions >= 1 && row.delivery.staffing.status !== 'green', 'sessions with no lead coach are exceptions');
  assert.ok(Object.values(sc.rules).every((r) => typeof r === 'string' && r.length > 20), 'every status carries its rule');
  assert.equal(row.finance.length, 0, 'no charges: the money columns are empty, not zero');
  assert.ok(sc.data_quality.venue_booked && sc.data_quality.programmes_with_branch.pct === 100);
  assert.equal(sc.branches.some((b) => b.branch_id === null) , false, 'every programme is in a branch, so no Unassigned row');

  const fin = must(await api('GET', `/organisations/${a.org.id}/academy/branch-scorecard?${q}`, { token: a.finance.token }));
  assert.equal(fin.money_only, true); assert.equal(fin.data_quality, null);
  assert.ok(fin.branches.every((b) => b.people === undefined && b.delivery === undefined), 'finance never receives people or delivery data');
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/branch-scorecard?${q}`, { token: a.coach.token })).status, 403);
  const other = await academy('Elsewhere');
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/branch-scorecard?${q}`, { token: other.owner.token })).status, 404);
  must(await api('POST', `/academy/branches/${north.id}`, { token: a.owner.token, body: { athlete_target: 20, manager_id: null } }));
  const after = must(await api('GET', `/organisations/${a.org.id}/academy/branch-scorecard?${q}`, { token: a.owner.token })).branches.find((b) => b.branch_id === north.id);
  assert.equal(after.people.target_pct, 40); assert.equal(after.manager, null);
});

test('executive home: people, delivery and outcomes respect the branch_id filter', async () => {
  const a = await academy('Branch Filter');
  // Create two branches and assign programmes to each
  const branchA = must(await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'Branch A', idempotency_key: key() } }), 201);
  const branchB = must(await api('POST', `/organisations/${a.org.id}/academy/branches`, { token: a.owner.token, body: { name: 'Branch B', idempotency_key: key() } }), 201);
  // Existing programme → Branch A
  must(await api('POST', `/academy/programmes/${a.programme.id}/branch`, { token: a.owner.token, body: { branch_id: branchA.id } }));
  // Second programme → Branch B
  const progB = must(await api('POST', `/organisations/${a.org.id}/academy/programmes`, { token: a.owner.token, body: { sport: 'football', title: 'Branch B Prog', admission_mode: 'direct', public: true } }), 201);
  must(await api('POST', `/academy/programmes/${progB.id}/branch`, { token: a.owner.token, body: { branch_id: branchB.id } }));
  const cohortB = must(await api('POST', `/organisations/${a.org.id}/cohorts`, { token: a.owner.token, body: { name: 'Branch B cohort', coach_id: a.coach.id } }), 201);
  await pool.query('UPDATE org_cohorts SET programme_id=$2 WHERE id=$1', [cohortB.id, progB.id]);

  // 3 athletes enrolled in Branch A, 5 in Branch B
  for (let i = 0; i < 3; i++) {
    const u = await signup();
    await pool.query("INSERT INTO org_enrolments(cohort_id, user_id, status, programme_id, consent_at, enrolled_by) VALUES ($1,$2,'enrolled',$3,now(),$4)", [a.cohort.id, u.id, a.programme.id, a.owner.id]);
  }
  for (let i = 0; i < 5; i++) {
    const u = await signup();
    await pool.query("INSERT INTO org_enrolments(cohort_id, user_id, status, programme_id, consent_at, enrolled_by) VALUES ($1,$2,'enrolled',$3,now(),$4)", [cohortB.id, u.id, progB.id, a.owner.id]);
  }

  // 1 completed session in Branch A, 2 in Branch B
  await session(a, { status: 'completed', day: addDays(today, -3) });
  await pool.query(
    `INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, title, starts_at, ends_at, status, created_by)
     VALUES ($1,$2,$3,'B Sess 1',($4::date + make_interval(hours => 10)) AT TIME ZONE 'UTC',($4::date + make_interval(hours => 11)) AT TIME ZONE 'UTC','completed',$5)`,
    [a.org.id, cohortB.id, progB.id, addDays(today, -2), a.owner.id]);
  await pool.query(
    `INSERT INTO academy_sessions(organisation_id, cohort_id, programme_id, title, starts_at, ends_at, status, created_by)
     VALUES ($1,$2,$3,'B Sess 2',($4::date + make_interval(hours => 14)) AT TIME ZONE 'UTC',($4::date + make_interval(hours => 15)) AT TIME ZONE 'UTC','completed',$5)`,
    [a.org.id, cohortB.id, progB.id, addDays(today, -1), a.owner.id]);

  const q = `from=${addDays(today, -10)}&to=${today}`;

  // people: branch A → 3 athletes; branch B → 5 athletes; no filter → 8
  const homeA = must(await api('GET', `/organisations/${a.org.id}/academy/executive?${q}&branch_id=${branchA.id}`, { token: a.owner.token }));
  assert.equal(homeA.people.enrolled_athletes, 3, 'people: branch A has 3 enrolled athletes');
  const homeB = must(await api('GET', `/organisations/${a.org.id}/academy/executive?${q}&branch_id=${branchB.id}`, { token: a.owner.token }));
  assert.equal(homeB.people.enrolled_athletes, 5, 'people: branch B has 5 enrolled athletes');
  const homeAll = must(await api('GET', `/organisations/${a.org.id}/academy/executive?${q}`, { token: a.owner.token }));
  assert.equal(homeAll.people.enrolled_athletes, 8, 'people: all 8 athletes when no branch filter');

  // delivery: branch A → 1 completed session; branch B → 2 completed sessions
  assert.equal(homeA.delivery.sessions_completed, 1, 'delivery: branch A has 1 completed session');
  assert.equal(homeB.delivery.sessions_completed, 2, 'delivery: branch B has 2 completed sessions');
  assert.equal(homeAll.delivery.sessions_completed, 3, 'delivery: 3 total completed sessions with no filter');

  // outcomes: no progression decisions seeded → review_queue and decisions are empty for both branches
  assert.equal(homeA.outcomes.review_queue, 0, 'outcomes: empty queue for branch A with no pathways');
  assert.equal(homeB.outcomes.review_queue, 0, 'outcomes: empty queue for branch B with no pathways');
});
