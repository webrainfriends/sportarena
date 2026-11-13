// Tests for academy-conferences capability (#796)
// Covers: create, update, list, get, cancel, reschedule, attendees,
//         evidence, agenda, decisions, acknowledge, report generation,
//         and guardian access control (staff_notes NEVER shown to guardians).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, rpc, testUser, testOrg, cleanup } from './helpers.js';

let orgId, staffToken, guardianToken, guardianUserId, athleteUserId, planId;
let confId, attendeeId, itemId, decisionId;

before(async () => {
  await cleanup();
  const org = await testOrg();
  orgId = org.id;
  staffToken = org.ownerToken;
  const ath = await testUser({ role: 'athlete' });
  athleteUserId = ath.id;
  const grd = await testUser({ role: 'user' });
  guardianUserId = grd.id;
  guardianToken = grd.token;
  // Create a dev plan for the athlete
  const plan = await api.post(`/organisations/${orgId}/academy/dev-plans`, { athlete_id: athleteUserId, title: 'Test Plan', kind: 'annual' }, staffToken);
  planId = plan.id;
});

after(cleanup);

describe('create conference', () => {
  it('staff can create a conference', async () => {
    const r = await api.post(`/orgs/${orgId}/conferences`, {
      title: 'Annual Review 2026 — Test Athlete',
      kind: 'annual_review',
      scheduled_at: '2026-06-15T10:00:00Z',
      duration_minutes: 60,
      location_type: 'video',
      location_detail: 'https://meet.example.com/review',
      agenda: 'Review development domains and set targets for next term',
      staff_notes: 'Private coach notes — guardian should never see this',
      family_visible: true,
      plan_id: planId,
    }, staffToken);
    confId = r.id;
    assert.equal(r.kind, 'annual_review');
    assert.equal(r.status, 'draft');
    assert.equal(r.family_visible, true);
    assert.ok(r.agenda, 'agenda should be returned');
    assert.ok(r.staff_notes, 'staff should see staff_notes');
  });

  it('staff_notes is NEVER returned to guardian callers', async () => {
    // Link guardian to athlete first
    await api.post(`/youth/guardian-links`, { guardian_id: guardianUserId, athlete_id: athleteUserId, purpose: 'parent' }, staffToken);
    // Add guardian as attendee
    const a = await api.post(`/orgs/${orgId}/conferences/${confId}/attendees`, { user_id: guardianUserId, role: 'guardian' }, staffToken);
    attendeeId = a.id;
    // Guardian views conference
    const r = await api.get(`/orgs/${orgId}/conferences/${confId}`, {}, guardianToken);
    assert.equal(r.staff_notes, undefined, 'staff_notes must never be returned to guardians');
    assert.ok(r.agenda, 'guardian should see agenda');
  });
});

describe('update conference', () => {
  it('updates status to scheduled', async () => {
    const r = await api.patch(`/orgs/${orgId}/conferences/${confId}`, { status: 'scheduled' }, staffToken);
    assert.equal(r.status, 'scheduled');
    assert.equal(r.row_version, 2);
  });

  it('updates staff_notes without leaking to guardian', async () => {
    await api.patch(`/orgs/${orgId}/conferences/${confId}`, { staff_notes: 'Updated internal notes' }, staffToken);
    const guardianView = await api.get(`/orgs/${orgId}/conferences/${confId}`, {}, guardianToken);
    assert.equal(guardianView.staff_notes, undefined);
  });
});

describe('list conferences', () => {
  it('staff sees all conferences', async () => {
    const r = await api.get(`/orgs/${orgId}/conferences`, {}, staffToken);
    assert.ok(Array.isArray(r));
    assert.ok(r.some((c) => c.id === confId));
  });

  it('guardian only sees family_visible conferences they are invited to', async () => {
    // Create a non-family-visible conference
    const hidden = await api.post(`/orgs/${orgId}/conferences`, { title: 'Internal only', kind: 'welfare', family_visible: false, plan_id: planId }, staffToken);
    const r = await api.get(`/orgs/${orgId}/conferences`, {}, guardianToken);
    assert.ok(!r.some((c) => c.id === hidden.id), 'hidden conference must not appear for guardian');
    assert.ok(r.some((c) => c.id === confId), 'family_visible conference should appear');
  });
});

describe('attendees', () => {
  it('invites a lead coach', async () => {
    const coach = await testUser({ role: 'coach' });
    const r = await api.post(`/orgs/${orgId}/conferences/${confId}/attendees`, { user_id: coach.id, role: 'lead_coach' }, staffToken);
    assert.equal(r.role, 'lead_coach');
    assert.equal(r.status, 'invited');
  });

  it('guardian can confirm their own attendance', async () => {
    const r = await api.post(`/orgs/${orgId}/conferences/${confId}/attendees/${attendeeId}/respond`, { status: 'confirmed' }, guardianToken);
    assert.equal(r.status, 'confirmed');
    assert.ok(r.responded_at);
  });
});

describe('evidence', () => {
  it('staff can add evidence', async () => {
    const r = await api.post(`/orgs/${orgId}/conferences/${confId}/evidence`, { source_kind: 'dev_review', label: 'Q1 Development Review', visible_to_roles: ['coach', 'admin', 'guardian'] }, staffToken);
    assert.equal(r.source_kind, 'dev_review');
    assert.equal(r.label, 'Q1 Development Review');
  });

  it('staff can remove evidence', async () => {
    const ev = await api.post(`/orgs/${orgId}/conferences/${confId}/evidence`, { source_kind: 'assessment', label: 'Test to remove', visible_to_roles: ['coach'] }, staffToken);
    const r = await api.delete(`/orgs/${orgId}/conferences/${confId}/evidence/${ev.id}`, staffToken);
    assert.equal(r.ok, true);
  });
});

