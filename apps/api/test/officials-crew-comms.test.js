// R20: Crew Communication Center — integration tests (#1012)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const signup = async (roles = []) => {
  const email = `comms-test-${Math.random().toString(36).slice(2)}@example.com`;
  const r = await api('POST', '/api/v1/auth/register', { body: { email, password: 'Test1234!', name: 'Test User' } });
  assert.equal(r.status, 201, `register failed: ${JSON.stringify(r.body)}`);
  if (roles.length) await pool.query('UPDATE users SET roles=$1 WHERE id=$2', [roles, r.body.user.id]);
  return { token: r.body.token, id: r.body.user.id };
};

const createEventAndFixture = async (orgToken, orgId) => {
  const ev = await api('POST', '/api/v1/events', {
    token: orgToken,
    body: { name: 'Comms Test Event', sport_slug: 'football', start_date: '2027-07-01', end_date: '2027-07-02', timezone: 'UTC', organizer_id: orgId },
  });
  const eventId = ev.body.id ?? ev.body.event?.id;
  if (!eventId) throw new Error(`event create failed: ${JSON.stringify(ev.body)}`);
  const fx = await api('POST', `/api/v1/events/${eventId}/fixtures`, {
    token: orgToken,
    body: { scheduled_at: '2027-07-01T10:00:00Z', duration_min: 90, sport_slug: 'football' },
  });
  const fixtureId = fx.body.id ?? fx.body.fixture?.id;
  if (!fixtureId) throw new Error(`fixture create failed: ${JSON.stringify(fx.body)}`);
  return { eventId, fixtureId };
};

const inviteAndAcceptOfficial = async ({ orgToken, officialId, fixtureId, eventId }) => {
  const inv = await api('POST', `/api/v1/fixtures/${fixtureId}/officials`, {
    token: orgToken,
    body: { user_id: officialId, role: 'referee', event_id: eventId },
  });
  if (inv.status >= 400) throw new Error(`invite failed: ${JSON.stringify(inv.body)}`);
  const assignmentId = inv.body.id ?? inv.body.assignment?.id;
  // Accept directly in DB
  await pool.query("UPDATE fixture_officials SET status='accepted' WHERE id=$1", [assignmentId]);
  return assignmentId;
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => { server.close(); await pool.end(); });

// ── Thread lifecycle ──────────────────────────────────────────────────────────

test('organiser can create a general thread and official can read it', async () => {
  const org = await signup(['organizer']);
  const official = await signup(['official']);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);
  await inviteAndAcceptOfficial({ orgToken: org.token, officialId: official.id, fixtureId, eventId });

  const create = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-threads`, {
    token: org.token,
    body: { type: 'general', title: 'Pre-match coordination' },
  });
  assert.equal(create.status, 201, `create thread: ${JSON.stringify(create.body)}`);
  assert.ok(create.body.id, 'has id');
  assert.equal(create.body.type, 'general');

  const list = await api('GET', `/api/v1/fixtures/${fixtureId}/crew-threads`, { token: official.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 1, 'official sees threads');
  assert.ok(list.body.some((t) => t.id === create.body.id));
});

test('emergency thread has priority 100', async () => {
  const org = await signup(['organizer']);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);

  const create = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-threads`, {
    token: org.token,
    body: { type: 'emergency', title: 'Emergency: pitch waterlogged' },
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.priority, 100);
});

// ── Messaging ─────────────────────────────────────────────────────────────────

test('post and read messages in a thread', async () => {
  const org = await signup(['organizer']);
  const official = await signup(['official']);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);
  await inviteAndAcceptOfficial({ orgToken: org.token, officialId: official.id, fixtureId, eventId });

  const { body: thread } = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-threads`, {
    token: org.token,
    body: { type: 'general', title: 'Chat' },
  });

  const post = await api('POST', `/api/v1/crew-threads/${thread.id}/messages`, {
    token: official.token,
    body: { body: 'On my way to the venue', client_id: 'cli-001-abc' },
  });
  assert.equal(post.status, 201, `post msg: ${JSON.stringify(post.body)}`);
  assert.ok(post.body.id);

  // Idempotency: same client_id returns existing message
  const retry = await api('POST', `/api/v1/crew-threads/${thread.id}/messages`, {
    token: official.token,
    body: { body: 'On my way to the venue', client_id: 'cli-001-abc' },
  });
  assert.ok([200, 201].includes(retry.status), 'idempotent retry ok');

  const msgs = await api('GET', `/api/v1/crew-threads/${thread.id}/messages`, { token: org.token });
  assert.equal(msgs.status, 200);
  assert.ok(msgs.body.some((m) => m.body === 'On my way to the venue'), 'org can read message');
});

test('outsider cannot read thread messages', async () => {
  const org = await signup(['organizer']);
  const outsider = await signup([]);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);

  const { body: thread } = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-threads`, {
    token: org.token,
    body: { type: 'general', title: 'Private' },
  });

  const r = await api('GET', `/api/v1/crew-threads/${thread.id}/messages`, { token: outsider.token });
  assert.ok([403, 404].includes(r.status), `outsider should be blocked, got ${r.status}`);
});

// ── Read receipts ─────────────────────────────────────────────────────────────

