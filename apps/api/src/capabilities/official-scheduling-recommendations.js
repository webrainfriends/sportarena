// Official Scheduling Recommendations — Issue #1022 (REF-R24)
// Per-event policy config, structured dimension-card explanations,
// mandatory override audit trail, suggestion history view.
// All five capabilities reuse canonical suggestion logs; no competing source of truth.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, audit } from '../helpers.js';
import { eventForOrganizer } from './events.js';

const OVERRIDE_CATEGORIES = ['local_preference','budget_constraint','rotation_policy','special_skills','other'];

// Default scoring weights (must match scoreOfficial in officials-bulk.js)
const DEFAULT_WEIGHTS = { grade: 30, travel: 24, neutral: 20, rotation: 14, cost: 8, avail: 4 };

// Shared auth: organizer, delegated assignor, or platform admin
async function guardOrganizer(user, eventId, c) {
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev) throw notFound('event');
  if (isAdmin(user)) return ev;
  if (ev.organizer_id === user.id) return ev;
  const grant = ev.organisation_id ? (await c.query(
    "SELECT 1 FROM org_assignor_grants WHERE organisation_id=$1 AND granted_to=$2 AND status='active' AND can_assign=true",
    [ev.organisation_id, user.id],
  )).rows[0] : null;
  if (!grant) throw forbidden('Only the event organiser or a delegated assignor can configure scheduling');
  return ev;
}

function policyWeights(policy) {
  if (!policy) return DEFAULT_WEIGHTS;
  return {
    grade:    policy.w_grade   ?? DEFAULT_WEIGHTS.grade,
    travel:   policy.w_travel  ?? DEFAULT_WEIGHTS.travel,
    neutral:  policy.w_neutral ?? DEFAULT_WEIGHTS.neutral,
    rotation: policy.w_rotation ?? DEFAULT_WEIGHTS.rotation,
    cost:     policy.w_cost    ?? DEFAULT_WEIGHTS.cost,
    avail:    policy.w_avail   ?? DEFAULT_WEIGHTS.avail,
  };
}

