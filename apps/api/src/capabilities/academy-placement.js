// Academy OS P2 / Gap 21 (#801): Scholarship, University & College Placement Pathways.
// Advisor-managed placement funnel extending the canonical pathway plan (#335, #395).
// No duplicate: opportunity eligibility, evidence checklist, reference requests and
// institution sharing are new; they reuse education-catalogue institutions, sponsorship
// awards attribution and the athlete's existing pathway/academic domains without copying.
// Security: tenant/org/guardian consent enforced server-side; encrypted free text (*_enc);
// audit-logged on every sensitive read; append-only event log; youth safeguarding gates.

import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { isYouth, youthGate } from '../youth.js';
import { encrypt, decrypt } from '../crypto.js';
import { STAFF } from '../academy.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const day  = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date YYYY-MM-DD');
const stale = () => conflict('This record changed since you opened it. Reload and try again.', { code: 'stale_version' });

const KINDS     = ['university_place', 'scholarship', 'grant', 'professional_contract'];
const STATUSES  = ['identified', 'eligibility_check', 'evidence_gathering', 'applied', 'offer_received', 'outcome'];
const EV_KINDS  = ['academic_transcript', 'sport_cv', 'performance_video', 'reference_letter', 'passport', 'ranking_cert', 'medical_clearance', 'other'];
const REF_ROLES = ['coach', 'academic', 'advisor', 'personal', 'other'];
const OUTCOMES  = ['accepted', 'declined', 'deferred', 'withdrawn', 'lapsed'];

const seal = (text, col) => text != null ? encrypt(text, `placement.${col}`) : null;
const open = (enc, col)  => enc != null ? decrypt(enc, `placement.${col}`)   : null;

/** Resolve the athlete for a placement op, checking org membership and advisor scope. */
async function oppFor(oppId, user, { write = false, c = null } = {}) {
  const q = c ?? { query: (t, p) => one(t, p).then((r) => ({ rows: r ? [r] : [] })) };
  const opp = (await q.query('SELECT * FROM placement_opportunities WHERE id=$1', [oppId])).rows[0];
  if (!opp) throw notFound('Placement opportunity');
  await orgFor(user, opp.organisation_id, write ? STAFF : [...STAFF, 'coach', 'staff'], { write, c: c ?? undefined });
  return opp;
}

/** Check the user is a placement advisor for this org (owns placement permission or is owner/admin). */
async function advisorFor(user, orgId, { c = null } = {}) {
  const { role } = await orgFor(user, orgId, [...STAFF, 'coach', 'staff', 'finance'], { c: c ?? undefined });
  if (STAFF.includes(role)) return role;
  const q = c ?? { query: (t, p) => one(t, p).then((r) => ({ rows: r ? [r] : [] })) };
  const perm = (await q.query(
    "SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND 'placement'=ANY(permissions) LIMIT 1",
    [orgId, user.id]
  )).rows[0];
  if (!perm) throw forbidden('Placement advisor permission required');
  return role;
}

/** Check athlete is in scope for this org (enrolled, applied or scouted). */
async function athleteInOrg(athleteId, orgId, c) {
  const q = c ?? { query: (t, p) => one(t, p).then((r) => ({ rows: r ? [r] : [] })) };
  const r = (await q.query(
    `SELECT 1 FROM academy_applications WHERE organisation_id=$1 AND athlete_id=$2
     UNION
     SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 LIMIT 1`,
    [orgId, athleteId]
  )).rows[0];
  if (!r) throw notFound('Athlete not enrolled or applied in this academy');
}

/** Append one event to the log. */
async function logOppEvent(c, { opportunityId, athleteId, kind, fromStatus, toStatus, detail, actorId }) {
  await c.query(
    'INSERT INTO placement_opportunity_events(opportunity_id,athlete_id,kind,from_status,to_status,detail,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [opportunityId, athleteId, kind, fromStatus ?? null, toStatus ?? null, detail ? JSON.stringify(detail) : null, actorId]
  );
}

/** Serialise an opportunity for the response (decrypt sensitive fields only for permitted callers). */
function serializeOpp(opp, { decryptSensitive = false } = {}) {
  const r = { ...opp };
  if (decryptSensitive) {
    r.outcome_note   = open(opp.outcome_note_enc, 'outcome_note');
    r.conditions     = open(opp.conditions_enc, 'conditions');
  }
  delete r.outcome_note_enc;
  delete r.conditions_enc;
  return r;
}

