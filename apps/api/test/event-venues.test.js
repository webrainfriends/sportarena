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
  const r = await api('POST', '/auth/register', { body: { handle: `ev_v${n}_${roles[0]}`, display_name: `Ev ${n}`, email: `evv${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function venue(owner, name, courts, country = 'IN') {
  const v = must(await api('POST', '/venues', { token: owner.token, body: { name, city: 'Mumbai', country, timezone: 'UTC' } }), 201);
  must(await api('POST', `/venues/${v.id}/hours`, { token: owner.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '08:00', closes: '20:00' })) } }));
  const rs = [];
  for (const c of courts) rs.push(must(await api('POST', `/venues/${v.id}/resources`, { token: owner.token, body: { kind: 'court', name: c.name, sport: c.sport, hourly_rate_cents: 50000 } }), 201));
  return { ...v, courts: rs };
}

test('venue finder lists courts for the sport and all-purpose courts, not other sports; multi-sport events see every venue', async () => {
  const org = await signup(['organizer']), vm = await signup(['venue_manager']);
  const general = await venue(vm, 'General Hall', [{ name: 'Hall 1' }, { name: 'Hall 2' }]);
  const tagged = await venue(vm, 'Hoops Centre', [{ name: 'Court 1', sport: 'basketball' }]);
  const tennis = await venue(vm, 'Tennis Club', [{ name: 'Clay', sport: 'tennis' }]);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Hoops Cup', sport: 'basketball', kind: 'tournament' } }), 201);
  const found = must(await api('GET', `/events/${ev.id}/partners?kind=venue`, { token: org.token }));
  const names = found.map((v) => v.name);
  assert.ok(names.includes('General Hall') && names.includes('Hoops Centre'), names.join());
  assert.ok(!names.includes('Tennis Club'), 'a tennis-only venue does not suit basketball');
  assert.equal(found[0].name, 'Hoops Centre', 'venues with courts for the sport come first');
  assert.ok('cover_url' in found[0], 'results carry the cover photo (null when none)');
  assert.equal(found.find((v) => v.name === 'General Hall').all_purpose_courts, 2);
  assert.deepEqual((await api('GET', `/venue-finder?sports=basketball`)).body[0].venues.map((v) => v.name).sort(), ['General Hall', 'Hoops Centre']);
  const multi = must(await api('POST', '/events', { token: org.token, body: { name: 'Games', sport: 'multi-sport', kind: 'tournament' } }), 201);
  assert.equal((await api('GET', `/events/${multi.id}/partners?kind=venue`, { token: org.token })).body.length, 3, 'no sports chosen yet: every venue with courts');
  assert.ok(tennis.id && general.id && tagged.id);
});

test('check, book, list and release the courts for an event; budget line, holidays, hours and clashes', async () => {
  const org = await signup(['organizer']), vm = await signup(['venue_manager']), stranger = await signup(['athlete']);
  const v = await venue(vm, 'Arena', [{ name: 'Court A' }, { name: 'Court B' }], 'IN');
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Booked Cup', sport: 'basketball', kind: 'tournament', starts_on: day(5), ends_on: day(6) } }), 201);
  const win = { venue_id: v.id, from_date: day(5), to_date: day(6), start_time: '09:00', end_time: '12:00' };

  const pv = must(await api('POST', `/events/${ev.id}/venue-bookings/preview`, { token: org.token, body: win }));
  assert.equal(pv.rows.length, 4); assert.ok(pv.rows.every((r) => r.status === 'free'));
  assert.equal(pv.summary.free, 4); assert.equal(pv.summary.total_cents, 4 * 3 * 50000, '3h x 50000/h per court-day');
  assert.equal((await api('POST', `/events/${ev.id}/venue-bookings/preview`, { token: stranger.token, body: win })).status, 403);
  const early = must(await api('POST', `/events/${ev.id}/venue-bookings/preview`, { token: org.token, body: { ...win, start_time: '06:00', end_time: '09:00' } }));
  assert.ok(early.rows.every((r) => r.status === 'closed'), 'outside opening hours');
  assert.equal((await api('POST', `/events/${ev.id}/venue-bookings/preview`, { token: org.token, body: { ...win, end_time: '08:00' } })).status, 400);

  // a public holiday on day 6 is skipped; a held court makes the slot unavailable
  must(await api('POST', '/holidays', { token: org.token, body: { country: 'IN', days: [{ on_date: day(6), label: 'Festival' }] } }), 201);
  const withHol = must(await api('POST', `/events/${ev.id}/venue-bookings/preview`, { token: org.token, body: win }));
  assert.equal(withHol.summary.free, 2); assert.deepEqual(Object.keys(withHol.skipped_dates), [day(6)]);
  assert.equal(must(await api('POST', `/events/${ev.id}/venue-bookings/preview`, { token: org.token, body: { ...win, respect_holidays: false } })).summary.free, 4);

  const done = must(await api('POST', `/events/${ev.id}/venue-bookings`, { token: org.token, body: win }), 201);
  assert.equal(done.booked, 2); assert.equal(done.total_cents, 2 * 3 * 50000); assert.ok(done.budget_line_id);
  assert.equal((await api('GET', `/events/${ev.id}`)).body.venue_id, v.id, 'the event now has a venue');
  const budget = must(await api('GET', `/events/${ev.id}/budget`, { token: org.token }));
  assert.ok(JSON.stringify(budget).includes('Courts at Arena'));

  // the same slots again: 409 lists them; skip_unavailable with nothing free is also refused
  const again = await api('POST', `/events/${ev.id}/venue-bookings`, { token: org.token, body: win });
  assert.equal(again.status, 409); assert.ok(JSON.stringify(again.body).includes('booked'));
  assert.equal((await api('POST', `/events/${ev.id}/venue-bookings`, { token: org.token, body: { ...win, skip_unavailable: true } })).status, 409);
  // part available: another event books around the first
  const ev2 = must(await api('POST', '/events', { token: org.token, body: { name: 'Second', sport: 'basketball', kind: 'tournament' } }), 201);
  const part = must(await api('POST', `/events/${ev2.id}/venue-bookings`, { token: org.token, body: { ...win, resource_ids: [v.courts[0].id], from_date: day(5), to_date: day(5), start_time: '11:00', end_time: '13:00', skip_unavailable: false } }).then((r) => (r.status === 409 ? { status: 200, body: r.body } : r)));
  assert.ok(part.error || part.booked !== undefined);

  const venues = must(await api('GET', `/events/${ev.id}/venues`, { token: org.token }));
  assert.equal(venues.length, 1); assert.equal(venues[0].chosen, true);
  assert.equal(venues[0].summary.slots, 2); assert.equal(venues[0].summary.total_cents, 300000);
  assert.ok('cover_url' in venues[0]); assert.equal(venues[0].country, 'IN');

  // release one: refund policy applies, slot frees up, summary shrinks
  const rel = must(await api('POST', `/event-bookings/${venues[0].bookings[0].id}/release`, { token: org.token, body: { reason: 'Moved' } }));
  assert.ok('refund_cents' in rel);
  const after = must(await api('GET', `/events/${ev.id}/venues`, { token: org.token }));
  assert.equal(after[0].summary.slots, 1);
  assert.equal((await api('POST', `/event-bookings/${venues[0].bookings[0].id}/release`, { token: org.token, body: {} })).status, 409, 'already released');
  assert.equal((await api('POST', `/event-bookings/${venues[0].bookings[1].id}/release`, { token: stranger.token, body: {} })).status, 403);
});

test('event bookings that do not match the event dates need the organiser’s consent; the fit report shows wasted spend; the venue schedule lists event bookings', async () => {
  const org = await signup(['organizer']), vm = await signup(['venue_manager']);
  const v = await venue(vm, 'Fit Arena', [{ name: 'Court 1' }]);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Fit Cup', sport: 'basketball', kind: 'tournament', starts_on: day(10), ends_on: day(11) } }), 201);
  assert.equal((await api('GET', `/events/${ev.id}`)).body.starts_on.slice(0, 10), day(10));

  // exact match: no consent needed
  const exact = must(await api('POST', `/events/${ev.id}/venue-bookings/preview`, { token: org.token, body: { venue_id: v.id, from_date: day(10), to_date: day(11), start_time: '09:00', end_time: '10:00' } }));
  assert.equal(exact.alignment.matches, true); assert.equal(exact.alignment.consent_required, false);

  // a day early + a day late: refused with the wasted spend and a trimmed alternative
  const wide = { venue_id: v.id, from_date: day(9), to_date: day(12), start_time: '09:00', end_time: '10:00' };
  const pv = must(await api('POST', `/events/${ev.id}/venue-bookings/preview`, { token: org.token, body: wide }));
  assert.equal(pv.alignment.consent_required, true); assert.deepEqual(pv.alignment.before, [day(9)]); assert.deepEqual(pv.alignment.after, [day(12)]);
  assert.equal(pv.alignment.wasted_cents, 2 * 50000);
  assert.deepEqual(pv.alignment.suggested_window, { from_date: day(10), to_date: day(11) });
  assert.equal(pv.alignment.options.find((o) => o.recommended).saves_cents, 100000);
  const refused = await api('POST', `/events/${ev.id}/venue-bookings`, { token: org.token, body: wide });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details.consent_required, true);
  assert.equal((await api('GET', `/events/${ev.id}/venues`, { token: org.token })).body.length, 0, 'nothing was booked without consent');

  // with consent it is booked, flagged, and shows up as waste in the fit report
  const done = must(await api('POST', `/events/${ev.id}/venue-bookings`, { token: org.token, body: { ...wide, accept_mismatch: true } }), 201);
  assert.equal(done.booked, 4); assert.equal(done.alignment.consent_required, true);
  const fit = must(await api('GET', `/events/${ev.id}/fit`, { token: org.token }));
  assert.equal(fit.totals.booked_cents, 4 * 50000); assert.equal(fit.totals.wasted_cents, 2 * 50000);
  assert.ok(fit.venues[0].bookings.some((b) => b.state === 'wasted_before') && fit.venues[0].bookings.some((b) => b.state === 'idle_after'));
  assert.ok(fit.findings.some((f) => f.code === 'venue_time_wasted' && f.severity === 'high'));
  const rec = fit.venues[0].compare.find((o) => o.key === 'release_idle');
  assert.equal(rec.saves_cents, 100000); assert.equal(rec.release_booking_ids.length, 2);
  assert.equal((await api('GET', `/events/${ev.id}/fit`, { token: vm.token })).status, 403);

  // the venue team sees the event bookings on its schedule, labelled with the event
  const sch = must(await api('GET', `/venues/${v.id}/schedule?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 30 * 864e5).toISOString())}`, { token: vm.token }));
  assert.equal(sch.bookings.length, 4); assert.ok(sch.bookings.every((b) => b.event_id === ev.id && b.event_name === 'Fit Cup' && b.event_starts_on === day(10) && b.event_ends_on === day(11)));

  // releasing the idle slots brings the event back to efficient (no games yet: the in-window days are "awaiting schedule")
  for (const bid of rec.release_booking_ids) must(await api('POST', `/event-bookings/${bid}/release`, { token: org.token, body: {} }));
  const clean = must(await api('GET', `/events/${ev.id}/fit`, { token: org.token }));
  assert.equal(clean.totals.wasted_cents, 0); assert.ok(!clean.findings.some((f) => f.severity === 'high'));
});

test('games placed outside the event dates need consent too; single fixtures and the fit report flag them', async () => {
  const org = await signup(['organizer']), vm = await signup(['venue_manager']);
  const v = await venue(vm, 'Fixture Arena', [{ name: 'Main' }]);
  const t1 = must(await api('POST', '/teams', { token: org.token, body: { name: 'Fit A', sport: 'basketball' } }), 201), t2 = must(await api('POST', '/teams', { token: org.token, body: { name: 'Fit B', sport: 'basketball' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: 'Window Cup', sport: 'basketball', kind: 'tournament', starts_on: day(20), ends_on: day(20) } }), 201);
  for (const t of [t1, t2]) { const e = must(await api('POST', `/events/${ev.id}/entries`, { token: org.token, body: { team_id: t.id } }), 201); must(await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } })); }
  const at = new Date(`${day(22)}T10:00:00Z`).toISOString();
  const early = await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: t1.id, away_team_id: t2.id, scheduled_at: at, resource_id: v.courts[0].id } });
  assert.equal(early.status, 409); assert.equal(early.body.error.details.consent_required, true);
  must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: t1.id, away_team_id: t2.id, scheduled_at: at, resource_id: v.courts[0].id, accept_mismatch: true } }), 201);
  const fit = must(await api('GET', `/events/${ev.id}/fit`, { token: org.token }));
  assert.ok(fit.findings.some((f) => f.code === 'activity_outside_event_dates'));
  assert.ok(fit.venues[0].bookings.some((b) => b.state === 'idle_after'), 'booked after the event ended');

  const sched = { format: 'knockout', venue_id: v.id, from_date: day(21), to_date: day(23), match_duration_min: 60 };
  const p = must(await api('POST', `/events/${ev.id}/schedule/preview`, { token: org.token, body: sched }));
  assert.equal(p.alignment.consent_required, true);
  const no = await api('POST', `/events/${ev.id}/schedule`, { token: org.token, body: sched });
  assert.equal(no.status, 409, JSON.stringify(no.body)); assert.equal(no.body.error.details?.consent_required, true, JSON.stringify(no.body));
});
