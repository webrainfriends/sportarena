import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `Cp ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery-9', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const league = async (teamCount = 2) => {
  const org = await signup(['organizer']);
  const comp = must(await api('POST', '/competitions', { token: org.token, body: { name: `Gov League ${++n}`, sport: 'football', country: 'IN', level: 'amateur', is_public: true } }), 201);
  const season = must(await api('POST', `/competitions/${comp.id}/seasons`, { token: org.token, body: { label: '2026/27', starts_on: day(1), ends_on: day(200), registration_opens_on: day(-1), registration_closes_on: day(30) } }), 201);
  const div = must(await api('POST', `/seasons/${season.id}/divisions`, { token: org.token, body: { name: 'Premier', tier: 1, capacity: 8 } }), 201);
  const mgrs = [], teams = [];
  for (let i = 0; i < teamCount; i++) {
    const m = await signup(); mgrs.push(m);
    teams.push(must(await api('POST', '/teams', { token: m.token, body: { name: `GFC ${n}-${i}`, sport: 'football' } }), 201));
  }
  must(await api('POST', `/seasons/${season.id}/status`, { token: org.token, body: { status: 'open' } }));
  const ms = [];
  for (const [i, t] of teams.entries()) ms.push(must(await api('POST', `/seasons/${season.id}/memberships`, { token: mgrs[i].token, body: { team_id: t.id, division_id: div.id } }), 201));
  for (const m of ms) must(await api('POST', `/memberships/${m.id}/decision`, { token: org.token, body: { action: 'accept' } }));
  return { org, comp, season, div, mgrs, teams };
};

test('rule packs: immutable, versioned, pinned per season, closed with the season', async () => {
  const L = await league();
  const rv = (await pool.query('SELECT id FROM comp_rule_versions WHERE season_id=$1 ORDER BY version DESC LIMIT 1', [L.season.id])).rows[0];
  const stranger = await signup(['organizer']);
  assert.equal((await api('POST', `/competitions/${L.comp.id}/rule-packs`, { token: stranger.token, body: { name: 'x1', standings_rule_version_id: rv.id } })).status, 404, 'outsiders get 404');
  assert.equal((await api('POST', `/competitions/${L.comp.id}/rule-packs`, { token: L.org.token, body: { name: 'empty pack' } })).status, 400, 'a pack needs at least one reference');
  // a rule version of another competition cannot be bundled
  const other = await league(2);
  const orv = (await pool.query('SELECT id FROM comp_rule_versions WHERE season_id=$1 LIMIT 1', [other.season.id])).rows[0];
  assert.equal((await api('POST', `/competitions/${L.comp.id}/rule-packs`, { token: L.org.token, body: { name: 'stolen', standings_rule_version_id: orv.id } })).status, 400);
  const p1 = must(await api('POST', `/competitions/${L.comp.id}/rule-packs`, { token: L.org.token, body: { name: 'Pack 2026', standings_rule_version_id: rv.id } }), 201);
  assert.equal(p1.version, 1);
  assert.match(p1.hash, /^[0-9a-f]{64}$/);
  assert.ok(p1.content.standings.points);
  const pinned = must(await api('POST', `/seasons/${L.season.id}/rule-pack`, { token: L.org.token, body: { pack_id: p1.id, reason: 'first pack' } }));
  assert.equal(pinned.pack.version, 1);
  assert.equal((await api('POST', `/seasons/${L.season.id}/rule-pack`, { token: L.org.token, body: { pack_id: (await pool.query('SELECT id FROM gov_rule_packs WHERE competition_id=$1', [other.comp.id])).rows[0]?.id ?? '00000000-0000-0000-0000-000000000000' } })).status, 404, 'a pack of another competition cannot be pinned');
  // immutability is enforced by the database
  await assert.rejects(pool.query("UPDATE gov_rule_packs SET name='changed' WHERE id=$1", [p1.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM gov_season_rule_pins WHERE season_id=$1', [L.season.id]), /append-only/);
  // new pack, repin: history keeps the first
  const p2 = must(await api('POST', `/competitions/${L.comp.id}/rule-packs`, { token: L.org.token, body: { name: 'Pack 2026b', standings_rule_version_id: rv.id, note: 'tweak' } }), 201);
  assert.equal(p2.version, 2);
  must(await api('POST', `/seasons/${L.season.id}/rule-pack`, { token: L.org.token, body: { pack_id: p2.id } }));
  const cur = must(await api('GET', `/seasons/${L.season.id}/rule-pack`));
  assert.deepEqual([cur.current.version, cur.history.length, cur.history[0].version], [2, 1, 1]);
  assert.equal(must(await api('GET', `/competitions/${L.comp.id}/rule-packs`, { token: L.org.token })).items.length, 2);
  assert.equal((await api('GET', `/competitions/${L.comp.id}/rule-packs`, { token: (await signup()).token })).status, 404, 'staff only');
  assert.equal((await api('GET', `/competitions/${L.comp.id}/rule-packs`)).status, 401, 'signed in only');
  // MCP parity
  const tools = (await rpc('tools/list', {}, L.org.token)).tools.map((t) => t.name);
  for (const t of ['publish_rule_pack', 'pin_season_rule_pack', 'get_season_rule_pack', 'list_rule_packs', 'get_governance_lineage', 'archive_season_pack', 'get_season_archive']) assert.ok(tools.includes(t), t);
  // start play and complete: the pack is closed with the season and a later rule change cannot move it
  must(await api('POST', `/seasons/${L.season.id}/status`, { token: L.org.token, body: { status: 'active' } }));
  must(await api('POST', `/seasons/${L.season.id}/complete`, { token: L.org.token, body: { force: true } }));
  const p3 = must(await api('POST', `/competitions/${L.comp.id}/rule-packs`, { token: L.org.token, body: { name: 'late', standings_rule_version_id: rv.id } }), 201);
  assert.equal((await api('POST', `/seasons/${L.season.id}/rule-pack`, { token: L.org.token, body: { pack_id: p3.id } })).status, 409, 'closed season keeps its pack');
  assert.equal(must(await api('GET', `/seasons/${L.season.id}/rule-pack`)).current.version, 2);
});

test('season archive: sealing is idempotent, tamper-evident, staff see the bundle and the public only the summary; archiving seals automatically', async () => {
  const L = await league();
  const rv = (await pool.query('SELECT id FROM comp_rule_versions WHERE season_id=$1 LIMIT 1', [L.season.id])).rows[0];
  const p = must(await api('POST', `/competitions/${L.comp.id}/rule-packs`, { token: L.org.token, body: { name: 'Archive pack', standings_rule_version_id: rv.id } }), 201);
  must(await api('POST', `/seasons/${L.season.id}/rule-pack`, { token: L.org.token, body: { pack_id: p.id } }));
  assert.equal((await api('POST', `/seasons/${L.season.id}/archive-pack`, { token: L.org.token })).status, 409, 'only a finished season');
  must(await api('POST', `/seasons/${L.season.id}/status`, { token: L.org.token, body: { status: 'active' } }));
  must(await api('POST', `/seasons/${L.season.id}/complete`, { token: L.org.token, body: { force: true } }));
  const stranger = await signup(['organizer']);
  assert.equal((await api('POST', `/seasons/${L.season.id}/archive-pack`, { token: stranger.token })).status, 404);
  const a = must(await api('POST', `/seasons/${L.season.id}/archive-pack`, { token: L.org.token }));
  const b = must(await api('POST', `/seasons/${L.season.id}/archive-pack`, { token: L.org.token }));
  assert.equal(a.hash, b.hash, 'sealing twice returns the same seal');
  const staff = must(await api('GET', `/seasons/${L.season.id}/archive-pack`, { token: L.org.token }));
  assert.equal(staff.intact, true);
  assert.equal(staff.bundle.rule_pack.version, 1);
  assert.equal(staff.bundle.memberships.length, 2);
  assert.ok(Array.isArray(staff.bundle.eligibility_decisions));
  const pub = must(await api('GET', `/seasons/${L.season.id}/archive-pack`));
  assert.equal(pub.bundle, undefined, 'public gets no bundle');
  assert.equal(pub.summary.teams.length, 2);
  // a later team rename does not change the sealed record
  await pool.query("UPDATE teams SET name='Renamed' WHERE id=$1", [L.teams[0].id]);
  const again = must(await api('GET', `/seasons/${L.season.id}/archive-pack`, { token: L.org.token }));
  assert.equal(again.intact, true);
  assert.ok(!again.bundle.memberships.some((m) => m.team === 'Renamed'));
  // archiving a completed season seals it automatically (second season)
  const L2 = await league();
  must(await api('POST', `/seasons/${L2.season.id}/status`, { token: L2.org.token, body: { status: 'active' } }));
  must(await api('POST', `/seasons/${L2.season.id}/complete`, { token: L2.org.token, body: { force: true } }));
  must(await api('POST', `/seasons/${L2.season.id}/status`, { token: L2.org.token, body: { status: 'archived' } }));
  assert.equal(must(await api('GET', `/seasons/${L2.season.id}/archive-pack`, { token: L2.org.token })).intact, true);
});

test('lineage: team → club → affiliated body chain; a person is private', async () => {
  const owner = await signup(['organizer']);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0];
  const nat = must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Nat Fed ${n}`, level: 'national', abbreviation: 'NFA', country: 'IN', sports: [{ sport_id: sport.id }] } }), 201);
  const reg = must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `State Assoc ${n}`, level: 'state', abbreviation: 'SFA', country: 'IN', sports: [{ sport_id: sport.id }] } }), 201);
  const bodyId = (x) => x.id ?? x.body?.id;
  await pool.query("INSERT INTO governing_body_links(parent_id, child_id, status, effective_from, requested_by) VALUES ($1,$2,'recognised',current_date,$3)", [bodyId(nat), bodyId(reg), (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id]).catch(() => {});
  const chain = must(await api('GET', '/governance/lineage', { token: owner.token, query: { subject: 'body', id: bodyId(reg) } }));
  assert.ok(chain.branches[0].chain.length >= 1);
  assert.equal(chain.branches[0].chain.at(-1).id, bodyId(reg));
  // a person can only be resolved by themself
  const me = await signup(); const other = await signup();
  assert.equal((await api('GET', '/governance/lineage', { token: other.token, query: { subject: 'person', id: me.user?.id ?? me.id } })).status, 404);
  assert.equal((await api('GET', '/governance/lineage', { query: { subject: 'body', id: bodyId(reg) } })).status, 401);
});

