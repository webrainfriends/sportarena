import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `cb_${n}_${roles[0]}`, display_name: `Cb ${n}`, email: `cb${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const dayAt = (days, hour = 9) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const dateOf = (days) => dayAt(days).slice(0, 10);
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const coachOf = async (rate = 60000) => {
  const coach = await signup(['coach']);
  ok(await api('POST', '/me/sport-profiles', { token: coach.token, body: { sport: 'football', role: 'coach', level: 'pro', hourly_rate_cents: rate } }), 201);
  return coach;
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('specialisations and rate cards: validated, shown publicly, searchable by audience, archived not deleted', async () => {
  const coach = await coachOf(), other = await signup(['athlete']);
  const spec = ok(await api('POST', '/coach/specialisations', { token: coach.token, body: { sport: 'football', name: 'Goalkeeping', levels: ['amateur', 'pro'], years: 6, certification: 'UEFA GK B' } }), 201);
  assert.equal((await api('POST', '/coach/specialisations', { token: coach.token, body: { sport: 'tennis', name: 'Serve' } })).status, 400, 'only sports you coach');
  assert.equal((await api('POST', '/coach/specialisations', { token: other.token, body: { sport: 'football', name: 'x1' } })).status, 403);
  const hourly = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'One-to-one hour', sport: 'football', specialisation_id: spec.id, audience: 'individual', unit: 'hour', price_cents: 70000 } }), 201);
  const trial = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Trial session', sport: 'football', audience: 'individual', unit: 'session', duration_min: 45, price_cents: 20000, is_intro: true } }), 201);
  assert.equal((await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Bad group', audience: 'group', unit: 'hour', price_cents: 1000, min_participants: 5, max_participants: 3 } })).status, 400);
  assert.equal((await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Solo for many', audience: 'individual', unit: 'hour', price_cents: 1000, max_participants: 4 } })).status, 400);
  assert.equal((await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Pack', audience: 'individual', unit: 'package', price_cents: 1000 } })).status, 400, 'a package needs its session count');
  const team = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Team training day', sport: 'football', audience: 'team', unit: 'day', duration_min: 360, price_cents: 900000, min_participants: 8, max_participants: 30 } }), 201);
  const pub = ok(await api('GET', `/coaches/${coach.id}`));
  assert.deepEqual(pub.rate_cards.map((c) => c.title).sort(), ['One-to-one hour', 'Team training day', 'Trial session']);
  assert.equal(pub.specialisations[0].name, 'Goalkeeping');
  assert.equal(ok(await api('GET', '/coaches?sport=football&audience=team')).some((x) => x.id === coach.id), true);
  assert.equal(ok(await api('GET', '/coaches?sport=football&audience=event')).some((x) => x.id === coach.id), false);
  assert.equal(ok(await api('GET', '/coaches?sport=football&intro_offer=true')).some((x) => x.id === coach.id), true);
  assert.equal(ok(await api('GET', '/coaches?sport=football&q=goalkeep')).some((x) => x.id === coach.id), true, 'search finds specialisations');
  ok(await api('PATCH', `/coach/rate-cards/${trial.id}`, { token: coach.token, body: { price_cents: 25000, active: false } }));
  assert.equal(ok(await api('GET', `/coaches/${coach.id}`)).rate_cards.length, 2, 'switched-off cards are not public');
  ok(await api('PATCH', `/coach/rate-cards/${team.id}`, { token: coach.token, body: { archive: true } }));
  const mine = ok(await api('GET', '/coach/rate-cards', { token: coach.token }));
  assert.deepEqual(mine.map((c) => c.title).sort(), ['One-to-one hour', 'Trial session'], 'archived card leaves the list');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coach_rate_cards WHERE coach_id=$1', [coach.id])).rows[0].n, 3, 'but the row is kept');
  assert.equal((await api('PATCH', `/coach/rate-cards/${hourly.id}`, { token: other.token, body: { price_cents: 1 } })).status, 403);
  assert.equal(ok(await api('GET', '/coach/specialisations', { token: coach.token }))[0].sessions_done, 0);
});

test('team and event bookings from rate cards: who may book, headcount rules, per-person pricing', async () => {
  const coach = await coachOf(), manager = await signup(['athlete']), stranger = await signup(['athlete']), org = await signup(['organizer']);
  const teamCard = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Team day', sport: 'football', audience: 'team', unit: 'day', duration_min: 300, price_cents: 500000, min_participants: 8, max_participants: 25 } }), 201);
  const group = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Small group', sport: 'football', audience: 'group', unit: 'session', duration_min: 60, price_cents: 15000, per_person: true, min_participants: 2, max_participants: 6 } }), 201);
  const eventCard = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Clinic at your event', sport: 'football', audience: 'event', unit: 'session', duration_min: 120, price_cents: 300000 } }), 201);
  const team = ok(await api('POST', '/teams', { token: manager.token, body: { name: 'Riverside FC', sport: 'football' } }), 201);
  const ev = ok(await api('POST', '/events', { token: org.token, body: { name: 'Summer Cup', sport: 'football' } }), 201);
  const book = (token, body) => api('POST', '/hires', { token, body: { coach_id: coach.id, starts_at: dayAt(4, 8), ...body } });
  assert.equal((await book(stranger.token, { rate_card_id: teamCard.id, team_id: team.id, participants: 12 })).status, 403, 'only a team manager');
  assert.equal((await book(manager.token, { rate_card_id: teamCard.id, participants: 12 })).status, 400, 'a team card needs a team');
  assert.equal((await book(manager.token, { rate_card_id: teamCard.id, team_id: team.id, participants: 3 })).status, 400, 'below the minimum headcount');
  const t = ok(await book(manager.token, { rate_card_id: teamCard.id, team_id: team.id, participants: 12 }), 201);
  assert.equal(t.audience, 'team'); assert.equal(t.total_cents, 500000); assert.equal(t.duration_min, 300, 'length comes from the card');
  const g = ok(await book(stranger.token, { rate_card_id: group.id, participants: 4, starts_at: dayAt(5, 8) }), 201);
  assert.equal(g.total_cents, 60000, '4 people x per-person price');
  assert.equal((await book(stranger.token, { rate_card_id: group.id, participants: 9, starts_at: dayAt(6, 8) })).status, 400, 'above the maximum');
  assert.equal((await book(manager.token, { rate_card_id: eventCard.id, event_id: ev.id, starts_at: dayAt(7, 8) })).status, 403, 'only the organiser books for an event');
  assert.equal((await book(org.token, { rate_card_id: eventCard.id, event_id: ev.id, starts_at: dayAt(7, 8) }).then((r) => r)).status, 201);
  assert.equal((await book(stranger.token, { starts_at: dayAt(8, 8), sport: 'football', participants: 3 })).status, 400, 'no card: one person only');
  const cal = ok(await api('GET', `/coach/calendar?from=${dateOf(1)}&to=${dateOf(10)}`, { token: coach.token }));
  assert.ok(cal.items.some((x) => x.title.includes('Team coaching') && x.title.includes('Riverside FC')), 'team sessions are labelled by the team');
  assert.ok(cal.items.some((x) => x.title.includes('Event coaching') && x.title.includes('Summer Cup')));
});

test('commitments fill the schedule, block booking, and the delivery log drives reports', async () => {
  const coach = await coachOf(), athlete = await signup(['athlete']);
  ok(await api('POST', '/me/coach-profile', { token: coach.token, body: { timezone: 'UTC' } }));
  ok(await api('POST', '/me/coach-availability', { token: coach.token, body: { windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '08:00', end: '12:00' })) } }));
  const slotsBefore = ok(await api('GET', `/coaches/${coach.id}/slots?from=${encodeURIComponent(dayAt(3, 0))}&to=${encodeURIComponent(dayAt(4, 0))}`)).slots;
  const target = new Date(dayAt(3, 9)), wd = target.getUTCDay();
  assert.equal((await api('POST', '/coach/commitments', { token: coach.token, body: { kind: 'team', title: 'x', starts_on: dateOf(3), weekdays: [wd], start: '9am' } })).status, 400);
  const c = ok(await api('POST', '/coach/commitments', { token: coach.token, body: { kind: 'retainer', title: 'Academy under-14s', client_name: 'Hilltop Academy', starts_on: dateOf(-14), ends_on: dateOf(60), weekdays: [wd], start: '09:00', duration_min: 60, fee_cents: 200000, fee_unit: 'session' } }), 201);
  assert.deepEqual(c.clashes, []);
  const slotsAfter = ok(await api('GET', `/coaches/${coach.id}/slots?from=${encodeURIComponent(dayAt(3, 0))}&to=${encodeURIComponent(dayAt(4, 0))}`)).slots;
  assert.equal(slotsAfter.length, slotsBefore.length - 1, 'the 09:00 slot is gone');
  assert.equal((await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: dayAt(3, 9), duration_min: 60 } })).status, 409);
  const hire = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: dayAt(3, 10), duration_min: 60 } }), 201);
  const clash = ok(await api('POST', '/coach/commitments', { token: coach.token, body: { kind: 'personal', title: 'Gym', starts_on: dateOf(3), weekdays: [], start: '10:30', duration_min: 60 } }), 201);
  assert.ok(clash.clashes.some((x) => x.with === 'session' && x.id === hire.id), 'a clash with an existing session is reported, not blocked');
  // schedule shows it; skipping a date removes it; delivering a past one counts
  const cal = () => api('GET', `/coach/calendar?from=${dateOf(-14)}&to=${dateOf(10)}`, { token: coach.token }).then((r) => ok(r).items.filter((x) => x.source_type === 'coach_commitment' && x.title === 'Academy under-14s'));
  const before = (await cal()).length; assert.ok(before >= 3);
  const past = (await cal()).find((x) => x.starts_at < new Date().toISOString()).starts_at.slice(0, 10);
  assert.equal((await api('POST', `/coach/commitments/${c.id}/log`, { token: coach.token, body: { on_date: dateOf(1) === past ? dateOf(2) : '1999-01-01', status: 'delivered' } })).status, 400, 'not a scheduled date');
  ok(await api('POST', `/coach/commitments/${c.id}/log`, { token: coach.token, body: { on_date: past, status: 'delivered', note: 'Went well' } }));
  ok(await api('POST', `/coach/commitments/${c.id}/log`, { token: coach.token, body: { on_date: dateOf(3), status: 'skipped' } }));
  assert.equal((await cal()).length, before - 1, 'the skipped date leaves the schedule');
  const listed = ok(await api('GET', '/coach/commitments', { token: coach.token })).find((x) => x.id === c.id);
  assert.equal(listed.delivered, 1); assert.equal(listed.skipped, 1); assert.ok(listed.upcoming.length >= 1);
  const an = ok(await api('GET', `/coach/analytics?from=${dateOf(-14)}&to=${dateOf(0)}`, { token: coach.token }));
  assert.equal(an.commitments.sessions_delivered, 1); assert.equal(an.commitments.income_cents, 200000);
  assert.ok(an.utilisation.pct > 0);
  const csv = ok(await api('GET', `/coach/report?from=${dateOf(-14)}&to=${dateOf(0)}`, { token: coach.token }));
  assert.ok(csv.csv.startsWith('Date,Type,Client') && csv.csv.includes('Commitment: Academy under-14s') && csv.csv.includes('Hilltop Academy'));
  ok(await api('PATCH', `/coach/commitments/${c.id}`, { token: coach.token, body: { status: 'paused' } }));
  assert.equal((await cal()).length, 0, 'paused commitments leave the schedule');
  ok(await api('PATCH', `/coach/commitments/${c.id}`, { token: coach.token, body: { status: 'cancelled' } }));
  assert.equal((await api('PATCH', `/coach/commitments/${c.id}`, { token: coach.token, body: { status: 'active' } })).status, 409);
  assert.equal((await api('GET', '/coach/commitments', { token: athlete.token })).status, 403);
});

test('testimonials both ways: need a relationship, review nudges once, pin at most three', async () => {
  const coach = await coachOf(), athlete = await signup(['athlete']), stranger = await signup(['athlete']);
  assert.equal((await api('POST', `/coach/athletes/${stranger.id}/testimonial`, { token: coach.token, body: { rating: 5, body: 'Great attitude' } })).status, 403, 'no relationship');
  const mk = async (days) => {
    const h = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: dayAt(days, 9), duration_min: 60 } }), 201);
    ok(await api('PATCH', `/hires/${h.id}`, { token: coach.token, body: { status: 'confirmed' } }));
    return h;
  };
  const h1 = await mk(2);
  ok(await api('POST', `/coach/athletes/${athlete.id}/testimonial`, { token: coach.token, body: { rating: 5, body: 'Coachable and hard-working' } }), 201);
  const pub = ok(await api('GET', `/testimonials?subject_type=user&subject_id=${athlete.id}`));
  assert.equal(pub.n, 1, 'shows on the athlete\'s public profile');
  assert.equal((await api('POST', `/hires/${h1.id}/request-review`, { token: coach.token })).status, 409, 'not completed yet');
  ok(await api('PATCH', `/hires/${h1.id}`, { token: coach.token, body: { status: 'completed' } }));
  ok(await api('POST', `/hires/${h1.id}/request-review`, { token: coach.token }));
  assert.equal((await api('POST', `/hires/${h1.id}/request-review`, { token: coach.token })).status, 409, 'once only');
  assert.ok(JSON.stringify(ok(await api('GET', '/notifications', { token: athlete.token }))).includes('would value your review'));
  const reviews = [];
  for (const d of [3, 4, 5, 6]) {
    const h = d === 3 ? h1 : await mk(d);
    if (d !== 3) ok(await api('PATCH', `/hires/${h.id}`, { token: coach.token, body: { status: 'completed' } }));
    reviews.push(ok(await api('POST', `/hires/${h.id}/review`, { token: athlete.token, body: { rating: 5 } }), 201));
  }
  for (const r of reviews.slice(0, 3)) ok(await api('POST', `/coach-reviews/${r.id}/pin`, { token: coach.token, body: { pinned: true } }));
  assert.equal((await api('POST', `/coach-reviews/${reviews[3].id}/pin`, { token: coach.token, body: { pinned: true } })).status, 409, 'three pins at most');
  assert.equal((await api('POST', `/coach-reviews/${reviews[0].id}/pin`, { token: athlete.token, body: { pinned: true } })).status, 403);
  const profile = ok(await api('GET', `/coaches/${coach.id}`));
  assert.deepEqual(profile.reviews.slice(0, 3).map((r) => r.pinned), [true, true, true]);
  assert.equal(ok(await api('GET', '/coach/testimonials', { token: coach.token })).length, 4);
  assert.equal(ok(await api('GET', '/coach/testimonials?dir=given', { token: coach.token })).length, 1);
});

test('analytics and statement over rate-card sessions; an answer to a team request must quote a team card', async () => {
  const coach = await coachOf(), manager = await signup(['athlete']), athlete = await signup(['athlete']);
  const spec = ok(await api('POST', '/coach/specialisations', { token: coach.token, body: { sport: 'football', name: 'Finishing' } }), 201);
  const card = ok(await api('POST', '/coach/rate-cards', { token: coach.token, body: { title: 'Squad clinic', sport: 'football', specialisation_id: spec.id, audience: 'team', unit: 'session', duration_min: 90, price_cents: 120000, min_participants: 6 } }), 201);
  const team = ok(await api('POST', '/teams', { token: manager.token, body: { name: 'Hill Rovers', sport: 'football' } }), 201);
  // a team request: the coach quotes the team card, the manager accepts, price is fixed by the card
  const req = ok(await api('POST', '/coach-requests', { token: manager.token, body: { sport: 'football', title: 'Pre-season clinic', audience: 'team', team_id: team.id, participants: 14 } }), 201);
  assert.equal((await api('POST', '/coach-requests', { token: athlete.token, body: { sport: 'football', title: 'Hijack', audience: 'team', team_id: team.id } })).status, 403);
  assert.equal((await api('POST', `/coach-requests/${req.id}/respond`, { token: coach.token, body: { starts_at: dayAt(3, 9) } })).status, 400, 'must quote a team rate card');
  const ans = ok(await api('POST', `/coach-requests/${req.id}/respond`, { token: coach.token, body: { rate_card_id: card.id, starts_at: dayAt(3, 9) } }), 201);
  assert.equal(ans.total_cents, 120000); assert.equal(ans.duration_min, 90);
  const seen = ok(await api('GET', `/coach-requests/${req.id}`, { token: manager.token }));
  assert.equal(seen.responses[0].rate_card_title, 'Squad clinic'); assert.equal(seen.team_name, 'Hill Rovers');
  const done = ok(await api('POST', `/coach-responses/${ans.id}/decision`, { token: manager.token, body: { decision: 'accept' } }));
  assert.equal(done.hire.audience, 'team'); assert.equal(done.hire.total_cents, 120000); assert.equal(done.hire.participants, 14);
  ok(await api('PATCH', `/hires/${done.hire.id}`, { token: coach.token, body: { status: 'completed' } }));
  // an individual session on the standard rate, completed, plus a cancelled one
  const h = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: dayAt(5, 9), duration_min: 60 } }), 201);
  ok(await api('PATCH', `/hires/${h.id}`, { token: coach.token, body: { status: 'confirmed' } }));
  ok(await api('PATCH', `/hires/${h.id}`, { token: coach.token, body: { status: 'completed' } }));
  const x = ok(await api('POST', '/hires', { token: athlete.token, body: { coach_id: coach.id, sport: 'football', starts_at: dayAt(6, 9), duration_min: 60 } }), 201);
  ok(await api('PATCH', `/hires/${x.id}`, { token: athlete.token, body: { status: 'cancelled' } }));
  const an = ok(await api('GET', `/coach/analytics?from=${dateOf(0)}&to=${dateOf(10)}`, { token: coach.token }));
  assert.equal(an.totals.sessions_completed, 2); assert.equal(an.totals.sessions_cancelled, 1);
  assert.equal(an.totals.income_cents, 120000 + 60000); assert.equal(an.totals.hours_delivered, 2.5); assert.equal(an.totals.clients, 2);
  assert.deepEqual(an.by_audience.map((r) => [r.key, r.income_cents]), [['team', 120000], ['individual', 60000]]);
  assert.equal(an.by_rate_card[0].key, 'Squad clinic'); assert.equal(an.by_specialisation[0].key, 'Finishing');
  assert.equal(an.requests.answered, 1); assert.equal(an.requests.won, 1); assert.equal(an.requests.win_rate_pct, 100);
  assert.equal(an.cancellations.by_client, 1); assert.equal(an.utilisation.pct, null, 'no weekly hours published, so no utilisation');
  assert.equal((await api('GET', `/coach/analytics?from=2020-01-01&to=2026-01-01`, { token: coach.token })).status, 400, 'range is limited');
  assert.equal((await api('GET', '/coach/analytics', { token: athlete.token })).status, 403);
  const rep = ok(await api('GET', `/coach/report?from=${dateOf(0)}&to=${dateOf(10)}`, { token: coach.token }));
  assert.equal(rep.rows, 3); assert.ok(rep.csv.includes('Hill Rovers') && rep.csv.includes('Squad clinic'));
  const specList = ok(await api('GET', '/coach/specialisations', { token: coach.token }))[0];
  assert.equal(specList.sessions_done, 1); assert.equal(specList.income_cents, 120000);
});
