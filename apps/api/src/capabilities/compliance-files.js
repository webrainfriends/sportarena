// Compliance evidence files (#595): PDF, photos (JPEG, PNG, WebP, GIF), Word (.docx, .doc), Excel (.xlsx, .xls), CSV and plain text, up to 10 MB each and 5 per record.
// The type is decided from the bytes, never from the name or what the client says; Office files with macros, external links or ActiveX are refused; a malware
// scanner is honoured when one is configured. Files are AES-256-GCM encrypted on disk, hidden (never deleted) when removed, and every read is audit-logged.
// A background check never takes files: its reference stays with the holder and reviewers see only the outcome.
// Upload is JSON with the file as base64 (one path works the same on iOS, iPadOS, Android and web); listing is part of list_compliance_records.
import { createHash } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { one, pool, tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { requireApproved } from '../access.js';
import { audit } from '../helpers.js';
import { DOC_LIMITS, loadEncrypted, saveEncrypted } from '../doc-store.js';
import { scanBuffer, scanPolicy } from '../malware-scan.js';
import { holderAccess, manages } from '../compliance.js';
import { sniffTenderFile } from './tender-files.js';
import { TAG, log } from './compliance.js';

export const PER_RECORD = 5;
const safeName = (n) => String(n ?? 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
const OLE = Buffer.from('d0cf11e0a1b1', 'hex');
const OLE_TYPES = { doc: 'application/msword', xls: 'application/vnd.ms-excel' };
const TEXT_TYPES = { csv: 'text/csv', txt: 'text/plain' };
export const ALLOWED = 'PDF, JPEG, PNG, WebP, GIF, Word (.docx, .doc), Excel (.xlsx, .xls), CSV or text';

/** What a file really is, from its bytes: null when it is not an accepted kind. Throws a plain message for macro-bearing Office files. */
export function sniffEvidenceFile(buf, name) {
  const t = sniffTenderFile(buf, name); // PDF, photos, macro-free .docx / .xlsx
  if (t) return t;
  const ext = String(name).toLowerCase().split('.').pop();
  if (OLE_TYPES[ext] && buf.subarray(0, 6).equals(OLE)) {
    if (buf.includes('_VBA_PROJECT') || buf.includes(Buffer.from('V\0B\0A\0', 'latin1')) || buf.includes('Macros')) throw badRequest('Documents with macros are not accepted');
    return { type: OLE_TYPES[ext], ext };
  }
  if (TEXT_TYPES[ext] && !buf.includes(0)) {
    const s = buf.toString('utf8');
    if (Buffer.from(s, 'utf8').equals(buf)) return { type: TEXT_TYPES[ext], ext };
  }
  return null;
}

const INLINE = /^(application\/pdf|image\/)/;

/** Who may touch a record's files: the holder (or guardian, or the organisation / event manager for theirs). For reading, scope managers too, except for sensitive requirements. */
async function recordFor(user, rid, { read = false } = {}) {
  const r = (await pool.query('SELECT k.*, q.scope_kind, q.scope_id, q.sensitive, q.requires_review, q.name AS requirement_name FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id WHERE k.id=$1', [rid])).rows[0];
  const own = r ? await holderAccess(user, r.subject_kind, r.subject_id) : null;
  const mgr = read && r && !r.sensitive && (await manages(user, r.scope_kind, r.scope_id));
  if (!r || !(own || mgr)) throw notFound('Record');
  return { r, own };
}

cap({
  name: 'remove_compliance_evidence_file', method: 'DELETE', path: '/compliance/records/:id/files/:file_id', tag: TAG,
  summary: 'Hide a file you attached to a record that is still waiting for review (the holder, a guardian, or the organisation / event manager). The encrypted file is kept for the audit trail.',
  input: z.object({ id, file_id: id }),
  async handler({ user }, i) {
    const { r } = await recordFor(user, i.id);
    if (r.status !== 'submitted') throw conflict('Files can only be changed while the submission is waiting for review');
    const f = await one('UPDATE comp_files SET removed_at=now(), removed_by=$3 WHERE id=$1 AND record_id=$2 AND removed_at IS NULL RETURNING id', [i.file_id, r.id, user.id]);
    if (!f) throw notFound('File');
    await log(pool, { requirement_id: r.requirement_id, record_id: r.id, subject_kind: r.subject_kind, subject_id: r.subject_id, actor_id: user.id, action: 'file_removed', detail: { file_id: f.id } });
    return { id: f.id, removed: true };
  },
});

export function complianceFilesRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });
  const who = async (req) => { const u = await authenticate(req.headers.authorization); if (!u) throw unauthorized(); requireApproved(u); return u; };
  const uuid = (v, what) => { if (!/^[0-9a-f-]{36}$/.test(v)) throw notFound(what); return v; };

  // POST /api/v1/compliance/records/:id/files   { file_name, data: <base64> }  (JSON body up to ~14 MB, mounted in http.js)
  r.post('/compliance/records/:id/files', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const body = z.object({ file_name: z.string().trim().min(1).max(160), data: z.string().min(4) }).parse(req.body ?? {});
      const { r: rec } = await recordFor(user, uuid(req.params.id, 'Record'));
      if (rec.sensitive) throw conflict('A background check keeps only its outcome: give the reference, and do not attach files', { code: 'files_not_accepted' });
      const open = rec.status === 'submitted' || (rec.status === 'valid' && !rec.requires_review && !rec.decided_by);
      if (!open) throw conflict('Files can only be added while the submission is waiting for review', { code: 'record_closed' });
      const buf = Buffer.from(body.data, 'base64');
      if (!buf.length) throw badRequest('Empty upload');
      if (buf.length > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', `Files can be up to ${DOC_LIMITS.bytes / 2 ** 20} MB`);
      const name = safeName(body.file_name);
      const t = sniffEvidenceFile(buf, name);
      if (!t) throw badRequest(`Unsupported file. Use ${ALLOWED}.`);
      const scan = await scanBuffer(buf);
      if (scan.status === 'infected') throw badRequest('That file was rejected by the malware scan');
      if (scan.status === 'unavailable' && scanPolicy().mode === 'required') throw new AppError(503, 'scan_unavailable', 'Files cannot be checked right now. Try again shortly.');
      const { id: fid, file } = await saveEncrypted('compliance', 'comp_files.file', buf);
      const row = await tx(async (c) => {
        await c.query('SELECT id FROM comp_records WHERE id=$1 FOR UPDATE', [rec.id]);
        const used = (await c.query('SELECT count(*)::int AS n FROM comp_files WHERE record_id=$1 AND removed_at IS NULL', [rec.id])).rows[0].n;
        if (used >= PER_RECORD) throw new AppError(409, 'limit_reached', `A record can have up to ${PER_RECORD} files`);
        const f = (await c.query(
          `INSERT INTO comp_files(id, record_id, original_name, content_type, file_name, size_bytes, sha256, scan, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, record_id, original_name, content_type, size_bytes, created_at`, [fid, rec.id, name, t.type, file, buf.length, createHash('sha256').update(buf).digest('hex'), scan.status === 'clean' ? 'clean' : 'skipped', user.id])).rows[0];
        await log(c, { requirement_id: rec.requirement_id, record_id: rec.id, subject_kind: rec.subject_kind, subject_id: rec.subject_id, actor_id: user.id, action: 'file_added', detail: { file_id: f.id, type: t.ext } });
        return f;
      });
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  // GET /api/v1/compliance/records/:id/files/:file_id: needs the Authorization header; every read is audit-logged
  r.get('/compliance/records/:id/files/:file_id', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const { r: rec, own } = await recordFor(user, uuid(req.params.id, 'Record'), { read: true });
      const f = await one('SELECT * FROM comp_files WHERE id=$1 AND record_id=$2 AND removed_at IS NULL', [uuid(req.params.file_id, 'File'), rec.id]);
      if (!f) throw notFound('File');
      const bytes = await loadEncrypted('compliance', 'comp_files.file', f.file_name);
      await audit(null, user.id, 'read_compliance_file', 'comp_files', f.id);
      await log(pool, { requirement_id: rec.requirement_id, record_id: rec.id, subject_kind: rec.subject_kind, subject_id: rec.subject_id, actor_id: user.id, action: 'file_read', detail: { file_id: f.id, as: own ?? 'manager' } });
      res.set({ 'Content-Type': f.content_type, 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': `${INLINE.test(f.content_type) ? 'inline' : 'attachment'}; filename="${f.original_name.replace(/"/g, '')}"` });
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('File') : e); }
  });
  return r;
}
