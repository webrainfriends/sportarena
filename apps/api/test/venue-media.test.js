import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@/sportarena_test?host=/tmp';
process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'sa-media-'));
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/http.js');
const { embedFor } = await import('../src/capabilities/venue-media.js');

let server, base;
const api = async (method, path, { token, body, query } = {}) => {
  const r = await fetch(`${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const put = (venueId, bytes, { token, query } = {}) => fetch(`${base}/api/v1/venues/${venueId}/media${query ? `?${new URLSearchParams(query)}` : ''}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: bytes });
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
let n = 0;
const signup = async (roles = ['athlete']) => {
  n++;
  const r = await api('POST', '/auth/register', { body: { handle: `vm_${n}_${roles[0]}`, display_name: `VM ${n}`, email: `vm${n}@example.com`, password: 'correct-horse-battery', roles } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
};
const pad = (head, len = 600) => Buffer.concat([Buffer.from(head), Buffer.alloc(len, 7)]);
const JPEG = () => pad([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = () => pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const MP4 = () => pad([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test('venue media: upload (base64 + streaming), type sniffing, limits, serving with ranges, cover, order, soft remove', async () => {
  const mgr = await signup(['venue_manager']), other = await signup();
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: 'Media Arena', city: 'Pune' } }), 201);

  // permissions
  assert.equal((await put(v.id, JPEG())).status, 401);
  assert.equal((await put(v.id, JPEG(), { token: other.token })).status, 403);
  assert.equal((await api('POST', `/venues/${v.id}/media`, { token: other.token, body: { data: JPEG().toString('base64') } })).status, 403);

  // base64 capability: first upload becomes the cover
  const p1 = must(await api('POST', `/venues/${v.id}/media`, { token: mgr.token, body: { data: JPEG().toString('base64'), caption: 'Main court' } }), 201);
  assert.equal(p1.kind, 'photo');
  assert.equal(p1.content_type, 'image/jpeg');
  assert.equal(p1.is_cover, true);
  assert.match(p1.url, /^\/api\/v1\/media\//);

  // streaming PUT: png, then a video
  const r2 = await put(v.id, PNG(), { token: mgr.token, query: { caption: 'Lobby' } });
  assert.equal(r2.status, 201);
  const p2 = await r2.json();
  assert.equal(p2.content_type, 'image/png');
  assert.equal(p2.is_cover, false);
  const r3 = await put(v.id, MP4(), { token: mgr.token });
  const p3 = await r3.json();
  assert.equal(p3.kind, 'video');
  assert.equal(p3.content_type, 'video/mp4');

  // the type comes from the bytes, not from the client; scripts and SVG are refused
  assert.equal((await put(v.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(200, ' ')), { token: mgr.token })).status, 400);
  assert.equal((await put(v.id, Buffer.from('#!/bin/sh\nrm -rf /\n'.padEnd(200, '#')), { token: mgr.token })).status, 400);
  assert.equal((await put(v.id, Buffer.alloc(0), { token: mgr.token })).status, 400);
  assert.equal((await api('POST', `/venues/${v.id}/media`, { token: mgr.token, body: { data: Buffer.from('not an image at all, just text').toString('base64') } })).status, 400);
  // a photo over 10 MB is refused
  const big = Buffer.concat([JPEG(), Buffer.alloc(10 * 2 ** 20 + 10, 1)]);
  assert.equal((await put(v.id, big, { token: mgr.token })).status, 413);

  // serving: public, immutable, range-capable, cross-origin allowed for the web app
  const served = await fetch(`${base}${p1.url}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.match(served.headers.get('cache-control'), /immutable/);
  assert.equal(served.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(Buffer.compare(Buffer.from(await served.arrayBuffer()), JPEG()), 0);
  const part = await fetch(`${base}${p3.url}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await fetch(`${base}/api/v1/media/00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/media/../../etc/passwd`)).status, 404);

  // video links: only YouTube/Vimeo, normalised to embeds
  assert.equal(embedFor('https://youtu.be/dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(embedFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(embedFor('https://vimeo.com/123456789'), 'https://player.vimeo.com/video/123456789');
  assert.equal(embedFor('http://youtu.be/dQw4w9WgXcQ'), null);
  assert.equal(embedFor('https://evil.example/watch?v=dQw4w9WgXcQ'), null);
  const link = must(await api('POST', `/venues/${v.id}/media/link`, { token: mgr.token, body: { url: 'https://youtu.be/dQw4w9WgXcQ', caption: 'Tour' } }), 201);
  assert.equal(link.kind, 'video_link');
  assert.equal((await api('POST', `/venues/${v.id}/media/link`, { token: mgr.token, body: { url: 'https://evil.example/x' } })).status, 400);

  // public listing, cover first; venue + list carry media
  let list = must(await api('GET', `/venues/${v.id}/media`));
  assert.deepEqual(list.map((m) => m.id), [p1.id, p2.id, p3.id, link.id]);
  assert.match(must(await api('GET', `/venues/${v.id}`)).media[0].url, /^\/api\/v1\/media\//);
  assert.equal(must(await api('GET', '/venues', { query: { q: 'Media Arena' } }))[0].cover_url, p1.url);

  // cover, reorder, caption
  assert.equal(must(await api('PATCH', `/media/${p2.id}`, { token: mgr.token, body: { is_cover: true, caption: 'Lobby view' } })).is_cover, true);
  assert.equal((await api('PATCH', `/media/${link.id}`, { token: mgr.token, body: { is_cover: true } })).status, 400, 'a video link cannot be the cover');
  assert.equal((await api('PATCH', `/media/${p2.id}`, { token: other.token, body: { caption: 'x' } })).status, 403);
  must(await api('POST', `/venues/${v.id}/media/order`, { token: mgr.token, body: { ids: [link.id, p3.id, p2.id, p1.id] } }));
  list = must(await api('GET', `/venues/${v.id}/media`));
  assert.deepEqual(list.map((m) => m.id), [p2.id, link.id, p3.id, p1.id], 'cover first, then by position');
  assert.equal(list[0].caption, 'Lobby view');

  // removal is soft: hidden everywhere, file and row stay; the next photo becomes the cover
  const row = (await pool.query('SELECT file_name FROM venue_media WHERE id=$1', [p2.id])).rows[0];
  must(await api('DELETE', `/media/${p2.id}`, { token: mgr.token }));
  assert.equal((await fetch(`${base}${p2.url}`)).status, 404);
  assert.ok(existsSync(join(process.env.MEDIA_DIR, v.id, row.file_name)), 'file kept on disk');
  assert.ok((await pool.query('SELECT removed_at FROM venue_media WHERE id=$1', [p2.id])).rows[0].removed_at);
  list = must(await api('GET', `/venues/${v.id}/media`));
  assert.equal(list[0].id, p1.id);
  assert.equal(list[0].is_cover, true);
  assert.ok(readFileSync(join(process.env.MEDIA_DIR, v.id, row.file_name)).length > 0);
});

test('venue reviews: ratings, distribution, verified players, owner replies, notifications', async () => {
  const mgr = await signup(['venue_manager']);
  const v = must(await api('POST', '/venues', { token: mgr.token, body: { name: 'Review Arena', timezone: 'UTC' } }), 201);
  const court = must(await api('POST', `/venues/${v.id}/resources`, { token: mgr.token, body: { kind: 'court', name: 'C1', hourly_rate_cents: 1000 } }), 201);
  const [a, b, c] = [await signup(), await signup(), await signup()];
  const review = (u, rating, body) => api('POST', '/testimonials', { token: u.token, body: { subject_type: 'venue', subject_id: v.id, rating, body } });

  assert.equal((await review(mgr, 5, 'Best venue ever')).status, 400, 'the venue team cannot review its own venue');
  must(await review(a, 5, 'Brilliant floors'), 201);
  must(await review(b, 2, 'Too noisy'), 201);
  must(await review(c, 4, 'Good value'), 201);
  must(await review(c, 4, 'Still good value'), 201); // an edit, not a new review

  // only `a` has actually played there (a booking that has ended)
  const made = must(await api('POST', '/reservations', { token: a.token, body: { items: [{ resource_id: court.id, starts_at: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 13) + ':00:00.000Z', ends_at: new Date(Date.now() + 5 * 864e5 + 3600e3).toISOString().slice(0, 13) + ':00:00.000Z' }] } }), 201);
  await pool.query("UPDATE bookings SET starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' WHERE reservation_id=$1", [made.id]);

  const r = must(await api('GET', `/venues/${v.id}/reviews`, { token: a.token }));
  assert.equal(r.count, 3);
  assert.equal(r.average, 3.67);
  assert.deepEqual(r.distribution, { 5: 1, 4: 1, 3: 0, 2: 1, 1: 0 });
  assert.equal(r.my_review.rating, 5);
  assert.equal(r.can_manage, false);
  assert.equal(r.items.find((x) => x.author_id === a.id).verified, true);
  assert.equal(r.items.find((x) => x.author_id === b.id).verified, false);
  assert.equal(must(await api('GET', `/venues/${v.id}/reviews`, { query: { sort: 'lowest' } })).items[0].rating, 2);
  assert.equal(must(await api('GET', `/venues/${v.id}/reviews`, { query: { sort: 'highest' } })).items[0].rating, 5);
  assert.equal(must(await api('GET', `/venues/${v.id}/reviews`, { query: { sort: 'verified' } })).items[0].author_id, a.id);
  assert.equal(must(await api('GET', `/venues/${v.id}/reviews`, { query: { stars: '4' } })).items.length, 1);
  assert.equal(must(await api('GET', `/venues/${v.id}/reviews`, { token: mgr.token })).can_manage, true);

  // the team is told about new reviews (once per reviewer, not on edits) and can reply
  const inbox = must(await api('GET', '/notifications', { token: mgr.token })).items.filter((x) => x.kind === 'new_review');
  assert.equal(inbox.length, 3);
  const target = r.items.find((x) => x.author_id === b.id);
  assert.equal((await api('POST', `/reviews/${target.id}/reply`, { token: a.token, body: { body: 'Thanks!' } })).status, 403);
  must(await api('POST', `/reviews/${target.id}/reply`, { token: mgr.token, body: { body: 'Sorry about the noise — we have added sound panels.' } }));
  const after = must(await api('GET', `/venues/${v.id}/reviews`)).items.find((x) => x.id === target.id);
  assert.match(after.reply.body, /sound panels/);
  assert.equal(after.reply.by, mgr.display_name);
  assert.ok(must(await api('GET', '/notifications', { token: b.token })).items.some((x) => x.kind === 'review_reply'));
  const rating = must(await api('GET', `/venues/${v.id}`));
  assert.equal(rating.reviews, 3);
  assert.equal(rating.rating, 3.67);
});
