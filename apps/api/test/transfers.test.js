import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { requiredParties, windowCheck, approvalState, canMove } = await import('../src/transfer.js');

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
test('transfer rules: required parties, window and legal status moves', () => {
  assert.deepEqual(requiredParties({ kind: 'permanent', from_team_id: 'a', to_team_id: 'b' }), ['player', 'source_club', 'destination_club']);
  assert.deepEqual(requiredParties({ kind: 'permanent', from_team_id: 'a', to_team_id: 'b' }, { youth: true, seasoned: true }), ['player', 'guardian', 'source_club', 'destination_club', 'authority']);
  assert.deepEqual(requiredParties({ kind: 'release', from_team_id: 'a', to_team_id: null }), ['player', 'source_club']);
  assert.deepEqual(requiredParties({ kind: 'loan_recall', from_team_id: 'a', to_team_id: 'b' }), ['source_club', 'destination_club'], 'a recall is a club clause: the player does not consent');
  const s = { transfer_opens_on: '2026-08-01', transfer_closes_on: '2026-09-01' };
  assert.equal(windowCheck(s, '2026-07-31').code, 'window_not_open');
  assert.equal(windowCheck(s, '2026-08-01').ok, true);
  assert.equal(windowCheck(s, '2026-09-02').code, 'window_closed');
  assert.equal(windowCheck({}, '2030-01-01').code, 'no_window');
  assert.equal(windowCheck(null, '2030-01-01').code, 'no_season');
  const st = approvalState(['player', 'source_club'], [{ party: 'player', decision: 'approved' }]);
  assert.deepEqual([st.complete, st.waiting], [false, ['source_club']]);
  assert.equal(approvalState(['player'], [{ party: 'player', decision: 'rejected' }]).rejected.length, 1);
  assert.equal(canMove('completed', 'draft'), false);
  assert.equal(canMove('approved', 'completed'), true);
});

// ------------------------------------------------------------------ lifecycle (PostgreSQL)

const setup = async ({ youth = false } = {}) => {
  const mA = await signup(); const mB = await signup(); const player = await signup();
  const A = must(await api('POST', '/teams', { token: mA.token, body: { name: `Alpha ${n}`, sport: 'football' } }), 201);
  const B = must(await api('POST', '/teams', { token: mB.token, body: { name: `Bravo ${n}`, sport: 'football' } }), 201);
  await pool.query("INSERT INTO team_members(team_id,user_id,role,status) VALUES ($1,$2,'player','active') ON CONFLICT (team_id,user_id) DO UPDATE SET status='active'", [A.id, player.id]);
  let guardian = null;
  if (youth) {
    guardian = await signup();
    await pool.query("UPDATE users SET youth_until = current_date + 400 WHERE id=$1", [player.id]);
    await pool.query("INSERT INTO guardian_links(guardian_id,child_id,relationship,status,requested_by) VALUES ($1,$2,'parent','active',$1)", [guardian.id, player.id]);
  }
  return { mA, mB, player, A, B, guardian };
};
const req = (S, extra = {}, token = S.mA.token) => api('POST', '/transfers', { token, body: { kind: 'permanent', player_id: S.player.id, from_team_id: S.A.id, to_team_id: S.B.id, effective_on: day(2), ...extra } });
const decide = (S, tr, party, token, decision = 'approved', v = tr.version) => api('POST', `/transfers/${tr.id}/decision`, { token, body: { party, decision, expected_version: v } });

