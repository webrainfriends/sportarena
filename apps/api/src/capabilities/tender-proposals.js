// Tender zone, supplier journey: draft -> validate -> authorised submission -> immutable receipt -> revise / withdraw -> outcome.
// A proposal belongs to a supplier legal entity (not a person): collaborators share one draft, and exactly one proposal exists per
// entity, round and alternative. Submitted versions are sealed, hashed and immutable; the working draft is encrypted too.
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { auditLog, buyerIds, contentHash, entityUserIds, getProject, noticeAccess, requireEntity, sealJson, stageOf, tellUsers, myEntityIds } from '../tender/core.js';
import { credentialCheck, lotsOf, questionsOf } from '../tender/rfp.js';
import { lineAmounts, convertMinor } from '../tender/money.js';
import { exportSheet, importSheet } from '../tender/sheet.js';

const TAG = 'Tender zone';
const MAX_DRAFT = 400_000;
const line = z.object({ lot_code: z.string().max(20), qty: z.union([z.string(), z.number()]).transform(String), unit: z.string().max(30).optional(), rate_minor: z.number().int().min(0), currency: z.string().length(3).optional(), discount_bp: z.number().int().min(0).max(10000).default(0), tax_bp: z.number().int().min(0).max(10000).default(0), tax_inclusive: z.boolean().default(false),
  breakdown: z.object({ labour_minor: z.number().int().min(0).optional(), material_minor: z.number().int().min(0).optional(), travel_minor: z.number().int().min(0).optional() }).optional(), notes: z.string().max(300).optional() });
const technical = z.object({ answers: z.record(z.string(), z.any()).default({}), evidence: z.record(z.string(), z.array(id)).default({}), delivery_plan: z.string().max(8000).optional(), staffing: z.object({ headcount: z.number().int().min(0).max(100000).optional(), capacity_note: z.string().max(1000).optional() }).optional(),
  subcontractors: z.array(z.object({ name: z.string().max(120), scope: z.string().max(300) })).max(30).default([]), assumptions: z.string().max(4000).optional(), deviations: z.string().max(4000).optional(), attachments: z.array(id).max(50).default([]) });
const commercial = z.object({ lines: z.array(line).max(1000).default([]), answers: z.record(z.string(), z.any()).default({}), validity_days: z.number().int().min(1).max(730).optional(), payment_terms: z.string().max(1000).optional(), assumptions: z.string().max(4000).optional(), attachments: z.array(id).max(50).default([]) });
const draftT = z.object({ technical: technical.default({ answers: {}, evidence: {}, subcontractors: [], attachments: [] }), commercial: commercial.default({ lines: [], answers: {}, attachments: [] }) });

const dctx = (pid) => `proc_proposals.draft:${pid}`;
export const readDraft = (row) => (row.draft_enc ? draftT.parse(JSON.parse(decrypt(row.draft_enc, dctx(row.id)))) : draftT.parse({}));
const writeDraft = (pid, d) => encrypt(JSON.stringify(d), dctx(pid));

// Commercial wording is not allowed inside the technical envelope when two envelopes are used.
const MONEY_TEXT = /(?:[₹$€£]\s?\d|\b(?:rs\.?|inr|usd|eur|gbp|aed|sgd)\s?\d|\d[\d,.]*\s?(?:rupees|dollars|euros|pounds|inr|usd|eur|gbp)\b|\b(?:price|fee|rate|cost)s?\s*(?:of|is|:)\s*\d)/i;
const textsOf = (t) => [t.delivery_plan, t.assumptions, t.deviations, ...Object.values(t.answers).filter((v) => typeof v === 'string'), ...t.subcontractors.map((s) => s.scope)].filter(Boolean);

const memberRoles = ['owner', 'bid_manager', 'contributor', 'signatory'];
async function loadProposal(user, pid, roles = memberRoles, c = pool) {
  const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1', [pid])).rows[0];
  if (!pr) throw notFound('Proposal');
  await requireEntity(user, pr.entity_id, roles, c);
  return pr;
}
const editable = (p, pr, now) => {
  if (p.suspended_at) return 'Submissions are suspended';
  if (pr.round === 1 && (p.status !== 'published' || (p.closes_at && now >= new Date(p.closes_at)))) return 'The tender has closed';
  if (pr.status !== 'draft' && !p.allow_revision) return 'This tender does not allow revisions';
  return null;
};
const dbNow = async (c) => new Date((await c.query('SELECT clock_timestamp() AS t')).rows[0].t);

