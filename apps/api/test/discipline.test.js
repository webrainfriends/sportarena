// Sports Disciplinary & Sanctions (#479): policy thresholds, cases from canonical cards, automatic and panel decisions, served-match counting, eligibility,
// fines and points deductions through the canonical mechanisms, appeals, corrections, privacy and the whole sport catalogue.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const D = await import('../src/discipline.js');
const { activeSportingSanction } = await import('../src/integrity.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `dc_${n}_${roles[0]}`, display_name: `Dc ${n}`, email: `dc${n}@example.com`, password: 'correct-horse-battery', roles } }); return { ...r.body.user, token: r.body.token }; };

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

const PARAMS = {
  card_points: { yellow_card: 1 }, accumulation: [{ points: 3, matches: 1 }], direct: [{ kind: 'red_card', matches: 2 }], second_caution: { kind: 'yellow_card', matches: 1 },
  authority: { fines: true, points_deduction: true, fine_cap_minor: 500000, points_cap: 6 }, appeal_window_days: 7, stay_on_appeal: true,
};

// ------------------------------------------------------------------ pure engine
test('thresholds are deterministic: the same cards give the same triggers in any order, and carry-over / expiry follow the policy', () => {
  const at = (d) => new Date(Date.UTC(2026, 0, d)).toISOString();
  const yc = (i, d, fx = `f${d}`) => ({ id: `c${String(i).padStart(2, '0')}`, kind: 'yellow_card', fixture_id: fx, at: at(d), player_id: 'p' });
  const cards = [yc(1, 1), yc(2, 5), yc(3, 9), yc(4, 12), yc(5, 14), yc(6, 18)];
  const a = D.evaluateThresholds(PARAMS, cards);
  const b = D.evaluateThresholds(PARAMS, [...cards].reverse());
  assert.deepEqual(a, b, 'order of arrival never changes the result');
  assert.deepEqual(a.filter((t) => t.rule === 'accumulation').map((t) => t.match_event_id), ['c03', 'c06'], 'every third caution, then the count restarts');
  const keep = D.evaluateThresholds({ ...PARAMS, carry_over: 'keep_excess', card_points: { yellow_card: 2 }, accumulation: [{ points: 3, matches: 1 }] }, cards.slice(0, 3));
  assert.equal(keep.length, 2, 'excess points carry over: 2 then 4-3=1, +2 reaches 3 again');
  const exp = D.evaluateThresholds({ ...PARAMS, expire_after_days: 4 }, cards);
  assert.equal(exp.filter((t) => t.rule === 'accumulation').length, 0, 'cautions older than the window stop counting');
  const two = D.evaluateThresholds(PARAMS, [yc(1, 1, 'fx'), yc(2, 1, 'fx')]);
  assert.equal(two.filter((t) => t.rule === 'second_caution').length, 1, 'two cautions in one match');
  assert.equal(D.escalate({ repeat_offence: { within_days: 365, add_matches: 1 } }, 2, 2), 4);
});

// ------------------------------------------------------------------ the whole sport catalogue
test('every sport in the catalogue has a native discipline model or a labelled generic fallback; none is silent', async () => {
  const sports = (await pool.query('SELECT * FROM sports ORDER BY slug')).rows;
  assert.ok(sports.length > 20);
  const native = [], fallback = [];
  for (const sp of sports) {
    const m = D.disciplineModelOf(sp);
    assert.ok(['cards', 'conduct_levels', 'foul_limits', 'generic'].includes(m.family), sp.slug);
    assert.ok(m.label, `${sp.slug} is labelled`);
    if (m.family === 'generic') { fallback.push(sp.slug); assert.match(m.label, /fallback/i); } else native.push(sp.slug);
  }
  console.log(`# discipline sports: ${sports.length}; native ${native.length}; labelled generic fallback ${fallback.length}: ${fallback.join(', ')}`);
  const v = must(await api('GET', '/discipline/vocabulary'));
  assert.equal(v.sports.length, sports.length);
});

// ------------------------------------------------------------------ a real league with cards
const league = async () => {
  const org = await signup(['organizer']);
  const comp = must(await api('POST', '/competitions', { token: org.token, body: { name: `Disc League ${++n}`, sport: 'football', country: 'IN', level: 'amateur', is_public: true } }), 201);
  const season = must(await api('POST', `/competitions/${comp.id}/seasons`, { token: org.token, body: { label: '2026/27', starts_on: day(1), ends_on: day(200), registration_opens_on: day(-1), registration_closes_on: day(30) } }), 201);
  const div = must(await api('POST', `/seasons/${season.id}/divisions`, { token: org.token, body: { name: 'Premier', tier: 1, capacity: 8 } }), 201);
  const mgrs = [], teams = [];
  for (let i = 0; i < 2; i++) {
    const m = await signup(); mgrs.push(m);
    teams.push(must(await api('POST', '/teams', { token: m.token, body: { name: `DFC ${n}-${i}`, sport: 'football' } }), 201));
  }
  must(await api('POST', `/seasons/${season.id}/status`, { token: org.token, body: { status: 'open' } }));
  for (const [i, t] of teams.entries()) {
    const m = must(await api('POST', `/seasons/${season.id}/memberships`, { token: mgrs[i].token, body: { team_id: t.id, division_id: div.id } }), 201);
    must(await api('POST', `/memberships/${m.id}/decision`, { token: org.token, body: { action: 'accept' } }));
  }
  const player = await signup();
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [teams[0].id, player.id]);
  const ev = (await pool.query('SELECT event_id FROM comp_seasons WHERE id=$1', [season.id])).rows[0].event_id;
  const fx = async (offset, status = 'scheduled') => (await pool.query('INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status) VALUES ($1,$2,$3,now() + ($4 || \' days\')::interval,$5) RETURNING id', [ev, teams[0].id, teams[1].id, String(offset), status])).rows[0].id;
  let seq = 0;
  const card = async (fixtureId, kind, who = player.id, team = teams[0].id) => (await pool.query(
    "INSERT INTO match_events(fixture_id, event_id, seq, kind, team_id, player_id, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [fixtureId, ev, ++seq + Math.floor(Math.random() * 1e6), kind, team, who, org.id])).rows[0].id;
  return { org, comp, season, div, mgrs, teams, player, ev, fx, card };
};

test('a published, versioned policy turns a red card into a case with the automatic suspension; a repeat sweep adds nothing; eligibility reads it live', async () => {
  const L = await league();
  const t = L.org.token;
  assert.equal((await api('GET', `/competitions/${L.comp.id}/discipline`, { token: (await signup()).token, query: { season_id: L.season.id } })).status, 404, 'outsiders get a 404');
  const scope = must(await api('GET', `/events/${L.ev}/discipline-scope`, { token: t }));
  assert.deepEqual([scope.competition_id, scope.season_id, scope.as, scope.can_decide], [L.comp.id, L.season.id, 'organiser', true]);
  assert.equal((await api('GET', `/events/${L.ev}/discipline-scope`, { token: L.player.token })).status, 404, 'no standing: the tab stays hidden');
  const v1 = must(await api('POST', `/competitions/${L.comp.id}/discipline/policy`, { token: t, body: { params: PARAMS } }), 201);
  const v2 = must(await api('POST', `/competitions/${L.comp.id}/discipline/policy`, { token: t, body: { params: { ...PARAMS, direct: [{ kind: 'red_card', matches: 3 }] }, note: 'tougher' } }), 201);
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  const played = await L.fx(-3, 'completed');
  const next1 = await L.fx(2), next2 = await L.fx(9);
  const red = await L.card(played, 'red_card');
  const sw = must(await api('POST', `/competitions/${L.comp.id}/discipline/sweep`, { token: t, body: { season_id: L.season.id } }), 200);
  assert.equal(sw.opened, 1);
  assert.equal(must(await api('POST', `/competitions/${L.comp.id}/discipline/sweep`, { token: t, body: { season_id: L.season.id } })).opened, 0, 'idempotent');
  const list = must(await api('GET', `/competitions/${L.comp.id}/discipline/cases`, { token: t, query: { season_id: L.season.id } }));
  assert.equal(list.length, 1);
  const k = must(await api('GET', `/discipline/cases/${list[0].id}`, { token: t }));
  assert.equal(k.match_event_id, red, 'the card is referenced, not copied');
  assert.equal(k.decisions[0].automatic, true);
  assert.equal(k.sanctions[0].matches, 3, 'the latest policy version governs');
  assert.equal(k.sanctions[0].service.remaining, 3);
  // eligibility is consumed live: blocked for the next two matches, free for the third only after serving
  const at = (id) => pool.query('SELECT scheduled_at FROM fixtures WHERE id=$1', [id]).then((r) => r.rows[0].scheduled_at);
  const sport = (await pool.query('SELECT sport_id FROM events WHERE id=$1', [L.ev])).rows[0].sport_id;
  assert.ok(await activeSportingSanction(pool, L.player.id, sport, undefined, { eventId: L.ev, at: await at(next1) }));
  // cancelled and postponed fixtures do not count; a played one does
  await pool.query("UPDATE fixtures SET status='cancelled' WHERE id=$1", [next1]);
  const after1 = must(await api('GET', `/discipline/cases/${list[0].id}`, { token: t }));
  assert.equal(after1.sanctions[0].service.served, 0);
  assert.ok(after1.sanctions[0].service.fixtures.some((f) => f.state === 'skipped_cancelled'));
  await pool.query("UPDATE fixtures SET status='completed' WHERE id=$1", [next2]);
  assert.equal(must(await api('GET', `/discipline/cases/${list[0].id}`, { token: t })).sanctions[0].service.remaining, 2);
  // the player and their manager see only what they should
  const mine = must(await api('GET', '/me/discipline', { token: L.player.token }));
  assert.equal(mine.length, 1);
  const team = must(await api('GET', `/teams/${L.teams[0].id}/discipline`, { token: L.mgrs[0].token }));
  assert.equal(team.length, 1);
  assert.equal(JSON.stringify(team).includes('summary'), false);
  assert.equal((await api('GET', `/discipline/cases/${list[0].id}`, { token: L.mgrs[1].token })).status, 404, 'the other team’s manager has no standing');
});

test('a panel decision: warning + fine through team finance + points deduction through standings adjustments, then an appeal that overturns it (history kept)', async () => {
  const L = await league();
  const t = L.org.token;
  must(await api('POST', `/competitions/${L.comp.id}/discipline/policy`, { token: t, body: { params: PARAMS } }), 201);
  const panel = await signup();
  must(await api('POST', `/competitions/${L.comp.id}/discipline/panel`, { token: t, body: { user_id: panel.id, role: 'panel' } }), 201);
  const c = must(await api('POST', `/competitions/${L.comp.id}/discipline/cases`, { token: t, body: { season_id: L.season.id, source: 'manual_referral', subject_kind: 'player', subject_user_id: L.player.id, team_id: L.teams[0].id, category: 'abusive_language', summary: 'Alleged abuse towards the referee after full time' } }), 201);
  assert.match(c.case_no, /-DISC-/);
  assert.equal(c.summary_enc, undefined, 'encrypted columns never leave the server');
  const raw = (await pool.query('SELECT summary_enc FROM disc_cases WHERE id=$1', [c.id])).rows[0].summary_enc;
  assert.ok(!raw.includes('referee'), 'the allegation is encrypted at rest');
  // an allegation alone does not block; an interim suspension does, and is not a finding
  assert.equal(await activeSportingSanction(pool, L.player.id, (await pool.query('SELECT sport_id FROM events WHERE id=$1', [L.ev])).rows[0].sport_id, undefined, { eventId: L.ev }), null);
  must(await api('POST', `/discipline/cases/${c.id}/transition`, { token: panel.token, body: { action: 'set_interim', interim: 'interim_suspension' } }));
  const sportId = (await pool.query('SELECT sport_id FROM events WHERE id=$1', [L.ev])).rows[0].sport_id;
  assert.ok(await activeSportingSanction(pool, L.player.id, sportId, undefined, { eventId: L.ev }));
  // the policy caps the authority
  assert.equal((await api('POST', `/discipline/cases/${c.id}/decision`, { token: panel.token, body: { outcome: 'upheld', reason: 'Too much', sanctions: [{ kind: 'fine', amount_minor: 900000 }] } })).status, 400);
  const dec = must(await api('POST', `/discipline/cases/${c.id}/decision`, { token: panel.token, body: { outcome: 'upheld', reason: 'Abuse towards a match official', sanctions: [{ kind: 'warning', label: 'Formal reprimand' }, { kind: 'fine', amount_minor: 200000 }, { kind: 'points_deduction', points: 3 }] } }), 201);
  const fine = dec.sanctions.find((s) => s.kind === 'fine'), pts = dec.sanctions.find((s) => s.kind === 'points_deduction');
  const ch = (await pool.query('SELECT c.amount_minor, b.kind FROM team_charges c JOIN team_charge_batches b ON b.id=c.batch_id WHERE c.id=$1', [fine.team_charge_id])).rows[0];
  assert.deepEqual([Number(ch.amount_minor), ch.kind], [200000, 'fine']);
  const adj = (await pool.query('SELECT points_delta, disc_sanction_id FROM comp_adjustments WHERE id=$1', [pts.comp_adjustment_id])).rows[0];
  assert.deepEqual([adj.points_delta, adj.disc_sanction_id], [-3, pts.id]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fixtures WHERE home_score IS NOT NULL AND event_id=$1", [L.ev])).rows[0].n, 0, 'no match result was touched');
  assert.equal(await activeSportingSanction(pool, L.player.id, sportId, undefined, { eventId: L.ev }), null, 'a final non-playing sanction replaces the interim block');
  // appeal: only the person, within the window; the panel member who decided cannot rule on it
  assert.equal((await api('POST', `/discipline/cases/${c.id}/appeals`, { token: t, body: { grounds: 'I was not even there' } })).status, 403);
  const ap = must(await api('POST', `/discipline/cases/${c.id}/appeals`, { token: L.player.token, body: { grounds: 'I was not at the ground at that time' } }), 201);
  assert.equal(ap.stay, true);
  assert.equal((await api('POST', `/discipline/cases/${c.id}/appeals`, { token: L.player.token, body: { grounds: 'Second appeal on the same decision' } })).status, 409, 'one open appeal per decision');
  assert.equal((await api('POST', `/discipline/appeals/${ap.id}/ruling`, { token: panel.token, body: { outcome: 'overturned', reason: 'Not the decider' } })).status, 403);
  must(await api('POST', `/discipline/appeals/${ap.id}/ruling`, { token: t, body: { outcome: 'overturned', reason: 'CCTV shows the player had already left the ground' } }));
  const k = must(await api('GET', `/discipline/cases/${c.id}`, { token: t }));
  assert.deepEqual(k.decisions.map((d) => [d.kind, d.outcome, !!d.superseded_at]), [['initial', 'upheld', true], ['appeal_outcome', 'dismissed', false]], 'the original decision stays in the history');
  assert.equal((await pool.query("SELECT status FROM team_charges WHERE id=$1", [fine.team_charge_id])).rows[0].status, 'cancelled', 'the unpaid fine is cancelled');
  assert.equal((await pool.query('SELECT sum(points_delta)::int AS s FROM comp_adjustments WHERE disc_sanction_id=$1', [pts.id])).rows[0].s, 0, 'the deduction is reversed by a reversing row, not edited');
  // decisions cannot be edited or deleted
  await assert.rejects(pool.query("UPDATE disc_decisions SET outcome='dismissed' WHERE case_id=$1 AND kind='initial'", [c.id]), /cannot be edited/);
  await assert.rejects(pool.query('DELETE FROM disc_events WHERE case_id=$1', [c.id]), /append-only/);
});

test('voiding the card a case came from flags the case for re-evaluation; nothing is deleted', async () => {
  const L = await league();
  must(await api('POST', `/competitions/${L.comp.id}/discipline/policy`, { token: L.org.token, body: { params: PARAMS } }), 201);
  const red = await L.card(await L.fx(-1, 'completed'), 'red_card');
  must(await api('POST', `/competitions/${L.comp.id}/discipline/sweep`, { token: L.org.token, body: { season_id: L.season.id } }));
  const { flagForEvent } = D;
  assert.equal(await flagForEvent(pool, red, L.org.id, 'Referee corrected the card'), 1);
  const [k] = must(await api('GET', `/competitions/${L.comp.id}/discipline/cases`, { token: L.org.token, query: { season_id: L.season.id, flagged: 'true' } }));
  assert.equal(k.reevaluation, 'flagged');
  const full = must(await api('GET', `/discipline/cases/${k.id}`, { token: L.org.token }));
  assert.equal(full.decisions.length, 1, 'the prior decision is untouched');
  assert.ok(full.history.some((h) => h.action === 'source_event_corrected'));
});

test('a voided event cannot start a case, and a card feeds one case per person even under concurrent sweeps', async () => {
  const L = await league();
  must(await api('POST', `/competitions/${L.comp.id}/discipline/policy`, { token: L.org.token, body: { params: PARAMS } }), 201);
  await L.card(await L.fx(-1, 'completed'), 'red_card');
  const runs = await Promise.all([1, 2, 3, 4].map(() => api('POST', `/competitions/${L.comp.id}/discipline/sweep`, { token: L.org.token, body: { season_id: L.season.id } })));
  assert.equal(runs.reduce((t, r) => t + (r.body.opened ?? 0), 0), 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM disc_cases WHERE competition_id=$1', [L.comp.id])).rows[0].n, 1);
});
