// Tender documents: each family is built from authorised data into a snapshot, issued once into proc_documents (immutable), and every later
// download renders that stored snapshot, so a document keeps its historical values even if branding, rankings or the tender change.
// Audience is part of the snapshot key: a technical-only scorecard never carries commercial figures, and that scope persists in every export.
import { createHash } from 'node:crypto';
import { one, many, pool } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { toMajor } from '../currency.js';
import { auditLog, buyerRoles, can, canon, getProject, noticeAccess, requireBuyer, requireEntity, stageOf, issuerOf } from './core.js';
import { cardOf, lotsOf } from './rfp.js';
import { renderTenderDocument } from './pdf.js';

export const KINDS = ['notice', 'addendum', 'receipt', 'opening', 'scorecard', 'comparison', 'recommendation', 'award_notice', 'regret_notice', 'agreement'];
const amt = (m, c) => (m === null || m === undefined ? '—' : `${c} ${toMajor(Number(m), c)}`);
const when = (d) => (d ? new Date(d) : null);

const kitFor = async (p) => (await one(p.organisation_id ? 'SELECT display_name, legal_name, address, primary_color, secondary_color, footer_text FROM brand_kits WHERE organisation_id=$1 AND archived_at IS NULL ORDER BY created_at LIMIT 1' : 'SELECT display_name, legal_name, address, primary_color, secondary_color, footer_text FROM brand_kits WHERE owner_user_id=$1 AND archived_at IS NULL ORDER BY created_at LIMIT 1', [p.organisation_id ?? p.owner_user_id])) ?? null;

async function noticeDoc(user, id) {
  const p = await getProject(id); await noticeAccess(user, p);
  const card = await cardOf(p), lots = await lotsOf(pool, p.id), add = await many('SELECT n, summary, issued_at FROM proc_addenda WHERE project_id=$1 ORDER BY n', [p.id]);
  return { p, audience: 'notice', refId: p.id, title: 'Tender notice', subtitle: p.title, reference: p.ref, sections: [
    { heading: 'Notice', rows: [['Issuer', card.issuer.name], ['Reference', p.ref], ['Type', p.kind.toUpperCase()], ['Category', p.category], ['Location', p.location], ['Sites', card.sites.join(', ')], ['Who can take part', card.participation.replace(/_/g, ' ')], ['Contract', p.contract_type.replace(/_/g, ' ')], ['Tender version', p.version]] },
    { heading: 'Scope', text: [p.objective, p.scope].filter(Boolean).join('\n\n'), rows: [['Inclusions', p.inclusions], ['Exclusions', p.exclusions]].filter((r) => r[1]) },
    { heading: 'Schedule', rows: [['Time zone', p.timezone], ['Clarifications until', when(p.clarification_deadline)], ['Site visit', when(p.site_visit_at)], ['Submission closes', when(p.closes_at)], ['Service period', `${p.service_start ? new Date(p.service_start).toISOString().slice(0, 10) : '—'} to ${p.service_end ? new Date(p.service_end).toISOString().slice(0, 10) : '—'}`]] },
    { heading: 'Lots', table: { head: ['Lot', 'Scope', 'Quantity', 'Unit'], rows: lots.map((l) => [l.code, l.title, l.qty, l.unit]), widths: [0.1, 0.55, 0.2, 0.15] } },
    ...(add.length ? [{ heading: 'Addenda', table: { head: ['No.', 'Summary', 'Issued'], rows: add.map((a) => [a.n, a.summary, when(a.issued_at)]), widths: [0.1, 0.65, 0.25] } }] : []),
  ], footnote: 'This notice is public information. Attachments, proposals and bidder identities are not public. Times are shown in UTC.' };
}

