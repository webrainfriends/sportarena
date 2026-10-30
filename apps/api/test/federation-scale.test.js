// Federation governance at scale (#525): delegated administration without sibling/ancestor leakage, maker-checker (no self-approval, one use, exact terms,
// immutable), locked policy inheritance with provenance, rollups that reconcile with the canonical reports and honour small-cell suppression, youth-safe
// exports and aggregates, access review, REST/OpenAPI/MCP parity and a large hierarchy that stays fast without per-row permission shortcuts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0, sport;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)))}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const day = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const signup = async () => { n++; const r = await api('POST', '/auth/register', { body: { handle: `sc_${n}_a`, display_name: `Scale ${n}`, email: `sc${n}@example.com`, password: 'Sup3r-secret-pw!', roles: ['athlete'] } }); return { ...r.body.user, token: r.body.token }; };
const body = async (owner, over = {}) => must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Scale Fed ${++n}`, level: 'national', abbreviation: `S${String(n).padStart(3, '0')}`, country: 'SG', sports: [{ sport_id: sport.id }], ...over } }), 201);
const link = async (parentOwner, childOwner, P, C) => {
  const l = must(await api('POST', '/federation/links', { token: childOwner.token, body: { parent_id: P.id, child_id: C.id } }), 201);
  if (l.status !== 'recognised') must(await api('POST', `/federation/links/${l.id}/respond`, { token: parentOwner.token, body: { decision: 'recognise' } }));
};
const club = async (owner, name = `Scale Club ${++n}`) => must(await api('POST', '/organisations', { token: owner.token, body: { name, kind: 'club' } }), 201);
const category = async (owner, b) => must(await api('POST', `/federation/bodies/${b.id}/affiliation-categories`, { token: owner.token, body: { name: `Full ${++n}`, applicant_kind: 'club' } }), 201);
const apply = async (u, b, org, cat) => {
  const a = must(await api('POST', '/federation/affiliations', { token: u.token, body: { body_id: b.id, organisation_id: org.id, category_id: cat.id, season_year: new Date().getFullYear() } }), 201);
  must(await api('POST', `/federation/affiliations/${a.id}/submit`, { token: u.token }));
  return a;
};
const decide = (u, id, action, extra = {}) => api('POST', `/federation/affiliations/${id}/decision`, { token: u.token, body: { action, ...extra } });
const role = async (owner, b, user, r) => must(await api('POST', `/federation/bodies/${b.id}/roles`, { token: owner.token, body: { user_id: user.id, role: r } }), 201);
const delegate = (owner, b, user, over = {}) => api('POST', `/federation/bodies/${b.id}/delegations`, { token: owner.token, body: { user_id: user.id, role: 'registrar', max_depth: 1, reason: 'Regional administration', ...over } });
const rule = async (owner, b, action, required = true) => must(await api('POST', `/federation/bodies/${b.id}/approval-rules`, { token: owner.token, body: { action, required, reason: 'Two people for membership decisions' } }), 201);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  [sport] = await q("SELECT id, slug FROM sports WHERE slug='badminton'");
});
after(async () => { server.close(); await pool.end(); });

test('delegation reaches only the granted node and its descendants to the stated depth, never siblings, ancestors or further delegation', async () => {
  const nat = await signup(), s1 = await signup(), s2 = await signup(), dist = await signup(), x = await signup(), clubOwner = await signup();
  const N = await body(nat), S1 = await body(s1, { level: 'state' }), S2 = await body(s2, { level: 'state' }), D = await body(dist, { level: 'district' });
  await link(nat, s1, N, S1); await link(nat, s2, N, S2); await link(s1, dist, S1, D);
  const cat = await category(dist, D);
  const a = await apply(clubOwner, D, await club(clubOwner), cat);
  // before delegation X is nobody anywhere
  for (const b of [N, S1, S2, D]) assert.equal((await api('GET', `/federation/bodies/${b.id}/rollup`, { token: x.token })).status, 404);
  // only a body's own owner/admin delegates; a registrar cannot, and nobody delegates to themselves
  const reg = await signup(); await role(s1, S1, reg, 'registrar');
  assert.equal((await delegate(reg, S1, x)).status, 403);
  assert.equal((await delegate(s1, S1, s1)).status, 400);
  assert.equal((await delegate(nat, S1, x)).status, 403, 'the national owner sees the state body but does not run it, so cannot delegate on it');
  const d = must(await delegate(s1, S1, x, { max_depth: 1 }), 201);
  // reaches S1 and D
  for (const b of [S1, D]) must(await api('GET', `/federation/bodies/${b.id}/rollup`, { token: x.token }));
  // ...but not the sibling or the ancestor
  for (const b of [S2, N]) assert.equal((await api('GET', `/federation/bodies/${b.id}/rollup`, { token: x.token })).status, 404, 'no sibling or ancestor access');
  // acts as registrar on the child (the role, not admin)
  assert.equal(must(await decide(x, a.id, 'approve')).status, 'approved');
  assert.equal((await api('POST', `/federation/bodies/${D.id}/roles`, { token: x.token, body: { user_id: reg.id, role: 'auditor' } })).status, 403, 'a delegate is not an admin and cannot grant roles');
  assert.equal((await delegate(x, D, reg)).status, 403, 'and cannot delegate further');
  // one role only: no licensing powers
  assert.equal((await api('POST', `/federation/bodies/${D.id}/licence-types`, { token: x.token, body: { name: 'Player', holder_role: 'athlete', sport_id: sport.id } })).status, 403);
  // depth 0 stops at the node
  must(await api('DELETE', `/federation/bodies/${S1.id}/delegations/${d.id}`, { token: s1.token, body: { reason: 'Re-scoped' } }));
  assert.equal((await api('GET', `/federation/bodies/${D.id}/rollup`, { token: x.token })).status, 404, 'revocation is immediate');
  must(await delegate(s1, S1, x, { max_depth: 0 }), 201);
  must(await api('GET', `/federation/bodies/${S1.id}/rollup`, { token: x.token }));
  assert.equal((await api('GET', `/federation/bodies/${D.id}/rollup`, { token: x.token })).status, 404, 'depth 0 does not reach the child');
  // expiry is read live
  await q("UPDATE fed_delegations SET expires_on=current_date-1 WHERE user_id=$1 AND status='active'", [x.id]);
  assert.equal((await api('GET', `/federation/bodies/${S1.id}/rollup`, { token: x.token })).status, 404);
  assert.equal((await delegate(s1, S1, x, { expires_on: day(-2) })).status, 400);
  // the grant and the revocation stay in history
  const log = must(await api('GET', `/federation/bodies/${S1.id}/history`, { token: s1.token, query: { subject_type: 'delegation' } }));
  assert.ok(log.some((e) => e.action === 'granted') && log.some((e) => e.action === 'revoked'));
  assert.equal((await api('GET', '/federation/delegations/mine', { token: x.token })).status, 200);
});

test('maker-checker: no self-approval, exact terms, single use, immutable, inherited downward, decided by an entitled second person', async () => {
  const nat = await signup(), st = await signup(), maker = await signup(), checker = await signup(), outsider = await signup(), clubOwner = await signup();
  const N = await body(nat), S = await body(st, { level: 'state' });
  await link(nat, st, N, S);
  await role(st, S, maker, 'registrar'); await role(st, S, checker, 'registrar');
  const cat = await category(st, S);
  const aff = [];
  for (let k = 0; k < 3; k++) aff.push(await apply(clubOwner, S, await club(clubOwner), cat));
  // the NATIONAL body requires four eyes; the state body inherits it and cannot relax it
  await rule(nat, N, 'affiliation_approve');
  const states = must(await api('GET', `/federation/bodies/${S.id}/approval-rules`, { token: st.token }));
  const ar = states.find((r) => r.action === 'affiliation_approve');
  assert.ok(ar.required && ar.inherited && ar.source_body_id === N.id);
  must(await api('POST', `/federation/bodies/${S.id}/approval-rules`, { token: st.token, body: { action: 'affiliation_approve', required: false, reason: 'We would rather not' } }), 201);
  assert.ok(must(await api('GET', `/federation/bodies/${S.id}/approval-rules`, { token: st.token })).find((r) => r.action === 'affiliation_approve').required, 'a child cannot weaken a parent rule');
  // approving without an approval is refused
  const blocked = await decide(maker, aff[0].id, 'approve');
  assert.equal(blocked.status, 409); assert.equal(code(blocked), 'approval_required');
  // ask; outsiders cannot ask, and the same request cannot be asked twice while pending
  assert.equal((await api('POST', `/federation/bodies/${S.id}/approvals`, { token: outsider.token, body: { action: 'affiliation_approve', subject_id: aff[0].id, summary: 'Looks fine' } })).status, 404);
  const ask = must(await api('POST', `/federation/bodies/${S.id}/approvals`, { token: maker.token, body: { action: 'affiliation_approve', subject_id: aff[0].id, summary: 'Constitution and insurance seen', evidence: ['https://example.com/evidence/1'] } }), 201);
  assert.equal(ask.status, 'pending'); assert.equal(ask.rule_body_id, N.id);
  assert.equal((await api('POST', `/federation/bodies/${S.id}/approvals`, { token: maker.token, body: { action: 'affiliation_approve', subject_id: aff[0].id, summary: 'Again' } })).status, 409);
  // not usable while pending; cannot be self-approved; outsiders learn nothing
  assert.equal(code(await decide(maker, aff[0].id, 'approve', { approval_id: ask.id })), 'approval_invalid');
  assert.equal((await api('POST', `/federation/approvals/${ask.id}/decision`, { token: maker.token, body: { decision: 'approve' } })).status, 403, 'nobody approves their own request');
  assert.equal((await api('POST', `/federation/approvals/${ask.id}/decision`, { token: outsider.token, body: { decision: 'approve' } })).status, 404);
  assert.equal((await api('POST', `/federation/approvals/${ask.id}/decision`, { token: checker.token, body: { decision: 'reject' } })).status, 400, 'a rejection needs a reason');
  // the checker approves; it is bound to the maker and to the exact record
  const done = must(await api('POST', `/federation/approvals/${ask.id}/decision`, { token: checker.token, body: { decision: 'approve', reason: 'Evidence reviewed' } }));
  assert.equal(done.status, 'approved'); assert.equal(done.authority_source, 'role');
  assert.equal(code(await decide(maker, aff[1].id, 'approve', { approval_id: ask.id })), 'approval_invalid', 'another record');
  assert.equal((await decide(checker, aff[0].id, 'approve', { approval_id: ask.id })).status, 403, 'only the maker may use it');
  assert.equal(must(await decide(maker, aff[0].id, 'approve', { approval_id: ask.id })).status, 'approved');
  // single use, and history keeps the chain
  await assert.rejects(pool.query('UPDATE fed_approvals SET consumed_at=NULL WHERE id=$1', [ask.id]), /used once/);
  const detail = must(await api('GET', `/federation/approvals/${ask.id}`, { token: maker.token }));
  assert.equal(detail.used, true); assert.deepEqual(detail.history.map((h) => h.action), ['requested', 'approved', 'used']);
  // the database itself refuses to rewrite a decided approval or let anyone approve their own
  await assert.rejects(pool.query("UPDATE fed_approvals SET status='rejected' WHERE id=$1", [ask.id]), /immutable/);
  await assert.rejects(pool.query('UPDATE fed_approvals SET decided_by=requested_by WHERE id=$1', [ask.id]), /immutable|check/i);
  await assert.rejects(pool.query('DELETE FROM fed_approvals WHERE id=$1', [ask.id]), /never deleted/);
  await assert.rejects(pool.query("UPDATE fed_approval_rules SET required=false"), /append-only/);
  // a rejected request is final
  const ask2 = must(await api('POST', `/federation/bodies/${S.id}/approvals`, { token: maker.token, body: { action: 'affiliation_approve', subject_id: aff[1].id, summary: 'Second club' } }), 201);
  must(await api('POST', `/federation/approvals/${ask2.id}/decision`, { token: checker.token, body: { decision: 'reject', reason: 'Insurance missing' } }));
  assert.equal(code(await decide(maker, aff[1].id, 'approve', { approval_id: ask2.id })), 'approval_invalid');
  assert.equal((await api('POST', `/federation/approvals/${ask2.id}/decision`, { token: checker.token, body: { decision: 'approve' } })).status, 409, 'the decision is final');
  // central oversight: an admin of the national body above can decide for the state
  const ask3 = must(await api('POST', `/federation/bodies/${S.id}/approvals`, { token: maker.token, body: { action: 'affiliation_approve', subject_id: aff[2].id, summary: 'Third club' } }), 201);
  assert.equal(must(await api('POST', `/federation/approvals/${ask3.id}/decision`, { token: nat.token, body: { decision: 'approve' } })).authority_source, 'ancestor');
  assert.equal(must(await decide(maker, aff[2].id, 'approve', { approval_id: ask3.id })).status, 'approved');
  const awaiting = must(await api('GET', `/federation/bodies/${N.id}/approvals`, { token: nat.token, query: { awaiting_me: 'true' } }));
  assert.ok(Array.isArray(awaiting));
  // rejected suspension/overrides are covered by their own keys: with no rule an action is unchanged
  await rule(nat, N, 'affiliation_suspend');
  const sus = await decide(maker, aff[0].id, 'suspend', { reason: 'Audit' });
  assert.equal(code(sus), 'approval_required');
});

test('policy publication and file exports honour four eyes; the export log keeps purpose and approval; youth holders are withheld', async () => {
  const fed = await signup(), sec = await signup(), sec2 = await signup(), aud = await signup(), aud2 = await signup();
  const F = await body(fed);
  await role(fed, F, sec, 'secretary'); await role(fed, F, sec2, 'secretary'); await role(fed, F, aud, 'auditor'); await role(fed, F, aud2, 'auditor');
  await rule(fed, F, 'policy_publish'); await rule(fed, F, 'bulk_export');
  const p = must(await api('POST', `/federation/bodies/${F.id}/policies`, { token: sec.token, body: { kind: 'roster', title: 'Roster limits' } }), 201);
  const publish = (u, extra = {}) => api('POST', `/federation/policies/${p.id}/versions`, { token: u.token, body: { effective_from: day(1), params: { max_players: 15 }, ...extra } });
  assert.equal(code(await publish(sec)), 'approval_required');
  const ask = must(await api('POST', `/federation/bodies/${F.id}/approvals`, { token: sec.token, body: { action: 'policy_publish', subject_id: p.id, summary: 'Squad cap of 15', effective_from: day(1), params: { max_players: 15 } } }), 201);
  must(await api('POST', `/federation/approvals/${ask.id}/decision`, { token: sec2.token, body: { decision: 'approve' } }));
  assert.equal(code(await publish(sec, { approval_id: ask.id, params: { max_players: 99 } })), 'approval_invalid', 'what is published must be what was approved');
  assert.equal((await publish(sec, { approval_id: ask.id })).status, 201);
  // exports
  const athlete = await signup(), youth = await signup();
  const [lt] = await q("INSERT INTO fed_licence_types(body_id, name, holder_role, sport_id, created_by) VALUES ($1,'Player','athlete',$2,$3) RETURNING id", [F.id, sport.id, fed.id]);
  let k = 0;
  for (const u of [athlete, youth]) await q("INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, status, licence_no, public_code, issued_on, expires_on, decided_at) VALUES ($1,$2,$3,$3,'active',$4,$5,current_date-10,current_date+300,now())", [F.id, lt.id, u.id, `LIC-${++k}`, `PC${k}${Date.now()}`]);
  await q("UPDATE users SET youth_until=current_date+365 WHERE id=$1", [youth.id]);
  const csv = (u, extra = {}) => api('GET', `/federation/bodies/${F.id}/reports/licences`, { token: u.token, query: { format: 'csv', ...extra } });
  assert.equal((await csv(aud)).status, 400, 'a file needs a purpose');
  assert.equal(code(await csv(aud, { purpose: 'Season audit' })), 'approval_required');
  const eask = must(await api('POST', `/federation/bodies/${F.id}/approvals`, { token: aud.token, body: { action: 'bulk_export', summary: 'Licence audit for the board', report: 'licences' } }), 201);
  must(await api('POST', `/federation/approvals/${eask.id}/decision`, { token: aud2.token, body: { decision: 'approve' } }));
  const out = must(await csv(aud, { purpose: 'Season audit', approval_id: eask.id }));
  assert.match(out.csv, /Youth participant/); assert.ok(!out.csv.includes(youth.display_name), 'a youth holder\'s name never leaves in a file');
  assert.ok(out.csv.includes(athlete.display_name));
  const logged = (await q('SELECT purpose, approval_id, redactions FROM fed_exports WHERE body_id=$1', [F.id]))[0];
  assert.equal(logged.purpose, 'Season audit'); assert.equal(logged.approval_id, eask.id); assert.equal(logged.redactions.youth_holders, 1);
  assert.equal(code(await csv(aud, { purpose: 'Season audit', approval_id: eask.id })), 'approval_invalid', 'one approval, one file');
});

test('policy inheritance: a locked requirement binds everything beneath it and the provenance shows which version applies and why', async () => {
  const nat = await signup(), st = await signup();
  const N = await body(nat), S = await body(st, { level: 'state' });
  await link(nat, st, N, S);
  // the state published its own before the lock
  const own = must(await api('POST', `/federation/bodies/${S.id}/policies`, { token: st.token, body: { kind: 'roster', title: 'State roster' } }), 201);
  must(await api('POST', `/federation/policies/${own.id}/versions`, { token: st.token, body: { effective_from: day(-10), params: { max_players: 20 } } }), 201);
  const resolve = async () => must(await api('GET', `/federation/bodies/${S.id}/policy-at`, { query: { kind: 'roster' } }));
  assert.equal((await resolve()).params.max_players, 20, 'without a lock the nearer body wins');
  const top = must(await api('POST', `/federation/bodies/${N.id}/policies`, { token: nat.token, body: { kind: 'roster', title: 'National roster', local_override: 'locked' } }), 201);
  must(await api('POST', `/federation/policies/${top.id}/versions`, { token: nat.token, body: { effective_from: day(-5), params: { max_players: 12 } } }), 201);
  const r = await resolve();
  assert.equal(r.params.max_players, 12); assert.equal(r.inherited, true); assert.equal(r.policy_id, top.id, 'the locked national requirement applies');
  // nobody beneath can publish a competing one
  const other = await signup(); const D = await body(other, { level: 'district' }); await link(st, other, S, D);
  const blocked = await api('POST', `/federation/bodies/${D.id}/policies`, { token: other.token, body: { kind: 'roster', title: 'District roster' } });
  assert.equal(blocked.status, 409); assert.equal(code(blocked), 'policy_locked');
  // other kinds stay free
  assert.equal((await api('POST', `/federation/bodies/${D.id}/policies`, { token: other.token, body: { kind: 'transfer', title: 'District transfers' } })).status, 201);
  const inh = must(await api('GET', `/federation/bodies/${S.id}/policy-inheritance`, { query: { kind: 'roster' } }));
  assert.equal(inh.effective.source_body_id, N.id); assert.equal(inh.effective.locked, true);
  assert.deepEqual(inh.levels.map((l) => l.applies), [true, false], 'the national level is listed first and applies');
  assert.match(inh.levels[0].why, /Locked/); assert.match(inh.levels[1].why, /Overridden/);
  assert.ok(inh.levels[0].version >= 1 && inh.levels[0].version_id, 'provenance carries the version');
});

test('rollup and aggregate reconcile with the canonical report, define every metric, suppress small person cells and never separate youth', async () => {
  const nat = await signup(), st = await signup(), aud = await signup(), clubOwner = await signup();
  const N = await body(nat), S = await body(st, { level: 'state', state: 'North' });
  await link(nat, st, N, S);
  await role(nat, N, aud, 'auditor');
  const cat = await category(nat, N), cat2 = await category(st, S);
  for (let k = 0; k < 2; k++) { const a = await apply(clubOwner, N, await club(clubOwner), cat); must(await decide(nat, a.id, 'approve')); }
  for (let k = 0; k < 3; k++) { const a = await apply(clubOwner, S, await club(clubOwner), cat2); must(await decide(st, a.id, 'approve')); }
  const pending = await apply(clubOwner, S, await club(clubOwner), cat2);
  // people: 6 adult athletes at the state body, 3 at the national
  const [lt] = await q("INSERT INTO fed_licence_types(body_id, name, holder_role, sport_id, created_by) VALUES ($1,'Player','athlete',$2,$3) RETURNING id", [S.id, sport.id, st.id]);
  const [lt2] = await q("INSERT INTO fed_licence_types(body_id, name, holder_role, sport_id, created_by) VALUES ($1,'Player','athlete',$2,$3) RETURNING id", [N.id, sport.id, nat.id]);
  let k = 0;
  const lic = async (b, t, u) => q("INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, status, licence_no, public_code, issued_on, expires_on, decided_at) VALUES ($1,$2,$3,$3,'active',$4,$5,current_date-10,current_date+300,now())", [b.id, t.id, u.id, `L${++k}`, `PCX${k}${Date.now()}`]);
  for (let j = 0; j < 6; j++) await lic(S, lt, await signup());
  for (let j = 0; j < 3; j++) await lic(N, lt2, await signup());
  const youthU = await signup(); await lic(S, lt, youthU); await q('UPDATE users SET youth_until=current_date+400 WHERE id=$1', [youthU.id]);

  const roll = must(await api('GET', `/federation/bodies/${N.id}/rollup`, { token: aud.token }));
  const defs = must(await api('GET', '/federation/metric-definitions'));
  const metricKeys = Object.keys(roll.rows[0]).filter((x) => defs.some((d) => d.key === x));
  assert.ok(metricKeys.length >= 10, 'every dashboard number is a defined metric');
  for (const key of ['affiliations_in_force', 'licences_good_standing', 'athletes', 'credential_health_pct', 'awaiting_decision']) assert.ok(defs.find((d) => d.key === key)?.definition.length > 20);
  const own = roll.rows.find((r) => r.own), kid = roll.rows.find((r) => !r.own);
  assert.equal(own.affiliations_in_force, 2); assert.equal(kid.affiliations_in_force, 3); assert.equal(kid.awaiting_decision, 1);
  const report = must(await api('GET', `/federation/bodies/${N.id}/reports/affiliations`, { token: aud.token }));
  assert.equal(own.affiliations_in_force + kid.affiliations_in_force, report.totals.in_force, 'the dashboard reconciles to the canonical report');
  assert.equal(own.athletes, null, '3 people is below the floor'); assert.ok(own.suppressed.includes('athletes'));
  assert.equal(kid.licences_good_standing, 7, 'a cell of 7 includes the youth licence; youth are never separated'); assert.equal(kid.athletes, 7);
  assert.equal(kid.credential_health_pct, 100);
  // drill-down: organisation-level numbers list their records, person-level ones are not drillable
  const drill = must(await api('GET', `/federation/bodies/${N.id}/rollup/records`, { token: aud.token, query: { metric: 'affiliations_in_force', node_id: S.id } }));
  assert.equal(drill.total, 3); assert.equal(drill.rows.length, 3);
  assert.equal((await api('GET', `/federation/bodies/${N.id}/rollup/records`, { token: aud.token, query: { metric: 'athletes' } })).status, 400);
  assert.equal((await api('GET', `/federation/bodies/${N.id}/rollup/records`, { token: aud.token, query: { metric: 'affiliations_in_force', node_id: (await body(await signup())).id } })).status, 404);
  // aggregate: configurable, filtered, suppressed
  const agg = must(await api('GET', `/federation/bodies/${N.id}/aggregate`, { token: aud.token, query: { measure: 'licences', group_by: 'level', credential_state: 'in_force' } }));
  const byKey = Object.fromEntries(agg.rows.map((r) => [r.key, r]));
  assert.equal(byKey.national.suppressed, true, 'the national cell of 3 is hidden');
  assert.equal(byKey.state.suppressed, true, 'and so is its only neighbour, so the hidden cell cannot be recovered');
  assert.equal(agg.total, null); assert.equal(agg.suppressed_cells, 2);
  const onlyState = must(await api('GET', `/federation/bodies/${N.id}/aggregate`, { token: aud.token, query: { measure: 'licences', group_by: 'level', credential_state: 'in_force', level: 'state' } }));
  assert.equal(onlyState.rows[0].count, 7); assert.equal(onlyState.total, 7);
  assert.ok(!JSON.stringify(agg).includes(youthU.display_name) && !('youth' in agg));
  const aff = must(await api('GET', `/federation/bodies/${N.id}/aggregate`, { token: aud.token, query: { measure: 'affiliations', group_by: 'status', state: 'North' } }));
  assert.equal(aff.rows.find((r) => r.key === 'in_force').count, 3);
  assert.equal((await api('GET', `/federation/bodies/${N.id}/aggregate`, { token: aud.token, query: { measure: 'affiliations', event_id: pending.id } })).status, 400);
  assert.equal((await api('GET', `/federation/bodies/${N.id}/aggregate`, { token: (await signup()).token, query: { measure: 'licences' } })).status, 404);
});

test('access review lists admins, roles, delegations, stale accounts and service tokens; certification revokes with history and flags stay pending', async () => {
  const nat = await signup(), st = await signup(), reg = await signup(), del = await signup();
  const N = await body(nat), S = await body(st, { level: 'state' });
  await link(nat, st, N, S);
  const r = await role(st, S, reg, 'registrar');
  const d = must(await delegate(nat, N, del, { max_depth: 1 }), 201);
  await q("INSERT INTO api_tokens(user_id, name, token_hash, scopes) VALUES ($1,'bulk sync',$2,ARRAY['admin']::text[])", [reg.id, `h${Date.now()}`]);
  await q("UPDATE auth_sessions SET last_seen_at = now() - interval '200 days' WHERE user_id=$1", [reg.id]);
  const rev = must(await api('GET', `/federation/bodies/${N.id}/access-review`, { token: nat.token }));
  assert.equal(rev.bodies, 2);
  assert.equal(rev.summary.roles, 1); assert.equal(rev.summary.delegations, 1);
  assert.ok(rev.summary.admins >= 2); assert.ok(rev.summary.service_identities >= 1 && rev.summary.broad_tokens >= 1, 'a broad API token held by staff is called out');
  assert.ok(rev.roles[0].stale, 'a person who never signed in with a session is stale');
  assert.equal(rev.roles[0].body_name != null, true);
  assert.equal((await api('GET', `/federation/bodies/${N.id}/access-review`, { token: reg.token })).status, 404, 'a registrar of a child cannot read the parent review');
  assert.equal((await api('GET', `/federation/bodies/${S.id}/access-review`, { token: reg.token })).status, 403, 'a scoped role other than auditor cannot read it');
  // certification needs reasons for revoke/flag, accepts only items in scope
  assert.equal((await api('POST', `/federation/bodies/${N.id}/access-reviews`, { token: nat.token, body: { decisions: [{ kind: 'role', ref_id: r.id, decision: 'revoke' }] } })).status, 400);
  assert.equal((await api('POST', `/federation/bodies/${N.id}/access-reviews`, { token: nat.token, body: { decisions: [{ kind: 'role', ref_id: d.id, decision: 'revoke', reason: 'wrong kind' }] } })).status, 400);
  const admin = rev.admins.find((a) => a.id === st.id);
  const done = must(await api('POST', `/federation/bodies/${N.id}/access-reviews`, { token: nat.token, body: { note: 'Q4 review', decisions: [
    { kind: 'role', ref_id: r.id, decision: 'revoke', reason: 'Left the state body' }, { kind: 'delegation', ref_id: d.id, decision: 'keep' }, { kind: 'org_admin', ref_id: admin.ref_id, decision: 'flag', reason: 'Confirm with the state body' }] } }), 201);
  assert.equal(done.revoked, 1); assert.equal(done.flagged, 1); assert.ok(done.kept >= 1);
  assert.equal((await q('SELECT status FROM governing_body_roles WHERE id=$1', [r.id]))[0].status, 'revoked');
  assert.equal((await api('GET', `/federation/bodies/${S.id}/rollup`, { token: reg.token })).status, 404, 'the revoked role stops working immediately');
  const after = must(await api('GET', `/federation/bodies/${N.id}/access-review`, { token: nat.token }));
  assert.equal(after.summary.roles, 0); assert.equal(after.summary.pending_revocations, 1); assert.equal(after.last_review.revoked, 1);
  assert.equal((await q('SELECT count(*)::int AS n FROM fed_access_review_items WHERE review_id=$1', [done.id]))[0].n >= 3, true);
  await assert.rejects(pool.query('DELETE FROM fed_access_review_items WHERE review_id=$1', [done.id]), /append-only/);
  assert.equal(must(await api('GET', `/federation/bodies/${N.id}/access-reviews`, { token: nat.token })).length, 1);
  const hist = must(await api('GET', `/federation/bodies/${S.id}/history`, { token: st.token, query: { subject_type: 'role' } }));
  assert.ok(hist.some((e) => e.action === 'revoked_in_review'));
});

test('REST, OpenAPI and MCP expose the same governance capabilities', async () => {
  const { buildOpenApi } = await import('../src/openapi.js');
  const { capabilities } = await import('../src/capabilities/index.js');
  const names = ['grant_federation_delegation', 'revoke_federation_delegation', 'list_federation_delegations', 'my_federation_delegations', 'set_federation_approval_rule', 'get_federation_approval_rules',
    'request_federation_approval', 'decide_federation_approval', 'cancel_federation_approval', 'list_federation_approvals', 'get_federation_approval', 'get_policy_inheritance',
    'list_federation_metric_definitions', 'get_federation_rollup', 'list_federation_rollup_records', 'get_federation_aggregate', 'get_federation_access_review', 'record_federation_access_review', 'list_federation_access_reviews'];
  const doc = buildOpenApi();
  const ops = new Set(Object.values(doc.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId));
  for (const nm of names) { assert.ok(capabilities.some((c) => c.name === nm), `${nm} is a capability`); assert.ok(ops.has(nm), `${nm} is in OpenAPI`); }
  const u = await signup();
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${u.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const tools = (await r.json()).result.tools.map((t) => t.name);
  for (const nm of names) assert.ok(tools.includes(nm), `${nm} is an MCP tool`);
  // a read-scope token cannot grant a delegation
  assert.equal(capabilities.find((c) => c.name === 'grant_federation_delegation').scope, 'write');
  assert.equal(capabilities.find((c) => c.name === 'get_federation_rollup').scope, 'read');
});

test('a national hierarchy of 500 bodies and 40,000 records resolves permissions, rollups and aggregates in bounded time, with isolation intact', async () => {
  const root = await signup(), outsider = await signup(), delegate1 = await signup();
  const N = await body(root);
  // 8 states x 8 districts x 7 leagues, built in SQL with the same recognised links the API creates
  const [u] = [root];
  await q(`INSERT INTO organisations(name, kind, created_by) SELECT 'Bulk body ' || g, 'other', $1::uuid FROM generate_series(1, 560) g`, [u.id]);
  await q(`INSERT INTO governing_bodies(organisation_id, level, abbreviation, country, state, created_by)
           SELECT o.id, (ARRAY['state','district','league'])[1 + (rn > 8)::int + (rn > 72)::int], 'B' || rn, 'SG', 'S' || (rn % 8), $1::uuid
             FROM (SELECT id, row_number() OVER (ORDER BY name) AS rn FROM organisations WHERE name LIKE 'Bulk body %') o`, [u.id]);
  const bodies = (await q("SELECT b.id, o.name, row_number() OVER (ORDER BY o.name) AS rn FROM governing_bodies b JOIN organisations o ON o.id=b.organisation_id WHERE o.name LIKE 'Bulk body %'")).map((r) => ({ id: r.id, rn: Number(r.rn) }));
  const states = bodies.filter((b) => b.rn <= 8), districts = bodies.filter((b) => b.rn > 8 && b.rn <= 72), leagues = bodies.filter((b) => b.rn > 72);
  const links = [...states.map((s) => [N.id, s.id]), ...districts.map((d, i) => [states[i % 8].id, d.id]), ...leagues.map((l, i) => [districts[i % 64].id, l.id])];
  for (let i = 0; i < links.length; i += 200) {
    const chunk = links.slice(i, i + 200);
    await q(`INSERT INTO governing_body_links(parent_id, child_id, status, requested_by, requested_side, effective_from) SELECT p, c, 'recognised', $1::uuid, 'child', current_date FROM unnest($2::uuid[], $3::uuid[]) AS t(p, c)`, [u.id, chunk.map((x) => x[0]), chunk.map((x) => x[1])]);
  }
  // 20,000 affiliations and 20,000 licences spread over the leagues
  const [cat] = await q('INSERT INTO fed_affiliation_categories(body_id, name, applicant_kind, sport_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [N.id, 'Bulk', 'club', sport.id, u.id]);
  const [lt] = await q("INSERT INTO fed_licence_types(body_id, name, holder_role, sport_id, created_by) VALUES ($1,'Bulk','athlete',$2,$3) RETURNING id", [N.id, sport.id, u.id]);
  await q(`INSERT INTO users(handle, display_name, password_hash, email_enc, email_idx) SELECT 'bulk' || g, 'Bulk ' || g, 'x', 'x', 'bulk' || g FROM generate_series(1, 20000) g`);
  const leagueIds = leagues.map((l) => l.id);
  await q(`INSERT INTO organisations(name, kind, created_by) SELECT 'Bulk club ' || g, 'club', $1::uuid FROM generate_series(1, 20000) g`, [u.id]);
  await q(`INSERT INTO fed_affiliations(body_id, organisation_id, category_id, season_year, status, affiliation_no, applicant_id, effective_from, effective_to, decided_at)
           SELECT ($2::uuid[])[1 + (rn % $3::int)], o.id, $4::uuid, extract(year FROM current_date)::int, 'approved', 'AF' || rn, $1::uuid, current_date-30, current_date+300, now()
             FROM (SELECT id, row_number() OVER (ORDER BY name) AS rn FROM organisations WHERE name LIKE 'Bulk club %') o`, [u.id, leagueIds, leagueIds.length, cat.id]);
  await q(`INSERT INTO fed_licences(body_id, type_id, holder_id, applicant_id, status, licence_no, public_code, issued_on, expires_on, decided_at)
           SELECT ($3::uuid[])[1 + (h.rn::int % $4::int)], $2::uuid, h.id, h.id, 'active', 'BL' || h.rn, 'BP' || h.rn, current_date-30, current_date+300, now() FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM users WHERE handle LIKE 'bulk%' LIMIT 20000) h WHERE $1::uuid IS NOT NULL`, [u.id, lt.id, leagueIds, leagueIds.length]);
  assert.equal((await q('SELECT count(*)::int AS n FROM fed_affiliations WHERE category_id=$1', [cat.id]))[0].n, 20000);

  const time = async (fn) => { const t = Date.now(); const r = await fn(); return [Date.now() - t, r]; };
  const [tRoll, roll] = await time(async () => must(await api('GET', `/federation/bodies/${N.id}/rollup`, { token: root.token })));
  const kidTotal = roll.rows.filter((r) => !r.own).reduce((s, r) => s + r.affiliations_in_force, 0);
  assert.equal(kidTotal, 20000, 'the rollup counts every record exactly once down 3 levels');
  assert.equal(roll.rows.length, 9);
  const [tAgg, agg] = await time(async () => must(await api('GET', `/federation/bodies/${N.id}/aggregate`, { token: root.token, query: { measure: 'affiliations', group_by: 'state', credential_state: 'in_force' } })));
  assert.equal(agg.total, 20000);
  const [tRep] = await time(async () => must(await api('GET', `/federation/bodies/${N.id}/reports/jurisdiction`, { token: root.token, query: { limit: 100 } })));
  // permission resolution at the deepest level stays a fixed number of queries: a delegation at the top reaches a league 3 levels down
  must(await delegate(root, N, delegate1, { max_depth: 3 }), 201);
  const [tAuth] = await time(async () => { for (let i = 0; i < 20; i++) must(await api('GET', `/federation/bodies/${leagues[i].id}/rollup`, { token: delegate1.token })); });
  assert.equal((await api('GET', `/federation/bodies/${leagues[0].id}/rollup`, { token: outsider.token })).status, 404, 'isolation holds at scale');
  for (const [label, ms, limit] of [['rollup', tRoll, 4000], ['aggregate', tAgg, 4000], ['jurisdiction report', tRep, 6000], ['20 deep permission-checked rollups', tAuth, 8000]]) assert.ok(ms < limit, `${label} took ${ms}ms (limit ${limit}ms)`);
});
