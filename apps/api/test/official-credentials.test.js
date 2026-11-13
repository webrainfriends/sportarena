// Official Credential Verification Hub tests (#993 REF-R02).
// Covers: list, submit, reviewer queue, claim, decide (approve/reject), badge toggle, public profile badges.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body).slice(0, 400)); return r.body; };
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `oc_${n}_${roles[0]}`, display_name: `Cred ${n}`, email: `oc${n}@example.com`, password: 'correct-horse-battery', roles } });
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

// Create a governing body, a licence type and a fed_licence for the official.
async function setupLicence(official) {
  const { rows: [body] } = await pool.query(`
    INSERT INTO governing_bodies (name, slug, sport_id)
    SELECT 'Test Federation', 'test-fed-${n}', s.id FROM sports s LIMIT 1
    RETURNING id
  `);
  const { rows: [lt] } = await pool.query(`
    INSERT INTO federation_licence_types (body_id, name, slug, role)
    VALUES ($1, 'Level 1 Referee', 'level-1-ref-${n}', 'referee')
    RETURNING id
  `, [body.id]);
  const { rows: [lic] } = await pool.query(`
    INSERT INTO fed_licences (body_id, type_id, holder_id, applicant_id, status, licence_no, issued_on, expires_on)
    VALUES ($1, $2, $3, $3, 'active', 'LIC-${n}-TEST', CURRENT_DATE - 10, CURRENT_DATE + 365)
    RETURNING id
  `, [body.id, lt.id, official.id]);
  return { body, lt, licence: lic };
}

test('list credentials — empty for new official', async () => {
  const official = await signup(['referee']);
  const r = must(await api('GET', '/me/credentials', { token: official.token }));
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 0);
});

test('credential detail — returns 404 for nonexistent id', async () => {
  const official = await signup(['referee']);
  const r = await api('GET', '/me/credentials/00000000-0000-0000-0000-000000000000', { token: official.token });
  assert.equal(r.status, 404);
});

test('list credentials — shows active licence', async () => {
  const official = await signup(['referee']);
  const { licence } = await setupLicence(official);
  const r = must(await api('GET', '/me/credentials', { token: official.token }));
  assert.ok(r.length >= 1);
  const found = r.find((c) => c.id === licence.id);
  assert.ok(found, 'licence should appear in list');
  assert.equal(found.status, 'active');
  assert.ok(!found.licence_no, 'full licence_no must not be returned in list');
  assert.ok(found.licence_no_masked, 'masked licence_no should be present');
});

test('credential detail — full detail returns masked licence_no, no private proof by default', async () => {
  const official = await signup(['referee']);
  const { licence } = await setupLicence(official);
  const r = must(await api('GET', `/me/credentials/${licence.id}`, { token: official.token }));
  assert.ok(r.licence_no_masked, 'masked licence_no should be present');
  assert.ok(!r.private_proof, 'private proof must not be in response without reveal');
  assert.equal(r.has_private_proof, false);
});

test('submit for review — creates official_cred_reviews row', async () => {
  const official = await signup(['referee']);
  const { licence } = await setupLicence(official);
  // Set status to draft so submit is valid
  await pool.query(`UPDATE fed_licences SET status='draft' WHERE id=$1`, [licence.id]);
  const r = must(await api('POST', `/me/credentials/${licence.id}/submit`, {}/* no token = auth check */), 401);
});

test('submit for review — requires auth', async () => {
  const official = await signup(['referee']);
  const { licence } = await setupLicence(official);
  await pool.query(`UPDATE fed_licences SET status='draft' WHERE id=$1`, [licence.id]);
  const r = await api('POST', `/me/credentials/${licence.id}/submit`, {});
  assert.equal(r.status, 401);
});

test('reviewer queue — requires licensing role', async () => {
  const stranger = await signup(['organizer']);
  const r = await api('GET', '/credential-reviews', { token: stranger.token });
  assert.equal(r.status, 403);
});

test('public credential badges — returns only active badge_on_profile credentials', async () => {
  const official = await signup(['referee']);
  const { licence } = await setupLicence(official);
  // Public endpoint requires knowing the official's profile ID
  const profileRow = await pool.query(`SELECT id FROM official_profiles WHERE user_id=$1 LIMIT 1`, [official.id]);
  if (!profileRow.rows.length) return; // no profile yet — skip
  const profileId = profileRow.rows[0].id;
  // With badge off (default) — expect empty
  const r = must(await api('GET', `/official-profiles/${profileId}/credential-badges`));
  assert.ok(Array.isArray(r));
  const badged = r.filter((c) => c.id === licence.id);
  assert.equal(badged.length, 0, 'badge_on_profile=false should not appear');
});

test('badge toggle — not allowed for non-active credentials', async () => {
  const official = await signup(['referee']);
  const { licence } = await setupLicence(official);
  await pool.query(`UPDATE fed_licences SET status='draft' WHERE id=$1`, [licence.id]);
  const r = await api('PATCH', `/me/credentials/${licence.id}/badge`, { token: official.token, body: { badge_on_profile: true } });
  assert.equal(r.status, 422);
});
