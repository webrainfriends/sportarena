// Branded sponsorship contracts and signatures (#295), on top of the versioned agreements (#145) and the branded-document system (#249).
// A contract freezes ONE terms version of an agreement (snapshot + SHA-256). It is a DRAFT until every named signatory has signed; signing
// re-checks live authority, is idempotent, and ends in an immutable signed PDF + one evidence row per signature. Nothing here changes the
// agreement's terms, schedule, payments or acceptance: the contract is evidence about the text, never a ledger.
import { createHash } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { requireApproved } from '../access.js';
import { cap, id, page } from '../registry.js';
import { one, many, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { saveEncrypted, loadEncrypted } from '../doc-store.js';
import { notify } from '../notify.js';
import { dealContext, logHistory, loadLines } from '../sponsor-agreements.js';
import { sponsorRecipients } from '../sponsor-access.js';
import { ORG_TARGETS, targetOrgId } from '../sponsor-beneficiaries.js';
import { starterFor } from '../documents/layout.js';
import { renderSponsorshipContract } from '../documents/render.js';
import { PROVIDERS, providerList, verifyCallback } from '../signatures/providers.js';

const TAG = 'Sponsorship contracts';
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** JSON with sorted keys, so the same content always hashes the same whatever order the database returns it in. */
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
const OPEN_DEAL = ['proposed', 'active'];
const COLS = 'c.id, c.sponsorship_id, c.terms_version, c.status, c.snapshot_sha256, c.document_id, c.template_version_id, c.created_by, c.requested_at, c.signed_at, c.voided_at, c.void_reason, c.row_version, c.created_at';
const fileUrl = (docId) => `/api/v1/branded-documents/${docId}/file`;

/** The caller's side of a deal as a contract party, or null. Recipient-side parties are the target owner / organisation representatives. */
async function partyOf(c, sponsorshipId, userId) {
  let ctx;
  try { ctx = await dealContext(c, sponsorshipId, { id: userId, roles: [] }); } catch { return null; } // a fake non-admin user: admins are never signatories
  if (ctx.role === 'sponsor') { try { ctx.need('sign_contract', 'sign contracts for this brand'); } catch { return null; } return 'sponsor'; }
  return ctx.role === 'recipient' && bindsRecipient(ctx) ? 'recipient' : null;
}

/** Who may bind the recipient: the target owner, or for an organisation / group the owners and admins. A payee (a finance member who only confirms money) is on the deal but cannot sign or issue for the organisation. */
const bindsRecipient = (ctx) => !ctx.beneficiary || ctx.beneficiary.representative;

/** Who may issue, void and send a contract: the sponsor's contract-capable staff or the recipient side. Admins can read, not bind. */
function mustManage(ctx) {
  if (ctx.role === 'sponsor') ctx.need('contract', 'issue contracts for this brand');
  else if (ctx.role !== 'recipient') throw forbidden('Only the parties to this sponsorship can issue contracts');
  else if (!bindsRecipient(ctx)) throw forbidden('Only an owner or admin of the receiving organisation can issue contracts for it');
}
/** An agreement still waiting on the brand's internal budget approval is invisible to the recipient. */
const hiddenFromRecipient = (ctx) => ctx.role === 'recipient' && ['pending', 'rejected'].includes(ctx.d.budget_approval);

async function recipientName(c, d) {
  const q = { event: 'SELECT name FROM events WHERE id=$1', team: 'SELECT name FROM teams WHERE id=$1', athlete: 'SELECT display_name AS name FROM users WHERE id=$1', organisation: 'SELECT name FROM organisations WHERE id=$1', group: 'SELECT name FROM org_cohorts WHERE id=$1' }[d.target_type];
  return (await c.query(q, [d.target_id])).rows[0]?.name ?? null;
}

async function buildSnapshot(c, ctx) {
  const { d, sp } = ctx;
  const ident = (await c.query('SELECT display_name, legal_name FROM sponsorship_identity_snapshots WHERE sponsorship_id=$1 AND version=$2', [d.id, d.terms_version])).rows[0];
  const lines = (await loadLines(c, d.id, d.terms_version)).map((l) => ({
    kind: l.kind, label: l.label, currency: l.currency ?? d.currency ?? null, amount_cents: l.amount_cents != null ? Number(l.amount_cents) : null, total_cents: l.total_cents != null ? Number(l.total_cents) : null,
    estimate_cents: l.estimate_cents != null ? Number(l.estimate_cents) : null, quantity: l.quantity ?? null, unit: l.unit ?? null, cadence: l.cadence, instalments: l.instalments ?? null,
    first_due_on: l.first_due_on ?? null, custom_dates: l.custom_dates ?? null, promoter: l.promoter ?? null,
  }));
  return {
    ref: d.agreement_ref ?? null, terms_version: d.terms_version, generated_at: new Date().toISOString(),
    sponsor: { name: ident?.display_name ?? sp.name, legal_name: ident?.legal_name ?? null },
    recipient: { type: d.target_type, name: await recipientName(c, d) },
    period: { starts_on: d.starts ?? null, ends_on: d.ends ?? null, timezone: d.timezone ?? null }, currency: d.currency ?? null,
    objectives: d.objectives ?? null, deliverables: d.deliverables ?? null, lines,
  };
}

const loadLogo = async (assetId) => { if (!assetId) return null; const a = (await pool.query('SELECT file_name FROM brand_assets WHERE id=$1', [assetId])).rows[0]; return a ? loadEncrypted('brand', 'brand_assets.file', a.file_name) : null; };
const pinnedTemplate = async (c, versionId) => (versionId ? (await c.query('SELECT * FROM document_template_versions WHERE id=$1', [versionId])).rows[0] : null);

async function storeDocument(c, { buffer, pages, contractId, version, templateVersionId, logoAssetId, userId }) {
  const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
  await c.query(
    `INSERT INTO generated_documents(id, family, source_type, source_id, source_version, template_version_id, logo_asset_id, file_name, size_bytes, sha256, pages, generated_by)
     VALUES ($1,'sponsorship_agreement','sponsorship_contract',$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [did, contractId, version, templateVersionId, logoAssetId, file, buffer.length, sha(buffer), pages, userId]);
  return { id: did, sha256: sha(buffer) };
}

/** A contract as the API shows it. `current` = it is for the agreement's latest terms; `stale` = not yet signed and the terms moved on. */
async function view(c, row, ctx, userId) {
  const d = ctx.d;
  const sigs = (await c.query(
    `SELECT g.id, g.side, g.user_id, u.display_name AS name, g.capacity, g.status, s.signed_at, s.provider
       FROM sponsorship_signatories g JOIN users u ON u.id=g.user_id LEFT JOIN sponsorship_signatures s ON s.signatory_id=g.id
      WHERE g.contract_id=$1 AND g.status <> 'removed' ORDER BY g.side DESC, g.created_at, g.id`, [row.id])).rows;
  const mine = sigs.find((s) => s.user_id === userId);
  const signedDoc = row.status === 'signed' ? (await c.query('SELECT document_id, sha256 FROM sponsorship_signed_documents WHERE contract_id=$1', [row.id])).rows[0] : null;
  const current = row.terms_version === d.terms_version;
  const stale = !current && ['draft', 'awaiting_signatures'].includes(row.status);
  let canManage = false;
  try { mustManage(ctx); canManage = ['draft', 'awaiting_signatures'].includes(row.status); } catch { /* read-only for this caller */ }
  return {
    ...row, signed_state: row.status === 'signed' ? 'signed' : 'unsigned', current, stale, accepted_terms_version: d.accepted_version ?? null,
    draft_url: fileUrl(row.document_id), signed_url: signedDoc ? fileUrl(signedDoc.document_id) : null, signed_sha256: signedDoc?.sha256 ?? null,
    signatories: sigs, my_signatory_id: mine?.id ?? null,
    can: { manage: canManage, sign: !!mine && mine.status === 'pending' && row.status === 'awaiting_signatures' && !stale },
    snapshot: undefined,
  };
}

async function contractFor(c, contractId, user, { lock = false } = {}) {
  const row = (await c.query(`SELECT ${COLS} FROM sponsorship_contracts c WHERE c.id=$1${lock ? ' FOR UPDATE' : ''}`, [contractId])).rows[0];
  if (!row) throw notFound('Contract');
  let ctx;
  try { ctx = await dealContext(c, row.sponsorship_id, user); } catch { throw notFound('Contract'); } // outsiders learn nothing, not even that it exists
  if (hiddenFromRecipient(ctx)) throw notFound('Contract');
  return { row, ctx };
}

/** Every named signatory has signed and each side has at least one signature -> seal the contract. */
async function sealIfComplete(c, row, actorId) {
  const left = (await c.query("SELECT count(*)::int AS n FROM sponsorship_signatories WHERE contract_id=$1 AND status='pending'", [row.id])).rows[0].n;
  const sides = (await c.query("SELECT DISTINCT side FROM sponsorship_signatories WHERE contract_id=$1 AND status='signed'", [row.id])).rows.length;
  if (left > 0 || sides < 2) return false;
  const snap = (await c.query('SELECT snapshot FROM sponsorship_contracts WHERE id=$1', [row.id])).rows[0].snapshot;
  const ver = await pinnedTemplate(c, row.template_version_id);
  const sigs = (await c.query(
    `SELECT s.side, u.display_name AS name, g.capacity, s.signed_at, s.provider, s.provider_ref FROM sponsorship_signatures s JOIN users u ON u.id=s.user_id JOIN sponsorship_signatories g ON g.id=s.signatory_id
      WHERE s.contract_id=$1 ORDER BY s.signed_at, s.id`, [row.id])).rows;
  const { buffer, pages } = await renderSponsorshipContract({ layout: ver ? ver.layout : starterFor('sponsorship_agreement', 'classic'), kit: ver?.kit_snapshot ?? null, logo: await loadLogo(ver?.logo_asset_id), snapshot: snap, signatures: sigs, fingerprint: row.snapshot_sha256 });
  const doc = await storeDocument(c, { buffer, pages, contractId: row.id, version: row.terms_version, templateVersionId: ver?.id ?? null, logoAssetId: ver?.logo_asset_id ?? null, userId: actorId });
  await c.query('INSERT INTO sponsorship_signed_documents(contract_id, document_id, sha256, terms_version) VALUES ($1,$2,$3,$4)', [row.id, doc.id, doc.sha256, row.terms_version]);
  await c.query("UPDATE sponsorship_contracts SET status='signed', signed_at=now(), row_version=row_version+1 WHERE id=$1", [row.id]);
  await logHistory(c, row.sponsorship_id, row.terms_version, actorId, 'contract_signed');
  await audit(c, actorId, 'seal_sponsorship_contract', 'sponsorship_contracts', row.id);
  const people = (await c.query("SELECT user_id FROM sponsorship_signatories WHERE contract_id=$1 AND status='signed'", [row.id])).rows;
  for (const p of people) await notify(c, p.user_id, { kind: 'sponsorship_contract', title: 'Sponsorship contract signed', body: 'Everyone has signed. The signed copy is on the agreement.', data: { sponsorship_id: row.sponsorship_id, contract_id: row.id }, dedupe_key: `contract-signed:${row.id}` });
  return true;
}

/**
 * The one place a signature is recorded, for every provider. Locks the contract, re-checks live authority and the exact text, and is
 * idempotent: repeating a signature (a retry, a double click, a replayed callback) changes nothing and returns the existing evidence.
 */
export async function applySignature(c, { contractId, userId, documentSha256, provider, providerRef = null, actorId = userId }) {
  const row = (await c.query(`SELECT ${COLS} FROM sponsorship_contracts c WHERE c.id=$1 FOR UPDATE`, [contractId])).rows[0];
  if (!row) throw notFound('Contract');
  const g = (await c.query("SELECT * FROM sponsorship_signatories WHERE contract_id=$1 AND user_id=$2 AND status <> 'removed' FOR UPDATE", [contractId, userId])).rows[0];
  if (!g) throw forbidden('You are not a named signatory of this contract');
  const done = (await c.query('SELECT id, signed_at, provider FROM sponsorship_signatures WHERE signatory_id=$1', [g.id])).rows[0];
  if (done) return { duplicate: true, signature_id: done.id, signed_at: done.signed_at, contract_status: row.status };
  if (row.status !== 'awaiting_signatures') throw conflict(row.status === 'draft' ? 'This contract has not been sent for signature yet' : `This contract is ${row.status}`);
  if (documentSha256 !== row.snapshot_sha256) throw conflict('The contract text changed. Reload it and review the current text before signing.', { code: 'stale_document' });
  const d = (await c.query('SELECT terms_version, status FROM sponsorships WHERE id=$1 FOR UPDATE', [row.sponsorship_id])).rows[0];
  if (d.terms_version !== row.terms_version) throw conflict('The agreement was revised after this contract was issued. Ask for a new contract.', { code: 'stale_version' });
  if (!OPEN_DEAL.includes(d.status)) throw conflict(`This sponsorship is ${d.status}, so it can no longer be signed`);
  const side = await partyOf(c, row.sponsorship_id, userId); // live: someone who lost authority since being named cannot sign
  if (side !== g.side) throw forbidden('You no longer have authority to sign for this side');
  const p = PROVIDERS[provider];
  const s = (await c.query(
    `INSERT INTO sponsorship_signatures(contract_id, signatory_id, user_id, side, terms_version, document_sha256, provider, provider_ref, intent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (contract_id, signatory_id) DO NOTHING RETURNING id, signed_at`,
    [contractId, g.id, userId, g.side, row.terms_version, row.snapshot_sha256, provider, providerRef, p.intent])).rows[0];
  if (!s) return { duplicate: true, contract_status: row.status };
  await c.query("UPDATE sponsorship_signatories SET status='signed' WHERE id=$1", [g.id]);
  await logHistory(c, row.sponsorship_id, row.terms_version, actorId, 'contract_signature');
  await audit(c, actorId, 'sign_sponsorship_contract', 'sponsorship_contracts', row.id);
  const sealed = await sealIfComplete(c, row, actorId);
  return { duplicate: false, signature_id: s.id, signed_at: s.signed_at, contract_status: sealed ? 'signed' : 'awaiting_signatures' };
}

// ------------------------------------------------------------------ capabilities
cap({
  name: 'generate_sponsorship_contract', method: 'POST', path: '/sponsorships/:id/contracts', tag: TAG, status: 201,
  summary: 'Issue an unsigned DRAFT contract (branded PDF) for the CURRENT terms version of an agreement, from one of your published sponsorship_agreement templates or the plain classic layout. The text is frozen at this moment (snapshot + SHA-256): later edits to the agreement, kit or template never change it. Issuing again replaces the unsent draft; a contract already sent for signature or signed must be voided / is final.',
  input: z.object({ id, template_id: id.optional(), version: z.number().int().min(1).describe('the terms version you are looking at; a stale one is refused').optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    const out = await tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (hiddenFromRecipient(ctx)) throw notFound('Sponsorship');
      mustManage(ctx);
      const { d } = ctx;
      if (!OPEN_DEAL.includes(d.status)) throw conflict(`This sponsorship is ${d.status}; a contract can only be issued while it is proposed or active`);
      if (i.version != null && i.version !== d.terms_version) throw conflict(`The agreement is now at terms version ${d.terms_version}`, { code: 'stale_version' });
      const lines = await loadLines(c, d.id, d.terms_version);
      if (!lines.length) throw badRequest('Set the contribution lines before issuing a contract');
      let ver = null;
      if (i.template_id) {
        const t = (await c.query('SELECT * FROM document_templates WHERE id=$1', [i.template_id])).rows[0];
        if (!t || t.family !== 'sponsorship_agreement') throw badRequest('That is not a sponsorship agreement template');
        if (t.status === 'retired' || t.archived_at) throw conflict('That template is retired');
        const owned = t.owner_user_id ? t.owner_user_id === user.id : !!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin','finance')", [t.organisation_id, user.id])).rowCount;
        if (!owned) throw notFound('Template');
        ver = (await c.query('SELECT * FROM document_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1', [t.id])).rows[0];
        if (!ver) throw conflict('Publish the template before issuing contracts from it');
      }
      const live = (await c.query("SELECT id, status FROM sponsorship_contracts WHERE sponsorship_id=$1 AND terms_version=$2 AND status <> 'voided' FOR UPDATE", [d.id, d.terms_version])).rows[0];
      if (live && live.status !== 'draft') throw conflict(live.status === 'signed' ? 'This version already has a signed contract' : 'This version already has a contract out for signature. Void it first to issue a new one.');
      if (live) { await c.query("UPDATE sponsorship_contracts SET status='voided', voided_at=now(), void_reason='Replaced by a new draft', row_version=row_version+1 WHERE id=$1", [live.id]); await c.query("UPDATE sponsorship_signatories SET status='removed' WHERE contract_id=$1", [live.id]); }
      const snapshot = await buildSnapshot(c, ctx);
      const fingerprint = sha(canonical(snapshot));
      const { buffer, pages } = await renderSponsorshipContract({ layout: ver ? ver.layout : starterFor('sponsorship_agreement', 'classic'), kit: ver?.kit_snapshot ?? null, logo: await loadLogo(ver?.logo_asset_id), snapshot, signatures: null, fingerprint });
      const cid = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      const doc = await storeDocument(c, { buffer, pages, contractId: cid, version: d.terms_version, templateVersionId: ver?.id ?? null, logoAssetId: ver?.logo_asset_id ?? null, userId: user.id });
      await c.query(
        'INSERT INTO sponsorship_contracts(id, sponsorship_id, terms_version, snapshot, snapshot_sha256, document_id, template_version_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [cid, d.id, d.terms_version, JSON.stringify(snapshot), fingerprint, doc.id, ver?.id ?? null, user.id]);
      await logHistory(c, d.id, d.terms_version, user.id, 'contract_drafted');
      await audit(c, user.id, 'generate_sponsorship_contract', 'sponsorship_contracts', cid);
      return { cid, ctx };
    });
    const { row, ctx } = await contractFor(pool, out.cid, user);
    return view(pool, row, ctx, user.id);
  },
});

cap({
  name: 'list_sponsorship_contracts', method: 'GET', path: '/sponsorships/:id/contracts', tag: TAG,
  summary: 'Contracts of one agreement (newest first, deterministic), with their state: draft or signed, who still has to sign, whether the terms moved on (stale), and download links. Only the parties to the agreement can read them.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    if (hiddenFromRecipient(ctx)) throw notFound('Sponsorship');
    const rows = (await pool.query(`SELECT ${COLS} FROM sponsorship_contracts c WHERE c.sponsorship_id=$1 ORDER BY c.created_at DESC, c.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset])).rows;
    const out = [];
    for (const r of rows) out.push(await view(pool, r, ctx, user.id));
    return { terms_version: ctx.d.terms_version, accepted_version: ctx.d.accepted_version ?? null, providers: providerList(), contracts: out };
  },
});

