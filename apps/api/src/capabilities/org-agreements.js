// Organisation agreements: a guided drafting flow instead of a text box. Pick a standard template, tailor it (parties, dates, fees, governing
// law, logo via the brand kit, optional AI help), review the overview as PDF or Word, submit it for approval, then store the signed copy.
// Approval is by an owner (so an admin's draft is checked by someone else). Approving a participant-facing agreement also publishes its text as
// a versioned organisation policy, so the existing acknowledgement flow (programmes, families) keeps working. Nothing is ever deleted: drafts
// are archived, files are hidden, every step is audit-logged and signed copies are encrypted on disk.
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
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { orgFor } from '../org-access.js';
import { toMajor, isSupportedCurrency } from '../currency.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { aiConfigured, askJson, quoteData, AI_RULES } from '../ai.js';
import { AGREEMENT_KINDS, AGREEMENT_TEMPLATES, POLICY_KIND, buildAgreementText, templateByKey } from '../agreement-templates.js';
import { renderAgreement } from '../documents/render.js';
import { kitOf, loadLogo, mustAccess } from './branded-documents.js';

const TAG = 'Agreements';
const STAFF = ['owner', 'admin'];
const day = z.string().date();
const text = (n) => z.string().trim().max(n);
const STATUS_LABEL = { draft: 'Draft', submitted: 'Awaiting approval', changes_requested: 'Changes requested', approved: 'Approved', rejected: 'Rejected', signed: 'Signed' };
const EDITABLE = ['draft', 'changes_requested'];
const party = z.object({ role: text(60).min(1), name: text(160).min(1), user_id: id.optional() });
const refOf = (a) => `AGR-${a.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
const fileUrl = (f) => `/api/v1/org-agreement-files/${f.id}`;

const terms = {
  title: text(120).min(2), body: text(30000), counterparty: text(160), effective_from: day, effective_to: day, auto_renew: z.boolean(),
  governing_country: z.union([z.string().regex(/^[A-Z]{2}$/, 'two-letter country code'), z.literal('')]), brand_kit_id: id,
};

async function agreementFor(user, agreementId, { write = false, roles = STAFF, c } = {}) {
  const q = c ? (...a) => c.query(...a).then((r) => r.rows[0]) : one;
  const a = await q('SELECT * FROM org_agreements WHERE id=$1', [agreementId]);
  if (!a) throw notFound('Agreement');
  const { org, role } = await orgFor(user, a.organisation_id, roles, { write, c }).catch((e) => { throw e.status === 403 ? e : notFound('Agreement'); });
  return { a, org, role };
}

const partiesOf = (agreementId) => many('SELECT role, name, user_id FROM org_agreement_parties WHERE agreement_id=$1 AND removed_at IS NULL ORDER BY position, id', [agreementId]);
const filesOf = async (agreementId) => (await many('SELECT id, kind, label, content_type, size_bytes, sha256, uploaded_by, created_at FROM org_agreement_files WHERE agreement_id=$1 AND hidden_at IS NULL ORDER BY created_at DESC', [agreementId])).map((f) => ({ ...f, url: fileUrl(f) }));
async function savePartiesTx(c, agreementId, list) {
  await c.query('UPDATE org_agreement_parties SET removed_at=now() WHERE agreement_id=$1 AND removed_at IS NULL', [agreementId]); // the replaced list stays on record
  let n = 0;
  for (const p of list) await c.query('INSERT INTO org_agreement_parties(agreement_id, role, name, user_id, position) VALUES ($1,$2,$3,$4,$5)', [agreementId, p.role, p.name, p.user_id ?? null, n++]);
}
async function checkKit(user, kitId, orgId) {
  if (!kitId) return;
  const k = await kitOf(kitId);
  await mustAccess(user, k, 'Brand kit');
  if (k.owner_user_id || k.organisation_id !== orgId) throw badRequest('Pick one of this organisation\'s brand kits');
}

const view = async (a) => ({
  ...a, ref: refOf(a), status_label: STATUS_LABEL[a.status], parties: await partiesOf(a.id), files: await filesOf(a.id),
  export: { pdf: `/api/v1/org-agreements/${a.id}/export?format=pdf`, doc: `/api/v1/org-agreements/${a.id}/export?format=doc` },
});

/** Everything the overview prints, frozen at the moment it is rendered. */
async function snapshotOf(a, org) {
  const parties = await partiesOf(a.id);
  const addr = await one("SELECT line1, line2, area, locality, region, postal_code, country FROM addresses WHERE owner_kind='organisation' AND owner_id=$1 AND archived_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1", [org.id]);
  const address = addr ? [addr.line1, addr.line2, addr.area, addr.locality, addr.region, addr.postal_code].filter(Boolean).join(', ') : org.city ?? null;
  const tpl = templateByKey(a.template_key);
  const ds = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const facts = [
    { title: 'Agreement type', value: tpl?.title ?? a.kind.replace(/_/g, ' ') },
    { title: 'Organisation', value: org.legal_name || org.name },
    ...(a.counterparty ? [{ title: 'Other party', value: a.counterparty }] : []),
    { title: 'Effective from', value: ds(a.effective_from) ?? 'On signature' },
    { title: 'Ends', value: ds(a.effective_to) ? `${ds(a.effective_to)}${a.auto_renew ? ' (renews automatically)' : ''}` : 'Until ended by notice' },
    ...(a.governing_country ? [{ title: 'Governing law', value: new Intl.DisplayNames(['en'], { type: 'region' }).of(a.governing_country) }] : []),
    { title: 'Status', value: STATUS_LABEL[a.status] },
  ];
  return {
    title: a.title, organisation: org.name, legal_name: org.legal_name, address, contact_email: org.contact_email, contact_phone: org.contact_phone, website: org.website,
    reference: refOf(a), status: STATUS_LABEL[a.status], issued_at: new Date().toISOString(), facts, parties, body: a.body,
  };
}
async function kitFor(a, orgId) {
  const kit = a.brand_kit_id ? await kitOf(a.brand_kit_id) : await one('SELECT * FROM brand_kits WHERE organisation_id=$1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1', [orgId]);
  return { kit: kit ?? null, logo: await loadLogo(kit?.logo_asset_id) };
}
async function renderPdf(a, org) {
  const { kit, logo } = await kitFor(a, org.id);
  return renderAgreement({ kit, logo, snapshot: await snapshotOf(a, org) });
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
/** A Word-compatible document (HTML that Word, Pages and Google Docs open and edit) with the same overview, text and signature lines. */
async function renderDoc(a, org) {
  const s = await snapshotOf(a, org);
  const { kit } = await kitFor(a, org.id);
  const accent = /^#[0-9A-Fa-f]{6}$/.test(kit?.primary_color ?? '') ? kit.primary_color : '#0F6E56';
  const paras = String(s.body).split(/\n{2,}/).map((b) => {
    const m = /^(\d+\.\s+[^\n]{1,80})\n([\s\S]+)$/.exec(b.trim());
    return m ? `<h3 style="color:${accent}">${esc(m[1])}</h3><p>${esc(m[2]).replace(/\n/g, '<br>')}</p>` : /^\d+\.\s+.{1,80}$/.test(b.trim()) ? `<h3 style="color:${accent}">${esc(b.trim())}</h3>` : `<p>${esc(b).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  const signers = [{ role: 'For the organisation', name: s.legal_name ?? s.organisation }, ...s.parties];
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(s.title)}</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}td{padding:3pt 8pt 3pt 0;vertical-align:top}</style></head><body>
<p style="color:${accent};font-size:15pt;font-weight:bold">${esc(kit?.display_name ?? s.organisation)}</p><p style="font-size:9pt">${esc([kit?.legal_name ?? s.legal_name, kit?.address ?? s.address, kit?.contact_email ?? s.contact_email, kit?.phone ?? s.contact_phone, kit?.website ?? s.website].filter(Boolean).join(' · '))}</p><hr>
<h1 style="color:${accent}">${esc(s.title)}</h1><p style="font-size:9pt">Ref ${esc(s.reference)} · ${esc(s.status)}</p>
<table>${s.facts.map((f) => `<tr><td><b>${esc(f.title)}</b></td><td>${esc(f.value)}</td></tr>`).join('')}</table><hr>
${paras}
<h3 style="color:${accent}">Signatures</h3><table>${signers.map((p) => `<tr><td style="padding-top:28pt"><b>${esc(p.name)}</b><br>${esc(p.role)}<br>Signature: ____________________ Date: ____________</td></tr>`).join('')}</table>
<p style="font-size:8pt;color:#777">${esc(kit?.footer_text || 'Template wording, not legal advice. Have it reviewed for your situation.')}</p></body></html>`;
  return Buffer.from(html, 'utf8');
}

// ------------------------------------------------------------------ catalogue and drafting
cap({
  name: 'list_agreement_templates', method: 'GET', path: '/agreement-templates', tag: TAG, auth: 'user',
  summary: 'The standard agreement templates (participation terms, code of conduct, refund policy, media consent, equipment, pick-up, programme declaration, player registration, coaching services, venue hire, event entry, custom) with their section headings. General wording, not legal advice.',
  input: z.object({}),
  handler: () => AGREEMENT_TEMPLATES.map((t) => ({ key: t.key, kind: t.kind, title: t.title, summary: t.summary, other_party: t.other, sections: t.clauses.map(([h]) => h), published_for_acknowledgement: !!t.publish })),
});

cap({
  name: 'draft_agreement_text', method: 'POST', path: '/organisations/:id/agreements/draft-text', tag: TAG,
  summary: 'Produce the agreement text from a template and the wizard answers (owner/admin). Optionally ask AI to tailor it to your instructions; without AI, or if AI is unavailable, you get the standard wording with your details filled in. AI never sees personal names: the other party is substituted afterwards.',
  input: z.object({
    id, template_key: z.string().max(40).default('blank'), counterparty: terms.counterparty.optional(), effective_from: day.optional(), effective_to: day.optional(), auto_renew: z.boolean().default(false),
    governing_country: terms.governing_country.optional(), fee_minor: z.number().int().min(0).max(1e12).optional(), currency: z.string().length(3).toUpperCase().optional(),
    instructions: text(800).optional().describe('what to add or change, in your own words'), use_ai: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    const { org } = await orgFor(user, i.id, STAFF, { write: true });
    const template = templateByKey(i.template_key);
    if (!template) throw badRequest('Unknown template');
    if (i.effective_from && i.effective_to && i.effective_to < i.effective_from) throw badRequest('The end date is before the start date');
    if ((i.fee_minor != null) !== !!i.currency && i.fee_minor) throw badRequest('Choose a currency for the fee');
    if (i.currency && !isSupportedCurrency(i.currency)) throw badRequest('Unsupported currency');
    const feeText = i.fee_minor ? `The fee is ${i.currency} ${toMajor(i.fee_minor, i.currency)}, payable as agreed between the parties.` : null;
    const base = { template, organisation: org.name, legalName: org.legal_name, start: i.effective_from, end: i.effective_to, autoRenew: i.auto_renew, country: i.governing_country || null, feeText };
    const standard = buildAgreementText({ ...base, counterparty: i.counterparty });
    if (!i.use_ai || !aiConfigured()) return { body: standard, ai: false, ai_available: aiConfigured() };
    const TOKEN = '[OTHER PARTY]';
    const out = await askJson({
      system: `You are a careful drafting assistant for sports clubs and academies. Adapt the agreement below to the instructions. Keep it plain-English, numbered with headings like "1. Heading", fair to both sides, and do not invent facts, amounts, dates or legal citations. Keep the placeholder ${TOKEN} unchanged. ${AI_RULES}`,
      user: `<data>Instructions: ${quoteData(i.instructions || 'Tailor the wording for a ' + template.title.toLowerCase() + ' and keep it concise.', 800)}\n\nAgreement:\n${buildAgreementText({ ...base, counterparty: TOKEN })}</data>`,
      schema: z.object({ body: z.string().min(50).max(30000) }), shape: '{"body": "the full agreement text"}', maxTokens: 4000,
    });
    if (!out) return { body: standard, ai: false, ai_available: true };
    return { body: out.body.replaceAll(TOKEN, i.counterparty || `the ${template.other}`), ai: true, ai_available: true };
  },
});

// ------------------------------------------------------------------ the agreement itself
cap({
  name: 'create_org_agreement', method: 'POST', path: '/organisations/:id/agreements', tag: TAG, status: 201,
  summary: 'Save an agreement draft from the wizard (owner/admin): type, text, parties, effective and end dates, renewal, governing law and the brand kit whose logo and letterhead to use. Nothing is visible to anyone else until it is submitted and approved.',
  input: z.object({
    id, kind: z.enum(AGREEMENT_KINDS), template_key: z.string().max(40).optional(), title: terms.title, body: terms.body.default(''), counterparty: terms.counterparty.optional(), parties: z.array(party).max(10).default([]),
    effective_from: day.optional(), effective_to: day.optional(), auto_renew: terms.auto_renew.default(false), governing_country: terms.governing_country.optional(), brand_kit_id: terms.brand_kit_id.optional(), ai_assisted: z.boolean().default(false),
    policy_id: id.optional().describe('revise this published policy: approval publishes a new version of it'),
  }).refine((v) => !v.effective_from || !v.effective_to || v.effective_to >= v.effective_from, { message: 'The end date is before the start date', path: ['effective_to'] }),
  handler: ({ user }, i) => tx(async (c) => {
    requireApproved(user);
    await orgFor(user, i.id, STAFF, { write: true, c });
    await checkKit(user, i.brand_kit_id, i.id);
    if (i.policy_id && !(await c.query('SELECT 1 FROM org_policies WHERE id=$1 AND organisation_id=$2 AND archived_at IS NULL', [i.policy_id, i.id])).rowCount) throw notFound('Policy');
    const a = (await c.query(
      `INSERT INTO org_agreements(organisation_id, kind, title, template_key, body, counterparty, effective_from, effective_to, auto_renew, governing_country, brand_kit_id, ai_assisted, policy_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [i.id, i.kind, i.title, i.template_key ?? null, i.body, i.counterparty || null, i.effective_from ?? null, i.effective_to ?? null, i.auto_renew, i.governing_country || null, i.brand_kit_id ?? null, i.ai_assisted, i.policy_id ?? null, user.id])).rows[0];
    await savePartiesTx(c, a.id, i.parties);
    await audit(c, user.id, 'create_org_agreement', 'org_agreements', a.id);
    return { ...a, ref: refOf(a), status_label: STATUS_LABEL[a.status], parties: i.parties, files: [] };
  }),
});

