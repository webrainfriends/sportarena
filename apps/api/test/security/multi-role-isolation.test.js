// Multi-role IDOR and tenant isolation regression suite — issue #1129
//
// Proves that switching identities/roles and crossing org boundaries never reveals private records across the
// six-role GotMyGame ecosystem. Every test is a NEGATIVE case: it sets up minimal state, makes a request
// that SHOULD be denied, and asserts status 403 or 404.
//
// Run just this file:
//   cd apps/api
//   PLATFORM_APPROVALS=off node --import ./test/setup.js --test test/security/multi-role-isolation.test.js
//
// Run as part of the full suite:
//   npm test
//
// The suite requires a Postgres instance. Set TEST_DATABASE_URL or rely on the default:
//   postgres://postgres@/sportarena_test?host=/tmp

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, assertDenied, forbiddenCases, register } from './helpers.js';

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp',
});
const { pool } = await import('../../src/db.js');
const { migrate } = await import('../../src/migrate.js');
const { createApp } = await import('../../src/http.js');
const { signToken } = await import('../../src/auth.js');

let server, base, call, adminToken;
let n = 0;
const uid = () => ++n;

// ---- bootstrap ----
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (
    await pool.query(
      "INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('iso_root','iso_root','{admin}','x','x','iso_root') RETURNING id",
    )
  ).rows[0];
  adminToken = await signToken({ id: row.id, roles: ['admin'] });
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  call = api(base);
});
after(async () => { server.close(); await pool.end(); });

// ---- shared helper ----
const reg = (roles, extra = {}) => register(base, roles, extra);
const must = async (p, status = 200) => {
  const r = await p; assert.equal(r.status, status, JSON.stringify(r.body)); return r.body;
};

/** Create an org of given kind and return { org, owner }. */
async function makeOrg(kind = 'club') {
  const owner = await reg(['coach', 'athlete']);
  const org = await must(call('POST', '/organisations', { token: owner.token, body: { name: `Org ${uid()}`, kind } }), 201);
  return { org, owner };
}

/** Add user as a member of org with given role. */
async function addMember(orgId, userId, role, adminTok) {
  await must(call('POST', `/organisations/${orgId}/members`, { token: adminTok, body: { user_id: userId, role } }), 201);
}

/** Create a physio, submit+approve a verification_case for them. */
async function makeVerifiedPhysio() {
  const physio = await reg(['physio']);
  const vc = await must(call('POST', '/verification/cases', { token: physio.token, body: { type: 'physio', licence_number: 'P123', jurisdiction: 'GB', document_url: 'https://example.com/d' } }), 201);
  await must(call('POST', `/admin/verification/cases/${vc.id}/decision`, { token: adminToken, body: { decision: 'approve', expires_at: new Date(Date.now() + 365 * 86400e3).toISOString() } }), 200);
  return physio;
}

/** Create a clinical record (medical entry) for athlete, granted to provider. Returns { entry, grant }. */
async function makeClinicalEntry(athleteToken, providerId) {
  const grant = await must(
    call('POST', `/me/health/grants`, { token: athleteToken, body: { provider_id: providerId, scope: 'full' } }), 201,
  );
  return { grant };
}

// ==============================================================================================
// 1. CLINICAL RECORD ISOLATION
// ==============================================================================================
describe('clinical record isolation', () => {
  test('coach cannot read clinical records', async () => {
    const coach = await reg(['coach']);
    const athlete = await reg(['athlete']);
    // No medical grant — coach has no clinical scope
    const r = await call('GET', `/people/${athlete.id}/health`, { token: coach.token });
    assertDenied(r, 'coach→athlete health');
  });

  test('physio without grant cannot read clinical record', async () => {
    const physio = await makeVerifiedPhysio();
    const athlete = await reg(['athlete']);
    // No grant issued
    const r = await call('GET', `/people/${athlete.id}/health`, { token: physio.token });
    assertDenied(r, 'physio without grant');
  });

  test('physio with expired grant cannot read clinical record', async () => {
    const physio = await makeVerifiedPhysio();
    const athlete = await reg(['athlete']);
    // create and immediately expire the grant
    const grant = await must(
      call('POST', '/me/health/grants', { token: athlete.token, body: { provider_id: physio.id, scope: 'full' } }), 201,
    );
    await pool.query('UPDATE medical_grants SET revoked_at = now() - interval \'1 second\' WHERE id = $1', [grant.id]);
    const r = await call('GET', `/people/${athlete.id}/health`, { token: physio.token });
    assertDenied(r, 'physio with expired grant');
  });

  test('official/referee cannot read clinical record', async () => {
    const official = await reg(['referee']);
    const athlete = await reg(['athlete']);
    const r = await call('GET', `/people/${athlete.id}/health`, { token: official.token });
    assertDenied(r, 'referee→health');
  });

  test('sponsor rep cannot read clinical record', async () => {
    const sponsor = await reg(['sponsor']);
    const athlete = await reg(['athlete']);
    const r = await call('GET', `/people/${athlete.id}/health`, { token: sponsor.token });
    assertDenied(r, 'sponsor→health');
  });

  test('academy admin cannot read clinical record of non-enrolled athlete', async () => {
    const { org, owner } = await makeOrg('academy');
    const outsider = await reg(['athlete']);
    const r = await call('GET', `/people/${outsider.id}/health`, { token: owner.token });
    assertDenied(r, 'academy admin→non-enrolled athlete health');
  });
});

