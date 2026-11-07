import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { requireGuardian, isYouth } from '../youth.js';
import { relationships, requireCoachingConsent } from '../coaching.js';
import { notify } from '../notify.js';

const TAG = 'Para';
const CLASS_NOTE =
  'A competition class is an administrative sporting classification, not a medical diagnosis.';

const FORBIDDEN_TERMS = /\b(diagnosis|impairment|condition)\b/i;

function guardForbiddenTerms(text) {
  if (text && FORBIDDEN_TERMS.test(text)) {
    throw badRequest(
      'Milestone text must not describe a medical diagnosis, impairment or condition. ' +
        'Use the official classification link instead.',
    );
  }
}

const STAGES = [
  'adapted_learning',
  'coach_evaluation',
  'community_competition',
  'official_advancement',
  'verified_competition',
];

async function subjectId(user, input) {
  const aid = input.athlete_id ?? user.id;
  if (aid !== user.id) await requireGuardian(user, aid);
  return aid;
}

async function ownedMilestone(athleteId, milestoneId) {
  const m = await one(
    `SELECT * FROM para_pathway_milestones WHERE id = $1 AND athlete_id = $2`,
    [milestoneId, athleteId],
  );
  if (!m) throw notFound('Milestone');
  return m;
}

async function activeShareForCaller(callerId, athleteId) {
  const share = await one(
    `SELECT pps.*
     FROM para_pathway_shares pps
     WHERE pps.athlete_id = $2
       AND pps.revoked_at IS NULL
       AND (
         pps.shared_with_id = $1
         OR pps.shared_with_id IN (
           SELECT organisation_id FROM organisation_members
           WHERE user_id = $1 AND status = 'active' AND left_at IS NULL
         )
       )
     LIMIT 1`,
    [callerId, athleteId],
  );
  return share;
}

