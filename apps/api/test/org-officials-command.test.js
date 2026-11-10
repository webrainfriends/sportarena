// Federation & assignor organisation command centre (REF-R12, #1004): an organisation's panel of officials, delegated assignors, workload,
// unfilled fixtures, messages and export. Driven over REST against a real Postgres, like the other officials suites: every person in the
// story signs up through the public API and each test creates its own data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body).slice(0, 400)); return r.body; };
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ooc_${n}_${roles[0]}`, display_name: `Command ${n}`, email: `ooc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const referee = async (sport = 'football') => {
  const r = await signup(['referee']);
  must(await api('POST', '/me/sport-profiles', { token: r.token, body: { sport, role: 'referee' } }), 201);
  return r;
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function world() {
  const owner = await signup(['organizer']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Island Referees ${n}`, kind: 'club', city: 'Palma' } }), 201);
  const sportId = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0].id;
  return { owner, org, sportId };
}

test('roster: invite, accept or decline, suspend, reinstate, remove; history is kept and outsiders get nothing', async () => {
  const { owner, org, sportId } = await world();
  const [r1, r2, outsider] = [await referee(), await referee(), await signup(['organizer'])];

  const inv = must(await api('POST', `/organisations/${org.id}/officials/roster`, { token: owner.token, body: { user_id: r1.id, sport_id: sportId, notes: 'Regional panel' } }), 201);
  assert.equal(inv.status, 'invited');
  assert.equal((await api('POST', `/organisations/${org.id}/officials/roster`, { token: owner.token, body: { user_id: r1.id, sport_id: sportId } })).status, 409, 'the same official and sport cannot be on the panel twice');
  const bulk = must(await api('POST', `/organisations/${org.id}/officials/roster/bulk`, { token: owner.token, body: { user_ids: [r1.id, r2.id], sport_id: sportId } }), 201);
  assert.ok(JSON.stringify(bulk).includes(r2.id), 'the second official is invited by the bulk call');

  // only the invited official can answer
  assert.notEqual((await api('POST', `/org-official-roster/${inv.id}/respond`, { token: r2.token, body: { response: 'accept' } })).status, 200);
  const acc = must(await api('POST', `/org-official-roster/${inv.id}/respond`, { token: r1.token, body: { response: 'accept' } }));
  assert.equal(acc.status, 'active');

  const roster = must(await api('GET', `/organisations/${org.id}/officials/roster`, { token: owner.token }));
  const rows = roster.items ?? roster.officials ?? roster.roster ?? roster;
  assert.ok(rows.some((x) => x.user_id === r1.id && x.status === 'active'));

  const sus = must(await api('POST', `/org-official-roster/${inv.id}/suspend`, { token: owner.token, body: { reason: 'Licence under review' } }));
  assert.equal(sus.status, 'suspended');
  assert.equal(must(await api('POST', `/org-official-roster/${inv.id}/reinstate`, { token: owner.token, body: {} })).status, 'active');
  assert.equal(must(await api('POST', `/org-official-roster/${inv.id}/remove`, { token: owner.token, body: { reason: 'Moved to another region' } })).status, 'removed');
  const hist = (await pool.query('SELECT from_status, to_status FROM org_official_roster_history WHERE roster_id=$1 ORDER BY at, id', [inv.id])).rows;
  assert.ok(hist.length >= 3, 'each change of state is recorded');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_official_rosters WHERE id=$1', [inv.id])).rows[0].n, 1, 'a removed official is kept as history, not deleted');

  // someone outside the organisation
  for (const [m, p, b] of [['GET', `/organisations/${org.id}/officials/roster`], ['GET', `/organisations/${org.id}/officials/command`], ['POST', `/organisations/${org.id}/officials/roster`, { user_id: r2.id }], ['GET', `/organisations/${org.id}/officials/roster/export`]]) {
    const r = await api(m, p, { token: outsider.token, body: b });
    assert.ok([403, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
  assert.equal((await api('GET', `/organisations/${org.id}/officials/roster`)).status, 401);
});

test('assignors: grant, change, list and revoke delegated permissions', async () => {
  const { owner, org, sportId } = await world();
  const helper = await signup(['organizer']);
  // an assignor is chosen from the organisation's own active members
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,'staff','active')", [org.id, helper.id]);
  const g = must(await api('POST', `/organisations/${org.id}/assignors`, { token: owner.token, body: { user_id: helper.id, sport_id: sportId, jurisdiction: 'Mallorca', can_release: false } }), 201);
  assert.equal(g.status, 'active');
  assert.equal((await api('POST', `/organisations/${org.id}/assignors`, { token: owner.token, body: { user_id: helper.id, sport_id: sportId } })).status, 409, 'one grant per person and sport');
  const upd = must(await api('POST', `/org-assignors/${g.id}/update`, { token: owner.token, body: { can_release: true } }));
  assert.equal(upd.can_release, true);
  const list = must(await api('GET', `/organisations/${org.id}/assignors`, { token: owner.token }));
  assert.ok((list.items ?? list.assignors ?? list).some((x) => x.id === g.id));
  // the grant lets the assignor invite to the panel; without it they could not
  const ref = await referee();
  assert.equal((await api('POST', `/organisations/${org.id}/officials/roster`, { token: helper.token, body: { user_id: ref.id, sport_id: sportId } })).status, 201);
  assert.equal(must(await api('POST', `/org-assignors/${g.id}/revoke`, { token: owner.token, body: {} })).status, 'revoked');
  const ref2 = await referee();
  assert.ok([403, 404].includes((await api('POST', `/organisations/${org.id}/officials/roster`, { token: helper.token, body: { user_id: ref2.id, sport_id: sportId } })).status), 'a revoked grant stops working at once');
  assert.ok([403, 404].includes((await api('POST', `/organisations/${org.id}/assignors`, { token: helper.token, body: { user_id: ref2.id } })).status), 'an assignor cannot grant permissions');
});

test('command centre, workload, unfilled fixtures, eligibility, messages and export all answer for the organisation', async () => {
  const { owner, org, sportId } = await world();
  const r1 = await referee();
  const inv = must(await api('POST', `/organisations/${org.id}/officials/roster`, { token: owner.token, body: { user_id: r1.id, sport_id: sportId } }), 201);
  must(await api('POST', `/org-official-roster/${inv.id}/respond`, { token: r1.token, body: { response: 'accept' } }));

  const cmd = must(await api('GET', `/organisations/${org.id}/officials/command`, { token: owner.token }));
  assert.ok(JSON.stringify(cmd).length > 2);
  must(await api('GET', `/organisations/${org.id}/officials/workload`, { token: owner.token, query: { days: 14 } }));
  must(await api('GET', `/organisations/${org.id}/officials/unfilled`, { token: owner.token, query: { days_ahead: 21 } }));
  must(await api('GET', `/organisations/${org.id}/officials/eligibility`, { token: owner.token }));

  const msg = must(await api('POST', `/organisations/${org.id}/officials/messages`, { token: owner.token, body: { subject: 'Season briefing', body: 'Briefing on Thursday at the federation office.' } }), 201);
  assert.ok(msg.id ?? msg.message?.id);
  const told = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1", [r1.id])).rows[0].n;
  assert.ok(told >= 1, 'the active official is notified');
  const msgs = must(await api('GET', `/organisations/${org.id}/officials/messages`, { token: owner.token }));
  assert.ok((msgs.items ?? msgs.messages ?? msgs).length >= 1);

  const exp = await api('GET', `/organisations/${org.id}/officials/roster/export`, { token: owner.token });
  assert.equal(exp.status, 200);
  assert.ok(JSON.stringify(exp.body).includes(r1.display_name), 'the export lists the panel');
});

test('every command-centre capability is on REST, OpenAPI and MCP', async () => {
  const names = ['get_org_officials_command', 'list_org_official_roster', 'invite_org_official', 'bulk_invite_org_officials', 'respond_org_official_invite', 'suspend_org_official', 'reinstate_org_official', 'remove_org_official',
    'grant_assignor_permission', 'update_assignor_permission', 'revoke_assignor_permission', 'list_org_assignors', 'get_org_official_workload', 'get_org_unfilled_fixtures', 'send_org_officials_message', 'list_org_official_messages',
    'get_org_official_eligibility', 'export_org_official_roster'];
  for (const nm of names) assert.equal(capabilities.filter((c) => c.name === nm).length, 1, `${nm} is registered`);
  const spec = must(await api('GET', '/openapi.json'));
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const nm of names) assert.ok(ops.has(nm), `${nm} in OpenAPI`);
  const who = await signup(['organizer']);
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${who.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const text = await r.text();
  for (const nm of names) assert.ok(text.includes(`"${nm}"`), `${nm} in MCP`);
});
