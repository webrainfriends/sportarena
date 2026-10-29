import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Sports agent & player representation (#484), against a real Postgres: identity and verification, the versioned mandate, live access and revocation,
// #333 contract participation, opportunity approvals, commission, conflicts, youth, history and the public profile.
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/capabilities/index.js');
const { targetFor } = await import('../src/representation.js');

let server, base, n = 0, admin, admin2, football, cricket;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const reason = (r) => r.body.error?.details?.reason ?? r.body.details?.reason;
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const key = () => `k-${++n}-${Math.random().toString(36).slice(2, 10)}`;
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `rp_${n}_${roles[0]}`, display_name: `Rep ${n}`, email: `rp${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const mk = async (h) => { const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ($1,$1,'{admin}','x','x',$1) RETURNING id", [h])).rows[0]; return { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) }; };
  admin = await mk('rp_root'); admin2 = await mk('rp_root2');
  football = (await q("SELECT id FROM sports WHERE slug='football'"))[0].id;
  cricket = (await q("SELECT id FROM sports WHERE slug='cricket'"))[0]?.id ?? (await q("SELECT id FROM sports WHERE slug <> 'football' ORDER BY slug LIMIT 1"))[0].id;
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// ------------------------------------------------------------------ helpers
const CHECKLIST = [
  { key: 'identity_matches', ok: true, note: 'Photo and name match the account' }, { key: 'evidence_authentic', ok: true },
  { key: 'standing_checked', ok: true, note: 'Registration looked up on the issuer\'s public register; no disciplinary record was checked' }, { key: 'scope_recorded', ok: true }, { key: 'authorised_to_act', ok: true },
];
const verify = (u, { days = 300 } = {}) => q("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at, checklist) VALUES ('agent','user',$1,$1,'approved',1,now(), now() + ($2 || ' days')::interval, $3) RETURNING id", [u.id, String(days), JSON.stringify(CHECKLIST)]).then((r) => r[0].id);
const profile = async (u, o = {}) => must(await api('POST', '/agents/me', { token: u.token, body: { display_name: `Agent ${u.handle}`, sport_ids: [football], markets: ['IN', 'GB'], is_public: true, ...o } }), 201);
/** An agent with a profile, a verified badge and a declared licence that the review covered. */
async function agent({ licence = true, verified = true } = {}) {
  const u = await signup(['agent']);
  const p = await profile(u);
  let lic = null;
  if (licence) lic = must(await api('POST', '/agents/me/licences', { token: u.token, body: { issuing_body: 'National Football Association', grade: 'Licensed agent', jurisdiction: 'GB', sport_id: football, reference: 'FA-2026-77421', valid_from: day(-100), valid_to: day(400) } }), 201);
  if (verified) { const id = await verify(u); if (lic) await q("UPDATE agent_licences SET verified_case_id=$2, verified_at=now() WHERE id=$1", [lic.id, id]); }
  return { ...u, profile: p, licence: lic };
}
const commission = (o = {}) => ({ key: 'main', applies_to: ['player_contract'], basis: 'percentage', rate_bp: 1000, calc_on: 'earned', currency: 'INR', effective_from: day(-20), effective_to: day(300), ...o });
const terms = (o = {}) => ({
  sport_ids: [football], territories: ['IN', 'GB'], purposes: ['opportunity_outreach', 'contract_negotiation', 'sponsorship_commercial'], exclusive: false, starts_on: day(-20), ends_on: day(330), notice_days: 30, notice_terms_ref: 'Schedule 2 clause 9',
  data_access: ['public_passport', 'recruitment_materials', 'opportunity_applications', 'contract_workflow', 'sponsorship_discussions'], contact_actions: ['share_opportunities', 'express_interest', 'draft_applications', 'manage_conversations', 'track_pipeline'], allow_staff: false,
  commission: [commission()], ...o,
});
/** An athlete asks an agent to represent them; both sign. Returns the mandate view. */
async function mandate(a, ag, o = {}) {
  const t = terms(o.terms ?? {});
  const m = must(await api('POST', '/representation/mandates', { token: a.token, body: { agent_id: ag.profile.id, terms: t, send: true, client_key: key() } }), 201);
  assert.equal(m.status, 'proposed');
  const done = must(await api('POST', `/representation/mandates/${m.id}/versions/1/decision`, { token: ag.token, body: { decision: 'sign' } }));
  assert.equal(done.status, 'active');
  return done;
}
const grant = (a, m, subject_type, subject_id, level = 'view') => api('POST', `/representation/mandates/${m.id}/grants`, { token: a.token, body: { subject_type, subject_id, level } });

/** A club with a player who has an accepted paid opportunity, a signed contract and the athlete's ledger accrued (a fixed fee of 250,000 was earned). */
async function club() {
  const owner = await signup(['coach']), manager = await signup(['athlete']), player = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: `Strikers ${++n}`, sport: 'football', currency: 'INR' } }), 201);
  must(await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: manager.id } }), 201);
  must(await api('PATCH', `/teams/${team.id}/members/${manager.id}`, { token: owner.token, body: { role: 'manager' } }));
  const post = must(await api('POST', '/billboard', { token: owner.token, body: { title: `Striker wanted ${++n}`, sport: 'football', kind: 'assignment', opportunity_type: 'paid_assignment', team_id: team.id, budget_cents: 250000, currency: 'INR', positions_needed: 3, ends_at: new Date(Date.now() + 864e6).toISOString() } }), 201);
  const resp = must(await api('POST', `/billboard/${post.id}/responses`, { token: player.token, body: { message: 'Pick me' } }), 201);
  must(await api('PATCH', `/billboard/responses/${resp.id}`, { token: owner.token, body: { status: 'accepted' } }));
  return { owner, manager, player, team, resp, post };
}
const contractTerms = (o = {}) => ({ starts_on: day(-40), ends_on: day(60), currency: 'INR', expected_games: 10, withholding_bp: 1000, expense_cap_cents: 200000, pay_terms_days: 7, components: [{ kind: 'appearance_fee', amount_cents: 400000 }, { kind: 'fixed', label: 'Signing match fee', amount_cents: 250000, due_on: day(-5) }], ...o });
async function signedContract(c, o = {}) {
  const k = must(await api('POST', '/player-contracts', { token: c.owner.token, body: { team_id: c.team.id, response_id: c.resp.id, title: 'Season contract', terms: contractTerms(o), send: true, client_key: key() } }), 201);
  const s = must(await api('POST', `/contract-versions/${k.pending.id}/decision`, { token: c.player.token, body: { decision: 'sign' } }));
  assert.equal(s.status, 'active');
  return s;
}

// ------------------------------------------------------------------ 1. identity
test('agent identity: profile, masked licence, what verification actually checked, directory and suspension', async () => {
  const u = await signup(['athlete']);
  assert.equal((await api('GET', '/agents/me', { token: u.token })).body.profile, null);
  const matrix = must(await api('GET', '/representation/matrix'));
  assert.ok(matrix.never_shared.some((s) => /Medical/.test(s)));
  assert.ok(matrix.athlete_only.some((s) => /sign a contract/.test(s)));
  assert.ok(Object.keys(matrix.purposes).includes('transfer_assistance'));

  const p = await profile(u);
  assert.ok((await q('SELECT roles FROM users WHERE id=$1', [u.id]))[0].roles.includes('agent'), 'creating a profile adds the agent role');
  assert.equal(p.verification.verified, false);
  // a role or a profile alone grants nothing: no athlete is reachable
  const other = await signup();
  assert.equal((await api('GET', '/representation/mandates', { token: u.token, query: { as: 'athlete', athlete_id: other.id } })).status, 404);
  // updates need the current row_version
  const upd = must(await api('POST', '/agents/me', { token: u.token, body: { display_name: 'Agent Renamed', sport_ids: [football], markets: ['IN'], is_public: false, row_version: p.row_version } }), 201);
  assert.equal(upd.display_name, 'Agent Renamed');
  assert.equal(code(await api('POST', '/agents/me', { token: u.token, body: { display_name: 'x1', row_version: p.row_version } })), 'stale_version');

  // licence: the reference is encrypted and masked; it is only a declaration until a review covers it
  const lic = must(await api('POST', '/agents/me/licences', { token: u.token, body: { issuing_body: 'National Football Association', grade: 'Licensed agent', jurisdiction: 'GB', reference: 'FA-2026-77421', valid_from: day(-10), valid_to: day(200) } }), 201);
  assert.equal(lic.reference_last4, '7421'); assert.equal(lic.standing, 'declared');
  const raw = (await q('SELECT reference_enc FROM agent_licences WHERE id=$1', [lic.id]))[0].reference_enc;
  assert.ok(raw && !raw.includes('FA-2026'), 'the licence reference is stored encrypted');
  assert.equal((await api('POST', '/agents/me/licences', { token: u.token, body: { issuing_body: 'Body', jurisdiction: 'GB', valid_from: day(5), valid_to: day(1) } })).status, 400);

  // verification: the platform's own review; it states what was checked and covers the licences declared at the time
  const ev = await api('POST', '/verification/cases', { token: u.token, body: { type: 'agent', claim_note: 'Licensed in England', evidence: [{ kind: 'id_document', reference: 'ID-77421-X' }, { kind: 'agent_licence', reference: 'FA-2026-77421' }] } });
  const vc = must(ev, 201);
  must(await api('POST', `/admin/verification/cases/${vc.id}/claim`, { token: admin.token }));
  const queue = must(await api('GET', `/verification/cases/${vc.id}`, { token: admin.token }));
  assert.equal(queue.agent_declaration.licences[0].reference_last4, '7421', 'the reviewer sees the declared registration');
  assert.equal(queue.checklist_template.some((c) => c.key === 'standing_checked'), true);
  assert.equal((await api('POST', `/admin/verification/cases/${vc.id}/decision`, { token: admin.token, body: { decision: 'approve', checklist: [{ key: 'identity_matches', ok: true }] } })).status, 400, 'every item must be ticked');
  must(await api('POST', `/admin/verification/cases/${vc.id}/decision`, { token: admin.token, body: { decision: 'approve', checklist: CHECKLIST } }));
  const me = must(await api('GET', '/agents/me', { token: u.token })).profile;
  assert.equal(me.verification.verified, true);
  assert.ok(me.verification.checked.some((c) => /public register/.test(c.note ?? '')), 'what was checked is stated');
  assert.match(me.verification.statement, /not a statement that the agent is licensed everywhere/);
  assert.equal(me.licences[0].standing, 'verified');
  // an expired validity date shows as expired, never as verified
  await q("UPDATE agent_licences SET valid_to=current_date - 1 WHERE id=$1", [lic.id]);
  assert.equal(must(await api('GET', '/agents/me', { token: u.token })).profile.licences[0].standing, 'expired');
  await q("UPDATE agent_licences SET valid_to=current_date + 200 WHERE id=$1", [lic.id]);

  // directory: listed + verified only, and listing is the agent's choice
  must(await api('POST', '/agents/me', { token: u.token, body: { display_name: 'Agent Renamed', sport_ids: [football], markets: ['IN'], is_public: true, row_version: upd.row_version } }), 201);
  const finder = await signup();
  const found = must(await api('GET', '/agents', { token: finder.token, query: { sport_id: football, market: 'IN' } }));
  assert.ok(found.some((a) => a.id === p.id));
  assert.equal(found.find((a) => a.id === p.id).licences[0].reference_last4, '7421');
  assert.equal(JSON.stringify(found).includes('FA-2026-77421'), false, 'the full reference is never shown');
  const unlisted = await agent(); await q('UPDATE agent_profiles SET is_public=false WHERE id=$1', [unlisted.profile.id]);
  assert.equal((await api('GET', `/agents/${unlisted.profile.id}`, { token: finder.token })).status, 404, 'an unlisted profile is invisible to strangers');
  const noBadge = await agent({ verified: false });
  assert.ok(!must(await api('GET', '/agents', { token: finder.token })).some((a) => a.id === noBadge.profile.id), 'unverified agents are not listed');

  // suspension is a platform decision with a reason; another team member decides about your own profile
  assert.equal((await api('POST', `/admin/agents/${p.id}/suspension`, { token: finder.token, body: { suspended: true, reason: 'x' } })).status, 403);
  assert.equal((await api('POST', `/admin/agents/${p.id}/suspension`, { token: admin.token, body: { suspended: true } })).status, 400);
  must(await api('POST', `/admin/agents/${p.id}/suspension`, { token: admin.token, body: { suspended: true, reason: 'Complaint under review' } }));
  assert.ok(!must(await api('GET', '/agents', { token: finder.token })).some((a) => a.id === p.id), 'a suspended agent leaves the directory');
  must(await api('POST', `/admin/agents/${p.id}/suspension`, { token: admin.token, body: { suspended: false } }));
});

test('agency profile: only an organisation owner or admin creates it; staff must belong to it and cannot be clients', async () => {
  const owner = await signup(['agent']), member = await signup(['athlete']), outsider = await signup(['agent']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Agency Co ${n}`, kind: 'other' } }), 201);
  assert.equal((await api('POST', '/agents/me', { token: outsider.token, body: { kind: 'agency', organisation_id: org.id, display_name: 'Not mine', sport_ids: [], markets: [] } })).status, 403);
  const ag = must(await api('POST', '/agents/me', { token: owner.token, body: { kind: 'agency', organisation_id: org.id, display_name: 'Agency Co', sport_ids: [football], markets: ['WW'], is_public: true } }), 201);
  assert.equal(ag.kind, 'agency');
  assert.equal((await api('POST', '/agents/me/staff', { token: owner.token, body: { user_id: member.id, permissions: ['view'] } })).status, 400, 'not a member of the organisation');
  await q("INSERT INTO organisation_members(organisation_id, user_id, role, status, invited_by) VALUES ($1,$2,'coach','active',$3)", [org.id, member.id, owner.id]).catch(async () => q("INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,'coach','active')", [org.id, member.id]));
  const st = must(await api('POST', '/agents/me/staff', { token: owner.token, body: { user_id: member.id, permissions: ['view', 'outreach'] } }), 201);
  assert.deepEqual(st.permissions.sort(), ['outreach', 'view']);
  assert.equal((await api('POST', '/agents/me/staff', { token: owner.token, body: { user_id: owner.id } })).status, 400);
  const solo = await signup(['agent']); await profile(solo);
  assert.equal((await api('POST', '/agents/me/staff', { token: solo.token, body: { user_id: member.id } })).status, 400, 'only an agency has staff');
  must(await api('DELETE', `/agents/me/staff/${st.id}`, { token: owner.token }));
  assert.equal(must(await api('GET', '/agents/me', { token: member.token })).works_for.length, 0);
});

