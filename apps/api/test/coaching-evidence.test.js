import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { config } = await import('../src/config.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const raw = async (method, path, token, bytes, type = 'image/png') => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: bytes });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: r.status, buf, json };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ce_${n}_${roles[0]}`, display_name: `CE Person${n}`, email: `ce${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body ?? r.json)); return r.body ?? r.json; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from('EVIDENCE-PIXELS-1234567890')]);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { config.transcribe.url = undefined; server.close(); await pool.end(); });

const setup = async () => {
  const coach = await signup(['coach']), assistant = await signup(['coach']), outsider = await signup(['coach']), a = await signup(['athlete']), b = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Ev FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active')", [team.id, assistant.id]);
  for (const p of [a, b]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, p.id]);
  const note = async (visibility, extra = {}) => ok(await post(coach.token, '/coaching/observations', { athlete_id: a.id, team_id: team.id, note: 'with a clip', visibility, ...extra }), 201);
  return { coach, assistant, outsider, a, b, team, note };
};

test('evidence is readable by exactly the people who can read the note, and follows the note\'s visibility live', async () => {
  const s = await setup();
  const o = await s.note('coach_private');
  const up = await raw('PUT', `/coaching/observations/${o.id}/evidence?title=Clip`, s.coach.token, PNG);
  assert.equal(up.status, 201); assert.equal(up.json.kind, 'photo');
  const url = `/coaching/evidence/${up.json.id}/file`;
  const fetchFile = (t) => raw('GET', url, t.token);
  assert.deepEqual((await fetchFile(s.coach)).buf, PNG, 'the author gets the exact bytes back');
  for (const who of [s.assistant, s.a, s.b, s.outsider]) assert.equal((await fetchFile(who)).status, 404, 'private note: nobody else');
  assert.equal((await get(s.a.token, `/coaching/observations/${o.id}/evidence`)).status, 404);
  // share with the player
  ok(await api('PATCH', `/coaching/observations/${o.id}`, { token: s.coach.token, body: { row_version: 1, visibility: 'player' } }));
  assert.equal((await fetchFile(s.a)).status, 200); assert.equal((await fetchFile(s.b)).status, 404); assert.equal((await fetchFile(s.assistant)).status, 404);
  assert.equal(ok(await get(s.a.token, `/coaching/observations/${o.id}/evidence`)).length, 1);
  // staff only
  ok(await api('PATCH', `/coaching/observations/${o.id}`, { token: s.coach.token, body: { row_version: 2, visibility: 'staff' } }));
  assert.equal((await fetchFile(s.assistant)).status, 200); assert.equal((await fetchFile(s.a)).status, 404, 'taking the share back hides the file at once');
  // back to private, then removal keeps the file on disk but hides it
  ok(await api('PATCH', `/coaching/observations/${o.id}`, { token: s.coach.token, body: { row_version: 3, visibility: 'coach_private' } }));
  assert.equal((await fetchFile(s.assistant)).status, 404);
  ok(await api('DELETE', `/coaching/evidence/${up.json.id}`, { token: s.coach.token }));
  assert.equal((await fetchFile(s.coach)).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_evidence WHERE id=$1', [up.json.id])).rows[0].n, 1, 'the row is kept');
  assert.equal((await api('DELETE', `/coaching/evidence/${up.json.id}`, { token: s.outsider.token })).status, 404);
});

test('uploads: only the author with a current relationship, real file types only, size and count limits', async () => {
  const s = await setup();
  const o = await s.note('coach_private');
  assert.equal((await raw('PUT', `/coaching/observations/${o.id}/evidence`, s.outsider.token, PNG)).status, 404, 'not your note');
  assert.equal((await raw('PUT', `/coaching/observations/${o.id}/evidence`, s.assistant.token, PNG)).status, 404, 'another coach cannot add to your note');
  assert.equal((await raw('PUT', `/coaching/observations/${o.id}/evidence`, s.a.token, PNG)).status, 404);
  assert.equal((await raw('PUT', `/coaching/observations/${o.id}/evidence`, s.coach.token, Buffer.from('<html><script>alert(1)</script></html>'), 'image/png')).status, 400, 'content type claims mean nothing; bytes decide');
  assert.equal((await raw('PUT', `/coaching/observations/${o.id}/evidence`, s.coach.token, Buffer.alloc(0))).status, 400);
  const pdf = await raw('PUT', `/coaching/observations/${o.id}/evidence`, s.coach.token, Buffer.from('%PDF-1.4\n%fake'), 'application/pdf');
  assert.equal(pdf.status, 201); assert.equal(pdf.json.kind, 'document');
  const vid = await raw('PUT', `/coaching/observations/${o.id}/evidence`, s.coach.token, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]), 'video/mp4');
  assert.equal(vid.status, 201); assert.equal(vid.json.kind, 'video');
  assert.equal((await raw('PUT', `/coaching/observations/${o.id}/evidence`, undefined, PNG)).status, 401);
  for (let k = 0; k < 8; k++) assert.equal((await raw('PUT', `/coaching/observations/${o.id}/evidence`, s.coach.token, PNG)).status, 201);
  assert.equal((await raw('PUT', `/coaching/observations/${o.id}/evidence`, s.coach.token, PNG)).status, 400, 'ten files per note');
  // once the coaching relationship ends, no new files
  await pool.query('UPDATE teams SET owner_id=$2 WHERE id=$1', [s.team.id, s.outsider.id]);
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.coach.id]);
  const o2 = (await pool.query("SELECT id FROM coaching_observations WHERE id=$1", [o.id])).rows[0];
  assert.equal((await raw('PUT', `/coaching/observations/${o2.id}/evidence`, s.coach.token, PNG)).status, 403);
  assert.equal(ok(await get(s.coach.token, `/coaching/observations/${o.id}/evidence`)).length, 10, 'the author keeps their own');
});

