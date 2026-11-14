// Formal scouting recommendations with evidence attachments and committee routing (issue #565).
// Recommendations are linked to campaign entries; evidence items reference videos, documents or stats.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';

const TAG = 'Scouting';
const text = (n) => z.string().trim().min(1).max(n);

const DECISIONS = ['enrol', 'reserve', 'monitor', 'decline', 'defer'];
const STATUSES = ['draft', 'submitted', 'approved', 'declined', 'withdrawn'];
const EVIDENCE_KINDS = ['video', 'document', 'stats', 'evaluation', 'external_link'];

async function recAccess(user, recId) {
  const rec = await one(
    `SELECT sr.*, ace.user_id AS prospect_user_id, ace.campaign_id
     FROM scouting_recommendations sr
     JOIN academy_campaign_entries ace ON ace.id = sr.campaign_entry_id
     WHERE sr.id = $1`,
    [recId]
  );
  if (!rec) throw notFound();
  if (rec.author_id !== user.id && !isAdmin(user)) {
    const cm = await one(
      `SELECT id FROM academy_campaign_members WHERE campaign_id = $1 AND user_id = $2`,
      [rec.campaign_id, user.id]
    );
    if (!cm) throw forbidden();
  }
  return rec;
}

cap({
  name: 'create_recommendation',
  method: 'POST',
  path: '/scouting/prospects/:entry_id/recommendations',
  tag: TAG,
  auth: ['scout', 'coach'],
  status: 201,
  summary: 'Create a draft scouting recommendation for a prospect',
  input: z.object({
    entry_id: id,
    decision: z.enum(DECISIONS),
    confidence: z.number().int().min(1).max(10),
    notes_enc: z.string().optional(),
    summary_enc: z.string().optional(),
  }),
  async handler({ user }, i) {
    const entry = await one(
      `SELECT ace.*, c.id AS campaign_id
       FROM academy_campaign_entries ace
       JOIN academy_scouting_campaigns c ON c.id = ace.campaign_id
       WHERE ace.id = $1`,
      [i.entry_id]
    );
    if (!entry) throw notFound();
    const existing = await one(
      `SELECT id FROM scouting_recommendations WHERE campaign_entry_id = $1 AND author_id = $2 AND status NOT IN ('withdrawn','declined')`,
      [i.entry_id, user.id]
    );
    if (existing) throw conflict('You already have an active recommendation for this prospect');
    return one(
      `INSERT INTO scouting_recommendations (campaign_entry_id, author_id, decision, confidence, notes_enc, summary_enc)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [i.entry_id, user.id, i.decision, i.confidence, i.notes_enc ?? null, i.summary_enc ?? null]
    );
  },
});

cap({
  name: 'update_recommendation',
  method: 'PATCH',
  path: '/scouting/recommendations/:id',
  tag: TAG,
  auth: ['scout', 'coach'],
  status: 200,
  summary: 'Update a draft recommendation',
  input: z.object({
    id,
    decision: z.enum(DECISIONS).optional(),
    confidence: z.number().int().min(1).max(10).optional(),
    notes_enc: z.string().optional(),
    summary_enc: z.string().optional(),
  }),
  async handler({ user }, i) {
    const rec = await recAccess(user, i.id);
    if (rec.status !== 'draft') throw conflict('Only draft recommendations may be edited');
    if (rec.author_id !== user.id) throw forbidden();
    return one(
      `UPDATE scouting_recommendations
       SET decision = COALESCE($2, decision),
           confidence = COALESCE($3, confidence),
           notes_enc = COALESCE($4, notes_enc),
           summary_enc = COALESCE($5, summary_enc),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.decision ?? null, i.confidence ?? null, i.notes_enc ?? null, i.summary_enc ?? null]
    );
  },
});

cap({
  name: 'submit_recommendation',
  method: 'POST',
  path: '/scouting/recommendations/:id/submit',
  tag: TAG,
  auth: ['scout', 'coach'],
  status: 200,
  summary: 'Submit a recommendation for admin review',
  input: z.object({ id }),
  async handler({ user }, i) {
    const rec = await recAccess(user, i.id);
    if (rec.status !== 'draft') throw conflict('Only draft recommendations can be submitted');
    if (rec.author_id !== user.id) throw forbidden();
    return one(
      `UPDATE scouting_recommendations SET status = 'submitted', submitted_at = now() WHERE id = $1 RETURNING *`,
      [i.id]
    );
  },
});

