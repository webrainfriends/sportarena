import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { generateObligations } = await import('../src/sponsor-agreements.js');
const { expireAgreementTerms, settleExpiredAgreements, sendRenewalNotices, processSponsorshipTerms } = await import('../src/sponsor-renewals.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sp_${n}_${roles[0]}`, display_name: `Pause ${n}`, email: `sp${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 6 };
const period = { starts_on: '2030-01-01', ends_on: '2030-06-30' };
const today = async () => (await pool.query('SELECT current_date::text AS d')).rows[0].d;
const inDays = async (k) => (await pool.query('SELECT (current_date + $1::int)::text AS d', [k])).rows[0].d;

/** A fresh accepted agreement with six monthly dues (2030), plus an outsider. */
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']), outsider = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `PauseBrand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', ...period, lines: [money] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } }));
  return { sponsor, ath, outsider, deal, id: deal.id };
};
const get = async (w, who = 'ath') => must(await api('GET', `/sponsorships/${w.id}`, { token: w[who].token }));

const sql = async (q, p = []) => (await pool.query(q, p)).rows;
const setEnd = (w, ends) => pool.query('UPDATE sponsorships SET ends_on=$2 WHERE id=$1', [w.id, ends]);
const status = async (w) => (await sql('SELECT status FROM sponsorships WHERE id=$1', [w.id]))[0].status;
const dues = (w) => sql('SELECT id, status, kind, amount_cents FROM sponsorship_obligations WHERE sponsorship_id=$1 ORDER BY seq', [w.id]);
const history = async (w, action) => (await sql('SELECT 1 FROM sponsorship_history WHERE sponsorship_id=$1 AND action=$2', [w.id, action])).length;
const notices = async (w, m) => (await sql('SELECT 1 FROM sponsorship_renewal_notices WHERE sponsorship_id=$1 AND milestone=$2', [w.id, m])).length;
const pings = async (userId, title) => (await sql("SELECT 1 FROM notifications WHERE user_id=$1 AND title LIKE $2", [userId, `${title}%`])).length;
const settleAll = async (w) => { for (const o of await dues(w)) await pool.query("UPDATE sponsorship_obligations SET status='fulfilled', fulfilled_at=now() WHERE id=$1", [o.id]); };
const renewBody = async (w, over = {}) => ({ expected_renewal_rev: (await get(w, 'sponsor')).renewal.renewal_rev, starts_on: '2030-07-01', ends_on: '2030-12-31', ...over });
const renew = async (w, who = 'sponsor', over = {}) => api('POST', `/sponsorships/${w.id}/renewal`, { token: w[who].token, body: await renewBody(w, over) });
const expired = async (w) => { await setEnd(w, await inDays(-1)); await expireAgreementTerms(); return get(w, 'sponsor'); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('the end date alone never settles money: an expired term with unpaid dues is term_expired and every due is still owed', async () => {
  const w = await world();
  const before = await dues(w);
  assert.equal((await expireAgreementTerms()), 0, 'a running agreement is not expired');
  const a = await expired(w);
  assert.equal(a.status, 'term_expired');
  assert.deepEqual(await dues(w), before, 'no due was paid, cancelled or changed by the date passing');
  assert.ok(before.every((o) => o.status === 'scheduled'));
  assert.equal(a.renewal.settlement.state, 'term_expired');
  assert.equal(a.renewal.settlement.open_dues, 6);
  assert.deepEqual(a.renewal.settlement.open_cents, { SGD: 300000 }, 'per-currency, never combined');
  assert.equal(await history(w, 'term_expired'), 1);
  assert.equal(await notices(w, 'expired'), 1);
  assert.ok(await pings(w.ath.id, 'A sponsorship term has ended') >= 1, 'both sides are told');
});

test('an expired term is still payable and becomes completed only when the last due is settled', async () => {
  const w = await world();
  await expired(w);
  const [first, ...rest] = await dues(w);
  for (const o of rest) await pool.query("UPDATE sponsorship_obligations SET status='cancelled', cancelled_at=now() WHERE id=$1", [o.id]);
  must(await api('POST', `/sponsorship-obligations/${first.id}/payments`, { token: w.sponsor.token, body: { amount_cents: 50000, currency: 'SGD', method: 'bank_transfer', reference: 'LATE-1', paid_on: await today() } }), 201);
  assert.equal(await status(w), 'term_expired', 'a report alone settles nothing');
  const p = (await sql("SELECT id FROM sponsorship_payments WHERE reference='LATE-1'"))[0];
  must(await api('PATCH', `/sponsorship-payments/${p.id}`, { token: w.ath.token, body: { status: 'confirmed' } }));
  assert.equal(await status(w), 'completed', 'confirmed payment of the last open due completes the agreement');
  assert.equal(await history(w, 'completed'), 1);
  await settleExpiredAgreements();
  await settleExpiredAgreements();
  assert.equal(await notices(w, 'settled'), 1, 'told once');
  assert.equal((await get(w, 'sponsor')).renewal.settlement.state, 'completed');
});

test('an agreement with nothing owed at expiry goes straight to completed; a paused or not-yet-ended one is untouched', async () => {
  const w = await world();
  await settleAll(w);
  assert.equal((await expired(w)).status, 'completed');
  const live = await world();
  assert.equal(await expireAgreementTerms(), 0);
  assert.equal(await status(live), 'active');
  await pool.query("UPDATE sponsorships SET status='paused', ends_on=$2 WHERE id=$1", [live.id, await inDays(-5)]);
  await expireAgreementTerms();
  assert.equal(await status(live), 'paused', 'a paused agreement is moved by resume, not by the clock');
});

test('scheduled processing is idempotent, also under two workers at once', async () => {
  const w = await world();
  await setEnd(w, await inDays(-1));
  const runs = await Promise.all([expireAgreementTerms(), expireAgreementTerms(), processSponsorshipTerms()]);
  assert.ok(runs.reduce((a, b) => a + b, 0) >= 1);
  assert.equal(await status(w), 'term_expired');
  assert.equal(await history(w, 'term_expired'), 1, 'one transition, one history row');
  assert.equal((await sql('SELECT renewal_rev FROM sponsorships WHERE id=$1', [w.id]))[0].renewal_rev, 1);
  const n = await pings(w.ath.id, 'A sponsorship term has ended');
  await expireAgreementTerms(); await settleExpiredAgreements(); await processSponsorshipTerms();
  assert.equal(await pings(w.ath.id, 'A sponsorship term has ended'), n, 'no repeat notification');
  assert.equal(await history(w, 'term_expired'), 1);
});

test('expiry follows the agreement\'s own timezone, and an unknown zone falls back to UTC', async () => {
  const pago = (await sql("SELECT (now() AT TIME ZONE 'Pacific/Pago_Pago')::date::text AS d"))[0].d;
  const west = await world(), east = await world(), junk = await world();
  await pool.query("UPDATE sponsorships SET timezone='Pacific/Pago_Pago', ends_on=$2 WHERE id=$1", [west.id, pago]);
  await pool.query("UPDATE sponsorships SET timezone='Pacific/Kiritimati', ends_on=$2 WHERE id=$1", [east.id, pago]);
  await pool.query("UPDATE sponsorships SET timezone='Not/AZone', ends_on=$2 WHERE id=$1", [junk.id, await inDays(-2)]);
  await expireAgreementTerms();
  assert.equal(await status(west), 'active', 'its last day has not finished where it is signed');
  assert.equal(await status(east), 'term_expired', 'the same calendar date is already over 25 hours further east');
  assert.equal(await status(junk), 'term_expired', 'a bad zone name does not break the sweep');
});

test('renewal reminders go out at 60/30/7 days, once each, and say nothing renews by itself', async () => {
  const w = await world();
  await setEnd(w, await inDays(75));
  await sendRenewalNotices();
  assert.equal(await notices(w, 'd60'), 0, 'outside the 60 day window');
  await setEnd(w, await inDays(25));
  await sendRenewalNotices(); await sendRenewalNotices();
  assert.equal(await notices(w, 'd30'), 1);
  assert.equal(await pings(w.ath.id, 'A sponsorship ends in'), 1, 'exactly one reminder per milestone');
  await setEnd(w, await inDays(5));
  await sendRenewalNotices();
  assert.equal(await notices(w, 'd7'), 1);
  assert.ok(await pings(w.sponsor.id, 'A sponsorship ends in') >= 1);
  assert.match((await sql("SELECT title FROM notifications WHERE user_id=$1 AND title LIKE 'A sponsorship ends in%'", [w.ath.id]))[0].title, /will not renew unless you both agree/);
  const r = await renew(w);
  must(r, 201);
  await setEnd(w, await inDays(3));
  const before = await pings(w.ath.id, 'A sponsorship ends in');
  await sendRenewalNotices();
  assert.equal(await pings(w.ath.id, 'A sponsorship ends in'), before, 'no reminder once a renewal is on the table');
});

test('renewal is a new linked agreement that needs the recipient\'s acceptance of the CURRENT version; nothing renews silently', async () => {
  const w = await world();
  assert.equal((await renew(w)).status, 409, 'far from the end of the term: outside the renewal window');
  const a = await expired(w);
  assert.equal(a.renewal.can_renew, true);
  const r = must(await renew(w), 201);
  assert.equal(r.status, 'proposed');
  assert.equal(r.renews_id, w.id);
  assert.equal((await status(w)), 'term_expired', 'proposing changes nothing on the predecessor');
  assert.equal((await dues(w)).length, 6);
  assert.equal((await sql('SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id=$1', [r.id]))[0].n, 0, 'no dues exist until the exact terms are accepted');
  assert.equal((await api('PATCH', `/sponsorships/${r.id}`, { token: w.ath.token, body: { status: 'active' } })).status, 400, 'a version is required');
  assert.equal((await api('PATCH', `/sponsorships/${r.id}`, { token: w.ath.token, body: { status: 'active', version: 7 } })).status, 409, 'a stale version is refused');
  assert.equal((await api('PATCH', `/sponsorships/${r.id}`, { token: w.sponsor.token, body: { status: 'active', version: 1 } })).status, 403, 'the proposer cannot accept their own renewal');
  assert.equal((await api('PATCH', `/sponsorships/${r.id}`, { token: w.outsider.token, body: { status: 'active', version: 1 } })).status, 403);
  const next = must(await api('PATCH', `/sponsorships/${r.id}`, { token: w.ath.token, body: { status: 'active', version: 1 } }));
  assert.equal(next.status, 'active');
  const dues2 = await sql('SELECT due_on::text AS d FROM sponsorship_obligations WHERE sponsorship_id=$1 ORDER BY seq', [r.id]);
  assert.equal(dues2.length, 6);
  assert.deepEqual(dues2[0], { d: '2030-07-15' }, 'dates carried over, shifted by the gap between the two start dates');
  assert.equal(await history(w, 'renewed'), 1);
  const succ = await get(w, 'ath');
  assert.equal(succ.renewal.successor.id, r.id);
  assert.equal(succ.renewal.can_renew, false);
  const child = await get({ id: r.id, ath: w.ath }, 'ath');
  assert.equal(child.renewal.predecessor.id, w.id, 'the predecessor stays reachable');
  assert.equal((await dues(w)).length, 6, 'the predecessor\'s dues and history are untouched');
});

test('only one live renewal per agreement, and a declined one can be replaced', async () => {
  const w = await world();
  await expired(w);
  const [x, y] = await Promise.all([renew(w), renew(w, 'ath')]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409], 'two concurrent proposals: exactly one wins');
  const winner = x.status === 201 ? x.body : y.body;
  assert.equal((await renew(w)).status, 409, 'a third attempt is refused too');
  const decliner = x.status === 201 ? 'ath' : 'sponsor', proposer = x.status === 201 ? 'sponsor' : 'ath';
  if (proposer === 'sponsor') assert.equal((await api('PATCH', `/sponsorships/${winner.id}`, { token: w[proposer].token, body: { status: 'declined', reason: 'mine' } })).status, 403, 'a sponsor cannot decline its own renewal (it withdraws it)');
  must(await api('PATCH', `/sponsorships/${winner.id}`, { token: w[decliner].token, body: { status: 'declined', reason: 'not now' } }));
  must(await renew(w), 201);
});

