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
const signup = async (roles = ['athlete'], extra = {}) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `pr_${n}_${roles[0]}`, display_name: `Par ${n}`, email: `pr${n}@example.com`, password: 'correct-horse-battery', roles, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await pool.query("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('pr_root','pr_root','{admin}','x','x','pr_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });


/** Organiser, two teams (managers) and a fixture in a wheelchair-basketball competition. */
const setup = async (sport = 'wheelchair-basketball') => {
  const org = await signup(['organizer']), mgr = await signup(['athlete']), mgr2 = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: mgr.token, body: { name: `Rollers ${++n}`, sport } }), 201);
  const rival = must(await api('POST', '/teams', { token: mgr2.token, body: { name: `Chairs ${++n}`, sport } }), 201);
  const ev = must(await api('POST', '/events', { token: org.token, body: { name: `Para Cup ${n}`, sport, starts_on: day(5), ends_on: day(30) } }), 201);
  for (const [t, tok] of [[team, mgr.token], [rival, mgr2.token]]) {
    const en = must(await api('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } }), 201);
    must(await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } }));
  }
  const fx = must(await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: team.id, away_team_id: rival.id, scheduled_at: inst(3) } }), 201);
  const sportId = (await pool.query('SELECT id FROM sports WHERE slug=$1', [sport])).rows[0].id;
  const body = (await pool.query("INSERT INTO organisations(name, created_by) VALUES ($1,$2) RETURNING id", [`Authority ${n}`, org.id])).rows[0];
  const gb = (await pool.query("INSERT INTO governing_bodies(organisation_id, level, abbreviation, created_by) VALUES ($1,'international',$3,$2) RETURNING id", [body.id, org.id, `X${String(n).padStart(4, '0')}`])).rows[0];
  const ver = (await pool.query("INSERT INTO para_class_versions(body_id, sport_id, version, title, source_ref, effective_from, status, created_by) VALUES ($1,$2,1,'Classes','handbook','2020-01-01','published',$3) RETURNING id", [gb.id, sportId, org.id])).rows[0];
  return { org, mgr, mgr2, team, rival, ev, fx, sportId, gb, ver };
};
const classify = (s, p, code, status = 'confirmed', extra = {}) => pool.query(
  `INSERT INTO para_outcomes(athlete_id, sport_id, version_id, class_code, status, effective_from, authority_id, decision_ref, issued_by, review_by) VALUES ($1,$2,$3,$4,$5,'2020-01-01',$6,$7,$8,$9)`,
  [p.id, s.sportId, s.ver.id, code, status, s.gb.id, `REF-${++n}`, s.org.id, extra.review_by ?? null]);
const player = async (s, team, mgr, code, status = 'confirmed', extra = {}) => {
  const p = await signup(['athlete']);
  must(await api('POST', `/teams/${team.id}/members`, { token: mgr.token, body: { user_id: p.id } }), 201);
  if (code) await classify(s, p, code, status, extra);
  const r = must(await api('POST', `/events/${s.ev.id}/registrations`, { token: mgr.token, body: { team_id: team.id, user_id: p.id } }), 201);
  return { ...p, reg: must(await api('POST', `/registrations/${r.id}/review`, { token: s.org.token, body: { action: 'register', row_version: r.row_version } })) };
};
const wb = (extra = {}) => ({
  classes: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5].map((p) => ({ code: String(p), points: p })),
  categories: [{ key: 'open', label: 'Open', classes: ['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5'] }],
  rules: [{ id: 'cap', type: 'class_points_cap', max: 14, label: 'On-court class points' }, { id: 'five', type: 'composition', min: 5, max: 5, label: 'Players on court' }], ...extra });
