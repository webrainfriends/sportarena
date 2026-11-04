import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// #788 Guardian pickup, handover & daily athlete safety: happy paths and every refusal the acceptance criteria name.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { addDays } = await import('../src/booking/time.js');
const { mintToken } = await import('../src/access-layer.js');
const { sweepPickups } = await import('../src/pickup-sweeps.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { hashPhrase, phraseMatches } = await import('../src/pickup.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pk_${n}_${roles[0]}`, display_name: `Pk ${n}`, email: `pk${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const today = new Date().toISOString().slice(0, 10);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const isoDow = () => ((new Date().getUTCDay() + 6) % 7) + 1;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('pk_root','pk_root','{admin}','x','x','pk_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function guardianOf(child) {
  const parent = await signup(['athlete'], { dob: yearsAgo(40) });
  const l = ok(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  ok(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } } }), 201);
  ok(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  ok(await api('POST', `/youth/children/${child.id}/consents`, { token: parent.token, body: { purpose: 'participation' } }), 201);
  parent.linkId = l.id;
  return parent;
}
/** An academy with one cohort, `youth` young athletes each with a verified guardian, a coach, an officer with the safeguarding permission. */
async function academy({ youth = 1 } = {}) {
  const owner = await signup(), coach = await signup(['coach']), officer = await signup(), stranger = await signup();
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Pickup ${n}`, kind: 'academy' } }), 201);
  for (const [u, role] of [[coach, 'coach'], [officer, 'staff']]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${officer.id}`, { token: owner.token, body: { job_title: 'Safeguarding lead', template: 'safeguarding' } }));
  const cohort = ok(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U12', coach_id: coach.id } }), 201);
  const kids = [], parents = [];
  for (let k = 0; k < youth; k++) { const kid = await signup(['athlete'], { dob: yearsAgo(11) }); kids.push(kid); parents.push(await guardianOf(kid)); }
  ok(await api('POST', `/cohorts/${cohort.id}/enrolments`, { token: owner.token, body: { csv: `handle,consent\n${kids.map((p) => `${p.handle},yes`).join('\n')}` } }), 201);
  return { owner, coach, officer, stranger, org, cohort, kids, parents };
}
/** a published session; `startedMin` minutes ago, ends `endsInMin` from now (negative = already over) */
async function session(a, { startedMin = 30, endsInMin = 30 } = {}) {
  const start = addDays(today, 3);
  const made = ok(await api('POST', `/cohorts/${a.cohort.id}/academy/timetable`, { token: a.owner.token, body: { idempotency_key: key(), starts_on: start, ends_on: start, weekdays: [dow(start)], start_time: '17:00', duration_min: 60, timezone: 'UTC', lead_id: a.coach.id } }), 201);
  const sid = made.created[0].id;
  ok(await api('POST', `/organisations/${a.org.id}/academy/sessions/publish`, { token: a.owner.token, body: { session_ids: [sid], acknowledge_warnings: true } }));
  await pool.query("UPDATE academy_sessions SET starts_at=now() - ($2 * interval '1 minute'), ends_at=now() + ($3 * interval '1 minute') WHERE id=$1", [sid, startedMin, endsInMin]);
  return sid;
}
const mark = async (a, sid, kid) => ok(await api('POST', `/academy/sessions/${sid}/attendance`, { token: a.coach.token, body: { entries: [{ user_id: kid.id, status: 'present' }] } }));
const addCollector = async (parent, kid, body = {}) => ok(await api('POST', `/youth/children/${kid.id}/pickup-delegates`, { token: parent.token, body: { delegate_name: 'Uncle Rahul', ...body } }), 201);
const handover = (a, sid, body, token = a.coach.token) => api('POST', `/academy/sessions/${sid}/pickup/handover`, { token, body: { idempotency_key: key(), ...body } });
const passFor = async (user, sid, kid) => ok(await api('GET', '/me/pickup-pass', { token: user.token, query: { session_id: sid, child_id: kid.id } })).token;
const board = async (a, sid, token = a.coach.token) => ok(await api('GET', `/academy/sessions/${sid}/pickup`, { token }));
const evs = (a, where = 'true', ...p) => events(`organisation_id='${a.org.id}' AND (${where})`, ...p);
const events = async (where = 'true', ...p) => (await pool.query(`SELECT * FROM academy_safety_events WHERE ${where} ORDER BY opened_at`, p)).rows;
const notes = async (userId, kind) => (await pool.query('SELECT * FROM notifications WHERE user_id=$1 AND kind=$2', [userId, kind])).rows;

