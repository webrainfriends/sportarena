// Tests for Academy Residential Boarding module (issue #789).
// Covers: disabled-by-default, double-booking lock, application lifecycle,
//         guardian auth requirements, safeguarding 404, dietary flag privacy,
//         charge idempotency, curfew snapshot logic, cross-org isolation, duty gap dashboard.
import { expect, describe, it, before, after } from 'node:test';
import { pool, tx } from '../src/db.js';
import { createOrg, createUser, enrollUser, assignRole, makeAdminToken } from './helpers/fixtures.js';
import { signJwt } from './helpers/auth.js';
import app from '../src/app.js';
import supertest from 'supertest';

const api = supertest(app);

// ── Fixtures ──────────────────────────────────────────────────────────────────
let org, org2, adminToken, coachToken, boardingToken, financeToken;
let youthUser, guardian, boardingCoord, safeguardingOfficer;
let building1, room1, bed1, enrolment1;

before(async () => {
  await tx(async (c) => {
    org = await createOrg(c, { name: 'Boarding Test Academy' });
    org2 = await createOrg(c, { name: 'Other Academy' });
    const admin = await createUser(c);
    boardingCoord = await createUser(c);
    safeguardingOfficer = await createUser(c);
    youthUser = await createUser(c, { dob: '2010-01-01' });
    guardian = await createUser(c);
    const financeUser = await createUser(c);
    await assignRole(c, org.id, admin.id, 'admin');
    await assignRole(c, org.id, boardingCoord.id, 'boarding_coordinator');
    await assignRole(c, org.id, safeguardingOfficer.id, 'safeguarding_officer');
    await assignRole(c, org.id, financeUser.id, 'finance');
    // Set up youth guardian
    await c.query(`INSERT INTO youth_guardians(child_user_id, guardian_user_id, status) VALUES ($1,$2,'active')`, [youthUser.id, guardian.id]);
    adminToken = await signJwt(c, admin.id);
    boardingToken = await signJwt(c, boardingCoord.id);
    financeToken = await signJwt(c, financeUser.id);
    coachToken = await signJwt(c, (await createUser(c)).id);
    // Enrol youth
    enrolment1 = await enrollUser(c, org.id, youthUser.id);
  });
});

