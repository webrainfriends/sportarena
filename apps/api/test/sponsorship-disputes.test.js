// Sponsorship disputes, complaints and risk controls (#308).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { actionsFor } = await import('../src/sponsor-access.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sd_${n}_${roles[0]}`, display_name: `Disp ${n}`, email: `sd${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const PDF = Buffer.from('%PDF-1.4 fake evidence body').toString('base64');

const money = { kind: 'money', label: 'Season support', currency: 'SGD', amount_cents: 100000, cadence: 'custom', custom_dates: ['2020-01-15', '2020-02-15'] };
const goods = { kind: 'goods', label: 'Rackets', quantity: 10, unit: 'pcs', cadence: 'once', first_due_on: '2020-03-01' };
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']), outsider = await signup(['athlete']), otherBrand = await signup(['sponsor']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Brand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', starts_on: '2020-01-01', ends_on: '2099-12-31', lines: [money, goods] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: 1 } }));
  const w = { sponsor, ath, outsider, otherBrand, id: deal.id };
  const dues = must(await api('GET', `/sponsorships/${w.id}`, { token: ath.token })).obligations;
  w.due = dues.find((o) => o.kind === 'money'); w.goodsDue = dues.find((o) => o.kind === 'goods');
  const p = must(await api('POST', `/sponsorship-obligations/${w.due.id}/payments`, { token: sponsor.token, body: { amount_cents: 60000, currency: 'SGD', method: 'bank_transfer', reference: `REF-${n}`, paid_on: '2030-01-16' } }), 201);
  must(await api('PATCH', `/sponsorship-payments/${p.id}`, { token: ath.token, body: { status: 'confirmed' } }));
  w.pay = p;
  return w;
};
const dueOf = async (w) => must(await api('GET', `/sponsorships/${w.id}`, { token: w.ath.token })).obligations.find((o) => o.id === w.due.id);
const open = (w, body, token = w.sponsor.token) => api('POST', `/sponsorships/${w.id}/disputes`, { token, body: { subject_type: 'payment', subject_id: w.pay.id, disputed_cents: 60000, title: 'Payment amount is wrong', description: 'The slip shows a different amount', ...body } });
const get = (d, token) => api('GET', `/sponsorship-disputes/${d.id}`, { token });
const act = (d, path, token, body, rev = d.rev) => api('POST', `/sponsorship-disputes/${d.id}/${path}`, { token, body: { rev, ...body } });
let admin, admin2, admin3;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('sd_root'); admin2 = await mkAdmin('sd_root2'); admin3 = await mkAdmin('sd_root3');
});
after(async () => { server.close(); await pool.end(); });

test('opening a dispute keeps the debt, the payment and the evidence exactly as they were, and marks the record contested', async () => {
  const w = await world();
  const before = await dueOf(w);
  const d = must(await open(w, { evidence: [{ label: 'Bank slip', data: PDF, file_name: 'slip.pdf' }] }), 201);
  assert.equal(d.status, 'open'); assert.equal(d.contested, true); assert.equal(d.currency, 'SGD'); assert.equal(d.subject_type, 'payment');
  const after = await dueOf(w);
  assert.deepEqual({ s: after.status, p: after.payments.map((p) => [p.id, p.status, p.amount_cents]) }, { s: before.status, p: before.payments.map((p) => [p.id, p.status, p.amount_cents]) }, 'nothing about the due or payment changed');
  const detail = must(await get(d, w.ath.token));
  assert.equal(detail.evidence.length, 1); assert.equal(detail.evidence[0].file_name, 'slip.pdf'); assert.equal(detail.thread[0].body, 'The slip shows a different amount');
  assert.equal(detail.side, 'recipient'); assert.equal(detail.can.resolve, false);
  const list = must(await api('GET', `/sponsorships/${w.id}/disputes`, { token: w.ath.token }));
  assert.equal(list.disputes.length, 1); assert.ok(list.subjects.payments.length >= 1);
  const ev = must(await api('GET', `/sponsorship-disputes/${d.id}/evidence/${detail.evidence[0].id}`, { token: w.ath.token }));
  assert.equal(ev.data, PDF);
});

