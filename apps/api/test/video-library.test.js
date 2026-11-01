import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { saveEncrypted } = await import('../src/doc-store.js');
const { capabilities } = await import('../src/registry.js');

let server, base;
const call = async (method, path, { token, body, raw } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type };
};
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await call('POST', '/auth/register', { body: { handle: `vl_${n}`, display_name: `Vl ${n}`, email: `vl${n}@example.com`, phone: '+911234567890', full_name: `Secret Name ${n}`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const post = (t, p, body) => call('POST', p, { token: t, body });
const get = (t, p) => call('GET', p, { token: t });
const patch = (t, p, body) => call('PATCH', p, { token: t, body });
const put = (t, p, body) => call('POST', p, { token: t, body });
const url = (u) => u.replace(/^\/api\/v1/, '');
const MP4 = (b = 1) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(40, b)]);
const YT = (id) => `https://www.youtube.com/watch?v=${id}`;
const upload = (t, qs, b) => call('PUT', `/me/passport-videos/upload?${qs}`, { token: t, raw: MP4(b) });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

const makeYouth = async () => {
  const parent = await signup(), kid = await signup();
  await pool.query('UPDATE users SET youth_until = current_date + 365 WHERE id=$1', [kid.id]);
  await pool.query("INSERT INTO guardian_links(guardian_id, child_id, relationship, status, requested_by) VALUES ($1,$2,'parent','active',$1)", [parent.id, kid.id]);
  return { parent, kid };
};

test('library: add by link and upload, edit with versions, idempotent retries, archive and restore, nothing deleted', async () => {
  const a = await signup(), b = await signup();
  const v = ok(await post(a.token, '/me/passport-videos', { title: 'Hat-trick', link_url: YT('dQw4w9WgXcQ'), visibility: 'private', description: 'Secret desc', client_key: 'k1' }), 201);
  const again = ok(await post(a.token, '/me/passport-videos', { title: 'Hat-trick', link_url: YT('dQw4w9WgXcQ'), client_key: 'k1' }), 201);
  assert.equal(again.id, v.id, 'a retry with the same client_key is the same clip');
  const up = ok(await upload(a.token, 'title=Clip&visibility=private&client_key=u1', 3), 201);
  assert.equal(ok(await upload(a.token, 'title=Clip&visibility=private&client_key=u1', 3)).id, up.id, 'upload retry is idempotent');
  assert.equal((await upload(a.token, 'title=Bad&visibility=nope', 4)).status, 400);

  const list = ok(await get(a.token, '/me/videos'));
  assert.equal(list.length, 2);
  const got = list.find((x) => x.id === v.id);
  assert.equal(got.description, 'Secret desc'); assert.equal(got.visibility, 'private'); assert.equal(got.source, 'link');
  const raw = await pool.query('SELECT description_enc FROM passport_videos WHERE id=$1', [v.id]);
  assert.ok(raw.rows[0].description_enc.startsWith('v'), 'description is stored encrypted'); assert.ok(!raw.rows[0].description_enc.includes('Secret'));
  assert.equal((await get(b.token, `/me/videos/${v.id}`)).status, 404, 'other people get 404');
  assert.equal((await patch(b.token, `/me/videos/${v.id}`, { version: 1, title: 'x' })).status, 404);

  const edited = ok(await patch(a.token, `/me/videos/${v.id}`, { version: got.version, title: 'Renamed' }));
  assert.equal(edited.title, 'Renamed');
  assert.equal((await patch(a.token, `/me/videos/${v.id}`, { version: got.version, title: 'Stale' })).status, 409, 'stale version refused');
  assert.equal((await patch(a.token, `/me/videos/${v.id}`, { version: edited.version })).status, 400, 'nothing to change');
  assert.equal((await patch(a.token, `/me/videos/${v.id}`, { version: edited.version, match_activity_id: 'game:00000000-0000-0000-0000-000000000000' })).status, 404, 'match must be one of yours');

  ok(await post(a.token, `/me/videos/${v.id}/archive`, { id: v.id }));
  ok(await post(a.token, `/me/videos/${v.id}/archive`, { id: v.id }));
  assert.equal(ok(await get(a.token, '/me/videos')).length, 1, 'archived clips are hidden');
  assert.equal(ok(await get(a.token, '/me/videos?include_archived=true')).length, 2);
  ok(await post(a.token, `/me/videos/${v.id}/archive`, { id: v.id, restore: true }));
  assert.equal((await pool.query('SELECT count(*)::int AS c FROM passport_videos WHERE user_id=$1 AND removed_at IS NULL', [a.id])).rows[0].c, 2, 'no row was deleted');
  const exp = ok(await get(a.token, '/me/video-library/export'));
  assert.equal(exp.format, 'sportarena.video-library.v1'); assert.equal(exp.videos.length, 2);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='export_video_library'", [a.id])).rows.length);
});

test('playlists: ordered, idempotent, version-checked; a playlist link shows only that playlist and dies with revoke, archive or unshare', async () => {
  const a = await signup();
  const v1 = ok(await upload(a.token, 'title=One&visibility=shared', 11), 201), v2 = ok(await upload(a.token, 'title=Two&visibility=private', 12), 201), v3 = ok(await upload(a.token, 'title=Three&visibility=shared', 13), 201);
  const pl = ok(await post(a.token, '/me/playlists', { title: 'Season reel', kind: 'highlight', description: 'best bits' }), 201);
  assert.equal(pl.videos.length, 0);
  const set1 = ok(await put(a.token, `/me/playlists/${pl.id}/videos`, { version: pl.version, video_ids: [v3.id, v1.id, v2.id] }));
  assert.deepEqual(set1.videos.map((x) => x.title), ['Three', 'One', 'Two']);
  assert.equal((await put(a.token, `/me/playlists/${pl.id}/videos`, { version: pl.version, video_ids: [v1.id] })).status, 409, 'stale playlist version');
  const set2 = ok(await put(a.token, `/me/playlists/${pl.id}/videos`, { version: set1.version, video_ids: [v1.id, v3.id, v2.id, v1.id] }));
  assert.deepEqual(set2.videos.map((x) => x.title), ['One', 'Three', 'Two'], 'duplicates ignored, order kept');
  assert.equal(ok(await get(a.token, `/me/videos?playlist_id=${pl.id}`)).length, 3);
  const stranger = await signup();
  assert.equal((await put(stranger.token, `/me/playlists/${pl.id}/videos`, { version: set2.version, video_ids: [] })).status, 404);
  assert.equal((await put(a.token, `/me/playlists/${pl.id}/videos`, { version: set2.version, video_ids: [stranger.id] })).status, 404, 'only your own clips');

  const link = ok(await post(a.token, '/me/passport-links', { playlist_id: pl.id, show_matches: true }), 201);
  assert.equal(link.playlist_id, pl.id); assert.equal(link.show_matches, false, 'a playlist link shows the playlist only');
  const open = async () => call('GET', `/passport/${encodeURIComponent(link.token)}`);
  let p = ok(await open());
  assert.deepEqual(p.videos.map((x) => x.title), ['One', 'Three'], 'the private clip is never shown');
  const file = await call('GET', url(p.videos[0].file_url));
  assert.equal(file.status, 200); assert.equal((await call('GET', `/passport/${encodeURIComponent(link.token)}/video/${v2.id}`)).status, 404, 'private clip file is 404');
  // unshare live
  const cur = ok(await get(a.token, `/me/videos/${v1.id}`));
  ok(await post(a.token, `/me/videos/${v1.id}/visibility`, { id: v1.id, version: cur.version, visibility: 'private' }));
  assert.deepEqual(ok(await open()).videos.map((x) => x.title), ['Three'], 'unsharing takes effect on the next read');
  assert.equal((await call('GET', `/passport/${encodeURIComponent(link.token)}/video/${v1.id}`)).status, 404);
  // archive a clip
  ok(await post(a.token, `/me/videos/${v3.id}/archive`, { id: v3.id }));
  assert.deepEqual(ok(await open()).videos, []);
  // archive the playlist -> a playlist link shows nothing from the playlist
  ok(await call('DELETE', `/me/playlists/${pl.id}`, { token: a.token }));
  assert.deepEqual(ok(await open()).videos, []);
  // revoke
  const l2 = ok(await post(a.token, '/me/passport-links', { show_video: true }), 201);
  ok(await post(a.token, `/me/passport-links/${l2.id}/revoke`, {}));
  assert.equal((await call('GET', `/passport/${encodeURIComponent(l2.token)}`)).status, 404);
  assert.equal((await post(a.token, '/me/passport-links', { playlist_id: pl.id })).status, 404, 'an archived playlist cannot be shared');
});

test('existing passport behaviour is kept: a coach-approved clip still reaches a passport link, a private one never does', async () => {
  const coach = await signup(['coach']), a = await signup();
  const team = ok(await post(coach.token, '/teams', { name: `Vl FC ${n}`, sport: 'football' }), 201);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'coach','active') ON CONFLICT (team_id, user_id) DO UPDATE SET role='coach', status='active'", [team.id, coach.id]);
  await pool.query("INSERT INTO team_members(team_id, user_id, role, status) VALUES ($1,$2,'player','active')", [team.id, a.id]);
  const shared = ok(await post(a.token, '/me/passport-videos', { title: 'Old style', link_url: YT('aaaaaaaaaaa') }), 201);
  const priv = ok(await post(a.token, '/me/passport-videos', { title: 'Mine only', link_url: YT('bbbbbbbbbbb'), visibility: 'private' }), 201);
  const queue = ok(await get(coach.token, '/coach/passport-videos'));
  assert.deepEqual(queue.map((x) => x.id), [shared.id], 'private clips are not in the review queue');
  ok(await post(coach.token, `/passport-videos/${shared.id}/review`, { version: 1, decision: 'approved' }));
  const link = ok(await post(a.token, '/me/passport-links', { show_video: true }), 201);
  assert.deepEqual(ok(await call('GET', `/passport/${encodeURIComponent(link.token)}`)).videos.map((x) => x.title), ['Old style']);
  const staff = ok(await get(coach.token, `/athletes/${a.id}/videos`));
  assert.deepEqual(staff.map((x) => x.title), ['Old style'], 'staff see shared clips only');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='read_athlete_videos'", [coach.id])).rows.length, 'staff reads are audited');
  assert.equal((await get((await signup(['coach'])).token, `/athletes/${a.id}/videos`)).status, 404);
  const up = ok(await upload(a.token, 'title=PrivFile&visibility=private', 21), 201);
  assert.equal((await call('GET', `/passport-videos/${up.id}/file`, { token: coach.token })).status, 404, 'a coach cannot open a private file');
  assert.equal((await call('GET', `/passport-videos/${up.id}/file`, { token: a.token })).status, 200);
  assert.equal(priv.status, 'pending');
});