test('permanent transfer: each party approves the current version; amending voids approvals; completion moves the player exactly once', async () => {
  const S = await setup();
  const stranger = await signup();
  assert.equal((await req(S, {}, stranger.token)).status, 404, 'an outsider cannot start a transfer for someone else');
  let tr = must(await req(S, { reason: 'Wants more minutes', idempotency_key: 'idem-key-0001' }), 201);
  assert.equal(tr.status, 'draft');
  assert.equal((await req(S, { idempotency_key: 'idem-key-0001' })).body.id, tr.id, 'a retry with the same key returns the same transfer');
  assert.equal((await req(S)).body.error.details?.code, 'open_transfer', 'one open movement per player and sport');
  assert.equal((await api('GET', `/transfers/${tr.id}`, { token: stranger.token })).status, 404);
  assert.equal(must(await api('GET', `/transfers/${tr.id}`, { token: S.player.token })).reason, 'Wants more minutes');
  // cannot decide before submitting; cannot decide for a party you are not
  assert.equal((await decide(S, tr, 'player', S.player.token)).status, 409);
  tr = must(await api('POST', `/transfers/${tr.id}/submit`, { token: S.mA.token, body: { expected_version: 1 } }));
  assert.equal(tr.status, 'submitted');
  assert.equal((await decide(S, tr, 'destination_club', S.mA.token)).status, 403, 'the current club cannot sign for the destination');
  assert.equal((await decide(S, tr, 'player', S.mB.token)).status, 403, 'nobody signs for the player');
  assert.equal((await decide(S, tr, 'authority', S.mA.token)).status, 400, 'no competition, no authority party');
  must(await decide(S, tr, 'player', S.player.token));
  assert.equal((await decide(S, tr, 'player', S.player.token)).status, 409, 'a party decides a version once');
  assert.equal((await decide(S, tr, 'source_club', S.mA.token, 'approved', 99)).body.error.details.code, 'stale_version');
  // amending bumps the version and sends it back to review: the player's earlier approval no longer counts
  const am = must(await api('PATCH', `/transfers/${tr.id}`, { token: S.mA.token, body: { expected_version: 1, effective_on: day(3) } }));
  assert.deepEqual([am.version, am.status, am.approvals.approved], [2, 'submitted', []]);
  assert.equal((await api('PATCH', `/transfers/${tr.id}`, { token: S.mA.token, body: { expected_version: 1, effective_on: day(4) } })).body.error.details.code, 'stale_version');
  assert.equal((await decide(S, am, 'source_club', S.mA.token, 'approved', 1)).body.error.details.code, 'stale_version', 'a stale client cannot approve the old version');
  must(await decide(S, am, 'source_club', S.mA.token, 'approved', 2));
  must(await decide(S, am, 'player', S.player.token, 'approved', 2));
  assert.equal((await api('POST', `/transfers/${tr.id}/complete`, { token: S.mB.token, body: { expected_version: 2 } })).body.error.details.code, 'not_approved');
  const ok = must(await decide(S, am, 'destination_club', S.mB.token, 'approved', 2));
  assert.equal(ok.status, 'approved');
  assert.equal((await api('POST', `/transfers/${tr.id}/complete`, { token: stranger.token, body: { expected_version: 2 } })).status, 404);
  const done = must(await api('POST', `/transfers/${tr.id}/complete`, { token: S.mB.token, body: { expected_version: 2 } }));
  assert.equal(done.status, 'completed');
  const again = must(await api('POST', `/transfers/${tr.id}/complete`, { token: S.mB.token, body: { expected_version: 2 } }));
  assert.equal(again.completed_at, done.completed_at, 'a retried completion changes nothing');
  const mem = (await pool.query('SELECT team_id,status FROM team_members WHERE user_id=$1', [S.player.id])).rows;
  assert.deepEqual(Object.fromEntries(mem.map((m) => [m.team_id, m.status])), { [S.A.id]: 'left', [S.B.id]: 'active' }, 'history kept: the old membership is left, not deleted');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM career_memberships WHERE user_id=$1 AND team_id=$2", [S.player.id, S.B.id])).rows[0].n, 1);
  assert.deepEqual(done.events.map((e) => e.action).filter((a) => ['requested', 'submitted', 'amended', 'completed'].includes(a)), ['requested', 'submitted', 'amended', 'completed']);
  await assert.rejects(pool.query("UPDATE tr_transfers SET effective_on = effective_on + 1 WHERE id=$1", [tr.id]), /completed transfer cannot be changed/);
  await assert.rejects(pool.query('DELETE FROM tr_events WHERE transfer_id=$1', [tr.id]), /append-only/);
  assert.equal((await api('PATCH', `/transfers/${tr.id}`, { token: S.mA.token, body: { expected_version: 2, effective_on: day(9) } })).status, 409, 'a completed transfer is closed');
  // listing: parties see it, strangers do not
  assert.equal(must(await api('GET', '/transfers', { token: S.player.token })).items.length, 1);
  assert.equal(must(await api('GET', '/transfers', { token: stranger.token })).items.length, 0);
});