// ------------------------------------------------------------------ start & draft
cap({
  name: 'start_proposal', method: 'POST', path: '/tenders/:id/proposals', tag: TAG, status: 201,
  summary: 'Start (or continue) your supplier entity\'s proposal for a tender: pick the lots you will bid on, and optionally an alternative proposal where the tender allows it. You must have been admitted (public interest, approval or invitation) and have accepted the terms. Exactly one proposal exists per supplier entity, round and alternative, however many colleagues work on it, so starting again returns the same draft.',
  input: z.object({ id, entity_id: id, lots: z.array(z.string().max(20)).min(1).max(200), alt_key: z.string().regex(/^[a-z0-9_]{1,20}$/).default('base'), round: z.number().int().min(1).max(10).default(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await getProject(i.id, c);
      const acc = await noticeAccess(user, p, c);
      if (acc.buyer.length) throw forbidden('The buying team cannot bid on its own tender');
      await requireEntity(user, i.entity_id, ['owner', 'bid_manager', 'signatory'], c);
      const part = (await c.query('SELECT * FROM proc_participants WHERE project_id=$1 AND entity_id=$2', [p.id, i.entity_id])).rows[0];
      if (!part || ['declined', 'withdrawn', 'requested'].includes(part.status)) throw forbidden('You are not admitted to this tender yet');
      if (!part.terms_accepted_at) throw conflict('Accept the tender terms first');
      if (p.suspended_at || (i.round === 1 ? p.status !== 'published' : p.status !== 'evaluation')) throw conflict('This tender is not open for proposals');
      if (i.round === 1 && p.closes_at && new Date() >= new Date(p.closes_at)) throw conflict('The tender has closed');
      if (i.round > 1) {
        const r = (await c.query('SELECT * FROM proc_rounds WHERE project_id=$1 AND n=$2', [p.id, i.round])).rows[0];
        if (!r || !r.invited.includes(i.entity_id)) throw forbidden('You are not invited to that round');
      }
      if (i.alt_key !== 'base' && !p.allow_alternatives) throw badRequest('This tender does not accept alternative proposals');
      const lots = await lotsOf(c, p.id);
      for (const l of i.lots) if (!lots.some((x) => x.code === l)) throw notFound(`Lot ${l}`);
      const pr = (await c.query(`INSERT INTO proc_proposals(project_id, entity_id, round, alt_key, lots, created_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (project_id, entity_id, round, alt_key) DO UPDATE SET lots = CASE WHEN proc_proposals.status='draft' THEN EXCLUDED.lots ELSE proc_proposals.lots END, updated_at=now() RETURNING *`, [p.id, i.entity_id, i.round, i.alt_key, i.lots, user.id])).rows[0];
      await auditLog(c, p.id, user.id, 'proposal_started', { proposal_id: pr.id, entity_id: i.entity_id, round: i.round, alt_key: i.alt_key });
      const { draft_enc, ...rest } = pr;
      return rest;
    });
  },
});

cap({
  name: 'save_proposal_draft', method: 'PATCH', path: '/proposals/:id/draft', tag: TAG,
  summary: 'Autosave your proposal draft: technical answers, evidence, delivery plan, staffing and subcontractors; commercial lines (lot, quantity, unit rate, discount, tax, currency), validity and payment terms. Send the draft_version you read; a stale one is a 409 so two colleagues never overwrite each other. Saving is not submitting. After the deadline, saving is refused. Commercial wording (prices, fees) is rejected inside the technical envelope of a two-envelope tender.',
  input: z.object({ id, draft_version: z.number().int(), lots: z.array(z.string().max(20)).min(1).max(200).optional(), technical: technical.optional(), commercial: commercial.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pr0 = await loadProposal(user, i.id, memberRoles, c);
      const p = await getProject(pr0.project_id, c);
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const block = editable(p, pr, await dbNow(c));
      if (block) throw conflict(block);
      if (pr.draft_version !== i.draft_version) throw conflict('A colleague saved a newer draft; reload it first', { draft_version: pr.draft_version });
      const cur = readDraft(pr);
      const next = { technical: i.technical ?? cur.technical, commercial: i.commercial ?? cur.commercial };
      if (p.envelope_mode !== 'open' && i.technical) {
        const hit = textsOf(next.technical).find((t) => MONEY_TEXT.test(t));
        if (hit) throw unprocessable('Prices belong in the commercial envelope. Remove them from the technical answers.', { field: 'technical' });
      }
      const size = JSON.stringify(next).length;
      if (size > MAX_DRAFT) throw badRequest('The proposal draft is too large');
      const lots = i.lots ?? pr.lots;
      if (i.lots) { const all = await lotsOf(c, p.id); for (const l of i.lots) if (!all.some((x) => x.code === l)) throw notFound(`Lot ${l}`); }
      const row = (await c.query('UPDATE proc_proposals SET draft_enc=$2, lots=$3, draft_version=draft_version+1, updated_at=now() WHERE id=$1 RETURNING id, draft_version, lots, status, updated_at', [pr.id, writeDraft(pr.id, next), lots])).rows[0];
      return row;
    });
  },
});

