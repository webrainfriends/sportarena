// Issue #330: permissioned athlete support-team collaboration over wellness data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (name, args, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => api('POST', p, { token: t, body });
const get = (t, p) => api('GET', p, { token: t });
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ws_${n}_${roles[0]}`, display_name: `Share ${n}`, email: `ws${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** an athlete with wellness logged, a coach on the same team, a sponsor and a team-mate with no coaching role */
const setup = async () => {
  const ath = await signup(['athlete']), coach = await signup(['coach']), mate = await signup(['athlete']), sponsor = await signup(['sponsor']);
  const team = ok(await post(coach.token, '/teams', { name: `Share FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const u of [ath, mate]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, u.id]);
  ok(await post(ath.token, '/me/wellness', { date: day(), sleep_hours: 7.5, sleep_quality: 4, soreness: 3, mood: 2, water_ml: 1800, note: 'PRIVATE-NOTE-XYZ' }), 200);
  ok(await post(ath.token, '/me/wellness', { date: day(-1), sleep_hours: 6, soreness: 5, mood: 3 }), 200);
  ok(await post(ath.token, '/me/body-pain', { region: 'knee', side: 'left', severity: 6, note: 'PRIVATE-PAIN-NOTE' }), 201);
  return { ath, coach, mate, sponsor, team };
};
const share = (s, extra = {}) => post(s.ath.token, '/me/wellness-shares', { recipient_id: s.coach.id, purpose: 'training_load', fields: ['sleep', 'soreness'], history_days: 30, expires_on: day(30), ...extra });
const providerFor = async (ath) => {
  const doc = await signup(['physio']);
  ok(await post(doc.token, '/me/sport-profiles', { sport: 'football', role: 'physio' }), 201);
  const c = (await pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ('physio','user',$1,$1,'approved',1,now(), now() + interval '300 days') RETURNING id", [doc.id])).rows[0].id;
  ok(await post(ath.token, '/medical/grants', { provider_id: doc.id }), 201);
  return { doc, caseId: c };
};

test('only people who actually work with the athlete can be chosen; team-mates and sponsors cannot', async () => {
  const s = await setup();
  const rec = ok(await get(s.ath.token, '/me/wellness-shares/recipients'));
  assert.deepEqual(rec.map((r) => [r.id, r.kind]), [[s.coach.id, 'coach']]);
  assert.equal((await post(s.ath.token, '/me/wellness-shares', { recipient_id: s.mate.id, purpose: 'training_load', fields: ['sleep'], history_days: 7, expires_on: day(7) })).status, 403);
  assert.equal((await post(s.ath.token, '/me/wellness-shares', { recipient_id: s.sponsor.id, purpose: 'training_load', fields: ['sleep'], history_days: 7, expires_on: day(7) })).status, 403);
  assert.equal((await post(s.ath.token, '/me/wellness-shares', { recipient_id: s.ath.id, purpose: 'training_load', fields: ['sleep'], history_days: 7, expires_on: day(7) })).status, 400);
});

test('validation: past or too-distant end dates, empty or unknown fields, notes can never be shared', async () => {
  const s = await setup();
  assert.equal((await share(s, { expires_on: day(-1) })).status, 400);
  assert.equal((await share(s, { expires_on: day(400) })).status, 400);
  assert.equal((await share(s, { fields: [] })).status, 400);
  assert.equal((await share(s, { fields: ['notes'] })).status, 400);
  assert.equal((await share(s, { history_days: 0 })).status, 400);
});

test('the coach sees exactly the chosen fields and window, never notes; each view is logged and visible to the athlete', async () => {
  const s = await setup();
  const sh = ok(await share(s, { history_days: 1 }), 201);
  assert.equal(sh.version, 1); assert.deepEqual(sh.fields, ['sleep', 'soreness']);
  const list = ok(await get(s.coach.token, '/wellness-shared'));
  assert.equal(list.length, 1); assert.equal(list[0].live, true); assert.equal(list[0].athlete_id, s.ath.id);
  const v = ok(await get(s.coach.token, `/wellness-shared/${sh.id}`));
  assert.equal(v.days.length, 1, 'history_days 1 = today only');
  assert.equal(v.days[0].sleep_hours, 7.5); assert.equal(v.days[0].soreness, 3);
  assert.ok(!('mood' in v.days[0]) && !('water_ml' in v.days[0]));
  assert.ok(v.not_shared.includes('notes') && v.not_shared.includes('mood') && v.not_shared.includes('body_map'));
  assert.ok(!('body_map' in v) && !('readiness' in v) && !('workload' in v));
  assert.ok(!JSON.stringify(v).includes('PRIVATE'));
  // asking for older days than the athlete allowed is clamped, not honoured
  const wide = ok(await get(s.coach.token, `/wellness-shared/${sh.id}?from=${day(-30)}`));
  assert.equal(wide.window.from, day()); assert.equal(wide.days.length, 1);
  const mine = ok(await get(s.ath.token, '/me/wellness-shares'));
  assert.equal(mine.shares[0].views, 2); assert.ok(mine.shares[0].last_viewed_at);
  assert.ok(mine.activity.some((a) => a.action === 'viewed'));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_wellness_shared'", [s.coach.id])).rowCount >= 2);
});

test('readiness, workload and body map appear only when chosen, without notes', async () => {
  const s = await setup();
  const sh = ok(await share(s, { fields: ['readiness', 'workload', 'body_map'] }), 201);
  const v = ok(await get(s.coach.token, `/wellness-shared/${sh.id}`));
  assert.equal(v.days.length, 0, 'no raw daily fields were chosen');
  assert.ok(v.readiness.score !== null); assert.ok(v.workload.status);
  assert.deepEqual(v.body_map.map((p) => [p.region, p.side, p.severity]), [['knee', 'left', 6]]);
  assert.ok(!JSON.stringify(v).includes('PRIVATE'));
});

test('duplicate create is idempotent, a conflicting one must be edited, parallel creates leave one live share', async () => {
  const s = await setup();
  const a = ok(await share(s), 201);
  const again = ok(await share(s), 201);
  assert.equal(again.id, a.id);
  const diff = await share(s, { fields: ['sleep'] });
  assert.equal(diff.status, 409); assert.equal(diff.body.error.details.code, 'share_exists');
  const t = await setup();
  const rs = await Promise.all([share(t), share(t), share(t)]);
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201]);
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM wellness_shares WHERE athlete_id=$1 AND revoked_at IS NULL', [t.ath.id])).rows[0].n, 1);
});

test('editing needs the current version; narrowing applies at once; the other writer is told to reload', async () => {
  const s = await setup();
  const a = ok(await share(s), 201);
  const wide = ok(await post(s.ath.token, '/me/wellness-shares', { recipient_id: s.coach.id, purpose: 'training_load', fields: ['sleep', 'soreness'], history_days: 30, expires_on: day(30) }), 201);
  assert.equal(wide.id, a.id);
  const up = ok(await api('PATCH', `/me/wellness-shares/${a.id}`, { token: s.ath.token, body: { version: 1, fields: ['sleep'] } }));
  assert.equal(up.version, 2); assert.deepEqual(up.fields, ['sleep']);
  const stale = await api('PATCH', `/me/wellness-shares/${a.id}`, { token: s.ath.token, body: { version: 1, fields: ['mood'] } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details.code, 'stale_version'); assert.equal(stale.body.error.details.version, 2);
  const v = ok(await get(s.coach.token, `/wellness-shared/${a.id}`));
  assert.ok(!('soreness' in v.days[0]));
  assert.equal((await api('PATCH', `/me/wellness-shares/${a.id}`, { token: s.ath.token, body: { version: 2 } })).status, 400);
  assert.equal((await api('PATCH', `/me/wellness-shares/${a.id}`, { token: s.coach.token, body: { version: 2, fields: ['mood'] } })).status, 404, 'the recipient cannot widen their own access');
});

test('revoking stops the very next read, is repeatable, notifies and keeps the history', async () => {
  const s = await setup();
  const a = ok(await share(s), 201);
  ok(await get(s.coach.token, `/wellness-shared/${a.id}`));
  const r = ok(await post(s.ath.token, `/me/wellness-shares/${a.id}/revoke`, {}));
  assert.equal(r.state, 'revoked');
  assert.equal(ok(await post(s.ath.token, `/me/wellness-shares/${a.id}/revoke`, {})).state, 'revoked');
  assert.equal((await get(s.coach.token, `/wellness-shared/${a.id}`)).status, 403);
  assert.equal((await get(s.coach.token, `/wellness-shared/${a.id}/export`)).status, 403);
  const mine = ok(await get(s.ath.token, '/me/wellness-shares'));
  assert.equal(mine.shares[0].state, 'revoked'); assert.equal(mine.shares[0].views, 1);
  assert.deepEqual([...new Set(mine.activity.map((e) => e.action))].sort(), ['granted', 'revoked', 'viewed']);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='wellness_share_revoked'", [s.coach.id])).rowCount === 1);
  assert.equal((await post(s.coach.token, `/me/wellness-shares/${a.id}/revoke`, {})).status, 404, 'recipient cannot revoke or learn more');
  // a fresh share for the same purpose is allowed after revoking
  ok(await share(s), 201);
});

test('expiry ends access without any action, and a lapsed share does not block a new one', async () => {
  const s = await setup();
  const a = ok(await share(s), 201);
  await pool.query("UPDATE wellness_shares SET expires_at = now() - interval '1 minute' WHERE id=$1", [a.id]);
  assert.equal((await get(s.coach.token, `/wellness-shared/${a.id}`)).status, 403);
  assert.equal(ok(await get(s.ath.token, '/me/wellness-shares')).shares[0].state, 'expired');
  const list = ok(await get(s.coach.token, '/wellness-shared'));
  assert.equal(list[0].live, false); assert.equal(list[0].state, 'expired');
  assert.equal((await api('PATCH', `/me/wellness-shares/${a.id}`, { token: s.ath.token, body: { version: 1, fields: ['mood'] } })).status, 409);
  const fresh = ok(await share(s), 201);
  assert.notEqual(fresh.id, a.id);
});

test('a coach who stops coaching the athlete loses access at once, with the reason shown to both sides', async () => {
  const s = await setup();
  const a = ok(await share(s), 201);
  ok(await get(s.coach.token, `/wellness-shared/${a.id}`));
  await pool.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND user_id=$2", [s.team.id, s.coach.id]);
  assert.equal((await get(s.coach.token, `/wellness-shared/${a.id}`)).status, 403);
  const mine = ok(await get(s.ath.token, '/me/wellness-shares')).shares[0];
  assert.equal(mine.state, 'active'); assert.equal(mine.live, false); assert.match(mine.blocked_reason, /no longer coach/);
  assert.equal(ok(await get(s.coach.token, '/wellness-shared'))[0].live, false);
});

test('a clinician needs the medical grant AND a verified credential, live; sponsors and strangers learn nothing', async () => {
  const s = await setup();
  const { doc, caseId } = await providerFor(s.ath);
  assert.ok(ok(await get(s.ath.token, '/me/wellness-shares/recipients')).some((r) => r.id === doc.id && r.kind === 'provider'));
  const a = ok(await post(s.ath.token, '/me/wellness-shares', { recipient_id: doc.id, purpose: 'return_to_play', fields: ['soreness', 'body_map'], history_days: 14, expires_on: day(20) }), 201);
  assert.equal(a.recipient_kind, 'provider');
  const v = ok(await get(doc.token, `/wellness-shared/${a.id}`));
  assert.equal(v.body_map.length, 1);
  assert.equal((await get(s.sponsor.token, `/wellness-shared/${a.id}`)).status, 404);
  assert.equal((await get(s.coach.token, `/wellness-shared/${a.id}`)).status, 404);
  // credential revoked -> blocked
  await pool.query("UPDATE verification_cases SET status='revoked' WHERE id=$1", [caseId]);
  assert.equal((await get(doc.token, `/wellness-shared/${a.id}`)).status, 403);
  await pool.query("UPDATE verification_cases SET status='approved' WHERE id=$1", [caseId]);
  ok(await get(doc.token, `/wellness-shared/${a.id}`));
  // withdrawing the medical grant -> blocked, share row untouched
  ok(await api('DELETE', `/medical/grants/${doc.id}`, { token: s.ath.token }));
  assert.equal((await get(doc.token, `/wellness-shared/${a.id}`)).status, 403);
  assert.equal(ok(await get(s.ath.token, '/me/wellness-shares')).shares[0].live, false);
});

test('without a medical grant a clinician cannot be chosen', async () => {
  const s = await setup();
  const doc = await signup(['physio']);
  assert.equal((await post(s.ath.token, '/me/wellness-shares', { recipient_id: doc.id, purpose: 'return_to_play', fields: ['soreness'], history_days: 7, expires_on: day(7) })).status, 403);
});

test('young athletes: guardian consent is required to share and applies live; the guardian can see and stop it; others cannot', async () => {
  const s = await setup();
  const parent = await signup(['athlete']);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [s.ath.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, s.ath.id]);
  const refused = await share(s);
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details?.code ?? refused.body.error.code, 'guardian_consent_required');
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'coaching',$2,1, now() + interval '30 days')", [s.ath.id, parent.id]);
  const a = ok(await share(s), 201);
  ok(await get(s.coach.token, `/wellness-shared/${a.id}`));
  const seen = ok(await get(parent.token, `/me/wellness-shares?athlete_id=${s.ath.id}`));
  assert.equal(seen.shares.length, 1);
  assert.equal((await get(s.mate.token, `/me/wellness-shares?athlete_id=${s.ath.id}`)).status, 403);
  // consent withdrawn -> the next read is refused, nothing was deleted
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [s.ath.id]);
  assert.equal((await get(s.coach.token, `/wellness-shared/${a.id}`)).status, 403);
  assert.match(ok(await get(s.ath.token, '/me/wellness-shares')).shares[0].blocked_reason, /guardian/);
  // the guardian can stop it; a stranger gets a plain 404
  assert.equal((await post(s.mate.token, `/me/wellness-shares/${a.id}/revoke`, {})).status, 404);
  assert.equal(ok(await post(parent.token, `/me/wellness-shares/${a.id}/revoke`, {})).state, 'revoked');
});

test('CSV export carries only the chosen fields, is audited and visible to the athlete; MCP and OpenAPI expose the same capabilities', async () => {
  const s = await setup();
  const a = ok(await share(s, { fields: ['sleep'] }), 201);
  const e = ok(await get(s.coach.token, `/wellness-shared/${a.id}/export`));
  assert.equal(e.content_type, 'text/csv'); assert.equal(e.csv.split('\n')[0], 'date,sleep_hours,sleep_quality'); assert.equal(e.rows, 2);
  assert.ok(!e.csv.includes('PRIVATE') && !e.csv.includes('soreness'));
  assert.ok(ok(await get(s.ath.token, '/me/wellness-shares')).activity.some((x) => x.action === 'exported'));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='export_wellness_shared'", [s.coach.id])).rowCount === 1);
  const t = await rpc('list_wellness_shared_with_me', {}, s.coach.token);
  assert.ok(!t.isError, JSON.stringify(t));
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ids = Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
  for (const name of ['create_wellness_share', 'update_wellness_share', 'revoke_wellness_share', 'list_wellness_shares', 'list_wellness_share_recipients', 'list_wellness_shared_with_me', 'get_shared_wellness', 'export_shared_wellness']) assert.ok(ids.includes(name), name);
});

test('anonymous callers cannot reach sharing', async () => {
  const s = await setup();
  assert.equal((await api('GET', '/wellness-shared')).status, 401);
  const a = ok(await share(s), 201);
  assert.equal((await api('GET', `/wellness-shared/${a.id}`)).status, 401);
});

test('a revoke in flight wins: a read that started meanwhile waits for it and is then refused', async () => {
  const s = await setup();
  const a = ok(await share(s), 201);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE wellness_shares SET revoked_at=now() WHERE id=$1', [a.id]); // revoke not yet committed
    const read = get(s.coach.token, `/wellness-shared/${a.id}`);
    await new Promise((r) => setTimeout(r, 300));
    await c.query('COMMIT');
    assert.equal((await read).status, 403);
  } finally { c.release(); }
});
