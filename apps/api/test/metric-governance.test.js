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
const signup = async (roles, admin = false) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `mg_${n}_${roles[0]}`, display_name: `Mg ${n}`, email: `mg${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let u = { ...r.body.user, token: r.body.token };
  if (admin) {
    await pool.query("UPDATE users SET roles = roles || '{admin}' WHERE id=$1", [u.id]);
    u = { ...u, roles: [...u.roles, 'admin'] }; // the registration token keeps working (roles are read live); signing in again would drop the label, since the account is not on the platform-admin list
  }
  return u;
};
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const v1 = (over = {}) => ({ sport: 'athletics', metric: '100m_time_s', label: '100 m time', expected_version: 0, unit: 's', direction: 'lower', aggregation: 'best', value_kind: 'decimal', min_value: 8, max_value: 40, points_mode: 'flat', points_value: 10, note: 'federation rule', ...over });

test('only admins or appointed governors publish; readers see the rule', async () => {
  const adm = await signup(['athlete'], true), pl = await signup(['athlete']);
  assert.equal((await api('POST', '/metric-definitions', { token: pl.token, body: v1() })).status, 403);
  assert.equal((await api('POST', '/metric-definitions', { body: v1() })).status, 401);
  const ok = await api('POST', '/metric-definitions', { token: adm.token, body: v1() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.version.version, 1);
  const list = await api('GET', '/metric-definitions?sport=athletics', { token: pl.token });
  assert.equal(list.body.can_govern, false);
  assert.equal(list.body.metrics[0].direction, 'lower');
  assert.equal(Number(list.body.metrics[0].min_value), 8);
  // appoint a governor for athletics only
  assert.equal((await api('POST', '/metric-governors', { token: pl.token, body: { user_id: pl.id, active: true } })).status, 403);
  assert.equal((await api('POST', '/metric-governors', { token: adm.token, body: { user_id: pl.id, sport: 'athletics', active: true } })).status, 200);
  assert.equal((await api('POST', '/metric-definitions', { token: pl.token, body: v1({ sport: 'basketball', metric: 'points', unit: 'count', direction: 'higher', value_kind: 'integer', min_value: 0, max_value: 200, points_value: 1, points_mode: 'per_unit' }) })).status, 403, 'not their sport');
  assert.equal((await api('POST', '/metric-definitions', { token: pl.token, body: v1({ expected_version: 1, max_value: 30 }) })).status, 201);
  await api('POST', '/metric-governors', { token: adm.token, body: { user_id: pl.id, sport: 'athletics', active: false } });
  assert.equal((await api('POST', '/metric-definitions', { token: pl.token, body: v1({ expected_version: 2, max_value: 35 }) })).status, 403, 'revoked');
});

test('validation, stale versions and retries', async () => {
  const adm = await signup(['athlete'], true);
  const b = v1({ metric: '200m_time_s' });
  assert.equal((await api('POST', '/metric-definitions', { token: adm.token, body: { ...b, min_value: 50, max_value: 10 } })).status, 422);
  assert.equal((await api('POST', '/metric-definitions', { token: adm.token, body: { ...b, value_kind: 'integer', min_value: 0.5 } })).status, 422);
  const a = await api('POST', '/metric-definitions', { token: adm.token, body: { ...b, client_key: 'retry-key-1' } });
  assert.equal(a.status, 201);
  const again = await api('POST', '/metric-definitions', { token: adm.token, body: { ...b, client_key: 'retry-key-1' } });
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.version.id, a.body.version.id, 'a retry does not publish twice');
  assert.equal((await api('POST', '/metric-definitions', { token: adm.token, body: b })).status, 409, 'new-metric form against an existing one is stale');
  assert.equal((await api('POST', '/metric-definitions', { token: adm.token, body: { ...b, expected_version: 1 } })).status, 422, 'nothing changed');
  // two people publish version 2 at once: exactly one wins
  const [x, y] = await Promise.all([1, 2].map((k) => api('POST', '/metric-definitions', { token: adm.token, body: { ...b, expected_version: 1, max_value: 30 + k } })));
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  const def = a.body.definition.id;
  const d = (await api('GET', `/metric-definitions/${def}`)).body;
  assert.equal(d.versions.length, 2);
  assert.equal(d.versions[0].changes[0].field, 'max_value');
  // versions are immutable at the database
  await assert.rejects(pool.query('UPDATE metric_definition_versions SET unit=$1', ['m']), /immutable/);
  await assert.rejects(pool.query('DELETE FROM metric_definition_versions'), /immutable/);
});

test('results keep the version they were scored under; ranges, evidence and corrections follow the version', async () => {
  const adm = await signup(['athlete'], true), org = await signup(['organizer']), ref = await signup(['referee']), ath = await signup(['athlete']);
  const pub = (body) => api('POST', '/metric-definitions', { token: adm.token, body: v1({ metric: 'sprint_time_s', label: 'Sprint', ...body }) });
  const first = await pub({ min_value: 8, max_value: 40, points_value: 10 });
  const def = first.body.definition.id;
  // practice: out of range is refused with the range in the message
  const bad = await api('POST', '/performances', { token: ath.token, body: { sport: 'athletics', metric: 'sprint_time_s', value: 3 } });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error.message ?? bad.body.message ?? JSON.stringify(bad.body), /between 8 and 40/);
  const p1 = await api('POST', '/performances', { token: ath.token, body: { sport: 'athletics', metric: 'sprint_time_s', value: 12 } });
  assert.equal(p1.status, 201);
  assert.equal(p1.body.metric_version_id, first.body.version.id);
  // an official result under v1
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Gov Meet ${++n}`, sport: 'athletics' } })).body;
  await pool.query("INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,'accepted')", [ev.id, ath.id]);
  await pool.query("INSERT INTO event_staff(event_id, user_id, role, status) VALUES ($1,$2,'timekeeper','accepted')", [ev.id, ref.id]);
  const off = await api('POST', '/performances', { token: org.token, body: { user_id: ath.id, sport: 'athletics', metric: 'sprint_time_s', value: 11.5, event_id: ev.id } });
  assert.equal(off.status, 201, JSON.stringify(off.body));
  assert.equal(off.body.official_points, 10);
  assert.equal((await api('POST', `/performances/${off.body.id}/approve`, { token: ref.token })).status, 200);
  // v2 tightens the range and changes points; stored v1 results are untouched
  const second = await pub({ expected_version: 1, min_value: 9, max_value: 20, points_value: 25, evidence_required_for: ['imported', 'self_reported'] });
  assert.equal(second.status, 201);
  const stored = (await pool.query('SELECT value, official_points, metric_version_id, rule_version FROM performances WHERE id=$1', [off.body.id])).rows[0];
  assert.equal(Number(stored.official_points), 10);
  assert.equal(stored.metric_version_id, first.body.version.id);
  // new results use v2: range, evidence for a self-reported claim
  assert.equal((await api('POST', '/performances', { token: ath.token, body: { sport: 'athletics', metric: 'sprint_time_s', value: 8.5 } })).status, 422);
  const noEv = await api('POST', '/performances', { token: ath.token, body: { sport: 'athletics', metric: 'sprint_time_s', value: 12 } });
  assert.equal(noEv.status, 422, 'v2 needs evidence even for a self-reported claim');
  assert.equal((await api('POST', '/performances', { token: ath.token, body: { sport: 'athletics', metric: 'sprint_time_s', value: 12, evidence_ref: 'https://example.com/clip' } })).body.metric_version_id, second.body.version.id);
  // a correction of the old result is judged under v1 (8.5 is valid there), and keeps v1
  const cor = await api('POST', `/performances/${off.body.id}/correct`, { token: org.token, body: { value: 8.5, reason: 'timing gate re-read' } });
  assert.equal(cor.status, 201, JSON.stringify(cor.body));
  assert.equal(cor.body.metric_version_id, first.body.version.id);
  assert.equal(Number(cor.body.official_points), 10);
  // as-of lookup and impact preview
  const d = (await api('GET', `/metric-definitions/${def}?as_of=${new Date(Date.now() - 3600e3).toISOString()}`)).body;
  assert.equal(d.version_in_force, null, 'nothing was in force an hour ago');
  const imp = await api('GET', `/metric-definitions/${def}/impact?min_value=9&max_value=20`, { token: adm.token });
  assert.equal(imp.body.rescored, 0);
  assert.ok(imp.body.outside_proposed_range >= 1);
  assert.equal((await api('GET', `/metric-definitions/${def}/impact`, { token: ath.token })).status, 403);
  // rules endpoint reflects the governed version
  const rules = await api('GET', '/scoring-rules?sport=athletics&metric=sprint_time_s');
  assert.equal(rules.body.rule.version, 2);
  assert.equal(rules.body.rule.governed, true);
});

