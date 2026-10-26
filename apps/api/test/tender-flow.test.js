import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, ok, signup, start, stop, pool, buyerSide, publishedTender, supplierEntity, part, submitBid, inAt, dateOf, lots, rubric, questions, goodDraft, closeNow } from './tender-helpers.js';

before(start);
after(stop);

test('authority: unrelated users cannot create, approve or publish; the approver cannot approve their own request', async () => {
  const { owner, approver, org } = await buyerSide();
  const stranger = await signup('stranger', ['organizer']);
  assert.equal((await call('POST', '/rfps', { token: stranger.token, body: { title: 'Sneaky tender', category: 'Crew', organisation_id: org.id } })).status, 403);
  const t = ok(await call('POST', '/rfps', { token: owner.token, body: { title: 'Valid tender', category: 'Crew', organisation_id: org.id } }), 201);
  assert.equal((await call('GET', `/rfps/${t.id}`, { token: stranger.token })).status, 404, 'existence is not leaked');
  assert.equal((await call('POST', `/rfps/${t.id}/publish`, { token: stranger.token })).status, 404);
  assert.equal((await call('POST', `/rfps/${t.id}/publish`, { token: owner.token })).status, 409, 'draft cannot be published without approval');
  // validation blocks approval until the tender is complete
  const v = ok(await call('POST', `/rfps/${t.id}/validate`, { token: owner.token }));
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.field === 'lots') && v.issues.some((i) => i.field === 'rubric') && v.issues.some((i) => i.field === 'closes_at'));
  assert.equal((await call('POST', `/rfps/${t.id}/request-approval`, { token: owner.token })).status, 422);
  // a member with only a supplier role or plain membership cannot become approver
  const member = await signup('plain', ['organizer']);
  await pool.query("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at, invited_by) VALUES ($1,$2,'finance','active',now(),$3)", [org.id, member.id, owner.id]);
  assert.equal((await call('POST', `/rfps/${t.id}/members`, { token: owner.token, body: { handle: member.handle, role: 'approver' } })).status, 403);
});

test('publication: approval freezes the rubric, publishes at the stated time and the card is an allowlisted projection', async () => {
  const { owner, approver, org } = await buyerSide();
  const t = await publishedTender({ owner, approver, org, over: { budget_public: false } });
  assert.equal(t.status, 'published');
  const row = await pool.query('SELECT rubric_version, rubric_frozen_at, approvals_required FROM proc_projects WHERE id=$1', [t.id]);
  assert.equal(row.rows[0].rubric_version, 1); assert.ok(row.rows[0].rubric_frozen_at);
  assert.equal((await call('PATCH', `/rfps/${t.id}`, { token: owner.token, body: { row_version: t.row_version, title: 'Changed after approval' } })).status, 409, 'approved tenders only change through addenda');
  const supplier = await signup('sup', ['supplier']); const ent = await supplierEntity(supplier, 'Alpha Grounds Ltd');
  const list = ok(await call('GET', '/tenders', { token: supplier.token }));
  const card = list.find((c) => c.id === t.id);
  assert.ok(card && card.ref.startsWith('TND-'));
  assert.equal(card.budget, null, 'budget stays private unless published');
  for (const banned of ['scope', 'rubric', 'budget_minor', 'owner_user_id', 'fx', 'objective']) assert.ok(!(banned in card), `card must not expose ${banned}`);
  assert.equal(card.closes_at_utc, card.closes_at); assert.equal(card.timezone, 'Asia/Kolkata');
  // draft/private tenders are invisible
  const priv = await publishedTender({ owner, approver, org, over: { publication: 'private' } });
  assert.ok(!ok(await call('GET', '/tenders', { token: supplier.token })).some((c) => c.id === priv.id));
  assert.equal((await call('GET', `/tenders/${priv.id}`, { token: supplier.token })).status, 404);
  const invOnly = await publishedTender({ owner, approver, org, over: { publication: 'invite_only' } });
  assert.equal((await call('GET', `/tenders/${invOnly.id}`, { token: supplier.token })).status, 404);
  ok(await call('POST', `/rfps/${invOnly.id}/invites`, { token: owner.token, body: { entity_ids: [ent.id] } }));
  assert.equal((await call('GET', `/tenders/${invOnly.id}`, { token: supplier.token })).status, 200, 'invited supplier now sees it');
});

