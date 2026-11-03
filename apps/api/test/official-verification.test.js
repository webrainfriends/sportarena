// Official verification (#479): suspensions are not on any public surface; an entitled organiser can ask the platform for a standing attestation; only an
// Official verifier (granted by the platform admin, never self-assigned, never public) answers it; the attestation never reveals a sanction.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp', PLATFORM_ADMIN_EMAILS: 'rraja.edge@gmail.com,rrajas1978@icloud.com' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { reconcilePlatformRoles } = await import('../src/platform.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const reg = async (handle, email, roles = ['athlete']) => { const r = await api('POST', '/auth/register', { body: { handle, display_name: handle, email: email ?? `${handle}@example.com`, password: 'correct-horse-battery', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };

let admin, verifier, organiser, stranger, player, comp, season, team, sportId, ev;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate();
  server = createApp().listen(0); base = `http://localhost:${server.address().port}`;
  admin = await reg('boss_one', 'rraja.edge@gmail.com'); await pool.query("UPDATE users SET roles='{athlete,admin,platform_admin}' WHERE id=$1", [admin.id]);
  verifier = await reg('verifier_vic'); organiser = await reg('org_olive', null, ['organizer']); stranger = await reg('stranger_sam'); player = await reg('player_pat');
  comp = must(await api('POST', '/competitions', { token: organiser.token, body: { name: 'Verified Cup', sport: 'football', country: 'IN', level: 'amateur', is_public: true } }), 201);
  season = must(await api('POST', `/competitions/${comp.id}/seasons`, { token: organiser.token, body: { label: '2026/27', starts_on: day(1), ends_on: day(200), registration_opens_on: day(-1), registration_closes_on: day(30) } }), 201);
  ev = (await pool.query('SELECT event_id FROM comp_seasons WHERE id=$1', [season.id])).rows[0].event_id;
  sportId = (await pool.query('SELECT sport_id FROM events WHERE id=$1', [ev])).rows[0].sport_id;
  team = must(await api('POST', '/teams', { token: organiser.token, body: { name: 'Verified FC', sport: 'football' } }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, player.id]);
});
after(async () => { server.close(); await pool.end(); });

const ask = (token, extra = {}) => api('POST', '/official-verifications', { token, body: { subject_user_id: player.id, sport_id: sportId, purpose: 'tournament_selection', competition_id: comp.id, ...extra } });

test('the Official verifier role: granted only by the platform admin, never self-assigned, never public, and not stripped as an admin label', async () => {
  assert.equal((await api('POST', '/admin/official-verifiers', { token: verifier.token, body: { user_id: verifier.id } })).status, 403, 'not for ordinary accounts');
  assert.equal((await api('PATCH', '/me/roles', { token: verifier.token, body: { add: ['official_verifier'] } })).status, 400, 'not self-assignable');
  assert.equal((await api('POST', '/auth/register', { body: { handle: 'sneaky', display_name: 'S', email: 'sneaky@example.com', password: 'correct-horse-battery', roles: ['official_verifier'] } })).status, 400);
  must(await api('POST', '/admin/official-verifiers', { token: admin.token, body: { user_id: verifier.id } }), 201);
  assert.ok((await pool.query('SELECT roles FROM users WHERE id=$1', [verifier.id])).rows[0].roles.includes('official_verifier'));
  await reconcilePlatformRoles({ log() {}, error() {} });
  assert.ok((await pool.query('SELECT roles FROM users WHERE id=$1', [verifier.id])).rows[0].roles.includes('official_verifier'), 'reconcile guards the two admin labels only');
  const person = must(await api('GET', `/people/${verifier.id}`));
  assert.ok(!person.roles.includes('official_verifier') && !person.roles.includes('admin'), 'other people never see the role');
  assert.equal((await api('GET', '/verifier/queue', { token: stranger.token })).status, 403);
  assert.equal((await api('GET', '/verifier/queue', { token: verifier.token })).status, 200);
  const kept = must(await api('PATCH', '/me/roles', { token: verifier.token, body: { add: ['coach'] } }));
  assert.ok((await pool.query('SELECT roles FROM users WHERE id=$1', [verifier.id])).rows[0].roles.includes('official_verifier'), 'editing roles keeps the staff role');
  assert.ok(!kept.roles.includes('official_verifier'));
});

test('a verification request needs standing for a competition or organisation AND the platform-reports entitlement; an unpriced install denies', async () => {
  assert.equal((await ask(stranger.token)).status, 404, 'no standing in that competition');
  assert.equal((await ask(organiser.token)).status, 402, 'no entitlement is published yet: closed, not open');
  assert.equal((await ask(organiser.token, { subject_user_id: organiser.id })).status, 400, 'not about yourself');
  await pool.query("INSERT INTO commercial_overrides(scope, subject_type, subject_id, key, reason, created_by) VALUES ('contract','user',$1,'reports.official_verification','Platform reports subscription',$2)", [organiser.id, admin.id]);
  const r = must(await ask(organiser.token, { note: 'Selection for the district squad' }), 201);
  assert.match(r.request_no, /^OV-/);
  const raw = (await pool.query('SELECT note_enc FROM disc_verification_requests WHERE id=$1', [r.id])).rows[0].note_enc;
  assert.ok(!raw.includes('district'), 'the note is encrypted at rest');
});

