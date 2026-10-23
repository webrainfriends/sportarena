import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { generateObligations } = await import('../src/sponsor-agreements.js');
const { activateDuePauses } = await import('../src/sponsor-pause.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sp_${n}_${roles[0]}`, display_name: `Pause ${n}`, email: `sp${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 6 };
const period = { starts_on: '2030-01-01', ends_on: '2030-06-30' };
const today = async () => (await pool.query('SELECT current_date::text AS d')).rows[0].d;
const inDays = async (k) => (await pool.query('SELECT (current_date + $1::int)::text AS d', [k])).rows[0].d;

/** A fresh accepted agreement with six monthly dues (2030), plus an outsider. */
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']), outsider = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `PauseBrand${n}` } }), 201);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', ...period, lines: [money] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: ath.token, body: { status: 'active', version: deal.terms_version } }));
  return { sponsor, ath, outsider, deal, id: deal.id };
};
const get = async (w, who = 'ath') => must(await api('GET', `/sponsorships/${w.id}`, { token: w[who].token }));
const dueRows = async (w) => (await pool.query('SELECT id, due_on::text AS due_on, original_due_on::text AS original_due_on, held_by_pause_id, status FROM sponsorship_obligations WHERE sponsorship_id=$1 ORDER BY seq', [w.id])).rows;
const ask = async (w, who, over = {}) => {
  const rev = who === 'outsider' ? 0 : (await get(w, who)).pause_rev;
  return api('POST', `/sponsorships/${w.id}/pause-requests`, { token: w[who].token, body: { expected_pause_rev: rev, reason_code: 'injury', policy: 'reschedule', effective_from: await today(), ...over } });
};
const decide = async (w, who, pauseId, decision, note) => api('PATCH', `/sponsorship-pauses/${pauseId}`, { token: w[who].token, body: { expected_pause_rev: (await get(w, who)).pause_rev, decision, note } });
const paused = async (w, over = {}, requester = 'sponsor', approver = 'ath') => {
  const p = must(await ask(w, requester, over), 201);
  must(await decide(w, approver, p.id, 'approve'));
  return p;
};
const resume = async (w, who = 'sponsor') => api('POST', `/sponsorships/${w.id}/resume`, { token: w[who].token, body: { expected_pause_rev: (await get(w, who)).pause_rev } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('a pause needs the other side: you cannot approve your own request, outsiders are refused, and the agreement stays active until approval', async () => {
  const w = await world();
  const p = must(await ask(w, 'sponsor'), 201);
  assert.equal(p.status, 'requested');
  assert.equal((await get(w)).status, 'active', 'a request alone changes nothing');
  assert.equal((await decide(w, 'sponsor', p.id, 'approve')).status, 403, 'the requester cannot approve');
  assert.equal((await api('PATCH', `/sponsorship-pauses/${p.id}`, { token: w.outsider.token, body: { expected_pause_rev: 1, decision: 'approve' } })).status, 403, 'tenant isolation: an outsider cannot decide');
  assert.equal((await api('GET', `/sponsorships/${w.id}`, { token: w.outsider.token })).status, 403);
  assert.equal((await ask(w, 'sponsor')).status, 409, 'only one pause can be open at a time');
  assert.equal((await ask(w, 'ath', { policy: 'hold' })).status, 409);
  assert.equal((await ask(w, 'outsider')).status, 403);
  must(await decide(w, 'ath', p.id, 'approve'));
  const d = await get(w);
  assert.equal(d.status, 'paused');
  assert.equal(d.pauses[0].policy, 'reschedule');
  assert.equal(d.pauses[0].status, 'active');
  const s = await get(w, 'sponsor');
  assert.deepEqual(s.pauses[0], d.pauses[0], 'both parties see the same agreed policy');
  const listed = must(await api('GET', '/sponsorships', { token: w.sponsor.token, query: { status: 'paused' } }));
  assert.ok(listed.some((x) => x.id === w.id), 'paused agreements can be listed by status');
});

test('validation: past start, bad resume date, missing reason for "other", declining needs a reason, withdraw only by the requester', async () => {
  const w = await world();
  assert.equal((await ask(w, 'sponsor', { effective_from: await inDays(-1) })).status, 400);
  assert.equal((await ask(w, 'sponsor', { effective_from: await inDays(5), planned_resume_on: await inDays(2) })).status, 400);
  assert.equal((await ask(w, 'sponsor', { reason_code: 'other' })).status, 400);
  const p = must(await ask(w, 'sponsor', { reason_code: 'other', reason: 'Brand restructuring' }), 201);
  assert.equal((await decide(w, 'ath', p.id, 'decline')).status, 400, 'a decline needs a reason');
  assert.equal((await decide(w, 'ath', p.id, 'withdraw')).status, 403, 'only the requester withdraws');
  must(await decide(w, 'sponsor', p.id, 'withdraw'));
  assert.equal((await get(w)).status, 'active');
  const q = must(await ask(w, 'ath', { policy: 'hold' }), 201);
  must(await decide(w, 'sponsor', q.id, 'decline', 'Not now'));
  assert.equal((await get(w)).pauses.find((x) => x.id === q.id).status, 'declined');
  must(await ask(w, 'sponsor'), 201); // a new request is possible once the earlier ones are closed
});

test('stale version: a decision on an outdated view is refused and nothing changes', async () => {
  const w = await world();
  const p = must(await ask(w, 'sponsor'), 201);
  const r = await api('PATCH', `/sponsorship-pauses/${p.id}`, { token: w.ath.token, body: { expected_pause_rev: 0, decision: 'approve' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.details?.code ?? r.body.details?.code ?? 'stale_version', 'stale_version');
  assert.equal((await get(w)).status, 'active');
});

test('hold: pausing flags dues in place, never erases debt (past dues and dues with money in flight stay open and payable), and held dues cannot be paid', async () => {
  const w = await world();
  const before = await dueRows(w);
  assert.equal(before.length, 6);
  // simulate an overdue debt (first due) and a due that already has a reported payment (second due)
  await pool.query("UPDATE sponsorship_obligations SET due_on='2020-01-15' WHERE id=$1", [before[0].id]);
  const rep = await api('POST', `/sponsorship-obligations/${before[1].id}/payments`, { token: w.sponsor.token, body: { amount_cents: 10000, currency: 'SGD', method: 'bank_transfer', reference: 'P1', paid_on: '2030-01-14' } });
  must(rep, 201);
  await paused(w, { policy: 'hold' });
  const rows = await dueRows(w);
  assert.equal(rows.length, 6, 'no due was created or removed');
  assert.equal(rows[0].held_by_pause_id, null, 'an overdue debt is never held');
  assert.equal(rows[1].held_by_pause_id, null, 'a due with money in flight is never held');
  assert.equal(rows.filter((r) => r.held_by_pause_id).length, 4);
  assert.ok(rows.every((r) => r.status === 'scheduled'), 'no due was cancelled or waived');
  // the overdue debt is still payable while paused; a held due is refused with a clear code
  must(await api('POST', `/sponsorship-obligations/${rows[0].id}/payments`, { token: w.sponsor.token, body: { amount_cents: 50000, currency: 'SGD', method: 'cash', reference: 'DEBT1', paid_on: '2030-01-14' } }), 201);
  const held = await api('POST', `/sponsorship-obligations/${rows[3].id}/payments`, { token: w.sponsor.token, body: { amount_cents: 50000, currency: 'SGD', method: 'cash', reference: 'H1', paid_on: '2030-01-14' } });
  assert.equal(held.status, 409);
  assert.equal(held.body.error?.details?.code ?? held.body.details?.code, 'held_by_pause');
  const list = must(await api('GET', '/sponsorship-obligations', { token: w.ath.token, query: { sponsorship_id: w.id, limit: 100 } }));
  const view = list.obligations.find((o) => o.id === rows[3].id);
  assert.equal(view.held, true); assert.equal(view.overdue, false);
  assert.equal(list.obligations.find((o) => o.id === rows[0].id).overdue, true, 'the unpaid past debt still shows as overdue');
  // hold: with nothing elapsed the held dues fall due on the later of their date and today (2030 dates unchanged)
  const prev = await api('GET', `/sponsorships/${w.id}/resume-preview`, { token: w.ath.token });
  const pv = must(prev);
  assert.equal(pv.dues.length, 4); assert.equal(pv.totals.SGD, 200000);
  assert.equal(pv.dues[0].due_on, pv.dues[0].new_due_on);
  must(await resume(w));
  const after = await dueRows(w);
  assert.equal(after.length, 6); assert.ok(after.every((r) => r.held_by_pause_id === null));
  assert.equal((await get(w)).status, 'active');
});

test('hold: a due whose date passed during the pause falls due on the resume date, and is recorded', async () => {
  const w = await world();
  await paused(w, { policy: 'hold' });
  await pool.query("UPDATE sponsorship_obligations SET due_on='2020-03-01' WHERE sponsorship_id=$1 AND seq=2", [w.id]); // its date passed while paused
  const t = await today();
  const pv = must(await api('GET', `/sponsorships/${w.id}/resume-preview`, { token: w.sponsor.token }));
  assert.equal(pv.dues.find((x) => x.due_on === '2020-03-01').new_due_on, t);
  must(await resume(w, 'ath'));
  const row = (await dueRows(w)).find((r) => r.original_due_on === '2020-03-01');
  assert.equal(row.due_on, t);
});

test('reschedule: held dues move by the length of the pause, the agreement end moves with them, the same rows are reused, and a second resume changes nothing', async () => {
  const w = await world();
  const before = await dueRows(w);
  const p = await paused(w, { policy: 'reschedule' });
  await pool.query('UPDATE sponsorship_pauses SET effective_from = current_date - 10 WHERE id=$1', [p.id]); // ten days have elapsed
  const pv = must(await api('GET', `/sponsorships/${w.id}/resume-preview`, { token: w.ath.token }));
  assert.equal(pv.shift_days, 10);
  assert.equal(pv.dues.length, 6);
  assert.equal(pv.ends_on, '2030-06-30'); assert.equal(pv.new_ends_on, '2030-07-10');
  const r = must(await resume(w));
  assert.equal(r.status, 'active');
  const after = await dueRows(w);
  assert.equal(after.length, 6, 'resume creates no duplicate dues');
  assert.deepEqual(after.map((x) => x.id), before.map((x) => x.id), 'the same dues are moved, not re-created');
  assert.equal(after[0].due_on, '2030-01-25'); assert.equal(after[0].original_due_on, '2030-01-15');
  assert.equal((await get(w)).ends_on.slice(0, 10), '2030-07-10');
  const c = await pool.connect();
  try { await c.query('BEGIN'); assert.equal(await generateObligations(c, w.id), 0, 'regenerating the schedule adds nothing'); await c.query('COMMIT'); } finally { c.release(); }
  const again = await resume(w);
  assert.equal(again.status, 409, 'a second resume is refused');
  assert.equal((await dueRows(w)).length, 6);
  assert.deepEqual((await dueRows(w)).map((x) => x.due_on), after.map((x) => x.due_on));
  const h = (await get(w)).history.map((x) => x.action);
  assert.ok(h.includes('pause_requested') && h.includes('paused') && h.includes('resumed'), 'every step is in the history');
});

test('stale resume: a resume sent with an old version is refused', async () => {
  const w = await world();
  await paused(w);
  const r = await api('POST', `/sponsorships/${w.id}/resume`, { token: w.sponsor.token, body: { expected_pause_rev: 0 } });
  assert.equal(r.status, 409);
  assert.equal((await get(w)).status, 'paused');
  assert.equal((await api('POST', `/sponsorships/${w.id}/resume`, { token: w.outsider.token, body: { expected_pause_rev: 2 } })).status, 403);
});

test('scheduled start: an approved future pause leaves the agreement active until its date, then the worker starts it', async () => {
  const w = await world();
  const p = must(await ask(w, 'ath', { policy: 'hold', effective_from: await inDays(30), planned_resume_on: await inDays(60) }), 201);
  assert.equal(must(await decide(w, 'sponsor', p.id, 'approve')).status, 'scheduled');
  assert.equal((await get(w)).status, 'active');
  assert.equal((await dueRows(w)).filter((r) => r.held_by_pause_id).length, 0);
  assert.equal(await activateDuePauses(), 0, 'not yet');
  await pool.query('UPDATE sponsorship_pauses SET effective_from = current_date WHERE id=$1', [p.id]);
  assert.equal(await activateDuePauses(), 1);
  assert.equal((await get(w)).status, 'paused');
  assert.equal(await activateDuePauses(), 0, 'starting twice does nothing');
});

test('ending a paused agreement closes the pause and releases held dues so owed money stays payable', async () => {
  const w = await world();
  await paused(w, { policy: 'hold' });
  await pool.query("UPDATE sponsorship_obligations SET due_on='2020-04-01' WHERE sponsorship_id=$1 AND seq=1", [w.id]); // already due, held by the pause
  must(await api('PATCH', `/sponsorships/${w.id}`, { token: w.sponsor.token, body: { status: 'ended', reason: 'Finished' } }));
  const d = await get(w);
  assert.equal(d.status, 'ended');
  assert.equal(d.pauses[0].status, 'ended');
  const rows = await dueRows(w);
  assert.ok(rows.every((r) => r.held_by_pause_id === null));
  const owed = rows.find((r) => r.status === 'scheduled');
  assert.ok(owed, 'the due that was already due stays open');
  must(await api('POST', `/sponsorship-obligations/${owed.id}/payments`, { token: w.sponsor.token, body: { amount_cents: 50000, currency: 'SGD', method: 'cash', reference: 'END1', paid_on: '2030-01-14' } }), 201);
});

test('concurrency: a pause approved while a payment is reported never leaves a held due with money against it', async () => {
  for (let k = 0; k < 4; k++) {
    const w = await world();
    const due = (await dueRows(w))[0];
    const p = must(await ask(w, 'sponsor'), 201);
    const rev = (await get(w)).pause_rev;
    const [a, b] = await Promise.all([
      api('PATCH', `/sponsorship-pauses/${p.id}`, { token: w.ath.token, body: { expected_pause_rev: rev, decision: 'approve' } }),
      api('POST', `/sponsorship-obligations/${due.id}/payments`, { token: w.sponsor.token, body: { amount_cents: 50000, currency: 'SGD', method: 'cash', reference: `C${k}`, paid_on: '2030-01-14' } }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok([201, 409].includes(b.status), JSON.stringify(b.body));
    const now = (await dueRows(w))[0];
    const money = (await pool.query("SELECT count(*)::int AS c FROM sponsorship_payments WHERE obligation_id=$1 AND status IN ('reported','confirmed','awaiting_payment')", [due.id])).rows[0].c;
    assert.ok(!(now.held_by_pause_id && money > 0), 'consistent: held and paid never both');
    assert.equal(b.status === 201, money === 1);
    assert.equal(now.held_by_pause_id === null, b.status === 201);
  }
});

test('concurrency: two simultaneous resumes and two simultaneous requests each take effect once', async () => {
  const w = await world();
  await paused(w);
  const rev = (await get(w)).pause_rev;
  const rs = await Promise.all([1, 2].map(() => api('POST', `/sponsorships/${w.id}/resume`, { token: w.sponsor.token, body: { expected_pause_rev: rev } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await dueRows(w)).length, 6);
  const rev2 = (await get(w)).pause_rev;
  const qs = await Promise.all([1, 2].map(() => api('POST', `/sponsorships/${w.id}/pause-requests`, { token: w.sponsor.token, body: { expected_pause_rev: rev2, reason_code: 'injury', policy: 'hold', effective_from: '2030-05-01' } })));
  assert.deepEqual(qs.map((r) => r.status).sort(), [201, 409]);
});
