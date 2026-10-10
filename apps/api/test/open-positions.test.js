import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `op_${n}_${roles[0]}`, display_name: `OP ${n}`, email: `op${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const put = (path, token, buf, query = '') => fetch(`${base}/api/v1${path}${query}`, { method: 'PUT', headers: { 'content-type': 'application/pdf', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: buf });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const mkEvent = async (org, extra = {}) => must(await api('POST', '/events', { token: org.token, body: { name: `Cup ${++n}`, sport: 'football', starts_on: day(20), ends_on: day(21), city: 'Pune', ...extra } }), 201);

test('open positions are public; applying needs a login and any user may apply', async () => {
  const org = await signup(['organizer']), fan = await signup(['athlete']);
  const ev = await mkEvent(org);
  const role = must(await api('POST', `/events/${ev.id}/staff-roles`, { token: org.token, body: { role: 'security', needed: 2, fee_cents: 50000, notes: 'Gate duty' } }), 201);
  const hidden = must(await api('POST', `/events/${ev.id}/staff-roles`, { token: org.token, body: { role: 'volunteer', is_public: false } }), 201);

  const list = must(await api('GET', '/open-positions'));
  assert.ok(list.some((p) => p.id === role.id && p.open_places === 2 && p.event_name === ev.name && p.login_required_for.includes('apply')), 'visible to visitors');
  assert.ok(!list.some((p) => p.id === hidden.id), 'private positions are not listed');
  assert.ok(must(await api('GET', '/open-positions', { query: { group: 'vendor' } })).every((p) => p.id !== role.id));
  assert.ok(must(await api('GET', '/open-positions', { query: { q: 'security', city: 'pune' } })).some((p) => p.id === role.id));

  assert.equal((await api('POST', `/staff-roles/${role.id}/apply`, { body: {} })).status, 401, 'login required');
  assert.equal((await api('POST', `/staff-roles/${role.id}/apply`, { token: org.token, body: {} })).status, 409, 'organiser cannot apply to their own event');
  assert.equal((await api('POST', `/staff-roles/${hidden.id}/apply`, { token: fan.token, body: {} })).status, 404);
  const ap = must(await api('POST', `/staff-roles/${role.id}/apply`, { token: fan.token, body: { message: 'Ten years at stadium gates' } }), 201);
  assert.equal(ap.status, 'applied');
  assert.equal((await api('POST', `/staff-roles/${role.id}/apply`, { token: fan.token, body: {} })).status, 409, 'no double applications');
  assert.equal(must(await api('GET', `/open-positions/${role.id}`, { token: fan.token })).my_status, 'applied');
});

test('apply → documents both ways → organiser accepts and a contract is generated → applicant signs', async () => {
  const org = await signup(['organizer']), guard = await signup(['athlete']), other = await signup(['athlete']);
  const ev = await mkEvent(org);
  const role = must(await api('POST', `/events/${ev.id}/staff-roles`, { token: org.token, body: { role: 'security', needed: 1, fee_cents: 50000 } }), 201);
  const ap = must(await api('POST', `/staff-roles/${role.id}/apply`, { token: guard.token, body: { message: 'Hello' } }), 201);

  // documents: applicant and organiser both add and read; a stranger cannot
  assert.equal((await put(`/staff-assignments/${ap.id}/documents`, other.token, pdf, '?title=x')).status, 404);
  assert.equal((await put(`/staff-assignments/${ap.id}/documents`, guard.token, Buffer.from('not a document'), '?title=x')).status, 400);
  const up = await put(`/staff-assignments/${ap.id}/documents`, guard.token, pdf, '?title=Licence');
  assert.equal(up.status, 201);
  const d1 = await up.json();
  assert.equal((await put(`/staff-assignments/${ap.id}/documents`, org.token, pdf, '?title=Brief')).status, 201);
  assert.equal(must(await api('GET', `/staff-assignments/${ap.id}/documents`, { token: org.token })).length, 2);
  assert.equal((await api('GET', `/staff-assignments/${ap.id}/documents`, { token: other.token })).status, 404);
  const dl = await fetch(`${base}/api/v1/staff-documents/${d1.id}/file`, { headers: { authorization: `Bearer ${org.token}` } });
  assert.equal(dl.status, 200); assert.deepEqual(Buffer.from(await dl.arrayBuffer()), pdf);
  assert.equal((await fetch(`${base}/api/v1/staff-documents/${d1.id}/file`, { headers: { authorization: `Bearer ${other.token}` } })).status, 404);
  assert.equal((await api('DELETE', `/staff-documents/${d1.id}`, { token: org.token })).status, 403, 'only the uploader hides it');

  // organiser decision
  assert.equal((await api('POST', `/staff-assignments/${ap.id}/decide`, { token: guard.token, body: { decision: 'accept' } })).status, 403);
  const dec = must(await api('POST', `/staff-assignments/${ap.id}/decide`, { token: org.token, body: { decision: 'accept', fee_cents: 60000, terms: 'Bring ID.' } }));
  assert.equal(dec.assignment.status, 'contract_sent'); assert.equal(dec.contract.status, 'pending');
  assert.match(dec.contract.body, /Bring ID\./); assert.match(dec.contract.body, /600\.00/);
  assert.equal((await api('POST', `/staff-assignments/${ap.id}/decide`, { token: org.token, body: { decision: 'accept' } })).status, 409, 'already decided');

  const mine = must(await api('GET', '/me/staff-assignments', { token: guard.token }));
  assert.equal(mine[0].contract_id, dec.contract.id); assert.equal(mine[0].documents, 2);
  assert.equal((await api('GET', `/event-contracts/${dec.contract.id}`, { token: other.token })).status, 404);
  assert.equal(must(await api('GET', `/event-contracts/${dec.contract.id}`, { token: guard.token })).mine_to_sign, true);
  assert.equal((await api('POST', `/event-contracts/${dec.contract.id}/respond`, { token: org.token, body: { accept: true } })).status, 404, 'only the engaged person signs');
  const signed = must(await api('POST', `/event-contracts/${dec.contract.id}/respond`, { token: guard.token, body: { accept: true } }));
  assert.equal(signed.status, 'signed'); assert.ok(signed.party_signed_at);
  const staff = must(await api('GET', `/events/${ev.id}/staff-assignments`, { token: org.token }));
  assert.equal(staff[0].status, 'accepted'); assert.equal(Number(staff[0].fee_cents), 60000); assert.equal(staff[0].contract_status, 'signed');
  // filled → off the board
  assert.ok(!must(await api('GET', '/open-positions')).some((p) => p.id === role.id));
  assert.equal((await api('POST', `/staff-roles/${role.id}/apply`, { token: other.token, body: {} })).status, 409, 'a filled position takes no more applications');
});

test('rejecting, declining and withdrawing never delete anything; vendor places create a vendor on signing', async () => {
  const org = await signup(['organizer']), shop = await signup(['supplier']), cook = await signup(['supplier']);
  const ev = await mkEvent(org);
  const stall = must(await api('POST', `/events/${ev.id}/staff-roles`, { token: org.token, body: { role: 'retail', title: 'Merch stall', needed: 1, fee_cents: 20000 } }), 201);
  assert.equal(stall.pay_direction, 'applicant_pays');
  const a1 = must(await api('POST', `/staff-roles/${stall.id}/apply`, { token: shop.token, body: {} }), 201);
  const a2 = must(await api('POST', `/staff-roles/${stall.id}/apply`, { token: cook.token, body: {} }), 201);
  assert.equal(must(await api('POST', `/staff-assignments/${a2.id}/decide`, { token: org.token, body: { decision: 'reject', reason: 'Full' } })).assignment.status, 'rejected');
  const d = must(await api('POST', `/staff-assignments/${a1.id}/decide`, { token: org.token, body: { decision: 'accept' } }));
  assert.match(d.contract.body, /pays the Organiser/);
  must(await api('POST', `/event-contracts/${d.contract.id}/respond`, { token: shop.token, body: { accept: true } }));
  const vendors = must(await api('GET', `/events/${ev.id}/vendors`));
  assert.equal(vendors.length, 1); assert.equal(vendors[0].kind, 'retail'); assert.equal(vendors[0].vendor_user_id, shop.id);
  const money = must(await api('GET', `/events/${ev.id}/commercials`, { token: org.token }));
  assert.equal(money.vendors.pitch_fees_cents, 20000); assert.equal(money.staff.cost_cents, 0, 'a vendor fee is income, not crew cost');
  // withdrawing a confirmed vendor ends the vendor place
  must(await api('POST', `/staff-assignments/${a1.id}/end`, { token: shop.token, body: {} }));
  assert.equal(must(await api('GET', `/events/${ev.id}/vendors`, { token: org.token }))[0].status, 'ended');
  // declining a contract reopens the place; the rows stay
  const guard = await signup(), r2 = must(await api('POST', `/events/${ev.id}/staff-roles`, { token: org.token, body: { role: 'volunteer', needed: 1 } }), 201);
  const a3 = must(await api('POST', `/staff-roles/${r2.id}/apply`, { token: guard.token, body: {} }), 201);
  const d3 = must(await api('POST', `/staff-assignments/${a3.id}/decide`, { token: org.token, body: { decision: 'accept' } }));
  must(await api('POST', `/event-contracts/${d3.contract.id}/respond`, { token: guard.token, body: { accept: false } }));
  assert.ok(must(await api('GET', '/open-positions', { query: { event_id: ev.id } })).some((p) => p.id === r2.id), 'place is open again');
  const kept = await pool.query("SELECT status FROM event_staff_assignments WHERE id = ANY($1) ORDER BY created_at", [[a1.id, a2.id, a3.id]]);
  assert.deepEqual(kept.rows.map((r) => r.status).sort(), ['declined', 'rejected', 'withdrawn']);
});
