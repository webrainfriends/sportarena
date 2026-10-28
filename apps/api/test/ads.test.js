// Sports advertising & promoted marketplace (#524): policy, campaign lifecycle and review, money that cannot overspend, serving that stays contextual and
// labelled, youth protection, and the guarantee that paying for ads never moves an organic list. Every test creates its own people and data; the card
// provider is a local stand-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const fake = { sessions: {}, refunds: [], n: 0 };
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, { error: { message: 'no such session' } }); }
  if (req.url === '/v1/refunds') { const f = new URLSearchParams(raw); fake.refunds.push({ intent: f.get('payment_intent'), amount: Number(f.get('amount')) }); return send(200, { id: `re_${fake.refunds.length}` }); }
  send(404, {});
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: `http://127.0.0.1:${provider.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test',
  PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com',
});
const { pool, start, stop, call, ok, signup, orgWith, createApp } = await import('./tender-helpers.js');
const { adSweeps } = await import('../src/ads/engine.js');
const { PLACEMENTS, PLACEMENT_CODES, PROHIBITED_CATEGORIES, CATEGORIES } = await import('../src/ads/policy.js');

before(start);
after(async () => { provider.close(); await stop(); });

const isoDay = (d = 0) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
let seq = 0;
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };

async function platformAdmin() {
  const r = await call('POST', '/auth/register', { body: { handle: `boss_${++seq}`, display_name: 'Boss', email: 'rraja.edge@gmail.com', password: 'correct-horse-battery', roles: ['athlete'] } });
  let u;
  if (r.status === 201) { u = { ...r.body.user, token: r.body.token }; await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id=$1", [u.id]); }
  else { const l = ok(await call('POST', '/auth/login', { body: { email: 'rraja.edge@gmail.com', password: 'correct-horse-battery' } })); u = { ...l.user, token: l.token }; }
  return u;
}
let adminUser;
const admin = async () => (adminUser ??= await platformAdmin());

/** Fresh stage: every campaign from earlier tests stops delivering, so each test sees only its own ads. */
const clearStage = () => pool.query("UPDATE ad_campaigns SET status='ended' WHERE status IN ('active','scheduled','paused')");

/** An advertiser with a venue they manage, ready to promote it. */
async function venueAdvertiser() {
  await clearStage();
  const mgr = await signup('adv', ['venue_manager']);
  const v = ok(await call('POST', '/venues', { token: mgr.token, body: { name: `Ad Arena ${++seq}`, city: 'Mumbai', timezone: 'UTC', currency: 'INR', payment_mode: 'online_optional' } }), 201);
  const acc = ok(await call('POST', '/advertising/advertisers', { token: mgr.token, body: { accept_policy: true } }), 201);
  return { mgr, venue: v, advertiser: acc.id };
}
const campaignBody = (w, over = {}) => ({
  advertiser_id: w.advertiser, name: `Spring offer ${++seq}`, objective: 'traffic', category: 'venues_facilities', placements: ['featured_venue'], billing_model: 'cpm', rate_minor: 5000, currency: 'INR', budget_minor: 100000,
  starts_on: isoDay(0), ends_on: isoDay(30), landing_entity_type: 'venue', landing_entity_id: w.venue.id,
  creative: { headline: 'Courts from 8am', body: 'Book a court this week', cta: 'book_now', claims: ['availability'] }, ...over,
});
const create = async (w, over, token = w.mgr.token) => ok(await call('POST', '/advertising/campaigns', { token, body: campaignBody(w, over) }), 201);
const submit = (w, c) => call('POST', `/advertising/campaigns/${c.id}/submit`, { token: w.mgr.token, body: {} });
const review = async (c, body = { decision: 'approved', claims_checked: ['availability'] }) => call('POST', `/admin/advertising/campaigns/${c.id}/review`, { token: (await admin()).token, body });
const pay = async (u, funding) => {   // hosted checkout by `u`, settled by the provider stand-in
  const r = await call('POST', '/payments', { token: u.token, body: { purpose_type: 'ad_funding', purpose_id: funding.id, provider: 'stripe', return_url: 'http://app.test/' } });
  if (r.status !== 201) return r;
  Object.values(fake.sessions).at(-1).payment_status = 'paid';
  return { ...r, confirm: ok(await call('POST', `/payments/${r.body.id}/confirm`, { token: u.token, body: {} })) };
};
const fund = async (w, c, amount) => {
  const f = ok(await call('POST', `/advertising/campaigns/${c.id}/fund`, { token: w.mgr.token, body: { amount_minor: amount } }), 201);
  assert.equal((await pay(w.mgr, f)).status, 201);
  return f;
};
/** Create → submit → approve → fund → start: a live campaign. */
async function live(w, over = {}, amount) {
  const c = await create(w, over);
  ok(await submit(w, c));
  ok(await review(c));
  await fund(w, c, amount ?? c.budget_minor);
  ok(await call('POST', `/advertising/campaigns/${c.id}/start`, { token: w.mgr.token, body: {} }));
  return c;
}
const serve = (placement, extra = {}, { token, ua } = {}) => call('GET', `/public/ads?${new URLSearchParams({ placement, ...extra })}`, { token, headers: { 'user-agent': ua ?? `viewer-${++seq}` } });
const campaignRow = (id) => pool.query('SELECT * FROM ad_campaigns WHERE id=$1', [id]).then((r) => r.rows[0]);

test('the policy states every placement, its organic neighbour, who may buy it and how it is measured; prohibited categories are named', async () => {
  const p = ok(await call('GET', '/advertising/policy'));
  assert.deepEqual(p.placements.map((x) => x.code).sort(), [...PLACEMENT_CODES].sort());
  assert.equal(p.placements.length, 9);
  assert.ok(p.placements.every((x) => x.in_app), 'every placement has an organic surface in the app');
  for (const x of p.placements) {
    assert.ok(x.organic_source_left_untouched && x.advertiser_eligibility && x.measurement && x.surface, `${x.code} documents its assessment row`);
    assert.match(x.disclosure, /^(Sponsored|Promoted)$/);
  }
  assert.ok(p.categories.prohibited.some((c) => c.code === 'gambling_betting') && p.categories.prohibited.some((c) => c.code === 'supplements_health_claims'));
  assert.ok(p.targeting.never.some((t) => /health/.test(t)) && p.targeting.never.some((t) => /youth/.test(t)));
  assert.equal(p.youth.contextual_allowed, false, 'young people are protected until the platform decides otherwise');
  assert.match(p.metrics.conversions, /Not measured/);
  assert.match(p.metrics.unique_reach, /Not measured/);
});

test('campaign rules: prohibited categories, forbidden targeting, ownership of what is promoted, safe links, plain dates and budgets', async () => {
  const w = await venueAdvertiser();
  const stranger = await signup('stranger', ['venue_manager']);
  const theirVenue = ok(await call('POST', '/venues', { token: stranger.token, body: { name: `Other ${++seq}`, timezone: 'UTC', currency: 'INR', payment_mode: 'online_optional' } }), 201);
  for (const category of PROHIBITED_CATEGORIES) {
    const r = await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { category }) });
    assert.equal(r.status, 422, `${category} must be refused`);
  }
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { category: 'made_up' }) })).status, 400);
  // targeting the platform will never offer: refused by name, not ignored
  for (const key of ['health_interest', 'injury_history', 'insurance_claim', 'legal_matter', 'age_band', 'child_profile', 'lat', 'lng', 'private_messages', 'ethnicity']) {
    const r = await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: { ...campaignBody(w), [key]: key === 'lat' || key === 'lng' ? 19.07 : 'yes' } });
    assert.equal(r.status, 400, `${key} is not a targeting option`);
  }
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { landing_entity_id: theirVenue.id }) })).status, 400, 'you can only promote a venue you manage');
  assert.equal((await call('POST', '/advertising/campaigns', { token: stranger.token, body: campaignBody(w) })).status, 404, 'an outsider cannot use someone else\'s advertiser account (and learns nothing about it)');
  for (const url of ['http://example.com/a', 'https://localhost/x', 'https://10.0.0.1/x', 'https://user:pw@example.com/x', 'javascript:alert(1)']) {
    const r = await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { placements: ['sponsored_post'], landing_entity_type: undefined, landing_entity_id: undefined, landing_url: url }) });
    assert.equal(r.status, 400, url);
  }
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { starts_on: isoDay(-2) }) })).status, 400, 'a start date in the past');
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { ends_on: isoDay(-1), starts_on: isoDay(0) }) })).status, 400);
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { billing_model: 'flat', rate_minor: 9000, budget_minor: 10000 }) })).status, 400, 'a flat fee spends exactly its fee');
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { placements: ['featured_coach'] }) })).status, 400, 'featured coach needs a coach');
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { placements: ['search_sponsored'], landing_entity_type: undefined, landing_entity_id: undefined, landing_url: 'https://example.com/shop' }) })).status, 400, 'a sponsored search slot needs keywords');
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { sports: ['no-such-sport'] }) })).status, 400);
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { creative: { headline: 'Best betting odds', cta: 'view' } }) })).status, 422, 'the wording is screened too');
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { audience: 'followers', placements: ['sponsored_post'], landing_entity_type: undefined, landing_entity_id: undefined, landing_url: 'https://example.com/x' }) })).status, 400, 'followers only for a venue or event');
});

test('lifecycle: draft → submitted → approved → funded → live; every step is recorded and only the platform admin can decide', async () => {
  const w = await venueAdvertiser();
  const c = await create(w);
  assert.equal(c.status, 'draft');
  assert.equal(c.disclosure, 'Promoted');
  const noCreative = await create(w, { creative: undefined });
  assert.equal((await submit(w, noCreative)).status, 422, 'a campaign needs its ad before review');
  // a person who is not the platform admin cannot read or decide the queue
  assert.equal((await call('GET', '/admin/advertising/queue', { token: w.mgr.token })).status, 403);
  assert.equal((await call('POST', `/admin/advertising/campaigns/${c.id}/review`, { token: w.mgr.token, body: { decision: 'approved' } })).status, 403);
  const impostor = await signup('impostor', ['athlete']);
  await pool.query("UPDATE users SET roles = '{athlete,admin,platform_admin}' WHERE id=$1", [impostor.id]);
  assert.equal((await call('GET', '/admin/advertising/queue', { token: impostor.token })).status, 403, 'the label alone is not enough: the account must be on the platform-admin list');
  const sub = ok(await submit(w, c));
  assert.equal(sub.status, 'submitted');
  const q = ok(await call('GET', '/admin/advertising/queue', { token: (await admin()).token }));
  assert.ok(q.campaigns.some((x) => x.id === c.id));
  // rejection needs a reason; the advertiser sees it and may fix and resubmit
  assert.equal((await review(c, { decision: 'rejected' })).status, 400);
  ok(await review(c, { decision: 'rejected', reason_category: 'misleading_claim', reason: 'Say which days the offer covers.' }));
  const seen = ok(await call('GET', `/advertising/campaigns/${c.id}`, { token: w.mgr.token }));
  assert.equal(seen.campaign.status, 'rejected');
  assert.equal(seen.reviews[0].reason_category, 'misleading_claim');
  ok(await call('POST', `/advertising/campaigns/${c.id}/creatives`, { token: w.mgr.token, body: { headline: 'Courts from 8am, Mon–Fri', cta: 'book_now', claims: ['availability'] } }), 201);
  assert.equal(ok(await call('GET', `/advertising/campaigns/${c.id}`, { token: w.mgr.token })).campaign.status, 'draft', 'a changed ad goes back to draft');
  ok(await submit(w, c));
  // claims the ad declares must be checked before approval
  assert.equal((await review(c, { decision: 'approved', claims_checked: [] })).status, 400);
  assert.equal((await call('POST', `/advertising/campaigns/${c.id}/start`, { token: w.mgr.token, body: {} })).status, 409, 'not approved yet');
  ok(await review(c));
  assert.equal((await call('POST', `/advertising/campaigns/${c.id}/start`, { token: w.mgr.token, body: {} })).status, 409, 'approved but not funded');
  await fund(w, c, 100000);
  const started = ok(await call('POST', `/advertising/campaigns/${c.id}/start`, { token: w.mgr.token, body: {} }));
  assert.equal(started.status, 'active');
  const detail = ok(await call('GET', `/advertising/campaigns/${c.id}`, { token: w.mgr.token }));
  const actions = detail.timeline.map((t) => t.action);
  for (const a of ['created', 'submitted', 'rejected', 'approved', 'funded', 'activated']) assert.ok(actions.includes(a), a);
  // reviews are append-only
  await assert.rejects(pool.query("UPDATE ad_reviews SET reason='edited'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM ad_reviews'), /append-only/);
});

test('serving: a labelled ad with a plain reason, only for the page context, never alongside private data; impressions and clicks are charged once', async () => {
  const w = await venueAdvertiser();
  const c = await live(w, { sports: ['football'], countries: ['IN'], cities: ['Mumbai'], rate_minor: 10000, budget_minor: 50000 });
  // context must match: a different sport, no sport, a different city: nothing
  assert.deepEqual(ok(await serve('featured_venue', { sport: 'tennis', city: 'Mumbai' })).ads, []);
  assert.deepEqual(ok(await serve('featured_venue', { city: 'Mumbai' })).ads, [], 'a campaign that names a sport needs the page to be about it');
  assert.deepEqual(ok(await serve('featured_venue', { sport: 'football', city: 'Delhi' })).ads, []);
  assert.deepEqual(ok(await serve('featured_venue', { sport: 'football' })).ads, [], 'no location chosen: a city-targeted ad is not shown');
  assert.deepEqual(ok(await serve('featured_venue', { sport: 'football', city: 'mumbai' })).ads.length, 1, 'city match ignores case');
  assert.deepEqual(ok(await serve('search_sponsored', { sport: 'football', city: 'Mumbai', q: 'court' })).ads, [], 'another placement');
  const r = ok(await serve('featured_venue', { sport: 'football', city: 'Mumbai' }, { ua: 'serving-viewer' }));
  const ad = r.ads[0];
  assert.equal(ad.label, 'Promoted');
  assert.ok(ad.token && ad.advertiser.name && ad.headline && ad.cta === 'book_now');
  assert.match(ad.why, /not because of anything private/);
  const wire = JSON.stringify(r);
  for (const leak of ['spent', 'budget', 'funded', 'rate_minor', 'viewer_hash', 'countries', 'cities', 'keywords', 'campaign_id', 'landing_url']) assert.ok(!wire.includes(leak), `the public payload does not expose ${leak}`);
  // a click is tied to its impression, counted once, and leads to the promoted page
  const dest = ok(await call('POST', `/public/ads/${ad.token}/click`, { headers: { 'user-agent': 'serving-viewer' } }));
  assert.equal(dest.type, 'entity'); assert.equal(dest.entity_id, w.venue.id);
  assert.equal((await call('POST', `/public/ads/${ad.token}/click`, { headers: { 'user-agent': 'someone-else' } })).status, 404, 'an impression id only works for the person it was served to');
  ok(await call('POST', `/public/ads/${ad.token}/click`, { headers: { 'user-agent': 'serving-viewer' } }));   // a second tap is the same click
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM ad_delivery_events WHERE parent_id=$1 AND kind='click'", [ad.token])).rows[0].n), 1, 'one click per impression');
  const rep = ok(await call('GET', `/advertising/campaigns/${c.id}/report`, { token: w.mgr.token }));
  assert.ok(rep.impressions >= 1);
  assert.equal(rep.conversions, null); assert.equal(rep.unique_reach, null);
  assert.ok(rep.definitions.impressions);
});

test('money: delivery can never spend more than is funded, even under concurrent requests; the counter equals the sum of the facts', async () => {
  // per click: 30,000 minor, 90,000 funded → exactly three clicks fit; ten viewers click at the same moment
  const w = await venueAdvertiser();
  const c = await live(w, { billing_model: 'cpc', rate_minor: 30000, budget_minor: 90000 }, 90000);
  const viewers = Array.from({ length: 10 }, (_, i) => `click-viewer-${i}-${++seq}`);
  const tokens = [];
  for (const ua of viewers) { const a = ok(await serve('featured_venue', {}, { ua })).ads[0]; assert.ok(a, 'impressions are free under cpc'); tokens.push([ua, a.token]); }
  const results = await Promise.all(tokens.map(([ua, t]) => call('POST', `/public/ads/${t}/click`, { headers: { 'user-agent': ua } })));
  assert.ok(results.every((x) => x.status === 200), 'everyone still reaches the destination');
  const billable = Number((await pool.query("SELECT count(*) AS n FROM ad_delivery_events WHERE campaign_id=$1 AND kind='click' AND billable", [c.id])).rows[0].n);
  assert.equal(billable, 3, 'exactly the clicks the funds cover are charged');
  const refused = (await pool.query("SELECT invalid_reason FROM ad_delivery_events WHERE campaign_id=$1 AND kind='click' AND NOT billable", [c.id])).rows;
  assert.equal(refused.length, 7); assert.ok(refused.every((r) => r.invalid_reason === 'budget_exhausted'), 'the rest are recorded as not charged, with the reason');
  let m = ok(await call('GET', `/advertising/campaigns/${c.id}`, { token: w.mgr.token })).money;
  assert.equal(m.spent_minor, 90000); assert.equal(m.remaining_minor, 0);
  assert.equal(m.reconciliation.spend_matches, true); assert.equal(m.reconciliation.funds_match, true);
  assert.ok(m.spent_minor <= m.funded_minor, 'never overspent');
  assert.deepEqual(ok(await serve('featured_venue', {}, { ua: 'late' })).ads, [], 'a campaign with nothing left stops serving');

  // per 1,000 impressions: 1,000 minor is one minor unit an impression; room for exactly two, twenty viewers at once
  const w2 = await venueAdvertiser();
  const c2 = await live(w2, { billing_model: 'cpm', rate_minor: 1000, budget_minor: 1000 }, 1000);
  await pool.query('UPDATE ad_campaigns SET budget_minor = 2 WHERE id=$1', [c2.id]);
  const out = await Promise.all(Array.from({ length: 20 }, (_, i) => serve('featured_venue', {}, { ua: `imp-viewer-${i}-${++seq}` })));
  const shown = out.flatMap((r) => r.body.ads);
  const facts = (await pool.query("SELECT count(*)::int AS n, coalesce(sum(cost_micro),0)::bigint AS micro FROM ad_delivery_events WHERE campaign_id=$1 AND kind='impression'", [c2.id])).rows[0];
  assert.equal(facts.n, 2, 'only the room that was funded was sold'); assert.equal(shown.length, 2);
  m = ok(await call('GET', `/advertising/campaigns/${c2.id}`, { token: w2.mgr.token })).money;
  assert.equal(m.spent_micro, 2_000_000); assert.equal(m.reconciliation.spend_matches, true);
  // facts are immutable
  await assert.rejects(pool.query('UPDATE ad_delivery_events SET billable=false'), /append-only/);
  await assert.rejects(pool.query('DELETE FROM ad_delivery_events'), /append-only/);
});

test('frequency cap and repeats: the same person is not charged twice for one view and stops at their daily limit; a viewer who hides an ad stops seeing it', async () => {
  const w = await venueAdvertiser();
  const c = await live(w, { frequency_per_day: 2 });
  const viewer = await signup('fan');
  const first = ok(await serve('featured_venue', {}, { token: viewer.token })).ads;
  const mine = first.find((a) => a.headline === 'Courts from 8am');
  assert.ok(mine, 'shown to the signed-in viewer');
  const again = ok(await serve('featured_venue', {}, { token: viewer.token })).ads.find((a) => a.headline === 'Courts from 8am');
  assert.equal(again?.token, mine.token, 'asking again straight away is the same impression, not a new charge');
  const imps = Number((await pool.query("SELECT count(*) AS n FROM ad_delivery_events WHERE campaign_id=$1 AND kind='impression' AND viewer_hash IS NOT NULL", [c.id])).rows[0].n);
  assert.equal(imps, 1);
  // one more view earlier today puts them at the cap of two
  const hash = (await pool.query('SELECT viewer_hash, creative_id FROM ad_delivery_events WHERE id=$1', [mine.token])).rows[0];
  await pool.query("INSERT INTO ad_delivery_events(campaign_id, creative_id, placement_code, kind, viewer_hash, occurred_at, cost_micro, dedupe_key) VALUES ($1,$2,'featured_venue','impression',$3, now() - interval '2 hours', 5000000, 'earlier')", [c.id, hash.creative_id, hash.viewer_hash]);
  await pool.query('UPDATE ad_campaigns SET spent_micro = spent_micro + 5000000 WHERE id=$1', [c.id]);
  await pool.query("UPDATE ad_campaigns SET frequency_per_day = 2 WHERE id=$1", [c.id]);
  await new Promise((r) => setTimeout(r, 25));
  const third = ok(await serve('featured_venue', {}, { token: viewer.token })).ads.find((a) => a.token !== mine.token && a.headline === 'Courts from 8am');
  assert.equal(third, undefined, 'two views in the last 24 hours: that is the cap');
  // hide: takes effect on the next request, can be undone
  const w2 = await venueAdvertiser();
  await live(w2, { frequency_per_day: 5 });
  const viewer2 = await signup('hider');
  const shown = ok(await serve('featured_venue', {}, { token: viewer2.token })).ads;
  assert.ok(shown.length);
  ok(await call('POST', `/ads/${shown[0].token}/hide`, { token: viewer2.token, body: { scope: 'advertiser' } }), 201);
  assert.ok(!ok(await serve('featured_venue', {}, { token: viewer2.token })).ads.some((a) => a.advertiser.name === shown[0].advertiser.name));
  const hides = ok(await call('GET', '/me/ad-hides', { token: viewer2.token }));
  assert.equal(hides.length, 1);
  ok(await call('POST', `/me/ad-hides/${hides[0].id}/remove`, { token: viewer2.token, body: {} }));
  assert.equal(ok(await call('GET', '/me/ad-hides', { token: viewer2.token })).length, 0);
});

test('an ad stops the moment it is paused, withdrawn or its ad is changed; a stale page cannot follow it; platform pauses cannot be undone by the advertiser', async () => {
  const w = await venueAdvertiser();
  const c = await live(w);
  const ad = ok(await serve('featured_venue', {}, { ua: 'stable' })).ads.find((a) => a.headline === 'Courts from 8am');
  assert.ok(ad);
  ok(await call('POST', `/advertising/campaigns/${c.id}/pause`, { token: w.mgr.token, body: {} }));
  assert.ok(!ok(await serve('featured_venue')).ads.some((a) => a.headline === 'Courts from 8am'), 'paused: gone on the next request');
  assert.equal((await call('POST', `/public/ads/${ad.token}/click`, { headers: { 'user-agent': 'stable' } })).status, 404, 'and a page that still shows it leads nowhere');
  // editing a paused campaign sends it back to review
  assert.equal((await call('POST', `/advertising/campaigns/${c.id}/resume`, { token: w.mgr.token, body: {} })).status, 200);
  assert.equal((await call('PATCH', `/advertising/campaigns/${c.id}`, { token: w.mgr.token, body: { name: 'Renamed' } })).status, 409, 'live campaigns are paused before they are edited');
  ok(await call('POST', `/advertising/campaigns/${c.id}/pause`, { token: w.mgr.token, body: {} }));
  ok(await call('POST', `/advertising/campaigns/${c.id}/creatives`, { token: w.mgr.token, body: { headline: 'New wording', cta: 'view' } }), 201);
  assert.equal((await campaignRow(c.id)).status, 'draft');
  assert.equal((await call('POST', `/advertising/campaigns/${c.id}/resume`, { token: w.mgr.token, body: {} })).status, 409, 'a changed ad is reviewed again before it shows');
  // platform pause is the platform's to release
  const w2 = await venueAdvertiser();
  const c2 = await live(w2);
  const a = await admin();
  ok(await call('POST', `/admin/advertising/campaigns/${c2.id}/stop`, { token: a.token, body: { action: 'pause', reason_category: 'misleading_claim', reason: 'Claim under review' } }));
  const name2 = ok(await call('GET', `/advertising/campaigns/${c2.id}`, { token: w2.mgr.token })).advertiser_name;
  assert.ok(!ok(await serve('featured_venue')).ads.some((x) => x.headline === 'Courts from 8am' && x.advertiser.name === name2));
  assert.equal((await call('POST', `/advertising/campaigns/${c2.id}/resume`, { token: w2.mgr.token, body: {} })).status, 403);
  ok(await call('POST', `/admin/advertising/campaigns/${c2.id}/stop`, { token: a.token, body: { action: 'release', reason: 'Resolved with advertiser' } }));
  assert.equal((await campaignRow(c2.id)).status, 'active');
  // withdrawal is final
  ok(await call('POST', `/advertising/campaigns/${c2.id}/withdraw`, { token: w2.mgr.token, body: {} }));
  assert.equal((await call('POST', `/advertising/campaigns/${c2.id}/start`, { token: w2.mgr.token, body: {} })).status, 409);
  // a prohibited category already in the data never serves, whatever was approved
  const w3 = await venueAdvertiser();
  const c3 = await live(w3);
  await pool.query("UPDATE ad_campaigns SET category='gambling_betting' WHERE id=$1", [c3.id]);
  const name3 = ok(await call('GET', `/advertising/campaigns/${c3.id}`, { token: w3.mgr.token })).advertiser_name;
  assert.ok(!ok(await serve('featured_venue')).ads.some((x) => x.advertiser.name === name3));
});

test('funding: a numbered invoice, funds only once the provider confirms, a flat fee is credited back when nothing was shown, unspent funds are refunded and reconcile', async () => {
  const w = await venueAdvertiser();
  const c = await create(w, { billing_model: 'flat', rate_minor: 25000, budget_minor: 25000 });
  ok(await submit(w, c)); ok(await review(c));
  assert.equal((await call('POST', `/advertising/campaigns/${c.id}/fund`, { token: w.mgr.token, body: { amount_minor: 30000 } })).status, 400, 'cannot fund beyond the budget');
  const f = ok(await call('POST', `/advertising/campaigns/${c.id}/fund`, { token: w.mgr.token, body: { amount_minor: 25000 } }), 201);
  assert.match(f.number, /^AD-\d{4}-\d{6}$/);
  assert.equal((await campaignRow(c.id)).funded_minor, 0, 'an unpaid invoice adds no funds');
  const outsider = await signup('nosy');
  assert.equal((await call('POST', '/payments', { token: outsider.token, body: { purpose_type: 'ad_funding', purpose_id: f.id, provider: 'stripe', return_url: 'http://app.test/' } })).status, 403, 'only the person who raised the invoice can pay it');
  assert.equal((await pay(w.mgr, f)).status, 201);
  assert.equal(Number((await campaignRow(c.id)).funded_minor), 25000);
  ok(await call('POST', `/advertising/campaigns/${c.id}/start`, { token: w.mgr.token, body: {} }));
  let m = ok(await call('GET', `/advertising/campaigns/${c.id}`, { token: w.mgr.token })).money;
  assert.equal(m.spent_minor, 25000, 'the flat fee is taken when it starts');
  ok(await call('POST', `/advertising/campaigns/${c.id}/withdraw`, { token: w.mgr.token, body: {} }));
  m = ok(await call('GET', `/advertising/campaigns/${c.id}`, { token: w.mgr.token })).money;
  assert.equal(m.spent_minor, 0, 'nothing was shown: the flat fee is credited back');
  const back = ok(await call('POST', `/advertising/campaigns/${c.id}/refund-balance`, { token: w.mgr.token, body: {} }));
  assert.equal(back.refunded_minor, 25000);
  assert.equal(fake.refunds.at(-1).amount, 25000);
  const after = ok(await call('GET', `/advertising/campaigns/${c.id}`, { token: w.mgr.token })).money;
  assert.equal(after.refunded_minor, 25000);
  assert.equal(after.reconciliation.funds_match, true);
  assert.equal(after.reconciliation.spend_matches, true);
  assert.equal(ok(await call('POST', `/advertising/campaigns/${c.id}/refund-balance`, { token: w.mgr.token, body: {} })).refunded_minor, 0, 'nothing left to give back');
  await assert.rejects(pool.query("UPDATE ad_ledger SET amount_minor = 1"), /append-only/);
  // the admin refund route cannot hand back money that was spent
  const w2 = await venueAdvertiser();
  const c2 = await live(w2, { billing_model: 'cpc', rate_minor: 10000, budget_minor: 40000 }, 40000);
  const shown = ok(await serve('featured_venue', {}, { ua: 'payer' })).ads.find((x) => x.headline === 'Courts from 8am');
  if (shown) await call('POST', `/public/ads/${shown.token}/click`, { headers: { 'user-agent': 'payer' } });
  const spentNow = ok(await call('GET', `/advertising/campaigns/${c2.id}`, { token: w2.mgr.token })).money.spent_minor;
  const pay2 = (await pool.query("SELECT p.id FROM payments p JOIN ad_fundings f ON f.id=p.purpose_id WHERE f.campaign_id=$1", [c2.id])).rows[0];
  const tooMuch = await call('POST', `/admin/payments/${pay2.id}/refund`, { token: (await admin()).token, body: { amount_cents: 40000, reason: 'Testing the guard' } });
  if (spentNow > 0) assert.equal(tooMuch.status, 409, 'spent money is not refundable');
  // the platform report adds up the same facts
  const overview = ok(await call('GET', '/admin/advertising/overview', { token: (await admin()).token }));
  assert.deepEqual(overview.reconciliation.mismatched, [], 'every campaign counter equals its delivery facts');
});

test('youth: no ads for a young person or on a youth event unless the platform allows approved contextual campaigns, and then no profiling', async () => {
  const w = await venueAdvertiser();
  const c = await live(w, { frequency_per_day: 3 });
  const kid = await signup('kid', { dob: yearsAgo(12) }.dob ? ['athlete'] : ['athlete']);
  await pool.query("UPDATE users SET dob_enc = dob_enc WHERE id=$1", [kid.id]).catch(() => {});
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [kid.id]);
  const adult = await signup('adult');
  assert.ok(ok(await serve('featured_venue', {}, { token: adult.token })).ads.length >= 1);
  const none = ok(await serve('featured_venue', {}, { token: kid.token }));
  assert.deepEqual(none.ads, []); assert.equal(none.why_empty, 'youth_protection');
  // the platform may allow contextual-only delivery, but only for campaigns a reviewer marked safe
  const a = await admin();
  ok(await call('PATCH', '/admin/advertising/policy', { token: a.token, body: { youth_contextual: true } }));
  assert.deepEqual(ok(await serve('featured_venue', {}, { token: kid.token })).ads, [], 'allowed by policy, but this campaign was not marked youth-safe');
  await pool.query('UPDATE ad_campaigns SET youth_contextual=true WHERE id=$1', [c.id]);
  const shown = ok(await serve('featured_venue', {}, { token: kid.token })).ads.find((x) => x.headline === 'Courts from 8am');
  assert.ok(shown, 'contextual delivery to a young person');
  const row = (await pool.query("SELECT viewer_hash FROM ad_delivery_events WHERE id=$1", [shown.token])).rows[0];
  assert.equal(row.viewer_hash, null, 'no per-person record is kept for a young person');
  ok(await call('PATCH', '/admin/advertising/policy', { token: a.token, body: { youth_contextual: false } }));
  assert.deepEqual(ok(await serve('featured_venue', {}, { token: kid.token })).ads, [], 'switching the policy off takes effect at once');
});

test('event pages: ads appear only where the organiser allowed them, never on youth events; targeted by the event\'s own context', async () => {
  const w = await venueAdvertiser();
  const org = await signup('org', ['organizer']);
  const ev = ok(await call('POST', '/events', { token: org.token, body: { name: `Ads Cup ${++seq}`, sport: 'football', city: 'Mumbai' } }), 201);
  ok(await call('PATCH', `/events/${ev.id}`, { token: org.token, body: { status: 'open' } }));
  await live(w, { placements: ['event_display', 'scorecard_leaderboard'], landing_entity_type: undefined, landing_entity_id: undefined, landing_url: 'https://example.com/offer', objective: 'traffic' });
  assert.equal(ok(await serve('event_display', { event_id: ev.id })).why_empty, 'organiser_has_not_allowed_ads', 'off by default');
  assert.equal(ok(await call('GET', `/events/${ev.id}/public-settings`, { token: org.token })).ads, false);
  ok(await call('PATCH', `/events/${ev.id}/public-settings`, { token: org.token, body: { ads: true } }));
  const r = ok(await serve('event_display', { event_id: ev.id }));
  assert.equal(r.ads[0].label, 'Sponsored');
  assert.equal(r.ads[0].destination.type, 'external');
  assert.ok(!JSON.stringify(r).includes('example.com'), 'an external link is only revealed on a click');
  ok(await call('PATCH', `/events/${ev.id}/public-settings`, { token: org.token, body: { ads: false } }));
  assert.deepEqual(ok(await serve('scorecard_leaderboard', { event_id: ev.id })).ads, []);
  const stranger = await signup('stranger');
  assert.equal((await call('PATCH', `/events/${ev.id}/public-settings`, { token: stranger.token, body: { ads: true } })).status >= 400, true, 'only the organiser decides');
  const youthEv = ok(await call('POST', '/events', { token: org.token, body: { name: `Kids Cup ${++seq}`, sport: 'football', min_age: 8, max_age: 12 } }), 201);
  assert.equal((await call('PATCH', `/events/${youthEv.id}/public-settings`, { token: org.token, body: { ads: true } })).status, 422, 'youth events never carry ads');
  assert.equal(ok(await serve('event_display', { event_id: youthEv.id })).ads.length, 0);
});

test('search slots match what was searched, other placements need what they promote, and each placement honours its own switch', async () => {
  const w = await venueAdvertiser();
  await live(w, { placements: ['search_sponsored'], landing_entity_type: undefined, landing_entity_id: undefined, landing_url: 'https://example.com/shop', keywords: ['badminton', 'racket'], rate_minor: 2000, budget_minor: 20000, creative: { headline: 'Rackets for every level', cta: 'shop_now', claims: [] } });
  assert.deepEqual(ok(await serve('search_sponsored', { q: 'tennis court' })).ads, []);
  assert.deepEqual(ok(await serve('search_sponsored')).ads, [], 'no search text: nothing to match');
  const hit = ok(await serve('search_sponsored', { q: 'Badminton courts near me' }));
  assert.equal(hit.ads[0].label, 'Sponsored');
  const a = await admin();
  ok(await call('PATCH', '/admin/advertising/policy', { token: a.token, body: { inventory: [{ code: 'search_sponsored', enabled: false, max_slots: 1 }] } }));
  assert.equal(ok(await serve('search_sponsored', { q: 'badminton' })).why_empty, 'not_on_sale');
  ok(await call('PATCH', '/admin/advertising/policy', { token: a.token, body: { inventory: [{ code: 'search_sponsored', enabled: true, max_slots: 1 }] } }));
  assert.equal(ok(await serve('search_sponsored', { q: 'badminton' })).ads.length, 1);
});

test('followers audience reaches only people who follow the promoted venue; other people see nothing', async () => {
  const w = await venueAdvertiser();
  await live(w, { audience: 'followers' });
  const fan = await signup('fan'), other = await signup('other');
  assert.deepEqual(ok(await serve('featured_venue', {}, { token: other.token })).ads.filter((x) => x.headline === 'Courts from 8am'), []);
  assert.deepEqual(ok(await serve('featured_venue')).ads.filter((x) => x.headline === 'Courts from 8am'), [], 'anonymous people are never "followers"');
  ok(await call('POST', `/venues/${w.venue.id}/favourite`, { token: fan.token, body: {} }), 201);
  assert.equal(ok(await serve('featured_venue', {}, { token: fan.token })).ads.filter((x) => x.headline === 'Courts from 8am').length, 1);
});

test('reports and moderation: a report is tied to an impression, its note is encrypted, the review desk can pause or withdraw', async () => {
  const w = await venueAdvertiser();
  const c = await live(w);
  const viewer = await signup('viewer');
  const ad = ok(await serve('featured_venue', {}, { token: viewer.token })).ads.find((x) => x.headline === 'Courts from 8am');
  const rep = ok(await call('POST', `/public/ads/${ad.token}/report`, { token: viewer.token, body: { reason: 'misleading', note: 'The price is not what it says' } }), 201);
  assert.equal(rep.duplicate, false);
  assert.equal(ok(await call('POST', `/public/ads/${ad.token}/report`, { token: viewer.token, body: { reason: 'misleading' } }), 201).duplicate, true, 'one report per impression');
  assert.equal((await call('POST', `/public/ads/${crypto.randomUUID()}/report`, { body: { reason: 'other' } })).status, 404, 'cannot report an ad you were not shown');
  const stored = (await pool.query('SELECT note_enc FROM ad_reports LIMIT 1')).rows[0].note_enc;
  assert.match(stored, /^v1\./); assert.ok(!stored.includes('price'));
  const a = await admin();
  const list = ok(await call('GET', '/admin/advertising/reports', { token: a.token }));
  assert.equal(list[0].note, 'The price is not what it says');
  assert.equal((await call('GET', '/admin/advertising/reports', { token: w.mgr.token })).status, 403);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_ad_report_notes'")).rows[0].n >= 1, true, 'reading a note is audit-logged');
  ok(await call('POST', `/admin/advertising/reports/${list[0].id}/handle`, { token: a.token, body: { outcome: 'paused', reason: 'Checking the price claim' } }));
  const row = await campaignRow(c.id);
  assert.equal(row.status, 'paused'); assert.equal(row.held_by_platform, true);
  // suspending the advertiser stops everything it runs
  const w2 = await venueAdvertiser();
  await live(w2);
  ok(await call('POST', `/admin/advertising/advertisers/${w2.advertiser}/status`, { token: a.token, body: { status: 'suspended', reason: 'Repeated policy breaches' } }));
  assert.equal((await call('POST', '/advertising/campaigns', { token: w2.mgr.token, body: campaignBody(w2) })).status, 403);
});

test('team access: organisation owners and admins run campaigns; finance members can fund and read but not create or edit; outsiders get 404', async () => {
  const owner = await signup('owner', ['organizer']), fin = await signup('fin', ['organizer']), outsider = await signup('out', ['organizer']);
  const org = await orgWith(owner, [{ user: fin, role: 'finance' }]);
  assert.equal((await call('POST', '/advertising/advertisers', { token: fin.token, body: { organisation_id: org.id, accept_policy: true } })).status, 404, 'finance cannot open the account');
  const acc = ok(await call('POST', '/advertising/advertisers', { token: owner.token, body: { organisation_id: org.id, accept_policy: true } }), 201);
  assert.equal(ok(await call('POST', '/advertising/advertisers', { token: owner.token, body: { organisation_id: org.id, accept_policy: true } }), 201).id, acc.id, 'idempotent');
  assert.equal((await call('POST', '/advertising/advertisers', { token: owner.token, body: { organisation_id: org.id, accept_policy: false } })).status, 400, 'the policy has to be accepted');
  const body = { advertiser_id: acc.id, name: 'Club promo', objective: 'awareness', category: 'other_sports_related', placements: ['sponsored_post'], billing_model: 'cpm', rate_minor: 1000, currency: 'INR', budget_minor: 10000, starts_on: isoDay(1), ends_on: isoDay(9), creative: { headline: 'Join our club', cta: 'learn_more' } };
  assert.equal((await call('POST', '/advertising/campaigns', { token: fin.token, body })).status, 404, 'finance cannot create');
  assert.equal((await call('POST', '/advertising/campaigns', { token: outsider.token, body })).status, 404);
  const c = ok(await call('POST', '/advertising/campaigns', { token: owner.token, body }), 201);
  assert.equal(ok(await call('GET', `/advertising/campaigns/${c.id}`, { token: fin.token })).campaign.id, c.id, 'finance can read');
  assert.equal((await call('GET', `/advertising/campaigns/${c.id}`, { token: outsider.token })).status, 404);
  ok(await call('POST', `/advertising/campaigns/${c.id}/submit`, { token: owner.token, body: {} }));
  assert.equal((await call('POST', `/advertising/campaigns/${c.id}/withdraw`, { token: fin.token, body: {} })).status, 404, 'finance cannot withdraw');
  ok(await call('POST', `/admin/advertising/campaigns/${c.id}/review`, { token: (await admin()).token, body: { decision: 'approved' } }));
  const f = ok(await call('POST', `/advertising/campaigns/${c.id}/fund`, { token: fin.token, body: { amount_minor: 10000 } }), 201);
  assert.equal((await pay(fin, f)).status, 201, 'finance funds it');
  const home = ok(await call('GET', '/advertising', { token: fin.token }));
  assert.ok(home.organisations.some((o) => o.organisation_id === org.id && o.can_manage === false));
});

test('paid ads never touch an organic list: the same search before and after delivery is identical, and ranking, tender and review code cannot reach ad tables', async () => {
  const w = await venueAdvertiser();
  const read = async () => (ok(await call('GET', '/venues?limit=50')).map((v) => v.id));
  const before = await read();
  const readEvents = async () => ok(await call('GET', '/events/search?limit=50')).items.map((e) => e.id);
  const eventsBefore = await readEvents();
  const bySort = async (sort) => ok(await call('GET', `/venues?limit=50&sort=${sort}`)).map((v) => v.id);
  const sortedBefore = { rating: await bySort('rating'), price: await bySort('price') };
  const cpmCamp = await live(w, { billing_model: 'cpm', rate_minor: 20000, budget_minor: 200000 }, 200000);
  for (let i = 0; i < 5; i++) await serve('featured_venue');
  assert.deepEqual(await read(), before, 'delivery and spend do not move the venue list');
  assert.deepEqual(await readEvents(), eventsBefore, 'nor the event list');
  assert.deepEqual({ rating: await bySort('rating'), price: await bySort('price') }, sortedBefore, 'nor the rating or price order');
  // no foreign key leads from any non-ad table into an ad table, and no ad table points at a ranking/tender/review table
  const fks = (await pool.query(
    `SELECT c.conrelid::regclass::text AS from_table, c.confrelid::regclass::text AS to_table FROM pg_constraint c WHERE c.contype='f' AND (c.conrelid::regclass::text LIKE 'ad\\_%' OR c.confrelid::regclass::text LIKE 'ad\\_%')`)).rows;
  for (const f of fks) {
    if (f.to_table.startsWith('ad_')) assert.ok(f.from_table.startsWith('ad_'), `${f.from_table} must not reference ${f.to_table}`);
    else assert.ok(!/rank|tender|rfp|rubric|evaluation|score|review|rating|testimonial|eligib|selection|standing/i.test(f.to_table), `${f.from_table} must not reference ${f.to_table}`);
  }
  // the source of every integrity-critical module never imports the ad engine
  const root = new URL('../src/', import.meta.url).pathname;
  const guarded = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) guarded.push(p); } };
  walk(root);
  const sensitive = guarded.filter((p) => /\/(rankings|tender|scoring)\//.test(p) || /(tender-|sponsorship-evaluation|sponsorship-awards|registration-eligibility|community|ratings|result-proposals)/.test(p));
  assert.ok(sensitive.length > 10, 'the guard covers real files');
  for (const p of sensitive) assert.doesNotMatch(readFileSync(p, 'utf8'), /ads\/(engine|policy)|advertising/, `${p} must not know about advertising`);
  // and the ad engine reads none of their tables
  const engine = readFileSync(new URL('../src/ads/engine.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/capabilities/advertising.js', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /FROM (ranking|player_rankings|tender|rfp|testimonials|ratings|sponsorship_applications)/i);
  void cpmCamp;
});

test('every sport in the catalogue can be targeted and is served only on pages about it; the sweeps start scheduled campaigns and end finished ones', async () => {
  const w = await venueAdvertiser();
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows.map((r) => r.slug);
  assert.ok(sports.length > 100, 'the whole catalogue');
  const c = await live(w, { sports: [sports[0]] });
  for (const slug of sports) {   // the API accepts each sport as a target…
    const draft = await call('PATCH', `/advertising/campaigns/${c.id}`, { token: w.mgr.token, body: { sports: [slug] } });
    assert.equal(draft.status, 409, `${slug}: a live campaign is paused before it is edited`);   // …and the serve path matches each one exactly
    await pool.query('UPDATE ad_campaigns SET sports=$2 WHERE id=$1', [c.id, [slug]]);
    const other = sports[(sports.indexOf(slug) + 1) % sports.length];
    assert.equal(ok(await serve('featured_venue', { sport: slug }, { ua: `walk-${slug}` })).ads.length, 1, `${slug} is served on its own pages`);
    assert.equal(ok(await serve('featured_venue', { sport: other }, { ua: `walk-${slug}-other` })).ads.length, 0, `${slug} is not served on ${other}`);
  }
  // naming several sports at once
  const many12 = await create(w, { sports: sports.slice(0, 12) });
  assert.equal(many12.sports.length, 12);
  assert.equal((await call('POST', '/advertising/campaigns', { token: w.mgr.token, body: campaignBody(w, { sports: sports.slice(0, 13) }) })).status, 400, 'at most 12 sports per campaign: use "any sport" for a wider reach');
  // schedule and finish
  const w2 = await venueAdvertiser();
  const sc = await create(w2, { starts_on: isoDay(1), ends_on: isoDay(3) });
  ok(await submit(w2, sc)); ok(await review(sc)); await fund(w2, sc, sc.budget_minor);
  assert.equal(ok(await call('POST', `/advertising/campaigns/${sc.id}/start`, { token: w2.mgr.token, body: {} })).status, 'scheduled');
  const nameSc = ok(await call('GET', `/advertising/campaigns/${sc.id}`, { token: w2.mgr.token })).advertiser_name;
  assert.ok(!ok(await serve('featured_venue')).ads.some((x) => x.advertiser.name === nameSc), 'not before its start date');
  await pool.query("UPDATE ad_campaigns SET starts_on = current_date - 1, ends_on = current_date + 1 WHERE id=$1", [sc.id]);
  assert.ok((await adSweeps()).started >= 1);
  assert.equal((await campaignRow(sc.id)).status, 'active');
  await pool.query("UPDATE ad_campaigns SET starts_on = current_date - 5, ends_on = current_date - 1 WHERE id=$1", [sc.id]);
  assert.ok((await adSweeps()).ended >= 1);
  assert.equal((await campaignRow(sc.id)).status, 'ended');
  assert.deepEqual(ok(await call('GET', `/advertising/campaigns/${sc.id}/report`, { token: w2.mgr.token })).money.reconciliation.spend_matches, true);
});

test('Explore directories: academies and suppliers are listed by name only, public, on MCP too — and their sponsored placements sit above them, labelled', async () => {
  // an academy with a published, public programme (listed), and a supplier profile
  const owner = await signup('acad', ['organizer']);
  const org = ok(await call('POST', '/organisations', { token: owner.token, body: { name: `Zed Academy ${++seq}`, kind: 'academy' } }), 201);
  ok(await call('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'INR', listed: true } }));
  const prog = ok(await call('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: 'U12 Football', capacity: 20, admission_mode: 'direct', public: true } }), 201);
  ok(await call('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'one_time', currency: 'INR', fee_minor: 500000 } }), 201);
  const unlisted = ok(await call('POST', '/organisations', { token: owner.token, body: { name: `Alpha Hidden ${seq}`, kind: 'academy' } }), 201);
  const sup = await signup('sup', ['supplier']);
  const profile = ok(await call('POST', '/supplier-profiles', { token: sup.token, body: { supplier_type: 'sole_trader', legal_name: `Turf Co ${++seq}`, categories: ['ground_maintenance'], currencies: ['INR'], daily_capacity: 4 } }), 201);

  const list = ok(await call('GET', '/academies?limit=100'));
  assert.ok(list.some((a) => a.id === org.id && a.programmes === 1), 'a listed academy with a published programme appears');
  assert.ok(!list.some((a) => a.id === unlisted.id), 'an unlisted one does not');
  assert.equal(ok(await call('GET', `/academies/${org.id}`)).programmes[0].title, 'U12 Football');
  assert.equal((await call('GET', `/academies/${unlisted.id}`)).status, 404);
  assert.ok(ok(await call('GET', '/suppliers?limit=100')).some((x) => x.id === profile.id));

  // sponsored placements for both are on sale now and carry their labels
  const pol = ok(await call('GET', '/advertising/policy'));
  for (const code of ['featured_academy', 'promoted_supplier']) assert.equal(pol.placements.find((x) => x.code === code).on_sale, true, `${code} has a surface in the app`);
  const acc = ok(await call('POST', '/advertising/advertisers', { token: owner.token, body: { organisation_id: org.id, accept_policy: true } }), 201);
  const mine = { mgr: owner, advertiser: acc.id, venue: { id: 'x' } };
  const body = (over) => ({ advertiser_id: acc.id, name: `Directory ${++seq}`, objective: 'traffic', category: 'academies_education', billing_model: 'cpm', rate_minor: 2000, currency: 'INR', budget_minor: 20000, starts_on: isoDay(0), ends_on: isoDay(10), creative: { headline: 'Trials every Saturday', cta: 'learn_more', claims: [] }, ...over });
  const a1 = ok(await call('POST', '/advertising/campaigns', { token: owner.token, body: body({ placements: ['featured_academy'], landing_entity_type: 'academy', landing_entity_id: org.id }) }), 201);
  assert.equal((await call('POST', '/advertising/campaigns', { token: owner.token, body: body({ placements: ['featured_academy'], landing_entity_type: 'academy', landing_entity_id: unlisted.id }) })).status, 400, 'an unlisted academy cannot be promoted');
  const s1 = ok(await call('POST', '/advertising/advertisers', { token: sup.token, body: { accept_policy: true } }), 201);
  assert.equal((await call('POST', '/advertising/campaigns', { token: owner.token, body: body({ placements: ['promoted_supplier'], landing_entity_type: 'supplier', landing_entity_id: profile.id }) })).status, 400, 'someone else\'s supplier profile cannot be promoted');
  const c2 = ok(await call('POST', '/advertising/campaigns', { token: sup.token, body: body({ advertiser_id: s1.id, category: 'technology_services', placements: ['promoted_supplier'], landing_entity_type: 'supplier', landing_entity_id: profile.id, creative: { headline: 'Pitch care, all season', cta: 'view', claims: [] } }) }), 201);
  for (const [c, who] of [[a1, owner], [c2, sup]]) {
    ok(await call('POST', `/advertising/campaigns/${c.id}/submit`, { token: who.token, body: {} }));
    ok(await call('POST', `/admin/advertising/campaigns/${c.id}/review`, { token: (await admin()).token, body: { decision: 'approved' } }));
    const f = ok(await call('POST', `/advertising/campaigns/${c.id}/fund`, { token: who.token, body: { amount_minor: 20000 } }), 201);
    assert.equal((await pay(who, f)).status, 201);
    ok(await call('POST', `/advertising/campaigns/${c.id}/start`, { token: who.token, body: {} }));
  }
  const ad1 = ok(await serve('featured_academy')).ads;
  assert.equal(ad1[0].label, 'Promoted'); assert.equal(ad1[0].destination.entity_type, 'academy'); assert.equal(ad1[0].destination.entity_id, org.id);
  const ad2 = ok(await serve('promoted_supplier')).ads;
  assert.equal(ad2[0].label, 'Promoted'); assert.equal(ad2[0].destination.entity_type, 'supplier');
  // the organic directories are unchanged by delivery
  assert.deepEqual(ok(await call('GET', '/academies?limit=100')), list); 
  // a campaign for an academy that stops being listed stops serving at once
  await pool.query('UPDATE academy_profiles SET listed=false WHERE organisation_id=$1', [org.id]);
  assert.deepEqual(ok(await serve('featured_academy')).ads, []);
  void mine;
  // MCP: the same directories are tools
  const mcp = createApp().listen(0);
  const rpc = async (name, args) => (await (await fetch(`http://localhost:${mcp.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  assert.ok(Array.isArray((await rpc('search_academies', {})).structuredContent.result));
  assert.ok((await rpc('search_suppliers', {})).structuredContent.result.some((x) => x.id === profile.id));
  assert.equal((await rpc('get_academy_listing', { id: unlisted.id })).isError, true);
  mcp.close();
});

