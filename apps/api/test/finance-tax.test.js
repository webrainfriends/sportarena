import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Per-entity tax engine and tax report (#593): rules API, engine postings in the ledger, payment tax pro-rated from source documents, and the report.
// All data is created by the tests.
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com', PAYMENT_CURRENCY: 'INR',
});
const { pool, tx } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { blindIndex } = await import('../src/crypto.js');
const fin = await import('../src/finance.js');
const { divRound, taxIn } = await import('../src/tax.js');

let server, base, n = 0, boss;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ftx_${n}_${roles[0]}`, display_name: `Tax ${n}`, email: `ftx${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const dayOf = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const reconcile = async () => must(await api('POST', '/admin/finance/reconcile', { token: boss.token, body: {} }), 200);
/** a user with a fresh organisation they control */
const mkOrg = async (kind = 'academy') => { const user = await signup(); const org = must(await api('POST', '/organisations', { token: user.token, body: { name: `Tax Org ${++n}`, kind } }), 201); return { user, org, id: org.id, token: user.token }; };
const addMember = (orgId, userId, role) => pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [orgId, userId, role]);
const grant = (orgId, userId, level) => pool.query("INSERT INTO fin_finance_access(organisation_id, user_id, level) VALUES ($1,$2,$3)", [orgId, userId, level]);
const rule = (o, body, status = 201) => api('POST', '/finance/tax/rules', { token: o.token, body: { organisation_id: o.id, code: 'GST18', rate_bp: 1800, effective_from: dayOf(-400), ...body } }).then((r) => (status ? must(r, status) : r));
const profile = async (o, body = {}) => must(await api('POST', '/finance/tax/profile', { token: o.token, body: { organisation_id: o.id, regime: 'gst_in', registered: true, rounding_mode: 'half_up', ...body } }));
const dbRules = async (orgId) => (await pool.query("SELECT *, to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t FROM org_tax_rules WHERE organisation_id=$1 ORDER BY effective_from, created_at", [orgId])).rows;
const row = async (key) => (await pool.query('SELECT * FROM fin_transactions WHERE idem_key=$1', [key])).rows[0];

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  boss = await signup();
  await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}', email_idx=$2 WHERE id=$1", [boss.id, blindIndex('rraja.edge@gmail.com')]);
});
after(async () => { server.close(); await pool.end(); });

/** a team of the organisation with `players` members and a dues round; returns the raised charges */
const raise = async (o, players, amount, dueOffset = 10) => {
  const team = must(await api('POST', '/teams', { token: o.token, body: { name: `Falcons ${++n}`, sport: 'cricket' } }), 201);
  await pool.query('UPDATE teams SET organisation_id=$2 WHERE id=$1', [team.id, o.id]);
  for (let k = 0; k < players; k++) must(await api('POST', `/teams/${team.id}/members`, { token: o.token, body: { user_id: (await signup()).id } }), 201);
  must(await api('POST', `/teams/${team.id}/charges`, { token: o.token, body: { kind: 'season_fee', title: `Season ${n}`, amount_minor: amount, due_on: dayOf(dueOffset), idempotency_key: `k${n}${Date.now()}` } }), 201);
  return (await pool.query('SELECT * FROM team_charges WHERE team_id=$1 ORDER BY created_at, id', [team.id])).rows;
};
const obligation = async (id) => row(`obl:team_charge:${id}`);
const cash = async (o, chargeId, amount) => { must(await api('POST', `/team-charges/${chargeId}/payments`, { token: o.token, body: { amount_minor: amount, method: 'cash', idempotency_key: `cash-${++n}-${Date.now()}` } })); };
const receipts = async (chargeId) => (await pool.query("SELECT * FROM fin_transactions WHERE kind='payment' AND source_type='team_charge' AND source_id=$1 ORDER BY occurred_at, idem_key", [chargeId])).rows;

// ------------------------------------------------------------------------------------------------ 1. unit

