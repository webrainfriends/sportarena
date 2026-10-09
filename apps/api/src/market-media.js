// Photos, GIFs and short videos attached to marketplace posts. Same rules as venue media: type decided from the bytes,
// server-generated file names, rows retired with removed_at (files are never deleted).
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
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
import { sniff } from './media.js';

export const MARKET_LIMITS = { photoBytes: 10 * 2 ** 20, videoBytes: 60 * 2 ** 20, perUserUnattached: 20 };
const root = () => resolve(config.mediaDir, 'market');
export const marketMediaUrl = (m) => `/api/v1/market/media/${m.id}`;

async function store(stream, userId, purpose = null) {
  const tmp = join(root(), 'tmp', `${randomUUID()}.part`);
  await mkdir(dirname(tmp), { recursive: true });
  const hash = createHash('sha256');
  let size = 0, head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      if (size > MARKET_LIMITS.videoBytes) return cb(new AppError(413, 'too_large', `Files can be up to ${MARKET_LIMITS.videoBytes / 2 ** 20} MB`));
      if (head.length < 32) head = Buffer.concat([head, chunk]).subarray(0, 32);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o640 }));
    if (!size) throw badRequest('Empty upload');
    const t = sniff(head);
    if (!t) throw badRequest('Unsupported file. Use JPEG, PNG, WebP or GIF images, or MP4, MOV or WebM videos.');
    if (t.kind === 'photo' && size > MARKET_LIMITS.photoBytes) throw new AppError(413, 'too_large', `Images can be up to ${MARKET_LIMITS.photoBytes / 2 ** 20} MB`);
    if (purpose === 'avatar' && (t.kind !== 'photo' || t.type === 'image/gif')) throw badRequest('Use a JPEG, PNG or WebP photo for your profile picture.');
    const pending = await one('SELECT count(*)::int AS n FROM market_media WHERE uploader_id=$1 AND post_id IS NULL AND purpose IS NULL AND removed_at IS NULL', [userId]);
    if (purpose !== 'avatar' && pending.n >= MARKET_LIMITS.perUserUnattached) throw new AppError(409, 'limit_reached', 'Attach your uploads to a post before adding more');
    const id = randomUUID();
    const file = `${id}.${t.ext}`;
    await mkdir(root(), { recursive: true });
    await rename(tmp, join(root(), file));
    return one('INSERT INTO market_media(id, uploader_id, kind, content_type, file_name, size_bytes, sha256, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, kind, content_type',
      [id, userId, t.kind, t.type, file, size, hash.digest('hex'), purpose]);
  } catch (e) { await rm(tmp, { force: true }); throw e; }
}

export function marketMediaRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };

  // PUT /api/v1/market/media   body = the raw file. Returns {id, url, kind}; pass the id in create_market_post.media_ids.
  r.put('/market/media', rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (Number(req.headers['content-length'] ?? 0) > MARKET_LIMITS.videoBytes) throw new AppError(413, 'too_large', 'File too large');
      const row = await store(req, user.id);
      res.status(201).json({ ...row, url: marketMediaUrl(row) });
    } catch (e) { req.resume(); fail(res, e); }
  });

  // PUT /api/v1/me/avatar[?cutout=1]   body = the raw photo (JPEG/PNG/WebP, up to 10 MB). cutout=1 marks a transparent PNG with the background removed. Becomes the profile picture of any account, whatever its roles.
  // Earlier photos stay stored (nothing is deleted); the emoji avatar remains the fallback.
  r.put('/me/avatar', rateLimit({ windowMs: 60_000, limit: config.isProd ? 20 : 1000, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (Number(req.headers['content-length'] ?? 0) > MARKET_LIMITS.photoBytes) throw new AppError(413, 'too_large', `Images can be up to ${MARKET_LIMITS.photoBytes / 2 ** 20} MB`);
      const row = await store(req, user.id, 'avatar');
      const url = marketMediaUrl(row);
      const cutout = req.query.cutout === '1' && row.content_type === 'image/png';
      await query('UPDATE users SET avatar_url=$2, avatar_cutout=$3 WHERE id=$1', [user.id, url, cutout]);
      res.status(201).json({ avatar_url: url, avatar_cutout: cutout });
    } catch (e) { req.resume(); fail(res, e); }
  });

  // GET /api/v1/market/media/:id — public; ids are unguessable and file bytes never change under an id.
  r.get('/market/media/:id', async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Media');
      const m = (await query('SELECT * FROM market_media WHERE id=$1 AND removed_at IS NULL', [req.params.id])).rows[0];
      if (!m) throw notFound('Media');
      const path = join(root(), m.file_name);
      await stat(path);
      res.set({ 'Content-Type': m.content_type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
      res.sendFile(path, { cacheControl: false, headers: {} }, (err) => { if (err && !res.headersSent) fail(res, notFound('Media')); });
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Media') : e); }
  });
  return r;
}