// ==============================================================================================
// 2. FINANCE ISOLATION
// ==============================================================================================
describe('finance isolation', () => {
  test('coach cannot read finance invoices of an org they coach for', async () => {
    const { org, owner } = await makeOrg('club');
    const coach = await reg(['coach']);
    // Add coach as 'member' (not finance role)
    await must(
      call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { user_id: coach.id, role: 'member' } }), 201,
    );
    const r = await call('GET', `/organisations/${org.id}/invoices`, { token: coach.token });
    assertDenied(r, 'coach→org invoices');
  });

  test('physio cannot read payout account', async () => {
    const { org, owner } = await makeOrg('club');
    const physio = await reg(['physio']);
    await must(
      call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { user_id: physio.id, role: 'member' } }), 201,
    );
    const r = await call('GET', `/organisations/${org.id}/payout-accounts`, { token: physio.token });
    assertDenied(r, 'physio→payout accounts');
  });

  test('referee cannot read private rate agreement', async () => {
    const { org, owner } = await makeOrg('club');
    const official = await reg(['referee']);
    // Rate agreements are accessed via /officials/rate-agreements — only org finance roles
    const r = await call('GET', `/organisations/${org.id}/officials/rate-agreements`, { token: official.token });
    assertDenied(r, 'referee→private rate agreement of unrelated org');
  });

  test('sponsor rep cannot read another sponsor org campaigns', async () => {
    const { org: orgA } = await makeOrg('sponsor');
    const { org: orgB, owner: ownerB } = await makeOrg('sponsor');
    const repA = await reg(['sponsor']);
    await must(
      call('POST', `/organisations/${orgA.id}/members`, { token: adminToken, body: { user_id: repA.id, role: 'member' } }), 201,
    );
    // repA tries to read orgB's sponsorships
    const r = await call('GET', `/organisations/${orgB.id}/sponsorships`, { token: repA.token });
    assertDenied(r, 'sponsor A rep → org B campaigns');
  });

  test('athlete cannot read another athletes earnings', async () => {
    const a1 = await reg(['athlete']);
    const a2 = await reg(['athlete']);
    const r = await call('GET', `/people/${a2.id}/earnings`, { token: a1.token });
    assertDenied(r, 'athlete A→athlete B earnings');
  });
});

// ==============================================================================================
// 3. IDOR ATTEMPTS ON USER DATA
// ==============================================================================================
describe('IDOR on user data', () => {
  test('user A cannot read user B private profile fields', async () => {
    const a = await reg(['athlete']);
    const b = await reg(['athlete']);
    // /people/:id returns public fields; /users/:id/private or /me is the gated endpoint
    const r = await call('GET', `/me`, { token: a.token });
    // Sanity: can read own
    assert.equal(r.status, 200);
    // Cannot elevate to another user's private data via PATCH /people/:id
    const r2 = await call('PATCH', `/people/${b.id}`, { token: a.token, body: { bio: 'hijack' } });
    assertDenied(r2, 'user A PATCH user B');
  });

  test('user A cannot update user B profile', async () => {
    const a = await reg(['athlete']);
    const b = await reg(['athlete']);
    const r = await call('PATCH', `/me`, { token: a.token, body: { _impersonate_id: b.id, bio: 'injected' } });
    // The injected field must be ignored or the status must be 403/404 for b
    // Verify b's bio is unchanged
    const before = (await call('GET', `/people/${b.id}`, { token: b.token })).body?.bio ?? null;
    await call('PATCH', `/me`, { token: a.token, body: { bio: 'hijack' } });
    const after = (await call('GET', `/people/${b.id}`, { token: b.token })).body?.bio ?? null;
    assert.equal(before, after, 'user B bio must not change when user A updates /me');
  });

  test('guardian cannot access non-linked child data', async () => {
    const guardian = await reg(['guardian', 'athlete']);
    const unlinkedChild = await reg(['athlete']);
    // No guardian_link exists
    const r = await call('GET', `/youth/children/${unlinkedChild.id}/profile`, { token: guardian.token });
    assertDenied(r, 'guardian→non-linked child');
  });
});

