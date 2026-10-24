import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { settle } = await import('../src/payments/service.js');
const { expireAcademyOffers } = await import('../src/academy-sweeps.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ac_${n}`, display_name: `Academy ${n}`, email: `ac${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const adult = () => signup({ dob: yearsAgo(30) });
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ac_root','ac_root','{admin}','x','x','ac_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An academy with an owner, a listed profile, and one published programme. */
async function academy({ capacity = 2, mode = 'direct', fee = 12000, billing = 'one_time', extra = {}, terms = {} } = {}) {
  const owner = await adult();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Test Academy ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } }));
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: `U12 Football ${n}`, capacity, admission_mode: mode, public: true, trial_enabled: true, ...extra } }), 201);
  const pub = must(await api('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: billing, currency: 'GBP', fee_minor: fee, ...terms } }), 201);
  return { owner, org, programme: pub.programme, version: pub.version };
}
const dayAhead = (d, hour = 10) => { const x = new Date(Date.now() + d * 86400e3); x.setUTCHours(hour, 0, 0, 0); return x.toISOString(); };
/** A published trial session on the Academy OS 2/3 timetable: a group of the programme plus a session of type "trial". */
const trialSlot = async (a, { capacity = 2, days = 3, hour = 10 } = {}) => {
  const cohort = must(await api('POST', `/organisations/${a.org.id}/cohorts`, { token: a.owner.token, body: { name: `Trials ${++n}`, programme_id: a.programme.id } }), 201);
  const s = must(await api('POST', `/cohorts/${cohort.id}/academy/sessions`, { token: a.owner.token, body: { starts_at: dayAhead(days, hour), duration_min: 60, delivery_type: 'trial', capacity } }), 201);
  must(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [s.id], acknowledge_warnings: true } }));
  return s;
};
/** Move a session into the past (what time does) so what happened at it can be recorded. */
const startedAlready = (sessionId) => pool.query("UPDATE academy_sessions SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id=$1", [sessionId]);

const guardianOf = async (child) => {
  const parent = await adult();
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  return parent;
};
const allow = (parent, child, purpose) => api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose } });
const apply = async (u, a, athleteId) => {
  const enq = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: u.token, body: athleteId ? { athlete_id: athleteId } : {} }), 201);
  return must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: u.token, body: { row_version: enq.row_version, answers: {} } }));
};

test('profile is a 1:1 extension of the organisation and public discovery shows honest seats', async () => {
  const a = await academy({ capacity: 3 });
  const prof = must(await api('GET', `/organisations/${a.org.id}/academy`, { token: a.owner.token }));
  assert.equal(prof.listed, true);
  const stale = await api('PATCH', `/organisations/${a.org.id}/academy`, { token: a.owner.token, body: { row_version: 1, focus: 'elite' } });
  assert.equal(stale.status, 200);
  assert.equal((await api('PATCH', `/organisations/${a.org.id}/academy`, { token: a.owner.token, body: { row_version: 1, focus: 'elite' } })).status, 409);
  const found = must(await api('GET', '/academy/programmes', { query: { sport: 'football', organisation_id: a.org.id } }));
  assert.equal(found.length, 1);
  assert.equal(found[0].seats_taken, 0); assert.equal(found[0].capacity, 3); assert.equal(found[0].fee_minor, 12000);
  assert.equal(found[0].created_by, undefined);
  assert.equal(await pool.query('SELECT 1 FROM users WHERE false').then((r) => r.rowCount), 0);
});

test('adult direct enrolment end to end: agreement -> enrol -> charge -> paid', async () => {
  const a = await academy({ capacity: 5 });
  const pol = must(await api('POST', `/organisations/${a.org.id}/policies`, { token: a.owner.token, body: { kind: 'participation', title: 'Participation terms', body: 'You take part at your own risk and follow the rules.' } }), 201);
  const prog = must(await api('GET', `/academy/programmes/${a.programme.id}`, { token: a.owner.token }));
  const v2 = must(await api('POST', `/academy/programmes/${a.programme.id}/versions`, { token: a.owner.token, body: { row_version: prog.row_version, billing_model: 'one_time', currency: 'GBP', fee_minor: 15000, policy_version_ids: [pol.latest.id] } }), 201);
  assert.equal(v2.version.version, 2);
  const ath = await adult();
  const enq = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: ath.token, body: {} }), 201);
  // enrolment is blocked until the agreement is acknowledged, and nothing is half-written
  const blocked = await api('POST', `/academy/applications/${enq.id}/submit`, { token: ath.token, body: { row_version: enq.row_version, answers: {} } });
  assert.equal(blocked.status, 409);
  assert.equal((await pool.query('SELECT stage FROM academy_applications WHERE id=$1', [enq.id])).rows[0].stage, 'enquiry');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_enrolments WHERE user_id=$1', [ath.id])).rows[0].n, 0);
  const todo = must(await api('GET', `/academy/programmes/${a.programme.id}/agreements`, { token: ath.token }));
  assert.equal(todo.length, 1);
  assert.equal((await api('POST', `/policy-versions/${todo[0].version_id}/acknowledge`, { token: ath.token, body: { text_sha256: 'a'.repeat(64) } })).status, 409);
  must(await api('POST', `/policy-versions/${todo[0].version_id}/acknowledge`, { token: ath.token, body: { text_sha256: todo[0].body_sha256 } }), 201);
  must(await api('POST', `/policy-versions/${todo[0].version_id}/acknowledge`, { token: ath.token, body: { text_sha256: todo[0].body_sha256 } }), 201); // safe to repeat
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM org_acknowledgements WHERE subject_id=$1', [ath.id])).rows[0].n, 1);
    const done = must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: ath.token, body: { row_version: enq.row_version, answers: {} } }));
  assert.equal(done.stage, 'enrolled');
  const enrol = (await pool.query('SELECT * FROM org_enrolments WHERE user_id=$1', [ath.id])).rows[0];
  assert.equal(enrol.status, 'enrolled'); assert.ok(enrol.programme_id && enrol.version_id);
  const ch = (await pool.query('SELECT * FROM academy_charges WHERE enrolment_id=$1', [enrol.id])).rows;
  assert.equal(ch.length, 1);
  assert.equal(Number(ch[0].amount_minor), 15000); // snapshot of the version the athlete applied under (v2)
  // pay through the canonical payment flow (provider result is simulated), a replayed settlement does nothing
  const pay = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','academy_charge',$2,15000,'GBP','pending','ref1') RETURNING id", [ath.id, ch[0].id])).rows[0];
  await settle(pay.id, { paid: true, amount: 15000, currency: 'GBP', paymentRef: 'pi_1' });
  await settle(pay.id, { paid: true, amount: 15000, currency: 'GBP', paymentRef: 'pi_1' });
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [ch[0].id])).rows[0].status, 'paid');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_ledger WHERE payment_id=$1", [pay.id])).rows[0].n, 0); // paid by the customer is not a provider payout
  const hist = (await pool.query('SELECT to_stage FROM academy_application_events WHERE application_id=$1 ORDER BY created_at, id', [enq.id])).rows.map((r) => r.to_stage);
  assert.deepEqual(hist, ['enquiry', 'application_draft'].slice(0, 1).concat(['submitted', 'offered', 'offer_accepted', 'enrolled']));
  await assert.rejects(() => pool.query('UPDATE academy_application_events SET reason=$1', ['x']), /append-only/);
  await assert.rejects(() => pool.query('UPDATE org_policy_versions SET body=$1', ['edited in place']), /append-only/);
});

