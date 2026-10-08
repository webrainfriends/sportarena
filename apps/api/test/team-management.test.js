import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async (roles) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `tm_${n}_${roles[0]}`, display_name: `Tm ${n}`, email: `tm${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const setup = async () => {
  const owner = await signup(['athlete']);
  const org = await signup(['organizer']);
  const team = (await api('POST', '/teams', { token: owner.token, body: { name: 'SuperBats', sport: 'cricket', currency: 'inr' } })).body;
  const rival = (await api('POST', '/teams', { token: org.token, body: { name: 'Rivals', sport: 'cricket' } })).body;
  const ev = (await api('POST', '/events', { token: org.token, body: { name: 'Summer Cup', sport: 'cricket', starts_on: day(5), ends_on: day(6), entry_fee_cents: 0 } })).body;
  for (const [t, tok] of [[team, owner.token], [rival, org.token]]) {
    const en = (await api('POST', `/events/${ev.id}/entries`, { token: tok, body: { team_id: t.id } })).body;
    assert.equal((await api('PATCH', `/entries/${en.id}`, { token: org.token, body: { status: 'accepted' } })).status, 200);
  }
  const fx = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: team.id, away_team_id: rival.id, scheduled_at: new Date(Date.now() + 3 * 864e5).toISOString() } })).body;
  return { owner, org, team, rival, ev, fx };
};

test('roster: owner edits members, availability is shared, rates stay private', async () => {
  const { owner, team } = await setup();
  const p1 = await signup(['athlete']), p2 = await signup(['athlete']), stranger = await signup(['athlete']);
  for (const p of [p1, p2]) assert.equal((await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: p.id } })).status, 201);

  // modify: role / jersey / position / rate (owner), nobody else
  const up = await api('PATCH', `/teams/${team.id}/members/${p1.id}`, { token: owner.token, body: { jersey_no: 7, position: 'Opener', rate_cents: 50000, notes: 'left-hander' } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await api('PATCH', `/teams/${team.id}/members/${p1.id}`, { token: p2.token, body: { jersey_no: 9 } })).status, 403);
  assert.equal((await api('PATCH', `/teams/${team.id}/members/${p1.id}`, { token: owner.token, body: {} })).status, 400);
  assert.equal((await api('PATCH', `/teams/${team.id}/members/${owner.id}`, { token: owner.token, body: { role: 'player' } })).status, 409, 'owner stays manager');

  // availability: self or manager, not another player
  assert.equal((await api('PATCH', `/teams/${team.id}/members/${p1.id}/availability`, { token: p1.token, body: { availability: 'tentative', note: 'exam' } })).status, 200);
  assert.equal((await api('PATCH', `/teams/${team.id}/members/${p1.id}/availability`, { token: p2.token, body: { availability: 'injured' } })).status, 403);
  assert.equal((await api('PATCH', `/teams/${team.id}/members/${p2.id}/availability`, { token: owner.token, body: { availability: 'injured', note: 'hamstring' } })).status, 200);

  const r = (await api('GET', `/teams/${team.id}/roster`, { token: owner.token })).body;
  assert.equal(r.can_manage, true);
  const m1 = r.members.find((m) => m.id === p1.id);
  assert.deepEqual([m1.jersey_no, m1.position, m1.availability, m1.rate_cents, m1.notes], [7, 'Opener', 'tentative', 50000, 'left-hander']);
  // a player sees availability but not other people's rates or notes
  const pr = (await api('GET', `/teams/${team.id}/roster`, { token: p2.token })).body;
  assert.equal(pr.can_manage, false);
  const seen = pr.members.find((m) => m.id === p1.id);
  assert.equal(seen.availability, 'tentative'); assert.equal(seen.rate_cents, undefined); assert.equal(seen.notes, undefined);
  assert.equal((await api('GET', `/teams/${team.id}/roster`, { token: stranger.token })).status, 403);

  // public team page tells the viewer what they can do
  assert.equal((await api('GET', `/teams/${team.id}`, { token: owner.token })).body.can_manage, true);
  assert.equal((await api('GET', `/teams/${team.id}`, { token: p1.token })).body.can_manage, false);
  assert.equal((await api('GET', `/teams/${team.id}`)).body.can_manage, false);

  // remove = soft delete; the row is kept
  assert.equal((await api('DELETE', `/teams/${team.id}/members/${p2.id}`, { token: owner.token })).status, 200);
  assert.equal((await pool.query('SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2', [team.id, p2.id])).rows[0].status, 'left');
});

test('invitations: owner invites a player and a coach from the community; they accept or decline', async () => {
  const { owner, team } = await setup();
  const player = await signup(['athlete']), coach = await signup(['coach']), other = await signup(['athlete']);
  assert.equal((await api('POST', `/teams/${team.id}/invitations`, { token: other.token, body: { user_id: player.id } })).status, 403);
  const inv = await api('POST', `/teams/${team.id}/invitations`, { token: owner.token, body: { user_id: coach.id, role: 'coach', rate_cents: 120000, rate_unit: 'month' } });
  assert.equal(inv.status, 201); assert.equal(inv.body.status, 'invited');
  await api('POST', `/teams/${team.id}/invitations`, { token: owner.token, body: { user_id: player.id } });
  assert.equal((await api('GET', '/me/team-invites', { token: coach.token })).body[0].rate_cents, 120000);
  // invited people are not on the roster until they accept
  assert.equal((await api('GET', `/teams/${team.id}`)).body.members.length, 1);
  assert.equal((await api('POST', `/teams/${team.id}/invitations/respond`, { token: coach.token, body: { accept: true } })).body.status, 'active');
  assert.equal((await api('POST', `/teams/${team.id}/invitations/respond`, { token: player.token, body: { accept: false } })).body.status, 'left');
  assert.equal((await api('POST', `/teams/${team.id}/invitations/respond`, { token: other.token, body: { accept: true } })).status, 404);
  assert.equal((await api('POST', `/teams/${team.id}/invitations`, { token: owner.token, body: { user_id: coach.id } })).status, 409, 'already on the team');
  const roster = (await api('GET', `/teams/${team.id}`)).body.members;
  assert.ok(roster.some((m) => m.id === coach.id && m.team_role === 'coach'));
  const inbox = (await api('GET', '/notifications', { token: owner.token })).body;
  assert.ok(JSON.stringify(inbox).includes('accepted your invitation'));
});

test('squads: pick players and roles for an event or a match; players confirm or decline', async () => {
  const { owner, team, ev, fx, rival } = await setup();
  const [a, b, c] = [await signup(['athlete']), await signup(['athlete']), await signup(['athlete'])];
  for (const p of [a, b, c]) await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: p.id } });
  await api('PATCH', `/teams/${team.id}/members/${c.id}/availability`, { token: c.token, body: { availability: 'injured' } });
  const stranger = await signup(['athlete']);

  const set = (body, token = owner.token) => api('POST', `/teams/${team.id}/squad`, { token, body });
  assert.equal((await set({ event_id: ev.id, members: [{ user_id: a.id }] }, a.token)).status, 403, 'players cannot pick');
  assert.equal((await set({ members: [] })).status, 400, 'needs a scope');
  assert.equal((await set({ event_id: ev.id, fixture_id: fx.id, members: [] })).status, 400);
  assert.equal((await set({ event_id: ev.id, members: [{ user_id: stranger.id }] })).status, 400, 'only roster members');
  assert.equal((await set({ event_id: ev.id, members: [{ user_id: a.id }, { user_id: c.id }] })).status, 409, 'injured player refused');
  assert.equal((await api('POST', `/teams/${rival.id}/squad`, { token: owner.token, body: { event_id: ev.id, members: [] } })).status, 403);

  const sq = await set({ event_id: ev.id, members: [{ user_id: a.id, role: 'captain', position: 'Batter' }, { user_id: b.id, role: 'substitute' }, { user_id: c.id }], allow_unavailable: true });
  assert.equal(sq.status, 200, JSON.stringify(sq.body));
  assert.equal(sq.body.length, 3);
  assert.equal(sq.body.find((x) => x.id === a.id).role, 'captain');

  // players see their selections and respond
  const mine = (await api('GET', '/me/selections', { token: a.token })).body;
  assert.equal(mine.length, 1); assert.equal(mine[0].status, 'selected'); assert.equal(mine[0].event_name, 'Summer Cup');
  assert.equal((await api('PATCH', `/squads/${mine[0].squad_id}`, { token: b.token, body: { status: 'confirmed' } })).status, 403, 'not their selection');
  assert.equal((await api('PATCH', `/squads/${mine[0].squad_id}`, { token: a.token, body: { status: 'confirmed' } })).body.status, 'confirmed');
  const bSel = (await api('GET', '/me/selections', { token: b.token })).body[0];
  await api('PATCH', `/squads/${bSel.squad_id}`, { token: b.token, body: { status: 'declined' } });

  // re-submitting keeps a's confirmation, drops c, and re-opens b's declined slot
  const again = await set({ event_id: ev.id, members: [{ user_id: a.id, role: 'captain' }, { user_id: b.id }] });
  const byId = Object.fromEntries(again.body.map((x) => [x.id, x.status]));
  assert.deepEqual(byId, { [a.id]: 'confirmed', [b.id]: 'selected' });
  assert.equal((await pool.query("SELECT status FROM team_squads WHERE user_id=$1 AND team_id=$2", [c.id, team.id])).rows[0].status, 'dropped', 'dropped rows are kept');
  assert.equal((await api('GET', '/me/selections', { token: c.token })).body.length, 0);

  // a single match squad is separate from the event squad
  const m = await set({ fixture_id: fx.id, members: [{ user_id: a.id, role: 'player' }] });
  assert.equal(m.status, 200);
  assert.equal(m.body[0].fixture_id, fx.id); assert.equal(m.body[0].event_id, ev.id);
  assert.equal((await api('GET', `/teams/${team.id}/squad?fixture_id=${fx.id}`, { token: a.token })).body.length, 1);
  assert.equal((await api('GET', `/teams/${team.id}/squad?event_id=${ev.id}`, { token: a.token })).body.length, 2);
  assert.equal((await api('GET', `/teams/${team.id}/squad?event_id=${ev.id}`, { token: stranger.token })).status, 403);

  // schedule with squad counts
  const sch = (await api('GET', `/teams/${team.id}/schedule`, { token: owner.token })).body;
  assert.equal(sch.fixtures.length, 1); assert.equal(sch.fixtures[0].squad.selected, 1);
  assert.equal(sch.events[0].name, 'Summer Cup'); assert.equal(sch.events[0].squad.selected, 2); assert.equal(sch.events[0].squad.confirmed, 1);
});

test('recruiting: a coach-wanted post fills the team with a coach at the advertised rate', async () => {
  const { owner, team } = await setup();
  const coach = await signup(['coach']);
  assert.equal((await api('POST', '/billboard', { token: owner.token, body: { kind: 'coach_wanted', title: 'Coach needed' } })).status, 400, 'needs a team');
  const post = await api('POST', '/billboard', { token: owner.token, body: { kind: 'coach_wanted', title: 'Head coach for SuperBats', team_id: team.id, sport: 'cricket', budget_cents: 200000, rate_unit: 'month' } });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  const listed = (await api('GET', '/billboard?kind=coach_wanted')).body;
  assert.equal(listed[0].rate_unit, 'month');
  const resp = (await api('POST', `/billboard/${post.body.id}/responses`, { token: coach.token, body: { message: 'I can help' } })).body;
  assert.equal((await api('PATCH', `/billboard/responses/${resp.id}`, { token: owner.token, body: { status: 'accepted' } })).status, 200);
  const roster = (await api('GET', `/teams/${team.id}/roster`, { token: owner.token })).body.members.find((m) => m.id === coach.id);
  assert.deepEqual([roster.team_role, roster.rate_cents, roster.rate_unit], ['coach', 200000, 'month']);
});

test('settlement: fees from the squad, manual payouts, mark paid, per-person totals', async () => {
  const { owner, team, ev } = await setup();
  const p = await signup(['athlete']), coach = await signup(['coach']), norate = await signup(['athlete']), nobody = await signup(['athlete']);
  for (const u of [p, norate]) await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: u.id } });
  await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: coach.id, role: 'coach' } });
  await api('PATCH', `/teams/${team.id}/members/${p.id}`, { token: owner.token, body: { rate_cents: 30000, rate_unit: 'match' } });
  await api('PATCH', `/teams/${team.id}/members/${coach.id}`, { token: owner.token, body: { rate_cents: 100000, rate_unit: 'match' } });
  assert.equal((await api('PATCH', `/teams/${team.id}/members/${p.id}`, { token: p.token, body: { rate_cents: 99999999 } })).status, 403, 'players cannot set their own rate');
  await api('POST', `/teams/${team.id}/squad`, { token: owner.token, body: { event_id: ev.id, members: [{ user_id: p.id }, { user_id: coach.id, role: 'coach' }, { user_id: norate.id }] } });

  const gen = await api('POST', `/teams/${team.id}/payouts/from-squad`, { token: owner.token, body: { event_id: ev.id } });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.created.length, 2); assert.equal(gen.body.skipped.length, 1);
  const again = (await api('POST', `/teams/${team.id}/payouts/from-squad`, { token: owner.token, body: { event_id: ev.id } })).body;
  assert.equal(again.created.length, 0, 're-running creates no duplicates');
  assert.equal((await api('POST', `/teams/${team.id}/payouts/from-squad`, { token: p.token, body: { event_id: ev.id } })).status, 403);

  const manual = await api('POST', `/teams/${team.id}/payouts`, { token: owner.token, body: { user_id: p.id, kind: 'bonus', amount_cents: 5000, note: 'player of the match' } });
  assert.equal(manual.status, 201); assert.equal(manual.body.currency, 'INR');
  assert.equal((await api('POST', `/teams/${team.id}/payouts`, { token: owner.token, body: { user_id: nobody.id, amount_cents: 1 } })).status, 400);

  // ledger visibility: manager sees all, a player only their own
  assert.equal((await api('GET', `/teams/${team.id}/payouts`, { token: owner.token })).body.length, 3);
  const own = (await api('GET', `/teams/${team.id}/payouts`, { token: p.token })).body;
  assert.equal(own.length, 2); assert.ok(own.every((x) => x.user_id === p.id));
  assert.equal((await api('GET', `/teams/${team.id}/settlement`, { token: p.token })).status, 403);

  const first = own.find((x) => x.kind === 'match_fee');
  const paid = await api('PATCH', `/team-payouts/${first.id}`, { token: owner.token, body: { status: 'paid' } });
  assert.equal(paid.body.status, 'paid'); assert.ok(paid.body.paid_at);
  assert.equal((await api('PATCH', `/team-payouts/${first.id}`, { token: owner.token, body: { amount_cents: 1 } })).status, 409, 'paid is final');
  await api('PATCH', `/team-payouts/${manual.body.id}`, { token: owner.token, body: { amount_cents: 6000 } });

  const s = (await api('GET', `/teams/${team.id}/settlement`, { token: owner.token })).body;
  assert.equal(s.currency, 'INR');
  assert.deepEqual([s.total_paid_cents, s.total_due_cents], [30000, 106000]);
  const sp = s.people.find((x) => x.id === p.id);
  assert.deepEqual([sp.paid_cents, sp.due_cents], [30000, 6000]);

  // cancel keeps the row
  const canc = await api('PATCH', `/team-payouts/${manual.body.id}`, { token: owner.token, body: { status: 'cancelled' } });
  assert.equal(canc.body.status, 'cancelled');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_payouts WHERE team_id=$1', [team.id])).rows[0].n, 3);
});

test('team chat: members talk, managers announce, outsiders are kept out, deletes are soft', async () => {
  const { owner, team } = await setup();
  const p = await signup(['athlete']), q = await signup(['athlete']), outsider = await signup(['athlete']);
  for (const u of [p, q]) await api('POST', `/teams/${team.id}/members`, { token: owner.token, body: { user_id: u.id } });
  const post = (tok, body) => api('POST', `/teams/${team.id}/messages`, { token: tok, body });

  assert.equal((await post(outsider.token, { body: 'hi' })).status, 403);
  assert.equal((await api('GET', `/teams/${team.id}/messages`, { token: outsider.token })).status, 403);
  assert.equal((await post(p.token, { body: '   ' })).status, 400);
  const m1 = await post(p.token, { body: 'Nets at 6?' });
  assert.equal(m1.status, 201); assert.equal(m1.body.mine, true); assert.equal(m1.body.handle, p.handle);
  await post(q.token, { body: 'Count me in' });
  assert.equal((await post(p.token, { body: 'Team meeting', announcement: true })).status, 403, 'players cannot announce');
  assert.equal((await post(owner.token, { body: 'Kit collection Saturday', announcement: true })).status, 201);
  assert.ok(JSON.stringify((await api('GET', '/notifications', { token: q.token })).body).includes('Kit collection'));

  const feed = (await api('GET', `/teams/${team.id}/messages`, { token: q.token })).body;
  assert.deepEqual(feed.map((m) => m.body), ['Kit collection Saturday', 'Count me in', 'Nets at 6?'], 'newest first');
  assert.equal(feed[1].mine, true);
  const newer = (await api('GET', `/teams/${team.id}/messages?after=${encodeURIComponent(feed[2].created_at)}`, { token: q.token })).body;
  assert.equal(newer.length, 2);

  // unread counts per team
  const chats = (await api('GET', '/me/team-chats', { token: p.token })).body;
  assert.equal(chats[0].team_id, team.id); assert.equal(chats[0].unread, 2); assert.equal(chats[0].last_message.body, 'Kit collection Saturday');
  await api('POST', `/teams/${team.id}/messages/read`, { token: p.token });
  assert.equal((await api('GET', '/me/team-chats', { token: p.token })).body[0].unread, 0);

  // delete: own message, or any as manager; never someone else's as a player; row is kept
  assert.equal((await api('DELETE', `/teams/${team.id}/messages/${m1.body.message_id}`, { token: q.token })).status, 403);
  assert.equal((await api('DELETE', `/teams/${team.id}/messages/${m1.body.message_id}`, { token: owner.token })).status, 200);
  assert.equal((await api('GET', `/teams/${team.id}/messages`, { token: p.token })).body.length, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_messages WHERE team_id=$1', [team.id])).rows[0].n, 3);

  // someone who left loses access
  await api('DELETE', `/teams/${team.id}/members/${q.id}`, { token: owner.token });
  assert.equal((await api('GET', `/teams/${team.id}/messages`, { token: q.token })).status, 403);
});