/** Build structured dimension cards from a reasons jsonb object. */
function buildDimensionCards(reasons, weights) {
  const w = weights ?? DEFAULT_WEIGHTS;
  const cards = [];

  cards.push({
    dimension: 'grade',
    score: reasons.grade?.score ?? 0,
    max_score: w.grade,
    label: reasons.grade?.label ?? 'No grade data',
    detail: reasons.grade?.score > 0
      ? `Licence grade meets the event minimum. Grade rank: ${reasons.grade?.label ?? 'unknown'}.`
      : 'No active licence found for this sport. The official does not meet the minimum grade requirement.',
    warning: !reasons.grade?.score,
  });

  cards.push({
    dimension: 'travel',
    score: reasons.travel?.score ?? 0,
    max_score: w.travel,
    label: reasons.travel?.label ?? 'Distance unknown',
    detail: reasons.travel?.beyond_range
      ? 'The venue is beyond the maximum travel distance this official has declared.'
      : reasons.travel?.band === 0
        ? 'Within 50 km of the official\'s base — lowest travel burden.'
        : reasons.travel?.band == null
          ? 'No home location on file; distance cannot be computed.'
          : `Travel band: ${reasons.travel.label}. Exact distance is not disclosed.`,
    warning: reasons.travel?.beyond_range === true || reasons.travel?.score === 0,
  });

  cards.push({
    dimension: 'neutral',
    score: reasons.neutral?.score ?? 0,
    max_score: w.neutral,
    label: reasons.neutral?.conflict ? '⚠️ Conflict of interest' : reasons.neutral?.label ?? 'Not checked',
    detail: reasons.neutral?.checked === false
      ? 'Player nationality data is not held by the platform. The organizer must verify neutrality manually before confirming this assignment.'
      : reasons.neutral?.conflict
        ? 'A declared conflict of interest has been recorded for this official and fixture. Assignment is blocked.'
        : 'No declared conflicts found in the platform record.',
    data_gap: reasons.neutral?.checked === false,
    warning: reasons.neutral?.conflict === true,
  });

  cards.push({
    dimension: 'rotation',
    score: reasons.rotation?.score ?? 0,
    max_score: w.rotation,
    label: reasons.rotation?.label ?? 'No assignment data',
    detail: `${reasons.rotation?.count ?? 0} confirmed assignment(s) so far in this event. Lower workload = higher fair-rotation score.`,
  });

  cards.push({
    dimension: 'cost',
    score: reasons.cost?.score ?? 0,
    max_score: w.cost,
    label: reasons.cost?.label ?? 'No rate on file',
    detail: reasons.cost?.score === 4 && reasons.cost?.label?.includes('No rate')
      ? 'No hourly rate on file. A neutral mid-range score has been applied.'
      : reasons.cost?.score >= 8
        ? 'Fee is at or below the event budget — good value.'
        : reasons.cost?.score >= 4
          ? 'Fee is slightly above the event budget (within 20%).'
          : 'Fee significantly exceeds the event budget.',
  });

  cards.push({
    dimension: 'avail',
    score: reasons.availability?.score ?? 0,
    max_score: w.avail,
    label: reasons.availability?.label ?? 'Not scheduled',
    detail: reasons.availability?.state === 'unavailable'
      ? `Unavailable at fixture time: ${reasons.availability.label}`
      : reasons.availability?.state === 'limited'
        ? `Limited availability: ${reasons.availability.label}`
        : reasons.availability?.state === 'inside_hours' || (reasons.availability?.score ?? 0) >= 3
          ? 'Inside declared officiating hours. No blocks detected.'
          : 'Availability partially confirmed. Some conditions apply — check the official\'s calendar.',
    warning: reasons.availability?.state === 'unavailable',
  });

  return cards;
}

// ─── 1. Get event scheduling policy ──────────────────────────────────────────

cap({
  name: 'get_scheduling_policy',
  method: 'GET',
  path: '/events/:id/officials/scheduling-policy',
  tag: 'Officials',
  summary: 'Returns the current scheduling policy for an event, including weight overrides and organizer rules. Falls back to platform defaults where not configured.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { withClient } = await import('../db.js');
    return withClient(async (c) => {
      const ev = await guardOrganizer(user, i.id, c);
      const policy = (await c.query(
        'SELECT * FROM official_scheduling_policies WHERE event_id=$1',
        [ev.id]
      )).rows[0] ?? null;

      const weights = policyWeights(policy);
      return {
        policy_id: policy?.id ?? null,
        event_id: ev.id,
        version: policy?.version ?? 0,
        effective_from: policy?.effective_from ?? null,
        weights,
        defaults: DEFAULT_WEIGHTS,
        is_customised: !!policy,
        require_neutral: policy?.require_neutral ?? false,
        max_per_official_per_day: policy?.max_per_official_per_day ?? null,
        travel_budget_km: policy?.travel_budget_km ?? null,
        min_grade_rank: policy?.min_grade_rank ?? null,
        preferred_user_ids: policy?.preferred_user_ids ?? [],
        blocked_user_ids: policy?.blocked_user_ids ?? [],
        auto_suggest_on_publish: policy?.auto_suggest_on_publish ?? false,
        note: policy?.note ?? null,
      };
    });
  },
});

// ─── 2. Create or update event scheduling policy ─────────────────────────────

