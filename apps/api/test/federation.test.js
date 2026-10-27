// Federation & Governing Body OS (#475): hierarchy, scoped roles, affiliation / licence / sanction lifecycles with immutable history, versioned policy,
// least-privilege (a federation never reaches a club's private data), concurrency, calendar/report reconciliation, auditable export, branded
// documents, appeals, REST/OpenAPI/MCP parity and the additive migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { runFederationSweeps } = await import('../src/federation-sweeps.js');

let server, base, n = 0, sport, sport2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)))}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed, headers: r.headers };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const day = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `fed_${n}_${roles[0]}`, display_name: `Fed ${n}`, email: `fed${n}@example.com`, password: 'correct-horse-battery', roles, phone: '+15550100' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const FILE = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('a federation test document body'), Buffer.from('\n%%EOF')]).toString('base64');

const body = async (owner, over = {}) => must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Federation ${++n}`, level: 'national', abbreviation: `F${String(n).padStart(3, '0')}`, country: 'SG', sports: [{ sport_id: sport.id }], ...over } }), 201);
const club = async (owner, name = `Club ${++n}`) => must(await api('POST', '/organisations', { token: owner.token, body: { name, kind: 'club' } }), 201);
const category = async (owner, b, over = {}) => must(await api('POST', `/federation/bodies/${b.id}/affiliation-categories`, { token: owner.token, body: { name: `Full club ${++n}`, applicant_kind: 'club', ...over } }), 201);
const policy = async (owner, b, kind, params, over = {}) => {
  const p = must(await api('POST', `/federation/bodies/${b.id}/policies`, { token: owner.token, body: { kind, title: `${kind} rules ${++n}`, ...over } }), 201);
  const v = must(await api('POST', `/federation/policies/${p.id}/versions`, { token: owner.token, body: { effective_from: over.effective_from ?? day(-30), params } }), 201);
  return { p, v };
};
const apply = async (u, b, org, cat, over = {}) => must(await api('POST', '/federation/affiliations', { token: u.token, body: { body_id: b.id, organisation_id: org.id, category_id: cat.id, season_year: new Date().getFullYear(), ...over } }), 201);
const decide = (u, kind, id, action, extra = {}) => api('POST', `/federation/${kind}/${id}/decision`, { token: u.token, body: { action, ...extra } });
const grant = async (owner, b, user, role, sport_id) => must(await api('POST', `/federation/bodies/${b.id}/roles`, { token: owner.token, body: { user_id: user.id, role, sport_id } }), 201);
const mkEvent = async (u, over = {}) => must(await api('POST', '/events', { token: u.token, body: { name: `Open ${++n}`, sport: sport.slug, kind: 'tournament', starts_on: day(40), ends_on: day(42), ...over } }), 201);
const home = async (u, b) => must(await api('GET', `/federation/bodies/${b.id}/home`, { token: u.token }));
const report = (u, b, r, query = {}) => api('GET', `/federation/bodies/${b.id}/reports/${r}`, { token: u.token, query });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  const sports = await q("SELECT id, slug FROM sports WHERE slug IN ('badminton','tennis') ORDER BY slug");
  [sport, sport2] = sports;
});
after(async () => { server.close(); await pool.end(); });

test('hierarchy: recognition needs the other side, has one parent, can never loop, and ends with history', async () => {
  const nat = await signup(), reg = await signup(), lg = await signup();
  const N = await body(nat), R = await body(reg, { level: 'regional' }), L = await body(lg, { level: 'league' });
  // the regional asks to sit under the national; only the national can say yes
  const link = must(await api('POST', '/federation/links', { token: reg.token, body: { parent_id: N.id, child_id: R.id, reason: 'We are the state body' } }), 201);
  assert.equal(link.status, 'requested');
  assert.equal((await api('POST', `/federation/links/${link.id}/respond`, { token: reg.token, body: { decision: 'recognise' } })).status, 403, 'the asking side cannot answer its own request');
  assert.equal((await api('POST', `/federation/links/${link.id}/respond`, { token: lg.token, body: { decision: 'recognise' } })).status, 404, 'an outsider learns nothing');
  assert.equal(must(await api('POST', `/federation/links/${link.id}/respond`, { token: nat.token, body: { decision: 'recognise' } })).status, 'recognised');
  assert.equal(must(await api('GET', `/federation/bodies/${R.id}`)).parent.id, N.id);
  assert.equal(must(await api('GET', `/federation/bodies/${N.id}`)).children.length, 1);
  // one parent at a time
  const second = await api('POST', '/federation/links', { token: reg.token, body: { parent_id: L.id, child_id: R.id } });
  assert.equal(second.status, 409);
  // L under R is fine (an admin of both... lg asks, reg answers)
  const l2 = must(await api('POST', '/federation/links', { token: lg.token, body: { parent_id: R.id, child_id: L.id } }), 201);
  must(await api('POST', `/federation/links/${l2.id}/respond`, { token: reg.token, body: { decision: 'recognise' } }));
  // a loop is refused: national under the league
  const loop = await api('POST', '/federation/links', { token: nat.token, body: { parent_id: L.id, child_id: N.id } });
  assert.equal(loop.status, 409); assert.match(loop.body.error?.message ?? loop.body.message ?? '', /descendant/);
  // and the database refuses it too, whoever writes
  await assert.rejects(pool.query("INSERT INTO governing_body_links(parent_id, child_id, status, requested_by, requested_side) VALUES ($1,$2,'recognised',$3,'child')", [L.id, N.id, nat.id]), /descendants/);
  // an admin of two bodies recognises at once; two opposing requests in parallel can never both stand
  const both = await signup();
  const A = await body(both, { level: 'state' }), B = await body(both, { level: 'district' });
  const [r1, r2] = await Promise.all([
    api('POST', '/federation/links', { token: both.token, body: { parent_id: A.id, child_id: B.id } }),
    api('POST', '/federation/links', { token: both.token, body: { parent_id: B.id, child_id: A.id } }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409], 'exactly one direction wins');
  // ending keeps the row and the history
  must(await api('POST', `/federation/links/${link.id}/end`, { token: nat.token, body: { reason: 'Left the federation' } }));
  const links = must(await api('GET', `/federation/bodies/${R.id}/links`, { token: reg.token }));
  assert.equal(links.find((x) => x.id === link.id).status, 'ended');
  assert.equal(must(await api('GET', `/federation/bodies/${R.id}`)).parent, null);
  const log = must(await api('GET', `/federation/bodies/${R.id}/history`, { token: reg.token, query: { subject_type: 'link' } }));
  assert.deepEqual(log.map((e) => e.action).sort(), ['ended', 'recognised', 'requested'].sort());
});

test('a body is an organisation plus governing semantics: nothing is duplicated, an existing organisation can become one, numbers are unique', async () => {
  const o = await signup();
  const org = must(await api('POST', '/organisations', { token: o.token, body: { name: 'Existing League Co', kind: 'other', registration_no: 'REG-77', website: 'https://league.example' } }), 201);
  const b = must(await api('POST', '/federation/bodies', { token: o.token, body: { organisation_id: org.id, level: 'league', abbreviation: 'XLG', country: 'IN', region: 'South', sports: [{ sport_id: sport.id, discipline: 'Singles' }] } }), 201);
  assert.equal(b.organisation_id, org.id, 'the same organisation, not a copy');
  assert.equal(b.registration_no, 'REG-77', 'legal identifiers stay on the organisation');
  assert.equal((await q('SELECT count(*)::int AS n FROM organisations WHERE id=$1', [org.id]))[0].n, 1);
  assert.equal((await api('POST', '/federation/bodies', { token: o.token, body: { organisation_id: org.id, level: 'league', abbreviation: 'XL2', sports: [{ sport_id: sport.id }] } })).status, 409, 'already a governing body');
  assert.equal((await api('POST', '/federation/bodies', { token: (await signup()).token, body: { organisation_id: org.id, level: 'league', abbreviation: 'XL3', sports: [{ sport_id: sport.id }] } })).status, 404, 'only the owner can convert it');
  const dup = await api('POST', '/federation/bodies', { token: o.token, body: { name: 'Another', level: 'league', abbreviation: 'XLG', country: 'IN', sports: [{ sport_id: sport.id }] } });
  assert.equal(dup.status, 409, 'abbreviation is unique per level and country');
  // public directory shows the profile only
  const found = must(await api('GET', '/federation/bodies', { query: { q: 'Existing League', sport_id: sport.id } }));
  assert.equal(found.length, 1);
  assert.ok(!('legal_name' in found[0]) && !('registration_no' in found[0]) && !('tax_id' in found[0]));
  // dropping a sport ends it, never deletes it
  must(await api('PATCH', `/federation/bodies/${b.id}`, { token: o.token, body: { sports: [{ sport_id: sport2.id }] } }));
  assert.equal((await q('SELECT count(*)::int AS n FROM governing_body_sports WHERE body_id=$1', [b.id]))[0].n, 2);
  assert.equal(must(await api('GET', `/federation/bodies/${b.id}`)).sports.length, 1);
  // a suspended body takes no new applications; everything stays readable
  const c = await signup(), cl = await club(c);
  const cat = await category(o, b);
  must(await api('POST', `/federation/bodies/${b.id}/status`, { token: o.token, body: { status: 'suspended', reason: 'Governance review' } }));
  const refused = await api('POST', '/federation/affiliations', { token: c.token, body: { body_id: b.id, organisation_id: cl.id, category_id: cat.id, season_year: 2026 } });
  assert.equal(refused.status, 409);
  must(await api('POST', `/federation/bodies/${b.id}/status`, { token: o.token, body: { status: 'active', reason: 'Review complete' } }));
});

test('scoped roles are least-privilege, live, and a federation never reaches a club\'s private data', async () => {
  const owner = await signup(), clubOwner = await signup();
  const F = await body(owner), org = await club(clubOwner);
  const cat = await category(owner, F);
  const registrar = await signup(), licensing = await signup(), auditor = await signup(), outsider = await signup();
  const rr = await grant(owner, F, registrar, 'registrar'), lr = await grant(owner, F, licensing, 'licensing');
  await grant(owner, F, auditor, 'auditor');
  assert.equal((await api('POST', `/federation/bodies/${F.id}/roles`, { token: registrar.token, body: { user_id: outsider.id, role: 'auditor' } })).status, 403, 'only owners/admins grant roles');
  const aff = await apply(clubOwner, F, org, cat);
  must(await api('POST', `/federation/affiliations/${aff.id}/submit`, { token: clubOwner.token }));
  // outsiders get 404, not 403, so existence is not probed
  assert.equal((await api('GET', `/federation/affiliations/${aff.id}`, { token: outsider.token })).status, 404);
  assert.equal((await api('GET', `/federation/bodies/${F.id}/home`, { token: outsider.token })).status, 404);
  // the licensing officer and the auditor cannot decide affiliations; the registrar can
  assert.equal((await decide(licensing, 'affiliations', aff.id, 'start_review')).status, 403);
  assert.equal((await decide(auditor, 'affiliations', aff.id, 'start_review')).status, 403);
  assert.equal(must(await decide(registrar, 'affiliations', aff.id, 'start_review')).status, 'under_review');
  // a federation owner/registrar cannot read the club's members, finance or teams through any organisation API
  for (const u of [owner, registrar]) {
    assert.equal((await api('GET', `/organisations/${org.id}/members`, { token: u.token })).status, 404);
    assert.equal((await api('GET', `/organisations/${org.id}`, { token: u.token })).body.legal_name, undefined, 'private organisation fields stay private');
  }
  // revocation is immediate
  must(await api('DELETE', `/federation/bodies/${F.id}/roles/${rr.id}`, { token: owner.token }));
  assert.equal((await decide(registrar, 'affiliations', aff.id, 'request_info', { reason: 'x' })).status, 404, 'no longer any role on this body');
  // a role limited to one sport cannot decide in another
  const scoped = await signup();
  await grant(owner, F, scoped, 'licensing', sport.id);
  const odd = await api('POST', `/federation/bodies/${F.id}/roles`, { token: owner.token, body: { user_id: scoped.id, role: 'registrar', sport_id: sport2.id } });
  assert.equal(odd.status, 400, 'a sport the body does not govern');
  // the role list shows who runs the body, to its staff only
  const roles = must(await api('GET', `/federation/bodies/${F.id}/roles`, { token: auditor.token }));
  assert.ok(roles.owners.some((x) => x.id === owner.id) && roles.roles.some((x) => x.role === 'licensing'));
  assert.equal((await api('GET', `/federation/bodies/${F.id}/roles`, { token: outsider.token })).status, 404);
  assert.ok(lr.id);
});

test('affiliation lifecycle: apply, requirements, fee, approve, suspend, reinstate, expire, renew, full immutable history; nothing about the club changes', async () => {
  const owner = await signup(), clubOwner = await signup();
  const F = await body(owner), org = await club(clubOwner);
  const team = must(await api('POST', '/teams', { token: clubOwner.token, body: { name: `Aff Team ${++n}`, sport: 'badminton', organisation_id: org.id } }), 201);
  const cat = await category(owner, F, { fee_minor: 5000, currency: 'SGD' });
  await policy(owner, F, 'affiliation', { required_documents: ['Constitution'], min_teams: 1 });
  const before = { members: await q('SELECT user_id, role, status FROM organisation_members WHERE organisation_id=$1 ORDER BY user_id', [org.id]), teams: await q('SELECT id, organisation_id, owner_id FROM teams WHERE organisation_id=$1 ORDER BY id', [org.id]), owner: await q('SELECT name, kind, status, created_by FROM organisations WHERE id=$1', [org.id]) };
  const aff = await apply(clubOwner, F, org, cat);
  assert.equal(aff.status, 'draft');
  assert.equal((await api('POST', '/federation/affiliations', { token: clubOwner.token, body: { body_id: F.id, organisation_id: org.id, category_id: cat.id, season_year: new Date().getFullYear() } })).status, 409, 'one open application per season')
  // requirements: submit needs the document
  const noDoc = await api('POST', `/federation/affiliations/${aff.id}/submit`, { token: clubOwner.token });
  assert.equal(noDoc.status, 409); assert.equal(code(noDoc), 'documents_missing');
  assert.equal((await api('POST', `/federation/affiliations/${aff.id}/evidence`, { token: (await signup()).token, body: { requirement: 'Constitution', reference: 'https://club.example/constitution.pdf' } })).status, 404);
  must(await api('POST', `/federation/affiliations/${aff.id}/evidence`, { token: clubOwner.token, body: { requirement: 'Constitution', file_name: 'constitution.pdf', data: FILE } }), 201);
  const raw = await q('SELECT reference_enc, file_enc FROM fed_evidence WHERE subject_id=$1', [aff.id]);
  assert.ok(!String(raw[0].file_enc).includes(FILE.slice(0, 20)), 'evidence is stored encrypted');
  const sub = must(await api('POST', `/federation/affiliations/${aff.id}/submit`, { token: clubOwner.token }));
  assert.equal(sub.status, 'submitted'); assert.equal(sub.fee_status, 'due');
  // evidence is frozen once submitted
  assert.equal((await api('POST', `/federation/affiliations/${aff.id}/evidence`, { token: clubOwner.token, body: { requirement: 'Extra', reference: 'https://x.example/y' } })).status, 409);
  const registrar = await signup(); await grant(owner, F, registrar, 'registrar');
  // detail lists metadata only; reading evidence is audited
  const d = must(await api('GET', `/federation/affiliations/${aff.id}`, { token: registrar.token }));
  assert.equal(d.evidence.length, 1); assert.ok(!('file_enc' in d.evidence[0]) && !('reference_enc' in d.evidence[0]));
  assert.ok(d.preview.some((c) => c.key === 'fee' && c.status === 'fail') && d.preview.some((c) => c.key === 'teams' && c.status === 'pass'));
  const read = must(await api('GET', `/federation/affiliations/${aff.id}/evidence/${d.evidence[0].id}`, { token: registrar.token }));
  assert.equal(read.file.data, FILE);
  assert.equal((await q("SELECT count(*)::int AS n FROM audit_log WHERE actor_id=$1 AND action='read_pii' AND entity='fed_evidence'", [registrar.id]))[0].n, 1);
  // approval is blocked until the fee is settled; override needs a reason and shows up as an exception
  const blocked = await decide(registrar, 'affiliations', aff.id, 'approve');
  assert.equal(blocked.status, 409); assert.equal(code(blocked), 'requirements_not_met');
  must(await api('POST', `/federation/affiliations/${aff.id}/fee`, { token: registrar.token, body: { status: 'paid', reference: 'BANK-123' } }));
  assert.equal((await api('POST', `/federation/affiliations/${aff.id}/fee`, { token: registrar.token, body: { status: 'paid' } })).status, 409, 'recorded once');
  const ok = must(await decide(registrar, 'affiliations', aff.id, 'approve', { version: (await api('GET', `/federation/affiliations/${aff.id}`, { token: registrar.token })).body.row_version }));
  assert.equal(ok.status, 'approved');
  assert.match(ok.affiliation_no, new RegExp(`^${F.abbreviation}-AFF-${new Date().getFullYear()}-0001$`));
  assert.ok(ok.effective_from && ok.effective_to && ok.effective_to > ok.effective_from);
  assert.ok((await q('SELECT policy_version_id FROM fed_affiliations WHERE id=$1', [aff.id]))[0].policy_version_id, 'the decision keeps the policy version it was made under');
  // the club is untouched
  assert.deepEqual({ members: await q('SELECT user_id, role, status FROM organisation_members WHERE organisation_id=$1 ORDER BY user_id', [org.id]), teams: await q('SELECT id, organisation_id, owner_id FROM teams WHERE organisation_id=$1 ORDER BY id', [org.id]), owner: await q('SELECT name, kind, status, created_by FROM organisations WHERE id=$1', [org.id]) }, before, 'affiliation never alters ownership, members or teams');
  assert.ok(team.id);
  // public register
  const reg = must(await api('GET', `/federation/bodies/${F.id}/affiliated`));
  assert.equal(reg.length, 1); assert.equal(reg[0].affiliation_no, ok.affiliation_no);
  // suspend then reinstate; a second concurrent decision on the same record loses
  assert.equal((await decide(registrar, 'affiliations', aff.id, 'suspend')).status, 400, 'a reason is required');
  assert.equal(must(await decide(registrar, 'affiliations', aff.id, 'suspend', { reason: 'Unpaid league levy' })).status, 'suspended');
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/affiliated`)).length, 0, 'a suspended club leaves the register');
  const [x, y] = await Promise.all([decide(registrar, 'affiliations', aff.id, 'reinstate'), decide(registrar, 'affiliations', aff.id, 'reinstate')]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409], 'only one of two parallel decisions applies');
  // stale version guard
  assert.equal((await decide(registrar, 'affiliations', aff.id, 'suspend', { reason: 'again', version: 1 })).status, 409);
  // expiry is read live, then persisted by the sweep with history
  await q('UPDATE fed_affiliations SET effective_from=current_date-400, effective_to=current_date-1 WHERE id=$1', [aff.id]);
  assert.equal(must(await api('GET', `/federation/affiliations/${aff.id}`, { token: clubOwner.token })).status, 'expired');
  assert.equal((await q('SELECT status FROM fed_affiliations WHERE id=$1', [aff.id]))[0].status, 'approved', 'not yet persisted');
  await runFederationSweeps();
  assert.equal((await q('SELECT status FROM fed_affiliations WHERE id=$1', [aff.id]))[0].status, 'expired');
  // renewal: a new row pointing at the old one, documents carried over, the old one untouched
  const ren = must(await api('POST', `/federation/affiliations/${aff.id}/renew`, { token: clubOwner.token, body: {} }), 201);
  assert.equal(ren.previous_id, aff.id); assert.equal(ren.status, 'draft'); assert.equal(ren.season_year, new Date().getFullYear() + 1);
  assert.equal((await q("SELECT count(*)::int AS n FROM fed_evidence WHERE subject_id=$1 AND removed_at IS NULL", [ren.id]))[0].n, 1);
  assert.equal((await api('POST', `/federation/affiliations/${aff.id}/renew`, { token: clubOwner.token, body: {} })).status, 409, 'already renewed');
  must(await api('POST', `/federation/affiliations/${ren.id}/submit`, { token: clubOwner.token }));
  must(await api('POST', `/federation/affiliations/${ren.id}/fee`, { token: registrar.token, body: { status: 'waived', reason: 'Returning member' } }));
  const ren2 = must(await decide(registrar, 'affiliations', ren.id, 'approve'));
  assert.match(ren2.affiliation_no, /-0002$/, 'numbers are sequential per body');
  const list = must(await api('GET', '/federation/affiliations', { token: clubOwner.token, query: { organisation_id: org.id } }));
  assert.equal(list.total, 2);
  // history is complete and cannot be rewritten
  const hist = must(await api('GET', `/federation/affiliations/${aff.id}`, { token: registrar.token })).history.map((h) => h.action);
  for (const a of ['created', 'submitted', 'fee_paid', 'approve', 'suspend', 'reinstate', 'expired', 'renewal_started']) assert.ok(hist.includes(a), `${a} is in the history: ${hist}`);
  await assert.rejects(pool.query("UPDATE fed_events SET reason='x' WHERE subject_id=$1", [aff.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM fed_events WHERE subject_id=$1', [aff.id]), /append-only/);
  // a withdrawn application keeps its row
  const o2 = await club(clubOwner);
  const a2 = await apply(clubOwner, F, o2, await category(owner, F, { name: `Associate ${++n}` }));
  assert.equal(must(await api('POST', `/federation/affiliations/${a2.id}/withdraw`, { token: clubOwner.token, body: {} })).status, 'withdrawn');
});

test('governing requirements are versioned by date: decisions keep the version used, hierarchy supplies defaults', async () => {
  const owner = await signup(), childOwner = await signup(), clubOwner = await signup();
  const N = await body(owner), R = await body(childOwner, { level: 'regional' });
  const l = must(await api('POST', '/federation/links', { token: childOwner.token, body: { parent_id: N.id, child_id: R.id } }), 201);
  must(await api('POST', `/federation/links/${l.id}/respond`, { token: owner.token, body: { decision: 'recognise' } }));
  const { p, v: v1 } = await policy(owner, N, 'affiliation', { required_documents: ['Constitution'] }, { effective_from: day(-60) });
  // the regional has no policy of its own: the national's applies
  const inherited = must(await api('GET', `/federation/bodies/${R.id}/policy-at`, { query: { kind: 'affiliation' } }));
  assert.equal(inherited.version, 1); assert.equal(inherited.inherited, true);
  assert.deepEqual(inherited.params.required_documents, ['Constitution']);
  // a decision under v1
  const cat = await category(childOwner, R), org = await club(clubOwner);
  const aff = await apply(clubOwner, R, org, cat);
  must(await api('POST', `/federation/affiliations/${aff.id}/evidence`, { token: clubOwner.token, body: { requirement: 'Constitution', reference: 'https://club.example/c.pdf' } }), 201);
  must(await api('POST', `/federation/affiliations/${aff.id}/submit`, { token: clubOwner.token }));
  const approved = must(await decide(childOwner, 'affiliations', aff.id, 'approve'));
  const used = (await q('SELECT policy_version_id FROM fed_affiliations WHERE id=$1', [aff.id]))[0].policy_version_id;
  assert.equal(used, v1.id);
  // v2 takes effect later (not before v1), is immutable once published, and v1 can never be edited
  assert.equal((await api('POST', `/federation/policies/${p.id}/versions`, { token: owner.token, body: { effective_from: day(-60), params: {} } })).status, 409, 'must be after the previous version');
  assert.equal((await api('POST', `/federation/policies/${p.id}/versions`, { token: owner.token, body: { effective_from: day(5), params: { bogus: 1 } } })).status, 400, 'params are validated for the kind');
  const v2 = must(await api('POST', `/federation/policies/${p.id}/versions`, { token: owner.token, body: { effective_from: day(5), params: { required_documents: ['Constitution', 'Insurance certificate'] }, summary: 'Adds insurance' } }), 201);
  assert.equal(v2.version, 2);
  assert.equal(must(await api('GET', `/federation/bodies/${N.id}/policy-at`, { query: { kind: 'affiliation', on: day(0) } })).version, 1);
  assert.equal(must(await api('GET', `/federation/bodies/${N.id}/policy-at`, { query: { kind: 'affiliation', on: day(6) } })).version, 2);
  await assert.rejects(pool.query("UPDATE fed_policy_versions SET params='{}' WHERE id=$1", [v1.id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM fed_policy_versions WHERE id=$1', [v1.id]), /immutable/);
  assert.equal((await q('SELECT policy_version_id FROM fed_affiliations WHERE id=$1', [aff.id]))[0].policy_version_id, v1.id, 'the earlier decision still points at the version it used');
  const view = must(await api('GET', `/federation/policies/${p.id}`));
  assert.deepEqual(view.versions.map((x) => [x.version, x.in_force]), [[2, false], [1, true]]);
  // a regional policy overrides the inherited one for its own decisions
  await policy(childOwner, R, 'affiliation', { required_documents: [] }, { effective_from: day(-1) });
  assert.equal(must(await api('GET', `/federation/bodies/${R.id}/policy-at`, { query: { kind: 'affiliation' } })).inherited, false);
  // more specific scope wins: a sport-specific policy beats the general one
  await policy(owner, N, 'sanction', { min_officials: 1 }, { effective_from: day(-1) });
  await policy(owner, N, 'sanction', { min_officials: 4 }, { effective_from: day(-1), sport_id: sport.id, title: 'Sport specific' });
  assert.equal(must(await api('GET', `/federation/bodies/${N.id}/policy-at`, { query: { kind: 'sanction', sport_id: sport.id } })).params.min_officials, 4);
  assert.equal(must(await api('GET', `/federation/bodies/${N.id}/policy-at`, { query: { kind: 'sanction', sport_id: sport2.id } })).params.min_officials, 1);
  assert.ok(approved.affiliation_no);
});

test('licences: canonical identity, club membership, verification, windows, standing, suspension, expiry, renewal, public check', async () => {
  const owner = await signup(), clubOwner = await signup(), athlete = await signup(['athlete']), coach = await signup(['coach']), stranger = await signup(['athlete']);
  const F = await body(owner), org = await club(clubOwner);
  const licensing = await signup(); await grant(owner, F, licensing, 'licensing');
  const registrar = await signup(); await grant(owner, F, registrar, 'registrar');
  const cat = await category(owner, F);
  const aff = await apply(clubOwner, F, org, cat);
  must(await api('POST', `/federation/affiliations/${aff.id}/submit`, { token: clubOwner.token }));
  must(await decide(registrar, 'affiliations', aff.id, 'approve'));
  // the athlete plays for the club
  const team = must(await api('POST', '/teams', { token: clubOwner.token, body: { name: `Lic Team ${++n}`, sport: 'badminton', organisation_id: org.id } }), 201);
  await q("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, athlete.id]);
  const t = must(await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { name: 'Senior player', holder_role: 'athlete', sport_id: sport.id, grade: 'Senior', fee_minor: 2000, currency: 'SGD', requires_affiliation: true } }), 201);
  assert.equal((await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { name: 'Senior player', holder_role: 'athlete', sport_id: sport.id } })).status, 409);
  assert.equal((await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: registrar.token, body: { name: 'Nope', holder_role: 'athlete', sport_id: sport.id } })).status, 403);
  const apply1 = (u, over = {}) => api('POST', '/federation/licences', { token: u.token, body: { body_id: F.id, type_id: t.id, affiliation_id: aff.id, ...over } });
  assert.equal((await apply1(stranger)).status, 400, 'not a member of the affiliated club');
  assert.equal((await api('POST', '/federation/licences', { token: athlete.token, body: { body_id: F.id, type_id: t.id } })).status, 400, 'this licence is held through a club');
  assert.equal((await apply1(athlete, { holder_id: stranger.id })).status, 403, 'nobody applies for another adult');
  const lic = must(await apply1(athlete), 201);
  assert.equal(lic.holder_id, athlete.id); assert.equal(lic.standing, 'pending');
  assert.equal((await apply1(athlete)).status, 409, 'one live licence of a type per person');
  must(await api('POST', `/federation/licences/${lic.id}/submit`, { token: athlete.token }));
  assert.equal(must(await api('GET', `/federation/licences/${lic.id}`, { token: athlete.token })).fee_status, 'due');
  assert.equal(code(await decide(licensing, 'licences', lic.id, 'approve')), 'requirements_not_met', 'fee first');
  must(await api('POST', `/federation/licences/${lic.id}/fee`, { token: licensing.token, body: { status: 'paid', paid_on: day(0) } }));
  const live = must(await decide(licensing, 'licences', lic.id, 'approve'));
  assert.equal(live.status, 'active'); assert.equal(live.standing, 'good_standing');
  assert.match(live.licence_no, /-LIC-\d{4}-0001$/); assert.match(live.public_code, /^[A-F0-9]{12}$/);
  assert.equal(live.grade, 'Senior');
  // grade is copied: changing the type later never rewrites a licence already held
  await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { type_id: t.id, name: 'Senior player', holder_role: 'athlete', sport_id: sport.id, grade: 'Elite', requires_affiliation: true } });
  assert.equal(must(await api('GET', `/federation/licences/${lic.id}`, { token: athlete.token })).grade, 'Senior');
  // anyone can check it; the registered code is the only way in
  const check = must(await api('GET', `/federation/verify/${live.public_code}`));
  assert.equal(check.valid, true); assert.equal(check.holder_name, athlete.display_name);
  assert.equal((await api('GET', '/federation/verify/ABCDEF123456')).status, 404);
  // the club's affiliation lapsing does not silently change the licence, but staff see it on the board
  // suspension until a date, then lifted by the sweep
  assert.equal(must(await decide(licensing, 'licences', lic.id, 'suspend', { reason: 'Disciplinary panel', suspended_until: day(30) })).standing, 'suspended');
  assert.equal(must(await api('GET', `/federation/verify/${live.public_code}`)).valid, false);
  await q('UPDATE fed_licences SET suspended_until=current_date-1 WHERE id=$1', [lic.id]);
  assert.equal(must(await api('GET', `/federation/licences/${lic.id}`, { token: athlete.token })).standing, 'good_standing', 'a timed suspension ends on its date');
  await runFederationSweeps();
  assert.equal((await q('SELECT status FROM fed_licences WHERE id=$1', [lic.id]))[0].status, 'active');
  // renewal only opens inside the notice period
  assert.equal((await api('POST', `/federation/licences/${lic.id}/renew`, { token: athlete.token, body: {} })).status, 409);
  await q("UPDATE fed_licences SET expires_on=current_date+10 WHERE id=$1", [lic.id]);
  const renewal = must(await api('POST', `/federation/licences/${lic.id}/renew`, { token: athlete.token, body: {} }), 201);
  assert.equal(renewal.previous_id, lic.id);
  assert.equal(must(await api('GET', `/federation/licences/${lic.id}`, { token: athlete.token })).standing, 'good_standing', 'the old licence is untouched until it runs out');
  // expiry
  await q("UPDATE fed_licences SET issued_on=current_date-400, expires_on=current_date-1 WHERE id=$1", [lic.id]);
  assert.equal(must(await api('GET', `/federation/licences/${lic.id}`, { token: athlete.token })).standing, 'expired');
  assert.equal(must(await api('GET', `/federation/verify/${live.public_code}`)).valid, false);
  // the holder's own list, with the body's filters
  assert.ok(must(await api('GET', '/federation/licences', { token: athlete.token, query: { mine: 'true' } })).total >= 2);
  assert.equal((await api('GET', '/federation/licences', { token: stranger.token, query: { body_id: F.id } })).status, 404, 'outsiders cannot list a body\'s licences');
  assert.equal((await api('GET', `/federation/licences/${lic.id}`, { token: stranger.token })).status, 404);
  // a coach licence needs a platform-verified coach
  const ct = must(await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { name: 'Level 1 coach', holder_role: 'coach', sport_id: sport.id, requires_verification: 'coach' } }), 201);
  const cl = must(await api('POST', '/federation/licences', { token: coach.token, body: { body_id: F.id, type_id: ct.id } }), 201);
  must(await api('POST', `/federation/licences/${cl.id}/submit`, { token: coach.token }));
  const noVer = await decide(licensing, 'licences', cl.id, 'approve');
  assert.equal(noVer.status, 409); assert.ok(noVer.body.error?.details?.checks?.some((c) => c.key === 'verification' && c.status === 'fail') || JSON.stringify(noVer.body).includes('verification'));
  await q("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ('coach','user',$1,$1,'approved',1,now(), now() + interval '1 year')", [coach.id]);
  assert.equal(must(await decide(licensing, 'licences', cl.id, 'approve')).status, 'active');
  // an override is recorded as a compliance exception
  const ath2 = await signup(['coach']);
  const l3 = must(await api('POST', '/federation/licences', { token: ath2.token, body: { body_id: F.id, type_id: ct.id } }), 201);
  must(await api('POST', `/federation/licences/${l3.id}/submit`, { token: ath2.token }));
  assert.equal((await decide(licensing, 'licences', l3.id, 'approve', { override_reason: 'x' })).status, 400, 'a real reason is required');
  const forced = must(await decide(licensing, 'licences', l3.id, 'approve', { override_reason: 'Verified in person at the clinic' }));
  assert.equal(forced.override_reason, 'Verified in person at the clinic');
  const hm = await home(owner, F);
  assert.ok(hm.exceptions.some((e) => e.type === 'licence' && e.kind === 'override'));
});