test('divRound / taxIn: inclusive tax, half_up vs half_even on exact halves, no precision loss at scale', () => {
  assert.equal(taxIn(118000, 1800), 18000);
  assert.equal(taxIn(0, 1800), 0); assert.equal(taxIn(1000, 0), 0); assert.equal(taxIn(-5, 1800), 0);
  // 100% rate: tax = gross / 2, so odd grosses land on an exact .5
  assert.equal(divRound(5, 2, 'half_up'), 3); assert.equal(divRound(5, 2, 'half_even'), 2);
  assert.equal(divRound(7, 2, 'half_up'), 4); assert.equal(divRound(7, 2, 'half_even'), 4);
  assert.equal(taxIn(5, 10000, 'half_up'), 3); assert.equal(taxIn(5, 10000, 'half_even'), 2);
  assert.equal(taxIn(7, 10000, 'half_up'), 4); assert.equal(taxIn(7, 10000, 'half_even'), 4);
  assert.equal(taxIn(5, 10000), 3, 'default is half_up');
  // not a half: both modes round to nearest
  assert.equal(divRound(10, 3, 'half_even'), 3); assert.equal(divRound(11, 3, 'half_even'), 4);
  // 10^12 and 10^15 (past 2^53 once multiplied by the rate) stay exact
  assert.equal(taxIn(10 ** 12, 1800), 152542372881);
  assert.equal(taxIn(10 ** 15, 1800), 152542372881356);
  assert.equal(taxIn(10 ** 15, 1800), Number((BigInt(10 ** 15) * 1800n * 2n + 11800n) / (11800n * 2n)), 'matches exact BigInt rounding');
  assert.equal(divRound(10n ** 18n, 4n), 25 * 10 ** 16);
});

// ------------------------------------------------------------------------------------------------ 2. rules API