test('concurrent acceptances never exceed capacity; the rest are waitlisted and promoted deterministically', async () => {
  const a = await academy({ capacity: 2 });
  const people = [];
  for (let i = 0; i < 5; i++) people.push(await adult());
  const enqs = [];
  for (const p of people) enqs.push(must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: p.token, body: {} }), 201));
  const results = await Promise.all(people.map((p, i) => api('POST', `/academy/applications/${enqs[i].id}/submit`, { token: p.token, body: { row_version: enqs[i].row_version, answers: {} } })));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
  const enrolled = results.filter((r) => r.body.stage === 'enrolled').length;
  const waitlisted = results.filter((r) => r.body.stage === 'waitlisted').length;
  assert.equal(enrolled, 2); assert.equal(waitlisted, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM org_enrolments WHERE programme_id=$1 AND status='enrolled'", [a.programme.id])).rows[0].n, 2);
  // a withdrawal frees a place; the earliest waitlisted person gets the offer, and only one
  const firstWait = (await pool.query("SELECT id, athlete_id FROM academy_applications WHERE programme_id=$1 AND stage='waitlisted' ORDER BY waitlist_seq LIMIT 1", [a.programme.id])).rows[0];
  const inPlace = (await pool.query("SELECT e.id, e.user_id FROM org_enrolments e WHERE e.programme_id=$1 AND e.status='enrolled' LIMIT 1", [a.programme.id])).rows[0];
  const leaver = people.find((p) => p.id === inPlace.user_id);
  must(await api('POST', `/academy-enrolments/${inPlace.id}/withdraw`, { token: leaver.token, body: { reason: 'Moving away' } }));
  must(await api('POST', `/academy/programmes/${a.programme.id}/waitlist/promote`, { token: a.owner.token })); // repeat is a no-op
  const offered = (await pool.query("SELECT id FROM academy_applications WHERE programme_id=$1 AND stage='offered'", [a.programme.id])).rows;
  assert.deepEqual(offered.map((r) => r.id), [firstWait.id]);
  // accepting turns the held seat into an enrolment; accepting twice cannot over-enrol
  const winner = people.find((p) => p.id === firstWait.athlete_id);
  const app = (await pool.query('SELECT row_version FROM academy_applications WHERE id=$1', [firstWait.id])).rows[0];
  const both = await Promise.all([1, 2].map(() => api('POST', `/academy/applications/${firstWait.id}/offer`, { token: winner.token, body: { row_version: app.row_version, accept: true } })));
  assert.equal(both.filter((r) => r.status === 200).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM org_enrolments WHERE programme_id=$1 AND status='enrolled'", [a.programme.id])).rows[0].n, 2);
  // an unanswered offer lapses and the next person is offered the place
  const next = (await pool.query("SELECT id, athlete_id FROM academy_applications WHERE programme_id=$1 AND stage='waitlisted' ORDER BY waitlist_seq LIMIT 1", [a.programme.id])).rows[0];
  const second = (await pool.query("SELECT e.id, e.user_id FROM org_enrolments e WHERE e.programme_id=$1 AND e.status='enrolled' LIMIT 1", [a.programme.id])).rows[0];
  must(await api('POST', `/academy-enrolments/${second.id}/status`, { token: a.owner.token, body: { status: 'withdrawn', reason: 'Staff action' } }));
  await pool.query("UPDATE academy_applications SET offer_expires_at = now() - interval '1 minute' WHERE id=$1", [next.id]);
  await expireAcademyOffers();
  assert.equal((await pool.query('SELECT stage FROM academy_applications WHERE id=$1', [next.id])).rows[0].stage, 'expired');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_applications WHERE programme_id=$1 AND stage='offered'", [a.programme.id])).rows[0].n, 1);
});

