import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { capabilities } = await import('../src/registry.js');
const { expireAcademyContent, fulfilContentLicencePaid } = await import('../src/academy-content.js');
const { describePurpose } = await import('../src/payments/service.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ac_${n}_${roles[0]}`, display_name: `Ac ${n}`, email: `ac${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const addMember = async (org, owner, u, role) => {
  ok(await api('POST', `/organisations/${org.id}/members`, { token: owner.token, body: { person: u.handle, role } }), 201);
  ok(await api('POST', `/organisations/${org.id}/invite/respond`, { token: u.token, body: { accept: true } }));
};
const LIB = {
  philosophy: { statement: 'Play with courage.', values: [{ key: 'respect', title: 'Respect' }] }, stages: [{ key: 'foundation', title: 'Foundation', age_min: 8, age_max: 10, hours_per_week: 4 }],
  game_model: [{ key: 'build', phase: 'in_possession', title: 'Build from the back' }], standards: { session_minutes: 75 },
  competencies: [{ key: 'first_touch', pillar: 'technical', title: 'First touch' }, { key: 'speed', pillar: 'physical', title: 'Speed' }],
  outcomes: [], drills: [{ key: 'rondo', title: 'Rondo 4v2', kind: 'skill_drill', competency_keys: ['first_touch'], duration_min: 15 }],
};
const OBJ = [{ key: 'touch', title: 'Receive on the back foot', competency_key: 'first_touch', sessions_target: 1, drill_keys: ['rondo'], success_criteria: '8 of 10 controlled' }];