test('a rejection ends the transfer; withdraw keeps history; fee state is independent of sporting state', async () => {
  const S = await setup();
  let tr = must(await req(S, { fee: { minor: 250000, currency: 'EUR' } }), 201);
  assert.equal(tr.fee_state, 'agreed');
  tr = must(await api('POST', `/transfers/${tr.id}/submit`, { token: S.mA.token, body: { expected_version: 1 } }));
  must(await api('POST', `/transfers/${tr.id}/fee`, { token: S.mB.token, body: { fee_state: 'invoiced', invoice_ref: 'INV-1001' } }));
  assert.equal((await api('POST', `/transfers/${tr.id}/fee`, { token: S.mB.token, body: { fee_state: 'cleared' } })).status, 409, 'money moves forward one step at a time');
  assert.equal((await api('POST', `/transfers/${tr.id}/fee`, { token: S.player.token, body: { fee_state: 'paid' } })).status, 403, 'the player does not manage the fee');
  const r = must(await decide(S, tr, 'source_club', S.mA.token, 'rejected'));
  assert.equal(r.status, 'rejected');
  assert.equal(r.fee_state, 'invoiced', 'a paid-or-unpaid fee does not change sporting state');
  assert.equal((await api('POST', `/transfers/${tr.id}/withdraw`, { token: S.mA.token, body: {} })).status, 409);
  const t2 = must(await req(S), 201);
  const w = must(await api('POST', `/transfers/${t2.id}/withdraw`, { token: S.mA.token, body: { reason: 'changed mind' } }));
  assert.equal(w.status, 'withdrawn');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tr_transfers WHERE player_id=$1', [S.player.id])).rows[0].n, 2, 'nothing deleted');
});

test('transfer window is enforced by the server; an audited authority exception lets one movement through; registration hands off', async () => {
  const S = await setup();
  const org = await signup(['organizer']);
  const comp = must(await api('POST', '/competitions', { token: org.token, body: { name: `Window Cup ${n}`, sport: 'football', is_public: true } }), 201);
  const season = must(await api('POST', `/competitions/${comp.id}/seasons`, { token: org.token, body: { label: '2026', starts_on: day(1), ends_on: day(100), transfer_opens_on: day(-20), transfer_closes_on: day(-10) } }), 201);
  let tr = must(await req(S, { season_id: season.id, effective_on: day(5) }), 201);
  assert.equal(tr.window.code, 'window_closed');
  tr = must(await api('POST', `/transfers/${tr.id}/submit`, { token: S.mA.token, body: { expected_version: 1 } }));
  assert.deepEqual(tr.approvals.required.includes('authority'), true);
  for (const [p, t] of [['player', S.player], ['source_club', S.mA], ['destination_club', S.mB]]) must(await decide(S, tr, p, t.token));
  assert.equal((await decide(S, tr, 'authority', S.mB.token)).status, 403, 'a club cannot be the authority');
  const approved = must(await decide(S, tr, 'authority', org.token));
  assert.equal(approved.status, 'approved');
  const blocked = await api('POST', `/transfers/${tr.id}/complete`, { token: S.mB.token, body: { expected_version: 1 } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.details.blockers[0].code, 'window_closed');
  assert.equal((await api('POST', `/transfers/${tr.id}/window-exception`, { token: S.mB.token, body: { reason: 'please let us' } })).status, 403, 'only the authority grants an exception');
  must(await api('POST', `/transfers/${tr.id}/window-exception`, { token: org.token, body: { reason: 'Emergency goalkeeper cover' } }));
  // a registration at the old team in this season is withdrawn and a new one is submitted for the registrar
  const ev = season.event_id;
  await pool.query("INSERT INTO reg_registrations(event_id,team_id,user_id,status,submitted_by) VALUES ($1,$2,$3,'registered',$3)", [ev, S.A.id, S.player.id]);
  const done = must(await api('POST', `/transfers/${tr.id}/complete`, { token: S.mB.token, body: { expected_version: 1 } }));
  assert.equal(done.status, 'completed');
  const regs = (await pool.query('SELECT team_id,status FROM reg_registrations WHERE event_id=$1 AND user_id=$2 ORDER BY created_at', [ev, S.player.id])).rows;
  assert.deepEqual(regs.map((r) => [r.team_id, r.status]), [[S.A.id, 'withdrawn'], [S.B.id, 'submitted']]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM reg_dependencies WHERE event_id=$1 AND user_id=$2 AND source_ref=$3", [ev, S.player.id, `transfer:${tr.id}`])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='transfer.window_exception' AND entity_id=$1", [tr.id])).rows[0].n, 1);
});

