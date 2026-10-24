import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

// Guardian-authorized youth sponsorship (#307): authority, acceptance, purpose permissions, revocation and isolation.
let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `ys_${n}_${roles[0]}`, display_name: `Youth ${n}`, email: `ys${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100', ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const evidence = { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' };
async function verifiedGuardian(parent, child) {
  const l = must(await api('POST', '/youth/guardian-links', { token: parent.token, body: { guardian_id: parent.id, child_id: child.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: child.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: parent.token, body: { evidence } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  return l;
}
const world = async ({ authorize = true } = {}) => {
  const sponsor = await signup(['sponsor']), parent = await signup(['athlete']), kid = await signup(['athlete'], { dob: yearsAgo(12) });
  const link = await verifiedGuardian(parent, kid);
  const brand = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `YouthBrand${n}` } }), 201);
  if (authorize) must(await api('POST', `/youth/children/${kid.id}/sponsors`, { token: parent.token, body: { sponsor_id: brand.id } }), 201);
  const offer = (token = sponsor.token) => api('POST', '/sponsorships', { token, body: { sponsor_id: brand.id, target_type: 'athlete', target_id: kid.id, deliverables: 'Wear the kit', starts_on: '2030-01-01', ends_on: '2030-06-30',
    lines: [{ kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 10000, cadence: 'once', first_due_on: '2030-02-01' }] } });
  return { sponsor, parent, kid, link, brand, offer };
};
const decide = (w, who, status = 'active') => api('PATCH', `/sponsorships/${w.deal.id}`, { token: who.token, body: { status, version: 1 } });
const active = async (w) => { w.deal = must(await w.offer(), 201); must(await decide(w, w.parent)); return w; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('ys_root','ys_root','{admin}','x','x','ys_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('a young person is unreachable without a guardian authorization, even if they opted in', async () => {
  const w = await world({ authorize: false });
  must(await api('POST', '/me/sponsorship-profile', { token: w.kid.token, body: { open_to_sponsors: true } }));
  assert.equal((await w.offer()).status, 409, 'opting in never opens the door');
  const found = must(await api('GET', '/sponsorable-athletes', { token: w.sponsor.token }));
  assert.ok(!JSON.stringify(found).includes(w.kid.id), 'discovery still hides young people');
  const stranger = await signup(['athlete']);
  assert.equal((await api('POST', `/youth/children/${w.kid.id}/sponsors`, { token: stranger.token, body: { sponsor_id: w.brand.id } })).status, 403, 'only a verified guardian authorizes');
  assert.equal((await api('POST', `/youth/children/${w.kid.id}/sponsors`, { token: w.kid.token, body: { sponsor_id: w.brand.id } })).status, 403, 'the young person cannot authorize for themselves');
  assert.equal((await w.offer()).status, 409);
});

test('an authorized sponsor can offer; only the verified guardian answers, and the offer reaches guardians not the child', async () => {
  const w = await world();
  const a = must(await api('GET', `/sponsors/${w.brand.id}/youth-authorizations`, { token: w.sponsor.token }));
  assert.deepEqual(a.map((x) => x.athlete_id), [w.kid.id]);
  assert.deepEqual(Object.keys(a[0]).sort(), ['athlete_id', 'created_at', 'display_name', 'id'], 'no contact or guardian data');
  assert.equal((await api('GET', `/sponsors/${w.brand.id}/youth-authorizations`, { token: w.parent.token })).status, 403, 'tenant isolation');
  w.deal = must(await w.offer(), 201);
  const inbox = (u) => pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='sponsorship_offer'", [u.id]).then((r) => r.rows[0].n);
  assert.equal(await inbox(w.parent), 1); assert.equal(await inbox(w.kid), 0, 'the child is not contacted');
  assert.equal((await decide(w, w.kid)).status, 403, 'the young person cannot accept');
  assert.equal((await decide(w, admin)).status, 403, 'a platform admin cannot consent for a minor');
  const unverified = await signup(['athlete']);
  assert.equal((await decide(w, unverified)).status, 403, 'an unverified guardian cannot accept');
  const acc = must(await decide(w, w.parent));
  assert.equal(acc.status, 'active'); assert.equal(acc.visibility, 'private');
  const row = (await pool.query('SELECT guardian_id, guardian_decided_at FROM sponsorships WHERE id=$1', [w.deal.id])).rows[0];
  assert.equal(row.guardian_id, w.parent.id); assert.ok(row.guardian_decided_at);
  const d = must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.parent.token }));
  assert.equal(d.role, 'recipient'); assert.equal(d.youth.guardian_acting, true); assert.equal(d.youth.media_allowed, false, 'the agreement implies no image consent');
  const mine = must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.kid.token }));
  assert.equal(mine.youth.minor_self, true, 'the young person can read it');
  assert.equal(mine.negotiation.can_counter, false, 'and is not offered actions that would be refused');
  const list = must(await api('GET', '/sponsorships', { token: w.parent.token, query: { as: 'target' } }));
  assert.ok(list.some((x) => x.id === w.deal.id), 'the guardian sees their child\'s deals');
});

test('a stale version cannot be accepted and an unverified guardian\'s authority never counts', async () => {
  const w = await world();
  w.deal = must(await w.offer(), 201);
  must(await api('POST', `/sponsorships/${w.deal.id}/revise`, { token: w.sponsor.token, body: { lines: [{ kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 12000, cadence: 'once', first_due_on: '2030-02-01' }] } }));
  assert.equal((await decide(w, w.parent)).status, 409, 'v1 is stale');
  const res = await api('PATCH', `/sponsorships/${w.deal.id}`, { token: w.parent.token, body: { status: 'active', version: 2 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('sharing results is the guardian\'s decision and stops when their authority ends', async () => {
  const w = await active(await world());
  const share = (u, enabled = true) => api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: u.token, body: { enabled } });
  const read = () => api('GET', `/sponsorships/${w.deal.id}/performance`, { token: w.sponsor.token });
  assert.equal((await share(w.kid)).status, 403, 'the young person cannot switch sharing on');
  assert.equal((await share(w.sponsor)).status, 403);
  assert.equal((await read()).status, 403, 'nothing shared yet');
  must(await share(w.parent));
  assert.equal((await read()).status, 200);
  // the guardian relationship is revoked: sponsor reads stop at once, history stays
  must(await api('POST', `/youth/guardian-links/${w.link.id}/revoke`, { token: w.parent.token, body: { reason: 'no longer guardian' } }));
  assert.equal((await read()).status, 403, 'revoked authority blocks future reads');
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}`, { token: w.sponsor.token })).status, 200, 'the agreement is still there');
  assert.equal((await share(w.parent)).status, 403, 'the former guardian can no longer act');
});

