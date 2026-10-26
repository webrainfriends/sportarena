// Tender zone, evaluation: opening register with quorum, qualification gates, assigned/blind scoring, consensus, ranking, sensitivity,
// negotiation rounds (BAFO) and break-glass. Sealed content is read only through the audited gates in tender/core.js.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { auditLog, buyerIds, buyerRoles, can, entityUserIds, getProject, myEntityIds, opening, readEnvelope, requireBuyer, tellUsers, unsealJson } from '../tender/core.js';
import { onApproved, requestApproval } from '../tender/approvals.js';
import { currentSubmission, ensureCost, lockedScores, reviewerChecks, rankRound, rankingInputs, recomputeEligibility, registerHash, runGates } from '../tender/evaluation.js';
import { lotsOf, questionsOf } from '../tender/rfp.js';
import { rubricSchema, sensitivity as sens, technicalScore } from '../tender/scoring.js';

const TAG = 'Tender zone';
const envT = z.enum(['technical', 'commercial']);

/** Names shown to a reviewer: anonymised ("Bidder 3") when any of their assignments is blind. */
const aliasMap = async (c, projectId, userId, round = 1) => {
  const blind = (await c.query("SELECT 1 FROM proc_assignments WHERE project_id=$1 AND user_id=$2 AND blind AND status='active'", [projectId, userId])).rowCount > 0;
  if (!blind) return null;
  const rows = (await c.query("SELECT id FROM proc_proposals WHERE project_id=$1 AND round=$2 AND status IN ('submitted','withdrawn') ORDER BY created_at, id", [projectId, round])).rows;
  return new Map(rows.map((r, n) => [r.id, `Bidder ${n + 1}`]));
};

