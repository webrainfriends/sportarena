import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `dp_${n}_${roles[0]}`, display_name: `Dp ${n}`, email: `dp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const newEvent = async (org) => (await api('POST', '/events', { token: org.token, body: { name: `Dept Cup ${++n}`, sport: 'football' } })).body;
const newDept = async (org, ev, extra = {}) => {
  const d = await api('POST', `/events/${ev.id}/departments`, { token: org.token, body: { name: `Dept ${++n}`, kind: 'medical', ...extra } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  return d.body;
};

test('only the organiser creates departments; names are unique per event', async () => {
  const org = await signup(['organizer']), other = await signup(['organizer']);
  const ev = await newEvent(org);
  assert.equal((await api('POST', `/events/${ev.id}/departments`, { token: other.token, body: { name: 'Medical', kind: 'medical' } })).status, 403);
  const d = await newDept(org, ev, { name: 'Medical Cover', colour: '#22D3EE' });
  assert.equal(d.colour, '#22D3EE');
  assert.equal((await api('POST', `/events/${ev.id}/departments`, { token: org.token, body: { name: 'medical cover' } })).status, 409);
  assert.equal((await api('POST', `/events/${ev.id}/departments`, { token: org.token, body: { name: 'Bad colour', colour: 'red' } })).status, 400);
  const kinds = await api('GET', '/department-kinds');
  assert.ok(kinds.body.some((k) => k.key === 'volunteers'));
});

test('invite, accept with personal details, roster hides them unless asked; reads are audited and values encrypted at rest', async () => {
  const org = await signup(['organizer']), vol = await signup(['athlete']), nosy = await signup(['athlete']);
  const ev = await newEvent(org);
  const d = await newDept(org, ev, { kind: 'volunteers' });
  const inv = await api('POST', `/departments/${d.id}/members`, { token: org.token, body: { user_id: vol.id, title: 'Gate marshal' } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal((await api('POST', `/departments/${d.id}/members`, { token: org.token, body: { user_id: vol.id } })).status, 409);
  assert.equal((await api('POST', `/department-members/${inv.body.id}/respond`, { token: nosy.token, body: { accept: true } })).status, 404, 'only the invitee can answer');
  const mine = await api('GET', '/me/department-invites', { token: vol.token });
  assert.equal(mine.body[0].status, 'invited');
  const ok = await api('POST', `/department-members/${inv.body.id}/respond`, { token: vol.token, body: { accept: true, phone: '+919800000001', dob: '2004-05-17', id_number: 'AB1234567' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'active');
  assert.equal((await api('POST', `/department-members/${inv.body.id}/respond`, { token: vol.token, body: { accept: true } })).status, 409);

  const raw = (await pool.query('SELECT phone_enc, dob_enc, id_number_enc, id_number_idx FROM event_department_members WHERE id=$1', [inv.body.id])).rows[0];
  for (const v of [raw.phone_enc, raw.dob_enc, raw.id_number_enc]) assert.match(v, /^v1\./);
  assert.ok(!JSON.stringify(raw).includes('AB1234567') && !JSON.stringify(raw).includes('9800000001'));
  assert.ok(raw.id_number_idx);

  const before = Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='read_roster_pii'")).rows[0].count);
  const plain = await api('GET', `/events/${ev.id}/roster`, { token: org.token });
  assert.equal(plain.status, 200);
  assert.equal(plain.body[0].phone, undefined);
  assert.deepEqual(plain.body[0].has_details, { phone: true, dob: true, id_number: true });
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='read_roster_pii'")).rows[0].count), before, 'no audit row without a decrypted read');
  const full = await api('GET', `/events/${ev.id}/roster?include_pii=true`, { token: org.token });
  assert.equal(full.body[0].id_number, 'AB1234567');
  assert.equal(full.body[0].phone, '+919800000001');
  assert.equal(Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='read_roster_pii'")).rows[0].count), before + 1);
  assert.equal((await api('GET', `/events/${ev.id}/roster`, { token: nosy.token })).status, 403, 'outsiders see nothing');
  const own = await api('GET', `/events/${ev.id}/roster?include_pii=true`, { token: vol.token });
  assert.equal(own.status, 200);
  assert.equal(own.body[0].phone, undefined, 'a plain member never gets others\' details');
});

test('a lead runs their department only; accreditation needs an ID on file', async () => {
  const org = await signup(['organizer']), lead = await signup(['coach']), m1 = await signup(['athlete']), m2 = await signup(['athlete']);
  const ev = await newEvent(org);
  const a = await newDept(org, ev, { lead_user_id: lead.id }), b = await newDept(org, ev);
  const li = (await api('GET', '/me/department-invites', { token: lead.token })).body[0];
  assert.equal(li.role, 'lead');
  await api('POST', `/department-members/${li.id}/respond`, { token: lead.token, body: { accept: true } });
  const inv = await api('POST', `/departments/${a.id}/members`, { token: lead.token, body: { user_id: m1.id } });
  assert.equal(inv.status, 201);
  assert.equal((await api('POST', `/departments/${b.id}/members`, { token: lead.token, body: { user_id: m2.id } })).status, 403, 'not their department');
  assert.equal((await api('POST', `/departments/${a.id}/members`, { token: lead.token, body: { user_id: m2.id, role: 'lead' } })).status, 403, 'only the organiser appoints leads');
  assert.equal((await api('PATCH', `/departments/${a.id}`, { token: lead.token, body: { archived: true } })).status, 403);
  await api('POST', `/department-members/${inv.body.id}/respond`, { token: m1.token, body: { accept: true } });
  assert.equal((await api('POST', `/department-members/${inv.body.id}/accreditation`, { token: lead.token, body: { status: 'issued' } })).status, 409);
  await api('PATCH', `/department-members/${inv.body.id}/details`, { token: m1.token, body: { id_number: 'ZX99' } });
  const acc = await api('POST', `/department-members/${inv.body.id}/accreditation`, { token: lead.token, body: { status: 'issued' } });
  assert.equal(acc.body.accreditation, 'issued');
  const full = await api('GET', `/events/${ev.id}/roster?department_id=${a.id}&include_pii=true`, { token: lead.token });
  assert.equal(full.status, 200);
  assert.ok(full.body.some((r) => r.id_number === 'ZX99'));
  const led = await api('GET', `/events/${ev.id}/departments`, { token: lead.token });
  assert.deepEqual(led.body.map((d) => d.id), [a.id], 'a lead only lists their own');
});

test('leaving or archiving keeps the records', async () => {
  const org = await signup(['organizer']), p = await signup(['athlete']);
  const ev = await newEvent(org);
  const d = await newDept(org, ev, { kind: 'media' });
  const inv = (await api('POST', `/departments/${d.id}/members`, { token: org.token, body: { user_id: p.id } })).body;
  await api('POST', `/department-members/${inv.id}/respond`, { token: p.token, body: { accept: true } });
  const left = await api('POST', `/department-members/${inv.id}/leave`, { token: p.token, body: {} });
  assert.equal(left.body.status, 'left');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_department_members WHERE id=$1', [inv.id])).rows[0].n, 1, 'row kept');
  const re = await api('POST', `/departments/${d.id}/members`, { token: org.token, body: { user_id: p.id } });
  assert.equal(re.status, 201, 'can be invited again after leaving');
  const arch = await api('PATCH', `/departments/${d.id}`, { token: org.token, body: { archived: true } });
  assert.equal(arch.body.status, 'archived');
  assert.ok(arch.body.archived_at);
  assert.equal((await api('GET', `/events/${ev.id}/departments`, { token: org.token })).body.length, 0);
  assert.equal((await api('GET', `/events/${ev.id}/departments?include_archived=true`, { token: org.token })).body.length, 1);
  assert.equal((await api('POST', `/departments/${d.id}/members`, { token: org.token, body: { user_id: org.id } })).status, 409, 'archived');
});
