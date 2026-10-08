import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';

// ---- a stand-in for the Expo push service ----
const expo = { received: [], mode: 'ok' };
const expoServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const msgs = JSON.parse(Buffer.concat(chunks).toString());
  expo.received.push(...msgs);
  if (expo.mode === 'down') { res.writeHead(503).end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: msgs.map(() => (expo.mode === 'gone' ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'r1' })) }));
});
await new Promise((r) => expoServer.listen(0, '127.0.0.1', r));
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  EXPO_PUSH_URL: `http://127.0.0.1:${expoServer.address().port}/send`, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { senders, dispatchPush } = await import('../src/push.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async () => { n++; const r = await api('POST', '/auth/register', { body: { handle: `pu_${n}_a`, display_name: `Push ${n}`, email: `pu${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'] } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };
const tok = () => `ExponentPushToken[${randomBytes(8).toString('hex')}]`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); expoServer.close(); await pool.end(); });

test('devices: register phones and browsers, validate, move between accounts, soft remove', async () => {
  const cfg = must(await api('GET', '/push/config'));
  assert.equal(cfg.web_public_key, vapid.publicKey);
  const a = await signup(), b = await signup();
  assert.equal((await api('POST', '/me/push-devices', { body: { provider: 'expo', platform: 'ios', token: tok() } })).status, 401);
  assert.equal((await api('POST', '/me/push-devices', { token: a.token, body: { provider: 'expo', platform: 'ios', token: 'not-an-expo-token-at-all' } })).status, 400);
  const t = tok();
  const d = must(await api('POST', '/me/push-devices', { token: a.token, body: { provider: 'expo', platform: 'ios', token: t, label: 'My iPhone' } }), 201);
  assert.equal(must(await api('GET', '/me/push-devices', { token: a.token })).length, 1);
  assert.ok(!JSON.stringify(must(await api('GET', '/me/push-devices', { token: a.token }))).includes(t), 'tokens are never echoed back');

  // the same phone signs in as someone else: the registration moves
  must(await api('POST', '/me/push-devices', { token: b.token, body: { provider: 'expo', platform: 'ios', token: t } }), 201);
  assert.equal(must(await api('GET', '/me/push-devices', { token: a.token })).length, 0);
  assert.equal(must(await api('GET', '/me/push-devices', { token: b.token })).length, 1);

  // browsers: only real push services, keys required and stored encrypted
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') };
  const web = (endpoint, k = keys) => api('POST', '/me/push-devices', { token: a.token, body: { provider: 'webpush', platform: 'web', token: endpoint, ...(k ? { keys: k } : {}) } });
  assert.equal((await web('https://evil.example/push/abc')).status, 400, 'no arbitrary URLs');
  assert.equal((await web('http://fcm.googleapis.com/fcm/send/abc')).status, 400, 'https only');
  assert.equal((await web('https://fcm.googleapis.com/fcm/send/abc', null)).status, 400, 'keys needed');
  const w = must(await web('https://fcm.googleapis.com/fcm/send/abcdef'), 201);
  const raw = JSON.stringify((await pool.query('SELECT keys_enc FROM push_devices WHERE id=$1', [w.id])).rows);
  assert.ok(!raw.includes(keys.auth), 'subscription keys are encrypted at rest');

  // removal switches it off, keeps the row
  must(await api('DELETE', `/me/push-devices/${w.id}`, { token: a.token }));
  assert.equal((await api('DELETE', `/me/push-devices/${w.id}`, { token: a.token })).status, 404);
  assert.ok((await pool.query('SELECT disabled_at FROM push_devices WHERE id=$1', [w.id])).rows[0].disabled_at);
  assert.equal((await api('DELETE', `/me/push-devices/${d.id}`, { token: a.token })).status, 404, "not yours (it moved)");
});

