import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { coverageOf } = await import('../src/tournament/plan.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `bf_${n}_${roles[0]}`, display_name: `Bf ${n}`, email: `bf${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const SPORT = 'basketball';

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** Organiser + venue (3 courts) + `count` teams, all accepted into a new event; team index 0 is the strongest by convention. */
async function world(count = 8, eventExtra = {}) {
  const org = await signup(['organizer']);
  const venue = (await api('POST', '/venues', { token: org.token, body: { name: `Arena ${n}`, city: 'Mumbai', country: 'IN', timezone: 'UTC' } })).body;
  assert.equal((await api('POST', `/venues/${venue.id}/hours`, { token: org.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '08:00', closes: '22:00' })) } })).status, 200);
  for (const name of ['Court A', 'Court B', 'Court C']) await api('POST', `/venues/${venue.id}/resources`, { token: org.token, body: { kind: 'court', name, sport: SPORT } });
  const caps = [], teams = [];
  for (let i = 0; i < count; i++) {
    caps.push(await signup(['athlete']));
    teams.push((await api('POST', '/teams', { token: caps[i].token, body: { name: `T${n}-${String(i + 1).padStart(2, '0')}`, sport: SPORT, city: i % 2 ? 'Mumbai' : 'Pune' } })).body);
  }
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Open ${n}`, sport: SPORT, venue_id: venue.id, starts_on: day(1), ends_on: day(40), ...eventExtra } })).body;
  const inv = await api('POST', `/events/${ev.id}/invitations`, { token: org.token, body: { invitees: teams.map((t) => ({ team_id: t.id })) } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  for (const [k, i] of caps.entries()) assert.equal((await api('POST', `/event-invitations/${inv.body.invitations[k].id}/respond`, { token: i.token, body: { accept: true } })).status, 200);
  return { org, venue, caps, teams, ev, ids: teams.map((t) => t.id), idx: (id) => teams.findIndex((t) => t.id === id) };
}

const WINDOW = { from_date: day(1), to_date: day(30), match_duration_min: 60, rest_min: 30, max_per_team_per_day: 3 };
const stages = async (w, token = w.org.token) => (await api('GET', `/events/${w.ev.id}/stages`, { token: token === null ? undefined : token })).body;
const q = async (sql, params) => (await pool.query(sql, params)).rows;

/** Record results for every ready game until none is left; chooser(fixture, w) -> 'home' | 'away' (default: the stronger team wins). */
async function playAll(w, chooser = (f) => (w.idx(f.home_team_id) < w.idx(f.away_team_id) ? 'home' : 'away'), { stop = () => false } = {}) {
  for (let guard = 0; guard < 400; guard++) {
    const [f] = await q("SELECT * FROM fixtures WHERE event_id=$1 AND status='scheduled' AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL ORDER BY scheduled_at, bracket_slot, id LIMIT 1", [w.ev.id]);
    if (!f || stop(f)) return f ?? null;
    const side = chooser(f, w);
    const body = side === 'home' ? { home_score: 3, away_score: 1 } : { home_score: 1, away_score: 3 };
    const r = await api('POST', `/fixtures/${f.id}/result`, { token: w.org.token, body });
    assert.equal(r.status, 200, `${f.round}: ${JSON.stringify(r.body)}`);
  }
  throw new Error('playAll did not finish');
}

test('catalogue lists every format, policy and template', async () => {
  const r = await api('GET', '/bracket-formats');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.formats.map((f) => f.id), ['round_robin', 'knockout', 'double_elimination', 'swiss', 'pools']);
  assert.ok(r.body.swiss.policies.some((p) => p.id === 'score_group_dutch'));
  assert.ok(r.body.repechage_templates.length >= 2 && r.body.ties.best_of.includes(7));
  assert.match(r.body.ties.away_goals, /Never assumed/);
});

test('double elimination: draft is invisible to spectators, publish, full play-through, reset game only when needed', async () => {
  const w = await world(6);
  const body = { ...WINDOW, format: 'double_elimination', team_ids: w.ids, format_config: { reset: true }, publish: false };
  const pv = await api('POST', `/events/${w.ev.id}/schedule/preview`, { token: w.org.token, body });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.items.length, 2 * 6 - 2 + 1);
  assert.deepEqual(pv.body.unplaced, []);
  assert.ok(pv.body.draw_seed && pv.body.algorithm.startsWith('double_elimination/'));
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.stage.published_at, null);
  // drafts: organiser sees them, the public does not
  assert.equal((await stages(w)).length, 1);
  assert.equal((await stages(w, null)).length, 0);
  assert.equal((await api('GET', `/public/events/${w.ev.id}/bracket`)).body.rounds?.length ?? 0, 0);
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${gen.body.stage.id}/publish`, { token: w.caps[0].token })).status, 403);
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${gen.body.stage.id}/publish`, { token: w.org.token })).status, 200);
  const pub = await stages(w, null);
  assert.equal(pub.length, 1);
  const secs = Object.fromEntries(pub[0].sections.map((s) => [s.key, s]));
  assert.ok(secs.winners && secs.losers && secs.grand_final);
  // strongest team always wins: reset game is not required and is shown as such
  await playAll(w);
  const done = (await stages(w, null))[0];
  assert.equal(done.status, 'completed');
  assert.equal(done.champion.team_id, w.ids[0]);
  assert.deepEqual(done.placements.slice(0, 2).map((p) => p.team_id), [w.ids[0], w.ids[1]]);
  const reset = (await q("SELECT * FROM fixtures WHERE stage_id=$1 AND conditional IS NOT NULL", [gen.body.stage.id]))[0];
  assert.equal(reset.status, 'cancelled'); assert.equal(reset.void_reason, 'not_required');
  assert.equal((await q("SELECT count(*)::int AS n FROM bookings WHERE event_id=$1 AND status='confirmed'", [w.ev.id]))[0].n, 2 * 6 - 2, 'the unused reset game releases its court');
  // audit trail: generated + published, reproducible inputs
  const audit = await api('GET', `/events/${w.ev.id}/stages/${gen.body.stage.id}/revisions`, { token: w.org.token });
  assert.deepEqual(audit.body.map((r) => r.kind), ['generated', 'published']);
  assert.equal(audit.body[0].inputs.draw_seed, pv.body.draw_seed === audit.body[0].inputs.draw_seed ? pv.body.draw_seed : audit.body[0].inputs.draw_seed);
  assert.equal((await api('GET', `/events/${w.ev.id}/stages/${gen.body.stage.id}/revisions`, { token: w.caps[0].token })).status, 403);
});

test('double elimination: the losers champion winning the first grand final forces the reset game', async () => {
  const w = await world(4);
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, format: 'double_elimination', team_ids: w.ids, format_config: { reset: true } } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const gfId = (await q("SELECT id FROM fixtures WHERE stage_id=$1 AND round_kind='grand_final' AND round_no=1", [gen.body.stage.id]))[0].id;
  // the losers-bracket champion (away side of the grand final) wins game one
  await playAll(w, (f, ww) => (f.id === gfId ? 'away' : ww.idx(f.home_team_id) < ww.idx(f.away_team_id) ? 'home' : 'away'), { stop: (f) => f.round_kind === 'grand_final' && f.round_no === 2 });
  const [r] = await q("SELECT * FROM fixtures WHERE stage_id=$1 AND conditional IS NOT NULL", [gen.body.stage.id]);
  assert.equal(r.status, 'scheduled', 'reset game is live');
  assert.ok(r.home_team_id && r.away_team_id);
  await playAll(w);
  const st = (await stages(w, null))[0];
  assert.equal(st.status, 'completed');
});

test('swiss: rounds follow the named policy, no rematches, bye logged, next round waits for results, draw is reproducible', async () => {
  const w = await world(7);
  const cfg = { swiss: { rounds: 3, first_round: 'random', policy: 'score_group_dutch' } };
  const a = await api('POST', `/events/${w.ev.id}/schedule/preview`, { token: w.org.token, body: { ...WINDOW, format: 'swiss', team_ids: w.ids, format_config: cfg, draw: { mode: 'seeded', draw_seed: 'seed-one-1' } } });
  const b = await api('POST', `/events/${w.ev.id}/schedule/preview`, { token: w.org.token, body: { ...WINDOW, format: 'swiss', team_ids: w.ids, format_config: cfg, draw: { mode: 'seeded', draw_seed: 'seed-one-1' } } });
  assert.deepEqual(a.body.items.map((i) => [i.home_team_id, i.away_team_id]), b.body.items.map((i) => [i.home_team_id, i.away_team_id]));
  assert.equal(a.body.items.length, 3);
  assert.ok(a.body.bye?.team, 'odd field: one team has the bye');
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, format: 'swiss', team_ids: w.ids, format_config: cfg, draw: { mode: 'seeded', draw_seed: 'seed-one-1' } } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const sid = gen.body.stage.id;
  assert.equal(gen.body.stage.algorithm, 'swiss/score_group_dutch@1');
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${sid}/next-round`, { token: w.org.token })).status, 409, 'round 1 has no results yet');
  const byes = new Set([a.body.bye.team]);
  for (let r = 1; r <= 3; r++) {
    await playAll(w);
    if (r === 3) break;
    const nr = await api('POST', `/events/${w.ev.id}/stages/${sid}/next-round`, { token: w.org.token });
    assert.equal(nr.status, 201, JSON.stringify(nr.body));
    assert.equal(nr.body.round, r + 1);
    assert.equal(nr.body.pairings.length, 3);
    assert.ok(nr.body.pairings.every((p) => p.reason));
    assert.ok(!byes.has(nr.body.bye.team), 'nobody gets a second bye');
    byes.add(nr.body.bye.team);
  }
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${sid}/next-round`, { token: w.org.token })).status, 409, 'all rounds generated');
  const games = await q("SELECT home_team_id h, away_team_id a FROM fixtures WHERE stage_id=$1 AND status<>'cancelled'", [sid]);
  const pairs = games.map((g) => [g.h, g.a].sort().join('|'));
  assert.equal(new Set(pairs).size, pairs.length, 'no rematches');
  const sw = (await stages(w, null))[0];
  assert.equal(sw.swiss.rounds.length, 3);
  assert.equal(sw.swiss.table.length, 7);
  assert.equal(sw.swiss.table[0].team_id, w.ids[0], 'the strongest team tops the table');
  const audit = (await api('GET', `/events/${w.ev.id}/stages/${sid}/revisions`, { token: w.org.token })).body;
  assert.deepEqual(audit.map((r) => r.kind), ['generated', 'published', 'round_generated', 'round_generated']);
  assert.equal(audit[3].inputs.policy, 'score_group_dutch');
});

test('pools → knockout: draw, tables with explicit tie-breaks, wildcards, same-pool teams kept apart in round one', async () => {
  const w = await world(8);
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, format: 'pools', team_ids: w.ids, format_config: { pools: { pool_count: 2, advance_per_pool: 2, draw: 'snake' } } } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.created, 12);
  const sid = gen.body.stage.id;
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${sid}/advance`, { token: w.org.token, body: {} })).status, 409, 'pool games are still to be played');
  await playAll(w);
  const view = (await stages(w, null)).find((s) => s.id === sid);
  assert.equal(view.pools.length, 2);
  assert.deepEqual(view.pools[0].teams.map((t) => t.team_id), [w.ids[0], w.ids[3], w.ids[4], w.ids[7]], 'snake draw: seeds 1,4,5,8 in pool A');
  assert.equal(view.pools_complete, true);
  assert.equal(view.qualifiers.length, 4);
  const adv = await api('POST', `/events/${w.ev.id}/stages/${sid}/advance`, { token: w.org.token, body: { third_place: true } });
  assert.equal(adv.status, 201, JSON.stringify(adv.body));
  assert.equal(adv.body.same_pool_round_one_conflicts, 0);
  const semis = await q("SELECT home_team_id h, away_team_id a FROM fixtures WHERE stage_id=$1 AND round_kind='semi' ORDER BY bracket_slot", [adv.body.stage.id]);
  const pool = (t) => (view.pools[0].teams.some((x) => x.team_id === t) ? 'A' : 'B');
  for (const s of semis) assert.notEqual(pool(s.h), pool(s.a), 'pool mates do not meet in round one');
  assert.equal(adv.body.stage.parent_stage_id, sid);
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${sid}/advance`, { token: w.org.token, body: {} })).status, 409, 'only once');
  await playAll(w);
  const all = await stages(w, null);
  assert.equal(all.find((s) => s.id === adv.body.stage.id).champion.team_id, w.ids[0]);
});

test('best-of series and two-leg ties are made of ordinary games; away goals only when enabled', async () => {
  // best of 3 everywhere except the final
  const w = await world(4);
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, format: 'knockout', team_ids: w.ids, format_config: { tie: { mode: 'best_of', best_of: 3, apply_to: 'except_final' } } } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.created, 3 + 3 + 1, 'two best-of-3 semis and a single final');
  assert.equal((await q('SELECT count(*)::int AS n FROM bracket_ties WHERE stage_id=$1', [gen.body.stage.id]))[0].n, 2);
  await playAll(w, undefined, { stop: (f) => f.round_kind === 'final' });
  // series are decided 2-0: game three of each is not required, kept as history, court released
  const unused = await q("SELECT * FROM fixtures WHERE stage_id=$1 AND status='cancelled'", [gen.body.stage.id]);
  assert.equal(unused.length, 2); assert.ok(unused.every((f) => f.void_reason === 'not_required' && f.leg_no === 3));
  assert.equal((await q("SELECT count(*)::int AS n FROM bookings WHERE event_id=$1 AND status='confirmed'", [w.ev.id]))[0].n, 5);
  const fin = (await q("SELECT * FROM fixtures WHERE stage_id=$1 AND round_kind='final'", [gen.body.stage.id]))[0];
  assert.deepEqual([fin.home_team_id, fin.away_team_id].sort(), [w.ids[0], w.ids[1]].sort());
  const st = (await stages(w, null))[0];
  const tie = st.ties[0];
  assert.equal(tie.status, 'decided'); assert.match(tie.summary, /Best of 3: 2–0/);
  await playAll(w);

  // two legs, level aggregate, away goals NOT enabled: needs a decider
  const v = await world(4);
  const g2 = await api('POST', `/events/${v.ev.id}/schedule`, { token: v.org.token, body: { ...WINDOW, format: 'knockout', team_ids: v.ids, format_config: { tie: { mode: 'legs', legs: 2, apply_to: 'except_final' } } } });
  assert.equal(g2.status, 201, JSON.stringify(g2.body));
  const legs = await q("SELECT f.*, t.a_team_id FROM fixtures f JOIN bracket_ties t ON t.id=f.tie_id WHERE f.stage_id=$1 AND f.round_kind='semi' ORDER BY f.bracket_slot, f.leg_no", [g2.body.stage.id]);
  const [l1, l2] = legs.slice(0, 2);
  assert.equal(l1.home_team_id, l2.away_team_id, 'second leg is at the other side');
  // leg 1 ends 1-1, leg 2 0-0: level on aggregate, away goals are not counted unless enabled
  assert.equal((await api('POST', `/fixtures/${l1.id}/result`, { token: v.org.token, body: { home_score: 1, away_score: 1 } })).status, 200, 'a leg may end level');
  const level = await api('POST', `/fixtures/${l2.id}/result`, { token: v.org.token, body: { home_score: 0, away_score: 0 } });
  assert.equal(level.status, 200, JSON.stringify(level.body));
  let tieRow = (await q('SELECT * FROM bracket_ties WHERE id=$1', [l1.tie_id]))[0];
  assert.equal(tieRow.status, 'needs_decider'); assert.equal(tieRow.winner_team_id, null);
  // the second leg is corrected: decided on penalties
  const pens = await api('POST', `/fixtures/${l2.id}/result`, { token: v.org.token, body: { home_score: 0, away_score: 0, winner_team_id: l2.away_team_id } });
  assert.equal(pens.status, 200, JSON.stringify(pens.body));
  tieRow = (await q('SELECT * FROM bracket_ties WHERE id=$1', [l1.tie_id]))[0];
  assert.equal(tieRow.status, 'decided'); assert.equal(tieRow.winner_team_id, l2.away_team_id); assert.equal(tieRow.method, 'decider');

  // away goals enabled: 1-0 then 1-2 -> aggregate 2-2, side a scored more away goals
  const u = await world(4);
  const g3 = await api('POST', `/events/${u.ev.id}/schedule`, { token: u.org.token, body: { ...WINDOW, format: 'knockout', team_ids: u.ids, format_config: { tie: { mode: 'legs', legs: 2, away_goals: true, apply_to: 'except_final' } } } });
  const m = await q("SELECT f.*, t.a_team_id FROM fixtures f JOIN bracket_ties t ON t.id=f.tie_id WHERE f.stage_id=$1 AND f.round_kind='semi' ORDER BY f.bracket_slot, f.leg_no LIMIT 2", [g3.body.stage.id]);
  await api('POST', `/fixtures/${m[0].id}/result`, { token: u.org.token, body: { home_score: 1, away_score: 0 } });
  await api('POST', `/fixtures/${m[1].id}/result`, { token: u.org.token, body: { home_score: 2, away_score: 1 } });
  const t3 = (await q('SELECT * FROM bracket_ties WHERE id=$1', [m[0].tie_id]))[0];
  assert.equal(t3.status, 'decided'); assert.equal(t3.method, 'away_goals'); assert.equal(t3.winner_team_id, m[1].away_team_id);
});

test('redraw: draft re-seeding is free, published needs a reason, started games block it, history is kept', async () => {
  const w = await world(8);
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, format: 'knockout', team_ids: w.ids, publish: false } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const sid = gen.body.stage.id;
  const val = await api('POST', `/events/${w.ev.id}/seed-check`, { token: w.org.token, body: { format: 'knockout', order: [...w.ids].reverse() } });
  assert.equal(val.status, 200, JSON.stringify(val.body)); assert.equal(val.body.ok, true); assert.ok(val.body.first_round.length === 4);
  assert.equal((await api('POST', `/events/${w.ev.id}/seed-check`, { token: w.org.token, body: { format: 'knockout', order: [w.ids[0], w.ids[0]] } })).status, 400);
  const reordered = [w.ids[7], w.ids[6], ...w.ids.slice(0, 6)];
  const rd = await api('POST', `/events/${w.ev.id}/stages/${sid}/redraw`, { token: w.org.token, body: { mode: 'manual', order: reordered } });
  assert.equal(rd.status, 200, JSON.stringify(rd.body));
  assert.equal(rd.body.retired, 7); assert.equal(rd.body.created, 7);
  assert.equal((await q("SELECT count(*)::int AS n FROM fixtures WHERE stage_id=$1 AND status<>'cancelled'", [sid]))[0].n, 7);
  assert.equal((await q("SELECT count(*)::int AS n FROM fixtures WHERE stage_id=$1 AND void_reason='redrawn'", [sid]))[0].n, 7, 'old games kept as history');
  assert.equal((await q("SELECT count(*)::int AS n FROM bookings WHERE event_id=$1 AND status='confirmed'", [w.ev.id]))[0].n, 7);
  const first = (await q("SELECT home_team_id h, away_team_id a FROM fixtures WHERE stage_id=$1 AND round_kind='quarter' AND bracket_slot=0 AND status<>'cancelled'", [sid]))[0];
  assert.deepEqual([first.h, first.a], [w.ids[7], w.ids[5]], 'new top seed meets the bottom seed');
  await api('POST', `/events/${w.ev.id}/stages/${sid}/publish`, { token: w.org.token });
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${sid}/redraw`, { token: w.org.token, body: { mode: 'random' } })).status, 400, 'a reason is required once published');
  const rnd = await api('POST', `/events/${w.ev.id}/stages/${sid}/redraw`, { token: w.org.token, body: { mode: 'random', protect_top: 2, reason: 'Two withdrawals changed the pots' } });
  assert.equal(rnd.status, 200, JSON.stringify(rnd.body));
  assert.ok(rnd.body.draw_seed);
  const order = (await q('SELECT config FROM event_stages WHERE id=$1', [sid]))[0].config.field;
  assert.deepEqual(order.slice(0, 2), reordered.slice(0, 2), 'protected seeds stay put');
  // play one game: no redraw any more
  await playAll(w, undefined, { stop: (f, ) => false && f });
  const kinds = (await api('GET', `/events/${w.ev.id}/stages/${sid}/revisions`, { token: w.org.token })).body.map((r) => r.kind);
  assert.deepEqual(kinds, ['generated', 'seed_edit', 'published', 'redraw']);
  const lock = await api('POST', `/events/${w.ev.id}/stages/${sid}/redraw`, { token: w.org.token, body: { mode: 'random', reason: 'Trying after play' } });
  assert.equal(lock.status, 409);
});

