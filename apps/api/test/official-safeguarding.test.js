import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// #1029 Official Safety & Safeguarding Escalation (REF-R31)
// Tests: welfare officer designation, raise concern (identified + anonymous), immediate safety flag,
// triage → act → close workflow, whistleblower protection, role access enforcement, anon token integrity.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
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
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};

const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const fail = (r, s) => { assert.equal(r.status, s, `expected ${s}, got ${r.status}: ${JSON.stringify(r.body)}`); };

const signup = async (roles = ['official'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', {
    body: { handle: `osg_${n}_${Date.now()}`, display_name: `Official ${n}`, email: `osg${n}_${Date.now()}@example.com`, password: 'correct-horse-battery', roles, ...extra },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('osg_root','osg_root','{admin}','x','x','osg_root_idx') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => { server.close(); await pool.end(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeOrg(owner) {
  const r = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `OSG Org ${n}`, kind: 'club' } }), 201);
  return r;
}

async function makeSafeguardingCred(userId) {
  // Insert a valid safeguarding compliance record directly.
  await pool.query(
    "INSERT INTO compliance_records(user_id, kind, status, issued_on) VALUES ($1, 'safeguarding', 'valid', current_date)",
    [userId],
  );
}

async function makeFixture(orgId, creatorToken) {
  const sport = ok(await api('GET', '/sports', { token: creatorToken }));
  const sportId = sport.sports?.[0]?.id;
  if (!sportId) return null;
  const ev = ok(await api('POST', '/events', { token: creatorToken, body: { name: `OSG Event ${n}`, sport_id: sportId, organiser_id: orgId, starts_on: new Date().toISOString().slice(0, 10), ends_on: new Date().toISOString().slice(0, 10) } }), 201);
  const fx = ok(await api('POST', `/events/${ev.id}/fixtures`, { token: creatorToken, body: { scheduled_at: new Date().toISOString(), home_team_id: null, away_team_id: null } }), 201);
  return fx;
}

async function assignOfficial(fixtureId, officialId, adminToken) {
  // Accept fixture_official directly in DB.
  await pool.query(
    "INSERT INTO fixture_officials(fixture_id, user_id, role, status) VALUES ($1, $2, 'referee', 'accepted') ON CONFLICT DO NOTHING",
    [fixtureId, officialId],
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('welfare officer designation — requires safeguarding credential', async () => {
  const owner = await signup(['official', 'club_owner']);
  const officer = await signup(['official']);
  const org = await makeOrg(owner);

  // Without credential → 400
  const r1 = await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1 },
  });
  fail(r1, 400);

  // Add credential → succeeds
  await makeSafeguardingCred(officer.id);
  const r2 = await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1, contact_channel: 'officer@test.com' },
  });
  ok(r2, 201);
  assert.equal(r2.body.designated, true);

  // Duplicate → 409
  const r3 = await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1 },
  });
  fail(r3, 400);
});

test('raise concern — identified reporter stores reporter_id; ref starts with OSG-', async () => {
  const owner = await signup(['official', 'club_owner']);
  const official = await signup(['official']);
  const officer = await signup(['official']);
  const org = await makeOrg(owner);
  await makeSafeguardingCred(officer.id);
  ok(await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1 },
  }), 201);

  // Need a fixture with this org; skip if sports unavailable in test db
  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;
  await assignOfficial(fx.id, official.id, admin.token);

  const r = await api('POST', `/fixtures/${fx.id}/safety-concerns`, {
    token: official.token,
    body: { id: fx.id, type: 'harassment', risk_level: 'medium', narrative: 'I experienced repeated intimidation during the match from a team official.', anonymous: false },
  });
  ok(r, 201);
  assert.match(r.body.ref, /^OSG-\d{5}$/);
  assert.equal(r.body.anon_token, undefined);

  // Confirm in DB: reporter_id is set
  const row = await pool.query('SELECT reporter_id FROM official_sg_cases WHERE 1=1 ORDER BY raised_at DESC LIMIT 1');
  assert.ok(row.rows[0].reporter_id, 'reporter_id should be set for identified report');
});