// ------------------------------------------------------------------ validation (checklist)
export async function checklist(c, p, pr, draft, part) {
  const items = [];
  const add = (severity, key, message, section = 'general') => items.push({ severity, key, section, message });
  const lots = await lotsOf(c, p.id), qs = await questionsOf(c, p.id);
  const ent = (await c.query('SELECT * FROM supplier_entities WHERE id=$1', [pr.entity_id])).rows[0];
  if (!part?.terms_accepted_at) add('error', 'terms', 'Accept the tender terms');
  if (p.site_visit_mandatory && !(part?.site_visit_attended || part?.site_visit_exempt_reason)) add('error', 'site_visit', 'Attendance at the site visit is mandatory and has not been recorded');
  const adds = (await c.query('SELECT a.n FROM proc_addenda a WHERE a.project_id=$1 AND NOT EXISTS (SELECT 1 FROM proc_addendum_acks k WHERE k.project_id=a.project_id AND k.n=a.n AND k.entity_id=$2)', [p.id, pr.entity_id])).rows;
  for (const a of adds) add('error', `addendum_${a.n}`, `Acknowledge addendum ${a.n}`);
  const chosen = new Set(pr.lots);
  for (const code of chosen) { const l = lots.find((x) => x.code === code); for (const b of l?.bundle_with ?? []) if (!chosen.has(b)) add('error', `bundle_${code}`, `Lot ${code} must be bid together with lot ${b}`, 'commercial'); }
  const answers = { ...draft.technical.answers, ...draft.commercial.answers };
  const visible = (q) => !q.show_if || answers[q.show_if.key] === q.show_if.equals;
  for (const q of qs.filter(visible)) {
    if (q.lot_code && !chosen.has(q.lot_code)) continue;
    const v = answers[q.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (q.type === 'attachment') { if (q.required && !(draft.technical.evidence[q.key]?.length || draft.commercial.attachments.length)) add('error', q.key, `Attach evidence: ${q.prompt}`, q.section); continue; }
    if (empty) { if (q.required) add('error', q.key, `Answer: ${q.prompt}`, q.section); continue; }
    const bad = (m) => add('error', q.key, m, q.section);
    if (q.type === 'yes_no' && typeof v !== 'boolean') bad(`"${q.prompt}" must be yes or no`);
    if (q.type === 'single_select' && !q.options?.includes(v)) bad(`Choose one of the listed options for "${q.prompt}"`);
    if (q.type === 'multi_select' && !(Array.isArray(v) && v.every((x) => q.options?.includes(x)))) bad(`Choose from the listed options for "${q.prompt}"`);
    if (q.type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) bad(`"${q.prompt}" must be a number`);
    if (q.type === 'currency' && !Number.isInteger(v)) bad(`"${q.prompt}" must be an amount`);
    if (q.type === 'date' && Number.isNaN(Date.parse(v))) bad(`"${q.prompt}" must be a date`);
    if (q.type === 'table' && !Array.isArray(v)) bad(`"${q.prompt}" must be a table`);
    if (q.evidence_required && !draft.technical.evidence[q.key]?.length) add('error', q.key, `Evidence is required for: ${q.prompt}`, q.section);
    if (q.pass_fail && q.pass_value !== null && JSON.stringify(v) !== JSON.stringify(q.pass_value)) add('warning', q.key, `This answer does not meet a pass/fail requirement ("${q.prompt}") and will make the bid ineligible`, q.section);
  }
  if (p.envelope_mode !== 'open') for (const t of textsOf(draft.technical)) if (MONEY_TEXT.test(t)) { add('error', 'technical_prices', 'Prices were found in the technical answers. Move them to the commercial envelope.', 'technical'); break; }
  if (p.kind !== 'rfi') {
    const allowed = new Set([p.currency, ...(ent?.currencies ?? [])]);
    for (const code of chosen) {
      const ln = draft.commercial.lines.filter((l) => l.lot_code === code);
      const lot = lots.find((x) => x.code === code);
      if (!ln.length) { add('error', `price_${code}`, `Price lot ${code}`, 'commercial'); continue; }
      for (const l of ln) {
        if (!(l.rate_minor > 0)) add('error', `price_${code}`, `Lot ${code} needs a unit rate above zero`, 'commercial');
        const q = Number(l.qty);
        if (!(q > 0)) add('error', `qty_${code}`, `Lot ${code} needs a quantity`, 'commercial');
        else if (lot && q > Number(lot.qty) + 1e-9) add('error', `qty_${code}`, `Lot ${code}: you cannot offer more than the ${lot.qty} requested`, 'commercial');
        else if (lot && !lot.allow_partial && q + 1e-9 < Number(lot.qty)) add('error', `qty_${code}`, `Lot ${code} must be offered in full`, 'commercial');
        const cur = l.currency ?? p.currency;
        if (cur !== p.currency && (!allowed.has(cur) || !p.fx?.rates?.[cur])) add('error', `fx_${code}`, `Lot ${code}: ${cur} has no approved exchange rate on this tender; price in ${p.currency}`, 'commercial');
        try { lineAmounts(l); } catch (e) { add('error', `price_${code}`, e.message, 'commercial'); }
      }
    }
    for (const l of draft.commercial.lines) if (!chosen.has(l.lot_code)) add('error', `price_${l.lot_code}`, `Lot ${l.lot_code} is priced but not selected`, 'commercial');
    if (!draft.commercial.validity_days) add('warning', 'validity', 'State how long your prices are valid', 'commercial');
  }
  if (draft.technical.attachments.length + draft.commercial.attachments.length > 0) {
    const ids = [...draft.technical.attachments, ...draft.commercial.attachments, ...Object.values(draft.technical.evidence).flat()];
    const ok = (await c.query("SELECT id FROM proc_files WHERE id = ANY($1) AND entity_id=$2 AND proposal_id=$3 AND scan='clean' AND archived_at IS NULL", [ids, pr.entity_id, pr.id])).rows.length;
    if (ok !== new Set(ids).size) add('error', 'attachments', 'An attached file is missing or still being checked', 'general');
  }
  for (const r of await credentialCheck(c, p, pr.entity_id)) if (r.state !== 'ok') add('warning', `credential_${r.kind}`, r.detail, 'qualification');
  return { ok: !items.some((x) => x.severity === 'error'), items, total_required: qs.filter((q) => q.required).length, missing: items.filter((x) => x.severity === 'error').length };
}

cap({
  name: 'validate_proposal', method: 'POST', path: '/proposals/:id/validate', tag: TAG,
  summary: 'The missing-item checklist for your proposal: unanswered or invalid questions, missing evidence, unpriced lots, quantities, bundles, exchange rates, acknowledgements, the site visit and credential warnings. Submitting runs the same checks on the server.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const pr = await loadProposal(user, i.id);
    const p = await getProject(pr.project_id);
    const part = await one('SELECT * FROM proc_participants WHERE project_id=$1 AND entity_id=$2', [p.id, pr.entity_id]);
    return checklist(pool, p, pr, readDraft(pr), part);
  },
});

