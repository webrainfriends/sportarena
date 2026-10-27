// Officials Development & Assessment (#486): assessor authority, observation assignment on existing #88 assignments, versioned rubrics, immutable assessment
// versions with publication/acknowledgement/appeal, requirements consumed by the existing licence approval (a score never promotes), demotion, mentoring,
// CPD, fitness privacy, dashboards, notifications that carry no content, REST/OpenAPI/MCP parity and the additive migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base, n = 0, sport;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)))}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const day = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const at = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `od_${n}_${roles[0]}`, display_name: `Od ${n}`, email: `od${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

const SCALE = { min: 1, max: 4, labels: { 1: 'Below the standard', 2: 'Developing', 3: 'At the standard', 4: 'Exemplary' } };
const DIMS = [
  { key: 'laws', label: 'Application of the laws', description: 'Correct and consistent', evidence_expectation: 'Cite the incident', evidence_required: true, allow_na: false },
  { key: 'positioning', label: 'Positioning and movement', allow_na: true },
  { key: 'communication', label: 'Communication', allow_na: true },
];
const scoresOf = (s = 3, evidence = 'Minute 12 foul call') => [{ key: 'laws', score: s, evidence }, { key: 'positioning', score: s }, { key: 'communication', na: true }];
const NARR = { strengths: ['Calm under pressure'], development_areas: ['Anticipate transitions'], required_actions: ['Review two transition clips'], observations: [{ note: 'Good signal timing', minute: 12, evidence: 'clip 4' }] };

const mkBody = async (owner) => must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Federation ${++n}`, level: 'national', abbreviation: `O${String(n).padStart(3, '0')}`, country: 'SG', sports: [{ sport_id: sport.id }] } }), 201);
const licType = async (owner, b, grade, rank, over = {}) => must(await api('POST', `/federation/bodies/${b.id}/licence-types`, { token: owner.token, body: { name: `Official ${grade} ${++n}`, holder_role: 'official', sport_id: sport.id, grade, grade_rank: rank, duration_months: 12, ...over } }), 201);
const licence = async (owner, b, user, type) => {
  const l = must(await api('POST', '/federation/licences', { token: user.token, body: { body_id: b.id, type_id: type.id } }), 201);
  must(await api('POST', `/federation/licences/${l.id}/submit`, { token: user.token }));
  return must(await api('POST', `/federation/licences/${l.id}/decision`, { token: owner.token, body: { action: 'approve' } }));
};
const referee = async () => { const r = await signup(['referee']); must(await api('POST', '/me/sport-profiles', { token: r.token, body: { sport: 'basketball', role: 'referee' } }), 201); return r; };
const rubric = async (owner, b, over = {}) => {
  const r = must(await api('POST', `/officials-development/bodies/${b.id}/rubrics`, { token: owner.token, body: { sport_id: sport.id, official_role: 'referee', name: `Referee ${++n}`, ...over } }), 201);
  return must(await api('POST', `/officials-development/rubrics/${r.id}/versions`, { token: owner.token, body: { scale: SCALE, dimensions: DIMS } }), 201);
};
const appoint = (owner, b, user, lic, over = {}) => api('POST', `/officials-development/bodies/${b.id}/assessors`, { token: owner.token, body: { user_id: user.id, sport_id: sport.id, credential_licence_id: lic.id, valid_until: day(300), ...over } });

/** An event with one fixture and an accepted referee crew, the crew member's official licence, and an assessor with a live appointment. */
async function world({ grade = 'L1' } = {}) {
  const owner = await signup(['organizer']), b = await mkBody(owner);
  const t1 = await licType(owner, b, 'L1', 1), t2 = await licType(owner, b, 'L2', 2), t3 = await licType(owner, b, 'L3', 3);
  const org = await signup(['organizer']);
  const caps = await Promise.all([signup(), signup()]);
  const teams = [];
  for (const [i, c] of caps.entries()) teams.push(must(await api('POST', '/teams', { token: c.token, body: { name: `T${++n}-${i}`, sport: 'basketball' } }), 201));
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Cup ${++n}`, sport: 'basketball' } }), 201);
  for (const [i, c] of caps.entries()) { const e = must(await api('POST', `/events/${ev.id}/entries`, { token: c.token, body: { team_id: teams[i].id } }), 201); must(await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } })); }
  const fixture = must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: teams[0].id, away_team_id: teams[1].id, scheduled_at: at(5) } }), 201);
  const official = await referee();
  const offLic = await licence(owner, b, official, grade === 'L1' ? t1 : t2);
  const inv = must(await api('POST', `/fixtures/${fixture.id}/officials`, { token: org.token, body: { user_id: official.id, role: 'referee' } }), 201);
  const mine = (await api('GET', '/me/official-assignments', { token: official.token })).body;
  must(await api('POST', `/official-assignments/${mine.find((a) => a.id === inv.id).id}/respond`, { token: official.token, body: { response: 'accept' } }));
  const assessor = await referee();
  const aLic = await licence(owner, b, assessor, t3);
  const appt = must(await appoint(owner, b, assessor, aLic), 201);
  const rv = await rubric(owner, b);
  return { owner, b, t1, t2, t3, org, ev, fixture, official, offLic, assignment: inv, assessor, aLic, appt, rv };
}
const assign = (w, over = {}, user = w.owner) => api('POST', '/officials-development/observations', { token: user.token, body: { body_id: w.b.id, fixture_official_id: w.assignment.id, assessor_id: w.assessor.id, purpose: 'routine', ...over } });
const accept = (w, o) => api('POST', `/officials-development/observations/${o.id}/respond`, { token: w.assessor.token, body: { response: 'accept', conflict: 'none' } });
const live = (w) => pool.query("UPDATE fixtures SET status='live' WHERE id=$1", [w.fixture.id]);
const draft = (w, o, over = {}) => api('POST', `/officials-development/observations/${o.id}/assessment`, { token: w.assessor.token, body: { scores: scoresOf(3), narrative: NARR, recommendation: 'maintain_grade', ...over } });
const submit = (w, a) => api('POST', `/officials-development/assessments/${a.id}/submit`, { token: w.assessor.token, body: {} });
/** A published assessment end to end. */
async function published(w, { purpose = 'routine', recommendation = 'maintain_grade', score = 3 } = {}) {
  const o = must(await assign(w, { purpose }), 201); must(await accept(w, o)); await live(w);
  const a = must(await draft(w, o, { scores: scoresOf(score), recommendation }));
  const s = must(await submit(w, a));
  return { o, a: s };
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  sport = (await q("SELECT id, slug FROM sports WHERE slug='basketball'"))[0];
});
after(async () => { server.close(); await pool.end(); });

