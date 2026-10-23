// Branded documents (issue #249, phase 1): brand kits + logos, versioned PDF templates, and branded invoice PDFs.
// Money, numbers, parties and lines always come from the canonical invoice; a template only chooses presentation. Generating a PDF
// never changes the invoice, books, pays, signs or sends anything.
import { createHash } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireApproved } from '../access.js';
import { cap, id, page } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { one, many, tx } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit, isAdmin } from '../helpers.js';
import { orgRole } from '../org-access.js';
import { docHeaders, loadEncrypted, readBody, saveEncrypted } from '../doc-store.js';
import { canManage } from '../booking/engine.js';
import { buyerOf } from '../booking/invoices.js';
import { FAMILIES, STARTERS, checkLayout, layoutSchema, starterFor } from '../documents/layout.js';
import { canReadReportVersion, reportVersionFor } from '../coaching-report-access.js';
import { LOGO_LIMITS, inspectLogo } from '../documents/image.js';
import { renderInvoice, renderCoachingReport } from '../documents/render.js';
import { canReadContractDocument } from './sponsorship-contracts.js';

const TAG = 'Branded documents';
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a #RRGGBB colour');
const text = (n) => z.string().trim().max(n);
const KIT_FIELDS = { name: text(80).min(1), display_name: text(120).min(1), legal_name: text(200).nullish(), address: text(400).nullish(), contact_email: text(200).nullish(), phone: text(40).nullish(), website: text(200).nullish(), tax_id: text(60).nullish(), primary_color: color, secondary_color: color, footer_text: text(300).nullish() };
const KIT_COLS = 'id, owner_user_id, organisation_id, name, display_name, legal_name, address, contact_email, phone, website, tax_id, primary_color, secondary_color, footer_text, logo_asset_id, row_version, archived_at, created_at, updated_at';
const TPL_COLS = 't.id, t.owner_user_id, t.organisation_id, t.family, t.name, t.status, t.kit_id, t.draft, t.row_version, t.archived_at, t.created_at, t.updated_at, (SELECT max(version) FROM document_template_versions v WHERE v.template_id=t.id) AS latest_version';
const ORG_USE = ['owner', 'admin', 'finance'], ORG_EDIT = ['owner', 'admin'];

/** Who may use / change a kit or template: the owner of a personal one; for an organisation's, members by role (membership alone is not enough to edit). 404 for outsiders. */
async function mustAccess(user, row, what, { write = false } = {}) {
  if (!row) throw notFound(what);
  if (row.owner_user_id) { if (row.owner_user_id !== user.id) throw notFound(what); return; }
  const role = await orgRole(user, row.organisation_id);
  if (!role) throw notFound(what);
  if (!(write ? ORG_EDIT : ORG_USE).includes(role)) throw forbidden(`Your role in this organisation does not allow ${write ? 'changing' : 'using'} its ${what.toLowerCase()}s`);
}
const scopeCols = (user, orgId) => (orgId ? { owner: null, org: orgId } : { owner: user.id, org: null });
const mustScope = async (user, orgId, write) => { if (orgId) await mustAccess(user, { organisation_id: orgId }, 'Organisation', { write }); };

const kitOf = async (kitId) => one(`SELECT ${KIT_COLS} FROM brand_kits WHERE id=$1`, [kitId]);
const myKits = (user) => many(
  `SELECT ${KIT_COLS} FROM brand_kits k WHERE archived_at IS NULL AND (owner_user_id=$1 OR organisation_id IN (SELECT m.organisation_id FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.user_id=$1 AND m.status='active' AND o.status='active' AND m.role = ANY($2))) ORDER BY created_at DESC`, [user.id, ORG_USE]);