// ------------------------------------------------------------------ submit / withdraw
const receiptOf = (s, p, e) => ({ receipt_no: s.receipt_no, tender: p.ref, supplier: e.legal_name, version: s.version, submitted_at: s.submitted_at, rfp_version: s.rfp_version, addendum_n: s.addendum_n, lots: s.lots, content_hash: s.content_hash, late: s.late });

cap({
  name: 'submit_proposal', method: 'POST', path: '/proposals/:id/submit', tag: TAG,
  summary: 'Submit your proposal (owner or authorised signatory only). The server validates everything, seals the technical and commercial envelopes, and returns an immutable receipt with the server timestamp, version, content hash and the exact tender and addendum version: that receipt, not the button press or an upload, is proof the bid was received before close. Send an idempotency_key so a retried request returns the same receipt instead of a duplicate. The deadline is decided by server time at commit: at the deadline instant the tender is already closed.',
  input: z.object({ id, idempotency_key: z.string().min(8).max(80), declaration: z.literal(true).describe('I am authorised to submit this proposal for the supplier entity'), expected_draft_version: z.number().int().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pr0 = await loadProposal(user, i.id, ['owner', 'signatory'], c);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`proposal:${pr0.id}`]);
      const prior = (await c.query('SELECT * FROM proc_submissions WHERE proposal_id=$1 AND idempotency_key=$2', [pr0.id, i.idempotency_key])).rows[0];
      const p = (await c.query('SELECT * FROM proc_projects WHERE id=$1 FOR SHARE', [pr0.project_id])).rows[0];
      const ent = (await c.query('SELECT * FROM supplier_entities WHERE id=$1', [pr0.entity_id])).rows[0];
      if (prior) return { ...receiptOf(prior, p, ent), replayed: true };
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 FOR UPDATE', [pr0.id])).rows[0];
      if (i.expected_draft_version !== undefined && pr.draft_version !== i.expected_draft_version) throw conflict('The draft changed after you reviewed it; review and submit again', { draft_version: pr.draft_version });
      const now = await dbNow(c);
      if (p.suspended_at) throw conflict('Submissions are suspended for this tender');
      let late = false;
      let deadline = p.closes_at;
      if (pr.round > 1) { deadline = (await c.query('SELECT closes_at FROM proc_rounds WHERE project_id=$1 AND n=$2', [p.id, pr.round])).rows[0]?.closes_at; if (p.status !== 'evaluation') throw conflict('This round is not open'); }
      else if (p.status !== 'published' && !(p.status === 'evaluation')) throw conflict('This tender is not open for proposals');
      if (deadline && now >= new Date(deadline)) {
        const w = (await c.query("SELECT 1 FROM proc_approvals WHERE project_id=$1 AND kind='late_submission' AND status='approved' AND payload->>'entity_id'=$2 AND (payload->>'until')::timestamptz > $3", [p.id, pr.entity_id, now])).rows[0];
        if (!w) throw conflict('The submission deadline has passed. Your proposal was not received.', { closes_at: deadline, server_time: now.toISOString() });
        late = true;
      }
      if (pr.status === 'submitted' && !p.allow_revision) throw conflict('This tender does not allow revisions');
      if (pr.status === 'withdrawn' && !p.allow_revision) throw conflict('A withdrawn proposal cannot be resubmitted on this tender');
      const part = (await c.query('SELECT * FROM proc_participants WHERE project_id=$1 AND entity_id=$2', [p.id, pr.entity_id])).rows[0];
      if (!part || ['declined', 'withdrawn', 'requested'].includes(part.status)) throw forbidden('You are not admitted to this tender');
      const draft = readDraft(pr);
      const check = await checklist(c, p, pr, draft, part);
      if (!check.ok) throw unprocessable('The proposal is not complete. Fix the listed items and submit again.', { items: check.items.filter((x) => x.severity === 'error') });
      const version = ((await c.query('SELECT coalesce(max(version),0)+1 AS v FROM proc_submissions WHERE proposal_id=$1', [pr.id])).rows[0].v);
      const sid = randomUUID();
      const addn = (await c.query('SELECT coalesce(max(n),0) AS n FROM proc_addenda WHERE project_id=$1', [p.id])).rows[0].n;
      const hash = contentHash([draft.technical, draft.commercial, p.version, addn, pr.lots]);
      const receipt = `RCPT-${p.ref.slice(4)}-${randomBytes(4).toString('hex').toUpperCase()}`;
      const sub = (await c.query(`INSERT INTO proc_submissions(id, proposal_id, project_id, version, receipt_no, rfp_version, addendum_n, lots, tech_enc, comm_enc, content_hash, submitted_by, submitted_at, late, idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [sid, pr.id, p.id, version, receipt, p.version, addn, pr.lots, sealJson(draft.technical, 'tech_enc', sid), sealJson(draft.commercial, 'comm_enc', sid), hash, user.id, now, late, i.idempotency_key])).rows[0];
      await c.query("UPDATE proc_proposals SET status='submitted', current_submission_id=$2, eligibility='pending', eligibility_reason=NULL, tech_signoff=NULL, tech_signoff_by=NULL, tech_signoff_at=NULL, commercial_unlocked_at=NULL, updated_at=now() WHERE id=$1", [pr.id, sid]);
      await auditLog(c, p.id, user.id, 'proposal_submitted', { proposal_id: pr.id, submission_id: sid, version, receipt_no: receipt, late });
      await tellUsers(c, await entityUserIds(pr.entity_id, c, ['owner', 'bid_manager', 'signatory']), p, 'tender_receipt', 'Proposal received', `Your proposal for tender ${p.ref} was received. Receipt ${receipt}.`, `r${sid}`);
      return receiptOf(sub, p, ent);
    });
  },
});

cap({
  name: 'withdraw_proposal', method: 'POST', path: '/proposals/:id/withdraw', tag: TAG,
  summary: 'Withdraw your submitted proposal before the deadline, where the tender allows withdrawal. Submitted versions are kept for the record; a withdrawn proposal is not evaluated unless you resubmit before the deadline (where revisions are allowed).',
  input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pr0 = await loadProposal(user, i.id, ['owner', 'signatory'], c);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`proposal:${pr0.id}`]);
      const p = (await c.query('SELECT * FROM proc_projects WHERE id=$1 FOR SHARE', [pr0.project_id])).rows[0];
      const now = await dbNow(c);
      if (!p.allow_withdrawal) throw conflict('This tender does not allow withdrawal');
      const deadline = pr0.round > 1 ? (await c.query('SELECT closes_at FROM proc_rounds WHERE project_id=$1 AND n=$2', [p.id, pr0.round])).rows[0]?.closes_at : p.closes_at;
      if (deadline && now >= new Date(deadline)) throw conflict('The deadline has passed, so the proposal can no longer be withdrawn');
      const r = (await c.query("UPDATE proc_proposals SET status='withdrawn', eligibility='withdrawn', updated_at=now() WHERE id=$1 AND status='submitted' RETURNING id, status", [pr0.id])).rows[0];
      if (!r) throw conflict('Only a submitted proposal can be withdrawn');
      await auditLog(c, p.id, user.id, 'proposal_withdrawn', { proposal_id: pr0.id, reason: i.reason ?? null });
      return r;
    });
  },
});

// ------------------------------------------------------------------ read
cap({
  name: 'get_tender_proposal', method: 'GET', path: '/proposals/:id', tag: TAG,
  summary: 'Your proposal: the decrypted working draft, completion checklist, submitted versions with receipts, and your participation. Suppliers only ever see their own proposal and permitted outcome information.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const pr = await loadProposal(user, i.id);
    const p = await getProject(pr.project_id);
    const part = await one('SELECT * FROM proc_participants WHERE project_id=$1 AND entity_id=$2', [p.id, pr.entity_id]);
    const draft = readDraft(pr);
    const subs = await many('SELECT version, receipt_no, submitted_at, rfp_version, addendum_n, content_hash, late FROM proc_submissions WHERE proposal_id=$1 ORDER BY version', [pr.id]);
    const { draft_enc, ...rest } = pr;
    const now = new Date();
    return { ...rest, tender: { id: p.id, ref: p.ref, title: p.title, stage: stageOf(p), closes_at: p.closes_at, currency: p.currency, timezone: p.timezone, envelope_mode: p.envelope_mode, version: p.version, allow_revision: p.allow_revision, allow_withdrawal: p.allow_withdrawal }, draft, checklist: await checklist(pool, p, pr, draft, part), submissions: subs, editable: !editable(p, pr, now), outcome_available: ['awarded', 'closed'].includes(p.status) };
  },
});

cap({
  name: 'list_my_tender_proposals', method: 'GET', path: '/proposals', tag: TAG, summary: 'Proposals of the supplier entities you belong to, with the tender, deadline and receipt state.',
  input: z.object({ entity_id: id.optional(), status: z.enum(['draft', 'submitted', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    const ents = await myEntityIds(user);
    return many(`SELECT pr.id, pr.entity_id, e.legal_name AS supplier, pr.round, pr.alt_key, pr.lots, pr.status, pr.updated_at, p.id AS tender_id, p.ref, p.title, p.closes_at, p.timezone, p.status AS tender_status,
        (SELECT receipt_no FROM proc_submissions s WHERE s.id=pr.current_submission_id) AS receipt_no, (SELECT submitted_at FROM proc_submissions s WHERE s.id=pr.current_submission_id) AS submitted_at
      FROM proc_proposals pr JOIN proc_projects p ON p.id=pr.project_id JOIN supplier_entities e ON e.id=pr.entity_id
      WHERE pr.entity_id = ANY($1) AND ($2::uuid IS NULL OR pr.entity_id=$2) AND ($3::text IS NULL OR pr.status=$3) ORDER BY pr.updated_at DESC, pr.id LIMIT $4 OFFSET $5`, [ents, i.entity_id ?? null, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_proposal_receipt', method: 'GET', path: '/proposals/:id/receipt', tag: TAG,
  summary: 'The immutable receipt of your latest submitted version: reference, server timestamp, version, content hash, tender and addendum version. A receipt exists only after the server durably committed the submission.',
  input: z.object({ id, version: z.coerce.number().int().min(1).optional() }),
  async handler({ user }, i) {
    const pr = await loadProposal(user, i.id);
    const p = await getProject(pr.project_id);
    const ent = await one('SELECT * FROM supplier_entities WHERE id=$1', [pr.entity_id]);
    const s = await one('SELECT * FROM proc_submissions WHERE proposal_id=$1 AND ($2::int IS NULL OR version=$2) ORDER BY version DESC LIMIT 1', [pr.id, i.version ?? null]);
    if (!s) throw notFound('Receipt');
    return receiptOf(s, p, ent);
  },
});

// ------------------------------------------------------------------ pricing sheets
cap({
  name: 'export_pricing_sheet', method: 'GET', path: '/proposals/:id/pricing-sheet', tag: TAG,
  summary: 'Download the structured pricing sheet for your proposal as CSV or XLSX: one row per lot, with fixed quantities and units and editable rate, discount, tax and notes, tied to this exact tender version. Returns the file as text (csv) or base64 (xlsx).',
  input: z.object({ id, format: z.enum(['csv', 'xlsx']).default('csv') }),
  async handler({ user }, i) {
    const pr = await loadProposal(user, i.id);
    const p = await getProject(pr.project_id);
    const lots = (await lotsOf(pool, p.id)).filter((l) => pr.lots.includes(l.code));
    const out = exportSheet(p, lots, readDraft(pr).commercial.lines, i.format);
    return { filename: `${p.ref}-pricing.${out.ext}`, content_type: out.type, encoding: i.format === 'xlsx' ? 'base64' : 'utf8', data: i.format === 'xlsx' ? out.body.toString('base64') : out.body };
  },
});

cap({
  name: 'import_pricing_sheet', method: 'POST', path: '/proposals/:id/pricing-sheet', tag: TAG,
  summary: 'Import a filled pricing sheet (CSV) into your draft\'s commercial lines. Rejected: sheets from another tender or an older tender version, changed quantities or units, spreadsheet formulas, and files over the size limit. Unpriced lots are left unpriced, never imported as zero.',
  input: z.object({ id, csv: z.string().min(10).max(500_000), draft_version: z.number().int() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pr0 = await loadProposal(user, i.id, memberRoles, c);
      const p = await getProject(pr0.project_id, c);
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 FOR UPDATE', [pr0.id])).rows[0];
      const block = editable(p, pr, await dbNow(c));
      if (block) throw conflict(block);
      if (pr.draft_version !== i.draft_version) throw conflict('A colleague saved a newer draft; reload it first', { draft_version: pr.draft_version });
      const lots = (await lotsOf(c, p.id)).filter((l) => pr.lots.includes(l.code));
      const lines = importSheet(p, lots, i.csv);
      const d = readDraft(pr);
      const next = { ...d, commercial: { ...d.commercial, lines: lines.map((l) => ({ ...l, currency: p.currency })) } };
      const row = (await c.query('UPDATE proc_proposals SET draft_enc=$2, draft_version=draft_version+1, updated_at=now() WHERE id=$1 RETURNING id, draft_version', [pr.id, writeDraft(pr.id, next)])).rows[0];
      return { ...row, imported_lines: lines.length };
    });
  },
});