test('end to end: suspensions never reach public views; the verifier issues a standing attestation that carries no sanction detail', async () => {
  must(await api('POST', `/competitions/${comp.id}/discipline/policy`, { token: organiser.token, body: { params: { direct: [{ kind: 'red_card', matches: 5 }], card_points: {} } } }), 201);
  const fx = (await pool.query("INSERT INTO fixtures(event_id, home_team_id, away_team_id, scheduled_at, status) VALUES ($1,$2,NULL,now() - interval '1 day','completed') RETURNING id", [ev, team.id])).rows[0].id;
  await pool.query("INSERT INTO fixtures(event_id, home_team_id, scheduled_at) VALUES ($1,$2,now() + interval '3 days')", [ev, team.id]);
  await pool.query("INSERT INTO match_events(fixture_id, event_id, seq, kind, team_id, player_id, recorded_by) VALUES ($1,$2,1,'red_card',$3,$4,$5)", [fx, ev, team.id, player.id, organiser.id]);
  assert.equal(must(await api('POST', `/competitions/${comp.id}/discipline/sweep`, { token: organiser.token, body: { season_id: season.id } })).opened, 1);

  // nothing disciplinary is on any public surface
  const surfaces = [`/people/${player.id}`, `/teams/${team.id}`, '/people'];
  for (const path of surfaces) {
    const r = await api('GET', path, path === '/people' ? { query: { q: 'player' } } : {});
    const txt = JSON.stringify(r.body).toLowerCase();
    assert.ok(!/suspen|disciplin|sanction|red_card|ban\b|disc_/.test(txt), `${path} must not mention discipline: ${txt.slice(0, 200)}`);
  }
  const pack = await api('GET', `/people/${player.id}`);
  assert.equal(pack.status, 200);
  assert.equal((await api('GET', '/me/discipline', { token: stranger.token })).body.length, 0, 'nobody sees another person’s matters');

  const [req] = must(await api('GET', '/me/official-verifications', { token: organiser.token }));
  const queue = must(await api('GET', '/verifier/queue', { token: verifier.token }));
  assert.equal(queue.length, 1);
  assert.equal(JSON.stringify(queue).includes('red_card'), false, 'the queue never carries a sanction');
  assert.equal((await api('POST', `/verifier/requests/${req.id}/decision`, { token: verifier.token, body: {} })).status, 409, 'claim first');
  must(await api('POST', `/verifier/requests/${req.id}/claim`, { token: verifier.token }));
  assert.equal((await api('POST', `/verifier/requests/${req.id}/claim`, { token: admin.token })).status, 409, 'one verifier per request');
  const att = must(await api('POST', `/verifier/requests/${req.id}/decision`, { token: verifier.token, body: {} }), 201);
  assert.equal(att.result, 'not_eligible');
  assert.ok(att.valid_until > att.as_of);
  assert.deepEqual(Object.keys(att).sort(), ['as_of', 'id', 'result', 'valid_until'], 'the attestation is only a result and its dates');
  const mine = must(await api('GET', '/me/official-verifications', { token: organiser.token }));
  assert.equal(mine[0].result, 'not_eligible');
  assert.equal(mine[0].valid, true);
  assert.ok(!JSON.stringify(mine).match(/red_card|suspension|sanction|reason|evidence/i));
  // a lifted standing is a new request; an old attestation can be revoked
  must(await api('POST', `/verifier/attestations/${att.id}/revoke`, { token: verifier.token, body: { reason: 'Standing changed on appeal' } }));
  assert.equal(must(await api('GET', '/me/official-verifications', { token: organiser.token }))[0].valid, false);
  // the requester may not decide their own request; an ordinary user has no queue
  assert.equal((await api('POST', `/verifier/requests/${req.id}/claim`, { token: organiser.token })).status, 403);
});

test('a clean record verifies as eligible, and a young person needs current guardian consent', async () => {
  const clean = await reg('clean_cleo');
  must(await api('POST', '/admin/official-verifiers', { token: admin.token, body: { user_id: verifier.id } }), 201);
  const r = must(await ask(organiser.token, { subject_user_id: clean.id }), 201);
  must(await api('POST', `/verifier/requests/${r.id}/claim`, { token: verifier.token }));
  assert.equal(must(await api('POST', `/verifier/requests/${r.id}/decision`, { token: verifier.token, body: {} }), 201).result, 'eligible');
  const kid = await reg('kid_kai');
  await pool.query("UPDATE users SET youth_until = current_date + interval '5 years' WHERE id=$1", [kid.id]);
  const youth = await ask(organiser.token, { subject_user_id: kid.id });
  assert.equal(youth.status, 409, `a minor without consent is refused: ${JSON.stringify(youth.body)}`);
  assert.equal(youth.body.error.details?.code ?? youth.body.error.code, 'guardian_consent_required');
});

test('the Official verifier can be revoked: staff access ends, attestations and history stay', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM disc_attestations')).rows[0].n;
  must(await api('DELETE', `/admin/official-verifiers/${verifier.id}`, { token: admin.token }));
  assert.equal((await api('GET', '/verifier/queue', { token: verifier.token })).status, 403);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM disc_attestations')).rows[0].n, before);
  assert.equal((await api('GET', '/admin/official-verifiers', { token: verifier.token })).status, 403);
});