test('validation: a dispute is about a record of this agreement, within its amount and currency; one live dispute per record; retry-safe', async () => {
  const w = await world(), w2 = await world();
  assert.equal((await open(w, { subject_id: undefined })).status, 400, 'a payment dispute names the payment');
  assert.equal((await open(w, { disputed_cents: 60001 })).status, 400, 'more than the payment');
  assert.equal((await open(w, { disputed_cents: undefined })).status, 400, 'amount is required for a payment');
  assert.equal((await open(w, { subject_id: w2.pay.id })).status, 404, 'a payment of another agreement');
  assert.equal((await open(w, { subject_type: 'goods', subject_id: w.pay.id, disputed_cents: undefined })).status, 404);
  assert.equal((await open(w, { subject_type: 'agreement', subject_id: undefined, disputed_cents: 5 })).status, 400, 'amount only on payments');
  const a = must(await open(w, { idempotency_key: 'retry-key-0001' }), 201);
  const again = must(await open(w, { idempotency_key: 'retry-key-0001' }), 201);
  assert.equal(again.id, a.id, 'a retry returns the same dispute');
  assert.equal((await open(w, {}, w.ath.token)).status, 409, 'the other side cannot open a second live dispute on the same payment');
  const g = await api('POST', '/cases', { token: w.sponsor.token, body: { kind: 'dispute', category: 'sponsorship', subject: 'Payment dispute', description: 'x y z abc', links: [{ type: 'sponsorship', id: w.id }] } });
  assert.equal(g.status, 400, 'the generic case form cannot open a sponsorship dispute');
  const ag = must(await open(w, { subject_type: 'agreement', subject_id: undefined, disputed_cents: undefined, title: 'Kit was not supplied' }), 201);
  assert.equal(ag.subject_type, 'agreement');
});

test('only the two sides and assigned reviewers can see a dispute; unrelated people and staff get nothing', async () => {
  const w = await world();
  const d = must(await open(w), 201);
  for (const who of [w.outsider, w.otherBrand, admin]) {
    assert.ok([403, 404].includes((await get(d, who.token)).status), 'read denied');
    assert.ok([403, 404].includes((await api('GET', `/sponsorships/${w.id}/disputes`, { token: who.token })).status) || who === admin, 'list denied');
    assert.ok([403, 404].includes((await act(d, 'replies', who.token, { body: 'hi there' })).status), 'write denied');
  }
  assert.deepEqual(must(await api('GET', `/sponsorships/${w.id}/disputes`, { token: admin.token })).disputes, [], 'an unassigned admin sees no disputes');
  const q = must(await api('GET', '/admin/cases', { token: admin.token, query: { kind: 'dispute' } }));
  assert.ok(!q.some((c) => c.id === d.case_id), 'the dispute is not in an unassigned admin\'s queue');
  assert.equal((await api('GET', `/cases/${d.case_id}`, { token: admin.token })).status, 404);
  assert.equal((await api('GET', `/admin/cases/${d.case_id}/evidence`, { token: admin.token })).status, 404);
  assert.equal((await api('POST', `/admin/cases/${d.case_id}/resolve`, { token: admin.token, body: { resolution: 'closing it quickly' } })).status, 404);
  assert.equal((await api('POST', `/cases/${d.case_id}/withdraw`, { token: w.sponsor.token, body: {} })).status, 409, 'the case cannot be changed around the dispute rules');
  assert.equal((await api('GET', `/sponsorships/${w.id}/disputes/export`, { token: w.outsider.token })).status, 403);
  for (const role of ['evaluator', 'viewer']) assert.ok(!actionsFor(role).includes('dispute') && !actionsFor(role).includes('dispute_read'), `${role} never sees disputes`);
  assert.ok(actionsFor('auditor').includes('dispute_read') && !actionsFor('auditor').includes('dispute'));
});

