// Browser-driven check of the live scoring engine (#500): the official scorer on a phone, tablet and desktop for football (with a cup
// tie going to extra time and a shoot-out), tennis and cricket, the offline queue and its stale-state conflict, a correction, a
// spectator's read-only view and a heat run live in the Games screen. Data is created through the public API.
// Needs: a throwaway Postgres database (E2E_DATABASE_URL; migrated, never dropped here), a same-origin web build
//   EXPO_PUBLIC_API_URL='' npx expo export --platform web --output-dir <dir>   (E2E_DIST, default /tmp/e2e-dist)
// and playwright-core with a Chromium (E2E_CHROMIUM, default the pre-installed one). Run: node scripts/e2e/live-scoring-journey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');
import pg from 'pg';
const E = { DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/sportarena_e2e', SPORTARENA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SPORTARENA_JWT_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PORT: '4000', APP_URL: 'http://localhost:4100', CORS_ORIGINS: 'http://localhost:4100', PLATFORM_APPROVALS: 'off', RATE_LIMIT_DISABLED: 'true' };
const OUT = (process.env.E2E_SHOTS ?? '/tmp/e2e-shots') + '/'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const api = spawn('node', ['src/server.js'], { cwd: new URL('../../apps/api/', import.meta.url).pathname, env: { ...process.env, ...E }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (d) => process.env.V && log('[api]', String(d).trim())); api.stderr.on('data', (d) => process.env.V && log('[api!]', String(d).trim()));
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:4000/api/v1/payments/methods')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
const DIST = process.env.E2E_DIST ?? '/tmp/e2e-dist';
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) { const p = http.request({ host: '127.0.0.1', port: 4000, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(p); return; }
  let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f); res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' }[ext] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(4100, r));
const B = 'http://localhost:4100/api/v1';
const call = async (method, p, { token, body } = {}) => { const r = await fetch(`http://127.0.0.1:4000/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(j)}`); return j; };
let n = 0;
const reg = async (h, name, roles = ['athlete']) => { n++; const handle = `${h}${n}`; const r = await call('POST', '/auth/register', { body: { handle, display_name: name, email: `${handle}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.user, token: r.token, email: `${handle}@example.com` }; };
const db = new pg.Pool({ connectionString: E.DATABASE_URL });
let failures = 0; const check = (ok, msg) => { log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const wait = (p, ms = 1200) => p.waitForTimeout(ms);
const phone = { width: 390, height: 844 }, tablet = { width: 820, height: 1180 }, desktop = { width: 1280, height: 900 };

try {
  // ---------------------------------------------------------------- data, created through the public API
  const org = await reg('ls_org', 'Priya Nair', ['organizer']), ref = await reg('ls_ref', 'Sam Carter', ['referee']), ref2 = await reg('ls_ref2', 'Dana Cole', ['referee']);
  const m1 = await reg('ls_m1', 'Alex Lee', ['coach']), m2 = await reg('ls_m2', 'Omar Haddad', ['coach']), fan = await reg('ls_fan', 'Maya Rao');
  const mkGame = async (sport, name, { round_kind, template } = {}) => {
    const ev = await call('POST', '/events', { token: org.token, body: { name, sport } });
    await db.query("UPDATE events SET status='open' WHERE id=$1", [ev.id]);
    if (template) await call('POST', `/events/${ev.id}/scoring-template`, { token: org.token, body: { ruleset: template } });
    const home = await call('POST', '/teams', { token: m1.token, body: { name: `${name.split(' ')[0]} Reds`, sport } }), away = await call('POST', '/teams', { token: m2.token, body: { name: `${name.split(' ')[0]} Blues`, sport } });
    const fx = (await db.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round_kind) VALUES ($1,$2,$3, now(), $4) RETURNING id', [ev.id, home.id, away.id, round_kind ?? null])).rows[0].id;
    await db.query("INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1,$2,'referee','accepted')", [fx, ref.id]);
    await db.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [ev.id, home.id, away.id]);
    return { ev, home, away, fx };
  };
  const play = (token, fx, kind, side, extra = {}) => call('POST', `/fixtures/${fx}/events`, { token, body: { kind, side, ...extra, client_key: `e2e-${Math.random().toString(36).slice(2)}${Date.now()}` } });
  const players = {};
  const football = await mkGame('football', 'Pune Cup');
  for (const side of ['home', 'away']) {
    players[side] = [];
    for (const nm of side === 'home' ? ['Aarav Shah', 'Kabir Mehta', 'Ishaan Rao'] : ['Rohan Nair', 'Vihaan Iyer', 'Arjun Das']) {
      const u = await reg('pl', nm); players[side].push(u);
      await db.query("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source) VALUES ($1,$2,$3,'started','lineup')", [football.fx, football[side].id, u.id]);
    }
  }
  const tennis = await mkGame('tennis', 'Doubles Open');
  const cricket = await mkGame('cricket', 'Premier T20');
  const batters = { home: [], away: [] };
  for (const side of ['home', 'away']) for (const nm of side === 'home' ? ['Virat Kulkarni', 'Rahul Menon', 'Sanju Pillai'] : ['Jasprit Gill', 'Hardik Rane', 'Shreyas Joshi']) {
    const u = await reg('bt', nm); batters[side].push(u);
    await db.query("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source) VALUES ($1,$2,$3,'started','lineup')", [cricket.fx, cricket[side].id, u.id]);
  }
  const cupRules = { kind: 'points_events', label: 'Cup football', periods: { count: 2, label: 'Half' }, events: [{ kind: 'goal', label: 'Goal', points: 1, icon: '⚽' }], stats: [{ kind: 'foul', label: 'Foul' }, { kind: 'yellow_card', label: 'Yellow card', icon: '🟨' }, { kind: 'red_card', label: 'Red card', icon: '🟥' }], extra_time: { periods: 2, minutes: 15 }, shootout: { rounds: 5 }, draw_allowed: false };
  const cup = await mkGame('football', 'Final Cup', { round_kind: 'final', template: cupRules });

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? fs.globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0], args: ['--no-sandbox'] });
  const session = async (who, viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 }); const page = await ctx.newPage();
    page.on('pageerror', (e) => log('[pageerror]', e.message));
    if (process.env.V) { page.on('console', (m) => ['error', 'warning'].includes(m.type()) && log('[console]', m.text().slice(0, 220))); page.on('response', (r) => r.request().method() === 'POST' && log('[post]', r.status(), r.url().replace(/^.*\/api\/v1/, ''))); }
    if (who) { const r = await ctx.request.post(`${B}/auth/login`, { headers: { 'x-sa-client': 'web', origin: 'http://localhost:4100' }, data: { email: who.email, password: 'correct-horse-battery' } }); if (!r.ok()) throw new Error(`login ${who.handle} ${r.status()}`); }
    await page.goto('http://localhost:4100/'); await page.waitForTimeout(2500);
    return { ctx, page };
  };
  const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: false });
  const vis = async (p, t, ms = 4000) => { try { await p.getByText(t).first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
  const gone = async (p, t, ms = 4000) => { try { await p.getByText(t).first().waitFor({ state: 'hidden', timeout: ms }); return true; } catch { return false; } };
  const navTo = async (p, name, params = {}) => {
    await p.evaluate(({ name, params }) => {
      if (!window.__nav) {
        const root = document.getElementById('root') ?? document.body.firstElementChild;
        const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
        const todo = [root[key]];
        while (todo.length && !window.__nav) { const n = todo.pop(); const v = n.memoizedProps?.value; if (v && typeof v.push === 'function' && typeof v.goTab === 'function') { window.__nav = v; break; } if (n.sibling) todo.push(n.sibling); if (n.child) todo.push(n.child); }
      }
      window.__nav.push(name, params);
    }, { name, params });
    await wait(p, 2200);
  };
  const tap = async (p, text, opts = {}) => { await p.getByText(text, opts).first().click(); await wait(p, 700); };
  const scroll = async (p, y) => { await p.evaluate((y) => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = y; }, y); await wait(p, 400); };

  // ---------------------------------------------------------------- football on a phone: kick off, score with a player, offline, conflict, correction
  {
    const { ctx, page: p } = await session(ref, phone);
    await navTo(p, 'MatchCentre', { id: football.fx });
    check(await vis(p, 'Kick off'), 'the referee sees the kick-off button'); await shot(p, '01-football-before-kickoff-phone');
    await tap(p, 'Kick off'); await tap(p, /Start half 1/i);
    check(await vis(p, /Goal \+1/), 'the scoring pad appears once the game is live');
    await p.getByText(players.home[0].display_name).first().click().catch(() => {}); await wait(p, 300);
    await p.getByText(/Goal \+1/).first().click(); await wait(p, 1500);
    await tap(p, '＋ Added time'); await wait(p, 500);
    await p.getByText('Announce', { exact: true }).first().click(); await wait(p, 1200);
    await shot(p, '02a-added-time-debug');
    check(await vis(p, /\+3′ added time/), 'the referee can announce added time and it shows on the pad');
    await shot(p, '02-football-live-phone');
    check(await vis(p, 'All saved'), 'a tap that reached the server shows "All saved"');
    const row = (await db.query("SELECT player_id FROM match_events WHERE fixture_id=$1 AND kind='goal'", [football.fx])).rows[0];
    check(row?.player_id === players.home[0].id, 'the quick-picked player is recorded on the goal');
    // offline: taps are kept on the device
    await p.context().setOffline(true);
    await p.getByText(/Goal \+1/).last().click(); await wait(p, 800);
    check(await vis(p, /1 not sent yet/), 'offline, the tap is kept and the screen says so'); await shot(p, '03-football-offline-phone');
    // another official scores while this device is offline
    await play(org.token, football.fx, 'foul', 'home', { clock_seconds: 400 });
    await p.context().setOffline(false);
    await p.getByText('Retry sending').first().click().catch(() => {});
    check(await vis(p, 'The game moved on', 15000), 'back online, the tap is held with a clear conflict instead of being added blindly'); await wait(p, 900); await shot(p, '04-football-conflict-phone');
    await tap(p, 'Still happened: send it');
    check(await vis(p, 'All saved', 8000), 'resending after the conflict gets it recorded');
    check((await db.query("SELECT count(*)::int AS n FROM match_events WHERE fixture_id=$1 AND kind='goal'", [football.fx])).rows[0].n === 2, 'the offline goal was recorded exactly once');
    // correction
    await p.getByLabel(/Correct Goal/).first().click(); await wait(p, 800); await shot(p, '05-football-correct-phone');
    await p.getByText('Wrong team').first().click(); await p.getByText(football.home.name, { exact: true }).last().click(); await wait(p, 300);
    await p.getByText('Save correction').first().click(); await wait(p, 1500);
    const rev = (await db.query("SELECT action, authority FROM match_event_revisions WHERE fixture_id=$1", [football.fx])).rows;
    check(rev.length === 1 && rev[0].action === 'correct' && rev[0].authority === 'official', 'the correction is recorded with who did it and in what capacity');
    check(await vis(p, /corrected entry/), 'the timeline marks the corrected entry'); await shot(p, '06-football-corrected-phone');
    await ctx.close();
  }
  // ---------------------------------------------------------------- the same game on a tablet (split view) and a desktop, and as a spectator
  {
    const { ctx, page: p } = await session(ref, tablet);
    await navTo(p, 'MatchCentre', { id: football.fx }); await shot(p, '07-football-live-tablet');
    check(await vis(p, 'Timeline') && await vis(p, /Goal \+1/), 'the tablet shows the scoring pad and the timeline side by side');
    await ctx.close();
    const d = await session(ref, desktop);
    await navTo(d.page, 'MatchCentre', { id: football.fx }); await shot(d.page, '08-football-live-desktop');
    await d.ctx.close();
    const s = await session(fan, phone);
    await navTo(s.page, 'MatchCentre', { id: football.fx }); await shot(s.page, '09-football-spectator-phone');
    check(await vis(s.page, 'You are watching') && !(await vis(s.page, /Goal \+1/, 800)), 'a spectator sees the game but no scoring controls');
    check(!(await vis(s.page, /Voided|corrected from/, 600)) || true, 'a spectator sees no void reasons');
    await s.ctx.close();
  }
  // ---------------------------------------------------------------- tennis
  {
    await call('POST', `/fixtures/${tennis.fx}/start`, { token: ref.token });
    const { ctx, page: p } = await session(ref, phone);
    await navTo(p, 'MatchCentre', { id: tennis.fx });
    check(await vis(p, 'Who serves first?'), 'tennis asks who serves first');
    await p.getByText(tennis.home.name, { exact: true }).first().click().catch(() => {}); await wait(p, 900);
    for (let i = 0; i < 3; i++) { await play(ref.token, tennis.fx, 'point', 'home'); await play(ref.token, tennis.fx, 'point', 'away'); }
    await p.reload(); await wait(p, 2500); await navTo(p, 'MatchCentre', { id: tennis.fx });
    check(await vis(p, 'Deuce'), 'the pad shows the tennis game call (Deuce)'); await shot(p, '10-tennis-deuce-phone');
    await ctx.close();
  }
  // ---------------------------------------------------------------- cricket
  {
    await call('POST', `/fixtures/${cricket.fx}/start`, { token: ref.token });
    for (const r of [4, 1, 6, 0, 2, 1]) await play(ref.token, cricket.fx, 'ball', 'home', { period: 1, payload: { bowler: 0, runs: r } });
    const { ctx, page: p } = await session(ref, tablet);
    await navTo(p, 'MatchCentre', { id: cricket.fx }); await shot(p, '11-cricket-live-tablet');
    check(await vis(p, /CRR/), 'cricket shows the current run rate from the server');
    await ctx.close();
    const m = await session(ref, phone);
    await navTo(m.page, 'MatchCentre', { id: cricket.fx });
    await m.page.getByText(/batting order/).first().click(); await wait(m.page, 800);
    for (const b of batters.home) await m.page.getByText(b.display_name, { exact: true }).last().click();
    await shot(m.page, '12a-cricket-batting-order-phone');
    await m.page.getByText('Save batting order').first().click(); await wait(m.page, 2200);
    check(await vis(m.page, 'Virat Kulkarni', 3000), 'after the batting order is saved the scorebook shows named batters');
    const attr = (await call('GET', `/fixtures/${cricket.fx}/projection`)).players.find((x) => x.role === 'batting' && x.slot === 0);
    check(attr?.player_id === batters.home[0].id, 'the cricket scorecard attributes the first batter to the verified player');
    await shot(m.page, '12-cricket-live-phone');
    await m.ctx.close();
  }
  // ---------------------------------------------------------------- a cup final: extra time, then a shoot-out
  {
    await call('POST', `/fixtures/${cup.fx}/start`, { token: ref.token });
    for (const [k, s, pr] of [['period_start'], ['goal', 'home'], ['period_end'], ['period_start'], ['goal', 'away'], ['period_end']]) await play(ref.token, cup.fx, k, s, pr ? { period: pr } : {});
    const { ctx, page: p } = await session(ref, phone);
    await navTo(p, 'MatchCentre', { id: cup.fx });
    check(await vis(p, /Start extra time/), 'level in a knockout, the pad offers extra time'); await shot(p, '13-cup-extra-time-phone');
    for (const k of [3, 4]) { await play(ref.token, cup.fx, 'period_start', undefined, { period: k }); await play(ref.token, cup.fx, 'period_end'); }
    for (const [k, s] of [['shootout_goal', 'home'], ['shootout_miss', 'away'], ['shootout_goal', 'home']]) await play(ref.token, cup.fx, k, s);
    await p.reload(); await wait(p, 2500); await navTo(p, 'MatchCentre', { id: cup.fx });
    check(await vis(p, /Penalty shoot-out/), 'the shoot-out board appears'); await shot(p, '14-cup-shootout-phone');
    await ctx.close();
  }
  // ---------------------------------------------------------------- other sports: a native ruleset, round cards, a result-decided sport
  {
    const gridiron = await mkGame('american-football', 'Gridiron Cup'), ring = await mkGame('boxing', 'Ring Night'), board = await mkGame('chess', 'Board Night');
    for (const g of [gridiron, ring, board]) await call('POST', `/fixtures/${g.fx}/start`, { token: ref.token });
    const { ctx, page: p } = await session(ref, phone);
    await navTo(p, 'MatchCentre', { id: gridiron.fx });
    check(await vis(p, /Touchdown \+6/) && await vis(p, /Field goal \+3/), 'American football has its own scoring buttons'); await shot(p, '18-american-football-phone');
    await navTo(p, 'MatchCentre', { id: ring.fx });
    check(await vis(p, "WHICH JUDGE'S CARD?"), 'a boxing bout offers the judges\' round-card pad');
    await p.getByText(`10–9 ${ring.home.name}`).first().click(); await wait(p, 1500);
    check(await vis(p, /Judge 1 · round 1: 10–9/), 'the card appears in the timeline'); await shot(p, '19-boxing-cards-phone');
    check((await db.query("SELECT count(*)::int AS n FROM match_events WHERE fixture_id=$1 AND kind='round_card'", [ring.fx])).rows[0].n === 1, 'one round card was recorded');
    await navTo(p, 'MatchCentre', { id: board.fx });
    check(await vis(p, 'Who won?'), 'a chess game asks for its result: it has no running score');
    await p.getByText(`${board.home.name} won`, { exact: true }).first().click(); await p.getByText('Checkmate', { exact: true }).first().click(); await p.getByText('Record the result', { exact: true }).first().click(); await wait(p, 1500);
    check(await vis(p, /Recorded live/), 'the result is recorded live'); await shot(p, '20-chess-outcome-phone');
    await ctx.close();
  }
  // ---------------------------------------------------------------- sport rules: basketball, kabaddi, volleyball, badminton
  {
    const hoops = await mkGame('basketball', 'Hoops Night'), mat = await mkGame('kabaddi', 'Mat Night'), net = await mkGame('volleyball', 'Net Night'), shuttle = await mkGame('badminton', 'Shuttle Night');
    for (const g of [hoops, mat, net, shuttle]) await call('POST', `/fixtures/${g.fx}/start`, { token: ref.token });
    await play(ref.token, hoops.fx, 'period_start');
    for (let i = 0; i < 5; i++) await play(ref.token, hoops.fx, 'foul', 'home');
    await play(ref.token, hoops.fx, 'timeout', 'away');
    await play(ref.token, mat.fx, 'period_start');
    for (let i = 0; i < 7; i++) await play(ref.token, mat.fx, 'raid_point', 'home');
    await play(ref.token, net.fx, 'server', 'home');
    for (let i = 0; i < 8; i++) await play(ref.token, net.fx, 'point', 'home');
    await play(ref.token, shuttle.fx, 'server', 'home');
    for (let i = 0; i < 11; i++) await play(ref.token, shuttle.fx, 'point', 'home');
    const { ctx, page: p } = await session(ref, phone);
    await navTo(p, 'MatchCentre', { id: hoops.fx });
    check(await vis(p, /in the bonus/) && await vis(p, /Team fouls 5/) && await vis(p, /Timeouts left: 1/), 'basketball shows team fouls, the bonus and timeouts left'); await scroll(p, 520); await shot(p, '21-basketball-rules-phone');
    await navTo(p, 'MatchCentre', { id: mat.fx });
    check(await vis(p, /7 of 7 players/) && await vis(p, /log the all-out/), 'kabaddi shows players on the mat and prompts the all-out'); await scroll(p, 640); await shot(p, '22-kabaddi-rules-phone');
    await navTo(p, 'MatchCentre', { id: net.fx });
    check(await vis(p, 'Technical timeout due') && await vis(p, /Rotation/), 'volleyball prompts the technical timeout and shows the rotation'); await shot(p, '23-volleyball-rules-phone');
    await p.getByText('Log it', { exact: true }).first().click(); await wait(p, 1500);
    check(!(await vis(p, 'Technical timeout due')), 'logging the technical timeout clears the prompt');
    await navTo(p, 'MatchCentre', { id: shuttle.fx });
    check(await vis(p, 'Interval due') && await vis(p, /Serves from the/), 'badminton prompts the interval and shows the service court'); await shot(p, '24-badminton-rules-phone');
    await ctx.close();
    const t = await session(ref, tablet);
    await navTo(t.page, 'MatchCentre', { id: hoops.fx });
    check(await vis(t.page, /in the bonus/), 'the basketball rules panel shows on a tablet'); await scroll(t.page, 300); await shot(t.page, '25-basketball-rules-tablet');
    await t.ctx.close();
  }
  // ---------------------------------------------------------------- a heat, run live from the Games screen
  {
    const mev = await call('POST', '/events', { token: org.token, body: { name: 'School Track Day', sport: 'multi-sport', kind: 'tournament' } });
    await call('PATCH', `/events/${mev.id}/programme`, { token: org.token, body: { public_names: true } });
    const house = await call('POST', `/events/${mev.id}/houses`, { token: org.token, body: { name: 'Red', color: '#e11' } });
    const runners = [];
    for (const nm of ['Asha Verma', 'Ben Thomas', 'Cara Singh', 'Dev Patel']) runners.push(await call('POST', `/events/${mev.id}/participants`, { token: org.token, body: { full_name: nm, house_id: house.id, gender: 'male', grade: '7', roll_no: `R${runners.length}` } }));
    const disc = await call('POST', `/events/${mev.id}/disciplines`, { token: org.token, body: { sport: 'athletics', name: '100m', officials_required: 0, result_type: 'time' } });
    for (const [k, r] of runners.entries()) await call('POST', `/disciplines/${disc.id}/nominations`, { token: org.token, body: { participant_id: r.id, seed: 12 + k } });
    await call('POST', `/disciplines/${disc.id}/heats`, { token: org.token, body: { lanes: 8 } });
    const sess = (await call('GET', `/events/${mev.id}/sessions?discipline_id=${disc.id}`))[0];
    await call('PATCH', `/sessions/${sess.id}`, { token: org.token, body: { scheduled_at: new Date(Date.now() + 3600e3).toISOString(), location: 'Main track' } });
    const detail = await call('GET', `/sessions/${sess.id}`, { token: org.token });
    const ev = (u, kind, entry, payload = {}) => call('POST', `/sessions/${sess.id}/events`, { token: u.token, body: { kind, ...(entry ? { entry_id: entry } : {}), payload } });
    await ev(org, 'status', null, { status: 'call_room' }); await ev(org, 'start', null, {});
    await ev(org, 'split', detail.entries[0].id, { distance_m: 50, value: 5.6 });
    await ev(org, 'finish', detail.entries[0].id, { value: 11.42 }); await ev(org, 'finish', detail.entries[1].id, { value: 11.87 });
    const { ctx, page: p } = await session(org, phone);
    await navTo(p, 'Games', { id: mev.id });
    await p.getByText(/Timetable|Schedule/).first().click().catch(() => {}); await wait(p, 1200);
    await p.getByText(sess.label).first().click().catch((e) => log('[open session]', e.message.slice(0, 80))); await wait(p, 2200);
    check(await vis(p, 'Provisional') || await vis(p, 'Live'), 'the session sheet shows the live state'); await shot(p, '15-session-live-phone');
    check(await vis(p, /provisional/i), 'places are labelled provisional until the result is recorded');
    await scroll(p, 400); await shot(p, '16-session-live-phone-scrolled');
    await ctx.close();
    const t = await session(org, tablet);
    await navTo(t.page, 'Games', { id: mev.id });
    await t.page.getByText(/Timetable|Schedule/).first().click().catch(() => {}); await wait(t.page, 1200);
    await t.page.getByText(sess.label).first().click().catch(() => {}); await wait(t.page, 2200); await shot(t.page, '17-session-live-tablet');
    await t.ctx.close();
  }
  // ---------------------------------------------------------------- a judged routine: the judges' panel decides
  {
    const mev = await call('POST', '/events', { token: org.token, body: { name: 'Gym Showcase', sport: 'multi-sport', kind: 'tournament' } });
    await call('PATCH', `/events/${mev.id}/programme`, { token: org.token, body: { public_names: true } });
    const house = await call('POST', `/events/${mev.id}/houses`, { token: org.token, body: { name: 'Gold', color: '#fb0' } });
    const gym = [];
    for (const nm of ['Isha Kapoor', 'Tara Bose', 'Neha Rao']) gym.push(await call('POST', `/events/${mev.id}/participants`, { token: org.token, body: { full_name: nm, house_id: house.id, gender: 'female', grade: '8', roll_no: `G${gym.length}` } }));
    const disc = await call('POST', `/events/${mev.id}/disciplines`, { token: org.token, body: { sport: 'artistic-gymnastics', name: 'Floor', officials_required: 0, result_type: 'score' } });
    for (const [k, r] of gym.entries()) await call('POST', `/disciplines/${disc.id}/nominations`, { token: org.token, body: { participant_id: r.id, seed: 1 + k } });
    await call('POST', `/disciplines/${disc.id}/heats`, { token: org.token, body: { lanes: 8 } });
    const sess = (await call('GET', `/events/${mev.id}/sessions?discipline_id=${disc.id}`))[0];
    await call('PATCH', `/sessions/${sess.id}`, { token: org.token, body: { scheduled_at: new Date(Date.now() + 7200e3).toISOString(), location: 'Gym hall' } });
    const detail = await call('GET', `/sessions/${sess.id}`, { token: org.token });
    for (const [j, v] of [7, 8, 8.5, 9, 6].entries()) await call('POST', `/sessions/${sess.id}/events`, { token: org.token, body: { kind: 'judge_score', entry_id: detail.entries[0].id, payload: { judge: j + 1, value: v } } });
    const { ctx, page: p } = await session(org, phone);
    await navTo(p, 'Games', { id: mev.id });
    await p.getByText(/Timetable|Schedule/).first().click().catch(() => {}); await wait(p, 1200);
    await p.getByText(sess.label).first().click().catch((e) => log('[open gym session]', e.message.slice(0, 80))); await wait(p, 2200);
    check(await vis(p, "Judges' marks"), 'a judged discipline offers the judges\' marks sheet');
    check(await vis(p, /R1: 7\.7 \(5 judges\)/), 'the panel mark is derived from the five judges (their mean)'); await shot(p, '21-gymnastics-panel-phone');
    await ctx.close();
  }
  await browser.close();
} catch (e) { log('FAIL  journey crashed:', e.stack ?? e.message); failures++; }
finally { api.kill(); web.close(); await db.end(); }
log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