cap({
  name: 'update_org_agreement', method: 'PATCH', path: '/org-agreements/:id', tag: TAG,
  summary: 'Change a draft, or one sent back with changes requested (owner/admin). Send only what changes; parties replace the list. Submitted, approved and signed agreements are fixed.',
  input: z.object({
    id, title: terms.title.optional(), body: terms.body.optional(), counterparty: terms.counterparty.optional(), parties: z.array(party).max(10).optional(), effective_from: day.nullable().optional(), effective_to: day.nullable().optional(),
    auto_renew: terms.auto_renew.optional(), governing_country: terms.governing_country.optional(), brand_kit_id: terms.brand_kit_id.nullable().optional(), ai_assisted: z.boolean().optional(), row_version: z.number().int().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await agreementFor(user, i.id, { write: true, c });
    if (!EDITABLE.includes(a.status)) throw conflict('Only a draft, or one sent back for changes, can be edited');
    if (i.row_version !== undefined && i.row_version !== a.row_version) throw conflict('Someone changed this agreement. Reload and try again.');
    await checkKit(user, i.brand_kit_id, a.organisation_id);
    const next = { ...a, ...Object.fromEntries(['title', 'body', 'counterparty', 'effective_from', 'effective_to', 'auto_renew', 'governing_country', 'brand_kit_id', 'ai_assisted'].filter((k) => i[k] !== undefined).map((k) => [k, i[k] === '' ? null : i[k]])) };
    const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    if (dayOf(next.effective_from) && dayOf(next.effective_to) && dayOf(next.effective_to) < dayOf(next.effective_from)) throw badRequest('The end date is before the start date');
    const row = (await c.query(
      `UPDATE org_agreements SET title=$2, body=$3, counterparty=$4, effective_from=$5, effective_to=$6, auto_renew=$7, governing_country=$8, brand_kit_id=$9, ai_assisted=$10, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *`,
      [a.id, next.title, next.body, next.counterparty, next.effective_from, next.effective_to, next.auto_renew, next.governing_country, next.brand_kit_id, next.ai_assisted])).rows[0];
    if (i.parties) await savePartiesTx(c, a.id, i.parties);
    await audit(c, user.id, 'update_org_agreement', 'org_agreements', a.id);
    return view(row);
  }),
});

