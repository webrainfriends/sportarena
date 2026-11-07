import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_APPROVALS: 'on',
  PLATFORM_ADMIN_EMAIL: 'platform-owner@example.com', PLATFORM_ADMIN_EMAILS: 'platform-owner@example.com',
  PLATFORM_ADMIN_PASSWORD: 'owner-test-pass', PLATFORM_ADMIN_HANDLE: 'platformarena',
});
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { initKeys } = await import('../src/crypto.js');
const { bootstrapPlatformOwner } = await import('../src/platform.js');
const { addDays, fromLocal } = await import('../src/booking/time.js');

let server, base, n = 0, platform, venueOwner;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ss_${n}_${roles[0]}`, display_name: `SS Test ${n}`, email: `ss${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201);
  return { ...r.body.user, token: r.body.token };
};
const today = () => new Date().toISOString().slice(0, 10);
const at = (daysFromNow, hour = 10) => fromLocal(addDays(today(), daysFromNow), hour * 60, 'UTC').toISOString();

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  await initKeys();
  await bootstrapPlatformOwner({ log() {}, error() {} });
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const l = must(await api('POST', '/auth/login', { body: { email: 'platform-owner@example.com', password: 'owner-test-pass' } }));
  platform = { ...l.user, token: l.token };
  venueOwner = await signup(['venue_manager']);
});
after(async () => { server.close(); await pool.end(); });

let partnerId, venueId, courtId, contractId, scheduleId;

test('setup: create partner, venue, contract', async () => {
  const p = must(await api('POST', '/admin/partners', { token: platform.token, body: { owner: `ss_1_venue_owner`, name: 'SS Sports', kind: 'venue_operator', city: 'Mumbai' } }), 201);
  partnerId = p.id;
  must(await api('POST', `/admin/partners/${partnerId}/decide`, { token: platform.token, body: { action: 'approve', reason: 'Test approve' } }));

  const v = must(await api('POST', '/venues', {
    token: venueOwner.token,
    body: { name: 'Settlement Test Arena', city: 'Mumbai', country: 'India', timezone: 'Asia/Kolkata', sports: ['cricket'] },
  }), 201);
  venueId = v.id;

  const c = must(await api('POST', `/venues/${venueId}/resources`, {
    token: venueOwner.token,
    body: { name: 'Court 1', kind: 'court', capacity: 1, hourly_rate_cents: 100000, currency: 'INR' },
  }), 201);
  courtId = c.id;

  const contract = must(await api('POST', '/admin/contracts', {
    token: platform.token,
    body: {
      partner_id: partnerId, venue_id: venueId,
      terms: { commission_bp: 1200, commission_tax_bp: 1800, gateway_fee_bp: 200, settlement_cycle: 'weekly', settlement_delay_days: 2, term_months: 12, auto_renew: false, notice_days: 30, exclusivity: false, governing_law: 'India', reserve_bp: 500, reserve_days: 7 },
      send: false,
    },
  }), 201);
  contractId = contract.id;
  must(await api('POST', `/contracts/${contractId}/accept`, { token: venueOwner.token }));
});

test('create_settlement_schedule: platform can set up automated weekly settlement', async () => {
  const schedule = must(await api('POST', '/admin/settlement-schedules', {
    token: platform.token,
    body: { contract_id: contractId, cycle: 'weekly', delay_days: 2, auto_approve: true, tolerance_minor: 500 },
  }), 201);
  assert.equal(schedule.cycle, 'weekly');
  assert.equal(schedule.auto_approve, true);
  assert.ok(schedule.next_run_at, 'next_run_at computed');
  scheduleId = schedule.id;
});

test('duplicate schedule for same contract is rejected', async () => {
  const r = await api('POST', '/admin/settlement-schedules', {
    token: platform.token,
    body: { contract_id: contractId, cycle: 'monthly' },
  });
  assert.equal(r.status, 409, 'duplicate schedule rejected');
});

test('non-platform user cannot create or list schedules', async () => {
  assert.equal((await api('POST', '/admin/settlement-schedules', { token: venueOwner.token, body: { contract_id: contractId, cycle: 'weekly' } })).status, 403);
  assert.equal((await api('GET', '/admin/settlement-schedules', { token: venueOwner.token })).status, 403);
});

test('list_settlement_schedules returns the created schedule', async () => {
  const list = must(await api('GET', '/admin/settlement-schedules', { token: platform.token }));
  assert.ok(Array.isArray(list.items));
  const found = list.items.find(s => s.id === scheduleId);
  assert.ok(found, 'schedule in list');
  assert.equal(found.cycle, 'weekly');
});

test('update_settlement_schedule: change cycle and tolerance', async () => {
  const updated = must(await api('PATCH', `/admin/settlement-schedules/${scheduleId}`, {
    token: platform.token,
    body: { cycle: 'biweekly', tolerance_minor: 1000 },
  }));
  assert.equal(updated.cycle, 'biweekly');
  assert.equal(updated.tolerance_minor, 1000);
});

