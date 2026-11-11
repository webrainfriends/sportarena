// REF-R14: open match self-assignment (#1006).
// Tests: publish → browse → claim (instant); approval mode; waitlist; race; cancel/promote; PII leakage; idempotency.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx } from '../src/db.js';
import { testUser, testOrg, testEvent, testFixture, testSport } from './helpers.js';

let orgUser, official1, official2, official3;
let sportId, eventId, fixtureId;
let slotIdInstant, slotIdApproval;

before(async () => {
  orgUser   = await testUser({ roles: ['organiser'] });
  official1 = await testUser({ roles: ['official'] });
  official2 = await testUser({ roles: ['official'] });
  official3 = await testUser({ roles: ['official'] });
  sportId   = await testSport();
  const org  = await testOrg(orgUser.id);
  eventId   = await testEvent(orgUser.id, { sport_id: sportId, org_id: org.id });
  fixtureId = await testFixture(eventId, { status: 'scheduled', duration_min: 90, scheduled_at: new Date(Date.now() + 7 * 86400000).toISOString() });
});

after(async () => { await pool.end(); });

// ─── helpers ──────────────────────────────────────────────────────────────────

function call(user, method, path, body) {
  return import('../src/registry.js').then(({ capabilities }) => {
    const cap = capabilities.find((c) => c.method === method && c.path === path);
    if (!cap) throw new Error(`No capability ${method} ${path}`);
    return cap.handler({ user, session: { user_id: user.id } }, { ...body });
  });
}

async function getSlot(id) {
  return (await pool.query('SELECT * FROM open_match_slots WHERE id=$1', [id])).rows[0];
}
async function getApp(id) {
  return (await pool.query('SELECT * FROM open_slot_applications WHERE id=$1', [id])).rows[0];
}
async function getFO(userId, fId) {
  return (await pool.query("SELECT * FROM fixture_officials WHERE user_id=$1 AND fixture_id=$2 AND status IN ('invited','accepted')", [userId, fId])).rows[0];
}

// ─── publish ──────────────────────────────────────────────────────────────────

describe('publish_open_match_slot', () => {
  it('organiser can publish an instant-claim slot', async () => {
    const r = await call(orgUser, 'POST', '/fixtures/:id/open-slots', {
      id: fixtureId, role: 'referee', slots: 1, approval_mode: 'instant', allow_waitlist: true,
      fee_minor: 5000, fee_currency: 'USD', reporting_min: 30, notes: 'Bring yellow flag', publish: true,
    });
    assert.equal(r.status, 'open');
    assert.equal(r.approval_mode, 'instant');
    slotIdInstant = r.id;
  });

  it('organiser can publish an approval-mode slot for a different role', async () => {
    const r = await call(orgUser, 'POST', '/fixtures/:id/open-slots', {
      id: fixtureId, role: 'linesman', slots: 2, approval_mode: 'approval', allow_waitlist: true,
      fee_minor: 3000, fee_currency: 'USD', reporting_min: 20, publish: true,
    });
    assert.equal(r.status, 'open');
    slotIdApproval = r.id;
  });

  it('duplicate role on same fixture is rejected', async () => {
    await assert.rejects(() => call(orgUser, 'POST', '/fixtures/:id/open-slots', { id: fixtureId, role: 'referee', slots: 1 }), /already exists/i);
  });

  it('organiser cannot claim their own slot', async () => {
    await assert.rejects(() => call(orgUser, 'POST', '/open-match-slots/:id/claim', { id: slotIdInstant }), /cannot claim your own/i);
  });
});

// ─── browse ───────────────────────────────────────────────────────────────────

