// Evaluation engine shared by the capabilities: automatic qualification gates, eligibility, evaluated costs and the live ranking inputs.
// Everything here reads sealed content only inside an opening or sign-off that is already authorised and audited.
import { createHash } from 'node:crypto';
import { auditLog, canon, opening, unsealJson } from './core.js';
import { credentialCheck, lotsOf, questionsOf, visitDocs } from './rfp.js';
import { evaluatedCost } from './money.js';
import { rubricSchema, technicalScore, rank } from './scoring.js';

export const currentSubmission = async (c, proposal) => (proposal.current_submission_id ? (await c.query('SELECT * FROM proc_submissions WHERE id=$1', [proposal.current_submission_id])).rows[0] : null);

const setGate = (c, pid, key, result, reason, by = null) => c.query(`INSERT INTO proc_gates(proposal_id, gate_key, result, reason, decided_by) VALUES ($1,$2,$3,$4,$5)
  ON CONFLICT (proposal_id, gate_key) DO UPDATE SET result=EXCLUDED.result, reason=EXCLUDED.reason, decided_by=EXCLUDED.decided_by, decided_at=now()`, [pid, key, result, reason, by]);

export async function recomputeEligibility(c, proposalId) {
  const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1', [proposalId])).rows[0];
  const gates = (await c.query('SELECT * FROM proc_gates WHERE proposal_id=$1', [proposalId])).rows;
  let eligibility = 'eligible', reason = null;
  if (pr.status === 'withdrawn') { eligibility = 'withdrawn'; }
  else if (pr.disqualified_at) { eligibility = 'ineligible'; reason = 'Disqualified'; }
  else if (gates.some((g) => g.result === 'fail')) { eligibility = 'ineligible'; reason = gates.filter((g) => g.result === 'fail').map((g) => `${g.gate_key}: ${g.reason ?? 'failed'}`).join('; '); }
  else if (!gates.length || gates.some((g) => g.result === 'pending')) eligibility = 'pending';
  await c.query('UPDATE proc_proposals SET eligibility=$2, eligibility_reason=$3, updated_at=now() WHERE id=$1', [proposalId, eligibility, reason]);
  return { eligibility, reason };
}

/** Automatic qualification gates for one submitted proposal: terms, site visit, tender version, credentials, pass/fail answers. */
export async function runGates(c, p, pr, { atAward = false } = {}) {
  const sub = await currentSubmission(c, pr);
  if (!sub) return;
  const part = (await c.query('SELECT * FROM proc_participants WHERE project_id=$1 AND entity_id=$2', [p.id, pr.entity_id])).rows[0];
  await setGate(c, pr.id, 'terms', part?.terms_accepted_at ? 'pass' : 'fail', part?.terms_accepted_at ? null : 'Terms not accepted');
  if (p.site_visit_mandatory) { const ok = part?.site_visit_attended || part?.site_visit_exempt_reason; await setGate(c, pr.id, 'site_visit', ok ? 'pass' : 'fail', ok ? null : 'Mandatory site visit not attended'); }
  const vd = await visitDocs(c, p.id, pr.entity_id, sub.submitted_at);
  if (vd.total) await setGate(c, pr.id, 'visit_documents', vd.outstanding.length ? 'fail' : 'pass', vd.outstanding.length ? `Site-visit documents not acknowledged: ${vd.outstanding.map((d) => d.name).join(', ')}` : null);
  await setGate(c, pr.id, 'current_version', sub.rfp_version >= p.version ? 'pass' : 'fail', sub.rfp_version >= p.version ? null : 'Submitted against an earlier tender version; resubmission was required');
  const creds = (await credentialCheck(c, p, pr.entity_id, atAward ? new Date() : null)).filter((x) => x.state !== 'ok');
  await setGate(c, pr.id, 'credentials', creds.length ? 'fail' : 'pass', creds.length ? creds.map((x) => x.detail).join('; ') : null);
  const qs = (await questionsOf(c, p.id)).filter((q) => q.pass_fail);
  if (qs.length) {
    const t = unsealJson(sub.tech_enc, 'tech_enc', sub.id) ?? {}, cm = unsealJson(sub.comm_enc, 'comm_enc', sub.id) ?? {};
    const answers = { ...(t.answers ?? {}), ...(cm.answers ?? {}) };
    const failed = qs.filter((q) => answers[q.key] !== undefined && JSON.stringify(answers[q.key]) !== JSON.stringify(q.pass_value)).map((q) => q.key);
    await setGate(c, pr.id, 'requirements', failed.length ? 'fail' : 'pass', failed.length ? `Did not meet: ${failed.join(', ')}` : null);
  }
  return recomputeEligibility(c, pr.id);
}