test('loan, extension and recall keep history; international needs a received clearance, never auto-verified', async () => {
  const S = await setup();
  const run = async (body, parties) => {
    let tr = must(await req(S, body), 201);
    tr = must(await api('POST', `/transfers/${tr.id}/submit`, { token: S.mA.token, body: { expected_version: 1 } }));
    for (const [p, tk] of parties) must(await decide(S, tr, p, tk));
    return tr;
  };
  const loan = await run({ kind: 'loan', loan_ends_on: day(60) }, [['player', S.player.token], ['source_club', S.mA.token], ['destination_club', S.mB.token]]);
  assert.equal((await api('POST', `/transfers`, { token: S.mA.token, body: { kind: 'loan', player_id: S.player.id, from_team_id: S.A.id, to_team_id: S.B.id, effective_on: day(2) } })).status, 400, 'a loan needs an end date');
  must(await api('POST', `/transfers/${loan.id}/complete`, { token: S.mA.token, body: { expected_version: 1 } }));
  let m = (await pool.query('SELECT team_id,status FROM team_members WHERE user_id=$1', [S.player.id])).rows;
  assert.equal(m.filter((x) => x.status === 'active').length, 2, 'on loan: the parent membership stays, the loan club is added');
  // extension
  const ext = await run({ kind: 'loan_extension', parent_id: loan.id, from_team_id: S.A.id, to_team_id: S.B.id, loan_ends_on: day(120) }, [['player', S.player.token], ['source_club', S.mA.token], ['destination_club', S.mB.token]]);
  assert.equal((await api('POST', '/transfers', { token: S.mA.token, body: { kind: 'loan_extension', parent_id: loan.id, player_id: S.player.id, from_team_id: S.A.id, to_team_id: S.B.id, effective_on: day(2), loan_ends_on: day(200) } })).status, 409, 'one open movement at a time');
  must(await api('POST', `/transfers/${ext.id}/complete`, { token: S.mB.token, body: { expected_version: 1 } }));
  assert.equal((await pool.query('SELECT loan_state, loan_ends_on::text FROM tr_transfers WHERE id=$1', [loan.id])).rows[0].loan_state, 'extended');
  // recall: loan club B -> parent club A, no player consent
  const rec = must(await api('POST', '/transfers', { token: S.mA.token, body: { kind: 'loan_recall', parent_id: loan.id, player_id: S.player.id, from_team_id: S.B.id, to_team_id: S.A.id, effective_on: day(5) } }), 201);
  assert.deepEqual(rec.approvals.required, ['source_club', 'destination_club']);
  const rsub = must(await api('POST', `/transfers/${rec.id}/submit`, { token: S.mA.token, body: { expected_version: 1 } }));
  must(await decide(S, rsub, 'source_club', S.mB.token)); must(await decide(S, rsub, 'destination_club', S.mA.token));
  must(await api('POST', `/transfers/${rec.id}/complete`, { token: S.mA.token, body: { expected_version: 1 } }));
  assert.equal((await pool.query('SELECT loan_state FROM tr_transfers WHERE id=$1', [loan.id])).rows[0].loan_state, 'recalled');
  m = (await pool.query('SELECT team_id,status FROM team_members WHERE user_id=$1', [S.player.id])).rows;
  assert.deepEqual(Object.fromEntries(m.map((x) => [x.team_id, x.status])), { [S.A.id]: 'active', [S.B.id]: 'left' });
  // international: clearance gate
  const S2 = await setup();
  const intl = must(await api('POST', '/transfers', { token: S2.mB.token, body: { kind: 'international', player_id: S2.player.id, from_team_id: S2.A.id, to_team_id: S2.B.id, effective_on: day(2) } }), 201);
  assert.equal(intl.clearance_status, 'requested');
  const isub = must(await api('POST', `/transfers/${intl.id}/submit`, { token: S2.mB.token, body: { expected_version: 1 } }));
  for (const [p, tk] of [['player', S2.player.token], ['source_club', S2.mA.token], ['destination_club', S2.mB.token]]) must(await decide(S2, isub, p, tk));
  assert.equal((await api('POST', `/transfers/${intl.id}/complete`, { token: S2.mB.token, body: { expected_version: 1 } })).body.error.details.blockers[0].code, 'clearance_missing');
  assert.equal((await api('POST', `/transfers/${intl.id}/clearance`, { token: S2.mB.token, body: { status: 'received' } })).status, 400, 'a reference is required');
  const cl = must(await api('POST', `/transfers/${intl.id}/clearance`, { token: S2.mB.token, body: { status: 'received', reference: 'ITC-2026-77', source: 'National FA', verified: false } }));
  assert.equal(cl.clearance_verified, false);
  assert.equal((await api('POST', `/transfers/${intl.id}/clearance`, { token: S2.mB.token, body: { status: 'received', reference: 'ITC-2026-77', verified: true } })).status, 403, 'a club cannot mark its own clearance verified');
  must(await api('POST', `/transfers/${intl.id}/complete`, { token: S2.mB.token, body: { expected_version: 1 } }));
});

