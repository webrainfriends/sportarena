// Coach session media & resource library.
// Binary upload is handled by sessionMediaRouter() (raw PUT, no JSON middleware).
// List / metadata / soft-delete / patch are JSON capabilities so they appear in OpenAPI + MCP.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx, query } from '../db.js';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { AppError } from '../errors.js';
import { authenticate } from '../auth.js';
import { requireRelationship } from '../coaching.js';
import { isYouth, guardianLink } from '../youth.js';
import { saveEncrypted, loadEncrypted, docHeaders, sniffDoc } from '../doc-store.js';
import { sniff } from '../media.js';
import { config } from '../config.js';
import { notify } from '../notify.js';

const TAG = 'Session media';
const FOLDER = 'session-media';
const root = () => resolve(config.mediaDir);

// ── size limits ──────────────────────────────────────────────────────────────
const LIMITS = {
  video:    500 * 2 ** 20,   // 500 MB
  document:  50 * 2 ** 20,   //  50 MB
  image:     10 * 2 ** 20,   //  10 MB
  maxItems:  20,
  maxPlanBytes: 5 * 2 ** 30, // 5 GB per plan
};

// ── auth helpers ─────────────────────────────────────────────────────────────
async function loadSession(c, sessionId) {
  const s = (await c.query(
    `SELECT s.*, p.coach_id, p.athlete_id, p.id AS plan_id
       FROM training_sessions s
       JOIN training_plans p ON p.id = s.plan_id
      WHERE s.id = $1`,
    [sessionId],
  )).rows[0];
  if (!s) throw notFound('Training session');
  return s;
}

function assertCoach(user, s) {
  if (user.id !== s.coach_id) throw forbidden('Only the session\'s coach can manage resources');
}

async function assertCanRead(user, s) {
  if (user.id !== s.coach_id && user.id !== s.athlete_id) {
    // guardian?
    const link = await guardianLink(user.id, s.athlete_id);
    if (!link) throw forbidden('Not a party to this session');
  }
}

// ── sniff helper: decides kind from first bytes ───────────────────────────────
function sniffMedia(head) {
  const v = sniff(head);
  if (v && v.kind === 'video') return { kind: 'video', type: v.type, ext: v.ext };
  if (v && v.kind === 'photo') return { kind: 'image', type: v.type, ext: v.ext };
  const d = sniffDoc(head);
  if (d) return { kind: 'document', type: d.type, ext: d.ext };
  return null;
}

// ── mark session as viewed (drives unread badge) ─────────────────────────────
async function markViewed(c, sessionId, userId) {
  await c.query(
    `INSERT INTO session_media_views(session_id, user_id, viewed_at)
       VALUES($1,$2,now())
     ON CONFLICT (session_id, user_id) DO UPDATE SET viewed_at = now()`,
    [sessionId, userId],
  );
}