test('aggregation drives stats and the leaderboard; retired metrics fall back to built-in rules', async () => {
  const adm = await signup(['athlete'], true), org = await signup(['organizer']), ref = await signup(['referee']);
  const a = await signup(['athlete']), b = await signup(['athlete']);
  const pub = await api('POST', '/metric-definitions', { token: adm.token, body: v1({ sport: 'basketball', metric: 'rebounds', label: 'Rebounds', unit: 'count', direction: 'higher', aggregation: 'sum', value_kind: 'integer', min_value: 0, max_value: 60, points_mode: 'per_unit', points_value: 1 }) });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Agg ${++n}`, sport: 'basketball' } })).body;
  await pool.query("INSERT INTO event_staff(event_id, user_id, role, status) VALUES ($1,$2,'scorer','accepted')", [ev.id, ref.id]);
  for (const u of [a, b]) await pool.query("INSERT INTO event_entries(event_id, user_id, status) VALUES ($1,$2,'accepted')", [ev.id, u.id]);
  const rec = async (u, value, day) => {
    const r = await api('POST', '/performances', { token: org.token, body: { user_id: u.id, sport: 'basketball', metric: 'rebounds', value, event_id: ev.id, achieved_on: day } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await api('POST', `/performances/${r.body.id}/approve`, { token: ref.token })).status, 200);
  };
  await rec(a, 6, '2026-01-01'); await rec(a, 6, '2026-01-02'); await rec(b, 10, '2026-01-01');
  const lb = (await api('GET', '/leaderboard?sport=basketball&metric=rebounds')).body;
  assert.deepEqual(lb.map((r) => r.id), [a.id, b.id], 'sum: 12 beats a single best of 10');
  assert.equal(lb[0].aggregation, 'sum');
  assert.equal(Number(lb[0].best), 12);
  const stats = (await api('GET', `/people/${a.id}/stats?sport=basketball`)).body.by_metric[0];
  assert.equal(stats.aggregation, 'sum');
  assert.equal(Number(stats.aggregate), 12);
  // retire: stored results and history stay, the metric stops being listed
  assert.equal((await api('POST', `/metric-definitions/${pub.body.definition.id}/status`, { token: a.token, body: { retired: true } })).status, 403);
  assert.equal((await api('POST', `/metric-definitions/${pub.body.definition.id}/status`, { token: adm.token, body: { retired: true } })).status, 200);
  assert.equal((await api('GET', '/metric-definitions?sport=basketball')).body.metrics.length, 0);
  assert.equal((await api('GET', '/metric-definitions?sport=basketball&include_retired=true')).body.metrics.length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS c FROM performances WHERE metric='rebounds'")).rows[0].c, 3);
});

test('governed match formats: published versions are pinned when a game starts; history is not re-scored', async () => {
  const adm = await signup(['athlete'], true), org = await signup(['organizer']), pl = await signup(['athlete']);
  const rs = (points) => ({ kind: 'points_events', label: 'Football', periods: { count: 2, label: 'Half' }, events: [{ kind: 'goal', label: 'Goal', points }], stats: [] });
  const pub = (expected, points, extra = {}) => api('POST', '/ruleset-versions', { token: adm.token, body: { sport: 'football', format_key: 'default', expected_version: expected, ruleset: rs(points), note: 'house format', ...extra } });
  assert.equal((await api('POST', '/ruleset-versions', { token: pl.token, body: { sport: 'football', expected_version: 0, ruleset: rs(1) } })).status, 403);
  assert.equal((await pub(0, 1)).status, 201);
  assert.equal((await pub(0, 2)).status, 409, 'stale');
  assert.equal((await pub(1, 1)).status, 422, 'unchanged');
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Pin ${++n}`, sport: 'football' } })).body;
  const mkTeam = async (u) => (await api('POST', '/teams', { token: u.token, body: { name: `T ${++n}`, sport: 'football' } })).body;
  const [h, aw] = [await mkTeam(await signup(['coach'])), await mkTeam(await signup(['coach']))];
  const mkFx = async () => (await pool.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3, now()) RETURNING id', [ev.id, h.id, aw.id])).rows[0].id;
  const f1 = await mkFx();
  const s1 = await api('POST', `/fixtures/${f1}/start`, { token: org.token });
  assert.equal(s1.body.ruleset.source, 'governed');
  assert.equal(s1.body.ruleset.version, 1);
  await api('POST', `/fixtures/${f1}/events`, { token: org.token, body: { kind: 'period_start' } });
  assert.equal((await pub(1, 3)).status, 201, 'v2 published while f1 is live');
  const g = await api('POST', `/fixtures/${f1}/events`, { token: org.token, body: { kind: 'goal', side: 'home' } });
  assert.equal(g.body.state.score.home, 1, 'the live game still scores under v1');
  const f2 = await mkFx();
  const s2 = await api('POST', `/fixtures/${f2}/start`, { token: org.token });
  assert.equal(s2.body.ruleset.version, 2, 'a new game starts under the latest version');
  // an organiser can choose a named format for the event, copied and remembered
  const fmt = await api('POST', '/ruleset-versions', { token: adm.token, body: { sport: 'football', format_key: 'short_halves', expected_version: 0, note: 'quarters', ruleset: { ...rs(1), periods: { count: 4, label: 'Quarter' } } } });
  const ev2 = (await api('POST', '/events', { token: org.token, body: { name: `Fmt ${++n}`, sport: 'football' } })).body;
  const tpl = await api('POST', `/events/${ev2.id}/scoring-template`, { token: org.token, body: { ruleset_version_id: fmt.body.id } });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.body));
  assert.equal(tpl.body.ruleset_version_id, fmt.body.id);
  assert.equal((await api('GET', `/events/${ev2.id}/scoring-ruleset`)).body.version, 1);
  assert.equal((await api('POST', `/events/${ev2.id}/scoring-template`, { token: org.token, body: {} })).status, 400, 'needs a ruleset or a version');
  const list = await api('GET', '/ruleset-versions?sport=football');
  assert.equal(list.body.versions.length, 3);
  await assert.rejects(pool.query('UPDATE ruleset_versions SET label=$1', ['x']), /immutable/);
});