// ------------------------------------------------------------------ 2. mandate
test('mandate: versioned, signed by every required party, frozen once proposed, amended by a new signed version', async () => {
  const a = await signup(), ag = await agent();
  const bad = (t, re) => api('POST', '/representation/mandates', { token: a.token, body: { agent_id: ag.profile.id, terms: t } }).then((r) => { assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(JSON.stringify(r.body), re); });
  await bad(terms({ data_access: ['public_passport', 'medical_records'] }), /data_access/); // nothing outside the published categories can even be named
  await bad(terms({ data_access: ['public_passport'] }), /needs/);                              // contract purpose without contract access
  await bad(terms({ purposes: ['opportunity_outreach'], contact_actions: [] }), /allowed action/);
  await bad(terms({ territories: ['WW', 'IN'] }), /Worldwide/);
  await bad(terms({ ends_on: day(-30) }), /cannot end before/);
  await bad(terms({ commission: [commission({ effective_to: day(900) })] }), /inside the mandate period/);
  await bad(terms({ commission: [commission({ applies_to: ['sponsorship'] })], purposes: ['opportunity_outreach', 'contract_negotiation'], data_access: ['contract_workflow', 'public_passport', 'opportunity_applications'] }), /sponsorship/);
  await bad(terms({ licence_id: '00000000-0000-4000-8000-000000000000' }), /declared licences/);
  await bad(terms({ starts_on: day(0), ends_on: day(366 * 6) }), /five years/);
  assert.equal((await api('POST', '/representation/mandates', { token: ag.token, body: { terms: terms() } })).status, 400, 'an agent names the athlete; without one they are just an athlete asking for an agent');
  assert.equal((await api('POST', '/representation/mandates', { token: a.token, body: { agent_id: a.id, terms: terms() } })).status, 404);

  const c1 = key();
  const draft = must(await api('POST', '/representation/mandates', { token: a.token, body: { agent_id: ag.profile.id, terms: terms(), client_key: c1 } }), 201);
  assert.equal(draft.status, 'draft'); assert.match(draft.mandate_no, /^REP-\d{4}-\d{4}$/);
  assert.equal(must(await api('POST', '/representation/mandates', { token: a.token, body: { agent_id: ag.profile.id, terms: terms(), client_key: c1 } }), 201).id, draft.id, 'a retry with the same key is the same mandate');
  assert.equal((await api('GET', `/representation/mandates/${draft.id}`, { token: ag.token })).status, 404, 'a draft belongs to its writer');
  assert.equal((await api('GET', `/representation/mandates/${draft.id}`, { token: (await signup()).token })).status, 404);
  const upd = must(await api('PATCH', `/representation/mandates/${draft.id}`, { token: a.token, body: { row_version: draft.row_version, terms: terms({ notice_days: 45 }) } }));
  assert.equal(upd.versions[0].notice_days, 45);
  assert.equal(code(await api('PATCH', `/representation/mandates/${draft.id}`, { token: a.token, body: { row_version: draft.row_version, terms: terms() } })), 'stale_version');
  const sent = must(await api('POST', `/representation/mandates/${draft.id}/send`, { token: a.token, body: { row_version: upd.row_version } }));
  assert.equal(sent.status, 'proposed'); assert.deepEqual(sent.pending.waiting_for, ['agent']);
  assert.equal(code(await api('POST', `/representation/mandates/${draft.id}/send`, { token: a.token, body: { row_version: upd.row_version } })), 'not_draft');
  assert.equal((await q('UPDATE representation_mandate_versions SET ends_on = ends_on + 1 WHERE mandate_id=$1', [draft.id]).catch((e) => e.code)), '23514', 'a proposed version is frozen in the database too');
  assert.equal(must(await api('GET', `/representation/mandates/${draft.id}`, { token: ag.token })).needs_my_signature, true);

  // nobody signs for someone else
  assert.equal(must(await api('POST', `/representation/mandates/${draft.id}/versions/1/decision`, { token: a.token, body: { decision: 'sign' } })).status, 'proposed', 'the athlete signing again cannot sign for the agent');
  const stranger = await agent();
  assert.equal((await api('POST', `/representation/mandates/${draft.id}/versions/1/decision`, { token: stranger.token, body: { decision: 'sign' } })).status, 404);
  const live = must(await api('POST', `/representation/mandates/${draft.id}/versions/1/decision`, { token: ag.token, body: { decision: 'sign', comment: 'Agreed' } }));
  assert.equal(live.status, 'active'); assert.equal(live.live, true); assert.equal(live.current.version, 1);
  assert.equal(must(await api('POST', `/representation/mandates/${draft.id}/versions/1/decision`, { token: ag.token, body: { decision: 'sign' } })).status, 'active', 'repeating a signature changes nothing');
  assert.equal((await q('SELECT count(*)::int AS n FROM representation_signatures WHERE version_id=$1', [live.current.id]))[0].n, 2);

  // an amendment is a new version; until both sign, the version in force is untouched
  assert.equal(code(await api('POST', `/representation/mandates/${draft.id}/versions`, { token: a.token, body: { kind: 'amendment', base_version: 9, terms: terms() } })), 'stale_version');
  const am = must(await api('POST', `/representation/mandates/${draft.id}/versions`, { token: a.token, body: { kind: 'amendment', base_version: 1, terms: terms({ exclusive: true, data_access: ['public_passport', 'contract_workflow'], purposes: ['contract_negotiation'], contact_actions: [], commission: [commission({ rate_bp: 800 })] }), reason: 'Narrow it to contracts' } }), 201);
  assert.equal(am.pending.version, 2); assert.equal(am.current.version, 1);
  assert.ok(am.pending.changes.some((c) => c.field === 'exclusive'), 'the change is shown field by field');
  assert.ok(am.pending.changes.some((c) => c.field === 'commission:main'));
  assert.equal(code(await api('POST', `/representation/mandates/${draft.id}/versions`, { token: a.token, body: { kind: 'amendment', base_version: 1, terms: terms() } })), 'pending_exists');
  const back = must(await api('POST', `/representation/mandates/${draft.id}/versions/2/withdraw`, { token: a.token }));
  assert.equal(back.status, 'active'); assert.equal(back.current.version, 1);
  const am2 = must(await api('POST', `/representation/mandates/${draft.id}/versions`, { token: ag.token, body: { kind: 'amendment', base_version: 1, terms: terms({ notice_days: 60 }) } }), 201);
  assert.equal(am2.pending.version, 3); assert.deepEqual(am2.pending.waiting_for, ['athlete']);
  const v3 = must(await api('POST', `/representation/mandates/${draft.id}/versions/3/decision`, { token: a.token, body: { decision: 'sign' } }));
  assert.equal(v3.current.version, 3); assert.equal(v3.versions.find((v) => v.version === 1).status, 'superseded');
  // a declined version never replaces the one in force
  const am3 = must(await api('POST', `/representation/mandates/${draft.id}/versions`, { token: ag.token, body: { kind: 'amendment', base_version: 3, terms: terms({ notice_days: 90 }) } }), 201);
  const dec = must(await api('POST', `/representation/mandates/${draft.id}/versions/${am3.pending.version}/decision`, { token: a.token, body: { decision: 'decline', comment: 'No' } }));
  assert.equal(dec.current.version, 3); assert.equal(dec.status, 'active');

  // the document is built from the frozen version and is stable
  const d1 = must(await api('GET', `/representation/mandates/${draft.id}/document`, { token: a.token, query: { version: 3 } }));
  const d2 = must(await api('GET', `/representation/mandates/${draft.id}/document`, { token: ag.token, query: { version: 3 } }));
  assert.equal(d1.sha256, d2.sha256); assert.match(d1.text, /Never available under any mandate: medical/); assert.match(d1.text, /Never done by the agent: accepting a position/);
  assert.equal((await api('GET', `/representation/mandates/${draft.id}/document`, { token: (await signup()).token })).status, 404);
  // history is append-only
  assert.equal((await q('UPDATE representation_events SET action=$2 WHERE mandate_id=$1', [draft.id, 'x1']).catch((e) => e.code)), '23514');
  assert.ok(dec.events.some((e) => e.action === 'mandate_active') && dec.events.some((e) => e.action === 'version_declined'));
});