test('voice notes: unavailable (clearly) without a speech-to-text bridge; with one you get text to review and nothing is saved', async () => {
  const s = await setup();
  config.transcribe.url = undefined;
  const opts = ok(await get(s.coach.token, '/coaching/capture-options'));
  assert.equal(opts.voice_note.available, false); assert.match(opts.voice_note.reason, /Type the note/);
  assert.equal(opts.evidence.max_bytes, 10 * 2 ** 20);
  const none = await raw('POST', '/coaching/voice-note', s.coach.token, Buffer.from('audio'), 'audio/webm');
  assert.equal(none.status, 501);
  const stub = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: Buffer.concat(c).toString() === 'silence' ? '' : '  Scanned well, lost shape late  ' })); }); }).listen(0);
  try {
    config.transcribe.url = `http://127.0.0.1:${stub.address().port}/stt`;
    assert.equal(ok(await get(s.coach.token, '/coaching/capture-options')).voice_note.available, true);
    const before = (await pool.query('SELECT count(*)::int AS n FROM coaching_observations')).rows[0].n;
    const r = await raw('POST', '/coaching/voice-note', s.coach.token, Buffer.from('speech'), 'audio/webm');
    assert.equal(r.status, 200); assert.equal(r.json.transcript, 'Scanned well, lost shape late'); assert.equal(r.json.saved, false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM coaching_observations')).rows[0].n, before, 'a transcript is a draft, not a note');
    assert.equal((await raw('POST', '/coaching/voice-note', s.coach.token, Buffer.from('silence'), 'audio/webm')).status, 422);
    assert.equal((await raw('POST', '/coaching/voice-note', s.a.token, Buffer.from('speech'), 'audio/webm')).status, 403, 'coaches only');
    assert.equal((await raw('POST', '/coaching/voice-note', undefined, Buffer.from('speech'), 'audio/webm')).status, 401);
    config.transcribe.url = 'http://127.0.0.1:1/unreachable';
    assert.equal((await raw('POST', '/coaching/voice-note', s.coach.token, Buffer.from('speech'), 'audio/webm')).status, 502);
  } finally { stub.close(); config.transcribe.url = undefined; }
});
