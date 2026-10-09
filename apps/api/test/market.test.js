import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.MEDIA_DIR = process.env.MEDIA_DIR ?? `${process.env.TMPDIR ?? '/tmp'}/sa-market-test-media`;
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/capabilities/index.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const self = roles.filter((x) => x !== 'admin'); if (!self.length) self.push('athlete');
  const r = await api('POST', '/auth/register', { body: { handle: `mk_${n}_${roles[0]}`, display_name: `Market ${n}`, email: `mk${n}@example.com`, password: 'correct-horse-battery', roles: self } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (roles.includes('admin')) await pool.query("UPDATE users SET roles = roles || '{admin}' WHERE id=$1", [r.body.user.id]); // admin cannot be self-assigned
  return { ...r.body.user, token: r.body.token };
};
const in1d = new Date(Date.now() + 864e5).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('visitors see public cards with the author redacted; members-only needs a login', async () => {
  const poster = await signup(['organizer']);
  const pub = await api('POST', '/market/posts', { token: poster.token, body: { kind: 'wanted', title: 'Athletes wanted for relay championship', body: '4x100m squad', positions: 4 } });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  const priv = await api('POST', '/market/posts', { token: poster.token, body: { kind: 'announcement', title: 'Members only note', visibility: 'members' } });

  const anon = await api('GET', '/market/posts');
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.body.map((p) => p.id), [pub.body.id]);
  const card = anon.body[0];
  assert.equal(card.author.display_name, poster.display_name);
  assert.equal(card.author.id, undefined);
  assert.equal(card.author.handle, undefined);
  assert.ok(card.login_required_for.includes('apply'));

  assert.equal((await api('GET', `/market/posts/${priv.body.id}`)).status, 401);
  const member = await signup(['athlete']);
  const seen = await api('GET', '/market/posts', { token: member.token });
  assert.equal(seen.body.length, 2);
  assert.equal(seen.body[0].author.handle, poster.handle);
});

test('reacting, commenting and applying require login; applying notifies the poster who can decide', async () => {
  const poster = await signup(['organizer']);
  const athlete = await signup(['athlete']);
  const post = (await api('POST', '/market/posts', { token: poster.token, body: { kind: 'wanted', title: 'Relay anchor leg wanted' } })).body;
  for (const [m, p] of [['POST', 'react'], ['POST', 'apply'], ['POST', 'comments']]) assert.equal((await api(m, `/market/posts/${post.id}/${p}`, { body: { body: 'x' } })).status, 401);

  const r1 = await api('POST', `/market/posts/${post.id}/react`, { token: athlete.token });
  assert.deepEqual([r1.body.reacted, r1.body.reactions], [true, 1]);
  const r2 = await api('POST', `/market/posts/${post.id}/react`, { token: athlete.token });
  assert.deepEqual([r2.body.reacted, r2.body.reactions], [false, 0]);

  assert.equal((await api('POST', `/market/posts/${post.id}/apply`, { token: poster.token, body: {} })).status, 400, 'cannot apply to your own post');
  const ap = await api('POST', `/market/posts/${post.id}/apply`, { token: athlete.token, body: { message: 'I run 10.9s' } });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  assert.equal((await api('POST', `/market/posts/${post.id}/apply`, { token: athlete.token, body: {} })).status, 409);
  const inbox = await api('GET', '/notifications', { token: poster.token });
  assert.ok(inbox.body.items.some((x) => x.kind === 'market_application'));

  assert.equal((await api('GET', `/market/posts/${post.id}/applications`, { token: athlete.token })).status, 403);
  const leads = await api('GET', `/market/posts/${post.id}/applications`, { token: poster.token });
  assert.equal(leads.body.length, 1);
  const d = await api('POST', `/market/applications/${leads.body[0].id}/decide`, { token: poster.token, body: { decision: 'accepted' } });
  assert.equal(d.body.status, 'accepted');
  const mine = await api('GET', '/market/applications', { token: athlete.token });
  assert.equal(mine.body[0].status, 'accepted');

  const cm = await api('POST', `/market/posts/${post.id}/comments`, { token: athlete.token, body: { body: 'Count me in' } });
  assert.equal(cm.status, 201);
  assert.equal((await api('GET', `/market/posts/${post.id}/comments`, { token: poster.token })).body.length, 1);
});

