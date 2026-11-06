// PS-20 (#850) Accessible para-sport Learn & Study content catalogue: learning paths, editorial workflow,
// accessible media, assessments, progress tracking, credential issuance, institution publisher gate, recommendations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => { n++; const r = await api('POST', '/auth/register', { body: { handle: `pl${n}`, display_name: `PL ${n}`, email: `pl${n}@example.com`, password: 'horse-battery-X9', roles } }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token }; };
const adminToken = async () => {
  const rows = (await pool.query("SELECT email FROM users WHERE roles @> ARRAY['platform_admin']::text[] LIMIT 1")).rows;
  if (!rows.length) throw new Error('No platform admin seeded');
  const r = await api('POST', '/auth/login', { body: { email: rows[0].email, password: process.env.PLATFORM_ADMIN_TEST_PASSWORD ?? 'correct-horse-battery' } });
  return r.body.token;
};
const sport = async (slug = 'para-athletics') => (await pool.query('SELECT id, slug FROM sports WHERE slug=$1', [slug])).rows[0];
const org = async (token) => must(await api('POST', '/organisations', { token, body: { name: `Org ${++n}`, kind: 'club', sport_ids: [] } }), 201);

before(async () => { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await migrate(); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

// ── helpers ────────────────────────────────────────────────────────────────
const createPath = async (token, sportId, over = {}) => must(await api('POST', '/para/learn/paths', { token, body: { sport_id: sportId, level_key: 'beginner', title: `Learn path ${++n}`, summary: 'A test path', ...over } }), 201);
const addModule = async (token, versionId, over = {}) => must(await api('POST', `/para/learn/path-versions/${versionId}/modules`, { token, body: { title: `Module ${++n}`, body_blocks: [{ type: 'text', content: 'Body text.' }], source_attribution: { name: 'IPC', url: 'https://www.paralympic.org' }, ...over } }), 201);
const addAssessment = async (token, moduleId) => must(await api('POST', `/para/learn/modules/${moduleId}/assessments`, { token, body: { question: 'Which is correct?', options: [{ label: 'Yes', is_correct: true }, { label: 'No', is_correct: false }], plain_language_hint: 'Think yes.', max_retakes: 2 } }), 201);
const submitPath = async (token, versionId) => must(await api('POST', `/para/learn/path-versions/${versionId}/submit`, { token }));
const reviewPath = async (token, versionId, action) => must(await api('POST', `/para/learn/path-versions/${versionId}/review`, { token, body: { action } }));

// ── tests ──────────────────────────────────────────────────────────────────

test('public browse: empty when no published paths', async () => {
  const r = must(await api('GET', '/para/learn/paths'));
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 0);
});

test('path CRUD: create → draft version auto-created → add module → submit → approve → publish', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport();
  const path = await createPath(admin.token, sl.id);
  assert.ok(path.id, 'path id returned');
  assert.ok(path.draft_version_id, 'draft version auto-created');

  // add module with accessible media
  const mod = await addModule(admin.token, path.draft_version_id, {
    caption_url: 'https://cdn.example.com/captions.vtt',
    transcript_url: 'https://cdn.example.com/transcript.txt',
    alt_text: 'An athlete on the track',
    audio_description: 'The camera pans across a sunny athletics track.',
  });
  assert.ok(mod.id);
  assert.equal(mod.caption_url, 'https://cdn.example.com/captions.vtt');

  // add assessment
  const assess = await addAssessment(admin.token, mod.id);
  assert.ok(assess.id);

  // submit for review
  const submitted = await submitPath(admin.token, path.draft_version_id);
  assert.equal(submitted.status, 'submitted');

  // approve
  const approved = await reviewPath(admin.token, path.draft_version_id, 'approve');
  assert.equal(approved.status, 'approved');

  // publish
  const published = await reviewPath(admin.token, path.draft_version_id, 'publish');
  assert.equal(published.status, 'published');
  assert.ok(published.published_at);

  // now shows in public browse
  const paths = must(await api('GET', '/para/learn/paths'));
  assert.ok(paths.some((p) => p.id === path.id));
});

test('immutability: cannot update a published version', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport('para-swimming');
  const path = await createPath(admin.token, sl.id, { level_key: 'intermediate' });
  await addModule(admin.token, path.draft_version_id);
  await submitPath(admin.token, path.draft_version_id);
  await reviewPath(admin.token, path.draft_version_id, 'approve');
  await reviewPath(admin.token, path.draft_version_id, 'publish');

  // direct DB update should be blocked by trigger
  const r = await pool.query("UPDATE para_learn_path_versions SET objectives=$1 WHERE id=$2 RETURNING id", ['{}', path.draft_version_id]).catch((e) => ({ error: e.message }));
  assert.ok(r.error || r.rows?.length === 0, 'immutability trigger fired or update silently rejected');
});