test('a registration window gates licence types that require one, and young people need a verified guardian with current consent', async () => {
  const owner = await signup(), licensing = await signup(), secretary = await signup(), adult = await signup(['athlete']), kid = await signup(['athlete']), guardian = await signup(), other = await signup();
  const F = await body(owner);
  await grant(owner, F, licensing, 'licensing'); await grant(owner, F, secretary, 'secretary');
  const t = must(await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { name: 'Junior', holder_role: 'athlete', sport_id: sport.id, window_required: true } }), 201);
  const l = must(await api('POST', '/federation/licences', { token: adult.token, body: { body_id: F.id, type_id: t.id } }), 201);
  must(await api('POST', `/federation/licences/${l.id}/submit`, { token: adult.token }));
  assert.equal((await decide(licensing, 'licences', l.id, 'approve')).status, 409, 'registration is closed');
  const w = must(await api('POST', `/federation/bodies/${F.id}/dates`, { token: secretary.token, body: { kind: 'registration_window', title: 'Season registration', starts_on: day(-1), ends_on: day(20), sport_id: sport.id } }), 201);
  assert.equal(must(await decide(licensing, 'licences', l.id, 'approve')).status, 'active');
  assert.equal((await api('POST', `/federation/dates/${w.id}/cancel`, { token: licensing.token, body: { reason: 'nope' } })).status, 403);
  // young person
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  const kt = must(await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { name: 'Youth', holder_role: 'athlete', sport_id: sport.id } }), 201);
  assert.equal((await api('POST', '/federation/licences', { token: kid.token, body: { body_id: F.id, type_id: kt.id } })).status, 403, 'a young person does not apply alone');
  assert.equal((await api('POST', '/federation/licences', { token: other.token, body: { body_id: F.id, type_id: kt.id, holder_id: kid.id } })).status, 403, 'not their guardian');
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, kid.id]);
  const noConsent = await api('POST', '/federation/licences', { token: guardian.token, body: { body_id: F.id, type_id: kt.id, holder_id: kid.id } });
  assert.equal(noConsent.status, 409); assert.equal(code(noConsent), 'guardian_consent_required');
  await q("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '30 days')", [kid.id, guardian.id]);
  const yl = must(await api('POST', '/federation/licences', { token: guardian.token, body: { body_id: F.id, type_id: kt.id, holder_id: kid.id } }), 201);
  must(await api('POST', `/federation/licences/${yl.id}/submit`, { token: guardian.token }));
  const live = must(await decide(licensing, 'licences', yl.id, 'approve'));
  assert.equal(must(await api('GET', `/federation/verify/${live.public_code}`)).holder_name, 'Registered athlete (name withheld)', 'a young person\'s name is never public');
  assert.ok(must(await api('GET', '/federation/licences', { token: guardian.token, query: { mine: 'true' } })).items.some((x) => x.id === yl.id), 'the guardian sees the child\'s licence');
  // revoking the guardian ends their access immediately
  await q("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE guardian_id=$1", [guardian.id]);
  assert.equal((await api('GET', `/federation/licences/${yl.id}`, { token: guardian.token })).status, 404);
});

