// Issue #516: team communication (real time, replies, reactions, pins, polls, media, RSVP prompts, guardians channel) and member finance
// (dues, match fees, split expenses, fundraising, offline and online payments, privacy).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { settle } = await import('../src/payments/service.js');
const { raiseTeamDues, remindTeamCharges, splitShares } = await import('../src/team-money.js');
const { capabilities } = await import('../src/registry.js');
const { buildOpenApi } = await import('../src/openapi.js');

let server, base;
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const put = async (path, token, bytes, headers = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', ...headers }, body: bytes });
  return { status: r.status, body: await r.json() };
};
const getRaw = (path, token) => fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await call('POST', '/auth/register', { body: { handle: `tc_${n}`, display_name: `Tc ${n}`, email: `tc${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
const WEBM = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(40)]);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const setup = async (players = 3) => {
  const owner = await signup();
  const team = (await call('POST', '/teams', { token: owner.token, body: { name: `Hawks ${n}`, sport: 'cricket' } })).body;
  const ps = [];
  for (let k = 0; k < players; k++) {
    const p = await signup();
    assert.equal((await call('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: p.id } })).status, 201);
    ps.push(p);
  }
  return { owner, team, ps };
};
// a young player with a verified guardian and the consent a team chat needs
const youngPlayer = async (team, owner) => {
  const kid = await signup(), parent = await signup();
  assert.equal((await call('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: kid.id } })).status, 201);
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  await pool.query("INSERT INTO youth_consents(child_id, purpose, granted_by, policy_version, expires_at) VALUES ($1,'contact',$2,1, now() + interval '30 days')", [kid.id, parent.id]);
  return { kid, parent };
};

// ------------------------------------------------------------------------------------------------------------------ communication
test('real time: client ids dedupe retries, after_seq resumes, a long poll wakes on a new message', async () => {
  const { owner, team, ps: [p, q] } = await setup(2);
  const url = `/teams/${team.id}/messages`;
  const cid = key();
  const a = await call('POST', url, { token: p.token, body: { body: 'Nets at 6?', client_id: cid } });
  const b = await call('POST', url, { token: p.token, body: { body: 'Nets at 6?', client_id: cid } });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.equal(a.body.message_id, b.body.message_id, 'a retried send is the same message');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_messages WHERE team_id=$1', [team.id])).rows[0].n, 1);

  const cursor = a.body.seq;
  const waiting = call('GET', `${url}?after_seq=${cursor}&wait_seconds=10`, { token: q.token });   // nothing newer yet: held open
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await call('POST', url, { token: owner.token, body: { body: 'Yes, 6 sharp' } });
  const got = await waiting;
  assert.equal(got.body.length, 1); assert.equal(got.body[0].body, 'Yes, 6 sharp');
  assert.ok(Date.now() - t0 < 3000, 'delivered when sent, not on a timer');
  // a reconnect that repeats the old cursor gets the same message again with the same id: the client dedupes by message_id
  const again = await call('GET', `${url}?after_seq=${cursor}`, { token: q.token });
  assert.deepEqual(again.body.map((m) => m.message_id), got.body.map((m) => m.message_id));
  // an empty wait returns [] after the timeout and never errors
  const empty = await call('GET', `${url}?after_seq=${got.body[0].seq}&wait_seconds=1`, { token: q.token });
  assert.deepEqual(empty.body, []);
});

test('real time: the SSE stream resumes from a cursor, pushes changes and closes when access is revoked', async () => {
  const { owner, team, ps: [p, q] } = await setup(2);
  const url = `/teams/${team.id}/messages`;
  const m1 = (await call('POST', url, { token: p.token, body: { body: 'first' } })).body;
  const frames = [];
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/v1${url}/stream?cursor=0`, { headers: { authorization: `Bearer ${q.token}` }, signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  let buf = '', ended = false;
  (async () => {
    try { for await (const chunk of res.body) { buf += Buffer.from(chunk).toString(); let k; while ((k = buf.indexOf('\n\n')) >= 0) { frames.push(buf.slice(0, k)); buf = buf.slice(k + 2); } } } catch { /* aborted */ }
    ended = true;
  })();
  const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  assert.ok(await until(() => frames.some((f) => f.includes('event: messages') && f.includes('first'))), 'missed message replayed from the cursor');
  await call('POST', url, { token: owner.token, body: { body: 'second' } });
  assert.ok(await until(() => frames.some((f) => f.includes('second'))), 'new message pushed');
  await call('POST', `${url}/${m1.message_id}/reactions`, { token: owner.token, body: { emoji: '👍' } });
  assert.ok(await until(() => frames.some((f) => f.includes('👍'))), 'a reaction on an older message is pushed too');
  // revoke: the next frame closes the stream, and a fresh one is refused
  await call('DELETE', `/teams/${team.id}/members/${q.id}`, { token: owner.token });
  await call('POST', url, { token: owner.token, body: { body: 'after removal' } });
  assert.ok(await until(() => frames.some((f) => f.includes('event: revoked')) && ended), 'stream says revoked and closes');
  assert.ok(!frames.some((f) => f.includes('after removal')), 'the removed member never sees what is said after');
  ctl.abort();
  assert.equal((await getRaw(`${url}/stream`, q.token)).status, 404);
  assert.equal((await call('GET', url, { token: q.token })).status, 403);
});

test('replies, reactions, pins and polls', async () => {
  const { owner, team, ps: [p, q] } = await setup(2);
  const url = `/teams/${team.id}/messages`;
  const m = (await call('POST', url, { token: p.token, body: { body: 'Who has the kit bag?' } })).body;
  const r = (await call('POST', url, { token: q.token, body: { body: 'I do', reply_to_id: m.message_id } })).body;
  assert.equal(r.reply_to.message_id, m.message_id); assert.equal(r.reply_to.body, 'Who has the kit bag?');
  assert.equal((await call('POST', url, { token: q.token, body: { body: 'x', reply_to_id: '00000000-0000-4000-8000-000000000000' } })).status, 404);

  // reactions: a toggle that keeps its rows
  let x = (await call('POST', `${url}/${m.message_id}/reactions`, { token: q.token, body: { emoji: '🙌' } })).body;
  assert.deepEqual(x.reactions, [{ emoji: '🙌', count: 1, mine: true }]);
  await call('POST', `${url}/${m.message_id}/reactions`, { token: p.token, body: { emoji: '🙌' } });
  x = (await call('POST', `${url}/${m.message_id}/reactions`, { token: q.token, body: { emoji: '🙌', on: false } })).body;
  assert.deepEqual(x.reactions, [{ emoji: '🙌', count: 1, mine: false }]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_message_reactions WHERE message_id=$1', [m.message_id])).rows[0].n, 2, 'withdrawn reaction row is kept');

  // pins: managers only
  assert.equal((await call('POST', `${url}/${m.message_id}/pin`, { token: p.token, body: {} })).status, 403);
  assert.ok((await call('POST', `${url}/${m.message_id}/pin`, { token: owner.token, body: {} })).body.pinned_at);
  assert.equal((await call('GET', `${url}?pinned=true`, { token: q.token })).body.length, 1);

  // polls: single choice, changed vote, counts only, closing
  const poll = await call('POST', `/teams/${team.id}/polls`, { token: owner.token, body: { question: 'Kit colour?', options: ['Blue', 'Red', 'Green'] } });
  assert.equal(poll.status, 201, JSON.stringify(poll.body));
  const [blue, red] = poll.body.poll.options;
  assert.equal((await call('POST', `/teams/${team.id}/polls/${poll.body.message_id}/vote`, { token: p.token, body: { option_ids: [blue.option_id, red.option_id] } })).status, 400, 'one choice only');
  await call('POST', `/teams/${team.id}/polls/${poll.body.message_id}/vote`, { token: p.token, body: { option_ids: [blue.option_id] } });
  let v = (await call('POST', `/teams/${team.id}/polls/${poll.body.message_id}/vote`, { token: p.token, body: { option_ids: [red.option_id] } })).body;
  assert.deepEqual(v.poll.options.map((o) => o.votes), [0, 1, 0]); assert.equal(v.poll.options[1].mine, true);
  assert.equal(JSON.stringify(v).includes(p.id), false, 'nobody sees who voted what');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_poll_votes WHERE message_id=$1', [poll.body.message_id])).rows[0].n, 2, 'the changed vote is kept as withdrawn');
  assert.equal((await call('POST', `/teams/${team.id}/polls/${poll.body.message_id}/close`, { token: q.token })).status, 403);
  assert.equal((await call('POST', `/teams/${team.id}/polls/${poll.body.message_id}/close`, { token: owner.token })).body.poll.closed, true);
  assert.equal((await call('POST', `/teams/${team.id}/polls/${poll.body.message_id}/vote`, { token: q.token, body: { option_ids: [blue.option_id] } })).status, 409);
  assert.ok(JSON.stringify((await call('GET', '/notifications', { token: q.token })).body).includes('Kit colour?'), 'members are told about a poll');
});

test('an RSVP prompt points at the canonical attendance and stores no answers of its own', async () => {
  const { owner, team, ps: [p, q] } = await setup(2);
  const org = await signup(['organizer']);
  const ev = (await call('POST', '/events', { token: org.token, body: { name: 'Winter Cup', sport: 'cricket', starts_on: day(5), ends_on: day(6), entry_fee_cents: 0 } })).body;
  await pool.query('UPDATE teams SET event_id=$2 WHERE id=$1', [team.id, ev.id]);
  const prompt = await call('POST', `/teams/${team.id}/rsvp-prompts`, { token: owner.token, body: { event_id: ev.id, note: 'Saturday nets' } });
  assert.equal(prompt.status, 201, JSON.stringify(prompt.body));
  assert.equal(prompt.body.kind, 'rsvp'); assert.equal(prompt.body.rsvp.counts.pending, 3);
  assert.equal((await call('POST', `/teams/${team.id}/rsvp-prompts`, { token: p.token, body: { event_id: ev.id } })).status, 403);
  assert.equal((await call('POST', `/teams/${team.id}/attendance`, { token: p.token, body: { event_id: ev.id, rsvp: 'going' } })).status, 200);
  const card = (await call('GET', `/teams/${team.id}/messages`, { token: p.token })).body.find((m) => m.kind === 'rsvp');
  assert.deepEqual([card.rsvp.counts.going, card.rsvp.counts.pending, card.rsvp.mine], [1, 2, 'going'], 'the card reads team_attendance live');
  const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('team_messages','team_polls')")).rows.map((r) => r.column_name);
  assert.ok(!cols.includes('rsvp'), 'no second RSVP state in chat');
  assert.ok(JSON.stringify((await call('GET', '/notifications', { token: q.token })).body).includes('are you coming'));
});

test('photos, files and voice notes: sniffed from bytes, served only to current members, gone with the message', async () => {
  const { owner, team, ps: [p, q] } = await setup(2);
  const outsider = await signup();
  const up = (token, kind, bytes, extra = '') => put(`/teams/${team.id}/chat-media?kind=${kind}&name=pic${extra}`, token, bytes);
  assert.equal((await up(p.token, 'image', Buffer.from('not an image at all, really'))).status, 400);
  assert.equal((await up(outsider.token, 'image', PNG)).status, 403);
  assert.equal((await up(p.token, 'voice', WEBM)).status, 400, 'a voice note needs its length');
  const img = await up(p.token, 'image', PNG);
  assert.equal(img.status, 201, JSON.stringify(img.body));
  assert.equal((await getRaw(img.body.url.replace('/api/v1', ''), q.token)).status, 404, 'not visible until it is on a message');
  const msg = await call('POST', `/teams/${team.id}/messages`, { token: p.token, body: { body: '', media_id: img.body.media_id } });
  assert.equal(msg.status, 201, JSON.stringify(msg.body));
  assert.equal(msg.body.kind, 'media'); assert.equal(msg.body.media.kind, 'image');
  const dl = await getRaw(img.body.url.replace('/api/v1', ''), q.token);
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PNG, 'round-trips through encrypted storage');
  assert.equal((await getRaw(img.body.url.replace('/api/v1', ''), outsider.token)).status, 404);
  const voice = await put(`/teams/${team.id}/chat-media?kind=voice&seconds=12&name=note`, p.token, WEBM);
  assert.equal(voice.status, 201, JSON.stringify(voice.body));
  assert.equal(voice.body.content_type, 'audio/webm');
  // the file on disk is not the plain bytes
  const row = (await pool.query('SELECT file_name FROM team_chat_media WHERE id=$1', [img.body.media_id])).rows[0];
  const { readFile } = await import('node:fs/promises');
  const { config } = await import('../src/config.js');
  assert.ok(!(await readFile(`${config.mediaDir}/team-chat/${row.file_name}`)).includes(PNG), 'stored encrypted');
  // removal ends access
  await call('DELETE', `/teams/${team.id}/messages/${msg.body.message_id}`, { token: owner.token });
  assert.equal((await getRaw(img.body.url.replace('/api/v1', ''), q.token)).status, 404);
  // leaving the team ends access for a message that is still there
  const keep = await call('POST', `/teams/${team.id}/messages`, { token: p.token, body: { body: 'pic', media_id: voice.body.media_id, client_id: key() } });
  assert.equal((await getRaw(voice.body.url.replace('/api/v1', ''), q.token)).status, 200);
  await call('DELETE', `/teams/${team.id}/members/${q.id}`, { token: owner.token });
  assert.equal((await getRaw(voice.body.url.replace('/api/v1', ''), q.token)).status, 404);
  assert.ok(keep.body.media);
});

test('young members: the guardians channel, guardian-only access, announcements to guardians, consent, revocation', async () => {
  const { owner, team, ps: [adult] } = await setup(1);
  const { kid, parent } = await youngPlayer(team, owner);
  const stranger = await signup();
  const url = `/teams/${team.id}/messages`;

  // the guardian is not on the team but can reach the guardians channel only
  const g = await call('POST', url, { token: parent.token, body: { body: 'Who can drive on Saturday?', audience: 'guardians' } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal((await call('POST', url, { token: parent.token, body: { body: 'hello team' } })).status, 403, 'a guardian cannot post in the team channel');
  assert.deepEqual((await call('GET', url, { token: parent.token })).body.map((m) => m.message_id), [g.body.message_id]);
  assert.equal((await call('GET', url, { token: adult.token })).body.length, 0, 'other players never see the guardians channel');
  assert.equal((await call('GET', url, { token: kid.token })).body.length, 0, 'nor does the young player');
  assert.equal((await call('GET', url, { token: stranger.token })).status, 403);
  assert.equal(JSON.stringify(g.body).includes(kid.id), false, 'no child is attached to a guardian message');
  assert.equal(Object.keys(g.body).some((k) => /email|phone|contact/i.test(k)), false);

  // the manager posts a guardians-only announcement: guardians are notified, players are not
  const ann = await call('POST', url, { token: owner.token, body: { body: 'Fees reminder for parents', audience: 'guardians', announcement: true } });
  assert.equal(ann.status, 201);
  assert.ok(JSON.stringify((await call('GET', '/notifications', { token: parent.token })).body).includes('Fees reminder'));
  assert.ok(!JSON.stringify((await call('GET', '/notifications', { token: adult.token })).body).includes('Fees reminder'));
  const chats = (await call('GET', '/me/team-chats', { token: parent.token })).body;
  assert.equal(chats.length, 1); assert.deepEqual(chats[0].channels, ['guardians']);

  // a young member needs live consent to post; withdrawing it blocks the next message, not the record
  assert.equal((await call('POST', url, { token: kid.token, body: { body: 'See you there' } })).status, 201);
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='contact'", [kid.id]);
  assert.equal((await call('POST', url, { token: kid.token, body: { body: 'again' } })).status, 409);

  // revoking the guardian link ends their access at once
  await pool.query("UPDATE guardian_links SET status='revoked', revoked_at=now() WHERE guardian_id=$1", [parent.id]);
  assert.equal((await call('GET', url, { token: parent.token })).status, 403);
});

// ------------------------------------------------------------------------------------------------------------------ finance
test('split shares add up to the paise, the same way every time', () => {
  const ids = ['b', 'a', 'c'];
  const s1 = splitShares(1000, ids, { mode: 'equal' });
  assert.deepEqual(s1.map(([u]) => u), ['a', 'b', 'c'], 'ordered by id so the result never depends on input order');
  assert.equal(s1.reduce((t, [, a]) => t + a, 0), 1000);
  assert.deepEqual(s1.map(([, a]) => a), [333, 334, 333]);
  assert.deepEqual(splitShares(1000, ['c', 'a', 'b'], { mode: 'equal' }), s1);
  const w = splitShares(1001, ['a', 'b'], { mode: 'weights', weights: { a: 1, b: 2 } });
  assert.equal(w.reduce((t, [, a]) => t + a, 0), 1001);
  assert.throws(() => splitShares(1000, ['a', 'b'], { mode: 'exact', exact: { a: 400, b: 500 } }), /add up/);
  assert.deepEqual(splitShares(0, ['a'], { mode: 'equal' }), [['a', 0]]);
  for (const total of [1, 2, 3, 99, 100, 101, 12345, 999999]) for (const k of [1, 2, 3, 7, 11]) {
    const r = splitShares(total, Array.from({ length: k }, (_, x) => `m${x}`), { mode: 'equal' });
    assert.equal(r.reduce((t, [, a]) => t + a, 0), total); assert.ok(Math.max(...r.map(([, a]) => a)) - Math.min(...r.map(([, a]) => a)) <= 1);
  }
});

test('dues and match fees: charges per member, guardian pays for a young player, retries add nothing, privacy holds', async () => {
  const { owner, team, ps: [p, q, r] } = await setup(3);
  const { kid, parent } = await youngPlayer(team, owner);
  const noGuardianKid = await signup();
  await call('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: noGuardianKid.id } });
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [noGuardianKid.id]);
  const k = key();
  const body = { kind: 'season_fee', title: 'Season 2026', amount_minor: 150000, due_on: day(10), idempotency_key: k };

  assert.equal((await call('POST', `/teams/${team.id}/charges`, { token: p.token, body })).status, 403, 'players cannot raise charges');
  const made = await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.charges_raised, 4);   // 3 players + the young player; the owner is staff and the second young player has no guardian
  const retry = await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body });
  assert.equal(retry.body.batch_id, made.body.batch_id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_charges WHERE team_id=$1', [team.id])).rows[0].n, made.body.charges_raised, 'a retry raised nothing more');
  assert.deepEqual(made.body.skipped.map((x) => x.user_id), [noGuardianKid.id]);
  assert.deepEqual(retry.body.skipped, [], 'the retry raises and skips nothing');
  const first = await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { ...body, idempotency_key: key(), title: 'Check skip' } });
  assert.deepEqual(first.body.skipped.map((s) => [s.user_id, s.reason]), [[noGuardianKid.id, 'no_verified_guardian']], 'a young player with no verified guardian is never charged');

  // the young player's charge is payable only by the guardian
  const kidCharge = (await pool.query('SELECT * FROM team_charges WHERE member_id=$1 AND batch_id=$2', [kid.id, made.body.batch_id])).rows[0];
  assert.equal(kidCharge.payer_id, parent.id);
  assert.equal((await call('GET', '/me/team-charges', { token: kid.token })).body.length, 0, 'the child sees no money');
  const mineParent = (await call('GET', '/me/team-charges', { token: parent.token })).body;
  assert.equal(mineParent.length, 2); assert.ok(mineParent.every((c) => c.for_member === kid.display_name));
  assert.ok(JSON.stringify((await call('GET', '/notifications', { token: parent.token })).body).includes('Season 2026'));
  assert.ok(!JSON.stringify((await call('GET', '/notifications', { token: kid.token })).body).includes('Season 2026'), 'the child is not messaged about money');

  // privacy: a member sees only their own; no ledger; no player pay in any finance payload
  const mine = (await call('GET', '/me/team-charges', { token: p.token })).body;
  assert.equal(mine.length, 2); assert.equal(mine[0].purpose.purpose_type, 'team_charge');
  assert.equal((await call('GET', `/teams/${team.id}/charges`, { token: p.token })).status, 403);
  assert.equal((await call('GET', `/teams/${team.id}/ledger`, { token: p.token })).status, 403);
  const other = (await pool.query('SELECT id FROM team_charges WHERE member_id=$1 LIMIT 1', [q.id])).rows[0];
  assert.equal((await call('GET', `/team-charges/${other.id}`, { token: p.token })).status, 404);
  const fin = (await call('GET', `/teams/${team.id}/my-finance`, { token: p.token })).body;
  assert.equal(fin.totals, null, 'team totals are off by default');
  await call('POST', `/teams/${team.id}/payouts`, { token: owner.token, body: { user_id: q.id, amount_cents: 777777, kind: 'match_fee' } }).catch(() => {});
  for (const payload of [fin, (await call('GET', `/teams/${team.id}/ledger`, { token: owner.token })).body, (await call('GET', `/teams/${team.id}/charges`, { token: owner.token })).body]) {
    assert.ok(!/payout|rate_cents|777777/i.test(JSON.stringify(payload)), 'finance screens never carry player pay');
  }
  assert.equal((await call('PATCH', `/teams/${team.id}/finance-settings`, { token: p.token, body: { members_see_totals: true } })).status, 403);
  await call('PATCH', `/teams/${team.id}/finance-settings`, { token: owner.token, body: { members_see_totals: true } });
  const withTotals = (await call('GET', `/teams/${team.id}/my-finance`, { token: p.token })).body;
  assert.equal(withTotals.totals.due_minor, 150000 * 8, 'two batches of four'); assert.equal(withTotals.totals.collected_minor, 0);
  assert.ok(!JSON.stringify(withTotals.totals).includes(q.display_name), 'totals carry no names');

  // match fee for the selected squad only
  const org = await signup(['organizer']);
  const ev = (await call('POST', '/events', { token: org.token, body: { name: 'Cup', sport: 'cricket', starts_on: day(5), ends_on: day(6), entry_fee_cents: 0 } })).body;
  await pool.query('UPDATE teams SET event_id=$2 WHERE id=$1', [team.id, ev.id]);
  await pool.query("INSERT INTO team_squads(team_id, event_id, user_id, status) VALUES ($1,$2,$3,'selected'), ($1,$2,$4,'confirmed'), ($1,$2,$5,'dropped')", [team.id, ev.id, p.id, q.id, r.id]);
  const mf = await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'match_fee', title: 'Cup match fee', amount_minor: 20000, audience: 'selected_squad', event_id: ev.id, idempotency_key: key() } });
  assert.equal(mf.status, 201, JSON.stringify(mf.body)); assert.equal(mf.body.charges_raised, 2);
  assert.equal((await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'match_fee', title: 'x', amount_minor: 1, idempotency_key: key() } })).status, 400, 'a match fee names its match');
  const going = await call('POST', `/teams/${team.id}/attendance`, { token: r.token, body: { event_id: ev.id, rsvp: 'going' } });
  assert.equal(going.status, 200);
  const rs = await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'match_fee', title: 'Going fee', amount_minor: 5000, audience: 'rsvp_going', event_id: ev.id, idempotency_key: key() } });
  assert.equal(rs.body.charges_raised, 1, 'attendance policy: only those who said going');
});

