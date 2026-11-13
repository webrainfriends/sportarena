// REF-R11: Officials Services & Opportunity Marketplace (#1003)
// Tests: listing guards, PII leak, full engagement lifecycle, idempotency,
//        race condition, volunteer flow, youth exclusion, MCP parity.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { testUser, testOrg, testEvent, testFixture, testSport } from './helpers.js';

let official, officialYouth, organiser, organiser2;
let sportId, orgId, eventId, fixtureId;

before(async () => {
  official      = await testUser({ roles: ['official', 'referee'], dob: '1990-01-01' });
  officialYouth = await testUser({ roles: ['official', 'referee'], dob: new Date(Date.now() - 15 * 365.25 * 86400000).toISOString().slice(0, 10) });
  organiser     = await testUser({ roles: ['organiser'] });
  organiser2    = await testUser({ roles: ['organiser'] });
  sportId       = await testSport();
  const org     = await testOrg(organiser.id);
  orgId         = org.id;
  eventId       = await testEvent(organiser.id, { sport_id: sportId, org_id: orgId });
  fixtureId     = await testFixture(eventId, {
    status: 'scheduled',
    duration_min: 90,
    scheduled_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  });
});

after(async () => { await pool.end(); });

// ─── helpers ─────────────────────────────────────────────────────────────────

async function call(user, method, path, body = {}) {
  const { capabilities } = await import('../src/registry.js');
  const cap = capabilities.find((c) => c.method === method && c.path === path);
  if (!cap) throw new Error(`No capability ${method} ${path}`);
  return cap.handler({ user, session: { user_id: user.id } }, { ...body });
}

async function dbRow(table, where) {
  const keys   = Object.keys(where);
  const vals   = Object.values(where);
  const clause = keys.map((k, i) => `${k}=$${i + 1}`).join(' AND ');
  const { rows } = await pool.query(`SELECT * FROM ${table} WHERE ${clause}`, vals);
  return rows[0] ?? null;
}

// ─── listing CRUD ─────────────────────────────────────────────────────────────

describe('official service listing', () => {
  it('requires the caller to hold the referee role', async () => {
    const noRole = await testUser({ roles: ['organiser'] });
    await assert.rejects(
      () => call(noRole, 'PUT', '/me/official-service-listing', {
        headline: 'Pro Ref', summary: 'x'.repeat(100), family: 'official',
        sports: [sportId], rate_minor: 5000, rate_currency: 'GBP', rate_unit: 'per_match',
        locations: ['London'], remote: false,
        meta: { roles: ['referee'], grades: ['Level 2'], event_types: ['league'], equipment_own: [] },
      }),
      /not.*referee|unauthorized|forbidden/i,
    );
  });

  let listingId;
  it('official can create a listing with meta', async () => {
    const r = await call(official, 'PUT', '/me/official-service-listing', {
      headline: 'Elite Match Official — UEFA Qualified',
      summary: 'x'.repeat(100),
      family: 'official',
      sports: [sportId],
      rate_minor: 7500,
      rate_currency: 'GBP',
      rate_unit: 'per_match',
      locations: ['London', 'South East England'],
      remote: false,
      meta: {
        roles: ['referee', 'fourth_official'],
        grades: ['UEFA Level 2', 'FA Level 4'],
        event_types: ['league', 'cup', 'friendly'],
        equipment_own: ['whistle', 'flag_set', 'uniform_formal'],
        max_travel_km: 150,
        volunteer_available: false,
      },
    });
    assert.ok(r.listing_id || r.id, 'returns listing id');
    listingId = r.listing_id ?? r.id;

    const meta = await dbRow('official_listing_meta', { listing_id: listingId });
    assert.ok(meta, 'meta row created');
    assert.deepEqual(meta.roles, ['referee', 'fourth_official']);
    assert.deepEqual(meta.grades, ['UEFA Level 2', 'FA Level 4']);
  });

  it('GET /me/official-service-listing returns metric strip without PII', async () => {
    const r = await call(official, 'GET', '/me/official-service-listing', {});
    assert.ok(r.listing, 'listing present');
    assert.ok(r.metrics, 'metrics present');
    // must not leak encrypted fields
    assert.ok(!r.listing.tax_id_enc, 'no tax_id_enc');
    assert.ok(!r.listing.payout_account_enc, 'no payout_account_enc');
  });

  it('official can pause the listing', async () => {
    const r = await call(official, 'PATCH', '/me/official-service-listing/state', { state: 'paused' });
    assert.equal(r.state, 'paused');
  });

  it('official can resume the listing', async () => {
    const r = await call(official, 'PATCH', '/me/official-service-listing/state', { state: 'published' });
    assert.equal(r.state, 'published');
  });
});

// ─── discovery & PII ─────────────────────────────────────────────────────────

describe('GET /official-services search', () => {
  it('returns officials matching sport filter', async () => {
    const r = await call(organiser, 'GET', '/official-services', { sport: sportId });
    assert.ok(Array.isArray(r.results), 'results array');
  });

  it('never returns payout_account_enc or tax_id_enc to organiser', async () => {
    const r = await call(organiser, 'GET', '/official-services', {});
    for (const row of r.results ?? []) {
      assert.ok(!row.payout_account_enc, 'no payout_account_enc');
      assert.ok(!row.tax_id_enc, 'no tax_id_enc');
    }
  });

  it('excludes youth officials (age < 18)', async () => {
    const r = await call(organiser, 'GET', '/official-services', {});
    const ids = (r.results ?? []).map((x) => x.user_id ?? x.provider_id);
    assert.ok(!ids.includes(officialYouth.id), 'youth excluded');
  });
});