test('a renewal proposed by the recipient is signed off by the sponsor, never by the recipient themself', async () => {
  const w = await world();
  await expired(w);
  const r = must(await renew(w, 'ath'), 201);
  assert.equal(r.terms_side, 'recipient');
  assert.equal((await api('PATCH', `/sponsorships/${r.id}`, { token: w.ath.token, body: { status: 'active', version: 1 } })).status, 403);
  must(await api('PATCH', `/sponsorships/${r.id}`, { token: w.sponsor.token, body: { status: 'active', version: 1 } }));
  assert.equal((await sql('SELECT status FROM sponsorships WHERE id=$1', [r.id]))[0].status, 'active');
});

test('renewal validation: the new period must follow the old one, outsiders and non-accepted agreements are refused, a stale view is refused', async () => {
  const w = await world();
  await expired(w);
  assert.equal((await renew(w, 'sponsor', { starts_on: await inDays(-1), ends_on: '2030-12-31' })).status, 400, 'must start after the old term ends');
  assert.equal((await renew(w, 'sponsor', { starts_on: await inDays(10), ends_on: await inDays(5) })).status, 400);
  assert.equal((await api('POST', `/sponsorships/${w.id}/renewal`, { token: w.outsider.token, body: { expected_renewal_rev: 0, starts_on: '2030-07-01', ends_on: '2030-12-31' } })).status, 403, 'tenant isolation');
  assert.equal((await api('POST', `/sponsorships/${w.id}/renewal`, { token: w.sponsor.token, body: { expected_renewal_rev: 0, starts_on: '2031-07-01', ends_on: '2031-12-31' } })).status, 409, 'stale renewal_rev');
  const ended = await world();
  must(await api('PATCH', `/sponsorships/${ended.id}`, { token: ended.sponsor.token, body: { status: 'ended', reason: 'stop' } }));
  assert.equal((await renew(ended)).status, 409, 'a terminated agreement is not renewed');
});