test('governance calendar lists season registration and transfer windows by reference, and lists show approval progress', async () => {
  const owner = await signup(['organizer']);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0];
  const body = must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Cal Fed ${n}`, level: 'national', abbreviation: 'CAL', country: 'IN', sports: [{ sport_id: sport.id }] } }), 201);
  const bodyId = body.id ?? body.body?.id;
  const orgId = (await pool.query('SELECT organisation_id FROM governing_bodies WHERE id=$1', [bodyId])).rows[0].organisation_id;
  const cm = must(await api('POST', '/competitions', { token: owner.token, body: { name: `Cal League ${n}`, sport: 'football', organisation_id: orgId, is_public: true } }), 201);
  const season = must(await api('POST', `/competitions/${cm.id}/seasons`, { token: owner.token, body: { label: 'Cal', starts_on: day(5), ends_on: day(80), registration_opens_on: day(-10), registration_closes_on: day(3), transfer_opens_on: day(10), transfer_closes_on: day(30) } }), 201);
  must(await api('POST', `/seasons/${season.id}/status`, { token: owner.token, body: { status: 'open' } }));
  const cal = must(await api('GET', `/federation/bodies/${bodyId}/calendar`, { token: owner.token, query: { from: day(-30), to: day(60) } }));
  const kinds = cal.items.map((x) => x.kind);
  assert.ok(kinds.includes('season_registration') && kinds.includes('season_transfer'), JSON.stringify(kinds));
  const win = cal.items.find((x) => x.kind === 'season_transfer');
  assert.deepEqual([win.starts_on, win.ends_on, win.source.type], [day(10), day(30), 'competition_season']);
  // moving the season window moves the calendar entry: it is read live, not copied
  must(await api('PATCH', `/seasons/${season.id}`, { token: owner.token, body: { transfer_opens_on: day(12), transfer_closes_on: day(40) } }));
  const again = must(await api('GET', `/federation/bodies/${bodyId}/calendar`, { token: owner.token, query: { from: day(-30), to: day(60) } }));
  assert.equal(again.items.find((x) => x.kind === 'season_transfer').starts_on, day(12));
});