// ── public shape ─────────────────────────────────────────────────────────────
function shape(m) {
  return {
    id: m.id,
    session_id: m.session_id,
    kind: m.kind,
    content_type: m.content_type ?? null,
    original_name: m.original_name ?? null,
    size_bytes: m.size_bytes ? Number(m.size_bytes) : null,
    duration_sec: m.duration_sec ?? null,
    link_url: m.link_url ?? null,
    link_provider: m.link_provider ?? null,
    link_thumb_url: m.link_thumb_url ?? null,
    caption: m.caption ?? null,
    position: m.position,
    released: m.released,
    view_count: m.view_count,
    created_at: m.created_at,
    // binary items stream from /api/v1/session-media/:id/file
    download_url: m.file_name ? `/api/v1/session-media/${m.id}/file` : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw binary upload router (PUT /training-sessions/:id/media)
// ─────────────────────────────────────────────────────────────────────────────
export function sessionMediaRouter() {
  const r = express.Router();
  const fail = (res, e) => {
    const status = e.statusCode ?? e.status ?? 500;
    res.status(status).json({ error: { code: e.code ?? 'error', message: e.message } });
  };

  r.put(
    '/training-sessions/:id/media',
    rateLimit({ windowMs: 60_000, limit: config.isProd ? 20 : 1000, standardHeaders: true, legacyHeaders: false }),
    async (req, res) => {
      try {
        const user = await authenticate(req.headers.authorization);
        if (!user) throw unauthorized();
        if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Session');

        const s = await loadSession({ query: (sql, p) => query(sql, p) }, req.params.id);
        assertCoach(user, s);

        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > LIMITS.video) throw new AppError(413, 'too_large', 'Files can be up to 500 MB');

        // stream to temp
        const tmp = join(root(), 'tmp', `${randomUUID()}.part`);
        await mkdir(dirname(tmp), { recursive: true });
        const hash = createHash('sha256');
        let size = 0;
        let head = Buffer.alloc(0);
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > LIMITS.video) return cb(new AppError(413, 'too_large', 'File too large'));
            if (head.length < 32) head = Buffer.concat([head, chunk]).subarray(0, 32);
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        try { await pipeline(req, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o640 })); }
        catch (e) { await rm(tmp, { force: true }); throw e; }
        if (!size) { await rm(tmp, { force: true }); throw badRequest('Empty upload'); }

        const t = sniffMedia(head);
        if (!t) { await rm(tmp, { force: true }); throw badRequest('Unsupported file type. Upload MP4, MOV, WebM, PDF, JPEG, PNG or WebP.'); }

        // size check by kind
        const kindLimit = LIMITS[t.kind] ?? LIMITS.document;
        if (size > kindLimit) {
          await rm(tmp, { force: true });
          throw new AppError(413, 'too_large', `${t.kind === 'video' ? 'Videos' : t.kind === 'image' ? 'Images' : 'Documents'} can be up to ${kindLimit / 2 ** 20} MB`);
        }

        // per-session item count
        const { n: itemCount } = await one('SELECT count(*)::int AS n FROM session_media WHERE session_id=$1 AND removed_at IS NULL', [s.id]);
        if (itemCount >= LIMITS.maxItems) {
          await rm(tmp, { force: true });
          throw new AppError(409, 'limit_reached', `Maximum ${LIMITS.maxItems} resources per session`);
        }

        // encrypt and store
        const buf = Buffer.allocUnsafe(size);
        // re-read from tmp
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(tmp);
        await rm(tmp, { force: true });

        const { file } = await saveEncrypted(FOLDER, 'session_media.file_name', raw);

        const caption = typeof req.query.caption === 'string' ? req.query.caption.slice(0, 500) : null;
        const originalName = typeof req.query.name === 'string' ? req.query.name.slice(0, 255) : null;

        const row = await one(
          `INSERT INTO session_media(session_id, plan_id, uploaded_by, kind, content_type, original_name,
              file_name, size_bytes, sha256, caption, position)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce((
             SELECT max(position)+1 FROM session_media WHERE session_id=$1 AND removed_at IS NULL
           ), 0)
           RETURNING *`,
          [s.id, s.plan_id, user.id, t.kind, t.type, originalName, file, size, hash.digest('hex'), caption],
        );

        // notify athlete
        try {
          await notify(null, s.athlete_id, {
            kind: 'session_media_added',
            title: 'New session resources',
            body: `Your coach added a resource to ${s.title ?? 'your session'}`,
            data: { session_id: s.id, media_id: row.id },
          });
          if (await isYouth(s.athlete_id)) {
            const g = await guardianLink(null, s.athlete_id);
            if (g) {
              await notify(null, g.guardian_id, {
                kind: 'session_media_added',
                title: 'New session resources',
                body: `Coach added a resource to ${s.title ?? 'a session'}`,
                data: { session_id: s.id },
              });
            }
          }
        } catch { /* notifications best-effort */ }

        res.status(201).json(shape(row));
      } catch (e) { req.resume(); fail(res, e); }
    },
  );

  // GET /api/v1/session-media/:id/file — authenticated encrypted download
  r.get('/session-media/:id/file', async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Media');
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();

      const m = await one('SELECT sm.*, s.coach_id, s.athlete_id, s.plan_id FROM session_media sm JOIN training_sessions s ON s.id = sm.session_id WHERE sm.id=$1 AND sm.removed_at IS NULL AND sm.file_name IS NOT NULL', [req.params.id]);
      if (!m) throw notFound('Media');

      const isCoach = user.id === m.coach_id;
      const isAthlete = user.id === m.athlete_id;
      if (!isCoach && !isAthlete) {
        const g = await guardianLink(user.id, m.athlete_id);
        if (!g) throw forbidden('Not a party to this session');
      }
      if (!isCoach && !m.released) throw forbidden('This resource has not been released yet');

      const bytes = await loadEncrypted(FOLDER, 'session_media.file_name', m.file_name);
      await query('UPDATE session_media SET view_count = view_count + 1 WHERE id=$1', [m.id]);

      res.set(docHeaders(m.content_type, bytes));
      res.end(bytes);
    } catch (e) {
      const status = e.statusCode ?? e.status ?? 500;
      res.status(status).json({ error: { code: e.code ?? 'error', message: e.message } });
    }
  });

  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON capabilities
// ─────────────────────────────────────────────────────────────────────────────