test('withdrawing the sponsor blocks future sponsor actions but keeps the agreement and money', async () => {
  const w = await active(await world());
  assert.equal(must(await api('POST', `/youth/children/${w.kid.id}/sponsors`, { token: w.parent.token, body: { sponsor_id: w.brand.id } }), 201).created, false, 'authorizing twice is idempotent');
  must(await api('POST', `/sponsorships/${w.deal.id}/performance-access`, { token: w.parent.token, body: { enabled: true } }));
  must(await api('DELETE', `/youth/children/${w.kid.id}/sponsors/${w.brand.id}`, { token: w.parent.token }));
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}/performance`, { token: w.sponsor.token })).status, 403);
  assert.equal((await api('POST', `/sponsorships/${w.deal.id}/comments`, { token: w.sponsor.token, body: { body: 'hi' } })).status, 403, 'no authority, no sponsor messages');
  assert.equal((await w.offer()).status, 409, 'no new offers');
  const ob = (await api('GET', '/sponsorship-obligations', { token: w.parent.token })).body;
  assert.ok(ob.obligations.length >= 1, 'financial history survives, and the guardian sees it');
  const list = must(await api('GET', `/youth/children/${w.kid.id}/sponsors`, { token: w.parent.token }));
  assert.equal(list[0].status, 'withdrawn'); assert.equal(list[0].agreements, 1);
  assert.equal((await api('GET', `/youth/children/${w.kid.id}/sponsors`, { token: (await signup()).token })).status, 404);
});

test('media and contact stay separate permissions from the agreement', async () => {
  const w = await active(await world());
  const ob = (await pool.query('SELECT o.id FROM sponsorship_obligations o WHERE o.sponsorship_id=$1', [w.deal.id])).rows;
  const objective = { sport: 'athletics', metric: '100m_time_s', direction: 'lower', target_value: 12, window_start: '2030-01-01', window_end: '2030-03-01' };
  assert.equal((await api('POST', `/sponsorships/${w.deal.id}/objectives`, { token: w.sponsor.token, body: objective })).status, 409, 'no contact consent, no sponsor messages');
  must(await api('POST', `/youth/children/${w.kid.id}/consents`, { token: w.parent.token, body: { purpose: 'contact' } }), 201);
  must(await api('POST', `/sponsorships/${w.deal.id}/objectives`, { token: w.sponsor.token, body: objective }), 201);
  assert.ok(ob.length >= 1);
  const d = must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.parent.token }));
  assert.equal(d.youth.contact_allowed, true); assert.equal(d.youth.media_allowed, false);
});

test('young people cannot act on an agreement with a guardian, and unrelated people see nothing', async () => {
  const w = await active(await world());
  const stranger = await signup(['athlete']);
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}`, { token: stranger.token })).status, 403);
  const o = (await pool.query('SELECT id FROM sponsorship_obligations WHERE sponsorship_id=$1 LIMIT 1', [w.deal.id])).rows[0];
  const pay = must(await api('POST', `/sponsorship-obligations/${o.id}/payments`, { token: w.sponsor.token, body: { amount_cents: 10000, currency: 'SGD', reference: 'TT-1', paid_on: '2030-02-01', method: 'bank_transfer' } }), 201);
  assert.equal((await api('PATCH', `/sponsorship-payments/${pay.id}`, { token: w.kid.token, body: { status: 'confirmed' } })).status, 403, 'the young person cannot confirm money');
  assert.equal((await api('PATCH', `/sponsorship-payments/${pay.id}`, { token: w.parent.token, body: { status: 'confirmed' } })).status, 200, 'the guardian is the payee side');
});