test('renewal intents: each side states its plan, stale views are refused, outsiders cannot read or write', async () => {
  const w = await world();
  const rev = (await get(w, 'sponsor')).renewal.renewal_rev;
  const put = (who, body) => api('POST', `/sponsorships/${w.id}/renewal-assessment`, { token: w[who].token, body });
  must(await put('sponsor', { expected_renewal_rev: rev, intent: 'renew', note: 'Happy to continue' }));
  assert.equal((await put('ath', { expected_renewal_rev: rev, intent: 'renegotiate' })).status, 409, 'the other side already changed the agreement');
  must(await put('ath', { expected_renewal_rev: rev + 1, intent: 'renegotiate', note: 'Higher monthly fee' }));
  must(await put('ath', { expected_renewal_rev: rev + 2, intent: 'not_renew' }));
  const view = (await get(w, 'sponsor')).renewal;
  assert.deepEqual(view.assessments.map((a) => [a.side, a.intent]), [['recipient', 'not_renew'], ['sponsor', 'renew']]);
  assert.equal(await status(w), 'active', 'an intention never renews or ends anything');
  assert.equal((await put('outsider', { expected_renewal_rev: 0, intent: 'renew' })).status, 403);
  assert.equal((await api('GET', `/sponsorships/${w.id}`, { token: w.outsider.token })).status, 403);
  assert.ok(await history(w, 'renewal_intent_not_renew'));
});

