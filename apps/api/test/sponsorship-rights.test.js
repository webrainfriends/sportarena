// Sponsorship rights, inventory & activation lifecycle (#589): territory/platform limits, rights packages, hospitality links, the one-lifecycle read,
// the activation calendar, relationship history, renewal pipeline stages and figure provenance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const { renewalStage } = await import('../src/sponsor-renewals.js');
const { estimateFrom, provenanceOf } = await import('../src/sponsor-roi.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `rt_${n}_${roles[0]}`, display_name: `Rights ${n}`, email: `rt${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const sql = async (q, p = []) => (await pool.query(q, p)).rows;
const day = (k = 0) => new Date(Date.now() + k * 864e5).toISOString().slice(0, 10);
const money = { kind: 'money', label: 'Title fee', currency: 'SGD', amount_cents: 100000, cadence: 'monthly', first_due_on: '2031-01-15', instalments: 4 };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function world() {
  const org = await signup(['organizer']);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Rights Cup ${++n}`, sport: 'football', city: 'Mumbai', starts_on: day(0), ends_on: day(3) } }), 201);
  must(await api('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'open' } }));
  const w = { org, ev };
  w.deal = async () => {
    const sponsor = await signup(['sponsor']);
    const brand = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Brand${++n}` } }), 201);
    const d = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: brand.id, target_type: 'event', target_id: ev.id, deliverables: 'Logo', starts_on: '2031-01-01', ends_on: '2031-12-31', lines: [money] } }), 201);
    must(await api('PATCH', `/sponsorships/${d.id}`, { token: org.token, body: { status: 'active', version: d.terms_version } }));
    await pool.query("UPDATE sponsorships SET starts_on=current_date - 30, ends_on=current_date + 60 WHERE id=$1", [d.id]);
    return { sponsor, brand, id: d.id };
  };
  return w;
}
const unit = (w, body = {}) => api('POST', '/sponsor-inventory', { token: w.org.token, body: { target_type: 'event', target_id: w.ev.id, kind: 'title_partner', name: 'Title partner', ...body } });
const book = (w, u, deal, body = {}) => api('POST', `/sponsor-inventory/${u.id}/bookings`, { token: w.org.token, body: { sponsorship_id: deal.id, category: 'beverage', starts_on: day(-5), ends_on: day(30), ...body } });

test('rights: territory and platform limits are enforced at booking, and exclusivity only collides where scopes meet', async () => {
  const w = await world();
  const [a, b] = [await w.deal(), await w.deal()];
  assert.equal((await unit(w, { territory_mode: 'include' })).status, 400, 'include needs countries');
  assert.equal((await unit(w, { asking_price_minor: 500 })).status, 400, 'price needs currency');
  const u = must(await unit(w, { name: 'Regional stream', kind: 'livestream_overlay', capacity: 3, exclusive_category: true, territory_mode: 'include', countries: ['in', 'sg', 'IN'], platforms: ['ott', 'web'], exclusivity_scope: 'Beverages', asking_price_minor: 250000, asking_currency: 'sgd' }), 201);
  assert.deepEqual(u.countries, ['IN', 'SG']); assert.equal(u.asking_currency, 'SGD');
  const out = await book(w, u, a, { countries: ['GB'] });
  assert.equal(out.status, 409); assert.match(JSON.stringify(out.body), /outside_rights/);
  assert.equal((await book(w, u, a, { platforms: ['linear_tv'] })).status, 409);
  must(await book(w, u, a, { countries: ['IN'], platforms: ['ott'] }), 201);
  must(await book(w, u, b, { countries: ['SG'], platforms: ['web'] }), 201);   // same category, disjoint territory and platform: no clash
  const c = await w.deal();
  const clash = await book(w, u, c, { countries: ['IN'], platforms: ['ott'] });
  assert.equal(clash.status, 409); assert.match(JSON.stringify(clash.body), /category_exclusive|already_booked|inventory_full/);
  const excl = must(await unit(w, { name: 'Not in GB', kind: 'replay', territory_mode: 'exclude', countries: ['GB'] }), 201);
  assert.equal((await book(w, excl, a, { countries: ['GB'] })).status, 409);
  must(await book(w, excl, a, { countries: ['US'] }), 201);
  const upd = must(await api('PATCH', `/sponsor-inventory/${excl.id}`, { token: w.org.token, body: { row_version: excl.row_version, territory_mode: 'worldwide', countries: [] } }));
  assert.equal(upd.territory_mode, 'worldwide');
});