test('rules API: roles, effective dating, conflicts, validation, nothing deleted, settings and audit', async () => {
  const o = await mkOrg();
  const acct = await signup(), viewer = await signup(), outsider = await signup();
  await addMember(o.id, acct.id, 'finance');
  await grant(o.id, viewer.id, 'viewer');
  const body = { organisation_id: o.id, code: 'GST18', rate_bp: 1800, effective_from: dayOf(-400) };

  // who may add
  assert.equal((await api('POST', '/finance/tax/rules', { token: acct.token, body })).status, 403, 'accountant cannot change rules');
  assert.equal((await api('POST', '/finance/tax/rules', { token: viewer.token, body })).status, 403);
  assert.equal((await api('POST', '/finance/tax/rules', { token: outsider.token, body })).status, 404, 'outsider learns nothing');
  assert.equal((await api('POST', '/finance/tax/profile', { token: acct.token, body: { organisation_id: o.id, regime: 'vat', registered: true } })).status, 403);
  assert.equal((await api('POST', '/finance/tax/profile', { token: outsider.token, body: { organisation_id: o.id, regime: 'vat', registered: true } })).status, 404);
  assert.equal((await dbRules(o.id)).length, 0);

  const first = await rule(o, { category: 'registration' });
  assert.equal(first.category, 'registration'); assert.equal(first.rate_bp, 1800); assert.equal(first.effective_to, null);

  // a new open rule for the same category ends the previous one the day before
  const second = await rule(o, { category: 'registration', code: 'GST12', rate_bp: 1200, effective_from: dayOf(-100), evidence: 'Notification 12/2026' });
  let rows = await dbRules(o.id);
  assert.equal(rows.length, 2, 'the old rule is kept');
  assert.equal(rows.find((r) => r.id === first.id).t, dayOf(-101));
  assert.equal(rows.find((r) => r.id === second.id).t, null);

  // starting on or before the open rule is a conflict
  assert.equal((await rule(o, { category: 'registration', effective_from: dayOf(-100) }, null)).status, 409);
  assert.equal((await rule(o, { category: 'registration', effective_from: dayOf(-200) }, null)).status, 409);
  assert.equal((await dbRules(o.id)).length, 2);
  // a different source narrowing is its own series
  const src = await rule(o, { category: 'registration', source_type: 'team_charge', code: 'GST5', rate_bp: 500, effective_from: dayOf(-300) });
  assert.equal((await dbRules(o.id)).find((r) => r.id === second.id).t, null, 'category rule untouched by a source rule');

  // validation
  assert.equal((await rule(o, { category: 'tickets', treatment: 'exempt', rate_bp: 500 }, null)).status, 400, 'only standard rules carry a rate');
  assert.equal((await rule(o, { category: 'tickets', treatment: 'zero_rated', rate_bp: 1 }, null)).status, 400);
  assert.equal((await rule(o, { category: 'not_a_category' }, null)).status, 400);
  const ex = await rule(o, { category: 'tickets', treatment: 'exempt', rate_bp: 0, code: 'EXEMPT' });
  assert.equal(ex.treatment, 'exempt');

  // end: keeps the row, cannot end before it starts, scoped to the organisation
  const ended = must(await api('POST', `/finance/tax/rules/${ex.id}/end`, { token: o.token, body: { organisation_id: o.id, effective_to: dayOf(-10) } }));
  assert.equal(String(ended.effective_to).slice(0, 10) === dayOf(-10) || (await dbRules(o.id)).find((r) => r.id === ex.id).t === dayOf(-10), true);
  assert.equal((await api('POST', `/finance/tax/rules/${src.id}/end`, { token: o.token, body: { organisation_id: o.id, effective_to: dayOf(-301) } })).status, 400, 'cannot end before it starts');
  assert.equal((await api('POST', `/finance/tax/rules/${src.id}/end`, { token: acct.token, body: { organisation_id: o.id, effective_to: dayOf(-1) } })).status, 403);
  assert.equal((await api('POST', `/finance/tax/rules/${src.id}/end`, { token: outsider.token, body: { organisation_id: o.id, effective_to: dayOf(-1) } })).status, 404);
  const o2 = await mkOrg();
  assert.equal((await api('POST', `/finance/tax/rules/${src.id}/end`, { token: o2.token, body: { organisation_id: o2.id, effective_to: dayOf(-1) } })).status, 404, "another organisation's rule is not found");
  assert.equal((await dbRules(o.id)).length, 4, 'ending never deletes');

  // profile + settings
  await profile(o, { regime: 'gst_in', registered: true, rounding_mode: 'half_even' });
  await pool.query('UPDATE organisations SET tax_id=$2 WHERE id=$1', [o.id, '29ABCDE1234F1Z5']);
  for (const who of [o, acct]) {
    const s = must(await api('GET', '/finance/tax/settings', { token: who.token, query: { organisation_id: o.id } }));
    assert.equal(s.profile.regime, 'gst_in'); assert.equal(s.profile.registered, true); assert.equal(s.profile.rounding_mode, 'half_even');
    assert.equal(s.registration_id, '29ABCDE1234F1Z5');
    assert.equal(s.rules.length, 4); assert.ok(s.rules.some((r) => r.id === first.id && r.effective_to), 'ended rules are listed');
    assert.ok(s.rules.some((r) => r.evidence === 'Notification 12/2026'));
  }
  assert.equal((await api('GET', '/finance/tax/settings', { token: viewer.token, query: { organisation_id: o.id } })).status, 403);
  assert.equal((await api('GET', '/finance/tax/settings', { token: outsider.token, query: { organisation_id: o.id } })).status, 404);
  const blank = must(await api('GET', '/finance/tax/settings', { token: o2.token, query: { organisation_id: o2.id } }));
  assert.deepEqual([blank.profile.regime, blank.profile.registered, blank.rules.length, blank.registration_id], ['none', false, 0, null]);

  // every change is audit-logged and visible in the finance audit trail
  const logged = (await pool.query("SELECT action FROM audit_log WHERE entity='organisations' AND entity_id=$1 AND action LIKE '%finance%'", [o.id])).rows.map((r) => r.action);
  for (const a of ['add_finance_tax_rule', 'end_finance_tax_rule', 'set_finance_tax_profile']) assert.ok(logged.includes(a), `${a} audit-logged`);
  assert.equal(logged.filter((a) => a === 'add_finance_tax_rule').length, 4);
  const trail = must(await api('GET', '/finance/audit', { token: o.token, query: { organisation_id: o.id, limit: 100 } }));
  for (const a of ['add_finance_tax_rule', 'end_finance_tax_rule', 'set_finance_tax_profile']) assert.ok(trail.some((t) => t.action === a && t.entity === 'organisations'), `${a} visible in /finance/audit`);
});

// ------------------------------------------------------------------------------------------------ 3. engine in the ledger

test('engine: standard rule taxes obligations and offline receipts with the inclusive tax and records how', async () => {
  const o = await mkOrg();
  await profile(o);
  await rule(o, { category: '*' });
  const [ch] = await raise(o, 1, 100000);
  await reconcile();
  const exp = taxIn(100000, 1800);
  assert.equal(exp, 15254);
  const ob = await obligation(ch.id);
  assert.equal(Number(ob.tax_minor), exp); assert.equal(ob.tax_code, 'GST18'); assert.equal(ob.tax_rate_bp, 1800); assert.equal(ob.tax_basis, 'engine'); assert.equal(ob.tax_treatment, 'standard');
  await cash(o, ch.id, 40000);
  await reconcile();
  const [r1] = await receipts(ch.id);
  assert.equal(Number(r1.tax_minor), taxIn(40000, 1800)); assert.equal(r1.tax_basis, 'engine'); assert.equal(r1.tax_code, 'GST18'); assert.equal(r1.tax_rate_bp, 1800); assert.equal(r1.tax_treatment, 'standard');
  assert.equal(Number(r1.net_minor), 40000 - taxIn(40000, 1800), 'net = gross less tax');
  await cash(o, ch.id, 60000);
  await reconcile();
  const rs = await receipts(ch.id);
  assert.equal(rs.length, 2);
  assert.equal(Number(rs[1].tax_minor), taxIn(60000, 1800));
});

