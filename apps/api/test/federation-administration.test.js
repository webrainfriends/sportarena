// Governing body administration depth (#574, on top of #475): the compliance register, exception reviews, renewal campaigns, delegation by jurisdiction,
// least-privilege, append-only history, concurrency, REST/OpenAPI/MCP parity and the additive migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0, sport, sport2;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)))}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const day = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const signup = async () => { n++; const r = await api('POST', '/auth/register', { body: { handle: `adm_${n}`, display_name: `Adm ${n}`, email: `adm${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], phone: '+15550100' } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const body = async (owner, over = {}) => must(await api('POST', '/federation/bodies', { token: owner.token, body: { name: `Federation ${++n}`, level: 'national', abbreviation: `A${String(n).padStart(3, '0')}`, country: 'SG', sports: [{ sport_id: sport.id }], ...over } }), 201);
const club = async (owner, name = `Club ${++n}`) => must(await api('POST', '/organisations', { token: owner.token, body: { name, kind: 'club' } }), 201);
const category = async (owner, b, over = {}) => must(await api('POST', `/federation/bodies/${b.id}/affiliation-categories`, { token: owner.token, body: { name: `Full club ${++n}`, applicant_kind: 'club', ...over } }), 201);
const grant = async (owner, b, user, role, extra = {}) => must(await api('POST', `/federation/bodies/${b.id}/roles`, { token: owner.token, body: { user_id: user.id, role, ...extra } }), 201);
const decide = (u, kind, id, action, extra = {}) => api('POST', `/federation/${kind}/${id}/decision`, { token: u.token, body: { action, ...extra } });
/** A club that applies and is approved (over a failed fee requirement when `over` is given). */
const affiliate = async (owner, F, cat, over = {}) => {
  const clubOwner = await signup(); const org = await club(clubOwner);
  const aff = must(await api('POST', '/federation/affiliations', { token: clubOwner.token, body: { body_id: F.id, organisation_id: org.id, category_id: cat.id, season_year: new Date().getFullYear() } }), 201);
  must(await api('POST', `/federation/affiliations/${aff.id}/submit`, { token: clubOwner.token }));
  const ok = must(await decide(owner, 'affiliations', aff.id, 'approve', over));
  return { clubOwner, org, aff: ok };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  [sport, sport2] = await q("SELECT id, slug FROM sports WHERE slug IN ('badminton','tennis') ORDER BY slug");
});
after(async () => { server.close(); await pool.end(); });

test('compliance register: good standing, at risk and non-compliant are read live with their reasons, and only reporting staff see it', async () => {
  const owner = await signup(), outsider = await signup(), auditor = await signup(), clubber = await signup();
  const F = await body(owner);
  await grant(owner, F, auditor, 'auditor');
  const free = await category(owner, F), paid = await category(owner, F, { fee_minor: 1000, currency: 'SGD' });
  const good = await affiliate(owner, F, free);
  const risky = await affiliate(owner, F, paid, { override_reason: 'Fee will be paid at the next congress' });
  const sus = await affiliate(owner, F, free);
  must(await decide(owner, 'affiliations', sus.aff.id, 'suspend', { reason: 'Unpaid ground fees' }));
  const reg = must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: auditor.token }));
  assert.deepEqual(reg.counts, { good_standing: 1, at_risk: 1, non_compliant: 1 });
  const byLabel = Object.fromEntries(reg.items.map((x) => [x.label, x]));
  assert.deepEqual(byLabel[good.org.name].reasons, []);
  assert.deepEqual([...byLabel[risky.org.name].reasons].sort(), ['fee_due', 'open_exception']);
  assert.deepEqual(byLabel[sus.org.name].reasons, ['suspended']);
  assert.equal(reg.items[0].standing, 'non_compliant', 'the worst standing is listed first');
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: auditor.token, query: { standing: 'at_risk' } })).items.length, 1);
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: auditor.token, query: { q: good.org.name } })).total, 1);
  // an expired affiliation is read as expired without waiting for the sweep
  await pool.query("UPDATE fed_affiliations SET effective_from=current_date-400, effective_to=current_date-5 WHERE id=$1", [good.aff.id]);
  const after = must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: owner.token }));
  assert.deepEqual(after.items.find((x) => x.id === good.aff.id).reasons, ['expired']);
  assert.equal(after.counts.non_compliant, 2);
  // outsiders and clubs learn nothing
  assert.equal((await api('GET', `/federation/bodies/${F.id}/compliance`, { token: outsider.token })).status, 404);
  assert.equal((await api('GET', `/federation/bodies/${F.id}/compliance`, { token: good.clubOwner.token })).status, 404);
  assert.equal((await api('GET', `/federation/bodies/${F.id}/compliance`)).status, 401);
  void clubber;
});

