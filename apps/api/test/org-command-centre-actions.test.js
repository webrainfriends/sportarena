// Command Centre (#573), the second half of the queue: sponsor offers, overdue fees, supplier agreements and invoices, contracts to sign, and the
// exact records every item opens. Every test builds its own data; actions are executed exactly as the app and MCP agents do: by calling the capability the item names.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cca_${n}_${roles[0]}`, display_name: `Actions ${n}`, email: `cca${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100', dob: '1985-05-05' } }); return { ...r.body.user, token: r.body.token }; };
const iso = (d, h = 9) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + d); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };
const ymd = (d) => iso(d).slice(0, 10);
const queue = async (org, token, domain) => must(await api('GET', `/organisations/${org.id}/command-centre/approvals`, { token, query: domain ? { domain } : {} }));
/** Run an action the way a client does: the body the server named, plus whatever the person typed. */
const run = (a, token, typed = {}) => api(a.method, a.path, { token, body: { ...a.body, ...typed } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function orgWithOwner() {
  const owner = await signup();
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Actions Club ${++n}`, kind: 'club' } }), 201);
  return { owner, org };
}

test('a sponsor offer is accepted or declined from the queue; an offer the organisation made itself is not waiting on it', async () => {
  const { owner, org } = await orgWithOwner();
  const sponsorOwner = await signup();
  const sp = (await pool.query("INSERT INTO sponsors(owner_id, name) VALUES ($1,'Acme Foods') RETURNING id", [sponsorOwner.id])).rows[0];
  const offer = (await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, status, proposed_by) VALUES ($1,'organisation',$2,250000,'GBP','proposed',$3) RETURNING id, terms_version", [sp.id, org.id, sponsorOwner.id])).rows[0];
  const ours = (await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, status, proposed_by) VALUES ($1,'organisation',$2,100,'GBP','proposed',$3) RETURNING id", [sp.id, org.id, owner.id])).rows[0];
  const q = await queue(org, owner.token, 'sponsors');
  assert.deepEqual(q.items.map((i) => i.key), [`sponsors:offer:${offer.id}`]);
  const item = q.items[0];
  assert.deepEqual(item.record, { screen: 'SponsorDeal', params: { id: offer.id } });
  assert.deepEqual(item.actions.map((a) => a.label), ['Accept offer', 'Decline']);
  assert.equal(item.actions[1].ask[0].required, undefined, 'a reason for declining is optional');
  must(await run(item.actions[0], owner.token));
  assert.equal((await pool.query('SELECT status FROM sponsorships WHERE id=$1', [offer.id])).rows[0].status, 'active');
  assert.equal((await queue(org, owner.token, 'sponsors')).total, 0);
  assert.notEqual(ours.id, offer.id);

  // an offer for a team goes to the team's owner in the deal screen: the queue only opens it
  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: `Offers ${n}`, sport: 'football', organisation_id: org.id } }), 201);
  const forTeam = (await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, status, proposed_by) VALUES ($1,'team',$2,5000,'GBP','proposed',$3) RETURNING id", [sp.id, team.id, sponsorOwner.id])).rows[0];
  const t = (await queue(org, owner.token, 'sponsors')).items.find((i) => i.key === `sponsors:offer:${forTeam.id}`);
  assert.deepEqual([t.actions.length, t.open_label], [0, 'Review offer']);
  // finance sees offers but cannot answer them
  const fin = await signup(); await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,'finance','active',now())", [org.id, fin.id]);
  assert.ok((await queue(org, fin.token, 'sponsors')).items.every((i) => i.actions.length === 0));
});

test('an overdue team fee is chased from the queue: a promise to pay removes it, a note does not', async () => {
  const { owner, org } = await orgWithOwner();
  const payer = await signup();
  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: `Dues ${n}`, sport: 'football', organisation_id: org.id } }), 201);
  const b = (await pool.query("INSERT INTO team_charge_batches(team_id, kind, title, currency, total_minor, split_mode, due_on, created_by) VALUES ($1,'dues','Season dues','GBP',5000,'fixed',$2,$3) RETURNING id", [team.id, ymd(-20), owner.id]).catch(async () => (await pool.query("INSERT INTO team_charge_batches(team_id, kind, title, currency, total_minor, split_mode, due_on) VALUES ($1,'dues','Season dues','GBP',5000,'fixed',$2) RETURNING id", [team.id, ymd(-20)])))).rows[0];
  await pool.query("INSERT INTO team_charges(batch_id, team_id, member_id, payer_id, amount_minor, due_on) VALUES ($1,$2,$3,$3,5000,$4)", [b.id, team.id, payer.id, ymd(-20)]);
  const q = await queue(org, owner.token, 'finance');
  assert.equal(q.total, 1);
  const item = q.items[0];
  assert.match(item.title, /GBP 50\.00 overdue/);
  assert.deepEqual(item.record, { screen: 'TeamDues', params: { id: team.id } });
  const promise = item.actions.find((a) => a.label === 'Record a promise to pay');
  assert.equal(promise.ask[0].kind, 'date');
  const note = item.actions.find((a) => a.label === 'Add a note');
  must(await run(note, owner.token, { note: 'Called the parent' }), 200);
  assert.equal((await queue(org, owner.token, 'finance')).total, 1, 'a note does not stop the chase');
  must(await run(promise, owner.token, { promised_on: ymd(7) }));
  assert.equal((await queue(org, owner.token, 'finance')).total, 0, 'a promise pauses it until the date');
  const tile = must(await api('GET', `/organisations/${org.id}/command-centre`, { token: owner.token })).tiles.find((t) => t.key === 'finance');
  assert.equal(tile.overdue_by_currency[0].currency, 'GBP');
});

test('a supplier agreement is signed and an overdue supplier invoice is paid from the queue', async () => {
  // a real order, delivered and invoiced, for an event the organisation runs
  const supplier = await signup(['supplier']);
  const sp = must(await api('POST', '/supplier-profiles', { token: supplier.token, body: { supplier_type: 'sole_trader', legal_name: `Turf Co ${n}`, categories: ['ground_maintenance'], currencies: ['INR'], daily_capacity: 4 } }), 201);
  const { owner, org } = await orgWithOwner();
  const ev = must(await api('POST', '/events', { token: owner.token, body: { name: `Cup ${n}`, sport: 'football', starts_on: ymd(10), ends_on: ymd(12) } }), 201);
  must(await api('POST', `/organisations/${org.id}/assets`, { token: owner.token, body: { kind: 'event', asset_id: ev.id } }));
  const buyer = must(await api('POST', '/service-buyers', { token: owner.token, body: { event_id: ev.id, currency: 'INR' } }), 201);
  const req = must(await api('POST', `/service-buyers/${buyer.id}/requirements`, { token: owner.token, body: { category: 'ground_maintenance', title: 'Prepare main pitch', scope: { surface: 'natural_grass', area_sqm: 7000, tasks: ['mowing'] }, quantity: 3, unit: 'visit', starts_at: iso(10), ends_at: iso(12), budget_minor: 400000, currency: 'INR', location: { city: 'Leeds' } } }), 201);
  const rfq = must(await api('POST', `/service-requirements/${req.id}/rfq`, { token: owner.token, body: { rubric: [{ key: 'price', label: 'Price', weight: 60 }, { key: 'quality', label: 'Quality', weight: 40 }] } }), 201);
  must(await api('POST', `/rfqs/${rfq.id}/invites`, { token: owner.token, body: { profile_ids: [sp.id] } }), 201);
  must(await api('POST', `/rfqs/${rfq.id}/issue`, { token: owner.token }));
  const inbox = must(await api('GET', '/me/rfq-invitations', { token: supplier.token, query: { profile_id: sp.id } })).find((x) => x.rfq_id === rfq.id);
  must(await api('POST', `/rfq-invites/${inbox.id}/respond`, { token: supplier.token, body: { action: 'accept' } }));
  const q1 = must(await api('POST', `/rfq-invites/${inbox.id}/quote`, { token: supplier.token, body: { currency: 'INR', valid_until: iso(5), lines: [{ line_type: 'service', description: 'Pitch preparation visit', quantity: 3, unit: 'visit', rate_minor: 100000 }] } }), 201);
  const fresh = must(await api('GET', `/rfqs/${rfq.id}`, { token: owner.token }));
  const aw = must(await api('POST', `/rfqs/${rfq.id}/award`, { token: owner.token, body: { row_version: fresh.row_version, awards: [{ quote_id: q1.id }], justification: 'Only compliant bid' } }), 201);
  const order = must(await api('POST', `/service-orders/${aw.orders[0].id}/respond`, { token: supplier.token, body: { action: 'confirm' } }));

  await pool.query("UPDATE svc_orders SET agreement_status='pending_signature' WHERE id=$1", [order.id]);
  const ag = (await queue(org, owner.token, 'procurement')).items.find((i) => i.key === `procurement:agreement:${order.id}`);
  assert.ok(ag, 'the agreement waits for this side');
  assert.deepEqual(ag.record, { screen: 'ServicesBuyer', params: { event_id: ev.id } });
  assert.equal(ag.actions[0].ask[0].key, 'typed_name');
  assert.equal((await run(ag.actions[0], owner.token, { typed_name: 'A' })).status, 400); // a real name is needed
  must(await run(ag.actions[0], owner.token, { typed_name: 'Pat Organiser' }));
  assert.ok(!(await queue(org, owner.token, 'procurement')).items.some((i) => i.key === `procurement:agreement:${order.id}`));

  const v = must(await api('POST', `/service-orders/${order.id}/visits`, { token: supplier.token, body: { line_no: 1, starts_at: iso(10, 8), duration_minutes: 60, planned_qty: 3 } }), 201).visits[0];
  must(await api('POST', `/service-visits/${v.id}/status`, { token: supplier.token, body: { row_version: v.row_version, status: 'in_progress' } }));
  const cur = must(await api('GET', `/service-orders/${order.id}/visits`, { token: supplier.token })).find((x) => x.id === v.id);
  must(await api('POST', `/service-visits/${v.id}/status`, { token: supplier.token, body: { row_version: cur.row_version, status: 'submitted_for_acceptance', actual_qty: 3 } }));
  must(await api('POST', `/service-orders/${order.id}/acceptance`, { token: owner.token, body: { line_no: 1, visit_id: v.id, decision: 'accepted', quantity: 3 } }), 201);
  const inv = must(await api('POST', `/service-orders/${order.id}/invoices`, { token: supplier.token, body: { kind: 'progress', lines: [{ line_no: 1, quantity: 3 }] } }), 201);
  must(await api('POST', `/service-invoices/${inv.id}/issue`, { token: supplier.token }));
  await pool.query('UPDATE svc_invoices SET due_on=$2 WHERE id=$1', [inv.id, ymd(-5)]);

  const it = (await queue(org, owner.token, 'procurement')).items.find((i) => i.key === `procurement:invoice:${inv.id}`);
  assert.ok(it, 'the overdue invoice is listed');
  const pay = it.actions[0];
  assert.deepEqual(pay.ask.map((f) => f.kind), ['amount', 'date', 'line', 'line']);
  assert.equal(pay.ask[0].default_minor, Number(inv.payable_minor));
  must(await run(pay, owner.token, { amount_minor: pay.ask[0].default_minor, paid_on: ymd(0), reference: 'UTR-77', evidence: 'bank statement line 9' }), 201);
  assert.equal((await pool.query('SELECT pay_status FROM svc_invoices WHERE id=$1', [inv.id])).rows[0].pay_status, 'paid');
  assert.ok(!(await queue(org, owner.token, 'procurement')).items.some((i) => i.key === `procurement:invoice:${inv.id}`));
});

test('a contract waiting for signatures opens on the contract; only a named signatory is told it is theirs to sign', async () => {
  const { owner, org } = await orgWithOwner();
  const sponsorOwner = await signup(), other = await signup();
  const sp = (await pool.query("INSERT INTO sponsors(owner_id, name) VALUES ($1,'Acme Foods') RETURNING id", [sponsorOwner.id])).rows[0];
  const deal = (await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, currency, status, proposed_by) VALUES ($1,'organisation',$2,900,'GBP','active',$3) RETURNING id", [sp.id, org.id, sponsorOwner.id])).rows[0];
  const doc = (await pool.query("INSERT INTO generated_documents(family, source_type, source_id, file_name, size_bytes, sha256, pages, generated_by) VALUES ('sponsorship','sponsorship_contract',$1,'c.pdf',10,$2,1,$3) RETURNING id", [deal.id, 'a'.repeat(64), owner.id])).rows[0];
  const c = (await pool.query("INSERT INTO sponsorship_contracts(sponsorship_id, terms_version, status, snapshot, snapshot_sha256, document_id, created_by, requested_at) VALUES ($1,1,'awaiting_signatures','{}',$2,$3,$4,now()) RETURNING id", [deal.id, 'a'.repeat(64), doc.id, owner.id])).rows[0];
  await pool.query("INSERT INTO sponsorship_signatories(contract_id, side, user_id, status) VALUES ($1,'recipient',$2,'pending')", [c.id, owner.id]);
  const mine = (await queue(org, owner.token, 'documents')).items[0];
  assert.deepEqual([mine.key, mine.open_label, mine.actions.length, mine.can_act], [`documents:contract:${c.id}`, 'Review & sign', 0, true]);
  assert.deepEqual(mine.record, { screen: 'SponsorDeal', params: { id: deal.id } });
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,'admin','active',now())", [org.id, other.id]);
  const theirs = (await queue(org, other.token, 'documents')).items[0];
  assert.deepEqual([theirs.open_label, theirs.can_act], ['Open', false]);
});

test('every screen a queue item opens is registered in the app', () => {
  const app = readFileSync(new URL('../../app/src/App.js', import.meta.url), 'utf8');
  const pages = app.match(/const PAGES = \{([^\n]*)\}/)[1];
  const src = readFileSync(new URL('../src/capabilities/org-command-centre.js', import.meta.url), 'utf8');
  const screens = [...new Set([...src.matchAll(/rec\('(\w+)'/g)].map((m) => m[1]))];
  assert.ok(screens.length >= 6);
  for (const s of screens) assert.ok(new RegExp(`\\b${s}\\b`).test(pages), `${s} is a registered screen`);
});