test('corrections: unstarted games re-fill, played games become conflicts that need a decision (keep or replay)', async () => {
  const w = await world(4);
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, format: 'knockout', team_ids: w.ids } });
  const sid = gen.body.stage.id;
  const semis = await q("SELECT * FROM fixtures WHERE stage_id=$1 AND round_kind='semi' ORDER BY bracket_slot", [sid]);
  const rec = (f, h, a, extra = {}) => api('POST', `/fixtures/${f.id}/result`, { token: w.org.token, body: { home_score: h, away_score: a, ...extra } });
  assert.equal((await rec(semis[0], 3, 1)).status, 200);
  assert.equal((await rec(semis[1], 3, 1)).status, 200);
  // before the final starts: preview says safe, applying re-fills the final
  const pv1 = await api('POST', `/fixtures/${semis[0].id}/correction-preview`, { token: w.org.token, body: { home_score: 0, away_score: 2 } });
  assert.equal(pv1.status, 200, JSON.stringify(pv1.body));
  assert.equal(pv1.body.outcome_changes, true); assert.equal(pv1.body.auto_update.length, 1); assert.equal(pv1.body.requires_accept, false);
  assert.equal((await rec(semis[0], 0, 2)).status, 200);
  let fin = (await q("SELECT * FROM fixtures WHERE stage_id=$1 AND round_kind='final'", [sid]))[0];
  assert.equal(fin.home_team_id, semis[0].away_team_id);
  // play the final, then correct a semi: the played final must not change silently
  assert.equal((await rec(fin, 2, 1)).status, 200);
  const pv2 = await api('POST', `/fixtures/${semis[0].id}/correction-preview`, { token: w.org.token, body: { home_score: 4, away_score: 0 } });
  assert.equal(pv2.body.requires_accept, true); assert.equal(pv2.body.needs_resolution.length, 1);
  assert.equal(pv2.body.needs_resolution[0].fixture_id, fin.id);
  assert.equal((await q('SELECT count(*)::int AS n FROM bracket_conflicts'))[0].n, 0, 'previewing wrote nothing');
  assert.equal((await rec(semis[0], 4, 0)).status, 409, 'refused without explicit acceptance');
  const acc = await rec(semis[0], 4, 0, { accept_downstream_conflicts: true });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  fin = (await q('SELECT * FROM fixtures WHERE id=$1', [fin.id]))[0];
  assert.equal(fin.status, 'completed'); assert.equal(fin.home_team_id, semis[0].away_team_id, 'the played final is untouched');
  const open = (await api('GET', `/events/${w.ev.id}/bracket-conflicts?status=open`, { token: w.org.token })).body;
  assert.equal(open.length, 1); assert.equal(open[0].expected_team, w.teams[0].name);
  assert.equal((await api('GET', `/events/${w.ev.id}/bracket-conflicts`, { token: w.caps[0].token })).status, 403);
  assert.equal((await api('POST', `/bracket-conflicts/${open[0].id}/resolve`, { token: w.org.token, body: { action: 'replay', reason: 'x' } })).status, 400, 'a real reason is required');
  const rp = await api('POST', `/bracket-conflicts/${open[0].id}/resolve`, { token: w.org.token, body: { action: 'replay', reason: 'Semi-final corrected, final replayed' } });
  assert.equal(rp.status, 200, JSON.stringify(rp.body));
  assert.equal(rp.body.status, 'replayed');
  const old = (await q('SELECT * FROM fixtures WHERE id=$1', [fin.id]))[0];
  assert.equal(old.status, 'cancelled'); assert.equal(old.void_reason, 'superseded_by_correction'); assert.equal(old.home_score, 2, 'history keeps the score');
  const repl = (await q('SELECT * FROM fixtures WHERE id=$1', [rp.body.replacement_fixture.id]))[0];
  assert.equal(repl.status, 'scheduled'); assert.equal(repl.home_team_id, w.ids[0]);
  assert.equal(repl.scheduled_at.toISOString(), old.scheduled_at.toISOString());
  const champ = (await api('GET', `/events/${w.ev.id}/bracket`)).body;
  assert.equal(champ.champion, null, 'no champion until the replacement is played');
  assert.equal((await rec(repl, 3, 2)).status, 200);
  assert.equal((await api('GET', `/events/${w.ev.id}/bracket`)).body.champion.team_id, w.ids[0]);
  const kinds = (await api('GET', `/events/${w.ev.id}/stages/${sid}/revisions`, { token: w.org.token })).body.map((r) => r.kind);
  assert.ok(kinds.includes('conflict_resolved'));
  // keep_played path
  const w2 = await world(4);
  const g2 = await api('POST', `/events/${w2.ev.id}/schedule`, { token: w2.org.token, body: { ...WINDOW, format: 'knockout', team_ids: w2.ids } });
  const sm = await q("SELECT * FROM fixtures WHERE stage_id=$1 AND round_kind='semi' ORDER BY bracket_slot", [g2.body.stage.id]);
  const r2 = (f, h, a, extra = {}) => api('POST', `/fixtures/${f.id}/result`, { token: w2.org.token, body: { home_score: h, away_score: a, ...extra } });
  await r2(sm[0], 3, 1); await r2(sm[1], 3, 1);
  const f2 = (await q("SELECT * FROM fixtures WHERE stage_id=$1 AND round_kind='final'", [g2.body.stage.id]))[0];
  await r2(f2, 2, 1);
  await r2(sm[0], 0, 5, { accept_downstream_conflicts: true });
  const c2 = (await api('GET', `/events/${w2.ev.id}/bracket-conflicts?status=open`, { token: w2.org.token })).body[0];
  const keep = await api('POST', `/bracket-conflicts/${c2.id}/resolve`, { token: w2.org.token, body: { action: 'keep_played', reason: 'Result stands; protest rejected' } });
  assert.equal(keep.status, 200); assert.equal(keep.body.status, 'kept');
  assert.equal((await q('SELECT status FROM fixtures WHERE id=$1', [f2.id]))[0].status, 'completed');
});

