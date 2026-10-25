// Mutually accepted amendments of an accepted sponsorship agreement (#296).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { generateObligations } = await import('../src/sponsor-agreements.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `am_${n}_${roles[0]}`, display_name: `Amend ${n}`, email: `am${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };

const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 6 };
const period = { starts_on: '2030-01-01', ends_on: '2030-06-30' };
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Brand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', ...period, lines: [money] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: 1 } }));
  return { sponsor, ath, b, id: deal.id };
};
const get = async (w, token = w.ath.token) => must(await api('GET', `/sponsorships/${w.id}`, { token }));
const dues = async (w) => (await get(w)).obligations;
const live = async (w) => (await dues(w)).filter((o) => o.status !== 'cancelled');
const propose = (w, body, token = w.sponsor.token) => api('POST', `/sponsorships/${w.id}/amendments`, { token, body: { expected_version: 1, effective_from: '2030-03-01', lines: [{ ...money, amount_cents: 60000 }], reason: 'Bigger season', ...body } });
const decide = (a, token, decision, extra = {}) => api('POST', `/sponsorship-amendments/${a.id}/decision`, { token, body: { decision, rev: a.rev, version: 1, ...extra } });
const pay = async (w, o, ref) => {
  const p = must(await api('POST', `/sponsorship-obligations/${o.id}/payments`, { token: w.sponsor.token, body: { amount_cents: 50000, currency: 'SGD', method: 'bank_transfer', reference: ref, paid_on: '2030-01-16' } }), 201);
  return p;
};



before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('an unaccepted amendment changes nothing; its impact preview shows what would move', async () => {
  const w = await world();
  const before = await dues(w);
  assert.equal(before.length, 6);
  const prev = must(await api('POST', `/sponsorships/${w.id}/amendments/preview`, { token: w.sponsor.token, body: { effective_from: '2030-03-01', lines: [{ ...money, amount_cents: 60000 }] } }));
  assert.equal(prev.retained_count, 2); assert.equal(prev.replaced.length, 4); assert.equal(prev.added.length, 4); assert.equal(prev.blocked, null);
  assert.deepEqual(prev.totals, [{ currency: 'SGD', before_cents: 300000, after_cents: 340000, delta_cents: 40000 }]);
  const a = must(await propose(w, {}), 201);
  assert.equal(a.status, 'proposed'); assert.equal(a.seq, 1); assert.equal(a.rev, 1); assert.equal(a.can_answer, false); assert.equal(a.can_edit, true);
  assert.deepEqual(await dues(w), before, 'a proposal leaves every due untouched');
  const d = await get(w);
  assert.equal(d.terms_version, 1); assert.equal(d.accepted_version, 1); assert.equal(d.lines[0].amount_cents, 50000);
  assert.equal(d.amendments.open.id, a.id); assert.equal(d.amendments.can_propose, false);
  assert.equal((await api('POST', `/sponsorships/${w.id}/amendments`, { token: w.sponsor.token, body: { expected_version: 1, effective_from: '2030-04-01', lines: [{ ...money, amount_cents: 70000 }] } })).status, 409, 'one open proposal at a time');
  // rejecting or withdrawing keeps everything as it was
  assert.equal((await decide(a, w.sponsor.token, 'accept')).status, 403, 'you cannot accept your own proposal');
  assert.equal((await decide(a, w.ath.token, 'reject')).status, 400, 'a rejection needs a reason');
  const rej = must(await decide(a, w.ath.token, 'reject', { note: 'Too much' }));
  assert.equal(rej.status, 'rejected');
  assert.deepEqual(await dues(w), before);
  assert.equal((await decide(a, w.ath.token, 'accept')).status, 409, 'a rejected amendment cannot be accepted');
  const b = must(await propose(w, { effective_from: '2030-04-01' }), 201);
  assert.equal(b.seq, 2);
  must(await decide(b, w.sponsor.token, 'withdraw'));
  assert.deepEqual(await dues(w), before);
  assert.ok((await get(w)).history.some((h) => h.action === 'amendment_withdrawn'));
});