test('an unverified, suspended or lapsed agent cannot be agreed with or used; an expired mandate renews by a new signed version', async () => {
  const a = await signup(), unver = await agent({ verified: false });
  const m = must(await api('POST', '/representation/mandates', { token: a.token, body: { agent_id: unver.profile.id, terms: terms() } }), 201);
  assert.equal(code(await api('POST', `/representation/mandates/${m.id}/send`, { token: a.token, body: { row_version: m.row_version } })), 'agent_unverified');

  const ag = await agent();
  const live = await mandate(a, ag);
  assert.equal(live.live, true);
  // verification expiry, suspension and a licence relied on all stop access at once, and resume when fixed
  const lic = ag.licence.id;
  const reliant = await mandate(await signup(), ag, { terms: { licence_id: lic } });
  assert.equal(reliant.live, true);
  const state = async (mm, u) => must(await api('GET', `/representation/mandates/${mm.id}`, { token: u.token }));
  await q("UPDATE agent_licences SET valid_to=current_date - 1 WHERE id=$1", [lic]);
  const lapsed = await state(reliant, ag);
  assert.equal(lapsed.live, false); assert.equal(lapsed.not_live_reason, 'licence_lapsed');
  assert.equal((await state(live, ag)).live, true, 'a mandate that does not rely on that licence is unaffected');
  await q("UPDATE agent_licences SET valid_to=current_date + 100 WHERE id=$1", [lic]);
  await q("UPDATE verification_cases SET expires_at = now() - interval '1 day' WHERE subject_id=$1 AND type='agent'", [ag.id]);
  assert.equal((await state(live, ag)).not_live_reason, 'agent_unverified');
  assert.equal((await api('GET', `/representation/mandates/${live.id}/athlete`, { token: ag.token })).status, 403);
  await q("UPDATE verification_cases SET expires_at = now() + interval '100 days' WHERE subject_id=$1 AND type='agent'", [ag.id]);
  must(await api('POST', `/admin/agents/${ag.profile.id}/suspension`, { token: admin.token, body: { suspended: true, reason: 'Investigation' } }));
  assert.equal((await state(live, a)).not_live_reason, 'agent_suspended');
  assert.equal(code(await api('GET', `/representation/mandates/${live.id}/athlete`, { token: ag.token })), 'mandate_not_live');
  must(await api('POST', `/admin/agents/${ag.profile.id}/suspension`, { token: admin.token, body: { suspended: false } }));
  assert.equal((await state(live, a)).live, true);

  // expiry: the worker marks it, but the live check never waited for the worker
  await q('ALTER TABLE representation_mandate_versions DISABLE TRIGGER representation_versions_frozen');
  await q("UPDATE representation_mandate_versions SET starts_on = current_date - 60, ends_on = current_date - 1 WHERE mandate_id=$1", [live.id]);
  await q('ALTER TABLE representation_mandate_versions ENABLE TRIGGER representation_versions_frozen');
  assert.equal(code(await api('GET', `/representation/mandates/${live.id}/athlete`, { token: ag.token })), 'mandate_not_live');
  const { runRepresentationSweeps } = await import('../src/representation.js');
  await runRepresentationSweeps();
  assert.equal((await state(live, a)).status, 'expired');
  // renewal is a new signed version; the history of the first stays
  const old = (await state(live, a)).current;
  const ren = must(await api('POST', `/representation/mandates/${live.id}/versions`, { token: a.token, body: { kind: 'renewal', base_version: 1, terms: terms({ starts_on: day(0), ends_on: day(365), commission: [commission({ effective_from: day(0), effective_to: day(365) })] }) } }), 201);
  assert.equal(ren.status, 'expired', 'still expired until the agent signs');
  assert.equal((await api('POST', `/representation/mandates/${live.id}/versions`, { token: a.token, body: { kind: 'renewal', base_version: 1, terms: terms({ ends_on: day(5) }) } })).status, 409);
  const back = must(await api('POST', `/representation/mandates/${live.id}/versions/${ren.pending.version}/decision`, { token: ag.token, body: { decision: 'sign' } }));
  assert.equal(back.status, 'active'); assert.equal(back.live, true); assert.equal(back.versions.length, 2); assert.equal(old.version, 1);
});