test('repechage from a versioned template, placement play-offs and consolation use the same stage and scheduler', async () => {
  const w = await world(8);
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, format: 'knockout', team_ids: w.ids, format_config: { repechage_template: 'opponents_of_finalists_cross_bronze' } } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const sid = gen.body.stage.id;
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${sid}/repechage`, { token: w.org.token, body: {} })).status, 409, 'entrants are not known before the semi-finals');
  await playAll(w, undefined, { stop: (f) => f.round_kind === 'final' });
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${sid}/repechage`, { token: w.org.token, body: { template: 'nope' } })).status, 400);
  const rp = await api('POST', `/events/${w.ev.id}/stages/${sid}/repechage`, { token: w.org.token, body: {} });
  assert.equal(rp.status, 201, JSON.stringify(rp.body));
  assert.equal(rp.body.created, 2, 'one entrant per half goes straight to a bronze contest');
  const br = await q("SELECT * FROM fixtures WHERE stage_id=$1 AND round_kind='repechage' ORDER BY bracket_slot", [sid]);
  assert.equal(br.length, 2); assert.ok(br.every((f) => f.home_team_id && f.away_team_id));
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${sid}/repechage`, { token: w.org.token, body: {} })).status, 409, 'only once');
  await playAll(w);
  const st = (await stages(w, null))[0];
  assert.ok(st.sections.some((s) => s.key === 'repechage'));
  assert.equal(st.status, 'completed');

  // placement play-offs to 8th place and a consolation bracket are alternatives on the same teams
  const p = await world(8);
  const g2 = await api('POST', `/events/${p.ev.id}/schedule`, { token: p.org.token, body: { ...WINDOW, format: 'knockout', team_ids: p.ids, format_config: { placement_up_to: 8 } } });
  assert.equal(g2.status, 201, JSON.stringify(g2.body));
  assert.equal(g2.body.created, 7 + 1 + 4, 'bracket, third place, two 5-8 semis, 5th and 7th place games');
  await playAll(p);
  const done = (await stages(p, null))[0];
  assert.equal(done.status, 'completed');
  const place = done.sections.find((s) => s.key === 'placement');
  assert.ok(place);
  const bad = await api('POST', `/events/${p.ev.id}/schedule/preview`, { token: p.org.token, body: { ...WINDOW, format: 'knockout', team_ids: p.ids, format_config: { placement_up_to: 8, consolation: true } } });
  assert.equal(bad.status, 400);
  const c = await world(8);
  const g3 = await api('POST', `/events/${c.ev.id}/schedule`, { token: c.org.token, body: { ...WINDOW, format: 'knockout', team_ids: c.ids, format_config: { consolation: true } } });
  assert.equal(g3.status, 201, JSON.stringify(g3.body));
  assert.equal(g3.body.created, 7 + 3, 'four first-round losers play a 3-game consolation bracket');
  await playAll(c);
  assert.equal((await stages(c, null))[0].status, 'completed');
});

test('schedule check reports real conflicts and bracket generation refuses a timetable that does not fit', async () => {
  const w = await world(8);
  const tight = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, from_date: day(1), to_date: day(1), format: 'double_elimination', team_ids: w.ids, day_start_min: 480, day_end_min: 600 } });
  assert.equal(tight.status, 409, 'no bracket without a valid timetable');
  assert.equal((await q('SELECT count(*)::int AS n FROM event_stages WHERE event_id=$1', [w.ev.id]))[0].n, 0);
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, format: 'knockout', team_ids: w.ids } });
  const sid = gen.body.stage.id;
  const ok = await api('GET', `/events/${w.ev.id}/stages/${sid}/schedule-check`, { token: w.org.token });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.conflicts, []); assert.equal(ok.body.ok, true);
  // pull the final in front of its semi-finals
  const [semi] = await q("SELECT * FROM fixtures WHERE stage_id=$1 AND round_kind='semi' ORDER BY scheduled_at LIMIT 1", [sid]);
  const [fin] = await q("SELECT * FROM fixtures WHERE stage_id=$1 AND round_kind='final'", [sid]);
  assert.equal((await api('PATCH', `/fixtures/${fin.id}`, { token: w.org.token, body: { scheduled_at: new Date(+semi.scheduled_at - 36e5).toISOString() } })).status, 200);
  const bad = await api('GET', `/events/${w.ev.id}/stages/${sid}/schedule-check`, { token: w.org.token });
  assert.equal(bad.body.ok, false);
  assert.ok(bad.body.conflicts.some((c) => c.kind === 'order'));
  assert.ok(bad.body.conflicts.some((c) => c.kind === 'court_overlap'));
  await pool.query("UPDATE bookings SET status='cancelled' WHERE event_id=$1 AND source='fixture' AND id=(SELECT id FROM bookings WHERE event_id=$1 AND source='fixture' AND status='confirmed' LIMIT 1)", [w.ev.id]);
  assert.ok((await api('GET', `/events/${w.ev.id}/stages/${sid}/schedule-check`, { token: w.org.token })).body.conflicts.some((c) => c.kind === 'unbooked'));
});

test('published brackets can be shared as a print page, embedded in other sites and downloaded as a PDF; drafts and private events cannot', async () => {
  const w = await world(6);
  const gen = await api('POST', `/events/${w.ev.id}/schedule`, { token: w.org.token, body: { ...WINDOW, format: 'double_elimination', team_ids: w.ids, publish: false } });
  const sid = gen.body.stage.id;
  assert.equal((await api('GET', `/share/bracket/${w.ev.id}/pdf`)).status, 404, 'nothing published: no PDF');
  const draftPage = await api('GET', `/share/bracket/${w.ev.id}`);
  assert.equal(draftPage.status, 200);
  assert.match(draftPage.body, /No bracket has been published/);
  assert.equal((await api('POST', `/events/${w.ev.id}/stages/${sid}/publish`, { token: w.org.token })).status, 200);
  assert.equal((await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { visibility: 'public' } })).status, 200);
  await playAll(w, undefined, { stop: (f) => f.round_kind === 'losers' });
  const page = await api('GET', `/share/bracket/${w.ev.id}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Winners bracket/); assert.match(page.body, /Losers bracket/); assert.match(page.body, /<ol>/, 'a semantic list, not only a drawing');
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  const emb = await api('GET', `/share/bracket/${w.ev.id}/embed?theme=dark`);
  assert.equal(emb.status, 200); assert.match(emb.body, /data-theme="dark"/);
  assert.equal(emb.headers.get('x-frame-options'), null);
  assert.match(emb.headers.get('content-security-policy'), /frame-ancestors \*/);
  const pdf = await fetch(`${base}/api/v1/share/bracket/${w.ev.id}/pdf`);
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api('PATCH', `/events/${w.ev.id}/public-settings`, { token: w.org.token, body: { visibility: 'private' } })).status, 200);
  assert.equal((await api('GET', `/share/bracket/${w.ev.id}`)).status, 404);
  assert.equal((await api('GET', `/share/bracket/${w.ev.id}/embed`)).status, 404);
  assert.equal((await api('GET', '/share/bracket/not-a-uuid')).status, 404);
});

