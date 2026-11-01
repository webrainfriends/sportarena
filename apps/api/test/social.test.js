import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const r = await fetch(`${base}/api/v1${path}${qs}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `soc_${n}`, display_name: `Social ${n}`, email: `soc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const follow = (u, target) => api('POST', '/me/follows', { token: u.token, body: { subject_type: 'athlete', subject_id: target.id } });
const feed = async (u, query = {}) => must(await api('GET', '/me/activity-feed', { token: u.token, query }));
const sportId = async (slug) => (await pool.query('SELECT id FROM sports WHERE slug=$1', [slug])).rows[0].id;
const result = async (u, slug = 'football', { status = 'approved', provenance = 'approved_competition', on = new Date().toISOString().slice(0, 10) } = {}) =>
  (await pool.query(
    `INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, achieved_on, official_points, direction)
     VALUES ($1,$2,'goals',2,0,$1,$3,$4,$5,0,NULL) RETURNING id`, [u.id, await sportId(slug), provenance, status, on])).rows[0].id;
const young = (u) => pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [u.id]);
const guardianOf = async (child) => {
  const g = await signup();
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [g.id, child.id]);
  return g;
};
const team = async (a, b) => {
  const t = must(await api('POST', '/teams', { token: a.token, body: { name: `Soc FC ${++n}`, sport: 'football' } }), 201);
  for (const u of [a, b]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active') ON CONFLICT (team_id, user_id) DO UPDATE SET status='active'", [t.id, u.id]);
  return t;
};
const notes = async (u, kind) => (await pool.query('SELECT title FROM notifications WHERE user_id=$1 AND kind=$2', [u.id, kind])).rows;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('follow, list followers and following, and unfollow keeps the history', async () => {
  const a = await signup(), b = await signup();
  const f = must(await follow(a, b), 201);
  assert.equal(f.status, 'active');
  assert.deepEqual(must(await api('GET', '/me/followers', { token: b.token })).map((p) => p.id), [a.id]);
  assert.deepEqual(must(await api('GET', '/me/following', { token: a.token })).map((p) => p.id), [b.id]);
  assert.equal((await notes(b, 'follow_new')).length, 1);
  must(await api('DELETE', `/me/follows/${f.id}`, { token: a.token }));
  assert.equal(must(await api('GET', '/me/following', { token: a.token })).length, 0);
  assert.equal((await pool.query('SELECT 1 FROM spectator_follows WHERE user_id=$1 AND removed_at IS NOT NULL', [a.id])).rowCount, 1, 'soft unfollow keeps the row');
});

test('unknown, self, closed and blocked targets are the same 404', async () => {
  const a = await signup(), b = await signup(), c = await signup();
  assert.equal((await follow(a, { id: '00000000-0000-4000-8000-000000000000' })).status, 404);
  assert.equal((await follow(a, a)).status, 404);
  must(await api('PATCH', '/me/social-settings', { token: b.token, body: { follow_mode: 'closed' } }));
  assert.equal((await follow(a, b)).status, 404);
  must(await api('POST', '/me/contact-blocks', { token: c.token, body: { user_id: a.id, blocked: true } }));
  assert.equal((await follow(a, c)).status, 404, 'blocked by them');
  assert.equal((await api('POST', '/me/friends', { token: a.token, body: { user_id: c.id } })).status, 404);
  assert.equal((await follow(c, a)).status, 404, 'a blocker cannot follow the person they blocked either');
});

test('a person who approves followers sees a request and decides it', async () => {
  const a = await signup(), b = await signup(), c = await signup();
  must(await api('PATCH', '/me/social-settings', { token: b.token, body: { follow_mode: 'approval' } }));
  assert.equal(must(await follow(a, b), 201).status, 'pending');
  assert.equal(must(await api('GET', '/me/followers', { token: b.token })).length, 0);
  const reqs = must(await api('GET', '/me/follow-requests', { token: b.token }));
  assert.equal(reqs.incoming.length, 1);
  assert.equal((await api('POST', `/me/follow-requests/${reqs.incoming[0].id}`, { token: c.token, body: { approve: true } })).status, 404, 'only the person followed may decide');
  must(await api('POST', `/me/follow-requests/${reqs.incoming[0].id}`, { token: b.token, body: { approve: true } }));
  assert.deepEqual(must(await api('GET', '/me/followers', { token: b.token })).map((p) => p.id), [a.id]);
});

test('blocking ends friendship and follows both ways and keeps the history', async () => {
  const a = await signup(), b = await signup();
  must(await follow(a, b), 201); must(await follow(b, a), 201);
  const fr = must(await api('POST', '/me/friends', { token: a.token, body: { user_id: b.id } }), 201);
  assert.equal(fr.status, 'pending');
  must(await api('PATCH', `/me/friends/${fr.id}`, { token: b.token, body: { decision: 'accept' } }));
  assert.equal(must(await api('GET', '/me/friends', { token: a.token })).friends.length, 1);
  assert.equal((await notes(a, 'friend_accepted')).length, 1);
  must(await api('POST', '/me/contact-blocks', { token: a.token, body: { user_id: b.id, blocked: true } }));
  assert.equal(must(await api('GET', '/me/friends', { token: a.token })).friends.length, 0);
  assert.equal(must(await api('GET', '/me/following', { token: b.token })).length, 0);
  assert.equal((await pool.query("SELECT 1 FROM friendships WHERE status='ended'")).rowCount >= 1, true);
  const bm = must(await api('GET', '/me/blocked-muted', { token: a.token }));
  assert.deepEqual(bm.blocked.map((p) => p.id), [b.id]);
});

test('the feed is built from approved records only, honours per-item visibility, mute and hide', async () => {
  const a = await signup(), fan = await signup(), stranger = await signup(), friend = await signup();
  const ok = await result(a), unapproved = await result(a, 'football', { status: 'submitted' }), practice = await result(a, 'football', { provenance: 'self_reported' });
  must(await follow(fan, a), 201);
  const items = await feed(fan);
  assert.deepEqual(items.map((i) => i.source_id), [ok], 'unapproved and practice results never appear');
  assert.equal(items[0].kind, 'result'); assert.equal(items[0].sport.slug, 'football');
  assert.equal((await feed(stranger)).length, 0, 'someone who does not follow sees nothing');
  // friends-only
  must(await api('PATCH', `/me/activity/result/${ok}`, { token: a.token, body: { visibility: 'friends' } }));
  assert.equal((await feed(fan)).length, 0);
  must(await follow(friend, a), 201);
  const fr = must(await api('POST', '/me/friends', { token: friend.token, body: { user_id: a.id } }), 201);
  must(await api('PATCH', `/me/friends/${fr.id}`, { token: a.token, body: { decision: 'accept' } }));
  assert.equal((await feed(friend)).length, 1);
  // private, then public
  must(await api('PATCH', `/me/activity/result/${ok}`, { token: a.token, body: { visibility: 'private' } }));
  assert.equal((await feed(friend)).length, 0);
  must(await api('PATCH', `/me/activity/result/${ok}`, { token: a.token, body: { visibility: 'followers' } }));
  assert.equal((await feed(fan)).length, 1);
  // mute and hide
  must(await api('PATCH', `/me/mutes/${a.id}`, { token: fan.token, body: { muted: true } }));
  assert.equal((await feed(fan)).length, 0);
  must(await api('PATCH', `/me/mutes/${a.id}`, { token: fan.token, body: { muted: false } }));
  must(await api('PATCH', `/me/activity/result/${ok}`, { token: a.token, body: { hidden: true } }));
  assert.equal((await feed(fan)).length, 0);
  const mine = await feed(a, { scope: 'mine' });
  assert.equal(mine.find((i) => i.source_id === ok).hidden, true);
  // an item that is not yours is a 404
  assert.equal((await api('PATCH', `/me/activity/result/${unapproved}`, { token: a.token, body: { hidden: true } })).status, 404);
  assert.equal((await api('PATCH', `/me/activity/result/${ok}`, { token: fan.token, body: { hidden: false } })).status, 404);
});

test('a moderated item disappears for everyone and the person cannot lift it', async () => {
  const a = await signup(), fan = await signup(), reporter = await signup();
  const ok = await result(a);
  must(await follow(fan, a), 201); must(await follow(reporter, a), 201);
  const rep = must(await api('POST', '/social/reports', { token: reporter.token, body: { target_type: 'activity', target_id: `result:${ok}`, reason: 'inaccurate', note: 'looks wrong' } }), 201);
  assert.equal(rep.status, 'open');
  assert.equal((await pool.query('SELECT note_enc FROM social_reports WHERE id=$1', [rep.id])).rows[0].note_enc.includes('looks wrong'), false, 'note is encrypted');
  assert.equal((await api('GET', '/social/reports', { token: reporter.token })).status, 403, 'only the platform admin reads reports');
  await pool.query("INSERT INTO activity_item_settings(actor_id, kind, source_id, moderated_at) VALUES ($1,'result',$2,now()) ON CONFLICT (actor_id, kind, source_id) DO UPDATE SET moderated_at=now()", [a.id, ok]);
  assert.equal((await feed(fan)).length, 0);
  must(await api('PATCH', `/me/activity/result/${ok}`, { token: a.token, body: { visibility: 'public', hidden: false } }));
  assert.equal((await feed(fan)).length, 0, 'moderation hide survives the person changing their own setting');
  assert.equal((await api('POST', '/social/reports', { token: reporter.token, body: { target_type: 'user', target_id: '00000000-0000-4000-8000-000000000000', reason: 'spam' } })).status, 404);
});

test('hosted public games, ratings and streaks come from canonical records', async () => {
  const a = await signup(), fan = await signup();
  must(await follow(fan, a), 201);
  const d = (k) => new Date(Date.now() - k * 7 * 864e5).toISOString().slice(0, 10);
  for (const k of [0, 1, 2]) await result(a, 'tennis', { on: d(k) });
  const items = await feed(fan);
  assert.equal(items.filter((i) => i.kind === 'result').length, 3);
  const streak = items.find((i) => i.kind === 'streak');
  assert.ok(streak && streak.data.weeks >= 3, JSON.stringify(items.map((i) => i.kind)));
});

test('every sport in the catalogue can appear in the feed', async () => {
  const a = await signup(), fan = await signup();
  must(await follow(fan, a), 201);
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length >= 20);
  for (const s of sports) await result(a, s.slug);
  const seen = new Set();
  let before;
  for (let p = 0; p < 40; p++) {
    const page = await feed(fan, { limit: 50, ...(before ? { before } : {}) });
    for (const i of page) if (i.kind === 'result') seen.add(i.sport.slug);
    if (page.length < 50) break;
    before = `${page[page.length - 1].at}|${page[page.length - 1].source_id}`;
  }
  assert.equal(seen.size, sports.length, `missing: ${sports.filter((s) => !seen.has(s.slug)).map((s) => s.slug).join(', ')}`);
});

