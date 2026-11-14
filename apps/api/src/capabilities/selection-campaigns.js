// Issue #1194: Elite Player Intelligence & Team Selection Studio — campaign management
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { encrypt } from '../crypto.js';

const TAG = 'Selection';
const text = (n) => z.string().trim().min(1).max(n);

// Hard-gate requirements per stage advance
const STAGE_GATES = {
  3: async (c, campaignId) => {
    const n = await c.one(`SELECT COUNT(*) AS cnt FROM selection_nominations WHERE campaign_id=$1 AND removed_at IS NULL`, [campaignId]);
    if (parseInt(n.cnt) < 1) throw badRequest('At least one nomination required before advancing to eligibility stage');
  },
  5: async (c, campaignId) => {
    const eligible = await c.one(`SELECT COUNT(*) AS cnt FROM selection_nominations WHERE campaign_id=$1 AND eligibility_status='eligible' AND removed_at IS NULL`, [campaignId]);
    if (parseInt(eligible.cnt) < 1) throw badRequest('At least one eligible candidate required before assessment stage');
  },
  10: async (c, campaignId) => {
    const rec = await c.one(`SELECT id FROM selection_recommendations WHERE campaign_id=$1 AND status='submitted' ORDER BY created_at DESC LIMIT 1`, [campaignId]);
    if (!rec) throw badRequest('A submitted recommendation is required before advancing to approval');
  },
};

async function campaignAccess(user, campaignId, roles = null) {
  const campaign = await one(`SELECT sc.*, o.name AS org_name FROM selection_campaigns sc JOIN organisations o ON o.id=sc.org_id WHERE sc.id=$1 AND sc.archived_at IS NULL`, [campaignId]);
  if (!campaign) throw notFound();
  const member = await one(
    `SELECT om.role FROM organisation_members om WHERE om.organisation_id=$1 AND om.user_id=$2 AND om.left_at IS NULL`,
    [campaign.org_id, user.id]
  );
  if (!member && !isAdmin(user)) throw forbidden();
  if (roles && !isAdmin(user) && !roles.includes(member?.role)) throw forbidden();
  return { campaign, member };
}