// ------------------------------------------------------------------ opening
cap({
  name: 'open_envelope', method: 'POST', path: '/rfps/:id/open', tag: TAG,
  summary: 'Cast your opening vote for the technical or commercial envelope. Nothing opens before the submission deadline and the earliest opening time, and the envelope opens only when the configured quorum of different authorised openers has voted; the opening register (who, when, which submissions, hash) is then written permanently. For two envelopes the commercial one opens only after technical sign-off passes. Opening automatically runs the qualification gates and evaluated-cost calculation.',
  input: z.object({ id, envelope: envT.default('technical'), round: z.number().int().min(1).max(10).default(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'open', c, { lock: true });
      const now = new Date((await c.query('SELECT clock_timestamp() AS t')).rows[0].t);
      if (p.suspended_at) throw conflict('The tender is suspended');
      if (!['published', 'evaluation'].includes(p.status)) throw conflict('This tender is not at the opening stage');
      let deadline = p.closes_at;
      if (i.round > 1) deadline = (await c.query('SELECT closes_at FROM proc_rounds WHERE project_id=$1 AND n=$2', [p.id, i.round])).rows[0]?.closes_at;
      if (!deadline || now < new Date(deadline)) throw forbidden('Proposals cannot be opened before the submission deadline');
      if (i.round === 1 && p.opens_at && now < new Date(p.opens_at)) throw forbidden('The earliest opening time has not been reached');
      if (i.envelope === 'commercial') {
        if (p.envelope_mode !== 'sealed_dual') throw badRequest('This tender has no separate commercial envelope');
        if (!(await opening(p.id, 'technical', i.round, c))) throw conflict('Open the technical envelope first');
        if (!(await c.query("SELECT 1 FROM proc_proposals WHERE project_id=$1 AND round=$2 AND tech_signoff='pass' AND commercial_unlocked_at IS NOT NULL", [p.id, i.round])).rowCount) throw conflict('No proposal has passed the technical sign-off yet');
      }
      if (await opening(p.id, i.envelope, i.round, c)) throw conflict('This envelope is already open');
      await c.query('INSERT INTO proc_opening_votes(project_id, envelope, round, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [p.id, i.envelope, i.round, user.id]);
      const votes = (await c.query('SELECT v.user_id, u.handle FROM proc_opening_votes v JOIN users u ON u.id=v.user_id WHERE v.project_id=$1 AND v.envelope=$2 AND v.round=$3 ORDER BY v.at', [p.id, i.envelope, i.round])).rows;
      await auditLog(c, p.id, user.id, 'opening_vote', { envelope: i.envelope, round: i.round });
      if (votes.length < p.quorum) return { opened: false, votes: votes.length, quorum: p.quorum };
      const subs = (await c.query("SELECT s.id, s.receipt_no, s.submitted_at, s.late, e.legal_name, pr.id AS proposal_id FROM proc_proposals pr JOIN proc_submissions s ON s.id=pr.current_submission_id JOIN supplier_entities e ON e.id=pr.entity_id WHERE pr.project_id=$1 AND pr.round=$2 AND pr.status='submitted' AND ($3 = 'technical' OR pr.commercial_unlocked_at IS NOT NULL) ORDER BY s.submitted_at, s.id", [p.id, i.round, i.envelope])).rows;
      const body = { project: p.ref, envelope: i.envelope, round: i.round, participants: votes.map((v) => v.handle), submissions: subs.map((s) => ({ receipt_no: s.receipt_no, supplier: s.legal_name, submitted_at: s.submitted_at, late: s.late })) };
      const reg = (await c.query('INSERT INTO proc_openings(project_id, envelope, round, participants, submissions, hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [p.id, i.envelope, i.round, JSON.stringify(votes.map((v) => ({ user_id: v.user_id, handle: v.handle }))), JSON.stringify(body.submissions), registerHash(body)])).rows[0];
      if (p.status === 'published') await c.query("UPDATE proc_projects SET status='evaluation' WHERE id=$1", [p.id]);
      const fresh = await getProject(p.id, c);
      if (i.envelope === 'technical') {
        for (const s of subs) { const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1', [s.proposal_id])).rows[0]; if (i.round === 1) await runGates(c, fresh, pr); else await carryOver(c, fresh, pr); if (fresh.envelope_mode !== 'sealed_dual') await ensureCost(c, fresh, (await c.query('SELECT * FROM proc_submissions WHERE id=$1', [s.id])).rows[0]); }
      } else for (const s of subs) await ensureCost(c, fresh, (await c.query('SELECT * FROM proc_submissions WHERE id=$1', [s.id])).rows[0]);
      await auditLog(c, p.id, user.id, 'envelope_opened', { envelope: i.envelope, round: i.round, hash: reg.hash, submissions: subs.length });
      return { opened: true, register: reg };
    });
  },
});

/** A re-pricing round inherits the entity's first-round qualification and sign-off. */
async function carryOver(c, p, pr) {
  const first = (await c.query("SELECT * FROM proc_proposals WHERE project_id=$1 AND entity_id=$2 AND round=1 AND alt_key='base'", [p.id, pr.entity_id])).rows[0];
  if (first) await c.query('UPDATE proc_proposals SET eligibility=$2, tech_signoff=$3, tech_signoff_at=$4, commercial_unlocked_at=$5 WHERE id=$1', [pr.id, first.eligibility, first.tech_signoff, first.tech_signoff_at, first.commercial_unlocked_at ?? first.tech_signoff_at]);
}

cap({
  name: 'get_opening_register', method: 'GET', path: '/rfps/:id/openings', tag: TAG, summary: 'The permanent opening register: which envelope was opened, when, by whom, which submissions were present and the register hash. Visible to the buying team and auditors.', input: z.object({ id }),
  async handler({ user }, i) {
    const { project: p } = await requireBuyer(user, i.id, 'view');
    return { quorum: p.quorum, openings: await many('SELECT envelope, round, opened_at, participants, submissions, hash FROM proc_openings WHERE project_id=$1 ORDER BY opened_at', [p.id]), pending_votes: await many('SELECT v.envelope, v.round, u.handle, v.at FROM proc_opening_votes v JOIN users u ON u.id=v.user_id WHERE v.project_id=$1 AND NOT EXISTS (SELECT 1 FROM proc_openings o WHERE o.project_id=v.project_id AND o.envelope=v.envelope AND o.round=v.round)', [p.id]) };
  },
});

// ------------------------------------------------------------------ submissions (buyer view)
cap({
  name: 'list_rfp_submissions', method: 'GET', path: '/rfps/:id/submissions', tag: TAG,
  summary: 'Submitted proposals with receipt, time, eligibility and sign-off. Before the technical envelope is opened only the count and timestamps are shown to the owner and auditors, and nothing to reviewers. Reviewers with a blind assignment see "Bidder N" instead of the supplier name.',
  input: z.object({ id, round: z.coerce.number().int().min(1).default(1), ...page }),
  async handler({ user }, i) {
    const { project: p, roles } = await requireBuyer(user, i.id, 'view');
    const opened = !!(await opening(p.id, 'technical', i.round));
    const rows = await many(`SELECT pr.id, pr.entity_id, e.legal_name, pr.alt_key, pr.lots, pr.status, pr.eligibility, pr.eligibility_reason, pr.tech_signoff, pr.commercial_unlocked_at, s.receipt_no, s.submitted_at, s.version, s.late
      FROM proc_proposals pr JOIN supplier_entities e ON e.id=pr.entity_id LEFT JOIN proc_submissions s ON s.id=pr.current_submission_id WHERE pr.project_id=$1 AND pr.round=$2 AND pr.status IN ('submitted','withdrawn') ORDER BY s.submitted_at, pr.id LIMIT $3 OFFSET $4`, [p.id, i.round, i.limit, i.offset]);
    if (!opened) return { opened: false, count: rows.length, items: can(roles, 'audit') || can(roles, 'members') ? rows.map((r) => ({ submitted_at: r.submitted_at, late: r.late, status: r.status })) : [] };
    const alias = await aliasMap(pool, p.id, user.id, i.round);
    return { opened: true, count: rows.length, items: rows.map((r) => ({ ...r, legal_name: alias ? alias.get(r.id) : r.legal_name, entity_id: alias ? undefined : r.entity_id })) };
  },
});

cap({
  name: 'get_proposal_content', method: 'GET', path: '/rfps/:id/proposals/:pid/content', tag: TAG,
  summary: 'Read one envelope of a proposal as an assigned reviewer (or chair/owner), only after the opening register allows it. Technical reviewers can never read the commercial envelope. Every read is recorded in the audit trail. Blind reviewers get no supplier identity.',
  input: z.object({ id, pid: id, envelope: envT }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p, roles } = await requireBuyer(user, i.id, 'view', c);
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 AND project_id=$2', [i.pid, p.id])).rows[0];
      if (!pr || pr.status === 'draft') throw notFound('Proposal');
      await reviewerChecks(c, p, user, pr);
      const isRev = roles.some((r) => ['technical_evaluator', 'commercial_evaluator'].includes(r)) && !roles.some((r) => ['chair', 'owner'].includes(r));
      if (isRev && !(await c.query("SELECT 1 FROM proc_assignments WHERE project_id=$1 AND user_id=$2 AND section=$3 AND status='active'", [p.id, user.id, i.envelope])).rowCount) throw forbidden('You are not assigned to that part of the evaluation');
      const sub = await currentSubmission(c, pr);
      if (!sub) throw notFound('Submission');
      const content = await readEnvelope(user, roles, p, sub, i.envelope, c);
      const alias = await aliasMap(c, p.id, user.id, pr.round);
      const files = await c.query("SELECT id, name, mime, bytes FROM proc_files WHERE proposal_id=$1 AND audience=$2 AND archived_at IS NULL", [pr.id, i.envelope]);
      return { proposal_id: pr.id, supplier: alias ? alias.get(pr.id) : (await c.query('SELECT legal_name FROM supplier_entities WHERE id=$1', [pr.entity_id])).rows[0].legal_name, receipt_no: sub.receipt_no, version: sub.version, lots: sub.lots, envelope: i.envelope, content, files: files.rows.map((f) => ({ ...f, url: `/api/v1/tender-files/${f.id}` })), questions: (await questionsOf(c, p.id)).map(({ pass_value, ...q }) => q) };
    });
  },
});

