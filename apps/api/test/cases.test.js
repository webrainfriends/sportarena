import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin, admin2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cs_${n}_${roles[0]}`, display_name: `Case ${n}`, email: `cs${n}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const mkAdmin = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
const PDF = Buffer.from('%PDF-1.4 fake evidence body').toString('base64');
const open = (u, body) => api('POST', '/cases', { token: u.token, body: { kind: 'support', category: 'technical', subject: 'App will not load', description: 'It crashes on start', ...body } });
const A = (a, id, action, body) => api('POST', `/admin/cases/${id}/${action}`, { token: a.token, body });
const mkPayment = async (userId) => (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency, status) VALUES ($1,'stripe','shop_order',gen_random_uuid(),1500,'INR','paid') RETURNING id", [userId])).rows[0].id;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  admin = await mkAdmin('cs_root'); admin2 = await mkAdmin('cs_root2');
});
after(async () => { server.close(); await pool.end(); });

test('categories are public and describe SLA targets', async () => {
  const r = must(await api('GET', '/cases/categories'));
  assert.ok(r.kinds.dispute.includes('booking_charge') && r.kinds.support.includes('technical'));
  assert.equal(r.sla_hours.urgent.first_response, 2);
});

test('raise a ticket: case number, validation, encrypted thread, private to the requester', async () => {
  const u = await signup(), other = await signup();
  assert.equal((await open(u, { category: 'booking_charge' })).status, 400); // dispute category on a support ticket
  assert.equal((await open(u, { kind: 'dispute', category: 'refund' })).status, 400); // dispute needs a link
  const c = must(await open(u, { priority: 'high', evidence: [{ label: 'Screenshot', data: PDF, file_name: 's.pdf' }] }), 201);
  assert.equal(c.status, 'open'); assert.ok(Number(c.case_no) > 0);
  const raw = (await pool.query('SELECT body_enc FROM case_messages WHERE case_id=$1', [c.id])).rows[0].body_enc;
  assert.ok(!raw.includes('crashes on start') && raw.startsWith('v1.'));
  assert.equal((await api('GET', `/cases/${c.id}`, { token: other.token })).status, 404);
  assert.equal((await api('POST', `/cases/${c.id}/replies`, { token: other.token, body: { body: 'hi' } })).status, 404);
  const mine = must(await api('GET', '/me/cases', { token: u.token }));
  assert.deepEqual(mine.map((x) => x.id), [c.id]);
  assert.deepEqual(must(await api('GET', '/me/cases', { token: other.token })), []);
  const g = must(await api('GET', `/cases/${c.id}`, { token: u.token }));
  assert.equal(g.thread[0].body, 'It crashes on start'); assert.equal(g.evidence.length, 1); assert.equal(g.sla_state, 'ok');
  assert.equal((await api('GET', '/admin/cases', { token: u.token })).status, 403);
});

test('staff workflow: queue filters, assign, internal notes stay hidden, respond, request info, reply, resolve, reopen', async () => {
  const u = await signup();
  const c = must(await open(u, { subject: 'Wrong court shown', category: 'bookings', priority: 'high' }), 201);
  const q = must(await api('GET', '/admin/cases', { token: admin.token, query: { priority: 'high', q: 'Wrong court' } }));
  assert.deepEqual(q.map((x) => x.id), [c.id]);
  assert.equal(must(await api('GET', '/admin/cases', { token: admin.token, query: { assignee: 'unassigned', q: String(c.case_no) } })).length, 1);
  assert.equal(must(await api('GET', '/admin/cases', { token: admin.token, query: { assignee: 'me', q: 'Wrong court' } })).length, 0);

  must(await A(admin, c.id, 'triage', { priority: 'urgent' }));
  assert.equal(must(await api('GET', '/admin/cases', { token: admin.token, query: { assignee: 'me', q: 'Wrong court' } })).length, 1);
  assert.equal((await A(admin, c.id, 'triage', { assignee_id: u.id })).status, 400); // only team members
  must(await A(admin, c.id, 'notes', { body: 'Looks like a venue config error' }), 201);
  must(await A(admin, c.id, 'respond', { body: 'Which venue was it?', request_info: true }), 201);

  let g = must(await api('GET', `/cases/${c.id}`, { token: u.token }));
  assert.equal(g.status, 'awaiting_user');
  assert.ok(!JSON.stringify(g).includes('venue config error'), 'internal note must not reach the requester');
  assert.ok(g.thread.every((m) => m.visibility === 'public'));
  assert.ok(!g.history.some((h) => h.action === 'internal_note' || h.action === 'triage'));
  assert.ok(g.history.some((h) => h.action === 'request_info'));
  const gs = must(await api('GET', `/cases/${c.id}`, { token: admin2.token }));
  assert.ok(gs.thread.some((m) => m.visibility === 'internal'));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_case' AND entity_id=$1", [c.id])).rowCount >= 1);
  const notes = (await pool.query("SELECT body FROM notifications WHERE user_id=$1 AND kind='case_update'", [u.id])).rows;
  assert.ok(notes.length >= 1 && notes.every((x) => !/venue/i.test(x.body ?? '')));

  must(await api('POST', `/cases/${c.id}/replies`, { token: u.token, body: { body: 'Arena One' } }), 201);
  assert.equal(must(await api('GET', `/cases/${c.id}`, { token: u.token })).status, 'in_progress');
  must(await A(admin, c.id, 'escalate', { reason: 'Venue data wrong; needs owner', assignee_id: admin2.id }));
  assert.equal((await A(admin, c.id, 'escalate', { reason: 'x' })).status, 400); // reason too short
  must(await A(admin2, c.id, 'resolve', { resolution: 'Venue fixed the court mapping.', action_ref: 'venue-fix-1' }));
  assert.equal((await A(admin2, c.id, 'respond', { body: 'again' })).status, 409);
  assert.equal((await api('POST', `/cases/${c.id}/replies`, { token: u.token, body: { body: 'more' } })).status, 409);
  const done = must(await api('GET', `/cases/${c.id}`, { token: u.token }));
  assert.equal(done.status, 'resolved'); assert.equal(done.resolution, 'Venue fixed the court mapping.');
  assert.deepEqual(done.history.map((h) => h.action), ['open', 'request_info', 'reply', 'escalate', 'resolve']);

  must(await api('POST', `/cases/${c.id}/reopen`, { token: u.token, body: { reason: 'Still wrong on Friday' } }));
  assert.equal(must(await api('GET', `/cases/${c.id}`, { token: u.token })).status, 'open');
  await pool.query("UPDATE cases SET status='resolved', resolved_at=now() - interval '20 days' WHERE id=$1", [c.id]);
  assert.equal((await api('POST', `/cases/${c.id}/reopen`, { token: u.token, body: { reason: 'Too late now' } })).status, 409);
  const ev = (await pool.query('SELECT count(*)::int AS n FROM case_events WHERE case_id=$1', [c.id])).rows[0].n;
  assert.equal(ev, 8); // open, triage, note, request_info, reply, escalate, resolve, reopen
});