test('notifications reach phones: payload, preferences, rejected devices, retries', async () => {
  const u = await signup();
  const t = tok();
  must(await api('POST', '/me/push-devices', { token: u.token, body: { provider: 'expo', platform: 'android', token: t } }), 201);
  expo.received.length = 0;
  assert.equal(must(await api('POST', '/me/push-test', { token: u.token, body: {} })).devices, 1);
  await wait(() => expo.received.length >= 1);
  const m = expo.received.at(-1);
  assert.equal(m.to, t);
  assert.match(m.title, /Push is working/);
  assert.equal(m.data.kind, 'test');
  assert.ok(m.data.notification_id);
  assert.ok((await pool.query("SELECT 1 FROM notification_deliveries WHERE channel='push' AND status='sent'")).rowCount >= 1);

  // switching push off in preferences stops pushes (the inbox still gets it)
  assert.equal(must(await api('PATCH', '/me/notification-preferences', { token: u.token, body: { push: false } })).push, false);
  expo.received.length = 0;
  must(await api('POST', '/me/push-test', { token: u.token, body: {} }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(expo.received.length, 0);
  assert.equal(must(await api('GET', '/notifications', { token: u.token })).items.filter((x) => x.kind === 'test').length, 2);
  must(await api('PATCH', '/me/notification-preferences', { token: u.token, body: { push: true } }));

  // the push service is down: the delivery stays pending and the worker retries it
  expo.mode = 'down'; expo.received.length = 0;
  must(await api('POST', '/me/push-test', { token: u.token, body: {} }));
  await wait(() => expo.received.length >= 1);
  await wait(async () => (await pool.query("SELECT 1 FROM notification_deliveries WHERE channel='push' AND status='pending' AND last_error LIKE '%503%'")).rowCount);
  expo.mode = 'ok'; expo.received.length = 0;
  const r = await dispatchPush();
  assert.equal(r.sent, 1);
  assert.equal(expo.received.length, 1);

  // the phone uninstalled the app: the provider says so and the device is switched off
  expo.mode = 'gone';
  must(await api('POST', '/me/push-test', { token: u.token, body: {} }));
  await wait(async () => must(await api('GET', '/me/push-devices', { token: u.token })).length === 0);
  expo.mode = 'ok';
  assert.ok((await pool.query("SELECT 1 FROM push_devices WHERE token=$1 AND disabled_reason LIKE 'rejected%'", [t])).rowCount);
});

test('browser push: encrypted with the subscription keys and signed with the VAPID key; fan-out to every device', async () => {
  // the encryption path itself (what a real browser would decrypt)
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') } };
  const req = webpush.generateRequestDetails(sub, JSON.stringify({ title: 't', body: 'b' }), { vapidDetails: { subject: 'mailto:a@b.co', publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 60 });
  assert.equal(req.method, 'POST');
  assert.match(req.headers.Authorization, /^vapid /);
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(req.body.length > 50);

  // delivery: one notification fans out to the phone and the browser; a dead browser subscription is switched off
  const u = await signup();
  const phone = tok();
  must(await api('POST', '/me/push-devices', { token: u.token, body: { provider: 'expo', platform: 'ios', token: phone } }), 201);
  must(await api('POST', '/me/push-devices', { token: u.token, body: { provider: 'webpush', platform: 'web', token: 'https://fcm.googleapis.com/fcm/send/live1', keys: sub.keys } }), 201);
  must(await api('POST', '/me/push-devices', { token: u.token, body: { provider: 'webpush', platform: 'web', token: 'https://fcm.googleapis.com/fcm/send/dead1', keys: sub.keys } }), 201);
  const sent = [];
  const original = senders.webpush;
  senders.webpush = async (dev, payload) => { sent.push({ endpoint: dev.token, payload }); return dev.token.endsWith('dead1') ? { gone: true } : { ok: true }; };
  try {
    expo.received.length = 0;
    must(await api('POST', '/me/push-test', { token: u.token, body: {} }));
    await wait(() => sent.length >= 2 && expo.received.length >= 1);
    assert.deepEqual(sent.map((s) => s.endpoint.split('/').pop()).sort(), ['dead1', 'live1']);
    assert.equal(sent[0].payload.data.kind, 'test');
    await wait(async () => must(await api('GET', '/me/push-devices', { token: u.token })).length === 2);
  } finally { senders.webpush = original; }
});