test('engine: a source-specific rule beats the category rule; future and ended rules are ignored', async () => {
  const o = await mkOrg();
  await profile(o);
  await rule(o, { category: '*' });
  await rule(o, { category: '*', source_type: 'team_charge', code: 'GST5', rate_bp: 500, effective_from: dayOf(-300) });
  const [ch] = await raise(o, 1, 21000);
  await reconcile();
  const ob = await obligation(ch.id);
  assert.equal(Number(ob.tax_minor), taxIn(21000, 500)); assert.equal(ob.tax_code, 'GST5'); assert.equal(ob.tax_rate_bp, 500);

  const f = await mkOrg();   // a rule that has not started yet
  await profile(f);
  await rule(f, { category: '*', effective_from: dayOf(30) });
  const [fc] = await raise(f, 1, 50000);
  const e = await mkOrg();   // a rule that has already ended
  await profile(e);
  const old = await rule(e, { category: '*', effective_from: dayOf(-400) });
  must(await api('POST', `/finance/tax/rules/${old.id}/end`, { token: e.token, body: { organisation_id: e.id, effective_to: dayOf(-100) } }));
  const [ec] = await raise(e, 1, 50000);
  await reconcile();
  for (const c of [fc, ec]) {
    const r = await obligation(c.id);
    assert.equal(Number(r.tax_minor), 0); assert.equal(r.tax_basis, null); assert.equal(r.tax_treatment, null); assert.equal(r.tax_code, null);
  }
});

test('engine: unregistered -> out_of_scope, exempt rule -> exempt, no rule -> unchanged (basis NULL)', async () => {
  const u = await mkOrg();
  await profile(u, { regime: 'gst_in', registered: false });
  await rule(u, { category: '*' });
  const [uc] = await raise(u, 1, 30000);
  const x = await mkOrg();
  await profile(x);
  await rule(x, { category: '*', treatment: 'exempt', rate_bp: 0, code: 'EXEMPT' });
  const [xc] = await raise(x, 1, 30000);
  const z = await mkOrg();
  const [zc] = await raise(z, 1, 30000);
  await reconcile();
  const ur = await obligation(uc.id);
  assert.equal(Number(ur.tax_minor), 0); assert.equal(ur.tax_treatment, 'out_of_scope'); assert.equal(ur.tax_basis, 'engine'); assert.equal(ur.tax_rate_bp, 0);
  const xr = await obligation(xc.id);
  assert.equal(Number(xr.tax_minor), 0); assert.equal(xr.tax_treatment, 'exempt'); assert.equal(xr.tax_basis, 'engine'); assert.equal(xr.tax_code, 'EXEMPT');
  const zr = await obligation(zc.id);
  assert.equal(Number(zr.tax_minor), 0); assert.equal(zr.tax_basis, null); assert.equal(zr.tax_treatment, null); assert.equal(zr.tax_rate_bp, null);
  // half_even profile uses banker's rounding for exact halves
  const h = await mkOrg();
  await profile(h, { rounding_mode: 'half_even' });
  await rule(h, { category: '*', code: 'FULL', rate_bp: 10000 });
  const [hc] = await raise(h, 1, 5);
  await reconcile();
  assert.equal(Number((await obligation(hc.id)).tax_minor), 2, 'half_even: 2.5 -> 2');
});

