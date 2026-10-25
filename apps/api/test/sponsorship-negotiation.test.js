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

const counter = (w, id, v, lines, extra = {}) => api('POST', `/sponsorships/${id}/revise`, { token: w.ath.token, body: { lines, expected_version: v, ...extra } });
const sponsorSees = async (w, id) => must(await api('GET', `/sponsorships/${id}`, { token: w.sponsor.token }));
const athSees = async (w, id) => must(await api('GET', `/sponsorships/${id}`, { token: w.ath.token }));

test('recipient counteroffer: new version, stays proposed, the recipient cannot accept their own terms, only the sponsor signs off', async () => {
  const w = await world(), deal = must(await propose(w, { lines: [money] }), 201);
  const c = must(await counter(w, deal.id, 1, [{ ...money, amount_cents: 40000 }], { reason: 'Budget is tighter' }));
  assert.equal(c.terms_version, 2); assert.equal(c.status, 'proposed'); assert.equal(c.terms_side, 'recipient');
  assert.equal((await dues(w, deal.id)).obligations.length, 0, 'a counteroffer creates no dues');
  assert.equal((await accept(w, deal.id, 2)).status, 403, 'the author cannot accept their own counteroffer');
  assert.equal((await api('PATCH', `/sponsorships/${deal.id}`, { token: w.sponsor.token, body: { status: 'active' } })).status, 400, 'sign-off needs the exact version');
  assert.equal((await api('PATCH', `/sponsorships/${deal.id}`, { token: w.sponsor.token, body: { status: 'active', version: 1 } })).status, 409, 'stale version');
  const done = must(await api('PATCH', `/sponsorships/${deal.id}`, { token: w.sponsor.token, body: { status: 'active', version: 2 } }));
  assert.equal(done.status, 'active');
  const d = await athSees(w, deal.id);
  assert.equal(d.accepted_version, 2); assert.equal(d.lines[0].amount_cents, 40000);
  assert.ok(d.negotiation.versions.find((v) => v.version === 2 && v.signed_off_at));
  assert.ok(d.history.some((h) => h.action === 'counter_offered' && h.reason === 'Budget is tighter'));
  assert.ok(d.history.some((h) => h.action === 'signed_off'));
  assert.equal(d.sponsor_identity.display_name, d.sponsor.name, 'brand identity frozen at sign-off');
  assert.equal((await dues(w, deal.id)).obligations.length, 6);
});

test('stale versions: counter on an old base, accept an old version, and a sponsor revision that overtakes a counter are all rejected', async () => {
  const w = await world(), deal = must(await propose(w, { lines: [money] }), 201);
  assert.equal((await counter(w, deal.id, 1, [money].map((l) => ({ ...l, instalments: 3 })))).status, 200);
  assert.equal((await counter(w, deal.id, 1, [money])).status, 409, 'based on a stale version');
  assert.equal((await api('POST', `/sponsorships/${deal.id}/revise`, { token: w.ath.token, body: { lines: [money] } })).status, 400, 'recipient must say which version');
  must(await api('POST', `/sponsorships/${deal.id}/revise`, { token: w.sponsor.token, body: { lines: [{ ...money, amount_cents: 45000 }] } })); // v3 by the sponsor
  assert.equal((await api('PATCH', `/sponsorships/${deal.id}`, { token: w.sponsor.token, body: { status: 'active', version: 3 } })).status, 403, 'sponsor cannot sign its own v3');
  assert.equal((await accept(w, deal.id, 2)).status, 409, 'old version');
  assert.equal((await accept(w, deal.id, 3)).status, 200);
});

test('withdrawing a change re-issues the other side\'s earlier terms as a new version (nothing deleted)', async () => {
  const w = await world(), deal = must(await propose(w, { lines: [money] }), 201);
  must(await counter(w, deal.id, 1, [{ ...money, amount_cents: 30000 }]));
  const wd = (token, v) => api('POST', `/sponsorships/${deal.id}/withdraw-counter`, { token, body: { expected_version: v } });
  assert.equal((await wd(w.sponsor.token, 2)).status, 409, 'sponsor did not write v2');
  assert.equal((await wd(w.ath.token, 1)).status, 409, 'stale');
  const r = must(await wd(w.ath.token, 2));
  assert.equal(r.terms_version, 3); assert.equal(r.terms_side, 'sponsor');
  const d = await athSees(w, deal.id);
  assert.equal(d.lines[0].amount_cents, 50000);
  assert.equal(d.negotiation.versions.length, 3); assert.equal(d.negotiation.versions[2].restores, 1);
  assert.equal((await accept(w, deal.id, 3)).status, 200);
});