/** Evaluated cost of a submission (written once, immutable). */
export async function ensureCost(c, p, sub) {
  const have = (await c.query('SELECT cost FROM proc_submission_costs WHERE submission_id=$1', [sub.id])).rows[0];
  if (have) return have.cost;
  const cm = unsealJson(sub.comm_enc, 'comm_enc', sub.id) ?? { lines: [] };
  const cost = evaluatedCost({ lines: cm.lines, lots: sub.lots, currency: p.currency, fx: p.fx, basis: p.cost_basis });
  cost.valid_until = cm.validity_days ? new Date(new Date(sub.submitted_at).getTime() + cm.validity_days * 864e5).toISOString() : null;
  await c.query('INSERT INTO proc_submission_costs(submission_id, cost, fx_date) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [sub.id, cost, p.fx?.date ?? null]);
  return cost;
}

/** Locked reviewer scores of a submission grouped by criterion, with each reviewer's weight. */
export async function lockedScores(c, projectId, submissionId) {
  const rows = (await c.query(`SELECT s.criterion_key, s.reviewer_id, s.score::float AS score, s.na, coalesce(a.weight,1)::float AS weight FROM proc_scores s
    LEFT JOIN proc_assignments a ON a.project_id=s.project_id AND a.user_id=s.reviewer_id AND a.section='technical'
    WHERE s.project_id=$1 AND s.submission_id=$2 AND s.status='locked'`, [projectId, submissionId])).rows;
  const by = {};
  for (const r of rows) (by[r.criterion_key] ??= []).push({ reviewer_id: r.reviewer_id, score: r.na ? null : r.score, weight: r.weight });
  const cons = {};
  for (const r of (await c.query('SELECT criterion_key, score::float AS score FROM proc_consensus WHERE submission_id=$1', [submissionId])).rows) cons[r.criterion_key] = r.score;
  return { by, consensus: cons };
}

/** Everything the ranking needs for a round. Technical scores come from the entity's first-round submission (a BAFO re-prices only). */
export async function rankingInputs(c, p, round) {
  const rubric = rubricSchema.parse(p.rubric);
  const props = (await c.query("SELECT pr.*, e.legal_name FROM proc_proposals pr JOIN supplier_entities e ON e.id=pr.entity_id WHERE pr.project_id=$1 AND pr.round=$2 AND pr.alt_key='base' AND (pr.status='submitted' OR pr.status='withdrawn') ORDER BY pr.created_at, pr.id", [p.id, round])).rows;
  const openedComm = p.envelope_mode === 'open' || p.envelope_mode === 'sealed_single' ? !!(await opening(p.id, 'technical', round, c)) : !!(await opening(p.id, 'commercial', round, c));
  const entries = [];
  for (const pr of props) {
    const sub = await currentSubmission(c, pr);
    if (!sub) continue;
    const techProp = round === 1 ? pr : (await c.query("SELECT * FROM proc_proposals WHERE project_id=$1 AND entity_id=$2 AND round=1 AND alt_key='base'", [p.id, pr.entity_id])).rows[0];
    const techSub = techProp ? await currentSubmission(c, techProp) : sub;
    const { by, consensus } = techSub ? await lockedScores(c, p.id, techSub.id) : { by: {}, consensus: {} };
    let cost = null, unlocked = false;
    if (p.envelope_mode === 'sealed_dual') unlocked = !!(techProp ?? pr).commercial_unlocked_at && openedComm;
    else unlocked = openedComm;
    if (unlocked && pr.status === 'submitted') cost = (await c.query('SELECT cost FROM proc_submission_costs WHERE submission_id=$1', [sub.id])).rows[0]?.cost ?? null;
    const eligibility = pr.status === 'withdrawn' ? 'withdrawn' : (techProp ?? pr).eligibility;
    entries.push({ id: pr.id, entity_id: pr.entity_id, legal_name: pr.legal_name, submission_id: sub.id, receipt_no: sub.receipt_no, lots: sub.lots, eligibility, tech_signoff: (techProp ?? pr).tech_signoff, commercial_unlocked: unlocked,
      technical: p.rubric.weights.technical > 0 ? technicalScore(rubric, by, consensus) : { score: 0, complete: true, missing: [], failed: [], by_criterion: {} },
      cost_minor: cost?.total_minor ?? null, cost, submitted_at: sub.submitted_at });
  }
  return { rubric, entries };
}

export function rankRound(p, inputs) {
  const r = rank(inputs.rubric, inputs.entries);
  const meta = new Map(inputs.entries.map((e) => [e.id, e]));
  return { ...r, rows: r.rows.map((x) => { const e = meta.get(x.id); return { ...x, entity_id: e.entity_id, legal_name: e.legal_name, submission_id: e.submission_id, receipt_no: e.receipt_no, lots: e.lots, tech_signoff: e.tech_signoff, commercial_unlocked: e.commercial_unlocked, technical_detail: e.technical.by_criterion, evaluated_cost: e.cost ? { total_minor: e.cost.total_minor, currency: e.cost.currency, per_lot: e.cost.per_lot, qty_per_lot: e.cost.qty_per_lot, valid_until: e.cost.valid_until, original: e.cost.original, basis: e.cost.basis } : null }; }) };
}

import { forbidden } from '../errors.js';

/** An evaluator must not work for the supplier, must have declared conflicts, and must not be recused from this supplier. */
export async function reviewerChecks(c, p, user, proposal) {
  const ent = proposal.entity_id;
  if ((await c.query("SELECT 1 FROM supplier_entity_members WHERE entity_id=$1 AND user_id=$2 AND status='active'", [ent, user.id])).rowCount) throw forbidden('You work for this supplier and cannot evaluate it');
  const decl = (await c.query('SELECT * FROM proc_conflicts WHERE project_id=$1 AND user_id=$2 ORDER BY declared_at DESC', [p.id, user.id])).rows;
  if (!decl.length) throw forbidden('Declare whether you have a conflict of interest before evaluating');
  if (decl.some((d) => d.has_conflict && (!d.entity_id || d.entity_id === ent))) throw forbidden('You declared a conflict that excludes you from this supplier');
}


export const registerHash = (obj) => createHash('sha256').update(canon(obj)).digest('hex');
export { auditLog, lotsOf };