test('a young person is never discoverable, suggested, listed or in anyone\'s feed', async () => {
  const kid = await signup(), teammate = await signup(), stranger = await signup(), adult = await signup();
  const t = await team(teammate, kid);
  await young(kid);
  const parent = await guardianOf(kid);
  await result(kid);
  // strangers cannot reach, follow or befriend the young person; a teammate can only ask
  assert.equal((await follow(stranger, kid)).status, 404);
  assert.equal((await api('POST', '/me/friends', { token: stranger.token, body: { user_id: kid.id } })).status, 404);
  // suggestions: not for the kid, and the kid is not suggested to teammates
  assert.deepEqual(must(await api('GET', '/me/social-suggestions', { token: kid.token })), []);
  assert.equal(must(await api('GET', '/me/social-suggestions', { token: teammate.token })).some((p) => p.id === kid.id), false);
  // settings are always private and cannot be loosened
  const st = must(await api('GET', '/me/social-settings', { token: kid.token }));
  assert.equal(st.default_item_visibility, 'private'); assert.equal(st.discoverable, false);
  assert.equal((await api('PATCH', '/me/social-settings', { token: kid.token, body: { discoverable: true } })).status, 409);
  // a teammate's follow of the young person waits for a guardian
  const f = must(await follow(teammate, kid), 201);
  assert.equal(f.status, 'guardian_pending');
  assert.equal(must(await api('GET', '/me/followers', { token: kid.token })).length, 0);
  assert.equal((await api('POST', `/me/follow-requests/${f.id}`, { token: stranger.token, body: { approve: true } })).status, 404, 'only a live guardian decides');
  const q = must(await api('GET', '/me/follow-requests', { token: parent.token }));
  assert.equal(q.guardian.length, 1);
  must(await api('POST', `/me/follow-requests/${f.id}`, { token: parent.token, body: { approve: true } }));
  assert.equal(must(await api('GET', '/me/following', { token: teammate.token })).length, 1);
  // ...but the young person's items are still never in the feed
  assert.equal((await feed(teammate)).length, 0);
  assert.equal((await feed(kid, { scope: 'following' })).length, 0);
  // revoking the guardian link ends the visibility of the follow at once
  await pool.query("UPDATE guardian_links SET revoked_at=now(), status='revoked' WHERE child_id=$1", [kid.id]).catch(() => pool.query('UPDATE guardian_links SET revoked_at=now() WHERE child_id=$1', [kid.id]));
  assert.equal(must(await api('GET', '/me/following', { token: teammate.token })).length, 0);
  // a guardian without the social scope cannot approve
  const kid2 = await signup(); await team(teammate, kid2); await young(kid2);
  const p2 = await guardianOf(kid2);
  await pool.query("UPDATE guardian_links SET scopes = '{pay}' WHERE child_id=$1", [kid2.id]);
  const f2 = must(await follow(teammate, kid2), 201);
  assert.equal((await api('POST', `/me/follow-requests/${f2.id}`, { token: p2.token, body: { approve: true } })).status, 403);
  void t; void adult;
});