test('a sponsor with no earlier counter has nothing to go back to; only an unanswered offer can be negotiated', async () => {
  const w = await world(), deal = must(await propose(w, { lines: [money] }), 201);
  assert.equal((await api('POST', `/sponsorships/${deal.id}/withdraw-counter`, { token: w.sponsor.token, body: { expected_version: 1 } })).status, 409);
  must(await accept(w, deal.id, 1));
  assert.equal((await counter(w, deal.id, 1, [money])).status, 409);
  assert.equal((await api('POST', `/sponsorships/${deal.id}/comments`, { token: w.ath.token, body: { body: 'late' } })).status, 409);
});

test('version comparison shows added, removed and changed lines and the period, never combining currencies', async () => {
  const w = await world(), deal = must(await propose(w, { lines: [money, goods] }), 201);
  must(await counter(w, deal.id, 1, [{ ...money, amount_cents: 40000, currency: 'USD' }, post], { ends_on: '2030-09-30' }));
  const cmp = must(await api('GET', `/sponsorships/${deal.id}/compare`, { token: w.sponsor.token, query: { from: 1, to: 2 } }));
  assert.deepEqual(cmp.changes.map((c) => `${c.type}:${c.label}`).sort(), ['added:Instagram posts', 'changed:Monthly support', 'removed:Rackets']);
  const ch = cmp.changes.find((c) => c.type === 'changed');
  assert.deepEqual(ch.fields.map((f) => f.field).sort(), ['amount_cents', 'currency']);
  assert.ok(cmp.period.some((p) => p.field === 'ends_on' && p.to === '2030-09-30'));
  assert.equal((await api('GET', `/sponsorships/${deal.id}/compare`, { token: w.sponsor.token, query: { from: 1, to: 1 } })).status, 400);
  assert.equal((await api('GET', `/sponsorships/${deal.id}/compare`, { token: (await signup()).token })).status, 403);
});

test('comments: shared ones reach both sides, internal notes stay on the side that wrote them (outsiders never see them)', async () => {
  const w = await world(), deal = must(await propose(w, { lines: [money] }), 201);
  const say = (u, body) => api('POST', `/sponsorships/${deal.id}/comments`, { token: u.token, body });
  must(await say(w.ath, { body: 'Can the first payment move earlier?', line_position: 1 }), 201);
  must(await say(w.ath, { body: 'My walk-away is 40k', visibility: 'internal' }), 201);
  must(await say(w.sponsor, { body: 'Our ceiling is 55k', visibility: 'internal' }), 201);
  must(await say(w.sponsor, { body: 'We can look at it' }), 201);
  assert.equal((await say(w.ath, { body: 'x', line_position: 9 })).status, 400);
  assert.equal((await say(w.ath, { body: 'x', version: 7 })).status, 400);
  const texts = (d) => d.negotiation.comments.map((c) => c.body).sort();
  assert.deepEqual(texts(await athSees(w, deal.id)), ['Can the first payment move earlier?', 'My walk-away is 40k', 'We can look at it']);
  assert.deepEqual(texts(await sponsorSees(w, deal.id)), ['Can the first payment move earlier?', 'Our ceiling is 55k', 'We can look at it']);
  const outsider = await signup();
  assert.equal((await api('GET', `/sponsorships/${deal.id}`, { token: outsider.token })).status, 403);
  assert.equal((await say(outsider, { body: 'hi' })).status, 403);
  const hist = JSON.stringify((await athSees(w, deal.id)).history);
  assert.ok(!hist.includes('walk-away') && !hist.includes('ceiling'), 'notes never reach the history');
});

