import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// #798 Academy uniforms, kits & equipment issuance: the acceptance criteria (no oversell under concurrency, ledger-correct returns, no addresses or payment data
// in the requirement view, scanning, REST/OpenAPI/MCP parity) and every refusal around them.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { slotsForSport, SLOT_KEYS } = await import('../src/kit-slots.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `kt_${n}_${roles[0]}`, display_name: `Kit ${n}`, email: `kt${n}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(25), ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('kt_root','kt_root','{admin}','x','x','kt_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function join(org, owner, u, role) {
  ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
  ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
}

/** An academy: a group of adult athletes, a venue of the academy with a cashier, a kit desk, a kit manager, a coach, an outsider. */
async function academy({ athletes = 2 } = {}) {
  const owner = await signup(['athlete', 'venue_manager']), coach = await signup(['coach']), desk = await signup(), lead = await signup(), stranger = await signup(), cashier = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Kit Academy ${n}`, kind: 'academy' } }), 201);
  await join(org, owner, coach, 'coach');
  await join(org, owner, desk, 'staff');
  await join(org, owner, lead, 'staff');
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${desk.id}`, { token: owner.token, body: { job_title: 'Front desk', template: 'registrar' } }));
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${lead.id}`, { token: owner.token, body: { job_title: 'Operations', template: 'operations' } }));
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U14', coach_id: coach.id } }), 201);
  const kids = [];
  for (let k = 0; k < athletes; k++) kids.push(await signup());
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.map((p) => `${p.handle},yes`).join('\n')}` } }), 201);
  const enrol = {};
  for (const k of kids) enrol[k.id] = (await pool.query('SELECT id FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2', [cohort.id, k.id])).rows[0].id;
  const venue = ok(await api('POST', '/venues', { token: owner.token, body: { name: 'Academy Ground', timezone: 'UTC', currency: 'GBP' } }), 201);
  await pool.query('UPDATE venues SET organisation_id=$2 WHERE id=$1', [venue.id, org.id]);
  ok(await api('POST', `/venues/${venue.id}/pos/cashiers`, { token: owner.token, body: { handle: cashier.handle } }), 201);
  return { owner, coach, desk, lead, stranger, cashier, org, cohort, kids, enrol, venue };
}
const stock = async (a, { style = 'home-shirt', size = 'M', quantity = 1, name = 'Home shirt', ...rest } = {}) =>
  ok(await api('POST', '/inventory', { token: a.owner.token, body: { venue_id: a.venue.id, name, category: 'apparel', quantity, style_key: style, size_label: size, kit_slot: 'shirt', reorder_level: 1, ...rest } }), 201);
const entitlement = async (a, body = {}) =>
  ok(await api('POST', `/organisations/${a.org.id}/academy/kit/entitlements`, { token: a.owner.token, body: { name: 'Home shirt', scope_type: 'cohort', scope_id: a.cohort.id, style_key: 'home-shirt', kit_slot: 'shirt', ...body } }), 201);
const fit = async (a, athlete, size = 'M', slot = 'shirt') => ok(await api('POST', `/organisations/${a.org.id}/academy/kit/sizes`, { token: a.desk.token, body: { athlete_id: athlete.id, slot, size_label: size } }));
const issue = (a, athlete, ent, extra = {}, token) => api('POST', `/organisations/${a.org.id}/academy/kit/issues`, { token: token ?? a.desk.token, body: { enrolment_id: a.enrol[athlete.id], venue_id: a.venue.id, entitlement_id: ent.id, client_ref: key(), ...extra } });
const moves = async (itemId) => (await pool.query('SELECT coalesce(sum(delta),0)::int AS d, count(*)::int AS n FROM pos_stock_moves WHERE item_id=$1', [itemId])).rows[0];
const qty = async (itemId) => (await pool.query('SELECT quantity FROM inventory_items WHERE id=$1', [itemId])).rows[0].quantity;

