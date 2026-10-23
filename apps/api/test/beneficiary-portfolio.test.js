// Beneficiary portfolio (#292): totals reconcile with the source agreements, requested vs awarded funding, other sponsors' terms stay hidden,
// deterministic paging, scoped access across list/detail/export, youth limits and the additive migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `bp_${n}_${roles[0]}`, display_name: `Portfolio ${n}`, email: `bp${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const money = (rows, cur) => rows.find((m) => m.currency === cur);

const brandOf = async (name) => { const owner = await signup(['sponsor']); const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `${name} ${n}` } }), 201); return { owner, b }; };
const athlete = async (name) => { const a = await signup(['athlete']); must(await api('POST', '/me/sponsorship-profile', { token: a.token, body: { open_to_sponsors: true } })); await pool.query('UPDATE users SET display_name=$2 WHERE id=$1', [a.id, name]); return a; };
const offer = async (w, ath, { cents = 10000, currency = 'SGD', first = day(30), endsOn = day(200), instalments = 1 } = {}) => {
  const d = must(await api('POST', '/sponsorships', { token: w.owner.token, body: { sponsor_id: w.b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: day(1), ends_on: endsOn,
    lines: [{ kind: 'money', label: 'Support', currency, amount_cents: cents, cadence: instalments > 1 ? 'monthly' : 'once', instalments, first_due_on: first }] } }), 201);
  must(await api('PATCH', `/sponsorships/${d.id}`, { token: ath.token, body: { status: 'active', version: 1 } }));
  return d;
};
const dues = async (w, id) => (await api('GET', '/sponsorship-obligations', { token: w.owner.token, query: { sponsorship_id: id } })).body;
const list = (u, query = {}) => api('GET', '/beneficiary-portfolio', { token: u.token, query });
const entry = (u, type, id, query = {}) => api('GET', `/beneficiary-portfolio/${type}/${id}`, { token: u.token, query });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('totals reconcile with the source agreements; a reported payment is never counted as received', async () => {
  const w = await brandOf('Reconcile'), ath = await athlete('Zara Reconcile');
  const d = await offer(w, ath, { cents: 10000, instalments: 3 });
  const o = (await dues(w, d.id)).obligations;
  assert.equal(o.length, 3);
  const pay = (i, cents, ref) => api('POST', `/sponsorship-obligations/${o[i].id}/payments`, { token: w.owner.token, body: { amount_cents: cents, currency: 'SGD', method: 'bank_transfer', reference: ref, paid_on: day(0) } });
  const p1 = must(await pay(0, 10000, 'REF-1'), 201);
  must(await pay(1, 4000, 'REF-2'), 201);
  must(await api('PATCH', `/sponsorship-payments/${p1.id}`, { token: ath.token, body: { status: 'confirmed' } }));

  const p = must(await list(w.owner));
  assert.equal(p.view, 'sponsor');
  const item = p.items.find((x) => x.target_id === ath.id);
  const m = money(item.money, 'SGD');
  assert.deepEqual([m.committed_cents, m.confirmed_cents, m.reported_unconfirmed_cents, m.outstanding_cents], [30000, 10000, 4000, 20000], 'reported money is shown apart from confirmed money');
  const source = (await dues(w, d.id)).totals.find((t) => t.currency === 'SGD');
  assert.deepEqual([m.committed_cents, m.confirmed_cents, m.reported_unconfirmed_cents, m.outstanding_cents], [Number(source.committed_cents), Number(source.confirmed_cents), Number(source.reported_unverified_cents), Number(source.outstanding_cents)], 'identical to the obligations list');
  assert.deepEqual(money(p.totals, 'SGD'), m, 'the page totals are the same numbers');
  const detail = must(await entry(w.owner, 'athlete', ath.id));
  assert.deepEqual(money(detail.totals, 'SGD'), m);
  assert.deepEqual(detail.agreements[0].money[0].committed_cents, 30000);
  assert.equal(detail.agreements[0].money[0].committed_cents, detail.agreements.reduce((s, a) => s + a.money.reduce((t, x) => t + x.committed_cents, 0), 0));
});