cap({
  name: 'upsert_scheduling_policy',
  method: 'POST',
  path: '/events/:id/officials/scheduling-policy',
  tag: 'Officials',
  status: 200,
  summary: 'Create or replace the scheduling policy for an event. All weight fields are optional (null = use default). The sum of non-null weights must not exceed 100. Increments the version on update.',
  input: z.object({
    id,
    w_grade:    z.number().int().min(0).max(100).nullable().optional(),
    w_travel:   z.number().int().min(0).max(100).nullable().optional(),
    w_neutral:  z.number().int().min(0).max(100).nullable().optional(),
    w_rotation: z.number().int().min(0).max(100).nullable().optional(),
    w_cost:     z.number().int().min(0).max(100).nullable().optional(),
    w_avail:    z.number().int().min(0).max(100).nullable().optional(),
    require_neutral:          z.boolean().optional(),
    max_per_official_per_day: z.number().int().min(1).max(20).nullable().optional(),
    travel_budget_km:         z.number().int().min(0).nullable().optional(),
    min_grade_rank:           z.number().int().min(0).max(10).nullable().optional(),
    preferred_user_ids:       z.array(id).max(50).optional(),
    blocked_user_ids:         z.array(id).max(50).optional(),
    auto_suggest_on_publish:  z.boolean().optional(),
    note:                     z.string().max(1000).nullable().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await guardOrganizer(user, i.id, c);

      // Validate sum constraint
      const wGrade    = i.w_grade   ?? DEFAULT_WEIGHTS.grade;
      const wTravel   = i.w_travel  ?? DEFAULT_WEIGHTS.travel;
      const wNeutral  = i.w_neutral ?? DEFAULT_WEIGHTS.neutral;
      const wRotation = i.w_rotation ?? DEFAULT_WEIGHTS.rotation;
      const wCost     = i.w_cost    ?? DEFAULT_WEIGHTS.cost;
      const wAvail    = i.w_avail   ?? DEFAULT_WEIGHTS.avail;
      const total = wGrade + wTravel + wNeutral + wRotation + wCost + wAvail;
      if (total > 100) throw badRequest(`Weight sum ${total} exceeds 100. Reduce weights before saving.`);

      const existing = (await c.query(
        'SELECT id, version FROM official_scheduling_policies WHERE event_id=$1',
        [ev.id]
      )).rows[0];

      let policy;
      if (existing) {
        policy = (await c.query(
          `UPDATE official_scheduling_policies
              SET version=$2, effective_from=now(), created_by=$3,
                  w_grade=$4, w_travel=$5, w_neutral=$6, w_rotation=$7, w_cost=$8, w_avail=$9,
                  require_neutral=$10, max_per_official_per_day=$11, travel_budget_km=$12,
                  min_grade_rank=$13, preferred_user_ids=$14, blocked_user_ids=$15,
                  auto_suggest_on_publish=$16, note=$17
            WHERE event_id=$1
            RETURNING *`,
          [
            ev.id, existing.version + 1, user.id,
            i.w_grade ?? null, i.w_travel ?? null, i.w_neutral ?? null,
            i.w_rotation ?? null, i.w_cost ?? null, i.w_avail ?? null,
            i.require_neutral ?? false,
            i.max_per_official_per_day ?? null,
            i.travel_budget_km ?? null,
            i.min_grade_rank ?? null,
            i.preferred_user_ids ?? [],
            i.blocked_user_ids ?? [],
            i.auto_suggest_on_publish ?? false,
            i.note ?? null,
          ]
        )).rows[0];
      } else {
        policy = (await c.query(
          `INSERT INTO official_scheduling_policies
              (event_id, created_by, w_grade, w_travel, w_neutral, w_rotation, w_cost, w_avail,
               require_neutral, max_per_official_per_day, travel_budget_km, min_grade_rank,
               preferred_user_ids, blocked_user_ids, auto_suggest_on_publish, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING *`,
          [
            ev.id, user.id,
            i.w_grade ?? null, i.w_travel ?? null, i.w_neutral ?? null,
            i.w_rotation ?? null, i.w_cost ?? null, i.w_avail ?? null,
            i.require_neutral ?? false,
            i.max_per_official_per_day ?? null,
            i.travel_budget_km ?? null,
            i.min_grade_rank ?? null,
            i.preferred_user_ids ?? [],
            i.blocked_user_ids ?? [],
            i.auto_suggest_on_publish ?? false,
            i.note ?? null,
          ]
        )).rows[0];
      }

      await audit(c, user.id, 'official_scheduling_policy_saved', {
        event_id: ev.id, policy_id: policy.id, version: policy.version,
      });

      return { ...policy, weights: policyWeights(policy) };
    });
  },
});