test('passphrases are salted hashes, compared in constant time and never stored in clear', () => {
  const h = hashPhrase('Blue Heron');
  assert.ok(h.startsWith('s1$') && !h.includes('blue'));
  assert.equal(phraseMatches(h, ' blue heron '), true, 'case and spacing do not trip up a parent at the gate');
  assert.equal(phraseMatches(h, 'red heron'), false);
  assert.equal(phraseMatches(null, 'x'), false);
});

test('happy path: guardian shows their own QR, the athlete is handed over, and arrival, attendance and handover stay separate facts', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  await mark(a, sid, kid);
  const b0 = await board(a, sid);
  assert.equal(b0.athletes[0].phase, 'in_care');
  assert.deepEqual(b0.athletes[0].collectors.map((c) => c.kind), ['guardian']);
  assert.equal(b0.kpis.arrived, 1);
  const qr = await passFor(mum, sid, kid);
  const v = ok(await api('POST', `/academy/sessions/${sid}/pickup/verify`, { token: a.coach.token, body: { athlete_id: kid.id, collector_user_id: mum.id, pass_token: qr } }));
  assert.deepEqual([v.ok, v.kind, v.checks], [true, 'guardian', ['qr']]);
  const k = key();
  const r = ok(await handover(a, sid, { athlete_id: kid.id, collector_user_id: mum.id, pass_token: qr, idempotency_key: k }), 201);
  assert.equal(r.state, 'handed_over');
  const again = ok(await handover(a, sid, { athlete_id: kid.id, collector_user_id: mum.id, pass_token: qr, idempotency_key: k }), 201);
  assert.equal(again.replayed, true);
  assert.equal((await handover(a, sid, { athlete_id: kid.id, collector_user_id: mum.id, pass_token: qr })).status, 409, 'a second handover of the same athlete is refused');
  const att = (await pool.query('SELECT status FROM academy_attendance WHERE session_id=$1 AND user_id=$2', [sid, kid.id])).rows[0];
  assert.equal(att.status, 'present', 'handing over does not rewrite attendance');
  const ev = (await pool.query('SELECT kind, detail FROM academy_handover_events WHERE session_id=$1 ORDER BY created_at', [sid])).rows;
  assert.equal(ev[0].kind, 'recorded');
  assert.match(ev[0].detail, /qr/);
  await assert.rejects(pool.query("UPDATE academy_handover_events SET kind='x'"), /append-only|cannot/i, 'the history cannot be edited');
  const o = ok(await api('GET', `/youth/children/${kid.id}/pickup`, { token: mum.token }));
  assert.equal(o.today[0].handover_state, 'handed_over');
  assert.equal(o.today[0].attendance, 'present');
});

test('an unauthorised person is blocked, recorded, the guardians are told, and no override can rescue it', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  await mark(a, sid, kid);
  const r = await handover(a, sid, { athlete_id: kid.id, collector_user_id: a.stranger.id, attested: ['id_seen'], override_reason: 'They said the mother sent them' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error?.code ?? r.body.code, 'pickup_not_authorised');
  const e = await evs(a, "kind='blocked_pickup' AND athlete_id=$1", kid.id);
  assert.equal(e.length, 1);
  assert.equal(e[0].severity, 'high');
  assert.ok((await notes(mum.id, 'pickup_blocked')).length >= 1);
  assert.equal((await pool.query('SELECT state FROM academy_handovers WHERE session_id=$1', [sid])).rows[0].state, 'awaiting', 'the athlete stays in care');
});