test('sanctioning references the canonical event: conditions are read live, decisions are immutable, drift is flagged, no second event', async () => {
  const fed = await signup(), organiser = await signup(['organizer']), referee = await signup(['referee']), outsider = await signup(['organizer']), sanctioner = await signup(), secretary = await signup(), licensing = await signup();
  const F = await body(fed);
  await grant(fed, F, sanctioner, 'sanctioner'); await grant(fed, F, secretary, 'secretary'); await grant(fed, F, licensing, 'licensing');
  const ev = await mkEvent(organiser);
  const events0 = (await q('SELECT count(*)::int AS n FROM events'))[0].n;
  await policy(fed, F, 'sanction', { require_venue: true, require_ruleset: true, min_officials: 1, require_licensed_officials: true, min_official_grade_rank: 2, require_insurance: true, lead_time_days: 7 }, { sport_id: sport.id });
  // readiness is public to the organiser only and reads the event live
  const ready = must(await api('GET', '/federation/sanction-readiness', { token: organiser.token, query: { body_id: F.id, event_id: ev.id } }));
  assert.equal(ready.ready, false);
  for (const k of ['venue', 'ruleset', 'officials', 'licensed_officials', 'insurance']) assert.ok(ready.checks.some((c) => c.key === k && c.status === 'fail'), k);
  assert.equal((await api('GET', '/federation/sanction-readiness', { token: outsider.token, query: { body_id: F.id, event_id: ev.id } })).status, 404);
  assert.equal((await api('POST', '/federation/sanctions', { token: outsider.token, body: { body_id: F.id, event_id: ev.id } })).status, 403);
  assert.equal((await api('POST', '/federation/sanctions', { token: organiser.token, body: { body_id: (await body(await signup(), { sports: [{ sport_id: sport2.id }] })).id, event_id: ev.id } })).status, 400, 'a body must govern the event\'s sport');
  const s = must(await api('POST', '/federation/sanctions', { token: organiser.token, body: { body_id: F.id, event_id: ev.id, categories: ['U17 Boys', 'Open'] } }), 201);
  assert.equal(s.status, 'requested'); assert.equal(s.event_id, ev.id);
  assert.equal((await q('SELECT count(*)::int AS n FROM events'))[0].n, events0, 'sanctioning never creates a second event');
  assert.equal((await api('POST', '/federation/sanctions', { token: organiser.token, body: { body_id: F.id, event_id: ev.id } })).status, 409, 'one live request per body and event');
  // blocked while conditions fail
  const blocked = await decide(sanctioner, 'sanctions', s.id, 'approve');
  assert.equal(blocked.status, 409); assert.equal(code(blocked), 'requirements_not_met');
  // fix the event: venue, a governed rule version, a licensed official, insurance
  const venue = (await q("INSERT INTO venues(owner_id, name, city, address) VALUES ($1,'Test Hall','Singapore','1 Main St') RETURNING id", [organiser.id]))[0];
  await q('UPDATE events SET venue_id=$2 WHERE id=$1', [ev.id, venue.id]);
  const rv = (await q("INSERT INTO ruleset_versions(sport_id, format_key, version, label, ruleset, ruleset_hash) VALUES ($1,'best_of_3',1,'Best of 3','{}','h1') RETURNING id", [sport.id]))[0];
  must(await api('PATCH', `/federation/sanctions/${s.id}`, { token: organiser.token, body: { ruleset_version_id: rv.id, note: 'Rules attached' } }));
  const role = (await q("INSERT INTO event_staff_roles(event_id, role, created_by) VALUES ($1,'referee',$2) RETURNING id", [ev.id, organiser.id]))[0];
  await q("INSERT INTO event_staff_assignments(role_id, event_id, user_id, status, invited_by) VALUES ($1,$2,$3,'accepted',$4)", [role.id, ev.id, referee.id, organiser.id]);
  const afterFix = await decide(sanctioner, 'sanctions', s.id, 'approve');
  assert.equal(afterFix.status, 409);
  const failing = afterFix.body.error?.details?.checks ?? afterFix.body.details?.checks ?? [];
  assert.ok(failing.some((c) => c.key === 'licensed_officials' && c.status === 'fail'), 'the referee has no federation licence yet');
  // the referee gets licensed at rank 2
  const ot = must(await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { name: 'Umpire L2', holder_role: 'official', sport_id: sport.id, grade: 'Level 2', grade_rank: 2 } }), 201);
  const ol = must(await api('POST', '/federation/licences', { token: referee.token, body: { body_id: F.id, type_id: ot.id } }), 201);
  must(await api('POST', `/federation/licences/${ol.id}/submit`, { token: referee.token }));
  must(await decide(licensing, 'licences', ol.id, 'approve'));
  // insurance still missing: approve with an override
  const exception = must(await decide(sanctioner, 'sanctions', s.id, 'approve', { override_reason: 'Insurance certificate arrives Friday', conditions: ['Insurance certificate by Friday'] }));
  assert.equal(exception.status, 'approved'); assert.match(exception.sanction_no, /-SAN-\d{4}-0001$/);
  assert.deepEqual(exception.conditions, ['Insurance certificate by Friday']); assert.deepEqual(exception.approved_categories, ['U17 Boys', 'Open']);
  assert.ok((await q('SELECT policy_version_id FROM fed_sanctions WHERE id=$1', [s.id]))[0].policy_version_id);
  // public: the event shows who sanctions it
  const pub = must(await api('GET', `/events/${ev.id}/sanctions`));
  assert.equal(pub[0].sanction_no, exception.sanction_no); assert.equal(pub[0].drift, false);
  // exceptions show on Federation Home; moving the event outside the sanctioned dates is flagged too
  await q('UPDATE events SET starts_on=current_date+60, ends_on=current_date+62 WHERE id=$1', [ev.id]);
  const h = await home(fed, F);
  assert.equal(h.counts.sanctions.moved, 1);
  assert.ok(h.exceptions.some((e) => e.kind === 'override') && h.exceptions.some((e) => e.kind === 'event_moved'));
  assert.equal(must(await api('GET', `/events/${ev.id}/sanctions`))[0].drift, true);
  assert.equal(must(await api('GET', '/federation/sanctions', { token: fed.token, query: { body_id: F.id, drift: 'true' } })).total, 1);
  // suspend, revoke; each is final history
  assert.equal(must(await decide(sanctioner, 'sanctions', s.id, 'suspend', { reason: 'Venue safety audit' })).status, 'suspended');
  assert.equal(must(await decide(sanctioner, 'sanctions', s.id, 'reinstate')).status, 'approved');
  assert.equal(must(await decide(sanctioner, 'sanctions', s.id, 'revoke', { reason: 'Event not run to the rules' })).status, 'revoked');
  assert.equal((await decide(sanctioner, 'sanctions', s.id, 'approve')).status, 409, 'a revoked sanction is final');
  const hist = must(await api('GET', `/federation/sanctions/${s.id}`, { token: organiser.token })).history.map((x) => x.action);
  assert.deepEqual(hist.filter((a) => ['requested', 'amended', 'approve', 'suspend', 'reinstate', 'revoke'].includes(a)), ['requested', 'amended', 'approve', 'suspend', 'reinstate', 'revoke']);
  // jurisdiction lists the event from the canonical table
  await q('UPDATE events SET organisation_id=NULL WHERE id=$1', [ev.id]);
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/events`, { token: fed.token })).total, 0, 'a revoked sanction no longer puts the event under jurisdiction');
});

test('calendar and reports reconcile with the canonical records; exports are logged, hashed and capped by role', async () => {
  const fed = await signup(), clubOwner = await signup(), registrar = await signup(), auditor = await signup(), secretary = await signup(), outsider = await signup();
  const F = await body(fed);
  await grant(fed, F, registrar, 'registrar'); await grant(fed, F, auditor, 'auditor'); await grant(fed, F, secretary, 'secretary');
  const cat = await category(fed, F);
  const orgs = [];
  for (let k = 0; k < 3; k++) {
    const org = await club(clubOwner, `=Report Club ${k}`);          // a leading '=' must not become a spreadsheet formula
    const a = await apply(clubOwner, F, org, cat);
    must(await api('POST', `/federation/affiliations/${a.id}/submit`, { token: clubOwner.token }));
    must(await decide(registrar, 'affiliations', a.id, 'approve'));
    orgs.push(a);
  }
  must(await decide(registrar, 'affiliations', orgs[2].id, 'suspend', { reason: 'Audit' }));
  await q("UPDATE fed_affiliations SET effective_to=current_date+10 WHERE id=$1", [orgs[0].id]);
  const h = await home(fed, F);
  const r = must(await report(auditor, F, 'affiliations'));
  assert.equal(r.totals.in_force, h.counts.affiliations.approved, 'the report and Federation Home count the same records');
  assert.equal(r.totals.suspended ?? 0, h.counts.affiliations.suspended);
  assert.equal(r.total, h.counts.affiliations.approved + h.counts.affiliations.suspended);
  assert.ok(r.rows.every((x) => x.affiliation_id && x.organisation_id && x.effective_from && x.effective_to), 'every row links to its source and carries effective dates');
  assert.equal(h.counts.affiliations.expiring_30, 1);
  // as-of: before the affiliations began there was nothing in force
  assert.equal(must(await report(auditor, F, 'affiliations', { as_of: day(-30) })).total, 0);
  const jur = must(await report(auditor, F, 'jurisdiction'));
  assert.equal(jur.totals.affiliations_in_force, h.counts.affiliations.approved);
  // calendar: the expiry day shows a count, never people; windows and competitions come from their sources
  must(await api('POST', `/federation/bodies/${F.id}/dates`, { token: secretary.token, body: { kind: 'congress', title: 'Annual congress', starts_on: day(5), ends_on: day(6) } }), 201);
  const cal = must(await api('GET', `/federation/bodies/${F.id}/calendar`, { token: auditor.token, query: { from: day(0), to: day(30) } }));
  assert.ok(cal.items.some((i) => i.kind === 'congress' && i.title === 'Annual congress'));
  const exp = cal.items.find((i) => i.kind === 'affiliation_renewal');
  assert.equal(exp.count, 1); assert.equal(exp.source.expires_on, day(10));
  assert.equal((await api('GET', `/federation/bodies/${F.id}/calendar`, { token: outsider.token, query: { from: day(0), to: day(30) } })).status, 404);
  assert.equal((await api('GET', `/federation/bodies/${F.id}/calendar`, { token: fed.token, query: { from: day(0), to: day(900) } })).status, 400);
  // export: spreadsheet-safe, logged with a hash of the exact bytes, allowed for reporting roles only
  const csv = must(await report(auditor, F, 'affiliations', { format: 'csv' }));
  assert.match(csv.csv, /'=Report Club/, 'formulas are neutralised');
  assert.equal(csv.rows, r.total);
  const logged = await q('SELECT * FROM fed_exports WHERE body_id=$1', [F.id]);
  assert.equal(logged.length, 1); assert.equal(logged[0].row_count, csv.rows); assert.equal(logged[0].sha256, csv.sha256); assert.equal(logged[0].exported_by, auditor.id);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='export_federation_report'", [auditor.id])).length);
  await assert.rejects(pool.query("UPDATE fed_exports SET row_count=0 WHERE body_id=$1", [F.id]), /append-only/);
  assert.equal((await report(outsider, F, 'affiliations', { format: 'csv' })).status, 404);
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/exports`, { token: auditor.token })).length, 1);
  // a body above sees its descendants' numbers but cannot decide for them
  const nat = await signup(); const N = await body(nat);
  const link = must(await api('POST', '/federation/links', { token: fed.token, body: { parent_id: N.id, child_id: F.id } }), 201);
  must(await api('POST', `/federation/links/${link.id}/respond`, { token: nat.token, body: { decision: 'recognise' } }));
  const up = await home(nat, N);
  assert.equal(up.counts.affiliations.approved, h.counts.affiliations.approved, 'the national body sees the roll-up');
  assert.equal(up.me.read_only_via_parent, false);
  assert.equal(up.breakdown.by_region.length, 2);
  assert.equal(must(await api('GET', '/federation/affiliations', { token: nat.token, query: { body_id: F.id } })).total >= 3, true, 'a body above can read a descendant\'s register');
  assert.equal((await decide(nat, 'affiliations', orgs[0].id, 'suspend', { reason: 'not mine' })).status, 403, 'but cannot decide for it');
  assert.equal((await api('POST', `/federation/affiliations/${orgs[0].id}/evidence/${randomUuid()}`, { token: nat.token })).status >= 400, true);
});
const randomUuid = () => '00000000-0000-4000-8000-000000000000';

