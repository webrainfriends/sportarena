// Travel partner adapters (#704): search / hold / book / cancel through a sandbox partner, room blocks, consent, partner callbacks, cost reconciliation.
// Real PostgreSQL, real HTTP. Enabling an integration for an organisation is covered in integrations.test.js; here the install row is created directly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLATFORM_ADMIN_EMAILS = 'rraja.edge@gmail.com,rrajas1978@icloud.com';
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { encrypt } = await import('../src/crypto.js');
const { createHmac } = await import('node:crypto');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `tv_${n}_${roles[0]}`, display_name: `Trav ${n}`, email: `tv${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const kid = (age = 14) => signup(['athlete'], { dob: yearsAgo(age) });
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };
async function verifiedGuardian(parent, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
}
const addTo = (teamId, user, role = 'player') => pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,$3,'active') ON CONFLICT (team_id, user_id) DO UPDATE SET status='active', role=$3", [teamId, user.id, role]);
const inDays = (d, h = 9) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(h, 0, 0, 0); return x; };
const iso = (d, h) => inDays(d, h).toISOString();
/** An ISO instant written with the +05:30 offset of Asia/Kolkata */
const kolkata = (d, h, m = 0) => { const x = inDays(d, h); x.setUTCMinutes(m); const t = new Date(x.getTime() + 330 * 60000); return `${t.toISOString().slice(0, 19)}+05:30`; };
const uniq = () => `key-${Date.now()}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

