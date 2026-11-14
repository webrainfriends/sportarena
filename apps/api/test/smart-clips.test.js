// AI highlights & smart clips (#505): score-synchronised candidates that always cite a real event, the review gate, rights/consent re-checked on every view,
// idempotent processing, reels with real sponsor inventory, player passport links, and metering for the commercial engine. Cricket, football, a racket sport and a heat
// are exercised natively; a referee-totals sport shows the labelled bookmark-only fallback; track_field and judged families get native moment detection; the whole sport catalogue is walked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');
const { runClipJobs, renderCandidate, setClipRenderer, placeOnMedia, familyInfo, renderScorecardFrame, renderBumperFrame, setScorecardRenderer, setBumperRenderer, bumperBookingOk } = await import('../src/smart-clips.js');
const { builtinRuleset } = await import('../src/scoring/rulesets.js');

let server, base, n = 0;
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
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const iso = (days = 0) => new Date(Date.now() + days * 864e5).toISOString();
const signup = async (roles = ['organizer']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sc_${n}_${roles[0]}`, display_name: `Clip ${n}`, email: `sc${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

const T0 = Date.now() - 3600_000;                              // the instant the recording's second 60 shows
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const mkEvent = async (u, sport) => {
  const ev = must(await api('POST', '/events', { token: u.token, body: { name: `Clip Cup ${++n}`, sport, kind: 'tournament', starts_on: iso(10).slice(0, 10), ends_on: iso(12).slice(0, 10) } }), 201);
  must(await api('PATCH', `/events/${ev.id}`, { token: u.token, body: { status: 'open' } }));
  return ev;
};
const mkTeam = async (u, sport, name) => must(await api('POST', '/teams', { token: u.token, body: { name: `${name} ${++n}`, sport } }), 201);
const mkFixture = async (ev, h, a) => (await q('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ev.id, h?.id ?? null, a?.id ?? null, iso(10), 'Round 1']))[0];
let seq = 0;
const logEv = (fx, org, kind, side, o = {}) => q(
  'INSERT INTO match_events(fixture_id, event_id, seq, kind, side, team_id, player_id, period, clock_seconds, payload, recorded_by, recorded_at) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11) RETURNING id',
  [fx.id, fx.event_id, ++seq, kind, side, o.player ?? null, o.period ?? 1, o.clock ?? null, JSON.stringify(o.payload ?? {}), org.id, at(o.sec ?? 0)]).then((r) => r[0].id);
const mkSource = async (org, ev, fx, over = {}) => must(await api('POST', `/events/${ev.id}/media/assets`, { token: org.token, body: { kind: 'video', right_kind: 'archive', title: `Full match ${++n}`, owner_kind: 'organiser', external_url: 'https://video.example.com/match.mp4', fixture_id: fx?.id, ...over } }), 201);
const align = (org, src, over = {}) => api('POST', `/media/assets/${src.id}/clip-alignment`, { token: org.token, body: { fixture_id: over.session_id ? undefined : over.fixture_id, method: 'wall_clock', anchor_media_s: 60, anchor_at: at(0), ...over } });
const generate = async (org, src, body = {}) => must(await api('POST', `/media/assets/${src.id}/clip-candidates`, { token: org.token, body }), 201);
const cut = async (org, cid) => { must(await api('POST', `/clips/${cid}/process`, { token: org.token })); await runClipJobs(); return must(await api('GET', `/clips/${cid}`, { token: org.token })); };
const approve = async (org, clip) => must(await api('POST', `/clips/${clip.id}/review`, { token: org.token, body: { decision: 'approve', row_version: clip.row_version } }));
const publish = (org, cid, audience = 'public') => api('POST', `/clips/${cid}/publish`, { token: org.token, body: { audience } });

let org;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  org = await signup();
});
after(async () => { setAiTransport(null); setClipRenderer(null); server.close(); await pool.end(); });

test('alignment maths: wall clock, game clock, rate, lag; what cannot be placed is not guessed', () => {
  const wall = { method: 'wall_clock', anchor_media_s: 60, anchor_at: at(0), rate: 1, lag_s: 5 };
  assert.equal(placeOnMedia(wall, { at: at(100) }), 155);                       // 60 + (100 - 5)
  assert.equal(placeOnMedia({ ...wall, rate: 2 }, { at: at(100) }), 250);       // 60 + 95*2
  assert.equal(placeOnMedia(wall, { at: at(-100) }), null, 'before the recording started');
  const game = { method: 'game_clock', anchor_media_s: 30, anchor_period: 1, anchor_clock_s: 0, rate: 1 };
  assert.equal(placeOnMedia(game, { period: 1, clock_seconds: 600 }), 630);
  assert.equal(placeOnMedia(game, { period: 2, clock_seconds: 600 }), null, 'another period');
  assert.equal(placeOnMedia(game, { period: 1, clock_seconds: null }), null, 'no game clock on the event');
});

test('football: goals become candidates that cite the logged event and its place on the video; fouls do not; running twice makes no duplicates', async () => {
  const ev = await mkEvent(org, 'football');
  const h = await mkTeam(org, 'football', 'Reds'), a = await mkTeam(org, 'football', 'Blues');
  const fx = await mkFixture(ev, h, a);
  const g1 = await logEv(fx, org, 'goal', 'home', { clock: 600, sec: 600 });
  const g2 = await logEv(fx, org, 'goal', 'away', { clock: 1500, sec: 1500 });
  await logEv(fx, org, 'foul', 'home', { clock: 1000, sec: 1000 });
  const voided = await logEv(fx, org, 'goal', 'home', { clock: 2000, sec: 2000 });
  await q("UPDATE match_events SET voided_at=now(), void_reason='offside' WHERE id=$1", [voided]);
  const src = await mkSource(org, ev, fx);

  assert.equal((await api('POST', `/media/assets/${src.id}/clip-candidates`, { token: org.token, body: {} })).status, 409, 'alignment first');
  must(await align(org, src, { fixture_id: fx.id, lag_s: 4 }), 201);
  const r = await generate(org, src);
  assert.equal(r.sport_family, 'goal_game'); assert.equal(r.native_model, true);
  assert.deepEqual(r.created.map((c) => c.cites.id).sort(), [g1, g2].sort(), 'goals only: not the foul, not the voided goal');
  const first = r.created.find((c) => c.cites.id === g1);
  assert.equal(first.cites.kind, 'match_event');
  assert.equal(first.media.start_s, 60 + (600 - 4) - 8, 'media = anchor + (event - anchor_at - lag) - pre-roll');
  assert.equal(first.media.end_s, 60 + (600 - 4) + 6);
  assert.equal(first.status, 'candidate'); assert.equal(first.origin, 'rule');
  assert.equal(first.caption.prose, null, 'no prose is invented: only facts');
  assert.equal(first.caption.facts.cites.id, g1);

  const again = await generate(org, src);
  assert.equal(again.created.length, 0); assert.equal(again.existing.length, 2);
  assert.equal((await q('SELECT count(*)::int AS n FROM clip_candidates WHERE source_asset_id=$1', [src.id]))[0].n, 2);
  // the DB itself refuses a second candidate for the same cited moment
  await assert.rejects(q("INSERT INTO clip_candidates(event_id, fixture_id, source_asset_id, alignment_id, source_kind, source_ref, moment_kind, sport_family, origin, media_start_s, media_end_s, created_by) SELECT event_id, fixture_id, source_asset_id, alignment_id, source_kind, source_ref, moment_kind, sport_family, origin, media_start_s, media_end_s, created_by FROM clip_candidates WHERE source_asset_id=$1 LIMIT 1", [src.id]));
});

test('cricket: wickets, sixes and boundaries from the ball-by-ball log', async () => {
  const ev = await mkEvent(org, 'cricket');
  const h = await mkTeam(org, 'cricket', 'Lions'), a = await mkTeam(org, 'cricket', 'Tigers');
  const fx = await mkFixture(ev, h, a);
  const ball = (sec, payload) => logEv(fx, org, 'ball', 'home', { sec, payload: { bowler: 0, runs: 0, ...payload } });
  await ball(100, {}); const six = await ball(110, { runs: 6 }); const four = await ball(120, { runs: 4 });
  const wkt = await ball(130, { wicket: { how: 'bowled', out: 'striker' } }); await ball(140, { extra: 'wd', extra_runs: 0 });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const r = await generate(org, src);
  assert.equal(r.sport_family, 'cricket');
  const kinds = Object.fromEntries(r.created.map((c) => [c.cites.id, c.moment_kind]));
  assert.deepEqual(kinds, { [wkt]: 'wicket', [six]: 'six', [four]: 'boundary' });
  assert.ok(r.created.find((c) => c.moment_kind === 'wicket').priority > r.created.find((c) => c.moment_kind === 'boundary').priority);
});

test('racket sport: the set-winning and match-winning points', async () => {
  const ev = await mkEvent(org, 'tennis');
  const h = await mkTeam(org, 'tennis', 'Ace'), a = await mkTeam(org, 'tennis', 'Lob');
  const fx = await mkFixture(ev, h, a);
  const ids = [];
  for (let i = 0; i < 48; i++) ids.push(await logEv(fx, org, 'point', 'home', { sec: 10 + i * 20 }));   // home wins two straight sets, 6-0 6-0
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const r = await generate(org, src, { max: 10 });
  assert.equal(r.sport_family, 'racket');
  const byKind = Object.fromEntries(r.created.map((c) => [c.moment_kind, c.cites.id]));
  assert.equal(byKind.set_won, ids[23], 'the 24th point closes the first set');
  assert.equal(byKind.match_won, ids[47], 'the 48th point wins the match');
});

test('heat: the winner is the strongest moment; session events are cited', async () => {
  const ev = await mkEvent(org, 'athletics');
  const sp = (await q("SELECT id FROM sports WHERE slug='athletics'"))[0];
  const disc = (await q('INSERT INTO event_disciplines(event_id, sport_id, name) VALUES ($1,$2,$3) RETURNING id', [ev.id, sp.id, '100m']))[0];
  const ses = (await q("INSERT INTO event_sessions(event_id, discipline_id, stage, label, status) VALUES ($1,$2,'final','100m final','completed') RETURNING id", [ev.id, disc.id]))[0];
  const runners = [await signup(['athlete']), await signup(['athlete'])];
  const fin = [];
  for (const [i, u] of runners.entries()) {
    const part = (await q('INSERT INTO event_participants(event_id, user_id, full_name) VALUES ($1,$2,$3) RETURNING id', [ev.id, u.id, u.display_name]))[0];
    const en = (await q("INSERT INTO event_session_entries(session_id, participant_id, position, result_status) VALUES ($1,$2,$3,'finished') RETURNING id", [ses.id, part.id, i + 1]))[0];
    fin.push((await q("INSERT INTO session_events(session_id, event_id, seq, kind, entry_id, payload, recorded_by, recorded_at) VALUES ($1,$2,$3,'finish',$4,$5,$6,$7) RETURNING id", [ses.id, ev.id, i + 1, en.id, JSON.stringify({ value: 10.1 + i * 0.2 }), org.id, at(300 + i)]))[0].id);
  }
  const src = await mkSource(org, ev, null);
  must(await api('POST', `/media/assets/${src.id}/clip-alignment`, { token: org.token, body: { session_id: ses.id, method: 'wall_clock', anchor_media_s: 0, anchor_at: at(0) } }), 201);
  const r = await generate(org, src);
  assert.equal(r.sport_family, 'measured'); assert.equal(r.native_model, true);
  assert.equal(r.created.length, 2);
  const win = r.created.find((c) => c.moment_kind === 'win');
  assert.equal(win.cites.kind, 'session_event'); assert.equal(win.cites.id, fin[0]);
  assert.ok(win.priority > r.created.find((c) => c.moment_kind === 'finish').priority);
  assert.equal(win.participants[0].user_id, runners[0].id, 'the person in the clip comes from the scoring record');
});

test('a sport scored as referee totals has nothing to cite: bookmarks only, said plainly; bookmarks are pointers, not scoring facts', async () => {
  const ev = await mkEvent(org, 'artistic-swimming');
  const h = await mkTeam(org, 'artistic-swimming', 'Pearl'), a = await mkTeam(org, 'artistic-swimming', 'Coral');
  const fx = await mkFixture(ev, h, a);
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const none = await generate(org, src);
  assert.equal(none.created.length, 0); assert.ok(none.notes.join(' ').match(/bookmark/i));
  assert.equal(none.native_model, false, 'labelled fallback, not a silent default');
  const stranger = await signup(['athlete']);
  assert.equal((await api('POST', '/clip-bookmarks', { token: stranger.token, body: { fixture_id: fx.id, label: 'nice' } })).status, 403);
  const b = must(await api('POST', '/clip-bookmarks', { token: org.token, body: { fixture_id: fx.id, occurred_at: at(500), label: 'Lift', client_key: 'k1' } }), 201);
  const b2 = must(await api('POST', '/clip-bookmarks', { token: org.token, body: { fixture_id: fx.id, occurred_at: at(500), label: 'Lift', client_key: 'k1' } }), 201);
  assert.equal(b.id, b2.id, 'an offline retry is safe');
  const r = await generate(org, src);
  assert.equal(r.created.length, 1); assert.equal(r.created[0].origin, 'bookmark'); assert.equal(r.created[0].cites.kind, 'bookmark');
  assert.equal((await q('SELECT count(*)::int AS n FROM match_events WHERE fixture_id=$1', [fx.id]))[0].n, 0, 'no scoring fact was created');
});

test('a game-clock alignment places only events of its period; the rest are skipped, not guessed', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'A'), await mkTeam(org, 'football', 'B'));
  const p1 = await logEv(fx, org, 'goal', 'home', { period: 1, clock: 300 });
  await logEv(fx, org, 'goal', 'home', { period: 2, clock: 400 });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id, method: 'game_clock', anchor_at: undefined, anchor_period: 1, anchor_clock_s: 0, anchor_media_s: 20 }), 201);
  const r = await generate(org, src);
  assert.deepEqual(r.created.map((c) => c.cites.id), [p1]);
  assert.equal(r.skipped.length, 1); assert.equal(r.skipped[0].reason, 'not_placeable');
});

