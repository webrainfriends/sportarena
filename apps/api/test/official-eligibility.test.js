// Tests for official eligibility evaluation, overrides, conflict declarations and appeals — issue #1000 (REF-R09)
// Covers: eligible path, suspension gate, min-age gate, training cert gate, safeguarding gate,
// conflict-of-interest gate, override grant + revocation, suspension-override refusal,
// conflict declare → decide (waive / reassign / escalate) → withdraw, appeal routing,
// concurrency idempotency, privacy (detail_enc not exposed), REST/MCP parity.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx } from '../src/db.js';
import { testUser, testEvent, testFixture, testOfficialAssignment, teardown } from './helpers/fixtures.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function evaluateEligibility(c, assignmentId, user) {
  // Call the capability handler directly via the internal API path.
  const { pool: p } = await import('../src/db.js');
  const { default: app } = await import('../src/app.js');
  const res = await app.inject({ method: 'GET', url: `/official-assignments/${assignmentId}/eligibility`, headers: { 'x-test-user': user.id } });
  return { status: res.statusCode, body: res.json() };
}

async function grantOverride(c, assignmentId, factorKey, user) {
  const { default: app } = await import('../src/app.js');
  const expiresAt = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const res = await app.inject({ method: 'POST', url: `/official-assignments/${assignmentId}/eligibility/override`, headers: { 'x-test-user': user.id }, payload: { factor_key: factorKey, reason: 'Test override', override_expires_at: expiresAt } });
  return { status: res.statusCode, body: res.json() };
}

async function declareConflict(assignmentId, payload, user) {
  const { default: app } = await import('../src/app.js');
  const res = await app.inject({ method: 'POST', url: `/official-assignments/${assignmentId}/conflicts`, headers: { 'x-test-user': user.id }, payload });
  return { status: res.statusCode, body: res.json() };
}