const publishPack = async (s, definition, v = 0) => {
  const pack = must(await api('POST', `/events/${s.ev.id}/para/rule-packs`, { token: s.org.token, body: { title: 'IWBF Official Rules', publisher: 'IWBF', source_ref: 'handbook §C.3', definition, expected_version: v } }), 201);
  const pol = must(await api('POST', `/events/${s.ev.id}/registration/policy`, { token: s.org.token, body: { rules: { para_pack_id: pack.id, require_team_affiliation: true, require_guardian_consent: false, require_compliance: false }, expected_version: s.v ?? 0 } }), 201);
  s.v = pol.version; return pack;
};
const squad = (s, team, tok, players, extra = []) => api('POST', `/teams/${team.id}/squad`, { token: tok, body: { fixture_id: s.fx.id, members: [...players.map((p) => ({ user_id: p.id, role: 'player' })), ...extra] } });

test('pure engine: class-points cap, quota, role and composition validators are deterministic', async () => {
  const { DEFINITION, evaluateLineup } = await import('../src/para-rules.js');
  const def = DEFINITION.parse(wb());
  const m = (codes) => codes.map((c, i) => ({ user_id: `u${i}`, class_code: String(c), status: 'confirmed', slot: 'court' }));
  const ok = evaluateLineup(def, m([4.5, 4, 3, 1.5, 1]));            // 14.0
  assert.equal(ok.valid, true);
  const over = evaluateLineup(def, m([4.5, 4, 3, 2, 1]));            // 14.5
  assert.equal(over.valid, false);
  const k = over.checks.find((x) => x.rule === 'cap'); assert.equal(k.value, 14.5); assert.match(k.remediation, /over by 0\.5/);
  assert.deepEqual(evaluateLineup(def, m([4.5, 4, 3, 2, 1])), over, 'same inputs, same result');
  assert.equal(evaluateLineup(def, m([1, 1, 1])).checks.find((x) => x.rule === 'five').status, 'fail');
  // bench players do not count on court; an unclassified person is refused with a remediation
  const bench = [...m([4.5, 4, 3, 1.5, 1]), { user_id: 'b', class_code: '4.5', status: 'confirmed', slot: 'bench' }];
  assert.equal(evaluateLineup(def, bench).valid, true);
  const none = evaluateLineup(def, [...m([4, 4, 3, 2, 1]), { user_id: 'x', class_code: null, status: null, slot: 'bench' }]);
  assert.equal(none.members.find((x) => x.user_id === 'x').status, 'fail');
  // schema refuses unknown classes, duplicate ids, a cap with no points
  assert.throws(() => DEFINITION.parse(wb({ rules: [{ id: 'q', type: 'class_quota', classes: ['9'], min: 1 }] })));
  assert.throws(() => DEFINITION.parse({ ...wb(), classes: [{ code: 'A' }], categories: [], rules: [{ id: 'cap', type: 'class_points_cap', max: 3 }] }));
  assert.throws(() => DEFINITION.parse(wb({ rules: [{ id: 'a', type: 'composition', max: 5 }, { id: 'a', type: 'composition', min: 1 }] })));
  // a second, materially different sport: boccia pairs with class quota and a required assistant for BC3, no points at all
  const boccia = DEFINITION.parse({ classes: ['BC1', 'BC2', 'BC3', 'BC4'].map((code) => ({ code })), rules: [
    { id: 'pair', type: 'composition', min: 2, max: 3, scope: 'all' }, { id: 'mix', type: 'same_class_max', max: 2, scope: 'all' },
    { id: 'assistant', type: 'role_required', role: 'assistant', min: 1, when_classes: ['BC3'], scope: 'all' }] });
  const b = (codes, extra = []) => [...codes.map((c, i) => ({ user_id: `b${i}`, class_code: c, status: 'confirmed', slot: 'court' })), ...extra];
  assert.equal(evaluateLineup(boccia, b(['BC1', 'BC2'])).valid, true);
  const needA = evaluateLineup(boccia, b(['BC3', 'BC1']));
  assert.equal(needA.valid, false); assert.match(needA.checks.find((x) => x.rule === 'assistant').reason, /assistant needed/);
  assert.equal(evaluateLineup(boccia, b(['BC3', 'BC1'], [{ user_id: 'a', slot: 'staff', role: 'assistant' }])).valid, true);
  assert.equal(evaluateLineup(boccia, b(['BC1', 'BC1', 'BC1'])).valid, false, 'no class may dominate');
});

