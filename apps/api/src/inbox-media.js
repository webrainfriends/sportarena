// Inbox attachments over plain HTTP (a raw file body cannot ride the JSON capability router, same as team chat media).
//   PUT /api/v1/conversations/:id/attachments?kind=image|file&name=…   body = the raw file   -> { attachment_id, url, ... }
//   GET /api/v1/conversation-attachments/:attachment_id                                       -> the file (inline), members and guardian viewers only
// Files are stored encrypted, recognised from their bytes (never from what the client says), and every download re-checks live membership.
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
import { requireApproved } from './access.js';
import { assertMayPostHere, conversationAccess } from './inbox.js';
import { requireConsent, isYouth } from './youth.js';

const UUID = /^[0-9a-f-]{36}$/;
export const ATTACHMENT_LIMITS = { bytes: DOC_LIMITS.bytes, perConversation: 500 };

export function inboxMediaRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 60 : 2000, standardHeaders: true, legacyHeaders: false });

  r.put('/conversations/:id/attachments', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      requireApproved(user);
      if (!UUID.test(req.params.id)) throw notFound('Conversation');
      const q = z.object({ kind: z.enum(['image', 'file']), name: z.string().trim().min(1).max(120).default('attachment') }).parse(req.query);
      const access = await conversationAccess(user, req.params.id, { write: true });
      if (await isYouth(user.id)) await requireConsent(user.id, 'contact', 'messaging');
      await assertMayPostHere(user.id, access.conv.id);
      if (Number(req.headers['content-length'] ?? 0) > ATTACHMENT_LIMITS.bytes) throw new AppError(413, 'too_large', 'That file is too large');
      const used = await one('SELECT count(*)::int AS n FROM conversation_attachments WHERE conversation_id=$1 AND removed_at IS NULL', [req.params.id]);
      if (used.n >= ATTACHMENT_LIMITS.perConversation) throw new AppError(409, 'limit_reached', 'This conversation has used all of its attachment storage');
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = q.kind === 'image' ? (sniff(buf)?.kind === 'photo' ? sniff(buf) : null) : sniffDoc(buf);
      if (!t) throw badRequest(q.kind === 'image' ? 'Unsupported photo. Use JPEG, PNG, WebP or GIF.' : 'Unsupported file. Use a PDF or a JPEG, PNG, WebP or GIF image.');
      const { id: aid, file } = await saveEncrypted('inbox', 'conversation_attachments.file', buf);
      const row = await one(
        `INSERT INTO conversation_attachments(id, conversation_id, uploader_id, kind, content_type, name, file_name, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, kind, name, content_type, size_bytes, created_at`, [aid, req.params.id, user.id, q.kind, t.type, q.name, file, buf.length, createHash('sha256').update(buf).digest('hex')]);
      res.status(201).json({ ...row, attachment_id: row.id, url: `/api/v1/conversation-attachments/${row.id}` });
    } catch (e) { req.resume(); fail(res, e.name === 'ZodError' ? badRequest('Say whether this is an image or a file') : e); }
  });

  r.get('/conversation-attachments/:attachment_id', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!UUID.test(req.params.attachment_id)) throw notFound('Attachment');
      const a = await one('SELECT * FROM conversation_attachments WHERE id=$1 AND removed_at IS NULL', [req.params.attachment_id]);
      if (!a) throw notFound('Attachment');
      let access;
      try { access = await conversationAccess(user, a.conversation_id); } catch { throw notFound('Attachment'); }
      const posted = await one('SELECT 1 FROM conversation_messages WHERE attachment_id=$1 AND hidden_at IS NULL', [a.id]);
      if (!posted && a.uploader_id !== user.id) throw notFound('Attachment');   // not sent yet: only the person composing it; hidden: only its sender and organisers below
      if (!posted && a.uploader_id === user.id && !access.member) throw notFound('Attachment');
      const bytes = await loadEncrypted('inbox', 'conversation_attachments.file', a.file_name);
      res.set({ ...docHeaders(a.content_type, bytes), 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.name)}` });
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Attachment') : e); }
  });
  return r;
}
