// Recurring collections & dunning (issue #511): schedules, part payments, waivers, the dunning lifecycle, mandates, suspension, youth billing and reporting.
// Every test builds its own data; time is moved by passing `today` to the worker steps, never by editing rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { settle } = await import('../src/payments/service.js');
const { runCollections, raiseScheduledCharges, registerMandateExecutor, collectionsReport } = await import('../src/collections.js');
const { raiseSubscriptionRenewals } = await import('../src/booking/plans.js');
const { addDays } = await import('../src/sponsor-schedule.js');
const { capabilities } = await import('../src/registry.js');
await import('../src/capabilities/index.js');
const { STEPS } = await import('../src/worker.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const today = new Date().toISOString().slice(0, 10);
const T = (d) => addDays(today, d);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `co_${n}`, display_name: `Collect ${n}`, email: `co${n}@example.com`, password: 'correct-horse-battery', roles, dob: yearsAgo(30), ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('co_root','co_root','{admin}','x','x','co_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ------------------------------------------------------------------------------------------------------------------ fixtures
async function guardianOf(child) {
  const parent = await signup(['athlete'], { dob: yearsAgo(40) });
  const l = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  ok(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  ok(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  return { ...parent, link: l };
}
/** A club (or academy) with a group, adult players and young players with guardians, plus a finance member and a coach who is not allowed money. */
async function club({ players = 2, youth = 0, kind = 'club' } = {}) {
  const owner = await signup(), finance = await signup(), coach = await signup(['coach']), stranger = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Collect Club ${n}`, kind } }), 201);
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at, invited_by) VALUES ($1,$2,'finance','active',now(),$3), ($1,$4,'coach','active',now(),$3)", [org.id, finance.id, owner.id, coach.id]);
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: `Seniors ${n}` } }), 201);
  const people = [];
  for (let k = 0; k < players; k++) people.push(await signup());
  const kids = [], parents = [];
  for (let k = 0; k < youth; k++) { const kid = await signup(['athlete'], { dob: yearsAgo(11) }); kids.push(kid); parents.push(await guardianOf(kid)); }
  const all = [...people, ...kids];
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${all.map((p) => `${p.handle},yes`).join('\n')}` } }), 201);
  const enrolment = async (u) => (await pool.query('SELECT * FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2', [cohort.id, u.id])).rows[0];
  return { owner, finance, coach, stranger, org, cohort, players: people, kids, parents, enrolment };
}
const schedule = async (k, athlete, over = {}) => {
  const e = await k.enrolment(athlete);
  return ok(await api('POST', '/billing-schedules', { token: k.owner.token, body: { organisation_id: k.org.id, enrolment_id: e.id, kind: 'custom', label: 'Club dues', currency: 'GBP', amount_minor: 10000, due_dates: [T(0)], idempotency_key: key(), ...over } }), 201);
};
const chargeOf = async (scheduleId, period = 1) => (await pool.query('SELECT ch.* FROM billing_schedule_periods p JOIN academy_charges ch ON ch.id=p.charge_id WHERE p.schedule_id=$1 AND p.period_no=$2', [scheduleId, period])).rows[0];
const caseOf = async (chargeId) => (await pool.query("SELECT * FROM collection_cases WHERE source_type='academy_charge' AND source_id=$1", [chargeId])).rows[0];
const events = async (caseId, kind) => (await pool.query('SELECT * FROM collection_events WHERE case_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at, id', [caseId, kind ?? null])).rows;
const notes = async (userId, like) => (await pool.query("SELECT * FROM notifications WHERE user_id=$1 AND kind LIKE $2 ORDER BY created_at, id", [userId, like])).rows;
const sweep = (k, day) => runCollections({ today: day, ownerId: k.org.id });
const pay = (k, chargeId, body, who = 'owner') => api('POST', `/academy-charges/${chargeId}/paid`, { token: k[who].token, body });

