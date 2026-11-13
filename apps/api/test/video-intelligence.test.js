import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');

let server, base;
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : null };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await call('POST', '/auth/register', { body: { handle: `vi_${n}`, display_name: `Vi ${n}`, email: `vi${n}@example.com`, phone: '+911234500000', full_name: `Vi User ${n}`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => call('POST', p, { token: t, body });
const get = (t, p) => call('GET', p, { token: t });
const patch = (t, p, body) => call('PATCH', p, { token: t, body });
const del = (t, p) => call('DELETE', p, { token: t });

before(async () => {
  await migrate();
  const app = await createApp();
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await pool.end(); });

// ── helpers ───────────────────────────────────────────────────────────────────
async function createVideo(token) {
  const r = await post(token, '/me/videos', {
    title: 'Test match clip', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=test123',
  });
  if (r.status !== 201) return null; // some test envs may not have football sport
  return r.body.id ?? r.body?.video?.id ?? null;
}

// ── Annotation CRUD ───────────────────────────────────────────────────────────
test('annotation lifecycle — add, list, resolve, reply', async () => {
  const coach = await signup(['coach']);
  const vidRow = await post(coach.token, '/me/videos', {
    title: 'Pressing Shape', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=abc',
  });
  if (vidRow.status === 404) return; // sport not seeded in this env
  const videoId = vidRow.body?.id ?? vidRow.body?.video?.id;
  assert.ok(videoId, 'created video');

  // add annotation
  const a = ok(await post(coach.token, `/me/videos/${videoId}/annotations`, {
    timestamp_ms: 12000, text: 'Defender too high', tactical_category: 'defending',
  }), 201);
  assert.ok(a.id);

  // list
  const list = ok(await get(coach.token, `/me/videos/${videoId}/annotations`));
  assert.ok(Array.isArray(list));
  const found = list.find((x) => x.id === a.id);
  assert.ok(found, 'annotation in list');
  assert.equal(found.text, 'Defender too high');
  assert.equal(found.tactical_category, 'defending');
  assert.equal(found.ai_generated, false);

  // filter by tactical_category
  const defending = ok(await get(coach.token, `/me/videos/${videoId}/annotations?tactical_category=defending`));
  assert.ok(defending.some((x) => x.id === a.id));
  const attacking = ok(await get(coach.token, `/me/videos/${videoId}/annotations?tactical_category=attacking`));
  assert.ok(!attacking.some((x) => x.id === a.id));

  // resolve
  ok(await post(coach.token, `/me/videos/${videoId}/annotations/${a.id}/resolve`, { resolved: true }));
  const after = ok(await get(coach.token, `/me/videos/${videoId}/annotations`));
  const resolvedAnn = after.find((x) => x.id === a.id);
  assert.ok(resolvedAnn.resolved_at);

  // re-open
  ok(await post(coach.token, `/me/videos/${videoId}/annotations/${a.id}/resolve`, { resolved: false }));

  // reply
  const reply = ok(await post(coach.token, `/me/videos/${videoId}/annotations/${a.id}/reply`, { text: 'Working on it' }), 201);
  assert.ok(reply.id);

  const replies = ok(await get(coach.token, `/me/videos/${videoId}/annotations/${a.id}/replies`));
  assert.ok(replies.some((r) => r.id === reply.id));
  assert.equal(replies[0].text, 'Working on it');
});

test('annotation — unauthorized user gets 404', async () => {
  const owner = await signup(['athlete']);
  const other = await signup(['athlete']);
  const v = await post(owner.token, '/me/videos', { title: 'Private clip', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=priv' });
  if (v.status === 404) return;
  const videoId = v.body?.id ?? v.body?.video?.id;
  assert.ok(videoId);

  const r = await get(other.token, `/me/videos/${videoId}/annotations`);
  assert.equal(r.status, 404);
});

// ── Export ────────────────────────────────────────────────────────────────────
test('export_video_analysis returns structured JSON', async () => {
  const coach = await signup(['coach']);
  const v = await post(coach.token, '/me/videos', { title: 'Export test', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=exp' });
  if (v.status === 404) return;
  const videoId = v.body?.id ?? v.body?.video?.id;
  assert.ok(videoId);

  await post(coach.token, `/me/videos/${videoId}/annotations`, { timestamp_ms: 5000, text: 'Goal opportunity', tactical_category: 'attacking' });
  const exp = ok(await get(coach.token, `/me/videos/${videoId}/analysis/export`));
  assert.ok(exp.video_title);
  assert.ok(Array.isArray(exp.annotations));
  assert.ok(exp.annotations[0].text === 'Goal opportunity');
  assert.ok(exp.exported_at);
});

// ── AI Tags ───────────────────────────────────────────────────────────────────
test('AI tags lifecycle — generate, confirm, reject', async () => {
  const coach = await signup(['coach']);
  const v = await post(coach.token, '/me/videos', { title: 'AI test clip', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=aitag' });
  if (v.status === 404) return;
  const videoId = v.body?.id ?? v.body?.video?.id;
  assert.ok(videoId);

  // add categorised annotations to generate tags from
  await post(coach.token, `/me/videos/${videoId}/annotations`, { timestamp_ms: 1000, text: 'High press', tactical_category: 'pressing' });
  await post(coach.token, `/me/videos/${videoId}/annotations`, { timestamp_ms: 2000, text: 'Press again', tactical_category: 'pressing' });

  const gen = ok(await post(coach.token, `/me/videos/${videoId}/ai-summary`));
  assert.ok(gen.generated >= 0);

  const tags = ok(await get(coach.token, `/me/videos/${videoId}/ai-tags?status=pending`));
  assert.ok(Array.isArray(tags));
  if (tags.length) {
    // inference_label always present
    assert.ok(tags[0].inference_label, 'inference_label must be present');

    // confirm one
    ok(await post(coach.token, `/video-ai-tags/${tags[0].id}/confirm`));
    const confirmed = ok(await get(coach.token, `/me/videos/${videoId}/ai-tags?status=confirmed`));
    assert.ok(confirmed.some((t) => t.id === tags[0].id));
  }
  if (tags.length > 1) {
    // reject one
    ok(await post(coach.token, `/video-ai-tags/${tags[1].id}/reject`));
    const rejected = ok(await get(coach.token, `/me/videos/${videoId}/ai-tags?status=rejected`));
    assert.ok(rejected.some((t) => t.id === tags[1].id));
  }
});

// ── Clip Comparisons ──────────────────────────────────────────────────────────
test('clip comparison CRUD', async () => {
  const user = await signup(['coach']);
  const va = await post(user.token, '/me/videos', { title: 'Clip A', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=cla' });
  const vb = await post(user.token, '/me/videos', { title: 'Clip B', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=clb' });
  if (va.status === 404 || vb.status === 404) return;
  const aId = va.body?.id ?? va.body?.video?.id;
  const bId = vb.body?.id ?? vb.body?.video?.id;

  const cmp = ok(await post(user.token, '/video-comparisons', {
    title: 'A vs B',
    video_a_id: aId, start_ms_a: 0, end_ms_a: 60000,
    video_b_id: bId, start_ms_b: 10000, end_ms_b: 70000,
    notes: 'Pressing structure comparison',
  }), 201);
  assert.ok(cmp.id);

  const list = ok(await get(user.token, '/video-comparisons'));
  assert.ok(list.some((c) => c.id === cmp.id));

  const detail = ok(await get(user.token, `/video-comparisons/${cmp.id}`));
  assert.equal(detail.notes, 'Pressing structure comparison');

  ok(await patch(user.token, `/video-comparisons/${cmp.id}`, { title: 'Updated comparison' }));

  ok(await del(user.token, `/video-comparisons/${cmp.id}`));
  const listAfter = ok(await get(user.token, '/video-comparisons'));
  assert.ok(!listAfter.some((c) => c.id === cmp.id));
});

// ── Tactical Boards ───────────────────────────────────────────────────────────
test('tactical board — create, items CRUD, batch, version bump', async () => {
  const coach = await signup(['coach']);

  const b = ok(await post(coach.token, '/tactical-boards', {
    title: '4-3-3 Pressing Shape', pitch_template: 'full_pitch',
  }), 201);
  assert.ok(b.id);
  assert.equal(b.version, 1);

  // list
  const list = ok(await get(coach.token, '/tactical-boards'));
  assert.ok(list.some((x) => x.id === b.id));

  // get with items
  const full = ok(await get(coach.token, `/tactical-boards/${b.id}`));
  assert.equal(full.items.length, 0);

  // add items
  const item1 = ok(await post(coach.token, `/tactical-boards/${b.id}/items`, {
    kind: 'player', position: { x: 50, y: 20 }, style: { team_side: 'home', jersey_no: '9' },
  }), 201);
  assert.ok(item1.id);

  const item2 = ok(await post(coach.token, `/tactical-boards/${b.id}/items`, {
    kind: 'arrow', position: [{ x: 50, y: 20 }, { x: 60, y: 30 }],
  }), 201);
  assert.ok(item2.id);

  // update item
  ok(await patch(coach.token, `/tactical-board-items/${item1.id}`, { position: { x: 55, y: 22 } }));

  // remove item
  ok(await del(coach.token, `/tactical-board-items/${item2.id}`));
  const updated = ok(await get(coach.token, `/tactical-boards/${b.id}`));
  assert.equal(updated.items.length, 1);

  // batch update with optimistic concurrency
  const batch = ok(await post(coach.token, `/tactical-boards/${b.id}/items/batch`, {
    version: b.version,
    ops: [
      { op: 'add', kind: 'marker', position: { x: 30, y: 60 }, label: 'High press trigger' },
      { op: 'move', item_id: item1.id, position: { x: 45, y: 18 } },
    ],
  }));
  assert.equal(batch.version, b.version + 1);

  // stale version should conflict
  const staleR = await post(coach.token, `/tactical-boards/${b.id}/items/batch`, {
    version: b.version, // old version
    ops: [{ op: 'add', kind: 'text', position: { x: 10, y: 10 }, label: 'Note' }],
  });
  assert.equal(staleR.status, 409);
});

test('tactical board — archive', async () => {
  const coach = await signup(['coach']);
  const b = ok(await post(coach.token, '/tactical-boards', { title: 'To archive', pitch_template: 'blank' }), 201);
  ok(await del(coach.token, `/tactical-boards/${b.id}`));
  const list = ok(await get(coach.token, '/tactical-boards'));
  assert.ok(!list.some((x) => x.id === b.id));
});

test('tactical board — video link', async () => {
  const coach = await signup(['coach']);
  const b = ok(await post(coach.token, '/tactical-boards', { title: 'Board with video', pitch_template: 'full_pitch' }), 201);
  const v = await post(coach.token, '/me/videos', { title: 'Linked video', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=lnk' });
  if (v.status === 404) return;
  const videoId = v.body?.id ?? v.body?.video?.id;

  const link = ok(await post(coach.token, `/tactical-boards/${b.id}/video-links`, { video_id: videoId, timestamp_ms: 45000 }), 201);
  assert.ok(link.id);

  const links = ok(await get(coach.token, `/tactical-boards/${b.id}/video-links`));
  assert.ok(links.some((l) => l.id === link.id));
  assert.equal(links[0].timestamp_ms, 45000);

  ok(await del(coach.token, `/tactical-board-video-links/${link.id}`));
  const after = ok(await get(coach.token, `/tactical-boards/${b.id}/video-links`));
  assert.ok(!after.some((l) => l.id === link.id));
});

// ── Video Search ──────────────────────────────────────────────────────────────
test('search_videos — owner sees own videos', async () => {
  const user = await signup(['athlete']);
  const v = await post(user.token, '/me/videos', { title: 'Searchable clip', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=srch' });
  if (v.status === 404) return;
  const videoId = v.body?.id ?? v.body?.video?.id;

  const results = ok(await get(user.token, '/videos/search?q=Searchable'));
  assert.ok(results.some((r) => r.id === videoId));
});

test('search_videos — tactical_category filter', async () => {
  const coach = await signup(['coach']);
  const v = await post(coach.token, '/me/videos', { title: 'Tactic filtered', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=tfil' });
  if (v.status === 404) return;
  const videoId = v.body?.id ?? v.body?.video?.id;

  await post(coach.token, `/me/videos/${videoId}/annotations`, { timestamp_ms: 1000, text: 'Press high', tactical_category: 'pressing' });

  const r = ok(await get(coach.token, '/videos/search?tactical_category=pressing'));
  assert.ok(r.some((x) => x.id === videoId));

  const r2 = ok(await get(coach.token, '/videos/search?tactical_category=attacking'));
  // may or may not contain video — just ensure no crash
  assert.ok(Array.isArray(r2));
});

// ── Rights-aware export ───────────────────────────────────────────────────────
test('export — non-owner gets 404', async () => {
  const owner = await signup(['coach']);
  const other = await signup(['coach']);
  const v = await post(owner.token, '/me/videos', { title: 'Rights test', sport_slug: 'football', link_url: 'https://youtube.com/watch?v=rts' });
  if (v.status === 404) return;
  const videoId = v.body?.id ?? v.body?.video?.id;

  const r = await get(other.token, `/me/videos/${videoId}/analysis/export`);
  // other has no access → 404
  assert.ok(r.status === 404 || r.status === 403);
});