test('branded certificates and licences are issued through the shared document stack and downloaded under live access checks', async () => {
  const fed = await signup(), clubOwner = await signup(), registrar = await signup(), outsider = await signup();
  const F = await body(fed);
  const rr = await grant(fed, F, registrar, 'registrar');
  const org = await club(clubOwner), cat = await category(fed, F);
  const a = await apply(clubOwner, F, org, cat);
  must(await api('POST', `/federation/affiliations/${a.id}/submit`, { token: clubOwner.token }));
  assert.equal((await api('POST', '/federation/documents', { token: registrar.token, body: { subject_type: 'affiliation', subject_id: a.id } })).status, 409, 'only for an affiliation in force');
  must(await decide(registrar, 'affiliations', a.id, 'approve'));
  const doc = must(await api('POST', '/federation/documents', { token: registrar.token, body: { subject_type: 'affiliation', subject_id: a.id, note: 'Welcome to the federation.' } }), 201);
  assert.equal(doc.family, 'federation_document'); assert.ok(doc.pages >= 1);
  const dl = (u) => fetch(`${base}${doc.url}`, { headers: u ? { authorization: `Bearer ${u.token}` } : {} });
  const ok = await dl(clubOwner);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.equal((await ok.arrayBuffer()).byteLength > 500, true);
  assert.equal((await dl(registrar)).status, 200);
  assert.equal((await dl(outsider)).status, 404, 'outsiders cannot download');
  assert.equal((await api('POST', '/federation/documents', { token: clubOwner.token, body: { subject_type: 'affiliation', subject_id: a.id, note: 'mine' } })).status, 403, 'the club cannot rewrite the federation\'s wording');
  assert.equal(must(await api('POST', '/federation/documents', { token: clubOwner.token, body: { subject_type: 'affiliation', subject_id: a.id } }), 201).id, doc.id, 'the club gets the issued document');
  assert.equal(must(await api('GET', '/federation/documents', { token: clubOwner.token, query: { subject_type: 'affiliation', subject_id: a.id } })).length, 1);
  must(await api('DELETE', `/federation/bodies/${F.id}/roles/${rr.id}`, { token: fed.token }));
  assert.equal((await dl(registrar)).status, 404, 'revoking the role ends access at once');
  assert.equal((await dl(clubOwner)).status, 200);
  assert.ok((await q("SELECT 1 FROM fed_events WHERE subject_id=$1 AND action='document_issued'", [a.id])).length);
});