describe('agenda', () => {
  it('adds an agenda item', async () => {
    const r = await api.post(`/orgs/${orgId}/conferences/${confId}/agenda`, { title: 'Technical development review', kind: 'review_domain', time_minutes: 20 }, staffToken);
    itemId = r.id;
    assert.equal(r.title, 'Technical development review');
    assert.equal(r.kind, 'review_domain');
  });

  it('updates the agenda item', async () => {
    const r = await api.patch(`/orgs/${orgId}/conferences/${confId}/agenda/${itemId}`, { time_minutes: 25 }, staffToken);
    assert.equal(r.time_minutes, 25);
  });

  it('reorders agenda items', async () => {
    const item2 = await api.post(`/orgs/${orgId}/conferences/${confId}/agenda`, { title: 'Welfare check', kind: 'welfare', time_minutes: 10 }, staffToken);
    const r = await api.patch(`/orgs/${orgId}/conferences/${confId}/agenda/order`, { item_ids: [item2.id, itemId] }, staffToken);
    assert.equal(r.ok, true);
  });
});

describe('decisions', () => {
  it('staff records a decision visible to guardian', async () => {
    const r = await api.post(`/orgs/${orgId}/conferences/${confId}/decisions`, {
      kind: 'action', body: 'Increase forehand training to 3x per week', deadline_on: '2026-09-01', visible_to_guardian: true,
    }, staffToken);
    decisionId = r.id;
    assert.equal(r.kind, 'action');
    assert.equal(r.status, 'open');
    assert.equal(r.visible_to_guardian, true);
  });

  it('guardian sees decisions marked visible_to_guardian', async () => {
    const r = await api.get(`/orgs/${orgId}/conferences/${confId}/decisions`, {}, guardianToken);
    assert.ok(r.some((d) => d.id === decisionId));
  });

  it('staff updates decision status to done', async () => {
    const r = await api.patch(`/orgs/${orgId}/conferences/${confId}/decisions/${decisionId}`, { status: 'done' }, staffToken);
    assert.equal(r.status, 'done');
    assert.ok(r.resolved_at);
  });
});

describe('reschedule', () => {
  it('reschedules and notifies attendees', async () => {
    const r = await api.post(`/orgs/${orgId}/conferences/${confId}/reschedule`, { new_scheduled_at: '2026-07-01T14:00:00Z', reason: 'Coach availability change' }, staffToken);
    assert.equal(r.status, 'rescheduled');
    assert.equal(r.scheduled_at, '2026-07-01T14:00:00.000Z');
  });
});

describe('outcome and acknowledgement', () => {
  it('staff marks conference complete', async () => {
    const r = await api.patch(`/orgs/${orgId}/conferences/${confId}`, { status: 'completed', outcome_summary: 'Excellent progress across all domains. Next review in 3 months.' }, staffToken);
    assert.equal(r.status, 'completed');
    assert.ok(r.outcome_summary);
  });

  it('staff generates outcome report', async () => {
    const r = await api.post(`/orgs/${orgId}/conferences/${confId}/report`, {}, staffToken);
    assert.ok(r.document_id);
    assert.ok(r.created_at);
  });

  it('guardian can acknowledge the outcome', async () => {
    const r = await api.post(`/orgs/${orgId}/conferences/${confId}/acknowledge`, {}, guardianToken);
    assert.equal(r.acknowledged, true);
    assert.ok(r.acknowledged_at);
  });

  it('guardian can get the report after acknowledgement', async () => {
    const r = await api.get(`/orgs/${orgId}/conferences/${confId}/report`, {}, guardianToken);
    assert.ok(r.document_id);
    assert.ok(r.download_url);
  });

  it('guardian cannot get the report without acknowledging first', async () => {
    // Create a fresh conference where guardian has not acknowledged
    const conf2 = await api.post(`/orgs/${orgId}/conferences`, { title: 'Another Conference', kind: 'termly', family_visible: true, plan_id: planId }, staffToken);
    await api.post(`/orgs/${orgId}/conferences/${conf2.id}/attendees`, { user_id: guardianUserId, role: 'guardian' }, staffToken);
    await api.patch(`/orgs/${orgId}/conferences/${conf2.id}`, { status: 'completed' }, staffToken);
    await api.post(`/orgs/${orgId}/conferences/${conf2.id}/report`, {}, staffToken);
    await assert.rejects(
      () => api.get(`/orgs/${orgId}/conferences/${conf2.id}/report`, {}, guardianToken),
      { status: 400 },
    );
  });
});

describe('MCP access', () => {
  it('MCP create_academy_conference works', async () => {
    const r = await rpc('create_academy_conference', { org_id: orgId, title: 'MCP test conference', kind: 'progress_check', plan_id: planId }, staffToken);
    assert.equal(r.kind, 'progress_check');
  });

  it('MCP list_my_guardian_conferences works for guardian', async () => {
    const r = await rpc('list_my_guardian_conferences', {}, guardianToken);
    assert.ok(Array.isArray(r));
  });
});

describe('cancel', () => {
  it('staff can cancel a draft conference', async () => {
    const c = await api.post(`/orgs/${orgId}/conferences`, { title: 'To cancel', kind: 'other', plan_id: planId }, staffToken);
    const r = await api.post(`/orgs/${orgId}/conferences/${c.id}/cancel`, { reason: 'No longer needed' }, staffToken);
    assert.equal(r.status, 'cancelled');
  });

  it('cannot cancel a completed conference', async () => {
    await assert.rejects(
      () => api.post(`/orgs/${orgId}/conferences/${confId}/cancel`, {}, staffToken),
      { status: 400 },
    );
  });
});