cap({
  name: 'get_sponsorship_contract', method: 'GET', path: '/sponsorship-contracts/:id', tag: TAG,
  summary: 'One contract with its signatories and download links. 404 for anyone who is not a party to the agreement.',
  input: z.object({ id }),
  async handler({ user }, i) { const { row, ctx } = await contractFor(pool, i.id, user); return view(pool, row, ctx, user.id); },
});

cap({
  name: 'list_contract_signers', method: 'GET', path: '/sponsorships/:id/contract-signers', tag: TAG,
  summary: 'People who can currently be named as signatories, per side: the sponsor\'s people with authority to bind the brand, and the recipient\'s people with authority to bind the recipient. For a search-and-pick control.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    if (hiddenFromRecipient(ctx)) throw notFound('Sponsorship');
    mustManage(ctx);
    const sponsorIds = await sponsorRecipients(pool, await one('SELECT * FROM sponsors WHERE id=$1', [ctx.d.sponsor_id]), 'sign_contract', ctx.d.department_id);
    let recipientIds;
    if (ORG_TARGETS.includes(ctx.d.target_type)) recipientIds = (await many("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')", [await targetOrgId(pool, ctx.d.target_type, ctx.d.target_id)])).map((r) => r.user_id);
    else recipientIds = ctx.recipientId ? [ctx.recipientId] : [];
    const names = async (ids) => (ids.length ? many('SELECT id AS user_id, display_name AS name, handle FROM users WHERE id = ANY($1) ORDER BY display_name, id', [ids]) : []);
    return { sponsor: await names([...new Set(sponsorIds)]), recipient: await names([...new Set(recipientIds)]) };
  },
});