test('athlete consent: a sponsor cannot renew with an athlete who has since closed sponsorship offers; the athlete still can propose', async () => {
  const w = await world();
  await expired(w);
  await pool.query('UPDATE sponsorship_profiles SET open_to_sponsors=false WHERE user_id=$1', [w.ath.id]);
  assert.equal((await renew(w, 'sponsor')).status, 409);
  must(await renew(w, 'ath'), 201);
});

test('list_sponsorship_renewals: deterministic, scoped to the caller, soonest end first, with what is owed', async () => {
  const a = await world(), b = await world();
  await setEnd(a, await inDays(20)); await setEnd(b, await inDays(10));
  const mine = must(await api('GET', '/sponsorship-renewals', { token: a.sponsor.token }));
  assert.deepEqual(mine.map((x) => x.id), [a.id]);
  assert.equal(mine[0].open_dues, 6);
  const both = await api('GET', '/sponsorship-renewals', { token: b.ath.token, query: { as: 'target' } });
  assert.deepEqual(must(both).map((x) => x.id), [b.id]);
  assert.deepEqual(must(await api('GET', '/sponsorship-renewals', { token: a.outsider.token })), [], 'an outsider sees nothing');
  await setEnd(a, await inDays(200));
  assert.deepEqual(must(await api('GET', '/sponsorship-renewals', { token: a.sponsor.token })), [], 'outside the window it is not listed');
  assert.equal((await api('GET', '/sponsorship-renewals')).status, 401);
});

test('the migration is additive: existing agreements keep their status, dues and history', async () => {
  const w = await world();
  const row = (await sql('SELECT status, renews_id, renewal_rev, term_expired_at, settled_at FROM sponsorships WHERE id=$1', [w.id]))[0];
  assert.deepEqual(row, { status: 'active', renews_id: null, renewal_rev: 0, term_expired_at: null, settled_at: null });
  await assert.rejects(pool.query("UPDATE sponsorships SET status='nonsense' WHERE id=$1", [w.id]));
  await assert.rejects(pool.query('UPDATE sponsorships SET renews_id=id WHERE id=$1', [w.id]), 'an agreement cannot succeed itself');
});

test('the proposer of a renewal can withdraw it; the other side can decline it; neither can do the other\'s job', async () => {
  const a = await world(); await expired(a);
  const r1 = must(await renew(a, 'ath'), 201); // recipient proposes
  assert.equal((await api('POST', `/sponsorships/${r1.id}/withdraw`, { token: a.sponsor.token })).status, 403, 'the sponsor did not propose it');
  assert.equal((await api('POST', `/sponsorships/${r1.id}/withdraw`, { token: a.outsider.token })).status, 403);
  must(await api('POST', `/sponsorships/${r1.id}/withdraw`, { token: a.ath.token }));
  const r2 = must(await renew(a, 'ath'), 201);
  must(await api('PATCH', `/sponsorships/${r2.id}`, { token: a.sponsor.token, body: { status: 'declined', reason: 'not this year' } }));
  assert.equal((await sql('SELECT status FROM sponsorships WHERE id=$1', [r2.id]))[0].status, 'declined');
  assert.equal(await status(a), 'term_expired', 'declining a renewal leaves the predecessor and what it owes alone');
  assert.equal((await dues(a)).length, 6);
});