test('acceptance changes only the untouched future dues, once; settled and in-progress dues keep their history', async () => {
  const w = await world();
  const [d1, d2] = await dues(w);
  const p1 = await pay(w, d1, 'REF-1');
  must(await api('PATCH', `/sponsorship-payments/${p1.id}`, { token: w.ath.token, body: { status: 'confirmed' } }));
  await pay(w, d2, 'REF-2'); // reported, not confirmed: still activity
  assert.equal((await dues(w)).find((o) => o.id === d1.id).status, 'fulfilled');
  const a = must(await propose(w, {}), 201);
  const done = must(await decide(a, w.ath.token, 'accept'));
  assert.equal(done.status, 'accepted'); assert.equal(done.resulting_version, 2); assert.deepEqual(done.applied, { version: 2, dues_replaced: 4, dues_created: 4 });
  const all = await dues(w), now = await live(w);
  assert.equal(all.length, 10, 'old dues are kept, never deleted');
  assert.equal(now.length, 6);
  assert.deepEqual(now.map((o) => [o.due_on, o.amount_cents, o.version]), [['2030-01-15', 50000, 1], ['2030-02-15', 50000, 1], ['2030-03-15', 60000, 2], ['2030-04-15', 60000, 2], ['2030-05-15', 60000, 2], ['2030-06-15', 60000, 2]]);
  assert.equal(now[0].status, 'fulfilled'); assert.equal(now[0].confirmed_cents, 50000);
  assert.equal(now[1].reported_unverified_cents, 50000, 'the reported payment stays on its own due');
  assert.equal(all.filter((o) => o.status === 'cancelled').length, 4); assert.ok(all.filter((o) => o.status === 'cancelled').every((o) => o.version === 1 && o.cancelled_by_amendment === a.id));
  const d = await get(w);
  assert.equal(d.terms_version, 2); assert.equal(d.accepted_version, 2); assert.equal(d.lines[0].amount_cents, 60000);
  assert.equal(d.negotiation.versions.find((v) => v.version === 2).signed_off_at !== null, true);
  assert.ok(d.history.some((h) => h.action === 'amendment_accepted'));
  const sum = must(await api('GET', '/sponsorship-obligations', { token: w.ath.token, query: { sponsorship_id: w.id } }));
  assert.deepEqual(sum.totals.map((t) => [t.currency, Number(t.committed_cents)]), [['SGD', 340000]], 'cancelled dues leave the committed total; retained ones stay');
  // once only: a second acceptance, a re-run of the schedule builder and the admin rebuild all add nothing
  assert.equal((await decide(a, w.ath.token, 'accept')).status, 409);
  assert.equal(await generateObligations(pool, w.id), 0);
  assert.equal((await dues(w)).length, 10);
  assert.equal((await api('GET', `/sponsorship-reconciliation`, { token: w.ath.token, query: { sponsorship_id: w.id } })).body[0].committed_cents, 340000);
});

test('stale acceptance fails: an edited proposal, a double accept and concurrent accepts apply once', async () => {
  const w = await world();
  const a = must(await propose(w, {}), 201);
  const r2 = must(await api('POST', `/sponsorship-amendments/${a.id}/revise`, { token: w.sponsor.token, body: { rev: 1, expected_version: 1, effective_from: '2030-03-01', lines: [{ ...money, amount_cents: 65000 }] } }));
  assert.equal(r2.rev, 2);
  assert.equal((await api('POST', `/sponsorship-amendments/${a.id}/revise`, { token: w.sponsor.token, body: { rev: 1, expected_version: 1, effective_from: '2030-03-01', lines: [{ ...money, amount_cents: 1000 }] } })).status, 409, 'editing an old revision');
  assert.equal((await decide(a, w.ath.token, 'accept')).status, 409, 'accepting the revision you saw before the edit');
  assert.equal((await api('POST', `/sponsorship-amendments/${a.id}/decision`, { token: w.ath.token, body: { decision: 'accept', rev: 2, version: 7 } })).status, 409, 'wrong agreement version');
  assert.equal((await api('POST', `/sponsorship-amendments/${a.id}/decision`, { token: w.ath.token, body: { decision: 'accept', rev: 2 } })).status, 400, 'the version is required');
  assert.equal((await dues(w)).length, 6);
  const race = await Promise.all([1, 2, 3].map(() => api('POST', `/sponsorship-amendments/${a.id}/decision`, { token: w.ath.token, body: { decision: 'accept', rev: 2, version: 1 } })));
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409, 409]);
  const now = await live(w);
  assert.equal(now.length, 6); assert.equal(now.filter((o) => o.version === 2).length, 4); assert.ok(now.filter((o) => o.version === 2).every((o) => o.amount_cents === 65000));
  assert.equal((await propose(w, { expected_version: 1 })).status, 409, 'proposals are based on the current accepted version');
});

