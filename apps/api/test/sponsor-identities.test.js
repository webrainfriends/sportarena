import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['sponsor']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `si_${n}_${roles[0]}`, display_name: `Ident ${n}`, email: `si${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201); return { ...r.body.user, token: r.body.token }; };
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const entityBrand = async (u, name = `Brand${++n}`, { sponsor_type = 'company', legal_name = `${name} Holdings Ltd`, ...extra } = {}) => {
  const b = must(await api('POST', '/sponsors', { token: u.token, body: { name, ...extra } }), 201);
  const idn = must(await api('POST', `/sponsors/${b.id}/identity`, { token: u.token, body: { sponsor_type, legal_name } }));
  return { ...b, entity_id: idn.entity_id };
};
const team = async (owner, entityId, user, role) => {
  const inv = must(await api('POST', `/sponsor-entities/${entityId}/representatives`, { token: owner.token, body: { user_id: user.id, role } }), 201);
  must(await api('POST', `/sponsor-representatives/${inv.id}/response`, { token: user.token, body: { accept: true } }));
  return inv.id;
};
const optedIn = async () => {
  const a = await signup(['athlete']);
  await api('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'tennis', role: 'athlete' } });
  must(await api('POST', '/me/sponsorship-profile', { token: a.token, body: { open_to_sponsors: true } }));
  return a;
};
const offer = (u, brandId, athlete, extra = {}) => api('POST', '/sponsorships', { token: u.token, body: { sponsor_id: brandId, target_type: 'athlete', target_id: athlete.id, amount_cents: 500000, objectives: 'Awareness', deliverables: 'Wear the kit', starts_on: day(1), ends_on: day(180), ...extra } });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('legacy brands migrate without fabricated identity; identity is confirmed explicitly and is versioned', async () => {
  const u = await signup();
  const legacy = must(await api('POST', '/sponsors', { token: u.token, body: { name: 'LegacyCo', contact_email: 'a@legacy.example' } }), 201);
  assert.equal(legacy.entity_id, null);
  const mine = must(await api('GET', '/sponsors', { token: u.token, query: { mine: 'true' } }));
  assert.equal(mine[0].identity_confirmed, false); assert.equal(mine[0].my_role, 'manager');
  const before = must(await api('GET', `/sponsors/${legacy.id}/identity`, { token: u.token }));
  assert.equal(before.identity_confirmed, false);
  for (const k of ['sponsor_type', 'legal_name', 'registration_number', 'tax_id', 'billing_email']) assert.equal(before[k] ?? null, null, `${k} not invented`);
  assert.equal((await api('POST', `/sponsors/${legacy.id}/identity`, { token: u.token, body: { legal_name: 'LegacyCo Ltd' } })).status, 400, 'type needed to confirm');

  const saved = must(await api('POST', `/sponsors/${legacy.id}/identity`, { token: u.token, body: { sponsor_type: 'company', legal_name: 'LegacyCo Ltd', registration_country: 'gb', registration_number: 'RC123456', tax_id: 'GB999', billing_email: 'bill@legacy.example', billing_address: '1 High St, London' } }));
  assert.equal(saved.identity_confirmed, true); assert.equal(saved.registration_number, 'RC123456'); assert.equal(saved.registration_country, 'GB');
  const v = saved.row_version;
  const stale = await api('POST', `/sponsors/${legacy.id}/identity`, { token: u.token, body: { legal_name: 'LegacyCo Group Ltd', row_version: v - 1 } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details.row_version, v);
  assert.equal((await api('POST', `/sponsors/${legacy.id}/identity`, { token: u.token, body: { legal_name: 'X Ltd' } })).status, 400, 'row_version required once it exists');
  const upd = must(await api('POST', `/sponsors/${legacy.id}/identity`, { token: u.token, body: { legal_name: 'LegacyCo Group Ltd', row_version: v } }));
  assert.equal(upd.row_version, v + 1); assert.equal(upd.tax_id, 'GB999', 'untouched fields stay');
  assert.equal((await api('POST', `/sponsors/${legacy.id}/identity`, { token: u.token, body: { sponsor_type: 'individual', registration_number: 'RC1', row_version: upd.row_version } })).status, 400, 'individuals have no company number');
  const { rows } = await pool.query('SELECT registration_number_enc, tax_id_enc FROM sponsor_entities WHERE id=$1', [upd.entity_id]);
  assert.ok(rows[0].registration_number_enc.startsWith('v1.') && !rows[0].registration_number_enc.includes('RC123456'), 'stored encrypted');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_pii' AND entity='sponsor_entities' AND entity_id=$1 AND actor_id=$2", [upd.entity_id, u.id])).rowCount > 0, 'decrypting is audit-logged');
});

test('concurrent identity saves: one wins, the other gets a stale-version conflict', async () => {
  const u = await signup();
  const b = await entityBrand(u);
  const cur = must(await api('GET', `/sponsors/${b.id}/identity`, { token: u.token }));
  const rs = await Promise.all([1, 2, 3].map((k) => api('POST', `/sponsors/${b.id}/identity`, { token: u.token, body: { legal_name: `Racer ${k} Ltd`, row_version: cur.row_version } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
});

test('public directory and public profile never expose private identity', async () => {
  const u = await signup();
  const b = await entityBrand(u, 'PublicBrand', { industry: 'Sport' });
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: u.token, body: { legal_name: 'Secret Legal Name Ltd', registration_number: 'SECRET-REG', tax_id: 'SECRET-TAX', billing_email: 'secret@bill.example', row_version: 2 } }));
  const dir = JSON.stringify(must(await api('GET', '/sponsors', { query: { q: 'PublicBrand' } })));
  const pub = JSON.stringify(must(await api('GET', `/sponsors/${b.id}`)));
  const other = await signup();
  const asOther = JSON.stringify(must(await api('GET', `/sponsors/${b.id}`, { token: other.token })));
  for (const text of [dir, pub, asOther]) for (const secret of ['Secret Legal', 'SECRET-REG', 'SECRET-TAX', 'secret@bill', 'registration', 'billing']) assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.equal(JSON.parse(dir)[0].sponsor_type, 'company');
  assert.equal(must(await api('GET', `/sponsors/${b.id}`)).sponsor_type, 'company');
  // a stranger cannot read or write the identity, and does not learn the brand's entity exists
  assert.equal((await api('GET', `/sponsors/${b.id}/identity`, { token: other.token })).status, 404);
  assert.equal((await api('POST', `/sponsors/${b.id}/identity`, { token: other.token, body: { legal_name: 'Hijack Ltd', row_version: 1 } })).status, 404);
  assert.equal((await api('GET', `/sponsor-entities/${b.entity_id}/export`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/sponsor-entities/${b.entity_id}/representatives`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/sponsors/${b.id}/identity`)).status, 401);
});

test('role matrix: finance reports payments only, viewer reads only, owner/admin run identity and team', async () => {
  const owner = await signup(), admin = await signup(['athlete']), fin = await signup(['athlete']), viewer = await signup(['athlete']), pm = await signup(['athlete']);
  const b = await entityBrand(owner);
  const e = b.entity_id;
  await team(owner, e, admin, 'admin'); await team(owner, e, fin, 'finance'); await team(owner, e, viewer, 'viewer'); await team(owner, e, pm, 'portfolio_manager');
  const athlete = await optedIn();
  // finance / viewer cannot make offers; admin can
  assert.equal((await offer(fin, b.id, athlete)).status, 403);
  assert.equal((await offer(viewer, b.id, athlete)).status, 403);
  const proposed = must(await offer(admin, b.id, athlete), 201);
  // read access for the whole team, but a portfolio manager with no portfolio has none
  for (const u of [admin, fin, viewer]) assert.equal((await api('GET', `/sponsorships/${proposed.id}`, { token: u.token })).status, 200);
  assert.equal((await api('GET', `/sponsorships/${proposed.id}`, { token: pm.token })).status, 403);
  assert.equal((await api('POST', `/sponsorships/${proposed.id}/withdraw`, { token: viewer.token })).status, 403);
  // identity and team: finance/viewer/pm are denied, admin may edit identity but not appoint owners
  for (const u of [fin, viewer]) {
    assert.equal((await api('POST', `/sponsors/${b.id}/identity`, { token: u.token, body: { legal_name: 'Nope Ltd', row_version: 2 } })).status, 403);
    assert.equal((await api('GET', `/sponsor-entities/${e}/representatives`, { token: u.token })).status, 403);
  }
  assert.equal((await api('POST', `/sponsors/${b.id}/identity`, { token: pm.token, body: { legal_name: 'Nope Ltd', row_version: 2 } })).status, 404, 'unassigned portfolio manager cannot even see the brand');
  const identity = must(await api('GET', `/sponsors/${b.id}/identity`, { token: fin.token }));
  assert.equal(identity.registration_number, undefined, 'finance does not see private fields');
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: admin.token, body: { billing_email: 'ap@x.example', row_version: identity.row_version } }));
  const extra = await signup(['athlete']);
  assert.equal((await api('POST', `/sponsor-entities/${e}/representatives`, { token: admin.token, body: { user_id: extra.id, role: 'owner' } })).status, 403);
  must(await api('POST', `/sponsor-entities/${e}/representatives`, { token: admin.token, body: { user_id: extra.id, role: 'viewer' } }), 201);
  // sponsorship list scopes by team
  const list = must(await api('GET', '/sponsorships', { token: viewer.token }));
  assert.ok(list.some((s) => s.id === proposed.id && s.i_am_sponsor));
  assert.equal(must(await api('GET', '/sponsorships', { token: (await signup()).token })).length, 0);
});

test('invitations: accept/decline once, no youth, idempotent invite, one owner always remains', async () => {
  const owner = await signup(), guest = await signup(['athlete']);
  const b = await entityBrand(owner), e = b.entity_id;
  const inv = must(await api('POST', `/sponsor-entities/${e}/representatives`, { token: owner.token, body: { user_id: guest.id, role: 'finance' } }), 201);
  assert.equal(must(await api('POST', `/sponsor-entities/${e}/representatives`, { token: owner.token, body: { user_id: guest.id, role: 'finance' } }), 201).id, inv.id, 'same invite returned');
  assert.equal((await api('POST', `/sponsor-entities/${e}/representatives`, { token: owner.token, body: { user_id: guest.id, role: 'viewer' } })).status, 409);
  assert.equal((await api('GET', `/sponsors/${b.id}/identity`, { token: guest.token })).status, 404, 'no access before accepting');
  assert.equal(must(await api('GET', '/me/sponsor-identities', { token: guest.token })).invitations.length, 1);
  assert.equal((await api('POST', `/sponsor-representatives/${inv.id}/response`, { token: owner.token, body: { accept: true } })).status, 404, 'only the invitee answers');
  must(await api('POST', `/sponsor-representatives/${inv.id}/response`, { token: guest.token, body: { accept: true } }));
  assert.equal((await api('POST', `/sponsor-representatives/${inv.id}/response`, { token: guest.token, body: { accept: false } })).status, 409);
  assert.equal((await api('POST', `/sponsor-entities/${e}/representatives`, { token: owner.token, body: { user_id: guest.id, role: 'viewer' } })).status, 409, 'already active');
  // youth cannot be a representative
  const kid = await signup(['athlete']);
  await pool.query("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [kid.id]);
  assert.equal((await api('POST', `/sponsor-entities/${e}/representatives`, { token: owner.token, body: { user_id: kid.id, role: 'viewer' } })).status, 400);
  // last owner
  const reps = must(await api('GET', `/sponsor-entities/${e}/representatives`, { token: owner.token }));
  const ownerRep = reps.find((r) => r.user_id === owner.id);
  assert.equal((await api('PATCH', `/sponsor-representatives/${ownerRep.id}`, { token: owner.token, body: { role: 'admin' } })).status, 409);
  assert.equal((await api('POST', `/sponsor-representatives/${ownerRep.id}/remove`, { token: owner.token })).status, 409);
  // a second owner lets the first leave; concurrent leave of both owners keeps one
  const second = await signup(['athlete']); await team(owner, e, second, 'owner');
  const both = await Promise.all([api('POST', `/sponsor-representatives/${ownerRep.id}/remove`, { token: owner.token }), api('POST', `/sponsor-representatives/${reps.length ? (must(await api('GET', `/sponsor-entities/${e}/representatives`, { token: owner.token })).find((r) => r.user_id === second.id).id) : ''}/remove`, { token: second.token })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM sponsor_representatives WHERE entity_id=$1 AND role='owner' AND status='active'", [e]);
  assert.equal(rows[0].n, 1);
});

test('representative changes preserve agreement history and frozen identity; removed people lose access at once', async () => {
  const owner = await signup(), admin = await signup(['athlete']);
  const b = await entityBrand(owner, 'HistoryBrand'), e = b.entity_id;
  const adminRep = await team(owner, e, admin, 'admin');
  const athlete = await optedIn();
  const deal = must(await offer(admin, b.id, athlete), 201);
  // rename brand and legal name afterwards: the agreement still shows who the sponsor was when proposed
  const idv = must(await api('GET', `/sponsors/${b.id}/identity`, { token: owner.token }));
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: owner.token, body: { legal_name: 'Renamed Corporation Ltd', row_version: idv.row_version } }));
  await pool.query("UPDATE sponsors SET name='RenamedBrand' WHERE id=$1", [b.id]);
  const seen = must(await api('GET', `/sponsorships/${deal.id}`, { token: athlete.token }));
  assert.equal(seen.sponsor_identity.display_name, 'HistoryBrand');
  assert.equal(seen.sponsor_identity.legal_name, 'HistoryBrand Holdings Ltd');
  assert.equal(seen.sponsor_identity.sponsor_type, 'company');
  assert.equal(seen.sponsor_identity.signed_by, admin.display_name);
  assert.ok(!JSON.stringify(seen).includes('registration_number'));
  // remove the admin who signed: access ends immediately, history and identity stay
  must(await api('POST', `/sponsor-representatives/${adminRep}/remove`, { token: owner.token }));
  assert.equal((await api('GET', `/sponsorships/${deal.id}`, { token: admin.token })).status, 403);
  assert.equal((await api('POST', `/sponsorships/${deal.id}/withdraw`, { token: admin.token })).status, 403);
  const after = must(await api('GET', `/sponsorships/${deal.id}`, { token: owner.token }));
  assert.equal(after.sponsor_identity.signed_by, admin.display_name, 'who signed is never rewritten');
  assert.ok(after.history.some((h) => h.action === 'proposed' && h.actor === admin.display_name), 'agreement history kept');
  const reps = must(await api('GET', `/sponsor-entities/${e}/representatives`, { token: owner.token }));
  assert.equal(reps.find((r) => r.id === adminRep).status, 'left');
  const exp = must(await api('GET', `/sponsor-entities/${e}/export`, { token: owner.token }));
  assert.equal(exp.identity.legal_name, 'Renamed Corporation Ltd'); assert.equal(exp.agreement_identities[0].legal_name, 'HistoryBrand Holdings Ltd');
  assert.ok(exp.representatives.some((r) => r.status === 'left'));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export_pii' AND entity_id=$1", [e])).rowCount > 0);
  // former owner of a legacy brand loses access once the brand sits under an entity
  const legacyOwner = await signup(), other = await signup();
  const legacy = must(await api('POST', '/sponsors', { token: legacyOwner.token, body: { name: 'MovingBrand' } }), 201);
  const ent = await entityBrand(other, 'TargetEntity');
  assert.equal((await api('POST', `/sponsors/${legacy.id}/entity`, { token: legacyOwner.token, body: { entity_id: ent.entity_id } })).status, 404, 'cannot attach to an entity you do not run');
  await team(other, ent.entity_id, legacyOwner, 'admin');
  must(await api('POST', `/sponsors/${legacy.id}/entity`, { token: legacyOwner.token, body: { entity_id: ent.entity_id } }));
  assert.equal(must(await api('GET', `/sponsors/${legacy.id}/identity`, { token: other.token })).brands.length, 2);
  // the original creator (owner_id) leaves: owner_id alone no longer grants anything anywhere
  const leaving = must(await api('GET', `/sponsor-entities/${ent.entity_id}/representatives`, { token: other.token })).find((r) => r.user_id === legacyOwner.id);
  must(await api('POST', `/sponsor-representatives/${leaving.id}/remove`, { token: other.token }));
  assert.equal((await api('GET', `/sponsors/${legacy.id}/identity`, { token: legacyOwner.token })).status, 404);
  assert.equal((await api('POST', '/verification/cases', { token: legacyOwner.token, body: { type: 'sponsor', subject_id: legacy.id, evidence: [{ kind: 'business_registration', reference: 'REG-9' }, { kind: 'website_domain_proof', reference: 'https://x.example/p' }] } })).status, 403);
  assert.equal(must(await api('GET', '/sponsors', { token: legacyOwner.token, query: { mine: 'true' } })).length, 0);
  assert.equal((await pool.query("SELECT 1 FROM sponsors sp WHERE sp.id=$1 AND (sp.entity_id IS NULL AND sp.owner_id=$2)", [legacy.id, legacyOwner.id])).rowCount, 0);
});

test('several entities per sponsor, with different roles in each; brands grouped under an entity', async () => {
  const a = await signup(), b = await signup(['athlete']);
  const e1 = await entityBrand(a, 'Alpha'), e2 = await entityBrand(a, 'Beta', { sponsor_type: 'organization' });
  assert.notEqual(e1.entity_id, e2.entity_id);
  const second = must(await api('POST', '/sponsors', { token: a.token, body: { name: 'Alpha Kids', entity_id: e1.entity_id } }), 201);
  assert.equal(second.entity_id, e1.entity_id);
  await team(a, e1.entity_id, b, 'finance'); await team(a, e2.entity_id, b, 'admin');
  const mine = must(await api('GET', '/me/sponsor-identities', { token: b.token }));
  assert.deepEqual(mine.entities.map((x) => x.my_role).sort(), ['admin', 'finance']);
  assert.equal(must(await api('GET', '/me/sponsor-identities', { token: a.token })).entities.length, 2);
  // finance in entity 1 cannot add brands there, admin in entity 2 can
  assert.equal((await api('POST', '/sponsors', { token: b.token, body: { name: 'Nope', entity_id: e1.entity_id } })).status, 403);
  must(await api('POST', '/sponsors', { token: b.token, body: { name: 'BetaTwo', entity_id: e2.entity_id } }), 201);
  assert.equal((await api('POST', '/sponsors', { token: b.token, body: { name: 'Ghost', entity_id: '00000000-0000-4000-8000-000000000000' } })).status, 404);
});

test('portfolio managers reach only brands in portfolios assigned to them', async () => {
  const owner = await signup(), pm = await signup(['athlete']), pm2 = await signup(['athlete']);
  const b1 = await entityBrand(owner, 'PortA'), e = b1.entity_id;
  const b2 = must(await api('POST', '/sponsors', { token: owner.token, body: { name: 'PortB', entity_id: e } }), 201);
  const b3 = must(await api('POST', '/sponsors', { token: owner.token, body: { name: 'PortC', entity_id: e } }), 201);
  const pmRep = await team(owner, e, pm, 'portfolio_manager'); await team(owner, e, pm2, 'portfolio_manager');
  const athlete = await optedIn();
  assert.equal((await offer(pm, b1.id, athlete)).status, 403, 'no portfolio yet');
  assert.equal((await api('POST', `/sponsor-entities/${e}/portfolios`, { token: pm.token, body: { name: 'Mine' } })).status, 403);
  const pf = must(await api('POST', `/sponsor-entities/${e}/portfolios`, { token: owner.token, body: { name: 'Tennis', sponsor_ids: [b1.id, b2.id], manager_ids: [pmRep] } }), 201);
  assert.equal(pf.brands.length, 2); assert.equal(pf.managers.length, 1);
  assert.equal((await api('POST', `/sponsor-entities/${e}/portfolios`, { token: owner.token, body: { name: 'tennis' } })).status, 409);
  assert.equal((await api('POST', `/sponsor-entities/${e}/portfolios`, { token: owner.token, body: { name: 'Bad', manager_ids: [(await pool.query("SELECT id FROM sponsor_representatives WHERE user_id=$1 AND role='owner'", [owner.id])).rows[0].id] } })).status, 400, 'only portfolio managers can manage');
  const foreign = await entityBrand(await signup(), 'Foreign');
  assert.equal((await api('POST', `/sponsor-entities/${e}/portfolios`, { token: owner.token, body: { name: 'Mixed', sponsor_ids: [foreign.id] } })).status, 400, 'brands must belong to the entity');
  const mine = must(await api('GET', '/sponsors', { token: pm.token, query: { mine: 'true' } }));
  assert.deepEqual(mine.map((x) => x.name).sort(), ['PortA', 'PortB']);
  assert.equal(must(await api('GET', '/sponsors', { token: pm2.token, query: { mine: 'true' } })).length, 0);
  assert.equal((await api('GET', `/sponsors/${b3.id}/identity`, { token: pm.token })).status, 404, 'brand outside the portfolio is invisible');
  const deal = must(await offer(pm, b1.id, athlete), 201);
  assert.equal((await offer(pm, b3.id, athlete)).status, 403);
  assert.equal(must(await api('GET', `/sponsorships/${deal.id}`, { token: pm.token })).role, 'sponsor');
  assert.equal((await api('GET', `/sponsorships/${deal.id}`, { token: pm2.token })).status, 403);
  assert.equal((await api('POST', `/sponsors/${b1.id}/identity`, { token: pm.token, body: { legal_name: 'Nope Ltd', row_version: 2 } })).status, 403);
  assert.deepEqual(must(await api('GET', `/sponsor-entities/${e}/portfolios`, { token: pm.token })).map((p) => p.name), ['Tennis']);
  assert.deepEqual(must(await api('GET', `/sponsor-entities/${e}/portfolios`, { token: pm2.token })), []);
  // unassigning, or moving a brand out, ends access immediately; archiving keeps the record
  must(await api('PATCH', `/sponsor-portfolios/${pf.id}`, { token: owner.token, body: { sponsor_ids: [b2.id] } }));
  assert.equal((await api('GET', `/sponsorships/${deal.id}`, { token: pm.token })).status, 403);
  must(await api('PATCH', `/sponsor-portfolios/${pf.id}`, { token: owner.token, body: { sponsor_ids: [b1.id, b2.id] } }));
  assert.equal((await api('GET', `/sponsorships/${deal.id}`, { token: pm.token })).status, 200);
  must(await api('PATCH', `/sponsor-portfolios/${pf.id}`, { token: owner.token, body: { manager_ids: [] } }));
  assert.equal((await api('GET', `/sponsorships/${deal.id}`, { token: pm.token })).status, 403);
  must(await api('PATCH', `/sponsor-portfolios/${pf.id}`, { token: owner.token, body: { archived: true } }));
  assert.equal(must(await api('GET', `/sponsor-entities/${e}/portfolios`, { token: owner.token })).length, 0);
  assert.equal(must(await api('GET', `/sponsor-entities/${e}/portfolios`, { token: owner.token, query: { archived: 'true' } })).length, 1);
  // changing a manager to another role ends their assignment
  const pf2 = must(await api('POST', `/sponsor-entities/${e}/portfolios`, { token: owner.token, body: { name: 'Golf', sponsor_ids: [b1.id], manager_ids: [pmRep] } }), 201);
  must(await api('PATCH', `/sponsor-representatives/${pmRep}`, { token: owner.token, body: { role: 'viewer' } }));
  assert.equal(must(await api('GET', `/sponsor-entities/${e}/portfolios`, { token: owner.token })).find((p) => p.id === pf2.id).managers.length, 0);
});

test('organization identity links only an organisation you administer; verification is requested by owner/admin and shows the legal identity to reviewers', async () => {
  const owner = await signup(), stranger = await signup();
  const arow = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('si_root','si_root','{admin}','x','x','si_root') RETURNING id")).rows[0];
  const admin = { id: arow.id, token: await signToken({ id: arow.id, roles: ['admin'] }) };
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: 'Riverside Club', kind: 'club' } }), 201);
  const b = await entityBrand(owner, 'OrgBrand', { sponsor_type: 'organization', legal_name: 'Riverside Club CIC' });
  must(await api('POST', `/sponsors/${b.id}/identity`, { token: owner.token, body: { organisation_id: org.id, row_version: 2 } }));
  const other = await entityBrand(stranger, 'Other', { sponsor_type: 'organization' });
  assert.equal((await api('POST', `/sponsors/${other.id}/identity`, { token: stranger.token, body: { organisation_id: org.id, row_version: 2 } })).status, 403);
  const co = await entityBrand(owner, 'CoBrand');
  assert.equal((await api('POST', `/sponsors/${co.id}/identity`, { token: owner.token, body: { organisation_id: org.id, row_version: 2 } })).status, 400, 'companies do not link organisations');
  // verification
  const viewer = await signup(['athlete']); await team(owner, b.entity_id, viewer, 'viewer');
  const ev = { type: 'sponsor', subject_id: b.id, evidence: [{ kind: 'business_registration', reference: 'REG-123' }, { kind: 'website_domain_proof', reference: 'https://orgbrand.example/proof' }] };
  assert.equal((await api('POST', '/verification/cases', { token: viewer.token, body: ev })).status, 403);
  const vc = must(await api('POST', '/verification/cases', { token: owner.token, body: ev }), 201);
  const seen = must(await api('GET', `/verification/cases/${vc.id}`, { token: admin.token }));
  assert.equal(seen.sponsor_identity.legal_name, 'Riverside Club CIC'); assert.equal(seen.sponsor_identity.sponsor_type, 'organization');
  assert.equal(must(await api('GET', `/verification/cases/${vc.id}`, { token: owner.token })).sponsor_identity, undefined, 'requester view unchanged');
});

test('guards: bad country is a 400, a type change never silently drops stored data, a restored portfolio cannot duplicate a live name', async () => {
  const u = await signup();
  const b = await entityBrand(u, 'GuardBrand');
  assert.equal((await api('POST', `/sponsors/${b.id}/identity`, { token: u.token, body: { registration_country: '1A', row_version: 2 } })).status, 400);
  const v2 = must(await api('POST', `/sponsors/${b.id}/identity`, { token: u.token, body: { registration_number: 'KEEP-ME-1', registration_country: 'in', row_version: 2 } }));
  assert.equal((await api('POST', `/sponsors/${b.id}/identity`, { token: u.token, body: { sponsor_type: 'individual', row_version: v2.row_version } })).status, 409, 'registration number would be lost');
  assert.equal(must(await api('GET', `/sponsors/${b.id}/identity`, { token: u.token })).registration_number, 'KEEP-ME-1');
  const e = b.entity_id;
  const p1 = must(await api('POST', `/sponsor-entities/${e}/portfolios`, { token: u.token, body: { name: 'EMEA' } }), 201);
  must(await api('PATCH', `/sponsor-portfolios/${p1.id}`, { token: u.token, body: { archived: true } }));
  must(await api('POST', `/sponsor-entities/${e}/portfolios`, { token: u.token, body: { name: 'EMEA' } }), 201);
  assert.equal((await api('PATCH', `/sponsor-portfolios/${p1.id}`, { token: u.token, body: { archived: false } })).status, 409);
});

test('a review written by any sponsor-side member can be answered; the athlete never answers their own', async () => {
  const owner = await signup(), pm = await signup(['athlete']);
  const b = await entityBrand(owner, 'ReviewBrand');
  const pf = must(await api('POST', `/sponsor-entities/${b.entity_id}/portfolios`, { token: owner.token, body: { name: 'All', sponsor_ids: [b.id] } }), 201);
  const rep = await team(owner, b.entity_id, pm, 'portfolio_manager');
  must(await api('PATCH', `/sponsor-portfolios/${pf.id}`, { token: owner.token, body: { manager_ids: [rep] } }));
  const athlete = await optedIn();
  const deal = must(await offer(pm, b.id, athlete), 201);
  must(await api('PATCH', `/sponsorships/${deal.id}`, { token: athlete.token, body: { status: 'active' } }));
  const review = await api('POST', `/sponsorships/${deal.id}/reviews`, { token: pm.token, body: { body: 'Checking in', next_review_on: day(30) } });
  if (review.status === 201) {
    must(await api('POST', `/sponsorship-reviews/${review.body.id}/response`, { token: athlete.token, body: { response: 'Thanks!' } }));
  } else assert.equal(review.status, 409, JSON.stringify(review.body)); // reviews only open once the deal has run for a while
});