test('everything ties back to the standard rules: always readable, divergence flagged and explained, reset keeps history', async () => {
  const adm = await signup(['athlete'], true), pl = await signup(['athlete']);
  // standard game rules are available to anyone, before and after a governed version exists
  const before = await api('GET', '/sports/basketball/rules');
  assert.equal(before.status, 200);
  assert.equal(before.body.in_force, null);
  assert.ok(before.body.scoring.length >= 2, 'readable standard game rules');
  assert.equal(before.body.standard_ruleset.kind, 'points_events');
  assert.equal(before.body.standard_metrics.length, 3);
  assert.equal(before.body.standard_metrics[0].unit, 's');
  // a metric that differs from the standard needs a reason; one equal to the standard does not
  const base = { sport: 'athletics', metric: '400m_time_s', label: '400 m', expected_version: 0, unit: 's', direction: 'lower', aggregation: 'best', value_kind: 'decimal', min_value: 30, max_value: 200, points_mode: 'flat', points_value: 5 };
  const noWhy = await api('POST', '/metric-definitions', { token: adm.token, body: base });
  assert.equal(noWhy.status, 422);
  assert.ok(noWhy.body.error?.details?.differs_from_standard?.includes('min_value') || JSON.stringify(noWhy.body).includes('min_value'));
  const v1r = await api('POST', '/metric-definitions', { token: adm.token, body: { ...base, note: 'federation limit' } });
  assert.equal(v1r.status, 201, JSON.stringify(v1r.body));
  const list = (await api('GET', '/metric-definitions?sport=athletics')).body.metrics.find((m) => m.key === '400m_time_s');
  assert.equal(Number(list.standard.max_value), 86400);
  assert.deepEqual(list.differs_from_standard.sort(), ['max_value', 'min_value']);
  // reset to standard: a new version equal to the standard, v1 untouched
  const reset = await api('POST', '/metric-definitions', { token: adm.token, body: { ...base, expected_version: 1, reset_to_standard: true } });
  assert.equal(reset.status, 201, JSON.stringify(reset.body));
  assert.equal(reset.body.version.version, 2);
  assert.equal(Number(reset.body.version.max_value), 86400);
  const d = (await api('GET', `/metric-definitions/${v1r.body.definition.id}`)).body;
  assert.equal(d.versions.length, 2);
  assert.deepEqual(d.versions[0].differs_from_standard, []);
  assert.deepEqual(d.versions[1].differs_from_standard.sort(), ['max_value', 'min_value']);
  // rules endpoint carries the standard next to the rule in force
  assert.equal((await api('GET', '/scoring-rules?sport=athletics&metric=400m_time_s')).body.standard.unit, 's');
  // formats: a changed default needs a reason, is reported next to (never instead of) the standard, and can be reset
  const std = (await api('GET', '/ruleset-versions?sport=basketball')).body.standard;
  const changed = { ...std, events: std.events.map((e) => ({ ...e, points: e.points + 1 })) };
  assert.equal((await api('POST', '/ruleset-versions', { token: adm.token, body: { sport: 'basketball', expected_version: 0, ruleset: changed } })).status, 422);
  assert.equal((await api('POST', '/ruleset-versions', { token: adm.token, body: { sport: 'basketball', expected_version: 0, ruleset: changed, note: 'league rule' } })).status, 201);
  const mid = (await api('GET', '/sports/basketball/rules', { token: pl.token })).body;
  assert.equal(mid.in_force.version, 1);
  assert.equal(mid.in_force.differs_from_standard, true);
  assert.equal(mid.standard_ruleset.events[0].points, std.events[0].points, 'standard unchanged by the governed version');
  assert.equal((await api('POST', '/ruleset-versions', { token: pl.token, body: { sport: 'basketball', expected_version: 1, reset_to_standard: true } })).status, 403);
  const rs = await api('POST', '/ruleset-versions', { token: adm.token, body: { sport: 'basketball', expected_version: 1, reset_to_standard: true } });
  assert.equal(rs.status, 201, JSON.stringify(rs.body));
  assert.equal((await api('GET', '/sports/basketball/rules')).body.in_force.differs_from_standard, false);
  assert.equal((await pool.query("SELECT count(*)::int AS c FROM ruleset_versions WHERE format_key='default'")).rows[0].c >= 2, true, 'history kept');
  // an event shows the standard next to its own rules
  const org = await signup(['organizer']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Std ${++n}`, sport: 'basketball' } })).body;
  assert.equal((await api('GET', `/events/${ev.id}/scoring-ruleset`)).body.standard.kind, 'points_events');
});