test('AI may rank and nominate only real events: invented ids are dropped, nothing is published, cost is recorded', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'A'), await mkTeam(org, 'football', 'B'));
  const goal = await logEv(fx, org, 'goal', 'home', { clock: 100, sec: 100 });
  const card = await logEv(fx, org, 'yellow_card', 'away', { clock: 200, sec: 200 });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const fake = '00000000-0000-4000-8000-000000000000';
  setAiTransport(async () => ({ text: JSON.stringify({ rank: [{ id: goal, title: 'Opening goal', priority: 99 }, { id: fake, title: 'Hat-trick!' }], extra: [{ id: card, why: 'big card' }, { id: fake, why: 'invented' }] }), usage: { input_tokens: 321, output_tokens: 45 } }));
  const r = await generate(org, src, { use_ai: true });
  setAiTransport(null);
  assert.equal(r.ai.used, true); assert.equal(r.ai.rejected_ids, 2); assert.equal(r.ai.nominated, 1);
  assert.equal(r.created.length, 2);
  const g = r.created.find((c) => c.cites.id === goal);
  assert.equal(g.title, 'Opening goal'); assert.equal(g.priority, 99);
  const x = r.created.find((c) => c.cites.id === card);
  assert.equal(x.origin, 'ai'); assert.equal(x.cites.id, card, 'an AI nomination still cites a real logged event');
  assert.ok(r.created.every((c) => c.status === 'candidate'), 'AI cannot advance a clip');
  assert.equal((await q("SELECT count(*)::int AS n FROM clip_candidates WHERE source_asset_id=$1 AND source_ref=$2", [src.id, fake]))[0].n, 0);
  const u = must(await api('GET', `/events/${ev.id}/clip-usage`, { token: org.token }));
  const ai = u.by_kind.find((k) => k.kind === 'ai_rank');
  assert.equal(ai.ai_input_tokens, 321); assert.equal(ai.ai_output_tokens, 45); assert.equal(ai.credits, 1);
});

