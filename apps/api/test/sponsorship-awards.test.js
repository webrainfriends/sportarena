// Award approvals and conditional sponsorship offers (#289): sign-off thresholds, budget reservation, idempotent issue, expiry,
// waitlist, exact-version acceptance that creates one agreement, isolation and the additive migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { expireAwards } = await import('../src/sponsorship-awards.js');
const { STEPS } = await import('../src/worker.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `aw_${n}_${roles[0]}`, display_name: `Award ${n}`, email: `aw${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** A brand run by an organisation with an approver, finance and legal member next to the owner (manager). */
const brand = async () => {
  const owner = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Acme ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Corp ${n}` } }), 201);
  must(await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'sponsor', asset_id: b.id } }));
  const staff = {};
  for (const role of ['approver', 'finance', 'legal']) {
    const u = await signup(['athlete']);
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
    staff[role] = u;
  }
  return { owner, b, staff };
};
const live = async (extra = {}) => {
  const w = await brand();
  let p = must(await api('POST', '/sponsorship-programs', { token: w.owner.token, body: { sponsor_id: w.b.id, name: 'Youth fund', currency: 'USD', budget_cents: 100000, max_award_cents: 60000 } }), 201);
  const r = must(await api('POST', `/sponsorship-programs/${p.id}/rounds`, { token: w.owner.token, body: { opens_on: day(-1), closes_on: day(30) } }), 201);
  p = must(await api('POST', `/sponsorship-programs/${p.id}/status`, { token: w.owner.token, body: { status: 'published', version: p.row_version } }));
  if (Object.keys(extra).length) p = must(await api('PATCH', `/sponsorship-programs/${p.id}`, { token: w.owner.token, body: { version: p.row_version, ...extra } }));
  return { w, p, r };
};
const applyFor = async (r, cents = 20000) => {
  const a = await signup(['athlete']);
  const app = must(await api('POST', `/program-rounds/${r.id}/applications`, { token: a.token, body: { target_type: 'athlete', target_id: a.id, requested_cents: cents, pitch: 'Please' } }), 201);
  return { a, app };
};
const version = async (w, p) => (await api('GET', `/sponsorship-programs/${p.id}`, { token: w.owner.token })).body.row_version;
const award = async (w, p, app, extra = {}) => api('PATCH', `/program-applications/${app.id}`, { token: w.owner.token, body: { decision: 'award', program_version: await version(w, p), ...extra } });
const row = async (id) => (await pool.query('SELECT * FROM sponsorship_awards WHERE id=$1', [id])).rows[0];
const held = async (pid) => Number((await pool.query("SELECT coalesce(sum(amount_cents),0) AS s FROM sponsorship_award_reservations WHERE program_id=$1 AND status='held'", [pid])).rows[0].s);
const sign = (u, id, step, v, decision = 'approve') => api('POST', `/program-awards/${id}/approvals`, { token: u.token, body: { step, decision, offer_version: v } });
const issue = (w, id, v, key = 'issue-key-0001') => api('POST', `/program-awards/${id}/issue`, { token: w.owner.token, body: { offer_version: v, idempotency_key: key } });
const accept = (a, id, v) => api('POST', `/program-awards/${id}/respond`, { token: a.token, body: { decision: 'accept', offer_version: v } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('unapproved awards cannot issue; sign-offs follow the thresholds, the proposer cannot sign, and approval makes it issuable', async () => {
  const { w, p, r } = await live({ award_approval_cents: 10000, finance_signoff_cents: 30000, legal_signoff_required: true });
  const { a, app } = await applyFor(r, 40000);
  const won = must(await award(w, p, app));
  assert.equal(won.award.status, 'pending_approval');
  const id = won.award.id, v = won.award.offer_version;
  assert.equal(await held(p.id), 40000, 'budget is reserved while the award waits');
  assert.equal((await issue(w, id, v)).status, 422, 'unapproved');
  assert.equal((await accept(a, id, v)).status, 409, 'not issued, so it cannot be accepted');
  assert.equal((await api('GET', `/program-awards/${id}`, { token: a.token })).status, 404, 'internal stages are hidden from the recipient');
  assert.equal((await sign(w.owner, id, 'approver', v)).status, 403, 'the proposer cannot sign');
  assert.equal((await sign(w.staff.finance, id, 'approver', v)).status, 403, 'wrong role');
  assert.equal((await sign(w.staff.approver, id, 'legal', v)).status, 403, 'wrong step for the role');
  assert.equal((await sign(w.staff.approver, id, 'approver', v + 1)).status, 409, 'stale offer version');
  must(await sign(w.staff.approver, id, 'approver', v));
  assert.equal((await sign(w.staff.approver, id, 'approver', v)).status, 409, 'already decided');
  must(await sign(w.staff.finance, id, 'finance', v));
  assert.equal((await issue(w, id, v)).status, 422, 'legal still missing');
  const view = must(await sign(w.staff.legal, id, 'legal', v));
  assert.equal(view.status, 'approved');
  const issued = must(await issue(w, id, v));
  assert.equal(issued.status, 'issued');
  assert.ok(issued.expires_at);
  assert.match(issued.letter, /offer version 1/);
  // a small award under every threshold only needs legal, because the program requires it for all
  const small = await applyFor(r, 5000);
  const w2 = must(await award(w, p, small.app));
  assert.deepEqual((await row(w2.award.id)).status, 'pending_approval');
  assert.equal((await pool.query('SELECT step FROM sponsorship_award_approvals WHERE award_id=$1', [w2.award.id])).rows.map((x) => x.step).join(), 'legal');
});

test('over-budget awards cannot be created or revised past the budget; a rejection releases the reservation', async () => {
  const { w, p, r } = await live({ award_approval_cents: 1 });
  const one = await applyFor(r, 60000), two = await applyFor(r, 60000);
  const first = must(await award(w, p, one.app));
  assert.equal(await held(p.id), 60000);
  const over = await award(w, p, two.app);
  assert.equal(over.status, 409, 'would exceed the program budget');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_awards WHERE application_id=$1', [two.app.id])).rows[0].n, 0);
  // raising the first award above what is left is refused too
  const small = await applyFor(r, 30000);
  must(await award(w, p, small.app, { awarded_cents: 30000 }));
  assert.equal(await held(p.id), 90000);
  assert.equal((await api('PATCH', `/program-awards/${first.award.id}`, { token: w.owner.token, body: { row_version: first.award.row_version, amount_cents: 70000 } })).status, 400, 'above what was requested');
  assert.equal((await api('PATCH', `/program-awards/${first.award.id}`, { token: w.owner.token, body: { row_version: first.award.row_version, amount_cents: 60000 } })).status, 200);
  // rejecting frees the money for the next award
  must(await sign(w.staff.approver, first.award.id, 'approver', 2, 'reject').then((x) => (x.status === 409 ? sign(w.staff.approver, first.award.id, 'approver', 3, 'reject') : x)));
  assert.equal((await row(first.award.id)).status, 'rejected');
  assert.equal(await held(p.id), 30000);
  must(await award(w, p, two.app, { awarded_cents: 40000 }));
});

test('retries and concurrent issues reserve and notify once; the issue key makes a replay return the same offer', async () => {
  const { w, p, r } = await live({ award_approval_cents: 1 });
  const { a, app } = await applyFor(r, 20000);
  const won = must(await award(w, p, app));
  const id = won.award.id, v = won.award.offer_version;
  must(await sign(w.staff.approver, id, 'approver', v));
  const res = await Promise.all([issue(w, id, v, 'same-key-0001'), issue(w, id, v, 'same-key-0001'), issue(w, id, v, 'same-key-0001')]);
  assert.deepEqual(res.map((x) => x.status), [200, 200, 200]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_award_reservations WHERE award_id=$1', [id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='sponsorship_offer'", [a.id])).rows[0].n, 1, 'notified once');
  assert.equal((await issue(w, id, v, 'other-key-0002')).status, 409, 'a different key on an issued offer is not a replay');
  assert.equal(await held(p.id), 20000);
  // deciding the application again is refused and does not reserve again
  assert.equal((await award(w, p, app)).status, 409);
  assert.equal(await held(p.id), 20000);
});

test('acceptance names the exact version, creates exactly one canonical agreement, and a double accept is a replay', async () => {
  const { w, p, r } = await live();
  const { a, app } = await applyFor(r, 20000);
  const won = must(await award(w, p, app, { awarded_cents: 18000 }));
  const id = won.award.id;
  assert.equal(won.award.status, 'issued');
  const other = await signup(['athlete']);
  assert.equal((await accept(other, id, 1)).status, 404, 'someone else cannot see or accept it');
  // the brand revises the offer: the old version can no longer be accepted
  const rev = must(await api('PATCH', `/program-awards/${id}`, { token: w.owner.token, body: { row_version: won.award.row_version, amount_cents: 17000, conditions: [{ text: 'Share your club accounts', due_on: day(20), blocks_payment: true }] } }));
  assert.equal(rev.offer_version, 2);
  assert.equal(rev.status, 'approved');
  assert.equal((await accept(a, id, 1)).status, 409, 'withdrawn for revision');
  assert.equal(await held(p.id), 17000, 'the reservation follows the revised amount');
  must(await issue(w, id, 2, 'reissue-key-1'));
  const seen = must(await api('GET', `/program-awards/${id}`, { token: a.token }));
  assert.equal(seen.conditions.length, 1);
  assert.equal(seen.my_side, 'recipient');
  assert.equal(seen.approvals, undefined, 'recipients do not see the sign-offs');
  assert.equal((await accept(a, id, 1)).status, 409, 'stale version');
  const done = await Promise.all([accept(a, id, 2), accept(a, id, 2)]);
  assert.deepEqual(done.map((x) => x.status), [200, 200]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorships WHERE application_id=$1', [app.id])).rows[0].n, 1, 'one canonical agreement');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id=$1', [done[0].body.sponsorship_id])).rows[0].n, 1);
  const deal = (await pool.query('SELECT status, amount_cents, accepted_version FROM sponsorships WHERE id=$1', [done[0].body.sponsorship_id])).rows[0];
  assert.deepEqual([deal.status, Number(deal.amount_cents), deal.accepted_version], ['active', 17000, 1]);
  assert.equal((await pool.query("SELECT status FROM sponsorship_award_reservations WHERE award_id=$1", [id])).rows[0].status, 'converted');
  assert.equal(await held(p.id), 0, 'accepted money is counted by the agreement, not twice');
  const summary = must(await api('GET', `/sponsorship-programs/${p.id}/award-summary`, { token: w.owner.token }));
  assert.deepEqual([summary.accepted_cents, summary.reserved_cents, summary.free_cents], [17000, 0, 83000]);
  // the condition is tracked by the brand, never by the recipient's say-so
  const cid = seen.conditions[0].id;
  assert.equal((await api('POST', `/program-awards/${id}/conditions/${cid}/met`, { token: a.token, body: {} })).status, 403);
  const due = must(await api('GET', '/sponsorship-obligations', { token: w.owner.token, query: { sponsorship_id: done[0].body.sponsorship_id } })).obligations[0];
  const pay = () => api('POST', `/sponsorship-obligations/${due.id}/payments`, { token: w.owner.token, body: { amount_cents: 17000, currency: 'USD', method: 'bank_transfer', reference: 'REF-AWARD-1', paid_on: day(0) } });
  assert.equal((await pay()).status, 409, 'a payment-blocking condition is unmet');
  const met = must(await api('POST', `/program-awards/${id}/conditions/${cid}/met`, { token: w.owner.token, body: { note: 'received' } }));
  assert.ok(met.conditions[0].met_at);
  assert.equal((await pay()).status, 201, 'payment can be reported once the condition is met');
});

test('expired offers cannot be accepted, release their reservation once, and the waitlist is promoted in rank order', async () => {
  const { w, p, r } = await live({ waitlist_enabled: true, offer_validity_days: 3 });
  const one = await applyFor(r, 60000), two = await applyFor(r, 50000), three = await applyFor(r, 50000);
  const first = must(await award(w, p, one.app));
  assert.equal(first.award.status, 'issued');
  const second = must(await award(w, p, two.app));
  assert.equal(second.award.status, 'waitlisted');
  assert.equal(second.award.waitlist_rank, 1);
  const third = must(await award(w, p, three.app));
  assert.equal(third.award.waitlist_rank, 2);
  assert.equal((await accept(two.a, second.award.id, 1)).status, 409, 'waitlisted offers cannot be accepted');
  assert.equal(await held(p.id), 60000);
  await pool.query("UPDATE sponsorship_awards SET expires_at = now() - interval '1 minute' WHERE id=$1", [first.award.id]);
  assert.equal((await accept(one.a, first.award.id, 1)).status, 409, 'expired');
  assert.equal((await row(first.award.id)).status, 'expired');
  // the freed 60000 goes to the first waitlisted award, then the next one that still fits
  const after1 = await row(second.award.id), after2 = await row(third.award.id);
  assert.equal(after1.status, 'issued');
  assert.equal(after2.status, 'issued');
  assert.equal(await held(p.id), 100000);
  assert.equal(await expireAwards(), 0, 'nothing left to expire');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sponsorship_award_reservations WHERE award_id=$1 AND status='released'", [first.award.id])).rows[0].n, 1);
  // the worker step expires the rest safely and repeatedly
  await pool.query("UPDATE sponsorship_awards SET expires_at = now() - interval '1 minute' WHERE id = ANY($1)", [[second.award.id, third.award.id]]);
  assert.equal(await expireAwards(), 2);
  assert.equal(await expireAwards(), 0);
  assert.equal(await held(p.id), 0);
  assert.ok(STEPS.some(([name]) => name === 'sponsor_awards'), 'registered in the maintenance worker');
  // after an expiry the brand can award the still-open application again
  assert.equal((await award(w, p, one.app)).status, 200);
});

test('declining releases the budget; withdrawing returns the application to the pile; no waitlist means a plain refusal', async () => {
  const { w, p, r } = await live();
  const one = await applyFor(r, 60000), two = await applyFor(r, 50000);
  const first = must(await award(w, p, one.app));
  assert.equal((await award(w, p, two.app)).status, 409, 'no waitlist on this program');
  must(await api('POST', `/program-awards/${first.award.id}/respond`, { token: one.a.token, body: { decision: 'decline', offer_version: 1, reason: 'Found other funding' } }));
  assert.equal(await held(p.id), 0);
  assert.equal((await pool.query('SELECT status FROM sponsorship_applications WHERE id=$1', [one.app.id])).rows[0].status, 'withdrawn');
  const second = must(await award(w, p, two.app));
  must(await api('POST', `/program-awards/${second.award.id}/withdraw`, { token: w.owner.token, body: { reason: 'changed plans' } }));
  assert.equal(await held(p.id), 0);
  assert.equal((await pool.query('SELECT status FROM sponsorship_applications WHERE id=$1', [two.app.id])).rows[0].status, 'submitted');
  must(await award(w, p, two.app));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorships WHERE program_id=$1', [p.id])).rows[0].n, 0, 'nothing became an agreement');
});

test('tenant isolation: other brands, staff without the role and strangers cannot read, change or export awards', async () => {
  const { w, p, r } = await live({ finance_signoff_cents: 1 });
  const { a, app } = await applyFor(r, 20000);
  const won = must(await award(w, p, app));
  const id = won.award.id;
  const other = await brand();
  for (const [m, path, body] of [['GET', `/program-awards/${id}`], ['GET', `/sponsorship-programs/${p.id}/awards`], ['GET', `/sponsorship-programs/${p.id}/award-summary`], ['GET', `/sponsorship-programs/${p.id}/awards-export`], ['PATCH', `/program-awards/${id}`, { row_version: 1, amount_cents: 10000 }], ['POST', `/program-awards/${id}/withdraw`, {}], ['POST', `/program-awards/${id}/issue`, { offer_version: 1, idempotency_key: 'intruder-key-1' }], ['POST', `/program-awards/${id}/approvals`, { step: 'finance', decision: 'approve', offer_version: 1 }]]) {
    const res = await api(m, path, { token: other.owner.token, body });
    assert.ok([403, 404].includes(res.status), `${m} ${path} -> ${res.status}`);
  }
  assert.equal((await api('POST', `/program-awards/${id}/approvals`, { token: other.staff.finance.token, body: { step: 'finance', decision: 'approve', offer_version: 1 } })).status, 403, 'finance of another brand');
  assert.equal((await api('PATCH', `/program-awards/${id}`, { token: w.staff.finance.token, body: { row_version: 1, amount_cents: 10000 } })).status, 403, 'finance cannot edit');
  assert.equal((await api('GET', `/sponsorship-programs/${p.id}/awards`, { token: a.token })).status, 403, 'the applicant cannot list brand awards');
  assert.equal((await api('GET', '/my/program-awards', { token: a.token })).body.length, 0, 'pending awards are not shown to the recipient');
  const stranger = await signup(['athlete']);
  assert.equal((await api('GET', `/program-awards/${id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('GET', `/sponsorship-programs/${p.id}/awards`, { token: w.staff.finance.token })).body.length, 1);
  const csv = must(await api('GET', `/sponsorship-programs/${p.id}/awards-export`, { token: w.owner.token }));
  assert.match(csv.csv, /pending_approval/);
  // paging is deterministic
  for (let k = 0; k < 3; k++) must(await award(w, p, (await applyFor(r, 1000)).app));
  const all = must(await api('GET', `/sponsorship-programs/${p.id}/awards`, { token: w.owner.token, query: { limit: 10 } }));
  const paged = [...must(await api('GET', `/sponsorship-programs/${p.id}/awards`, { token: w.owner.token, query: { limit: 2 } })), ...must(await api('GET', `/sponsorship-programs/${p.id}/awards`, { token: w.owner.token, query: { limit: 2, offset: 2 } }))];
  assert.deepEqual(paged.map((x) => x.id), all.map((x) => x.id));
});