test('wheelchair basketball: pack locks to the policy, rejects over-cap lineups with remediation, blocks lock and kick-off, snapshot reproducible', async () => {
  const s = await setup();
  await publishPack(s, wb());
  const mk = (codes) => Promise.all(codes.map((c) => player(s, s.team, s.mgr, c)));
  const good = await mk([4.5, 4, 3, 1.5, 1]);                  // 14.0
  const over = await player(s, s.team, s.mgr, 2);              // swapping 1 -> 2 gives 15.0
  const rivals = await Promise.all([4, 3.5, 2, 1.5, 1].map((c) => player(s, s.rival, s.mgr2, c)));
  must(await squad(s, s.rival, s.mgr2.token, rivals));
  // saving a squad is only refused for people the pack does not accept (here: nobody); lineup rules are checked on demand and at lock
  must(await squad(s, s.team, s.mgr.token, [...good.slice(0, 4), over]));
  const check = (members, tok = s.mgr.token) => api('POST', `/fixtures/${s.fx.id}/para/lineup-check`, { token: tok, body: { team_id: s.team.id, ...(members ? { members } : {}) } });
  let r = must(await check());
  assert.equal(r.valid, false);
  const cap = r.checks.find((k) => k.rule === 'cap');
  assert.equal(cap.value, 15); assert.match(cap.reason, /exceeds the limit of 14/); assert.ok(cap.remediation);
  assert.ok(r.members.every((m) => 'class_code' in m && !('evidence' in m)), 'class code and status only');
  // trying out a different five (without saving) is valid; the saved squad is unchanged
  r = must(await check(good.map((p) => ({ user_id: p.id, slot: 'court' }))));
  assert.equal(r.valid, true); assert.equal(r.pack.version, 1);
  assert.equal((await check(null, (await signup()).token)).status, 404, 'a stranger learns nothing');
  assert.equal((await check([{ user_id: (await signup()).id }])).status, 400, 'only registered people');
  // lock and kick-off refuse the invalid lineup with explanations
  const lock = await api('POST', `/fixtures/${s.fx.id}/eligibility/lock`, { token: s.org.token });
  assert.equal(lock.status, 409); assert.equal(lock.body.error.details.code, 'para_rules_blocked');
  assert.match(JSON.stringify(lock.body.error.details.teams[0].failures), /exceeds the limit/);
  assert.equal((await pool.query('SELECT 1 FROM para_lineup_snapshots WHERE fixture_id=$1', [s.fx.id])).rowCount, 0, 'nothing written on a refusal');
  // fix the lineup: lock succeeds and the snapshot stays reproducible after later changes
  must(await squad(s, s.team, s.mgr.token, good));
  must(await api('POST', `/fixtures/${s.fx.id}/eligibility/lock`, { token: s.org.token }), 201);
  const snap = must(await api('GET', `/fixtures/${s.fx.id}/para/snapshots`, { token: s.org.token, query: { team_id: s.team.id } }));
  assert.equal(snap.length, 1); assert.equal(snap[0].valid, true); assert.equal(snap[0].pack_version, 1);
  assert.equal(snap[0].checks.definition.rules[0].max, 14);
  await publishPack(s, wb({ rules: [{ id: 'cap', type: 'class_points_cap', max: 10 }] }), 1);
  const v2 = await api('POST', `/fixtures/${s.fx.id}/eligibility/lock`, { token: s.org.token });
  assert.equal(v2.status, 409, 'the stricter pack v2 now refuses the same lineup'); assert.equal(v2.body.error.details.teams[0].pack_version, 2);
  const again = must(await api('GET', `/fixtures/${s.fx.id}/para/snapshots`, { token: s.org.token, query: { team_id: s.team.id } }));
  assert.equal(again[0].pack_version, 1, 'the earlier snapshot is not rewritten by pack v2');
  await assert.rejects(pool.query('UPDATE para_rule_packs SET title=$1', ['x']), /never changed/);
  // a manager sees only their team's snapshot
  assert.equal(must(await api('GET', `/fixtures/${s.fx.id}/para/snapshots`, { token: s.mgr.token })).every((x) => x.team_id === s.team.id), true);
});