test('exceptions: reviewed by compliance only, remedies need a date and are confirmed, reviews are append-only history and reopen on a new decision', async () => {
  const owner = await signup(), compliance = await signup(), auditor = await signup(), registrar = await signup();
  const F = await body(owner);
  await grant(owner, F, compliance, 'compliance'); await grant(owner, F, auditor, 'auditor'); await grant(owner, F, registrar, 'registrar');
  const paid = await category(owner, F, { fee_minor: 500, currency: 'SGD' });
  const a = await affiliate(registrar, F, paid, { override_reason: 'Paying after the season opens' });
  let list = must(await api('GET', `/federation/bodies/${F.id}/exceptions`, { token: auditor.token }));
  assert.equal(list.total, 1); assert.equal(list.items[0].state, 'unreviewed');
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/home`, { token: owner.token })).counts.exceptions, 1);
  const review = (u, over) => api('POST', `/federation/bodies/${F.id}/exceptions/review`, { token: u.token, body: { subject_type: 'affiliation', subject_id: a.aff.id, ...over } });
  // reading is not reviewing, and a registrar decides records but does not review exceptions
  assert.equal((await review(auditor, { resolution: 'accepted', note: 'fine' })).status, 403);
  assert.equal((await review(registrar, { resolution: 'accepted', note: 'fine' })).status, 403);
  assert.equal((await review(a.clubOwner, { resolution: 'accepted', note: 'fine' })).status, 404, 'the club cannot review its own exception');
  assert.equal((await review(compliance, { resolution: 'remedy_required', note: 'Pay the fee' })).status, 400, 'a remedy needs a due date');
  assert.equal((await review(compliance, { resolution: 'accepted', note: 'ok', due_on: day(5) })).status, 400, 'only a remedy has a due date');
  assert.equal((await review(compliance, { resolution: 'remedied', note: 'Paid' })).status, 409, 'nothing to confirm yet');
  must(await review(compliance, { resolution: 'remedy_required', note: 'Pay the fee', due_on: day(14) }), 201);
  assert.equal((await q("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='federation_exception_remedy'", [a.clubOwner.id]))[0].n, 1, 'the club is told what to fix and by when');
  list = must(await api('GET', `/federation/bodies/${F.id}/exceptions`, { token: auditor.token, query: { open: 'true' } }));
  assert.equal(list.items[0].state, 'remedy_required'); assert.equal(list.items[0].due_on, day(14));
  must(await review(compliance, { resolution: 'remedied', note: 'Fee received, receipt on file' }), 201);
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/exceptions`, { token: auditor.token, query: { open: 'true' } })).total, 0, 'closed exceptions leave the open list');
  const all = must(await api('GET', `/federation/bodies/${F.id}/exceptions`, { token: auditor.token }));
  assert.equal(all.items[0].state, 'remedied'); assert.equal(all.items[0].reviewer, compliance.display_name);
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/home`, { token: owner.token })).counts.exceptions, 0);
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: owner.token })).items[0].reasons.includes('open_exception'), false);
  // history keeps every step; the review table refuses edits and deletes whoever writes
  const hist = must(await api('GET', `/federation/bodies/${F.id}/history`, { token: auditor.token, query: { subject_type: 'exception' } }));
  assert.deepEqual(hist.map((e) => e.action).sort(), ['remedied', 'remedy_required']);
  await assert.rejects(pool.query("UPDATE fed_exception_reviews SET note='edited'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM fed_exception_reviews'), /append-only/);
  // a records that is not an exception on this body is not found, and nothing leaks across bodies
  const other = await body(await signup());
  assert.equal((await api('POST', `/federation/bodies/${other.id}/exceptions/review`, { token: owner.token, body: { subject_type: 'affiliation', subject_id: a.aff.id, resolution: 'accepted', note: 'nope' } })).status, 404);
  // a later decision on the same record reopens it
  await pool.query("UPDATE fed_affiliations SET decided_at = now() + interval '1 minute' WHERE id=$1", [a.aff.id]);
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/exceptions`, { token: auditor.token, query: { open: 'true' } })).total, 1);
});