function milestoneShape(m) {
  return {
    id: m.id,
    sport: m.sport,
    stage: m.stage,
    title: decrypt(m.title_enc, 'para_pathway_milestones.title_enc'),
    notes: m.notes_enc
      ? decrypt(m.notes_enc, 'para_pathway_milestones.notes_enc')
      : null,
    linked_goal_id: m.linked_goal_id,
    linked_plan_id: m.linked_plan_id,
    linked_academy_assessment_id: m.linked_academy_assessment_id,
    linked_learning_outcome_id: m.linked_learning_outcome_id,
    display_order: m.display_order,
    evidence_count: Number(m.evidence_count ?? 0),
    feedback_count: Number(m.feedback_count ?? 0),
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

// 1 — GET /me/para-pathway
cap({
  name: 'get_my_para_pathway',
  method: 'GET',
  path: '/me/para-pathway',
  tag: TAG,
  summary: 'Athlete\'s own para-sport development pathway: milestones by stage, shares, para sports, classification status (read-only).',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = await subjectId(user, i);

    const rows = await many(
      `SELECT m.*,
         COUNT(DISTINCT e.id) AS evidence_count,
         COUNT(DISTINCT fr.id) AS feedback_count
       FROM para_pathway_milestones m
       LEFT JOIN para_pathway_evidence e ON e.milestone_id = m.id
       LEFT JOIN para_pathway_feedback_requests fr ON fr.milestone_id = m.id
       WHERE m.athlete_id = $1
       GROUP BY m.id
       ORDER BY m.stage, m.display_order, m.created_at`,
      [athleteId],
    );

    const milestones_by_stage = Object.fromEntries(STAGES.map((s) => [s, []]));
    for (const m of rows) milestones_by_stage[m.stage]?.push(milestoneShape(m));

    const shares = await many(
      `SELECT id, shared_with_id, shared_with_kind, scope, created_at
       FROM para_pathway_shares
       WHERE athlete_id = $1 AND revoked_at IS NULL
       ORDER BY created_at`,
      [athleteId],
    );

    // Competition-facing classification status only — no case/panel/evidence
    const paraOutcomes = await many(
      `SELECT po.sport_id, s.slug AS sport, po.class_code, po.status, po.effective_from, po.review_by, po.expires_on, g.abbreviation AS authority
       FROM para_outcomes po
       JOIN sports s ON s.id = po.sport_id
       LEFT JOIN governing_bodies g ON g.id = po.authority_id
       WHERE po.athlete_id = $1 AND po.status IN ('confirmed','temporary') AND po.superseded_at IS NULL
       ORDER BY s.slug`,
      [athleteId],
    );

    // Para sports from sport profiles
    const paraSports = await many(
      `SELECT DISTINCT s.slug AS sport, s.name AS sport_name
       FROM sport_profiles sp
       JOIN sports s ON s.id = sp.sport_id AND s.is_para = true
       WHERE sp.user_id = $1 AND sp.archived_at IS NULL`,
      [athleteId],
    );

    return {
      milestones_by_stage,
      shares,
      para_sports: paraSports,
      classification: paraOutcomes,
      note: CLASS_NOTE,
    };
  },
});

// 2 — POST /me/para-pathway/milestones
cap({
  name: 'add_para_milestone',
  method: 'POST',
  path: '/me/para-pathway/milestones',
  tag: TAG,
  summary: 'Add an athlete-defined para-sport milestone.',
  input: z.object({
    athlete_id: id.optional(),
    sport: z.string().min(1),
    stage: z.enum(STAGES),
    title: z.string().min(1).max(160),
    notes: z.string().max(2000).optional(),
    linked_goal_id: id.optional(),
    linked_plan_id: id.optional(),
    linked_academy_assessment_id: id.optional(),
  }),
  async handler({ user }, i) {
    const athleteId = await subjectId(user, i);
    guardForbiddenTerms(i.title);
    guardForbiddenTerms(i.notes);

    const sport = await one(
      `SELECT slug FROM sports WHERE (slug = $1 OR id::text = $1) AND is_para = true`,
      [i.sport],
    );
    if (!sport) throw badRequest('Sport must be a para sport (is_para = true).');

    const row = await one(
      `INSERT INTO para_pathway_milestones
         (athlete_id, sport, stage, title_enc, notes_enc,
          linked_goal_id, linked_plan_id, linked_academy_assessment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        athleteId,
        sport.slug,
        i.stage,
        encrypt(i.title, 'para_pathway_milestones.title_enc'),
        i.notes ? encrypt(i.notes, 'para_pathway_milestones.notes_enc') : null,
        i.linked_goal_id ?? null,
        i.linked_plan_id ?? null,
        i.linked_academy_assessment_id ?? null,
      ],
    );

    return { milestone: milestoneShape({ ...row, evidence_count: 0, feedback_count: 0 }) };
  },
});

// 3 — PATCH /me/para-pathway/milestones/:id
cap({
  name: 'update_para_milestone',
  method: 'PATCH',
  path: '/me/para-pathway/milestones/:id',
  tag: TAG,
  summary: 'Update title, notes or stage of an athlete-owned milestone.',
  input: z.object({
    id,
    athlete_id: id.optional(),
    title: z.string().min(1).max(160).optional(),
    notes: z.string().max(2000).optional(),
    stage: z.enum(STAGES).optional(),
  }),
  async handler({ user }, i) {
    const athleteId = await subjectId(user, i);
    guardForbiddenTerms(i.title);
    guardForbiddenTerms(i.notes);
    await ownedMilestone(athleteId, i.id);

    const sets = ['updated_at = now()'];
    const vals = [];
    let n = 1;

    if (i.title !== undefined) {
      sets.push(`title_enc = $${n++}`);
      vals.push(encrypt(i.title, 'para_pathway_milestones.title_enc'));
    }
    if (i.notes !== undefined) {
      sets.push(`notes_enc = $${n++}`);
      vals.push(i.notes ? encrypt(i.notes, 'para_pathway_milestones.notes_enc') : null);
    }
    if (i.stage !== undefined) {
      sets.push(`stage = $${n++}`);
      vals.push(i.stage);
    }

    vals.push(i.id, athleteId);
    const row = await one(
      `UPDATE para_pathway_milestones SET ${sets.join(', ')}
       WHERE id = $${n++} AND athlete_id = $${n++}
       RETURNING *`,
      vals,
    );

    return { milestone: milestoneShape({ ...row, evidence_count: 0, feedback_count: 0 }) };
  },
});

// 4 — GET /me/para-opportunities
cap({
  name: 'list_para_opportunities',
  method: 'GET',
  path: '/me/para-opportunities',
  tag: TAG,
  summary: 'Next para-sport opportunities filtered by sport, stage and location. Eligibility from verified classification only — never diagnosis.',
  input: z.object({
    athlete_id: id.optional(),
    sport: z.string().optional(),
    stage: z.enum(STAGES).optional(),
    location: z.string().optional(),
  }),
  async handler({ user }, i) {
    const athleteId = await subjectId(user, i);

    // Athlete's confirmed/provisional para outcomes keyed by sport slug
    const outcomes = await many(
      `SELECT s.slug AS sport, po.id, po.class_code, po.status FROM para_outcomes po
       JOIN sports s ON s.id = po.sport_id
       WHERE po.athlete_id = $1 AND po.status IN ('confirmed','temporary') AND po.superseded_at IS NULL`,
      [athleteId],
    );
    const outcomeMap = Object.fromEntries(outcomes.map((o) => [o.sport, o]));

    // Open para-cases (pending eligibility)
    const openCases = await many(
      `SELECT s.slug AS sport FROM para_cases pc
       JOIN sports s ON s.id = pc.sport_id
       WHERE pc.athlete_id = $1 AND pc.status NOT IN ('decision_issued','incomplete','closed','withdrawn')`,
      [athleteId],
    );
    const pendingSet = new Set(openCases.map((c) => c.sport));

    // Events (trials and competitions) for para sports
    const sportFilter = i.sport ? `AND s.slug = $2` : '';
    const locationFilter = i.location ? `AND e.city ILIKE '%' || $${i.sport ? 3 : 2} || '%'` : '';
    const params = [true];
    if (i.sport) params.push(i.sport);
    if (i.location) params.push(i.location);

    const events = await many(
      `SELECT e.id, 'event' AS kind, e.name, s.slug AS sport, s.name AS sport_name,
              e.kind AS event_kind, e.starts_on AS date, e.city AS location,
              NULL::text AS stage
       FROM events e
       JOIN sports s ON s.id = e.sport_id AND s.is_para = $1
       WHERE e.kind IN ('trial','tournament','league')
         AND e.starts_on >= current_date
         AND e.archived_at IS NULL
         ${sportFilter}
         ${locationFilter}
       ORDER BY e.starts_on
       LIMIT 50`,
      params,
    );

    // Academy programmes with 'adapted' pathway variant
    const programmes = await many(
      `SELECT ap.id, 'programme' AS kind, ap.title AS name, s.slug AS sport, s.name AS sport_name,
              ap.starts_on AS date, NULL::text AS location, NULL::text AS stage
       FROM academy_programmes ap
       JOIN academy_programme_inclusion pi ON pi.programme_id = ap.id
       JOIN sports s ON (s.slug = ap.sport OR lower(s.name) = lower(ap.sport)) AND s.is_para = true
       WHERE ap.status = 'published'
         AND 'adapted' = ANY(pi.pathway_variants)
         AND (ap.starts_on IS NULL OR ap.starts_on >= current_date)
       ORDER BY ap.starts_on NULLS LAST
       LIMIT 50`,
      [],
    );

    const opportunities = [...events, ...programmes].map((o) => {
      const outcome = outcomeMap[o.sport];
      let eligibility;
      if (outcome) {
        eligibility = 'eligible';
        audit(null, athleteId, 'para_classification_read_for_eligibility', 'para_outcomes', outcome.id ?? athleteId);
      } else if (pendingSet.has(o.sport)) {
        eligibility = 'pending';
      } else {
        eligibility = 'unknown';
      }

      return {
        id: o.id,
        kind: o.kind,
        name: o.name,
        sport: o.sport,
        sport_name: o.sport_name,
        date: o.date,
        location: o.location,
        stage: o.stage,
        eligibility,
        class_code: outcome?.class_code ?? null,
      };
    });

    if (i.stage) {
      return {
        opportunities: opportunities.filter((o) => o.stage === i.stage),
        note: CLASS_NOTE,
      };
    }

    return { opportunities, note: CLASS_NOTE };
  },
});

// 5 — POST /me/para-pathway/milestones/:id/feedback-requests
cap({
  name: 'request_milestone_feedback',
  method: 'POST',
  path: '/me/para-pathway/milestones/:id/feedback-requests',
  tag: TAG,
  summary: 'Athlete requests coach feedback on a milestone.',
  input: z.object({
    id,
    athlete_id: id.optional(),
    coach_id: id,
    message: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const athleteId = await subjectId(user, i);
    await ownedMilestone(athleteId, i.id);

    const rels = await relationships(athleteId, i.coach_id);
    if (!rels.length) throw forbidden('No coaching relationship with this coach.');
    await requireCoachingConsent(athleteId, i.coach_id);

    const row = await one(
      `INSERT INTO para_pathway_feedback_requests
         (milestone_id, athlete_id, coach_id, message_enc)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        i.id,
        athleteId,
        i.coach_id,
        i.message ? encrypt(i.message, 'para_pathway_feedback_requests.message_enc') : null,
      ],
    );

    await notify(i.coach_id, 'para_pathway_feedback_requested', {
      athlete_id: athleteId,
      milestone_id: i.id,
      feedback_request_id: row.id,
    });

    return { feedback_request_id: row.id };
  },
});