test('classification gates: unclassified, not eligible, lapsed review and unknown class are refused per person, with reasons and no clinical data', async () => {
  const s = await setup();
  await publishPack(s, wb());
  const none = await player(s, s.team, s.mgr, null), no = await player(s, s.team, s.mgr, '3', 'not_eligible'), rev = await player(s, s.team, s.mgr, '3', 'review_required'), odd = await player(s, s.team, s.mgr, 'T99'), fine = await player(s, s.team, s.mgr, '2');
  const sel = await squad(s, s.team, s.mgr.token, [none, no, rev, odd, fine]);
  assert.equal(sel.status, 409); assert.equal(sel.body.error.details.code, 'eligibility_blocked');
  const by = Object.fromEntries(sel.body.error.details.players.map((x) => [x.user_id, x]));
  assert.ok(by[none.id] && by[no.id] && by[odd.id]); assert.ok(!by[fine.id]);
  assert.ok(by[odd.id].reasons.some((x) => /not a class of this competition/.test(x)));
  must(await squad(s, s.team, s.mgr.token, [fine]));
  // projection: class code + status only for the organiser; the athlete sees only themselves; strangers get 404
  const proj = must(await api('GET', `/events/${s.ev.id}/para/eligibility`, { token: s.org.token }));
  assert.equal(proj.rows.length, 5);
  assert.ok(proj.rows.every((x) => Object.keys(x).every((k) => ['registration_id', 'user_id', 'team_id', 'display_name', 'class_code', 'class_status', 'decision', 'reason', 'remediation'].includes(k))));
  assert.equal(proj.rows.find((x) => x.user_id === fine.id).decision, 'accepted');
  const mine = must(await api('GET', `/events/${s.ev.id}/para/eligibility`, { token: fine.token }));
  assert.deepEqual(mine.rows.map((x) => x.user_id), [fine.id]);
  assert.equal((await api('GET', `/events/${s.ev.id}/para/eligibility`, { token: (await signup()).token })).status, 404);
  assert.doesNotMatch(JSON.stringify(proj), /diagnos|evidence|medical|impairment/i);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action='read_para_eligibility_projection'")).rowCount >= 1);
});

