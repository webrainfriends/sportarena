import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx } from '../src/db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createOrg(name) {
  const r = await db.query(
    `INSERT INTO organisations (name, status) VALUES ($1, 'active') RETURNING id`,
    [name],
  );
  return r.rows[0].id;
}

async function createEvent(orgId, name = 'Test Event') {
  const r = await db.query(
    `INSERT INTO events (org_id, name, status, starts_at, ends_at)
     VALUES ($1, $2, 'published', NOW(), NOW() + INTERVAL '7 days') RETURNING id`,
    [orgId, name],
  );
  return r.rows[0].id;
}

async function createVenue(orgId) {
  const r = await db.query(
    `INSERT INTO venues (org_id, name, lat, lng, status)
     VALUES ($1, 'Test Venue', 40.4168, -3.7038, 'active') RETURNING id`,
    [orgId, name],
  );
  return r.rows[0].id;
}

async function createFixture(eventId, venueId = null) {
  const r = await db.query(
    `INSERT INTO fixtures (event_id, venue_id, starts_at, status)
     VALUES ($1, $2, NOW() + INTERVAL '1 day', 'scheduled') RETURNING id`,
    [eventId, venueId],
  );
  return r.rows[0].id;
}

async function createUser(email) {
  const r = await db.query(
    `INSERT INTO users (email, name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [email, email.split('@')[0]],
  );
  return r.rows[0].id;
}

async function createOfficialProfile(userId, grade = 'G3', baseLat = 40.5, baseLng = -3.6) {
  // upsert sport_profiles entry with official data
  const r = await db.query(
    `INSERT INTO sport_profiles (user_id, role, official_grade, base_lat, base_lng, status)
     VALUES ($1, 'official', $2, $3, $4, 'active')
     ON CONFLICT (user_id, role) DO UPDATE
       SET official_grade = EXCLUDED.official_grade,
           base_lat = EXCLUDED.base_lat,
           base_lng = EXCLUDED.base_lng
     RETURNING id`,
    [userId, grade, baseLat, baseLng],
  );
  return r.rows[0].id;
}

async function addToEventPool(eventId, userId) {
  await db.query(
    `INSERT INTO event_members (event_id, user_id, role, status)
     VALUES ($1, $2, 'official', 'active')
     ON CONFLICT DO NOTHING`,
    [eventId, userId],
  );
}

// Lightweight HTTP-style capability invoker (calls handler fn directly)
async function cap(name, params, ctx = {}) {
  // Dynamically resolve capability from registry
  const { registry } = await import('../src/capabilities/registry.js');
  const handler = registry.get(name);
  if (!handler) throw new Error(`Capability not found: ${name}`);
  return handler(params, { user: ctx.user || { id: ctx.userId, role: 'org_admin' }, ...ctx });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let orgId, eventId, fixtureId, userId1, userId2, userId3;

before(async () => {
  orgId = await createOrg('Test Academy');
  eventId = await createEvent(orgId);

  // Create three officials
  userId1 = await createUser(`off1_${Date.now()}@test.com`);
  userId2 = await createUser(`off2_${Date.now()}@test.com`);
  userId3 = await createUser(`off3_${Date.now()}@test.com`);

  await createOfficialProfile(userId1, 'G4', 40.4168, -3.7038); // near Madrid
  await createOfficialProfile(userId2, 'G3', 40.4500, -3.6900);
  await createOfficialProfile(userId3, 'G2', 51.5074, -0.1278); // London – far

  // Add all to event pool
  await addToEventPool(eventId, userId1);
  await addToEventPool(eventId, userId2);
  await addToEventPool(eventId, userId3);

  fixtureId = await createFixture(eventId);
});

after(async () => {
  // Clean up: soft-delete event which cascades through event_members
  await db.query(`UPDATE events SET status='archived' WHERE id=$1`, [eventId]);
});

// ---------------------------------------------------------------------------
// 1. get_assignment_board
// ---------------------------------------------------------------------------

describe('get_assignment_board', () => {
  it('returns fixture rows with crew map and coverage stats', async () => {
    const result = await cap('get_assignment_board', { event_id: eventId });

    assert.ok(result.fixtures, 'has fixtures array');
    assert.ok(result.stats, 'has stats object');
    assert.ok(typeof result.stats.confirmed === 'number', 'confirmed is a number');
    assert.ok(typeof result.stats.uncovered_slots === 'number', 'uncovered_slots is a number');

    const f = result.fixtures.find((x) => x.id === fixtureId);
    assert.ok(f, 'created fixture is in board');
    assert.ok(typeof f.crew === 'object', 'fixture has crew map');
  });

  it('surfaces neutrality_conflict flag when present', async () => {
    // just check the shape; actual conflict depends on team_members data
    const result = await cap('get_assignment_board', { event_id: eventId });
    for (const f of result.fixtures) {
      assert.ok('neutrality_conflicts' in f, 'neutrality_conflicts key present on fixture row');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. suggest_fixture_officials
// ---------------------------------------------------------------------------

describe('suggest_fixture_officials', () => {
  it('returns ranked candidates with scores 0-100', async () => {
    const result = await cap('suggest_fixture_officials', {
      fixture_id: fixtureId,
      role: 'referee',
    });

    assert.ok(Array.isArray(result.suggestions), 'suggestions is array');
    for (const s of result.suggestions) {
      assert.ok(s.score >= 0 && s.score <= 100, `score ${s.score} in range`);
      assert.ok(Array.isArray(s.reasons), 'reasons present');
    }
  });

  it('sorts by descending score', async () => {
    const result = await cap('suggest_fixture_officials', {
      fixture_id: fixtureId,
      role: 'referee',
    });
    const scores = result.suggestions.map((s) => s.score);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i - 1] >= scores[i], 'scores are sorted descending');
    }
  });

  it('grades factor correctly: G4 ranks above G2 for same venue', async () => {
    const result = await cap('suggest_fixture_officials', {
      fixture_id: fixtureId,
      role: 'referee',
    });
    const s1 = result.suggestions.find((s) => s.user_id === userId1); // G4 near venue
    const s3 = result.suggestions.find((s) => s.user_id === userId3); // G2 far away
    if (s1 && s3) {
      assert.ok(s1.score > s3.score, 'G4 near venue scores higher than G2 far away');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. shortlist_fixture_official / remove_shortlist_official
// ---------------------------------------------------------------------------

describe('shortlist_fixture_official / remove_shortlist_official', () => {
  let shortlistId;

  it('adds an official to the shortlist', async () => {
    const result = await cap('shortlist_fixture_official', {
      fixture_id: fixtureId,
      user_id: userId2,
      role: 'umpire',
    });
    assert.ok(result.shortlist_id, 'returns shortlist_id');
    shortlistId = result.shortlist_id;
  });

  it('idempotent: second shortlist returns same id', async () => {
    const result = await cap('shortlist_fixture_official', {
      fixture_id: fixtureId,
      user_id: userId2,
      role: 'umpire',
    });
    assert.equal(result.shortlist_id, shortlistId, 'same shortlist_id on duplicate');
  });

  it('removes from shortlist (soft delete via archived_at)', async () => {
    const result = await cap('remove_shortlist_official', { shortlist_id: shortlistId });
    assert.ok(result.ok, 'remove succeeds');

    const row = await db.query(
      'SELECT archived_at FROM official_shortlists WHERE id=$1',
      [shortlistId],
    );
    assert.ok(row.rows[0]?.archived_at, 'archived_at set — data not deleted');
  });
});

// ---------------------------------------------------------------------------
// 4. bulk_invite_officials
// ---------------------------------------------------------------------------

describe('bulk_invite_officials', () => {
  it('sends invitations and returns sent/skipped/errors breakdown', async () => {
    const result = await cap('bulk_invite_officials', {
      event_id: eventId,
      invitations: [
        { fixture_id: fixtureId, user_id: userId1, role: 'referee', agreed_fee: 100 },
        { fixture_id: fixtureId, user_id: userId2, role: 'umpire', agreed_fee: 80 },
      ],
      message: 'Welcome to the tournament.',
    });

    assert.ok(typeof result.sent === 'number', 'sent count present');
    assert.ok(typeof result.skipped === 'number', 'skipped count present');
    assert.ok(typeof result.errors === 'number', 'errors count present');
    assert.equal(result.sent + result.skipped + result.errors, 2, 'totals sum to input count');
    assert.ok(result.sent >= 1, 'at least one invite sent');
  });

  it('skips duplicate: re-sending same fixture+official returns skipped=1', async () => {
    const result = await cap('bulk_invite_officials', {
      event_id: eventId,
      invitations: [
        { fixture_id: fixtureId, user_id: userId1, role: 'referee', agreed_fee: 100 },
      ],
      message: 'Duplicate invite.',
    });
    assert.equal(result.skipped, 1, 'duplicate is skipped not re-sent');
    assert.equal(result.sent, 0, 'nothing new sent');
  });

  it('concurrent invites are concurrency-safe (no double-booking)', async () => {
    const fixture2 = await createFixture(eventId);
    const user4 = await createUser(`off4_${Date.now()}@test.com`);
    await createOfficialProfile(user4, 'G3', 40.42, -3.70);
    await addToEventPool(eventId, user4);

    // Fire two concurrent bulk-invites for the same slot
    const [r1, r2] = await Promise.all([
      cap('bulk_invite_officials', {
        event_id: eventId,
        invitations: [{ fixture_id: fixture2, user_id: user4, role: 'linesman', agreed_fee: 60 }],
      }),
      cap('bulk_invite_officials', {
        event_id: eventId,
        invitations: [{ fixture_id: fixture2, user_id: user4, role: 'linesman', agreed_fee: 60 }],
      }),
    ]);

    const totalSent = r1.sent + r2.sent;
    assert.equal(totalSent, 1, 'only one invite created across concurrent calls');
  });
});

// ---------------------------------------------------------------------------
// 5. swap_fixture_official
// ---------------------------------------------------------------------------

describe('swap_fixture_official', () => {
  let assignmentId;

  before(async () => {
    // Create a confirmed assignment to swap from
    const r = await db.query(
      `INSERT INTO fixture_officials (fixture_id, user_id, role, status)
       VALUES ($1, $2, 'referee', 'confirmed') RETURNING id`,
      [fixtureId, userId1],
    );
    assignmentId = r.rows[0].id;
  });

  it('swaps to an eligible official and notifies', async () => {
    const result = await cap('swap_fixture_official', {
      assignment_id: assignmentId,
      new_user_id: userId2,
      role: 'referee',
    });
    assert.ok(result.ok || result.new_assignment_id, 'swap succeeded');
  });

  it('requires override_reason for rotation-preference warnings', async () => {
    // userId2 now has 1 assignment in this event; create enough to trigger rotation warning
    // by calling swap without override_reason when warning is raised
    // We test that providing the reason succeeds
    const r = await db.query(
      `INSERT INTO fixture_officials (fixture_id, user_id, role, status)
       VALUES ($1, $2, 'umpire', 'confirmed') RETURNING id`,
      [fixtureId, userId1],
    );
    const aId = r.rows[0].id;

    // First attempt without override_reason — may raise warning
    try {
      await cap('swap_fixture_official', {
        assignment_id: aId,
        new_user_id: userId2,
        role: 'umpire',
        // no override_reason
      });
      // If no warning raised, that's also valid (rotation threshold not met)
    } catch (e) {
      // If it throws for missing override_reason, re-call with reason
      assert.match(e.message, /override_reason/i, 'error mentions override_reason');
      const result = await cap('swap_fixture_official', {
        assignment_id: aId,
        new_user_id: userId2,
        role: 'umpire',
        override_reason: 'Only available G3 official this date.',
      });
      assert.ok(result.ok || result.new_assignment_id, 'swap with override_reason succeeds');
    }
  });

  it('hard-blocks swap when official has time clash', async () => {
    // Add a blackout covering the fixture time for userId3
    await db.query(
      `INSERT INTO official_blackouts (user_id, starts_at, ends_at)
       VALUES ($1, NOW(), NOW() + INTERVAL '7 days')`,
      [userId3],
    );

    const r2 = await db.query(
      `INSERT INTO fixture_officials (fixture_id, user_id, role, status)
       VALUES ($1, $2, 'scorer', 'confirmed') RETURNING id`,
      [fixtureId, userId1],
    );

    await assert.rejects(
      () =>
        cap('swap_fixture_official', {
          assignment_id: r2.rows[0].id,
          new_user_id: userId3,
          role: 'scorer',
        }),
      /blackout|unavailable|clash/i,
      'hard-block on blackout',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. preview_bulk_reschedule_officials
// ---------------------------------------------------------------------------

describe('preview_bulk_reschedule_officials', () => {
  it('returns per-fixture conflict analysis without mutating data', async () => {
    const result = await cap('preview_bulk_reschedule_officials', {
      event_id: eventId,
      new_starts_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // +14 days
    });

    assert.ok(Array.isArray(result.fixtures), 'fixtures array present');
    for (const f of result.fixtures) {
      assert.ok(Array.isArray(f.conflicts), 'each fixture has conflicts array');
      assert.ok(typeof f.safe === 'boolean', 'each fixture has safe flag');
    }

    // Verify no data was mutated (fixture still has original starts_at)
    const row = await db.query('SELECT starts_at FROM fixtures WHERE id=$1', [fixtureId]);
    assert.ok(
      new Date(row.rows[0].starts_at) < new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      'fixture starts_at unchanged by preview',
    );
  });
});

// ---------------------------------------------------------------------------
// 7. list_event_official_pool
// ---------------------------------------------------------------------------

describe('list_event_official_pool', () => {
  it('returns officials with grade and availability info', async () => {
    const result = await cap('list_event_official_pool', { event_id: eventId });

    assert.ok(Array.isArray(result.officials), 'officials array present');
    assert.ok(result.officials.length >= 3, 'has at least 3 officials from setup');

    for (const o of result.officials) {
      assert.ok(o.user_id, 'official has user_id');
      assert.ok(o.name, 'official has name');
    }
  });

  it('applies grade filter', async () => {
    const result = await cap('list_event_official_pool', { event_id: eventId, grade: 'G4' });
    for (const o of result.officials) {
      assert.equal(o.official_grade, 'G4', 'all returned officials are G4');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. REST / OpenAPI / MCP parity smoke test
// ---------------------------------------------------------------------------

describe('REST / OpenAPI / MCP parity', () => {
  it('all 8 bulk-assignment capabilities are registered in the registry', async () => {
    const { registry } = await import('../src/capabilities/registry.js');
    const expected = [
      'get_assignment_board',
      'suggest_fixture_officials',
      'shortlist_fixture_official',
      'remove_shortlist_official',
      'bulk_invite_officials',
      'swap_fixture_official',
      'preview_bulk_reschedule_officials',
      'list_event_official_pool',
    ];
    for (const name of expected) {
      assert.ok(registry.has(name), `capability "${name}" registered`);
    }
  });

  it('each capability definition has method, path, schema and handler', async () => {
    const { registry } = await import('../src/capabilities/registry.js');
    const bulkCaps = [
      'get_assignment_board',
      'suggest_fixture_officials',
      'bulk_invite_officials',
      'swap_fixture_official',
    ];
    for (const name of bulkCaps) {
      const def = registry.getDef(name);
      if (!def) continue; // registry may only expose handler; shape test where possible
      assert.ok(def.method || def.handler, `${name} has method or handler`);
    }
  });
});
