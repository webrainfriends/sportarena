// Issue #332: athlete season / career export packs - provenance, permissions, shares, CSV/PDF, youth rules, concurrency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, raw } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') };
  return { status: r.status, body: await r.json() };
};
const rpc = async (name, args, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const patch = (t, p, body) => api('PATCH', p, { token: t, body });
const signup = async (roles = ['athlete'], name) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ep_${n}_${roles[0]}`, display_name: name ?? `Pack ${n}`, email: `ep${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const Y = new Date().getUTCFullYear();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const sportId = async (slug) => (await pool.query('SELECT id FROM sports WHERE slug=$1', [slug])).rows[0].id;

/** an athlete with a full record, a coach who coaches them, a team-mate and a stranger */
const setup = async () => {
  const ath = await signup(['athlete'], 'Asha Pack'), coach = await signup(['coach'], 'Coach Pack'), mate = await signup(['athlete']), stranger = await signup(['coach']);
  const team = ok(await post(coach.token, '/teams', { name: `Pack FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const u of [ath, mate]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, u.id]);
  const prof = ok(await post(ath.token, '/me/sport-profiles', { sport: 'football', role: 'athlete', level: 'amateur' }), 201);
  const m = (played_on, extra = {}) => post(ath.token, '/me/matches', { sport_profile_id: prof.id, played_on, opponent: 'Reds', score_for: 2, score_against: 1, ...extra });
  ok(await m(`${Y}-01-10`, { notes: 'PRIVATE-MATCH-NOTE', rating: 9 }), 201);
  ok(await m(`${Y}-02-11`, { opponent: 'Blues', score_for: 0, score_against: 3 }), 201);
  ok(await m(`${Y - 1}-03-05`, { opponent: 'Greens' }), 201);
  // a self-reported result and an approved competition result
  ok(await post(ath.token, '/performances', { sport: 'athletics', metric: 'sprint_time', value: 12.4, achieved_on: `${Y}-03-01` }), 201);
  await pool.query(`INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on, evidence_ref)
                    VALUES ($1,$2,'sprint_time',11.9,0,$3,'approved_competition','approved','s','lower',$4,'SECRET-EVIDENCE-REF')`, [ath.id, await sportId('athletics'), coach.id, `${Y}-04-01`]);
  await pool.query("INSERT INTO awards(name, kind, user_id, awarded_by, awarded_at) VALUES ('Player of the match','mvp',$1,$2,$3)", [ath.id, coach.id, `${Y}-05-01T10:00:00Z`]);
  ok(await post(ath.token, '/me/career', { idempotency_key: `career-${n}-aaaa`, sport: 'football', club_name: 'Local FC', starts_on: `${Y - 1}-08-01` }), 201);
  const goal = ok(await post(ath.token, '/me/goals', { title: '=HYPERLINK("evil")', category: 'physical', measure: 'Stopwatch', target_value: 5.4, unit: 's', why: 'PRIVATE-WHY', starts_on: `${Y}-01-01` }), 201);
  const goal2 = ok(await post(ath.token, '/me/goals', { title: 'Weaker foot', category: 'technical', starts_on: `${Y}-01-01` }), 201);
  await pool.query("INSERT INTO player_goal_progress(goal_id, value, note, logged_on) VALUES ($1, 5.9, 'PRIVATE-PROGRESS-NOTE', $2)", [goal.id, `${Y}-06-01`]);
  // private data that must never appear anywhere
  ok(await post(ath.token, '/me/wellness', { date: day(), sleep_hours: 7, soreness: 3, mood: 3, note: 'PRIVATE-WELLNESS-NOTE' }), 200);
  return { ath, coach, mate, stranger, team, goal, goal2 };
};
const body = (extra = {}) => ({ scope: 'season', season: Y, sections: ['matches', 'results', 'goals', 'awards', 'career', 'evidence'], ...extra });
const mk = (u, extra = {}) => post(u.token, '/export-packs', { client_key: `key-${++n}-${Math.random().toString(36).slice(2, 8)}`, ...body(extra) });
const everything = (v) => JSON.stringify(v);

test('a season pack reads the canonical records with provenance and never includes private data', async () => {
  const s = await setup();
  const opts = ok(await get(s.ath.token, '/me/export-pack-options'));
  assert.deepEqual(opts.seasons.map((x) => x.year), [Y, Y - 1], 'only seasons that have records');
  assert.equal(opts.seasons[0].matches, 2);
  assert.ok(opts.sports.some((x) => x.slug === 'football'));
  assert.deepEqual(opts.recipients.map((r) => r.id), [s.coach.id], 'only a coach who currently coaches you, never a team-mate or stranger');
  assert.ok(opts.never_included.includes('private_notes'));

  const prev = ok(await post(s.ath.token, '/export-packs/preview', body())).snapshot;
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM export_packs')).rows[0].c, 0, 'a preview saves nothing');
  assert.equal(prev.matches.rows.length, 2, 'only this season');
  assert.deepEqual(prev.matches.rows.map((m) => m.provenance), ['manual', 'manual']);
  assert.equal(prev.matches.summary[0].self_reported, 2); assert.equal(prev.matches.summary[0].official, 0);
  assert.equal(prev.results.rows.length, 2);
  assert.deepEqual(prev.results.bests.map((b) => [b.metric, b.best, b.unit]), [['sprint_time', 11.9, 's']], 'bests come from approved competition results only');
  assert.equal(prev.results.rows.find((r) => r.provenance === 'approved_competition').has_evidence, true);
  assert.equal(prev.awards.rows[0].awarded_by, s.coach.display_name);
  assert.equal(prev.career.rows[0].verification_status, 'unverified');
  assert.equal(prev.goals.rows.find((g) => g.latest_value === 5.9).basis, 'athlete_claim');
  assert.ok(prev.evidence.notes.length >= 4);
  assert.deepEqual(prev.never_included, ['private_notes', 'health_and_wellness', 'contact_details', 'date_of_birth']);
  for (const secret of ['PRIVATE-MATCH-NOTE', 'PRIVATE-WHY', 'PRIVATE-PROGRESS-NOTE', 'PRIVATE-WELLNESS-NOTE', 'SECRET-EVIDENCE-REF', 'ep' + '@example', 'password']) assert.ok(!everything(prev).includes(secret), `leaked ${secret}`);

  const career = ok(await post(s.ath.token, '/export-packs/preview', body({ scope: 'career', season: undefined }))).snapshot;
  assert.equal(career.matches.rows.length, 3, 'career covers every season');
  const sport = ok(await post(s.ath.token, '/export-packs/preview', body({ sport: 'athletics' }))).snapshot;
  assert.equal(sport.matches.rows.length, 0, 'sport filter'); assert.equal(sport.results.rows.length, 2);
});

test('creating a pack freezes it: idempotent, fingerprinted, immutable, listed; CSV is safe and labelled', async () => {
  const s = await setup();
  const key = 'retry-key-0001';
  const a = ok(await post(s.ath.token, '/export-packs', { ...body(), client_key: key }), 201);
  const b = ok(await post(s.ath.token, '/export-packs', { ...body(), client_key: key }), 201);
  assert.equal(a.id, b.id); assert.equal(b.duplicate, true);
  assert.equal((await post(s.ath.token, '/export-packs', { ...body({ season: Y - 1 }), client_key: key })).status, 409, 'the same key for a different pack is refused');
  assert.match(a.snapshot_sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.summary.matches, 2);
  await assert.rejects(pool.query("UPDATE export_packs SET sections='{matches}' WHERE id=$1", [a.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM export_packs WHERE id=$1', [a.id]), /immutable/);
  // later changes never alter the frozen pack
  const prof = (await get(s.ath.token, '/me/sport-profiles')).body[0];
  ok(await post(s.ath.token, '/me/matches', { sport_profile_id: prof.id, played_on: `${Y}-02-20`, opponent: 'Late' }), 201);
  assert.equal(ok(await get(s.ath.token, `/export-packs/${a.id}`)).snapshot.matches.rows.length, 2);
  assert.equal(ok(await get(s.ath.token, '/export-packs')).length, 1);

  const csv = ok(await get(s.ath.token, `/export-packs/${a.id}/csv`));
  assert.match(csv.filename, /^season-report-.*\.csv$/);
  assert.equal(csv.sha256, a.snapshot_sha256);
  const lines = csv.csv.trim().split('\n');
  assert.equal(lines[0], 'section,date,sport,item,detail,outcome,value,unit,provenance,verification,source');
  assert.ok(lines.some((l) => l.startsWith('about,')));
  assert.ok(lines.some((l) => l.startsWith('matches,') && l.includes('self_reported')));
  assert.ok(csv.csv.includes("'=HYPERLINK"), 'formula injection is neutralised');
  assert.ok(!/^[a-z]+,[^,]*,[^,]*,=/m.test(csv.csv));
  assert.ok(!csv.csv.includes('PRIVATE-'));
});

test('validation: scope rules, sport, unauthenticated, other people\'s packs read as not found', async () => {
  const s = await setup();
  assert.equal((await api('POST', '/export-packs/preview', { body: body() })).status, 401);
  assert.equal((await post(s.ath.token, '/export-packs/preview', { scope: 'season', sections: ['matches'] })).status, 400, 'a season pack needs a year');
  assert.equal((await post(s.ath.token, '/export-packs/preview', { scope: 'career', season: Y, sections: ['matches'] })).status, 400);
  assert.equal((await post(s.ath.token, '/export-packs/preview', body({ sport: 'not-a-sport' }))).status, 404);
  assert.equal((await post(s.ath.token, '/export-packs/preview', body({ sections: [] }))).status, 400);
  assert.equal((await post(s.ath.token, '/export-packs/preview', body({ sections: ['health'] }))).status, 400, 'health is not a section');
  assert.equal((await post(s.ath.token, '/export-packs/preview', body({ athlete_id: s.mate.id }))).status, 403, 'only a verified guardian can act for someone else');
  const p = ok(await mk(s.ath), 201);
  for (const who of [s.mate, s.stranger, s.coach]) {
    assert.equal((await get(who.token, `/export-packs/${p.id}`)).status, 404, 'no leaking existence');
    assert.equal((await get(who.token, `/export-packs/${p.id}/csv`)).status, 404);
    assert.equal((await post(who.token, `/export-packs/${p.id}/pdf`, {})).status, 404);
  }
  assert.equal((await get(s.ath.token, '/export-packs/00000000-0000-4000-8000-000000000000')).status, 404);
});

test('coaching reports: only published versions the athlete was sent, chosen by the athlete', async () => {
  const s = await setup();
  const mkReport = async (audience, title) => {
    const r = ok(await post(s.coach.token, '/coaching/reports', { athlete_id: s.ath.id, team_id: s.team.id, kind: 'athlete_progress', title, audience, from: `${Y}-01-01`, to: day() }), 201);
    ok(await post(s.coach.token, `/coaching/reports/${r.id}/publish`, { row_version: 1 }), 201);
    return r;
  };
  const toAthlete = await mkReport('athlete', 'Progress for Asha'), toStaff = await mkReport('team_staff', 'For the coaching staff');
  const draft = ok(await post(s.coach.token, '/coaching/reports', { athlete_id: s.ath.id, team_id: s.team.id, kind: 'athlete_progress', title: 'Unpublished draft', audience: 'athlete', from: `${Y}-01-01`, to: day() }), 201);
  const opts = ok(await get(s.ath.token, '/me/export-pack-options'));
  assert.deepEqual(opts.reports.map((r) => r.report_id), [toAthlete.id], 'only reports published to the athlete');
  const none = ok(await post(s.ath.token, '/export-packs/preview', body({ sections: ['reports'] }))).snapshot;
  assert.equal(none.reports.rows.length, 0, 'reports are included only when chosen');
  for (const bad of [toStaff.id, draft.id]) assert.equal((await mk(s.ath, { sections: ['reports'], report_ids: [bad] })).status, 400, 'not available to include');
  const pack = ok(await mk(s.ath, { sections: ['reports', 'evidence'], report_ids: [toAthlete.id] }), 201);
  const r = pack.snapshot.reports.rows[0];
  assert.equal(r.title, 'Progress for Asha'); assert.equal(r.version, 1); assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pack.snapshot.evidence.reports[0].sha256, r.sha256, 'the evidence summary carries the report fingerprint');
  // a season outside the report period excludes it from eligibility
  assert.equal(ok(await post(s.ath.token, '/export-packs/preview', body({ scope: 'season', season: Y - 3, sections: ['reports'], report_ids: [] }))).snapshot.reports.rows.length, 0);
  assert.ok(!everything(pack).includes('PRIVATE'));
});

test('PDF: branded template, stored once, downloadable only by people who may read the pack', async () => {
  const s = await setup();
  const pack = ok(await mk(s.ath), 201);
  const plain = ok(await post(s.ath.token, `/export-packs/${pack.id}/pdf`, {}), 201);
  assert.equal(plain.duplicate, false); assert.ok(plain.pages >= 1);
  assert.equal(ok(await post(s.ath.token, `/export-packs/${pack.id}/pdf`, {}), 201).id, plain.id, 'same pack and layout returns the PDF you have');
  const file = await api('GET', `/branded-documents/${plain.id}/file`, { token: s.ath.token, raw: true });
  assert.equal(file.status, 200); assert.equal(file.buf.subarray(0, 5).toString(), '%PDF-');
  for (const who of [s.mate, s.stranger, s.coach]) assert.equal((await api('GET', `/branded-documents/${plain.id}/file`, { token: who.token, raw: true })).status, 404);

  // a brand kit + published season_report template
  const kit = ok(await post(s.ath.token, '/brand-kits', { name: 'Mine', display_name: 'Asha Pack Sport', primary_color: '#0F6E56', secondary_color: '#444441', footer_text: 'Confidential' }));
  const fams = ok(await get(s.ath.token, '/branded-documents/families'));
  assert.ok(fams.families.find((f) => f.family === 'season_report').source.available);
  const tpl = ok(await post(s.ath.token, '/document-templates', { family: 'season_report', name: 'Season', kit_id: kit.id }));
  assert.equal((await post(s.ath.token, '/document-templates', { family: 'season_report', name: 'Bad', layout: { blocks: [{ type: 'lines' }] } })).status, 400, 'a season layout cannot use invoice blocks');
  ok(await post(s.ath.token, `/document-templates/${tpl.id}/publish`, { row_version: tpl.row_version }));
  const opts = ok(await get(s.ath.token, '/me/export-pack-options'));
  assert.deepEqual(opts.templates.map((t) => t.id), [tpl.id]);
  const branded = ok(await post(s.ath.token, `/export-packs/${pack.id}/pdf`, { template_id: tpl.id }), 201);
  assert.notEqual(branded.id, plain.id);
  assert.equal((await post(s.mate.token, `/export-packs/${pack.id}/pdf`, { template_id: tpl.id })).status, 404);
  assert.equal((await post(s.ath.token, `/export-packs/${pack.id}/pdf`, { template_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
  assert.equal(ok(await get(s.ath.token, `/export-packs/${pack.id}`)).documents.length, 2);
});

test('coach share: only what the athlete ticks, live relationship, stale versions, duplicates, revoke wins', async () => {
  const s = await setup();
  const share = (extra = {}) => post(s.ath.token, '/me/export-pack-shares', { recipient_id: s.coach.id, scope: 'season', season: Y, sections: ['matches', 'goals', 'evidence'], expires_on: day(30), ...extra });
  assert.equal((await share({ recipient_id: s.stranger.id })).status, 403, 'a coach who does not coach you');
  assert.equal((await share({ recipient_id: s.mate.id })).status, 403);
  assert.equal((await share({ expires_on: day(-1) })).status, 400);
  assert.equal((await share({ expires_on: day(400) })).status, 400);
  assert.equal((await post(s.ath.token, '/me/export-pack-shares', { recipient_id: s.coach.id, scope: 'season', sections: ['matches'], expires_on: day(5) })).status, 400, 'season needed');
  const sh = ok(await share(), 201);
  assert.equal(ok(await share(), 201).id, sh.id, 'a repeat returns the same share');
  const dup = await share({ sections: ['matches'] });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.details.code, 'share_exists');

  // the coach sees it, builds the pack, and gets only the chosen sections
  const inbox = ok(await get(s.coach.token, '/export-pack-shared'));
  assert.equal(inbox[0].live, true); assert.equal(inbox[0].athlete_name, s.ath.display_name);
  assert.equal((await get(s.stranger.token, '/export-pack-shared')).body.length, 0);
  assert.equal((await post(s.stranger.token, '/export-packs', { share_id: sh.id })).status, 404, 'a share is for its recipient only');
  assert.equal((await post(s.mate.token, '/export-packs', { share_id: sh.id })).status, 404);
  const cp = ok(await post(s.coach.token, '/export-packs', { share_id: sh.id, client_key: 'coach-key-0001' }), 201);
  assert.equal(cp.snapshot.prepared_for, 'staff');
  assert.equal(cp.snapshot.matches.rows.length, 2);
  assert.deepEqual(cp.snapshot.goals.rows, [], 'goals only if the athlete also shared those goals with this coach');
  for (const k of ['results', 'awards', 'career', 'reports']) assert.equal(cp.snapshot[k], undefined, `${k} was not shared`);
  assert.equal(ok(await post(s.coach.token, '/export-packs', { share_id: sh.id, client_key: 'coach-key-0001' }), 201).id, cp.id, 'idempotent');
  assert.ok(!everything(cp).includes('PRIVATE'));

  // goal shared with this coach through the existing goal share flow
  ok(await post(s.ath.token, '/me/shares', { goal_id: s.goal.id, coach_id: s.coach.id }), 201);
  const cp2 = ok(await post(s.coach.token, '/export-packs', { share_id: sh.id }), 201);
  assert.deepEqual(cp2.snapshot.goals.rows.map((g) => g.title), ['=HYPERLINK("evil")']);
  assert.ok(!('coach_rating' in cp2.snapshot.goals.rows[0]) && !everything(cp2).includes('PRIVATE-WHY'), 'no private reason, no ratings for staff');
  const csv = ok(await get(s.coach.token, `/export-packs/${cp2.id}/csv`));
  assert.ok(csv.rows > 2);
  const coachDoc = ok(await post(s.coach.token, `/export-packs/${cp2.id}/pdf`, {}), 201);
  assert.equal((await api('GET', `/branded-documents/${coachDoc.id}/file`, { token: s.coach.token, raw: true })).status, 200);

  // the athlete sees it all, in a log, and can open what the coach built
  const list = ok(await get(s.ath.token, '/me/export-pack-shares'));
  assert.equal(list.shares[0].live, true); assert.equal(list.shares[0].packs, 2);
  assert.ok(['granted', 'created', 'csv', 'pdf'].every((a) => list.activity.some((e) => e.action === a)));
  assert.equal(ok(await get(s.ath.token, `/export-packs/${cp2.id}`)).access, 'self');

  // stale edits are refused; a narrowing applies to the next build
  assert.equal((await patch(s.ath.token, `/me/export-pack-shares/${sh.id}`, { version: 99, sections: ['matches'] })).status, 409);
  const up = ok(await patch(s.ath.token, `/me/export-pack-shares/${sh.id}`, { version: sh.version, sections: ['awards'] }));
  assert.equal(up.version, 2);
  assert.equal((await patch(s.ath.token, `/me/export-pack-shares/${sh.id}`, { version: sh.version, sections: ['matches'] })).status, 409, 'the old version is stale');
  assert.deepEqual(ok(await post(s.coach.token, '/export-packs', { share_id: sh.id }), 201).snapshot.awards.rows.length, 1);
  assert.equal((await patch(s.mate.token, `/me/export-pack-shares/${sh.id}`, { version: 2, sections: ['matches'] })).status, 404);

  // a coach who stops coaching loses access at once, including to the pack already built
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.coach.id]);
  assert.equal(ok(await get(s.coach.token, '/export-pack-shared'))[0].live, false);
  for (const r of [await get(s.coach.token, `/export-packs/${cp.id}`), await get(s.coach.token, `/export-packs/${cp.id}/csv`), await post(s.coach.token, '/export-packs', { share_id: sh.id }), await api('GET', `/branded-documents/${coachDoc.id}/file`, { token: s.coach.token, raw: true })]) assert.ok([403, 404].includes(r.status), String(r.status));
  await pool.query("UPDATE team_members SET status='active' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.coach.id]);
  assert.equal((await get(s.coach.token, `/export-packs/${cp.id}`)).status, 200, 'coaching again restores a still-live share');

  // revoke ends everything immediately and is repeatable
  ok(await post(s.ath.token, `/me/export-pack-shares/${sh.id}/revoke`, {}));
  assert.equal(ok(await post(s.ath.token, `/me/export-pack-shares/${sh.id}/revoke`, {})).state, 'revoked');
  const after = await get(s.coach.token, `/export-packs/${cp.id}`);
  assert.equal(after.status, 403); assert.match(after.body.error.message, /stopped sharing/);
  assert.equal((await post(s.coach.token, '/export-packs', { share_id: sh.id })).status, 403);
  assert.equal((await patch(s.ath.token, `/me/export-pack-shares/${sh.id}`, { version: 3, sections: ['matches'] })).status, 409, 'an ended share is edited by making a new one');
  assert.equal(ok(await get(s.ath.token, `/export-packs/${cp.id}`)).snapshot.matches.rows.length, 2, 'the athlete keeps the history');
  assert.equal((await share()).status, 201, 'a fresh share can be made after a revoke');
});

test('coach reports in a staff pack are only that coach\'s own published reports', async () => {
  const s = await setup();
  const other = await signup(['coach']);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active')", [s.team.id, other.id]);
  const mine = ok(await post(s.coach.token, '/coaching/reports', { athlete_id: s.ath.id, team_id: s.team.id, kind: 'athlete_progress', title: 'Mine', audience: 'athlete', from: `${Y}-01-01`, to: day() }), 201);
  ok(await post(s.coach.token, `/coaching/reports/${mine.id}/publish`, { row_version: 1 }), 201);
  const theirs = ok(await post(other.token, '/coaching/reports', { athlete_id: s.ath.id, team_id: s.team.id, kind: 'athlete_progress', title: 'Their report', audience: 'athlete', from: `${Y}-01-01`, to: day() }), 201);
  ok(await post(other.token, `/coaching/reports/${theirs.id}/publish`, { row_version: 1 }), 201);
  const sh = ok(await post(s.ath.token, '/me/export-pack-shares', { recipient_id: s.coach.id, scope: 'career', sections: ['reports'], expires_on: day(10) }), 201);
  const p = ok(await post(s.coach.token, '/export-packs', { share_id: sh.id }), 201);
  assert.deepEqual(p.snapshot.reports.rows.map((r) => r.title), ['Mine']);
});

test('young athletes: a guardian arranges everything; consent applies live; the young person cannot export alone', async () => {
  const s = await setup();
  const parent = await signup(['athlete'], 'Parent Pack');
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [s.ath.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, s.ath.id]);
  assert.equal((await post(s.ath.token, '/export-packs/preview', body())).status, 403, 'a young person cannot arrange exports alone');
  assert.equal((await get(s.ath.token, '/me/export-pack-options')).status, 403);
  assert.deepEqual(ok(await get(s.ath.token, '/export-packs')), [], 'and sees no packs');
  assert.equal((await post(s.stranger.token, '/export-packs/preview', body({ athlete_id: s.ath.id }))).status, 403);

  // without coaching consent the guardian still gets matches, results, awards and career; goals and reports are withheld, with the reason
  const prev = ok(await post(parent.token, '/export-packs/preview', body({ athlete_id: s.ath.id, sections: ['matches', 'goals', 'reports'] }))).snapshot;
  assert.equal(prev.prepared_for, 'guardian'); assert.equal(prev.matches.rows.length, 2);
  assert.deepEqual(prev.withheld.map((w) => w.section), ['goals', 'reports']); assert.match(prev.withheld[0].reason, /guardian/i);
  assert.equal((await post(parent.token, '/me/export-pack-shares', { athlete_id: s.ath.id, recipient_id: s.coach.id, scope: 'career', sections: ['matches'], expires_on: day(10) })).status, 409, 'a coach share needs current coaching consent');

  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'coaching',$2,1, now() + interval '30 days')", [s.ath.id, parent.id]);
  const withGoals = ok(await post(parent.token, '/export-packs/preview', body({ athlete_id: s.ath.id, sections: ['goals'] }))).snapshot;
  assert.equal(withGoals.goals.rows.length, 2); assert.deepEqual(withGoals.withheld, []);
  const pack = ok(await post(parent.token, '/export-packs', { ...body({ athlete_id: s.ath.id }) }), 201);
  assert.equal(pack.snapshot.prepared_for, 'guardian');
  const sh = ok(await post(parent.token, '/me/export-pack-shares', { athlete_id: s.ath.id, recipient_id: s.coach.id, scope: 'career', sections: ['matches'], expires_on: day(10) }), 201);
  assert.equal(ok(await get(parent.token, `/me/export-pack-shares?athlete_id=${s.ath.id}`)).shares.length, 1);
  assert.equal(ok(await get(parent.token, `/export-packs?athlete_id=${s.ath.id}`)).length, 1);
  assert.equal((await get(parent.token, `/export-packs/${pack.id}/csv`)).status, 200);
  ok(await post(s.coach.token, '/export-packs', { share_id: sh.id }), 201);

  // withdrawing consent hides everything from the coach at once; the guardian can still stop the share
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [s.ath.id]);
  assert.equal((await post(s.coach.token, '/export-packs', { share_id: sh.id })).status, 403);
  assert.match(ok(await get(parent.token, `/me/export-pack-shares?athlete_id=${s.ath.id}`)).shares[0].blocked_reason, /guardian/i);
  assert.equal(ok(await post(parent.token, `/me/export-pack-shares/${sh.id}/revoke`, {})).state, 'revoked');
  assert.equal((await post(s.stranger.token, `/me/export-pack-shares/${sh.id}/revoke`, {})).status, 404);
  // a guardian link that ends removes the guardian's access
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE guardian_id=$1", [parent.id]);
  assert.equal((await get(parent.token, `/export-packs/${pack.id}`)).status, 404);
});

test('concurrency: parallel retries make one pack; a revoke in flight wins over a build', async () => {
  const s = await setup();
  const key = 'parallel-key-01';
  const rs = await Promise.all(Array.from({ length: 6 }, () => post(s.ath.token, '/export-packs', { ...body(), client_key: key })));
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM export_packs WHERE created_by=$1', [s.ath.id])).rows[0].c, 1);

  const sh = ok(await post(s.ath.token, '/me/export-pack-shares', { recipient_id: s.coach.id, scope: 'career', sections: ['matches'], expires_on: day(10) }), 201);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM export_pack_shares WHERE id=$1 FOR UPDATE', [sh.id]); // a revoke in flight holds the row
    const building = post(s.coach.token, '/export-packs', { share_id: sh.id });
    await new Promise((r) => setTimeout(r, 300));
    await c.query('UPDATE export_pack_shares SET revoked_at=now(), version=version+1 WHERE id=$1', [sh.id]);
    await c.query('COMMIT');
    assert.equal((await building).status, 403, 'the build waited for the revoke and was refused');
  } finally { c.release(); }
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM export_packs WHERE share_id=$1', [sh.id])).rows[0].c, 0);
  // two simultaneous creates of the same share make one share
  const two = await Promise.all([1, 2].map(() => post(s.ath.token, '/me/export-pack-shares', { recipient_id: s.coach.id, scope: 'career', sections: ['matches'], expires_on: day(11) })));
  assert.deepEqual(two.map((r) => r.status), [201, 201]);
  assert.equal(new Set(two.map((r) => r.body.id)).size, 1);
});

test('MCP and OpenAPI expose the same capabilities', async () => {
  const s = await setup();
  const r = await rpc('preview_export_pack', body(), s.ath.token);
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(JSON.parse(r.content[0].text).snapshot.matches.rows.length, 2);
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json()).paths;
  for (const [p, m] of [['/export-packs', 'post'], ['/export-packs/{id}/csv', 'get'], ['/export-packs/{id}/pdf', 'post'], ['/me/export-pack-shares', 'post'], ['/export-pack-shared', 'get']]) assert.ok(spec[p]?.[m], `${m} ${p}`);
});