test('appeals reference the federation record without exposing it to the body\'s staff, and Federation Home counts the open ones', async () => {
  const fed = await signup(), athlete = await signup(['athlete']), nosy = await signup(), licensing = await signup();
  const F = await body(fed); await grant(fed, F, licensing, 'licensing');
  const t = must(await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { name: 'Player', holder_role: 'athlete', sport_id: sport.id } }), 201);
  const l = must(await api('POST', '/federation/licences', { token: athlete.token, body: { body_id: F.id, type_id: t.id } }), 201);
  must(await api('POST', `/federation/licences/${l.id}/submit`, { token: athlete.token }));
  must(await decide(licensing, 'licences', l.id, 'approve'));
  must(await decide(licensing, 'licences', l.id, 'suspend', { reason: 'Panel decision' }));
  const appeal = { category: 'other', subject: 'Appeal against suspension', description: 'I would like to appeal', priority: 'normal', links: [{ type: 'federation_licence', id: l.id }] };
  assert.equal((await api('POST', '/cases', { token: nosy.token, body: appeal })).status, 404, 'only the holder can raise a case about their licence');
  const made = await api('POST', '/cases', { token: athlete.token, body: appeal });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const h = await home(fed, F);
  assert.equal(h.cases.length, 1); assert.equal(h.cases[0].link_type, 'licence');
  assert.ok(!('subject' in h.cases[0]) && !('description' in h.cases[0]), 'the body sees that an appeal is open, never what the person wrote');
});

