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
const signup = async (extra = {}) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `ap_${n}`, display_name: `Player ${n}`, email: `ap${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'], ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const q = async (sql, args) => (await pool.query(sql, args)).rows;
const profile = async (u, sport, extra = {}) => (await api('POST', '/me/sport-profiles', { token: u.token, body: { sport, role: 'athlete', level: 'amateur', ...extra } })).body;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('archiving a sport card keeps every logged match; restore and re-adding bring the card back', async () => {
  const u = await signup();
  const f = await profile(u, 'football');
  const t = await profile(u, 'tennis');
  for (let d = 1; d <= 3; d++) await api('POST', '/me/matches', { token: u.token, body: { sport_profile_id: f.id, played_on: `2026-01-0${d}`, opponent: 'Reds', score_for: 2, score_against: 1 } });
  assert.equal((await api('DELETE', `/me/sport-profiles/${f.id}`, { token: u.token })).status, 200);
  assert.equal((await q('SELECT count(*)::int AS n FROM player_matches WHERE sport_profile_id=$1', [f.id]))[0].n, 3, 'matches are never destroyed');
  assert.equal((await q('SELECT 1 FROM sport_profiles WHERE id=$1', [f.id])).length, 1, 'the card row is kept');
  const cards = (await api('GET', '/me/sport-profiles', { token: u.token })).body;
  assert.deepEqual(cards.map((c) => [c.sport_slug, c.is_default]), [['tennis', true]], 'default is promoted');
  const archived = (await api('GET', '/me/sport-profiles/archived', { token: u.token })).body;
  assert.deepEqual(archived.map((a) => [a.sport_slug, a.matches_kept]), [['football', 3]]);
  assert.equal((await api('GET', '/me/matches', { token: u.token })).body.length, 3, 'career history still lists the matches');
  assert.equal((await api('POST', `/me/sport-profiles/${f.id}/default`, { token: u.token })).status, 400, 'archived card cannot become default');
  // restore: same card, same matches, not the default
  assert.equal((await api('POST', `/me/sport-profiles/${f.id}/restore`, { token: u.token })).status, 200);
  const back = (await api('GET', '/me/sport-profiles', { token: u.token })).body;
  assert.deepEqual(back.map((c) => [c.sport_slug, c.is_default, c.summary.matches]), [['tennis', true, 0], ['football', false, 3]]);
  // archive again then add the sport again: restores the same row, no duplicate
  await api('DELETE', `/me/sport-profiles/${f.id}`, { token: u.token });
  const again = await profile(u, 'football');
  assert.equal(again.id, f.id);
  assert.equal((await q("SELECT count(*)::int AS n FROM sport_profiles WHERE user_id=$1 AND role='athlete'", [u.id]))[0].n, 2);
  // an archived card is not on the public profile
  await api('DELETE', `/me/sport-profiles/${t.id}`, { token: u.token });
  assert.deepEqual((await api('GET', `/people/${u.id}`)).body.sport_profiles.map((p) => p.slug), ['football']);
});

test('the only card can be archived and restored as the default', async () => {
  const u = await signup();
  const p = await profile(u, 'cricket');
  await api('DELETE', `/me/sport-profiles/${p.id}`, { token: u.token });
  assert.deepEqual((await api('GET', '/me/sport-profiles', { token: u.token })).body, []);
  await api('POST', `/me/sport-profiles/${p.id}/restore`, { token: u.token });
  assert.equal((await api('GET', '/me/sport-profiles', { token: u.token })).body[0].is_default, true);
  const other = await signup();
  assert.equal((await api('POST', `/me/sport-profiles/${p.id}/restore`, { token: other.token })).status, 404);
  assert.equal((await api('DELETE', `/me/sport-profiles/${p.id}`, { token: other.token })).status, 404);
});

test('dominant side, positions and preferences are private until shared, and scoped per viewer', async () => {
  const u = await signup();
  const p = await profile(u, 'football', { position: 'Striker' });
  const opts = (await api('GET', '/sports/football/profile-options')).body;
  assert.ok(opts.positions.includes('Winger') && opts.metrics.find((m) => m.metric === 'height').units.includes('in'));
  const set = await api('PATCH', `/me/sport-profiles/${p.id}/athlete`, { token: u.token, body: { dominant_side: 'left', positions: ['Striker', 'Winger', 'Striker'], play_prefs: ['Pressing'] } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const mine = (await api('GET', `/me/sport-profiles/${p.id}/athlete`, { token: u.token })).body;
  assert.deepEqual(mine.positions, ['Striker', 'Winger']);
  assert.equal(mine.dominant_side, 'left');
  const pub = () => api('GET', `/people/${u.id}`).then((r) => r.body.sport_profiles[0]);
  let seen = await pub();
  assert.ok(!('dominant_side' in seen) && !('positions' in seen), 'private by default');
  await api('PATCH', `/me/sport-profiles/${p.id}/athlete`, { token: u.token, body: { field_scopes: { positions: 'public', dominant_side: 'coach' } } });
  seen = await pub();
  assert.deepEqual(seen.positions, ['Striker', 'Winger']);
  assert.ok(!('dominant_side' in seen), 'coach-scoped is hidden from the public');
  // a coach of the athlete's team sees coach-scoped fields
  const coach = await signup({ roles: ['coach'] });
  const tm = (await api('POST', '/teams', { token: u.token, body: { name: 'Scope FC', sport: 'football' } })).body;
  await q("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT DO NOTHING", [tm.id, coach.id]);
  const asCoach = (await api('GET', `/people/${u.id}`, { token: coach.token })).body.sport_profiles[0];
  assert.equal(asCoach.dominant_side, 'left');
  const stranger = await signup();
  assert.ok(!('dominant_side' in (await api('GET', `/people/${u.id}`, { token: stranger.token })).body.sport_profiles[0]));
  // validation
  assert.equal((await api('PATCH', `/me/sport-profiles/${p.id}/athlete`, { token: u.token, body: { dominant_side: 'up' } })).status, 400);
  assert.equal((await api('PATCH', `/me/sport-profiles/${p.id}/athlete`, { token: stranger.token, body: { dominant_side: 'left' } })).status, 404);
});

test('measurements are opt-in, validated by unit, dated, encrypted, audited, scoped and revocable', async () => {
  const u = await signup();
  const p = await profile(u, 'basketball');
  const add = (body) => api('POST', `/me/sport-profiles/${p.id}/measurements`, { token: u.token, body });
  assert.equal((await add({ metric: 'height', unit: 'cm', value: 20, measured_on: '2026-03-01' })).status, 400, 'out of range');
  assert.equal((await add({ metric: 'height', unit: 'kg', value: 180, measured_on: '2026-03-01' })).status, 400, 'wrong unit');
  assert.equal((await add({ metric: 'height', unit: 'cm', value: 180, measured_on: '2999-01-01' })).status, 400, 'future date');
  const ok = await add({ metric: 'height', unit: 'in', value: 72, measured_on: '2026-03-01', source: 'coach' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await q('SELECT value_enc FROM athlete_measurements WHERE id=$1', [ok.body.id]))[0].value_enc.startsWith('v1.'), true, 'stored encrypted');
  const listed = (await api('GET', `/me/sport-profiles/${p.id}/measurements`, { token: u.token })).body;
  assert.deepEqual([listed[0].value, listed[0].unit, listed[0].measured_on, listed[0].source, listed[0].scope], [72, 'in', '2026-03-01', 'coach', 'private']);
  assert.ok((await q("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_athlete_measurements'", [u.id])).length);
  const seen = async () => (await api('GET', `/people/${u.id}`)).body.sport_profiles[0].measurements;
  assert.deepEqual(await seen(), [], 'private by default');
  assert.equal((await api('PATCH', `/me/measurements/${ok.body.id}`, { token: u.token, body: { scope: 'public' } })).status, 200);
  assert.equal((await seen())[0].value, 72);
  assert.equal((await api('POST', `/me/measurements/${ok.body.id}/revoke`, { token: u.token })).status, 200);
  assert.deepEqual(await seen(), [], 'revocation is immediate');
  assert.equal((await q('SELECT 1 FROM athlete_measurements WHERE id=$1', [ok.body.id])).length, 1, 'kept, not deleted');
  assert.equal((await api('POST', `/me/measurements/${ok.body.id}/restore`, { token: u.token })).status, 200);
  assert.deepEqual(await seen(), [], 'restored as private');
  const stranger = await signup();
  assert.equal((await api('POST', `/me/measurements/${ok.body.id}/revoke`, { token: stranger.token })).status, 404);
});

test('verified affiliations and completeness come from existing records', async () => {
  const u = await signup();
  const p = await profile(u, 'football');
  let prof = (await api('GET', `/me/sport-profiles/${p.id}/athlete`, { token: u.token })).body;
  assert.deepEqual(prof.affiliations, []);
  const base0 = prof.completeness.percent;
  const tm = (await api('POST', '/teams', { token: u.token, body: { name: 'Verified FC', sport: 'football' } })).body;
  await api('PATCH', `/me/sport-profiles/${p.id}/athlete`, { token: u.token, body: { dominant_side: 'right', positions: ['Striker'], play_prefs: ['Pressing'] } });
  prof = (await api('GET', `/me/sport-profiles/${p.id}/athlete`, { token: u.token })).body;
  assert.deepEqual(prof.affiliations.map((a) => [a.kind, a.label, a.verified]), [['team', 'Verified FC', true]]);
  assert.ok(prof.completeness.percent > base0 && !prof.completeness.missing.includes('dominant_side'));
  assert.ok(prof.completeness.missing.includes('measurement'), 'a measurement is never required');
});

test('young athletes cannot share profile fields beyond private (guardian authority)', async () => {
  const u = await signup();
  const p = await profile(u, 'football');
  await q("UPDATE users SET youth_until = current_date + 365 WHERE id=$1", [u.id]);
  const r = await api('PATCH', `/me/sport-profiles/${p.id}/athlete`, { token: u.token, body: { field_scopes: { positions: 'public' } } });
  assert.equal(r.status, 400);
  const m = await api('POST', `/me/sport-profiles/${p.id}/measurements`, { token: u.token, body: { metric: 'height', unit: 'cm', value: 170, measured_on: '2026-03-01', scope: 'coach' } });
  assert.equal(m.status, 400);
  assert.equal((await api('PATCH', `/me/sport-profiles/${p.id}/athlete`, { token: u.token, body: { positions: ['Striker'] } })).status, 200);
});
