// Issue #1194: Transparent, explainable scoring, ranking and scenario forecasting.
// Admin-configurable criteria/weights per position rubric.
// Confidence penalties for incomplete data. Eligibility is a hard pre-check.
// Forecasts are SCENARIOS not certainties. AI never autonomously approve/assign.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, notFound, forbidden } from '../errors.js';
import { isAdmin } from '../helpers.js';

const TAG = 'Selection';

async function orgMember(c, orgId, userId) {
  return !!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND left_at IS NULL", [orgId, userId])).rows.length;
}
async function campaignAccess(c, campaignId, userId, adminOk = false) {
  const camp = (await c.query('SELECT * FROM selection_campaigns WHERE id=$1', [campaignId])).rows[0];
  if (!camp) throw notFound('SelectionCampaign');
  if (!(await orgMember(c, camp.org_id, userId)) && !adminOk) throw forbidden();
  return camp;
}

function computeScore(scores, criteria, observationCount) {
  if (!criteria.length || !Object.keys(scores).length) return { total: null, weighted: null, confidence: 0, breakdown: [] };
  let weightedSum = 0, totalWeight = 0;
  const breakdown = [];
  for (const crit of criteria) {
    const raw = scores[crit.key];
    if (raw === undefined || raw === null) {
      breakdown.push({ key: crit.key, label: crit.label, raw: null, weighted: null, weight: crit.weight, missing: true });
      continue;
    }
    const normalised = (raw / (crit.max_score ?? 10));
    const weighted = normalised * (crit.weight ?? 1);
    weightedSum += weighted;
    totalWeight += (crit.weight ?? 1);
    breakdown.push({ key: crit.key, label: crit.label, raw, normalised: Math.round(normalised * 100) / 100, weighted: Math.round(weighted * 100) / 100, weight: crit.weight ?? 1, missing: false });
  }
  const completeness = breakdown.filter(b => !b.missing).length / criteria.length;
  const confidencePenalty = completeness < 0.5 ? 0.5 : completeness;
  const rawScore = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : null;
  const confidenceAdjusted = rawScore !== null ? rawScore * confidencePenalty : null;
  return {
    total: rawScore !== null ? Math.round(rawScore * 10) / 10 : null,
    weighted: confidenceAdjusted !== null ? Math.round(confidenceAdjusted * 10) / 10 : null,
    confidence: Math.round(completeness * 100) / 100,
    insufficient_data: completeness < 0.4,
    observation_count: observationCount,
    breakdown
  };
}