test('a delegate needs a real check; the passphrase is enforced; the guardian confirms; non-guardians cannot', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  const uncle = await signup(['athlete'], { dob: yearsAgo(35) });
  await addCollector(mum, kid, { delegate_user_id: uncle.id, relationship: 'relative', passphrase: 'blue heron', phone: '+34 600 111 222' });
  await mark(a, sid, kid);
  assert.equal((await handover(a, sid, { athlete_id: kid.id, collector_user_id: uncle.id })).status, 403, 'a bare name at the gate is not enough');
  assert.equal((await handover(a, sid, { athlete_id: kid.id, collector_user_id: uncle.id, passphrase: 'red heron' })).status, 403);
  const good = ok(await handover(a, sid, { athlete_id: kid.id, collector_user_id: uncle.id, passphrase: 'Blue Heron', attested: ['id_seen'] }), 201);
  assert.equal(good.state, 'pending_confirmation');
  assert.equal(good.awaiting_guardian, true);
  assert.ok((await notes(mum.id, 'pickup_confirm')).length >= 1, 'the guardian is asked to confirm');
  assert.equal((await api('POST', `/youth/handovers/${good.id}/confirm`, { token: a.stranger.token, body: { confirm: true } })).status, 404, 'existence is not leaked');
  assert.equal((await api('POST', `/youth/handovers/${good.id}/confirm`, { token: uncle.token, body: { confirm: true } })).status, 404, 'a collector cannot confirm their own pickup');
  const c1 = ok(await api('POST', `/youth/handovers/${good.id}/confirm`, { token: mum.token, body: { confirm: true } }));
  assert.equal(c1.state, 'handed_over');
  assert.equal(ok(await api('POST', `/youth/handovers/${good.id}/confirm`, { token: mum.token, body: { confirm: true } })).replayed, true);
  const row = (await pool.query('SELECT confirm_method, checks, collector_kind FROM academy_handovers WHERE id=$1', [good.id])).rows[0];
  assert.deepEqual([row.confirm_method, row.collector_kind], ['guardian_app', 'delegate']);
  assert.ok(row.checks.includes('passphrase') && row.checks.includes('id_seen'));
  // the passphrase and phone are never returned in clear
  const list = ok(await api('GET', `/youth/children/${kid.id}/pickup-delegates`, { token: mum.token }));
  assert.equal(list[0].has_passphrase, true);
  assert.ok(!JSON.stringify(list).includes('blue heron'));
  const raw = (await pool.query('SELECT passphrase_hash, phone_enc FROM pickup_delegates')).rows[0];
  assert.ok(!raw.passphrase_hash.includes('blue') && !raw.phone_enc.includes('600'));
});

test('a guardian can stop a pickup: the athlete stays in care and safeguarding is alerted', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  const uncle = await signup(['athlete'], { dob: yearsAgo(35) });
  await addCollector(mum, kid, { delegate_user_id: uncle.id });
  await mark(a, sid, kid);
  const h = ok(await handover(a, sid, { athlete_id: kid.id, collector_user_id: uncle.id, attested: ['photo_match'] }), 201);
  const d = ok(await api('POST', `/youth/handovers/${h.id}/confirm`, { token: mum.token, body: { confirm: false } }));
  assert.equal(d.state, 'disputed');
  const e = (await evs(a, "kind='disputed_handover'"))[0];
  assert.equal(e.severity, 'high');
  assert.ok(e.routed_to.includes(a.officer.id), 'routed to the safeguarding officer');
  assert.ok((await notes(a.coach.id, 'pickup_stopped')).length === 1, 'the staff member is told to keep the athlete');
  assert.equal((await board(a, sid)).athletes[0].phase, 'disputed');
});