async function addendumDoc(user, id, q) {
  const p = await getProject(id); await noticeAccess(user, p);
  const a = await one('SELECT * FROM proc_addenda WHERE project_id=$1 AND n=$2', [p.id, Number(q.n)]);
  if (!a) throw notFound('Addendum');
  return { p, audience: `notice:${a.n}`, refId: p.id, title: `Addendum ${a.n}`, subtitle: p.title, reference: `${p.ref}-A${a.n}`, sections: [{ heading: 'Change', rows: [['Summary', a.summary], ['Reason', a.reason], ['Material change', a.material], ['Changed sections', a.changed_sections.join(', ')], ['Tender version', a.rfp_version], ['New deadline', when(a.new_closes_at)], ['Issued', when(a.issued_at)]], text: a.body ?? '' }] };
}

async function receiptDoc(user, id, q) {
  const pr = await one('SELECT * FROM proc_proposals WHERE id=$1', [id]);
  if (!pr) throw notFound('Proposal');
  await requireEntity(user, pr.entity_id);
  const p = await getProject(pr.project_id), e = await one('SELECT legal_name FROM supplier_entities WHERE id=$1', [pr.entity_id]);
  const s = await one('SELECT * FROM proc_submissions WHERE proposal_id=$1 AND ($2::int IS NULL OR version=$2) ORDER BY version DESC LIMIT 1', [pr.id, q.version ? Number(q.version) : null]);
  if (!s) throw notFound('Receipt');
  return { p, audience: `supplier:${s.version}`, refId: pr.id, title: 'Proposal receipt', subtitle: p.title, reference: s.receipt_no, sections: [{ heading: 'Receipt', rows: [['Tender', p.ref], ['Supplier', e.legal_name], ['Version', s.version], ['Received (server time)', when(s.submitted_at)], ['Tender version', s.rfp_version], ['Addenda acknowledged up to', s.addendum_n], ['Lots', s.lots.join(', ')], ['Content hash (SHA-256)', s.content_hash], ['Late submission', s.late]] }], footnote: 'This receipt proves the proposal was durably received at the time shown. It contains no proposal content or prices.' };
}

async function openingDoc(user, id, q) {
  const { project: p } = await requireBuyer(user, id, 'view');
  const o = await one('SELECT * FROM proc_openings WHERE project_id=$1 AND envelope=$2 AND round=$3', [p.id, q.envelope ?? 'technical', Number(q.round ?? 1)]);
  if (!o) throw notFound('Opening register');
  return { p, audience: `buyer:${o.envelope}:${o.round}`, refId: p.id, title: 'Opening register', subtitle: `${o.envelope} envelope · round ${o.round}`, reference: `${p.ref}-OPEN-${o.envelope.toUpperCase()}`, sections: [
    { heading: 'Opening', rows: [['Opened at', when(o.opened_at)], ['Quorum', p.quorum], ['Register hash', o.hash]] },
    { heading: 'Openers', table: { head: ['Opener'], rows: o.participants.map((x) => [x.handle]) } },
    { heading: 'Submissions present', table: { head: ['Receipt', 'Supplier', 'Received', 'Late'], rows: o.submissions.map((s) => [s.receipt_no, s.supplier, when(s.submitted_at), s.late]), widths: [0.3, 0.35, 0.25, 0.1] } }] };
}

