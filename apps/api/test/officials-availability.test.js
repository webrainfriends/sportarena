// Official availability and scheduling preferences (#994, REF-R03): recurring blackout, cross-zone dates, update conflict, cancelled match
// release, tentative holds, the official's own limits, privacy towards organisers, idempotency, history and REST / OpenAPI / MCP parity.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool, tx } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const eng = await import('../src/official-availability.js');
const { assertOfficialEligible } = await import('../src/officials.js');
const { addDays } = await import('../src/booking/time.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `oa_${n}_${roles[0]}`, display_name: `Avail ${n}`, email: `oa${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup(sport = 'basketball') {
  const org = await signup(['organizer']);
  const caps = await Promise.all([signup(['athlete']), signup(['athlete']), signup(['athlete']), signup(['athlete'])]);
  const teams = [];
  for (const [i, c] of caps.entries()) teams.push(must(await api('POST', '/teams', { token: c.token, body: { name: `OA${n}-${i}`, sport } }), 201));
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Avail Open ${n}`, sport } }), 201);
  for (const [i, c] of caps.entries()) {
    const e = must(await api('POST', `/events/${ev.id}/entries`, { token: c.token, body: { team_id: teams[i].id } }), 201);
    await api('PATCH', `/entries/${e.id}`, { token: org.token, body: { status: 'accepted' } });
  }
  const fx = async (scheduled_at, pair = 0, extra = {}) => must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: teams[pair * 2].id, away_team_id: teams[pair * 2 + 1].id, scheduled_at, ...extra } }), 201);
  return { org, ev, teams, fx };
}
const referee = async (sport = 'basketball', tz = null, prefs = {}) => {
  const r = await signup(['referee']);
  must(await api('POST', '/me/sport-profiles', { token: r.token, body: { sport, role: 'referee' } }), 201);
  if (tz) must(await api('POST', '/me/officials/availability/prefs', { token: r.token, body: { timezone: tz, ...prefs } }));
  return r;
};
const invite = (org, fixtureId, user, role = 'referee') => api('POST', `/fixtures/${fixtureId}/officials`, { token: org.token, body: { user_id: user.id, role } });
const mine = async (u) => must(await api('GET', '/me/official-assignments', { token: u.token }));
const accept = (u, id) => api('POST', `/official-assignments/${id}/respond`, { token: u.token, body: { response: 'accept' } });
const avail = async (u) => must(await api('GET', '/me/officials/availability', { token: u.token }));
const calendar = async (u, fromMs, toMs) => must(await api('GET', '/me/officials/calendar', { token: u.token, query: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() } }));

/** The local date of the next given weekday (0 = Sunday) at least `ahead` days from now, in a zone. */
const nextWeekday = (weekday, tz, ahead = 14) => {
  let d = addDays(eng.localDate(Date.now(), tz), ahead);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== weekday) d = addDays(d, 1);
  return d;
};
/** An instant from a local date and HH:MM in a zone. */
const local = (date, hhmm, tz) => { const [h, m] = hhmm.split(':').map(Number); return new Date(eng.localToMs(date, h * 60 + m, tz)).toISOString(); };

test('recurring blackout: every other Tuesday evening is blocked in the official\'s own zone, a skipped date and the off weeks stay open', async () => {
  const tz = 'Asia/Kolkata';
  const { org, fx } = await setup();
  const ref = await referee('basketball', tz);
  const tue = nextWeekday(2, tz);
  const body = { recurrence: { starts_on: tue, ends_on: addDays(tue, 56), weekdays: [2], every_n_weeks: 2, start_minute: 18 * 60, end_minute: 22 * 60, exclude_dates: [addDays(tue, 28)] }, category: 'work', note: 'Night shift at the plant' };
  const dry = must(await api('POST', '/me/officials/availability/preview', { token: ref.token, body: { time_off: { recurrence: body.recurrence } } }));
  assert.equal(dry.total_occurrences, 4, 'weeks 0, 2, 6 and 8: week 4 is skipped');
  assert.equal((await avail(ref)).recurring.length, 0, 'a preview saves nothing');

  const block = must(await api('POST', '/me/officials/availability/time-off', { token: ref.token, body }), 201);
  assert.equal(block.kind, 'recurring');
  assert.equal(block.timezone, tz);
  assert.deepEqual(block.affected_assignments, []);

  const blocked = await fx(local(tue, '19:00', tz));
  const r = await invite(org, blocked.id, ref);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.details.code, 'time_off');
  assert.ok(!JSON.stringify(r.body).includes('Night shift'), 'the organiser never sees the note');
  assert.ok(!JSON.stringify(r.body).includes('work'), 'nor the category');

  const before6pm = await fx(local(tue, '15:00', tz), 1);
  assert.equal((await invite(org, before6pm.id, ref)).status, 201, 'earlier the same day is open');
  const offWeek = await fx(local(addDays(tue, 7), '19:00', tz));
  assert.equal((await invite(org, offWeek.id, ref)).status, 201, 'the week in between is open');
  const skipped = await fx(local(addDays(tue, 28), '19:00', tz));
  assert.equal((await invite(org, skipped.id, ref)).status, 201, 'an excluded date is open');
  const week2 = await fx(local(addDays(tue, 14), '21:00', tz));
  assert.equal((await invite(org, week2.id, ref)).status, 409, 'two weeks on is blocked again');
  const after = await fx(local(addDays(tue, 70), '19:00', tz));
  assert.equal((await invite(org, after.id, ref)).status, 201, 'after the pattern ends it is open');

  // re-timing a match onto the block is refused the same way
  assert.equal((await api('PATCH', `/fixtures/${offWeek.id}`, { token: org.token, body: { scheduled_at: local(addDays(tue, 14), '19:30', tz) } })).status, 409);

  const cal = await calendar(ref, eng.localToMs(tue, 0, tz), eng.localToMs(addDays(tue, 57), 0, tz));
  const occ = cal.entries.filter((e) => e.kind === 'time_off');
  assert.equal(occ.length, 4);
  assert.ok(occ.every((e) => e.repeats && e.source_type === 'official_availability' && e.source_id === block.id), 'each occurrence points at the one source row');
  assert.deepEqual(occ.map((e) => e.occurrence), [tue, addDays(tue, 14), addDays(tue, 42), addDays(tue, 56)]);
  assert.equal(occ[0].subtitle, 'Night shift at the plant', 'the owner sees their own note');

  // skipping one more date through the versioned update
  const upd = must(await api('PATCH', `/me/officials/availability/${block.id}`, { token: ref.token, body: { expected_version: block.version, skip_dates: [addDays(tue, 14)] } }));
  assert.equal(upd.version, block.version + 1);
  assert.equal((await invite(org, week2.id, ref)).status, 201, 'the skipped occurrence is open now');
  // the note is encrypted at rest and the legacy plain column is not used
  const row = (await pool.query('SELECT note, note_enc FROM official_availability WHERE id=$1', [block.id])).rows[0];
  assert.equal(row.note, null);
  assert.ok(row.note_enc && !row.note_enc.includes('Night shift'));
});

test('cross-zone dates: wall-clock rules follow the official\'s zone across the date line and across daylight saving', async () => {
  // Auckland is a calendar day ahead of most venues: an all-day Saturday block must cover Saturday in Auckland, not Saturday in UTC
  const tz = 'Pacific/Auckland';
  const { org, fx } = await setup();
  const ref = await referee('basketball', tz);
  const sat = nextWeekday(6, tz);
  must(await api('POST', '/me/officials/availability/time-off', { token: ref.token, body: { recurrence: { starts_on: sat, ends_on: sat, weekdays: [6] }, all_day: true } }), 201);
  const satMorningNz = local(sat, '09:00', tz);
  assert.notEqual(satMorningNz.slice(0, 10), sat, 'that instant is still Friday in UTC');
  assert.equal((await invite(org, (await fx(satMorningNz)).id, ref)).status, 409, 'Saturday morning in Auckland is blocked although it is Friday in UTC');
  const sunEarlyNz = local(addDays(sat, 1), '02:00', tz);
  assert.equal(sunEarlyNz.slice(0, 10), sat, 'that instant is Saturday in UTC');
  const open = await fx(sunEarlyNz, 1);
  assert.equal((await invite(org, open.id, ref)).status, 201, 'Sunday 02:00 in Auckland is open although it is Saturday in UTC');
  const cal = await calendar(ref, eng.localToMs(sat, 0, tz), eng.localToMs(addDays(sat, 2), 0, tz));
  assert.equal(cal.timezone, tz);
  assert.equal(cal.entries.find((e) => e.fixture_id === open.id).local_date, addDays(sat, 1), 'the calendar files the match under the official\'s local day');
  assert.equal(cal.days.find((d) => d.date === sat).blocked, 1);

  // a public holiday is one whole local day, wherever the server or venue is: Kiritimati is UTC+14, Honolulu UTC-10
  for (const [zone, hours] of [['Pacific/Kiritimati', 14], ['Pacific/Honolulu', -10]]) {
    const [o] = eng.expandBlocks([{ id: 'h', kind: 'holiday', starts_on: '2027-01-26', timezone: zone }], Date.parse('2027-01-24T00:00:00Z'), Date.parse('2027-01-28T00:00:00Z'));
    assert.equal(o.startMs, Date.parse('2027-01-26T00:00:00Z') - hours * 3600000, zone);
    assert.equal(o.endMs - o.startMs, 864e5);
  }
  // weekly hours keep their local time when the clocks change: 10:00 New York is 15:00Z in winter and 14:00Z in summer
  const weekly = [{ kind: 'weekly', weekday: 0, start_minute: 9 * 60, end_minute: 13 * 60 }];
  assert.equal(eng.withinHours(weekly, Date.parse('2027-03-07T15:00:00Z'), 90, 'America/New_York'), true, 'before the change');
  assert.equal(eng.withinHours(weekly, Date.parse('2027-03-14T14:00:00Z'), 90, 'America/New_York'), true, 'after the change');
  assert.equal(eng.withinHours(weekly, Date.parse('2027-03-14T15:00:00Z'), 180, 'America/New_York'), false, '11:00 to 14:00 runs past the window');
  assert.equal(eng.withinHours(weekly, Date.parse('2027-03-08T15:00:00Z'), 90, 'America/New_York'), false, 'Monday has no hours');
  assert.equal(eng.withinHours([], Date.parse('2027-03-08T15:00:00Z'), 90, 'America/New_York'), null, 'no hours set means no restriction');
  // a repeating block on the day the clocks go forward still starts at its local time
  const [dst] = eng.expandBlocks([{ id: 'r', kind: 'recurring', timezone: 'America/New_York', starts_on: '2027-03-14', ends_on: '2027-03-14', weekdays: [0], every_n_weeks: 1, start_minute: 600, end_minute: 720, exclude_dates: [] }], Date.parse('2027-03-13T00:00:00Z'), Date.parse('2027-03-16T00:00:00Z'));
  assert.equal(new Date(dst.startMs).toISOString(), '2027-03-14T14:00:00.000Z');
  // a seasonal window only applies inside its season
  const seasonal = [{ kind: 'weekly', weekday: 0, start_minute: 540, end_minute: 780, valid_from: '2027-04-01', valid_to: '2027-09-30' }];
  assert.equal(eng.withinHours(seasonal, Date.parse('2027-03-14T14:00:00Z'), 60, 'America/New_York'), null);
  assert.equal(eng.withinHours(seasonal, Date.parse('2027-04-04T14:00:00Z'), 60, 'America/New_York'), true);
  // the gap between matches: the same-venue gap applies only when both matches share a venue
  const p = { buffer_min: 60, buffer_same_venue_min: 10 };
  assert.equal(eng.bufferMs(p, 'v1', 'v1'), 10 * 60000);
  assert.equal(eng.bufferMs(p, 'v1', 'v2'), 60 * 60000);
  assert.equal(eng.bufferMs(p, null, null), 60 * 60000);
});

test('update conflict: a stale version is refused with 409 and nothing is overwritten', async () => {
  const ref = await referee('basketball');
  const first = await avail(ref);
  assert.equal(first.prefs.version, 0, 'never saved');
  const a = must(await api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: 'Europe/Madrid', buffer_min: 45, expected_version: 0 } }));
  assert.equal(a.version, 1);
  // a second device still holding version 0
  const lost = await api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: 'Europe/London', buffer_min: 5, expected_version: 0 } });
  assert.equal(lost.status, 409);
  assert.equal(lost.body.error.details.code, 'stale_version');
  assert.equal(lost.body.error.details.current_version, 1);
  assert.equal((await avail(ref)).prefs.timezone, 'Europe/Madrid', 'the first save stands');
  // weekly hours share the same version
  const stale = await api('POST', '/me/officials/availability/weekly', { token: ref.token, body: { windows: [{ weekday: 6, start_minute: 540, end_minute: 1080 }], expected_version: 0 } });
  assert.equal(stale.status, 409);
  assert.equal((await avail(ref)).weekly.length, 0);
  must(await api('POST', '/me/officials/availability/weekly', { token: ref.token, body: { windows: [{ weekday: 6, start_minute: 540, end_minute: 1080 }], expected_version: 1 } }));
  assert.equal((await avail(ref)).prefs.version, 2);
  // two concurrent writers holding the same version: exactly one wins
  const race = await Promise.all([0, 1].map((k) => api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: 'Europe/Madrid', buffer_min: 10 + k, expected_version: 2 } })));
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  // a block carries its own version
  const b = must(await api('POST', '/me/officials/availability/time-off', { token: ref.token, body: { starts_at: new Date(Date.now() + 30 * 864e5).toISOString(), ends_at: new Date(Date.now() + 31 * 864e5).toISOString(), category: 'travel' } }), 201);
  must(await api('PATCH', `/me/officials/availability/${b.id}`, { token: ref.token, body: { expected_version: 1, category: 'family' } }));
  const again = await api('PATCH', `/me/officials/availability/${b.id}`, { token: ref.token, body: { expected_version: 1, category: 'work' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.details.current_version, 2);
  assert.equal((await avail(ref)).time_off[0].category, 'family');
  // incompatible shapes
  assert.equal((await api('PATCH', `/me/officials/availability/${b.id}`, { token: ref.token, body: { expected_version: 2, skip_dates: ['2027-01-01'] } })).status, 400, 'a one-off block has no dates to skip');
  assert.equal((await api('POST', '/me/officials/availability/time-off', { token: ref.token, body: { category: 'work' } })).status, 400, 'neither a period nor a pattern');
  assert.equal((await api('POST', '/me/officials/availability/time-off', { token: ref.token, body: { starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 1e6).toISOString(), recurrence: { starts_on: '2027-01-01', ends_on: '2027-01-08', weekdays: [1] } } })).status, 400, 'both a period and a pattern');
  // the existing clients that send no version keep working
  must(await api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: 'Europe/Madrid', buffer_min: 30 } }));
});

test('accepted assignments reserve the slot; a cancelled match releases it and keeps the history', async () => {
  const tz = 'Europe/Madrid';
  const a = await setup(), b = await setup();
  const ref = await referee('basketball', tz, { buffer_min: 30 });
  const day = nextWeekday(3, tz);
  const fa = await a.fx(local(day, '18:00', tz));
  const fb = await b.fx(local(day, '18:30', tz));
  must(await invite(a.org, fa.id, ref), 201);
  must(await accept(ref, (await mine(ref)).find((x) => x.fixture_id === fa.id).id));
  const clash = await invite(b.org, fb.id, ref);
  assert.equal(clash.status, 409, 'the confirmed match reserves the slot');
  assert.equal(clash.body.error.details.code, 'clash');
  const cal1 = await calendar(ref, eng.localToMs(day, 0, tz), eng.localToMs(day, 1440, tz));
  assert.equal(cal1.entries.find((e) => e.fixture_id === fa.id).hold, 'reserved');
  assert.equal(cal1.totals.reserved, 1);

  must(await api('PATCH', `/fixtures/${fa.id}`, { token: a.org.token, body: { status: 'cancelled' } }));
  assert.equal((await invite(b.org, fb.id, ref)).status, 201, 'the slot is free again');
  const cal2 = await calendar(ref, eng.localToMs(day, 0, tz), eng.localToMs(day, 1440, tz));
  assert.ok(!cal2.entries.some((e) => e.fixture_id === fa.id), 'the cancelled match no longer holds calendar time');
  assert.equal(cal2.entries.find((e) => e.fixture_id === fb.id).hold, 'tentative');
  const hist = (await pool.query("SELECT h.from_status, h.to_status FROM fixture_official_history h JOIN fixture_officials fo ON fo.id=h.fixture_official_id WHERE fo.fixture_id=$1 AND fo.user_id=$2 ORDER BY h.at, h.id", [fa.id, ref.id])).rows;
  assert.deepEqual(hist.map((h) => h.to_status), ['invited', 'accepted', 'cancelled'], 'nothing is deleted');
  const note = (await pool.query("SELECT data FROM notifications WHERE user_id=$1 AND title='Fixture cancelled' ORDER BY created_at DESC LIMIT 1", [ref.id])).rows[0];
  assert.equal(note.data.slot_released, true);
  must(await accept(ref, (await mine(ref)).find((x) => x.fixture_id === fb.id).id));
});

test('tentative offers: overlapping requests are holds, accepting one reserves the slot and tells the other organiser; concurrent accepts cannot double-book', async () => {
  const tz = 'Asia/Singapore';
  const a = await setup(), b = await setup(), c = await setup();
  const ref = await referee('basketball', tz);
  const day = nextWeekday(5, tz);
  const fa = await a.fx(local(day, '10:00', tz)), fb = await b.fx(local(day, '10:30', tz));
  must(await invite(a.org, fa.id, ref), 201);
  must(await invite(b.org, fb.id, ref), 201);
  const cal = await calendar(ref, eng.localToMs(day, 0, tz), eng.localToMs(day, 1440, tz));
  const ea = cal.entries.find((e) => e.fixture_id === fa.id), eb = cal.entries.find((e) => e.fixture_id === fb.id);
  assert.equal(ea.hold, 'tentative');
  assert.deepEqual(ea.rival_requests, [eb.source_id]);
  assert.equal(cal.totals.tentative, 2);
  assert.equal((await avail(ref)).summary.tentative_holds, 2);
  // the organiser of B is told the official is holding another request, with no detail of it
  const look = must(await api('GET', `/fixtures/${fb.id}/officials/${ref.id}/availability`, { token: b.org.token }));
  assert.ok(look.reasons.some((r) => r.code === 'tentative_overlap' && r.level === 'note'));
  assert.ok(look.free_busy.spans.some((s) => s.state === 'tentative'));

  const mineNow = await mine(ref);
  const [ra, rb] = await Promise.all([accept(ref, mineNow.find((x) => x.fixture_id === fa.id).id), accept(ref, mineNow.find((x) => x.fixture_id === fb.id).id)]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409], 'exactly one acceptance wins');
  const loser = ra.status === 200 ? b : a;
  const told = (await pool.query("SELECT data FROM notifications WHERE user_id=$1 AND title='Official no longer free'", [loser.org.id])).rows;
  assert.equal(told.length, 1, 'the other organiser is told');
  assert.equal(told[0].data.superseded, true);
  assert.equal((await mine(ref)).filter((x) => x.status === 'invited').length, 1, 'the losing request is not declined for the official');

  // an official who takes one request per slot
  const strict = await referee('basketball', tz, { tentative_policy: 'one_per_slot' });
  const fc = await c.fx(local(day, '10:15', tz));
  const a2 = await setup();
  const fa2 = await a2.fx(local(day, '10:00', tz));
  must(await invite(a2.org, fa2.id, strict), 201);
  const second = await invite(c.org, fc.id, strict);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.details.code, 'tentative_overlap');
});

test('the official\'s own limits stop new requests but never their own acceptance: hours, notice and load caps', async () => {
  const tz = 'Europe/London';
  const { org, fx } = await setup();
  const other = await setup();
  const ref = await referee('basketball', tz);
  const sat = nextWeekday(6, tz);
  must(await api('POST', '/me/officials/availability/weekly', { token: ref.token, body: { windows: [{ weekday: 6, start_minute: 9 * 60, end_minute: 18 * 60 }] } }));
  const evening = await fx(local(sat, '19:00', tz));
  must(await invite(org, evening.id, ref), 201);   // policy "warn": the request goes through, flagged
  const cal = await calendar(ref, eng.localToMs(sat, 0, tz), eng.localToMs(sat, 1440, tz));
  assert.equal(cal.entries.find((e) => e.fixture_id === evening.id).outside_availability, true);
  assert.equal((await avail(ref)).summary.outside_hours, 1);

  must(await api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: tz, outside_hours_policy: 'block', max_per_day: 1, min_notice_hours: 48 } }));
  const late = await other.fx(local(sat, '20:00', tz));
  const refused = await invite(other.org, late.id, ref);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.details.code, 'outside_hours');
  // an explicit extra window opens that evening
  const win = must(await api('POST', '/me/officials/availability/open', { token: ref.token, body: { starts_at: local(sat, '18:00', tz), ends_at: local(sat, '23:00', tz), idempotency_key: 'open-window-0001' } }), 201);
  assert.equal(must(await api('POST', '/me/officials/availability/open', { token: ref.token, body: { starts_at: local(sat, '18:00', tz), ends_at: local(sat, '23:00', tz), idempotency_key: 'open-window-0001' } }), 201).id, win.id);
  // the official accepts the evening match they were asked for earlier: their own limits never block their own yes
  must(await accept(ref, (await mine(ref)).find((x) => x.fixture_id === evening.id).id));
  // now the daily cap of one match stops a second request that day
  const noon = await other.fx(local(sat, '11:00', tz), 1);
  const capped = await invite(other.org, noon.id, ref);
  assert.equal(capped.status, 409);
  assert.equal(capped.body.error.details.code, 'day_cap');
  // minimum notice
  const soon = await other.fx(new Date(Date.now() + 6 * 3600000).toISOString());
  const short = await invite(other.org, soon.id, ref);
  assert.equal(short.status, 409);
  assert.ok(['short_notice', 'outside_hours'].includes(short.body.error.details.code));
  // re-timing an agreed match is held only to the hard rules
  assert.equal((await api('PATCH', `/fixtures/${evening.id}`, { token: org.token, body: { scheduled_at: local(sat, '21:30', tz) } })).status, 200);
  // weekly cap and consecutive days through the engine
  const u = await referee('basketball', tz, { max_per_week: 1, max_consecutive_days: 1 });
  const wed = nextWeekday(3, tz, 28);
  const f1 = await fx(local(wed, '10:00', tz), 1);
  must(await invite(org, f1.id, u), 201);
  must(await accept(u, (await mine(u))[0].id));
  const thu = await assessFor(u.id, local(addDays(wed, 1), '10:00', tz));
  assert.deepEqual(thu.soft.map((s) => s.code).sort(), ['consecutive_days', 'week_cap']);
  assert.equal(thu.state, 'limited');
  const nextWeek = await assessFor(u.id, local(addDays(wed, 7), '10:00', tz));
  assert.equal(nextWeek.state, 'available');
});
const assessFor = (userId, start) => tx((c) => eng.assess(c, { userId, start, durationMin: 90, venueId: null }));

test('privacy and authorisation: organisers get free / busy only, nobody else gets anything, and no location is exposed', async () => {
  const tz = 'Europe/Paris';
  const { org, ev, fx } = await setup();
  const stranger = await setup();
  const ref = await referee('basketball', tz, { region: 'Lyon', travel_km: 60, buffer_min: 20 });
  const other = await referee('basketball', tz);
  const day = nextWeekday(4, tz);
  const f = await fx(local(day, '14:00', tz));
  const off = must(await api('POST', '/me/officials/availability/time-off', { token: ref.token, body: { starts_at: local(day, '08:00', tz), ends_at: local(day, '12:00', tz), category: 'injury', note: 'Physio for my left knee' } }), 201);
  // a base location recorded elsewhere on the platform must never travel to an organiser
  await pool.query('UPDATE sport_profiles SET base_lat=45.7640, base_lng=4.8357 WHERE user_id=$1', [ref.id]);

  const look = must(await api('GET', `/fixtures/${f.id}/officials/${ref.id}/availability`, { token: org.token }));
  assert.equal(look.state, 'available');
  assert.equal(look.timezone, tz);
  assert.equal(look.travel.region, 'Lyon', 'only the coarse area they chose');
  const span = look.free_busy.spans.find((s) => s.state === 'unavailable');
  assert.ok(span, 'the block shows as unavailable time');
  assert.deepEqual(Object.keys(span).sort(), ['ends_at', 'starts_at', 'state'], 'no title, reason or note on a span');
  const text = JSON.stringify(look);
  for (const secret of ['Physio', 'knee', 'injury', '45.76', '4.83', 'base_lat', 'latitude', 'address']) assert.ok(!text.includes(secret), `organiser response leaks ${secret}`);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='official_availability.view' AND entity_id=$2", [org.id, ref.id])).rows[0].n, 1, 'the look is audit-logged');

  // everyone else gets 404: another organiser, another official, the official themself through this route, an anonymous caller 401
  for (const who of [stranger.org, other, ref]) assert.equal((await api('GET', `/fixtures/${f.id}/officials/${ref.id}/availability`, { token: who.token })).status, 404);
  assert.equal((await api('GET', `/fixtures/${f.id}/officials/${ref.id}/availability`)).status, 401);
  assert.equal((await api('GET', `/fixtures/${f.id}/officials/${stranger.org.id}/availability`, { token: org.token })).status, 404, 'someone who is not an official for this sport');

  // an official's blocks belong to them alone
  assert.equal((await api('PATCH', `/me/officials/availability/${off.id}`, { token: other.token, body: { expected_version: 1, category: 'work' } })).status, 404);
  assert.equal((await api('POST', `/me/officials/availability/${off.id}/remove`, { token: other.token })).status, 404);
  assert.equal((await api('GET', '/me/officials/availability')).status, 401);
  assert.equal((await avail(other)).time_off.length, 0);

  // the organiser's pool and suggestions: a day state and a distance band, never coordinates or an exact distance
  const poolRes = must(await api('GET', `/events/${ev.id}/officials/pool`, { token: org.token }));
  const row = poolRes.officials.find((o) => o.id === ref.id);
  assert.ok(row, 'the official is in the pool');
  for (const k of ['base_lat', 'base_lng']) assert.ok(!(k in row), `pool row has ${k}`);
  assert.ok(!JSON.stringify(poolRes).includes('45.76'));
  const sug = must(await api('GET', `/fixtures/${f.id}/officials/suggest`, { token: org.token, query: { role: 'referee' } }));
  const sText = JSON.stringify(sug);
  assert.ok(!sText.includes('Physio') && !sText.includes('45.76'), 'suggestions carry no note or coordinates');
  const mineSug = (sug.suggestions ?? sug.items ?? sug).find?.((s) => (s.user_id ?? s.id) === ref.id);
  if (mineSug) assert.equal(mineSug.dist_km, null, 'no exact distance');

  // history: every change, never the note
  const hist = must(await api('GET', '/me/officials/availability/history', { token: ref.token }));
  assert.ok(hist.some((h) => h.entity === 'prefs' && h.action === 'created') && hist.some((h) => h.entity === 'block' && h.action === 'created'));
  assert.ok(!JSON.stringify(hist).includes('Physio'));
  must(await api('POST', `/me/officials/availability/${off.id}/remove`, { token: ref.token }));
  assert.equal((await pool.query('SELECT archived_at IS NOT NULL AS gone FROM official_availability WHERE id=$1', [off.id])).rows[0].gone, true, 'archived, not deleted');
  assert.equal((await api('POST', `/me/officials/availability/${off.id}/remove`, { token: ref.token })).status, 404, 'removing twice is refused');
});

test('public holidays come from the shared holiday calendar; taking one twice is a no-op; a retry of time off returns the same block', async () => {
  const tz = 'Asia/Kolkata';
  const { org, fx } = await setup();
  const ref = await referee('basketball', tz, { country: 'IN' });
  const d1 = nextWeekday(1, tz, 21), d2 = addDays(d1, 3);
  const days = must(await api('POST', '/holidays', { token: org.token, body: { country: 'IN', days: [{ on_date: d1, label: 'Republic Day' }, { on_date: d2, label: 'Festival' }] } }), 201);
  const listed = must(await api('GET', '/holidays', { query: { country: 'IN', from: d1, to: d2 } }));
  assert.equal(listed.length, 2);
  const match = await fx(local(d1, '16:00', tz));
  must(await invite(org, match.id, ref), 201);
  const dry = must(await api('POST', '/me/officials/availability/preview', { token: ref.token, body: { holiday_ids: days.map((d) => d.id) } }));
  assert.equal(dry.total_occurrences, 2);
  assert.equal(dry.affected_assignments.length, 1, 'the request already on that day is shown before saving');
  const took = must(await api('POST', '/me/officials/availability/holidays', { token: ref.token, body: { holiday_ids: days.map((d) => d.id) } }), 201);
  assert.equal(took.added.length, 2);
  assert.equal(took.affected_assignments[0].fixture_id, match.id, 'nothing is dropped silently');
  assert.equal((await mine(ref))[0].status, 'invited');
  const again = must(await api('POST', '/me/officials/availability/holidays', { token: ref.token, body: { holiday_ids: [days[0].id] } }), 201);
  assert.deepEqual([again.added.length, again.skipped], [0, 1]);
  assert.equal((await avail(ref)).holidays.length, 2);
  const blocked = await fx(local(d2, '10:00', tz), 1);
  assert.equal((await invite(org, blocked.id, ref)).status, 409);
  assert.equal((await accept(ref, (await mine(ref))[0].id)).status, 409, 'a match on a day I took off cannot be accepted until I free the day');
  assert.equal((await api('POST', '/me/officials/availability/holidays', { token: ref.token, body: { holiday_ids: ['00000000-0000-4000-8000-000000000000'] } })).status, 404);
  const a = await avail(ref);
  assert.equal(a.summary.conflicts, 1);
  assert.equal(a.attention[0].issue, 'time_off');
  assert.equal(a.summary.blocked_days_90, 2);

  const body = { starts_at: local(addDays(d1, 10), '00:00', tz), ends_at: local(addDays(d1, 12), '00:00', tz), all_day: true, category: 'holiday', idempotency_key: 'retry-key-0001' };
  const one = must(await api('POST', '/me/officials/availability/time-off', { token: ref.token, body }), 201);
  const two = must(await api('POST', '/me/officials/availability/time-off', { token: ref.token, body }), 201);
  assert.equal(two.id, one.id);
  assert.equal(two.replayed, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM official_availability WHERE user_id=$1 AND idempotency_key=$2', [ref.id, 'retry-key-0001'])).rows[0].n, 1);
});

test('preferences are validated against the catalogues and summarised from real data', async () => {
  const ref = await referee('basketball');
  const sportId = (await pool.query("SELECT id FROM sports WHERE slug='basketball'")).rows[0].id;
  const bad = (b) => api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: 'UTC', ...b } });
  assert.equal((await bad({ levels: ['galactic'] })).status, 400);
  assert.equal((await bad({ sport_ids: ['00000000-0000-4000-8000-000000000000'] })).status, 400);
  assert.equal((await bad({ roles: ['mascot'] })).status, 400);
  assert.equal((await bad({ age_bands: ['u99'] })).status, 400);
  assert.equal((await bad({ max_per_day: 0 })).status, 400);
  assert.equal((await bad({ timezone: 'Mars/Olympus' })).status, 400);
  const p = must(await bad({ sport_ids: [sportId], levels: ['national', 'international'], roles: ['referee', 'fourth_official'], age_bands: ['u18', 'senior'], buffer_min: 60, buffer_same_venue_min: 15, min_notice_hours: 24, max_per_day: 2, max_per_week: 5, max_consecutive_days: 3, travel_km: 120, region: 'Mallorca', country: 'ES' }));
  assert.deepEqual(p.roles, ['referee', 'fourth_official']);
  // a later save that leaves the new fields out keeps them (older clients)
  const q = must(await bad({ buffer_min: 45 }));
  assert.equal(q.max_per_week, 5);
  assert.deepEqual(q.age_bands, ['u18', 'senior']);
  const a = await avail(ref);
  assert.equal(a.summary.open_minutes_week, null, 'no weekly hours yet');
  assert.equal(a.summary.load.length, 12);
  assert.ok(a.summary.load.every((w) => w.confirmed === 0 && w.tentative === 0), 'no invented numbers');
  assert.deepEqual(a.options.levels, eng.LEVELS);
  assert.ok(a.privacy.organisers_never_see.includes('home_address'));
  must(await api('POST', '/me/officials/availability/weekly', { token: ref.token, body: { windows: [{ weekday: 1, start_minute: 1080, end_minute: 1320 }, { weekday: 6, start_minute: 480, end_minute: 1200, valid_from: '2020-01-01', valid_to: '2099-12-31' }] } }));
  const b = await avail(ref);
  assert.equal(b.summary.open_minutes_week, 240 + 720);
  assert.equal(b.summary.minutes_by_weekday[6], 720);
  const dry = must(await api('POST', '/me/officials/availability/preview', { token: ref.token, body: { weekly: [{ weekday: 2, start_minute: 600, end_minute: 660 }] } }));
  assert.equal(dry.open_minutes_week, 60);
  assert.equal((await api('POST', '/me/officials/availability/preview', { token: ref.token, body: {} })).status, 400);
});

test('every sport in the catalogue: an official can state preferences and be checked for a match', async () => {
  const sports = (await pool.query('SELECT id, slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 20, 'the catalogue is loaded');
  const ref = await signup(['referee']);
  await pool.query("INSERT INTO sport_profiles(user_id, sport_id, role) SELECT $1, s.id, 'referee' FROM sports s ON CONFLICT DO NOTHING", [ref.id]);
  const prefs = must(await api('POST', '/me/officials/availability/prefs', { token: ref.token, body: { timezone: 'Asia/Dubai', buffer_min: 30, sport_ids: sports.slice(0, 30).map((s) => s.id) } }));
  assert.equal(prefs.sport_ids.length, 30);
  const start = new Date(Date.now() + 20 * 864e5).toISOString();
  const missing = [];
  await tx(async (c) => {
    for (const s of sports) {
      try {
        const a = await assertOfficialEligible(c, { event: { sport_id: s.id, official_policy: 'optional' }, userId: ref.id, role: 'referee', start, durationMin: 45, mode: 'invite' });
        if (a.state !== 'available') missing.push(`${s.slug}: ${a.state}`);
      } catch (e) { missing.push(`${s.slug}: ${e.message}`); }
    }
  });
  assert.deepEqual(missing, [], 'no sport is left on a silent default');
});

test('every availability capability is on REST, OpenAPI and MCP', async () => {
  const names = ['get_my_official_availability', 'save_my_official_prefs', 'set_my_weekly_availability', 'add_my_time_off', 'update_my_time_off', 'remove_my_time_off', 'add_my_holiday_windows', 'add_my_extra_availability', 'preview_my_availability_change', 'list_my_availability_history', 'get_fixture_official_availability', 'get_official_calendar'];
  for (const nm of names) assert.equal(capabilities.filter((c) => c.name === nm).length, 1, `${nm} is registered once`);
  const spec = must(await api('GET', '/openapi.json'));
  const ops = Object.values(spec.paths).flatMap((p) => Object.values(p));
  for (const nm of names) assert.ok(ops.some((o) => o.operationId === nm), `${nm} in OpenAPI`);
  assert.ok(spec.paths['/me/officials/availability/{id}']?.patch, 'the versioned update is a PATCH');
  const ref = await referee();
  const mcp = async (body) => (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ref.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) })).text();
  const listed = await mcp({ method: 'tools/list' });
  for (const nm of names) assert.ok(listed.includes(`"${nm}"`), `${nm} in MCP`);
  // the same rule through MCP as through REST: an unknown timezone is refused, a good save is stored
  const badCall = await mcp({ method: 'tools/call', params: { name: 'save_my_official_prefs', arguments: { timezone: 'Mars/Olympus' } } });
  assert.match(badCall, /not a known timezone/);
  await mcp({ method: 'tools/call', params: { name: 'save_my_official_prefs', arguments: { timezone: 'Europe/Madrid', buffer_min: 25 } } });
  assert.equal((await avail(ref)).prefs.buffer_min, 25, 'a save through MCP is the same record REST reads');
});