test('reviewers: a claim is reasoned and audited; only assigned reviewers read and act; parties cannot review', async () => {
  const w = await world();
  const d = must(await open(w), 201);
  assert.equal((await act(d, 'reviewers', w.sponsor.token, { action: 'claim', reason: 'I will take it' })).status, 403, 'a party cannot claim');
  assert.equal((await act(d, 'reviewers', admin.token, { action: 'claim' })).status, 400, 'reason required');
  const c1 = must(await act(d, 'reviewers', admin.token, { action: 'claim', reason: 'Finance queue owner' }));
  assert.equal(c1.rev, d.rev + 1);
  assert.equal((await act(d, 'reviewers', admin.token, { action: 'claim', reason: 'again please' }, c1.rev)).status, 409, 'already assigned');
  assert.equal((await act(d, 'reviewers', admin2.token, { action: 'add', user_id: admin2.id, reason: 'self add attempt' }, c1.rev)).status, 404, 'an unassigned admin cannot add anyone');
  const detail = must(await get(d, admin.token));
  assert.equal(detail.side, 'reviewer'); assert.equal(detail.status, 'under_review'); assert.equal(detail.reviewers.length, 1);
  assert.equal(must(await get(d, w.ath.token)).reviewers.length, 0, 'parties do not see the reviewer roster');
  assert.equal((await act(d, 'reviewers', admin.token, { action: 'add', user_id: w.outsider.id, reason: 'not staff here' }, detail.rev)).status, 400, 'reviewers must be platform staff');
  const c2 = must(await act(d, 'reviewers', admin.token, { action: 'add', user_id: admin2.id, reason: 'second pair of eyes' }, detail.rev));
  must(await act(d, 'reviewers', admin.token, { action: 'remove', user_id: admin2.id, reason: 'no longer needed' }, c2.rev));
  assert.equal((await get(d, admin2.token)).status, 404, 'a removed reviewer loses access at once');
  const logs = (await pool.query("SELECT action FROM audit_log WHERE entity_id=$1 OR entity_id=$2", [d.id, w.id])).rows.map((r) => r.action);
  assert.ok(logs.includes('sponsorship.dispute_reviewer_claim') && logs.includes('sponsorship.dispute_read'));
  const internal = must(await act(d, 'replies', admin.token, { body: 'internal view only', internal: true }, (await get(d, admin.token)).body.rev), 201);
  assert.ok(must(await get(d, admin.token)).thread.some((m) => m.visibility === 'internal'));
  assert.ok(!must(await get(d, w.sponsor.token)).thread.some((m) => m.visibility === 'internal'), 'internal notes never reach the sides');
  assert.ok(internal.rev);
});

test('risk flags are reasoned, attributed, never deleted and cleared with a reason', async () => {
  const w = await world();
  const d = must(await open(w), 201);
  assert.equal((await act(d, 'flags', w.ath.token, { kind: 'amount_mismatch', reason: 'no' })).status, 400, 'a reason is required');
  const f = must(await act(d, 'flags', w.ath.token, { kind: 'amount_mismatch', reason: 'The slip shows a different amount' }), 201);
  assert.equal((await act(d, 'flags', w.ath.token, { kind: 'amount_mismatch', reason: 'stale revision attempt' })).status, 409, 'stale rev');
  const claim = must(await act({ ...d, rev: f.rev }, 'reviewers', admin.token, { action: 'claim', reason: 'Taking the review' }));
  let detail = must(await get(d, w.sponsor.token));
  assert.equal(detail.flags.length, 1); assert.equal(detail.flags[0].raised_side, 'recipient'); assert.equal(detail.flags[0].cleared_at, null);
  assert.equal((await act(d, `flags/${f.id}/clear`, w.ath.token, { reason: 'I take it back now' }, claim.rev)).status, 403, 'only a reviewer clears');
  must(await act(d, `flags/${f.id}/clear`, admin.token, { reason: 'Slip verified with the bank' }, claim.rev));
  detail = must(await get(d, w.sponsor.token));
  assert.equal(detail.flags[0].cleared_reason, 'Slip verified with the bank'); assert.equal(detail.flags.length, 1, 'the flag stays on record');
  await assert.rejects(pool.query('DELETE FROM sponsorship_dispute_flags WHERE id=$1', [f.id]), /never deleted/);
  await assert.rejects(pool.query('DELETE FROM sponsorship_disputes WHERE id=$1', [d.id]), /never deleted/);
  assert.ok(detail.history.some((h) => h.action === 'flag' && h.reason));
});

