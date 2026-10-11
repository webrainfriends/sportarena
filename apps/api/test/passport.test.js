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
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pp_${n}`, display_name: `Pp ${n}`, email: `pp${n}@example.com`, phone: '+911234567890', full_name: `Secret Name ${n}`, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('a passport link is secret, expiring, revocable, counted, and shows no personal identification data', async () => {
  const a = await signup(), other = await signup();
  const prof = (await api('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'football', role: 'athlete', level: 'amateur', position: 'Striker', jersey_no: 9, club: 'Rovers FC' } })).body;
  await api('POST', '/me/matches', { token: a.token, body: { sport_profile_id: prof.id, played_on: day(-10), opponent: 'SECRET-OPPONENT', result: 'win', score_for: 2, score_against: 0, notes: 'PRIVATE-NOTE' } });
  await api('POST', '/me/matches', { token: a.token, body: { sport_profile_id: prof.id, played_on: day(-5), result: 'loss' } });
  const fb = (await pool.query("SELECT id FROM sports WHERE slug='football'")).rows[0].id;
  await pool.query(`INSERT INTO performances(user_id, sport_id, metric, value, points, recorded_by, provenance, status, unit, direction, achieved_on)
                    VALUES ($1,$2,'goals',5,0,$1,'approved_competition','approved','count','higher',$3), ($1,$2,'assists',9,0,$1,'self_reported','recorded','count','higher',$3)`, [a.id, fb, day(-3)]);
  await pool.query("INSERT INTO awards(name, kind, user_id, awarded_by, note) VALUES ('Golden Boot','trophy',$1,$1,'PRIVATE-AWARD-NOTE')", [a.id]);

  assert.equal((await api('POST', '/me/passport-links', { body: {} })).status, 401);
  assert.equal((await api('POST', '/me/passport-links', { token: a.token, body: { expires_in_days: 365 } })).status, 400, 'at most 90 days');
  const made = await api('POST', '/me/passport-links', { token: a.token, body: { label: 'Academy scout', expires_in_days: 7 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { token, id, path } = made.body;
  assert.match(token, /^sa_/); assert.ok(path.includes(token));

  // only a hash is stored; the list never shows the secret
  const stored = (await pool.query('SELECT token_hash FROM passport_links WHERE id=$1', [id])).rows[0].token_hash;
  assert.notEqual(stored, token); assert.match(stored, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify((await api('GET', '/me/passport-links', { token: a.token })).body).includes(token));

  // anyone with the link can read it, with no sign-in
  const view = await api('GET', `/passport/${encodeURIComponent(token)}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const p = view.body;
  assert.equal(p.athlete.handle, a.handle); assert.equal(p.athlete.display_name, a.display_name);
  assert.equal(p.sport_profiles[0].club, 'Rovers FC'); assert.equal(p.sport_profiles[0].jersey_no, 9);
  assert.equal(p.career[0].matches, 2); assert.equal(p.career[0].wins, 1); assert.equal(p.career[0].losses, 1); assert.equal(p.career[0].official_matches, 0, 'self-logged matches are labelled as such');
  assert.equal(p.seasons[0].season, new Date().getUTCFullYear());
  assert.deepEqual(p.verified_results.map((r) => [r.metric, r.best]), [['goals', 5]], 'only approved competition results, never practice');
  assert.equal(p.awards[0].name, 'Golden Boot');

  // nothing private leaks
  const text = JSON.stringify(p);
  for (const secret of ['SECRET-OPPONENT', 'PRIVATE-NOTE', 'PRIVATE-AWARD-NOTE', 'Secret Name', a.email, '+911234567890', 'dob', 'national']) assert.ok(!text.toLowerCase().includes(String(secret).toLowerCase()), `leaked ${secret}`);

  // opens are counted
  assert.equal((await api('GET', '/me/passport-links', { token: a.token })).body[0].view_count, 1);
  assert.equal((await api('GET', '/me/passport-links', { token: a.token })).body[0].status, 'active');

  // wrong, other people's, revoked and expired links all look the same
  assert.equal((await api('GET', '/passport/sa_not-a-real-token-value')).status, 404);
  assert.equal((await api('POST', `/me/passport-links/${id}/revoke`, { token: other.token })).status, 404, 'not yours');
  assert.equal((await api('POST', `/me/passport-links/${id}/revoke`, { token: a.token })).status, 200);
  assert.equal((await api('GET', `/passport/${encodeURIComponent(token)}`)).status, 404, 'revoked');
  assert.equal((await api('POST', `/me/passport-links/${id}/revoke`, { token: a.token })).status, 404, 'already revoked');
  assert.equal((await api('GET', '/me/passport-links', { token: a.token })).body[0].status, 'revoked');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM passport_links WHERE user_id=$1', [a.id])).rows[0].n, 1, 'the record is kept');

  const exp = (await api('POST', '/me/passport-links', { token: a.token, body: {} })).body;
  await pool.query("UPDATE passport_links SET expires_at = now() - interval '1 minute' WHERE id=$1", [exp.id]);
  assert.equal((await api('GET', `/passport/${encodeURIComponent(exp.token)}`)).status, 404, 'expired');
  assert.equal((await api('GET', '/me/passport-links', { token: a.token })).body.find((l) => l.id === exp.id).status, 'expired');
});

test('what a link shows is the athlete\'s choice, and the owner can preview', async () => {
  const a = await signup();
  const prof = (await api('POST', '/me/sport-profiles', { token: a.token, body: { sport: 'football', role: 'athlete' } })).body;
  await api('POST', '/me/matches', { token: a.token, body: { sport_profile_id: prof.id, played_on: day(-2), result: 'win' } });
  await pool.query("INSERT INTO awards(name, kind, user_id, awarded_by) VALUES ('MVP','mvp',$1,$1)", [a.id]);
  const l = (await api('POST', '/me/passport-links', { token: a.token, body: { show_matches: false, show_results: false } })).body;
  const p = (await api('GET', `/passport/${encodeURIComponent(l.token)}`)).body;
  assert.equal(p.career, null); assert.equal(p.seasons, null); assert.equal(p.verified_results, null);
  assert.equal(p.awards.length, 1, 'awards stay on');
  assert.equal(p.sport_profiles.length, 1);
  const mine = (await api('GET', '/me/passport', { token: a.token })).body;
  assert.equal(mine.career[0].matches, 1); assert.equal(mine.awards.length, 1);
  assert.equal((await api('GET', '/me/passport')).status, 401);
});

test('young people cannot create passport links', async () => {
  const kid = await signup();
  await pool.query("UPDATE users SET youth_until = current_date + interval '2 years' WHERE id=$1", [kid.id]);
  assert.equal((await api('POST', '/me/passport-links', { token: kid.token, body: {} })).status, 403);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM passport_links WHERE user_id=$1', [kid.id])).rows[0].n, 0);
});
