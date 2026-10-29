// Tender zone, award and handoff: scenarios, human-approved recommendation, atomic award notice, supplier acceptance that creates exactly one
// order and one budget commitment, framework call-offs, outcomes/debriefs and appeals. Provisional award, supplier acceptance, contract and
// order statuses are separate columns on purpose: none implies another, and none implies delivery or payment.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { auditLog, buyerIds, buyerRoles, can, entityUserIds, getProject, issuerOf, lockProject, myEntityIds, requireBuyer, requireEntity, tellUsers } from '../tender/core.js';
import { onApproved, onRejected, requestApproval } from '../tender/approvals.js';
import { buildScenario, SCENARIO_KINDS } from '../tender/award.js';
import { lotsOf, credentialCheck } from '../tender/rfp.js';
import { rubricSchema, technicalScore } from '../tender/scoring.js';
import { lockedScores } from '../tender/evaluation.js';
import { ensureServiceOrder, commitTenderOrder, addCallOffLine } from '../svc/from-tender.js';
import { cancelOrderRecords } from '../svc/orders.js';

const TAG = 'Tender zone';
const BUDGET_CATEGORY = (cat) => (/ground|pitch|pool|venue|maint/i.test(cat) ? 'venue' : /crew|staff|ball/i.test(cat) ? 'staff' : /electric|wi-?fi|connect|equip|install/i.test(cat) ? 'equipment' : /travel|transport/i.test(cat) ? 'transport' : /cater/i.test(cat) ? 'catering' : 'other');

/** Quantity of each lot already taken by live award lines (provisional or accepted), so follow-up awards only cover what is left. */
const takenQty = async (c, projectId) => {
  const rows = (await c.query("SELECT lot_code, sum(qty)::float AS q FROM proc_award_lines WHERE project_id=$1 AND status IN ('provisional','accepted') GROUP BY lot_code", [projectId])).rows;
  return Object.fromEntries(rows.map((r) => [r.lot_code, r.q]));
};

/**
 * Lots that still have quantity to award after a supplier declined or let its offer expire, with who was already offered each lot and, under
 * the tender's published reserve rule, the next eligible bidder in ranking order (never one who already had the lot). Reserve awards are never
 * automatic: they go through a fresh scenario, recommendation and approval.
 */
export async function reservePlan(c, p, rk) {
  const hist = (await c.query("SELECT l.id, l.lot_code, l.entity_id, l.status, l.decline_reason, l.responded_at, e.legal_name FROM proc_award_lines l JOIN supplier_entities e ON e.id=l.entity_id WHERE l.project_id=$1 AND l.status IN ('declined','expired') ORDER BY l.responded_at NULLS LAST, l.id", [p.id])).rows;
  if (!hist.length) return [];
  const taken = await takenQty(c, p.id);
  const byLot = {};
  for (const h of hist) (byLot[h.lot_code] ??= []).push(h);
  const out = [];
  for (const lot of await lotsOf(c, p.id)) {
    const open = lot.qty - (taken[lot.code] ?? 0);
    if (!byLot[lot.code] || open <= 1e-9) continue;
    const tried = new Set(byLot[lot.code].map((h) => h.entity_id));
    const next = (rk?.rows ?? []).filter((r) => r.rank && r.evaluated_cost?.per_lot?.[lot.code] && r.evaluated_cost.qty_per_lot?.[lot.code] && !tried.has(r.entity_id)).sort((a, b) => a.rank - b.rank || b.total - a.total)[0];
    out.push({ lot: lot.code, title: lot.title, qty_open: open, previous: byLot[lot.code].map((h) => ({ line_id: h.id, entity_id: h.entity_id, supplier: h.legal_name, status: h.status, reason: h.decline_reason })), next: next ? { entity_id: next.entity_id, supplier: next.legal_name, rank: next.rank } : null, allowed: p.reserve_policy === 'next_ranked' });
  }
  return out;
}

// ------------------------------------------------------------------ scenarios
cap({
  name: 'build_award_scenario', method: 'POST', path: '/rfps/:id/scenarios', tag: TAG, status: 201,
  summary: 'Compare an award on the committed ranking: highest score, lowest compliant evaluated cost, single supplier, or split by lot/quantity, under constraints (maximum suppliers, minimum score, budget, supplier exposure). The result shows allocation, evaluated cost, coverage, unfilled lots with reasons, constraint violations and budget impact. Small cases are solved exhaustively and reported as proven best; larger ones use a heuristic that is labelled as such and never presented as a global optimum. Only eligible, ranked bidders are considered; lots already awarded are not offered again.',
  input: z.object({ id, kind: z.enum(SCENARIO_KINDS), ranking_id: id.optional(), max_suppliers: z.number().int().min(1).max(50).optional(), min_score: z.number().min(0).max(100).optional(), budget_minor: z.number().int().min(0).optional(), max_exposure_minor: z.number().int().min(0).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'scenario', c, { lock: true });
      if (!['evaluation', 'award'].includes(p.status)) throw conflict('Scenarios are built during evaluation');
      const rk = (await c.query(`SELECT * FROM proc_rankings WHERE project_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at DESC LIMIT 1`, [p.id, i.ranking_id ?? null])).rows[0];
      if (!rk) throw conflict('Commit a final ranking first');
      const taken = await takenQty(c, p.id);
      let lots = (await lotsOf(c, p.id)).map((l) => ({ code: l.code, qty: l.qty - (taken[l.code] ?? 0), estimate_minor: l.estimate_minor })).filter((l) => l.qty > 1e-9);
      if (!lots.length) throw conflict('Every lot is already awarded');
      const plan = await reservePlan(c, p, rk);
      const reserveByLot = new Map(plan.map((x) => [x.lot, x]));
      const blocked = p.reserve_policy === 'none' ? plan.map((x) => x.lot) : [];
      if (blocked.length) {
        lots = lots.filter((l) => !blocked.includes(l.code));
        if (!lots.length) throw conflict(`This tender's published rule does not allow a declined or expired lot to go to another bidder (lots ${blocked.join(', ')}). Re-tender those lots or close the tender without further award.`, { blocked });
      }
      const declined = (await c.query("SELECT lot_code, entity_id FROM proc_award_lines WHERE project_id=$1 AND status IN ('declined','expired')", [p.id])).rows;
      const offers = [];
      for (const row of rk.rows.filter((r) => r.rank && r.evaluated_cost)) {
        const lotsMap = {};
        for (const l of lots) {
          const q = row.evaluated_cost.qty_per_lot?.[l.code], cost = row.evaluated_cost.per_lot?.[l.code];
          if (!q || !cost || declined.some((d) => d.lot_code === l.code && d.entity_id === row.entity_id)) continue;
          if (reserveByLot.has(l.code) && reserveByLot.get(l.code).next?.entity_id !== row.entity_id) continue;   // a reserve lot is offered only to the next bidder in ranking order
          const unit = cost / q;
          lotsMap[l.code] = { unit_cost_minor: unit, capacity: Math.min(q, l.qty), cost_minor: q >= l.qty ? Math.round(unit * l.qty) : cost };
        }
        offers.push({ entity: row.entity_id, score: row.total, capacity_ok: true, lots: lotsMap });
      }
      const budget = i.budget_minor ?? (p.budget_minor !== null ? Number(p.budget_minor) : undefined);
      const res = buildScenario(i.kind, lots, offers, { max_suppliers: i.max_suppliers, min_score: i.min_score, budget_minor: budget, max_exposure_minor: i.max_exposure_minor });
      const names = Object.fromEntries(rk.rows.map((r) => [r.entity_id, r.legal_name]));
      const row = (await c.query('INSERT INTO proc_scenarios(project_id, ranking_id, kind, constraints, result, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at', [p.id, rk.id, i.kind, JSON.stringify({ max_suppliers: i.max_suppliers, min_score: i.min_score, budget_minor: budget, max_exposure_minor: i.max_exposure_minor }), JSON.stringify({ ...res, entities: names, currency: p.currency, ranking_id: rk.id, reserve: plan.filter((x) => lots.some((l) => l.code === x.lot)).map((x) => ({ lot: x.lot, entity: x.next?.entity_id ?? null, rank: x.next?.rank ?? null, replaces: x.previous.map((h) => h.line_id) })), reserve_blocked: blocked }), user.id])).rows[0];
      await auditLog(c, p.id, user.id, 'scenario_built', { scenario_id: row.id, kind: i.kind, feasible: res.feasible, solver: res.solver });
      return { id: row.id, ...res, entities: names, currency: p.currency, ranking_id: rk.id, reserve: plan.filter((x) => lots.some((l) => l.code === x.lot)), reserve_blocked: blocked };
    });
  },
});