cap({
  name: 'list_org_agreements', method: 'GET', path: '/organisations/:id/agreements', tag: TAG,
  summary: 'The organisation\'s agreements, newest first, with status (owner/admin). Archived ones are left out unless include_archived.',
  input: z.object({ id, status: z.enum(['draft', 'submitted', 'changes_requested', 'approved', 'rejected', 'signed']).optional(), include_archived: z.boolean().default(false), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    const rows = await many(
      `SELECT a.id, a.kind, a.title, a.template_key, a.counterparty, a.effective_from, a.effective_to, a.status, a.submitted_at, a.decided_at, a.decision_note, a.policy_id, a.archived_at, a.created_at, a.updated_at,
              (SELECT count(*)::int FROM org_agreement_files f WHERE f.agreement_id=a.id AND f.kind='signed' AND f.hidden_at IS NULL) AS signed_files
         FROM org_agreements a WHERE a.organisation_id=$1 AND ($2::text IS NULL OR a.status=$2) AND ($3 OR a.archived_at IS NULL) ORDER BY a.created_at DESC, a.id LIMIT $4 OFFSET $5`, [i.id, i.status ?? null, i.include_archived, i.limit, i.offset]);
    return rows.map((r) => ({ ...r, ref: refOf(r), status_label: STATUS_LABEL[r.status] }));
  },
});

cap({
  name: 'get_org_agreement', method: 'GET', path: '/org-agreements/:id', tag: TAG,
  summary: 'One agreement with its text, parties, signed and supporting files and links to export it as PDF or Word (owner/admin).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { a } = await agreementFor(user, i.id);
    return view(a);
  },
});

