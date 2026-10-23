// Termination, refunds, returns and final settlement of a sponsorship agreement (#298).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { endDueTerminations } = await import('../src/sponsor-termination.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `tm_${n}_${roles[0]}`, display_name: `Term ${n}`, email: `tm${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };

const money = { kind: 'money', label: 'Season support', currency: 'SGD', amount_cents: 100000, cadence: 'custom', custom_dates: ['2020-01-15', '2020-02-15', '2099-01-01', '2099-02-01'] };
const goods = { kind: 'goods', label: 'Rackets', quantity: 10, unit: 'pcs', cadence: 'once', first_due_on: '2020-03-01' };
const world = async (lines = [money, goods]) => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']), outsider = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Brand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: '2020-01-01', ends_on: '2099-12-31', lines } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: 1 } }));
  return { sponsor, ath, outsider, id: deal.id };
};
const get = (w, token = w.ath.token) => api('GET', `/sponsorships/${w.id}`, { token });
const dues = async (w) => must(await get(w)).obligations;
const term = async (w, token = w.ath.token) => must(await api('GET', `/sponsorships/${w.id}/termination`, { token }));
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const notice = (w, body = {}, token = w.sponsor.token) => api('POST', `/sponsorships/${w.id}/termination`, { token, body: { reason_code: 'budget', reason: 'Budget cut', effective_on: tomorrow(), expected_version: 1, ...body } });
const answer = (t, token, action, extra = {}) => api('POST', `/sponsorship-terminations/${t.id}/answer`, { token, body: { action, rev: t.rev, ...extra } });
const pay = async (w, o, amount, ref) => must(await api('POST', `/sponsorship-obligations/${o.id}/payments`, { token: w.sponsor.token, body: { amount_cents: amount, currency: 'SGD', method: 'bank_transfer', reference: ref, paid_on: '2030-01-16' } }), 201);