test('public showcase: publishing is the player\'s choice, takedown is immediate, a young person needs live guardian media consent', async () => {
  const a = await signup();
  const v = ok(await upload(a.token, 'title=Goal&visibility=private', 31), 201);
  assert.deepEqual(ok(await call('GET', `/players/${a.handle}/showcase`)).videos, [], 'private by default');
  const cur = ok(await get(a.token, `/me/videos/${v.id}`));
  const pub = ok(await post(a.token, `/me/videos/${v.id}/visibility`, { id: v.id, version: cur.version, visibility: 'public' }));
  assert.ok(pub.published_at);
  assert.equal((await post(a.token, `/me/videos/${v.id}/visibility`, { id: v.id, version: cur.version, visibility: 'private' })).status, 409, 'stale');
  const show = ok(await call('GET', `/players/${a.handle}/showcase`));
  assert.equal(show.videos.length, 1);
  assert.equal(JSON.stringify(show).includes('email'), false, 'no personal identification data');
  assert.equal((await call('GET', url(show.videos[0].file_url))).status, 200);
  ok(await post(a.token, `/me/videos/${v.id}/visibility`, { id: v.id, version: pub.version, visibility: 'private' }));
  assert.deepEqual(ok(await call('GET', `/players/${a.handle}/showcase`)).videos, []);
  assert.equal((await call('GET', url(show.videos[0].file_url))).status, 404, 'file closes with the unpublish');
  assert.equal((await call('GET', '/players/nobody_here/showcase')).status, 404);

  const { parent, kid } = await makeYouth();
  const kv = ok(await upload(kid.token, 'title=Kid&visibility=private', 41), 201);
  const kc = ok(await get(kid.token, `/me/videos/${kv.id}`));
  assert.equal((await post(kid.token, `/me/videos/${kv.id}/visibility`, { id: kv.id, version: kc.version, visibility: 'public' })).status, 409, 'no guardian consent, no publishing');
  ok(await post(parent.token, `/youth/children/${kid.id}/consents`, { child_id: kid.id, purpose: 'media' }), 201);
  const kp = ok(await post(kid.token, `/me/videos/${kv.id}/visibility`, { id: kv.id, version: kc.version, visibility: 'public' }));
  assert.equal(ok(await call('GET', `/players/${kid.handle}/showcase`)).videos.length, 1);
  const pl = ok(await post(kid.token, '/me/playlists', { title: 'Kid reel' }), 201);
  ok(await put(kid.token, `/me/playlists/${pl.id}/videos`, { version: pl.version, video_ids: [kv.id] }));
  // a guardian shares via the existing guardian-arranged link
  ok(await post(parent.token, `/youth/children/${kid.id}/consents`, { child_id: kid.id, purpose: 'recruitment_sharing' }), 201);
  const link = ok(await post(parent.token, '/me/passport-links', { athlete_id: kid.id, show_video: true }), 201);
  assert.equal((await post(parent.token, `/me/videos/${kv.id}/visibility`, { id: kv.id, version: kp.version, visibility: 'public', athlete_id: kid.id })).status, 403, 'a guardian can only take down');
  // withdraw media consent: showcase, export-free reads and file all stop with no change to the clip
  await pool.query("UPDATE youth_consents SET revoked_at=now() WHERE child_id=$1 AND purpose='media'", [kid.id]);
  assert.equal((await call('GET', `/players/${kid.handle}/showcase`)).status, 404, 'revocation is live');
  assert.equal((await call('GET', `/showcase/${kid.handle}/video/${kv.id}`)).status, 404);
  assert.equal((await post(parent.token, '/me/passport-links', { athlete_id: kid.id, playlist_id: pl.id })).status, 409, 'media consent needed for a playlist link');
  assert.ok((await pool.query('SELECT 1 FROM passport_videos WHERE id=$1 AND removed_at IS NULL', [kv.id])).rows.length, 'the clip itself is kept');
  // guardian takedown
  ok(await post(parent.token, `/youth/children/${kid.id}/consents`, { child_id: kid.id, purpose: 'media' }), 201);
  const back = ok(await post(parent.token, `/me/videos/${kv.id}/visibility`, { id: kv.id, version: kp.version, visibility: 'private', athlete_id: kid.id }));
  assert.equal(back.visibility, 'private');
  assert.equal((await post((await signup()).token, `/me/videos/${kv.id}/visibility`, { id: kv.id, version: back.version, visibility: 'private', athlete_id: kid.id })).status, 404);
  assert.ok(link.token);
});

