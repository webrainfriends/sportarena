import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const upload = async (token, query, bytes) => {
  const r = await fetch(`${base}/api/v1/tracking/imports?${query}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: bytes });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `tt_${n}_${roles[0]}`, display_name: `Tt ${n}`, email: `tt${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

const mkTeam = async (u, sport) => (await api('POST', '/teams', { token: u.token, body: { name: `Team ${++n}`, sport } })).body;
const setup = async (sport = 'football', kind = 'tournament') => {
  const org = await signup(['organizer']), ref = await signup(['referee']), m1 = await signup(['coach']), m2 = await signup(['coach']), rando = await signup(['athlete']), other = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Tool Cup ${++n}`, sport } })).body;
  await pool.query("UPDATE events SET status='open', kind=$2 WHERE id=$1", [ev.id, kind]);
  const home = await mkTeam(m1, sport), away = await mkTeam(m2, sport);
  const fx = (await pool.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3, now()) RETURNING id', [ev.id, home.id, away.id])).rows[0].id;
  await pool.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
  await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [ev.id, home.id, away.id]);
  return { org, ref, m1, m2, rando, other, ev, home, away, fx };
};
const post = (u, path, body = {}) => api('POST', path, { token: u.token, body });
const add = (u, sheetId, e) => api('PATCH', `/tracking/sheets/${sheetId}`, { token: u.token, body: { add_entry: e } });
const sheetWith = async (u, { sport = 'football', home = 0, away = 0, body = {} } = {}) => {
  const s = (await post(u, '/tracking/sheets', { sport, ...body })).body;
  if (sport === 'football') { await add(u, s.id, { kind: 'period_start', period: 1 }); for (let i = 0; i < home; i++) await add(u, s.id, { kind: 'goal', side: 'home', period: 1 }); for (let i = 0; i < away; i++) await add(u, s.id, { kind: 'goal', side: 'away', period: 1 }); }
  return s;
};
const complete = (u, id) => post(u, `/tracking/sheets/${id}/complete`);

test('Tools catalogue lists Document Designer and Scoring & Game Tracking for any signed-in user', async () => {
  const u = await signup(['athlete']);
  const r = await api('GET', '/tools', { token: u.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((t) => t.route), ['BrandedDocuments', 'ScoringTool']);
  assert.equal((await api('GET', '/tools')).status, 401);
});

test('standalone football: ordinary athlete tracks live, undoes, completes, prints; nothing official moves', async () => {
  const u = await signup(['athlete']);
  const t = (await api('GET', '/tracking/templates?sport=football', { token: u.token })).body;
  assert.equal(t.starter.layout.mode, 'points_events');
  assert.ok(t.starter.layout.scoring.some((s) => s.kind === 'goal'));
  const s = await sheetWith(u, { home: 2, away: 1, body: { labels: { home: 'Reds', away: 'Blues' } } });
  assert.equal(s.mode, 'standalone');
  const mid = (await api('GET', `/tracking/sheets/${s.id}`, { token: u.token })).body;
  assert.equal(mid.label, 'Unofficial / standalone');
  assert.equal(mid.official, false);
  assert.deepEqual([mid.result.home, mid.result.away], [2, 1]);
  const undone = (await api('PATCH', `/tracking/sheets/${s.id}`, { token: u.token, body: { void_entry: { reason: 'wrong side' } } })).body;
  assert.deepEqual([undone.result.home, undone.result.away], [2, 0]);
  assert.equal(undone.entries.filter((e) => e.voided_at).length, 1); // kept in the history, not deleted
  assert.equal((await add(u, s.id, { kind: 'dunk', side: 'home' })).status, 409); // not part of the football rules
  const dup1 = await add(u, s.id, { kind: 'goal', side: 'home', period: 1, client_key: 'k1' }), dup2 = await add(u, s.id, { kind: 'goal', side: 'home', period: 1, client_key: 'k1' });
  assert.equal(dup1.body.result.home, 3); assert.equal(dup2.body.result.home, 3);
  assert.equal((await complete(u, s.id)).body.status, 'completed');
  assert.equal((await add(u, s.id, { kind: 'goal', side: 'home' })).status, 409); // completed sheets are locked
  const pdf = await api('GET', `/tracking/sheets/${s.id}/pdf`, { token: u.token });
  assert.equal(pdf.status, 200); assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM match_events')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM score_sheets')).rows[0].n, 0);
  const mine = (await api('GET', '/tracking/sheets?mode=standalone', { token: u.token })).body;
  assert.equal(mine.length, 1); assert.deepEqual(mine[0].score, { home: 3, away: 0 });
});

test('badminton sets are scored by the canonical engine; best-of format only for set sports', async () => {
  const u = await signup(['athlete']);
  const s = (await post(u, '/tracking/sheets', { sport: 'badminton', variant: 'Doubles', best_of: 3 })).body;
  assert.equal(s.template.ruleset.sets.best_of, 3);
  for (let set = 0; set < 2; set++) for (let i = 0; i < 21; i++) await add(u, s.id, { kind: 'point', side: 'home' });
  const done = (await api('GET', `/tracking/sheets/${s.id}`, { token: u.token })).body;
  assert.deepEqual([done.result.home, done.result.away], [2, 0]);
  assert.equal((await add(u, s.id, { kind: 'point', side: 'away' })).status, 409); // match already decided
  assert.equal((await post(u, '/tracking/sheets', { sport: 'football', best_of: 3 })).status, 400);
});

test('templates: published versions are immutable and sheets keep the version they started on', async () => {
  const u = await signup(['coach']);
  const t = (await post(u, '/tracking/templates', { name: 'Practice game', sport: 'football', customise: { hidden_stats: ['foul'], notes_fields: ['Focus of the session'] } })).body;
  assert.equal((await post(u, '/tracking/sheets', { sport: 'football', template_id: t.id })).status, 409); // draft cannot be used
  const v1 = (await post(u, `/tracking/templates/${t.id}/publish`)).body;
  const s1 = (await post(u, '/tracking/sheets', { template_id: t.id })).body;
  assert.equal(s1.template.version, 1);
  assert.ok(!s1.template.layout.stats.some((x) => x.kind === 'foul'), JSON.stringify([t.draft, s1.template.layout.stats.map((x) => x.kind)]));
  assert.ok(s1.template.layout.scoring.some((x) => x.kind === 'goal'), 'scoring events can never be hidden');
  assert.equal(s1.template.layout.notes_fields[0].official, false);
  const v2 = (await post(u, `/tracking/templates/${t.id}/publish`, { customise: { hidden_stats: ['foul', 'timeout'] } })).body;
  assert.equal(v2.version, 2);
  assert.equal((await api('GET', `/tracking/sheets/${s1.id}`, { token: u.token })).body.template.version, 1);
  await assert.rejects(pool.query('UPDATE tracking_sheet_template_versions SET name=$2 WHERE id=$1', [v1.version_id, 'x']), /immutable/);
  const other = await signup(['athlete']);
  assert.equal((await api('GET', `/tracking/templates/${t.id}`, { token: other.token })).status, 404);
  const prep = (await post(u, '/tracking/templates/prepare', { sport: 'football', brief: 'track fouls and cards' })).body;
  assert.equal(prep.source, 'deterministic'); // works without AI
});

test('sheets are private to their owner', async () => {
  const a = await signup(['athlete']), b = await signup(['athlete']);
  const s = await sheetWith(a, { home: 1 });
  assert.equal((await api('GET', `/tracking/sheets/${s.id}`, { token: b.token })).status, 404);
  assert.equal((await api('GET', `/tracking/sheets/${s.id}/pdf`, { token: b.token })).status, 404);
  assert.equal((await add(b, s.id, { kind: 'goal', side: 'home' })).status, 404);
});

test('upload: type, size and active-content checks; duplicate is idempotent; extraction is reviewed, never official', async () => {
  const u = await signup(['athlete']);
  const pdf = (extra = '') => Buffer.from(`%PDF-1.4\n${extra}\n1 0 obj<<>>endobj\n%%EOF ${Math.random()}`);
  assert.equal((await upload(u.token, 'sport=badminton', Buffer.from('not a document'))).status, 415);
  assert.equal((await upload(u.token, 'sport=badminton', pdf('/JavaScript (app.alert(1))'))).status, 422);
  assert.equal((await upload(u.token, 'sport=badminton', Buffer.alloc(11 * 2 ** 20, 1))).status, 413);
  assert.equal((await upload(u.token, '', pdf())).status, 400);
  // no reader available: manual entry path
  const manual = await upload(u.token, 'sport=badminton', pdf('a'));
  assert.equal(manual.status, 201); assert.equal(manual.body.state, 'needs_manual'); assert.equal(manual.body.extracted, null);
  // reader available: low-confidence field, wrong sport and an impossible set are flagged
  setAiTransport(async () => JSON.stringify({ sheet_code: null, sport: 'Football', home: 2, away: 0, sets: [{ home: 21, away: 15 }, { home: 21, away: 22 }], confidence: { home: 0.95, away: 0.4 }, unreadable: ['stats'] }));
  const bytes = pdf('b');
  const read = await upload(u.token, 'sport=badminton', bytes);
  setAiTransport(null);
  assert.equal(read.status, 201); assert.equal(read.body.state, 'extracted');
  const codes = read.body.warnings.map((w) => w.code);
  assert.ok(codes.includes('low_confidence') && codes.includes('wrong_sport') && codes.includes('illegal_set_score') && codes.includes('unreadable_field'), codes.join());
  const again = await upload(u.token, 'sport=badminton', bytes);
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true); assert.equal(again.body.id, read.body.id);
  const bad = await post(u, `/tracking/imports/${read.body.id}/confirm`, { sport: 'badminton', totals: { home: 2, away: 0, sets: [{ home: 21, away: 15 }, { home: 21, away: 22 }] } });
  assert.equal(bad.status, 422);
  const ok = await post(u, `/tracking/imports/${read.body.id}/confirm`, { sport: 'badminton', best_of: 3, labels: { home: 'Asha', away: 'Ben' }, totals: { home: 2, away: 0, sets: [{ home: 21, away: 15 }, { home: 23, away: 21 }] } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.provenance, 'upload'); assert.equal(ok.body.status, 'completed'); assert.equal(ok.body.official, false);
  assert.equal((await post(u, `/tracking/imports/${read.body.id}/confirm`, { sport: 'badminton', totals: { home: 2, away: 0 } })).body.id, ok.body.id);
  const other = await signup(['athlete']);
  assert.equal((await api('GET', `/tracking/imports/${read.body.id}`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/tracking/imports/${read.body.id}/file`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/tracking/imports/${read.body.id}/file`, { token: u.token })).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM score_sheets')).rows[0].n, 0);
});

test('printed code identifies the sheet but never authorises anything', async () => {
  const { sheetCode, verifySheetCode } = await import('../src/tracking/logic.js');
  const code = sheetCode('TS-ABCDEFGH', 'v1');
  assert.ok(verifySheetCode(code, 'TS-ABCDEFGH', 'v1'));
  assert.ok(!verifySheetCode(code, 'TS-ABCDEFGH', 'v2'));
  assert.ok(!verifySheetCode(code.replace(/.$/, code.endsWith('A') ? 'B' : 'A'), 'TS-ABCDEFGH', 'v1'));
  const owner = await signup(['athlete']), thief = await signup(['athlete']);
  const s = await sheetWith(owner, { home: 1 });
  const c = sheetCode(s.ref, s.template_version_id);
  setAiTransport(async () => JSON.stringify({ sheet_code: c, sport: 'Football', home: 5, away: 0, confidence: { home: 0.9, away: 0.9, sheet_code: 0.9 }, unreadable: [] }));
  const imp = await upload(thief.token, 'sport=football', Buffer.from(`%PDF-1.4 copy ${Math.random()}`));
  setAiTransport(null);
  assert.equal(imp.status, 201);
  assert.equal(imp.body.sheet_id, null, 'a copied code must not bind someone else\'s sheet');
});

test('linked proposal: ordinary user submits, nothing official changes, roles are resolved server-side, multi-step approval, apply is idempotent and feeds the score-sheet lifecycle', async () => {
  const t = await setup('football', 'tournament');
  const s = await sheetWith(t.rando, { home: 2, away: 1 });
  await complete(t.rando, s.id);
  const cands = (await api('GET', `/tracking/link-candidates?sheet_id=${s.id}`, { token: t.rando.token })).body;
  assert.ok(cands.some((c) => c.id === t.fx), JSON.stringify(cands));
  const sub = await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.state, 'proposed');
  const again = await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx });
  assert.equal(again.body.id, sub.body.id); assert.equal(again.body.duplicate, true);
  const pid = sub.body.id;
  const fx = (await pool.query('SELECT status, home_score, away_score FROM fixtures WHERE id=$1', [t.fx])).rows[0];
  assert.deepEqual([fx.status, fx.home_score], ['scheduled', null]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM score_sheets')).rows[0].n, 0);

  // who can act
  assert.equal((await api('GET', `/tracking/proposals/${pid}`, { token: t.other.token })).status, 404);
  assert.equal((await post(t.other, `/tracking/proposals/${pid}/review`, { decision: 'approve' })).status, 404);
  assert.equal((await post(t.rando, `/tracking/proposals/${pid}/review`, { decision: 'approve' })).status, 403); // submitter cannot approve
  assert.equal((await post(t.m1, `/tracking/proposals/${pid}/review`, { decision: 'approve' })).status, 403); // a manager is not asked in a tournament policy
  assert.equal((await post(t.org, `/tracking/proposals/${pid}/review`, { decision: 'approve' })).status, 403); // sequential: referee goes first
  const queue = (await api('GET', '/tracking/awaiting-review', { token: t.ref.token })).body;
  assert.equal(queue.find?.((p) => p.id === pid)?.action ?? JSON.stringify(queue), 'review');
  assert.equal((await api('GET', '/tracking/awaiting-review', { token: t.other.token })).body.length, 0);
  assert.equal((await post(t.ref, `/tracking/proposals/${pid}/review`, { decision: 'reject' })).status, 400); // a reason is required

  const r1 = await post(t.ref, `/tracking/proposals/${pid}/review`, { decision: 'approve' });
  assert.equal(r1.body.state, 'under_review');
  assert.equal((await post(t.ref, `/tracking/proposals/${pid}/review`, { decision: 'approve' })).status, 403); // referee step is done
  assert.equal((await post(t.ref, `/tracking/proposals/${pid}/apply`)).status, 409); // not approved yet
  const r2 = await post(t.org, `/tracking/proposals/${pid}/review`, { decision: 'approve' });
  assert.equal(r2.body.state, 'approved');
  assert.equal(r2.body.reviews.length, 2);
  assert.equal((await post(t.rando, `/tracking/proposals/${pid}/apply`)).status, 403);

  const applied = await post(t.ref, `/tracking/proposals/${pid}/apply`);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.score_sheet.status, 'draft');
  assert.deepEqual([applied.body.score_sheet.home_score, applied.body.score_sheet.away_score], [2, 1]);
  const repeat = await post(t.ref, `/tracking/proposals/${pid}/apply`);
  assert.equal(repeat.body.already_applied, true); assert.equal(repeat.body.score_sheet.id, applied.body.score_sheet.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM score_sheets WHERE fixture_id=$1', [t.fx])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT status FROM fixtures WHERE id=$1', [t.fx])).rows[0].status, 'scheduled', 'still unofficial until the score sheet is published');
  // the existing lifecycle takes over: submit -> sign -> approve -> publish
  const sid = applied.body.score_sheet.id;
  assert.equal((await post(t.ref, `/score-sheets/${sid}/submit`)).status, 200);
  await post(t.m1, `/score-sheets/${sid}/sign`, { decision: 'signed' }); await post(t.m2, `/score-sheets/${sid}/sign`, { decision: 'signed' });
  assert.equal((await post(t.org, `/score-sheets/${sid}/approve`)).status, 200);
  assert.equal((await post(t.org, `/score-sheets/${sid}/publish`)).status, 200);
  const done = (await pool.query('SELECT status, home_score, away_score FROM fixtures WHERE id=$1', [t.fx])).rows[0];
  assert.deepEqual([done.status, done.home_score, done.away_score], ['completed', 2, 1]);
  await assert.rejects(pool.query("UPDATE result_proposal_reviews SET decision='reject'"), /append-only/);
});

test('league policy needs the referee and both managers; changes requested opens a new round; quorum policy; organiser override only when allowed', async () => {
  const t = await setup('football', 'league');
  const s = await sheetWith(t.rando, { home: 1 }); await complete(t.rando, s.id);
  const pid = (await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx })).body.id;
  assert.deepEqual((await api('GET', `/tracking/proposals/${pid}`, { token: t.ref.token })).body.approval.requirements.map((r) => r.key), ['official', 'home_manager', 'away_manager']);
  await post(t.ref, `/tracking/proposals/${pid}/review`, { decision: 'approve' });
  await post(t.m1, `/tracking/proposals/${pid}/review`, { decision: 'approve' });
  assert.equal((await post(t.org, `/tracking/proposals/${pid}/review`, { decision: 'approve', override_reason: 'Both sides agreed in person' })).status, 403); // not allowed by policy
  const cr = await post(t.m2, `/tracking/proposals/${pid}/review`, { decision: 'changes_requested', comment: 'We scored twice' });
  assert.equal(cr.body.state, 'changes_requested');
  assert.equal((await post(t.org, `/tracking/proposals/${pid}/review`, { decision: 'approve' })).status, 409); // deterministic: blocked until resubmitted
  await add(t.rando, s.id, { kind: 'goal', side: 'home', period: 1 }).catch(() => {});
  const re = await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx });
  assert.equal(re.body.round, 2); assert.equal(re.body.state, 'proposed');
  const view = (await api('GET', `/tracking/proposals/${pid}`, { token: t.ref.token })).body;
  assert.equal(view.approval.approved.length, 0, 'a new round starts with a clean slate');
  assert.equal(view.reviews.length, 3, 'earlier rounds stay in the history');

  // quorum 2 of 3 + override, set by the organiser
  const t2 = await setup('football', 'league');
  const put = await api('POST', `/events/${t2.ev.id}/result-approval-policy`, { token: t2.org.token, body: { policy: { mode: 'parallel', quorum: 2, allow_organiser_override: true, requirements: [{ key: 'official', roles: ['official'] }, { key: 'home_manager', roles: ['home_manager'] }, { key: 'away_manager', roles: ['away_manager'] }] } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await api('POST', `/events/${t2.ev.id}/result-approval-policy`, { token: t2.rando.token, body: { policy: put.body.policy } })).status, 403);
  const s2 = await sheetWith(t2.rando, { away: 1 }); await complete(t2.rando, s2.id);
  const p2 = (await post(t2.rando, `/tracking/sheets/${s2.id}/proposals`, { fixture_id: t2.fx })).body.id;
  assert.equal((await post(t2.m2, `/tracking/proposals/${p2}/review`, { decision: 'approve' })).body.state, 'under_review');
  assert.equal((await post(t2.ref, `/tracking/proposals/${p2}/review`, { decision: 'approve' })).body.state, 'approved');
  const t3 = await setup('football', 'league');
  await api('POST', `/events/${t3.ev.id}/result-approval-policy`, { token: t3.org.token, body: { policy: { mode: 'parallel', allow_organiser_override: true, requirements: [{ key: 'official', roles: ['official'] }, { key: 'home_manager', roles: ['home_manager'] }] } } });
  const s3 = await sheetWith(t3.rando, { home: 3 }); await complete(t3.rando, s3.id);
  const p3 = (await post(t3.rando, `/tracking/sheets/${s3.id}/proposals`, { fixture_id: t3.fx })).body.id;
  const ov = await post(t3.org, `/tracking/proposals/${p3}/review`, { decision: 'approve', override_reason: 'Referee unreachable; both managers confirmed' });
  assert.equal(ov.body.state, 'approved'); assert.ok(ov.body.reviews.every((r) => r.override));
});

test('revoked or reassigned official loses authority immediately', async () => {
  const t = await setup('football', 'friendly');
  const s = await sheetWith(t.rando, { home: 1 }); await complete(t.rando, s.id);
  const pid = (await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx })).body.id;
  await pool.query("UPDATE fixture_officials SET status='declined' WHERE fixture_id=$1", [t.fx]);
  assert.equal((await post(t.ref, `/tracking/proposals/${pid}/review`, { decision: 'approve' })).status, 404); // no longer an official of this game: it is not even visible
  assert.equal((await post(t.org, `/tracking/proposals/${pid}/review`, { decision: 'approve' })).body.state, 'approved'); // friendly: referee OR organiser
});

test('stale proposal: an official change after submission blocks apply until re-reviewed', async () => {
  const t = await setup('football', 'friendly');
  const s = await sheetWith(t.rando, { home: 1 }); await complete(t.rando, s.id);
  const pid = (await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx })).body.id;
  await post(t.ref, `/tracking/proposals/${pid}/review`, { decision: 'approve' });
  await pool.query("INSERT INTO match_events(fixture_id, event_id, seq, kind, side, period, recorded_by) VALUES ($1,$2,1,'goal','away',1,$3)", [t.fx, t.ev.id, t.ref.id]);
  const view = (await api('GET', `/tracking/proposals/${pid}`, { token: t.ref.token })).body;
  assert.equal(view.stale, true); assert.equal(view.can_apply, false);
  const ap = await post(t.ref, `/tracking/proposals/${pid}/apply`);
  assert.equal(ap.status, 409); assert.equal(ap.body.error.details?.stale, true);
  const re = await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx });
  assert.equal(re.body.round, 2);
});

test('a proposal that disagrees with the live match log needs the organiser and a reason', async () => {
  const t = await setup('football', 'friendly');
  await pool.query("INSERT INTO match_events(fixture_id, event_id, seq, kind, side, period, recorded_by) VALUES ($1,$2,1,'goal','away',1,$3)", [t.fx, t.ev.id, t.ref.id]);
  await pool.query("UPDATE fixtures SET status='finished' WHERE id=$1", [t.fx]);
  const s = await sheetWith(t.rando, { home: 2 }); await complete(t.rando, s.id);
  const pid = (await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx })).body.id;
  const view = (await api('GET', `/tracking/proposals/${pid}`, { token: t.ref.token })).body;
  assert.ok(view.differences.some((d) => d.code === 'differs_from_match_log'));
  assert.deepEqual([view.current.live_log.home, view.current.live_log.away], [0, 1]);
  await post(t.ref, `/tracking/proposals/${pid}/review`, { decision: 'approve' });
  const refTry = await post(t.ref, `/tracking/proposals/${pid}/apply`, { reconcile_reason: 'Scorer missed two goals' });
  assert.equal(refTry.status, 403, JSON.stringify(refTry.body)); // referee cannot supersede the log
  assert.equal((await post(t.org, `/tracking/proposals/${pid}/apply`)).status, 400);
  const ok = await post(t.org, `/tracking/proposals/${pid}/apply`, { reconcile_reason: 'Scorer missed two goals' });
  assert.equal(ok.status, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM match_events WHERE fixture_id=$1', [t.fx])).rows[0].n, 1, 'the live log is preserved');
});

test('a correction of a published result becomes a revision and keeps the published one in force', async () => {
  const t = await setup('football', 'friendly');
  const s = await sheetWith(t.rando, { home: 1 }); await complete(t.rando, s.id);
  const p1 = (await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx })).body.id;
  await post(t.ref, `/tracking/proposals/${p1}/review`, { decision: 'approve' });
  const sid = (await post(t.ref, `/tracking/proposals/${p1}/apply`)).body.score_sheet.id;
  await post(t.ref, `/score-sheets/${sid}/submit`); await post(t.m1, `/score-sheets/${sid}/sign`, { decision: 'signed' }); await post(t.m2, `/score-sheets/${sid}/sign`, { decision: 'signed' });
  await post(t.org, `/score-sheets/${sid}/approve`); await post(t.org, `/score-sheets/${sid}/publish`);
  const s2 = await sheetWith(t.other, { home: 3 }); await complete(t.other, s2.id);
  const p2 = (await post(t.other, `/tracking/sheets/${s2.id}/proposals`, { fixture_id: t.fx })).body.id;
  await post(t.org, `/tracking/proposals/${p2}/review`, { decision: 'approve' });
  assert.equal((await post(t.org, `/tracking/proposals/${p2}/apply`)).status, 400); // reason required
  const rev = await post(t.org, `/tracking/proposals/${p2}/apply`, { reconcile_reason: 'Result was entered wrongly' });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  assert.equal(rev.body.score_sheet.source, 'revision');
  const rows = (await pool.query('SELECT status, home_score FROM score_sheets WHERE fixture_id=$1 ORDER BY version', [t.fx])).rows;
  assert.deepEqual(rows.map((r) => r.status), ['published', 'draft']);
  assert.equal((await pool.query('SELECT home_score FROM fixtures WHERE id=$1', [t.fx])).rows[0].home_score, 1);
});

test('wrong sport, incompatible rules, hidden events and impossible totals cannot be proposed', async () => {
  const t = await setup('football', 'friendly');
  const bad = await sheetWith(t.rando, { sport: 'badminton' }); await complete(t.rando, bad.id);
  assert.equal((await post(t.rando, `/tracking/sheets/${bad.id}/proposals`, { fixture_id: t.fx })).status, 400);
  const open = await sheetWith(t.rando, { home: 1 });
  assert.equal((await post(t.rando, `/tracking/sheets/${open.id}/proposals`, { fixture_id: t.fx })).status, 409); // not completed yet
  await complete(t.rando, open.id);
  await pool.query("UPDATE events SET status='draft' WHERE id=$1", [t.ev.id]);
  assert.equal((await post(t.rando, `/tracking/sheets/${open.id}/proposals`, { fixture_id: t.fx })).status, 404); // private events are not revealed
  assert.ok(!(await api('GET', `/tracking/link-candidates?sheet_id=${open.id}`, { token: t.rando.token })).body.some((c) => c.id === t.fx));
  await pool.query("UPDATE events SET status='open' WHERE id=$1", [t.ev.id]);
  const bt = await setup('badminton', 'friendly');
  const s3 = (await post(bt.rando, '/tracking/sheets', { sport: 'badminton', best_of: 1 })).body;
  for (let i = 0; i < 21; i++) await add(bt.rando, s3.id, { kind: 'point', side: 'home' });
  await complete(bt.rando, s3.id);
  assert.equal((await post(bt.rando, `/tracking/sheets/${s3.id}/proposals`, { fixture_id: bt.fx })).status, 409); // best of 1 vs the event's best of 3
  await api('POST', `/events/${bt.ev.id}/result-approval-policy`, { token: bt.org.token, body: { policy: { requirements: [{ key: 'official', roles: ['official'] }], allow_public_submission: false } } });
  const s4 = (await post(bt.rando, '/tracking/sheets', { sport: 'badminton' })).body;
  for (let set = 0; set < 2; set++) for (let i = 0; i < 21; i++) await add(bt.rando, s4.id, { kind: 'point', side: 'home' });
  await complete(bt.rando, s4.id);
  assert.equal((await post(bt.rando, `/tracking/sheets/${s4.id}/proposals`, { fixture_id: bt.fx })).status, 403); // event only takes results from its own people
});

test('linked tracker uses the event\'s pinned rules and canonical team names', async () => {
  const t = await setup('badminton', 'tournament');
  const s = await post(t.rando, '/tracking/sheets', { fixture_id: t.fx, labels: { home: 'Fake', away: 'Names' } });
  assert.equal(s.status, 201);
  assert.equal(s.body.mode, 'linked'); assert.equal(s.body.labels.home, t.home.name);
  assert.match(s.body.label, /not official until approved/);
  assert.equal((await api('PATCH', `/tracking/sheets/${s.body.id}`, { token: t.rando.token, body: { labels: { home: 'Mine' } } })).status, 400);
  assert.equal((await post(t.rando, '/tracking/sheets', { fixture_id: t.fx, sport: 'football' })).status, 400);
});

test('two reviewers acting at the same moment give one deterministic state', async () => {
  const t = await setup('football', 'league');
  const s = await sheetWith(t.rando, { home: 1 }); await complete(t.rando, s.id);
  const pid = (await post(t.rando, `/tracking/sheets/${s.id}/proposals`, { fixture_id: t.fx })).body.id;
  const [a, b, c] = await Promise.all([
    post(t.ref, `/tracking/proposals/${pid}/review`, { decision: 'approve' }),
    post(t.m1, `/tracking/proposals/${pid}/review`, { decision: 'approve' }),
    post(t.m2, `/tracking/proposals/${pid}/review`, { decision: 'changes_requested', comment: 'Wrong score' }),
  ]);
  // an approval that arrives after the change request is refused (409); either order ends in the same state
  assert.equal(c.status, 200);
  assert.ok([a.status, b.status].every((x) => [200, 409].includes(x)), `${a.status} ${b.status}`);
  const view = (await api('GET', `/tracking/proposals/${pid}`, { token: t.ref.token })).body;
  assert.equal(view.state, 'changes_requested', 'a negative decision blocks regardless of arrival order');
  assert.equal(view.reviews.length, 1 + [a.status, b.status].filter((x) => x === 200).length, 'every accepted decision is recorded exactly once');
  assert.equal((await post(t.org, `/tracking/proposals/${pid}/apply`)).status, 409);
});

test('context links and AI-arranged layouts are checked and labelled', async () => {
  const u = await signup(['coach']), other = await signup(['athlete']);
  const ev = (await api('POST', '/events', { token: u.token, body: { name: `Ctx Cup ${++n}`, sport: 'football' } })).body;
  await pool.query("UPDATE events SET status='draft' WHERE id=$1", [ev.id]);
  const ok = await post(u, '/tracking/sheets', { sport: 'football', context_type: 'event', context_id: ev.id });
  assert.equal(ok.status, 201); assert.equal(ok.body.context_type, 'event');
  assert.equal((await post(other, '/tracking/sheets', { sport: 'football', context_type: 'event', context_id: ev.id })).status, 404); // a draft event is not visible to others
  assert.equal((await post(other, '/tracking/sheets', { sport: 'football', context_type: 'academy_session', context_id: ev.id })).status, 404);
  assert.equal((await post(u, '/tracking/sheets', { sport: 'football', context_type: 'team' })).status, 400);
  const t = (await post(u, '/tracking/templates', { name: 'AI layout', sport: 'football', from_ai: true, customise: { hidden_stats: ['corner'] } })).body;
  assert.equal(t.origin, 'ai');
  await post(u, `/tracking/templates/${t.id}/publish`);
  const s = (await post(u, '/tracking/sheets', { template_id: t.id })).body;
  assert.equal(s.template.origin, 'ai');
});