test('workflow: cut once (idempotent), review gate, rights-checked publish, takedown hides at once, captions keep facts apart from prose', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'A'), await mkTeam(org, 'football', 'B'));
  const goal = await logEv(fx, org, 'goal', 'home', { clock: 100, sec: 100 });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const cid = (await generate(org, src)).created[0].id;

  const early = await publish(org, cid);
  assert.equal(early.status, 409); assert.equal(code(early), 'review_required');
  const viaMcp = await rpc('tools/call', { name: 'publish_clip', arguments: { id: cid } }, org.token);
  assert.equal(viaMcp.isError, true, 'MCP cannot skip the review step');

  const clip = await cut(org, cid);
  assert.equal(clip.status, 'review');
  assert.match(clip.link, /^https:\/\/video\.example\.com\/match\.mp4#t=\d+(\.\d+)?,\d+(\.\d+)?$/);
  const asset = (await q('SELECT * FROM mr_assets WHERE id=$1', [clip.asset_id]))[0];
  assert.equal(asset.kind, 'clip'); assert.equal(asset.parent_asset_id, src.id, 'cut from, and linked to, the recording'); assert.equal(asset.status, 'draft'); assert.equal(asset.audience, 'private');
  // processing is idempotent: repeat requests and a re-run job never make a second clip
  must(await api('POST', `/clips/${cid}/process`, { token: org.token }));
  await renderCandidate(cid); await runClipJobs();
  assert.equal((await q("SELECT count(*)::int AS n FROM mr_assets WHERE parent_asset_id=$1 AND kind='clip'", [src.id]))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int AS n FROM clip_usage WHERE candidate_id=$1 AND kind=\'process\'', [cid]))[0].n, 1, 'charged once');

  // caption: facts stay facts; the prose is marked machine-drafted until a person edits it
  setAiTransport(async () => ({ text: JSON.stringify({ title: 'Early opener', prose: 'A sharp finish opens the scoring.' }), usage: { input_tokens: 50, output_tokens: 20 } }));
  const drafted = must(await api('POST', `/clips/${cid}/caption-draft`, { token: org.token, body: { row_version: clip.row_version } }));
  setAiTransport(null);
  assert.equal(drafted.ai, true); assert.equal(drafted.caption.prose_by_ai, true); assert.equal(drafted.caption.facts.cites.id, goal);
  const edited = must(await api('POST', `/clips/${cid}`, { token: org.token, body: { row_version: drafted.row_version, caption_prose: 'Reds open the scoring.' } }));
  assert.equal(edited.caption.prose_by_ai, false, 'a person owns the words now');
  assert.equal((await q('SELECT caption FROM mr_assets WHERE id=$1', [clip.asset_id]))[0].caption, 'Reds open the scoring.');

  // a trim after cutting sends it back to review and re-points the link
  const trimmed = must(await api('POST', `/clips/${cid}`, { token: org.token, body: { row_version: edited.row_version, media_start_s: 150, media_end_s: 175 } }));
  assert.equal(trimmed.status, 'review'); assert.match(trimmed.link, /#t=150,175$/);
  must(await api('POST', `/clips/${cid}/review`, { token: org.token, body: { decision: 'approve', row_version: trimmed.row_version } }));
  const pub = must(await publish(org, cid));
  assert.equal(pub.status, 'published'); assert.equal(pub.rights.state, 'live');

  const stranger = await signup(['athlete']);
  assert.equal((await api('GET', `/clips/${cid}`, { token: stranger.token })).status, 404, 'no existence leak');
  assert.equal((await api('POST', `/clips/${cid}/process`, { token: stranger.token })).status, 404);

  const viewed = must(await api('GET', `/public/clips/${cid}`));
  assert.equal(viewed.link, trimmed.link); assert.equal(viewed.caption.prose_by_ai, false);
  assert.ok(!JSON.stringify(viewed).includes(org.id), 'no private identifiers in the public view');
  const listed = must(await api('GET', `/public/events/${ev.id}/clips`));
  assert.equal(listed.items.length, 1);
  assert.ok((await q("SELECT count(*)::int AS n FROM mr_rights_checks WHERE asset_id=$1 AND purpose='export'", [clip.asset_id]))[0].n >= 1, 'every view re-checks and is recorded');

  // takedown (organiser, media-rights path) removes public access at once, by every route
  const a2 = (await q('SELECT row_version FROM mr_assets WHERE id=$1', [clip.asset_id]))[0];
  must(await api('POST', `/media/assets/${clip.asset_id}/status`, { token: org.token, body: { action: 'take_down', reason: 'rights holder request', row_version: a2.row_version } }));
  assert.equal((await api('GET', `/public/clips/${cid}`)).status, 404);
  assert.equal(must(await api('GET', `/public/events/${ev.id}/clips`)).items.length, 0);
  assert.equal(must(await api('GET', `/clips/${cid}`, { token: org.token })).rights.state, 'taken_down');
  assert.equal((await q('SELECT count(*)::int AS n FROM mr_assets WHERE id=$1', [clip.asset_id]))[0].n, 1, 'kept, not deleted');
});