// ------------------------------------------------------------------ 3. access is explicit, item by item, and live
async function agency({ perms = ['view'] } = {}) {
  const owner = await signup(['agent']), staff = await signup(['athlete']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Agency ${++n}`, kind: 'other' } }), 201);
  const p = must(await api('POST', '/agents/me', { token: owner.token, body: { kind: 'agency', organisation_id: org.id, display_name: `Agency ${n}`, sport_ids: [football], markets: ['WW'], is_public: true } }), 201);
  await verify(owner);
  await q("INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,'coach','active')", [org.id, staff.id]);
  const st = must(await api('POST', '/agents/me/staff', { token: owner.token, body: { user_id: staff.id, permissions: perms } }), 201);
  return { ...owner, profile: p, staff, staffRow: st, org };
}
const randomId = '00000000-0000-4000-8000-0000000000aa';

test('a role grants nothing: a mandate, then a grant of one exact item; revoking an item, then the mandate, stops access at once', async () => {
  const c = await club(), ag = await agent();
  const k = await signedContract(c);
  const m = await mandate(c.player, ag);
  const asAgent = (path, o = {}) => api('GET', `/representation/mandates/${m.id}${path}`, { token: ag.token, ...o });

  // the mandate alone shares only what anyone can already see
  const first = must(await asAgent('/athlete'));
  assert.deepEqual(first.shared_videos, []);
  assert.equal(JSON.stringify(first).match(/medical|wellness|\bphone\b|password|iban|bank/i), null, 'no medical, wellness, contact or banking data is part of this view');
  assert.deepEqual(must(await asAgent('/contracts')), []);
  assert.equal(code(await asAgent(`/contracts/${k.id}`)), 'mandate_not_live');
  assert.equal(reason(await asAgent(`/contracts/${k.id}`)), 'no_grant', 'the contract exists but was not shared');
  // an agent role on someone else's mandate sees a 404
  assert.equal((await api('GET', `/representation/mandates/${m.id}/athlete`, { token: (await agent()).token })).status, 404);

  // only the athlete's own item can be shared, only for a kind and purpose the mandate allows, and only the athlete decides
  const stranger = await signup(); const sm = await mandate(stranger, ag);
  assert.equal((await grant(stranger, sm, 'player_contract', k.id)).status, 404, 'not the athlete\'s own contract: indistinguishable from none');
  assert.equal((await grant(ag, m, 'player_contract', k.id)).status, 403, 'the agent cannot grant themselves anything');
  assert.equal(code(await grant(c.player, m, 'transfer', randomId)), 'workflow_unavailable');
  assert.equal((await grant(c.player, m, 'passport_video', k.id, 'participate')).status, 400, 'only contract discussions can be shared at participate level');
  const g = must(await grant(c.player, m, 'player_contract', k.id), 201);
  assert.equal(g.level, 'view');
  const view = must(await asAgent(`/contracts/${k.id}`));
  assert.equal(view.versions[0].status, 'in_force'); assert.equal(view.level, 'view');
  assert.equal(JSON.stringify(view).match(/ladder|bank|account_number|payout_|"ledger"|reference_enc/i), null, 'no ledger, bank or payout detail is part of the agent view');
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='read_represented_contract' AND actor_id=$1", [ag.id])).length >= 1, 'every read is audit-logged');
  assert.deepEqual(must(await asAgent('/contracts')).map((x) => x.id), [k.id]);
  // view level cannot take part; participate can comment, never sign
  const note = (body = {}) => api('POST', `/representation/mandates/${m.id}/contracts/${k.id}/notes`, { token: ag.token, body: { kind: 'note', visibility: 'athlete', body: 'The appearance fee looks low', ...body } });
  assert.equal(reason(await note()), 'no_grant');
  assert.equal(must(await grant(c.player, m, 'player_contract', k.id, 'participate'), 201).level, 'participate');
  assert.equal((await q("SELECT count(*)::int AS n FROM representation_grants WHERE mandate_id=$1 AND revoked_at IS NULL", [m.id]))[0].n, 1, 'a repeated grant updates the level, it does not duplicate');
  const sig = await api('POST', `/contract-versions/${view.versions[0].id}/decision`, { token: ag.token, body: { decision: 'sign' } });
  assert.equal(sig.status, 404, 'an agent can never sign for the player: the canonical contract does not even know them');
  const before = (await q('SELECT count(*)::int AS n FROM player_contract_signatures WHERE version_id=$1', [view.versions[0].id]))[0].n;

  // negotiation notes: controlled visibility; a suggestion is words and numbers, never applied
  must(await note({ visibility: 'agent_only', body: 'My private view' }), 201);
  must(await note({ visibility: 'athlete', body: 'Ask for more appearances' }), 201);
  must(await note({ visibility: 'all_parties', kind: 'suggestion', body: 'Suggesting a higher fee', suggestion: { topic: 'Appearance fee', proposal: 'Raise to 450,000 per game', amount_cents: 450000, currency: 'INR' } }), 201);
  assert.equal((await note({ kind: 'suggestion', body: 'no proposal' })).status, 400);
  const mine = must(await api('GET', `/player-contracts/${k.id}/negotiation-notes`, { token: c.player.token }));
  assert.deepEqual(mine.map((x) => x.visibility).sort(), ['all_parties', 'athlete'], 'the athlete never sees agent-only notes');
  const club1 = must(await api('GET', `/player-contracts/${k.id}/negotiation-notes`, { token: c.manager.token }));
  assert.deepEqual(club1.map((x) => x.visibility), ['all_parties'], 'the club sees only notes marked for all parties');
  assert.equal((await api('GET', `/player-contracts/${k.id}/negotiation-notes`, { token: (await signup()).token })).status, 404);
  assert.equal(must(await asAgent(`/contracts/${k.id}`)).notes.length, 3);
  const raw = (await q('SELECT body_enc FROM representation_notes ORDER BY created_at LIMIT 1'))[0].body_enc;
  assert.ok(!raw.includes('private view'), 'note text is stored encrypted');
  const comps = (await q('SELECT components FROM player_contract_versions WHERE contract_id=$1', [k.id]))[0].components;
  assert.ok(comps.every((x) => x.kind !== 'appearance_fee' || x.amount_cents === 400000), 'a suggestion never changes the contract');
  assert.equal((await q('SELECT count(*)::int AS n FROM player_contract_signatures WHERE version_id=$1', [view.versions[0].id]))[0].n, before);
  must(await api('POST', `/representation/mandates/${m.id}/contracts/${k.id}/review`, { token: ag.token, body: { version_no: 1, state: 'reviewed' } }));
  assert.equal((await api('POST', `/representation/mandates/${m.id}/contracts/${k.id}/review`, { token: ag.token, body: { version_no: 9, state: 'reviewed' } })).status, 404);

  // a new version of the contract: the live agent gets a review item and a short notice with no terms in it
  const raise = { base_version: 1, amendment_types: ['fee_change'], reason: 'Renewal after good form', effective_from: day(-20), terms: contractTerms({ components: contractTerms().components.map((x) => (x.kind === 'appearance_fee' ? { ...x, amount_cents: 450000 } : x)) }) };
  must(await api('POST', `/player-contracts/${k.id}/amendments`, { token: c.owner.token, body: raise }), 201);
  const rev = await q("SELECT version_no, state FROM representation_contract_reviews WHERE mandate_id=$1 AND version_no=2", [m.id]);
  assert.equal(rev[0]?.state, 'to_review');
  const notice = (await q("SELECT body, title FROM notifications WHERE user_id=$1 AND kind='representation_contract_revision'", [ag.id]));
  assert.equal(notice.length, 1); assert.equal(/450000|4500|fee/i.test(notice[0].body), false, 'the notice names no terms');
  assert.equal(must(await asAgent(`/contracts/${k.id}`)).versions.find((v) => v.version === 2).status, 'proposed');

  // revoking the one grant ends access to that item at once and leaves the rest
  must(await api('DELETE', `/representation/grants/${g.id}`, { token: c.player.token }));
  assert.equal(reason(await asAgent(`/contracts/${k.id}`)), 'no_grant');
  assert.equal(reason(await note()), 'no_grant');
  assert.equal((await asAgent('/athlete')).status, 200);
  assert.equal(must(await api('GET', `/representation/mandates/${m.id}/grants`, { token: ag.token })).length, 0, 'the agent sees nothing about revoked items');
  assert.equal(must(await api('GET', `/representation/mandates/${m.id}/grants`, { token: c.player.token, query: { include_revoked: 'true' } })).length, 1);
  // no notice for the next revision once the item is not shared
  must(await api('POST', `/player-contracts/${k.id}/amendments`, { token: c.owner.token, body: { ...raise, base_version: 1, replace_pending: true, reason: 'Counter' } }), 201);
  assert.equal((await q("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='representation_contract_revision'", [ag.id]))[0].n, 1);

  // re-share, then the athlete ends the mandate: everything agent-facing stops, the business record stays
  must(await grant(c.player, m, 'player_contract', k.id, 'participate'), 201);
  assert.equal((await asAgent(`/contracts/${k.id}`)).status, 200);
  const ended = must(await api('POST', `/representation/mandates/${m.id}/end`, { token: c.player.token, body: { reason: 'Going a different way' } }));
  assert.equal(ended.status, 'revoked'); assert.equal(ended.end_kind, 'revoked_by_athlete'); assert.equal(ended.live, false);
  for (const path of ['/athlete', '/contracts', `/contracts/${k.id}`, '/sponsorships']) { const r = await asAgent(path); assert.equal(r.status, 403, path); assert.equal(reason(r), 'revoked'); }
  assert.equal(reason(await note()), 'revoked');
  assert.equal((await api('POST', `/representation/mandates/${m.id}/pipeline`, { token: ag.token, body: { post_id: c.post.id } })).status, 403);
  assert.equal((await q('SELECT count(*)::int AS n FROM representation_grants WHERE mandate_id=$1 AND revoked_at IS NULL', [m.id]))[0].n, 0);
  const kept = must(await asAgent(''));
  assert.equal(kept.status, 'revoked'); assert.ok(kept.events.some((e) => e.action === 'mandate_ended'), 'the agent keeps the history of the mandate');
  assert.equal(must(await api('GET', `/representation/mandates/${m.id}/document`, { token: ag.token })).status, 'in_force');
  assert.ok(must(await api('GET', '/agent/report', { token: ag.token, query: { format: 'csv' } })).csv.includes(m.mandate_no), 'exports still list the business record');
  assert.equal(must(await api('POST', `/representation/mandates/${m.id}/end`, { token: c.player.token })).status, 'revoked', 'ending again does nothing');
  assert.equal((await api('POST', `/representation/mandates/${m.id}/versions`, { token: c.player.token, body: { kind: 'amendment', base_version: 1, terms: terms() } })).status, 409, 'an ended mandate is replaced by a new one, not amended');
  // the contract itself is untouched by all of it
  assert.equal((await q('SELECT status FROM player_contracts WHERE id=$1', [k.id]))[0].status, 'active');
});

test('what the mandate does not allow cannot be shared: data kind, purpose and sport are all checked', async () => {
  const c = await club(), ag = await agent();
  const k = await signedContract(c);
  const noContracts = await mandate(c.player, ag, { terms: { purposes: ['opportunity_outreach'], data_access: ['public_passport', 'opportunity_applications'], commission: [] } });
  assert.equal(code(await grant(c.player, noContracts, 'player_contract', k.id)), 'data_not_permitted');
  const cricketOnly = await mandate(c.player, ag, { terms: { sport_ids: [cricket] } });
  assert.equal(code(await grant(c.player, cricketOnly, 'player_contract', k.id)), 'sport_not_in_mandate');
  assert.equal((await api('GET', `/representation/mandates/${cricketOnly.id}/athlete`, { token: ag.token })).status, 200);
});

test('agency staff act only where the athlete allowed it and only with their own permissions; removal is immediate', async () => {
  const c = await club(), ag = await agency({ perms: ['view'] });
  const k = await signedContract(c);
  const m1 = await mandate(c.player, ag, { terms: { allow_staff: false } });
  assert.equal(reason(await api('GET', `/representation/mandates/${m1.id}/athlete`, { token: ag.staff.token })), 'staff_not_allowed', 'the athlete did not allow staff');
  assert.equal((await api('GET', `/representation/mandates/${m1.id}`, { token: ag.staff.token })).status, 404, 'staff do not even see a mandate that does not allow them');
  must(await api('POST', `/representation/mandates/${m1.id}/end`, { token: c.player.token }));
  const m = await mandate(c.player, ag, { terms: { allow_staff: true } });
  assert.equal((await api('GET', `/representation/mandates/${m.id}/athlete`, { token: ag.staff.token })).status, 200);
  must(await grant(c.player, m, 'player_contract', k.id, 'participate'), 201);
  assert.equal((await api('GET', `/representation/mandates/${m.id}/contracts/${k.id}`, { token: ag.staff.token })).status, 200, 'view permission');
  const r = await api('POST', `/representation/mandates/${m.id}/contracts/${k.id}/notes`, { token: ag.staff.token, body: { kind: 'note', visibility: 'athlete', body: 'x1' } });
  assert.equal(reason(r), 'staff_not_allowed', 'the negotiate permission was not given');
  const amend = must(await api('POST', `/representation/mandates/${m.id}/versions`, { token: c.player.token, body: { kind: 'amendment', base_version: 1, terms: terms({ allow_staff: true, notice_days: 40 }) } }), 201);
  assert.equal((await api('POST', `/representation/mandates/${m.id}/versions/${amend.pending.version}/decision`, { token: ag.staff.token, body: { decision: 'sign' } })).status, 403, 'staff never sign for the agent');
  must(await api('POST', `/representation/mandates/${m.id}/versions/${amend.pending.version}/decision`, { token: ag.token, body: { decision: 'sign' } }));
  assert.equal((await api('POST', `/representation/mandates/${m.id}/end`, { token: ag.staff.token })).status, 403, 'staff cannot end the mandate');
  must(await api('POST', '/agents/me/staff', { token: ag.token, body: { user_id: ag.staff.id, permissions: ['view', 'negotiate'] } }), 201);
  must(await api('POST', `/representation/mandates/${m.id}/contracts/${k.id}/notes`, { token: ag.staff.token, body: { kind: 'note', visibility: 'athlete', body: 'Now allowed' } }), 201);
  must(await api('DELETE', `/agents/me/staff/${ag.staffRow.id}`, { token: ag.token }));
  assert.equal((await api('GET', `/representation/mandates/${m.id}/athlete`, { token: ag.staff.token })).status, 404, 'removed staff lose access at once');
  assert.ok((await q("SELECT 1 FROM representation_events WHERE mandate_id=$1 AND actor_side='staff'", [m.id])).length >= 1, 'what staff did stays in the history');
});

// ------------------------------------------------------------------ 4. opportunities and approvals
test('opportunity outreach: the agent shares and drafts; nothing is sent as the athlete until the athlete approves', async () => {
  const c = await club(), ag = await agent(), a = await signup();
  const m = await mandate(a, ag);
  const pipe = (path = '', o = {}) => api(o.method ?? 'GET', `/representation/mandates/${m.id}/pipeline${path}`, { token: o.token ?? ag.token, body: o.body });
  const sh = must(await pipe('', { method: 'POST', body: { post_id: c.post.id, note: 'Good fit for you' } }), 201);
  assert.equal(sh.stage, 'shared'); assert.equal(sh.note, 'Good fit for you');
  assert.equal(must(await pipe('', { method: 'POST', body: { post_id: c.post.id } }), 201).id, sh.id, 'sharing again is the same item');
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='representation_opportunity'", [a.id])).length === 1);
  // sport must be in the mandate
  const other = (await q("SELECT slug FROM sports WHERE id=$1", [cricket]))[0].slug;
  const post2 = must(await api('POST', '/billboard', { token: c.owner.token, body: { title: `Other ${++n}`, sport: other, kind: 'match_players', positions_needed: 2 } }), 201);
  assert.equal(reason(await pipe('', { method: 'POST', body: { post_id: post2.id } })), 'sport_not_in_mandate');
  // an agent whose mandate lacks the action cannot share
  const lim = await mandate(await signup(), ag, { terms: { contact_actions: ['track_pipeline'] } });
  assert.equal(reason(await api('POST', `/representation/mandates/${lim.id}/pipeline`, { token: ag.token, body: { post_id: c.post.id } })), 'action_not_permitted');
  // only the athlete answers
  assert.equal((await api('POST', `/representation/pipeline/${sh.id}/response`, { token: ag.token, body: { response: 'interested' } })).status, 403, 'only the athlete answers');
  assert.equal(must(await api('POST', `/representation/pipeline/${sh.id}/response`, { token: a.token, body: { response: 'interested' } })).stage, 'drafting');
  // draft; stale protection; the agent can't skip the draft
  assert.equal((await api('POST', `/representation/pipeline/${sh.id}/approval`, { token: ag.token, body: { kind: 'submit_application' } })).status, 400, 'draft first so the athlete can read what would be sent');
  const d = must(await api('PATCH', `/representation/pipeline/${sh.id}`, { token: ag.token, body: { row_version: 3, draft_message: 'I am a striker with 40 goals', draft_sections: ['video'] } }).then((r) => (r.status === 409 ? api('PATCH', `/representation/pipeline/${sh.id}`, { token: ag.token, body: { row_version: r.body.error?.details?.row_version ?? 2, draft_message: 'I am a striker with 40 goals', draft_sections: ['video'] } }) : r)));
  assert.equal(d.draft_message, 'I am a striker with 40 goals');
  assert.equal(code(await api('PATCH', `/representation/pipeline/${sh.id}`, { token: ag.token, body: { row_version: 1, stage: 'outcome' } })), 'stale_version');
  assert.equal((await q('SELECT count(*)::int AS n FROM billboard_responses WHERE responder_id=$1', [a.id]))[0].n, 0, 'drafting sends nothing');
  // high-impact commitments are not an approval kind at all
  assert.equal((await api('POST', `/representation/pipeline/${sh.id}/approval`, { token: ag.token, body: { kind: 'accept_offer' } })).status, 400);
  const ap = must(await api('POST', `/representation/pipeline/${sh.id}/approval`, { token: ag.token, body: { kind: 'submit_application' } }), 201);
  assert.equal(ap.status, 'pending'); assert.match(ap.summary, /Apply to/);
  assert.equal(must(await api('POST', `/representation/pipeline/${sh.id}/approval`, { token: ag.token, body: { kind: 'submit_application' } }), 201).id, ap.id, 'asking again returns the pending request');
  assert.equal((await api('POST', `/representation/approvals/${ap.id}/decision`, { token: ag.token, body: { decision: 'approve' } })).status, 403, 'the agent cannot approve their own request');
  assert.equal(must(await api('GET', '/me/representation', { token: a.token })).approvals.length, 1);
  const done = must(await api('POST', `/representation/approvals/${ap.id}/decision`, { token: a.token, body: { decision: 'approve' } }));
  assert.equal(done.status, 'approved');
  const resp = await q('SELECT id, message, status FROM billboard_responses WHERE responder_id=$1 AND post_id=$2', [a.id, c.post.id]);
  assert.equal(resp.length, 1); assert.equal(resp[0].message, 'I am a striker with 40 goals');
  assert.equal(must(await api('POST', `/representation/approvals/${ap.id}/decision`, { token: a.token, body: { decision: 'approve' } })).status, 'approved', 'repeating changes nothing');
  assert.equal((await q('SELECT count(*)::int AS n FROM billboard_responses WHERE responder_id=$1 AND post_id=$2', [a.id, c.post.id]))[0].n, 1);
  assert.equal(must(await pipe('')).find((x) => x.id === sh.id).stage, 'submitted');
  assert.equal(code(await api('POST', `/representation/pipeline/${sh.id}/approval`, { token: ag.token, body: { kind: 'express_interest' } })), 'already_applied');

  // a declined approval sends nothing; an expired one cannot be used; ending the mandate cancels what is waiting
  const sh2 = must(await pipe('', { method: 'POST', body: { post_id: (must(await api('POST', '/billboard', { token: c.owner.token, body: { title: `Third ${++n}`, sport: 'football', kind: 'match_players', positions_needed: 1 } }), 201)).id } }), 201);
  const ap2 = must(await api('POST', `/representation/pipeline/${sh2.id}/approval`, { token: ag.token, body: { kind: 'express_interest' } }), 201);
  assert.equal(must(await api('POST', `/representation/approvals/${ap2.id}/decision`, { token: a.token, body: { decision: 'decline', note: 'Not now' } })).status, 'declined');
  const sh3 = must(await pipe('', { method: 'POST', body: { post_id: (must(await api('POST', '/billboard', { token: c.owner.token, body: { title: `Fourth ${++n}`, sport: 'football', kind: 'match_players', positions_needed: 1 } }), 201)).id } }), 201);
  const ap3 = must(await api('POST', `/representation/pipeline/${sh3.id}/approval`, { token: ag.token, body: { kind: 'express_interest' } }), 201);
  await q("UPDATE representation_approvals SET expires_at = now() - interval '1 day' WHERE id=$1", [ap3.id]);
  assert.equal(code(await api('POST', `/representation/approvals/${ap3.id}/decision`, { token: a.token, body: { decision: 'approve' } })), 'expired');
  const sh4 = must(await pipe('', { method: 'POST', body: { post_id: (must(await api('POST', '/billboard', { token: c.owner.token, body: { title: `Fifth ${++n}`, sport: 'football', kind: 'match_players', positions_needed: 1 } }), 201)).id } }), 201);
  const ap4 = must(await api('POST', `/representation/pipeline/${sh4.id}/approval`, { token: ag.token, body: { kind: 'express_interest' } }), 201);

  // conversations are logged by the agent, readable by the athlete, encrypted at rest
  const ct = must(await api('POST', `/representation/mandates/${m.id}/contacts`, { token: ag.token, body: { pipeline_id: sh.id, channel: 'call', counterparty: 'Strikers FC manager', summary: 'Asked about trial dates', happened_on: day(0) } }), 201);
  assert.ok(!(await q('SELECT summary_enc FROM representation_contacts WHERE id=$1', [ct.id]))[0].summary_enc.includes('trial dates'));
  assert.equal(must(await api('GET', `/representation/mandates/${m.id}/contacts`, { token: a.token }))[0].summary, 'Asked about trial dates');
  must(await api('POST', `/representation/mandates/${m.id}/end`, { token: a.token }));
  assert.equal((await q('SELECT status FROM representation_approvals WHERE id=$1', [ap4.id]))[0].status, 'cancelled');
  assert.equal(code(await api('POST', `/representation/approvals/${ap4.id}/decision`, { token: a.token, body: { decision: 'approve' } })), 'not_pending');
});

// ------------------------------------------------------------------ 5. young people
test('young people: a guardian proposes and must sign, consent is live, and a guardian decides what is sent', async () => {
  const parent = await signup(), kid = await signup(), ag = await agent(), c = await club();
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  const body = (o = {}) => ({ athlete_id: kid.id, agent_id: ag.profile.id, terms: terms({ commission: [] }), send: true, ...o });
  assert.equal((await api('POST', '/representation/mandates', { token: kid.token, body: body() })).status, 403, 'a young person cannot propose alone');
  assert.equal((await api('POST', '/representation/mandates', { token: (await signup()).token, body: body({ agent_id: ag.profile.id }) })).status, 403, 'a stranger cannot propose for them');
  const no = await api('POST', '/representation/mandates', { token: parent.token, body: body() });
  assert.equal(no.status, 409); assert.equal(code(no), 'guardian_consent_required');
  for (const purpose of ['recruitment', 'participation', 'recruitment_sharing']) await q("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,$2,$3,1, now() + interval '30 days')", [kid.id, purpose, parent.id]);
  const m = must(await api('POST', '/representation/mandates', { token: parent.token, body: body({ client_key: key() }) }), 201);
  assert.equal(m.status, 'proposed'); assert.deepEqual(m.pending.required_parties, ['guardian', 'athlete', 'agent']); assert.deepEqual(m.pending.waiting_for.sort(), ['agent', 'athlete']);
  const afterAgent = must(await api('POST', `/representation/mandates/${m.id}/versions/1/decision`, { token: ag.token, body: { decision: 'sign' } }));
  assert.equal(afterAgent.status, 'proposed', 'the agent and the guardian alone do not complete it');
  const live = must(await api('POST', `/representation/mandates/${m.id}/versions/1/decision`, { token: kid.token, body: { decision: 'sign' } }));
  assert.equal(live.status, 'active');
  assert.equal((await api('POST', `/representation/mandates/${m.id}/grants`, { token: kid.token, body: { subject_type: 'player_contract', subject_id: randomId } })).status, 403, 'a young person cannot grant');
  assert.equal(code(await api('POST', `/representation/mandates/${m.id}/profile-visibility`, { token: parent.token, body: { show: true } })), 'youth_profile');
  const seen = must(await api('GET', `/representation/mandates/${m.id}/athlete`, { token: ag.token }));
  assert.equal(seen.passport.restricted, true, 'young people have no public profile to show an agent');
  assert.equal(must(await api('GET', '/me/representation', { token: parent.token, query: { athlete_id: kid.id } })).side, 'guardian');
  assert.equal((await api('GET', '/me/representation', { token: (await signup()).token, query: { athlete_id: kid.id } })).status, 404);

  // contact consent gates conversations; a guardian approves what is sent, on the young person's behalf
  const log = () => api('POST', `/representation/mandates/${m.id}/contacts`, { token: ag.token, body: { channel: 'call', counterparty: 'A coach', summary: 'Intro call', happened_on: day(0) } });
  assert.equal(reason(await log()), 'guardian_consent_withdrawn');
  const sh = must(await api('POST', `/representation/mandates/${m.id}/pipeline`, { token: ag.token, body: { post_id: c.post.id } }), 201);
  must(await api('PATCH', `/representation/pipeline/${sh.id}`, { token: ag.token, body: { row_version: sh.row_version, draft_message: 'Keen to trial', draft_sections: [] } }));
  const ap = must(await api('POST', `/representation/pipeline/${sh.id}/approval`, { token: ag.token, body: { kind: 'submit_application' } }), 201);
  assert.equal((await api('POST', `/representation/approvals/${ap.id}/decision`, { token: kid.token, body: { decision: 'approve' } })).status, 403, 'a young person cannot approve');
  assert.equal(must(await api('POST', `/representation/approvals/${ap.id}/decision`, { token: parent.token, body: { decision: 'approve' } })).status, 'approved');
  const row = (await q('SELECT responder_id, applied_by FROM billboard_responses WHERE post_id=$1 AND responder_id=$2', [c.post.id, kid.id]))[0];
  assert.equal(row.applied_by, parent.id, 'sent by the guardian for the young person');

  // consent withdrawn: the agent loses sight at once, the record stays, and the young person can still end it
  await q('UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose=$2', [kid.id, 'recruitment']);
  assert.equal(reason(await api('GET', `/representation/mandates/${m.id}/athlete`, { token: ag.token })), 'guardian_consent_withdrawn');
  assert.equal(must(await api('GET', `/representation/mandates/${m.id}`, { token: ag.token })).status, 'active');
  assert.equal(must(await api('POST', `/representation/mandates/${m.id}/end`, { token: kid.token, body: { reason: 'I changed my mind' } })).status, 'revoked');
});

// ------------------------------------------------------------------ 6. commission
test('commission: computed from the deal\'s own facts, once per deal, never twice for an amendment, and "settled" only when the agent confirms receipt', async () => {
  const c = await club(), ag = await agent();
  const k = await signedContract(c);
  const m = await mandate(c.player, ag, { terms: { commission: [commission({ rate_bp: 1000, threshold_cents: 50000 })] } });
  const link = (token = ag.token, body = {}) => api('POST', `/representation/mandates/${m.id}/deals`, { token, body: { deal_type: 'player_contract', deal_id: k.id, term_key: 'main', ...body } });
  assert.equal(reason(await link()), 'no_grant', 'a deal that was not shared cannot carry commission');
  must(await grant(c.player, m, 'player_contract', k.id), 201);
  const d = must(await link(), 201);
  assert.equal(d.status, 'proposed'); assert.equal(d.ladder.owed_cents, 0, 'nothing accrues before the athlete confirms');
  assert.equal(must(await link(), 201).id, d.id, 'linking again is the same deal');
  const acc = (token, id = d.id) => api('POST', `/representation/deals/${id}/accrue`, { token });
  assert.equal(must(await acc(ag.token), 200).posted, false);
  assert.equal((await api('POST', `/representation/deals/${d.id}/decision`, { token: ag.token, body: { decision: 'confirm' } })).status, 403, 'the proposer cannot confirm their own proposal');
  const ok = must(await api('POST', `/representation/deals/${d.id}/decision`, { token: c.player.token, body: { decision: 'confirm' } }));
  assert.equal(ok.status, 'confirmed');
  // 10% of (250,000 earned - 50,000 threshold) = 20,000, from the contract ledger
  assert.equal(ok.ladder.owed_cents, 20000); assert.equal(ok.ladder.stage, 'accruing');
  const full = must(await api('GET', `/representation/deals/${d.id}`, { token: c.player.token }));
  assert.equal(full.entries.length, 1); assert.equal(full.entries[0].basis_cents, 250000);
  assert.equal(full.entries[0].calc.deal_version, 1); assert.equal(full.entries[0].calc.deal_ref, k.contract_no); assert.equal(full.entries[0].calc.mandate_version, 1);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='read_representation_deal' AND actor_id=$1", [c.player.id])).length === 0, 'the athlete reading their own account is not logged as an agent read');
  must(await api('GET', `/representation/deals/${d.id}`, { token: ag.token }));
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='read_representation_deal' AND actor_id=$1", [ag.id])).length === 1, 'the agent reading the athlete\'s earnings is logged');
  // repeats and parallel accruals post nothing more
  await Promise.all([acc(ag.token), acc(c.player.token), acc(ag.token), acc(ag.token)]);
  assert.equal((await q("SELECT count(*)::int AS n FROM representation_commission_entries WHERE deal_id=$1 AND kind='accrual'", [d.id]))[0].n, 1);
  // an amendment to the contract raises the fee: only the difference accrues, no second commission
  const raise = { base_version: 1, amendment_types: ['fee_change'], reason: 'Better terms', effective_from: day(-20), terms: contractTerms({ components: contractTerms().components.map((x) => (x.kind === 'fixed' ? { ...x, amount_cents: 300000 } : x)) }) };
  const am = must(await api('POST', `/player-contracts/${k.id}/amendments`, { token: c.owner.token, body: raise }), 201);
  must(await api('POST', `/contract-versions/${am.pending.id}/decision`, { token: c.player.token, body: { decision: 'sign' } }));
  const after = must(await acc(ag.token));
  assert.equal(after.delta_cents, 5000); assert.equal(after.deal.ladder.owed_cents, 25000, '10% of (300,000 - 50,000)');
  assert.equal(after.deal.entries?.length ?? 2, 2);
  const again = await acc(c.player.token); assert.equal(must(again).posted, false);
  // the same deal cannot be counted twice for this agent and athlete, under another mandate either
  const m2 = await mandate(c.player, ag, { terms: { commission: [commission()] } });
  must(await grant(c.player, m2, 'player_contract', k.id), 201);
  assert.equal(code(await api('POST', `/representation/mandates/${m2.id}/deals`, { token: ag.token, body: { deal_type: 'player_contract', deal_id: k.id, term_key: 'main' } })), 'already_linked');
  // a term in another currency is refused: nothing is ever converted
  const usd = await mandate(c.player, ag, { terms: { commission: [commission({ currency: 'USD' })] } });
  must(await grant(c.player, usd, 'player_contract', k.id), 201);
  assert.equal(code(await api('POST', `/representation/mandates/${usd.id}/deals`, { token: ag.token, body: { deal_type: 'player_contract', deal_id: k.id, term_key: 'main' } })), 'currency_mismatch');
  // statements, reports and settlement: each is its own state
  const stm = (token = ag.token, body = {}) => api('POST', `/representation/deals/${d.id}/statements`, { token, body });
  assert.equal((await stm(c.player.token)).status, 403, 'the athlete does not issue the agent\'s statements');
  const s1 = must(await stm(), 201);
  assert.match(s1.statement_no, /^REP-STM-\d{4}-\d{4}$/); assert.equal(Number(s1.amount_cents), 25000); assert.equal(s1.sha256.length, 64);
  assert.equal(code(await stm()), 'nothing_to_invoice');
  let view = must(await api('GET', `/representation/deals/${d.id}`, { token: c.player.token }));
  assert.equal(view.ladder.stage, 'invoiced'); assert.equal(view.ladder.settled_cents, 0);
  const report = (token, amount, ref) => api('POST', `/representation/deals/${d.id}/payments-reported`, { token, body: { amount_cents: amount, reference: ref } });
  assert.equal(code(await report(c.player.token, 30000, 'UTR-1')), 'exceeds_invoiced');
  assert.equal((await report(ag.token, 25000, 'UTR-1')).status, 403, 'the agent cannot report the payer\'s payment');
  view = must(await report(c.player.token, 25000, 'UTR-1'), 201);
  assert.equal(view.ladder.stage, 'payment_reported'); assert.equal(view.ladder.reported_cents, 25000); assert.equal(view.ladder.settled_cents, 0, 'a reported payment is not a settled one');
  assert.equal(code(await report(c.player.token, 100, 'UTR-1')), 'duplicate_reference');
  const confirm = (amount, ref, token = ag.token) => api('POST', `/representation/deals/${d.id}/payments`, { token, body: { amount_cents: amount, reference: ref } });
  assert.equal((await confirm(25000, 'BANK-1', c.player.token)).status, 403, 'only the agent confirms receipt');
  assert.equal(code(await confirm(26000, 'BANK-1')), 'exceeds_invoiced');
  view = must(await confirm(10000, 'BANK-1'), 201);
  assert.equal(view.ladder.stage, 'part_settled'); assert.equal(view.ladder.outstanding_cents, 15000);
  view = must(await confirm(15000, 'BANK-2'), 201);
  assert.equal(view.ladder.stage, 'settled'); assert.equal(view.ladder.outstanding_cents, 0);
  assert.equal(code(await confirm(100, 'BANK-2')), 'duplicate_reference');
  assert.equal(code(await api('POST', `/representation/statements/${s1.id}/void`, { token: ag.token, body: { reason: 'Issued in error' } })), 'payments_applied');
  // credits and refunds are new lines with reasons; nothing is edited
  view = must(await api('POST', `/representation/deals/${d.id}/adjustments`, { token: ag.token, body: { credit_cents: 5000, reason: 'Goodwill after the renewal', client_key: 'adj-1' } }), 201);
  assert.equal(view.ladder.owed_cents, 20000);
  must(await api('POST', `/representation/deals/${d.id}/adjustments`, { token: ag.token, body: { credit_cents: 5000, reason: 'Goodwill after the renewal', client_key: 'adj-1' } }), 201);
  assert.equal((await q("SELECT count(*)::int AS n FROM representation_commission_entries WHERE deal_id=$1 AND kind='adjustment'", [d.id]))[0].n, 1, 'a retry with the same key adds nothing');
  assert.equal(code(await api('POST', `/representation/deals/${d.id}/adjustments`, { token: ag.token, body: { credit_cents: 999999, reason: 'Too much', client_key: 'adj-2' } })), 'exceeds_owed');
  view = must(await api('POST', `/representation/deals/${d.id}/refunds`, { token: ag.token, body: { amount_cents: 5000, reference: 'REF-1', reason: 'Returned the credit' } }), 201);
  assert.equal(view.ladder.settled_cents, 20000);
  assert.equal((await q('UPDATE representation_commission_entries SET amount_cents = 1 WHERE deal_id=$1', [d.id]).catch((e) => e.code)), '23514', 'the ledger is append-only');
  const csv = must(await api('GET', `/representation/statements/${s1.id}`, { token: c.player.token, query: { format: 'csv' } }));
  assert.match(csv.csv, /^line,kind,amount,basis,note/);
  // an outsider sees nothing; staff without the commission permission see nothing
  assert.equal((await api('GET', `/representation/deals/${d.id}`, { token: (await signup()).token })).status, 404);
  // the agent can only end a confirmed link (waiving future commission); what is owed stays
  assert.equal((await api('POST', `/representation/deals/${d.id}/decision`, { token: c.player.token, body: { decision: 'end' } })).status, 403);
  const ended = must(await api('POST', `/representation/deals/${d.id}/decision`, { token: ag.token, body: { decision: 'end' } }));
  assert.equal(ended.status, 'ended'); assert.equal(ended.ladder.owed_cents, 20000);
  assert.equal((await acc(ag.token)).status, 200);
  // the athlete ending the mandate does not erase commission records
  must(await api('POST', `/representation/mandates/${m.id}/end`, { token: c.player.token }));
  assert.equal(must(await api('GET', `/representation/deals/${d.id}`, { token: ag.token })).ladder.owed_cents, 20000);
});

test('commission terms: fixed, percentage with threshold and cap, and milestones the athlete confirms', async () => {
  // the arithmetic, in whole minor units, rounded down
  const pct = { basis: 'percentage', rate_bp: 1250, threshold_cents: 100000, cap_cents: 30000 };
  assert.equal(targetFor(pct, { basis_cents: 90000 }), 0, 'below the threshold nothing accrues');
  assert.equal(targetFor(pct, { basis_cents: 100001 }), 0, 'rounded down');
  assert.equal(targetFor(pct, { basis_cents: 300000 }), 25000);
  assert.equal(targetFor(pct, { basis_cents: 900000 }), 30000, 'the cap applies');
  assert.equal(targetFor({ basis: 'fixed', fixed_cents: 70000 }, { in_force: false }), 0);
  assert.equal(targetFor({ basis: 'fixed', fixed_cents: 70000, cap_cents: 50000 }, { in_force: true }), 50000);
  const ms = { basis: 'milestone', milestones: [{ key: 'a', amount_cents: 10000 }, { key: 'b', amount_cents: 20000 }] };
  assert.equal(targetFor(ms, { confirmed: new Set(['b']) }), 20000);

  // fixed: accrues once the contract is in force and the athlete confirms
  const c = await club(), ag = await agent();
  const k = await signedContract(c);
  const mf = await mandate(c.player, ag, { terms: { commission: [commission({ basis: 'fixed', fixed_cents: 70000, rate_bp: undefined, calc_on: undefined })] } });
  must(await grant(c.player, mf, 'player_contract', k.id), 201);
  const df = must(await api('POST', `/representation/mandates/${mf.id}/deals`, { token: ag.token, body: { deal_type: 'player_contract', deal_id: k.id, term_key: 'main' } }), 201);
  assert.equal(must(await api('POST', `/representation/deals/${df.id}/decision`, { token: c.player.token, body: { decision: 'confirm' } })).ladder.owed_cents, 70000);

  // milestones: nothing without the athlete's confirmation, each only once
  const c2 = await club(); const k2 = await signedContract(c2);
  const mm = await mandate(c2.player, ag, { terms: { commission: [commission({ basis: 'milestone', rate_bp: undefined, calc_on: undefined, milestones: [{ key: 'signed', label: 'Contract signed', amount_cents: 50000 }, { key: 'renewed', label: 'Renewed', amount_cents: 30000 }] })] } });
  must(await grant(c2.player, mm, 'player_contract', k2.id), 201);
  const dm = must(await api('POST', `/representation/mandates/${mm.id}/deals`, { token: c2.player.token, body: { deal_type: 'player_contract', deal_id: k2.id, term_key: 'main' } }), 201);
  assert.equal((await api('POST', `/representation/deals/${dm.id}/decision`, { token: c2.player.token, body: { decision: 'confirm' } })).status, 403, 'the athlete cannot confirm their own proposal');
  assert.equal(must(await api('POST', `/representation/deals/${dm.id}/decision`, { token: ag.token, body: { decision: 'confirm' } })).ladder.owed_cents, 0);
  const claim = (key) => api('POST', `/representation/deals/${dm.id}/milestones`, { token: ag.token, body: { milestone_key: key, evidence_note: 'Signed on the date' } });
  assert.equal((await api('POST', `/representation/deals/${dm.id}/milestones`, { token: c2.player.token, body: { milestone_key: 'signed' } })).status, 403, 'only the agent claims');
  assert.equal((await claim('nope')).status, 400);
  const m1 = must(await claim('signed'), 201), m2 = must(await claim('renewed'), 201);
  assert.equal(must(await claim('signed'), 201).id, m1.id, 'claiming again is the same claim');
  assert.equal((await api('POST', `/representation/milestones/${m1.id}/decision`, { token: ag.token, body: { decision: 'confirm' } })).status, 403);
  must(await api('POST', `/representation/milestones/${m1.id}/decision`, { token: c2.player.token, body: { decision: 'confirm' } }));
  must(await api('POST', `/representation/milestones/${m2.id}/decision`, { token: c2.player.token, body: { decision: 'reject' } }));
  assert.equal(must(await api('GET', `/representation/deals/${dm.id}`, { token: c2.player.token })).ladder.owed_cents, 50000);
  const rep = must(await api('GET', '/agent/report', { token: ag.token, query: { format: 'csv' } }));
  assert.match(rep.csv, /owed,invoiced,reported,settled,outstanding/);
});

test('commission from a sponsorship made with the athlete counts only confirmed money, net of refunds', async () => {
  const a = await signup(), ag = await agent(), sp = await signup(['sponsor']);
  const sponsor = (await q("INSERT INTO sponsors(owner_id, name) VALUES ($1,'Volt Drinks') RETURNING id", [sp.id]))[0];
  const s = (await q("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, status, proposed_by, currency, terms_version, accepted_version, decided_at, agreement_ref) VALUES ($1,'athlete',$2,0,'active',$3,'INR',1,1,now(),'SP-9') RETURNING id", [sponsor.id, a.id, sp.id]))[0];
  const line = (await q("INSERT INTO sponsorship_lines(sponsorship_id, version, position, kind, label, currency, amount_cents, total_cents) VALUES ($1,1,1,'money','Cash','INR',500000,1000000) RETURNING id", [s.id]))[0];
  const ob = (await q("INSERT INTO sponsorship_obligations(sponsorship_id, version, line_id, seq, kind, due_on, amount_cents, currency) VALUES ($1,1,$2,1,'money',current_date,500000,'INR') RETURNING id", [s.id, line.id]))[0];
  await q("INSERT INTO sponsorship_payments(obligation_id, amount_cents, currency, method, reference, paid_on, status, reported_by, refunded_cents) VALUES ($1,500000,'INR','bank_transfer','CONF-1',current_date,'confirmed',$2,100000)", [ob.id, sp.id]);
  await q("INSERT INTO sponsorship_payments(obligation_id, amount_cents, currency, method, reference, paid_on, status, reported_by) VALUES ($1,400000,'INR','bank_transfer','CLAIM-2',current_date,'reported',$2)", [ob.id, sp.id]);
  const m = await mandate(a, ag, { terms: { commission: [commission({ applies_to: ['sponsorship'], rate_bp: 1500 })] } });
  assert.deepEqual(must(await api('GET', `/representation/mandates/${m.id}/sponsorships`, { token: ag.token })), []);
  assert.equal(reason(await api('GET', `/representation/mandates/${m.id}/sponsorships/${s.id}`, { token: ag.token })), 'no_grant');
  must(await grant(a, m, 'sponsorship', s.id), 201);
  const view = must(await api('GET', `/representation/mandates/${m.id}/sponsorships/${s.id}`, { token: ag.token }));
  assert.equal(view.confirmed_cents, 400000, 'only confirmed money, net of the refund; a sponsor\'s unconfirmed claim is not counted');
  assert.equal(view.sponsor_name, 'Volt Drinks'); assert.match(view.reminder, /Only the athlete accepts/);
  const d = must(await api('POST', `/representation/mandates/${m.id}/deals`, { token: ag.token, body: { deal_type: 'sponsorship', deal_id: s.id, term_key: 'main' } }), 201);
  assert.equal(d.deal_ref, 'SP-9');
  const ok = must(await api('POST', `/representation/deals/${d.id}/decision`, { token: a.token, body: { decision: 'confirm' } }));
  assert.equal(ok.ladder.owed_cents, 60000, '15% of 400,000');
  // a refund after the fact reduces the commission through a compensating line
  await q("UPDATE sponsorship_payments SET refunded_cents = 300000 WHERE reference='CONF-1'");
  const r = must(await api('POST', `/representation/deals/${d.id}/accrue`, { token: ag.token }));
  assert.equal(r.deal.ladder.owed_cents, 30000); assert.equal(r.delta_cents, -30000);
  // the agent cannot reach sponsorships made with someone else
  const other = await signup(); const om = await mandate(other, ag);
  assert.equal(reason(await api('GET', `/representation/mandates/${om.id}/sponsorships/${s.id}`, { token: ag.token })), 'no_grant');
  assert.equal((await grant(other, om, 'sponsorship', s.id)).status, 404);
});

// ------------------------------------------------------------------ 7. conflicts of interest
test('conflicts: flagged by comparison, decided by people, blocking the affected item until they are; policy limits what an athlete may accept', async () => {
  const c = await club(), ag = await agent();
  const k = await signedContract(c);
  const m = await mandate(c.player, ag);
  const itemOf = (path = '') => api('GET', `/representation/mandates/${m.id}/contracts/${k.id}${path}`, { token: ag.token });
  const interest = must(await api('POST', '/agents/me/interests', { token: ag.token, body: { kind: 'club', target_type: 'team', target_id: c.team.id, label: 'Part-owner of Strikers FC' } }), 201);
  assert.equal((await api('POST', '/agents/me/interests', { token: ag.token, body: { kind: 'club', target_type: 'team', label: 'x1' } })).status, 400);
  must(await grant(c.player, m, 'player_contract', k.id), 201);
  const list = must(await api('GET', `/representation/mandates/${m.id}/conflicts`, { token: c.player.token }));
  assert.equal(list.length, 1); assert.equal(list[0].kind, 'agent_interest'); assert.equal(list[0].raised_by, 'system'); assert.equal(list[0].status, 'open'); assert.equal(list[0].can_acknowledge, true);
  assert.match(list[0].detail, /Part-owner|declared an interest/);
  assert.equal(reason(await itemOf()), 'conflict_open', 'the item is blocked until the athlete decides');
  assert.equal(must(await api('GET', '/me/representation', { token: c.player.token })).conflicts.length, 1);
  const decide = (token, id, decision, extra = {}) => api('POST', `/representation/conflicts/${id}/decision`, { token, body: { decision, ...extra } });
  assert.equal((await decide(ag.token, list[0].id, 'acknowledge')).status, 403, 'the agent cannot accept a conflict on the athlete\'s behalf');
  assert.equal((await decide((await signup()).token, list[0].id, 'acknowledge')).status, 404);
  const ack = must(await decide(c.player.token, list[0].id, 'acknowledge', { note: 'Fine, I know' }));
  assert.equal(ack.status, 'acknowledged'); assert.equal(ack.decision_note, 'Fine, I know');
  assert.equal(must(await decide(c.player.token, list[0].id, 'acknowledge')).status, 'acknowledged', 'repeating changes nothing');
  assert.equal((await itemOf()).status, 200);
  assert.ok((await q("SELECT 1 FROM representation_events WHERE mandate_id=$1 AND action IN ('conflict_raised','conflict_acknowledged')", [m.id])).length >= 2, 'raised and decided are in the history');
  assert.ok((await q("SELECT 1 FROM audit_log WHERE action='conflict_acknowledged' AND actor_id=$1", [c.player.id])).length === 1);
  // an acknowledged conflict can still be rejected later; that closes the item
  assert.equal(must(await decide(c.player.token, list[0].id, 'reject')).status, 'rejected');
  assert.equal(reason(await itemOf()), 'recused');

  // opposing sides: the agent also represents the person who runs the club on the other side; policy: the athlete cannot simply accept it
  const c2 = await club(); const k2 = await signedContract(c2);
  const clubOwnerMandate = await mandate(c2.owner, ag);
  const m2 = await mandate(c2.player, ag);
  must(await grant(c2.player, m2, 'player_contract', k2.id), 201);
  const opp = must(await api('GET', `/representation/mandates/${m2.id}/conflicts`, { token: c2.player.token })).find((x) => x.kind === 'opposing_sides');
  assert.ok(opp, 'representing the other side of a negotiation is flagged'); assert.equal(opp.can_acknowledge, false);
  assert.equal(code(await decide(c2.player.token, opp.id, 'acknowledge')), 'cannot_acknowledge');
  assert.equal(reason(await api('GET', `/representation/mandates/${m2.id}/contracts/${k2.id}`, { token: ag.token })), 'conflict_open');
  // the agent can step back from the item: its grant closes and it stays closed
  const rec = must(await decide(ag.token, opp.id, 'recuse', { note: 'I will not act on this one' }));
  assert.equal(rec.status, 'recused');
  assert.equal((await q("SELECT count(*)::int AS n FROM representation_grants WHERE mandate_id=$1 AND subject_id=$2 AND revoked_at IS NULL", [m2.id, k2.id]))[0].n, 0);
  assert.equal(reason(await api('GET', `/representation/mandates/${m2.id}/contracts/${k2.id}`, { token: ag.token })) !== undefined, true);
  assert.equal(clubOwnerMandate.status, 'active');

  // dual representation: a second agent for the same athlete in overlapping scope is disclosed, and blocks the second agent's access until decided
  const m3 = await mandate(c.player, ag);
  const agB = await agent();
  const mB = await mandate(c.player, agB);
  const dual = must(await api('GET', `/representation/mandates/${mB.id}/conflicts`, { token: c.player.token })).find((x) => x.kind === 'dual_representation');
  assert.ok(dual); assert.equal(dual.subject_type, 'mandate');
  assert.equal(reason(await api('GET', `/representation/mandates/${mB.id}/athlete`, { token: agB.token })), 'conflict_open');
  assert.equal((await api('GET', `/representation/mandates/${m3.id}/athlete`, { token: ag.token })).status, 200, 'the first agent is not blocked');
  must(await decide(c.player.token, dual.id, 'acknowledge'));
  assert.equal((await api('GET', `/representation/mandates/${mB.id}/athlete`, { token: agB.token })).status, 200);
  // exclusive overlaps are refused outright; the athlete must end the other first
  const agC = await agent();
  const ex = await api('POST', '/representation/mandates', { token: c.player.token, body: { agent_id: agC.profile.id, terms: terms({ exclusive: true, commission: [] }), send: true } });
  assert.equal(ex.status, 409); assert.equal(code(ex), 'exclusivity_overlap');
  // a disclosure made by hand, then withdrawn by whoever made it; an automatic flag cannot be withdrawn
  const hand = must(await api('POST', `/representation/mandates/${mB.id}/conflicts`, { token: agB.token, body: { kind: 'related_party', detail: 'My brother runs the sponsor involved' } }), 201);
  assert.equal(hand.raised_by, 'agent'); assert.equal(hand.can_acknowledge, true);
  assert.equal((await decide(c.player.token, hand.id, 'withdraw')).status, 403, 'only the side that disclosed it can withdraw it');
  assert.equal(must(await decide(agB.token, hand.id, 'withdraw')).status, 'withdrawn');
  assert.equal((await decide(agB.token, dual.id, 'withdraw')).status, 409, 'an acknowledged conflict is no longer open');
  // recusal at mandate level is the agent ending the mandate
  const agD = await agent(); const mD = await mandate(c.player, agD);
  const d2 = must(await api('GET', `/representation/mandates/${mD.id}/conflicts`, { token: c.player.token })).find((x) => x.kind === 'dual_representation');
  must(await decide(agD.token, d2.id, 'recuse'));
  const ended = must(await api('GET', `/representation/mandates/${mD.id}`, { token: c.player.token }));
  assert.equal(ended.status, 'revoked'); assert.equal(ended.end_kind, 'ended_by_agent');
  void interest;
});

// ------------------------------------------------------------------ 8. profile, every sport, scopes, retries, MCP
test('public profile: representation shows only when the athlete opts in, while in force, listed and verified - never terms or commission', async () => {
  const a = await signup(), ag = await agent();
  const m = await mandate(a, ag);
  const pub = async () => (await api('GET', `/people/${a.id}`)).body.representation;
  assert.deepEqual(await pub(), [], 'off by default');
  assert.equal((await api('POST', `/representation/mandates/${m.id}/profile-visibility`, { token: ag.token, body: { show: true } })).status, 403, 'only the athlete decides');
  must(await api('POST', `/representation/mandates/${m.id}/profile-visibility`, { token: a.token, body: { show: true } }));
  const shown = await pub();
  assert.equal(shown.length, 1); assert.equal(shown[0].agent.id, ag.profile.id); assert.equal(shown[0].agent.verified, true);
  assert.equal(JSON.stringify(shown).match(/commission|rate_bp|notice|licence|reference/i), null);
  await q('UPDATE agent_profiles SET is_public=false WHERE id=$1', [ag.profile.id]);
  assert.deepEqual(await pub(), [], 'an agent who is not listed is not shown');
  await q('UPDATE agent_profiles SET is_public=true WHERE id=$1', [ag.profile.id]);
  must(await api('POST', `/admin/agents/${ag.profile.id}/suspension`, { token: admin.token, body: { suspended: true, reason: 'Review' } }));
  assert.deepEqual(await pub(), []);
  must(await api('POST', `/admin/agents/${ag.profile.id}/suspension`, { token: admin.token, body: { suspended: false } }));
  assert.equal((await pub()).length, 1);
  must(await api('POST', `/representation/mandates/${m.id}/end`, { token: a.token }));
  assert.deepEqual(await pub(), [], 'ending the mandate removes it at once');
  assert.equal((await q('SELECT show_on_profile FROM representation_mandates WHERE id=$1', [m.id]))[0].show_on_profile, false);
});

test('every sport in the catalogue can be represented: no sport is left on a silent default', async () => {
  const sports = await q('SELECT id, slug FROM sports ORDER BY slug');
  assert.ok(sports.length >= 20, `the catalogue has ${sports.length} sports`);
  const a = await signup(), ag = await agent();
  let made = 0;
  for (const s of sports) {
    const r = await api('POST', '/representation/mandates', { token: a.token, body: { agent_id: ag.profile.id, terms: terms({ sport_ids: [s.id], commission: [], purposes: ['opportunity_outreach'], data_access: ['public_passport'] }), client_key: `sport-${s.slug}` } });
    assert.equal(r.status, 201, `${s.slug}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body.versions[0].sports.map((x) => x.name).length, 1, `${s.slug} carries its own sport, not a default`);
    made++;
  }
  assert.equal(made, sports.length);
  // a profile can declare any of them as well
  const u = await signup(['agent']);
  await profile(u, { sport_ids: sports.map((s) => s.id) });
  assert.equal((await q('SELECT cardinality(sport_ids)::int AS n FROM agent_profiles WHERE user_id=$1', [u.id]))[0].n, sports.length);
});

