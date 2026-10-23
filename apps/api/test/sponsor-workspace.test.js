// Sponsor workspace and delegated roles (#283): brand linked to an organisation, staff roles, department scope, revocation, isolation, export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sw_${n}_${roles[0]}`, display_name: `Workspace ${n}`, email: `sw${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 3 };
const period = { starts_on: '2030-01-01', ends_on: '2030-06-30' };

/** A corporate brand: organisation + owner (company), brand linked to it, staff in each role, and one accepted deal. */
const corporate = async () => {
  const owner = await signup(['sponsor']), ath = await signup(['athlete']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Acme ${n}`, kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `Brand ${n}` } }), 201);
  must(await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'sponsor', asset_id: b.id } }));
  const staff = {};
  for (const role of ['manager', 'evaluator', 'finance', 'legal', 'approver', 'auditor']) {
    const u = await signup(['athlete']);
    must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
    must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
    staff[role] = u;
  }
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const deal = must(await api('POST', '/sponsorships', { token: owner.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', ...period, lines: [money] } }), 201);
  return { owner, ath, org, b, staff, deal };
};
const accepted = async (w) => {
  must(await api('PATCH', `/sponsorships/${w.deal.id}`, { token: w.ath.token, body: { status: 'active', version: w.deal.terms_version } }));
  return (await api('GET', '/sponsorship-obligations', { token: w.owner.token, query: { sponsorship_id: w.deal.id } })).body.obligations[0];
};
const pay = (w, who, due, ref = 'REF-1', amount = 1000) => api('POST', `/sponsorship-obligations/${due.id}/payments`, { token: who.token, body: { amount_cents: amount, currency: 'SGD', method: 'bank_transfer', reference: ref, paid_on: '2030-01-14' } });
const revise = (w, who) => api('POST', `/sponsorships/${w.deal.id}/revise`, { token: who.token, body: { lines: [{ ...money, instalments: 2 }], ...period } });
// each proposal goes to a fresh opted-in athlete (a brand may hold only one open offer per athlete)
const propose = async (w, who, extra = {}) => {
  const a = await signup(['athlete']);
  must(await api('POST', '/me/sponsorship-profile', { token: a.token, body: { open_to_sponsors: true } }));
  return api('POST', '/sponsorships', { token: who.token, body: { sponsor_id: w.b.id, target_type: 'athlete', target_id: a.id, deliverables: 'More kit', ...period, lines: [money], ...extra } });
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('role matrix: evaluators cannot pay or sign; finance pays; legal and approver revise terms; auditors only read and export', async () => {
  const w = await corporate();
  const s = w.staff;
  // read: every sponsor role
  for (const role of Object.keys(s)) must(await api('GET', `/sponsorships/${w.deal.id}`, { token: s[role].token }));
  // sign / commit the brand's terms
  assert.equal((await revise(w, s.evaluator)).status, 403, 'evaluator cannot revise terms');
  assert.equal((await revise(w, s.finance)).status, 403);
  assert.equal((await revise(w, s.auditor)).status, 403);
  must(await revise(w, s.legal));
  must(await revise(w, s.approver));
  must(await revise(w, s.manager));
  assert.equal((await propose(w, s.evaluator)).status, 403, 'evaluator cannot propose');
  assert.equal((await propose(w, s.finance)).status, 403);
  assert.equal((await propose(w, s.legal)).status, 403);
  const ok = must(await propose(w, s.approver), 201);
  assert.equal((await api('POST', `/sponsorships/${ok.id}/withdraw`, { token: s.evaluator.token })).status, 403, 'evaluator cannot withdraw');
  must(await api('POST', `/sponsorships/${ok.id}/withdraw`, { token: s.approver.token }));
  // pay
  const cur = (await api('GET', `/sponsorships/${w.deal.id}`, { token: w.owner.token })).body;
  must(await api('PATCH', `/sponsorships/${w.deal.id}`, { token: w.ath.token, body: { status: 'active', version: cur.terms_version } }));
  const due = (await api('GET', '/sponsorship-obligations', { token: w.owner.token, query: { sponsorship_id: w.deal.id } })).body.obligations[0];
  for (const role of ['evaluator', 'legal', 'approver', 'auditor']) assert.equal((await pay(w, s[role], due, `X-${role}`)).status, 403, `${role} cannot report payment`);
  must(await pay(w, s.finance, due, 'FIN-1'), 201);
  must(await pay(w, s.manager, due, 'MGR-1'), 201);
  assert.equal((await api('PATCH', `/sponsorships/${w.deal.id}`, { token: s.evaluator.token, body: { status: 'ended' } })).status, 403, 'evaluator cannot end the deal');
  assert.equal((await api('PATCH', `/sponsorships/${w.deal.id}`, { token: s.auditor.token, body: { status: 'ended' } })).status, 403);
  // export: manager, finance, auditor only
  for (const role of ['manager', 'finance', 'auditor']) must(await api('GET', `/organisations/${w.org.id}/export`, { token: s[role].token, query: { section: 'sponsor_deals' } }));
  for (const role of ['evaluator', 'legal', 'approver']) assert.equal((await api('GET', `/organisations/${w.org.id}/export`, { token: s[role].token, query: { section: 'sponsor_obligations' } })).status, 403, `${role} cannot export`);
  const csv = must(await api('GET', `/organisations/${w.org.id}/export`, { token: s.auditor.token, query: { section: 'sponsor_obligations' } }));
  assert.equal(csv.rows, 2, 'the revised two-instalment schedule');
  assert.match(csv.csv, /^brand,agreement_ref,department,kind,label,due_on,amount_cents/);
  assert.equal((await api('GET', `/organisations/${w.org.id}/export`, { token: s.auditor.token, query: { section: 'finance' } })).status, 403, 'sponsor roles do not unlock other exports');
  assert.equal((await api('GET', `/organisations/${w.org.id}/export`, { token: s.auditor.token, query: { section: 'staff' } })).status, 403);
});

test('revocation is immediate across reads, writes and exports; the owner path is untouched', async () => {
  const w = await corporate();
  const due = await accepted(w);
  const f = w.staff.finance;
  must(await pay(w, f, due, 'F-1'), 201);
  must(await api('GET', '/sponsorship-obligations', { token: f.token, query: { sponsorship_id: w.deal.id } }));
  must(await api('GET', `/organisations/${w.org.id}/export`, { token: f.token, query: { section: 'sponsor_obligations' } }));
  must(await api('DELETE', `/organisations/${w.org.id}/members/${f.id}`, { token: w.owner.token }));
  assert.equal((await pay(w, f, due, 'F-2')).status, 403, 'write refused at once');
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}`, { token: f.token })).status, 403, 'read refused at once');
  const list = must(await api('GET', '/sponsorship-obligations', { token: f.token, query: { sponsorship_id: w.deal.id } }));
  assert.equal(list.obligations.length, 0, 'lists exclude the brand');
  assert.equal(must(await api('GET', '/sponsorship-summary', { token: f.token })).agreements.length, 0);
  assert.equal((await api('GET', `/organisations/${w.org.id}/export`, { token: f.token, query: { section: 'sponsor_obligations' } })).status, 404, 'export refused at once');
  assert.equal(must(await api('GET', '/sponsors', { token: f.token, query: { mine: 'true' } })).length, 0);
  // history is kept
  const held = await pool.query("SELECT 1 FROM sponsorship_payments WHERE reference='F-1'");
  assert.equal(held.rowCount, 1, 'the financial history survives revocation');
  // the individual owner is unaffected
  must(await pay(w, w.owner, due, 'O-1'), 201);
  // a re-invite restores access with the new role
  must(await api('POST', `/organisations/${w.org.id}/members`, { token: w.owner.token, body: { person: f.handle, role: 'auditor' } }), 201);
  must(await api('POST', `/organisations/${w.org.id}/invite/respond`, { token: f.token, body: { accept: true } }));
  assert.equal((await pay(w, f, due, 'F-3')).status, 403, 'now only an auditor');
  must(await api('GET', `/sponsorships/${w.deal.id}`, { token: f.token }));
});

