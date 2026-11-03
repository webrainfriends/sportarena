import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete'], name) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `tp_${n}_${roles[0]}`, display_name: name ?? `Tp ${n}`, email: `tp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ago = (d, h = 10) => { const x = new Date(); x.setUTCDate(x.getUTCDate() - d); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };
const dayOf = (d) => ago(d).slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

const NAMES = ['Aarav Mehta', 'Bhavna Rao', 'Chetan Pillai', 'Divya Menon', 'Eshan Kulkarni', 'Fatima Sheikh'];
/** A team of six adult players, three past sessions in three weeks with attendance, an effort on every block, and scores on one sheet. */
async function setup({ players = 6 } = {}) {
  const coach = await signup(['coach'], 'Coach Test');
  const people = []; for (let i = 0; i < players; i++) people.push(await signup(['athlete'], NAMES[i]));
  const team = ok(await api('POST', '/teams', { token: coach.token, body: { name: `Perf FC ${n}`, sport: 'football' } }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const p of people) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, p.id]);
  const sheet = ok(await api('POST', '/coaching/rubrics', { token: coach.token, body: { name: 'Squad profile', sport: 'football', dimensions: [
    { key: 'first_touch', name: 'First touch', pillar: 'technical', weight: 2, scale_min: 1, scale_max: 5 },
    { key: 'scanning', name: 'Scanning', pillar: 'tactical', weight: 1, scale_min: 1, scale_max: 5 }] } }), 201);
  const rid = sheet.rubric_id ?? sheet.id;
  const records = [];
  for (const [i, d] of [[0, 21], [1, 14], [2, 7]]) {
    const rec = ok(await api('POST', '/coaching/sessions', { token: coach.token, body: { source_type: 'team_session', source_id: randomUUID(), team_id: team.id, title: `Training ${i + 1}`, scheduled_at: ago(d) } }), 201);
    ok(await api('POST', `/coaching/sessions/${rec.id}/plan`, { token: coach.token, body: { blocks: [{ kind: 'warm_up', title: 'Warm-up', duration_min: 10, target_rpe: 3 }, { kind: 'conditioned_game', title: 'Game', duration_min: 30, target_rpe: 8 }] } }));
    // everyone present except one person in the last session; nothing recorded for the first session
    if (i > 0) ok(await api('POST', `/coaching/sessions/${rec.id}/attendance`, { token: coach.token, body: { entries: people.map((p, k) => ({ athlete_id: p.id, attendance: i === 2 && k === 0 ? 'absent' : 'present' })) } }));
    // first touch gets better over the sessions, scanning stays put
    ok(await api('POST', `/coaching/sessions/${rec.id}/scores`, { token: coach.token, body: { rubric_id: rid, scores: people.flatMap((p) => [{ athlete_id: p.id, dimension_key: 'first_touch', score: 2 + i }, { athlete_id: p.id, dimension_key: 'scanning', score: 2 }]) } }));
    records.push(rec);
  }
  return { coach, people, team, rid, records };
}
const perfQ = (s, extra = {}) => ({ team_id: s.team.id, from: dayOf(40), to: dayOf(0), rubric_id: s.rid, ...extra });

test('team performance rolls up sessions, attendance, planned load and the criteria of one sheet, from the coach\'s own records only', async () => {
  const s = await setup();
  const p = ok(await api('GET', '/coaching/team-performance', { token: s.coach.token, query: perfQ(s) }));
  assert.equal(p.sessions.total, 3); assert.equal(p.athletes.n, 6);
  // attendance: session 1 was never recorded (missing, not absent); sessions 2 and 3 record 12 places, one of them absent
  assert.equal(p.attendance.recorded_slots, 12); assert.equal(p.attendance.rate, 91.7); assert.equal(p.attendance.sessions_without_record, 1);
  assert.equal(p.load.total_au, 3 * (10 * 3 + 30 * 8)); assert.equal(p.load.avg_rpe, Math.round(((3 * 270) / 120) * 10) / 10);
  const ft = p.criteria.find((c) => c.key === 'first_touch'), sc = p.criteria.find((c) => c.key === 'scanning');
  assert.equal(ft.avg, 4); assert.equal(ft.change, 2, 'first to latest score, averaged over six athletes'); assert.equal(sc.change, 0);
  assert.equal(p.shareable, true);
  assert.ok(!JSON.stringify(p).includes('Aarav'), 'no athlete is named');
  // someone who does not coach the team gets nothing; an athlete cannot ask
  const other = await signup(['coach']);
  assert.equal((await api('GET', '/coaching/team-performance', { token: other.token, query: perfQ(s) })).status, 403);
  assert.equal((await api('GET', '/coaching/team-performance', { token: s.people[0].token, query: perfQ(s) })).status, 403);
  const scopes = ok(await api('GET', '/coaching/team-performance/scopes', { token: s.coach.token }));
  assert.ok(scopes.teams.some((t) => t.id === s.team.id));
});

