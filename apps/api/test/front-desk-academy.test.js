import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// The academy and the venue share ONE front desk: an academy's venue sells kit, rents equipment and collects the academy's own fees
// through the same POS code, settling the academy's canonical charge and invoice.
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fa_${n}`, display_name: `FA ${n}`, email: `fa${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], dob: yearsAgo(30), ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('an academy front desk sells kit, rents equipment and collects the academy fee on the canonical charge', async () => {
  const owner = await signup({ roles: ['athlete', 'venue_manager'] });
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Desk Academy', kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } }));
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: 'U12 Football', capacity: 5, admission_mode: 'direct', public: true } }), 201);
  must(await api('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'one_time', currency: 'GBP', fee_minor: 12000 } }), 201);
  const parent = await signup();
  const enq = must(await api('POST', `/academy/programmes/${prog.id}/applications`, { token: parent.token, body: {} }), 201);
  must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: parent.token, body: { row_version: enq.row_version, answers: {} } }));
  const charge = (await pool.query("SELECT * FROM academy_charges WHERE payer_id=$1", [parent.id])).rows[0];
  assert.equal(charge.status, 'awaiting_payment');

  // the academy's training venue is a venue of the organisation; its owner is the academy owner
  const v = must(await api('POST', '/venues', { token: owner.token, body: { name: 'Academy Ground', timezone: 'UTC', currency: 'GBP' } }), 201);
  await pool.query('UPDATE venues SET organisation_id=$2 WHERE id=$1', [v.id, org.id]);
  const kit = must(await api('POST', '/inventory', { token: owner.token, body: { venue_id: v.id, name: 'Academy shirt', category: 'apparel', quantity: 10, sell_price_cents: 2500 } }), 201);
  const cashier = await signup();
  must(await api('POST', `/venues/${v.id}/pos/cashiers`, { token: owner.token, body: { handle: cashier.handle } }), 201);

  // a venue that is not the academy's cannot collect its fees
  const other = must(await api('POST', '/venues', { token: owner.token, body: { name: 'Elsewhere', timezone: 'UTC', currency: 'GBP' } }), 201);
  const wrong = await api('POST', `/venues/${other.id}/pos/sales`, { token: owner.token, body: { lines: [{ kind: 'academy_charge', charge_id: charge.id }], payments: [{ method: 'cash' }] } });
  assert.equal(wrong.status, 404);
  // …and a charge in another currency is refused
  const inr = must(await api('POST', '/venues', { token: owner.token, body: { name: 'INR ground', timezone: 'UTC', currency: 'INR' } }), 201);
  await pool.query('UPDATE venues SET organisation_id=$2 WHERE id=$1', [inr.id, org.id]);
  assert.equal((await api('POST', `/venues/${inr.id}/pos/sales`, { token: owner.token, body: { lines: [{ kind: 'academy_charge', charge_id: charge.id }], payments: [{ method: 'cash' }] } })).status, 400);

  const sale = must(await api('POST', `/venues/${v.id}/pos/sales`, { token: cashier.token, body: {
    lines: [{ kind: 'academy_charge', charge_id: charge.id }, { kind: 'item', item_id: kit.id, qty: 2 }], customer_handle: parent.handle, payments: [{ method: 'cash', tendered_cents: 20000 }] } }), 201);
  assert.equal(sale.status, 'paid');
  assert.equal(sale.total_cents, 12000 + 5000);
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [charge.id])).rows[0].status, 'paid');
  const inv = (await pool.query("SELECT status, payment_method FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [charge.id])).rows[0];
  assert.deepEqual([inv.status, inv.payment_method], ['paid', 'cash']);
  assert.equal((await pool.query('SELECT quantity FROM inventory_items WHERE id=$1', [kit.id])).rows[0].quantity, 8);
  // a charge already collected cannot be taken twice
  assert.equal((await api('POST', `/venues/${v.id}/pos/sales`, { token: cashier.token, body: { lines: [{ kind: 'academy_charge', charge_id: charge.id }], payments: [{ method: 'cash' }] } })).status, 409);
  const rep = must(await api('GET', `/venues/${v.id}/pos/report`, { token: owner.token }));
  assert.equal(rep.reconciliation.reconciled, true, JSON.stringify(rep.reconciliation));
  assert.equal(rep.by_category.find((c) => c.category === 'academy').total_cents, 12000);
});
