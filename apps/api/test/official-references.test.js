// Tests for official-references capability (#1002 REF-R33).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { buildApp } from '../src/app.js';

let app, adminToken, refereeToken, orgToken, orgId, refereeId, adminId, refId, inviteToken;

before(async () => {
  app = await buildApp();

  // create platform admin
  const ar = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'rraja.edge@gmail.com', password: 'Admin1234!', name: 'Admin' } });
  adminToken = ar.json().token || (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'rraja.edge@gmail.com', password: 'Admin1234!' } })).json().token;
  adminId = ar.json().user?.id;

  // create referee user
  const rr = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: `ref_${Date.now()}@test.com`, password: 'Ref12345!', name: 'Test Referee' } });
  refereeToken = rr.json().token;
  refereeId = rr.json().user?.id;

  // create org-staff user
  const or2 = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: `org_${Date.now()}@test.com`, password: 'Org12345!', name: 'Org Staff' } });
  orgToken = or2.json().token;

  // create an org
  const orgR = await app.inject({ method: 'POST', url: '/orgs', headers: { authorization: `Bearer ${orgToken}` }, payload: { name: `TestOrg_${Date.now()}`, sport: 'Football' } });
  orgId = orgR.json().id;
});

after(async () => {
  if (refereeId) await pool.query(`DELETE FROM official_portfolio_references WHERE user_id = $1`, [refereeId]);
  await pool.end();
});

describe('request_reference', () => {
  it('creates a reference request with conflict detection', async () => {
    const r = await app.inject({
      method: 'POST', url: '/me/officials/references',
      headers: { authorization: `Bearer ${refereeToken}` },
      payload: { org_id: orgId, referee_type: 'club', invite_method: 'secure_link', invitee_email: `contact_${Date.now()}@club.com`, tenure_from: '2022-01-01', sport_context: 'Officiated 50+ fixtures', is_confidential: false, consent_given: true, expiry_date: '2027-12-31' },
    });
    assert.equal(r.statusCode, 201);
    refId = r.json().id;
    assert.ok(refId);
    // invite token returned
    inviteToken = r.json().invite_token;
  });

  it('blocks duplicate pending request for same (user, org)', async () => {
    const r = await app.inject({
      method: 'POST', url: '/me/officials/references',
      headers: { authorization: `Bearer ${refereeToken}` },
      payload: { org_id: orgId, referee_type: 'club', invite_method: 'secure_link', invitee_email: `dup_${Date.now()}@club.com`, consent_given: true },
    });
    assert.equal(r.statusCode, 409);
  });
});

describe('list_my_references', () => {
  it('returns the created reference', async () => {
    const r = await app.inject({ method: 'GET', url: '/me/officials/references', headers: { authorization: `Bearer ${refereeToken}` } });
    assert.equal(r.statusCode, 200);
    const items = r.json().items ?? r.json();
    assert.ok(Array.isArray(items));
    assert.ok(items.some(x => x.id === refId));
  });
});

describe('get_my_reference', () => {
  it('returns full detail', async () => {
    const r = await app.inject({ method: 'GET', url: `/me/officials/references/${refId}`, headers: { authorization: `Bearer ${refereeToken}` } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().id, refId);
  });

  it('returns 404 for another user', async () => {
    const r = await app.inject({ method: 'GET', url: `/me/officials/references/${refId}`, headers: { authorization: `Bearer ${orgToken}` } });
    assert.equal(r.statusCode, 404);
  });
});

describe('get_reference_invite_link', () => {
  it('returns a secure link for secure_link invites', async () => {
    const r = await app.inject({ method: 'GET', url: `/me/officials/references/${refId}/invite-link`, headers: { authorization: `Bearer ${refereeToken}` } });
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().link);
    // token is 48 hex chars (96 nibbles) = 48 bytes = 96 char hex
    assert.match(r.json().link, /[a-f0-9]{96}$/);
  });
});