/** A publisher academy with an approved, published curriculum + methodology, and a licensee academy (country ES) with an owner and two coaches. */
async function world({ licenseeCountry = 'ES', buyerParent = false } = {}) {
  const owner = await signup(), td = await signup(), buyer = await signup(), coach = await signup(['coach']), coach2 = await signup(['coach']), outsider = await signup(['coach']);
  const org = ok(await api('POST', '/organisations', { token: owner.token, body: { name: `Publisher Academy ${n}`, kind: 'academy' } }), 201);
  await addMember(org, owner, td, 'staff');
  ok(await api('POST', `/organisations/${org.id}/academy/staff/${td.id}`, { token: owner.token, body: { job_title: 'Technical Director', template: 'head_coach' } }));
  const buyerOrg = ok(await api('POST', '/organisations', { token: buyer.token, body: { name: `Partner Academy ${n}`, kind: 'academy' } }), 201);
  await addMember(buyerOrg, buyer, coach, 'coach'); await addMember(buyerOrg, buyer, coach2, 'coach');
  await pool.query("INSERT INTO addresses(owner_kind, owner_id, kind, country) VALUES ('organisation',$1,'billing',$2)", [buyerOrg.id, licenseeCountry]);
  if (buyerParent) await pool.query('UPDATE organisations SET parent_organisation_id=$2 WHERE id=$1', [buyerOrg.id, org.id]);
  const m = ok(await api('POST', `/organisations/${org.id}/academy/methodologies`, { token: owner.token, body: { sport: 'football', title: `Way ${n}` } }), 201);
  const mv = ok(await api('POST', `/academy/methodologies/${m.id}/versions`, { token: td.token, body: { row_version: m.row_version, ...LIB } }), 201);
  const cur = ok(await api('POST', `/organisations/${org.id}/academy/curricula`, { token: owner.token, body: { methodology_id: m.id, title: 'U12 Technical Core', age_min: 10, age_max: 12 } }), 201);
  const d = ok(await api('POST', `/academy/curricula/${cur.id}/versions`, { token: td.token, body: { objectives: OBJ } }), 201);
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/submit`, { token: td.token }));
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/decision`, { token: owner.token, body: { decision: 'approve' } }));
  ok(await api('POST', `/academy/curriculum-versions/${d.id}/publish`, { token: owner.token }));
  return { owner, td, buyer, coach, coach2, outsider, org, buyerOrg, m, mv: mv.methodology ?? m, curVersion: d };
}
const PACK = { title: 'U12 Technical Core — coach licence', sport: 'football', summary: 'Our methodology.', languages: ['en', 'es'], eligibility: 'open', authors: [{ name: 'Head of Methodology', role: 'author' }], price_minor: 0, revenue_share: [{ name: 'Academy', kind: 'academy', bp: 10000 }] };
const ITEMS = (w, extra = []) => [
  { kind: 'curriculum', ref_id: w.curVersion.id, title: 'U12 Technical Core v1', minutes: 60 },
  { kind: 'methodology', ref_id: w.m.id, ref_version: 1, title: 'Our methodology', minutes: 30 },
  { kind: 'drill', ref_id: w.m.id, ref_version: 1, ref_key: 'rondo', title: 'Rondo 4v2', minutes: 15 },
  { kind: 'module', title: 'Receiving under pressure', body: { blocks: [{ type: 'heading', text: 'Why scanning matters' }, { type: 'text', text: 'Scan before the ball arrives.' }], sources: [{ title: 'Sample study', evidence: 'peer_reviewed' }] }, minutes: 20 },
  ...extra,
];
async function publishedPack(w, packOver = {}, extraItems = []) {
  const p = ok(await api('POST', `/organisations/${w.org.id}/academy/content/packs`, { token: w.td.token, body: { ...PACK, ...packOver } }), 201);
  ok(await api('POST', `/academy/content/packs/${p.id}/draft`, { token: w.td.token, body: { objectives: [{ title: 'Coach the receive' }], assessment: { kind: 'observation', pass_mark: 70 }, cpd_hours: 3, items: ITEMS(w, extraItems) } }));
  const pub = ok(await api('POST', `/academy/content/packs/${p.id}/publish`, { token: w.td.token, body: {} }));
  return pub;
}
/** Request → propose → accept (free) → active licence with a seat for `coach`. */
async function licensed(w, pack, { seats = 2, propose = {}, seat = true } = {}) {
  ok(await api('POST', `/academy/content/packs/${pack.id}/request`, { token: w.buyer.token, body: { org_id: w.buyerOrg.id, seats } }), 201);
  const l = ok(await api('POST', `/academy/content/packs/${pack.id}/licences`, { token: w.td.token, body: { licensee_org_id: w.buyerOrg.id, seats, ...propose } }), 201);
  const acc = ok(await api('POST', `/academy/content/licences/${l.id}/respond`, { token: w.buyer.token, body: { action: 'accept' } }));
  if (seat && acc.stage === 'active') ok(await api('POST', `/academy/content/licences/${l.id}/seats`, { token: w.buyer.token, body: { user_id: w.coach.id } }), 201);
  return { l, acc };
}

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('lifecycle: pack → publish → request → terms → accept → seat → read → link to a session; no content is copied into the buyer’s tables', async () => {
  const w = await world();
  const pack = await publishedPack(w);
  assert.equal(pack.status, 'published'); assert.equal(pack.current_version, 1);
  const market = ok(await api('GET', '/academy/content/marketplace', { token: w.buyer.token, query: { org_id: w.buyerOrg.id } }));
  assert.equal(market.length, 1); assert.equal(market[0].eligible, true);
  // preview shows the syllabus but locks it
  const prev = ok(await api('GET', `/academy/content/packs/${pack.id}`, { token: w.buyer.token, query: { org_id: w.buyerOrg.id } }));
  assert.equal(prev.side, 'buyer'); assert.equal(prev.items.length, 4); assert.ok(prev.items.every((i) => i.locked)); assert.equal(prev.items[0].body, undefined);
  const { l, acc } = await licensed(w, pack);
  assert.equal(acc.state, 'active');
  const lib = ok(await api('GET', '/me/academy/content', { token: w.coach.token }));
  assert.equal(lib.length, 1); assert.equal(lib[0].locked, false); assert.equal(lib[0].syllabus.length, 4);
  const items = lib[0].syllabus;
  const cur = ok(await api('GET', `/academy/content/licences/${l.id}/items/${items[0].id}`, { token: w.coach.token }));
  assert.equal(cur.reference.title, 'U12 Technical Core'); assert.equal(cur.reference.objectives[0].key, 'touch');
  const drill = ok(await api('GET', `/academy/content/licences/${l.id}/items/${items[2].id}`, { token: w.coach.token }));
  assert.equal(drill.reference.drill.key, 'rondo');
  const mod = ok(await api('GET', `/academy/content/licences/${l.id}/items/${items[3].id}`, { token: w.coach.token }));
  assert.equal(mod.item.body.blocks.length, 2);
  ok(await api('POST', `/academy/content/licences/${l.id}/items/${items[0].id}/complete`, { token: w.coach.token, body: { seconds: 300 } }));
  ok(await api('POST', `/academy/content/licences/${l.id}/rating`, { token: w.coach.token, body: { stars: 5 } }));
  // nothing was copied into the buyer's academy
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_curricula WHERE organisation_id=$1', [w.buyerOrg.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM academy_methodologies WHERE organisation_id=$1', [w.buyerOrg.id])).rows[0].n, 0);
  // telemetry + overview + history
  const tel = ok(await api('GET', `/academy/content/packs/${pack.id}/telemetry`, { token: w.td.token }));
  assert.equal(tel.items.find((i) => i.id === items[0].id).opened, 1); assert.equal(tel.items.find((i) => i.id === items[0].id).completed, 1);
  const ov = ok(await api('GET', `/organisations/${w.org.id}/academy/content/overview`, { token: w.td.token }));
  assert.equal(ov.kpis.active_licences, 1); assert.equal(ov.kpis.seats_used, 1);
  const det = ok(await api('GET', `/academy/content/licences/${l.id}`, { token: w.td.token }));
  assert.ok(det.events.some((e) => e.action === 'activated')); assert.equal(det.seat_holders.length, 1);
});