cap({
  name: 'list_award_scenarios', method: 'GET', path: '/rfps/:id/scenarios', tag: TAG, summary: 'Scenarios built for this tender, newest first, for side-by-side comparison.', input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { project: p } = await requireBuyer(user, i.id, 'scenario');
    return many('SELECT id, kind, constraints, result, created_at FROM proc_scenarios WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [p.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ recommendation & approval
cap({
  name: 'recommend_tender_award', method: 'POST', path: '/rfps/:id/awards', tag: TAG, status: 201,
  summary: 'Chair: recommend an award from a scenario with a written rationale. It then needs human approval (more approvals above the organisation\'s award threshold; never the requester). Nothing is awarded, notified or committed until approved and issued. An award that leaves lots unfilled is a partial award and needs allow_partial. No AI step can award.',
  input: z.object({ id, scenario_id: id, rationale: z.string().min(20).max(4000), allow_partial: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'recommend', c, { lock: true });
      if (!['evaluation', 'award'].includes(p.status)) throw conflict('The tender is not ready for an award');
      const sc = (await c.query('SELECT * FROM proc_scenarios WHERE id=$1 AND project_id=$2', [i.scenario_id, p.id])).rows[0];
      if (!sc) throw notFound('Scenario');
      const r = sc.result;
      if (!r.allocation?.length) throw conflict('That scenario allocates nothing');
      if (r.violations?.length) throw conflict('That scenario breaks its constraints', { violations: r.violations });
      if (r.unfilled?.length && !i.allow_partial) throw conflict('That scenario leaves lots unfilled. Confirm a partial award to continue.', { unfilled: r.unfilled });
      const rk = (await c.query('SELECT id, rubric_version FROM proc_rankings WHERE id=$1', [sc.ranking_id])).rows[0];
      const a = (await c.query(`INSERT INTO proc_awards(project_id, scenario_id, rationale, rubric_version, rfp_version, snapshot, recommended_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [p.id, sc.id, i.rationale, rk.rubric_version, p.version, JSON.stringify({ scenario: r, ranking_id: sc.ranking_id }), user.id])).rows[0];
      const ap = await requestApproval(c, p, user, 'award', { award_id: a.id, subject: `award:${a.id}`, reserve: (r.reserve ?? []).map((x) => x.lot) }, i.rationale, r.cost_minor);
      await c.query('UPDATE proc_awards SET approval_id=$2 WHERE id=$1', [a.id, ap.id]);
      await c.query("UPDATE proc_projects SET status='award' WHERE id=$1", [p.id]);
      await auditLog(c, p.id, user.id, 'award_recommended', { award_id: a.id, scenario_id: sc.id });
      return { ...a, approval_id: ap.id, approvals_required: ap.required };
    });
  },
});
onApproved('award', async (c, a, p) => { await c.query("UPDATE proc_awards SET status='approved', updated_at=now() WHERE id=$1 AND status='approval_pending'", [a.payload.award_id]); await tellUsers(c, await buyerIds(p, ['chair']), p, 'tender_award_approved', 'Award approved', `The award for tender ${p.ref} is approved and can be issued.`, a.id); });
onRejected('award', async (c, a, p) => { await c.query("UPDATE proc_awards SET status='cancelled', updated_at=now() WHERE id=$1", [a.payload.award_id]); await c.query("UPDATE proc_projects SET status='evaluation' WHERE id=$1 AND status='award'", [p.id]); });

// ------------------------------------------------------------------ notice (atomic allocation)
async function refreshAward(c, awardId) {
  const lines = (await c.query('SELECT status FROM proc_award_lines WHERE award_id=$1', [awardId])).rows;
  const n = (s) => lines.filter((l) => l.status === s).length;
  let status = 'notified';
  if (n('provisional') === 0) status = n('accepted') === 0 ? (n('cancelled') === lines.length ? 'cancelled' : 'declined') : n('accepted') === lines.length ? 'accepted' : 'partially_accepted';
  else if (n('accepted')) status = 'partially_accepted';
  const a = (await c.query('UPDATE proc_awards SET status=$2, updated_at=now() WHERE id=$1 RETURNING project_id, status', [awardId, status])).rows[0];
  if (status === 'accepted' || status === 'partially_accepted') {
    const acc = Object.fromEntries((await c.query("SELECT lot_code, sum(qty)::float AS q FROM proc_award_lines WHERE project_id=$1 AND status='accepted' GROUP BY lot_code", [a.project_id])).rows.map((r) => [r.lot_code, r.q]));
    const lots = await lotsOf(c, a.project_id);
    if (lots.every((l) => (acc[l.code] ?? 0) + 1e-9 >= l.qty)) await c.query("UPDATE proc_projects SET status='awarded' WHERE id=$1", [a.project_id]);
  }
  return status;
}
async function expireLines(c, awardId) {
  const a = (await c.query('SELECT * FROM proc_awards WHERE id=$1', [awardId])).rows[0];
  if (a?.accept_by && new Date() > new Date(a.accept_by)) {
    const r = await c.query("UPDATE proc_award_lines SET status='expired' WHERE award_id=$1 AND status='provisional'", [awardId]);
    if (r.rowCount) await refreshAward(c, awardId);
  }
}

cap({
  name: 'issue_award_notice', method: 'POST', path: '/awards/:id/notify', tag: TAG,
  summary: 'Issue the approved award as provisional award notices. Under one lock it re-checks, for every winner: still eligible and not disqualified, credentials and insurance still valid today, the quote still valid, quantities not already allocated, and spend limits (tender budget and event spend cap). Any failure blocks the notice and says why. Suppliers then accept or decline within the window (after any standstill period). Unsuccessful bidders are told an outcome is available.',
  input: z.object({ id, accept_within_days: z.number().int().min(1).max(60).default(7) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = (await c.query('SELECT * FROM proc_awards WHERE id=$1', [i.id])).rows[0];
      if (!a0) throw notFound('Award');
      const { project: p } = await requireBuyer(user, a0.project_id, 'recommend', c, { lock: true });
      const a = (await c.query('SELECT * FROM proc_awards WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (a.status !== 'approved') throw conflict(a.status === 'approval_pending' ? 'The award is still waiting for approval' : `This award is ${a.status}`);
      const alloc = a.snapshot.scenario.allocation;
      const taken = await takenQty(c, p.id);
      const lots = await lotsOf(c, p.id);
      const problems = [];
      let total = 0;
      for (const x of alloc) {
        const lot = lots.find((l) => l.code === x.lot);
        if ((taken[x.lot] ?? 0) + x.qty > lot.qty + 1e-9) problems.push(`Lot ${x.lot} would be over-allocated`);
        total += x.cost_minor;
        const pr = (await c.query("SELECT * FROM proc_proposals WHERE project_id=$1 AND entity_id=$2 AND status='submitted' AND alt_key='base' ORDER BY round DESC LIMIT 1", [p.id, x.entity])).rows[0];
        if (!pr || pr.eligibility !== 'eligible' || pr.disqualified_at) { problems.push(`${a.snapshot.scenario.entities?.[x.entity] ?? 'A supplier'} is no longer eligible`); continue; }
        const ent = (await c.query("SELECT status FROM supplier_entities WHERE id=$1", [x.entity])).rows[0];
        if (ent?.status !== 'active') problems.push(`${a.snapshot.scenario.entities?.[x.entity] ?? 'A supplier'} is suspended`);
        for (const ch of (await credentialCheck(c, p, x.entity, new Date())).filter((q) => q.state !== 'ok')) problems.push(`${a.snapshot.scenario.entities?.[x.entity] ?? 'A supplier'}: ${ch.detail}`);
        const cost = (await c.query('SELECT cost FROM proc_submission_costs WHERE submission_id=$1', [pr.current_submission_id])).rows[0]?.cost;
        if (cost?.valid_until && new Date(cost.valid_until) < new Date()) problems.push(`${a.snapshot.scenario.entities?.[x.entity] ?? 'A supplier'}: the quote has expired`);
      }
      if (p.budget_minor !== null && total > Number(p.budget_minor)) problems.push('The award exceeds the tender budget');
      if (p.event_id) {
        const eb = (await c.query('SELECT currency, spend_cap_cents FROM event_budgets WHERE event_id=$1', [p.event_id])).rows[0];
        if (eb?.spend_cap_cents !== null && eb?.spend_cap_cents !== undefined && eb.currency === p.currency) {
          const used = (await c.query("SELECT coalesce(sum(committed_cents),0)::bigint AS s FROM event_budget_lines WHERE event_id=$1 AND direction='expense' AND status <> 'void'", [p.event_id])).rows[0].s;
          if (Number(used) + total > Number(eb.spend_cap_cents)) problems.push('The award would exceed the event spend cap');
        }
      }
      if (problems.length) throw conflict('The award cannot be issued yet', { problems });
      const accept_after = new Date(Date.now() + p.standstill_days * 864e5), accept_by = new Date(accept_after.getTime() + i.accept_within_days * 864e5);
      const sub = async (entity) => (await c.query("SELECT pr.id AS proposal_id, pr.current_submission_id AS submission_id FROM proc_proposals pr WHERE pr.project_id=$1 AND pr.entity_id=$2 AND pr.status='submitted' AND pr.alt_key='base' ORDER BY pr.round DESC LIMIT 1", [p.id, entity])).rows[0];
      for (const x of alloc) {
        const s = await sub(x.entity);
        const reserve = (a.snapshot.scenario.reserve ?? []).find((r) => r.lot === x.lot && r.entity === x.entity);
        if (reserve && p.reserve_policy !== 'next_ranked') throw conflict('The tender\'s published rule does not allow reserve awards');
        const replaces = reserve ? (await c.query("SELECT id FROM proc_award_lines WHERE project_id=$1 AND lot_code=$2 AND status IN ('declined','expired') ORDER BY responded_at DESC NULLS LAST, id DESC LIMIT 1", [p.id, x.lot])).rows[0]?.id ?? null : null;
        await c.query('INSERT INTO proc_award_lines(award_id, project_id, lot_code, entity_id, proposal_id, submission_id, qty, amount_minor, currency, reserve_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [a.id, p.id, x.lot, x.entity, s.proposal_id, s.submission_id, x.qty, x.cost_minor, p.currency, replaces]);
      }
      await c.query("UPDATE proc_awards SET status='notified', notified_at=now(), accept_after=$2, accept_by=$3, updated_at=now() WHERE id=$1", [a.id, accept_after, accept_by]);
      await auditLog(c, p.id, user.id, 'award_notified', { award_id: a.id, lines: alloc.length, total_minor: total });
      const winners = new Set(alloc.map((x) => x.entity));
      for (const e of winners) await tellUsers(c, await entityUserIds(e, c, ['owner', 'bid_manager', 'signatory']), p, 'tender_award_notice', 'Provisional award', `Tender ${p.ref}: you have a provisional award. Review and respond by ${accept_by.toISOString()}.`, `aw${a.id}`);
      const others = (await c.query("SELECT DISTINCT entity_id FROM proc_proposals WHERE project_id=$1 AND status IN ('submitted','withdrawn')", [p.id])).rows.map((r) => r.entity_id).filter((e) => !winners.has(e));
      for (const e of others) await tellUsers(c, await entityUserIds(e, c, ['owner', 'bid_manager', 'signatory']), p, 'tender_outcome', 'Tender outcome available', `The outcome of tender ${p.ref} is available.`, `out${a.id}`);
      return { award_id: a.id, status: 'notified', accept_after, accept_by };
    });
  },
});

cap({
  name: 'cancel_tender_award', method: 'POST', path: '/awards/:id/cancel', tag: TAG, summary: 'Cancel an award that no supplier has accepted yet, with a reason. Lines are cancelled (kept for the record) and the tender returns to evaluation so a corrected award can be built.', input: z.object({ id, reason: z.string().min(10).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = (await c.query('SELECT * FROM proc_awards WHERE id=$1', [i.id])).rows[0];
      if (!a0) throw notFound('Award');
      const { project: p } = await requireBuyer(user, a0.project_id, 'recommend', c, { lock: true });
      const a = (await c.query('SELECT * FROM proc_awards WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!['approval_pending', 'approved', 'notified'].includes(a.status)) throw conflict('Only an award that has not been accepted can be cancelled');
      if ((await c.query("SELECT 1 FROM proc_award_lines WHERE award_id=$1 AND status='accepted'", [a.id])).rowCount) throw conflict('A supplier already accepted part of this award');
      await c.query("UPDATE proc_award_lines SET status='cancelled' WHERE award_id=$1 AND status='provisional'", [a.id]);
      await c.query("UPDATE proc_awards SET status='cancelled', updated_at=now() WHERE id=$1", [a.id]);
      await c.query("UPDATE proc_projects SET status='evaluation' WHERE id=$1 AND status='award'", [p.id]);
      await auditLog(c, p.id, user.id, 'award_cancelled', { award_id: a.id, reason: i.reason });
      return { status: 'cancelled' };
    });
  },
});

cap({
  name: 'close_without_award', method: 'POST', path: '/rfps/:id/no-award', tag: TAG, summary: 'Close the tender without an award (no compliant bid, budget gone, requirement changed), with a reason. Bidders are told. Nothing is committed and every submission and score is kept.', input: z.object({ id, reason: z.string().min(10).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'recommend', c, { lock: true });
      if (!['evaluation', 'award'].includes(p.status)) throw conflict('Only a tender under evaluation can close without an award');
      if ((await c.query("SELECT 1 FROM proc_awards WHERE project_id=$1 AND status IN ('approval_pending','approved','notified','partially_accepted','accepted')", [p.id])).rowCount) throw conflict('Cancel or finish the current award first');
      await c.query("UPDATE proc_projects SET status='closed', cancelled_reason=$2 WHERE id=$1", [p.id, i.reason]);
      await auditLog(c, p.id, user.id, 'closed_without_award', { reason: i.reason });
      for (const r of (await c.query("SELECT DISTINCT entity_id FROM proc_proposals WHERE project_id=$1 AND status IN ('submitted','withdrawn')", [p.id])).rows) await tellUsers(c, await entityUserIds(r.entity_id, c), p, 'tender_outcome', 'Tender outcome available', `Tender ${p.ref} closed without an award.`, 'noaward');
      return { status: 'closed' };
    });
  },
});

cap({
  name: 'get_tender_award', method: 'GET', path: '/awards/:id', tag: TAG, summary: 'An award with its snapshot (rubric and tender version, scenario, ranking), lines and statuses, and the approval trail. Buyer team only.', input: z.object({ id }),
  async handler({ user }, i) {
    const a = await one('SELECT * FROM proc_awards WHERE id=$1', [i.id]);
    if (!a) throw notFound('Award');
    await requireBuyer(user, a.project_id, 'view');
    await tx((c) => expireLines(c, a.id));
    const fresh = await one('SELECT * FROM proc_awards WHERE id=$1', [a.id]);
    const lines = await many('SELECT l.id, l.lot_code, l.entity_id, e.legal_name AS supplier, l.qty::float AS qty, l.amount_minor, l.currency, l.status, l.reserve_of, l.responded_at, l.decline_reason, o.id AS order_id, o.ref AS order_ref FROM proc_award_lines l JOIN supplier_entities e ON e.id=l.entity_id LEFT JOIN proc_orders o ON o.award_line_id=l.id WHERE l.award_id=$1 ORDER BY l.lot_code', [a.id]);
    const approval = fresh.approval_id ? await one("SELECT a.id, a.status, a.required, (SELECT count(*)::int FROM proc_approval_votes v WHERE v.approval_id=a.id AND v.decision='approve') AS approvals FROM proc_approvals a WHERE a.id=$1", [fresh.approval_id]) : null;
    return { ...fresh, lines, approval };
  },
});

cap({
  name: 'list_tender_awards', method: 'GET', path: '/rfps/:id/awards', tag: TAG, summary: 'Awards of a tender.', input: z.object({ id }),
  async handler({ user }, i) { const { project: p } = await requireBuyer(user, i.id, 'view'); return many('SELECT id, status, rationale, notified_at, accept_after, accept_by, created_at FROM proc_awards WHERE project_id=$1 ORDER BY created_at DESC', [p.id]); },
});

// ------------------------------------------------------------------ supplier response & handoff
cap({
  name: 'respond_to_award_line', method: 'POST', path: '/award-lines/:id/respond', tag: TAG,
  summary: 'Accept or decline your provisional award for a lot (owner or authorised signatory), inside the acceptance window and after any standstill period. Acceptance is idempotent and atomic: it creates exactly one order and one budget commitment however many times it is sent, and cannot over-allocate. Declining needs a reason and lets the buyer award the lot to a reserve bidder with fresh approval.',
  input: z.object({ id, action: z.enum(['accept', 'decline']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l0 = (await c.query('SELECT * FROM proc_award_lines WHERE id=$1', [i.id])).rows[0];
      if (!l0) throw notFound('Award');
      await requireEntity(user, l0.entity_id, ['owner', 'signatory'], c);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`award_line:${i.id}`]);
      const p = await lockProject(c, l0.project_id);
      await expireLines(c, l0.award_id);
      const l = (await c.query('SELECT * FROM proc_award_lines WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const a = (await c.query('SELECT * FROM proc_awards WHERE id=$1', [l.award_id])).rows[0];
      if (l.status === 'accepted' && i.action === 'accept') return { status: 'accepted', order: (await c.query('SELECT id, ref, status, amount_minor, currency FROM proc_orders WHERE award_line_id=$1', [l.id])).rows[0], replayed: true };
      if (l.status === 'declined' && i.action === 'decline') return { status: 'declined', replayed: true };
      if (l.status !== 'provisional') throw conflict(l.status === 'expired' ? 'The acceptance window has passed' : `This award line is ${l.status}`);
      if (a.accept_after && new Date() < new Date(a.accept_after)) throw conflict('The standstill period has not ended yet', { accept_after: a.accept_after });
      if (i.action === 'decline') {
        if (!i.reason) throw badRequest('Say why you are declining');
        await c.query("UPDATE proc_award_lines SET status='declined', decline_reason=$2, responded_by=$3, responded_at=now() WHERE id=$1", [l.id, i.reason, user.id]);
        await auditLog(c, p.id, user.id, 'award_line_declined', { line_id: l.id, reason: i.reason });
        await refreshAward(c, l.award_id);
        await tellUsers(c, await buyerIds(p, ['chair', 'author']), p, 'tender_award_declined', 'A supplier declined', `A supplier declined lot ${l.lot_code} on tender ${p.ref}.`, `dl${l.id}`);
        return { status: 'declined' };
      }
      // re-check what can change between notice and acceptance
      const creds = (await credentialCheck(c, p, l.entity_id, new Date())).filter((q) => q.state !== 'ok');
      if (creds.length) throw conflict('Your credentials no longer meet the tender requirements', { problems: creds.map((q) => q.detail) });
      const lot = (await c.query('SELECT * FROM proc_lots WHERE project_id=$1 AND code=$2', [p.id, l.lot_code])).rows[0];
      const others = (await c.query("SELECT coalesce(sum(qty),0)::float AS q FROM proc_award_lines WHERE project_id=$1 AND lot_code=$2 AND id <> $3 AND status IN ('provisional','accepted')", [p.id, l.lot_code, l.id])).rows[0].q;
      if (others + Number(l.qty) > Number(lot.qty) + 1e-9) throw conflict('This lot is already fully allocated');
      const ent = (await c.query('SELECT * FROM supplier_entities WHERE id=$1', [l.entity_id])).rows[0];
      const sub = (await c.query('SELECT * FROM proc_submissions WHERE id=$1', [l.submission_id])).rows[0];
      const evalCost = (await c.query('SELECT cost FROM proc_submission_costs WHERE submission_id=$1', [sub.id])).rows[0]?.cost;
      const totalAward = (await c.query('SELECT coalesce(sum(amount_minor),0)::bigint AS t FROM proc_award_lines WHERE award_id=$1 AND status <> \'cancelled\'', [l.award_id])).rows[0].t;
      const ceiling = p.contract_type === 'framework' && p.ceiling_minor ? Math.round(Number(p.ceiling_minor) * Number(l.amount_minor) / Math.max(1, Number(totalAward))) : null;
      const renewalCeiling = p.contract_type === 'framework' && p.renewal_ceiling_minor ? Math.round(Number(p.renewal_ceiling_minor) * Number(l.amount_minor) / Math.max(1, Number(totalAward))) : null;
      const scope = { tender: { ref: p.ref, title: p.title, version: a.rfp_version, category: p.category }, lot: { code: lot.code, title: lot.title, qty: Number(l.qty), unit: lot.unit, description: lot.description }, supplier: { id: ent.id, legal_name: ent.legal_name },
        submission: { receipt_no: sub.receipt_no, version: sub.version, content_hash: sub.content_hash, submitted_at: sub.submitted_at }, evaluated: evalCost ? { total_minor: evalCost.total_minor, basis: evalCost.basis } : null, award: { id: a.id, rationale: a.rationale, rubric_version: a.rubric_version, ranking_id: a.snapshot.ranking_id, approval_id: a.approval_id }, dates: { prep_start: p.prep_start, service_start: p.service_start, service_end: p.service_end, teardown_end: p.teardown_end }, contract_type: p.contract_type, terms: { renewal_options: p.renewal_options, renewal_term_months: p.renewal_term_months, notice_days: p.notice_days, milestones: p.milestones ?? [] } };
      const order = (await c.query(`INSERT INTO proc_orders(ref, project_id, award_line_id, organisation_id, buyer_user_id, event_id, entity_id, lot_code, scope, amount_minor, currency, contract_type, prep_start, service_start, service_end, teardown_end, ceiling_minor, renewal_options, renewal_term_months, renewal_ceiling_minor, notice_days)
        VALUES ('PO-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('proc_order_seq')::text, 5, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (award_line_id) DO NOTHING RETURNING *`,
        [p.id, l.id, p.organisation_id, p.owner_user_id, p.event_id, l.entity_id, l.lot_code, JSON.stringify(scope), l.amount_minor, l.currency, p.contract_type, p.prep_start, p.service_start, p.service_end, p.teardown_end, ceiling, p.renewal_options, p.renewal_term_months, renewalCeiling, p.notice_days])).rows[0];
      if (!order) return { status: 'accepted', order: (await c.query('SELECT id, ref, status, amount_minor, currency FROM proc_orders WHERE award_line_id=$1', [l.id])).rows[0], replayed: true };
      let pos = 0;
      for (const m of p.milestones ?? []) await c.query('INSERT INTO proc_order_milestones(order_id, position, name, description, due_on) VALUES ($1,$2,$3,$4,$5)', [order.id, pos++, m.name, m.description ?? null, m.due_on]);
      // one canonical order for delivery, acceptance, invoices and payments (#458) and one budget commitment on it
      const { order: svcOrder, warning } = await ensureServiceOrder(c, order.id, user);
      const { line: budgetLine, note } = await commitTenderOrder(c, svcOrder, p, BUDGET_CATEGORY(p.category), user);
      await c.query('INSERT INTO proc_commitments(order_id, event_id, budget_line_id, amount_minor, currency, note) VALUES ($1,$2,$3,$4,$5,$6)', [order.id, p.event_id, budgetLine?.id ?? null, l.amount_minor, l.currency, note]);
      await auditLog(c, p.id, user.id, 'service_order_created', { order_id: order.id, service_order_id: svcOrder.id, warning: warning ?? null });
      await c.query("UPDATE proc_award_lines SET status='accepted', responded_by=$2, responded_at=now() WHERE id=$1", [l.id, user.id]);
      await auditLog(c, p.id, user.id, 'award_line_accepted', { line_id: l.id, order_id: order.id });
      await refreshAward(c, l.award_id);
      await tellUsers(c, await buyerIds(p, ['chair', 'author']), p, 'tender_award_accepted', 'Award accepted', `A supplier accepted lot ${l.lot_code} on tender ${p.ref}. Order ${order.ref} was created.`, `ac${l.id}`);
      return { status: 'accepted', order: { id: order.id, ref: order.ref, status: order.status, amount_minor: order.amount_minor, currency: order.currency, service_order_id: svcOrder.id, service_order_number: svcOrder.number }, budget_note: note };
    });
  },
});

// ------------------------------------------------------------------ orders & call-offs
cap({
  name: 'list_procurement_orders', method: 'GET', path: '/procurement-orders', tag: TAG, summary: 'Orders from awarded tenders: for buyers the ones on tenders they can see, for suppliers the ones for their entities. The order is the shared handoff record that #458 service scheduling, acceptance and invoicing continue from.',
  input: z.object({ role: z.enum(['buyer', 'supplier']).default('buyer'), project_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if (i.role === 'supplier') {
      const ents = await myEntityIds(user);
      return many('SELECT o.id, o.ref, o.project_id, p.ref AS tender_ref, p.title, o.lot_code, o.amount_minor, o.currency, o.status, o.contract_status, o.contract_type, o.service_start, o.service_end, o.ceiling_minor, o.svc_order_id FROM proc_orders o JOIN proc_projects p ON p.id=o.project_id WHERE o.entity_id = ANY($1) ORDER BY o.created_at DESC LIMIT $2 OFFSET $3', [ents, i.limit, i.offset]);
    }
    return many(`SELECT o.id, o.ref, o.project_id, p.ref AS tender_ref, p.title, e.legal_name AS supplier, o.lot_code, o.amount_minor, o.currency, o.status, o.contract_status, o.contract_type, o.service_start, o.service_end, o.ceiling_minor, o.svc_order_id
      FROM proc_orders o JOIN proc_projects p ON p.id=o.project_id JOIN supplier_entities e ON e.id=o.entity_id
      WHERE ($4::uuid IS NULL OR o.project_id=$4) AND (p.owner_user_id=$1 OR EXISTS (SELECT 1 FROM proc_members m WHERE m.project_id=p.id AND m.user_id=$1 AND m.revoked_at IS NULL) OR (p.venue_id IS NOT NULL AND EXISTS (SELECT 1 FROM venues vv WHERE vv.id=p.venue_id AND (vv.owner_id=$1 OR EXISTS (SELECT 1 FROM venue_staff vs WHERE vs.venue_id=vv.id AND vs.user_id=$1 AND vs.role='manager' AND vs.removed_at IS NULL)))) OR (p.organisation_id IS NOT NULL AND EXISTS (SELECT 1 FROM organisation_members om WHERE om.organisation_id=p.organisation_id AND om.user_id=$1 AND om.status='active' AND om.role IN ('owner','admin'))))
      ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset, i.project_id ?? null]);
  },
});

async function orderFor(user, oid, c = pool) {
  const o = (await c.query('SELECT * FROM proc_orders WHERE id=$1', [oid])).rows[0];
  if (!o) throw notFound('Order');
  const p = await getProject(o.project_id, c);
  const roles = await buyerRoles(user, p, c);
  const supplier = !!(await c.query("SELECT 1 FROM supplier_entity_members WHERE entity_id=$1 AND user_id=$2 AND status='active'", [o.entity_id, user.id])).rowCount;
  if (!roles.length && !supplier) throw notFound('Order');
  return { o, p, roles, supplier };
}

cap({
  name: 'get_procurement_order', method: 'GET', path: '/procurement-orders/:id', tag: TAG, summary: 'One order with its scope snapshot (tender and proposal versions, ranking and approval references), commitment, call-offs and the separate statuses: award line, order, contract. None of them says anything about delivery or payment.', input: z.object({ id }),
  async handler({ user }, i) {
    const { o, roles, supplier } = await orderFor(user, i.id);
    const [commit, calloffs, line] = await Promise.all([one('SELECT amount_minor, currency, budget_line_id, note FROM proc_commitments WHERE order_id=$1', [o.id]), many("SELECT id, amount_minor, description, service_date, status, created_at FROM proc_calloffs WHERE order_id=$1 ORDER BY created_at", [o.id]), one('SELECT status FROM proc_award_lines WHERE id=$1', [o.award_line_id])]);
    const committed = calloffs.filter((x) => x.status === 'approved').reduce((a, x) => a + Number(x.amount_minor), 0);
    const [milestones, renewals] = await Promise.all([many('SELECT id, position, name, description, due_on, status, note, updated_at FROM proc_order_milestones WHERE order_id=$1 ORDER BY position', [o.id]), many('SELECT n, previous_service_end, new_service_end, added_ceiling_minor, created_at FROM proc_order_renewals WHERE order_id=$1 ORDER BY n', [o.id])]);
    const terms = { renewal_options: o.renewal_options, renewals_used: o.renewals_used, renewals_left: Math.max(0, o.renewal_options - o.renewals_used), renewal_term_months: o.renewal_term_months, renewal_ceiling_minor: o.renewal_ceiling_minor ? Number(o.renewal_ceiling_minor) : null, notice_days: o.notice_days,
      notice: o.notice_kind ? { kind: o.notice_kind, served_at: o.notice_served_at, effective_on: o.notice_effective_on } : null, milestones, renewals };
    const so = o.svc_order_id ? await one('SELECT id, number, status, fulfilment, billing, settlement, net_minor, gross_minor, currency FROM svc_orders WHERE id=$1', [o.svc_order_id]) : null;
    return { ...o, service_order: so, viewer: { buyer: can(roles, 'order'), supplier }, terms, award_line_status: line?.status, commitment: commit, call_offs: calloffs, framework: o.ceiling_minor ? { ceiling_minor: Number(o.ceiling_minor), committed_call_offs_minor: committed, remaining_minor: Number(o.ceiling_minor) - committed, note: 'A ceiling is not guaranteed spend. Actual invoices are tracked separately.' } : null };
  },
});

cap({
  name: 'update_procurement_order', method: 'POST', path: '/procurement-orders/:id/update', tag: TAG,
  summary: 'Move an order along or record its contract state. start (buyer or supplier), complete (buyer only: the supplier cannot sign off its own work), cancel (buyer, reason), record_agreement and record_signature (buyer: manual records, a signature record is not a validated e-signature). Order, contract and award statuses stay separate; completing an order does not mean it is paid.',
  input: z.object({ id, action: z.enum(['start', 'complete', 'cancel', 'record_agreement', 'record_signature']), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { o: o0, roles, supplier } = await orderFor(user, i.id, c);
      const o = (await c.query('SELECT * FROM proc_orders WHERE id=$1 FOR UPDATE', [o0.id])).rows[0];
      const buyer = can(roles, 'order');
      if (i.action === 'start') { if (!buyer && !supplier) throw forbidden('Not allowed'); if (o.svc_order_id) throw conflict('Delivery is run on the linked service order (visits, receiving and acceptance); this order follows it', { service_order_id: o.svc_order_id }); if (o.status !== 'confirmed') throw conflict(`The order is ${o.status}`); await c.query("UPDATE proc_orders SET status='in_progress', updated_at=now() WHERE id=$1", [o.id]); }
      else {
        if (!buyer) throw forbidden('Only the buying team can do that');
        if (i.action === 'complete') { if (o.svc_order_id) throw conflict('Delivery is run on the linked service order (visits, receiving and acceptance); this order follows it', { service_order_id: o.svc_order_id }); if (o.status !== 'in_progress') throw conflict('Only an order in progress can be completed'); await c.query("UPDATE proc_orders SET status='completed', updated_at=now() WHERE id=$1", [o.id]); }
        else if (i.action === 'cancel') { if (!i.reason) throw badRequest('Say why'); if (['completed', 'cancelled'].includes(o.status)) throw conflict(`The order is ${o.status}`);
          if (o.svc_order_id) {
            const so = (await c.query('SELECT * FROM svc_orders WHERE id=$1 FOR UPDATE', [o.svc_order_id])).rows[0];
            if (!['pending_supplier', 'changes_proposed', 'confirmed'].includes(so.status) || (await c.query("SELECT 1 FROM svc_order_lines WHERE order_id=$1 AND status='active' AND (qty_accepted > 0 OR qty_invoiced > 0)", [so.id])).rowCount) throw conflict('Work was already accepted or invoiced: end the order with a termination on the service order', { service_order_id: so.id });
            await cancelOrderRecords(c, so, i.reason);
          }
          await c.query("UPDATE proc_orders SET status='cancelled', cancelled_reason=$2, updated_at=now() WHERE id=$1", [o.id, i.reason]); await c.query("UPDATE event_budget_lines SET status='void' WHERE proc_order_id=$1", [o.id]); }
        else if (i.action === 'record_agreement') await c.query("UPDATE proc_orders SET contract_status='agreed', updated_at=now() WHERE id=$1 AND contract_status='pending'", [o.id]);
        else await c.query("UPDATE proc_orders SET contract_status='signed_recorded', updated_at=now() WHERE id=$1 AND contract_status='agreed'", [o.id]);
      }
      await auditLog(c, o.project_id, user.id, `order_${i.action}`, { order_id: o.id, reason: i.reason ?? null });
      return (await c.query('SELECT id, ref, status, contract_status FROM proc_orders WHERE id=$1', [o.id])).rows[0];
    });
  },
});

cap({
  name: 'create_call_off', method: 'POST', path: '/procurement-orders/:id/call-offs', tag: TAG, status: 201,
  summary: 'Place a call-off against a framework order (buying team with order authority). It must fall inside the service period, the order must be active, and the total of call-offs can never exceed the framework ceiling without a new approved award. Idempotent by key. Call-offs are commitments; invoices and payment are tracked separately.',
  input: z.object({ id, amount_minor: z.number().int().min(1), description: z.string().min(3).max(300), service_date: z.string().date().optional(), idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { o: o0, roles } = await orderFor(user, i.id, c);
      if (!can(roles, 'order')) throw forbidden('Only the buying team can place call-offs');
      const o = (await c.query('SELECT * FROM proc_orders WHERE id=$1 FOR UPDATE', [o0.id])).rows[0];
      if (o.contract_type !== 'framework' || !o.ceiling_minor) throw conflict('Call-offs apply to framework orders');
      if (!['confirmed', 'in_progress'].includes(o.status)) throw conflict(`The order is ${o.status}`);
      if (i.idempotency_key) { const prev = (await c.query('SELECT * FROM proc_calloffs WHERE order_id=$1 AND idempotency_key=$2', [o.id, i.idempotency_key])).rows[0]; if (prev) return { ...prev, replayed: true }; }
      if (i.service_date && ((o.service_start && i.service_date < new Date(o.service_start).toISOString().slice(0, 10)) || (o.service_end && i.service_date > new Date(o.service_end).toISOString().slice(0, 10)))) throw badRequest('The call-off is outside the service period');
      if (o.notice_kind === 'terminate' && o.notice_effective_on) {
        const late = (await c.query('SELECT (coalesce($2::date, current_date) > $1::date) AS late', [o.notice_effective_on, i.service_date ?? null])).rows[0].late;
        if (late) throw conflict('A termination notice has been served: call-offs cannot be placed for dates after it takes effect', { effective_on: o.notice_effective_on });
      }
      const used = Number((await c.query("SELECT coalesce(sum(amount_minor),0)::bigint AS s FROM proc_calloffs WHERE order_id=$1 AND status='approved'", [o.id])).rows[0].s);
      if (used + i.amount_minor > Number(o.ceiling_minor)) throw conflict('This call-off would exceed the framework ceiling. A ceiling change needs a new approved award.', { remaining_minor: Number(o.ceiling_minor) - used });
      const row = (await c.query('INSERT INTO proc_calloffs(order_id, amount_minor, description, service_date, requested_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [o.id, i.amount_minor, i.description, i.service_date ?? null, user.id, i.idempotency_key ?? null])).rows[0];
      if (o.svc_order_id) await addCallOffLine(c, o.id, row);
      await auditLog(c, o.project_id, user.id, 'call_off_created', { order_id: o.id, call_off_id: row.id, amount_minor: i.amount_minor });
      await tellUsers(c, await entityUserIds(o.entity_id, c, ['owner', 'bid_manager']), await getProject(o.project_id, c), 'tender_call_off', 'New call-off', `A call-off was placed on order ${o.ref}.`, `co${row.id}`);
      return row;
    });
  },
});

cap({
  name: 'update_order_milestone', method: 'POST', path: '/procurement-milestones/:id/update', tag: TAG,
  summary: 'Record a contract milestone as completed or waived, or put it back to planned (buying team with order authority). This records the contract milestone only: it is not acceptance of delivered work and does not trigger payment. Both stay in the service delivery and finance records.',
  input: z.object({ id, status: z.enum(['planned', 'completed', 'waived']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m0 = (await c.query('SELECT * FROM proc_order_milestones WHERE id=$1', [i.id])).rows[0];
      if (!m0) throw notFound('Milestone');
      const { o: o0, roles } = await orderFor(user, m0.order_id, c);
      if (!can(roles, 'order')) throw forbidden('Only the buying team can record milestones');
      if (['cancelled'].includes(o0.status)) throw conflict('The order is cancelled');
      if (i.status === 'waived' && !i.note) throw badRequest('Say why the milestone is waived');
      const m = (await c.query('UPDATE proc_order_milestones SET status=$2, note=$3, updated_by=$4, updated_at=now() WHERE id=$1 RETURNING id, name, due_on, status, note', [i.id, i.status, i.note ?? null, user.id])).rows[0];
      await auditLog(c, o0.project_id, user.id, 'order_milestone_recorded', { order_id: o0.id, milestone_id: m.id, status: m.status });
      return m;
    });
  },
});

cap({
  name: 'renew_procurement_order', method: 'POST', path: '/procurement-orders/:id/renew', tag: TAG,
  summary: 'Exercise one of the renewal options the tender published (buying team with order authority). It extends the service period by the published renewal term and, for a framework, adds the published renewal ceiling. It must be exercised at least the published notice period before the service period ends, and never after a notice of termination or non-renewal. Idempotent by renewal number. Earlier terms are kept as history.',
  input: z.object({ id, renewal_no: z.number().int().min(1).max(10).describe('the renewal you are exercising: 1 for the first, 2 for the second. Retrying the same number never renews twice') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { o: o0, roles } = await orderFor(user, i.id, c);
      if (!can(roles, 'order')) throw forbidden('Only the buying team can renew an order');
      const o = (await c.query('SELECT * FROM proc_orders WHERE id=$1 FOR UPDATE', [o0.id])).rows[0];
      const prev = (await c.query('SELECT n, previous_service_end, new_service_end, added_ceiling_minor FROM proc_order_renewals WHERE order_id=$1 AND n=$2', [o.id, i.renewal_no])).rows[0];
      if (prev) return { ...prev, replayed: true };
      if (i.renewal_no !== o.renewals_used + 1) throw conflict(`The next renewal is number ${o.renewals_used + 1}`);
      if (!['confirmed', 'in_progress'].includes(o.status)) throw conflict(`The order is ${o.status}`);
      if (o.renewals_used >= o.renewal_options || !o.renewal_term_months) throw conflict('This order has no renewal option left');
      if (o.notice_kind) throw conflict(o.notice_kind === 'terminate' ? 'A termination notice has been served' : 'A notice of non-renewal has been served');
      if (!o.service_end) throw conflict('The order has no service end date to renew from');
      const window = (await c.query('SELECT (current_date <= ($1::date - $2::int)) AS ok, ($1::date - $2::int) AS last_day FROM (SELECT 1) x', [o.service_end, o.notice_days])).rows[0];
      if (!window.ok) throw conflict('The renewal must be exercised before the notice period begins', { last_day: window.last_day, notice_days: o.notice_days });
      const add = o.contract_type === 'framework' && o.renewal_ceiling_minor ? Number(o.renewal_ceiling_minor) : 0;
      const upd = (await c.query(`UPDATE proc_orders SET renewals_used=renewals_used+1, service_end=(service_end + make_interval(months => $2))::date, teardown_end=CASE WHEN teardown_end IS NULL THEN NULL ELSE (teardown_end + make_interval(months => $2))::date END, ceiling_minor=CASE WHEN ceiling_minor IS NULL THEN NULL ELSE ceiling_minor + $3 END, updated_at=now() WHERE id=$1 RETURNING service_end`, [o.id, o.renewal_term_months, add])).rows[0];
      const row = (await c.query('INSERT INTO proc_order_renewals(order_id, n, previous_service_end, new_service_end, added_ceiling_minor, renewed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING n, previous_service_end, new_service_end, added_ceiling_minor', [o.id, i.renewal_no, o.service_end, upd.service_end, add, user.id])).rows[0];
      await auditLog(c, o.project_id, user.id, 'order_renewed', { order_id: o.id, n: i.renewal_no, new_service_end: upd.service_end, added_ceiling_minor: add });
      await tellUsers(c, await entityUserIds(o.entity_id, c, ['owner', 'bid_manager', 'signatory']), await getProject(o.project_id, c), 'tender_order_renewed', 'Order renewed', `Order ${o.ref} was renewed (renewal ${i.renewal_no}).`, `rn${o.id}${i.renewal_no}`);
      return row;
    });
  },
});

cap({
  name: 'serve_order_notice', method: 'POST', path: '/procurement-orders/:id/notice', tag: TAG, status: 201,
  summary: 'Serve a notice of termination or of non-renewal, as the buying team (order authority) or the supplier (owner or signatory), with a reason. It takes effect after the notice period the tender published. One notice per order; it is recorded permanently. While it runs the order carries on; renewals stop, and after a termination notice takes effect no further call-offs can be placed. Cancelling the order itself stays a separate, reasoned action.',
  input: z.object({ id, kind: z.enum(['terminate', 'not_renew']), reason: z.string().min(10).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { o: o0, roles, supplier } = await orderFor(user, i.id, c);
      const buyer = can(roles, 'order');
      const signs = supplier && (await c.query("SELECT 1 FROM supplier_entity_members WHERE entity_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','signatory')", [o0.entity_id, user.id])).rowCount > 0;
      if (!buyer && !signs) throw forbidden('Only the buying team, or the supplier owner or signatory, can serve notice');
      const o = (await c.query('SELECT * FROM proc_orders WHERE id=$1 FOR UPDATE', [o0.id])).rows[0];
      if (o.notice_kind) throw conflict('A notice has already been served on this order');
      if (!['confirmed', 'in_progress'].includes(o.status)) throw conflict(`The order is ${o.status}`);
      const row = (await c.query(`UPDATE proc_orders SET notice_kind=$2, notice_served_at=now(), notice_served_by=$3, notice_effective_on=(current_date + $4::int), updated_at=now() WHERE id=$1 RETURNING id, ref, notice_kind, notice_served_at, notice_effective_on`, [o.id, i.kind, user.id, o.notice_days])).rows[0];
      await auditLog(c, o.project_id, user.id, 'order_notice_served', { order_id: o.id, kind: i.kind, by: buyer ? 'buyer' : 'supplier', reason: i.reason, effective_on: row.notice_effective_on });
      const p = await getProject(o.project_id, c);
      const tell = buyer ? await entityUserIds(o.entity_id, c, ['owner', 'bid_manager', 'signatory']) : await buyerIds(p, ['chair', 'owner']);
      await tellUsers(c, tell, p, 'tender_order_notice', 'Notice served', `Order ${o.ref}: notice of ${i.kind === 'terminate' ? 'termination' : 'non-renewal'} served, effective ${row.notice_effective_on}.`, `nt${o.id}`);
      return row;
    });
  },
});

// ------------------------------------------------------------------ outcome, debrief, appeals
cap({
  name: 'get_my_outcome', method: 'GET', path: '/proposals/:id/outcome', tag: TAG,
  summary: 'Your own outcome and debrief once the buyer has issued an award decision: your eligibility and reasons, your own scores per criterion with the evaluator rationale you are entitled to, your award lines and responses. Rank and bidder count appear only if the published policy discloses them. You never see competing prices, scores or identities.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const pr = await one('SELECT * FROM proc_proposals WHERE id=$1', [i.id]);
    if (!pr) throw notFound('Proposal');
    await requireEntity(user, pr.entity_id);
    const p = await getProject(pr.project_id);
    const award = await one("SELECT * FROM proc_awards WHERE project_id=$1 AND status IN ('notified','partially_accepted','accepted','declined') ORDER BY created_at DESC LIMIT 1", [p.id]);
    if (!award && p.status !== 'closed') throw conflict('No outcome has been issued yet');
    const out = { tender: { ref: p.ref, title: p.title }, eligibility: pr.eligibility, eligibility_reason: pr.eligibility_reason, technical_signoff: pr.tech_signoff };
    if (pr.current_submission_id) {
      const rubric = p.rubric ? rubricSchema.parse(p.rubric) : null;
      const { by, consensus } = await lockedScores(pool, p.id, pr.current_submission_id);
      if (rubric && pr.eligibility === 'eligible') { const t = technicalScore(rubric, by, consensus); out.technical = { score: t.score, by_criterion: t.by_criterion }; out.rationale = await many("SELECT criterion_key, rationale FROM proc_scores WHERE submission_id=$1 AND status='locked' AND rationale IS NOT NULL", [pr.current_submission_id]); }
      const cost = await one('SELECT cost FROM proc_submission_costs WHERE submission_id=$1', [pr.current_submission_id]);
      if (cost) out.your_evaluated_cost = { total_minor: cost.cost.total_minor, currency: cost.cost.currency };
    }
    if (p.disclosure?.rank) { const rk = await one('SELECT rows FROM proc_rankings WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [p.id]); out.rank = rk?.rows.find((r) => r.entity_id === pr.entity_id)?.rank ?? null; }
    if (p.disclosure?.bidder_count) out.bidder_count = (await one("SELECT count(DISTINCT entity_id)::int AS n FROM proc_proposals WHERE project_id=$1 AND status='submitted'", [p.id])).n;
    out.award_lines = await many("SELECT l.id, l.lot_code, l.qty::float AS qty, l.amount_minor, l.currency, l.status FROM proc_award_lines l WHERE l.project_id=$1 AND l.entity_id=$2 ORDER BY l.lot_code", [p.id, pr.entity_id]);
    out.appeal = await one('SELECT id, status, decision FROM proc_appeals WHERE proposal_id=$1', [pr.id]);
    out.appeal_until = award?.notified_at ? new Date(new Date(award.notified_at).getTime() + Math.max(p.standstill_days, 7) * 864e5).toISOString() : null;
    return out;
  },
});

cap({
  name: 'file_tender_appeal', method: 'POST', path: '/proposals/:id/appeal', tag: TAG, status: 201,
  summary: 'Challenge your outcome with reasons, within the tender\'s appeal window (the standstill period, at least 7 days). One appeal per proposal. The buying team decides and records the reason; this is the tender\'s own review process, not a claim of public-procurement legal compliance.',
  input: z.object({ id, reason: z.string().min(20).max(3000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pr = (await c.query('SELECT * FROM proc_proposals WHERE id=$1', [i.id])).rows[0];
      if (!pr) throw notFound('Proposal');
      await requireEntity(user, pr.entity_id, ['owner', 'signatory', 'bid_manager'], c);
      const p = await getProject(pr.project_id, c);
      const award = (await c.query("SELECT * FROM proc_awards WHERE project_id=$1 AND notified_at IS NOT NULL ORDER BY created_at DESC LIMIT 1", [p.id])).rows[0];
      if (!award) throw conflict('No award decision has been issued');
      if (Date.now() > new Date(award.notified_at).getTime() + Math.max(p.standstill_days, 7) * 864e5) throw conflict('The appeal window has closed');
      const a = (await c.query('INSERT INTO proc_appeals(project_id, entity_id, proposal_id, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (proposal_id) DO NOTHING RETURNING id, status', [p.id, pr.entity_id, pr.id, i.reason])).rows[0];
      if (!a) throw conflict('You already filed an appeal');
      await auditLog(c, p.id, user.id, 'appeal_filed', { appeal_id: a.id, entity_id: pr.entity_id });
      await tellUsers(c, await buyerIds(p, ['chair', 'auditor']), p, 'tender_appeal', 'Appeal filed', `An appeal was filed on tender ${p.ref}.`, a.id);
      return a;
    });
  },
});

cap({
  name: 'decide_tender_appeal', method: 'POST', path: '/appeals/:id/decide', tag: TAG, summary: 'Chair or owner: uphold or dismiss an appeal, with the reason that is sent to the supplier. Upholding does not change an award by itself; cancel or rebuild the award with the usual approvals.', input: z.object({ id, outcome: z.enum(['upheld', 'dismissed']), decision: z.string().min(10).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ap = (await c.query('SELECT * FROM proc_appeals WHERE id=$1', [i.id])).rows[0];
      if (!ap) throw notFound('Appeal');
      const { project: p } = await requireBuyer(user, ap.project_id, 'recommend', c);
      const r = (await c.query("UPDATE proc_appeals SET status=$2, decision=$3, decided_by=$4, decided_at=now() WHERE id=$1 AND status='open' RETURNING id, status", [i.id, i.outcome, i.decision, user.id])).rows[0];
      if (!r) throw conflict('This appeal was already decided');
      await auditLog(c, p.id, user.id, 'appeal_decided', { appeal_id: ap.id, outcome: i.outcome });
      await tellUsers(c, await entityUserIds(ap.entity_id, c), p, 'tender_appeal_decided', 'Appeal decided', `Your appeal on tender ${p.ref} was ${i.outcome}.`, ap.id);
      return r;
    });
  },
});

cap({
  name: 'list_tender_appeals', method: 'GET', path: '/rfps/:id/appeals', tag: TAG, summary: 'Appeals filed on a tender (buying team).', input: z.object({ id }),
  async handler({ user }, i) { const { project: p } = await requireBuyer(user, i.id, 'recommend'); return many('SELECT a.id, e.legal_name AS supplier, a.reason, a.status, a.decision, a.created_at FROM proc_appeals a JOIN supplier_entities e ON e.id=a.entity_id WHERE a.project_id=$1 ORDER BY a.created_at', [p.id]); },
});

// ------------------------------------------------------------------ reserve bidders
cap({
  name: 'list_reserve_options', method: 'GET', path: '/rfps/:id/reserve', tag: TAG,
  summary: 'Lots that are open again because a supplier declined or let its offer expire: who already had each lot and why, the tender\'s published reserve rule, and, if the rule allows it, the next eligible bidder in ranking order. Offering a lot to that bidder is never automatic: build a scenario, recommend it and get a fresh approval.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { project: p } = await requireBuyer(user, i.id, 'scenario');
    const rk = await one('SELECT rows FROM proc_rankings WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [p.id]);
    return { reserve_policy: p.reserve_policy, lots: await reservePlan(pool, p, rk) };
  },
});

// ------------------------------------------------------------------ public award publication (separately approved)
const PUBLIC_FIELDS = ['supplier', 'lots', 'award_date', 'service_period', 'value'];

cap({
  name: 'request_award_publication', method: 'POST', path: '/rfps/:id/award-publication', tag: TAG, status: 201,
  summary: 'Ask to publish the award result on the tender notice. Only if the tender\'s published disclosure policy allows public award notices. You choose exactly which fields may appear (supplier names, lots, award date, service period, contract value); anything not chosen never appears, losing bids and scores never do, and the contract value is off unless you choose it. The record is built now from accepted award lines and cannot be edited, and it is published only after a separate approval by someone other than you. It can be withdrawn later with a reason; the record is kept.',
  input: z.object({ id, fields: z.array(z.enum(PUBLIC_FIELDS)).min(1).max(5), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { project: p } = await requireBuyer(user, i.id, 'recommend', c, { lock: true });
      if (!p.disclosure?.award_public) throw conflict('This tender\'s published disclosure policy does not allow a public award notice');
      const lines = (await c.query("SELECT l.lot_code, l.amount_minor, l.currency, l.responded_at, e.legal_name, lt.title AS lot_title FROM proc_award_lines l JOIN supplier_entities e ON e.id=l.entity_id LEFT JOIN proc_lots lt ON lt.project_id=l.project_id AND lt.code=l.lot_code WHERE l.project_id=$1 AND l.status='accepted' ORDER BY l.lot_code", [p.id])).rows;
      if (!lines.length) throw conflict('Nothing has been accepted yet, so there is nothing to publish');
      if ((await c.query("SELECT 1 FROM proc_award_publications WHERE project_id=$1 AND status IN ('approval_pending','published')", [p.id])).rowCount) throw conflict('An award notice is already waiting for approval or published. Withdraw it first to publish a corrected one.');
      const f = new Set(i.fields);
      const record = { tender: { ref: p.ref, title: p.title, issuer: (await issuerOf(p, c))?.name ?? null }, as_of: new Date().toISOString() };
      if (f.has('award_date')) record.award_date = new Date(Math.max(...lines.map((l) => new Date(l.responded_at).getTime()))).toISOString().slice(0, 10);
      if (f.has('service_period')) record.service_period = { start: p.service_start, end: p.service_end };
      if (f.has('lots') || f.has('supplier') || f.has('value')) record.awards = lines.map((l) => ({ ...(f.has('lots') ? { lot: l.lot_code, lot_title: l.lot_title } : {}), ...(f.has('supplier') ? { supplier: l.legal_name } : {}), ...(f.has('value') ? { amount_minor: Number(l.amount_minor), currency: l.currency } : {}) }));
      const row = (await c.query('INSERT INTO proc_award_publications(project_id, fields, record, requested_by) VALUES ($1,$2,$3,$4) RETURNING id, status, fields, record', [p.id, i.fields, JSON.stringify(record), user.id])).rows[0];
      const ap = await requestApproval(c, p, user, 'award_publication', { publication_id: row.id, subject: `pub:${row.id}`, fields: i.fields, includes_value: f.has('value') }, i.note ?? 'Publish the award result on the tender notice');
      await c.query('UPDATE proc_award_publications SET approval_id=$2 WHERE id=$1', [row.id, ap.id]);
      await auditLog(c, p.id, user.id, 'award_publication_requested', { publication_id: row.id, fields: i.fields });
      return { ...row, approval_id: ap.id };
    });
  },
});
onApproved('award_publication', async (c, a, p) => {
  const r = (await c.query("UPDATE proc_award_publications SET status='published', published_at=now() WHERE id=$1 AND status='approval_pending' RETURNING id", [a.payload.publication_id])).rows[0];
  if (!r) return;
  await auditLog(c, p.id, a.requested_by, 'award_published', { publication_id: r.id, approval_id: a.id });
  await tellUsers(c, [a.requested_by], p, 'tender_award_published', 'Award notice published', `The award result for tender ${p.ref} is now on the notice.`, `pub${r.id}`);
});
onRejected('award_publication', async (c, a) => { await c.query("UPDATE proc_award_publications SET status='rejected' WHERE id=$1 AND status='approval_pending'", [a.payload.publication_id]); });

cap({
  name: 'withdraw_award_publication', method: 'POST', path: '/award-publications/:id/withdraw', tag: TAG,
  summary: 'Take a published award result off the notice, with a reason. The record and the approval trail are kept; a corrected one can be requested and approved again.',
  input: z.object({ id, reason: z.string().min(10).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const pub0 = (await c.query('SELECT * FROM proc_award_publications WHERE id=$1', [i.id])).rows[0];
      if (!pub0) throw notFound('Publication');
      const { project: p } = await requireBuyer(user, pub0.project_id, 'recommend', c, { lock: true });
      const r = (await c.query("UPDATE proc_award_publications SET status='withdrawn', withdrawn_at=now(), withdrawn_by=$2, withdraw_reason=$3 WHERE id=$1 AND status='published' RETURNING id, status", [i.id, user.id, i.reason])).rows[0];
      if (!r) throw conflict('Only a published award notice can be withdrawn');
      await auditLog(c, p.id, user.id, 'award_publication_withdrawn', { publication_id: r.id, reason: i.reason });
      return r;
    });
  },
});

cap({
  name: 'list_award_publications', method: 'GET', path: '/rfps/:id/award-publications', tag: TAG,
  summary: 'The tender\'s public award notices with status, the fields allowed, the exact record, and the approval state (buying team).', input: z.object({ id }),
  async handler({ user }, i) {
    const { project: p } = await requireBuyer(user, i.id, 'view');
    return many("SELECT u.id, u.status, u.fields, u.record, u.requested_at, u.published_at, u.withdrawn_at, u.withdraw_reason, a.status AS approval_status, a.required, (SELECT count(*)::int FROM proc_approval_votes v WHERE v.approval_id=a.id AND v.decision='approve') AS approvals FROM proc_award_publications u LEFT JOIN proc_approvals a ON a.id=u.approval_id WHERE u.project_id=$1 ORDER BY u.requested_at DESC", [p.id]);
  },
});