cap({
  name: 'list_session_media', method: 'GET', path: '/training-sessions/:id/media', tag: TAG,
  summary: 'List media attachments for a session. Coach sees all; athlete and guardian see released items only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await loadSession(c, i.id);
      await assertCanRead(user, s);
      const isCoach = user.id === s.coach_id;
      const rows = await many(
        `SELECT * FROM session_media WHERE session_id=$1 AND removed_at IS NULL ${isCoach ? '' : 'AND released=true'}
           ORDER BY position, created_at`,
        [i.id],
      );
      await markViewed(c, i.id, user.id);
      const total_bytes = rows.reduce((a, r) => a + Number(r.size_bytes ?? 0), 0);
      const video_sec = rows.filter((r) => r.kind === 'video' && r.duration_sec).reduce((a, r) => a + r.duration_sec, 0);
      return {
        items: rows.map(shape),
        kpi: {
          count: rows.length,
          total_bytes,
          video_hours: Math.round(video_sec / 360) / 10,
        },
      };
    });
  },
});

cap({
  name: 'attach_session_link', method: 'POST', path: '/training-sessions/:id/links', tag: TAG, status: 201,
  summary: 'Coach attaches an external link (YouTube, Vimeo, Hudl, Catapult, etc.) to a session. No binary stored.',
  input: z.object({
    id,
    link_url: z.string().url().max(2000),
    link_provider: z.enum(['youtube', 'vimeo', 'hudl', 'catapult', 'sportscode', 'other']).optional(),
    link_thumb_url: z.string().url().max(2000).optional(),
    caption: z.string().max(500).optional(),
    released: z.boolean().default(true),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await loadSession(c, i.id);
      assertCoach(user, s);
      const { n } = await one('SELECT count(*)::int AS n FROM session_media WHERE session_id=$1 AND removed_at IS NULL', [s.id]);
      if (n >= LIMITS.maxItems) throw new AppError(409, 'limit_reached', `Maximum ${LIMITS.maxItems} resources per session`);
      const row = await one(
        `INSERT INTO session_media(session_id, plan_id, uploaded_by, kind, link_url, link_provider, link_thumb_url, caption, released, position)
         SELECT $1,$2,$3,'link',$4,$5,$6,$7,$8, coalesce((SELECT max(position)+1 FROM session_media WHERE session_id=$1 AND removed_at IS NULL),0)
         RETURNING *`,
        [s.id, s.plan_id, user.id, i.link_url, i.link_provider ?? 'other', i.link_thumb_url ?? null, i.caption ?? null, i.released],
      );
      return shape(row);
    });
  },
});

cap({
  name: 'update_session_media', method: 'PATCH', path: '/session-media/:id', tag: TAG,
  summary: 'Coach updates caption, position or released state of a session resource.',
  input: z.object({
    id,
    caption: z.string().max(500).optional().nullable(),
    position: z.number().int().min(0).max(999).optional(),
    released: z.boolean().optional(),
    link_url: z.string().url().max(2000).optional(),
    link_provider: z.enum(['youtube', 'vimeo', 'hudl', 'catapult', 'sportscode', 'other']).optional(),
    link_thumb_url: z.string().url().max(2000).optional().nullable(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT sm.*, s.coach_id FROM session_media sm JOIN training_sessions s ON s.id=sm.session_id WHERE sm.id=$1 AND sm.removed_at IS NULL', [i.id])).rows[0];
      if (!m) throw notFound('Media');
      if (user.id !== m.coach_id) throw forbidden('Only the session\'s coach can update resources');
      const sets = [], vals = [i.id];
      const push = (col, val) => { if (val !== undefined) { vals.push(val); sets.push(`${col}=$${vals.length}`); } };
      push('caption', i.caption);
      push('position', i.position);
      push('released', i.released);
      push('link_url', i.link_url);
      push('link_provider', i.link_provider);
      push('link_thumb_url', i.link_thumb_url);
      if (!sets.length) throw badRequest('Nothing to update');
      const row = (await c.query(`UPDATE session_media SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals)).rows[0];
      return shape(row);
    });
  },
});

cap({
  name: 'remove_session_media', method: 'DELETE', path: '/session-media/:id', tag: TAG,
  summary: 'Coach soft-deletes (removes) a session resource. Bytes on disk are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT sm.*, s.coach_id FROM session_media sm JOIN training_sessions s ON s.id=sm.session_id WHERE sm.id=$1 AND sm.removed_at IS NULL', [i.id])).rows[0];
      if (!m) throw notFound('Media');
      if (user.id !== m.coach_id) throw forbidden('Only the session\'s coach can remove resources');
      await c.query('UPDATE session_media SET removed_at=now() WHERE id=$1', [i.id]);
      return { removed: true };
    });
  },
});