// ------------------------------------------------------------------ gates & sign-off
cap({
  name: 'record_gate_result', method: 'POST', path: '/rfps/:id/proposals/:pid/gate', tag: TAG,
  summary: 'Record a manual qualification gate (for example legal review, site assessment or commercial review) as pass or fail with a reason. Automatic gates (terms, site visit, tender version, credentials, pass/fail answers) are set by the system and cannot be edited here; overriding one needs the disqualify/reinstate approval flow.',
  input: z.object({ id, pid: id, gate_key: z.string().regex(/^[a-z0-9_]{2,30}$/), result: z.enum(['pass', 'fail', 'pending']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p, roles } = await requireBuyer(user, i.id, 'view', c, { lock: true });
      const ok = can(roles, 'gate') || (can(roles, 'score_commercial') && i.gate_key === 'commercial_review');
      if (!ok) throw forbidden('Your role cannot record that gate');
      if (['terms', 'site_visit', 'current_version', 'credentials', 'requirements'].includes(i.gate_key)) throw conflict('That gate is automatic. Use a disqualify or reinstate request to override it.');
      if (i.result === 'fail' && !i.reason) throw badRequest('Say why the gate failed');
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 AND project_id=$2', [i.pid, p.id])).rows[0];
      if (!pr || pr.status !== 'submitted') throw notFound('Proposal');
      await reviewerChecks(c, p, user, pr);
      await c.query('INSERT INTO proc_gates(proposal_id, gate_key, result, reason, decided_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (proposal_id, gate_key) DO UPDATE SET result=EXCLUDED.result, reason=EXCLUDED.reason, decided_by=EXCLUDED.decided_by, decided_at=now()', [pr.id, i.gate_key, i.result, i.reason ?? null, user.id]);
      await auditLog(c, p.id, user.id, 'gate_recorded', { proposal_id: pr.id, gate: i.gate_key, result: i.result });
      return recomputeEligibility(c, pr.id);
    });
  },
});

cap({
  name: 'request_bid_status_change', method: 'POST', path: '/rfps/:id/proposals/:pid/status', tag: TAG,
  summary: 'Ask to disqualify a bid or reinstate a disqualified or gate-failed one. Needs a reason and the approval of someone other than you; nothing changes until it is approved, and the decision is audited. A winner is never chosen by price alone unless the published rubric says so.',
  input: z.object({ id, pid: id, action: z.enum(['disqualify', 'reinstate']), reason: z.string().min(10).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'disqualify_request', c, { lock: true });
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 AND project_id=$2', [i.pid, p.id])).rows[0];
      if (!pr || !['submitted', 'withdrawn'].includes(pr.status)) throw notFound('Proposal');
      return requestApproval(c, p, user, i.action, { proposal_id: pr.id, subject: `${i.action}:${pr.id}` }, i.reason);
    });
  },
});
onApproved('disqualify', async (c, a, p) => { await c.query('UPDATE proc_proposals SET disqualified_at=now() WHERE id=$1', [a.payload.proposal_id]); await recomputeEligibility(c, a.payload.proposal_id); await auditLog(c, p.id, a.requested_by, 'bid_disqualified', { proposal_id: a.payload.proposal_id, approval_id: a.id, reason: a.reason }); });
onApproved('reinstate', async (c, a, p) => {
  await c.query("UPDATE proc_proposals SET disqualified_at=NULL, eligibility='eligible', eligibility_reason='Reinstated by approval', updated_at=now() WHERE id=$1", [a.payload.proposal_id]);
  await c.query("UPDATE proc_gates SET result='pass', reason='Overridden by approved reinstatement', decided_at=now() WHERE proposal_id=$1 AND result='fail'", [a.payload.proposal_id]);
  await auditLog(c, p.id, a.requested_by, 'bid_reinstated', { proposal_id: a.payload.proposal_id, approval_id: a.id, reason: a.reason });
});