cap({
  name: 'set_contract_signatories', method: 'PATCH', path: '/sponsorship-contracts/:id/signatories', tag: TAG,
  summary: 'Name who must sign a DRAFT contract (replaces the list). Each person must currently have authority to bind their side (sponsor: manager/approver of the brand; recipient: the owner or an organisation owner/admin), otherwise 403. Choose from list_contract_signers.',
  input: z.object({ id, signatories: z.array(z.object({ user_id: id, side: z.enum(['sponsor', 'recipient']), capacity: z.string().trim().max(80).optional() })).min(1).max(10), row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    requireApproved(user);
    await tx(async (c) => {
      const { row, ctx } = await contractFor(c, i.id, user, { lock: true });
      mustManage(ctx);
      if (row.status !== 'draft') throw conflict('Signatories can only be changed on a draft');
      if (row.row_version !== i.row_version) throw conflict('The contract changed. Reload it first.', { code: 'stale_row' });
      for (const s of i.signatories) {
        if ((await partyOf(c, row.sponsorship_id, s.user_id)) !== s.side) throw forbidden('That person has no authority to sign for the ' + s.side);
      }
      const keep = i.signatories.map((s) => s.user_id);
      await c.query("UPDATE sponsorship_signatories SET status='removed' WHERE contract_id=$1 AND NOT (user_id = ANY($2))", [row.id, keep]);
      for (const s of i.signatories) {
        await c.query(
          `INSERT INTO sponsorship_signatories(contract_id, side, user_id, capacity) VALUES ($1,$2,$3,$4)
           ON CONFLICT (contract_id, user_id) DO UPDATE SET side=EXCLUDED.side, capacity=EXCLUDED.capacity, status='pending'`, [row.id, s.side, s.user_id, s.capacity ?? null]);
      }
      await c.query('UPDATE sponsorship_contracts SET row_version=row_version+1 WHERE id=$1', [row.id]);
      await audit(c, user.id, 'set_contract_signatories', 'sponsorship_contracts', row.id);
    });
    const { row, ctx } = await contractFor(pool, i.id, user);
    return view(pool, row, ctx, user.id);
  },
});

cap({
  name: 'request_contract_signatures', method: 'POST', path: '/sponsorship-contracts/:id/request-signatures', tag: TAG,
  summary: 'Send a draft for signature: locks the text and asks every named signatory to sign. Needs at least one signatory on each side and the agreement still at the contract\'s terms version.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    requireApproved(user);
    await tx(async (c) => {
      const { row, ctx } = await contractFor(c, i.id, user, { lock: true });
      mustManage(ctx);
      if (row.status !== 'draft') throw conflict(`This contract is ${row.status}`);
      if (row.row_version !== i.row_version) throw conflict('The contract changed. Reload it first.', { code: 'stale_row' });
      if (row.terms_version !== ctx.d.terms_version) throw conflict('The agreement was revised after this draft. Issue a new contract.', { code: 'stale_version' });
      if (!OPEN_DEAL.includes(ctx.d.status)) throw conflict(`This sponsorship is ${ctx.d.status}`);
      const sides = new Set((await c.query("SELECT side FROM sponsorship_signatories WHERE contract_id=$1 AND status='pending'", [row.id])).rows.map((r) => r.side));
      if (!sides.has('sponsor') || !sides.has('recipient')) throw badRequest('Name at least one signatory on each side first');
      await c.query("UPDATE sponsorship_contracts SET status='awaiting_signatures', requested_at=now(), row_version=row_version+1 WHERE id=$1", [row.id]);
      await logHistory(c, row.sponsorship_id, row.terms_version, user.id, 'contract_sent');
      await audit(c, user.id, 'request_contract_signatures', 'sponsorship_contracts', row.id);
      for (const s of (await c.query("SELECT user_id FROM sponsorship_signatories WHERE contract_id=$1 AND status='pending'", [row.id])).rows)
        await notify(c, s.user_id, { kind: 'sponsorship_contract', title: 'A sponsorship contract needs your signature', body: 'Review the contract and sign it on the agreement.', data: { sponsorship_id: row.sponsorship_id, contract_id: row.id }, dedupe_key: `contract-request:${row.id}:${s.user_id}` });
    });
    const { row, ctx } = await contractFor(pool, i.id, user);
    return view(pool, row, ctx, user.id);
  },
});