test('promote a coaching video: only the player, only a note shared with them, starts private, keeps provenance, never duplicates', async () => {
  const coach = await signup(['coach']), a = await signup(), other = await signup();
  const { id: eid, file } = await saveEncrypted('coaching', 'coaching_evidence.file', MP4(51));
  const note = async (visibility) => (await pool.query("INSERT INTO coaching_observations(coach_id, athlete_id, note, visibility) VALUES ($1,$2,'Great run','" + visibility + "') RETURNING id", [coach.id, a.id])).rows[0].id;
  const priv = await note('coach_private'), shared = await note('player');
  const ev = async (oid) => (await pool.query("INSERT INTO coaching_evidence(observation_id, uploaded_by, kind, content_type, file_name, title, size_bytes, sha256) VALUES ($1,$2,'video','video/mp4',$3,'Run',48,'x') RETURNING id", [oid, coach.id, file])).rows[0].id;
  const e1 = await ev(priv), e2 = await ev(shared);
  assert.deepEqual(ok(await get(a.token, '/me/coaching-videos')).map((x) => x.id), [e2], 'only clips on notes shared with the player');
  assert.equal((await post(a.token, '/me/videos/from-coaching', { evidence_id: e1 })).status, 404, 'a private coach note is not the player\'s to copy');
  assert.equal((await post(other.token, '/me/videos/from-coaching', { evidence_id: e2 })).status, 404);
  assert.equal((await post(coach.token, '/me/videos/from-coaching', { evidence_id: e2 })).status, 404, 'not even the coach');
  const c = ok(await post(a.token, '/me/videos/from-coaching', { evidence_id: e2 }), 201);
  assert.deepEqual(ok(await get(a.token, '/me/coaching-videos')), [], 'a copied clip leaves the list');
  assert.equal(c.visibility, 'private'); assert.equal(c.source, 'coaching_evidence'); assert.equal(c.title, 'Run');
  assert.equal(ok(await post(a.token, '/me/videos/from-coaching', { evidence_id: e2 }), 201).id, c.id, 'repeat returns the same clip');
  assert.equal((await call('GET', `/passport-videos/${c.id}/file`, { token: a.token })).status, 200);
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE actor_id=$1 AND action='promote_coaching_video'", [a.id])).rows.length);
  await pool.query("UPDATE coaching_observations SET visibility='coach_private' WHERE id=$1", [shared]);
  assert.equal((await post(a.token, '/me/videos/from-coaching', { evidence_id: e2 })).status, 201, 'an existing copy is the player\'s own and is kept');
});