async function logAudit(c, campaignId, actorId, eventType, payload = {}) {
  await c.one(
    `INSERT INTO selection_audit_events (campaign_id, actor_id, event_type, payload) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
    [campaignId, actorId, eventType, JSON.stringify(payload)]
  );
}

cap({
  name: 'list_selection_campaigns',
  method: 'GET',
  path: '/organisations/:org_id/selection-campaigns',
  tag: TAG,
  auth: ['admin', 'coach', 'scout'],
  status: 200,
  summary: 'List team selection campaigns for an organisation',
  input: z.object({ org_id: id, sport_id: id.optional(), stage: z.coerce.number().int().min(0).max(11).optional(), ...page.shape }),
  async handler({ user }, i) {
    const member = await one(`SELECT id FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND left_at IS NULL`, [i.org_id, user.id]);
    if (!member && !isAdmin(user)) throw forbidden();
    return many(
      `SELECT sc.*, s.name AS sport_name, t.name AS team_name,
              COUNT(DISTINCT sn.id) AS nomination_count,
              COUNT(DISTINCT CASE WHEN sn.eligibility_status='eligible' THEN sn.id END) AS eligible_count
       FROM selection_campaigns sc
       LEFT JOIN sports s ON s.id=sc.sport_id
       LEFT JOIN teams t ON t.id=sc.team_id
       LEFT JOIN selection_nominations sn ON sn.campaign_id=sc.id AND sn.removed_at IS NULL
       WHERE sc.org_id=$1 AND sc.archived_at IS NULL
         AND ($2::uuid IS NULL OR sc.sport_id=$2)
         AND ($3::int IS NULL OR sc.stage=$3)
       GROUP BY sc.id, s.name, t.name
       ORDER BY sc.created_at DESC
       LIMIT $4 OFFSET $5`,
      [i.org_id, i.sport_id ?? null, i.stage ?? null, i.limit, i.offset]
    );
  },
});

cap({
  name: 'get_selection_campaign',
  method: 'GET',
  path: '/selection-campaigns/:id',
  tag: TAG,
  auth: ['admin', 'coach', 'scout'],
  status: 200,
  summary: 'Get a selection campaign with full pipeline stats',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { campaign } = await campaignAccess(user, i.id);
    const stats = await one(
      `SELECT
         COUNT(DISTINCT sn.id) AS nominations,
         COUNT(DISTINCT CASE WHEN sn.eligibility_status='eligible' THEN sn.id END) AS eligible,
         COUNT(DISTINCT CASE WHEN sn.stage='shortlisted' THEN sn.id END) AS shortlisted,
         COUNT(DISTINCT CASE WHEN sn.stage='recommended' THEN sn.id END) AS recommended,
         COUNT(DISTINCT sa.id) AS assessments
       FROM selection_nominations sn
       LEFT JOIN selection_assessments sa ON sa.nomination_id=sn.id
       WHERE sn.campaign_id=$1 AND sn.removed_at IS NULL`,
      [i.id]
    );
    const policyVersion = campaign.policy_version_id
      ? await one(`SELECT * FROM selection_policy_versions WHERE id=$1`, [campaign.policy_version_id])
      : null;
    return { ...campaign, stats, policy_version: policyVersion };
  },
});

cap({
  name: 'create_selection_campaign',
  method: 'POST',
  path: '/organisations/:org_id/selection-campaigns',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 201,
  summary: 'Create a new team selection campaign',
  input: z.object({
    org_id: id,
    name: text(200),
    sport_id: id.optional(),
    team_id: id.optional(),
    purpose: z.enum(['academy_admissions','season_roster','matchday_xi','tournament_squad','relay_team','trial_selection','development_squad','emergency_cover','cup_squad']),
    formation: z.string().trim().max(20).optional(),
    min_squad_size: z.number().int().min(1).max(100).optional(),
    max_squad_size: z.number().int().min(1).max(100).optional(),
    max_reserve_size: z.number().int().min(0).max(50).optional(),
    age_bracket_min: z.number().int().min(5).max(99).optional(),
    age_bracket_max: z.number().int().min(5).max(99).optional(),
    eligibility_constraints: z.record(z.string(), z.unknown()).optional(),
    approval_config: z.record(z.string(), z.unknown()).optional(),
    sod_exception: z.boolean().optional(),
    committee_quorum: z.number().int().min(1).optional(),
    voting_rule: z.enum(['majority','unanimous','supermajority']).optional(),
    nomination_deadline: z.string().date().optional(),
    assessment_deadline: z.string().date().optional(),
    decision_deadline: z.string().date().optional(),
    publication_deadline: z.string().date().optional(),
    description: z.string().trim().max(2000).optional(),
  }),
  async handler({ user }, i) {
    const member = await one(`SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND left_at IS NULL`, [i.org_id, user.id]);
    if (!member && !isAdmin(user)) throw forbidden();
    return tx(async (c) => {
      const descEnc = i.description ? await encrypt(i.description, 'selection_campaign_desc') : null;
      const campaign = await c.one(
        `INSERT INTO selection_campaigns
           (org_id, name, sport_id, team_id, purpose, formation, min_squad_size, max_squad_size, max_reserve_size,
            age_bracket_min, age_bracket_max, eligibility_constraints, approval_config, sod_exception,
            committee_quorum, voting_rule, nomination_deadline, assessment_deadline, decision_deadline,
            publication_deadline, description_enc, proposer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING *`,
        [
          i.org_id, i.name, i.sport_id ?? null, i.team_id ?? null, i.purpose, i.formation ?? null,
          i.min_squad_size ?? null, i.max_squad_size ?? null, i.max_reserve_size ?? null,
          i.age_bracket_min ?? null, i.age_bracket_max ?? null,
          JSON.stringify(i.eligibility_constraints ?? {}),
          JSON.stringify(i.approval_config ?? {}),
          i.sod_exception ?? false, i.committee_quorum ?? null,
          i.voting_rule ?? 'majority', i.nomination_deadline ?? null,
          i.assessment_deadline ?? null, i.decision_deadline ?? null,
          i.publication_deadline ?? null, descEnc, user.id,
        ]
      );
      await logAudit(c, campaign.id, user.id, 'campaign_created', { name: i.name, purpose: i.purpose });
      return campaign;
    });
  },
});

cap({
  name: 'update_selection_campaign',
  method: 'PATCH',
  path: '/selection-campaigns/:id',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Update campaign settings (blocked once locked)',
  input: z.object({
    id,
    name: text(200).optional(),
    formation: z.string().trim().max(20).optional(),
    min_squad_size: z.number().int().min(1).max(100).optional(),
    max_squad_size: z.number().int().min(1).max(100).optional(),
    max_reserve_size: z.number().int().min(0).max(50).optional(),
    nomination_deadline: z.string().date().optional(),
    assessment_deadline: z.string().date().optional(),
    decision_deadline: z.string().date().optional(),
    approval_config: z.record(z.string(), z.unknown()).optional(),
    committee_quorum: z.number().int().min(1).optional(),
  }),
  async handler({ user }, i) {
    const { campaign } = await campaignAccess(user, i.id, ['admin', 'coach']);
    if (campaign.locked_at) throw conflict('Campaign is locked — criteria cannot be changed after locking');
    return tx(async (c) => {
      const updated = await c.one(
        `UPDATE selection_campaigns SET
           name=COALESCE($2,name), formation=COALESCE($3,formation),
           min_squad_size=COALESCE($4,min_squad_size), max_squad_size=COALESCE($5,max_squad_size),
           max_reserve_size=COALESCE($6,max_reserve_size), nomination_deadline=COALESCE($7,nomination_deadline),
           assessment_deadline=COALESCE($8,assessment_deadline), decision_deadline=COALESCE($9,decision_deadline),
           approval_config=COALESCE($10::jsonb,approval_config), committee_quorum=COALESCE($11,committee_quorum),
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [i.id, i.name ?? null, i.formation ?? null, i.min_squad_size ?? null, i.max_squad_size ?? null,
         i.max_reserve_size ?? null, i.nomination_deadline ?? null, i.assessment_deadline ?? null,
         i.decision_deadline ?? null, i.approval_config ? JSON.stringify(i.approval_config) : null,
         i.committee_quorum ?? null]
      );
      await logAudit(c, i.id, user.id, 'campaign_updated', {});
      return updated;
    });
  },
});

