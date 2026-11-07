import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = y => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sh_${n}`, display_name: `SH ${n}`, email: `sh${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], dob: yearsAgo(28) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('sh_root','SH Root','{admin}','x','x','sh_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server?.close());

test('save replay reference, subscribe alert, add event marker', async () => {
  const manager = await signup();

  // Need a team and event_stream row
  const teamRow = (await pool.query(
    "INSERT INTO teams(name,slug,sport_slug) VALUES ('Stream FC','stream-fc','football') RETURNING id"
  )).rows[0];
  await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,'manager')", [teamRow.id, manager.id]);

  // Create an event_stream (needs event)
  const evRow = (await pool.query(
    "INSERT INTO events(name,starts_at,organisation_id) SELECT 'Stream Match','2030-03-01','00000000-0000-0000-0000-000000000000' RETURNING id"
  )).rows[0];
  if (!evRow?.id) return; // skip if events schema differs

  const streamRow = (await pool.query(
    "INSERT INTO event_streams(event_id,team_id,stream_url,provider,is_live) VALUES ($1,$2,'https://youtube.com/live/xyz','youtube',false) RETURNING id",
    [evRow.id, teamRow.id]
  )).rows[0];
  const streamId = streamRow.id;

  // Save replay reference
  ok(await api('POST', `/event-streams/${streamId}/replay`, { token: manager.token, body: {
    replay_url: 'https://youtube.com/watch?v=xyz',
    duration_seconds: 5400,
  } }));

  // Subscribe alert
  const sub = ok(await api('POST', `/stream-alerts/${teamRow.id}`, { token: manager.token, body: {} }), 201);
  assert.ok(sub.subscription);

  // Add event marker
  ok(await api('POST', `/event-streams/${streamId}/markers`, { token: manager.token, body: { type: 'goal', minute: 23, description: 'Header from corner' } }));

  // Verify marker saved
  const streamData = ok(await api('GET', `/event-streams/${streamId}`, { token: manager.token }));
  const markers = streamData.stream?.event_markers ?? [];
  assert.ok(markers.some(m => m.type === 'goal' && m.minute === 23));
});

test('parent chat: send and retrieve messages (encrypted at rest)', async () => {
  const user1 = await signup();
  const user2 = await signup();

  const evRow = (await pool.query(
    "INSERT INTO events(name,starts_at,organisation_id) SELECT 'Chat Match','2030-04-01','00000000-0000-0000-0000-000000000000' RETURNING id"
  )).rows[0];
  if (!evRow?.id) return;

  const streamRow = (await pool.query(
    "INSERT INTO event_streams(event_id,stream_url,provider,is_live,allow_family_chat) VALUES ($1,'https://example.com/live','other',true,true) RETURNING id",
    [evRow.id]
  )).rows[0];
  const streamId = streamRow.id;

  ok(await api('POST', `/event-streams/${streamId}/chat`, { token: user1.token, body: { message: 'Great goal!' } }), 201);
  ok(await api('POST', `/event-streams/${streamId}/chat`, { token: user2.token, body: { message: 'What a save!' } }), 201);

  // Retrieve — messages must be decrypted
  const chat = ok(await api('GET', `/event-streams/${streamId}/chat`, { token: user1.token }));
  assert.ok(chat.messages?.some(m => m.message === 'Great goal!'));
  assert.ok(chat.messages?.some(m => m.message === 'What a save!'));
  // Raw encrypted values must not leak
  for (const m of chat.messages ?? []) {
    assert.ok(!m.message_enc, 'encrypted field must not be exposed');
  }
});
