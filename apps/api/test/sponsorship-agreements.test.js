import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { expandLine, buildSchedule, addMonths } = await import('../src/sponsor-schedule.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sa_${n}_${roles[0]}`, display_name: `Agree ${n}`, email: `sa${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const brand = async (u, name) => must(await api('POST', '/sponsors', { token: u.token, body: { name } }), 201);
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']), b = await brand(sponsor, `Brand${n}`);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  return { sponsor, ath, b };
};
const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 6 };
const goods = { kind: 'goods', label: 'Rackets', quantity: 2, unit: 'pcs', cadence: 'custom', custom_dates: ['2030-02-01', '2030-05-01'], estimate_cents: 80000, currency: 'SGD' };
const post = { kind: 'endorsement', label: 'Instagram posts', promoter: 'recipient', cadence: 'custom', custom_dates: ['2030-02-10', '2030-04-10', '2030-06-10'], terms: { channels: ['instagram'], approval_criteria: 'Logo visible' } };
const period = { starts_on: '2030-01-01', ends_on: '2030-06-30' };
const propose = (w, extra = {}) => api('POST', '/sponsorships', { token: w.sponsor.token, body: { sponsor_id: w.b.id, target_type: 'athlete', target_id: w.ath.id, deliverables: 'Wear the kit', ...period, lines: [money, goods, post], ...extra } });
const accept = (w, id, version) => api('PATCH', `/sponsorships/${id}`, { token: w.ath.token, body: { status: 'active', version } });
const dues = async (w, id, query = {}) => must(await api('GET', '/sponsorship-obligations', { token: w.ath.token, query: { sponsorship_id: id, limit: 100, ...query } }));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('schedule rules: month-end clamp, leap years, inclusive end, remainder on the last instalment, nothing past the term', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(addMonths('2024-01-31', 2), '2024-03-31', 'anchored to the first date, not chained');
  assert.equal(addMonths('2024-11-30', 3), '2025-02-28');
  const six = expandLine({ ...money, first_due_on: '2024-01-31' }, { starts_on: '2024-01-01', ends_on: '2024-06-30' });
  assert.deepEqual(six.map((o) => o.due_on), ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31', '2024-06-30'], 'the final due falls exactly on the inclusive end date');
  assert.throws(() => expandLine({ ...money, first_due_on: '2024-01-31', instalments: 7 }, { starts_on: '2024-01-01', ends_on: '2024-06-30' }), /past the end/);
  assert.throws(() => expandLine(money, { starts_on: '2030-02-01', ends_on: '2030-06-30' }), /before the agreement starts/);
  assert.throws(() => expandLine(money, {}), /needs the agreement period/);
  const split = expandLine({ kind: 'money', label: 'x', currency: 'SGD', total_cents: 1000, cadence: 'weekly', first_due_on: '2030-01-01', instalments: 3 }, { starts_on: '2030-01-01', ends_on: '2030-02-01' });
  assert.deepEqual(split.map((o) => o.amount_cents), [333, 333, 334]);
  assert.deepEqual(split.map((o) => o.due_on), ['2030-01-01', '2030-01-08', '2030-01-15']);
  assert.throws(() => expandLine({ ...money, amount_cents: undefined }, period), /either amount_cents/);
  assert.throws(() => expandLine({ ...money, currency: 'XXX' }, period), /currency/);
  assert.throws(() => expandLine({ kind: 'endorsement', label: 'p', promoter: 'sponsor', amount_cents: 5, cadence: 'once', first_due_on: '2030-01-02' }, period), /only money lines/);
  const mixed = buildSchedule([money, { ...money, currency: 'USD', amount_cents: 100 }, goods], period);
  assert.deepEqual(mixed.committed, { SGD: 300000, USD: 600 }, 'currencies stay separate');
  assert.deepEqual(mixed.estimated_not_cash, { SGD: 80000 }, 'estimates are labelled and not cash');
});