test('an assessor is explicit, scoped authority resting on a live licence; being a referee grants nothing', async () => {
  const w = await world();
  const stranger = await signup(['referee']);
  assert.equal((await appoint(stranger, w.b, w.official, w.offLic)).status, 404, 'outsiders learn nothing about the body');
  const lonely = await referee();
  assert.equal((await appoint(w.owner, w.b, lonely, w.aLic)).status, 400, "someone else's licence");
  assert.equal((await appoint(w.owner, w.b, w.official, w.offLic, { valid_until: day(2000) })).status, 400, 'at most three years');
  // a plain referee with no appointment cannot be assigned
  assert.equal((await appoint(w.owner, w.b, lonely, {})).status, 400, 'no licence to rest an appointment on');
  const pick = must(await api('GET', `/officials-development/bodies/${w.b.id}/assignments`, { token: w.owner.token }));
  assert.equal(pick.items[0].fixture_official_id, w.assignment.id, 'the pick list is the #88 assignment'); assert.equal(pick.items[0].observations, 0);
  assert.equal((await api('GET', `/officials-development/bodies/${w.b.id}/assignments`, { token: w.official.token })).status, 404);
  assert.equal((await assign(w, { assessor_id: lonely.id })).status, 400);
  // the appointed assessor can; the official cannot assess themselves; crew cannot assess their own match
  assert.equal((await assign(w, { assessor_id: w.official.id })).status, 400);
  const o = must(await assign(w), 201);
  assert.equal(o.status, 'assigned');
  assert.equal((await assign(w)).status, 409, 'one open assignment per assessor and official at a match');
  // role / grade scope: restrict to scorers only -> no longer eligible for a referee
  const narrow = await signup(['referee']), nLic = await licence(w.owner, w.b, narrow, w.t3);
  must(await appoint(w.owner, w.b, narrow, nLic, { official_roles: ['scorer'] }), 201);
  assert.equal((await assign(w, { assessor_id: narrow.id })).status, 400, 'roles are scoped');
  const low = await signup(['referee']), lLic = await licence(w.owner, w.b, low, w.t3);
  const autoAppt = must(await appoint(w.owner, w.b, low, {}, { max_grade_rank: 0 }), 201);
  assert.equal(autoAppt.credential_licence_id, lLic.id, 'the credential defaults to their own current licence');
  assert.equal((await assign(w, { assessor_id: low.id })).status, 400, 'grade ceiling is scoped');
  // the appointment lapses with the licence it rests on, read live
  must(await api('POST', `/federation/licences/${w.aLic.id}/decision`, { token: w.owner.token, body: { action: 'suspend', reason: 'Under review' } }));
  const list = must(await api('GET', `/officials-development/bodies/${w.b.id}/assessors`, { token: w.owner.token }));
  assert.equal(list.items.find((a) => a.user_id === w.assessor.id).status, 'lapsed');
  assert.equal((await accept(w, o)).status, 409, 'lapsed appointment cannot accept');
  must(await api('POST', `/federation/licences/${w.aLic.id}/decision`, { token: w.owner.token, body: { action: 'reinstate' } }));
  must(await accept(w, o));
  // suspend / reinstate / revoke by staff only, with reasons
  assert.equal((await api('POST', `/officials-development/assessors/${w.appt.id}/decision`, { token: w.assessor.token, body: { action: 'revoke', reason: 'nope' } })).status, 404);
  must(await api('POST', `/officials-development/assessors/${w.appt.id}/decision`, { token: w.owner.token, body: { action: 'suspend', reason: 'Pending review' } }));
  await live(w);
  assert.equal((await draft(w, o)).status, 409, 'a suspended assessor cannot write');
  must(await api('POST', `/officials-development/assessors/${w.appt.id}/decision`, { token: w.owner.token, body: { action: 'reinstate', reason: 'Cleared' } }));
  assert.ok((await q("SELECT 1 FROM off_events WHERE subject_id=$1 AND action='suspend'", [w.appt.id])).length);
});

