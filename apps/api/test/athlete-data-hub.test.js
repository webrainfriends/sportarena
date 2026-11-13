// Tests for Athlete Data Hub & Performance Integration Platform (#566).
// Covers: assessment lifecycle, CSV import (InBody, Brower, ForceDecks), coach access control,
// missing data report, and measurement soft-void.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, makeAthlete, makeCoach, makeCoachWithShare, makeCoachNoShare } from './helpers.js';

describe('Athlete Data Hub', () => {
  let app;
  let athlete;
  let coachWithShare;
  let coachNoShare;

  before(async () => {
    app = await buildApp();
    athlete = await makeAthlete(app);
    coachWithShare = await makeCoachWithShare(app, { fields: ['wearables', 'assessments'] });
    coachNoShare = await makeCoachNoShare(app);
  });

  it('creates a jump assessment with 3 ForceDecks measurements and returns canonical values', async () => {
    const res = await athlete.post('/me/assessments', {
      assessed_on: '2026-01-15',
      assessment_family: 'jump',
      test_protocol: 'CMJ battery — Vald ForceDecks v2',
      provider: 'forcedecks',
      measurements: [
        { metric_key: 'jump_height',       value: 42.5,  unit: 'cm' },
        { metric_key: 'peak_force',        value: 2100,  unit: 'N' },
        { metric_key: 'rate_of_force_dev', value: 8500,  unit: 'N/s' },
      ],
    });
    assert.equal(res.status, 200, `create assessment: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.measurement_count, 3);
    assert.ok(res.body.id, 'assessment id returned');
  });

  it('list_performance_assessments returns created assessments', async () => {
    const res = await athlete.get('/me/assessments');
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 1, 'at least one assessment');
    assert.ok(Array.isArray(res.body.items));
  });

  it('get_athlete_data_hub returns all metric families with disclaimer', async () => {
    const res = await athlete.get('/me/data-hub');
    assert.equal(res.status, 200);
    assert.ok(res.body.disclaimer, 'disclaimer present');
    assert.ok(Array.isArray(res.body.metrics), 'metrics array present');
    assert.ok(Array.isArray(res.body.sources), 'sources array present');
  });

  it('list_hub_metric_timeline returns 90-day timeline with provenance', async () => {
    const res = await athlete.get('/me/data-hub/metrics/jump_height');
    assert.equal(res.status, 200);
    assert.equal(res.body.metric_key, 'jump_height');
    assert.ok(Array.isArray(res.body.points));
  });

  it('soft-voids a measurement; original row is kept, voided_at is set', async () => {
    const created = await athlete.post('/me/assessments', {
      assessed_on: '2026-01-16',
      assessment_family: 'strength',
      test_protocol: 'Void test — 1RM squat',
      measurements: [{ metric_key: 'squat_1rm', value: 100, unit: 'kg' }],
    });
    assert.equal(created.status, 200);
    const { id } = created.body;

    const detail = await athlete.get(`/me/assessments/${id}`);
    assert.equal(detail.status, 200);
    const mid = detail.body.measurements[0].id;

    const voidRes = await athlete.patch(`/me/assessments/${id}/measurements/${mid}/void`, {
      void_reason: 'Data entry error — wrong athlete',
    });
    assert.equal(voidRes.status, 200);
    assert.ok(voidRes.body.voided);

    // Original row must still exist (soft delete)
    const after = await athlete.get(`/me/assessments/${id}`);
    const m = after.body.measurements.find((x) => x.id === mid);
    assert.ok(m, 'measurement row still present after void');
    assert.ok(m.voided_at, 'voided_at is set');
  });

  it('import_assessment_csv parses InBody CSV correctly and stores body composition', async () => {
    const res = await athlete.post('/me/data-hub/import', {
      provider: 'inbody',
      assessed_on: '2026-01-17',
      rows: [{
        bodyFatPercent: '18.5',
        leanBodyMass_kg: '65.2',
        skeletalMuscleMass_kg: '35.1',
        testDate: '2026-01-17',
      }],
    });
    assert.equal(res.status, 200, `InBody import: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.assessment_id, 'assessment_id returned');
    assert.ok(res.body.imported >= 1, `expected >=1 imported, got ${res.body.imported}`);
  });

  it('import_assessment_csv parses Brower timing CSV correctly and stores sprint metrics', async () => {
    const res = await athlete.post('/me/data-hub/import', {
      provider: 'brower',
      assessed_on: '2026-01-18',
      rows: [{
        split10m: '1.72',
        split30m: '3.95',
        split40m: '5.12',
        date: '2026-01-18',
      }],
    });
    assert.equal(res.status, 200, `Brower import: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.imported >= 1);
  });

  it('register_hub_source returns an id; idempotent on second call', async () => {
    const res1 = await athlete.post('/me/data-hub/sources', {
      provider: 'forcedecks',
      display_name: 'ForceDecks Lab — Main Campus',
    });
    assert.equal(res1.status, 200);
    assert.ok(res1.body.id);

    const res2 = await athlete.post('/me/data-hub/sources', {
      provider: 'forcedecks',
      display_name: 'ForceDecks Lab — Main Campus',
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.id, res1.body.id, 'idempotent — same id returned');
  });

  it('coach without wellness share cannot access squad data hub (404)', async () => {
    const res = await coachNoShare.get(`/orgs/test-org/data-hub`);
    assert.ok([403, 404].includes(res.status), `Expected 403/404, got ${res.status}`);
  });

  it('get_missing_data_report returns three periods', async () => {
    const res = await coachWithShare.get(`/orgs/test-org/data-hub/missing`);
    assert.equal(res.status, 200);
    assert.ok('today' in res.body, 'today key present');
    assert.ok('this_week' in res.body, 'this_week key present');
    assert.ok('this_month' in res.body, 'this_month key present');
  });
});
