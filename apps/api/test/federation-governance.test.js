// Federation governance depth (#574): jurisdiction-scoped delegation, the compliance-exception register and renewal campaigns, on top of the #475 module.
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


const jur = async (owner, b, name, level = 'region') => must(await api('POST', `/federation/bodies/${b.id}/jurisdictions`, { token: owner.token, body: { level, name } }), 201);
const notes = async (userId, kind) => q('SELECT id, body, data FROM notifications WHERE user_id=$1 AND kind=$2 ORDER BY created_at', [userId, kind]);

test('roles can be limited to jurisdictions: lists, decisions and body-wide actions are scoped, live and fail closed', async () => {
  const owner = await signup(), cA = await signup(), cB = await signup(), cC = await signup(), reg = await signup(), other = await signup();
  const F = await body(owner), O = await body(other);
  const cat = await category(owner, F);
  const north = await jur(owner, F, `North ${++n}`), south = await jur(owner, F, `South ${++n}`);
  assert.equal((await api('POST', `/federation/bodies/${F.id}/jurisdictions`, { token: owner.token, body: { level: 'region', name: north.name } })).status, 409, 'unique per level');
  assert.equal((await api('POST', `/federation/bodies/${F.id}/jurisdictions`, { token: other.token, body: { level: 'region', name: 'Nope' } })).status, 404, 'outsiders get 404');
  const foreign = await jur(other, O, `West ${++n}`);
  const oA = await club(cA), oB = await club(cB), oC = await club(cC);
  assert.equal((await api('POST', '/federation/affiliations', { token: cA.token, body: { body_id: F.id, organisation_id: oA.id, category_id: cat.id, season_year: new Date().getFullYear(), jurisdiction_id: foreign.id } })).status, 400, 'another body\'s jurisdiction is refused');
  const aN = await apply(cA, F, oA, cat, { jurisdiction_id: north.id }), aS = await apply(cB, F, oB, cat, { jurisdiction_id: south.id }), aNone = await apply(cC, F, oC, cat);
  for (const a of [aN, aS, aNone]) must(await api('POST', `/federation/affiliations/${a.id}/submit`, { token: ({ [aN.id]: cA, [aS.id]: cB, [aNone.id]: cC })[a.id].token }));
  // the registrar is limited to North
  assert.equal((await api('POST', `/federation/bodies/${F.id}/roles`, { token: owner.token, body: { user_id: reg.id, role: 'registrar', jurisdiction_ids: [foreign.id] } })).status, 400, 'only this body\'s jurisdictions');
  const role = must(await api('POST', `/federation/bodies/${F.id}/roles`, { token: owner.token, body: { user_id: reg.id, role: 'registrar', jurisdiction_ids: [north.id] } }), 201);
  assert.deepEqual(role.jurisdiction_ids, [north.id]);
  const list = must(await api('GET', '/federation/affiliations', { token: reg.token, query: { body_id: F.id, include_descendants: true } }));
  assert.deepEqual(list.items.map((a) => a.id), [aN.id], 'sees only North');
  assert.equal((await api('GET', `/federation/affiliations/${aS.id}`, { token: reg.token })).status, 404, 'a record outside the jurisdiction does not exist for them');
  assert.equal((await decide(reg, 'affiliations', aS.id, 'start_review')).status, 404);
  assert.equal((await decide(reg, 'affiliations', aNone.id, 'start_review')).status, 404, 'no jurisdiction fails closed');
  assert.equal(must(await decide(reg, 'affiliations', aN.id, 'start_review')).status, 'under_review');
  // body-wide actions stay closed to a limited role
  assert.equal((await report(reg, F, 'affiliations')).status, 403);
  assert.equal((await api('POST', `/federation/bodies/${F.id}/affiliation-categories`, { token: reg.token, body: { name: 'Sneaky category', applicant_kind: 'club' } })).status, 403);
  const roles = must(await api('GET', `/federation/bodies/${F.id}/roles`, { token: owner.token }));
  assert.deepEqual(roles.roles.find((r) => r.role === 'registrar').jurisdiction_names, [north.name]);
  // home queues are scoped too; an unlimited registrar still sees everything
  const h = await home(reg, F);
  assert.deepEqual(h.queue.affiliations.map((a) => a.id), [aN.id]);
  assert.equal(h.me.can.affiliations, true);
  const wide = await signup(); await grant(owner, F, wide, 'registrar');
  assert.equal(must(await api('GET', '/federation/affiliations', { token: wide.token, query: { body_id: F.id } })).total, 3);
  // revoking is immediate
  must(await api('DELETE', `/federation/bodies/${F.id}/roles/${role.id}`, { token: owner.token }));
  assert.equal((await api('GET', '/federation/affiliations', { token: reg.token, query: { body_id: F.id } })).status, 404);
  // retiring a jurisdiction keeps it on the records
  must(await api('POST', `/federation/jurisdictions/${south.id}/archive`, { token: owner.token }));
  assert.equal(must(await api('GET', `/federation/affiliations/${aS.id}`, { token: owner.token })).jurisdiction_name, south.name);
  assert.ok(!must(await api('GET', `/federation/bodies/${F.id}/jurisdictions`)).some((j) => j.id === south.id));
});

