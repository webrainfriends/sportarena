import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { POLICY, thresholdFor, serviceOf, blocksOn, appealDeadline, modelFor } = await import('../src/discipline.js');
const { flagSourceCorrection } = await import('../src/discipline-live.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `cp_${n}_${roles[0]}`, display_name: `Cp ${n}`, email: `cp${n}@example.com`, password: 'correct-horse-battery-9', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });


// ------------------------------------------------------------------ pure rules
test('discipline rules: policy schema, deterministic thresholds, served matches, blocking and appeal window', () => {
  assert.throws(() => POLICY.parse({ caution_thresholds: [{ count: 5, suspension_matches: 1 }, { count: 5, suspension_matches: 2 }] }), /different/);
  assert.throws(() => POLICY.parse({ caution_thresholds: [{ count: 5, suspension_matches: 2 }, { count: 10, suspension_matches: 1 }] }), /shorter/);
  assert.throws(() => POLICY.parse({ typo_key: 1 }), /Unrecognized/);
  const p = POLICY.parse({ caution_thresholds: [{ count: 5, suspension_matches: 1 }, { count: 10, suspension_matches: 2 }] });
  assert.deepEqual([thresholdFor(p, 4), thresholdFor(p, 5)?.suspension_matches, thresholdFor(p, 6), thresholdFor(p, 10)?.suspension_matches], [null, 1, null, 2], 'only an exact crossing triggers, so recomputing never double-issues');
  const s = { matches: 2, starts_on: '2026-03-01', starts_after: '2026-03-01T15:00:00Z', status: 'active', kind: 'match_suspension' };
  const fx = [
    { id: 'same-day', status: 'completed', scheduled_at: '2026-03-01T15:00:00Z' }, // the match the card happened in is not served
    { id: 'a', status: 'postponed', scheduled_at: '2026-03-08T15:00:00Z' }, { id: 'b', status: 'completed', scheduled_at: '2026-03-15T15:00:00Z' },
    { id: 'c', status: 'cancelled', scheduled_at: '2026-03-22T15:00:00Z' }, { id: 'd', status: 'completed', scheduled_at: '2026-03-29T15:00:00Z' },
  ];
  const sv = serviceOf(s, fx);
  assert.deepEqual([sv.served, sv.remaining, sv.done, sv.counted_fixture_ids], [2, 0, true, ['b', 'd']]);
  assert.equal(serviceOf(s, fx.slice(0, 3)).remaining, 1);
  assert.equal(blocksOn(s, '2026-03-10', serviceOf(s, fx.slice(0, 3))), true);
  assert.equal(blocksOn(s, '2026-04-10', sv), false, 'served');
  assert.equal(blocksOn({ ...s, status: 'stayed' }, '2026-03-10'), false);
  assert.equal(blocksOn({ ...s, status: 'interim' }, '2026-03-10'), true, 'an interim measure blocks but is labelled interim');
  assert.equal(blocksOn({ ...s, kind: 'fine' }, '2026-03-10'), false);
  assert.equal(appealDeadline('2026-03-01', { appeal_window_days: 3 }), '2026-03-04');
  assert.equal(appealDeadline('2026-03-01', { appeal_window_days: 0 }), null);
});

// ------------------------------------------------------------------ lifecycle (PostgreSQL)
const comp = async ({ rules = {} } = {}) => {
  const org = await signup(['organizer']);
  const cm = must(await api('POST', '/competitions', { token: org.token, body: { name: `Discipline Cup ${++n}`, sport: 'football', is_public: true } }), 201);
  const season = must(await api('POST', `/competitions/${cm.id}/seasons`, { token: org.token, body: { label: '2026', starts_on: day(-100), ends_on: day(100) } }), 201);
  const div = must(await api('POST', `/seasons/${season.id}/divisions`, { token: org.token, body: { name: 'Premier', tier: 1, capacity: 8 } }), 201);
  const mA = await signup(); const mB = await signup(); const player = await signup();
  const A = must(await api('POST', '/teams', { token: mA.token, body: { name: `DA ${n}`, sport: 'football' } }), 201);
  const B = must(await api('POST', '/teams', { token: mB.token, body: { name: `DB ${n}`, sport: 'football' } }), 201);
  await pool.query("INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'player','active') ON CONFLICT (team_id,user_id) DO UPDATE SET status='active'", [A.id, player.id]);
  must(await api('POST', `/seasons/${season.id}/status`, { token: org.token, body: { status: 'open' } }));
  for (const [m, tm] of [[mA, A], [mB, B]]) { const ms = must(await api('POST', `/seasons/${season.id}/memberships`, { token: m.token, body: { team_id: tm.id, division_id: div.id } }), 201); must(await api('POST', `/memberships/${ms.id}/decision`, { token: org.token, body: { action: 'accept' } })); }
  const pol = must(await api('POST', `/competitions/${cm.id}/discipline-policy`, { token: org.token, body: { rules: { caution_thresholds: [{ count: 5, suspension_matches: 1 }, { count: 10, suspension_matches: 2 }], dismissal: { suspension_matches: 2, interim: true }, appeal_window_days: 3, stay_on_appeal: true, fine_authority: true, points_deduction_authority: true, ...rules } } }), 201);
  return { org, cm, season, div, A, B, mA, mB, player, pol };
};
let uid = 0; const fid = () => `00000000-0000-4000-8000-${String(++uid).padStart(12, '0')}`;
const fixture = async (C, offsetDays, status = 'completed', home = C.A.id, away = C.B.id) => (await pool.query(
  'INSERT INTO fixtures(event_id,home_team_id,away_team_id,scheduled_at,status) VALUES ($1,$2,$3,now() + ($4 || \' days\')::interval,$5) RETURNING id', [C.season.event_id, home, away, String(offsetDays), status])).rows[0].id;
const open = (C, category, extra = {}, token = C.org.token) => api('POST', '/discipline/cases', { token, body: { competition_id: C.cm.id, season_id: C.season.id, category, subject_user_id: C.player.id, subject_team_id: C.A.id, source: { type: 'official_report', id: fid() }, summary: 'Reported by the referee', ...extra } });

test('policy is versioned and immutable; the sport vocabulary walks the whole catalogue with labelled fallbacks', async () => {
  const C = await comp();
  assert.equal(C.pol.version, 1);
  const p2 = must(await api('POST', `/competitions/${C.cm.id}/discipline-policy`, { token: C.org.token, body: { rules: { appeal_window_days: 5 } } }), 201);
  assert.equal(p2.version, 2);
  await assert.rejects(pool.query('UPDATE disc_policies SET note=$2 WHERE id=$1', [C.pol.id, 'x']), /append-only/);
  assert.equal((await api('POST', `/competitions/${C.cm.id}/discipline-policy`, { token: (await signup(['organizer'])).token, body: { rules: {} } })).status, 404);
  assert.equal((await api('POST', `/competitions/${C.cm.id}/discipline-policy`, { token: C.org.token, body: { rules: { nonsense: 1 } } })).status, 400);
  const got = must(await api('GET', `/competitions/${C.cm.id}/discipline-policy`));
  assert.equal(got.current.version, 2); assert.equal(got.versions.length, 2); assert.equal(got.vocabulary.native, true);
  const sports = (await pool.query('SELECT slug, scoring, category FROM sports')).rows;
  assert.ok(sports.length > 10);
  const fallback = [];
  for (const s of sports) { const m = modelFor(s); assert.ok(m.caution && m.dismissal && typeof m.native === 'boolean', s.slug); if (!m.native) fallback.push(s.slug); }
  assert.ok(fallback.length < sports.length, 'most sports use a native vocabulary');
  console.log(`# discipline vocabulary: ${sports.length - fallback.length} native, ${fallback.length} labelled fallback`);
});

test('cautions accumulate to an automatic suspension exactly once, even concurrently; the engine blocks the player live; served matches ignore postponed games', async () => {
  const C = await comp();
  const stranger = await signup();
  assert.equal((await open(C, 'caution', {}, stranger.token)).status, 404);
  assert.equal((await open(C, 'caution', { subject_team_id: undefined })).status, 400, 'a caution names the team the person serves with');
  for (let k = 0; k < 4; k++) { const r = must(await open(C, 'caution'), 201); assert.equal(r.auto_case_id, null); }
  const [r5, r6] = await Promise.all([open(C, 'caution'), open(C, 'caution')]);
  must(r5, 201); must(r6, 201);
  const autos = (await pool.query("SELECT id FROM gov_cases WHERE competition_id=$1 AND category='caution_accumulation'", [C.cm.id])).rows;
  assert.equal(autos.length, 1, 'the fifth caution triggers once; the sixth does not re-trigger');
  const sus = must(await api('GET', '/discipline/suspensions', { token: C.player.token, query: { user_id: C.player.id } }));
  assert.equal(sus.items.length, 1);
  assert.deepEqual([sus.items[0].matches, sus.items[0].service.remaining, sus.items[0].blocking], [1, 1, true]);
  // retrying the same incident returns the same case
  const src = fid(); const first = must(await open(C, 'misconduct', { source: { type: 'official_report', id: src } }), 201);
  assert.equal(must(await open(C, 'misconduct', { source: { type: 'official_report', id: src } }), 201).id, first.id);
  // eligibility reads the sanction LIVE: a registered player is eligible until suspended, then ineligible with a stable code
  const ev = C.season.event_id;
  must(await api('POST', `/events/${ev}/registration/policy`, { token: C.org.token, body: { expected_version: 0, rules: { require_guardian_consent: false, require_compliance: false } } }), 201);
  await pool.query('DELETE FROM disc_sanctions WHERE false');
  await pool.query("INSERT INTO reg_registrations(event_id,team_id,user_id,status,submitted_by) VALUES ($1,$2,$3,'registered',$3)", [ev, C.A.id, C.player.id]);
  const el = must(await api('GET', `/events/${ev}/eligibility`, { token: C.org.token, query: { team_id: C.A.id, user_id: C.player.id } }));
  const txt = JSON.stringify(el);
  assert.match(txt, /suspension\.fail/);
  assert.match(txt, /ineligible/);
  // the suspended match is served by the next COMPLETED fixture; a postponed or cancelled game does not count
  await fixture(C, 1, 'postponed'); await fixture(C, 2, 'cancelled');
  assert.equal(must(await api('GET', '/discipline/suspensions', { token: C.player.token, query: { user_id: C.player.id } })).items[0].service.remaining, 1);
  await fixture(C, 3, 'completed');
  const after = must(await api('GET', '/discipline/suspensions', { token: C.player.token, query: { user_id: C.player.id } })).items[0];
  assert.deepEqual([after.service.remaining, after.blocking], [0, false], 'served by a completed fixture');
  assert.doesNotMatch(JSON.stringify(must(await api('GET', `/events/${ev}/eligibility`, { token: C.org.token, query: { team_id: C.A.id, user_id: C.player.id } }))), /suspension\.fail/);
  assert.equal((await api('GET', '/discipline/suspensions', { token: stranger.token, query: { user_id: C.player.id } })).status, 404);
});

test('dismissal sets an interim suspension; the panel decides with sanctions the policy allows; appeals respect the window and the stay; reduction and reversal keep history', async () => {
  const C = await comp();
  const k = must(await open(C, 'dismissal'), 201);
  assert.equal(k.status, 'interim');
  assert.deepEqual([k.sanctions[0].status, k.sanctions[0].matches], ['interim', 2]);
  assert.match(k.events.find((e) => e.action === 'interim_set').detail.note, /not a finding/i);
  const sus0 = must(await api('GET', '/discipline/suspensions', { token: C.mA.token, query: { team_id: C.A.id } }));
  assert.equal(sus0.items[0].blocking, true);
  // only competition staff decide; the player cannot
  const dec = (token, body) => api('POST', `/governance/cases/${k.id}/decision`, { token, body });
  assert.equal((await dec(C.player.token, { expected_version: 1, outcome: 'upheld', reason: 'Nope', sanctions: [{ kind: 'warning' }] })).status, 403);
  assert.equal((await dec(C.org.token, { expected_version: 1, outcome: 'upheld', reason: 'Serious foul play', sanctions: [] })).status, 400, 'upheld needs a sanction');
  assert.equal((await dec(C.org.token, { expected_version: 7, outcome: 'upheld', reason: 'Serious foul play', sanctions: [{ kind: 'warning' }] })).body.error.details.code, 'stale_version');
  const decided = must(await dec(C.org.token, { expected_version: 1, outcome: 'upheld', reason: 'Serious foul play confirmed', sanctions: [
    { kind: 'match_suspension', matches: 3, reason: 'Three matches' }, { kind: 'fine', amount_minor: 5000, currency: 'EUR' }, { kind: 'points_deduction', points: 3, reason: 'Team conduct' }] }));
  assert.equal(decided.status, 'decided');
  assert.equal(decided.decision, 'Serious foul play confirmed');
  const interimKept = decided.sanctions.find((s) => s.matches === 2 && s.kind === 'match_suspension' && s.superseded_at);
  assert.equal(interimKept.status, 'expired', 'the interim measure is kept, superseded by the final decision, never edited');
  const adj = (await pool.query('SELECT points_delta FROM comp_adjustments WHERE season_id=$1 AND team_id=$2', [C.season.id, C.A.id])).rows;
  assert.deepEqual(adj.map((a) => a.points_delta), [-3], 'a deduction goes through the standings adjustment, never an edited result');
  const fine = decided.sanctions.find((s) => s.kind === 'fine');
  assert.equal(fine.fine_state, 'imposed');
  must(await api('POST', `/discipline/sanctions/${fine.id}/fine`, { token: C.org.token, body: { fine_state: 'invoiced', invoice_ref: 'INV-9' } }));
  assert.equal((await api('POST', `/discipline/sanctions/${fine.id}/fine`, { token: C.org.token, body: { fine_state: 'invoiced' } })).status, 409);
  assert.equal(decided.sanctions.find((s) => s.kind === 'match_suspension' && s.status === 'active').service.remaining, 3, 'a fine does not change the sporting state');
  // appeal: only the person / guardian / team manager; stay pauses the suspension
  const stranger = await signup();
  assert.equal((await api('POST', `/governance/cases/${k.id}/appeal`, { token: stranger.token, body: { grounds: 'It was not me, honestly' } })).status, 404);
  assert.equal((await api('POST', `/governance/cases/${k.id}/appeal`, { token: C.mB.token, body: { grounds: 'Not our player at all' } })).status, 404, 'the other club cannot appeal');
  const ap = must(await api('POST', `/governance/cases/${k.id}/appeal`, { token: C.player.token, body: { grounds: 'The contact was accidental and unintentional' } }), 201);
  assert.equal(ap.kind, 'appeal');
  assert.equal((await api('POST', `/governance/cases/${k.id}/appeal`, { token: C.player.token, body: { grounds: 'A second appeal for the same thing' } })).status, 409, 'one appeal per decision');
  const stayed = must(await api('GET', '/discipline/suspensions', { token: C.player.token, query: { user_id: C.player.id } }));
  assert.equal(stayed.items.every((s) => s.status === 'stayed' && s.blocking === false), true, 'stay_on_appeal: not blocking while the appeal is heard');
  assert.equal((await api('POST', `/governance/appeals/${ap.id}/decision`, { token: C.player.token, body: { expected_version: 1, outcome: 'upheld', reason: 'self' } })).status, 403);
  assert.equal((await api('POST', `/governance/appeals/${ap.id}/decision`, { token: C.org.token, body: { expected_version: 1, outcome: 'reduced', reason: 'Too long', reduced_matches: 3 } })).status, 400, 'a reduction must be shorter');
  const red = must(await api('POST', `/governance/appeals/${ap.id}/decision`, { token: C.org.token, body: { expected_version: 1, outcome: 'reduced', reason: 'Excessive for the offence', reduced_matches: 1 } }));
  assert.equal(red.outcome, 'reduced');
  const parent = must(await api('GET', `/governance/cases/${k.id}`, { token: C.org.token }));
  const live = parent.sanctions.filter((s) => s.kind === 'match_suspension' && !s.superseded_at);
  assert.deepEqual(live.map((s) => [s.status, s.matches]), [['active', 1]]);
  assert.ok(parent.sanctions.some((s) => s.matches === 3 && s.superseded_at), 'the original is kept, superseded');
  assert.ok(parent.events.some((e) => e.action === 'sanction_amended'));
  await assert.rejects(pool.query('UPDATE disc_sanctions SET matches=9 WHERE id=$1', [live[0].id]), /superseding/);
  await assert.rejects(pool.query('DELETE FROM disc_sanctions WHERE id=$1', [live[0].id]), /never deleted/);
  await assert.rejects(pool.query('DELETE FROM gov_case_events WHERE case_id=$1', [k.id]), /append-only/);
  // a separate case: window closed
  const k2 = must(await open(C, 'misconduct'), 201);
  must(await api('POST', `/governance/cases/${k2.id}/decision`, { token: C.org.token, body: { expected_version: 1, outcome: 'upheld', reason: 'Abusive language', sanctions: [{ kind: 'warning' }] } }));
  await pool.query("UPDATE gov_cases SET appeal_deadline = current_date - 1 WHERE id=$1", [k2.id]);
  assert.equal((await api('POST', `/governance/cases/${k2.id}/appeal`, { token: C.player.token, body: { grounds: 'This is far too late now' } })).body.error.details.code, 'appeal_window_closed');
  // overturned appeal on a third case reverses the deduction
  const k3 = must(await open(C, 'misconduct'), 201);
  must(await api('POST', `/governance/cases/${k3.id}/decision`, { token: C.org.token, body: { expected_version: 1, outcome: 'upheld', reason: 'Fighting', sanctions: [{ kind: 'points_deduction', points: 2 }] } }));
  const ap3 = must(await api('POST', `/governance/cases/${k3.id}/appeal`, { token: C.mA.token, body: { grounds: 'The video clearly shows otherwise' } }), 201);
  must(await api('POST', `/governance/appeals/${ap3.id}/decision`, { token: C.org.token, body: { expected_version: 1, outcome: 'overturned', reason: 'Evidence did not support it' } }));
  const adj2 = (await pool.query('SELECT points_delta, reverses_id FROM comp_adjustments WHERE season_id=$1 ORDER BY created_at', [C.season.id])).rows;
  assert.equal(adj2.reduce((a, b) => a + b.points_delta, 0), -3, 'the -2 was reversed by a +2 adjustment, the -3 stands');
});

test('policy permissions bound what a panel can impose; correction of the source flags the case; waivers use the registration exception mechanism; public view hides youth', async () => {
  const C = await comp({ rules: { fine_authority: false, points_deduction_authority: false, public_disclosure: 'sanctions' } });
  const k = must(await open(C, 'misconduct'), 201);
  const dec = (body) => api('POST', `/governance/cases/${k.id}/decision`, { token: C.org.token, body: { expected_version: 1, outcome: 'upheld', reason: 'Reason given', ...body } });
  assert.equal((await dec({ sanctions: [{ kind: 'fine', amount_minor: 100, currency: 'USD' }] })).status, 403);
  assert.equal((await dec({ sanctions: [{ kind: 'points_deduction', points: 1 }] })).status, 403);
  must(await dec({ sanctions: [{ kind: 'date_suspension', starts_on: day(0), ends_on: day(14), public: true }] }));
  const pub = must(await api('GET', `/competitions/${C.cm.id}/sanctions`));
  assert.equal(pub.items.length, 1); assert.equal(pub.items[0].kind, 'date_suspension');
  assert.equal(JSON.stringify(pub).includes('Reason given'), false, 'reasons and evidence are never public');
  await pool.query("UPDATE users SET youth_until = current_date + 300 WHERE id=$1", [C.player.id]);
  assert.equal(must(await api('GET', `/competitions/${C.cm.id}/sanctions`)).items.length, 0, 'a young person is never listed publicly');
  // source correction flags, never deletes
  const ev = (await pool.query("INSERT INTO match_events(fixture_id,event_id,seq,kind,player_id,team_id,recorded_by) VALUES ($1,$2,1,'card',$3,$4,$3) RETURNING id", [await fixture(C, -5), C.season.event_id, C.player.id, C.A.id])).rows[0];
  const fx = (await pool.query('SELECT fixture_id FROM match_events WHERE id=$1', [ev.id])).rows[0].fixture_id;
  const kc = must(await open(C, 'caution', { fixture_id: fx, source: { type: 'match_event', id: ev.id } }), 201);
  assert.equal((await open(C, 'caution', { fixture_id: fx, source: { type: 'match_event', id: fid() } })).status, 400, 'the event must belong to the fixture');
  assert.equal(await flagSourceCorrection(pool, { sourceType: 'match_event', sourceId: ev.id, reason: 'Card reassigned to another player' }), 1);
  const queue = must(await api('GET', '/governance/cases', { token: C.org.token, query: { competition_id: C.cm.id, needs_review: 'true' } }));
  assert.deepEqual(queue.items.map((x) => x.id), [kc.id]);
  assert.equal((await api('POST', `/governance/cases/${kc.id}/review`, { token: C.player.token, body: { expected_version: 2, action: 'confirm', reason: 'self confirm' } })).status, 403);
  const cleared = must(await api('POST', `/governance/cases/${kc.id}/review`, { token: C.org.token, body: { expected_version: 2, action: 'withdraw', reason: 'Card belonged to someone else' } }));
  assert.equal(cleared.status, 'withdrawn');
  assert.equal(await pool.query("SELECT count(*)::int AS n FROM gov_cases WHERE id=$1", [kc.id]).then((r) => r.rows[0].n), 1, 'withdrawn, not deleted');
  // waiver: the request references the rule; granting creates the registration exception (encrypted reason), nobody else can grant
  const w = must(await api('POST', '/governance/cases', { token: C.player.token, body: { kind: 'waiver', competition_id: C.cm.id, season_id: C.season.id, category: 'waiver', summary: 'Late registration after a medical delay', subject_user_id: C.player.id, subject_team_id: C.A.id, waiver_rule: 'window' } }), 201);
  assert.equal((await api('POST', `/governance/cases/${w.id}/decision`, { token: C.player.token, body: { expected_version: 1, outcome: 'granted', reason: 'granting myself' } })).status, 403);
  must(await api('POST', `/governance/cases/${w.id}/decision`, { token: C.org.token, body: { expected_version: 1, outcome: 'granted', reason: 'Medical evidence seen' } }));
  const ex = (await pool.query("SELECT rule_key, reason_enc FROM reg_exceptions WHERE event_id=$1 AND user_id=$2", [C.season.event_id, C.player.id])).rows;
  assert.deepEqual(ex.map((e) => e.rule_key), ['window']);
  assert.notEqual(ex[0].reason_enc, 'Medical evidence seen');
  // protest: opened by a team manager, never changes a score
  const before = (await pool.query('SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1 AND home_score IS NOT NULL', [C.season.event_id])).rows[0].n;
  const pr = must(await api('POST', '/governance/cases', { token: C.mB.token, body: { kind: 'protest', competition_id: C.cm.id, fixture_id: fx, category: 'ineligible_player', summary: 'Team A fielded an unregistered player', subject_team_id: C.A.id, subject_role: 'team', links: [{ entity_type: 'fixture', entity_id: fx }] } }), 201);
  assert.equal(pr.links.length, 1);
  assert.equal((await api('GET', `/governance/cases/${pr.id}`, { token: (await signup()).token })).status, 404);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1 AND home_score IS NOT NULL', [C.season.event_id])).rows[0].n, before);
  const tools = (await rpc('tools/list', {}, C.org.token)).tools.map((t) => t.name);
  for (const t of ['open_discipline_case', 'decide_governance_case', 'file_appeal', 'decide_appeal', 'get_suspension_status', 'publish_discipline_policy', 'list_governance_cases', 'open_governance_case']) assert.ok(tools.includes(t), t);
});