test('engine: a source that already carries tax keeps it (basis source); posted rows are immutable when rules change later', async () => {
  const o = await mkOrg();
  await profile(o);
  await rule(o, { category: '*', code: 'GST12', rate_bp: 1200 });
  const parent = await signup(), athlete = await signup();
  const prog = (await pool.query("INSERT INTO academy_programmes(organisation_id, sport, title) VALUES ($1,'cricket','Squad') RETURNING id", [o.id])).rows[0];
  const app = (await pool.query('INSERT INTO academy_applications(organisation_id, programme_id, athlete_id, applicant_id) VALUES ($1,$2,$3,$4) RETURNING id', [o.id, prog.id, athlete.id, parent.id])).rows[0];
  const ac = (await pool.query(
    `INSERT INTO academy_charges(application_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, tax_minor, amount_minor, status)
     VALUES ($1,$2,$3,1,'tuition',$4,'INR',118000,18000,118000,'awaiting_payment') RETURNING id`, [app.id, o.id, parent.id, dayOf(10)])).rows[0];
  const [tc] = await raise(o, 1, 11200);
  await reconcile();
  const a = await row(`obl:academy_charge:${ac.id}`);
  assert.equal(Number(a.tax_minor), 18000, 'the source figure stands, not 12%'); assert.equal(a.tax_basis, 'source'); assert.equal(a.tax_code, null);
  const t = await obligation(tc.id);
  assert.equal(Number(t.tax_minor), taxIn(11200, 1200)); assert.equal(t.tax_basis, 'engine');

  // a rule added later does not touch posted rows
  await rule(o, { category: '*', code: 'GST28', rate_bp: 2800, effective_from: dayOf(0) });
  await reconcile();
  const t2 = await obligation(tc.id);
  assert.equal(Number(t2.tax_minor), Number(t.tax_minor)); assert.equal(t2.tax_code, 'GST12'); assert.equal(t2.tax_rate_bp, 1200);
  // ...and the append-only guard still refuses edits
  await assert.rejects(pool.query('UPDATE fin_transactions SET tax_minor = 1 WHERE id=$1', [t.id]), /cannot be edited|append-only/);
  await assert.rejects(pool.query('DELETE FROM fin_transactions WHERE id=$1', [t.id]), /append-only/);
  assert.equal(Number((await obligation(tc.id)).tax_minor), Number(t.tax_minor));
});

// ------------------------------------------------------------------------------------------------ 4. zero-tax posting fixes