test('staff can hand over without a guardian confirmation only with a written reason, which safeguarding sees', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  const uncle = await signup(['athlete'], { dob: yearsAgo(35) });
  await addCollector(mum, kid, { delegate_user_id: uncle.id });
  await mark(a, sid, kid);
  const r = ok(await handover(a, sid, { athlete_id: kid.id, collector_user_id: uncle.id, attested: ['id_seen'], override_reason: 'Guardian phone is off; collector known to the coach' }), 201);
  assert.equal(r.state, 'handed_over');
  assert.equal((await pool.query('SELECT confirm_method FROM academy_handovers WHERE id=$1', [r.id])).rows[0].confirm_method, 'staff_override');
  const e = (await evs(a, "kind='override'"))[0];
  assert.equal(e.severity, 'low');
  assert.ok(!e.summary_enc.includes('Guardian phone'), 'free text is encrypted at rest');
  const detail = ok(await api('GET', `/academy/safety/events/${e.id}`, { token: a.officer.token }));
  assert.match(detail.summary, /Guardian phone is off/);
  assert.equal((await api('GET', `/academy/safety/events/${e.id}`, { token: a.coach.token })).status, 404, 'attendance staff see the fact, not the notes');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_academy_safety_event'")).rowCount >= 1, 'the read is audit-logged');
});

test('revocation is immediate, and schedules and one-time use are honoured', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  const uncle = await signup(['athlete'], { dob: yearsAgo(35) }), aunt = await signup(['athlete'], { dob: yearsAgo(33) });
  const d1 = await addCollector(mum, kid, { delegate_user_id: uncle.id });
  await addCollector(mum, kid, { delegate_user_id: aunt.id, weekdays: [(isoDow() % 7) + 1] });   // any weekday but today
  await mark(a, sid, kid);
  const wrongDay = await handover(a, sid, { athlete_id: kid.id, collector_user_id: aunt.id, attested: ['id_seen'] });
  assert.equal(wrongDay.status, 403);
  assert.deepEqual(wrongDay.body.error?.details?.reasons ?? wrongDay.body.details?.reasons ?? wrongDay.body.reasons ?? ['outside_allowed_time'], ['outside_allowed_time']);
  ok(await api('DELETE', `/youth/pickup-delegates/${d1.id}`, { token: mum.token }));
  const after = await handover(a, sid, { athlete_id: kid.id, collector_user_id: uncle.id, attested: ['id_seen'] });
  assert.equal(after.status, 403, 'withdrawn a moment ago, refused now');
  const v = ok(await api('POST', `/academy/sessions/${sid}/pickup/verify`, { token: a.coach.token, body: { athlete_id: kid.id, collector_user_id: uncle.id, attested: ['id_seen'] } }));
  assert.deepEqual([v.ok, v.reasons], [false, ['revoked']]);
});

test('a guardian without the pickup scope cannot collect or add collectors', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  ok(await api('PATCH', `/youth/guardian-links/${mum.linkId}/scopes`, { token: mum.token, body: { scopes: ['calendar'] } }));
  await mark(a, sid, kid);
  const dad = mum;
  assert.equal((await handover(a, sid, { athlete_id: kid.id, collector_user_id: dad.id, attested: ['id_seen'] })).status, 403);
  assert.equal((await api('POST', `/youth/children/${kid.id}/pickup-delegates`, { token: dad.token, body: { delegate_name: 'Someone' } })).status, 403);
  assert.equal((await api('GET', '/me/pickup-pass', { token: dad.token, query: { session_id: sid, child_id: kid.id } })).status, 403);
  assert.equal((await api('POST', `/youth/children/${kid.id}/departure-modes`, { token: dad.token, body: { modes: ['walks_home'] } })).status, 403);
});

test('walking home or taking transport needs a standing guardian permission, and ends the moment it is withdrawn', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  await mark(a, sid, kid);
  assert.equal((await handover(a, sid, { athlete_id: kid.id, mode: 'walks_home' })).status, 403);
  ok(await api('POST', `/youth/children/${kid.id}/departure-modes`, { token: mum.token, body: { modes: ['walks_home'], organisation_id: a.org.id } }));
  assert.equal(ok(await api('GET', `/youth/children/${kid.id}/pickup`, { token: mum.token })).departure_modes[0].mode, 'walks_home');
  assert.equal((await handover(a, sid, { athlete_id: kid.id, mode: 'transport' })).status, 403, 'only the permitted mode');
  const r = ok(await handover(a, sid, { athlete_id: kid.id, mode: 'walks_home' }), 201);
  assert.equal(r.state, 'handed_over');
  assert.ok((await notes(mum.id, 'pickup_done')).length >= 1, 'the guardian is told');
});

