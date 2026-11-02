import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { addDays, fromLocal } = await import('../src/booking/time.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `as_${n}_${roles[0]}`, display_name: `As ${n}`, email: `as${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const today = new Date().toISOString().slice(0, 10);
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function academyWithVenues() {
  const owner = await signup(['venue_manager']), ops = await signup(), staff = await signup(), outsider = await signup(['venue_manager']);
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Supplier Academy ${n}`, kind: 'academy' } }), 201);
  for (const [u, role] of [[ops, 'staff'], [staff, 'staff']]) {
    ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  }
  const venues = [];
  for (const name of ['North Ground', 'South Hall', 'East Pool']) {
    const v = ok(await api('POST', '/venues', { token: owner.token, body: { name: `${name} ${n}`, city: 'Pune', timezone: 'UTC', currency: 'INR' } }), 201);
    ok(await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'venue', asset_id: v.id } }));
    venues.push(v);
  }
  // one staff member may manage suppliers (operations template), the other only has schedule access
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${ops.id}`, { token: owner.token, body: { job_title: 'Operations', template: 'operations' } }));
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${staff.id}`, { token: owner.token, body: { job_title: 'Scheduler', template: 'custom', permissions: ['schedule'] } }));
  return { owner, ops, staff, outsider, org, venues };
}

test('a supplier can serve every venue or chosen venues, contacts are encrypted, and venue filters see the right ones', async () => {
  const a = await academyWithVenues();
  const base = `/organisations/${a.org.id}/academy/suppliers`;
  const all = ok(await api('POST', base, { token: a.owner.token, body: { kind: 'maintenance', name: 'Turf Care', all_venues: true, email: 'turf@example.com', phone: '+91 99999 00000', contact_name: 'Asha' } }), 201);
  const some = ok(await api('POST', base, { token: a.owner.token, body: { kind: 'sporting_goods', name: 'Kit House', venue_ids: [a.venues[0].id, a.venues[1].id] } }), 201);
  const raw = (await pool.query('SELECT email_enc, phone_enc FROM academy_suppliers WHERE id=$1', [all.id])).rows[0];
  assert.ok(raw.email_enc && !raw.email_enc.includes('turf@example.com') && !raw.phone_enc.includes('99999'), 'contacts are stored encrypted');
  const names = async (q) => ok(await api('GET', `${base}${q}`, { token: a.owner.token })).map((s) => s.name).sort();
  assert.deepEqual(await names(''), ['Kit House', 'Turf Care']);
  assert.deepEqual(await names(`?venue_id=${a.venues[0].id}`), ['Kit House', 'Turf Care']);
  assert.deepEqual(await names(`?venue_id=${a.venues[2].id}`), ['Turf Care'], 'Kit House does not serve the pool');
  assert.deepEqual(await names('?kind=sporting_goods'), ['Kit House']);
  const listed = ok(await api('GET', base, { token: a.owner.token })).find((s) => s.name === 'Turf Care');
  assert.equal(listed.email, 'turf@example.com');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_academy_supplier_contacts' AND actor_id=$1", [a.owner.id])).rowCount > 0, 'decrypting contacts is audit-logged');
  // venues of another organisation are refused, and both at once is a 400
  const foreign = ok(await api('POST', '/venues', { token: a.outsider.token, body: { name: 'Elsewhere', city: 'Pune', timezone: 'UTC', currency: 'INR' } }), 201);
  assert.equal((await api('POST', base, { token: a.owner.token, body: { kind: 'other', name: 'X', venue_ids: [foreign.id] } })).status, 404);
  assert.equal((await api('POST', base, { token: a.owner.token, body: { kind: 'other', name: 'X', all_venues: true, venue_ids: [a.venues[0].id] } })).status, 400);
  // narrowing the scope ends the link but keeps the row; widening to all venues clears the links
  const upd = ok(await api('PATCH', `/academy/suppliers/${some.id}`, { token: a.owner.token, body: { row_version: some.row_version, venue_ids: [a.venues[2].id] } }));
  assert.equal(upd.row_version, 2);
  assert.deepEqual(await names(`?venue_id=${a.venues[0].id}`), ['Turf Care']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_supplier_venues WHERE supplier_id=$1', [some.id])).rows[0].n, 3, 'ended links are kept, not deleted');
  assert.equal((await api('PATCH', `/academy/suppliers/${some.id}`, { token: a.owner.token, body: { row_version: 1, name: 'Stale' } })).status, 409);
  ok(await api('PATCH', `/academy/suppliers/${some.id}`, { token: a.owner.token, body: { row_version: 2, status: 'archived' } }));
  assert.deepEqual(await names(''), ['Turf Care'], 'archived suppliers are hidden but kept');
  assert.equal((await pool.query('SELECT status FROM academy_suppliers WHERE id=$1', [some.id])).rows[0].status, 'archived');
});

test('who may manage suppliers: owner and the suppliers permission write; schedule staff read without contacts; outsiders get 404', async () => {
  const a = await academyWithVenues();
  const base = `/organisations/${a.org.id}/academy/suppliers`;
  const body = { kind: 'maintenance', name: 'Net Menders', email: 'nets@example.com', all_venues: true };
  ok(await api('POST', base, { token: a.ops.token, body }), 201);
  assert.equal((await api('POST', base, { token: a.staff.token, body })).status, 403, 'schedule-only staff cannot add suppliers');
  const seen = ok(await api('GET', base, { token: a.staff.token }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].email, undefined, 'contacts stay hidden without the suppliers permission');
  assert.equal((await api('GET', base, { token: a.outsider.token })).status, 404);
});

test('requests go only to active suppliers that serve the venue, follow the allowed status moves and keep money with a currency', async () => {
  const a = await academyWithVenues();
  const s = ok(await api('POST', `/organisations/${a.org.id}/academy/suppliers`, { token: a.owner.token, body: { kind: 'sporting_goods', name: 'Kit House', venue_ids: [a.venues[0].id] } }), 201);
  const post = (b) => api('POST', `/organisations/${a.org.id}/academy/supplier-requests`, { token: a.owner.token, body: b });
  assert.equal((await post({ supplier_id: s.id, venue_id: a.venues[1].id, title: 'Footballs' })).status, 409, 'the supplier does not serve South Hall');
  assert.equal((await post({ supplier_id: s.id, title: 'Cones', estimated_cost_minor: 5000 })).status, 400, 'an amount needs a currency');
  const r = ok(await post({ supplier_id: s.id, venue_id: a.venues[0].id, title: 'Match footballs', priority: 'high', currency: 'INR', estimated_cost_minor: 1200000 }), 201);
  const patch = (b) => api('PATCH', `/academy/supplier-requests/${r.id}`, { token: a.owner.token, body: b });
  assert.equal((await patch({ row_version: 1, status: 'done' })).status, 409, 'cannot skip to done');
  const q = ok(await patch({ row_version: 1, status: 'quoted', estimated_cost_minor: 1150000 }));
  const ap = ok(await patch({ row_version: q.row_version, status: 'approved' }));
  const dn = ok(await patch({ row_version: ap.row_version, status: 'delivered', actual_cost_minor: 1150000 }));
  ok(await patch({ row_version: dn.row_version, status: 'done' }));
  assert.equal(ok(await api('GET', `/organisations/${a.org.id}/academy/supplier-requests?open_only=true`, { token: a.owner.token })).length, 0);
  ok(await api('PATCH', `/academy/suppliers/${s.id}`, { token: a.owner.token, body: { row_version: s.row_version, status: 'paused' } }));
  assert.equal((await post({ supplier_id: s.id, venue_id: a.venues[0].id, title: 'More balls' })).status, 409, 'paused suppliers take no new requests');
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/venues`, { token: a.owner.token })).body.length, 3);
});