test('mixed agreement: exact-version acceptance, one generation of the schedule, idempotent under concurrency', async () => {
  const w = await world();
  const bad = await propose(w, { lines: [{ ...money, instalments: 7 }] });
  assert.equal(bad.status, 400, 'a schedule past the term is refused');
  const pv = must(await api('POST', '/sponsorship-schedule/preview', { token: w.sponsor.token, body: { lines: [money, goods, post], ...period } }));
  assert.equal(pv.occurrences.filter((o) => o.kind === 'money').length, 6);
  const deal = must(await propose(w), 201);
  assert.match(deal.agreement_ref, /^SPA-/);
  assert.equal(deal.visibility, 'private', 'athlete deals keep their private default');
  const seen = must(await api('GET', `/sponsorships/${deal.id}`, { token: w.ath.token }));
  assert.equal(seen.schedule.occurrences.length, 11, 'the recipient reviews the complete schedule before accepting');
  assert.equal(seen.role, 'recipient');

  assert.equal((await accept(w, deal.id)).status, 400, 'a version is required');
  const rev = must(await api('POST', `/sponsorships/${deal.id}/revise`, { token: w.sponsor.token, body: { lines: [money, goods], ...period } }));
  assert.equal(rev.terms_version, 2);
  assert.equal((await accept(w, deal.id, 1)).status, 409, 'accepting the old version is rejected');
  assert.equal((await api('POST', `/sponsorships/${deal.id}/revise`, { token: w.ath.token, body: { lines: [money], ...period } })).status, 403, 'only the sponsor revises');
  assert.equal((await api('PATCH', `/sponsorships/${deal.id}`, { token: w.sponsor.token, body: { status: 'active', version: 2 } })).status, 403, 'the sponsor cannot accept for the recipient');
  assert.equal(must(await accept(w, deal.id, 2)).status, 'active');
  assert.equal((await dues(w, deal.id)).obligations.length, 8, 'six instalments + two deliveries, exactly once');

  const again = await Promise.all([1, 2, 3].map(() => pool.connect().then(async (c) => { try { await c.query('BEGIN'); const { generateObligations } = await import('../src/sponsor-agreements.js'); const r = await generateObligations(c, deal.id); await c.query('COMMIT'); return r; } finally { c.release(); } })));
  assert.deepEqual(again, [0, 0, 0], 'retries and parallel workers add nothing');
  assert.equal((await dues(w, deal.id)).obligations.length, 8);

  const hist = must(await api('GET', `/sponsorships/${deal.id}`, { token: w.sponsor.token })).history.map((h) => h.action);
  assert.deepEqual(hist, ['proposed', 'revised', 'accepted']);
  assert.equal((await api('GET', `/sponsorships/${deal.id}`, { token: (await signup(['sponsor'])).token })).status, 403, 'an unrelated sponsor sees nothing');
  assert.equal((await api('GET', `/sponsorships/${deal.id}`, { token: (await signup(['athlete'])).token })).status, 403);
  assert.deepEqual(must(await api('GET', '/sponsorship-obligations', { token: (await signup(['sponsor'])).token })).obligations, []);
});