test('recordPayment: tax is pro-rated from the source document (academy, ticket, service invoice, pos sale); a part payment gets its share, never more than the document tax', async () => {
  const o = await mkOrg();
  const payer = await signup();
  const pay = async (type, id, amount, extra = {}) => {
    const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, paid_at, provider_ref) VALUES ($1,'stripe',$2,$3,$4,'INR','paid',now(),$5) RETURNING *", [payer.id, type, id, amount, `ref-${++n}`])).rows[0];
    const txid = await tx((c) => fin.recordPayment(c, { ...p, ...extra }));
    assert.ok(txid, 'posted');
    return (await pool.query('SELECT * FROM fin_transactions WHERE id=$1', [txid])).rows[0];
  };

  // academy_charge 118000 / tax 18000
  const parent = await signup(), athlete = await signup();
  const prog = (await pool.query("INSERT INTO academy_programmes(organisation_id, sport, title) VALUES ($1,'cricket','Squad') RETURNING id", [o.id])).rows[0];
  const app = (await pool.query('INSERT INTO academy_applications(organisation_id, programme_id, athlete_id, applicant_id) VALUES ($1,$2,$3,$4) RETURNING id', [o.id, prog.id, athlete.id, parent.id])).rows[0];
  const ac = (await pool.query(
    `INSERT INTO academy_charges(application_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, tax_minor, amount_minor) VALUES ($1,$2,$3,1,'tuition',$4,'INR',118000,18000,118000) RETURNING id`,
    [app.id, o.id, parent.id, dayOf(5)])).rows[0].id;
  let r = await pay('academy_charge', ac, 118000); assert.equal(Number(r.tax_minor), 18000);
  r = await pay('academy_charge', ac, 59000); assert.equal(Number(r.tax_minor), 9000, 'half the payment, half the tax');
  r = await pay('academy_charge', ac, 10000); assert.equal(Number(r.tax_minor), Math.round((18000 * 10000) / 118000));
  assert.equal(Number(r.tax_minor), 1525);
  r = await pay('academy_charge', ac, 300000); assert.equal(Number(r.tax_minor), 18000, 'never more than the document tax');
  assert.ok(r.tax_basis, 'derivation recorded');

  // ticket order 23600 / tax 3600
  const ev = must(await api('POST', '/events', { token: o.token, body: { name: `Cup ${++n}`, sport: 'football', starts_on: dayOf(1), ends_on: dayOf(3) } }), 201);
  await pool.query('UPDATE events SET organisation_id=$2 WHERE id=$1', [ev.id, o.id]);
  const order = (await pool.query("INSERT INTO ticket_orders(event_id, buyer_id, channel, currency, subtotal_minor, tax_minor, total_minor) VALUES ($1,$2,'online','INR',20000,3600,23600) RETURNING id", [ev.id, payer.id])).rows[0].id;
  r = await pay('ticket_order', order, 23600); assert.equal(Number(r.tax_minor), 3600); assert.equal(r.payee_org_id, o.id);
  r = await pay('ticket_order', order, 11800); assert.equal(Number(r.tax_minor), 1800);

  // service invoice 118000 / tax 18000
  const buyer = await mkOrg('club'), supplier = await mkOrg('company');
  const profileRow = (await pool.query("INSERT INTO svc_profiles(owner_id, organisation_id, supplier_type, legal_name) VALUES ($1,$2,'company',$3) RETURNING id", [supplier.user.id, supplier.id, `Supplier ${++n}`])).rows[0];
  const sb = (await pool.query("INSERT INTO svc_buyers(owner_id, organisation_id, name, currency) VALUES ($1,$2,$3,'INR') RETURNING id", [buyer.user.id, buyer.id, `Buyer ${n}`])).rows[0];
  const so = (await pool.query("INSERT INTO svc_orders(number, buyer_id, profile_id, currency, net_minor, tax_minor, gross_minor, created_by) VALUES ($1,$2,$3,'INR',100000,18000,118000,$4) RETURNING id", [`PO-${n}-${Date.now()}`, sb.id, profileRow.id, buyer.user.id])).rows[0];
  const inv = (await pool.query(
    `INSERT INTO svc_invoices(order_id, profile_id, buyer_id, doc_type, supplier_number, status, currency, lines, net_minor, tax_minor, gross_minor, payable_minor, due_on, issued_at, created_by)
     VALUES ($1,$2,$3,'invoice',$4,'issued','INR','[]',100000,18000,118000,118000,$5,now(),$6) RETURNING id`, [so.id, profileRow.id, sb.id, `INV-${++n}`, dayOf(30), supplier.user.id])).rows[0].id;
  r = await pay('service_invoice', inv, 118000); assert.equal(Number(r.tax_minor), 18000);
  r = await pay('service_invoice', inv, 29500); assert.equal(Number(r.tax_minor), 4500);

  // pos sale 11800 / tax 1800 (tax_cents / total_cents)
  const venue = (await pool.query('INSERT INTO venues(name, owner_id, organisation_id) VALUES ($1,$2,$3) RETURNING id', [`Desk ${++n}`, o.user.id, o.id])).rows[0];
  const sale = (await pool.query("INSERT INTO pos_sales(venue_id, cashier_id, currency, status, subtotal_cents, tax_cents, total_cents) VALUES ($1,$2,'INR','awaiting_payment',10000,1800,11800) RETURNING id", [venue.id, o.user.id])).rows[0].id;
  r = await pay('pos_sale', sale, 11800); assert.equal(Number(r.tax_minor), 1800);
  r = await pay('pos_sale', sale, 5900); assert.equal(Number(r.tax_minor), 900);
  r = await pay('pos_sale', sale, 99999); assert.equal(Number(r.tax_minor), 1800);

  // a purpose without a tax-bearing document stays at zero
  r = await pay('shop_order', '00000000-0000-4000-8000-000000000001', 5000); assert.equal(Number(r.tax_minor), 0);
});

// ------------------------------------------------------------------------------------------------ 5. report

const post = (e) => tx((c) => fin.insert(c, { status: 'settled', currency: 'INR', key: `ftx:${++n}:${Math.random()}`, ...e }));
const report = async (o, extra = {}, token = o.token) => must(await api('GET', '/finance/tax', { token, query: { organisation_id: o.id, ...extra } }));
const cur = (rep, c = 'INR') => rep.currencies.find((x) => x.currency === c);