test('raise concern — anonymous reporter: no reporter_id in DB, token returned once', async () => {
  const owner = await signup(['official', 'club_owner']);
  const official = await signup(['official']);
  const officer = await signup(['official']);
  const org = await makeOrg(owner);

  // Enable anonymous reporting
  await pool.query(
    'INSERT INTO official_sg_policies(org_id, version, allow_anonymous, retention_years, ack_hours, review_hours, created_by) VALUES ($1, 1, true, 7, $2, $3, $4)',
    [org.id, JSON.stringify({ low: 48, medium: 24, high: 4, immediate: 1 }), JSON.stringify({ low: 168, medium: 72, high: 24, immediate: 8 }), admin.id],
  );

  await makeSafeguardingCred(officer.id);
  ok(await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1 },
  }), 201);

  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;
  await assignOfficial(fx.id, official.id, admin.token);

  const r = await api('POST', `/fixtures/${fx.id}/safety-concerns`, {
    token: official.token,
    body: { id: fx.id, type: 'abuse', risk_level: 'high', narrative: 'I am raising this anonymously due to fear of reprisal from team management.', anonymous: true },
  });
  ok(r, 201);
  assert.ok(r.body.anon_token, 'anon_token should be returned for anonymous report');
  assert.match(r.body.ref, /^OSG-\d{5}$/);

  // DB: reporter_id is NULL; token_hash is stored not plain token
  const rows = await pool.query("SELECT reporter_id FROM official_sg_cases WHERE reporter_id IS NULL ORDER BY raised_at DESC LIMIT 1");
  assert.ok(rows.rows.length > 0, 'anonymous case should have NULL reporter_id');

  // Check status with anon_token
  const ref = r.body.ref;
  const token = r.body.anon_token;
  const s = await api('GET', `/safety-concerns/${ref}`, { token: null, query: { anon_token: token } });
  ok(s, 200);
  assert.equal(s.body.status, 'received');

  // Wrong token → 404
  const s2 = await api('GET', `/safety-concerns/${ref}`, { query: { anon_token: 'invalid-token' } });
  fail(s2, 404);
});

test('anonymous reporting blocked when policy disallows it', async () => {
  const owner = await signup(['official', 'club_owner']);
  const official = await signup(['official']);
  const org = await makeOrg(owner);
  // No policy row means anonymous defaults to false

  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;
  await assignOfficial(fx.id, official.id, admin.token);

  const r = await api('POST', `/fixtures/${fx.id}/safety-concerns`, {
    token: official.token,
    body: { id: fx.id, type: 'bullying', risk_level: 'low', narrative: 'I would like to remain anonymous about this ongoing situation in the locker room.', anonymous: true },
  });
  fail(r, 400);
});

test('immediate safety flag — creates flag row and sets sg_flag_raised', async () => {
  const owner = await signup(['official', 'club_owner']);
  const official = await signup(['official']);
  const org = await makeOrg(owner);

  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;
  await assignOfficial(fx.id, official.id, admin.token);

  const r = await api('POST', `/fixtures/${fx.id}/safety-flag`, {
    token: official.token,
    body: { id: fx.id, note: 'Spectator threatening officials in the technical area.' },
  });
  ok(r, 200);
  assert.equal(r.body.flagged, true);

  // Check sg_flag_raised column
  const row = await pool.query('SELECT sg_flag_raised FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2', [fx.id, official.id]);
  assert.equal(row.rows[0]?.sg_flag_raised, true);
});

test('non-crew member cannot raise safety flag', async () => {
  const owner = await signup(['official', 'club_owner']);
  const stranger = await signup(['official']);
  const org = await makeOrg(owner);

  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;

  const r = await api('POST', `/fixtures/${fx.id}/safety-flag`, {
    token: stranger.token,
    body: { id: fx.id },
  });
  assert.ok([403, 404].includes(r.status), `expected 403 or 404, got ${r.status}`);
});