test('a future due that already has money, goods or evidence cannot be replaced; fulfilled dues are immutable', async () => {
  const w = await world();
  const ds = await dues(w);
  await pay(w, ds[3], 'EARLY'); // April is paid in advance
  const blocked = await propose(w, {});
  assert.equal(blocked.status, 409); assert.match(blocked.body.error?.message ?? blocked.body.message ?? JSON.stringify(blocked.body), /Choose an effective date after 2030-04-15/);
  const ok = must(await propose(w, { effective_from: '2030-05-01' }), 201);
  // a payment lands on May after the proposal: accepting is refused and nothing moves
  await pay(w, ds[4], 'LATE');
  const refused = await decide(ok, w.ath.token, 'accept');
  assert.equal(refused.status, 409);
  assert.equal((await live(w)).length, 6); assert.ok((await live(w)).every((o) => o.version === 1));
  must(await decide(ok, w.sponsor.token, 'withdraw'));
  // database backstop: a fulfilled due can never be edited or cancelled
  const p = await pay(w, ds[0], 'JAN');
  must(await api('PATCH', `/sponsorship-payments/${p.id}`, { token: w.ath.token, body: { status: 'confirmed' } }));
  await assert.rejects(pool.query("UPDATE sponsorship_obligations SET amount_cents=1 WHERE id=$1", [ds[0].id]), /settled history/);
  await assert.rejects(pool.query("UPDATE sponsorship_obligations SET status='cancelled' WHERE id=$1", [ds[0].id]), /settled history/);
  await assert.rejects(pool.query("UPDATE sponsorship_obligations SET due_on='2031-01-01' WHERE id=$1", [ds[0].id]), /settled history/);
  // reversing the payment still reopens the due (existing behaviour)
  const rev = must(await api('PATCH', `/sponsorship-payments/${p.id}`, { token: w.ath.token, body: { status: 'reversed', note: 'Bounced' } }));
  assert.equal(rev.status, 'reversed'); assert.equal((await dues(w)).find((o) => o.id === ds[0].id).status, 'scheduled');
});

test('dates, recurrence, deliverables and rights can be amended; dates before today and no-op proposals are refused', async () => {
  const w = await world();
  const goods = { kind: 'goods', label: 'Rackets', quantity: 4, unit: 'pcs', cadence: 'custom', custom_dates: ['2030-04-01', '2030-06-01'], estimate_cents: 80000, currency: 'SGD' };
  const post = { kind: 'endorsement', label: 'Posts', promoter: 'recipient', cadence: 'custom', custom_dates: ['2030-05-10'], terms: { channels: ['instagram'], exclusivity: 'No rival kit brand' } };
  assert.equal((await propose(w, { effective_from: '2020-01-01' })).status, 400, 'the past is never rewritten');
  assert.equal((await propose(w, { lines: [money], effective_from: '2030-03-01' })).status, 400, 'nothing changes');
  assert.equal((await propose(w, { lines: [{ ...money, cadence: 'quarterly', first_due_on: '2030-01-15', instalments: 2 }, goods, post], ends_on: '2030-07-31', effective_from: '2030-03-01' })).status, 201);
  const open = (await get(w)).amendments.open;
  const full = must(await api('GET', `/sponsorship-amendments/${open.id}`, { token: w.ath.token }));
  assert.equal(full.lines.length, 3); assert.equal(full.impact.blocked, null);
  assert.ok(full.impact.added.some((x) => x.kind === 'goods') && full.impact.added.some((x) => x.kind === 'endorsement'));
  must(await decide(full, w.ath.token, 'accept'));
  const d = await get(w);
  assert.equal(d.ends_on.slice(0, 10), '2030-07-31'); assert.equal(d.lines.length, 3);
  assert.equal(d.lines.find((l) => l.kind === 'endorsement').terms.exclusivity, 'No rival kit brand');
  const now = await live(w);
  assert.deepEqual(now.filter((o) => o.kind === 'money').map((o) => o.due_on), ['2030-01-15', '2030-02-15', '2030-04-15'], 'quarterly from the anchor: Jan (kept), Feb (kept), Apr (new)');
  assert.equal(now.filter((o) => o.kind === 'goods').length, 2); assert.equal(now.filter((o) => o.kind === 'endorsement').length, 1);
  // the amended version only owns dues from its effective date: nothing earlier was invented
  assert.ok(now.filter((o) => o.version === 2).every((o) => o.due_on >= '2030-03-01'));
});