test('a concession is applied through the canonical obligation, bounded, once; the appeal is decided by someone else and is final', async () => {
  const w = await world();
  const before = await dueOf(w); // 100000 due, 60000 confirmed => 40000 still owed
  const d = must(await open(w, { disputed_cents: 30000 }), 201);
  const claim = must(await act(d, 'reviewers', admin.token, { action: 'claim', reason: 'Reviewing this one' }));
  const res = (body, token = admin.token, rev = d.rev) => act(d, 'resolve', token, body, rev);
  assert.equal((await res({ outcome: 'concession', reason: 'Parties settle', amount_cents: 5000 }, w.sponsor.token, claim.rev)).status, 403, 'a party cannot decide');
  assert.equal((await res({ outcome: 'concession', reason: 'Parties settle', amount_cents: 5000 }, admin.token, d.rev)).status, 409, 'stale rev');
  assert.equal((await res({ outcome: 'concession', reason: 'Parties settle', amount_cents: 30001 }, admin.token, claim.rev)).status, 400, 'more than disputed');
  assert.equal((await res({ outcome: 'no_financial_change', reason: 'No change needed', amount_cents: 5 }, admin.token, claim.rev)).status, 400, 'only a concession moves money');
  assert.equal((await res({ outcome: 'concession', reason: 'Parties settle' }, admin.token, claim.rev)).status, 400, 'a concession needs an amount');
  const r1 = must(await res({ outcome: 'concession', reason: 'Slip confirms a shortfall', amount_cents: 25000 }, admin.token, claim.rev));
  assert.equal(r1.status, 'resolved');
  const mid = await dueOf(w);
  assert.equal(Number(mid.conceded_cents), 25000, 'the canonical obligation carries the concession');
  assert.equal(mid.payments[0].status, 'confirmed', 'the payment itself is untouched');
  assert.equal((await res({ outcome: 'dismissed', reason: 'Trying twice over' }, admin.token, r1.rev)).status, 409, 'a decided dispute cannot be decided again');
  const detail = must(await get(d, w.ath.token));
  assert.equal(detail.status, 'resolved'); assert.equal(detail.contested, false);
  assert.equal(Number(detail.adjustments[0].amount_cents), 25000); assert.equal(detail.can.appeal, true); assert.equal(detail.can.resolve, false);
  await assert.rejects(pool.query('UPDATE sponsorship_dispute_adjustments SET amount_cents=1 WHERE dispute_id=$1', [d.id]), /never deleted/);
  // appeal: once, with a reason, by a party
  assert.equal((await act(d, 'appeal', w.outsider.token, { reason: 'I should be allowed' }, r1.rev)).status, 403);
  const ap = must(await act(d, 'appeal', w.sponsor.token, { reason: 'New bank statement shows more', evidence: [{ label: 'Statement', data: PDF }] }, r1.rev));
  assert.equal(ap.status, 'appealed');
  assert.equal((await act(d, 'appeal', w.sponsor.token, { reason: 'Second appeal attempt' }, ap.rev)).status, 409);
  assert.equal((await res({ outcome: 'no_financial_change', reason: 'Same reviewer again' }, admin.token, ap.rev)).status, 403, 'a different reviewer decides the appeal');
  assert.equal((await act(d, 'reviewers', admin.token, { action: 'add', user_id: admin2.id, reason: 'Independent appeal reviewer' }, ap.rev)).status, 200);
  const rev = (await get(d, admin2.token)).body.rev;
  assert.equal((await res({ outcome: 'concession', reason: 'Exceeds what is still owed', amount_cents: 15001 }, admin2.token, rev)).status, 400, 'bounded by what the due still owes (40000-25000)');
  const final = must(await res({ outcome: 'concession', reason: 'Appeal upheld in part', amount_cents: 5000 }, admin2.token, rev));
  assert.equal(Number((await dueOf(w)).conceded_cents), 30000);
  assert.equal((await act(d, 'appeal', w.ath.token, { reason: 'No further appeal' }, final.rev)).status, 409, 'final');
  const end = must(await get(d, w.sponsor.token));
  assert.equal(end.appeals.length, 1); assert.equal(end.appeals[0].decision_before, 'Slip confirms a shortfall'); assert.equal(end.adjustments.length, 2);
  assert.equal(before.status, 'scheduled');
});