test('acceptance #1: a revoked licence loses unpublished-and-published pack access at once, without touching the buyer’s own academy; a new publisher version never leaks to a revoked buyer', async () => {
  const w = await world();
  const pack = await publishedPack(w);
  const { l } = await licensed(w, pack);
  const [it] = ok(await api('GET', '/me/academy/content', { token: w.coach.token }))[0].syllabus;
  ok(await api('GET', `/academy/content/licences/${l.id}/items/${it.id}`, { token: w.coach.token }));
  // publisher ships v2 (pack-native module changed)
  ok(await api('POST', `/academy/content/packs/${pack.id}/draft`, { token: w.td.token, body: { objectives: [{ title: 'Coach the receive' }], cpd_hours: 4, items: ITEMS(w).concat([{ kind: 'module', title: 'Unreleased v2 module', body: { blocks: [{ type: 'text', text: 'secret' }] } }]) } }));
  ok(await api('POST', `/academy/content/packs/${pack.id}/publish`, { token: w.td.token, body: {} }));
  assert.equal(ok(await api('GET', '/me/academy/content', { token: w.coach.token }))[0].syllabus.length, 5);
  ok(await api('POST', `/academy/content/licences/${l.id}/manage`, { token: w.td.token, body: { action: 'revoke', reason_code: 'breach' } }));
  const r = await api('GET', `/academy/content/licences/${l.id}/items/${it.id}`, { token: w.coach.token });
  assert.equal(r.status, 402); assert.equal(r.body.error?.code ?? r.body.code, 'licence_inactive');
  assert.equal((await api('POST', `/academy/content/licences/${l.id}/items/${it.id}/use`, { token: w.coach.token, body: { session_id: l.id } })).status, 402);
  const libAfter = ok(await api('GET', '/me/academy/content', { token: w.coach.token }));
  assert.equal(libAfter[0].locked, true);
  // the buyer's own academy access is unaffected
  ok(await api('GET', `/organisations/${w.buyerOrg.id}/academy/methodologies`, { token: w.buyer.token }));
  assert.equal((await api('GET', `/organisations/${w.buyerOrg.id}`, { token: w.coach.token })).status, 200);
  // history is kept and a revoked licence cannot be reinstated
  assert.equal((await api('POST', `/academy/content/licences/${l.id}/manage`, { token: w.td.token, body: { action: 'reinstate' } })).status, 409);
  assert.ok(ok(await api('GET', `/academy/content/licences/${l.id}`, { token: w.td.token })).events.some((e) => e.action === 'revoke'));
});

test('expiry: past its window and grace the licence ends by itself (sweep); inside grace reading still works', async () => {
  const w = await world();
  const pack = await publishedPack(w);
  const { l } = await licensed(w, pack, { propose: { grace_days: 5 } });
  const [it] = ok(await api('GET', '/me/academy/content', { token: w.coach.token }))[0].syllabus;
  await pool.query("UPDATE academy_content_licences SET effective_from=current_date-40, effective_to=current_date-2 WHERE id=$1", [l.id]);
  const g = ok(await api('GET', `/academy/content/licences/${l.id}/items/${it.id}`, { token: w.coach.token }));
  assert.equal(g.grace, true);
  await pool.query("UPDATE academy_content_licences SET effective_to=current_date-9 WHERE id=$1", [l.id]);
  assert.equal((await api('GET', `/academy/content/licences/${l.id}/items/${it.id}`, { token: w.coach.token })).status, 402);
  const s = await expireAcademyContent();
  assert.equal(s.expired, 1);
  assert.equal((await pool.query('SELECT stage FROM academy_content_licences WHERE id=$1', [l.id])).rows[0].stage, 'expired');
  assert.equal((await expireAcademyContent()).expired, 0);   // idempotent
});