cap({
  name: 'advance_selection_stage',
  method: 'POST',
  path: '/selection-campaigns/:id/advance-stage',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Advance campaign to next stage — enforces hard gates',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { campaign } = await campaignAccess(user, i.id, ['admin', 'coach']);
    if (campaign.stage >= 11) throw conflict('Campaign is already at final stage');
    return tx(async (c) => {
      const nextStage = campaign.stage + 1;
      if (STAGE_GATES[nextStage]) await STAGE_GATES[nextStage](c, i.id);
      const updated = await c.one(
        `UPDATE selection_campaigns SET stage=$2, updated_at=now() WHERE id=$1 RETURNING stage`,
        [i.id, nextStage]
      );
      await logAudit(c, i.id, user.id, 'stage_advanced', { from: campaign.stage, to: nextStage });
      return updated;
    });
  },
});

cap({
  name: 'lock_selection_criteria',
  method: 'POST',
  path: '/selection-campaigns/:id/lock-criteria',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Lock criteria/policy snapshot before assessments begin',
  input: z.object({
    id,
    rubric_snapshot: z.record(z.string(), z.unknown()),
    weight_snapshot: z.record(z.string(), z.unknown()),
    eligibility_rules: z.record(z.string(), z.unknown()).optional(),
    min_evidence_threshold: z.number().int().min(1).default(1),
    confidence_penalty_pct: z.number().min(0).max(100).default(20),
  }),
  async handler({ user }, i) {
    const { campaign } = await campaignAccess(user, i.id, ['admin', 'coach']);
    if (campaign.locked_at) throw conflict('Criteria already locked');
    return tx(async (c) => {
      const pv = await c.one(
        `INSERT INTO selection_policy_versions (campaign_id, rubric_snapshot, weight_snapshot, eligibility_rules, min_evidence_threshold, confidence_penalty_pct, locked_at, created_by)
         VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,now(),$7) RETURNING *`,
        [i.id, JSON.stringify(i.rubric_snapshot), JSON.stringify(i.weight_snapshot),
         JSON.stringify(i.eligibility_rules ?? {}), i.min_evidence_threshold, i.confidence_penalty_pct, user.id]
      );
      await c.one(
        `UPDATE selection_campaigns SET policy_version_id=$2, locked_at=now(), updated_at=now() WHERE id=$1 RETURNING id`,
        [i.id, pv.id]
      );
      await logAudit(c, i.id, user.id, 'criteria_locked', { policy_version_id: pv.id });
      return pv;
    });
  },
});

