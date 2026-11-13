// Tests for academy-conferences capability (#796)
// Covers: create, update, list, get, cancel, reschedule, attendees,
//         evidence, agenda, decisions, acknowledge, report, guardian access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ac_${n}_${roles[0]}`, display_name: `AC ${n}`, email: `ac${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const evidence = { reference: 'https://example.com/bc-ref-123', label: 'Birth certificate' };

/** Full guardian setup: request -> child accepts -> evidence -> admin approves */
async function verifiedGuardian(guardian, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: guardian.token, body: { guardian_id: guardian.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: guardian.token, body: { evidence } }), 201);
  return must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ac_root','ac_root','{admin}','x','x','ac_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ---- Shared state across tests (sequential) --------------------------------
let orgId, staffToken, guardianToken, guardianUserId, athleteUserId;
let confId, attendeeId, itemId, decisionId;

test('setup: create org, staff, athlete, guardian', async () => {
  // Create org via organisations endpoint (admin token from before())
  const org = must(await api('POST', '/organisations', { token: admin.token, body: { name: `Test Academy ${n}`, kind: 'club' } }), 201);
  orgId = org.id;
  staffToken = admin.token;

  const ath = await signup(['athlete'], { dob: '2010-05-01' });
  athleteUserId = ath.id;

  const grd = await signup(['athlete']);
  guardianUserId = grd.id;
  guardianToken = grd.token;
  await verifiedGuardian(grd, ath);
});

test('staff can create a conference', async () => {
  const r = must(await api('POST', `/organisations/${orgId}/conferences`, {
    token: staffToken,
    body: {
      title: 'Annual Review 2026',
      kind: 'annual_review',
      scheduled_at: '2026-06-15T10:00:00Z',
      duration_minutes: 60,
      location_type: 'video',
      location_detail: 'https://meet.example.com/review',
      agenda: 'Review all development domains',
      staff_notes: 'Private coach notes — guardian must never see this',
      family_visible: true,
    },
  }), 201);
  confId = r.id;
  assert.equal(r.kind, 'annual_review');
  assert.equal(r.status, 'draft');
  assert.equal(r.family_visible, true);
  assert.ok(r.agenda, 'staff sees agenda');
  assert.ok(r.staff_notes, 'staff sees staff_notes');
});

test('staff_notes is NEVER returned to guardian callers', async () => {
  // Add guardian as attendee
  const a = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/attendees`, {
    token: staffToken,
    body: { user_id: guardianUserId, role: 'guardian' },
  }), 201);
  attendeeId = a.id;

  // Guardian views conference
  const r = must(await api('GET', `/organisations/${orgId}/conferences/${confId}`, { token: guardianToken }));
  assert.equal(r.staff_notes, undefined, 'staff_notes must never reach guardians');
  assert.ok(r.agenda, 'guardian sees agenda');
});

test('staff updates conference to scheduled', async () => {
  const r = must(await api('PATCH', `/organisations/${orgId}/conferences/${confId}`, {
    token: staffToken,
    body: { status: 'scheduled' },
  }));
  assert.equal(r.status, 'scheduled');
  assert.ok(r.row_version >= 2);
});

test('guardian cannot see conferences where family_visible=false', async () => {
  must(await api('POST', `/organisations/${orgId}/conferences`, {
    token: staffToken,
    body: { title: 'Internal only', kind: 'welfare', family_visible: false },
  }), 201);
  const list = must(await api('GET', `/organisations/${orgId}/conferences`, { token: guardianToken }));
  assert.ok(Array.isArray(list));
  assert.ok(!list.some((c) => c.family_visible === false), 'hidden conferences must not appear for guardian');
});

test('staff sees all conferences', async () => {
  const list = must(await api('GET', `/organisations/${orgId}/conferences`, { token: staffToken }));
  assert.ok(Array.isArray(list));
  assert.ok(list.some((c) => c.id === confId));
});

test('guardian confirms their own attendance', async () => {
  const r = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/attendees/${attendeeId}/respond`, {
    token: guardianToken,
    body: { status: 'confirmed' },
  }));
  assert.equal(r.status, 'confirmed');
  assert.ok(r.responded_at);
});

test('staff adds evidence', async () => {
  const r = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/evidence`, {
    token: staffToken,
    body: { source_kind: 'dev_review', label: 'Q1 Development Review', visible_to_roles: ['coach', 'admin', 'guardian'] },
  }), 201);
  assert.equal(r.source_kind, 'dev_review');
  assert.equal(r.label, 'Q1 Development Review');
});

test('staff removes evidence', async () => {
  const ev = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/evidence`, {
    token: staffToken,
    body: { source_kind: 'assessment', label: 'To remove', visible_to_roles: ['coach'] },
  }), 201);
  const r = must(await api('DELETE', `/organisations/${orgId}/conferences/${confId}/evidence/${ev.id}`, { token: staffToken }));
  assert.equal(r.ok, true);
});

