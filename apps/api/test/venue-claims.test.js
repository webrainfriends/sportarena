import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_APPROVALS: 'on',
  PLATFORM_ADMIN_EMAIL: 'platform-owner@example.com', PLATFORM_ADMIN_EMAILS: 'platform-owner@example.com',
  PLATFORM_ADMIN_PASSWORD: 'owner-test-pass', PLATFORM_ADMIN_HANDLE: 'platformarena',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { initKeys } = await import('../src/crypto.js');
const { bootstrapPlatformOwner } = await import('../src/platform.js');

let server, base, n = 0, platform;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `vc_${n}_${roles[0]}`, display_name: `VC Test ${n}`, email: `vc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201);
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  await initKeys();
  await bootstrapPlatformOwner({ log() {}, error() {} });
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const l = must(await api('POST', '/auth/login', { body: { email: 'platform-owner@example.com', password: 'owner-test-pass' } }));
  platform = { ...l.user, token: l.token };
});
after(async () => { server.close(); await pool.end(); });

let owner1, owner2, venueId;

test('setup: create a venue as an unclaimed listing', async () => {
  owner1 = await signup(['venue_owner']);
  // Create venue through the API
  const v = must(await api('POST', '/venues', { token: platform.token, body: { name: 'Test Arena', city: 'Bangalore', country: 'India', timezone: 'Asia/Kolkata', sports: ['basketball'] } }), 201);
  venueId = v.id;
  // Venue should start as unclaimed
  const detail = must(await api('GET', `/venues/${venueId}`, {}));
  assert.equal(detail.claim_status, 'unclaimed');
  // Contact info should be hidden on unclaimed venue for public visitor
  assert.ok(!detail.contact_email, 'contact email hidden on unclaimed venue');
});

test('a user can submit a claim for an unclaimed venue', async () => {
  const claim = must(await api('POST', `/venues/${venueId}/claim`, {
    token: owner1.token,
    body: { role: 'owner', statement: 'I have operated this arena since 2020' },
  }), 201);
  assert.ok(claim.claim_no.startsWith('CLM-'));
  assert.equal(claim.status, 'submitted');
  assert.equal(claim.venue_id, venueId);
  assert.equal(claim.claimant_id, owner1.id);

  // Venue claim_status should now be 'pending'
  const v = must(await api('GET', `/venues/${venueId}`, { token: owner1.token }));
  assert.equal(v.claim_status, 'pending');
});

test('the claimant can upload documents to their claim', async () => {
  const claims = must(await api('GET', '/me/claims', { token: owner1.token }));
  assert.ok(Array.isArray(claims.items));
  const claimId = claims.items[0].id;

  const doc = must(await api('POST', `/claims/${claimId}/documents`, {
    token: owner1.token,
    body: { kind: 'title_deed', label: 'Title Deed 2020', file_key: 'uploads/test-deed.pdf', mime_type: 'application/pdf', size_bytes: 204800 },
  }), 201);
  assert.equal(doc.kind, 'title_deed');
  assert.ok(!doc.file_key, 'file_key not exposed in response');
});

test('a second claimant for the same venue creates a conflict and both are linked', async () => {
  owner2 = await signup(['venue_owner']);
  const claim2 = must(await api('POST', `/venues/${venueId}/claim`, {
    token: owner2.token,
    body: { role: 'manager', statement: 'I manage this arena on behalf of the owner' },
  }), 201);
  assert.equal(claim2.status, 'submitted');

  // Platform can see both claims with conflict noted
  const queue = must(await api('GET', '/admin/venue-claims', { token: platform.token, query: { venue_id: venueId } }));
  assert.ok(queue.items.length >= 2, 'both claims visible to platform');

  // Both should reference each other via conflict_with_id
  const hasConflict = queue.items.some(c => c.conflict_with_id !== null);
  assert.ok(hasConflict, 'conflict link set on at least one claim');
});

test('a third concurrent claim for the same venue is rejected (safe limit)', async () => {
  const user3 = await signup(['venue_owner']);
  const r = await api('POST', `/venues/${venueId}/claim`, {
    token: user3.token,
    body: { role: 'owner', statement: 'I am the third claimant' },
  });
  // Should be rejected — max 2 active claims per venue
  assert.equal(r.status, 409, 'third concurrent claim rejected');
});

test('platform can review and approve one claim; the other is auto-rejected', async () => {
  const claims = must(await api('GET', '/me/claims', { token: owner1.token }));
  const claimId = claims.items[0].id;

  const result = must(await api('POST', `/admin/venue-claims/${claimId}/decide`, {
    token: platform.token,
    body: { action: 'approve', decision_note: 'Title deed verified, identity confirmed. Claimant A approved.' },
  }));
  assert.equal(result.status, 'approved');

  // Venue should now be claimed
  const v = must(await api('GET', `/venues/${venueId}`, { token: owner1.token }));
  assert.equal(v.claim_status, 'claimed');
  assert.equal(v.claimed_by, owner1.id);

  // Other active claim for same venue should be auto-rejected
  const claims2 = must(await api('GET', '/me/claims', { token: owner2.token }));
  const otherClaim = claims2.items.find(c => c.claimant_id === owner2.id);
  assert.equal(otherClaim.status, 'rejected', 'competing claim auto-rejected on approval');
});

test('decision_note is required on approve and reject', async () => {
  const venue2 = must(await api('POST', '/venues', { token: platform.token, body: { name: 'Arena 2', city: 'Mumbai', country: 'India', timezone: 'Asia/Kolkata', sports: ['badminton'] } }), 201);
  const user4 = await signup(['venue_owner']);
  const c = must(await api('POST', `/venues/${venue2.id}/claim`, { token: user4.token, body: { role: 'owner', statement: 'Owner' } }), 201);

  const r = await api('POST', `/admin/venue-claims/${c.id}/decide`, {
    token: platform.token,
    body: { action: 'approve' }, // missing decision_note
  });
  assert.equal(r.status, 400, 'decision_note required');
});

test('a claimant can withdraw their claim before decision', async () => {
  const venue3 = must(await api('POST', '/venues', { token: platform.token, body: { name: 'Arena 3', city: 'Delhi', country: 'India', timezone: 'Asia/Kolkata', sports: ['tennis'] } }), 201);
  const user5 = await signup(['venue_owner']);
  const c = must(await api('POST', `/venues/${venue3.id}/claim`, { token: user5.token, body: { role: 'owner', statement: 'Mine' } }), 201);

  must(await api('DELETE', `/claims/${c.id}`, { token: user5.token }));
  const updated = must(await api('GET', `/claims/${c.id}`, { token: user5.token }));
  assert.equal(updated.status, 'withdrawn');

  // Venue reverts to unclaimed when last active claim is withdrawn
  const v = must(await api('GET', `/venues/${venue3.id}`, {}));
  assert.equal(v.claim_status, 'unclaimed');
});

test('a rejected claimant can dispute the decision once', async () => {
  const claims2 = must(await api('GET', '/me/claims', { token: owner2.token }));
  const rejectedClaim = claims2.items.find(c => c.status === 'rejected');
  assert.ok(rejectedClaim);

  const dispute = must(await api('POST', `/claims/${rejectedClaim.id}/dispute`, {
    token: owner2.token,
    body: { dispute_reason: 'I have additional documents proving ownership' },
  }));
  assert.equal(dispute.status, 'disputed');

  // Cannot dispute twice
  const r = await api('POST', `/claims/${rejectedClaim.id}/dispute`, {
    token: owner2.token,
    body: { dispute_reason: 'Second dispute' },
  });
  assert.equal(r.status, 409, 'cannot dispute more than once');
});

test('a non-platform user cannot access the admin claim queue', async () => {
  const r = await api('GET', '/admin/venue-claims', { token: owner1.token });
  assert.equal(r.status, 403);
});

test('already-claimed venue cannot be claimed again', async () => {
  const r = await api('POST', `/venues/${venueId}/claim`, {
    token: (await signup()).token,
    body: { role: 'owner', statement: 'Late claimant' },
  });
  assert.equal(r.status, 409, 'already-claimed venue rejects new claims');
});

test('idempotency: same user submitting the same claim twice is rejected', async () => {
  const venue4 = must(await api('POST', '/venues', { token: platform.token, body: { name: 'Arena 4', city: 'Chennai', country: 'India', timezone: 'Asia/Kolkata', sports: ['squash'] } }), 201);
  const user6 = await signup(['venue_owner']);
  must(await api('POST', `/venues/${venue4.id}/claim`, { token: user6.token, body: { role: 'owner', statement: 'First' } }), 201);
  const r = await api('POST', `/venues/${venue4.id}/claim`, { token: user6.token, body: { role: 'owner', statement: 'Duplicate' } });
  assert.equal(r.status, 409, 'duplicate claim rejected');
});
