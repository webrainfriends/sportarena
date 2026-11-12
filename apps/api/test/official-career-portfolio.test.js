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
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `port_${n}_${roles[0]}`, display_name: `Port ${n}`, email: `port${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setupOrgAndOfficial() {
  const org = await signup(['organizer']);
  const off = await signup(['referee']);
  await api('POST', '/me/sport-profiles', { token: off.token, body: { sport: 'basketball', role: 'referee' } });
  return { org, off };
}

// ── Settings ─────────────────────────────────────────────────────────────────

test('portfolio settings: defaults returned when no settings saved', async () => {
  const { off } = await setupOrgAndOfficial();
  const r = await api('GET', '/me/officials/portfolio/settings', { token: off.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.visibility, 'private');
  assert.equal(r.body.show_grades, true);
});

test('portfolio settings: configure visibility and section toggles', async () => {
  const { off } = await setupOrgAndOfficial();
  const r = await api('PUT', '/me/officials/portfolio/settings', {
    token: off.token,
    body: { visibility: 'public', show_grades: false, show_match_count: false },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.visibility, 'public');
  assert.equal(r.body.show_grades, false);
  assert.equal(r.body.show_match_count, false);
  // idempotent update: persisted
  const r2 = await api('GET', '/me/officials/portfolio/settings', { token: off.token });
  assert.equal(r2.body.visibility, 'public');
});

// ── Portfolio assembly ────────────────────────────────────────────────────────

test('portfolio: returns career summary with zero matches for new official', async () => {
  const { off } = await setupOrgAndOfficial();
  const r = await api('GET', '/me/officials/portfolio', { token: off.token });
  assert.equal(r.status, 200);
  assert.ok('summary' in r.body);
  assert.equal(r.body.summary.total_matches, 0);
  assert.ok(Array.isArray(r.body.by_sport));
  assert.ok(Array.isArray(r.body.grades));
  assert.ok(Array.isArray(r.body.milestones));
  assert.ok(Array.isArray(r.body.references));
});

test('public portfolio: returns 404 for private (not 403 — existence not leaked)', async () => {
  const { off } = await setupOrgAndOfficial();
  // settings not set = private by default
  const stranger = await signup(['athlete']);
  const r = await api('GET', `/officials/${off.id}/portfolio`, { token: stranger.token });
  assert.equal(r.status, 404, 'private portfolio must return 404, not 403');
});

test('public portfolio: visible once set to public', async () => {
  const { off } = await setupOrgAndOfficial();
  await api('PUT', '/me/officials/portfolio/settings', { token: off.token, body: { visibility: 'public' } });
  const stranger = await signup(['athlete']);
  const r = await api('GET', `/officials/${off.id}/portfolio`);
  assert.equal(r.status, 200);
  assert.ok('summary' in r.body);
});

test('public portfolio: PII never in public response', async () => {
  const { off } = await setupOrgAndOfficial();
  await api('PUT', '/me/officials/portfolio/settings', { token: off.token, body: { visibility: 'public' } });
  const r = await api('GET', `/officials/${off.id}/portfolio`);
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.body);
  assert.ok(!body.includes('_enc'), 'encrypted field names must not appear in public response');
  assert.ok(!body.includes('contact_email'), 'contact_email must never appear in public response');
  assert.ok(!body.includes('holder_number'), 'holder_number must never appear in public response');
});

test('public portfolio: show_grades=false hides grades and licences', async () => {
  const { off } = await setupOrgAndOfficial();
  await api('PUT', '/me/officials/portfolio/settings', { token: off.token, body: { visibility: 'public', show_grades: false } });
  const r = await api('GET', `/officials/${off.id}/portfolio`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.grades, []);
  assert.deepEqual(r.body.licences, []);
});

// ── Milestones ────────────────────────────────────────────────────────────────

test('milestone: add, fetch, edit, soft-archive lifecycle', async () => {
  const { off } = await setupOrgAndOfficial();

  const add = await api('POST', '/me/officials/portfolio/milestones', {
    token: off.token,
    body: { title: 'FIFA U20 World Cup', milestone_date: '2024-06-01', is_championship: true },
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.verification_status, 'self_declared');
  assert.equal(add.body.is_championship, true);
  const mid = add.body.id;

  const portfolio = await api('GET', '/me/officials/portfolio', { token: off.token });
  assert.ok(portfolio.body.milestones.some((m) => m.id === mid));

  const edit = await api('PATCH', `/me/officials/portfolio/milestones/${mid}`, {
    token: off.token,
    body: { title: 'FIFA U20 World Cup 2024' },
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.title, 'FIFA U20 World Cup 2024');

  const del = await api('DELETE', `/me/officials/portfolio/milestones/${mid}`, { token: off.token });
  assert.equal(del.status, 200);
  assert.equal(del.body.archived, true);

  const after = await api('GET', '/me/officials/portfolio', { token: off.token });
  assert.ok(!after.body.milestones.some((m) => m.id === mid), 'archived milestone should not appear');
});

test('milestone: cannot edit someone else\'s milestone', async () => {
  const { off } = await setupOrgAndOfficial();
  const off2 = await signup(['referee']);
  const add = await api('POST', '/me/officials/portfolio/milestones', {
    token: off.token,
    body: { title: 'Olympic Final', milestone_date: '2024-08-10' },
  });
  const r = await api('PATCH', `/me/officials/portfolio/milestones/${add.body.id}`, {
    token: off2.token,
    body: { title: 'Edited by stranger' },
  });
  assert.equal(r.status, 403);
});

test('milestone: cannot edit a verified milestone', async () => {
  const { off, org } = await setupOrgAndOfficial();
  const orgRecord = await api('POST', '/organisations', { token: org.token, body: { name: `VerifyOrg${n}`, type: 'club' } });
  const orgId = orgRecord.body.id;

  const add = await api('POST', '/me/officials/portfolio/milestones', {
    token: off.token,
    body: { title: 'Champions League Final', milestone_date: '2024-05-01', verifying_org_id: orgId },
  });
  assert.equal(add.body.verification_status, 'pending');
  const mid = add.body.id;

  // org owner verifies it
  const ver = await api('POST', `/officials/portfolio/milestones/${mid}/verify`, {
    token: org.token,
    body: { action: 'verify', note: 'Confirmed from our records' },
  });
  assert.equal(ver.status, 200);
  assert.equal(ver.body.verification_status, 'verified');

  // attempt to edit must fail
  const edit = await api('PATCH', `/me/officials/portfolio/milestones/${mid}`, {
    token: off.token,
    body: { title: 'Should not change' },
  });
  assert.equal(edit.status, 409, 'verified milestones are immutable');
});

// ── References ────────────────────────────────────────────────────────────────

test('reference: request → org responds → public summary visible, PII hidden', async () => {
  const { off, org } = await setupOrgAndOfficial();
  const orgRecord = await api('POST', '/organisations', { token: org.token, body: { name: `RefOrg${n}`, type: 'club' } });
  const orgId = orgRecord.body.id;

  const req = await api('POST', '/me/officials/portfolio/references', {
    token: off.token,
    body: {
      org_id: orgId, relationship: 'worked_with',
      contact_name: 'Jane Smith', contact_email: 'jane@example.com',
      request_note: 'Refereed for your club for 3 seasons',
    },
  });
  assert.equal(req.status, 201);
  assert.equal(req.body.response_status, 'pending');
  const rid = req.body.id;

  // only org admin can respond
  const badRespond = await api('POST', `/officials/portfolio/references/${rid}/respond`, {
    token: off.token, // not org admin
    body: { action: 'approve', public_summary: 'Excellent referee' },
  });
  assert.equal(badRespond.status, 403);

  // approve without public_summary should fail
  const noSummary = await api('POST', `/officials/portfolio/references/${rid}/respond`, {
    token: org.token,
    body: { action: 'approve' },
  });
  assert.equal(noSummary.status, 400);

  const approve = await api('POST', `/officials/portfolio/references/${rid}/respond`, {
    token: org.token,
    body: { action: 'approve', public_summary: 'Highly professional referee, officiated 40+ matches for us' },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.response_status, 'approved');

  // check PII stays hidden in portfolio
  await api('PUT', '/me/officials/portfolio/settings', { token: off.token, body: { visibility: 'public' } });
  const pub = await api('GET', `/officials/${off.id}/portfolio`);
  assert.equal(pub.status, 200);
  const pubRef = pub.body.references.find((r) => r.id === rid);
  assert.ok(pubRef, 'approved reference appears publicly');
  assert.equal(pubRef.public_summary, 'Highly professional referee, officiated 40+ matches for us');
  const refStr = JSON.stringify(pubRef);
  assert.ok(!refStr.includes('contact_email'), 'contact email must not leak publicly');
  assert.ok(!refStr.includes('contact_name'), 'contact name must not leak publicly');
  assert.ok(!refStr.includes('_enc'), 'encrypted field names must not appear');
});

test('reference: revoke removes from public view', async () => {
  const { off, org } = await setupOrgAndOfficial();
  const orgRecord = await api('POST', '/organisations', { token: org.token, body: { name: `RevokeOrg${n}`, type: 'club' } });
  const orgId = orgRecord.body.id;
  await api('PUT', '/me/officials/portfolio/settings', { token: off.token, body: { visibility: 'public' } });

  const req = await api('POST', '/me/officials/portfolio/references', {
    token: off.token, body: { org_id: orgId, relationship: 'supervised' },
  });
  await api('POST', `/officials/portfolio/references/${req.body.id}/respond`, {
    token: org.token, body: { action: 'approve', public_summary: 'Supervised officiating successfully' },
  });

  const beforeRevoke = await api('GET', `/officials/${off.id}/portfolio`);
  assert.ok(beforeRevoke.body.references.some((r) => r.id === req.body.id));

  await api('POST', `/me/officials/portfolio/references/${req.body.id}/revoke`, { token: off.token });
  const afterRevoke = await api('GET', `/officials/${off.id}/portfolio`);
  assert.ok(!afterRevoke.body.references.some((r) => r.id === req.body.id), 'revoked reference must not appear publicly');
});

// ── PDF export ────────────────────────────────────────────────────────────────

test('export: cannot export with no data', async () => {
  const { off } = await setupOrgAndOfficial();
  const r = await api('POST', '/me/officials/portfolio/exports', { token: off.token, body: {} });
  assert.equal(r.status, 400);
  assert.ok(r.body.error?.message?.toLowerCase().includes('nothing'));
});

test('export: idempotent via client_key', async () => {
  // Need some data — add a grade manually via sql to avoid full fixture setup
  const { off } = await setupOrgAndOfficial();
  // Insert a grade scheme and grade directly for speed
  const sport = (await pool.query(`SELECT id FROM sports LIMIT 1`)).rows[0];
  if (!sport) return; // skip if no sport in this tiny DB
  const scheme = (await pool.query(
    `INSERT INTO official_grade_scheme_catalogue(sport_id, governing_body, display_name, effective_from, status, created_by)
     VALUES ($1,'FIFA','FIFA Referee Scheme','2020-01-01','active',$2) RETURNING id`,
    [sport.id, off.id],
  )).rows[0];
  const level = (await pool.query(
    `INSERT INTO official_grade_scheme_levels(scheme_id, level_code, display_name, rank_order)
     VALUES ($1,'Grade1','Grade 1',1) RETURNING id`,
    [scheme.id],
  )).rows[0];
  await pool.query(
    `INSERT INTO official_scheme_grades(user_id, scheme_id, level_id, effective_from, status, verification_status)
     VALUES ($1,$2,$3,'2023-01-01','active','verified')`,
    [off.id, scheme.id, level.id],
  );

  const r1 = await api('POST', '/me/officials/portfolio/exports', { token: off.token, body: { client_key: 'idem-test-01' } });
  assert.equal(r1.status, 201);
  const r2 = await api('POST', '/me/officials/portfolio/exports', { token: off.token, body: { client_key: 'idem-test-01' } });
  assert.equal(r2.status, 201);
  assert.equal(r1.body.id, r2.body.id, 'same client_key must return the same snapshot');
  assert.equal(r1.body.sha256, r2.body.sha256);

  // Different client_key creates a new snapshot
  const r3 = await api('POST', '/me/officials/portfolio/exports', { token: off.token, body: { client_key: 'idem-test-02' } });
  assert.equal(r3.status, 201);

  const list = await api('GET', '/me/officials/portfolio/exports', { token: off.token });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.ok(list.body.length >= 2);
});