test('paid campaigns stay hidden until an admin approves them, and only show inside the window', async () => {
  const advertiser = await signup(['sponsor']);
  const admin = await signup(['admin']);
  const visitor = await signup(['athlete']);
  const ad = (await api('POST', '/market/posts', { token: advertiser.token, body: { kind: 'campaign', title: 'Volt summer campaign', sponsored: true } })).body;
  assert.equal(ad.sponsor_status, 'pending');
  const ids = async (token) => (await api('GET', '/market/posts', { token })).body.map((p) => p.id);
  assert.ok(!(await ids()).includes(ad.id));
  assert.ok(!(await ids(visitor.token)).includes(ad.id));
  assert.ok((await ids(advertiser.token)).includes(ad.id));

  assert.equal((await api('POST', `/market/posts/${ad.id}/review`, { token: advertiser.token, body: { decision: 'approved', promo_ends_at: in1d } })).status, 403);
  const rq = await api('GET', '/market/sponsored/requests', { token: admin.token }); assert.equal(rq.body.length, 1, JSON.stringify(rq));
  assert.equal((await api('POST', `/market/posts/${ad.id}/review`, { token: admin.token, body: { decision: 'approved' } })).status, 400, 'needs an end date');
  assert.equal((await api('POST', `/market/posts/${ad.id}/review`, { token: admin.token, body: { decision: 'approved', promo_ends_at: in1d } })).status, 200);
  assert.ok((await ids()).includes(ad.id));
  const hl = await api('GET', '/market/highlights');
  assert.equal(hl.body.featured[0].id, ad.id);
  assert.equal(hl.body.featured[0].sponsored, true);
  const only = await api('GET', '/market/posts?sponsored=true');
  assert.deepEqual(only.body.map((p) => p.id), [ad.id]);

  await pool.query("UPDATE market_posts SET promo_ends_at = now() - interval '1 minute' WHERE id=$1", [ad.id]);
  assert.equal((await api('GET', '/market/posts?sponsored=true')).body.length, 0, 'expired campaigns are no longer sponsored');
  assert.equal((await api('GET', '/market/highlights')).body.featured.length, 0);
});

test('media is uploaded first, attached to a post once, and served publicly', async () => {
  const u = await signup(['organizer']);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)]);
  const up = await fetch(`${base}/api/v1/market/media`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}`, 'content-type': 'image/png' }, body: png });
  assert.equal(up.status, 201);
  const media = await up.json();
  assert.equal((await fetch(`${base}/api/v1/market/media`, { method: 'PUT', body: png })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/market/media`, { method: 'PUT', headers: { authorization: `Bearer ${u.token}` }, body: Buffer.from('not an image at all, plain text') })).status, 400);

  const post = await api('POST', '/market/posts', { token: u.token, body: { kind: 'sale', title: 'Cricket kit for sale', price_cents: 250000, media_ids: [media.id] } });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  const other = await signup(['athlete']);
  assert.equal((await api('POST', '/market/posts', { token: other.token, body: { kind: 'sale', title: 'Stolen upload', media_ids: [media.id] } })).status, 400);
  const card = (await api('GET', `/market/posts/${post.body.id}`)).body;
  assert.equal(card.media.length, 1);
  const file = await fetch(`${base}${card.media[0].url}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
});

test('posts are archived, never deleted; marketplace capabilities exist in REST, OpenAPI and MCP', async () => {
  const u = await signup(['organizer']);
  const p = (await api('POST', '/market/posts', { token: u.token, body: { kind: 'match', title: 'Sunday friendly', starts_at: in1d } })).body;
  assert.equal((await api('POST', `/market/posts/${p.id}/archive`, { token: u.token })).status, 200);
  assert.equal((await api('GET', `/market/posts/${p.id}`)).status, 404);
  assert.equal((await pool.query('SELECT 1 FROM market_posts WHERE id=$1', [p.id])).rowCount, 1);
  const spec = (await api('GET', '/openapi.json')).body;
  assert.ok(spec.paths['/market/posts']);
  assert.ok(capabilities.some((c) => c.name === 'list_market_posts' && c.auth === 'public'));
});

test('any account can set, see and remove a profile photo; photos only, never deleted', async () => {
  const u = await signup(['athlete']);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)]);
  const put = (token, body) => fetch(`${base}/api/v1/me/avatar`, { method: 'PUT', headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  assert.equal((await put(null, png)).status, 401);
  assert.equal((await put(u.token, Buffer.from('not an image at all, plain text'))).status, 400);
  assert.equal((await put(u.token, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]))).status, 400, 'GIFs are not profile photos');
  const up = await put(u.token, png);
  assert.equal(up.status, 201);
  const { avatar_url } = await up.json();
  assert.match(avatar_url, /^\/api\/v1\/market\/media\//);
  assert.equal((await fetch(`${base}${avatar_url}`)).status, 200);
  assert.equal((await api('GET', '/me', { token: u.token })).body.avatar_url, avatar_url);
  assert.equal((await api('GET', `/people/${u.id}`, { token: u.token })).body.avatar_url, avatar_url);
  // photo uploads don't eat the 20-per-user allowance for post media
  for (let i = 0; i < 3; i++) assert.equal((await put(u.token, png)).status, 201);
  assert.equal((await api('DELETE', '/me/avatar', { token: u.token })).status, 200);
  assert.equal((await api('GET', '/me', { token: u.token })).body.avatar_url, null);
  assert.equal((await fetch(`${base}${avatar_url}`)).status, 200, 'the old file is kept');
});
