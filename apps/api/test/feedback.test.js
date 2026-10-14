import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { signToken } = await import('../src/auth.js');

let server, base;
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
let n = 0;
const signup = async () => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `fb_${n}`, display_name: `FB ${n}`, email: `fb${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const review = (u, subject_type, subject_id, rating, body = 'Really good experience') => api('POST', '/testimonials', { token: u.token, body: { subject_type, subject_id, rating, body } });
const summary = async (subject_type, subject_id) => (await api('GET', `/testimonials?subject_type=${subject_type}&subject_id=${subject_id}`)).body;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('editing keeps the original date and the earlier text in the history; owners cannot review their own team', async () => {
  const cap = await signup(), fan = await signup();
  const team = (await api('POST', '/teams', { token: cap.token, body: { name: 'Feedback FC', sport: 'football' } })).body;
  assert.equal((await review(cap, 'team', team.id, 5)).status, 400, 'owner cannot review own team');
  const first = (await review(fan, 'team', team.id, 3, 'Decent side, slow start')).body;
  assert.equal(first.verification, 'unverified');
  const edited = (await review(fan, 'team', team.id, 5, 'Much better this time')).body;
  assert.equal(edited.id, first.id);
  assert.equal(new Date(edited.created_at).getTime(), new Date(first.created_at).getTime(), 'created_at is not replaced by the edit');
  assert.ok(edited.updated_at);
  const hist = (await pool.query('SELECT rating, body, action FROM testimonial_revisions WHERE testimonial_id=$1', [first.id])).rows;
  assert.deepEqual(hist, [{ rating: 3, body: 'Decent side, slow start', action: 'edit' }]);
});

test('withdrawn and moderated reviews leave every public average; zero reviews is null, not 0', async () => {
  const cap = await signup(), a = await signup(), b = await signup(), staff = await signup();
  const team = (await api('POST', '/teams', { token: cap.token, body: { name: 'Average FC', sport: 'football' } })).body;
  assert.equal((await summary('team', team.id)).avg, null);
  const ra = (await review(a, 'team', team.id, 5)).body;
  const rb = (await review(b, 'team', team.id, 1)).body;
  assert.equal((await summary('team', team.id)).n, 2);
  assert.equal(Number((await summary('team', team.id)).avg), 3);

  // another person cannot withdraw it; the author can
  assert.equal((await api('POST', `/testimonials/${rb.id}/withdraw`, { token: a.token })).status, 403);
  assert.equal((await api('POST', `/testimonials/${rb.id}/withdraw`, { token: b.token })).body.status, 'withdrawn');
  let s = await summary('team', team.id);
  assert.equal(s.n, 1); assert.equal(Number(s.avg), 5); assert.equal(s.items.length, 1);

  // report is open to readers, staff-only to decide
  assert.equal((await api('POST', `/testimonials/${ra.id}/report`, { token: b.token, body: { category: 'spam' } })).status, 201);
  assert.equal((await api('POST', `/testimonials/${ra.id}/moderate`, { token: b.token, body: { action: 'hide', reason: 'I do not like it' } })).status, 403);
  await pool.query("UPDATE users SET roles='{admin}' WHERE id=$1", [staff.id]);
  const adminTok = await signToken({ id: staff.id, roles: ['admin'] });
  assert.equal((await api('POST', `/testimonials/${ra.id}/moderate`, { token: adminTok, body: { action: 'hide', reason: 'Confirmed fabricated interaction' } })).body.status, 'hidden');
  s = await summary('team', team.id);
  assert.equal(s.n, 0); assert.equal(s.avg, null);
  assert.equal((await review(a, 'team', team.id, 5, 'Trying to edit it back')).status, 400, 'author cannot republish a hidden review');
  assert.equal((await pool.query("SELECT status FROM testimonial_reports WHERE testimonial_id=$1", [ra.id])).rows[0].status, 'upheld');
  assert.equal((await api('POST', `/testimonials/${ra.id}/moderate`, { token: adminTok, body: { action: 'restore', reason: 'Appeal accepted, evidence checked' } })).body.status, 'published');
  assert.equal((await summary('team', team.id)).n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM testimonial_revisions WHERE testimonial_id=$1", [ra.id])).rows[0].n, 2);

  // writing again after withdrawing republishes
  assert.equal((await review(b, 'team', team.id, 2, 'Changed my mind, fair enough')).body.status, 'published');
  assert.equal((await summary('team', team.id)).n, 2);
});

test('legacy rows stay published but are labelled legacy, never verified', async () => {
  const cap = await signup(), a = await signup();
  const team = (await api('POST', '/teams', { token: cap.token, body: { name: 'Legacy FC', sport: 'football' } })).body;
  await pool.query("INSERT INTO testimonials(author_id, subject_type, subject_id, rating, body, created_at) VALUES ($1,'team',$2,4,'Old review','2024-01-01')", [a.id, team.id]);
  const s = await summary('team', team.id);
  assert.equal(s.n, 1); assert.equal(s.verified, 0);
  assert.equal(s.items[0].verification, 'legacy');
});