// ─── 3. Suggestion history for a fixture-role ────────────────────────────────

cap({
  name: 'get_suggestion_history',
  method: 'GET',
  path: '/fixtures/:id/officials/suggestion-history',
  tag: 'Officials',
  summary: 'Paginated log of every AI suggestion made for a fixture-role, with override info and subsequent invite/shortlist status. Organizers only.',
  input: z.object({
    id,
    role: z.string().optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const f = await one('SELECT * FROM fixtures WHERE id=$1', [i.id]);
    if (!f) throw notFound('fixture');

    const { withClient } = await import('../db.js');
    return withClient(async (c) => {
      await guardOrganizer(user, f.event_id, c);

      const rows = await many(
        `SELECT
            sl.id, sl.user_id, sl.role, sl.score,
            sl.score_grade, sl.score_travel, sl.score_neutral,
            sl.score_rotation, sl.score_cost, sl.score_avail,
            sl.reasons, sl.policy_snapshot, sl.queried_by, sl.created_at,
            u.display_name, u.handle, u.avatar_emoji, u.avatar_color,
            fl.grade_rank, fl.name AS grade_name,
            so.id AS override_id, so.override_category, so.override_reason,
            so.selected_user_id, so.actor_id AS override_actor_id, so.created_at AS overridden_at,
            su.display_name AS selected_user_name,
            fo.id AS fo_id, fo.status AS fo_status,
            sh.id AS shortlist_id
         FROM official_suggestion_log sl
         JOIN users u ON u.id = sl.user_id
         LEFT JOIN LATERAL (
           SELECT t.grade_rank, t.name FROM fed_licences l
           JOIN fed_licence_types t ON t.id=l.type_id
           WHERE l.holder_id=sl.user_id AND l.status='active' AND l.expires_on>=current_date AND t.holder_role='official'
           ORDER BY t.grade_rank DESC LIMIT 1
         ) fl ON true
         LEFT JOIN official_suggestion_overrides so ON so.suggestion_log_id = sl.id
         LEFT JOIN users su ON su.id = so.selected_user_id
         LEFT JOIN fixture_officials fo ON fo.fixture_id=sl.fixture_id AND fo.user_id=sl.user_id AND fo.role=sl.role
           AND fo.status NOT IN ('declined','withdrawn','released','cancelled')
         LEFT JOIN official_shortlists sh ON sh.fixture_id=sl.fixture_id AND sh.user_id=sl.user_id AND sh.role=sl.role
           AND sh.archived_at IS NULL
        WHERE sl.fixture_id=$1
          AND ($2::text IS NULL OR sl.role=$2)
        ORDER BY sl.created_at DESC
        LIMIT $3 OFFSET $4`,
        [i.id, i.role ?? null, i.limit, i.offset]
      );

      return {
        fixture_id: i.id,
        role: i.role ?? null,
        history: rows.map((r) => ({
          ...r,
          dimension_cards: buildDimensionCards(r.reasons, r.policy_snapshot),
          was_invited: !!r.fo_id,
          was_shortlisted: !!r.shortlist_id && !r.fo_id,
          was_overridden: !!r.override_id,
        })),
        total: rows.length,
      };
    });
  },
});

// ─── 4. Record organizer override ────────────────────────────────────────────

cap({
  name: 'override_suggestion',
  method: 'POST',
  path: '/suggestion-logs/:id/override',
  tag: 'Officials',
  status: 201,
  summary: 'Record that an organizer has selected a lower-ranked official, overriding the AI recommendation. Requires a mandatory reason (min 20 chars) and a category. Idempotent: returns the existing override if already recorded.',
  input: z.object({
    id,
    selected_user_id: id.describe('The official the organizer chose (may be lower-ranked than the suggestion)'),
    original_rank: z.number().int().min(1).max(100).describe('1-based rank of the suggestion being overridden'),
    override_category: z.enum(OVERRIDE_CATEGORIES),
    override_reason: z.string().min(20).max(2000),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const sl = (await c.query(
        `SELECT sl.*, f.event_id FROM official_suggestion_log sl
           JOIN fixtures f ON f.id=sl.fixture_id
          WHERE sl.id=$1`,
        [i.id]
      )).rows[0];
      if (!sl) throw notFound('suggestion log entry');

      await guardOrganizer(user, sl.event_id, c);

      // Idempotent: return existing override
      const existing = (await c.query(
        'SELECT * FROM official_suggestion_overrides WHERE suggestion_log_id=$1',
        [i.id]
      )).rows[0];
      if (existing) return { ...existing, already_existed: true };

      const override = (await c.query(
        `INSERT INTO official_suggestion_overrides
            (suggestion_log_id, selected_user_id, original_rank, override_category, override_reason, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [i.id, i.selected_user_id, i.original_rank, i.override_category, i.override_reason, user.id]
      )).rows[0];

      await audit(c, user.id, 'official_suggestion_overridden', {
        suggestion_log_id: i.id,
        fixture_id: sl.fixture_id,
        role: sl.role,
        original_user_id: sl.user_id,
        selected_user_id: i.selected_user_id,
        original_rank: i.original_rank,
        override_category: i.override_category,
      });

      return { ...override, already_existed: false };
    });
  },
});

// ─── 5. Structured dimension detail for one suggestion ───────────────────────

cap({
  name: 'get_dimension_detail',
  method: 'GET',
  path: '/suggestion-logs/:id/dimensions',
  tag: 'Officials',
  summary: 'Returns the full structured per-dimension explanation cards for a single suggestion log entry, including override info if present.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { withClient } = await import('../db.js');
    return withClient(async (c) => {
      const sl = (await c.query(
        `SELECT sl.*, f.event_id, u.display_name, u.handle, u.avatar_emoji, u.avatar_color
           FROM official_suggestion_log sl
           JOIN fixtures f ON f.id=sl.fixture_id
           JOIN users u ON u.id=sl.user_id
          WHERE sl.id=$1`,
        [i.id]
      )).rows[0];
      if (!sl) throw notFound('suggestion log entry');

      await guardOrganizer(user, sl.event_id, c);

      const override = (await c.query(
        `SELECT so.*, u.display_name AS actor_name
           FROM official_suggestion_overrides so
           JOIN users u ON u.id=so.actor_id
          WHERE so.suggestion_log_id=$1`,
        [i.id]
      )).rows[0] ?? null;

      const weights = policyWeights(sl.policy_snapshot);
      const cards = buildDimensionCards(sl.reasons, weights);

      return {
        log_id: sl.id,
        fixture_id: sl.fixture_id,
        role: sl.role,
        user_id: sl.user_id,
        display_name: sl.display_name,
        handle: sl.handle,
        avatar_emoji: sl.avatar_emoji,
        avatar_color: sl.avatar_color,
        score: sl.score,
        dimension_cards: cards,
        weights_in_effect: weights,
        policy_snapshot: sl.policy_snapshot,
        queried_by: sl.queried_by,
        created_at: sl.created_at,
        override: override
          ? {
              id: override.id,
              override_category: override.override_category,
              override_reason: override.override_reason,
              selected_user_id: override.selected_user_id,
              actor_name: override.actor_name,
              created_at: override.created_at,
            }
          : null,
        has_data_gaps: cards.some((c) => c.data_gap),
        has_warnings: cards.some((c) => c.warning),
      };
    });
  },
});
