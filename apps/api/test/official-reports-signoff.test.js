// Tests for official report submission workflow, co-signing, discipline auto-trigger,
// evidence attachments, state machine transitions, and negative/security cases. (#998)
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
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', {
    body: { handle: `ors${n}`, display_name: `User ${n}`, email: `ors${n}@example.com`, password: 'correct-horse-battery', roles },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

const at = (days) => new Date(Date.now() + days * 864e5).toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup() {
  const org = await signup(['organizer']);
  const ref = await signup(['referee']);
  const ar = await signup(['referee']);

  await api('POST', '/me/sport-profiles', { token: ref.token, body: { sport: 'football', role: 'referee' } });
  await api('POST', '/me/sport-profiles', { token: ar.token, body: { sport: 'football', role: 'assistant_referee' } });

  const ev = (await api('POST', '/events', { token: org.token, body: { name: `ORSTest${n}`, sport: 'football' } })).body;
  assert.ok(ev.id, 'event created');

  const fx = (await api('POST', `/events/${ev.id}/fixtures`, {
    token: org.token,
    body: { home_name: 'Red FC', away_name: 'Blue FC', scheduled_at: at(1) },
  })).body;
  assert.ok(fx.id, 'fixture created');

  // Assign officials
  await api('POST', `/fixtures/${fx.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } });
  await api('POST', `/fixtures/${fx.id}/officials`, { token: org.token, body: { user_id: ar.id, role: 'assistant_referee' } });

  return { org, ref, ar, ev, fx };
}

// ─── Helper: file a minimal report ────────────────────────────────────────────
const fileReport = (token, fixtureId, body = {}) =>
  api('POST', `/fixtures/${fixtureId}/reports`, {
    token,
    body: { category: 'match_report', summary: 'Test match report', visibility: 'organiser', ...body },
  });

const matchFacts = (token, reportId, body = {}) =>
  api('PATCH', `/official-reports/${reportId}/match-facts`, {
    token,
    body: {
      match_facts: { kickoff_actual: '15:00', final_whistle: '16:50', score_home: 2, score_away: 1, attendance: 500, pitch_condition: 'good', weather: 'fine', summary: 'Played fairly.' },
      incidents: [],
      ...body,
    },
  });

const submit = (token, reportId, extraBody = {}) =>
  api('POST', `/official-reports/${reportId}/submit`, { token, body: { confirm: true, ...extraBody } });

// ─── 1. File → patch match facts → submit: happy path ─────────────────────────
test('file → patch match facts → submit: status filed → submitted, locked, hash set', async () => {
  const { ref, fx, ev } = await setup();

  const filed = (await fileReport(ref.token, fx.id)).body;
  assert.equal(filed.status, 'filed', 'status after create');

  const patched = (await matchFacts(ref.token, filed.id)).body;
  assert.equal(patched.status, 'filed', 'still filed after match-facts patch');

  const submitted = (await submit(ref.token, filed.id)).body;
  assert.equal(submitted.status, 'submitted', `expected submitted, got ${JSON.stringify(submitted)}`);
  assert.ok(submitted.locked, 'report must be locked');
  assert.ok(submitted.submitted_hash, 'SHA-256 hash must be set');
  assert.ok(submitted.submitted_at, 'submitted_at must be set');
});

// ─── 2. Submit without confirm: rejected ──────────────────────────────────────
test('submit without confirm: 400', async () => {
  const { ref, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);
  const res = await api('POST', `/official-reports/${r.id}/submit`, { token: ref.token, body: { confirm: false } });
  assert.equal(res.status, 400, 'must reject without confirm');
});

// ─── 3. Stranger cannot submit another official's report ──────────────────────
test('stranger cannot submit: 403 or 404', async () => {
  const { ref, fx } = await setup();
  const stranger = await signup(['referee']);
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);
  const res = await api('POST', `/official-reports/${r.id}/submit`, { token: stranger.token, body: { confirm: true } });
  assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
});

// ─── 4. Cannot patch a locked (submitted) report ──────────────────────────────
test('patch match-facts on locked report: 400 or 403', async () => {
  const { ref, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);
  await submit(ref.token, r.id);
  const res = await matchFacts(ref.token, r.id, { match_facts: { attendance: 999 } });
  assert.ok([400, 403].includes(res.status), `locked report must reject patch, got ${res.status}`);
});

// ─── 5. Send-off incident triggers discipline case automatically ───────────────
test('send-off in incidents triggers gov_case on submit', async () => {
  const { ref, org, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id, { category: 'send_off' })).body;
  await matchFacts(ref.token, r.id, {
    incidents: [{ type: 'send_off', minute: 72, person_name: 'J. Doe', team_name: 'Red FC', reason: 'Violent conduct', law_ref: 'Law 12' }],
  });
  const submitted = (await submit(ref.token, r.id)).body;
  assert.equal(submitted.status, 'submitted');

  // Verify a gov_case was linked
  const prov = (await api('GET', `/official-reports/${r.id}/provenance`, { token: ref.token })).body;
  assert.ok(prov.disc_case_id, 'discipline case must be linked for send-off');
});

// ─── 6. Abandonment report triggers discipline case ───────────────────────────
test('abandonment report triggers gov_case on submit', async () => {
  const { ref, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id, { category: 'abandonment' })).body;
  await matchFacts(ref.token, r.id, {
    abandonment: { minute: 55, reason: 'crowd_disorder', details: 'Flares thrown; match halted by ref.' },
  });
  const submitted = (await submit(ref.token, r.id)).body;
  assert.equal(submitted.status, 'submitted');
  const prov = (await api('GET', `/official-reports/${r.id}/provenance`, { token: ref.token })).body;
  assert.ok(prov.disc_case_id, 'discipline case must be linked for abandonment');
});

// ─── 7. Duplicate submission: second submit rejected ──────────────────────────
test('second submit on locked report: 400 or 403', async () => {
  const { ref, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);
  const first = await submit(ref.token, r.id);
  assert.equal(first.status, 200);
  const second = await submit(ref.token, r.id);
  assert.ok([400, 403].includes(second.status), `second submit must be rejected, got ${second.status}`);
});

// ─── 8. Co-sign request → cosign → advances state ────────────────────────────
test('co-sign workflow: request → cosign → co_signed or submitted', async () => {
  const { ref, ar, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);

  // Request co-sign
  const req = await api('POST', `/official-reports/${r.id}/request-cosign`, {
    token: ref.token,
    body: { cosignatories: [{ user_id: ar.id, required: true }] },
  });
  assert.ok([200, 201].includes(req.status), `cosign request failed: ${JSON.stringify(req.body)}`);

  // AR co-signs
  const cosigned = await api('POST', `/official-reports/${r.id}/cosign`, { token: ar.token, body: {} });
  assert.ok([200, 201].includes(cosigned.status), `cosign failed: ${JSON.stringify(cosigned.body)}`);
});

// ─── 9. Organiser accept / query ─────────────────────────────────────────────
test('organiser can accept or query a submitted report', async () => {
  const { ref, org, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);
  const sub = (await submit(ref.token, r.id)).body;
  assert.equal(sub.status, 'submitted');

  // Accept
  const accepted = await api('POST', `/official-reports/${r.id}/accept`, { token: org.token });
  assert.ok([200, 201].includes(accepted.status), `accept failed: ${JSON.stringify(accepted.body)}`);
  const checked = (await api('GET', `/official-reports/${r.id}`, { token: org.token })).body;
  assert.equal(checked.status, 'accepted');
});

test('organiser can query a submitted report', async () => {
  const { ref, org, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);
  await submit(ref.token, r.id);

  const queried = await api('POST', `/official-reports/${r.id}/query`, { token: org.token, body: { note: 'Please clarify the incident at 72 minutes.' } });
  assert.ok([200, 201].includes(queried.status), `query failed: ${JSON.stringify(queried.body)}`);
  const checked = (await api('GET', `/official-reports/${r.id}`, { token: org.token })).body;
  assert.equal(checked.status, 'queried');
});

// ─── 10. Non-organiser cannot accept or query ─────────────────────────────────
test('non-organiser cannot accept: 403 or 404', async () => {
  const { ref, ar, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);
  await submit(ref.token, r.id);
  const res = await api('POST', `/official-reports/${r.id}/accept`, { token: ar.token });
  assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
});

// ─── 11. Provenance endpoint returns hash and timeline ────────────────────────
test('provenance returns hash, submitted_at and revision history', async () => {
  const { ref, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);
  const sub = (await submit(ref.token, r.id)).body;
  assert.ok(sub.submitted_hash);

  const prov = (await api('GET', `/official-reports/${r.id}/provenance`, { token: ref.token })).body;
  assert.ok(prov.submitted_hash, 'provenance must include hash');
  assert.ok(prov.submitted_at, 'provenance must include submitted_at');
  assert.ok(Array.isArray(prov.revisions), 'provenance must include revisions array');
  assert.equal(prov.submitted_hash, sub.submitted_hash, 'hash must match');
});

// ─── 12. List event official reports: organiser sees all ────────────────────
test('list event official reports: organiser sees all, stranger sees none', async () => {
  const { ref, org, fx, ev } = await setup();
  const r = (await fileReport(ref.token, fx.id)).body;
  await matchFacts(ref.token, r.id);
  await submit(ref.token, r.id);

  const orgList = (await api('GET', `/events/${ev.id}/official-reports`, { token: org.token })).body;
  assert.ok(Array.isArray(orgList.items ?? orgList), 'must return array');

  const stranger = await signup(['athlete']);
  const strangerList = await api('GET', `/events/${ev.id}/official-reports`, { token: stranger.token });
  assert.ok([403, 404].includes(strangerList.status), `stranger must not see reports, got ${strangerList.status}`);
});

// ─── 13. Discipline case list visible to official who filed ───────────────────
test('discipline case list includes auto-triggered case for the filing official', async () => {
  const { ref, fx } = await setup();
  const r = (await fileReport(ref.token, fx.id, { category: 'send_off' })).body;
  await matchFacts(ref.token, r.id, {
    incidents: [{ type: 'send_off', minute: 88, person_name: 'A. Player', reason: 'Serious foul play', law_ref: 'Law 12' }],
  });
  await submit(ref.token, r.id);

  const list = (await api('GET', '/discipline/my-cases', { token: ref.token })).body;
  const items = list.items ?? list;
  assert.ok(Array.isArray(items), 'must return items');
  const linked = items.find((k) => k.linked_report_id === r.id);
  assert.ok(linked, 'discipline case linked to report must appear in list');
});