test('payments: partial, bounded, unverified until confirmed, only the recipient confirms, reversals reopen', async () => {
  const w = await world();
  const deal = must(await propose(w, { lines: [{ ...money, instalments: 2 }] }), 201);
  must(await accept(w, deal.id, 1));
  const [d1] = (await dues(w, deal.id)).obligations;
  const pay = (amt, ref, extra = {}) => api('POST', `/sponsorship-obligations/${d1.id}/payments`, { token: w.sponsor.token, body: { amount_cents: amt, currency: 'SGD', method: 'bank_transfer', reference: ref, paid_on: '2030-01-14', ...extra } });
  assert.equal((await api('POST', `/sponsorship-obligations/${d1.id}/payments`, { token: w.ath.token, body: { amount_cents: 1, currency: 'SGD', method: 'cash', reference: 'zz', paid_on: '2030-01-14' } })).status, 403, 'recipient does not report sponsor payments');
  assert.equal((await pay(100, 'R1', { currency: 'USD' })).status, 400);
  assert.equal((await pay(100, 'R1', { evidence_url: 'http://x.example/p.png' })).status, 400, 'https evidence only');
  const p1 = must(await pay(30000, 'BANK-1', { evidence_url: 'https://x.example/receipt.png' }), 201);
  assert.equal((await pay(30000, 'BANK-1')).status, 409, 'the same reference twice');
  assert.equal((await pay(30000, 'BANK-2')).status, 409, 'over the amount due');
  must(await pay(20000, 'BANK-2'), 201);
  let t = (await dues(w, deal.id)).totals[0];
  assert.equal(t.currency, 'SGD'); assert.equal(t.committed_cents, 100000);
  assert.equal(t.confirmed_cents, 0, 'nothing is received until confirmed'); assert.equal(t.reported_unverified_cents, 50000); assert.equal(t.outstanding_cents, 100000);
  assert.equal((await api('PATCH', `/sponsorship-payments/${p1.id}`, { token: w.sponsor.token, body: { status: 'confirmed' } })).status, 403, 'the sponsor cannot confirm its own payment');
  must(await api('PATCH', `/sponsorship-payments/${p1.id}`, { token: w.ath.token, body: { status: 'confirmed' } }));
  assert.equal((await api('PATCH', `/sponsorship-payments/${p1.id}`, { token: w.ath.token, body: { status: 'confirmed' } })).status, 409, 'a decision is final');
  const p2 = (await pool.query("SELECT id FROM sponsorship_payments WHERE reference='BANK-2'")).rows[0];
  assert.equal((await api('PATCH', `/sponsorship-payments/${p2.id}`, { token: w.ath.token, body: { status: 'rejected' } })).status, 400, 'a reason is needed');
  must(await api('PATCH', `/sponsorship-payments/${p2.id}`, { token: w.ath.token, body: { status: 'confirmed' } }));
  let row = (await dues(w, deal.id)).obligations[0];
  assert.equal(row.status, 'fulfilled'); assert.equal(row.confirmed_cents, 50000);
  must(await api('PATCH', `/sponsorship-payments/${p2.id}`, { token: w.ath.token, body: { status: 'reversed', note: 'refunded' } }));
  row = (await dues(w, deal.id)).obligations[0];
  assert.equal(row.status, 'scheduled', 'a reversal reopens the due'); assert.equal(row.confirmed_cents, 30000);
  t = (await dues(w, deal.id)).totals[0];
  assert.equal(t.confirmed_cents, 30000); assert.equal(t.outstanding_cents, 70000);
});

test('goods: partial receipt, rejection, quantity bounds, only the recipient confirms receipt', async () => {
  const w = await world();
  const deal = must(await propose(w, { lines: [{ kind: 'goods', label: 'Shoes', quantity: 5, unit: 'pairs', cadence: 'once', first_due_on: '2030-02-01' }] }), 201);
  must(await accept(w, deal.id, 1));
  const [o] = (await dues(w, deal.id)).obligations;
  const send = (q) => api('POST', `/sponsorship-obligations/${o.id}/deliveries`, { token: w.sponsor.token, body: { quantity: q, reference: 'AWB1' } });
  const d1 = must(await send(3), 201);
  assert.equal((await send(3)).status, 409, 'cannot dispatch more than committed');
  assert.equal((await api('PATCH', `/sponsorship-deliveries/${d1.id}`, { token: w.sponsor.token, body: { status: 'received' } })).status, 403, 'dispatching is not receiving');
  assert.equal((await api('PATCH', `/sponsorship-deliveries/${d1.id}`, { token: w.ath.token, body: { status: 'received', received_quantity: 4 } })).status, 400);
  must(await api('PATCH', `/sponsorship-deliveries/${d1.id}`, { token: w.ath.token, body: { status: 'received', received_quantity: 2 } }));
  let row = (await dues(w, deal.id)).obligations[0];
  assert.equal(row.received_quantity, 2); assert.equal(row.status, 'scheduled');
  const d2 = must(await send(3), 201);
  must(await api('PATCH', `/sponsorship-deliveries/${d2.id}`, { token: w.ath.token, body: { status: 'rejected', note: 'wrong size' } }));
  const d3 = must(await send(3), 201);
  must(await api('PATCH', `/sponsorship-deliveries/${d3.id}`, { token: w.ath.token, body: { status: 'received' } }));
  row = (await dues(w, deal.id)).obligations[0];
  assert.equal(row.received_quantity, 5); assert.equal(row.status, 'fulfilled');
});