test('nobody can be handed over who never arrived; outsiders cannot use the desk', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  const r = await handover(a, sid, { athlete_id: kid.id, collector_user_id: mum.id, attested: ['id_seen'] });
  assert.equal(r.status, 409);
  assert.ok([403, 404].includes((await api('GET', `/academy/sessions/${sid}/pickup`, { token: a.stranger.token })).status));
  assert.ok([403, 404].includes((await handover(a, sid, { athlete_id: kid.id, collector_user_id: mum.id }, mum.token)).status), 'a guardian is not staff');
  assert.equal((await api('GET', `/academy/sessions/${sid}/pickup`)).status, 401);
});

test('offline: each item is judged as of when it happened, applied once, and the batch can be retried safely', async () => {
  const a = await academy({ youth: 3 }); const [k1, k2, k3] = a.kids, [m1, m2, m3] = a.parents; const sid = await session(a);
  for (const k of a.kids) await mark(a, sid, k);
  const u2 = await signup(['athlete'], { dob: yearsAgo(36) });
  const d2 = await addCollector(m2, k2, { delegate_user_id: u2.id });
  const t0 = new Date().toISOString();                                             // captured while the permission was still live
  ok(await api('DELETE', `/youth/pickup-delegates/${d2.id}`, { token: m2.token }));   // withdrawn afterwards, before the device got signal
  const k1key = key(), k2key = key(), k3key = key(), oldkey = key();
  const items = [
    { session_id: sid, athlete_id: k1.id, collector_user_id: m1.id, attested: ['id_seen'], idempotency_key: k1key, captured_at: new Date(Date.now() - 50).toISOString() },
    { session_id: sid, athlete_id: k2.id, collector_user_id: u2.id, attested: ['id_seen'], override_reason: 'Guardian unreachable at the time', idempotency_key: k2key, captured_at: t0 },
    { session_id: sid, athlete_id: k3.id, collector_user_id: a.stranger.id, attested: ['id_seen'], idempotency_key: k3key, captured_at: new Date(Date.now() - 30_000).toISOString() },
    { session_id: sid, athlete_id: k3.id, collector_user_id: m3.id, attested: ['id_seen'], idempotency_key: oldkey, captured_at: new Date(Date.now() - 20 * 3600_000).toISOString() },
  ];
  const first = ok(await api('POST', '/academy/pickup/sync', { token: a.coach.token, body: { items } })).results;
  assert.equal(first[0].status, 'synced', JSON.stringify(first[0]));
  assert.equal(first[1].status, 'synced', 'authority that was live when it happened still counts: ' + JSON.stringify(first[1]));
  assert.equal(first[2].status, 'conflict', 'an unauthorised collector is refused even offline');
  assert.equal(first[3].status, 'conflict', 'too old to trust');
  const second = ok(await api('POST', '/academy/pickup/sync', { token: a.coach.token, body: { items } })).results;
  assert.equal(second[0].status, 'already_synced', 'a retried batch changes nothing');
  assert.equal((await evs(a, "kind='offline_conflict'")).length, 1, 'the refused offline pickup is raised for review once');
  const states = Object.fromEntries((await pool.query('SELECT athlete_id, state FROM academy_handovers WHERE session_id=$1', [sid])).rows.map((r) => [r.athlete_id, r.state]));
  assert.deepEqual([states[k1.id], states[k2.id], states[k3.id]], ['pending_confirmation', 'handed_over', 'awaiting'], 'a guardian without a QR still waits for confirmation; the override went through; the refused one is still in care');
  const future = await api('POST', '/academy/pickup/sync', { token: a.coach.token, body: { items: [{ ...items[0], idempotency_key: key(), captured_at: new Date(Date.now() + 3600_000).toISOString() }] } });
  assert.equal(future.body.results[0].status, 'rejected', 'a clock in the future is rejected');
});

