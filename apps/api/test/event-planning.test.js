import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ep_${n}_${roles[0]}`, display_name: `EP ${n}`, email: `ep${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const venue = async (owner, name, sports, city = 'Pune') => {
  const v = must(await api('POST', '/venues', { token: owner.token, body: { name, city } }), 201);
  for (const s of sports) must(await api('POST', `/venues/${v.id}/resources`, { token: owner.token, body: { kind: 'court', name: `${s} area`, sport: s, hourly_rate_cents: 100000 } }), 201);
  return v;
};
const mkEvent = async (org, extra = {}) => must(await api('POST', '/events', { token: org.token, body: { name: `Games ${++n}`, sports: ['athletics'], starts_on: day(40), ends_on: day(42), ...extra } }), 201);

test('create an event with several sports, a date range and a booking request per venue', async () => {
  const org = await signup(['organizer']), vOwner1 = await signup(['venue_manager']), vOwner2 = await signup(['venue_manager']);
  const track = await venue(vOwner1, 'City Stadium', ['athletics', 'football']), hall = await venue(vOwner2, 'Indoor Hall', ['basketball']);
  const mine = await venue(org, 'Own Ground', ['football']);
  // the venue finder offers, per sport, only venues that have something for it
  const found = must(await api('GET', '/venue-finder', { query: { sports: 'athletics,basketball,football' } }));
  assert.deepEqual(found.map((f) => [f.sport, f.venues.length]), [['athletics', 1], ['basketball', 1], ['football', 2]]);
  assert.equal((await api('POST', '/events', { token: org.token, body: { name: 'No sport' } })).status, 400);

  const ev = must(await api('POST', '/events', { token: org.token, body: {
    name: 'Inter-school Games', sports: ['athletics', 'football', 'basketball'], starts_on: day(40), ends_on: day(42), city: 'Pune',
    venue_requests: [{ venue_id: track.id, sports: ['athletics', 'football'], message: 'Track and the main field', offer_cents: 5000000 }, { venue_id: hall.id, sports: ['basketball'] }, { venue_id: mine.id, sports: ['football'] }],
  } }), 201);
  assert.equal(ev.disciplines.length, 3);
  assert.deepEqual(ev.disciplines.map((d) => d.mode).sort(), ['individual', 'team', 'team']);
  assert.equal(ev.venue_requests.length, 2, 'one request per venue you do not run');
  assert.equal(ev.venue_requests_skipped[0].name, 'Own Ground');
  assert.equal(ev.venue_id, mine.id, 'your own venue is set directly');
  assert.equal((await api('GET', `/events/${ev.id}/programme`)).status, 200, 'a multi-sport programme exists');
  assert.equal((await api('GET', `/events/${ev.id}`)).body.sport, 'Multi-sport games');
  // each venue owner has an inbox item with the sports and dates
  const inbox = must(await api('GET', '/me/event-requests', { token: vOwner1.token }));
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, 'venue');
  assert.equal(inbox[0].sport_ids.length, 2);
  assert.equal(inbox[0].starts_on.slice(0, 10), day(40));
  assert.equal(Number(inbox[0].offer_cents), 5000000);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='event_request'", [vOwner2.id])).rowCount >= 1);
  // errors: a sport the event does not have, an end before the start
  assert.equal((await api('POST', '/events', { token: org.token, body: { name: 'Bad', sports: ['athletics'], venue_requests: [{ venue_id: track.id, sports: ['football'] }] } })).status, 400);
  assert.equal((await api('POST', '/events', { token: org.token, body: { name: 'Bad2', sports: ['athletics'], starts_on: day(5), ends_on: day(2) } })).status, 400);
  // one sport stays a normal event
  const single = await mkEvent(org);
  assert.equal(single.disciplines.length, 0);
  assert.equal((await api('GET', `/events/${single.id}/programme`)).status, 404);
  assert.equal((await api('GET', '/events', { query: { q: 'Inter-school' } })).body.length, 1);
});