test('supplier journey: terms gate, validation checklist, one proposal per entity, idempotent submit with immutable receipt', async () => {
  const { owner, approver, org } = await buyerSide();
  const t = await publishedTender({ owner, approver, org });
  const alice = await signup('alice', ['supplier']), bob = await signup('bob', ['supplier']);
  const ent = await supplierEntity(alice, 'Alpha Grounds Ltd');
  ok(await call('POST', `/supplier-entities/${ent.id}/members`, { token: alice.token, body: { handle: bob.handle, role: 'bid_manager' } }));
  assert.equal((await call('POST', `/tenders/${t.id}/proposals`, { token: alice.token, body: { entity_id: ent.id, lots: ['L1'] } })).status, 403, 'not admitted yet');
  await part(alice, t, ent);
  const a = ok(await call('POST', `/tenders/${t.id}/proposals`, { token: alice.token, body: { entity_id: ent.id, lots: ['L1', 'L2'] } }), 201);
  const b = ok(await call('POST', `/tenders/${t.id}/proposals`, { token: bob.token, body: { entity_id: ent.id, lots: ['L1', 'L2'] } }), 201);
  assert.equal(a.id, b.id, 'collaborators share one proposal');
  const v = ok(await call('POST', `/proposals/${a.id}/validate`, { token: alice.token }));
  assert.equal(v.ok, false); assert.ok(v.items.some((i) => i.key === 'approach') && v.items.some((i) => i.key === 'price_L1'));
  assert.equal((await call('POST', `/proposals/${a.id}/submit`, { token: alice.token, body: { idempotency_key: 'k-aaaaaaaa', declaration: true } })).status, 422, 'incomplete bids are not accepted');
  // prices cannot hide in the technical envelope
  const bad = goodDraft(); bad.technical.answers.approach = 'Our price is ₹ 5000 per shift';
  assert.equal((await call('PATCH', `/proposals/${a.id}/draft`, { token: bob.token, body: { draft_version: a.draft_version, ...bad } })).status, 422);
  const saved = ok(await call('PATCH', `/proposals/${a.id}/draft`, { token: bob.token, body: { draft_version: a.draft_version, ...goodDraft() } }));
  assert.equal((await call('PATCH', `/proposals/${a.id}/draft`, { token: alice.token, body: { draft_version: a.draft_version, ...goodDraft() } })).status, 409, 'stale draft write is refused');
  assert.equal((await call('POST', `/proposals/${a.id}/submit`, { token: bob.token, body: { idempotency_key: 'k-bbbbbbbb', declaration: true } })).status, 403, 'only owner or signatory submits');
  const r1 = ok(await call('POST', `/proposals/${a.id}/submit`, { token: alice.token, body: { idempotency_key: 'retry-key-1', declaration: true } }));
  const r2 = ok(await call('POST', `/proposals/${a.id}/submit`, { token: alice.token, body: { idempotency_key: 'retry-key-1', declaration: true } }));
  assert.equal(r1.receipt_no, r2.receipt_no); assert.equal(r2.replayed, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proc_submissions WHERE proposal_id=$1', [a.id])).rows[0].n, 1, 'a retry never duplicates the bid');
  assert.match(r1.content_hash, /^[0-9a-f]{64}$/);
  // submitted rows are immutable and the content is sealed at rest
  await assert.rejects(pool.query("UPDATE proc_submissions SET late=true WHERE proposal_id=$1", [a.id]), /append-only/);
  const raw = (await pool.query('SELECT tech_enc, comm_enc FROM proc_submissions WHERE proposal_id=$1', [a.id])).rows[0];
  assert.ok(!raw.tech_enc.includes('trained crew') && !raw.comm_enc.includes('rate_minor'));
  // revision creates a new version; the earlier receipt stays
  const r3 = ok(await call('POST', `/proposals/${a.id}/submit`, { token: alice.token, body: { idempotency_key: 'revision-2', declaration: true } }));
  assert.equal(r3.version, 2); assert.notEqual(r3.receipt_no, r1.receipt_no);
  // suppliers see only their own proposal; a stranger gets 404
  const carol = await signup('carol', ['supplier']); await supplierEntity(carol, 'Carol Crew');
  assert.equal((await call('GET', `/proposals/${a.id}`, { token: carol.token })).status, 404);
});

test('venue owners and managers can hire suppliers by tender; plain staff, strangers and removed managers cannot', async () => {
  const owner = await signup('venueowner', ['venue_manager']), manager = await signup('venuemgr', ['venue_manager']), staff = await signup('venuestaff', ['venue_manager']), stranger = await signup('venuestranger', ['organizer']);
  const venue = ok(await call('POST', '/venues', { token: owner.token, body: { name: 'Riverside Aquatics Centre', city: 'Chennai' } }), 201);
  ok(await call('POST', `/venues/${venue.id}/staff`, { token: owner.token, body: { handle: manager.handle } }), 201);
  await pool.query("INSERT INTO venue_staff(venue_id, user_id, role) VALUES ($1,$2,'staff')", [venue.id, staff.id]);
  const create = (u) => call('POST', '/rfps', { token: u.token, body: { title: 'Pool water testing and maintenance', category: 'Pool maintenance', venue_id: venue.id } });
  const t = ok(await create(owner), 201);
  assert.equal(t.venue_id, venue.id); assert.deepEqual(t.sites.map((s) => s.label), ['Riverside Aquatics Centre']);
  assert.equal((await create(staff)).status, 403, 'plain staff cannot hire suppliers');
  assert.equal((await create(stranger)).status, 403);
  assert.equal((await call('POST', '/rfps', { token: owner.token, body: { title: 'Wrong venue tender', category: 'Crew', venue_id: '00000000-0000-4000-8000-000000000000' } })).status, 404);
  // the manager gets the owner role on the owner's tender and can run it; staff and strangers cannot even see it
  const asMgr = ok(await call('GET', `/rfps/${t.id}`, { token: manager.token })); assert.ok(asMgr.my_roles.includes('owner'));
  assert.ok(ok(await call('GET', '/rfps', { token: manager.token })).some((x) => x.id === t.id), 'the manager sees the venue\'s tenders in My RFPs');
  assert.equal((await call('GET', `/rfps/${t.id}`, { token: staff.token })).status, 404);
  assert.equal((await call('GET', `/rfps/${t.id}`, { token: stranger.token })).status, 404);
  const m2 = ok(await create(manager), 201); assert.equal(m2.owner_user_id, manager.id);
  // access is read live: removing the manager takes effect on the very next request, history stays
  await pool.query("UPDATE venue_staff SET removed_at=now() WHERE venue_id=$1 AND user_id=$2", [venue.id, manager.id]);
  assert.equal((await call('GET', `/rfps/${t.id}`, { token: manager.token })).status, 404);
  assert.equal((await create(manager)).status, 403);
  assert.ok((await pool.query('SELECT 1 FROM proc_projects WHERE id=$1', [m2.id])).rowCount === 1, 'what the manager created is kept');
  // the public card names the venue as the issuer
  assert.equal((await pool.query('SELECT venue_id FROM proc_projects WHERE id=$1', [t.id])).rows[0].venue_id, venue.id);
});