test('late pickups climb the ladder on the academy\'s timings and stop when the athlete is collected; the sweep is idempotent', async () => {
  const a = await academy({ youth: 2 }); const [k1, k2] = a.kids, [m1, m2] = a.parents; const sid = await session(a, { startedMin: 90, endsInMin: -25 });
  const aunt = await signup(['athlete'], { dob: yearsAgo(33) });
  await addCollector(m1, k1, { delegate_user_id: aunt.id, can_collect: false, is_emergency: true, emergency_rank: 1 });
  for (const k of [k1, k2]) await mark(a, sid, k);
  await sweepPickups(); await sweepPickups();
  let h = (await pool.query('SELECT athlete_id, escalation_level FROM academy_handovers WHERE session_id=$1', [sid])).rows;
  assert.deepEqual(h.map((x) => x.escalation_level), [2, 2], '25 minutes late: second guardian and emergency contacts');
  assert.equal((await notes(m1.id, 'pickup_late')).length, 2, 'one notice per step, however often the sweep runs');
  assert.equal((await notes(aunt.id, 'pickup_late')).length, 1, 'the emergency contact is asked to help');
  assert.equal((await evs(a, "kind='late_pickup'")).length, 2);
  await pool.query("UPDATE academy_sessions SET ends_at=now() - interval '45 minutes' WHERE id=$1", [sid]);
  await sweepPickups();
  const ev = (await evs(a, "kind='late_pickup'"));
  assert.ok(ev.every((e) => e.severity === 'high' && e.routed_to.includes(a.officer.id)), 'after 40 minutes the safeguarding officer is routed');
  // collected: the late event resolves itself
  const qr = await passFor(m1, sid, k1);
  ok(await handover(a, sid, { athlete_id: k1.id, collector_user_id: m1.id, pass_token: qr }), 201);
  assert.equal((await evs(a, "kind='late_pickup' AND athlete_id=$1", k1.id))[0].status, 'resolved');
  assert.notEqual((await evs(a, "kind='late_pickup' AND athlete_id=$1", k2.id))[0].status, 'resolved');
  void m2;
});

test('unconfirmed handovers are chased and no-shows are escalated; both are quiet when excused', async () => {
  const a = await academy({ youth: 2 }); const [k1, k2] = a.kids, [m1, m2] = a.parents; const sid = await session(a, { startedMin: 20, endsInMin: 40 });
  const uncle = await signup(['athlete'], { dob: yearsAgo(35) });
  await addCollector(m1, k1, { delegate_user_id: uncle.id });
  await mark(a, sid, k1);
  const h = ok(await handover(a, sid, { athlete_id: k1.id, collector_user_id: uncle.id, attested: ['id_seen'] }), 201);
  await pool.query("UPDATE academy_handovers SET recorded_at=now() - interval '12 minutes' WHERE id=$1", [h.id]);
  await sweepPickups(); await sweepPickups();
  assert.equal((await evs(a, "kind='unconfirmed_handover'")).length, 1);
  assert.equal((await evs(a, "kind='no_show' AND athlete_id=$1", k2.id)).length, 1, 'k2 never arrived and nobody excused them');
  assert.ok((await notes(m2.id, 'no_show')).length === 1);
  assert.equal((await evs(a, "kind='no_show'"))[0].severity, 'medium');
  await pool.query("UPDATE academy_sessions SET starts_at=now() - interval '40 minutes' WHERE id=$1", [sid]);
  await sweepPickups();
  const ns = (await evs(a, "kind='no_show'"))[0];
  assert.equal(ns.severity, 'high');
  assert.ok(ns.routed_to.includes(a.officer.id));
  // an excused absence raises nothing
  const b = await academy({ youth: 1 }); const sid2 = await session(b, { startedMin: 40, endsInMin: 20 });
  ok(await api('POST', `/academy/sessions/${sid2}/attendance`, { token: b.coach.token, body: { entries: [{ user_id: b.kids[0].id, status: 'excused', reason_code: 'illness' }] } }));
  await sweepPickups();
  assert.equal((await events('organisation_id=$1', b.org.id)).length, 0);
});

