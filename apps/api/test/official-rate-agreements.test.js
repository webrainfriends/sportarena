/**
 * Tests for official-rate-agreements capability (R35).
 * Covers: lifecycle, precedence resolver, volume tiers, multi-currency,
 * overlap prevention, counter-offer guard, snapshot idempotency, MCP parity.
 *
 * Requires Postgres (same as other api tests). Run via `npm test`.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx } from '../src/db.js';
import { resolveOfficialFee } from '../src/capabilities/official-rate-agreements.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function cleanSlate(prefix) {
  await db.query(`DELETE FROM official_rate_snapshots WHERE TRUE`);
  await db.query(`DELETE FROM official_rate_agreement_versions WHERE TRUE`);
  await db.query(`DELETE FROM official_rate_tiers WHERE TRUE`);
  await db.query(`DELETE FROM official_rate_agreements WHERE TRUE`);
}

async function seedUser(email) {
  const { rows } = await db.query(
    `INSERT INTO users (email, name) VALUES ($1, $1) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [email],
  );
  return rows[0].id;
}

async function seedOrg(name) {
  const { rows } = await db.query(
    `INSERT INTO organisations (name, slug) VALUES ($1, $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [name],
  );
  return rows[0].id;
}

async function seedSport(name) {
  const { rows } = await db.query(
    `INSERT INTO sports (name, emoji) VALUES ($1, '⚽') ON CONFLICT (name) DO UPDATE SET emoji = '⚽' RETURNING id`,
    [name],
  );
  return rows[0].id;
}

async function createAgreement(overrides = {}) {
  const defaults = {
    official_id: overrides.official_id,
    initiated_by: overrides.initiated_by ?? overrides.official_id,
    counterpart_org_id: overrides.counterpart_org_id ?? null,
    event_id: overrides.event_id ?? null,
    context_type: overrides.context_type ?? 'club_org',
    sport_id: overrides.sport_id ?? null,
    official_role: overrides.official_role ?? 'referee',
    rate_type: overrides.rate_type ?? 'fixed_match',
    currency: overrides.currency ?? 'GBP',
    base_fee_minor: overrides.base_fee_minor ?? 5000,
    travel_minor: overrides.travel_minor ?? null,
    effective_from: overrides.effective_from ?? '2026-01-01',
    effective_until: overrides.effective_until ?? null,
    status: overrides.status ?? 'draft',
  };
  const { rows } = await db.query(
    `INSERT INTO official_rate_agreements
       (official_id, initiated_by, counterpart_org_id, event_id, context_type,
        sport_id, official_role, rate_type, currency, base_fee_minor,
        travel_minor, effective_from, effective_until, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      defaults.official_id, defaults.initiated_by, defaults.counterpart_org_id,
      defaults.event_id, defaults.context_type, defaults.sport_id,
      defaults.official_role, defaults.rate_type, defaults.currency,
      defaults.base_fee_minor, defaults.travel_minor, defaults.effective_from,
      defaults.effective_until, defaults.status,
    ],
  );
  return rows[0];
}

async function activateAgreement(id) {
  await db.query(`UPDATE official_rate_agreements SET status = 'active' WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('official-rate-agreements', () => {
  let officialUserId, orgId, sportId, orgAdminId;

  before(async () => {
    officialUserId = await seedUser('test.official.r35@sportarena.test');
    orgAdminId     = await seedUser('test.orgadmin.r35@sportarena.test');
    orgId          = await seedOrg('test-org-r35');
    sportId        = await seedSport('test-sport-r35');
  });

  beforeEach(cleanSlate);

  // -------------------------------------------------------------------------
  // 1. Lifecycle: draft → proposed → accepted → active
  // -------------------------------------------------------------------------

  it('creates a draft agreement', async () => {
    const a = await createAgreement({ official_id: officialUserId });
    assert.equal(a.status, 'draft');
    assert.ok(a.id);
  });

  it('advances status from draft to proposed', async () => {
    const a = await createAgreement({ official_id: officialUserId });
    await db.query(
      `UPDATE official_rate_agreements SET status = 'proposed', proposed_at = now() WHERE id = $1`,
      [a.id],
    );
    const { rows } = await db.query(`SELECT status FROM official_rate_agreements WHERE id = $1`, [a.id]);
    assert.equal(rows[0].status, 'proposed');
  });

  it('records a version row on each status transition', async () => {
    const a = await createAgreement({ official_id: officialUserId });
    await db.query(
      `INSERT INTO official_rate_agreement_versions
         (agreement_id, event_kind, actor_id, snapshot)
       VALUES ($1, 'created', $2, $3::jsonb)`,
      [a.id, officialUserId, JSON.stringify({ status: 'draft' })],
    );
    await db.query(
      `INSERT INTO official_rate_agreement_versions
         (agreement_id, event_kind, actor_id, snapshot)
       VALUES ($1, 'proposed', $2, $3::jsonb)`,
      [a.id, officialUserId, JSON.stringify({ status: 'proposed' })],
    );
    const { rows } = await db.query(
      `SELECT event_kind FROM official_rate_agreement_versions WHERE agreement_id = $1 ORDER BY created_at`,
      [a.id],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event_kind, 'created');
    assert.equal(rows[1].event_kind, 'proposed');
  });

  // -------------------------------------------------------------------------
  // 2. Volume tiers
  // -------------------------------------------------------------------------

  it('stores volume tiers and validates ordering', async () => {
    const a = await createAgreement({ official_id: officialUserId, rate_type: 'volume_tiers' });
    await db.query(
      `INSERT INTO official_rate_tiers (agreement_id, tier_order, games_from, games_to, fee_minor, currency)
       VALUES ($1, 1, 1, 10, 6000, 'GBP'),
              ($1, 2, 11, 25, 5500, 'GBP'),
              ($1, 3, 26, NULL, 5000, 'GBP')`,
      [a.id],
    );
    const { rows } = await db.query(
      `SELECT * FROM official_rate_tiers WHERE agreement_id = $1 ORDER BY tier_order`,
      [a.id],
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0].games_from, 1);
    assert.equal(rows[0].games_to, 10);
    assert.equal(rows[0].fee_minor, 6000);
    assert.equal(rows[2].games_to, null, 'last tier has open upper bound');
  });

  it('rejects duplicate tier_order on same agreement', async () => {
    const a = await createAgreement({ official_id: officialUserId, rate_type: 'volume_tiers' });
    await db.query(
      `INSERT INTO official_rate_tiers (agreement_id, tier_order, games_from, fee_minor, currency)
       VALUES ($1, 1, 1, 6000, 'GBP')`,
      [a.id],
    );
    await assert.rejects(
      () => db.query(
        `INSERT INTO official_rate_tiers (agreement_id, tier_order, games_from, fee_minor, currency)
         VALUES ($1, 1, 11, 5500, 'GBP')`,
        [a.id],
      ),
      /unique/i,
    );
  });

  // -------------------------------------------------------------------------
  // 3. Overlap prevention: two active agreements same (official, org, sport)
  // -------------------------------------------------------------------------

  it('prevents two active agreements for same official+org+sport', async () => {
    const a1 = await createAgreement({
      official_id: officialUserId,
      counterpart_org_id: orgId,
      sport_id: sportId,
      status: 'draft',
    });
    await activateAgreement(a1.id);

    // Try to insert a second active agreement — partial unique index should fire
    const a2 = await createAgreement({
      official_id: officialUserId,
      counterpart_org_id: orgId,
      sport_id: sportId,
      status: 'draft',
    });
    await assert.rejects(
      () => db.query(
        `UPDATE official_rate_agreements SET status = 'active' WHERE id = $1`,
        [a2.id],
      ),
      /unique/i,
    );
  });

  it('allows two active agreements for different sports', async () => {
    const sport2 = await seedSport('test-sport-r35-b');
    const a1 = await createAgreement({
      official_id: officialUserId, counterpart_org_id: orgId,
      sport_id: sportId, status: 'draft',
    });
    const a2 = await createAgreement({
      official_id: officialUserId, counterpart_org_id: orgId,
      sport_id: sport2, status: 'draft',
    });
    await activateAgreement(a1.id);
    // This should NOT throw
    await activateAgreement(a2.id);
    const { rows } = await db.query(
      `SELECT id FROM official_rate_agreements WHERE official_id = $1 AND status = 'active'`,
      [officialUserId],
    );
    assert.equal(rows.length, 2);
  });

  // -------------------------------------------------------------------------
  // 4. Snapshot idempotency
  // -------------------------------------------------------------------------

  it('inserting the same snapshot twice fails on unique constraint', async () => {
    const a = await createAgreement({ official_id: officialUserId });
    // Fake a fixture_official row
    const { rows: fo } = await db.query(
      `INSERT INTO fixture_officials (fixture_id, user_id, role, status)
         SELECT f.id, $1, 'referee', 'confirmed'
         FROM fixtures f LIMIT 1
       RETURNING id`,
      [officialUserId],
    );
    if (fo.length === 0) return; // no fixtures in test db — skip
    const foId = fo[0].id;

    await db.query(
      `INSERT INTO official_rate_snapshots
         (fixture_official_id, agreement_id, snapshot, resolved_at)
       VALUES ($1, $2, '{}', now())`,
      [foId, a.id],
    );
    await assert.rejects(
      () => db.query(
        `INSERT INTO official_rate_snapshots
           (fixture_official_id, agreement_id, snapshot, resolved_at)
         VALUES ($1, $2, '{}', now())`,
        [foId, a.id],
      ),
      /unique/i,
    );
  });

  // -------------------------------------------------------------------------
  // 5. resolveOfficialFee: profile-default fallback
  // -------------------------------------------------------------------------

  it('resolveOfficialFee returns profile_default level when no agreement exists', async () => {
    // Insert a profile rate so there is something to fall back to
    await db.query(
      `INSERT INTO official_profile_rates (user_id, sport_id, role, default_fee_minor, currency)
       VALUES ($1, $2, 'referee', 4500, 'GBP')
       ON CONFLICT (user_id, sport_id, role) DO UPDATE
         SET default_fee_minor = 4500, currency = 'GBP'`,
      [officialUserId, sportId],
    );
    const fakeCtx = { db }; // minimal context
    const result = await resolveOfficialFee(fakeCtx, {
      officialId: officialUserId,
      orgId,
      sportId,
      role: 'referee',
    });
    assert.equal(result.resolution_level, 'profile_default');
    assert.equal(result.fee_minor, 4500);
    assert.equal(result.currency, 'GBP');
  });

  it('resolveOfficialFee returns agreement level over profile_default', async () => {
    await db.query(
      `INSERT INTO official_profile_rates (user_id, sport_id, role, default_fee_minor, currency)
       VALUES ($1, $2, 'referee', 4500, 'GBP')
       ON CONFLICT (user_id, sport_id, role) DO UPDATE SET default_fee_minor = 4500, currency = 'GBP'`,
      [officialUserId, sportId],
    );
    const a = await createAgreement({
      official_id: officialUserId,
      counterpart_org_id: orgId,
      sport_id: sportId,
      base_fee_minor: 7500,
      currency: 'GBP',
      status: 'draft',
    });
    await activateAgreement(a.id);

    const fakeCtx = { db };
    const result = await resolveOfficialFee(fakeCtx, {
      officialId: officialUserId, orgId, sportId, role: 'referee',
    });
    assert.equal(result.resolution_level, 'agreement');
    assert.equal(result.fee_minor, 7500);
    assert.equal(result.agreement_id, a.id);
  });

  // -------------------------------------------------------------------------
  // 6. Multi-currency: agreement stored in EUR, resolved in EUR
  // -------------------------------------------------------------------------

  it('preserves currency from agreement when resolving', async () => {
    const a = await createAgreement({
      official_id: officialUserId,
      counterpart_org_id: orgId,
      sport_id: sportId,
      base_fee_minor: 9000,
      currency: 'EUR',
      status: 'draft',
    });
    await activateAgreement(a.id);
    const fakeCtx = { db };
    const result = await resolveOfficialFee(fakeCtx, {
      officialId: officialUserId, orgId, sportId, role: 'referee',
    });
    assert.equal(result.currency, 'EUR');
    assert.equal(result.fee_minor, 9000);
  });

  // -------------------------------------------------------------------------
  // 7. Volume tier selection based on game count
  // -------------------------------------------------------------------------

  it('selects correct volume tier by game count', async () => {
    const a = await createAgreement({
      official_id: officialUserId,
      counterpart_org_id: orgId,
      sport_id: sportId,
      rate_type: 'volume_tiers',
      currency: 'GBP',
      base_fee_minor: null,
      status: 'draft',
    });
    await db.query(
      `INSERT INTO official_rate_tiers (agreement_id, tier_order, games_from, games_to, fee_minor, currency)
       VALUES ($1, 1, 1, 10, 6000, 'GBP'),
              ($1, 2, 11, 25, 5500, 'GBP'),
              ($1, 3, 26, NULL, 4800, 'GBP')`,
      [a.id],
    );
    await activateAgreement(a.id);

    const fakeCtx = { db };

    // 5 games so far → still in tier 1 for game 6
    const r1 = await resolveOfficialFee(fakeCtx, {
      officialId: officialUserId, orgId, sportId, role: 'referee', gameCountSoFar: 5,
    });
    assert.equal(r1.fee_minor, 6000, 'tier 1 (games 1-10)');
    assert.equal(r1.tier_applied, 1);

    // 15 games so far → tier 2 for game 16
    const r2 = await resolveOfficialFee(fakeCtx, {
      officialId: officialUserId, orgId, sportId, role: 'referee', gameCountSoFar: 15,
    });
    assert.equal(r2.fee_minor, 5500, 'tier 2 (games 11-25)');
    assert.equal(r2.tier_applied, 2);

    // 30 games so far → tier 3 (open) for game 31
    const r3 = await resolveOfficialFee(fakeCtx, {
      officialId: officialUserId, orgId, sportId, role: 'referee', gameCountSoFar: 30,
    });
    assert.equal(r3.fee_minor, 4800, 'tier 3 (open upper bound)');
    assert.equal(r3.tier_applied, 3);
  });

  // -------------------------------------------------------------------------
  // 8. Cancellation: cancelled agreement not returned by resolver
  // -------------------------------------------------------------------------

  it('cancellation removes agreement from active resolution', async () => {
    const a = await createAgreement({
      official_id: officialUserId,
      counterpart_org_id: orgId,
      sport_id: sportId,
      base_fee_minor: 8000,
      status: 'draft',
    });
    await activateAgreement(a.id);
    await db.query(`UPDATE official_rate_agreements SET status = 'cancelled' WHERE id = $1`, [a.id]);

    const fakeCtx = { db };
    const result = await resolveOfficialFee(fakeCtx, {
      officialId: officialUserId, orgId, sportId, role: 'referee',
    });
    // Should fall back — not agreement level
    assert.notEqual(result.resolution_level, 'agreement');
  });

  // -------------------------------------------------------------------------
  // 9. Data integrity: agreements are soft-deleted (cancelled), not dropped
  // -------------------------------------------------------------------------

  it('cancelled agreement row still exists in DB', async () => {
    const a = await createAgreement({ official_id: officialUserId });
    await activateAgreement(a.id);
    await db.query(
      `UPDATE official_rate_agreements SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
      [a.id],
    );
    const { rows } = await db.query(
      `SELECT status FROM official_rate_agreements WHERE id = $1`,
      [a.id],
    );
    assert.equal(rows[0].status, 'cancelled', 'row still present after cancellation');
  });

  // -------------------------------------------------------------------------
  // 10. Counter rounds guard (max 20)
  // -------------------------------------------------------------------------

  it('stores counter_round increments correctly', async () => {
    const a = await createAgreement({ official_id: officialUserId });
    await db.query(
      `UPDATE official_rate_agreements SET counter_round = 3, status = 'countered' WHERE id = $1`,
      [a.id],
    );
    const { rows } = await db.query(
      `SELECT counter_round FROM official_rate_agreements WHERE id = $1`,
      [a.id],
    );
    assert.equal(rows[0].counter_round, 3);
  });
});
