import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---- a stand-in for the OpenWA gateway ----
const owa = { sent: [], sessions: [], mode: 'ok' };
const owaServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers['x-api-key'] !== 'test-key') return json(401, { message: 'bad key' });
  const m = req.url.match(/^\/api\/sessions(?:\/([^/]+)(?:\/(.*))?)?$/);
  if (req.method === 'POST' && !m[1]) { const s = { id: `sess-${owa.sessions.length + 1}`, name: body.name, status: 'created' }; owa.sessions.push(s); return json(201, s); }
  if (m[2] === 'start') return json(201, { id: m[1], status: 'initializing' });
  if (m[2] === 'qr') return json(200, { qrCode: 'data:image/png;base64,AAAA', status: 'qr_ready' });
  if (m[2] === 'messages/send-text') {
    if (owa.mode === 'down') return json(503, { message: 'down' });
    owa.sent.push({ session: m[1], idem: req.headers['idempotency-key'], ...body });
    return json(201, { id: 'm1' });
  }
  if (!m[2]) return json(200, { id: m[1], status: 'ready', phone: '15550001111' });
  return json(404, {});
});
await new Promise((r) => owaServer.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
  OPENWA_URL: `http://127.0.0.1:${owaServer.address().port}`, OPENWA_API_KEY: 'test-key', OPENWA_DEFAULT_SESSION: 'default-sess', WHATSAPP_MIN_GAP_MS: '0',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { notify } = await import('../src/notify.js');
const { dispatchWhatsapp, normalizePhone, whatsappKind } = await import('../src/whatsapp.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `wa_${n}_a`, display_name: `Wa ${n}`, email: `wa${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const lastCode = () => owa.sent.at(-1).text.match(/code is (\d{6})/)[1];
const optIn = async (u, phone) => {
  must(await api('POST', '/me/whatsapp/verify', { token: u.token, body: { phone } }));
  must(await api('POST', '/me/whatsapp/confirm', { token: u.token, body: { code: lastCode() } }));
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); owaServer.close(); await pool.end(); });

test('phone numbers need a country code; only an allow-list of kinds is ever sent', () => {
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210');
  assert.equal(normalizePhone('0044 7700 900123'), '447700900123');
  assert.equal(normalizePhone('9876543210'), null, 'no country code, no guessing');
  assert.equal(normalizePhone('+12'), null);
  for (const k of ['booking_modified', 'team_invite', 'event_invitation']) assert.ok(whatsappKind(k), k);
  for (const k of ['security_password_reset', 'security_email_verify', 'appointment_reminder', 'followup_reminder', 'quote_message', 'payout_paid', 'something_new']) assert.ok(!whatsappKind(k), k);
});

test('verify a number by a code on WhatsApp, then switch it on', async () => {
  const u = await signup();
  assert.equal((await api('POST', '/me/whatsapp/verify', { body: { phone: '+919876543210' } })).status, 401);
  assert.equal((await api('POST', '/me/whatsapp/verify', { token: u.token, body: { phone: '9876543210' } })).status, 400);
  assert.equal(must(await api('GET', '/me/whatsapp', { token: u.token })).state, 'none');
  assert.equal((await api('PATCH', '/me/notification-preferences', { token: u.token, body: { whatsapp: true } })).status, 400, 'cannot switch on an unverified number');

  must(await api('POST', '/me/whatsapp/verify', { token: u.token, body: { phone: '+91 98765 43210' } }));
  assert.equal(owa.sent.at(-1).chatId, '919876543210@c.us');
  assert.equal((await api('POST', '/me/whatsapp/verify', { token: u.token, body: { phone: '+919876543210' } })).status, 429, 'one code a minute');
  const st = must(await api('GET', '/me/whatsapp', { token: u.token }));
  assert.equal(st.state, 'pending_code');
  assert.ok(!JSON.stringify(st).includes('9876543210'), 'the number is masked');
  const stored = (await pool.query('SELECT phone_enc FROM whatsapp_contacts WHERE user_id=$1', [u.id])).rows[0].phone_enc;
  assert.ok(!stored.includes('9876543210'), 'encrypted at rest');

  const code = lastCode();
  assert.equal((await api('POST', '/me/whatsapp/confirm', { token: u.token, body: { code: code === '000000' ? '111111' : '000000' } })).status, 400);
  must(await api('POST', '/me/whatsapp/confirm', { token: u.token, body: { code } }));
  assert.equal(must(await api('GET', '/me/whatsapp', { token: u.token })).state, 'verified');
  assert.equal(must(await api('GET', '/me/notification-preferences', { token: u.token })).whatsapp, true);
});

test('too many wrong codes lock the code out', async () => {
  const u = await signup();
  must(await api('POST', '/me/whatsapp/verify', { token: u.token, body: { phone: '+447700900111' } }));
  const good = lastCode(), bad = good === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/me/whatsapp/confirm', { token: u.token, body: { code: bad } })).status, 400);
  assert.equal((await api('POST', '/me/whatsapp/confirm', { token: u.token, body: { code: good } })).status, 429);
});

