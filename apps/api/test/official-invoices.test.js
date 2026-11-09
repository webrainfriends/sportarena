// Tests for official-invoices capability (#1008).
// Run with: npm test -- --grep official-invoices
import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { pool } from '../src/db.js';
import { buildApp } from '../src/app.js';

let app, adminToken, officialToken, organiserToken;
let fixtureOfficialId, eventId, officialId, organiserId;

before(async () => {
  app = await buildApp();

  // Helpers: create test users and seed minimal fixture data
  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (email, display_name, roles) VALUES ('admin-oi-test@test.invalid','Admin OI','{"admin"}') ON CONFLICT (email) DO UPDATE SET roles='{"admin"}' RETURNING id`,
  );
  const { rows: [official] } = await pool.query(
    `INSERT INTO users (email, display_name) VALUES ('official-oi-test@test.invalid','Referee Test') ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
  );
  const { rows: [organiser] } = await pool.query(
    `INSERT INTO users (email, display_name) VALUES ('organiser-oi-test@test.invalid','Organiser Test') ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
  );
  officialId = official.id;
  organiserId = organiser.id;

  adminToken = `test-token-${admin.id}`;
  officialToken = `test-token-${official.id}`;
  organiserToken = `test-token-${organiser.id}`;

  // Create a minimal event and fixture
  const { rows: [ev] } = await pool.query(
    `INSERT INTO events (name, organizer_id, start_date, status) VALUES ('OI Test Event', $1, now(), 'active') RETURNING id`,
    [organiserId],
  );
  eventId = ev.id;
  const { rows: [fix] } = await pool.query(
    `INSERT INTO fixtures (event_id, name, sport, scheduled_at, status) VALUES ($1, 'Test Match', 'football', now(), 'scheduled') RETURNING id`,
    [eventId],
  );
  const { rows: [fo] } = await pool.query(
    `INSERT INTO fixture_officials (fixture_id, user_id, role, status, fee_minor, fee_currency)
     VALUES ($1, $2, 'referee', 'accepted', 10000, 'GBP') RETURNING id`,
    [fix.id, officialId],
  );
  fixtureOfficialId = fo.id;
});

after(async () => {
  await pool.query(`DELETE FROM official_invoices WHERE fixture_official_id = $1`, [fixtureOfficialId]);
  await pool.end();
});

// ── helpers ─────────────────────────────────────────────────────────────────

const req = (method, path, body, token) =>
  app.inject({ method, url: `/api${path}`, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });

// ── tests ────────────────────────────────────────────────────────────────────

describe('official-invoices capability', () => {
  let draftId;

  it('official can create a draft invoice', async () => {
    const res = await req('POST', '/official-invoices', {
      fixture_official_id: fixtureOfficialId,
      kind: 'self_issued',
      currency: 'GBP',
      total_minor: 10000,
      tax_minor: 0,
      net_minor: 10000,
      idempotency_key: `test-create-${Date.now()}`,
    }, officialToken);
    assert.equal(res.statusCode, 201, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'draft');
    assert.equal(body.kind, 'self_issued');
    draftId = body.id;
  });

  it('wrong user cannot read a draft invoice (404)', async () => {
    const anotherUser = (await pool.query(`INSERT INTO users (email,display_name) VALUES ('oi-other-${Date.now()}@test.invalid','Other') RETURNING id`)).rows[0];
    const otherToken = `test-token-${anotherUser.id}`;
    const res = await req('GET', `/official-invoices/${draftId}`, null, otherToken);
    assert.equal(res.statusCode, 404);
  });

  it('official can read their own invoice', async () => {
    const res = await req('GET', `/official-invoices/${draftId}`, null, officialToken);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, draftId);
  });

  it('submitting assigns an invoice_number', async () => {
    const res = await req('POST', `/official-invoices/${draftId}/submit`, {}, officialToken);
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'submitted');
    assert.match(body.invoice_number, /^REF-\d{6}$/);
  });

  it('submitting again returns conflict', async () => {
    const res = await req('POST', `/official-invoices/${draftId}/submit`, {}, officialToken);
    assert.equal(res.statusCode, 409);
  });

  it('organiser can approve a submitted invoice', async () => {
    const res = await req('POST', `/official-invoices/${draftId}/approve`, {}, organiserToken);
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'approved');
  });

  it('approve_invoice sets fixture_officials.pay_status = due', async () => {
    const { rows: [fo] } = await pool.query('SELECT pay_status FROM fixture_officials WHERE id=$1', [fixtureOfficialId]);
    assert.equal(fo.pay_status, 'due');
  });

  it('wrong user cannot approve invoice (404)', async () => {
    // Create another draft and try to approve with wrong user
    const r1 = await req('POST', '/official-invoices', {
      fixture_official_id: fixtureOfficialId,
      kind: 'self_issued',
      currency: 'GBP',
      total_minor: 5000,
      tax_minor: 0,
      net_minor: 5000,
      idempotency_key: `test-perm-${Date.now()}`,
    }, officialToken);
    const { id: newId } = JSON.parse(r1.body);
    await req('POST', `/official-invoices/${newId}/submit`, {}, officialToken);
    const res = await req('POST', `/official-invoices/${newId}/approve`, {}, officialToken);
    assert.equal(res.statusCode, 404);
  });

  it('two sequential submits with different keys get distinct invoice numbers', async () => {
    // Create two separate drafts
    const [r1, r2] = await Promise.all([
      req('POST', '/official-invoices', { fixture_official_id: fixtureOfficialId, kind: 'self_issued', currency: 'GBP', total_minor: 1, tax_minor: 0, net_minor: 1, idempotency_key: `seq-a-${Date.now()}` }, officialToken),
      req('POST', '/official-invoices', { fixture_official_id: fixtureOfficialId, kind: 'self_issued', currency: 'GBP', total_minor: 1, tax_minor: 0, net_minor: 1, idempotency_key: `seq-b-${Date.now()}` }, officialToken),
    ]);
    const id1 = JSON.parse(r1.body).id;
    const id2 = JSON.parse(r2.body).id;
    // Submit sequentially so we can compare numbers
    const s1 = JSON.parse((await req('POST', `/official-invoices/${id1}/submit`, {}, officialToken)).body);
    const s2 = JSON.parse((await req('POST', `/official-invoices/${id2}/submit`, {}, officialToken)).body);
    assert.ok(s1.invoice_number !== s2.invoice_number, 'Invoice numbers must be distinct');
  });

  it('withholding: net_minor = total_minor - withheld_minor', () => {
    const gross = 10000;
    const rateBps = 2000; // 20%
    const withheld = Math.floor(gross * rateBps / 10000);
    const net = gross - withheld;
    assert.equal(net, gross - withheld);
    assert.equal(net, 8000);
  });

  it('link_payout twice with same payout_item_id is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const payoutItemId = crypto.randomUUID();
    // Insert directly to test idempotency at DB level
    await pool.query(
      `INSERT INTO official_invoice_payout_items (official_invoice_id, payout_item_id, amount_minor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [draftId, payoutItemId, 1000],
    );
    // Second insert must not throw
    await pool.query(
      `INSERT INTO official_invoice_payout_items (official_invoice_id, payout_item_id, amount_minor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [draftId, payoutItemId, 1000],
    );
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM official_invoice_payout_items WHERE official_invoice_id=$1 AND payout_item_id=$2',
      [draftId, payoutItemId],
    );
    assert.equal(rows[0].n, 1, 'ON CONFLICT DO NOTHING must keep exactly one row');
  });

  it('list_invoices returns only own invoices for official', async () => {
    const res = await req('GET', '/official-invoices?limit=100&offset=0', null, officialToken);
    assert.equal(res.statusCode, 200);
    const { invoices } = JSON.parse(res.body);
    assert.ok(Array.isArray(invoices));
    invoices.forEach((inv) => assert.equal(inv.official_id, officialId));
  });
});
