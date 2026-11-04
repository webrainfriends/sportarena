import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Academy talent scouting & recruitment journey (#790): campaign brief -> team -> launch -> prospect (Talent CRM entry) -> evaluation snapshot ->
// committee vote and decision -> invitation into the canonical academy application with source and consent -> outcome report.
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');
const { capabilities } = await import('../src/registry.js');
await import('../src/capabilities/index.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const key = () => `idem-${++n}-${Math.random().toString(36).slice(2, 10)}`;
const signup = async (roles = ['athlete'], extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `sc_${n}`, display_name: `Scout Person ${n}`, email: `sc${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const adult = (roles = ['athlete']) => signup(roles, { dob: yearsAgo(30) });
const member = async (org, role = 'coach') => { const u = await adult(['coach']); await q("INSERT INTO organisation_members(organisation_id, user_id, role, status, joined_at) VALUES ($1,$2,$3,'active',now())", [org.id, u.id, role]); return u; };
const verifyRecruiter = (u) => q("INSERT INTO verification_cases(type, subject_type, subject_id, requested_by, status, rules_version, decided_at, expires_at) VALUES ('recruiter','user',$1,$1,'approved',1,now(), now() + interval '300 days')", [u.id]);
const footballCard = (u) => q("INSERT INTO sport_profiles(user_id, sport_id, role, level, position, is_default) SELECT $1, id, 'athlete', 'amateur', 'Winger', true FROM sports WHERE slug='football'", [u.id]);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('sc_root','sc_root','{admin}','x','x','sc_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function academy() {
  const owner = await adult(['organizer']);
  const org = must(await api('POST', '/organisations', { token: owner.token, body: { name: `Scouting Academy ${++n}`, kind: 'academy' } }), 201);
  must(await api('PATCH', `/organisations/${org.id}/academy`, { token: owner.token, body: { row_version: 0, sports: ['football'], currency: 'GBP', listed: true } }));
  const prog = must(await api('POST', `/organisations/${org.id}/academy/programmes`, { token: owner.token, body: { sport: 'football', title: `U14 Football ${n}`, capacity: 10, admission_mode: 'application', public: true, trial_enabled: true } }), 201);
  const pub = must(await api('POST', `/academy/programmes/${prog.id}/versions`, { token: owner.token, body: { row_version: prog.row_version, billing_model: 'one_time', currency: 'GBP', fee_minor: 12000, trial_fee_minor: 0 } }), 201);
  const sport = (await q("SELECT id FROM sports WHERE slug='football'"))[0];
  return { owner, org, programme: pub.programme, sportId: sport.id };
}

/** A young athlete whose guardian has linked, been verified and consented to recruitment. */
async function youngAthlete() {
  const mum = await adult(), kid = await signup(['athlete'], { dob: yearsAgo(13) });
  const l = must(await api('POST', '/youth/guardian-links', { token: mum.token, body: { guardian_id: mum.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: mum.token, body: { evidence: { reference: 'https://example.com/birth-ref', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'participation' } }), 201);
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'recruitment' } }), 201);
  await footballCard(kid);
  return { mum, kid, birthYear: Number(yearsAgo(13).slice(0, 4)) };
}

/** The scout holds a live grant for the athlete and saves them to a Talent CRM list. */
async function crmEntry(scout, athlete, decider = athlete) {
  const req = must(await api('POST', '/recruiter/requests', { token: scout.token, body: { athlete_id: athlete.id, sport: 'football', scopes: ['profile'], purpose: 'scouting', expires_on: inDays(60), idempotency_key: key() } }), 201);
  must(await api('POST', `/me/recruiter-requests/${req.id}/decision`, { token: decider.token, body: { decision: 'approve', row_version: req.row_version, granted_scopes: ['profile'] } }));
  const list = must(await api('POST', '/recruiter/lists', { token: scout.token, body: { name: `List ${++n}`, sport: 'football' } }), 201);
  const entry = must(await api('POST', `/recruiter/lists/${list.id}/entries`, { token: scout.token, body: { request_id: req.id } }), 201);
  return { req, entry };
}
const evaluate = (scout, entry, basis, overall = 4) => api('POST', `/recruiter/entries/${entry.id}/evaluations`, { token: scout.token, body: { basis, observed_on: inDays(-2), ratings: { technical: overall, tactical: Math.max(1, overall - 1) }, overall, notes: 'Private note about first touch', idempotency_key: key() } });

const brief = (org, programme, sportId, owner, birthYear) => ({
  name: 'U14 Football Pune', objective: 'build_intake', season_label: '2027', sport_ids: [sportId], programme_ids: [programme.id], owner_id: owner.id,
  target_places: 8, scholarship_places: 2, pipeline_target: 40, starts_on: inDays(0), ends_on: inDays(60), decision_by: inDays(70),
  birth_year_min: birthYear - 1, birth_year_max: birthYear, genders: ['boys'], positions: ['Winger'], regions: ['Pune'], scouting_modes: ['open_trial_day'],
  rubric: [{ key: 'technical', weight: 60 }, { key: 'tactical', weight: 40 }], min_evaluations: 2, required_bases: ['live_viewing'],
  committee_quorum: 3, committee_rule: 'majority', sla_days: { evaluate: 14, committee: 7, invite: 5, trial: 21 },
});

test('the whole journey: brief -> launch -> prospect -> committee -> invitation -> application with source and consent -> report', async () => {
  const a = await academy();
  const kidA = await youngAthlete();
  const scout = await adult(['recruiter']); await verifyRecruiter(scout);
  must(await api('POST', '/recruiter/profile', { token: scout.token, body: { organisation_id: a.org.id, sport_ids: [a.sportId], regions: ['Pune'] } }));
  const c1 = await member(a.org), chair = await member(a.org), guard = await member(a.org);
  const stranger = await adult(['coach']);

  // options + referral sources
  const options = must(await api('GET', `/organisations/${a.org.id}/academy/scouting/options`, { token: a.owner.token }));
  assert.ok(options.sports.find((s) => s.slug === 'football').positions.length, 'positions come from the sport catalogue');
  assert.ok(options.scouts.some((s) => s.user_id === scout.id), 'a verified linked recruiter is offered as a scout');
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/scouting/options`, { token: stranger.token })).status, 404);
  const source = must(await api('POST', `/organisations/${a.org.id}/academy/referral-sources`, { token: a.owner.token, body: { name: 'Pune Public School', kind: 'school', region: 'Pune' } }));
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/referral-sources`, { token: a.owner.token, body: { name: 'pune public school', kind: 'club' } })).status, 409, 'names are unique per academy');

  // a draft saves step by step and cannot launch until the server is satisfied
  const draft = must(await api('POST', `/organisations/${a.org.id}/academy/scouting/campaigns`, { token: a.owner.token, body: { name: 'U14 Football Pune' } }), 201);
  assert.equal(draft.status, 'draft');
  assert.equal((await api('POST', `/organisations/${a.org.id}/academy/scouting/campaigns`, { token: stranger.token, body: { name: 'Nope campaign' } })).status, 404);
  const early = await api('POST', `/academy/scouting/campaigns/${draft.id}/launch`, { token: a.owner.token, body: { row_version: draft.row_version } });
  assert.equal(early.status, 409);
  const codes = (early.body.details ?? early.body.error?.details).blockers.map((b) => b.code);
  for (const c of ['sports', 'programme', 'committee', 'rubric', 'eligibility']) assert.ok(codes.includes(c), `blocker ${c}`);
  const v1 = must(await api('PATCH', `/academy/scouting/campaigns/${draft.id}`, { token: a.owner.token, body: { row_version: draft.row_version, ...brief(a.org, a.programme, a.sportId, a.owner, kidA.birthYear), referral_source_ids: [source.id] } }));
  assert.equal((await api('PATCH', `/academy/scouting/campaigns/${draft.id}`, { token: a.owner.token, body: { row_version: draft.row_version, name: 'stale write' } })).status, 409, 'stale row_version is refused');
  assert.equal((await api('PATCH', `/academy/scouting/campaigns/${draft.id}`, { token: a.owner.token, body: { row_version: v1.row_version, rubric: [{ key: 'technical', weight: 50 }, { key: 'tactical', weight: 40 }] } })).status, 200);
  const bad = await api('POST', `/academy/scouting/campaigns/${draft.id}/launch`, { token: a.owner.token, body: { row_version: v1.row_version + 1 } });
  assert.ok((bad.body.details ?? bad.body.error?.details).blockers.some((b) => b.code === 'rubric'), 'rubric weights must total 100');
  const fixed = must(await api('PATCH', `/academy/scouting/campaigns/${draft.id}`, { token: a.owner.token, body: { row_version: v1.row_version + 1, rubric: [{ key: 'technical', weight: 60 }, { key: 'tactical', weight: 40 }] } }));
  assert.equal((await api('PATCH', `/academy/scouting/campaigns/${draft.id}`, { token: a.owner.token, body: { row_version: fixed.row_version, guardian_consent_required: false } })).status, 400, 'consent cannot be switched off for an age band with young people');

  // team: scouts must be verified recruiters linked to the academy, committee members must belong to it
  const unverified = await adult(['recruiter']);
  assert.equal((await api('POST', `/academy/scouting/campaigns/${draft.id}/team`, { token: a.owner.token, body: { row_version: fixed.row_version, members: [{ user_id: unverified.id, role: 'scout', region: 'Pune' }] } })).status, 400);
  assert.equal((await api('POST', `/academy/scouting/campaigns/${draft.id}/team`, { token: a.owner.token, body: { row_version: fixed.row_version, members: [{ user_id: stranger.id, role: 'committee' }] } })).status, 400);
  const team = must(await api('POST', `/academy/scouting/campaigns/${draft.id}/team`, { token: a.owner.token, body: { row_version: fixed.row_version, members: [
    { user_id: scout.id, role: 'scout', region: 'Pune', capacity: 5 }, { user_id: c1.id, role: 'committee' }, { user_id: chair.id, role: 'chair' }, { user_id: guard.id, role: 'safeguarding_officer' }] } }));
  assert.equal(team.readiness.blockers.length, 0, JSON.stringify(team.readiness.blockers));
  assert.equal((await api('POST', `/academy/scouting/campaigns/${draft.id}/launch`, { token: scout.token, body: { row_version: team.row_version } })).status, 403, 'a scout cannot launch');
  const live = must(await api('POST', `/academy/scouting/campaigns/${draft.id}/launch`, { token: a.owner.token, body: { row_version: team.row_version } }));
  assert.equal(live.status, 'active');
  assert.equal((await api('PATCH', `/academy/scouting/campaigns/${draft.id}`, { token: a.owner.token, body: { row_version: live.row_version, birth_year_min: 1990 } })).status, 409, 'the age band is fixed after launch');
  assert.equal((await api('GET', `/academy/scouting/campaigns/${draft.id}`, { token: stranger.token })).status, 404, 'existence is not leaked');
  assert.equal(must(await api('GET', '/me/scouting/campaigns', { token: scout.token })).length, 1);

  // eligibility: an adult outside the brief is refused; a Talent CRM entry for the young athlete is accepted
  const adultAthlete = await adult(); await footballCard(adultAthlete);
  const outside = await crmEntry(scout, adultAthlete);
  assert.equal((await api('POST', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: scout.token, body: { entry_id: outside.entry.id, region: 'Pune' } })).status, 400, 'birth year outside the brief');
  const crm = await crmEntry(scout, kidA.kid, kidA.mum);
  assert.equal((await api('POST', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: stranger.token, body: { entry_id: crm.entry.id } })).status, 404);
  assert.equal((await api('POST', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: scout.token, body: { entry_id: crm.entry.id, region: 'Mumbai' } })).status, 400, 'region not in the campaign');
  const p = must(await api('POST', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: scout.token, body: { entry_id: crm.entry.id, region: 'Pune', referral_source_id: source.id } }), 201);
  assert.equal(p.stage, 'prospect');
  assert.equal(must(await api('POST', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: scout.token, body: { entry_id: crm.entry.id, region: 'Pune' } }), 201).replayed, true, 'adding twice is idempotent');
  assert.ok((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='academy_scouting_prospect_added'", [kidA.mum.id])).length, 'the guardian is told (generic wording)');
  assert.equal((await q("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='academy_scouting_prospect_added'", [kidA.kid.id])).length, 0, 'not the child');

  // committee cannot see an unsubmitted prospect; scouts only see their own
  assert.equal((await api('GET', `/academy/scouting/prospects/${p.id}`, { token: c1.token })).status, 404);
  assert.equal(must(await api('GET', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: c1.token })).length, 0);
  assert.equal(must(await api('GET', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: scout.token })).length, 1);

  // submission enforces the campaign's evidence rules
  const e1 = must(await evaluate(scout, crm.entry, 'video', 4), 201);
  const e2 = must(await evaluate(scout, crm.entry, 'profile_only', 5), 201);
  const tooFew = await api('POST', `/academy/scouting/prospects/${p.id}/submit`, { token: scout.token, body: { row_version: p.row_version, evaluation_ids: [e1.id, e2.id] } });
  assert.equal(tooFew.status, 409, 'a profile-only evaluation does not count');
  const e3 = must(await evaluate(scout, crm.entry, 'live_viewing', 4), 201);
  const video = (await q("INSERT INTO passport_videos(user_id, sport_id, title, link_url, status) SELECT $1, id, 'Match highlights', 'https://example.com/v1', 'approved' FROM sports WHERE slug='football' RETURNING id", [kidA.kid.id]))[0];
  const pending = (await q("INSERT INTO passport_videos(user_id, title, link_url, status) VALUES ($1,'Awaiting coach','https://example.com/v2','pending') RETURNING id", [kidA.kid.id]))[0];
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/submit`, { token: scout.token, body: { row_version: p.row_version, evaluation_ids: [e1.id, e3.id], video_ids: [pending.id] } })).status, 400, 'only approved videos can be referenced');
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/submit`, { token: chair.token, body: { row_version: p.row_version, evaluation_ids: [e1.id, e3.id] } })).status, 404, 'only the scout who holds it submits');
  const sub = must(await api('POST', `/academy/scouting/prospects/${p.id}/submit`, { token: scout.token, body: { row_version: p.row_version, evaluation_ids: [e1.id, e3.id], release_notes: true, video_ids: [video.id] } }));
  assert.equal(sub.stage, 'committee');

  // the committee file: snapshots with provenance, released notes (audited), authorised video links, no contact data
  const file = must(await api('GET', `/academy/scouting/prospects/${p.id}`, { token: c1.token }));
  assert.equal(file.evaluations.length, 2);
  assert.deepEqual(file.evaluations.map((e) => e.basis).sort(), ['live_viewing', 'video']);
  assert.ok(file.evaluations.every((e) => e.weighted != null && e.notes === 'Private note about first touch'));
  assert.equal(file.videos[0].url, 'https://example.com/v1');
  assert.equal(file.prospect.athlete.is_youth, true);
  assert.ok(!JSON.stringify(file).includes('@example.com'), 'no contact details anywhere');
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_scouting_notes'", [c1.id])).length, 'reading released notes is audit-logged');
  // an evaluation the scout later edits does not change what the committee saw
  await api('PATCH', `/recruiter/evaluations/${e1.id}`, { token: scout.token, body: { row_version: 1, overall: 1 } });
  assert.equal(must(await api('GET', `/academy/scouting/prospects/${p.id}`, { token: c1.token })).evaluations.find((e) => e.basis === 'video').overall, 4);

  // voting: only committee, a reason to decline, append-only history, quorum before a decision, a safeguarding veto for a young person
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: scout.token, body: { vote: 'advance' } })).status, 403, 'the scout is not on the committee');
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: c1.token, body: { vote: 'decline' } })).status, 400);
  must(await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: c1.token, body: { vote: 'advance', reason: 'Strong first touch' } }), 201);
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/decision`, { token: chair.token, body: { row_version: sub.row_version } })).status, 409, 'quorum not met');
  must(await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: chair.token, body: { vote: 'advance' } }), 201);
  must(await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: guard.token, body: { vote: 'decline', reason: 'Welfare concern to resolve first' } }), 201);
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/decision`, { token: c1.token, body: { row_version: sub.row_version } })).status, 403, 'only the chair, owner or admin closes a vote');
  const held = must(await api('POST', `/academy/scouting/prospects/${p.id}/decision`, { token: chair.token, body: { row_version: sub.row_version } }));
  assert.equal(held.outcome, 'hold', 'a safeguarding officer decline stops an advance for a young person');
  assert.equal(held.stage, 'evaluated');
  assert.equal((await q('SELECT count(*)::int AS n FROM academy_committee_votes WHERE campaign_entry_id=$1', [p.id]))[0].n, 3);
  await assert.rejects(pool.query('DELETE FROM academy_committee_votes WHERE campaign_entry_id=$1', [p.id]), /append|immutable|not allowed/i, 'votes are append-only');

  // round 2: a conflict of interest excludes a voter; then everyone advances
  const cur = must(await api('GET', `/academy/scouting/prospects/${p.id}`, { token: a.owner.token })).prospect;
  const re = must(await api('POST', `/academy/scouting/prospects/${p.id}/submit`, { token: scout.token, body: { row_version: cur.row_version, evaluation_ids: [e3.id, e1.id], release_notes: false } }));
  must(await api('POST', `/academy/scouting/prospects/${p.id}/conflict`, { token: c1.token, body: { reason: 'Coaches the athlete at school' } }), 201);
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: c1.token, body: { vote: 'advance' } })).status, 403, 'a declared conflict excludes the voter');
  must(await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: chair.token, body: { vote: 'advance' } }), 201);
  must(await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: guard.token, body: { vote: 'advance' } }), 201);
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/decision`, { token: chair.token, body: { row_version: re.row_version } })).status, 409, 'two voters is below quorum 3 once one is conflicted');
  const owner2 = await member(a.org); // owner adds a third eligible voter
  const t2 = must(await api('GET', `/academy/scouting/campaigns/${draft.id}`, { token: a.owner.token }));
  must(await api('POST', `/academy/scouting/campaigns/${draft.id}/team`, { token: a.owner.token, body: { row_version: t2.row_version, members: [...t2.members.map((m) => ({ user_id: m.user_id, role: m.role, region: m.region, capacity: m.capacity })), { user_id: owner2.id, role: 'committee' }] } }));
  must(await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: owner2.token, body: { vote: 'advance' } }), 201);
  const decided = must(await api('POST', `/academy/scouting/prospects/${p.id}/decision`, { token: a.owner.token, body: { row_version: re.row_version, note: 'Advance to trial' } }));
  assert.equal(decided.outcome, 'advance');

  // invitation: only an academy admin, only into a programme the campaign feeds, creating the canonical application with source + consent
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/invite`, { token: chair.token, body: { row_version: decided.row_version, programme_id: a.programme.id, mode: 'trial' } })).status, 403);
  const inv = must(await api('POST', `/academy/scouting/prospects/${p.id}/invite`, { token: a.owner.token, body: { row_version: decided.row_version, programme_id: a.programme.id, mode: 'trial' } }), 201);
  assert.equal(inv.stage, 'trial_requested');
  assert.equal(must(await api('POST', `/academy/scouting/prospects/${p.id}/invite`, { token: a.owner.token, body: { row_version: decided.row_version, programme_id: a.programme.id, mode: 'trial' } }), 201).replayed, true, 'inviting twice does not duplicate the application');
  assert.equal((await q('SELECT count(*)::int AS n FROM academy_applications WHERE athlete_id=$1', [kidA.kid.id]))[0].n, 1, 'no second admissions record');
  const app = must(await api('GET', `/academy/applications/${inv.application_id}`, { token: a.owner.token }));
  assert.equal(app.source.campaign, 'U14 Football Pune');
  assert.equal(app.source.referral_source, 'Pune Public School');
  assert.equal(app.source.region, 'Pune');
  assert.equal(app.source.consent.purpose, 'recruitment');
  assert.equal(app.source.consent.guardian_consent.granted_by, kidA.mum.id, 'the guardian\'s consent in force is recorded on the application');
  assert.equal(app.source_kind, 'scouting');
  const listApps = must(await api('GET', `/organisations/${a.org.id}/academy/applications`, { token: a.owner.token }));
  assert.equal(listApps.find((x) => x.id === inv.application_id).source_kind, 'scouting');
  assert.equal(must(await api('GET', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: a.owner.token }))[0].journey_stage, 'invited');

  // the report: counts only, never names
  const rep = must(await api('GET', `/organisations/${a.org.id}/academy/scouting/report`, { token: a.owner.token }));
  assert.equal(rep.funnel.prospects, 1); assert.equal(rep.funnel.committee, 1); assert.equal(rep.funnel.invited, 1); assert.equal(rep.funnel.enrolled, 0);
  assert.equal(rep.by_source[0].label, 'Pune Public School');
  assert.equal(rep.by_region.find((r) => r.key === 'Pune').scouts, 1);
  assert.ok(!JSON.stringify(rep).includes(kidA.kid.display_name), 'no athlete is named in the report');
  const csv = must(await api('GET', `/organisations/${a.org.id}/academy/scouting/report/export`, { token: a.owner.token }));
  assert.match(csv.csv, /^scope,name,prospects,committee,advanced,invited,applied,enrolled/);
  assert.ok(!csv.csv.includes(kidA.kid.display_name));
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/scouting/report`, { token: stranger.token })).status, 404);
  assert.equal((await api('GET', `/organisations/${a.org.id}/academy/scouting/report`, { token: c1.token })).status, 403, 'org-wide outcomes are for academy staff');

  // withdrawing the guardian's consent hides the prospect from the committee on the very next call; the academy's own record stays
  must(await api('DELETE', `/youth/children/${kidA.kid.id}/consents/recruitment`, { token: kidA.mum.token }));
  const hidden = must(await api('GET', `/academy/scouting/prospects/${p.id}`, { token: a.owner.token }));
  assert.equal(hidden.redacted, true);
  assert.equal(hidden.prospect.athlete, null);
  assert.equal(hidden.prospect.access_live, false);
  assert.equal(hidden.evaluations, undefined, 'the evaluations disappear with the consent');
  const row = must(await api('GET', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: a.owner.token }))[0];
  assert.equal(row.athlete, null);
  assert.equal(row.stage, 'invited', 'the academy keeps its own stage history');

  // closing keeps history and takes no new prospects
  const cl = must(await api('POST', `/academy/scouting/campaigns/${draft.id}/status`, { token: a.owner.token, body: { row_version: must(await api('GET', `/academy/scouting/campaigns/${draft.id}`, { token: a.owner.token })).row_version, status: 'closed' } }));
  assert.equal(cl.status, 'closed');
  assert.equal((await api('POST', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: scout.token, body: { entry_id: outside.entry.id } })).status, 409);
});

