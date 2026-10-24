import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ob_${n}_${roles[0]}`, display_name: `Builder ${n}`, email: `ob${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };

const period = { starts_on: '2031-01-01', ends_on: '2031-06-30' };
const cash = { kind: 'money', label: 'Monthly support', currency: 'INR', amount_cents: 3000000, cadence: 'monthly', first_due_on: '2031-01-05', instalments: 4 };
const kit = { kind: 'goods', label: 'Match kits', quantity: 12, unit: 'kits', estimate_cents: 3600000, currency: 'INR', cadence: 'custom', custom_dates: ['2031-02-20'] };
const endorse = { kind: 'endorsement', label: 'Posts', promoter: 'recipient', cadence: 'custom', custom_dates: ['2031-03-31'], terms: { channels: ['instagram'], exclusivity: 'No rival kit brand', asset_usage: 'Logo on kit' } };
const lessons = { kind: 'service', service_type: 'coaching', label: 'Coaching sessions', quantity: 4, cadence: 'once', first_due_on: '2031-02-01' };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('mixed offer to an event: the preview equals the dues the server creates, and cash/estimates stay apart', async () => {
  const sponsor = await signup(['sponsor']), org = await signup(['organizer']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: 'BuilderBrand' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Builder Cup', sport: 'football' } }), 201);
  const lines = [cash, kit, endorse, lessons];
  const preview = must(await api('POST', '/sponsorship-schedule/preview', { token: sponsor.token, body: { lines, ...period } }));
  assert.deepEqual(preview.committed, { INR: 12000000 });
  assert.deepEqual(preview.estimated_not_cash, { INR: 3600000 }, 'a valuation is never cash');
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'event', target_id: ev.id, ...period, lines, client_ref: 'form-event-0001' } }), 201);
  // the recipient sees the same preview before accepting
  const seen = must(await api('GET', `/sponsorships/${deal.id}`, { token: org.token }));
  assert.deepEqual(seen.schedule.occurrences.map((o) => [o.due_on, o.kind, o.amount_cents, o.quantity]), preview.occurrences.map((o) => [o.due_on, o.kind, o.amount_cents, o.quantity]), 'recipient preview matches the sponsor preview');
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: org.token, body: { status: 'active', version: 1 } }));
  const dues = must(await api('GET', '/sponsorship-obligations', { token: org.token, query: { sponsorship_id: deal.id, limit: 100 } }));
  assert.deepEqual(dues.obligations.map((o) => [o.due_on, o.kind, o.amount_cents == null ? null : Number(o.amount_cents), o.quantity]), preview.occurrences.map((o) => [o.due_on, o.kind, o.amount_cents, o.quantity]), 'the preview is exactly what the server scheduled');
  assert.equal(dues.obligations.every((o) => o.confirmed_cents === '0' || o.confirmed_cents === 0), true, 'nothing is paid just because it is scheduled');
});

test('sending an offer is idempotent: the same client_ref returns the offer already made', async () => {
  const sponsor = await signup(['sponsor']), org = await signup(['organizer']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: 'IdemBrand' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Idem Cup', sport: 'football' } }), 201);
  const body = { sponsor_id: b.id, target_type: 'event', target_id: ev.id, ...period, lines: [cash], client_ref: 'form-idem-00001' };
  const a1 = must(await api('POST', '/sponsorships', { token: sponsor.token, body }), 201);
  const [a2, a3] = await Promise.all([api('POST', '/sponsorships', { token: sponsor.token, body }), api('POST', '/sponsorships', { token: sponsor.token, body })]);
  assert.equal(a2.body.id, a1.id); assert.equal(a3.body.id, a1.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorships WHERE sponsor_id=$1', [b.id])).rows[0].n, 1, 'exactly one offer exists');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='sponsorship_offer'", [org.id])).rows[0].n, 1, 'the recipient was notified once');
  // another person using the same reference is not handed someone else's offer
  const other = await signup(['sponsor']);
  const ob = must(await api('POST', '/sponsors', { token: other.token, body: { name: 'OtherBrand' } }), 201);
  const mine = must(await api('POST', '/sponsorships', { token: other.token, body: { ...body, sponsor_id: ob.id } }), 201);
  assert.notEqual(mine.id, a1.id);
});

test('an invalid schedule is refused before anything is created', async () => {
  const sponsor = await signup(['sponsor']), org = await signup(['organizer']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: 'LongBrand' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Long Cup', sport: 'football' } }), 201);
  const tooLong = { ...cash, instalments: 8 };
  const r = await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'event', target_id: ev.id, ...period, lines: [tooLong] } });
  assert.equal(r.status, 400); assert.match(JSON.stringify(r.body), /past the end of the agreement/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorships WHERE sponsor_id=$1', [b.id])).rows[0].n, 0);
});

test('sponsor home summary: offers on each side, cash per currency, estimates apart, tenant isolation', async () => {
  const sponsor = await signup(['sponsor']), org = await signup(['organizer']), stranger = await signup(['sponsor']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: 'HomeBrand' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Home Cup', sport: 'football' } }), 201);
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'event', target_id: ev.id, ...period, lines: [cash, kit] } }), 201);
  let s = must(await api('GET', '/sponsorship-summary', { token: sponsor.token }));
  assert.equal(s.offers_awaiting_reply, 1); assert.equal(s.offers_to_answer, 0);
  s = must(await api('GET', '/sponsorship-summary', { token: org.token }));
  assert.equal(s.offers_to_answer, 1); assert.equal(s.offers_awaiting_reply, 0);
  assert.deepEqual(s.totals, [], 'a proposed offer commits no cash yet');
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: org.token, body: { status: 'active', version: 1 } }));
  for (const t of [sponsor, org]) {
    s = must(await api('GET', '/sponsorship-summary', { token: t.token }));
    assert.equal(s.totals.length, 1); assert.equal(s.totals[0].currency, 'INR'); assert.equal(Number(s.totals[0].committed_cents), 12000000);
    assert.equal(Number(s.totals[0].confirmed_cents), 0); assert.equal(Number(s.totals[0].reported_unverified_cents), 0);
    assert.deepEqual(s.estimated_not_cash.map((e) => [e.currency, Number(e.estimated_cents)]), [['INR', 3600000]]);
    assert.equal(s.offers_to_answer + s.offers_awaiting_reply, 0);
  }
  s = must(await api('GET', '/sponsorship-summary', { token: stranger.token }));
  assert.deepEqual(s.totals, []); assert.deepEqual(s.estimated_not_cash, []); assert.equal(s.offers_to_answer, 0); assert.equal(s.offers_awaiting_reply, 0);
  assert.equal((await api('GET', `/sponsorships/${deal.id}`, { token: stranger.token })).status, 403, 'a stranger cannot read the agreement');
  assert.equal((await api('GET', '/sponsorship-summary')).status, 401);
});

test('stale terms: accepting an old version is refused with a conflict', async () => {
  const sponsor = await signup(['sponsor']), org = await signup(['organizer']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: 'StaleBrand' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Stale Cup', sport: 'football' } }), 201);
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'event', target_id: ev.id, ...period, lines: [cash] } }), 201);
  must(await api('POST', `/sponsorships/${deal.id}/revise`, { token: sponsor.token, body: { lines: [{ ...cash, instalments: 3 }], ...period } }));
  assert.equal((await api('PATCH', `/sponsorships/${deal.id}`, { token: org.token, body: { status: 'active', version: 1 } })).status, 409);
});
