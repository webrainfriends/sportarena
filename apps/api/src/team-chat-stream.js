// Team chat over HTTP outside the JSON capability router: the live stream (Server-Sent Events) and photo / file / voice-note upload and download.
//  * Stream: GET /teams/:id/messages/stream. Every frame has the message's seq as its id; a reconnecting client sends it back (Last-Event-ID or ?cursor=)
//    and gets what it missed, oldest first. Frames carry whole messages as the viewer may see them, so the client dedupes by message_id. Access is
//    re-checked on every frame and every 10 s: when someone leaves the team (or a guardian link is revoked) the stream says `revoked` and closes.
//  * Media: stored encrypted on disk, served only to people who can see the channel the message was posted in, checked at download time.
// Clients that cannot hold a stream open (React Native has no EventSource) use list_team_messages with after_seq + wait_seconds instead.
import { createHash } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from './config.js';
import { authenticate } from './auth.js';
import { one } from './db.js';
import { AppError, badRequest, notFound, unauthorized } from './errors.js';
import { toErrorBody } from './invoke.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from './doc-store.js';
import { sniff } from './media.js';
import { subscribe, REFRESH } from './live.js';
import { channel, chatAccess, fetchMessages, mustBeSafeToPost, mustPost } from './team-chat.js';
import { requireApproved } from './access.js';
import { requireConsent } from './youth.js';

const UUID = /^[0-9a-f-]{36}$/;
const MAX_PER_USER = 6;
const RECHECK_MS = 10_000;
const open = new Map();
export const LIMITS = { image: DOC_LIMITS.bytes, file: DOC_LIMITS.bytes, voice: 5 * 2 ** 20, perTeam: 2000 };