cap({
  name: 'sign_sponsorship_contract', method: 'POST', path: '/sponsorship-contracts/:id/sign', tag: TAG,
  summary: 'Sign a contract in Sportarena. You must be a named signatory who still has authority to bind your side, and document_sha256 must be the fingerprint of the exact text you reviewed (get_sponsorship_contract returns it); a changed text or revised agreement is refused (409). Signing twice is harmless and returns the existing signature. The last signature seals the contract into an immutable signed PDF.',
  input: z.object({ id, document_sha256: z.string().regex(/^[0-9a-f]{64}$/), agree: z.literal(true).describe('confirms you have read the contract and intend to be bound by it') }),
  async handler({ user }, i) {
    requireApproved(user);
    const r = await tx(async (c) => {
      await contractFor(c, i.id, user); // non-parties get 404 before anything else is said
      return applySignature(c, { contractId: i.id, userId: user.id, documentSha256: i.document_sha256, provider: 'internal' });
    });
    const { row, ctx } = await contractFor(pool, i.id, user);
    return { ...r, contract: await view(pool, row, ctx, user.id) };
  },
});

cap({
  name: 'void_sponsorship_contract', method: 'POST', path: '/sponsorship-contracts/:id/void', tag: TAG,
  summary: 'Withdraw an unsigned (draft or awaiting-signature) contract so a new one can be issued. A signed contract can never be voided. Signatures already given stay as evidence.',
  input: z.object({ id, reason: z.string().trim().min(1).max(300) }),
  async handler({ user }, i) {
    requireApproved(user);
    await tx(async (c) => {
      const { row, ctx } = await contractFor(c, i.id, user, { lock: true });
      mustManage(ctx);
      if (!['draft', 'awaiting_signatures'].includes(row.status)) throw conflict(`A ${row.status} contract cannot be voided`);
      await c.query("UPDATE sponsorship_contracts SET status='voided', voided_at=now(), void_reason=$2, row_version=row_version+1 WHERE id=$1", [row.id, i.reason]);
      await c.query("UPDATE sponsorship_signatories SET status='removed' WHERE contract_id=$1 AND status='pending'", [row.id]);
      await logHistory(c, row.sponsorship_id, row.terms_version, user.id, 'contract_voided', i.reason);
      await audit(c, user.id, 'void_sponsorship_contract', 'sponsorship_contracts', row.id);
    });
    const { row, ctx } = await contractFor(pool, i.id, user);
    return view(pool, row, ctx, user.id);
  },
});