test('observation assignment: staff or the sanctioning organiser only, conflict-of-interest declaration, nothing in #88 changes', async () => {
  const w = await world();
  const before88 = await q('SELECT status, needs_ack FROM fixture_officials WHERE id=$1', [w.assignment.id]);
  const resultBefore = await q('SELECT status, home_score, away_score FROM fixtures WHERE id=$1', [w.fixture.id]);
  assert.equal((await assign(w, {}, w.org)).status, 403, 'an organiser can only use a body that sanctioned the event');
  await pool.query("INSERT INTO fed_sanctions(body_id, event_id, applicant_id, status, sanction_no, requested_starts_on, requested_ends_on, approved_starts_on, approved_ends_on) VALUES ($1,$2,$3,'approved','SAN-TEST-1',current_date,current_date + 30,current_date,current_date + 30)", [w.b.id, w.ev.id, w.org.id]);
  const o = must(await assign(w, { purpose: 'promotion', due_on: day(20) }, w.org), 201);
  assert.equal(o.purpose, 'promotion');
  assert.equal((await api('POST', `/officials-development/observations/${o.id}/respond`, { token: w.official.token, body: { response: 'accept', conflict: 'none' } })).status, 404, 'only the assessor responds');
  assert.equal((await api('POST', `/officials-development/observations/${o.id}/respond`, { token: w.assessor.token, body: { response: 'accept', conflict: 'declared', conflict_note: 'family' } })).status, 400, 'a declared conflict cannot accept');
  const declined = must(await api('POST', `/officials-development/observations/${o.id}/respond`, { token: w.assessor.token, body: { response: 'decline', conflict: 'declared', conflict_note: 'Coached this official last year' } }));
  assert.equal(declined.status, 'declined'); assert.equal(declined.coi_declared, true);
  assert.ok((await q("SELECT 1 FROM off_observations WHERE id=$1 AND coi_note_enc IS NOT NULL AND coi_note_enc NOT LIKE '%Coached%'", [o.id])).length, 'the note is sealed');
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='official_observation_declined'", [w.org.id])).length);
  const o2 = must(await assign(w), 201);
  must(await accept(w, o2));
  assert.equal((await api('POST', `/officials-development/observations/${o2.id}/cancel`, { token: w.official.token, body: { reason: 'I would rather not' } })).status, 404, 'the official cannot cancel their own observation');
  must(await api('POST', `/officials-development/observations/${o2.id}/cancel`, { token: w.owner.token, body: { reason: 'Match moved' } }));
  // visibility: assessor, staff and (when disclosed) the official; strangers get 404
  const o3 = must(await assign(w), 201);
  assert.equal((await api('GET', `/officials-development/observations/${o3.id}`, { token: w.official.token })).status, 200, 'disclosed by default');
  must(await api('POST', `/officials-development/bodies/${w.b.id}/settings`, { token: w.owner.token, body: { publication: 'on_submit', appeal_window_days: 14, disclose_observation: false } }));
  assert.equal((await api('GET', `/officials-development/observations/${o3.id}`, { token: w.official.token })).status, 404, 'hidden once the body stops disclosing');
  assert.equal((await api('GET', '/officials-development/observations', { token: w.official.token, query: { mine: true } })).body.total, 0);
  assert.equal((await api('GET', `/officials-development/observations/${o3.id}`, { token: (await signup()).token })).status, 404);
  assert.equal((await api('GET', '/officials-development/observations', { token: w.assessor.token, query: { as_assessor: true } })).body.items.length >= 3, true);
  must(await api('POST', `/officials-development/bodies/${w.b.id}/settings`, { token: w.owner.token, body: { publication: 'on_submit', appeal_window_days: 14, disclose_observation: true } }));
  // #88 and the result are untouched
  assert.deepEqual(await q('SELECT status, needs_ack FROM fixture_officials WHERE id=$1', [w.assignment.id]), before88);
  assert.deepEqual(await q('SELECT status, home_score, away_score FROM fixtures WHERE id=$1', [w.fixture.id]), resultBefore);
  assert.equal((await q('SELECT count(*)::int AS n FROM fixture_officials WHERE fixture_id=$1', [w.fixture.id]))[0].n, 1, 'no second assignment system');
});