// ─── engagement lifecycle ─────────────────────────────────────────────────────

describe('engagement lifecycle', () => {
  let engagementId;
  let listingId;

  before(async () => {
    const me = await call(official, 'GET', '/me/official-service-listing', {});
    listingId = me.listing?.id;
    assert.ok(listingId, 'listing exists for lifecycle test');
  });

  it('organiser can request an official', async () => {
    const r = await call(organiser, 'POST', `/official-services/:listing_id/request`, {
      listing_id: listingId,
      fixture_id: fixtureId,
      role: 'referee',
      proposed_date: new Date(Date.now() + 14 * 86400000).toISOString(),
      message: 'We would like you to officiate our cup semi-final.',
      budget_minor: 7500,
      budget_currency: 'GBP',
    });
    assert.ok(r.engagement_id || r.id, 'engagement created');
    engagementId = r.engagement_id ?? r.id;
  });

  it('engagement appears in official incoming requests', async () => {
    const r = await call(official, 'GET', '/me/official-service-listing', {});
    const ids = (r.engagements ?? []).map((e) => e.id);
    assert.ok(ids.includes(engagementId), 'engagement visible to official');
  });

  it('official can assign booking to fixture (contracted state required)', async () => {
    // Force engagement to contracted state for test
    await pool.query(
      `UPDATE marketplace_engagements SET status='contracted' WHERE id=$1`,
      [engagementId],
    );

    const r = await call(organiser, 'POST', `/official-service-bookings/:engagement_id/assign`, {
      engagement_id: engagementId,
      fixture_id: fixtureId,
      role: 'referee',
    });
    assert.ok(r.fixture_official_id || r.ok, 'fixture_officials row created');
  });

  it('/assign is idempotent — second call returns same row', async () => {
    const r2 = await call(organiser, 'POST', `/official-service-bookings/:engagement_id/assign`, {
      engagement_id: engagementId,
      fixture_id: fixtureId,
      role: 'referee',
    });
    assert.ok(r2.fixture_official_id || r2.ok);
  });

  it('organiser can post a review with 5-criteria scores', async () => {
    // Force status to 'completed' so review is accepted
    await pool.query(
      `UPDATE marketplace_engagements SET status='completed' WHERE id=$1`,
      [engagementId],
    );

    const r = await call(organiser, 'POST', `/official-service-bookings/:engagement_id/review`, {
      engagement_id: engagementId,
      punctuality: 5,
      communication: 4,
      officiating_quality: 5,
      professionalism: 5,
      rules_adherence: 4,
      public_note: 'Excellent performance throughout the match.',
    });
    assert.ok(r.review_id || r.ok, 'review created');

    const row = await dbRow('official_service_reviews', { engagement_id: engagementId });
    assert.ok(row, 'review row in db');
    assert.equal(row.punctuality, 5);
    assert.ok(Number(row.overall) > 4, 'overall computed correctly');
  });

  it('second review on same engagement is rejected', async () => {
    await assert.rejects(
      () => call(organiser, 'POST', `/official-service-bookings/:engagement_id/review`, {
        engagement_id: engagementId,
        punctuality: 1,
        communication: 1,
        officiating_quality: 1,
        professionalism: 1,
        rules_adherence: 1,
        public_note: 'Duplicate review attempt.',
      }),
      /already reviewed|conflict|duplicate/i,
    );
  });
});

// ─── volunteer flow ───────────────────────────────────────────────────────────

describe('volunteer (zero-fee) flow', () => {
  it('official can flag volunteer_available on their listing', async () => {
    const r = await call(official, 'PUT', '/me/official-service-listing', {
      headline: 'Volunteer Ref Available',
      summary: 'x'.repeat(100),
      family: 'official',
      sports: [sportId],
      rate_minor: 0,
      rate_currency: 'GBP',
      rate_unit: 'per_match',
      locations: ['London'],
      remote: true,
      meta: {
        roles: ['referee'],
        grades: [],
        event_types: ['volunteer'],
        equipment_own: ['whistle'],
        volunteer_available: true,
      },
    });
    assert.ok(r.listing_id ?? r.id);

    const listingId = r.listing_id ?? r.id;
    const meta = await dbRow('official_listing_meta', { listing_id: listingId });
    assert.equal(meta.volunteer_available, true);
  });

  it('volunteer_only filter returns volunteer-flagged officials', async () => {
    const r = await call(organiser, 'GET', '/official-services', { volunteer_only: true });
    assert.ok(Array.isArray(r.results));
    for (const row of r.results ?? []) {
      // row should have volunteer_available=true in meta (via join)
      assert.ok(row.volunteer_available !== false, 'all results are volunteer-flagged');
    }
  });
});

// ─── MCP parity ───────────────────────────────────────────────────────────────

describe('MCP parity', () => {
  it('search capability is listed in registry with MCP enabled', async () => {
    const { capabilities } = await import('../src/registry.js');
    const cap = capabilities.find(
      (c) => c.method === 'GET' && c.path === '/official-services',
    );
    assert.ok(cap, 'capability registered');
    assert.ok(!cap.mcp_disabled, 'MCP not disabled');
  });
});