test('tenant isolation: another organisation\'s staff see nothing of this brand', async () => {
  const a = await corporate(), b = await corporate();
  const due = await accepted(a);
  const intruder = b.staff.manager;
  assert.equal((await api('GET', `/sponsorships/${a.deal.id}`, { token: intruder.token })).status, 403);
  assert.equal((await pay(a, intruder, due, 'EVIL')).status, 403);
  assert.equal((await revise(a, intruder)).status, 403);
  assert.equal((await propose(a, intruder)).status, 403);
  assert.equal((await api('GET', `/organisations/${a.org.id}/export`, { token: intruder.token, query: { section: 'sponsor_deals' } })).status, 404);
  const all = must(await api('GET', '/sponsorship-obligations', { token: intruder.token, query: { limit: 100 } }));
  assert.ok(all.obligations.every((o) => o.sponsorship_id !== a.deal.id));
  assert.equal((await api('GET', `/sponsors/${a.b.id}`, { token: intruder.token })).body.contact_name, undefined, 'contacts stay private');
  // an organisation member without a sponsor role (a coach) gets no access either
  const coach = await signup(['athlete']);
  must(await api('POST', `/organisations/${a.org.id}/members`, { token: a.owner.token, body: { person: coach.handle, role: 'coach' } }), 201);
  must(await api('POST', `/organisations/${a.org.id}/invite/respond`, { token: coach.token, body: { accept: true } }));
  assert.equal((await api('GET', `/sponsorships/${a.deal.id}`, { token: coach.token })).status, 403);
});