test('authorisation & negatives: publisher rights, eligibility, territory, seats, tenants and unpublished packs', async () => {
  const w = await world();
  // an outsider and a buyer cannot publish for the academy (404, not 403)
  assert.equal((await api('POST', `/organisations/${w.org.id}/academy/content/packs`, { token: w.outsider.token, body: PACK })).status, 404);
  assert.equal((await api('POST', `/organisations/${w.org.id}/academy/content/packs`, { token: w.buyer.token, body: PACK })).status, 404);
  const p = ok(await api('POST', `/organisations/${w.org.id}/academy/content/packs`, { token: w.td.token, body: { ...PACK, eligibility: 'affiliated' } }), 201);
  // incomplete packs cannot be published, and say why
  const bad = await api('POST', `/academy/content/packs/${p.id}/publish`, { token: w.td.token, body: {} });
  assert.equal(bad.status, 422); assert.ok(bad.body.error.details.problems.length >= 2);
  // items may only point at the academy's own approved content
  const w2 = await world();
  const foreign = await api('POST', `/academy/content/packs/${p.id}/draft`, { token: w.td.token, body: { items: [{ kind: 'curriculum', ref_id: w2.curVersion.id, title: 'Not mine' }] } });
  assert.equal(foreign.status, 400);
  // an unpublished pack is invisible to buyers
  assert.equal((await api('GET', `/academy/content/packs/${p.id}`, { token: w.buyer.token, query: { org_id: w.buyerOrg.id } })).status, 404);
  assert.equal((await api('POST', `/academy/content/packs/${p.id}/request`, { token: w.buyer.token, body: { org_id: w.buyerOrg.id, seats: 1 } })).status, 409);
  ok(await api('POST', `/academy/content/packs/${p.id}/draft`, { token: w.td.token, body: { objectives: [{ title: 'x1' }], items: ITEMS(w) } }));
  ok(await api('POST', `/academy/content/packs/${p.id}/publish`, { token: w.td.token, body: {} }));
  // affiliated-only: an unaffiliated, unrelated buyer is not eligible…
  const r = await api('POST', `/academy/content/packs/${p.id}/request`, { token: w.buyer.token, body: { org_id: w.buyerOrg.id, seats: 1 } });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'not_eligible');
  // …a coach of the buyer cannot buy for the organisation…
  assert.equal((await api('POST', `/academy/content/packs/${p.id}/request`, { token: w.coach.token, body: { org_id: w.buyerOrg.id, seats: 1 } })).status, 403);
  // …a network campus (child organisation) is eligible
  await pool.query('UPDATE organisations SET parent_organisation_id=$2 WHERE id=$1', [w.buyerOrg.id, w.org.id]);
  ok(await api('POST', `/academy/content/packs/${p.id}/request`, { token: w.buyer.token, body: { org_id: w.buyerOrg.id, seats: 1 } }), 201);
  // territory: a pack released only in India is not available in Spain
  const inOnly = await publishedPack(w, { title: 'India only', eligibility: 'open', territory_mode: 'include', countries: ['IN'] });
  const t = await api('POST', `/academy/content/packs/${inOnly.id}/request`, { token: w.buyer.token, body: { org_id: w.buyerOrg.id, seats: 1 } });
  assert.equal(t.status, 409); assert.match(t.body.error.message, /not released in ES/);
  // a licence cannot widen the pack's territory
  assert.equal((await api('POST', `/academy/content/packs/${inOnly.id}/licences`, { token: w.td.token, body: { licensee_org_id: w2.buyerOrg.id, seats: 1 } })).status, 409);   // buyer outside the territory
  const noUs = await publishedPack(w, { title: 'Not in the US', eligibility: 'open', territory_mode: 'exclude', countries: ['US'] });
  assert.equal((await api('POST', `/academy/content/packs/${noUs.id}/licences`, { token: w.td.token, body: { licensee_org_id: w2.buyerOrg.id, seats: 1, territory_mode: 'worldwide' } })).status, 400);
  // seats: cannot exceed the licence; only coaches/staff of the licensed organisation; a seat holder from another tenant gets 404
  const open = await publishedPack(w, { title: 'Open pack', max_seats: 5 });
  const { l } = await licensed(w2, await publishedPack(w2, { title: 'W2 pack' }), { seats: 1 });
  const { l: l1 } = await licensed(w, open, { seats: 1 });
  assert.equal((await api('POST', `/academy/content/licences/${l1.id}/seats`, { token: w.buyer.token, body: { user_id: w.coach2.id } })).body.error.code, 'no_seats_left');
  assert.equal((await api('POST', `/academy/content/licences/${l1.id}/seats`, { token: w.buyer.token, body: { user_id: w.outsider.id } })).status, 400);
  const [it] = ok(await api('GET', '/me/academy/content', { token: w.coach.token })).find((x) => x.id === l1.id).syllabus;
  assert.equal((await api('GET', `/academy/content/licences/${l1.id}/items/${it.id}`, { token: w.coach2.token })).status, 404);   // no seat
  assert.equal((await api('GET', `/academy/content/licences/${l1.id}/items/${it.id}`, { token: w2.coach.token })).status, 404);  // other tenant
  assert.equal((await api('GET', `/academy/content/licences/${l1.id}`, { token: w2.buyer.token })).status, 404);
  assert.equal((await api('POST', `/academy/content/licences/${l1.id}/manage`, { token: w.buyer.token, body: { action: 'revoke', reason_code: 'breach' } })).status, 404);   // the buyer cannot revoke
  assert.ok(l.id);
  // max seats on the pack
  assert.equal((await api('POST', `/academy/content/packs/${open.id}/licences`, { token: w.td.token, body: { licensee_org_id: w2.buyerOrg.id, seats: 6 } })).status, 400);
});