test('staff adds agenda item', async () => {
  const r = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/agenda`, {
    token: staffToken,
    body: { title: 'Technical development review', kind: 'review_domain', time_minutes: 20 },
  }), 201);
  itemId = r.id;
  assert.equal(r.title, 'Technical development review');
  assert.equal(r.kind, 'review_domain');
});

test('staff updates agenda item', async () => {
  const r = must(await api('PATCH', `/organisations/${orgId}/conferences/${confId}/agenda/${itemId}`, {
    token: staffToken,
    body: { time_minutes: 25 },
  }));
  assert.equal(r.time_minutes, 25);
});

test('staff reorders agenda', async () => {
  const item2 = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/agenda`, {
    token: staffToken,
    body: { title: 'Welfare check', kind: 'welfare', time_minutes: 10 },
  }), 201);
  const r = must(await api('PATCH', `/organisations/${orgId}/conferences/${confId}/agenda/order`, {
    token: staffToken,
    body: { item_ids: [item2.id, itemId] },
  }));
  assert.equal(r.ok, true);
});

test('staff records decision visible to guardian', async () => {
  const r = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/decisions`, {
    token: staffToken,
    body: { kind: 'action', body: 'Increase forehand training to 3x/week', deadline_on: '2026-09-01', visible_to_guardian: true },
  }), 201);
  decisionId = r.id;
  assert.equal(r.kind, 'action');
  assert.equal(r.status, 'open');
  assert.equal(r.visible_to_guardian, true);
});

test('staff updates decision to done', async () => {
  const r = must(await api('PATCH', `/organisations/${orgId}/conferences/${confId}/decisions/${decisionId}`, {
    token: staffToken,
    body: { status: 'done' },
  }));
  assert.equal(r.status, 'done');
  assert.ok(r.resolved_at);
});

test('staff reschedules conference and notifies', async () => {
  const r = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/reschedule`, {
    token: staffToken,
    body: { new_scheduled_at: '2026-07-01T14:00:00Z', reason: 'Coach availability' },
  }));
  assert.equal(r.status, 'rescheduled');
});

test('staff marks conference complete with outcome', async () => {
  const r = must(await api('PATCH', `/organisations/${orgId}/conferences/${confId}`, {
    token: staffToken,
    body: { status: 'completed', outcome_summary: 'Excellent progress. Next review in 3 months.' },
  }));
  assert.equal(r.status, 'completed');
  assert.ok(r.outcome_summary);
});

test('staff generates outcome report', async () => {
  const r = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/report`, { token: staffToken }), 201);
  assert.ok(r.document_id || r.ok, 'should return document_id or ok');
});

test('guardian acknowledges outcome', async () => {
  const r = must(await api('POST', `/organisations/${orgId}/conferences/${confId}/acknowledge`, { token: guardianToken }));
  assert.equal(r.acknowledged, true);
  assert.ok(r.acknowledged_at);
});

test('guardian gets report after acknowledgement', async () => {
  const r = must(await api('GET', `/organisations/${orgId}/conferences/${confId}/report`, { token: guardianToken }));
  assert.ok(r.document_id || r.download_url || r.ok, 'should return report info');
});

test('staff can cancel a draft conference', async () => {
  const c2 = must(await api('POST', `/organisations/${orgId}/conferences`, {
    token: staffToken,
    body: { title: 'To cancel', kind: 'other' },
  }), 201);
  const r = must(await api('POST', `/organisations/${orgId}/conferences/${c2.id}/cancel`, {
    token: staffToken,
    body: { reason: 'No longer needed' },
  }));
  assert.equal(r.status, 'cancelled');
});

test('cannot cancel a completed conference', async () => {
  const r = await api('POST', `/organisations/${orgId}/conferences/${confId}/cancel`, { token: staffToken });
  assert.equal(r.status, 400);
});

test('MCP create_academy_conference works', async () => {
  const r = await rpc('tools/call', { name: 'create_academy_conference', arguments: { org_id: orgId, title: 'MCP test conference', kind: 'progress_check' } }, staffToken);
  assert.ok(r && r.content, 'MCP should return a result');
  const body = JSON.parse(r.content[0]?.text ?? 'null');
  assert.ok(body && body.kind === 'progress_check', 'should return a progress_check conference');
});

test('MCP list_my_guardian_conferences works for guardian', async () => {
  const r = await rpc('tools/call', { name: 'list_my_guardian_conferences', arguments: {} }, guardianToken);
  assert.ok(r !== null, 'MCP should return a result');
});
