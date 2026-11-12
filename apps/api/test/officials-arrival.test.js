// Tests for R21: Officials Arrival & Venue Logistics (Issue #1013)
// Covers: dispatch, get, check-in (all methods), late report, status list, consent

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { createTestFixture, createTestUser, cleanupFixture } from './helpers.js';

let organiser, official1, official2, fixtureId, official1AssignmentId;

before(async () => {
  organiser = await createTestUser({ role: 'organiser' });
  official1 = await createTestUser({ role: 'official' });
  official2 = await createTestUser({ role: 'official' });
  fixtureId = await createTestFixture({
    organiser_id: organiser.id,
    scheduled_at: new Date(Date.now() + 90 * 60_000).toISOString(), // 90 min from now
  });

  // Accept official1 on the fixture
  const { rows } = await pool.query(
    `INSERT INTO fixture_officials (fixture_id, user_id, role, status)
     VALUES ($1, $2, 'referee', 'accepted') RETURNING id`,
    [fixtureId, official1.id],
  );
  official1AssignmentId = rows[0].id;
});

after(async () => {
  if (fixtureId) await cleanupFixture(fixtureId);
  if (organiser) await pool.query('DELETE FROM users WHERE id=$1', [organiser.id]);
  if (official1) await pool.query('DELETE FROM users WHERE id=$1', [official1.id]);
  if (official2) await pool.query('DELETE FROM users WHERE id=$1', [official2.id]);
});

describe('dispatch_fixture_logistics', () => {
  it('organiser can dispatch logistics and generates check-in codes', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/logistics`, {
      method: 'POST',
      headers: { 'x-test-user': organiser.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parking_notes: 'East car park, Level 2',
        gate_instructions: 'Gate 7 — show official ID',
        official_room: 'Room 12, East Stand',
        check_in_deadline_min: 25,
        emergency_contacts: [{ label: 'Head steward', phone: '+447700900000', role: 'Steward' }],
        equipment_checklist: [{ id: 'whistle', label: 'Whistle', required: true }],
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);

    // Verify check-in code was generated
    const { rows } = await pool.query(
      `SELECT check_in_code FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2`,
      [fixtureId, official1.id],
    );
    assert.ok(rows[0].check_in_code, 'check_in_code should be generated');
    assert.equal(rows[0].check_in_code.length, 8);
  });

  it('non-organiser cannot dispatch logistics', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/logistics`, {
      method: 'POST',
      headers: { 'x-test-user': official1.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ check_in_deadline_min: 20 }),
    });
    assert.equal(r.status, 404);
  });
});