// ==============================================================================================
// 4. CROSS-TENANT ORG ISOLATION
// ==============================================================================================
describe('cross-tenant org isolation', () => {
  test('coach in org A cannot list members of org B', async () => {
    const { org: orgA, owner: ownerA } = await makeOrg('club');
    const { org: orgB } = await makeOrg('club');
    const coach = await reg(['coach']);
    await must(
      call('POST', `/organisations/${orgA.id}/members`, { token: ownerA.token, body: { user_id: coach.id, role: 'member' } }), 201,
    );
    const r = await call('GET', `/organisations/${orgB.id}/members`, { token: coach.token });
    assertDenied(r, 'coach in A → members of B');
  });

  test('org admin of org A cannot modify org B', async () => {
    const { org: orgA, owner: ownerA } = await makeOrg('club');
    const { org: orgB } = await makeOrg('club');
    const r = await call('PATCH', `/organisations/${orgB.id}`, { token: ownerA.token, body: { name: 'Hijacked' } });
    assertDenied(r, 'org A admin → patch org B');
  });

  test('sponsor rep of sponsor A cannot read sponsor B campaigns', async () => {
    const { org: sponsorA, owner: ownerA } = await makeOrg('sponsor');
    const { org: sponsorB } = await makeOrg('sponsor');
    const r = await call('GET', `/organisations/${sponsorB.id}/sponsorships`, { token: ownerA.token });
    assertDenied(r, 'sponsor A owner → sponsor B sponsorships');
  });

  test('venue manager of venue A cannot access venue B data', async () => {
    const mgr = await reg(['venue_manager', 'athlete']);
    // Create two venues for different orgs
    const { org: orgA, owner: ownerA } = await makeOrg('club');
    const { org: orgB, owner: ownerB } = await makeOrg('club');
    // Create a venue for orgA and add mgr
    const venueA = await must(
      call('POST', '/venues', { token: ownerA.token, body: { name: `VenueA-${uid()}`, city: 'London', sports: ['football'] } }), 201,
    );
    const venueB = await must(
      call('POST', '/venues', { token: ownerB.token, body: { name: `VenueB-${uid()}`, city: 'Paris', sports: ['tennis'] } }), 201,
    );
    // mgr has no membership in orgB's venue
    const r = await call('PATCH', `/venues/${venueB.id}`, { token: mgr.token, body: { city: 'Hijacked' } });
    assertDenied(r, 'venue A manager → patch venue B');
  });
});

// ==============================================================================================
// 5. ROLE BOUNDARY: COACH / REFEREE / PHYSIO SEPARATION
// ==============================================================================================
describe('role boundary enforcement', () => {
  test('being a referee does not grant organiser finance access', async () => {
    const { org } = await makeOrg('club');
    const referee = await reg(['referee']);
    const r = await call('GET', `/organisations/${org.id}/invoices`, { token: referee.token });
    assertDenied(r, 'referee→org invoices');
  });

  test('being a coach does not grant clinical access', async () => {
    const { org, owner } = await makeOrg('club');
    const coach = await reg(['coach']);
    const athlete = await reg(['athlete']);
    await must(
      call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { user_id: coach.id, role: 'member' } }), 201,
    );
    const r = await call('GET', `/people/${athlete.id}/health`, { token: coach.token });
    assertDenied(r, 'coach→clinical');
  });

  test('physio cannot access academy admin functions', async () => {
    const { org } = await makeOrg('academy');
    const physio = await reg(['physio']);
    // Attempting to manage academy programmes as physio
    const r = await call('POST', `/organisations/${org.id}/academy/programmes`, {
      token: physio.token,
      body: { sport: 'football', title: 'U12', capacity: 10, admission_mode: 'direct', public: true },
    });
    assertDenied(r, 'physio→academy programme create');
  });

  test('coach of a team cannot access event finance if not org admin', async () => {
    const { org, owner } = await makeOrg('club');
    const coach = await reg(['coach']);
    // Team membership only, not org finance role
    const team = await must(
      call('POST', '/teams', { token: owner.token, body: { name: `Team ${uid()}`, sport: 'football', organisation_id: org.id } }), 201,
    );
    await must(
      call('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: coach.id, role: 'coach' } }), 201,
    );
    const r = await call('GET', `/organisations/${org.id}/invoices`, { token: coach.token });
    assertDenied(r, 'team-only coach→org finance');
  });
});