cap({
  name: 'sign_off_technical', method: 'POST', path: '/rfps/:id/proposals/:pid/technical-signoff', tag: TAG,
  summary: 'Chair: record the technical sign-off for an eligible proposal. A pass needs every technical score locked and the technical result at or above the pass mark with no mandatory threshold failed; it unlocks that bidder\'s commercial envelope for the commercial opening. A fail keeps its commercial envelope sealed for good.',
  input: z.object({ id, pid: id, result: z.enum(['pass', 'fail']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'consensus', c, { lock: true });
      if (p.status !== 'evaluation') throw conflict('The tender is not in evaluation');
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 AND project_id=$2 FOR UPDATE', [i.pid, p.id])).rows[0];
      if (!pr || pr.status !== 'submitted' || pr.round !== 1) throw notFound('Proposal');
      if (!(await opening(p.id, 'technical', 1, c))) throw conflict('Open the technical envelope first');
      if (pr.eligibility !== 'eligible') throw conflict('Only eligible proposals can be signed off');
      if (i.result === 'fail') {
        if (!i.reason) throw badRequest('Say why the technical sign-off failed');
      } else {
        const sub = await currentSubmission(c, pr);
        const rubric = rubricSchema.parse(p.rubric);
        const { by, consensus } = await lockedScores(c, p.id, sub.id);
        const t = technicalScore(rubric, by, consensus);
        if (!t.complete) throw conflict('Technical scores are incomplete. Every criterion needs enough locked scores.', { missing: t.missing });
        if (t.failed.length || t.score < rubric.technical_pass_mark) throw conflict('The technical result is below the pass mark or a mandatory threshold, so it cannot be signed off as a pass');
      }
      await c.query('UPDATE proc_proposals SET tech_signoff=$2, tech_signoff_by=$3, tech_signoff_at=now(), commercial_unlocked_at = CASE WHEN $2=\'pass\' THEN now() ELSE NULL END, updated_at=now() WHERE id=$1', [pr.id, i.result, user.id]);
      await auditLog(c, p.id, user.id, 'technical_signoff', { proposal_id: pr.id, result: i.result, reason: i.reason ?? null });
      if (i.result === 'pass' && p.envelope_mode === 'sealed_dual' && (await opening(p.id, 'commercial', 1, c))) await ensureCost(c, p, await currentSubmission(c, pr));
      return { proposal_id: pr.id, tech_signoff: i.result };
    });
  },
});

// ------------------------------------------------------------------ assignments & scoring
cap({
  name: 'assign_reviewers', method: 'POST', path: '/rfps/:id/assignments', tag: TAG,
  summary: 'Assign evaluators to the technical or commercial section, optionally limited to some criteria or lots, with a weight, and blind (supplier identity hidden). Assignees must hold the matching evaluator role. Reviewers only ever score what they are assigned. Reassign a reviewer by assigning someone else and setting status reassigned.',
  input: z.object({ id, assignments: z.array(z.object({ handle: z.string().max(40), section: envT, criteria: z.array(z.string().max(40)).optional(), lot_codes: z.array(z.string().max(20)).optional(), blind: z.boolean().default(false), weight: z.number().gt(0).max(10).default(1), status: z.enum(['active', 'reassigned']).default('active'), note: z.string().max(300).optional() })).min(1).max(40) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p, roles } = await requireBuyer(user, i.id, null, c, { lock: true });
      if (!can(roles, 'members') && !can(roles, 'consensus')) throw forbidden('Only the owner or chair assigns reviewers');
      if (!['published', 'approved', 'evaluation'].includes(p.status)) throw conflict('Reviewers are assigned before or during evaluation');
      for (const a of i.assignments) {
        const u = (await c.query('SELECT id FROM users WHERE lower(handle)=lower($1)', [a.handle.replace(/^@/, '')])).rows[0];
        if (!u) throw notFound('Person');
        const role = a.section === 'technical' ? 'technical_evaluator' : 'commercial_evaluator';
        if (!(await c.query('SELECT 1 FROM proc_members WHERE project_id=$1 AND user_id=$2 AND role=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())', [p.id, u.id, role])).rowCount) throw badRequest(`${a.handle} needs the ${role.replace(/_/g, ' ')} role first`);
        if (a.status === 'active') await tellUsers(c, [u.id], p, 'tender_assignment', 'Evaluation assignment', `You are assigned to evaluate the ${a.section} part of tender ${p.ref}.`, `asg${a.section}`);
        await c.query(`INSERT INTO proc_assignments(project_id, user_id, section, criteria, lot_codes, blind, weight, status, note, assigned_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (project_id, user_id, section) DO UPDATE SET criteria=EXCLUDED.criteria, lot_codes=EXCLUDED.lot_codes, blind=EXCLUDED.blind, weight=EXCLUDED.weight, status=EXCLUDED.status, note=EXCLUDED.note, assigned_by=EXCLUDED.assigned_by`, [p.id, u.id, a.section, a.criteria ?? null, a.lot_codes ?? null, a.blind, a.weight, a.status, a.note ?? null, user.id]);
      }
      await auditLog(c, p.id, user.id, 'reviewers_assigned', { count: i.assignments.length });
      return many('SELECT a.user_id, u.handle, a.section, a.criteria, a.lot_codes, a.blind, a.weight, a.status FROM proc_assignments a JOIN users u ON u.id=a.user_id WHERE a.project_id=$1 ORDER BY a.section, u.handle', [p.id]);
    });
  },
});

