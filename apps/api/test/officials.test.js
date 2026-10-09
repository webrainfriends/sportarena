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
  const r = await api('POST', '/auth/register', { body: { handle: `off_${n}_${roles[0]}`, display_name: `Off ${n}`, email: `off${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (days, hour, min = 0) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, min, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup(sport = 'basketball') {
  const org = await signup(['organizer']);
  const caps = await Promise.all([signup(['athlete']), signup(['athlete']), signup(['athlete']), signup(['athlete'])]);
  const teams = [];
  for (const [i, c] of caps.entries()) teams.push((await api('POST', '/teams', { token: c.token, body: { name: `T${n}-${i}`, sport } })).body);
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Cup ${n}`, sport } })).body;
  for (const [i, c] of caps.entries()) {
    const e = await api('POST', `/events/${ev.id}/entries`, { token: c.token, body: { team_id: teams[i].id } });
    await api('PATCH', `/entries/${e.body.id}`, { token: org.token, body: { status: 'accepted' } });
  }
  const fx = (scheduled_at, pair = 0, extra = {}) => api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: teams[pair * 2].id, away_team_id: teams[pair * 2 + 1].id, scheduled_at, ...extra } });
  return { org, ev, teams, fx };
}
const referee = async (sport = 'basketball') => {
  const r = await signup(['referee']);
  assert.equal((await api('POST', '/me/sport-profiles', { token: r.token, body: { sport, role: 'referee' } })).status, 201);
  return r;
};
const mine = async (u) => (await api('GET', '/me/official-assignments', { token: u.token })).body;
const respond = (u, id, response, reason) => api('POST', `/official-assignments/${id}/respond`, { token: u.token, body: { response, reason } });

test('request -> accept/decline -> release keeps history; only accepted officials are crew', async () => {
  const { org, fx } = await setup();
  const ref = await referee(), umpire = await referee(), stranger = await signup(['athlete']);
  const f = (await fx(at(10, 9), 0, { referee_id: ref.id })).body;
  assert.equal(f.referee_id, null, 'not confirmed until accepted');
  const req = await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: umpire.id, role: 'umpire' } });
  assert.equal(req.status, 201);
  assert.equal((await api('POST', `/fixtures/${f.id}/officials`, { token: stranger.token, body: { user_id: umpire.id, role: 'linesman' } })).status, 403);
  const [refA] = await mine(ref), [umpA] = await mine(umpire);
  assert.equal(refA.status, 'invited');
  assert.equal((await respond(umpire, refA.id, 'accept')).status, 403, "someone else's invitation");
  assert.equal((await api('GET', `/fixtures/${f.id}/officials`, { token: stranger.token })).body.length, 0, 'no confirmed crew yet');
  assert.equal((await respond(ref, refA.id, 'accept')).status, 200);
  assert.equal((await respond(umpire, umpA.id, 'decline', 'busy')).body.status, 'declined');
  const crew = (await api('GET', `/fixtures/${f.id}/officials`, { token: stranger.token })).body;
  assert.deepEqual(crew.map((c) => [c.role, c.status]), [['referee', 'accepted']]);
  assert.equal((await pool.query('SELECT referee_id FROM fixtures WHERE id=$1', [f.id])).rows[0].referee_id, ref.id);
  assert.equal((await api('POST', `/official-assignments/${refA.id}/release`, { token: ref.token, body: { reason: 'nope nope' } })).status, 403);
  assert.equal((await api('POST', `/official-assignments/${refA.id}/release`, { token: org.token, body: { reason: 'Reassigning' } })).body.status, 'released');
  assert.equal((await pool.query('SELECT referee_id FROM fixtures WHERE id=$1', [f.id])).rows[0].referee_id, null);
  const hist = (await api('GET', `/fixtures/${f.id}/officials`, { token: org.token })).body.find((o) => o.id === refA.id).history;
  assert.deepEqual(hist.map((h) => h.to), ['invited', 'accepted', 'released']);
  assert.equal((await respond(ref, refA.id, 'accept')).status, 409, 'closed assignments cannot be revived');
  assert.ok((await pool.query("SELECT 1 FROM notifications WHERE user_id=$1 AND kind='official_assignment'", [ref.id])).rowCount >= 2);
});