test('overrides: a manager requests, a different organiser approves, the check shows waived, the lock records it; revoke restores the block', async () => {
  const s = await setup();
  await publishPack(s, wb());
  const five = await Promise.all([4.5, 4, 3, 2, 1].map((c) => player(s, s.team, s.mgr, c)));    // 14.5
  const rivals = await Promise.all([3, 3, 2, 2, 1].map((c) => player(s, s.rival, s.mgr2, c)));
  must(await squad(s, s.team, s.mgr.token, five)); must(await squad(s, s.rival, s.mgr2.token, rivals));
  const req = must(await api('POST', `/events/${s.ev.id}/para/overrides`, { token: s.mgr.token, body: { team_id: s.team.id, rule_id: 'cap', fixture_id: s.fx.id, reason: 'Class review pending, 0.5 over' } }), 201);
  assert.equal(req.status, 'requested');
  assert.equal((await api('POST', `/events/${s.ev.id}/para/overrides`, { token: s.mgr.token, body: { team_id: s.team.id, rule_id: 'nope', reason: 'x'.repeat(5) } })).status, 400);
  assert.equal((await api('POST', `/events/${s.ev.id}/para/overrides`, { token: (await signup()).token, body: { team_id: s.team.id, rule_id: 'cap', reason: 'abcde' } })).status, 404);
  assert.equal((await api('POST', `/fixtures/${s.fx.id}/eligibility/lock`, { token: s.org.token })).status, 409, 'a request alone changes nothing');
  assert.equal((await api('POST', `/para/overrides/${req.id}/decision`, { token: s.mgr.token, body: { decision: 'approved', note: 'ok ok', effective_to: inst(5) } })).status, 403, 'a manager cannot approve');
  // the requester cannot approve their own request even when an organiser
  const own = must(await api('POST', `/events/${s.ev.id}/para/overrides`, { token: s.org.token, body: { team_id: s.team.id, rule_id: 'cap', reason: 'self request' } }), 201);
  assert.equal((await api('POST', `/para/overrides/${own.id}/decision`, { token: s.org.token, body: { decision: 'approved', note: 'self', effective_to: inst(5) } })).status, 403);
  assert.equal((await api('POST', `/para/overrides/${req.id}/decision`, { token: s.org.token, body: { decision: 'approved', note: 'approved' } })).status, 400, 'needs an end time');
  must(await api('POST', `/para/overrides/${req.id}/decision`, { token: s.org.token, body: { decision: 'approved', note: 'Director approval', effective_to: inst(5) } }));
  const chk = must(await api('POST', `/fixtures/${s.fx.id}/para/lineup-check`, { token: s.mgr.token, body: { team_id: s.team.id } }));
  assert.equal(chk.valid, true); assert.equal(chk.checks.find((k) => k.rule === 'cap').status, 'waived'); assert.equal(chk.applied_overrides.length, 1);
  must(await api('POST', `/fixtures/${s.fx.id}/eligibility/lock`, { token: s.org.token }), 201);
  assert.equal(must(await api('GET', `/fixtures/${s.fx.id}/para/snapshots`, { token: s.org.token, query: { team_id: s.team.id } }))[0].overrides.length, 1);
  assert.equal((await pool.query("SELECT 1 FROM para_overrides WHERE reason_enc LIKE '%pending%'")).rowCount, 0, 'reason stored encrypted');
  // listing never returns the reason; revoke restores the block
  assert.ok(must(await api('GET', `/events/${s.ev.id}/para/overrides`, { token: s.mgr.token })).every((x) => !('reason' in x) && !('reason_enc' in x)));
  must(await api('POST', `/para/overrides/${req.id}/decision`, { token: s.org.token, body: { decision: 'revoked', note: 'Withdrawn' } }));
  assert.equal(must(await api('POST', `/fixtures/${s.fx.id}/para/lineup-check`, { token: s.mgr.token, body: { team_id: s.team.id } })).valid, false);
  assert.ok((await pool.query("SELECT DISTINCT action FROM audit_log WHERE action IN ('para_override_approved','para_override_revoked','request_para_override') ")).rows.length >= 3);
});