cap({
  name: 'recuse_myself', method: 'POST', path: '/rfps/:id/recuse', tag: TAG,
  summary: 'Step back from scoring this tender (for example you found a conflict). Your draft scores are kept for the record but no longer count; the chair can reassign your work.', input: z.object({ id, reason: z.string().min(5).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'view', c, { lock: true });
      const r = await c.query("UPDATE proc_assignments SET status='reassigned', note=$3 WHERE project_id=$1 AND user_id=$2 AND status='active'", [p.id, user.id, i.reason]);
      if (!r.rowCount) throw conflict('You have no active assignment on this tender');
      await c.query('INSERT INTO proc_conflicts(project_id, user_id, has_conflict, note) VALUES ($1,$2,true,$3)', [p.id, user.id, i.reason]);
      await auditLog(c, p.id, user.id, 'reviewer_recused', { reason: i.reason });
      return { recused: true };
    });
  },
});

cap({
  name: 'save_tender_score', method: 'POST', path: '/rfps/:id/scores', tag: TAG, status: 201,
  summary: 'Score one rubric criterion of a proposal, or mark it not applicable, with a rationale and evidence reference (question key, file id or page). Only assigned reviewers can score, only technical criteria are scored by people (the commercial score is a published formula), and only after the technical envelope is opened. Save as a draft, or lock it (locked scores never change except through a chair-approved reopening). Criteria with evidence_required need an evidence reference to lock.',
  input: z.object({ id, proposal_id: id, criterion_key: z.string().max(40), score: z.number().optional(), na: z.boolean().default(false), rationale: z.string().max(3000).optional(), evidence: z.object({ question_key: z.string().optional(), file_id: id.optional(), page: z.number().int().min(1).optional(), note: z.string().max(300).optional() }).optional(), lock: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p, roles } = await requireBuyer(user, i.id, 'score_technical', c);
      if (p.status !== 'evaluation') throw conflict('Scoring is open only during evaluation');
      const pr = (await c.query("SELECT * FROM proc_proposals WHERE id=$1 AND project_id=$2 AND status='submitted'", [i.proposal_id, p.id])).rows[0];
      if (!pr) throw notFound('Proposal');
      if (pr.round !== 1) throw conflict('Technical scoring applies to the first-round submission');
      if (!(await opening(p.id, 'technical', 1, c))) throw forbidden('The technical envelope is not open');
      await reviewerChecks(c, p, user, pr);
      const rubric = rubricSchema.parse(p.rubric);
      const crit = rubric.criteria.find((x) => x.key === i.criterion_key);
      if (!crit) throw notFound('Criterion');
      const asg = (await c.query("SELECT * FROM proc_assignments WHERE project_id=$1 AND user_id=$2 AND section='technical' AND status='active'", [p.id, user.id])).rows[0];
      if (!asg || (asg.criteria && !asg.criteria.includes(crit.key)) || (asg.lot_codes && crit.lot_code && !asg.lot_codes.includes(crit.lot_code))) throw forbidden('That criterion is not assigned to you');
      if (pr.eligibility !== 'eligible') throw conflict('Only eligible proposals are scored');
      if (!i.na && (i.score === undefined || i.score < crit.scale_min || i.score > crit.scale_max)) throw badRequest(`Score between ${crit.scale_min} and ${crit.scale_max}, or mark it not applicable`);
      if (i.na && i.score !== undefined) throw badRequest('A not-applicable criterion has no score');
      if (i.lock && (!i.rationale?.trim())) throw badRequest('A rationale is required to lock a score');
      if (i.lock && crit.evidence_required && !(i.evidence?.question_key || i.evidence?.file_id || i.evidence?.page)) throw badRequest('This criterion requires an evidence reference');
      const sub = await currentSubmission(c, pr);
      const cur = (await c.query('SELECT * FROM proc_scores WHERE submission_id=$1 AND reviewer_id=$2 AND criterion_key=$3 FOR UPDATE', [sub.id, user.id, crit.key])).rows[0];
      if (cur?.status === 'locked') throw conflict('This score is locked. Ask the chair to reopen it.');
      const row = (await c.query(`INSERT INTO proc_scores(project_id, submission_id, reviewer_id, criterion_key, lot_code, score, na, rationale, evidence, status, locked_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (submission_id, reviewer_id, criterion_key) DO UPDATE SET score=EXCLUDED.score, na=EXCLUDED.na, rationale=EXCLUDED.rationale, evidence=EXCLUDED.evidence, status=EXCLUDED.status, locked_at=EXCLUDED.locked_at, version=proc_scores.version+1, updated_at=now()
        RETURNING id, criterion_key, score::float AS score, na, rationale, evidence, status, version`, [p.id, sub.id, user.id, crit.key, crit.lot_code ?? null, i.na ? null : i.score, i.na, i.rationale ?? null, i.evidence ? JSON.stringify(i.evidence) : null, i.lock ? 'locked' : 'draft', i.lock ? new Date() : null])).rows[0];
      await auditLog(c, p.id, user.id, i.lock ? 'score_locked' : 'score_saved', { proposal_id: pr.id, criterion: crit.key });
      return row;
    });
  },
});