test('REST, OpenAPI and MCP share every video-library capability', async () => {
  const names = ['list_my_videos', 'get_my_video', 'update_my_video', 'set_my_video_visibility', 'archive_my_video', 'promote_coaching_video', 'list_my_playlists', 'get_my_playlist', 'create_playlist', 'update_playlist', 'set_playlist_videos', 'archive_playlist', 'get_player_showcase', 'list_athlete_videos', 'export_my_video_library'];
  for (const nm of names) assert.ok(capabilities.find((c) => c.name === nm), nm);
  const spec = ok(await call('GET', '/openapi.json'));
  const paths = JSON.stringify(Object.keys(spec.paths));
  for (const p of ['/me/videos', '/me/videos/{id}/visibility', '/me/playlists', '/players/{handle}/showcase']) assert.ok(paths.includes(p), p);
});

test('every sport in the catalogue can carry a clip', async () => {
  const a = await signup();
  const sports = ok(await get(a.token, '/sports'));
  assert.ok(sports.length > 5);
  for (const s of sports.slice(0, 50)) ok(await post(a.token, '/me/passport-videos', { title: `Clip ${s.slug}`.slice(0, 120), link_url: YT(`s${String(sports.indexOf(s)).padStart(10, '0')}`), sport_slug: s.slug, visibility: 'private' }).then((r) => r), 201).id;
  assert.equal(ok(await get(a.token, '/me/videos?limit=100')).length, Math.min(sports.length, 50));
});