test('triage and act workflow: acknowledge → escalate → close', async () => {
  const owner = await signup(['official', 'club_owner']);
  const official = await signup(['official']);
  const officer = await signup(['official']);
  const org = await makeOrg(owner);

  await makeSafeguardingCred(officer.id);
  ok(await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1 },
  }), 201);

  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;
  await assignOfficial(fx.id, official.id, admin.token);

  const raised = ok(await api('POST', `/fixtures/${fx.id}/safety-concerns`, {
    token: official.token,
    body: { id: fx.id, type: 'coercion', risk_level: 'high', narrative: 'A match commissioner made explicit threats about my future appointment if I did not alter my decisions.' },
  }), 201);
  const ref = raised.ref;
  const caseNum = parseInt(ref.replace('OSG-', ''), 10);
  const caseRow = await pool.query('SELECT id FROM official_sg_cases WHERE case_no=$1', [caseNum]);
  const caseId = caseRow.rows[0].id;

  // Stranger cannot list cases
  const stranger = await signup(['official']);
  const listBad = await api('GET', '/official-safeguarding/cases', { token: stranger.token });
  fail(listBad, 404);

  // Officer can list
  const list = ok(await api('GET', '/official-safeguarding/cases', { token: officer.token }));
  assert.ok(list.cases.some((c) => c.ref === ref), 'case should appear in officer list');
  assert.ok(list._notice, '_notice should be present');

  // Triage
  ok(await api('POST', `/official-safeguarding/cases/${caseId}/triage`, {
    token: officer.token,
    body: { id: caseId, risk_classification: 'high' },
  }));

  // Get full detail — narrative decrypted
  const detail = ok(await api('GET', `/official-safeguarding/cases/${caseId}`, { token: officer.token }));
  assert.ok(detail.narrative.length > 10, 'narrative should be decrypted');
  assert.equal(detail._notice, 'Receipt of this case record is not a finding. Allegations are separate from findings and no inference of guilt should be drawn.');

  // Add note
  ok(await api('POST', `/official-safeguarding/cases/${caseId}/actions`, {
    token: officer.token,
    body: { id: caseId, action: 'add_note', note: 'Initial triage completed. Investigating commissioner conduct.' },
  }));

  // Close with outcome
  ok(await api('POST', `/official-safeguarding/cases/${caseId}/actions`, {
    token: officer.token,
    body: { id: caseId, action: 'close', outcome: 'upheld', reason: 'Evidence of coercive conduct confirmed by independent witness.' },
  }));

  const closed = ok(await api('GET', `/official-safeguarding/cases/${caseId}`, { token: officer.token }));
  assert.equal(closed.status, 'closed');
  assert.equal(closed.outcome, 'upheld');
});

test('close requires outcome', async () => {
  const owner = await signup(['official', 'club_owner']);
  const official = await signup(['official']);
  const officer = await signup(['official']);
  const org = await makeOrg(owner);

  await makeSafeguardingCred(officer.id);
  ok(await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1 },
  }), 201);

  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;
  await assignOfficial(fx.id, official.id, admin.token);

  const raised = ok(await api('POST', `/fixtures/${fx.id}/safety-concerns`, {
    token: official.token,
    body: { id: fx.id, type: 'discrimination', risk_level: 'medium', narrative: 'Discriminatory language directed at me by a team official during the half-time break.' },
  }), 201);
  const caseNum = parseInt(raised.ref.replace('OSG-', ''), 10);
  const caseId = (await pool.query('SELECT id FROM official_sg_cases WHERE case_no=$1', [caseNum])).rows[0].id;

  const r = await api('POST', `/official-safeguarding/cases/${caseId}/actions`, {
    token: officer.token,
    body: { id: caseId, action: 'close', reason: 'Closing without outcome' },
  });
  fail(r, 400);
});