test('retries and parallel requests are safe: one activation, one mandate per client key, one grant, one deal', async () => {
  const c = await club(), ag = await agent();
  const k = await signedContract(c);
  const key1 = key();
  const mk = () => api('POST', '/representation/mandates', { token: c.player.token, body: { agent_id: ag.profile.id, terms: terms(), client_key: key1 } });
  const made = await Promise.all([mk(), mk(), mk(), mk()]);
  assert.ok(made.every((r) => r.status === 201), JSON.stringify(made.map((r) => r.status)));
  assert.equal(new Set(made.map((r) => r.body.id)).size, 1, 'four parallel retries are one mandate');
  const id = made[0].body.id;
  const sent = must(await api('POST', `/representation/mandates/${id}/send`, { token: c.player.token, body: { row_version: made[0].body.row_version } }));
  const signs = await Promise.all([1, 2, 3].map(() => api('POST', `/representation/mandates/${id}/versions/1/decision`, { token: ag.token, body: { decision: 'sign' } })));
  assert.ok(signs.every((r) => r.status === 200), JSON.stringify(signs.map((r) => r.body)));
  assert.equal((await q("SELECT count(*)::int AS n FROM representation_events WHERE mandate_id=$1 AND action='mandate_active'", [id]))[0].n, 1, 'activated exactly once');
  assert.equal(sent.status, 'proposed');
  const gs = await Promise.all([1, 2, 3].map(() => api('POST', `/representation/mandates/${id}/grants`, { token: c.player.token, body: { subject_type: 'player_contract', subject_id: k.id } })));
  assert.ok(gs.every((r) => r.status === 201), JSON.stringify(gs.map((r) => r.body)));
  assert.equal((await q("SELECT count(*)::int AS n FROM representation_grants WHERE mandate_id=$1 AND revoked_at IS NULL", [id]))[0].n, 1);
  const links = await Promise.all([1, 2, 3].map(() => api('POST', `/representation/mandates/${id}/deals`, { token: ag.token, body: { deal_type: 'player_contract', deal_id: k.id, term_key: 'main' } })));
  assert.ok(links.every((r) => r.status === 201), JSON.stringify(links.map((r) => r.body)));
  assert.equal((await q('SELECT count(*)::int AS n FROM representation_deals WHERE mandate_id=$1', [id]))[0].n, 1);
  // a revoke racing a read: afterwards every read is refused
  const [end] = await Promise.all([api('POST', `/representation/mandates/${id}/end`, { token: c.player.token }), api('GET', `/representation/mandates/${id}/athlete`, { token: ag.token })]);
  assert.equal(end.status, 200);
  assert.equal((await api('GET', `/representation/mandates/${id}/athlete`, { token: ag.token })).status, 403);
});