cap({
  name: 'submit_org_agreement', method: 'POST', path: '/org-agreements/:id/submit', tag: TAG,
  summary: 'Send the agreement for approval (owner/admin). The overview PDF is produced and kept as it was submitted, and the organisation\'s owners are told.',
  input: z.object({ id }),
  async handler({ user }, i) {
    requireApproved(user);
    const { a, org } = await agreementFor(user, i.id, { write: true });
    if (!EDITABLE.includes(a.status)) throw conflict('This agreement has already been submitted');
    if (a.body.trim().length < 50) throw badRequest('Add the agreement text before submitting');
    const submitted = { ...a, status: 'submitted' };
    const { buffer, pages } = await renderPdf(submitted, org);
    const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
    return tx(async (c) => {
      await c.query(
        `INSERT INTO generated_documents(id, family, source_type, source_id, file_name, size_bytes, sha256, pages, generated_by) VALUES ($1,'agreement','org_agreement',$2,$3,$4,$5,$6,$7)`,
        [did, a.id, file, buffer.length, createHash('sha256').update(buffer).digest('hex'), pages, user.id]);
      const row = (await c.query("UPDATE org_agreements SET status='submitted', submitted_by=$2, submitted_at=now(), document_id=$3, decision_note=NULL, updated_at=now(), row_version=row_version+1 WHERE id=$1 AND status = ANY($4) RETURNING *", [a.id, user.id, did, EDITABLE])).rows[0];
      if (!row) throw conflict('This agreement has already been submitted');
      for (const o of (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND role='owner' AND status='active' AND user_id<>$2", [org.id, user.id])).rows) {
        await notify(c, o.user_id, { kind: 'agreement_submitted', title: `Agreement awaiting approval: ${a.title}`, body: `${org.name} has an agreement waiting for your approval.`, data: { organisation_id: org.id, agreement_id: a.id } });
      }
      await audit(c, user.id, 'submit_org_agreement', 'org_agreements', a.id);
      return view(row);
    });
  },
});

cap({
  name: 'decide_org_agreement', method: 'POST', path: '/org-agreements/:id/decision', tag: TAG,
  summary: 'Approve, reject or send back a submitted agreement (owner only). Approving publishes participant-facing agreements as a versioned organisation policy so families can acknowledge it; sending back needs a note and reopens editing.',
  input: z.object({ id, decision: z.enum(['approve', 'request_changes', 'reject']), note: text(1000).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a, org } = await agreementFor(user, i.id, { write: true, roles: ['owner'], c });
    if (a.status !== 'submitted') throw conflict('Only a submitted agreement can be decided');
    if (i.decision !== 'approve' && !i.note?.trim()) throw badRequest('Say why, so the author knows what to do next');
    const status = { approve: 'approved', request_changes: 'changes_requested', reject: 'rejected' }[i.decision];
    let policyId = a.policy_id;
    if (i.decision === 'approve' && (a.policy_id || ['participation', 'code_of_conduct', 'refund_policy', 'media_consent', 'equipment', 'pickup', 'programme_declaration'].includes(a.kind))) {
      const sha = createHash('sha256').update(a.body).digest('hex');
      if (policyId) {
        const p = (await c.query('SELECT * FROM org_policies WHERE id=$1 FOR UPDATE', [policyId])).rows[0];
        const n = p.current_version + 1;
        await c.query('INSERT INTO org_policy_versions(policy_id, version, body, body_sha256, requires_reconsent, published_by) VALUES ($1,$2,$3,$4,true,$5)', [p.id, n, a.body, sha, user.id]);
        await c.query('UPDATE org_policies SET current_version=$2, title=$3 WHERE id=$1', [p.id, n, a.title]);
      } else {
        const purpose = templateByKey(a.template_key)?.publish ?? (a.kind === 'media_consent' ? 'media' : 'participation');
        const p = (await c.query('INSERT INTO org_policies(organisation_id, kind, title, consent_purpose, current_version, created_by) VALUES ($1,$2,$3,$4,1,$5) RETURNING id', [org.id, POLICY_KIND(a.kind), a.title, purpose, user.id])).rows[0];
        await c.query('INSERT INTO org_policy_versions(policy_id, version, body, body_sha256, published_by) VALUES ($1,1,$2,$3,$4)', [p.id, a.body, sha, user.id]);
        policyId = p.id;
      }
    }
    const row = (await c.query('UPDATE org_agreements SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, policy_id=$5, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *', [a.id, status, user.id, i.note?.trim() || null, policyId])).rows[0];
    if (a.submitted_by && a.submitted_by !== user.id) {
      await notify(c, a.submitted_by, { kind: 'agreement_decided', title: `${a.title}: ${STATUS_LABEL[status].toLowerCase()}`, body: i.note?.trim() || `Your agreement was ${STATUS_LABEL[status].toLowerCase()}.`, data: { organisation_id: org.id, agreement_id: a.id } });
    }
    await audit(c, user.id, `${i.decision}_org_agreement`, 'org_agreements', a.id);
    return view(row);
  }),
});