test('revocation mid-vote: no vote or decision once the athlete\'s access has ended', async () => {
  const a = await academy();
  const kid = await youngAthlete();
  const scout = await adult(['recruiter']); await verifyRecruiter(scout);
  must(await api('POST', '/recruiter/profile', { token: scout.token, body: { organisation_id: a.org.id } }));
  const m = [await member(a.org), await member(a.org), await member(a.org)];
  const draft = must(await api('POST', `/organisations/${a.org.id}/academy/scouting/campaigns`, { token: a.owner.token, body: brief(a.org, a.programme, a.sportId, a.owner, kid.birthYear) }), 201);
  const t = must(await api('POST', `/academy/scouting/campaigns/${draft.id}/team`, { token: a.owner.token, body: { row_version: draft.row_version, members: [{ user_id: scout.id, role: 'scout', region: 'Pune' }, { user_id: m[0].id, role: 'committee' }, { user_id: m[1].id, role: 'chair' }, { user_id: m[2].id, role: 'safeguarding_officer' }] } }));
  must(await api('POST', `/academy/scouting/campaigns/${draft.id}/launch`, { token: a.owner.token, body: { row_version: t.row_version } }));
  const crm = await crmEntry(scout, kid.kid, kid.mum);
  const p = must(await api('POST', `/academy/scouting/campaigns/${draft.id}/prospects`, { token: scout.token, body: { entry_id: crm.entry.id, region: 'Pune' } }), 201);
  const ev = [must(await evaluate(scout, crm.entry, 'live_viewing'), 201), must(await evaluate(scout, crm.entry, 'video'), 201)];
  const sub = must(await api('POST', `/academy/scouting/prospects/${p.id}/submit`, { token: scout.token, body: { row_version: p.row_version, evaluation_ids: ev.map((e) => e.id) } }));
  must(await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: m[0].token, body: { vote: 'advance' } }), 201);
  must(await api('POST', `/me/recruiter-requests/${crm.req.id}/revoke`, { token: kid.mum.token, body: { reason: 'We have changed our mind' } }));
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/votes`, { token: m[1].token, body: { vote: 'advance' } })).status, 409);
  assert.equal((await api('POST', `/academy/scouting/prospects/${p.id}/decision`, { token: m[1].token, body: { row_version: sub.row_version } })).status, 409);
  assert.equal(must(await api('GET', `/academy/scouting/prospects/${p.id}`, { token: m[0].token })).redacted, true);
});

test('every scouting capability is on REST, OpenAPI and MCP from one definition, and uses the right authorisation', async () => {
  const names = capabilities.filter((c) => /scouting|campaign_prospect|committee_vote|campaign_conflict|referral_source|campaign_team|prospect_to_committee/.test(c.name)).map((c) => c.name);
  for (const need of ['create_academy_scouting_campaign', 'update_academy_scouting_campaign', 'set_academy_campaign_team', 'launch_academy_scouting_campaign', 'add_campaign_prospect', 'submit_prospect_to_committee', 'cast_committee_vote', 'decide_campaign_prospect', 'invite_campaign_prospect', 'get_academy_scouting_report', 'export_academy_scouting_report', 'save_academy_referral_source']) assert.ok(names.includes(need), need);
  const spec = must(await api('GET', '/openapi.json')).paths ?? {};
  assert.ok(Object.keys(spec).some((p) => p.includes('/academy/scouting/campaigns')), 'in the OpenAPI document');
  const unauth = await api('GET', '/academy/scouting/prospects/00000000-0000-4000-8000-000000000000');
  assert.equal(unauth.status, 401);
  // no new generic prospect, video or trial tables: the campaign links to the Talent CRM
  const tables = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ~ '(prospect|video|trial)'")).map((r) => r.table_name);
  assert.ok(!tables.includes('academy_prospects') && !tables.includes('academy_videos') && !tables.includes('academy_trials'), `unexpected tables: ${tables}`);
  assert.deepEqual((await q("SELECT column_name FROM information_schema.columns WHERE table_name='academy_campaign_entries' AND column_name ~ '(name|email|phone|dob)'")), [], 'no identity data is copied into the campaign');
});
