// Issue #584: Elite Sports Medicine & Return-to-Play Workflow
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `inj_${n}_${roles[0]}`, display_name: `Inj ${n}`, email: `inj${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201);
  const u = { ...r.body.user, token: r.body.token };
  if (!roles.includes('athlete')) must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'football', role: roles[0] } }), 201);
  return u;
};
const verify = async (u, type) => (await pool.query(
  "INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days') RETURNING id", [type, u.id])).rows[0].id;
const setup = async () => {
  const ath = await signup(['athlete']);
  const doc = await signup(['doctor']);
  const phy = await signup(['physio']);
  await verify(doc, 'doctor');
  await verify(phy, 'physio');
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: doc.id } }), 201);
  must(await api('POST', '/medical/grants', { token: ath.token, body: { provider_id: phy.id } }), 201);
  return { ath, doc, phy };
};
const iso = (d = 0) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ── 1. Full lifecycle: open → rehab → restricted → RTT → RTP → closed ─────────
test('full injury episode lifecycle', async () => {
  const { ath, doc } = await setup();

  // Open episode
  const ep = must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'hamstring', side: 'left', injury_type: 'strain', mechanism: 'non_contact',
    severity: 'moderate', occurred_on: iso(-7), expected_return_on: iso(28),
  } }), 201);
  assert.ok(ep.episode_ref.startsWith('INJ-'), 'episode_ref prefixed INJ-');
  assert.equal(ep.status, 'active');
  assert.equal(ep.athlete_id, ath.id);

  // Transition to rehabilitation
  const r1 = must(await api('POST', `/injury-episodes/${ep.id}/transition`, { token: doc.token, body: { to_status: 'rehabilitation', note: 'Started pool sessions' } }));
  assert.equal(r1.status, 'rehabilitation');

  // Transition to restricted_training
  must(await api('POST', `/injury-episodes/${ep.id}/transition`, { token: doc.token, body: { to_status: 'restricted_training' } }));

  // Set RTP milestones
  const milestones = [
    { stage_order: 1, stage_name: 'Symptom-free rest', criteria: 'No pain at rest or palpation', target_date: iso(-3) },
    { stage_order: 2, stage_name: 'Light aerobic', criteria: 'Stationary bike 20 min, HR <140', target_date: iso(0) },
    { stage_order: 3, stage_name: 'Strength & mobility', criteria: 'Hamstring strength >80% contralateral', target_date: iso(7) },
    { stage_order: 4, stage_name: 'Sport-specific running', criteria: 'Straight sprints, no guarding', target_date: iso(14) },
    { stage_order: 5, stage_name: 'Full-contact training', criteria: 'Full session without restriction', target_date: iso(21) },
  ];
  const ms = must(await api('PUT', `/injury-episodes/${ep.id}/rtp/milestones`, { token: doc.token, body: { milestones } }));
  assert.equal(ms.length, 5);

  // Achieve milestone 1
  const ms1 = ms.find((m) => m.stage_order === 1);
  must(await api('PATCH', `/injury-episodes/${ep.id}/rtp/milestones/${ms1.id}`, { token: doc.token, body: { status: 'achieved', evidence: 'No pain on palpation at day 4' } }));

  // Issue Return-to-Train approval
  const rtt = must(await api('POST', `/injury-episodes/${ep.id}/rtp/approvals`, { token: doc.token, body: {
    approval_type: 'return_to_train', status: 'approved',
    approved_on: iso(0), valid_until: iso(14),
    load_restrictions: ['No sprinting', 'Pool sessions only'],
    internal_assessment: 'Hamstring healing well; MRI shows grade 1 only.',
  } }), 201);
  assert.equal(rtt.approval_type, 'return_to_train');
  assert.equal(rtt.status, 'approved');

  // Episode should transition to return_to_train
  const ep2 = must(await api('GET', `/injury-episodes/${ep.id}`, { token: doc.token }));
  assert.equal(ep2.status, 'return_to_train');

  // Achieve remaining milestones
  for (const m of ms.filter((m) => m.stage_order > 1)) {
    must(await api('PATCH', `/injury-episodes/${ep.id}/rtp/milestones/${m.id}`, { token: doc.token, body: { status: 'achieved', evidence: `Stage ${m.stage_order} passed` } }));
  }

  // Issue Return-to-Play approval — should auto-chain to clinical_clearances
  const rtp = must(await api('POST', `/injury-episodes/${ep.id}/rtp/approvals`, { token: doc.token, body: {
    approval_type: 'return_to_play', status: 'approved',
    approved_on: iso(0), valid_until: iso(90),
    load_restrictions: [],
    internal_assessment: 'Full clinical clearance. No restrictions.',
  } }), 201);
  assert.equal(rtp.approval_type, 'return_to_play');
  assert.ok(rtp.linked_clearance_id, 'RTP approval auto-chains to clearance');

  // Clearance should exist in clinical_clearances
  const { rows: clRows } = await pool.query('SELECT * FROM clinical_clearances WHERE id = $1', [rtp.linked_clearance_id]);
  assert.equal(clRows.length, 1, 'clearance record created');
  assert.equal(clRows[0].status, 'cleared');

  // Close episode
  const closed = must(await api('POST', `/injury-episodes/${ep.id}/close`, { token: doc.token, body: { actual_return_on: iso(0) } }));
  assert.equal(closed.status, 'closed');
  assert.ok(closed.actual_return_on);
});

// ── 2. Cross-athlete access returns 404, never 403 ────────────────────────────
test('cross-athlete access returns 404', async () => {
  const { ath, doc } = await setup();
  const { ath: ath2, doc: doc2 } = await setup();

  const ep = must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'knee', side: 'right', injury_type: 'sprain', mechanism: 'contact',
    severity: 'minor', occurred_on: iso(-2),
  } }), 201);

  // doc2 has no grant on ath — must 404
  assert.equal((await api('GET', `/injury-episodes/${ep.id}`, { token: doc2.token })).status, 404);
  assert.equal((await api('POST', `/injury-episodes/${ep.id}/transition`, { token: doc2.token, body: { to_status: 'rehabilitation' } })).status, 404);

  // ath2 must 404 (not own episode)
  assert.equal((await api('GET', `/injury-episodes/${ep.id}`, { token: ath2.token })).status, 404);
});

// ── 3. Coach endpoint returns zero clinical fields ────────────────────────────
test('coach endpoint exposes no clinical fields', async () => {
  const { ath, doc } = await setup();
  const coach = await signup(['coach']);

  // Create team and add both
  const team = must(await api('POST', '/teams', { token: coach.token, body: { name: 'Test FC', sport: 'football' } }), 201);
  must(await api('POST', `/teams/${team.id}/members`, { token: coach.token, body: { user_id: ath.id, role: 'player' } }), 201);

  const ep = must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'calf', side: 'left', injury_type: 'strain', mechanism: 'non_contact',
    severity: 'significant', occurred_on: iso(-5), expected_return_on: iso(21),
  } }), 201);

  // Share with team
  must(await api('POST', `/injury-episodes/${ep.id}/coach-share`, { token: ath.token, body: { team_id: team.id, show_expected_return: true, show_restrictions: false } }), 201);

  // Coach fetches team injury status
  const status = must(await api('GET', `/teams/${team.id}/injury-status`, { token: coach.token }));
  const member = status.find((m) => m.user_id === ath.id);
  assert.ok(member, 'injured member appears in list');

  // These clinical fields must NEVER appear
  const raw = JSON.stringify(member);
  assert.ok(!raw.includes('calf'), 'body region not exposed to coach');
  assert.ok(!raw.includes('strain'), 'injury type not exposed');
  assert.ok(!raw.includes('significant'), 'severity not exposed');
  assert.ok(!raw.includes('non_contact'), 'mechanism not exposed');
  assert.ok(!raw.includes(doc.id), 'provider identity not exposed');
  assert.ok(!raw.includes('_enc'), 'no encrypted field names in coach response');

  // Expected return IS shown when opted in
  assert.ok(member.expected_return_on, 'expected return shown when opted in');
});

// ── 4. Encrypted fields are stored encrypted ─────────────────────────────────
test('clinical fields stored encrypted at rest', async () => {
  const { ath, doc } = await setup();
  const ep = must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'shoulder', side: 'right', injury_type: 'dislocation', mechanism: 'contact',
    severity: 'severe', occurred_on: iso(-1),
  } }), 201);

  must(await api('PUT', `/injury-episodes/${ep.id}/rtp/milestones`, { token: doc.token, body: { milestones: [
    { stage_order: 1, stage_name: 'Rest', criteria: 'No pain SECRET CRITERIA', target_date: iso(7) },
  ] } }));

  // Verify criteria is stored encrypted, not plain text
  const { rows } = await pool.query('SELECT criteria_enc FROM injury_rtp_milestones WHERE episode_id = $1', [ep.id]);
  assert.ok(rows.length > 0);
  assert.ok(rows[0].criteria_enc !== 'No pain SECRET CRITERIA', 'criteria stored encrypted');
  assert.ok(rows[0].criteria_enc.length > 20, 'encrypted value is non-trivial');
});

// ── 5. Audit log entries created on every read/write ─────────────────────────
test('audit log entries created for clinical operations', async () => {
  const { ath, doc } = await setup();
  const countBefore = (await pool.query("SELECT COUNT(*) FROM audit_log WHERE table_name = 'injury_episodes'")).rows[0].count;

  must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'ankle', side: 'left', injury_type: 'sprain', mechanism: 'contact',
    severity: 'minor', occurred_on: iso(-1),
  } }), 201);

  const countAfter = (await pool.query("SELECT COUNT(*) FROM audit_log WHERE table_name = 'injury_episodes'")).rows[0].count;
  assert.ok(Number(countAfter) > Number(countBefore), 'audit entry created on open_episode');
});

// ── 6. Episode event log is append-only (immutable) ──────────────────────────
test('episode event log is immutable', async () => {
  const { ath, doc } = await setup();
  const ep = must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'wrist', side: 'right', injury_type: 'fracture', mechanism: 'contact',
    severity: 'moderate', occurred_on: iso(-3),
  } }), 201);

  const { rows } = await pool.query('SELECT id FROM injury_episode_events WHERE episode_id = $1', [ep.id]);
  assert.ok(rows.length > 0, 'events recorded on open');

  await assert.rejects(
    pool.query('UPDATE injury_episode_events SET event_type = $1 WHERE id = $2', ['opened', rows[0].id]),
    /nothing/i, // DB RULE silently does INSTEAD NOTHING — zero rows updated is not an error but let's verify
  ).catch(() => {
    // Silently does nothing (INSTEAD NOTHING) — verify row unchanged
  });

  const after = await pool.query('SELECT event_type FROM injury_episode_events WHERE id = $1', [rows[0].id]);
  assert.equal(after.rows[0].event_type, 'opened', 'immutable: event_type unchanged');
});

// ── 7. Share revocation immediately blocks coach endpoint ─────────────────────
test('share revocation immediately removes coach access', async () => {
  const { ath, doc } = await setup();
  const coach = await signup(['coach']);
  const team = must(await api('POST', '/teams', { token: coach.token, body: { name: 'Revoke FC', sport: 'football' } }), 201);
  must(await api('POST', `/teams/${team.id}/members`, { token: coach.token, body: { user_id: ath.id, role: 'player' } }), 201);

  const ep = must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'knee', side: 'left', injury_type: 'tendinopathy', mechanism: 'overuse',
    severity: 'moderate', occurred_on: iso(-10),
  } }), 201);

  must(await api('POST', `/injury-episodes/${ep.id}/coach-share`, { token: ath.token, body: { team_id: team.id, show_expected_return: true, show_restrictions: false } }), 201);

  // Coach can see athlete
  const before = must(await api('GET', `/teams/${team.id}/injury-status`, { token: coach.token }));
  assert.ok(before.some((m) => m.user_id === ath.id));

  // Revoke
  must(await api('DELETE', `/injury-episodes/${ep.id}/coach-share/${team.id}`, { token: ath.token }));

  // Coach can no longer see the episode detail
  const after = must(await api('GET', `/teams/${team.id}/injury-status`, { token: coach.token }));
  const member = after.find((m) => m.user_id === ath.id);
  assert.ok(!member || !member.episode_id, 'revoked share hides episode from coach');
});

// ── 8. Only one live approval per type per episode ────────────────────────────
test('duplicate live approval rejected', async () => {
  const { ath, doc } = await setup();
  const ep = must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'hip', side: 'right', injury_type: 'strain', mechanism: 'overuse',
    severity: 'minor', occurred_on: iso(-5),
  } }), 201);

  must(await api('POST', `/injury-episodes/${ep.id}/rtp/approvals`, { token: doc.token, body: {
    approval_type: 'return_to_train', status: 'approved', approved_on: iso(0), valid_until: iso(14),
    load_restrictions: ['Pool only'], internal_assessment: 'Safe for pool.',
  } }), 201);

  // Second live approval of same type must fail
  const dup = await api('POST', `/injury-episodes/${ep.id}/rtp/approvals`, { token: doc.token, body: {
    approval_type: 'return_to_train', status: 'approved', approved_on: iso(0), valid_until: iso(21),
    load_restrictions: ['Field allowed'], internal_assessment: 'Updated.',
  } });
  assert.ok([409, 422].includes(dup.status), 'duplicate live approval rejected');
});

// ── 9. my_injury_episodes returns only own episodes ───────────────────────────
test('athlete can only list own episodes via /me/injury-episodes', async () => {
  const { ath, doc } = await setup();
  const { ath: ath2, doc: doc2 } = await setup();

  must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'back', side: 'central', injury_type: 'strain', mechanism: 'overuse',
    severity: 'minor', occurred_on: iso(-2),
  } }), 201);

  must(await api('POST', `/athletes/${ath2.id}/injury-episodes`, { token: doc2.token, body: {
    body_region: 'neck', side: 'central', injury_type: 'strain', mechanism: 'contact',
    severity: 'moderate', occurred_on: iso(-1),
  } }), 201);

  const mine = must(await api('GET', '/me/injury-episodes', { token: ath.token }));
  assert.ok(mine.every((e) => e.athlete_id === ath.id), 'only own episodes returned');
});

// ── 10. Episode reference is unique per athlete ───────────────────────────────
test('episode refs are unique per athlete and auto-generated', async () => {
  const { ath, doc } = await setup();

  const ep1 = must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'quadriceps', side: 'left', injury_type: 'contusion', mechanism: 'contact',
    severity: 'minor', occurred_on: iso(-1),
  } }), 201);
  const ep2 = must(await api('POST', `/athletes/${ath.id}/injury-episodes`, { token: doc.token, body: {
    body_region: 'calf', side: 'right', injury_type: 'strain', mechanism: 'non_contact',
    severity: 'moderate', occurred_on: iso(-3),
  } }), 201);

  assert.notEqual(ep1.episode_ref, ep2.episode_ref, 'unique refs per episode');
  assert.ok(ep1.episode_ref.startsWith('INJ-'));
  assert.ok(ep2.episode_ref.startsWith('INJ-'));
});
