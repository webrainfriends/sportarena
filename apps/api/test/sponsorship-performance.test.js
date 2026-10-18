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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sp_${n}_${roles[0]}`, display_name: `Perf ${n}`, email: `sp${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const perf = async (userId, sport, metric, value, { provenance = 'approved_competition', status = 'approved', direction = 'higher', unit = 'count', on }) => {
  const s = (await pool.query('SELECT id FROM sports WHERE slug=$1', [sport])).rows[0];
  await pool.query(`INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on) VALUES ($1,$2,$3,$4,0,$1,$5,$6,$7,$8,$9)`, [userId, s.id, metric, value, provenance, status, unit, direction, on]);
};
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `PerfBrand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: '2030-01-01', ends_on: '2030-06-30',
    lines: [{ kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 10000, cadence: 'once', first_due_on: '2030-02-01' }] } }), 201);
  return { sponsor, ath, b, deal };
};
const accept = (w) => api('PATCH', `/sponsorships/${w.deal.id}`, { token: w.ath.token, body: { status: 'active', version: 1 } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('results are consent-gated, scoped by evidence, live, and revocable without touching the agreement', async () => {
  const w = await world();
  const read = (token) => api('GET', `/sponsorships/${w.deal.id}/performance`, { token });
  await perf(w.ath.id, 'football', 'goals', 3, { on: '2030-02-01' });
  await perf(w.ath.id, 'football', 'goals', 5, { provenance: 'self_reported', status: 'recorded', on: '2030-02-02' });
  assert.equal((await read(w.sponsor.token)).status, 409, 'nothing before the athlete accepts');
  must(await accept(w));
  assert.equal((await read(w.sponsor.token)).status, 403, 'no consent, no read');
  assert.equal((await api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: w.sponsor.token, body: { enabled: true } })).status, 403, 'a sponsor cannot grant itself access');
  must(await api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: w.ath.token, body: { enabled: true } }));
  let p = must(await read(w.sponsor.token));
  assert.deepEqual(p.metrics.map((m) => [m.evidence, m.best, m.results]), [['approved_competition', 3, 1]], 'official only by default; self-reported practice stays private');
  must(await api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: w.ath.token, body: { enabled: true, scope: 'all_evidence' } }));
  p = must(await read(w.sponsor.token));
  assert.equal(p.metrics.length, 2); assert.ok(p.metrics.every((m) => m.evidence_label));
  await pool.query("UPDATE performances SET status='superseded' WHERE user_id=$1 AND provenance='approved_competition'", [w.ath.id]);
  p = must(await read(w.sponsor.token));
  assert.deepEqual(p.metrics.map((m) => m.evidence), ['self_reported'], 'a corrected result changes the view');
  const other = await signup(['sponsor']);
  assert.equal((await read(other.token)).status, 403, 'an unrelated sponsor is denied');
  must(await api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: w.ath.token, body: { enabled: false, reason: 'changed my mind' } }));
  assert.equal((await read(w.sponsor.token)).status, 403, 'revocation stops reads at once');
  assert.equal((await read(w.ath.token)).status, 200, 'the athlete still sees their own');
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}`, { token: w.ath.token })).body.status, 'active', 'the agreement is unaffected');
});

test('objectives need the athlete\'s agreement, use the metric direction, and never touch a due', async () => {
  const w = await world();
  must(await accept(w));
  must(await api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: w.ath.token, body: { enabled: true } }));
  const o = must(await api('POST', `/sponsorships/${w.deal.id}/objectives`, { token: w.sponsor.token, body: { sport: 'athletics', metric: '100m_time_s', direction: 'lower', target_value: 12, baseline_value: 13, baseline_on: '2030-01-05', window_start: '2030-01-01', window_end: '2030-03-31' } }), 201);
  assert.equal((await api('POST', `/sponsorships/${w.deal.id}/objectives`, { token: w.sponsor.token, body: { sport: 'athletics', metric: 'x', direction: 'lower', target_value: 1, window_start: '2030-03-01', window_end: '2030-01-01' } })).status, 400);
  assert.equal((await api('PATCH', `/sponsorship-objectives/${o.id}`, { token: w.sponsor.token, body: { status: 'agreed' } })).status, 403, 'the sponsor cannot agree for the athlete');
  await perf(w.ath.id, 'athletics', '100m_time_s', 12.4, { direction: 'lower', unit: 's', on: '2030-02-10' });
  let p = must(await api('GET', `/sponsorships/${w.deal.id}/performance`, { token: w.sponsor.token }));
  assert.equal(p.objectives[0].progress, undefined, 'unagreed objectives are not evaluated');
  must(await api('PATCH', `/sponsorship-objectives/${o.id}`, { token: w.ath.token, body: { status: 'agreed' } }));
  p = must(await api('GET', `/sponsorships/${w.deal.id}/performance`, { token: w.sponsor.token }));
  assert.equal(p.objectives[0].progress.best_in_window, 12.4); assert.equal(p.objectives[0].progress.met, false);
  await perf(w.ath.id, 'athletics', '100m_time_s', 11.9, { direction: 'lower', unit: 's', on: '2030-03-01' });
  p = must(await api('GET', `/sponsorships/${w.deal.id}/performance`, { token: w.sponsor.token }));
  assert.equal(p.objectives[0].progress.met, true);
  const dues = must(await api('GET', '/sponsorship-obligations', { token: w.ath.token, query: { sponsorship_id: w.deal.id } })).obligations;
  assert.ok(dues.length && dues.every((d) => d.status === 'scheduled'), 'a missed or met target changes no due');
});

test('reviews: shared notes are seen by both sides, author-only notes by their author, the athlete answers once', async () => {
  const w = await world();
  assert.equal((await api('POST', `/sponsorships/${w.deal.id}/reviews`, { token: w.sponsor.token, body: { body: 'too early' } })).status, 409);
  must(await accept(w));
  const shared = must(await api('POST', `/sponsorships/${w.deal.id}/reviews`, { token: w.sponsor.token, body: { body: 'Great start', next_review_on: '2030-04-01' } }), 201);
  must(await api('POST', `/sponsorships/${w.deal.id}/reviews`, { token: w.sponsor.token, body: { body: 'internal view', visibility: 'author_only' } }), 201);
  assert.deepEqual((await (async () => must(await api('GET', `/sponsorships/${w.deal.id}/reviews`, { token: w.ath.token })))()).map((r) => r.body), ['Great start']);
  assert.equal(must(await api('GET', `/sponsorships/${w.deal.id}/reviews`, { token: w.sponsor.token })).length, 2);
  assert.equal((await api('POST', `/sponsorship-reviews/${shared.id}/response`, { token: w.sponsor.token, body: { response: 'thanks' } })).status, 403);
  must(await api('POST', `/sponsorship-reviews/${shared.id}/response`, { token: w.ath.token, body: { response: 'Thank you' } }), 200);
  assert.equal((await api('POST', `/sponsorship-reviews/${shared.id}/response`, { token: w.ath.token, body: { response: 'again' } })).status, 409);
  const other = await signup(['sponsor']);
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}/reviews`, { token: other.token })).status, 403);
});

test('youth athletes cannot be enabled here', async () => {
  const w = await world();
  must(await accept(w));
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [w.ath.id]);
  assert.equal((await api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: w.ath.token, body: { enabled: true } })).status, 403);
});
