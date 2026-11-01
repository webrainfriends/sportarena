// India GST on venue invoices and credit notes (#694 / #503): a venue with a GST profile shows CGST+SGST for a buyer in its own state and IGST
// for a buyer in another state; a credit note reverses the same split; ownership is enforced; venues without a profile are untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { slotAhead } from './support/slots.js';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { fromLocal, addDays } = await import('../src/booking/time.js');
const { gstinCheckDigit } = await import('../src/gst.js');

let server, base, n = 0;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `gst_${n}_${roles[0]}`, display_name: `Gst ${n}`, email: `gst${n}@example.com`, password: 'correct-horse-battery', roles } }); return { ...must(r, 201).user, token: r.body.token }; };
const today = new Date().toISOString().slice(0, 10);
const at = (d, h) => fromLocal(addDays(today, d), h * 60, 'UTC').toISOString();
const gstin = (state) => { const b = `${state}AAPFU0939F1Z`; return b + gstinCheckDigit(b); };
const venue = async (mgr) => {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Gst Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR', cancel_free_hours: 24, late_cancel_refund_percent: 50 } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 118000 } }), 201);
  return { v, court };
};
const book = (u, court, d, h, extra = {}) => api('POST', '/reservations', { token: u.token, body: { items: [{ resource_id: court.id, starts_at: at(d, h), ends_at: at(d, h + 1) }], ...extra } });

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test('profile: only the venue team sets it, a bad GSTIN is refused, replacing archives the old one', async () => {
  const mgr = await signup(['venue_manager']); const { v } = await venue(mgr); const other = await signup(['venue_manager']);
  const path = `/gst-profiles/venue/${v.id}`;
  assert.equal((await api('POST', path, { token: other.token, body: { gstin: gstin('27') } })).status, 404, 'outsiders learn nothing');
  assert.equal((await api('GET', path, { token: other.token })).status, 404);
  const wrongCheck = await api('POST', path, { token: mgr.token, body: { gstin: '27AAPFU0939F1Z0' } });
  assert.equal(wrongCheck.status, 400);
  assert.match(JSON.stringify(wrongCheck.body), /check\) character/, 'right format, wrong check digit says so');
  const badFormat = await api('POST', path, { token: mgr.token, body: { gstin: '27AAPFU0939' } });
  assert.equal(badFormat.status, 400);
  assert.match(JSON.stringify(badFormat.body), /15 characters/, 'wrong format says so');
  const p = must(await api('POST', path, { token: mgr.token, body: { gstin: gstin('27'), default_sac: '9993' } })).profile;
  assert.equal(p.state_code, '27'); assert.equal(p.rate_bp, 1800);
  must(await api('POST', path, { token: mgr.token, body: { gstin: gstin('29'), tax_inclusive: true } }));
  assert.equal(must(await api('GET', path, { token: mgr.token })).profile.state_code, '29');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM gst_profiles WHERE owner_id=$1', [v.id])).rows[0].n, 2, 'history kept');
});

test('same-state buyer gets CGST+SGST, other-state buyer gets IGST, and a cancellation credit note reverses the split', async () => {
  const mgr = await signup(['venue_manager']); const { v, court } = await venue(mgr);
  must(await api('POST', `/gst-profiles/venue/${v.id}`, { token: mgr.token, body: { gstin: gstin('27') } }));
  const u = await signup();
  const a = must(await book(u, court, 3, 10), 201);
  const ia = must(await api('GET', `/invoices/${a.invoices[0].id}`, { token: u.token }));
  assert.equal(ia.tax_name, 'GST');
  assert.equal(ia.tax_cents, 18000);
  const sa = ia.tax_breakup;
  assert.deepEqual([sa.supply, sa.taxable_cents, sa.cgst_cents, sa.sgst_cents, sa.igst_cents], ['intra_state', 100000, 9000, 9000, 0]);

  const b = must(await book(u, court, 4, 10, { billing: { name: 'Buyer Pvt Ltd', address: 'Bengaluru', tax_id: gstin('29') } }), 201);
  const sb = must(await api('GET', `/invoices/${b.invoices[0].id}`, { token: u.token })).tax_breakup;
  assert.deepEqual([sb.supply, sb.cgst_cents, sb.sgst_cents, sb.igst_cents, sb.buyer_gstin], ['inter_state', 0, 0, 18000, gstin('29')]);

  // pay, then cancel well ahead: the credit note carries the same split, reversed
  must(await api('POST', `/invoices/${b.invoices[0].id}/paid`, { token: mgr.token, body: { method: 'upi' } }));
  const view = must(await api('GET', `/reservations/${b.id}`, { token: u.token }));
  must(await api('DELETE', `/bookings/${view.bookings[0].id}`, { token: u.token }));
  const after = must(await api('GET', `/reservations/${b.id}`, { token: u.token }));
  const cn = after.invoices.find((i) => i.kind === 'credit_note');
  assert.ok(cn, 'a credit note was issued');
  const full = must(await api('GET', `/invoices/${cn.id}`, { token: u.token })).tax_breakup;
  assert.equal(full.reversal, true); assert.equal(full.igst_cents, 18000); assert.equal(full.cgst_cents + full.sgst_cents, 0);
});

test('a venue without a GST profile is unchanged (plain venue tax, no breakup)', async () => {
  const mgr = await signup(['venue_manager']); const { court } = await venue(mgr); const u = await signup();
  const r = must(await book(u, court, 5, 10), 201);
  const doc = must(await api('GET', `/invoices/${r.invoices[0].id}`, { token: u.token }));
  assert.equal(doc.tax_breakup, null);
  assert.notEqual(doc.tax_name, 'GST');
});