test('funding needs separate requested from awarded and offered; currencies stay apart', async () => {
  const w = await brandOf('Funding');
  const day0 = day(-1);
  let prog = must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: 'Fund', currency: 'USD', budget_cents: 100000, max_award_cents: 60000 } }), 201);
  const r = must(await api('POST', `/sponsorship-programs/${prog.id}/rounds`, { token: w.owner.token, body: { opens_on: day0, closes_on: day(30) } }), 201);
  prog = must(await api('POST', `/sponsorship-programs/${prog.id}/status`, { token: w.owner.token, body: { status: 'published', version: prog.row_version } }));
  const a = await athlete('Ana Funding'), b = await athlete('Ben Funding');
  const apply = async (u, cents) => must(await api('POST', `/program-rounds/${r.id}/applications`, { token: u.token, body: { target_type: 'athlete', target_id: u.id, requested_cents: cents, pitch: 'Please' } }), 201);
  const appA = await apply(a, 30000), appB = await apply(b, 15000);

  let item = (await list(w.owner, { q: 'Ana' })).body.items[0];
  let m = money(item.money, 'USD');
  assert.deepEqual([m.requested_cents, m.awarded_cents, m.offered_cents, m.gap_cents], [30000, 0, 0, 30000], 'asked for, nothing awarded yet');
  assert.equal(item.stage, 'pending');

  const v = (await api('GET', `/sponsorship-programs/${prog.id}`, { token: w.owner.token })).body.row_version;
  const won = must(await api('PATCH', `/program-applications/${appA.id}`, { token: w.owner.token, body: { decision: 'award', program_version: v, awarded_cents: 20000 } }));
  item = (await list(w.owner, { q: 'Ana' })).body.items[0];
  m = money(item.money, 'USD');
  assert.deepEqual([m.requested_cents, m.awarded_cents, m.offered_cents, m.gap_cents], [30000, 0, 20000, 10000], 'an issued offer is offered, not awarded');
  must(await api('POST', `/program-awards/${won.award.id}/respond`, { token: a.token, body: { decision: 'accept', offer_version: won.award.offer_version } }));
  item = (await list(w.owner, { q: 'Ana' })).body.items[0];
  m = money(item.money, 'USD');
  assert.deepEqual([m.requested_cents, m.awarded_cents, m.offered_cents, m.gap_cents], [30000, 20000, 0, 10000], 'accepted: awarded 20000 of the 30000 requested');
  assert.equal(item.stage, 'active');
  assert.ok(item.risks.includes('funding_gap'));

  const gaps = must(await list(w.owner, { has_gap: 'true' }));
  assert.deepEqual(gaps.items.map((x) => x.name).sort(), ['Ana Funding', 'Ben Funding']);
  assert.equal(money(gaps.totals, 'USD').requested_cents, 45000);
  assert.equal(money(gaps.totals, 'USD').gap_cents, 25000);
  assert.equal(must(await list(w.owner, { has_gap: 'false' })).total, 2, 'a string "false" is not truthy');

  // a second currency is its own line, never summed with the first
  const sgd = await offer(w, b, { cents: 5000, currency: 'SGD' });
  const both = (await list(w.owner, { q: 'Ben' })).body.items[0];
  assert.deepEqual(both.money.map((x) => x.currency).sort(), ['SGD', 'USD']);
  assert.equal(money(both.money, 'SGD').committed_cents, 5000);
  assert.equal(money(both.money, 'USD').committed_cents, 0);
  assert.equal(must(await list(w.owner, { currency: 'SGD' })).total, 1);
  assert.ok(sgd.id);

  const d = must(await entry(w.owner, 'athlete', a.id));
  assert.equal(d.applications.length, 1);
  assert.deepEqual([d.applications[0].requested_cents, d.applications[0].awarded_cents], [30000, 20000]);
  assert.ok(d.documents.some((x) => x.kind === 'award_letter'), 'the award letter is listed');
  assert.ok(d.history.some((h) => h.kind === 'award_accepted') && d.history.some((h) => h.kind === 'application_submitted'));
  assert.ok(d.next_actions.some((x) => x.code === 'review_funding_gap' && x.label.includes('$100.00')), 'amounts in labels are formatted, not raw minor units');
});