test('authorization and tenant isolation hold for reads, writes and exports', async () => {
  const w = await world();
  const outsider = await signup(['sponsor']), other = await signup(['athlete']);
  const a = must(await propose(w, {}), 201);
  for (const t of [outsider.token, other.token]) {
    assert.equal((await api('GET', `/sponsorships/${w.id}/amendments`, { token: t })).status, 403);
    assert.equal((await api('GET', `/sponsorship-amendments/${a.id}`, { token: t })).status, 403);
    assert.equal((await api('GET', `/sponsorships/${w.id}/amendments/export`, { token: t })).status, 403);
    assert.equal((await api('POST', `/sponsorships/${w.id}/amendments/preview`, { token: t, body: { effective_from: '2030-03-01', lines: [money] } })).status, 403);
    assert.equal((await api('POST', `/sponsorships/${w.id}/amendments`, { token: t, body: { expected_version: 1, effective_from: '2030-03-01', lines: [{ ...money, amount_cents: 1 }] } })).status, 403);
    assert.equal((await api('POST', `/sponsorship-amendments/${a.id}/decision`, { token: t, body: { decision: 'accept', rev: 1, version: 1 } })).status, 403);
    assert.equal((await api('POST', `/sponsorship-amendments/${a.id}/revise`, { token: t, body: { rev: 1, expected_version: 1, effective_from: '2030-03-01', lines: [{ ...money, amount_cents: 1 }] } })).status, 403);
  }
  assert.equal((await api('GET', `/sponsorships/${w.id}/amendments`)).status, 401);
  assert.equal((await api('POST', `/sponsorship-amendments/${a.id}/revise`, { token: w.ath.token, body: { rev: 1, expected_version: 1, effective_from: '2030-03-01', lines: [{ ...money, amount_cents: 1 }] } })).status, 403, 'only the proposer edits');
  assert.equal((await decide(a, w.ath.token, 'withdraw')).status, 403, 'only the proposer withdraws');
  const list = must(await api('GET', `/sponsorships/${w.id}/amendments`, { token: w.ath.token }));
  assert.equal(list.total, 1); assert.equal(list.amendments[0].mine, false);
  const csv = must(await api('GET', `/sponsorships/${w.id}/amendments/export`, { token: w.sponsor.token }));
  assert.match(csv.csv, /^agreement_ref,amendment,status/); assert.equal(csv.rows, 1);
  // a brand member whose role cannot revise cannot propose, and one that cannot sign off cannot accept
  assert.equal((await api('GET', `/sponsorships/${w.id}`, { token: w.sponsor.token })).body.amendments.can_answer, false);
});