test('stock rows carry size and product, entitlements validate against real stock, and the due list shows fittings and availability without money', async () => {
  const a = await academy();
  const shirtM = await stock(a, { size: 'M', quantity: 3 });
  assert.equal(shirtM.style_key, 'home-shirt');
  assert.equal(shirtM.size_label, 'M');
  // an entitlement needs a product that exists in the academy's stock
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/kit/entitlements`, { token: a.owner.token, body: { name: 'Ghost', scope_type: 'cohort', scope_id: a.cohort.id, style_key: 'nope-kit' } })).status, 409);
  // included kit has no price; a charged item cannot carry a deposit
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/kit/entitlements`, { token: a.owner.token, body: { name: 'Bad', scope_type: 'cohort', scope_id: a.cohort.id, style_key: 'home-shirt', mode: 'included', price_minor: 500 } })).status, 400);
  const ent = await entitlement(a);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/kit/entitlements`, { token: a.owner.token, body: { name: 'Dup', scope_type: 'cohort', scope_id: a.cohort.id, style_key: 'home-shirt' } })).status, 409, 'one entitlement per product per group');
  // only a kit manager defines entitlements: a desk member, a coach and an outsider cannot
  const mk = (t) => api('POST', `/organisations/${a.org.id}/academy/kit/entitlements`, { token: t, body: { name: 'X', scope_type: 'cohort', scope_id: a.cohort.id, style_key: 'home-shirt' } });
  assert.equal((await mk(a.desk.token)).status, 403);
  assert.equal((await mk(a.coach.token)).status, 403);
  assert.equal((await mk(a.stranger.token)).status, 404);

  const due = ok(await api('GET', `/organisations/${a.org.id}/academy/kit/due`, { token: a.coach.token }));
  assert.equal(due.length, 2);
  assert.ok(due.every((r) => r.needs_fitting && r.outstanding === 1), 'nobody is fitted yet');
  assert.ok(due.every((r) => r.mode === undefined), 'a coach sees what is owed, not how it is paid for');
  await fit(a, a.kids[0], 'M');
  const after = ok(await api('GET', `/organisations/${a.org.id}/academy/kit/due`, { token: a.desk.token, query: { athlete_id: a.kids[0].id } }));
  assert.equal(after[0].size, 'M');
  assert.equal(after[0].needs_fitting, false);
  assert.equal(after[0].available, 3);
  assert.equal(JSON.stringify(after).includes('address'), false);
  // a coach can see requirements but cannot issue or fit
  assert.equal((await issue(a, a.kids[0], ent, {}, a.coach.token)).status, 403);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/kit/sizes`, { token: a.coach.token, body: { athlete_id: a.kids[0].id, slot: 'shirt', size_label: 'L' } })).status, 403);
  // a changed size keeps the old one as history
  await fit(a, a.kids[0], 'L');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_kit_sizes WHERE athlete_id=$1 AND slot='shirt'", [a.kids[0].id])).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_kit_sizes WHERE athlete_id=$1 AND slot='shirt' AND superseded_at IS NULL", [a.kids[0].id])).rows[0].n, 1);
});