test('notifications reach WhatsApp only for opted-in people and allowed kinds, from the platform number by default', async () => {
  const on = await signup(), off = await signup();
  await optIn(on, '+14155550101');
  owa.sent.length = 0;
  await notify(null, on.id, { kind: 'team_invite', title: 'Team invite', body: 'Join Tigers' });
  await notify(null, on.id, { kind: 'security_password_reset', title: 'Reset', body: 'secret link' });
  await notify(null, on.id, { kind: 'followup_reminder', title: 'Health', body: 'clinic' });
  await notify(null, off.id, { kind: 'team_invite', title: 'Team invite', body: 'Join Tigers' });
  const rows = (await pool.query("SELECT n.user_id, n.kind FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.channel='whatsapp'")).rows;
  assert.deepEqual(rows.filter((r) => r.user_id === on.id).map((r) => r.kind), ['team_invite']);
  assert.equal(rows.filter((r) => r.user_id === off.id).length, 0);

  const r = await dispatchWhatsapp();
  assert.equal(r.sent, 1);
  const m = owa.sent.at(-1);
  assert.equal(m.chatId, '14155550101@c.us');
  assert.match(m.text, /Team invite/);
  assert.ok(m.idem, 'retries are idempotent');
  assert.equal(m.session, 'default-sess', 'no platform number linked yet: the configured default session is used');
});

test('platform number, dedicated numbers per owner, revoke falls back', async () => {
  const adm = await signup();
  await pool.query("UPDATE users SET roles='{admin}' WHERE id=$1", [adm.id]);
  const plain = await signup();
  assert.equal((await api('GET', '/admin/whatsapp/senders', { token: plain.token })).status, 403);

  const platform = must(await api('POST', '/admin/whatsapp/senders', { token: adm.token, body: { label: 'Sportarena' } }), 201);
  assert.ok(platform.qr.startsWith('data:image'));
  assert.equal((await api('POST', '/admin/whatsapp/senders', { token: adm.token, body: { label: 'again' } })).status, 409, 'one platform number');
  const orgId = '11111111-1111-4111-8111-111111111111';
  assert.equal((await api('POST', '/admin/whatsapp/senders', { token: adm.token, body: { label: 'x', scope_kind: 'event' } })).status, 400, 'scope needs its id');
  const own = must(await api('POST', '/admin/whatsapp/senders', { token: adm.token, body: { label: 'Summer Cup', scope_kind: 'event', scope_id: orgId } }), 201);
  const list = must(await api('GET', '/admin/whatsapp/senders', { token: adm.token }));
  assert.equal(list.items.length, 2);
  assert.equal(must(await api('GET', `/admin/whatsapp/senders/${own.id}/qr`, { token: adm.token })).status, 'ready');

  const u = await signup();
  await optIn(u, '+14155550102');
  assert.equal(owa.sent.at(-1).session, platform.openwa_session, 'codes come from the platform number');
  await notify(null, u.id, { kind: 'event_announcement', title: 'Final', body: 'Kick-off at 5', data: { sender_scope: { kind: 'event', id: orgId } } });
  await notify(null, u.id, { kind: 'event_announcement', title: 'Other', body: 'No scope' });
  await dispatchWhatsapp();
  assert.deepEqual(owa.sent.slice(-2).map((m) => m.session), [own.openwa_session, platform.openwa_session]);

  must(await api('DELETE', `/admin/whatsapp/senders/${own.id}`, { token: adm.token }));
  await notify(null, u.id, { kind: 'event_announcement', title: 'After', body: 'revoked' });
  await dispatchWhatsapp();
  assert.equal(owa.sent.at(-1).session, platform.openwa_session, 'a revoked number falls back to the platform number');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM whatsapp_senders')).rows[0].n, 2, 'revoked numbers are kept');
});

test('a failing gateway backs off and retries; opting out stops messages without deleting the number', async () => {
  const u = await signup();
  await optIn(u, '+14155550103');
  owa.mode = 'down';
  await notify(null, u.id, { kind: 'booking_modified', title: 'Moved', body: 'New time' });
  const r = await dispatchWhatsapp();
  assert.equal(r.failed, 1);
  const d = (await pool.query("SELECT d.status, d.attempts, d.next_attempt_at FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=$1 AND d.channel='whatsapp'", [u.id])).rows[0];
  assert.equal(d.status, 'pending'); assert.equal(d.attempts, 1); assert.ok(d.next_attempt_at > new Date());
  owa.mode = 'ok';
  await pool.query("UPDATE notification_deliveries SET next_attempt_at=NULL WHERE channel='whatsapp'");
  must(await api('DELETE', '/me/whatsapp', { token: u.token }));
  const before = owa.sent.length;
  assert.equal((await dispatchWhatsapp()).sent, 0);
  assert.equal(owa.sent.length, before, 'nothing is sent after opting out');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM whatsapp_contacts WHERE user_id=$1', [u.id])).rows[0].n, 1, 'number kept on file');
  assert.equal(must(await api('GET', '/me/whatsapp', { token: u.token })).state, 'opted_out');
  await notify(null, u.id, { kind: 'booking_modified', title: 'Again', body: 'x' });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=$1 AND d.channel='whatsapp' AND n.title='Again'", [u.id])).rows[0].n, 0);
});

test('under-18 accounts are never messaged', async () => {
  const u = await signup();
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [u.id]);
  assert.equal((await api('POST', '/me/whatsapp/verify', { token: u.token, body: { phone: '+14155550104' } })).status, 422);
});
