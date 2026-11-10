// The referee's path to being asked and paid, over REST exactly as the app calls it: official profile -> sports -> rate cards -> payout account ->
// tax profile, with the workbench's set-up checklist reading each record. Guards against these capabilities dropping out of the registry again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const { config } = await import('../src/config.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ro_${n}`, display_name: `Ref ${n}`, email: `ro${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const steps = async (who) => Object.fromEntries(must(await api('GET', '/me/officials/home', { token: who.token })).setup.steps.map((s) => [s.key, s]));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('every referee capability the app calls is registered (REST, OpenAPI and MCP share the one list)', () => {
  const names = new Set(capabilities.map((c) => c.name));
  for (const name of ['get_my_official_profile', 'upsert_official_profile', 'save_official_profile_sports', 'publish_official_profile', 'list_my_rate_cards', 'create_rate_card', 'activate_rate_card', 'calculate_quote',
    'set_official_tax_profile', 'get_official_tax_profile', 'official_earnings_report', 'set_official_payout_account', 'get_official_payout_account']) assert.ok(names.has(name), `${name} is registered`);
  // the referee routes must not collide with each other or with anything registered before them
  const mine = capabilities.filter((c) => /official|rate-agreement|tax-jurisdictions/.test(c.path));
  const routes = mine.map((c) => `${c.method} ${c.path.replace(/:[A-Za-z_]+/g, ':x')}`);
  assert.deepEqual(routes.filter((r, i) => routes.indexOf(r) !== i), [], 'no two referee capabilities answer the same route');
  assert.equal(new Set(mine.map((c) => c.name)).size, mine.length, 'no referee capability name is registered twice');
});

test('set-up journey: profile, sports, rate cards, payout account and tax each move their own checklist step', async () => {
  const ref = await signup(['referee']), other = await signup(['referee']);
  assert.equal((await api('GET', '/me/official-profile', { token: ref.token })).status, 404, 'nothing until the first save');
  let s = await steps(ref);
  assert.deepEqual([s.profile.state, s.rates.state, s.payout.state, s.tax.state], ['todo', 'todo', 'todo', 'todo']);

  // 1. profile
  let p = must(await api('POST', '/me/official-profile', { token: ref.token, body: { display_name_pref: 'R. Mehta', bio: 'Fifteen seasons', nationality: 'IN', step_reached: 2 } }), 201);
  assert.equal(p.status, 'draft'); assert.equal(p.nationality, 'IN');
  assert.equal((await steps(ref)).profile.state, 'in_progress');
  const opts = must(await api('GET', '/me/official-profile/options', { token: ref.token }));
  const sport = opts.sports.find((x) => x.name === 'Football') ?? opts.sports[0];
  must(await api('PUT', '/me/official-profile/sports', { token: ref.token, body: { sports: [{ sport_id: sport.id, role: 'referee', primary_sport: true }] } }));

  // 2. rate cards live in one catalogue
  assert.deepEqual(must(await api('GET', '/me/official-profile/rate-cards/catalog', { token: ref.token })), []);
  const card = must(await api('POST', '/me/official-profile/rate-cards', { token: ref.token, body: { name: 'League match', sport_id: sport.id, role: 'referee', fixture_type: 'league', fee_minor: 250000, fee_currency: 'INR', service_type: 'match', weekend_sat_pct: 25, private_notes: 'Floor is 2000' } }), 201);
  assert.equal(card.status, 'draft');
  s = await steps(ref);
  assert.equal(s.rates.state, 'in_progress'); assert.equal(s.rates.drafts, 1);
  must(await api('POST', `/me/official-profile/rate-cards/${card.id}/activate`, { token: ref.token }));
  s = await steps(ref);
  assert.equal(s.rates.state, 'done'); assert.equal(s.rates.count, 1);
  const mine = must(await api('GET', '/me/official-profile/rate-cards/catalog', { token: ref.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].status, 'active'); assert.equal(mine[0].sport_name, sport.name); assert.equal(Number(mine[0].fee_minor), 250000);
  assert.equal((await api('POST', `/me/official-profile/rate-cards/${card.id}/activate`, { token: other.token })).status, 404, 'another official cannot touch my card');

  // 3. payout account
  const currency = config.settlement.currencies[0];
  assert.equal((await api('GET', `/officials/${ref.id}/payout-account`, { token: ref.token, query: { currency } })).status, 404);
  must(await api('PUT', `/officials/${ref.id}/payout-account`, { token: ref.token, body: { currency, legal_name: 'Rohan Mehta', tax_country: 'IN', holder_name: 'Rohan Mehta', account_number: '123456789012', bank_code: 'HDFC0001234' } }), 201);
  const acct = must(await api('GET', `/officials/${ref.id}/payout-account`, { token: ref.token, query: { currency } }));
  assert.equal(acct.status, 'pending'); assert.equal(acct.last4, '9012'); assert.ok(!('details_enc' in acct));
  assert.equal((await steps(ref)).payout.state, 'in_progress');
  assert.equal((await api('GET', `/officials/${ref.id}/payout-account`, { token: other.token, query: { currency } })).status, 404, 'existence is not leaked');

  // 4. tax profile
  assert.equal((await api('POST', '/me/official-tax-profile', { token: (await signup(['organizer'])).token, body: { legal_name: 'Org', tax_country: 'IN' } })).status, 403);
  must(await api('POST', '/me/official-tax-profile', { token: ref.token, body: { legal_name: 'Rohan Mehta', tax_country: 'IN', tax_regime: 'gst', registration_status: 'not_registered' } }));
  const tax = must(await api('GET', '/me/official-tax-profile', { token: ref.token }));
  assert.equal(tax.current.tax_country, 'IN'); assert.equal(tax.current.legal_name, 'Rohan Mehta');
  s = await steps(ref);
  assert.equal(s.tax.state, 'done');
  const home = must(await api('GET', '/me/officials/home', { token: ref.token }));
  assert.equal(home.setup.done, 2); assert.equal(home.setup.next, 'profile');

  // nothing of mine shows on another official's checklist
  assert.deepEqual(Object.values(await steps(other)).map((x) => x.state), ['todo', 'todo', 'todo', 'todo', 'todo']);
});

test('saving the wizard never archives rate cards kept in the catalogue', async () => {
  const ref = await signup(['referee']);
  must(await api('POST', '/me/official-profile', { token: ref.token, body: { display_name_pref: 'Keeper', step_reached: 7 } }), 201);
  const a = must(await api('POST', '/me/official-profile/rate-cards', { token: ref.token, body: { name: 'Cup tie', fixture_type: 'cup', fee_minor: 5000, fee_currency: 'GBP', status: 'active' } }), 201);
  const prof = must(await api('GET', '/me/official-profile', { token: ref.token }));
  must(await api('POST', '/me/official-profile', { token: ref.token, body: { row_version: prof.row_version, step_reached: 8 } }), 201);
  const cards = must(await api('GET', '/me/official-profile/rate-cards/catalog', { token: ref.token }));
  assert.deepEqual(cards.map((c) => [c.id, c.status]), [[a.id, 'active']], 'moving on from the rates step leaves every card in place');
});