test('rights packages bundle only your own active units, are versioned, never deleted and hide drafts from sponsors', async () => {
  const w = await world();
  const u1 = must(await unit(w, { name: 'U1' }), 201), u2 = must(await unit(w, { kind: 'replay', name: 'U2' }), 201);
  const pk = must(await api('POST', '/sponsor-rights-packages', { token: w.org.token, body: { target_type: 'event', target_id: w.ev.id, name: 'Gold', unit_ids: [u1.id, u2.id], price_minor: 900000, currency: 'SGD' } }), 201);
  assert.equal(pk.status, 'draft');
  const a = await w.deal();
  assert.equal(must(await api('GET', '/sponsor-rights-packages', { token: a.sponsor.token, query: { target_type: 'event', target_id: w.ev.id } })).packages.length, 0, 'drafts are private');
  const stranger = await signup(['organizer']);
  assert.equal((await api('POST', '/sponsor-rights-packages', { token: stranger.token, body: { target_type: 'event', target_id: w.ev.id, name: 'Mine', unit_ids: [u1.id] } })).status, 403);
  assert.equal((await api('POST', '/sponsor-rights-packages', { token: w.org.token, body: { package_id: pk.id, row_version: 9, target_type: 'event', target_id: w.ev.id, name: 'Gold', unit_ids: [u1.id] } })).status, 409, 'stale');
  const open = must(await api('POST', '/sponsor-rights-packages', { token: w.org.token, body: { package_id: pk.id, row_version: pk.row_version, target_type: 'event', target_id: w.ev.id, name: 'Gold', unit_ids: [u1.id], status: 'open' } }), 201);
  assert.equal(open.row_version, 2);
  const seen = must(await api('GET', '/sponsor-rights-packages', { token: a.sponsor.token, query: { target_type: 'event', target_id: w.ev.id } }));
  assert.equal(seen.packages.length, 1); assert.equal(seen.packages[0].units.length, 1, 'the removed unit left the bundle');
  assert.equal((await sql('SELECT count(*)::int AS n FROM sponsor_rights_package_units WHERE package_id=$1', [pk.id]))[0].n, 2, 'membership history is kept');
});

test('hospitality allocations link to the agreement and booking they fulfil, and feed the lifecycle', async () => {
  const w = await world();
  const a = await w.deal();
  const u = must(await unit(w, { kind: 'hospitality', name: 'Hospitality suite' }), 201);
  const bk = must(await book(w, u, a), 201);
  const fx = (await sql("INSERT INTO fixtures(event_id, scheduled_at, status) VALUES ($1, now() + interval '2 hours','scheduled') RETURNING id", [w.ev.id]))[0].id;
  const p = must(await api('POST', `/events/${w.ev.id}/ticket-products`, { token: w.org.token, body: { name: 'Suite pass', class: 'complimentary', price_minor: 0, currency: 'GBP', fixture_ids: [fx] } }), 201);
  must(await api('PATCH', `/ticket-products/${p.id}`, { token: w.org.token, body: { status: 'active' } }));
  const base = { product_id: p.id, kind: 'sponsor', label: 'Suite', quota: 4, reason: 'Hospitality entitlement' };
  const other = await world();
  assert.equal((await api('POST', `/events/${w.ev.id}/ticket-allocations`, { token: w.org.token, body: { ...base, sponsorship_id: (await other.deal()).id } })).status, 404, 'another event\'s agreement');
  const al = must(await api('POST', `/events/${w.ev.id}/ticket-allocations`, { token: w.org.token, body: { ...base, sponsorship_id: a.id, booking_id: bk.id } }), 201);
  assert.equal(al.sponsorship_id, a.id);
  const lc = must(await api('GET', `/sponsorships/${a.id}/lifecycle`, { token: a.sponsor.token }));
  assert.equal(lc.hospitality[0].quota, 4);
  assert.equal(lc.matrix.find((m) => m.area === 'hospitality').contracted, 4);
});

