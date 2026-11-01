import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { settle, describePurpose } = await import('../src/payments/service.js');
const { quote } = await import('../src/registration-engine.js');
const { KINDS } = await import('../src/registration-engine.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const inst = (offsetDays) => new Date(Date.now() + offsetDays * 864e5).toISOString();
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `rx_${n}_${roles[0]}`, display_name: `Rx ${n}`, email: `rx${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
let key = 0;
const idem = () => `test-key-${++key}-${Date.now()}`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('rx_root','rx_root','{admin}','x','x','rx_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const text = (key, label, extra = {}) => ({ key, label, type: 'text', required: true, ...extra });
const form = (...fields) => ({ sections: [{ id: 'main', title: 'Details', fields }] });
const programme = async (org, body, version) => {
  const p = must(await api('POST', '/registration-programmes', { token: org.token, body }), 201);
  if (version) must(await api('POST', `/registration-programmes/${p.id}/versions`, { token: org.token, body: { expected_version: 0, ...version } }), 201);
  return p;
};
const open = async (org, p) => must(await api('POST', `/registration-programmes/${p.id}/status`, { token: org.token, body: { status: 'open' } }));
const start = async (who, p, body = {}) => must(await api('POST', `/registration-programmes/${p.id}/entries`, { token: who.token, body }), 201);
const submit = (who, e, k = idem()) => api('POST', `/registration-entries/${e.id}/submit`, { token: who.token, body: { row_version: e.row_version, idempotency_key: k } });
const decide = (staff, e, action, note) => api('POST', `/registration-entries/${e.id}/decision`, { token: staff.token, body: { action, row_version: e.row_version, note } });
const get = async (who, e) => must(await api('GET', `/registration-entries/${e.id}`, { token: who.token }));
const day0 = () => new Date().toISOString().slice(0, 10);

test('pure rules: fee quote, discounts, instalments are deterministic and never negative', () => {
  const fees = { items: [{ key: 'base', label: 'Base', amount_cents: 10000 }, { key: 'kit', label: 'Kit', amount_cents: 2500, when: { field: 'kit', op: 'eq', value: 'yes' } }],
    discounts: [{ key: 'early', label: 'Early bird', kind: 'percent', value: 10, auto: 'early_bird', before: '2999-01-01' }, { key: 'save', label: 'Code', kind: 'amount', value: 99999999, code: 'SAVE' }], instalments: { count: 3, interval_days: 30 } };
  const a = quote(fees, { answers: { kit: 'yes' }, codes: [], today: '2030-01-01', plan: 'instalments' });
  assert.equal(a.subtotal_cents, 12500); assert.equal(a.discount_cents, 1250); assert.equal(a.total_cents, 11250);
  assert.deepEqual(a.instalments.map((x) => x.amount_cents), [3750, 3750, 3750]); assert.equal(a.instalments[2].due_on, '2030-03-02');
  const b = quote(fees, { answers: {}, codes: ['save', 'nope'], today: '2030-01-01' });
  assert.equal(b.total_cents, 0); assert.deepEqual(b.rejected_codes, ['NOPE']); assert.equal(b.instalments.length, 0);
  assert.deepEqual(quote(fees, { answers: { kit: 'yes' }, codes: [], today: '2030-01-01', plan: 'instalments' }), a, 'same inputs, same quote');
  const odd = quote({ items: [{ key: 'x', label: 'X', amount_cents: 1000 }], instalments: { count: 3, interval_days: 7 } }, { today: '2030-01-01', plan: 'instalments' });
  assert.equal(odd.instalments.reduce((s, x) => s + x.amount_cents, 0), 1000, 'instalments always add up to the total');
});

test('scenario 1 — course/camp: form, conditional questions, fees, discount, instalments, capacity, quota, waitlist, idempotency, privacy', async () => {
  const org = await signup(['organizer']), a = await signup(), b = await signup(), c = await signup(), stranger = await signup();
  const p = await programme(org, { kind: 'course', title: 'Summer camp', sport: 'cricket', capacity: 2, currency: 'GBP', quotas: [{ field: 'group', limits: { under12: 1 } }] }, {
    form: form({ key: 'group', label: 'Group', type: 'choice', required: true, options: [{ value: 'under12', label: 'Under 12' }, { value: 'adult', label: 'Adult' }] },
      { key: 'allergy', label: 'Any allergies?', type: 'yesno', required: true },
      { key: 'allergy_detail', label: 'Which?', type: 'text', required: true, confidential: true, when: { field: 'allergy', op: 'eq', value: true } }),
    fees: { items: [{ key: 'camp', label: 'Camp', amount_cents: 30000 }], discounts: [{ key: 'friends', label: 'Friends', kind: 'amount', value: 5000, code: 'FRIENDS', max_uses: 1 }], instalments: { count: 2, interval_days: 30 } },
    waivers: [{ key: 'photo', title: 'Photo consent', body: 'We may photograph the camp.', required: true }],
  });
  // not open yet: nobody can start; drafts are invisible to strangers
  assert.equal((await api('POST', `/registration-programmes/${p.id}/entries`, { token: a.token, body: {} })).status, 404);
  assert.equal((await api('GET', `/registration-programmes/${p.id}`, { token: stranger.token })).status, 404);
  await open(org, p);
  assert.equal(must(await api('GET', '/registration-programmes', { token: stranger.token, query: { kind: 'course' } })).length, 1);
  assert.equal(must(await api('GET', '/registration-programmes', { token: stranger.token, query: { scope: 'managed' } })).length, 0);
  assert.equal(must(await api('GET', '/registration-programmes', { token: org.token, query: { scope: 'managed' } })).length, 1);

  const q = must(await api('POST', `/registration-programmes/${p.id}/quote`, { token: a.token, body: { answers: {}, codes: ['friends'], plan: 'instalments' } }));
  assert.equal(q.total_cents, 25000); assert.equal(q.instalments.length, 2); assert.equal(q.currency, 'GBP');

  // required answers, conditional question (shown only when allergy=yes) and waivers are enforced on submit
  let e = await start(a, p, { answers: { group: 'adult', allergy: true }, codes: ['friends'], plan: 'instalments' });
  assert.equal(e.status, 'draft');
  let bad = await submit(a, e); assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.issues.some((x) => x.path === 'answers.allergy_detail'));
  e = must(await api('PATCH', `/registration-entries/${e.id}`, { token: a.token, body: { row_version: e.row_version, answers: { group: 'adult', allergy: true, allergy_detail: 'Peanuts' } } }));
  bad = await submit(a, e); assert.equal(bad.status, 409); assert.equal(bad.body.error.details.code, 'waivers_unsigned');
  must(await api('POST', `/registration-entries/${e.id}/signatures`, { token: a.token, body: { waiver_key: 'photo', signature: 'Alex Adult', accept: true } }), 201);
  assert.equal((await api('POST', `/registration-entries/${e.id}/signatures`, { token: a.token, body: { waiver_key: 'photo', signature: 'Alex Adult', accept: true } })).status, 201, 'signing twice is idempotent');
  e = await get(a, e);
  const k = idem();
  const sub = must(await submit(a, e, k));
  assert.equal(sub.status, 'submitted'); assert.match(sub.receipt_no, /^RX-\d{6}$/); assert.equal(sub.total_cents, 25000);
  assert.deepEqual(sub.instalments.map((x) => x.amount_cents), [12500, 12500]);
  assert.equal(must(await submit(a, e, k)).receipt_no, sub.receipt_no, 'the same key never files twice');
  assert.equal((await submit(a, e, idem())).status, 409, 'already submitted');
  // confidential answer: applicant and staff see it, the staff read is audit-logged, a stranger gets 404
  assert.equal((await get(a, e)).answers.allergy_detail, 'Peanuts');
  assert.equal((await get(org, e)).answers.allergy_detail, 'Peanuts');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_registration_confidential'")).rowCount >= 1);
  assert.equal((await api('GET', `/registration-entries/${e.id}`, { token: stranger.token })).status, 404);
  assert.equal((await pool.query("SELECT 1 FROM rx_entries WHERE confidential_enc LIKE '%Peanuts%'")).rowCount, 0, 'stored encrypted');
  // a duplicate live registration for the same person is refused; the code is used up
  assert.equal((await api('POST', `/registration-programmes/${p.id}/entries`, { token: a.token, body: { answers: {} } })).status, 409);
  // quota: only one under-12 place
  const sign = async (who, en) => must(await api('POST', `/registration-entries/${en.id}/signatures`, { token: who.token, body: { waiver_key: 'photo', signature: 'X Person', accept: true } }), 201);
  let eb = await start(b, p, { answers: { group: 'adult', allergy: false }, codes: ['FRIENDS'] }); await sign(b, eb); eb = await get(b, eb);
  assert.equal((await submit(b, eb)).status, 409, 'FRIENDS had max_uses 1 and is used up');
  eb = must(await api('PATCH', `/registration-entries/${eb.id}`, { token: b.token, body: { row_version: eb.row_version, codes: [], answers: { group: 'under12', allergy: false } } }));
  const subB = must(await submit(b, eb)); assert.equal(subB.status, 'submitted');
  // programme is now full (2 seats) → the third goes to the waiting list
  let ec = await start(c, p, { answers: { group: 'adult', allergy: false } }); await sign(c, ec); ec = await get(c, ec);
  const subC = must(await submit(c, ec)); assert.equal(subC.status, 'waitlisted');
  assert.equal(subC.instalments.length, 0, 'no charge while waitlisted');
  assert.equal(must(await api('GET', `/registration-programmes/${p.id}`, { token: org.token })).availability.waitlisted, 1);
  // staff decision flow with optimistic concurrency, reasons and notifications
  const sa = await get(org, sub);
  assert.equal((await decide(org, { ...sa, row_version: sa.row_version - 1 }, 'approve')).status, 409);
  assert.equal((await decide(org, sa, 'reject')).status, 400, 'a rejection needs a reason');
  const approved = must(await decide(org, sa, 'approve', 'Welcome'));
  assert.equal(approved.status, 'approved');
  // withdrawing frees a seat for the waiting list; the history keeps everything
  const wb = must(await api('POST', `/registration-entries/${subB.id}/withdraw`, { token: b.token, body: { row_version: (await get(b, subB)).row_version, reason: 'Moved away' } }));
  assert.equal(wb.status, 'withdrawn');
  const cNow = await get(c, ec);
  assert.equal(cNow.status, 'submitted', 'promoted off the waiting list'); assert.equal(cNow.instalments.length, 1);
  assert.deepEqual((await get(c, ec)).history.map((h) => h.action), ['drafted', 'signed', 'waitlisted', 'promoted']);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='registration'", [c.id])).rowCount >= 1);
  await assert.rejects(pool.query("UPDATE rx_history SET action='x'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM rx_signatures'), /append-only/);
  // change request: nothing changes until staff approve
  const ch = must(await api('POST', `/registration-entries/${approved.id}/changes`, { token: a.token, body: { answers: { allergy: false }, reason: 'No allergy after all' } }), 201);
  assert.equal((await get(a, approved)).answers.allergy, true);
  assert.equal((await api('POST', `/registration-changes/${ch.id}/decision`, { token: a.token, body: { approve: true } })).status, 404, 'only staff decide');
  must(await api('POST', `/registration-changes/${ch.id}/decision`, { token: org.token, body: { approve: true } }));
  assert.equal((await get(a, approved)).answers.allergy, false);
  // pay an instalment through canonical payments + finance
  const inst1 = (await get(a, approved)).instalments[0];
  const d = await describePurpose(pool, 'registration_instalment', inst1.id);
  assert.equal(d.amount, 12500); assert.equal(d.payerId, a.id); assert.equal(d.payable, true);
  const pay = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','registration_instalment',$2,12500,'GBP','pending','rx1') RETURNING id", [a.id, inst1.id])).rows[0];
  await settle(pay.id, { paid: true, amount: 12500, currency: 'GBP', paymentRef: 'pi_rx1' });
  await settle(pay.id, { paid: true, amount: 12500, currency: 'GBP', paymentRef: 'pi_rx1' });
  const after = await get(a, approved);
  assert.equal(after.instalments[0].status, 'paid'); assert.equal(after.instalments[1].status, 'unpaid');
  assert.equal(Number((await pool.query("SELECT count(*) FROM fin_transactions WHERE source_type='registration_instalment' AND kind='payment'")).rows[0].count), 1);
  assert.equal((await pool.query("SELECT source_module FROM fin_transactions WHERE source_type='registration_instalment' LIMIT 1")).rows[0].source_module, 'registration');
  // staff list + CSV export are audited and carry no answers
  const list = must(await api('GET', `/registration-programmes/${p.id}/entries`, { token: org.token }));
  assert.equal(list.length, 3); assert.equal((await api('GET', `/registration-programmes/${p.id}/entries`, { token: a.token })).status, 404);
  const csv = must(await api('GET', `/registration-programmes/${p.id}/export`, { token: org.token }));
  assert.ok(csv.csv.includes('RX-') && !csv.csv.includes('Peanuts'));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export_registration_entries'")).rowCount >= 1);
  // closing and the deadline
  must(await api('POST', `/registration-programmes/${p.id}/status`, { token: org.token, body: { status: 'closed' } }));
  assert.equal((await api('POST', `/registration-programmes/${p.id}/entries`, { token: stranger.token, body: {} })).status, 409);
});

test('scenario 2 — membership for a dependent: guardian registers a child, a guardian must sign, consent is enforced, household list', async () => {
  const org = await signup(['organizer']), mum = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(12) }), stranger = await signup();
  const p = await programme(org, { kind: 'membership', title: 'Junior membership' }, {
    form: form(text('school', 'School')), fees: { items: [{ key: 'm', label: 'Membership', amount_cents: 5000 }] },
    waivers: [{ key: 'safeguard', title: 'Safeguarding consent', body: 'I consent.', required: true, guardian_required: true }],
  });
  await open(org, p);
  assert.equal((await api('POST', `/registration-programmes/${p.id}/entries`, { token: mum.token, body: { participant_id: kid.id, answers: {} } })).status, 404, 'not a guardian yet');
  const l = must(await api('POST', '/youth/guardian-links', { token: mum.token, body: { guardian_id: mum.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: mum.token, body: { evidence: { reference: 'https://example.com/ref-1', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  const household = must(await api('GET', '/me/registration-participants', { token: mum.token }));
  assert.deepEqual(household.map((h) => h.relation), ['self', 'dependent']); assert.equal(household[1].consent_ok, false);
  assert.equal((await api('POST', `/registration-programmes/${p.id}/entries`, { token: mum.token, body: { participant_id: kid.id, answers: {} } })).status, 409, 'needs guardian consent first');
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'participation' } }), 201);
  let e = await start(mum, p, { participant_id: kid.id, answers: { school: 'Hill Primary' } });
  assert.equal(e.participant_id, kid.id); assert.equal(e.submitted_by, mum.id);
  // the child cannot sign the guardian's waiver; the guardian can
  assert.equal((await api('POST', `/registration-entries/${e.id}/signatures`, { token: kid.token, body: { waiver_key: 'safeguard', signature: 'Kid', accept: true } })).status, 403);
  assert.equal(must(await api('POST', `/registration-entries/${e.id}/signatures`, { token: mum.token, body: { waiver_key: 'safeguard', signature: 'Mum Parent', accept: true } }), 201).signer_role, 'guardian');
  e = await get(mum, e);
  const sub = must(await submit(mum, e)); assert.equal(sub.status, 'submitted');
  assert.equal((await get(kid, e)).id, e.id, 'the child can see their own registration');
  assert.equal((await api('GET', `/registration-entries/${e.id}`, { token: stranger.token })).status, 404);
  // revoking consent makes the child a protected participant in the organiser's list
  assert.equal(must(await api('GET', `/registration-programmes/${p.id}/entries`, { token: org.token }))[0].participant_name, kid.display_name);
  must(await api('DELETE', `/youth/children/${kid.id}/consents/participation`, { token: mum.token }));
  assert.equal(must(await api('GET', `/registration-programmes/${p.id}/entries`, { token: org.token }))[0].participant_name, 'Protected participant');
  assert.equal(must(await api('GET', '/me/registration-entries', { token: mum.token })).length, 1);
});

test('scenario 3 — competition: the #477 eligibility decision gates approval; same entry, no second registry', async () => {
  const org = await signup(['organizer']), mgr = await signup(), pl = await signup();
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Bats ${++n}`, sport: 'cricket' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Cup ${n}`, sport: 'cricket', starts_on: day(5), ends_on: day(30) } }), 201);
  const en = must(await api('POST', `/events/${ev.id}/entries`, { token: mgr.token, body: { team_id: team.id } }), 201);
  must(await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }));
  must(await api('POST', `/teams/${team.id}/members`, { token: mgr.token, body: { user_id: pl.id } }), 201);
  assert.equal((await api('POST', '/registration-programmes', { token: org.token, body: { kind: 'competition', title: 'No event' } })).status, 400);
  assert.equal((await api('POST', '/registration-programmes', { token: mgr.token, body: { kind: 'competition', title: 'Not mine', event_id: ev.id } })).status, 404, 'only the organiser can run it');
  const p = await programme(org, { kind: 'competition', title: 'Cup 2026', event_id: ev.id }, { form: form({ key: 'shirt', label: 'Shirt size', type: 'choice', required: true, options: [{ value: 'm', label: 'M' }, { value: 'l', label: 'L' }] }) });
  assert.equal(p.check_eligibility, true);
  assert.equal((await api('POST', `/registration-programmes/${p.id}/status`, { token: org.token, body: { status: 'open' } })).status, 409, 'needs an eligibility policy first');
  must(await api('POST', `/events/${ev.id}/registration/policy`, { token: org.token, body: { rules: { required_clearances: ['licence'] }, expected_version: 0 } }), 201);
  await open(org, p);
  assert.equal((await api('POST', `/registration-programmes/${p.id}/entries`, { token: pl.token, body: { answers: { shirt: 'm' } } })).status, 400, 'pick a team');
  let e = await start(mgr, p, { participant_id: pl.id, team_id: team.id, answers: { shirt: 'm' } });
  const sub = must(await submit(mgr, e)); assert.equal(sub.eligibility.decision, 'ineligible');
  const blocked = await decide(org, await get(org, sub), 'approve'); assert.equal(blocked.status, 409); assert.equal(blocked.body.error.details.code, 'not_eligible');
  must(await api('POST', `/events/${ev.id}/registration/dependencies`, { token: org.token, body: { user_id: pl.id, kind: 'licence', status: 'clear' } }), 201);
  const ok = must(await decide(org, await get(org, sub), 'approve'));
  assert.equal(ok.status, 'approved'); assert.equal(ok.eligibility.decision, 'eligible');
  assert.ok(ok.eligibility.checks.length >= 1);
  assert.equal((await get(mgr, ok)).eligibility.checks.every((c) => !('source' in c)), true, 'managers see rule, status and reason only');
  // a player who is not on the team cannot be registered for it
  const outsider = await signup();
  assert.equal((await api('POST', `/registration-programmes/${p.id}/entries`, { token: mgr.token, body: { participant_id: outsider.id, team_id: team.id, answers: { shirt: 'l' } } })).status, 400);
});

test('scenario 4 — team registration, and scenario 5 — federation licence with uploads and confidential answers', async () => {
  const org = await signup(['organizer']), mgr = await signup(), other = await signup(), ath = await signup();
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Owls ${++n}`, sport: 'cricket' } }), 201);
  const tp = await programme(org, { kind: 'team', title: 'League entry', sport: 'cricket', capacity: 1, waitlist: false, needs_approval: false }, { form: form(text('captain', 'Captain name')), fees: { items: [{ key: 'f', label: 'Entry fee', amount_cents: 10000 }] } });
  await open(org, tp);
  assert.equal((await api('POST', `/registration-programmes/${tp.id}/entries`, { token: other.token, body: { team_id: team.id, answers: {} } })).status, 404, 'only the team manager');
  let e = await start(mgr, tp, { team_id: team.id, answers: { captain: 'Sam' } });
  assert.equal(e.participant_id, null);
  const sub = must(await submit(mgr, e)); assert.equal(sub.status, 'approved', 'no approval needed → confirmed at once');
  assert.equal(sub.team_name, team.name);
  const team2 = must(await api('POST', '/teams', { token: other.token, body: { name: `Bees ${++n}`, sport: 'cricket' } }), 201);
  const e2 = await start(other, tp, { team_id: team2.id, answers: { captain: 'Kim' } });
  const full = await submit(other, e2); assert.equal(full.status, 409); assert.equal(full.body.error.details.code, 'programme_full', 'no waiting list → refused');
  assert.equal((await api('POST', `/registration-programmes/${tp.id}/entries`, { token: mgr.token, body: { team_id: team.id, answers: {} } })).status, 409, 'one live registration per team');

  const lp = await programme(org, { kind: 'licence', title: 'Coach licence' }, { form: form(text('idno', 'ID number', { confidential: true }), { key: 'proof', label: 'Proof of qualification', type: 'file', required: true, max_files: 1 }) });
  await open(org, lp);
  let le = await start(ath, lp, { answers: { idno: 'ABC-12345' } });
  assert.equal((await submit(ath, le)).status, 400, 'the upload is required');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const up = async (tok, id) => fetch(`${base}/api/v1/registration-entries/${id}/files?field=proof&name=proof.png`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/octet-stream' }, body: png });
  assert.equal((await up(other.token, le.id)).status, 404, 'a stranger cannot upload');
  const r1 = await up(ath.token, le.id); assert.equal(r1.status, 201); const file = await r1.json();
  assert.equal((await up(ath.token, le.id)).status, 400, 'max one file');
  le = await get(ath, le);
  const ls = must(await submit(ath, le)); assert.equal(ls.status, 'submitted'); assert.equal(ls.files.length, 1);
  const dl = await fetch(`${base}/api/v1/registration-files/${file.id}`, { headers: { authorization: `Bearer ${org.token}` } });
  assert.equal(dl.status, 200); assert.deepEqual(Buffer.from(await dl.arrayBuffer()), png);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_registration_file'")).rowCount >= 1, 'staff reads are audit-logged');
  assert.equal((await fetch(`${base}/api/v1/registration-files/${file.id}`, { headers: { authorization: `Bearer ${other.token}` } })).status, 404);
  // sent back for more information, corrected and resubmitted; the history shows it all
  const back = must(await decide(org, await get(org, ls), 'request_info', 'Please re-upload a clearer copy'));
  assert.equal(back.status, 'info_requested');
  assert.equal(must(await api('DELETE', `/registration-files/${file.id}`, { token: ath.token })).removed, true);
  assert.equal((await up(ath.token, le.id)).status, 201);
  const again = must(await submit(ath, await get(ath, le)));
  assert.equal(again.status, 'submitted');
  assert.deepEqual(again.history.map((h) => h.action), ['drafted', 'submitted', 'info_requested', 'resubmitted']);
  assert.ok(again.history.find((h) => h.action === 'info_requested').note.includes('clearer'));
  const rej = must(await decide(org, await get(org, again), 'reject', 'Qualification not recognised'));
  assert.equal(rej.status, 'rejected');
  // a rejected applicant can apply again (the rejection is on record, the slot is free)
  assert.equal((await api('POST', `/registration-programmes/${lp.id}/entries`, { token: ath.token, body: { answers: { idno: 'ABC-12345' } } })).status, 201);
});

