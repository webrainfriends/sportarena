// Coach money follows the coach's country: the country of their default address decides the currency they price in, a card keeps
// the currency it was priced in, and classes, sessions and the reports built from them inherit it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { config } = await import('../src/config.js');
const { currencyOfCountry } = await import('../src/coach-currency.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const dob = () => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 30); return d.toISOString().slice(0, 10); };
const inHours = (h) => new Date(Date.now() + h * 36e5).toISOString();
const signup = async (roles, country) => {
  n++;
  const r = must(await api('POST', '/auth/register', { body: { handle: `ccy_${n}`, display_name: `Person ${n}`, email: `ccy${n}@example.com`, password: 'correct-horse-battery', roles, dob: dob() } }), 201);
  if (country) await pool.query("INSERT INTO addresses(owner_kind, owner_id, kind, country, is_default) VALUES ('user',$1,'home',$2,true)", [r.user.id, country]);
  return { ...r.user, token: r.token };
};
const coachWithCard = async (country, body = {}) => {
  const coach = await signup(['coach'], country);
  must(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: 70000 } }), 201);
  const card = must(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Group clinic', sport: 'football', audience: 'group', delivery: 'online', unit: 'session', duration_min: 60, price_cents: 5000, per_person: true, min_participants: 1, max_participants: 10, ...body } }), 201);
  return { coach, card };
};
const publish = (coach, card) => api('POST', '/coach/classes', { token: coach.token, body: { rate_card_id: card.id, starts_at: inHours(48), online_url: 'https://meet.example.com/clinic' } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('a country maps to the currency people use there, or to nothing the platform does not price in', () => {
  assert.equal(currencyOfCountry('US'), 'USD'); assert.equal(currencyOfCountry('in'), 'INR'); assert.equal(currencyOfCountry('JP'), 'JPY');
  assert.equal(currencyOfCountry('DE'), 'EUR'); assert.equal(currencyOfCountry('FR'), 'EUR');
  assert.equal(currencyOfCountry('ZZ'), null); assert.equal(currencyOfCountry(null), null);
});

test('a coach prices in the currency of their country, and classes and sessions inherit it', async () => {
  const us = await coachWithCard('US');
  assert.equal(us.card.currency, 'USD');
  const k = must(await publish(us.coach, us.card), 201);
  assert.equal(k.currency, 'USD'); assert.equal(Number(k.price_cents), 5000);
  const listed = must(await api('GET', '/coach/rate-cards', { token: us.coach.token }));
  assert.equal(listed[0].currency, 'USD');

  const jp = await coachWithCard('JP', { price_cents: 3000 });
  assert.equal(jp.card.currency, 'JPY');
  assert.equal(must(await publish(jp.coach, jp.card), 201).currency, 'JPY');

  const athlete = await signup(['athlete'], 'GB');   // the buyer's own country does not change what the coach charged
  const indiv = must(await api('POST', '/coach/rate-cards', { token: us.coach.token, body: { title: 'One to one', sport: 'football', audience: 'individual', unit: 'hour', price_cents: 9000 } }), 201);
  const hire = must(await api('POST', '/hires', { token: athlete.token, body: { coach_id: us.coach.id, sport: 'football', rate_card_id: indiv.id, starts_at: inHours(72), duration_min: 60 } }), 201);
  assert.equal(hire.currency, 'USD'); assert.equal(Number(hire.total_cents), 9000);
  const bare = must(await api('POST', '/hires', { token: athlete.token, body: { coach_id: jp.coach.id, sport: 'football', starts_at: inHours(96), duration_min: 60 } }), 201);
  assert.equal(bare.currency, 'JPY', 'a session at the coach\'s profile rate is in the coach\'s country currency');
});

test('no country, or a card priced before currencies were recorded, means the platform currency', async () => {
  const none = await coachWithCard(undefined);
  assert.equal(none.card.currency, config.payments.currency);
  assert.equal(must(await publish(none.coach, none.card), 201).currency, config.payments.currency);

  const us = await coachWithCard('US');
  await pool.query('UPDATE coach_rate_cards SET currency=NULL WHERE id=$1', [us.card.id]);   // a legacy card: NULL, kept as the platform currency
  const listed = must(await api('GET', '/coach/rate-cards', { token: us.coach.token }));
  assert.equal(listed[0].currency, config.payments.currency);
  assert.equal(must(await publish(us.coach, { id: us.card.id }), 201).currency, config.payments.currency);
});

test('analytics and the statement report in the coach currency and label every amount', async () => {
  const jp = await coachWithCard('JP', { price_cents: 3000 });
  const a = must(await api('GET', '/coach/analytics', { token: jp.coach.token }));
  assert.equal(a.currency, 'JPY');
  const csv = must(await api('GET', '/coach/report', { token: jp.coach.token })).csv;
  assert.match(csv.split('\n')[0], /Amount,Currency/);
});