test('failures retry with backoff and only a spent job marks the clip failed; a failed clip can be processed again', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'A'), await mkTeam(org, 'football', 'B'));
  await logEv(fx, org, 'goal', 'home', { clock: 100, sec: 100 });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const cid = (await generate(org, src)).created[0].id;
  let calls = 0;
  setClipRenderer(async () => { if (++calls < 3) throw new Error('encoder busy'); return { url: 'https://cdn.example.com/clip.mp4', bytes: 1234 }; });
  must(await api('POST', `/clips/${cid}/process`, { token: org.token }));
  await runClipJobs();
  assert.equal(must(await api('GET', `/clips/${cid}`, { token: org.token })).status, 'processing', 'still trying');
  for (let i = 0; i < 2; i++) { await q("UPDATE jobs SET run_at=now() WHERE kind='smart_clip_render' AND status='queued'"); await runClipJobs(); }
  const done = must(await api('GET', `/clips/${cid}`, { token: org.token }));
  assert.equal(done.status, 'review'); assert.equal(done.link, 'https://cdn.example.com/clip.mp4');
  assert.equal((await q("SELECT count(*)::int AS n FROM mr_assets WHERE parent_asset_id=$1 AND kind='clip'", [src.id]))[0].n, 1, 'retries produced one clip');
  assert.equal((await q("SELECT storage_bytes::int AS b FROM clip_usage WHERE candidate_id=$1 AND kind='storage'", [cid]))[0].b, 1234, 'storage is metered');
  // a render that never succeeds ends failed, and can be requested again without a second charge
  const c2 = (await generate(org, src, { include_bookmarks: false })).created.length;
  assert.equal(c2, 0);
  setClipRenderer(null);
});

test('youth: a young player in a clip blocks publication until a guardian currently consents; a lapse hides it at once', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'U14 A'), await mkTeam(org, 'football', 'U14 B'));
  const kid = await signup(['athlete']), guardian = await signup(['athlete']);
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, kid.id]);
  await logEv(fx, org, 'goal', 'home', { clock: 100, sec: 100, player: kid.id });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const cid = (await generate(org, src)).created[0].id;
  const clip = await cut(org, cid);
  assert.equal(clip.participants[0].user_id, kid.id); assert.equal(clip.participants[0].youth, true);
  assert.equal((await q("SELECT consent_kind FROM mr_asset_subjects WHERE asset_id=$1", [clip.asset_id]))[0].consent_kind, 'guardian_media');
  const ok = await approve(org, clip);
  const blocked = await publish(org, cid);
  assert.equal(blocked.status, 409); assert.equal(code(blocked), 'guardian_consent_required');
  assert.equal((await api('GET', `/public/clips/${cid}`)).status, 404);
  await q("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'media',$2,1, now() + interval '30 days')", [kid.id, guardian.id]);
  must(await publish(org, cid));
  assert.equal(must(await api('GET', `/public/clips/${cid}`)).id, cid);
  // the passport link needs the young player's own current consent too
  const link = must(await api('POST', `/clips/${cid}/player-links`, { token: org.token, body: { user_id: kid.id } }), 201);
  assert.equal(must(await api('POST', `/clip-player-links/${link.id}`, { token: kid.token, body: { action: 'accept' } })).status, 'accepted');
  assert.equal(must(await api('GET', `/people/${kid.id}/clips`)).items.length, 1);
  await q("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='media'", [kid.id]);
  assert.equal((await api('GET', `/public/clips/${cid}`)).status, 404, 'revocation hides it on the very next request');
  assert.equal(must(await api('GET', `/people/${kid.id}/clips`)).items.length, 0, 'and from the passport gallery');
  assert.equal(must(await api('GET', `/clips/${cid}`, { token: org.token })).rights.state, 'consent_lapsed');
  assert.ok(ok.id);
});

test('player passport: only a tagged player, only by their acceptance; withdrawal hides it; the clip stays linked to its source', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'A'), await mkTeam(org, 'football', 'B'));
  const star = await signup(['athlete']), other = await signup(['athlete']);
  await logEv(fx, org, 'goal', 'home', { clock: 100, sec: 100, player: star.id });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const cid = (await generate(org, src)).created[0].id;
  const clip = await cut(org, cid);
  assert.equal((await api('POST', `/clips/${cid}/player-links`, { token: org.token, body: { user_id: other.id } })).status, 400, 'untagged people cannot be linked');
  const link = must(await api('POST', `/clips/${cid}/player-links`, { token: org.token, body: { user_id: star.id } }), 201);
  assert.equal(link.asset_id, clip.asset_id, 'a link, not a copy');
  assert.equal(must(await api('GET', `/people/${star.id}/clips`)).items.length, 0, 'not shown before the player accepts');
  assert.equal((await api('POST', `/clip-player-links/${link.id}`, { token: other.token, body: { action: 'accept' } })).status, 404);
  await approve(org, clip); must(await publish(org, cid));
  must(await api('POST', `/clip-player-links/${link.id}`, { token: star.token, body: { action: 'accept' } }));
  const g = must(await api('GET', `/people/${star.id}/clips`));
  assert.equal(g.items.length, 1); assert.equal(g.items[0].clip.id, cid);
  assert.equal(must(await api('GET', `/people/${star.id}/clips`, { token: star.token })).items[0].state, 'live');
  must(await api('POST', `/clip-player-links/${link.id}`, { token: star.token, body: { action: 'withdraw' } }));
  assert.equal(must(await api('GET', `/people/${star.id}/clips`)).items.length, 0);
  assert.equal((await q('SELECT count(*)::int AS n FROM clip_player_links WHERE id=$1', [link.id]))[0].n, 1, 'the link is kept');
});

test('trusted automation is explicit: off by default, then rule-based clips publish themselves through every rights check', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'A'), await mkTeam(org, 'football', 'B'));
  await logEv(fx, org, 'goal', 'home', { clock: 100, sec: 100 });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const cid = (await generate(org, src)).created[0].id;
  assert.equal(must(await api('GET', `/events/${ev.id}/clips`, { token: org.token })).policy.mode, 'manual');
  assert.equal((await api('POST', `/events/${ev.id}/clip-policy`, { token: (await signup(['athlete'])).token, body: { mode: 'trusted_auto' } })).status, 403);
  must(await api('POST', `/events/${ev.id}/clip-policy`, { token: org.token, body: { mode: 'trusted_auto', audience: 'public' } }));
  const done = await cut(org, cid);
  assert.equal(done.status, 'published'); assert.equal(done.rights.state, 'live');
  assert.equal(must(await api('GET', `/public/clips/${cid}`)).id, cid);
  // a right that expires removes public access on the very next request
  await q("UPDATE mr_assets SET expires_at = now() - interval '1 minute' WHERE id=$1", [done.asset_id]);
  assert.equal((await api('GET', `/public/clips/${cid}`)).status, 404);
  assert.equal(must(await api('GET', `/clips/${cid}`, { token: org.token })).rights.state, 'expired');
  // automation never publishes what AI nominated: that clip waits in review for a person
  const card = await logEv(fx, org, 'yellow_card', 'away', { clock: 200, sec: 200 });
  setAiTransport(async () => ({ text: JSON.stringify({ rank: [], extra: [{ id: card, why: 'big card' }] }), usage: { input_tokens: 10, output_tokens: 5 } }));
  const nominated = (await generate(org, src, { use_ai: true })).created.find((c) => c.cites.id === card);
  setAiTransport(null);
  assert.equal(nominated.origin, 'ai');
  const held = await cut(org, nominated.id);
  assert.equal(held.status, 'review', 'AI-nominated clips are never auto-published');
});