test('small groups: the coach sees them, criterion figures are held back from anything shareable, and an organisation report is refused', async () => {
  const s = await setup({ players: 3 });
  const p = ok(await api('GET', '/coaching/team-performance', { token: s.coach.token, query: perfQ(s) }));
  assert.equal(p.shareable, false); assert.equal(p.criteria.find((c) => c.key === 'first_touch').avg, 4, 'the coach\'s own screen shows it');
  const rep = ok(await api('POST', '/coaching/reports', { token: s.coach.token, body: { team_id: s.team.id, kind: 'team_performance', title: 'Squad review', audience: 'organisation', from: dayOf(40), to: dayOf(0), rubric_id: s.rid } }), 201);
  const prev = await api('GET', `/coaching/reports/${rep.id}/preview`, { token: s.coach.token });
  assert.equal(prev.status, 400);
  assert.match(JSON.stringify(prev.body), /at least 5/);
  // for the coach's own copy the same report builds
  const own = ok(await api('POST', '/coaching/reports', { token: s.coach.token, body: { team_id: s.team.id, kind: 'team_performance', title: 'Mine', audience: 'coach_private', from: dayOf(40), to: dayOf(0), rubric_id: s.rid } }), 201);
  assert.ok(ok(await api('GET', `/coaching/reports/${own.id}/preview`, { token: s.coach.token })).snapshot.sections.length > 2);
});

test('a young person without a guardian\'s coaching consent is not counted in any figure', async () => {
  const s = await setup();
  await pool.query("UPDATE users SET youth_until = current_date + interval '3 years' WHERE id=$1", [s.people[5].id]);
  const p = ok(await api('GET', '/coaching/team-performance', { token: s.coach.token, query: perfQ(s) }));
  assert.equal(p.athletes.n, 5, 'the young player without consent is left out of every figure');
  assert.equal(p.criteria.find((c) => c.key === 'first_touch').n, 5);
});

test('findings are rules over the numbers, cite their source, and name the coach\'s own drills for a weak criterion', async () => {
  const s = await setup();
  // a drill tagged for the weak criterion (scanning averages 2 of 5)
  const rec = s.records[0];
  const saved = ok(await api('POST', `/coaching/sessions/${rec.id}/plan`, { token: s.coach.token, body: { blocks: [{ kind: 'skill_drill', title: 'Scanning rondo', duration_min: 15, trains: ['scanning'] }] } }));
  const drill = ok(await api('POST', '/coaching/templates', { token: s.coach.token, body: { title: 'Scanning rondo', scope: 'block', session_record_id: rec.id, block_id: saved.plan.blocks[0].id } }), 201);
  const f = ok(await api('POST', '/coaching/team-performance/findings', { token: s.coach.token, body: perfQ(s, { use_ai: false }) }));
  assert.equal(f.ai, null); assert.equal(f.ai_available, false);
  const weak = f.findings.find((x) => x.kind === 'criterion' && /Scanning/.test(x.title));
  assert.ok(weak, JSON.stringify(f.findings.map((x) => x.title)));
  assert.equal(weak.basis, 'observed'); assert.deepEqual(weak.source_refs, ['criteria.scanning']); assert.equal(weak.drills[0].id, drill.id);
  assert.ok(f.findings.some((x) => x.kind === 'criterion' && /First touch is improving/.test(x.title)));
  assert.ok(f.findings.some((x) => x.kind === 'data' && /Attendance missing/.test(x.title)), 'unrecorded attendance is reported as missing data');
  assert.ok(f.headline.length > 10);
});

test('AI only polishes: it sees aggregates (no names, no individual scores), its ideas are labelled suggestions, and the findings do not change', async () => {
  const s = await setup();
  let seen = null;
  setAiTransport(async (body) => { seen = JSON.stringify(body); return JSON.stringify({ headline: 'A steady block with first touch moving up.', suggestions: [{ title: 'Add a scanning game', detail: 'Scanning has not moved.' }] }); });
  try {
    const plain = ok(await api('POST', '/coaching/team-performance/findings', { token: s.coach.token, body: perfQ(s, { use_ai: false }) }));
    const f = ok(await api('POST', '/coaching/team-performance/findings', { token: s.coach.token, body: perfQ(s, { use_ai: true }) }));
    assert.equal(f.ai.headline, 'A steady block with first touch moving up.'); assert.equal(f.ai.suggestions[0].basis, 'suggestion'); assert.equal(f.ai_available, true);
    assert.deepEqual(f.findings, plain.findings, 'AI cannot change an observed finding');
    for (const name of NAMES) assert.ok(!seen.includes(name.split(' ')[0]), `the model never saw ${name}`);
    assert.ok(!seen.includes(s.team.name) && !seen.includes('Coach Test'), 'nor the team or coach name');
  } finally { setAiTransport(null); }
  // a model that returns rubbish is ignored: the rule-based findings still come back (the earlier answer is cached, so clear it first)
  await pool.query("DELETE FROM ai_outputs WHERE kind='team_findings'");
  setAiTransport(async () => 'not json');
  try { const f = ok(await api('POST', '/coaching/team-performance/findings', { token: s.coach.token, body: perfQ(s, { use_ai: true }) })); assert.equal(f.ai, null); assert.ok(f.findings.length); } finally { setAiTransport(null); }
});

