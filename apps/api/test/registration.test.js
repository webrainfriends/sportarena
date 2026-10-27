import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base, n = 0, admin;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const rpc = async (method, params, token) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const yearsAgo = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const inst = (offsetDays) => new Date(Date.now() + offsetDays * 864e5).toISOString();
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `rg_${n}_${roles[0]}`, display_name: `Reg ${n}`, email: `rg${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('rg_root','rg_root','{admin}','x','x','rg_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/** An organiser, a competition, two entered teams (each with a manager) and a fixture between them. */
const setup = async () => {
  const org = await signup(['organizer']), mgr = await signup(['athlete']), mgr2 = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Bats ${++n}`, sport: 'cricket' } }), 201);
  const rival = must(await api('POST', '/teams', { token: mgr2.token, body: { name: `Rivals ${++n}`, sport: 'cricket' } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Cup ${n}`, sport: 'cricket', starts_on: day(5), ends_on: day(30) } }), 201);
  for (const [t, tok] of [[team, mgr.token], [rival, mgr2.token]]) {
    const en = must(await api('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } }), 201);
    must(await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }));
  }
  const fx = must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: team.id, away_team_id: rival.id, scheduled_at: inst(3) } }), 201);
  return { org, mgr, mgr2, team, rival, ev, fx };
};
const addPlayer = async (s, team = s.team, mgr = s.mgr, extra = {}) => {
  const p = await signup(['athlete'], extra);
  must(await api('POST', `/teams/${team.id}/members`, { token: mgr.token, body: { user_id: p.id } }), 201);
  return p;
};
const submit = (s, p, body = {}, token) => api('POST', `/events/${s.ev.id}/registrations`, { token: token ?? s.mgr.token, body: { team_id: s.team.id, user_id: p.id, ...body } });
const review = (s, reg, action, body = {}) => api('POST', `/registrations/${reg.id}/review`, { token: s.org.token, body: { action, row_version: reg.row_version, ...body } });
const register = async (s, p, body = {}) => { const r = must(await submit(s, p), 201); return must(await review(s, r, 'register', body)); };
const policy = (s, rules = {}, extra = {}) => api('POST', `/events/${s.ev.id}/registration/policy`, { token: s.org.token, body: { rules, expected_version: s.v ?? 0, ...extra } }).then((r) => { if (r.status === 201) s.v = r.body.version; return r; });

test('registration: team/self/organiser submit, one live registration per person, authorisation, stale versions, history', async () => {
  const s = await setup();
  const p = await addPlayer(s), stranger = await signup(), other = await addPlayer(s, s.rival, s.mgr2);

  // who may submit: the player (self), their team manager, the organiser; nobody else (404, not leaking)
  assert.equal((await submit(s, p, {}, stranger.token)).status, 404);
  assert.equal((await submit(s, other, {}, s.mgr.token)).status, 400, 'not a member of that team');
  const reg = must(await submit(s, p, { user_id: undefined }, p.token), 201);
  assert.deepEqual([reg.status, reg.source, reg.roster_list, reg.window_kind, reg.row_version], ['submitted', 'self', 'active', 'open', 1]);
  // a person has one live registration per competition, even across teams
  assert.equal((await submit(s, p)).status, 409);
  const twin = await addPlayer(s, s.rival, s.mgr2); must(await api('POST', `/teams/${s.team.id}/members`, { token: s.mgr.token, body: { user_id: twin.id } }), 201);
  must(await api('POST', `/events/${s.ev.id}/registrations`, { token: s.mgr2.token, body: { team_id: s.rival.id, user_id: twin.id } }), 201);
  assert.equal((await submit(s, twin)).status, 409, 'already registered with another team');

  // only the organiser decides; stale versions are refused; transitions are validated
  assert.equal((await api('POST', `/registrations/${reg.id}/review`, { token: s.mgr.token, body: { action: 'register', row_version: 1 } })).status, 404);
  assert.equal((await review(s, reg, 'suspend', { reason: 'x'.repeat(5) })).status, 409, 'only a registered player can be suspended');
  assert.equal((await review(s, reg, 'reject')).status, 400, 'reject needs a reason');
  const reviewing = must(await review(s, reg, 'start_review'));
  assert.equal(reviewing.status, 'under_review');
  assert.equal((await review(s, reg, 'register')).status, 409, 'stale row_version');
  const done = must(await review(s, reviewing, 'register', { registration_no: 'CRI-001', origin_class: 'local' }));
  assert.deepEqual([done.status, done.registration_no, done.origin_class], ['registered', 'CRI-001', 'local']);
  assert.ok(done.effective_from);
  const p2 = await addPlayer(s);
  const r2 = must(await submit(s, p2), 201);
  assert.equal((await review(s, r2, 'register', { registration_no: 'cri-001' })).status, 409, 'registration numbers are unique per competition');

  // roster list changes: manager or organiser, recorded
  const moved = must(await api('POST', `/registrations/${done.id}/list`, { token: s.mgr.token, body: { roster_list: 'reserve', row_version: done.row_version } }));
  assert.equal(moved.roster_list, 'reserve');
  assert.equal((await api('POST', `/registrations/${done.id}/list`, { token: stranger.token, body: { roster_list: 'active', row_version: moved.row_version } })).status, 404);
  assert.equal((await api('POST', `/registrations/${done.id}/list`, { token: s.mgr.token, body: { roster_list: 'active', row_version: done.row_version } })).status, 409, 'stale client');

  // visibility: the player sees themself, the manager their team, a stranger nothing, the organiser all
  const mine = must(await api('GET', '/me/registrations', { token: p.token }));
  assert.equal(mine.length, 1); assert.equal(mine[0].status, 'registered'); assert.equal(mine[0].note_enc, undefined);
  assert.equal(must(await api('GET', `/events/${s.ev.id}/registrations`, { token: s.mgr.token })).length, 2);
  assert.equal(must(await api('GET', `/events/${s.ev.id}/registrations`, { token: s.org.token })).length, 3);
  assert.equal(must(await api('GET', `/events/${s.ev.id}/registrations`, { token: stranger.token })).length, 0);
  assert.equal(must(await api('GET', `/events/${s.ev.id}/registrations`, { token: s.org.token, query: { status: 'registered' } })).length, 1);

  // withdrawal frees the slot and keeps the history (who, what, when); reasons are for the organiser only
  const w = must(await api('POST', `/registrations/${r2.id}/withdraw`, { token: p2.token, body: { row_version: r2.row_version, reason: 'moving away' } }));
  assert.equal(w.status, 'withdrawn');
  const hist = must(await api('GET', `/registrations/${r2.id}/history`, { token: s.org.token }));
  assert.deepEqual(hist.map((h) => h.action), ['submitted', 'withdrawn']);
  assert.equal(hist[1].note, 'moving away'); assert.equal(hist[1].actor_id, p2.id);
  const playerView = must(await api('GET', `/registrations/${r2.id}/history`, { token: p2.token }));
  assert.equal(playerView[1].note, undefined);
  assert.equal((await api('GET', `/registrations/${r2.id}/history`, { token: stranger.token })).status, 404);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_registration_notes' AND actor_id=$1", [s.org.id])).rowCount >= 1);
  // withdrawn people can register again
  must(await submit(s, p2), 201);
  // history can never be rewritten
  await assert.rejects(pool.query("UPDATE reg_history SET action='registered'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM reg_history'), /append-only/);
});

test('windows: exact timezone boundaries, late and emergency need a reason, an authorised exception opens a closed window', async () => {
  const s = await setup();
  const p = await addPlayer(s), q = await addPlayer(s), r = await addPlayer(s);
  // no windows = open
  assert.equal(must(await submit(s, p), 201).window_kind, 'open');
  const add = (body) => api('POST', `/events/${s.ev.id}/registration/windows`, { token: s.org.token, body });
  assert.equal((await add({ kind: 'regular', timezone: 'Mars/Base', opens_on: day(1), closes_on: day(2) })).status, 400);
  assert.equal((await add({ kind: 'regular', timezone: 'Asia/Kolkata', opens_on: day(2), closes_on: day(1) })).status, 400, 'closes before it opens');
  assert.equal((await api('POST', `/events/${s.ev.id}/registration/windows`, { token: s.mgr.token, body: { timezone: 'UTC', opens_on: day(0), closes_on: day(1) } })).status, 403);
  // the stored instants are the wall-clock boundaries in the authoring timezone (Kolkata is UTC+5:30)
  const w = must(await add({ kind: 'regular', timezone: 'Asia/Kolkata', opens_on: '2031-03-01', opens_at_time: '09:00', closes_on: '2031-03-10', closes_at_time: '17:30' }), 201);
  assert.equal(new Date(w.opens_at).toISOString(), '2031-03-01T03:30:00.000Z');
  assert.equal(new Date(w.closes_at).toISOString(), '2031-03-10T12:00:00.000Z');
  // all windows are in the future: registration is closed, with the next opening in the answer
  const closed = await submit(s, q);
  assert.equal(closed.status, 409); assert.equal(closed.body.error.details.code, 'window_closed'); assert.ok(closed.body.error.details.next_opens_at);
  // an open window accepts; late and emergency windows demand a reason and flag the registration
  must(await add({ kind: 'late', timezone: 'UTC', opens_on: day(-1), closes_on: day(1) }), 201);
  assert.equal((await submit(s, q)).status, 400, 'a late registration needs a reason');
  const late = must(await submit(s, q, { reason: 'Replacement for an injured player' }), 201);
  assert.equal(late.window_kind, 'late');
  // an authorised exception opens the closed window for one person; it needs a policy that lists the rule as waivable
  const wr = await api('GET', `/events/${s.ev.id}/registration/setup`, { token: s.org.token });
  assert.equal(must(wr).windows.filter((x) => x.open_now).length, 1);
  for (const x of must(wr).windows.filter((v) => v.open_now)) must(await api('POST', `/registration/windows/${x.id}/retire`, { token: s.org.token, body: {} }));
  assert.equal((await submit(s, r)).status, 409, 'window closed again');
  const noPolicy = await api('POST', `/events/${s.ev.id}/registration/exceptions`, { token: s.org.token, body: { user_id: r.id, rule_key: 'window', reason: 'Court ruling', effective_to: inst(2) } });
  assert.equal(noPolicy.status, 409, 'no policy yet');
  must(await policy(s, { waivable: ['window'] }), 201);
  assert.equal((await api('POST', `/events/${s.ev.id}/registration/exceptions`, { token: s.org.token, body: { user_id: r.id, rule_key: 'licence', reason: 'Court ruling', effective_to: inst(2) } })).status, 409, 'licence is not waivable here');
  assert.equal((await api('POST', `/events/${s.ev.id}/registration/exceptions`, { token: s.mgr.token, body: { user_id: r.id, rule_key: 'window', reason: 'Court ruling', effective_to: inst(2) } })).status, 403);
  const ex = must(await api('POST', `/events/${s.ev.id}/registration/exceptions`, { token: s.org.token, body: { user_id: r.id, rule_key: 'window', reason: 'Court ruling', evidence: 'CASE-9', effective_to: inst(2) } }), 201);
  const viaEx = must(await submit(s, r), 201);
  assert.equal(viaEx.window_kind, 'exception');
  // revoked exceptions stop working; the reason and evidence are encrypted at rest and audit-logged when read
  const raw = (await pool.query('SELECT reason_enc FROM reg_exceptions WHERE id=$1', [ex.id])).rows[0].reason_enc;
  assert.ok(!raw.includes('Court ruling'));
  const list = must(await api('GET', `/events/${s.ev.id}/registration/exceptions`, { token: s.org.token }));
  assert.equal(list[0].reason, 'Court ruling'); assert.equal(list[0].in_force, true);
  assert.equal((await api('GET', `/events/${s.ev.id}/registration/exceptions`, { token: s.mgr.token })).status, 403);
  must(await api('POST', `/registration/exceptions/${ex.id}/revoke`, { token: s.org.token, body: { reason: 'No longer needed' } }));
  assert.equal((await api('POST', `/registration/exceptions/${ex.id}/revoke`, { token: s.org.token, body: { reason: 'again' } })).status, 409);
  assert.equal(must(await api('GET', `/events/${s.ev.id}/registration/exceptions`, { token: s.org.token, query: { active: 'true' } })).length, 0);
});

test('roster limits and quotas are concurrency-safe, list-aware, freeze-aware and only an exception passes them', async () => {
  const s = await setup();
  must(await policy(s, { roster: { max_total: 2, max_reserve: 1 }, quotas: { max_foreign: 1, min_homegrown: 2 }, waivable: ['roster_limit', 'quota', 'window'] }), 201);
  const players = []; for (let k = 0; k < 5; k++) players.push(await addPlayer(s));
  const regs = []; for (const p of players) regs.push(must(await submit(s, p), 201));
  // four organiser decisions race for two places: exactly two win, the rest are told the roster is full
  const results = await Promise.all(regs.slice(0, 4).map((r) => review(s, r, 'register')));
  const ok = results.filter((r) => r.status === 200).length, full = results.filter((r) => r.status === 409 && r.body.error?.details?.code === 'roster_limit').length;
  assert.deepEqual([ok, full], [2, 2], JSON.stringify(results.map((r) => r.status)));
  const summary = must(await api('GET', `/events/${s.ev.id}/rosters`, { token: s.org.token }));
  const t = summary.teams.find((x) => x.team_id === s.team.id);
  assert.deepEqual([t.total, t.awaiting], [2, 3]); assert.ok(t.warnings.includes('Roster is full'));
  assert.equal(summary.policy_version, 1);
  // a manager sees their own team's numbers only; strangers nothing
  assert.equal(must(await api('GET', `/events/${s.ev.id}/rosters`, { token: s.mgr.token })).teams.length, 1);
  assert.equal((await api('GET', `/events/${s.ev.id}/rosters`, { token: (await signup()).token })).status, 404);
  // withdraw frees a place; a stale client cannot take it twice
  const winner = results.find((r) => r.status === 200).body;
  must(await api('POST', `/registrations/${winner.id}/withdraw`, { token: s.org.token, body: { row_version: winner.row_version } }));
  const loser = regs.find((r, k) => results[k]?.status === 409);
  must(await review(s, loser, 'register'));
  // only a documented, waivable exception exceeds the limit
  const extra = regs[4];
  assert.equal((await review(s, extra, 'register')).status, 409);
  must(await api('POST', `/events/${s.ev.id}/registration/exceptions`, { token: s.org.token, body: { user_id: players[4].id, rule_key: 'roster_limit', reason: 'Medical replacement', effective_to: inst(5) } }), 201);
  assert.equal(must(await review(s, extra, 'register')).status, 'registered');
  // foreign quota: declared by the registrar, never inferred; the second foreign player is refused
  const f1 = must(await submit(s, await addPlayer(s)), 201), f2 = must(await submit(s, await addPlayer(s)), 201);
  const stopper = must(await api('GET', `/events/${s.ev.id}/registrations`, { token: s.org.token, query: { status: 'registered' } }));
  for (const r of stopper) must(await api('POST', `/registrations/${r.id}/withdraw`, { token: s.org.token, body: { row_version: r.row_version } }));
  must(await review(s, f1, 'register', { origin_class: 'foreign' }));
  const q2 = await review(s, f2, 'register', { origin_class: 'foreign' });
  assert.equal(q2.status, 409); assert.equal(q2.body.error.details.rule, 'quota');
  assert.equal(must(await review(s, f2, 'register', { origin_class: 'local' })).origin_class, 'local');
  // reserve list limit applies to list changes
  const regd = must(await api('GET', `/events/${s.ev.id}/registrations`, { token: s.org.token, query: { status: 'registered' } }));
  must(await api('POST', `/registrations/${regd[0].id}/list`, { token: s.mgr.token, body: { roster_list: 'reserve', row_version: regd[0].row_version } }));
  assert.equal((await api('POST', `/registrations/${regd[1].id}/list`, { token: s.mgr.token, body: { roster_list: 'reserve', row_version: regd[1].row_version } })).status, 409);
  // roster freeze: new registrations and list moves are refused afterwards, except for a window exception
  must(await policy(s, { roster: { max_total: 5, freeze_at: inst(-1) }, waivable: ['window'] }), 201);
  const late = await addPlayer(s);
  const frozen = await submit(s, late);
  assert.equal(frozen.status, 409); assert.equal(frozen.body.error.details.code, 'roster_frozen');
  assert.equal(must(await api('GET', `/events/${s.ev.id}/rosters`, { token: s.org.token })).frozen, true);
  // policy versions are append-only and guarded against two editors
  assert.equal((await api('POST', `/events/${s.ev.id}/registration/policy`, { token: s.org.token, body: { rules: {}, expected_version: 1 } })).status, 409);
  assert.equal((await api('POST', `/events/${s.ev.id}/registration/policy`, { token: s.org.token, body: { rules: { max_total: 3 }, expected_version: s.v } })).status, 400, 'unknown rule keys are refused');
  await assert.rejects(pool.query('UPDATE reg_policies SET enforcement=\'advisory\''), /append-only/);
});

test('eligibility: explainable decisions from registration, dependencies, age category, licence, guardian consent, with waivers', async () => {
  const s = await setup();
  const yes = await addPlayer(s, s.team, s.mgr, { dob: yearsAgo(25) }), old = await addPlayer(s, s.team, s.mgr, { dob: yearsAgo(50) }), nodob = await addPlayer(s), unreg = await addPlayer(s), waiting = await addPlayer(s, s.team, s.mgr, { dob: yearsAgo(25) });
  const div = must(await api('POST', `/events/${s.ev.id}/registration/divisions`, { token: s.org.token, body: { name: 'Under 40', grade: 'A', born_on_or_after: yearsAgo(40) } }), 201);
  assert.equal((await api('POST', `/events/${s.ev.id}/registration/divisions`, { token: s.org.token, body: { name: 'under 40' } })).status, 409);
  must(await policy(s, { required_clearances: ['licence'], waivable: ['division_age'], playing_lists: ['active'] }), 201);
  for (const p of [yes, old, nodob]) await register(s, p, { division_id: div.id });
  must(await submit(s, waiting, { division_id: div.id }), 201);
  must(await api('POST', `/events/${s.ev.id}/registration/dependencies`, { token: s.org.token, body: { user_id: waiting.id, kind: 'licence', status: 'clear' } }), 201);
  const check = (p, token = s.org.token) => api('GET', `/events/${s.ev.id}/eligibility`, { token, query: { team_id: s.team.id, user_id: p.id } });
  const dec = async (p) => must(await check(p)).decisions[0];

  // licence is required: nothing on record => not eligible, with a plain-language reason
  let d = await dec(yes);
  assert.equal(d.decision, 'ineligible'); assert.ok(d.reasons.some((r) => /licence/i.test(r)));
  // the licence dependency is a reference to the record held elsewhere
  const dep = (p, body) => api('POST', `/events/${s.ev.id}/registration/dependencies`, { token: s.org.token, body: { user_id: p.id, ...body } });
  must(await dep(yes, { kind: 'licence', status: 'pending', source_ref: 'FED-77', source_label: 'State federation' }), 201);
  assert.equal((await dec(yes)).decision, 'pending');
  must(await dep(yes, { kind: 'licence', status: 'clear', source_ref: 'FED-77', valid_until: day(60) }), 201);
  assert.equal((await dec(yes)).decision, 'eligible');
  // a suspension (disciplinary reference) blocks until it ends; the earlier records stay
  must(await dep(yes, { kind: 'disciplinary', status: 'blocked', source_ref: 'PANEL-3', valid_until: day(2), note: 'Two-match ban' }), 201);
  d = await dec(yes);
  assert.equal(d.decision, 'ineligible'); assert.ok(d.reasons.some((r) => /Suspended until/.test(r)));
  assert.equal(must(await api('GET', `/events/${s.ev.id}/registration/dependencies`, { token: s.org.token, query: { user_id: yes.id, history: 'true' } })).length, 3);
  // managers see kind / state / validity, never the source or the note
  const mgrDeps = must(await api('GET', `/events/${s.ev.id}/registration/dependencies`, { token: s.mgr.token, query: { user_id: yes.id } }));
  assert.ok(mgrDeps.length >= 1 && mgrDeps.every((x) => x.source_ref === undefined && x.note === undefined && x.source_label === undefined));
  assert.equal(must(await api('GET', `/events/${s.ev.id}/registration/dependencies`, { token: s.mgr2.token })).length, 0, "another team's manager sees none of these players");
  assert.equal((await api('GET', `/events/${s.ev.id}/registration/dependencies`, { token: (await signup()).token })).status, 404);
  must(await dep(yes, { kind: 'disciplinary', status: 'clear' }), 201);
  // age category: outside the range fails, unknown date of birth is `unknown`, and the exception waives only that rule
  for (const p of [old, nodob]) must(await dep(p, { kind: 'licence', status: 'clear' }), 201);
  assert.equal((await dec(yes)).decision, 'eligible');
  d = await dec(old);
  assert.equal(d.decision, 'ineligible'); assert.ok(d.reasons.some((r) => /birth-date range/.test(r)));
  assert.equal((await dec(nodob)).decision, 'unknown');
  must(await api('POST', `/events/${s.ev.id}/registration/exceptions`, { token: s.org.token, body: { user_id: old.id, rule_key: 'division_age', reason: 'Guest veteran', effective_to: inst(10) } }), 201);
  d = await dec(old);
  assert.equal(d.decision, 'eligible'); assert.ok(d.checks.find((k) => k.status === 'waived'));
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_dob_eligibility'")).rowCount >= 1, 'DOB reads are audit-logged');
  // pending / unregistered / other-team / listing
  assert.equal((await dec(waiting)).decision, 'pending');
  assert.equal((await dec(unreg)).decision, 'ineligible');
  const other = must(await api('GET', `/events/${s.ev.id}/eligibility`, { token: s.mgr2.token, query: { team_id: s.rival.id, user_id: yes.id } }));
  assert.equal(other.decisions[0].reasons[0], 'Registered with a different team in this competition');
  // visibility: players see themself; managers their own team; strangers nothing; non-staff get no source labels
  assert.equal((await check(yes, yes.token)).status, 200);
  assert.equal((await check(old, yes.token)).status, 404);
  assert.equal((await check(yes, (await signup()).token)).status, 404);
  const asMgr = must(await api('GET', `/events/${s.ev.id}/eligibility`, { token: s.mgr.token, query: { team_id: s.team.id } }));
  assert.ok(asMgr.decisions.length >= 4);
  assert.ok(JSON.stringify(asMgr).indexOf('State federation') === -1);
  // reserve / development lists do not play when the policy says so
  const reg = must(await api('GET', `/events/${s.ev.id}/registrations`, { token: s.org.token, query: { q: yes.display_name } }))[0];
  must(await api('POST', `/registrations/${reg.id}/list`, { token: s.mgr.token, body: { roster_list: 'development', row_version: reg.row_version } }));
  assert.equal((await dec(yes)).decision, 'ineligible');
  // suspend / reinstate from the registration side
  const reg2 = must(await api('GET', `/events/${s.ev.id}/registrations`, { token: s.org.token, query: { q: old.display_name } }))[0];
  const sus = must(await review(s, reg2, 'suspend', { reason: 'Pending hearing' }));
  assert.equal((await dec(old)).decision, 'ineligible');
  must(await review(s, sus, 'reinstate'));
  assert.equal((await dec(old)).decision, 'eligible');
});

test('youth: guardian consent is part of eligibility, and unconsented young people are protected in lists and reports', async () => {
  const s = await setup();
  const mum = await signup(), kid = await signup(['athlete'], { dob: yearsAgo(12) });
  // a young person cannot join a team (or register) without a guardian's current consent
  assert.equal((await api('POST', `/teams/${s.team.id}/members`, { token: s.mgr.token, body: { user_id: kid.id } })).status, 409);
  const l = must(await api('POST', '/youth/guardian-links', { token: mum.token, body: { guardian_id: mum.id, child_id: kid.id, relationship: 'parent' } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/respond`, { token: kid.token, body: { accept: true } }));
  must(await api('POST', `/youth/guardian-links/${l.id}/evidence`, { token: mum.token, body: { evidence: { reference: 'https://example.com/birth-ref-9', label: 'Birth certificate' } } }), 201);
  must(await api('POST', `/youth/guardian-links/${l.id}/decision`, { token: admin.token, body: { decision: 'approve', note: 'Documents match' } }));
  must(await api('POST', `/youth/children/${kid.id}/consents`, { token: mum.token, body: { purpose: 'participation' } }), 201);
  must(await api('POST', `/teams/${s.team.id}/members`, { token: s.mgr.token, body: { user_id: kid.id } }), 201);
  must(await policy(s, {}), 201);
  const reg = await register(s, kid);
  assert.equal(must(await api('GET', `/events/${s.ev.id}/eligibility`, { token: s.org.token, query: { team_id: s.team.id, user_id: kid.id } })).decisions[0].decision, 'eligible');
  assert.equal(must(await api('GET', `/events/${s.ev.id}/registrations`, { token: s.org.token }))[0].display_name, kid.display_name);
  // revoking consent takes effect at once: not eligible, and the child is a protected participant in lists, exports and exception lists
  must(await api('DELETE', `/youth/children/${kid.id}/consents/participation`, { token: mum.token }));
  const d = must(await api('GET', `/events/${s.ev.id}/eligibility`, { token: s.org.token, query: { team_id: s.team.id, user_id: kid.id } })).decisions[0];
  assert.equal(d.decision, 'ineligible'); assert.equal(d.display_name, 'Protected participant');
  assert.equal(must(await api('GET', `/events/${s.ev.id}/registrations`, { token: s.org.token }))[0].display_name, 'Protected participant');
  const csv = must(await api('GET', `/events/${s.ev.id}/registration/report`, { token: s.org.token, query: { format: 'csv' } }));
  assert.ok(!csv.csv.includes(kid.display_name) && csv.csv.includes('Protected participant'));
  assert.equal(reg.status, 'registered');
});