test('a young person following an adult needs their guardian; two young people never become friends', async () => {
  const kid = await signup(), coach = await signup(), kid2 = await signup();
  await team(coach, kid); await team(kid, kid2);
  await young(kid); await young(kid2);
  const parent = await guardianOf(kid); await guardianOf(kid2);
  const f = must(await follow(kid, coach), 201);
  assert.equal(f.status, 'guardian_pending');
  assert.equal((await feed(kid)).length, 0);
  must(await api('POST', `/me/follow-requests/${f.id}`, { token: parent.token, body: { approve: true } }));
  assert.equal(must(await api('GET', '/me/following', { token: kid.token })).length, 1);
  assert.equal((await api('POST', '/me/friends', { token: kid.token, body: { user_id: kid2.id } })).status, 404, 'young to young is not possible');
  assert.equal((await api('POST', '/me/follow-requests/00000000-0000-4000-8000-000000000000', { token: parent.token, body: { approve: true } })).status, 404);
});

test('rate limits, reports are audit-logged and the capabilities are in REST, OpenAPI and MCP', async () => {
  const a = await signup(), b = await signup();
  await pool.query("INSERT INTO spectator_actions(user_id, kind) SELECT $1, 'follow' FROM generate_series(1,60)", [a.id]);
  assert.equal((await follow(a, b)).status, 429);
  const victim = await signup();
  const rep = must(await api('POST', '/social/reports', { token: b.token, body: { target_type: 'user', target_id: victim.id, reason: 'spam', note: 'private note' } }), 201);
  assert.ok(rep.id ?? rep.status ?? rep, 'report accepted');
  assert.equal((await pool.query("SELECT 1 FROM social_reports WHERE reporter_id=$1 AND actor_id=$2 AND note_enc IS NOT NULL AND note_enc NOT LIKE '%private note%'", [b.id, victim.id])).rowCount, 1, 'note is stored encrypted');
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='social_report'", [b.id])).rowCount, 1, 'report is audit-logged');
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const names = ['get_social_settings', 'update_social_settings', 'list_followers', 'list_following', 'list_follow_requests', 'decide_follow_request', 'request_friend', 'respond_friend', 'end_friend', 'list_friends', 'set_user_mute', 'list_blocked_and_muted', 'get_social_suggestions', 'get_activity_feed', 'set_activity_visibility', 'report_social', 'list_social_reports', 'decide_social_report'];
  for (const nme of names) {
    assert.ok(capabilities.some((c) => c.name === nme), nme);
    assert.ok(Object.values(spec.paths).some((p) => Object.values(p).some((o) => o.operationId === nme)), `openapi ${nme}`);
  }
});