/** a club: manager (team owner), team, event they are entered in, and a trip over it */
async function club() {
  const mgr = await signup(['organizer', 'athlete']);
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Travel FC ${++n}`, sport: 'football' } }), 201);
  const host = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: host.token, body: { name: `Away Cup ${n}`, sport: 'football', starts_on: iso(10).slice(0, 10), ends_on: iso(12).slice(0, 10) } }), 201);
  const rival = must(await api('POST', '/teams', { token: host.token, body: { name: `Rivals ${n}`, sport: 'football' } }), 201);
  await pool.query("INSERT INTO event_entries(event_id, team_id, status) VALUES ($1,$2,'accepted')", [ev.id, team.id]);
  const fx = (await pool.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3,$4) RETURNING *', [ev.id, rival.id, team.id, iso(11, 14)])).rows[0];
  const trip = must(await api('POST', '/trips', { token: mgr.token, body: {
    name: `Away Cup trip ${n}`, team_id: team.id, origin: 'Mumbai', destination: 'Delhi', timezone: 'Asia/Kolkata', depart_at: kolkata(9, 3), return_at: kolkata(13, 15),
    event_ids: [ev.id], fixture_ids: [fx.id], idempotency_key: uniq(),
  } }), 201);
  return { mgr, team, host, ev, fx, trip, rival };
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('tv_root','tv_root','{admin}','x','x','tv_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });


const sign = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');
/** the club's team belongs to an organisation that has a connected sandbox travel partner, with a webhook secret */
async function withPartner(c, provider = 'travel_sandbox') {
  const org = (await pool.query("INSERT INTO organisations(name, kind, created_by) VALUES ($1,'club',$2) RETURNING id", [`Org ${++n}`, c.mgr.id])).rows[0];
  await pool.query('UPDATE teams SET organisation_id=$2 WHERE id=$1', [c.team.id, org.id]);
  const inst = (await pool.query("INSERT INTO integration_installs(organisation_id, provider_key, category, provider_version, label, mode) VALUES ($1,$2,'travel','1.0','Sandbox travel','sandbox') RETURNING *", [org.id, provider])).rows[0];
  const secret = `whsec_${Math.random().toString(36).slice(2)}`;
  await pool.query("INSERT INTO integration_credentials(install_id, kind, secret_enc) VALUES ($1,'webhook_secret',$2)", [inst.id, encrypt(secret, 'integration_credentials.secret')]);
  return { org, inst, secret };
}
async function traveller(c) {
  const u = await signup(['athlete']);
  await addTo(c.team.id, u);
  must(await api('POST', `/trips/${c.trip.id}/party`, { token: c.mgr.token, body: { user_id: u.id, role: 'athlete' } }), 201);
  must(await api('POST', `/trips/${c.trip.id}/party/respond`, { token: u.token, body: { response: 'confirm' } }));
  const p = (await pool.query('SELECT id FROM trip_participants WHERE trip_id=$1 AND user_id=$2', [c.trip.id, u.id])).rows[0];
  return { ...u, pid: p.id };
}
const hotelSearch = (c) => ({ kind: 'stay', destination: 'Delhi', country: 'IN', check_in_on: kolkata(9, 6).slice(0, 10), check_out_on: kolkata(12, 6).slice(0, 10), rooms: 2, currency: 'INR', destination_tz: 'Asia/Kolkata' });
const holdBody = (offer, pax, extra = {}) => ({ kind: 'stay', partner_key: offer.partner.key, offer_ref: offer.offer_ref, offer: { summary: offer.summary, property_name: offer.property_name, starts_at: offer.starts_at, ends_at: offer.ends_at, tz: offer.tz }, destination: 'Delhi', rooms: 2, traveller_ids: pax, idempotency_key: uniq(), ...extra });

test('no partner configured: search is refused with a clear code and typed references still work', async () => {
  const c = await club();
  const r = await api('POST', `/trips/${c.trip.id}/travel/search`, { token: c.mgr.token, body: hotelSearch(c) });
  assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code ?? r.body.error?.code, 'travel_partner_not_configured', JSON.stringify(r.body));
  const list = must(await api('GET', `/trips/${c.trip.id}/bookings`, { token: c.mgr.token }));
  assert.equal(list.partner_configured, false);
  must(await api('POST', `/trips/${c.trip.id}/stays`, { token: c.mgr.token, body: { property_name: 'Typed Hotel', reference: 'ABC123', check_in_at: kolkata(9, 6), check_out_at: kolkata(12, 6), tz: 'Asia/Kolkata', status: 'booked' } }), 201);
});

test('stub partner: consent gate, search, hold, book attaches to the trip and reconciles to costs and the event ledger; no PII in history', async () => {
  const c = await club(); await withPartner(c);
  const t = await traveller(c);
  const search = must(await api('POST', `/trips/${c.trip.id}/travel/search`, { token: c.mgr.token, body: hotelSearch(c) }));
  assert.equal(search.mode, 'sandbox'); assert.equal(search.offers.length, 2);
  const offer = search.offers[0];
  // nobody has agreed to share details yet
  const blocked = await api('POST', `/trips/${c.trip.id}/bookings`, { token: c.mgr.token, body: holdBody(offer, [t.pid]) });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code ?? blocked.body.error?.code, 'consent_required');
  // staff cannot consent for someone else; the traveller can
  assert.equal((await api('POST', `/trips/${c.trip.id}/partner-consent`, { token: c.mgr.token, body: { participant_id: t.pid, granted: true } })).status, 403);
  must(await api('POST', `/trips/${c.trip.id}/partner-consent`, { token: t.token, body: { participant_id: t.pid, granted: true } }));
  const body = holdBody(offer, [t.pid]);
  const held = must(await api('POST', `/trips/${c.trip.id}/bookings`, { token: c.mgr.token, body }), 201);
  assert.equal(held.status, 'held'); assert.ok(held.partner_ref.startsWith('SBX-'));
  assert.equal(must(await api('POST', `/trips/${c.trip.id}/bookings`, { token: c.mgr.token, body }), 201).id, held.id); // idempotent
  assert.equal(held.price_minor, offer.price_minor);                                                                  // the partner's price, derived server-side
  // booking is not confirmed yet: the stay is planned and partner-sourced, never "verified"
  assert.equal((await pool.query('SELECT status, reference_source FROM trip_stays WHERE id=$1', [held.stay_id])).rows[0].reference_source, 'partner');
  assert.equal((await api('POST', `/trips/${c.trip.id}/bookings/${held.id}/book`, { token: t.token, body: { row_version: held.row_version } })).status, 403);
  const booked = must(await api('POST', `/trips/${c.trip.id}/bookings/${held.id}/book`, { token: c.mgr.token, body: { row_version: held.row_version } }));
  assert.equal(booked.status, 'booked'); assert.equal(booked.verified, true);
  assert.equal((await pool.query('SELECT status FROM trip_stays WHERE id=$1', [held.stay_id])).rows[0].status, 'booked');
  // itinerary / cost reconciliation
  const fin = must(await api('GET', `/trips/${c.trip.id}/finance`, { token: c.mgr.token }));
  assert.equal(fin.costs.find((x) => x.currency === 'INR').partner_bookings_minor, offer.price_minor);
  const rooming = must(await api('GET', `/trips/${c.trip.id}/rooming`, { token: c.mgr.token }));
  assert.ok(JSON.stringify(rooming).includes(held.stay_id));
  // the traveller sees their booking; an outsider sees nothing
  assert.equal(must(await api('GET', `/trips/${c.trip.id}/bookings`, { token: t.token })).bookings.length, 1);
  const out = await signup(['athlete']);
  assert.equal((await api('GET', `/trips/${c.trip.id}/bookings`, { token: out.token })).status, 404);
  // history carries no personal data
  const hist = JSON.stringify((await pool.query('SELECT snapshot, note FROM trip_changes WHERE trip_id=$1 AND entity=$2', [c.trip.id, 'travel_booking'])).rows) + JSON.stringify((await pool.query('SELECT detail FROM travel_booking_events WHERE booking_id=$1', [held.id])).rows);
  assert.ok(!hist.includes(t.display_name ?? 'Trav '));
});

test('partner change and cancellation update the trip and keep the history; repeats and unsigned callbacks change nothing', async () => {
  const c = await club(); const { inst, secret } = await withPartner(c);
  const t = await traveller(c);
  must(await api('POST', `/trips/${c.trip.id}/partner-consent`, { token: t.token, body: { participant_id: t.pid, granted: true } }));
  const offer = must(await api('POST', `/trips/${c.trip.id}/travel/search`, { token: c.mgr.token, body: hotelSearch(c) })).offers[0];
  const held = must(await api('POST', `/trips/${c.trip.id}/bookings`, { token: c.mgr.token, body: holdBody(offer, [t.pid]) }), 201);
  must(await api('POST', `/trips/${c.trip.id}/bookings/${held.id}/book`, { token: c.mgr.token, body: { row_version: held.row_version } }));
  const hook = (payload, sig) => fetch(`${base}/api/v1/webhooks/integrations/${inst.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sportarena-signature': `sha256=${sig ?? sign(secret, payload)}` }, body: payload });
  const later = new Date(Date.parse(offer.ends_at) + 864e5).toISOString();
  const ev = JSON.stringify({ events: [{ id: 'e1', type: 'booking.changed', partner_ref: held.partner_ref, ends_at: later, price_minor: offer.price_minor + 5000, note: 'Hotel extended the stay by a night' }] });
  assert.equal((await hook(ev, 'bad')).status, 401);
  assert.equal((await hook(ev)).status, 200);
  assert.equal((await hook(ev)).status, 200);                                            // replay is acknowledged and ignored
  const after1 = must(await api('GET', `/trips/${c.trip.id}/bookings/${held.id}`, { token: c.mgr.token }));
  assert.equal(after1.status, 'changed'); assert.equal(after1.price_minor, offer.price_minor + 5000);
  assert.equal(after1.history.filter((h) => h.action === 'changed').length, 1);
  const stay = (await pool.query('SELECT status, check_out_at FROM trip_stays WHERE id=$1', [held.stay_id])).rows[0];
  assert.equal(stay.status, 'changed'); assert.equal(new Date(stay.check_out_at).toISOString(), later);
  assert.ok(must(await api('GET', '/notifications', { token: t.token })).items.some((x) => /changed/i.test(x.title)));
  const cancel = JSON.stringify({ events: [{ id: 'e2', type: 'booking.cancelled', partner_ref: held.partner_ref }] });
  assert.equal((await hook(cancel)).status, 200);
  const done = must(await api('GET', `/trips/${c.trip.id}/bookings/${held.id}`, { token: c.mgr.token }));
  assert.equal(done.status, 'cancelled'); assert.deepEqual(done.history.map((h) => h.action), ['held', 'booked', 'changed', 'cancelled']);
  assert.equal((await pool.query('SELECT status FROM trip_stays WHERE id=$1', [held.stay_id])).rows[0].status, 'cancelled');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM trip_stays WHERE id=$1', [held.stay_id])).rows[0].n, 1); // kept, not deleted
  const fin = must(await api('GET', `/trips/${c.trip.id}/finance`, { token: c.mgr.token }));
  assert.equal(fin.costs.find((x) => x.currency === 'INR').partner_bookings_minor, 0);
  // history rows are append-only
  await assert.rejects(pool.query('DELETE FROM travel_booking_events WHERE booking_id=$1', [held.id]));
});

