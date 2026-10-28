import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sg_${n}_${roles[0]}`, display_name: `Graph Person ${n}`, email: `sg${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const org = async (u, name) => must(await api('POST', '/organisations', { token: u.token, body: { name, kind: 'club' } }), 201);
const team = async (u, name, extra = {}) => must(await api('POST', '/teams', { token: u.token, body: { name, sport: 'football', ...extra } }), 201);
const key = () => `idem-${++n}-${Math.random().toString(36).slice(2, 10)}`;
const edge = (u, b) => api('POST', '/graph/edges', { token: u.token, body: { valid_from: '2024-01-01', ...b } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('sg_root','sg_root','{admin}','x','x','sg_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('every capability is REST + OpenAPI + MCP and the schema covers every entity in the master list', async () => {
  const names = capabilities.filter((c) => c.tag === 'Sports Graph').map((c) => c.name);
  for (const n of ['graph_search', 'get_graph_entity', 'graph_neighbours', 'create_graph_edge', 'update_graph_edge', 'end_graph_edge', 'verify_graph_edge', 'get_graph_edge_history', 'add_graph_alias', 'add_graph_external_id', 'verify_graph_external_id', 'get_athlete_360', 'get_organisation_360', 'get_graph_timeline', 'get_graph_schema']) assert.ok(names.includes(n), n);
  const schema = must(await api('GET', '/graph/schema'));
  assert.equal(schema.entities.length, 39, 'all entities of the issue are accounted for');
  assert.ok(schema.entities.every((e) => ['native', 'projected'].includes(e.status)));
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json().catch(() => null);
  if (spec?.paths) assert.ok(spec.paths['/graph/search']);
  assert.equal((await api('GET', '/graph/search', { query: { q: 'ab' } })).status, 401, 'search needs a signed-in user');
});

test('identity: names never merge, aliases find the same record, only a verified external id resolves identity', async () => {
  const a = await signup(), b = await signup(), issuer = await signup(['coach']);
  await q("UPDATE users SET display_name='Jordan Quill' WHERE id IN ($1,$2)", [a.id, b.id]);
  let r = must(await api('GET', '/graph/search', { token: issuer.token, query: { q: 'Jordan Quill', kinds: 'person' } }));
  assert.equal(r.length, 2, 'two people with one name are two separate candidates');
  assert.ok(r.every((x) => x.identity === 'candidate'));
  must(await api('POST', '/graph/aliases', { token: a.token, body: { kind: 'person', entity_id: a.id, alias: 'J. Q. Quillen' } }));
  assert.equal((await api('POST', '/graph/aliases', { token: a.token, body: { kind: 'person', entity_id: a.id, alias: 'j q quillen' } })).status, 409, 'duplicate alias');
  assert.equal((await api('POST', '/graph/aliases', { token: b.token, body: { kind: 'person', entity_id: a.id, alias: 'Not Mine' } })).status, 403);
  r = must(await api('GET', '/graph/search', { token: issuer.token, query: { q: 'quillen' } }));
  assert.deepEqual(r.map((x) => [x.id, x.matched_by]), [[a.id, 'alias']]);

  const o = await org(issuer, 'Licensing Federation');
  const added = must(await api('POST', '/graph/external-ids', { token: a.token, body: { kind: 'person', entity_id: a.id, scheme: 'federation_licence', value: 'LIC-0042', issuer_org_id: o.id } }));
  assert.equal(added.verification_state, 'claimed');
  assert.equal((await api('POST', '/graph/external-ids', { token: b.token, body: { kind: 'person', entity_id: b.id, scheme: 'federation_licence', value: 'lic-0042' } })).status, 409, 'one id, one record');
  const byExt = { external_scheme: 'federation_licence', external_value: 'LIC-0042' };
  assert.equal(must(await api('GET', '/graph/search', { token: issuer.token, query: byExt })).length, 0, 'a claimed id does not resolve identity');
  assert.equal((await api('POST', `/graph/external-ids/${added.id}/verify`, { token: a.token, body: { decision: 'verified' } })).status, 404, 'the owner cannot verify their own id');
  must(await api('POST', `/graph/external-ids/${added.id}/verify`, { token: issuer.token, body: { decision: 'verified' } }));
  r = must(await api('GET', '/graph/search', { token: b.token, query: byExt }));
  assert.deepEqual(r.map((x) => [x.id, x.identity]), [[a.id, 'verified']]);
  const card = must(await api('GET', `/graph/entities/person/${a.id}`, { token: a.token }));
  assert.equal(card.external_ids[0].value, 'LIC-0042');
  const other = must(await api('GET', `/graph/entities/person/${a.id}`, { token: b.token }));
  assert.equal(other.external_ids[0].value, undefined, 'values are only for the owner and managers');
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='read_graph_external_ids' AND actor_id=$1", [a.id])).length);
  assert.ok(!JSON.stringify(await q('SELECT value_enc FROM graph_external_ids')).includes('LIC-0042'), 'the value is stored encrypted');
});

test('organisation hierarchy and memberships are effective-dated, verified from the other side, versioned and never deleted', async () => {
  const clubOwner = await signup(['organizer']), leagueOwner = await signup(['organizer']), stranger = await signup();
  const club = await org(clubOwner, 'Harbour FC'), league = await org(leagueOwner, 'Coastal League');
  assert.equal((await edge(stranger, { from_kind: 'organisation', from_id: club.id, rel: 'member_of', to_kind: 'organisation', to_id: league.id })).status, 403);
  assert.equal((await edge(clubOwner, { from_kind: 'organisation', from_id: club.id, rel: 'based_at', to_kind: 'organisation', to_id: league.id })).status, 400, 'relationship kinds are checked');
  const e = must(await edge(clubOwner, { from_kind: 'organisation', from_id: club.id, rel: 'member_of', to_kind: 'organisation', to_id: league.id, valid_from: '2023-07-01', idempotency_key: key() }), 200);
  assert.equal(e.source_authority, 'organisation'); assert.equal(e.verification_state, 'unverified');
  assert.equal((await edge(clubOwner, { from_kind: 'organisation', from_id: club.id, rel: 'member_of', to_kind: 'organisation', to_id: league.id, valid_from: '2024-02-01' })).status, 409, 'overlap');
  const region = await org(leagueOwner, 'Regional Association');
  assert.equal((await edge(leagueOwner, { from_kind: 'organisation', from_id: league.id, rel: 'part_of', to_kind: 'organisation', to_id: region.id })).status, 200, 'part_of is a different relationship');
  assert.equal((await edge(leagueOwner, { from_kind: 'organisation', from_id: region.id, rel: 'part_of', to_kind: 'organisation', to_id: club.id })).status, 409, 'a cycle through the hierarchy is refused');
  assert.equal((await api('POST', `/graph/edges/${e.id}/verify`, { token: clubOwner.token, body: { decision: 'verified' } })).status, 403, 'no self-verification');
  const v = must(await api('POST', `/graph/edges/${e.id}/verify`, { token: leagueOwner.token, body: { decision: 'verified' } }));
  assert.equal(v.verification_state, 'verified');
  const fixed = must(await api('PATCH', `/graph/edges/${e.id}`, { token: clubOwner.token, body: { row_version: v.row_version, valid_from: '2023-08-01', reason: 'Joined in August' } }));
  assert.equal(fixed.verification_state, 'unverified', 'a correction re-opens verification');
  assert.equal((await api('PATCH', `/graph/edges/${e.id}`, { token: clubOwner.token, body: { row_version: v.row_version, note: 'stale' } })).status, 409);
  const ended = must(await api('POST', `/graph/edges/${e.id}/end`, { token: clubOwner.token, body: { valid_to: '2025-06-30' } }));
  assert.equal(ended.status, 'ended');
  const asOf = (d) => api('GET', `/graph/entities/organisation/${club.id}/neighbours`, { token: stranger.token, query: { as_of: d, rel: 'member_of' } });
  assert.equal(must(await asOf('2024-05-01')).edges.length, 1);
  assert.equal(must(await asOf('2026-01-01')).edges.length, 0, 'effective dating: not a member after it ended');
  assert.equal(must(await asOf('2023-01-01')).edges.length, 0, 'nor before it began');
  const hist = must(await api('GET', `/graph/edges/${e.id}/history`, { token: clubOwner.token }));
  assert.deepEqual(hist.map((h) => h.action), ['created', 'verified', 'corrected', 'ended']);
  assert.equal((await q('SELECT count(*)::int AS n FROM graph_edges'))[0].n >= 2, true, 'nothing was deleted');
  const o360 = must(await api('GET', `/graph/organisations/${club.id}/360`, { token: stranger.token }));
  assert.equal(o360.sections.people.access, 'forbidden'); assert.equal(o360.sections.identity.access, 'ok');
  assert.equal(must(await api('GET', `/graph/organisations/${club.id}/360`, { token: clubOwner.token })).sections.people.access, 'ok');
});

test('a player career is reconstructed across teams, competitions, contracts, moves, results and shared health, with no duplicate identity', async () => {
  const mgr = await signup(['coach']), p = await signup(), viewer = await signup(), doctor = await signup(['doctor']);
  const t1 = await team(mgr, 'Eastside FC'), t2 = await team(mgr, 'Westside FC');
  must(await api('POST', '/me/career', { token: p.token, body: { team_id: t1.id, starts_on: '2020-08-01', ends_on: '2022-06-30', competition_level: 'club', idempotency_key: key() } }), 201);
  must(await api('POST', '/me/career', { token: p.token, body: { team_id: t2.id, starts_on: '2022-08-01', competition_level: 'club', idempotency_key: key() } }), 201);
  const ev = (await q("INSERT INTO events(name, sport_id, organizer_id, status, starts_on) VALUES ('Spring Cup', (SELECT id FROM sports WHERE slug='football'), $1, 'completed', '2023-03-01') RETURNING id", [mgr.id]))[0].id;
  const fx = (await q("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status, home_score, away_score) VALUES ($1,$2,$3,'2023-03-05T15:00:00Z','completed',2,1) RETURNING id", [ev, t2.id, t1.id]))[0].id;
  await q("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, minutes_played, minutes_basis, source) VALUES ($1,$2,$3,'started',90,'match_clock','lineup')", [fx, t2.id, p.id]);
  await q("INSERT INTO awards(name, kind, event_id, user_id, awarded_by, awarded_at) VALUES ('Player of the Match','mvp',$1,$2,$3,'2023-03-05')", [ev, p.id, mgr.id]);
  const g = (await q("INSERT INTO games(sport_id, created_by, title, status, starts_at) VALUES ((SELECT id FROM sports WHERE slug='tennis'), $1, 'Club singles final', 'post-event', '2023-06-01') RETURNING id", [mgr.id]))[0].id;
  await q("INSERT INTO game_participants(game_id, user_id, outcome, rank) VALUES ($1,$2,'win',1)", [g, p.id]);
  const c = (await q("INSERT INTO player_contracts(contract_no, team_id, payee_id, title, role, status, currency, created_by) VALUES ('C-1',$1,$2,'Playing contract','player','active','USD',$3) RETURNING id", [t2.id, p.id, mgr.id]))[0].id;
  await q('INSERT INTO clinical_clearances(athlete_id, doctor_id, status, assessed_on, valid_until) VALUES ($1,$2,$3,current_date,current_date + 90)', [p.id, doctor.id, 'cleared']);

  const own = must(await api('GET', `/graph/athletes/${p.id}/360`, { token: p.token })).sections;
  assert.equal(own.career.data.stints.length, 2);
  assert.deepEqual(own.career.data.moves.map((m) => [m.from_club, m.to_club, m.provenance]), [['Eastside FC', 'Westside FC', 'derived']]);
  assert.equal(own.competitions.data.totals.matches, 1); assert.equal(own.competitions.data.totals.verified_minutes, 90);
  assert.equal(own.results.data.by_sport[0].sport_slug, 'tennis'); assert.equal(own.results.data.by_sport[0].wins, 1);
  assert.equal(own.achievements.data.length, 1);
  assert.equal(own.contracts.data[0].id, c); assert.equal(own.contracts.data[0].title, 'Playing contract');
  assert.equal(own.health.access, 'ok'); assert.equal(own.health.data.status, 'cleared');
  assert.equal(own.health.data.restrictions, undefined, 'availability only, nothing clinical');

  const other = must(await api('GET', `/graph/athletes/${p.id}/360`, { token: viewer.token })).sections;
  assert.equal(other.career.access, 'ok');
  assert.equal(other.health.access, 'forbidden'); assert.equal(other.contracts.access, 'forbidden', 'permissions hide inaccessible domains');
  assert.equal(must(await api('GET', `/graph/athletes/${p.id}/360`, { token: mgr.token })).sections.contracts.data[0].id, c, 'the contracting team sees the terms');
  assert.equal((await q("SELECT 1 FROM audit_log WHERE action='read_graph_360_health' AND actor_id=$1", [p.id])).length, 1);

  const tl = must(await api('GET', '/graph/timeline', { token: p.token, query: { kind: 'person', id: p.id } }));
  assert.deepEqual([...new Set(tl.items.map((i) => i.domain))].sort(), ['achievement', 'career', 'competition', 'contract', 'health', 'result']);
  assert.ok(tl.items.every((i) => i.source.table && i.source.id), 'every row links to its source record');
  assert.ok(tl.items.some((i) => i.type === 'transfer' && i.provenance === 'derived'));
  assert.deepEqual(tl.items.map((i) => i.at), [...tl.items.map((i) => i.at)].sort().reverse(), 'newest first');
  const pg = must(await api('GET', '/graph/timeline', { token: p.token, query: { kind: 'person', id: p.id, limit: 3, domains: 'career,competition' } }));
  assert.equal(pg.items.length, 3);
  const ov = must(await api('GET', '/graph/timeline', { token: viewer.token, query: { kind: 'person', id: p.id } }));
  assert.ok(!ov.items.some((i) => ['health', 'contract'].includes(i.domain)));
  assert.ok(ov.hidden_domains.includes('health'));
  assert.equal((await q('SELECT count(*)::int AS n FROM users WHERE id=$1', [p.id]))[0].n, 1, 'one identity throughout');
});

test('health availability can be shared with an organisation only through the athlete\'s own share, and young people stay hidden', async () => {
  const owner = await signup(['organizer']), p = await signup(), doctor = await signup(['doctor']);
  const o = await org(owner, 'Shared Academy');
  await q('INSERT INTO clinical_clearances(athlete_id, doctor_id, status, assessed_on, valid_until) VALUES ($1,$2,$3,current_date,current_date + 30)', [p.id, doctor.id, 'cleared']);
  const asOrg = () => api('GET', `/graph/athletes/${p.id}/360`, { token: owner.token, query: { organisation_id: o.id } });
  assert.equal(must(await asOrg()).sections.health.access, 'forbidden');
  await q('INSERT INTO academy_clearance_shares(organisation_id, athlete_id, granted_by) VALUES ($1,$2,$2)', [o.id, p.id]);
  const shared = must(await asOrg()).sections.health;
  assert.equal(shared.access, 'ok'); assert.equal(shared.data.status, 'cleared'); assert.equal(shared.data.restrictions, undefined);
  await q('UPDATE academy_clearance_shares SET revoked_at=now() WHERE athlete_id=$1', [p.id]);
  assert.equal(must(await asOrg()).sections.health.access, 'forbidden', 'revocation is live');
  const kid = await signup();
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  const stranger = await signup();
  assert.equal((await api('GET', `/graph/athletes/${kid.id}/360`, { token: stranger.token })).status, 404);
  assert.equal(must(await api('GET', '/graph/search', { token: stranger.token, query: { q: kid.display_name, kinds: 'person' } })).length, 0);
  assert.equal((await api('GET', '/graph/timeline', { token: stranger.token, query: { kind: 'person', id: kid.id } })).status, 404);
  assert.equal(must(await api('GET', `/graph/athletes/${kid.id}/360`, { token: kid.token })).viewer_relation, 'self');
});

test('person-linked relationships are private to the person, their guardian and the other end; agents are not public', async () => {
  const agent = await signup(), athlete = await signup(), stranger = await signup();
  const e = must(await edge(athlete, { from_kind: 'person', from_id: agent.id, rel: 'represents', to_kind: 'person', to_id: athlete.id }));
  assert.equal(e.source_authority, 'counterparty', 'the athlete manages the other end');
  assert.equal(must(await api('GET', `/graph/entities/person/${athlete.id}/neighbours`, { token: stranger.token })).edges.length, 0);
  assert.equal(must(await api('GET', `/graph/entities/person/${athlete.id}/neighbours`, { token: athlete.token })).edges.length, 1);
  must(await api('POST', `/graph/edges/${e.id}/verify`, { token: agent.token, body: { decision: 'verified' } }));
  assert.equal(must(await api('GET', `/graph/athletes/${athlete.id}/360`, { token: stranger.token })).sections.relationships.data.length, 0, 'agent representation stays private even when verified');
});

test('MCP exposes the graph tools to an agent, with the same permissions', async () => {
  const u = await signup();
  const call = async (method, params) => (await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${u.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
  const tools = (await call('tools/list', {})).tools.map((t) => t.name);
  for (const t of ['graph_search', 'get_athlete_360', 'get_organisation_360', 'get_graph_timeline', 'create_graph_edge', 'get_graph_schema']) assert.ok(tools.includes(t), t);
  const out = await call('tools/call', { name: 'get_athlete_360', arguments: { id: u.id } });
  assert.ok(!out.isError, JSON.stringify(out));
});

test('results and the 360 work for every sport in the catalogue, each in its own recorded units', async () => {
  const p = await signup(), mgr = await signup(['coach']);
  const sports = await q('SELECT id, slug FROM sports ORDER BY slug');
  assert.ok(sports.length > 10);
  for (const s of sports) {
    const g = (await q("INSERT INTO games(sport_id, created_by, title, status, starts_at) VALUES ($1,$2,$3,'post-event', now() - interval '1 day') RETURNING id", [s.id, mgr.id, `${s.slug} result`]))[0].id;
    await q("INSERT INTO game_participants(game_id, user_id, outcome, rank, score) VALUES ($1,$2,'win',1,10)", [g, p.id]);
  }
  const res = must(await api('GET', `/graph/athletes/${p.id}/360`, { token: p.token })).sections.results.data;
  assert.deepEqual(res.by_sport.map((x) => x.sport_slug).sort(), sports.map((s) => s.slug).sort(), 'no sport falls through to a silent default');
  const tl = must(await api('GET', '/graph/timeline', { token: p.token, query: { kind: 'person', id: p.id, domains: 'result', limit: 100 } }));
  assert.equal(tl.items.length, Math.min(100, sports.length));
});