test('compliance exceptions: an override opens one, the register is scoped, reviews are immutable history and standing reconciles', async () => {
  const owner = await signup(), club1 = await signup(), club2 = await signup(), registrar = await signup(), compliance = await signup(), auditor = await signup(), limited = await signup();
  const F = await body(owner);
  const cat = await category(owner, F);
  await policy(owner, F, 'affiliation', { required_documents: [], min_teams: 1 });
  const north = await jur(owner, F, `North ${++n}`);
  await grant(owner, F, registrar, 'registrar'); await grant(owner, F, compliance, 'compliance'); await grant(owner, F, auditor, 'auditor');
  await must(await api('POST', `/federation/bodies/${F.id}/roles`, { token: owner.token, body: { user_id: limited.id, role: 'compliance', jurisdiction_ids: [north.id] } }), 201);
  const o1 = await club(club1), o2 = await club(club2);
  const a1 = await apply(club1, F, o1, cat, { jurisdiction_id: north.id }), a2 = await apply(club2, F, o2, cat);
  for (const [a, u] of [[a1, club1], [a2, club2]]) must(await api('POST', `/federation/affiliations/${a.id}/submit`, { token: u.token }));
  assert.equal((await decide(registrar, 'affiliations', a1.id, 'approve')).status, 409, 'blocked without an override');
  must(await decide(registrar, 'affiliations', a1.id, 'approve', { override_reason: 'Teams register next month' }));
  must(await decide(registrar, 'affiliations', a2.id, 'approve', { override_reason: 'Second club, same reason' }));
  const reg = must(await api('GET', `/federation/bodies/${F.id}/exceptions`, { token: auditor.token }));
  assert.equal(reg.total, 2); assert.equal(reg.summary.open, 2);
  const e1 = reg.items.find((e) => e.subject_id === a1.id);
  assert.equal(e1.subject_type, 'affiliation'); assert.equal(e1.status, 'open'); assert.equal(e1.overdue, false);
  assert.ok(e1.failed.some((f) => f.key === 'teams'), 'the failed requirement is recorded');
  assert.ok(!('evidence' in e1));
  // the dashboard reads the same register
  const h = await home(owner, F);
  assert.equal(h.counts.exceptions, 2); assert.ok(h.exceptions.every((x) => x.exception_id && x.review_due));
  // a limited compliance officer sees only North
  assert.deepEqual(must(await api('GET', `/federation/bodies/${F.id}/exceptions`, { token: limited.token })).items.map((e) => e.subject_id), [a1.id]);
  // who may review: compliance within scope, not the auditor, not the registrar who decided
  const rv = (u, e, b) => api('POST', `/federation/exceptions/${e.id}/review`, { token: u.token, body: b });
  const e2 = reg.items.find((e) => e.subject_id === a2.id);
  assert.equal((await rv(auditor, e1, { outcome: 'accepted', note: 'I only read' })).status, 403);
  assert.equal((await rv(registrar, e1, { outcome: 'remedied', note: 'Marking my own' })).status, 403);
  assert.equal((await rv(limited, e2, { outcome: 'accepted', note: 'Not my place' })).status, 403, 'outside their jurisdiction');
  assert.equal((await rv(compliance, e1, { outcome: 'extended', note: 'Waiting on registration' })).status, 400, 'extension needs a date');
  assert.equal((await rv(compliance, e1, { outcome: 'extended', note: 'Waiting on registration', review_due: '2000-01-01' })).status, 400, 'the date must be in the future');
  assert.equal((await rv(compliance, e1, { outcome: 'remedied', note: 'x' })).status, 400, 'a real note is required');
  assert.equal((await rv(compliance, e1, { outcome: 'accepted', note: 'Stale try', version: 99 })).status, 409);
  const due = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const ext = must(await rv(compliance, e1, { outcome: 'extended', note: 'Waiting on registration', review_due: due }));
  assert.equal(ext.status, 'extended'); assert.equal(ext.review_due, due);
  const done = must(await rv(limited, e1, { outcome: 'remedied', note: 'Two teams are now registered' }));
  assert.equal(done.status, 'remedied'); assert.equal(done.review_count, 2);
  assert.equal((await rv(compliance, e1, { outcome: 'accepted', note: 'Closed already' })).status, 409);
  assert.deepEqual(done.history.map((h2) => h2.action), ['opened', 'review_extended', 'review_remedied']);
  // the decision on the record is untouched
  assert.equal((await q('SELECT override_reason FROM fed_affiliations WHERE id=$1', [a1.id]))[0].override_reason, 'Teams register next month');
  // overdue is read live
  await q("UPDATE fed_exceptions SET review_due=current_date-3 WHERE id=$1", [e2.id]);
  const od = must(await api('GET', `/federation/bodies/${F.id}/exceptions`, { token: auditor.token, query: { status: 'overdue' } }));
  assert.deepEqual(od.items.map((e) => e.id), [e2.id]);
  assert.equal((await home(owner, F)).exceptions[0].overdue, true, 'overdue first on Federation Home');
  // standing reconciles with the registers
  const st = must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: auditor.token }));
  assert.equal(st.affiliations.in_force, 2); assert.equal(st.affiliations.under_exception, 1); assert.equal(st.affiliations.good_standing, 1);
  assert.deepEqual(st.exceptions, { open: 1, overdue: 1, resolved: 1 });
  assert.equal((await api('GET', `/federation/bodies/${F.id}/compliance`, { token: (await signup()).token })).status, 404);
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: limited.token })).affiliations.in_force, 1, 'a limited role sees its own jurisdiction');
  // history is append-only
  await assert.rejects(q("UPDATE fed_events SET reason='x' WHERE subject_id=$1", [e1.id]));
});

