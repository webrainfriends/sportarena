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
  const r = await api('POST', '/auth/register', { body: { handle: `tn_${n}_${roles[0]}`, display_name: `Tn ${n}`, email: `tn${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const at = (offset, hour) => { const d = new Date(Date.now() + offset * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const SPORT = 'basketball';

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** Organiser + venue (2 courts, open 08:00–20:00 UTC) + 8 captains/teams. */
async function world() {
  const org = await signup(['organizer']);
  const venue = (await api('POST', '/venues', { token: org.token, body: { name: `Arena ${n}`, city: 'Mumbai', country: 'IN', timezone: 'UTC' } })).body;
  assert.ok(venue.id, JSON.stringify(venue));
  assert.equal((await api('POST', `/venues/${venue.id}/hours`, { token: org.token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: '08:00', closes: '20:00' })) } })).status, 200);
  const courts = [];
  for (const name of ['Court A', 'Court B']) courts.push((await api('POST', `/venues/${venue.id}/resources`, { token: org.token, body: { kind: 'court', name, sport: SPORT } })).body);
  const caps = [], teams = [];
  for (let i = 0; i < 8; i++) {
    caps.push(await signup(['athlete']));
    teams.push((await api('POST', '/teams', { token: caps[i].token, body: { name: `Team ${n}-${i}`, sport: SPORT, city: i < 6 ? 'Mumbai' : 'Pune' } })).body);
  }
  return { org, venue, courts, caps, teams };
}

const newEvent = async (org, extra = {}) => (await api('POST', '/events', { token: org.token, body: { name: `Cup ${++n}`, sport: SPORT, ...extra } })).body;

/** Invite and accept every team so they are accepted entrants. */
async function fillEvent(w, ev, idx = [0, 1, 2, 3, 4, 5, 6, 7]) {
  const inv = await api('POST', `/events/${ev.id}/invitations`, { token: w.org.token, body: { invitees: idx.map((i) => ({ team_id: w.teams[i].id })) } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  for (const [k, i] of idx.entries()) {
    const r = await api('POST', `/event-invitations/${inv.body.invitations[k].id}/respond`, { token: w.caps[i].token, body: { accept: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entry.status, 'accepted');
  }
}

/** Past results: team a beats team b whenever a < b, one game per day. */
async function playHistory(w) {
  const past = await newEvent(w.org, { name: `History ${n}` });
  await fillEvent(w, past);
  let d = 80;
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    const f = await api('POST', `/events/${past.id}/fixtures`, { token: w.org.token, body: { home_team_id: w.teams[a].id, away_team_id: w.teams[b].id, scheduled_at: at(-d--, 10) } });
    assert.equal(f.status, 201, JSON.stringify(f.body));
    assert.equal((await api('POST', `/fixtures/${f.body.id}/result`, { token: w.org.token, body: { home_score: 2, away_score: 0 } })).status, 200);
  }
}

test('suggestions rank by past results and obey rules; invitations register entrants within capacity', async () => {
  const w = await world();
  await playHistory(w);
  const ev = await newEvent(w.org, { capacity: 3, starts_on: day(3), ends_on: day(12) });

  // ranking: team i beat every team j > i
  const sug = await api('GET', `/events/${ev.id}/suggestions?limit=8`, { token: w.org.token });
  assert.equal(sug.status, 200);
  assert.deepEqual(sug.body.items.map((t) => t.team_id), w.teams.map((t) => t.id), 'strongest first');
  assert.equal(sug.body.items[0].rank, 1); assert.ok(sug.body.items[0].rating > sug.body.items[7].rating);
  assert.equal((await api('GET', `/events/${ev.id}/suggestions`, { token: w.caps[0].token })).status, 403, 'organiser only');

  // rules: only Mumbai teams, top 4
  const rules = await api('POST', `/events/${ev.id}/rules`, { token: w.org.token, body: { rules: [{ kind: 'city', params: { city: 'Mumbai' } }, { kind: 'invite_top_n', params: { n: 4 } }, { kind: 'note', params: { text: 'Bring ID' } }] } });
  assert.equal(rules.status, 200, JSON.stringify(rules.body));
  assert.equal((await api('POST', `/events/${ev.id}/rules`, { token: w.org.token, body: { rules: [{ kind: 'min_rating', params: { value: 'high' } }] } })).status, 400);
  assert.equal((await api('GET', `/events/${ev.id}/rules`)).body.length, 3);
  const ruled = (await api('GET', `/events/${ev.id}/suggestions`, { token: w.org.token })).body.items;
  assert.deepEqual(ruled.map((t) => t.team_id), w.teams.slice(0, 4).map((t) => t.id));

  // invite 4 into capacity 3
  const inv = await api('POST', `/events/${ev.id}/invitations`, { token: w.org.token, body: { invitees: ruled.map((t, k) => ({ team_id: t.team_id, seed_hint: k === 0 ? 1 : undefined })), source: 'ranking', message: 'Join us' } });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.invitations[0].source, 'ranking'); assert.ok(inv.body.invitations[0].rating > 0);
  assert.equal((await api('POST', `/events/${ev.id}/invitations`, { token: w.org.token, body: { invitees: [{ team_id: w.teams[0].id }] } })).status, 409, 'already has an open invitation');
  assert.equal((await api('POST', `/events/${ev.id}/invitations`, { token: w.caps[1].token, body: { invitees: [{ team_id: w.teams[5].id }] } })).status, 403, 'not the organiser');
  assert.equal((await api('POST', `/events/${ev.id}/invitations`, { token: w.org.token, body: { invitees: [{ team_id: w.teams[5].id, user_id: w.caps[5].id }] } })).status, 400);

  const mine = (await api('GET', '/me/event-invitations', { token: w.caps[0].token })).body;
  assert.equal(mine.length, 1); assert.equal(mine[0].event_id, ev.id);
  const note = (await api('GET', '/notifications', { token: w.caps[0].token })).body;
  assert.ok(JSON.stringify(note).includes('event_invitation'), 'invitee notified');

  const invs = inv.body.invitations;
  assert.equal((await api('POST', `/event-invitations/${invs[0].id}/respond`, { token: w.caps[3].token, body: { accept: true } })).status, 404, 'cannot answer for someone else');
  for (const k of [0, 1, 2]) assert.equal((await api('POST', `/event-invitations/${invs[k].id}/respond`, { token: w.caps[k].token, body: { accept: true } })).status, 200);
  const full = await api('POST', `/event-invitations/${invs[3].id}/respond`, { token: w.caps[3].token, body: { accept: true } });
  assert.equal(full.status, 409, 'event is full'); assert.match(full.body.error?.message ?? full.body.message ?? JSON.stringify(full.body), /full/i);
  const declined = await api('POST', `/event-invitations/${invs[3].id}/respond`, { token: w.caps[3].token, body: { accept: false } });
  assert.equal(declined.body.invitation.status, 'declined');
  assert.equal((await api('POST', `/event-invitations/${invs[3].id}/respond`, { token: w.caps[3].token, body: { accept: true } })).status, 409, 'already answered');
  const list = (await api('GET', `/events/${ev.id}/invitations?status=accepted`, { token: w.org.token })).body;
  assert.equal(list.length, 3);
  // the invitation's seed hint became a pinned seed
  assert.equal((await pool.query("SELECT seed FROM event_seeds WHERE event_id=$1 AND team_id=$2 AND source='manual'", [ev.id, w.teams[0].id])).rows[0].seed, 1);
  // individuals can be invited too
  const solo = await signup(['athlete']);
  await api('PATCH', `/events/${ev.id}`, { token: w.org.token, body: { capacity: 10 } });
  const si = await api('POST', `/events/${ev.id}/invitations`, { token: w.org.token, body: { invitees: [{ user_id: solo.id }] } });
  assert.equal(si.status, 201);
  assert.equal((await api('POST', `/event-invitations/${si.body.invitations[0].id}/respond`, { token: solo.token, body: { accept: true } })).body.entry.user_id, solo.id);
  const w2 = await api('POST', `/event-invitations/${(await api('POST', `/events/${ev.id}/invitations`, { token: w.org.token, body: { invitees: [{ team_id: w.teams[6].id }] } })).body.invitations[0].id}/withdraw`, { token: w.org.token });
  assert.equal(w2.body.status, 'withdrawn');
});

test('seeds come from ratings, manual pins hold and others renumber around them', async () => {
  const w = await world();
  await playHistory(w);
  const ev = await newEvent(w.org);
  await fillEvent(w, ev);
  const s = await api('POST', `/events/${ev.id}/seeds/compute`, { token: w.org.token, body: {} });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(s.body.seeds.map((x) => [x.team_id, x.seed]), w.teams.map((t, i) => [t.id, i + 1]));
  const pin = await api('POST', `/events/${ev.id}/seeds/${w.teams[7].id}`, { token: w.org.token, body: { seed: 1 } });
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  assert.deepEqual(pin.body.map((x) => x.team_id), [w.teams[7].id, ...w.teams.slice(0, 7).map((t) => t.id)]);
  assert.equal(pin.body[0].source, 'manual');
  assert.equal((await api('POST', `/events/${ev.id}/seeds/${w.teams[6].id}`, { token: w.org.token, body: { seed: 1 } })).status, 409, 'seed already pinned');
  assert.equal((await api('GET', `/events/${ev.id}/seeds`)).body.length, 8);
});

test('knockout: holiday-aware non-overlapping schedule, byes-free 8-team QF → SF → final, winners advance, podium', async () => {
  const w = await world();
  await playHistory(w);
  const ev = await newEvent(w.org, { venue_id: w.venue.id, starts_on: day(3), ends_on: day(14) });
  await fillEvent(w, ev);
  assert.equal((await api('POST', `/events/${ev.id}/seeds/compute`, { token: w.org.token, body: {} })).status, 200);

  // the venue's country has a holiday on the first day; the organiser blacks out the second
  const hol = await api('POST', '/holidays', { token: w.org.token, body: { country: 'IN', days: [{ on_date: day(3), label: 'Festival' }] } });
  assert.equal(hol.status, 201); assert.equal((await api('POST', '/holidays', { token: w.org.token, body: { country: 'in', days: [{ on_date: day(3), label: 'Festival' }] } })).body.length, 0, 'same day twice is a no-op');
  assert.equal((await api('GET', `/holidays?country=IN&from=${day(0)}`)).body.length, 1);
  assert.equal((await api('POST', `/events/${ev.id}/calendar`, { token: w.org.token, body: { days: [{ on_date: day(4), kind: 'rest_day', label: 'Rest day' }] } })).status, 201);
  assert.equal((await api('POST', `/events/${ev.id}/calendar`, { token: w.caps[0].token, body: { days: [{ on_date: day(5) }] } })).status, 403);

  const body = { format: 'knockout', from_date: day(3), to_date: day(10), match_duration_min: 60, rest_min: 60, third_place: true };
  const pv = await api('POST', `/events/${ev.id}/schedule/preview`, { token: w.org.token, body });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.items.length, 8); assert.deepEqual(pv.body.unplaced, []);
  assert.deepEqual(Object.keys(pv.body.skipped_dates).sort(), [day(3), day(4)]);
  assert.match(pv.body.skipped_dates[day(3)], /Festival/);
  const items = pv.body.items;
  for (const it of items) assert.ok(![day(3), day(4)].includes(it.local_date), 'holidays and rest days are skipped');
  const ov = (a, b) => a.scheduled_at < b.ends_at && b.scheduled_at < a.ends_at;
  for (const [i, a] of items.entries()) for (const b of items.slice(i + 1)) {
    if (a.resource_id === b.resource_id) assert.ok(!ov(a, b), 'court double-booked');
    const ta = [a.home_team_id, a.away_team_id].filter(Boolean), tb = [b.home_team_id, b.away_team_id].filter(Boolean);
    if (ta.some((t) => tb.includes(t))) assert.ok(!ov(a, b), 'team double-booked');
  }
  const key = (k) => items.find((x) => x.key === k);
  assert.ok(key('semi:0').scheduled_at >= key('quarter:0').ends_at && key('semi:0').scheduled_at >= key('quarter:1').ends_at, 'semi after its quarters');
  assert.ok(key('final:0').scheduled_at > key('semi:1').ends_at);
  // previewing wrote nothing
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1", [ev.id])).rows[0].n, 0);

  // a window that cannot hold the whole bracket is refused and writes nothing
  const tight = await api('POST', `/events/${ev.id}/schedule`, { token: w.org.token, body: { ...body, from_date: day(5), to_date: day(5), day_start_min: 480, day_end_min: 600 } });
  assert.equal(tight.status, 409);
  assert.ok(tight.body.error?.details?.unplaced?.length ?? tight.body.details?.unplaced?.length ?? JSON.stringify(tight.body).includes('unplaced'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1", [ev.id])).rows[0].n, 0);
  assert.equal((await api('POST', `/events/${ev.id}/schedule`, { token: w.caps[0].token, body })).status, 403);

  const gen = await api('POST', `/events/${ev.id}/schedule`, { token: w.org.token, body });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.created, 8);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM bookings WHERE event_id=$1 AND status='confirmed'", [ev.id])).rows[0].n, 8, 'courts are booked');
  assert.equal((await api('POST', `/events/${ev.id}/schedule`, { token: w.org.token, body })).status, 409, 'cannot generate the knockout twice');

  const br = (await api('GET', `/events/${ev.id}/bracket`)).body;
  assert.deepEqual(br.rounds.map((r) => [r.kind, r.games.length]), [['quarter', 4], ['semi', 2], ['final', 1], ['third_place', 1]]);
  const T = (i) => w.teams[i].id;
  // seeds 1..8 follow the ratings: 1v8, 4v5, 2v7, 3v6
  assert.deepEqual(br.rounds[0].games.map((g) => [g.home_team_id, g.away_team_id]), [[T(0), T(7)], [T(3), T(4)], [T(1), T(6)], [T(2), T(5)]]);
  assert.match(br.rounds[1].games[0].home_name ?? br.rounds[1].games[0].home_placeholder, /Winner Quarter-final 1/);

  const fxId = (g) => g.id;
  const q = br.rounds[0].games;
  const rec = (g, h, a, extra = {}) => api('POST', `/fixtures/${fxId(g)}/result`, { token: w.org.token, body: { home_score: h, away_score: a, ...extra } });
  assert.equal((await rec(br.rounds[1].games[0], 1, 0)).status, 409, 'semi teams not decided yet');
  assert.equal((await rec(q[0], 2, 1)).status, 200);
  const draw = await rec(q[1], 1, 1);
  assert.equal(draw.status, 400, 'knockout cannot end level without a winner');
  assert.equal((await rec(q[1], 1, 1, { winner_team_id: T(5) })).status, 400, 'winner must be one of the two teams');
  const pens = await rec(q[1], 1, 1, { winner_team_id: T(4) });
  assert.equal(pens.status, 200); assert.equal(pens.body.winner_team_id, T(4));
  assert.equal((await rec(q[2], 0, 3)).status, 200);   // upset: seed 7 beats seed 2
  assert.equal((await rec(q[3], 4, 2)).status, 200);
  let mid = (await api('GET', `/events/${ev.id}/bracket`)).body;
  assert.deepEqual(mid.rounds[1].games.map((g) => [g.home_team_id, g.away_team_id]), [[T(0), T(4)], [T(6), T(2)]]);
  assert.equal(mid.rounds[1].games[0].home_placeholder, null, 'placeholder replaced by the team');
  // correcting a quarter re-points the next round while the semi has not started
  assert.equal((await rec(q[1], 2, 1)).status, 200);
  mid = (await api('GET', `/events/${ev.id}/bracket`)).body;
  assert.equal(mid.rounds[1].games[0].away_team_id, T(3));
  const [s1, s2] = mid.rounds[1].games;
  assert.equal((await rec(s1, 3, 0)).status, 200);   // seed 1 through
  assert.equal((await rec(s2, 1, 2)).status, 200);   // seed 3 through
  assert.equal((await rec(q[1], 0, 3)).status, 409, 'cannot change a quarter once its semi was played');
  const end = (await api('GET', `/events/${ev.id}/bracket`)).body;
  const [fin] = end.rounds.find((r) => r.kind === 'final').games, [third] = end.rounds.find((r) => r.kind === 'third_place').games;
  assert.deepEqual([fin.home_team_id, fin.away_team_id], [T(0), T(2)]);
  assert.deepEqual([third.home_team_id, third.away_team_id], [T(3), T(6)]);
  assert.equal((await rec(third, 1, 0)).status, 200);
  assert.equal((await rec(fin, 2, 1)).status, 200);
  const done = (await api('GET', `/events/${ev.id}/bracket`)).body;
  assert.equal(done.champion.team_id, T(0));
  const comp = await api('POST', `/events/${ev.id}/complete`, { token: w.org.token });
  assert.equal(comp.status, 200, JSON.stringify(comp.body));
  assert.deepEqual(comp.body.awards.map((a) => [a.kind, a.team_id]), [['cup', T(0)], ['medal_silver', T(2)], ['medal_bronze', T(3)]]);
  // knockout results do not distort the group table
  assert.ok((await api('GET', `/events/${ev.id}/standings`)).body.every((r) => r.played === 0));
});

test('round robin fits games into court slots, one per team per day, skipping holidays', async () => {
  const w = await world();
  const ev = await newEvent(w.org, { venue_id: w.venue.id });
  await fillEvent(w, ev, [0, 1, 2, 3]);
  await api('POST', '/holidays', { token: w.org.token, body: { country: 'IN', region: 'Mumbai', days: [{ on_date: day(2), label: 'Local holiday' }] } });
  await api('POST', '/holidays', { token: w.org.token, body: { country: 'IN', region: 'Delhi', days: [{ on_date: day(4), label: 'Elsewhere' }] } });
  const body = { format: 'round_robin', from_date: day(2), to_date: day(9), match_duration_min: 90, weekdays_off: [] };
  const gen = await api('POST', `/events/${ev.id}/schedule`, { token: w.org.token, body });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.created, 6);
  const fx = gen.body.fixtures;
  assert.ok(fx.every((f) => f.scheduled_at.slice(0, 10) !== day(2)), 'the venue city’s holiday is skipped');
  assert.ok(fx.some((f) => f.scheduled_at.slice(0, 10) === day(4)), 'another city’s holiday is not skipped (day 3 is a national holiday from the earlier test)');
  const perDay = new Map();
  for (const f of fx) for (const t of [f.home_team_id, f.away_team_id]) { const k = `${t}|${f.scheduled_at.slice(0, 10)}`; perDay.set(k, (perDay.get(k) ?? 0) + 1); }
  assert.ok([...perDay.values()].every((c) => c === 1), 'at most one game per team per day');
  assert.ok(fx.every((f) => f.duration_min >= 90 && f.duration_min <= 120 && f.round_kind === 'group'));
  // existing standings keep working with generated group fixtures
  const f0 = fx[0];
  assert.equal((await api('POST', `/fixtures/${f0.id}/result`, { token: w.org.token, body: { home_score: 1, away_score: 1 } })).status, 200, 'draws are fine in the group stage');
  assert.equal((await api('GET', `/events/${ev.id}/standings`)).body.reduce((s, r) => s + r.drawn, 0), 2);
  // venue blocks (maintenance) also keep games out
  const ev2 = await newEvent(w.org, { venue_id: w.venue.id });
  await fillEvent(w, ev2, [4, 5]);
  assert.equal((await api('POST', `/venues/${w.venue.id}/blocks`, { token: w.org.token, body: { from_date: day(20), to_date: day(20), kind: 'maintenance' } })).status, 201);
  const pv = await api('POST', `/events/${ev2.id}/schedule/preview`, { token: w.org.token, body: { ...body, from_date: day(20), to_date: day(21), match_duration_min: 60 } });
  assert.equal(pv.body.items[0].local_date, day(21), 'maintenance block respected');
  assert.equal((await api('POST', `/events/${ev2.id}/schedule/preview`, { token: w.org.token, body: { format: 'round_robin', from_date: day(2) } })).status, 200);
  const novenue = await newEvent(w.org);
  assert.equal((await api('POST', `/events/${novenue.id}/schedule/preview`, { token: w.org.token, body })).status, 400, 'needs a venue');
});

test('event staff: credentials, time off, clashes, headcount; history is kept', async () => {
  const w = await world();
  const ev = await newEvent(w.org, { starts_on: day(3), ends_on: day(6), venue_id: w.venue.id });
  const role = await api('POST', `/events/${ev.id}/staff-roles`, { token: w.org.token, body: { role: 'referee', needed: 1, fee_cents: 150000 } });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  assert.equal((await api('POST', `/events/${ev.id}/staff-roles`, { token: w.caps[0].token, body: { role: 'referee' } })).status, 403);

  const ref1 = await signup(['referee']), ref2 = await signup(['referee']), nobody = await signup(['athlete']);
  for (const r of [ref1, ref2]) assert.equal((await api('POST', '/me/sport-profiles', { token: r.token, body: { sport: SPORT, role: 'referee' } })).status, 201);
  assert.equal((await api('POST', `/staff-roles/${role.body.id}/invite`, { token: w.org.token, body: { user_id: nobody.id } })).status, 400, 'not a referee for this sport');

  const cands = (await api('GET', `/events/${ev.id}/staff-candidates?role=referee`, { token: w.org.token })).body;
  assert.deepEqual(cands.map((c) => c.user_id).sort(), [ref1.id, ref2.id].sort());

  const inv = await api('POST', `/staff-roles/${role.body.id}/invite`, { token: w.org.token, body: { user_id: ref1.id, message: 'Final weekend' } });
  assert.equal(inv.status, 201); assert.equal(inv.body.fee_cents, 150000);
  assert.equal((await api('POST', `/staff-roles/${role.body.id}/invite`, { token: w.org.token, body: { user_id: ref1.id } })).status, 409, 'duplicate');
  assert.equal((await api('POST', `/staff-assignments/${inv.body.id}/respond`, { token: ref2.token, body: { accept: true } })).status, 404, 'not theirs');
  assert.equal((await api('POST', `/staff-assignments/${inv.body.id}/respond`, { token: ref1.token, body: { accept: true } })).body.status, 'accepted');
  const inv2 = await api('POST', `/staff-roles/${role.body.id}/invite`, { token: w.org.token, body: { user_id: ref2.id } });
  assert.equal(inv2.status, 201);
  assert.equal((await api('POST', `/staff-assignments/${inv2.body.id}/respond`, { token: ref2.token, body: { accept: true } })).status, 409, 'position filled');

  // a second event on overlapping dates clashes
  const other = await newEvent(w.org, { starts_on: day(5), ends_on: day(7) });
  const r2 = (await api('POST', `/events/${other.id}/staff-roles`, { token: w.org.token, body: { role: 'referee' } })).body;
  assert.equal((await api('POST', `/staff-roles/${r2.id}/invite`, { token: w.org.token, body: { user_id: ref1.id } })).status, 409, 'already committed on those dates');
  assert.ok(!(await api('GET', `/events/${other.id}/staff-candidates?role=referee`, { token: w.org.token })).body.some((c) => c.user_id === ref1.id));

  // release keeps history; the place reopens
  const rel = await api('POST', `/staff-assignments/${inv.body.id}/end`, { token: w.org.token, body: { reason: 'Reassigned' } });
  assert.equal(rel.body.status, 'released');
  assert.equal((await api('POST', `/staff-assignments/${inv.body.id}/end`, { token: w.org.token, body: {} })).status, 409);
  assert.equal((await api('POST', `/staff-assignments/${inv2.body.id}/respond`, { token: ref2.token, body: { accept: true } })).body.status, 'accepted');
  assert.deepEqual((await pool.query('SELECT to_status FROM event_staff_history WHERE assignment_id=$1 ORDER BY at, id', [inv.body.id])).rows.map((r) => r.to_status), ['invited', 'accepted', 'released']);
  const roles = (await api('GET', `/events/${ev.id}/staff-roles`)).body;
  assert.equal(roles[0].filled, 1);
  assert.equal((await api('GET', `/events/${ev.id}/staff?status=accepted`, { token: w.org.token })).body.length, 1);
  assert.equal((await api('GET', '/me/staff-assignments', { token: ref2.token })).body.length, 1);

  // doctors / physios: provider profile required, time off blocks
  const phys = await signup(['physio']), plain = await signup(['athlete']);
  const prole = (await api('POST', `/events/${ev.id}/staff-roles`, { token: w.org.token, body: { role: 'physio', needed: 2 } })).body;
  assert.equal((await api('POST', `/staff-roles/${prole.id}/invite`, { token: w.org.token, body: { user_id: phys.id } })).status, 400, 'no provider profile yet');
  assert.equal((await api('POST', '/me/provider-profile', { token: phys.token, body: { provider_type: 'physio', city: 'Mumbai' } })).status, 200);
  assert.equal((await api('POST', '/me/provider-time-off', { token: phys.token, body: { starts_at: at(4, 0), ends_at: at(5, 0) } })).status, 201);
  assert.equal((await api('POST', `/staff-roles/${prole.id}/invite`, { token: w.org.token, body: { user_id: phys.id } })).status, 409, 'time off during the event');
  assert.equal((await api('POST', `/staff-roles/${prole.id}/invite`, { token: w.org.token, body: { user_id: plain.id } })).status, 400);
  assert.ok(!(await api('GET', `/events/${ev.id}/staff-candidates?role=physio&city=mumbai`, { token: w.org.token })).body.some((c) => c.user_id === phys.id));
  // volunteers need no credential
  const vrole = (await api('POST', `/events/${ev.id}/staff-roles`, { token: w.org.token, body: { role: 'volunteer', needed: 5 } })).body;
  assert.equal((await api('POST', `/staff-roles/${vrole.id}/invite`, { token: w.org.token, body: { user_id: plain.id } })).status, 201);
  assert.equal((await api('POST', `/staff-roles/${vrole.id}/close`, { token: w.org.token })).body.closed_at !== null, true);
  assert.equal((await api('POST', `/staff-roles/${vrole.id}/invite`, { token: w.org.token, body: { user_id: nobody.id } })).status, 409, 'closed position');
});

test('vendors: retail and sponsor invitations, products on sale, commercial summary', async () => {
  const w = await world();
  const ev = await newEvent(w.org, { entry_fee_cents: 10000, starts_on: day(3), ends_on: day(4) });
  await fillEvent(w, ev, [0, 1]);
  const sponsor = await signup(['sponsor']), supplier = await signup(['supplier']), rival = await signup(['supplier']);
  const brand = (await api('POST', '/sponsors', { token: sponsor.token, body: { name: 'Acme Sports' } })).body;

  // sponsor
  assert.equal((await api('POST', `/events/${ev.id}/vendors`, { token: w.org.token, body: { kind: 'sponsor' } })).status, 400, 'needs sponsor_id');
  const si = await api('POST', `/events/${ev.id}/vendors`, { token: w.org.token, body: { kind: 'sponsor', sponsor_id: brand.id, fee_cents: 500000, in_kind: 'Kit' } });
  assert.equal(si.status, 201, JSON.stringify(si.body));
  assert.equal((await api('POST', `/event-vendors/${si.body.id}/respond`, { token: rival.token, body: { accept: true } })).status, 404);
  assert.equal((await api('GET', `/events/${ev.id}/vendors`)).body.length, 0, 'invitations are private');
  const acc = await api('POST', `/event-vendors/${si.body.id}/respond`, { token: sponsor.token, body: { accept: true } });
  assert.equal(acc.body.status, 'accepted'); assert.ok(acc.body.sponsorship_id);
  assert.equal((await api('GET', `/events/${ev.id}`)).body.sponsors[0].name, 'Acme Sports', 'shows on the event page');
  assert.equal((await api('GET', `/events/${ev.id}/vendors`)).body.length, 1);

  // retail
  const prod = (await api('POST', '/shop/products', { token: supplier.token, body: { name: 'Team scarf', price_cents: 1200, stock: 50 } })).body;
  const prod2 = (await api('POST', '/shop/products', { token: rival.token, body: { name: 'Water', price_cents: 100, stock: 500 } })).body;
  assert.equal((await api('POST', `/events/${ev.id}/products`, { token: supplier.token, body: { product_id: prod.id } })).status, 409, 'not a confirmed vendor yet');
  const ri = await api('POST', `/events/${ev.id}/vendors`, { token: w.org.token, body: { kind: 'retail', vendor_user_id: supplier.id, fee_cents: 20000 } });
  assert.equal(ri.status, 201);
  assert.equal((await api('POST', `/events/${ev.id}/vendors`, { token: w.org.token, body: { kind: 'retail', vendor_user_id: supplier.id } })).status, 409);
  assert.equal((await api('POST', `/event-vendors/${ri.body.id}/respond`, { token: supplier.token, body: { accept: true } })).body.status, 'accepted');
  assert.equal((await api('POST', `/events/${ev.id}/products`, { token: supplier.token, body: { product_id: prod.id } })).status, 201);
  assert.equal((await api('POST', `/events/${ev.id}/products`, { token: supplier.token, body: { product_id: prod.id } })).status, 409, 'already listed');
  assert.equal((await api('POST', `/events/${ev.id}/products`, { token: supplier.token, body: { product_id: prod2.id } })).status, 403, 'not their product');
  assert.equal((await api('POST', `/events/${ev.id}/products`, { token: w.org.token, body: { product_id: prod2.id } })).status, 409, 'rival is not a vendor');
  assert.deepEqual((await api('GET', `/events/${ev.id}/products`)).body.map((p) => p.name), ['Team scarf']);

  // staff cost + summary
  const role = (await api('POST', `/events/${ev.id}/staff-roles`, { token: w.org.token, body: { role: 'volunteer', needed: 2, fee_cents: 30000 } })).body;
  const vol = await signup(['athlete']);
  const a = (await api('POST', `/staff-roles/${role.id}/invite`, { token: w.org.token, body: { user_id: vol.id } })).body;
  await api('POST', `/staff-assignments/${a.id}/respond`, { token: vol.token, body: { accept: true } });
  const sum = await api('GET', `/events/${ev.id}/commercials`, { token: w.org.token });
  assert.equal(sum.status, 200, JSON.stringify(sum.body));
  assert.deepEqual([sum.body.entry_fees_cents, sum.body.sponsors.cents, sum.body.vendors.pitch_fees_cents, sum.body.staff.cost_cents, sum.body.staff.open_places], [20000, 500000, 20000, 30000, 1]);
  assert.equal(sum.body.net_cents, 20000 + 500000 + 20000 - 30000);
  assert.equal((await api('GET', `/events/${ev.id}/commercials`, { token: vol.token })).status, 403);

  // ending a vendor ends what it created and takes its goods off sale; nothing is deleted
  assert.equal((await api('POST', `/event-vendors/${si.body.id}/end`, { token: w.org.token })).body.status, 'ended');
  assert.equal((await pool.query('SELECT status FROM sponsorships WHERE id=$1', [acc.body.sponsorship_id])).rows[0].status, 'ended');
  assert.equal((await api('POST', `/event-vendors/${ri.body.id}/end`, { token: supplier.token })).body.status, 'ended');
  assert.equal((await api('GET', `/events/${ev.id}/products`)).body.length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_products WHERE event_id=$1', [ev.id])).rows[0].n, 1, 'listing kept as removed history');
});