cap({
  name: 'list_tender_scores', method: 'GET', path: '/rfps/:id/scores', tag: TAG,
  summary: 'Scores for one proposal. You always see your own. Other reviewers\' scores appear only to the chair and owner, and to reviewers once everyone assigned to that criterion has locked, so scoring stays independent. Also shows each reviewer\'s completion.',
  input: z.object({ id, proposal_id: id }),
  async handler({ user }, i) {
    const { project: p, roles } = await requireBuyer(user, i.id, 'view');
    const pr = await one('SELECT * FROM proc_proposals WHERE id=$1 AND project_id=$2', [i.proposal_id, p.id]);
    if (!pr?.current_submission_id) throw notFound('Proposal');
    const alias = await aliasMap(pool, p.id, user.id, pr.round);
    const rubric = rubricSchema.parse(p.rubric);
    const asg = await many("SELECT a.user_id, u.handle, a.criteria FROM proc_assignments a JOIN users u ON u.id=a.user_id WHERE a.project_id=$1 AND a.section='technical' AND a.status='active'", [p.id]);
    const all = await many('SELECT s.*, u.handle, s.score::float AS score_n FROM proc_scores s JOIN users u ON u.id=s.reviewer_id WHERE s.submission_id=$1', [pr.current_submission_id]);
    const progress = asg.map((a) => { const need = rubric.criteria.filter((c) => !a.criteria || a.criteria.includes(c.key)).length; const done = all.filter((s) => s.reviewer_id === a.user_id && s.status === 'locked').length; return { handle: a.handle, locked: done, total: need }; });
    const privileged = can(roles, 'consensus') || can(roles, 'members');
    const assignedFor = (ck) => asg.filter((a) => !a.criteria || a.criteria.includes(ck));
    const allLocked = (ck) => assignedFor(ck).every((a) => all.some((x) => x.reviewer_id === a.user_id && x.criterion_key === ck && x.status === 'locked'));
    const visible = all.filter((s) => s.reviewer_id === user.id || (s.status === 'locked' && allLocked(s.criterion_key)));
    const consensus = await many('SELECT criterion_key, score::float AS score, rationale, at FROM proc_consensus WHERE submission_id=$1', [pr.current_submission_id]);
    return { supplier: alias ? alias.get(pr.id) : undefined, scores: visible.map((s) => ({ id: s.id, criterion_key: s.criterion_key, reviewer: s.reviewer_id === user.id ? 'you' : s.handle, score: s.score_n, na: s.na, rationale: s.rationale, evidence: s.evidence, status: s.status, version: s.version })), consensus, progress: privileged ? progress : progress.filter((x) => x.handle), blind: !!alias };
  },
});

cap({
  name: 'reopen_scores', method: 'POST', path: '/rfps/:id/scores/reopen', tag: TAG,
  summary: 'Chair: reopen one reviewer\'s locked score for traceable re-evaluation, with a reason. The earlier value stays in the audit trail and the version number increases; the reviewer must lock a fresh score. Rankings are recomputed live and committed snapshots are not changed.',
  input: z.object({ id, proposal_id: id, criterion_key: z.string().max(40), reviewer_handle: z.string().max(40), reason: z.string().min(10).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'consensus', c, { lock: true });
      if (p.status !== 'evaluation') throw conflict('Scores can only be reopened during evaluation');
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 AND project_id=$2', [i.proposal_id, p.id])).rows[0];
      const rv = (await c.query('SELECT id FROM users WHERE lower(handle)=lower($1)', [i.reviewer_handle.replace(/^@/, '')])).rows[0];
      if (!pr || !rv) throw notFound('Score');
      const r = (await c.query("UPDATE proc_scores SET status='draft', locked_at=NULL, version=version+1, updated_at=now() WHERE submission_id=$1 AND reviewer_id=$2 AND criterion_key=$3 AND status='locked' RETURNING score::float AS was", [pr.current_submission_id, rv.id, i.criterion_key])).rows[0];
      if (!r) throw notFound('Locked score');
      await auditLog(c, p.id, user.id, 'score_reopened', { proposal_id: pr.id, criterion: i.criterion_key, reviewer: i.reviewer_handle, was: r.was, reason: i.reason });
      return { reopened: true };
    });
  },
});