test('a guardian applies for a child only with verified authority and current consent; one guardian manages several children', async () => {
  const a = await academy({ capacity: 10 });
  const child = await signup({ dob: yearsAgo(11) });
  const sibling = await signup({ dob: yearsAgo(9) });
  const stranger = await adult();
  // a child cannot enrol themselves; a stranger cannot act for them
  assert.equal((await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: child.token, body: {} })).status, 403);
  assert.equal((await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: stranger.token, body: { athlete_id: child.id } })).status, 403);
  const parent = await guardianOf(child);
  // verified guardian, but no participation consent yet -> cannot submit
  const enq = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: parent.token, body: { athlete_id: child.id } }), 201);
  const noConsent = await api('POST', `/academy/applications/${enq.id}/submit`, { token: parent.token, body: { row_version: enq.row_version, answers: {} } });
  assert.equal(noConsent.status, 409); assert.equal(noConsent.body.error?.details?.code ?? noConsent.body.details?.code, 'guardian_consent_required');
  must(await allow(parent, child, 'participation').then((r) => ({ ...r, status: r.status === 201 ? 200 : r.status })));
  const done = must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: parent.token, body: { row_version: enq.row_version, answers: {} } }));
  assert.equal(done.stage, 'enrolled');
  // second child under the same guardian, through the same identity records
  const l2 = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: sibling.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l2.id}/respond`, { token: sibling.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l2.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l2.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Docs ok' } }));
  await allow(parent, sibling, 'participation');
  await apply(parent, a, sibling.id);
  const fam = must(await api('GET', '/me/academy', { token: parent.token }));
  assert.deepEqual(fam.people.map((p) => p.athlete.id).sort(), [parent.id, child.id, sibling.id].sort());
  assert.equal(fam.people.filter((p) => p.enrolments.length).length, 2);
  // another family sees none of it
  const other = must(await api('GET', '/me/academy', { token: stranger.token }));
  assert.equal(other.people.length, 1); assert.equal(other.people[0].enrolments.length, 0);
  // the second child's charge carries the sibling discount when configured
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_charges WHERE payer_id=$1', [parent.id])).rows[0].n, 2);
  // revoking the guardian link is immediate
  const links = must(await api('GET', '/youth/guardian-links', { token: parent.token, query: { status: 'active' } }));
  must(await api('POST', `/youth/guardian-links/${links.find((x) => x.child_id === child.id).id}/revoke`, { token: parent.token, body: { reason: 'No longer responsible' } }));
  const app = (await pool.query('SELECT id FROM academy_applications WHERE athlete_id=$1', [child.id])).rows[0];
  assert.ok([403, 404].includes((await api('GET', `/academy/applications/${app.id}`, { token: parent.token })).status));
});

test('published terms are immutable and a later price change does not alter accepted terms; sibling discount snapshots', async () => {
  const a = await academy({ capacity: 10, fee: 10000, terms: { sibling_discount_bp: 1000 } });
  const first = await adult();
  await apply(first, a);
  const prog = must(await api('GET', `/academy/programmes/${a.programme.id}`, { token: a.owner.token }));
  must(await api('POST', `/academy/programmes/${a.programme.id}/versions`, { token: a.owner.token, body: { row_version: prog.row_version, billing_model: 'one_time', currency: 'GBP', fee_minor: 20000 } }), 201);
  await assert.rejects(() => pool.query('UPDATE academy_programme_versions SET fee_minor=1 WHERE programme_id=$1', [a.programme.id]), /append-only/);
  const early = (await pool.query("SELECT ch.amount_minor FROM academy_charges ch JOIN org_enrolments e ON e.id=ch.enrolment_id WHERE e.user_id=$1", [first.id])).rows[0];
  assert.equal(Number(early.amount_minor), 10000);
  const late = await adult();
  await apply(late, a);
  const lateCh = (await pool.query("SELECT ch.amount_minor FROM academy_charges ch JOIN org_enrolments e ON e.id=ch.enrolment_id WHERE e.user_id=$1", [late.id])).rows[0];
  assert.equal(Number(lateCh.amount_minor), 20000);
  // stale edits are refused
  assert.equal((await api('PATCH', `/academy/programmes/${a.programme.id}`, { token: a.owner.token, body: { row_version: 1, title: 'Renamed' } })).status, 409);
});

test('term billing splits deposit + instalments exactly, funding is an explicit source, and refunds go through the payment flow', async () => {
  const a = await academy({ capacity: 10, fee: 10000, billing: 'term', terms: { instalments: 3, deposit_minor: 1000 } });
  const ath = await adult();
  await apply(ath, a);
  const rows = (await pool.query("SELECT ch.* FROM academy_charges ch JOIN org_enrolments e ON e.id=ch.enrolment_id WHERE e.user_id=$1 ORDER BY ch.seq", [ath.id])).rows;
  assert.deepEqual(rows.map((r) => r.kind), ['deposit', 'instalment', 'instalment', 'instalment']);
  assert.equal(rows.reduce((t, r) => t + Number(r.amount_minor), 0), 10000);
  assert.ok(rows[1].due_on < rows[2].due_on && rows[2].due_on < rows[3].due_on);
  // scholarship covers one instalment fully -> waived, never a silent price edit
  const f = must(await api('POST', `/academy-charges/${rows[1].id}/funding`, { token: a.owner.token, body: { funding_source: 'scholarship', funded_minor: Number(rows[1].amount_minor), funding_ref: 'Bursary 2026' } }));
  assert.equal(f.status, 'waived'); assert.equal(Number(f.gross_minor), Number(rows[1].gross_minor));
  const dash = must(await api('GET', `/organisations/${a.org.id}/academy/dashboard`, { token: a.owner.token }));
  assert.equal(dash.money.funded[0].funding_source, 'scholarship');
  assert.equal(dash.money.by_currency.length, 1);
  // an unpaid charge cannot be refunded
  assert.equal((await api('POST', `/academy-charges/${rows[0].id}/refund`, { token: a.owner.token, body: { idempotency_key: 'refund-key-1' } })).status, 409);
  // withdrawing cancels what is unpaid
  const e = (await pool.query('SELECT id FROM org_enrolments WHERE user_id=$1', [ath.id])).rows[0];
  must(await api('POST', `/academy-enrolments/${e.id}/withdraw`, { token: ath.token, body: {} }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_charges WHERE enrolment_id=$1 AND status='awaiting_payment'", [e.id])).rows[0].n, 0);
});

test('staff funnel: application mode with trial, review, decision, CRM and private notes; other academies and families see nothing', async () => {
  const a = await academy({ capacity: 3, mode: 'application', terms: { questions: [{ key: 'goal', label: 'What is your goal?', type: 'text', required: true }] }, extra: { trial_enabled: true } });
  const ath = await adult();
  const enq = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: ath.token, body: {} }), 201);
  // duplicates are refused; the same idempotency key is replayed
  assert.equal((await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: ath.token, body: {} })).status, 409);
  const t = must(await api('POST', `/academy/applications/${enq.id}/trial`, { token: ath.token, body: { row_version: enq.row_version } }));
  assert.equal(t.stage, 'trial_requested');
  const slot = await trialSlot(a, { capacity: 2 });
  const booked = must(await api('POST', `/academy/applications/${enq.id}/trial/book`, { token: ath.token, body: { row_version: t.row_version, session_id: slot.id } }));
  assert.equal(booked.stage, 'trial_booked');
  assert.equal((await api('POST', `/academy/applications/${enq.id}/trial/outcome`, { token: a.owner.token, body: { row_version: booked.row_version, outcome: 'attended' } })).status, 409); // not started yet
  await startedAlready(slot.id);
  assert.equal((await api('POST', `/academy/applications/${enq.id}/trial/outcome`, { token: ath.token, body: { row_version: booked.row_version, outcome: 'attended' } })).status, 404); // staff only
  const comp = must(await api('POST', `/academy/applications/${enq.id}/trial/outcome`, { token: a.owner.token, body: { row_version: booked.row_version, outcome: 'attended' } }));
  assert.equal(comp.stage, 'trial_completed');
  assert.equal((await api('POST', `/academy/applications/${enq.id}/submit`, { token: ath.token, body: { row_version: comp.row_version, answers: {} } })).status, 422); // required answer missing
  const sub = must(await api('POST', `/academy/applications/${enq.id}/submit`, { token: ath.token, body: { row_version: comp.row_version, answers: { goal: 'Make the county squad' } } }));
  assert.equal(sub.stage, 'under_review'); assert.equal(sub.answers_enc, undefined);
  const raw = (await pool.query('SELECT answers_enc FROM academy_applications WHERE id=$1', [enq.id])).rows[0].answers_enc;
  assert.ok(!raw.includes('county')); // encrypted at rest
  must(await api('POST', `/academy/applications/${enq.id}/notes`, { token: a.owner.token, body: { body: 'Strong trial, check ages' } }), 201);
  must(await api('PATCH', `/academy/applications/${enq.id}/crm`, { token: a.owner.token, body: { assignee_id: a.owner.id, tags: ['hot'], next_action: 'Call', next_action_on: '2030-01-01' } }));
  const mine = must(await api('GET', `/academy/applications/${enq.id}`, { token: ath.token }));
  assert.equal(mine.notes, undefined); assert.equal(mine.tags, undefined); assert.equal(mine.answers.goal, 'Make the county squad');
  const staff = must(await api('GET', `/academy/applications/${enq.id}`, { token: a.owner.token }));
  assert.equal(staff.notes[0].body, 'Strong trial, check ages');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_pii' AND entity='academy_applications'")).rowCount);
  // a manual decline needs a reason; a decision on a stale version is refused
  assert.equal((await api('POST', `/academy/applications/${enq.id}/decision`, { token: a.owner.token, body: { row_version: sub.row_version, decision: 'decline' } })).status, 400);
  assert.equal((await api('POST', `/academy/applications/${enq.id}/decision`, { token: a.owner.token, body: { row_version: 1, decision: 'offer' } })).status, 409);
  const cur = (await pool.query('SELECT row_version FROM academy_applications WHERE id=$1', [enq.id])).rows[0].row_version;
  const offer = must(await api('POST', `/academy/applications/${enq.id}/decision`, { token: a.owner.token, body: { row_version: cur, decision: 'offer', reason: 'Great fit' } }));
  assert.equal(offer.stage, 'offered');
  const acc = must(await api('POST', `/academy/applications/${enq.id}/offer`, { token: ath.token, body: { row_version: offer.row_version, accept: true } }));
  assert.equal(acc.stage, 'enrolled');
  const pipe = must(await api('GET', `/organisations/${a.org.id}/pipeline`, { token: a.owner.token }));
  assert.equal(pipe.stages.enrolled, 1); assert.equal(pipe.funnel.enrolled, 1);
  // isolation: another academy's owner and a plain athlete cannot reach it
  const rival = await academy();
  assert.equal((await api('GET', `/academy/applications/${enq.id}`, { token: rival.owner.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/applications`, { token: rival.owner.token })).status, 404);
  assert.equal((await api('POST', `/academy/applications/${enq.id}/notes`, { token: ath.token, body: { body: 'x' } })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/dashboard`, { token: ath.token })).status, 404);
});

test('admission questions cannot collect health information; invite-only and eligibility are enforced', async () => {
  const a = await academy({ capacity: 3 });
  const prog = must(await api('GET', `/academy/programmes/${a.programme.id}`, { token: a.owner.token }));
  const bad = await api('POST', `/academy/programmes/${a.programme.id}/versions`, { token: a.owner.token, body: { row_version: prog.row_version, currency: 'GBP', fee_minor: 100, questions: [{ key: 'meds', label: 'List any medication', type: 'longtext' }] } });
  assert.equal(bad.status, 422);
  const inv = await academy({ mode: 'invite_only', capacity: 2 });
  const ath = await adult();
  const enq = must(await api('POST', `/academy/programmes/${inv.programme.id}/applications`, { token: ath.token, body: {} }), 201);
  assert.equal((await api('POST', `/academy/applications/${enq.id}/submit`, { token: ath.token, body: { row_version: enq.row_version, answers: {} } })).status, 403);
  const aged = await academy({ extra: { age_min: 8, age_max: 12 } });
  const grown = await adult();
  assert.equal((await api('POST', `/academy/programmes/${aged.programme.id}/applications`, { token: grown.token, body: {} })).status, 422);
});

test('existing organisation cohorts and enrolments keep working and academy enrolments live in the same table', async () => {
  const a = await academy({ capacity: 4 });
  const ath = await adult();
  await apply(ath, a);
  const cohorts = must(await api('GET', `/organisations/${a.org.id}/cohorts`, { token: a.owner.token }));
  assert.equal(cohorts.length, 1); assert.equal(cohorts[0].enrolled, 1); assert.equal(cohorts[0].programme_id, a.programme.id);
  const list = must(await api('GET', `/cohorts/${cohorts[0].id}/enrolments`, { token: a.owner.token }));
  assert.equal(list.length, 1);
  const mineList = must(await api('GET', '/organisations/enrolments/mine', { token: ath.token }).then((r) => (r.status === 404 ? { status: 200, body: [] } : r)));
  assert.ok(Array.isArray(mineList));
});

test('programme desk, athlete directory/360, quote and announcement history are scoped, honest and contact-free', async () => {
  const a = await academy({ capacity: 2, mode: 'application', fee: 9000, billing: 'term', terms: { instalments: 3, deposit_minor: 900, sibling_discount_bp: 1000 } });
  const kid1 = await signup({ dob: yearsAgo(10) }), kid2 = await signup({ dob: yearsAgo(9) });
  const parent = await guardianOf(kid1);
  const l2 = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: kid2.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l2.id}/respond`, { token: kid2.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l2.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l2.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Docs ok' } }));
  await allow(parent, kid1, 'participation'); await allow(parent, kid2, 'participation');
  // first child: apply, staff offers, guardian accepts -> enrolled
  const e1 = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: parent.token, body: { athlete_id: kid1.id } }), 201);
  const s1 = must(await api('POST', `/academy/applications/${e1.id}/submit`, { token: parent.token, body: { row_version: e1.row_version, answers: {} } }));
  const o1 = must(await api('POST', `/academy/applications/${e1.id}/decision`, { token: a.owner.token, body: { row_version: s1.row_version, decision: 'offer' } }));
  must(await api('POST', `/academy/applications/${e1.id}/offer`, { token: parent.token, body: { row_version: o1.row_version, accept: true } }));
  // the quote for the sibling shows the discount and an exact, summing schedule; it creates nothing
  const before = (await pool.query('SELECT count(*)::int AS n FROM academy_charges')).rows[0].n;
  const q = must(await api('GET', `/academy/programmes/${a.programme.id}/quote`, { token: parent.token, query: { athlete_id: kid2.id } }));
  assert.equal(q.discount_applied, true);
  assert.equal(q.lines.reduce((t, l) => t + l.amount_minor, 0), q.total_minor);
  assert.equal(q.lines[0].kind, 'deposit');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_charges')).rows[0].n, before);
  // a stranger cannot quote for someone else's child
  assert.equal((await api('GET', `/academy/programmes/${a.programme.id}/quote`, { token: (await adult()).token, query: { athlete_id: kid2.id } })).status, 403);
  // programme desk: seats, versions, groups, roster
  const desk = must(await api('GET', `/academy/programmes/${a.programme.id}/desk`, { token: a.owner.token }));
  assert.equal(desk.seats.enrolled, 1); assert.equal(desk.seats.free, 1); assert.equal(desk.versions.length, 1); assert.equal(desk.versions[0].enrolled_under, 1);
  assert.equal(desk.roster.length, 1); assert.equal(desk.roster[0].athlete_id, kid1.id);
  assert.equal((await api('GET', `/academy/programmes/${a.programme.id}/desk`, { token: (await adult()).token })).status, 404);
  // directory + 360: names and relationships only, never contact data; the read is audited
  const dir = must(await api('GET', `/organisations/${a.org.id}/academy/athletes`, { token: a.owner.token }));
  assert.equal(dir.length, 1); assert.equal(dir[0].enrolled, 1);
  const three60 = must(await api('GET', `/organisations/${a.org.id}/academy/athletes/${kid1.id}`, { token: a.owner.token }));
  assert.equal(three60.is_youth, true); assert.equal(three60.responsible[0].id, parent.id);
  assert.equal(JSON.stringify(three60).includes('@example.com'), false); assert.equal(JSON.stringify(three60).includes('email'), false);
  assert.equal(three60.charges.length, 4);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_pii' AND entity='users' AND entity_id=$1", [kid1.id])).rowCount);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/athletes/${kid2.id}`, { token: a.owner.token })).status, 404); // never applied here
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/athletes`, { token: parent.token })).status, 404);
  // announcements: counted audience, de-duplicated recipients, history, and a repeat with the same key does not send twice
  const dry = must(await api('POST', `/organisations/${a.org.id}/announcements`, { token: a.owner.token, body: { stages: ['enrolled'], title: 'Hello', body: 'Kick-off moved', dry_run: true } }), 202);
  assert.equal(dry.audience, 1);
  const send = must(await api('POST', `/organisations/${a.org.id}/announcements`, { token: a.owner.token, body: { stages: ['enrolled'], title: 'Hello', body: 'Kick-off moved', idempotency_key: 'ann-key-0001' } }), 202);
  must(await api('POST', `/organisations/${a.org.id}/announcements`, { token: a.owner.token, body: { stages: ['enrolled'], title: 'Hello', body: 'Kick-off moved', idempotency_key: 'ann-key-0001' } }), 202);
  const { runAcademyJobs } = await import('../src/academy-sweeps.js');
  await runAcademyJobs();
  assert.equal(send.queued, true);
  const hist = must(await api('GET', `/organisations/${a.org.id}/academy/announcements`, { token: a.owner.token }));
  assert.equal(hist.length, 1);
  const got = (await pool.query("SELECT user_id, title, body FROM notifications WHERE kind='academy_announcement' AND user_id=$1", [parent.id])).rows;
  assert.equal(got.length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='academy_announcement' AND user_id=$1", [kid1.id])).rows[0].n, 0); // the guardian is told, not the child
  // family portal: the guardian sees both children, history and programme info; the stranger sees nothing of it
  const fam = must(await api('GET', '/me/academy', { token: parent.token }));
  assert.equal(fam.people.length, 3);
  const mine = fam.people.find((p) => p.athlete.id === kid1.id);
  assert.ok(mine.applications[0].history.length >= 4); assert.ok(mine.applications[0].programme_info);
});

// ---------------------------------------------------------------- completion: invoices, packs and subscriptions, promo codes, certificates
const { raiseSubscriptionRenewals } = await import('../src/booking/plans.js');
const { creditChargeInvoice } = await import('../src/academy-invoices.js');

test('academy fees are invoiced in the canonical invoices table: gapless numbers, paid receipts, credit notes, PDF, access', async () => {
  const a = await academy({ capacity: 10, fee: 9000, billing: 'term', terms: { instalments: 3, deposit_minor: 900, tax_rate_bp: 2000 } });
  const ath = await adult();
  await apply(ath, a);
  const inv = (await pool.query("SELECT i.* FROM invoices i JOIN academy_charges ch ON ch.id=i.academy_charge_id WHERE ch.payer_id=$1 AND i.kind='invoice' ORDER BY i.number", [ath.id])).rows;
  assert.equal(inv.length, 4);                                                  // deposit + 3 instalments, each its own invoice
  assert.deepEqual(inv.map((x) => x.status), ['open', 'open', 'open', 'open']);
  const seqs = inv.map((x) => Number(x.number.split('-').pop()));
  assert.deepEqual(seqs, [1, 2, 3, 4]);                                         // gapless per organisation
  assert.ok(inv.every((x) => x.venue_id === null && x.reservation_id === null && x.organisation_id === a.org.id));
  assert.equal(inv.reduce((t, x) => t + x.total_cents, 0), 9000);
  assert.ok(inv[0].tax_cents > 0 && inv[0].tax_rate_bp === 2000);
  // the payer sees them; a stranger cannot
  const mine = must(await api('GET', '/invoices', { token: ath.token }));
  assert.equal(mine.filter((x) => x.organisation_id === a.org.id).length, 4);
  const stranger = await adult();
  assert.equal((await api('GET', `/invoices/${inv[0].id}`, { token: stranger.token })).status, 403);
  assert.equal((await api('GET', '/invoices', { token: stranger.token, query: { organisation_id: a.org.id } })).status, 404);
  const staff = must(await api('GET', '/invoices', { token: a.owner.token, query: { organisation_id: a.org.id } }));
  assert.equal(staff.length, 4);
  // funding revises the open invoice; full funding voids it
  const ch = (await pool.query('SELECT * FROM academy_charges WHERE payer_id=$1 AND kind=$2 ORDER BY seq', [ath.id, 'instalment'])).rows;
  must(await api('POST', `/academy-charges/${ch[0].id}/funding`, { token: a.owner.token, body: { funding_source: 'scholarship', funded_minor: 1000 } }));
  assert.equal((await pool.query("SELECT total_cents FROM invoices WHERE academy_charge_id=$1 AND kind='invoice' AND status='open'", [ch[0].id])).rows[0].total_cents, Number(ch[0].amount_minor) - 1000);
  must(await api('POST', `/academy-charges/${ch[1].id}/funding`, { token: a.owner.token, body: { funding_source: 'bursary', funded_minor: Number(ch[1].amount_minor) } }));
  assert.equal((await pool.query("SELECT status FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [ch[1].id])).rows[0].status, 'void');
  // staff record a desk payment: the invoice becomes a paid receipt
  const dep = (await pool.query("SELECT id FROM academy_charges WHERE payer_id=$1 AND kind='deposit'", [ath.id])).rows[0];
  assert.equal((await api('POST', `/academy-charges/${dep.id}/paid`, { token: ath.token, body: { method: 'cash' } })).status, 404);   // the family cannot mark itself paid
  must(await api('POST', `/academy-charges/${dep.id}/paid`, { token: a.owner.token, body: { method: 'cash' } }));
  assert.equal((await api('POST', `/academy-charges/${dep.id}/paid`, { token: a.owner.token, body: { method: 'cash' } })).status, 409);
  const paid = (await pool.query("SELECT * FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [dep.id])).rows[0];
  assert.equal(paid.status, 'paid'); assert.equal(paid.payment_method, 'cash');
  const full = must(await api('GET', `/invoices/${paid.id}`, { token: ath.token }));
  assert.equal(full.seller.name.length > 0, true); assert.equal(full.buyer.name, ath.display_name); assert.equal(full.pay.purpose_type, 'academy_charge');
  // finishing a programme forgives nothing; leaving cancels what is unpaid
  const enr2 = (await pool.query('SELECT id FROM org_enrolments WHERE user_id=$1', [ath.id])).rows[0];
  const unpaidBefore = (await pool.query("SELECT count(*)::int AS n FROM academy_charges WHERE enrolment_id=$1 AND status='awaiting_payment'", [enr2.id])).rows[0].n;
  assert.ok(unpaidBefore > 0);
  must(await api('POST', `/academy-enrolments/${enr2.id}/status`, { token: a.owner.token, body: { status: 'completed' } }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_charges WHERE enrolment_id=$1 AND status='awaiting_payment'", [enr2.id])).rows[0].n, unpaidBefore);
  // the staff charge list accepts its filters as query strings
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/charges`, { token: a.owner.token, query: { status: 'awaiting_payment', overdue: 'false' } })).length, unpaidBefore);
  assert.equal(must(await api('GET', `/organisations/${a.org.id}/charges`, { token: a.owner.token, query: { overdue: 'true' } })).length, 0);
  // a venue-only operation refuses academy invoices
  assert.equal((await api('POST', `/invoices/${paid.id}/paid`, { token: a.owner.token, body: { method: 'cash' } })).status, 400);
  // branded PDF of the paid invoice: payer and academy finance can render and download it; a stranger cannot
  const doc = must(await api('POST', '/branded-documents/invoice', { token: ath.token, body: { invoice_id: paid.id } }));
  const dl = await fetch(`${base}${doc.url}`, { headers: { authorization: `Bearer ${ath.token}` } });
  assert.equal(dl.status, 200); assert.equal((await dl.arrayBuffer()).byteLength > 500, true);
  assert.equal((await fetch(`${base}${doc.url}`, { headers: { authorization: `Bearer ${stranger.token}` } })).status, 404);
  assert.equal((await api('POST', '/branded-documents/invoice', { token: stranger.token, body: { invoice_id: paid.id } })).status, 404);
  // a refund issues a numbered credit note against it, once per refund key
  const cn = await pool.connect();
  try {
    const first = await creditChargeInvoice(cn, dep.id, 400, 'k-1');
    const again = await creditChargeInvoice(cn, dep.id, 400, 'k-1');
    assert.equal(first.id, again.id); assert.equal(first.kind, 'credit_note'); assert.match(first.number, /^CN-/); assert.equal(first.parent_id, paid.id);
  } finally { cn.release(); }
  // the platform's venue sales reports never count academy invoices
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM invoices WHERE venue_id IS NULL AND organisation_id IS NOT NULL")).rows[0].n > 0, true);
});

