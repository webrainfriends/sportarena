import http from 'node:http';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', APP_URL: 'http://app.test', CORS_ORIGINS: 'http://app.test' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { addDays } = await import('../src/booking/time.js');
const { capabilities } = await import('../src/registry.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `vc_${n}_${roles[0]}`, display_name: `Cmd ${n}`, email: `vc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201);
  return { ...r.body.user, token: r.body.token };
};
const today = new Date().toISOString().slice(0, 10);
async function venue(mgr) {
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: `Cmd Arena ${Math.random().toString(36).slice(2, 6)}`, timezone: 'UTC', currency: 'INR' } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'Court 1', hourly_rate_cents: 100000 } }), 201);
  return { v, court };
}
const book = (resourceId, userId, startsOffsetH, hours, over = {}) => pool.query(
  `INSERT INTO bookings (resource_id, user_id, starts_at, ends_at, quantity, status, base_cents, price_cents, payable_cents, payment_status)
   VALUES ($1,$2, now() + ($3 || ' hours')::interval, now() + ($3::float + $4::float || ' hours')::interval, 1, $5, 100000, 100000, 100000, $6)`,
  [resourceId, userId, String(startsOffsetH), String(hours), over.status ?? 'confirmed', over.pay ?? 'paid']);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('command centre: managers only, outsiders get 403, unknown venue 404', async () => {
  const mgr = await signup(['venue_manager']), other = await signup();
  const { v } = await venue(mgr);
  assert.equal((await api('GET', `/venues/${v.id}/command-centre`, { token: other.token })).status, 403);
  assert.equal((await api('GET', `/venues/00000000-0000-4000-8000-000000000000/command-centre`, { token: mgr.token })).status, 404);
  assert.equal((await api('GET', `/venues/${v.id}/command-centre`)).status, 401);
});

test('command centre: a new venue gets honest empty sections, not invented numbers', async () => {
  const mgr = await signup(['venue_manager']);
  const { v } = await venue(mgr);
  const d = must(await api('GET', `/venues/${v.id}/command-centre`, { token: mgr.token }));
  assert.deepEqual(d.unavailable, []);
  assert.equal(d.kpis.revenue_cents, 0);
  assert.equal(d.kpis.bookings, 0);
  assert.equal(d.facilities.length, 1);
  assert.equal(d.facilities[0].state, 'available');
  assert.deepEqual(d.insights, [], 'no history means no insight');
  assert.equal(d.revenue.projected_month_end_cents === null || typeof d.revenue.projected_month_end_cents === 'number', true);
  assert.deepEqual(d.events, []);
  assert.equal(d.customer.reviews, 0);
  assert.ok(d.attention.some((a) => a.key === 'no_insurance'), 'no insurance on record is flagged');
});

test('command centre: live state, revenue, attention and compliance come from real rows', async () => {
  const mgr = await signup(['venue_manager']), guest = await signup();
  const { v, court } = await venue(mgr);
  await book(court.id, guest.id, -0.5, 1);            // in progress now
  await book(court.id, guest.id, 3, 1, { pay: 'unpaid' }); // later today or tomorrow
  const d1 = must(await api('GET', `/venues/${v.id}/command-centre`, { token: mgr.token }));
  assert.equal(d1.facilities[0].state, 'occupied');
  assert.ok(d1.facilities[0].until);
  assert.ok(d1.revenue.month_to_date_cents >= 100000);

  // maintenance in progress closes the court on the live grid and raises attention
  await pool.query("INSERT INTO venue_maintenance (venue_id, resource_id, title, status, priority, due_on) VALUES ($1,$2,'Resurface','in_progress','urgent', current_date - 2)", [v.id, court.id]);
  const d2 = must(await api('GET', `/venues/${v.id}/command-centre`, { token: mgr.token }));
  assert.deepEqual(d2.unavailable, [], 'every section computed');
  assert.equal(d2.facilities[0].state, 'maintenance');
  assert.ok(d2.attention.some((a) => a.key === 'maintenance_overdue' && a.severity === 0));
  assert.equal(d2.kpis.actions_required, d2.attention.length);

  // compliance: add, expire-soon warning, encrypted reference, audit on reveal, archive instead of delete
  assert.equal((await api('POST', `/venues/${v.id}/compliance`, { token: guest.token, body: { kind: 'fire', title: 'Fire certificate' } })).status, 403);
  const item = must(await api('POST', `/venues/${v.id}/compliance`, { token: mgr.token, body: { kind: 'fire', title: 'Fire certificate', reference: 'FIRE-2291', expires_on: addDays(today, 10) } }), 201);
  const raw = (await pool.query('SELECT reference_enc FROM venue_compliance_items WHERE id=$1', [item.id])).rows[0].reference_enc;
  assert.ok(raw && !raw.includes('FIRE-2291'), 'reference is stored encrypted');
  const hidden = must(await api('GET', `/venues/${v.id}/compliance`, { token: mgr.token }));
  assert.equal(hidden.items.find((x) => x.id === item.id).reference, null);
  assert.equal(hidden.items.find((x) => x.id === item.id).status, 'soon');
  const shown = must(await api('GET', `/venues/${v.id}/compliance`, { token: mgr.token, query: { reveal: 'true' } }));
  assert.equal(shown.items.find((x) => x.id === item.id).reference, 'FIRE-2291');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_pii' AND entity='venue_compliance_items'")).rows[0].n, 1);
  const d3 = must(await api('GET', `/venues/${v.id}/command-centre`, { token: mgr.token }));
  assert.ok(d3.attention.some((a) => a.key === 'compliance_expiring'));
  must(await api('PATCH', `/venues/${v.id}/compliance/${item.id}`, { token: mgr.token, body: { expires_on: addDays(today, 365) } }));
  must(await api('PATCH', `/venues/${v.id}/compliance/${item.id}`, { token: mgr.token, body: { archived: true } }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM venue_compliance_items WHERE id=$1', [item.id])).rows[0].n, 1, 'archived, never deleted');
  const d4 = must(await api('GET', `/venues/${v.id}/command-centre`, { token: mgr.token }));
  assert.ok(!d4.attention.some((a) => a.key === 'compliance_expiring'));
});

test('command centre: reviews awaiting a reply and every capability is registered', async () => {
  const mgr = await signup(['venue_manager']), guest = await signup();
  const { v } = await venue(mgr);
  await pool.query("INSERT INTO testimonials (subject_type, subject_id, author_id, rating, body, status, visibility) VALUES ('venue',$1,$2,2,'Cold showers','published','public')", [v.id, guest.id]).catch(async () => {
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='testimonials'")).rows.map((r) => r.column_name);
    throw new Error(`testimonials insert failed; columns: ${cols.join(',')}`);
  });
  const d = must(await api('GET', `/venues/${v.id}/command-centre`, { token: mgr.token }));
  assert.deepEqual(d.unavailable, []);
  assert.equal(d.customer.awaiting_reply, 1);
  assert.equal(d.customer.rating, 2);
  assert.ok(d.attention.some((a) => a.key === 'review_unanswered' && a.severity === 0), 'a low unanswered review is urgent');
  for (const name of ['venue_command_centre', 'add_venue_compliance_item', 'list_venue_compliance_items', 'update_venue_compliance_item']) assert.ok(capabilities.some((c) => c.name === name), name);
});