// ── STAFF: list all opportunities for an org ─────────────────────────────────
cap({
  name: 'list_placement_opportunities',
  method: 'GET', path: '/organisations/:id/academy/placement', tag: 'Placement',
  summary: 'List all placement opportunities for this academy (owner/admin/placement-advisor). Returns each opportunity with athlete name, stage and next deadline, sorted by urgency.',
  input: z.object({
    id,
    status: z.enum([...STATUSES, 'all']).default('all'),
    sport: z.string().max(60).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    await advisorFor(user, i.id);
    const rows = await many(
      `SELECT po.*, u.display_name AS athlete_name, u.handle AS athlete_handle
       FROM placement_opportunities po
       JOIN users u ON u.id = po.athlete_id
       WHERE po.organisation_id = $1
         AND ($2::text = 'all' OR po.status = $2)
         AND ($3::text IS NULL OR po.sport = $3)
       ORDER BY
         CASE WHEN po.deadline IS NOT NULL AND po.deadline <= current_date + 7 THEN 0 ELSE 1 END,
         po.deadline NULLS LAST, po.created_at DESC
       LIMIT $4 OFFSET $5`,
      [i.id, i.status, i.sport ?? null, i.limit, i.offset]
    );
    return rows.map((r) => serializeOpp(r));
  },
});

// ── STAFF: action queue ───────────────────────────────────────────────────────
cap({
  name: 'get_placement_action_queue',
  method: 'GET', path: '/organisations/:id/academy/placement/queue', tag: 'Placement',
  summary: 'Returns urgent action items for this academy\'s placement advisor: references due, evidence incomplete, guardian consent pending, deadlines within 7 days.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await advisorFor(user, i.id);

    const refs_due = await many(
      `SELECT prr.id, prr.purpose, prr.due_on, prr.status,
              po.id AS opportunity_id, po.title, po.kind, po.athlete_id,
              u.display_name AS athlete_name,
              r.display_name AS referee_name
       FROM placement_reference_requests prr
       JOIN placement_opportunities po ON po.id = prr.opportunity_id
       JOIN users u ON u.id = po.athlete_id
       JOIN users r ON r.id = prr.referee_id
       WHERE po.organisation_id = $1
         AND prr.status IN ('requested','reminded')
         AND (prr.due_on IS NULL OR prr.due_on <= current_date + 7)
       ORDER BY prr.due_on NULLS LAST`,
      [i.id]
    );

    const evidence_incomplete = await many(
      `SELECT po.id AS opportunity_id, po.title, po.athlete_id,
              u.display_name AS athlete_name,
              count(*) FILTER (WHERE pei.status = 'pending' AND pei.required) AS missing_count,
              array_agg(pei.label ORDER BY pei.position) FILTER (WHERE pei.status = 'pending' AND pei.required) AS missing_items
       FROM placement_opportunities po
       JOIN placement_evidence_items pei ON pei.opportunity_id = po.id
       JOIN users u ON u.id = po.athlete_id
       WHERE po.organisation_id = $1
         AND po.status IN ('evidence_gathering','eligibility_check')
       GROUP BY po.id, po.title, po.athlete_id, u.display_name
       HAVING count(*) FILTER (WHERE pei.status = 'pending' AND pei.required) > 0`,
      [i.id]
    );

    const consent_pending = await many(
      `SELECT pis.id AS share_id, po.id AS opportunity_id, po.title, po.athlete_id,
              u.display_name AS athlete_name, pis.institution_name
       FROM placement_institution_shares pis
       JOIN placement_opportunities po ON po.id = pis.opportunity_id
       JOIN users u ON u.id = po.athlete_id
       WHERE po.organisation_id = $1
         AND pis.guardian_approved_at IS NULL
         AND pis.revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM user_guardians ug WHERE ug.child_id = po.athlete_id AND ug.verified)`,
      [i.id]
    );

    const deadlines_soon = await many(
      `SELECT po.id, po.title, po.kind, po.deadline, po.status,
              u.display_name AS athlete_name
       FROM placement_opportunities po
       JOIN users u ON u.id = po.athlete_id
       WHERE po.organisation_id = $1
         AND po.deadline BETWEEN current_date AND current_date + 14
         AND po.status NOT IN ('outcome')
       ORDER BY po.deadline`,
      [i.id]
    );

    return { refs_due, evidence_incomplete, consent_pending, deadlines_soon };
  },
});