// 6 — POST /me/para-pathway/milestones/:id/evidence
cap({
  name: 'submit_milestone_evidence',
  method: 'POST',
  path: '/me/para-pathway/milestones/:id/evidence',
  tag: TAG,
  summary: 'Submit provenance-labelled evidence for a milestone checkpoint.',
  input: z.object({
    id,
    athlete_id: id.optional(),
    provenance_label: z.string().min(1).max(200),
    kind: z.enum([
      'player_goal',
      'coach_observation',
      'competition_result',
      'academy_assessment',
      'learning_outcome',
      'external_ref',
      'other',
    ]),
    source_id: id.optional(),
    notes: z.string().max(2000).optional(),
  }),
  async handler({ user }, i) {
    const athleteId = await subjectId(user, i);
    await ownedMilestone(athleteId, i.id);

    const row = await one(
      `INSERT INTO para_pathway_evidence
         (milestone_id, athlete_id, provenance_label, kind, source_id, notes_enc)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        i.id,
        athleteId,
        i.provenance_label,
        i.kind,
        i.source_id ?? null,
        i.notes ? encrypt(i.notes, 'para_pathway_evidence.notes_enc') : null,
      ],
    );

    // Notify all active share recipients
    const shares = await many(
      `SELECT shared_with_id, shared_with_kind FROM para_pathway_shares
       WHERE athlete_id = $1 AND revoked_at IS NULL`,
      [athleteId],
    );
    for (const s of shares) {
      await notify(s.shared_with_id, 'para_pathway_evidence_submitted', {
        athlete_id: athleteId,
        milestone_id: i.id,
        evidence_id: row.id,
      });
    }

    return { evidence_id: row.id };
  },
});

// 7 — PATCH /para-pathway/evidence/:id/review
cap({
  name: 'review_milestone_evidence',
  method: 'PATCH',
  path: '/para-pathway/evidence/:id/review',
  tag: TAG,
  summary: 'Coach or academy reviews evidence submitted on a milestone (approve / return). Requires active share.',
  input: z.object({
    id,
    decision: z.enum(['approve', 'return', 'query']),
    notes: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    const evidence = await one(
      `SELECT e.*, m.athlete_id FROM para_pathway_evidence e
       JOIN para_pathway_milestones m ON m.id = e.milestone_id
       WHERE e.id = $1`,
      [i.id],
    );
    if (!evidence) throw notFound('Evidence');

    const share = await activeShareForCaller(user.id, evidence.athlete_id);
    if (!share) throw notFound('Para pathway');

    const stateMap = { approve: 'approved', return: 'returned', query: 'under_review' };
    const newState = stateMap[i.decision];

    await one(
      `UPDATE para_pathway_evidence
       SET state = $1, reviewed_by = $2, reviewed_at = now()
       WHERE id = $3`,
      [newState, user.id, i.id],
    );

    await notify(evidence.athlete_id, 'para_pathway_evidence_reviewed', {
      evidence_id: i.id,
      decision: i.decision,
      reviewer_id: user.id,
    });

    return { evidence_id: i.id, state: newState };
  },
});

// 8 — POST /me/para-pathway/shares
cap({
  name: 'share_para_pathway',
  method: 'POST',
  path: '/me/para-pathway/shares',
  tag: TAG,
  summary: 'Share para pathway progression with a coach (person) or academy (organisation). Revocable at any time.',
  input: z.object({
    athlete_id: id.optional(),
    shared_with_id: id,
    shared_with_kind: z.enum(['person', 'organisation']),
    scope: z.array(z.enum(STAGES)).optional(),
  }),
  async handler({ user }, i) {
    const athleteId = await subjectId(user, i);

    if (i.shared_with_kind === 'person') {
      const rels = await relationships(athleteId, i.shared_with_id);
      if (!rels.length) throw forbidden('No coaching relationship with this person.');
      await requireCoachingConsent(athleteId, i.shared_with_id);
    } else {
      // Organisation: athlete must be enrolled or in trial
      const enrolment = await one(
        `SELECT en.id FROM org_enrolments en
         JOIN org_cohorts k ON k.id = en.cohort_id
         WHERE en.user_id = $1 AND k.organisation_id = $2
           AND en.status = 'enrolled' AND en.withdrawn_at IS NULL`,
        [athleteId, i.shared_with_id],
      );
      if (!enrolment) throw forbidden('Athlete is not enrolled at this organisation.');
    }

    // Idempotency: if an active share already exists, return it
    const existing = await one(
      `SELECT id FROM para_pathway_shares
       WHERE athlete_id = $1 AND shared_with_id = $2 AND revoked_at IS NULL`,
      [athleteId, i.shared_with_id],
    );
    if (existing) return { share_id: existing.id, created: false };

    const row = await one(
      `INSERT INTO para_pathway_shares
         (athlete_id, shared_with_id, shared_with_kind, scope)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [athleteId, i.shared_with_id, i.shared_with_kind, i.scope ?? []],
    );

    await notify(i.shared_with_id, 'para_pathway_shared', {
      athlete_id: athleteId,
      share_id: row.id,
    });

    return { share_id: row.id, created: true };
  },
});

