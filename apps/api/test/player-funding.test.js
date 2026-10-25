// Issue #334: the player's sponsorship funding workspace — needs, applications, awards, dues, goods, next actions, guardian and coach access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const rpc = async (name, args, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pf_${n}_${roles[0]}`, display_name: `Fund ${n}`, email: `pf${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const get = (u, p, query) => api('GET', p, { token: u.token, query });
const post = (u, p, body) => api('POST', p, { token: u.token, body });
const ws = (u, query) => get(u, '/player-funding', query);

const money = { kind: 'money', label: 'Monthly support', currency: 'SGD', amount_cents: 50000, cadence: 'monthly', first_due_on: '2030-01-15', instalments: 6 };
const goods = { kind: 'goods', label: 'Rackets', quantity: 4, unit: 'pcs', cadence: 'custom', custom_dates: ['2030-02-01'], estimate_cents: 80000, currency: 'SGD' };
const post_ = { kind: 'endorsement', label: 'Instagram posts', promoter: 'recipient', cadence: 'custom', custom_dates: ['2030-02-10'], terms: { channels: ['instagram'], approval_criteria: 'Logo visible' } };
const period = { starts_on: '2030-01-01', ends_on: '2030-06-30' };

/** a sponsor brand, an athlete who is open to sponsors, and an accepted agreement with cash, goods and an endorsement */
const world = async () => {
  const sponsor = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `FundBrand${n}` } }), 201);
  must(await post(ath, '/me/sponsorship-profile', { open_to_sponsors: true }));
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: ath.id, deliverables: 'Wear the kit', ...period, lines: [money, goods, post_] } }), 201);
  return { sponsor, ath, b, deal };
};
const accept = async (w) => must(await api('PATCH', `/sponsorships/${w.deal.id}`, { token: w.ath.token, body: { status: 'active', version: 1 } }));
const dues = async (w) => must(await get(w.ath, '/sponsorship-obligations', { sponsorship_id: w.deal.id, limit: 100 })).obligations;

