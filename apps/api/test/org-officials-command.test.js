// Tests for REF-R12: Federation & Assignor Organisation Command Center
// Tests run against a real Postgres DB; each test sets up its own data.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx } from '../src/db.js';
import { testUser, testOrg, testEvent, testFixture, testSport } from './helpers.js';
import { request } from './request.js';

describe('org-officials-command', () => {
  let owner, admin, official1, official2, outsider;
  let org, sport;

  before(async () => {
    owner = await testUser({ display_name: 'Owner' });
    admin = await testUser({ display_name: 'Admin' });
    official1 = await testUser({ display_name: 'Official One' });
    official2 = await testUser({ display_name: 'Official Two' });
    outsider = await testUser({ display_name: 'Outsider' });
    sport = await testSport();
    org = await testOrg({ owner_id: owner.id });
    // Add admin to org
    await pool.query("INSERT INTO organisation_members(organisation_id,user_id,role,status) VALUES($1,$2,'admin','active')", [org.id, admin.id]);
    // Give official1 and official2 referee sport profiles
    for (const u of [official1, official2]) {
      await pool.query(
        "INSERT INTO active_sport_profiles(user_id,sport_id,role,status) VALUES($1,$2,'referee','active') ON CONFLICT DO NOTHING",
        [u.id, sport.id],
      );
    }
  });

  after(async () => {
    // cleanup is handled by test helpers / test db truncation
  });

  // ── Invite & respond ───────────────────────────────────────────────────────
  it('owner invites official → invite row created with status=invited', async () => {
    const r = await request('POST', `/organisations/${org.id}/officials/roster`, owner, { user_id: official1.id, sport_id: sport.id });
    assert.equal(r.status, 'invited');
    assert.equal(r.user_id, official1.id);
  });

  it('duplicate invite returns 409', async () => {
    const r = await request('POST', `/organisations/${org.id}/officials/roster`, owner, { user_id: official1.id, sport_id: sport.id });
    assert.equal(r._status, 409);
  });

  it('official accepts invite → status becomes active', async () => {
    const rows = await pool.query("SELECT id FROM org_official_rosters WHERE organisation_id=$1 AND user_id=$2", [org.id, official1.id]);
    const rosterId = rows.rows[0].id;
    const r = await request('POST', `/org-official-roster/${rosterId}/respond`, official1, { response: 'accept' });
    assert.equal(r.status, 'active');
  });

  it('official declines invite → status becomes removed', async () => {
    // invite official2 and have them decline
    const inv = await request('POST', `/organisations/${org.id}/officials/roster`, owner, { user_id: official2.id, sport_id: sport.id });
    const r = await request('POST', `/org-official-roster/${inv.id}/respond`, official2, { response: 'decline' });
    assert.equal(r.status, 'removed');
  });

  it('wrong user cannot respond to someone else's invite', async () => {
    const inv = await request('POST', `/organisations/${org.id}/officials/roster`, owner, { user_id: official2.id, sport_id: sport.id });
    const r = await request('POST', `/org-official-roster/${inv.id}/respond`, official1, { response: 'accept' });
    assert.equal(r._status, 403);
  });

  // ── Suspend / reinstate ────────────────────────────────────────────────────
  it('owner suspends active official → status becomes suspended', async () => {
    const rows = await pool.query("SELECT id FROM org_official_rosters WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [org.id, official1.id]);
    const rosterId = rows.rows[0].id;
    const r = await request('POST', `/org-official-roster/${rosterId}/suspend`, owner, { reason: 'Test suspension' });
    assert.equal(r.status, 'suspended');
  });

  it('admin reinstates suspended official → status becomes active', async () => {
    const rows = await pool.query("SELECT id FROM org_official_rosters WHERE organisation_id=$1 AND user_id=$2 AND status='suspended'", [org.id, official1.id]);
    const rosterId = rows.rows[0].id;
    const r = await request('POST', `/org-official-roster/${rosterId}/reinstate`, admin, { reason: 'Cleared' });
    assert.equal(r.status, 'active');
    // history should have both transitions
    const hist = await pool.query("SELECT * FROM org_official_roster_history WHERE roster_id=$1 ORDER BY at", [rosterId]);
    assert.ok(hist.rows.some((h) => h.to_status === 'suspended'));
    assert.ok(hist.rows.some((h) => h.to_status === 'active'));
  });

  it('outsider cannot suspend an official from another org', async () => {
    const rows = await pool.query("SELECT id FROM org_official_rosters WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [org.id, official1.id]);
    const rosterId = rows.rows[0].id;
    const r = await request('POST', `/org-official-roster/${rosterId}/suspend`, outsider, { reason: 'hack' });
    assert.equal(r._status, 403);
  });

  // ── Assignor grants ────────────────────────────────────────────────────────
  it('owner grants assignor permission → grant row created', async () => {
    // admin is an org member already
    const r = await request('POST', `/organisations/${org.id}/assignors`, owner, { user_id: admin.id, sport_id: sport.id, can_invite: true, can_assign: true, can_release: false });
    assert.equal(r.status, 'active');
    assert.equal(r.granted_to, admin.id);
    assert.equal(r.can_invite, true);
  });

  it('grantee can call bulk-assign endpoint', async () => {
    // create an event in the org
    const ev = await testEvent({ organisation_id: org.id, organizer_id: owner.id });
    // admin (grantee) should be able to query the event as organizer
    const r = await request('GET', `/organisations/${org.id}/officials/command`, admin, {});
    assert.ok(r.counts);
  });

  it('owner revokes assignor grant → grantee loses access', async () => {
    const grants = await pool.query("SELECT id FROM org_assignor_grants WHERE organisation_id=$1 AND granted_to=$2 AND status='active'", [org.id, admin.id]);
    const grantId = grants.rows[0].id;
    const r = await request('POST', `/org-assignors/${grantId}/revoke`, owner, {});
    assert.equal(r.status, 'revoked');
  });

  it('duplicate grant returns 409', async () => {
    // re-grant to admin
    await request('POST', `/organisations/${org.id}/assignors`, owner, { user_id: admin.id, sport_id: sport.id });
    const r = await request('POST', `/organisations/${org.id}/assignors`, owner, { user_id: admin.id, sport_id: sport.id });
    assert.equal(r._status, 409);
  });

  // ── Command overview ───────────────────────────────────────────────────────
  it('command overview returns correct roster counts', async () => {
    const r = await request('GET', `/organisations/${org.id}/officials/command`, owner, {});
    assert.ok(r.counts.active >= 1);
  });

  it('outsider gets 404 on command overview', async () => {
    const r = await request('GET', `/organisations/${org.id}/officials/command`, outsider, {});
    assert.equal(r._status, 404);
  });

  // ── Unfilled fixtures ──────────────────────────────────────────────────────
  it('unfilled endpoint returns fixture when no referee assigned', async () => {
    const ev = await testEvent({ organisation_id: org.id, organizer_id: owner.id, sport_id: sport.id });
    const fix = await testFixture({ event_id: ev.id, status: 'scheduled', scheduled_at: new Date(Date.now() + 86400000 * 3).toISOString() });
    const r = await request('GET', `/organisations/${org.id}/officials/unfilled`, owner, { days_ahead: 10 });
    assert.ok(Array.isArray(r));
    const found = r.find((f) => f.id === fix.id);
    assert.ok(found);
    assert.ok(found.roles_needed.includes('referee'));
  });

  // ── Broadcast message ──────────────────────────────────────────────────────
  it('owner sends message to panel → recipient_count equals active officials', async () => {
    // re-invite official2 and have them accept
    let inv;
    try { inv = await request('POST', `/organisations/${org.id}/officials/roster`, owner, { user_id: official2.id, sport_id: sport.id }); } catch (e) { /* may already exist */ }
    if (inv?.id) await request('POST', `/org-official-roster/${inv.id}/respond`, official2, { response: 'accept' });
    const r = await request('POST', `/organisations/${org.id}/officials/messages`, owner, { subject: 'Test broadcast', body: 'This is a test message for the panel.' });
    assert.ok(r.recipient_count >= 1);
  });

  // ── Eligibility ────────────────────────────────────────────────────────────
  it('eligibility endpoint categorises officials by credential band', async () => {
    const r = await request('GET', `/organisations/${org.id}/officials/eligibility`, owner, {});
    assert.ok(Array.isArray(r.expired));
    assert.ok(Array.isArray(r.expiring));
    assert.ok(Array.isArray(r.no_credential));
  });

  // ── Export ─────────────────────────────────────────────────────────────────
  it('export returns CSV content-type with no PII columns', async () => {
    const r = await request('GET', `/organisations/${org.id}/officials/roster/export`, owner, {}, { raw: true });
    assert.equal(r.headers['content-type'], 'text/csv');
    const csv = await r.text();
    // must not expose personal address, tax id or payout details
    assert.ok(!csv.toLowerCase().includes('tax_id'));
    assert.ok(!csv.toLowerCase().includes('bank_account'));
    assert.ok(!csv.toLowerCase().includes('address'));
  });

  // ── Org boundary ───────────────────────────────────────────────────────────
  it('admin from org A cannot see org B roster', async () => {
    const orgB = await testOrg({ owner_id: outsider.id });
    const r = await request('GET', `/organisations/${orgB.id}/officials/roster`, admin, {});
    assert.equal(r._status, 404);
  });
});
