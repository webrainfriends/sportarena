// Drill library media: photos and videos attached to drill steps.
// Binary upload: PUT /coaching/drills/:id/media  (raw stream, auth header)
// Download:      GET /coaching/drills/:id/media/:mid/file
// Delete:        cap  DELETE /coaching/drills/:id/media/:mid
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one } from '../db.js';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { AppError } from '../errors.js';
import { authenticate } from '../auth.js';
import { saveEncrypted, loadEncrypted } from '../doc-store.js';
import { sniff } from '../media.js';
import { sniffAudio } from '../team-chat-stream.js';
import { config } from '../config.js';

const TAG = 'Coach';
const COACH = ['coach'];
const FOLDER = 'drill-media';
const LIMITS = { photo: 10 * 2 ** 20, video: 500 * 2 ** 20, audio: 100 * 2 ** 20, perDrill: 30 };

/** Extract duration in whole seconds from raw audio/video bytes using ffprobe, if available. Returns null on any failure. */
async function probeDuration(buf, ext) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    const exec = promisify(execFile);
    const tmp = pjoin(tmpdir(), `probe-${Math.random().toString(36).slice(2)}.${ext}`);
    await writeFile(tmp, buf);
    try {
      const { stdout } = await exec('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', tmp], { timeout: 10_000 });
      const info = JSON.parse(stdout);
      const secs = parseFloat(info?.format?.duration);
      return Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  } catch { return null; }
}
const root = () => resolve(config.mediaDir);

async function ownDrill(userId, templateId) {
  const t = await one("SELECT id, coach_id FROM coach_templates WHERE id=$1 AND archived_at IS NULL AND scope='block'", [templateId]);
  if (!t) throw notFound('Drill');
  if (t.coach_id !== userId) throw forbidden('Not your drill');
  return t;
}

async function readableDrill(userId, templateId) {
  const t = await one(
    `SELECT t.id, t.coach_id FROM coach_templates t
      WHERE t.id=$1 AND t.archived_at IS NULL AND t.scope='block'
        AND (t.coach_id=$2
             OR t.shared_team_id IN (SELECT team_id FROM team_members WHERE user_id=$2 AND status='active' AND role='coach')
             OR t.shared_organisation_id IN (SELECT m.organisation_id FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.user_id=$2 AND m.status='active' AND o.status='active' AND m.role IN ('owner','admin','coach')))`,
    [templateId, userId]);
  if (!t) throw notFound('Drill');
  return t;
}

cap({
  name: 'delete_drill_media', method: 'DELETE', path: '/coaching/drills/:id/media/:mid', tag: TAG, auth: COACH,
  summary: 'Remove a photo or video from a drill (soft-delete; sessions that already used it keep their copy).',
  input: z.object({ id, mid: id }),
  async handler({ user }, i) {
    await ownDrill(user.id, i.id);
    const r = await one('UPDATE drill_media SET removed_at=now() WHERE id=$1 AND template_id=$2 AND removed_at IS NULL RETURNING id', [i.mid, i.id]);
    if (!r) throw notFound('Media');
    return { id: r.id, removed: true };
  },
});

export function drillMediaRouter() {
  const r = express.Router();
  const fail = (res, e) => res.status(e.statusCode ?? e.status ?? 500).json({ error: { code: e.code ?? 'error', message: e.message } });

  // PUT /coaching/drills/:id/media — upload a photo or video
  r.put(
    '/coaching/drills/:id/media',
    rateLimit({ windowMs: 60_000, limit: config.isProd ? 15 : 1000, standardHeaders: true, legacyHeaders: false }),
    async (req, res) => {
      try {
        const user = await authenticate(req.headers.authorization);
        if (!user) throw unauthorized();
        if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Drill');
        await ownDrill(user.id, req.params.id);

        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > LIMITS.video) throw new AppError(413, 'too_large', 'Files can be up to 500 MB for video or 100 MB for audio');

        const { n } = await one('SELECT count(*)::int AS n FROM drill_media WHERE template_id=$1 AND removed_at IS NULL', [req.params.id]);
        if (n >= LIMITS.perDrill) throw new AppError(409, 'limit_reached', `A drill can have up to ${LIMITS.perDrill} media items`);

        const tmp = join(root(), 'tmp', `${randomUUID()}.part`);
        await mkdir(dirname(tmp), { recursive: true });
        const hash = createHash('sha256');
        let size = 0, head = Buffer.alloc(0);
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > LIMITS.video) return cb(new AppError(413, 'too_large', 'File too large'));
            if (head.length < 32) head = Buffer.concat([head, chunk]).subarray(0, 32);
            hash.update(chunk); cb(null, chunk);
          },
        });
        try { await pipeline(req, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o640 })); }
        catch (e) { await rm(tmp, { force: true }); throw e; }
        if (!size) { await rm(tmp, { force: true }); throw badRequest('Empty upload'); }

        const t = sniff(head) ?? (sniffAudio(head) ? { kind: 'audio', ...sniffAudio(head) } : null);
        if (!t || !['photo', 'video', 'audio'].includes(t.kind)) {
          await rm(tmp, { force: true });
          throw badRequest('Upload JPEG, PNG, MP4, MP3, M4A, WAV or OGG files only.');
        }
        const limit = t.kind === 'photo' ? LIMITS.photo : t.kind === 'audio' ? LIMITS.audio : LIMITS.video;
        if (size > limit) { await rm(tmp, { force: true }); throw new AppError(413, 'too_large', `${t.kind === 'photo' ? 'Photos' : t.kind === 'audio' ? 'Audio files' : 'Videos'} can be up to ${limit / 2 ** 20} MB`); }

        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(tmp);
        await rm(tmp, { force: true });
        const { file } = await saveEncrypted(FOLDER, 'drill_media.file_name', raw);

        const duration = (t.kind === 'audio' || t.kind === 'video') ? await probeDuration(raw, t.ext ?? (t.kind === 'video' ? 'mp4' : 'mp3')) : null;
        const original = typeof req.query.name === 'string' ? req.query.name.slice(0, 255) : null;
        const row = await one(
          'INSERT INTO drill_media(template_id,uploaded_by,kind,content_type,file_name,size_bytes,sha256,original_name,duration_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,kind,content_type,size_bytes,original_name,duration_seconds,created_at',
          [req.params.id, user.id, t.kind, t.type, file, size, hash.digest('hex'), original, duration]);
        res.status(201).json({ ...row, size_bytes: Number(row.size_bytes), file_url: `/api/v1/coaching/drills/${req.params.id}/media/${row.id}/file` });
      } catch (e) { fail(res, e); }
    },
  );

  // GET /coaching/drills/:id/media/:mid/file — download (auth required)
  r.get('/coaching/drills/:id/media/:mid/file', async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!/^[0-9a-f-]{36}$/.test(req.params.id) || !/^[0-9a-f-]{36}$/.test(req.params.mid)) throw notFound('Media');
      await readableDrill(user.id, req.params.id);
      const m = await one('SELECT * FROM drill_media WHERE id=$1 AND template_id=$2 AND removed_at IS NULL', [req.params.mid, req.params.id]);
      if (!m) throw notFound('Media');
      const buf = await loadEncrypted(FOLDER, 'drill_media.file_name', m.file_name);
      res.set('Content-Type', m.content_type);
      res.set('Content-Length', String(buf.length));
      res.set('Cache-Control', 'private, max-age=86400');
      res.send(buf);
    } catch (e) { fail(res, e); }
  });

  return r;
}