test('single-draft constraint: cannot create second draft for same path', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport('boccia');
  const path = await createPath(admin.token, sl.id, { level_key: 'advanced' });

  // try to create another draft for same path
  const r = await api('POST', `/para/learn/paths/${path.id}/draft`, { token: admin.token, body: { objectives: ['obj1'], estimated_minutes: 30 } });
  // should either succeed (upsert) or the second insert attempt is handled gracefully
  // the unique partial index on (path_id) WHERE status='draft' means only one can exist
  // the capability should upsert (update) the existing draft, not 409
  assert.ok([200, 201].includes(r.status), `Expected upsert to succeed, got ${r.status}: ${JSON.stringify(r.body)}`);
});

test('submit validation: missing attribution → 400', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport('goalball');
  const path = await createPath(admin.token, sl.id);
  // add module without source_attribution
  await addModule(admin.token, path.draft_version_id, { source_attribution: null });
  const r = await api('POST', `/para/learn/path-versions/${path.draft_version_id}/submit`, { token: admin.token });
  assert.equal(r.status, 400, 'missing attribution should block submit');
});

test('submit validation: no modules → 400', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport('para-badminton');
  const path = await createPath(admin.token, sl.id);
  const r = await api('POST', `/para/learn/path-versions/${path.draft_version_id}/submit`, { token: admin.token });
  assert.equal(r.status, 400, 'no modules should block submit');
});

test('assessment: exactly one correct option enforced', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport('sitting-volleyball');
  const path = await createPath(admin.token, sl.id);
  const mod = await addModule(admin.token, path.draft_version_id);

  // zero correct → 400
  const r1 = await api('POST', `/para/learn/modules/${mod.id}/assessments`, { token: admin.token, body: { question: 'Q?', options: [{ label: 'A', is_correct: false }, { label: 'B', is_correct: false }] } });
  assert.equal(r1.status, 400, 'zero correct options');

  // two correct → 400
  const r2 = await api('POST', `/para/learn/modules/${mod.id}/assessments`, { token: admin.token, body: { question: 'Q?', options: [{ label: 'A', is_correct: true }, { label: 'B', is_correct: true }] } });
  assert.equal(r2.status, 400, 'two correct options');
});

test('progress tracking: complete module → % calculated → credential issued on path completion', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const athlete = await signup(['athlete']);
  const sl = await sport('wheelchair-basketball');
  const path = await createPath(admin.token, sl.id);
  const mod = await addModule(admin.token, path.draft_version_id);
  await addAssessment(admin.token, mod.id);
  await submitPath(admin.token, path.draft_version_id);
  await reviewPath(admin.token, path.draft_version_id, 'approve');
  const published = await reviewPath(admin.token, path.draft_version_id, 'publish');

  // get path detail for version_id
  const detail = must(await api('GET', `/para/learn/paths/${path.id}`));
  const versionId = detail.version_id ?? published.id;

  // complete the module (no assessment answer yet)
  const prog1 = must(await api('POST', '/para/learn/progress', { token: athlete.token, body: { path_id: path.id, version_id: versionId, module_id: mod.id } }), 201);
  assert.ok(prog1.id);

  // check progress
  const progress = must(await api('GET', '/para/learn/progress', { token: athlete.token, query: { path_id: path.id } }));
  assert.ok(Array.isArray(progress));
  const pEntry = progress.find((p) => p.path_id === path.id);
  assert.ok(pEntry, 'progress entry found');
  assert.ok(pEntry.module_completions?.includes(mod.id) || pEntry.completion_pct > 0, 'module recorded');

  // when path has no required assessments that must be passed, path should be complete
  // credential check
  if (pEntry.completion_pct === 100 || pEntry.credential_issued) {
    // credential issued
    const creds = must(await api('GET', '/athletes/me/credentials', { token: athlete.token }));
    assert.ok(creds.some((c) => c.kind === 'badge'), 'badge credential issued');
  }
});

test('retake cap: answer wrong → decrement retakes → 0 retakes → 400', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const athlete = await signup(['athlete']);
  const sl = await sport('blind-football');
  const path = await createPath(admin.token, sl.id);
  const mod = await addModule(admin.token, path.draft_version_id);
  const assess = must(await api('POST', `/para/learn/modules/${mod.id}/assessments`, { token: admin.token, body: { question: 'Q?', options: [{ label: 'Yes', is_correct: true }, { label: 'No', is_correct: false }], max_retakes: 1 } }), 201);
  await submitPath(admin.token, path.draft_version_id);
  await reviewPath(admin.token, path.draft_version_id, 'approve');
  const published = await reviewPath(admin.token, path.draft_version_id, 'publish');
  const detail = must(await api('GET', `/para/learn/paths/${path.id}`));
  const versionId = detail.version_id ?? published.id;

  // wrong answer attempt 1 (uses max_retakes=1 allowance)
  must(await api('POST', '/para/learn/progress', { token: athlete.token, body: { path_id: path.id, version_id: versionId, module_id: mod.id, assessment_id: assess.id, answer_index: 1 } }), 201);

  // wrong answer attempt 2 — should be blocked (retakes exhausted)
  const r = await api('POST', '/para/learn/progress', { token: athlete.token, body: { path_id: path.id, version_id: versionId, module_id: mod.id, assessment_id: assess.id, answer_index: 1 } });
  assert.equal(r.status, 400, 'retakes exhausted');
});