/** Live access check for downloading a contract PDF (draft or signed): the same rule as reading the contract. */
export async function canReadContractDocument(user, contractId) {
  await contractFor(pool, contractId, user);
}

/** POST /api/v1/webhooks/signatures/webhook: callbacks from an external e-signature service. Mounted before the JSON parser (raw body). */
export function signatureCallbackRouter() {
  const r = express.Router();
  const BODY = z.object({ event_id: z.string().min(1).max(200), contract_id: id, user_id: id, document_sha256: z.string().regex(/^[0-9a-f]{64}$/), provider_ref: z.string().max(200).optional(), status: z.literal('signed') });
  r.post('/webhook', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
    try {
      const raw = req.body.toString('utf8');
      if (!PROVIDERS.webhook.enabled()) return res.status(404).json({ error: 'provider_disabled' });
      if (!verifyCallback(raw, req.headers['x-signature'])) return res.status(400).json({ error: 'bad_signature' });
      const parsed = BODY.safeParse(JSON.parse(raw));
      if (!parsed.success) return res.status(422).json({ error: 'bad_payload' });
      const b = parsed.data;
      const out = await tx(async (c) => {
        // the event row and the signature commit together: a retry after a crash re-applies; a replay after success is a no-op
        const fresh = await c.query("INSERT INTO provider_events(provider, event_id, kind) VALUES ('esign-webhook',$1,'signed') ON CONFLICT DO NOTHING RETURNING event_id", [b.event_id]);
        if (!fresh.rowCount) return { duplicate: true };
        return applySignature(c, { contractId: b.contract_id, userId: b.user_id, documentSha256: b.document_sha256, provider: 'webhook', providerRef: b.provider_ref ?? b.event_id });
      });
      res.json({ received: true, ...out });
    } catch (e) {
      if (e.status && e.status < 500) return res.status(e.status).json({ error: e.code ?? 'rejected', message: e.message }); // permanently refused: a retry cannot help
      console.error('[signature-callback]', e.message);
      res.status(500).json({ error: 'processing_failed' }); // the provider retries
    }
  });
  return r;
}