test('recording payments, adjustments and the audit trail', async () => {
  const { owner, team, ps: [p, q] } = await setup(2);
  const made = (await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'dues', title: 'May dues', amount_minor: 100000, due_on: day(3), audience: 'members', member_ids: [p.id, q.id], idempotency_key: key() } })).body;
  const list = (await call('GET', `/teams/${team.id}/charges?batch_id=${made.batch_id}`, { token: owner.token })).body;
  const cp = list.find((c) => c.member_id === p.id), cq = list.find((c) => c.member_id === q.id);
  const rec = (token, c, amount, k = key(), method = 'upi') => call('POST', `/team-charges/${c.charge_id}/payments`, { token, body: { amount_minor: amount, method, note: 'UPI ref 4821', idempotency_key: k } });
  assert.equal((await rec(p.token, cp, 1000)).status, 403, 'members cannot mark themselves paid');
  const k = key();
  let r1 = await rec(owner.token, cp, 40000, k);
  assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.equal(r1.body.balance_minor, 60000); assert.equal(r1.body.status, 'awaiting_payment');
  assert.equal((await rec(owner.token, cp, 40000, k)).body.balance_minor, 60000, 'same key = same receipt');
  assert.equal((await rec(owner.token, cp, 60001)).status, 409, 'cannot take more than is owed');
  const r2 = await rec(owner.token, cp, 60000, key(), 'cash');
  assert.equal(r2.body.status, 'paid'); assert.equal(r2.body.balance_minor, 0);
  assert.equal((await rec(owner.token, cp, 1)).status, 409);

  // reduction and waiver keep the original amount and explain themselves
  const red = await call('POST', `/team-charges/${cq.charge_id}/adjustments`, { token: owner.token, body: { kind: 'reduction', amount_minor: 25000, reason: 'Student discount', idempotency_key: key() } });
  assert.equal(red.status, 200, JSON.stringify(red.body)); assert.equal(red.body.amount_minor, 100000); assert.equal(red.body.balance_minor, 75000);
  assert.equal((await call('POST', `/team-charges/${cq.charge_id}/adjustments`, { token: p.token, body: { kind: 'waiver', reason: 'because', idempotency_key: key() } })).status, 403);
  assert.equal((await call('POST', `/team-charges/${cq.charge_id}/adjustments`, { token: owner.token, body: { kind: 'reduction', amount_minor: 75001, reason: 'too much', idempotency_key: key() } })).status, 409);
  const wk = key();
  const waived = await call('POST', `/team-charges/${cq.charge_id}/adjustments`, { token: owner.token, body: { kind: 'waiver', reason: 'Injured all season', idempotency_key: wk } });
  assert.equal(waived.body.status, 'waived'); assert.equal(waived.body.balance_minor, 0);
  const replay = await call('POST', `/team-charges/${cq.charge_id}/adjustments`, { token: owner.token, body: { kind: 'waiver', reason: 'Injured all season', idempotency_key: wk } });
  assert.equal(replay.status, 200);

  const detail = (await call('GET', `/team-charges/${cq.charge_id}`, { token: owner.token })).body;
  assert.deepEqual(detail.entries.map((e) => [e.kind, e.amount_minor]), [['raised', 100000], ['reduction', 25000], ['waiver', 75000]]);
  assert.equal(detail.entries[1].note, 'Student discount');
  const asPayer = (await call('GET', `/team-charges/${cq.charge_id}`, { token: q.token })).body;
  assert.ok(asPayer.entries.every((e) => e.note === null), 'the payer sees amounts, not the manager\'s reasons');
  const raw = (await pool.query('SELECT reason_enc FROM team_charge_entries WHERE reason_enc IS NOT NULL')).rows;
  assert.ok(raw.length && raw.every((x) => !/Student|Injured|UPI ref/.test(x.reason_enc)), 'reasons and notes are encrypted at rest');
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='read_pii' AND entity='team_charge_entries'")).rows[0].n >= 1, 'reading reasons is audit-logged');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM team_charge_entries WHERE charge_id=$1", [cq.charge_id])).rows[0].n, 3, 'nothing was rewritten');

  // cancelling a mistaken charge only works while nothing is paid, and keeps the row
  const mis = (await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'dues', title: 'Oops', amount_minor: 100, audience: 'members', member_ids: [p.id], idempotency_key: key() } })).body;
  const oops = (await call('GET', `/teams/${team.id}/charges?batch_id=${mis.batch_id}`, { token: owner.token })).body[0];
  assert.equal((await call('POST', `/team-charges/${oops.charge_id}/cancel`, { token: owner.token, body: { reason: 'Raised by mistake' } })).body.status, 'cancelled');
  assert.equal((await call('POST', `/team-charges/${cp.charge_id}/cancel`, { token: owner.token, body: { reason: 'Already paid' } })).status, 409);
  assert.ok((await pool.query('SELECT 1 FROM team_charges WHERE id=$1', [oops.charge_id])).rowCount === 1);
});