test('framework: seven kinds, versions, API/OpenAPI/MCP parity, authorization', async () => {
  const org = await signup(['organizer']), other = await signup();
  assert.deepEqual(KINDS, ['athlete', 'team', 'event', 'competition', 'membership', 'course', 'licence']);
  for (const kind of KINDS.filter((k) => k !== 'competition')) must(await api('POST', '/registration-programmes', { token: org.token, body: { kind, title: `Kind ${kind}` } }), 201);
  const p = await programme(org, { kind: 'athlete', title: 'Versions' }, { form: form(text('a', 'A')) });
  assert.equal((await api('POST', `/registration-programmes/${p.id}/versions`, { token: org.token, body: { expected_version: 0, form: form(text('a', 'A')) } })).status, 409, 'stale version');
  assert.equal((await api('POST', `/registration-programmes/${p.id}/versions`, { token: other.token, body: { expected_version: 1, form: form(text('a', 'A')) } })).status, 404);
  assert.equal((await api('POST', `/registration-programmes/${p.id}/versions`, { token: org.token, body: { expected_version: 1, form: { sections: [{ id: 's', title: 'S', fields: [{ key: 'b', label: 'Budget', type: 'budget' }] }] } } })).status, 400, 'sponsorship-only blocks are refused');
  await open(org, p);
  // an old draft follows the new version; a submitted entry keeps the one it was filled under
  const e = await start(other, p, { answers: { a: 'x' } });
  must(await api('POST', `/registration-programmes/${p.id}/versions`, { token: org.token, body: { expected_version: 1, form: form(text('a', 'A'), text('b', 'B')) } }), 201);
  assert.equal((await submit(other, e)).body.error.details.code, 'stale_form_version');
  const moved = must(await api('PATCH', `/registration-entries/${e.id}`, { token: other.token, body: { row_version: e.row_version, answers: { a: 'x', b: 'y' } } }));
  assert.equal(moved.version, 2);
  assert.equal(must(await submit(other, moved)).version, 2);
  assert.equal((await api('POST', `/registration-programmes/${p.id}/status`, { token: org.token, body: { status: 'archived' } })).status, 409, 'undecided entries block archiving');
  // capacity cannot drop below held seats
  const cur = must(await api('GET', `/registration-programmes/${p.id}`, { token: org.token }));
  assert.equal((await api('PATCH', `/registration-programmes/${p.id}`, { token: org.token, body: { row_version: cur.row_version, capacity: 1 } })).status, 200);
  const cur2 = must(await api('GET', `/registration-programmes/${p.id}`, { token: org.token }));
  assert.equal((await api('PATCH', `/registration-programmes/${p.id}`, { token: org.token, body: { row_version: cur2.row_version, capacity: 1, title: 'x'.repeat(1) } })).status, 400);
  const tools = (await rpc('tools/list', {}, org.token)).tools.map((t) => t.name);
  for (const t of ['create_registration_programme', 'publish_registration_version', 'submit_registration_entry', 'decide_registration_entry', 'quote_registration', 'sign_registration_waiver', 'list_registration_programmes']) assert.ok(tools.includes(t), `${t} is an MCP tool`);
  const called = await rpc('tools/call', { name: 'list_registration_programmes', arguments: { scope: 'managed' } }, org.token);
  assert.ok(!called.isError);
  const doc = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(doc.paths['/registration-programmes/{id}/entries'] && doc.paths['/registration-entries/{id}/submit']);
  assert.equal((await api('GET', '/registration-programmes')).status, 401);
});