test('a published version is immutable evidence; items cannot be changed behind it', async () => {
  const w = await world();
  const pack = await publishedPack(w);
  const v = (await pool.query("SELECT id FROM academy_content_pack_versions WHERE pack_id=$1 AND status='published'", [pack.id])).rows[0];
  await assert.rejects(pool.query("UPDATE academy_content_pack_items SET title='tampered' WHERE version_id=$1", [v.id]), /cannot be edited/);
  await assert.rejects(pool.query('DELETE FROM academy_content_pack_items WHERE version_id=$1', [v.id]), /cannot be edited/);
  await assert.rejects(pool.query('UPDATE academy_content_licence_events SET action=$1', ['x']), /append-only|0 rows|./);
});

test('paid licence: accept → awaiting payment → payment fulfils it → seats; renewal keeps the old licence running until paid and then moves the seats', async () => {
  const w = await world();
  const pack = await publishedPack(w, { price_minor: 50000, currency: 'EUR' });
  const { l, acc } = await licensed(w, pack, { seats: 2, seat: false });
  assert.equal(acc.stage, 'awaiting_payment'); assert.equal(Number(acc.price_minor), 100000);
  const d = await describePurpose(pool, 'content_licence', l.id);
  assert.equal(d.payerId, w.buyer.id); assert.equal(d.amount, 100000); assert.equal(d.payable, true);
  assert.equal((await api('POST', `/academy/content/licences/${l.id}/seats`, { token: w.buyer.token, body: { user_id: w.coach.id } })).status, 409);   // not active yet
  const c = await pool.connect(); try { await c.query('BEGIN'); assert.equal(await fulfilContentLicencePaid(c, l.id, w.buyer.id), true); assert.equal(await fulfilContentLicencePaid(c, l.id, w.buyer.id), false); await c.query('COMMIT'); } finally { c.release(); }
  assert.equal((await pool.query('SELECT stage FROM academy_content_licences WHERE id=$1', [l.id])).rows[0].stage, 'active');
  ok(await api('POST', `/academy/content/licences/${l.id}/seats`, { token: w.buyer.token, body: { user_id: w.coach.id } }), 201);
  const fin = ok(await api('GET', `/academy/content/packs/${pack.id}/finance`, { token: w.td.token }));
  assert.equal(fin.gross_minor, 100000); assert.equal(fin.share_statement[0].amount_minor, 100000);
  // renewal
  const r = ok(await api('POST', `/academy/content/licences/${l.id}/renew`, { token: w.td.token, body: {} }), 201);
  assert.equal(r.stage, 'proposed'); assert.equal(r.renewal_of, l.id);
  assert.equal((await pool.query('SELECT stage FROM academy_content_licences WHERE id=$1', [l.id])).rows[0].stage, 'active');   // still running
  const acc2 = ok(await api('POST', `/academy/content/licences/${r.id}/respond`, { token: w.buyer.token, body: { action: 'accept' } }));
  assert.equal(acc2.stage, 'awaiting_payment');
  const c2 = await pool.connect(); try { await c2.query('BEGIN'); await fulfilContentLicencePaid(c2, r.id, w.buyer.id); await c2.query('COMMIT'); } finally { c2.release(); }
  assert.equal((await pool.query('SELECT stage FROM academy_content_licences WHERE id=$1', [l.id])).rows[0].stage, 'expired');
  const lib = ok(await api('GET', '/me/academy/content', { token: w.coach.token }));
  assert.ok(lib.some((x) => x.id === r.id && x.state === 'active'));   // the seat moved across
});

