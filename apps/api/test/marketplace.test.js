import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Sports Services & Opportunity Marketplace (#600): three provider families (coach, official, club organisation) complete the whole lifecycle
// through one framework, plus the access, credential, payment, review, schedule and catalogue-walk rules.
const fake = { sessions: {}, n: 0 };
const stripe = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(), send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/v1/checkout/sessions' && req.method === 'POST') {
    const f = new URLSearchParams(raw); const id = `cs_${++fake.n}`;
    fake.sessions[id] = { id, amount_total: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]'), name: f.get('line_items[0][price_data][product_data][name]'), payment_status: 'unpaid', payment_intent: `pi_${fake.n}` };
    return send(200, { id, url: `https://checkout.stripe.test/${id}` });
  }
  if (req.url.startsWith('/v1/checkout/sessions/')) { const s = fake.sessions[req.url.split('/').pop()]; return s ? send(200, s) : send(404, { error: { message: 'no such session' } }); }
  send(404, {});
});
await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`, APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { FAMILIES } = await import('../src/marketplace/families.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `mp_${n}_${roles[0]}`, display_name: `Market ${n}`, email: `mp${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const verify = (u, type) => pool.query("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ($1,'user',$2,$2,'approved',1,now(), now() + interval '300 days')", [type, u.id]);
const at = (days, hour = 10) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const list = (u, body) => api('POST', '/marketplace/listings', { token: u.token, body });
const download = async (u, url) => { const r = await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${u.token}` } }); return { status: r.status, text: Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString() }; };
const E = (id, p) => `/marketplace/engagements/${id}${p ?? ''}`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); stripe.close(); await pool.end(); });

/** The whole lifecycle for one provider, driven only through the shared capabilities. */
async function lifecycle({ provider, listing, buyer, price, counter }) {
  const l = must(await list(provider, listing));
  const found = must(await api('GET', '/marketplace/search', { query: { family: listing.family } }));
  assert.ok(found.results.some((r) => r.id === l.id), 'discoverable');
  assert.equal(found.paid_placement_affects_results, false);
  must(await api('POST', `/marketplace/listings/${l.id}/shortlist`, { token: buyer.token, body: { note: 'compare later' } }), 201);
  assert.equal(must(await api('GET', '/me/marketplace/shortlist', { token: buyer.token })).length >= 1, true);

  const e = must(await api('POST', '/marketplace/engagements', { token: buyer.token, body: { listing_id: l.id, title: `Need ${listing.family}`, brief: 'private brief about my needs', budget_minor: price + 10000 } }), 201);
  assert.equal(e.status, 'requested');
  assert.equal(e.brief, 'private brief about my needs');
  assert.equal((await api('POST', '/marketplace/engagements', { token: buyer.token, body: { listing_id: l.id, title: 'again please' } })).status, 409, 'one open request per listing');
  assert.equal((await api('GET', E(e.id), { token: (await signup()).token })).status, 404, 'outsiders do not learn it exists');

  assert.equal((await api('POST', E(e.id, '/quotes'), { token: buyer.token, body: { amount_minor: 100 } })).status, 409, 'the provider quotes first');
  must(await api('POST', E(e.id, '/messages'), { token: buyer.token, body: { body: 'Can you do it?' } }), 201);
  must(await api('POST', E(e.id, '/quotes'), { token: provider.token, body: { amount_minor: price + 5000, terms: 'Two sessions' } }), 201);
  assert.equal((await api('POST', E(e.id, '/quotes'), { token: provider.token, body: { amount_minor: 1 } })).status, 409, 'turns alternate');
  assert.equal((await api('POST', E(e.id, '/accept'), { token: provider.token })).status, 409, 'cannot accept your own offer');
  must(await api('POST', E(e.id, '/quotes'), { token: buyer.token, body: { amount_minor: counter } }), 201);
  must(await api('POST', E(e.id, '/quotes'), { token: provider.token, body: { amount_minor: price } }), 201);
  const accepted = must(await api('POST', E(e.id, '/accept'), { token: buyer.token }));
  assert.equal(accepted.status, 'contracted');
  assert.equal(Number(accepted.agreed_minor), price);
  assert.match(accepted.contract_number, /^MC-\d+$/);
  assert.equal(accepted.terms_sha256.length, 64);

  assert.equal((await api('POST', E(e.id, '/documents'), { token: buyer.token, body: { type: 'invoice' } })).status, 409, 'no invoice before delivery is accepted');
  const agreement = must(await api('POST', E(e.id, '/documents'), { token: buyer.token, body: { type: 'agreement' } }), 201);
  assert.deepEqual([(await download(buyer, agreement.url)).text, (await download(provider, agreement.url)).text], ['%PDF-', '%PDF-'], 'both parties can open the agreement');
  assert.equal((await download(await signup(), agreement.url)).status, 404, 'outsiders cannot');
  must(await api('POST', E(e.id, '/schedule'), { token: provider.token, body: { starts_at: at(7), ends_at: at(7, 12) } }));
  const buyerScheduleHas = must(await api('GET', '/me/sport-schedule', { token: buyer.token, query: { from: at(6).slice(0, 10), to: at(9).slice(0, 10) } }));
  assert.ok(JSON.stringify(buyerScheduleHas).includes(e.id), 'scheduled work shows in the buyer\'s calendar');
  assert.equal((await api('POST', E(e.id, '/deliver'), { token: buyer.token, body: {} })).status, 403, 'only the provider delivers');
  must(await api('POST', E(e.id, '/deliver'), { token: provider.token, body: { note: 'done' } }));
  const inv = must(await api('POST', E(e.id, '/accept-delivery'), { token: buyer.token }));
  assert.equal(inv.status, 'invoiced');
  assert.match(inv.invoice_number, /^MK[A-Z0-9]{8}-\d{4}-\d{6}$/, 'a gapless provider invoice number');
  const row = (await pool.query('SELECT id, status, total_cents, user_id FROM invoices WHERE marketplace_engagement_id=$1', [e.id])).rows[0];
  assert.deepEqual([row.status, Number(row.total_cents), row.user_id], ['open', price, buyer.id], 'a row of the shared invoices table');
  assert.equal(must(await api('GET', `/invoices/${row.id}`, { token: buyer.token })).number, inv.invoice_number, 'the buyer reads it through get_invoice');
  assert.ok(must(await api('GET', '/invoices', { token: buyer.token })).some((x) => x.number === inv.invoice_number), 'and lists it');
  const invDoc = must(await api('POST', E(e.id, '/documents'), { token: provider.token, body: { type: 'invoice' } }), 201);
  assert.equal((await download(buyer, invDoc.url)).text, '%PDF-');

  assert.equal((await api('POST', '/payments', { token: provider.token, body: { purpose_type: 'marketplace_engagement', purpose_id: e.id, provider: 'stripe' } })).status, 403, 'only the buyer pays');
  const pay = must(await api('POST', '/payments', { token: buyer.token, body: { purpose_type: 'marketplace_engagement', purpose_id: e.id, provider: 'stripe' } }), 201);
  assert.equal(pay.amount_cents, price);
  fake.sessions[pay.checkout_url.split('/').pop()].payment_status = 'paid';
  assert.equal(must(await api('POST', `/payments/${pay.id}/confirm`, { token: buyer.token })).status, 'paid');
  const paid = must(await api('GET', E(e.id), { token: buyer.token }));
  assert.equal(paid.status, 'paid');
  assert.equal(paid.invoice.status, 'paid');
  assert.equal((await pool.query('SELECT status FROM invoices WHERE marketplace_engagement_id=$1', [e.id])).rows[0].status, 'paid', 'the shared invoice is paid with it');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM marketplace_contract_signatures WHERE engagement_id=$1', [e.id])).rows[0].n, 2, 'both parties signed the frozen terms');
  const ledger = (await pool.query("SELECT kind, amount_cents FROM provider_ledger WHERE purpose_type='marketplace_engagement' AND purpose_id=$1 AND seller_id=$2 ORDER BY kind", [e.id, provider.id])).rows;
  assert.ok(ledger.some((r) => r.kind === 'commission' || Number(r.amount_cents) > 0), 'provider ledger posted through canonical finance');

  const rev = must(await api('POST', '/testimonials', { token: buyer.token, body: { subject_type: 'user', subject_id: provider.id, rating: 5, body: 'Delivered exactly as agreed' } }), 201);
  assert.equal(rev.verification, 'verified_interaction');
  const done = must(await api('GET', E(e.id), { token: buyer.token }));
  assert.equal(done.status, 'reviewed');
  assert.equal(must(await api('GET', E(e.id, '/messages'), { token: provider.token }))[0].body, 'Can you do it?');
  const tl = done.events.map((x) => x.kind);
  for (const k of ['requested', 'quote', 'counter', 'contracted', 'scheduled', 'delivered', 'invoiced', 'reviewed']) assert.ok(tl.includes(k), `timeline has ${k}`);
  return { listing: l, engagement: done };
}

test('coach, official and club organisation each complete the whole marketplace lifecycle', async () => {
  const buyer = await signup(['athlete']);

  const coach = await signup(['coach']); await verify(coach, 'coach');
  await lifecycle({ provider: coach, buyer, price: 150000, counter: 120000, listing: { family: 'coach', headline: 'Season coaching block', sports: ['football'], city: 'Pune', rate_min_minor: 50000, rate_unit: 'session' } });

  const ref = await signup(['referee']); await verify(ref, 'referee');
  await lifecycle({ provider: ref, buyer, price: 80000, counter: 60000, listing: { family: 'official', headline: 'Match officiating, all grades', sports: ['football'], city: 'Pune' } });

  const owner = await signup(['organizer']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Hill Town FC', kind: 'club' } }), 201);
  await lifecycle({ provider: owner, buyer, price: 200000, counter: 150000, listing: { family: 'club', organisation_id: org.id, headline: 'Friendly fixtures and squad hire', sports: ['football'] } });
});

test('credentials gate the contract, are shown in search, and expire', async () => {
  const buyer = await signup();
  const coach = await signup(['coach']);   // no verified credential
  const l = must(await list(coach, { family: 'coach', headline: 'Unverified coach', city: 'Goa' }));
  const open = must(await api('GET', '/marketplace/search', { query: { family: 'coach', city: 'Goa' } }));
  assert.equal(open.results.find((r) => r.id === l.id).credential_verified, false);
  assert.equal(must(await api('GET', '/marketplace/search', { query: { family: 'coach', city: 'Goa', verified: 'true' } })).results.length, 0);
  const e = must(await api('POST', '/marketplace/engagements', { token: buyer.token, body: { listing_id: l.id, title: 'Coaching' } }), 201);
  must(await api('POST', E(e.id, '/quotes'), { token: coach.token, body: { amount_minor: 1000 } }), 201);
  const r = await api('POST', E(e.id, '/accept'), { token: buyer.token });
  assert.equal(r.status, 409);
  assert.match(r.body.error?.message ?? JSON.stringify(r.body), /credential/);
  await verify(coach, 'coach');
  assert.equal(must(await api('POST', E(e.id, '/accept'), { token: buyer.token })).status, 'contracted');
  await pool.query("UPDATE verification_cases SET expires_at=now() - interval '1 day' WHERE subject_id=$1", [coach.id]);
  assert.equal(must(await api('GET', '/marketplace/search', { query: { family: 'coach', city: 'Goa', verified: 'true' } })).results.length, 0, 'expired credential drops out of verified search');
});

test('rules: roles, ownership, scheduling conflicts, cancel/decline, expiry, money, youth, organic order', async () => {
  const buyer = await signup(), outsider = await signup();
  assert.equal((await list(buyer, { family: 'coach', headline: 'I am not a coach' })).status, 400, 'family needs its role');
  assert.equal((await list(buyer, { family: 'club', headline: 'No organisation given' })).status, 400, 'club lists through an organisation');
  assert.equal((await list(await signup(['supplier']), { family: 'supplier', headline: 'Rate without unit', rate_min_minor: 10 })).status, 400);
  assert.equal((await api('GET', '/marketplace/search')).status, 200, 'search is public');

  const sup = await signup(['supplier']);
  assert.equal((await list(sup, { family: 'supplier', headline: 'Ground crew', rate_min_minor: 10000, rate_max_minor: 5000, rate_unit: 'day' })).status, 400, 'top rate below bottom rate');
  const good = must(await list(sup, { family: 'supplier', headline: 'Ground crew', sports: ['cricket'], city: 'Delhi', rate_min_minor: 5000, rate_max_minor: 10000, rate_unit: 'day' }));
  assert.equal((await api('POST', `/marketplace/listings/${good.id}/shortlist`, { token: sup.token })).status, 409, 'not your own');
  assert.equal((await api('POST', '/marketplace/engagements', { token: sup.token, body: { listing_id: good.id, title: 'Self deal' } })).status, 400, 'cannot engage yourself');

  const e1 = must(await api('POST', '/marketplace/engagements', { token: buyer.token, body: { listing_id: good.id, title: 'Cricket ground prep' } }), 201);
  must(await api('POST', E(e1.id, '/quotes'), { token: sup.token, body: { amount_minor: 9000, valid_until: new Date(Date.now() + 864e5).toISOString().slice(0, 10) } }), 201);
  await pool.query("UPDATE marketplace_quotes SET valid_until = current_date - 1 WHERE engagement_id=$1", [e1.id]);
  assert.equal((await api('POST', E(e1.id, '/accept'), { token: buyer.token })).status, 409, 'expired offer');
  must(await api('POST', E(e1.id, '/quotes'), { token: buyer.token, body: { amount_minor: 8000 } }), 201);
  must(await api('POST', E(e1.id, '/accept'), { token: sup.token }));
  assert.equal((await api('POST', E(e1.id, '/decline'), { token: sup.token, body: { reason: 'too late now' } })).status, 409, 'cannot decline contracted work (cancel instead)');
  must(await api('POST', E(e1.id, '/schedule'), { token: buyer.token, body: { starts_at: at(10), ends_at: at(10, 12) } }));

  const e2 = must(await api('POST', '/marketplace/engagements', { token: outsider.token, body: { listing_id: good.id, title: 'Second job same day' } }), 201);
  must(await api('POST', E(e2.id, '/quotes'), { token: sup.token, body: { amount_minor: 7000 } }), 201);
  must(await api('POST', E(e2.id, '/accept'), { token: outsider.token }));
  assert.equal((await api('POST', E(e2.id, '/schedule'), { token: outsider.token, body: { starts_at: at(10, 11), ends_at: at(10, 13) } })).status, 409, 'provider already booked');
  assert.equal(must(await api('GET', '/marketplace/search', { query: { family: 'supplier', available_on: at(10).slice(0, 10) } })).results.length, 0, 'booked day drops out of available_on search');
  assert.equal(must(await api('GET', '/marketplace/search', { query: { family: 'supplier', available_on: at(12).slice(0, 10) } })).results.length, 1);
  must(await api('POST', E(e2.id, '/cancel'), { token: outsider.token, body: { reason: 'plans changed' } }));
  assert.equal((await api('POST', E(e2.id, '/messages'), { token: outsider.token, body: { body: 'hello?' } })).status, 409, 'closed engagements are read-only');

  // delivered work cannot be paid by anyone else, nor before it is invoiced
  assert.equal((await api('POST', '/payments', { token: buyer.token, body: { purpose_type: 'marketplace_engagement', purpose_id: e1.id, provider: 'stripe' } })).status, 409, 'not payable before it is invoiced');
});

test('encryption at rest, youth block, opportunity hand-off and a zero-value agreement', async () => {
  const buyer = await signup(), prov = await signup(['supplier']);
  const l = must(await list(prov, { family: 'supplier', headline: 'Catering', city: 'Chennai' }));
  const e = must(await api('POST', '/marketplace/engagements', { token: buyer.token, body: { listing_id: l.id, title: 'Match-day catering', brief: 'secret brief text' } }), 201);
  const row = (await pool.query('SELECT brief_enc FROM marketplace_engagements WHERE id=$1', [e.id])).rows[0];
  assert.ok(row.brief_enc && !row.brief_enc.includes('secret'), 'brief stored encrypted');
  must(await api('POST', E(e.id, '/messages'), { token: buyer.token, body: { body: 'secret message text' } }), 201);
  assert.ok(!(await pool.query('SELECT body_enc FROM marketplace_messages WHERE engagement_id=$1', [e.id])).rows[0].body_enc.includes('secret'));
  const audited = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='marketplace.read_text' AND entity_id=$1", [e.id]);
  assert.ok(audited.rows[0].n >= 1, 'decrypted reads are audit-logged');

  // zero-value agreement: delivery acceptance closes it as paid, no checkout
  must(await api('POST', E(e.id, '/quotes'), { token: prov.token, body: { amount_minor: 0 } }), 201);
  must(await api('POST', E(e.id, '/accept'), { token: buyer.token }));
  must(await api('POST', E(e.id, '/schedule'), { token: buyer.token, body: { starts_at: at(20) } }));
  must(await api('POST', E(e.id, '/deliver'), { token: prov.token, body: {} }));
  assert.equal(must(await api('POST', E(e.id, '/accept-delivery'), { token: buyer.token })).status, 'paid');

  // a child cannot list or engage
  const kid = await signup(['coach']);
  await pool.query("UPDATE users SET youth_until = current_date + 400 WHERE id=$1", [kid.id]);
  assert.equal((await list(kid, { family: 'coach', headline: 'Teen coach' })).status, 403);
  assert.equal((await api('POST', '/marketplace/engagements', { token: kid.token, body: { listing_id: l.id, title: 'Child request' } })).status, 403);

  // opportunity hand-off (#67): the author of an accepted response engages the responder
  const poster = await signup(['sponsor']), responder = await signup(['athlete']);
  const post = (await pool.query("INSERT INTO billboard_posts(author_id, kind, title) VALUES ($1,'sponsor_call','Back our academy') RETURNING id", [poster.id])).rows[0];
  const resp = (await pool.query("INSERT INTO billboard_responses(post_id, responder_id, message, status) VALUES ($1,$2,'We are interested','pending') RETURNING id", [post.id, responder.id])).rows[0];
  const body = { opportunity_response_id: resp.id, family: 'athlete', title: 'Appearance at launch' };
  assert.equal((await api('POST', '/marketplace/engagements', { token: poster.token, body })).status, 409, 'accept the response first');
  await pool.query("UPDATE billboard_responses SET status='accepted' WHERE id=$1", [resp.id]);
  assert.equal((await api('POST', '/marketplace/engagements', { token: responder.token, body })).status, 404, 'only the post author');
  const fromOpp = must(await api('POST', '/marketplace/engagements', { token: poster.token, body }), 201);
  assert.equal(fromOpp.provider.id, responder.id);
  assert.equal((await api('POST', '/marketplace/engagements', { token: poster.token, body })).status, 409, 'one engagement per response');
});

test('catalogue walk: every provider family can be listed, found and engaged', async () => {
  const buyer = await signup();
  const cat = must(await api('GET', '/marketplace/catalogue'));
  assert.deepEqual(cat.families.map((f) => f.slug), FAMILIES.map((f) => f.slug));
  assert.equal(cat.stages.length, 9);
  for (const f of FAMILIES) {
    const roles = f.roles.length ? [f.roles[0]] : ['athlete'];
    const u = await signup(roles);
    let org;
    if (f.org) org = must(await api('POST', '/organisations', { token: u.token, body: { name: `Org ${f.slug} ${n}`, kind: 'club' } }), 201);
    const l = must(await list(u, { family: f.slug, headline: `${f.label} listing`, ...(org ? { organisation_id: org.id } : {}) }));
    assert.ok(must(await api('GET', '/marketplace/search', { query: { family: f.slug } })).results.some((r) => r.id === l.id), `${f.slug} discoverable`);
    assert.equal(must(await api('GET', `/marketplace/listings/${l.id}`)).credential_type, f.credential, `${f.slug} credential rule`);
    const e = must(await api('POST', '/marketplace/engagements', { token: buyer.token, body: { listing_id: l.id, title: `Engage ${f.slug}` } }), 201);
    assert.equal(e.family, f.slug);
  }
  assert.equal((await api('GET', '/marketplace/search', { query: { family: 'nonsense' } })).status, 400);
});

test('every sport in the catalogue can be offered and found (the marketplace is sport-agnostic)', async () => {
  const slugs = must(await api('GET', '/sports')).map((x) => x.slug);
  assert.ok(slugs.length > 100, 'the whole catalogue is walked');
  const u = await signup(['coach']);
  const l = must(await list(u, { family: 'coach', headline: 'All sports coach', sports: slugs }));
  assert.equal(l.sport_ids.length, slugs.length);
  for (const slug of slugs) assert.ok(must(await api('GET', '/marketplace/search', { query: { family: 'coach', sport: slug } })).results.some((r) => r.id === l.id), `${slug} searchable`);
  assert.equal((await list(u, { family: 'coach', headline: 'Bad sport', sports: ['not-a-sport'] })).status, 400);
});

test('service requests are #67 posts: providers with a listing respond, the accepted response becomes the engagement', async () => {
  const buyer = await signup(), prov = await signup(['athlete']), outsider = await signup();
  const post = must(await api('POST', '/billboard', { token: buyer.token, body: { kind: 'service_request', title: 'Photographer for the league final', body: 'Full day coverage', budget_cents: 500000, currency: 'INR', city: 'Mumbai' } }), 201);
  assert.equal(post.opportunity_type, 'service');
  assert.equal(post.compensation, 'paid');
  assert.equal((await api('POST', '/billboard', { token: buyer.token, body: { kind: 'service_request', title: 'Wrong type used', opportunity_type: 'trial' } })).status, 400);
  assert.equal((await api('POST', '/billboard', { token: buyer.token, body: { kind: 'assignment', title: 'Service type misuse', opportunity_type: 'service' } })).status, 400);
  const r = await api('POST', `/billboard/${post.id}/responses`, { token: prov.token, body: { message: 'I can cover it' } });
  assert.equal(r.status, 409, 'a provider must list first');
  assert.match(r.body.error.message, /List your services/);
  must(await list(prov, { family: 'media', headline: 'Sports photography', city: 'Mumbai' }));
  const resp = must(await api('POST', `/billboard/${post.id}/responses`, { token: prov.token, body: { message: 'I can cover it' } }), 201);
  assert.equal((await api('POST', `/billboard/${post.id}/responses`, { token: outsider.token, body: {} })).status, 409);
  must(await api('PATCH', `/billboard/responses/${resp.id}`, { token: buyer.token, body: { status: 'accepted' } }));
  const e = must(await api('POST', '/marketplace/engagements', { token: buyer.token, body: { opportunity_response_id: resp.id, family: 'media', title: 'League final photography' } }), 201);
  assert.equal(Number(e.budget_minor), 500000, 'the budget of the post carries over');
  const link = (await pool.query('SELECT engagement_type, engagement_id FROM billboard_responses WHERE id=$1', [resp.id])).rows[0];
  assert.deepEqual([link.engagement_type, link.engagement_id], ['marketplace_engagement', e.id], 'the response points at the canonical engagement');
});