describe('get_arrival_logistics', () => {
  it('accepted official sees logistics and their check-in code', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/logistics`, {
      headers: { 'x-test-user': official1.id },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.dispatched, true);
    assert.equal(body.parking_notes, 'East car park, Level 2');
    assert.ok(body.check_in_code, 'official should see their check-in code');
    assert.ok(body.equipment_checklist?.length > 0);
  });

  it('organiser sees logistics but no check-in code', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/logistics`, {
      headers: { 'x-test-user': organiser.id },
    });
    const body = await r.json();
    assert.equal(body.dispatched, true);
    assert.equal(body.check_in_code, null);
  });

  it('non-crew user cannot see logistics', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/logistics`, {
      headers: { 'x-test-user': official2.id },
    });
    assert.equal(r.status, 404);
  });
});

describe('check_in_official via manual_code', () => {
  let checkInCode;

  before(async () => {
    const { rows } = await pool.query(
      `SELECT check_in_code FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2`,
      [fixtureId, official1.id],
    );
    checkInCode = rows[0].check_in_code;
  });

  it('official checks in with correct code (on time)', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/check-in`, {
      method: 'POST',
      headers: { 'x-test-user': official1.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'manual_code', check_in_code: checkInCode }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.is_late, false);
    assert.equal(body.method, 'manual_code');
  });

  it('second check-in call is idempotent (returns existing record)', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/check-in`, {
      method: 'POST',
      headers: { 'x-test-user': official1.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'manual_code', check_in_code: checkInCode }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.already_checked_in, true);
  });

  it('wrong code is rejected', async () => {
    // Create a second official to test wrong code
    await pool.query(
      `INSERT INTO fixture_officials (fixture_id, user_id, role, status)
       VALUES ($1, $2, 'assistant', 'accepted') ON CONFLICT DO NOTHING`,
      [fixtureId, official2.id],
    );
    const r = await fetch(`/fixtures/${fixtureId}/check-in`, {
      method: 'POST',
      headers: { 'x-test-user': official2.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'manual_code', check_in_code: 'WRONGCODE' }),
    });
    assert.equal(r.status, 400);
  });

  after(async () => {
    // Clean up official2 check-in attempt
    await pool.query('DELETE FROM fixture_official_check_ins WHERE official_id=$1', [official2.id]);
  });
});

describe('check_in_official via geofence', () => {
  it('geofence rejected when consent not stored', async () => {
    // official2 has no consent row
    const r = await fetch(`/fixtures/${fixtureId}/check-in`, {
      method: 'POST',
      headers: { 'x-test-user': official2.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'geofence', location_consent: true }),
    });
    assert.equal(r.status, 400);
  });

  it('update_official_location_consent enables geofence', async () => {
    const r = await fetch('/officials/location-consent', {
      method: 'POST',
      headers: { 'x-test-user': official2.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ geofence_check_in: true }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.geofence_check_in, true);

    // Now geofence check-in should work for official2 (who has accepted assignment)
    const ci = await fetch(`/fixtures/${fixtureId}/check-in`, {
      method: 'POST',
      headers: { 'x-test-user': official2.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'geofence', location_consent: true }),
    });
    assert.equal(ci.status, 200);
  });

  it('geofence rejected when location_consent=false in request', async () => {
    // Reset for clean test
    await pool.query('DELETE FROM fixture_official_check_ins WHERE official_id=$1 AND fixture_id=$2', [official2.id, fixtureId]);
    const r = await fetch(`/fixtures/${fixtureId}/check-in`, {
      method: 'POST',
      headers: { 'x-test-user': official2.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'geofence', location_consent: false }),
    });
    assert.equal(r.status, 400);
  });

  after(async () => {
    await pool.query('DELETE FROM official_location_consent WHERE official_id=$1', [official2.id]);
    await pool.query('DELETE FROM fixture_official_check_ins WHERE official_id=$1', [official2.id]);
  });
});

describe('report_late_check_in', () => {
  let lateOfficial;

  before(async () => {
    lateOfficial = await createTestUser({ role: 'official' });
    await pool.query(
      `INSERT INTO fixture_officials (fixture_id, user_id, role, status)
       VALUES ($1, $2, 'fourth_official', 'accepted')`,
      [fixtureId, lateOfficial.id],
    );
  });

  after(async () => {
    if (lateOfficial) {
      await pool.query('DELETE FROM fixture_official_check_ins WHERE official_id=$1', [lateOfficial.id]);
      await pool.query('DELETE FROM fixture_officials WHERE user_id=$1 AND fixture_id=$2', [lateOfficial.id, fixtureId]);
      await pool.query('DELETE FROM users WHERE id=$1', [lateOfficial.id]);
    }
  });

  it('official self-reports late arrival with reason and ETA', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/late-report`, {
      method: 'POST',
      headers: { 'x-test-user': lateOfficial.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Train delayed at Waterloo', estimated_arrival_min: 20 }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);

    // Verify record
    const { rows } = await pool.query(
      `SELECT is_late, late_reason, estimated_arrival_min FROM fixture_official_check_ins
       WHERE fixture_id=$1 AND official_id=$2`,
      [fixtureId, lateOfficial.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_late, true);
    assert.equal(rows[0].late_reason, 'Train delayed at Waterloo');
    assert.equal(rows[0].estimated_arrival_min, 20);
  });
});

describe('list_arrival_status', () => {
  it('organiser sees all crew status', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/arrival-status`, {
      headers: { 'x-test-user': organiser.id },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.crew));
    const off1 = body.crew.find(m => m.official_id === official1.id);
    assert.ok(off1, 'official1 should appear in status list');
    assert.equal(off1.status, 'checked_in');
  });

  it('official cannot see the full status list', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/arrival-status`, {
      headers: { 'x-test-user': official1.id },
    });
    assert.equal(r.status, 404);
  });
});

describe('permission isolation', () => {
  it('official A cannot check in official B via organiser_manual without organiser role', async () => {
    const r = await fetch(`/fixtures/${fixtureId}/check-in`, {
      method: 'POST',
      headers: { 'x-test-user': official1.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'organiser_manual', official_id: official2.id }),
    });
    // Should fall back to checking in official1 themselves or fail — not official2
    if (r.status === 200) {
      const body = await r.json();
      // If 200, it must be for official1 (self), not official2
      const { rows } = await pool.query(
        `SELECT official_id FROM fixture_official_check_ins WHERE fixture_id=$1 AND official_id=$2`,
        [fixtureId, official2.id],
      );
      // official2 should NOT have been checked in by official1
      assert.equal(rows.length, 0, 'official1 must not be able to check in official2');
    }
    // 400/404 is also acceptable
  });
});