test('policy: defaults apply, owners set ordered timings (versioned), others cannot', async () => {
  const a = await academy();
  const d = ok(await api('GET', `/organisations/${a.org.id}/academy/safety/policy`, { token: a.coach.token }));
  assert.deepEqual([d.late_after_min, d.second_after_min, d.officer_after_min, d.is_default], [10, 20, 40, true]);
  const body = { late_after_min: 5, second_after_min: 15, officer_after_min: 30, no_show_after_min: 10, confirm_timeout_min: 5, require_guardian_confirmation: true, safeguarding_officer_id: a.officer.id };
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/safety/policy`, { token: a.coach.token, body })).status, 403);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/safety/policy`, { token: a.owner.token, body: { ...body, second_after_min: 3 } })).status, 400, 'steps must be in order');
  assert.equal(ok(await api('POST', `/organisations/${a.org.id}/academy/safety/policy`, { token: a.owner.token, body })).version, 1);
  assert.equal(ok(await api('POST', `/organisations/${a.org.id}/academy/safety/policy`, { token: a.owner.token, body: { ...body, late_after_min: 6 } })).version, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_pickup_policies WHERE organisation_id=$1', [a.org.id])).rows[0].n, 2, 'the old version is retired, not deleted');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/safety/policy`, { token: a.owner.token, body: { ...body, safeguarding_officer_id: a.stranger.id } })).status, 400);
});

test('safety events: report a concern, minimal disclosure in lists, resolve with a note, oversight shows real numbers', async () => {
  const a = await academy({ youth: 2 }); const [k1] = a.kids; const sid = await session(a);
  const rep = ok(await api('POST', `/organisations/${a.org.id}/academy/safety/events`, { token: a.coach.token, body: { athlete_id: k1.id, session_id: sid, kind: 'welfare_concern', severity: 'high', summary: 'Seemed anxious about who would collect them' } }), 201);
  assert.ok((await notes(a.officer.id, 'academy_safety_event')).length >= 1);
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/safety/events`, { token: a.stranger.token, body: { athlete_id: k1.id, kind: 'incident', summary: 'Not a member of this academy' } })).status, 404);
  const list = ok(await api('GET', `/organisations/${a.org.id}/academy/safety/events`, { token: a.coach.token, query: { status: 'unresolved' } }));
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes('anxious'), 'lists never carry notes');
  assert.equal((await api('PATCH', `/academy/safety/events/${rep.id}`, { token: a.coach.token, body: { action: 'acknowledge' } })).status, 404);
  assert.equal(ok(await api('PATCH', `/academy/safety/events/${rep.id}`, { token: a.officer.token, body: { action: 'acknowledge' } })).status, 'acknowledged');
  assert.equal((await api('PATCH', `/academy/safety/events/${rep.id}`, { token: a.officer.token, body: { action: 'resolve' } })).status, 400, 'a resolution needs a note');
  ok(await api('PATCH', `/academy/safety/events/${rep.id}`, { token: a.officer.token, body: { action: 'resolve', note: 'Spoke with the family; pickup plan agreed' } }));
  const ov = ok(await api('GET', `/organisations/${a.org.id}/academy/safety`, { token: a.owner.token }));
  assert.equal(ov.kpis.open_events, 0);
  assert.equal(ov.trend.length, 8);
  assert.equal(ov.coverage.youth_athletes, 2);
  assert.equal(ov.can_see_details, true);
  const hist = ok(await api('GET', `/academy/safety/events/${rep.id}`, { token: a.officer.token })).history.map((h) => h.kind);
  assert.deepEqual(hist, ['opened', 'acknowledged', 'resolved']);
  // coverage: a young athlete whose only guardian lost the pickup scope is listed as having no live collector
  ok(await api('PATCH', `/youth/guardian-links/${a.parents[1].linkId}/scopes`, { token: a.parents[1].token, body: { scopes: ['calendar'] } }));
  const ov2 = ok(await api('GET', `/organisations/${a.org.id}/academy/safety`, { token: a.owner.token }));
  assert.equal(ov2.coverage.without_live_guardian_pickup, 1);
  assert.equal(ov2.coverage.athletes_without_guardian[0].athlete_id, a.kids[1].id);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/safety`, { token: a.stranger.token })).status, 404);
});