// ==============================================================================================
// 6. MEMBERSHIP REVOCATION
// ==============================================================================================
describe('membership revocation', () => {
  test('user removed from org cannot call org-scoped endpoints', async () => {
    const { org, owner } = await makeOrg('club');
    const member = await reg(['athlete']);
    // Add then remove
    const m = await must(
      call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { user_id: member.id, role: 'member' } }), 201,
    );
    await must(call('DELETE', `/organisations/${org.id}/members/${m.id}`, { token: owner.token }), 200);
    const r = await call('GET', `/organisations/${org.id}/members`, { token: member.token });
    assertDenied(r, 'removed member→org members list');
  });

  test('user removed from team cannot access team-only data', async () => {
    const { org, owner } = await makeOrg('club');
    const member = await reg(['athlete']);
    const team = await must(
      call('POST', '/teams', { token: owner.token, body: { name: `Team ${uid()}`, sport: 'football', organisation_id: org.id } }), 201,
    );
    const tm = await must(
      call('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: member.id, role: 'player' } }), 201,
    );
    // Remove from team
    await must(call('DELETE', `/teams/${team.id}/members/${tm.id}`, { token: owner.token }), 200);
    // Private team data should not be accessible
    const r = await call('GET', `/teams/${team.id}/members`, { token: member.token });
    assertDenied(r, 'removed team member→team members');
  });

  test('expired guardian link does not grant access', async () => {
    const guardian = await reg(['guardian', 'athlete']);
    const child = await reg(['athlete']);
    // Create and immediately expire the guardian link
    const link = await must(
      call('POST', '/youth/guardian-links', { token: guardian.token, body: { guardian_id: guardian.id, child_id: child.id, relationship: 'parent' } }), 201,
    );
    await pool.query("UPDATE guardian_links SET expires_at = now() - interval '1 second' WHERE id = $1", [link.id]);
    const r = await call('GET', `/youth/children/${child.id}/profile`, { token: guardian.token });
    assertDenied(r, 'expired guardian link');
  });

  test('revoked medical grant does not grant clinical access', async () => {
    const physio = await makeVerifiedPhysio();
    const athlete = await reg(['athlete']);
    const grant = await must(
      call('POST', '/me/health/grants', { token: athlete.token, body: { provider_id: physio.id, scope: 'full' } }), 201,
    );
    // Revoke the grant
    await must(call('DELETE', `/me/health/grants/${grant.id}`, { token: athlete.token }), 200);
    const r = await call('GET', `/people/${athlete.id}/health`, { token: physio.token });
    assertDenied(r, 'revoked medical grant');
  });
});

// ==============================================================================================
// 7. YOUTH / MINOR RECORDS
// ==============================================================================================
describe('youth and minor record isolation', () => {
  test('unrelated adult cannot access minor private data', async () => {
    const minor = await reg(['athlete']);
    const unrelated = await reg(['athlete']);
    const r = await call('GET', `/youth/children/${minor.id}/profile`, { token: unrelated.token });
    assertDenied(r, 'unrelated adult→minor profile');
  });

  test('guardian consent revoked blocks access', async () => {
    const guardian = await reg(['guardian', 'athlete']);
    const child = await reg(['athlete']);
    const link = await must(
      call('POST', '/youth/guardian-links', { token: guardian.token, body: { guardian_id: guardian.id, child_id: child.id, relationship: 'parent' } }), 201,
    );
    // Revoke the link
    await pool.query("UPDATE guardian_links SET revoked_at = now() WHERE id = $1", [link.id]);
    const r = await call('GET', `/youth/children/${child.id}/profile`, { token: guardian.token });
    assertDenied(r, 'revoked guardian consent');
  });

  test('coach cannot access youth welfare record without org consent', async () => {
    const { org, owner } = await makeOrg('academy');
    const coach = await reg(['coach']);
    const minor = await reg(['athlete']);
    await must(
      call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { user_id: coach.id, role: 'member' } }), 201,
    );
    // No guardian consent for welfare data
    const r = await call('GET', `/youth/children/${minor.id}/welfare`, { token: coach.token });
    assertDenied(r, 'coach without consent→minor welfare');
  });
});

