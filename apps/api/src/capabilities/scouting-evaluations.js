// Scouting evaluation templates, completed evaluations and side-by-side athlete comparisons
// (issue #565). Template rubrics may be shared across campaigns and watchlists.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';

const TAG = 'Scouting';
const text = (n) => z.string().trim().min(1).max(n);

const criterionSchema = z.object({
  key: z.string().trim().regex(/^[a-z_]{1,40}$/),
  label: text(80),
  description: z.string().trim().max(300).optional(),
  max_score: z.number().int().min(1).max(100).default(10),
  weight: z.number().min(0).max(1).default(1),
  category: z.string().trim().max(60).optional(),
});

async function orgMember(user, orgId) {
  const m = await one(
    `SELECT id FROM organisation_members WHERE organisation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [orgId, user.id]
  );
  if (!m && !isAdmin(user)) throw forbidden();
}

async function tplAccess(user, tplId) {
  const tpl = await one(`SELECT * FROM scouting_evaluation_tpls WHERE id = $1 AND archived_at IS NULL`, [tplId]);
  if (!tpl) throw notFound();
  await orgMember(user, tpl.org_id);
  return tpl;
}

cap({
  name: 'list_eval_templates',
  method: 'GET',
  path: '/organisations/:org_id/scouting/eval-templates',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'List evaluation templates for an organisation',
  input: z.object({ org_id: id, sport_id: id.optional() }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return many(
      `SELECT et.*,
              s.name AS sport_name,
              COUNT(DISTINCT e.id) AS evaluation_count
       FROM scouting_evaluation_tpls et
       LEFT JOIN sports s ON s.id = et.sport_id
       LEFT JOIN scouting_evaluations e ON e.template_id = et.id
       WHERE et.org_id = $1
         AND et.archived_at IS NULL
         AND ($2::uuid IS NULL OR et.sport_id = $2)
       GROUP BY et.id, s.name
       ORDER BY et.name`,
      [i.org_id, i.sport_id ?? null]
    );
  },
});

cap({
  name: 'create_eval_template',
  method: 'POST',
  path: '/organisations/:org_id/scouting/eval-templates',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 201,
  summary: 'Create a scouting evaluation template with rubric criteria',
  input: z.object({
    org_id: id,
    name: text(120),
    sport_id: id.nullable().default(null),
    criteria: z.array(criterionSchema).min(1).max(50),
    max_score: z.number().int().min(1).max(100).default(10),
    passing_score: z.number().int().min(0).max(100).optional(),
    description: z.string().trim().max(500).optional(),
  }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return one(
      `INSERT INTO scouting_evaluation_tpls (org_id, name, sport_id, criteria, max_score, passing_score, description, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING *`,
      [i.org_id, i.name, i.sport_id, JSON.stringify(i.criteria), i.max_score, i.passing_score ?? null, i.description ?? null, user.id]
    );
  },
});

cap({
  name: 'get_eval_template',
  method: 'GET',
  path: '/scouting/eval-templates/:id',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'Get a single evaluation template',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tplAccess(user, i.id);
  },
});

cap({
  name: 'update_eval_template',
  method: 'PATCH',
  path: '/scouting/eval-templates/:id',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Update a template — blocked if evaluations already submitted against it',
  input: z.object({
    id,
    name: text(120).optional(),
    criteria: z.array(criterionSchema).min(1).max(50).optional(),
    description: z.string().trim().max(500).optional(),
    passing_score: z.number().int().min(0).max(100).optional(),
  }),
  async handler({ user }, i) {
    const tpl = await tplAccess(user, i.id);
    if (i.criteria) {
      const count = await one(`SELECT COUNT(*) AS n FROM scouting_evaluations WHERE template_id = $1`, [i.id]);
      if (parseInt(count.n) > 0) throw conflict('Cannot change criteria after evaluations have been submitted; create a new template instead');
    }
    return one(
      `UPDATE scouting_evaluation_tpls
       SET name = COALESCE($2, name),
           criteria = COALESCE($3::jsonb, criteria),
           description = COALESCE($4, description),
           passing_score = COALESCE($5, passing_score),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.name ?? null, i.criteria ? JSON.stringify(i.criteria) : null, i.description ?? null, i.passing_score ?? null]
    );
  },
});