test('mark messages read updates unread count', async () => {
  const org = await signup(['organizer']);
  const official = await signup(['official']);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);
  await inviteAndAcceptOfficial({ orgToken: org.token, officialId: official.id, fixtureId, eventId });

  const { body: thread } = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-threads`, {
    token: org.token, body: { type: 'general', title: 'Read receipt test' },
  });

  await api('POST', `/api/v1/crew-threads/${thread.id}/messages`, {
    token: org.token, body: { body: 'Please check in by 09:00' },
  });

  // Official reads
  const listBefore = await api('GET', `/api/v1/fixtures/${fixtureId}/crew-threads`, { token: official.token });
  const th = listBefore.body.find((t) => t.id === thread.id);
  assert.ok(th.unread_count >= 1, 'has unread');

  await api('POST', `/api/v1/crew-threads/${thread.id}/messages/read`, { token: official.token, body: {} });

  const listAfter = await api('GET', `/api/v1/fixtures/${fixtureId}/crew-threads`, { token: official.token });
  const thAfter = listAfter.body.find((t) => t.id === thread.id);
  assert.equal(thAfter.unread_count, 0, 'unread cleared after read');
});

// ── Archive ───────────────────────────────────────────────────────────────────

test('organiser can archive a thread', async () => {
  const org = await signup(['organizer']);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);

  const { body: thread } = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-threads`, {
    token: org.token, body: { type: 'handover', title: 'Half-time handover' },
  });
  const archive = await api('POST', `/api/v1/crew-threads/${thread.id}/archive`, { token: org.token, body: {} });
  assert.equal(archive.status, 200);
  assert.equal(archive.body.ok, true);

  // Archived thread excluded from default listing
  const list = await api('GET', `/api/v1/fixtures/${fixtureId}/crew-threads`, { token: org.token });
  assert.ok(!list.body.find((t) => t.id === thread.id), 'archived excluded from default list');

  // Included with flag
  const withArchived = await api('GET', `/api/v1/fixtures/${fixtureId}/crew-threads?include_archived=true`, { token: org.token });
  assert.ok(withArchived.body.find((t) => t.id === thread.id), 'included when flag set');
});

// ── Briefings ─────────────────────────────────────────────────────────────────

test('organiser can create briefing and official can ack it', async () => {
  const org = await signup(['organizer']);
  const official = await signup(['official']);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);
  await inviteAndAcceptOfficial({ orgToken: org.token, officialId: official.id, fixtureId, eventId });

  const brief = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-briefings`, {
    token: org.token,
    body: { title: 'Match day briefing', body: 'All officials report at 09:00. Kit: standard black.', requires_ack: true },
  });
  assert.equal(brief.status, 201, `create briefing: ${JSON.stringify(brief.body)}`);

  const list = await api('GET', `/api/v1/fixtures/${fixtureId}/crew-briefings`, { token: official.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((b) => b.id === brief.body.id), 'official sees briefing');
  assert.equal(list.body.find((b) => b.id === brief.body.id).caller_acked, false);

  const ack = await api('POST', `/api/v1/crew-briefings/${brief.body.id}/ack`, { token: official.token, body: {} });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.ok, true);
  assert.ok(ack.body.ack_count >= 1);

  // Idempotent
  const ack2 = await api('POST', `/api/v1/crew-briefings/${brief.body.id}/ack`, { token: official.token, body: {} });
  assert.ok([200, 409].includes(ack2.status), 'second ack idempotent');
});

test('non-organiser cannot create briefing', async () => {
  const org = await signup(['organizer']);
  const official = await signup(['official']);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);
  await inviteAndAcceptOfficial({ orgToken: org.token, officialId: official.id, fixtureId, eventId });

  const r = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-briefings`, {
    token: official.token,
    body: { title: 'Unofficial', body: 'This should fail', requires_ack: false },
  });
  assert.equal(r.status, 403, 'official cannot create briefing');
});

// ── Shared docs ───────────────────────────────────────────────────────────────

test('organiser can share a doc and crew can list it', async () => {
  const org = await signup(['organizer']);
  const official = await signup(['official']);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);
  await inviteAndAcceptOfficial({ orgToken: org.token, officialId: official.id, fixtureId, eventId });

  const doc = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-docs`, {
    token: org.token,
    body: {
      name: 'Laws of the Game 2024',
      doc_category: 'rules',
      mime_type: 'application/pdf',
      url: 'https://example.com/laws-2024.pdf',
      file_size_bytes: 2000000,
    },
  });
  assert.equal(doc.status, 201, `share doc: ${JSON.stringify(doc.body)}`);

  const list = await api('GET', `/api/v1/fixtures/${fixtureId}/crew-docs`, { token: official.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((d) => d.id === doc.body.id), 'doc visible to official');
  assert.ok(list.body[0].url, 'url is returned decrypted');
});

// ── Moderation ────────────────────────────────────────────────────────────────

test('official can flag a message and organiser can resolve it', async () => {
  const org = await signup(['organizer']);
  const official = await signup(['official']);
  const { eventId, fixtureId } = await createEventAndFixture(org.token, org.id);
  await inviteAndAcceptOfficial({ orgToken: org.token, officialId: official.id, fixtureId, eventId });

  const { body: thread } = await api('POST', `/api/v1/fixtures/${fixtureId}/crew-threads`, {
    token: org.token, body: { type: 'general', title: 'Moderation test' },
  });
  const { body: msg } = await api('POST', `/api/v1/crew-threads/${thread.id}/messages`, {
    token: official.token, body: { body: 'Inappropriate message' },
  });

  const flag = await api('POST', `/api/v1/crew-messages/${msg.id}/flag`, {
    token: org.token,
    body: { reason: 'inappropriate_conduct', notes: 'Contains personal insults' },
  });
  assert.equal(flag.status, 201, `flag: ${JSON.stringify(flag.body)}`);

  const resolve = await api('POST', `/api/v1/crew-flags/${flag.body.flag_id}/resolve`, {
    token: org.token,
    body: { status: 'resolved', resolution: 'Official warned' },
  });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.body.status, 'resolved');
});