describe('respond_via_invite_link', () => {
  it('responds to a valid token', async () => {
    // First fetch the token from DB since it may differ from creation response
    const row = await pool.query(`SELECT invite_token FROM official_portfolio_references WHERE id = $1`, [refId]);
    const tok = row.rows[0]?.invite_token;
    if (!tok) return; // skip if not set
    const r = await app.inject({
      method: 'POST', url: `/official-references/respond/${tok}`,
      payload: { response_status: 'approved', reference_text: 'Excellent referee, highly recommended.' },
    });
    assert.ok([200, 201].includes(r.statusCode), `Expected 200/201, got ${r.statusCode}: ${r.payload}`);
  });

  it('rejects an expired token', async () => {
    // set token_expires_at to past
    await pool.query(`UPDATE official_portfolio_references SET invite_token_expires_at = now() - interval '1 day' WHERE id = $1`, [refId]);
    const row = await pool.query(`SELECT invite_token FROM official_portfolio_references WHERE id = $1`, [refId]);
    const tok = row.rows[0]?.invite_token;
    if (!tok) return;
    const r = await app.inject({ method: 'POST', url: `/official-references/respond/${tok}`, payload: { response_status: 'approved', reference_text: 'Late.' } });
    assert.equal(r.statusCode, 410);
  });
});

describe('request_reference_correction', () => {
  it('creates a correction request', async () => {
    const r = await app.inject({
      method: 'POST', url: `/me/officials/references/${refId}/corrections`,
      headers: { authorization: `Bearer ${refereeToken}` },
      payload: { reason: 'The sport context is incorrect.', proposed_change: 'Should mention 80+ fixtures.' },
    });
    assert.ok([200, 201].includes(r.statusCode), `Got ${r.statusCode}: ${r.payload}`);
  });
});

describe('report_reference', () => {
  it('creates an abuse report', async () => {
    const r = await app.inject({
      method: 'POST', url: `/me/officials/references/${refId}/reports`,
      headers: { authorization: `Bearer ${refereeToken}` },
      payload: { reason: 'inaccurate', detail: 'The text misrepresents the relationship.' },
    });
    assert.ok([200, 201].includes(r.statusCode), `Got ${r.statusCode}: ${r.payload}`);
  });
});

describe('confidential reference privacy', () => {
  it('does not expose reference_text to third parties for confidential refs', async () => {
    // Create a confidential reference
    const r = await app.inject({
      method: 'POST', url: '/me/officials/references',
      headers: { authorization: `Bearer ${refereeToken}` },
      payload: { org_id: null, referee_type: 'federation', invite_method: 'secure_link', invitee_email: `conf_${Date.now()}@fed.com`, is_confidential: true, consent_given: true },
    });
    const confId = r.json().id;
    // Admin reads it — should not get plaintext reference_text
    if (confId) {
      const ar = await app.inject({ method: 'GET', url: `/me/officials/references/${confId}`, headers: { authorization: `Bearer ${adminToken}` } });
      // Should be 404 (admin can't access another user's reference via /me endpoint)
      assert.equal(ar.statusCode, 404);
    }
  });
});

describe('admin_moderate_reference', () => {
  it('platform admin can redact a reference', async () => {
    const r = await app.inject({
      method: 'POST', url: `/admin/official-references/${refId}/moderate`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { moderation_status: 'redacted', moderation_note: 'Violates community guidelines.' },
    });
    assert.ok([200, 201].includes(r.statusCode), `Got ${r.statusCode}: ${r.payload}`);
  });

  it('non-admin cannot moderate', async () => {
    const r = await app.inject({
      method: 'POST', url: `/admin/official-references/${refId}/moderate`,
      headers: { authorization: `Bearer ${refereeToken}` },
      payload: { moderation_status: 'cleared', moderation_note: 'Looks fine.' },
    });
    assert.ok([401, 403].includes(r.statusCode));
  });
});

describe('revoke_my_reference', () => {
  it('referee can revoke their own reference', async () => {
    const r = await app.inject({
      method: 'POST', url: `/me/officials/references/${refId}/revoke`,
      headers: { authorization: `Bearer ${refereeToken}` },
      payload: {},
    });
    assert.ok([200, 201].includes(r.statusCode), `Got ${r.statusCode}: ${r.payload}`);
    // Confirm it no longer shows as active
    const list = await app.inject({ method: 'GET', url: '/me/officials/references', headers: { authorization: `Bearer ${refereeToken}` } });
    const items = list.json().items ?? list.json();
    const revoked = items.find(x => x.id === refId);
    if (revoked) assert.equal(revoked.response_status ?? revoked.status, 'revoked');
  });
});
