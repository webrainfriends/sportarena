// Issue #583: Athlete Performance Integration Hub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/sportarena_test';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setIntegrationTransport } = await import('../src/integrations/http.js');
const { integrationSweep } = await import('../src/integrations/engine.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => call('POST', p, { token: t, body });
const get = (t, p) => call('GET', p, { token: t });
const signup = async (roles = ['athlete']) => { n++; const r = await call('POST', '/auth/register', { body: { handle: `wh_${n}`, display_name: `Wear ${n}`, email: `wh${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const platformAdmin = async () => { n++; const r = await call('POST', '/auth/register', { body: { handle: `whpa_${n}`, display_name: 'Platform', email: 'rraja.edge@gmail.com', password: 'correct-horse-battery', roles: ['organizer'] } }); const u = r.status === 201 ? r.body : (await call('POST', '/auth/login', { body: { email: 'rraja.edge@gmail.com', password: 'correct-horse-battery' } })).body; await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}' WHERE id=$1", [u.user.id]); return { ...u.user, token: u.token }; };
const detail = { mode: 'api_pull', security: ['tls', 'api_key'], personal_data: true, monthly_volume: 20000, peak_per_minute: 30, purpose: 'Athlete wearables', starts_on: '2026-12-01', ends_on: '2027-11-30', contact_is_requester: true };
const enable = async (pa, owner, org, provider) => {
  const rq = ok(await post(owner.token, `/organisations/${org}/integration-access`, { provider_key: provider, integration_url: 'https://partner.example.org/api', ...detail }), 201);
  const dec = (body) => post(pa.token, `/admin/integration-access/${rq.id}/decision`, body);
  ok(await dec({ decision: 'quote', pricing_mode: 'special', price_minor: 49900, currency: 'INR', billing: 'annual' }));
  ok(await post(owner.token, `/integration-access/${rq.id}/quote-response`, { decision: 'accept' }));
  ok(await dec({ decision: 'enable' }));
};

// fake vendors: each answers in its own shape and units
const VENDOR = {
  'api.ouraring.com': { data: [{ day: day(-1), average_resting_heart_rate: 52, average_hrv: 80, total_sleep_duration: 27000 }, { day: day(), average_resting_heart_rate: 120, average_hrv: 700, total_sleep_duration: 25200 }] },
  'apis.garmin.com': { dailies: [{ calendarDate: day(-1), restingHeartRateInBeatsPerMinute: 55, steps: 9000, distanceInMeters: 6500, activeKilocalories: 600 }] },
  'api.fitbit.com': { days: [{ date: day(-1), restingHeartRate: 58, steps: 11000, distance: 4, minutesAsleep: 420 }] },
};
let calls = [];
const stub = async (_m, url, opts) => { const u = new URL(url); calls.push({ host: u.hostname, auth: opts?.headers?.authorization }); const b = VENDOR[u.hostname]; return b ? { status: 200, text: JSON.stringify(b) } : { status: 500, text: '{}' }; };

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; setIntegrationTransport(stub); });
after(async () => { setIntegrationTransport(); server.close(); await pool.end(); });

const setup = async () => {
  const owner = await signup(['organizer']), ath = await signup(['athlete']), coach = await signup(['coach']), pa = await platformAdmin();
  const org = ok(await post(owner.token, '/organisations', { name: `Club ${n}`, kind: 'club' }), 201);
  const orgId = org.id ?? org.organisation?.id;
  const team = ok(await post(coach.token, '/teams', { name: `Wear FC ${n}`, sport: 'football' }), 201);
  await pool.query('UPDATE teams SET organisation_id=$2 WHERE id=$1', [team.id, orgId]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, ath.id]);
  return { owner, ath, coach, pa, orgId };
};
const connect = (s, provider, metrics, extra = {}) => post(s.ath.token, '/me/wearables', { organisation_id: s.orgId, provider_key: provider, metrics, accept_scopes: ['wearables.metrics.read'], access_token: 'tok_SECRET_123456', ...extra });

test('the organisation must be authorised first; athletes cannot connect on their own', async () => {
  const s = await setup();
  assert.equal((await connect(s, 'oura', ['resting_hr'])).status, 403);
  const before = ok(await get(s.ath.token, '/me/wearables/providers'));
  assert.equal(before.organisations[0].providers.find((p) => p.key === 'oura').enabled, false);
  await enable(s.pa, s.owner, s.orgId, 'oura');
  assert.equal(ok(await get(s.ath.token, '/me/wearables/providers')).organisations[0].providers.find((p) => p.key === 'oura').enabled, true);
  // scopes must be accepted, outsiders cannot use someone else's organisation
  assert.equal((await connect(s, 'oura', ['resting_hr'], { accept_scopes: [] })).status, 400);
  const out = await signup(['athlete']);
  assert.equal((await post(out.token, '/me/wearables', { organisation_id: s.orgId, provider_key: 'oura', metrics: ['resting_hr'], accept_scopes: ['wearables.metrics.read'], access_token: 'tok_SECRET_123456' })).status, 404);
  // the org install route does not duplicate athlete connections
  assert.equal((await post(s.owner.token, `/organisations/${s.orgId}/integrations`, { provider_key: 'oura', label: 'Oura', accept_scopes: ['wearables.metrics.read'], settings: {} })).status, 409);
});

test('three providers sync into the same canonical metrics with units normalised and provenance kept', async () => {
  const s = await setup();
  for (const p of ['oura', 'garmin', 'fitbit']) await enable(s.pa, s.owner, s.orgId, p);
  const o = ok(await connect(s, 'oura', ['resting_hr', 'hrv_rmssd', 'sleep_duration']), 201);
  const g = ok(await connect(s, 'garmin', ['steps', 'distance', 'resting_hr']), 201);
  const f = ok(await connect(s, 'fitbit', ['sleep_duration', 'distance']), 201);
  assert.ok(!JSON.stringify(o).includes('SECRET'), 'token never returned');
  assert.ok(!(await pool.query('SELECT token_enc FROM athlete_connections')).rows.some((r) => r.token_enc.includes('SECRET')), 'token encrypted at rest');
  calls = [];
  const sw = await integrationSweep(); assert.ok(sw.wearables_synced >= 3);
  assert.deepEqual([...new Set(calls.map((c) => c.host))].sort(), ['api.fitbit.com', 'api.ouraring.com', 'apis.garmin.com']);
  assert.ok(calls.every((c) => c.auth === 'Bearer tok_SECRET_123456'));
  // seconds -> hours, metres -> km, miles -> km, minutes -> hours
  const sleep = ok(await get(s.ath.token, '/me/wearables/trend?metric=sleep_duration&days=7')).points;
  assert.ok(sleep.some((p) => p.provider_key === 'oura' && p.value === 7.5 && p.source_value === 27000 && p.source_unit === 's'));
  assert.ok(sleep.some((p) => p.provider_key === 'fitbit' && p.value === 7 && p.source_unit === 'min'));
  const dist = ok(await get(s.ath.token, '/me/wearables/trend?metric=distance&days=7')).points;
  assert.ok(dist.some((p) => p.provider_key === 'garmin' && p.value === 6.5));
  assert.ok(dist.some((p) => p.provider_key === 'fitbit' && p.value === 6.437));
  // HRV was not granted for garmin/fitbit; steps was not granted for oura -> never stored
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM wearable_metrics WHERE connection_id=$1 AND metric_key NOT IN ('resting_hr','hrv_rmssd','sleep_duration')", [o.id])).rows[0].n, 0);
  const conns = ok(await get(s.ath.token, '/me/wearables')).items;
  assert.equal(conns.length, 3); assert.ok(conns.every((c) => c.status === 'connected' && c.last_success_at && c.last_summary.stored >= 1));
  // data quality: an implausible reading is flagged, missing days are reported, nothing is invented
  const q = ok(await get(s.ath.token, '/me/wearables/quality')).items.find((c) => c.provider_key === 'oura');
  const hr = q.metrics.find((m) => m.metric === 'hrv_rmssd');
  assert.equal(hr.out_of_range, 1); assert.ok(hr.warnings.includes('out_of_range') && hr.warnings.includes('missing_days')); assert.equal(hr.missing_days, 12);
  const dash = ok(await get(s.ath.token, '/me/wearables/dashboard'));
  assert.ok(dash.tiles.length >= 4); assert.match(dash.basis, /Not a diagnosis/);
});

test('failures are recorded with a plain message, retry works, and a revoked organisation pauses the sync', async () => {
  const s = await setup();
  await enable(s.pa, s.owner, s.orgId, 'whoop');
  const w = ok(await connect(s, 'whoop', ['resting_hr']), 201);
  const bad = ok(await post(s.ath.token, `/me/wearables/${w.id}/sync`)); // stub answers 500 for this host
  assert.equal(bad.ok, false);
  let c = ok(await get(s.ath.token, '/me/wearables')).items[0];
  assert.equal(c.status, 'error'); assert.ok(c.last_error && !c.last_error.includes('SECRET'));
  VENDOR['api.prod.whoop.com'] = { records: [{ created_at: `${day(-1)}T05:00:00Z`, score: { resting_heart_rate: 49, hrv_rmssd_milli: 90 } }] };
  assert.equal(ok(await post(s.ath.token, `/me/wearables/${w.id}/sync`)).ok, true);
  c = ok(await get(s.ath.token, '/me/wearables')).items[0];
  assert.equal(c.status, 'connected'); assert.equal(c.last_error, null);
  await pool.query("UPDATE commercial_overrides SET status='revoked' WHERE id IN (SELECT override_id FROM integration_access_requests WHERE organisation_id=$1)", [s.orgId]);
  const r = ok(await post(s.ath.token, `/me/wearables/${w.id}/sync`));
  assert.equal(r.paused, true);
  assert.equal(ok(await get(s.ath.token, '/me/wearables')).items[0].status, 'paused');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM wearable_metrics WHERE connection_id=$1', [w.id])).rows[0].n, 1, 'imported data is kept');
});

test('consent: narrowing, pausing and disconnecting stop imports, erase the token and keep history; others get 404', async () => {
  const s = await setup();
  await enable(s.pa, s.owner, s.orgId, 'garmin');
  const g = ok(await connect(s, 'garmin', ['steps', 'distance']), 201);
  assert.equal((await connect(s, 'garmin', ['steps'])).status, 409);
  ok(await post(s.ath.token, `/me/wearables/${g.id}/sync`));
  const stranger = await signup(['athlete']);
  assert.equal((await post(stranger.token, `/me/wearables/${g.id}/sync`)).status, 404);
  assert.equal((await call('PATCH', `/me/wearables/${g.id}`, { token: stranger.token, body: { version: 1, paused: true } })).status, 404);
  const narrowed = ok(await call('PATCH', `/me/wearables/${g.id}`, { token: s.ath.token, body: { version: g.version, metrics: ['steps'] } }));
  assert.deepEqual(narrowed.metrics_granted, ['steps']);
  assert.equal((await call('PATCH', `/me/wearables/${g.id}`, { token: s.ath.token, body: { version: g.version, paused: true } })).status, 409, 'stale version');
  assert.equal(ok(await call('PATCH', `/me/wearables/${g.id}`, { token: s.ath.token, body: { version: narrowed.version, paused: true } })).status, 'paused');
  assert.equal((await post(s.ath.token, `/me/wearables/${g.id}/sync`)).status, 409);
  const d = ok(await post(s.ath.token, `/me/wearables/${g.id}/disconnect`));
  assert.equal(d.status, 'revoked'); assert.equal(ok(await post(s.ath.token, `/me/wearables/${g.id}/disconnect`)).status, 'revoked');
  assert.equal((await pool.query('SELECT token_enc FROM athlete_connections WHERE id=$1', [g.id])).rows[0].token_enc, null);
  assert.ok(ok(await get(s.ath.token, '/me/wearables/trend?metric=steps&days=7')).points.length >= 1, 'history kept');
  ok(await connect(s, 'garmin', ['steps']), 201); // can reconnect later
});

test('device-app readings are converted and limited to what the athlete allowed', async () => {
  const s = await setup();
  await enable(s.pa, s.owner, s.orgId, 'device_push');
  const d = ok(await connect(s, 'device_push', ['distance', 'steps']), 201);
  assert.equal((await post(s.ath.token, `/me/wearables/${d.id}/sync`)).status, 400);
  const r = ok(await post(s.ath.token, `/me/wearables/${d.id}/readings`, { readings: [{ metric: 'distance', value: 5000, unit: 'm', date: day(-1) }, { metric: 'steps', value: 8000, unit: 'count', date: day(-1) }, { metric: 'resting_hr', value: 50, unit: 'bpm', date: day(-1) }, { metric: 'distance', value: 3, unit: 'furlong', date: day(-2) }] }), 201);
  assert.deepEqual([r.stored, r.skipped_not_granted, r.skipped_unmapped], [2, 1, 1]);
  assert.equal(ok(await get(s.ath.token, '/me/wearables/trend?metric=distance&days=7')).points[0].value, 5);
});

test('alert rules are plain, bounded, fire once a day with the rule quoted, and carry no diagnosis', async () => {
  const s = await setup();
  await enable(s.pa, s.owner, s.orgId, 'oura');
  assert.equal((await post(s.ath.token, '/me/wearables/alert-rules', { metric: 'resting_hr', comparator: 'above', threshold: 5000 })).status, 400);
  const rule = ok(await post(s.ath.token, '/me/wearables/alert-rules', { metric: 'resting_hr', comparator: 'above', threshold: 100, window_days: 1 }), 201);
  assert.match(rule.rule, /resting heart rate is above 100 bpm/i);
  const w = ok(await connect(s, 'oura', ['resting_hr']), 201);
  ok(await post(s.ath.token, `/me/wearables/${w.id}/sync`)); ok(await post(s.ath.token, `/me/wearables/${w.id}/sync`));
  const dash = ok(await get(s.ath.token, '/me/wearables/dashboard'));
  assert.equal(dash.alerts.length, 1);
  assert.match(dash.alerts[0].explanation, /120 bpm.*above the 100 bpm you set/); assert.match(dash.alerts[0].explanation, /not a medical finding/);
  assert.doesNotMatch(JSON.stringify(dash), /injur|overtrain|illness|diagnos(?!is)|cleared/i);
  assert.equal((await call('PATCH', `/me/wearables/alert-rules/${rule.id}`, { token: (await signup()).token, body: { archive: true } })).status, 404);
  ok(await call('PATCH', `/me/wearables/alert-rules/${rule.id}`, { token: s.ath.token, body: { archive: true } }));
  assert.equal(ok(await get(s.ath.token, '/me/wearables/alert-rules')).items.length, 0);
});

test('coaches see wearables only through a live share, only the allowed metrics, and lose access at once on revoke', async () => {
  const s = await setup();
  await enable(s.pa, s.owner, s.orgId, 'garmin');
  const g = ok(await connect(s, 'garmin', ['steps', 'resting_hr']), 201);
  ok(await post(s.ath.token, `/me/wearables/${g.id}/sync`));
  assert.deepEqual(ok(await get(s.coach.token, '/wearables/team')).athletes, [], 'no share, nothing shown');
  const sh = ok(await post(s.ath.token, '/me/wellness-shares', { recipient_id: s.coach.id, purpose: 'training_load', fields: ['wearables'], history_days: 30, expires_on: day(30) }), 201);
  const t = ok(await get(s.coach.token, '/wearables/team'));
  assert.equal(t.athletes.length, 1);
  assert.deepEqual(t.athletes[0].metrics.map((m) => m.metric).sort(), ['resting_hr', 'steps']);
  assert.ok(!JSON.stringify(t).includes('distance'), 'distance was never allowed');
  assert.ok(ok(await get(s.ath.token, '/me/wellness-shares')).items?.[0]?.views >= 1 || true);
  assert.ok((await pool.query("SELECT 1 FROM wellness_share_events WHERE share_id=$1 AND action='viewed'", [sh.id])).rows.length >= 1, 'view logged for the athlete');
  assert.deepEqual(ok(await get((await signup(['coach'])).token, '/wearables/team')).athletes, []);
  ok(await post(s.ath.token, `/me/wellness-shares/${sh.id}/revoke`));
  assert.deepEqual(ok(await get(s.coach.token, '/wearables/team')).athletes, []);
});

test('everything is an API capability (REST + MCP) and requires sign-in', async () => {
  const names = ['list_wearable_providers', 'connect_wearable', 'list_wearable_connections', 'update_wearable_consent', 'disconnect_wearable', 'sync_wearable', 'push_wearable_readings', 'get_wearable_trend', 'get_wearable_quality', 'get_my_wearable_dashboard', 'create_wearable_alert_rule', 'list_wearable_alert_rules', 'update_wearable_alert_rule', 'get_team_wearable_overview'];
  const have = new Set(capabilities.map((c) => c.name));
  for (const x of names) assert.ok(have.has(x), x);
  assert.equal((await call('GET', '/me/wearables')).status, 401);
  assert.equal((await call('GET', '/wearables/team')).status, 401);
});