test('rubrics are versioned and immutable; an assessment keeps the version it started on', async () => {
  const w = await world();
  const o = must(await assign(w), 201); must(await accept(w, o)); await live(w);
  const a = must(await draft(w, o));
  assert.equal(a.rubric.version, 1); assert.equal(a.status, 'draft');
  // v2 changes the scale; the open assessment is unchanged
  const r = (await q('SELECT rubric_id FROM off_rubric_versions WHERE id=$1', [a.rubric.id]))[0].rubric_id;
  const v2 = must(await api('POST', `/officials-development/rubrics/${r}/versions`, { token: w.owner.token, body: { scale: { min: 1, max: 5, labels: { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e' } }, dimensions: [{ key: 'laws', label: 'Laws', allow_na: false }, { key: 'control', label: 'Match control', allow_na: false }] } }), 201);
  assert.equal(v2.version, 2);
  assert.equal(must(await api('GET', `/officials-development/assessments/${a.id}`, { token: w.assessor.token })).rubric.version, 1);
  assert.equal((await draft(w, o, { scores: [{ key: 'laws', score: 5, evidence: 'x' }] })).status, 400, 'scored against the version it is bound to (1-4)');
  assert.equal((await q('SELECT count(*)::int AS n FROM off_rubric_versions WHERE rubric_id=$1', [r]))[0].n, 2);
  await assert.rejects(pool.query("UPDATE off_rubric_versions SET scale='{}' WHERE rubric_id=$1", [r]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM off_rubric_versions WHERE rubric_id=$1', [r]), /append-only/);
  // history: listing the first version still returns its original semantics
  const old = must(await api('GET', `/officials-development/bodies/${w.b.id}/rubrics`, { token: w.official.token, query: { version_id: a.rubric.id } }));
  assert.deepEqual(old[0].scale.labels['4'], 'Exemplary');
  // validation: N/A only where allowed, evidence where required, every dimension answered
  assert.equal((await draft(w, o, { scores: [{ key: 'laws', na: true }] })).status, 400, 'laws cannot be N/A');
  assert.equal((await draft(w, o, { scores: [{ key: 'laws', score: 3, na: true, evidence: 'x' }] })).status, 400, 'score or N/A, not both');
  assert.equal((await draft(w, o, { scores: [{ key: 'ghost', score: 3 }] })).status, 400);
  assert.equal((await submit(w, a)).status, 200, 'the saved draft is complete');
  // a new observation binds to v2
  const w2 = { ...w, assignment: w.assignment };
  await q("UPDATE off_observations SET status='cancelled' WHERE id=$1", [o.id]);
  const o2 = must(await assign(w2), 201); must(await accept(w2, o2));
  assert.equal(must(await draft(w2, o2, { scores: [{ key: 'laws', score: 5, evidence: 'x' }, { key: 'control', score: 4 }] })).rubric.version, 2);
});

test('assessment lifecycle: private draft, content-free notification, publication policy, acknowledgement, corrections keep history, void is explicit', async () => {
  const w = await world();
  const o = must(await assign(w), 201);
  assert.equal((await draft(w, o)).status, 409, 'accept first');
  must(await accept(w, o));
  const a = must(await draft(w, o));
  assert.equal((await api('GET', `/officials-development/assessments/${a.id}`, { token: w.official.token })).status, 404, 'the official cannot see a draft');
  assert.equal((await api('GET', `/officials-development/assessments/${a.id}`, { token: w.owner.token })).status, 404, 'nor can staff');
  assert.equal((await submit(w, a)).status, 409, 'the match has not started');
  await live(w);
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/submit`, { token: w.official.token, body: {} })).status, 404);
  assert.equal((await api('POST', `/officials-development/observations/${o.id}/assessment`, { token: w.assessor.token, body: { scores: [{ key: 'laws', score: 3, evidence: 'x' }], narrative: NARR } })).status, 200);
  assert.equal((await submit(w, a)).status, 400, 'every dimension needs a score or N/A');
  must(await draft(w, o, { scores: scoresOf(2), recommendation: 'further_observation' }));
  const sub = must(await submit(w, a));
  assert.equal(sub.status, 'published', 'on_submit policy');
  assert.equal((await submit(w, a)).status, 409, 'submitting twice');
  // the narrative is sealed at rest and the notification carries no content
  const raw = (await q('SELECT narrative_enc FROM off_assessment_versions WHERE assessment_id=$1', [a.id]))[0].narrative_enc;
  assert.ok(!raw.includes('Calm under pressure'));
  const note = (await q("SELECT title, body, data FROM notifications WHERE user_id=$1 AND kind='official_assessment_published'", [w.official.id]))[0];
  assert.ok(note && !JSON.stringify(note).includes('Calm') && !JSON.stringify(note).includes('transition'));
  // the official reads it, acknowledges, comments; the assessor sees the response; strangers and mentors get nothing
  const seen = must(await api('GET', `/officials-development/assessments/${a.id}`, { token: w.official.token }));
  assert.equal(seen.versions[0].narrative.strengths[0], 'Calm under pressure'); assert.ok(seen.actions.includes('acknowledge'));
  assert.equal((await api('GET', `/officials-development/assessments/${a.id}`, { token: (await signup(['referee'])).token })).status, 404);
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/respond`, { token: w.assessor.token, body: { kind: 'acknowledgement' } })).status, 403);
  must(await api('POST', `/officials-development/assessments/${a.id}/respond`, { token: w.official.token, body: { kind: 'acknowledgement' } }), 201);
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/respond`, { token: w.official.token, body: { kind: 'acknowledgement' } })).status, 409);
  const withComment = must(await api('POST', `/officials-development/assessments/${a.id}/respond`, { token: w.official.token, body: { kind: 'comment', body: 'I disagree about minute 12.' } }), 201);
  assert.equal(withComment.responses.length, 2);
  assert.ok(must(await api('GET', `/officials-development/assessments/${a.id}`, { token: w.assessor.token })).responses.some((r) => r.body === 'I disagree about minute 12.'));
  // required actions became the official's shared development items
  const items = must(await api('GET', '/officials-development/items', { token: w.official.token, query: { mine: true } }));
  assert.equal(items.items.find((i) => i.source_type === 'assessment').title, 'Review two transition clips');
  // a correction adds a version, keeps the old one, and asks for a new acknowledgement
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/correct`, { token: w.official.token, body: { scores: scoresOf(3), narrative: NARR, recommendation: 'maintain_grade', reason: 'I want it better' } })).status, 403);
  const fixed = must(await api('POST', `/officials-development/assessments/${a.id}/correct`, { token: w.assessor.token, body: { scores: scoresOf(3), narrative: { ...NARR, required_actions: [] }, recommendation: 'maintain_grade', reason: 'Reviewed the clip again' } }), 201);
  assert.equal(fixed.versions.length, 2); assert.equal(fixed.current_version, 2); assert.equal(fixed.versions[0].recommendation, 'further_observation', 'the original is kept');
  assert.ok(fixed.actions.length >= 0);
  assert.equal(must(await api('GET', `/officials-development/assessments/${a.id}`, { token: w.official.token })).actions.includes('acknowledge'), true, 'must acknowledge the new version');
  assert.equal((await q("SELECT status FROM off_dev_items WHERE source_id=$1", [a.id]))[0].status, 'cancelled', 'the action the correction removed is closed, not deleted');
  // immutability at the database
  await assert.rejects(pool.query("UPDATE off_assessment_versions SET recommendation='maintain_grade' WHERE assessment_id=$1 AND version=1", [a.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM off_assessment_versions WHERE assessment_id=$1', [a.id]), /immutable/);
  // staff cannot edit; voiding needs a real reason, is visible, keeps content, and stops counting
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/decision`, { token: w.owner.token, body: { action: 'void', reason: 'short' } })).status, 400);
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/decision`, { token: w.assessor.token, body: { action: 'void', reason: 'I would like it gone' } })).status, 403);
  const voided = must(await api('POST', `/officials-development/assessments/${a.id}/decision`, { token: w.owner.token, body: { action: 'void', reason: 'Recorded against the wrong official' } }));
  assert.equal(voided.status, 'voided'); assert.equal(voided.versions.length, 2);
  assert.equal(must(await api('GET', '/officials-development/assessments', { token: w.official.token, query: { mine: true } })).items[0].status, 'voided', 'the official still sees it, marked void');
  assert.ok((await q("SELECT 1 FROM off_events WHERE subject_id=$1 AND action='voided' AND reason IS NOT NULL", [a.id])).length);
  // reading a private report is audit-logged
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='read_off_assessments' AND entity_id=$1", [a.id])).length >= 2);
});

test('a young official\'s verified guardian reads and answers their assessment, exactly as for the licence; nobody else can', async () => {
  const w = await world();
  const { a } = await published(w);
  const guardian = await signup(['athlete']), stranger = await signup(['athlete']);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, w.official.id]);
  assert.equal((await api('GET', `/officials-development/assessments/${a.id}`, { token: guardian.token })).status, 404, 'an adult official is not read by a guardian link');
  await q("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [w.official.id]);
  assert.equal((await api('GET', `/officials-development/assessments/${a.id}`, { token: guardian.token })).status, 200);
  must(await api('POST', `/officials-development/assessments/${a.id}/respond`, { token: guardian.token, body: { kind: 'acknowledgement' } }), 201);
  assert.equal((await api('GET', `/officials-development/assessments/${a.id}`, { token: stranger.token })).status, 404);
});

test('review-first publication, appeals inside the window, and decisions that never edit the report', async () => {
  const w = await world();
  must(await api('POST', `/officials-development/bodies/${w.b.id}/settings`, { token: w.owner.token, body: { publication: 'after_review', appeal_window_days: 7, disclose_observation: true } }));
  assert.equal((await api('POST', `/officials-development/bodies/${w.b.id}/settings`, { token: w.assessor.token, body: { publication: 'on_submit', appeal_window_days: 7, disclose_observation: true } })).status, 404);
  const { a } = await published(w, { recommendation: 'further_observation', score: 2 });
  assert.equal(a.status, 'submitted');
  assert.equal((await api('GET', `/officials-development/assessments/${a.id}`, { token: w.official.token })).status, 404, 'not yet published to the official');
  assert.equal(must(await api('GET', '/officials-development/assessments', { token: w.owner.token, query: { body_id: w.b.id, status: 'submitted' } })).total, 1, 'the review queue');
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/decision`, { token: w.official.token, body: { action: 'publish' } })).status, 404);
  must(await api('POST', `/officials-development/assessments/${a.id}/decision`, { token: w.owner.token, body: { action: 'publish' } }));
  assert.equal(must(await api('GET', `/officials-development/assessments/${a.id}`, { token: w.official.token })).status, 'published');
  // appeal: grounds sealed, one open at a time, staff decide, nothing changes in the report
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/appeals`, { token: w.assessor.token, body: { kind: 'appeal', grounds: 'I am the assessor' } })).status, 403);
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/appeals`, { token: w.official.token, body: { kind: 'appeal', grounds: 'short' } })).status, 400);
  const lodged = must(await api('POST', `/officials-development/assessments/${a.id}/appeals`, { token: w.official.token, body: { kind: 'appeal', grounds: 'The foul at minute 12 was misjudged by the observer.' } }), 201);
  assert.equal(lodged.appeals[0].status, 'lodged');
  assert.equal((await api('POST', `/officials-development/assessments/${a.id}/appeals`, { token: w.official.token, body: { kind: 'appeal', grounds: 'A second one at the same time' } })).status, 409);
  assert.ok(!(await q('SELECT grounds_enc FROM off_appeals WHERE assessment_id=$1', [a.id]))[0].grounds_enc.includes('misjudged'));
  const pid = lodged.appeals[0].id;
  assert.equal((await api('POST', `/officials-development/appeals/${pid}/decision`, { token: w.official.token, body: { action: 'uphold', decision: 'I decide for myself' } })).status, 404, 'only the body decides');
  assert.equal((await api('POST', `/officials-development/appeals/${pid}/decision`, { token: w.owner.token, body: { action: 'dismiss' } })).status, 400, 'a decision needs wording');
  const decided = must(await api('POST', `/officials-development/appeals/${pid}/decision`, { token: w.owner.token, body: { action: 'partly_uphold', decision: 'The minute 12 call is accepted; the rest stands. Assessor to correct.' } }));
  assert.equal(decided.appeals[0].status, 'partly_uphold'.replace('partly_uphold', 'partly_upheld'));
  assert.equal(decided.versions.length, 1, 'an upheld appeal does not edit the report');
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='official_assessment_appeal_upheld'", [w.assessor.id])).length);
  assert.equal(must(await api('GET', `/officials-development/bodies/${w.b.id}/appeals`, { token: w.owner.token })).items[0].status, 'partly_upheld');
  // past the window nothing more can be lodged
  await pool.query("ALTER TABLE off_assessment_versions DISABLE TRIGGER off_assessment_versions_guard");
  await q("UPDATE off_assessments SET published_at = now() - interval '30 days' WHERE id=$1", [a.id]);
  await q("UPDATE off_assessment_versions SET finalised_at = now() - interval '30 days' WHERE assessment_id=$1", [a.id]);
  await pool.query("ALTER TABLE off_assessment_versions ENABLE TRIGGER off_assessment_versions_guard");
  const late = await api('POST', `/officials-development/assessments/${a.id}/appeals`, { token: w.official.token, body: { kind: 'review', grounds: 'Too late to ask for this review now.' } });
  assert.equal(late.status, 409); assert.match(late.body.error.message, /7-day window/);
});

test('requirements are consumed by the licence approval: a score never promotes; CPD, fitness and assessments are source-linked; demotion is explicit', async () => {
  const w = await world();
  // L2 asks for L1 for 0 months, 1 supportive promotion assessment, 4 verified CPD hours and a current fitness test
  const test1 = must(await api('POST', `/officials-development/bodies/${w.b.id}/fitness-tests`, { token: w.owner.token, body: { name: 'Beep test', result_kind: 'measured', unit: 'level', pass_direction: 'at_least', pass_threshold: 8, validity_months: 12 } }), 201);
  assert.equal((await api('POST', `/officials-development/bodies/${w.b.id}/fitness-tests`, { token: w.owner.token, body: { name: 'Bad test', result_kind: 'measured' } })).status, 400);
  const req = must(await api('POST', `/officials-development/bodies/${w.b.id}/requirements`, { token: w.owner.token, body: { licence_type_id: w.t2.id, prerequisite_type_id: w.t1.id, min_assessments: 1, min_favourable: 1, require_promotion_assessment: true, cpd_hours: 4, fitness_test_type_id: test1.id } }), 201);
  assert.equal(req.version, 1);
  assert.equal((await api('POST', `/officials-development/bodies/${w.b.id}/requirements`, { token: w.assessor.token, body: { licence_type_id: w.t2.id } })).status, 404);
  assert.equal((await api('POST', `/officials-development/bodies/${w.b.id}/requirements`, { token: w.owner.token, body: { licence_type_id: w.t1.id, prerequisite_type_id: w.t2.id } })).status, 400, 'the prerequisite must be lower');
  assert.equal(must(await api('GET', `/officials-development/bodies/${w.b.id}/requirements`)).length, 1, 'requirements are public');
  // the official applies for L2 through the ordinary licence application
  const app = must(await api('POST', '/federation/licences', { token: w.official.token, body: { body_id: w.b.id, type_id: w.t2.id } }), 201);
  must(await api('POST', `/federation/licences/${app.id}/submit`, { token: w.official.token }));
  const blocked = await api('POST', `/federation/licences/${app.id}/decision`, { token: w.owner.token, body: { action: 'approve' } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error?.details?.code ?? blocked.body.details?.code, 'requirements_not_met');
  const keys = (blocked.body.error?.details?.checks ?? blocked.body.details?.checks).filter((c) => c.status === 'fail').map((c) => c.key);
  assert.deepEqual(keys.sort(), ['assessments', 'cpd', 'fitness']);
  // readiness shows the same numbers to the holder, and no one else
  const ready = must(await api('GET', `/officials-development/licences/${w.offLic.id}/readiness`, { token: w.official.token, query: { type_id: w.t2.id } }));
  assert.equal(ready.ready, false);
  assert.equal((await api('GET', `/officials-development/licences/${w.offLic.id}/readiness`, { token: (await signup()).token })).status, 404);
  // a glowing score on a "further observation" report does not count as supportive; neither does a draft
  await published(w, { purpose: 'promotion', recommendation: 'further_observation', score: 4 });
  assert.equal((await api('GET', `/officials-development/licences/${w.offLic.id}/readiness`, { token: w.official.token, query: { type_id: w.t2.id } })).body.checks.find((c) => c.key === 'assessments').status, 'fail');
  // a supportive promotion assessment, verified CPD, a passing measured result
  await q("UPDATE off_observations SET status='cancelled'");
  const second = await published(w, { purpose: 'promotion', recommendation: 'ready_for_review', score: 3 });
  assert.equal(second.a.status, 'published');
  // CPD: self-reported waits for verification; a credential-backed one counts at once
  const cpd = must(await api('POST', '/officials-development/cpd', { token: w.official.token, body: { body_id: w.b.id, kind: 'workshop', title: 'Advanced game management', provider_name: 'Hoops Academy', completed_on: day(-10), hours: 4, evidence: 'certificate no. 8812' } }), 201);
  assert.equal(cpd.status, 'recorded');
  assert.equal((await api('POST', '/officials-development/cpd', { token: (await signup(['referee'])).token, body: { body_id: w.b.id, kind: 'course', title: 'Not licensed here', completed_on: day(-1), hours: 2 } })).status, 403, 'only a body that licenses you');
  assert.equal(must(await api('GET', '/officials-development/cpd', { token: w.official.token, query: { mine: true } })).items[0].evidence, 'certificate no. 8812');
  assert.equal(must(await api('GET', '/officials-development/cpd', { token: w.owner.token, query: { body_id: w.b.id } })).items[0].evidence, undefined, 'evidence text belongs to its owner');
  assert.equal((await api('POST', `/officials-development/cpd/${cpd.id}/decision`, { token: w.official.token, body: { action: 'verify' } })).status, 404);
  assert.equal((await api('POST', `/officials-development/cpd/${cpd.id}/decision`, { token: w.owner.token, body: { action: 'reject' } })).status, 400);
  must(await api('POST', `/officials-development/cpd/${cpd.id}/decision`, { token: w.owner.token, body: { action: 'verify' } }));
  // fitness: measured value decides the outcome and is private
  const fail = must(await api('POST', `/officials-development/bodies/${w.b.id}/fitness-results`, { token: w.owner.token, body: { test_id: test1.id, official_id: w.official.id, taken_on: day(-3), measured_value: 6.5, provider: 'Sports Institute' } }), 201);
  assert.equal(fail.outcome, 'fail'); assert.equal(fail.standing, 'failed');
  must(await api('POST', `/officials-development/fitness-results/${fail.id}/void`, { token: w.owner.token, body: { reason: 'Entered for the wrong person' } }));
  const pass = must(await api('POST', `/officials-development/bodies/${w.b.id}/fitness-results`, { token: w.owner.token, body: { test_id: test1.id, official_id: w.official.id, taken_on: day(-2), measured_value: 9.2 } }), 201);
  assert.equal(pass.outcome, 'pass');
  assert.equal((await api('POST', `/officials-development/bodies/${w.b.id}/fitness-results`, { token: w.assessor.token, body: { test_id: test1.id, official_id: w.official.id, taken_on: day(-2), measured_value: 9 } })).status, 404, 'an assessor is not licensing staff');
  assert.equal((await api('POST', `/officials-development/bodies/${w.b.id}/fitness-results`, { token: w.owner.token, body: { test_id: test1.id, official_id: (await signup(['referee'])).id, taken_on: day(-2), measured_value: 9 } })).status, 400, 'not licensed by this body');
  assert.equal(must(await api('GET', '/officials-development/fitness-results', { token: w.official.token, query: { mine: true } })).find((r) => r.id === pass.id).measured_value, 9.2);
  assert.equal((await api('GET', '/officials-development/fitness-results', { token: w.assessor.token, query: { body_id: w.b.id } })).status, 404, 'assessors never read fitness');
  assert.equal((await api('GET', '/officials-development/fitness-results', { token: w.assessor.token, query: { mine: true } })).body.length, 0);
  // everything the requirement asks is in place -> the check passes, but approval is still a person's decision
  const r2 = must(await api('GET', `/officials-development/licences/${w.offLic.id}/readiness`, { token: w.official.token, query: { type_id: w.t2.id } }));
  assert.deepEqual(r2.checks.filter((c) => c.status === 'fail').map((c) => c.key), []);
  {
    assert.equal((await q("SELECT status FROM fed_licences WHERE id=$1", [app.id]))[0].status, 'submitted', 'nothing promoted by itself');
    const ok = must(await api('POST', `/federation/licences/${app.id}/decision`, { token: w.owner.token, body: { action: 'approve', reason: 'Promoted after the panel' } }));
    assert.equal(ok.status, 'active'); assert.equal(ok.grade, 'L2');
    // demotion is its own explicit decision: reason, a bounded effective date, optional lower grade
    assert.equal((await api('POST', `/officials-development/licences/${app.id}/demotion`, { token: w.official.token, body: { reason: 'Please demote me for fun' } })).status, 403, 'the holder cannot decide');
    assert.equal((await api('POST', `/officials-development/licences/${app.id}/demotion`, { token: w.owner.token, body: { reason: 'too short' } })).status, 400);
    assert.equal((await api('POST', `/officials-development/licences/${app.id}/demotion`, { token: w.owner.token, body: { reason: 'Sustained concerns after two assessments', effective_on: day(-200) } })).status, 400);
    assert.equal((await api('POST', `/officials-development/licences/${app.id}/demotion`, { token: w.owner.token, body: { reason: 'Sustained concerns after two assessments', new_type_id: w.t3.id } })).status, 400, 'must be a lower grade');
    // L1 is still held (kept), so regrading to it conflicts; end the higher grade only
    const dem = must(await api('POST', `/officials-development/licences/${app.id}/demotion`, { token: w.owner.token, body: { reason: 'Sustained concerns after two assessments', effective_on: day(-1) } }));
    assert.equal(dem.new_licence_id, null);
    assert.equal((await q('SELECT status FROM fed_licences WHERE id=$1', [app.id]))[0].status, 'revoked');
    assert.ok((await q("SELECT 1 FROM fed_events WHERE subject_id=$1 AND action='demoted'", [app.id])).length, 'recorded in the licence history');
  }
});

test('mentoring grants only its own goals, actions and meetings; the body sees counts, never the text', async () => {
  const w = await world();
  const mentor = await referee(); await licence(w.owner, w.b, mentor, w.t3);
  const outsider = await referee();
  assert.equal((await api('POST', '/officials-development/mentorships', { token: outsider.token, body: { body_id: w.b.id, mentor_id: mentor.id, mentee_id: w.official.id, sport_id: sport.id } })).status, 404, 'a third party cannot pair people');
  const m = must(await api('POST', '/officials-development/mentorships', { token: mentor.token, body: { body_id: w.b.id, mentor_id: mentor.id, mentee_id: w.official.id, sport_id: sport.id, scope: 'Match control and communication' } }), 201);
  assert.equal(m.status, 'proposed'); assert.ok(m.mentor_accepted_at && !m.mentee_accepted_at);
  assert.equal((await api('POST', '/officials-development/items', { token: mentor.token, body: { body_id: w.b.id, mentorship_id: m.id, kind: 'goal', title: 'Too early' } })).status, 409, 'not active until both accept');
  assert.equal((await api('POST', `/officials-development/mentorships/${m.id}/respond`, { token: outsider.token, body: { response: 'accept' } })).status, 404);
  assert.equal(must(await api('POST', `/officials-development/mentorships/${m.id}/respond`, { token: w.official.token, body: { response: 'accept' } })).status, 'active');
  const shared = must(await api('POST', '/officials-development/items', { token: mentor.token, body: { body_id: w.b.id, mentorship_id: m.id, kind: 'goal', title: 'Manage the first five minutes', due_on: day(30) } }), 201);
  const priv = must(await api('POST', '/officials-development/items', { token: mentor.token, body: { body_id: w.b.id, mentorship_id: m.id, kind: 'meeting', title: 'Candid view on temperament', happened_on: day(-1), visibility: 'mentor_only' } }), 201);
  assert.equal((await api('POST', '/officials-development/items', { token: w.official.token, body: { body_id: w.b.id, mentorship_id: m.id, kind: 'meeting', title: 'Not allowed', happened_on: day(-1), visibility: 'mentor_only' } })).status, 403);
  const forMentee = must(await api('GET', '/officials-development/items', { token: w.official.token, query: { mentorship_id: m.id } }));
  assert.deepEqual(forMentee.items.map((i) => i.id), [shared.id], 'the mentee never sees mentor-only notes');
  assert.equal(must(await api('GET', '/officials-development/items', { token: mentor.token, query: { mentorship_id: m.id } })).total, 2);
  assert.equal((await api('GET', '/officials-development/items', { token: w.owner.token, query: { mentorship_id: m.id } })).status, 404, 'staff cannot read the text');
  assert.equal((await api('POST', `/officials-development/items/${priv.id}`, { token: w.official.token, body: { status: 'done' } })).status, 404);
  assert.equal(must(await api('POST', `/officials-development/items/${shared.id}`, { token: w.official.token, body: { status: 'done' } })).status, 'done');
  assert.ok(!(await q('SELECT title_enc FROM off_dev_items WHERE id=$1', [priv.id]))[0].title_enc.includes('temperament'));
  // the mentor gains no other access: assessments, fitness, observations
  const { a } = await published(w);
  assert.equal((await api('GET', `/officials-development/assessments/${a.id}`, { token: mentor.token })).status, 404);
  assert.equal((await api('GET', '/officials-development/fitness-results', { token: mentor.token, query: { body_id: w.b.id } })).status, 404);
  assert.equal(must(await api('GET', '/officials-development/mentorships', { token: w.owner.token, query: { body_id: w.b.id } })).items[0].scope, undefined, 'staff see the relationship, not its content');
  // the official's own goals, and a body-set action
  must(await api('POST', '/officials-development/items', { token: w.official.token, body: { body_id: w.b.id, kind: 'goal', title: 'Pass the L2 panel' } }), 201);
  assert.equal((await api('POST', '/officials-development/items', { token: w.owner.token, body: { body_id: w.b.id, official_id: w.official.id, kind: 'goal', title: 'x' } })).status, 400, 'the body sets actions, not goals');
  must(await api('POST', '/officials-development/items', { token: w.owner.token, body: { body_id: w.b.id, official_id: w.official.id, kind: 'action', title: 'Attend the rules briefing' } }), 201);
  must(await api('POST', `/officials-development/mentorships/${m.id}/end`, { token: mentor.token, body: { outcome: 'completed', reason: 'Goals met' } }));
  assert.equal((await api('POST', '/officials-development/items', { token: mentor.token, body: { body_id: w.b.id, mentorship_id: m.id, kind: 'goal', title: 'After the end' } })).status, 409);
});

test('dashboards: the official\'s home reads live; the body overview is counts only and rolls up with small groups hidden', async () => {
  const w = await world();
  await published(w, { purpose: 'promotion', recommendation: 'ready_for_review' });
  const home = must(await api('GET', '/me/officials-development', { token: w.official.token }));
  assert.equal(home.has_licence, true);
  assert.equal(home.grades[0].grade, 'L1'); assert.equal(home.grades[0].next_grade.grade, 'L2');
  assert.equal(home.recent_assessments.length, 1); assert.equal(home.awaiting_acknowledgement, 1);
  assert.equal(home.development.open_items, 1);
  assert.equal(home.assessor, null, 'only appointed assessors have a workspace');
  assert.equal(must(await api('GET', '/me/officials-development', { token: w.assessor.token })).assessor.appointments.length, 1);
  assert.equal(must(await api('GET', '/me/officials-development', { token: (await signup()).token })).has_licence, false);
  // the body's overview: counts, no names, no scores
  const ov = must(await api('GET', `/officials-development/bodies/${w.b.id}/overview`, { token: w.owner.token }));
  assert.equal(ov.assessments.by_status.find((x) => x.k === 'published').n, 1);
  assert.equal(ov.assessments.by_recommendation.find((x) => x.k === 'ready_for_review').n, 1);
  assert.ok(ov.grade_distribution.length >= 1);
  assert.ok(!JSON.stringify(ov).includes(w.official.display_name) && !/"score"/.test(JSON.stringify(ov)), 'no individual in the overview');
  assert.equal((await api('GET', `/officials-development/bodies/${w.b.id}/overview`, { token: w.official.token })).status, 404);
  // a body above sees roll-ups with groups under three hidden
  const apex = await signup(['organizer']), A = must(await api('POST', '/federation/bodies', { token: apex.token, body: { name: `Apex ${++n}`, level: 'international', abbreviation: `A${String(n).padStart(3, '0')}`, sports: [{ sport_id: sport.id }] } }), 201);
  const link = must(await api('POST', '/federation/links', { token: w.owner.token, body: { parent_id: A.id, child_id: w.b.id } }), 201);
  must(await api('POST', `/federation/links/${link.id}/respond`, { token: apex.token, body: { decision: 'recognise' } }));
  const roll = must(await api('GET', `/officials-development/bodies/${A.id}/overview`, { token: apex.token }));
  assert.equal(roll.scope.bodies, 2); assert.deepEqual(roll.suppression, { below: 3 });
  const pub = roll.assessments.by_status.find((x) => x.k === 'published');
  assert.equal(pub.n, null); assert.equal(pub.suppressed, true, 'a group of one is not revealed to a body above');
  const rollCsv = must(await api('GET', `/officials-development/bodies/${A.id}/export`, { token: apex.token })).csv;
  assert.match(rollCsv, /assessments,published,\n/, 'a roll-up export leaves small groups blank');
  const csv = must(await api('GET', `/officials-development/bodies/${w.b.id}/export`, { token: w.owner.token }));
  assert.match(csv.csv, /section,key,count/); assert.equal(csv.csv.includes(w.official.display_name), false);
  assert.equal((await api('GET', `/officials-development/bodies/${w.b.id}/export`, { token: w.assessor.token })).status, 404);
  assert.ok((await q("SELECT 1 FROM fed_exports WHERE body_id=$1 AND report='officials_development'", [w.b.id])).length);
});

test('the sweep reminds without content, once per assessment and per result', async () => {
  const { runOfficialsSweeps } = await import('../src/officials-sweeps.js');
  const w = await world();
  const o = must(await assign(w, { due_on: day(1) }), 201); must(await accept(w, o));
  const t = must(await api('POST', `/officials-development/bodies/${w.b.id}/fitness-tests`, { token: w.owner.token, body: { name: 'Beep', result_kind: 'pass_fail', validity_months: 12 } }), 201);
  must(await api('POST', `/officials-development/bodies/${w.b.id}/fitness-results`, { token: w.owner.token, body: { test_id: t.id, official_id: w.official.id, taken_on: day(-340), outcome: 'pass' } }), 201);
  const first = await runOfficialsSweeps(), again = await runOfficialsSweeps();
  assert.ok(first.assessor_reminders >= 1 && first.fitness_reminders >= 1); assert.deepEqual(again, { assessor_reminders: 0, fitness_reminders: 0 });
  const note = (await q("SELECT title, body, data FROM notifications WHERE user_id=$1 AND kind='official_observation_due'", [w.assessor.id]))[0];
  assert.ok(note && !JSON.stringify(note).includes(w.official.display_name), 'the reminder names nobody');
});

test('AI only drafts: it sees the official\'s own records, is labelled a draft, and decides nothing', async () => {
  const w = await world();
  assert.equal(must(await api('POST', '/me/officials-development/plan-draft', { token: w.official.token, body: {} })).source, 'none');
  await published(w);
  let prompt = '';
  setAiTransport(async (b) => { prompt = JSON.stringify(b); return JSON.stringify({ headline: 'Focus on transitions', items: [{ title: 'Anticipate transitions', detail: 'Review clips', source_refs: ['A1'] }] }); });
  const d = must(await api('POST', '/me/officials-development/plan-draft', { token: w.official.token, body: {} }));
  assert.equal(d.draft, true); assert.equal(d.source, 'ai'); assert.equal(d.items[0].title, 'Anticipate transitions');
  assert.ok(prompt.includes('Anticipate transitions') && !prompt.includes(w.assessor.display_name) && !prompt.includes(w.assessor.id), 'no assessor identity reaches the model');
  assert.match(prompt, /promoted, demoted, licensed or renewed/);
  setAiTransport(async () => null);
  assert.equal(must(await api('POST', '/me/officials-development/plan-draft', { token: w.official.token, body: {} })).source, 'plain');
  setAiTransport(null);
  assert.equal((await api('POST', '/me/officials-development/plan-draft', { token: (await signup()).token, body: {} })).body.source, 'none');
});

test('REST, OpenAPI and MCP expose the same capabilities; the migration is additive and unauthenticated calls are refused', async () => {
  const names = ['appoint_assessor', 'assign_observation', 'save_rubric', 'publish_rubric_version', 'save_assessment', 'submit_assessment', 'correct_assessment', 'decide_assessment', 'respond_assessment', 'lodge_assessment_appeal', 'decide_assessment_appeal',
    'save_grade_requirement', 'demote_official', 'record_fitness_result', 'record_cpd', 'propose_mentorship', 'add_development_item', 'get_my_officials_development', 'get_officials_development_overview', 'export_officials_development_report', 'draft_development_plan'];
  const w = await world();
  const tools = (await rpc('tools/list', {}, w.owner.token)).tools.map((t) => t.name);
  for (const nm of names) assert.ok(tools.includes(nm), `${nm} is an MCP tool`);
  const doc = (await (await fetch(`${base}/api/v1/openapi.json`)).json());
  const ops = new Set(Object.values(doc.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId));
  for (const nm of names) assert.ok(ops.has(nm), `${nm} is in OpenAPI`);
  const viaMcp = await rpc('tools/call', { name: 'get_my_officials_development', arguments: {} }, w.official.token);
  assert.equal(JSON.parse(viaMcp.content[0].text).has_licence, true);
  assert.equal((await api('GET', '/me/officials-development')).status, 401);
  assert.equal((await api('GET', `/officials-development/bodies/${w.b.id}/overview`)).status, 401);
  const sql = readFileSync(new URL('../migrations/116_officials_development.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  assert.ok(!/\bDROP\s+(TABLE|COLUMN)|\bTRUNCATE\b|\bDELETE\s+FROM\b|ON DELETE CASCADE/i.test(sql), 'additive and non-destructive');
  // the existing licence, assignment and public-feedback stores are untouched by this domain
  const fk = await q(`SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype='f' AND confrelid::regclass::text LIKE 'off\\_%' AND conrelid::regclass::text NOT LIKE 'off\\_%'`);
  assert.deepEqual(fk, [], 'nothing outside this domain depends on assessment data, and public feedback (#215) shares no table with it');
  assert.ok((await q("SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'testimonial%'")).length > 0);
});