test('renewal campaigns: draft preview, one send, deduplicated invitations, live outcomes, close, and least privilege', async () => {
  const owner = await signup(), registrar = await signup(), otherSport = await signup(), auditor = await signup(), outsider = await signup();
  const F = await body(owner, { sports: [{ sport_id: sport.id }, { sport_id: sport2.id }] });
  await grant(owner, F, registrar, 'registrar'); await grant(owner, F, otherSport, 'registrar', { sport_id: sport2.id }); await grant(owner, F, auditor, 'auditor');
  const cat = await category(owner, F, { sport_id: sport.id });
  const a1 = await affiliate(owner, F, cat), a2 = await affiliate(owner, F, cat);
  const ends = (await q('SELECT effective_to::text AS d FROM fed_affiliations WHERE id=$1', [a1.aff.id]))[0].d;
  const mk = (u, over = {}) => api('POST', `/federation/bodies/${F.id}/campaigns`, { token: u.token, body: { name: 'Season renewals', kind: 'affiliation', ends_from: ends, ends_to: ends, message: 'Please renew before the congress.', ...over } });
  // who may plan one
  assert.equal((await mk(auditor)).status, 403, 'reading is not running campaigns');
  assert.equal((await mk(outsider)).status, 404);
  assert.equal((await mk(otherSport)).status, 403, 'a role limited to another sport cannot invite every sport');
  assert.equal((await mk(registrar, { ends_to: day(-1000) })).status, 400);
  assert.equal((await mk(registrar, { ends_from: day(0), ends_to: day(500) })).status, 400, 'a window is at most 400 days');
  assert.equal((await mk(registrar, { sport_id: (await q("SELECT id FROM sports WHERE slug NOT IN ('badminton','tennis') LIMIT 1"))[0].id })).status, 400, 'the body must govern the sport');
  const draft = must(await mk(registrar), 201);
  assert.equal(draft.status, 'draft'); assert.equal(draft.would_invite, 2); assert.equal(draft.stats, null);
  assert.equal(must(await mk(registrar, { sport_id: sport2.id }), 201).would_invite, 0, 'another sport matches nobody here');
  // sending
  assert.equal((await api('POST', `/federation/campaigns/${draft.id}/send`, { token: auditor.token })).status, 403);
  assert.equal((await api('POST', `/federation/campaigns/${draft.id}/send`, { token: outsider.token })).status, 404);
  const [s1, s2] = await Promise.all([1, 2].map(() => api('POST', `/federation/campaigns/${draft.id}/send`, { token: registrar.token })));
  assert.deepEqual([s1.status, s2.status].sort(), [200, 409], 'a campaign is sent exactly once, even in parallel');
  const sent = (s1.status === 200 ? s1 : s2).body;
  assert.equal(sent.status, 'sent'); assert.equal(sent.invited, 2);
  assert.deepEqual(sent.stats, { invited: 2, renewed: 0, in_progress: 0, waiting: 2, lapsed: 0 });
  for (const a of [a1, a2]) assert.equal((await q("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='federation_campaign'", [a.clubOwner.id]))[0].n, 1);
  assert.equal((await q('SELECT count(*)::int AS n FROM fed_campaign_targets WHERE campaign_id=$1', [draft.id]))[0].n, 2);
  // outcomes follow the canonical renewal record
  const ren = must(await api('POST', `/federation/affiliations/${a1.aff.id}/renew`, { token: a1.clubOwner.token }), 201);
  let one = must(await api('GET', `/federation/campaigns/${draft.id}`, { token: auditor.token }));
  assert.deepEqual(one.stats, { invited: 2, renewed: 0, in_progress: 1, waiting: 1, lapsed: 0 });
  must(await api('POST', `/federation/affiliations/${ren.id}/submit`, { token: a1.clubOwner.token }));
  must(await decide(owner, 'affiliations', ren.id, 'approve'));
  await pool.query("UPDATE fed_affiliations SET effective_from=current_date-400, effective_to=current_date-2 WHERE id=$1", [a2.aff.id]);
  one = must(await api('GET', `/federation/campaigns/${draft.id}`, { token: auditor.token }));
  assert.deepEqual(one.stats, { invited: 2, renewed: 1, in_progress: 0, waiting: 0, lapsed: 1 });
  assert.deepEqual(one.items.map((x) => x.outcome).sort(), ['lapsed', 'renewed']);
  assert.equal(must(await api('GET', `/federation/campaigns/${draft.id}`, { token: auditor.token, query: { outcome: 'renewed' } })).items.length, 1);
  // a second campaign never re-invites a record that is already renewing
  const again = must(await mk(registrar, { name: 'Second wave', ends_from: day(-30), ends_to: day(300) }), 201);
  assert.equal(again.would_invite, 1, 'only the lapsed record is invited: the renewed one is already renewing');
  const empty = must(await mk(registrar, { name: 'Nobody', ends_from: day(900), ends_to: day(950) }), 201);
  assert.equal(empty.would_invite, 0);
  assert.equal((await api('POST', `/federation/campaigns/${empty.id}/send`, { token: registrar.token })).status, 400, 'an empty campaign is not sent');
  // reading and closing
  const list = must(await api('GET', `/federation/bodies/${F.id}/campaigns`, { token: auditor.token }));
  assert.equal(list.total, 4); assert.equal(list.can_manage, false);
  assert.equal(must(await api('GET', `/federation/bodies/${F.id}/campaigns`, { token: registrar.token })).can_manage, true);
  assert.equal((await api('GET', `/federation/bodies/${F.id}/campaigns`, { token: outsider.token })).status, 404);
  assert.equal((await api('GET', `/federation/campaigns/${draft.id}`, { token: outsider.token })).status, 404);
  assert.equal((await api('POST', `/federation/campaigns/${draft.id}/close`, { token: auditor.token })).status, 403);
  assert.equal(must(await api('POST', `/federation/campaigns/${draft.id}/close`, { token: registrar.token })).status, 'closed');
  assert.equal((await api('POST', `/federation/campaigns/${draft.id}/close`, { token: registrar.token })).status, 409);
  assert.equal((await api('POST', `/federation/campaigns/${draft.id}/send`, { token: registrar.token })).status, 409, 'a closed campaign is not sent again');
  const hist = must(await api('GET', `/federation/bodies/${F.id}/history`, { token: auditor.token, query: { subject_type: 'campaign' } }));
  assert.ok(['created', 'sent', 'closed'].every((a) => hist.some((e) => e.action === a)));
});

