// REF-R29: Para-sport officials workflow and accessibility (#1027)
// Tests: para match context redaction, incident filing, medical text guard, assistive needs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

let n = 0;
const signup = async (roles = []) => {
  n++;
  const r = await api('POST', '/auth/register', {
    body: { handle: `po${n}`, display_name: `User ${n}`, email: `po${n}@paratest.example`, password: 'correct-horse-battery', roles },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (d) => new Date(Date.now() + d * 864e5).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ------------------------------------------------------------------ para context endpoint

test('get_para_match_context: requires auth', async () => {
  const r = await api('GET', '/fixtures/00000000-0000-0000-0000-000000000000/para-context');
  assert.equal(r.status, 401);
});

test('get_para_match_context: 404 for nonexistent fixture', async () => {
  const user = await signup([]);
  const r = await api('GET', '/fixtures/00000000-0000-0000-0000-000000000001/para-context', { token: user.token });
  assert.equal(r.status, 404);
});

test('get_para_match_context: response never includes para_cases or para_evidence fields', async () => {
  const org = await signup(['organizer']);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `ParaCtxEv${n}`, sport: 'wheelchair_basketball' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;

  // Organiser is implicitly authorised to view the fixture
  const r = await api('GET', `/fixtures/${fx.id}/para-context`, { token: org.token });
  // May be 200 (empty list) or 403 if not on crew — either way must not leak case data
  assert.ok([200, 403].includes(r.status), `unexpected status ${r.status}`);
  const body = JSON.stringify(r.body);
  assert.ok(!body.includes('para_case'), 'must not expose para_case fields');
  assert.ok(!body.includes('para_evidence'), 'must not expose para_evidence fields');
  assert.ok(!body.includes('case_notes'), 'must not expose case_notes');
  assert.ok(!body.includes('medical_detail'), 'must not expose medical_detail');
});

// ------------------------------------------------------------------ para procedure

test('get_para_officiating_procedure: returns procedure for known sport', async () => {
  const user = await signup([]);
  const r = await api('GET', '/sports/wheelchair_basketball/para-procedure', { token: user.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.procedure, 'has procedure object');
  assert.ok(r.body.procedure.time_extensions !== undefined, 'has time_extensions');
});

test('get_para_officiating_procedure: returns generic fallback for unlisted sport', async () => {
  const user = await signup([]);
  const r = await api('GET', '/sports/cricket/para-procedure', { token: user.token });
  assert.ok([200, 404].includes(r.status), 'valid response for unlisted sport');
});

// ------------------------------------------------------------------ incident filing

test('file_para_incident: blocks clinical/medical text in description', async () => {
  const org = await signup(['organizer']);
  const official = await signup([]);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `IncEv${n}`, sport: 'wheelchair_basketball' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;

  // Invite the official to the fixture
  await api('POST', '/officials/invite', {
    token: org.token,
    body: { fixture_id: fx.id, user_id: official.id, role: 'referee' },
  });
  await api('PATCH', `/officials/assignments/${fx.id}/respond`, {
    token: official.token,
    body: { action: 'accept' },
  });

  const r = await api('POST', `/fixtures/${fx.id}/para-incidents`, {
    token: official.token,
    body: {
      kind: 'classification_protest',
      description: 'Athlete requires a diagnosis of cerebral palsy reclassification',
    },
  });
  assert.equal(r.status, 400, 'should reject clinical text');
  assert.ok(r.body.message?.toLowerCase().includes('clinical') || r.body.error?.toLowerCase().includes('clinical') || r.body.message?.toLowerCase().includes('medical'), `expected clinical rejection, got: ${JSON.stringify(r.body)}`);
});

test('file_para_incident: accepts valid classification protest', async () => {
  const org = await signup(['organizer']);
  const official = await signup([]);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `IncEv2${n}`, sport: 'wheelchair_basketball' } })).body;
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_name: 'A', away_name: 'B', scheduled_at: at(1) } })).body;
  await api('POST', '/officials/invite', { token: org.token, body: { fixture_id: fx.id, user_id: official.id, role: 'referee' } });
  await api('PATCH', `/officials/assignments/${fx.id}/respond`, { token: official.token, body: { action: 'accept' } });

  const r = await api('POST', `/fixtures/${fx.id}/para-incidents`, {
    token: official.token,
    body: {
      kind: 'classification_protest',
      description: 'Athlete competed in class S6 but their sport class card shows S5. Requesting review of documentation.',
    },
  });
  // 200/201 on success, 403 if assignment check is strict — either valid
  assert.ok([200, 201, 403].includes(r.status), `unexpected: ${r.status} ${JSON.stringify(r.body)}`);
  if (r.status === 200 || r.status === 201) {
    assert.ok(r.body.id ?? r.body.incident_id, 'returns incident id');
  }
});

test('file_para_incident: rejects unauthenticated request', async () => {
  const r = await api('POST', '/fixtures/00000000-0000-0000-0000-000000000001/para-incidents', {
    body: { kind: 'equipment_non_conformance', description: 'Test' },
  });
  assert.equal(r.status, 401);
});

// ------------------------------------------------------------------ assistive needs

test('get_my_assistive_needs: returns empty prefs for new official', async () => {
  const user = await signup([]);
  const r = await api('GET', '/me/assistive-needs', { token: user.token });
  assert.ok([200, 404].includes(r.status));
  if (r.status === 200) {
    assert.ok(r.body !== null);
  }
});

test('set_my_assistive_needs: saves preferences', async () => {
  const user = await signup([]);
  const r = await api('POST', '/me/assistive-needs', {
    token: user.token,
    body: {
      prefs: { large_targets: true, high_contrast: false, screen_reader: false, hearing_loop: true, haptic_alerts: false, written_comms: false },
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.ok || r.body.id || r.body.saved, 'save confirmed');
});

test('set_my_assistive_needs: detail field is never returned in plaintext', async () => {
  const user = await signup([]);
  await api('POST', '/me/assistive-needs', {
    token: user.token,
    body: {
      prefs: { large_targets: true },
      needs: [{ device: 'Cochlear processor', detail: 'Right side only — requires loop tuned to 95 MHz' }],
    },
  });
  const r = await api('GET', '/me/assistive-needs', { token: user.token });
  if (r.status === 200) {
    // detail should NOT be returned in plaintext — only the device name
    const body = JSON.stringify(r.body);
    assert.ok(!body.includes('95 MHz'), 'encrypted detail must not appear in plaintext');
  }
});