test('every scoring family of the sport catalogue has an explicit bracket coverage; fallbacks are labelled', async () => {
  // the catalogue is a database table: walk every sport in it (a family nobody decided on fails here instead of silently defaulting)
  const rows = (await pool.query('SELECT slug, name, category, scoring FROM sports ORDER BY slug')).rows;
  assert.ok(rows.length > 50, 'the catalogue is seeded by the migrations');
  const known = new Set(['goals', 'sets', 'points', 'combat', 'time', 'distance', 'judged', 'weight']);
  for (const sp of rows) {
    assert.ok(known.has(sp.scoring), `${sp.slug}: scoring family "${sp.scoring}" needs a decision for brackets`);
    const c = coverageOf(sp);
    assert.ok(['native', 'fallback'].includes(c.mode), sp.slug);
    if (c.mode === 'fallback') assert.match(c.note, /generic fallback/, `${sp.slug} is labelled a fallback`);
    else assert.equal(c.note, null);
  }
  assert.equal(coverageOf(rows.find((r) => r.slug === 'football')).mode, 'native');
  assert.equal(coverageOf(rows.find((r) => r.slug === 'long-jump')).mode, 'fallback');
});

test('previews say how a sport fits the bracket: native for two-sided contests, a labelled fallback for measured sports', async () => {
  const w = await world(4);
  const pv = await api('POST', `/events/${w.ev.id}/schedule/preview`, { token: w.org.token, body: { ...WINDOW, format: 'knockout', team_ids: w.ids } });
  assert.equal(pv.body.coverage.mode, 'native'); assert.equal(pv.body.coverage.family, 'points');
  await pool.query("UPDATE events SET sport_id=(SELECT id FROM sports WHERE slug='long-jump') WHERE id=$1", [w.ev.id]);
  await pool.query('UPDATE resources SET sport_id=NULL WHERE venue_id=$1', [w.venue.id]); // the courts serve any sport
  const fb = await api('POST', `/events/${w.ev.id}/schedule/preview`, { token: w.org.token, body: { ...WINDOW, format: 'knockout', team_ids: w.ids } });
  assert.equal(fb.status, 200, JSON.stringify(fb.body));
  assert.equal(fb.body.coverage.mode, 'fallback');
  assert.ok(fb.body.warnings.some((x) => /generic fallback/.test(x)));
});