test('licence campaigns invite the holder and the guardian-applicant and read outcomes from the renewal', async () => {
  const owner = await signup(), licensing = await signup(), athlete = await signup();
  const F = await body(owner);
  await grant(owner, F, licensing, 'licensing');
  const t = must(await api('POST', `/federation/bodies/${F.id}/licence-types`, { token: licensing.token, body: { name: 'Senior player', holder_role: 'athlete', sport_id: sport.id, grade: 'Senior', duration_months: 12 } }), 201);
  const lic = must(await api('POST', '/federation/licences', { token: athlete.token, body: { body_id: F.id, type_id: t.id } }), 201);
  must(await api('POST', `/federation/licences/${lic.id}/submit`, { token: athlete.token }));
  const live = must(await decide(licensing, 'licences', lic.id, 'approve'));
  const ends = (await q('SELECT expires_on::text AS d FROM fed_licences WHERE id=$1', [live.id]))[0].d;
  const camp = must(await api('POST', `/federation/bodies/${F.id}/campaigns`, { token: licensing.token, body: { name: 'Licence renewals', kind: 'licence', ends_from: ends, ends_to: ends } }), 201);
  assert.equal(camp.would_invite, 1);
  assert.equal((await api('POST', `/federation/bodies/${F.id}/campaigns`, { token: (await (async () => { const r = await signup(); await grant(owner, F, r, 'registrar'); return r; })()).token, body: { name: 'Nope', kind: 'licence', ends_from: ends, ends_to: ends } })).status, 403, 'a registrar does not run licence campaigns');
  const sent = must(await api('POST', `/federation/campaigns/${camp.id}/send`, { token: licensing.token }));
  assert.equal(sent.invited, 1);
  assert.equal((await q("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='federation_campaign'", [athlete.id]))[0].n, 1);
  assert.deepEqual(must(await api('GET', `/federation/campaigns/${camp.id}`, { token: licensing.token })).stats, { invited: 1, renewed: 0, in_progress: 0, waiting: 1, lapsed: 0 });
  const reg = must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: owner.token, query: { kind: 'licence' } }));
  assert.equal(reg.counts.at_risk + reg.counts.good_standing, 1);
});