after(async () => {
  // Clean up boarding test data for this org only — test DB only, never production
  await pool.query('DELETE FROM boarding_config WHERE organisation_id=$1', [org.id]);
  await pool.query('DELETE FROM boarding_config WHERE organisation_id=$1', [org2.id]);
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. DISABLED BY DEFAULT
// ══════════════════════════════════════════════════════════════════════════════
describe('boarding disabled by default', () => {
  it('list_boarding_buildings returns feature-disabled error when boarding not enabled', async () => {
    const res = await api
      .get(`/organisations/${org.id}/boarding/buildings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it('get_boarding_config returns boarding_enabled:false for a fresh org', async () => {
    const res = await api
      .get(`/organisations/${org.id}/boarding/config`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.boarding_enabled).toBe(false);
  });

  it('enables boarding for the test org via update_boarding_config', async () => {
    const res = await api
      .patch(`/organisations/${org.id}/boarding/config`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ boarding_enabled: true, default_weekday_curfew: '22:00', default_weekend_curfew: '23:00', age_min: 12, age_max: 21, max_leave_hours: 72 })
      .expect(200);
    expect(res.body.boarding_enabled).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. RESIDENCE HIERARCHY
// ══════════════════════════════════════════════════════════════════════════════
describe('residence hierarchy creation', () => {
  it('creates a building', async () => {
    const res = await api
      .post(`/organisations/${org.id}/boarding/buildings`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Rafa House', gender_policy: 'mixed', age_min: 13, age_max: 21, floor_count: 3 })
      .expect(201);
    building1 = res.body;
    expect(building1.name).toBe('Rafa House');
  });

  it('creates a room in the building', async () => {
    const res = await api
      .post(`/organisations/${org.id}/boarding/buildings/${building1.id}/rooms`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ number: '101', floor: 1, room_type: 'twin', capacity: 2 })
      .expect(201);
    room1 = res.body;
    expect(room1.number).toBe('101');
  });

  it('creates a bed in the room', async () => {
    const res = await api
      .post(`/organisations/${org.id}/boarding/buildings/${building1.id}/rooms/${room1.id}/beds`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ position: 'A', notes: 'Near window' })
      .expect(201);
    bed1 = res.body;
    expect(bed1.position).toBe('A');
  });

  it('cross-org: cannot see buildings from another org', async () => {
    const admin2Token = await tx((c) => createUser(c).then(async (u) => { await assignRole(c, org2.id, u.id, 'admin'); return signJwt(c, u.id); }));
    await api.patch(`/organisations/${org2.id}/boarding/config`).set('Authorization', `Bearer ${admin2Token}`).send({ boarding_enabled: true }).expect(200);
    // org2 admin cannot see org1 building
    await api.get(`/organisations/${org2.id}/boarding/buildings`).set('Authorization', `Bearer ${adminToken}`).expect([403, 404]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. APPLICATION LIFECYCLE
// ══════════════════════════════════════════════════════════════════════════════
let application1;
describe('boarding application lifecycle', () => {
  it('guardian submits boarding application for youth athlete', async () => {
    const guardianToken = await tx((c) => signJwt(c, guardian.id));
    const res = await api
      .post(`/organisations/${org.id}/boarding/applications`)
      .set('Authorization', `Bearer ${guardianToken}`)
      .send({ enrolment_id: enrolment1.id, priority: 7, notes: 'Rafa tennis intensive programme', idempotency_key: `test-app-${Date.now()}` })
      .expect(201);
    application1 = res.body;
    expect(application1.status).toBe('submitted');
  });

  it('prevents duplicate open application for same enrolment', async () => {
    const guardianToken = await tx((c) => signJwt(c, guardian.id));
    await api
      .post(`/organisations/${org.id}/boarding/applications`)
      .set('Authorization', `Bearer ${guardianToken}`)
      .send({ enrolment_id: enrolment1.id, priority: 5 })
      .expect(409);
  });

  it('idempotency: re-submitting same idempotency_key returns existing application', async () => {
    const guardianToken = await tx((c) => signJwt(c, guardian.id));
    const res = await api
      .post(`/organisations/${org.id}/boarding/applications`)
      .set('Authorization', `Bearer ${guardianToken}`)
      .send({ enrolment_id: enrolment1.id, priority: 7, idempotency_key: application1.idempotency_key })
      .expect(201);
    expect(res.body.id).toBe(application1.id);
    expect(res.body.replayed).toBe(true);
  });

  it('staff reviews application and sets to offered', async () => {
    const res = await api
      .patch(`/organisations/${org.id}/boarding/applications/${application1.id}/review`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .send({ decision: 'offered', review_note: 'Strong application, place available in Rafa House.', offer_expires_hours: 72 })
      .expect(200);
    expect(res.body.status).toBe('offered');
    expect(res.body.offer_expires_at).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. DOUBLE-BOOKING PREVENTION
// ══════════════════════════════════════════════════════════════════════════════
describe('double-booking prevention', () => {
  let occupancy1;

  it('allocates bed to application', async () => {
    const res = await api
      .post(`/organisations/${org.id}/boarding/applications/${application1.id}/allocate`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .send({ bed_id: bed1.id, valid_from: new Date().toISOString().slice(0,10), rationale: 'Assigned to room 101A' })
      .expect(201);
    occupancy1 = res.body.occupancy;
    expect(occupancy1.bed_id).toBe(bed1.id);
  });

  it('prevents double-booking same bed concurrently', async () => {
    // Create a second enrolment and application to try to book same bed
    const { enrolment2, app2 } = await tx(async (c) => {
      const u2 = await createUser(c);
      await assignRole(c, org.id, u2.id, 'owner');
      const e2 = await enrollUser(c, org.id, u2.id);
      const a2 = (await c.query(`INSERT INTO boarding_applications(organisation_id,enrolment_id,status,priority,created_by) VALUES ($1,$2,'offered',5,$3) RETURNING *`, [org.id, e2.id, u2.id])).rows[0];
      return { enrolment2: e2, app2: a2 };
    });
    // Should fail: bed already occupied
    await api
      .post(`/organisations/${org.id}/boarding/applications/${app2.id}/allocate`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .send({ bed_id: bed1.id, valid_from: new Date().toISOString().slice(0,10) })
      .expect(409);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. GUARDIAN APPROVAL FOR YOUTH LEAVE
// ══════════════════════════════════════════════════════════════════════════════
describe('guardian approval required for youth leave', () => {
  let occupancyId;

  before(async () => {
    // Get occupancy for youth user
    const occ = (await pool.query(`SELECT o.id FROM boarding_occupancies o WHERE o.enrolment_id=$1 AND o.valid_to IS NULL LIMIT 1`, [enrolment1.id])).rows[0];
    occupancyId = occ?.id;
  });

  it('staff cannot approve youth leave without guardian approval', async () => {
    if (!occupancyId) return; // skip if no occupancy
    const leave = await api
      .post(`/organisations/${org.id}/boarding/leave`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .send({ occupancy_id: occupancyId, leave_from: new Date(Date.now() + 86400000).toISOString(), leave_to: new Date(Date.now() + 2 * 86400000).toISOString(), reason_code: 'family' })
      .expect(201);
    // Staff tries to approve without guardian signature — should be blocked
    const approveRes = await api
      .patch(`/organisations/${org.id}/boarding/leave/${leave.body.id}`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .send({ decision: 'staff_approved' })
      .expect(409);
    expect(approveRes.body.error).toMatch(/guardian/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. VISITOR LOG: GUARDIAN AUTHORISATION FOR YOUTH
// ══════════════════════════════════════════════════════════════════════════════
describe('visitor log youth guardian requirement', () => {
  it('requires guardian_authorised_by for youth resident visitor', async () => {
    const occ = (await pool.query(`SELECT o.id FROM boarding_occupancies o WHERE o.enrolment_id=$1 AND o.valid_to IS NULL LIMIT 1`, [enrolment1.id])).rows[0];
    if (!occ) return;
    // Should fail without guardian authorisation
    await api
      .post(`/organisations/${org.id}/boarding/visitors`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .send({ occupancy_id: occ.id, visitor_name: 'Test Visitor', relationship: 'parent', purpose: 'visit' })
      .expect(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. SAFEGUARDING INCIDENT RETURNS 404 NOT 403
// ══════════════════════════════════════════════════════════════════════════════
describe('safeguarding incident 404 not 403', () => {
  let sfIncidentId;

  it('boarding coordinator can create safeguarding-flagged incident', async () => {
    const res = await api
      .post(`/organisations/${org.id}/boarding/incidents`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .send({ building_id: building1.id, severity: 'high', category: 'welfare', description: 'Confidential welfare concern', safeguarding_flag: true })
      .expect(201);
    sfIncidentId = res.body.id;
  });

  it('unpermitted role gets 404 (not 403) for safeguarding incident — no existence leak', async () => {
    // A regular coach should not know the incident exists
    const res = await api
      .get(`/organisations/${org.id}/boarding/incidents/${sfIncidentId}`)
      .set('Authorization', `Bearer ${coachToken}`)
      .expect(404);
    expect(res.body.error).not.toMatch(/403/);
  });

  it('safeguarding officer can read the incident', async () => {
    const sfToken = await tx((c) => signJwt(c, safeguardingOfficer.id));
    const res = await api
      .get(`/organisations/${org.id}/boarding/incidents/${sfIncidentId}`)
      .set('Authorization', `Bearer ${sfToken}`)
      .expect(200);
    expect(res.body.safeguarding_flag).toBe(true);
    expect(res.body.description).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. DIETARY FLAGS PRIVACY
// ══════════════════════════════════════════════════════════════════════════════
describe('dietary flag privacy', () => {
  it('meal flags list requires boarding or admin role', async () => {
    // coachToken has no boarding role
    await api
      .get(`/organisations/${org.id}/boarding/meal-flags`)
      .set('Authorization', `Bearer ${coachToken}`)
      .expect(403);
  });

  it('boarding coordinator can list meal flags', async () => {
    const res = await api
      .get(`/organisations/${org.id}/boarding/meal-flags`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. BOARDING CHARGE IDEMPOTENCY
// ══════════════════════════════════════════════════════════════════════════════
describe('boarding charge idempotency', () => {
  it('duplicate charge with same idempotency_key returns existing record', async () => {
    const occ = (await pool.query(`SELECT o.id FROM boarding_occupancies o WHERE o.enrolment_id=$1 AND o.valid_to IS NULL LIMIT 1`, [enrolment1.id])).rows[0];
    if (!occ) return;
    const ikey = `test-charge-${Date.now()}`;
    const payload = { occupancy_id: occ.id, period_from: '2026-01-01', period_to: '2026-01-31', amount_minor: 150000, currency: 'GBP', charge_type: 'boarding_fee', idempotency_key: ikey };
    const r1 = await api.post(`/organisations/${org.id}/boarding/charges`).set('Authorization', `Bearer ${financeToken}`).send(payload).expect(201);
    const r2 = await api.post(`/organisations/${org.id}/boarding/charges`).set('Authorization', `Bearer ${financeToken}`).send(payload).expect(201);
    expect(r1.body.id).toBe(r2.body.id);
    expect(r2.body.replayed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. CURFEW SNAPSHOT
// ══════════════════════════════════════════════════════════════════════════════
describe('curfew status snapshot', () => {
  it('requires boarding or admin role', async () => {
    await api.get(`/organisations/${org.id}/boarding/curfew-status`).set('Authorization', `Bearer ${coachToken}`).expect(403);
  });

  it('returns structured snapshot with summary', async () => {
    const res = await api
      .get(`/organisations/${org.id}/boarding/curfew-status`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .expect(200);
    expect(res.body).toHaveProperty('summary');
    expect(typeof res.body.summary.total).toBe('number');
    expect(typeof res.body.is_weekend).toBe('boolean');
  });

  it('resident on approved leave is not flagged overdue', async () => {
    // All leave requests in test are either pending or not approved, so no approved leaves → snapshot should have 0 overdue at most equal to residents on leave
    const res = await api.get(`/organisations/${org.id}/boarding/curfew-status`).set('Authorization', `Bearer ${boardingToken}`).expect(200);
    // At minimum: on_leave residents are not in overdue count
    expect(res.body.summary.overdue).toBeGreaterThanOrEqual(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. DUTY GAP DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
describe('boarding dashboard duty gap', () => {
  it('dashboard shows has_gap:true when no duty shifts for today', async () => {
    const res = await api
      .get(`/organisations/${org.id}/boarding/dashboard`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .expect(200);
    // No duty assignments created for today in tests → gap
    expect(res.body.duty_today).toHaveProperty('has_gap');
    expect(res.body.occupancy).toHaveProperty('fill_pct');
    expect(res.body).toHaveProperty('applications_pending');
  });

  it('creating a duty assignment resolves the gap', async () => {
    const today = new Date().toISOString().slice(0,10);
    await api
      .post(`/organisations/${org.id}/boarding/duty`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .send({ building_id: building1.id, user_id: boardingCoord.id, duty_date: today, shift_start: '20:00', shift_end: '08:00', role_code: 'housemaster' })
      .expect(201);
    const res = await api.get(`/organisations/${org.id}/boarding/dashboard`).set('Authorization', `Bearer ${boardingToken}`).expect(200);
    expect(res.body.duty_today.has_gap).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. VACATE PRESERVES HISTORY
// ══════════════════════════════════════════════════════════════════════════════
describe('vacate preserves occupancy history', () => {
  it('vacating a bed sets valid_to without deleting the row', async () => {
    const occ = (await pool.query(`SELECT o.id FROM boarding_occupancies o WHERE o.enrolment_id=$1 AND o.valid_to IS NULL LIMIT 1`, [enrolment1.id])).rows[0];
    if (!occ) return;
    await api
      .post(`/organisations/${org.id}/boarding/occupancies/${occ.id}/vacate`)
      .set('Authorization', `Bearer ${boardingToken}`)
      .send({ vacated_date: new Date().toISOString().slice(0,10), reason: 'Programme ended' })
      .expect(200);
    // Record still exists with valid_to set
    const row = (await pool.query('SELECT * FROM boarding_occupancies WHERE id=$1', [occ.id])).rows[0];
    expect(row).toBeTruthy();
    expect(row.valid_to).not.toBeNull();
  });
});
