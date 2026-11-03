import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { config } = await import('../src/config.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const raw = async (path, token, bytes) => {
  const r = await fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'audio/webm', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: bytes });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const signup = async (roles, name) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `dc_${n}_${roles[0]}`, display_name: name ?? `Dc ${n}`, email: `dc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { config.transcribe.url = undefined; setAiTransport(null); server.close(); await pool.end(); });

async function setup() {
  const coach = await signup(['coach'], 'Coach Dictation');
  const a = await signup(['athlete'], 'Lakshmi Narayanan');
  const team = ok(await api('POST', '/teams', { token: coach.token, body: { name: `Dict FC ${n}`, sport: 'football' } }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, a.id]);
  const sheet = ok(await api('POST', '/coaching/rubrics', { token: coach.token, body: { name: 'Profile', sport: 'football', dimensions: [{ key: 'first_touch', name: 'First touch', pillar: 'technical', weight: 1, scale_min: 1, scale_max: 5 }, { key: 'scanning', name: 'Scanning', pillar: 'tactical', weight: 1, scale_min: 1, scale_max: 5 }] } }), 201);
  const ev = ok(await api('POST', '/coaching/evaluations', { token: coach.token, body: { athlete_id: a.id, rubric_id: sheet.rubric_id ?? sheet.id, context_type: 'period' } }), 201);
  return { coach, a, ev, rid: sheet.rubric_id ?? sheet.id };
}

test('the spoken language is passed to the speech service (any of the 12, or auto); an unknown language is refused; the transcript is a draft', async () => {
  const s = await setup();
  const seen = [];
  const stub = http.createServer((req, res) => { req.resume(); req.on('end', () => { seen.push({ q: new URL(req.url, 'http://x').searchParams.get('language'), h: req.headers['x-language'] }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'முதல் தொடுதல் நன்றாக இருந்தது', language: 'ta' })); }); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  try {
    config.transcribe.url = `http://127.0.0.1:${stub.address().port}/stt`;
    const opts = ok(await api('GET', '/coaching/capture-options', { token: s.coach.token }));
    assert.deepEqual(opts.voice_note.languages, ['en', 'hi', 'mr', 'ta', 'te', 'ml', 'kn', 'bn', 'or', 'si', 'ur', 'id']);
    const r = await raw('/coaching/voice-note?language=ta', s.coach.token, Buffer.from('speech'));
    assert.equal(r.status, 200); assert.equal(r.json.transcript, 'முதல் தொடுதல் நன்றாக இருந்தது'); assert.equal(r.json.language, 'ta'); assert.equal(r.json.saved, false);
    assert.deepEqual(seen[0], { q: 'ta', h: 'ta' });
    assert.equal((await raw('/coaching/voice-note', s.coach.token, Buffer.from('speech'))).status, 200);
    assert.deepEqual(seen[1], { q: 'auto', h: 'auto' }, 'no language means auto-detect');
    assert.equal((await raw('/coaching/voice-note?language=xx', s.coach.token, Buffer.from('speech'))).status, 400);
  } finally { stub.close(); config.transcribe.url = undefined; }
});

test('translation: faithful, only for coaches, needs AI, same-language is a no-op, nothing is saved', async () => {
  const s = await setup();
  assert.equal((await api('POST', '/coaching/translate', { token: s.coach.token, body: { text: 'Good touch', to: 'ta' } })).status, 501, 'clear message when AI is not set up');
  let prompt = '';
  setAiTransport(async (b) => { prompt = JSON.stringify(b); return 'நல்ல தொடுதல்'; });
  try {
    const out = ok(await api('POST', '/coaching/translate', { token: s.coach.token, body: { text: 'Good touch', from: 'en', to: 'ta' } }));
    assert.equal(out.text, 'நல்ல தொடுதல்'); assert.match(prompt, /Tamil/);
    assert.equal(ok(await api('POST', '/coaching/translate', { token: s.coach.token, body: { text: 'Good touch', from: 'en', to: 'en' } })).unchanged, true);
    assert.equal((await api('POST', '/coaching/translate', { token: s.a.token, body: { text: 'x', to: 'ta' } })).status, 403, 'coaches only');
    assert.equal((await api('POST', '/coaching/translate', { token: s.coach.token, body: { text: 'x', to: 'xx' } })).status, 400);
  } finally { setAiTransport(null); }
});

