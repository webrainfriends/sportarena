import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MEDIA_DIR = process.env.MEDIA_DIR ?? `${process.env.TMPDIR ?? '/tmp'}/sa-insurance-test-media`;
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { expireQuotes, sendRenewalReminders } = await import('../src/insurance-cycle.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ag_${n}_${roles[0]}`, display_name: `Agency ${n}`, email: `ag${n}@example.com`, password: 'correct-horse-battery', roles } }); return { id: r.body.user.id, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id }) }; };
const insurer = async (name, extra = {}) => { const u = await signup(['insurer']); const ins = must(await api('POST', '/insurance/my-insurer', { token: u.token, body: { name, ...extra } }), 201); return { ...u, insurer: ins }; };
const plan = (who, body) => api('POST', '/insurance/plans', { token: who.token, body: { name: 'Plan', cover_for: 'individual', premium_cents: 50000, coverage_cents: 500000, ...body } });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const put = (token, qs, body, type = 'application/pdf') => fetch(`${base}/api/v1/insurance/documents?${new URLSearchParams(qs)}`, { method: 'PUT', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': type }, body });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('ag_root');
});
after(async () => { server.close(); await pool.end(); });

test('insurer role: onboarding, own plans only, public profile, licence kept encrypted and verification reset when it changes', async () => {
  const plain = await signup();
  assert.equal((await api('POST', '/insurance/my-insurer', { token: plain.token, body: { name: 'Sneaky Cover' } })).status, 403, 'needs the insurer role');
  assert.equal((await plan(plain, { insurer: 'Sneaky Cover' })).status, 403);
  const a = await insurer('Alpha Assure', { headline: 'Cover for clubs', regions: ['Mumbai'], sports: ['football'], licence_no: 'LIC-ALPHA-1' });
  assert.equal(a.insurer.verified_at, null);
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM insurers WHERE id=$1', [a.insurer.id])).rows[0]).includes('LIC-ALPHA-1'), 'licence is ciphertext');
  assert.equal((await api('POST', '/insurance/my-insurer', { token: a.token, body: { name: 'Alpha Two' } })).status, 409, 'one profile per account');
  const b = await insurer('Beta Cover');
  assert.equal((await api('POST', '/insurance/my-insurer', { token: (await signup(['insurer'])).token, body: { name: 'alpha assure' } })).status, 409);

  const mine = must(await api('GET', '/insurance/my-insurer', { token: a.token }));
  assert.equal(mine.licence_hint, '••••A-1'); assert.ok(mine.has_licence);
  const p = must(await plan(a, { name: 'Club Shield', cover_for: 'team', promo_text: '2 months free', promo_ends_on: '2999-01-01' }), 201);
  assert.equal(p.insurer_id, a.insurer.id);
  assert.equal((await api('PATCH', `/insurance/plans/${p.id}`, { token: b.token, body: { premium_cents: 1 } })).status, 403, 'another insurer cannot edit it');
  assert.equal((await plan(b, { name: 'Hijack', insurer_id: a.insurer.id })).status, 403);
  const listed = must(await api('GET', '/insurance/plans', { query: { insurer_id: a.insurer.id } }));
  assert.equal(listed[0].offer, '2 months free');
  must(await api('PATCH', `/insurance/plans/${p.id}`, { token: a.token, body: { promo_ends_on: '2000-01-01' } }));
  assert.equal(must(await api('GET', '/insurance/plans', { query: { insurer_id: a.insurer.id } }))[0].offer, null, 'an ended offer is not shown');

  const pub = must(await api('GET', `/insurance/insurers/${a.insurer.id}`));
  assert.equal(pub.headline, 'Cover for clubs'); assert.equal(pub.plans.length, 1); assert.ok(!('licence_no_enc' in pub));
  assert.deepEqual(must(await api('GET', '/insurance/insurers', { query: { sport: 'tennis' } })).map((x) => x.name), ['Beta Cover'], 'sport-specialist insurers are filtered, generalists match');

  must(await api('POST', `/insurance/insurers/${a.insurer.id}/verify`, { token: admin.token, body: {} }));
  const upd = must(await api('PATCH', '/insurance/my-insurer', { token: a.token, body: { licence_no: 'LIC-ALPHA-2' } }));
  assert.equal(upd.verified_at, null, 'a new licence number needs checking again');
  assert.equal((must(await api('GET', '/insurance/my-insurer', { token: a.token }))).verified, false);
  assert.deepEqual(must(await api('GET', '/insurance/my-plans', { token: a.token })).map((x) => x.name), ['Club Shield']);
  assert.equal((await api('GET', '/insurance/my-plans', { token: plain.token })).status, 403);
});

test('quote flow: request, inbox, quote, tracker, messages, accept creates the policy, other quotes close', async () => {
  const a = await insurer('Quote Alpha'), b = await insurer('Quote Beta');
  const tp = must(await plan(a, { name: 'Team Plan', cover_for: 'team', premium_cents: 100000, coverage_cents: 2000000 }), 201);
  const captain = await signup(['athlete']), stranger = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: captain.token, body: { name: 'Quote FC', sport: 'football' } }), 201);

  assert.equal((await api('POST', '/insurance/quote-requests', { token: stranger.token, body: { cover_for: 'team', subject_id: team.id } })).status, 403, 'only a manager can ask for team cover');
  const req = must(await api('POST', '/insurance/quote-requests', { token: captain.token, body: { cover_for: 'team', subject_id: team.id, participants: 18, message: 'Two players had knee injuries last year' } }), 201);
  assert.equal(req.insurer_id, null);
  assert.equal((await api('POST', '/insurance/quote-requests', { token: captain.token, body: { cover_for: 'team', subject_id: team.id } })).status, 409, 'no duplicate open request');
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM insurance_quote_requests WHERE id=$1', [req.id])).rows[0]).includes('knee'), 'the note is encrypted');

  assert.equal(must(await api('GET', '/insurance/quote-requests', { token: a.token, query: { view: 'inbox' } })).length, 1, 'open requests reach every insurer');
  assert.equal(must(await api('GET', '/insurance/quote-requests', { token: stranger.token })).length, 0);
  assert.equal((await api('GET', `/insurance/quote-requests/${req.id}`, { token: stranger.token })).status, 404);
  assert.ok(must(await api('GET', `/insurance/quote-requests/${req.id}`, { token: a.token })).message.includes('knee'), 'insurers it went to can read the note');

  must(await api('POST', `/insurance/quote-requests/${req.id}/messages`, { token: captain.token, body: { insurer_id: a.insurer.id, body: 'Do you cover tournaments abroad?' } }), 201);
  assert.equal((await api('POST', `/insurance/quote-requests/${req.id}/messages`, { token: captain.token, body: { body: 'who?' } })).status, 400);
  must(await api('POST', `/insurance/quote-requests/${req.id}/messages`, { token: a.token, body: { body: 'Yes, in Asia.' } }), 201);
  assert.equal(must(await api('GET', `/insurance/quote-requests/${req.id}`, { token: b.token })).messages.length, 0, 'other insurers do not see the thread');
  assert.equal(must(await api('GET', `/insurance/quote-requests/${req.id}`, { token: captain.token })).messages.length, 2);

  const wrongPlan = must(await plan(a, { name: 'Solo', cover_for: 'individual' }), 201);
  assert.equal((await api('POST', '/insurance/quotes', { token: a.token, body: { request_id: req.id, plan_id: wrongPlan.id, premium_cents: 1 } })).status, 400, 'plan must match what was asked for');
  assert.equal((await api('POST', '/insurance/quotes', { token: b.token, body: { request_id: req.id, plan_id: tp.id, premium_cents: 1 } })).status, 403, "cannot quote on another insurer's plan");
  const qa = must(await api('POST', '/insurance/quotes', { token: a.token, body: { request_id: req.id, plan_id: tp.id, premium_cents: 90000, coverage_cents: 2500000, valid_days: 7, note: 'Squad discount' } }), 201);
  assert.equal(qa.total_cents, 90000 * 12); assert.equal(qa.status, 'offered'); assert.equal(qa.subject_name, 'Quote FC');
  assert.equal((await api('POST', '/insurance/quotes', { token: a.token, body: { request_id: req.id, plan_id: tp.id, premium_cents: 80000 } })).status, 409, 'one live quote per request until withdrawn');
  const tpb = must(await plan(b, { name: 'Beta Team', cover_for: 'team', premium_cents: 120000, coverage_cents: 1000000 }), 201);
  const qb = must(await api('POST', '/insurance/quotes', { token: b.token, body: { request_id: req.id, plan_id: tpb.id, premium_cents: 110000 } }), 201);

  assert.equal(must(await api('GET', '/insurance/quotes', { token: captain.token })).length, 2);
  assert.equal(must(await api('GET', '/insurance/quotes', { token: a.token, query: { view: 'sent' } })).length, 1);
  assert.equal((await api('GET', `/insurance/quotes/${qa.id}`, { token: b.token })).status, 404, 'a quote is private to its buyer and insurer');
  assert.equal(must(await api('GET', `/insurance/quote-requests/${req.id}`, { token: b.token })).quotes.length, 1, 'insurers only see their own quote');
  assert.equal(must(await api('GET', `/insurance/quote-requests/${req.id}`, { token: captain.token })).quotes.length, 2);
  assert.equal(must(await api('GET', '/insurance/quote-requests', { token: captain.token }))[0].status, 'quoted');

  assert.equal((await api('POST', `/insurance/quotes/${qa.id}/accept`, { token: stranger.token, body: {} })).status, 404);
  const pol = must(await api('POST', `/insurance/quotes/${qa.id}/accept`, { token: captain.token, body: { beneficiary: 'Club fund' } }), 201);
  assert.equal(pol.status, 'active', 'no payment provider in tests'); assert.equal(pol.premium_cents, 90000 * 12); assert.equal(pol.coverage_cents, 2500000); assert.equal(pol.quote_id, qa.id);
  assert.equal((await api('POST', `/insurance/quotes/${qa.id}/accept`, { token: captain.token, body: {} })).status, 409, 'cannot accept twice');
  assert.equal((await api('POST', `/insurance/quotes/${qb.id}/accept`, { token: captain.token, body: {} })).status, 409, 'the other quote was closed');
  const after = must(await api('GET', `/insurance/quote-requests/${req.id}`, { token: captain.token }));
  assert.equal(after.status, 'accepted');
  assert.deepEqual(after.quotes.map((q) => q.status).sort(), ['accepted', 'declined']);
  assert.deepEqual(['requested', 'quote_sent', 'quote_accepted'].filter((x) => !after.events.some((e) => e.action === x)), [], 'the tracker has every step');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM insurance_quote_events")).rows[0].n >= 5, true);
  await assert.rejects(pool.query('DELETE FROM insurance_quote_events'), /append-only/);

  const book = must(await api('GET', '/insurance/insurer/policies', { token: a.token }));
  assert.equal(book.length, 1); assert.equal(book[0].subject_name, 'Quote FC'); assert.ok(book[0].policy_no.startsWith('SA-')); assert.ok(!('beneficiary' in book[0]));
  assert.equal(must(await api('GET', '/insurance/insurer/policies', { token: b.token })).length, 0);
  const sum = must(await api('GET', '/insurance/insurer/summary', { token: a.token }));
  assert.equal(sum.live_policies, 1); assert.equal(sum.quotes_accepted, 1);
  assert.equal(must(await api('GET', `/insurance/policies/${pol.id}`, { token: a.token })).beneficiary, undefined, 'the insurer does not see the beneficiary');
  assert.equal((await api('GET', `/insurance/policies/${pol.id}`, { token: b.token })).status, 403);
});