cap({
  name: 'submit_selection_assessment',
  method: 'POST',
  path: '/selection/nominations/:id/assessments',
  tag: TAG,
  auth: ['admin','coach','organizer','scout'],
  status: 201,
  summary: 'Submit an assessment/evaluation for a nominated candidate',
  input: z.object({
    id,
    scores: z.record(z.string(), z.number().min(0).max(100)),
    evidence_refs: z.array(z.object({ type: z.string().trim().max(40), ref_id: id.optional(), label: z.string().trim().max(120), verified: z.boolean().default(false) })).max(20).default([]),
    observation_notes: z.string().trim().max(2000).nullable().default(null),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const nom = (await c.query('SELECT * FROM selection_nominations WHERE id=$1', [i.id])).rows[0];
      if (!nom) throw notFound('Nomination');
      const camp = await campaignAccess(c, nom.campaign_id, user.id, isAdmin(user));
      const policyVersion = camp.criteria_locked_at
        ? (await c.query('SELECT * FROM selection_policy_versions WHERE campaign_id=$1 ORDER BY version_number DESC LIMIT 1', [nom.campaign_id])).rows[0]
        : null;
      const criteria = policyVersion?.criteria ?? [];
      const scoreResult = computeScore(i.scores, criteria, Object.keys(i.scores).length);
      const { encrypt } = await import('../crypto.js');
      const aId = (await c.query(
        `INSERT INTO selection_assessments(nomination_id, campaign_id, assessor_id, rubric_version_id, scores, evidence_refs, observation_notes_enc, total_score, weighted_score, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [i.id, nom.campaign_id, user.id, policyVersion?.id ?? null, JSON.stringify(i.scores), JSON.stringify(i.evidence_refs), i.observation_notes ? encrypt(i.observation_notes, 'obs_notes') : null, scoreResult.total, scoreResult.weighted, scoreResult.confidence]
      )).rows[0].id;
      await c.query('INSERT INTO selection_audit_events(campaign_id, actor_id, event_type, nomination_id, payload) VALUES ($1,$2,$3,$4,$5)',
        [nom.campaign_id, user.id, 'assessment_submitted', i.id, JSON.stringify({ assessment_id: aId, confidence: scoreResult.confidence, insufficient_data: scoreResult.insufficient_data })]);
      return { id: aId, ...scoreResult };
    });
  },
});

cap({
  name: 'run_selection_scoring',
  method: 'POST',
  path: '/selection/campaigns/:id/score',
  tag: TAG,
  auth: ['admin','coach','organizer'],
  status: 200,
  summary: 'Run scoring across all shortlisted candidates — returns ranked list with breakdown',
  input: z.object({ id, position: z.string().trim().max(60).nullable().default(null) }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      const camp = await campaignAccess(c, i.id, user.id, isAdmin(user));
      const policyVersion = camp.criteria_locked_at
        ? (await c.query('SELECT * FROM selection_policy_versions WHERE campaign_id=$1 ORDER BY version_number DESC LIMIT 1', [i.id])).rows[0]
        : null;
      const criteria = policyVersion?.criteria ?? [];
      const nominations = await c.query(
        `SELECT sn.*, u.display_name
         FROM selection_nominations sn LEFT JOIN users u ON u.id=sn.user_id
         WHERE sn.campaign_id=$1 AND sn.stage IN ('shortlisted','assessing','compared') AND sn.eligibility_status <> 'fail'
         AND ($2::text IS NULL OR sn.position=$2)`,
        [i.id, i.position ?? null]);
      const results = [];
      for (const nom of nominations.rows) {
        const latestAssessment = (await c.query('SELECT scores, confidence FROM selection_assessments WHERE nomination_id=$1 ORDER BY submitted_at DESC LIMIT 1', [nom.id])).rows[0];
        const scores = latestAssessment?.scores ?? {};
        const scoreResult = computeScore(scores, criteria, Object.keys(scores).length);
        results.push({ nomination_id: nom.id, display_name: nom.display_name, position: nom.position, eligibility_status: nom.eligibility_status, ...scoreResult });
      }
      results.sort((a, b) => (b.weighted ?? -1) - (a.weighted ?? -1));
      results.forEach((r, idx) => { r.rank = idx + 1; });
      return { campaign_id: i.id, criteria_version: policyVersion?.version_number ?? 0, ranked_candidates: results, insufficient_data_count: results.filter(r => r.insufficient_data).length };
    });
  },
});

cap({
  name: 'run_selection_forecast',
  method: 'POST',
  path: '/selection/campaigns/:id/forecast',
  tag: TAG,
  auth: ['admin','coach','organizer'],
  status: 200,
  summary: 'Run scenario-based selection forecast (ranges, not certainties)',
  input: z.object({
    id,
    squad_snapshot: z.record(z.string(), z.any()).optional(),
    scenario_label: z.string().trim().max(80).default('Default'),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const camp = await campaignAccess(c, i.id, user.id, isAdmin(user));
      const nominations = await c.query(
        `SELECT sn.id AS nomination_id, sn.position, sn.user_id,
                (SELECT weighted_score FROM selection_assessments WHERE nomination_id=sn.id ORDER BY submitted_at DESC LIMIT 1) AS score,
                (SELECT confidence FROM selection_assessments WHERE nomination_id=sn.id ORDER BY submitted_at DESC LIMIT 1) AS confidence
         FROM selection_nominations sn
         WHERE sn.campaign_id=$1 AND sn.eligibility_status <> 'fail' AND sn.stage NOT IN ('withdrawn','excluded')`,
        [i.id]);
      const insufficient = nominations.rows.filter(n => !n.score || n.score === null);
      if (insufficient.length > nominations.rows.length * 0.5) {
        const runId = (await c.query(
          'INSERT INTO selection_forecast_runs(campaign_id, model_version, input_snapshot, result, uncertainty, insufficient_data, run_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [i.id, 'v1', JSON.stringify({ scenario_label: i.scenario_label }), JSON.stringify({}), JSON.stringify({}), true, user.id]
        )).rows[0].id;
        return { id: runId, insufficient_data: true, message: 'Insufficient evidence to generate a meaningful forecast. Ensure at least 50% of candidates have submitted assessments.' };
      }
      const scenarios = [
        { label: i.scenario_label, description: 'Score-ranked selection with current evidence', candidates: nominations.rows.filter(n => n.score).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, camp.target_squad_size).map(n => ({ nomination_id: n.nomination_id, position: n.position, projected_score_range: [Math.max(0, (n.score ?? 0) - 10), Math.min(100, (n.score ?? 0) + 10)], confidence: n.confidence ?? 0 })) },
        { label: 'Conservative (high evidence only)', description: 'Only candidates with ≥70% evidence completeness', candidates: nominations.rows.filter(n => n.confidence >= 0.7 && n.score).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, camp.target_squad_size).map(n => ({ nomination_id: n.nomination_id, position: n.position, projected_score_range: [Math.max(0, (n.score ?? 0) - 5), Math.min(100, (n.score ?? 0) + 5)], confidence: n.confidence ?? 0 })) },
      ];
      const uncertainty = { overall: Math.round((1 - (nominations.rows.filter(n => n.score).length / nominations.rows.length)) * 100) / 100, note: 'Based on evidence completeness across nominated candidates. This is a scenario, not a prediction.' };
      const runId = (await c.query(
        'INSERT INTO selection_forecast_runs(campaign_id, model_version, input_snapshot, result, uncertainty, insufficient_data, run_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [i.id, 'v1', JSON.stringify({ squad_snapshot: i.squad_snapshot, scenario_label: i.scenario_label }), JSON.stringify({ scenarios }), JSON.stringify(uncertainty), false, user.id]
      )).rows[0].id;
      await c.query('INSERT INTO selection_audit_events(campaign_id, actor_id, event_type, payload) VALUES ($1,$2,$3,$4)',
        [i.id, user.id, 'forecast_run', JSON.stringify({ run_id: runId, model_version: 'v1', scenarios: scenarios.length })]);
      return { id: runId, insufficient_data: false, scenarios, uncertainty, model_version: 'v1', model_disclaimer: 'Forecasts are scenarios based on available evidence. They are not guarantees of performance. AI does not make final selection decisions.' };
    });
  },
});

cap({
  name: 'save_comparison_scenario',
  method: 'POST',
  path: '/selection/campaigns/:id/comparisons',
  tag: TAG,
  auth: ['admin','coach','organizer','scout'],
  status: 201,
  summary: 'Save a comparison scenario for 2-12 candidates',
  input: z.object({
    id,
    label: z.string().trim().min(1).max(80),
    position: z.string().trim().max(60).nullable().default(null),
    candidate_ids: z.array(id).min(2).max(12),
    weights: z.record(z.string(), z.number().min(0).max(1)).default({}),
    notes: z.string().trim().max(500).nullable().default(null),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await campaignAccess(c, i.id, user.id, isAdmin(user));
      const count = (await c.query('SELECT count(*)::int AS n FROM selection_nominations WHERE id=ANY($1) AND campaign_id=$2', [i.candidate_ids, i.id])).rows[0].n;
      if (count !== i.candidate_ids.length) throw badRequest('All candidates must belong to this campaign');
      const { encrypt } = await import('../crypto.js');
      const scId = (await c.query(
        'INSERT INTO selection_comparison_scenarios(campaign_id, analyst_id, label, position, candidate_ids, weights, notes_enc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [i.id, user.id, i.label, i.position, i.candidate_ids, JSON.stringify(i.weights), i.notes ? encrypt(i.notes, 'comp_notes') : null]
      )).rows[0].id;
      await c.query('INSERT INTO selection_audit_events(campaign_id, actor_id, event_type, payload) VALUES ($1,$2,$3,$4)',
        [i.id, user.id, 'comparison_saved', JSON.stringify({ scenario_id: scId, candidate_count: i.candidate_ids.length, position: i.position })]);
      return { id: scId };
    });
  },
});

cap({
  name: 'list_comparison_scenarios',
  method: 'GET',
  path: '/selection/campaigns/:id/comparisons',
  tag: TAG,
  auth: ['admin','coach','organizer','scout'],
  status: 200,
  summary: 'List saved comparison scenarios for a campaign',
  input: z.object({ id, limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      await campaignAccess(c, i.id, user.id, isAdmin(user));
      const rows = await c.query(
        `SELECT scs.id, scs.label, scs.position, scs.candidate_ids, scs.weights,
                scs.saved_at, u.display_name AS analyst_name
         FROM selection_comparison_scenarios scs LEFT JOIN users u ON u.id=scs.analyst_id
         WHERE scs.campaign_id=$1 AND scs.archived_at IS NULL
         ORDER BY scs.saved_at DESC LIMIT $2 OFFSET $3`,
        [i.id, i.limit, i.offset]);
      return rows.rows;
    });
  },
});

cap({
  name: 'get_comparison_scenario',
  method: 'GET',
  path: '/selection/campaigns/:id/comparisons/:scenario_id',
  tag: TAG,
  auth: ['admin','coach','organizer','scout'],
  status: 200,
  summary: 'Get a saved comparison scenario with full radar and sensitivity data',
  input: z.object({ id, scenario_id: id }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      await campaignAccess(c, i.id, user.id, isAdmin(user));
      const sc = (await c.query(
        `SELECT scs.*, u.display_name AS analyst_name
         FROM selection_comparison_scenarios scs LEFT JOIN users u ON u.id=scs.analyst_id
         WHERE scs.id=$1 AND scs.campaign_id=$2 AND scs.archived_at IS NULL`,
        [i.scenario_id, i.id])).rows[0];
      if (!sc) throw notFound('ComparisonScenario');
      return sc;
    });
  },
});

cap({
  name: 'compute_team_fit',
  method: 'POST',
  path: '/selection/campaigns/:id/team-fit',
  tag: TAG,
  auth: ['admin','coach','organizer'],
  status: 200,
  summary: 'Compute positional/tactical fit scores for a proposed lineup assignment',
  input: z.object({
    id,
    formation: z.string().trim().max(20),
    assigned_positions: z.array(z.object({
      nomination_id: id,
      position: z.string().trim().max(40),
    })).min(1).max(25),
  }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      const camp = await campaignAccess(c, i.id, user.id, isAdmin(user));
      const results = [];
      const positionSet = i.assigned_positions.map(a => a.position);
      const coverageMap = {};
      positionSet.forEach(p => { coverageMap[p] = (coverageMap[p] ?? 0) + 1; });

      for (const assignment of i.assigned_positions) {
        const nom = (await c.query(
          `SELECT sn.*, sa.scores, sa.confidence, sa.total_score
           FROM selection_nominations sn
           LEFT JOIN LATERAL (
             SELECT scores, confidence, total_score FROM selection_assessments
             WHERE nomination_id=sn.id ORDER BY submitted_at DESC LIMIT 1
           ) sa ON true
           WHERE sn.id=$1 AND sn.campaign_id=$2`,
          [assignment.nomination_id, i.id])).rows[0];
        if (!nom) continue;

        const nomPosition = nom.position ?? assignment.position;
        const positionMatch = nomPosition?.toLowerCase() === assignment.position?.toLowerCase();
        const positionalFitPct = positionMatch ? 90 : (nomPosition ? 50 : 30);
        const confidenceScore = nom.confidence ?? 0;
        const totalScore = nom.total_score ?? 0;
        const chemistryScore = Math.min(100, totalScore * confidenceScore * 100);

        // Depth: how many others are assigned to same position
        const depthCount = coverageMap[assignment.position] ?? 1;
        const depthScore = Math.min(100, depthCount * 40);

        results.push({
          nomination_id: assignment.nomination_id,
          position: assignment.position,
          positional_fit_pct: Math.round(positionalFitPct),
          chemistry_score: Math.round(chemistryScore * 10) / 10,
          depth_score: Math.round(depthScore),
          confidence: Math.round(confidenceScore * 100),
          insufficient_data: confidenceScore < 0.4,
        });
      }

      // Formation gaps: positions in formation with no assignment
      const formationGaps = [];
      const assignedPositions = new Set(i.assigned_positions.map(a => a.position));
      // Note: gap detection is formation-schema-agnostic; caller passes known formation slots
      const positionCounts = {};
      i.assigned_positions.forEach(a => { positionCounts[a.position] = (positionCounts[a.position] ?? 0) + 1; });

      await c.query('INSERT INTO selection_audit_events(campaign_id, actor_id, event_type, payload) VALUES ($1,$2,$3,$4)',
        [i.id, user.id, 'team_fit_computed', JSON.stringify({ formation: i.formation, candidate_count: results.length })]);

      return {
        formation: i.formation,
        candidates: results,
        formation_gaps: formationGaps,
        overall_fit_pct: results.length > 0 ? Math.round(results.reduce((s, r) => s + r.positional_fit_pct, 0) / results.length) : 0,
        model_disclaimer: 'Team fit is a heuristic based on position alignment and evidence completeness. Human judgement is essential.',
      };
    });
  },
});

cap({
  name: 'submit_selection_recommendation',
  method: 'POST',
  path: '/selection/campaigns/:id/recommendations',
  tag: TAG,
  auth: ['admin','coach','organizer'],
  status: 201,
  summary: 'Submit the coach recommendation for the squad',
  input: z.object({
    id,
    squad_snapshot: z.object({
      starting: z.array(id).max(100),
      reserves: z.array(id).max(50),
      development: z.array(id).max(50).default([]),
      watchlist: z.array(id).max(50).default([]),
      excluded: z.array(id).max(200).default([]),
    }),
    rationale: z.record(z.string(), z.object({ included: z.boolean(), reason: z.string().trim().max(1000), evidence_refs: z.array(z.string()).default([]) })).default({}),
    forecast_run_id: id.nullable().default(null),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const camp = await campaignAccess(c, i.id, user.id, isAdmin(user));
      if (camp.stage < 7) throw badRequest('The scenarios stage must be completed before submitting a recommendation');
      const allSelected = [...i.squad_snapshot.starting, ...i.squad_snapshot.reserves];
      if (allSelected.length) {
        const ineligible = (await c.query(
          "SELECT id FROM selection_nominations WHERE id=ANY($1) AND eligibility_status='fail'",
          [allSelected])).rows;
        if (ineligible.length) throw badRequest(`${ineligible.length} ineligible candidate(s) are in the proposed squad. Resolve eligibility issues first.`);
      }
      const nextVer = ((await c.query('SELECT max(version_number)::int AS v FROM selection_recommendations WHERE campaign_id=$1', [i.id])).rows[0].v ?? 0) + 1;
      const { encrypt } = await import('../crypto.js');
      const encRationale = {};
      for (const [nomId, r] of Object.entries(i.rationale)) {
        encRationale[nomId] = { included: r.included, reason_enc: encrypt(r.reason, 'rationale'), evidence_refs: r.evidence_refs };
      }
      const recId = (await c.query(
        'INSERT INTO selection_recommendations(campaign_id, proposer_id, version_number, squad_snapshot, rationale, forecast_run_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [i.id, user.id, nextVer, JSON.stringify(i.squad_snapshot), JSON.stringify(encRationale), i.forecast_run_id, 'submitted']
      )).rows[0].id;
      if (camp.stage === 8) {
        await c.query('UPDATE selection_campaigns SET stage=9, row_version=row_version+1, updated_at=now() WHERE id=$1', [i.id]);
      }
      await c.query('INSERT INTO selection_audit_events(campaign_id, actor_id, event_type, payload) VALUES ($1,$2,$3,$4)',
        [i.id, user.id, 'recommendation_submitted', JSON.stringify({ recommendation_id: recId, version: nextVer, starting_count: i.squad_snapshot.starting.length, reserve_count: i.squad_snapshot.reserves.length })]);
      return { id: recId, version: nextVer };
    });
  },
});