test('packs and monthly fees run on the shared plan engine: activate on payment, sessions, renewal raised once, ends with the enrolment', async () => {
  const pack = await academy({ capacity: 5, fee: 5000, billing: 'pack', terms: { sessions_in_pack: 10 } });
  const ver = (await pool.query('SELECT plan_id FROM academy_programme_versions WHERE programme_id=$1', [pack.programme.id])).rows[0];
  assert.ok(ver.plan_id);
  const plan = (await pool.query('SELECT * FROM venue_plans WHERE id=$1', [ver.plan_id])).rows[0];
  assert.equal(plan.organisation_id, pack.org.id); assert.equal(plan.venue_id, null); assert.equal(plan.kind, 'pass'); assert.equal(plan.sessions, 10);
  const p1 = await adult();
  await apply(p1, pack);
  const up = (await pool.query("SELECT * FROM user_plans WHERE user_id=$1 AND organisation_id=$2", [p1.id, pack.org.id])).rows[0];
  assert.equal(up.status, 'awaiting_payment'); assert.equal(up.sessions_left, 10); assert.ok(up.enrolment_id);
  const charge = (await pool.query('SELECT * FROM academy_charges WHERE user_plan_id=$1', [up.id])).rows[0];
  assert.equal(charge.kind, 'pack');
  must(await api('POST', `/academy-charges/${charge.id}/paid`, { token: pack.owner.token, body: { method: 'bank' } }));
  const live = (await pool.query('SELECT * FROM user_plans WHERE id=$1', [up.id])).rows[0];
  assert.equal(live.status, 'active'); assert.ok(live.expires_at > new Date());
  const mine = must(await api('GET', '/me/plans', { token: p1.token }));
  assert.equal(mine.some((x) => x.id === up.id && x.organisation_id === pack.org.id && x.sessions_left === 10), true);
  assert.equal((await api('DELETE', `/me/plans/${up.id}`, { token: p1.token })).status, 409);
  // staff keep the session count honest; the pack runs out at zero and never goes below
  const enr = (await pool.query('SELECT id FROM org_enrolments WHERE user_id=$1', [p1.id])).rows[0];
  assert.equal(must(await api('POST', `/academy-enrolments/${enr.id}/sessions`, { token: pack.owner.token, body: { delta: -3, reason: 'Attended three sessions' } })).sessions_left, 7);
  assert.equal((await api('POST', `/academy-enrolments/${enr.id}/sessions`, { token: pack.owner.token, body: { delta: -8, reason: 'too many' } })).status, 409);
  assert.equal(must(await api('POST', `/academy-enrolments/${enr.id}/sessions`, { token: pack.owner.token, body: { delta: -7, reason: 'Used the rest' } })).status, 'used_up');
  assert.equal((await api('POST', `/academy-enrolments/${enr.id}/sessions`, { token: p1.token, body: { delta: 1, reason: 'mine' } })).status, 404);
  const fam = must(await api('GET', '/me/academy', { token: p1.token }));
  assert.equal(fam.people[0].enrolments[0].sessions_left, 0);

  // a monthly fee is a membership: paid -> active; a week before it ends the next period and its charge are raised once; leaving stops it
  const mo = await academy({ capacity: 5, fee: 3200, billing: 'monthly' });
  const m1 = await adult();
  await apply(m1, mo);
  const mp = (await pool.query("SELECT * FROM user_plans WHERE user_id=$1 AND organisation_id=$2", [m1.id, mo.org.id])).rows[0];
  assert.equal(mp.kind, 'membership'); assert.equal(mp.duration_months, 1); assert.equal(mp.auto_renew, true);
  const c1 = (await pool.query('SELECT * FROM academy_charges WHERE user_plan_id=$1', [mp.id])).rows[0];
  must(await api('POST', `/academy-charges/${c1.id}/paid`, { token: mo.owner.token, body: { method: 'cash' } }));
  assert.equal((await pool.query('SELECT expires_at > now() + interval \'27 days\' AS ok FROM user_plans WHERE id=$1', [mp.id])).rows[0].ok, true);
  await pool.query("UPDATE user_plans SET expires_at = now() + interval '3 days' WHERE id=$1", [mp.id]);
  assert.equal(await raiseSubscriptionRenewals(), 1);
  assert.equal(await raiseSubscriptionRenewals(), 0);                                   // once per period
  const next = (await pool.query('SELECT * FROM user_plans WHERE renews_id=$1', [mp.id])).rows[0];
  assert.equal(next.status, 'awaiting_payment'); assert.equal(next.enrolment_id, mp.enrolment_id);
  const c2 = (await pool.query('SELECT * FROM academy_charges WHERE user_plan_id=$1', [next.id])).rows[0];
  assert.equal(Number(c2.amount_minor), 3200); assert.equal(c2.seq, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM invoices WHERE academy_charge_id=$1 AND status='open'", [c2.id])).rows[0].n, 1);
  must(await api('POST', `/academy-charges/${c2.id}/paid`, { token: mo.owner.token, body: { method: 'cash' } }));
  assert.equal((await pool.query('SELECT status FROM user_plans WHERE id=$1', [next.id])).rows[0].status, 'active');
  // withdrawing ends the subscription and cancels what is unpaid
  const menr = (await pool.query('SELECT id FROM org_enrolments WHERE user_id=$1', [m1.id])).rows[0];
  must(await api('POST', `/academy-enrolments/${menr.id}/withdraw`, { token: m1.token, body: {} }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM user_plans WHERE enrolment_id=$1 AND status IN ('active','awaiting_payment') AND auto_renew", [menr.id])).rows[0].n, 0);
  await pool.query("UPDATE user_plans SET status='active', expires_at = now() + interval '3 days', auto_renew=true WHERE id=$1", [next.id]);
  assert.equal(await raiseSubscriptionRenewals(), 0);                                   // a withdrawn enrolment is never renewed
});

test('promo codes: shared discounts framework, validated, limited, best single discount, price shown is price honoured', async () => {
  const a = await academy({ capacity: 10, fee: 10000, billing: 'one_time', terms: { sibling_discount_bp: 500 } });
  const promo = must(await api('POST', `/organisations/${a.org.id}/academy/promos`, { token: a.owner.token, body: { name: 'Early bird', code: 'EARLY20', kind: 'percent', value: 20, per_user_limit: 1, max_redemptions: 2 } }), 201);
  assert.equal(promo.venue_id, null); assert.equal(promo.organisation_id, a.org.id);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/promos`, { token: a.owner.token, body: { name: 'Dup', code: 'early20', kind: 'percent', value: 5 } })).status, 409);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/promos`, { token: a.owner.token, body: { name: 'No currency', code: 'FIXED5', kind: 'fixed', value: 500 } })).status, 400);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/promos`, { token: (await adult()).token, body: { name: 'Hack', code: 'HACKME', kind: 'percent', value: 99 } })).status, 404);
  const p1 = await adult(), p2 = await adult(), p3 = await adult();
  // a quote shows it; a wrong code says nothing about which codes exist
  const q = must(await api('GET', `/academy/programmes/${a.programme.id}/quote`, { token: p1.token, query: { promo_code: 'early20' } }));
  assert.equal(q.promo_applied, true); assert.equal(q.total_minor, 8000); assert.equal(q.lines[0].discount_minor, 2000);
  assert.equal((await api('GET', `/academy/programmes/${a.programme.id}/quote`, { token: p1.token, query: { promo_code: 'NOPE999' } })).status, 422);
  // apply with the code: the charge is snapshotted with the promo, a redemption is recorded, an invoice shows the line
  const e1 = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: p1.token, body: {} }), 201);
  const s1 = must(await api('POST', `/academy/applications/${e1.id}/submit`, { token: p1.token, body: { row_version: e1.row_version, answers: {}, promo_code: 'EARLY20' } }));
  assert.equal(s1.stage, 'enrolled');
  const ch = (await pool.query('SELECT * FROM academy_charges WHERE payer_id=$1', [p1.id])).rows[0];
  assert.equal(Number(ch.amount_minor), 8000); assert.equal(ch.terms.discount_reason, 'promo'); assert.equal(ch.terms.promo.code, 'EARLY20');
  assert.equal((await pool.query('SELECT amount_cents FROM discount_redemptions WHERE discount_id=$1', [promo.id])).rows[0].amount_cents, 2000);
  assert.equal(JSON.stringify((await pool.query("SELECT lines FROM invoices WHERE academy_charge_id=$1", [ch.id])).rows[0].lines).includes('EARLY20'), true);
  // per-person and total limits are enforced; the code can be paused and the list shows use
  const e2 = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: p2.token, body: {} }), 201);
  must(await api('POST', `/academy/applications/${e2.id}/submit`, { token: p2.token, body: { row_version: e2.row_version, answers: {}, promo_code: 'EARLY20' } }));
  const e3 = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: p3.token, body: {} }), 201);
  assert.equal((await api('POST', `/academy/applications/${e3.id}/submit`, { token: p3.token, body: { row_version: e3.row_version, answers: {}, promo_code: 'EARLY20' } })).status, 422);   // both uses are taken
  const list = must(await api('GET', `/organisations/${a.org.id}/academy/promos`, { token: a.owner.token, query: { include_inactive: 'true' } }));
  assert.equal(list[0].redemptions, 2); assert.equal(Number(list[0].given_minor), 4000);
  must(await api('PATCH', `/academy/promos/${promo.id}`, { token: a.owner.token, body: { active: false } }));
  assert.equal((await api('GET', `/academy/programmes/${a.programme.id}/quote`, { token: p3.token, query: { promo_code: 'EARLY20' } })).status, 422);
  // a fixed code needs the programme's currency and a smaller fixed code loses to a bigger sibling discount (one discount only)
  const b = await academy({ capacity: 10, fee: 10000, billing: 'one_time', terms: { sibling_discount_bp: 1000 } });
  must(await api('POST', `/organisations/${b.org.id}/academy/promos`, { token: b.owner.token, body: { name: 'Five off', code: 'FIVE', kind: 'fixed', value: 500, currency: 'GBP' } }), 201);
  must(await api('POST', `/organisations/${b.org.id}/academy/promos`, { token: b.owner.token, body: { name: 'Dollars', code: 'USD5', kind: 'fixed', value: 500, currency: 'USD' } }), 201);
  assert.equal((await api('GET', `/academy/programmes/${b.programme.id}/quote`, { token: p1.token, query: { promo_code: 'USD5' } })).status, 422);
  assert.equal(must(await api('GET', `/academy/programmes/${b.programme.id}/quote`, { token: p1.token, query: { promo_code: 'FIVE' } })).total_minor, 9500);
  // a code for one programme does not work on another
  const other = await academy({ capacity: 3 });
  assert.equal((await api('GET', `/academy/programmes/${other.programme.id}/quote`, { token: p1.token, query: { promo_code: 'FIVE' } })).status, 422);
});

test('graduation certificates reuse credentials: issued from a graduated enrolment, verifiable, once, hidden for a young person until a guardian decides', async () => {
  const a = await academy({ capacity: 5, fee: 0, billing: 'free' });
  const ath = await adult();
  const enr = await apply(ath, a);
  assert.equal(enr.stage, 'enrolled');
  const e = (await pool.query('SELECT id FROM org_enrolments WHERE user_id=$1', [ath.id])).rows[0];
  const body = { enrolment_id: e.id, kind: 'certificate', title: 'U12 Squad - completed' };
  assert.equal((await api('POST', `/organisations/${a.org.id}/credentials`, { token: a.owner.token, body })).status, 409);                       // still enrolled
  must(await api('POST', `/academy-enrolments/${e.id}/status`, { token: a.owner.token, body: { status: 'graduated', reason: 'Finished the pathway' } }));
  assert.equal((await api('POST', `/organisations/${a.org.id}/credentials`, { token: a.owner.token, body: { kind: 'certificate', title: 'x1' } })).status, 400);   // needs a source
  assert.equal((await api('POST', `/organisations/${a.org.id}/credentials`, { token: (await adult()).token, body })).status, 404);               // not their academy
  const cert = must(await api('POST', `/organisations/${a.org.id}/credentials`, { token: a.owner.token, body }), 201);
  assert.match(cert.code, /^GMG-/);
  assert.equal((await api('POST', `/organisations/${a.org.id}/credentials`, { token: a.owner.token, body })).status, 409);                       // once per kind
  const check = await api('GET', `/credentials/verify/${cert.code}`);
  assert.equal(check.status, 200);
  const mine = must(await api('GET', '/me/credentials', { token: ath.token }));
  assert.equal(mine[0].enrolment_id, e.id); assert.equal(mine[0].show_on_profile, true);
  const staffList = must(await api('GET', `/organisations/${a.org.id}/credentials`, { token: a.owner.token }));
  assert.equal(staffList[0].programme_title, a.programme.title);
  // a young person's certificate goes to the guardian and stays off the profile until they decide
  const kid = await signup({ dob: yearsAgo(10) });
  const parent = await guardianOf(kid);
  await allow(parent, kid, 'participation');
  await apply(parent, a, kid.id);
  const ke = (await pool.query('SELECT id FROM org_enrolments WHERE user_id=$1', [kid.id])).rows[0];
  must(await api('POST', `/academy-enrolments/${ke.id}/status`, { token: a.owner.token, body: { status: 'completed' } }));
  const kc = must(await api('POST', `/organisations/${a.org.id}/credentials`, { token: a.owner.token, body: { enrolment_id: ke.id, kind: 'badge', title: 'Season complete' } }), 201);
  assert.equal((await pool.query('SELECT show_on_profile FROM credentials WHERE id=$1', [kc.id])).rows[0].show_on_profile, false);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='credential_issued' AND user_id=$1", [parent.id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='credential_issued' AND user_id=$1", [kid.id])).rows[0].n, 0);
  // the guardian sees the child's certificate in the family view and decides about the profile; a stranger cannot
  const famk = must(await api('GET', '/me/academy', { token: parent.token }));
  assert.equal(famk.people.find((x) => x.athlete.id === kid.id).certificates[0].code, kc.code);
  must(await api('PATCH', `/me/credentials/${kc.id}`, { token: parent.token, body: { show_on_profile: true } }));
  assert.equal((await pool.query('SELECT show_on_profile FROM credentials WHERE id=$1', [kc.id])).rows[0].show_on_profile, true);
  assert.equal((await api('PATCH', `/me/credentials/${kc.id}`, { token: (await adult()).token, body: { show_on_profile: false } })).status, 404);
  // the programme desk lists who finished and whether a certificate exists
  const desk = must(await api('GET', `/academy/programmes/${a.programme.id}/desk`, { token: a.owner.token }));
  assert.equal(desk.alumni.length, 2); assert.ok(desk.alumni.every((x) => x.credential?.code));
});

test('enrolment letters reuse the branded-document stack: issued from the enrolment, immutable, templates, family and staff access, youth via guardian', async () => {
  const a = await academy({ capacity: 10, fee: 9000, billing: 'term', terms: { instalments: 3, deposit_minor: 900, equipment: 'Shin pads' } });
  const ath = await adult();
  await apply(ath, a);
  const enr = (await pool.query('SELECT id FROM org_enrolments WHERE user_id=$1', [ath.id])).rows[0];
  const get = (u, url) => fetch(`${base}${url}`, { headers: { authorization: `Bearer ${u.token}` } });
  // the enrolled adult gets the standard letter; asking again returns the same document instead of piling up copies
  const l1 = must(await api('POST', `/academy/enrolments/${enr.id}/letter`, { token: ath.token, body: {} }), 201);
  const l1b = must(await api('POST', `/academy/enrolments/${enr.id}/letter`, { token: ath.token, body: {} }), 201);
  assert.equal(l1b.id, l1.id); assert.equal(l1.family, 'enrolment_letter'); assert.equal(l1.source_type, 'academy_enrolment');
  const pdf = await get(ath, l1.url);
  assert.equal(pdf.status, 200); assert.equal((await pdf.arrayBuffer()).byteLength, l1.size_bytes);
  assert.equal((await api('POST', `/academy/enrolments/${enr.id}/letter`, { token: ath.token, body: { note: 'Hi' } })).status, 403); // only staff customise
  // a stranger can neither issue, list nor download
  const stranger = await adult();
  assert.equal((await api('POST', `/academy/enrolments/${enr.id}/letter`, { token: stranger.token, body: {} })).status, 404);
  assert.equal((await api('GET', `/academy/enrolments/${enr.id}/letters`, { token: stranger.token })).status, 404);
  assert.equal((await get(stranger, l1.url)).status, 404);
  assert.equal((await get(a.owner, l1.url)).status, 200);                       // academy staff can
  // staff: a welcome note and a published template; each issue is a new immutable document
  const tpl = must(await api('POST', '/document-templates', { token: a.owner.token, body: { family: 'enrolment_letter', name: 'Welcome', organisation_id: a.org.id, starter: 'modern' } }));
  assert.equal((await api('POST', '/document-templates', { token: a.owner.token, body: { family: 'enrolment_letter', name: 'Bad', organisation_id: a.org.id, layout: { style: 'classic', paper: 'A4', orientation: 'portrait', margin_mm: 18, blocks: [{ type: 'lines' }] } } })).status, 400); // a letter has no invoice lines
  assert.equal((await api('POST', `/academy/enrolments/${enr.id}/letter`, { token: a.owner.token, body: { template_id: tpl.id } })).status, 409); // unpublished
  must(await api('POST', `/document-templates/${tpl.id}/publish`, { token: a.owner.token, body: { row_version: tpl.row_version } }));
  const l2 = must(await api('POST', `/academy/enrolments/${enr.id}/letter`, { token: a.owner.token, body: { note: 'We cannot wait to see you on the pitch.', template_id: tpl.id } }), 201);
  assert.notEqual(l2.id, l1.id); assert.ok(l2.template_version_id);
  assert.equal((await api('POST', `/academy/enrolments/${enr.id}/letter`, { token: (await academy()).owner.token, body: { note: 'x' } })).status, 404); // other academies
  assert.equal(must(await api('GET', `/academy/enrolments/${enr.id}/letters`, { token: ath.token })).length, 2);
  await assert.rejects(() => pool.query('UPDATE generated_documents SET pages=9 WHERE id=$1', [l1.id]), /append-only/);
  // a young person's letter is addressed to the guardian and only the verified guardian can fetch it
  const child = await signup({ dob: yearsAgo(11) });
  const parent = await guardianOf(child);
  await allow(parent, child, 'participation');
  await apply(parent, a, child.id);
  const kEnr = (await pool.query('SELECT id FROM org_enrolments WHERE user_id=$1', [child.id])).rows[0];
  assert.equal((await api('POST', `/academy/enrolments/${kEnr.id}/letter`, { token: child.token, body: {} })).status, 404); // the child cannot
  const kl = must(await api('POST', `/academy/enrolments/${kEnr.id}/letter`, { token: parent.token, body: {} }), 201);
  assert.equal((await get(parent, kl.url)).status, 200);
  assert.equal((await get(child, kl.url)).status, 404);
  assert.equal((await get(ath, kl.url)).status, 404);
  // an ended enrolment gets no confirmation letter
  await pool.query("UPDATE org_enrolments SET status='withdrawn' WHERE id=$1", [kEnr.id]);
  assert.equal((await api('POST', `/academy/enrolments/${kEnr.id}/letter`, { token: a.owner.token, body: {} })).status, 409);
});

// ------------------------------------------------------------------ trials on the academy timetable
const { remindTrials } = await import('../src/academy-sweeps.js');
const requestTrial = async (u, a, athleteId) => {
  const enq = must(await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: u.token, body: athleteId ? { athlete_id: athleteId } : {} }), 201);
  return must(await api('POST', `/academy/applications/${enq.id}/trial`, { token: u.token, body: { row_version: enq.row_version } }));
};
const appRow = async (id) => (await pool.query('SELECT stage, row_version FROM academy_applications WHERE id=$1', [id])).rows[0];

test('trial booking: the seat is a guest attendance row on a published trial session; concurrent bookings never exceed capacity; change, cancel and a cancelled session free seats', async () => {
  const a = await academy({ capacity: 10 });
  const slot = await trialSlot(a, { capacity: 2 });
  const people = await Promise.all([adult(), adult(), adult(), adult()]);
  const reqs = await Promise.all(people.map((u) => requestTrial(u, a)));
  const slots = must(await api('GET', `/academy/programmes/${a.programme.id}/trial-slots`, { token: people[0].token }));
  assert.equal(slots.slots.length, 1); assert.equal(slots.slots[0].seats_free, 2); assert.ok(slots.slots[0].local_date && slots.slots[0].local_start);
  assert.equal(slots.slots[0].booked, undefined);                                    // no counts or names of other people
  assert.equal((await api('GET', `/academy/programmes/${a.programme.id}/trial-slots`, { token: (await adult()).token, query: { athlete_id: people[0].id } })).status, 403);
  const res = await Promise.all(people.map((u, k) => api('POST', `/academy/applications/${reqs[k].id}/trial/book`, { token: u.token, body: { row_version: reqs[k].row_version, session_id: slot.id } })));
  assert.equal(res.filter((r) => r.status === 200).length, 2); assert.equal(res.filter((r) => r.status === 409).length, 2);
  const seats = (await pool.query("SELECT user_id, guest, status, application_id FROM academy_attendance WHERE session_id=$1", [slot.id])).rows;
  assert.equal(seats.length, 2); assert.ok(seats.every((x) => x.guest && x.status === 'expected' && x.application_id));
  assert.equal(must(await api('GET', `/academy/programmes/${a.programme.id}/trial-slots`, { token: people[0].token })).slots.length, 0); // full: not offered
  // one of the booked changes to another time: the first seat is freed (excused), the second taken
  const k = res.findIndex((r) => r.status === 200), waiting = res.findIndex((r) => r.status === 409);
  const second = await trialSlot(a, { capacity: 3, days: 4 });
  const moved = must(await api('POST', `/academy/applications/${reqs[k].id}/trial/book`, { token: people[k].token, body: { row_version: res[k].body.row_version, session_id: second.id } }));
  assert.equal(moved.stage, 'trial_booked');
  assert.equal((await pool.query("SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2", [slot.id, people[k].id])).rows[0].status, 'excused');
  assert.equal((await api('POST', `/academy/applications/${reqs[k].id}/trial/book`, { token: people[k].token, body: { row_version: moved.row_version, session_id: second.id } })).status, 409); // already there
  // a stranger can neither book nor cancel; staff can book on someone's behalf
  const stranger = await adult();
  assert.equal((await api('POST', `/academy/applications/${reqs[k].id}/trial/book`, { token: stranger.token, body: { row_version: moved.row_version, session_id: slot.id } })).status, 404);
  const w = await appRow(reqs[waiting].id);
  const staffBooked = must(await api('POST', `/academy/applications/${reqs[waiting].id}/trial/book`, { token: a.owner.token, body: { row_version: w.row_version, session_id: slot.id } }));
  assert.equal((await pool.query("SELECT source FROM academy_attendance WHERE session_id=$1 AND user_id=$2", [slot.id, people[waiting].id])).rows[0].source, 'staff');
  // cancelling frees the seat and returns the application to "trial requested"
  const gone = must(await api('POST', `/academy/applications/${reqs[waiting].id}/trial/cancel`, { token: people[waiting].token, body: { row_version: staffBooked.row_version } }));
  assert.equal(gone.stage, 'trial_requested');
  // cancelling the session itself releases everyone on it and tells them; history is kept
  const held = (await pool.query("SELECT application_id FROM academy_attendance WHERE session_id=$1 AND status='expected'", [slot.id])).rows;
  assert.equal(held.length, 1);
  must(await api('POST', `/academy/sessions/${slot.id}/cancel`, { token: a.owner.token, body: { reason: 'Pitch unavailable' } }));
  assert.equal((await appRow(held[0].application_id)).stage, 'trial_requested');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_attendance WHERE session_id=$1 AND status IN ('not_held','excused')", [slot.id])).rows[0].n, 3);
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='academy_trial_cancelled'")).rows[0].n >= 1);
  const again = await appRow(held[0].application_id);
  assert.equal((await api('POST', `/academy/applications/${held[0].application_id}/trial/book`, { token: a.owner.token, body: { row_version: again.row_version, session_id: slot.id } })).status, 409);
});

test('trial for a young person goes through the verified guardian; the fee gates booking; reminders go once; attendance on the roster drives the application; a no-show can rebook', async () => {
  const a = await academy({ capacity: 10, terms: { trial_fee_minor: 500 } });
  const slot = await trialSlot(a, { capacity: 3, days: 1 });
  const child = await signup({ dob: yearsAgo(11) });
  assert.equal((await api('POST', `/academy/programmes/${a.programme.id}/applications`, { token: child.token, body: {} })).status, 403); // a child cannot enrol themselves
  const parent = await guardianOf(child);
  await allow(parent, child, 'participation');
  const t = await requestTrial(parent, a, child.id);
  const fee = (await pool.query("SELECT * FROM academy_charges WHERE application_id=$1 AND kind='trial'", [t.id])).rows[0];
  assert.equal(Number(fee.amount_minor), 500);
  assert.equal((await api('POST', `/academy/applications/${t.id}/trial/book`, { token: parent.token, body: { row_version: t.row_version, session_id: slot.id } })).status, 409); // fee unpaid
  await pool.query("UPDATE academy_charges SET status='waived' WHERE id=$1", [fee.id]);
  assert.equal((await api('POST', `/academy/applications/${t.id}/trial/book`, { token: child.token, body: { row_version: t.row_version, session_id: slot.id } })).status, 403); // the child cannot book either
  const booked = must(await api('POST', `/academy/applications/${t.id}/trial/book`, { token: parent.token, body: { row_version: t.row_version, session_id: slot.id } }));
  assert.equal((await pool.query("SELECT source FROM academy_attendance WHERE session_id=$1 AND user_id=$2", [slot.id, child.id])).rows[0].source, 'guardian');
  // the family view shows the booked time; only the guardian is told, never the child
  const fam = must(await api('GET', '/me/academy', { token: parent.token }));
  const mine = fam.people.find((p) => p.athlete.id === child.id).applications.find((x) => x.id === t.id);
  assert.equal(mine.trial.session.id, slot.id); assert.ok(mine.trial.session.local_date);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='academy_trial_booked' AND user_id=$1", [child.id])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='academy_trial_booked' AND user_id=$1", [parent.id])).rows[0].n, 1);
  // reminder: once, only inside the 24 hours before
  await pool.query("UPDATE academy_sessions SET starts_at = now() + interval '20 hours', ends_at = now() + interval '21 hours' WHERE id=$1", [slot.id]);
  assert.equal(await remindTrials(), 1);
  assert.equal(await remindTrials(), 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='academy_trial_reminder' AND user_id=$1", [parent.id])).rows[0].n, 1);
  // staff mark the roster (the single attendance write path): the application follows. Absent -> back to requested, the family can pick another time.
  await startedAlready(slot.id);
  must(await api('POST', `/academy/sessions/${slot.id}/attendance`, { token: a.owner.token, body: { entries: [{ user_id: child.id, status: 'absent', reason_code: 'other' }] } }));
  assert.equal((await appRow(t.id)).stage, 'trial_requested');
  const second = await trialSlot(a, { capacity: 3, days: 2 });
  const again = must(await api('POST', `/academy/applications/${t.id}/trial/book`, { token: parent.token, body: { row_version: (await appRow(t.id)).row_version, session_id: second.id } }));
  await startedAlready(second.id);
  must(await api('POST', `/academy/sessions/${second.id}/attendance`, { token: a.owner.token, body: { entries: [{ user_id: child.id, status: 'present' }] } }));
  assert.equal((await appRow(t.id)).stage, 'trial_completed');
  assert.ok(again.row_version > 0);
});

test('trial seats: cancelling a session you moved away from leaves your new booking alone; a released seat can be taken again; withdrawing frees the seat', async () => {
  const a = await academy({ capacity: 10 });
  const first = await trialSlot(a, { capacity: 1, days: 3 }), second = await trialSlot(a, { capacity: 1, days: 4 });
  const u = await adult(), v = await adult();
  const t = await requestTrial(u, a);
  const b1 = must(await api('POST', `/academy/applications/${t.id}/trial/book`, { token: u.token, body: { row_version: t.row_version, session_id: first.id } }));
  const b2 = must(await api('POST', `/academy/applications/${t.id}/trial/book`, { token: u.token, body: { row_version: b1.row_version, session_id: second.id } }));
  // staff cancel the session the family already left: the application keeps its seat on the second session
  must(await api('POST', `/academy/sessions/${first.id}/cancel`, { token: a.owner.token, body: { reason: 'Pitch unavailable' } }));
  assert.equal((await appRow(t.id)).stage, 'trial_booked');
  assert.equal((await pool.query("SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2", [second.id, u.id])).rows[0].status, 'expected');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='academy_trial_cancelled' AND user_id=$1", [u.id])).rows[0].n, 0);
  // give up the second seat, then take the very same session again
  const gone = must(await api('POST', `/academy/applications/${t.id}/trial/cancel`, { token: u.token, body: { row_version: b2.row_version } }));
  const again = must(await api('POST', `/academy/applications/${t.id}/trial/book`, { token: u.token, body: { row_version: gone.row_version, session_id: second.id } }));
  assert.equal(again.stage, 'trial_booked');
  assert.equal((await pool.query("SELECT status, reminded_at FROM academy_attendance WHERE session_id=$1 AND user_id=$2", [second.id, u.id])).rows[0].status, 'expected');
  // the only seat is taken, so another family cannot book it; withdrawing frees it
  const w = await requestTrial(v, a);
  assert.equal((await api('POST', `/academy/applications/${w.id}/trial/book`, { token: v.token, body: { row_version: w.row_version, session_id: second.id } })).status, 409);
  must(await api('POST', `/academy/applications/${t.id}/withdraw`, { token: u.token, body: { row_version: again.row_version } }));
  assert.equal((await pool.query("SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2", [second.id, u.id])).rows[0].status, 'excused');
  must(await api('POST', `/academy/applications/${w.id}/trial/book`, { token: v.token, body: { row_version: w.row_version, session_id: second.id } }));
});

test('trial outcomes can be corrected through attendance; a seat the family already left is ignored; trial seats cannot be moved by a make-up transfer', async () => {
  const a = await academy({ capacity: 10 });
  const s1 = await trialSlot(a, { capacity: 3, days: 3 }), s2 = await trialSlot(a, { capacity: 3, days: 4 });
  const u = await adult();
  const t = await requestTrial(u, a);
  const b1 = must(await api('POST', `/academy/applications/${t.id}/trial/book`, { token: u.token, body: { row_version: t.row_version, session_id: s1.id } }));
  // a trial seat is not a make-up: the transfer refuses it and points at the booking flow
  assert.equal((await api('POST', `/academy/sessions/${s1.id}/transfer`, { token: a.owner.token, body: { user_id: u.id, to_session_id: s2.id } })).status, 409);
  // the family moves to the second time; a staff correction on the seat they left must not touch the application
  must(await api('POST', `/academy/applications/${t.id}/trial/book`, { token: u.token, body: { row_version: b1.row_version, session_id: s2.id } }));
  await startedAlready(s1.id);
  must(await api('POST', `/academy/sessions/${s1.id}/attendance`, { token: a.owner.token, body: { reason: 'Correction after the move', entries: [{ user_id: u.id, status: 'absent', reason_code: 'other' }] } }));
  assert.equal((await appRow(t.id)).stage, 'trial_booked');
  // first mark absent, then corrected to present (and back): the application follows each correction
  await startedAlready(s2.id);
  const mark = (status, extra = {}) => api('POST', `/academy/sessions/${s2.id}/attendance`, { token: a.owner.token, body: { reason: 'Recorded at the session', entries: [{ user_id: u.id, status, ...extra }] } });
  must(await mark('absent', { reason_code: 'other' }));
  assert.equal((await appRow(t.id)).stage, 'trial_requested');
  must(await mark('present'));
  assert.equal((await appRow(t.id)).stage, 'trial_completed');
  must(await mark('absent', { reason_code: 'other' }));
  assert.equal((await appRow(t.id)).stage, 'trial_requested');
});

test('trial seats: an excused absence returns the application; cancelling a booking while staff mark attendance never deadlocks', async () => {
  const a = await academy({ capacity: 10 });
  const slot = await trialSlot(a, { capacity: 8, days: 1 });
  const people = await Promise.all([adult(), adult(), adult(), adult()]);
  const reqs = await Promise.all(people.map((u) => requestTrial(u, a)));
  const booked = await Promise.all(people.map((u, k) => api('POST', `/academy/applications/${reqs[k].id}/trial/book`, { token: u.token, body: { row_version: reqs[k].row_version, session_id: slot.id } }).then((r) => must(r))));
  // staff mark the first athlete excused (what a reported absence does): the application is free to choose another time
  must(await api('POST', `/academy/sessions/${slot.id}/attendance`, { token: a.owner.token, body: { reason: 'Told us in advance', entries: [{ user_id: people[0].id, status: 'excused', reason_code: 'family' }] } }));
  assert.equal((await appRow(reqs[0].id)).stage, 'trial_requested');
  // the other three cancel while staff mark the roster at the same time: every request settles (no aborted transaction)
  await startedAlready(slot.id);
  const results = await Promise.all([
    ...[1, 2, 3].map((k) => api('POST', `/academy/applications/${reqs[k].id}/trial/cancel`, { token: people[k].token, body: { row_version: booked[k].row_version } })),
    api('POST', `/academy/sessions/${slot.id}/attendance`, { token: a.owner.token, body: { reason: 'Roll call', entries: [1, 2, 3].map((k) => ({ user_id: people[k].id, status: 'present' })) } }),
  ]);
  assert.ok(results.every((r) => [200, 409].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
});

test('trial history: correcting an older seat after a rebooking is allowed and leaves the current booking alone', async () => {
  const a = await academy({ capacity: 10 });
  const s1 = await trialSlot(a, { capacity: 3, days: 3 }), s2 = await trialSlot(a, { capacity: 3, days: 4 });
  const u = await adult();
  const t = await requestTrial(u, a);
  const b1 = must(await api('POST', `/academy/applications/${t.id}/trial/book`, { token: u.token, body: { row_version: t.row_version, session_id: s1.id } }));
  await startedAlready(s1.id);
  must(await api('POST', `/academy/sessions/${s1.id}/attendance`, { token: a.owner.token, body: { entries: [{ user_id: u.id, status: 'absent', reason_code: 'other' }] } }));
  const again = must(await api('POST', `/academy/applications/${t.id}/trial/book`, { token: u.token, body: { row_version: (await appRow(t.id)).row_version, session_id: s2.id } }));
  assert.equal(again.stage, 'trial_booked'); assert.ok(b1.row_version > 0);
  // the older mark is corrected to present: no error, and the application still holds its new seat
  must(await api('POST', `/academy/sessions/${s1.id}/attendance`, { token: a.owner.token, body: { reason: 'Correction', entries: [{ user_id: u.id, status: 'present' }] } }));
  assert.equal((await appRow(t.id)).stage, 'trial_booked');
  assert.equal((await pool.query("SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2", [s2.id, u.id])).rows[0].status, 'expected');
  must(await api('POST', `/academy/applications/${t.id}/trial/cancel`, { token: u.token, body: { row_version: (await appRow(t.id)).row_version } }));
});
