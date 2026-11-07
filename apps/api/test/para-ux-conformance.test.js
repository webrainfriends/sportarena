import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// PS-08: Para-sport UX acceptance suite — conformance matrix, defects, release gate.
process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
await import('../src/capabilities/index.js');

let server, base, n = 0, admin, manager, athlete;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const uid = () => `ps08_${++n}_${Date.now()}`;

before(async () => {
  await migrate(pool);
  const app = createApp();
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (label, roles) => {
    const k = uid();
    const r = await api('POST', '/auth/register', { body: { handle: k, display_name: label, email: `${k}@example.com`, password: 'correct-horse-battery' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await pool.query('UPDATE users SET roles=$2 WHERE id=$1', [r.body.user.id, roles]);
    return { id: r.body.user.id, token: r.body.token };
  };
  // platform_admin is only honoured for the platform-admin email, so the admin signs in as that account.
  const pa = await api('POST', '/auth/register', { body: { handle: `ps08pa_${Date.now()}`, display_name: 'Platform', email: 'rraja.edge@gmail.com', password: 'correct-horse-battery' } });
  const pu = pa.status === 201 ? pa.body : (await api('POST', '/auth/login', { body: { email: 'rraja.edge@gmail.com', password: 'correct-horse-battery' } })).body;
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}' WHERE id=$1", [pu.user.id]);
  const re = await api('POST', '/auth/login', { body: { email: 'rraja.edge@gmail.com', password: 'correct-horse-battery' } });
  admin = { id: pu.user.id, token: re.body.token };
  manager = await mk('Manager', ['manager']);
  athlete = await mk('Athlete', ['athlete']);
});

after(async () => {
  await new Promise((res) => server.close(res));
  await pool.end();
});

// ── Auth guard: athletes get 404 ──────────────────────────────────────────────
test('athletes cannot access conformance matrix', async () => {
  const r = await api('GET', '/para/conformance', { token: athlete.token });
  assert.equal(r.status, 404);
});

test('unauthenticated request is rejected', async () => {
  const r = await api('GET', '/para/conformance', {});
  assert.ok([401, 403, 404].includes(r.status));
});

// ── Upsert conformance entry ──────────────────────────────────────────────────
test('upsert_conformance_entry — creates new entry', async () => {
  const r = await api('POST', '/para/conformance/entry/athlete_onboarding/ios/voiceover', {
    token: admin.token,
    body: { journey: 'athlete_onboarding', platform: 'ios', tech: 'voiceover', status: 'conformant', evidence_ref: 'https://example.com/evidence/1', notes: 'All criteria met' },
  });
  const b = ok(r);
  assert.equal(b.journey, 'athlete_onboarding');
  assert.equal(b.platform, 'ios');
  assert.equal(b.tech, 'voiceover');
  assert.equal(b.status, 'conformant');
  assert.equal(b.row_version, 1);
});

test('upsert_conformance_entry — updates and increments row_version', async () => {
  // First PUT
  await api('POST', '/para/conformance/entry/booking/android/talkback', {
    token: admin.token,
    body: { journey: 'booking', platform: 'android', tech: 'talkback', status: 'partial' },
  });
  // Second PUT
  const r = await api('POST', '/para/conformance/entry/booking/android/talkback', {
    token: admin.token,
    body: { journey: 'booking', platform: 'android', tech: 'talkback', status: 'conformant', notes: 'Fixed in v3.2' },
  });
  const b = ok(r);
  assert.equal(b.status, 'conformant');
  assert.equal(b.row_version, 2);
});

test('upsert_conformance_entry — invalid journey returns 422', async () => {
  const r = await api('POST', '/para/conformance/entry/not_a_journey/ios/voiceover', {
    token: admin.token,
    body: { journey: 'not_a_journey', platform: 'ios', tech: 'voiceover', status: 'conformant' },
  });
  assert.ok([400, 422].includes(r.status));
});

test('upsert_conformance_entry — invalid platform returns 422', async () => {
  const r = await api('POST', '/para/conformance/entry/booking/gameboy/keyboard', {
    token: admin.token,
    body: { journey: 'booking', platform: 'gameboy', tech: 'keyboard', status: 'untested' },
  });
  assert.ok([400, 422].includes(r.status));
});

// ── List conformance matrix ───────────────────────────────────────────────────
test('list_conformance_matrix — returns synthesised full grid for unseeded combinations', async () => {
  const r = await api('GET', '/para/conformance', { token: admin.token });
  const b = ok(r);
  assert.ok(Array.isArray(b.entries));
  // 10 journeys × 4 platforms × 5 techs = 200 entries
  assert.equal(b.total, 200);
  const untested = b.entries.filter((e) => e.status === 'untested');
  assert.ok(untested.length > 0, 'some entries should be untested');
});

test('list_conformance_matrix — filter by platform', async () => {
  const r = await api('GET', '/para/conformance', { token: admin.token, query: { platform: 'ios' } });
  const b = ok(r);
  assert.ok(b.entries.every((e) => e.platform === 'ios'), 'all entries should be ios');
  assert.equal(b.total, 50); // 10 journeys × 5 techs
});

// ── Conformance summary ───────────────────────────────────────────────────────
test('get_conformance_summary — returns counts and by_journey breakdown', async () => {
  const r = await api('GET', '/para/conformance/summary', { token: admin.token });
  const b = ok(r);
  assert.ok(Array.isArray(b.counts));
  assert.ok(Array.isArray(b.by_journey));
  assert.ok(typeof b.open_critical_defects === 'number');
});

// ── Add evidence ──────────────────────────────────────────────────────────────
test('add_conformance_evidence — attaches URL to existing entry', async () => {
  // Seed an entry first
  await api('POST', '/para/conformance/entry/health/web/keyboard', {
    token: admin.token,
    body: { journey: 'health', platform: 'web', tech: 'keyboard', status: 'partial' },
  });
  const r = await api('POST', '/para/conformance/evidence', {
    token: admin.token,
    body: { journey: 'health', platform: 'web', tech: 'keyboard', evidence_ref: 'https://axe.deque.com/reports/42' },
  });
  const b = ok(r);
  assert.equal(b.evidence_ref, 'https://axe.deque.com/reports/42');
});

test('add_conformance_evidence — invalid URL returns 400/422', async () => {
  const r = await api('POST', '/para/conformance/evidence', {
    token: admin.token,
    body: { journey: 'health', platform: 'web', tech: 'keyboard', evidence_ref: 'not-a-url' },
  });
  assert.ok([400, 422].includes(r.status));
});

// ── Defect lifecycle ──────────────────────────────────────────────────────────
let defectId;
test('upsert_conformance_defect — creates defect', async () => {
  const r = await api('POST', '/para/conformance/defects', {
    token: admin.token,
    body: {
      journey: 'tournament_entry', platform: 'ios', screen: 'EntryConfirmation',
      title: 'Focus order skips Submit button with VoiceOver',
      severity: 'critical',
      description: 'When VoiceOver is active, the submit button at the bottom of the entry form receives focus out of order, causing the user to activate it unintentionally.',
      steps_to_reproduce: '1. Open EntryConfirmation screen\n2. Enable VoiceOver\n3. Swipe through form fields',
      wcag_criterion: '2.4.3',
    },
  });
  const b = ok(r, 200);
  assert.ok(b.id, 'should return id');
  defectId = b.id;
  assert.equal(b.severity, 'critical');
  assert.equal(b.status, 'open');
  assert.equal(b.wcag_criterion, '2.4.3');
});

test('upsert_conformance_defect — description with classification code is rejected', async () => {
  const r = await api('POST', '/para/conformance/defects', {
    token: admin.token,
    body: {
      journey: 'classification_status', platform: 'android',
      title: 'Defect with class code',
      severity: 'major',
      description: 'The screen shows T11 classification which leaks clinical data.',
    },
  });
  assert.equal(r.status, 400);
});

test('list_conformance_defects — returns created defect', async () => {
  const r = await api('GET', '/para/conformance/defects', { token: admin.token });
  const b = ok(r);
  assert.ok(Array.isArray(b.defects));
  const found = b.defects.find((d) => d.id === defectId);
  assert.ok(found, 'should find the created defect');
  assert.equal(found.severity, 'critical');
});

test('list_conformance_defects — filter by severity', async () => {
  const r = await api('GET', '/para/conformance/defects', { token: admin.token, query: { severity: 'critical' } });
  const b = ok(r);
  assert.ok(b.defects.every((d) => d.severity === 'critical'), 'all should be critical');
});

test('resolve_conformance_defect — resolves with note', async () => {
  const r = await api('POST', `/para/conformance/defects/${defectId}/resolve`, {
    token: admin.token,
    body: { defect_id: defectId, status: 'resolved', resolution_note: 'Fixed in PR #2041 — reordered focus using accessibilityViewIsModal pattern.' },
  });
  const b = ok(r);
  assert.equal(b.status, 'resolved');
  assert.ok(b.resolved_at, 'should have resolved_at timestamp');
  assert.ok(b.resolution_note);
});

test('resolve_conformance_defect — cannot resolve already-resolved defect', async () => {
  const r = await api('POST', `/para/conformance/defects/${defectId}/resolve`, {
    token: admin.token,
    body: { defect_id: defectId, status: 'resolved', resolution_note: 'Duplicate resolve attempt' },
  });
  assert.equal(r.status, 404);
});

test('resolve_conformance_defect — short resolution_note is rejected', async () => {
  // Create a fresh defect to resolve
  const cr = await api('POST', '/para/conformance/defects', {
    token: admin.token,
    body: { journey: 'booking', platform: 'web', title: 'Missing alt on icon', severity: 'minor', description: 'The booking confirmation icon has no alt text for screen readers.' },
  });
  const nd = cr.body;
  const r = await api('POST', `/para/conformance/defects/${nd.id}/resolve`, {
    token: admin.token,
    body: { defect_id: nd.id, status: 'resolved', resolution_note: 'Fixed' },
  });
  assert.ok([400, 422].includes(r.status), 'short note should be rejected');
});

// ── Release gate ──────────────────────────────────────────────────────────────
test('get_conformance_release_gate — platform_admin only', async () => {
  const r = await api('GET', '/para/conformance/release-gate', { token: manager.token });
  assert.equal(r.status, 403); // mustBePlatformAdmin is the repo-wide guard
});

test('get_conformance_release_gate — returns blocker list when open critical defects exist', async () => {
  // Seed a critical open defect
  await api('POST', '/para/conformance/defects', {
    token: admin.token,
    body: {
      journey: 'athlete_onboarding', platform: 'android',
      title: 'Fatal focus trap in onboarding intro screen',
      severity: 'critical',
      description: 'TalkBack users cannot proceed past the onboarding welcome screen due to a focus trap in the animated overlay. No escape gesture works.',
    },
  });
  const r = await api('GET', '/para/conformance/release-gate', { token: admin.token });
  const b = ok(r);
  assert.equal(b.passes, false);
  assert.ok(b.blocker_count > 0);
  assert.ok(Array.isArray(b.blockers));
});

test('get_conformance_release_gate — evaluated_at is present', async () => {
  const r = await api('GET', '/para/conformance/release-gate', { token: admin.token });
  const b = ok(r);
  assert.ok(b.evaluated_at, 'should include evaluated_at');
});

// ── Learn module a11y ─────────────────────────────────────────────────────────
test('set_learn_module_a11y — requires platform_admin', async () => {
  // Try with manager (not platform_admin)
  const r = await api('PATCH', '/para/learn/modules/00000000-0000-0000-0000-000000000000/accessibility', {
    token: manager.token,
    body: { id: '00000000-0000-0000-0000-000000000000', caption_ref: 'https://example.com/caps.vtt' },
  });
  assert.ok([403, 404].includes(r.status));
});

test('get_learn_module_a11y — public endpoint returns 404 for non-existent module', async () => {
  const r = await api('GET', '/para/learn/modules/00000000-0000-0000-0000-000000000000/accessibility', {});
  assert.equal(r.status, 404);
});

// ── Sensitive data: notification rules seeded by migration ───────────────────
test('migration seeds notification sensitivity rules', async () => {
  const rows = (await pool.query(
    `SELECT notification_type, field_path FROM para_notification_sensitivity_rules ORDER BY notification_type, field_path`
  )).rows;
  assert.ok(rows.length >= 3, 'should have at least 3 default rules');
  assert.ok(rows.some((r) => r.notification_type === 'classification_update' && r.field_path === 'payload.class_code'));
  assert.ok(rows.some((r) => r.notification_type === 'para_entry_decision'   && r.field_path === 'payload.reason'));
});