test('tax report: collected vs paid, periods, refunds, withholding, untaxed and zero-by-rule counts, rounding variance, access', async () => {
  const o = await mkOrg();
  const acct = await signup(), viewer = await signup(), outsider = await signup(), cust = await signup();
  await addMember(o.id, acct.id, 'finance'); await grant(o.id, viewer.id, 'viewer');
  const sup = await mkOrg('company');   // counterparty
  const mk = (e) => post({ payerId: cust.id, payeeOrgId: o.id, module: 'registration', sourceType: 'academy_charge', ...e });

  // collected INR: Jan 118000/18000, Feb 59000/9000, Q2 (Apr) 23600/3600; refund of 59000 (tax 9000) in Apr; USD separately
  const pay1 = await mk({ kind: 'payment', gross: 118000, tax: 18000, at: '2026-01-15T10:00:00Z' });
  await mk({ kind: 'payment', gross: 59000, tax: 9000, at: '2026-02-10T10:00:00Z' });
  await mk({ kind: 'payment', gross: 23600, tax: 3600, at: '2026-04-05T10:00:00Z' });
  await mk({ kind: 'refund', gross: 59000, tax: 9000, at: '2026-04-20T10:00:00Z', parentId: pay1 });
  await mk({ kind: 'payment', gross: 1180, tax: 180, currency: 'USD', at: '2026-01-20T10:00:00Z' });
  // paid: the organisation pays a supplier 11800 / tax 1800 (payer = org)
  await post({ kind: 'payment', module: 'suppliers', sourceType: 'service_invoice', payerOrgId: o.id, payeeOrgId: sup.id, gross: 11800, tax: 1800, at: '2026-01-25T10:00:00Z' });
  await post({ kind: 'payment', module: 'suppliers', sourceType: 'service_invoice', payerOrgId: o.id, payeeOrgId: sup.id, gross: 2360, tax: 360, at: '2026-05-02T10:00:00Z' });
  // withholding: shown only under withheld, never as tax (new rows via withheld_minor, older rows via tax_minor)
  await post({ kind: 'payment', module: 'contracts', sourceType: 'player_payout_line', payerOrgId: o.id, gross: 100000, withheld: 10000, at: '2026-01-28T10:00:00Z' });
  await post({ kind: 'payment', module: 'officials', sourceType: 'payout_item', payerOrgId: o.id, gross: 50000, tax: 5000, at: '2026-04-28T10:00:00Z' });
  // untaxed income by category, and zero by rule
  await mk({ kind: 'payment', gross: 7000, at: '2026-02-11T10:00:00Z' });
  await post({ kind: 'payment', module: 'sponsorship', sourceType: 'sponsorship_obligation', payerId: cust.id, payeeOrgId: o.id, gross: 9000, at: '2026-02-12T10:00:00Z' });
  await mk({ kind: 'payment', gross: 4000, taxCode: 'EXEMPT', taxRate: 0, taxTreatment: 'exempt', taxBasis: 'engine', at: '2026-02-13T10:00:00Z' });
  // engine row with rounding: 10001 at 1800bp = 1525.576 -> 1526 (variance +0.42)
  await profile(o);
  await rule(o, { category: 'venue_service', code: 'GST18' });
  await post({ kind: 'payment', module: 'venue', sourceType: 'pos_sale', payerId: cust.id, payeeOrgId: o.id, gross: 10001, at: '2026-03-03T10:00:00Z' });
  // an open charge and a pending/failed payment never count
  await mk({ kind: 'charge', status: 'open', gross: 99999, tax: 9999, at: '2026-03-04T10:00:00Z' });
  await mk({ kind: 'payment', status: 'failed', gross: 88888, tax: 8888, at: '2026-03-05T10:00:00Z' });

  const sums = (await pool.query(
    `SELECT sum(CASE WHEN kind='payment' THEN tax_minor ELSE -tax_minor END)::bigint AS tax FROM fin_transactions WHERE currency='INR' AND payee_org_id=$1 AND status='settled' AND kind IN ('payment','refund')`, [o.id])).rows[0];
  const paidSql = (await pool.query(
    `SELECT sum(tax_minor)::bigint AS tax FROM fin_transactions WHERE currency='INR' AND payer_org_id=$1 AND payee_org_id IS DISTINCT FROM $1 AND status='settled' AND kind='payment' AND source_type NOT IN ('payout_item','player_payout_line')`, [o.id])).rows[0];

  const rep = await report(o);
  assert.equal(rep.period, 'month');
  assert.deepEqual(rep.currencies.map((c) => c.currency), ['INR', 'USD'], 'currencies are listed separately');
  const inr = cur(rep), usd = cur(rep, 'USD');
  assert.equal(usd.collected.tax, 180); assert.equal(usd.paid.tax, 0); assert.equal(usd.net_tax, 180);
  assert.equal(inr.collected.tax, 18000 + 9000 + 3600 - 9000 + 1526, 'refund takes its share back; engine row included');
  assert.equal(inr.collected.tax, Number(sums.tax), 'collected reconciles to SUM over the ledger rows');
  assert.equal(inr.paid.tax, 1800 + 360); assert.equal(inr.paid.tax, Number(paidSql.tax), 'withholding sources are not in paid tax');
  assert.equal(inr.net_tax, inr.collected.tax - inr.paid.tax);
  assert.equal(inr.collected.lines.reduce((t, l) => t + l.tax_minor, 0), inr.collected.tax, 'lines add up to the total');
  assert.equal(inr.paid.lines.reduce((t, l) => t + l.tax_minor, 0), inr.paid.tax);
  assert.equal(inr.collected.gross, 118000 + 59000 + 23600 - 59000 + 7000 + 9000 + 4000 + 10001);
  const jan = inr.collected.lines.filter((l) => l.period === '2026-01');
  assert.equal(jan.reduce((t, l) => t + l.tax_minor, 0), 18000);
  assert.equal(inr.collected.lines.filter((l) => l.period === '2026-04').reduce((t, l) => t + l.tax_minor, 0), 3600 - 9000, 'April nets the sale and the refund');
  // withholding
  assert.equal(inr.withheld.total, 15000); assert.deepEqual(inr.withheld.by_period.map((x) => [x.period, x.withheld_minor]), [['2026-01', 10000], ['2026-04', 5000]]);
  assert.ok(!inr.paid.lines.some((l) => l.tax_minor === 10000 || l.tax_minor === 5000), 'withholding never appears as tax');
  // untaxed + zero by rule
  const reg = inr.no_tax_recorded.find((x) => x.category === 'registration'), spo = inr.no_tax_recorded.find((x) => x.category === 'sponsorship');
  assert.equal(reg.rows, 1); assert.equal(reg.gross_minor, 7000); assert.equal(spo.gross_minor, 9000);
  assert.ok(!inr.no_tax_recorded.some((x) => x.category === 'venue_service'), 'engine-taxed money is not "untaxed"');
  assert.deepEqual(inr.zero_by_rule.map((z) => [z.treatment, z.rows, z.gross_minor]), [['exempt', 1, 4000]]);
  assert.ok(Math.abs(inr.rounding_variance_minor - 0.42) < 0.011, `variance ${inr.rounding_variance_minor}`);

  // periods
  const q = await report(o, { period: 'quarter' });
  assert.deepEqual([...new Set(cur(q).collected.lines.map((l) => l.period))].sort(), ['2026-Q1', '2026-Q2']);
  assert.equal(cur(q).collected.tax, inr.collected.tax, 'same total in any bucket size');
  assert.equal(cur(q).collected.lines.filter((l) => l.period === '2026-Q2').reduce((t, l) => t + l.tax_minor, 0), 3600 - 9000);
  const y = await report(o, { period: 'year' });
  assert.deepEqual([...new Set(cur(y).collected.lines.map((l) => l.period))], ['2026']);
  assert.equal(cur(y).paid.tax, inr.paid.tax);
  // date and currency filters
  const jf = await report(o, { from: '2026-01-01', to: '2026-01-31', currency: 'INR' });
  assert.deepEqual(jf.currencies.map((c) => c.currency), ['INR']);
  assert.equal(cur(jf).collected.tax, 18000); assert.equal(cur(jf).paid.tax, 1800); assert.equal(cur(jf).net_tax, 16200);

  // access
  assert.equal(cur(await report(o, {}, acct.token)).collected.tax, inr.collected.tax, 'accountant can read');
  assert.equal((await api('GET', '/finance/tax', { token: viewer.token, query: { organisation_id: o.id } })).status, 403);
  assert.equal((await api('GET', '/finance/tax', { token: outsider.token, query: { organisation_id: o.id } })).status, 404);
  // platform view: platform admin only
  assert.equal((await api('GET', '/finance/tax', { token: o.token })).status, 403);
  assert.equal((await api('GET', '/finance/tax', { token: acct.token })).status, 403);
  const plat = must(await api('GET', '/finance/tax', { token: boss.token }));
  const platInr = cur(plat);
  const platSql = (await pool.query(
    `SELECT sum(CASE WHEN kind='payment' THEN tax_minor ELSE -tax_minor END)::bigint AS tax FROM fin_transactions WHERE currency='INR' AND status='settled' AND kind IN ('payment','refund','chargeback') AND source_module <> 'events'
       AND source_type NOT IN ('payout_item','player_payout_line')`)).rows[0];
  assert.equal(platInr.collected.tax, Number(platSql.tax), 'platform totals reconcile to the ledger');
  assert.equal(platInr.paid.tax, 0, 'the platform view has no "paid" side');
});
