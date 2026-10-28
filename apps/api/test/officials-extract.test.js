import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { buildExtract } = await import('../src/officials-extract.js');
const { extractLines } = await import('../src/documents/official-extract.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ox_${n}_${roles[0]}`, display_name: `Extract ${n}`, email: `ox${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (days, hour) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ox_root','ox_root','{admin}','x','x','ox_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
});
after(async () => { server.close(); await pool.end(); });

async function world() {
  const org = await signup(['organizer']);
  const caps = await Promise.all([signup(['athlete']), signup(['athlete'])]);
  const teams = [];
  for (const [i, c] of caps.entries()) teams.push(must(await api('POST', '/teams', { token: c.token, body: { name: `OX${n}-${i}`, sport: 'football' } }), 201));
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Extract Cup ${n}`, sport: 'football' } }), 201);
  for (const [i, c] of caps.entries()) { const e = must(await api('POST', `/events/${ev.id}/entries`, { token: c.token, body: { team_id: teams[i].id } }), 201); await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } }); }
  const ref = await signup(['referee']);
  must(await api('POST', '/me/sport-profiles', { token: ref.token, body: { sport: 'football', role: 'referee' } }), 201);
  const fx = async (when) => must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: teams[0].id, away_team_id: teams[1].id, scheduled_at: when } }), 201);
  const assign = async (f, user = ref, role = 'referee') => {
    must(await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: user.id, role } }), 201);
    const a = (await api('GET', '/me/official-assignments', { token: user.token })).body.find((x) => x.fixture_id === f.id && x.role === role);
    must(await api('POST', `/official-assignments/${a.id}/respond`, { token: user.token, body: { response: 'accept' } }));
    return a;
  };
  return { org, caps, teams, ev, ref, fx, assign };
}

test('fee and payment: organiser records, official confirms or disputes, paid is final, history kept, others cannot see fees', async () => {
  const { org, ref, fx, assign, caps } = await world();
  const f = await fx(at(2, 9)); const a = await assign(f);
  const stranger = await signup(['athlete']);
  const body = { fee_minor: 5000, currency: 'INR', status: 'agreed' };
  assert.equal((await api('POST', `/official-assignments/${a.id}/fee`, { token: stranger.token, body })).status, 403);
  assert.equal((await api('POST', `/official-assignments/${a.id}/fee`, { token: ref.token, body })).status, 403, 'the official cannot set their own fee');
  must(await api('POST', `/official-assignments/${a.id}/fee`, { token: org.token, body }));
  assert.equal((await api('POST', `/official-assignments/${a.id}/payment-response`, { token: ref.token, body: { response: 'confirm' } })).status, 409, 'not paid yet');
  must(await api('POST', `/official-assignments/${a.id}/fee`, { token: org.token, body: { ...body, status: 'due' } }));
  assert.equal((await api('POST', `/official-assignments/${a.id}/fee`, { token: org.token, body })).status, 400, 'cannot go back to agreed');
  const d = must(await api('POST', `/official-assignments/${a.id}/payment-response`, { token: ref.token, body: { response: 'dispute', note: 'Amount differs from our agreement' } }));
  assert.equal(d.pay_status, 'disputed');
  must(await api('POST', `/official-assignments/${a.id}/fee`, { token: org.token, body: { ...body, fee_minor: 6000, status: 'paid' } }));
  assert.equal((await api('POST', `/official-assignments/${a.id}/fee`, { token: org.token, body: { ...body, status: 'paid' } })).status, 409, 'paid is final');
  assert.equal(must(await api('POST', `/official-assignments/${a.id}/payment-response`, { token: ref.token, body: { response: 'confirm' } })).pay_confirmed_at !== null, true);
  const log = must(await api('GET', `/official-assignments/${a.id}/payment-log`, { token: ref.token }));
  assert.deepEqual(log.map((l) => l.to_status), ['agreed', 'due', 'disputed', 'paid', 'paid']);
  assert.equal((await api('GET', `/official-assignments/${a.id}/payment-log`, { token: stranger.token })).status, 404);
  // another crew member sees no fee on the briefing; the organiser and the official do
  const lines = await signup(['referee']); must(await api('POST', '/me/sport-profiles', { token: lines.token, body: { sport: 'football', role: 'referee' } }), 201);
  await assign(f, lines, 'linesman');
  const seen = must(await api('GET', `/fixtures/${f.id}/briefing`, { token: lines.token })).crew.find((m) => m.role === 'referee');
  assert.equal(seen.fee_minor, null);
  assert.equal(must(await api('GET', `/fixtures/${f.id}/briefing`, { token: org.token })).crew.find((m) => m.role === 'referee').fee_minor, 6000);
});

test('feedback: fixed criteria, only after completion, one each, anonymous, threshold, reply, contest and moderation', async () => {
  const { org, ref, fx, assign, caps } = await world();
  const f = await fx(at(1, 9)); const a = await assign(f);
  const stranger = await signup(['athlete']);
  const ratings = { communication: 4, consistency: 5, game_control: 4, positioning_fitness: 3, conduct: 5 };
  assert.equal((await api('POST', `/official-assignments/${a.id}/feedback`, { token: org.token, body: { ratings } })).status, 409, 'match not completed');
  must(await api('POST', `/fixtures/${f.id}/result`, { token: org.token, body: { home_score: 1, away_score: 0 } }));
  assert.equal((await api('POST', `/official-assignments/${a.id}/feedback`, { token: stranger.token, body: { ratings } })).status, 404);
  assert.equal((await api('POST', `/official-assignments/${a.id}/feedback`, { token: ref.token, body: { ratings } })).status, 403, 'not about yourself');
  assert.equal((await api('POST', `/official-assignments/${a.id}/feedback`, { token: org.token, body: { ratings: { ...ratings, conduct: 9 } } })).status, 400);
  assert.ok(must(await api('GET', '/me/officials/feedback-due', { token: org.token })).some((x) => x.official_assignment_id === a.id));
  must(await api('POST', `/official-assignments/${a.id}/feedback`, { token: org.token, body: { ratings, comment: 'Calm and clear throughout.' } }), 201);
  assert.equal((await api('POST', `/official-assignments/${a.id}/feedback`, { token: org.token, body: { ratings } })).status, 409, 'one each');
  assert.ok(!must(await api('GET', '/me/officials/feedback-due', { token: org.token })).some((x) => x.official_assignment_id === a.id));
  let mine = must(await api('GET', '/me/officials/feedback', { token: ref.token }));
  assert.deepEqual([mine.enough, mine.responses, mine.comments.length], [false, 1, 0], 'one response is never shown');
  must(await api('POST', `/official-assignments/${a.id}/feedback`, { token: caps[0].token, body: { ratings: { ...ratings, communication: 2 }, comment: 'Slow to explain decisions.' } }), 201);
  must(await api('POST', `/official-assignments/${a.id}/feedback`, { token: caps[1].token, body: { ratings: { ...ratings, communication: 3 } } }), 201);
  mine = must(await api('GET', '/me/officials/feedback', { token: ref.token }));
  assert.equal(mine.enough, true);
  assert.equal(mine.criteria.find((c) => c.key === 'communication').average, 3);
  assert.equal(/Extract \d/.test(JSON.stringify(mine)), false, 'authors are never named');
  assert.deepEqual(mine.comments.map((c) => c.capacity).sort(), ['event_official', 'team_official']);
  const slow = mine.comments.find((c) => c.comment?.startsWith('Slow'));
  must(await api('POST', `/official-feedback/${slow.id}/reply`, { token: ref.token, body: { reply: 'Noted, I will explain more.' } }));
  assert.equal((await api('POST', `/official-feedback/${slow.id}/reply`, { token: ref.token, body: { reply: 'again please' } })).status, 409);
  assert.equal((await api('POST', `/official-feedback/${slow.id}/contest`, { token: stranger.token, body: { reason: 'not mine to contest' } })).status, 404);
  must(await api('POST', `/official-feedback/${slow.id}/contest`, { token: ref.token, body: { reason: 'This was written in retaliation' } }));
  assert.equal(must(await api('GET', '/admin/official-feedback', { token: admin.token })).length, 1);
  assert.equal((await api('GET', '/admin/official-feedback', { token: ref.token })).status, 403);
  must(await api('POST', `/admin/official-feedback/${slow.id}/moderation`, { token: admin.token, body: { decision: 'hide', reason: 'Retaliatory, confirmed' } }));
  mine = must(await api('GET', '/me/officials/feedback', { token: ref.token }));
  assert.deepEqual([mine.enough, mine.responses], [false, 2], 'a hidden response no longer counts, so the threshold applies again');
  const raw = (await pool.query('SELECT comment_enc FROM official_feedback WHERE comment_enc IS NOT NULL LIMIT 1')).rows[0].comment_enc;
  assert.ok(!raw.includes('Calm'), 'comments are encrypted at rest');
});

test('extract: frozen PDF with assignments, closure forms, fees, feedback; owner only, shared by revocable link', async () => {
  const { org, ref, fx, assign, caps } = await world();
  const f1 = await fx(at(1, 9)), f2 = await fx(at(3, 9));
  const a1 = await assign(f1); await assign(f2);
  must(await api('POST', `/official-assignments/${a1.id}/fee`, { token: org.token, body: { fee_minor: 7500, currency: 'INR', status: 'paid' } }));
  must(await api('POST', `/fixtures/${f1.id}/result`, { token: org.token, body: { home_score: 2, away_score: 2, winner_team_id: undefined } }));
  must(await api('POST', `/fixtures/${f1.id}/reports`, { token: ref.token, body: { category: 'match_report', summary: 'Heated but fair finish', note: 'Two bookings in the second half, both for dissent.' } }), 201);
  const t = (await pool.query('SELECT id FROM official_reports WHERE fixture_id=$1', [f1.id])).rows[0];
  must(await api('POST', `/official-reports/${t.id}/revise`, { token: ref.token, body: { summary: 'Heated but fair finish (amended)', reason: 'Added time of bookings' } }));
  const stranger = await signup(['athlete']);
  assert.equal((await api('POST', '/me/officials/extracts', { token: stranger.token, body: {} })).status, 400, 'nothing to report');

  const { snapshot } = await buildExtract(ref, { from: at(-30, 0).slice(0, 10), to: at(30, 0).slice(0, 10) });
  const text = JSON.stringify(extractLines(snapshot));
  assert.equal(snapshot.counts.assignments, 2);
  assert.match(text, /75\.00 INR/); assert.match(text, /amended/); assert.match(text, /Two bookings/); assert.match(text, /recorded directly/);
  assert.equal(snapshot.feedback.enough, false);

  const body = { client_key: 'extract-key-0001', to: at(30, 0).slice(0, 10) };
  const ex = must(await api('POST', '/me/officials/extracts', { token: ref.token, body }), 201);
  const again = must(await api('POST', '/me/officials/extracts', { token: ref.token, body }), 201);
  assert.equal(again.id, ex.id, 'a retry returns the same extract');
  assert.equal(ex.counts.assignments, 2);
  const dl = (u, id = ex.id) => fetch(`${base}/api/v1/official-extracts/${id}/pdf`, { headers: { authorization: `Bearer ${u.token}` } });
  const r = await dl(ref);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await dl(stranger)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/official-extracts/${ex.id}/pdf`)).status, 401);
  assert.equal((await api('POST', `/me/officials/extracts/${ex.id}/shares`, { token: stranger.token, body: { recipient_id: org.id } })).status, 404, 'only the owner shares');
  const share = must(await api('POST', `/me/officials/extracts/${ex.id}/shares`, { token: ref.token, body: { recipient_id: org.id, days: 7 } }), 201);
  assert.equal((await dl(org)).status, 200);
  assert.equal(must(await api('GET', '/me/officials/extracts-shared', { token: org.token })).length, 1);
  assert.equal(must(await api('GET', '/me/officials/extracts', { token: ref.token }))[0].shares[0].active, true);
  must(await api('POST', `/me/officials/extract-shares/${share.id}/revoke`, { token: ref.token }));
  assert.equal((await dl(org)).status, 404, 'revoking takes effect at once');
  const s2 = must(await api('POST', `/me/officials/extracts/${ex.id}/shares`, { token: ref.token, body: { recipient_id: org.id } }), 201);
  await pool.query("UPDATE official_extract_shares SET expires_at = now() - interval '1 minute' WHERE id=$1", [s2.id]);
  assert.equal((await dl(org)).status, 404, 'an expired share no longer opens it');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action IN ('build_official_extract','read_official_extract','share_official_extract')")).rowCount >= 3);
});

test('extract capabilities are in REST, OpenAPI and MCP', async () => {
  const names = ['set_official_fee', 'respond_official_payment', 'list_official_payment_log', 'list_official_feedback_due', 'submit_official_feedback', 'list_my_official_feedback', 'reply_official_feedback', 'contest_official_feedback', 'list_contested_official_feedback', 'moderate_official_feedback', 'build_official_extract', 'list_my_official_extracts', 'share_official_extract', 'revoke_official_extract_share', 'list_official_extracts_shared_with_me'];
  const spec = must(await api('GET', '/openapi.json'));
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  const u = await signup(['referee']);
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${u.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const text = await r.text();
  for (const nm of names) { assert.ok(ops.has(nm), `${nm} in OpenAPI`); if (!nm.includes('contested') && !nm.includes('moderate')) assert.ok(text.includes(`"${nm}"`), `${nm} in MCP`); }
});