test('department scope limits deals, proposals and exports; archived departments are kept', async () => {
  const w = await corporate();
  const mk = async (name) => must(await api('POST', `/organisations/${w.org.id}/departments`, { token: w.owner.token, body: { name } }), 201);
  const mkt = await mk('Marketing'), fin = await mk('Finance dept');
  assert.equal((await api('POST', `/organisations/${w.org.id}/departments`, { token: w.owner.token, body: { name: 'marketing' } })).status, 409, 'unique per organisation');
  const dealM = must(await propose(w, w.owner, { department_id: mkt.id }), 201);
  assert.equal(dealM.department_id, mkt.id);
  // a manager scoped to Finance cannot touch Marketing
  const scoped = await signup(['athlete']);
  must(await api('POST', `/organisations/${w.org.id}/members`, { token: w.owner.token, body: { person: scoped.handle, role: 'approver', department_id: fin.id } }), 201);
  must(await api('POST', `/organisations/${w.org.id}/invite/respond`, { token: scoped.token, body: { accept: true } }));
  assert.equal((await api('GET', `/sponsorships/${dealM.id}`, { token: scoped.token })).status, 403, 'other department');
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}`, { token: scoped.token })).status, 403, 'brand-wide deals are not in a department scope');
  assert.equal((await propose(w, scoped)).status, 403, 'must state their own department');
  assert.equal((await propose(w, scoped, { department_id: mkt.id })).status, 403);
  const own = must(await propose(w, scoped, { department_id: fin.id }), 201);
  must(await api('GET', `/sponsorships/${own.id}`, { token: scoped.token }));
  const seen = must(await api('GET', '/sponsorships', { token: scoped.token }));
  assert.deepEqual(seen.map((d) => d.id), [own.id]);
  // a department from another organisation is refused
  const other = await corporate();
  const od = must(await api('POST', `/organisations/${other.org.id}/departments`, { token: other.owner.token, body: { name: 'Elsewhere' } }), 201);
  assert.equal((await propose(w, w.owner, { department_id: od.id })).status, 400);
  assert.equal((await api('POST', `/organisations/${w.org.id}/members`, { token: w.owner.token, body: { person: (await signup()).handle, role: 'finance', department_id: od.id } })).status, 404);
  // export: a department-scoped finance member only gets their department; the owner gets everything
  const fm = await signup(['athlete']);
  must(await api('POST', `/organisations/${w.org.id}/members`, { token: w.owner.token, body: { person: fm.handle, role: 'finance', department_id: fin.id } }), 201);
  must(await api('POST', `/organisations/${w.org.id}/invite/respond`, { token: fm.token, body: { accept: true } }));
  const ex = must(await api('GET', `/organisations/${w.org.id}/export`, { token: fm.token, query: { section: 'sponsor_deals' } }));
  assert.equal(ex.rows, 1);
  assert.match(ex.csv, /Finance dept/);
  assert.equal(must(await api('GET', `/organisations/${w.org.id}/export`, { token: w.owner.token, query: { section: 'sponsor_deals' } })).rows, 3);
  // archiving a department keeps its deals and people
  must(await api('DELETE', `/organisations/${w.org.id}/departments/${mkt.id}`, { token: w.owner.token }));
  assert.equal((await pool.query('SELECT 1 FROM sponsorships WHERE department_id=$1', [mkt.id])).rowCount, 1);
  assert.deepEqual(must(await api('GET', `/organisations/${w.org.id}/departments`, { token: w.owner.token })).map((d) => d.name), ['Finance dept']);
});

test('stale role changes are rejected; concurrent changes serialise; last owner and archived organisations are protected', async () => {
  const w = await corporate();
  const e = w.staff.evaluator;
  const [r1, r2] = await Promise.all([
    api('PATCH', `/organisations/${w.org.id}/members/${e.id}`, { token: w.owner.token, body: { role: 'legal', expected_role: 'evaluator' } }),
    api('PATCH', `/organisations/${w.org.id}/members/${e.id}`, { token: w.owner.token, body: { role: 'finance', expected_role: 'evaluator' } }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify([r1.body, r2.body]));
  assert.match((r1.status === 409 ? r1 : r2).body.error?.message ?? JSON.stringify((r1.status === 409 ? r1 : r2).body), /changed/);
  // an evaluator whose role was lifted loses the old permission straight away
  const now = (await api('GET', `/organisations/${w.org.id}/members`, { token: w.owner.token })).body.find((m) => m.id === e.id).org_role;
  assert.ok(['legal', 'finance'].includes(now));
  // the last owner cannot be demoted, and sponsor roles never grant owner powers
  assert.equal((await api('PATCH', `/organisations/${w.org.id}/members/${w.owner.id}`, { token: w.owner.token, body: { role: 'manager' } })).status, 409);
  assert.equal((await api('POST', `/organisations/${w.org.id}/members`, { token: w.staff.manager.token, body: { person: (await signup()).handle, role: 'auditor' } })).status, 403, 'a manager cannot manage people');
  // archiving the organisation makes the brand read-only for its staff, not for the individual owner
  const due = await accepted(w);
  must(await api('POST', `/organisations/${w.org.id}/archive`, { token: w.owner.token }));
  assert.equal((await pay(w, w.staff.finance, due, 'ARCH')).status, 409);
  must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.staff.auditor.token }));
  must(await pay(w, w.owner, due, 'OWN-ARCH'), 201);
});

test('linking, roles in the brand list, contacts, dashboards and the individual owner flow', async () => {
  const w = await corporate();
  // a different person cannot link someone else's brand, and a brand belongs to one organisation
  const other = await signup(['sponsor']);
  const org2 = must(await api('POST', '/organisations', { token: other.token, body: { name: 'Other Co', kind: 'company' } }), 201);
  assert.equal((await api('POST', `/organisations/${org2.id}/assets`, { token: other.token, body: { kind: 'sponsor', asset_id: w.b.id } })).status, 403);
  assert.equal((await api('POST', `/organisations/${org2.id}/assets`, { token: w.owner.token, body: { kind: 'sponsor', asset_id: w.b.id } })).status, 404, 'caller must belong to the organisation');
  // my_role in the brand list
  const mine = must(await api('GET', '/sponsors', { token: w.staff.legal.token, query: { mine: 'true' } }));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].my_role, 'legal');
  assert.equal(mine[0].organisation_id, w.org.id);
  assert.equal(must(await api('GET', '/sponsors', { token: w.owner.token, query: { mine: 'true' } }))[0].my_role, 'manager');
  // contacts: manager reads (audited), others do not
  const solo = await signup(['sponsor']);
  must(await api('POST', '/sponsors', { token: solo.token, body: { name: 'Solo Brand', contact_name: 'Pat' } }), 201);
  assert.equal((await api('GET', `/sponsors/${(await pool.query("SELECT id FROM sponsors WHERE name='Solo Brand'")).rows[0].id}`, { token: solo.token })).body.contact_name, 'Pat', 'individual owner keeps contacts');
  await pool.query("UPDATE sponsors SET contact_name_enc=(SELECT contact_name_enc FROM sponsors WHERE name='Solo Brand') WHERE id=$1", [w.b.id]);
  assert.equal((await api('GET', `/sponsors/${w.b.id}`, { token: w.staff.manager.token })).body.contact_name, 'Pat');
  assert.equal((await api('GET', `/sponsors/${w.b.id}`, { token: w.staff.auditor.token })).body.contact_name, undefined);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_pii' AND actor_id=$1", [w.staff.manager.id])).rowCount >= 1);
  // sponsor roles see no people or cohort data on the organisation dashboard
  const dash = must(await api('GET', `/organisations/${w.org.id}/dashboard`, { token: w.staff.evaluator.token }));
  assert.equal(dash.attendance_30d, undefined);
  assert.equal(dash.seasons, undefined);
  assert.equal(dash.counts, undefined);
  // an individual sponsor with no organisation: owner flow works end to end
  const ath = await signup(['athlete']);
  must(await api('POST', '/me/sponsorship-profile', { token: ath.token, body: { open_to_sponsors: true } }));
  const sid = (await pool.query("SELECT id FROM sponsors WHERE name='Solo Brand'")).rows[0].id;
  const d = must(await api('POST', '/sponsorships', { token: solo.token, body: { sponsor_id: sid, target_type: 'athlete', target_id: ath.id, deliverables: 'Kit', ...period, lines: [money] } }), 201);
  must(await api('PATCH', `/sponsorships/${d.id}`, { token: ath.token, body: { status: 'active', version: d.terms_version } }));
  const due = (await api('GET', '/sponsorship-obligations', { token: solo.token, query: { sponsorship_id: d.id } })).body.obligations[0];
  must(await api('POST', `/sponsorship-obligations/${due.id}/payments`, { token: solo.token, body: { amount_cents: 500, currency: 'SGD', method: 'cash', reference: 'SOLO', paid_on: '2030-01-14' } }), 201);
  assert.equal(d.department_id, null);
  // notifications reach staff in the relevant role, not the evaluator, for payment decisions
  const p = (await pool.query("SELECT id FROM sponsorship_payments WHERE reference='SOLO'")).rows[0];
  must(await api('PATCH', `/sponsorship-payments/${p.id}`, { token: ath.token, body: { status: 'confirmed' } }));
});

test('payment reports from staff are bounded and idempotent under concurrency', async () => {
  const w = await corporate();
  const due = await accepted(w);
  const res = await Promise.all([pay(w, w.staff.finance, due, 'C-1', due.amount_cents), pay(w, w.staff.manager, due, 'C-2', due.amount_cents), pay(w, w.owner, due, 'C-3', due.amount_cents)]);
  assert.deepEqual(res.map((r) => r.status).sort(), [201, 409, 409], 'the due can be reported only once in full');
  assert.equal((await pay(w, w.staff.finance, due, 'C-1', 1)).status, 409);
});

test('the notified staff are those whose role matters; payments are a payment-scope action for API tokens', async () => {
  const w = await corporate();
  const due = await accepted(w);
  must(await pay(w, w.staff.finance, due, 'N-1', 1000), 201);
  const p = (await pool.query("SELECT id FROM sponsorship_payments WHERE reference='N-1'")).rows[0];
  must(await api('PATCH', `/sponsorship-payments/${p.id}`, { token: w.ath.token, body: { status: 'confirmed' } }));
  const got = async (u) => (await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='sponsorship_payment'", [u.id])).rowCount;
  assert.equal(await got(w.staff.finance), 1);
  assert.equal(await got(w.owner), 1);
  assert.equal(await got(w.staff.evaluator), 0, 'evaluators are not told about payments');
  const { classify } = await import('../src/scopes.js');
  const { capabilities } = await import('../src/registry.js');
  assert.equal(classify(capabilities.find((c) => c.name === 'report_sponsorship_payment')), 'payment');
});

test('precedence (#282 x #283): a brand with a sponsor entity is run only by its representatives; organisation staff are ignored', async () => {
  const w = await corporate();
  must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.staff.finance.token }));
  // confirming the brand's identity makes it an entity brand: from then on only entity representatives act for it
  must(await api('POST', `/sponsors/${w.b.id}/identity`, { token: w.owner.token, body: { sponsor_type: 'company', legal_name: 'Acme Ltd' } }));
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}`, { token: w.staff.finance.token })).status, 403, 'organisation staff no longer act for an entity brand');
  assert.equal((await api('GET', '/sponsors', { token: w.staff.finance.token, query: { mine: 'true' } })).body.length, 0);
  must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.owner.token })); // the entity's owner (the creator)
  // an entity brand cannot be linked to an organisation
  const solo = await signup(['sponsor']);
  const org = must(await api('POST', '/organisations', { token: solo.token, body: { name: 'Solo Co', kind: 'company' } }), 201);
  const b = must(await api('POST', '/sponsors', { token: solo.token, body: { name: 'EntityBrand' } }), 201);
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: solo.token, body: { sponsor_type: 'company', legal_name: 'Solo Ltd' } }));
  assert.equal((await api('POST', `/organisations/${org.id}/assets`, { token: solo.token, body: { kind: 'sponsor', asset_id: b.id } })).status, 409);
});