test('corporate roles: only revise-capable roles speak for the brand, only manager/approver sign off a counteroffer, tenant isolation holds', async () => {
  const owner = await signup(['sponsor']), ath = await signup(['athlete']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Neg ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `NegBrand ${n}` } }), 201);
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: owner.token, body: { sponsor_type: 'organization', organisation_id: org.id } }));
  const staff = {};
  for (const role of ['manager', 'evaluator', 'finance', 'legal', 'approver']) {
    const u = await signup(['athlete']);
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
    staff[role] = u;
  }
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: owner.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', ...period, lines: [money] } }), 201);
  must(await api('POST', `/sponsorships/${deal.id}/revise`, { token: ath.token, body: { lines: [{ ...money, amount_cents: 42000 }], expected_version: 1 } }));
  const note = (u, body) => api('POST', `/sponsorships/${deal.id}/comments`, { token: u.token, body });
  assert.equal((await note(staff.evaluator, { body: 'speak' })).status, 403, 'evaluator cannot speak for the brand');
  must(await note(staff.evaluator, { body: 'internal view', visibility: 'internal' }), 201);
  must(await note(staff.legal, { body: 'clause ok' }), 201);
  const sign = (u) => api('PATCH', `/sponsorships/${deal.id}`, { token: u.token, body: { status: 'active', version: 2 } });
  for (const r of ['evaluator', 'finance', 'legal']) assert.equal((await sign(staff[r])).status, 403, `${r} cannot sign off`);
  assert.equal((await sign(await signup(['sponsor']))).status, 403, 'another brand cannot');
  const seen = (await api('GET', `/sponsorships/${deal.id}`, { token: staff.finance.token })).body.negotiation.comments.map((c) => c.body);
  assert.ok(seen.includes('internal view'), 'internal notes are shared inside the brand team');
  assert.ok(!(await athSees({ ath }, deal.id)).negotiation.comments.some((c) => c.visibility === 'internal'));
  assert.equal((await sign(staff.approver)).status, 200);
});

test('decline cooldown is unchanged and counteroffers do not trigger it; concurrent sign-offs activate once', async () => {
  const w = await world(), deal = must(await propose(w, { lines: [money] }), 201);
  must(await counter(w, deal.id, 1, [{ ...money, amount_cents: 41000 }]));
  const again = await propose(w, { lines: [money] });
  assert.equal(again.status, 409, 'still an open offer');
  const [a, b2] = await Promise.all([1, 2].map(() => api('PATCH', `/sponsorships/${deal.id}`, { token: w.sponsor.token, body: { status: 'active', version: 2 } })));
  assert.deepEqual([a.status, b2.status].sort(), [200, 409]);
  assert.equal((await dues(w, deal.id)).obligations.length, 6, 'dues generated exactly once');
  const w2 = await world(), d2 = must(await propose(w2, { lines: [money] }), 201);
  must(await api('PATCH', `/sponsorships/${d2.id}`, { token: w2.ath.token, body: { status: 'declined' } }));
  assert.equal((await propose(w2, { lines: [money] })).status, 409, 'cooldown after decline');
});

test('migration backfill: an existing multi-version deal gets every version recorded as the sponsor\'s, with no invented dates', async () => {
  const w = await world(), deal = must(await propose(w, { lines: [money] }), 201);
  await pool.query('UPDATE sponsorships SET terms_version=3 WHERE id=$1', [deal.id]);
  await pool.query('DELETE FROM sponsorship_versions WHERE sponsorship_id=$1', [deal.id]);
  const sql = (await import('node:fs')).readFileSync(new URL('../migrations/094_sponsorship_negotiation.sql', import.meta.url), 'utf8').match(/INSERT INTO sponsorship_versions[\s\S]*?generate_series\(1, s.terms_version\) AS v\(n\);/)[0];
  await pool.query(sql.replace('FROM sponsorships s', `FROM (SELECT * FROM sponsorships WHERE id='${deal.id}') s`));
  const rows = (await pool.query('SELECT version, authored_side, starts_on IS NULL AS no_dates FROM sponsorship_versions WHERE sponsorship_id=$1 ORDER BY version', [deal.id])).rows;
  assert.deepEqual(rows, [{ version: 1, authored_side: 'sponsor', no_dates: true }, { version: 2, authored_side: 'sponsor', no_dates: true }, { version: 3, authored_side: 'sponsor', no_dates: false }]);
});