test('delegation by jurisdiction: a cascading role works on the bodies beneath, within its sport, and ends the moment it is revoked', async () => {
  const nat = await signup(), reg = await signup(), registrar = await signup(), plain = await signup(), tennisOnly = await signup();
  const N = await body(nat, { sports: [{ sport_id: sport.id }, { sport_id: sport2.id }] });
  const R = await body(reg, { level: 'regional', abbreviation: `R${String(++n).padStart(3, '0')}`, sports: [{ sport_id: sport.id }, { sport_id: sport2.id }] });
  const link = must(await api('POST', '/federation/links', { token: reg.token, body: { parent_id: N.id, child_id: R.id } }), 201);
  must(await api('POST', `/federation/links/${link.id}/respond`, { token: nat.token, body: { decision: 'recognise' } }));
  const cat = await category(reg, R, { sport_id: sport.id });
  assert.equal((await api('POST', `/federation/bodies/${N.id}/roles`, { token: nat.token, body: { user_id: registrar.id, role: 'integrity', cascades: true } })).status, 400, 'integrity is per body');
  const g = await grant(nat, N, registrar, 'registrar', { cascades: true });
  await grant(nat, N, plain, 'registrar');
  await grant(nat, N, tennisOnly, 'registrar', { sport_id: sport2.id, cascades: true });
  const clubOwner = await signup(); const org = await club(clubOwner);
  const aff = must(await api('POST', '/federation/affiliations', { token: clubOwner.token, body: { body_id: R.id, organisation_id: org.id, category_id: cat.id, season_year: new Date().getFullYear() } }), 201);
  must(await api('POST', `/federation/affiliations/${aff.id}/submit`, { token: clubOwner.token }));
  // the national registrar without a cascade can see the region but not decide there; the delegated one can
  assert.equal((await decide(plain, 'affiliations', aff.id, 'start_review')).status, 403);
  assert.equal((await decide(tennisOnly, 'affiliations', aff.id, 'start_review')).status, 403, 'delegation keeps the sport limit');
  assert.equal(must(await api('GET', `/federation/bodies/${R.id}/home`, { token: registrar.token })).me.can.affiliations, true);
  assert.equal(must(await api('GET', `/federation/bodies/${R.id}/home`, { token: plain.token })).me.can.affiliations, false);
  assert.equal(must(await decide(registrar, 'affiliations', aff.id, 'approve')).status, 'approved');
  assert.match(String(must(await api('GET', `/federation/affiliations/${aff.id}`, { token: registrar.token })).history.at(-1).actor_name ?? ''), /Adm/);
  // the delegation is one-way and narrow: not upward, not sideways, and no finance/private data door opens
  assert.equal((await api('GET', `/federation/bodies/${N.id}/roles`, { token: registrar.token })).status, 200, 'staff of N, as before');
  assert.equal((await api('POST', `/federation/bodies/${R.id}/roles`, { token: registrar.token, body: { user_id: plain.id, role: 'auditor' } })).status, 403, 'a delegated registrar does not grant roles');
  const sibling = await body(await signup(), { level: 'regional', abbreviation: `S${String(++n).padStart(3, '0')}` });
  assert.equal((await api('GET', `/federation/bodies/${sibling.id}/home`, { token: registrar.token })).status, 404, 'a body outside the hierarchy stays invisible');
  assert.equal((await api('GET', `/organisations/${org.id}/members`, { token: registrar.token })).status === 200, false, 'governing a sport does not open a club\'s private pages');
  // recognition ended or role revoked: access stops at once, history is kept
  must(await api('DELETE', `/federation/bodies/${N.id}/roles/${g.id}`, { token: nat.token }));
  const after = await api('GET', `/federation/bodies/${R.id}/home`, { token: registrar.token });
  assert.equal(after.status === 404, true, 'revoked: the region is invisible again');
  const roles = must(await api('GET', `/federation/bodies/${N.id}/roles`, { token: nat.token }));
  assert.ok(roles.roles.some((r) => r.cascades) && !roles.roles.some((r) => r.role_id === g.id));
  assert.ok((await q("SELECT 1 FROM fed_events WHERE subject_type='role' AND subject_id=$1 AND action='revoked'", [g.id])).length === 1);
  await pool.query("UPDATE governing_body_links SET status='ended', effective_to=current_date WHERE id=$1", [link.id]);
  assert.equal((await api('GET', `/federation/bodies/${R.id}/home`, { token: tennisOnly.token })).status, 404, 'when recognition ends, so does the delegation');
});