test('migration 092 is additive and repeatable: existing agreements, applications and budgets keep every value', async () => {
  const { w, p, r } = await live();
  const { a, app } = await applyFor(r, 20000);
  const won = must(await award(w, p, app));
  must(await accept(a, won.award.id, 1));
  const snap = async () => ({
    app: (await pool.query('SELECT status, awarded_cents, sponsorship_id FROM sponsorship_applications WHERE id=$1', [app.id])).rows[0],
    deal: (await pool.query('SELECT status, amount_cents, application_id FROM sponsorships WHERE application_id=$1', [app.id])).rows[0],
    award: (await pool.query('SELECT status, amount_cents, offer_version FROM sponsorship_awards WHERE id=$1', [won.award.id])).rows[0],
    prog: (await pool.query('SELECT budget_cents, award_approval_cents, legal_signoff_required, offer_validity_days, waitlist_enabled FROM sponsorship_programs WHERE id=$1', [p.id])).rows[0],
  });
  const before = await snap();
  const sql = readFileSync(new URL('../migrations/092_sponsorship_awards.sql', import.meta.url), 'utf8');
  await pool.query(sql); await pool.query(sql);
  assert.deepEqual(await snap(), before);
  assert.deepEqual(before.prog, { budget_cents: 100000, award_approval_cents: null, legal_signoff_required: false, offer_validity_days: 14, waitlist_enabled: false }, 'new program rules default to the old behaviour');
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(DROP|TRUNCATE|DELETE)\b|CASCADE/i);
  // the single-agreement guarantee is enforced by the database, not only by the code
  await assert.rejects(pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, proposed_by, application_id) SELECT sponsor_id, target_type, target_id, 1, currency, proposed_by, application_id FROM sponsorships WHERE application_id=$1", [app.id]), /sponsorships_one_per_application/);
});