test('REST, OpenAPI and MCP expose the same capabilities, and money-moving ones need the payment scope', async () => {
  const mine = capabilities.filter((x) => ['Representation'].includes(x.tag));
  assert.ok(mine.length >= 60, `${mine.length} representation capabilities`);
  for (const name of ['issue_commission_statement', 'void_commission_statement', 'report_commission_payment', 'confirm_commission_payment', 'adjust_commission', 'record_commission_refund']) assert.equal(capabilities.find((x) => x.name === name).scope, 'payment', name);
  for (const name of ['get_agent_home', 'list_mandates', 'get_mandate', 'get_represented_athlete', 'get_representation_deal']) assert.equal(capabilities.find((x) => x.name === name).scope, 'read', name);
  const spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json());
  const ops = new Set(Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)));
  for (const c of mine) assert.ok(ops.has(c.name), `${c.name} is in the OpenAPI document`);

  const a = await signup(), ag = await agent();
  const m = await mandate(a, ag);
  const mint = async (u, scopes) => must(await api('POST', '/me/tokens', { token: u.token, body: { name: 'tok', scopes } }), 201);
  const rpc = async (name, args, token) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const res = (await r.json()).result;
    return res.isError ? { error: JSON.parse(res.content[0].text) } : { ok: res.structuredContent.result };
  };
  const read = await mint(ag, ['read']), write = await mint(ag, ['read', 'write']), pay = await mint(ag, ['read', 'payment']);
  // MCP behaves exactly like REST: the same live checks, the same refusals
  assert.equal((await rpc('get_agent_home', {}, read.token)).ok.agent.id, ag.profile.id);
  assert.equal((await rpc('get_represented_athlete', { id: m.id }, read.token)).ok.athlete_id, a.id);
  assert.equal((await rpc('get_representation_matrix', {}, read.token)).ok.never_shared.length, 5);
  assert.equal((await rpc('share_opportunity', { id: m.id, post_id: randomId }, read.token)).error.code, 'forbidden', 'a read token cannot write');
  assert.equal((await rpc('issue_commission_statement', { id: randomId }, write.token)).error.code, 'forbidden', 'write does not imply payment');
  assert.equal((await rpc('issue_commission_statement', { id: randomId }, pay.token)).error.code, 'not_found', 'with the payment scope it reaches the capability, which refuses by itself');
  must(await api('POST', `/representation/mandates/${m.id}/end`, { token: a.token }));
  assert.equal((await rpc('get_represented_athlete', { id: m.id }, read.token)).error.code, 'forbidden', 'revocation reaches MCP too');
  assert.equal((await rpc('list_mandates', { as: 'agent' }, read.token)).ok.length >= 1, true, 'the business record stays readable over MCP');
});
