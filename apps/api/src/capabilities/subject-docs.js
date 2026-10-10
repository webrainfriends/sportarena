// Documents folder for a team, event or venue: approved or paid insurance (schedules, certificates, receipts) and anything else the
// people who run it want to keep together. Managers add and hide; members and sponsors with a stake can read. A row holds its own
// encrypted file, or points at a document already stored with a policy (nothing is copied twice). Files are never deleted.
import { createHash } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { one, many, query } from '../db.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit, isAdmin } from '../helpers.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { standing } from './insurance.js';
import { relation } from './insurance-docs.js';

const SUBJECTS = ['team', 'event', 'venue'];
const KINDS = ['policy', 'certificate', 'receipt', 'quote', 'other'];
const MAX_PER_SUBJECT = 200;
const COLS = 'd.id, d.subject_type, d.subject_id, d.kind, d.title, d.policy_id, d.insurance_document_id, coalesce(d.content_type, idoc.content_type) AS content_type, coalesce(d.size_bytes, idoc.size_bytes) AS size_bytes, (d.insurance_document_id IS NOT NULL) AS from_insurance, d.uploaded_by, u.display_name AS uploaded_by_name, d.created_at';
const FROM = 'FROM subject_documents d JOIN users u ON u.id=d.uploaded_by LEFT JOIN insurance_documents idoc ON idoc.id=d.insurance_document_id';

/** 'manage' | 'member' for this team / event / venue (admins count as managers), else a 404 so existence is not leaked. */
async function access(user, subjectType, subjectId) {
  const s = isAdmin(user) ? 'manage' : await standing(user, subjectType, subjectId);
  if (!s) throw notFound(subjectType);
  return s;
}
const needManage = (s) => { if (s !== 'manage') throw forbidden('Only the people who manage this can change its documents'); };

cap({
  name: 'list_subject_documents', method: 'GET', path: '/documents', tag: 'Documents',
  summary: 'The documents folder of a team, event or venue you belong to: insurance policies and certificates, receipts and other files. Download with GET /documents/{id}/file; upload with PUT /documents (raw file body; query: subject_type, subject_id, kind, title); attach an insurer\'s document with link_insurance_document.',
  input: z.object({ subject_type: z.enum(SUBJECTS), subject_id: id, ...page }),
  async handler({ user }, i) {
    await access(user, i.subject_type, i.subject_id);
    return many(`SELECT ${COLS} ${FROM} WHERE d.removed_at IS NULL AND d.subject_type=$1 AND d.subject_id=$2 ORDER BY d.created_at DESC LIMIT $3 OFFSET $4`, [i.subject_type, i.subject_id, i.limit, i.offset]);
  },
});

cap({
  name: 'link_insurance_document', method: 'POST', path: '/documents/link', tag: 'Documents', status: 201,
  summary: 'Add a document stored with one of your insurance policies (a schedule, certificate or receipt from the insurer, or one you uploaded) to the documents folder of the team, event or venue that policy covers. The file is not copied.',
  input: z.object({ insurance_document_id: id, kind: z.enum(KINDS).optional(), title: z.string().min(1).max(120).optional() }),
  async handler({ user }, i) {
    const d = await one(
      `SELECT d.*, p.subject_type, p.subject_id FROM insurance_documents d JOIN insurance_policies p ON p.id=d.policy_id WHERE d.id=$1 AND d.removed_at IS NULL AND p.subject_type IN ('team','event','venue')`, [i.insurance_document_id]);
    if (!d) throw notFound('Policy document');
    await relation(user, { policy_id: d.policy_id });
    needManage(await access(user, d.subject_type, d.subject_id));
    const dup = await one('SELECT id FROM subject_documents WHERE insurance_document_id=$1 AND subject_id=$2 AND removed_at IS NULL', [d.id, d.subject_id]);
    if (dup) return { id: dup.id, already_linked: true };
    const row = await one(
      'INSERT INTO subject_documents(subject_type, subject_id, kind, title, policy_id, insurance_document_id, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, subject_type, subject_id, kind, title, policy_id, created_at',
      [d.subject_type, d.subject_id, i.kind ?? (d.kind === 'receipt' ? 'receipt' : d.kind === 'quote' ? 'quote' : d.kind === 'certificate' ? 'certificate' : 'policy'), i.title ?? d.title, d.policy_id, d.id, user.id]);
    await audit(null, user.id, 'link_insurance_document', 'subject_documents', row.id);
    return row;
  },
});

