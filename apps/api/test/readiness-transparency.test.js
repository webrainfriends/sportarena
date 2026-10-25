// Issue #329: transparent readiness and workload indicators, with qualified, versioned, revocable configuration.
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
  const r = await api('POST', '/auth/register', { body: { handle: `rt_${n}_${roles[0]}`, display_name: `Share ${n}`, email: `rt${n}@example.com`, password: 'correct-horse-battery', roles } });
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


const { readiness, workload, explain, configProblems, DEFAULT_CONFIG, history } = await import('../src/readiness.js');

/** an athlete with a few logged days, a coach who coaches them, a team-mate and a sponsor */
const setup = async () => {
  const ath = await signup(['athlete']), coach = await signup(['coach']), mate = await signup(['athlete']);
  const team = ok(await post(coach.token, '/teams', { name: `Ready FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  for (const u of [ath, mate]) await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, u.id]);
  return { ath, coach, mate };
};
const share = (s, fields = ['readiness', 'workload', 'sleep'], extra = {}) => post(s.ath.token, '/me/wellness-shares', { recipient_id: s.coach.id, purpose: 'training_load', fields, history_days: 30, expires_on: day(30), ...extra });
const cfg = (o = {}) => ({
  weights: { sleep: 0.5, soreness: 0.3, mood: 0.2 }, bands: { ready_min: 75, moderate_min: 45 },
  workload: { low_below: 0.8, optimal_max: 1.3, caution_max: 1.5, caution_penalty: 5, high_penalty: 10, min_span_days: 20 }, ...o,
});
const setCfg = (s, shareId, version, o = {}) => post(s.coach.token, `/wellness-shared/${shareId}/readiness-config`, { version, reason: 'Heavy sleep deficit drives his injuries', ...cfg(), ...o });

test('engine: standard settings reproduce the original score exactly; custom settings change it; bad settings are explained', () => {
  const full = { sleep_hours: 8, sleep_quality: 5, soreness: 0, mood: 5 };
  assert.equal(readiness({ wellness: full, config: DEFAULT_CONFIG }).score, 100);
  assert.equal(readiness({ wellness: { sleep_hours: 4 }, config: null }).score, 50);
  const heavySleep = { ...DEFAULT_CONFIG, weights: { sleep: 0.6, soreness: 0.2, mood: 0.2 } };
  assert.notEqual(readiness({ wellness: { sleep_hours: 4, soreness: 0, mood: 5 }, config: heavySleep }).score, readiness({ wellness: { sleep_hours: 4, soreness: 0, mood: 5 } }).score);
  assert.equal(readiness({ wellness: { sleep_hours: 5 }, config: { bands: { ready_min: 90, moderate_min: 70 } } }).band, 'rest');
  assert.deepEqual(configProblems(DEFAULT_CONFIG), []);
  assert.match(configProblems({ ...DEFAULT_CONFIG, weights: { sleep: 0.8, soreness: 0.1, mood: 0.1 } }).join(), /between 10% and 70%/);
  assert.match(configProblems({ ...DEFAULT_CONFIG, weights: { sleep: 0.4, soreness: 0.4, mood: 0.4 } }).join(), /add up to 100%/);
  assert.match(configProblems({ ...DEFAULT_CONFIG, bands: { ready_min: 60, moderate_min: 60 } }).join(), /below/);
  assert.match(configProblems({ ...DEFAULT_CONFIG, workload: { ...DEFAULT_CONFIG.workload, high_penalty: 1 } }).join(), /high-workload/);
  assert.match(configProblems({ ...DEFAULT_CONFIG, workload: { ...DEFAULT_CONFIG.workload, low_below: 0.9, optimal_max: 1.2, caution_max: 1.2 } }).join(), /rise/);
});

test('engine: explanation covers inputs, coverage, confidence, workload basis and hides what a viewer was not given', () => {
  const none = explain({ date: '2026-10-25' });
  assert.equal(none.score, null); assert.equal(none.coverage.level, 'none'); assert.equal(none.confidence, 'none'); assert.equal(none.missing.length, 3);
  const part = explain({ date: '2026-10-25', wellness: { sleep_hours: 4, mood: 5 }, daysLogged: { d7: 1, d28: 1 } });
  assert.equal(part.coverage.level, 'partial'); assert.equal(part.coverage.weight_covered, 0.65); assert.equal(part.confidence, 'low');
  assert.deepEqual(part.missing.map((m) => m.key), ['soreness']);
  const sleep = part.inputs.find((i) => i.key === 'sleep');
  assert.equal(sleep.weight, 0.4); assert.equal(sleep.effective_weight, 0.615); assert.ok(Math.abs(sleep.points + part.inputs.find((i) => i.key === 'mood').points - part.score) < 1);
  const body = explain({ date: '2026-10-25', wellness: null, pain: [{ severity: 6 }] });
  assert.equal(body.inputs.find((i) => i.key === 'soreness').source, 'body_map');
  const good = explain({ date: '2026-10-25', wellness: { sleep_hours: 8, soreness: 1, mood: 4 }, daysLogged: { d7: 5, d28: 20 } });
  assert.equal(good.confidence, 'good'); assert.equal(good.formula.validated_for_injury_prediction, false); assert.equal(good.formula.medical_clearance, false);
  assert.ok(good.limitations.some((l) => /not been validated/.test(l)));
  const hidden = explain({ date: '2026-10-25', wellness: { sleep_hours: 8, soreness: 1, mood: 4 }, shown: new Set(['sleep']) });
  assert.equal(hidden.inputs.find((i) => i.key === 'mood').raw, null); assert.equal(hidden.inputs.find((i) => i.key === 'mood').logged, true); assert.equal(hidden.workload.hidden, true);
  assert.ok(hidden.inputs.find((i) => i.key === 'sleep').raw.sleep_hours === 8);
  // a spike that is not yet trusted does not move the score, and says why
  const spike = explain({ date: '2026-10-25', wellness: { sleep_hours: 8 }, loads: [{ session_date: '2026-10-24', load: 900 }] });
  assert.equal(spike.workload.trusted, false); assert.equal(spike.workload.counts_toward_score, false); assert.match(spike.workload.reason, /Needs 20 days/);
  const days = history({ from: '2026-10-24', to: '2026-10-25', wellnessRows: [{ log_date: '2026-10-25', sleep_hours: 8 }], painRows: [], loads: [] });
  assert.deepEqual(days.map((d) => d.score), [null, 100]);
});

test('an athlete with nothing logged gets an honest, empty explanation; logging fills it in and history shows each day', async () => {
  const s = await setup();
  const e0 = ok(await get(s.ath.token, '/me/readiness/explanation'));
  assert.equal(e0.score, null); assert.equal(e0.coverage.level, 'none'); assert.equal(e0.missing.length, 3); assert.equal(e0.settings.source, 'standard');
  assert.equal(e0.workload.status, 'no_data'); assert.match(e0.workload.reason, /No sessions/);
  ok(await post(s.ath.token, '/me/wellness', { date: day(), sleep_hours: 7, sleep_quality: 4, mood: 4 }));
  ok(await post(s.ath.token, '/me/wellness', { date: day(-1), sleep_hours: 8, sleep_quality: 5, soreness: 2, mood: 5 }));
  ok(await post(s.ath.token, '/me/body-pain', { region: 'knee', side: 'left', severity: 7 }), 201);
  const e1 = ok(await get(s.ath.token, '/me/readiness/explanation'));
  assert.equal(e1.coverage.inputs_logged, 3); assert.equal(e1.inputs.find((i) => i.key === 'soreness').source, 'body_map');
  assert.equal(e1.score, ok(await get(s.ath.token, '/me/readiness')).score, 'explanation and the headline score agree');
  const h = ok(await get(s.ath.token, `/me/readiness/history?from=${day(-3)}&to=${day()}`));
  assert.equal(h.days.length, 4); assert.equal(h.days[0].score, null); assert.equal(h.days[0].logged, false);
  assert.equal(h.days[2].inputs_logged, 3); assert.equal(h.days[2].score, 93, 'yesterday: full marks from the daily log, the later body-map entry did not exist yet');
  assert.equal(h.days[3].score, e1.score);
  assert.equal((await get(s.ath.token, `/me/readiness/history?from=${day(-200)}&to=${day()}`)).status, 400);
  assert.equal((await get(s.ath.token, `/me/readiness/explanation?date=${day(5)}`)).status, 400);
  // the body-map entry did not exist yesterday-before-it-was-logged: day -3 stays empty
  assert.equal(h.days[1].score, null);
});

test('staff see the explanation only through a live share that includes readiness, with only the shared raw values', async () => {
  const s = await setup();
  ok(await post(s.ath.token, '/me/wellness', { date: day(), sleep_hours: 7, sleep_quality: 4, soreness: 2, mood: 3 }));
  const noReadiness = ok(await share(s, ['sleep']), 201);
  assert.equal((await get(s.coach.token, `/wellness-shared/${noReadiness.id}/readiness`)).status, 403);
  assert.equal((await setCfg(s, noReadiness.id, 0)).status, 403);
  ok(await post(s.ath.token, `/me/wellness-shares/${noReadiness.id}/revoke`, {}));
  const a = ok(await share(s), 201);
  const v = ok(await get(s.coach.token, `/wellness-shared/${a.id}/readiness`));
  assert.equal(v.inputs.find((i) => i.key === 'sleep').raw.sleep_hours, 7);
  assert.equal(v.inputs.find((i) => i.key === 'mood').raw, null); assert.equal(v.inputs.find((i) => i.key === 'mood').points, null);
  assert.equal(v.inputs.find((i) => i.key === 'mood').logged, true);
  assert.equal(v.history.length, 28); assert.equal(v.history.at(-1).date, day()); assert.ok(!JSON.stringify(v.history).includes('sleep_hours'));
  assert.equal(v.can_configure, true); assert.ok(v.bounds.weights);
  assert.ok(ok(await get(s.ath.token, '/me/wellness-shares')).activity.some((x) => x.action === 'viewed'));
  assert.equal((await get(s.mate.token, `/wellness-shared/${a.id}/readiness`)).status, 404, 'a team-mate learns nothing');
  assert.equal((await get(s.coach.token, `/wellness-shared/${a.id}/readiness?date=${day(-90)}`)).status, 400, 'outside the shared window');
  ok(await post(s.ath.token, `/me/wellness-shares/${a.id}/revoke`, {}));
  assert.equal((await get(s.coach.token, `/wellness-shared/${a.id}/readiness`)).status, 403, 'revocation applies on the next read');
});

test('qualified configuration: validated, reasoned, versioned, idempotent, visible to the athlete, resettable, and tied to the live share', async () => {
  const s = await setup();
  ok(await post(s.ath.token, '/me/wellness', { date: day(), sleep_hours: 4, soreness: 0, mood: 5 }));
  const standard = ok(await get(s.ath.token, '/me/readiness')).score;
  const a = ok(await share(s), 201);
  // invalid input is explained and nothing is stored
  const bad = await setCfg(s, a.id, 0, { weights: { sleep: 0.8, soreness: 0.1, mood: 0.1 } });
  assert.equal(bad.status, 400); assert.match(bad.body.error.message, /between 10% and 70%/);
  assert.equal((await setCfg(s, a.id, 0, { reason: 'short' })).status, 400, 'a written reason is required');
  assert.equal((await setCfg(s, a.id, 0, { weights: { sleep: 0.5, soreness: 0.3, mood: 0.3 } })).status, 400);
  assert.equal((await pool.query('SELECT 1 FROM readiness_configs WHERE athlete_id=$1', [s.ath.id])).rowCount, 0);
  // a team-mate and the athlete themself cannot configure through the staff route
  assert.equal((await post(s.mate.token, `/wellness-shared/${a.id}/readiness-config`, { version: 0, reason: 'Not my athlete here', ...cfg() })).status, 404);
  const r1 = ok(await setCfg(s, a.id, 0));
  assert.equal(r1.version, 1); assert.equal(r1.changed, true);
  // a retry of the same request returns the same version instead of forking
  const again = ok(await setCfg(s, a.id, 0)); assert.equal(again.version, 1); assert.equal(again.changed, false);
  assert.equal((await pool.query('SELECT 1 FROM readiness_configs WHERE athlete_id=$1', [s.ath.id])).rowCount, 1);
  // a stale version is refused with the current one
  const stale = await setCfg(s, a.id, 0, { bands: { ready_min: 80, moderate_min: 50 } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details.code, 'stale_version'); assert.equal(stale.body.error.details.version, 1);
  // the athlete sees who changed what and why; the score now uses the new weights
  const conf = ok(await get(s.ath.token, '/me/readiness/config'));
  assert.equal(conf.current.source, 'custom'); assert.equal(conf.current.version, 1); assert.equal(conf.current.set_by.id, s.coach.id);
  assert.equal(conf.versions[0].reason, 'Heavy sleep deficit drives his injuries'); assert.equal(conf.current.weights.sleep, 0.5);
  assert.equal(conf.standard.weights.sleep, 0.4);
  assert.equal(standard, 80); assert.equal(ok(await get(s.ath.token, '/me/readiness')).score, 75, 'sleep 4 h, no soreness, great mood: 0.5x0.5 + 0.3 + 0.2');
  const ex = ok(await get(s.ath.token, '/me/readiness/explanation'));
  assert.equal(ex.settings.version, 1); assert.equal(ex.inputs.find((i) => i.key === 'sleep').weight, 0.5);
  assert.equal(ex.score, 75);
  assert.equal(ex.thresholds.bands.ready_min, 75);
  const sh = ok(await get(s.coach.token, `/wellness-shared/${a.id}`));
  assert.equal(sh.readiness.score, 75, 'the coach sees the same score the athlete does'); assert.equal(sh.readiness.settings_source, 'custom');
  // the reason is encrypted at rest and reading it is audit-logged; the athlete was told
  const raw = (await pool.query('SELECT rationale_enc FROM readiness_configs WHERE athlete_id=$1', [s.ath.id])).rows[0].rationale_enc;
  assert.ok(raw && !raw.includes('sleep deficit'));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_readiness_config'", [s.ath.id])).rowCount >= 1);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='readiness_config_changed'", [s.ath.id])).rowCount === 1);
  assert.ok(ok(await get(s.ath.token, '/me/wellness-shares')).activity.some((x) => x.action === 'updated'));
  // a second change is version 2; history keeps both
  ok(await setCfg(s, a.id, 1, { bands: { ready_min: 80, moderate_min: 50 } }));
  assert.equal(ok(await get(s.ath.token, '/me/readiness/config')).versions.length, 2);
  // the athlete resets: stale refused, then a new version on the standard; repeating is harmless
  assert.equal((await post(s.ath.token, '/me/readiness/config/reset', { version: 1 })).status, 409);
  const reset = ok(await post(s.ath.token, '/me/readiness/config/reset', { version: 2 }));
  assert.equal(reset.version, 3); assert.equal(reset.changed, true);
  assert.equal(ok(await post(s.ath.token, '/me/readiness/config/reset', { version: 3 })).changed, false);
  assert.equal(ok(await get(s.ath.token, '/me/readiness/explanation')).settings.source, 'standard');
  assert.equal(ok(await get(s.ath.token, '/me/readiness')).score, standard);
  assert.equal(ok(await get(s.ath.token, '/me/readiness/config')).versions.length, 3, 'nothing was deleted');
  // a custom version only applies while its share is live: revoke -> standard + paused
  ok(await setCfg(s, a.id, 3));
  assert.equal(ok(await get(s.ath.token, '/me/readiness/explanation')).settings.source, 'custom');
  ok(await post(s.ath.token, `/me/wellness-shares/${a.id}/revoke`, {}));
  const paused = ok(await get(s.ath.token, '/me/readiness/explanation'));
  assert.equal(paused.settings.source, 'standard'); assert.equal(paused.settings.status, 'paused'); assert.match(paused.settings.paused_reason, /stopped sharing/);
  assert.equal(paused.score, standard);
  assert.equal((await setCfg(s, a.id, 4)).status, 403, 'a revoked share cannot configure');
});

test('young athletes: a guardian can read and reset the settings; consent withdrawn stops staff configuring; others see nothing', async () => {
  const s = await setup();
  const parent = await signup(['athlete']);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [s.ath.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, s.ath.id]);
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'coaching',$2,1, now() + interval '30 days')", [s.ath.id, parent.id]);
  const a = ok(await share(s), 201);
  ok(await setCfg(s, a.id, 0));
  assert.equal(ok(await get(parent.token, `/me/readiness/config?athlete_id=${s.ath.id}`)).current.version, 1);
  assert.equal((await get(s.mate.token, `/me/readiness/config?athlete_id=${s.ath.id}`)).status, 404);
  assert.equal((await post(s.mate.token, '/me/readiness/config/reset', { athlete_id: s.ath.id, version: 1 })).status, 404);
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [s.ath.id]);
  assert.equal((await setCfg(s, a.id, 1)).status, 403, 'consent is checked live');
  assert.equal((await get(s.coach.token, `/wellness-shared/${a.id}/readiness`)).status, 403);
  assert.equal(ok(await get(s.ath.token, '/me/readiness/explanation')).settings.status, 'paused');
  const r = ok(await post(parent.token, '/me/readiness/config/reset', { athlete_id: s.ath.id, version: 1 }));
  assert.equal(r.version, 2);
  assert.equal((await pool.query('SELECT set_by_kind FROM readiness_configs WHERE athlete_id=$1 AND version=2', [s.ath.id])).rows[0].set_by_kind, 'guardian');
});

test('concurrent staff changes cannot fork versions; MCP and OpenAPI expose the new capabilities', async () => {
  const s = await setup();
  const a = ok(await share(s), 201);
  const rs = await Promise.all([setCfg(s, a.id, 0), setCfg(s, a.id, 0, { bands: { ready_min: 80, moderate_min: 50 } }), setCfg(s, a.id, 0, { bands: { ready_min: 85, moderate_min: 55 } })]);
  assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.equal(rs.filter((r) => r.status === 409).length, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM readiness_configs WHERE athlete_id=$1', [s.ath.id])).rows[0].n, 1);
  const res = await rpc('explain_readiness', {}, s.ath.token);
  assert.ok(!res.isError, JSON.stringify(res));
  for (const name of ['get_readiness_history', 'get_readiness_config', 'reset_readiness_config', 'get_shared_readiness', 'set_shared_readiness_config']) {
    const r = await rpc(name, { id: a.id, version: 1 }, s.ath.token);
    assert.ok(r, name);
  }
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  for (const p of ['/me/readiness/explanation', '/me/readiness/history', '/me/readiness/config', '/me/readiness/config/reset', '/wellness-shared/{id}/readiness', '/wellness-shared/{id}/readiness-config']) assert.ok(spec.paths[p], p);
  // existing behaviour is unchanged for someone who never configured anything
  const t = await signup(['athlete']);
  ok(await post(t.token, '/me/wellness', { date: day(), sleep_hours: 4 }));
  assert.equal(ok(await get(t.token, '/me/readiness')).score, 50);
});