/** A short voice note, recognised from its bytes (never from what the client says it is). */
export function sniffAudio(b) {
  if (b.length < 12) return null;
  const t = (a, z) => b.subarray(a, z).toString('latin1');
  if (t(0, 4) === 'OggS') return { type: 'audio/ogg', ext: 'ogg' };
  if (b.subarray(0, 4).toString('hex') === '1a45dfa3') return { type: 'audio/webm', ext: 'webm' };
  if (t(4, 8) === 'ftyp') return { type: 'audio/mp4', ext: 'm4a' };
  if (t(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return { type: 'audio/mpeg', ext: 'mp3' };
  if (t(0, 4) === 'RIFF' && t(8, 12) === 'WAVE') return { type: 'audio/wav', ext: 'wav' };
  return null;
}

export function teamChatRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 60 : 2000, standardHeaders: true, legacyHeaders: false });

  // ---------------------------------------------------------------------------------------------------------- stream
  r.get('/teams/:id/messages/stream', async (req, res) => {
    let user, access;
    try {
      if (!UUID.test(req.params.id)) throw notFound('Team');
      user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      access = await chatAccess(user, req.params.id);
    } catch (e) { return fail(res, e.status === 403 ? notFound('Team chat') : e); }   // 404, not 403: an outsider learns nothing about the chat
    const teamId = req.params.id;
    if ((open.get(user.id) ?? 0) >= MAX_PER_USER) return res.status(503).json({ error: { code: 'busy', message: 'Too many open chat streams; use list_team_messages with wait_seconds instead' } });
    open.set(user.id, (open.get(user.id) ?? 0) + 1);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const raw = Number.parseInt(String(req.get('last-event-id') ?? req.query.cursor ?? ''), 10);
    let since = Number.isInteger(raw) && raw >= 0 ? raw : null, closed = false, queue = Promise.resolve();
    const send = (event, data, id) => res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const end = () => { if (closed) return; closed = true; open.set(user.id, Math.max(0, (open.get(user.id) ?? 1) - 1)); clearInterval(beat); clearInterval(check); off(); res.end(); };
    const stillAllowed = async () => { try { access = await chatAccess(user, teamId); return true; } catch { return false; } };
    const revoke = () => { send('revoked', { message: 'You no longer have access to this chat' }); end(); };
    // `ids` = the messages that changed (a reaction, vote, pin, removal); no ids = catch up on anything newer than the cursor
    const push = async (ids) => {
      if (closed) return;
      if (!(await stillAllowed())) return revoke();
      if (ids?.length) {
        const fresh = await fetchMessages(user, access, { where: 'm.id = ANY($4)', params: [ids], limit: 200, order: 'ASC' });
        const seen = new Set(fresh.map((m) => m.message_id));
        const removed = ids.filter((x) => !seen.has(x));
        if (fresh.length || removed.length) send('messages', { messages: fresh, removed }, fresh.length ? Math.max(since, ...fresh.map((m) => m.seq)) : undefined);
        since = Math.max(since, ...fresh.map((m) => m.seq));
      } else {
        const fresh = await fetchMessages(user, access, { where: 'm.seq > $4', params: [since], limit: 200, order: 'ASC' });
        if (fresh.length) { send('messages', { messages: fresh, removed: [] }, fresh[fresh.length - 1].seq); since = fresh[fresh.length - 1].seq; }
      }
    };
    const on = (data) => { queue = queue.then(() => push(data === REFRESH || !data?.ids ? null : data.ids)).catch(() => {}); };
    const off = subscribe(channel(teamId), on);
    const beat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 25_000);
    const check = setInterval(() => { queue = queue.then(async () => { if (!closed && !(await stillAllowed())) revoke(); }).catch(() => {}); }, RECHECK_MS);
    req.on('close', end);
    // no cursor = a client that already loaded the chat over HTTP: start from now
    if (since === null) since = Number((await one('SELECT coalesce(max(seq),0)::bigint AS n FROM team_messages WHERE team_id=$1', [teamId])).n);
    send('ready', { team_id: teamId, channels: access.audiences, cursor: since });
    queue = queue.then(() => push(null)).catch(() => { if (!closed) { send('error', { message: 'could not read the chat' }); end(); } });
  });

  // ---------------------------------------------------------------------------------------------------------- upload
  // PUT /api/v1/teams/:id/chat-media?kind=image|file|voice&name=…&audience=team|guardians&seconds=12   body = the raw file
  r.put('/teams/:id/chat-media', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      requireApproved(user);
      if (!UUID.test(req.params.id)) throw notFound('Team');
      const q = z.object({ kind: z.enum(['image', 'file', 'voice']), name: z.string().trim().min(1).max(120).default('attachment'), audience: z.enum(['team', 'guardians']).default('team'), seconds: z.coerce.number().int().min(1).max(180).optional() }).parse(req.query);
      if (q.kind === 'voice' && !q.seconds) throw badRequest('Say how long the voice note is (seconds, up to 180)');
      const access = await chatAccess(user, req.params.id);
      mustPost(access, q.audience);
      await requireConsent(user.id, 'contact', 'messaging in the team chat');
      await mustBeSafeToPost(user, access);
      if (Number(req.headers['content-length'] ?? 0) > LIMITS[q.kind]) throw new AppError(413, 'too_large', `That ${q.kind === 'voice' ? 'voice note' : 'file'} is too large`);
      const used = await one('SELECT count(*)::int AS n FROM team_chat_media WHERE team_id=$1 AND removed_at IS NULL', [req.params.id]);
      if (used.n >= LIMITS.perTeam) throw new AppError(409, 'limit_reached', 'This team has used all of its chat storage');
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      if (buf.length > LIMITS[q.kind]) throw new AppError(413, 'too_large', `That ${q.kind === 'voice' ? 'voice note' : 'file'} is too large`);
      const t = q.kind === 'voice' ? sniffAudio(buf) : q.kind === 'image' ? (sniff(buf)?.kind === 'photo' ? sniff(buf) : null) : sniffDoc(buf);
      if (!t) throw badRequest(q.kind === 'voice' ? 'Unsupported voice note. Use an MP4/M4A, WebM, Ogg, MP3 or WAV recording.' : q.kind === 'image' ? 'Unsupported photo. Use JPEG, PNG, WebP or GIF.' : 'Unsupported file. Use a PDF or a JPEG, PNG, WebP or GIF image.');
      const { id: mid, file } = await saveEncrypted('team-chat', 'team_chat_media.file', buf);
      const row = await one(
        `INSERT INTO team_chat_media(id, team_id, uploader_id, audience, kind, content_type, name, file_name, size_bytes, seconds, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, kind, name, content_type, size_bytes, seconds, audience, created_at`,
        [mid, req.params.id, user.id, q.audience, q.kind, t.type, q.name, file, buf.length, q.seconds ?? null, createHash('sha256').update(buf).digest('hex')]);
      res.status(201).json({ ...row, media_id: row.id, url: `/api/v1/team-chat-media/${row.id}` });
    } catch (e) { req.resume(); fail(res, e); }
  });

  // ---------------------------------------------------------------------------------------------------------- download
  // Needs the Authorization header; access is the current membership / guardian link, so it ends the moment that does.
  r.get('/team-chat-media/:media_id', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!UUID.test(req.params.media_id)) throw notFound('Attachment');
      const m = await one('SELECT * FROM team_chat_media WHERE id=$1 AND removed_at IS NULL', [req.params.media_id]);
      if (!m) throw notFound('Attachment');
      let access;
      try { access = await chatAccess(user, m.team_id); } catch { throw notFound('Attachment'); }
      if (!access.audiences.includes(m.audience)) throw notFound('Attachment');
      const posted = await one('SELECT 1 FROM team_messages WHERE media_id=$1 AND deleted_at IS NULL', [m.id]);
      if (!posted && m.uploader_id !== user.id) throw notFound('Attachment');   // not yet sent: only the person who is composing it
      const bytes = await loadEncrypted('team-chat', 'team_chat_media.file', m.file_name);
      res.set({ ...docHeaders(m.content_type, bytes), 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.name)}` });
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Attachment') : e); }
  });
  return r;
}