// ------------------------------------------------------------------------------------------------------------------ schedules
test('a schedule freezes its terms and raises exactly one charge and one invoice per period, however many runs race', async () => {
  const k = await club();
  const ath = k.players[0];
  const s = await schedule(k, ath, { kind: 'monthly', due_dates: undefined, first_due_on: T(5), periods: 3, amount_minor: 5000, tax_rate_bp: 0 });
  assert.equal(s.due_dates.length, 3); assert.equal(s.raised_now, 1, 'only the period inside the raise window exists yet');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_charges WHERE enrolment_id=$1', [s.enrolment_id])).rows[0].n, 1);
  // the same request again changes nothing
  const again = ok(await api('POST', '/billing-schedules', { token: k.owner.token, body: { organisation_id: k.org.id, enrolment_id: s.enrolment_id, kind: 'monthly', label: 'Club dues', currency: 'GBP', amount_minor: 5000, first_due_on: T(5), periods: 3, idempotency_key: (await pool.query('SELECT idempotency_key FROM billing_schedules WHERE id=$1', [s.id])).rows[0].idempotency_key } }), 201);
  assert.equal(again.id, s.id); assert.equal(again.replay, true);
  // six workers racing for the second period raise it once
  const later = T(40);
  const made = await Promise.all(Array.from({ length: 6 }, () => raiseScheduledCharges({ today: later, ownerId: k.org.id })));
  assert.equal(made.reduce((t, x) => t + x, 0), 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_schedule_periods WHERE schedule_id=$1', [s.id])).rows[0].n, 2);
  await raiseScheduledCharges({ today: T(80), ownerId: k.org.id }); await raiseScheduledCharges({ today: T(80), ownerId: k.org.id });
  const charges = (await pool.query("SELECT ch.*, i.number FROM academy_charges ch JOIN invoices i ON i.academy_charge_id=ch.id AND i.kind='invoice' WHERE ch.enrolment_id=$1 ORDER BY ch.seq", [s.enrolment_id])).rows;
  assert.equal(charges.length, 3, 'three periods, three charges, three numbered invoices');
  assert.equal(new Set(charges.map((c) => c.number)).size, 3);
  assert.deepEqual(charges.map((c) => c.kind), ['dues', 'dues', 'dues']);
  assert.ok(charges.every((c) => Number(c.amount_minor) === 5000 && c.terms.schedule_id === s.id));
  assert.deepEqual(charges.map((c) => c.due_on.toISOString().slice(0, 10)), s.due_dates);
  // pausing raises nothing; ending is a soft end that keeps what was raised
  const k2 = await club(); const s2 = await schedule(k2, k2.players[0], { due_dates: [T(60), T(90)] });
  ok(await api('PATCH', `/billing-schedules/${s2.id}`, { token: k2.owner.token, body: { action: 'pause' } }));
  assert.equal(await raiseScheduledCharges({ today: T(100), ownerId: k2.org.id }), 0);
  ok(await api('PATCH', `/billing-schedules/${s2.id}`, { token: k2.owner.token, body: { action: 'end', reason: 'Left the club' } }));
  assert.equal((await pool.query('SELECT status FROM billing_schedules WHERE id=$1', [s2.id])).rows[0].status, 'ended');
  assert.equal((await api('PATCH', `/billing-schedules/${s2.id}`, { token: k2.owner.token, body: { action: 'resume' } })).status, 409);
});

test('schedules refuse past dates, double billing and a second schedule on one enrolment', async () => {
  const k = await club();
  const e = await k.enrolment(k.players[0]);
  const body = { organisation_id: k.org.id, enrolment_id: e.id, kind: 'custom', label: 'Dues', currency: 'GBP', amount_minor: 1000 };
  assert.equal((await api('POST', '/billing-schedules', { token: k.owner.token, body: { ...body, due_dates: [T(-3)], idempotency_key: key() } })).status, 422);
  await schedule(k, k.players[0], { due_dates: [T(10)] });
  assert.equal((await api('POST', '/billing-schedules', { token: k.owner.token, body: { ...body, due_dates: [T(20)], idempotency_key: key() } })).status, 409);
  // an enrolment that already renews through a subscription plan is billed there, not twice
  const k3 = await club(); const e3 = await k3.enrolment(k3.players[0]);
  const plan = (await pool.query("INSERT INTO venue_plans(organisation_id, currency, kind, name, price_cents, duration_days, duration_months, discount_bp, auto_renew) VALUES ($1,'GBP','membership','Monthly',1000,30,1,100,true) RETURNING id", [k3.org.id])).rows[0];
  await pool.query("INSERT INTO user_plans(plan_id, organisation_id, enrolment_id, user_id, kind, name, price_cents, currency, duration_days, duration_months, auto_renew, status) VALUES ($1,$2,$3,$4,'membership','Monthly',1000,'GBP',30,1,true,'active')", [plan.id, k3.org.id, e3.id, k3.players[0].id]);
  const dup = await api('POST', '/billing-schedules', { token: k3.owner.token, body: { organisation_id: k3.org.id, enrolment_id: e3.id, kind: 'custom', label: 'Dues', currency: 'GBP', amount_minor: 1000, due_dates: [T(10)], idempotency_key: key() } });
  assert.equal(dup.status, 409); assert.match(dup.body.error?.message ?? dup.body.message ?? JSON.stringify(dup.body), /twice/);
});

// ------------------------------------------------------------------------------------------------------------------ youth
test('a young person is billed to a verified guardian and reminded through them, never directly', async () => {
  const k = await club({ players: 0, youth: 1 });
  const kid = k.kids[0], parent = k.parents[0];
  const e = await k.enrolment(kid);
  const base = { organisation_id: k.org.id, enrolment_id: e.id, kind: 'custom', label: 'Junior dues', currency: 'GBP', amount_minor: 4000, due_dates: [T(0)] };
  const stranger = await signup();
  assert.equal((await api('POST', '/billing-schedules', { token: k.owner.token, body: { ...base, payer_id: stranger.id, idempotency_key: key() } })).status, 422, 'a stranger cannot be billed for a child');
  assert.equal((await api('POST', '/billing-schedules', { token: k.owner.token, body: { ...base, payer_id: kid.id, idempotency_key: key() } })).status, 422, 'the child is not billed');
  const s = ok(await api('POST', '/billing-schedules', { token: k.owner.token, body: { ...base, idempotency_key: key() } }), 201);
  assert.equal(s.payer_id, parent.id, 'the only verified guardian is billed');
  const ch = await chargeOf(s.id);
  assert.equal(ch.payer_id, parent.id);
  await sweep(k, T(0)); await sweep(k, T(4));
  assert.ok((await notes(parent.id, 'collections_%')).length >= 2, 'the guardian is reminded');
  assert.equal((await notes(kid.id, 'collections_%')).length, 0, 'the child is never messaged about money');
  // the live relationship decides: once the link is revoked the guardian is no longer told
  await pool.query("UPDATE guardian_links SET revoked_at=now() WHERE id=$1", [parent.link.id]);
  const before = (await notes(parent.id, 'collections_%')).length;
  await sweep(k, T(8));
  assert.equal((await notes(parent.id, 'collections_%')).length, before);
  assert.equal((await notes(kid.id, 'collections_%')).length, 0);
});

// ------------------------------------------------------------------------------------------------------------------ lifecycle
test('the dunning lifecycle follows the due date, sends each reminder once, and respects notification preferences', async () => {
  const k = await club();
  const ath = k.players[0];
  const s = await schedule(k, ath, { due_dates: [T(2)], amount_minor: 5000 });
  const ch = await chargeOf(s.id);
  await sweep(k, T(0)); await sweep(k, T(0)); await sweep(k, T(0));
  let cs = await caseOf(ch.id);
  assert.equal(cs.state, 'upcoming');
  assert.equal((await events(cs.id, 'reminder_sent')).length, 1, 'the three-days-before reminder is sent once');
  assert.equal((await notes(ath.id, 'collections_reminder')).length, 1);
  await sweep(k, T(2)); cs = await caseOf(ch.id); assert.equal(cs.state, 'due');
  await sweep(k, T(4)); cs = await caseOf(ch.id); assert.equal(cs.state, 'due', 'inside the grace days it is still due, not overdue');
  await sweep(k, T(6)); await sweep(k, T(6)); cs = await caseOf(ch.id); assert.equal(cs.state, 'overdue');
  const offsets = (await events(cs.id, 'reminder_sent')).map((e) => e.data.offset);
  assert.deepEqual(offsets, [-3, 0, 3], 'one reminder per cadence step, in order');
  assert.equal((await notes(ath.id, 'collections_reminder')).length, 3);
  await sweep(k, T(30)); await sweep(k, T(30)); cs = await caseOf(ch.id);
  assert.equal(cs.state, 'escalated');
  assert.equal((await notes(k.owner.id, 'collections_escalated')).length, 1, 'finance staff are told once when it escalates');
  assert.equal((await notes(k.finance.id, 'collections_escalated')).length, 1);
  assert.equal((await notes(k.coach.id, 'collections_escalated')).length, 0, 'staff without a money role are not told');
  assert.equal((await pool.query('SELECT status, settled_minor FROM academy_charges WHERE id=$1', [ch.id])).rows[0].status, 'awaiting_payment');
  // paying after it went overdue resolves (recovers) the case
  ok(await pay(k, ch.id, { method: 'cash' }));
  await sweep(k, T(31)); cs = await caseOf(ch.id);
  assert.equal(cs.state, 'resolved'); assert.ok(cs.closed_at);
  const rep = ok(await api('GET', '/collections/report', { token: k.owner.token, query: { organisation_id: k.org.id, from: T(-1), to: T(1) } }));
  assert.equal(rep.currencies[0].recovered_minor, 5000);
  // a person who muted fee reminders is not messaged, and the case history says so honestly
  const k2 = await club(); const quiet = k2.players[0];
  await pool.query("INSERT INTO notification_prefs(user_id, muted_kinds) VALUES ($1, '{collections_reminder}') ON CONFLICT (user_id) DO UPDATE SET muted_kinds='{collections_reminder}'", [quiet.id]);
  const s2 = await schedule(k2, quiet, { due_dates: [T(0)] }); const c2 = await caseOf((await chargeOf(s2.id)).id) ?? (await sweep(k2, T(0)), await caseOf((await chargeOf(s2.id)).id));
  await sweep(k2, T(0));
  assert.equal((await notes(quiet.id, 'collections_reminder')).length, 0);
  assert.equal((await events(c2.id, 'reminder_sent'))[0].data.recipients, 0);
});

test('a promise to pay or a hold pauses reminders; a broken promise is recorded; none of it changes what is owed', async () => {
  const k = await club();
  const s = await schedule(k, k.players[0], { due_dates: [T(0)] });
  const ch = await chargeOf(s.id);
  await sweep(k, T(0));
  const cs = await caseOf(ch.id);
  const act = (body, who = 'owner') => api('POST', `/collections/cases/${cs.id}/actions`, { token: k[who].token, body });
  assert.equal((await act({ action: 'promise', promised_on: T(-1) })).status, 422, 'a promise cannot be in the past');
  ok(await act({ action: 'promise', promised_on: T(9), note: 'Parent says payday is the 9th' }));
  const sent = (await events(cs.id, 'reminder_sent')).length;
  await sweep(k, T(5)); assert.equal((await events(cs.id, 'reminder_sent')).length, sent, 'no reminders while a promise stands');
  await sweep(k, T(12));
  assert.equal((await events(cs.id, 'promise_broken')).length, 1);
  assert.ok((await events(cs.id, 'reminder_sent')).length > sent, 'reminders resume after a broken promise');
  assert.equal((await act({ action: 'hold', until: T(200), reason: 'Too long' })).status, 422, 'a hold is capped at 90 days');
  assert.equal((await act({ action: 'hold', until: T(20) })).status, 400, 'a hold needs a reason');
  ok(await act({ action: 'hold', until: T(20), reason: 'Hardship, talking to the family' }));
  ok(await act({ action: 'release_hold' }));
  // the internal note is encrypted at rest, readable to money staff only, and the read is audited
  ok(await act({ action: 'note', note: 'Hardship: lost job, ask for a payment plan', idempotency_key: 'note-key-0001' }));
  ok(await act({ action: 'note', note: 'Hardship: lost job, ask for a payment plan', idempotency_key: 'note-key-0001' }));
  const raw = (await pool.query("SELECT note_enc FROM collection_events WHERE case_id=$1 AND kind='note'", [cs.id])).rows;
  assert.equal(raw.length, 1); assert.ok(!raw[0].note_enc.includes('Hardship'));
  const detail = ok(await api('GET', `/collections/cases/${cs.id}`, { token: k.finance.token }));
  assert.ok(detail.events.some((e) => e.note?.includes('lost job')));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_collection_notes' AND entity_id=$1", [cs.id])).rowCount > 0);
  assert.equal((await api('GET', `/collections/cases/${cs.id}`, { token: k.coach.token })).status, 403);
  assert.equal((await api('GET', `/collections/cases/${cs.id}`, { token: k.stranger.token })).status, 404);
  // there is no action that marks money as collected: recovery state follows the canonical charge only
  assert.equal((await act({ action: 'resolve' })).status, 400);
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [ch.id])).rows[0].status, 'awaiting_payment');
});

