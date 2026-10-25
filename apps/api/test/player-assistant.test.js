import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pa_${n}_${roles[0]}`, display_name: `PD Person${n}`, email: `pa${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const patch = (t, p, body) => api('PATCH', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const today = new Date().toISOString().slice(0, 10);
const inFuture = (days, hour = 17) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// a coach with a player on their team, a second adult, and a young player with a guardian
const setup = async () => {
  const coach = await signup(['coach']), player = await signup(['athlete']), kid = await signup(['athlete']), parent = await signup(['athlete']), stranger = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Asst FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const u of [player, kid]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, u.id]);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const consent = (purpose) => pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,$2,$3,1, now() + interval '30 days') ON CONFLICT (child_id, purpose) DO UPDATE SET revoked_at=NULL, expires_at=now() + interval '30 days'", [kid.id, purpose, parent.id]);
  await consent('participation');
  return { coach, player, kid, parent, stranger, team, consent };
};

const { setAiTransport } = await import('../src/ai.js');
test('assistant: sourced draft from a live coach goal, honest limits, nothing changes until accepted, retry-safe', async () => {
  const s = await setup();
  ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.player.id, title: 'First touch', athlete_text: 'Settle the ball in one touch' }), 201);
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.player.id, owner_id: s.player.id, title: 'Film review', due_at: new Date(Date.now() - 864e5).toISOString() }), 201);
  const before = (await pool.query('SELECT count(*)::int AS c FROM player_goals WHERE owner_id=$1', [s.player.id])).rows[0].c;
  const a = ok(await post(s.player.token, '/me/assistant/answers', { task: 'week', client_key: 'key-week-0001' }), 201);
  assert.equal(a.status, 'draft'); assert.equal(a.viewer, 'self'); assert.equal(a.ai, false);
  const film = a.output.items.find((x) => x.title.includes('Film review'));
  assert.ok(film, 'overdue coach action is surfaced'); assert.equal(film.basis, 'observed');
  for (const it of a.output.items) if (it.basis === 'observed') assert.ok(it.source_refs.length, 'observed claims carry a source');
  assert.ok(a.sources.every((x) => x.ref && x.kind && x.evidence), 'every source says what kind of evidence it is');
  assert.ok(a.limitations.some((l) => /AI is switched off/.test(l)));
  // retry returns the same answer, not a second one
  assert.equal(ok(await post(s.player.token, '/me/assistant/answers', { task: 'week', client_key: 'key-week-0001' }), 201).id, a.id);
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM player_goals WHERE owner_id=$1', [s.player.id])).rows[0].c, before, 'asking changes nothing');
  // nobody else can read or resolve it: 404, never 403
  assert.equal((await get(s.stranger.token, `/me/assistant/answers/${a.id}`)).status, 404);
  assert.equal((await post(s.stranger.token, `/me/assistant/answers/${a.id}/resolve`, { decision: 'discard' })).status, 404);
  const goalItem = a.output.items.find((x) => x.action?.kind === 'goal');
  if (goalItem) {
    const acc = { decision: 'accept', row_version: a.row_version, actions: [{ item_id: goalItem.id, title: 'My own wording' }] };
    const r1 = ok(await post(s.player.token, `/me/assistant/answers/${a.id}/resolve`, acc));
    assert.equal(r1.status, 'edited');
    assert.equal((await post(s.player.token, `/me/assistant/answers/${a.id}/resolve`, acc)).status, 409, 'resolves once');
    assert.equal((await pool.query("SELECT count(*)::int AS c FROM player_goals WHERE owner_id=$1 AND title='My own wording'", [s.player.id])).rows[0].c, 1);
  }
  const exp = ok(await get(s.player.token, `/me/assistant/answers/${a.id}/export`));
  assert.match(exp.csv, /Film review/);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='export_player_assistant_answer'", [s.player.id])).rows.length);
});

test('assistant: validation, stale versions, discard, and out-of-scope topics are declined', async () => {
  const s = await setup();
  assert.equal((await post(s.player.token, '/me/assistant/answers', { task: 'ask' })).status, 400, 'ask needs a question');
  assert.equal((await post(s.player.token, '/me/assistant/answers', { from: '2026-02-10', to: '2026-02-01' })).status, 400);
  assert.equal((await post(s.player.token, '/me/assistant/answers', { from: '2026-01-01', to: '2026-12-31' })).status, 400);
  assert.equal((await post(null, '/me/assistant/answers', {})).status, 401);
  const med = ok(await post(s.player.token, '/me/assistant/answers', { task: 'ask', question: 'Am I cleared to play after my injury?' }), 201);
  assert.equal(med.output.declined, 'medical'); assert.deepEqual(med.output.items, []);
  assert.equal(ok(await post(s.player.token, '/me/assistant/answers', { task: 'ask', question: 'Should I accept the contract offer?' }), 201).output.declined, 'contract');
  assert.ok(!JSON.stringify(med.limitations).includes('injury'), 'the free-text question is not echoed into the stored limits');
  const raw = (await pool.query('SELECT question_enc FROM player_assistant_answers WHERE id=$1', [med.id])).rows[0].question_enc;
  assert.ok(raw && !raw.includes('injury'), 'the question is stored encrypted');
  const a = ok(await post(s.player.token, '/me/assistant/answers', { task: 'overview' }), 201);
  assert.equal((await post(s.player.token, `/me/assistant/answers/${a.id}/resolve`, { decision: 'accept', row_version: 99, actions: [{ item_id: 'i1' }] })).status, 409);
  assert.equal((await post(s.player.token, `/me/assistant/answers/${a.id}/resolve`, { decision: 'accept' })).status, 400, 'accepting nothing is refused');
  assert.equal(ok(await post(s.player.token, `/me/assistant/answers/${a.id}/resolve`, { decision: 'discard' })).status, 'discarded');
  await pool.query("UPDATE player_assistant_answers SET created_at = now() - interval '2 days' WHERE id=$1", [med.id]);
  const old = ok(await post(s.player.token, '/me/assistant/answers', { task: 'overview' }), 201);
  await pool.query("UPDATE player_assistant_answers SET created_at = now() - interval '2 days' WHERE id=$1", [old.id]);
  const r = await post(s.player.token, `/me/assistant/answers/${old.id}/resolve`, { decision: 'accept', actions: [{ item_id: 'i1' }] });
  assert.equal(r.status, 409);
  assert.equal(ok(await get(s.player.token, `/me/assistant/answers/${old.id}`)).stale, true);
  assert.ok(ok(await get(s.player.token, '/me/assistant/answers?status=discarded')).some((x) => x.id === a.id));
});