cap({
  name: 'review_recommendation',
  method: 'POST',
  path: '/scouting/recommendations/:id/review',
  tag: TAG,
  auth: ['admin'],
  status: 200,
  summary: 'Approve or decline a submitted recommendation',
  input: z.object({
    id,
    action: z.enum(['approve', 'decline']),
    reviewer_note_enc: z.string().optional(),
  }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden();
    const rec = await one(`SELECT * FROM scouting_recommendations WHERE id = $1`, [i.id]);
    if (!rec) throw notFound();
    if (rec.status !== 'submitted') throw conflict('Only submitted recommendations can be reviewed');
    const newStatus = i.action === 'approve' ? 'approved' : 'declined';
    return one(
      `UPDATE scouting_recommendations
       SET status = $2, reviewed_by = $3, reviewed_at = now(), reviewer_note_enc = $4
       WHERE id = $1 RETURNING *`,
      [i.id, newStatus, user.id, i.reviewer_note_enc ?? null]
    );
  },
});

cap({
  name: 'add_evidence',
  method: 'POST',
  path: '/scouting/recommendations/:id/evidence',
  tag: TAG,
  auth: ['scout', 'coach'],
  status: 201,
  summary: 'Attach evidence to a recommendation',
  input: z.object({
    id,
    kind: z.enum(EVIDENCE_KINDS),
    ref_id: id.optional(),
    external_url_enc: z.string().optional(),
    label: text(200),
    notes_enc: z.string().optional(),
  }),
  async handler({ user }, i) {
    const rec = await recAccess(user, i.id);
    if (!['draft', 'submitted'].includes(rec.status)) throw conflict('Cannot add evidence to a finalised recommendation');
    if (!i.ref_id && !i.external_url_enc) throw badRequest('ref_id or external_url_enc required');
    return one(
      `INSERT INTO scouting_evidence (recommendation_id, kind, ref_id, external_url_enc, label, notes_enc, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [i.id, i.kind, i.ref_id ?? null, i.external_url_enc ?? null, i.label, i.notes_enc ?? null, user.id]
    );
  },
});

cap({
  name: 'remove_evidence',
  method: 'DELETE',
  path: '/scouting/evidence/:id',
  tag: TAG,
  auth: ['scout', 'coach'],
  status: 200,
  summary: 'Soft-remove an evidence item',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await one(`SELECT * FROM scouting_evidence WHERE id = $1 AND removed_at IS NULL`, [i.id]);
    if (!ev) throw notFound();
    const rec = await recAccess(user, ev.recommendation_id);
    if (rec.author_id !== user.id && !isAdmin(user)) throw forbidden();
    await one(`UPDATE scouting_evidence SET removed_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { removed: true };
  },
});

cap({
  name: 'list_recommendations',
  method: 'GET',
  path: '/scouting/prospects/:entry_id/recommendations',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'List recommendations for a prospect',
  input: z.object({ entry_id: id }),
  async handler({ user }, i) {
    return many(
      `SELECT sr.*,
              u.display_name AS author_name,
              rv.display_name AS reviewer_name,
              COUNT(DISTINCT se.id) FILTER (WHERE se.removed_at IS NULL) AS evidence_count
       FROM scouting_recommendations sr
       JOIN users u ON u.id = sr.author_id
       LEFT JOIN users rv ON rv.id = sr.reviewed_by
       LEFT JOIN scouting_evidence se ON se.recommendation_id = sr.id
       WHERE sr.campaign_entry_id = $1
       GROUP BY sr.id, u.display_name, rv.display_name
       ORDER BY sr.created_at DESC`,
      [i.entry_id]
    );
  },
});

cap({
  name: 'export_recommendation',
  method: 'GET',
  path: '/scouting/recommendations/:id/export',
  tag: TAG,
  auth: ['admin', 'scout'],
  status: 200,
  summary: 'Export a recommendation as structured data for PDF generation',
  input: z.object({ id }),
  async handler({ user }, i) {
    const rec = await recAccess(user, i.id);
    const evidence = await many(
      `SELECT * FROM scouting_evidence WHERE recommendation_id = $1 AND removed_at IS NULL ORDER BY created_at`,
      [i.id]
    );
    const evaluations = await many(
      `SELECT e.*, et.name AS template_name, et.criteria
       FROM scouting_evaluations e
       JOIN scouting_evaluation_tpls et ON et.id = e.template_id
       WHERE e.campaign_entry_id = $1
       ORDER BY e.submitted_at DESC`,
      [rec.campaign_entry_id]
    );
    const prospect = await one(
      `SELECT ace.*, u.display_name, u.avatar_url, u.handle
       FROM academy_campaign_entries ace
       LEFT JOIN users u ON u.id = ace.user_id
       WHERE ace.id = $1`,
      [rec.campaign_entry_id]
    );
    return {
      recommendation: rec,
      prospect,
      evidence,
      evaluations,
      exported_at: new Date().toISOString(),
    };
  },
});