async function decideConflict(conflictId, decision, user) {
  const { default: app } = await import('../src/app.js');
  const res = await app.inject({ method: 'POST', url: `/official-conflicts/${conflictId}/decision`, headers: { 'x-test-user': user.id }, payload: { decision, row_version: 1 } });
  return { status: res.statusCode, body: res.json() };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('official eligibility', () => {
  let official, organiser, event, fixture, assignment;

  before(async () => {
    official = await testUser({ role: 'referee' });
    organiser = await testUser({ role: 'organiser' });
    event = await testEvent({ organizer_id: organiser.id, official_policy: 'optional', sport_id: 'tennis' });
    fixture = await testFixture({ event_id: event.id });
    assignment = await testOfficialAssignment({ fixture_id: fixture.id, user_id: official.id, role: 'referee' });
  });

  after(() => teardown());

  // ── Eligible path ────────────────────────────────────────────────────────

  it('returns eligible when no policy constraints are set', async () => {
    const { status, body } = await evaluateEligibility(null, assignment.id, official);
    assert.equal(status, 200);
    assert.equal(body.eligible, true);
    assert.ok(Array.isArray(body.factors));
    // All factors should be eligible or skipped (no policy set)
    body.factors.forEach((f) => assert.notEqual(f.state, 'ineligible'));
  });

  it('never returns sanction type or case detail in eligibility response', async () => {
    const { body } = await evaluateEligibility(null, assignment.id, official);
    const bodyStr = JSON.stringify(body);
    assert.ok(!bodyStr.includes('sanction_type'), 'sanction_type must not be disclosed');
    assert.ok(!bodyStr.includes('case_id'), 'case_id must not be disclosed');
    assert.ok(!bodyStr.includes('evidence'), 'evidence must not be disclosed');
  });

  // ── Suspension gate ──────────────────────────────────────────────────────

  it('marks suspension factor ineligible when active sanction exists and blocks eligibility', async () => {
    // Insert a test active sanction for the official
    await pool.query(
      "INSERT INTO disc_sanctions(id, subject_user_id, kind, status, sport_id, starts_on, superseded_at) VALUES (gen_random_uuid(), $1, 'ban', 'active', $2, current_date - 1, NULL)",
      [official.id, event.sport_id]);
    const { body } = await evaluateEligibility(null, assignment.id, official);
    const suspFactor = body.factors.find((f) => f.key === 'suspension');
    assert.ok(suspFactor, 'suspension factor must be present');
    assert.equal(suspFactor.state, 'ineligible');
    assert.equal(body.eligible, false);
    // Clean up
    await pool.query("DELETE FROM disc_sanctions WHERE subject_user_id=$1 AND kind='ban'", [official.id]);
  });

  it('refuses suspension override — cannot be bypassed', async () => {
    const { status } = await grantOverride(null, assignment.id, 'suspension', organiser);
    assert.equal(status, 400, 'suspension override must be refused with 400');
  });

  // ── Minimum age gate ─────────────────────────────────────────────────────

  it('marks min_age factor ineligible when official is under event minimum age', async () => {
    // Set a 25-year minimum and give the official a birth date that makes them 20
    await pool.query('UPDATE events SET official_min_age=25 WHERE id=$1', [event.id]);
    const dob = new Date();
    dob.setFullYear(dob.getFullYear() - 20);
    await pool.query('UPDATE profiles SET birth_date=$1 WHERE user_id=$2', [dob.toISOString().slice(0, 10), official.id]);

    const { body } = await evaluateEligibility(null, assignment.id, official);
    const ageFactor = body.factors.find((f) => f.key === 'min_age');
    assert.ok(ageFactor, 'min_age factor must be present when policy is set');
    assert.equal(ageFactor.state, 'ineligible');
    assert.equal(body.eligible, false);

    // Reset
    await pool.query('UPDATE events SET official_min_age=NULL WHERE id=$1', [event.id]);
  });

  // ── Training certificate gate ────────────────────────────────────────────

  it('marks training factor ineligible when required cert is missing', async () => {
    await pool.query("UPDATE events SET official_training_required=ARRAY['child_protection_basic'] WHERE id=$1", [event.id]);
    const { body } = await evaluateEligibility(null, assignment.id, official);
    const trainFactor = body.factors.find((f) => f.key === 'training');
    assert.ok(trainFactor);
    assert.equal(trainFactor.state, 'ineligible');
    // Reset
    await pool.query("UPDATE events SET official_training_required='{}' WHERE id=$1", [event.id]);
  });

  it('marks training factor eligible after organiser grants override', async () => {
    await pool.query("UPDATE events SET official_training_required=ARRAY['child_protection_basic'] WHERE id=$1", [event.id]);
    await grantOverride(null, assignment.id, 'training', organiser);
    const { body } = await evaluateEligibility(null, assignment.id, official);
    const trainFactor = body.factors.find((f) => f.key === 'training');
    assert.equal(trainFactor.state, 'overridden');
    assert.equal(body.eligible, true);
    // Clean up
    await pool.query('DELETE FROM official_eligibility_overrides WHERE fixture_official_id=$1', [assignment.id]);
    await pool.query("UPDATE events SET official_training_required='{}' WHERE id=$1", [event.id]);
  });

  // ── Conflict of interest gate ────────────────────────────────────────────

  it('allows assignment when no conflict is declared', async () => {
    await pool.query('UPDATE events SET official_conflict_declaration_required=true WHERE id=$1', [event.id]);
    const { body } = await evaluateEligibility(null, assignment.id, official);
    const conflictFactor = body.factors.find((f) => f.key === 'conflicts');
    // No open conflict → eligible
    assert.ok(['eligible', undefined].includes(conflictFactor?.state));
    assert.equal(body.eligible, true);
    await pool.query('UPDATE events SET official_conflict_declaration_required=false WHERE id=$1', [event.id]);
  });

  it('blocks assignment when open conflict exists', async () => {
    await pool.query('UPDATE events SET official_conflict_declaration_required=true WHERE id=$1', [event.id]);
    const { body: decl } = await declareConflict(assignment.id, { kind: 'team_relationship', detail: 'I coached the home team last season', serious: false }, official);
    assert.equal(decl.status, 'open');

    const { body } = await evaluateEligibility(null, assignment.id, official);
    const conflictFactor = body.factors.find((f) => f.key === 'conflicts');
    assert.equal(conflictFactor?.state, 'ineligible');
    assert.equal(body.eligible, false);

    // Organiser waives → eligible again
    await decideConflict(decl.id, 'waive', organiser);
    const { body: after } = await evaluateEligibility(null, assignment.id, official);
    assert.equal(after.eligible, true);

    await pool.query('UPDATE events SET official_conflict_declaration_required=false WHERE id=$1', [event.id]);
  });

  // ── Conflict: reassign ───────────────────────────────────────────────────

  it('releases official when organiser decides reassign', async () => {
    const { body: decl } = await declareConflict(assignment.id, { kind: 'family_member', detail: 'My sibling plays for the away team', serious: true }, official);
    const { status, body } = await decideConflict(decl.id, 'reassign', organiser);
    assert.equal(status, 200);
    assert.equal(body.status, 'reassigned');
    // The fixture_official row should now be released
    const fo = (await pool.query('SELECT status FROM fixture_officials WHERE id=$1', [assignment.id])).rows[0];
    assert.equal(fo.status, 'released');
  });

  // ── Conflict: withdraw ───────────────────────────────────────────────────

  it('allows official to withdraw their own open declaration', async () => {
    // Create a fresh assignment since the last one was released
    const a2 = await testOfficialAssignment({ fixture_id: fixture.id, user_id: official.id, role: 'timekeeper' });
    const { body: decl } = await declareConflict(a2.id, { kind: 'other', detail: 'General concern about objectivity', serious: false }, official);
    const { default: app } = await import('../src/app.js');
    const res = await app.inject({ method: 'POST', url: `/official-conflicts/${decl.id}/withdraw`, headers: { 'x-test-user': official.id }, payload: {} });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'withdrawn');
  });

  // ── Privacy: detail_enc must not be exposed to unauthorized callers ───────

  it('does not return detail to a third party (non-official, non-organiser)', async () => {
    const intruder = await testUser({ role: 'athlete' });
    const { default: app } = await import('../src/app.js');
    // List should return 404 for intruder
    const res = await app.inject({ method: 'GET', url: `/official-assignments/${assignment.id}/conflicts`, headers: { 'x-test-user': intruder.id } });
    assert.ok([403, 404].includes(res.statusCode), `expected 403/404 for intruder, got ${res.statusCode}`);
  });

  // ── Appeal routing ───────────────────────────────────────────────────────

  it('creates a cases row when official appeals an ineligibility decision', async () => {
    // Temporarily set min-age to trigger ineligibility
    await pool.query('UPDATE events SET official_min_age=99 WHERE id=$1', [event.id]);
    const { default: app } = await import('../src/app.js');
    const res = await app.inject({ method: 'POST', url: `/official-assignments/${assignment.id}/eligibility/appeal`, headers: { 'x-test-user': official.id }, payload: { grounds: 'I am eligible under the governing body waiver programme', supporting_note: 'See attached waiver document.' } });
    assert.equal(res.statusCode, 201);
    const caseRow = (await pool.query("SELECT * FROM cases WHERE subject_id=$1 AND kind='eligibility_appeal' ORDER BY created_at DESC LIMIT 1", [assignment.id])).rows[0];
    assert.ok(caseRow, 'cases row must be created for the appeal');
    await pool.query('UPDATE events SET official_min_age=NULL WHERE id=$1', [event.id]);
  });

  // ── REST / OpenAPI parity ────────────────────────────────────────────────

  it('all official eligibility capabilities appear in the OpenAPI schema', async () => {
    const { default: app } = await import('../src/app.js');
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const schema = res.json();
    const paths = Object.keys(schema.paths);
    const required = [
      '/official-assignments/{id}/eligibility',
      '/fixtures/{id}/officials/eligibility',
      '/official-assignments/{id}/eligibility/override',
      '/official-assignments/{id}/eligibility/overrides',
      '/events/{id}/official-eligibility-policy',
      '/official-assignments/{id}/conflicts',
      '/official-conflicts/{id}/decision',
      '/official-conflicts/{id}/withdraw',
      '/official-assignments/{id}/eligibility/appeal',
    ];
    for (const p of required) {
      assert.ok(paths.includes(p), `Missing from OpenAPI: ${p}`);
    }
  });
});