test('renewal campaigns: preview, launch, notify once, track renewals live, remind on schedule, close', async () => {
  const owner = await signup(), cA = await signup(), cB = await signup(), cC = await signup(), registrar = await signup(), north = await signup(), outsider = await signup();
  const F = await body(owner);
  const cat = await category(owner, F);
  const N = await jur(owner, F, `North ${++n}`), S = await jur(owner, F, `South ${++n}`);
  await grant(owner, F, registrar, 'registrar');
  await must(await api('POST', `/federation/bodies/${F.id}/roles`, { token: owner.token, body: { user_id: north.id, role: 'registrar', jurisdiction_ids: [N.id] } }), 201);
  const mk = async (u, j) => { const o = await club(u); const a = await apply(u, F, o, cat, j ? { jurisdiction_id: j.id } : {}); must(await api('POST', `/federation/affiliations/${a.id}/submit`, { token: u.token })); must(await decide(registrar, 'affiliations', a.id, 'approve')); return a; };
  const aA = await mk(cA, N), aB = await mk(cB, S), aC = await mk(cC, N);
  for (const a of [aA, aB, aC]) await q('UPDATE fed_affiliations SET effective_from=current_date-300, effective_to=current_date+10 WHERE id=$1', [a.id]);
  const cfg = { target: 'affiliation', window_from: day(0), window_to: day(30) };
  assert.equal((await api('POST', `/federation/bodies/${F.id}/campaigns/preview`, { token: outsider.token, body: cfg })).status, 404);
  assert.equal(must(await api('POST', `/federation/bodies/${F.id}/campaigns/preview`, { token: registrar.token, body: cfg })).records, 3);
  assert.equal(must(await api('POST', `/federation/bodies/${F.id}/campaigns/preview`, { token: registrar.token, body: { ...cfg, jurisdiction_ids: [N.id] } })).records, 2);
  assert.equal((await api('POST', `/federation/bodies/${F.id}/campaigns/preview`, { token: registrar.token, body: { ...cfg, window_to: day(-5) } })).status, 400);
  // a limited registrar may only run campaigns for their own jurisdiction
  assert.equal((await api('POST', `/federation/bodies/${F.id}/campaigns`, { token: north.token, body: { ...cfg, name: 'Everyone' } })).status, 403);
  assert.equal((await api('POST', `/federation/bodies/${F.id}/campaigns`, { token: north.token, body: { ...cfg, name: 'South', jurisdiction_ids: [S.id] } })).status, 403);
  const draft = must(await api('POST', `/federation/bodies/${F.id}/campaigns`, { token: registrar.token, body: { ...cfg, name: 'Club renewals', jurisdiction_ids: [N.id], message: 'Renew before the season starts' } }), 201);
  assert.equal(draft.status, 'draft'); assert.deepEqual(draft.reminder_days, [30, 14, 7]);
  assert.equal((await notes(cA.id, 'federation_renewal_campaign')).length, 0, 'nothing is sent from a draft');
  const edited = must(await api('POST', `/federation/bodies/${F.id}/campaigns`, { token: registrar.token, body: { ...cfg, campaign_id: draft.id, name: 'Club renewals 2', jurisdiction_ids: [N.id], reminder_days: [14, 3] }, }), 201);
  assert.equal(edited.name, 'Club renewals 2'); assert.deepEqual(edited.reminder_days, [14, 3]);
  const run = must(await api('POST', `/federation/campaigns/${draft.id}/launch`, { token: registrar.token }));
  assert.equal(run.status, 'running'); assert.equal(run.recipients, 2);
  assert.equal((await api('POST', `/federation/campaigns/${draft.id}/launch`, { token: registrar.token })).status, 409);
  assert.equal((await api('POST', `/federation/campaigns/${draft.id}/launch`, { token: outsider.token })).status, 404);
  assert.equal((await notes(cA.id, 'federation_renewal_campaign')).length, 1); assert.equal((await notes(cB.id, 'federation_renewal_campaign')).length, 0, 'South is not covered');
  // the sweep does not repeat today's notice, and the body's own automatic reminder skips covered records
  await runFederationSweeps();
  assert.equal((await notes(cA.id, 'federation_renewal_campaign')).length, 1);
  assert.equal((await notes(cA.id, 'federation_affiliation_renewal')).length, 0, 'not told twice');
  assert.equal((await notes(cB.id, 'federation_affiliation_renewal')).length, 1, 'uncovered records keep the automatic reminder');
  // progress is live from the renewal chain
  let got = must(await api('GET', `/federation/campaigns/${draft.id}`, { token: registrar.token }));
  assert.deepEqual(got.progress, { renewed: 0, in_progress: 0, awaiting: 2, lapsed: 0 });
  const ren = must(await api('POST', `/federation/affiliations/${aA.id}/renew`, { token: cA.token, body: {} }), 201);
  got = must(await api('GET', `/federation/campaigns/${draft.id}`, { token: registrar.token }));
  assert.equal(got.progress.in_progress, 1);
  must(await api('POST', `/federation/affiliations/${ren.id}/submit`, { token: cA.token }));
  must(await decide(registrar, 'affiliations', ren.id, 'approve'));
  got = must(await api('GET', `/federation/campaigns/${draft.id}`, { token: registrar.token, query: { state: 'renewed' } }));
  assert.equal(got.progress.renewed, 1); assert.equal(got.total, 1); assert.equal(got.recipients[0].subject_id, aA.id);
  // the limited registrar sees North only; a limited role can read, an outsider cannot
  assert.equal(must(await api('GET', `/federation/campaigns/${draft.id}`, { token: north.token })).total, 2);
  assert.equal((await api('GET', `/federation/campaigns/${draft.id}`, { token: outsider.token })).status, 404);
  // reminders: inside the 14-day step, one per step, only for those not renewed
  await q('UPDATE fed_campaign_recipients SET last_reminded_at = now() - interval \'2 days\' WHERE campaign_id=$1', [draft.id]);
  await runFederationSweeps();
  assert.equal((await notes(cC.id, 'federation_renewal_campaign')).length, 2, 'the 14-day step reminded the club that has not renewed');
  assert.equal((await notes(cA.id, 'federation_renewal_campaign')).length, 1, 'the renewed club is left alone');
  await q('UPDATE fed_campaign_recipients SET last_reminded_at = now() - interval \'2 days\' WHERE campaign_id=$1', [draft.id]);
  await runFederationSweeps();
  assert.equal((await notes(cC.id, 'federation_renewal_campaign')).length, 2, 'the same step is never sent twice');
  // the club's record ran out: overdue notice once, state lapsed
  await q('UPDATE fed_affiliations SET effective_from=current_date-300, effective_to=current_date-1 WHERE id=$1', [aC.id]);
  await q('UPDATE fed_campaign_recipients SET last_reminded_at = now() - interval \'2 days\' WHERE campaign_id=$1', [draft.id]);
  await runFederationSweeps();
  assert.equal((await notes(cC.id, 'federation_renewal_campaign')).at(-1).data.campaign_id, draft.id);
  assert.equal(must(await api('GET', `/federation/campaigns/${draft.id}`, { token: registrar.token })).progress.lapsed, 1);
  // closing stops reminders; the outcome stays readable
  const closed = must(await api('POST', `/federation/campaigns/${draft.id}/close`, { token: registrar.token, body: { reason: 'Season started' } }));
  assert.equal(closed.status, 'closed');
  assert.equal((await api('POST', `/federation/campaigns/${draft.id}/close`, { token: registrar.token, body: {} })).status, 409);
  const lst = must(await api('GET', `/federation/bodies/${F.id}/campaigns`, { token: registrar.token }));
  assert.equal(lst.total, 1); assert.equal(lst.items[0].progress.renewed, 1);
  const hist = must(await api('GET', `/federation/campaigns/${draft.id}`, { token: registrar.token })).history.map((h) => h.action);
  assert.deepEqual(hist, ['created', 'updated', 'launched', 'closed']);
  // a campaign over licences uses the same machinery
  const lt = must(await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: owner.token, body: { name: `Player ${++n}`, holder_role: 'athlete', sport_id: sport.id, duration_months: 12 } }), 201);
  assert.equal(must(await api('POST', `/federation/bodies/${F.id}/campaigns/preview`, { token: owner.token, body: { target: 'licence', category_ids: [lt.id], window_from: day(0), window_to: day(30) } })).records, 0);
  assert.equal((await api('POST', `/federation/campaigns/${draft.id}/launch`, { token: owner.token })).status, 409);
});