test('corporate roles: only revise-capable roles propose, only manager/approver agree for the brand', async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']);
  const org = must(await api('POST', '/organisations', { token: sponsor.token, body: { name: `Acme ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Corp ${n}` } }), 201);
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: sponsor.token, body: { sponsor_type: 'organization', organisation_id: org.id } }));
  const staff = {};
  for (const role of ['approver', 'finance', 'auditor', 'legal']) {
    const u = await signup(['athlete']);
    must(await api('POST', `/organisations/${org.id}/members`, { token: sponsor.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
    staff[role] = u;
  }
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Kit', ...period, lines: [money] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: 1 } }));
  const w = { id: deal.id, sponsor, ath };
  assert.equal((await propose(w, {}, staff.finance.token)).status, 403, 'finance cannot revise terms');
  assert.equal((await propose(w, {}, staff.auditor.token)).status, 403);
  const own = must(await propose(w, {}, staff.legal.token), 201);
  assert.equal(own.proposed_side, 'sponsor');
  must(await decide(own, staff.approver.token, 'withdraw').then((r) => ({ ...r, status: r.status })), 200);
  // the athlete proposes; the brand's legal role cannot bind it, its approver can
  const counter = must(await propose(w, { lines: [{ ...money, amount_cents: 40000 }] }, ath.token), 201);
  assert.equal(counter.proposed_side, 'recipient');
  assert.equal((await decide(counter, staff.legal.token, 'accept')).status, 403);
  assert.equal((await decide(counter, staff.finance.token, 'accept')).status, 403);
  assert.equal((await decide(counter, staff.auditor.token, 'accept')).status, 403);
  must(await decide(counter, staff.approver.token, 'accept'));
  assert.equal((await live(w)).filter((o) => o.version === 2).every((o) => o.amount_cents === 40000), true);
});

test('organisation agreements: a payee change is part of the mutual amendment and applies on acceptance only', async () => {
  const owner = await signup(['coach']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Riverside ${++n}` } }), 201);
  must(await api('PATCH', `/organisations/${org.id}`, { token: owner.token, body: { open_to_sponsors: true } }));
  const mk = async (role) => {
    const u = await signup(['coach']);
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
    return u;
  };
  const fin = await mk('finance'), plain = await mk('member').catch(() => null);
  const sponsor = await signup(['sponsor']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Brand${n}` } }), 201);
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'organisation', target_id: org.id, ...period, lines: [money] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: owner.token, body: { status: 'active', version: 1 } }));
  const w = { id: deal.id, sponsor, ath: owner };
  const alloc = [{ beneficiary_type: 'organisation', beneficiary_id: org.id, share_bp: 10000, payee_user_id: fin.id }];
  assert.equal((await propose(w, { lines: [money], allocations: alloc }, sponsor.token)).status, 400, 'only the organisation proposes who is paid');
  assert.equal((await api('POST', `/sponsorships/${deal.id}/amendments`, { token: fin.token, body: { expected_version: 1, effective_from: '2030-03-01', lines: [money], allocations: alloc } })).status, 403, 'a payee is not a representative');
  const a = must(await propose(w, { lines: [money], allocations: alloc }, owner.token), 201);
  assert.equal(a.changes_payees, true);
  const before = must(await api('GET', `/sponsorships/${deal.id}/allocations`, { token: owner.token }));
  assert.equal(before.allocations.length, 0, 'unaccepted: payees unchanged');
  const seen = must(await api('GET', `/sponsorship-amendments/${a.id}`, { token: sponsor.token }));
  assert.equal(seen.allocations[0].payee_user_id, undefined, 'the brand never sees payee identities'); assert.equal(seen.allocations[0].payee_name, undefined);
  must(await decide(a, sponsor.token, 'accept'));
  const after = must(await api('GET', `/sponsorships/${deal.id}/allocations`, { token: owner.token }));
  assert.equal(after.allocations.length, 1); assert.equal(after.allocations[0].payee_name, fin.display_name);
  assert.equal((await live(w)).length, 6, 'no due changed: only the payee did');
  void plain;
});

test('a budget-controlled agreement: extra cash needs headroom, a reduction frees it, and retained dues keep counting', async () => {
  const owner = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Brand${n}` } }), 201);
  const bud = must(await api('POST', '/sponsorship-budgets', { token: owner.token, body: { sponsor_id: b.id, currency: 'USD', kind: 'annual', name: `FY ${n}`, fiscal_year: 2030, authorized_cents: 100000 } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const line = { kind: 'money', label: 'Support', currency: 'USD', amount_cents: 10000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 6 };
  const deal = must(await api('POST', '/sponsorships', { token: owner.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, budget_id: bud.id, deliverables: 'Kit', ...period, lines: [line] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: 1 } }));
  const free = async () => must(await api('GET', `/sponsorship-budgets/${bud.id}`, { token: owner.token })).available_cents;
  assert.equal(await free(), 40000);
  const w = { id: deal.id, sponsor: owner, ath };
  const big = must(await propose(w, { lines: [{ ...line, amount_cents: 30000 }], effective_from: '2030-04-01' }), 201); // 3 retained x 10000 + 3 x 30000 = 120000 > 100000
  assert.equal((await decide(big, ath.token, 'accept')).status, 409, 'above the authorized budget');
  assert.equal(await free(), 40000); assert.equal((await live(w)).length, 6);
  must(await decide(big, owner.token, 'withdraw'));
  const small = must(await propose(w, { lines: [{ ...line, amount_cents: 5000 }], effective_from: '2030-04-01' }), 201);
  must(await decide(small, ath.token, 'accept'));
  assert.equal(await free(), 100000 - (30000 + 15000), 'retained dues count at their old value, new ones at the new value');
  assert.equal((await propose(w, { expected_version: 2, lines: [{ ...line, currency: 'SGD', amount_cents: 5000 }], effective_from: '2030-05-01' })).status, 422, 'one currency only');
});