// ── STAFF: analytics ─────────────────────────────────────────────────────────
cap({
  name: 'get_placement_analytics',
  method: 'GET', path: '/organisations/:id/academy/placement/analytics', tag: 'Placement',
  summary: 'Aggregate placement analytics for academy leadership: funnel counts, sport breakdown, opportunity types, scholarship fund attribution, and outcome rates.',
  input: z.object({ id, season: z.string().max(10).optional() }),
  async handler({ user }, i) {
    await advisorFor(user, i.id);

    const [funnel, by_sport, by_kind, scholarships, outcomes] = await Promise.all([
      many(
        `SELECT status, count(*) AS n FROM placement_opportunities
         WHERE organisation_id=$1 GROUP BY status`,
        [i.id]
      ),
      many(
        `SELECT sport, count(*) AS n FROM placement_opportunities
         WHERE organisation_id=$1 AND sport IS NOT NULL GROUP BY sport ORDER BY n DESC`,
        [i.id]
      ),
      many(
        `SELECT kind, count(*) AS n FROM placement_opportunities
         WHERE organisation_id=$1 GROUP BY kind ORDER BY n DESC`,
        [i.id]
      ),
      many(
        `SELECT sa.id, sa.amount_cents, sa.currency, sa.status,
                po.title AS opportunity_title, po.athlete_id,
                u.display_name AS athlete_name,
                sp.name AS sponsor_name
         FROM sponsorship_awards sa
         JOIN placement_opportunities po ON po.id = sa.placement_opportunity_id
         JOIN sponsorship_programs sp ON sp.id = sa.program_id
         JOIN users u ON u.id = po.athlete_id
         WHERE po.organisation_id = $1
         ORDER BY sa.created_at DESC`,
        [i.id]
      ),
      many(
        `SELECT outcome, count(*) AS n FROM placement_opportunities
         WHERE organisation_id=$1 AND outcome IS NOT NULL GROUP BY outcome`,
        [i.id]
      ),
    ]);

    return { funnel, by_sport, by_kind, scholarships, outcomes };
  },
});

