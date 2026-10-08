// Venue media storage on the server's persistent disk. Files are written once under a server-generated name, their type is
// decided from the bytes (never from the client), and rows are retired with removed_at — files are never deleted.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { authenticate } from './auth.js';
import { one, query } from './db.js';
import { AppError, badRequest, notFound, unauthorized } from './errors.js';
import { toErrorBody } from './invoke.js';
import { mustManage } from './booking/engine.js';

export const LIMITS = { photoBytes: 10 * 2 ** 20, videoBytes: 150 * 2 ** 20, perVenueItems: 100, perVenueBytes: 3 * 2 ** 30 };
const root = () => resolve(config.mediaDir);

/** Decide what a file is from its first bytes. Only formats browsers render natively; SVG is refused (script risk). */
export function sniff(b) {
  if (b.length < 12) return null;
  const hex = (a, z) => b.subarray(a, z).toString('hex');
  const txt = (a, z) => b.subarray(a, z).toString('latin1');
  if (hex(0, 3) === 'ffd8ff') return { kind: 'photo', type: 'image/jpeg', ext: 'jpg' };
  if (hex(0, 8) === '89504e470d0a1a0a') return { kind: 'photo', type: 'image/png', ext: 'png' };
  if (txt(0, 4) === 'GIF8') return { kind: 'photo', type: 'image/gif', ext: 'gif' };
  if (txt(0, 4) === 'RIFF' && txt(8, 12) === 'WEBP') return { kind: 'photo', type: 'image/webp', ext: 'webp' };
  if (txt(4, 8) === 'ftyp') {
    const brand = txt(8, 12);
    if (brand === 'qt  ') return { kind: 'video', type: 'video/quicktime', ext: 'mov' };
    if (/^(heic|heix|mif1|msf1|avif)/.test(brand)) return null; // still images in an MP4 box: not supported
    return { kind: 'video', type: 'video/mp4', ext: 'mp4' };
  }
  if (hex(0, 4) === '1a45dfa3') return { kind: 'video', type: 'video/webm', ext: 'webm' };
  return null;
}

/** Take a finished temp file, verify it, move it into place and record it. Returns the new row. */
async function finalize({ tmp, size, sha, head, venueId, userId, caption, resourceId }) {
  try {
    const t = sniff(head);
    if (!t) throw badRequest('Unsupported file. Use JPEG, PNG, WebP or GIF photos, or MP4, MOV or WebM videos.');
    if (t.kind === 'photo' && size > LIMITS.photoBytes) throw new AppError(413, 'too_large', `Photos can be up to ${LIMITS.photoBytes / 2 ** 20} MB`);
    if (t.kind === 'video' && size > LIMITS.videoBytes) throw new AppError(413, 'too_large', `Videos can be up to ${LIMITS.videoBytes / 2 ** 20} MB`);
    const used = await one('SELECT count(*)::int AS n, coalesce(sum(size_bytes),0) AS bytes FROM venue_media WHERE venue_id=$1 AND removed_at IS NULL', [venueId]);
    if (used.n >= LIMITS.perVenueItems) throw new AppError(409, 'limit_reached', `A venue can have up to ${LIMITS.perVenueItems} photos and videos`);
    if (Number(used.bytes) + size > LIMITS.perVenueBytes) throw new AppError(409, 'limit_reached', 'This venue has used all of its media storage');
    if (resourceId) {
      const r = await one('SELECT venue_id FROM resources WHERE id=$1', [resourceId]);
      if (!r || r.venue_id !== venueId) throw badRequest('That area belongs to another venue');
    }
    const id = randomUUID();
    const file = `${id}.${t.ext}`;
    const dest = join(root(), venueId, file);
    await mkdir(dirname(dest), { recursive: true });
    await rename(tmp, dest);
    const row = await one(
      `INSERT INTO venue_media(id, venue_id, resource_id, kind, content_type, file_name, size_bytes, sha256, caption, position, is_cover, uploaded_by)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce(max(position),-1)+1, NOT EXISTS (SELECT 1 FROM venue_media WHERE venue_id=$2 AND is_cover AND removed_at IS NULL), $10
         FROM venue_media WHERE venue_id=$2 AND removed_at IS NULL RETURNING *`,
      [id, venueId, resourceId ?? null, t.kind, t.type, file, size, sha, caption ?? null, userId]);
    return row;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Store an uploaded stream (raw PUT). Counts bytes as they arrive and stops early at the largest allowed size. */
export async function storeStream(stream, ctx) {
  const tmp = join(root(), 'tmp', `${randomUUID()}.part`);
  await mkdir(dirname(tmp), { recursive: true });
  const hash = createHash('sha256');
  let size = 0, head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > LIMITS.videoBytes) return cb(new AppError(413, 'too_large', `Files can be up to ${LIMITS.videoBytes / 2 ** 20} MB`));
      if (head.length < 32) head = Buffer.concat([head, chunk]).subarray(0, 32);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try { await pipeline(stream, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o640 })); }
  catch (e) { await rm(tmp, { force: true }); throw e; }
  if (!size) { await rm(tmp, { force: true }); throw badRequest('Empty upload'); }
  return finalize({ tmp, size, sha: hash.digest('hex'), head, ...ctx });
}