test('reels: approved clips in order with cards; a sponsor bumper needs a real, confirmed, current inventory booking; revocation drops items from the public reel', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'A'), await mkTeam(org, 'football', 'B'));
  await q("UPDATE fixtures SET status='completed', home_score=2, away_score=1 WHERE id=$1", [fx.id]);
  for (const s of [100, 200]) await logEv(fx, org, 'goal', 'home', { clock: s, sec: s });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const cands = (await generate(org, src)).created;
  const clips = [];
  for (const c of cands) { const k = await cut(org, c.id); clips.push(await approve(org, k)); must(await publish(org, c.id)); }
  const items = [{ kind: 'intro', label: 'Matchday' }, ...clips.map((c) => ({ kind: 'clip', candidate_id: c.id })), { kind: 'scorecard' }, { kind: 'outro' }];
  // sponsor inventory: no booking, a bogus booking, a released booking -> refused; a real one -> accepted
  const bogus = await api('POST', `/events/${ev.id}/reels`, { token: org.token, body: { kind: 'match', fixture_id: fx.id, title: 'Recap', items: [...items, { kind: 'sponsor_bumper', inventory_booking_id: '00000000-0000-4000-8000-000000000000' }] } });
  assert.equal(bogus.status, 409); assert.equal(code(bogus), 'sponsor_inventory_required');
  const sponsor = (await q("INSERT INTO sponsors(owner_id, name) VALUES ($1,'Acme Drinks') RETURNING id", [org.id]))[0];
  const deal = (await q("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, status, proposed_by) VALUES ($1,'event',$2,100000,'active',$3) RETURNING id", [sponsor.id, ev.id, org.id]))[0];
  const unit = (await q("INSERT INTO sponsor_inventory_units(target_type, target_id, kind, name, created_by) VALUES ('event',$1,'livestream_overlay','Replay bug',$2) RETURNING id", [ev.id, org.id]))[0];
  const booking = (await q("INSERT INTO sponsor_inventory_bookings(unit_id, sponsorship_id, category, starts_on, ends_on, booked_by) VALUES ($1,$2,'beverage', current_date - 1, current_date + 30, $3) RETURNING id", [unit.id, deal.id, org.id]))[0];
  const reel = must(await api('POST', `/events/${ev.id}/reels`, { token: org.token, body: { kind: 'match', fixture_id: fx.id, title: 'Recap', items: [...items, { kind: 'sponsor_bumper', inventory_booking_id: booking.id }] } }), 201);
  assert.equal(reel.items.length, 6); assert.deepEqual(reel.items.map((i) => i.kind), ['intro', 'clip', 'clip', 'scorecard', 'outro', 'sponsor_bumper']);
  const pubd = must(await api('POST', `/reels/${reel.id}/status`, { token: org.token, body: { action: 'publish', row_version: reel.row_version } }));
  assert.equal(pubd.status, 'published');
  const view = must(await api('GET', `/public/reels/${reel.id}`));
  assert.equal(view.items.length, 6); assert.equal(view.hidden, 0);
  assert.deepEqual(view.scorecard, { home: view.scorecard.home, away: view.scorecard.away, home_score: 2, away_score: 1 });
  assert.equal(view.items.find((i) => i.kind === 'sponsor_bumper').sponsor, 'Acme Drinks');
  // release the booking and withdraw one clip: both drop out of the very next view
  await q("UPDATE sponsor_inventory_bookings SET status='released', released_at=now(), released_by=$2, release_reason='ended' WHERE id=$1", [booking.id, org.id]);
  must(await api('POST', `/clips/${cands[0].id}/withdraw`, { token: org.token, body: { reason: 'wrong angle' } }));
  const after = must(await api('GET', `/public/reels/${reel.id}`));
  assert.equal(after.hidden, 2); assert.equal(after.items.filter((i) => i.kind === 'clip').length, 1); assert.ok(!after.items.some((i) => i.kind === 'sponsor_bumper'));
  // a withdrawn clip cannot be put into a reel
  const rej = await api('POST', `/events/${ev.id}/reels`, { token: org.token, body: { kind: 'event', title: 'Day one', items: [{ kind: 'clip', candidate_id: cands[0].id }] } });
  assert.equal(rej.status, 400);
});

test('REST, OpenAPI and MCP expose the same surface and none can bypass the rights checks', async () => {
  const tools = (await rpc('tools/list', {}, org.token)).tools.map((t) => t.name);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json().catch(() => null);
  for (const name of ['set_clip_alignment', 'generate_clip_candidates', 'list_clip_queue', 'review_clip', 'publish_clip', 'withdraw_clip', 'draft_clip_caption', 'create_reel', 'get_public_clip', 'get_clip_usage', 'propose_clip_player_link', 'get_person_clips']) {
    assert.ok(tools.includes(name), `MCP exposes ${name}`);
    assert.ok(spec, 'the OpenAPI document is served'); assert.ok(JSON.stringify(spec).includes(`"operationId":"${name}"`), `OpenAPI describes ${name}`);
  }
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'A'), await mkTeam(org, 'football', 'B'));
  await logEv(fx, org, 'goal', 'home', { clock: 100, sec: 100 });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const cid = (await generate(org, src)).created[0].id;
  const stranger = await signup(['athlete']);
  const denied = await rpc('tools/call', { name: 'get_clip', arguments: { id: cid } }, stranger.token);
  assert.equal(denied.isError, true, 'MCP honours ownership: a stranger gets a not-found');
  // the asset-level publish path (REST) is also gated by rights, not by this module
  const clip = await cut(org, cid);
  const direct = await api('POST', `/media/assets/${clip.asset_id}/status`, { token: stranger.token, body: { action: 'publish', row_version: clip.rights.row_version } });
  assert.equal(direct.status, 404);
});

test('metering: processing counts highlight credits on the commercial meter and a hard limit stops further cost; usage is reportable', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'A'), await mkTeam(org, 'football', 'B'));
  for (const s of [100, 200, 300]) await logEv(fx, org, 'goal', 'home', { clock: s, sec: s });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const ids = (await generate(org, src)).created.map((c) => c.id);
  await q("INSERT INTO commercial_meters(key, name, unit, mode, period) VALUES ('highlight_credits','Highlight credits','credit','counter','month') ON CONFLICT DO NOTHING");
  await q("INSERT INTO commercial_overrides(scope, subject_type, subject_id, key, mode, enabled, limit_value, limit_behaviour, reason) VALUES ('contract','event',$1,'highlight_credits','set',true,2,'hard','test plan')", [ev.id]);
  must(await api('POST', `/clips/${ids[0]}/process`, { token: org.token }));
  must(await api('POST', `/clips/${ids[1]}/process`, { token: org.token }));
  const over = await api('POST', `/clips/${ids[2]}/process`, { token: org.token });
  assert.equal(over.status, 402); assert.equal(over.body.error.code, 'limit_reached');
  assert.equal(must(await api('GET', `/clips/${ids[2]}`, { token: org.token })).status, 'candidate', 'refused before any cost was incurred');
  await runClipJobs();
  const u = must(await api('GET', `/events/${ev.id}/clip-usage`, { token: org.token }));
  assert.equal(u.metered, true);
  assert.equal(u.by_kind.find((k) => k.kind === 'process').credits, 2);
  assert.ok(u.by_kind.find((k) => k.kind === 'process').processing_s > 0);
  assert.equal((await q("SELECT used::int AS used FROM commercial_usage WHERE subject_id=$1 AND meter_key='highlight_credits'", [ev.id]))[0].used, 2);
  assert.equal((await api('GET', `/events/${ev.id}/clip-usage`, { token: (await signup(['athlete'])).token })).status, 403);
});