test('SLA: breached cases surface first and can be filtered', async () => {
  const u = await signup();
  const c = must(await open(u, { subject: 'SLA probe case' }), 201);
  await pool.query("UPDATE cases SET first_response_due = now() - interval '1 hour' WHERE id=$1", [c.id]);
  const hit = must(await api('GET', '/admin/cases', { token: admin.token, query: { sla: 'breached' } }));
  assert.ok(hit.some((x) => x.id === c.id && x.sla_state === 'breached'));
  must(await A(admin, c.id, 'respond', { body: 'On it' }), 201);
  assert.ok(!must(await api('GET', '/admin/cases', { token: admin.token, query: { sla: 'breached' } })).some((x) => x.id === c.id));
});

test('disputes link canonical records, only for parties; evidence is encrypted and staff reads are audited', async () => {
  const u = await signup(), other = await signup();
  const pay = await mkPayment(u.id);
  assert.equal((await open(other, { kind: 'dispute', category: 'refund', links: [{ type: 'payment', id: pay }] })).status, 404); // not their payment
  const body = { kind: 'dispute', category: 'booking_charge', subject: 'Charged twice', description: 'Two charges', links: [{ type: 'payment', id: pay }], details: { disputed_amount_cents: 1500, currency: 'INR' }, evidence: [{ label: 'Bank line', reference: 'https://bank.example/tx/1' }] };
  const c = must(await open(u, body), 201);
  assert.equal((await open(u, body)).status, 409); // one active dispute per record
  assert.equal((await open(u, { ...body, evidence: [{ reference: 'http://insecure.example' }] })).status, 400);
  const g = must(await api('GET', `/cases/${c.id}`, { token: u.token }));
  assert.deepEqual(g.links, [{ entity_type: 'payment', entity_id: pay }]);
  assert.equal(g.details.disputed_amount_cents, 1500);
  const raw = (await pool.query('SELECT reference_enc FROM case_evidence WHERE case_id=$1', [c.id])).rows[0].reference_enc;
  assert.ok(!raw.includes('bank.example'));
  assert.equal((await api('GET', `/admin/cases/${c.id}/evidence`, { token: u.token })).status, 403);
  const ev = must(await api('GET', `/admin/cases/${c.id}/evidence`, { token: admin.token }));
  assert.equal(ev[0].reference, 'https://bank.example/tx/1');
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE action='read_case_evidence' AND actor_id=$1", [admin.id])).rowCount, 1);
  must(await api('POST', `/cases/${c.id}/withdraw`, { token: u.token, body: {} }));
  must(await open(u, body), 201); // allowed again once the earlier one is closed
});

test('platform staff cannot work their own case', async () => {
  const c = must(await open(admin, { subject: 'Staff own ticket' }), 201);
  assert.equal((await A(admin, c.id, 'respond', { body: 'self' })).status, 403);
  assert.equal((await api('GET', `/admin/cases/${c.id}/evidence`, { token: admin.token })).status, 403);
  must(await A(admin2, c.id, 'respond', { body: 'handled by a colleague' }), 201);
});