cap({
  name: 'remove_subject_document', method: 'DELETE', path: '/documents/:id', tag: 'Documents',
  summary: 'Hide a document from a team, event or venue folder (managers only). The encrypted file and the audit trail are kept; it just stops appearing.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const d = await one('SELECT * FROM subject_documents WHERE id=$1 AND removed_at IS NULL', [i.id]);
    if (!d) throw notFound('Document');
    needManage(await access(user, d.subject_type, d.subject_id));
    await query('UPDATE subject_documents SET removed_at=now() WHERE id=$1', [d.id]);
    await audit(null, user.id, 'remove_subject_document', 'subject_documents', d.id);
    return { id: d.id, removed: true };
  },
});

export function subjectDocsRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });

  // PUT /api/v1/documents?subject_type=team&subject_id=…&kind=certificate&title=…   body = the raw file (PDF, JPEG, PNG, WebP or GIF)
  r.put('/documents', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      const q = z.object({ subject_type: z.enum(SUBJECTS), subject_id: id, kind: z.enum(KINDS).default('other'), title: z.string().min(1).max(120).optional(), policy_id: id.optional() }).parse(req.query);
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', 'File too large');
      needManage(await access(user, q.subject_type, q.subject_id));
      if (q.policy_id && !(await one('SELECT 1 FROM insurance_policies WHERE id=$1 AND subject_type=$2 AND subject_id=$3', [q.policy_id, q.subject_type, q.subject_id]))) throw badRequest('That policy does not cover this team, event or venue');
      const used = await one('SELECT count(*)::int AS n FROM subject_documents WHERE removed_at IS NULL AND subject_type=$1 AND subject_id=$2', [q.subject_type, q.subject_id]);
      if (used.n >= MAX_PER_SUBJECT) throw new AppError(409, 'limit_reached', `Up to ${MAX_PER_SUBJECT} documents can be kept here`);
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniffDoc(buf);
      if (!t) throw badRequest('Unsupported file. Use a PDF or a JPEG, PNG, WebP or GIF image.');
      const { id: did, file } = await saveEncrypted('subject-docs', 'subject_documents.file', buf);
      const row = await one(
        `INSERT INTO subject_documents(id, subject_type, subject_id, kind, title, policy_id, content_type, file_name, size_bytes, sha256, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, subject_type, subject_id, kind, title, policy_id, content_type, size_bytes, created_at`,
        [did, q.subject_type, q.subject_id, q.kind, q.title ?? q.kind.replace(/_/g, ' '), q.policy_id ?? null, t.type, file, buf.length, createHash('sha256').update(buf).digest('hex'), user.id]);
      await audit(null, user.id, 'upload_subject_document', 'subject_documents', did);
      res.status(201).json({ ...row, url: `/api/v1/documents/${did}/file` });
    } catch (e) { req.resume(); fail(res, e); }
  });

  // GET /api/v1/documents/:id/file — needs the Authorization header; every download is audit-logged.
  r.get('/documents/:id/file', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Document');
      const d = await one('SELECT * FROM subject_documents WHERE id=$1 AND removed_at IS NULL', [req.params.id]);
      if (!d) throw notFound('Document');
      await access(user, d.subject_type, d.subject_id);
      let bytes, type = d.content_type;
      if (d.file_name) bytes = await loadEncrypted('subject-docs', 'subject_documents.file', d.file_name);
      else {
        const idoc = await one('SELECT * FROM insurance_documents WHERE id=$1 AND removed_at IS NULL', [d.insurance_document_id]);
        if (!idoc) throw notFound('Document');
        bytes = await loadEncrypted('insurance', 'insurance_documents.file', idoc.file_name); type = idoc.content_type;
      }
      await audit(null, user.id, 'read_pii', 'subject_documents', d.id);
      res.set(docHeaders(type, bytes));
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Document') : e); }
  });
  return r;
}