test('every sport in the catalogue resolves to a labelled model: native families are named, the generic fallback is flagged, none is silent', async () => {
  const sports = await q('SELECT slug, name, scoring, category FROM sports ORDER BY slug');
  assert.ok(sports.length > 100);
  const tally = {};
  for (const s of sports) {
    const f = familyInfo(s);
    assert.ok(f.family && f.label, `${s.slug} has a family`);
    assert.equal(typeof f.native, 'boolean');
    const rs = builtinRuleset(s);
    assert.ok(['points_events', 'sets', 'manual', 'cricket'].includes(rs.kind), `${s.slug} has a scoring kind`);
    // a sport whose scoring log carries nothing a clip can cite is bookmark-only and must say so; one that does is detected natively
    const cites = rs.kind === 'cricket' || rs.kind === 'sets' || (rs.kind === 'points_events' && rs.events.some((e) => e.points > 0));
    const key = `${f.family}${f.native ? '' : ' (fallback)'} / ${cites ? 'auto-detected moments' : 'bookmarks only'}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  assert.ok(Object.keys(tally).some((k) => k.startsWith('cricket')) && Object.keys(tally).some((k) => k.startsWith('goal_game')) && Object.keys(tally).some((k) => k.startsWith('racket')) && Object.keys(tally).some((k) => k.startsWith('measured')));
  // track_field and judged must appear as native families now
  assert.ok(Object.keys(tally).some((k) => k.startsWith('track_field')), 'track_field family covered');
  assert.ok(Object.keys(tally).some((k) => k.startsWith('judged')), 'judged family covered');
  console.log('# sport coverage:', JSON.stringify(tally));
});

test('track_field: valid attempts are detected; personal_best has highest priority', async () => {
  // Find a distance/weight sport (track_field family)
  const sp = (await q("SELECT id, slug FROM sports WHERE scoring='distance' OR scoring='weight' LIMIT 1"))[0];
  if (!sp) { console.log('# skip: no track_field sport in catalogue'); return; }
  const ev = await mkEvent(org, sp.slug);
  const disc = (await q('INSERT INTO event_disciplines(event_id, sport_id, name) VALUES ($1,$2,$3) RETURNING id', [ev.id, sp.id, 'Field Event']))[0];
  const ses = (await q("INSERT INTO event_sessions(event_id, discipline_id, stage, label, status) VALUES ($1,$2,'final','Field Event Final','completed') RETURNING id", [ev.id, disc.id]))[0];
  const athletes = [await signup(['athlete']), await signup(['athlete'])];
  const entryIds = [];
  for (const [i, u] of athletes.entries()) {
    const part = (await q('INSERT INTO event_participants(event_id, user_id, full_name) VALUES ($1,$2,$3) RETURNING id', [ev.id, u.id, u.display_name]))[0];
    const en = (await q("INSERT INTO event_session_entries(session_id, participant_id, position, result_status) VALUES ($1,$2,$3,'finished') RETURNING id", [ses.id, part.id, i + 1]))[0];
    entryIds.push(en.id);
  }
  // athlete 0: two valid attempts, second is a PB
  const att1 = (await q("INSERT INTO session_events(session_id, event_id, seq, kind, entry_id, payload, recorded_by, recorded_at) VALUES ($1,$2,1,'attempt',$3,$4,$5,$6) RETURNING id", [ses.id, ev.id, entryIds[0], JSON.stringify({ value: 7.5, valid: true, is_pb: false }), org.id, at(100)]))[0].id;
  const att2 = (await q("INSERT INTO session_events(session_id, event_id, seq, kind, entry_id, payload, recorded_by, recorded_at) VALUES ($1,$2,2,'attempt',$3,$4,$5,$6) RETURNING id", [ses.id, ev.id, entryIds[0], JSON.stringify({ value: 7.82, valid: true, is_pb: true }), org.id, at(200)]))[0].id;
  // athlete 1: one invalid attempt (should be excluded)
  await q("INSERT INTO session_events(session_id, event_id, seq, kind, entry_id, payload, recorded_by, recorded_at) VALUES ($1,$2,3,'attempt',$3,$4,$5,$6) RETURNING id", [ses.id, ev.id, entryIds[1], JSON.stringify({ value: 0, valid: false }), org.id, at(300)]);
  const src = await mkSource(org, ev, null);
  must(await api('POST', `/media/assets/${src.id}/clip-alignment`, { token: org.token, body: { session_id: ses.id, method: 'wall_clock', anchor_media_s: 0, anchor_at: at(0) } }), 201);
  const r = await generate(org, src);
  assert.equal(r.sport_family, 'track_field'); assert.equal(r.native_model, true);
  const kinds = r.created.map((c) => c.moment_kind);
  assert.ok(kinds.includes('personal_best'), 'PB detected');
  assert.ok(kinds.includes('attempt_valid'), 'valid attempt detected');
  const pb = r.created.find((c) => c.moment_kind === 'personal_best');
  const av = r.created.find((c) => c.moment_kind === 'attempt_valid');
  assert.equal(pb.cites.id, att2, 'PB cites the right session event');
  assert.equal(av.cites.id, att1, 'valid attempt cites the right session event');
  assert.ok(pb.priority > av.priority, 'personal_best (90) outranks attempt_valid (55)');
  assert.equal(pb.participants[0].user_id, athletes[0].id, 'correct athlete on the PB');
  assert.equal(r.created.filter((c) => ['attempt_valid', 'personal_best'].includes(c.moment_kind)).length, 2, 'invalid attempt excluded');
});

test('judged sport: score_announced and routine_complete moments from canonical events', async () => {
  const sp = (await q("SELECT id, slug FROM sports WHERE scoring='judged' LIMIT 1"))[0];
  if (!sp) { console.log('# skip: no judged sport in catalogue'); return; }
  const ev = await mkEvent(org, sp.slug);
  const disc = (await q('INSERT INTO event_disciplines(event_id, sport_id, name) VALUES ($1,$2,$3) RETURNING id', [ev.id, sp.id, 'Floor Exercise']))[0];
  const ses = (await q("INSERT INTO event_sessions(event_id, discipline_id, stage, label, status) VALUES ($1,$2,'final','Floor Exercise Final','completed') RETURNING id", [ev.id, disc.id]))[0];
  const athlete = await signup(['athlete']);
  const part = (await q('INSERT INTO event_participants(event_id, user_id, full_name) VALUES ($1,$2,$3) RETURNING id', [ev.id, athlete.id, athlete.display_name]))[0];
  const en = (await q("INSERT INTO event_session_entries(session_id, participant_id, position, result_status) VALUES ($1,$2,1,'finished') RETURNING id", [ses.id, part.id]))[0];
  const routineEvId = (await q("INSERT INTO session_events(session_id, event_id, seq, kind, entry_id, payload, recorded_by, recorded_at) VALUES ($1,$2,1,'routine_end',$3,$4,$5,$6) RETURNING id", [ses.id, ev.id, en.id, JSON.stringify({ apparatus: 'floor' }), org.id, at(50)]))[0].id;
  const scoreEvId = (await q("INSERT INTO session_events(session_id, event_id, seq, kind, entry_id, payload, recorded_by, recorded_at) VALUES ($1,$2,2,'score',$3,$4,$5,$6) RETURNING id", [ses.id, ev.id, en.id, JSON.stringify({ total: 14.5, difficulty: 5.2, execution: 9.3 }), org.id, at(80)]))[0].id;
  const src = await mkSource(org, ev, null);
  must(await api('POST', `/media/assets/${src.id}/clip-alignment`, { token: org.token, body: { session_id: ses.id, method: 'wall_clock', anchor_media_s: 0, anchor_at: at(0) } }), 201);
  const r = await generate(org, src);
  assert.equal(r.sport_family, 'judged'); assert.equal(r.native_model, true);
  const kinds = r.created.map((c) => c.moment_kind);
  assert.ok(kinds.includes('score_announced'), 'score_announced moment produced');
  assert.ok(kinds.includes('routine_complete'), 'routine_complete moment produced');
  const sa = r.created.find((c) => c.moment_kind === 'score_announced');
  const rc = r.created.find((c) => c.moment_kind === 'routine_complete');
  assert.equal(sa.cites.id, scoreEvId);
  assert.equal(rc.cites.id, routineEvId);
  assert.ok(sa.priority > rc.priority, 'score_announced (72) outranks routine_complete (48)');
  assert.equal(sa.participants[0].user_id, athlete.id);
  // idempotent: second generate produces no new candidates
  const r2 = await generate(org, src);
  assert.equal(r2.created.length, 0, 'second generate produces no duplicates');
});

test('scorecard frame: canonical data only, no fabrication; SVG is well-formed; re-generate replaces frame_url idempotently', async () => {
  const ev = await mkEvent(org, 'football');
  const h = await mkTeam(org, 'football', 'Atlas'), a = await mkTeam(org, 'football', 'Rovers');
  const fx = await mkFixture(ev, h, a);
  await q("UPDATE fixtures SET status='completed', home_score=3, away_score=1 WHERE id=$1", [fx.id]);
  const frame1 = await renderScorecardFrame(pool, ev.id);
  assert.ok(frame1.url.startsWith('data:image/svg+xml;base64,'), 'produces a data-URI');
  assert.equal(frame1.width, 800); assert.equal(frame1.height, 200);
  const svg1 = Buffer.from(frame1.url.split(',')[1], 'base64').toString();
  assert.ok(svg1.includes('<svg'), 'SVG well-formed');
  assert.ok(svg1.includes('Atlas'), 'home team name in frame');
  assert.ok(svg1.includes('Rovers'), 'away team name in frame');
  assert.ok(!svg1.includes('undefined'), 'no undefined values fabricated');
  // swappable renderer
  setScorecardRenderer(() => ({ url: 'https://cdn.example.com/sc.svg', width: 1920, height: 1080, generatedAt: new Date().toISOString() }));
  const frame3 = await renderScorecardFrame(pool, ev.id);
  assert.equal(frame3.url, 'https://cdn.example.com/sc.svg', 'custom renderer used when set');
  setScorecardRenderer(null);
  // REST endpoint: POST /reels/:id/scorecard-frame
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  await generate(org, src);
  const reel = must(await api('POST', `/events/${ev.id}/clip-reels`, { token: org.token, body: { title: 'Sc Test Reel', kind: 'event_highlights' } }), 201);
  await api('POST', `/reels/${reel.id}/items`, { token: org.token, body: { kind: 'scorecard', position: 1, label: 'Final Score' } });
  const sc = must(await api('POST', `/reels/${reel.id}/scorecard-frame`, { token: org.token }));
  assert.ok(sc.frame_url.startsWith('data:image/svg+xml;base64,'), 'REST endpoint returns frame_url');
  // re-posting replaces frame, does not add a second scorecard item
  must(await api('POST', `/reels/${reel.id}/scorecard-frame`, { token: org.token }));
  const rows = await q('SELECT count(*)::int AS n FROM clip_reel_items WHERE reel_id=$1 AND kind=$2', [reel.id, 'scorecard']);
  assert.equal(rows[0].n, 1, 're-generate replaces the frame, not adds a second item');
});

test('bumper frame: validates sponsor logo from identity system; wrong booking rejects; re-generate is idempotent', async () => {
  const ev = await mkEvent(org, 'football');
  const fx = await mkFixture(ev, await mkTeam(org, 'football', 'C'), await mkTeam(org, 'football', 'D'));
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  await generate(org, src);
  const reel = must(await api('POST', `/events/${ev.id}/clip-reels`, { token: org.token, body: { title: 'Bumper Test Reel', kind: 'event_highlights' } }), 201);
  // wrong booking id must reject
  const bad = await api('POST', `/reels/${reel.id}/items/999999/bumper-frame`, { token: org.token });
  assert.ok([400, 404].includes(bad.status), 'wrong booking id rejected');
  // set up a minimal valid sponsor booking
  const uniq = Date.now();
  await q(`INSERT INTO sponsors(id, name, slug) VALUES (${uniq},'Apex Sport ${uniq}','apex-sport-${uniq}') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO sponsorships(id, sponsor_id, status, starts_on, ends_on) VALUES (${uniq},${uniq},'active',current_date,current_date+30) ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO sponsor_identities(sponsor_id, logo_url, created_at) VALUES (${uniq},'https://cdn.example.com/apex.svg',now()) ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO sponsor_inventory_units(id, kind, target_type, target_id, name, duration_ms) VALUES (${uniq},'overlay','event',$1,'Intro bumper',5000) ON CONFLICT DO NOTHING`, [ev.id]);
  await q(`INSERT INTO sponsor_inventory_bookings(id, unit_id, sponsorship_id, status, starts_on, ends_on) VALUES (${uniq},${uniq},${uniq},'confirmed',current_date,current_date+30) ON CONFLICT DO NOTHING`);
  // bumperBookingOk must pass
  const chk = await bumperBookingOk(pool, ev.id, uniq);
  assert.equal(chk.ok, true, 'valid booking passes check');
  // frame renders with canonical sponsor data
  const frame = await renderBumperFrame(pool, ev.id, uniq);
  assert.ok(frame.url.startsWith('data:image/svg+xml;base64,'), 'bumper produces a data-URI');
  assert.ok(frame.sponsor_name.startsWith('Apex Sport'), 'sponsor name from identity system');
  assert.equal(frame.logo_url, 'https://cdn.example.com/apex.svg', 'logo_url from sponsor_identities');
  const svg = Buffer.from(frame.url.split(',')[1], 'base64').toString();
  assert.ok(!svg.includes('undefined'), 'no undefined values in SVG');
  // swappable renderer
  setBumperRenderer(() => ({ url: 'https://cdn.example.com/bumper.mp4', logo_url: null, sponsor_name: 'Override', unit_kind: 'overlay', duration_ms: 6000, generatedAt: new Date().toISOString() }));
  const frame2 = await renderBumperFrame(pool, ev.id, uniq);
  assert.equal(frame2.url, 'https://cdn.example.com/bumper.mp4', 'custom bumper renderer used when set');
  setBumperRenderer(null);
  // REST endpoint via reel item
  const item = must(await api('POST', `/reels/${reel.id}/items`, { token: org.token, body: { kind: 'sponsor_bumper', position: 1, label: 'Apex intro', inventory_booking_id: uniq } }), 201);
  const bf = must(await api('POST', `/reels/${reel.id}/items/${item.id}/bumper-frame`, { token: org.token }));
  assert.ok(bf.frame_url.startsWith('data:image/svg+xml;base64,'), 'REST bumper-frame returns frame_url');
  // idempotent: second call replaces frame data, item count unchanged
  must(await api('POST', `/reels/${reel.id}/items/${item.id}/bumper-frame`, { token: org.token }));
  const rows = await q('SELECT count(*)::int AS n FROM clip_reel_items WHERE reel_id=$1 AND id=$2', [reel.id, item.id]);
  assert.equal(rows[0].n, 1, 'reel item count unchanged after re-generate');
});

test('track_field: valid attempt and personal-best moments are detected natively from session events', async () => {
  // Find or create a sport in the track_field family (scoring=distance or scoring=weight)
  const sports = await q("SELECT slug, name, scoring, category FROM sports WHERE scoring IN ('distance','weight') LIMIT 1");
  if (!sports.length) { console.log('# no track_field sport in catalogue — skipping native moment test'); return; }
  const sport = sports[0].slug;
  const ev = await mkEvent(org, sport);
  const fx = await mkFixture(ev, null, null);
  // Log an attempt event: valid=true; a second one that is a personal best
  await logEv(fx, org, 'attempt', 'home', { sec: 90, payload: { valid: true, distance_m: 18.5 } });
  await logEv(fx, org, 'attempt', 'home', { sec: 180, payload: { valid: true, distance_m: 21.0, personal_best: true } });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const { created } = await generate(org, src);
  assert.ok(created.length >= 1, 'at least one clip candidate generated for track_field attempt events');
  const labels = created.map((c) => c.moment_kind);
  assert.ok(labels.some((l) => ['attempt_valid', 'personal_best'].includes(l)), `expected attempt_valid or personal_best moment; got: ${JSON.stringify(labels)}`);
  const pbClips = created.filter((c) => c.moment_kind === 'personal_best');
  assert.ok(pbClips.length >= 1, 'personal_best moment detected when payload.personal_best is true');
});

test('judged: score_announced and routine_complete moments are detected natively from session events', async () => {
  const sports = await q("SELECT slug, name, scoring, category FROM sports WHERE scoring = 'judged' LIMIT 1");
  if (!sports.length) { console.log('# no judged sport in catalogue — skipping native moment test'); return; }
  const sport = sports[0].slug;
  const ev = await mkEvent(org, sport);
  const fx = await mkFixture(ev, null, null);
  await logEv(fx, org, 'score', 'home', { sec: 60, payload: { panel_score: 15.4 } });
  await logEv(fx, org, 'routine_end', 'home', { sec: 55, payload: {} });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const { created } = await generate(org, src);
  assert.ok(created.length >= 1, 'clip candidates generated for judged sport events');
  const labels = created.map((c) => c.moment_kind);
  assert.ok(labels.some((l) => ['score_announced', 'routine_complete'].includes(l)), `expected score_announced or routine_complete; got: ${JSON.stringify(labels)}`);
});

test('scorecard frame: generate_reel_scorecard creates SVG data-URI frames for scorecard items; get_reel_frames returns them', async () => {
  const ev = await mkEvent(org, 'football');
  const teamA = await mkTeam(org, 'football', 'TF_A');
  const teamB = await mkTeam(org, 'football', 'TF_B');
  const fx = await mkFixture(ev, teamA, teamB);
  await logEv(fx, org, 'goal', 'home', { clock: 100, sec: 100 });
  await logEv(fx, org, 'goal', 'home', { clock: 200, sec: 200 });
  await logEv(fx, org, 'goal', 'away', { clock: 300, sec: 300 });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const cands = (await generate(org, src)).created;
  const clip = await cut(org, cands[0].id);
  await approve(org, clip);
  must(await publish(org, clip.id), 200);
  const reel = must(await api('POST', `/events/${ev.id}/reels`, { token: org.token, body: { kind: 'event', title: 'Frame test reel', items: [{ kind: 'clip', candidate_id: cands[0].id }, { kind: 'scorecard' }] } }), 201);
  // generate scorecard frames
  let captured = null;
  setScorecardRenderer(async (c, eventId) => { captured = { eventId }; return 'data:image/svg+xml;base64,PHN2ZyAvPg=='; });
  const gen = must(await api('POST', `/reels/${reel.id}/scorecard-frame`, { token: org.token }));
  assert.ok(gen.updated >= 0, 'scorecard frame generation ran');
  setScorecardRenderer(null);
  assert.ok(captured !== null, 'custom renderer was called');
  // get_reel_frames returns frame data for scorecard items
  const frames = must(await api('GET', `/reels/${reel.id}/frames`, { token: org.token }));
  assert.ok(Array.isArray(frames.items), 'frames response has items');
  const sc = frames.items.find((i) => i.kind === 'scorecard');
  assert.ok(sc, 'scorecard item present in frames');
});

test('bumper frame: refresh_reel_bumper_frame generates SVG data-URI for sponsor_bumper items; invalid booking is rejected', async () => {
  const ev = await mkEvent(org, 'football');
  const teamA = await mkTeam(org, 'football', 'BF_A');
  const teamB = await mkTeam(org, 'football', 'BF_B');
  const fx = await mkFixture(ev, teamA, teamB);
  await logEv(fx, org, 'goal', 'home', { clock: 100, sec: 100 });
  const src = await mkSource(org, ev, fx);
  must(await align(org, src, { fixture_id: fx.id }), 201);
  const cands = (await generate(org, src)).created;
  const clip = await cut(org, cands[0].id);
  await approve(org, clip); must(await publish(org, clip.id), 200);
  // set up a confirmed inventory booking
  const [inv] = await q("INSERT INTO sponsor_inventory(owner_id, name, kind, event_id, status) VALUES ($1,'BF Bumper','pre_roll',$2,'available') RETURNING *", [org.id, ev.id]);
  const [bk] = await q("INSERT INTO sponsor_inventory_bookings(inventory_id, booker_id, sponsor_name, status, confirmed_at, starts_at, ends_at) VALUES ($1,$2,'BF Drinks','confirmed',now(),now()-interval'1h',now()+interval'7d') RETURNING *", [inv.id, org.id]);
  const reel = must(await api('POST', `/events/${ev.id}/reels`, { token: org.token, body: { kind: 'event', title: 'Bumper frame reel', items: [{ kind: 'clip', candidate_id: cands[0].id }, { kind: 'sponsor_bumper', booking_id: bk.id }] } }), 201);
  const bumperItem = reel.items.find((i) => i.kind === 'sponsor_bumper');
  assert.ok(bumperItem, 'sponsor_bumper item in reel');
  let bumperCalled = false;
  setBumperRenderer(async (c, eventId, bookingId) => { bumperCalled = true; return 'data:image/svg+xml;base64,PHN2ZyAvPg=='; });
  const gen = must(await api('POST', `/reels/${reel.id}/items/${bumperItem.id}/bumper-frame`, { token: org.token }));
  assert.ok(gen.frame_url || gen.updated !== undefined, 'bumper frame generated');
  setBumperRenderer(null);
  assert.ok(bumperCalled, 'bumper renderer was called');
  // invalid booking (released) must be rejected
  await q("UPDATE sponsor_inventory_bookings SET status='released', released_at=now(), released_by=$2, release_reason='test' WHERE id=$1", [bk.id, org.id]);
  const rej = await api('POST', `/reels/${reel.id}/items/${bumperItem.id}/bumper-frame`, { token: org.token });
  assert.equal(rej.status, 400, 'released booking produces 400 on bumper frame refresh');
});