test('direct offers, withdraw, decline, declining a request, cancel, and quotes that run out', async () => {
  const a = await insurer('Direct Cover');
  const p = must(await plan(a, { name: 'Solo Plus' }), 201);
  const u = await signup(), v = await signup();
  assert.equal((await api('POST', '/insurance/quotes', { token: a.token, body: { buyer_id: a.id, plan_id: p.id, premium_cents: 1 } })).status, 400, 'no quoting yourself');
  assert.equal((await api('POST', '/insurance/quotes', { token: a.token, body: { plan_id: p.id, premium_cents: 1 } })).status, 400, 'request_id or buyer_id');
  const q1 = must(await api('POST', '/insurance/quotes', { token: a.token, body: { buyer_id: u.id, plan_id: p.id, premium_cents: 40000, months: 6 } }), 201);
  assert.equal(q1.total_cents, 240000); assert.equal(q1.request_id, null);
  assert.equal(must(await api('GET', '/notifications', { token: u.token })).items.some((x) => x.kind === 'quote_update'), true, 'the buyer is told');
  must(await api('POST', `/insurance/quotes/${q1.id}/withdraw`, { token: a.token }));
  assert.equal((await api('POST', `/insurance/quotes/${q1.id}/accept`, { token: u.token, body: {} })).status, 409, 'a withdrawn quote cannot be accepted');
  const q2 = must(await api('POST', '/insurance/quotes', { token: a.token, body: { buyer_id: u.id, plan_id: p.id, premium_cents: 41000 } }), 201);
  must(await api('POST', `/insurance/quotes/${q2.id}/decline`, { token: u.token, body: { reason: 'too dear' } }));
  assert.equal(must(await api('GET', `/insurance/quotes/${q2.id}`, { token: u.token })).events.map((e) => e.action).join(), 'quote_sent,quote_declined');

  const q3 = must(await api('POST', '/insurance/quotes', { token: a.token, body: { buyer_id: u.id, plan_id: p.id, premium_cents: 42000 } }), 201);
  await pool.query("UPDATE insurance_quotes SET valid_until = current_date - 1 WHERE id=$1", [q3.id]);
  assert.equal(must(await api('GET', '/insurance/quotes', { token: u.token, query: { status: 'expired' } })).length, 1, 'an expired offer reads as expired straight away');
  assert.equal((await api('POST', `/insurance/quotes/${q3.id}/accept`, { token: u.token, body: {} })).status, 409);
  assert.equal(await expireQuotes(), 1);
  assert.equal((await pool.query("SELECT status FROM insurance_quotes WHERE id=$1", [q3.id])).rows[0].status, 'expired');

  // an addressed request: the insurer can decline it, which closes it for the requester
  const r = must(await api('POST', '/insurance/quote-requests', { token: v.token, body: { cover_for: 'individual', plan_id: p.id, months: 6 } }), 201);
  assert.equal(r.insurer_id, a.insurer.id);
  assert.equal((await api('POST', '/insurance/quote-requests', { token: v.token, body: { cover_for: 'team', plan_id: p.id } })).status, 400, 'plan decides what is covered');
  must(await api('POST', `/insurance/quote-requests/${r.id}/decline`, { token: a.token, body: { reason: 'Outside our sports' } }));
  assert.equal(must(await api('GET', '/insurance/quote-requests', { token: v.token }))[0].status, 'declined');
  assert.equal(must(await api('GET', '/insurance/quote-requests', { token: a.token, query: { view: 'inbox' } })).length, 0);
  // cancelling closes live quotes
  const r2 = must(await api('POST', '/insurance/quote-requests', { token: v.token, body: { cover_for: 'individual' } }), 201);
  const q4 = must(await api('POST', '/insurance/quotes', { token: a.token, body: { request_id: r2.id, plan_id: p.id, premium_cents: 30000 } }), 201);
  must(await api('POST', `/insurance/quote-requests/${r2.id}/cancel`, { token: v.token }));
  assert.equal(must(await api('GET', `/insurance/quotes/${q4.id}`, { token: v.token })).status, 'declined');
  assert.equal((await api('POST', `/insurance/quote-requests/${r2.id}/cancel`, { token: v.token })).status, 409);
  // pausing requests hides the insurer from "request a quote"
  must(await api('PATCH', '/insurance/my-insurer', { token: a.token, body: { accepting_requests: false } }));
  assert.equal((await api('POST', '/insurance/quote-requests', { token: u.token, body: { cover_for: 'individual', insurer_id: a.insurer.id } })).status, 409);
  assert.ok(!must(await api('GET', '/insurance/insurers', { query: { accepting: 'true' } })).some((x) => x.name === 'Direct Cover'), 'paused insurers drop out of the accepting filter');
  assert.ok(must(await api('GET', '/insurance/insurers')).some((x) => x.name === 'Direct Cover'), 'but stay listed with their plans');
});

