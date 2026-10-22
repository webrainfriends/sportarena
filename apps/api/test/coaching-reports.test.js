import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base;
const api = async (method, path, { token, body, raw } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') };
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles, name) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cr_${n}_${roles[0]}`, display_name: name ?? `CR Person${n}`, email: `cr${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const today = new Date().toISOString().slice(0, 10), start = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

const setup = async () => {
  const coach = await signup(['coach']), assistant = await signup(['coach']), outsider = await signup(['coach']);
  const arjun = await signup(['athlete'], 'Arjun Reports'), kabir = await signup(['athlete'], 'Kabir Reports');
  const team = ok(await post(coach.token, '/teams', { name: `Reports FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active')", [team.id, assistant.id]);
  for (const p of [arjun, kabir]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, p.id]);
  const rec = ok(await post(coach.token, '/coaching/sessions', { source_type: 'team_session', source_id: randomUUID(), team_id: team.id, title: 'Tuesday', scheduled_at: new Date().toISOString() }), 201);
  ok(await post(coach.token, `/coaching/sessions/${rec.id}/attendance`, { entries: [{ athlete_id: arjun.id, attendance: 'present' }] }));
  const obs = async (athlete, note, visibility, extra = {}) => ok(await post(coach.token, '/coaching/observations', { athlete_id: athlete.id, team_id: team.id, session_record_id: rec.id, note, visibility, ...extra }), 201);
  return { coach, assistant, outsider, arjun, kabir, team, rec, obs };
};
const mkReport = (s, extra = {}) => post(s.coach.token, '/coaching/reports', { athlete_id: s.arjun.id, team_id: s.team.id, kind: 'athlete_progress', title: 'Arjun progress', audience: 'athlete', from: start, to: today, ...extra });

test('only notes visible to the audience can be selected; a private note can never reach an athlete, guardian or staff report', async () => {
  const s = await setup();
  const priv = await s.obs(s.arjun, 'PRIVATE-WORRY', 'coach_private'), staff = await s.obs(s.arjun, 'STAFF-ONLY', 'staff'), shared = await s.obs(s.arjun, 'SHARED-PRAISE', 'player');
  const other = await s.obs(s.kabir, 'KABIR-SHARED', 'player');
  for (const aud of ['athlete', 'team_staff']) {
    const bad = await mkReport(s, { audience: aud, selection: { observation_ids: [priv.id, shared.id] } });
    assert.equal(bad.status, 400, aud); assert.match(bad.body.error.message, /not shared with this audience/);
  }
  assert.equal((await mkReport(s, { selection: { observation_ids: [staff.id] } })).status, 400, 'staff-only notes are not for the athlete');
  assert.equal((await mkReport(s, { selection: { observation_ids: [other.id] } })).status, 400, 'a note about someone else');
  assert.equal((await post(s.outsider.token, '/coaching/reports', { athlete_id: s.arjun.id, kind: 'athlete_progress', title: 'Guess', audience: 'athlete', from: start, to: today })).status, 403);
  const r = ok(await mkReport(s, { selection: { observation_ids: [shared.id] }, narrative: 'A good month.' }), 201);
  // changing the audience re-checks the selection
  const priv2 = ok(await mkReport(s, { audience: 'coach_private', selection: { observation_ids: [priv.id] } }), 201);
  assert.equal((await api('PATCH', `/coaching/reports/${priv2.id}`, { token: s.coach.token, body: { row_version: 1, audience: 'athlete' } })).status, 400);
  const prev = ok(await get(s.coach.token, `/coaching/reports/${r.id}/preview`));
  assert.ok(!JSON.stringify(prev).includes('PRIVATE-WORRY') && !JSON.stringify(prev).includes('STAFF-ONLY'));
  assert.ok(JSON.stringify(prev).includes('SHARED-PRAISE'));
});

test('audience-safe sections: goals use athlete wording, rubric scores stay private, actions need sharing', async () => {
  const s = await setup();
  const hidden = ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.arjun.id, title: 'SECRET-GOAL', criterion: 'SECRET-CRITERION' }), 201);
  const shown = ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.arjun.id, title: 'Scan more', athlete_text: 'Look over your shoulder', coach_notes: 'SECRET-COACH-NOTE', criterion: 'SECRET-CRITERION' }), 201);
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.arjun.id, title: 'PRIVATE-ACTION' }), 201);
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.arjun.id, title: 'Shared drill', shared: true }), 201);
  const rub = ok(await post(s.coach.token, '/coaching/rubrics', { name: 'Tech', dimensions: [{ key: 'touch', name: 'Touch', scale_min: 1, scale_max: 5 }] }), 201);
  await s.obs(s.arjun, 'scored', 'coach_private', { rubric_id: rub.id, dimension_key: 'touch', score: 4 });
  ok(await post(s.coach.token, '/coaching/measurements', { athlete_id: s.arjun.id, metric: 'Sprint', unit: 's', value: 3.5 }), 201);
  const r = ok(await mkReport(s), 201);
  const snap = ok(await get(s.coach.token, `/coaching/reports/${r.id}/preview`)).snapshot;
  const all = JSON.stringify(snap);
  for (const bad of ['SECRET-GOAL', 'SECRET-CRITERION', 'SECRET-COACH-NOTE', 'PRIVATE-ACTION', 'Touch']) assert.ok(!all.includes(bad), `leaked ${bad}`);
  assert.ok(all.includes('Look over your shoulder') && all.includes('Shared drill') && all.includes('Sprint'));
  const metrics = snap.sections.find((x) => x.key === 'metrics').items.find((m) => m.title === 'Attendance');
  assert.match(metrics.value, /100/); assert.match(metrics.meta, /Coach-observed/);
  const priv = ok(await mkReport(s, { audience: 'coach_private', title: 'My copy' }), 201);
  const mine = JSON.stringify(ok(await get(s.coach.token, `/coaching/reports/${priv.id}/preview`)).snapshot);
  assert.ok(mine.includes('SECRET-GOAL') && mine.includes('Touch') && mine.includes('PRIVATE-ACTION'), 'the coach\'s own copy has everything');
});

test('publishing freezes an immutable numbered snapshot; later changes do not alter it; unchanged content is not duplicated', async () => {
  const s = await setup();
  const note = await s.obs(s.arjun, 'FIRST-WORDING', 'player');
  const r = ok(await mkReport(s, { selection: { observation_ids: [note.id] } }), 201);
  assert.equal((await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 99 })).status, 409);
  const v1 = ok(await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 }), 201);
  assert.equal(v1.version, 1);
  assert.equal(ok(await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 }), 201).unchanged, true, 'same content, no duplicate');
  await pool.query("UPDATE coaching_observations SET note='REWRITTEN-LATER' WHERE id=$1", [note.id]);
  const seen = ok(await get(s.arjun.token, `/coaching/reports/${r.id}/versions/1`));
  assert.ok(JSON.stringify(seen).includes('FIRST-WORDING') && !JSON.stringify(seen).includes('REWRITTEN-LATER'));
  await assert.rejects(pool.query("UPDATE coaching_report_versions SET audience='coach_private' WHERE report_id=$1", [r.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM coaching_report_versions WHERE report_id=$1', [r.id]), /immutable/);
  const v2 = ok(await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 }), 201);
  assert.equal(v2.version, 2, 'changed source = new version');
  assert.ok(JSON.stringify(ok(await get(s.arjun.token, `/coaching/reports/${r.id}/versions/2`))).includes('REWRITTEN-LATER'));
  assert.ok(JSON.stringify(ok(await get(s.arjun.token, `/coaching/reports/${r.id}/versions/1`))).includes('FIRST-WORDING'), 'v1 is still v1');
  assert.deepEqual(ok(await get(s.coach.token, `/coaching/reports/${r.id}`)).versions.map((v) => v.version), [2, 1]);
});

test('who can read a published version: author and the audience only, live-checked', async () => {
  const s = await setup();
  const r = ok(await mkReport(s, { narrative: 'Well done' }), 201);
  ok(await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 }), 201);
  assert.equal((await get(s.kabir.token, `/coaching/reports/${r.id}/versions/1`)).status, 404, 'another athlete');
  assert.equal((await get(s.outsider.token, `/coaching/reports/${r.id}/versions/1`)).status, 404);
  assert.equal((await get(s.assistant.token, `/coaching/reports/${r.id}/versions/1`)).status, 404, 'staff are not the audience of an athlete report');
  assert.deepEqual(ok(await get(s.arjun.token, '/me/coaching-reports')).map((x) => x.report_id), [r.id]);
  assert.deepEqual(ok(await get(s.kabir.token, '/me/coaching-reports')), []);
  // a staff report is read by the team's coaches, not the athlete
  const st = ok(await mkReport(s, { audience: 'team_staff', title: 'Staff view' }), 201);
  ok(await post(s.coach.token, `/coaching/reports/${st.id}/publish`, { row_version: 1 }), 201);
  assert.equal((await get(s.assistant.token, `/coaching/reports/${st.id}/versions/1`)).status, 200);
  assert.equal((await get(s.arjun.token, `/coaching/reports/${st.id}/versions/1`)).status, 404);
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.assistant.id]);
  assert.equal((await get(s.assistant.token, `/coaching/reports/${st.id}/versions/1`)).status, 404, 'a coach who left loses access');
  // what the athlete was shown stays visible after the coaching relationship ends; the coach cannot publish new versions
  await pool.query('UPDATE teams SET owner_id=$2 WHERE id=$1', [s.team.id, s.outsider.id]);
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.coach.id]);
  assert.equal((await get(s.arjun.token, `/coaching/reports/${r.id}/versions/1`)).status, 200);
  assert.equal((await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 })).status, 403);
  assert.equal((await post(s.coach.token, '/coaching/reports', { athlete_id: s.arjun.id, kind: 'athlete_progress', title: 'New', audience: 'athlete', from: start, to: today })).status, 403);
});

test('a guardian report needs a young person with a verified guardian, and only that guardian reads it', async () => {
  const s = await setup();
  assert.equal((await mkReport(s, { audience: 'guardian' })).status, 400, 'adult athlete: no guardian report');
  const guardian = await signup(['athlete'], 'Parent Person');
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [s.arjun.id]);
  assert.equal((await mkReport(s, { audience: 'guardian' })).status, 403, 'a young person without guardian consent is not visible to the coach at all');
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, s.arjun.id]);
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '30 days')", [s.arjun.id, guardian.id]);
  const r = ok(await mkReport(s, { audience: 'guardian', title: 'For parents' }), 201);
  ok(await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 }), 201);
  assert.equal((await get(guardian.token, `/coaching/reports/${r.id}/versions/1`)).status, 200);
  assert.deepEqual(ok(await get(guardian.token, `/me/coaching-reports?child_id=${s.arjun.id}`)).map((x) => x.report_id), [r.id]);
  assert.equal((await get(s.kabir.token, `/me/coaching-reports?child_id=${s.arjun.id}`)).status, 403);
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE guardian_id=$1", [guardian.id]);
  assert.equal((await get(guardian.token, `/coaching/reports/${r.id}/versions/1`)).status, 404, 'revoked guardian loses access');
});

test('an AI narrative must come from a draft written for the same audience and be confirmed as reviewed before publishing', async () => {
  const s = await setup();
  await s.obs(s.arjun, 'PRIVATE-WORRY about confidence', 'coach_private');
  await s.obs(s.arjun, 'Shared: confident passing', 'player', { skill_tag: 'passing' });
  setAiTransport(async () => JSON.stringify({ headline: 'Arjun is passing with confidence', items: [{ title: 'Passing', detail: 'Confident', basis: 'observed', source_refs: ['O1'] }] }));
  const priv = ok(await post(s.coach.token, '/coaching/ai/drafts', { task: 'player_progress', athlete_id: s.arjun.id }), 201);
  const shared = ok(await post(s.coach.token, '/coaching/ai/drafts', { task: 'player_progress', athlete_id: s.arjun.id, audience: 'athlete' }), 201);
  assert.ok(!JSON.stringify(shared.sources).includes('PRIVATE'), 'sources only list shared records');
  assert.equal((await mkReport(s, { ai_draft_id: priv.id })).status, 400, 'a private-evidence draft cannot seed an athlete report');
  const r = ok(await mkReport(s, { ai_draft_id: shared.id }), 201);
  assert.equal(r.narrative_from_ai, true); assert.match(r.narrative, /passing with confidence/);
  assert.equal((await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 })).status, 400, 'must confirm review');
  assert.equal(ok(await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1, confirm_reviewed: true }), 201).version, 1);
  setAiTransport(null);
});

test('branded PDF reuses the #249 templates: renders the frozen version, and only the author or audience can download it', async () => {
  const s = await setup();
  const note = await s.obs(s.arjun, 'Lovely first touch', 'player');
  const r = ok(await mkReport(s, { selection: { observation_ids: [note.id] }, narrative: 'A strong month.' }), 201);
  assert.equal((await post(s.coach.token, '/branded-documents/coaching-report', { report_id: r.id })).status, 404, 'nothing published yet');
  ok(await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 }), 201);
  const fam = ok(await get(s.coach.token, '/branded-documents/families')).families.find((f) => f.family === 'coaching_report');
  assert.equal(fam.source.available, true);
  const kit = ok(await post(s.coach.token, '/brand-kits', { name: 'Club', display_name: 'Rao Coaching' }));
  const tpl = ok(await post(s.coach.token, '/document-templates', { family: 'coaching_report', name: 'Report', kit_id: kit.id }));
  assert.equal((await post(s.coach.token, '/document-templates', { family: 'coaching_report', name: 'Bad', layout: { blocks: [{ type: 'title' }, { type: 'lines' }] } })).status, 400, 'invoice-only blocks refused');
  ok(await post(s.coach.token, `/document-templates/${tpl.id}/publish`, { row_version: 1 }));
  const doc = ok(await post(s.coach.token, '/branded-documents/coaching-report', { report_id: r.id, template_id: tpl.id }));
  assert.equal(doc.source_version, 1); assert.ok(doc.pages >= 1);
  const pdf = await api('GET', doc.url.replace('/api/v1', ''), { token: s.coach.token, raw: true });
  assert.equal(pdf.status, 200); assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');
  assert.equal((await api('GET', doc.url.replace('/api/v1', ''), { token: s.arjun.token, raw: true })).status, 200, 'the athlete it was published for');
  assert.equal((await api('GET', doc.url.replace('/api/v1', ''), { token: s.kabir.token, raw: true })).status, 404);
  assert.equal((await api('GET', doc.url.replace('/api/v1', ''), { token: s.outsider.token, raw: true })).status, 404);
  assert.equal((await post(s.outsider.token, '/branded-documents/coaching-report', { report_id: r.id })).status, 404);
  assert.equal(ok(await get(s.coach.token, `/branded-documents/coaching-report?report_id=${r.id}`)).length, 1);
});