cap({
  name: 'record_consensus', method: 'POST', path: '/rfps/:id/consensus', tag: TAG,
  summary: 'Chair: record a consensus score for a criterion with the chair\'s rationale, after every assigned reviewer has locked theirs. The reviewers\' original scores are kept; the consensus replaces their mean in the ranking.',
  input: z.object({ id, proposal_id: id, criterion_key: z.string().max(40), score: z.number(), rationale: z.string().min(10).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'consensus', c, { lock: true });
      if (p.status !== 'evaluation') throw conflict('Consensus is recorded during evaluation');
      const rubric = rubricSchema.parse(p.rubric);
      const crit = rubric.criteria.find((x) => x.key === i.criterion_key);
      if (!crit) throw notFound('Criterion');
      if (i.score < crit.scale_min || i.score > crit.scale_max) throw badRequest(`Score between ${crit.scale_min} and ${crit.scale_max}`);
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1 AND project_id=$2', [i.proposal_id, p.id])).rows[0];
      if (!pr?.current_submission_id) throw notFound('Proposal');
      const open = (await c.query("SELECT a.user_id FROM proc_assignments a WHERE a.project_id=$1 AND a.section='technical' AND a.status='active' AND (a.criteria IS NULL OR $3 = ANY(a.criteria)) AND NOT EXISTS (SELECT 1 FROM proc_scores s WHERE s.submission_id=$2 AND s.reviewer_id=a.user_id AND s.criterion_key=$3 AND s.status='locked')", [p.id, pr.current_submission_id, i.criterion_key])).rows;
      if (open.length) throw conflict('Every assigned reviewer must lock their score first', { waiting_for: open.length });
      await c.query('INSERT INTO proc_consensus(submission_id, criterion_key, score, rationale, chair_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (submission_id, criterion_key) DO UPDATE SET score=EXCLUDED.score, rationale=EXCLUDED.rationale, chair_id=EXCLUDED.chair_id, at=now()', [pr.current_submission_id, i.criterion_key, i.score, i.rationale, user.id]);
      await auditLog(c, p.id, user.id, 'consensus_recorded', { proposal_id: pr.id, criterion: i.criterion_key, score: i.score });
      return { recorded: true };
    });
  },
});

// ------------------------------------------------------------------ ranking
cap({
  name: 'get_tender_ranking', method: 'GET', path: '/rfps/:id/ranking', tag: TAG,
  summary: 'The live ranking for a round: eligibility, per-criterion scores, technical score, evaluated cost and commercial score (only for bids whose commercial envelope is open), total, exceptions, completeness and tie status. Ineligible bids are listed but never ranked; missing scores or unknown costs block the final ranking and are listed, never turned into zeros. Technical evaluators see technical columns only.',
  input: z.object({ id, round: z.coerce.number().int().min(1).default(1) }),
  async handler({ user }, i) {
    const { project: p, roles } = await requireBuyer(user, i.id, 'view');
    if (!p.rubric) throw conflict('This tender has no rubric');
    if (!(await opening(p.id, 'technical', i.round))) return { opened: false, rows: [], blockers: ['The technical envelope has not been opened'], final: false };
    const priv = can(roles, 'rank');
    const r = rankRound(p, await rankingInputs(pool, p, i.round));
    const alias = await aliasMap(pool, p.id, user.id, i.round);
    const snap = priv ? await one('SELECT created_at FROM proc_rankings WHERE project_id=$1 AND round=$2 ORDER BY created_at DESC LIMIT 1', [p.id, i.round]) : null;
    return { opened: true, final: r.final, committed_at: snap?.created_at ?? null, blockers: priv ? r.blockers : [], rubric_version: p.rubric_version, formula_version: r.formula_version,
      rows: r.rows.map((x) => ({ id: x.id, supplier: alias ? alias.get(x.id) : x.legal_name, eligibility: x.eligibility, technical: x.technical, technical_detail: x.technical_detail, completeness: x.completeness, exceptions: x.exceptions,
        ...(priv ? { commercial: x.commercial, total: x.total, rank: x.rank, tied: x.tied, evaluated_cost: x.evaluated_cost, lots: x.lots, receipt_no: x.receipt_no } : {}) })) };
  },
});

cap({
  name: 'commit_ranking', method: 'POST', path: '/rfps/:id/ranking/commit', tag: TAG, status: 201,
  summary: 'Chair or owner: freeze the current final ranking as an immutable snapshot (rubric version, scores, evaluated costs, exceptions) that awards are based on. It needs a final ranking (no blockers). Later reranking never changes a committed snapshot.',
  input: z.object({ id, round: z.number().int().min(1).default(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'rank', c, { lock: true });
      if (p.status !== 'evaluation') throw conflict('The tender is not in evaluation');
      const r = rankRound(p, await rankingInputs(c, p, i.round));
      if (!r.final) throw conflict('The ranking is not final yet', { blockers: r.blockers });
      const snap = (await c.query('INSERT INTO proc_rankings(project_id, round, rubric_version, rows, blockers, committed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at', [p.id, i.round, p.rubric_version, JSON.stringify(r.rows), JSON.stringify(r.blockers), user.id])).rows[0];
      await auditLog(c, p.id, user.id, 'ranking_committed', { ranking_id: snap.id, round: i.round });
      return snap;
    });
  },
});

cap({
  name: 'ranking_sensitivity', method: 'POST', path: '/rfps/:id/ranking/sensitivity', tag: TAG,
  summary: 'What-if analysis: how the order would change under alternative technical/commercial weights. Never saved and never used for the official award, which always uses the frozen rubric.',
  input: z.object({ id, round: z.number().int().min(1).default(1), alternatives: z.array(z.object({ technical: z.number().min(0).max(100), commercial: z.number().min(0).max(100) }).refine((w) => Math.abs(w.technical + w.commercial - 100) < 1e-9, 'Weights must add up to 100')).min(1).max(10) }),
  async handler({ user }, i) {
    const { project: p } = await requireBuyer(user, i.id, 'rank');
    const inp = await rankingInputs(pool, p, i.round);
    return { official: rankRound(p, inp).rows.filter((x) => x.rank).map((x) => x.id), scenarios: sens(inp.rubric, inp.entries, i.alternatives), note: 'Analysis only. The award uses the frozen rubric.' };
  },
});