cap({
  name: 'list_document_families', method: 'GET', path: '/branded-documents/families', tag: TAG,
  summary: 'The document families Sportarena can brand, which roles use them, and whether their canonical source workflow is connected (invoices and coaching reports today). A family that is not available cannot be generated.',
  handler: () => ({ families: FAMILIES, starters: Object.keys(STARTERS), starter_layouts: STARTERS, paper: ['A4', 'Letter'], logo: { types: ['image/png', 'image/jpeg'], max_bytes: LOGO_LIMITS.bytes, max_px: LOGO_LIMITS.maxPx, recommended_min_px: LOGO_LIMITS.recommendedPx } }),
});

cap({
  name: 'list_brand_kits', method: 'GET', path: '/brand-kits', tag: TAG,
  summary: 'Brand kits you may use: your personal kits and those of organisations where you are owner, admin or finance. Upload the logo with PUT /brand-kits/{id}/logo (raw PNG or JPEG body).',
  handler: ({ user }) => myKits(user),
});

cap({
  name: 'create_brand_kit', method: 'POST', path: '/brand-kits', tag: TAG,
  summary: 'Create a brand kit (name, colours, contact details, footer) for yourself, or for an organisation you own or administer (organisation_id).',
  input: z.object({ organisation_id: id.optional(), ...KIT_FIELDS, primary_color: color.default('#0F6E56'), secondary_color: color.default('#444441') }),
  async handler({ user }, i) {
    requireApproved(user);
    await mustScope(user, i.organisation_id, true);
    const { owner, org } = scopeCols(user, i.organisation_id);
    const n = await one('SELECT count(*)::int AS n FROM brand_kits WHERE archived_at IS NULL AND owner_user_id IS NOT DISTINCT FROM $1 AND organisation_id IS NOT DISTINCT FROM $2', [owner, org]);
    if (n.n >= 20) throw conflict('Up to 20 brand kits can be kept; archive one first');
    const row = await one(
      `INSERT INTO brand_kits(owner_user_id, organisation_id, name, display_name, legal_name, address, contact_email, phone, website, tax_id, primary_color, secondary_color, footer_text, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${KIT_COLS}`,
      [owner, org, i.name, i.display_name, i.legal_name ?? null, i.address ?? null, i.contact_email ?? null, i.phone ?? null, i.website ?? null, i.tax_id ?? null, i.primary_color, i.secondary_color, i.footer_text ?? null, user.id]);
    await audit(null, user.id, 'create_brand_kit', 'brand_kits', row.id);
    return row;
  },
});

cap({
  name: 'update_brand_kit', method: 'PATCH', path: '/brand-kits/:id', tag: TAG,
  summary: 'Change a brand kit, or archive it (archived: true). Send the row_version you last read; a stale one is a 409 so two editors never overwrite each other. Documents already issued keep the branding they were issued with.',
  input: z.object({ id, row_version: z.number().int(), archived: z.boolean().optional(), ...Object.fromEntries(Object.entries(KIT_FIELDS).map(([k, v]) => [k, v.optional()])) }),
  async handler({ user }, i) {
    const kit = await kitOf(i.id);
    await mustAccess(user, kit, 'Brand kit', { write: true });
    const { id: _id, row_version, archived, ...f } = i;
    const sets = Object.keys(f).filter((k) => f[k] !== undefined);
    const vals = sets.map((k) => f[k] ?? null);
    const row = await one(
      `UPDATE brand_kits SET ${sets.map((k, n) => `${k}=$${n + 3}`).join(', ')}${sets.length ? ',' : ''} archived_at = CASE WHEN $${sets.length + 3}::boolean IS NULL THEN archived_at WHEN $${sets.length + 3} THEN coalesce(archived_at, now()) ELSE NULL END, row_version=row_version+1, updated_at=now()
        WHERE id=$1 AND row_version=$2 RETURNING ${KIT_COLS}`, [i.id, row_version, ...vals, archived ?? null]);
    if (!row) throw conflict('Someone else changed this brand kit; reload it and try again');
    await audit(null, user.id, 'update_brand_kit', 'brand_kits', row.id);
    return row;
  },
});