// ------------------------------------------------------------------------------------------------------------------ payments
test('a failed payment is a recorded attempt and a request to try again, never collected revenue', async () => {
  const k = await club();
  const ath = k.players[0];
  const s = await schedule(k, ath, { due_dates: [T(0)], amount_minor: 8000 });
  const ch = await chargeOf(s.id);
  await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','academy_charge',$2,8000,'GBP','failed','fail-1')", [ath.id, ch.id]);
  await sweep(k, T(0)); await sweep(k, T(0));
  let cs = await caseOf(ch.id);
  assert.equal(cs.state, 'failed'); assert.equal(cs.failed_attempts, 1); assert.equal(cs.attempts, 1);
  assert.equal((await events(cs.id, 'attempt_failed')).length, 1, 'the same failure is recorded once however often the worker runs');
  const row = (await pool.query('SELECT status, settled_minor FROM academy_charges WHERE id=$1', [ch.id])).rows[0];
  assert.equal(row.status, 'awaiting_payment'); assert.equal(Number(row.settled_minor), 0);
  let rep = ok(await api('GET', '/collections/report', { token: k.owner.token, query: { organisation_id: k.org.id, from: T(-1), to: T(1) } }));
  assert.equal(rep.currencies[0].collected_minor, 0);
  assert.equal(rep.currencies[0].payment_attempts.failed, 1); assert.equal(rep.currencies[0].payment_failure_rate_pct, 100);
  await sweep(k, T(1)); await sweep(k, T(1)); cs = await caseOf(ch.id);
  assert.equal(cs.state, 'retrying'); assert.equal((await events(cs.id, 'retry_requested')).length, 1);
  assert.equal((await notes(ath.id, 'collections_retry')).length, 1, 'one retry request per failure');
  // a payment that is in flight is "attempted", and still not collected
  await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','academy_charge',$2,8000,'GBP','pending','pend-1')", [ath.id, ch.id]);
  await sweep(k, T(1)); cs = await caseOf(ch.id);
  assert.equal(cs.state, 'attempted');
  rep = ok(await api('GET', '/collections/report', { token: k.owner.token, query: { organisation_id: k.org.id, from: T(-1), to: T(1) } }));
  assert.equal(rep.currencies[0].collected_minor, 0);
});

