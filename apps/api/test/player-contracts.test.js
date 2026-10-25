import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Player contracts, amendments, earnings, expenses, payout runs and statements (#333), against a real Postgres.
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
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const code = (r) => r.body.error?.details?.code ?? r.body.details?.code ?? r.body.code;
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const key = () => `k-${++n}-${Math.random().toString(36).slice(2, 10)}`;
const q = (sql, args) => pool.query(sql, args);
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pc_${n}_${roles[0]}`, display_name: `Contracts ${n}`, email: `pc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};

before(async () => {
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  const row = (await q("INSERT INTO users(handle,display_name,roles,password_hash,email_enc,email_idx) VALUES ('pc_root','pc_root','{admin}','x','x','pc_root') RETURNING id")).rows[0];
  admin = { id: row.id, token: await signToken({ id: row.id, roles: ['admin'] }) };
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const terms = (o = {}) => ({
  starts_on: day(-40), ends_on: day(60), currency: 'INR', expected_games: 10, withholding_bp: 1000, expense_cap_cents: 200000, pay_terms_days: 7,
  components: [
    { kind: 'appearance_fee', amount_cents: 400000 }, { kind: 'start_bonus', amount_cents: 50000 }, { kind: 'goal_bonus', amount_cents: 100000 }, { kind: 'win_bonus', amount_cents: 75000 },
    { kind: 'fixed', label: 'Match fee agreed on acceptance', amount_cents: 250000, due_on: day(-5) },
  ], ...o,
});

/** A club with an owner and a second manager, a player with an accepted paid opportunity, and one completed, verified game the player started and won 2-0. */
async function club({ withGame = true } = {}) {
  const owner = await signup(['coach']), manager = await signup(['athlete']), player = await signup(['athlete']), orgz = await signup(['organizer']), rival = await signup(['athlete']);
  const team = must(await api('POST', '/teams', { token: owner.token, body: { name: `Strikers ${++n}`, sport: 'football', currency: 'INR' } }), 201);
  must(await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: manager.id } }), 201);
  must(await api('PATCH', `/teams/${team.id}/members/${manager.id}`, { token: owner.token, body: { role: 'manager' } }));
  const post = must(await api('POST', '/billboard', { token: owner.token, body: { title: `Striker wanted ${++n}`, sport: 'football', kind: 'assignment', opportunity_type: 'paid_assignment', team_id: team.id, budget_cents: 250000, currency: 'INR', positions_needed: 3, ends_at: new Date(Date.now() + 864e6).toISOString() } }), 201);
  const resp = must(await api('POST', `/billboard/${post.id}/responses`, { token: player.token, body: { message: 'Pick me' } }), 201);
  must(await api('PATCH', `/billboard/responses/${resp.id}`, { token: owner.token, body: { status: 'accepted' } }));
  let fx = null;
  if (withGame) {
    const rivalTeam = must(await api('POST', '/teams', { token: rival.token, body: { name: `Rivals ${++n}`, sport: 'football' } }), 201);
    const ev = must(await api('POST', '/events', { token: orgz.token, body: { name: `Cup ${n}`, sport: 'football', starts_on: day(1), ends_on: day(2), entry_fee_cents: 0 } }), 201);
    for (const [t, tok] of [[team, owner.token], [rivalTeam, rival.token]]) {
      const en = must(await api('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } }), 201);
      must(await api('PATCH', `/entries/${en.id}`, { token: orgz.token, body: { status: 'accepted' } }));
    }
    fx = must(await api('POST', `/events/${ev.id}/fixtures`, { token: orgz.token, body: { home_team_id: team.id, away_team_id: rivalTeam.id, scheduled_at: new Date(Date.now() + 864e5).toISOString() } }), 201);
    await q("UPDATE fixtures SET scheduled_at = now() - interval '10 days', status='completed', home_score=2, away_score=0 WHERE id=$1", [fx.id]);
    await q("INSERT INTO match_appearances(fixture_id, team_id, user_id, status, on_clock_seconds, minutes_played, minutes_basis, source, authority, verified_at, created_by) VALUES ($1,$2,$3,'started',0,90,'official_sheet','official_sheet',40,now(),$4)", [fx.id, team.id, player.id, orgz.id]);
    for (const seq of [1, 2]) await q("INSERT INTO match_events(fixture_id, event_id, seq, kind, side, team_id, player_id, recorded_by) VALUES ($1,$2,$3,'goal','home',$4,$5,$6)", [fx.id, ev.id, seq, team.id, player.id, orgz.id]);
    fx.event_id = ev.id;
  }
  return { owner, manager, player, team, resp, fx };
}
const contractOf = async (c, o = {}) => must(await api('POST', '/player-contracts', { token: c.owner.token, body: { team_id: c.team.id, response_id: c.resp.id, title: 'Season contract', terms: terms(), client_key: key(), ...o } }), 201);
const live = async (c, o = {}) => {
  const k = await contractOf(c, { send: true, ...o });
  assert.equal(k.status, 'offered');
  const s = must(await api('POST', `/contract-versions/${k.pending.id}/decision`, { token: c.player.token, body: { decision: 'sign' } }));
  assert.equal(s.status, 'active');
  return s;
};
const verifyAccount = async (player) => {
  must(await api('POST', '/me/payout-accounts', { token: player.token, body: { currency: 'INR', holder_name: 'Player One', account_number: '1234567890', bank_code: 'HDFC0001234' } }), 201);
  await q("UPDATE payout_accounts SET status='verified', decided_by=$2, decided_at=now() WHERE owner_id=$1 AND status='pending'", [player.id, admin.id]);
};

test('an accepted opportunity becomes a contract: drafts stay private, offer is signed, the fee recorded on acceptance moves into the contract', async () => {
  const c = await club({ withGame: false });
  const cand = must(await api('GET', '/player-contracts/candidates', { token: c.owner.token, query: { team_id: c.team.id } }));
  assert.equal(cand.length, 1);
  assert.equal(cand[0].legacy_amount_cents, 250000);
  assert.equal(cand[0].legacy_status, 'due');
  // nobody else sees the candidates
  assert.equal((await api('GET', '/player-contracts/candidates', { token: c.player.token, query: { team_id: c.team.id } })).status, 403);

  const d = await contractOf(c);
  assert.equal(d.status, 'draft');
  assert.equal(d.pending, null);
  assert.equal(d.versions[0].status, 'draft');
  assert.match(d.contract_no, /^PC-\d{4}-\d{4}$/);
  assert.equal(d.ladder.committed_cents, null, 'nothing is committed before the offer is sent');
  assert.equal((await api('GET', `/player-contracts/${d.id}`, { token: c.player.token })).status, 404, 'a draft is the club\'s until it is sent');
  assert.equal((await api('GET', `/player-contracts/${d.id}`, { token: (await signup()).token })).status, 404, 'outsiders learn nothing');
  // duplicate application and a retry with the same key
  assert.equal(code(await api('POST', '/player-contracts', { token: c.owner.token, body: { team_id: c.team.id, response_id: c.resp.id, title: 'Again', terms: terms() } })), 'duplicate');
  // draft edits need the current row_version
  const upd = must(await api('PATCH', `/player-contracts/${d.id}`, { token: c.owner.token, body: { row_version: d.row_version, title: 'Season 2026 contract' } }));
  assert.equal(upd.title, 'Season 2026 contract');
  const stale = await api('PATCH', `/player-contracts/${d.id}`, { token: c.owner.token, body: { row_version: d.row_version, title: 'x' } });
  assert.equal(stale.status, 409); assert.equal(code(stale), 'stale_version');
  // validation
  must(await api('POST', `/teams/${c.team.id}/members`, { token: c.owner.token, body: { user_id: c.player.id } }), 201);
  const bad = (t, re) => api('POST', '/player-contracts', { token: c.owner.token, body: { team_id: c.team.id, payee_id: c.player.id, title: 'x', terms: t } }).then((r) => { assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(JSON.stringify(r.body), re); });
  await bad(terms({ currency: 'USD' }), /same currency/);
  await bad(terms({ components: [{ kind: 'fixed', amount_cents: 100 }] }), /due date/);
  await bad(terms({ components: [{ kind: 'fixed', amount_cents: 100, due_on: day(90) }] }), /inside the contract term/);
  await bad(terms({ ends_on: day(-50) }), /cannot end before/);
  assert.equal((await api('POST', '/player-contracts', { token: c.player.token, body: { team_id: c.team.id, payee_id: c.player.id, title: 'x', terms: terms() } })).status, 403, 'a player cannot draft their own contract');

  // send: terms freeze, the player is asked to sign
  const sent = must(await api('POST', `/player-contracts/${d.id}/send`, { token: c.owner.token, body: { row_version: upd.row_version } }));
  assert.equal(sent.status, 'offered');
  assert.equal(sent.pending.version, 1);
  assert.deepEqual(sent.pending.waiting_for, ['player']);
  assert.equal(sent.ladder.earned_cents, 0, 'an offer is not earnings');
  assert.equal((await q('UPDATE player_contract_versions SET components = $2 WHERE contract_id=$1', [d.id, '[]']).catch((e) => e.code)), '23514', 'a sent version is frozen in the database too');
  const mine = must(await api('GET', '/player-contracts', { token: c.player.token }));
  assert.equal(mine[0].needs_my_action, true);
  // only a party can sign; a manager of the club cannot sign for the player
  assert.equal((await api('POST', `/contract-versions/${sent.pending.id}/decision`, { token: (await signup()).token, body: { decision: 'sign' } })).status, 404);
  const signed = must(await api('POST', `/contract-versions/${sent.pending.id}/decision`, { token: c.player.token, body: { decision: 'sign' } }));
  assert.equal(signed.status, 'active');
  assert.equal(signed.in_force.version, 1);
  assert.equal(signed.pending, null);
  // repeating the signature changes nothing
  assert.equal(must(await api('POST', `/contract-versions/${sent.pending.id}/decision`, { token: c.player.token, body: { decision: 'sign' } })).status, 'active');
  assert.equal((await q('SELECT count(*)::int AS n FROM player_contract_signatures WHERE version_id=$1', [sent.pending.id])).rows[0].n, 2);
  // the fee recorded on acceptance is settled through the contract: kept, cancelled, and earned once from the due date
  const legacy = (await q('SELECT status, note FROM team_payouts WHERE id=$1', [cand[0].legacy_payout_id])).rows[0];
  assert.equal(legacy.status, 'cancelled'); assert.match(legacy.note, /moved to contract/);
  assert.equal(signed.ladder.earned_cents, 250000);
  assert.equal(signed.ladder.withheld_cents, 25000);
  assert.equal(signed.ladder.owed_cents, 225000);
  assert.equal(signed.ladder.committed_cents > 0, true);
});

test('earnings come only from verified triggers, repeat safely, and a correction is a compensating line', async () => {
  const c = await club();
  const k = await live(c);
  // fixed 2,500 + appearance 4,000 + start 500 + two goals 2,000 + win 750 = 9,750; 10% withheld
  assert.equal(k.ladder.earned_cents, 975000);
  assert.equal(k.ladder.withheld_cents, 97500);
  assert.equal(k.ladder.owed_cents, 877500);
  const again = must(await api('POST', `/player-contracts/${k.id}/accrue`, { token: c.owner.token }));
  assert.equal(again.posted, 0, 'accruing twice posts nothing');
  // a game that is not verified earns nothing
  await q("UPDATE match_appearances SET verified_at=NULL WHERE fixture_id=$1", [c.fx.id]);
  const unverified = must(await api('POST', `/player-contracts/${k.id}/accrue`, { token: c.owner.token }));
  assert.equal(unverified.ladder.earned_cents, 250000, 'unverified minutes are reversed by compensating lines, not edited away');
  await q("UPDATE match_appearances SET verified_at=now() WHERE fixture_id=$1", [c.fx.id]);
  assert.equal(must(await api('POST', `/player-contracts/${k.id}/accrue`, { token: c.owner.token })).ladder.earned_cents, 975000);
  // a voided goal
  await q("UPDATE match_events SET voided_at=now() WHERE fixture_id=$1 AND seq=2", [c.fx.id]);
  const fixed = must(await api('GET', `/player-contracts/${k.id}`, { token: c.player.token }));
  assert.equal(fixed.ladder.earned_cents, 875000, 'reading brings earnings up to date');
  assert.equal(fixed.ladder.withheld_cents, 87500);
  const ledger = must(await api('GET', `/player-contracts/${k.id}/ledger`, { token: c.player.token }));
  assert.ok(ledger.entries.some((e) => e.kind === 'fee' && e.amount_cents < 0 && /Reversed|Recalculated|goal/i.test(e.label + (e.reason ?? ''))), 'the correction is a negative line');
  const seqs = ledger.entries.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a), 'newest first in a fixed order');
  // the ledger is append-only in the database
  assert.equal(await q('UPDATE player_contract_entries SET amount_cents=1 WHERE contract_id=$1', [k.id]).catch((e) => e.code), '23514');
  assert.equal(await q('DELETE FROM player_contract_entries WHERE contract_id=$1', [k.id]).catch((e) => e.code), '23514');
  // the ledger export is a file and is audit-logged
  const csv = must(await api('GET', `/player-contracts/${k.id}/ledger`, { token: c.owner.token, query: { format: 'csv' } }));
  assert.match(csv.csv, /occurred_on,kind,label,amount,currency,reason/);
  assert.equal((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='export_contract_ledger' AND entity_id=$1", [k.id])).rows[0].n, 1);
  // an adjustment needs a reason and posts once
  const adj = { amount_cents: -5000, label: 'Kit deposit', reason: 'Unreturned kit', client_key: key() };
  assert.equal((await api('POST', `/player-contracts/${k.id}/adjustments`, { token: c.manager.token, body: adj })).status, 403, 'a plain manager is not finance');
  const a1 = must(await api('POST', `/player-contracts/${k.id}/adjustments`, { token: c.owner.token, body: adj }), 201);
  const a2 = must(await api('POST', `/player-contracts/${k.id}/adjustments`, { token: c.owner.token, body: adj }), 201);
  assert.deepEqual([a1.duplicate, a2.duplicate], [false, true]);
  assert.equal(a2.ladder.owed_cents, 787500 - 5000);
  assert.equal(a2.ladder.adjustments_cents, -5000);
});

test('expenses: claims are checked against the contract cap, decided by the right people, and never self-approved', async () => {
  const c = await club({ withGame: false });
  const k = await live(c);
  const claim = (body) => api('POST', `/player-contracts/${k.id}/expenses`, { token: c.player.token, body: { category: 'travel', incurred_on: day(-3), amount_cents: 150000, client_key: key(), ...body } });
  const ck = key();
  const e1 = must(await claim({ client_key: ck, note: 'Bus to the ground' }), 201);
  const retry = must(await claim({ client_key: ck }), 201);
  assert.equal(retry.id, e1.id, 'a retry returns the same claim');
  assert.equal(e1.over_limit, false);
  const over = must(await claim({ amount_cents: 250000, category: 'accommodation' }), 201);
  assert.equal(over.over_limit, true, 'over the cap is accepted but flagged');
  assert.equal((await claim({ incurred_on: day(5) })).status, 400);
  assert.equal((await claim({ incurred_on: day(-90) })).status, 400);
  assert.equal((await api('POST', `/player-contracts/${k.id}/expenses`, { token: c.manager.token, body: { category: 'travel', incurred_on: day(-3), amount_cents: 100, client_key: key() } })).status, 403, 'only the person on the contract claims');
  // the note is stored encrypted
  assert.doesNotMatch((await q('SELECT note_enc FROM player_contract_expenses WHERE id=$1', [e1.id])).rows[0].note_enc, /Bus/);
  const queue = must(await api('GET', '/player-contract-expenses', { token: c.manager.token, query: { team_id: c.team.id } }));
  assert.equal(queue.length, 2);
  assert.equal((await api('GET', '/player-contract-expenses', { token: c.player.token, query: { team_id: c.team.id } })).status, 403);
  const decide = (tok, x, body) => api('POST', `/contract-expenses/${x.id}/decision`, { token: tok, body: { row_version: x.row_version, ...body } });
  assert.equal((await decide(c.player.token, e1, { decision: 'approve' })).status, 403, 'nobody approves their own claim');
  assert.equal((await decide(c.manager.token, over, { decision: 'approve' })).status, 403, 'over the limit needs the owner or finance team');
  assert.equal((await decide(c.manager.token, over, { decision: 'decline' })).status, 400, 'declining needs a reason');
  assert.equal((await decide(c.manager.token, { id: e1.id, row_version: 99 }, { decision: 'approve' })).status, 409);
  assert.equal(must(await decide(c.manager.token, e1, { decision: 'approve' })).status, 'approved');
  assert.equal(must(await decide(c.manager.token, e1, { decision: 'approve' })).status, 'approved', 'deciding twice changes nothing');
  assert.equal(must(await decide(c.owner.token, over, { decision: 'decline', reason: 'Hotel is not covered' })).status, 'declined');
  const view = must(await api('GET', `/player-contracts/${k.id}`, { token: c.player.token }));
  assert.equal(view.ladder.expenses_cents, 150000, 'only the approved claim is owed');
  assert.equal((await q("SELECT count(*)::int AS n FROM player_contract_entries WHERE contract_id=$1 AND kind='expense'", [k.id])).rows[0].n, 1);
  // receipts: the claimant attaches one, once; the club's managers can read it; outsiders cannot
  const rc = must(await claim({ amount_cents: 5000 }), 201);
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const put = (tok, xid, body) => fetch(`${base}/api/v1/player-contract-expenses/${xid}/receipt`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'image/png' }, body });
  assert.equal((await put(c.manager.token, rc.id, PNG)).status, 404, 'only the claimant attaches a receipt');
  assert.equal((await put(c.player.token, rc.id, Buffer.from('not a picture'))).status, 400);
  assert.equal((await put(c.player.token, rc.id, PNG)).status, 201);
  assert.equal((await put(c.player.token, rc.id, PNG)).status, 409, 'a receipt is set once');
  const got = await fetch(`${base}/api/v1/player-contract-expenses/${rc.id}/receipt`, { headers: { authorization: `Bearer ${c.manager.token}` } });
  assert.equal(got.status, 200); assert.equal(Buffer.from(await got.arrayBuffer()).equals(PNG), true);
  const stranger = await signup();
  assert.equal((await fetch(`${base}/api/v1/player-contract-expenses/${rc.id}/receipt`, { headers: { authorization: `Bearer ${stranger.token}` } })).status, 404);
  assert.equal(must(await api('GET', '/player-contract-expenses', { token: c.player.token })).find((x) => x.id === rc.id).has_receipt, true);
  assert.ok((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='read_pii' AND entity='player_contract_expenses'")).rows[0].n >= 1);
  // withdraw while waiting
  const w = must(await claim({ amount_cents: 1000 }), 201);
  assert.equal(must(await decide(c.player.token, w, { decision: 'withdraw' })).status, 'withdrawn');
});

test('payout run: checks block unpaid people, a second step approves, the bank file is audited, results post payments and statements', async () => {
  const c = await club();
  const k = await live(c);
  const x = must(await api('POST', `/player-contracts/${k.id}/expenses`, { token: c.player.token, body: { category: 'travel', incurred_on: day(-3), amount_cents: 150000, client_key: key() } }), 201);
  must(await api('POST', `/contract-expenses/${x.id}/decision`, { token: c.owner.token, body: { decision: 'approve', row_version: x.row_version } }));
  const run0 = { team_id: c.team.id, currency: 'INR' };
  // only finance prepares a run
  assert.equal((await api('POST', '/player-payout-runs', { token: c.manager.token, body: run0 })).status, 403);
  assert.equal((await api('POST', '/player-payout-runs', { token: c.owner.token, body: { ...run0, as_of: day(3) } })).status, 400);
  // no bank account: the line is listed, blocked, and stays owed
  const r1 = must(await api('POST', '/player-payout-runs', { token: c.owner.token, body: { ...run0, client_key: 'rk1' } }), 201);
  assert.equal(r1.lines.length, 1);
  assert.deepEqual([r1.lines[0].status, r1.lines[0].block_code], ['blocked', 'no_bank_account']);
  assert.equal(r1.totals.blocked, 1);
  assert.equal(must(await api('POST', '/player-payout-runs', { token: c.owner.token, body: { ...run0, client_key: 'rk1' } }), 201).id, r1.id, 'a retry returns the same run');
  assert.equal(code(await api('POST', '/player-payout-runs', { token: c.owner.token, body: { ...run0, client_key: 'rk2' } })), 'run_open', 'one open run per team and currency');
  assert.equal(code(await api('POST', `/player-payout-runs/${r1.id}/approve`, { token: c.owner.token, body: { row_version: r1.row_version } })), 'nothing_ready');
  must(await api('POST', `/player-payout-runs/${r1.id}/cancel`, { token: c.owner.token, body: { reason: 'Waiting for the bank account' } }));
  assert.equal((await q('SELECT status FROM player_payout_runs WHERE id=$1', [r1.id])).rows[0].status, 'cancelled', 'cancelled runs are kept');
  await verifyAccount(c.player);

  const r2 = must(await api('POST', '/player-payout-runs', { token: c.owner.token, body: run0 }), 201);
  const line = r2.lines[0];
  // 9,750 earned - 975 tax + 1,500 expense
  assert.deepEqual([line.status, line.net_cents, line.withheld_cents, line.gross_cents], ['ready', 1027500, 97500, 1125000]);
  const approvedBy = must(await api('POST', `/player-payout-runs/${r2.id}/approve`, { token: c.owner.token, body: { row_version: r2.row_version } }));
  assert.equal(approvedBy.status, 'approved');
  assert.equal(approvedBy.approval_basis, 'sole_authority', 'the owner is the only finance authority, so the approval is labelled as such');
  assert.equal(must(await api('POST', `/player-payout-runs/${r2.id}/approve`, { token: c.owner.token, body: { row_version: r2.row_version } })).status, 'approved', 'approving twice changes nothing');
  assert.equal((await api('POST', `/player-payout-lines/${line.id}/result`, { token: c.manager.token, body: { result: 'paid', reference: 'UTR123456' } })).status, 404, 'a plain manager cannot record payments');
  // the bank file
  const file = must(await api('POST', `/player-payout-runs/${r2.id}/export`, { token: c.owner.token }));
  assert.match(file.csv, /1234567890,HDFC0001234,INR,10275\.00/);
  assert.equal(file.rows, 1);
  assert.ok((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='read_payout_account' AND actor_id=$1", [c.owner.id])).rows[0].n >= 1);
  assert.equal((await q('SELECT status FROM player_payout_runs WHERE id=$1', [r2.id])).rows[0].status, 'exported');

  // results
  const res = (body) => api('POST', `/player-payout-lines/${line.id}/result`, { token: c.owner.token, body });
  assert.equal((await res({ result: 'paid' })).status, 400, 'paid needs a bank reference');
  const failed = must(await res({ result: 'failed', failure_reason: 'Bank returned the transfer' }));
  assert.equal(failed.lines[0].status, 'failed');
  assert.equal(must(await api('GET', `/player-contracts/${k.id}`, { token: c.player.token })).ladder.owed_cents, 1027500, 'a failed transfer leaves the money owed');
  // next run pays it
  const r3 = must(await api('POST', '/player-payout-runs', { token: c.owner.token, body: run0 }), 201);
  assert.equal(r3.lines[0].net_cents, 1027500);
  must(await api('POST', `/player-payout-runs/${r3.id}/approve`, { token: c.owner.token, body: { row_version: r3.row_version } }));
  const l3 = r3.lines[0];
  const paid = must(await api('POST', `/player-payout-lines/${l3.id}/result`, { token: c.owner.token, body: { result: 'paid', reference: 'UTR-998877' } }));
  assert.equal(paid.status, 'closed');
  assert.equal(paid.totals.paid_cents, 1027500);
  assert.equal(must(await api('POST', `/player-payout-lines/${l3.id}/result`, { token: c.owner.token, body: { result: 'paid', reference: 'UTR-998877' } })).status, 'closed', 'repeating the result changes nothing');
  const after = must(await api('GET', `/player-contracts/${k.id}`, { token: c.player.token }));
  assert.deepEqual([after.ladder.paid_cents, after.ladder.owed_cents], [1027500, 0]);
  assert.equal((await q("SELECT count(*)::int AS n FROM player_contract_entries WHERE contract_id=$1 AND kind='payment'", [k.id])).rows[0].n, 1);
  assert.equal((await q("SELECT status FROM player_contract_expenses WHERE id=$1", [x.id])).rows[0].status, 'reimbursed');
  // the team's existing settlement ledger records the payment
  const tp = (await q("SELECT amount_cents, status FROM team_payouts WHERE team_id=$1 AND user_id=$2 AND status='paid'", [c.team.id, c.player.id])).rows;
  assert.deepEqual(tp.map((r) => [Number(r.amount_cents), r.status]), [[1027500, 'paid']]);
  // statement: sequential, covers the lines, shows the tax withheld
  const inv = must(await api('GET', '/player-contract-invoices', { token: c.player.token }));
  assert.equal(inv.length, 1);
  assert.match(inv[0].number, /^INV-\d{4}-0001$/);
  const detail = must(await api('GET', `/player-contract-invoices/${inv[0].id}`, { token: c.player.token }));
  assert.deepEqual([detail.net_cents, detail.withheld_cents, detail.gross_cents], [1027500, 97500, 1125000]);
  assert.ok(detail.lines.some((l) => l.kind === 'withholding' && l.amount_cents < 0));
  // a correction is a credit note, not an edit
  assert.equal((await api('POST', `/player-contract-invoices/${inv[0].id}/credit-note`, { token: c.manager.token, body: { amount_cents: 100, reason: 'Wrong', client_key: key() } })).status, 403);
  assert.equal(code(await api('POST', `/player-contract-invoices/${inv[0].id}/credit-note`, { token: c.owner.token, body: { amount_cents: 99999999, reason: 'Too much', client_key: key() } })), 'exceeds_statement');
  const cnKey = key();
  const cn = must(await api('POST', `/player-contract-invoices/${inv[0].id}/credit-note`, { token: c.owner.token, body: { amount_cents: 20000, reason: 'Kit not returned', client_key: cnKey } }), 201);
  assert.match(cn.number, /^CN-\d{4}-0001$/);
  assert.equal(must(await api('POST', `/player-contract-invoices/${inv[0].id}/credit-note`, { token: c.owner.token, body: { amount_cents: 20000, reason: 'Kit not returned', client_key: cnKey } }), 201).duplicate, true);
  assert.equal(must(await api('GET', `/player-contracts/${k.id}`, { token: c.player.token })).ladder.owed_cents, -20000, 'the person now owes the club; a negative balance is never paid out');
  // the same bank reference cannot be reused on another payment
  const c2 = await club({ withGame: false });
  await verifyAccount(c2.player);
  const k2 = await live(c2);
  const r4 = must(await api('POST', '/player-payout-runs', { token: c2.owner.token, body: run0 && { team_id: c2.team.id, currency: 'INR' } }), 201);
  must(await api('POST', `/player-payout-runs/${r4.id}/approve`, { token: c2.owner.token, body: { row_version: r4.row_version } }));
  const dup = await api('POST', `/player-payout-lines/${r4.lines[0].id}/result`, { token: c2.owner.token, body: { result: 'paid', reference: 'UTR-998877' } });
  assert.equal(dup.status, 409); assert.equal(code(dup), 'duplicate_reference');
  void k2;
  // the desk reconciles ledger payments against recorded payout lines
  const desk = must(await api('GET', '/player-contract-desk', { token: c.owner.token, query: { team_id: c.team.id } }));
  assert.equal(desk.reconciliation[0].balanced, true);
  assert.equal(desk.money[0].paid_cents, 1027500);
  assert.equal((await api('GET', '/player-contract-desk', { token: c.player.token, query: { team_id: c.team.id } })).status, 403);
});

test('amendments: a new version, impact preview, counter-offers, signatures, retroactive adjustments and stale protection', async () => {
  const c = await club();
  const k = await live(c);
  assert.equal(k.ladder.earned_cents, 975000);
  // an earlier payment must never be touched by a later amendment
  await verifyAccount(c.player);
  const run = must(await api('POST', '/player-payout-runs', { token: c.owner.token, body: { team_id: c.team.id, currency: 'INR' } }), 201);
  must(await api('POST', `/player-payout-runs/${run.id}/approve`, { token: c.owner.token, body: { row_version: run.row_version } }));
  must(await api('POST', `/player-payout-lines/${run.lines[0].id}/result`, { token: c.owner.token, body: { result: 'paid', reference: 'UTR-AMEND-1' } }));
  const paidBefore = (await q("SELECT id FROM player_contract_entries WHERE contract_id=$1 AND kind='payment'", [k.id])).rows.map((r) => r.id);

  const raise = (o = {}) => ({ base_version: 1, amendment_types: ['fee_change'], reason: 'Renewal after good form', effective_from: day(-20), terms: terms({ components: terms().components.map((x) => (x.kind === 'appearance_fee' ? { ...x, amount_cents: 450000 } : x)) }), ...o });
  const staleBase = await api('POST', `/player-contracts/${k.id}/amendments/preview`, { token: c.owner.token, body: raise({ base_version: 7 }) });
  assert.equal(staleBase.status, 409); assert.equal(code(staleBase), 'stale_version');
  assert.equal((await api('POST', `/player-contracts/${k.id}/amendments/preview`, { token: c.owner.token, body: raise({ terms: terms() }) })).status, 400, 'nothing changes');
  assert.equal((await api('POST', `/player-contracts/${k.id}/amendments/preview`, { token: c.owner.token, body: raise({ terms: terms({ starts_on: day(-30) }) }) })).status, 400, 'the start date cannot move');
  assert.equal((await api('POST', `/player-contracts/${k.id}/amendments`, { token: (await signup()).token, body: raise() })).status, 404);

  const pre = must(await api('POST', `/player-contracts/${k.id}/amendments/preview`, { token: c.owner.token, body: raise() }));
  assert.deepEqual(pre.changes.map((x) => x.field), ['component:appearance_fee']);
  assert.equal(pre.impact.retroactive, true);
  assert.equal(pre.impact.earned_lines_repriced, 1);
  assert.equal(pre.impact.adjustment_cents, 50000);
  assert.equal(pre.impact.value_change_cents, 500000);
  assert.equal(pre.impact.paid_entries_touched, 0);
  assert.equal(must(await api('GET', `/player-contracts/${k.id}`, { token: c.owner.token })).versions.length, 1, 'a preview saves nothing');

  const proposed = must(await api('POST', `/player-contracts/${k.id}/amendments`, { token: c.owner.token, body: raise() }), 201);
  assert.equal(proposed.pending.version, 2);
  assert.equal(proposed.pending.status, 'proposed');
  assert.deepEqual(proposed.pending.waiting_for, ['player']);
  assert.equal(proposed.in_force.version, 1, 'version 1 stays in force until the player signs');
  assert.equal(proposed.ladder.earned_cents, 975000, 'a proposal changes no money');
  assert.equal(code(await api('POST', `/player-contracts/${k.id}/amendments`, { token: c.owner.token, body: raise({ reason: 'again' }) })), 'amendment_pending');

  // counter-offer by the player replaces it; the club's proposal is kept as countered
  const counter = must(await api('POST', `/player-contracts/${k.id}/amendments`, { token: c.player.token, body: raise({ replace_pending: true, reason: 'I would like a higher fee', terms: terms({ components: terms().components.map((x) => (x.kind === 'appearance_fee' ? { ...x, amount_cents: 500000 } : x)) }) }) }), 201);
  assert.equal(counter.pending.version, 3);
  assert.deepEqual(counter.pending.waiting_for, ['team']);
  assert.equal(counter.versions.find((v) => v.version === 2).status, 'countered');
  // the player cannot sign for the club; the club signs
  assert.equal(must(await api('POST', `/contract-versions/${counter.pending.id}/decision`, { token: c.player.token, body: { decision: 'sign' } })).pending.version, 3, 'the player already signed their own counter; nothing else is theirs to sign');
  const done = must(await api('POST', `/contract-versions/${counter.pending.id}/decision`, { token: c.manager.token, body: { decision: 'sign' } }));
  assert.equal(done.in_force.version, 3);
  assert.equal(done.versions.find((v) => v.version === 1).status, 'superseded');
  assert.equal(done.pending, null);
  assert.equal(done.current_version, 3);
  // retroactive: the earned game is re-priced with a separate line; the payment is untouched
  assert.equal(done.ladder.earned_cents, 975000 + 100000, 'appearance fee 4,000 -> 5,000 for the game already played');
  assert.deepEqual((await q("SELECT id FROM player_contract_entries WHERE contract_id=$1 AND kind='payment'", [k.id])).rows.map((r) => r.id), paidBefore);
  assert.equal(done.ladder.paid_cents, 877500);
  assert.equal(done.ladder.owed_cents, 100000 - 10000, 'only the difference, less tax, is newly owed');
  // frozen history
  assert.equal(await q("UPDATE player_contract_versions SET ends_on = ends_on + 1 WHERE contract_id=$1 AND version=1", [k.id]).catch((e) => e.code), '23514');
  const cmp = must(await api('GET', `/player-contracts/${k.id}/compare`, { token: c.player.token, query: { from: 1, to: 3 } }));
  assert.deepEqual(cmp.changes.map((x) => [x.field, x.from, x.to]), [['component:appearance_fee', 400000, 500000]]);

  // a declined amendment leaves everything as it was; a withdrawn one too
  const p4 = must(await api('POST', `/player-contracts/${k.id}/amendments`, { token: c.owner.token, body: raise({ base_version: 3, effective_from: day(1), amendment_types: ['term_extension'], terms: terms({ ends_on: day(90), components: terms().components.map((x) => (x.kind === 'appearance_fee' ? { ...x, amount_cents: 500000 } : x)) }) }) }), 201);
  assert.equal(p4.pending.version, 4);
  assert.equal(must(await api('POST', `/contract-versions/${p4.pending.id}/decision`, { token: c.player.token, body: { decision: 'decline', comment: 'No thanks' } })).versions.find((v) => v.version === 4).status, 'declined');
  const p5 = must(await api('POST', `/player-contracts/${k.id}/amendments`, { token: c.owner.token, body: raise({ base_version: 3, effective_from: day(1), terms: terms({ components: terms().components.map((x) => (x.kind === 'appearance_fee' ? { ...x, amount_cents: 520000 } : x)) }) }) }), 201);
  assert.equal((await api('POST', `/contract-versions/${p5.pending.id}/withdraw`, { token: (await signup()).token, body: { reason: 'x' } })).status, 404);
  assert.equal(must(await api('POST', `/contract-versions/${p5.pending.id}/withdraw`, { token: c.owner.token, body: { reason: 'Changed our mind' } })).versions.find((v) => v.version === 5).status, 'withdrawn');
  assert.equal(code(await api('POST', `/contract-versions/${p5.pending.id}/decision`, { token: c.player.token, body: { decision: 'sign' } })), 'not_pending');

  // ending: pay stays earned up to the date, later dated payments are no longer owed
  const live3 = must(await api('GET', `/player-contracts/${k.id}`, { token: c.owner.token }));
  assert.equal((await api('POST', `/player-contracts/${k.id}/end`, { token: c.manager.token, body: { row_version: live3.row_version + 9, reason: 'x' } })).status, 409);
  const ended = must(await api('POST', `/player-contracts/${k.id}/end`, { token: c.manager.token, body: { row_version: live3.row_version, reason: 'Moved clubs' } }));
  assert.equal(ended.status, 'terminated');
  assert.equal(ended.ended_on, day(0));
  assert.equal((await api('POST', `/player-contracts/${k.id}/amendments`, { token: c.owner.token, body: raise({ base_version: 3 }) })).status, 409, 'an ended contract cannot be amended');
});

test('monthly pay and retention: earned by period, pro-rata when a contract ends early, retention lost if not under contract on the date', async () => {
  const c = await club({ withGame: false });
  const t = terms({ starts_on: day(-75), ends_on: day(100), components: [{ kind: 'monthly', amount_cents: 3000000 }, { kind: 'signing_fee', amount_cents: 500000 }, { kind: 'retention', amount_cents: 1500000, due_on: day(20) }] });
  const k = await live(c, { terms: t });
  // two complete month periods have ended; the signing fee was due at the start
  const periods = (await q("SELECT count(*)::int AS n FROM player_contract_entries WHERE contract_id=$1 AND component_key='monthly' AND kind='fee'", [k.id])).rows[0].n;
  assert.equal(periods, 2);
  assert.equal(k.ladder.earned_cents, 2 * 3000000 + 500000);
  assert.equal(k.upcoming.some((u) => u.label.startsWith('Retention')), true, 'upcoming payments are informational, not income');
  assert.equal(k.ladder.committed_cents > k.ladder.earned_cents, true);
  const ended = must(await api('POST', `/player-contracts/${k.id}/end`, { token: c.owner.token, body: { row_version: k.row_version, reason: 'Released' } }));
  const m = (await q("SELECT count(*)::int AS n, sum(amount_cents)::bigint AS s FROM player_contract_entries WHERE contract_id=$1 AND component_key='monthly' AND kind='fee'", [k.id])).rows[0];
  assert.equal(m.n, 3, 'the part month is added pro-rata');
  assert.ok(Number(m.s) > 6000000 && Number(m.s) < 9000000);
  assert.equal(ended.ladder.earned_cents > 6500000, true);
  assert.equal((await q("SELECT count(*)::int AS n FROM player_contract_entries WHERE contract_id=$1 AND component_key='retention'", [k.id])).rows[0].n, 0, 'retention is not owed to someone no longer under contract');
});

test('young people: a guardian must sign, consent is live, and staff lose sight of the contract the moment consent is withdrawn', async () => {
  const c = await club({ withGame: false });
  const parent = await signup(['athlete']);
  await q('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [c.player.id]);
  await q("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, c.player.id]);
  // no consent: the contract cannot be made
  const no = await api('POST', '/player-contracts', { token: c.owner.token, body: { team_id: c.team.id, response_id: c.resp.id, title: 'Youth', terms: terms() } });
  assert.equal(no.status, 409); assert.equal(code(no), 'guardian_consent_required');
  await q("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'participation',$2,1, now() + interval '30 days')", [c.player.id, parent.id]);
  const k = await contractOf(c, { send: true });
  assert.deepEqual(k.pending.waiting_for.sort(), ['guardian', 'player']);
  const g = must(await api('POST', `/contract-versions/${k.pending.id}/decision`, { token: parent.token, body: { decision: 'sign' } }));
  assert.equal(g.status, 'offered', 'the guardian alone does not complete it');
  assert.ok((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='read_pii' AND actor_id=$1", [parent.id])).rows[0].n >= 1, 'guardian reads are audit-logged');
  assert.equal(must(await api('POST', `/contract-versions/${k.pending.id}/decision`, { token: c.player.token, body: { decision: 'sign' } })).status, 'active');
  // consent withdrawn: staff and the young person lose access at once; the guardian keeps theirs; records stay
  await q('UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1', [c.player.id]);
  assert.equal((await api('GET', `/player-contracts/${k.id}`, { token: c.owner.token })).status, 404);
  assert.equal((await api('GET', `/player-contracts/${k.id}`, { token: c.player.token })).status, 404);
  assert.equal((await api('GET', `/player-contracts/${k.id}`, { token: parent.token })).status, 200);
  const list = must(await api('GET', '/player-contracts', { token: c.owner.token, query: { team_id: c.team.id } }));
  assert.deepEqual(list.map((r) => [r.hidden, r.title ?? null]), [[true, null]], 'staff see a placeholder with no name or amounts');
  const queue = must(await api('GET', '/player-contract-expenses', { token: c.owner.token, query: { team_id: c.team.id } }));
  assert.deepEqual(queue, []);
  assert.equal((await q('SELECT count(*)::int AS n FROM player_contracts WHERE id=$1', [k.id])).rows[0].n, 1, 'nothing was deleted');
  // payment is blocked while consent is not current
  await verifyAccount(c.player).catch(() => {});
  const run = await api('POST', '/player-payout-runs', { token: c.owner.token, body: { team_id: c.team.id, currency: 'INR' } });
  assert.equal(run.status, 201);
  assert.ok(run.body.lines.every((l) => l.status === 'blocked' && l.hidden === true));
});

test('separation of duties: a second finance person approves a run, nobody approves or decides their own pay', async () => {
  const c = await club({ withGame: false });
  const fin = await signup(['organizer']);
  const org = (await q("INSERT INTO organisations(name, kind, created_by) VALUES ('Strikers FC', 'club', $1) RETURNING id", [c.owner.id])).rows[0];
  await q("INSERT INTO organisation_members(organisation_id, user_id, role, status) VALUES ($1,$2,'owner','active'), ($1,$3,'finance','active')", [org.id, c.owner.id, fin.id]);
  await q('UPDATE teams SET organisation_id=$2 WHERE id=$1', [c.team.id, org.id]);
  // a contract above the finance threshold needs finance as well as the player; the proposer cannot give that approval
  const offer = await contractOf(c, { send: true });
  assert.deepEqual(offer.pending.waiting_for.sort(), ['finance', 'player']);
  assert.equal(must(await api('POST', `/contract-versions/${offer.pending.id}/decision`, { token: c.owner.token, body: { decision: 'sign' } })).status, 'offered', 'the proposer is not the second person');
  assert.equal(must(await api('POST', `/contract-versions/${offer.pending.id}/decision`, { token: c.player.token, body: { decision: 'sign' } })).status, 'offered');
  assert.equal(must(await api('POST', `/contract-versions/${offer.pending.id}/decision`, { token: fin.token, body: { decision: 'sign' } })).status, 'active');
  await verifyAccount(c.player);
  const r = must(await api('POST', '/player-payout-runs', { token: c.owner.token, body: { team_id: c.team.id, currency: 'INR' } }), 201);
  assert.equal((await api('POST', `/player-payout-runs/${r.id}/approve`, { token: c.owner.token, body: { row_version: r.row_version } })).status, 403, 'the preparer cannot approve when someone else can');
  const ok = must(await api('POST', `/player-payout-runs/${r.id}/approve`, { token: fin.token, body: { row_version: r.row_version } }));
  assert.equal(ok.approval_basis, 'second_person');
  // a player who is also a manager cannot act on their own contract
  const self = await api('GET', `/player-payout-runs/${r.id}`, { token: c.player.token });
  assert.equal(self.status, 404);
  assert.equal((await api('POST', `/player-contracts/${(await q('SELECT id FROM player_contracts WHERE payee_id=$1', [c.player.id])).rows[0].id}/adjustments`, { token: c.player.token, body: { amount_cents: 5000, label: 'x', reason: 'give me money', client_key: key() } })).status, 403);
});

test('regression: squad fees skip people paid through a contract, so nobody is paid twice', async () => {
  const c = await club();
  must(await api('POST', `/teams/${c.team.id}/members`, { token: c.owner.token, body: { user_id: c.player.id } }), 201);
  must(await api('PATCH', `/teams/${c.team.id}/members/${c.player.id}`, { token: c.owner.token, body: { rate_cents: 300000, rate_unit: 'match' } }));
  await q("INSERT INTO team_squads(team_id, user_id, event_id, role, status, selected_by) VALUES ($1,$2,$3,'player','selected',$4)", [c.team.id, c.player.id, c.fx.event_id, c.owner.id]);
  const before = must(await api('POST', `/teams/${c.team.id}/payouts/from-squad`, { token: c.owner.token, body: { event_id: c.fx.event_id } }), 201);
  assert.equal(before.created.length, 1, 'without a contract the squad fee is created as before');
  await q("DELETE FROM team_payouts WHERE team_id=$1 AND squad_id IS NOT NULL", [c.team.id]);
  await live(c);
  const after = must(await api('POST', `/teams/${c.team.id}/payouts/from-squad`, { token: c.owner.token, body: { event_id: c.fx.event_id } }), 201);
  assert.equal(after.created.length, 0);
  assert.match(after.skipped[0].reason, /paid through contract PC-/);
});

test('concurrency: parallel runs, parallel results and parallel accruals keep the ledger exact', async () => {
  const c = await club();
  const k = await live(c);
  await verifyAccount(c.player);
  const accrue = await Promise.all(Array.from({ length: 6 }, () => api('POST', `/player-contracts/${k.id}/accrue`, { token: c.owner.token })));
  assert.ok(accrue.every((r) => r.status === 200), 'parallel accruals all succeed');
  const dups = (await q("SELECT count(*)::int AS n FROM (SELECT component_key, source_key, kind FROM player_contract_entries WHERE contract_id=$1 GROUP BY 1,2,3 HAVING count(*) > 1) d", [k.id])).rows[0].n;
  assert.equal(dups, 0, 'no earning is posted twice');
  assert.equal(must(await api('GET', `/player-contracts/${k.id}`, { token: c.owner.token })).ladder.earned_cents, 975000);
  const runs = await Promise.all(Array.from({ length: 5 }, (_, n) => api('POST', '/player-payout-runs', { token: c.owner.token, body: { team_id: c.team.id, currency: 'INR', client_key: `par-${n}` } })));
  const ok = runs.filter((r) => r.status === 201);
  assert.equal(ok.length, 1, JSON.stringify(runs.map((r) => r.status)));
  assert.ok(runs.filter((r) => r.status !== 201).every((r) => r.status === 409), 'the rest are refused, not duplicated');
  const run = ok[0].body;
  must(await api('POST', `/player-payout-runs/${run.id}/approve`, { token: c.owner.token, body: { row_version: run.row_version } }));
  const results = await Promise.all(Array.from({ length: 4 }, () => api('POST', `/player-payout-lines/${run.lines[0].id}/result`, { token: c.owner.token, body: { result: 'paid', reference: 'UTR-PARALLEL-1' } })));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal((await q("SELECT count(*)::int AS n FROM player_contract_entries WHERE contract_id=$1 AND kind='payment'", [k.id])).rows[0].n, 1, 'one transfer, one payment');
  assert.equal((await q("SELECT count(*)::int AS n FROM player_contract_invoices WHERE contract_id=$1", [k.id])).rows[0].n, 1);
  assert.equal(must(await api('GET', `/player-contracts/${k.id}`, { token: c.owner.token })).ladder.owed_cents, 0);
  // two people signing the same version at once
  const c2 = await club({ withGame: false });
  const o = await contractOf(c2, { send: true });
  const sig = await Promise.all([1, 2, 3].map(() => api('POST', `/contract-versions/${o.pending.id}/decision`, { token: c2.player.token, body: { decision: 'sign' } })));
  assert.ok(sig.every((r) => r.status === 200));
  assert.equal((await q('SELECT count(*)::int AS n FROM player_contract_signatures WHERE version_id=$1', [o.pending.id])).rows[0].n, 2);
});

test('the worker keeps earnings current, and the desk shows them without anyone opening the contract', async () => {
  const { maintenanceCycle } = await import('../src/worker.js');
  const c = await club();
  const k = await live(c);
  assert.equal(k.ladder.earned_cents, 975000);
  await q('UPDATE match_events SET voided_at=now() WHERE fixture_id=$1 AND seq=2', [c.fx.id]);
  const cycle = await maintenanceCycle();
  assert.ok(cycle.contract_earnings_posted >= 2, JSON.stringify(cycle));
  const ledger = (await q("SELECT coalesce(sum(amount_cents) FILTER (WHERE kind='fee'),0)::bigint AS s FROM player_contract_entries WHERE contract_id=$1", [k.id])).rows[0].s;
  assert.equal(Number(ledger), 875000, 'posted by the worker, before anyone read the contract');
  assert.equal((await maintenanceCycle()).contract_earnings_posted, 0, 'a second cycle posts nothing');
  const desk = must(await api('GET', '/player-contract-desk', { token: c.owner.token, query: { team_id: c.team.id } }));
  assert.equal(desk.money[0].earned_cents, 875000);
  assert.equal(desk.contracts_by_status.active, 1);
});

test('export holds back a line whose bank account changed after approval, and it stays owed', async () => {
  const c = await club();
  const k = await live(c);
  await verifyAccount(c.player);
  const r = must(await api('POST', '/player-payout-runs', { token: c.owner.token, body: { team_id: c.team.id, currency: 'INR' } }), 201);
  must(await api('POST', `/player-payout-runs/${r.id}/approve`, { token: c.owner.token, body: { row_version: r.row_version } }));
  await q("UPDATE payout_accounts SET status='superseded' WHERE owner_id=$1", [c.player.id]);
  const file = must(await api('POST', `/player-payout-runs/${r.id}/export`, { token: c.owner.token }));
  assert.equal(file.rows, 0);
  assert.equal(file.held_back.length, 1);
  assert.match(file.held_back[0].reason, /bank account/i);
  assert.equal((await q('SELECT status, block_code FROM player_payout_lines WHERE id=$1', [r.lines[0].id])).rows[0].status, 'blocked');
  assert.equal(must(await api('GET', `/player-contracts/${k.id}`, { token: c.player.token })).ladder.owed_cents, 877500, 'nothing was paid');
  // adjustments and refunds cannot be dated in the future
  assert.equal((await api('POST', `/player-contracts/${k.id}/adjustments`, { token: c.owner.token, body: { amount_cents: 100, label: 'x', reason: 'future', occurred_on: day(3), client_key: key() } })).status, 400);
});

test('every capability is classified, in OpenAPI and MCP', async () => {
  const { capabilities } = await import('../src/capabilities/index.js');
  const mine = capabilities.filter((x) => ['Player contracts', 'Player contract money'].includes(x.tag));
  assert.ok(mine.length >= 28, `expected the full surface, got ${mine.length}`);
  const money = ['create_payout_run', 'approve_payout_run', 'export_payout_run', 'record_payout_line_result', 'cancel_payout_run', 'add_contract_adjustment', 'record_contract_refund', 'issue_contract_credit_note', 'decide_contract_expense'];
  for (const name of money) assert.equal(capabilities.find((x) => x.name === name).scope, 'payment', name);
  const doc = (await import('../src/openapi.js')).buildOpenApi();
  const ids = new Set(Object.values(doc.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId));
  for (const x of mine) assert.ok(ids.has(x.name), `${x.name} in OpenAPI`);
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${admin.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const tools = new Set((await r.json()).result.tools.map((t) => t.name));
  for (const x of mine) assert.ok(tools.has(x.name), `${x.name} is an MCP tool`);
});
