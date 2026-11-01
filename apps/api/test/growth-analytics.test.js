// Growth, participation & operator analytics (#73): the new governed KPIs (read through the existing /analytics/metrics layer), consent-aware
// telemetry with replay protection and reconciliation, first-touch attribution, experiments, data quality and retention.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');
const { deidentifyExpiredEvents, reconcileEvents, assignVariant } = await import('../src/growth/service.js');
const { EVENTS } = await import('../src/growth/events.js');
const { wilson } = await import('../src/growth/outcomes.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined))}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text && (text.startsWith('{') || text.startsWith('[')) ? JSON.parse(text) : text };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const one = async (sql, args) => (await q(sql, args))[0];
const person = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ga_${n}_${roles[0]}`, display_name: `Growth Person ${n}`, email: `ga${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const FROM = '2026-03-01', TO = '2026-03-14';
const P = { preset: 'custom', from: FROM, to: TO };
const value = (u, key, scope, extra = {}) => api('GET', `/analytics/metrics/${key}/value`, { token: u.token, query: { scope_type: scope.type, scope_id: scope.id, ...P, ...extra } });
const records = (u, key, scope, extra = {}) => api('GET', `/analytics/metrics/${key}/records`, { token: u.token, query: { scope_type: scope.type, scope_id: scope.id, ...P, ...extra } });
const ev = (key, k, extra = {}) => ({ event_key: key, dedupe_key: k, occurred_at: new Date().toISOString(), ...extra });
const consent = (u, granted = true) => must(api('POST', '/analytics/consent', { token: u.token, body: { granted } }));

let admin, owner, ann, bo, cy, dee, youth, football, org, venue, resource, team;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = await one("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ga_root','ga_root','{admin}','x','x','ga_root') RETURNING id");
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  [owner, ann, bo, cy, dee, youth] = [await person(['organizer']), await person(), await person(), await person(), await person(['coach']), await person()];
  await q("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [youth.id]);
  football = (await one("SELECT id FROM sports WHERE slug='football'")).id;
  org = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Growth Club', kind: 'club' } }), 201);
  venue = await one("INSERT INTO venues(name, owner_id, organisation_id, timezone, currency, city) VALUES ('Growth Arena', $1, $2, 'UTC', 'INR', ' mumbai ') RETURNING id", [owner.id, org.id]);
  resource = await one("INSERT INTO resources(venue_id, kind, name, sport_id) VALUES ($1,'court','Court 1',$2) RETURNING id", [venue.id, football]);
  team = await one("INSERT INTO teams(name, sport_id, owner_id, organisation_id) VALUES ('Growth FC', $1, $2, $3) RETURNING id", [football, owner.id, org.id]);
  // sign-up dates inside the fixed fortnight
  for (const u of [ann, bo, cy]) await q("UPDATE users SET created_at='2026-03-02T09:00:00Z' WHERE id=$1", [u.id]);
});
after(async () => { server.close(); await pool.end(); });

const booking = (user, start, status, extra = {}) => one(
  `INSERT INTO bookings(resource_id, user_id, starts_at, ends_at, status, checked_in_at, cancelled_by) VALUES ($1,$2,$3::timestamptz,$3::timestamptz + interval '1 hour',$4,$5,$6) RETURNING id`,
  [resource.id, user.id, start, status, extra.checkedIn ?? null, extra.cancelledBy ?? null]);

test('completed activity: first activity, repeat participants and activation count real participation and never cancellations', async () => {
  // Ann: checked-in booking on 3 Mar, game on 9 Mar => first activity + repeat. Bo: only a cancelled booking and a cancelled game. Cy: signed up, nothing.
  await booking(ann, '2026-03-03T10:00:00Z', 'confirmed', { checkedIn: '2026-03-03T09:58:00Z' });
  const g = await one("INSERT INTO games(sport_id, created_by, title, starts_at, status, venue_id) VALUES ($1,$2,'Sunday five-a-side','2026-03-09T10:00:00Z','post-event',$3) RETURNING id", [football, owner.id, venue.id]);
  await q("INSERT INTO game_participants(game_id, user_id, outcome) VALUES ($1,$2,'win')", [g.id, ann.id]);
  await booking(bo, '2026-03-04T10:00:00Z', 'cancelled', { checkedIn: '2026-03-04T10:01:00Z', cancelledBy: bo.id });
  const cancelled = await one("INSERT INTO games(sport_id, created_by, title, starts_at, status, venue_id) VALUES ($1,$2,'Rained off','2026-03-05T10:00:00Z','canceled',$3) RETURNING id", [football, owner.id, venue.id]);
  await q("INSERT INTO game_participants(game_id, user_id) VALUES ($1,$2)", [cancelled.id, bo.id]);

  let r = must(await value(admin, 'first_completed_activity', { type: 'platform' }));
  assert.equal(r.value, 1, 'only Ann; a cancelled booking and a cancelled game are not participation');
  const rec = must(await records(admin, 'first_completed_activity', { type: 'platform' }));
  assert.equal(rec.reconciles_to.distinct_subjects, r.value, 'drill-down reconciles to the figure');
  assert.equal(rec.records.length, 1);
  assert.equal(rec.records[0].rec_kind, 'booking_checkin', 'it is her earlier activity');

  r = must(await value(admin, 'repeat_participants', { type: 'platform' }));
  assert.equal(r.value, 1, 'Ann came back on a later day');
  const same = await person();
  await q("UPDATE users SET created_at='2026-03-02T09:00:00Z' WHERE id=$1", [same.id]);
  await booking(same, '2026-03-06T10:00:00Z', 'confirmed', { checkedIn: '2026-03-06T10:00:00Z' });
  await booking(same, '2026-03-06T15:00:00Z', 'confirmed', { checkedIn: '2026-03-06T15:00:00Z' });
  assert.equal(must(await value(admin, 'repeat_participants', { type: 'platform' })).value, 1, 'two activities on the same day do not make a repeat participant');

  r = must(await value(admin, 'activation_rate', { type: 'platform' }));
  assert.equal(r.denominator, 4, 'Ann, Bo, Cy and the same-day player signed up in the period; everyone else signed up outside it');
  assert.equal(r.numerator, 2, 'Ann and the same-day player activated within 14 days');
  const byChannel = must(await value(admin, 'activation_rate', { type: 'platform' }, { group_by: 'channel' }));
  assert.equal(byChannel.groups.length, 1);
  assert.equal(byChannel.groups[0].label, 'Direct');
});

test('activation can be split by acquisition source only for people who consented, and referrals are read from the loyalty record', async () => {
  must(await api('POST', '/analytics/consent', { token: ann.token, body: { granted: true } }));
  must(await api('POST', '/analytics/attribution', { token: ann.token, body: { source: 'social', campaign: 'spring_cup' } }));
  // a loyalty referral: bo was invited by ann
  const prog = await one("INSERT INTO loyalty_programmes(owner_kind, name, currency, status) VALUES ('platform','Main','INR','active') RETURNING id");
  const code = await one("INSERT INTO loyalty_referral_codes(programme_id, referrer_id, code) VALUES ($1,$2,'ANNCODE1') RETURNING id", [prog.id, ann.id]);
  await q("INSERT INTO loyalty_referrals(programme_id, code_id, referrer_id, invitee_id, version) VALUES ($1,$2,$3,$4,1)", [prog.id, code.id, ann.id, bo.id]);
  const g = must(await value(admin, 'activation_rate', { type: 'platform' }, { group_by: 'channel' }));
  const by = Object.fromEntries(g.groups.map((x) => [x.label, [x.numerator, x.denominator]]));
  assert.deepEqual(by.Social, [1, 1], 'Ann arrived through a social campaign and activated');
  assert.deepEqual(by['Invited by a member'], [0, 1], 'Bo was invited and has not played yet');
  // withdrawing consent removes the attribution from reports at once
  await api('POST', '/analytics/consent', { token: ann.token, body: { granted: false } });
  const after_ = must(await value(admin, 'activation_rate', { type: 'platform' }, { group_by: 'channel' }));
  assert.ok(!after_.groups.some((x) => x.label === 'Social'));
  await api('POST', '/analytics/consent', { token: ann.token, body: { granted: true } });
});

test('activation cannot be filtered by sport and is limited to platform operators', async () => {
  const r = await value(admin, 'activation_rate', { type: 'platform' }, { sport_ids: football });
  assert.equal(r.status, 422);
  assert.equal((await value(owner, 'activation_rate', { type: 'platform' })).status, 403);
  assert.equal((await value(owner, 'activation_rate', { type: 'organisation', id: org.id })).status, 422, 'a metric that is platform-only is explained, not zero');
});

test('vacancy fill rate counts confirmed places over places offered and leaves cancelled games out', async () => {
  const mk = async (title, status, max) => {
    const g = await one("INSERT INTO games(sport_id, created_by, title, starts_at, status, venue_id) VALUES ($1,$2,$3,'2026-03-10T10:00:00Z','pre-event',$4) RETURNING id", [football, owner.id, title, venue.id]);
    return one("INSERT INTO open_games(game_id, host_id, max_players, min_players, status) VALUES ($1,$2,$3,2,$4) RETURNING id", [g.id, owner.id, max, status]);
  };
  const og = await mk('Open run', 'open', 4);
  for (const [u, st] of [[ann, 'confirmed'], [bo, 'confirmed'], [cy, 'waitlisted'], [dee, 'requested']]) await q("INSERT INTO open_game_members(open_game_id, user_id, status) VALUES ($1,$2,$3)", [og.id, u.id, st]);
  const gone = await mk('Called off', 'cancelled', 10);
  await q("INSERT INTO open_game_members(open_game_id, user_id, status) VALUES ($1,$2,'confirmed')", [gone.id, ann.id]);
  const r = must(await value(owner, 'vacancy_fill_rate', { type: 'venue', id: venue.id }));
  assert.equal(r.value, 50, '2 confirmed of 4 places; the waitlisted and requested are not filled; the cancelled game is out');
  assert.equal(r.denominator, 4);
  const byCity = must(await value(owner, 'vacancy_fill_rate', { type: 'venue', id: venue.id }, { group_by: 'city' }));
  assert.deepEqual(byCity.groups.map((x) => x.label), ['Mumbai'], 'free-text city is trimmed and capitalised');
  assert.equal((await value(dee, 'vacancy_fill_rate', { type: 'venue', id: venue.id })).status, 404, 'an outsider learns nothing about the venue');
});

test('booking failure rate ignores customer cancellations; payment failure rate ignores pending payments', async () => {
  const v2 = await one("INSERT INTO venues(name, owner_id, organisation_id, timezone, currency) VALUES ('Failure Arena', $1, $2, 'UTC', 'INR') RETURNING id", [owner.id, org.id]);
  const r2 = await one("INSERT INTO resources(venue_id, kind, name, sport_id) VALUES ($1,'court','Court 9',$2) RETURNING id", [v2.id, football]);
  const at = (user, start, status, by = null) => q("INSERT INTO bookings(resource_id, user_id, starts_at, ends_at, status, cancelled_by) VALUES ($1,$2,$3::timestamptz,$3::timestamptz + interval '1 hour',$4,$5)", [r2.id, user.id, start, status, by]);
  await at(ann, '2026-03-11T10:00:00Z', 'confirmed');
  await at(bo, '2026-03-11T11:00:00Z', 'no_show');
  await at(cy, '2026-03-11T12:00:00Z', 'cancelled', owner.id);
  await at(cy, '2026-03-11T13:00:00Z', 'cancelled', cy.id);
  const b = must(await value(owner, 'booking_failure_rate', { type: 'venue', id: v2.id }));
  assert.equal(b.numerator, 2); assert.equal(b.denominator, 3); assert.equal(b.value, 66.7);

  const pay = (status, ref) => q("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref, created_at) VALUES ($1,'stripe','shop_order',gen_random_uuid(),1000,'INR',$2,$3,'2026-03-05T10:00:00Z')", [ann.id, status, ref]);
  await pay('paid', 'p1'); await pay('failed', 'p2'); await pay('pending', 'p3'); await pay('refunded', 'p4');
  const p = must(await value(admin, 'payment_failure_rate', { type: 'platform' }));
  assert.equal(p.numerator, 1); assert.equal(p.denominator, 3, 'pending payments are left out until they resolve'); assert.equal(p.value, 33.3);
  const bc = must(await value(admin, 'payment_failure_rate', { type: 'platform' }, { group_by: 'channel' }));
  assert.equal(bc.groups[0].label, 'Shop orders');
});

test('provider earnings: a provider sees only their own, refunds do not count, the platform sees no names', async () => {
  const hire = (coach) => one("INSERT INTO coach_hires(hirer_id, coach_id, starts_at, total_cents, status) VALUES ($1,$2,'2026-03-05T10:00:00Z',5000,'completed') RETURNING id", [ann.id, coach.id]);
  const h1 = await hire(dee), h2 = await hire(dee), h3 = await hire(cy);
  const pay = (h, status, ref, amount) => q("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref, paid_at) VALUES ($1,'stripe','coach_hire',$2,$3,'INR',$4,$5,'2026-03-06T10:00:00Z')", [ann.id, h.id, amount, status, ref]);
  await pay(h1, 'paid', 'c1', 5000); await pay(h2, 'refunded', 'c2', 5000); await pay(h3, 'paid', 'c3', 7000);
  const mine = must(await value(dee, 'provider_earnings', { type: 'provider' }));
  assert.deepEqual(mine.amounts, [{ currency: 'INR', cents: 5000 }], 'one paid session; the refunded one does not count; Cy\'s is not mine');
  const other = await value(dee, 'provider_earnings', { type: 'provider', id: cy.id });
  assert.equal(other.status, 404, 'asking for someone else\'s earnings leaks nothing');
  const all = must(await value(admin, 'provider_earnings', { type: 'platform' }));
  assert.deepEqual(all.amounts, [{ currency: 'INR', cents: 12000 }]);
  const rec = must(await records(admin, 'provider_earnings', { type: 'platform' }));
  assert.ok(rec.records.every((x) => x.label === 'Coaching session'), 'no provider is named at platform level');
  assert.equal((await value(owner, 'provider_earnings', { type: 'organisation', id: org.id })).status, 422);
  const scopes = must(await api('GET', '/analytics/scopes', { token: dee.token }));
  assert.ok(scopes.some((s) => s.type === 'provider' && s.id === dee.id));
});

test('telemetry: nothing is stored without consent, young people are never recorded, replays are counted once', async () => {
  const booking_ = await booking(ann, '2026-03-12T10:00:00Z', 'confirmed');
  const e1 = ev('booking_completed', 'dedupe-0001', { entity_type: 'booking', entity_id: booking_.id });
  // no decision yet
  let r = must(await api('POST', '/analytics/events', { token: cy.token, body: { events: [e1] } }));
  assert.deepEqual(r.results.map((x) => [x.status, x.reason]), [['dropped', 'not_recorded']]);
  assert.equal(Number((await one("SELECT count(*) AS n FROM analytics_events WHERE user_id=$1", [cy.id])).n), 0);
  // a young person cannot switch it on, and nothing they send is stored
  assert.equal((await api('POST', '/analytics/consent', { token: youth.token, body: { granted: true } })).status, 409);
  assert.equal(must(await api('GET', '/analytics/consent', { token: youth.token })).available, false);
  r = must(await api('POST', '/analytics/events', { token: youth.token, body: { events: [e1] } }));
  assert.equal(r.results[0].reason, 'not_recorded');
  // Ann consents: accepted once, replay is a duplicate
  must(await api('POST', '/analytics/consent', { token: ann.token, body: { granted: true } }));
  r = must(await api('POST', '/analytics/events', { token: ann.token, body: { events: [e1] } }));
  assert.equal(r.accepted, 1);
  for (let i = 0; i < 3; i++) assert.equal(must(await api('POST', '/analytics/events', { token: ann.token, body: { events: [e1] } })).duplicates, 1);
  const row = await one("SELECT count(*) OVER () AS n, duplicate_count FROM analytics_events WHERE dedupe_key='dedupe-0001'");
  assert.equal(Number(row.n), 1); assert.equal(row.duplicate_count, 3);
  // someone else replaying Ann's key neither inflates nor overwrites it
  must(await api('POST', '/analytics/consent', { token: bo.token, body: { granted: true } }));
  r = must(await api('POST', '/analytics/events', { token: bo.token, body: { events: [e1] } }));
  assert.equal(r.duplicates, 1);
  assert.equal((await one("SELECT duplicate_count, user_id FROM analytics_events WHERE dedupe_key='dedupe-0001'")).user_id, ann.id);
  assert.equal((await one("SELECT duplicate_count FROM analytics_events WHERE dedupe_key='dedupe-0001'")).duplicate_count, 3, 'a different person cannot bump it');
});

test('telemetry is validated against the versioned definitions, and carries nothing sensitive', async () => {
  const bad = [
    ev('health_record_viewed', 'bad-0001'), ev('discovery_viewed', 'bad-0002', { entity_type: 'venue', entity_id: venue.id, properties: { surface: 'home', note: 'free text' } }),
    ev('discovery_viewed', 'bad-0003', { entity_type: 'clinical_record', entity_id: venue.id, properties: { surface: 'home' } }),
    ev('discovery_viewed', 'bad-0004', { entity_type: 'venue', entity_id: venue.id, properties: { surface: 'home' }, event_version: 9 }),
    { ...ev('search_performed', 'bad-0005', { properties: { surface: 'search', result_band: 'few' } }), occurred_at: '2020-01-01T00:00:00Z' },
    ev('search_performed', 'bad-0006', { properties: { surface: 'search', result_band: 'few' }, entity_type: 'venue', entity_id: venue.id }),
  ];
  const r = must(await api('POST', '/analytics/events', { token: ann.token, body: { events: bad } }));
  assert.deepEqual(r.results.map((x) => x.reason), ['unknown_event', 'invalid_properties', 'invalid_entity', 'unsupported_version', 'bad_time', 'invalid_entity']);
  const ok = must(await api('POST', '/analytics/events', { token: ann.token, body: { events: [ev('search_performed', 'good-0001', { properties: { surface: 'search', result_band: 'few' } })] } }));
  assert.equal(ok.accepted, 1);
  assert.ok([400, 422].includes((await api('POST', '/analytics/events', { token: ann.token, body: { events: [] } })).status), 'an empty batch is refused');
  assert.equal((await api('POST', '/analytics/events', { body: { events: [bad[0]] } })).status, 401);
  const defs = must(await api('GET', '/analytics/events/definitions', { token: ann.token }));
  assert.deepEqual(defs.map((d) => d.key).sort(), EVENTS.map((e) => e.key).sort());
  const sensitive = /health|clinical|medical|insurance|legal|guardian|youth|diagnos|injur/i;
  assert.ok(!defs.some((d) => sensitive.test(d.key) || d.entity_types.some((t) => sensitive.test(t)) || d.properties.some((p) => sensitive.test(p.name))), 'no event can carry sensitive data');
});

test('telemetry can never move a governed KPI; reconciliation matches claims to records on file', async () => {
  const before_ = [must(await value(admin, 'first_completed_activity', { type: 'platform' })).value, must(await value(admin, 'activation_rate', { type: 'platform' })).value];
  const real = await booking(ann, '2026-03-13T10:00:00Z', 'confirmed');
  const pay = await one("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref) VALUES ($1,'stripe','shop_order',gen_random_uuid(),500,'INR','failed','px1') RETURNING id", [ann.id]);
  const fake = '00000000-0000-4000-8000-000000000001';
  const resv = await one("INSERT INTO reservations(code, user_id, currency, status) VALUES ('GA-RESV-1', $1, 'INR', 'confirmed') RETURNING id", [ann.id]);
  const events = [
    ev('booking_completed', 'rec-real-01', { entity_type: 'booking', entity_id: real.id }),
    ev('booking_completed', 'rec-fake-01', { entity_type: 'booking', entity_id: fake }),
    ev('booking_completed', 'rec-resv-01', { entity_type: 'reservation', entity_id: resv.id }),
    ev('payment_failed', 'rec-pay-001', { entity_type: 'payment', entity_id: pay.id, properties: { reason: 'declined' } }),
    ev('payment_started', 'rec-pay-002', { entity_type: 'payment', entity_id: fake }),
  ];
  for (let i = 0; i < 3; i++) must(await api('POST', '/analytics/events', { token: ann.token, body: { events } }));
  for (let i = 0; i < 50; i++) await api('POST', '/analytics/events', { token: ann.token, body: { events: [ev('booking_completed', `flood-${i}-xxxxxx`, { entity_type: 'booking', entity_id: fake })] } });
  const after_ = [must(await value(admin, 'first_completed_activity', { type: 'platform' })).value, must(await value(admin, 'activation_rate', { type: 'platform' })).value];
  assert.deepEqual(after_, before_, 'forged and repeated events change no governed figure');

  await reconcileEvents();
  const st = async (k) => (await one("SELECT reconcile_state FROM analytics_events WHERE dedupe_key=$1", [k])).reconcile_state;
  assert.equal(await st('rec-real-01'), 'matched');
  assert.equal(await st('rec-resv-01'), 'matched', 'a reservation claim is checked against the reservation');
  assert.equal(await st('rec-pay-001'), 'matched');
  assert.equal(await st('rec-fake-01'), 'pending', 'inside the grace period it is not yet called unmatched');
  await q("UPDATE analytics_events SET received_at = now() - interval '1 hour' WHERE reconcile_state='pending'");
  await reconcileEvents();
  assert.equal(await st('rec-fake-01'), 'unmatched');
  assert.equal(await st('rec-pay-002'), 'unmatched');
  assert.equal(await st('good-0001'), 'not_applicable');
});

test('data quality is for operators and reports freshness, replays, reconciliation and consent coverage as counts only', async () => {
  assert.equal((await api('GET', '/analytics/growth/quality', { token: owner.token })).status, 403);
  const d = must(await api('GET', '/analytics/growth/quality', { token: admin.token }));
  assert.ok(d.telemetry.events > 0 && d.telemetry.replays_ignored >= 3);
  assert.equal(d.telemetry.freshness, 'current');
  const booking_ = d.reconciliation.find((x) => x.event_key === 'booking_completed');
  assert.ok(booking_.matched >= 1 && booking_.unmatched >= 1);
  assert.ok(d.warnings.some((w) => w.code === 'unreconciled'));
  assert.ok(d.consent.granted >= 2 && d.retention.days >= 30);
  assert.ok(!JSON.stringify(d).includes(ann.id), 'no person is identified');
});

test('withdrawing consent de-identifies what was recorded and retention removes the person link without deleting rows', async () => {
  const total = Number((await one('SELECT count(*) AS n FROM analytics_events')).n);
  await q("UPDATE analytics_events SET occurred_at = now() - interval '500 days' WHERE dedupe_key='good-0001'");
  const old = await deidentifyExpiredEvents(395);
  assert.equal(old, 1);
  const row = await one("SELECT user_id, entity_id, properties, deidentified_at FROM analytics_events WHERE dedupe_key='good-0001'");
  assert.equal(row.user_id, null); assert.deepEqual(row.properties, {}); assert.ok(row.deidentified_at);
  const mine = Number((await one('SELECT count(*) AS n FROM analytics_events WHERE user_id=$1', [bo.id])).n);
  must(await api('POST', '/analytics/consent', { token: ann.token, body: { granted: false } }));
  assert.equal(Number((await one('SELECT count(*) AS n FROM analytics_events WHERE user_id=$1', [ann.id])).n), 0);
  assert.equal(Number((await one('SELECT count(*) AS n FROM analytics_events')).n), total, 'no row was deleted');
  assert.equal(Number((await one('SELECT count(*) AS n FROM analytics_events WHERE user_id=$1', [bo.id])).n), mine, 'only the person who withdrew is affected');
  const rec = must(await api('POST', '/analytics/events', { token: ann.token, body: { events: [ev('invite_shared', 'after-out-1', { properties: { channel: 'link' } })] } }));
  assert.equal(rec.results[0].reason, 'not_recorded', 'recording stops at once');
});

const exp = (over = {}) => ({ key: 'new_join_flow', name: 'Shorter join flow', hypothesis: 'A shorter join flow lifts the share of people who play within two weeks.', variants: [{ key: 'control', weight: 50 }, { key: 'short', weight: 50 }], success_metric: 'completed_activity', guardrails: ['payment_failure', 'booking_failure'], min_sample: 10, window_days: 7, ...over });

test('experiments need a hypothesis and measures, are operator-only and are never deleted', async () => {
  assert.equal((await api('POST', '/analytics/experiments', { token: owner.token, body: exp() })).status, 403);
  assert.ok([400, 422].includes((await api('POST', '/analytics/experiments', { token: admin.token, body: exp({ hypothesis: 'too short' }) })).status), 'a hypothesis is required');
  assert.ok([400, 422].includes((await api('POST', '/analytics/experiments', { token: admin.token, body: exp({ guardrails: ['completed_activity'] }) })).status), 'success cannot be its own guardrail');
  assert.ok([400, 422].includes((await api('POST', '/analytics/experiments', { token: admin.token, body: exp({ variants: [{ key: 'a', weight: 1 }, { key: 'a', weight: 1 }] }) })).status));
  const e = must(await api('POST', '/analytics/experiments', { token: admin.token, body: exp() }), 201);
  assert.equal(e.status, 'draft'); assert.equal(e.row_version, 1);
  assert.equal((await api('POST', '/analytics/experiments', { token: admin.token, body: exp() })).status, 409, 'key is unique');
  // concurrent edits: the second one is refused
  const a = await api('PATCH', `/analytics/experiments/${e.id}`, { token: admin.token, body: { row_version: 1, name: 'Shorter join (A)' } });
  const b = await api('PATCH', `/analytics/experiments/${e.id}`, { token: admin.token, body: { row_version: 1, name: 'Shorter join (B)' } });
  assert.deepEqual([a.status, b.status], [200, 409]);
  const run = must(await api('PATCH', `/analytics/experiments/${e.id}`, { token: admin.token, body: { row_version: 2, status: 'running' } }));
  assert.equal(run.status, 'running'); assert.ok(run.started_at);
  assert.equal((await api('PATCH', `/analytics/experiments/${e.id}`, { token: admin.token, body: { row_version: 3, name: 'Renamed while running' } })).status, 409, 'only a draft can be redesigned');
  assert.equal((await api('PATCH', `/analytics/experiments/${e.id}`, { token: admin.token, body: { row_version: 3, status: 'concluded' } })).status, 400, 'a conclusion is required');
  assert.equal((await api('GET', '/analytics/experiments', { token: owner.token })).status, 403);
  assert.equal(must(await api('GET', '/analytics/experiments', { token: admin.token })).length, 1);
  assert.equal((await api('DELETE', `/analytics/experiments/${e.id}`, { token: admin.token })).status, 404, 'there is no delete');
});

test('exposure is stable, recorded once, consent-aware, and young people always get the control', async () => {
  must(await api('POST', '/analytics/consent', { token: cy.token, body: { granted: true } }));
  const first = must(await api('POST', '/analytics/experiments/new_join_flow/exposure', { token: cy.token }));
  assert.equal(first.recorded, true); assert.equal(first.first_exposure, true);
  for (let i = 0; i < 3; i++) { const again = must(await api('POST', '/analytics/experiments/new_join_flow/exposure', { token: cy.token })); assert.equal(again.variant, first.variant); assert.equal(again.first_exposure, false); }
  const row = await one('SELECT exposure_count FROM experiment_exposures WHERE user_id=$1', [cy.id]);
  assert.equal(row.exposure_count, 4, 'repeated deliveries raise the count, not the number of people');
  assert.equal(Number((await one('SELECT count(*) AS n FROM experiment_exposures WHERE user_id=$1', [cy.id])).n), 1);
  const noConsent = must(await api('POST', '/analytics/experiments/new_join_flow/exposure', { token: dee.token }));
  assert.equal(noConsent.recorded, false); assert.ok(['control', 'short'].includes(noConsent.variant));
  const y = must(await api('POST', '/analytics/experiments/new_join_flow/exposure', { token: youth.token }));
  assert.deepEqual([y.variant, y.recorded], ['control', false]);
  assert.equal((await api('POST', '/analytics/experiments/no_such_flag/exposure', { token: cy.token })).status, 404);
  // assignment follows the weights across many people and is a pure function
  const counts = { control: 0, short: 0 };
  for (let i = 0; i < 2000; i++) counts[assignVariant('new_join_flow', `user-${i}`, [{ key: 'control', weight: 50 }, { key: 'short', weight: 50 }])]++;
  assert.ok(counts.control > 900 && counts.short > 900, JSON.stringify(counts));
  assert.equal(assignVariant('k', 'u', [{ key: 'a', weight: 1 }, { key: 'b', weight: 3 }]), assignVariant('k', 'u', [{ key: 'a', weight: 1 }, { key: 'b', weight: 3 }]));
});

test('results count only consenting people with a finished window and say when there is not enough data', async () => {
  const e = (await q('SELECT id FROM experiments'))[0];
  // 12 consenting people per variant, exposed long ago; control completes an activity for 1, the other variant for 10
  const mk = async (variant, i, played) => {
    const u = await person();
    await q('INSERT INTO analytics_consents(user_id, granted) VALUES ($1,true)', [u.id]);
    await q("INSERT INTO experiment_exposures(experiment_id, user_id, variant, first_exposed_at) VALUES ($1,$2,$3,'2026-01-10T10:00:00Z')", [e.id, u.id, variant]);
    if (played) await booking(u, `2026-01-${11 + (i % 5)}T10:00:00Z`, 'confirmed', { checkedIn: `2026-01-${11 + (i % 5)}T10:05:00Z` });
    return u;
  };
  for (let i = 0; i < 12; i++) await mk('control', i, i < 1);
  for (let i = 0; i < 12; i++) await mk('short', i, i < 10);
  // a person who withdrew consent after exposure is left out
  const gone = await mk('short', 0, true);
  await q('UPDATE analytics_consents SET granted=false WHERE user_id=$1', [gone.id]);
  const r = must(await api('GET', `/analytics/experiments/${e.id}/results`, { token: admin.token }));
  const v = Object.fromEntries(r.variants.map((x) => [x.key, x]));
  assert.equal(v.control.mature, 12, 'Cy was exposed just now, so Cy is not counted yet');
  assert.equal(v.short.mature, 12, 'the person who withdrew consent is not counted');
  assert.equal(v.short.outcomes.completed_activity.successes, 10);
  assert.equal(v.control.outcomes.completed_activity.successes, 1);
  assert.equal(r.success.vs_control[0].difference_points, 75);
  assert.equal(r.success.vs_control[0].clear_difference, true, 'intervals do not overlap');
  assert.equal(r.guardrails.length, 2); assert.ok(r.guardrails.every((g) => g.breached === false));
  assert.ok(v.control.maturing + v.short.maturing >= 1, 'Cy was exposed just now so is still inside the window');
  assert.equal(r.ready, true);
  // fewer than the minimum per variant: told plainly
  await q('UPDATE experiments SET min_sample=50 WHERE id=$1', [e.id]);
  const thin = must(await api('GET', `/analytics/experiments/${e.id}/results`, { token: admin.token }));
  assert.equal(thin.ready, false); assert.ok(thin.warnings.some((w) => w.code === 'insufficient_data'));
  await q('UPDATE experiments SET min_sample=10 WHERE id=$1', [e.id]);
  // a guardrail that clearly gets worse is raised
  for (let i = 0; i < 12; i++) { const u = (await q("SELECT user_id FROM experiment_exposures WHERE experiment_id=$1 AND variant='short' ORDER BY first_exposed_at, user_id LIMIT 12", [e.id]))[i]; await q("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status, provider_ref, created_at) VALUES ($1,'stripe','shop_order',gen_random_uuid(),100,'INR','failed',$2,'2026-01-12T10:00:00Z')", [u.user_id, `gr-${i}`]); }
  const bad = must(await api('GET', `/analytics/experiments/${e.id}/results`, { token: admin.token }));
  assert.equal(bad.guardrails.find((g) => g.metric === 'payment_failure').breached, true);
  assert.ok(bad.warnings.some((w) => w.code === 'guardrail_breached'));
  const csv = must(await api('GET', `/analytics/experiments/${e.id}/export`, { token: admin.token }));
  assert.equal(csv.content_type, 'text/csv'); assert.match(csv.content, /new_join_flow","short"/); assert.ok(!csv.content.includes('@'), 'aggregates only');
  assert.equal((await api('GET', `/analytics/experiments/${e.id}/results`, { token: owner.token })).status, 403);
});

test('attribution is first touch only and needs consent', async () => {
  const u = await person();
  assert.equal(must(await api('POST', '/analytics/attribution', { token: u.token, body: { source: 'email' } })).recorded, false, 'no consent, nothing stored');
  must(await api('POST', '/analytics/consent', { token: u.token, body: { granted: true } }));
  assert.equal(must(await api('POST', '/analytics/attribution', { token: u.token, body: { source: 'email', campaign: 'welcome' } })).recorded, true);
  const second = must(await api('POST', '/analytics/attribution', { token: u.token, body: { source: 'partner' } }));
  assert.deepEqual([second.recorded, second.source], [false, 'email'], 'the first answer is kept');
  assert.ok([400, 422].includes((await api('POST', '/analytics/attribution', { token: u.token, body: { source: 'email', campaign: 'has spaces!' } })).status));
});

test('wilson interval is sane, and every growth capability is on REST, OpenAPI and MCP', async () => {
  assert.deepEqual(wilson(0, 0), { rate: null, low: null, high: null });
  const w = wilson(50, 100); assert.equal(w.rate, 50); assert.ok(w.low > 39 && w.high < 61);
  const mine = capabilities.filter((c) => c.tag === 'Analytics').map((c) => c.name);
  for (const x of ['get_analytics_consent', 'set_analytics_consent', 'record_attribution', 'record_analytics_events', 'list_analytics_event_definitions', 'expose_experiment', 'create_experiment', 'list_experiments', 'get_experiment', 'update_experiment', 'get_experiment_results', 'export_experiment_results', 'get_growth_data_quality', 'get_kpi_value']) assert.ok(mine.includes(x), x);
  const spec = must(await api('GET', '/openapi.json'));
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const x of mine) assert.ok(ops.has(x), `${x} is in OpenAPI`);
});