async function rankingRows(p) { return one('SELECT * FROM proc_rankings WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [p.id]); }

async function comparisonDoc(user, id, q, scorecard = false) {
  const { project: p, roles } = await requireBuyer(user, id, 'view');
  const rk = await rankingRows(p);
  if (!rk) throw notFound('Committed ranking');
  const full = can(roles, 'rank') || can(roles, 'audit');
  let rows = rk.rows;
  if (scorecard) { rows = rows.filter((r) => r.id === q.proposal_id); if (!rows.length) throw notFound('Proposal'); }
  const head = full ? ['Rank', 'Supplier', 'Eligibility', 'Technical', 'Commercial', 'Total', 'Evaluated cost'] : ['Supplier', 'Eligibility', 'Technical'];
  const table = { head, rows: rows.map((r) => (full ? [r.rank ?? '—', r.legal_name, r.eligibility, r.technical, r.commercial, r.total, r.evaluated_cost ? amt(r.evaluated_cost.total_minor, r.evaluated_cost.currency) : '—'] : [r.legal_name, r.eligibility, r.technical])), widths: full ? [0.07, 0.25, 0.12, 0.12, 0.14, 0.1, 0.2] : [0.5, 0.25, 0.25], align: full ? ['l', 'l', 'l', 'r', 'r', 'r', 'r'] : ['l', 'l', 'r'] };
  const detail = rows.map((r) => ({ heading: `${r.legal_name}: criteria`, table: { head: ['Criterion', 'Raw', 'Normalised (0-100)'], rows: Object.entries(r.technical_detail ?? {}).map(([k, v]) => [k, v.na ? 'N/A' : v.raw, v.na ? '' : v.normalised]), widths: [0.5, 0.25, 0.25], align: ['l', 'r', 'r'] } }));
  return { p, audience: `${full ? 'full' : 'technical'}${scorecard ? `:${q.proposal_id}` : ''}`, refId: rk.id, title: scorecard ? 'Evaluation scorecard' : 'Ranked comparison', subtitle: p.title, reference: `${p.ref}-${scorecard ? 'SC' : 'CMP'}`, sections: [
    { heading: 'Basis', rows: [['Rubric version', rk.rubric_version], ['Committed', when(rk.created_at)], ['Technical weight', p.rubric?.weights?.technical], ...(full ? [['Commercial weight', p.rubric?.weights?.commercial], ['Cost basis', p.cost_basis]] : [])] },
    { heading: scorecard ? 'Result' : 'Ranking', table }, ...(scorecard ? detail : []),
    ...(full ? [] : [{ heading: 'Scope of this document', text: 'Technical view. Commercial figures are excluded for your role.' }])], footnote: 'Ineligible bids are listed but never ranked. Figures come from the committed ranking snapshot.' };
}

async function recommendationDoc(user, id) {
  const a = await one('SELECT * FROM proc_awards WHERE id=$1', [id]);
  if (!a) throw notFound('Award');
  const { project: p } = await requireBuyer(user, a.project_id, 'view');
  const sc = a.snapshot.scenario;
  const votes = a.approval_id ? await many('SELECT u.handle, v.decision, v.at, v.reason FROM proc_approval_votes v JOIN users u ON u.id=v.user_id WHERE v.approval_id=$1 ORDER BY v.at', [a.approval_id]) : [];
  return { p, audience: 'buyer', refId: a.id, title: 'Award recommendation', subtitle: p.title, reference: `${p.ref}-AWD`, sections: [
    { heading: 'Recommendation', text: a.rationale, rows: [['Scenario', sc.kind.replace(/_/g, ' ')], ['Solver', `${sc.solver}${sc.optimal ? ' (proven best)' : ' (heuristic, not proven optimal)'}`], ['Evaluated cost', amt(sc.cost_minor, sc.currency)], ['Coverage', `${sc.coverage.filled} of ${sc.coverage.total} lots`], ['Rubric version', a.rubric_version], ['Tender version', a.rfp_version]] },
    { heading: 'Allocation', table: { head: ['Lot', 'Supplier', 'Quantity', 'Evaluated cost'], rows: sc.allocation.map((x) => [x.lot, sc.entities?.[x.entity] ?? x.entity, x.qty, amt(x.cost_minor, sc.currency)]), widths: [0.12, 0.4, 0.2, 0.28], align: ['l', 'l', 'r', 'r'] } },
    ...(sc.unfilled?.length ? [{ heading: 'Unfilled lots', table: { head: ['Lot', 'Missing', 'Reason'], rows: sc.unfilled.map((u) => [u.lot, u.missing_qty, u.reason]), widths: [0.15, 0.2, 0.65] } }] : []),
    { heading: 'Approvals', table: { head: ['Approver', 'Decision', 'At'], rows: votes.map((v) => [v.handle, v.decision, when(v.at)]), widths: [0.4, 0.3, 0.3] } }] };
}

async function awardNoticeDoc(user, id, q) {
  const a = await one('SELECT * FROM proc_awards WHERE id=$1', [id]);
  if (!a || !a.notified_at) throw notFound('Award');
  await requireEntity(user, q.entity_id);
  const p = await getProject(a.project_id), e = await one('SELECT legal_name FROM supplier_entities WHERE id=$1', [q.entity_id]);
  const lines = await many('SELECT lot_code, qty::float AS qty, amount_minor, currency, status FROM proc_award_lines WHERE award_id=$1 AND entity_id=$2 ORDER BY lot_code', [a.id, q.entity_id]);
  if (!lines.length) throw notFound('Award notice');
  return { p, audience: `supplier:${q.entity_id}`, refId: a.id, title: 'Provisional award notice', subtitle: p.title, reference: `${p.ref}-AN`, sections: [
    { heading: 'Notice', text: `${e.legal_name} is provisionally awarded the lots below. This is not a contract or a confirmed order until you accept and an order is created.`, rows: [['Respond between', `${when(a.accept_after)?.toISOString().slice(0, 16).replace('T', ' ')} and ${when(a.accept_by)?.toISOString().slice(0, 16).replace('T', ' ')} UTC`]] },
    { heading: 'Lots', table: { head: ['Lot', 'Quantity', 'Amount', 'Status'], rows: lines.map((l) => [l.lot_code, l.qty, amt(l.amount_minor, l.currency), l.status]), widths: [0.2, 0.2, 0.35, 0.25], align: ['l', 'r', 'r', 'l'] } }] };
}

async function regretNoticeDoc(user, id, q) {
  const p = await getProject(id);
  await requireEntity(user, q.entity_id);
  const pr = await one("SELECT * FROM proc_proposals WHERE project_id=$1 AND entity_id=$2 AND status IN ('submitted','withdrawn') ORDER BY round, created_at LIMIT 1", [p.id, q.entity_id]);
  if (!pr) throw notFound('Proposal');
  const won = await one("SELECT 1 FROM proc_award_lines WHERE project_id=$1 AND entity_id=$2 AND status <> 'cancelled' LIMIT 1", [p.id, q.entity_id]);
  if (won) throw badRequest('This supplier has an award notice, not a regret notice');
  if (!(await one("SELECT 1 FROM proc_awards WHERE project_id=$1 AND notified_at IS NOT NULL", [p.id])) && p.status !== 'closed') throw notFound('Outcome');
  const e = await one('SELECT legal_name FROM supplier_entities WHERE id=$1', [q.entity_id]);
  return { p, audience: `supplier:${q.entity_id}`, refId: pr.id, title: 'Outcome notice', subtitle: p.title, reference: `${p.ref}-ON`, sections: [{ heading: 'Outcome', text: `${e.legal_name} was not selected for this tender. Your own scores and the evaluation rationale you are entitled to are available in the debrief in Sportarena.`, rows: [['Your proposal eligibility', pr.eligibility], ['Appeal window', `${Math.max(p.standstill_days, 7)} days from the notice`]] }], footnote: 'No competing prices, scores or identities are disclosed.' };
}

async function agreementDoc(user, id) {
  const o = await one('SELECT * FROM proc_orders WHERE id=$1', [id]);
  if (!o) throw notFound('Order');
  const p = await getProject(o.project_id);
  const supplier = (await one("SELECT 1 FROM supplier_entity_members WHERE entity_id=$1 AND user_id=$2 AND status='active'", [o.entity_id, user.id])) ? true : false;
  if (!supplier && !(await buyerRoles(user, p)).length) throw notFound('Order');
  const s = o.scope;
  return { p, audience: 'parties', refId: o.id, title: 'Service order and agreement summary', subtitle: p.title, reference: o.ref, sections: [
    { heading: 'Parties', rows: [['Buyer', (await issuerOf(p))?.name], ['Supplier', s.supplier.legal_name]] },
    { heading: 'Order', rows: [['Order', o.ref], ['Tender', s.tender.ref], ['Lot', `${s.lot.code} ${s.lot.title}`], ['Quantity', `${s.lot.qty} ${s.lot.unit ?? ''}`], ['Amount', amt(o.amount_minor, o.currency)], ['Contract type', o.contract_type.replace(/_/g, ' ')], ...(o.ceiling_minor ? [['Framework ceiling', amt(o.ceiling_minor, o.currency)]] : []), ['Preparation', o.prep_start && new Date(o.prep_start).toISOString().slice(0, 10)], ['Service', `${o.service_start ? new Date(o.service_start).toISOString().slice(0, 10) : '—'} to ${o.service_end ? new Date(o.service_end).toISOString().slice(0, 10) : '—'}`], ['Teardown', o.teardown_end && new Date(o.teardown_end).toISOString().slice(0, 10)]] },
    { heading: 'Basis', rows: [['Proposal receipt', s.submission.receipt_no], ['Proposal hash', s.submission.content_hash], ['Tender version', s.tender.version], ['Rubric version', s.award.rubric_version]] },
    { heading: 'Status', rows: [['Order', o.status], ['Contract', o.contract_status.replace(/_/g, ' ')]], text: 'Order, contract, delivery and payment are tracked separately. A completed order does not mean it has been paid.' },
    { heading: 'Signatures', text: 'Buyer: ______________________    Supplier: ______________________\nA signature image or manual record is not a validated electronic signature.' }] };
}

const BUILDERS = { notice: noticeDoc, addendum: addendumDoc, receipt: receiptDoc, opening: openingDoc, scorecard: (u, i, q) => comparisonDoc(u, i, q, true), comparison: (u, i, q) => comparisonDoc(u, i, q, false), recommendation: recommendationDoc, award_notice: awardNoticeDoc, regret_notice: regretNoticeDoc, agreement: agreementDoc };

/** Issue (once) and render a tender document. Later requests render the stored snapshot, so history never changes. */
export async function tenderDocument(user, kind, id, q = {}) {
  if (!KINDS.includes(kind)) throw notFound('Document');
  const built = await BUILDERS[kind](user, id, q);
  const stored = await one('SELECT * FROM proc_documents WHERE project_id=$1 AND kind=$2 AND ref_id IS NOT DISTINCT FROM $3 AND audience=$4', [built.p.id, kind, built.refId, built.audience]);
  let snap = stored?.snapshot;
  if (!snap) {
    snap = { title: built.title, subtitle: built.subtitle, reference: built.reference, sections: built.sections, footnote: built.footnote ?? null, kit: await kitFor(built.p), issued_at: new Date().toISOString() };
    const sha = createHash('sha256').update(canon(snap)).digest('hex');
    await pool.query('INSERT INTO proc_documents(project_id, kind, ref_id, audience, snapshot, sha256, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [built.p.id, kind, built.refId, built.audience, JSON.stringify(snap), sha, user.id]);
    snap = (await one('SELECT snapshot FROM proc_documents WHERE project_id=$1 AND kind=$2 AND ref_id IS NOT DISTINCT FROM $3 AND audience=$4', [built.p.id, kind, built.refId, built.audience])).snapshot;
  }
  await auditLog(pool, built.p.id, user.id, 'document_downloaded', { kind, audience: built.audience });
  const { buffer, pages } = await renderTenderDocument({ ...snap, issued_at: snap.issued_at, stamp: 'ISSUED' });
  return { buffer, pages, filename: `${snap.reference}-${kind}.pdf` };
}
