import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, s) => { if (s ? r.status !== s : r.status >= 300) assert.fail(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const get = (t, p) => call('GET', p, { token: t });
const post = (t, p, body) => call('POST', p, { token: t, body });
const patch = (t, p, body) => call('PATCH', p, { token: t, body });
const del = (t, p) => call('DELETE', p, { token: t });
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => {
  n++;
  const r = ok(await call('POST', '/auth/register', { body: { handle: `pw_${n}`, display_name: `Pw ${n}`, email: `pw${n}@example.com`, password: 'correct-horse-battery', roles } }), 201);
  return { ...r.user, token: r.token };
};
const sports = {};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const s of ok(await call('GET', '/sports'))) sports[s.slug] = s;
});
after(async () => { server.close(); await pool.end(); });

/** A listed college with one programme (so it can be a target and take an enquiry). */
const college = async () => {
  const owner = await signup();
  const org = ok(await post(owner.token, '/organisations', { name: `Hilltop ${n}`, kind: 'college', city: 'Pune' }), 201);
  ok(await patch(owner.token, `/organisations/${org.id}/institution`, { about: 'Sports degrees', website: 'https://hilltop.example', country: 'India', contact_email: 'admissions@hilltop.example', contact_phone: '+91 20 5550 0000', listed: true }));
  return { owner, org };
};
const target = async (t, type, id, extra = {}) => ok(await post(t, '/me/bucket', { target_type: type, target_id: id, ...extra }), 201);
const coached = async () => {
  const coach = await signup(['coach']), a = await signup();
  const team = ok(await post(coach.token, '/teams', { name: `Pw FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, a.id]);
  return { coach, a, team };
};

test('targets: institutions and teams share one list; every stage change is kept and a stale edit is refused', async () => {
  const a = await signup(), { org } = await college();
  const { team } = await coached();
  const inst = await target(a.token, 'institution', org.id);
  const club = await target(a.token, 'team', team.id, { status: 'shortlisted' });
  assert.equal((await post(a.token, '/me/bucket', { target_type: 'team', target_id: '00000000-0000-4000-8000-000000000000' })).status, 404, 'unknown team');
  const list = ok(await get(a.token, '/me/bucket'));
  assert.deepEqual(list.map((x) => x.target_type).sort(), ['institution', 'team']);
  assert.ok(list.find((x) => x.target_type === 'team').institution, 'a team target says its sport');
  const next = ok(await patch(a.token, `/me/bucket/${inst.id}`, { status: 'applied', row_version: inst.row_version }));
  assert.equal((await patch(a.token, `/me/bucket/${inst.id}`, { status: 'offered', row_version: inst.row_version })).status, 409, 'stale version');
  assert.equal(next.status, 'applied');
  const out = ok(await get(a.token, '/me/pathway/outcomes'));
  assert.equal(out.counts.applied, 1);
  assert.equal(out.counts.shortlisted, 1);
  assert.ok(out.timeline.some((e) => e.kind === 'stage' && e.from_value === 'saved' && e.to_value === 'applied'));
  assert.equal(ok(await get(a.token, '/me/pathway')).targets, 2);
  // an enquiry at the listed institution shows its status next to the target
  ok(await post(a.token, '/enquiries', { organisation_id: org.id, message: 'Hello' }), 201);
  assert.equal(ok(await get(a.token, '/me/bucket')).find((x) => x.target_type === 'institution').enquiry_status, 'new');
  // nobody else sees my plan
  const other = await signup();
  assert.equal(ok(await get(other.token, '/me/bucket')).length, 0);
  assert.equal((await patch(other.token, `/me/bucket/${inst.id}`, { status: 'saved' })).status, 404);
  await assert.rejects(pool.query('DELETE FROM pathway_events WHERE user_id=$1', [a.id]), /append-only|cannot/i, 'history is append-only');
});

test('goals: built from the catalogue (sport metrics with your real figures, academic scales, milestones); live tracking, bounds, duplicates, stale edits', async () => {
  const a = await signup();
  assert.equal((await post(a.token, '/me/sport-profiles', { sport: 'athletics', role: 'athlete', level: 'amateur' })).status, 201);
  const ath = (await pool.query("SELECT id FROM sports WHERE slug='athletics'")).rows[0].id;
  const def = (await pool.query("INSERT INTO metric_definitions(sport_id, key, label, current_version) VALUES ($1,'sprint_time','100 m time',1) RETURNING id", [ath])).rows[0].id;
  await pool.query("INSERT INTO metric_definition_versions(definition_id, version, unit, direction, aggregation, value_kind, min_value, max_value, points_mode, points_value, hash) VALUES ($1,1,'s','lower','best','decimal',8,30,'flat',0,'h')", [def]);
  await pool.query("INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on) VALUES ($1,$2,'sprint_time',12.4,0,$1,'self_reported','recorded','s','lower',$3)", [a.id, ath, day(-5)]);
  await pool.query("INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on) VALUES ($1,$2,'sprint_time',12.0,0,$1,'approved_competition','approved','s','lower',$3)", [a.id, ath, day(-3)]);

  const base = ok(await get(a.token, '/me/pathway/goal-options'));
  assert.deepEqual(base.sports.map((x) => x.slug), ['athletics']);
  assert.ok(base.academic.some((m) => m.key === 'ielts' && m.max === 9 && m.step === 0.5), 'academic measures carry their real scale');
  assert.ok(base.milestones.length > 3 && base.metrics.length === 0);
  const opts = ok(await get(a.token, '/me/pathway/goal-options?sport_slug=athletics'));
  const m = opts.metrics.find((x) => x.key === 'sprint_time');
  assert.equal(m.current, 12.0); assert.equal(m.evidence, 'approved_competition', 'approved result preferred, never blended with practice');
  assert.equal(m.direction, 'lower'); assert.equal(m.unit, 's'); assert.equal(m.step, 0.01);
  assert.ok(m.suggestions.every((s) => s.value < 12.0), 'suggestions go in the good direction (faster)');
  assert.equal((await get(a.token, '/me/pathway/goal-options?sport_slug=golf')).status, 200, 'a sport you do not play just has no metrics');

  assert.equal((await post(a.token, '/me/pathway/goals', { kind: 'sporting', sport_slug: 'athletics', metric_key: 'made_up', target: 11 })).status, 400, 'only catalogue metrics');
  assert.equal((await post(a.token, '/me/pathway/goals', { kind: 'sporting', sport_slug: 'athletics', metric_key: 'sprint_time', target: 2 })).status, 400, 'outside the valid range');
  assert.equal((await post(a.token, '/me/pathway/goals', { kind: 'sporting', metric_key: 'sprint_time', target: 11 })).status, 400, 'sport first');
  assert.equal((await post(a.token, '/me/pathway/goals', { kind: 'sporting', sport_slug: 'athletics' })).status, 400, 'a metric or a milestone');
  const g = ok(await post(a.token, '/me/pathway/goals', { kind: 'sporting', sport_slug: 'athletics', metric_key: 'sprint_time', target: 11.5, target_date: day(120), notes: 'private worry' }), 201);
  assert.equal(g.title, '100 m time'); assert.equal(g.unit, 's'); assert.equal(g.baseline, 12.0); assert.equal(g.current_source, 'live');
  assert.equal(g.progress, 0, 'baseline = current = 12.0 so no progress yet');
  assert.equal((await pool.query('SELECT notes_enc FROM pathway_goals WHERE id=$1', [g.id])).rows[0].notes_enc.startsWith('v1.'), true, 'notes are encrypted at rest');
  // a new approved result moves the goal by itself
  await pool.query("INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on) VALUES ($1,$2,'sprint_time',11.75,0,$1,'approved_competition','approved','s','lower',$3)", [a.id, ath, day(-1)]);
  const live = ok(await get(a.token, '/me/pathway/goals')).find((x) => x.id === g.id);
  assert.equal(live.current, 11.75); assert.equal(live.progress, 0.5, 'half way from 12.0 to 11.5');
  assert.equal(ok(await post(a.token, '/me/pathway/goals', { kind: 'sporting', sport_slug: 'athletics', metric_key: 'sprint_time', target: 11 }), 201).replay, true, 'same goal twice is one goal');

  const acad = ok(await post(a.token, '/me/pathway/goals', { kind: 'academic', academic_measure: 'ielts', baseline: 6, current: 6.5, target: 7.5 }), 201);
  assert.equal(acad.title, 'IELTS'); assert.equal(acad.progress, 0.33); assert.equal(acad.current_source, 'manual');
  assert.equal((await post(a.token, '/me/pathway/goals', { kind: 'academic', academic_measure: 'gpa_4', target: 4.5 })).status, 400, 'bounded by the real scale');
  const mile = ok(await post(a.token, '/me/pathway/goals', { kind: 'sporting', milestone: 'Make the squad' }), 201);
  assert.equal(mile.measure, 'yes_no'); assert.equal(mile.progress, null);
  const up = ok(await patch(a.token, `/me/pathway/goals/${acad.id}`, { row_version: acad.row_version, current: 7.5, status: 'achieved' }));
  assert.equal(up.progress, 1); assert.ok(up.achieved_at);
  assert.equal((await patch(a.token, `/me/pathway/goals/${acad.id}`, { row_version: acad.row_version, current: 7 })).status, 409, 'stale');
  const other = await signup();
  assert.equal((await patch(other.token, `/me/pathway/goals/${acad.id}`, { row_version: 2, current: 1 })).status, 404);
  ok(await patch(a.token, `/me/pathway/goals/${mile.id}`, { row_version: mile.row_version, remove: true }));
  assert.equal(ok(await get(a.token, '/me/pathway/goals')).length, 2, 'removed goals are hidden, not deleted');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pathway_goals WHERE user_id=$1', [a.id])).rows[0].n, 3);
});

test('deadlines: one list across own dates, targets, trials and offer replies; duplicates, done, reminders', async () => {
  const a = await signup(), { org } = await college();
  const b = await target(a.token, 'institution', org.id, { target_date: day(9) });
  const d1 = ok(await post(a.token, '/me/pathway/deadlines', { kind: 'documents', bucket_id: b.id, due_on: day(3), remind_days: 5 }), 201);
  assert.equal(ok(await post(a.token, '/me/pathway/deadlines', { kind: 'documents', bucket_id: b.id, due_on: day(3) }), 201).id, d1.id, 'same deadline twice is one');
  assert.equal((await post(a.token, '/me/pathway/deadlines', { kind: 'other', due_on: day(2) })).status, 400, 'other needs a title');
  assert.equal((await post(a.token, '/me/pathway/deadlines', { kind: 'application', bucket_id: '00000000-0000-4000-8000-000000000000', due_on: day(2) })).status, 404);
  ok(await post(a.token, '/me/pathway/offers', { bucket_id: b.id, title: 'Place A', tuition_minor: 100000, currency: 'INR', reply_by: day(20) }), 201);
  const list = ok(await get(a.token, '/me/pathway/deadlines'));
  assert.deepEqual(list.map((x) => x.source), ['own', 'offer'], 'sorted by date, each says where it comes from; the application date is finished once an offer is in');
  assert.equal(list[0].days_left, 3);
  // the due-soon one is reminded exactly once, even if the sweep runs twice
  const { queuePathwayReminders } = await import('../src/pathway-reminders.js');
  assert.equal(await queuePathwayReminders(), 1);
  assert.equal(await queuePathwayReminders(), 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='pathway_deadline'", [a.id])).rows[0].n, 1);
  const moved = ok(await patch(a.token, `/me/pathway/deadlines/${d1.id}`, { row_version: d1.row_version, due_on: day(4) }));
  assert.equal(moved.reminded_at, null, 'moving the date re-arms the reminder');
  assert.equal((await patch(a.token, `/me/pathway/deadlines/${d1.id}`, { row_version: d1.row_version, done: true })).status, 409);
  ok(await patch(a.token, `/me/pathway/deadlines/${d1.id}`, { row_version: moved.row_version, done: true }));
  assert.equal(ok(await get(a.token, '/me/pathway/deadlines')).some((x) => x.source === 'own'), false, 'finished and past items drop off');
  assert.equal(ok(await get(a.token, '/me/pathway/deadlines?include_past=true')).some((x) => x.source === 'own' && x.done), true);
  // a booked trial shows up without being copied
  const organiser = await signup(['organizer']);
  const trial = ok(await post(organiser.token, '/events', { name: 'Open trial', sport: 'football', kind: 'trial', starts_on: day(6), ends_on: day(6), capacity: 5 }), 201);
  await pool.query("UPDATE events SET status='open' WHERE id=$1", [trial.id]);
  ok(await post(a.token, `/trials/${trial.id}/book`, {}), 201);
  const withTrial = ok(await get(a.token, '/me/pathway/deadlines'));
  assert.deepEqual(withTrial.map((x) => x.source), ['trial', 'offer'], 'the finished own deadline is hidden');
  assert.equal(withTrial[0].title, 'Open trial'); assert.equal(withTrial[0].days_left, 6);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pathway_deadlines WHERE user_id=$1', [a.id])).rows[0].n, 1, 'the trial was read, not copied');
  assert.equal(ok(await get(a.token, '/me/pathway')).next_deadlines.length, 2);
});

test('scholarships: evidence is linked, never copied; provenance is honest; removed evidence stops counting', async () => {
  const a = await signup(), { org } = await college();
  const b = await target(a.token, 'institution', org.id);
  const sc = ok(await post(a.token, '/me/pathway/scholarships', { bucket_id: b.id, name: 'Sports bursary', amount_minor: 1200000, currency: 'INR', requirements: ['Latest transcript', 'Coach reference'], notes: 'ask about housing' }), 201);
  assert.equal(sc.total, 2); assert.equal(sc.met, 0); assert.equal(sc.notes, 'ask about housing');
  assert.equal(ok(await post(a.token, '/me/pathway/scholarships', { bucket_id: b.id, name: 'sports bursary' }), 201).replay, true);
  assert.equal((await post(a.token, '/me/pathway/scholarships', { bucket_id: b.id, name: 'No cur', amount_minor: 5 })).status, 400, 'amount needs a currency');
  const ev = await pool.query("INSERT INTO academic_evidence(user_id, kind, institution, provenance) VALUES ($1,'transcript','Hill School','self_reported') RETURNING id", [a.id]);
  const item = sc.items.find((i) => i.requirement === 'Latest transcript');
  const stranger = await signup();
  assert.equal((await post(stranger.token, `/me/pathway/scholarship-items/${item.id}/evidence`, { source_type: 'academic_evidence', source_id: ev.rows[0].id })).status, 404, 'not mine');
  const strangerEv = await pool.query("INSERT INTO academic_evidence(user_id, kind, institution) VALUES ($1,'transcript','Other School') RETURNING id", [stranger.id]);
  assert.equal((await post(a.token, `/me/pathway/scholarship-items/${item.id}/evidence`, { source_type: 'academic_evidence', source_id: strangerEv.rows[0].id })).status, 404, 'someone else\'s evidence cannot be attached');
  const att = ok(await post(a.token, `/me/pathway/scholarship-items/${item.id}/evidence`, { source_type: 'academic_evidence', source_id: ev.rows[0].id }));
  assert.equal(att.met, 1);
  const it = att.items.find((i) => i.id === item.id);
  assert.equal(it.provenance, 'self_reported'); assert.equal(it.provenance_label, 'Self-reported');
  ok(await post(a.token, `/me/pathway/scholarship-items/${item.id}/evidence`, { source_type: 'academic_evidence', source_id: ev.rows[0].id })); // retry changes nothing
  await pool.query('UPDATE academic_evidence SET removed_at=now() WHERE id=$1', [ev.rows[0].id]);
  assert.equal(ok(await get(a.token, '/me/pathway/scholarships'))[0].met, 0, 'evidence later removed is no longer counted as met');
  assert.equal(ok(await del(a.token, `/me/pathway/scholarship-items/${item.id}/evidence`)).met, 0);
  assert.equal((await patch(a.token, `/me/pathway/scholarships/${sc.id}`, { row_version: sc.row_version, status: 'awarded' })).status, 200, 'amount already set');
  assert.equal((await patch(a.token, `/me/pathway/scholarships/${sc.id}`, { row_version: sc.row_version, status: 'declined' })).status, 409, 'stale');
  assert.equal(ok(await post(a.token, `/me/pathway/scholarships/${sc.id}/requirements`, { requirement: 'Match video' }), 201).total, 3);
});

test('offers: net cost per currency, never converted; accept, decline, defer move the target and are logged and idempotent', async () => {
  const a = await signup(), c1 = await college(), c2 = await college();
  const b1 = await target(a.token, 'institution', c1.org.id, { status: 'applied' }), b2 = await target(a.token, 'institution', c2.org.id);
  const s = ok(await post(a.token, '/me/pathway/scholarships', { bucket_id: b1.id, name: 'Merit', amount_minor: 300000, currency: 'INR' }), 201);
  ok(await patch(a.token, `/me/pathway/scholarships/${s.id}`, { row_version: s.row_version, status: 'awarded' }));
  const o1 = ok(await post(a.token, '/me/pathway/offers', { bucket_id: b1.id, title: 'BSc place', tuition_minor: 1000000, other_minor: 200000, currency: 'INR', scholarship_id: s.id, reply_by: day(10), conditions: 'GPA 3.2' }), 201);
  assert.equal(o1.scholarship_minor, 300000, 'amount taken from the awarded scholarship');
  assert.equal(o1.net_minor, 900000);
  assert.equal(o1.conditions, 'GPA 3.2');
  assert.ok(o1.source_label.includes('not verified'), 'honest source label');
  assert.equal(ok(await get(a.token, '/me/bucket')).find((x) => x.id === b1.id).status, 'offered');
  assert.equal(ok(await post(a.token, '/me/pathway/offers', { bucket_id: b1.id, title: 'bsc place', currency: 'INR' }), 201).id, o1.id, 'duplicate = same offer');
  const o2 = ok(await post(a.token, '/me/pathway/offers', { bucket_id: b2.id, title: 'Diploma', tuition_minor: 500000, currency: 'INR', scholarship_minor: 100000 }), 201);
  const o3 = ok(await post(a.token, '/me/pathway/offers', { bucket_id: b2.id, title: 'Overseas', tuition_minor: 2000000, currency: 'USD' }), 201);
  const cmp = ok(await get(a.token, '/me/pathway/offers/compare'));
  assert.equal(cmp.mixed, true); assert.ok(cmp.notice.includes('never converted'));
  const inr = cmp.groups.find((g) => g.currency === 'INR');
  assert.deepEqual(inr.offers.map((o) => o.title), ['Diploma', 'BSc place'], 'cheapest net first');
  assert.equal(inr.offers[0].lowest_net_cost, true); assert.equal(inr.offers[1].lowest_net_cost, false);
  assert.equal(cmp.groups.find((g) => g.currency === 'USD').offers[0].lowest_net_cost, false, 'a lone offer is not "best"');
  assert.equal((await get(a.token, `/me/pathway/offers/compare?ids=${o1.id},00000000-0000-4000-8000-000000000000`)).status, 404);

  // decisions
  const acc = ok(await post(a.token, `/me/pathway/offers/${o1.id}/decision`, { row_version: o1.row_version, decision: 'accept', note: 'happy' }));
  assert.equal(acc.status, 'accepted'); assert.equal(acc.decision_note, 'happy');
  assert.equal(ok(await post(a.token, `/me/pathway/offers/${o1.id}/decision`, { row_version: o1.row_version, decision: 'accept' })).replay, true, 'repeat = no change');
  assert.equal(ok(await get(a.token, '/me/bucket')).find((x) => x.id === b1.id).status, 'accepted');
  assert.equal((await patch(a.token, `/me/pathway/offers/${o1.id}`, { row_version: acc.row_version, tuition_minor: 1 })).status, 409, 'decided offers are not edited');
  const dec = ok(await post(a.token, `/me/pathway/offers/${o2.id}/decision`, { row_version: o2.row_version, decision: 'decline' }));
  assert.equal(ok(await get(a.token, '/me/bucket')).find((x) => x.id === b2.id).status, 'offered', 'another live offer (USD) remains');
  assert.equal((await post(a.token, `/me/pathway/offers/${o2.id}/decision`, { row_version: 1, decision: 'accept' })).status, 409, 'stale version');
  const def = ok(await post(a.token, `/me/pathway/offers/${o3.id}/decision`, { row_version: o3.row_version, decision: 'defer', reply_by: day(30) }));
  assert.equal(def.status, 'deferred'); assert.equal(def.reply_by.slice(0, 10), day(30));
  ok(await post(a.token, `/me/pathway/offers/${o3.id}/decision`, { row_version: def.row_version, decision: 'decline' }));
  assert.equal(ok(await get(a.token, '/me/bucket')).find((x) => x.id === b2.id).status, 'declined', 'the last live offer declined');
  // change of mind on the accepted one
  ok(await post(a.token, `/me/pathway/offers/${o1.id}/decision`, { row_version: acc.row_version, decision: 'defer' }));
  assert.equal(ok(await get(a.token, '/me/bucket')).find((x) => x.id === b1.id).status, 'offered');
  const hist = ok(await get(a.token, '/me/pathway/outcomes?limit=100')).timeline;
  assert.ok(hist.filter((e) => e.kind === 'offer_decided').length >= 4);
  // two accepted offers for one target are impossible
  const o4 = ok(await post(a.token, '/me/pathway/offers', { bucket_id: b1.id, title: 'Second', currency: 'INR' }), 201);
  ok(await post(a.token, `/me/pathway/offers/${o1.id}/decision`, { row_version: (ok(await get(a.token, '/me/pathway/offers')).find((o) => o.id === o1.id)).row_version, decision: 'accept' }));
  assert.equal((await post(a.token, `/me/pathway/offers/${o4.id}/decision`, { row_version: o4.row_version, decision: 'accept' })).status, 409);
  // concurrent identical decisions end as one decision
  const [x, y] = await Promise.all([post(a.token, `/me/pathway/offers/${o4.id}/decision`, { row_version: o4.row_version, decision: 'decline' }), post(a.token, `/me/pathway/offers/${o4.id}/decision`, { row_version: o4.row_version, decision: 'decline' })]);
  assert.ok([x.status, y.status].every((s) => s === 200 || s === 409), 'a concurrent retry is either a replay or a stale refusal');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pathway_events WHERE kind='offer_decided' AND to_value='declined' AND bucket_id=$1 AND detail='Second'", [b1.id])).rows[0].n, 1);
});

test('sharing with a coach: scoped, live, audited; revoked or ended relationships and withdrawn consent cut access; exports follow the same rules', async () => {
  const { coach, a, team } = await coached(), stranger = await signup(['coach']), { org } = await college();
  const b = await target(a.token, 'institution', org.id, { note: 'PRIVATE NOTE' });
  const goal = ok(await post(a.token, '/me/pathway/goals', { kind: 'academic', academic_measure: 'percentage', target: 80, notes: 'goal private' }), 201);
  const sc = ok(await post(a.token, '/me/pathway/scholarships', { bucket_id: b.id, name: 'Bursary', requirements: ['Transcript'], notes: 'sch private' }), 201);
  ok(await post(a.token, '/me/pathway/offers', { bucket_id: b.id, title: 'Place', tuition_minor: 500, currency: 'INR', conditions: 'cond private' }), 201);
  assert.equal((await post(a.token, '/me/pathway/shares', { recipient_id: stranger.id, scopes: ['goals'] })).status, 409, 'only a coach who works with you');
  assert.equal((await get(coach.token, `/pathway/shared/${a.id}`)).status, 404, 'nothing shared yet');
  const sh = ok(await post(a.token, '/me/pathway/shares', { recipient_id: coach.id, scopes: ['goals', 'offers', 'scholarships'] }), 201);
  assert.equal(ok(await get(coach.token, '/pathway/shared')).length, 1);
  const view = ok(await get(coach.token, `/pathway/shared/${a.id}`));
  assert.deepEqual(view.scopes.sort(), ['goals', 'offers', 'scholarships']);
  assert.equal(view.targets, undefined, 'targets were not shared'); assert.equal(view.deadlines, undefined);
  const text = JSON.stringify(view);
  for (const secret of ['PRIVATE NOTE', 'goal private', 'sch private', 'cond private']) assert.equal(text.includes(secret), false, `${secret} never leaves the athlete`);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND entity='pathway_shares'", [coach.id])).rows[0].n, 1, 'the read is audit-logged');
  const csv = ok(await get(coach.token, `/pathway/shared/${a.id}/export`));
  assert.ok(csv.csv.includes('Grade (%)') && csv.csv.includes('Place') && !csv.csv.includes('PRIVATE NOTE'));
  assert.equal((await get(stranger.token, `/pathway/shared/${a.id}`)).status, 404, 'someone else cannot read it');
  assert.ok(ok(await get(a.token, '/me/pathway/export')).csv.includes('PRIVATE NOTE') === false);

  // widening and narrowing is one share
  ok(await post(a.token, '/me/pathway/shares', { recipient_id: coach.id, scopes: ['targets'] }), 201);
  assert.equal(ok(await get(a.token, '/me/pathway/shares')).length, 1);
  assert.deepEqual(Object.keys(ok(await get(coach.token, `/pathway/shared/${a.id}`))).filter((k) => ['targets', 'goals', 'offers'].includes(k)), ['targets']);
  // coaching relationship ends -> access ends with no change to the share
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [team.id, coach.id]);
  assert.equal((await get(coach.token, `/pathway/shared/${a.id}`)).status, 404);
  assert.equal(ok(await get(coach.token, '/pathway/shared')).length, 0);
  await pool.query("UPDATE team_members SET status='active' WHERE team_id=$1 AND user_id=$2", [team.id, coach.id]);
  assert.equal((await get(coach.token, `/pathway/shared/${a.id}`)).status, 200);
  // revoke: immediate, by the athlete or by the coach; idempotent
  assert.equal((await post(stranger.token, `/me/pathway/shares/${sh.id}/revoke`, {})).status, 404);
  ok(await post(a.token, `/me/pathway/shares/${sh.id}/revoke`, {}));
  ok(await post(a.token, `/me/pathway/shares/${sh.id}/revoke`, {}));
  assert.equal((await get(coach.token, `/pathway/shared/${a.id}`)).status, 404);
  assert.equal((await get(coach.token, `/pathway/shared/${a.id}/export`)).status, 404);
  const again = ok(await post(a.token, '/me/pathway/shares', { recipient_id: coach.id, scopes: ['goals'], expires_on: day(-1) }), 201);
  assert.equal((await get(coach.token, `/pathway/shared/${a.id}`)).status, 404, 'expired');
  ok(await post(coach.token, `/me/pathway/shares/${again.id}/revoke`, {}));
  assert.ok(goal.id && sc.id);
});

test('young people: a guardian acts for them, accepting needs a guardian, sharing needs current consent and stops when it is withdrawn', async () => {
  const { coach, a: kid } = await coached(), parent = await signup(), stranger = await signup(), { org } = await college();
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  assert.equal((await get(stranger.token, `/me/pathway?athlete_id=${kid.id}`)).status, 403, 'only a verified guardian can act');
  const b = ok(await post(kid.token, '/me/bucket', { target_type: 'institution', target_id: org.id }), 201);
  const o = ok(await post(parent.token, '/me/pathway/offers', { athlete_id: kid.id, bucket_id: b.id, title: 'Place', tuition_minor: 1000, currency: 'INR' }), 201);
  assert.equal((await post(kid.token, `/me/pathway/offers/${o.id}/decision`, { row_version: o.row_version, decision: 'accept' })).status, 409, 'a young person alone needs consent to accept');
  assert.equal((await post(kid.token, '/me/pathway/shares', { recipient_id: coach.id, scopes: ['goals'] })).status, 409, 'sharing needs recruitment_sharing consent');
  assert.equal((await post(parent.token, '/me/pathway/shares', { athlete_id: kid.id, recipient_id: coach.id, scopes: ['goals'] })).status, 409, 'a guardian cannot share without the consent being in force');
  ok(await post(parent.token, `/youth/children/${kid.id}/consents`, { child_id: kid.id, purpose: 'recruitment_sharing' }), 201);
  ok(await post(parent.token, `/youth/children/${kid.id}/consents`, { child_id: kid.id, purpose: 'participation' }), 201); // a coach may see a young player only with this
  ok(await post(parent.token, '/me/pathway/shares', { athlete_id: kid.id, recipient_id: coach.id, scopes: ['goals'] }), 201);
  ok(await post(kid.token, '/me/pathway/goals', { kind: 'academic', academic_measure: 'percentage', target: 80 }), 201);
  assert.equal(ok(await get(coach.token, `/pathway/shared/${kid.id}`)).goals.length, 1);
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='recruitment_sharing'", [kid.id]);
  assert.equal((await get(coach.token, `/pathway/shared/${kid.id}`)).status, 404, 'withdrawn consent cuts access at once');
  const accepted = ok(await post(parent.token, `/me/pathway/offers/${o.id}/decision`, { athlete_id: kid.id, row_version: o.row_version, decision: 'accept' }));
  assert.equal(accepted.status, 'accepted', 'a verified guardian can decide for them');
  assert.ok(ok(await get(parent.token, `/me/pathway/export?athlete_id=${kid.id}`)).csv.includes('Grade (%)'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='pathway_offer_decision'", [kid.id])).rows[0].n, 1, 'the young person is told');
});

test('regressions: the existing bucket list, trial bookings and education routes still work', async () => {
  const a = await signup(), { org } = await college();
  const b = ok(await post(a.token, '/me/bucket', { target_type: 'institution', target_id: org.id, status: 'applying', target_date: day(5), note: 'call them' }), 201);
  assert.equal(b.row_version, 1);
  assert.equal(ok(await post(a.token, '/me/bucket', { target_type: 'institution', target_id: org.id }), 201).status, 'applying', 'saving again keeps the stage');
  ok(await patch(a.token, `/me/bucket/${b.id}`, { remove: true }));
  assert.equal(ok(await get(a.token, '/me/bucket')).length, 0);
  assert.equal(ok(await post(a.token, '/me/bucket', { target_type: 'institution', target_id: org.id, status: 'shortlisted' }), 201).status, 'shortlisted', 'a removed item comes back at the stage asked for');
  assert.equal((await post(a.token, '/me/bucket', { target_type: 'bogus', target_id: org.id })).status, 400);
  assert.equal(ok(await get(a.token, '/trials/mine')).items.length, 0);
});