async function org(adminUser) {
  const { rows: [o] } = await pool.query("INSERT INTO organisations(name, kind, created_by) VALUES ($1,'academy',$2) RETURNING id", [`Academy ${randomUUID().slice(0, 6)}`, adminUser.id]);
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,'admin','active', now())", [o.id, adminUser.id]);
  return o.id;
}

test('an organisation report is aggregate only, shared with an expiry, read live and audited, and revocable; the AI-summary gate holds', async () => {
  const s = await setup();
  const admin = await signup(['organizer']), outsider = await signup(['organizer']);
  const orgId = await org(admin);
  const body = { team_id: s.team.id, kind: 'team_performance', title: 'Q3 squad review', audience: 'organisation', from: dayOf(40), to: dayOf(0), rubric_id: s.rid };
  assert.equal((await api('POST', '/coaching/reports', { token: s.coach.token, body: { ...body, selection: { observation_ids: [randomUUID()] } } })).status, 400, 'individual notes cannot be selected for an organisation');
  const rep = ok(await api('POST', '/coaching/reports', { token: s.coach.token, body: { ...body, narrative: 'Strong block; first touch up.', narrative_ai: true } }), 201);
  const pub0 = await api('POST', `/coaching/reports/${rep.id}/publish`, { token: s.coach.token, body: { row_version: rep.row_version } });
  assert.equal(pub0.status, 400, 'an AI-origin summary needs confirm_reviewed');
  const pub = ok(await api('POST', `/coaching/reports/${rep.id}/publish`, { token: s.coach.token, body: { row_version: rep.row_version, confirm_reviewed: true } }), 201);
  const v = ok(await api('GET', `/coaching/reports/${rep.id}/versions/${pub.version}`, { token: s.coach.token }));
  const text = JSON.stringify(v.snapshot);
  for (const name of NAMES) assert.ok(!text.includes(name.split(' ')[0]), `${name} is not in the frozen report`);
  assert.ok(!/Training \d/.test(text), 'no session titles either'); assert.match(v.snapshot.disclosure, /Aggregate only/);
  assert.ok(v.snapshot.sections.some((x) => x.kind === 'bars'));
  // before sharing nobody else can read it
  assert.equal((await api('GET', `/coaching/reports/${rep.id}/versions/${pub.version}`, { token: admin.token })).status, 404);
  // sharing: only a published organisation version, only to a real organisation, expiry bounded
  assert.equal((await api('POST', `/coaching/reports/${rep.id}/shares`, { token: s.coach.token, body: { organisation_id: randomUUID() } })).status, 404);
  assert.equal((await api('POST', `/coaching/reports/${rep.id}/shares`, { token: s.coach.token, body: { organisation_id: orgId, expires_on: dayOf(-400) } })).status, 400);
  const share = ok(await api('POST', `/coaching/reports/${rep.id}/shares`, { token: s.coach.token, body: { organisation_id: orgId, note: 'For the board' } }), 201);
  assert.equal(ok(await api('POST', `/coaching/reports/${rep.id}/shares`, { token: s.coach.token, body: { organisation_id: orgId } }), 201).unchanged, true, 'sharing again returns the same share');
  // the admin reads and exports it; an outsider cannot; both reads are audited
  const mine = ok(await api('GET', '/me/shared-coaching-reports', { token: admin.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].id, share.id); assert.equal(mine[0].title, 'Q3 squad review');
  assert.equal(ok(await api('GET', '/me/shared-coaching-reports', { token: outsider.token })).length, 0);
  assert.equal((await api('GET', `/me/shared-coaching-reports/${share.id}`, { token: outsider.token })).status, 404);
  assert.equal(ok(await api('GET', `/me/shared-coaching-reports/${share.id}`, { token: admin.token })).snapshot.title, 'Q3 squad review');
  const pdf = ok(await api('GET', `/me/shared-coaching-reports/${share.id}/export`, { token: admin.token }));
  assert.equal(pdf.content_type, 'application/pdf'); assert.equal(Buffer.from(pdf.content, 'base64').subarray(0, 4).toString(), '%PDF');
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('read_shared_coaching_report','export_shared_coaching_report') AND actor_id=$1", [admin.id])).rows[0].n >= 2);
  // the coach sees the share and revokes it; access ends at once, the record stays
  assert.equal(ok(await api('GET', `/coaching/reports/${rep.id}/shares`, { token: s.coach.token }))[0].live, true);
  ok(await api('POST', `/coaching/report-shares/${share.id}/revoke`, { token: s.coach.token }));
  assert.equal((await api('GET', `/me/shared-coaching-reports/${share.id}`, { token: admin.token })).status, 404);
  assert.equal(ok(await api('GET', '/me/shared-coaching-reports', { token: admin.token })).length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_report_shares WHERE id=$1', [share.id])).rows[0].n, 1);
  // an expired share also stops working; the PDF the coach downloads themselves is theirs to forward
  const again = ok(await api('POST', `/coaching/reports/${rep.id}/shares`, { token: s.coach.token, body: { organisation_id: orgId } }), 201);
  await pool.query("UPDATE coaching_report_shares SET expires_on = current_date - 1 WHERE id=$1", [again.id]);
  assert.equal((await api('GET', `/me/shared-coaching-reports/${again.id}`, { token: admin.token })).status, 404);
  ok(await api('POST', '/branded-documents/coaching-report', { token: s.coach.token, body: { report_id: rep.id } }));
});

test('evaluate everyone in a session: one draft each from the scores, a first-draft narrative, AI gated, nobody duplicated, anyone not allowed listed as skipped', async () => {
  const s = await setup();
  const rec = s.records[2];
  const stranger = await signup(['athlete'], 'Not In Session');
  const out = ok(await api('POST', `/coaching/sessions/${rec.id}/evaluations`, { token: s.coach.token, body: { rubric_id: s.rid } }), 201);
  assert.equal(out.created, 6); assert.equal(out.existing, 0); assert.deepEqual(out.skipped, []);
  const ev = ok(await api('GET', `/coaching/evaluations/${out.evaluations[0].id}`, { token: s.coach.token }));
  assert.equal(ev.criteria.find((c) => c.key === 'first_touch').score, 4, 'scores given in the session carry in');
  assert.match(ev.narrative.strengths ?? '', /First touch \(4 of 5\)/); assert.match(ev.narrative.development ?? '', /Scanning \(2 of 5\)/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM coaching_evaluations WHERE session_record_id=$1", [rec.id])).rows[0].n, 6);
  // again: nothing duplicated
  const again = ok(await api('POST', `/coaching/sessions/${rec.id}/evaluations`, { token: s.coach.token, body: { rubric_id: s.rid } }), 201);
  assert.equal(again.created, 0); assert.equal(again.existing, 6);
  // naming someone who is not in the session is refused
  assert.equal((await api('POST', `/coaching/sessions/${rec.id}/evaluations`, { token: s.coach.token, body: { rubric_id: s.rid, athlete_ids: [stranger.id] } })).status, 400);
  // AI-written feedback must be confirmed before it reaches the athlete
  const rec2 = s.records[1];
  let seen = '';
  setAiTransport(async (b) => { seen += JSON.stringify(b); return JSON.stringify({ strengths: 'Good touch under pressure.', development: 'Scan earlier.', next_steps: 'Add a scanning game.' }); });
  try {
    const ai = ok(await api('POST', `/coaching/sessions/${rec2.id}/evaluations`, { token: s.coach.token, body: { rubric_id: s.rid, use_ai: true, athlete_ids: [s.people[0].id] } }), 201);
    assert.equal(ai.ai_used, true); assert.equal(ai.evaluations[0].ai_drafted, true);
    assert.ok(!seen.includes('Aarav'), 'the model never saw the athlete\'s name');
    const id = ai.evaluations[0].id;
    const blocked = await api('POST', `/coaching/evaluations/${id}/share`, { token: s.coach.token, body: {} });
    assert.equal(blocked.status, 400); assert.match(JSON.stringify(blocked.body), /AI draft/);
    ok(await api('POST', `/coaching/evaluations/${id}/share`, { token: s.coach.token, body: { confirm_reviewed: true } }));
    const mine = ok(await api('GET', `/me/coaching-evaluations/${id}`, { token: s.people[0].token }));
    assert.equal(JSON.stringify(mine).includes('ai_drafted'), false, 'the flag is not part of what the athlete receives');
  } finally { setAiTransport(null); }
});