test('pure endorsement needs no cash; evidence is reviewed by the other party with a trail', async () => {
  const w = await world();
  const deal = must(await propose(w, { lines: [{ ...post, custom_dates: ['2030-02-10'] }, { kind: 'endorsement', label: 'Brand story', promoter: 'sponsor', cadence: 'once', first_due_on: '2030-03-01' }] }), 201);
  assert.equal(deal.amount_cents, 0);
  must(await accept(w, deal.id, 1));
  const os = (await dues(w, deal.id)).obligations;
  assert.equal(os.length, 2);
  const mine = os.find((o) => o.label === 'Instagram posts');
  const sub = (token, u = 'https://x.example/post/1') => api('POST', `/sponsorship-obligations/${mine.id}/submissions`, { token, body: { evidence_url: u } });
  assert.equal((await sub(w.sponsor.token)).status, 403, 'only the promoter submits');
  const s1 = must(await sub(w.ath.token), 201);
  assert.equal((await sub(w.ath.token)).status, 409, 'one open submission at a time');
  assert.equal((await api('PATCH', `/sponsorship-submissions/${s1.id}`, { token: w.ath.token, body: { status: 'accepted' } })).status, 403, 'promoter cannot review itself');
  assert.equal((await api('PATCH', `/sponsorship-submissions/${s1.id}`, { token: w.sponsor.token, body: { status: 'revision_requested' } })).status, 400);
  must(await api('PATCH', `/sponsorship-submissions/${s1.id}`, { token: w.sponsor.token, body: { status: 'revision_requested', note: 'Logo hidden' } }));
  const s2 = must(await sub(w.ath.token, 'https://x.example/post/2'), 201);
  must(await api('PATCH', `/sponsorship-submissions/${s2.id}`, { token: w.sponsor.token, body: { status: 'accepted' } }));
  assert.equal((await dues(w, deal.id, { kind: 'endorsement', state: 'fulfilled' })).obligations.length, 1);
  const sum = must(await api('GET', '/sponsorship-summary', { token: w.sponsor.token }));
  assert.equal(sum.endorsements_to_review, 0);
  assert.deepEqual(must(await api('GET', `/sponsorships/${deal.id}`, { token: w.sponsor.token })).history.map((h) => h.action).slice(-4), ['endorsement_submitted', 'endorsement_revision_requested', 'endorsement_submitted', 'endorsement_accepted']);
});

test('ending an agreement stops untouched future dues but keeps what is due, overdue or part-paid', async () => {
  const w = await world();
  const deal = must(await propose(w, { starts_on: '2020-01-01', ends_on: '2099-12-31', lines: [{ ...money, first_due_on: '2020-01-15', cadence: 'custom', custom_dates: ['2020-01-15', '2020-02-15', '2099-01-01', '2099-02-01'], instalments: undefined }] }), 201);
  must(await accept(w, deal.id, 1));
  let r = await dues(w, deal.id);
  assert.equal(r.totals[0].overdue_cents, 100000, 'two past dues are overdue');
  assert.equal((await dues(w, deal.id, { state: 'overdue' })).obligations.length, 2);
  const future = r.obligations.filter((o) => o.due_on > '2090');
  must(await api('POST', `/sponsorship-obligations/${future[0].id}/payments`, { token: w.sponsor.token, body: { amount_cents: 100, currency: 'SGD', method: 'cash', reference: 'ADV', paid_on: '2030-01-01' } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: w.sponsor.token, body: { status: 'ended', reason: 'brand pulled out' } }));
  r = await dues(w, deal.id);
  const by = Object.fromEntries(r.obligations.map((o) => [o.due_on, o.status]));
  assert.equal(by['2020-01-15'], 'scheduled', 'debt is not erased'); assert.equal(by['2099-01-01'], 'scheduled', 'part-paid stays'); assert.equal(by['2099-02-01'], 'cancelled', 'untouched future due is stopped');
  const sm = must(await api('GET', '/sponsorship-summary', { token: w.ath.token }));
  assert.equal(sm.overdue, 2, 'the two past dues are still owed after the agreement ended');
});

test('agreement detail lists payments, deliveries and submissions for participants', async () => {
  const w = await world();
  const deal = must(await propose(w, { lines: [{ ...money, instalments: 1 }] }), 201);
  must(await accept(w, deal.id, 1));
  const [o] = (await dues(w, deal.id)).obligations;
  must(await api('POST', `/sponsorship-obligations/${o.id}/payments`, { token: w.sponsor.token, body: { amount_cents: 1000, currency: 'SGD', method: 'cash', reference: 'C1', paid_on: '2030-01-10' } }), 201);
  const g = must(await api('GET', `/sponsorships/${deal.id}`, { token: w.ath.token }));
  assert.equal(g.obligations[0].payments[0].status, 'reported');
  assert.equal(g.legacy_amount_cents, undefined);
});