// ------------------------------------------------------------------ negotiation rounds
cap({
  name: 'start_tender_round', method: 'POST', path: '/rfps/:id/rounds', tag: TAG, status: 201,
  summary: 'Open a negotiation round with explicitly invited, eligible suppliers: a clarification round, demo, site assessment, or a best-and-final offer (BAFO) with its own deadline. Earlier submissions stay immutable; a BAFO only re-prices, and competitors\' offers are never shared.',
  input: z.object({ id, kind: z.enum(['clarification', 'demo', 'site_assessment', 'bafo']), entity_ids: z.array(id).min(1).max(50), closes_at: z.string().datetime({ offset: true }), note: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'rounds', c, { lock: true });
      if (p.status !== 'evaluation') throw conflict('Rounds run during evaluation');
      if (new Date(i.closes_at) <= new Date()) throw badRequest('The round deadline must be in the future');
      const ok = (await c.query("SELECT entity_id FROM proc_proposals WHERE project_id=$1 AND round=1 AND alt_key='base' AND status='submitted' AND eligibility='eligible' AND entity_id = ANY($2)", [p.id, i.entity_ids])).rows.map((r) => r.entity_id);
      if (ok.length !== new Set(i.entity_ids).size) throw badRequest('Only eligible suppliers with a submitted proposal can be invited');
      const n = (await c.query('SELECT coalesce(max(n),1)+1 AS n FROM proc_rounds WHERE project_id=$1', [p.id])).rows[0].n;
      const row = (await c.query('INSERT INTO proc_rounds(project_id, n, kind, invited, closes_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [p.id, n, i.kind, i.entity_ids, i.closes_at, i.note ?? null, user.id])).rows[0];
      await c.query("UPDATE proc_proposals SET shortlisted=true WHERE project_id=$1 AND round=1 AND entity_id = ANY($2)", [p.id, i.entity_ids]);
      await auditLog(c, p.id, user.id, 'round_started', { n, kind: i.kind, invited: i.entity_ids.length });
      for (const e of i.entity_ids) await tellUsers(c, await entityUserIds(e, c, ['owner', 'bid_manager', 'signatory']), p, 'tender_round', 'You are invited to the next round', `Tender ${p.ref}: ${i.kind === 'bafo' ? 'best and final offer' : i.kind.replace(/_/g, ' ')} round, closes ${new Date(i.closes_at).toISOString()}.`, `rd${n}`);
      return row;
    });
  },
});

cap({
  name: 'list_tender_rounds', method: 'GET', path: '/tenders/:id/rounds', tag: TAG, summary: 'Rounds of a tender. Suppliers see only the rounds they are invited to; buyers see all.', input: z.object({ id }),
  async handler({ user }, i) {
    const p = await getProject(i.id);
    const buyer = (await buyerRoles(user, p)).length > 0;
    if (buyer) return many('SELECT n, kind, invited, closes_at, note FROM proc_rounds WHERE project_id=$1 ORDER BY n', [p.id]);
    const mine = await myEntityIds(user);
    if (!mine.length) throw notFound('Tender');
    return many('SELECT n, kind, closes_at, note FROM proc_rounds WHERE project_id=$1 AND (n=1 OR invited && $2::uuid[]) ORDER BY n', [p.id, mine]);
  },
});

// ------------------------------------------------------------------ break-glass
cap({
  name: 'breakglass_read_envelope', method: 'POST', path: '/admin/rfps/:id/breakglass', tag: TAG, auth: ['admin'],
  summary: 'Platform administrator, exceptional use only: read one sealed envelope with a written justification (at least 20 characters). The reason is stored permanently, the tender owner and auditors are notified, and the call can only read: it cannot change supplier content or rankings.',
  input: z.object({ id, submission_id: id, envelope: envT, reason: z.string().min(20).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await getProject(i.id, c);
      const sub = (await c.query('SELECT * FROM proc_submissions WHERE id=$1 AND project_id=$2', [i.submission_id, p.id])).rows[0];
      if (!sub) throw notFound('Submission');
      await c.query('INSERT INTO proc_breakglass(project_id, actor_id, submission_id, envelope, reason) VALUES ($1,$2,$3,$4,$5)', [p.id, user.id, sub.id, i.envelope, i.reason]);
      await auditLog(c, p.id, user.id, 'breakglass_read', { submission_id: sub.id, envelope: i.envelope, reason: i.reason });
      await tellUsers(c, await buyerIds(p, ['auditor', 'chair']), p, 'tender_breakglass', 'Administrator opened a sealed envelope', `An administrator read a sealed envelope on tender ${p.ref} with a recorded justification.`, `bg${sub.id}${i.envelope}`);
      return { envelope: i.envelope, content: unsealJson(i.envelope === 'technical' ? sub.tech_enc : sub.comm_enc, i.envelope === 'technical' ? 'tech_enc' : 'comm_enc', sub.id), read_only: true };
    });
  },
});