cap({
  name: 'archive_eval_template',
  method: 'POST',
  path: '/scouting/eval-templates/:id/archive',
  tag: TAG,
  auth: ['admin'],
  status: 200,
  summary: 'Soft-archive an evaluation template',
  input: z.object({ id }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden();
    const tpl = await one(`SELECT id FROM scouting_evaluation_tpls WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!tpl) throw notFound();
    await one(`UPDATE scouting_evaluation_tpls SET archived_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { archived: true };
  },
});

cap({
  name: 'submit_evaluation',
  method: 'POST',
  path: '/scouting/eval-templates/:id/evaluations',
  tag: TAG,
  auth: ['scout', 'coach'],
  status: 201,
  summary: 'Submit a completed evaluation for a prospect or watchlist member',
  input: z.object({
    id,
    campaign_entry_id: id.optional(),
    watchlist_member_id: id.optional(),
    scores: z.record(z.string(), z.number()),
    notes_enc: z.string().optional(),
    observed_on: z.string().date().optional(),
    context: z.string().trim().max(200).optional(),
  }),
  async handler({ user }, i) {
    const tpl = await tplAccess(user, i.id);
    if (!i.campaign_entry_id && !i.watchlist_member_id) throw badRequest('campaign_entry_id or watchlist_member_id required');
    const totalScore = Object.values(i.scores).reduce((a, b) => a + b, 0);
    return one(
      `INSERT INTO scouting_evaluations
         (template_id, campaign_entry_id, watchlist_member_id, scores, total_score, notes_enc, observed_on, context, submitted_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING *`,
      [i.id, i.campaign_entry_id ?? null, i.watchlist_member_id ?? null, JSON.stringify(i.scores), totalScore, i.notes_enc ?? null, i.observed_on ?? null, i.context ?? null, user.id]
    );
  },
});

cap({
  name: 'list_evaluations',
  method: 'GET',
  path: '/scouting/prospects/:entry_id/evaluations',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'List evaluations for a prospect',
  input: z.object({ entry_id: id }),
  async handler({ user }, i) {
    return many(
      `SELECT e.*, et.name AS template_name, et.criteria, u.display_name AS evaluator_name
       FROM scouting_evaluations e
       JOIN scouting_evaluation_tpls et ON et.id = e.template_id
       JOIN users u ON u.id = e.submitted_by
       WHERE e.campaign_entry_id = $1
       ORDER BY e.submitted_at DESC`,
      [i.entry_id]
    );
  },
});

cap({
  name: 'get_evaluation',
  method: 'GET',
  path: '/scouting/evaluations/:id',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'Get a single evaluation',
  input: z.object({ id }),
  async handler({ user }, i) {
    const e = await one(
      `SELECT e.*, et.name AS template_name, et.criteria, et.org_id, u.display_name AS evaluator_name
       FROM scouting_evaluations e
       JOIN scouting_evaluation_tpls et ON et.id = e.template_id
       JOIN users u ON u.id = e.submitted_by
       WHERE e.id = $1`,
      [i.id]
    );
    if (!e) throw notFound();
    await orgMember(user, e.org_id);
    return e;
  },
});

cap({
  name: 'create_comparison',
  method: 'POST',
  path: '/organisations/:org_id/scouting/comparisons',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 201,
  summary: 'Create a side-by-side athlete comparison set',
  input: z.object({
    org_id: id,
    name: text(120),
    athlete_ids: z.array(id).min(2).max(10),
    criteria: z.array(z.string().trim().max(80)).min(1).max(20),
    campaign_id: id.optional(),
    template_id: id.optional(),
  }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return tx(async (c) => {
      const comp = await c.one(
        `INSERT INTO scouting_comparisons (org_id, name, athlete_ids, criteria, campaign_id, template_id, created_by)
         VALUES ($1,$2,$3::uuid[],$4::text[],$5,$6,$7) RETURNING *`,
        [i.org_id, i.name, i.athlete_ids, i.criteria, i.campaign_id ?? null, i.template_id ?? null, user.id]
      );
      if (i.template_id) {
        const evals = await c.many(
          `SELECT e.*, u.display_name
           FROM scouting_evaluations e
           JOIN users u ON u.id = e.submitted_by
           WHERE e.template_id = $1 AND e.campaign_entry_id IN (
             SELECT id FROM academy_campaign_entries WHERE user_id = ANY($2::uuid[])
           )
           ORDER BY e.submitted_at DESC`,
          [i.template_id, i.athlete_ids]
        );
        return { ...comp, evaluations: evals };
      }
      return comp;
    });
  },
});

cap({
  name: 'get_comparison',
  method: 'GET',
  path: '/scouting/comparisons/:id',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'Get a comparison with aggregated evaluation scores per athlete',
  input: z.object({ id }),
  async handler({ user }, i) {
    const comp = await one(`SELECT * FROM scouting_comparisons WHERE id = $1`, [i.id]);
    if (!comp) throw notFound();
    await orgMember(user, comp.org_id);
    const evals = comp.template_id
      ? await many(
          `SELECT e.total_score, e.scores, e.submitted_at,
                  ace.user_id AS athlete_id,
                  u.display_name AS athlete_name
           FROM scouting_evaluations e
           JOIN academy_campaign_entries ace ON ace.id = e.campaign_entry_id
           JOIN users u ON u.id = ace.user_id
           WHERE e.template_id = $1 AND ace.user_id = ANY($2::uuid[])
           ORDER BY e.submitted_at DESC`,
          [comp.template_id, comp.athlete_ids]
        )
      : [];
    return { ...comp, evaluations: evals };
  },
});

cap({
  name: 'list_comparisons',
  method: 'GET',
  path: '/organisations/:org_id/scouting/comparisons',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'List scouting comparisons for an organisation',
  input: z.object({ org_id: id, ...page.shape }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return many(
      `SELECT sc.*, u.display_name AS created_by_name
       FROM scouting_comparisons sc
       JOIN users u ON u.id = sc.created_by
       WHERE sc.org_id = $1
       ORDER BY sc.created_at DESC
       LIMIT $2 OFFSET $3`,
      [i.org_id, i.limit, i.offset]
    );
  },
});