test('lifecycle: one view of rights, dues, activation, evidence, exposure and renewal, visible only to the parties', async () => {
  const w = await world();
  const a = await w.deal();
  const u = must(await unit(w, { name: 'Event page', kind: 'event_page' }), 201);
  const bk = must(await book(w, u, a), 201);
  const d = must(await api('POST', `/sponsorships/${a.id}/deliverables`, { token: w.org.token, body: { booking_id: bk.id, kind: 'appearance', title: 'Trophy handover', due_on: day(5), owed_by: 'recipient', evidence_required: 'link' } }), 201);
  const lc = must(await api('GET', `/sponsorships/${a.id}/lifecycle`, { token: a.sponsor.token }));
  assert.equal(lc.rights.length, 1); assert.equal(lc.rights[0].deliverables, 1);
  assert.equal(lc.activation.deliverables[0].id, d.id); assert.equal(lc.activation.deliverables[0].state, 'upcoming');
  assert.equal(lc.matrix.find((m) => m.area === 'dues_money').contracted, 4);
  assert.equal(lc.matrix.find((m) => m.area === 'deliverables').delivered, 0);
  assert.ok(lc.matrix.every((m) => m.provenance === 'recorded'));
  assert.match(lc.exposure.provenance_note, /ROI is never invented/);
  assert.equal(lc.renewal.stage, 'expiring'); assert.equal(lc.renewal.alert, 'expires_60');
  assert.equal(must(await api('GET', `/sponsorships/${a.id}/lifecycle`, { token: w.org.token })).agreement.viewer_side, 'recipient');
  const stranger = await signup(['sponsor']);
  assert.equal((await api('GET', `/sponsorships/${a.id}/lifecycle`, { token: stranger.token })).status, 404);
});

test('activation calendar merges deliverables, tasks, rights and dues in date order, limited to your agreements', async () => {
  const w = await world();
  const a = await w.deal();
  const u = must(await unit(w, { name: 'Page', kind: 'event_page' }), 201);
  must(await book(w, u, a), 201);
  must(await api('POST', `/sponsorships/${a.id}/deliverables`, { token: w.org.token, body: { kind: 'content', title: 'Post', due_on: day(3), owed_by: 'recipient', evidence_required: 'link' } }), 201);
  const cal = must(await api('GET', '/sponsorship-activation-calendar', { token: w.org.token, query: { from: day(-10), to: day(40) } }));
  const types = new Set(cal.items.map((x) => x.type));
  assert.ok(types.has('deliverable') && types.has('rights_start') && types.has('rights_end'));
  assert.deepEqual(cal.items.map((x) => x.on), [...cal.items.map((x) => x.on)].sort());
  const stranger = await signup(['organizer']);
  assert.equal(must(await api('GET', '/sponsorship-activation-calendar', { token: stranger.token })).items.length, 0);
  assert.equal((await api('GET', '/sponsorship-activation-calendar', { token: stranger.token, query: { sponsorship_id: a.id } })).status, 404);
});

test('relationship history and renewal pipeline stages', async () => {
  const w = await world();
  const a = await w.deal();
  const hist = must(await api('GET', '/sponsor-relationship-history', { token: a.sponsor.token, query: { sponsor_id: a.brand.id, target_type: 'event', target_id: w.ev.id } }));
  assert.equal(hist.agreements.length, 1); assert.ok(hist.events.length > 0);
  const stranger = await signup(['sponsor']);
  assert.equal((await api('GET', '/sponsor-relationship-history', { token: stranger.token, query: { sponsor_id: a.brand.id, target_type: 'event', target_id: w.ev.id } })).status, 404);
  const list = must(await api('GET', '/sponsorship-renewals', { token: a.sponsor.token }));
  const row = list.find((r) => r.id === a.id);
  assert.equal(row.stage, 'expiring'); assert.equal(row.alert, 'expires_60');
  assert.deepEqual(renewalStage({ status: 'term_expired', days_left: -3 }), { stage: 'past_term', alert: 'expired' });
  assert.equal(renewalStage({ status: 'active', days_left: 20, assessments: [{ intent: 'renew' }] }).alert, 'expires_30');
  assert.equal(renewalStage({ status: 'active', days_left: 20, successor_status: 'proposed' }).stage, 'renewal_proposed');
  assert.equal(renewalStage({ status: 'completed', days_left: -9, successor_status: 'active' }).stage, 'renewed');
});

test('provenance: every figure is labelled measured, imported or estimated', () => {
  assert.equal(provenanceOf('platform_measured'), 'measured');
  assert.equal(provenanceOf('provider_reported'), 'imported');
  const est = estimateFrom({ assumptions: { placement_impressions: { value_cents: 100, per: 1000 } }, currency: 'SGD', id: 'v', model_id: 'm', name: 'M', version: 1 }, { metrics: [{ key: 'placement_impressions', value: 5000, basis: 'platform_measured' }] }, []);
  assert.equal(est.provenance, 'estimated'); assert.equal(est.lines[0].provenance, 'estimated'); assert.equal(est.lines[0].measured_provenance, 'measured');
});

test('new capabilities are exposed to REST and MCP from one definition', () => {
  for (const name of ['save_sponsor_rights_package', 'list_sponsor_rights_packages', 'get_sponsorship_lifecycle', 'get_sponsorship_activation_calendar', 'get_sponsor_relationship_history']) assert.ok(capabilities.find((c) => c.name === name), name);
});
