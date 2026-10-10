// Insurance documents (the "locker"): policy schedules, certificates, receipts, quotes and claim evidence kept with the policy.
// Files live encrypted on the server's disk and are never deleted: removing a document only hides it (removed_at).
// Upload and download are binary, so they are Express routes (mounted in http.js); listing and hiding are ordinary capabilities.
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
import { audit, hasRole, isAdmin } from '../helpers.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { standing } from './insurance.js';

export { DOC_LIMITS, sniffDoc };
const KINDS = ['policy_schedule', 'certificate', 'receipt', 'quote', 'claim_evidence', 'other'];

/** How `user` relates to the thing a document hangs on: 'holder' (the buyer/claimant, or whoever manages the covered team, event or venue), 'insurer' (the insurer that wrote it) or null. */
export async function relation(user, { policy_id, quote_id, claim_id }) {
  const ins = hasRole(user, 'insurer') ? await one('SELECT id FROM insurers WHERE owner_id=$1', [user.id]) : null;
  let row;
  if (policy_id) row = await one('SELECT p.holder_id AS holder, pl.insurer_id, p.subject_type AS kind, p.subject_id FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE p.id=$1', [policy_id]);
  else if (quote_id) row = await one('SELECT buyer_id AS holder, insurer_id, cover_for AS kind, subject_id FROM insurance_quotes WHERE id=$1', [quote_id]);
  else if (claim_id) row = await one('SELECT cl.claimant_id AS holder, pl.insurer_id FROM insurance_claims cl JOIN insurance_policies p ON p.id=cl.policy_id JOIN insurance_plans pl ON pl.id=p.plan_id WHERE cl.id=$1', [claim_id]);
  if (!row) throw notFound('That policy, quote or claim');
  if (row.holder === user.id) return 'holder';
  if (row.kind && row.kind !== 'individual' && !isAdmin(user) && (await standing(user, row.kind, row.subject_id)) === 'manage') return 'holder';   // whoever manages the covered team / event / venue
  if (ins && ins.id === row.insurer_id) return 'insurer';
  if (isAdmin(user)) return 'admin';
  throw notFound('That policy, quote or claim');
}
const parentOf = (d) => ({ policy_id: d.policy_id ?? null, quote_id: d.quote_id ?? null, claim_id: d.claim_id ?? null });
const PUBLIC_DOC = 'd.id, d.policy_id, d.quote_id, d.claim_id, d.kind, d.title, d.content_type, d.size_bytes, d.sha256, d.uploaded_by, u.display_name AS uploaded_by_name, d.created_at';

cap({
  name: 'list_insurance_documents', method: 'GET', path: '/insurance/documents', tag: 'Insurance',
  summary: 'Documents stored with a policy, quote or claim (pass exactly one of policy_id, quote_id, claim_id): schedules, certificates, receipts, claim evidence. Holder and the insurer that wrote it can see them. Download with GET /insurance/documents/{id}/file; upload with PUT /insurance/documents (raw file body; query: policy_id|quote_id|claim_id, kind, title).',
  input: z.object({ policy_id: id.optional(), quote_id: id.optional(), claim_id: id.optional(), ...page }).refine((q) => [q.policy_id, q.quote_id, q.claim_id].filter(Boolean).length === 1, 'Give exactly one of policy_id, quote_id, claim_id'),
  async handler({ user }, i) {
    await relation(user, i);
    return many(`SELECT ${PUBLIC_DOC} FROM insurance_documents d JOIN users u ON u.id=d.uploaded_by WHERE d.removed_at IS NULL AND d.policy_id IS NOT DISTINCT FROM $1 AND d.quote_id IS NOT DISTINCT FROM $2 AND d.claim_id IS NOT DISTINCT FROM $3 ORDER BY d.created_at DESC LIMIT $4 OFFSET $5`,
      [i.policy_id ?? null, i.quote_id ?? null, i.claim_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'remove_insurance_document', method: 'DELETE', path: '/insurance/documents/:id', tag: 'Insurance',
  summary: 'Hide a document you uploaded (or, as admin, any). The encrypted file is kept on the server and the audit trail stays; it just stops appearing.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const d = await one('SELECT * FROM insurance_documents WHERE id=$1 AND removed_at IS NULL', [i.id]);
    if (!d) throw notFound('Document');
    await relation(user, parentOf(d));
    if (d.uploaded_by !== user.id && !isAdmin(user)) throw forbidden('Only the person who uploaded a document can remove it');
    await query('UPDATE insurance_documents SET removed_at=now() WHERE id=$1', [d.id]);
    await audit(null, user.id, 'remove_insurance_document', 'insurance_documents', d.id);
    return { id: d.id, removed: true };
  },
});

export function insuranceDocsRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });

  // PUT /api/v1/insurance/documents?policy_id=…&kind=certificate&title=…   body = the raw file (PDF, JPEG, PNG, WebP or GIF)
  r.put('/insurance/documents', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      const q = z.object({ policy_id: id.optional(), quote_id: id.optional(), claim_id: id.optional(), kind: z.enum(KINDS).default('other'), title: z.string().min(1).max(120).optional() })
        .refine((x) => [x.policy_id, x.quote_id, x.claim_id].filter(Boolean).length === 1, 'Give exactly one of policy_id, quote_id, claim_id').parse(req.query);
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', 'File too large');
      const rel = await relation(user, q);
      if (rel === 'insurer' && q.kind === 'claim_evidence') throw forbidden('Claim evidence is added by the claimant');
      const used = await one('SELECT count(*)::int AS n FROM insurance_documents WHERE removed_at IS NULL AND policy_id IS NOT DISTINCT FROM $1 AND quote_id IS NOT DISTINCT FROM $2 AND claim_id IS NOT DISTINCT FROM $3', [q.policy_id ?? null, q.quote_id ?? null, q.claim_id ?? null]);
      if (used.n >= DOC_LIMITS.perParent) throw new AppError(409, 'limit_reached', `Up to ${DOC_LIMITS.perParent} documents can be kept here`);
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniffDoc(buf);
      if (!t) throw badRequest('Unsupported file. Use a PDF or a JPEG, PNG, WebP or GIF image.');
      const { id: did, file } = await saveEncrypted('insurance', 'insurance_documents.file', buf);
      const row = await one(
        `INSERT INTO insurance_documents(id, policy_id, quote_id, claim_id, kind, title, content_type, file_name, size_bytes, sha256, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, policy_id, quote_id, claim_id, kind, title, content_type, size_bytes, created_at`,
        [did, q.policy_id ?? null, q.quote_id ?? null, q.claim_id ?? null, q.kind, q.title ?? q.kind.replace(/_/g, ' '), t.type, file, buf.length, createHash('sha256').update(buf).digest('hex'), user.id]);
      await audit(null, user.id, 'upload_insurance_document', 'insurance_documents', did);
      res.status(201).json({ ...row, url: `/api/v1/insurance/documents/${did}/file` });
    } catch (e) { req.resume(); fail(res, e); }
  });

  // GET /api/v1/insurance/documents/:id/file — needs the Authorization header; every download is audit-logged.
  r.get('/insurance/documents/:id/file', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Document');
      const d = await one('SELECT * FROM insurance_documents WHERE id=$1 AND removed_at IS NULL', [req.params.id]);
      if (!d) throw notFound('Document');
      await relation(user, parentOf(d));
      const bytes = await loadEncrypted('insurance', 'insurance_documents.file', d.file_name);
      await audit(null, user.id, 'read_pii', 'insurance_documents', d.id);
      res.set(docHeaders(d.content_type, bytes));
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Document') : e); }
  });
  return r;
}