test("one sponsor never sees another sponsor's terms, and the recipient sees only their own agreements", async () => {
  const a = await brandOf('Alpha'), b = await brandOf('Beta'), ath = await athlete('Shared Athlete');
  const dA = await offer(a, ath, { cents: 11100 }), dB = await offer(b, ath, { cents: 22200 });
  await pool.query("UPDATE sponsorships SET visibility='public' WHERE id=$1", [dB.id]);

  const seenByA = must(await entry(a.owner, 'athlete', ath.id));
  assert.deepEqual(seenByA.agreements.map((x) => x.id), [dA.id], "only Alpha's own agreement is returned");
  assert.equal(money(seenByA.totals, 'SGD').committed_cents, 11100, "Beta's money is not in Alpha's totals");
  assert.equal(seenByA.other_public_sponsors, 1, 'only that another sponsor exists is visible, and only because its deal is public');
  assert.ok(!JSON.stringify(seenByA).includes('22200') && !JSON.stringify(seenByA).includes(dB.id) && !JSON.stringify(seenByA).includes(b.b.name), "no amount, id or name of Beta");
  assert.ok(!JSON.stringify(must(await list(a.owner))).includes('22200'));

  await pool.query("UPDATE sponsorships SET visibility='private' WHERE id=$1", [dB.id]);
  assert.equal(must(await entry(a.owner, 'athlete', ath.id)).other_public_sponsors, 0, 'a private deal is not even counted');

  const own = must(await list(ath));
  assert.equal(own.view, 'recipient');
  const mine = own.items.find((x) => x.target_id === ath.id);
  assert.equal(money(mine.money, 'SGD').committed_cents, 33300, 'the athlete is a party to both agreements');
  const outsider = await athlete('Outsider');
  assert.equal(must(await list(outsider)).items.length, 0);
  assert.equal((await entry(outsider, 'athlete', ath.id)).status, 403, 'no relationship: denied');
  assert.equal((await entry(b.owner, 'athlete', outsider.id)).status, 403, "a beneficiary no deal links to cannot be probed");
  assert.equal((await list(outsider, { view: 'sponsor' })).status, 403, 'a non-sponsor cannot open the sponsor view');
  assert.equal((await api('GET', '/beneficiary-portfolio')).status, 401);
});

test('filters page deterministically with a total order and an honest total', async () => {
  const w = await brandOf('Paging');
  const names = ['Mia Page', 'Mia Page', 'Liam Page', 'Noah Page', 'Eve Page'];
  for (const name of names) await offer(w, await athlete(name));
  const all = must(await list(w.owner, { limit: 100 }));
  assert.equal(all.total, 5);
  const seen = [];
  for (let off = 0; off < 5; off += 2) {
    const pg = must(await list(w.owner, { limit: 2, offset: off }));
    assert.equal(pg.total, 5);
    seen.push(...pg.items.map((x) => x.target_id));
  }
  assert.deepEqual(seen, all.items.map((x) => x.target_id), 'pages concatenate to the full list with no gap or repeat, even with equal names');
  assert.deepEqual(all.items.map((x) => x.name.split(' ')[0]), ['Eve', 'Liam', 'Mia', 'Mia', 'Noah']);
  assert.equal(must(await list(w.owner, { q: 'mia' })).total, 2);
  assert.equal(must(await list(w.owner, { q: '%' })).total, 0, 'wildcards are literal');
  assert.equal(must(await list(w.owner, { stage: 'closed' })).total, 0);
  assert.equal((await list(w.owner, { limit: 101 })).status, 400);
  assert.equal((await list(w.owner, { risk: 'nonsense' })).status, 400);
  const beyond = must(await list(w.owner, { limit: 2, offset: 50 }));
  assert.deepEqual([beyond.items.length, beyond.total], [0, 5]);
});