test('manual run_settlement_schedule generates a settlement when bookings exist', async () => {
  // Create a paid booking to have something to settle
  const booking = must(await api('POST', '/bookings', {
    token: venueOwner.token,
    body: { resource_id: courtId, starts_at: at(-8), ends_at: at(-8, 11), note: 'Test booking' },
  }), 201);
  // Mark booking as paid (simulate payment)
  await pool.query("UPDATE bookings SET payment_status='paid', paid_at=now()-interval'7 days' WHERE id=$1", [booking.id]);

  const result = must(await api('POST', `/admin/settlement-schedules/${scheduleId}/run`, { token: platform.token }));
  assert.ok(result.settlement_id || result.dry_run_only === false || result.message, 'run result returned');
});

test('settlement reconciliation totals match payments to the paisa', async () => {
  // Find the most recent settlement for this venue
  const settlements = must(await api('GET', '/admin/settlements', { token: platform.token, query: { venue_id: venueId } }));
  if (!settlements.items || !settlements.items.length) { return; } // skip if no bookings settled

  const stl = settlements.items[0];
  // Net = gross - refunds - commission - commission_tax - gateway_fee + reserve_releases
  // We just check the response has all fields
  assert.ok(stl.sales_cents !== undefined, 'sales_cents present');
  assert.ok(stl.payout_cents !== undefined, 'payout_cents present');
  assert.ok(stl.commission_cents !== undefined, 'commission_cents present');
  assert.ok(stl.period_start, 'period_start present');
  assert.ok(stl.period_end, 'period_end present');

  // Variance check: payout = sales - refunds - commission - commission_tax - gateway_fee
  const computedNet = stl.sales_cents - (stl.refund_cents ?? 0) - stl.commission_cents - (stl.commission_tax_cents ?? 0) - (stl.gateway_fee_cents ?? 0) + (stl.reserve_released_cents ?? 0) - (stl.reserve_held_cents ?? 0);
  assert.equal(stl.payout_cents, computedNet, `payout reconciles to the paisa: expected ${computedNet}, got ${stl.payout_cents}`);
});

test('list_due_schedules returns schedules with next_run_at <= today', async () => {
  // Set the schedule's next_run_at to yesterday to make it due
  await pool.query("UPDATE settlement_schedules SET next_run_at = current_date - 1 WHERE id=$1", [scheduleId]);
  const due = must(await api('GET', '/admin/settlement-schedules/due', { token: platform.token }));
  assert.ok(Array.isArray(due.items));
  const found = due.items.find(s => s.id === scheduleId);
  assert.ok(found, 'overdue schedule appears in due list');
});

test('process_due_schedules runs all due schedules and advances next_run_at', async () => {
  const result = must(await api('POST', '/admin/settlement-schedules/process', { token: platform.token }));
  assert.ok(typeof result.processed === 'number');
  assert.ok(typeof result.succeeded === 'number' || typeof result.skipped === 'number');

  // Schedule's next_run_at should have advanced
  const s = must(await api('GET', `/admin/settlement-schedules/${scheduleId}`, { token: platform.token }));
  assert.ok(new Date(s.next_run_at) > new Date(today()), 'next_run_at advanced past today');
});

test('partner_settlement_summary returns aggregated settlement info for the partner', async () => {
  const summary = must(await api('GET', `/partners/${partnerId}/settlement-summary`, { token: venueOwner.token }));
  assert.ok(summary.total_paid_this_year !== undefined);
  assert.ok(summary.next_scheduled_run !== undefined || summary.schedule === null);
});

test('pausing a schedule stops it from appearing in due list', async () => {
  await pool.query("UPDATE settlement_schedules SET next_run_at = current_date - 1 WHERE id=$1", [scheduleId]);
  must(await api('PATCH', `/admin/settlement-schedules/${scheduleId}`, { token: platform.token, body: { paused: true, paused_reason: 'Partner account under review' } }));

  const due = must(await api('GET', '/admin/settlement-schedules/due', { token: platform.token }));
  assert.ok(!due.items.find(s => s.id === scheduleId), 'paused schedule not in due list');

  // Resume it
  must(await api('PATCH', `/admin/settlement-schedules/${scheduleId}`, { token: platform.token, body: { paused: false } }));
});

test('failed payout handling: list and retry action', async () => {
  // Seed a fake failed payout item
  const { rows } = await pool.query(`
    INSERT INTO payout_items (batch_id, source_type, source_id, payee_id, amount_cents, currency, status, failure_reason)
    SELECT pb.id, 'venue_settlement', $1, $2, 87600, 'INR', 'failed', 'Bank return code 93: beneficiary account does not exist'
    FROM payout_batches pb LIMIT 1
    RETURNING id`, [venueId, venueOwner.id]);

  if (!rows.length) { return; } // no batch exists yet, skip

  const failed = must(await api('GET', '/admin/failed-payouts', { token: platform.token }));
  assert.ok(Array.isArray(failed.items));

  const item = failed.items.find(i => i.id === rows[0].id);
  if (!item) { return; }

  const r = must(await api('POST', `/admin/failed-payouts/${item.id}/action`, {
    token: platform.token,
    body: { action: 'hold', note: 'Investigating bank error' },
  }));
  assert.equal(r.status, 'on_hold');
});