cap({
  name: 'archive_org_agreement', method: 'DELETE', path: '/org-agreements/:id', tag: TAG,
  summary: 'Remove a draft, rejected or finished agreement from the list (owner/admin). It is kept on record; an approved policy stays published.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await agreementFor(user, i.id, { write: true, c });
    if (a.status === 'submitted') throw conflict('Decide or withdraw a submitted agreement before archiving it');
    await c.query('UPDATE org_agreements SET archived_at=coalesce(archived_at, now()), updated_at=now() WHERE id=$1', [a.id]);
    await audit(c, user.id, 'archive_org_agreement', 'org_agreements', a.id);
    return { id: a.id, archived: true };
  }),
});

cap({
  name: 'hide_org_agreement_file', method: 'DELETE', path: '/org-agreement-files/:id', tag: TAG,
  summary: 'Hide an uploaded file from the agreement (owner/admin). The file is kept on record.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const f = (await c.query('SELECT * FROM org_agreement_files WHERE id=$1 AND hidden_at IS NULL', [i.id])).rows[0];
    if (!f) throw notFound('File');
    await agreementFor(user, f.agreement_id, { write: true, c });
    await c.query('UPDATE org_agreement_files SET hidden_at=now() WHERE id=$1', [f.id]);
    await audit(c, user.id, 'hide_org_agreement_file', 'org_agreement_files', f.id);
    return { id: f.id, hidden: true };
  }),
});