async function guardianOf(child) {
  const parent = await signup(['athlete']);
  const l = must(await post(parent, '/youth/guardian-links', { guardian_id: parent.id, child_id: child.id, relationship: 'parent' }), 201);
  must(await post(child, `/youth/guardian-links/${l.id}/respond`, { accept: true }));
  must(await post(parent, `/youth/guardian-links/${l.id}/evidence`, { evidence: { reference: 'https://example.com/birth-certificate-ref-123', label: 'Birth certificate' } }), 201);
  must(await post(admin, `/youth/guardian-links/${l.id}/decision`, { decision: 'approve', note: 'Documents match' }));
  return parent;
}
/** a coach on the same team as the athlete (a current coaching relationship) */
async function coachFor(ath) {
  const coach = await signup(['coach']);
  const team = must(await post(coach, '/teams', { name: `Fund FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, ath.id]);
  return { coach, team };
}
const need = (u, extra = {}) => post(u, '/funding-needs', { category: 'travel', title: 'Travel to nationals', amount_cents: 200000, currency: 'SGD', needed_by: day(60), client_key: `key-${Math.random().toString(36).slice(2, 12)}`, ...extra });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('pf_root','pf_root','{admin}','x','x','pf_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('an empty workspace is an honest empty state, and strangers get 404', async () => {
  const a = await signup(['athlete']), other = await signup(['athlete']);
  const w = must(await ws(a));
  assert.deepEqual([w.totals, w.needs, w.applications, w.support, w.next_actions], [[], [], [], [], []]);
  assert.equal(w.dues.total, 0); assert.equal(w.access.role, 'self');
  assert.equal((await ws(other, { athlete_id: a.id })).status, 404, 'no relationship: the workspace is not revealed');
  assert.equal((await api('GET', '/player-funding')).status, 401);
  assert.equal((await get(other, '/funding-shares', { athlete_id: a.id })).status, 404);
});

test('dues, paid and confirmed amounts, goods and next actions reconcile with the agreement and the portfolio', async () => {
  const w = await world();
  const offer = must(await ws(w.ath));
  assert.ok(offer.next_actions.some((x) => x.code === 'answer_offer' && x.entity.id === w.deal.id), 'an unanswered offer is a next action');
  await accept(w);
  const before = must(await ws(w.ath));
  assert.equal(before.dues.total, 8, 'six instalments, one delivery, one endorsement, exactly once');
  assert.equal(before.totals[0].committed_cents, 300000); assert.equal(before.totals[0].confirmed_cents, 0);
  const first = before.dues.items.find((d) => d.kind === 'money');
  assert.equal(first.money.outstanding_cents, 50000);
  assert.ok(before.next_actions.some((x) => x.code === 'submit_endorsement'), 'the athlete owes the endorsement evidence');

  const ob = (await dues(w)).find((o) => o.kind === 'money');
  const paid = must(await api('POST', `/sponsorship-obligations/${ob.id}/payments`, { token: w.sponsor.token, body: { amount_cents: 50000, currency: 'SGD', method: 'bank_transfer', reference: 'TT-1', paid_on: day(-1) } }), 201);
  const mid = must(await ws(w.ath));
  assert.equal(mid.totals[0].reported_unconfirmed_cents, 50000); assert.equal(mid.totals[0].confirmed_cents, 0, 'a reported payment is never counted as received');
  assert.ok(mid.next_actions.some((x) => x.code === 'confirm_payment'));
  must(await api('PATCH', `/sponsorship-payments/${paid.id}`, { token: w.ath.token, body: { status: 'confirmed' } }));
  const after = must(await ws(w.ath));
  assert.equal(after.totals[0].confirmed_cents, 50000); assert.equal(after.totals[0].outstanding_cents, 250000);
  assert.ok(!after.next_actions.some((x) => x.code === 'confirm_payment'));
  const row = after.dues.items.find((d) => d.id === ob.id);
  assert.deepEqual([row.money.confirmed_cents, row.money.reported_unconfirmed_cents, row.money.outstanding_cents], [50000, 0, 0]);

  // goods: dispatch is not receipt
  const g = (await dues(w)).find((o) => o.kind === 'goods');
  const d = must(await api('POST', `/sponsorship-obligations/${g.id}/deliveries`, { token: w.sponsor.token, body: { quantity: 3, reference: 'AWB-1' } }), 201);
  let gw = must(await ws(w.ath)).dues.items.find((x) => x.id === g.id).goods;
  assert.deepEqual([gw.committed, gw.received, gw.in_transit, gw.remaining], [4, 0, 3, 1]);
  assert.ok(must(await ws(w.ath)).next_actions.some((x) => x.code === 'confirm_receipt'));
  must(await api('PATCH', `/sponsorship-deliveries/${d.id}`, { token: w.ath.token, body: { status: 'received', received_quantity: 2 } }));
  gw = must(await ws(w.ath)).dues.items.find((x) => x.id === g.id).goods;
  assert.deepEqual([gw.received, gw.in_transit], [2, 0]);

  // the same numbers as the agreement's own list and as the beneficiary portfolio
  const own = must(await get(w.ath, '/sponsorship-obligations', { sponsorship_id: w.deal.id, kind: 'money' })).totals[0];
  const pf = must(await get(w.ath, `/beneficiary-portfolio/athlete/${w.ath.id}`, { view: 'recipient' })).totals[0];
  const now = must(await ws(w.ath)).totals[0];
  assert.deepEqual([now.committed_cents, now.confirmed_cents, now.outstanding_cents], [Number(own.committed_cents), Number(own.confirmed_cents), Number(own.outstanding_cents)]);
  assert.deepEqual([now.committed_cents, now.confirmed_cents, now.reported_unconfirmed_cents], [pf.committed_cents, pf.confirmed_cents, pf.reported_unconfirmed_cents]);

  // deterministic pages and filters
  const p1 = must(await ws(w.ath, { limit: 3, offset: 0 })), p2 = must(await ws(w.ath, { limit: 3, offset: 3 }));
  assert.equal(p1.dues.items.length, 3); assert.equal(p1.dues.total, 8);
  assert.equal(new Set([...p1.dues.items, ...p2.dues.items].map((x) => x.id)).size, 6, 'pages never repeat a due');
  assert.ok(must(await ws(w.ath, { state: 'fulfilled' })).dues.items.every((x) => x.state === 'fulfilled'));
  assert.equal((await ws(w.ath, { limit: 500 })).status, 400);
  assert.equal((await ws(w.ath, { state: 'nonsense' })).status, 400);
  assert.equal((await ws(w.sponsor, { athlete_id: w.ath.id })).status, 404, 'the sponsor sees the recipient\'s workspace through the portfolio, never this one');
});

test('funding needs: validation, idempotent create, stale versions, withdraw and reopen, encrypted note', async () => {
  const a = await signup(['athlete']);
  assert.equal((await need(a, { amount_cents: 0 })).status, 400);
  assert.equal((await need(a, { currency: 'sgd1' })).status, 400);
  assert.equal((await need(a, { needed_by: day(-2) })).status, 400);
  assert.equal((await need(a, { category: 'yacht' })).status, 400);
  assert.equal((await post(a, '/funding-needs', { category: 'travel', title: 'x', amount_cents: 5, currency: 'SGD' })).status, 400, 'a client_key is required');
  const body = { category: 'equipment', title: 'New racket', amount_cents: 15000, currency: 'sgd', needed_by: day(30), note: 'PRIVATE-NOTE-XYZ', client_key: 'retry-key-0001' };
  const first = must(await post(a, '/funding-needs', body), 201);
  const again = must(await post(a, '/funding-needs', body), 201);
  assert.equal(again.id, first.id, 'a retried create returns the same need');
  assert.equal(first.currency, 'SGD'); assert.equal(first.note, 'PRIVATE-NOTE-XYZ'); assert.equal(first.gap_cents, 15000);
  assert.equal((await post(a, '/funding-needs', { ...body, amount_cents: 99 })).status, 409, 'the same key for a different need is refused');
  const stored = (await pool.query('SELECT note_enc FROM athlete_funding_needs WHERE id=$1', [first.id])).rows[0].note_enc;
  assert.ok(stored && !stored.includes('PRIVATE'), 'personal free text is encrypted at rest');

  const upd = must(await api('PATCH', `/funding-needs/${first.id}`, { token: a.token, body: { rev: 1, amount_cents: 20000, needed_by: null } }));
  assert.equal(upd.rev, 2); assert.equal(upd.amount_cents, 20000); assert.equal(upd.needed_by, null);
  const stale = await api('PATCH', `/funding-needs/${first.id}`, { token: a.token, body: { rev: 1, title: 'Other' } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details?.code, 'stale_version');
  assert.equal((await api('PATCH', `/funding-needs/${first.id}`, { token: a.token, body: { rev: 2 } })).status, 400, 'nothing to change');
  const off = must(await api('PATCH', `/funding-needs/${first.id}`, { token: a.token, body: { rev: 2, status: 'withdrawn' } }));
  assert.equal(off.status, 'withdrawn'); assert.equal(off.gap_cents, 0, 'a withdrawn need is no longer a gap');
  assert.equal((await api('PATCH', `/funding-needs/${first.id}`, { token: a.token, body: { rev: 3, title: 'Edit while withdrawn' } })).status, 409);
  assert.equal(must(await api('PATCH', `/funding-needs/${first.id}`, { token: a.token, body: { rev: 3, status: 'open' } })).status, 'open');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM athlete_funding_needs WHERE id=$1', [first.id])).rows[0].n, 1, 'nothing is ever deleted');
  const other = await signup(['athlete']);
  assert.equal((await api('PATCH', `/funding-needs/${first.id}`, { token: other.token, body: { rev: 4, title: 'Hijack' } })).status, 404);
  const seen = must(await ws(a));
  assert.deepEqual(seen.needs_totals, [{ currency: 'SGD', needed_cents: 20000, secured_cents: 0, pending_cents: 0, gap_cents: 20000 }]);
  assert.ok(seen.next_actions.some((x) => x.code === 'fund_need'));
});

test('linking a need to an agreement: caps, currencies, no double counting, live coverage, release', async () => {
  const w = await world();
  const a1 = must(await need(w.ath, { amount_cents: 200000 }), 201), a2 = must(await need(w.ath, { title: 'Coaching', category: 'coaching', amount_cents: 250000 }), 201);
  const link = (nd, extra, rev = nd.rev) => post(w.ath, `/funding-needs/${nd.id}/links`, { rev, sponsorship_id: w.deal.id, allocated_cents: 100000, ...extra });
  const proposed = must(await link(a1), 201);
  assert.equal(proposed.pending_cents, 100000); assert.equal(proposed.secured_cents, 0, 'an unanswered offer is pending, not secured');
  assert.equal(proposed.rev, 2);
  assert.equal((await link(a1, {}, 1)).status, 409, 'stale need revision');
  assert.equal(must(await link(proposed, {}, 2), 201).links.length, 1, 'a retried link is idempotent');
  assert.equal((await link(proposed, { allocated_cents: 90000 }, 2)).status, 409, 'a different amount on the same item must release first');
  await accept(w);

  const cov = must(await ws(w.ath)).needs.find((x) => x.id === a1.id);
  assert.equal(cov.secured_cents, 100000); assert.equal(cov.pending_cents, 0); assert.equal(cov.gap_cents, 100000);
  // the agreement commits 300000 SGD: 100000 is claimed, so a second need can claim at most 200000
  const over = await link(a2, { allocated_cents: 200001 });
  assert.equal(over.status, 409); assert.equal(over.body.error.details.remaining_cents, 200000);
  const l2 = must(await link(a2, { allocated_cents: 200000 }), 201);
  assert.equal(l2.secured_cents, 200000);
  assert.equal((await link(a1, { allocated_cents: 1 }, 3)).status, 409, 'already linked, nothing left of the agreement either');

  const usd = must(await need(w.ath, { currency: 'USD', amount_cents: 5000, title: 'Visa' }), 201);
  assert.equal((await link(usd)).status, 400, 'currencies are never converted');
  assert.equal((await post(w.ath, `/funding-needs/${usd.id}/links`, { rev: 1, allocated_cents: 5 })).status, 400, 'one target is required');
  assert.equal((await post(w.ath, `/funding-needs/${usd.id}/links`, { rev: 1, allocated_cents: 5, sponsorship_id: w.deal.id, application_id: w.deal.id })).status, 400, 'not both');
  const stranger = await signup(['athlete']);
  assert.equal((await post(stranger, `/funding-needs/${a1.id}/links`, { rev: 3, sponsorship_id: w.deal.id, allocated_cents: 1 })).status, 404);
  const mine = must(await need(stranger), 201);
  assert.equal((await post(stranger, `/funding-needs/${mine.id}/links`, { rev: 1, sponsorship_id: w.deal.id, allocated_cents: 1 })).status, 404, 'cannot claim someone else\'s agreement');

  // concurrent claims on the same unclaimed money: exactly one wins
  must(await post(w.ath, `/funding-need-links/${l2.links[0].id}/release`, { rev: l2.rev }));
  const c1 = must(await need(w.ath, { amount_cents: 100000, title: 'Race A' }), 201), c2 = must(await need(w.ath, { amount_cents: 100000, title: 'Race B' }), 201);
  const res = await Promise.all([link(c1, { allocated_cents: 150000 }), link(c2, { allocated_cents: 150000 })]);
  assert.deepEqual(res.map((r) => r.status).sort(), [201, 409]);

  // the agreement ends early: coverage disappears by itself, the data stays
  await pool.query("UPDATE sponsorships SET status='withdrawn' WHERE id=$1", [w.deal.id]);
  const lapsed = must(await ws(w.ath)).needs.find((x) => x.id === a1.id);
  assert.equal(lapsed.secured_cents, 0); assert.equal(lapsed.links[0].state, 'lapsed'); assert.equal(lapsed.gap_cents, 200000);
  await pool.query("UPDATE sponsorships SET status='active' WHERE id=$1", [w.deal.id]);
  const rel = must(await post(w.ath, `/funding-need-links/${lapsed.links[0].id}/release`, { rev: lapsed.rev }));
  assert.equal(rel.links.length, 0);
  must(await post(w.ath, `/funding-need-links/${lapsed.links[0].id}/release`, { rev: 1 })); // second release: harmless
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM athlete_funding_links WHERE need_id=$1', [a1.id])).rows[0].n, 1, 'released, not deleted');
  assert.equal(await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='link_funding_need'", [w.ath.id]).then((r) => r.rowCount > 0), true);
});

test('applications and awards show with their offers and a next action; an application is not double counted with the agreement it becomes', async () => {
  const owner = await signup(['sponsor']), ath = await signup(['athlete']);
  const b = must(await api('POST', '/sponsors', { token: owner.token, body: { name: `AppBrand${n}` } }), 201);
  let p = must(await api('POST', '/sponsorship-programs', { token: owner.token, body: { sponsor_id: b.id, name: 'Youth fund', currency: 'USD', budget_cents: 100000, max_award_cents: 60000 } }), 201);
  const r = must(await api('POST', `/sponsorship-programs/${p.id}/rounds`, { token: owner.token, body: { opens_on: day(-1), closes_on: day(30) } }), 201);
  p = must(await api('POST', `/sponsorship-programs/${p.id}/status`, { token: owner.token, body: { status: 'published', version: p.row_version } }));
  const app = must(await post(ath, `/program-rounds/${r.id}/applications`, { target_type: 'athlete', target_id: ath.id, requested_cents: 40000, pitch: 'Please' }), 201);
  const nd = must(await need(ath, { currency: 'USD', amount_cents: 40000, title: 'Season fees', category: 'competition_fees' }), 201);
  const submitted = must(await ws(ath));
  assert.equal(submitted.applications[0].status, 'submitted'); assert.equal(submitted.totals[0].requested_cents, 40000);
  const l1 = must(await post(ath, `/funding-needs/${nd.id}/links`, { rev: 1, application_id: app.id, allocated_cents: 40000 }), 201);
  assert.equal(l1.pending_cents, 40000);
  assert.equal((await post(ath, `/funding-needs/${nd.id}/links`, { rev: 2, application_id: app.id, allocated_cents: 1 })).status, 409);

  const ver = (await api('GET', `/sponsorship-programs/${p.id}`, { token: owner.token })).body.row_version;
  const won = must(await api('PATCH', `/program-applications/${app.id}`, { token: owner.token, body: { decision: 'award', program_version: ver } }));
  const issued = must(await ws(ath));
  assert.equal(issued.applications[0].award.status, 'issued');
  assert.ok(issued.next_actions.some((x) => x.code === 'answer_award' && x.entity.id === won.award.id && x.due_on));
  must(await post(ath, `/program-awards/${won.award.id}/respond`, { decision: 'accept', offer_version: won.award.offer_version }));
  const done = must(await ws(ath));
  assert.equal(done.applications[0].award.status, 'accepted');
  assert.equal(done.needs[0].secured_cents, 40000, 'an accepted award counts as secured');
  const deal = done.support[0];
  assert.ok(deal, 'the accepted award became one agreement');
  const clash = await post(ath, `/funding-needs/${nd.id}/links`, { rev: 2, sponsorship_id: deal.id, allocated_cents: 40000 });
  assert.equal(clash.status, 409, 'the agreement and its application are never both counted for one need');
  assert.equal(clash.body.error.details.code, 'double_count');
});

test('a guardian runs a young athlete\'s workspace; the young person is covered; strangers are not', async () => {
  const sponsor = await signup(['sponsor']), kid = await signup(['athlete'], { dob: yearsAgo(12) });
  const parent = await guardianOf(kid);
  const b = must(await api('POST', '/sponsors', { token: sponsor.token, body: { name: `KidBrand${n}` } }), 201);
  must(await post(parent, `/youth/children/${kid.id}/sponsors`, { sponsor_id: b.id }), 201);
  const deal = must(await api('POST', '/sponsorships', { token: sponsor.token, body: { sponsor_id: b.id, target_type: 'athlete', target_id: kid.id, deliverables: 'Kit', ...period, lines: [{ kind: 'money', label: 'Support', currency: 'SGD', amount_cents: 10000, cadence: 'once', first_due_on: '2030-02-01' }] } }), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: parent.token, body: { status: 'active', version: 1 } }));
  const mine = must(await ws(parent, { athlete_id: kid.id }));
  assert.equal(mine.access.role, 'guardian'); assert.equal(mine.athlete.youth, true); assert.equal(mine.totals[0].committed_cents, 10000);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_funding_workspace' AND entity_id=$2", [parent.id, kid.id])).rowCount > 0, 'a guardian\'s read is audit-logged');
  const created = must(await post(parent, '/funding-needs', { athlete_id: kid.id, category: 'education', title: 'School fees', amount_cents: 30000, currency: 'SGD', client_key: 'guardian-key-1' }), 201);
  assert.equal(created.athlete_id, kid.id);
  const stranger = await signup(['athlete']);
  assert.equal((await ws(stranger, { athlete_id: kid.id })).status, 404);
  assert.equal((await post(stranger, '/funding-needs', { athlete_id: kid.id, category: 'other', title: 'x', amount_cents: 5, currency: 'SGD', client_key: 'stranger-key-1' })).status, 404);
  assert.equal((await get(stranger, '/player-funding/export', { athlete_id: kid.id })).status, 404);
  // the guardian link ends: access ends on the next read, nothing is deleted
  await pool.query("UPDATE guardian_links SET revoked_at=now() WHERE guardian_id=$1 AND child_id=$2", [parent.id, kid.id]);
  assert.equal((await ws(parent, { athlete_id: kid.id })).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM athlete_funding_needs WHERE athlete_id=$1', [kid.id])).rows[0].n, 1);
});

test('sharing with a coach: only the chosen sections, live revocation, lapsed relationship, history, export and audit', async () => {
  const w = await world();
  await accept(w);
  const { coach } = await coachFor(w.ath);
  const mate = await signup(['coach']);
  const nd = must(await need(w.ath, { note: 'PRIVATE-NOTE-XYZ' }), 201);
  must(await post(w.ath, `/funding-needs/${nd.id}/links`, { rev: 1, sponsorship_id: w.deal.id, allocated_cents: 100000 }), 201);

  assert.equal((await ws(coach, { athlete_id: w.ath.id })).status, 404, 'a coach sees nothing without a share');
  const rec = must(await get(w.ath, '/funding-shares/recipients'));
  assert.deepEqual(rec.map((x) => x.id), [coach.id]);
  const mk = (extra = {}) => post(w.ath, '/funding-shares', { recipient_id: coach.id, purpose: 'funding_planning', sections: ['needs', 'dues'], expires_on: day(30), ...extra });
  assert.equal((await post(w.ath, '/funding-shares', { recipient_id: mate.id, purpose: 'funding_planning', sections: ['needs'], expires_on: day(30) })).status, 403, 'only a coach who coaches the athlete can be chosen');
  assert.equal((await mk({ expires_on: day(-1) })).status, 400); assert.equal((await mk({ expires_on: day(400) })).status, 400);
  assert.equal((await mk({ sections: [] })).status, 400); assert.equal((await mk({ sections: ['notes'] })).status, 400);
  const s = must(await mk(), 201);
  assert.equal(must(await mk(), 201).id, s.id, 'a repeated grant returns the same share');
  assert.equal((await mk({ sections: ['needs'] })).status, 409, 'a different grant for the same purpose is an edit');

  const seen = must(await ws(coach, { athlete_id: w.ath.id }));
  assert.equal(seen.access.role, 'staff'); assert.deepEqual(seen.access.sections, ['needs', 'dues']);
  assert.equal(seen.applications, null); assert.equal(seen.support, null); assert.deepEqual(seen.withheld, ['applications', 'support']);
  assert.equal(seen.next_actions, undefined, 'the actions are the athlete\'s to take');
  assert.ok(!('requested_cents' in seen.totals[0]) && seen.totals[0].committed_cents === 300000, 'application money is withheld, dues money is shown');
  assert.ok(!JSON.stringify(seen).includes('PRIVATE-NOTE-XYZ') && !('note' in seen.needs[0]), 'the athlete\'s private note never goes to a coach');
  assert.equal((await get(coach, '/player-funding/export', { athlete_id: w.ath.id })).status, 403, 'export was not granted');

  const upd = must(await api('PATCH', `/funding-shares/${s.id}`, { token: w.ath.token, body: { version: 1, can_export: true, sections: ['needs'] } }));
  assert.equal(upd.version, 2);
  assert.equal((await api('PATCH', `/funding-shares/${s.id}`, { token: w.ath.token, body: { version: 1, can_export: false } })).status, 409, 'stale share version');
  assert.equal(must(await ws(coach, { athlete_id: w.ath.id })).dues, null, 'narrowing applies on the very next read');
  const csv = must(await get(coach, '/player-funding/export', { athlete_id: w.ath.id }));
  assert.match(csv.csv.split('\n')[0], /^record,reference,label/); assert.ok(csv.csv.includes('need,') && !csv.csv.includes('due,'));
  assert.ok(!csv.csv.includes('PRIVATE'));
  const hist = must(await get(w.ath, '/funding-shares'));
  assert.deepEqual(['granted', 'updated', 'viewed', 'exported'].filter((a) => hist.events.some((e) => e.action === a)), ['granted', 'updated', 'viewed', 'exported']);
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='export_player_funding'", [coach.id])).rowCount, 1);
  assert.equal(must(await get(coach, '/funding-shared'))[0].athlete.id, w.ath.id);

  // not the coach's to change, and a stranger cannot see the history
  assert.equal((await api('PATCH', `/funding-shares/${s.id}`, { token: coach.token, body: { version: 2, sections: SECTIONS_ALL } })).status, 404);
  assert.equal((await post(coach, `/funding-shares/${s.id}/revoke`, {})).status, 404);
  assert.equal((await get(coach, '/funding-shares', { athlete_id: w.ath.id })).status, 404);

  // relationship lapses: refused at once; restored: works again (the share itself never changed)
  await pool.query("UPDATE team_members SET status='left' WHERE user_id=$1 AND role='coach'", [coach.id]);
  assert.equal((await ws(coach, { athlete_id: w.ath.id })).status, 404);
  assert.equal((await get(coach, '/player-funding/export', { athlete_id: w.ath.id })).status, 404);
  const lapsed = must(await get(coach, '/funding-shared'))[0];
  assert.equal(lapsed.blocked, 'no_relationship'); assert.equal(lapsed.athlete.display_name, null, 'a blocked share does not name the athlete');
  assert.match(must(await get(w.ath, '/funding-shares')).shares[0].blocked_reason, /no longer coach/);
  await pool.query("UPDATE team_members SET status='active' WHERE user_id=$1 AND role='coach'", [coach.id]);
  must(await ws(coach, { athlete_id: w.ath.id }));

  // revoke: the next read, export and listing are refused; history is kept
  assert.equal(must(await post(w.ath, `/funding-shares/${s.id}/revoke`, {})).state, 'revoked');
  assert.equal(must(await post(w.ath, `/funding-shares/${s.id}/revoke`, {})).state, 'revoked', 'revoking twice is harmless');
  assert.equal((await ws(coach, { athlete_id: w.ath.id })).status, 404);
  assert.equal((await get(coach, '/player-funding/export', { athlete_id: w.ath.id })).status, 404);
  assert.equal(must(await get(coach, '/funding-shared')).length, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM funding_shares WHERE id=$1', [s.id])).rows[0].n, 1);
  const again = must(await mk({ sections: ['needs'] }), 201);
  assert.notEqual(again.id, s.id, 'a new share after a revoke is a fresh grant');
});
const SECTIONS_ALL = ['needs', 'applications', 'support', 'dues'];

test('a young athlete\'s share needs the guardian\'s coaching consent, and withdrawing it ends access on the next read', async () => {
  const kid = await signup(['athlete'], { dob: yearsAgo(12) });
  const parent = await guardianOf(kid);
  const { coach } = await coachFor(kid);
  const mk = (u) => post(u, '/funding-shares', { athlete_id: kid.id, recipient_id: coach.id, purpose: 'application_support', sections: ['needs'], expires_on: day(30) });
  const refused = await mk(parent);
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details?.code, 'guardian_consent_required');
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'coaching',$2,1, now() + interval '30 days')", [kid.id, parent.id]);
  const s = must(await mk(parent), 201);
  assert.equal(s.athlete_id, kid.id);
  must(await ws(coach, { athlete_id: kid.id }));
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='coaching'", [kid.id]);
  assert.equal((await ws(coach, { athlete_id: kid.id })).status, 404, 'withdrawn consent applies on the next read');
  assert.equal(must(await get(coach, '/funding-shared'))[0].blocked, 'guardian_consent');
  const stranger = await signup(['athlete']);
  assert.equal((await post(stranger, `/funding-shares/${s.id}/revoke`, {})).status, 404);
  assert.equal(must(await post(parent, `/funding-shares/${s.id}/revoke`, {})).state, 'revoked');
});

test('export is audited, injection-safe, and the capabilities are the same over REST, OpenAPI and MCP', async () => {
  const w = await world();
  await accept(w);
  must(await need(w.ath, { title: '=HYPERLINK("http://evil","x")' }), 201);
  const e = must(await get(w.ath, '/player-funding/export'));
  assert.equal(e.content_type, 'text/csv');
  assert.ok(e.csv.includes("'=HYPERLINK"), 'formulas are neutralised');
  assert.equal(e.csv.split('\n').filter((l) => l.startsWith('due,')).length, 8);
  assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='export_player_funding'", [w.ath.id])).rowCount, 1);

  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  for (const [op, path] of [['get_player_funding_workspace', '/player-funding'], ['export_player_funding', '/player-funding/export'], ['create_funding_need', '/funding-needs'], ['link_funding_need', '/funding-needs/{id}/links'], ['create_funding_share', '/funding-shares'], ['revoke_funding_share', '/funding-shares/{id}/revoke']]) {
    assert.ok(Object.values(spec.paths[path] ?? {}).some((o) => o.operationId === op), `${op} is in the OpenAPI document`);
  }
  const viaMcp = await rpc('get_player_funding_workspace', {}, w.ath.token);
  assert.ok(!viaMcp.isError, JSON.stringify(viaMcp));
  const sc = viaMcp.structuredContent.result;
  assert.equal(sc.totals[0].committed_cents, 300000, 'MCP returns the same workspace as REST');
});

test('the migration is additive and the workspace never writes to the sponsorship tables', () => {
  const sql = readFileSync(new URL('../migrations/112_player_funding.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  assert.ok(!/\bDROP\b|\bTRUNCATE\b|\bDELETE\b|ON DELETE CASCADE|ALTER TABLE/i.test(sql), 'no destructive or table-altering statement');
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 4);
});