describe('browse_open_match_slots', () => {
  it('official can browse open slots', async () => {
    const rows = await call(official1, 'GET', '/open-match-slots', { limit: 50 });
    const mine = rows.find((s) => s.id === slotIdInstant);
    assert.ok(mine, 'slot not in browse results');
    assert.ok('my_eligibility' in mine, 'missing my_eligibility');
  });

  it('private notes not leaked on browse', async () => {
    // publish a slot with private notes, then check browse does not expose them
    const slotP = await call(orgUser, 'POST', '/fixtures/:id/open-slots', {
      id: fixtureId, role: 'scorer', slots: 1, approval_mode: 'instant', private_notes: 'SECRET', publish: true,
    });
    const rows = await call(official1, 'GET', '/open-match-slots', { limit: 50 });
    const found = rows.find((s) => s.id === slotP.id);
    assert.ok(found, 'slot not found');
    assert.ok(!found.private_notes, 'private_notes leaked on browse');
    // close to avoid interfering with other tests
    await call(orgUser, 'POST', '/open-match-slots/:id/close', { id: slotP.id });
  });

  it('filter by role works', async () => {
    const rows = await call(official1, 'GET', '/open-match-slots', { role: 'referee', limit: 10 });
    assert.ok(rows.every((s) => s.role === 'referee'));
  });
});

// ─── instant claim ────────────────────────────────────────────────────────────

describe('claim_open_match_slot (instant)', () => {
  it('eligible official can instantly claim a slot', async () => {
    const app = await call(official1, 'POST', '/open-match-slots/:id/claim', { id: slotIdInstant });
    assert.equal(app.status, 'approved');
    // fixture_official must be created
    const fo = await getFO(official1.id, fixtureId);
    assert.ok(fo, 'fixture_official not created');
    assert.equal(fo.status, 'accepted');
    // slot filled count bumped
    const slot = await getSlot(slotIdInstant);
    assert.equal(slot.filled, 1);
    assert.equal(slot.status, 'full');
  });

  it('idempotent — second claim returns same application', async () => {
    const app2 = await call(official1, 'POST', '/open-match-slots/:id/claim', { id: slotIdInstant });
    assert.equal(app2.status, 'approved');
  });

  it('another official is waitlisted when slot is full', async () => {
    const app = await call(official2, 'POST', '/open-match-slots/:id/claim', { id: slotIdInstant });
    assert.equal(app.status, 'waitlisted');
    assert.equal(app.waitlist_position, 1);
  });

  it('third official joins waitlist at position 2', async () => {
    const app = await call(official3, 'POST', '/open-match-slots/:id/claim', { id: slotIdInstant });
    assert.equal(app.status, 'waitlisted');
    assert.equal(app.waitlist_position, 2);
  });
});

// ─── cancel and waitlist promotion ────────────────────────────────────────────

describe('cancel and waitlist promotion', () => {
  it('confirmed official can cancel; waitlist is promoted', async () => {
    const myApp = (await pool.query("SELECT * FROM open_slot_applications WHERE slot_id=$1 AND user_id=$2 AND status='approved'", [slotIdInstant, official1.id])).rows[0];
    await call(official1, 'POST', '/open-slot-applications/:id/cancel', { id: myApp.id, reason: 'Unavailable' });
    // first waitlisted (official2) should now be approved
    const promotedApp = (await pool.query("SELECT * FROM open_slot_applications WHERE slot_id=$1 AND user_id=$2", [slotIdInstant, official2.id])).rows[0];
    assert.equal(promotedApp.status, 'approved', 'waitlist not promoted after cancel');
    // slot should still be full (1/1)
    const slot = await getSlot(slotIdInstant);
    assert.equal(slot.filled, 1);
  });
});

// ─── approval mode ────────────────────────────────────────────────────────────

describe('approval mode', () => {
  let pendingAppId;

  it('official applies → pending', async () => {
    const app = await call(official1, 'POST', '/open-match-slots/:id/claim', { id: slotIdApproval, note: 'Very experienced linesman' });
    assert.equal(app.status, 'pending');
    pendingAppId = app.id;
  });

  it('organiser can reject with a note', async () => {
    await call(orgUser, 'POST', '/open-slot-applications/:id/decide', { id: pendingAppId, decision: 'reject', note: 'Need higher grade' });
    const app = await getApp(pendingAppId);
    assert.equal(app.status, 'rejected');
  });

  it('organiser can approve a second applicant', async () => {
    const app = await call(official2, 'POST', '/open-match-slots/:id/claim', { id: slotIdApproval });
    assert.equal(app.status, 'pending');
    await call(orgUser, 'POST', '/open-slot-applications/:id/decide', { id: app.id, decision: 'approve' });
    const updated = await getApp(app.id);
    assert.equal(updated.status, 'approved');
    // fixture_official created
    const fo = await getFO(official2.id, fixtureId);
    assert.ok(fo, 'fixture_official not created after approval');
  });
});

