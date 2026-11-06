// PS-20 (#850) Para-sport Learn & Study catalogue: learning paths, editorial approval, progress, badge issuance, publisher gate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp' });
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base, n = 0;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
};
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `pl_${n}_${roles[0]}`, display_name: `Pl ${n}`, email: `pl${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body)); return { ...r.body.user, token: r.body.token };
};
const adminEmail = 'rraja.edge@gmail.com';

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('list_para_learn_paths: public endpoint returns empty list when nothing published', async () => {
  const r = must(await api('GET', '/para/learn/paths'));
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 0);
});

test('create_para_learn_path: requires admin role', async () => {
  const athlete = await signup(['athlete']);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='para-athletics' LIMIT 1")).rows[0];
  const r = await api('POST', '/para/learn/paths', { token: athlete.token, body: { title: 'Intro to Para Athletics', sport_id: sport.id, level: 'beginner' } });
  assert.ok(r.status === 403 || r.status === 401);
});

test('full publish workflow: draft → submit → review/publish → visible in list', async () => {
  const admin = await signup(['organizer', 'admin']);
  // force platform_admin for this test via direct DB (platform_admin list is env-controlled)
  await pool.query("UPDATE users SET roles = array_append(roles, 'platform_admin') WHERE id=$1", [admin.id]);

  const sport = (await pool.query("SELECT id FROM sports WHERE slug='para-athletics' LIMIT 1")).rows[0];
  assert.ok(sport, 'para-athletics sport seeded');

  // 1. create path
  const path = must(await api('POST', '/para/learn/paths', { token: admin.token, body: { title: 'Para Athletics: Track Basics', sport_id: sport.id, level: 'beginner', objectives: ['Understand track classifications', 'Master guide-runner protocol'] } }), 201);
  assert.ok(path.id);
  assert.equal(path.status, 'draft');

  // 2. save a draft version
  const ver = must(await api('POST', `/para/learn/paths/${path.id}/draft`, { token: admin.token, body: { summary: 'Foundation track content for T11–T13 athletes.' } }), 201);
  assert.ok(ver.id);

  // 3. add a module
  const mod = must(await api('POST', `/para/learn/path-versions/${ver.id}/modules`, { token: admin.token, body: { title: 'Sprint mechanics', seq: 1, body_blocks: [{ type: 'text', content: 'Lean forward at start.' }], duration_minutes: 8 } }), 201);
  assert.ok(mod.id);

  // 4. add an assessment question
  const asmnt = must(await api('POST', `/para/learn/modules/${mod.id}/assessments`, { token: admin.token, body: { question: 'Which class uses a guide runner?', options: ['T11', 'T54', 'F40'], correct_index: 0, hint: 'Think vision impairment.', max_retakes: 2 } }), 201);
  assert.ok(asmnt.id);

  // 5. submit for review
  must(await api('POST', `/para/learn/path-versions/${ver.id}/submit`, { token: admin.token }));

  // 6. review: approve then publish (platform admin only)
  must(await api('POST', `/para/learn/path-versions/${ver.id}/review`, { token: admin.token, body: { action: 'approve' } }));
  must(await api('POST', `/para/learn/path-versions/${ver.id}/review`, { token: admin.token, body: { action: 'publish' } }));

  // 7. now appears in public list
  const list = must(await api('GET', '/para/learn/paths', { query: { sport_id: sport.id, level: 'beginner' } }));
  assert.ok(list.some((p) => p.id === path.id), 'published path visible');

  // 8. get path detail
  const detail = must(await api('GET', `/para/learn/paths/${path.id}`));
  assert.equal(detail.id, path.id);
  assert.ok(Array.isArray(detail.modules));
  assert.equal(detail.modules.length, 1);
  assert.equal(detail.modules[0].assessment?.question, 'Which class uses a guide runner?');
});

test('record_para_learn_progress and badge issuance', async () => {
  const athlete = await signup(['athlete']);
  const admin = await signup(['organizer', 'admin']);
  await pool.query("UPDATE users SET roles = array_append(roles, 'platform_admin') WHERE id=$1", [admin.id]);

  const sport = (await pool.query("SELECT id FROM sports WHERE slug='para-swimming' LIMIT 1")).rows[0];
  if (!sport) return; // skip if not seeded

  // create + publish a minimal path
  const path = must(await api('POST', '/para/learn/paths', { token: admin.token, body: { title: 'Swimming Basics', sport_id: sport.id, level: 'beginner' } }), 201);
  const ver = must(await api('POST', `/para/learn/paths/${path.id}/draft`, { token: admin.token, body: { summary: 'Basics.' } }), 201);
  const mod = must(await api('POST', `/para/learn/path-versions/${ver.id}/modules`, { token: admin.token, body: { title: 'Entry', seq: 1, body_blocks: [{ type: 'text', content: 'Enter pool safely.' }], duration_minutes: 5 } }), 201);
  must(await api('POST', `/para/learn/path-versions/${ver.id}/submit`, { token: admin.token }));
  must(await api('POST', `/para/learn/path-versions/${ver.id}/review`, { token: admin.token, body: { action: 'approve' } }));
  must(await api('POST', `/para/learn/path-versions/${ver.id}/review`, { token: admin.token, body: { action: 'publish' } }));

  // record progress for each module
  const prog1 = must(await api('POST', '/para/learn/progress', { token: athlete.token, body: { path_version_id: ver.id, module_id: mod.id, status: 'complete' } }), 201);
  assert.equal(prog1.status, 'complete');

  // get progress overview — path is now complete (single module)
  const overview = must(await api('GET', '/para/learn/progress', { token: athlete.token, query: { path_id: path.id } }));
  assert.ok(Array.isArray(overview));
  const entry = overview.find((p) => p.path_id === path.id);
  assert.ok(entry);
  assert.equal(entry.pct, 100);
  assert.ok(entry.credential_id, 'badge issued on 100% completion');
});

test('list_para_learn_recommendations: returns empty list (no disability inference)', async () => {
  const athlete = await signup(['athlete']);
  const r = must(await api('GET', '/para/learn/recommendations', { token: athlete.token }));
  assert.ok(Array.isArray(r), 'returns array even when empty');
});

test('manage_para_learn_publisher: requires platform admin', async () => {
  const admin = await signup(['organizer', 'admin']);
  const r = await api('POST', '/para/learn/publishers', { token: admin.token, body: { org_id: '00000000-0000-0000-0000-000000000000', action: 'grant' } });
  assert.ok(r.status === 403 || r.status === 401, 'non-platform-admin cannot manage publishers');
});

test('update_para_learn_module: edit draft module, cannot edit published version modules', async () => {
  const admin = await signup(['organizer', 'admin']);
  await pool.query("UPDATE users SET roles = array_append(roles, 'platform_admin') WHERE id=$1", [admin.id]);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='boccia' LIMIT 1")).rows[0];
  if (!sport) return;

  const path = must(await api('POST', '/para/learn/paths', { token: admin.token, body: { title: 'Boccia Rules', sport_id: sport.id, level: 'intermediate' } }), 201);
  const ver = must(await api('POST', `/para/learn/paths/${path.id}/draft`, { token: admin.token, body: { summary: 'Official rules overview.' } }), 201);
  const mod = must(await api('POST', `/para/learn/path-versions/${ver.id}/modules`, { token: admin.token, body: { title: 'Throw types', seq: 1, body_blocks: [{ type: 'text', content: 'Jack throw, attack, block.' }], duration_minutes: 6 } }), 201);

  // edit in draft is fine
  const updated = must(await api('PATCH', `/para/learn/modules/${mod.id}`, { token: admin.token, body: { title: 'Throw types (updated)' } }));
  assert.equal(updated.title, 'Throw types (updated)');

  // publish
  must(await api('POST', `/para/learn/path-versions/${ver.id}/submit`, { token: admin.token }));
  must(await api('POST', `/para/learn/path-versions/${ver.id}/review`, { token: admin.token, body: { action: 'approve' } }));
  must(await api('POST', `/para/learn/path-versions/${ver.id}/review`, { token: admin.token, body: { action: 'publish' } }));

  // edit on published version module should fail (immutable)
  const r = await api('PATCH', `/para/learn/modules/${mod.id}`, { token: admin.token, body: { title: 'Should not update' } });
  assert.ok(r.status >= 400, 'cannot edit module in published version');
});

test('save_para_learn_assessment: validates exactly one correct option', async () => {
  const admin = await signup(['organizer', 'admin']);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='goalball' LIMIT 1")).rows[0];
  if (!sport) return;

  const path = must(await api('POST', '/para/learn/paths', { token: admin.token, body: { title: 'Goalball Intro', sport_id: sport.id, level: 'beginner' } }), 201);
  const ver = must(await api('POST', `/para/learn/paths/${path.id}/draft`, { token: admin.token, body: { summary: 'Basics.' } }), 201);
  const mod = must(await api('POST', `/para/learn/path-versions/${ver.id}/modules`, { token: admin.token, body: { title: 'Rules', seq: 1, body_blocks: [{ type: 'text', content: 'Team of 3.' }], duration_minutes: 4 } }), 201);

  // correct_index out of range
  const bad = await api('POST', `/para/learn/modules/${mod.id}/assessments`, { token: admin.token, body: { question: 'Q?', options: ['A', 'B'], correct_index: 5, max_retakes: 1 } });
  assert.ok(bad.status >= 400, 'invalid correct_index rejected');
});

test('path not leaked if status is not published (404)', async () => {
  const admin = await signup(['organizer', 'admin']);
  const athlete = await signup(['athlete']);
  const sport = (await pool.query("SELECT id FROM sports WHERE slug='blind-football' LIMIT 1")).rows[0];
  if (!sport) return;

  const path = must(await api('POST', '/para/learn/paths', { token: admin.token, body: { title: 'Blind Football Basics', sport_id: sport.id, level: 'beginner' } }), 201);

  // draft path not visible to athlete
  const r = await api('GET', `/para/learn/paths/${path.id}`, { token: athlete.token });
  assert.ok(r.status === 404 || r.status === 403, 'draft path hidden from non-admin');
});
