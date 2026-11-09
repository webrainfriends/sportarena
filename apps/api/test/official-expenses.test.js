// Tests for official-expenses capability (#1008).
// Run with: npm test -- --grep official-expenses
import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { pool } from '../src/db.js';
import { buildApp } from '../src/app.js';

let app, officialToken, organiserToken, officialId, organiserId, fixtureOfficialId;

before(async () => {
  app = await buildApp();

  const { rows: [official] } = await pool.query(
    `INSERT INTO users (email, display_name) VALUES ('official-exp-test@test.invalid','Ref Expenses') ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
  );
  const { rows: [organiser] } = await pool.query(
    `INSERT INTO users (email, display_name) VALUES ('organiser-exp-test@test.invalid','Org Expenses') ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
  );
  officialId = official.id;
  organiserId = organiser.id;
  officialToken = `test-token-${official.id}`;
  organiserToken = `test-token-${organiser.id}`;

  const { rows: [ev] } = await pool.query(
    `INSERT INTO events (name, organizer_id, start_date, status) VALUES ('Exp Test Event', $1, now(), 'active') RETURNING id`,
    [organiserId],
  );
  const { rows: [fix] } = await pool.query(
    `INSERT INTO fixtures (event_id, name, sport, scheduled_at, status) VALUES ($1, 'Exp Match', 'football', now(), 'scheduled') RETURNING id`,
    [ev.id],
  );
  const { rows: [fo] } = await pool.query(
    `INSERT INTO fixture_officials (fixture_id, user_id, role, status, fee_minor, fee_currency)
     VALUES ($1, $2, 'referee', 'accepted', 10000, 'GBP') RETURNING id`,
    [fix.id, officialId],
  );
  fixtureOfficialId = fo.id;
});

after(async () => {
  await pool.query('DELETE FROM official_expenses WHERE official_id = $1', [officialId]);
  await pool.end();
});

const req = (method, path, body, token) =>
  app.inject({ method, url: `/api${path}`, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });

describe('official-expenses capability', () => {
  let expId1, expId2;

  it('official can create a draft expense', async () => {
    const res = await req('POST', `/official-assignments/${fixtureOfficialId}/expenses`, {
      id: fixtureOfficialId,
      category: 'travel',
      amount_minor: 3500,
      currency: 'GBP',
      description: 'Train to Manchester',
      idempotency_key: `exp-travel-${Date.now()}`,
    }, officialToken);
    assert.equal(res.statusCode, 201, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.category, 'travel');
    assert.equal(body.status, 'draft');
    assert.ok(!body.description, 'description_enc must not leak in list view');
    expId1 = body.id;
  });

  it('description is encrypted at rest', async () => {
    const { rows: [row] } = await pool.query('SELECT description_enc FROM official_expenses WHERE id=$1', [expId1]);
    assert.ok(row.description_enc, 'description_enc should be non-null');
    assert.ok(!row.description_enc.toString().includes('Train'), 'plaintext must not appear in DB');
  });

  it('get_expense decrypts description for the owner', async () => {
    const res = await req('GET', `/official-expenses/${expId1}`, null, officialToken);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.description, 'Train to Manchester');
  });

  it('official can submit the expense', async () => {
    const res = await req('POST', `/official-expenses/${expId1}/submit`, {}, officialToken);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).status, 'submitted');
  });

  it('organiser can approve the expense', async () => {
    const res = await req('POST', `/official-expenses/${expId1}/approve`, {}, organiserToken);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).status, 'approved');
  });

  it('double-approve returns conflict', async () => {
    const res = await req('POST', `/official-expenses/${expId1}/approve`, {}, organiserToken);
    assert.equal(res.statusCode, 409);
  });

  it('reject requires reason of at least 5 chars', async () => {
    // Create a second expense and submit it
    const r1 = await req('POST', `/official-assignments/${fixtureOfficialId}/expenses`, {
      id: fixtureOfficialId,
      category: 'accommodation',
      amount_minor: 15000,
      currency: 'GBP',
      idempotency_key: `exp-hotel-${Date.now()}`,
    }, officialToken);
    expId2 = JSON.parse(r1.body).id;
    await req('POST', `/official-expenses/${expId2}/submit`, {}, officialToken);

    // Reject with no reason → validation error
    const noReason = await req('POST', `/official-expenses/${expId2}/reject`, { reason: 'x' }, organiserToken);
    assert.equal(noReason.statusCode, 400);

    // Reject with valid reason
    const ok = await req('POST', `/official-expenses/${expId2}/reject`, { reason: 'Receipt is not valid' }, organiserToken);
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).status, 'rejected');
  });

  it('batch rejects mixed currencies', async () => {
    // Create a GBP and a USD expense, both approved
    const rGbp = await req('POST', `/official-assignments/${fixtureOfficialId}/expenses`, {
      id: fixtureOfficialId, category: 'travel', amount_minor: 1000, currency: 'GBP',
      idempotency_key: `batch-gbp-${Date.now()}`,
    }, officialToken);
    const rUsd = await req('POST', `/official-assignments/${fixtureOfficialId}/expenses`, {
      id: fixtureOfficialId, category: 'travel', amount_minor: 1000, currency: 'USD',
      idempotency_key: `batch-usd-${Date.now()}`,
    }, officialToken);
    const gbpId = JSON.parse(rGbp.body).id;
    const usdId = JSON.parse(rUsd.body).id;

    // Submit and approve both
    for (const id of [gbpId, usdId]) {
      await req('POST', `/official-expenses/${id}/submit`, {}, officialToken);
      await req('POST', `/official-expenses/${id}/approve`, {}, organiserToken);
    }

    const batchRes = await req('POST', '/official-expense-batches', { expense_ids: [gbpId, usdId] }, officialToken);
    assert.equal(batchRes.statusCode, 400, 'Mixed currencies must be rejected');
  });

  it('batch rejects non-approved expenses', async () => {
    // Create a draft expense (not submitted)
    const r = await req('POST', `/official-assignments/${fixtureOfficialId}/expenses`, {
      id: fixtureOfficialId, category: 'other', amount_minor: 500, currency: 'GBP',
      idempotency_key: `batch-draft-${Date.now()}`,
    }, officialToken);
    const draftExpId = JSON.parse(r.body).id;

    const batchRes = await req('POST', '/official-expense-batches', { expense_ids: [draftExpId] }, officialToken);
    assert.equal(batchRes.statusCode, 409, 'Non-approved expenses must be rejected');
  });

  it('batch groups approved same-currency expenses', async () => {
    // expId1 is already approved (from above) — create another GBP approved expense
    const r = await req('POST', `/official-assignments/${fixtureOfficialId}/expenses`, {
      id: fixtureOfficialId, category: 'subsistence', amount_minor: 2000, currency: 'GBP',
      idempotency_key: `batch-ok-${Date.now()}`,
    }, officialToken);
    const newExpId = JSON.parse(r.body).id;
    await req('POST', `/official-expenses/${newExpId}/submit`, {}, officialToken);
    await req('POST', `/official-expenses/${newExpId}/approve`, {}, organiserToken);

    const batchRes = await req('POST', '/official-expense-batches', { expense_ids: [expId1, newExpId] }, officialToken);
    assert.equal(batchRes.statusCode, 201, batchRes.body);
    const batch = JSON.parse(batchRes.body);
    assert.equal(batch.currency, 'GBP');
    assert.equal(Number(batch.total_minor), 3500 + 2000);
  });
});