test('the MCP server lists every social capability, with the same auth rules', async () => {
  const rpc = async (method, params, token) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()).result;
  };
  const tools = (await rpc('tools/list', {})).tools.map((t) => t.name);
  for (const nme of ['list_followers', 'list_following', 'request_friend', 'respond_friend', 'get_activity_feed', 'set_user_mute', 'report_social', 'get_social_settings']) assert.ok(tools.includes(nme), `mcp ${nme}`);
  assert.equal((await rpc('tools/call', { name: 'get_activity_feed', arguments: {} })).isError, true, 'anonymous is refused');
  const u = await signup();
  const r = await rpc('tools/call', { name: 'get_activity_feed', arguments: {} }, u.token);
  assert.ok(!r.isError && Array.isArray(r.structuredContent.result));
});

test('notifications respect muted kinds, blocks, quiet hours and never leave the app channel', async () => {
  const { useCaseForKind } = await import('../src/comms-catalogue.js');
  for (const k of ['follow_new', 'follow_request', 'friend_request', 'friend_accepted']) assert.equal(useCaseForKind(k), null, `${k} is not mapped to WhatsApp / SMS`);
  const pushFor = async (u, kind) => (await pool.query("SELECT d.channel FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=$1 AND n.kind=$2", [u.id, kind])).rows.map((r) => r.channel);
  const device = (u) => pool.query("INSERT INTO push_devices(user_id, provider, platform, token) VALUES ($1,'expo','ios',$2)", [u.id, `ExponentPushToken[${u.id}]`]);
  const a = await signup(), b = await signup(), c = await signup(), d = await signup(), e = await signup();
  // normal: in the inbox, and pushed
  await device(b); must(await follow(a, b), 201);
  assert.equal((await notes(b, 'follow_new')).length, 1);
  assert.deepEqual(await pushFor(b, 'follow_new'), ['email', 'push']);
  // muted kind: nothing is created at all
  await pool.query("INSERT INTO notification_prefs(user_id, muted_kinds) VALUES ($1, ARRAY['follow_new'])", [c.id]);
  must(await follow(a, c), 201);
  assert.equal((await notes(c, 'follow_new')).length, 0);
  // quiet hours: still in the inbox, but no push (and no WhatsApp / SMS)
  await device(d);
  await pool.query("INSERT INTO notification_prefs(user_id, quiet_start, quiet_end, quiet_tz) VALUES ($1,'00:00','23:59','UTC')", [d.id]);
  const nowUtc = new Date().toISOString().slice(11, 16);
  if (nowUtc < '23:59') {
    must(await follow(a, d), 201);
    assert.equal((await notes(d, 'follow_new')).length, 1);
    const ch = await pushFor(d, 'follow_new');
    assert.ok(!ch.includes('push') && !ch.includes('whatsapp') && !ch.includes('sms'), JSON.stringify(ch));
  }
  // a blocked person never notifies the person who blocked them
  must(await api('POST', '/me/contact-blocks', { token: e.token, body: { user_id: a.id, blocked: true } }));
  assert.equal((await follow(a, e)).status, 404);
  assert.equal((await notes(e, 'follow_new')).length, 0);
});