test('risk flags, milestones and next actions come from real state and respect the role', async () => {
  const w = await brandOf('Risk'), ath = await athlete('Risky Rider');
  const d = await offer(w, ath, { cents: 10000, instalments: 2 });
  const o = (await dues(w, d.id)).obligations;
  await pool.query('UPDATE sponsorship_obligations SET due_on=$2 WHERE id=$1', [o[0].id, day(-10)]);
  const p = must(await api('POST', `/sponsorship-obligations/${o[1].id}/payments`, { token: w.owner.token, body: { amount_cents: 1000, currency: 'SGD', method: 'cash', reference: 'OLD-REF', paid_on: day(-9) } }), 201);
  await pool.query("UPDATE sponsorship_payments SET created_at = now() - interval '9 days' WHERE id=$1", [p.id]);
  must(await api('POST', `/sponsorships/${d.id}/reviews`, { token: w.owner.token, body: { body: 'Check in later', next_review_on: day(-2) } }), 201);
  await pool.query("UPDATE sponsorships SET ends_on=$2 WHERE id=$1", [d.id, day(10)]);

  const e = must(await entry(w.owner, 'athlete', ath.id));
  assert.deepEqual(e.risks.map((x) => x.code).sort(), ['agreement_ending', 'overdue_payment', 'review_overdue', 'unconfirmed_payment']);
  assert.ok(e.milestones.some((x) => x.type === 'due' && x.overdue));
  assert.ok(e.milestones.some((x) => x.type === 'agreement_end'));
  const codes = e.next_actions.map((x) => x.code);
  assert.ok(['report_payment', 'chase_confirmation', 'write_review', 'renew_or_end'].every((c) => codes.includes(c)), codes.join());
  assert.equal(must(await list(w.owner, { risk: 'overdue_payment' })).total, 1);
  assert.equal(must(await list(w.owner, { risk: 'funding_gap' })).total, 0);
  assert.equal(must(await list(w.owner, { sort: 'risk' })).items[0].risks.length, 4);
  assert.equal(e.reviews.length, 1);

  // the same beneficiary from the athlete's side: confirm the payment, not chase it; and the sponsor's private notes stay private
  must(await api('POST', `/sponsorships/${d.id}/reviews`, { token: w.owner.token, body: { body: 'Private sponsor note', visibility: 'author_only' } }), 201);
  const mine = must(await entry(ath, 'athlete', ath.id));
  assert.equal(mine.view, 'recipient');
  const mc = mine.next_actions.map((x) => x.code);
  assert.ok(mc.includes('confirm_payment') && mc.includes('respond_review') && !mc.includes('report_payment'), mc.join());
  assert.ok(!JSON.stringify(mine).includes('Private sponsor note'));
  assert.ok(must(await entry(w.owner, 'athlete', ath.id)).reviews.some((r) => r.body === 'Private sponsor note'), 'the author still sees their own note');

  // an evaluator of the brand's organisation reads, but cannot report payments or export
  const org = must(await api('POST', '/organisations', { token: w.owner.token, body: { name: `RiskOrg ${n}`, kind: 'company' } }), 201);
  must(await api('POST', `/organisations/${org.id}/assets`, { token: w.owner.token, body: { kind: 'sponsor', asset_id: w.b.id } }));
  const ev = await signup(['athlete']);
  must(await api('POST', `/organisations/${org.id}/members`, { token: w.owner.token, body: { person: ev.handle, role: 'evaluator' } }), 201);
  must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: ev.token, body: { accept: true } }));
  const asEv = must(await entry(ev, 'athlete', ath.id));
  assert.ok(!asEv.next_actions.some((x) => x.code === 'report_payment'), 'an evaluator is not offered payment actions');
  assert.ok(asEv.next_actions.some((x) => x.code === 'write_review'));
  assert.equal((await api('GET', '/beneficiary-portfolio-export', { token: ev.token })).status, 403);
});

