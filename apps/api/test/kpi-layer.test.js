import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');
const { METRICS } = await import('../src/kpi/catalogue.js');
const { syncCatalogue, computeKpi } = await import('../src/kpi/engine.js');
const { deliverDueKpiReports } = await import('../src/kpi/service.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined))}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text && text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const one = async (sql, args) => (await q(sql, args))[0];
const person = async (roles = ['athlete'], name) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `kp_${n}_${roles[0]}`, display_name: name ?? `Kpi Person ${n}`, email: `kp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

// everything below lives in one fixed week so the figures are exact
const FROM = '2026-03-01', TO = '2026-03-07';
const P = { preset: 'custom', from: FROM, to: TO };
const value = (u, key, scope, extra = {}) => api('GET', `/analytics/metrics/${key}/value`, { token: u.token, query: { scope_type: scope.type, scope_id: scope.id, ...P, ...extra } });
let admin, owner, finance, coach, staff, outsider, athleteA, athleteB, athleteC;
let org, venue, resource, event, footballId, tennisId, team, game1, game2, sponsor, brand;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = await one("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('kp_root','kp_root','{admin}','x','x','kp_root') RETURNING id");
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  [owner, finance, coach, staff, outsider, athleteA, athleteB, athleteC] = [await person(['organizer'], 'Olive Owner'), await person(['organizer']), await person(['coach']), await person(['organizer']), await person(['organizer']), await person(['athlete'], 'Ann Athlete'), await person(['athlete'], 'Bo Athlete'), await person(['athlete'], 'Cy Athlete')];
  org = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Kpi Club', kind: 'club' } }), 201);
  for (const [u, role] of [[finance, 'finance'], [coach, 'coach'], [staff, 'staff']]) await q("INSERT INTO organisation_members(organisation_id,user_id,role,status) VALUES ($1,$2,$3,'active')", [org.id, u.id, role]);
  footballId = (await one("SELECT id FROM sports WHERE slug='football'")).id;
  tennisId = (await one("SELECT id FROM sports WHERE slug='tennis'")).id;
  venue = await one("INSERT INTO venues(name, owner_id, organisation_id, timezone, currency) VALUES ('Kpi Arena', $1, $2, 'UTC', 'INR') RETURNING id", [owner.id, org.id]);
  resource = await one("INSERT INTO resources(venue_id, kind, name, sport_id) VALUES ($1,'court','Court 1',$2) RETURNING id", [venue.id, footballId]);
  for (let d = 0; d < 7; d++) await q('INSERT INTO venue_hours(venue_id, weekday, opens_min, closes_min) VALUES ($1,$2,480,1200)', [venue.id, d]);
  event = await one("INSERT INTO events(name, sport_id, organizer_id, organisation_id, venue_id, status) VALUES ('Kpi Cup', $1, $2, $3, $4, 'open') RETURNING id", [footballId, owner.id, org.id, venue.id]);
  team = await one("INSERT INTO teams(name, sport_id, owner_id, organisation_id) VALUES ('Kpi FC', $1, $2, $3) RETURNING id", [footballId, owner.id, org.id]);
});
after(async () => { server.close(); await pool.end(); });

test('the catalogue governs every shared KPI once, with owner, formula, version and provenance, and is on REST + OpenAPI + MCP', async () => {
  const cat = must(await api('GET', '/analytics/metrics', { token: owner.token }));
  assert.deepEqual(cat.map((m) => m.key).sort(), ['active_athletes', 'athlete_availability', 'attendees', 'matches_played', 'receivable', 'registered_participants', 'revenue', 'sponsor_fulfilment', 'sponsor_value', 'venue_utilisation']);
  for (const m of cat) {
    assert.ok(m.version >= 1 && m.formula.length > 40 && m.owner && m.scopes.length && m.provenance.length && m.definition_hash.length === 64, m.key);
    assert.ok(m.dimensions.every((d) => ['sport', 'event', 'venue', 'team', 'month', 'channel'].includes(d)), m.key);
  }
  const names = capabilities.filter((c) => c.tag === 'Analytics').map((c) => c.name);
  for (const x of ['list_kpi_catalogue', 'get_kpi_definition', 'list_kpi_scopes', 'get_kpi_value', 'list_kpi_records', 'create_kpi_dashboard', 'list_kpi_dashboards', 'get_kpi_dashboard', 'update_kpi_dashboard', 'archive_kpi_dashboard', 'export_kpi_report', 'create_kpi_report_schedule', 'update_kpi_report_schedule', 'get_kpi_report_run']) assert.ok(names.includes(x), x);
  assert.equal((await api('GET', '/analytics/metrics')).status, 401, 'signed-in users only');
});

test('definitions are append-only: a changed formula without a version bump is refused, and history is kept', async () => {
  await syncCatalogue();
  const def = must(await api('GET', '/analytics/metrics/revenue', { token: owner.token }));
  assert.equal(def.versions.length, 1);
  assert.equal(def.versions[0].version, def.version);
  const m = METRICS.find((x) => x.key === 'revenue');
  const before_ = m.formula;
  m.formula += ' (edited)';
  try { await assert.rejects(() => syncCatalogue(), /without raising its version/); } finally { m.formula = before_; }
  m.formula += ' (edited)'; m.version = 2;
  try {
    await syncCatalogue();
    const hist = must(await api('GET', '/analytics/metrics/revenue', { token: owner.token }));
    assert.deepEqual(hist.versions.map((v) => v.version), [2, 1], 'old version stays readable');
    assert.equal(hist.versions[1].formula, before_);
  } finally {
    // put the catalogue back and drop the test-only version so later tests see the real definition
    m.formula = before_; m.version = 1;
    await q("DELETE FROM kpi_definition_versions WHERE definition_id=(SELECT id FROM kpi_definitions WHERE key='revenue') AND version=2");
    await q("UPDATE kpi_definitions SET current_version=1 WHERE key='revenue'");
  }
  await syncCatalogue();
});

test('participation: active athletes, registered participants, matches played and attendees follow their governed formulas', async () => {
  const mk = (sport, title, status, venueId = venue.id) => one('INSERT INTO games(sport_id, created_by, title, starts_at, status, competition_id, venue_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [sport, owner.id, title, '2026-03-03T10:00:00Z', status, event.id, venueId]);
  game1 = await mk(footballId, 'Final', 'post-event');
  game2 = await mk(tennisId, 'Singles', 'post-event');
  const cancelled = await mk(footballId, 'Rained off', 'canceled');
  const noResult = await mk(footballId, 'Unscored', 'post-event');
  // a team game is played by team entries (its players come in through match appearances); a singles game by individual entries
  await q("INSERT INTO game_participants(game_id, team_id, user_id, outcome) VALUES ($1,$2,NULL,'win'),($3,NULL,$4,'win'),($3,NULL,$5,'loss'),($6,NULL,$4,NULL),($7,NULL,$4,NULL)", [game1.id, team.id, game2.id, athleteA.id, athleteB.id, cancelled.id, noResult.id]);
  const fx = await one("INSERT INTO fixtures(event_id, scheduled_at, home_team_id) VALUES ($1,'2026-03-04T10:00:00Z',$2) RETURNING id", [event.id, team.id]);
  await q("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, source) VALUES ($1,$2,$3,'started','lineup'),($1,$2,$4,'unused_sub','lineup')", [fx.id, team.id, athleteC.id, athleteB.id]);

  let r = must(await value(owner, 'matches_played', { type: 'organisation', id: org.id }));
  assert.equal(r.value, 3, 'cancelled games are not played; a two-sport org counts both');
  assert.ok(r.warnings.some((w) => w.code === 'no_result' && w.records >= 1), 'a completed game with no result is flagged');
  r = must(await value(owner, 'matches_played', { type: 'organisation', id: org.id }, { sport_ids: tennisId }));
  assert.equal(r.value, 1, 'sport filter');
  r = must(await value(owner, 'matches_played', { type: 'organisation', id: org.id }, { group_by: 'sport' }));
  assert.deepEqual(r.groups.map((g) => [g.label, g.value]).sort(), [['Football', 2], ['Tennis', 1]]);

  r = must(await value(owner, 'active_athletes', { type: 'organisation', id: org.id }));
  assert.equal(r.value, 3, 'Ann and Bo (singles) and Cy (started a team match), each counted once; an unused substitute did not play');
  const rec = must(await api('GET', '/analytics/metrics/active_athletes/records', { token: owner.token, query: { scope_type: 'organisation', scope_id: org.id, ...P } }));
  assert.ok(rec.total_records > rec.reconciles_to.distinct_subjects, 'more records than people');
  assert.equal(rec.reconciles_to.distinct_subjects, r.value, 'drill-down reconciles to the figure');

  await q("INSERT INTO reg_registrations(event_id, team_id, user_id, submitted_by, status, effective_from) VALUES ($1,$2,$3,$4,'registered','2026-02-01'),($1,$2,$5,$4,'registered','2026-02-01'),($1,$2,$6,$4,'rejected','2026-02-01')", [event.id, team.id, athleteA.id, owner.id, athleteB.id, athleteC.id]);
  r = must(await value(owner, 'registered_participants', { type: 'event', id: event.id }));
  assert.equal(r.value, 2, 'rejected registrations never count');
  assert.ok(r.warnings.some((w) => w.code === 'no_division'));

  const b1 = await one("INSERT INTO bookings(resource_id, user_id, starts_at, ends_at, status, checked_in_at) VALUES ($1,$2,'2026-03-02T10:00:00Z','2026-03-02T12:00:00Z','confirmed','2026-03-02T09:58:00Z') RETURNING id", [resource.id, athleteA.id]);
  await q("INSERT INTO bookings(resource_id, user_id, starts_at, ends_at, status) VALUES ($1,$2,'2026-03-03T10:00:00Z','2026-03-03T11:00:00Z','cancelled')", [resource.id, athleteB.id]);
  await q("INSERT INTO bookings(resource_id, user_id, starts_at, ends_at, status, checked_in_at) VALUES ($1,$2,'2026-03-02T15:00:00Z','2026-03-02T16:00:00Z','confirmed','2026-03-02T15:01:00Z')", [resource.id, athleteA.id]);
  r = must(await value(owner, 'attendees', { type: 'venue', id: venue.id }));
  assert.equal(r.value, 1, 'the same person twice on the same day is one attendee');
  assert.ok(b1.id);
});

test('venue utilisation is booked minutes over opening hours, leaving cancelled bookings and hour-less venues out', async () => {
  let r = must(await value(owner, 'venue_utilisation', { type: 'venue', id: venue.id }));
  assert.equal(r.denominator, 7 * 720);
  assert.equal(r.numerator, 180, 'two confirmed bookings: 2h + 1h; the cancelled hour is not utilisation');
  assert.equal(r.value, 3.6);
  const empty = await one("INSERT INTO venues(name, owner_id, organisation_id, timezone) VALUES ('No Hours', $1, $2, 'UTC') RETURNING id", [owner.id, org.id]);
  await q("INSERT INTO resources(venue_id, kind, name) VALUES ($1,'court','C')", [empty.id]);
  r = must(await value(owner, 'venue_utilisation', { type: 'organisation', id: org.id }));
  assert.equal(r.value, 3.6, 'a resource with no opening hours is excluded, not counted as 0%');
  assert.ok(r.warnings.some((w) => w.code === 'no_opening_hours'));
  assert.equal((await value(owner, 'venue_utilisation', { type: 'team', id: team.id })).status, 422, 'not applicable is explained, not zero');
});

test('finance: revenue nets tax and credit notes per currency, receivable is what is still owed', async () => {
  const inv = async (number, kind, status, cents, tax, cur, extra = {}) => {
    const rsv = await one("INSERT INTO reservations(code, user_id, currency) VALUES ($1,$2,$3) RETURNING id", [`R-${number}`, owner.id, cur]);
    await q(
      `INSERT INTO invoices(number, kind, status, user_id, currency, total_cents, tax_cents, tax_name, tax_rate_bp, tax_inclusive, seller, lines, venue_id, reservation_id, issued_at, paid_at, credits_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'GST',1000,true,'{}','[]',$8,$9,$10,$11,$12)`, [number, kind, status, owner.id, cur, cents, tax, venue.id, rsv.id, extra.issued ?? '2026-03-02T09:00:00Z', status === 'paid' ? extra.paid ?? '2026-03-02T09:05:00Z' : null, extra.credits ?? 0]);
  };
  await inv('K-1', 'invoice', 'paid', 11000, 1000, 'INR');
  await inv('K-2', 'credit_note', 'paid', 2200, 200, 'INR');
  await inv('K-3', 'invoice', 'paid', 5000, 0, 'USD');
  await inv('K-4', 'invoice', 'open', 8000, 0, 'INR', { credits: 1000 });
  await inv('K-5', 'invoice', 'void', 9999, 0, 'INR');
  let r = must(await value(finance, 'revenue', { type: 'organisation', id: org.id }));
  assert.deepEqual(r.amounts, [{ currency: 'INR', cents: 8000 }, { currency: 'USD', cents: 5000 }], '10000 - 2000 net of tax; USD kept apart; open and void ignored');
  assert.ok(r.warnings.some((w) => w.code === 'multiple_currencies'));
  r = must(await value(finance, 'receivable', { type: 'venue', id: venue.id }));
  assert.deepEqual(r.amounts, [{ currency: 'INR', cents: 7000 }]);
  const batch = await one("INSERT INTO team_charge_batches(team_id, kind, title, currency, total_minor, split_mode, created_by) VALUES ($1,'dues','Kit',$2,3000,'equal',$3) RETURNING id", [team.id, 'INR', owner.id]);
  await q("INSERT INTO team_charges(batch_id, team_id, member_id, payer_id, amount_minor, settled_minor, due_on, status, created_at) VALUES ($1,$2,$3,$3,3000,1000,'2026-03-10','awaiting_payment','2026-03-04T10:00:00Z')", [batch.id, team.id, athleteA.id]);
  r = must(await value(finance, 'receivable', { type: 'organisation', id: org.id }, { group_by: 'channel' }));
  assert.deepEqual(r.amounts, [{ currency: 'INR', cents: 9000 }], 'open invoice 7000 + unpaid team dues 2000');
  assert.deepEqual(r.groups.map((g) => g.label).sort(), ['Team dues', 'Venue bookings']);
  const rec = must(await api('GET', '/analytics/metrics/receivable/records', { token: finance.token, query: { scope_type: 'organisation', scope_id: org.id, ...P } }));
  assert.deepEqual(rec.reconciles_to.amounts, r.amounts, 'drill-down reconciles to the figure');
  assert.equal(rec.records.length, 2);
  assert.ok(rec.records.every((x) => x.link_kind && x.link_id));
});

test('sponsorship: value is confirmed cash only, fulfilment is accepted over due; a brand reads its own', async () => {
  brand = await person(['sponsor'], 'Brand Owner');
  sponsor = await one("INSERT INTO sponsors(owner_id, name) VALUES ($1,'Kpi Brand') RETURNING id", [brand.id]);
  const s = await one("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, proposed_by, status, accepted_version, currency) VALUES ($1,'event',$2,100000,$3,'active',1,'INR') RETURNING id", [sponsor.id, event.id, brand.id]);
  const line = await one("INSERT INTO sponsorship_lines(sponsorship_id, version, position, kind, label, amount_cents, total_cents) VALUES ($1,1,1,'money','Cash',60000,60000) RETURNING id", [s.id]);
  const ob = await one("INSERT INTO sponsorship_obligations(sponsorship_id, version, line_id, seq, kind, due_on, amount_cents, currency) VALUES ($1,1,$2,1,'money','2026-03-05',60000,'INR') RETURNING id", [s.id, line.id]);
  const pay = (status, cents, ref, refunded = 0) => q("INSERT INTO sponsorship_payments(obligation_id, amount_cents, currency, method, reference, paid_on, reported_by, status, refunded_cents) VALUES ($1,$2,'INR','bank_transfer',$3,'2026-03-05',$4,$5,$6)", [ob.id, cents, ref, brand.id, status, refunded]);
  await pay('confirmed', 40000, 'P1', 5000); await pay('reported', 20000, 'P2'); await pay('rejected', 1000, 'P3');
  let r = must(await value(owner, 'sponsor_value', { type: 'event', id: event.id }));
  assert.deepEqual(r.amounts, [{ currency: 'INR', cents: 35000 }], 'confirmed net of refund; reported and rejected never count');
  assert.deepEqual(must(await value(brand, 'sponsor_value', { type: 'sponsor', id: sponsor.id })).amounts, r.amounts, 'the brand and the event see the same figure');
  const del = (title, status, due) => q("INSERT INTO sponsorship_deliverables(sponsorship_id, kind, title, owed_by, due_on, evidence_required, created_by, status, reviewed_by, reviewed_at) VALUES ($1,'content',$2,'sponsor',$3,'link',$4,$5,$6,$7)", [s.id, title, due, brand.id, status, status === 'accepted' ? owner.id : null, status === 'accepted' ? '2026-03-04T00:00:00Z' : null]);
  await del('Post 1', 'accepted', '2026-03-03'); await del('Post 2', 'planned', '2020-01-01'); await del('Post 3', 'cancelled', '2026-03-04'); await del('Post 4', 'excepted', '2026-03-04');
  await q("UPDATE sponsorship_deliverables SET due_on='2026-03-06' WHERE title='Post 2'");
  r = must(await value(owner, 'sponsor_fulfilment', { type: 'event', id: event.id }));
  assert.deepEqual([r.numerator, r.denominator, r.value], [1, 2, 50], 'cancelled and excepted are removed from the base');
  assert.equal((await value(outsider, 'sponsor_value', { type: 'sponsor', id: sponsor.id })).status, 404);
});

test('athlete availability is aggregate-only: small groups are hidden outside a team you manage', async () => {
  for (const [u, a] of [[athleteA, 'available'], [athleteB, 'injured'], [athleteC, 'unavailable']]) await q("INSERT INTO team_members(team_id, user_id, role, status, availability) VALUES ($1,$2,'player','active',$3)", [team.id, u.id, a]);
  let r = must(await value(owner, 'athlete_availability', { type: 'team', id: team.id }));
  assert.deepEqual([r.numerator, r.denominator, r.value], [1, 3, 33.3]);
  r = must(await value(owner, 'athlete_availability', { type: 'organisation', id: org.id }));
  assert.equal(r.value, null, 'fewer than 5 athletes: hidden');
  assert.equal(r.suppressed, true);
  const rec = await api('GET', '/analytics/metrics/athlete_availability/records', { token: owner.token, query: { scope_type: 'organisation', scope_id: org.id } });
  assert.equal(rec.status, 403, 'no individual rows outside a team you manage');
  const own = must(await api('GET', '/analytics/metrics/athlete_availability/records', { token: owner.token, query: { scope_type: 'team', scope_id: team.id } }));
  assert.equal(own.total_records, 3);
  assert.equal(JSON.stringify(own).includes('injury'), false, 'no clinical detail is read');
});

test('access is read live: outsiders get 404, narrow roles 403 with the reason, admins only for the platform', async () => {
  assert.equal((await value(outsider, 'revenue', { type: 'organisation', id: org.id })).status, 404);
  assert.equal((await value(outsider, 'matches_played', { type: 'venue', id: venue.id })).status, 404);
  const coachRev = await value(coach, 'revenue', { type: 'organisation', id: org.id });
  assert.equal(coachRev.status, 403);
  assert.match(coachRev.body.error?.message ?? coachRev.body.message ?? JSON.stringify(coachRev.body), /limited to/);
  assert.equal((await value(staff, 'matches_played', { type: 'organisation', id: org.id })).status, 200, 'staff may read operational counts');
  assert.equal((await value(staff, 'revenue', { type: 'organisation', id: org.id })).status, 403);
  assert.equal((await value(owner, 'revenue', { type: 'platform' })).status, 403);
  assert.equal((await value(admin, 'revenue', { type: 'platform' })).status, 200);
  assert.equal((await value(owner, 'revenue', { type: 'event', id: event.id })).status, 422, 'revenue is not an event metric');
  assert.equal((await value(owner, 'matches_played', { type: 'organisation', id: org.id }, { group_by: 'channel' })).status, 422);
  assert.equal((await value(owner, 'matches_played', { type: 'organisation', id: org.id }, { preset: 'custom', from: '2020-01-01', to: '2026-03-07' })).status, 422, 'periods are bounded');
  await q("UPDATE organisation_members SET status='left' WHERE organisation_id=$1 AND user_id=$2", [org.id, finance.id]);
  assert.equal((await value(finance, 'revenue', { type: 'organisation', id: org.id })).status, 404, 'a left member loses access at once');
  await q("UPDATE organisation_members SET status='active' WHERE organisation_id=$1 AND user_id=$2", [org.id, finance.id]);
});

test('drill-down is audit-logged and every access to a figure by another module sees the same definition and result', async () => {
  const before_ = (await one("SELECT count(*)::int AS n FROM audit_log WHERE action='kpi_drilldown' AND actor_id=$1", [owner.id])).n;
  must(await api('GET', '/analytics/metrics/matches_played/records', { token: owner.token, query: { scope_type: 'venue', scope_id: venue.id, ...P } }));
  assert.equal((await one("SELECT count(*)::int AS n FROM audit_log WHERE action='kpi_drilldown' AND actor_id=$1", [owner.id])).n, before_ + 1);

  // REST, the in-process call other modules use, a dashboard tile, an export and a scheduled run: one definition, one figure
  const rest = must(await value(owner, 'matches_played', { type: 'organisation', id: org.id }));
  const inProcess = await computeKpi(owner, 'matches_played', { scope: { type: 'organisation', id: org.id }, range: P });
  assert.equal(inProcess.digest, rest.digest);
  assert.equal(inProcess.reference, rest.reference);
  const dash = must(await api('POST', '/analytics/dashboards', { token: owner.token, body: { title: 'Club board', range_preset: 'custom', range_from: FROM, range_to: TO,
    widgets: [{ metric: 'matches_played', scope_type: 'organisation', scope_id: org.id }, { metric: 'revenue', scope_type: 'organisation', scope_id: org.id }] } }), 201);
  const opened = must(await api('GET', `/analytics/dashboards/${dash.id}`, { token: owner.token }));
  const tile = opened.tiles.find((t) => t.widget.metric === 'matches_played').result;
  assert.equal(tile.digest, rest.digest);
  assert.equal(tile.definition.definition_hash, rest.definition.definition_hash);
  const csv = (await api('GET', '/analytics/export', { token: owner.token, query: { dashboard_id: dash.id, format: 'csv' } })).body;
  assert.equal(csv.encoding, 'utf8');
  const lines = csv.content.split('\n');
  assert.ok(lines[0].startsWith('metric,scope,period'));
  assert.ok(lines.some((l) => l.startsWith('Matches played,Kpi Club,2026-03-01 to 2026-03-07,,3,3,count')), 'the export carries the same figure: ' + csv.content);
  assert.ok(lines.some((l) => l.includes(rest.reference)), 'and the same reference');
  const pdf = (await api('GET', '/analytics/export', { token: owner.token, query: { dashboard_id: dash.id, format: 'pdf' } })).body;
  assert.equal(pdf.content_type, 'application/pdf');
  assert.ok(Buffer.from(pdf.content, 'base64').subarray(0, 4).toString() === '%PDF');
  const xlsx = (await api('GET', '/analytics/export', { token: owner.token, query: { dashboard_id: dash.id, format: 'xlsx' } })).body;
  assert.ok(Buffer.from(xlsx.content, 'base64').subarray(0, 2).toString() === 'PK');
});

test('dashboards: shared recipes degrade per viewer, sharing is limited, edits are optimistic, archive keeps data', async () => {
  const dash = must(await api('POST', '/analytics/dashboards', { token: owner.token, body: { title: 'Shared board', visibility: 'organisation', organisation_id: org.id, range_preset: 'custom', range_from: FROM, range_to: TO,
    widgets: [{ metric: 'matches_played', scope_type: 'organisation', scope_id: org.id }, { metric: 'revenue', scope_type: 'organisation', scope_id: org.id }] } }), 201);
  const asStaff = must(await api('GET', `/analytics/dashboards/${dash.id}`, { token: staff.token }));
  assert.equal(asStaff.tiles.find((t) => t.widget.metric === 'matches_played').result.value, 3);
  const gap = asStaff.tiles.find((t) => t.widget.metric === 'revenue');
  assert.equal(gap.result, null);
  assert.equal(gap.error.code, 'forbidden', 'a tile staff may not read is an explained gap, never the owner\'s number');
  assert.equal(asStaff.quality.hidden, 1);
  assert.equal((await api('GET', `/analytics/dashboards/${dash.id}`, { token: outsider.token })).status, 404);
  assert.ok(must(await api('GET', '/analytics/dashboards', { token: staff.token })).some((d) => d.id === dash.id));
  assert.equal(must(await api('GET', '/analytics/dashboards', { token: outsider.token })).length, 0);

  // a tile you cannot read now cannot be saved; roles you do not hold or admin roles cannot be shared to
  assert.equal((await api('POST', '/analytics/dashboards', { token: staff.token, body: { title: 'x', widgets: [{ metric: 'revenue', scope_type: 'organisation', scope_id: org.id }] } })).status, 403);
  assert.equal((await api('POST', '/analytics/dashboards', { token: owner.token, body: { title: 'x', visibility: 'roles', roles: ['admin'] } })).status, 422);
  assert.equal((await api('POST', '/analytics/dashboards', { token: owner.token, body: { title: 'x', visibility: 'roles', roles: ['physio'] } })).status, 403);
  assert.equal((await api('POST', '/analytics/dashboards', { token: staff.token, body: { title: 'x', visibility: 'organisation', organisation_id: org.id } })).status, 403, 'staff cannot publish to the org');

  const upd = must(await api('PATCH', `/analytics/dashboards/${dash.id}`, { token: owner.token, body: { row_version: dash.row_version, title: 'Shared board v2' } }));
  assert.equal(upd.row_version, 2);
  assert.equal((await api('PATCH', `/analytics/dashboards/${dash.id}`, { token: owner.token, body: { row_version: 1, title: 'stale' } })).status, 409);
  assert.equal((await api('PATCH', `/analytics/dashboards/${dash.id}`, { token: staff.token, body: { row_version: 2, title: 'hijack' } })).status, 404, 'only the owner edits');
  must(await api('POST', `/analytics/dashboards/${dash.id}/archive`, { token: owner.token, body: {} }));
  assert.equal((await api('GET', `/analytics/dashboards/${dash.id}`, { token: owner.token })).status, 404);
  assert.equal((await one('SELECT count(*)::int AS n FROM kpi_dashboards WHERE id=$1', [dash.id])).n, 1, 'archived, never deleted');
});

test('scheduled reports: delivered once per period under each recipient\'s live access, with no figures in the notice', async () => {
  const dash = must(await api('POST', '/analytics/dashboards', { token: owner.token, body: { title: 'Weekly', visibility: 'organisation', organisation_id: org.id, range_preset: 'last_7',
    widgets: [{ metric: 'matches_played', scope_type: 'organisation', scope_id: org.id }, { metric: 'revenue', scope_type: 'organisation', scope_id: org.id }] } }), 201);
  assert.equal((await api('POST', '/analytics/schedules', { token: owner.token, body: { dashboard_id: dash.id, cadence: 'weekly', recipient_ids: [outsider.id] } })).status, 422, 'recipients must be able to open it');
  assert.equal((await api('POST', '/analytics/schedules', { token: owner.token, body: { dashboard_id: dash.id, cadence: 'weekly', first_run_on: '2020-01-01' } })).status, 422, 'first delivery in the future');
  const sch = must(await api('POST', '/analytics/schedules', { token: owner.token, body: { dashboard_id: dash.id, cadence: 'weekly', format: 'pdf', recipient_ids: [owner.id, staff.id] } }), 201);
  await q("UPDATE kpi_report_schedules SET next_run_on = current_date WHERE id=$1", [sch.id]);
  assert.equal(await deliverDueKpiReports(), 2);
  assert.equal(await deliverDueKpiReports(), 0, 'a repeated sweep delivers nothing more');
  const runs = must(await api('GET', '/analytics/runs', { token: staff.token }));
  assert.equal(runs.length, 1);
  const note = await one("SELECT title, body FROM notifications WHERE user_id=$1 AND kind='kpi_report'", [staff.id]);
  assert.ok(note && !/\d{2,}/.test(note.body.replace(/\d{4}-\d{2}-\d{2}/g, '')), 'the notice carries no figures: ' + note?.body);
  const run = must(await api('GET', `/analytics/runs/${runs[0].id}`, { token: staff.token }));
  assert.equal(run.quality.hidden, 1, 'opened under the recipient\'s own access, not the owner\'s');
  assert.deepEqual(run.run.definitions_changed_since, []);
  assert.equal((await api('GET', `/analytics/runs/${runs[0].id}`, { token: owner.token })).status, 404, 'a run belongs to its recipient');
  // losing access: a revoked member's next run is skipped, with no notice
  await q("UPDATE kpi_report_schedules SET next_run_on = current_date WHERE id=$1", [sch.id]);
  await q("UPDATE organisation_members SET status='left' WHERE organisation_id=$1 AND user_id=$2", [org.id, staff.id]);
  await q("UPDATE kpi_report_runs SET period_on = period_on - 7 WHERE schedule_id=$1", [sch.id]);
  await deliverDueKpiReports();
  assert.equal((await one("SELECT status FROM kpi_report_runs WHERE schedule_id=$1 AND recipient_id=$2 ORDER BY period_on DESC LIMIT 1", [sch.id, staff.id])).status, 'skipped_no_access');
  assert.equal((await one("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='kpi_report'", [staff.id])).n, 1);
  await q("UPDATE organisation_members SET status='active' WHERE organisation_id=$1 AND user_id=$2", [org.id, staff.id]);
  const paused = must(await api('PATCH', `/analytics/schedules/${sch.id}`, { token: owner.token, body: { row_version: (await one('SELECT row_version FROM kpi_report_schedules WHERE id=$1', [sch.id])).row_version, paused: true } }));
  assert.ok(paused.paused_at);
});

test('every sport in the catalogue can be reported on: no sport falls back to a silent default or fails', async () => {
  const sports = await q('SELECT id, slug FROM sports ORDER BY slug');
  assert.ok(sports.length > 100);
  for (const s of sports) {
    const r = await value(admin, 'matches_played', { type: 'platform' }, { sport_ids: s.id });
    assert.equal(r.status, 200, `${s.slug}: ${JSON.stringify(r.body)}`);
    assert.equal(typeof r.body.value, 'number', s.slug);
  }
  const tennis = must(await value(admin, 'matches_played', { type: 'platform' }, { sport_ids: tennisId }));
  assert.equal(tennis.value, 1, 'a count of completed games is sport-neutral: tennis and football use the same rule, each filtered by its own sport');
});

test('no other module defines a governed KPI of its own: the names are only produced by the semantic layer', () => {
  const GOVERNED = /\b(active_athletes|registered_participants|matches_played|venue_utilisation|athlete_availability|sponsor_fulfilment|sponsor_value)\b/;
  // an entitlement meter key that is persisted in plan data (renaming it would rewrite stored plans); it is a billing gauge, not a KPI
  const ALLOWED = new Set(['commercial/engine.js']);
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.js') ? [join(d, f)] : []));
  const src = new URL('../src/', import.meta.url).pathname;
  const hits = walk(src).map((f) => f.slice(src.length)).filter((f) => !f.startsWith('kpi/') && f !== 'capabilities/kpi-layer.js' && !ALLOWED.has(f)).filter((f) => GOVERNED.test(readFileSync(join(src, f), 'utf8')));
  assert.deepEqual(hits, [], 'a module that needs one of these figures must call computeKpi / kpiValue (src/kpi/engine.js) instead of defining it');
});