test('split expense: exact shares, exclusions, the member who fronted the money, reconciliation', async () => {
  const { owner, team, ps: [p, q, r] } = await setup(3);
  const body = { title: 'Pitch hire', total_minor: 100000, split: 'equal', participants: [{ user_id: p.id }, { user_id: q.id }, { user_id: r.id }], paid_by: p.id, idempotency_key: key() };
  const e = await call('POST', `/teams/${team.id}/expenses`, { token: owner.token, body });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  const rows = (await pool.query('SELECT member_id, amount_minor, settled_minor, status FROM team_charges WHERE batch_id=$1 ORDER BY member_id', [e.body.batch_id])).rows;
  assert.equal(rows.reduce((t, x) => t + Number(x.amount_minor), 0), 100000, 'shares add up to the total to the paise');
  assert.deepEqual(rows.map((x) => Number(x.amount_minor)).sort(), [33333, 33333, 33334]);
  const front = rows.find((x) => x.member_id === p.id);
  assert.equal(front.status, 'paid', 'the person who fronted the money has paid their own share'); assert.equal(Number(front.settled_minor), Number(front.amount_minor));
  assert.equal(rows.filter((x) => x.status === 'awaiting_payment').length, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_charges WHERE member_id=$1 AND batch_id=$2', [owner.id, e.body.batch_id])).rows[0].n, 0, 'excluded members owe nothing');
  assert.equal((await call('POST', `/teams/${team.id}/expenses`, { token: owner.token, body })).body.batch_id, e.body.batch_id, 'retry is the same expense');

  const bad = await call('POST', `/teams/${team.id}/expenses`, { token: owner.token, body: { ...body, idempotency_key: key(), split: 'exact', participants: [{ user_id: p.id, amount_minor: 60000 }, { user_id: q.id, amount_minor: 30000 }] } });
  assert.equal(bad.status, 409);
  const exact = await call('POST', `/teams/${team.id}/expenses`, { token: owner.token, body: { ...body, idempotency_key: key(), title: 'Balls', total_minor: 90000, split: 'exact', paid_by: undefined, participants: [{ user_id: p.id, amount_minor: 60000 }, { user_id: q.id, amount_minor: 30000 }] } });
  assert.equal(exact.status, 201);
  const wt = await call('POST', `/teams/${team.id}/expenses`, { token: owner.token, body: { ...body, idempotency_key: key(), title: 'Tea', total_minor: 1001, split: 'weights', paid_by: undefined, participants: [{ user_id: p.id, weight: 1 }, { user_id: q.id, weight: 2 }] } });
  assert.equal((await pool.query('SELECT sum(amount_minor)::int AS s FROM team_charges WHERE batch_id=$1', [wt.body.batch_id])).rows[0].s, 1001);
  assert.equal((await call('POST', `/teams/${team.id}/expenses`, { token: owner.token, body: { ...body, idempotency_key: key(), participants: [{ user_id: (await signup()).id }] } })).status, 400, 'participants must be on the team');

  // q pays online, r pays in cash: the ledger reconciles both and shows what p is owed back
  const qc = (await pool.query('SELECT id, amount_minor FROM team_charges WHERE batch_id=$1 AND member_id=$2', [e.body.batch_id, q.id])).rows[0];
  const pay = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency) VALUES ($1,'stripe','team_charge',$2,$3,'INR') RETURNING id", [q.id, qc.id, qc.amount_minor])).rows[0];
  await settle(pay.id, { paid: true, amount: Number(qc.amount_minor), currency: 'INR', paymentRef: 'pi_test_1' });
  await settle(pay.id, { paid: true, amount: Number(qc.amount_minor), currency: 'INR', paymentRef: 'pi_test_1' });   // webhook replay
  assert.equal((await pool.query('SELECT status, settled_minor FROM team_charges WHERE id=$1', [qc.id])).rows[0].status, 'paid');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_charge_entries WHERE payment_id=$1', [pay.id])).rows[0].n, 1, 'a replayed webhook records one receipt');
  const rc = (await pool.query('SELECT id FROM team_charges WHERE batch_id=$1 AND member_id=$2', [e.body.batch_id, r.id])).rows[0];
  await call('POST', `/team-charges/${rc.id}/payments`, { token: owner.token, body: { amount_minor: 33333, method: 'cash', idempotency_key: key() } });
  const ledger = (await call('GET', `/teams/${team.id}/ledger`, { token: owner.token })).body;
  const owed = ledger.expenses_owed_back.find((x) => x.batch_id === e.body.batch_id);
  assert.equal(owed.paid_by, p.id); assert.equal(owed.collected_from_others_minor, 33333 + Number(qc.amount_minor));
  assert.equal(ledger.reconciliation.online_received_minor, Number(qc.amount_minor));
  assert.equal(ledger.reconciliation.offline_received_minor, 33333);
  assert.equal(ledger.reconciliation.ok, true, JSON.stringify(ledger.reconciliation));
  assert.equal((await pool.query("SELECT funds FROM (SELECT 'team_receivable' AS funds) x")).rows.length, 1);
});