test('a second sport (boccia) runs on the same engine; competitions without a pack are untouched; policy and pack authorisation hold', async () => {
  const s = await setup('boccia');
  const pack = await publishPack(s, { classes: ['BC1', 'BC2', 'BC3', 'BC4'].map((code) => ({ code })), rules: [
    { id: 'pair', type: 'composition', min: 2, max: 3, scope: 'all' }, { id: 'mix', type: 'same_class_max', max: 2, scope: 'all' }, { id: 'assistant', type: 'role_required', role: 'assistant', min: 1, when_classes: ['BC3'], scope: 'all' }] });
  const a = await player(s, s.team, s.mgr, 'BC3'), b = await player(s, s.team, s.mgr, 'BC1'), asst = await signup(['athlete']);
  must(await api('POST', `/teams/${s.team.id}/members`, { token: s.mgr.token, body: { user_id: asst.id } }), 201);
  must(await squad(s, s.team, s.mgr.token, [a, b]));
  let r = must(await api('POST', `/fixtures/${s.fx.id}/para/lineup-check`, { token: s.mgr.token, body: { team_id: s.team.id } }));
  assert.equal(r.valid, false); assert.match(r.checks.find((k) => k.rule === 'assistant').reason, /assistant needed/);
  must(await api('POST', `/teams/${s.team.id}/squad`, { token: s.mgr.token, body: { fixture_id: s.fx.id, members: [{ user_id: a.id, role: 'player' }, { user_id: b.id, role: 'player' }, { user_id: asst.id, role: 'coach', position: 'assistant' }] } }));
  r = must(await api('POST', `/fixtures/${s.fx.id}/para/lineup-check`, { token: s.mgr.token, body: { team_id: s.team.id } }));
  assert.equal(r.valid, true, JSON.stringify(r.checks));
  // authorisation and versioning
  assert.equal((await api('POST', `/events/${s.ev.id}/para/rule-packs`, { token: s.mgr.token, body: { title: 'Pack', publisher: 'BISFed', source_ref: 'abc', definition: { classes: [{ code: 'A' }], rules: [{ id: 'c', type: 'composition', max: 2 }] }, expected_version: 1 } })).status, 403);
  assert.equal((await api('POST', `/events/${s.ev.id}/para/rule-packs`, { token: s.org.token, body: { title: 'Pack', publisher: 'BISFed', source_ref: 'abc', definition: { classes: [{ code: 'A' }], rules: [{ id: 'c', type: 'composition', max: 2 }] }, expected_version: 0 } })).status, 409, 'stale version');
  const list = must(await api('GET', `/events/${s.ev.id}/para/rule-packs`, { token: s.mgr.token }));
  assert.equal(list.locked_pack_id, pack.id); assert.equal(list.can_manage, false);
  assert.equal((await api('GET', `/events/${s.ev.id}/para/rule-packs`, { token: (await signup()).token })).status, 404);
  // regression: a competition with no pack never sees para checks, and a policy without para_pack_id behaves exactly as before
  const plain = await setup('cricket');
  const p = await signup(['athlete']); must(await api('POST', `/teams/${plain.team.id}/members`, { token: plain.mgr.token, body: { user_id: p.id } }), 201);
  must(await api('POST', `/events/${plain.ev.id}/registration/policy`, { token: plain.org.token, body: { rules: { require_guardian_consent: false, require_compliance: false }, expected_version: 0 } }), 201);
  const chk = await api('POST', `/fixtures/${plain.fx.id}/para/lineup-check`, { token: plain.mgr.token, body: { team_id: plain.team.id } });
  assert.equal(chk.status, 409); assert.equal(chk.body.error.details.code, 'no_pack');
  assert.equal((await api('POST', `/fixtures/${plain.fx.id}/eligibility/lock`, { token: plain.org.token })).status, 201, 'non-para lock unchanged');
  // MCP parity: every capability is exposed as a tool and OpenAPI paths exist
  const tools = (await rpc('tools/list', {}, s.org.token)).tools.map((t) => t.name);
  for (const t of ['publish_para_rule_pack', 'list_para_rule_packs', 'check_para_lineup', 'get_para_eligibility_projection', 'request_para_override', 'decide_para_override', 'list_para_overrides', 'get_para_lineup_snapshots']) assert.ok(tools.includes(t), t);
  const oa = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.ok(oa.paths['/events/{id}/para/rule-packs'] && oa.paths['/fixtures/{id}/para/lineup-check']);
  const mcp = await rpc('tools/call', { name: 'check_para_lineup', arguments: { id: s.fx.id, team_id: s.team.id } }, s.mgr.token);
  assert.ok(!mcp.isError, JSON.stringify(mcp));
});