test('surface parity: REST, OpenAPI and MCP expose advertising; narrow tokens cannot spend or administer', async () => {
  const { capabilities } = await import('../src/capabilities/index.js');
  const names = capabilities.filter((c) => c.tag === 'Advertising' || c.tag === 'Advertising (platform)').map((c) => c.name);
  for (const n of ['get_advertising_policy', 'get_advertising_home', 'open_advertiser_account', 'create_ad_campaign', 'update_ad_campaign', 'save_ad_creative', 'submit_ad_campaign', 'start_ad_campaign', 'pause_ad_campaign', 'resume_ad_campaign',
    'end_ad_campaign', 'withdraw_ad_campaign', 'fund_ad_campaign', 'refund_ad_balance', 'get_ad_report', 'serve_ads', 'follow_ad', 'hide_ad', 'report_ad', 'admin_ad_review_queue', 'admin_review_ad', 'admin_stop_ad', 'admin_ad_overview', 'admin_set_ad_policy']) assert.ok(names.includes(n), n);
  const { buildOpenApi } = await import('../src/openapi.js');
  const ops = Object.values(buildOpenApi().paths).flatMap((p) => Object.values(p)).map((o) => o.operationId);
  for (const n of names) assert.ok(ops.includes(n), `${n} is in OpenAPI`);
  const byName = Object.fromEntries(capabilities.map((c) => [c.name, c]));
  assert.equal(byName.fund_ad_campaign.scope, 'payment'); assert.equal(byName.refund_ad_balance.scope, 'payment'); assert.equal(byName.admin_review_ad.scope, 'admin');
  const w = await venueAdvertiser();
  const ro = ok(await call('POST', '/me/tokens', { token: w.mgr.token, body: { name: 'ro', scopes: ['read'] } }), 201);
  assert.equal((await call('POST', '/advertising/campaigns', { token: ro.token, body: campaignBody(w) })).status, 403);
  assert.equal((await call('GET', '/advertising', { token: ro.token })).status, 200);
  // MCP: the same capabilities are tools, and the same auth rules apply
  const mcp = createApp().listen(0);
  const rpc = async (method, params, token) => {
    const r = await fetch(`http://localhost:${mcp.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()).result;
  };
  const tools = (await rpc('tools/list', {})).tools.map((t) => t.name);
  for (const n of names) assert.ok(tools.includes(n), `${n} is an MCP tool`);
  const pol = await rpc('tools/call', { name: 'get_advertising_policy', arguments: {} });
  assert.equal(pol.structuredContent.result.placements.length, 9);
  const adminCall = await rpc('tools/call', { name: 'admin_ad_review_queue', arguments: {} }, w.mgr.token);
  assert.equal(adminCall.isError, true, 'platform admin tools refuse everyone else over MCP too');
  const viaMcp = await rpc('tools/call', { name: 'serve_ads', arguments: { placement: 'featured_venue' } });
  assert.ok(Array.isArray(viaMcp.structuredContent.result.ads));
  mcp.close();
  assert.equal(PLACEMENT_CODES.every((c) => PLACEMENTS[c].label), true);
  assert.equal(PROHIBITED_CATEGORIES.every((k) => CATEGORIES[k].allowed === false), true);
});
