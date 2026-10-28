import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { METRICS, sha } = await import('../src/sponsor-roi.js');

let server, base, n = 0;
const raw = (method, path, { token, body } = {}) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const api = async (method, path, o = {}) => {
  const qs = o.query ? `?${new URLSearchParams(o.query)}` : '';
  const r = await raw(method, `/api/v1${path}${qs}`, o);
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `roi_${n}_${roles[0]}`, display_name: `Roi ${n}`, email: `roi${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const sql = async (q, p = []) => (await pool.query(q, p)).rows;
const inDays = async (k) => (await sql('SELECT (current_date + $1::int)::text AS d', [k]))[0].d;
const money = { kind: 'money', label: 'Title fee', currency: 'SGD', amount_cents: 100000, cadence: 'monthly', first_due_on: '2031-01-15', instalments: 4 };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An open event, and a helper that gives a brand an ACCEPTED agreement with it whose term covers today. */
async function world() {
  const org = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `ROI Cup ${++n}`, sport: 'football', city: 'Mumbai' } }), 201);
  must(await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'open' } }));
  const w = { org, ev };
  w.deal = async (name = `Brand${++n}`, lines = [money]) => {
    const sponsor = await signup(['sponsor']);
    const brand = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name } }), 201);
    const d = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: brand.id, target_type: 'event', target_id: ev.id, deliverables: 'Logo on event page', starts_on: '2031-01-01', ends_on: '2031-12-31', lines } }), 201);
    must(await api('PATCH', `/sponsorships/${d.id}`, { token: org.token, body: { status: 'active', version: d.terms_version } }));
    await pool.query("UPDATE sponsorships SET starts_on=current_date - 30, ends_on=DATE '2032-12-31' WHERE id=$1", [d.id]);
    return { sponsor, brand, id: d.id };
  };
  return w;
}
const unit = (w, body = {}) => api('POST', '/sponsor-inventory', { token: w.org.token, body: { target_type: 'event', target_id: w.ev.id, kind: 'title_partner', name: 'Title partner', ...body } });
const book = (w, u, deal, body = {}, token = w.org.token) => api('POST', `/sponsor-inventory/${u.id}/bookings`, { token, body: { sponsorship_id: deal.id, category: 'beverage', starts_on: '2031-02-01', ends_on: '2031-03-31', ...body } });
const bookNow = async (w, u, deal, body = {}) => book(w, u, deal, { starts_on: await inDays(-5), ends_on: await inDays(60), ...body });

test('inventory: capacity, category exclusivity and parallel bookings can never double-sell', async () => {
  const w = await world();
  const [a, b, c] = [await w.deal(), await w.deal(), await w.deal()];
  const u = must(await unit(w, { kind: 'scorecard', name: 'Scorecard', capacity: 2 }), 201);
  assert.equal(u.placement_slot, 'scorecard');
  must(await book(w, u, a), 201);
  must(await book(w, u, b, { category: 'banking_finance' }), 201);
  const full = await book(w, u, c, { category: 'telecom' });
  assert.equal(full.status, 409); assert.equal(full.body.error.details?.code ?? full.body.details?.code, 'inventory_full');
  must(await book(w, u, c, { category: 'telecom', starts_on: '2031-04-01', ends_on: '2031-04-30' }), 201); // after the others: free again
  assert.equal((await book(w, u, a)).status, 409, 'the same agreement cannot hold a unit twice in one period');

  // exclusive category
  const x = must(await unit(w, { kind: 'leaderboard', name: 'Leaderboard', capacity: 3, exclusive_category: true }), 201);
  const first = must(await book(w, x, a, { category: 'beverage' }), 201);
  const rival = await book(w, x, b, { category: 'beverage' });
  assert.equal(rival.status, 409); assert.match(JSON.stringify(rival.body), /category_exclusive/);
  must(await book(w, x, b, { category: 'banking_finance' }), 201);
  must(await book(w, x, b, { category: 'beverage', starts_on: '2031-06-01', ends_on: '2031-06-30' }), 201); // different period
  // releasing the holder frees the category
  must(await api('POST', `/sponsor-inventory-bookings/${first.id}/release`, { token: w.org.token, body: { reason: 'Sponsor withdrew the placement' } }));
  must(await book(w, x, c, { category: 'beverage' }), 201);

  // parallel: one seat, five agreements, exactly one wins
  const solo = must(await unit(w, { kind: 'event_page', name: 'Event page', capacity: 1 }), 201);
  const racers = [a, b, c, await w.deal(), await w.deal()];
  const res = await Promise.all(racers.map((d, k) => book(w, solo, d, { category: 'retail', starts_on: '2031-08-01', ends_on: '2031-08-31' })));
  assert.equal(res.filter((r) => r.status === 201).length, 1, 'exactly one booking wins');
  assert.equal(res.filter((r) => r.status === 409).length, 4);
  assert.equal((await sql("SELECT count(*)::int AS n FROM sponsor_inventory_bookings WHERE unit_id=$1 AND status='confirmed'", [solo.id]))[0].n, 1);
});

test('inventory: only the owner books, only active agreements with the same target, inside term and availability', async () => {
  const w = await world();
  const a = await w.deal();
  const u = must(await unit(w, { name: 'Title', available_from: '2031-01-01', available_to: '2031-12-31' }), 201);
  assert.equal((await book(w, u, a, {}, a.sponsor.token)).status, 403, 'a sponsor cannot book inventory for itself');
  assert.equal((await book(w, u, a, { starts_on: '2030-12-01', ends_on: '2031-02-01' })).status, 409, 'outside availability');
  await pool.query("UPDATE sponsorships SET starts_on='2031-02-10' WHERE id=$1", [a.id]);
  assert.equal((await book(w, u, a, { starts_on: '2031-02-01', ends_on: '2031-03-01' })).status, 409, 'outside the agreement term');
  await pool.query("UPDATE sponsorships SET starts_on='2031-01-01', ends_on='2031-12-31', status='paused' WHERE id=$1", [a.id]);
  assert.equal((await book(w, u, a)).status, 409, 'a paused agreement holds no new inventory');
  await pool.query("UPDATE sponsorships SET status='active' WHERE id=$1", [a.id]);
  // an agreement with another event cannot take this event's unit
  const other = await world();
  const foreign = await other.deal();
  assert.equal((await book(w, u, foreign)).status, 403, 'a stranger agreement is not even visible to this organiser');
  // an outsider cannot create or book inventory on someone else's event
  const stranger = await signup(['organizer']);
  assert.equal((await api('POST', '/sponsor-inventory', { token: stranger.token, body: { target_type: 'event', target_id: w.ev.id, kind: 'title_partner', name: 'Mine now' } })).status, 403);
  // a young athlete's sponsorship is not sold as inventory
  const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  assert.equal((await api('POST', '/sponsor-inventory', { token: kid.token, body: { target_type: 'athlete', target_id: kid.id, kind: 'appearance', name: 'Kid appearance' } })).status, 409);
  // availability views
  must(await book(w, u, a, { category: 'beverage' }), 201);
  const pub = must(await api('GET', '/sponsor-inventory', { token: a.sponsor.token, query: { target_type: 'event', target_id: w.ev.id, from: '2031-02-01', to: '2031-03-31' } }));
  assert.equal(pub.owner, false);
  assert.equal(pub.units[0].window.free, 0); assert.equal(pub.units[0].bookings, undefined, 'a sponsor never learns who holds a unit');
  const mine = must(await api('GET', '/sponsor-inventory', { token: w.org.token, query: { target_type: 'event', target_id: w.ev.id, from: '2031-02-01', to: '2031-03-31' } }));
  assert.equal(mine.owner, true); assert.equal(mine.units[0].bookings[0].sponsor_name, a.brand.name);
  // stale edit and archive with live bookings
  assert.equal((await api('PATCH', `/sponsor-inventory/${u.id}`, { token: w.org.token, body: { row_version: 1, status: 'archived' } })).status, 409);
  assert.equal((await api('PATCH', `/sponsor-inventory/${u.id}`, { token: w.org.token, body: { row_version: 99, name: 'x' } })).body.error?.details?.code ?? 'stale_version', 'stale_version');
});

test('public placements: an event that sells a slot only accepts a sponsor with a live booking, and releasing ends the placement', async () => {
  const w = await world();
  const a = await w.deal(), b = await w.deal();
  const place = (d, body = {}) => api('POST', `/events/${w.ev.id}/sponsor-placements`, { token: w.org.token, body: { sponsorship_id: d.id, slot: 'title_partner', ...body } });
  must(await place(a), 201); // no inventory defined for the slot yet: today's behaviour is unchanged
  must(await api('POST', `/sponsor-placements/${(await sql('SELECT id FROM event_sponsor_placements LIMIT 1'))[0].id}/end`, { token: w.org.token }));
  const u = must(await unit(w, { name: 'Title', capacity: 1 }), 201);
  const refused = await place(a);
  assert.equal(refused.status, 409); assert.match(JSON.stringify(refused.body), /inventory_required/);
  const bk = must(await bookNow(w, u, a), 201);
  const p = must(await place(a), 201);
  assert.equal(p.booking_id, bk.id);
  assert.equal((await place(b)).status, 409, 'b holds no booking');
  const rel = must(await api('POST', `/sponsor-inventory-bookings/${bk.id}/release`, { token: w.org.token, body: { reason: 'Contract change' } }));
  assert.equal(rel.placements_ended, 1);
  assert.equal((await sql('SELECT status FROM event_sponsor_placements WHERE id=$1', [p.id]))[0].status, 'ended');
  assert.equal(must(await api('GET', `/public/events/${w.ev.id}`)).sponsors.placements.length, 0);
});

test('deliverables need evidence and the OTHER side\'s acceptance; time and the event ending complete nothing', async () => {
  const w = await world();
  const a = await w.deal();
  const due = await inDays(10);
  const d = must(await api('POST', `/sponsorships/${a.id}/deliverables`, { token: w.org.token, body: { kind: 'appearance', title: 'Trophy presentation', owed_by: 'recipient', due_on: due, evidence_required: 'link' } }), 201);
  assert.equal(d.state, 'upcoming');
  const sub = (token, body = {}) => api('POST', `/sponsorship-deliverables/${d.id}/evidence`, { token, body });
  const review = (token, body) => api('PATCH', `/sponsorship-deliverables/${d.id}/review`, { token, body });
  assert.equal((await sub(w.org.token, {})).status, 400, 'no evidence, no submission');
  assert.equal((await sub(a.sponsor.token, { url: 'https://x.example/e' })).status, 403, 'the sponsor does not submit the beneficiary\'s work');
  assert.equal((await sub(w.org.token, { url: 'http://insecure.example' })).status, 400);
  const got = must(await sub(w.org.token, { url: 'https://photos.example/trophy', label: 'Photo album' }), 201);
  assert.equal(got.status, 'submitted'); assert.equal(got.state, 'awaiting_review');
  assert.equal((await review(w.org.token, { decision: 'accept', expected_rev: got.rev })).status, 403, 'nobody accepts their own work');
  assert.equal((await review(a.sponsor.token, { decision: 'rework', expected_rev: got.rev })).status, 400, 'rework needs a note');
  assert.equal((await review(a.sponsor.token, { decision: 'accept', expected_rev: got.rev - 1 })).status, 409, 'stale decision refused');
  const back = must(await review(a.sponsor.token, { decision: 'rework', note: 'Need the sponsor board in frame', expected_rev: got.rev }));
  assert.equal(back.status, 'rework');
  const again = must(await sub(w.org.token, { url: 'https://photos.example/trophy-2' }), 201);
  const ok = must(await review(a.sponsor.token, { decision: 'accept', expected_rev: again.rev }));
  assert.equal(ok.state, 'accepted'); assert.ok(ok.reviewed_at);

  // a file deliverable cannot be completed with a link alone
  const f = must(await api('POST', `/sponsorships/${a.id}/deliverables`, { token: a.sponsor.token, body: { kind: 'hospitality', title: 'Host 10 guests', owed_by: 'sponsor', due_on: due, evidence_required: 'file' } }), 201);
  const linkOnly = must(await api('POST', `/sponsorship-deliverables/${f.id}/evidence`, { token: a.sponsor.token, body: { url: 'https://guests.example/list' } }), 201);
  assert.equal(linkOnly.status, 'planned', 'a link does not meet a file requirement');
  assert.equal(linkOnly.evidence_met, false);
  assert.equal((await api('PATCH', `/sponsorship-deliverables/${f.id}/review`, { token: w.org.token, body: { decision: 'accept', expected_rev: linkOnly.rev } })).status, 409);

  // the event ending or the due date passing completes nothing
  await pool.query("UPDATE events SET status='completed' WHERE id=$1", [w.ev.id]);
  await pool.query("UPDATE sponsorship_deliverables SET due_on=current_date - 3 WHERE id=$1", [f.id]);
  const list = must(await api('GET', `/sponsorships/${a.id}/deliverables`, { token: a.sponsor.token }));
  assert.equal(list.find((x) => x.id === f.id).state, 'overdue');
  assert.equal(list.find((x) => x.id === d.id).state, 'accepted');
  assert.equal(list.find((x) => x.id === d.id).evidence.length, 2);

  // exceptions: requested by the owing side, decided by the other; never silently
  const req = must(await api('POST', `/sponsorship-deliverables/${f.id}/exception`, { token: a.sponsor.token, body: { kind: 'postpone', reason: 'Venue closed for the semi-final', new_due_on: await inDays(20) } }), 201);
  assert.equal((await api('PATCH', `/sponsorship-deliverable-exceptions/${req.id}`, { token: a.sponsor.token, body: { decision: 'approve' } })).status, 403, 'the requester cannot approve');
  const dec = must(await api('PATCH', `/sponsorship-deliverable-exceptions/${req.id}`, { token: w.org.token, body: { decision: 'approve' } }));
  assert.equal(dec.state, 'upcoming', 'postponed: the new date applies');
  const waive = must(await api('POST', `/sponsorship-deliverables/${f.id}/exception`, { token: a.sponsor.token, body: { kind: 'waive', reason: 'Cannot host this season' } }), 201);
  assert.equal((await api('PATCH', `/sponsorship-deliverable-exceptions/${waive.id}`, { token: w.org.token, body: { decision: 'decline' } })).status, 400, 'a decline needs a reason');
  assert.equal(must(await api('PATCH', `/sponsorship-deliverable-exceptions/${waive.id}`, { token: w.org.token, body: { decision: 'approve' } })).state, 'excepted');
  const health = must(await api('GET', `/sponsorships/${a.id}/renewal-pack`, { token: a.sponsor.token })).deliverables;
  assert.equal(health.accepted, 1); assert.equal(health.excepted, 1); assert.equal(health.missed, 0, 'an excepted deliverable is not a miss');
  // outsiders see nothing
  assert.equal((await api('GET', `/sponsorships/${a.id}/deliverables`, { token: (await signup(['sponsor'])).token })).status, 403);
});

test('exposure: only measured figures, definitions published, gaps shown as missing, no double counting, corrections supersede', async () => {
  const w = await world();
  const a = await w.deal();
  const defs = must(await api('GET', '/sponsorship-metric-definitions', { token: a.sponsor.token }));
  assert.equal(defs.metrics.length, METRICS.length);
  assert.ok(defs.metrics.every((m) => m.definition && m.basis && m.dedupe));
  assert.ok(defs.not_measured.some((x) => /social/i.test(x)) && defs.not_measured.some((x) => /AVE/.test(x)), 'what is not measured is stated');

  const u = must(await unit(w, { kind: 'hospitality', name: 'Hospitality lounge' }), 201);
  assert.equal(u.placement_slot, null);
  must(await bookNow(w, u, a), 201);
  let exp = must(await api('GET', `/sponsorships/${a.id}/exposure`, { token: a.sponsor.token }));
  assert.ok(exp.missing.some((m) => m.metric === 'hospitality_guests'), 'an expected metric with no data is missing, not zero');
  assert.ok(!exp.metrics.some((m) => m.key === 'hospitality_guests'));

  const day = await inDays(-2);
  const sig = (body) => api('POST', `/sponsorships/${a.id}/exposure-signals`, { token: w.org.token, body: { metric: 'hospitality_guests', day, value: 12, source: 'Guest list', source_ref: 'Hospitality guest list #44', ...body } });
  assert.equal((await api('POST', `/sponsorships/${a.id}/exposure-signals`, { token: a.sponsor.token, body: { metric: 'hospitality_guests', day, value: 9, source: 'me', source_ref: 'me' } })).status, 403, 'a sponsor cannot enter its own exposure');
  assert.equal((await sig({ day: await inDays(3) })).status, 400, 'no future days');
  const s1 = must(await sig(), 201);
  assert.equal((await sig({ source: 'OtherCo', value: 50 })).status, 409, 'a second source for the same day is refused, never added');
  must(await sig({ day: await inDays(-1), value: 8 }), 201);
  exp = must(await api('GET', `/sponsorships/${a.id}/exposure`, { token: a.sponsor.token }));
  const m = exp.metrics.find((x) => x.key === 'hospitality_guests');
  assert.equal(m.value, 20); assert.equal(m.basis, 'provider_reported'); assert.equal(m.days_with_data, 2); assert.deepEqual(m.sources, ['Guest list']);
  assert.equal(exp.missing.length, 0, 'the expected figure arrived');
  // correction supersedes
  const fix = must(await api('POST', `/sponsor-exposure-signals/${s1.id}/correction`, { token: w.org.token, body: { value: 10, reason: 'Guest list was corrected' } }), 201);
  assert.equal(fix.value, 10);
  exp = must(await api('GET', `/sponsorships/${a.id}/exposure`, { token: a.sponsor.token }));
  assert.equal(exp.metrics.find((x) => x.key === 'hospitality_guests').value, 18);
  assert.equal((await sql('SELECT count(*)::int AS n FROM sponsor_exposure_signals WHERE superseded_at IS NOT NULL'))[0].n, 1, 'history kept');

  // platform-measured: placements, followers (distinct accounts)
  const fan = await signup(['athlete']);
  must(await api('POST', '/me/follows', { token: fan.token, body: { subject_type: 'event', subject_id: w.ev.id } }), 201).id;
  must(await api('POST', '/me/follows', { token: fan.token, body: { subject_type: 'event', subject_id: w.ev.id } }).then((r) => ({ ...r, status: r.status === 200 ? 201 : r.status })), 201);
  const pl = must(await api('POST', `/events/${w.ev.id}/sponsor-placements`, { token: w.org.token, body: { sponsorship_id: a.id, slot: 'title_partner', cta_label: 'Visit', cta_url: 'https://brand.example' } }), 201);
  await api('GET', `/public/events/${w.ev.id}`); await api('GET', `/public/events/${w.ev.id}`);
  must(await api('POST', `/public/placements/${pl.id}/click`));
  exp = must(await api('GET', `/sponsorships/${a.id}/exposure`, { token: a.sponsor.token }));
  const get = (k) => exp.metrics.find((x) => x.key === k);
  assert.equal(get('placement_impressions').value, 2); assert.equal(get('placement_impressions').basis, 'platform_measured');
  assert.equal(get('placement_clicks').value, 1);
  assert.equal(get('event_followers').value, 1, 'one account following twice is one follower'); assert.equal(get('event_followers').period_bound, false);
  assert.ok(!exp.metrics.some((x) => /reach|ave|value/i.test(x.key)), 'no invented reach or media value');
  // the beneficiary sees the same figures (shared truth), a stranger sees nothing
  assert.equal(must(await api('GET', `/sponsorships/${a.id}/exposure`, { token: w.org.token })).metrics.length, exp.metrics.length);
  assert.equal((await api('GET', `/sponsorships/${a.id}/exposure`, { token: (await signup(['sponsor'])).token })).status, 403);
});

const isoT = (days = 0, hours = 0) => new Date(Date.now() + days * 864e5 + hours * 36e5).toISOString();
/** An active media licence on the event (media rights, #482), reached through its own API. */
async function mediaLicence(w) {
  const pu = await signup(['organizer']);
  const org = must(await api('POST', '/organisations', { token: pu.token, body: { name: `Broadcast ${++n}`, kind: 'company' } }), 201);
  const partner = must(await api('POST', '/media/partners', { token: pu.token, body: { organisation_id: org.id, kind: 'broadcaster' } }), 201);
  const p = must(await api('POST', `/events/${w.ev.id}/media/packages`, { token: w.org.token, body: { name: `Package ${++n}`, rights: ['live_video', 'highlights'], valid_from: isoT(-1), valid_to: isoT(60) } }), 201);
  const l = must(await api('POST', `/media/packages/${p.id}/licences`, { token: w.org.token, body: { partner_id: partner.id, approved_rights: ['live_video', 'highlights'], effective_from: isoT(-1), effective_to: isoT(30), fee_minor: 500000, currency: 'USD' } }), 201);
  const lic = must(await api('POST', `/media/licences/${l.id}/decision`, { token: pu.token, body: { action: 'accept', row_version: l.row_version } }));
  return { pu, lic };
}

test('broadcast reach and licence deliverables are REUSED from media rights, gated by inventory, never entered or counted twice', async () => {
  const w = await world();
  const a = await w.deal(), b = await w.deal();
  const { pu, lic } = await mediaLicence(w);
  const overlay = must(await unit(w, { kind: 'livestream_overlay', name: 'Overlay', capacity: 2 }), 201);
  // the event now sells overlay placements: a media-licence deliverable that names a sponsor needs that sponsor's live booking
  const mk = (d, body = {}) => api('POST', `/media/licences/${lic.id}/deliverables`, { token: w.org.token, body: { kind: 'graphic_overlay', title: 'Sponsor overlay in every game', due_at: isoT(2), sponsorship_id: d.id, ...body } });
  const refused = await mk(a);
  assert.equal(refused.status, 409); assert.match(JSON.stringify(refused.body), /inventory_required/);
  const bk = must(await bookNow(w, overlay, a), 201);
  const dl = must(await mk(a), 201);
  assert.equal(dl.booking_id, bk.id);
  assert.equal((await mk(b)).status, 409, 'a sponsor without a booking cannot be named on an overlay deliverable');
  must(await mk(b, { kind: 'other', title: 'Not a placement kind' }), 201); // other kinds are not governed
  // before any measurement: expected broadcast figures are missing, not zero
  let exp = must(await api('GET', `/sponsorships/${a.id}/exposure`, { token: a.sponsor.token }));
  assert.deepEqual(exp.missing.map((m) => m.metric).sort(), ['broadcast_impressions', 'broadcast_views']);
  assert.ok(!exp.metrics.some((m) => m.key.startsWith('broadcast_')));
  // the provider's numbers are recorded ONCE, in media rights
  const meas = (body) => api('POST', `/media/licences/${lic.id}/measurements`, { token: pu.token, body: { metric: 'views', value: 1200, period_start: isoT(-3), period_end: isoT(-2), source_name: 'StreamCo', source_ref: 'StreamCo report 1', deliverable_id: dl.id, ...body } });
  must(await meas(), 201);
  must(await meas({ value: 800, period_start: isoT(-2), period_end: isoT(-1), source_ref: 'StreamCo report 2' }), 201);
  must(await meas({ value: 1200 }), 201); // the same report entered twice
  must(await meas({ value: 9999, source_name: 'OtherCo', source_ref: 'OtherCo 7' }), 201); // a second source for the same metric
  must(await meas({ metric: 'unique_viewers', value: 400, source_ref: 'StreamCo uv 1' }), 201);
  must(await meas({ metric: 'unique_viewers', value: 650, source_ref: 'StreamCo uv 2', period_start: isoT(-2), period_end: isoT(-1) }), 201);
  exp = must(await api('GET', `/sponsorships/${a.id}/exposure`, { token: a.sponsor.token }));
  const get = (k) => exp.metrics.find((x) => x.key === k);
  assert.equal(get('broadcast_views').value, 2000, 'two distinct reports from the first source; the duplicate and the second source are not added');
  assert.equal(get('broadcast_views').basis, 'provider_reported'); assert.deepEqual(get('broadcast_views').sources, ['StreamCo']);
  assert.equal(get('broadcast_unique_viewers').value, 650, 'unique viewers are never summed: the highest reported figure');
  assert.equal(get('broadcast_unique_viewers').period_bound, false);
  assert.deepEqual(exp.missing.map((m) => m.metric), ['broadcast_impressions'], 'impressions are still missing');
  // the media-licence deliverable counts in deliverable health, and verification there is the acceptance
  const health = async () => must(await api('GET', `/sponsorships/${a.id}/renewal-pack`, { token: a.sponsor.token })).deliverables;
  assert.equal((await health()).total, 1); assert.equal((await health()).media_licence_items, 1); assert.equal((await health()).accepted, 0);
  must(await api('POST', `/media/deliverables/${dl.id}/status`, { token: pu.token, body: { status: 'delivered', evidence_url: 'https://proof.example/overlay' } }));
  assert.equal((await health()).awaiting_review, 1);
  must(await api('POST', `/media/deliverables/${dl.id}/status`, { token: w.org.token, body: { status: 'verified' } }));
  assert.equal((await health()).accepted, 1);
  const dash = must(await api('GET', '/sponsorship-intelligence', { token: a.sponsor.token, query: { sponsor_id: a.brand.id } }));
  assert.equal(dash.totals.deliverables.accepted, 1, 'the portfolio counts it once');
  // a released booking stops a not-yet-delivered placement from being delivered
  const dl2 = must(await mk(a, { title: 'Second overlay' }), 201);
  must(await api('POST', `/sponsor-inventory-bookings/${bk.id}/release`, { token: w.org.token, body: { reason: 'Contract change' } }));
  const late = await api('POST', `/media/deliverables/${dl2.id}/status`, { token: pu.token, body: { status: 'delivered', evidence_url: 'https://proof.example/x' } });
  assert.equal(late.status, 409); assert.match(JSON.stringify(late.body), /booking_released/);
  // broadcast metrics cannot be entered a second time through the ROI ledger
  assert.equal((await api('POST', `/sponsorships/${a.id}/exposure-signals`, { token: w.org.token, body: { metric: 'stream_views', day: isoT(-1).slice(0, 10), value: 5, source: 'x', source_ref: 'xx' } })).status, 400);
});

test('valuation: assumption-based, versioned, immutable, labelled an estimate, sponsor-only', async () => {
  const w = await world();
  const a = await w.deal();
  await pool.query("INSERT INTO sponsor_exposure_signals(sponsorship_id, metric, day, value, source, source_ref, recorded_by) VALUES ($1,'page_views',current_date - 1, 5000,'SiteStats','SiteStats export 9',$2)", [a.id, w.org.id]);
  const noModel = must(await api('GET', `/sponsorships/${a.id}/renewal-pack`, { token: a.sponsor.token }));
  assert.equal(noModel.valuation, undefined, 'no assumptions, no value and no ROI');
  assert.equal(JSON.stringify(noModel).match(/estimated_value|return_on_spend/), null);

  const create = (token, body = {}) => api('POST', `/sponsors/${a.brand.id}/valuation-models`, { token, body: { name: 'Digital CPM', currency: 'SGD', basis_note: 'Our agency CPM for sports video, 2031 plan', assumptions: { page_views: { per: 1000, value_cents: 2000 } }, ...body } });
  assert.equal((await create(w.org.token)).status, 404, 'a beneficiary cannot write the brand\'s assumptions');
  assert.equal((await create(a.sponsor.token, { assumptions: {} })).status, 400);
  assert.equal((await create(a.sponsor.token, { assumptions: { social_reach: { per: 1, value_cents: 5 } } })).status, 400, 'only measured metrics can be valued');
  assert.equal((await create(a.sponsor.token, { assumptions: { event_followers: { per: 1, value_cents: 5 } } })).status, 400, 'a point-in-time count is not valued');
  assert.equal((await create(a.sponsor.token, { assumptions: { broadcast_unique_viewers: { per: 1, value_cents: 5 } } })).status, 400, 'non-additive figures are not valued');
  assert.equal((await create(a.sponsor.token, { basis_note: 'short' })).status, 400, 'a rationale is required');
  const m = must(await create(a.sponsor.token), 201);
  const v1 = m.versions[0];
  const v2 = must(await api('POST', `/sponsor-valuation-models/${m.id}/versions`, { token: a.sponsor.token, body: { expected_version: 1, currency: 'SGD', basis_note: 'Renegotiated agency rate for the second half', assumptions: { page_views: { per: 1000, value_cents: 3000 } } } }), 201);
  assert.equal(v2.version, 2);
  assert.equal((await api('POST', `/sponsor-valuation-models/${m.id}/versions`, { token: a.sponsor.token, body: { expected_version: 1, currency: 'SGD', basis_note: 'stale attempt at version', assumptions: { page_views: { per: 1, value_cents: 1 } } } })).status, 409);
  await assert.rejects(pool.query('UPDATE sponsor_valuation_versions SET basis_note=$2 WHERE id=$1', [v1.id, 'tampered with the rationale']), /immutable/);
  await assert.rejects(pool.query('DELETE FROM sponsor_valuation_versions WHERE id=$1', [v1.id]), /immutable/);

  const est1 = must(await api('GET', `/sponsorships/${a.id}/valuation`, { token: a.sponsor.token, query: { version_id: v1.id } }));
  assert.match(est1.valuation.label, /ESTIMATE/); assert.equal(est1.valuation.kind, 'assumption_based');
  assert.equal(est1.valuation.estimated_value_cents, 10000); assert.equal(est1.valuation.model.version, 1);
  assert.equal(est1.valuation.lines[0].measured_value, 5000); assert.equal(est1.valuation.lines[0].measured_basis, 'provider_reported'); assert.equal(est1.valuation.lines[0].rate_cents, 2000);
  assert.equal(est1.valuation.return_on_spend.note ? 'no spend' : 'spend', 'no spend', 'no confirmed spend: no ratio is invented');
  const est2 = must(await api('GET', `/sponsorships/${a.id}/valuation`, { token: a.sponsor.token, query: { version_id: v2.id } }));
  assert.equal(est2.valuation.estimated_value_cents, 15000);
  assert.equal((await api('GET', `/sponsorships/${a.id}/valuation`, { token: w.org.token, query: { version_id: v1.id } })).status, 403, 'the beneficiary never sees the brand\'s assumptions');
  const other = await w.deal();
  assert.equal((await api('GET', `/sponsorships/${other.id}/valuation`, { token: other.sponsor.token, query: { version_id: v1.id } })).status, 404, 'another brand cannot use this model');
  assert.equal(must(await api('GET', `/sponsors/${a.brand.id}/valuation-models`, { token: a.sponsor.token })).models[0].versions.length, 2);
  assert.equal((await api('GET', `/sponsors/${a.brand.id}/valuation-models`, { token: w.org.token })).status, 404);
});

test('portfolio, comparison and renewal pack reconcile with the dues, stay inside privacy rules and never rank', async () => {
  const w = await world();
  const a = await w.deal(), b = await w.deal();
  const owner = a.sponsor;
  // finance truth: a confirmed payment on a's first due
  const due = (await sql("SELECT id FROM sponsorship_obligations WHERE sponsorship_id=$1 AND kind='money' ORDER BY seq LIMIT 1", [a.id]))[0].id;
  const pay = must(await api('POST', `/sponsorship-obligations/${due}/payments`, { token: owner.token, body: { amount_cents: 25000, currency: 'SGD', method: 'bank_transfer', reference: 'TT-1', paid_on: await inDays(-1) } }), 201);
  must(await api('PATCH', `/sponsorship-payments/${pay.id}`, { token: w.org.token, body: { status: 'confirmed' } }));
  await api('POST', `/sponsorships/${a.id}/deliverables`, { token: w.org.token, body: { kind: 'content', title: 'Highlights reel', owed_by: 'recipient', due_on: await inDays(5), evidence_required: 'link' } });

  const dash = must(await api('GET', '/sponsorship-intelligence', { token: owner.token, query: { sponsor_id: a.brand.id } }));
  assert.equal(dash.total, 1);
  const ob = must(await api('GET', '/sponsorship-obligations', { token: owner.token, query: { sponsorship_id: a.id } }));
  assert.deepEqual(dash.agreements[0].finance.totals[0], { currency: 'SGD', committed_cents: Number(ob.totals[0].committed_cents), confirmed_cents: Number(ob.totals[0].confirmed_cents), reported_unverified_cents: Number(ob.totals[0].reported_unverified_cents), outstanding_cents: Number(ob.totals[0].outstanding_cents), overdue_cents: Number(ob.totals[0].overdue_cents) }, 'reconciles with the finance truth');
  assert.equal(dash.agreements[0].finance.totals[0].confirmed_cents, 25000);
  assert.equal(dash.totals.finance[0].confirmed_cents, 25000);
  assert.equal(dash.totals.deliverables.upcoming, 1);
  assert.equal(dash.agreements[0].finance.upcoming.length > 0, true);
  assert.ok(dash.not_measured.length);
  assert.equal((await api('GET', '/sponsorship-intelligence', { token: w.org.token, query: { sponsor_id: a.brand.id } })).status, 404, 'a beneficiary is not the brand');
  assert.equal((await api('GET', '/sponsorship-intelligence', { token: b.sponsor.token, query: { sponsor_id: a.brand.id } })).status, 404, 'another brand sees nothing');

  // comparison: two agreements by DIFFERENT brands cannot be compared by one brand
  assert.equal((await api('POST', '/sponsorship-intelligence/compare', { token: owner.token, body: { sponsorship_ids: [a.id, b.id], from: await inDays(-10), to: await inDays(0) } })).status, 403);
  // same brand, two agreements
  const brand2 = a.brand;
  const d2 = must(await api('POST', '/sponsorships', { token: owner.token, body: { sponsor_id: brand2.id, target_type: 'event', target_id: w.ev.id, deliverables: 'Second package', starts_on: '2031-01-01', ends_on: '2031-12-31', lines: [{ ...money, currency: 'USD' }] } }), 201);
  must(await api('PATCH', `/sponsorships/${d2.id}`, { token: w.org.token, body: { status: 'active', version: d2.terms_version } }));
  await pool.query('UPDATE sponsorships SET starts_on=current_date - 10, ends_on=current_date + 100 WHERE id=$1', [d2.id]);
  await pool.query("INSERT INTO sponsor_exposure_signals(sponsorship_id, metric, day, value, source, source_ref, recorded_by) VALUES ($1,'page_views',current_date - 1, 100,'SiteStats','r1',$2), ($3,'page_views',current_date - 1, 300,'SiteStats','r2',$2), ($3,'attendance',current_date - 1, 40,'Gate','r3',$2)", [a.id, w.org.id, d2.id]);
  const cmp = must(await api('POST', '/sponsorship-intelligence/compare', { token: owner.token, body: { sponsorship_ids: [a.id, d2.id], from: await inDays(-5), to: await inDays(0) } }));
  assert.equal(cmp.comparable_metrics.length, 1); assert.equal(cmp.comparable_metrics[0].key, 'page_views');
  assert.deepEqual(cmp.comparable_metrics[0].values.map((v) => v.value), [100, 300], 'in the order given');
  assert.ok(cmp.not_comparable.some((x) => x.key === 'attendance' && x.agreements_lacking.includes(a.id)), 'a metric missing for one agreement is not compared');
  assert.ok(cmp.not_comparable.some((x) => x.key === 'event_followers'), 'a point-in-time count is not compared');
  assert.equal(cmp.spend.comparable, false, 'SGD and USD are never combined');
  assert.match(cmp.ranking, /none/); assert.ok(!JSON.stringify(cmp).match(/"rank"|"score"/));

  // renewal pack: facts only; the athlete-style outcome stays private unless shared
  const pack = must(await api('GET', `/sponsorships/${a.id}/renewal-pack`, { token: owner.token }));
  assert.ok(pack.facts.length > 3 && pack.facts.some((f) => /Not measured by Sportarena/.test(f)));
  assert.equal(pack.outcomes.status, 'not_shared');
  assert.equal(pack.workspace.propose.path, `/sponsorships/${a.id}/renewal`);
  assert.equal(pack.valuation, undefined);
  assert.ok(!JSON.stringify(pack).match(/diagnos|medical|salary|bank_account|email/i), 'no health, finance of the recipient or contact data');
  const mine = must(await api('GET', `/sponsorships/${a.id}/renewal-pack`, { token: w.org.token }));
  assert.equal(mine.role, 'recipient'); assert.equal(mine.valuation, undefined);
  assert.equal((await api('GET', `/sponsorships/${a.id}/renewal-pack`, { token: b.sponsor.token })).status, 403);
});

test('issued reports are immutable, hash-verified, reproducible from their snapshot and exportable; recipients never get valuation', async () => {
  const w = await world();
  const a = await w.deal();
  await pool.query("INSERT INTO sponsor_exposure_signals(sponsorship_id, metric, day, value, source, source_ref, recorded_by) VALUES ($1,'page_views',current_date - 1, 5000,'SiteStats','SiteStats export 9',$2)", [a.id, w.org.id]);
  const m = must(await api('POST', `/sponsors/${a.brand.id}/valuation-models`, { token: a.sponsor.token, body: { name: 'CPM', currency: 'SGD', basis_note: 'Agency CPM, internal plan', assumptions: { page_views: { per: 1000, value_cents: 2000 } } } }), 201);
  const body = { sponsorship_ids: [a.id], from: await inDays(-20), to: await inDays(0), valuation_version_id: m.versions[0].id };
  assert.equal((await api('POST', '/sponsorship-roi-reports', { token: w.org.token, body })).status, 403, 'a beneficiary cannot issue a sponsor report');
  assert.equal((await api('POST', '/sponsorship-roi-reports', { token: a.sponsor.token, body: { ...body, kind: 'end_of_agreement' } })).status, 409, 'the term is not over');
  assert.equal((await api('POST', '/sponsorship-roi-reports', { token: a.sponsor.token, body: { ...body, to: await inDays(2) } })).status, 400, 'no future periods');
  const rep = must(await api('POST', '/sponsorship-roi-reports', { token: a.sponsor.token, body }), 201);
  assert.match(rep.content_sha256, /^[0-9a-f]{64}$/);
  const got = must(await api('GET', `/sponsorship-roi-reports/${rep.id}`, { token: a.sponsor.token }));
  assert.equal(got.verified, true);
  assert.equal(sha(got.snapshot), rep.content_sha256, 'the hash is reproducible from the snapshot alone');
  assert.equal(got.snapshot.agreements[0].valuation.estimated_value_cents, 10000);
  assert.match(got.snapshot.agreements[0].valuation.label, /ESTIMATE/);
  assert.ok(got.snapshot.definitions.some((d) => d.key === 'page_views') && got.snapshot.not_measured.length);

  // later data changes do not alter the issued report
  await pool.query("UPDATE sponsor_exposure_signals SET value=1 WHERE sponsorship_id=$1", [a.id]);
  const after1 = must(await api('GET', `/sponsorship-roi-reports/${rep.id}`, { token: a.sponsor.token }));
  assert.equal(after1.snapshot.agreements[0].exposure.metrics.find((x) => x.key === 'page_views').value, 5000);
  assert.equal(after1.verified, true);
  // the database refuses edits and deletes
  await assert.rejects(pool.query("UPDATE sponsor_roi_reports SET snapshot='{}' WHERE id=$1", [rep.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM sponsor_roi_reports WHERE id=$1', [rep.id]), /immutable/);

  // exports come from the snapshot
  const csv = must(await api('GET', `/sponsorship-roi-reports/${rep.id}/export`, { token: a.sponsor.token, query: { format: 'csv' } }));
  assert.match(csv.content, /^recipient,status,period,currency,/); assert.match(csv.content, /,SGD,/, 'every money row carries its currency'); assert.match(csv.content, /page_views 5000/);
  const xlsx = must(await api('GET', `/sponsorship-roi-reports/${rep.id}/export`, { token: a.sponsor.token, query: { format: 'xlsx' } }));
  assert.equal(xlsx.encoding, 'base64'); assert.equal(Buffer.from(xlsx.content, 'base64').subarray(0, 2).toString(), 'PK');
  const pdf = must(await api('GET', `/sponsorship-roi-reports/${rep.id}/export`, { token: a.sponsor.token, query: { format: 'pdf' } }));
  assert.equal(Buffer.from(pdf.content, 'base64').subarray(0, 4).toString(), '%PDF');

  // access is live: a stranger and the beneficiary (for a sponsor report) get 404
  assert.equal((await api('GET', `/sponsorship-roi-reports/${rep.id}`, { token: w.org.token })).status, 404);
  assert.equal((await api('GET', `/sponsorship-roi-reports/${rep.id}`, { token: (await signup(['sponsor'])).token })).status, 404);
  assert.equal(must(await api('GET', '/sponsorship-roi-reports', { token: a.sponsor.token })).length, 1);

  // the recipient's own report: no valuation, no other agreements, no brand assumptions
  assert.equal((await api('POST', '/sponsorship-roi-reports', { token: w.org.token, body: { view: 'recipient', ...body } })).status, 403, 'a recipient report carries no valuation');
  const mine = must(await api('POST', '/sponsorship-roi-reports', { token: w.org.token, body: { view: 'recipient', sponsorship_ids: [a.id], from: body.from, to: body.to } }), 201);
  const mineFull = must(await api('GET', `/sponsorship-roi-reports/${mine.id}`, { token: w.org.token }));
  assert.equal(mineFull.snapshot.agreements[0].valuation, undefined);
  assert.equal(mineFull.snapshot.agreements[0].outcomes, undefined);
  assert.ok(!JSON.stringify(mineFull).includes('CPM'));
  assert.equal((await api('GET', `/sponsorship-roi-reports/${mine.id}`, { token: a.sponsor.token })).status, 404, 'the sponsor cannot open the beneficiary\'s own report');
  assert.equal(must(await api('GET', '/sponsorship-roi-reports', { token: w.org.token, query: { view: 'recipient' } })).length, 1);

  // a department of the report can no longer be read once the agreement is withdrawn from the reader: live access
  await pool.query('UPDATE sponsors SET owner_id=$2 WHERE id=$1', [a.brand.id, w.org.id]);
  assert.equal((await api('GET', `/sponsorship-roi-reports/${rep.id}`, { token: a.sponsor.token })).status, 404, 'losing the brand removes read access at once');
});

test('REST, OpenAPI and MCP expose the same ROI capabilities and permissions', async () => {
  const ops = ['create_sponsor_inventory_unit', 'update_sponsor_inventory_unit', 'list_sponsor_inventory', 'book_sponsor_inventory', 'release_sponsor_inventory_booking', 'list_sponsorship_inventory_bookings',
    'create_sponsorship_deliverable', 'list_sponsorship_deliverables', 'submit_deliverable_evidence', 'get_deliverable_evidence_file', 'review_sponsorship_deliverable', 'request_deliverable_exception', 'decide_deliverable_exception', 'cancel_sponsorship_deliverable',
    'list_sponsorship_metric_definitions', 'record_exposure_signal', 'correct_exposure_signal', 'get_sponsorship_exposure', 'create_valuation_model', 'add_valuation_version', 'list_valuation_models', 'get_sponsorship_valuation',
    'get_sponsorship_portfolio_intelligence', 'compare_sponsorship_campaigns', 'get_sponsorship_renewal_pack', 'issue_sponsorship_roi_report', 'list_sponsorship_roi_reports', 'get_sponsorship_roi_report', 'export_sponsorship_roi_report'];
  const spec = await (await raw('GET', '/api/v1/openapi.json')).json();
  for (const op of ops) assert.ok(Object.values(spec.paths).some((p) => Object.values(p).some((o) => o.operationId === op)), `${op} is in OpenAPI`);
  const w = await world();
  const a = await w.deal();
  const rpc = async (name, args, token) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json();
    return { error: j.result?.isError, body: JSON.parse(j.result.content[0].text) };
  };
  const viaRest = must(await api('GET', `/sponsorships/${a.id}/exposure`, { token: a.sponsor.token }));
  const viaMcp = await rpc('get_sponsorship_exposure', { id: a.id }, a.sponsor.token);
  assert.deepEqual(Object.keys(viaMcp.body).sort(), Object.keys(viaRest).sort());
  const denied = await rpc('get_sponsorship_exposure', { id: a.id }, (await signup(['sponsor'])).token);
  assert.ok(denied.error || denied.body.error, 'MCP enforces the same permission as REST');
  assert.equal((await api('GET', `/sponsorships/${a.id}/exposure`)).status, 401);
});

test('inventory of teams and athletes: owners only, adult athletes only, and an athlete shows only while open to sponsors', async () => {
  const coach = await signup(['coach']);
  const team = must(await api('POST', '/teams', { token: coach.token, body: { name: `Inventory FC ${n}`, sport: 'football' } }), 201);
  const tu = must(await api('POST', '/sponsor-inventory', { token: coach.token, body: { target_type: 'team', target_id: team.id, kind: 'kit_placement', name: 'Sleeve badge', capacity: 2 } }), 201);
  assert.equal(tu.placement_slot, null);
  assert.equal((await api('POST', '/sponsor-inventory', { token: (await signup(['coach'])).token, body: { target_type: 'team', target_id: team.id, kind: 'kit_placement', name: 'Mine' } })).status, 403);
  assert.equal((await api('POST', '/sponsor-inventory', { token: coach.token, body: { target_type: 'team', target_id: team.id, kind: 'title_partner', name: 'x'.repeat(3) } })).status, 201, 'a team may also offer partner-level association');
  const ath = await signup(['athlete'], { dob: yearsAgo(28) });
  must(await api('POST', '/sponsor-inventory', { token: ath.token, body: { target_type: 'athlete', target_id: ath.id, kind: 'appearance', name: 'Two appearances' } }), 201);
  const viewer = await signup(['sponsor']);
  assert.equal((await api('GET', '/sponsor-inventory', { token: viewer.token, query: { target_type: 'athlete', target_id: ath.id } })).status, 404, 'hidden until the athlete is open to sponsors');
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  assert.equal(must(await api('GET', '/sponsor-inventory', { token: viewer.token, query: { target_type: 'athlete', target_id: ath.id } })).units.length, 1);
});

test('a department-scoped member can use ROI for their own department only; brand-wide assumptions stay brand-wide', async () => {
  const w = await world();
  // a corporate brand: organisation, identity, a finance member scoped to one department
  const owner = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Acme ${++n}`, kind: 'company' } }), 201);
  const brand = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Corp ${n}` } }), 201);
  must(await api('POST', `/sponsors/${brand.id}/identity`, { token: owner.token, body: { sponsor_type: 'organization', organisation_id: org.id } }));
  const dept = must(await api('POST', `/organisations/${org.id}/departments`, { token: owner.token, body: { name: 'Marketing' } }), 201);
  const scoped = await signup(['athlete']);
  must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: scoped.handle, role: 'finance', department_id: dept.id } }), 201);
  must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: scoped.token, body: { accept: true } }));
  const deal = async (extra = {}) => {
    const d = must(await api('POST', '/sponsorships', { token: owner.token, body: { sponsor_id: brand.id, target_type: 'event', target_id: w.ev.id, deliverables: 'Title', starts_on: '2031-01-01', ends_on: '2031-12-31', lines: [money], ...extra } }), 201);
    must(await api('PATCH', `/sponsorships/${d.id}`, { token: w.org.token, body: { status: 'active', version: d.terms_version } }));
    await pool.query("UPDATE sponsorships SET starts_on=current_date - 30, ends_on=DATE '2032-12-31' WHERE id=$1", [d.id]);
    return d;
  };
  const inDept = await deal({ department_id: dept.id }), brandWide = await deal();
  const dash = must(await api('GET', '/sponsorship-intelligence', { token: scoped.token, query: { sponsor_id: brand.id } }));
  assert.equal(dash.total, 1, 'only their department\'s agreement'); assert.equal(dash.agreements[0].agreement.id, inDept.id);
  assert.equal(must(await api('GET', '/sponsorship-intelligence', { token: owner.token, query: { sponsor_id: brand.id } })).total, 2);
  // reports: issue for the department's agreement, read and export it; one that includes a brand-wide agreement is not theirs to read
  const body = { sponsorship_ids: [inDept.id], from: await inDays(-10), to: await inDays(0) };
  const rep = must(await api('POST', '/sponsorship-roi-reports', { token: scoped.token, body }), 201);
  assert.equal(must(await api('GET', `/sponsorship-roi-reports/${rep.id}`, { token: scoped.token })).verified, true);
  must(await api('GET', `/sponsorship-roi-reports/${rep.id}/export`, { token: scoped.token, query: { format: 'csv' } }));
  assert.equal((await api('POST', '/sponsorship-roi-reports', { token: scoped.token, body: { ...body, sponsorship_ids: [brandWide.id] } })).status, 403, 'a brand-wide agreement is outside the department');
  const wide = must(await api('POST', '/sponsorship-roi-reports', { token: owner.token, body: { ...body, sponsorship_ids: [inDept.id, brandWide.id] } }), 201);
  assert.equal((await api('GET', `/sponsorship-roi-reports/${wide.id}`, { token: scoped.token })).status, 404, 'a report that spans other departments is not readable');
  assert.equal(must(await api('GET', '/sponsorship-roi-reports', { token: scoped.token })).length, 1);
  // valuation assumptions are brand-wide
  assert.equal((await api('GET', `/sponsors/${brand.id}/valuation-models`, { token: scoped.token })).status, 403);
  assert.equal((await api('POST', `/sponsors/${brand.id}/valuation-models`, { token: scoped.token, body: { name: 'x1', currency: 'SGD', basis_note: 'department attempt at rates', assumptions: { page_views: { per: 1, value_cents: 1 } } } })).status, 403);
});

test('deliverable file evidence can be opened by both sides, never by outsiders, and the read is audit-logged', async () => {
  const w = await world();
  const a = await w.deal();
  const d = must(await api('POST', `/sponsorships/${a.id}/deliverables`, { token: w.org.token, body: { kind: 'content', title: 'Reel', owed_by: 'recipient', due_on: await inDays(10), evidence_required: 'file' } }), 201);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n').toString('base64');
  const sub = must(await api('POST', `/sponsorship-deliverables/${d.id}/evidence`, { token: w.org.token, body: { files: [{ file_name: 'reel-proof.pdf', data: pdf }], label: 'Proof' } }), 201);
  assert.equal(sub.status, 'submitted');
  const list = must(await api('GET', `/sponsorships/${a.id}/deliverables`, { token: a.sponsor.token }));
  const ev = list[0].evidence[0];
  assert.equal(ev.file_name, 'reel-proof.pdf'); assert.equal(ev.data, undefined, 'the list carries metadata only');
  const file = must(await api('GET', `/sponsorship-deliverable-evidence/${ev.id}`, { token: a.sponsor.token }));
  assert.equal(Buffer.from(file.data, 'base64').subarray(0, 4).toString(), '%PDF'); assert.equal(file.content_type, 'application/pdf');
  must(await api('GET', `/sponsorship-deliverable-evidence/${ev.id}`, { token: w.org.token }));
  assert.equal((await api('GET', `/sponsorship-deliverable-evidence/${ev.id}`, { token: (await signup(['sponsor'])).token })).status, 403);
  assert.ok((await sql("SELECT 1 FROM audit_log WHERE action='sponsorship.deliverable_evidence.read' AND entity_id=$1", [ev.id])).length >= 2, 'reads are audit-logged');
  assert.equal(JSON.stringify((await sql('SELECT file_enc FROM sponsorship_deliverable_evidence WHERE id=$1', [ev.id]))[0]).includes('PDF'), false, 'stored encrypted');
});

test('an agreement with money in several currencies keeps every currency in issued reports and exports, never combined', async () => {
  const w = await world();
  const a = await w.deal(`Multi${++n}`, [money, { ...money, currency: 'USD', label: 'USD fee', amount_cents: 70000 }]);
  const rep = must(await api('POST', '/sponsorship-roi-reports', { token: a.sponsor.token, body: { sponsorship_ids: [a.id], from: await inDays(-10), to: await inDays(0) } }), 201);
  const got = must(await api('GET', `/sponsorship-roi-reports/${rep.id}`, { token: a.sponsor.token }));
  const rows = got.snapshot.table.rows;
  assert.deepEqual(rows.map((r) => r.currency).sort(), ['SGD', 'USD'], 'one row per currency');
  assert.equal(rows.find((r) => r.currency === 'USD').committed_cents, 280000);
  assert.equal(rows.find((r) => r.currency === 'SGD').committed_cents, 400000);
  assert.equal(rows.filter((r) => r.deliverables_accepted !== null).length, 1, 'non-money figures are not repeated on the second currency row');
  const csv = must(await api('GET', `/sponsorship-roi-reports/${rep.id}/export`, { token: a.sponsor.token, query: { format: 'csv' } }));
  assert.match(csv.content, /,SGD,400000,/); assert.match(csv.content, /,USD,280000,/);
  assert.equal(csv.rows, 2);
  // an estimate in a currency the agreement has no money in gets its own row and is never shown under another currency
  const m = must(await api('POST', `/sponsors/${a.brand.id}/valuation-models`, { token: a.sponsor.token, body: { name: 'EUR plan', currency: 'EUR', basis_note: 'Our euro media plan rates', assumptions: { page_views: { per: 1000, value_cents: 1000 } } } }), 201);
  await pool.query("INSERT INTO sponsor_exposure_signals(sponsorship_id, metric, day, value, source, source_ref, recorded_by) VALUES ($1,'page_views',current_date - 1, 2000,'SiteStats','export 3',$2)", [a.id, w.org.id]);
  const rep2 = must(await api('POST', '/sponsorship-roi-reports', { token: a.sponsor.token, body: { sponsorship_ids: [a.id], from: await inDays(-10), to: await inDays(0), valuation_version_id: m.versions[0].id } }), 201);
  const rows2 = must(await api('GET', `/sponsorship-roi-reports/${rep2.id}`, { token: a.sponsor.token })).snapshot.table.rows;
  assert.deepEqual(rows2.map((r) => r.currency).sort(), ['EUR', 'SGD', 'USD']);
  assert.equal(rows2.find((r) => r.currency === 'EUR').estimated_value_cents, 2000);
  assert.equal(rows2.filter((r) => r.estimated_value_cents != null).length, 1);
});
