import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sb_${n}_${roles[0]}`, display_name: `Ben ${n}`, email: `sb${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const money = { kind: 'money', label: 'Season support', currency: 'SGD', amount_cents: 100000, cadence: 'once', first_due_on: day(5) };

const member = async (org, owner, role) => {
  const u = await signup(['coach']);
  must(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
  must(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
  return u;
};
// an organisation (open to sponsors), two groups, an owner, an admin, a finance member, plus a brand and a live accepted offer
const world = async ({ open = true, accept = true } = {}) => {
  const owner = await signup(['coach']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Riverside ${++n}` } }), 201);
  if (open) must(await api('PATCH', `/organisations/${org.id}`, { token: owner.token, body: { open_to_sponsors: true } }));
  const admin = await member(org, owner, 'admin'), fin = await member(org, owner, 'finance');
  const g1 = must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U14 Girls' } }), 201);
  const g2 = must(await api('POST', `/organisations/${org.id}/cohorts`, { token: owner.token, body: { name: 'U16 Boys' } }), 201);
  const sponsor = await signup(['sponsor']);
  const brand = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `Brand${n}` } }), 201);
  const w = { owner, org, admin, fin, g1, g2, sponsor, brand };
  if (open) {
    w.deal = await offer(w, 'organisation', org.id);
    if (accept) must(await api('PATCH', `/sponsorships/${w.deal.id}`, { token: owner.token, body: { status: 'active', version: w.deal.terms_version } }));
  }
  return w;
};
const offer = async (w, type, targetId, extra = {}) => must(await api('POST', '/sponsorships', { token: w.sponsor.token, body: { sponsor_id: w.brand.id, target_type: type, target_id: targetId, starts_on: day(1), ends_on: day(200), lines: [money], ...extra } }), 201);
const alloc = (token, id, rev, allocations) => api('POST', `/sponsorships/${id}/allocations`, { token, body: { rev, allocations } });
const a = (type, id, bp, payee) => ({ beneficiary_type: type, beneficiary_id: id, share_bp: bp, payee_user_id: payee.id });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('organisations are private until opted in; search shows names only and groups are offerable', async () => {
  const w = await world({ open: false });
  assert.equal((await api('POST', '/sponsorships', { token: w.sponsor.token, body: { sponsor_id: w.brand.id, target_type: 'organisation', target_id: w.org.id, lines: [money], starts_on: day(1), ends_on: day(90) } })).status, 409, 'closed organisation refuses offers');
  assert.ok(!must(await api('GET', '/sponsorship-beneficiaries', { token: w.sponsor.token, query: { q: 'Riverside' } })).some((o) => o.id === w.org.id));
  must(await api('PATCH', `/organisations/${w.org.id}`, { token: w.owner.token, body: { open_to_sponsors: true } }));
  const found = must(await api('GET', '/sponsorship-beneficiaries', { token: w.sponsor.token, query: { q: w.org.name } }));
  assert.deepEqual(Object.keys(found[0]).sort(), ['city', 'id', 'kind', 'name', 'organisation_name', 'type']);
  const groups = must(await api('GET', '/sponsorship-beneficiaries', { token: w.sponsor.token, query: { type: 'group', q: 'U14' } }));
  assert.ok(groups.some((g) => g.id === w.g1.id));
  assert.equal((await api('GET', '/sponsorship-beneficiaries', { token: (await signup(['athlete'])).token })).status, 403, 'only sponsors search');
  const gd = await offer(w, 'group', w.g1.id);
  assert.equal(gd.target_type, 'group');
});

test('representative, payee and sponsor are distinct; allocations are validated and atomic', async () => {
  const w = await world();
  const v0 = must(await api('GET', `/sponsorships/${w.deal.id}/allocations`, { token: w.admin.token }));
  assert.equal(v0.my_role, 'representative'); assert.equal(v0.rev, 1); assert.deepEqual(v0.allocations, []); assert.equal(v0.unallocated_bp, 10000);
  assert.ok(v0.candidates.payees.some((p) => p.id === w.fin.id) && v0.candidates.groups.length === 2);
  // only live owner/admin represent; the finance member (not yet a payee) and strangers are refused
  assert.equal((await alloc(w.fin.token, w.deal.id, 1, [])).status, 403);
  const stranger = await signup(['coach']);
  assert.equal((await alloc(stranger.token, w.deal.id, 1, [])).status, 403);
  // over-allocation, duplicates, bad payee and foreign beneficiary all fail and change nothing
  assert.equal((await alloc(w.admin.token, w.deal.id, 1, [a('group', w.g1.id, 6000, w.fin), a('group', w.g2.id, 5000, w.fin)])).status, 400);
  assert.equal((await alloc(w.admin.token, w.deal.id, 1, [a('group', w.g1.id, 3000, w.fin), a('group', w.g1.id, 3000, w.fin)])).status, 400);
  assert.equal((await alloc(w.admin.token, w.deal.id, 1, [a('group', w.g1.id, 3000, stranger)])).status, 400, 'payee must be a live finance-capable member');
  const other = await world();
  assert.equal((await alloc(w.admin.token, w.deal.id, 1, [a('group', other.g1.id, 3000, w.fin)])).status, 400, 'another tenant\'s group');
  assert.equal(must(await api('GET', `/sponsorships/${w.deal.id}/allocations`, { token: w.admin.token })).allocations.length, 0);
  // a valid set
  const ok = must(await alloc(w.admin.token, w.deal.id, 1, [a('organisation', w.org.id, 4000, w.fin), a('group', w.g1.id, 6000, w.fin)]));
  assert.equal(ok.rev, 2); assert.equal(ok.allocated_bp, 10000); assert.equal(ok.unallocated_bp, 0);
  assert.equal(ok.allocations[0].payee_name, w.fin.display_name);
  // stale editor
  const stale = await alloc(w.owner.token, w.deal.id, 1, []);
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details.rev, 2);
});

test('concurrent allocation edits never over-allocate or duplicate', async () => {
  const w = await world();
  const rs = await Promise.all([1, 2, 3, 4].map((k) => alloc(k % 2 ? w.admin.token : w.owner.token, w.deal.id, 1, [a('group', k % 2 ? w.g1.id : w.g2.id, 7000, w.fin)])));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, 'exactly one wins the same rev');
  assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
  const { rows } = await pool.query("SELECT share_bp FROM sponsorship_allocations WHERE sponsorship_id=$1 AND status='active'", [w.deal.id]);
  assert.equal(rows.length, 1);
  // DB backstop: the same beneficiary cannot be active twice
  await assert.rejects(pool.query("INSERT INTO sponsorship_allocations(sponsorship_id, beneficiary_type, beneficiary_id, beneficiary_name, share_bp, payee_user_id, payee_name, terms_version, set_by) SELECT sponsorship_id, beneficiary_type, beneficiary_id, beneficiary_name, share_bp, payee_user_id, payee_name, terms_version, set_by FROM sponsorship_allocations WHERE sponsorship_id=$1 AND status='active'", [w.deal.id]), /sponsorship_allocations_live/);
});

test('membership changes never rewrite historical payees; a payee confirms only their own deal', async () => {
  const w = await world();
  let v = must(await alloc(w.owner.token, w.deal.id, 1, [a('group', w.g1.id, 5000, w.fin), a('organisation', w.org.id, 5000, w.owner)]));
  // the finance member is now a payee: sees the deal, may confirm money, still cannot change allocations
  assert.equal(must(await api('GET', `/sponsorships/${w.deal.id}/allocations`, { token: w.fin.token })).my_role, 'payee');
  assert.equal((await alloc(w.fin.token, w.deal.id, v.rev, [])).status, 403);
  const ob = must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.owner.token })).obligations[0];
  const pay = must(await api('POST', `/sponsorship-obligations/${ob.id}/payments`, { token: w.sponsor.token, body: { amount_cents: 100000, currency: 'SGD', method: 'bank_transfer', reference: 'TX1', paid_on: day(0) } }), 201);
  must(await api('PATCH', `/sponsorship-payments/${pay.id}`, { token: w.fin.token, body: { status: 'confirmed' } }));
  // the payee leaves the organisation and is replaced
  must(await api('DELETE', `/organisations/${w.org.id}/members/${w.fin.id}`, { token: w.owner.token }));
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}/allocations`, { token: w.fin.token })).status, 403, 'access ends immediately');
  v = must(await alloc(w.owner.token, w.deal.id, v.rev, [a('group', w.g1.id, 5000, w.admin), a('organisation', w.org.id, 5000, w.owner)]));
  assert.equal(v.history.length, 1); assert.equal(v.history[0].payee_name, w.fin.display_name, 'released row keeps its payee');
  const deal = must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.sponsor.token }));
  const paid = deal.obligations[0].payments[0];
  assert.equal(paid.payee_snapshot.allocations.find((x) => x.beneficiary_type === 'group').payee_name, w.fin.display_name);
  assert.equal(paid.payee_snapshot.allocations.reduce((s, x) => s + x.amount_cents, 0) + paid.payee_snapshot.unallocated_cents, 100000);
  // the sponsor can never confirm its own payment
  const pay2 = (await pool.query("SELECT id FROM sponsorship_payments WHERE id=$1", [pay.id])).rows[0];
  assert.equal((await api('PATCH', `/sponsorship-payments/${pay2.id}`, { token: w.sponsor.token, body: { status: 'reversed', note: 'x' } })).status, 403);
});