test('youth transfers need the guardian; concurrent completion moves the player once', async () => {
  const S = await setup({ youth: true });
  let tr = must(await req(S), 201);
  tr = must(await api('POST', `/transfers/${tr.id}/submit`, { token: S.mA.token, body: { expected_version: 1 } }));
  assert.ok(tr.approvals.required.includes('guardian'));
  assert.equal(must(await api('GET', `/transfers/${tr.id}`, { token: S.guardian.token })).id, tr.id, 'the guardian can read it');
  assert.equal((await decide(S, tr, 'guardian', S.mB.token)).status, 403, 'only a verified guardian signs as guardian');
  for (const [p, t] of [['player', S.player], ['guardian', S.guardian], ['source_club', S.mA], ['destination_club', S.mB]]) must(await decide(S, tr, p, t.token));
  const results = await Promise.all([1, 2, 3].map(() => api('POST', `/transfers/${tr.id}/complete`, { token: S.mB.token, body: { expected_version: 1 } })));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM career_memberships WHERE user_id=$1 AND team_id=$2", [S.player.id, S.B.id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM tr_events WHERE transfer_id=$1 AND action='completed'", [tr.id])).rows[0].n, 1);
  const tools = (await rpc('tools/list', {}, S.mA.token)).tools.map((t) => t.name);
  for (const t of ['request_transfer', 'decide_transfer', 'complete_transfer', 'list_transfers', 'amend_transfer', 'submit_transfer']) assert.ok(tools.includes(t), t);
});