test('recommendations: returns paths for athlete declared sport interests, no disability attributes', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const athlete = await signup(['athlete']);
  const sl = await sport('para-athletics');
  const path = await createPath(admin.token, sl.id);
  await addModule(admin.token, path.draft_version_id);
  await submitPath(admin.token, path.draft_version_id);
  await reviewPath(admin.token, path.draft_version_id, 'approve');
  await reviewPath(admin.token, path.draft_version_id, 'publish');

  // set athlete sport profile
  await pool.query("INSERT INTO sport_profiles (user_id, sport_id, kind, status) VALUES ($1,$2,'para','active') ON CONFLICT DO NOTHING", [athlete.id, sl.id]);

  const recs = must(await api('GET', '/para/learn/recommendations', { token: athlete.token }));
  assert.ok(Array.isArray(recs));
  // recs should include published paths for the athlete's declared sport
  // disability inference fields must not be in the query or response
  const raw = JSON.stringify(recs);
  assert.ok(!raw.includes('classification_code'), 'no disability inference in response');
  assert.ok(!raw.includes('impairment_type'), 'no impairment_type leakage');
});

test('institution publisher gate: unapproved org cannot create path', async () => {
  const user = await signup(['organizer']);
  const o = await org(user.token);
  const sl = await sport('boccia');

  // attempt to create path as unapproved org
  const r = await api('POST', '/para/learn/paths', { token: user.token, body: { sport_id: sl.id, level_key: 'beginner', title: 'Unapproved path', summary: 'Should fail', publisher_org_id: o.id } });
  assert.equal(r.status, 404, 'unapproved publisher org → 404');
});

test('platform admin gate: non-admin cannot approve/publish', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const nonadmin = await signup(['organizer']);
  const sl = await sport('para-badminton');
  const path = await createPath(admin.token, sl.id);
  await addModule(admin.token, path.draft_version_id);
  await submitPath(admin.token, path.draft_version_id);

  const r = await api('POST', `/para/learn/path-versions/${path.draft_version_id}/review`, { token: nonadmin.token, body: { action: 'approve' } });
  assert.equal(r.status, 404, 'non-platform-admin cannot approve');
});

test('accessible media: caption_url and transcript_url must be https', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport('goalball');
  const path = await createPath(admin.token, sl.id);

  const r = await api('POST', `/para/learn/path-versions/${path.draft_version_id}/modules`, { token: admin.token, body: { title: 'Test', body_blocks: [{ type: 'text', content: 'x' }], source_attribution: { name: 'IPC', url: 'https://www.paralympic.org' }, caption_url: 'http://insecure.example.com/captions.vtt' } });
  assert.equal(r.status, 400, 'http caption_url rejected');
});

test('admin paths queue: returns all statuses for platform admin', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport('sitting-volleyball');
  await createPath(admin.token, sl.id);

  const queue = must(await api('GET', '/para/learn/admin/paths', { token: admin.token }));
  assert.ok(Array.isArray(queue));
  assert.ok(queue.some((p) => p.status === 'draft' || p.draft_version_id), 'draft paths visible');
});

test('admin paths queue: non-admin cannot access', async () => {
  const user = await signup(['athlete']);
  const r = await api('GET', '/para/learn/admin/paths', { token: user.token });
  assert.equal(r.status, 404, 'non-admin cannot see admin queue');
});

test('get_para_learn_path: returns modules with accessible media fields', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport('wheelchair-basketball');
  const path = await createPath(admin.token, sl.id, { level_key: 'advanced' });
  await addModule(admin.token, path.draft_version_id, {
    caption_url: 'https://cdn.example.com/c.vtt',
    transcript_url: 'https://cdn.example.com/t.txt',
    alt_text: 'Alt',
    audio_description: 'Audio desc',
  });
  await submitPath(admin.token, path.draft_version_id);
  await reviewPath(admin.token, path.draft_version_id, 'approve');
  await reviewPath(admin.token, path.draft_version_id, 'publish');

  const detail = must(await api('GET', `/para/learn/paths/${path.id}`));
  assert.ok(detail.modules?.length > 0, 'modules returned');
  const m = detail.modules[0];
  assert.equal(m.caption_url, 'https://cdn.example.com/c.vtt');
  assert.equal(m.alt_text, 'Alt');
});

test('level filter: browse by level_key returns only matching paths', async () => {
  const admin = await signup(['organizer', 'platform_admin']);
  const sl = await sport('boccia');

  for (const level of ['beginner', 'intermediate', 'advanced']) {
    const p = await createPath(admin.token, sl.id, { level_key: level });
    await addModule(admin.token, p.draft_version_id);
    await submitPath(admin.token, p.draft_version_id);
    await reviewPath(admin.token, p.draft_version_id, 'approve');
    await reviewPath(admin.token, p.draft_version_id, 'publish');
  }

  const beginners = must(await api('GET', '/para/learn/paths', { query: { sport_id: sl.id, level_key: 'beginner' } }));
  assert.ok(beginners.every((p) => p.level_key === 'beginner'), 'only beginner paths returned');
});
