// REF-R01 / #992 — Officials Assignment Lifecycle tests
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
  const r = await api('POST', '/auth/register', { body: { handle: `ol_${n}_${roles[0]}`, display_name: `OL ${n}`, email: `ol${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const at = (days, hour = 10) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

async function setup(sport = 'basketball') {
  const org = await signup(['organizer']);
  const a1 = await signup(['athlete']), a2 = await signup(['athlete']), a3 = await signup(['athlete']), a4 = await signup(['athlete']);
  const t1 = (await api('POST', '/teams', { token: a1.token, body: { name: `T${n}A`, sport } })).body;
  const t2 = (await api('POST', '/teams', { token: a3.token, body: { name: `T${n}B`, sport } })).body;
  const ev = (await api('POST', '/events', { token: org.token, body: { name: `Ev${n}`, sport } })).body;
  for (const [user, team] of [[a1, t1],[a2, t1],[a3, t2],[a4, t2]]) {
    const e = await api('POST', `/events/${ev.id}/entries`, { token: user.token, body: { team_id: team.id } });
    await api('PATCH', `/entries/${e.body.id}`, { token: org.token, body: { status: 'accepted' } });
  }
  const f = (await api('POST', `/events/${ev.id}/fixtures`, { token: org.token, body: { home_team_id: t1.id, away_team_id: t2.id, scheduled_at: at(14) } })).body;
  return { org, ev, f };
}

const mkRef = async (sport = 'basketball') => {
  const r = await signup(['referee']);
  await api('POST', '/me/sport-profiles', { token: r.token, body: { sport, role: 'referee' } });
  return r;
};

test('propose_fixture_official: official can self-propose, organiser sees it in inbox', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  const r = await api('POST', `/fixtures/${f.id}/officials/propose`, { token: ref.token, body: { role: 'referee' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'proposed');

  const inbox = await api('GET', '/me/organiser/officials/inbox', { token: org.token });
  assert.equal(inbox.status, 200);
  const proposal = inbox.body.proposals?.find((p) => p.id === r.body.id);
  assert.ok(proposal, 'proposal should appear in organiser inbox');
});

test('confirm_official_proposal: organiser accepts proposal → accepted', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  const prop = (await api('POST', `/fixtures/${f.id}/officials/propose`, { token: ref.token, body: { role: 'umpire' } })).body;
  assert.equal(prop.status, 'proposed');

  const accept = await api('POST', `/official-assignments/${prop.id}/confirm-proposal`, { token: org.token, body: {} });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  assert.equal(accept.body.status, 'accepted');
});

test('decline_official_proposal: organiser declines proposal → declined', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  const prop = (await api('POST', `/fixtures/${f.id}/officials/propose`, { token: ref.token, body: { role: 'scorer' } })).body;

  const decline = await api('POST', `/official-assignments/${prop.id}/decline-proposal`, { token: org.token, body: { reason: 'Level mismatch' } });
  assert.equal(decline.status, 200, JSON.stringify(decline.body));
  assert.equal(decline.body.status, 'declined');
});

test('confirm_fixture_crew: all accepted → confirmed; sets confirmed_at', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  // invite via standard flow then accept
  const inv = (await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).body;
  await api('POST', `/official-assignments/${inv.id}/respond`, { token: ref.token, body: { response: 'accept' } });

  const confirm = await api('POST', `/fixtures/${f.id}/officials/confirm-crew`, { token: org.token, body: {} });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.ok(confirm.body.confirmed_count >= 1, 'at least one slot confirmed');

  const detail = (await api('GET', `/official-assignments/${inv.id}`, { token: ref.token })).body;
  assert.equal(detail.status, 'confirmed');
  assert.ok(detail.confirmed_at, 'confirmed_at set');
});

test('set_invitation_deadline: organiser can set a deadline on an invited assignment', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  const inv = (await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).body;

  const dl = at(2, 12); // 2 days from now
  const r = await api('POST', `/official-assignments/${inv.id}/deadline`, { token: org.token, body: { deadline: dl } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.invitation_deadline, 'deadline set');
});

test('expire_official_assignments: admin sweep expires overdue invited assignments', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  const inv = (await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).body;

  // Set deadline in the past
  await pool.query("UPDATE fixture_officials SET invitation_deadline=now()-interval'1 hour' WHERE id=$1", [inv.id]);

  const admin = await signup(['admin']);
  const r = await api('POST', '/official-assignments/expire', { token: admin.token, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.expired >= 1, 'at least 1 expired');

  const detail = (await api('GET', `/official-assignments/${inv.id}`, { token: ref.token })).body;
  assert.equal(detail.status, 'expired');
});

test('acknowledge_schedule_change: official acks, needs_ack cleared', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  const inv = (await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).body;
  await api('POST', `/official-assignments/${inv.id}/respond`, { token: ref.token, body: { response: 'accept' } });

  // Simulate a schedule change requiring ack
  await pool.query("UPDATE fixture_officials SET needs_ack=true, ack_required_reason='Venue changed' WHERE id=$1", [inv.id]);

  const r = await api('POST', `/official-assignments/${inv.id}/acknowledge`, { token: ref.token, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.needs_ack, false);
  assert.ok(r.body.ack_at, 'ack_at timestamp set');
});

test('replace_fixture_official: organiser can replace an accepted official', async () => {
  const { org, f } = await setup();
  const ref = await mkRef(), ref2 = await mkRef();
  const inv = (await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).body;
  await api('POST', `/official-assignments/${inv.id}/respond`, { token: ref.token, body: { response: 'accept' } });

  const r = await api('POST', `/official-assignments/${inv.id}/replace`, { token: org.token, body: { reason: 'Injury', replacement_user_id: ref2.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replaced.status, 'replaced');
  if (r.body.replacement) assert.equal(r.body.replacement.status, 'invited');
});

test('get_official_assignment_detail: official can see own assignment, stranger cannot', async () => {
  const { org, f } = await setup();
  const ref = await mkRef(), stranger = await signup(['athlete']);
  const inv = (await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).body;

  const mine = await api('GET', `/official-assignments/${inv.id}`, { token: ref.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.id, inv.id);

  const other = await api('GET', `/official-assignments/${inv.id}`, { token: stranger.token });
  assert.ok([403, 404].includes(other.status), 'stranger gets 403 or 404');
});

test('get_organiser_officials_inbox: organiser sees proposals and metrics', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  await api('POST', `/fixtures/${f.id}/officials/propose`, { token: ref.token, body: { role: 'umpire' } });

  const r = await api('GET', '/me/organiser/officials/inbox', { token: org.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.proposals));
  assert.ok(r.body.metrics != null);
});

test('state machine: cannot propose if already has open assignment on same fixture+role', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  const r1 = await api('POST', `/fixtures/${f.id}/officials/propose`, { token: ref.token, body: { role: 'referee' } });
  assert.equal(r1.status, 201);

  const r2 = await api('POST', `/fixtures/${f.id}/officials/propose`, { token: ref.token, body: { role: 'referee' } });
  assert.equal(r2.status, 409, 'duplicate open proposal should be rejected');
});

test('state machine: cannot confirm-proposal on non-proposed assignment', async () => {
  const { org, f } = await setup();
  const ref = await mkRef();
  const inv = (await api('POST', `/fixtures/${f.id}/officials`, { token: org.token, body: { user_id: ref.id, role: 'referee' } })).body;
  // inv is 'invited', not 'proposed'

  const r = await api('POST', `/official-assignments/${inv.id}/confirm-proposal`, { token: org.token, body: {} });
  assert.equal(r.status, 409, 'confirm-proposal on invited assignment should fail');
});