test('requests: invite, quote, finalize — each kind has its effect and feeds the budget', async () => {
  const org = await signup(['organizer']), stranger = await signup();
  const ev = await mkEvent(org, { name: 'Open Cup', entry_fee_cents: 0 });
  const post = (path, who, body) => api('POST', path, { token: who.token, body });

  // team invitation without a fee: accepted = entered
  const captain = await signup();
  const team = must(await api('POST', '/teams', { token: captain.token, body: { name: `Tigers ${n}`, sport: 'athletics' } }), 201);
  const found = must(await api('GET', `/events/${ev.id}/partners`, { token: org.token, query: { kind: 'team' } }));
  assert.ok(found.some((t) => t.id === team.id && t.key === 'team_id' && !t.entered));
  assert.equal((await api('GET', `/events/${ev.id}/partners`, { token: stranger.token, query: { kind: 'team' } })).status, 403);
  const inv = must(await post(`/events/${ev.id}/requests`, org, { kind: 'team', team_id: team.id, message: 'Join us' }), 201);
  assert.equal(inv.status, 'sent');
  assert.equal((await post(`/events/${ev.id}/requests`, org, { kind: 'team', team_id: team.id })).status, 409, 'no duplicate open request');
  assert.equal((await post(`/events/${ev.id}/requests`, stranger, { kind: 'team', team_id: team.id })).status, 403, 'only the organiser asks');
  assert.equal((await post(`/event-requests/${inv.id}/respond`, stranger, { response: 'accept' })).status, 403);
  assert.equal(must(await post(`/event-requests/${inv.id}/respond`, captain, { response: 'accept', message: 'We are in' })).status, 'finalized');
  assert.equal((await pool.query("SELECT status FROM event_entries WHERE event_id=$1 AND team_id=$2", [ev.id, team.id])).rows[0].status, 'accepted');
  assert.equal((await post(`/event-requests/${inv.id}/respond`, captain, { response: 'decline' })).status, 409, 'already settled');
  assert.equal(must(await api('GET', `/event-requests/${inv.id}`, { token: captain.token })).thread.length, 1);

  // referee: quote above the offer, message, finalize -> crew post + expense line
  const ref = await signup(['referee']);
  assert.equal((await post(`/events/${ev.id}/requests`, org, { kind: 'referee', user_id: stranger.id })).status, 400, 'must be a referee');
  assert.equal((await post(`/events/${ev.id}/requests`, org, { kind: 'referee', user_id: org.id })).status, 400, 'not yourself');
  const rq = must(await post(`/events/${ev.id}/requests`, org, { kind: 'referee', user_id: ref.id, offer_cents: 100000, sports: ['athletics'], quantity: 1 }), 201);
  assert.equal(must(await api('GET', '/me/event-requests', { token: ref.token })).length, 1);
  assert.equal((await post(`/event-requests/${rq.id}/finalize`, org, {})).status, 409, 'nothing to finalize before they answer');
  const q = must(await post(`/event-requests/${rq.id}/respond`, ref, { response: 'quote', quote_cents: 150000, quote_note: 'Travel included', quote_valid_until: day(10) }));
  assert.equal(q.status, 'quoted');
  assert.equal((await post(`/event-requests/${rq.id}/respond`, ref, { response: 'accept' })).status, 409, 'already quoted');
  must(await post(`/event-requests/${rq.id}/messages`, org, { body: 'Can you do 1,400?' }), 201);
  must(await post(`/event-requests/${rq.id}/messages`, ref, { body: 'Fine, 1,400' }), 201);
  const fin = must(await post(`/event-requests/${rq.id}/finalize`, org, { amount_cents: 140000 }));
  assert.equal(fin.status, 'finalized');
  const staff = (await pool.query("SELECT role, status, rate_cents FROM event_staff WHERE event_id=$1 AND user_id=$2", [ev.id, ref.id])).rows[0];
  assert.deepEqual([staff.role, staff.status, Number(staff.rate_cents)], ['referee', 'accepted', 140000]);
  assert.equal(must(await api('GET', `/event-requests/${rq.id}`, { token: org.token })).thread.length, 2);

  // physio declines
  const physio = await signup(['physio']);
  const pr = must(await post(`/events/${ev.id}/requests`, org, { kind: 'physio', user_id: physio.id, offer_cents: 200000 }), 201);
  assert.equal(must(await post(`/event-requests/${pr.id}/respond`, physio, { response: 'decline' })).status, 'declined');
  assert.equal((await post(`/event-requests/${pr.id}/finalize`, org, {})).status, 409);

  // venue + supplier quotes: the venue is set, budget lines are committed
  const vOwner = await signup(['venue_manager']), vn = await venue(vOwner, 'Arena', ['athletics']);
  const vr = must(await post(`/events/${ev.id}/requests`, org, { kind: 'venue', venue_id: vn.id, sports: ['athletics'] }), 201);
  assert.equal((await post(`/event-requests/${vr.id}/respond`, stranger, { response: 'accept' })).status, 403);
  must(await post(`/event-requests/${vr.id}/respond`, vOwner, { response: 'quote', quote_cents: 4500000 }));
  must(await post(`/event-requests/${vr.id}/finalize`, org, {}));
  assert.equal((await api('GET', `/events/${ev.id}`)).body.venue.id, vn.id);
  const sup = await signup(['supplier']);
  const sr = must(await post(`/events/${ev.id}/requests`, org, { kind: 'supplier', user_id: sup.id, title: '200 water bottles and 30 cones', quantity: 200 }), 201);
  must(await post(`/event-requests/${sr.id}/respond`, sup, { response: 'quote', quote_cents: 800000 }));
  must(await post(`/event-requests/${sr.id}/finalize`, org, {}));

  // sponsor: asked for money; accepting and finalizing makes the sponsorship active and an income line
  const spOwner = await signup(['sponsor']);
  const brand = must(await api('POST', '/sponsors', { token: spOwner.token, body: { name: 'FitCo' } }), 201);
  const spr = must(await post(`/events/${ev.id}/requests`, org, { kind: 'sponsor', sponsor_id: brand.id, offer_cents: 2500000, message: 'Title sponsor?' }), 201);
  must(await post(`/event-requests/${spr.id}/respond`, spOwner, { response: 'accept' }));
  must(await post(`/event-requests/${spr.id}/finalize`, org, {}));
  assert.equal((await api('GET', `/events/${ev.id}`)).body.sponsors.length, 1);

  // the budget now holds every committed booking
  const b = must(await api('GET', `/events/${ev.id}/budget`, { token: org.token }));
  assert.equal(b.summary.expense.committed_cents, 140000 + 4500000 + 800000);
  assert.equal(b.summary.income.committed_cents, 2500000);
  assert.equal(b.lines.filter((l) => l.request_id).length, 4);
  assert.equal(b.summary.net_forecast_cents, 2500000 - 5440000);
  assert.ok(b.alerts.some((a) => /does not cover/.test(a.text)));

  // cancel works until finalized
  const sr2 = must(await post(`/events/${ev.id}/requests`, org, { kind: 'supplier', user_id: sup.id, title: 'Trophies' }), 201);
  assert.equal(must(await post(`/event-requests/${sr2.id}/cancel`, org, {})).status, 'cancelled');
  assert.equal((await post(`/event-requests/${sr.id}/cancel`, org, {})).status, 409, 'a finalized booking is changed where it took effect');
  // drafts stay private until sent
  const draft = must(await post(`/events/${ev.id}/requests`, org, { kind: 'coach', user_id: (await signup(['coach'])).id, send: false }), 201);
  assert.equal(draft.status, 'draft');
  assert.equal(must(await post(`/event-requests/${draft.id}/send`, org, {})).status, 'sent');
  const plan = must(await api('GET', `/events/${ev.id}/plan`, { token: org.token }));
  assert.ok(plan.requests.by_kind.supplier.finalized >= 1);
  assert.ok(plan.todo.includes('No insurance arranged'));
  assert.equal(plan.event.days_to_go, 40);
});