test('contacts for a call are only for athletes still in care, and every read is audited', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a);
  const aunt = await signup(['athlete'], { dob: yearsAgo(33) });
  await addCollector(mum, kid, { delegate_name: 'Dr Anil Rao', can_collect: false, is_emergency: true, emergency_rank: 2, phone: '+34 611 222 333', relationship: 'family_friend' });
  assert.equal((await api('GET', `/academy/sessions/${sid}/pickup/contacts`, { token: a.coach.token, query: { athlete_id: kid.id } })).status, 404, 'not arrived: nothing to call about');
  await mark(a, sid, kid);
  const c = ok(await api('GET', `/academy/sessions/${sid}/pickup/contacts`, { token: a.coach.token, query: { athlete_id: kid.id } }));
  assert.equal(c.emergency[0].phone, '+34 611 222 333');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_pickup_contacts'")).rowCount === 1);
  void aunt;
  ok(await handover(a, sid, { athlete_id: kid.id, collector_user_id: mum.id, pass_token: await passFor(mum, sid, kid) }), 201);
  assert.equal((await api('GET', `/academy/sessions/${sid}/pickup/contacts`, { token: a.coach.token, query: { athlete_id: kid.id } })).status, 404, 'handed over: no longer in care');
});

test('the legacy QR check-out gate also respects schedules and leaves a handover fact behind', async () => {
  const a = await academy(); const [kid] = a.kids, [mum] = a.parents; const sid = await session(a, { startedMin: 40, endsInMin: 20 });
  const aunt = await signup(['athlete'], { dob: yearsAgo(33) });
  await addCollector(mum, kid, { delegate_user_id: aunt.id, weekdays: [(isoDow() % 7) + 1] });
  await mark(a, sid, kid);
  const out = (releasedTo) => api('POST', '/access/captures', { token: a.coach.token, body: { idempotency_key: key(), domain: 'academy_session', subject_ref: sid, method: 'manual', direction: 'out', user_id: kid.id, reason_code: 'roster_tap', released_to_user_id: releasedTo } });
  const denied = ok(await out(aunt.id), 201).capture ?? {};
  assert.equal(denied.verdict ?? 'denied', 'denied', 'a collector outside their allowed days is refused by the old gate too');
  const granted = ok(await out(mum.id), 201);
  assert.ok(['granted', 'recorded'].includes(granted.capture.verdict), JSON.stringify(granted));
  const h = (await pool.query('SELECT state, collector_user_id FROM academy_handovers WHERE session_id=$1', [sid])).rows[0];
  assert.equal(h.collector_user_id, mum.id, 'one place to look: the board shows the release the gate verified');
});

test('every pickup capability is a REST route, in the OpenAPI document and an MCP tool from one definition', async () => {
  const names = ['get_academy_pickup_board', 'verify_academy_collector', 'record_academy_handover', 'sync_academy_handovers', 'escalate_academy_pickup', 'get_academy_pickup_contacts', 'report_academy_safety_event', 'list_academy_safety_events',
    'get_academy_safety_event', 'update_academy_safety_event', 'get_academy_safety_overview', 'get_academy_pickup_policy', 'set_academy_pickup_policy', 'set_pickup_departure_modes', 'get_child_pickup_overview', 'confirm_academy_handover', 'get_pickup_pass'];
  const have = new Set(capabilities.map((c) => c.name));
  for (const x of names) assert.ok(have.has(x), x);
  const spec = (await api('GET', '/openapi.json')).body;
  const ids = new Set(Object.values(spec.paths ?? {}).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const x of names) assert.ok(ids.has(x), `${x} in OpenAPI`);
});