const receive = async (w, o, sent, got) => {
  const dl = must(await api('POST', `/sponsorship-obligations/${o.id}/deliveries`, { token: w.sponsor.token, body: { quantity: sent } }), 201);
  must(await api('PATCH', `/sponsorship-deliveries/${dl.id}`, { token: w.ath.token, body: { status: 'received', received_quantity: got } }));
  return dl;
};
const endToday = async (w) => { const t = must(await notice(w, { effective_on: today() }), 201); return t.termination; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('notice gives a reason and effective date; the agreement keeps running until then and nothing is deleted', async () => {
  const w = await world();
  assert.equal((await notice(w, { effective_on: '2020-01-01' })).status, 400, 'a past effective date is refused');
  assert.equal((await notice(w, { reason_code: 'other', reason: undefined })).status, 400, 'other needs a reason');
  assert.equal((await notice(w, { expected_version: 7 })).status, 409, 'stale terms version');
  const pre = await term(w);
  assert.equal(pre.termination, null);
  assert.ok(pre.preview.stopped_count >= 1, 'the preview shows what would stop');
  assert.equal(pre.can.give, true);
  const before = await dues(w);
  const t = must(await notice(w), 201).termination;
  assert.equal(t.status, 'notice'); assert.equal(t.given_side, 'sponsor'); assert.equal(t.effective_on, tomorrow());
  assert.equal(must(await get(w)).status, 'active', 'still active until the effective date');
  assert.deepEqual((await dues(w)).map((o) => o.status), before.map((o) => o.status), 'no due changed');
  assert.equal((await notice(w)).status, 409, 'one live termination at a time');
  assert.equal((await answer(t, w.sponsor.token, 'accept')).status, 403, 'cannot accept your own notice');
  const stale = await answer({ ...t, rev: 99 }, w.ath.token, 'accept');
  assert.equal(stale.status, 409); assert.equal(stale.body.error?.details?.code ?? stale.body.details?.code, 'stale_version');
  const agreed = must(await answer(t, w.ath.token, 'accept')).termination;
  assert.equal(agreed.status, 'agreed'); assert.ok(agreed.rev > t.rev);
  assert.equal((await answer(agreed, w.sponsor.token, 'withdraw')).status, 409, 'cannot withdraw after the other side accepted');
});

test('authorization and tenant isolation: outsiders cannot read, write or export', async () => {
  const w = await world();
  assert.equal((await api('GET', `/sponsorships/${w.id}/termination`, { token: w.outsider.token })).status, 403);
  assert.equal((await notice(w, {}, w.outsider.token)).status, 403);
  const t = must(await notice(w), 201).termination;
  assert.equal((await answer(t, w.outsider.token, 'accept')).status, 403);
  assert.equal((await api('GET', `/sponsorships/${w.id}/termination/export`, { token: w.outsider.token })).status, 403);
  assert.equal((await api('POST', `/sponsorship-terminations/${t.id}/returns`, { token: w.outsider.token, body: { delivery_id: t.id, quantity: 1 } })).status, 403);
  assert.equal((await api('POST', `/sponsorship-terminations/${t.id}/settlement`, { token: w.outsider.token, body: { rev: t.rev } })).status, 403);
  const reader = must(await api('GET', `/sponsorships/${w.id}/termination`, { token: w.sponsor.token }));
  assert.equal(reader.can.accept, false, 'the side that gave notice cannot accept it');
});

test('ending keeps due debt, part-paid dues and delivered value; only untouched future dues stop', async () => {
  const w = await world();
  const os = await dues(w);
  const future = os.filter((o) => o.due_on > '2090'), past = os.find((o) => o.due_on === '2020-01-15'), g = os.find((o) => o.kind === 'goods');
  const part = await pay(w, future[0], 100, 'ADV');
  await receive(w, g, 10, 10);
  const t = await endToday(w);
  assert.equal(t.status, 'ended');
  const after = Object.fromEntries((await dues(w)).map((o) => [`${o.kind}${o.due_on}`, o.status]));
  assert.equal(after['money2020-01-15'], 'scheduled', 'overdue debt is not erased');
  assert.equal(after['money2099-01-01'], 'scheduled', 'a part-paid due stays');
  assert.equal(after['money2099-02-01'], 'cancelled', 'an untouched future due is stopped');
  assert.equal(must(await get(w)).status, 'ended');
  assert.equal(past.status, 'scheduled');
  const st = (await term(w)).settlement;
  assert.ok(st.items.some((i) => i.kind === 'due' && !i.blocking), 'the overdue due is exposed, not erased');
  assert.ok(part.id);
});

test('the legacy end action is recorded as a termination and keeps the same safe handling', async () => {
  const w = await world();
  must(await api('PATCH', `/sponsorships/${w.id}`, { token: w.sponsor.token, body: { status: 'ended', reason: 'brand pulled out' } }));
  const t = (await term(w)).termination;
  assert.equal(t.status, 'ended'); assert.equal(t.effective_on, today());
  assert.deepEqual(must(await get(w)).history.map((h) => h.action).filter((a) => a === 'ended'), ['ended']);
  assert.equal((await dues(w)).find((o) => o.due_on === '2099-02-01').status, 'cancelled');
});

test('a notice ends the agreement once its effective date passes, applied once (worker and read)', async () => {
  const w = await world();
  const t = must(await notice(w), 201).termination;
  await pool.query("UPDATE sponsorship_terminations SET effective_on=current_date, notice_on=current_date WHERE id=$1", [t.id]);
  assert.equal(await endDueTerminations(), 1);
  assert.equal(await endDueTerminations(), 0, 'idempotent');
  assert.equal(must(await get(w)).status, 'ended');
  assert.equal((await term(w)).termination.status, 'ended');
});

test('returns can never exceed the goods received, even under concurrency, and declining frees the quantity', async () => {
  const w = await world();
  const g = (await dues(w)).find((o) => o.kind === 'goods');
  const dl = await receive(w, g, 10, 8);
  const t = (await endToday(w));
  const ask = (q) => api('POST', `/sponsorship-terminations/${t.id}/returns`, { token: w.sponsor.token, body: { delivery_id: dl.id, quantity: q } });
  const over = await ask(9); assert.equal(over.status, 409); assert.equal(over.body.error?.details?.returnable ?? over.body.details?.returnable, 8);
  const both = await Promise.all([ask(5), ask(5)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409], 'two concurrent requests cannot both fit');
  const ok = both.find((r) => r.status === 201).body;
  assert.equal((await api('POST', `/sponsorship-terminations/${t.id}/returns`, { token: w.ath.token, body: { delivery_id: dl.id, quantity: 1 } })).status, 403, 'only the sponsor asks for goods back');
  assert.equal((await api('PATCH', `/sponsorship-returns/${ok.id}`, { token: w.sponsor.token, body: { status: 'received' } })).status, 409, 'goods can be confirmed back only after the recipient accepted');
  assert.equal((await api('PATCH', `/sponsorship-returns/${ok.id}`, { token: w.ath.token, body: { status: 'declined' } })).status, 400, 'declining needs a reason');
  must(await api('PATCH', `/sponsorship-returns/${ok.id}`, { token: w.ath.token, body: { status: 'declined', note: 'Already used' } }));
  assert.equal((await ask(8)).status, 201, 'a declined return frees the quantity');
  const unreceived = (await dues(w)).find((o) => o.kind === 'goods');
  await assert.rejects(pool.query("INSERT INTO sponsorship_returns(termination_id, delivery_id, quantity, requested_side, requested_by) VALUES ($1,$2,5,'sponsor',$3)", [t.id, dl.id, w.sponsor.id]), /cannot exceed the goods received/, 'the database enforces it too');
  assert.ok(unreceived);
});

test('refunds reference a confirmed payment, are capped, concede the due and record only when the money is back', async () => {
  const w = await world();
  const o = (await dues(w)).find((x) => x.due_on === '2020-01-15');
  const p = await pay(w, o, 100000, 'R1');
  const t = await endToday(w);
  const ask = (amount, id = p.id) => api('POST', `/sponsorship-terminations/${t.id}/refunds`, { token: w.sponsor.token, body: { sponsorship_payment_id: id, amount_cents: amount } });
  assert.equal((await ask(1000)).status, 409, 'a reported (unconfirmed) payment cannot be refunded');
  must(await api('PATCH', `/sponsorship-payments/${p.id}`, { token: w.ath.token, body: { status: 'confirmed' } }));
  assert.equal((await ask(100001)).status, 409, 'cannot exceed what was paid');
  assert.equal((await ask(1000, t.id)).status, 404, 'must reference a real payment of this agreement');
  const r = must(await ask(30000), 201);
  assert.equal(r.currency, 'SGD'); assert.equal(r.sponsorship_payment_id, p.id);
  assert.equal((await ask(80000)).status, 409, 'open requests count against the payment');
  assert.equal((await api('PATCH', `/sponsorship-refunds/${r.id}`, { token: w.sponsor.token, body: { status: 'approved' } })).status, 403, 'the sponsor cannot approve its own refund');
  must(await api('PATCH', `/sponsorship-refunds/${r.id}`, { token: w.ath.token, body: { status: 'approved' } }));
  let due = (await dues(w)).find((x) => x.id === o.id);
  assert.equal(due.refunded_cents, 0, 'nothing is recorded as refunded until the money is back');
  assert.equal((await term(w)).settlement.items.some((i) => i.kind === 'refund' && i.blocking), true);
  must(await api('PATCH', `/sponsorship-refunds/${r.id}`, { token: w.sponsor.token, body: { status: 'refunded' } }));
  due = (await dues(w)).find((x) => x.id === o.id);
  assert.equal(due.refunded_cents, 30000); assert.equal(due.confirmed_cents, 70000); assert.equal(due.status, 'fulfilled', 'the refund does not re-open the due as a debt');
  assert.equal(due.conceded_cents, 30000);
  assert.equal((await api('PATCH', `/sponsorship-refunds/${r.id}`, { token: w.sponsor.token, body: { status: 'refunded' } })).status, 409, 'confirming twice changes nothing');
  const rest = must(await ask(70000), 201);
  must(await api('PATCH', `/sponsorship-refunds/${rest.id}`, { token: w.ath.token, body: { status: 'approved' } }));
  must(await api('PATCH', `/sponsorship-refunds/${rest.id}`, { token: w.sponsor.token, body: { status: 'refunded' } }));
  const p2 = (await dues(w)).find((x) => x.id === o.id).payments.find((x) => x.id === p.id);
  assert.equal(p2.status, 'reversed', 'a fully refunded payment is reversed');
  const rec = must(await api('GET', '/sponsorship-reconciliation', { token: w.sponsor.token, query: { sponsorship_id: w.id } }));
  assert.equal(rec[0].conceded_cents, 100000);
});

test('final settlement exposes unresolved items, blocks on them, carries owed dues on record and freezes the result', async () => {
  const w = await world();
  const os = await dues(w);
  const g = os.find((o) => o.kind === 'goods');
  const dl = must(await api('POST', `/sponsorship-obligations/${g.id}/deliveries`, { token: w.sponsor.token, body: { quantity: 4 } }), 201);
  const pend = await pay(w, os.find((o) => o.due_on === '2020-02-15'), 50000, 'S1');
  const t = await endToday(w);
  let s = (await term(w)).settlement;
  assert.deepEqual([...new Set(s.items.filter((i) => i.blocking).map((i) => i.kind))].sort(), ['delivery', 'payment']);
  assert.ok(s.items.some((i) => i.kind === 'due' && !i.blocking));
  assert.equal(s.can_finalise, false);
  const blocked = await api('POST', `/sponsorship-terminations/${t.id}/settlement`, { token: w.sponsor.token, body: { rev: (await term(w)).termination.rev } });
  assert.equal(blocked.status, 409); assert.equal((blocked.body.error?.details ?? blocked.body.details).code, 'unresolved_items');
  must(await api('PATCH', `/sponsorship-deliveries/${dl.id}`, { token: w.ath.token, body: { status: 'received', received_quantity: 4 } }));
  must(await api('PATCH', `/sponsorship-payments/${pend.id}`, { token: w.ath.token, body: { status: 'confirmed' } }));
  const cur = (await term(w)).termination;
  const owed = await api('POST', `/sponsorship-terminations/${t.id}/settlement`, { token: w.sponsor.token, body: { rev: cur.rev } });
  assert.equal(owed.status, 409); assert.equal((owed.body.error?.details ?? owed.body.details).code, 'dues_owed', 'owed dues must be acknowledged');
  assert.equal((await api('POST', `/sponsorship-terminations/${t.id}/settlement`, { token: w.sponsor.token, body: { rev: cur.rev - 1, carry_forward: true } })).status, 409, 'stale revision');
  const done = must(await api('POST', `/sponsorship-terminations/${t.id}/settlement`, { token: w.sponsor.token, body: { rev: cur.rev, carry_forward: true } }));
  assert.equal(done.status, 'settled'); assert.ok(done.carried_forward.length >= 1);
  const after = await term(w);
  assert.equal(after.termination.status, 'settled'); assert.deepEqual(after.settlement.carried_forward, done.carried_forward, 'the snapshot is frozen');
  assert.equal((await dues(w)).find((o) => o.due_on === '2020-01-15').status, 'scheduled', 'the owed due is still on record');
  const csv = must(await api('GET', `/sponsorships/${w.id}/termination/export`, { token: w.sponsor.token }));
  assert.match(csv.csv, /carried forward/);
  assert.equal((await api('POST', `/sponsorship-terminations/${t.id}/settlement`, { token: w.sponsor.token, body: { rev: 99, carry_forward: true } })).status, 409);
});

test('a dispute needs a note, blocks the settlement, and is resolved by the person who raised it', async () => {
  const w = await world([{ ...money, custom_dates: ['2099-01-01', '2099-02-01'] }]);
  const t = must(await notice(w, { effective_on: today() }), 201).termination;
  assert.equal(t.status, 'ended');
  assert.equal((await answer(t, w.ath.token, 'dispute')).status, 400);
  const d = must(await answer(t, w.ath.token, 'dispute', { note: 'Notice was too short' })).termination;
  assert.ok(d.disputed_at && !d.dispute_resolved_at);
  const blocked = await api('POST', `/sponsorship-terminations/${t.id}/settlement`, { token: w.sponsor.token, body: { rev: d.rev } });
  assert.equal(blocked.status, 409);
  assert.equal((await answer(d, w.sponsor.token, 'resolve_dispute')).status, 403, 'only the person who disputed it resolves it');
  const ok = must(await answer(d, w.ath.token, 'resolve_dispute')).termination;
  const fin = must(await api('POST', `/sponsorship-terminations/${t.id}/settlement`, { token: w.sponsor.token, body: { rev: ok.rev } }));
  assert.equal(fin.status, 'settled');
});

test('migration is additive: existing agreements keep their data and no termination exists until one is given', async () => {
  const w = await world();
  const before = (await pool.query('SELECT count(*)::int AS n FROM sponsorship_obligations')).rows[0].n;
  await migrate();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_obligations')).rows[0].n, before);
  assert.equal((await term(w)).termination, null);
  assert.equal(must(await get(w)).status, 'active');
});