// 9 — DELETE /me/para-pathway/shares/:id
cap({
  name: 'revoke_para_pathway_share',
  method: 'DELETE',
  path: '/me/para-pathway/shares/:id',
  tag: TAG,
  summary: 'Revoke a para pathway share. Immediate; the recipient can no longer access any milestone.',
  input: z.object({
    id,
    athlete_id: id.optional(),
  }),
  async handler({ user }, i) {
    const athleteId = await subjectId(user, i);

    const share = await one(
      `SELECT id FROM para_pathway_shares
       WHERE id = $1 AND athlete_id = $2 AND revoked_at IS NULL`,
      [i.id, athleteId],
    );
    if (!share) throw notFound('Share');

    await one(
      `UPDATE para_pathway_shares SET revoked_at = now() WHERE id = $1`,
      [i.id],
    );

    return { revoked: true };
  },
});

// 10 — GET /coaching/para-pathway/:athlete_id
cap({
  name: 'get_coaching_para_pathway',
  method: 'GET',
  path: '/coaching/para-pathway/:athlete_id',
  tag: TAG,
  summary: 'Coach or academy view of an athlete\'s para pathway. Requires an active share. Returns only stages in the share scope.',
  input: z.object({ athlete_id: id }),
  async handler({ user }, i) {
    const share = await activeShareForCaller(user.id, i.athlete_id);
    if (!share) throw notFound('Para pathway');

    // Youth: check guardian consent is active for this coach
    if (await isYouth(i.athlete_id)) await requireCoachingConsent(i.athlete_id, user.id);

    const stageFilter =
      share.scope && share.scope.length > 0
        ? `AND m.stage = ANY($2::text[])`
        : '';
    const params = share.scope && share.scope.length > 0
      ? [i.athlete_id, share.scope]
      : [i.athlete_id];

    const rows = await many(
      `SELECT m.*,
         COUNT(DISTINCT e.id) AS evidence_count,
         COUNT(DISTINCT fr.id) FILTER (WHERE fr.coach_id = $1) AS feedback_count
       FROM para_pathway_milestones m
       LEFT JOIN para_pathway_evidence e ON e.milestone_id = m.id
       LEFT JOIN para_pathway_feedback_requests fr ON fr.milestone_id = m.id
       WHERE m.athlete_id = $1
         ${stageFilter}
       GROUP BY m.id
       ORDER BY m.stage, m.display_order, m.created_at`,
      [i.athlete_id, ...(share.scope && share.scope.length > 0 ? [share.scope] : [])],
    );

    // Competition-facing classification only — no diagnosis, no case details
    const classification = await many(
      `SELECT s.slug AS sport, po.class_code, po.status, po.effective_from, po.review_by, po.expires_on, g.abbreviation AS authority
       FROM para_outcomes po
       JOIN sports s ON s.id = po.sport_id
       LEFT JOIN governing_bodies g ON g.id = po.authority_id
       WHERE po.athlete_id = $1 AND po.status IN ('confirmed','temporary') AND po.superseded_at IS NULL
       ORDER BY s.slug`,
      [i.athlete_id],
    );

    await audit(null, user.id, 'coaching_para_pathway_read', 'para_pathway_milestones', i.athlete_id);

    const milestones_by_stage = Object.fromEntries(STAGES.map((s) => [s, []]));
    for (const m of rows) milestones_by_stage[m.stage]?.push(milestoneShape(m));

    return {
      athlete_id: i.athlete_id,
      scope: share.scope,
      milestones_by_stage,
      classification,
      note: CLASS_NOTE,
    };
  },
});