test('a mandate is a permission to collect: without a provider adapter the invoice is raised and payment requested, and execution never counts as paid', async () => {
  const k = await club();
  const ath = k.players[0];
  const s = await schedule(k, ath, { due_dates: [T(0), T(35)], amount_minor: 6000, mandate_ref: 'mandate_test_0001' });
  assert.equal(s.mandate_status, 'pending'); assert.equal(s.has_mandate, true); assert.equal(s.mandate_ref, undefined, 'the reference is not echoed');
  const ch = await chargeOf(s.id);
  await pool.query("UPDATE billing_schedules SET mandate_status='active' WHERE id=$1", [s.id]);   // what the provider reports once the payer authorises it
  await sweep(k, T(0)); await sweep(k, T(0));
  let cs = await caseOf(ch.id);
  assert.equal((await events(cs.id, 'auto_debit_unavailable')).length, 1, 'honestly reported once, nothing pretended');
  assert.equal((await events(cs.id, 'auto_debit_started')).length, 0);
  const inv = (await pool.query("SELECT status FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [ch.id])).rows[0];
  assert.equal(inv.status, 'open');
  assert.ok((await notes(ath.id, 'collections_reminder')).length >= 1, 'the payer is asked to pay');
  // a provider adapter whose debit fails: recorded as a failed attempt, still unpaid
  registerMandateExecutor('stub', async () => ({ ok: false, reason: 'insufficient funds' }));
  try {
    await sweep(k, T(0)); cs = await caseOf(ch.id);
    assert.equal((await events(cs.id, 'auto_debit_failed')).length, 1);
    assert.equal(cs.failed_attempts, 1);
    assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [ch.id])).rows[0].status, 'awaiting_payment');
    let rep = ok(await api('GET', '/collections/report', { token: k.owner.token, query: { organisation_id: k.org.id, from: T(-1), to: T(1) } }));
    assert.equal(rep.currencies[0].auto_debit.failed, 1); assert.equal(rep.currencies[0].auto_debit_failure_rate_pct, 100); assert.equal(rep.currencies[0].collected_minor, 0);
    // a debit that the provider accepted is in flight: the charge is still unpaid until a payment is confirmed
    registerMandateExecutor('stub', async ({ chargeId, amountMinor }) => ({ ok: true, ref: `dbt_${chargeId.slice(0, 6)}_${amountMinor}` }));
    await sweep(k, T(1)); cs = await caseOf(ch.id);
    assert.equal((await events(cs.id, 'auto_debit_started')).length, 1);
    assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [ch.id])).rows[0].status, 'awaiting_payment');
    await sweep(k, T(1)); assert.equal((await events(cs.id, 'auto_debit_started')).length, 1, 'no second debit on a rerun');
    // the confirmed payment arrives through the canonical payment flow and only then is it collected
    const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','academy_charge',$2,6000,'GBP','pending','mand-ok') RETURNING id", [ath.id, ch.id])).rows[0];
    await settle(p.id, { paid: true, amount: 6000, currency: 'GBP', paymentRef: 'pi_m' });
    assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [ch.id])).rows[0].status, 'paid');
    rep = ok(await api('GET', '/collections/report', { token: k.owner.token, query: { organisation_id: k.org.id, from: T(-1), to: T(1) } }));
    assert.equal(rep.currencies[0].collected_minor, 6000);
  } finally { registerMandateExecutor('stub', null); }
});