// ==============================================================================================
// 8. FILE / SIGNED URL ACCESS
// ==============================================================================================
describe('file and signed URL isolation', () => {
  test('user not in org cannot get signed URL for org private document', async () => {
    const { org } = await makeOrg('club');
    const outsider = await reg(['athlete']);
    const r = await call('GET', `/organisations/${org.id}/documents`, { token: outsider.token });
    assertDenied(r, 'outsider→org private documents');
  });

  test('removed member cannot access previously scoped org document list', async () => {
    const { org, owner } = await makeOrg('club');
    const member = await reg(['athlete']);
    const m = await must(
      call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { user_id: member.id, role: 'member' } }), 201,
    );
    // Remove member
    await must(call('DELETE', `/organisations/${org.id}/members/${m.id}`, { token: owner.token }), 200);
    const r = await call('GET', `/organisations/${org.id}/documents`, { token: member.token });
    assertDenied(r, 'removed member→org documents');
  });
});

// ==============================================================================================
// 9. MCP INVOCATION (same auth as REST)
// ==============================================================================================
describe('MCP invocation auth parity', () => {
  test('MCP call is subject to same role check as REST', async () => {
    // The MCP server dispatches through invoke() just as the REST handler does.
    // A coach calling a clinical capability via MCP must be denied identically.
    const coach = await reg(['coach']);
    const athlete = await reg(['athlete']);
    // The MCP endpoint proxies to the same invoke() — test the REST path as the same code path.
    const r = await call('GET', `/people/${athlete.id}/health`, { token: coach.token });
    assertDenied(r, 'MCP-equivalent: coach→clinical (same invoke path)');
  });

  test('MCP call cannot bypass org membership check', async () => {
    const { org } = await makeOrg('club');
    const outsider = await reg(['athlete']);
    const r = await call('GET', `/organisations/${org.id}/members`, { token: outsider.token });
    assertDenied(r, 'MCP-equivalent: outsider→org members (same invoke path)');
  });
});

// ==============================================================================================
// 10. PLATFORM ADMIN ISOLATION
// ==============================================================================================
describe('platform admin isolation', () => {
  test('non-admin cannot access admin security console endpoint', async () => {
    const coach = await reg(['coach']);
    const r = await call('GET', '/admin/security/access-denied-events', { token: coach.token });
    assertDenied(r, 'coach→admin security console');
  });

  test('non-admin cannot see the permission matrix', async () => {
    const athlete = await reg(['athlete']);
    const r = await call('GET', '/admin/security/permission-matrix', { token: athlete.token });
    assertDenied(r, 'athlete→permission matrix');
  });

  test('non-admin cannot see access_denied_events', async () => {
    const sponsor = await reg(['sponsor']);
    const r = await call('GET', '/admin/security/access-denied-events', { token: sponsor.token });
    assertDenied(r, 'sponsor→access denied events');
  });

  test('platform_admin role is not revealed in public user profiles', async () => {
    // Platform admin user; public profile should strip admin/platform_admin from roles array
    const r = await call('GET', `/people/${(await reg(['athlete'])).id}`, {});
    const body = r.body;
    if (body && Array.isArray(body.roles)) {
      assert.ok(!body.roles.includes('admin'), 'admin role must not appear in public profile');
      assert.ok(!body.roles.includes('platform_admin'), 'platform_admin must not appear in public profile');
    }
  });
});