test('REST, OpenAPI and MCP expose the same federation capabilities with the same permissions', async () => {
  const fed = await signup(), outsider = await signup();
  const F = await body(fed);
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json());
  const ops = Object.values(spec.paths).flatMap((p) => Object.values(p)).filter((o) => o.tags?.includes('Federation')).map((o) => o.operationId);
  assert.ok(ops.length >= 55, `expected the federation surface in OpenAPI, got ${ops.length}`);
  const tools = (await rpc('tools/list', {}, fed.token)).tools.map((x) => x.name);
  for (const op of ops) assert.ok(tools.includes(op), `${op} is an MCP tool`);
  // same data and same permission through REST and MCP
  const viaMcp = await rpc('tools/call', { name: 'get_federation_home', arguments: { id: F.id } }, fed.token);
  const viaRest = must(await api('GET', `/federation/bodies/${F.id}/home`, { token: fed.token }));
  assert.deepEqual(JSON.parse(viaMcp.content[0].text).counts, viaRest.counts);
  const denied = await rpc('tools/call', { name: 'get_federation_home', arguments: { id: F.id } }, outsider.token);
  assert.equal(denied.isError, true, 'the same 404 over MCP');
  // an API token limited to read cannot decide anything
  const tok = must(await api('POST', '/me/tokens', { token: fed.token, body: { name: 'readonly', scopes: ['read'] } }), 201);
  assert.equal((await api('POST', `/federation/bodies/${F.id}/status`, { token: tok.token, body: { status: 'suspended', reason: 'test' } })).status, 403);
  assert.equal((await api('GET', `/federation/bodies/${F.id}/home`, { token: tok.token })).status, 200);
});

test('the migration is additive: nothing is dropped, truncated or cascaded, and it is safe to run twice', async () => {
  const sql = readFileSync(new URL('../migrations/115_federation_os.sql', import.meta.url), 'utf8');
  assert.ok(!/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|ON DELETE CASCADE/i.test(sql), 'no destructive statement');
  assert.deepEqual([...sql.matchAll(/DROP CONSTRAINT[^;]*/gi)].map((m) => m[0].replace(/\s+/g, ' ')), ['DROP CONSTRAINT IF EXISTS organisations_kind_check', 'DROP CONSTRAINT IF EXISTS case_links_entity_type_check'], 'only the two CHECK constraints are widened');
  const before = (await q('SELECT count(*)::int AS n FROM organisations'))[0].n;
  await migrate();
  assert.equal((await q('SELECT count(*)::int AS n FROM organisations'))[0].n, before);
  // every kind that was valid still is
  for (const kind of ['club', 'academy', 'school', 'college', 'university', 'company', 'other']) assert.ok((await q("SELECT $1::text IN ('club','academy','school','college','university','company','other','federation') AS ok", [kind]))[0].ok);
});