test('an online payment that arrives after the charge changed is refunded, not applied', async () => {
  const { owner, team, ps: [p] } = await setup(1);
  const made = (await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'dues', title: 'Late', amount_minor: 5000, audience: 'members', member_ids: [p.id], idempotency_key: key() } })).body;
  const c = (await pool.query('SELECT id FROM team_charges WHERE batch_id=$1', [made.batch_id])).rows[0];
  const pay = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency) VALUES ($1,'stripe','team_charge',$2,5000,'INR') RETURNING id", [p.id, c.id])).rows[0];
  await call('POST', `/team-charges/${c.id}/adjustments`, { token: owner.token, body: { kind: 'waiver', reason: 'Forgiven meanwhile', idempotency_key: key() } });
  const { fulfilTeamChargePaid } = await import('../src/team-money.js');
  const ok = await (await import('../src/db.js')).tx((cl) => fulfilTeamChargePaid(cl, c.id, { id: pay.id, amount_cents: 5000 }));
  assert.equal(ok, false, 'nothing left to pay: the caller refunds the payment');
  assert.equal((await pool.query('SELECT settled_minor FROM team_charges WHERE id=$1', [c.id])).rows[0].settled_minor, 0);
});

test('recurring dues are raised once per period and reminders are sent once', async () => {
  const { owner, team, ps: [p] } = await setup(1);
  const plan = await call('POST', `/teams/${team.id}/dues-plans`, { token: owner.token, body: { title: 'Monthly dues', amount_minor: 50000, every_months: 1, starts_on: day(-1), due_days: 3 } });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM team_charges WHERE team_id=$1', [team.id])).rows[0].n;
  assert.equal(await count(), 1, 'the player is charged for the first period');
  await raiseTeamDues(); await raiseTeamDues();
  assert.equal(await count(), 1, 'running the worker again raises nothing');
  assert.ok(plan.body.next_on > day(-1), 'the plan moved on one period');
  assert.equal((await call('GET', `/teams/${team.id}/dues-plans`, { token: p.token })).status, 403);
  // a due-today charge is reminded exactly once
  await pool.query("UPDATE team_charges SET due_on=current_date WHERE team_id=$1", [team.id]);
  assert.equal(await remindTeamCharges(), 1);
  assert.equal(await remindTeamCharges(), 0, 'each reminder carries a dedupe key');
  assert.ok(JSON.stringify((await call('GET', '/notifications', { token: p.token })).body).includes('due today'));
  assert.equal((await call('PATCH', `/team-dues-plans/${plan.body.plan_id}`, { token: owner.token, body: { status: 'paused' } })).body.status, 'paused');
});