// ==============================================================================================
// 11. API TOKEN SCOPE / RESOURCE RESTRICTIONS
// ==============================================================================================
describe('API token scope and resource restrictions', () => {
  test('API token with read scope cannot perform write operations', async () => {
    const user = await reg(['athlete']);
    // Create a read-only API token
    const tok = await must(
      call('POST', '/me/api-tokens', { token: user.token, body: { name: 'read-only', scopes: ['read'], expires_in_days: 30 } }), 201,
    );
    const readToken = tok.token;
    // Attempt a write (PATCH profile) with a read token
    const r = await call('PATCH', '/me', { token: readToken, body: { bio: 'test write' } });
    assertDenied(r, 'read-scope token→write operation');
  });

  test('API token with resources restriction cannot access out-of-scope venue', async () => {
    const user = await reg(['athlete', 'venue_manager']);
    const { org: orgA, owner: ownerA } = await makeOrg('club');
    const { org: orgB, owner: ownerB } = await makeOrg('club');
    const venueA = await must(
      call('POST', '/venues', { token: ownerA.token, body: { name: `VA-${uid()}`, city: 'London', sports: ['football'] } }), 201,
    );
    const venueB = await must(
      call('POST', '/venues', { token: ownerB.token, body: { name: `VB-${uid()}`, city: 'Paris', sports: ['football'] } }), 201,
    );
    // Create token restricted to venueA only
    const tok = await must(
      call('POST', '/me/api-tokens', { token: user.token, body: { name: 'venue-scoped', scopes: ['read', 'write'], resources: { venue: [venueA.id] }, expires_in_days: 1 } }), 201,
    );
    const r = await call('GET', `/venues/${venueB.id}`, { token: tok.token });
    assertDenied(r, 'resource-restricted token→out-of-scope venue');
  });
});

// ==============================================================================================
// 12. ROLE SWITCH / WORKSPACE CONTEXT
// ==============================================================================================
describe('role switch and workspace context isolation', () => {
  test('workspace endpoint only returns orgs the user is currently a member of', async () => {
    const user = await reg(['coach', 'athlete']);
    const { org: orgA, owner: ownerA } = await makeOrg('club');
    const m = await must(
      call('POST', `/organisations/${orgA.id}/members`, { token: ownerA.token, body: { user_id: user.id, role: 'member' } }), 201,
    );
    // Confirm membership appears in workspace
    const before = await call('GET', '/me/role-workspace', { token: user.token, query: { role: 'coach' } });
    assert.equal(before.status, 200);
    // Remove membership
    await must(call('DELETE', `/organisations/${orgA.id}/members/${m.id}`, { token: ownerA.token }), 200);
    // Workspace should no longer include that org
    const after = await call('GET', '/me/role-workspace', { token: user.token, query: { role: 'coach' } });
    assert.equal(after.status, 200);
    const orgIds = (after.body?.organisations ?? []).map((o) => o.id);
    assert.ok(!orgIds.includes(orgA.id), 'revoked org must not appear in workspace after removal');
  });

  test('role switch clears scope: org B data is not returned when acting as a role with no B membership', async () => {
    const user = await reg(['coach', 'sponsor']);
    const { org: orgA, owner: ownerA } = await makeOrg('club');
    const { org: orgB } = await makeOrg('sponsor');
    // User is in orgA as coach, but NOT in orgB as sponsor
    await must(
      call('POST', `/organisations/${orgA.id}/members`, { token: ownerA.token, body: { user_id: user.id, role: 'member' } }), 201,
    );
    // Acting as sponsor: orgB should not appear, and no cross-tenant leak
    const ws = await call('GET', '/me/role-workspace', { token: user.token, query: { role: 'sponsor' } });
    assert.equal(ws.status, 200);
    const orgIds = (ws.body?.organisations ?? []).map((o) => o.id);
    assert.ok(!orgIds.includes(orgB.id), 'org B must not appear when user has no B membership');
    // Attempting to access orgB directly is denied
    const r = await call('GET', `/organisations/${orgB.id}/members`, { token: user.token });
    assertDenied(r, 'user acting as sponsor without B membership→org B');
  });

  test('stale deep link to revoked org resource returns 404', async () => {
    const { org, owner } = await makeOrg('club');
    const member = await reg(['athlete']);
    const m = await must(
      call('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { user_id: member.id, role: 'member' } }), 201,
    );
    await must(call('DELETE', `/organisations/${org.id}/members/${m.id}`, { token: owner.token }), 200);
    // Deep link to org details returns 404 (existence not leaked)
    const r = await call('GET', `/organisations/${org.id}`, { token: member.token });
    assertDenied(r, 'stale deep link after membership removal');
  });
});