/** Store an in-memory file (base64 capability). */
export async function storeBuffer(buf, ctx) {
  const tmp = join(root(), 'tmp', `${randomUUID()}.part`);
  await mkdir(dirname(tmp), { recursive: true });
  await writeFile(tmp, buf, { flag: 'wx', mode: 0o640 });
  return finalize({ tmp, size: buf.length, sha: createHash('sha256').update(buf).digest('hex'), head: buf.subarray(0, 32), ...ctx });
}

export const mediaUrl = (m) => (m.kind === 'video_link' ? m.link_url : `/api/v1/media/${m.id}`);
export const publicMedia = (m) => ({ id: m.id, kind: m.kind, url: mediaUrl(m), content_type: m.content_type, caption: m.caption, position: m.position, is_cover: m.is_cover, resource_id: m.resource_id, created_at: m.created_at });

/** Binary routes that don't fit the JSON capability model: streaming upload and serving files. */
export function mediaRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };

  // PUT /api/v1/venues/:id/media?caption=&resource_id=   body = the raw file (photos up to 10 MB, videos up to 150 MB)
  r.put('/venues/:id/media', rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Venue');
      await mustManage(user, req.params.id);
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > LIMITS.videoBytes) throw new AppError(413, 'too_large', `Files can be up to ${LIMITS.videoBytes / 2 ** 20} MB`);
      const caption = typeof req.query.caption === 'string' ? req.query.caption.slice(0, 200) : undefined;
      const resourceId = typeof req.query.resource_id === 'string' && /^[0-9a-f-]{36}$/.test(req.query.resource_id) ? req.query.resource_id : undefined;
      const row = await storeStream(req, { venueId: req.params.id, userId: user.id, caption, resourceId });
      res.status(201).json(publicMedia(row));
    } catch (e) { req.resume(); fail(res, e); }
  });

  // GET /api/v1/media/:id — public (venue pages are public). Immutable: a file's bytes never change under its id.
  r.get('/media/:id', async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Media');
      const m = (await query("SELECT * FROM venue_media WHERE id=$1 AND removed_at IS NULL AND file_name IS NOT NULL", [req.params.id])).rows[0];
      if (!m) throw notFound('Media');
      const path = join(root(), m.venue_id, m.file_name);
      await stat(path);
      res.set({ 'Content-Type': m.content_type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
      res.sendFile(path, { cacheControl: false, headers: {} }, (err) => { if (err && !res.headersSent) fail(res, notFound('Media')); });
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Media') : e); }
  });
  return r;
}