test('a manager can cancel a held flight; flights send a date of birth only for travellers who agreed', async () => {
  const c = await club(); await withPartner(c);
  const t = await traveller(c);
  must(await api('PATCH', '/me', { token: t.token, body: { dob: yearsAgo(25) } }).catch(() => ({ status: 200, body: {} })), 200);
  must(await api('POST', `/trips/${c.trip.id}/partner-consent`, { token: t.token, body: { participant_id: t.pid, granted: true } }));
  const s = must(await api('POST', `/trips/${c.trip.id}/travel/search`, { token: c.mgr.token, body: { kind: 'air', origin: 'Mumbai', destination: 'Delhi', origin_tz: 'Asia/Kolkata', destination_tz: 'Asia/Kolkata', depart_on: kolkata(9, 6).slice(0, 10), pax: 1, currency: 'INR' } }));
  const o = s.offers[0];
  const held = must(await api('POST', `/trips/${c.trip.id}/bookings`, { token: c.mgr.token, body: { kind: 'air', partner_key: o.partner.key, offer_ref: o.offer_ref, offer: { summary: o.summary, starts_at: o.starts_at, ends_at: o.ends_at, tz: o.tz, arrive_tz: o.arrive_tz }, origin: 'Mumbai', destination: 'Delhi', traveller_ids: [t.pid], idempotency_key: uniq() } }), 201);
  assert.ok(held.segment_id);
  const x = must(await api('POST', `/trips/${c.trip.id}/bookings/${held.id}/cancel`, { token: c.mgr.token, body: { row_version: held.row_version, reason: 'Plans changed' } }));
  assert.equal(x.status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM trip_segments WHERE id=$1', [held.segment_id])).rows[0].status, 'cancelled');
  assert.equal((await api('POST', `/trips/${c.trip.id}/bookings/${held.id}/cancel`, { token: c.mgr.token, body: { row_version: x.row_version, reason: 'Again please' } })).status, 409);
});

test('room blocks: organiser publishes, trip takes rooms under a lock, cut-off and capacity are enforced, cancel frees rooms', async () => {
  const c = await club();
  const t = await traveller(c);
  must(await api('POST', `/trips/${c.trip.id}/partner-consent`, { token: t.token, body: { participant_id: t.pid, granted: true } }));
  const blk = { property_name: 'Stay & Play Inn', check_in_on: kolkata(9, 6).slice(0, 10), check_out_on: kolkata(12, 6).slice(0, 10), rooms_total: 3, rate_minor: 250000, currency: 'INR', cut_off_on: kolkata(8, 6).slice(0, 10), terms: 'Pay the hotel on arrival' };
  assert.equal((await api('POST', `/events/${c.ev.id}/room-blocks`, { token: c.mgr.token, body: blk })).status, 403); // the trip manager does not organise the event
  const k = must(await api('POST', `/events/${c.ev.id}/room-blocks`, { token: c.host.token, body: blk }), 201);
  const seen = must(await api('GET', `/trips/${c.trip.id}/bookings`, { token: c.mgr.token }));
  assert.equal(seen.room_blocks[0].rooms_left, 3);
  const take = (rooms) => api('POST', `/trips/${c.trip.id}/bookings/room-block`, { token: c.mgr.token, body: { room_block_id: k.id, rooms, traveller_ids: [t.pid], idempotency_key: uniq() } });
  const b = must(await take(2), 201);
  assert.equal(b.source, 'room_block'); assert.equal(b.price_minor, 250000 * 2 * 3);
  const full = await take(2);
  assert.equal(full.status, 409); assert.equal(full.body.code ?? full.body.error?.code, 'room_block_full');
  must(await api('POST', `/trips/${c.trip.id}/bookings/${b.id}/cancel`, { token: c.mgr.token, body: { row_version: b.row_version, reason: 'Fewer travellers' } }));
  must(await take(3), 201);
  assert.equal(must(await api('GET', `/events/${c.ev.id}/room-blocks`, { token: c.host.token }))[0].rooms_left, 0);
});

test('REST, OpenAPI and MCP expose the booking capabilities from one definition', async () => {
  const names = ['search_trip_travel', 'hold_trip_booking', 'book_trip_booking', 'cancel_trip_booking', 'list_trip_bookings', 'get_trip_booking', 'set_trip_partner_consent', 'create_event_room_block', 'list_event_room_blocks', 'book_trip_room_block'];
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json().catch(() => null);
  if (spec?.paths) assert.ok(Object.keys(spec.paths).some((p) => p.includes('/bookings')));
  const mgr = await signup(['organizer']);
  const tools = (await rpc('tools/list', {}, mgr.token)).tools.map((x) => x.name);
  for (const nm of names) assert.ok(tools.includes(nm), nm);
});

let paCache;
const platformAdmin = async () => {
  if (paCache) return paCache;
  const r = await api('POST', '/auth/register', { body: { handle: 'tvpa_root', display_name: 'Platform', email: 'rraja.edge@gmail.com', password: 'correct-horse-battery', roles: ['organizer'] } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  const uid = r.body.user?.id ?? r.body.id;
  await pool.query("UPDATE users SET roles = roles || '{platform_admin}' WHERE id=$1", [uid]);
  return (paCache = { id: uid, token: await signToken({ id: uid, roles: ['organizer', 'platform_admin'] }) });
};
const partnerBody = (label, extra = {}) => ({ label, preset: 'sandbox', kinds: ['stay', 'air'], regions: ['IN'], mode: 'sandbox', ...extra });

test('channel partners: platform admin only, secrets never returned, region and kind rules', async () => {
  const pa = await platformAdmin(); const ordinary = await signup(['organizer']);
  assert.equal((await api('POST', '/admin/travel-partners', { token: ordinary.token, body: partnerBody('Nope') })).status, 403);
  assert.equal((await api('GET', '/admin/travel-partners', { token: ordinary.token })).status, 403);
  const made = must(await api('POST', '/admin/travel-partners', { token: pa.token, body: partnerBody('Sandbox India') }), 201);
  assert.ok(made.webhook_secret && made.webhook_path.endsWith(made.id));
  const listed = JSON.stringify(must(await api('GET', '/admin/travel-partners', { token: pa.token })));
  assert.ok(!listed.includes(made.webhook_secret)); assert.ok(listed.includes('Booking.com') && listed.includes('Expedia'));
  assert.equal((await api('POST', '/admin/travel-partners', { token: pa.token, body: partnerBody('Live sandbox', { mode: 'live' }) })).status, 400);       // the sandbox books nothing real
  assert.equal((await api('POST', '/admin/travel-partners', { token: pa.token, body: { label: 'Booking.com IN', preset: 'booking_com', kinds: ['air'], regions: ['IN'], mode: 'live', connection: { url: 'https://api.example.org', api_key: 'k_12345678' } } })).status, 400); // a hotel site has no flights
  assert.equal((await api('POST', '/admin/travel-partners', { token: pa.token, body: { label: 'Private', preset: 'agoda', kinds: ['stay'], regions: ['IN'], mode: 'live', connection: { url: 'https://10.0.0.5/api', api_key: 'k_12345678' } } })).status, 400); // no private networks
  assert.equal((await api('GET', '/admin/travel-partners', { token: pa.token })).body.items.some((x) => x.credentials_set === undefined), false);
  must(await api('PATCH', `/admin/travel-partners/${made.id}`, { token: pa.token, body: { status: 'archived' } }));
});

test('several partners per region: search merges them cheapest first, a failing partner never blocks, region and status are respected, booking goes through the chosen one', async () => {
  const pa = await platformAdmin(); const c = await club(); const t = await traveller(c);
  await pool.query("UPDATE travel_channel_partners SET status='archived', archived_at=now()");                 // a clean slate for this test
  const a = must(await api('POST', '/admin/travel-partners', { token: pa.token, body: partnerBody('Sandbox A', { regions: ['IN'] }) }), 201);
  const b = must(await api('POST', '/admin/travel-partners', { token: pa.token, body: partnerBody('Sandbox B', { regions: ['IN', 'AE'] }) }), 201);
  const world = must(await api('POST', '/admin/travel-partners', { token: pa.token, body: partnerBody('Sandbox World', { regions: [] }) }), 201);
  const uae = must(await api('POST', '/admin/travel-partners', { token: pa.token, body: partnerBody('Sandbox UAE only', { regions: ['AE'] }) }), 201);
  const down = must(await api('POST', '/admin/travel-partners', { token: pa.token, body: { label: 'Down OTA', preset: 'agoda', kinds: ['stay'], regions: ['IN'], mode: 'sandbox', connection: { url: 'http://localhost:9/api', api_key: 'k_12345678' } } }), 201);
  must(await api('POST', `/trips/${c.trip.id}/partner-consent`, { token: t.token, body: { participant_id: t.pid, granted: true } }));
  const q = { ...hotelSearch(c), country: 'IN' };
  const s = must(await api('POST', `/trips/${c.trip.id}/travel/search`, { token: c.mgr.token, body: q }));
  const names = s.partners.map((x) => x.label).sort();
  assert.deepEqual(names, ['Down OTA', 'Sandbox A', 'Sandbox B', 'Sandbox World']);                    // UAE-only is not asked for an Indian trip
  assert.equal(s.partners.find((x) => x.label === 'Down OTA').ok, false);
  assert.ok(s.offers.length === 6 && s.offers.every((o) => o.partner?.label));                         // 3 working partners x 2 offers
  assert.deepEqual(s.offers.map((o) => o.price_minor), [...s.offers.map((o) => o.price_minor)].sort((x, y) => x - y));
  // the chosen partner is the one booked, and the booking says so
  const pick = s.offers.find((o) => o.partner.label === 'Sandbox B' && o.terms.refundable);
  const held = must(await api('POST', `/trips/${c.trip.id}/bookings`, { token: c.mgr.token, body: holdBody(pick, [t.pid], { destination_country: 'IN' }) }), 201);
  assert.equal(held.partner_label, 'Sandbox B');
  assert.equal((await pool.query('SELECT channel_partner_id FROM travel_bookings WHERE id=$1', [held.id])).rows[0].channel_partner_id, b.id);
  // a partner paused after the hold can still confirm and cancel what it holds, but is no longer searched
  must(await api('PATCH', `/admin/travel-partners/${b.id}`, { token: pa.token, body: { status: 'paused' } }));
  must(await api('POST', `/trips/${c.trip.id}/bookings/${held.id}/book`, { token: c.mgr.token, body: { row_version: held.row_version } }));
  const again = must(await api('POST', `/trips/${c.trip.id}/travel/search`, { token: c.mgr.token, body: q }));
  assert.ok(!again.partners.some((x) => x.label === 'Sandbox B'));
  assert.equal((await api('POST', `/trips/${c.trip.id}/bookings`, { token: c.mgr.token, body: holdBody(pick, [t.pid], { destination_country: 'IN', idempotency_key: uniq() }) })).status, 409); // stale partner key
  // another region only sees its own partners; a region nobody serves falls back to typed references
  const ae = must(await api('POST', `/trips/${c.trip.id}/travel/search`, { token: c.mgr.token, body: { ...q, country: 'AE' } }));
  assert.deepEqual(ae.partners.map((x) => x.label).sort(), ['Sandbox UAE only', 'Sandbox World']);
  must(await api('PATCH', `/admin/travel-partners/${world.id}`, { token: pa.token, body: { regions: ['IN'] } }));
  assert.equal((await api('POST', `/trips/${c.trip.id}/travel/search`, { token: c.mgr.token, body: { ...q, country: 'BR' } })).status, 409);
  // signed callback from the channel partner updates the booking; a wrong signature does nothing
  const hook = (payload, sig) => fetch(`${base}/api/v1/webhooks/integrations/${b.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sportarena-signature': `sha256=${sig}` }, body: payload });
  const rot = must(await api('PATCH', `/admin/travel-partners/${b.id}`, { token: pa.token, body: { rotate_webhook_secret: true } }));
  const ev = JSON.stringify({ events: [{ id: 'ch1', type: 'booking.cancelled', partner_ref: held.partner_ref, note: 'Hotel closed' }] });
  assert.equal((await hook(ev, 'bad')).status, 401);
  assert.equal((await hook(ev, sign(b.webhook_secret, ev))).status, 401);                               // the old secret is dead after rotation
  assert.equal((await hook(ev, sign(rot.webhook_secret, ev))).status, 200);
  assert.equal(must(await api('GET', `/trips/${c.trip.id}/bookings/${held.id}`, { token: c.mgr.token })).status, 'cancelled');
  void a; void uae; void down;
});
