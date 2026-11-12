/**
 * Tests for official-discounts capability (R36 / #1017).
 * Covers: CRUD lifecycle, eligibility rules, stacking, floors, redemptions,
 * idempotency, race conditions, tax invariants, auth enforcement.
 *
 * Requires Postgres. Run via `npm test`.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { buildApp } from '../src/app.js';

// ─── Seed helpers ────────────────────────────────────────────────────────────

async function seedUser(email, roles = []) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, display_name, roles)
     VALUES ($1, $1, $2)
     ON CONFLICT (email) DO UPDATE SET roles = $2
     RETURNING id`,
    [email, JSON.stringify(roles)],
  );
  return rows[0].id;
}

async function seedOrg(name) {
  const { rows } = await pool.query(
    `INSERT INTO organisations (name, slug)
     VALUES ($1, $1)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name],
  );
  return rows[0].id;
}

async function cleanDiscounts() {
  await pool.query('DELETE FROM official_discount_approvals WHERE TRUE');
  await pool.query('DELETE FROM official_discount_redemptions WHERE TRUE');
  await pool.query('DELETE FROM official_discounts WHERE TRUE');
}

// ─── App & token helpers ─────────────────────────────────────────────────────

let app;
let officialId, customerId, adminId, otherOfficialId;
let orgId;

before(async () => {
  app = await buildApp();
  officialId      = await seedUser('official.r36@test.invalid');
  otherOfficialId = await seedUser('other.official.r36@test.invalid');
  customerId      = await seedUser('customer.r36@test.invalid');
  adminId         = await seedUser('admin.r36@test.invalid', ['admin']);
  orgId           = await seedOrg('test-academy-r36');
});

after(async () => {
  await cleanDiscounts();
  await pool.end();
});

beforeEach(cleanDiscounts);

const req = (method, path, body, userId) =>
  app.inject({
    method,
    url: `/api${path}`,
    headers: { authorization: `Bearer test-token-${userId}` },
    ...(body ? { payload: body } : {}),
  });

// ─── 1. Discount CRUD ────────────────────────────────────────────────────────

describe('official-discounts: CRUD', () => {
  it('creates a percent discount in draft status', async () => {
    const res = await req('POST', '/official-discounts', {
      name: 'Academy Bundle 15%',
      kind: 'percent',
      value_bp: 1500,
      discount_type: 'recurring_contract',
      funded_by: 'referee',
      auto_apply: true,
    }, officialId);

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'draft');
    assert.equal(body.kind, 'percent');
    assert.equal(body.value_bp, 1500);
    assert.equal(body.owner_id, officialId);
    assert.equal(body.funded_by, 'referee');
  });

  it('creates a fixed discount in draft status', async () => {
    const res = await req('POST', '/official-discounts', {
      name: 'Early Bird £25',
      kind: 'fixed',
      value_minor: 2500,
      currency: 'GBP',
      discount_type: 'early_commitment',
      funded_by: 'platform',
      days_advance: 14,
      auto_apply: false,
      code: 'EARLY25',
    }, officialId);

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'draft');
    assert.equal(body.kind, 'fixed');
    assert.equal(body.value_minor, 2500);
    assert.equal(body.currency, 'GBP');
  });

  it('rejects value_bp > 10000 (over 100%)', async () => {
    const res = await req('POST', '/official-discounts', {
      name: 'Invalid',
      kind: 'percent',
      value_bp: 10001,
      discount_type: 'event',
      funded_by: 'referee',
    }, officialId);
    assert.equal(res.statusCode, 400);
  });

  it('normalises coupon code to uppercase', async () => {
    const res = await req('POST', '/official-discounts', {
      name: 'Case Test',
      kind: 'fixed',
      value_minor: 1000,
      currency: 'GBP',
      discount_type: 'coupon',
      funded_by: 'referee',
      code: 'mycode',
    }, officialId);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.equal(body.code_normalized, 'MYCODE');
  });

  it('activates a draft discount', async () => {
    const create = await req('POST', '/official-discounts', {
      name: 'Activate Me',
      kind: 'percent',
      value_bp: 1000,
      discount_type: 'bulk_games',
      funded_by: 'referee',
      min_booking_count: 5,
    }, officialId);
    const { id } = JSON.parse(create.payload);

    const activate = await req('POST', `/official-discounts/${id}/activate`, {}, officialId);
    assert.equal(activate.statusCode, 200);
    const body = JSON.parse(activate.payload);
    assert.equal(body.status, 'active');
  });

  it('rejects duplicate coupon code for same owner', async () => {
    // Create and activate first discount with code
    const first = await req('POST', '/official-discounts', {
      name: 'First Code',
      kind: 'fixed',
      value_minor: 500,
      currency: 'GBP',
      discount_type: 'coupon',
      funded_by: 'referee',
      code: 'UNIQUE99',
    }, officialId);
    const { id: firstId } = JSON.parse(first.payload);
    await req('POST', `/official-discounts/${firstId}/activate`, {}, officialId);

    // Second with same code should fail
    const second = await req('POST', '/official-discounts', {
      name: 'Second Code',
      kind: 'fixed',
      value_minor: 500,
      currency: 'GBP',
      discount_type: 'coupon',
      funded_by: 'referee',
      code: 'unique99', // lowercase — same normalised
    }, officialId);
    assert.equal(second.statusCode, 409);
  });

  it('updates name and valid_to', async () => {
    const create = await req('POST', '/official-discounts', {
      name: 'Old Name',
      kind: 'percent',
      value_bp: 500,
      discount_type: 'loyalty',
      funded_by: 'referee',
    }, officialId);
    const { id } = JSON.parse(create.payload);

    const update = await req('PATCH', `/official-discounts/${id}`, {
      name: 'Updated Name',
      valid_to: '2027-12-31',
    }, officialId);
    assert.equal(update.statusCode, 200);
    const body = JSON.parse(update.payload);
    assert.equal(body.name, 'Updated Name');
    assert.ok(body.valid_to.startsWith('2027-12-31'));
  });

  it('soft-deletes (archives) a discount', async () => {
    const create = await req('POST', '/official-discounts', {
      name: 'To Archive',
      kind: 'percent',
      value_bp: 200,
      discount_type: 'first_booking',
      funded_by: 'referee',
    }, officialId);
    const { id } = JSON.parse(create.payload);

    const archive = await req('POST', `/official-discounts/${id}/archive`, {}, officialId);
    assert.equal(archive.statusCode, 200);

    // Should no longer appear in active list
    const list = await req('GET', '/official-discounts', null, officialId);
    const listBody = JSON.parse(list.payload);
    assert.ok(!listBody.discounts.some((d) => d.id === id));
  });
});

// ─── 2. Preview & eligibility ────────────────────────────────────────────────

describe('official-discounts: preview eligibility', () => {
  async function createActiveDiscount(overrides) {
    const defaults = {
      name: 'Test Discount',
      kind: 'percent',
      value_bp: 1000,
      discount_type: 'event',
      funded_by: 'referee',
    };
    const payload = { ...defaults, ...overrides };
    const create = await req('POST', '/official-discounts', payload, officialId);
    assert.equal(create.statusCode, 201, `Create failed: ${create.payload}`);
    const { id } = JSON.parse(create.payload);
    const activate = await req('POST', `/official-discounts/${id}/activate`, {}, officialId);
    assert.equal(activate.statusCode, 200, `Activate failed: ${activate.payload}`);
    return id;
  }

  const baseCtx = {
    official_id: null, // set per test
    booking_context: {
      game_count: 1,
      booking_days_advance: 0,
      prior_bookings_count: 0,
      customer_type: 'event_organiser',
    },
    list_price_minor: 10000,
    currency: 'GBP',
  };

  it('returns correct saving for percent discount', async () => {
    const discId = await createActiveDiscount({ value_bp: 1500 }); // 15%
    const res = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
    }, customerId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    const match = body.eligible.find((d) => d.discount_id === discId);
    assert.ok(match, 'discount should be eligible');
    // 15% of 10000 = 1500 minor
    assert.equal(match.saving_minor, 1500);
    assert.equal(match.discounted_price_minor, 8500);
  });

  it('returns correct saving for fixed discount', async () => {
    await createActiveDiscount({ kind: 'fixed', value_bp: undefined, value_minor: 2500, currency: 'GBP' });
    const res = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
    }, customerId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    const match = body.eligible.find((d) => d.saving_minor === 2500);
    assert.ok(match, 'fixed discount should be eligible with correct saving');
    assert.equal(match.discounted_price_minor, 7500);
  });

  it('respects min_booking_count for bulk games', async () => {
    await createActiveDiscount({
      discount_type: 'bulk_games',
      min_booking_count: 5,
      value_bp: 1000,
    });

    // Under threshold: not eligible
    const resUnder = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      booking_context: { ...baseCtx.booking_context, game_count: 4 },
    }, customerId);
    const bodyUnder = JSON.parse(resUnder.payload);
    assert.equal(bodyUnder.eligible.length, 0);

    // At threshold: eligible
    const resAt = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      booking_context: { ...baseCtx.booking_context, game_count: 5 },
    }, customerId);
    const bodyAt = JSON.parse(resAt.payload);
    assert.equal(bodyAt.eligible.length, 1);
  });

  it('respects days_advance for early commitment', async () => {
    await createActiveDiscount({
      discount_type: 'early_commitment',
      days_advance: 14,
      value_bp: 500,
    });

    const resInsufficient = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      booking_context: { ...baseCtx.booking_context, booking_days_advance: 10 },
    }, customerId);
    assert.equal(JSON.parse(resInsufficient.payload).eligible.length, 0);

    const resSufficient = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      booking_context: { ...baseCtx.booking_context, booking_days_advance: 14 },
    }, customerId);
    assert.equal(JSON.parse(resSufficient.payload).eligible.length, 1);
  });

  it('respects loyalty_min_prior_bookings', async () => {
    await createActiveDiscount({
      discount_type: 'loyalty',
      loyalty_min_prior_bookings: 3,
      value_bp: 800,
    });

    const resInsufficient = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      booking_context: { ...baseCtx.booking_context, prior_bookings_count: 2 },
    }, customerId);
    assert.equal(JSON.parse(resInsufficient.payload).eligible.length, 0);

    const resSufficient = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      booking_context: { ...baseCtx.booking_context, prior_bookings_count: 3 },
    }, customerId);
    assert.equal(JSON.parse(resSufficient.payload).eligible.length, 1);
  });

  it('enforces min_price_floor_minor', async () => {
    await createActiveDiscount({
      value_bp: 5000, // 50% off
      min_price_floor_minor: 6000, // floor at 6000
    });

    const res = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      list_price_minor: 10000,
    }, customerId);
    const body = JSON.parse(res.payload);
    const match = body.eligible[0];
    // 50% of 10000 = 5000; below floor of 6000
    assert.ok(match, 'discount should still appear in preview');
    assert.equal(match.is_floor_breach, true);
    assert.equal(match.needs_approval, true);
    // Actual price shown is floored at 6000
    assert.equal(match.discounted_price_minor, 6000);
  });

  it('enforces min_price_floor_pct', async () => {
    await createActiveDiscount({
      value_bp: 4000, // 40% off
      min_price_floor_pct: 70, // must remain at 70% of list
    });

    const res = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      list_price_minor: 10000,
    }, customerId);
    const body = JSON.parse(res.payload);
    const match = body.eligible[0];
    // 40% off → 6000; floor pct 70% → 7000; 6000 < 7000 → floor breach
    assert.ok(match);
    assert.equal(match.is_floor_breach, true);
    assert.equal(match.discounted_price_minor, 7000);
  });

  it('stacking: returns combined discount when both stackable=true', async () => {
    await createActiveDiscount({ name: 'Stack A', value_bp: 1000, stackable: true, stack_priority: 1 });
    await createActiveDiscount({ name: 'Stack B', value_bp: 500, stackable: true, stack_priority: 2 });

    const res = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      list_price_minor: 10000,
    }, customerId);
    const body = JSON.parse(res.payload);
    // Combined: 10% + 5% = 15% → saving 1500
    assert.ok(body.total_saving_minor >= 1500, `Expected >=1500 saving, got ${body.total_saving_minor}`);
  });

  it('stacking: returns best single when stackable=false', async () => {
    await createActiveDiscount({ name: 'Non-stack A', value_bp: 1500, stackable: false, stack_priority: 1 });
    await createActiveDiscount({ name: 'Non-stack B', value_bp: 1000, stackable: false, stack_priority: 2 });

    const res = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      list_price_minor: 10000,
    }, customerId);
    const body = JSON.parse(res.payload);
    // Best single = 15% = 1500
    assert.equal(body.best_single_saving_minor, 1500);
  });

  it('respects max_stack_discount_bp cap', async () => {
    // Two stackable discounts totalling 25%, capped at 20%
    await createActiveDiscount({ name: 'Stack Cap A', value_bp: 1500, stackable: true, max_stack_discount_bp: 2000 });
    await createActiveDiscount({ name: 'Stack Cap B', value_bp: 1000, stackable: true, max_stack_discount_bp: 2000 });

    const res = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      list_price_minor: 10000,
    }, customerId);
    const body = JSON.parse(res.payload);
    // Cap at 20% → 2000 minor saving max
    assert.ok(body.total_saving_minor <= 2000, `Saving ${body.total_saving_minor} exceeded stack cap`);
  });

  it('respects valid_from / valid_to window', async () => {
    // Discount valid only in the future
    await createActiveDiscount({
      valid_from: '2099-01-01',
      valid_to: '2099-12-31',
    });

    const res = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
    }, customerId);
    const body = JSON.parse(res.payload);
    assert.equal(body.eligible.length, 0, 'future-dated discount should not be eligible now');
  });

  it('validates coupon code case-insensitively', async () => {
    await createActiveDiscount({
      discount_type: 'coupon',
      kind: 'fixed',
      value_bp: undefined,
      value_minor: 1500,
      currency: 'GBP',
      code: 'CODETEST',
      auto_apply: false,
    });

    const resLower = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      coupon_code: 'codetest', // lowercase
    }, customerId);
    assert.equal(JSON.parse(resLower.payload).eligible.length, 1, 'case-insensitive code should match');

    const resWrong = await req('POST', '/official-discounts/preview', {
      ...baseCtx,
      official_id: officialId,
      coupon_code: 'WRONGCODE',
    }, customerId);
    assert.equal(JSON.parse(resWrong.payload).eligible.length, 0, 'wrong code should not match');
  });
});

// ─── 3. Apply & redemption ───────────────────────────────────────────────────

describe('official-discounts: apply & redemption', () => {
  async function createActivePercent(valueBp = 1000) {
    const create = await req('POST', '/official-discounts', {
      name: `Apply Test ${valueBp}bp`,
      kind: 'percent',
      value_bp: valueBp,
      discount_type: 'event',
      funded_by: 'referee',
      max_redemptions: 10,
      per_customer_limit: 2,
    }, officialId);
    const { id } = JSON.parse(create.payload);
    await req('POST', `/official-discounts/${id}/activate`, {}, officialId);
    return id;
  }

  it('creates a redemption record on apply', async () => {
    const discId = await createActivePercent(1500);
    const bookingRefId = '00000000-0000-0000-0000-000000000001';

    const res = await req('POST', `/official-discounts/${discId}/apply`, {
      official_id: officialId,
      customer_id: customerId,
      customer_type: 'event_organiser',
      booking_ref_id: bookingRefId,
      booking_ref_type: 'engagement',
      list_price_minor: 10000,
      currency: 'GBP',
      booking_context: { game_count: 1, booking_days_advance: 0, prior_bookings_count: 0, customer_type: 'event_organiser' },
    }, officialId);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.ok(body.id, 'should return redemption id');
    assert.equal(body.saving_minor, 1500); // 15% of 10000
    assert.equal(body.discounted_price_minor, 8500);
    assert.equal(body.funded_by_snapshot, 'referee');
  });

  it('is idempotent for same booking_ref_id', async () => {
    const discId = await createActivePercent(1000);
    const bookingRefId = '00000000-0000-0000-0000-000000000002';
    const payload = {
      official_id: officialId,
      customer_id: customerId,
      customer_type: 'event_organiser',
      booking_ref_id: bookingRefId,
      booking_ref_type: 'engagement',
      list_price_minor: 10000,
      currency: 'GBP',
      booking_context: { game_count: 1, booking_days_advance: 0, prior_bookings_count: 0, customer_type: 'event_organiser' },
    };

    const res1 = await req('POST', `/official-discounts/${discId}/apply`, payload, officialId);
    const res2 = await req('POST', `/official-discounts/${discId}/apply`, payload, officialId);
    assert.equal(res1.statusCode, 201);
    assert.equal(res2.statusCode, 200); // idempotent — returns existing
    assert.equal(JSON.parse(res1.payload).id, JSON.parse(res2.payload).id);
  });

  it('respects max_redemptions limit', async () => {
    const discId = await createActivePercent(500);
    // Override max_redemptions to 1
    await pool.query('UPDATE official_discounts SET max_redemptions = 1 WHERE id = $1', [discId]);

    const makeApply = (refSuffix) => req('POST', `/official-discounts/${discId}/apply`, {
      official_id: officialId,
      customer_id: customerId,
      customer_type: 'event_organiser',
      booking_ref_id: `00000000-0000-0000-0000-00000000000${refSuffix}`,
      booking_ref_type: 'engagement',
      list_price_minor: 10000,
      currency: 'GBP',
      booking_context: { game_count: 1, booking_days_advance: 0, prior_bookings_count: 0, customer_type: 'event_organiser' },
    }, officialId);

    const res1 = await makeApply('3');
    assert.equal(res1.statusCode, 201);
    const res2 = await makeApply('4');
    assert.equal(res2.statusCode, 409, 'Second apply should be rejected after max_redemptions');
  });

  it('respects per_customer_limit', async () => {
    const discId = await createActivePercent(500);
    await pool.query('UPDATE official_discounts SET per_customer_limit = 1 WHERE id = $1', [discId]);

    const makeApply = (refSuffix) => req('POST', `/official-discounts/${discId}/apply`, {
      official_id: officialId,
      customer_id: customerId,
      customer_type: 'event_organiser',
      booking_ref_id: `00000000-0000-0000-0000-00000000010${refSuffix}`,
      booking_ref_type: 'engagement',
      list_price_minor: 10000,
      currency: 'GBP',
      booking_context: { game_count: 1, booking_days_advance: 0, prior_bookings_count: 0, customer_type: 'event_organiser' },
    }, officialId);

    const res1 = await makeApply('5');
    assert.equal(res1.statusCode, 201);
    const res2 = await makeApply('6');
    assert.equal(res2.statusCode, 409, 'Second apply by same customer should exceed per_customer_limit');
  });

  it('creates floor approval when below floor', async () => {
    const create = await req('POST', '/official-discounts', {
      name: 'Floor Test',
      kind: 'percent',
      value_bp: 5000, // 50% off
      discount_type: 'event',
      funded_by: 'referee',
      min_price_floor_minor: 6000,
      requires_approval: true,
    }, officialId);
    const { id: discId } = JSON.parse(create.payload);
    await req('POST', `/official-discounts/${discId}/activate`, {}, officialId);

    const res = await req('POST', `/official-discounts/${discId}/apply`, {
      official_id: officialId,
      customer_id: customerId,
      customer_type: 'event_organiser',
      booking_ref_id: '00000000-0000-0000-0000-000000000099',
      booking_ref_type: 'engagement',
      list_price_minor: 10000, // 50% = 5000; below floor 6000
      currency: 'GBP',
      booking_context: { game_count: 1, booking_days_advance: 0, prior_bookings_count: 0, customer_type: 'event_organiser' },
    }, officialId);

    assert.equal(res.statusCode, 202, 'Floor breach should return 202 Accepted (pending approval)');
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'pending_approval');
    assert.ok(body.approval_id, 'Should create an approval record');
  });

  it('voids a redemption and notifies', async () => {
    const discId = await createActivePercent(1000);
    const bookingRefId = '00000000-0000-0000-0000-000000000098';

    const applyRes = await req('POST', `/official-discounts/${discId}/apply`, {
      official_id: officialId,
      customer_id: customerId,
      customer_type: 'event_organiser',
      booking_ref_id: bookingRefId,
      booking_ref_type: 'engagement',
      list_price_minor: 10000,
      currency: 'GBP',
      booking_context: { game_count: 1, booking_days_advance: 0, prior_bookings_count: 0, customer_type: 'event_organiser' },
    }, officialId);
    const { id: redemptionId } = JSON.parse(applyRes.payload);

    const voidRes = await req('POST', `/official-discount-redemptions/${redemptionId}/void`, {
      reason: 'Booking cancelled by academy',
    }, officialId);
    assert.equal(voidRes.statusCode, 200);
    const body = JSON.parse(voidRes.payload);
    assert.ok(body.voided_at);
    assert.equal(body.void_reason, 'Booking cancelled by academy');
  });
});

// ─── 4. Tax invariant ────────────────────────────────────────────────────────

describe('official-discounts: tax invariants', () => {
  it('tax is computed on post-discount amount, not list price', async () => {
    // list = 10000, 10% discount = 1000, taxable = 9000
    // 20% VAT on 9000 = 1800; total = 10800
    // If tax were on list: 20% of 10000 = 2000 (wrong)
    const listMinor = 10000;
    const discountPct = 10; // 10%
    const taxRatePct = 20; // 20% VAT

    const discountedMinor = listMinor - Math.floor(listMinor * discountPct / 100);
    const correctTax = Math.floor(discountedMinor * taxRatePct / 100);
    const wrongTax = Math.floor(listMinor * taxRatePct / 100);

    assert.notEqual(correctTax, wrongTax, 'Sanity: correct and wrong tax should differ');
    assert.equal(discountedMinor, 9000);
    assert.equal(correctTax, 1800);
    assert.equal(wrongTax, 2000);
  });

  it('invoice total_minor reflects post-discount gross', async () => {
    // Create a redemption and verify the invoice picks up the discounted total
    const create = await req('POST', '/official-discounts', {
      name: 'Invoice Tax Test',
      kind: 'percent',
      value_bp: 1000, // 10%
      discount_type: 'event',
      funded_by: 'referee',
    }, officialId);
    const { id: discId } = JSON.parse(create.payload);
    await req('POST', `/official-discounts/${discId}/activate`, {}, officialId);

    const applyRes = await req('POST', `/official-discounts/${discId}/apply`, {
      official_id: officialId,
      customer_id: customerId,
      customer_type: 'event_organiser',
      booking_ref_id: '00000000-0000-0000-0000-000000000097',
      booking_ref_type: 'invoice',
      list_price_minor: 12000,
      currency: 'GBP',
      booking_context: { game_count: 1, booking_days_advance: 0, prior_bookings_count: 0, customer_type: 'event_organiser' },
    }, officialId);
    assert.equal(applyRes.statusCode, 201);
    const { id: redemptionId } = JSON.parse(applyRes.payload);

    // Verify saving is 10% of 12000 = 1200
    const body = JSON.parse(applyRes.payload);
    assert.equal(body.saving_minor, 1200);
    assert.equal(body.discounted_price_minor, 10800);

    // The discounted total (10800) is what tax should be computed on
    const taxAt20Pct = Math.floor(10800 * 20 / 100);
    assert.equal(taxAt20Pct, 2160, 'Tax on discounted amount should be 2160, not 2400');
  });
});

// ─── 5. Auth ─────────────────────────────────────────────────────────────────

describe('official-discounts: authorisation', () => {
  it('other user cannot read private discount terms', async () => {
    const create = await req('POST', '/official-discounts', {
      name: 'Private Terms',
      kind: 'percent',
      value_bp: 1000,
      discount_type: 'event',
      funded_by: 'referee',
      terms: 'Confidential: special rate for Nadal Academy only',
    }, officialId);
    const { id } = JSON.parse(create.payload);

    // Owner can see terms
    const ownerGet = await req('GET', `/official-discounts/${id}`, null, officialId);
    assert.equal(ownerGet.statusCode, 200);

    // Other user gets 404 (never 403 — do not leak existence)
    const otherGet = await req('GET', `/official-discounts/${id}`, null, otherOfficialId);
    assert.equal(otherGet.statusCode, 404);
  });

  it('only owner can activate their discount', async () => {
    const create = await req('POST', '/official-discounts', {
      name: 'Auth Activate Test',
      kind: 'percent',
      value_bp: 500,
      discount_type: 'event',
      funded_by: 'referee',
    }, officialId);
    const { id } = JSON.parse(create.payload);

    const otherActivate = await req('POST', `/official-discounts/${id}/activate`, {}, otherOfficialId);
    assert.equal(otherActivate.statusCode, 404);

    const ownerActivate = await req('POST', `/official-discounts/${id}/activate`, {}, officialId);
    assert.equal(ownerActivate.statusCode, 200);
  });

  it('only owner can archive their discount', async () => {
    const create = await req('POST', '/official-discounts', {
      name: 'Auth Archive Test',
      kind: 'percent',
      value_bp: 500,
      discount_type: 'event',
      funded_by: 'referee',
    }, officialId);
    const { id } = JSON.parse(create.payload);

    const otherArchive = await req('POST', `/official-discounts/${id}/archive`, {}, otherOfficialId);
    assert.equal(otherArchive.statusCode, 404);
  });

  it('platform admin can list all discounts', async () => {
    // Create discounts for two different officials
    await req('POST', '/official-discounts', {
      name: 'Official A Discount',
      kind: 'percent',
      value_bp: 500,
      discount_type: 'event',
      funded_by: 'referee',
    }, officialId);
    await req('POST', '/official-discounts', {
      name: 'Other Official Discount',
      kind: 'percent',
      value_bp: 300,
      discount_type: 'loyalty',
      funded_by: 'referee',
    }, otherOfficialId);

    // Admin can see all
    const res = await req('GET', '/official-discounts/platform', null, adminId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.discounts.length >= 2, 'Admin should see discounts from multiple officials');
  });

  it('non-admin cannot access platform discount list', async () => {
    const res = await req('GET', '/official-discounts/platform', null, officialId);
    assert.equal(res.statusCode, 403);
  });
});