// ── STAFF: create opportunity ────────────────────────────────────────────────
cap({
  name: 'create_placement_opportunity',
  method: 'POST', path: '/organisations/:id/academy/placement', tag: 'Placement', status: 201,
  summary: 'Create a placement opportunity for an enrolled athlete (owner/admin/placement-advisor). One athlete may have multiple opportunities.',
  input: z.object({
    id,
    athlete_id: id,
    kind: z.enum(KINDS),
    title: z.string().min(2).max(200),
    sport: z.string().max(60).optional(),
    institution_name: z.string().min(1).max(200).optional(),
    institution_id: id.optional(),
    amount_minor: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    intake_year: z.number().int().min(2024).max(2040).optional(),
    intake_term: z.string().max(60).optional(),
    deadline: day.optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    await advisorFor(user, i.id, { c });
    await athleteInOrg(i.athlete_id, i.id, c);

    const row = (await c.query(
      `INSERT INTO placement_opportunities
         (organisation_id, athlete_id, advisor_id, kind, title, sport,
          institution_id, institution_name, amount_minor, currency,
          intake_year, intake_term, deadline, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [i.id, i.athlete_id, user.id, i.kind, i.title, i.sport ?? null,
       i.institution_id ?? null, i.institution_name ?? null,
       i.amount_minor ?? null, i.currency ?? null,
       i.intake_year ?? null, i.intake_term ?? null, i.deadline ?? null, user.id]
    )).rows[0];

    await logOppEvent(c, { opportunityId: row.id, athleteId: i.athlete_id, kind: 'created', toStatus: 'identified', actorId: user.id });
    await audit(c, user.id, 'create_placement_opportunity', 'placement_opportunities', row.id);
    return serializeOpp(row);
  }),
});

// ── STAFF: get opportunity detail ────────────────────────────────────────────
cap({
  name: 'get_placement_opportunity',
  method: 'GET', path: '/academy/placement/:id', tag: 'Placement',
  summary: 'Full detail for one placement opportunity: stage, evidence checklist, references, sharing status, event history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const opp = await oppFor(i.id, user);
    await audit(null, user.id, 'read_placement_opportunity', 'placement_opportunities', i.id);

    const [evidence, references, shares, events] = await Promise.all([
      many('SELECT * FROM placement_evidence_items WHERE opportunity_id=$1 ORDER BY position', [i.id]),
      many('SELECT prr.*, u.display_name AS referee_name FROM placement_reference_requests prr JOIN users u ON u.id=prr.referee_id WHERE prr.opportunity_id=$1 ORDER BY prr.created_at', [i.id]),
      many('SELECT * FROM placement_institution_shares WHERE opportunity_id=$1 AND revoked_at IS NULL ORDER BY created_at', [i.id]),
      many('SELECT poe.*, u.display_name AS actor_name FROM placement_opportunity_events poe JOIN users u ON u.id=poe.actor_id WHERE poe.opportunity_id=$1 ORDER BY poe.created_at DESC LIMIT 50', [i.id]),
    ]);

    return { opportunity: serializeOpp(opp, { decryptSensitive: true }), evidence, references, shares, events };
  },
});

// ── STAFF: update opportunity stage/fields ───────────────────────────────────
cap({
  name: 'update_placement_opportunity',
  method: 'PATCH', path: '/academy/placement/:id', tag: 'Placement',
  summary: 'Update stage, deadline, offer details or outcome for a placement opportunity. Tracks the stage change in the event log.',
  input: z.object({
    id,
    row_version: z.number().int().min(1),
    status: z.enum(STATUSES).optional(),
    deadline: day.nullable().optional(),
    offer_at: day.nullable().optional(),
    offer_expires_at: z.string().datetime().nullable().optional(),
    outcome: z.enum(OUTCOMES).nullable().optional(),
    outcome_note: z.string().max(2000).nullable().optional(),
    conditions: z.string().max(2000).nullable().optional(),
    amount_minor: z.number().int().min(0).nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
    intake_year: z.number().int().min(2024).max(2040).nullable().optional(),
    intake_term: z.string().max(60).nullable().optional(),
    title: z.string().min(2).max(200).optional(),
    institution_name: z.string().min(1).max(200).optional(),
    advisor_id: id.optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const opp = (await c.query('SELECT * FROM placement_opportunities WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!opp) throw notFound('Placement opportunity');
    await orgFor(user, opp.organisation_id, STAFF, { write: true, c });
    if (opp.row_version !== i.row_version) throw stale();

    const fromStatus = opp.status;
    const toStatus   = i.status ?? fromStatus;

    // Offer: if receiving an offer for a U18 athlete require guardian consent gate
    if (toStatus === 'offer_received' && fromStatus !== 'offer_received') {
      if (await isYouth(opp.athlete_id)) {
        await youthGate(c, user.id, opp.athlete_id, 'recruitment', 'recording an offer');
      }
    }

    const updated = (await c.query(
      `UPDATE placement_opportunities SET
         status            = COALESCE($2, status),
         deadline          = CASE WHEN $3::text IS DISTINCT FROM 'UNCHANGED' THEN $3::date ELSE deadline END,
         offer_at          = CASE WHEN $4::text IS DISTINCT FROM 'UNCHANGED' THEN $4::date ELSE offer_at END,
         offer_expires_at  = CASE WHEN $5::text IS DISTINCT FROM 'UNCHANGED' THEN $5::timestamptz ELSE offer_expires_at END,
         outcome           = CASE WHEN $6::text IS DISTINCT FROM 'UNCHANGED' THEN $6 ELSE outcome END,
         outcome_note_enc  = CASE WHEN $7::text IS DISTINCT FROM 'UNCHANGED' THEN $7 ELSE outcome_note_enc END,
         conditions_enc    = CASE WHEN $8::text IS DISTINCT FROM 'UNCHANGED' THEN $8 ELSE conditions_enc END,
         amount_minor      = CASE WHEN $9::bigint IS DISTINCT FROM -1 THEN $9 ELSE amount_minor END,
         currency          = COALESCE($10, currency),
         intake_year       = CASE WHEN $11::int IS DISTINCT FROM -1 THEN $11 ELSE intake_year END,
         intake_term       = COALESCE($12, intake_term),
         title             = COALESCE($13, title),
         institution_name  = COALESCE($14, institution_name),
         advisor_id        = COALESCE($15, advisor_id),
         row_version       = row_version + 1,
         updated_at        = now()
       WHERE id=$1 RETURNING *`,
      [i.id, i.status ?? null,
       i.deadline !== undefined ? (i.deadline ?? null)   : 'UNCHANGED',
       i.offer_at !== undefined ? (i.offer_at ?? null)   : 'UNCHANGED',
       i.offer_expires_at !== undefined ? (i.offer_expires_at ?? null) : 'UNCHANGED',
       i.outcome !== undefined ? (i.outcome ?? null)     : 'UNCHANGED',
       i.outcome_note !== undefined ? seal(i.outcome_note, 'outcome_note') : 'UNCHANGED',
       i.conditions !== undefined ? seal(i.conditions, 'conditions') : 'UNCHANGED',
       i.amount_minor !== undefined ? (i.amount_minor ?? null) : -1,
       i.currency ?? null,
       i.intake_year !== undefined ? (i.intake_year ?? null) : -1,
       i.intake_term ?? null,
       i.title ?? null,
       i.institution_name ?? null,
       i.advisor_id ?? null,
      ]
    )).rows[0];

    if (fromStatus !== toStatus) {
      await logOppEvent(c, { opportunityId: i.id, athleteId: opp.athlete_id, kind: 'status_change', fromStatus, toStatus, actorId: user.id });
    }
    await audit(c, user.id, 'update_placement_opportunity', 'placement_opportunities', i.id);
    return serializeOpp(updated, { decryptSensitive: true });
  }),
});

// ── STAFF: add evidence checklist item ───────────────────────────────────────
cap({
  name: 'add_placement_evidence_item',
  method: 'POST', path: '/academy/placement/:id/evidence', tag: 'Placement', status: 201,
  summary: 'Add an evidence requirement to this placement opportunity\'s checklist.',
  input: z.object({
    id,
    kind: z.enum(EV_KINDS),
    label: z.string().min(1).max(200),
    note: z.string().max(500).optional(),
    required: z.boolean().default(true),
    position: z.number().int().min(1).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const opp = await oppFor(i.id, user, { write: true, c });
    const pos = i.position ?? (await c.query('SELECT COALESCE(max(position),0)+1 AS p FROM placement_evidence_items WHERE opportunity_id=$1', [opp.id])).rows[0].p;
    const row = (await c.query(
      'INSERT INTO placement_evidence_items(opportunity_id,kind,label,note,required,position,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [opp.id, i.kind, i.label, i.note ?? null, i.required, pos, user.id]
    )).rows[0];
    await audit(c, user.id, 'add_placement_evidence', 'placement_evidence_items', row.id);
    return row;
  }),
});

// ── STAFF/ATHLETE: update evidence item status ───────────────────────────────
cap({
  name: 'update_placement_evidence_item',
  method: 'PATCH', path: '/academy/placement/evidence/:id', tag: 'Placement',
  summary: 'Update the status of an evidence item (uploaded/verified/waived) or attach a document ID.',
  input: z.object({
    id,
    status: z.enum(['pending', 'requested', 'uploaded', 'verified', 'waived']).optional(),
    document_id: id.nullable().optional(),
    note: z.string().max(500).optional(),
    label: z.string().min(1).max(200).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const item = (await c.query('SELECT * FROM placement_evidence_items WHERE id=$1', [i.id])).rows[0];
    if (!item) throw notFound('Evidence item');
    const opp = await oppFor(item.opportunity_id, user, { write: false, c });

    // Athlete may only upload; staff may verify/waive
    if (['verified', 'waived'].includes(i.status)) {
      await orgFor(user, opp.organisation_id, STAFF, { write: true, c });
    }

    const updated = (await c.query(
      `UPDATE placement_evidence_items SET
         status      = COALESCE($2, status),
         document_id = CASE WHEN $3::text IS DISTINCT FROM 'UNCHANGED' THEN $3::uuid ELSE document_id END,
         note        = COALESCE($4, note),
         label       = COALESCE($5, label),
         uploaded_at = CASE WHEN $2 = 'uploaded' AND uploaded_at IS NULL THEN now() ELSE uploaded_at END,
         verified_at = CASE WHEN $2 = 'verified' AND verified_at IS NULL THEN now() ELSE verified_at END,
         verified_by = CASE WHEN $2 = 'verified' AND verified_by IS NULL THEN $6 ELSE verified_by END,
         requested_at = CASE WHEN $2 = 'requested' AND requested_at IS NULL THEN now() ELSE requested_at END,
         updated_at  = now()
       WHERE id=$1 RETURNING *`,
      [i.id, i.status ?? null, i.document_id !== undefined ? (i.document_id ?? null) : 'UNCHANGED',
       i.note ?? null, i.label ?? null, user.id]
    )).rows[0];
    await audit(c, user.id, 'update_placement_evidence', 'placement_evidence_items', i.id);
    return updated;
  }),
});

// ── STAFF: request a reference ───────────────────────────────────────────────
cap({
  name: 'create_placement_reference_request',
  method: 'POST', path: '/academy/placement/:id/references', tag: 'Placement', status: 201,
  summary: 'Request a reference from a named user (coach, academic coordinator etc.) for this placement opportunity.',
  input: z.object({
    id,
    referee_id: id,
    referee_role: z.enum(REF_ROLES),
    purpose: z.string().min(2).max(200),
    instructions: z.string().max(1000).optional(),
    due_on: day.optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const opp = await oppFor(i.id, user, { write: true, c });
    // Referee must exist
    const ref = (await c.query('SELECT id FROM users WHERE id=$1', [i.referee_id])).rows[0];
    if (!ref) throw notFound('Referee user');

    const row = (await c.query(
      `INSERT INTO placement_reference_requests
         (opportunity_id, referee_id, referee_role, purpose, instructions_enc, due_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [opp.id, i.referee_id, i.referee_role, i.purpose,
       i.instructions ? seal(i.instructions, 'ref_instructions') : null,
       i.due_on ?? null, user.id]
    )).rows[0];
    await audit(c, user.id, 'create_reference_request', 'placement_reference_requests', row.id);
    return row;
  }),
});

// ── STAFF/REFEREE: update reference request ──────────────────────────────────
cap({
  name: 'update_placement_reference_request',
  method: 'PATCH', path: '/academy/placement/references/:id', tag: 'Placement',
  summary: 'Mark a reference as submitted, declined or reminded. Referees may submit; advisors may remind or update.',
  input: z.object({
    id,
    row_version: z.number().int().min(1),
    status: z.enum(['reminded', 'submitted', 'declined']).optional(),
    document_id: id.optional(),
    due_on: day.nullable().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const req = (await c.query('SELECT * FROM placement_reference_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!req) throw notFound('Reference request');
    if (req.row_version !== i.row_version) throw stale();

    const opp = (await c.query('SELECT * FROM placement_opportunities WHERE id=$1', [req.opportunity_id])).rows[0];
    // Referee may submit their own; advisor/admin may update anything
    const isReferee = req.referee_id === user.id;
    if (!isReferee) await orgFor(user, opp.organisation_id, STAFF, { write: true, c });
    if (isReferee && i.status && !['submitted', 'declined'].includes(i.status)) {
      throw forbidden('Referees may only submit or decline');
    }

    const updated = (await c.query(
      `UPDATE placement_reference_requests SET
         status       = COALESCE($2, status),
         document_id  = COALESCE($3, document_id),
         due_on       = CASE WHEN $4::text IS DISTINCT FROM 'UNCHANGED' THEN $4::date ELSE due_on END,
         submitted_at = CASE WHEN $2 = 'submitted' AND submitted_at IS NULL THEN now() ELSE submitted_at END,
         row_version  = row_version + 1,
         updated_at   = now()
       WHERE id=$1 RETURNING *`,
      [i.id, i.status ?? null, i.document_id ?? null,
       i.due_on !== undefined ? (i.due_on ?? null) : 'UNCHANGED']
    )).rows[0];
    await audit(c, user.id, 'update_reference_request', 'placement_reference_requests', i.id);
    return updated;
  }),
});

// ── ATHLETE/GUARDIAN: list my opportunities ──────────────────────────────────
cap({
  name: 'list_my_placement_opportunities',
  method: 'GET', path: '/me/placement', tag: 'Placement',
  summary: 'List placement opportunities assigned to the authenticated athlete (or their ward), with stage, evidence completeness and sharing status.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    // If athlete_id specified, must be a guardian
    let athleteId = user.id;
    if (i.athlete_id && i.athlete_id !== user.id) {
      const link = await one('SELECT 1 FROM user_guardians WHERE guardian_id=$1 AND child_id=$2 AND verified', [user.id, i.athlete_id]);
      if (!link) throw forbidden('Not a verified guardian of this athlete');
      athleteId = i.athlete_id;
    }

    const opps = await many(
      `SELECT po.*,
              (SELECT count(*) FROM placement_evidence_items WHERE opportunity_id=po.id AND required) AS evidence_total,
              (SELECT count(*) FROM placement_evidence_items WHERE opportunity_id=po.id AND required AND status IN ('uploaded','verified')) AS evidence_done,
              (SELECT count(*) FROM placement_reference_requests WHERE opportunity_id=po.id) AS refs_total,
              (SELECT count(*) FROM placement_reference_requests WHERE opportunity_id=po.id AND status='submitted') AS refs_done
       FROM placement_opportunities po
       WHERE po.athlete_id = $1
       ORDER BY po.deadline NULLS LAST, po.created_at DESC`,
      [athleteId]
    );
    return opps.map((r) => serializeOpp(r));
  },
});

// ── ATHLETE/GUARDIAN: get one opportunity detail ─────────────────────────────
cap({
  name: 'get_my_placement_opportunity',
  method: 'GET', path: '/me/placement/:id', tag: 'Placement',
  summary: 'Full detail for one of the athlete\'s placement opportunities, including evidence checklist and sharing consent status.',
  input: z.object({ id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    let athleteId = user.id;
    if (i.athlete_id && i.athlete_id !== user.id) {
      const link = await one('SELECT 1 FROM user_guardians WHERE guardian_id=$1 AND child_id=$2 AND verified', [user.id, i.athlete_id]);
      if (!link) throw forbidden('Not a verified guardian of this athlete');
      athleteId = i.athlete_id;
    }

    const opp = await one('SELECT * FROM placement_opportunities WHERE id=$1 AND athlete_id=$2', [i.id, athleteId]);
    if (!opp) throw notFound('Placement opportunity');

    const [evidence, references, shares] = await Promise.all([
      many('SELECT * FROM placement_evidence_items WHERE opportunity_id=$1 ORDER BY position', [i.id]),
      many('SELECT prr.id,prr.purpose,prr.due_on,prr.status,prr.submitted_at,u.display_name AS referee_name,u.handle AS referee_handle FROM placement_reference_requests prr JOIN users u ON u.id=prr.referee_id WHERE prr.opportunity_id=$1', [i.id]),
      many('SELECT * FROM placement_institution_shares WHERE opportunity_id=$1 ORDER BY created_at', [i.id]),
    ]);
    await audit(null, user.id, 'read_placement_opportunity_athlete', 'placement_opportunities', i.id);
    return { opportunity: serializeOpp(opp), evidence, references, shares };
  },
});

// ── ATHLETE/GUARDIAN: grant institution share ────────────────────────────────
cap({
  name: 'grant_institution_share',
  method: 'POST', path: '/me/placement/:id/sharing', tag: 'Placement', status: 201,
  summary: 'Athlete (or guardian on their behalf) grants a named institution access to selected fields of their placement evidence. Youth athletes require guardian approval; a guardian calling this counts as approval.',
  input: z.object({
    id,
    athlete_id: id.optional(),
    institution_name: z.string().min(1).max(200),
    institution_id: id.optional(),
    fields: z.object({
      sport_performance: z.boolean().default(false),
      academic: z.boolean().default(false),
      dev_plan: z.boolean().default(false),
      health_summary: z.boolean().default(false),
      contact: z.boolean().default(false),
    }),
    expires_at: z.string().datetime().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    let athleteId = user.id;
    let guardianApprovedBy = null, guardianApprovedAt = null;

    if (i.athlete_id && i.athlete_id !== user.id) {
      const link = (await c.query('SELECT 1 FROM user_guardians WHERE guardian_id=$1 AND child_id=$2 AND verified', [user.id, i.athlete_id])).rows[0];
      if (!link) throw forbidden('Not a verified guardian of this athlete');
      athleteId = i.athlete_id;
      guardianApprovedBy = user.id;
      guardianApprovedAt = new Date().toISOString();
    } else if (await isYouth(user.id, c)) {
      // Athlete is U18 — the grant is created but requires guardian approval separately
    }

    const opp = (await c.query('SELECT * FROM placement_opportunities WHERE id=$1 AND athlete_id=$2', [i.id, athleteId])).rows[0];
    if (!opp) throw notFound('Placement opportunity');

    await youthGate(c, user.id, athleteId, 'recruitment_sharing', 'sharing placement evidence with an institution');

    const row = (await c.query(
      `INSERT INTO placement_institution_shares
         (opportunity_id, athlete_id, institution_id, institution_name,
          granted_by, guardian_approved_by, guardian_approved_at, fields, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (opportunity_id, institution_name) WHERE revoked_at IS NULL
       DO UPDATE SET fields=$8, expires_at=$9, updated_at=now(), row_version=placement_institution_shares.row_version+1
       RETURNING *`,
      [i.id, athleteId, i.institution_id ?? null, i.institution_name,
       user.id, guardianApprovedBy, guardianApprovedAt,
       JSON.stringify(i.fields), i.expires_at ?? null]
    )).rows[0];

    await logOppEvent(c, { opportunityId: i.id, athleteId, kind: 'share_granted', detail: { institution: i.institution_name, fields: i.fields }, actorId: user.id });
    await audit(c, user.id, 'grant_institution_share', 'placement_institution_shares', row.id);
    return row;
  }),
});

// ── GUARDIAN: approve an institution share for a youth athlete ───────────────
cap({
  name: 'guardian_approve_institution_share',
  method: 'POST', path: '/me/placement/shares/:id/guardian-approve', tag: 'Placement',
  summary: 'Guardian approves an institution share that the athlete created. Required for under-18 athletes before the institution can access the shared data.',
  input: z.object({ id, athlete_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const link = (await c.query('SELECT 1 FROM user_guardians WHERE guardian_id=$1 AND child_id=$2 AND verified', [user.id, i.athlete_id])).rows[0];
    if (!link) throw forbidden('Not a verified guardian of this athlete');

    const share = (await c.query('SELECT * FROM placement_institution_shares WHERE id=$1 AND athlete_id=$2 AND revoked_at IS NULL FOR UPDATE', [i.id, i.athlete_id])).rows[0];
    if (!share) throw notFound('Share not found or already revoked');
    if (share.guardian_approved_at) throw conflict('Already approved');

    const updated = (await c.query(
      'UPDATE placement_institution_shares SET guardian_approved_by=$2, guardian_approved_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *',
      [i.id, user.id]
    )).rows[0];
    await audit(c, user.id, 'guardian_approve_share', 'placement_institution_shares', i.id);
    return updated;
  }),
});

// ── ATHLETE/GUARDIAN: revoke an institution share ────────────────────────────
cap({
  name: 'revoke_institution_share',
  method: 'POST', path: '/me/placement/shares/:id/revoke', tag: 'Placement',
  summary: 'Immediately revoke an institution\'s access to this athlete\'s placement data. Revocation is instant and permanent; a new share must be created to restore access.',
  input: z.object({ id, athlete_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    let athleteId = user.id;
    if (i.athlete_id && i.athlete_id !== user.id) {
      const link = (await c.query('SELECT 1 FROM user_guardians WHERE guardian_id=$1 AND child_id=$2 AND verified', [user.id, i.athlete_id])).rows[0];
      if (!link) throw forbidden('Not a verified guardian of this athlete');
      athleteId = i.athlete_id;
    }
    const share = (await c.query('SELECT * FROM placement_institution_shares WHERE id=$1 AND athlete_id=$2 AND revoked_at IS NULL FOR UPDATE', [i.id, athleteId])).rows[0];
    if (!share) throw notFound('Active share not found');

    await c.query('UPDATE placement_institution_shares SET revoked_at=now(), revoked_by=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [i.id, user.id]);
    await logOppEvent(c, { opportunityId: share.opportunity_id, athleteId, kind: 'share_revoked', detail: { institution: share.institution_name }, actorId: user.id });
    await audit(c, user.id, 'revoke_institution_share', 'placement_institution_shares', i.id);
    return { revoked: true };
  }),
});

// ── STAFF: link a sponsorship award to an opportunity ───────────────────────
cap({
  name: 'link_placement_sponsorship',
  method: 'POST', path: '/academy/placement/:id/sponsorship', tag: 'Placement',
  summary: 'Link an existing sponsorship award to this placement opportunity for attribution tracking. Preserves the canonical sponsorship award without copying it.',
  input: z.object({ id, award_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const opp = await oppFor(i.id, user, { write: true, c });
    const award = (await c.query('SELECT * FROM sponsorship_awards WHERE id=$1', [i.award_id])).rows[0];
    if (!award) throw notFound('Sponsorship award');
    if (award.placement_opportunity_id && award.placement_opportunity_id !== i.id) {
      throw conflict('This award is already linked to a different placement opportunity');
    }
    await c.query('UPDATE sponsorship_awards SET placement_opportunity_id=$2 WHERE id=$1', [i.award_id, opp.id]);
    await audit(c, user.id, 'link_placement_sponsorship', 'sponsorship_awards', i.award_id);
    return { linked: true, award_id: i.award_id, opportunity_id: opp.id };
  }),
});

// ── STAFF: list sharing events for audit ─────────────────────────────────────
cap({
  name: 'list_placement_sharing_log',
  method: 'GET', path: '/organisations/:id/academy/placement/sharing-log', tag: 'Placement',
  summary: 'Full sharing audit log for this academy: grants, revocations, guardian approvals, with actor and timestamp.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await advisorFor(user, i.id);
    await audit(null, user.id, 'read_placement_sharing_log', 'placement_institution_shares', null);

    const rows = await many(
      `SELECT poe.*, po.title AS opportunity_title, po.athlete_id,
              u.display_name AS athlete_name
       FROM placement_opportunity_events poe
       JOIN placement_opportunities po ON po.id = poe.opportunity_id
       JOIN users u ON u.id = po.athlete_id
       WHERE po.organisation_id = $1
         AND poe.kind IN ('share_granted','share_revoked','guardian_approved')
       ORDER BY poe.created_at DESC
       LIMIT $2 OFFSET $3`,
      [i.id, i.limit, i.offset]
    );
    return rows;
  },
});