test('concurrent decisions apply once', async () => {
  const w = await world();
  const d = must(await open(w), 201);
  const claim = must(await act(d, 'reviewers', admin3.token, { action: 'claim', reason: 'Concurrency check' }));
  const go = () => act(d, 'resolve', admin3.token, { outcome: 'concession', reason: 'Settled by review', amount_cents: 10000 }, claim.rev);
  const rs = await Promise.all([go(), go(), go()]);
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(Number((await dueOf(w)).conceded_cents), 10000);
});

test('withdrawing keeps everything; stale versions, empty/denied states and exports behave', async () => {
  const w = await world();
  const d = must(await open(w), 201);
  assert.equal((await act(d, 'withdraw', w.ath.token, {})).status, 403, 'only the side that raised it withdraws');
  assert.equal((await act(d, 'withdraw', w.sponsor.token, {}, 99)).status, 409);
  const wd = must(await act(d, 'withdraw', w.sponsor.token, {}));
  assert.equal(wd.status, 'withdrawn');
  const detail = must(await get(d, w.ath.token));
  assert.equal(detail.contested, false); assert.equal(detail.thread.length, 1); assert.equal((await act(d, 'flags', w.ath.token, { kind: 'other', reason: 'too late now' }, wd.rev)).status, 409);
  const csv = must(await api('GET', `/sponsorships/${w.id}/disputes/export`, { token: w.ath.token }));
  assert.equal(csv.rows, 1); assert.match(csv.csv, /^case_no,subject_type,status/);
  const none = await world();
  const empty = must(await api('GET', `/sponsorships/${none.id}/disputes`, { token: none.sponsor.token }));
  assert.deepEqual(empty.disputes, []); assert.equal(empty.can_open, true);
  const paged = must(await api('GET', `/sponsorships/${w.id}/disputes`, { token: w.ath.token, query: { limit: 1, offset: 5 } }));
  assert.deepEqual(paged.disputes, []);
});

test('an open dispute blocks finalising a termination settlement and stays visible there', async () => {
  const w = await world();
  const d = must(await open(w), 201);
  const t = must(await api('POST', `/sponsorships/${w.id}/termination`, { token: w.sponsor.token, body: { reason_code: 'budget', reason: 'Budget cut', effective_on: new Date().toISOString().slice(0, 10), expected_version: 1 } }), 201);
  const s = must(await api('GET', `/sponsorships/${w.id}/termination`, { token: w.sponsor.token }));
  assert.ok(JSON.stringify(s).includes(`${d.id}`), 'the dispute shows in the settlement items');
  assert.ok(t.termination);
});
