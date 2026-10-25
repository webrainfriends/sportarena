// Supplier services (#458) — branded PDFs for every document family: RFQ, comparison / award summary, quote, service order, agreement / SOW, job sheet,
// timesheet, service receipt, completion report, invoice (draft, pro forma, issued, credit note), payment receipt and supplier statement.
// Built on the branded-documents store (#249): private encrypted bytes, sha256, page count, audit, access re-checked on every download.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { saveEncrypted } from '../doc-store.js';
import { LOADERS, DOC_TYPES } from '../svc/documents.js';
import { renderServiceDocument } from '../documents/service-render.js';
import { kitOf, mustAccess, loadLogo } from './branded-documents.js';

const TAG = 'Supplier documents';

cap({
  name: 'generate_service_document', method: 'POST', path: '/service-documents', tag: TAG, status: 201,
  summary: `Render a supplier-services document as a branded PDF (${DOC_TYPES.join(', ')}). Content is read from the canonical records for the type and checked against your access; figures are never typed in. Drafts, pro formas and unconfirmed orders carry a visible watermark. Regenerating makes a new immutable document; historical PDFs are unaffected by later brand changes. Download with GET /branded-documents/{id}/file.`,
  input: z.object({ type: z.enum(DOC_TYPES), source_id: id, kit_id: id.optional().describe('your brand kit (personal, or an organisation you may use); the plain layout when omitted') }),
  async handler({ user }, i) {
    const loaded = await LOADERS[i.type](user, i.source_id);
    let kit = null;
    if (i.kit_id) { kit = await kitOf(i.kit_id); await mustAccess(user, kit, 'Brand kit'); if (kit.archived_at) throw badRequest('That brand kit is archived'); }
    const { buffer, pages } = await renderServiceDocument({ doc: loaded.doc, kit, logo: kit ? await loadLogo(kit.logo_asset_id) : null });
    const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
    const row = await one(
      `INSERT INTO generated_documents(id, family, source_type, source_id, source_version, logo_asset_id, file_name, size_bytes, sha256, pages, generated_by)
       VALUES ($1,'service_document',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, family, source_type, source_id, source_version, size_bytes, sha256, pages, created_at`,
      [did, `svc_${i.type}`, i.source_id, loaded.version ?? null, kit?.logo_asset_id ?? null, file, buffer.length, createHash('sha256').update(buffer).digest('hex'), pages, user.id]);
    await audit(null, user.id, 'generate_document', 'generated_documents', did);
    return { ...row, type: i.type, url: `/api/v1/branded-documents/${did}/file` };
  },
});
cap({
  name: 'list_service_documents', method: 'GET', path: '/service-documents', tag: TAG,
  summary: 'PDFs generated for one source (newest first), if you may read that source.',
  input: z.object({ type: z.enum(DOC_TYPES), source_id: id, ...page }),
  async handler({ user }, i) {
    await LOADERS[i.type](user, i.source_id);
    return many("SELECT id, family, source_type, source_id, source_version, size_bytes, sha256, pages, generated_by, created_at FROM generated_documents WHERE source_type=$1 AND source_id=$2 ORDER BY created_at DESC, id LIMIT $3 OFFSET $4", [`svc_${i.type}`, i.source_id, i.limit, i.offset]);
  },
});
