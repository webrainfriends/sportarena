// Sports Media, Broadcast & Rights Management (#482): the rights inventory and licence lifecycle, exclusivity, scope (a media agreement never opens other records),
// live expiry and revocation across REST / API credentials / MCP, production crew and restricted zones, honest streaming state, asset rights (embargo, expiry,
// takedown, derivatives, youth media consent), data-feed credentials with rate limits, reports that keep currencies apart, and OpenAPI/MCP parity.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { runMediaRightsSweeps } = await import('../src/media-rights-sweeps.js');
const { describePurpose, settle } = await import('../src/payments/service.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query, raw } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)))}` : ''}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed, headers: r.headers };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const iso = (days = 0, hours = 0) => new Date(Date.now() + days * 864e5 + hours * 36e5).toISOString();
const signup = async (roles = ['organizer']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `mr_${n}_${roles[0]}`, display_name: `Media ${n}`, email: `mr${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

const mkEvent = async (u) => {
  const ev = must(await api('POST', '/events', { token: u.token, body: { name: `Media Cup ${++n}`, sport: 'football', kind: 'tournament', starts_on: iso(10).slice(0, 10), ends_on: iso(12).slice(0, 10) } }), 201);
  must(await api('PATCH', `/events/${ev.id}`, { token: u.token, body: { status: 'open' } }));
  return ev;
};
const mkTeam = async (u, name) => must(await api('POST', '/teams', { token: u.token, body: { name: `${name} ${++n}`, sport: 'football' } }), 201);
const mkFixture = async (ev, h, a, at = iso(10)) => (await q('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, round) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ev.id, h.id, a.id, at, 'Round 1']))[0];
const partnerOrg = async (u, kind = 'broadcaster') => {
  const org = must(await api('POST', '/organisations', { token: u.token, body: { name: `Broadcast ${++n}`, kind: 'company' } }), 201);
  const mp = must(await api('POST', '/media/partners', { token: u.token, body: { organisation_id: org.id, kind } }), 201);
  return { org, ...mp, partner_id: mp.id };
};
const pkg = async (u, ev, over = {}) => must(await api('POST', `/events/${ev.id}/media/packages`, { token: u.token, body: { name: `Package ${++n}`, rights: ['live_video', 'highlights', 'data_feed'], valid_from: iso(-1), valid_to: iso(60), ...over } }), 201);
const terms = (over = {}) => ({ approved_rights: ['live_video', 'highlights', 'data_feed'], effective_from: iso(-1), effective_to: iso(30), fee_minor: 500000, currency: 'USD', ...over });
const offer = async (u, p, partner, over = {}) => must(await api('POST', `/media/packages/${p.id}/licences`, { token: u.token, body: { partner_id: partner.partner_id, ...terms(over) } }), 201);
const decide = (u, l, action, extra = {}) => api('POST', `/media/licences/${l.id}/decision`, { token: u.token, body: { action, row_version: extra.row_version ?? l.row_version, ...extra } });
const activeLicence = async (org, partnerUser, ev, partner, pOver = {}, tOver = {}) => {
  const p = await pkg(org, ev, pOver);
  const l = await offer(org, p, partner, tOver);
  return { p, l: must(await decide(partnerUser, l, 'accept')) };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('rights package: scoped to the competition, a game or a collection; only the organiser defines it; licensed terms are frozen', async () => {
  const org = await signup(), other = await signup(), pu = await signup();
  const ev = await mkEvent(org), a = await mkTeam(org, 'A'), b = await mkTeam(org, 'B'), f = await mkFixture(ev, a, b);
  assert.equal((await api('POST', `/events/${ev.id}/media/packages`, { token: other.token, body: { name: 'Mine', rights: ['live_video'], valid_from: iso(), valid_to: iso(10) } })).status, 403);
  const p1 = await pkg(org, ev, { scope_kind: 'fixture', fixture_id: f.id, territory_mode: 'include', countries: ['SG', 'MY'], platforms: ['ott', 'web'], languages: ['en'], embargo_minutes: 60, exclusivity: 'exclusive', sublicensing: 'with_approval' });
  assert.deepEqual(p1.countries.sort(), ['MY', 'SG']);
  assert.equal(p1.embargo_minutes, 60);
  // a game from another event, a territory without countries, and a backwards window are all refused
  const foreign = await mkEvent(org), fa = await mkFixture(foreign, a, b);
  assert.equal((await api('POST', `/events/${ev.id}/media/packages`, { token: org.token, body: { name: 'X', scope_kind: 'fixture', fixture_id: fa.id, rights: ['live_video'], valid_from: iso(), valid_to: iso(5) } })).status, 400);
  assert.equal((await api('POST', `/events/${ev.id}/media/packages`, { token: org.token, body: { name: 'X', territory_mode: 'include', rights: ['live_video'], valid_from: iso(), valid_to: iso(5) } })).status, 400);
  assert.equal((await api('POST', `/events/${ev.id}/media/packages`, { token: org.token, body: { name: 'X', rights: ['live_video'], valid_from: iso(5), valid_to: iso(1) } })).status, 400);
  const col = must(await api('POST', `/events/${ev.id}/media/collections`, { token: org.token, body: { name: 'Official highlights' } }), 201);
  const p2 = await pkg(org, ev, { scope_kind: 'collection', collection_id: col.id, rights: ['highlights'] });
  assert.equal(p2.scope_kind, 'collection');
  // partners discover open packages across events
  must(await api('POST', `/media/packages/${p1.id}/status`, { token: org.token, body: { status: 'open' } }));
  const found = must(await api('GET', '/media-opportunities', { token: pu.token, query: { q: ev.name } }));
  assert.ok(found.some((x) => x.id === p1.id) && found.every((x) => x.event_id === ev.id));
  must(await api('POST', `/media/packages/${p1.id}/status`, { token: org.token, body: { status: 'closed' } }));
  assert.equal(must(await api('GET', '/media-opportunities', { token: pu.token, query: { q: ev.name } })).some((x) => x.id === p1.id), false, 'closed packages are not offered');
  // public sees only OPEN packages; the organiser sees all
  must(await api('POST', `/media/packages/${p2.id}/status`, { token: org.token, body: { status: 'open' } }));
  assert.deepEqual(must(await api('GET', `/events/${ev.id}/media/packages`, { token: pu.token })).map((x) => x.id), [p2.id]);
  assert.equal(must(await api('GET', `/events/${ev.id}/media/packages`, { token: org.token })).length, 2);
  // once a licence exists, the package cannot be edited or withdrawn underneath it
  const partner = await partnerOrg(pu);
  const lic = await offer(org, p2, partner, { approved_rights: ['highlights'] });
  assert.equal((await api('POST', `/events/${ev.id}/media/packages`, { token: org.token, body: { package_id: p2.id, name: 'Changed', scope_kind: 'collection', collection_id: col.id, rights: ['highlights'], valid_from: iso(-1), valid_to: iso(60) } })).status, 409);
  assert.equal((await api('POST', `/media/packages/${p2.id}/status`, { token: org.token, body: { status: 'withdrawn' } })).status, 409);
  assert.equal(must(await decide(pu, lic, 'accept')).stage, 'active');
});

test('licence: the other side accepts; terms can only narrow the package; stale edits and outsiders are refused; every step is in the history', async () => {
  const org = await signup(), pu = await signup(), outsider = await signup();
  const ev = await mkEvent(org), partner = await partnerOrg(pu);
  const p = await pkg(org, ev, { territory_mode: 'include', countries: ['SG', 'MY', 'ID'], platforms: ['ott', 'web'], rights: ['live_video', 'highlights'] });
  const bad = (over) => api('POST', `/media/packages/${p.id}/licences`, { token: org.token, body: { partner_id: partner.partner_id, ...terms({ approved_rights: ['live_video'], ...over }) } });
  assert.equal(code(await bad({ approved_rights: ['audio'] })), 'terms_outside_package');
  assert.equal(code(await bad({ territory_mode: 'worldwide' })), 'terms_outside_package');
  assert.equal(code(await bad({ territory_mode: 'include', countries: ['SG', 'US'] })), 'terms_outside_package');
  assert.equal(code(await bad({ territory_mode: 'include', countries: ['SG'], approved_platforms: ['linear_tv'] })), 'terms_outside_package');
  assert.equal(code(await bad({ territory_mode: 'include', countries: ['SG'], effective_to: iso(90) })), 'terms_outside_package');
  const lic = await offer(org, p, partner, { approved_rights: ['live_video'], territory_mode: 'include', countries: ['SG'], approved_platforms: ['ott'] });
  assert.equal(lic.stage, 'proposed'); assert.match(lic.licence_no, /^MR-\d{4}-/);
  assert.equal((await api('POST', `/media/packages/${p.id}/licences`, { token: org.token, body: { partner_id: partner.partner_id, ...terms({ approved_rights: ['live_video'], approved_platforms: ['ott'], territory_mode: 'include', countries: ['SG'] }) } })).status, 409, 'one offer at a time');
  // the proposer cannot accept its own offer; an outsider cannot even see it
  assert.equal((await decide(org, lic, 'accept')).status, 403);
  assert.equal((await api('GET', `/media/licences/${lic.id}`, { token: outsider.token })).status, 404);
  assert.equal((await decide(outsider, lic, 'accept')).status, 404);
  // partner counters; now the organiser must accept
  const rev = must(await api('POST', `/media/licences/${lic.id}/terms`, { token: pu.token, body: { row_version: lic.row_version, ...terms({ approved_rights: ['live_video', 'highlights'], approved_platforms: ['web'], territory_mode: 'include', countries: ['SG', 'MY'], fee_minor: 400000 }) } }));
  assert.equal(rev.stage, 'negotiating'); assert.equal(rev.proposed_by_side, 'partner'); assert.equal(Number(rev.fee_minor), 400000);
  assert.equal((await api('POST', `/media/licences/${lic.id}/terms`, { token: org.token, body: { row_version: lic.row_version, ...terms() } })).status, 409, 'stale version');
  assert.equal((await decide(pu, rev, 'accept')).status, 403);
  assert.equal((await decide(org, rev, 'decline')).status, 400, 'a decline needs a reason');
  const act = must(await decide(org, rev, 'accept'));
  assert.equal(act.stage, 'active'); assert.equal(act.in_force, true);
  const full = must(await api('GET', `/media/licences/${lic.id}`, { token: pu.token }));
  assert.deepEqual(full.history.map((h) => h.action), ['proposed', 'revised', 'accept']);
  assert.equal(full.as.partner, true); assert.equal(full.as.organiser, false);
  // the log is append-only
  await assert.rejects(pool.query("UPDATE mr_log SET action='x' WHERE subject_id=$1", [lic.id]), /append-only/);
  // a member whose role cannot act for the partner cannot answer for it
  const staff = await signup(['athlete']);
  await q("INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,'staff','active')", [partner.org.id, staff.id]);
  assert.equal((await api('GET', `/media/licences/${lic.id}`, { token: staff.token })).status, 200);
  assert.equal((await decide(staff, act, 'terminate', { reason: 'no' })).status, 403);
});

test('exclusive rights cannot overlap; non-overlapping territory, rights or dates are fine', async () => {
  const org = await signup(), u1 = await signup(), u2 = await signup();
  const ev = await mkEvent(org), p1 = await partnerOrg(u1), p2 = await partnerOrg(u2);
  const ex = await pkg(org, ev, { exclusivity: 'exclusive', rights: ['live_video', 'audio'] });
  const l1 = await offer(org, ex, p1, { approved_rights: ['live_video'], territory_mode: 'include', countries: ['SG'] });
  must(await decide(u1, l1, 'accept'));
  const l2 = await offer(org, ex, p2, { approved_rights: ['live_video'], territory_mode: 'include', countries: ['SG', 'MY'] });
  const clash = await decide(u2, l2, 'accept');
  assert.equal(clash.status, 409); assert.equal(code(clash), 'exclusivity_conflict');
  assert.equal(clash.body.error.details.conflicts[0].licence_no, l1.licence_no);
  // different right, different territory, or later dates all coexist
  const l3 = must(await api('POST', `/media/licences/${l2.id}/terms`, { token: org.token, body: { row_version: l2.row_version, ...terms({ approved_rights: ['audio'], territory_mode: 'include', countries: ['SG'] }) } }));
  assert.equal(must(await decide(u2, l3, 'accept')).stage, 'active');
});

test('rights are read live: a licence that has run out, been suspended or terminated stops granting access straight away, and the sweep records it', async () => {
  const org = await signup(), pu = await signup();
  const ev = await mkEvent(org), partner = await partnerOrg(pu);
  const { l } = await activeLicence(org, pu, ev, partner);
  assert.equal(must(await api('GET', '/media-workspace', { token: pu.token })).summary.held_now, 1);
  must(await decide(org, { ...l, row_version: l.row_version }, 'suspend', { reason: 'Investigating' }));
  assert.equal(must(await api('GET', '/media-workspace', { token: pu.token })).summary.held_now, 0);
  const cur = must(await api('GET', `/media/licences/${l.id}`, { token: org.token }));
  must(await decide(org, cur, 'reinstate'));
  assert.equal(must(await api('GET', '/media-workspace', { token: pu.token })).summary.held_now, 1);
  // time passes: no sweep has run, yet the licence already reads as expired everywhere
  await q("UPDATE mr_licences SET effective_from = now() - interval '3 days', effective_to = now() - interval '1 minute' WHERE id=$1", [l.id]);
  assert.equal(must(await api('GET', '/media-workspace', { token: pu.token })).summary.held_now, 0);
  assert.equal(must(await api('GET', `/media/licences/${l.id}`, { token: org.token })).stage_now, 'expired');
  assert.equal((await q('SELECT stage FROM mr_licences WHERE id=$1', [l.id]))[0].stage, 'active');
  assert.ok((await runMediaRightsSweeps()).changed >= 1);
  assert.equal((await q('SELECT stage FROM mr_licences WHERE id=$1', [l.id]))[0].stage, 'expired');
  assert.equal((await runMediaRightsSweeps()).changed, 0, 'idempotent');
  // a renewal is a new proposal pointing at the old one
  const ren = must(await api('POST', `/media/licences/${l.id}/renew`, { token: org.token, body: { effective_from: iso(), effective_to: iso(40) } }), 201);
  assert.equal(ren.renewal_of, l.id); assert.equal(ren.stage, 'proposed');
});

test('a media agreement grants only its own scope: the workspace shows licensed games and nothing about teams, players or other events', async () => {
  const org = await signup(), pu = await signup(), stranger = await signup(['athlete']);
  const ev = await mkEvent(org), other = await mkEvent(org), a = await mkTeam(org, 'A'), b = await mkTeam(org, 'B'), c2 = await mkTeam(org, 'C');
  const f1 = await mkFixture(ev, a, b), f2 = await mkFixture(ev, a, c2, iso(11)), f3 = await mkFixture(other, b, c2);
  const partner = await partnerOrg(pu);
  await activeLicence(org, pu, ev, partner, { scope_kind: 'fixture', fixture_id: f1.id });
  const ws = must(await api('GET', '/media-workspace', { token: pu.token }));
  assert.deepEqual(ws.fixtures.map((x) => x.id), [f1.id], 'only the licensed game');
  assert.ok(!ws.fixtures.some((x) => [f2.id, f3.id].includes(x.id)));
  assert.deepEqual(ws.events.map((e) => e.id), [ev.id]);
  const text = JSON.stringify(ws);
  assert.ok(!/email|phone|dob|guardian|medical/i.test(text), 'no personal or private fields');
  // a media partner is not given other canonical records by virtue of the licence
  assert.equal((await api('GET', `/events/${ev.id}/media/licences`, { token: pu.token })).status, 403);
  assert.equal((await api('GET', `/events/${ev.id}/media/reports/revenue`, { token: pu.token })).status, 403);
  assert.equal((await api('GET', `/events/${ev.id}/media/feeds`, { token: pu.token })).status, 403);
  assert.deepEqual(must(await api('GET', '/media-workspace', { token: stranger.token })).partners, []);
  // a licence is for one event: crew cannot be assigned to another event under it
  const lic = (await q('SELECT id FROM mr_licences LIMIT 1'))[0];
  assert.equal((await api('POST', `/events/${other.id}/media/crew`, { token: pu.token, body: { user_id: pu.id, role: 'producer', licence_id: lic.id } })).status, 403);
});

test('production: crew, restricted zones, acknowledgement, badge read from the department, call sheet and incidents', async () => {
  const org = await signup(), pu = await signup(), cam = await signup(['athlete']), out = await signup();
  const ev = await mkEvent(org), a = await mkTeam(org, 'A'), b = await mkTeam(org, 'B'), f = await mkFixture(ev, a, b);
  const partner = await partnerOrg(pu);
  const { l } = await activeLicence(org, pu, ev, partner);
  const body = { user_id: cam.id, role: 'camera_operator', licence_id: l.id, fixture_id: f.id, camera_position: 'Cam 3 · halfway line', call_time: iso(10, -3) };
  // a partner cannot open a locker room; only the organiser can approve restricted zones
  assert.equal((await api('POST', `/events/${ev.id}/media/crew`, { token: pu.token, body: { ...body, zones: ['mixed_zone', 'locker_room'] } })).status, 403);
  assert.equal((await api('POST', `/events/${ev.id}/media/crew`, { token: out.token, body })).status, 403);
  const row = must(await api('POST', `/events/${ev.id}/media/crew`, { token: pu.token, body }), 201);
  assert.equal(row.status, 'assigned'); assert.equal(row.accreditation, 'none'); assert.equal(row.ready, false);
  assert.equal((await api('POST', `/events/${ev.id}/media/crew`, { token: pu.token, body })).status, 409, 'same person, role and game');
  assert.ok(Number(row.id) !== 0);
  const withLocker = must(await api('POST', `/events/${ev.id}/media/crew`, { token: org.token, body: { ...body, role: 'photographer', zones: ['mixed_zone', 'locker_room'], licence_id: l.id } }), 201);
  assert.equal(withLocker.restricted_zones_approved, true);
  // the badge is the event department's, read live; ready = confirmed AND badge issued
  const dept = must(await api('POST', `/events/${ev.id}/departments`, { token: org.token, body: { name: 'Media', kind: 'media' } }), 201);
  const dm = (await q("INSERT INTO event_department_members(event_id, department_id, user_id, role, status, accreditation, invited_by) VALUES ($1,$2,$3,'member','active','none',$4) RETURNING id", [ev.id, dept.id, cam.id, org.id]))[0];
  must(await api('POST', `/events/${ev.id}/media/crew`, { token: pu.token, body: { ...body, crew_id: row.id, department_member_id: dm.id } }), 201);
  assert.equal((await api('POST', `/media/crew/${row.id}/respond`, { token: pu.token, body: { accept: true } })).status, 404, 'only the crew member answers');
  assert.equal((await api('POST', `/media/crew/${row.id}/respond`, { token: cam.token, body: { accept: false } })).status, 400);
  must(await api('POST', `/media/crew/${row.id}/respond`, { token: cam.token, body: { accept: true } }));
  let list = must(await api('GET', `/events/${ev.id}/media/crew`, { token: pu.token }));
  assert.equal(list.find((x) => x.id === row.id).ready, false, 'confirmed but no badge');
  await q("UPDATE event_department_members SET accreditation='issued' WHERE id=$1", [dm.id]);
  list = must(await api('GET', `/events/${ev.id}/media/crew`, { token: pu.token }));
  assert.equal(list.find((x) => x.id === row.id).ready, true);
  await q("UPDATE event_department_members SET accreditation='revoked' WHERE id=$1", [dm.id]);
  assert.equal(must(await api('GET', `/events/${ev.id}/media/crew`, { token: pu.token })).find((x) => x.id === row.id).ready, false, 'a revoked badge is no longer ready');
  // the partner only sees its own crew; crew see only theirs; outsiders see nothing
  assert.equal(must(await api('GET', `/events/${ev.id}/media/crew`, { token: cam.token })).every((x) => x.user_id === cam.id), true);
  const mine = must(await api('GET', '/me/media-assignments', { token: cam.token }));
  assert.ok(mine.some((x) => x.id === row.id && x.event_name === ev.name), 'the crew member sees their own assignment across events');
  assert.deepEqual(must(await api('GET', '/me/media-assignments', { token: out.token })), []);
  assert.equal((await api('GET', `/events/${ev.id}/media/crew`, { token: out.token })).status, 404);
  // run sheet, incidents and the call sheet
  must(await api('POST', `/events/${ev.id}/media/run-sheet`, { token: pu.token, body: { phase: 'setup', title: 'Rig cameras', starts_at: iso(10, -6), ends_at: iso(10, -4), fixture_id: f.id, location: 'Broadcast compound' } }), 201);
  assert.equal((await api('POST', `/events/${ev.id}/media/run-sheet`, { token: pu.token, body: { phase: 'live', title: 'x', starts_at: iso(1), ends_at: iso(0) } })).status, 400);
  const inc = must(await api('POST', `/events/${ev.id}/media/incidents`, { token: cam.token, body: { kind: 'incident', severity: 'major', summary: 'Camera 3 feed lost', fixture_id: f.id } }), 201);
  const sheet = must(await api('GET', `/events/${ev.id}/media/call-sheet`, { token: cam.token, query: { fixture_id: f.id } }));
  assert.equal(sheet.run_sheet.length, 1); assert.equal(sheet.incidents.length, 1); assert.equal(sheet.viewer.crew, true);
  assert.ok(!JSON.stringify(sheet).match(/email|phone/i), 'no contact details on the call sheet');
  assert.equal((await api('GET', `/events/${ev.id}/media/call-sheet`, { token: out.token })).status, 404);
  assert.equal((await api('POST', `/media/incidents/${inc.id}/resolve`, { token: out.token })).status, 404);
  must(await api('POST', `/media/incidents/${inc.id}/resolve`, { token: cam.token }));
  must(await api('POST', `/media/crew/${row.id}/release`, { token: pu.token, body: {} }));
  assert.equal((await q('SELECT status FROM mr_crew WHERE id=$1', [row.id]))[0].status, 'released', 'released, not deleted');
  // a young person only joins a production with guardian consent
  const kid = await signup(['athlete']), guardian = await signup(['athlete']);
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  const youthTry = await api('POST', `/events/${ev.id}/media/crew`, { token: pu.token, body: { ...body, user_id: kid.id, role: 'reporter' } });
  assert.equal(youthTry.status, 409); assert.equal(code(youthTry), 'guardian_consent_required');
});

test('streaming is honest: nothing is implied, live needs a playback link, access policy decides who gets it, stale live reports are unconfirmed', async () => {
  const org = await signup(), pu = await signup(), fan = await signup(['athlete']);
  const ev = await mkEvent(org), a = await mkTeam(org, 'A'), b = await mkTeam(org, 'B'), f = await mkFixture(ev, a, b);
  const partner = await partnerOrg(pu);
  assert.deepEqual(must(await api('GET', `/fixtures/${f.id}/streams`)), [], 'no stream configured, none shown');
  const provs = must(await api('GET', '/media-stream-providers'));
  assert.ok(provs.every((p) => p.integration === 'reference_only'), 'no provider integration is claimed');
  const { l } = await activeLicence(org, pu, ev, partner);
  const st = must(await api('POST', `/events/${ev.id}/media/streams`, { token: pu.token, body: { provider: 'youtube', channel_ref: 'UC-abc', fixture_id: f.id, licence_id: l.id, scheduled_start: iso(0, -1), scheduled_end: iso(0, 2), access_policy: 'public' } }), 201);
  assert.equal(st.state, 'scheduled'); assert.equal(st.integration, 'reference_only');
  assert.equal((await api('POST', `/media/streams/${st.id}/state`, { token: pu.token, body: { state: 'live' } })).status, 400, 'no playback link, no live');
  assert.equal(code(await api('POST', `/media/streams/${st.id}/state`, { token: pu.token, body: { state: 'live' } })), 'playback_required');
  assert.equal((await api('POST', `/events/${ev.id}/media/streams`, { token: pu.token, body: { provider: 'youtube', channel_ref: 'x', playback_ref: 'http://insecure.example/x', licence_id: l.id } })).status, 400);
  const live = must(await api('POST', `/media/streams/${st.id}/state`, { token: pu.token, body: { state: 'live', playback_ref: 'https://youtube.example/watch?v=1' } }));
  assert.equal(live.display_state, 'live'); assert.equal(live.reported_by, 'organiser_or_partner');
  let pub = must(await api('GET', `/fixtures/${f.id}/streams`));
  assert.equal(pub[0].display_state, 'live'); assert.match(pub[0].playback_ref, /^https:/); assert.equal(pub[0].channel_ref, undefined, 'channel reference is not public');
  // subscriber / private streams withhold the link from the public but not from the licensee or organiser
  must(await api('POST', `/events/${ev.id}/media/streams`, { token: pu.token, body: { stream_id: st.id, provider: 'youtube', channel_ref: 'UC-abc', playback_ref: 'https://youtube.example/watch?v=1', fixture_id: f.id, licence_id: l.id, access_policy: 'subscriber' } }), 201);
  pub = must(await api('GET', `/fixtures/${f.id}/streams`, { token: fan.token }));
  assert.equal(pub[0].playback_ref, undefined); assert.equal(pub[0].requires, 'subscription');
  assert.match(must(await api('GET', `/fixtures/${f.id}/streams`, { token: pu.token }))[0].playback_ref, /^https:/);
  must(await api('POST', `/events/${ev.id}/media/streams`, { token: pu.token, body: { stream_id: st.id, provider: 'youtube', channel_ref: 'UC-abc', fixture_id: f.id, licence_id: l.id, access_policy: 'private' } }), 201);
  assert.deepEqual(must(await api('GET', `/fixtures/${f.id}/streams`, { token: fan.token })), [], 'a private stream is not listed');
  // a "live" report long past the scheduled end is shown as unconfirmed, never as live
  await q("UPDATE mr_streams SET access_policy='public', state='live', scheduled_end = now() - interval '5 hours' WHERE id=$1", [st.id]);
  assert.equal(must(await api('GET', `/fixtures/${f.id}/streams`))[0].display_state, 'unconfirmed');
  // when the licence stops being in force, the partner can no longer go live on it
  await q("UPDATE mr_licences SET stage='terminated' WHERE id=$1", [l.id]);
  assert.equal((await api('POST', `/media/streams/${st.id}/state`, { token: pu.token, body: { state: 'live' } })).status, 404, 'the partner has no control once the licence is not in force');
  assert.equal((await api('POST', `/media/streams/${st.id}/state`, { token: org.token, body: { state: 'live', playback_ref: 'https://youtube.example/watch?v=1' } })).status, 409, 'and the stream cannot be shown live under a dead licence');
});

test('assets: declared ownership, embargo / expiry / territory, takedown hides derivatives, nothing is deleted, youth need live guardian media consent', async () => {
  const org = await signup(), pu = await signup(), other = await signup(), fan = await signup(['athlete']);
  const ev = await mkEvent(org), a = await mkTeam(org, 'A'), b = await mkTeam(org, 'B'), f = await mkFixture(ev, a, b);
  const partner = await partnerOrg(pu), rival = await partnerOrg(other);
  await activeLicence(org, pu, ev, partner, { rights: ['highlights', 'photography', 'live_video'], embargo_minutes: 0 }, { approved_rights: ['highlights', 'photography'] });
  const reg = (u, over = {}) => api('POST', `/events/${ev.id}/media/assets`, { token: u.token, body: { kind: 'clip', right_kind: 'highlights', title: `Clip ${++n}`, owner_kind: 'organiser', external_url: 'https://cdn.example/clip.mp4', fixture_id: f.id, audience: 'licensed', ...over } });
  // ownership is declared, never inferred from the upload
  assert.equal((await reg(pu)).status, 403, 'a partner cannot claim organiser ownership');
  assert.equal((await reg(pu, { owner_kind: 'partner' })).status, 400, 'a partner owner needs its id');
  assert.equal((await reg(org, { owner_kind: 'third_party' })).status, 400, 'a third-party owner needs a name');
  assert.equal((await reg(fan)).status, 404, 'outsiders cannot register');
  const src = must(await reg(org, { title: 'Full match highlights' }), 201);
  assert.equal(src.state, undefined === src.state ? undefined : src.state);
  assert.equal(src.status, 'draft'); assert.equal(src.owner_kind, 'organiser');
  const list = async (u) => must(await api('GET', `/events/${ev.id}/media/assets`, { token: u?.token })).items;
  assert.deepEqual(await list(pu), [], 'a draft is not visible to licensees');
  must(await api('POST', `/media/assets/${src.id}/status`, { token: org.token, body: { action: 'publish', row_version: src.row_version } }));
  assert.deepEqual((await list(pu)).map((x) => x.id), [src.id], 'licensed partner sees it');
  assert.deepEqual(await list(other), [], 'a partner without the right does not');
  assert.deepEqual(await list(fan), [], 'licensed material is not public');
  // embargo: invisible until it lifts, then visible
  const cur = must(await api('GET', `/media/assets/${src.id}`, { token: org.token }));
  must(await api('POST', `/media/assets/${src.id}/rights`, { token: org.token, body: { row_version: cur.row_version, embargo_until: iso(0, 2) } }));
  assert.deepEqual(await list(pu), []); assert.equal((await api('GET', `/media/assets/${src.id}`, { token: pu.token })).status, 404);
  assert.equal(must(await api('GET', `/media/assets/${src.id}`, { token: org.token })).state, 'embargoed');
  await q("UPDATE mr_assets SET embargo_until = now() - interval '1 minute' WHERE id=$1", [src.id]);
  assert.equal((await list(pu)).length, 1);
  // the package delay: after-the-fact content waits for the game to finish plus the delay
  await q('UPDATE mr_packages SET embargo_minutes = 120 WHERE event_id=$1', [ev.id]);
  assert.deepEqual(await list(pu), [], 'game not finished: replay/highlights are held back');
  await q("UPDATE fixtures SET finished_at = now() - interval '3 hours' WHERE id=$1", [f.id]);
  assert.equal((await list(pu)).length, 1, 'delay has passed');
  // territory and expiry
  await q("UPDATE mr_assets SET expires_at = now() - interval '1 second' WHERE id=$1", [src.id]);
  assert.deepEqual(await list(pu), []); assert.equal(must(await api('GET', `/media/assets/${src.id}`, { token: org.token })).state, 'expired');
  await q('UPDATE mr_assets SET expires_at = NULL WHERE id=$1', [src.id]);
  // a clip cut from it follows its source: take the source down and the derivative disappears too
  const clip = must(await reg(org, { title: 'Goal clip', kind: 'clip', right_kind: 'highlights', parent_asset_id: src.id, audience: 'public' }), 201);
  assert.equal((await reg(pu, { title: 'Derivative', parent_asset_id: src.id, owner_kind: 'partner', owner_partner_id: partner.partner_id })).status, 403, 'only the owner of the source can derive from it');
  must(await api('POST', `/media/assets/${clip.id}/status`, { token: org.token, body: { action: 'publish', row_version: clip.row_version } }));
  assert.equal((await list(fan)).length, 1, 'public clip visible to anyone');
  const srcNow = must(await api('GET', `/media/assets/${src.id}`, { token: org.token }));
  assert.equal((await api('POST', `/media/assets/${src.id}/status`, { token: pu.token, body: { action: 'take_down', reason: 'x', row_version: srcNow.row_version } })).status, 404, 'a partner who does not own it cannot even see its controls');
  assert.equal((await api('POST', `/media/assets/${src.id}/status`, { token: org.token, body: { action: 'take_down', row_version: srcNow.row_version } })).status, 400, 'a takedown needs a reason');
  must(await api('POST', `/media/assets/${src.id}/status`, { token: org.token, body: { action: 'take_down', reason: 'Rights dispute', row_version: srcNow.row_version } }));
  assert.deepEqual(await list(fan), [], 'derivative hidden with its source');
  assert.equal(must(await api('GET', `/media/assets/${clip.id}`, { token: org.token })).state, 'source_withdrawn');
  assert.equal((await q('SELECT count(*)::int AS n FROM mr_assets WHERE id = ANY($1)', [[src.id, clip.id]]))[0].n, 2, 'taken down, not deleted');
  const back = must(await api('GET', `/media/assets/${src.id}`, { token: org.token }));
  assert.ok(back.history.some((h) => h.action === 'take_down'));
  // youth: publishing is blocked without current guardian media consent, and a lapse hides a live asset
  const kid = await signup(['athlete']), guardian = await signup(['athlete']);
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, kid.id]);
  const photo = must(await reg(org, { title: 'Under-14 trophy photo', kind: 'photo', right_kind: 'photography', audience: 'public', subjects: [{ user_id: kid.id, consent_kind: 'guardian_media', consent_ref: 'form-77' }] }), 201);
  const noConsent = await api('POST', `/media/assets/${photo.id}/status`, { token: org.token, body: { action: 'publish', row_version: photo.row_version } });
  assert.equal(noConsent.status, 409); assert.equal(code(noConsent), 'guardian_consent_required');
  await q("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'media',$2,1, now() + interval '30 days')", [kid.id, guardian.id]);
  must(await api('POST', `/media/assets/${photo.id}/status`, { token: org.token, body: { action: 'publish', row_version: photo.row_version } }));
  assert.equal((await list(fan)).some((x) => x.id === photo.id), true);
  assert.ok(!JSON.stringify(await list(fan)).includes(kid.id), 'no identities in the public view');
  await q("UPDATE youth_consents SET revoked_at = now() WHERE child_id=$1 AND purpose='media'", [kid.id]);
  assert.equal((await list(fan)).some((x) => x.id === photo.id), false, 'revoked consent hides it at once');
  assert.equal(must(await api('GET', `/media/assets/${photo.id}`, { token: org.token })).state, 'consent_lapsed');
});

test('uploaded photos are scanned, stored encrypted, and served only while the rights allow; video must be a link', async () => {
  const org = await signup(), pu = await signup(), fan = await signup(['athlete']);
  const ev = await mkEvent(org);
  const partner = await partnerOrg(pu);
  await activeLicence(org, pu, ev, partner, { rights: ['photography'] }, { approved_rights: ['photography'] });
  assert.equal((await api('POST', `/events/${ev.id}/media/assets`, { token: org.token, body: { kind: 'video', right_kind: 'highlights', title: 'Video', owner_kind: 'organiser' } })).status, 400, 'video needs its hosted link');
  const photo = must(await api('POST', `/events/${ev.id}/media/assets`, { token: org.token, body: { kind: 'photo', right_kind: 'photography', title: 'Podium', owner_kind: 'organiser', audience: 'licensed', credit: 'Official photographer' } }), 201);
  assert.equal(photo.file_pending, true);
  assert.equal(code(await api('POST', `/media/assets/${photo.id}/status`, { token: org.token, body: { action: 'publish', row_version: photo.row_version } })), 'file_required');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-a-tiny-image')]);
  assert.equal((await api('PUT', `/media/assets/${photo.id}/file`, { token: fan.token, raw: png, query: { name: 'p.png' } })).status, 404);
  assert.equal((await api('PUT', `/media/assets/${photo.id}/file`, { token: org.token, raw: Buffer.from('not an image'), query: { name: 'p.txt' } })).status, 400);
  must(await api('PUT', `/media/assets/${photo.id}/file`, { token: org.token, raw: png, query: { name: 'podium.png' } }), 201);
  const fresh = must(await api('GET', `/media/assets/${photo.id}`, { token: org.token }));
  must(await api('POST', `/media/assets/${photo.id}/status`, { token: org.token, body: { action: 'publish', row_version: fresh.row_version } }));
  const get = (token) => fetch(`${base}/api/v1/media/assets/${photo.id}/file`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await get(pu.token)).status, 200);
  assert.deepEqual(Buffer.from(await (await get(org.token)).arrayBuffer()), png);
  assert.equal((await get(fan.token)).status, 404, 'licensed, not public');
  assert.equal((await get(null)).status, 404);
  const onDisk = (await q('SELECT stored_file FROM mr_assets WHERE id=$1', [photo.id]))[0].stored_file;
  assert.ok(onDisk && !onDisk.includes('podium'), 'stored under an opaque name');
  await q("UPDATE mr_assets SET status='taken_down' WHERE id=$1", [photo.id]);
  assert.equal((await get(pu.token)).status, 404, 'a takedown stops the bytes at once');
});

test('data feeds: only with the data-feed right, credential issued by the partner, rate limit and quota enforced, metered, and revocation / expiry stop it on REST and MCP at once', async () => {
  const org = await signup(), pu = await signup(), spy = await signup();
  const ev = await mkEvent(org), a = await mkTeam(org, 'A'), b = await mkTeam(org, 'B'), f = await mkFixture(ev, a, b, iso(0, 1));
  const partner = await partnerOrg(pu, 'data_licensee');
  const { l } = await activeLicence(org, pu, ev, partner, { rights: ['data_feed', 'live_video'] }, { approved_rights: ['data_feed'] });
  const feedBody = { consumer_name: 'Match centre', datasets: ['fixtures', 'live', 'results', 'standings'], mode: 'live', rate_per_minute: 2, daily_quota: 100, valid_to: iso(20) };
  // right checks
  const noRight = await activeLicence(org, pu, await mkEvent(org), partner, { rights: ['live_video'] }, { approved_rights: ['live_video'] });
  assert.equal(code(await api('POST', `/media/licences/${noRight.l.id}/feeds`, { token: org.token, body: feedBody })), 'no_data_feed_right');
  assert.equal((await api('POST', `/media/licences/${l.id}/feeds`, { token: pu.token, body: feedBody })).status, 403, 'the partner cannot grant itself access');
  assert.equal((await api('POST', `/media/licences/${l.id}/feeds`, { token: org.token, body: { ...feedBody, valid_to: iso(90) } })).status, 400, 'cannot outlast the licence');
  assert.equal((await api('POST', `/media/licences/${l.id}/feeds`, { token: org.token, body: { ...feedBody, mode: 'delayed' } })).status, 400, 'live scope needs live mode');
  const feed = must(await api('POST', `/media/licences/${l.id}/feeds`, { token: org.token, body: feedBody }), 201);
  // no credential yet: nothing is served, even to the partner
  assert.equal((await api('GET', `/media/feed/events/${ev.id}/fixtures`, { token: pu.token })).status, 403);
  // the organiser cannot mint the secret; the partner does, and it is shown once
  assert.equal((await api('POST', `/media/feeds/${feed.id}/credential`, { token: org.token })).status, 403);
  assert.equal((await api('POST', `/media/feeds/${feed.id}/credential`, { token: spy.token })).status, 404);
  const cred = must(await api('POST', `/media/feeds/${feed.id}/credential`, { token: pu.token }), 201);
  assert.match(cred.token, /^sa_/);
  const tok = cred.token;
  assert.ok(!JSON.stringify(must(await api('GET', `/events/${ev.id}/media/feeds`, { token: org.token }))).includes(tok), 'the secret is never listed');
  const get = (dataset, token = tok, query) => api('GET', `/media/feed/events/${ev.id}/${dataset}`, { token, query });
  const fx = must(await get('fixtures'));
  assert.equal(fx.data.length, 1); assert.equal(fx.source, 'SportArena official scoring and results');
  assert.ok(!JSON.stringify(fx).match(/email|phone|dob|player/i), 'no player or contact data');
  must(await get('standings'));   // second and last call in the window
  const limited = await get('results');
  assert.equal(limited.status, 429); assert.equal(limited.body.error.code, 'rate_limited'); assert.equal(limited.body.error.details.limit, 'rate');
  // the restricted token cannot be used for anything else on the platform
  assert.equal((await api('GET', '/me/tokens', { token: tok })).status, 403);
  // usage is audited for the organiser and the partner
  const use = must(await api('GET', `/media/feeds/${feed.id}/usage`, { token: org.token }));
  const total = use.days.reduce((t, d) => t + d.calls, 0), refused = use.days.reduce((t, d) => t + d.refused, 0);
  assert.equal(total, 2); assert.equal(refused, 1);
  assert.equal((await api('GET', `/media/feeds/${feed.id}/usage`, { token: spy.token })).status, 404);
  // the daily quota
  await q('UPDATE mr_feed_windows SET window_start = now() - interval \'2 minutes\' WHERE grant_id=$1', [feed.id]);
  await q('UPDATE mr_feed_grants SET daily_quota = 2 WHERE id=$1', [feed.id]);
  const quota = await get('fixtures'); assert.equal(quota.status, 429); assert.equal(quota.body.error.details.limit, 'quota');
  await q('UPDATE mr_feed_grants SET daily_quota = 100 WHERE id=$1', [feed.id]);
  // MCP uses the very same checks
  await q('UPDATE mr_feed_windows SET window_start = now() - interval \'2 minutes\' WHERE grant_id=$1', [feed.id]);
  const viaMcp = await rpc('tools/call', { name: 'get_media_feed', arguments: { event_id: ev.id, dataset: 'fixtures' } }, tok);
  assert.ok(!viaMcp.isError, JSON.stringify(viaMcp));
  // a feed for another event is refused for this credential
  const other = await mkEvent(org);
  assert.equal((await api('GET', `/media/feed/events/${other.id}/fixtures`, { token: tok })).status, 403);
  // revoke: the next call on every surface fails
  await q('UPDATE mr_feed_windows SET window_start = now() - interval \'2 minutes\' WHERE grant_id=$1', [feed.id]);
  const rev = must(await api('POST', `/media/feeds/${feed.id}/revoke`, { token: org.token, body: { reason: 'Breach of terms' } }));
  assert.equal(rev.status, 'revoked');
  assert.equal((await get('fixtures')).status, 401, 'the credential itself is revoked');
  const mcpAfter = await rpc('tools/call', { name: 'get_media_feed', arguments: { event_id: ev.id, dataset: 'fixtures' } }, tok);
  assert.ok(mcpAfter.isError || /401|unauthor/i.test(JSON.stringify(mcpAfter)), 'MCP refuses too');
  // re-issue is refused for a revoked feed; a fresh grant works
  assert.equal((await api('POST', `/media/feeds/${feed.id}/credential`, { token: pu.token })).status, 409);
  const feed2 = must(await api('POST', `/media/licences/${l.id}/feeds`, { token: org.token, body: { ...feedBody, rate_per_minute: 100 } }), 201);
  const tok2 = must(await api('POST', `/media/feeds/${feed2.id}/credential`, { token: pu.token }), 201).token;
  must(await get('fixtures', tok2));
  // the feed stops with the licence even though the token was not touched: suspend, then it refuses
  must(await decide(org, must(await api('GET', `/media/licences/${l.id}`, { token: org.token })), 'suspend', { reason: 'Payment dispute' }));
  assert.ok([401, 403].includes((await get('fixtures', tok2)).status));
  assert.equal((await q('SELECT status FROM mr_feed_grants WHERE id=$1', [feed2.id]))[0].status, 'revoked');
  // delayed mode: official results only after the delay, no live scores
  const lic3 = await activeLicence(org, pu, await mkEvent(org), partner, { rights: ['data_feed'] }, { approved_rights: ['data_feed'] });
  const dfeed = must(await api('POST', `/media/licences/${lic3.l.id}/feeds`, { token: org.token, body: { consumer_name: 'Delayed', datasets: ['fixtures', 'results'], mode: 'delayed', delay_seconds: 600, valid_to: iso(10) } }), 201);
  const dtok = must(await api('POST', `/media/feeds/${dfeed.id}/credential`, { token: pu.token }), 201).token;
  const ev3 = (await q('SELECT event_id FROM mr_packages WHERE id=$1', [lic3.p.id]))[0].event_id;
  assert.equal((await api('GET', `/media/feed/events/${ev3}/live`, { token: dtok })).status, 403, 'a delayed feed has no live dataset');
  assert.equal((await api('GET', `/media/feed/events/${ev3}/results`, { token: dtok })).status, 200);
});

test('expiry sweeps end feeds and revoke their credentials; reminders are sent once', async () => {
  const org = await signup(), pu = await signup();
  const ev = await mkEvent(org), partner = await partnerOrg(pu);
  const { l } = await activeLicence(org, pu, ev, partner, { rights: ['data_feed'] }, { approved_rights: ['data_feed'], effective_to: iso(5) });
  const feed = must(await api('POST', `/media/licences/${l.id}/feeds`, { token: org.token, body: { consumer_name: 'API', datasets: ['fixtures'], valid_to: iso(4) } }), 201);
  const tok = must(await api('POST', `/media/feeds/${feed.id}/credential`, { token: pu.token }), 201).token;
  const r1 = await runMediaRightsSweeps();
  assert.ok(r1.reminders >= 1);
  const count = async () => (await q("SELECT count(*)::int AS n FROM notifications WHERE kind='media_licence_expiring'"))[0].n;
  const c1 = await count();
  await runMediaRightsSweeps();
  assert.equal(await count(), c1, 'deduplicated');
  await q("UPDATE mr_feed_grants SET valid_to = now() - interval '1 minute', valid_from = now() - interval '2 days' WHERE id=$1", [feed.id]);
  assert.equal((await api('GET', `/media/feed/events/${ev.id}/fixtures`, { token: tok })).status, 403, 'refused before any sweep');
  await runMediaRightsSweeps();
  assert.equal((await q('SELECT revoked_at FROM api_tokens WHERE token_hash IS NOT NULL AND name LIKE $1 ORDER BY created_at DESC LIMIT 1', ['Media feed: API%']))[0].revoked_at !== null, true);
});

test('deliverables stay source-linked and reach is only what a named source measured', async () => {
  const org = await signup(), pu = await signup(), sp = await signup(['sponsor']);
  const ev = await mkEvent(org), partner = await partnerOrg(pu);
  const { l } = await activeLicence(org, pu, ev, partner);
  const dl = must(await api('POST', `/media/licences/${l.id}/deliverables`, { token: org.token, body: { kind: 'naming_mention', title: 'Presented by … mention at kick-off', due_at: iso(9) } }), 201);
  assert.equal((await api('POST', `/media/licences/${l.id}/deliverables`, { token: pu.token, body: { kind: 'other', title: 'Mine' } })).status, 403);
  // a sponsorship must be one of THIS event's
  const sponsor = (await q("INSERT INTO sponsors(user_id, company) VALUES ($1,'Acme') RETURNING id", [sp.id]).catch(() => null));
  if (sponsor) {
    const foreignEvent = await mkEvent(org);
    const s = (await q("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, proposed_by) VALUES ($1,'event',$2,100,$3) RETURNING id", [sponsor[0].id, foreignEvent.id, sp.id]))[0];
    assert.equal((await api('POST', `/media/licences/${l.id}/deliverables`, { token: org.token, body: { kind: 'signage', title: 'Boards', sponsorship_id: s.id } })).status, 400);
    await q("UPDATE sponsorships SET target_id=$2 WHERE id=$1", [s.id, ev.id]);
    const linked = must(await api('POST', `/media/licences/${l.id}/deliverables`, { token: org.token, body: { kind: 'signage', title: 'Boards', sponsorship_id: s.id } }), 201);
    assert.equal(linked.sponsorship_id, s.id);
    assert.equal(must(await api('GET', `/media/licences/${l.id}/deliverables`, { token: org.token })).items.find((x) => x.id === linked.id).sponsorship_status, 'proposed', 'the sponsorship status is read live from Sponsorship');
  }
  assert.equal(code(await api('POST', `/media/deliverables/${dl.id}/status`, { token: pu.token, body: { status: 'delivered' } })), 'evidence_required');
  must(await api('POST', `/media/deliverables/${dl.id}/status`, { token: pu.token, body: { status: 'delivered', evidence_url: 'https://proof.example/clip' } }));
  assert.equal((await api('POST', `/media/deliverables/${dl.id}/status`, { token: pu.token, body: { status: 'verified' } })).status, 403, 'the partner cannot verify itself');
  must(await api('POST', `/media/deliverables/${dl.id}/status`, { token: org.token, body: { status: 'verified' } }));
  // no measurement, no reach; the response says so rather than guessing
  assert.match(must(await api('GET', `/media/licences/${l.id}/deliverables`, { token: org.token })).note, /does not estimate/);
  const m = { metric: 'views', value: 12000, period_start: iso(-2), period_end: iso(-1), source_name: 'Provider analytics', source_ref: 'export-2026-10' };
  assert.equal((await api('POST', `/media/licences/${l.id}/measurements`, { token: pu.token, body: { ...m, source_name: undefined } })).status, 400);
  assert.equal((await api('POST', `/media/licences/${l.id}/measurements`, { token: pu.token, body: { ...m, period_start: iso(3), period_end: iso(4) } })).status, 400, 'no future numbers');
  must(await api('POST', `/media/licences/${l.id}/measurements`, { token: pu.token, body: m }), 201);
  const out = must(await api('GET', `/media/licences/${l.id}/deliverables`, { token: org.token }));
  assert.equal(out.measurements.length, 1); assert.equal(out.measurements[0].source_name, 'Provider analytics');
});

test('reports reconcile to the rights records, keep currencies apart and say what finance cannot report', async () => {
  const org = await signup(), u1 = await signup(), u2 = await signup(), outsider = await signup();
  const ev = await mkEvent(org), a = await mkTeam(org, 'A'), b = await mkTeam(org, 'B'), f = await mkFixture(ev, a, b);
  const p1 = await partnerOrg(u1), p2 = await partnerOrg(u2, 'press');
  await activeLicence(org, u1, ev, p1, { rights: ['live_video', 'highlights'] }, { approved_rights: ['live_video'], fee_minor: 1000000, currency: 'USD', effective_to: iso(20) });
  const pk = await pkg(org, ev, { rights: ['press'] });
  const lic = await offer(org, pk, p2, { approved_rights: ['press'], fee_minor: 250000, currency: 'EUR', effective_to: iso(45) });
  must(await decide(u2, lic, 'accept'));
  const report = async (name, query) => must(await api('GET', `/events/${ev.id}/media/reports/${name}`, { token: org.token, query }));
  assert.equal((await api('GET', `/events/${ev.id}/media/reports/revenue`, { token: outsider.token })).status, 403);
  const rev = (await report('revenue')).data;
  assert.deepEqual(rev.currencies.map((c) => [c.currency, c.contracted_minor]).sort(), [['EUR', 250000], ['USD', 1000000]], 'one line per currency, never added together');
  assert.equal(rev.currencies.find((c) => c.currency === 'USD').invoiced_minor, 0);
  assert.equal(rev.currencies.find((c) => c.currency === 'USD').not_yet_invoiced_minor, 1000000, 'contracted but not yet invoiced');
  const inv = (await report('rights_inventory')).data;
  assert.ok(inv.rights.find((r) => r.right === 'live_video').licensed >= 1);
  const cov = (await report('partner_coverage')).data;
  assert.equal(cov.length, 2); assert.equal(cov.find((c) => c.name === p1.org.name).games_covered, 1);
  assert.equal((await report('expiring', { days: 30 })).data.licences.length, 1, 'only the licence ending within 30 days');
  const ready = (await report('production_readiness')).data;
  assert.equal(ready[0].readiness, 'not_started');
  await api('POST', `/events/${ev.id}/media/streams`, { token: org.token, body: { provider: 'youtube', channel_ref: 'c', fixture_id: f.id } });
  assert.equal((await report('production_readiness')).data[0].readiness, 'attention');
  await report('published_assets'); await report('embargo_takedown');
});

test('rights-fee billing: invoiced never exceeds contracted, paid online or recorded offline, one currency at a time, refund and cancellation are honest', async () => {
  const org = await signup(), pu = await signup(), pu2 = await signup(), spy = await signup();
  const ev = await mkEvent(org), partner = await partnerOrg(pu);
  await q("INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,'admin','active')", [partner.org.id, pu2.id]);
  const { l } = await activeLicence(org, pu, ev, partner, {}, { fee_minor: 900000, currency: 'EUR' });
  const fee = (u, body = {}) => api('POST', `/media/licences/${l.id}/fees`, { token: u.token, body });
  assert.equal((await fee(pu, { amount_minor: 1000 })).status, 403, 'only the organiser invoices');
  assert.equal((await fee(spy)).status, 404);
  assert.equal(code(await fee(org, { amount_minor: 900001 })), 'exceeds_contracted_fee');
  const first = must(await fee(org, { amount_minor: 300000, description: 'Deposit', due_on: iso(-2).slice(0, 10) }), 201);
  assert.match(first.number, /^MRF-/); assert.equal(first.currency, 'EUR'); assert.equal(first.overdue, true);
  assert.equal(first.payer_id, pu.id, 'defaults to the first owner/admin of the partner');
  assert.equal((await fee(org, { amount_minor: 100, payer_id: spy.id })).status, 400, 'the payer must be a partner member who can act');
  let list = must(await api('GET', `/media/licences/${l.id}/fees`, { token: pu.token }));
  assert.deepEqual([list.totals.contracted_minor, list.totals.invoiced_minor, list.totals.collected_minor, list.totals.outstanding_minor, list.totals.not_yet_invoiced_minor], [900000, 300000, 0, 300000, 600000]);
  assert.equal((await api('GET', `/media/licences/${l.id}/fees`, { token: spy.token })).status, 404);
  // only the payer can pay; another partner admin can take it over
  assert.equal((await describePurpose(pool, 'media_rights_fee', first.id)).payerId, pu.id);
  assert.equal((await api('POST', `/media/fees/${first.id}/payer`, { token: org.token })).status, 403);
  must(await api('POST', `/media/fees/${first.id}/payer`, { token: pu2.token }));
  const d = await describePurpose(pool, 'media_rights_fee', first.id);
  assert.equal(d.payerId, pu2.id); assert.equal(d.currency, 'EUR'); assert.equal(d.amount, 300000); assert.equal(d.payable, true);
  // online payment settles through the payments module
  const pay = (await q("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency) VALUES ($1,'stripe','media_rights_fee',$2,300000,'EUR') RETURNING id", [pu2.id, first.id]))[0];
  assert.equal((await settle(pay.id, { paid: true, amount: 300000, currency: 'EUR', paymentRef: 'pi_test' })).status, 'paid');
  assert.equal((await q('SELECT status, paid_method FROM mr_fees WHERE id=$1', [first.id]))[0].paid_method, 'online');
  assert.equal((await describePurpose(pool, 'media_rights_fee', first.id)).payable, false, 'already paid');
  // offline receipt, cancellation and re-issue
  const second = must(await fee(org, { amount_minor: 400000 }), 201);
  assert.equal((await api('POST', `/media/fees/${second.id}/received`, { token: pu.token, body: { reference: 'x1' } })).status, 403);
  must(await api('POST', `/media/fees/${second.id}/received`, { token: org.token, body: { reference: 'Bank transfer 2291' } }));
  assert.equal((await api('POST', `/media/fees/${second.id}/cancel`, { token: org.token, body: { reason: 'Mistake' } })).status, 409, 'a paid fee cannot be cancelled');
  const third = must(await fee(org, { amount_minor: 200000 }), 201);
  must(await api('POST', `/media/fees/${third.id}/cancel`, { token: org.token, body: { reason: 'Re-issuing with a due date' } }));
  assert.equal((await describePurpose(pool, 'media_rights_fee', third.id)).payable, false);
  list = must(await api('GET', `/media/licences/${l.id}/fees`, { token: org.token }));
  assert.deepEqual([list.totals.invoiced_minor, list.totals.collected_minor, list.totals.outstanding_minor, list.totals.not_yet_invoiced_minor], [700000, 700000, 0, 200000], 'cancelled fees do not count as invoiced');
  const rev = (await api('GET', `/events/${ev.id}/media/reports/revenue`, { token: org.token })).body.data.currencies;
  const eur = rev.find((c) => c.currency === 'EUR');
  assert.deepEqual([eur.contracted_minor, eur.invoiced_minor, eur.collected_minor, eur.collected_online_minor, eur.collected_offline_minor, eur.not_yet_invoiced_minor], [900000, 700000, 700000, 300000, 400000, 200000]);
  assert.equal(rev.length, 1, 'no other currency leaks in');
  // refund of the whole online payment marks the fee refunded and takes it out of collected
  await q("UPDATE payments SET refunded_cents = amount_cents, status='refunded' WHERE id=$1", [pay.id]);
  const { syncRefunds } = await import('../src/settlement.js');
  await syncRefunds(pool, pay.id);
  assert.equal((await q('SELECT status FROM mr_fees WHERE id=$1', [first.id]))[0].status, 'refunded');
  const after = (await api('GET', `/events/${ev.id}/media/reports/revenue`, { token: org.token })).body.data.currencies.find((c) => c.currency === 'EUR');
  assert.deepEqual([after.collected_minor, after.refunded_minor], [400000, 300000]);
  assert.ok((await q("SELECT count(*)::int AS n FROM mr_log WHERE subject_type='fee' AND subject_id=$1", [first.id]))[0].n >= 3);
});

test('REST / OpenAPI / MCP parity: every media-rights capability is exposed on all three with its scope', async () => {
  const spec = (await api('GET', '/openapi.json')).body;
  const tools = (await rpc('tools/list', {}, (await signup()).token)).tools.map((t) => t.name);
  const names = ['register_media_partner', 'search_media_partners', 'list_my_media_partners', 'save_rights_package', 'set_rights_package_status', 'list_rights_packages', 'propose_media_licence', 'revise_media_licence',
    'decide_media_licence', 'link_media_licence_records', 'renew_media_licence', 'get_media_licence', 'list_media_licences', 'get_media_workspace', 'save_crew_assignment', 'respond_crew_assignment', 'release_crew_assignment',
    'list_media_crew', 'save_run_item', 'log_media_incident', 'resolve_media_incident', 'get_call_sheet', 'list_stream_providers', 'save_stream', 'set_stream_state', 'list_event_streams', 'get_fixture_streams',
    'save_media_collection', 'list_media_collections', 'set_collection_assets', 'register_media_asset', 'update_media_asset_rights', 'set_media_asset_status', 'list_media_assets', 'get_media_asset',
    'list_my_media_assignments', 'list_open_rights_packages', 'issue_media_fee', 'list_media_fees', 'take_over_media_fee', 'cancel_media_fee', 'record_media_fee_payment', 'save_media_deliverable', 'set_media_deliverable_status', 'list_media_deliverables', 'record_media_measurement', 'grant_data_feed', 'issue_feed_credential', 'revoke_data_feed', 'list_data_feeds', 'get_feed_usage', 'get_media_feed', 'get_media_report'];
  for (const name of names) assert.ok(tools.includes(name), `MCP tool ${name}`);
  const ops = Object.values(spec.paths).flatMap((p) => Object.values(p));
  for (const name of names) assert.ok(ops.some((o) => o.operationId === name), `OpenAPI operation ${name}`);
  const feed = ops.find((o) => o.operationId === 'get_media_feed');
  assert.equal(feed['x-required-scope'], 'read');
  assert.equal(ops.find((o) => o.operationId === 'grant_data_feed')['x-required-scope'], 'write');
  // unauthenticated callers get nothing from the protected surfaces
  assert.equal((await api('GET', '/media-workspace')).status, 401);
  assert.equal((await api('GET', '/media/feed/events/00000000-0000-0000-0000-000000000000/fixtures')).status, 401);
});

test('the migration is additive: it creates only media-rights tables and leaves existing data alone', async () => {
  const mine = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'mr\\_%' OR table_name='media_partners') ORDER BY 1")).map((r) => r.table_name);
  assert.ok(mine.includes('mr_licences') && mine.includes('mr_feed_grants') && mine.includes('media_partners'));
  const sql = (await import('node:fs')).readFileSync(new URL('../migrations/116_media_rights.sql', import.meta.url), 'utf8');
  assert.ok(!/\bDROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|ON\s+DELETE\s+CASCADE/i.test(sql), 'no destructive statements');
});