const tplOf = (tid) => one(`SELECT ${TPL_COLS} FROM document_templates t WHERE t.id=$1`, [tid]);
async function checkKitForTemplate(user, kitId, orgId) {
  if (!kitId) return;
  const kit = await kitOf(kitId);
  await mustAccess(user, kit, 'Brand kit');
  if (orgId && kit.organisation_id !== orgId) throw badRequest('An organisation template can only use that organisation\'s brand kit');
  if (kit.archived_at) throw conflict('That brand kit is archived');
}

cap({
  name: 'list_document_templates', method: 'GET', path: '/document-templates', tag: TAG,
  summary: 'Your templates and those of organisations you can use, newest first (archived hidden). Filter by family.',
  input: z.object({ family: z.string().optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ${TPL_COLS} FROM document_templates t WHERE t.archived_at IS NULL AND ($1::text IS NULL OR t.family=$1)
       AND (t.owner_user_id=$2 OR t.organisation_id IN (SELECT m.organisation_id FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.user_id=$2 AND m.status='active' AND o.status='active' AND m.role = ANY($3)))
      ORDER BY t.created_at DESC, t.id LIMIT $4 OFFSET $5`, [i.family ?? null, user.id, ORG_USE, i.limit, i.offset]),
});

cap({
  name: 'create_document_template', method: 'POST', path: '/document-templates', tag: TAG,
  summary: 'Start a template for a document family from a starter (classic or modern) or your own layout, optionally with a brand kit. It is a draft until published. A layout cannot drop the blocks a family requires (for invoices: title, parties, lines, totals).',
  input: z.object({ family: z.enum(FAMILIES.map((f) => f.family)), name: text(80).min(1), organisation_id: id.optional(), kit_id: id.optional(), starter: z.enum(Object.keys(STARTERS)).default('classic'), layout: layoutSchema.optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    const fam = FAMILIES.find((f) => f.family === i.family);
    if (!fam.source.available) throw new AppError(409, 'source_unavailable', fam.source.reason);
    await mustScope(user, i.organisation_id, true);
    await checkKitForTemplate(user, i.kit_id, i.organisation_id);
    const c = checkLayout(i.family, i.layout ?? starterFor(i.family, i.starter));
    if (c.error) throw badRequest(c.error);
    const { owner, org } = scopeCols(user, i.organisation_id);
    const row = await one('INSERT INTO document_templates(owner_user_id, organisation_id, family, name, kit_id, draft, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [owner, org, i.family, i.name, i.kit_id ?? null, JSON.stringify(c.layout), user.id]);
    await audit(null, user.id, 'create_document_template', 'document_templates', row.id);
    return tplOf(row.id);
  },
});

cap({
  name: 'update_document_template', method: 'PATCH', path: '/document-templates/:id', tag: TAG,
  summary: 'Edit a template\'s draft (name, brand kit, layout) or archive it. Published versions never change: edit, then publish again for a new version. Send the row_version you last read.',
  input: z.object({ id, row_version: z.number().int(), name: text(80).min(1).optional(), kit_id: id.nullish(), layout: layoutSchema.optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    const t = await tplOf(i.id);
    await mustAccess(user, t, 'Template', { write: true });
    if (i.kit_id !== undefined) await checkKitForTemplate(user, i.kit_id, t.organisation_id);
    let draft = null;
    if (i.layout) { const c = checkLayout(t.family, i.layout); if (c.error) throw badRequest(c.error); draft = JSON.stringify(c.layout); }
    const row = await one(
      `UPDATE document_templates SET name=coalesce($3,name), kit_id=CASE WHEN $4 THEN $5::uuid ELSE kit_id END, draft=coalesce($6::jsonb,draft),
         archived_at = CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN coalesce(archived_at, now()) ELSE NULL END, row_version=row_version+1, updated_at=now()
        WHERE id=$1 AND row_version=$2 RETURNING id`, [i.id, i.row_version, i.name ?? null, i.kit_id !== undefined, i.kit_id ?? null, draft, i.archived ?? null]);
    if (!row) throw conflict('Someone else changed this template; reload it and try again');
    await audit(null, user.id, 'update_document_template', 'document_templates', i.id);
    return tplOf(i.id);
  },
});

cap({
  name: 'publish_document_template', method: 'POST', path: '/document-templates/:id/publish', tag: TAG,
  summary: 'Freeze the current draft as the next immutable version (layout, the brand kit\'s text and colours, and its current logo). Documents are generated from the latest published version; older ones are never altered.',
  input: z.object({ id, row_version: z.number().int() }),
  async handler({ user }, i) {
    const t0 = await tplOf(i.id);
    await mustAccess(user, t0, 'Template', { write: true });
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM document_templates WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (t.row_version !== i.row_version) throw conflict('Someone else changed this template; reload it and try again');
      if (t.archived_at) throw conflict('This template is archived');
      const chk = checkLayout(t.family, t.draft);
      if (chk.error) throw badRequest(chk.error);
      const kit = t.kit_id ? (await c.query(`SELECT ${KIT_COLS} FROM brand_kits WHERE id=$1`, [t.kit_id])).rows[0] : null;
      if (kit?.archived_at) throw conflict('The brand kit is archived; pick another before publishing');
      const snap = kit && Object.fromEntries(['display_name', 'legal_name', 'address', 'contact_email', 'phone', 'website', 'tax_id', 'primary_color', 'secondary_color', 'footer_text'].map((k) => [k, kit[k]]));
      const v = (await c.query('SELECT coalesce(max(version),0)+1 AS v FROM document_template_versions WHERE template_id=$1', [i.id])).rows[0].v;
      await c.query('INSERT INTO document_template_versions(template_id, version, layout, kit_snapshot, logo_asset_id, published_by) VALUES ($1,$2,$3,$4,$5,$6)', [i.id, v, JSON.stringify(chk.layout), snap ? JSON.stringify(snap) : null, kit?.logo_asset_id ?? null, user.id]);
      await c.query("UPDATE document_templates SET status='published', row_version=row_version+1, updated_at=now() WHERE id=$1", [i.id]);
      await audit(c, user.id, 'publish_document_template', 'document_templates', i.id);
      return { template_id: i.id, version: v };
    });
  },
});

cap({
  name: 'retire_document_template', method: 'POST', path: '/document-templates/:id/retire', tag: TAG,
  summary: 'Stop a template being used for new documents. Its versions and everything generated from them are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustAccess(user, await tplOf(i.id), 'Template', { write: true });
    await one("UPDATE document_templates SET status='retired', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id", [i.id]);
    await audit(null, user.id, 'retire_document_template', 'document_templates', i.id);
    return tplOf(i.id);
  },
});

// ---------------------------------------------------------------- invoice PDFs
async function invoiceFor(user, invoiceId) {
  const inv = await one('SELECT i.*, rs.code AS reservation_code FROM invoices i JOIN reservations rs ON rs.id=i.reservation_id WHERE i.id=$1', [invoiceId]);
  if (!inv) throw notFound('Invoice');
  if (inv.user_id !== user.id && !isAdmin(user) && !(await canManage(user, inv.venue_id))) throw notFound('Invoice');
  return inv;
}
const printable = (inv) => ({ ...inv, buyer: buyerOf(inv) });
const loadLogo = async (assetId) => { if (!assetId) return null; const a = await one('SELECT file_name FROM brand_assets WHERE id=$1', [assetId]); return a ? loadEncrypted('brand', 'brand_assets.file', a.file_name) : null; };

const GENERATE = z.object({ invoice_id: id, template_id: id.optional() });
cap({
  name: 'generate_invoice_document', method: 'POST', path: '/branded-documents/invoice', tag: TAG,
  summary: 'Render an invoice or credit note as a branded PDF from a published template version (or the plain classic layout if none is given) and keep the bytes. Amounts, number, parties and lines are the invoice\'s own; this never changes, pays or sends the invoice. Regenerating makes a new document. Download with GET /branded-documents/{id}/file.',
  input: GENERATE,
  async handler({ user }, i) {
    requireApproved(user);
    const inv = await invoiceFor(user, i.invoice_id);
    let ver = null;
    if (i.template_id) {
      const t = await tplOf(i.template_id);
      await mustAccess(user, t, 'Template');
      if (t.family !== 'invoice') throw badRequest('That template is for a different document');
      if (t.status === 'retired' || t.archived_at) throw conflict('That template is retired');
      ver = await one('SELECT * FROM document_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1', [t.id]);
      if (!ver) throw conflict('Publish the template before generating documents from it');
    }
    const layout = ver ? ver.layout : STARTERS.classic;
    const { buffer, pages } = await renderInvoice({ layout, kit: ver?.kit_snapshot ?? null, logo: await loadLogo(ver?.logo_asset_id), invoice: printable(inv) });
    const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
    const row = await one(
      `INSERT INTO generated_documents(id, family, source_type, source_id, template_version_id, logo_asset_id, file_name, size_bytes, sha256, pages, generated_by)
       VALUES ($1,'invoice','invoice',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, family, source_type, source_id, template_version_id, size_bytes, sha256, pages, created_at`,
      [did, inv.id, ver?.id ?? null, ver?.logo_asset_id ?? null, file, buffer.length, createHash('sha256').update(buffer).digest('hex'), pages, user.id]);
    await audit(null, user.id, 'generate_document', 'generated_documents', did);
    return { ...row, url: `/api/v1/branded-documents/${did}/file` };
  },
});

cap({
  name: 'generate_coaching_report_document', method: 'POST', path: '/branded-documents/coaching-report', tag: TAG, auth: ['coach'],
  summary: 'Render a published coaching report version as a branded PDF (from one of your published coaching_report templates, or the plain classic layout) and keep the bytes. The words and figures are the frozen snapshot of that version; a template only chooses presentation. Regenerating makes a new document. Download with GET /branded-documents/{id}/file.',
  input: z.object({ report_id: id, version: z.number().int().min(1).optional().describe('defaults to the latest published version'), template_id: id.optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    const v = await reportVersionFor(i.report_id, i.version);
    if (!v || v.coach_id !== user.id) throw notFound('Report version');
    let ver = null;
    if (i.template_id) {
      const t = await tplOf(i.template_id);
      await mustAccess(user, t, 'Template');
      if (t.family !== 'coaching_report') throw badRequest('That template is for a different document');
      if (t.status === 'retired' || t.archived_at) throw conflict('That template is retired');
      ver = await one('SELECT * FROM document_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1', [t.id]);
      if (!ver) throw conflict('Publish the template before generating documents from it');
    }
    const layout = ver ? ver.layout : starterFor('coaching_report', 'classic');
    const { buffer, pages } = await renderCoachingReport({ layout, kit: ver?.kit_snapshot ?? null, logo: await loadLogo(ver?.logo_asset_id), snapshot: v.snapshot, version: v.version });
    const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
    const row = await one(
      `INSERT INTO generated_documents(id, family, source_type, source_id, source_version, template_version_id, logo_asset_id, file_name, size_bytes, sha256, pages, generated_by)
       VALUES ($1,'coaching_report','coaching_report',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, family, source_type, source_id, source_version, template_version_id, size_bytes, sha256, pages, created_at`,
      [did, v.report_id, v.version, ver?.id ?? null, ver?.logo_asset_id ?? null, file, buffer.length, createHash('sha256').update(buffer).digest('hex'), pages, user.id]);
    await audit(null, user.id, 'generate_document', 'generated_documents', did);
    return { ...row, url: `/api/v1/branded-documents/${did}/file` };
  },
});

cap({
  name: 'list_coaching_report_documents', method: 'GET', path: '/branded-documents/coaching-report', tag: TAG, auth: ['coach'],
  summary: 'PDFs you generated for one coaching report (newest first).', input: z.object({ report_id: id, ...page }),
  async handler({ user }, i) {
    const v = await reportVersionFor(i.report_id, null);
    if (!v || v.coach_id !== user.id) throw notFound('Report');
    const rows = await many('SELECT id, family, source_id, source_version, template_version_id, size_bytes, sha256, pages, created_at FROM generated_documents WHERE source_type=\'coaching_report\' AND source_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [i.report_id, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, url: `/api/v1/branded-documents/${r.id}/file` }));
  },
});

cap({
  name: 'list_generated_documents', method: 'GET', path: '/branded-documents', tag: TAG,
  summary: 'PDFs generated for one invoice (newest first). Only the buyer or the venue team of that invoice can list them.',
  input: z.object({ invoice_id: id, ...page }),
  async handler({ user }, i) {
    const inv = await invoiceFor(user, i.invoice_id);
    const rows = await many('SELECT id, family, source_type, source_id, template_version_id, size_bytes, sha256, pages, generated_by, created_at FROM generated_documents WHERE source_type=\'invoice\' AND source_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [inv.id, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, url: `/api/v1/branded-documents/${r.id}/file` }));
  },
});

/** Binary routes (raw logo upload/serve, PDF preview and download). Same auth and the same access checks as the capabilities above. */
export function brandedDocumentsRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });
  const who = async (req) => { const u = await authenticate(req.headers.authorization); if (!u) throw unauthorized(); return u; };
  const uuid = (v, what) => { if (!/^[0-9a-f-]{36}$/.test(v)) throw notFound(what); return v; };

  // PUT /api/v1/brand-kits/:id/logo   body = the raw PNG or JPEG (≤ 2 MB, 32–4000 px). Replacing keeps the old asset for issued documents.
  r.put('/brand-kits/:id/logo', limiter, async (req, res) => {
    try {
      const user = await who(req); requireApproved(user);
      const kit = await kitOf(uuid(req.params.id, 'Brand kit'));
      await mustAccess(user, kit, 'Brand kit', { write: true });
      if (Number(req.headers['content-length'] ?? 0) > LOGO_LIMITS.bytes) throw new AppError(413, 'too_large', 'Logos can be up to 2 MB');
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      if (buf.length > LOGO_LIMITS.bytes) throw new AppError(413, 'too_large', 'Logos can be up to 2 MB');
      const img = inspectLogo(buf);
      if (!img) throw badRequest('Unsupported logo. Use a PNG or JPEG image (SVG and WebP are not accepted).');
      if (img.width > LOGO_LIMITS.maxPx || img.height > LOGO_LIMITS.maxPx || img.width < LOGO_LIMITS.minPx || img.height < LOGO_LIMITS.minPx) throw badRequest(`Logo must be between ${LOGO_LIMITS.minPx} and ${LOGO_LIMITS.maxPx} pixels on each side`);
      const { id: aid, file } = await saveEncrypted('brand', 'brand_assets.file', buf);
      await tx(async (c) => {
        await c.query('INSERT INTO brand_assets(id, kit_id, content_type, file_name, size_bytes, width_px, height_px, sha256, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [aid, kit.id, img.type, file, buf.length, img.width, img.height, createHash('sha256').update(buf).digest('hex'), user.id]);
        await c.query('UPDATE brand_kits SET logo_asset_id=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [kit.id, aid]);
        await audit(c, user.id, 'upload_brand_logo', 'brand_kits', kit.id);
      });
      const warnings = Math.min(img.width, img.height) < LOGO_LIMITS.recommendedPx ? [`Low resolution (${img.width}×${img.height}); it may look soft in print. ${LOGO_LIMITS.recommendedPx}px or more is recommended.`] : [];
      res.status(201).json({ asset_id: aid, kit_id: kit.id, content_type: img.type, width: img.width, height: img.height, size_bytes: buf.length, warnings, url: `/api/v1/brand-kits/${kit.id}/logo` });
    } catch (e) { req.resume(); fail(res, e); }
  });

  r.get('/brand-kits/:id/logo', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const kit = await kitOf(uuid(req.params.id, 'Brand kit'));
      await mustAccess(user, kit, 'Brand kit');
      const a = kit.logo_asset_id && await one('SELECT * FROM brand_assets WHERE id=$1', [kit.logo_asset_id]);
      if (!a) throw notFound('Logo');
      res.set(docHeaders(a.content_type, Buffer.alloc(a.size_bytes)));
      res.end(await loadEncrypted('brand', 'brand_assets.file', a.file_name));
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Logo') : e); }
  });

  // POST /api/v1/documents/preview  {template_id} | {layout, kit_id?}  -> application/pdf with the same renderer, on made-up SAMPLE data.
  r.post('/branded-documents/preview', limiter, express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const user = await who(req);
      const b = z.object({ template_id: id.optional(), layout: layoutSchema.optional(), kit_id: id.optional() }).refine((x) => !!x.template_id !== !!x.layout, 'Give template_id or layout').parse(req.body ?? {});
      let layout = b.layout, kitRow = null;
      if (b.template_id) { const t = await tplOf(b.template_id); await mustAccess(user, t, 'Template'); layout = t.draft; kitRow = t.kit_id; } else kitRow = b.kit_id ?? null;
      const c = checkLayout('invoice', layout); if (c.error) throw badRequest(c.error);
      let kit = null, logo = null;
      if (kitRow) { const k = await kitOf(kitRow); await mustAccess(user, k, 'Brand kit'); kit = k; logo = await loadLogo(k.logo_asset_id); }
      const now = new Date();
      const sample = { kind: 'invoice', number: 'SAMPLE-0001', issued_at: now, status: 'open', currency: 'USD', reservation_code: null,
        seller: { name: kit?.legal_name ?? kit?.display_name ?? 'Your business', address: kit?.address ?? 'Your address', tax_id: kit?.tax_id ?? null }, buyer: { name: 'Sample customer', address: 'Sample address', tax_id: null },
        lines: [{ description: 'Sample court booking', starts_at: now, amount_cents: 5000, tax_cents: 455 }], tax_name: 'Tax', tax_rate_bp: 1000, tax_inclusive: true, tax_cents: 455, total_cents: 5000, credits_cents: 0 };
      const { buffer } = await renderInvoice({ layout: c.layout, kit, logo, invoice: sample, sample: true });
      res.set(docHeaders('application/pdf', buffer)).end(buffer);
    } catch (e) { fail(res, e); }
  });

  r.get('/branded-documents/:id/file', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const d = await one('SELECT * FROM generated_documents WHERE id=$1', [uuid(req.params.id, 'Document')]);
      if (!d) throw notFound('Document');
      if (d.source_type === 'coaching_report') {
        // live check on every download: the audience the version was published for (or its author), never anyone else
        const v = await reportVersionFor(d.source_id, d.source_version);
        if (!v || !(await canReadReportVersion(user, v))) throw notFound('Document');
      } else if (d.source_type === 'sponsorship_contract') await canReadContractDocument(user, d.source_id); // parties to the agreement only, checked live
      else await invoiceFor(user, d.source_id); // live check on every download: revoked venue-team access ends here
      const bytes = await loadEncrypted('documents', 'generated_documents.file', d.file_name);
      await audit(null, user.id, 'read_pii', 'generated_documents', d.id);
      res.set({ ...docHeaders('application/pdf', bytes), 'Content-Disposition': `attachment; filename="${d.id}.pdf"` });
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Document') : e); }
  });
  return r;
}