test('REST, OpenAPI and MCP expose the administration capabilities with the same permissions, and the migration is additive', async () => {
  const fed = await signup(), outsider = await signup();
  const F = await body(fed);
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  const ops = Object.values(spec.paths).flatMap((p) => Object.values(p)).filter((o) => o.tags?.includes('Federation')).map((o) => o.operationId);
  const tools = (await rpc('tools/list', {}, fed.token)).tools.map((x) => x.name);
  for (const name of ['get_compliance_register', 'list_compliance_exceptions', 'review_compliance_exception', 'create_renewal_campaign', 'send_renewal_campaign', 'close_renewal_campaign', 'list_renewal_campaigns', 'get_renewal_campaign']) {
    assert.ok(ops.includes(name), `${name} is in OpenAPI`); assert.ok(tools.includes(name), `${name} is an MCP tool`);
  }
  const viaMcp = await rpc('tools/call', { name: 'get_compliance_register', arguments: { id: F.id } }, fed.token);
  const viaRest = must(await api('GET', `/federation/bodies/${F.id}/compliance`, { token: fed.token }));
  assert.deepEqual(JSON.parse(viaMcp.content[0].text), viaRest);
  const denied = await rpc('tools/call', { name: 'get_compliance_register', arguments: { id: F.id } }, outsider.token);
  assert.equal(denied.isError, true, 'the same refusal through MCP');
  const sql = readFileSync(new URL('../migrations/125_federation_administration.sql', import.meta.url), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.ok(!/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|ON DELETE CASCADE/i.test(code), 'no destructive statement');
  assert.deepEqual([...code.matchAll(/DROP CONSTRAINT[^;]*/gi)].map((m) => m[0]), ['DROP CONSTRAINT IF EXISTS fed_events_subject_type_check'], 'only the history subject list is widened');
  await migrate();
  assert.equal((await q('SELECT count(*)::int AS n FROM fed_events'))[0].n >= 0, true);
});
