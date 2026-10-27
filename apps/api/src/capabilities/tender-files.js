// Tender files (binary, so outside the JSON capability router like the other document folders): buyer pack documents and supplier proposal
// attachments. Files are encrypted at rest, scanned, never deleted, and every download goes through the same sealing and role rules as the
// proposal content: no direct URL works without authority, and a technical-envelope file can never be a pricing spreadsheet.
import { createHash } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { id } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { one, pool, tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { requireApproved } from '../access.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { scanBuffer, scanPolicy } from '../malware-scan.js';
import { assertEnvelopeAccess, auditLog, buyerRoles, getProject, noticeAccess, requireBuyer, requireEntity } from '../tender/core.js';
import { KINDS, tenderDocument } from '../tender/documents.js';

const PER_PROJECT = 80;
const OOXML = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const safeName = (n) => String(n ?? 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';

/** PDF, photos, and macro-free Word/Excel documents. The type is decided from the bytes, never from what the client says. */
export function sniffTenderFile(buf, name) {
  const t = sniffDoc(buf);
  if (t) return t;
  const ext = String(name).toLowerCase().split('.').pop();
  if (OOXML[ext] && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const hay = buf.toString('latin1');
    if (/vbaProject|macros\/|\.bin\b.*vba|xl\/externalLinks|ActiveX/i.test(hay)) throw badRequest('Documents with macros, external links or ActiveX content are not accepted');
    if (!hay.includes('[Content_Types].xml')) return null;
    return { type: OOXML[ext], ext };
  }
  return null;
}

export function tenderFilesRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });

  async function store(req, user, p, { entityId, proposalId, audience, visitPack = false, replaces = null }) {
    if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', 'File too large');
    const used = await one('SELECT count(*)::int AS n FROM proc_files WHERE project_id=$1 AND archived_at IS NULL AND entity_id IS NOT DISTINCT FROM $2 AND proposal_id IS NOT DISTINCT FROM $3', [p.id, entityId, proposalId]);
    if (used.n >= PER_PROJECT) throw new AppError(409, 'limit_reached', `Up to ${PER_PROJECT} files can be attached here`);
    const buf = await readBody(req);
    if (!buf.length) throw badRequest('Empty upload');
    const name = safeName(req.query.name);
    const t = sniffTenderFile(buf, name);
    if (!t) throw badRequest('Unsupported file. Use a PDF, a JPEG/PNG/WebP image, or a Word/Excel document without macros.');
    if (audience === 'technical' && t.ext === 'xlsx') throw badRequest('Spreadsheets cannot go in the technical envelope because they can carry prices. Put priced documents in the commercial envelope.');
    const scan = await scanBuffer(buf);
    if (scan.status === 'infected') throw badRequest('That file was rejected by the malware scan');
    if (scan.status === 'unavailable' && scanPolicy().mode === 'required') throw new AppError(503, 'scan_unavailable', 'Files cannot be checked right now. Try again shortly.');
    const { id: fid, file } = await saveEncrypted('procurement', 'proc_files.stored', buf);
    const row = await tx(async (c) => {
      const r = (await c.query(`INSERT INTO proc_files(id, project_id, entity_id, proposal_id, uploaded_by, audience, name, mime, bytes, sha256, stored, scan, visit_pack, replaces_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'clean',$12,$13) RETURNING id, name, mime, bytes, audience, visit_pack, replaces_id, created_at`,
        [fid, p.id, entityId, proposalId, user.id, audience, name, t.type, buf.length, createHash('sha256').update(buf).digest('hex'), file, visitPack, replaces])).rows[0];
      if (replaces) await c.query('UPDATE proc_files SET archived_at=now() WHERE id=$1 AND archived_at IS NULL', [replaces]);
      return r;
    });
    await auditLog(pool, p.id, user.id, replaces ? 'file_replaced' : 'file_uploaded', { file_id: fid, audience, entity_id: entityId, visit_pack: visitPack, ...(replaces ? { replaces } : {}) });
    return { ...row, url: `/api/v1/tender-files/${fid}` };
  }

  // PUT /api/v1/rfps/:id/files?name=…&audience=public|participants|buyer[&visit_pack=true][&replaces=<file id>]   body = the raw file (tender pack documents)
  r.put('/rfps/:id/files', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      requireApproved(user);
      const q = z.object({ id, audience: z.enum(['public', 'participants', 'buyer']).optional(), visit_pack: z.enum(['true', 'false']).optional(), replaces: id.optional() }).parse({ ...req.query, id: req.params.id });
      const { project: p } = await requireBuyer(user, q.id, 'files');
      if (['cancelled', 'archived'].includes(p.status)) throw conflict('This tender is finished');
      let audience = q.audience ?? 'participants', visitPack = q.visit_pack === 'true';
      if (q.replaces) {
        // an amended document replaces the earlier one: only while the tender is still a draft (after approval a change goes through an addendum)
        if (p.status !== 'draft') throw conflict('After approval a document cannot be replaced. Add the amended document as a new one and issue an addendum that says what changed.');
        const old = await one('SELECT * FROM proc_files WHERE id=$1 AND project_id=$2 AND entity_id IS NULL AND archived_at IS NULL', [q.replaces, p.id]);
        if (!old) throw notFound('File');
        audience = q.audience ?? old.audience; visitPack = q.visit_pack ? q.visit_pack === 'true' : old.visit_pack;
      }
      if (visitPack && audience !== 'participants') throw badRequest('A site-visit document goes to participants who accepted the terms');
      res.status(201).json(await store(req, user, p, { entityId: null, proposalId: null, audience, visitPack, replaces: q.replaces ?? null }));
    } catch (e) { req.resume(); fail(res, e); }
  });

  // PUT /api/v1/proposals/:id/files?name=…&envelope=technical|commercial   body = the raw file (proposal attachments)
  r.put('/proposals/:id/files', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      requireApproved(user);
      const q = z.object({ id, envelope: z.enum(['technical', 'commercial']) }).parse({ ...req.query, id: req.params.id });
      const pr = await one('SELECT * FROM proc_proposals WHERE id=$1', [q.id]);
      if (!pr) throw notFound('Proposal');
      await requireEntity(user, pr.entity_id, ['owner', 'bid_manager', 'contributor', 'signatory']);
      const p = await getProject(pr.project_id);
      if (p.suspended_at || p.status !== 'published' || (p.closes_at && new Date() >= new Date(p.closes_at))) throw conflict('This tender no longer accepts files');
      res.status(201).json(await store(req, user, p, { entityId: pr.entity_id, proposalId: pr.id, audience: q.envelope }));
    } catch (e) { req.resume(); fail(res, e); }
  });

  // GET /api/v1/tender-files/:id — needs the Authorization header. Pack files follow the notice rules; proposal files follow the envelope rules.
  r.get('/tender-files/:id', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('File');
      const f = await one('SELECT * FROM proc_files WHERE id=$1 AND archived_at IS NULL', [req.params.id]);
      if (!f) throw notFound('File');
      const p = await getProject(f.project_id);
      if (!f.entity_id) {
        const acc = await noticeAccess(user, p).catch(() => { throw notFound('File'); });
        if (f.audience === 'buyer' && !acc.buyer.length) throw notFound('File');
        if (f.audience === 'participants' && !acc.buyer.length && !(acc.part && acc.part.terms_accepted_at && ['approved', 'interested', 'invited'].includes(acc.part.status))) throw forbidden('Accept the tender terms to download this document');
      } else {
        const mine = await one("SELECT 1 FROM supplier_entity_members WHERE entity_id=$1 AND user_id=$2 AND status='active'", [f.entity_id, user.id]);
        if (!mine) {
          const roles = await buyerRoles(user, p);
          if (!roles.length) throw notFound('File');
          const pr = await one('SELECT * FROM proc_proposals WHERE id=$1', [f.proposal_id]);
          await assertEnvelopeAccess(user, roles, p, pr, f.audience);
          await auditLog(pool, p.id, user.id, 'envelope_file_read', { file_id: f.id, envelope: f.audience });
        }
      }
      const bytes = await loadEncrypted('procurement', 'proc_files.stored', f.stored);
      res.set({ ...docHeaders(f.mime, bytes), 'Content-Disposition': `attachment; filename="${encodeURIComponent(f.name)}"` });
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('File') : e); }
  });

  // GET /api/v1/tender-documents/:kind/:id  — branded PDF rendered from an immutable issued snapshot (needs the Authorization header)
  r.get('/tender-documents/:kind/:id', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      const kind = req.params.kind, did = req.params.id.replace(/\.pdf$/, '');
      if (!KINDS.includes(kind) || !/^[0-9a-f-]{36}$/.test(did)) throw notFound('Document');
      const q = z.object({ n: z.coerce.number().int().min(1).optional(), version: z.coerce.number().int().min(1).optional(), envelope: z.enum(['technical', 'commercial']).optional(), round: z.coerce.number().int().min(1).optional(), proposal_id: id.optional(), entity_id: id.optional() }).parse(req.query);
      const { buffer, filename } = await tenderDocument(user, kind, did, q);
      res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(buffer.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff' });
      res.end(buffer);
    } catch (e) { fail(res, e); }
  });
  return r;
}