cap({
  name: 'nominate_candidate',
  method: 'POST',
  path: '/selection-campaigns/:id/nominations',
  tag: TAG,
  auth: ['admin', 'coach', 'scout'],
  status: 201,
  summary: 'Nominate a candidate for a selection campaign',
  input: z.object({
    id,
    candidate_id: id,
    source: z.enum(['manual','roster','watchlist','scouting','application','external']),
    position: z.string().trim().max(60).optional(),
    jersey_preference: z.number().int().min(1).max(99).optional(),
    watchlist_member_id: id.optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const { campaign } = await campaignAccess(user, i.id);
    if (campaign.stage > 3) throw conflict('Nomination period has closed');
    return tx(async (c) => {
      const existing = await c.one(`SELECT id FROM selection_nominations WHERE campaign_id=$1 AND candidate_id=$2`, [i.id, i.candidate_id]);
      if (existing) throw conflict('Candidate already nominated');
      const notesEnc = i.notes ? await encrypt(i.notes, 'selection_nomination_notes') : null;
      const nom = await c.one(
        `INSERT INTO selection_nominations (campaign_id, candidate_id, nominated_by, source, position, jersey_preference, watchlist_member_id, notes_enc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [i.id, i.candidate_id, user.id, i.source, i.position ?? null, i.jersey_preference ?? null, i.watchlist_member_id ?? null, notesEnc]
      );
      await logAudit(c, i.id, user.id, 'candidate_nominated', { candidate_id: i.candidate_id, source: i.source });
      return nom;
    });
  },
});

cap({
  name: 'bulk_import_nominations',
  method: 'POST',
  path: '/selection-campaigns/:id/nominations/bulk-import',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 201,
  summary: 'Bulk import nominations from a roster, watchlist, or scouting campaign',
  input: z.object({
    id,
    source: z.enum(['roster','watchlist','scouting']),
    source_ref_id: id,
    position_filter: z.string().trim().max(60).optional(),
  }),
  async handler({ user }, i) {
    const { campaign } = await campaignAccess(user, i.id);
    if (campaign.stage > 3) throw conflict('Nomination period has closed');
    return tx(async (c) => {
      let candidates = [];
      if (i.source === 'roster') {
        candidates = await c.many(`SELECT user_id AS candidate_id FROM team_squads WHERE team_id=$1 AND left_at IS NULL`, [i.source_ref_id]);
      } else if (i.source === 'watchlist') {
        candidates = await c.many(`SELECT user_id AS candidate_id FROM scouting_watchlist_members WHERE watchlist_id=$1 AND user_id IS NOT NULL AND removed_at IS NULL`, [i.source_ref_id]);
      } else if (i.source === 'scouting') {
        candidates = await c.many(`SELECT DISTINCT user_id AS candidate_id FROM academy_campaign_entries WHERE campaign_id=$1 AND user_id IS NOT NULL`, [i.source_ref_id]);
      }
      const imported = [];
      for (const { candidate_id } of candidates) {
        try {
          const nom = await c.one(
            `INSERT INTO selection_nominations (campaign_id, candidate_id, nominated_by, source) VALUES ($1,$2,$3,$4) ON CONFLICT (campaign_id, candidate_id) DO NOTHING RETURNING *`,
            [i.id, candidate_id, user.id, i.source]
          );
          if (nom) imported.push(nom);
        } catch (_) { /* skip duplicates */ }
      }
      await logAudit(c, i.id, user.id, 'bulk_nominations_imported', { source: i.source, count: imported.length });
      return { imported: imported.length, skipped: candidates.length - imported.length };
    });
  },
});

cap({
  name: 'check_nomination_eligibility',
  method: 'POST',
  path: '/selection-campaigns/:campaign_id/nominations/:nomination_id/eligibility-check',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Run eligibility checks for a nomination against campaign constraints',
  input: z.object({
    campaign_id: id,
    nomination_id: id,
    checks: z.array(z.object({
      check_type: z.enum(['age','registration','clearance','guardian_consent','federation_clearance','transfer_window','visa','medical_clearance','academic','para_classification','safeguarding']),
      result: z.enum(['pass','fail','warning','expired','pending']),
      reason: z.string().trim().max(500).optional(),
      expires_at: z.string().datetime().optional(),
    })).min(1),
  }),
  async handler({ user }, i) {
    await campaignAccess(user, i.campaign_id);
    const nom = await one(`SELECT * FROM selection_nominations WHERE id=$1 AND campaign_id=$2 AND removed_at IS NULL`, [i.nomination_id, i.campaign_id]);
    if (!nom) throw notFound();
    return tx(async (c) => {
      const inserted = [];
      for (const chk of i.checks) {
        const row = await c.one(
          `INSERT INTO selection_eligibility_checks (nomination_id, campaign_id, check_type, result, reason, checker_id, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [i.nomination_id, i.campaign_id, chk.check_type, chk.result, chk.reason ?? null, user.id, chk.expires_at ?? null]
        );
        inserted.push(row);
      }
      const anyFail = i.checks.some(c => c.result === 'fail');
      const newStatus = anyFail ? 'ineligible' : 'eligible';
      await c.one(`UPDATE selection_nominations SET eligibility_status=$2, updated_at=now() WHERE id=$1 RETURNING eligibility_status`, [i.nomination_id, newStatus]);
      await logAudit(c, i.campaign_id, user.id, 'eligibility_checked', { nomination_id: i.nomination_id, result: newStatus });
      return { eligibility_status: newStatus, checks: inserted };
    });
  },
});

cap({
  name: 'move_nomination_stage',
  method: 'POST',
  path: '/selection-campaigns/:campaign_id/nominations/:nomination_id/move',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Move a nomination to a different stage (shortlist, compare, etc.)',
  input: z.object({
    campaign_id: id,
    nomination_id: id,
    stage: z.enum(['nominated','eligibility_check','shortlisted','assessing','comparison','recommended','approved','declined','withdrawn','reserve','development']),
    reason: z.string().trim().max(500).optional(),
  }),
  async handler({ user }, i) {
    await campaignAccess(user, i.campaign_id);
    const nom = await one(`SELECT * FROM selection_nominations WHERE id=$1 AND campaign_id=$2 AND removed_at IS NULL`, [i.nomination_id, i.campaign_id]);
    if (!nom) throw notFound();
    if (['shortlisted','recommended'].includes(i.stage) && nom.eligibility_status === 'ineligible') {
      throw badRequest('Ineligible candidates cannot be shortlisted or recommended');
    }
    return tx(async (c) => {
      const updated = await c.one(
        `UPDATE selection_nominations SET stage=$2, declined_reason=$3, updated_at=now() WHERE id=$1 RETURNING *`,
        [i.nomination_id, i.stage, i.reason ?? null]
      );
      await logAudit(c, i.campaign_id, user.id, 'nomination_stage_moved', { nomination_id: i.nomination_id, to_stage: i.stage });
      return updated;
    });
  },
});

cap({
  name: 'get_selection_audit',
  method: 'GET',
  path: '/selection-campaigns/:id/audit',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Get immutable audit trail for a selection campaign',
  input: z.object({ id, ...page.shape }),
  async handler({ user }, i) {
    await campaignAccess(user, i.id);
    return many(
      `SELECT sae.*, u.display_name AS actor_name
       FROM selection_audit_events sae
       JOIN users u ON u.id=sae.actor_id
       WHERE sae.campaign_id=$1
       ORDER BY sae.occurred_at DESC
       LIMIT $2 OFFSET $3`,
      [i.id, i.limit, i.offset]
    );
  },
});