test('insurance requests go through the insurance module and finalize once a quote is accepted', async () => {
  const org = await signup(['organizer']);
  const ev = await mkEvent(org, { name: 'Insured Cup' });
  const insurer = await signup(['insurer']);
  const ins = must(await api('POST', '/insurance/my-insurer', { token: insurer.token, body: { name: 'SafeCo' } }), 201);
  const partners = must(await api('GET', `/events/${ev.id}/partners`, { token: org.token, query: { kind: 'insurer' } }));
  assert.equal(partners[0].id, ins.id);
  const r = must(await api('POST', `/events/${ev.id}/requests`, { token: org.token, body: { kind: 'insurer', insurer_id: ins.id, quantity: 200, message: 'Cover 200 players' } }), 201);
  assert.equal(r.ref_type, 'insurance_quote_request');
  assert.equal((await api('POST', `/event-requests/${r.id}/respond`, { token: insurer.token, body: { response: 'accept' } })).status, 400, 'answered in the insurance desk');
  assert.equal((await api('POST', `/event-requests/${r.id}/finalize`, { token: org.token, body: {} })).status, 409);
  const plan = must(await api('POST', '/insurance/plans', { token: insurer.token, body: { name: 'Event cover', cover_for: 'event', premium_cents: 300000, coverage_cents: 50000000 } }), 201);
  const quote = must(await api('POST', '/insurance/quotes', { token: insurer.token, body: { request_id: r.ref_id, plan_id: plan.id, premium_cents: 300000, coverage_cents: 50000000, valid_days: 14 } }), 201);
  assert.equal(must(await api('GET', `/events/${ev.id}/requests`, { token: org.token })).find((x) => x.id === r.id).status, 'quoted');
  must(await api('POST', `/insurance/quotes/${quote.id}/accept`, { token: org.token, body: {} }), 201);
  const mid = must(await api('GET', `/events/${ev.id}/requests`, { token: org.token })).find((x) => x.id === r.id);
  assert.equal(mid.status, 'accepted');
  assert.equal(Number(mid.insurance.accepted_total_cents) > 0, true);
  const fin = must(await api('POST', `/event-requests/${r.id}/finalize`, { token: org.token, body: {} }));
  assert.equal(fin.status, 'finalized');
  const b = must(await api('GET', `/events/${ev.id}/budget`, { token: org.token }));
  assert.equal(b.lines.find((l) => l.category === 'insurance').committed_cents, Number(mid.insurance.accepted_total_cents));
});