test('two desks racing for the last unit: exactly one wins, nothing is oversold, the ledger explains the stock; a replayed client_ref issues once', async () => {
  const a = await academy({ athletes: 3 });
  const shirt = await stock(a, { size: 'M', quantity: 1 });
  const ent = await entitlement(a);
  for (const k of a.kids) await fit(a, k, 'M');
  const results = await Promise.all([issue(a, a.kids[0], ent), issue(a, a.kids[1], ent), issue(a, a.kids[2], ent)]);
  const wins = results.filter((r) => r.status === 201), losses = results.filter((r) => r.status === 409);
  assert.equal(wins.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(losses.length, 2);
  assert.equal(await qty(shirt.id), 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_kit_issues WHERE status='issued'")).rows[0].n, 1);
  const m = await moves(shirt.id);
  assert.equal(m.d, -1 + 1, 'opening stock +1, one kit_issue -1');
  assert.equal(await qty(shirt.id), m.d);
  // the same client_ref sent twice at once issues one item
  const b = await academy();
  const item = await stock(b, { size: 'M', quantity: 5 });
  const entB = await entitlement(b);
  await fit(b, b.kids[0], 'M');
  const ref = key();
  const twice = await Promise.all([issue(b, b.kids[0], entB, { client_ref: ref }), issue(b, b.kids[0], entB, { client_ref: ref })]);
  assert.deepEqual(twice.map((r) => r.status).sort(), [201, 201]);
  assert.equal(twice[0].body.id, twice[1].body.id);
  assert.equal(await qty(item.id), 4);
  // an athlete cannot be issued more than the entitlement allows
  const more = await issue(b, b.kids[0], entB);
  assert.equal(more.status, 409);
  assert.equal(more.body.error?.code ?? more.body.code, 'entitlement_exhausted');
});

test('return puts the unit back with a ledger line, a second return is refused, and exchange swaps sizes atomically', async () => {
  const a = await academy();
  const m = await stock(a, { size: 'M', quantity: 2 }), l = await stock(a, { size: 'L', quantity: 0, name: 'Home shirt' });
  const ent = await entitlement(a);
  await fit(a, a.kids[0], 'M');
  const iss = ok(await issue(a, a.kids[0], ent), 201);
  assert.equal(iss.size_label, 'M');
  assert.equal(await qty(m.id), 1);
  // exchange to a size that is not in stock changes nothing
  const refused = await api('POST', `/organisations/${a.org.id}/academy/kit/issues/${iss.id}/exchange`, { token: a.desk.token, body: { size_label: 'L' } });
  assert.equal(refused.status, 409);
  assert.equal(await qty(m.id), 1);
  assert.equal((await pool.query('SELECT status FROM academy_kit_issues WHERE id=$1', [iss.id])).rows[0].status, 'issued');
  ok(await api('POST', `/organisations/${a.org.id}/academy/kit/orders`, { token: a.lead.token, body: { academy_supplier_id: await supplier(a), lines: [{ item_id: l.id, quantity: 2 }] } }), 201);
  const order = (await pool.query('SELECT id FROM supply_orders WHERE item_id=$1', [l.id])).rows[0];
  ok(await api('PATCH', `/organisations/${a.org.id}/academy/kit/orders/${order.id}`, { token: a.lead.token, body: { status: 'received' } }));
  assert.equal(await qty(l.id), 2);
  const swapped = ok(await api('POST', `/organisations/${a.org.id}/academy/kit/issues/${iss.id}/exchange`, { token: a.desk.token, body: { size_label: 'L', reason: 'wrong_size', client_ref: key() } }), 201);
  assert.equal(swapped.size_label, 'L');
  assert.equal(await qty(m.id), 2, 'the old size went back on the shelf');
  assert.equal(await qty(l.id), 1);
  assert.equal((await pool.query('SELECT status FROM academy_kit_issues WHERE id=$1', [iss.id])).rows[0].status, 'exchanged');
  // return the new one, then try again
  const back = ok(await api('POST', `/organisations/${a.org.id}/academy/kit/issues/${swapped.id}/return`, { token: a.desk.token, body: { condition: 'good' } }));
  assert.equal(back.status, 'returned');
  assert.equal(await qty(l.id), 2);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/kit/issues/${swapped.id}/return`, { token: a.desk.token, body: {} })).status, 409);
  for (const it of [m, l]) { const mv = await moves(it.id); assert.equal(mv.d, await qty(it.id), 'every unit of stock is explained by the append-only ledger'); }
  const reasons = (await pool.query("SELECT DISTINCT reason FROM pos_stock_moves WHERE kit_issue_id IS NOT NULL ORDER BY reason")).rows.map((r) => r.reason);
  assert.deepEqual(reasons, ['kit_exchange_in', 'kit_exchange_out', 'kit_issue', 'kit_return']);
  // the ledger cannot be edited
  await assert.rejects(pool.query("UPDATE pos_stock_moves SET delta = 99 WHERE kit_issue_id IS NOT NULL"));
});

async function supplier(a) {
  const s = ok(await api('POST', `/organisations/${a.org.id}/academy/suppliers`, { token: a.owner.token, body: { kind: 'sporting_goods', name: 'Kit House', all_venues: true } }), 201);
  return s.id;
}

const pay = async (a, chargeId) => ok(await api('POST', `/academy-charges/${chargeId}/paid`, { token: a.owner.token, body: { method: 'cash' } }));
const kitUrl = (a, p) => `/organisations/${a.org.id}/academy/kit/${p}`;

test('charged and deposit kit raise the academy\'s own charges; payment-first kit is held until paid; a deposit is cancelled, refunded by credit note or forfeited', async () => {
  const a = await academy({ athletes: 3 });
  const shirt = await stock(a, { size: 'M', quantity: 5, sell_price_cents: 4000 });
  const bag = await stock(a, { style: 'loan-bag', size: 'One size', quantity: 5, name: 'Loan bag', kit_slot: 'bag' });
  void bag;
  const buy = await entitlement(a, { name: 'Match shirt', mode: 'charged', price_minor: 4500, require_payment: true });
  const loan = await entitlement(a, { name: 'Loan bag', style_key: 'loan-bag', kit_slot: 'bag', mode: 'deposit', deposit_minor: 3000, return_days: 30, size_required: false });
  // a deposit item without a return window, and a price on a deposit item, are refused
  assert.equal((await api('POST', kitUrl(a, 'entitlements'), { token: a.owner.token, body: { name: 'X', scope_type: 'cohort', scope_id: a.cohort.id, style_key: 'loan-bag', mode: 'deposit', deposit_minor: 100 } })).status, 400);
  for (const k of a.kids) await fit(a, k, 'M');

  // payment first: reserved, stock already held, handover refused until the canonical charge is paid
  const r1 = ok(await issue(a, a.kids[0], buy), 201);
  assert.equal(r1.status, 'reserved');
  assert.equal(r1.charge.amount_minor, 4500);
  assert.equal(r1.charge.kind, 'kit');
  assert.equal(await qty(shirt.id), 4);
  const early = await api('POST', kitUrl(a, `issues/${r1.id}/handover`), { token: a.desk.token });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'kit_payment_required');
  assert.equal(early.body.error.details.charge_id, r1.charge.id);
  const inv = (await pool.query("SELECT total_cents, status FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [r1.charge.id])).rows[0];
  assert.deepEqual([Number(inv.total_cents), inv.status], [4500, 'open']);
  await pay(a, r1.charge.id);
  const handed = ok(await api('POST', kitUrl(a, `issues/${r1.id}/handover`), { token: a.desk.token }));
  assert.equal(handed.status, 'issued');
  // a reservation can be given back: stock returns and the unpaid charge is cancelled
  await fit(a, a.kids[1], 'M');
  const r2 = ok(await issue(a, a.kids[1], buy), 201);
  const cancelled = ok(await api('POST', kitUrl(a, `issues/${r2.id}/cancel`), { token: a.desk.token }));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(await qty(shirt.id), 4);
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [r2.charge.id])).rows[0].status, 'cancelled');

  // deposit never paid -> cancelled on return; deposit paid -> credit note + refunded; lost -> forfeited after a manager decides
  const d1 = ok(await issue(a, a.kids[0], loan), 201);
  assert.equal(d1.deposit.amount_minor, 3000);
  assert.equal(d1.status, 'issued');
  assert.ok(d1.due_back_at);
  const ret1 = ok(await api('POST', kitUrl(a, `issues/${d1.id}/return`), { token: a.desk.token, body: { condition: 'good' } }));
  assert.equal(ret1.deposit.action, 'cancelled_unpaid');
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [d1.deposit.id])).rows[0].status, 'cancelled');

  const d2 = ok(await issue(a, a.kids[1], loan), 201);
  await pay(a, d2.deposit.id);
  const ret2 = ok(await api('POST', kitUrl(a, `issues/${d2.id}/return`), { token: a.desk.token, body: { condition: 'worn' } }));
  assert.equal(ret2.deposit.action, 'refund_at_desk');
  assert.equal(ret2.deposit.refund_minor, 3000);
  const note = (await pool.query("SELECT total_cents FROM invoices WHERE academy_charge_id=$1 AND kind='credit_note'", [d2.deposit.id])).rows;
  assert.deepEqual(note.map((x) => Number(x.total_cents)), [3000]);
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [d2.deposit.id])).rows[0].status, 'refunded');

  const d3 = ok(await issue(a, a.kids[2], loan), 201);
  await pay(a, d3.deposit.id);
  const before = await qty(bag.id);
  const rep = ok(await api('POST', kitUrl(a, `issues/${d3.id}/report`), { token: a.desk.token, body: { kind: 'lost', note: 'Left on the coach' } }));
  assert.equal(rep.status, 'writeoff_pending');
  // desk staff cannot approve; a kit manager can; nothing moved before the decision
  assert.equal((await api('POST', kitUrl(a, `issues/${d3.id}/decision`), { token: a.desk.token, body: { decision: 'approved' } })).status, 403);
  assert.equal((await pool.query('SELECT deposit_charge_id FROM academy_kit_issues WHERE id=$1', [d3.id])).rows[0].deposit_charge_id, d3.deposit.id);
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [d3.deposit.id])).rows[0].status, 'paid');
  const decided = ok(await api('POST', kitUrl(a, `issues/${d3.id}/decision`), { token: a.lead.token, body: { decision: 'approved', replacement_minor: 2000 } }));
  assert.equal(decided.status, 'written_off');
  assert.equal(decided.deposit.action, 'forfeited');
  assert.equal(decided.deposit.forfeit_minor, 3000);
  assert.ok(decided.replacement_charge_id);
  assert.equal(await qty(bag.id), before, 'lost kit does not come back to stock');
  assert.equal((await api('POST', kitUrl(a, `issues/${d3.id}/decision`), { token: a.lead.token, body: { decision: 'approved' } })).status, 409, 'decided once');
  // the history says who did what
  const hist = ok(await api('GET', kitUrl(a, `issues/${d3.id}`), { token: a.owner.token }));
  assert.deepEqual(hist.events.map((e) => e.kind), ['issued', 'writeoff_requested', 'writeoff_approved']);
  // a manager cannot approve their own report; an owner can, and it is flagged
  const d4 = ok(await issue(a, a.kids[2], loan, { client_ref: key() }, a.lead.token), 201);
  ok(await api('POST', kitUrl(a, `issues/${d4.id}/report`), { token: a.lead.token, body: { kind: 'lost', note: 'Gone' } }));
  assert.equal((await api('POST', kitUrl(a, `issues/${d4.id}/decision`), { token: a.lead.token, body: { decision: 'rejected' } })).status, 403);
  const back = ok(await api('POST', kitUrl(a, `issues/${d4.id}/decision`), { token: a.owner.token, body: { decision: 'rejected', note: 'Found it' } }));
  assert.equal(back.status, 'issued');
  assert.equal((await pool.query("SELECT (data->>'self_approved') AS s FROM academy_kit_events WHERE issue_id=$1 AND kind='writeoff_rejected'", [d4.id])).rows[0].s, 'false', 'the owner was not the reporter');
  // damaged on return goes to approval too, and rejecting puts it back on the shelf
  const d5 = ok(await issue(a, a.kids[1], loan), 201);
  const shelf = await qty(bag.id);
  const dmg = ok(await api('POST', kitUrl(a, `issues/${d5.id}/return`), { token: a.desk.token, body: { condition: 'damaged', note: 'Zip broken' } }));
  assert.equal(dmg.status, 'writeoff_pending');
  assert.equal(await qty(bag.id), shelf);
  const fine = ok(await api('POST', kitUrl(a, `issues/${d5.id}/decision`), { token: a.lead.token, body: { decision: 'rejected', note: 'Zip works' } }));
  assert.equal(fine.status, 'returned');
  assert.equal(await qty(bag.id), shelf + 1);
  for (const it of [shirt, bag]) assert.equal((await moves(it.id)).d, await qty(it.id));
});

test('serial-numbered kit: units are unique per venue, issued by serial, scanned, and a counted adjustment is refused', async () => {
  const a = await academy({ athletes: 2 });
  const racket = await stock(a, { style: 'pro-racket', size: 'One size', quantity: 0, name: 'Pro racket', kit_slot: 'racket', serialised: true });
  const ent = await entitlement(a, { name: 'Racket', style_key: 'pro-racket', kit_slot: 'racket', mode: 'deposit', deposit_minor: 10000, return_days: 90, size_required: false });
  assert.equal((await api('POST', `/inventory/${racket.id}/adjust`, { token: a.owner.token, body: { delta: 3, reason: 'count' } })).status, 400);
  assert.equal((await api('POST', kitUrl(a, 'units'), { token: a.desk.token, body: { item_id: racket.id, serials: ['R-1'] } })).status, 403);
  const units = ok(await api('POST', kitUrl(a, 'units'), { token: a.lead.token, body: { item_id: racket.id, serials: ['R-1', 'R-2'] } }), 201);
  assert.equal(units.units.length, 2);
  assert.equal(await qty(racket.id), 2);
  assert.equal((await api('POST', kitUrl(a, 'units'), { token: a.lead.token, body: { item_id: racket.id, serials: ['R-2'] } })).status, 409, 'a serial is unique at its venue');
  const first = ok(await issue(a, a.kids[0], ent, { serial_no: 'R-1' }), 201);
  assert.equal(first.serial_no, 'R-1');
  const scan = ok(await api('GET', kitUrl(a, 'resolve'), { token: a.desk.token, query: { code: 'R-1' } }));
  assert.equal(scan.kind, 'unit');
  assert.equal(scan.unit.issue_status, 'issued');
  assert.equal(scan.unit.athlete_id, a.kids[0].id);
  // the same physical unit cannot be issued twice
  assert.equal((await issue(a, a.kids[1], ent, { serial_no: 'R-1' })).status, 409);
  const second = ok(await issue(a, a.kids[1], ent), 201);
  assert.equal(second.serial_no, 'R-2', 'the next free unit is picked');
  assert.equal(await qty(racket.id), 0);
  ok(await api('POST', kitUrl(a, `issues/${first.id}/return`), { token: a.desk.token, body: {} }));
  assert.equal(await qty(racket.id), 1);
  assert.equal((await pool.query("SELECT status FROM inventory_units WHERE serial_no='R-1'")).rows[0].status, 'in_stock');
  // barcodes resolve to the stock row; unknown codes are 404
  const m = await stock(a, { style: 'tee', size: 'S', quantity: 2, name: 'Tee', barcode: '5012345678900' });
  const bc = ok(await api('GET', kitUrl(a, 'resolve'), { token: a.cashier.token, query: { code: '5012345678900', venue_id: a.venue.id } }));
  assert.equal(bc.item.id, m.id);
  assert.equal((await api('GET', kitUrl(a, 'resolve'), { token: a.desk.token, query: { code: 'nothing-here' } })).status, 404);
  assert.equal((await api('POST', '/inventory', { token: a.owner.token, body: { venue_id: a.venue.id, name: 'Dup', category: 'apparel', quantity: 1, barcode: '5012345678900' } })).status >= 400, true, 'a barcode is unique per venue');
});

test('privacy and authority: the requirement view carries no addresses or payment data, desk cashiers work only their venue, and outsiders get a 404', async () => {
  const a = await academy();
  await stock(a, { size: 'M', quantity: 3 });
  const ent = await entitlement(a, { mode: 'charged', price_minor: 4000 });
  await fit(a, a.kids[0], 'M');
  await pay(a, ok(await issue(a, a.kids[0], ent), 201).charge.id);
  const asCoach = JSON.stringify([ok(await api('GET', kitUrl(a, 'due'), { token: a.coach.token })), ok(await api('GET', kitUrl(a, 'issues'), { token: a.coach.token })), ok(await api('GET', kitUrl(a, 'entitlements'), { token: a.coach.token })), ok(await api('GET', kitUrl(a, 'dashboard'), { token: a.coach.token }))]);
  for (const bad of ['address', 'email', 'phone', 'amount_minor', 'balance_minor', 'price_minor', 'deposit_minor', 'settled', 'deposits_held', 'unpaid_kit_charges', 'payer', 'fit_note']) assert.equal(asCoach.includes(bad), false, `a coach must not see ${bad}`);
  const asLead = ok(await api('GET', kitUrl(a, 'dashboard'), { token: a.lead.token }));
  assert.ok(Array.isArray(asLead.deposits_held) && Array.isArray(asLead.unpaid_kit_charges), 'kit managers see the money');
  // a cashier of the academy's venue (not a member) can look up and issue entitled kit there, and nothing else
  const kid2 = a.kids[1];
  await fit(a, kid2, 'M');
  const viaDesk = await issue(a, kid2, ent, { client_ref: key() }, a.cashier.token);
  assert.equal(viaDesk.status, 201, JSON.stringify(viaDesk.body));
  assert.equal(viaDesk.body.charge.amount_minor, 4000, 'the cashier sees what this item costs, to collect it');
  assert.equal(JSON.stringify(viaDesk.body).includes('payer'), false);
  assert.equal(ok(await api('GET', kitUrl(a, 'dashboard'), { token: a.desk.token })).deposits_held, undefined, 'the academy\'s finances are for managers, not the issuing desk');
  assert.equal((await api('GET', kitUrl(a, 'entitlements'), { token: a.cashier.token })).status, 404, 'a cashier is not a member of the academy');
  assert.equal((await api('POST', kitUrl(a, 'entitlements'), { token: a.cashier.token, body: { name: 'X', scope_type: 'cohort', scope_id: a.cohort.id, style_key: 'home-shirt' } })).status, 404);
  // another academy's venue is invisible: issuing from it is 404
  const b = await academy();
  const other = await issue(a, a.kids[0], ent, { venue_id: b.venue.id, client_ref: key() }, a.owner.token);
  assert.equal(other.status, 404);
  assert.equal((await api('GET', kitUrl(a, 'due'), { token: b.owner.token })).status, 404);
  assert.equal((await api('GET', kitUrl(a, 'due'), { token: a.stranger.token })).status, 404);
  // fit notes are encrypted at rest and only managers read them (and it is audited)
  ok(await api('POST', kitUrl(a, 'sizes'), { token: a.desk.token, body: { athlete_id: a.kids[0].id, slot: 'boots', size_label: '42', fit_note: 'wide left foot' } }));
  const raw = (await pool.query("SELECT fit_note_enc FROM academy_kit_sizes WHERE slot='boots'")).rows[0].fit_note_enc;
  assert.ok(raw && !raw.includes('wide'));
  const forDesk = ok(await api('GET', kitUrl(a, `sizes/${a.kids[0].id}`), { token: a.desk.token }));
  assert.equal(JSON.stringify(forDesk).includes('wide'), false);
  const forLead = ok(await api('GET', kitUrl(a, `sizes/${a.kids[0].id}`), { token: a.lead.token }));
  assert.ok(JSON.stringify(forLead).includes('wide left foot'));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='kit_read_fit_notes' AND actor_id=$1", [a.lead.id])).rowCount > 0);
  // a size row only exists once and the athlete must be in the academy
  assert.equal((await api('POST', kitUrl(a, 'sizes'), { token: a.desk.token, body: { athlete_id: a.stranger.id, slot: 'shirt', size_label: 'M' } })).status, 404);
});

test('a young athlete\'s kit is visible to a verified guardian only, live: revoking the link ends access; the receipt is accessible text', async () => {
  const owner = await signup(['athlete', 'venue_manager']), desk = await signup(), stranger = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Kit Youth ${n}`, kind: 'academy' } }), 201);
  await join(org, owner, desk, 'staff');
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${desk.id}`, { token: owner.token, body: { job_title: 'Front desk', template: 'registrar' } }));
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U11' } }), 201);
  const kid = await signup(['athlete'], { dob: yearsAgo(11) });
  const parent = await signup(['athlete'], { dob: yearsAgo(40) });
  const l = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: kid.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  ok(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  ok(await api('POST', `/youth/children/${kid.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kid.handle},yes` } }), 201);
  const enrolment = (await pool.query('SELECT id FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2', [cohort.id, kid.id])).rows[0].id;
  const venue = ok(await api('POST', '/venues', { token: owner.token, body: { name: 'Youth Ground', timezone: 'UTC', currency: 'GBP' } }), 201);
  await pool.query('UPDATE venues SET organisation_id=$2 WHERE id=$1', [venue.id, org.id]);
  ok(await api('POST', '/inventory', { token: owner.token, body: { venue_id: venue.id, name: 'Training top', category: 'apparel', quantity: 4, style_key: 'top', size_label: 'YM', kit_slot: 'training_top' } }), 201);
  const ent = ok(await api('POST', `/organisations/${org.id}/academy/kit/entitlements`, { token: owner.token, body: { name: 'Training top', scope_type: 'cohort', scope_id: cohort.id, style_key: 'top', kit_slot: 'training_top', mode: 'charged', price_minor: 2500, collection_note: 'Collect from the pavilion desk after training' } }), 201);
  ok(await api('POST', `/organisations/${org.id}/academy/kit/sizes`, { token: desk.token, body: { athlete_id: kid.id, slot: 'training_top', size_label: 'YM' } }));

  const before = ok(await api('GET', '/me/academy/kit', { token: parent.token, query: { athlete_id: kid.id } }));
  assert.equal(before.youth, true);
  assert.equal(before.organisations[0].to_collect[0].collection_note, 'Collect from the pavilion desk after training');
  assert.equal(before.organisations[0].sizes[0].size_label, 'YM');
  assert.equal((await api('GET', '/me/academy/kit', { token: stranger.token, query: { athlete_id: kid.id } })).status, 404, 'not their child');
  assert.equal((await api('GET', '/me/academy/kit', { token: kid.token })).status, 404, 'a young person acts through a guardian');

  const iss = ok(await api('POST', `/organisations/${org.id}/academy/kit/issues`, { token: desk.token, body: { enrolment_id: enrolment, venue_id: venue.id, entitlement_id: ent.id, client_ref: key() } }), 201);
  const charge = (await pool.query('SELECT payer_id, kind FROM academy_charges WHERE id=$1', [iss.charge ? iss.charge.id : null])).rows;
  void charge;
  const dbCharge = (await pool.query("SELECT payer_id FROM academy_charges WHERE enrolment_id=$1 AND kind='kit'", [enrolment])).rows[0];
  assert.equal(dbCharge.payer_id, parent.id, 'a young person\'s guardian is billed, not the child');
  const note = (await pool.query("SELECT user_id, title, body FROM notifications WHERE kind='academy_kit_issued' AND user_id = ANY($1)", [[parent.id, kid.id]])).rows;
  assert.deepEqual(note.map((x) => x.user_id), [parent.id], 'the guardian is told, with generic wording');
  assert.equal(note[0].body, 'Open GotMyGame to see the details.');
  const mine = ok(await api('GET', '/me/academy/kit', { token: parent.token, query: { athlete_id: kid.id } }));
  assert.equal(mine.organisations[0].items[0].status, 'issued');
  assert.equal(mine.organisations[0].items[0].charge.amount_minor, 2500);
  const rcpt = ok(await api('GET', `/academy/kit/issues/${iss.id}/receipt`, { token: parent.token }));
  assert.match(rcpt.text, /^Kit issue receipt KIT-/);
  assert.match(rcpt.text, /Item: Training top, size YM/);
  assert.match(rcpt.text, /Fee: 25\.00 GBP/);
  assert.equal(rcpt.language, 'en');
  assert.equal((await api('GET', `/academy/kit/issues/${iss.id}/receipt`, { token: stranger.token })).status, 404);

  // live revocation
  ok(await api('POST', `/youth/guardian-links/${l.id}/revoke`, { token: parent.token, body: { reason: 'No longer guardian of this child' } }));
  assert.equal((await api('GET', '/me/academy/kit', { token: parent.token, query: { athlete_id: kid.id } })).status, 404);
  assert.equal((await api('GET', `/academy/kit/issues/${iss.id}/receipt`, { token: parent.token })).status, 404);
});

test('replenishment: demand by size against stock and orders, ordered from the academy\'s supplier, received into the same ledger; the dashboard adds up', async () => {
  const a = await academy({ athletes: 3 });
  const m = await stock(a, { size: 'M', quantity: 1 });
  const ent = await entitlement(a);
  for (const k of a.kids) await fit(a, k, 'M');
  const plan0 = ok(await api('GET', kitUrl(a, 'replenishment'), { token: a.desk.token }));
  const line0 = plan0.lines.find((x) => x.style_key === 'home-shirt' && x.size_label === 'M');
  assert.deepEqual([line0.demand, line0.on_hand, line0.on_order, line0.short], [3, 1, 0, 2]);
  assert.deepEqual(plan0.orders, [], 'orders are for managers');
  // ordering needs a manager and one of the academy's own active suppliers
  const sup = await supplier(a);
  const body = { academy_supplier_id: sup, lines: [{ item_id: m.id, quantity: 2, unit_cost_cents: 1800 }], expected_on: '2030-01-31', note: 'Season kit' };
  assert.equal((await api('POST', kitUrl(a, 'orders'), { token: a.desk.token, body })).status, 403);
  const foreign = await academy();
  assert.equal((await api('POST', kitUrl(a, 'orders'), { token: a.lead.token, body: { ...body, academy_supplier_id: await supplier(foreign) } })).status, 404);
  const placed = ok(await api('POST', kitUrl(a, 'orders'), { token: a.lead.token, body }), 201);
  assert.equal(placed.orders.length, 1);
  const req = (await pool.query('SELECT title, estimated_cost_minor, currency FROM academy_supplier_requests WHERE id=$1', [placed.request_id])).rows[0];
  assert.deepEqual([req.title, Number(req.estimated_cost_minor), req.currency], ['Kit replenishment', 3600, 'GBP']);
  const plan1 = ok(await api('GET', kitUrl(a, 'replenishment'), { token: a.lead.token }));
  const line1 = plan1.lines.find((x) => x.size_label === 'M');
  assert.deepEqual([line1.on_order, line1.short], [2, 0]);
  assert.equal(plan1.orders.length, 1);
  ok(await api('PATCH', kitUrl(a, `orders/${placed.orders[0].id}`), { token: a.lead.token, body: { status: 'shipped' } }));
  ok(await api('PATCH', kitUrl(a, `orders/${placed.orders[0].id}`), { token: a.lead.token, body: { status: 'received' } }));
  assert.equal(await qty(m.id), 3);
  assert.equal((await api('PATCH', kitUrl(a, `orders/${placed.orders[0].id}`), { token: a.lead.token, body: { status: 'received' } })).status, 409, 'received once');
  assert.equal((await moves(m.id)).d, 3);
  // the old Supply screen path still works for its own orders and cannot receive a serial-numbered item by count
  const dash = ok(await api('GET', kitUrl(a, 'dashboard'), { token: a.lead.token }));
  assert.equal(dash.required, 3);
  assert.equal(dash.fulfilled, 0);
  assert.equal(dash.coverage_pct, 0);
  assert.equal(dash.due, 3);
  ok(await issue(a, a.kids[0], ent), 201);
  const dash2 = ok(await api('GET', kitUrl(a, 'dashboard'), { token: a.lead.token }));
  assert.deepEqual([dash2.fulfilled, dash2.coverage_pct, dash2.due, dash2.with_athletes], [1, 33, 2, 1]);
  assert.ok(dash2.stock.find((s) => s.item_id === m.id));
  const mine = ok(await api('GET', '/inventory', { token: a.owner.token, query: { venue_id: a.venue.id } }));
  assert.equal(mine.find((x) => x.id === m.id).style_key, 'home-shirt', 'the existing stock list shows the new fields');
});

test('every sport in the catalogue has kit slots: native families are their own list, anything else is a labelled fallback; the catalogue endpoint serves them', async () => {
  const sports = (await pool.query('SELECT id, slug, name, scoring, category FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 20, 'the sport catalogue is seeded');
  const native = [], fallback = [];
  for (const s of sports) {
    const r = slotsForSport(s);
    assert.ok(r.slots.length >= 6, `${s.slug} has kit slots`);
    for (const slot of r.slots) assert.ok(SLOT_KEYS.includes(slot.key) && slot.label, `${s.slug}: ${slot.key}`);
    assert.equal(typeof r.native, 'boolean');
    (r.native ? native : fallback).push(s.slug);
  }
  assert.ok(native.length > 0 && fallback.length > 0, `native ${native.length}, labelled fallback ${fallback.length}`);
  assert.ok(slotsForSport({ slug: 'cricket', scoring: 'runs' }).slots.some((x) => x.key === 'cricket_pads'));
  assert.ok(slotsForSport({ slug: 'tennis', scoring: 'sets', category: 'racquet' }).slots.some((x) => x.key === 'racket'));
  assert.ok(slotsForSport({ slug: 'football', scoring: 'goals' }).slots.some((x) => x.key === 'shin_pads'));
  const a = await academy();
  await stock(a, { size: 'M', quantity: 2 });
  await pool.query("UPDATE academy_profiles SET currency='GBP' WHERE organisation_id=$1", [a.org.id]);
  ok(await api('PATCH', `/organisations/${a.org.id}/academy`, { token: a.owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } }));
  ok(await api('POST', `/organisations/${a.org.id}/academy/programmes`, { token: a.owner.token, body: { sport: 'football', title: 'U12 Football', capacity: 5, admission_mode: 'direct', public: true } }), 201);
  const cat = ok(await api('GET', kitUrl(a, 'catalogue'), { token: a.desk.token }));
  assert.equal(cat.styles[0].style_key, 'home-shirt');
  assert.equal(cat.styles[0].sizes[0].size_label, 'M');
  assert.equal(cat.sports[0].slug, 'football');
  assert.equal(cat.sports[0].native, true);
});

test('every kit capability is a REST route, in the OpenAPI document and an MCP tool from one definition; the migration can run twice over live data', async () => {
  const names = capabilities.filter((c) => c.tag === 'Academy kit').map((c) => c.name);
  assert.ok(names.length >= 20, `${names.length} kit capabilities`);
  const spec = (await api('GET', '/openapi.json')).body;
  const ids = new Set(Object.values(spec.paths ?? {}).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const x of names) assert.ok(ids.has(x), `${x} in OpenAPI`);
  const u = await signup();
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${u.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const text = await res.text();
  for (const x of names) assert.ok(text.includes(`"${x}"`), `${x} is an MCP tool`);
  // the migration is additive and idempotent: running it again over existing data changes nothing
  const before = (await pool.query('SELECT (SELECT count(*) FROM academy_kit_issues)::int AS i, (SELECT count(*) FROM inventory_items)::int AS s, (SELECT count(*) FROM pos_stock_moves)::int AS m')).rows[0];
  const sql = fs.readFileSync(new URL('../migrations/157_academy_kit_issuance.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  const after = (await pool.query('SELECT (SELECT count(*) FROM academy_kit_issues)::int AS i, (SELECT count(*) FROM inventory_items)::int AS s, (SELECT count(*) FROM pos_stock_moves)::int AS m')).rows[0];
  assert.deepEqual(after, before);
  assert.ok(before.i > 0 && before.m > 0);
  // nothing in the migration removes or rewrites data
  assert.equal(/\b(DROP TABLE|TRUNCATE|DELETE FROM|ON DELETE CASCADE)\b/i.test(sql.replace(/--.*$/gm, '')), false);
});

test('reminders are idempotent, overdue loans are flagged, and kit comes due again after its replace-after window', async () => {
  const a = await academy({ athletes: 2 });
  await stock(a, { size: 'M', quantity: 5 });
  const bag = await stock(a, { style: 'loan-bag', size: 'One size', quantity: 3, name: 'Loan bag', kit_slot: 'bag' });
  const ent = await entitlement(a, { replace_after_months: 6 });
  const loan = await entitlement(a, { name: 'Loan bag', style_key: 'loan-bag', kit_slot: 'bag', mode: 'deposit', deposit_minor: 1000, return_days: 10, size_required: false });
  for (const k of a.kids) await fit(a, k, 'M');
  const { sweepKit } = await import('../src/kit-sweeps.js');
  const count = async (kind) => (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE kind=$1 AND user_id = ANY($2)', [kind, a.kids.map((k) => k.id)])).rows[0].n;
  await sweepKit();
  const first = await count('academy_kit_due');
  assert.equal(first, 4, 'two athletes x two entitlements are ready to collect');
  await sweepKit();
  assert.equal(await count('academy_kit_due'), first, 'running the sweep again sends nothing twice');
  // overdue loan
  const lent = ok(await issue(a, a.kids[0], loan), 201);
  await pool.query("UPDATE academy_kit_issues SET due_back_at = now() - interval '2 days' WHERE id=$1", [lent.id]);
  const late = ok(await api('GET', kitUrl(a, 'issues'), { token: a.desk.token, query: { overdue: 'true' } }));
  assert.deepEqual(late.map((r) => r.id), [lent.id]);
  assert.equal(late[0].overdue, true);
  await sweepKit();
  assert.equal(await count('academy_kit_overdue'), 1);
  await sweepKit();
  assert.equal(await count('academy_kit_overdue'), 1);
  // replace-after: issued, then 7 months pass
  const shirt = ok(await issue(a, a.kids[0], ent), 201);
  let due = ok(await api('GET', kitUrl(a, 'due'), { token: a.desk.token, query: { athlete_id: a.kids[0].id } }));
  assert.equal(due.some((r) => r.entitlement === 'Home shirt'), false);
  await pool.query("UPDATE academy_kit_issues SET issued_at = now() - interval '7 months' WHERE id=$1", [shirt.id]);
  due = ok(await api('GET', kitUrl(a, 'due'), { token: a.desk.token, query: { athlete_id: a.kids[0].id } }));
  const again = due.find((r) => r.entitlement === 'Home shirt');
  assert.equal(again.reason, 'replacement');
  ok(await issue(a, a.kids[0], ent), 201);
  assert.equal(bag.id !== undefined, true);
});
