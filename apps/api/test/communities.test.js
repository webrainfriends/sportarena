// Communities and moderated activity sharing (issue #66): membership and roles, visibility, blocks, young people, posts and shares,
// cursor feeds, reports -> decisions -> appeals, rate limits, retention, notification choices and REST / OpenAPI / MCP parity.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
process.env.MESSAGES_PER_HOUR = '3';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const { LIMITS, archiveStaleCommunityContent } = await import('../src/communities.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const r = await fetch(`${base}/api/v1${path}${qs}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const rpc = async (token, name, args) => (await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
const signup = async (email) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `com_${n}`, display_name: `Com ${n}`, email: email ?? `com${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const platformAdmin = async () => {
  const u = await signup('rraja.edge@gmail.com');
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id=$1", [u.id]);
  return u;
};
const young = (u) => pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [u.id]);
const team = async (a, ...others) => {
  const t = must(await api('POST', '/teams', { token: a.token, body: { name: `Com FC ${++n}`, sport: 'football' } }), 201);
  for (const u of others) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active') ON CONFLICT (team_id, user_id) DO UPDATE SET status='active'", [t.id, u.id]);
  return t;
};
const community = async (owner, body = {}) => must(await api('POST', '/communities', { token: owner.token, body: { name: `Club ${++n} runners`, ...body } }), 201);
const post = async (u, ref, text, extra = {}) => must(await api('POST', `/communities/${ref}/posts`, { token: u.token, body: { text, ...extra } }), 201);
const feed = async (u, ref, query = {}) => must(await api('GET', `/communities/${ref}/feed`, { token: u.token, query }));
const block = (a, b) => api('POST', '/me/contact-blocks', { token: a.token, body: { user_id: b.id, blocked: true } });
const result = async (u) => (await pool.query(
  `INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, achieved_on, official_points, direction)
   VALUES ($1,(SELECT id FROM sports WHERE slug='football'),'goals',2,0,$1,'approved_competition','approved',current_date,0,NULL) RETURNING id`, [u.id])).rows[0].id;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('create, address clash, visibility rules and the owner role', async () => {
  const o = await signup();
  const c = await community(o, { name: 'Sunday Cricket Chennai', sport: 'cricket', city: 'Chennai' });
  assert.equal(c.slug, 'sunday-cricket-chennai');
  assert.equal((await api('POST', '/communities', { token: o.token, body: { name: 'Sunday Cricket Chennai' } })).status, 409, 'same address twice');
  assert.equal((await api('POST', '/communities', { token: o.token, body: { name: 'Secret club', visibility: 'hidden', join_mode: 'open' } })).status, 400, 'hidden must be by invitation');
  assert.equal((await api('POST', '/communities', { token: o.token, body: { name: 'Kids public', audience: 'all' } })).status, 400, 'an open community cannot admit young people');
  const mine = must(await api('GET', '/communities', { token: o.token, query: { scope: 'mine' } }));
  assert.deepEqual(mine.items.map((x) => x.slug), ['sunday-cricket-chennai']);
  assert.equal(mine.items[0].my_role, 'owner');
  const k = await signup(); await young(k);
  assert.equal((await api('POST', '/communities', { token: k.token, body: { name: 'Young founders' } })).status, 403, 'young people cannot start communities');
});

test('open, request and invitation-only joining, with roles and removal', async () => {
  const o = await signup(), a = await signup(), b = await signup(), m = await signup();
  const open = await community(o);
  assert.equal(must(await api('POST', `/communities/${open.slug}/join`, { token: a.token }), 201).status, 'active');
  must(await api('POST', `/communities/${open.slug}/join`, { token: a.token }), 201);            // harmless twice
  const req = await community(o, { join_mode: 'request', visibility: 'private' });
  assert.equal(must(await api('POST', `/communities/${req.slug}/join`, { token: b.token }), 201).status, 'pending');
  assert.equal((await api('GET', `/communities/${req.slug}/members`, { token: b.token, query: { status: 'pending' } })).status, 404, 'a requester cannot read the member list');
  assert.equal(must(await api('GET', `/communities/${req.slug}/members`, { token: o.token, query: { status: 'pending' } })).items.length, 1);
  must(await api('POST', `/communities/${req.slug}/members/${b.id}`, { token: o.token, body: { action: 'approve' } }));
  assert.equal((await api('POST', `/communities/${req.slug}/members/${b.id}`, { token: b.token, body: { action: 'remove' } })).status, 403, 'a member cannot run the community');
  // only the owner appoints moderators; a moderator can remove a member but not another moderator
  must(await api('POST', `/communities/${open.slug}/members/${a.id}`, { token: o.token, body: { action: 'make_moderator' } }));
  must(await api('POST', `/communities/${open.slug}/join`, { token: m.token }), 201);
  assert.equal((await api('POST', `/communities/${open.slug}/members/${m.id}`, { token: a.token, body: { action: 'make_moderator' } })).status, 403, 'moderators cannot appoint');
  must(await api('POST', `/communities/${open.slug}/members/${m.id}`, { token: a.token, body: { action: 'silence', silence_minutes: 30 } }));
  assert.equal((await api('POST', `/communities/${open.slug}/posts`, { token: m.token, body: { text: 'hello' } })).status, 403, 'a silenced member cannot post');
  must(await api('POST', `/communities/${open.slug}/members/${m.id}`, { token: a.token, body: { action: 'remove' } }));
  assert.equal((await api('POST', `/communities/${open.slug}/join`, { token: m.token })).status, 404, 'a removed person cannot rejoin on their own');
  assert.equal((await api('POST', `/communities/${open.slug}/members/${o.id}`, { token: a.token, body: { action: 'remove' } })).status, 403, 'the owner cannot be removed');
  assert.equal((await api('POST', `/communities/${open.slug}/leave`, { token: o.token })).status, 409, 'the owner archives instead of leaving');
  assert.equal((await pool.query("SELECT status FROM community_members WHERE community_id=$1 AND user_id=$2", [open.id, m.id])).rows[0].status, 'removed', 'removal keeps the row');
  const inviteOnly = await community(o, { join_mode: 'invite', visibility: 'private' });
  assert.equal((await api('POST', `/communities/${inviteOnly.slug}/join`, { token: b.token })).status, 409);
});

test('private and hidden content is a 404 to outsiders over REST and MCP', async () => {
  const o = await signup(), insider = await signup(), outsider = await signup();
  const priv = await community(o, { visibility: 'private', join_mode: 'request' });
  const hid = await community(o, { visibility: 'hidden', join_mode: 'invite' });
  await team(o, insider, outsider);                                  // a shared team makes everyone reachable, as in real life
  must(await api('POST', `/communities/${priv.slug}/join`, { token: insider.token }), 201);
  must(await api('POST', `/communities/${priv.slug}/members/${insider.id}`, { token: o.token, body: { action: 'approve' } }));
  const invite = must(await api('POST', `/communities/${hid.slug}/invitations`, { token: o.token, body: { user_id: insider.id } }), 201);
  assert.equal((await api('GET', `/communities/${hid.slug}`, { token: insider.token })).status, 200, 'an invitee can see a hidden community');
  must(await api('POST', `/me/community-invitations/${invite.id}`, { token: insider.token, body: { decision: 'accept' } }));
  const secret = await post(o, priv.slug, 'private training plan');
  const secret2 = await post(o, hid.slug, 'hidden plan');
  for (const [c, p] of [[priv, secret], [hid, secret2]]) {
    for (const path of [`/communities/${c.slug}/feed`, `/communities/${c.slug}/members`, `/market/posts/${p.id}`, `/market/posts/${p.id}/comments`]) {
      assert.equal((await api('GET', path, { token: outsider.token })).status, 404, `REST ${path}`);
    }
    assert.equal((await api('POST', `/market/posts/${p.id}/comments`, { token: outsider.token, body: { body: 'hi' } })).status, 404);
    assert.equal((await api('POST', `/market/posts/${p.id}/react`, { token: outsider.token })).status, 404);
    // MCP goes through the same invoke path
    assert.equal((await rpc(outsider.token, 'list_community_feed', { ref: c.slug })).isError, true, 'MCP feed is an error for an outsider');
    assert.equal((await rpc(outsider.token, 'get_market_post', { id: p.id })).isError, true);
  }
  assert.equal((await api('GET', `/communities/${hid.slug}`, { token: outsider.token })).status, 404, 'hidden is not even listed');
  const card = must(await api('GET', `/communities/${priv.slug}`, { token: outsider.token }));
  assert.equal(card.can.read, false);
  assert.equal(JSON.stringify(card).includes('private training plan'), false);
  assert.ok(!must(await api('GET', '/communities', { token: outsider.token })).items.some((x) => x.id === hid.id), 'hidden communities are not discoverable');
  // an insider reads it, and it never reaches the public marketplace
  assert.equal((await feed(insider, priv.slug)).items[0].text, 'private training plan');
  const pub = must(await api('GET', '/market/posts', { query: { limit: 100 } }));
  assert.equal(pub.some((x) => x.id === secret.id || x.id === secret2.id), false, 'community posts never appear in the public marketplace');
  assert.equal((await pool.query('SELECT body_enc IS NOT NULL AS enc, body IS NULL AS plain_empty FROM market_posts WHERE id=$1', [secret.id])).rows[0].enc, true, 'text is stored encrypted');
});

test('blocking applies to invitations, join, feed visibility, comments and members', async () => {
  const o = await signup(), a = await signup(), b = await signup();
  await team(o, a, b);
  const c = await community(o);
  for (const u of [a, b]) must(await api('POST', `/communities/${c.slug}/join`, { token: u.token }), 201);
  const pa = await post(a, c.slug, 'a was here'), pb = await post(b, c.slug, 'b was here');
  assert.deepEqual((await feed(a, c.slug)).items.map((x) => x.text).sort(), ['a was here', 'b was here']);
  must(await block(a, b));
  assert.deepEqual((await feed(a, c.slug)).items.map((x) => x.text), ['a was here'], 'the blocker no longer sees the blocked person');
  assert.deepEqual((await feed(b, c.slug)).items.map((x) => x.text), ['b was here'], 'the blocked person no longer sees the blocker');
  assert.equal((await api('POST', `/market/posts/${pa.id}/comments`, { token: b.token, body: { body: 'hello' } })).status, 404, 'cannot comment across a block');
  assert.equal((await api('GET', `/market/posts/${pb.id}`, { token: a.token })).status, 404);
  assert.ok(!must(await api('GET', `/communities/${c.slug}/members`, { token: a.token })).items.some((m) => m.id === b.id));
  const other = await community(a, { visibility: 'private', join_mode: 'invite' });
  assert.equal((await api('POST', `/communities/${other.slug}/invitations`, { token: a.token, body: { user_id: b.id } })).status, 404, 'no invitations across a block');
  assert.equal((await api('POST', `/communities/${c.slug}/invitations`, { token: b.token, body: { user_id: a.id } })).status, 404);
  assert.equal((await api('POST', '/social/reports', { token: a.token, body: { target_type: 'community_post', target_id: pb.id, reason: 'spam' } })).status, 404);
  // a mute hides without telling them
  const c2 = await signup(); await team(o, c2);
  must(await api('POST', `/communities/${c.slug}/join`, { token: c2.token }), 201);
  must(await api('PATCH', `/me/mutes/${b.id}`, { token: c2.token, body: { muted: true } }));
  assert.ok(!(await feed(c2, c.slug)).items.some((x) => x.text === 'b was here'));
});

test('invitations are idempotent, answered by the invitee, and young people need a live guardian and an audience=all community', async () => {
  const o = await signup(), p = await signup(), kid = await signup(), g = await signup();
  await team(o, p, kid);
  const adults = await community(o, { visibility: 'private', join_mode: 'invite' });
  const i1 = must(await api('POST', `/communities/${adults.slug}/invitations`, { token: o.token, body: { user_id: p.id } }), 201);
  const i2 = must(await api('POST', `/communities/${adults.slug}/invitations`, { token: o.token, body: { user_id: p.id } }), 201);
  assert.equal(i2.already, true); assert.equal(i2.id, i1.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM community_invitations WHERE community_id=$1", [adults.id])).rows[0].n, 1);
  assert.equal((await api('POST', `/me/community-invitations/${i1.id}`, { token: o.token, body: { decision: 'accept' } })).status, 404, 'only the invitee answers');
  must(await api('POST', `/me/community-invitations/${i1.id}`, { token: p.token, body: { decision: 'accept' } }));
  assert.equal((await api('POST', `/me/community-invitations/${i1.id}`, { token: p.token, body: { decision: 'decline' } })).status, 409);
  // young people
  await young(kid);
  assert.equal((await api('POST', `/communities/${adults.slug}/invitations`, { token: o.token, body: { user_id: kid.id } })).status, 404, 'adults-only communities do not admit the young');
  const family = await community(o, { visibility: 'private', join_mode: 'invite', audience: 'all' });
  const pi = must(await api('POST', `/communities/${family.slug}/invitations`, { token: o.token, body: { user_id: p.id } }), 201);
  must(await api('POST', `/me/community-invitations/${pi.id}`, { token: p.token, body: { decision: 'accept' } }));
  const ki = await api('POST', `/communities/${family.slug}/invitations`, { token: o.token, body: { user_id: kid.id } });
  must(ki, 201);
  assert.equal((await api('POST', `/me/community-invitations/${ki.body.id}`, { token: kid.token, body: { decision: 'accept' } })).status, 409, 'no guardian, no joining');
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [g.id, kid.id]);
  must(await api('POST', `/me/community-invitations/${ki.body.id}`, { token: kid.token, body: { decision: 'accept' } }));
  assert.ok(!must(await api('GET', `/communities/${family.slug}/members`, { token: p.token })).items.some((m) => m.id === kid.id), 'non-staff do not see young members');
  assert.ok(must(await api('GET', `/communities/${family.slug}/members`, { token: o.token })).items.some((m) => m.id === kid.id), 'the owner does');
  // revoking the guardian removes access at once
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE child_id=$1", [kid.id]);
  assert.equal((await api('GET', `/communities/${family.slug}/feed`, { token: kid.token })).status, 404);
});

test('posts, shares of verified achievements, and a cursor feed that stays stable while posts arrive', async () => {
  const o = await signup(), a = await signup();
  const c = await community(o);
  must(await api('POST', `/communities/${c.slug}/join`, { token: a.token }), 201);
  for (let i = 1; i <= 5; i++) await post(a, c.slug, `post ${i}`);
  const p1 = await feed(a, c.slug, { limit: 2 });
  assert.deepEqual(p1.items.map((x) => x.text), ['post 5', 'post 4']);
  await post(o, c.slug, 'arrived between pages');
  const p2 = await feed(a, c.slug, { limit: 2, before: p1.next });
  assert.deepEqual(p2.items.map((x) => x.text), ['post 3', 'post 2'], 'no skips or repeats when a post arrives');
  const p3 = await feed(a, c.slug, { limit: 2, before: p2.next });
  assert.deepEqual(p3.items.map((x) => x.text), ['post 1']); assert.equal(p3.next, null);
  assert.equal((await api('GET', `/communities/${c.slug}/feed`, { token: a.token, query: { before: 'junk' } })).status, 400);
  assert.equal((await api('POST', `/communities/${c.slug}/posts`, { token: a.token, body: { text: '   ' } })).status, 400, 'empty posts are refused');
  // an achievement share: only your own approved record
  const rid = await result(a);
  const s = await post(a, c.slug, 'Two goals!', { ref_kind: 'result', ref_id: String(rid) });
  const shared = (await feed(a, c.slug)).items.find((x) => x.id === s.id);
  assert.equal(shared.share.kind, 'result'); assert.equal(shared.share.data.metric, 'goals'); assert.equal(shared.share.sport.slug, 'football');
  assert.equal((await api('POST', `/communities/${c.slug}/posts`, { token: o.token, body: { text: 'mine', ref_kind: 'result', ref_id: String(rid) } })).status, 404, "cannot share someone else's record");
  await pool.query("UPDATE performances SET status='reversed' WHERE id=$1", [rid]).catch(() => pool.query("UPDATE performances SET status='rejected' WHERE id=$1", [rid]));
  assert.equal((await feed(a, c.slug)).items.find((x) => x.id === s.id).share.unavailable, true, 'a reversed record is no longer shown');
  // comments page by cursor and keep their text encrypted
  for (const t of ['one', 'two', 'three']) must(await api('POST', `/market/posts/${s.id}/comments`, { token: o.token, body: { body: t } }), 201);
  const c1 = must(await api('GET', `/market/posts/${s.id}/comments`, { token: a.token, query: { limit: 2 } }));
  const c2 = must(await api('GET', `/market/posts/${s.id}/comments`, { token: a.token, query: { limit: 2, after: c1.at(-1).cursor } }));
  assert.deepEqual([...c1, ...c2].map((x) => x.body), ['one', 'two', 'three']);
  assert.equal((await pool.query("SELECT bool_and(body = '' AND body_enc IS NOT NULL) AS enc FROM market_comments WHERE post_id=$1", [s.id])).rows[0].enc, true);
  // removal hides, never deletes
  must(await api('POST', `/communities/${c.slug}/posts/${s.id}/remove`, { token: o.token, body: { reason: 'off topic' } }));
  assert.ok(!(await feed(a, c.slug)).items.some((x) => x.id === s.id));
  assert.equal((await pool.query('SELECT hidden_at IS NOT NULL AS h FROM market_posts WHERE id=$1', [s.id])).rows[0].h, true);
});

test('report -> moderator decision with reason -> notices -> appeal as a support case -> overturn', async () => {
  const o = await signup(), mod = await signup(), bad = await signup(), rep = await signup(), bystander = await signup(), boss = await platformAdmin();
  await team(o, mod, bad, rep, bystander);
  const c = await community(o);
  for (const u of [mod, bad, rep, bystander]) must(await api('POST', `/communities/${c.slug}/join`, { token: u.token }), 201);
  must(await api('POST', `/communities/${c.slug}/members/${mod.id}`, { token: o.token, body: { action: 'make_moderator' } }));
  const p = await post(bad, c.slug, 'buy cheap followers now');
  assert.equal((await api('POST', '/social/reports', { token: bad.token, body: { target_type: 'community_post', target_id: p.id, reason: 'spam' } })).status, 409, 'your own post');
  const r = must(await api('POST', '/social/reports', { token: rep.token, body: { target_type: 'community_post', target_id: p.id, reason: 'spam', note: 'obvious spam' } }), 201);
  assert.equal(must(await api('POST', '/social/reports', { token: rep.token, body: { target_type: 'community_post', target_id: p.id, reason: 'spam' } }), 201).id, r.id, 'one report per target');
  assert.equal((await pool.query('SELECT note_enc LIKE $2 AS enc FROM social_reports WHERE id=$1', [r.id, 'v%'])).rows[0].enc, true, 'the note is encrypted');
  // queues: bystanders see none; the moderator sees their community; the admin sees all
  assert.equal((await api('GET', '/social/reports', { token: bystander.token })).status, 403);
  const q = must(await api('GET', '/social/reports', { token: mod.token, query: { include_content: true } }));
  assert.equal(q.items.length, 1); assert.equal(q.items[0].content, 'buy cheap followers now');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_reported_content' AND actor_id=$1", [mod.id])).rowCount >= 1, 'reading reported text is audit-logged');
  assert.equal(JSON.stringify(q).includes('obvious spam'), false, "the reporter's note is never shown");
  assert.ok(must(await api('GET', '/social/reports', { token: boss.token })).items.some((x) => x.id === r.id));
  // a decision needs a reason; outsiders and the reported person cannot decide
  assert.equal((await api('PATCH', `/social/reports/${r.id}`, { token: mod.token, body: { outcome: 'hidden' } })).status, 400);
  assert.equal((await api('PATCH', `/social/reports/${r.id}`, { token: bad.token, body: { outcome: 'dismissed', reason: 'it is fine really' } })).status, 404, 'the reported person is not staff');
  assert.equal((await api('PATCH', `/social/reports/${r.id}`, { token: bystander.token, body: { outcome: 'dismissed', reason: 'not my business' } })).status, 404);
  must(await api('PATCH', `/social/reports/${r.id}`, { token: mod.token, body: { outcome: 'hidden', reason: 'Advertising is not allowed here' } }));
  assert.equal((await api('PATCH', `/social/reports/${r.id}`, { token: mod.token, body: { outcome: 'dismissed', reason: 'changed my mind' } })).status, 409, 'decided once');
  assert.ok(!(await feed(rep, c.slug)).items.some((x) => x.id === p.id), 'hidden');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='moderation_decision'", [bad.id])).rows[0].n, 1, 'the person is told');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='moderation_decision'", [rep.id])).rows[0].n, 1, 'the reporter is told');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='decide_social_report' AND actor_id=$1", [mod.id])).rowCount === 1);
  assert.equal((await pool.query('SELECT decision_reason_enc LIKE $2 AS enc FROM social_reports WHERE id=$1', [r.id, 'v%'])).rows[0].enc, true);
  // appeal: only the person concerned, once, as a support case
  assert.equal((await api('POST', `/social/reports/${r.id}/appeal`, { token: rep.token, body: { statement: 'I am not the author at all' } })).status, 404);
  const ap = must(await api('POST', `/social/reports/${r.id}/appeal`, { token: bad.token, body: { statement: 'This was a club sponsor announcement, agreed with the owner.' } }), 201);
  assert.equal(ap.category, 'moderation_appeal');
  assert.equal((await api('POST', `/social/reports/${r.id}/appeal`, { token: bad.token, body: { statement: 'Appealing a second time again' } })).status, 409);
  assert.ok(must(await api('GET', '/me/cases', { token: bad.token })).some((x) => x.case_no === ap.case_no), 'the appeal shows in their cases');
  // upheld: the platform admin overturns, the post is back and the person is told
  assert.equal((await api('POST', `/social/reports/${r.id}/overturn`, { token: mod.token, body: { reason: 'I am only a moderator' } })).status, 403);
  must(await api('POST', `/social/reports/${r.id}/overturn`, { token: boss.token, body: { reason: 'Agreed sponsorship, appeal upheld' } }));
  assert.ok((await feed(rep, c.slug)).items.some((x) => x.id === p.id), 'visible again');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND title='Your appeal was upheld'", [bad.id])).rows[0].n, 1);
  // silence outcome
  const p2 = await post(bad, c.slug, 'more spam');
  const r2 = must(await api('POST', '/social/reports', { token: rep.token, body: { target_type: 'community_post', target_id: p2.id, reason: 'spam' } }), 201);
  must(await api('PATCH', `/social/reports/${r2.id}`, { token: mod.token, body: { outcome: 'silenced', reason: 'Repeated advertising', silence_minutes: 60 } }));
  assert.equal((await api('POST', `/communities/${c.slug}/posts`, { token: bad.token, body: { text: 'again' } })).status, 403);
});

test('rate limits: posts, comments and messages answer 429', async () => {
  const o = await signup(), a = await signup();
  await team(o, a);
  const c = await community(o);
  const before = LIMITS.postsPerHour; LIMITS.postsPerHour = 2;
  await post(o, c.slug, 'one'); await post(o, c.slug, 'two');
  assert.equal((await api('POST', `/communities/${c.slug}/posts`, { token: o.token, body: { text: 'three' } })).status, 429);
  LIMITS.postsPerHour = before;
  const conv = must(await api('POST', '/conversations', { token: o.token, body: { kind: 'direct', user_id: a.id, body: 'first' } }), 201);
  conv.id = conv.conversation_id;
  must(await api('POST', `/conversations/${conv.id}/messages`, { token: o.token, body: { body: 'second' } }), 201);
  must(await api('POST', `/conversations/${conv.id}/messages`, { token: o.token, body: { body: 'third' } }), 201);
  assert.equal((await api('POST', `/conversations/${conv.id}/messages`, { token: o.token, body: { body: 'fourth' } })).status, 429);
  // a retried send (same client_id) is a replay, not a new message
  const first = must(await api('POST', `/conversations/${conv.id}/messages`, { token: a.token, body: { body: 'reply', client_id: 'retry-key-0001' } }), 201);
  const again = must(await api('POST', `/conversations/${conv.id}/messages`, { token: a.token, body: { body: 'reply', client_id: 'retry-key-0001' } }), 201);
  assert.equal(again.id, first.id, 'the retry returns the same message');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id=$1 AND client_id='retry-key-0001'", [conv.id])).rows[0].n, 1);
});

test('retention archives old community content (never deletes) and keeps content under an open report', async () => {
  const o = await signup(), a = await signup();
  const c = await community(o);
  must(await api('POST', `/communities/${c.slug}/join`, { token: a.token }), 201);
  const old = await post(a, c.slug, 'old post'), reported = await post(a, c.slug, 'old but reported'), fresh = await post(a, c.slug, 'fresh');
  const rep = await signup(); must(await api('POST', `/communities/${c.slug}/join`, { token: rep.token }), 201);
  must(await api('POST', '/social/reports', { token: rep.token, body: { target_type: 'community_post', target_id: reported.id, reason: 'other' } }), 201);
  await pool.query("UPDATE market_posts SET created_at = now() - interval '800 days' WHERE id = ANY($1)", [[old.id, reported.id]]);
  const r = await archiveStaleCommunityContent();
  assert.equal(r.posts, 1);
  assert.ok((await pool.query('SELECT archived_at FROM market_posts WHERE id=$1', [old.id])).rows[0].archived_at);
  assert.equal((await pool.query('SELECT archived_at FROM market_posts WHERE id=$1', [reported.id])).rows[0].archived_at, null);
  assert.equal((await pool.query('SELECT archived_at FROM market_posts WHERE id=$1', [fresh.id])).rows[0].archived_at, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM market_posts WHERE id=$1', [old.id])).rows[0].n, 1, 'the row is kept');
});

test('notification choices group social kinds onto the existing muted list', async () => {
  const u = await signup();
  assert.deepEqual(must(await api('GET', '/me/notification-preferences', { token: u.token })).social_categories, { people: true, communities: true, comments: true });
  const r = must(await api('PATCH', '/me/notification-preferences', { token: u.token, body: { social_categories: { communities: false } } }));
  assert.equal(r.social_categories.communities, false); assert.equal(r.social_categories.people, true);
  assert.ok(r.muted_kinds.includes('community_invite'));
  const o = await signup(); await team(o, u);
  const c = await community(o, { visibility: 'private', join_mode: 'invite' });
  must(await api('POST', `/communities/${c.slug}/invitations`, { token: o.token, body: { user_id: u.id } }), 201);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='community_invite'", [u.id])).rows[0].n, 0, 'switched off');
  const back = must(await api('PATCH', '/me/notification-preferences', { token: u.token, body: { social_categories: { communities: true } } }));
  assert.equal(back.social_categories.communities, true);
});

test('every community capability is a REST route, an OpenAPI operation and an MCP tool, and needs sign-in', async () => {
  const names = ['create_community', 'list_communities', 'get_community', 'update_community', 'archive_community', 'join_community', 'leave_community', 'list_community_members', 'decide_community_member',
    'invite_to_community', 'list_my_community_invitations', 'respond_community_invitation', 'post_to_community', 'list_community_feed', 'remove_community_post', 'appeal_moderation_decision', 'overturn_moderation_decision'];
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  const u = await signup();
  const tools = (await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${u.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json()).result.tools.map((t) => t.name);
  for (const nme of names) {
    const c = capabilities.find((x) => x.name === nme);
    assert.ok(c, `${nme} is a capability`); assert.ok(ops.has(nme), `${nme} is in OpenAPI`); assert.ok(tools.includes(nme), `${nme} is an MCP tool`);
    assert.notEqual(c.auth, 'public', `${nme} needs a signed-in user`);
  }
  assert.equal((await api('GET', '/communities')).status, 401);
  assert.equal((await api('GET', '/communities/some-club/feed')).status, 401);
  assert.equal((await api('POST', '/communities', { body: { name: 'Anon club' } })).status, 401);
  // existing records survive: a marketplace post and a social report written before this feature still read normally
  const p = must(await api('POST', '/market/posts', { token: u.token, body: { kind: 'wanted', title: 'Striker wanted', body: 'plain old post' } }), 201);
  assert.equal(must(await api('GET', `/market/posts/${p.id}`, { token: u.token })).body, 'plain old post');
});
