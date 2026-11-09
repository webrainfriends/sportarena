// Tests for official rate card service catalog (#1015 R34).
// Covers: CRUD lifecycle, draft→active versioning, quote calculator, privacy, MCP/REST parity, race conditions.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';

let app, adminToken, refereeToken, organiserToken, profileId;

// Minimal test helpers
const req = (method, path, body, token) =>
  app.inject({ method, url: `/api${path}`, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body ?? undefined });
const json = (r) => JSON.parse(r.body);

before(async () => {
  app = await buildApp({ testing: true });

  // Create a referee user and official profile
  const rr = json(await req('POST', '/auth/register', { email: 'rctest.ref@test.invalid', password: 'Test1234!', display_name: 'RC Referee' }));
  refereeToken = rr.token;
  // Approve user
  await pool.query("UPDATE users SET status='approved' WHERE email='rctest.ref@test.invalid'");

  // Create official profile (step 1 auto-creates)
  await req('PUT', '/me/official-profile/identity', { display_name_pref: null }, refereeToken);
  const p = json(await req('GET', '/me/official-profile', {}, refereeToken));
  profileId = p?.id;

  // Create an organiser user
  const or = json(await req('POST', '/auth/register', { email: 'rctest.org@test.invalid', password: 'Test1234!', display_name: 'RC Organiser' }));
  organiserToken = or.token;
  await pool.query("UPDATE users SET status='approved' WHERE email='rctest.org@test.invalid'");
});

after(async () => {
  await pool.query("DELETE FROM users WHERE email IN ('rctest.ref@test.invalid','rctest.org@test.invalid')");
  await app.close();
});

describe('Rate card CRUD', () => {
  let draftId, activeId;

  it('creates a draft rate card', async () => {
    const r = await req('POST', '/me/official-profile/rate-cards', {
      name: 'Elite Football Referee',
      service_type: 'match',
      fee_minor: 16500,
      fee_currency: 'GBP',
      weekend_sat_pct: 15,
      weekend_sun_pct: 20,
      holiday_pct: 25,
      overtime_rate_minor: 2800,
      min_fee_minor: 12000,
      deposit_type: 'pct',
      deposit_pct: 20,
      tax_inclusive: true,
      is_indicative: true,
      private_notes: 'Premier League only',
      status: 'draft',
    }, refereeToken);
    assert.equal(r.statusCode, 201);
    const body = json(r);
    assert.equal(body.status, 'draft');
    assert.equal(body.version_number, 1);
    assert.equal(body.fee_minor, 16500);
    assert.equal(body.private_notes, 'Premier League only', 'private notes decrypted for owner');
    draftId = body.id;
  });

  it('activates a draft rate card', async () => {
    const r = await req('POST', `/me/official-profile/rate-cards/${draftId}/activate`, {}, refereeToken);
    assert.equal(r.statusCode, 200);
    const body = json(r);
    assert.equal(body.status, 'active');
    activeId = draftId;
  });

  it('idempotent activate on already-active card', async () => {
    const r = await req('POST', `/me/official-profile/rate-cards/${activeId}/activate`, {}, refereeToken);
    assert.equal(r.statusCode, 200);
    assert.equal(json(r).status, 'active');
  });

  it('editing an active card creates a new draft version', async () => {
    const r = await req('PUT', `/me/official-profile/rate-cards/${activeId}`, { id: activeId, fee_minor: 17500, fee_currency: 'GBP' }, refereeToken);
    assert.equal(r.statusCode, 200);
    const body = json(r);
    assert.equal(body.status, 'draft', 'returns new draft');
    assert.equal(body.version_number, 2, 'version incremented');
    assert.equal(body.fee_minor, 17500);
    assert.equal(body._versioned, true);
    assert.equal(body._previous_id, activeId, 'previous card id returned');
    // Old card should be archived
    const catalog = json(await req('GET', '/me/official-profile/rate-cards/catalog', {}, refereeToken));
    const old = catalog.find((c) => c.id === activeId);
    assert.equal(old?.status, 'archived', 'old version archived');
    draftId = body.id;
  });

  it('cannot edit archived card', async () => {
    const r = await req('PUT', `/me/official-profile/rate-cards/${activeId}`, { id: activeId, fee_minor: 999, fee_currency: 'GBP' }, refereeToken);
    assert.equal(r.statusCode, 400);
  });

  it('duplicates a rate card as new draft', async () => {
    const r = await req('POST', `/me/official-profile/rate-cards/${draftId}/duplicate`, {}, refereeToken);
    assert.equal(r.statusCode, 201);
    const body = json(r);
    assert.equal(body.status, 'draft');
    assert.equal(body.version_number, 1);
    assert(body.name.includes('(copy)'), 'name has copy suffix');
  });

  it('deactivates an active card', async () => {
    // Activate the draft first
    await req('POST', `/me/official-profile/rate-cards/${draftId}/activate`, {}, refereeToken);
    const r = await req('POST', `/me/official-profile/rate-cards/${draftId}/deactivate`, {}, refereeToken);
    assert.equal(r.statusCode, 200);
    assert.equal(json(r).status, 'archived');
  });
});