test('withdraw needs a reason, and an ineligible sport is rejected on invite, create AND reschedule', async () => {
  const { org, fx } = await setup();
  const hoop = await referee('basketball'), tennis = await referee('tennis');
  assert.equal((await fx(at(11, 9), 0, { referee_id: tennis.id })).status, 400, 'create: wrong sport');
  const f = (await fx(at(11, 9), 0, { referee_id: hoop.id })).body;
  assert.equal((await api('PATCH', `/fixtures/${f.id}`, { token: org.token, body: { referee_id: tennis.id } })).status, 400, 'reschedule: wrong sport (parity)');
  const [a] = await mine(hoop);
  await respond(hoop, a.id, 'accept');
  assert.equal((await api('POST', `/official-assignments/${a.id}/withdraw`, { token: hoop.token, body: { reason: '' } })).status, 400);
  assert.equal((await api('POST', `/official-assignments/${a.id}/withdraw`, { token: hoop.token, body: { reason: 'Injured ankle' } })).body.status, 'withdrawn');
});

test('clash checks use the fixture duration (not 90 min) and reschedule enforces them', async () => {
  const { org, fx } = await setup();
  const ref = await referee();
  const long = (await fx(at(12, 9), 0, { duration_min: 180, referee_id: ref.id })).body;
  const [a] = await mine(ref);
  assert.equal((await respond(ref, a.id, 'accept')).status, 200);
  // starts 100 min in: the old hard-coded 90 would allow it, the real 180 does not
  const second = (await fx(at(12, 10, 40), 1, {})).body;
  assert.equal((await api('POST', `/fixtures/${second.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).status, 409);
  // free slot invites fine; moving it onto the confirmed game is refused on reschedule
  const third = (await fx(at(12, 14), 1, {})).body;
  assert.equal((await api('POST', `/fixtures/${third.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).status, 201);
  const [, b] = (await mine(ref)).sort((x, y) => x.scheduled_at.localeCompare(y.scheduled_at));
  assert.equal((await respond(ref, b.id, 'accept')).status, 200);
  assert.equal((await api('PATCH', `/fixtures/${third.id}`, { token: org.token, body: { scheduled_at: at(12, 10, 40) } })).status, 409);
  // lengthening a confirmed game into the next one is also refused
  assert.equal((await api('PATCH', `/fixtures/${long.id}`, { token: org.token, body: { duration_min: 600 } })).status, 409);
  // a legit move requires the official to acknowledge
  assert.equal((await api('PATCH', `/fixtures/${third.id}`, { token: org.token, body: { scheduled_at: at(12, 16) } })).status, 200);
  const after = (await mine(ref)).find((x) => x.id === b.id);
  assert.equal(after.needs_ack, true);
  await respond(ref, b.id, 'accept');
  assert.equal((await mine(ref)).find((x) => x.id === b.id).needs_ack, false);
});

test('concurrent acceptances cannot double-book an official', async () => {
  const { org, fx } = await setup();
  const ref = await referee();
  const f1 = (await fx(at(13, 9), 0, {})).body, f2 = (await fx(at(13, 9, 30), 1, {})).body;
  for (const f of [f1, f2]) assert.equal((await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).status, 201);
  const rows = await mine(ref);
  const res = await Promise.all(rows.map((r) => respond(ref, r.id, 'accept')));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
});

test('crew: several roles accept independently; cancelling the fixture closes them with history', async () => {
  const { org, fx } = await setup();
  const [r1, r2, r3] = [await referee(), await referee(), await signup(['athlete'])];
  const f = (await fx(at(14, 9), 0, {})).body;
  for (const [u, role] of [[r1, 'referee'], [r2, 'linesman'], [r3, 'scorer']]) assert.equal((await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: u.id, role } })).status, 201);
  assert.equal((await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: r1.id, role: 'referee' } })).status, 409, 'duplicate');
  await respond(r2, (await mine(r2))[0].id, 'accept');
  await respond(r3, (await mine(r3))[0].id, 'accept');
  const crew = (await api('GET', `/fixtures/${f.id}/officials`, { token: r3.token })).body;
  assert.deepEqual(crew.map((c) => c.role).sort(), ['linesman', 'scorer'], 'the un-responded referee invite is not crew');
  assert.equal(crew.find((c) => c.role === 'scorer').reason, null, 'no private notes for crew');
  assert.equal((await api('PATCH', `/fixtures/${f.id}`, { token: org.token, body: { status: 'cancelled' } })).status, 200);
  for (const u of [r1, r2, r3]) assert.equal((await mine(u))[0].status, 'cancelled');
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM fixture_official_history WHERE to_status='cancelled'");
  assert.equal(rows[0].n, 3);
});