test('part payments, waivers and concessions reconcile exactly to the remaining balance without touching the invoice', async () => {
  const k = await club();
  const ath = k.players[0];
  const s = await schedule(k, ath, { due_dates: [T(0)], amount_minor: 10000 });
  const ch = await chargeOf(s.id);
  const invBefore = (await pool.query("SELECT id, total_cents, revision, status FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [ch.id])).rows[0];
  const part = ok(await pay(k, ch.id, { method: 'cash', amount_minor: 3000, idempotency_key: 'part-key-0001' }));
  const replay = ok(await pay(k, ch.id, { method: 'cash', amount_minor: 3000, idempotency_key: 'part-key-0001' }));
  assert.equal(Number(part.balance_minor), 7000); assert.equal(replay.replay, true); assert.equal(Number(replay.settled_minor), 3000);
  assert.equal(part.status, 'awaiting_payment');
  assert.equal((await pay(k, ch.id, { method: 'cash', amount_minor: 99000 })).status, 409, 'you cannot take more than is owed');
  // five desk staff taking 2,000 at once: only what the balance allows is recorded
  const race = await Promise.all(Array.from({ length: 5 }, (_, i) => pay(k, ch.id, { method: 'cash', amount_minor: 2000, idempotency_key: `race-key-000${i}` })));
  assert.equal(race.filter((r) => r.status === 200).length, 3); assert.equal(race.filter((r) => r.status === 409).length, 2);
  let row = (await pool.query('SELECT status, settled_minor, adjusted_minor, amount_minor FROM academy_charges WHERE id=$1', [ch.id])).rows[0];
  assert.equal(Number(row.settled_minor), 9000);
  assert.equal((await api('POST', `/academy-charges/${ch.id}/adjustments`, { token: k.coach.token, body: { kind: 'waiver', amount_minor: 100, reason: 'Nope', idempotency_key: key() } })).status, 403);
  const w = ok(await api('POST', `/academy-charges/${ch.id}/adjustments`, { token: k.finance.token, body: { kind: 'waiver', amount_minor: 400, reason: 'Late joiner, first week free', idempotency_key: 'adj-key-0001' } }));
  assert.equal(w.balance_minor, 600);
  assert.equal(ok(await api('POST', `/academy-charges/${ch.id}/adjustments`, { token: k.finance.token, body: { kind: 'waiver', amount_minor: 400, reason: 'Late joiner, first week free', idempotency_key: 'adj-key-0001' } })).replay, true);
  assert.equal((await api('POST', `/academy-charges/${ch.id}/adjustments`, { token: k.finance.token, body: { kind: 'concession', amount_minor: 601, reason: 'More than owed', idempotency_key: key() } })).status, 409);
  const done = ok(await api('POST', `/academy-charges/${ch.id}/adjustments`, { token: k.finance.token, body: { kind: 'concession', amount_minor: 600, reason: 'Sibling goodwill', idempotency_key: 'adj-key-0002' } }));
  assert.equal(done.balance_minor, 0); assert.equal(done.charge_status, 'paid');
  row = (await pool.query('SELECT status, settled_minor, adjusted_minor, amount_minor FROM academy_charges WHERE id=$1', [ch.id])).rows[0];
  assert.equal(row.status, 'paid');
  assert.equal(Number(row.settled_minor) + Number(row.adjusted_minor), Number(row.amount_minor));
  const sums = (await pool.query('SELECT (SELECT sum(amount_minor) FROM charge_receipts WHERE charge_id=$1) AS r, (SELECT sum(amount_minor) FROM charge_adjustments WHERE charge_id=$1) AS a', [ch.id])).rows[0];
  assert.equal(Number(sums.r), 9000); assert.equal(Number(sums.a), 1000);
  const invAfter = (await pool.query("SELECT id, total_cents, revision, status FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [ch.id])).rows[0];
  assert.equal(invAfter.id, invBefore.id); assert.equal(Number(invAfter.total_cents), 10000); assert.equal(invAfter.revision, invBefore.revision, 'the original invoice is never rewritten'); assert.equal(invAfter.status, 'paid');
  assert.equal((await pay(k, ch.id, { method: 'cash' })).status, 409, 'nothing more to pay');
  // the report agrees with the facts
  const rep = ok(await api('GET', '/collections/report', { token: k.owner.token, query: { organisation_id: k.org.id, from: T(-1), to: T(1) } }));
  const c = rep.currencies[0];
  assert.equal(c.billed_minor, 10000); assert.equal(c.collected_minor, 9000); assert.equal(c.waived_minor, 400); assert.equal(c.conceded_minor, 600); assert.equal(c.outstanding_minor, 0);
  assert.equal(rep.reconciles, true, JSON.stringify(rep.checks));
  // a charge that was fully waived with nothing paid is waived, its invoice voided, and its case closes as waived
  const s2 = await schedule(k, k.players[1], { due_dates: [T(0)], amount_minor: 2500 });
  const c2 = await chargeOf(s2.id); await sweep(k, T(0));
  ok(await api('POST', `/academy-charges/${c2.id}/adjustments`, { token: k.owner.token, body: { kind: 'waiver', amount_minor: 2500, reason: 'Scholarship place', idempotency_key: key() } }));
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [c2.id])).rows[0].status, 'waived');
  assert.equal((await pool.query("SELECT status FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [c2.id])).rows[0].status, 'void');
  await sweep(k, T(1)); assert.equal((await caseOf(c2.id)).state, 'waived');
  // funding cannot take a part-paid charge below what was already settled
  const k3 = await club(); const s3 = await schedule(k3, k3.players[0], { due_dates: [T(0)], amount_minor: 10000 }); const c3 = await chargeOf(s3.id);
  ok(await pay(k3, c3.id, { method: 'cash', amount_minor: 3000, idempotency_key: 'part-key-0009' }));
  assert.equal((await api('POST', `/academy-charges/${c3.id}/funding`, { token: k3.owner.token, body: { funding_source: 'scholarship', funded_minor: 9500 } })).status, 409);
  ok(await api('POST', `/academy-charges/${c3.id}/funding`, { token: k3.owner.token, body: { funding_source: 'scholarship', funded_minor: 4000 } }));
  assert.equal(Number((await pay(k3, c3.id, { method: 'cash' })).body.balance_minor), 0, 'the balance after funding and a part payment is what the next payment takes');
});

test('an online payment settles the balance that was owed when checkout started, replays are harmless, and a shrunken balance goes to finance', async () => {
  const k = await club();
  const ath = k.players[0];
  const s = await schedule(k, ath, { due_dates: [T(0)], amount_minor: 10000 });
  const ch = await chargeOf(s.id);
  ok(await pay(k, ch.id, { method: 'cash', amount_minor: 4000, idempotency_key: 'part-key-0002' }));
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','academy_charge',$2,6000,'GBP','pending','bal-1') RETURNING id", [ath.id, ch.id])).rows[0];
  await settle(p.id, { paid: true, amount: 6000, currency: 'GBP', paymentRef: 'pi_b1' });
  await settle(p.id, { paid: true, amount: 6000, currency: 'GBP', paymentRef: 'pi_b1' });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM charge_receipts WHERE payment_id=$1', [p.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [ch.id])).rows[0].status, 'paid');
  // checkout started for 6,000, then the desk took 2,000: only the 4,000 still owed is taken and the difference is raised for reconciliation
  const s2 = await schedule(k, k.players[1], { due_dates: [T(0)], amount_minor: 10000 });
  const c2 = await chargeOf(s2.id);
  ok(await pay(k, c2.id, { method: 'cash', amount_minor: 4000, idempotency_key: 'part-key-0003' }));
  const p2 = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','academy_charge',$2,6000,'GBP','pending','bal-2') RETURNING id", [k.players[1].id, c2.id])).rows[0];
  ok(await pay(k, c2.id, { method: 'cash', amount_minor: 2000, idempotency_key: 'part-key-0004' }));
  await settle(p2.id, { paid: true, amount: 6000, currency: 'GBP', paymentRef: 'pi_b2' });
  const r2 = (await pool.query('SELECT status, settled_minor FROM academy_charges WHERE id=$1', [c2.id])).rows[0];
  assert.equal(r2.status, 'paid'); assert.equal(Number(r2.settled_minor), 10000, 'never over-collected');
  assert.ok((await pool.query("SELECT 1 FROM settlement_exceptions WHERE dedupe_key=$1", [`charge_balance_changed:${p2.id}`])).rowCount === 1);
});

test('a payment plan keeps the original charge, follows the next instalment, and breaks when one is missed', async () => {
  const k = await club();
  const s = await schedule(k, k.players[0], { due_dates: [T(0)], amount_minor: 10000 });
  const ch = await chargeOf(s.id); await sweep(k, T(0));
  ok(await pay(k, ch.id, { method: 'cash', amount_minor: 2000, idempotency_key: 'part-key-0005' }));
  const plan = (body, who = 'owner') => api('POST', `/academy-charges/${ch.id}/payment-plan`, { token: k[who].token, body });
  assert.equal((await plan({ instalments: [{ due_on: T(7), amount_minor: 4000 }, { due_on: T(14), amount_minor: 3000 }], idempotency_key: key() })).status, 422, 'must add up to the balance exactly');
  assert.equal((await plan({ instalments: [{ due_on: T(-2), amount_minor: 4000 }, { due_on: T(14), amount_minor: 4000 }], idempotency_key: key() })).status, 422);
  assert.equal((await plan({ instalments: [{ due_on: T(7), amount_minor: 4000 }, { due_on: T(14), amount_minor: 4000 }], idempotency_key: key() }, 'coach')).status, 403);
  const made = ok(await plan({ instalments: [{ due_on: T(7), amount_minor: 4000 }, { due_on: T(14), amount_minor: 4000 }], idempotency_key: 'plan-key-0001' }), 201);
  assert.equal(ok(await plan({ instalments: [{ due_on: T(7), amount_minor: 4000 }, { due_on: T(14), amount_minor: 4000 }], idempotency_key: 'plan-key-0001' }), 201).replay, true);
  assert.equal((await plan({ instalments: [{ due_on: T(8), amount_minor: 4000 }, { due_on: T(15), amount_minor: 4000 }], idempotency_key: key() })).status, 409, 'one active plan per charge');
  const orig = (await pool.query('SELECT amount_minor, due_on, status FROM academy_charges WHERE id=$1', [ch.id])).rows[0];
  assert.equal(Number(orig.amount_minor), 10000); assert.equal(orig.status, 'awaiting_payment');
  await sweep(k, T(8)); assert.equal((await caseOf(ch.id)).state, 'due', 'judged against the instalment, not the original date');
  // paying the first instalment moves the case on to the second
  ok(await pay(k, ch.id, { method: 'cash', amount_minor: 4000, idempotency_key: 'part-key-0006' }));
  await sweep(k, T(12)); assert.equal((await caseOf(ch.id)).state, 'upcoming');
  assert.equal((await pool.query('SELECT status FROM payment_plans WHERE id=$1', [made.id])).rows[0].status, 'active');
  // missing the second instalment beyond the grace days breaks the plan and the original due date applies again
  await sweep(k, T(20));
  assert.equal((await pool.query('SELECT status FROM payment_plans WHERE id=$1', [made.id])).rows[0].status, 'broken');
  const cs = await caseOf(ch.id); assert.equal(cs.state, 'overdue'); assert.equal((await events(cs.id, 'plan_broken')).length, 1);
});

// ------------------------------------------------------------------------------------------------------------------ policy: fees and suspension
test('late fees are off until configured with a basis, add one charge once, and never compound', async () => {
  const k = await club();
  const patch = (body, who = 'owner') => api('PATCH', '/collections/policy', { token: k[who].token, body: { organisation_id: k.org.id, ...body } });
  const defaults = ok(await api('GET', '/collections/policy', { token: k.finance.token, query: { organisation_id: k.org.id } }));
  assert.equal(defaults.late_fee_enabled, false); assert.equal(defaults.suspension_enabled, false); assert.equal(defaults.customised, false);
  assert.equal((await patch({ late_fee_enabled: true, late_fee_minor: 500, late_fee_currency: 'GBP' })).status, 422, 'a late fee needs its contractual basis');
  assert.equal((await patch({ late_fee_enabled: true, late_fee_minor: 500, late_fee_currency: 'GBP', late_fee_basis: 'Section 4.2 of the membership terms' }, 'coach')).status, 403);
  ok(await patch({ late_fee_enabled: true, late_fee_minor: 500, late_fee_currency: 'GBP', late_fee_basis: 'Section 4.2 of the membership terms', late_fee_after_days: 7 }));
  const s = await schedule(k, k.players[0], { due_dates: [T(0)], amount_minor: 4000 });
  const ch = await chargeOf(s.id);
  await sweep(k, T(3)); assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_charges WHERE parent_charge_id=$1", [ch.id])).rows[0].n, 0);
  await sweep(k, T(9)); await sweep(k, T(9)); await sweep(k, T(40));
  const fees = (await pool.query("SELECT * FROM academy_charges WHERE parent_charge_id=$1", [ch.id])).rows;
  assert.equal(fees.length, 1); assert.equal(fees[0].kind, 'late_fee'); assert.equal(Number(fees[0].amount_minor), 500); assert.equal(fees[0].terms.basis, 'Section 4.2 of the membership terms');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_charges WHERE parent_charge_id=$1", [fees[0].id])).rows[0].n, 0, 'a late fee does not attract a late fee');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [fees[0].id])).rows[0].n, 1, 'the fee has its own numbered invoice');
  // forgiving the fee forgives the lateness: the unpaid late fee is cancelled with it and its invoice voided
  ok(await api('POST', `/academy-charges/${ch.id}/adjustments`, { token: k.owner.token, body: { kind: 'waiver', amount_minor: 4000, reason: 'Hardship, fee forgiven', idempotency_key: key() } }));
  assert.equal((await pool.query('SELECT status FROM academy_charges WHERE id=$1', [fees[0].id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query("SELECT status FROM invoices WHERE academy_charge_id=$1 AND kind='invoice'", [fees[0].id])).rows[0].status, 'void');
  // a fee set in pounds is never added to a charge in another currency
  const s_inr = await schedule(k, k.players[1], { due_dates: [T(0)], amount_minor: 90000, currency: 'INR' }); const c_inr = await chargeOf(s_inr.id); await sweep(k, T(20));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_charges WHERE parent_charge_id=$1', [c_inr.id])).rows[0].n, 0);
  // a hold from a human stops fees as well
  const k2 = await club();
  ok(await api('PATCH', '/collections/policy', { token: k2.owner.token, body: { organisation_id: k2.org.id, late_fee_enabled: true, late_fee_minor: 300, late_fee_currency: 'GBP', late_fee_basis: 'Written club fee policy v2', late_fee_after_days: 2 } }));
  const s2 = await schedule(k2, k2.players[0], { due_dates: [T(0)] }); const c2 = await chargeOf(s2.id); await sweep(k2, T(0));
  ok(await api('POST', `/collections/cases/${(await caseOf(c2.id)).id}/actions`, { token: k2.owner.token, body: { action: 'hold', until: T(30), reason: 'Family in hospital' } }));
  await sweep(k2, T(10));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM academy_charges WHERE parent_charge_id=$1", [c2.id])).rows[0].n, 0);
});

test('non-payment can pause access to future sessions only, and payment, waiver or a human reinstates it; nothing is deleted', async () => {
  const k = await club({ kind: 'academy' });
  const ath = k.players[0];
  const coach = k.coach;
  const start = T(3);
  const made = ok(await api('POST', `/cohorts/${k.cohort.id}/academy/timetable`, { token: k.owner.token, body: { idempotency_key: key(), starts_on: start, ends_on: start, weekdays: [dow(start)], start_time: '17:00', duration_min: 60, timezone: 'UTC' } }), 201);
  const sid = made.created[0].id;
  ok(await api('POST', `/organisations/${k.org.id}/academy/sessions/publish`, { token: k.owner.token, body: { session_ids: [sid], acknowledge_warnings: true } }));
  await pool.query("UPDATE academy_sessions SET starts_at=now() - interval '5 minutes', ends_at=now() + interval '55 minutes', self_checkin=true WHERE id=$1", [sid]);
  void coach;
  const s = await schedule(k, ath, { due_dates: [T(0)], amount_minor: 7000 });
  const ch = await chargeOf(s.id);
  const e = await k.enrolment(ath);
  ok(await api('PATCH', '/collections/policy', { token: k.owner.token, body: { organisation_id: k.org.id, suspension_enabled: true, suspend_after_days: 10 } }));
  await sweep(k, T(5));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM entitlement_suspensions WHERE enrolment_id=$1", [e.id])).rows[0].n, 0, 'not yet past the threshold');
  ok(await api('GET', '/access/pass', { token: ath.token, query: { domain: 'academy_session', subject_ref: sid } }));
  await sweep(k, T(11)); await sweep(k, T(11));
  const susp = (await pool.query("SELECT * FROM entitlement_suspensions WHERE enrolment_id=$1", [e.id])).rows;
  assert.equal(susp.length, 1); assert.equal(susp[0].status, 'active'); assert.equal(susp[0].started_by, null, 'applied by the policy');
  assert.equal((await notes(ath.id, 'collections_suspended')).length, 1);
  const blocked = await api('GET', '/access/pass', { token: ath.token, query: { domain: 'academy_session', subject_ref: sid } });
  assert.equal(blocked.status, 403); assert.match(JSON.stringify(blocked.body), /paused until a payment/i);
  const self = await api('POST', `/academy/sessions/${sid}/self-check-in`, { token: ath.token, body: { idempotency_key: key() } });
  assert.equal(self.status, 403);
  // enrolment and history are untouched
  assert.equal((await pool.query('SELECT status FROM org_enrolments WHERE id=$1', [e.id])).rows[0].status, 'enrolled');
  // paying restores access on the next run, with a record of why
  ok(await pay(k, ch.id, { method: 'upi' }));
  await sweep(k, T(12));
  assert.equal((await pool.query("SELECT status FROM entitlement_suspensions WHERE enrolment_id=$1", [e.id])).rows[0].status, 'lifted');
  assert.equal((await events((await caseOf(ch.id)).id, 'reinstated')).length, 1);
  ok(await api('GET', '/access/pass', { token: ath.token, query: { domain: 'academy_session', subject_ref: sid } }));
  assert.equal((await notes(ath.id, 'collections_access_restored')).length, 1);
  // a human can reinstate early, which also holds the case so the policy does not suspend again next run
  const s2 = await schedule(k, k.players[1], { due_dates: [T(0)], amount_minor: 1000 });
  const c2 = await chargeOf(s2.id); const e2 = await k.enrolment(k.players[1]);
  await sweep(k, T(12));
  assert.equal((await pool.query("SELECT status FROM entitlement_suspensions WHERE enrolment_id=$1", [e2.id])).rows[0].status, 'active');
  const cs2 = await caseOf(c2.id);
  assert.equal((await api('POST', `/collections/cases/${cs2.id}/actions`, { token: k.coach.token, body: { action: 'reinstate', reason: 'Not mine to decide' } })).status, 403);
  ok(await api('POST', `/collections/cases/${cs2.id}/actions`, { token: k.finance.token, body: { action: 'reinstate', reason: 'Agreed with the family' } }));
  await sweep(k, T(13));
  assert.equal((await pool.query("SELECT status FROM entitlement_suspensions WHERE enrolment_id=$1", [e2.id])).rows[0].status, 'lifted', 'not suspended again while the hold lasts');
  // suspension can be a policy choice only
  const k3 = await club(); const s3 = await schedule(k3, k3.players[0], { due_dates: [T(0)] }); await sweep(k3, T(1));
  const off = await api('POST', `/collections/cases/${(await caseOf((await chargeOf(s3.id)).id)).id}/actions`, { token: k3.owner.token, body: { action: 'suspend', reason: 'Because' } });
  assert.equal(off.status, 422);
});

// ------------------------------------------------------------------------------------------------------------------ one logic for academy, club and venue
test('academy fees, club dues and venue membership renewals all land in the same desk logic', async () => {
  // club dues (a schedule) and an academy programme fee (an instalment charge from the enrolment) share the work queue
  const k = await club({ kind: 'academy' });
  const dues = await schedule(k, k.players[0], { due_dates: [T(0)], amount_minor: 3000 });
  const prog = (await pool.query("INSERT INTO academy_programmes(organisation_id, sport, title, status, capacity) VALUES ($1,'football','U12 Football','published',20) RETURNING id", [k.org.id])).rows[0];
  const e1 = await k.enrolment(k.players[1]);
  await pool.query('UPDATE org_enrolments SET programme_id=$2 WHERE id=$1', [e1.id, prog.id]);
  const fee = (await pool.query("INSERT INTO academy_charges(enrolment_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, amount_minor, status) VALUES ($1,$2,$3,0,'instalment',current_date,'GBP',9000,9000,'awaiting_payment') RETURNING id", [e1.id, k.org.id, k.players[1].id])).rows[0];
  const list = ok(await api('GET', '/collections/cases', { token: k.finance.token, query: { organisation_id: k.org.id } }));
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items.map((i) => i.kind).sort(), ['dues', 'instalment']);
  assert.equal(list.totals.length, 1); assert.equal(list.totals[0].currency, 'GBP'); assert.equal(Number(list.totals[0].balance_minor), 12000);
  await sweep(k, T(0)); await sweep(k, T(5));
  for (const id of [(await chargeOf(dues.id)).id, fee.id]) assert.equal((await caseOf(id)).state, 'overdue');
  void fee;
  // a venue membership renewal raised by the shared subscription renewal is a case on the venue's desk
  const mgr = await signup(['venue_manager']), member = await signup(), stranger = await signup(['venue_manager']);
  const v = ok(await api('POST', '/venues', { token: mgr.token, body: { name: `Dues Arena ${n}`, timezone: 'UTC', currency: 'INR' } }), 201);
  const plan = (await pool.query("INSERT INTO venue_plans(venue_id, currency, kind, name, price_cents, duration_days, discount_bp, auto_renew) VALUES ($1,'INR','membership','Gold',150000,30,1000,true) RETURNING id", [v.id])).rows[0];
  await pool.query("INSERT INTO user_plans(plan_id, venue_id, user_id, kind, name, price_cents, currency, discount_bp, duration_days, starts_at, expires_at, auto_renew, status) VALUES ($1,$2,$3,'membership','Gold',150000,'INR',1000,30,now() - interval '27 days', now() + interval '3 days', true, 'active')", [plan.id, v.id, member.id]);
  assert.equal(await raiseSubscriptionRenewals(), 1);
  const desk = ok(await api('GET', '/collections/cases', { token: mgr.token, query: { venue_id: v.id } }));
  assert.equal(desk.items.length, 1); assert.equal(desk.items[0].kind, 'membership'); assert.equal(desk.items[0].currency, 'INR'); assert.equal(Number(desk.items[0].balance_minor), 150000);
  assert.equal((await api('GET', '/collections/cases', { token: stranger.token, query: { venue_id: v.id } })).status, 404, 'outsiders do not learn the venue exists');
  assert.equal((await api('GET', '/collections/cases', { token: mgr.token, query: { venue_id: v.id, organisation_id: k.org.id } })).status, 400);
  await runCollections({ today: T(0), ownerId: v.id });
  const vc = (await pool.query("SELECT * FROM collection_cases WHERE owner_type='venue' AND owner_id=$1", [v.id])).rows[0];
  assert.ok(['upcoming', 'due'].includes(vc.state), vc.state);
  await runCollections({ today: T(10), ownerId: v.id });
  assert.equal((await pool.query('SELECT state FROM collection_cases WHERE id=$1', [vc.id])).rows[0].state, 'overdue');
  assert.ok((await notes(member.id, 'collections_reminder')).length >= 1);
  assert.equal((await api('PATCH', '/collections/policy', { token: mgr.token, body: { venue_id: v.id, late_fee_enabled: true, late_fee_minor: 100, late_fee_currency: 'INR', late_fee_basis: 'Venue terms clause 9' } })).status, 422, 'venues have no late fee or suspension');
  ok(await api('POST', `/collections/cases/${vc.id}/actions`, { token: mgr.token, body: { action: 'promise', promised_on: T(12) } }));
  // paying the renewal through the canonical venue-plan payment closes the case as recovered
  const renewal = (await pool.query("SELECT id FROM user_plans WHERE venue_id=$1 AND status='awaiting_payment'", [v.id])).rows[0];
  const p = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','venue_plan',$2,150000,'INR','pending','vp-1') RETURNING id", [member.id, renewal.id])).rows[0];
  await settle(p.id, { paid: true, amount: 150000, currency: 'INR', paymentRef: 'pi_vp' });
  await runCollections({ today: T(11), ownerId: v.id });
  assert.equal((await pool.query('SELECT state FROM collection_cases WHERE id=$1', [vc.id])).rows[0].state, 'resolved');
});

// ------------------------------------------------------------------------------------------------------------------ reporting and access
test('ageing, forecast and recovery reports are per currency, reconcile to the desk, and respect finance roles', async () => {
  const k = await club();
  await schedule(k, k.players[0], { due_dates: [T(-0)], amount_minor: 10000, currency: 'GBP' });
  await schedule(k, k.players[1], { due_dates: [T(0)], amount_minor: 777000, currency: 'INR' });
  const future = await schedule(k, (await (async () => { const u = await signup(); ok(await api('POST', `/cohorts/${k.cohort.id}/enrolments`, { token: k.owner.token, body: { csv: `handle,consent\n${u.handle},yes` } }), 201); return u; })()), { due_dates: [T(20), T(50)], amount_minor: 3000, currency: 'GBP', raise_days_before: 30 });
  assert.equal(future.raised_now, 1);
  await sweep(k, T(10));
  const rep = ok(await api('GET', '/collections/report', { token: k.finance.token, query: { organisation_id: k.org.id, from: T(-5), to: T(5), as_of: T(10) } }));
  assert.deepEqual(rep.currencies.map((c) => c.currency), ['GBP', 'INR'], 'one block per currency, never added together');
  const gbp = rep.currencies[0], inr = rep.currencies[1];
  assert.equal(gbp.outstanding_minor, 13000); assert.equal(inr.outstanding_minor, 777000);
  assert.equal(gbp.overdue_minor, 10000); assert.equal(inr.overdue_minor, 777000);
  const bucketTotal = (c) => Object.values(c.buckets).reduce((t, b) => t + b.amount_minor, 0);
  assert.equal(bucketTotal(gbp), gbp.outstanding_minor); assert.equal(bucketTotal(inr), inr.outstanding_minor);
  assert.equal(gbp.forecast.next_30_minor, 3000 + 0, 'the raised period falling due in 30 days counts'); assert.equal(gbp.scheduled_not_yet_raised_minor, 3000, 'the second period is scheduled, not yet owed');
  assert.equal(rep.currencies.some((c) => 'total_all_currencies' in c), false);
  // the desk lists the same money
  const desk = ok(await api('GET', '/collections/cases', { token: k.owner.token, query: { organisation_id: k.org.id } }));
  assert.equal(Number(desk.totals.find((t) => t.currency === 'GBP').balance_minor), gbp.outstanding_minor);
  assert.equal(Number(desk.totals.find((t) => t.currency === 'INR').balance_minor), inr.outstanding_minor);
  assert.equal(ok(await api('GET', '/collections/cases', { token: k.owner.token, query: { organisation_id: k.org.id, currency: 'INR' } })).items.length, 1);
  assert.equal(rep.reconciles, true, JSON.stringify(rep.checks));
  const direct = await collectionsReport(k.org.id, { from: T(-5), to: T(5), today: T(10) });
  assert.deepEqual(direct.currencies.map((c) => c.outstanding_minor), rep.currencies.map((c) => c.outstanding_minor));
  // roles: a coach and a stranger cannot reach any of it
  for (const [who, status] of [['coach', 403], ['stranger', 404]]) {
    assert.equal((await api('GET', '/collections/report', { token: k[who].token, query: { organisation_id: k.org.id } })).status, status);
    assert.equal((await api('GET', '/collections/cases', { token: k[who].token, query: { organisation_id: k.org.id } })).status, status);
    assert.equal((await api('GET', '/collections/policy', { token: k[who].token, query: { organisation_id: k.org.id } })).status, status);
    assert.equal((await api('GET', '/billing-schedules', { token: k[who].token, query: { organisation_id: k.org.id } })).status, status);
  }
  // an archived organisation is read-only
  await pool.query("UPDATE organisations SET status='archived' WHERE id=$1", [k.org.id]);
  const cs = (await pool.query('SELECT id FROM collection_cases WHERE owner_id=$1 LIMIT 1', [k.org.id])).rows[0];
  assert.equal((await api('POST', `/collections/cases/${cs.id}/actions`, { token: k.owner.token, body: { action: 'note', note: 'x' } })).status, 409);
});

test('the capabilities are wired into REST, OpenAPI, MCP scopes and the maintenance worker', async () => {
  const names = ['get_collection_policy', 'set_collection_policy', 'list_collection_cases', 'get_collection_case', 'act_on_collection_case', 'adjust_academy_charge', 'approve_payment_plan', 'cancel_payment_plan', 'create_billing_schedule', 'list_billing_schedules', 'update_billing_schedule', 'get_collections_report'];
  for (const name of names) assert.ok(capabilities.some((c) => c.name === name), name);
  assert.equal(capabilities.find((c) => c.name === 'adjust_academy_charge').scope, 'payment', 'a narrow token cannot waive money');
  assert.equal(capabilities.find((c) => c.name === 'record_academy_payment').scope, 'payment');
  assert.ok(STEPS.some(([name, , fn]) => name === 'billing_schedules' && fn === raiseScheduledCharges));
  assert.ok(STEPS.some(([name, , fn]) => name === 'collections' && fn === runCollections));
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json()).paths;
  assert.ok(spec['/collections/cases'] && spec['/billing-schedules'] && spec['/academy-charges/{id}/payment-plan'] && spec['/collections/report']);
  // a read-only token can see the desk but cannot waive, schedule or act
  const owner = await signup(['athlete']);
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Token Club ${n}`, kind: 'club' } }), 201);
  const tok = ok(await api('POST', '/me/tokens', { token: owner.token, body: { name: 'reader', scopes: ['read'] } }), 201);
  const bearer = tok.token ?? tok.secret;
  assert.equal((await api('GET', '/collections/cases', { token: bearer, query: { organisation_id: org.id } })).status, 200);
  assert.equal((await api('POST', '/billing-schedules', { token: bearer, body: { organisation_id: org.id, enrolment_id: org.id, kind: 'custom', label: 'x', currency: 'GBP', amount_minor: 1, due_dates: [T(3)], idempotency_key: key() } })).status, 403);
});