/** Binary routes: export as PDF / Word, upload a signed copy or supporting file, download one. Same access checks as the capabilities. */
export function orgAgreementsRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });
  const who = async (req) => { const u = await authenticate(req.headers.authorization); if (!u) throw unauthorized(); return u; };
  const uuid = (v, what) => { if (!/^[0-9a-f-]{36}$/.test(v)) throw notFound(what); return v; };

  // GET /api/v1/org-agreements/:id/export?format=pdf|doc  — what was submitted once it is submitted, the live draft before that
  r.get('/org-agreements/:id/export', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const format = z.enum(['pdf', 'doc']).default('pdf').parse(req.query.format ?? 'pdf');
      const { a, org } = await agreementFor(user, uuid(req.params.id, 'Agreement'));
      let bytes;
      if (format === 'pdf' && a.document_id && !EDITABLE.includes(a.status) && a.status === 'submitted') {
        const d = await one('SELECT file_name FROM generated_documents WHERE id=$1', [a.document_id]);
        bytes = await loadEncrypted('documents', 'generated_documents.file', d.file_name);
      } else bytes = format === 'pdf' ? (await renderPdf(a, org)).buffer : await renderDoc(a, org);
      await audit(null, user.id, 'export_org_agreement', 'org_agreements', a.id);
      const name = `${refOf(a)}-${a.title.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}.${format === 'pdf' ? 'pdf' : 'doc'}`;
      res.set({ ...docHeaders(format === 'pdf' ? 'application/pdf' : 'application/msword', bytes), 'Content-Disposition': `attachment; filename="${name}"` }).end(bytes);
    } catch (e) { fail(res, e); }
  });

  // PUT /api/v1/org-agreements/:id/files?kind=signed&label=…   body = the raw PDF or photo (≤ 10 MB). A signed copy of an approved agreement marks it signed.
  r.put('/org-agreements/:id/files', limiter, async (req, res) => {
    try {
      const user = await who(req); requireApproved(user);
      const q = z.object({ kind: z.enum(['signed', 'supporting']).default('signed'), label: text(120).optional() }).parse(req.query);
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', 'File too large');
      const { a } = await agreementFor(user, uuid(req.params.id, 'Agreement'), { write: true });
      if (a.status === 'draft' || a.status === 'rejected') throw conflict('Submit the agreement for approval first');
      if (q.kind === 'signed' && !['approved', 'signed'].includes(a.status)) throw conflict('A signed copy can be added once the agreement is approved');
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniffDoc(buf);
      if (!t) throw badRequest('Unsupported file. Use a PDF or a JPEG, PNG, WebP or GIF photo of the signed pages.');
      const { id: did, file } = await saveEncrypted('org-agreements', 'org_agreement_files.file', buf);
      const row = await tx(async (c) => {
        const f = (await c.query(
          'INSERT INTO org_agreement_files(id, agreement_id, kind, label, content_type, file_name, size_bytes, sha256, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, kind, label, content_type, size_bytes, sha256, uploaded_by, created_at',
          [did, a.id, q.kind, q.label ?? null, t.type, file, buf.length, createHash('sha256').update(buf).digest('hex'), user.id])).rows[0];
        if (q.kind === 'signed' && a.status === 'approved') await c.query("UPDATE org_agreements SET status='signed', updated_at=now(), row_version=row_version+1 WHERE id=$1", [a.id]);
        await audit(c, user.id, 'upload_org_agreement_file', 'org_agreement_files', did);
        return f;
      });
      res.status(201).json({ ...row, url: fileUrl(row) });
    } catch (e) { req.resume(); fail(res, e); }
  });

  r.get('/org-agreement-files/:id', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const f = await one('SELECT * FROM org_agreement_files WHERE id=$1 AND hidden_at IS NULL', [uuid(req.params.id, 'File')]);
      if (!f) throw notFound('File');
      await agreementFor(user, f.agreement_id);
      const bytes = await loadEncrypted('org-agreements', 'org_agreement_files.file', f.file_name);
      await audit(null, user.id, 'read_pii', 'org_agreement_files', f.id);
      res.set({ ...docHeaders(f.content_type, bytes), 'Content-Disposition': `attachment; filename="${f.kind}-${f.id.slice(0, 8)}.${f.content_type === 'application/pdf' ? 'pdf' : f.content_type.split('/')[1]}"` }).end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('File') : e); }
  });
  return r;
}