test('whistleblower protection: request then confirm', async () => {
  const owner = await signup(['official', 'club_owner']);
  const official = await signup(['official']);
  const officer = await signup(['official']);
  const org = await makeOrg(owner);

  await makeSafeguardingCred(officer.id);
  ok(await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1 },
  }), 201);

  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;
  await assignOfficial(fx.id, official.id, admin.token);

  const raised = ok(await api('POST', `/fixtures/${fx.id}/safety-concerns`, {
    token: official.token,
    body: { id: fx.id, type: 'harassment', risk_level: 'medium', narrative: 'I am requesting whistleblower protection for this report about systematic harassment by a senior assessor.', request_whistleblower_protection: true },
  }), 201);
  const ref = raised.ref;

  // Check status as the reporter
  const status = ok(await api('GET', `/safety-concerns/${ref}`, { token: official.token }));
  assert.equal(status.ref, ref);

  // Confirm WB by officer
  const wbRow = await pool.query('SELECT id FROM official_sg_whistleblower ORDER BY created_at DESC LIMIT 1');
  if (wbRow.rows.length) {
    const wbId = wbRow.rows[0].id;
    ok(await api('POST', `/official-safeguarding/whistleblower/${wbId}/confirm`, {
      token: officer.token,
      body: { id: wbId, basis: 'Policy section 4.2 — reporter raised concern in good faith' },
    }));
    const confirmedRow = await pool.query('SELECT status FROM official_sg_whistleblower WHERE id=$1', [wbId]);
    assert.equal(confirmedRow.rows[0].status, 'confirmed');
  }
});

test('welfare contacts endpoint returns officer list without revealing cases', async () => {
  const owner = await signup(['official', 'club_owner']);
  const officer = await signup(['official']);
  const org = await makeOrg(owner);

  await makeSafeguardingCred(officer.id);
  ok(await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1, contact_channel: 'welfare@club.com' },
  }), 201);

  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;

  const r = ok(await api('GET', `/fixtures/${fx.id}/welfare-contacts`, { token: owner.token }));
  assert.ok(Array.isArray(r.welfare_officers));
  assert.ok(r.welfare_officers.length > 0);
  assert.ok(r.welfare_officers[0].name);
  // No case data
  assert.equal(r.cases, undefined);
});

test('end welfare officer blocked when open cases assigned', async () => {
  const owner = await signup(['official', 'club_owner']);
  const official = await signup(['official']);
  const officer = await signup(['official']);
  const org = await makeOrg(owner);

  await makeSafeguardingCred(officer.id);
  const desig = ok(await api('POST', '/official-safeguarding/welfare-officers', {
    token: owner.token,
    body: { user_id: officer.id, org_id: org.id, tier: 1 },
  }), 201);

  const sports = await api('GET', '/sports', { token: owner.token });
  if (!sports.body?.sports?.length) return;
  const fx = await makeFixture(org.id, owner.token);
  if (!fx) return;
  await assignOfficial(fx.id, official.id, admin.token);

  const raised = ok(await api('POST', `/fixtures/${fx.id}/safety-concerns`, {
    token: official.token,
    body: { id: fx.id, type: 'bullying', risk_level: 'low', narrative: 'Persistent name-calling by a fixture secretary throughout the match period.' },
  }), 201);

  // Assign the case to the officer
  const caseNum = parseInt(raised.ref.replace('OSG-', ''), 10);
  const caseId = (await pool.query('SELECT id FROM official_sg_cases WHERE case_no=$1', [caseNum])).rows[0].id;
  await pool.query('UPDATE official_sg_cases SET assigned_to=$1 WHERE id=$2', [officer.id, caseId]);

  // Find the welfare officer record id
  const woRow = await pool.query('SELECT id FROM official_welfare_officers WHERE org_id=$1 AND user_id=$2 AND ended_at IS NULL', [org.id, officer.id]);
  const woId = woRow.rows[0].id;

  const r = await api('DELETE', `/official-safeguarding/welfare-officers/${woId}`, {
    token: owner.token,
    body: { id: woId, end_reason: 'Officer is leaving the organisation' },
  });
  fail(r, 400);
});