test('assistant: a young person\'s guardian reads under live consent; withdrawing it hides content at once; coach and stranger are bounded', async () => {
  const s = await setup();
  await s.consent('coaching');
  ok(await post(s.coach.token, '/coaching/goals', { athlete_id: s.kid.id, title: 'Kid goal', athlete_text: 'Keep going' }), 201);
  const g = ok(await post(s.parent.token, '/me/assistant/answers', { athlete_id: s.kid.id, task: 'overview' }), 201);
  assert.equal(g.viewer, 'guardian'); 
  assert.ok(g.limitations.some((l) => /Schedule is not shared with a guardian/.test(l)), 'schedule stays the child\'s own');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_athlete_assistant'", [s.parent.id])).rows.length);
  assert.equal((await post(s.parent.token, `/me/assistant/answers/${g.id}/resolve`, { decision: 'accept', actions: [{ item_id: 'i1' }] })).status, 403, 'a guardian cannot create the child\'s goals');
  assert.equal((await post(s.stranger.token, '/me/assistant/answers', { athlete_id: s.kid.id })).status, 404, 'no relationship: existence is not leaked');
  const c = ok(await post(s.coach.token, '/me/assistant/answers', { athlete_id: s.kid.id, task: 'overview' }), 201);
  assert.equal(c.viewer, 'coach'); assert.ok(c.source_kinds.every((k) => k === 'progress'), 'a coach is limited to progress');
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [s.kid.id]);
  const hidden = ok(await get(s.parent.token, `/me/assistant/answers/${g.id}`));
  assert.equal(hidden.hidden, 'consent_withdrawn'); assert.equal(hidden.output, null);
  assert.equal((await post(s.parent.token, '/me/assistant/answers', { athlete_id: s.kid.id })).status, 409, 'new asks are blocked while consent is off');
  assert.equal((await post(s.coach.token, '/me/assistant/answers', { athlete_id: s.kid.id })).status, 409);
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE guardian_id=$1", [s.parent.id]);
  assert.equal((await get(s.parent.token, `/me/assistant/answers/${g.id}`)).status, 404, 'a revoked link ends access to stored answers too');
});

test('assistant: an AI provider only rewords existing items; invented ids and medical wording are ignored', async () => {
  const s = await setup();
  ok(await post(s.coach.token, '/coaching/actions', { athlete_id: s.player.id, owner_id: s.player.id, title: 'Film review', due_at: new Date(Date.now() - 864e5).toISOString() }), 201);
  setAiTransport(async () => JSON.stringify({ headline: 'Film review first', whys: [{ id: 'i1', why: 'It is overdue.' }, { id: 'zzz', why: 'invented' }, { id: 'i2', why: 'See your physio about the injury' }] }));
  try {
    const a = ok(await post(s.player.token, '/me/assistant/answers', { task: 'week' }), 201);
    assert.equal(a.ai, true); assert.equal(a.output.headline, 'Film review first');
    assert.equal(a.output.items[0].why, 'It is overdue.');
    assert.ok(a.output.items.every((x) => x.id !== 'zzz' && !/physio/.test(x.why ?? '')));
    assert.ok(!a.limitations.some((l) => /AI is switched off/.test(l)));
  } finally { setAiTransport(null); }
});

test('assistant: accepting creates the player\'s own goal exactly once, even when the request is retried', async () => {
  const s = await setup();
  const a = ok(await post(s.player.token, '/me/assistant/answers', { task: 'overview' }), 201);
  const it = a.output.items.find((x) => x.action?.kind === 'goal');
  assert.ok(it, 'with no goals yet the assistant suggests setting one'); assert.equal(it.basis, 'suggestion');
  const body = { decision: 'accept', row_version: a.row_version, actions: [{ item_id: it.id, title: 'Serve to a target', target_value: 60, unit: 'percent' }] };
  const [r1, r2] = await Promise.all([post(s.player.token, `/me/assistant/answers/${a.id}/resolve`, body), post(s.player.token, `/me/assistant/answers/${a.id}/resolve`, body)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify([r1.body, r2.body]));
  const goals = (await pool.query("SELECT title, target_value::float8 AS t FROM player_goals WHERE owner_id=$1", [s.player.id])).rows;
  assert.deepEqual(goals, [{ title: 'Serve to a target', t: 60 }]);
  assert.equal(ok(await get(s.player.token, `/me/assistant/answers/${a.id}`)).status, 'edited');
  assert.equal((await post(s.player.token, `/me/assistant/answers/${a.id}/resolve`, { decision: 'accept', actions: [{ item_id: 'nope' }] })).status, 409);
});