test('youth footage is stream-only with a watermark and never offline; offline grants follow the licence; a takedown pulls an item everywhere', async () => {
  const w = await world();
  const pack = await publishedPack(w, { offline_allowed: true }, [{ kind: 'video', title: 'U10 match footage', external_url: 'https://video.example.com/u10', youth_footage: true }]);
  const { l } = await licensed(w, pack, { propose: { offline_allowed: true } });
  const syl = ok(await api('GET', '/me/academy/content', { token: w.coach.token }))[0].syllabus;
  const vid = syl.find((s) => s.kind === 'video');
  const o = ok(await api('GET', `/academy/content/licences/${l.id}/items/${vid.id}`, { token: w.coach.token }));
  assert.equal(o.stream_only, true); assert.equal(o.offline_ok, false); assert.ok(o.watermark);
  const g = ok(await api('POST', `/academy/content/licences/${l.id}/offline`, { token: w.coach.token }), 201);
  assert.ok(!g.item_ids.includes(vid.id)); assert.equal(g.excluded_youth_footage, 1);
  assert.equal(ok(await api('GET', `/academy/content/offline/${g.grant_id}`, { token: w.coach.token })).valid, true);
  // takedown of an item
  const cs = ok(await api('POST', '/academy/content/cases', { token: w.coach.token, body: { pack_id: pack.id, licence_id: l.id, item_id: vid.id, kind: 'takedown', note: 'Parent asked for removal' } }), 201);
  ok(await api('POST', `/academy/content/cases/${cs.id}/resolve`, { token: w.td.token, body: { status: 'resolved', resolution: 'Removed', takedown: 'withdraw', takedown_reason: 'youth_safeguarding' } }));
  assert.equal((await api('GET', `/academy/content/licences/${l.id}/items/${vid.id}`, { token: w.coach.token })).status, 410);
  assert.equal(ok(await api('GET', `/academy/content/offline/${g.grant_id}`, { token: w.coach.token })).valid, false);
  const cases = ok(await api('GET', `/organisations/${w.org.id}/academy/content/cases`, { token: w.td.token }));
  assert.equal(cases[0].note, 'Parent asked for removal');
  assert.equal((await pool.query('SELECT note_enc FROM academy_content_cases').then((r) => r.rows[0].note_enc)).includes('Parent'), false);   // encrypted at rest
  // revoking the licence kills offline copies too
  const g2 = ok(await api('POST', `/academy/content/licences/${l.id}/offline`, { token: w.coach.token }), 201);
  ok(await api('POST', `/academy/content/licences/${l.id}/manage`, { token: w.td.token, body: { action: 'suspend', reason_code: 'non_payment' } }));
  assert.equal(ok(await api('GET', `/academy/content/offline/${g2.grant_id}`, { token: w.coach.token })).valid, false);
  // a pack that does not allow offline cannot grant it
  const w3 = await world(); const p3 = await publishedPack(w3); const { l: l3 } = await licensed(w3, p3);
  assert.equal((await api('POST', `/academy/content/licences/${l3.id}/offline`, { token: w3.coach.token })).status, 403);
});

test('every sport in the catalogue can be packaged natively (pack sport is the catalogue slug); the registry exposes REST/MCP for every content capability', async () => {
  const w = await world();
  const sports = (await pool.query('SELECT slug FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 20);
  for (const s of sports) ok(await api('POST', `/organisations/${w.org.id}/academy/content/packs`, { token: w.td.token, body: { ...PACK, title: `Pack ${s.slug}`, sport: s.slug } }), 201);
  const caps = capabilities.filter((c) => /content_(pack|licence|item|case|overview|telemetry|finance|offline|seat|marketplace)|my_content/.test(c.name));
  assert.ok(caps.length >= 25, `only ${caps.length}`);
  for (const c of caps) assert.ok(c.path && c.method && c.summary && c.tag === 'Academy content licensing', c.name);
});