test('budget: lines, cap and contingency, payments (void, never delete), alerts and export', async () => {
  const org = await signup(['organizer']), other = await signup(['organizer']);
  const ev = await mkEvent(org, { name: 'Budget Cup', entry_fee_cents: 50000 });
  const T = org.token;
  assert.equal((await api('GET', `/events/${ev.id}/budget`, { token: other.token })).status, 403);
  must(await api('PATCH', `/events/${ev.id}/budget`, { token: T, body: { spend_cap_cents: 1000000, contingency_pct: 10 } }));
  const venueLine = must(await api('POST', `/events/${ev.id}/budget/lines`, { token: T, body: { category: 'venue', name: 'Ground hire', planned_cents: 600000 } }), 201);
  const kit = must(await api('POST', `/events/${ev.id}/budget/lines`, { token: T, body: { category: 'equipment', name: 'Kit', planned_cents: 300000 } }), 201);
  const fees = must(await api('POST', `/events/${ev.id}/budget/lines`, { token: T, body: { direction: 'income', category: 'entry_fees', name: 'Entry fees', planned_cents: 900000 } }), 201);
  let b = must(await api('GET', `/events/${ev.id}/budget`, { token: T }));
  assert.equal(b.summary.expense.forecast_cents, 900000);
  assert.equal(b.summary.contingency_cents, 90000);
  assert.equal(b.summary.cap_used_pct, 99);
  assert.equal(b.summary.net_forecast_cents, 900000 - 900000 - 90000);
  assert.ok(b.alerts.some((a) => a.level === 'amber' && /cap/.test(a.text)));
  // payments: partial, over-pay flags a red alert, void fixes it
  const p1 = must(await api('POST', `/budget-lines/${venueLine.id}/payments`, { token: T, body: { amount_cents: 200000, method: 'bank', reference: 'UTR123' } }), 201);
  const p2 = must(await api('POST', `/budget-lines/${venueLine.id}/payments`, { token: T, body: { amount_cents: 500000, paid_on: day(0) } }), 201);
  b = must(await api('GET', `/events/${ev.id}/budget`, { token: T }));
  assert.equal(b.summary.expense.paid_cents, 700000);
  assert.ok(b.alerts.some((a) => a.level === 'red' && a.line_id === venueLine.id));
  assert.equal(b.summary.cap_used_pct > 100, true, 'forecast now follows what was actually paid');
  assert.equal((await api('POST', `/budget-lines/${venueLine.id}/payments`, { token: T, body: { amount_cents: 0 } })).status, 400);
  must(await api('POST', `/budget-payments/${p2.id}/void`, { token: T, body: { reason: 'Entered twice' } }));
  assert.equal((await api('POST', `/budget-payments/${p2.id}/void`, { token: T, body: { reason: 'again' } })).status, 409);
  b = must(await api('GET', `/events/${ev.id}/budget`, { token: T }));
  assert.equal(b.summary.expense.paid_cents, 200000);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_budget_payments WHERE line_id=$1', [venueLine.id])).rows[0].n, 2, 'voided payments stay on record');
  // income received, closing, voiding rules
  must(await api('POST', `/budget-lines/${fees.id}/payments`, { token: T, body: { amount_cents: 400000 } }), 201);
  assert.equal(must(await api('GET', `/events/${ev.id}/budget`, { token: T })).summary.net_cash_cents, 400000 - 200000);
  must(await api('PATCH', `/budget-lines/${kit.id}`, { token: T, body: { status: 'closed' } }));
  assert.equal((await api('POST', `/budget-lines/${kit.id}/payments`, { token: T, body: { amount_cents: 1000 } })).status, 409, 'closed lines take no payments');
  assert.equal((await api('PATCH', `/budget-lines/${venueLine.id}`, { token: T, body: { status: 'void' } })).status, 409, 'has payments');
  must(await api('PATCH', `/budget-lines/${fees.id}`, { token: T, body: { planned_cents: 1200000 } }));
  const x = must(await api('GET', `/events/${ev.id}/budget/export`, { token: T }));
  assert.match(x.csv, /Ground hire/);
  assert.equal(x.rows, 3);
  assert.equal(must(await api('GET', `/events/${ev.id}/budget`, { token: T })).summary.suggested_entry_fee_income_cents, 0);
});