test('REST, OpenAPI and MCP carry the governance-depth capabilities with the same permissions; the migration is additive', async () => {
  const fed = await signup(), outsider = await signup();
  const F = await body(fed);
  const names = ['save_federation_jurisdiction', 'archive_federation_jurisdiction', 'list_federation_jurisdictions', 'list_federation_exceptions', 'review_federation_exception', 'get_federation_compliance',
    'preview_renewal_campaign', 'save_renewal_campaign', 'launch_renewal_campaign', 'close_renewal_campaign', 'list_renewal_campaigns', 'get_renewal_campaign'];
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json());
  const ops = Object.values(spec.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId);
  const tools = (await rpc('tools/list', {}, fed.token)).tools.map((x) => x.name);
  for (const nm of names) { assert.ok(ops.includes(nm), `${nm} in OpenAPI`); assert.ok(tools.includes(nm), `${nm} is an MCP tool`); }
  const viaMcp = await rpc('tools/call', { name: 'get_federation_compliance', arguments: { id: F.id } }, fed.token);
  assert.deepEqual(JSON.parse(viaMcp.content[0].text), must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: fed.token })));
  assert.equal((await rpc('tools/call', { name: 'get_federation_compliance', arguments: { id: F.id } }, outsider.token)).isError, true);
  const sql = readFileSync(new URL('../migrations/130_federation_governance_depth.sql', import.meta.url), 'utf8');
  assert.ok(!/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|ON DELETE CASCADE/i.test(sql), 'no destructive statement');
  assert.deepEqual([...sql.matchAll(/DROP CONSTRAINT[^;]*/gi)].map((m) => m[0]), ['DROP CONSTRAINT IF EXISTS fed_events_subject_type_check'], 'only the history CHECK is widened');
});