test('organisation sponsorship grants no private member data and enforces tenant isolation', async () => {
  const w = await world();
  const o = await world();
  must(await alloc(w.owner.token, w.deal.id, 1, [a('group', w.g1.id, 2500, w.fin)]));
  const member = await signup(['athlete']);
  await pool.query("INSERT INTO org_enrolments(cohort_id, user_id, consent_at, enrolled_by) VALUES ($1,$2,now(),$3)", [w.g1.id, member.id, w.owner.id]);
  const sponsorView = JSON.stringify([must(await api('GET', `/sponsorships/${w.deal.id}`, { token: w.sponsor.token })), must(await api('GET', `/sponsorships/${w.deal.id}/allocations`, { token: w.sponsor.token })), must(await api('GET', '/sponsorships', { token: w.sponsor.token }))]).toLowerCase();
  for (const secret of [member.handle, member.display_name, member.id, 'enrol', 'roster', 'attendance']) assert.ok(!sponsorView.includes(String(secret).toLowerCase()), `no ${secret}`);
  assert.equal(must(await api('GET', `/sponsorships/${w.deal.id}/allocations`, { token: w.sponsor.token })).candidates, undefined, 'sponsors never get the org\'s candidates');
  assert.equal((await alloc(w.sponsor.token, w.deal.id, 1, [])).status, 403);
  // another tenant: reads, writes, lists and obligation scopes
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}`, { token: o.owner.token })).status, 403);
  assert.equal((await api('GET', `/sponsorships/${w.deal.id}/allocations`, { token: o.owner.token })).status, 403);
  assert.equal((await alloc(o.owner.token, w.deal.id, 1, [])).status, 403);
  assert.equal(must(await api('GET', '/sponsorships', { token: o.owner.token, query: { as: 'target' } })).some((d) => d.id === w.deal.id), false);
  assert.equal(must(await api('GET', '/sponsorship-obligations', { token: o.owner.token })).obligations.some((x) => x.sponsorship_id === w.deal.id), false);
  assert.ok(must(await api('GET', '/sponsorships', { token: w.admin.token, query: { as: 'target', organisation_id: w.org.id } })).some((d) => d.id === w.deal.id), 'org filter finds its deals');
  assert.equal(must(await api('GET', '/sponsorships', { token: w.admin.token, query: { as: 'target', organisation_id: o.org.id } })).length, 0, 'filter cannot reach another tenant');
  const mine = must(await api('GET', '/sponsorships', { token: w.admin.token, query: { as: 'target' } }));
  assert.equal(mine.find((d) => d.id === w.deal.id).target_name, w.org.name);
  // a non-representative cannot accept; a stranger cannot decide
  const fresh = await offer(w, 'organisation', w.org.id);
  assert.equal((await api('PATCH', `/sponsorships/${fresh.id}`, { token: w.fin.token, body: { status: 'active', version: fresh.terms_version } })).status, 403);
  must(await api('PATCH', `/sponsorships/${fresh.id}`, { token: w.admin.token, body: { status: 'active', version: fresh.terms_version } }));
});

test('existing event/team/athlete sponsorships and legacy payments are untouched by the additive migration', async () => {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM sponsorship_payments WHERE payee_snapshot IS NOT NULL AND status <> 'confirmed'");
  assert.equal(rows[0].n, 0);
  const col = (await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name='organisations' AND column_name='open_to_sponsors'")).rows[0];
  assert.match(col.column_default, /false/);
});

test('allocations export is scoped to the organisation, role-gated and carries no member data', async () => {
  const w = await world();
  const o = await world();
  must(await alloc(w.owner.token, w.deal.id, 1, [a('group', w.g1.id, 5000, w.fin)]));
  const exp = (u, org) => api('GET', `/organisations/${org.id}/export`, { token: u.token, query: { section: 'sponsorship_allocations' } });
  const mine = must(await exp(w.fin, w.org));
  assert.equal(mine.rows, 1); assert.match(mine.csv, /U14 Girls/); assert.match(mine.csv, new RegExp(w.fin.display_name));
  assert.ok(!mine.csv.includes(w.owner.email ?? '@example.com'));
  assert.equal(must(await exp(o.owner, o.org)).rows, 0, 'another tenant sees none of it');
  assert.equal((await exp(w.owner, o.org)).status, 404, 'cannot export another organisation');
  const coach = await member(w.org, w.owner, 'coach');
  assert.equal((await exp(coach, w.org)).status, 403);
  assert.equal((await exp(w.sponsor, w.org)).status, 404);
});