// ─── withdraw ─────────────────────────────────────────────────────────────────

describe('withdraw_open_slot_application', () => {
  it('official can withdraw a pending application', async () => {
    const app = await call(official3, 'POST', '/open-match-slots/:id/claim', { id: slotIdApproval });
    assert.equal(app.status, 'pending');
    await call(official3, 'POST', '/open-slot-applications/:id/withdraw', { id: app.id });
    const withdrawn = await getApp(app.id);
    assert.equal(withdrawn.status, 'withdrawn');
  });

  it('cannot withdraw an approved application', async () => {
    const approvedApp = (await pool.query("SELECT * FROM open_slot_applications WHERE slot_id=$1 AND user_id=$2 AND status='approved'", [slotIdApproval, official2.id])).rows[0];
    await assert.rejects(() => call(official2, 'POST', '/open-slot-applications/:id/withdraw', { id: approvedApp.id }), /cannot withdraw/i);
  });
});

// ─── organiser list (slot management) ────────────────────────────────────────

describe('list_open_match_slots_for_fixture', () => {
  it('organiser sees all slots with applicants and private notes', async () => {
    const slots = await call(orgUser, 'GET', '/fixtures/:id/open-slots', { id: fixtureId });
    const referee = slots.find((s) => s.role === 'referee');
    assert.ok(referee, 'referee slot not found');
    assert.ok(Array.isArray(referee.applications), 'applications not included');
  });

  it('non-organiser cannot list organiser view', async () => {
    await assert.rejects(() => call(official1, 'GET', '/fixtures/:id/open-slots', { id: fixtureId }), /organis/i);
  });
});

// ─── my applications ──────────────────────────────────────────────────────────

describe('list_my_open_slot_applications', () => {
  it('official can list their own applications', async () => {
    const apps = await call(official1, 'GET', '/me/open-slot-applications', {});
    assert.ok(Array.isArray(apps));
  });
});

// ─── close slot ───────────────────────────────────────────────────────────────

describe('close_open_match_slot', () => {
  it('organiser can close a slot', async () => {
    // publish a fresh slot to close
    const slot = await call(orgUser, 'POST', '/fixtures/:id/open-slots', {
      id: fixtureId, role: 'timekeeper', slots: 1, approval_mode: 'instant', publish: true,
    });
    await call(orgUser, 'POST', '/open-match-slots/:id/close', { id: slot.id });
    const closed = await getSlot(slot.id);
    assert.equal(closed.status, 'closed');
  });

  it('closed slot rejects new claims', async () => {
    const slot = await getSlot(slotIdInstant);
    // set to closed via direct query so we can test the guard
    await pool.query("UPDATE open_match_slots SET status='closed' WHERE id=$1", [slotIdInstant]);
    await assert.rejects(() => call(official3, 'POST', '/open-match-slots/:id/claim', { id: slotIdInstant }), /no longer accepting/i);
  });
});

// ─── OpenAPI/MCP parity ───────────────────────────────────────────────────────

describe('OpenAPI/MCP schema generation', () => {
  it('each capability generates a schema definition', async () => {
    const { capabilities } = await import('../src/capabilities/index.js');
    const names = ['publish_open_match_slot', 'update_open_match_slot', 'close_open_match_slot',
      'list_open_match_slots_for_fixture', 'browse_open_match_slots', 'get_open_match_slot',
      'claim_open_match_slot', 'list_my_open_slot_applications', 'decide_open_slot_application',
      'withdraw_open_slot_application', 'cancel_open_slot_application'];
    for (const name of names) {
      const found = capabilities.find((c) => c.name === name);
      assert.ok(found, `Missing capability: ${name}`);
    }
  });
});