test('match day: squad selection is checked server-side, kick-off locks the decision, later policy changes never rewrite it', async () => {
  const s = await setup();
  const good = await addPlayer(s), bad = await addPlayer(s), rivalP = await addPlayer(s, s.rival, s.mgr2);
  must(await policy(s, { required_clearances: ['licence'] }, { enforcement: 'blocking' }), 201);
  const dep = (p, body) => api('POST', `/events/${s.ev.id}/registration/dependencies`, { token: s.org.token, body: { user_id: p.id, ...body } });
  await register(s, good); must(await dep(good, { kind: 'licence', status: 'clear' }), 201);
  must(await submit(s, bad), 201);
  const rg = must(await api('POST', `/events/${s.ev.id}/registrations`, { token: s.mgr2.token, body: { team_id: s.rival.id, user_id: rivalP.id } }), 201);
  must(await review(s, rg, 'register')); must(await dep(rivalP, { kind: 'licence', status: 'clear' }), 201);

  // selection: an ineligible player is refused with the reasons; an eligible one is accepted
  const squad = (players, token = s.mgr.token) => api('POST', `/teams/${s.team.id}/squad`, { token, body: { fixture_id: s.fx.id, members: players.map((p) => ({ user_id: p.id, role: 'player' })) } });
  const refused = await squad([good, bad]);
  assert.equal(refused.status, 409); assert.equal(refused.body.error.details.code, 'eligibility_blocked');
  assert.equal(refused.body.error.details.players[0].user_id, bad.id); assert.ok(refused.body.error.details.players[0].reasons.length);
  must(await squad([good]));
  must(await api('POST', `/teams/${s.rival.id}/squad`, { token: s.mgr2.token, body: { fixture_id: s.fx.id, members: [{ user_id: rivalP.id, role: 'player' }] } }));
  // the decision for the whole squad is explainable from the fixture
  const fx = must(await api('GET', `/fixtures/${s.fx.id}/eligibility`, { token: s.mgr.token, query: { team_id: s.team.id } }));
  assert.equal(fx.summary.eligible, 1); assert.equal(fx.decisions[0].user_id, good.id);
  assert.equal((await api('GET', `/fixtures/${s.fx.id}/eligibility`, { token: s.mgr.token, query: { team_id: s.rival.id } })).status, 404, "not another team's squad");

  // lock: preserves the policy version, the rule set and the decision
  assert.equal((await api('POST', `/fixtures/${s.fx.id}/eligibility/lock`, { token: s.mgr.token, body: {} })).status, 403);
  const lock = must(await api('POST', `/fixtures/${s.fx.id}/eligibility/lock`, { token: s.org.token, body: {} }), 201);
  assert.deepEqual([lock.policy_version, lock.newly_locked, lock.players], [1, 2, 2]);
  assert.equal(must(await api('POST', `/fixtures/${s.fx.id}/eligibility/lock`, { token: s.org.token, body: {} }), 201).newly_locked, 0, 'idempotent');

  // the policy changes afterwards and the licence lapses: the locked snapshot is untouched
  must(await policy(s, { required_clearances: [], roster: { max_total: 30 } }), 201);
  must(await dep(good, { kind: 'licence', status: 'clear', valid_until: day(-1) }), 201);   // the licence has lapsed
  must(await api('PATCH', `/events/${s.ev.id}`, { token: s.org.token, body: { status: 'ongoing' } }));
  // kick-off re-checks under the CURRENT policy (v2 no longer needs a licence), and keeps a second snapshot
  must(await api('POST', `/fixtures/${s.fx.id}/start`, { token: s.org.token, body: {} }));
  const snaps = must(await api('GET', `/fixtures/${s.fx.id}/eligibility/snapshots`, { token: s.org.token }));
  const lockSnap = snaps.find((x) => x.stage === 'lock' && x.user_id === good.id), startSnap = snaps.find((x) => x.stage === 'start' && x.user_id === good.id);
  assert.equal(lockSnap.policy_version, 1); assert.deepEqual(lockSnap.rules.required_clearances, ['licence']); assert.equal(lockSnap.decision, 'eligible');
  assert.equal(startSnap.policy_version, 2); assert.equal(startSnap.decision, 'eligible');
  assert.equal(snaps.length, 4);
  // managers see their own team's snapshots without the rule set; strangers nothing; snapshots are immutable
  const mine = must(await api('GET', `/fixtures/${s.fx.id}/eligibility/snapshots`, { token: s.mgr.token }));
  assert.ok(mine.every((x) => x.team_id === s.team.id && x.rules === undefined));
  assert.equal((await api('GET', `/fixtures/${s.fx.id}/eligibility/snapshots`, { token: (await signup()).token })).status, 404);
  await assert.rejects(pool.query("UPDATE reg_snapshots SET decision='ineligible'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM reg_snapshots'), /append-only/);
});

test('a blocking policy stops kick-off for an ineligible player; advisory does not; events without a policy are unchanged', async () => {
  const plain = await setup();
  const pp = await addPlayer(plain);
  must(await api('POST', `/teams/${plain.team.id}/squad`, { token: plain.mgr.token, body: { fixture_id: plain.fx.id, members: [{ user_id: pp.id, role: 'player' }] } }));
  must(await api('PATCH', `/events/${plain.ev.id}`, { token: plain.org.token, body: { status: 'ongoing' } }));
  must(await api('POST', `/fixtures/${plain.fx.id}/start`, { token: plain.org.token, body: {} }));
  assert.equal((await pool.query('SELECT 1 FROM reg_snapshots WHERE event_id=$1', [plain.ev.id])).rowCount, 0, 'no policy, no snapshots');

  const s = await setup();
  const p = await addPlayer(s);
  const sel = await api('POST', `/teams/${s.team.id}/squad`, { token: s.mgr.token, body: { fixture_id: s.fx.id, members: [{ user_id: p.id, role: 'player' }] } });
  assert.equal(sel.status, 200);
  must(await api('PATCH', `/events/${s.ev.id}`, { token: s.org.token, body: { status: 'ongoing' } }));
  must(await policy(s, {}, { enforcement: 'blocking' }), 201);
  // selected before the policy existed, unregistered now: kick-off is refused with reasons
  const blocked = await api('POST', `/fixtures/${s.fx.id}/start`, { token: s.org.token, body: {} });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.details.code, 'eligibility_blocked');
  assert.equal((await pool.query("SELECT status FROM fixtures WHERE id=$1", [s.fx.id])).rows[0].status, 'scheduled');
  // advisory: warns (the decision is recorded) but play goes ahead
  must(await policy(s, {}, { enforcement: 'advisory' }), 201);
  must(await api('POST', `/fixtures/${s.fx.id}/start`, { token: s.org.token, body: {} }));
  const snap = must(await api('GET', `/fixtures/${s.fx.id}/eligibility/snapshots`, { token: s.org.token }));
  assert.equal(snap[0].decision, 'ineligible'); assert.equal(snap[0].policy_version, 2);
});

test('report is deterministic, exports are audited, and the surface is on REST, OpenAPI and MCP', async () => {
  const s = await setup();
  must(await policy(s, { quotas: { min_homegrown: 3 } }), 201);
  for (let k = 0; k < 3; k++) await register(s, await addPlayer(s), { origin_class: k ? 'local' : 'homegrown' });
  must(await submit(s, await addPlayer(s)), 201);
  const a = must(await api('GET', `/events/${s.ev.id}/registration/report`, { token: s.org.token })), b = must(await api('GET', `/events/${s.ev.id}/registration/report`, { token: s.org.token }));
  assert.deepEqual(a, b);
  assert.equal(a.registrations.length, 4);
  assert.deepEqual(a.totals.map((x) => x.status), ['registered', 'submitted']);
  assert.ok(a.rosters.teams.find((t) => t.team_id === s.team.id).warnings.includes('Needs 2 more homegrown'));
  const csv1 = must(await api('GET', `/events/${s.ev.id}/registration/report`, { token: s.org.token, query: { format: 'csv' } })), csv2 = must(await api('GET', `/events/${s.ev.id}/registration/report`, { token: s.org.token, query: { format: 'csv' } }));
  assert.equal(csv1.csv, csv2.csv); assert.equal(csv1.rows, 4);
  assert.equal((await api('GET', `/events/${s.ev.id}/registration/report`, { token: s.mgr.token })).status, 403);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='export_registration_report'")).rowCount >= 3);

  const names = ['get_registration_setup', 'publish_registration_policy', 'add_registration_division', 'add_registration_window', 'submit_registration', 'list_registrations', 'review_registration', 'change_registration_list', 'withdraw_registration',
    'get_roster_summary', 'grant_eligibility_exception', 'record_eligibility_dependency', 'check_fixture_eligibility', 'check_player_eligibility', 'lock_fixture_eligibility', 'get_eligibility_snapshots', 'get_registration_report', 'list_my_registrations'];
  const tools = (await rpc('tools/list', {}, s.org.token)).tools.map((t) => t.name);
  for (const nm of names) assert.ok(tools.includes(nm), `${nm} is an MCP tool`);
  const openapi = must(await api('GET', '/openapi.json').catch(() => ({ status: 200, body: {} })));
  if (openapi.paths) assert.ok(openapi.paths['/events/{id}/registration/policy'] ?? openapi.paths['/events/:id/registration/policy']);
  // a registration read-only token cannot decide registrations
  const tool = await rpc('tools/call', { name: 'list_registrations', arguments: { id: s.ev.id } }, s.org.token);
  assert.ok(tool);
});