test('speaking an evaluation: the words become a draft of the feedback and per-criterion comments, flagged for review; the name never reaches the model; nothing is saved', async () => {
  const s = await setup();
  const say = 'Lakshmi Narayanan had a lovely first touch today, but she did not scan before receiving. Next week work on checking her shoulder.';
  assert.equal((await api('POST', `/coaching/evaluations/${s.ev.id}/dictation`, { token: s.coach.token, body: { transcript: say } })).status, 501, 'needs AI');
  let seen = '';
  setAiTransport(async (b) => { seen = JSON.stringify(b); return JSON.stringify({ strengths: 'A lovely first touch.', development: 'Did not scan before receiving.', next_steps: 'Check the shoulder before receiving.', comments: [{ key: 'first_touch', comment: 'Lovely.' }, { key: 'invented_key', comment: 'Should be dropped.' }, { key: 'scanning', comment: 'Did not scan first.' }] }); });
  try {
    const d = ok(await api('POST', `/coaching/evaluations/${s.ev.id}/dictation`, { token: s.coach.token, body: { transcript: say, language: 'en', write_in: 'ta' } }));
    assert.equal(d.saved, false); assert.equal(d.narrative.ai_drafted, true); assert.equal(d.narrative.strengths, 'A lovely first touch.');
    assert.deepEqual(Object.keys(d.comments).sort(), ['first_touch', 'scanning'], 'a criterion the sheet does not have is dropped');
    assert.ok(!seen.includes('Lakshmi') && !seen.includes('Narayanan'), 'the athlete\'s name is removed before it reaches the model');
    assert.match(seen, /Tamil/, 'writes in the requested language');
    // nothing was written to the evaluation
    const row = (await pool.query('SELECT narrative, scores FROM coaching_evaluations WHERE id=$1', [s.ev.id])).rows[0];
    assert.deepEqual(row.narrative, {}); assert.deepEqual(row.scores, {});
    // someone else's evaluation is a 404, an athlete is refused
    const other = await signup(['coach']);
    assert.equal((await api('POST', `/coaching/evaluations/${s.ev.id}/dictation`, { token: other.token, body: { transcript: say } })).status, 404);
    assert.equal((await api('POST', `/coaching/evaluations/${s.ev.id}/dictation`, { token: s.a.token, body: { transcript: say } })).status, 403);
    // the coach reviews, applies it with the AI marker, and cannot share until confirming
    ok(await api('PATCH', `/coaching/evaluations/${s.ev.id}`, { token: s.coach.token, body: { row_version: 1, narrative: d.narrative, scores: { first_touch: { score: 4, comment: d.comments.first_touch }, scanning: { score: 2, comment: d.comments.scanning } } } }));
    const blocked = await api('POST', `/coaching/evaluations/${s.ev.id}/share`, { token: s.coach.token, body: {} });
    assert.equal(blocked.status, 400); assert.match(JSON.stringify(blocked.body), /AI draft/);
    ok(await api('POST', `/coaching/evaluations/${s.ev.id}/share`, { token: s.coach.token, body: { confirm_reviewed: true } }));
  } finally { setAiTransport(null); }
  // a garbled model answer is reported as a failure, not saved
  setAiTransport(async () => 'sorry');
  try { assert.equal((await api('POST', `/coaching/evaluations/${s.ev.id}/dictation`, { token: s.coach.token, body: { transcript: say } })).status, 502); } finally { setAiTransport(null); }
});