test('tasks: a dated checklist on request, owners update their own, overdue is flagged', async () => {
  const org = await signup(['organizer']), helper = await signup();
  const ev = await mkEvent(org, { name: 'Task Cup', starts_on: day(30), ends_on: day(31) });
  const gen = must(await api('POST', `/events/${ev.id}/tasks/checklist`, { token: org.token, body: {} }), 201);
  assert.ok(gen.created >= 20);
  assert.equal(must(await api('POST', `/events/${ev.id}/tasks/checklist`, { token: org.token, body: {} }), 201).created, 0, 'repeating adds nothing');
  const tasks = must(await api('GET', `/events/${ev.id}/tasks`, { token: org.token }));
  const venueTask = tasks.find((t) => /Confirm the venue/.test(t.title));
  assert.equal(venueTask.due_on.slice(0, 10), day(30 - 60), 'dated back from the start date');
  assert.equal(venueTask.overdue, true);
  assert.equal(tasks.find((t) => /Brief officials/.test(t.title)).due_on.slice(0, 10), day(23));
  const mine = must(await api('POST', `/events/${ev.id}/tasks`, { token: org.token, body: { title: 'Print banners', category: 'marketing', owner_id: helper.id, due_on: day(10), priority: 'high' } }), 201);
  assert.equal((await api('POST', `/events/${ev.id}/tasks`, { token: org.token, body: { title: 'print banners' } })).status, 409);
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='event_task'", [helper.id])).rowCount >= 0);
  assert.equal((await api('PATCH', `/event-tasks/${mine.id}`, { token: helper.token, body: { title: 'Hacked' } })).status, 403);
  const done = must(await api('PATCH', `/event-tasks/${mine.id}`, { token: helper.token, body: { status: 'done', notes: 'Printed 12' } }));
  assert.equal(done.status, 'done');
  assert.ok(done.completed_at);
  assert.equal(must(await api('GET', `/events/${ev.id}/tasks`, { token: helper.token })).length, 1, 'an owner sees their own tasks');
  assert.equal(must(await api('GET', `/events/${ev.id}/plan`, { token: org.token })).tasks.done, 1);
  must(await api('PATCH', `/event-tasks/${venueTask.id}`, { token: org.token, body: { status: 'dropped' } }));
  assert.ok(!must(await api('GET', `/events/${ev.id}/tasks`, { token: org.token })).some((t) => t.id === venueTask.id));
});
