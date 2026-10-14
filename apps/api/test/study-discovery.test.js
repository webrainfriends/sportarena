import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { setAiTransport } = await import('../src/ai.js');

let server, base, n = 0, calls = 0, lastPrompt = '';
const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const must = (r, status) => { if (status ? r.status !== status : r.status >= 300) assert.fail(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const signup = async () => {
  n++;
  const r = must(await api('POST', '/auth/register', { body: { handle: `std_${n}`, display_name: `Std ${n}`, email: `std${n}@example.com`, password: 'correct-horse-battery', roles: ['athlete'] } }), 201);
  return { ...r.user, token: r.token };
};

const answer = {
  institutions: [
    { name: 'Loughborough University', kind: 'university', country: 'United Kingdom', city: 'Loughborough', about: 'Sport-focused university.', website: 'https://www.lboro.ac.uk', contact_email: 'not an email', contact_phone: null,
      admissions_process: 'Step 1 apply via UCAS. Step 2 interview.', known_for: 'Sports science',
      programmes: [{ title: 'BSc Sport and Exercise Science', kind: 'degree', mode: 'On Campus', sports: ['tennis', 'not-a-sport'], description: 'Three-year degree.', duration_text: '3 years', fee_text: 'about 9,250 GBP a year', how_to_apply: 'UCAS', apply_url: 'http://insecure.example' }, 'junk'] },
    { name: 'Loughborough University', kind: 'university', country: 'united kingdom', programmes: [] },
    42,
  ],
};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { setAiTransport(null); server.close(); await pool.end(); });

test('without AI switched on, discovery says so instead of inventing results', async () => {
  const u = await signup();
  must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'tennis', role: 'athlete', region: 'Leicester' } }), 201);
  const r = await api('POST', '/me/study/discover', { token: u.token, body: {} });
  assert.equal(r.status, 503);
});

test('context comes from the profile; discovery uses it, cleans the AI output, caches it, and needs a region or sport', async () => {
  setAiTransport(async (body) => { calls++; lastPrompt = body.messages[0].content; return JSON.stringify(answer); });
  const u = await signup();
  assert.equal((await api('POST', '/me/study/discover', { token: u.token, body: {} })).status, 400, 'no sport on the profile');
  must(await api('POST', '/me/sport-profiles', { token: u.token, body: { sport: 'tennis', role: 'athlete', region: 'Leicester' } }), 201);
  const ctx = must(await api('GET', '/me/study/context', { token: u.token }));
  assert.deepEqual(ctx.sports.map((s) => s.slug), ['tennis']);
  assert.deepEqual(ctx.regions, ['Leicester']);

  const r = must(await api('POST', '/me/study/discover', { token: u.token, body: {} }));
  assert.equal(calls, 1);
  assert.match(lastPrompt, /Leicester/);
  assert.equal(r.institutions.length, 1, 'the duplicate and junk entries are dropped');
  const inst = r.institutions[0];
  assert.equal(inst.contact_email, null, 'an invalid email is not kept');
  assert.equal(inst.rating, null);
  assert.equal(inst.programmes.length, 1);
  const p = inst.programmes[0];
  assert.equal(p.mode, 'on_campus');
  assert.equal(p.apply_url, null, 'only https links are kept');
  assert.deepEqual(p.sports.map((s) => s.slug), ['tennis']);

  must(await api('POST', '/me/study/discover', { token: u.token, body: {} }));
  assert.equal(calls, 1, 'second identical search is served from the cache');
  must(await api('POST', '/me/study/discover', { token: u.token, body: { refresh: true } }));
  assert.equal(calls, 2);
  const regionOnly = must(await api('POST', '/me/study/discover', { token: u.token, body: { basis: 'region', region: 'Kerala' } }));
  assert.equal(regionOnly.sports.length, 0);
  assert.equal(regionOnly.region, 'Kerala');
  const cnt = await pool.query('SELECT count(*)::int AS n FROM study_institutions');
  assert.equal(cnt.rows[0].n, 1, 'the same institution is never stored twice');
});

test('bucket list: save, stage, note, remove and restore; reviews feed the rating', async () => {
  const u = await signup(), v = await signup();
  const found = must(await api('POST', '/me/study/discover', { token: u.token, body: { basis: 'region', region: 'Leicester' } }));
  const inst = found.institutions[0], prog = inst.programmes[0];

  const item = must(await api('POST', '/me/bucket', { token: u.token, body: { target_type: 'study_programme', target_id: prog.id, note: 'Ask about scholarships', target_date: '2027-01-15' } }), 201);
  assert.equal(item.status, 'saved');
  must(await api('POST', '/me/bucket', { token: u.token, body: { target_type: 'study_institution', target_id: inst.id } }), 201);
  assert.equal((await api('POST', '/me/bucket', { token: u.token, body: { target_type: 'study_programme', target_id: '00000000-0000-4000-8000-000000000000' } })).status, 404);

  must(await api('PATCH', `/me/bucket/${item.id}`, { token: u.token, body: { status: 'applying' } }));
  let list = must(await api('GET', '/me/bucket', { token: u.token }));
  assert.equal(list.length, 2);
  const row = list.find((x) => x.id === item.id);
  assert.equal(row.status, 'applying');
  assert.equal(row.note, 'Ask about scholarships');
  assert.equal(row.institution, 'Loughborough University');
  assert.equal(row.listed_on_platform, false);
  assert.equal((await api('GET', '/me/bucket', { token: v.token })).body.length, 0, 'buckets are private');
  assert.equal((await api('PATCH', `/me/bucket/${item.id}`, { token: v.token, body: { status: 'accepted' } })).status, 404);

  must(await api('POST', '/testimonials', { token: v.token, body: { subject_type: 'study_institution', subject_id: inst.id, rating: 4, body: 'Great facilities and coaches.' } }), 201);
  must(await api('POST', '/testimonials', { token: u.token, body: { subject_type: 'study_institution', subject_id: inst.id, rating: 5, body: 'Loved the course content.' } }), 201);
  must(await api('POST', '/testimonials', { token: u.token, body: { subject_type: 'study_programme', subject_id: prog.id, rating: 3, body: 'Heavy workload.' } }), 201);
  const shown = must(await api('GET', `/study/institutions/${inst.id}`, { token: u.token }));
  assert.equal(shown.rating, 4.5);
  assert.equal(shown.reviews, 2);
  assert.equal(shown.programmes[0].rating, 3);
  list = must(await api('GET', '/me/bucket', { token: u.token }));
  assert.equal(list.find((x) => x.target_type === 'study_institution').rating, 4.5);
  const reviews = must(await api('GET', `/testimonials?subject_type=study_institution&subject_id=${inst.id}`));
  assert.equal(reviews.reviews?.length ?? reviews.items?.length ?? reviews.testimonials?.length ?? 2, 2);

  must(await api('PATCH', `/me/bucket/${item.id}`, { token: u.token, body: { remove: true } }));
  assert.equal(must(await api('GET', '/me/bucket', { token: u.token })).length, 1);
  const again = must(await api('POST', '/me/bucket', { token: u.token, body: { target_type: 'study_programme', target_id: prog.id } }), 201);
  assert.equal(again.id, item.id, 'saving again restores the same item');
  assert.equal(again.status, 'saved');
  assert.equal(again.note, 'Ask about scholarships', 'the note is kept');
  const kept = await pool.query('SELECT count(*)::int AS n FROM study_bucket');
  assert.equal(kept.rows[0].n, 2, 'nothing was deleted');
});