test('fundraising: approved purpose, gifts reconcile to payments, anonymous gifts, distinct from sponsorship', async () => {
  const { owner, team, ps: [p, q] } = await setup(2);
  const capn = q;
  await pool.query("UPDATE team_members SET role='captain' WHERE team_id=$1 AND user_id=$2", [team.id, capn.id]);
  const f = { title: 'New nets', purpose: 'Buy two practice nets for the ground', target_minor: 100000 };
  // a manager who is not the owner proposes; the owner approves the purpose
  const draft = await call('POST', `/teams/${team.id}/fundraisers`, { token: capn.token, body: f });
  assert.equal(draft.status, 201, JSON.stringify(draft.body)); assert.equal(draft.body.status, 'draft');
  assert.equal((await call('POST', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}/contributions`, { token: p.token, body: { amount_minor: 500, idempotency_key: key() } })).status, 409, 'no gifts before approval');
  assert.equal((await call('POST', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}/decision`, { token: capn.token, body: { action: 'approve' } })).status, 403);
  assert.equal((await call('POST', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}/decision`, { token: owner.token, body: { action: 'approve' } })).body.status, 'active');
  assert.ok(JSON.stringify((await call('GET', '/notifications', { token: owner.token })).body).includes('approve a fundraiser'));
  assert.deepEqual((await call('GET', `/teams/${team.id}/fundraisers`, { token: p.token })).body.map((x) => x.title), ['New nets']);

  const gk = key();
  const gift = await call('POST', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}/contributions`, { token: p.token, body: { amount_minor: 25000, anonymous: true, idempotency_key: gk } });
  assert.equal(gift.status, 201, JSON.stringify(gift.body)); assert.equal(gift.body.purpose.purpose_type, 'team_contribution');
  assert.equal((await call('POST', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}/contributions`, { token: p.token, body: { amount_minor: 25000, anonymous: true, idempotency_key: gk } })).body.contribution_id, gift.body.contribution_id);
  const view = async (tok) => (await call('GET', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}`, { token: tok })).body;
  assert.equal((await view(p.token)).raised_minor, 0, 'an unpaid pledge is not progress');
  const pay = (await pool.query("INSERT INTO payments(payer_id, provider, purpose_type, purpose_id, amount_cents, currency) VALUES ($1,'stripe','team_contribution',$2,25000,'INR') RETURNING id", [p.id, gift.body.contribution_id])).rows[0];
  await settle(pay.id, { paid: true, amount: 25000, currency: 'INR', paymentRef: 'pi_gift' });
  assert.equal((await view(p.token)).raised_minor, 25000);
  await call('POST', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}/recorded-contributions`, { token: owner.token, body: { contributor_id: q.id, amount_minor: 10000, method: 'upi', idempotency_key: key() } });
  const asOwner = await view(owner.token);
  assert.equal(asOwner.raised_minor, 35000); assert.equal(asOwner.percent, 35); assert.equal(asOwner.contributors, 2);
  const asP = await view(p.token);
  assert.equal(asP.contributions.length, 1, 'a member sees only their own gifts');
  assert.equal(asOwner.contributions.find((x) => x.anonymous).from, p.display_name, 'managers can reconcile an anonymous gift');
  assert.equal((await call('GET', `/teams/${team.id}/ledger`, { token: owner.token })).body.fundraisers[0].raised_minor, 35000);

  // an outsider cannot give; a young player gives through a guardian
  const outsider = await signup();
  assert.equal((await call('POST', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}/contributions`, { token: outsider.token, body: { amount_minor: 100, idempotency_key: key() } })).status, 403);
  const { kid } = await youngPlayer(team, owner);
  assert.equal((await call('POST', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}/contributions`, { token: kid.token, body: { amount_minor: 100, idempotency_key: key() } })).status, 403);

  // sponsorship stays separate unless linked on purpose, and only to an agreement with this team
  const sp = (await pool.query("INSERT INTO sponsors(owner_id, name) VALUES ($1,'Acme') RETURNING id", [(await signup(['sponsor'])).id])).rows[0];
  const s = (await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, proposed_by, status) VALUES ($1,'team',$2,100,$3,'active') RETURNING id", [sp.id, team.id, owner.id])).rows[0];
  const foreign = (await pool.query("INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, proposed_by, status) VALUES ($1,'team',$2,100,$3,'active') RETURNING id", [sp.id, (await setup(0)).team.id, owner.id])).rows[0];
  assert.equal((await call('POST', `/teams/${team.id}/fundraisers`, { token: owner.token, body: { ...f, sponsorship_id: foreign.id } })).status, 400);
  const linked = await call('POST', `/teams/${team.id}/fundraisers`, { token: owner.token, body: { ...f, title: 'Linked', sponsorship_id: s.id } });
  assert.equal(linked.status, 201); assert.equal(linked.body.status, 'active', 'owner-created opens at once'); assert.equal(linked.body.sponsorship_id, s.id);
  assert.equal(draft.body.sponsorship_id, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sponsorship_payments').catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n, 0, 'gifts never become sponsorship payments');

  // closing keeps paid gifts, cancelling withdraws unpaid pledges
  assert.equal((await call('POST', `/teams/${team.id}/fundraisers/${draft.body.fundraiser_id}/decision`, { token: owner.token, body: { action: 'close' } })).body.status, 'closed');
  assert.equal((await view(owner.token)).raised_minor, 35000);
});

test('notifications reuse the shared channels (#499): push / WhatsApp / email come from notify, no team-specific provider', async () => {
  const { whatsappKind } = await import('../src/whatsapp.js');
  for (const k of ['team_announcement', 'team_poll', 'team_charge_raised', 'team_charge_reminder', 'team_charge_paid', 'team_attendance_request']) assert.ok(whatsappKind(k), `${k} may use WhatsApp for people who opted in`);
  assert.ok(!whatsappKind('team_fundraiser_approval'), 'internal approvals stay off WhatsApp');
  const { owner, team, ps: [p] } = await setup(1);
  await pool.query("INSERT INTO notification_prefs(user_id, whatsapp, push, email, in_app) VALUES ($1,false,true,true,true) ON CONFLICT (user_id) DO UPDATE SET email=true", [p.id]);
  await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'dues', title: 'Channel check', amount_minor: 100, audience: 'members', member_ids: [p.id], idempotency_key: key() } });
  const n = (await pool.query("SELECT id FROM notifications WHERE user_id=$1 AND kind='team_charge_raised'", [p.id])).rows[0];
  assert.ok(n, 'the in-app notification exists');
  assert.ok((await pool.query("SELECT 1 FROM notification_deliveries WHERE notification_id=$1 AND channel='email'", [n.id])).rowCount, 'and the shared email outbox carries it');
});

test('payments: new purposes are accepted by the canonical checkout and land in a team receivable class', async () => {
  const { fundsClass } = await import('../src/settlement.js');
  assert.equal(fundsClass('team_charge'), 'team_receivable'); assert.equal(fundsClass('team_contribution'), 'team_receivable');
  const createPayment = capabilities.find((c) => c.name === 'create_payment');
  assert.ok(createPayment.input.parse({ purpose_type: 'team_charge', purpose_id: '00000000-0000-4000-8000-000000000000', provider: 'stripe' }));
  const { describePurpose } = await import('../src/payments/service.js');
  const { setup: _s } = { setup };
  const { owner, team, ps: [p] } = await _s(1);
  const made = (await call('POST', `/teams/${team.id}/charges`, { token: owner.token, body: { kind: 'dues', title: 'Pay me', amount_minor: 7000, audience: 'members', member_ids: [p.id], idempotency_key: key() } })).body;
  const ch = (await pool.query('SELECT id FROM team_charges WHERE batch_id=$1', [made.batch_id])).rows[0];
  const d = await describePurpose(pool, 'team_charge', ch.id);
  assert.equal(d.payerId, p.id); assert.equal(d.amount, 7000); assert.equal(d.currency, 'INR'); assert.equal(d.payable, true);
  assert.equal((await call('POST', '/payments', { token: owner.token, body: { purpose_type: 'team_charge', purpose_id: ch.id, provider: 'stripe' } })).status >= 400, true, 'someone else cannot pay it');
});

test('API first and MCP enabled: every new capability is in OpenAPI and carries a tag and summary', async () => {
  const names = ['send_team_message', 'list_team_messages', 'react_to_team_message', 'pin_team_message', 'create_team_poll', 'vote_team_poll', 'close_team_poll', 'post_team_rsvp_prompt',
    'create_team_charges', 'create_team_expense', 'list_my_team_charges', 'list_team_charges', 'get_team_charge', 'get_my_team_finance', 'get_team_ledger', 'adjust_team_charge', 'record_team_payment',
    'cancel_team_charge', 'create_team_dues_plan', 'list_team_dues_plans', 'update_team_dues_plan', 'create_team_fundraiser', 'decide_team_fundraiser', 'list_team_fundraisers', 'get_team_fundraiser',
    'contribute_to_team_fundraiser', 'record_team_contribution', 'set_team_finance_settings'];
  const spec = JSON.stringify(buildOpenApi());
  for (const nm of names) {
    const c = capabilities.find((x) => x.name === nm);
    assert.ok(c, `${nm} is registered once and shared by REST, OpenAPI and MCP`);
    assert.ok(c.tag && c.summary.length > 20, nm);
    assert.ok(spec.includes(`"operationId":"${nm}"`) || spec.includes(c.path.replace(/:(\w+)/g, '{$1}')), `${nm} in OpenAPI`);
  }
  const { classify } = await import('../src/scopes.js');
  for (const nm of ['record_team_payment', 'adjust_team_charge', 'create_team_charges', 'create_team_expense']) assert.equal(classify(capabilities.find((x) => x.name === nm)), 'payment', `${nm} needs the payment scope`);
});