describe('Public catalog privacy', () => {
  let pubCardId;

  before(async () => {
    // Publish the official profile first so public endpoint works
    await pool.query("UPDATE official_profiles SET status='published' WHERE id=$1", [profileId]);
    const r = json(await req('POST', '/me/official-profile/rate-cards', {
      name: 'Public Test Card',
      service_type: 'match',
      fee_minor: 10000,
      fee_currency: 'GBP',
      is_indicative: true,
      private_notes: 'SECRET NOTES',
      status: 'active',
    }, refereeToken));
    pubCardId = r.id;
  });

  it('public catalog returns only active + indicative cards', async () => {
    // Create a private (non-indicative) active card
    await req('POST', '/me/official-profile/rate-cards', {
      name: 'Private Card',
      fee_minor: 5000,
      fee_currency: 'GBP',
      is_indicative: false,
      status: 'active',
    }, refereeToken);
    // Create a draft card
    await req('POST', '/me/official-profile/rate-cards', {
      name: 'Draft Card',
      fee_minor: 3000,
      fee_currency: 'GBP',
      is_indicative: true,
      status: 'draft',
    }, refereeToken);

    const r = await req('GET', `/official-profiles/${profileId}/rate-cards`, {}, organiserToken);
    assert.equal(r.statusCode, 200);
    const cards = json(r);
    assert(cards.every((c) => c.status === 'active'), 'only active cards');
    assert(cards.every((c) => c.is_indicative), 'only indicative cards');
  });

  it('private notes never appear in public catalog', async () => {
    const r = json(await req('GET', `/official-profiles/${profileId}/rate-cards`, {}, organiserToken));
    const pub = r.find((c) => c.id === pubCardId);
    assert(pub, 'public card present');
    assert.equal(pub.private_notes, undefined, 'private_notes not exposed');
    assert.equal(pub.private_notes_enc, undefined, 'private_notes_enc not exposed');
  });

  it('owner sees private notes decrypted', async () => {
    const catalog = json(await req('GET', '/me/official-profile/rate-cards/catalog', {}, refereeToken));
    const mine = catalog.find((c) => c.id === pubCardId);
    assert(mine, 'found in owner catalog');
    assert.equal(mine.private_notes, 'SECRET NOTES');
  });
});