test('event/tournament quotes, and renewal: window, continuity, plan switch, idempotency, reminders, no renewal for others', async () => {
  const a = await insurer('Renew Cover');
  const ep = must(await plan(a, { name: 'Tournament Cover', cover_for: 'event', premium_cents: 20000, coverage_cents: 1000000, term_months_min: 1, term_months_max: 12 }), 201);
  const org = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Renew Cup', sport: 'football' } }), 201);
  const r = must(await api('POST', '/insurance/quote-requests', { token: org.token, body: { cover_for: 'event', subject_id: ev.id, plan_id: ep.id, months: 3, participants: 200 } }), 201);
  assert.equal(must(await api('GET', `/insurance/quote-requests/${r.id}`, { token: org.token })).subject_name, 'Renew Cup');
  const q = must(await api('POST', '/insurance/quotes', { token: a.token, body: { request_id: r.id, plan_id: ep.id, premium_cents: 18000, months: 3 } }), 201);
  const pol = must(await api('POST', `/insurance/quotes/${q.id}/accept`, { token: org.token, body: {} }), 201);

  assert.equal((await api('POST', `/insurance/policies/${pol.id}/renew`, { token: org.token, body: {} })).status, 409, 'too early: the window opens 60 days before the end');
  await pool.query("UPDATE insurance_policies SET starts_on = current_date - 70, ends_on = current_date + 20 WHERE id=$1", [pol.id]);
  const list = must(await api('GET', '/insurance/policies', { token: org.token, query: { renewal_due: 'true' } }));
  assert.equal(list.length, 1); assert.equal(list[0].renewal_due, true); assert.equal(list[0].days_left, 20); assert.equal(list[0].subject_name, 'Renew Cup');
  assert.equal(must(await api('GET', '/dashboard', { token: org.token })).policies_to_renew, 1);
  assert.equal((await api('POST', `/insurance/policies/${pol.id}/renew`, { token: (await signup()).token, body: {} })).status, 403);

  assert.equal(await sendRenewalReminders(), 1);
  assert.equal(await sendRenewalReminders(), 0, 'each reminder step is sent once');
  assert.equal(must(await api('GET', '/notifications', { token: org.token })).items.filter((x) => x.kind === 'insurance_renewal').length, 1);
  await pool.query("UPDATE insurance_policies SET ends_on = current_date + 5 WHERE id=$1", [pol.id]);
  assert.equal(await sendRenewalReminders(), 1, 'and again a week before');
  await pool.query("UPDATE insurance_policies SET ends_on = current_date + 20 WHERE id=$1", [pol.id]);

  must(await api('PATCH', `/insurance/plans/${ep.id}`, { token: a.token, body: { premium_cents: 25000, waiting_period_days: 14 } }));
  const ren = must(await api('POST', `/insurance/policies/${pol.id}/renew`, { token: org.token, body: {} }), 201);
  assert.equal(ren.renewed_from, pol.id); assert.equal(ren.premium_cents, 25000 * 3, 'priced on the plan\'s current premium, same 3-month length');
  assert.equal(ren.terms.waiting_period_days, 0, 'continuous cover: no new waiting period');
  const old = (await pool.query('SELECT ends_on, starts_on FROM insurance_policies WHERE id=$1', [pol.id])).rows[0];
  assert.equal(new Date(ren.starts_on).toISOString().slice(0, 10), new Date(new Date(old.ends_on).getTime() + 864e5).toISOString().slice(0, 10), 'starts the day after the current one ends');
  assert.equal((await api('POST', `/insurance/policies/${pol.id}/renew`, { token: org.token, body: {} })).status, 409, 'already renewed');
  assert.equal(must(await api('GET', '/insurance/policies', { token: org.token, query: { renewal_due: 'true' } })).length, 0);
  assert.equal(must(await api('GET', '/insurance/insurer/policies', { token: a.token, query: { expiring_in_days: 30 } })).filter((x) => !x.renewed).length, 0, 'the insurer sees who has renewed');

  // lapsed policies: a short grace period, cover restarts today with the plan's waiting period
  const lapsed = must(await api('POST', '/insurance/policies', { token: org.token, body: { plan_id: ep.id, subject_id: ev.id, months: 2 } }), 201);
  await pool.query("UPDATE insurance_policies SET starts_on = current_date - 90, ends_on = current_date - 10 WHERE id=$1", [lapsed.id]);
  const back = must(await api('POST', `/insurance/policies/${lapsed.id}/renew`, { token: org.token, body: { months: 2 } }), 201);
  assert.equal(back.terms.waiting_period_days, 14); assert.equal(new Date(back.starts_on).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
  await pool.query("UPDATE insurance_policies SET ends_on = current_date - 40 WHERE id=$1", [pol.id]);
  const old2 = must(await api('POST', '/insurance/policies', { token: org.token, body: { plan_id: ep.id, subject_id: ev.id, months: 1 } }), 201);
  await pool.query("UPDATE insurance_policies SET starts_on = current_date - 90, ends_on = current_date - 31 WHERE id=$1", [old2.id]);
  assert.equal((await api('POST', `/insurance/policies/${old2.id}/renew`, { token: org.token, body: {} })).status, 409, 'too long ago: buy a new policy');
  // retired plans cannot be renewed onto
  const fresh = must(await api('POST', '/insurance/policies', { token: org.token, body: { plan_id: ep.id, subject_id: ev.id, months: 1 } }), 201);
  must(await api('PATCH', `/insurance/plans/${ep.id}`, { token: a.token, body: { status: 'retired' } }));
  assert.equal((await api('POST', `/insurance/policies/${fresh.id}/renew`, { token: org.token, body: {} })).status, 409);
});

test('documents: upload to a policy, access limited to holder and insurer, encrypted on disk, hidden not deleted', async () => {
  const a = await insurer('Doc Cover'), other = await insurer('Other Cover');
  const p = must(await plan(a, { name: 'Doc Plan' }), 201);
  const u = await signup(), nosy = await signup();
  const pol = must(await api('POST', '/insurance/policies', { token: u.token, body: { plan_id: p.id } }), 201);

  assert.equal((await put(null, { policy_id: pol.id }, PDF)).status, 401);
  assert.equal((await put(nosy.token, { policy_id: pol.id }, PDF)).status, 404, 'strangers cannot even tell it exists');
  assert.equal((await put(other.token, { policy_id: pol.id }, PDF)).status, 404, 'nor can other insurers');
  assert.equal((await put(u.token, { policy_id: pol.id }, Buffer.from('MZ not a document at all, just text'))).status, 400);
  assert.equal((await put(u.token, { policy_id: pol.id, kind: 'bogus' }, PDF)).status, 400);
  const mine = await put(u.token, { policy_id: pol.id, kind: 'receipt', title: 'Receipt Oct' }, PDF);
  assert.equal(mine.status, 201); const d1 = await mine.json();
  const sched = await put(a.token, { policy_id: pol.id, kind: 'policy_schedule', title: 'Schedule' }, PDF); assert.equal(sched.status, 201); const d2 = await sched.json();

  const docs = must(await api('GET', '/insurance/documents', { token: u.token, query: { policy_id: pol.id } }));
  assert.deepEqual(docs.map((d) => d.title).sort(), ['Receipt Oct', 'Schedule']);
  assert.equal(must(await api('GET', '/insurance/documents', { token: a.token, query: { policy_id: pol.id } })).length, 2, 'the insurer sees the same locker');
  assert.equal((await api('GET', '/insurance/documents', { token: nosy.token, query: { policy_id: pol.id } })).status, 404);
  assert.equal(must(await api('GET', '/insurance/policies', { token: u.token }))[0].documents, 2);

  const dl = await fetch(`${base}${d1.url}`, { headers: { authorization: `Bearer ${u.token}` } });
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PDF);
  assert.equal((await fetch(`${base}${d1.url}`)).status, 401); assert.equal((await fetch(`${base}${d1.url}`, { headers: { authorization: `Bearer ${nosy.token}` } })).status, 404);
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(`${process.env.MEDIA_DIR}/insurance/${(await pool.query('SELECT file_name FROM insurance_documents WHERE id=$1', [d1.id])).rows[0].file_name}`, 'utf8');
  assert.ok(raw.startsWith('v1.') && !raw.includes('%PDF'), 'stored as ciphertext');
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_pii' AND entity='insurance_documents'")).rows[0].n >= 1, 'downloads are audit-logged');

  assert.equal((await api('DELETE', `/insurance/documents/${d2.id}`, { token: u.token })).status, 403, 'the holder cannot remove what the insurer filed');
  must(await api('DELETE', `/insurance/documents/${d1.id}`, { token: u.token }));
  assert.equal(must(await api('GET', '/insurance/documents', { token: u.token, query: { policy_id: pol.id } })).length, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM insurance_documents WHERE id=$1', [d1.id])).rows[0].n, 1, 'the row is kept');
  assert.equal((await fetch(`${base}${d1.url}`, { headers: { authorization: `Bearer ${u.token}` } })).status, 404);

  // claim evidence belongs to the claimant; the insurer reviews the claim and can read it
  const claim = must(await api('POST', `/insurance/policies/${pol.id}/claims`, { token: u.token, body: { description: 'Sprained ankle in the final', amount_cents: 10000 } }), 201);
  assert.equal((await put(a.token, { claim_id: claim.id, kind: 'claim_evidence' }, PDF)).status, 403);
  assert.equal((await put(u.token, { claim_id: claim.id, kind: 'claim_evidence', title: 'Doctor note' }, PDF)).status, 201);
  assert.equal((await put(u.token, { policy_id: pol.id, claim_id: claim.id }, PDF)).status, 400, 'exactly one parent');
  const inbox = must(await api('GET', '/insurance/claims', { token: a.token, query: { as_insurer: 'true' } }));
  assert.equal(inbox.length, 1); assert.equal(inbox[0].description, 'Sprained ankle in the final');
  assert.equal(must(await api('GET', '/insurance/claims', { token: other.token, query: { as_insurer: 'true' } })).length, 0);
  assert.equal((await api('GET', `/insurance/claims/${claim.id}`, { token: other.token })).status, 404);
  assert.equal((await api('PATCH', `/insurance/claims/${claim.id}`, { token: other.token, body: { status: 'approved' } })).status, 404, 'only the insurer that wrote the policy reviews its claims');
  assert.equal((await api('PATCH', `/insurance/claims/${claim.id}`, { token: u.token, body: { status: 'approved' } })).status, 403, 'holders are not reviewers');
  assert.equal(must(await api('PATCH', `/insurance/claims/${claim.id}`, { token: a.token, body: { status: 'approved' } })).status, 'approved');
  assert.equal(must(await api('GET', `/insurance/claims/${claim.id}`, { token: a.token })).history.length, 2);
});