test('the export follows the filters, is audit-logged, needs the export role and neutralises spreadsheet formulas', async () => {
  const w = await brandOf('Export'), ath = await athlete('=HYPERLINK("x")');
  await offer(w, ath, { cents: 12300 });
  const out = must(await api('GET', '/beneficiary-portfolio-export', { token: w.owner.token }));
  assert.equal(out.rows, 1);
  const lines = out.csv.trim().split('\n');
  assert.match(lines[0], /^beneficiary,target_type,stage,/);
  assert.ok(lines[1].startsWith("\"'=HYPERLINK") || lines[1].startsWith("'=HYPERLINK"), lines[1]);
  assert.ok(lines[1].includes('12300'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='export' AND entity='beneficiary_portfolio'", [w.owner.id])).rows[0].n, 1);
  assert.equal((await api('GET', '/beneficiary-portfolio-export', { token: ath.token })).status, 200, 'the recipient exports their own');
  const stranger = await signup(['sponsor']);
  assert.equal((await api('GET', '/beneficiary-portfolio-export', { token: stranger.token, query: { view: 'sponsor' } })).status, 403);
});

test('a youth athlete is masked for the sponsor and their notes are not read from here', async () => {
  const w = await brandOf('Youth'), ath = await athlete('Young Talent');
  const d = await offer(w, ath, { cents: 5000 });
  must(await api('POST', `/sponsorships/${d.id}/reviews`, { token: w.owner.token, body: { body: 'Progress note' } }), 201);
  await pool.query("UPDATE users SET youth_until = current_date + 400 WHERE id=$1", [ath.id]);
  const e = must(await entry(w.owner, 'athlete', ath.id));
  assert.equal(e.beneficiary.name, 'Youth athlete');
  assert.ok(e.beneficiary.youth_limited && e.risks.some((r) => r.code === 'youth_beneficiary'));
  assert.deepEqual(e.reviews, []);
  assert.equal(must(await list(w.owner, { q: 'Young' })).total, 0, 'the real name cannot be searched');
  assert.equal(must(await list(w.owner, { q: 'Youth' })).total, 1);
  assert.ok(!JSON.stringify(must(await api('GET', '/beneficiary-portfolio-export', { token: w.owner.token }))).includes('Young Talent'));
  assert.equal(must(await entry(ath, 'athlete', ath.id)).beneficiary.name, 'Young Talent', 'the athlete sees their own name');
});

test('the snapshot changes when the data does, so a stale screen can tell', async () => {
  const w = await brandOf('Snap'), ath = await athlete('Snap Athlete');
  const d = await offer(w, ath, { cents: 9000 });
  const before1 = must(await entry(w.owner, 'athlete', ath.id)).snapshot;
  assert.equal(must(await entry(w.owner, 'athlete', ath.id)).snapshot, before1, 'stable while nothing changes');
  const o = (await dues(w, d.id)).obligations[0];
  must(await api('POST', `/sponsorship-obligations/${o.id}/payments`, { token: w.owner.token, body: { amount_cents: 1000, currency: 'SGD', method: 'cash', reference: 'SNAP-1', paid_on: day(0) } }), 201);
  assert.notEqual(must(await entry(w.owner, 'athlete', ath.id)).snapshot, before1);
});

test('the migration is additive and the read model writes nothing', async () => {
  const sql = readFileSync(new URL('../migrations/094_beneficiary_portfolio.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  assert.ok(!/\b(DROP|TRUNCATE|DELETE|ALTER\s+TABLE|UPDATE)\b/i.test(sql), 'indexes only');
  assert.ok(/CREATE INDEX IF NOT EXISTS/.test(sql));
  const counts = async () => (await pool.query("SELECT (SELECT count(*) FROM sponsorships) a, (SELECT count(*) FROM sponsorship_payments) b, (SELECT count(*) FROM sponsorship_obligations) c")).rows[0];
  const w = await brandOf('ReadOnly'), ath = await athlete('Read Only');
  await offer(w, ath);
  const before2 = await counts();
  must(await list(w.owner)); must(await entry(w.owner, 'athlete', ath.id)); must(await api('GET', '/beneficiary-portfolio-export', { token: w.owner.token }));
  assert.deepEqual(await counts(), before2);
});