describe('Quote calculator', () => {
  let calcCardId;

  before(async () => {
    await pool.query("UPDATE official_profiles SET status='published' WHERE id=$1", [profileId]);
    const r = json(await req('POST', '/me/official-profile/rate-cards', {
      name: 'Calc Test Card',
      service_type: 'match',
      fee_minor: 16500,
      fee_currency: 'GBP',
      weekend_sat_pct: 15,
      weekend_sun_pct: 20,
      holiday_pct: 25,
      overtime_rate_minor: 2800,
      min_fee_minor: 0,
      deposit_type: 'pct',
      deposit_pct: 20,
      includes_travel: false,
      travel_allowance_per_km_minor: 45,
      travel_radius_km: 10,
      is_indicative: true,
      status: 'active',
    }, refereeToken));
    calcCardId = r.id;
  });

  it('weekday: returns base fee only', async () => {
    const r = await req('POST', `/official-profiles/${profileId}/rate-cards/${calcCardId}/quote`, {
      profileId,
      id: calcCardId,
      event_date: '2026-02-04', // Wednesday
      duration_min: 90,
      travel_km: 0,
      overtime_hrs: 0,
      is_holiday: false,
    });
    assert.equal(r.statusCode, 200);
    const q = json(r);
    assert.equal(q.total, 16500, 'weekday = base fee');
    assert.equal(q.lines.filter((l) => l.key === 'premium').length, 0, 'no premium line');
  });

  it('saturday: applies +15% weekend premium', async () => {
    const r = json(await req('POST', `/official-profiles/${profileId}/rate-cards/${calcCardId}/quote`, {
      profileId, id: calcCardId, event_date: '2026-02-07', // Saturday
      duration_min: 90, travel_km: 0, overtime_hrs: 0, is_holiday: false,
    }));
    const prem = r.lines.find((l) => l.key === 'premium');
    assert(prem, 'premium line present');
    assert.equal(r.total, Math.round(16500 * 1.15));
  });

  it('bank holiday: applies +25% holiday premium', async () => {
    const r = json(await req('POST', `/official-profiles/${profileId}/rate-cards/${calcCardId}/quote`, {
      profileId, id: calcCardId, event_date: '2026-01-01',
      duration_min: 90, travel_km: 0, overtime_hrs: 0, is_holiday: true,
    }));
    const prem = r.lines.find((l) => l.key === 'premium');
    assert(prem, 'holiday premium line present');
    assert.equal(r.total, Math.round(16500 * 1.25));
  });

  it('overtime: adds overtime charges', async () => {
    const r = json(await req('POST', `/official-profiles/${profileId}/rate-cards/${calcCardId}/quote`, {
      profileId, id: calcCardId, event_date: '2026-02-04',
      duration_min: 90, travel_km: 0, overtime_hrs: 1.5, is_holiday: false,
    }));
    const ot = r.lines.find((l) => l.key === 'overtime');
    assert(ot, 'overtime line present');
    assert.equal(ot.amount, Math.round(1.5 * 2800));
  });

  it('travel: charges beyond free radius', async () => {
    const r = json(await req('POST', `/official-profiles/${profileId}/rate-cards/${calcCardId}/quote`, {
      profileId, id: calcCardId, event_date: '2026-02-04',
      duration_min: 90, travel_km: 35, overtime_hrs: 0, is_holiday: false,
    }));
    const travel = r.lines.find((l) => l.key === 'travel');
    assert(travel, 'travel line present');
    assert.equal(travel.amount, Math.round(25 * 45), '25 chargeable km (35-10 radius)');
  });

  it('deposit: 20% of total', async () => {
    const r = json(await req('POST', `/official-profiles/${profileId}/rate-cards/${calcCardId}/quote`, {
      profileId, id: calcCardId, event_date: '2026-02-04',
      duration_min: 90, travel_km: 0, overtime_hrs: 0, is_holiday: false,
    }));
    assert.equal(r.deposit_amount, Math.round(r.total * 0.20));
  });

  it('REST and MCP parity: same quote from both', async () => {
    const payload = { profileId, id: calcCardId, event_date: '2026-02-07', duration_min: 90, travel_km: 10, overtime_hrs: 0, is_holiday: false };
    const rest = json(await req('POST', `/official-profiles/${profileId}/rate-cards/${calcCardId}/quote`, payload));
    // MCP call via /mcp route
    const mcp = json(await req('POST', '/mcp', { tool: 'calculate_quote', input: payload }));
    assert.deepEqual(rest.total, mcp.result?.total ?? mcp.total, 'REST and MCP totals match');
  });
});

describe('Race condition: simultaneous activate', () => {
  it('two concurrent activates on the same draft are idempotent (no duplicate active)', async () => {
    const draft = json(await req('POST', '/me/official-profile/rate-cards', {
      name: 'Race Card', fee_minor: 5000, fee_currency: 'GBP', status: 'draft',
    }, refereeToken));
    const id = draft.id;
    // Fire two simultaneous activate calls
    const [r1, r2] = await Promise.all([
      req('POST', `/me/official-profile/rate-cards/${id}/activate`, {}, refereeToken),
      req('POST', `/me/official-profile/rate-cards/${id}/activate`, {}, refereeToken),
    ]);
    assert(r1.statusCode === 200 || r2.statusCode === 200, 'at least one succeeds');
    // Catalog should have exactly one active card with this id
    const catalog = json(await req('GET', '/me/official-profile/rate-cards/catalog', {}, refereeToken));
    const active = catalog.filter((c) => c.id === id && c.status === 'active');
    assert.equal(active.length, 1, 'exactly one active version');
  });
});

describe('i18n catalogue', () => {
  it('rc.* keys exist in en.js', async () => {
    const { default: en } = await import('../../../apps/app/src/i18n/en.js', { assert: { type: 'json' } }).catch(() => import('../../app/src/i18n/en.js'));
    assert(en['rc.title'], 'rc.title present');
    assert(en['rc.quote_title'], 'rc.quote_title present');
    assert(en['rc.breakdown_total'], 'rc.breakdown_total present');
  });
});
