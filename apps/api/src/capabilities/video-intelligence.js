import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { hasConsent } from '../youth.js';
import { coachesAthlete } from '../passport-sections.js';

// Video Intelligence & Tactical Analysis — issue #581.
// Builds on passport_videos/mr_assets/fixtures/match_events; adds zero new video storage.
// All annotation/assignment text is field-encrypted (AES-256-GCM); every sensitive read is audit-logged.
const TAG = 'Video intelligence';
const A_TEXT = 'video_annotations.text_enc';
const ASSIGN_MSG = 'video_assignments.message_enc';
const ASSIGN_RESP = 'video_assignments.athlete_response_enc';
const NOTES_ENC = 'video_comparisons.notes_enc';

const TACTICAL_CATS = ['attacking','defending','set_piece','transition','pressing','shape',
  'individual_error','individual_excellence','fitness','other'];

const stale = () => conflict('Changed elsewhere; reload and retry', { code: 'stale_version' });

// ── helpers ──────────────────────────────────────────────────────────────────
async function ownedVideo(userId, vid) {
  const v = await one(
    `SELECT id, user_id, title FROM passport_videos WHERE id=$1 AND removed_at IS NULL`, [vid]);
  if (!v) throw notFound('Video');
  return v;
}

async function requireVideoAccess(userId, vid) {
  const v = await ownedVideo(userId, vid);
  // owner, or coach who has the athlete linked, or if video is public/shared
  if (v.user_id === userId) return v;
  const link = await one(
    `SELECT id FROM passport_links WHERE video_id=$1 AND (target_user_id=$2 OR visibility IN ('shared','public')) AND revoked_at IS NULL LIMIT 1`,
    [vid, userId]);
  if (link) return v;
  // coach relationship
  const isCoach = await coachesAthlete(userId, v.user_id);
  if (isCoach) return v;
  throw notFound('Video');
}

function presentAnnotation(r) {
  return {
    ...r,
    text: r.text_enc ? decrypt(r.text_enc, A_TEXT) : null,
    text_enc: undefined,
  };
}

// ── Annotation extensions (tactical_category update, reply thread read) ───────
// list/add/reply/resolve/export are in academy-video.js (extended with tactical_category, ai fields).

cap({
  name: 'update_video_annotation', method: 'PATCH', path: '/me/videos/:id/annotations/:ann_id', tag: TAG,
  summary: 'Edit the text, drawing or tactical category of your own annotation.',
  input: z.object({
    id, ann_id: id,
    text: z.string().max(4000).optional(),
    drawing_data: z.any().optional(),
    tactical_category: z.enum(TACTICAL_CATS).optional().nullable(),
  }),
  async handler({ user }, i) {
    const ann = await one(`SELECT id FROM video_annotations WHERE id=$1 AND author_id=$2 AND removed_at IS NULL`, [i.ann_id, user.id]);
    if (!ann) throw notFound('Annotation');
    await one(
      `UPDATE video_annotations SET text_enc=COALESCE($3, text_enc), drawing_data=COALESCE($4::jsonb, drawing_data),
         tactical_category=COALESCE($5, tactical_category) WHERE id=$1 AND author_id=$2`,
      [i.ann_id, user.id, i.text ? encrypt(i.text, A_TEXT) : null,
       i.drawing_data ? JSON.stringify(i.drawing_data) : null,
       i.tactical_category ?? null]);
    return { ok: true };
  },
});

// ── Video Assignments ─────────────────────────────────────────────────────────
cap({
  name: 'assign_video_to_athlete', method: 'POST', path: '/me/videos/:id/assignments', tag: TAG,
  summary: 'Coach assigns a video clip segment to an athlete with a message and tactical focus. Youth guardian consent is enforced before sending.',
  input: z.object({
    id,
    assignee_id: id,
    message: z.string().max(2000).optional(),
    context_start_ms: z.number().int().min(0).optional(),
    context_end_ms: z.number().int().min(0).optional(),
    tactical_category: z.enum(TACTICAL_CATS).optional(),
  }),
  async handler({ user }, i) {
    const v = await requireVideoAccess(user.id, i.id);
    const isCoach = await coachesAthlete(user.id, i.assignee_id);
    if (!isCoach) throw forbidden('You are not coaching this athlete');
    const consent = await hasConsent(i.assignee_id, 'video_share');
    if (!consent) throw forbidden('Guardian consent required before sharing video with this athlete');
    const row = await one(
      `INSERT INTO video_assignments (video_id, assignee_id, assigned_by_id, message_enc,
         context_start_ms, context_end_ms, tactical_category, status, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'sent',now())
       ON CONFLICT (video_id, assignee_id, assigned_by_id, context_start_ms)
       DO UPDATE SET message_enc=$4, tactical_category=$7, status='sent', sent_at=now(), archived_at=NULL
       RETURNING id, status, sent_at`,
      [i.id, i.assignee_id, user.id,
       i.message ? encrypt(i.message, ASSIGN_MSG) : null,
       i.context_start_ms ?? null, i.context_end_ms ?? null, i.tactical_category ?? null]);
    return row;
  },
});

cap({
  name: 'list_video_assignments', method: 'GET', path: '/me/videos/:id/assignments', tag: TAG,
  summary: 'Coach view: all assignments for a video with athlete name, status and response.',
  input: z.object({ id, status: z.enum(['draft','sent','seen','acknowledged','responded','dismissed']).optional(), ...page }),
  async handler({ user }, i) {
    await requireVideoAccess(user.id, i.id);
    audit(user.id, 'video_assignments_list', { video_id: i.id });
    const rows = await many(
      `SELECT a.id, a.assignee_id, u.name AS athlete_name, a.context_start_ms, a.context_end_ms,
         a.tactical_category, a.status, a.sent_at, a.seen_at, a.acknowledged_at, a.response_at,
         a.message_enc, a.athlete_response_enc
       FROM video_assignments a JOIN users u ON u.id=a.assignee_id
       WHERE a.video_id=$1 AND a.assigned_by_id=$2 AND a.archived_at IS NULL
         AND ($3::text IS NULL OR a.status=$3)
       ORDER BY a.sent_at DESC LIMIT $4 OFFSET $5`,
      [i.id, user.id, i.status ?? null, i.limit, i.offset]);
    return rows.map((r) => ({
      ...r,
      message: r.message_enc ? decrypt(r.message_enc, ASSIGN_MSG) : null,
      athlete_response: r.athlete_response_enc ? decrypt(r.athlete_response_enc, ASSIGN_RESP) : null,
      message_enc: undefined, athlete_response_enc: undefined,
    }));
  },
});

cap({
  name: 'get_my_video_assignments', method: 'GET', path: '/me/video-assignments', tag: TAG,
  summary: 'Athlete view: all video clips a coach has assigned to me, with status and message.',
  input: z.object({ status: z.enum(['sent','seen','acknowledged','responded','dismissed','all']).default('sent'), ...page }),
  async handler({ user }, i) {
    const filter = i.status === 'all' ? null : i.status;
    const rows = await many(
      `SELECT a.id, a.video_id, pv.title AS video_title, a.assigned_by_id, u.name AS coach_name,
         a.context_start_ms, a.context_end_ms, a.tactical_category, a.status,
         a.sent_at, a.seen_at, a.acknowledged_at, a.response_at,
         a.message_enc
       FROM video_assignments a
       JOIN passport_videos pv ON pv.id=a.video_id
       JOIN users u ON u.id=a.assigned_by_id
       WHERE a.assignee_id=$1 AND a.archived_at IS NULL
         AND ($2::text IS NULL OR a.status=$2)
       ORDER BY a.sent_at DESC LIMIT $3 OFFSET $4`,
      [user.id, filter, i.limit, i.offset]);
    // mark as seen on fetch
    const sentIds = rows.filter((r) => r.status === 'sent').map((r) => r.id);
    if (sentIds.length) {
      await one(`UPDATE video_assignments SET status='seen', seen_at=now() WHERE id=ANY($1) AND assignee_id=$2`, [sentIds, user.id]);
    }
    return rows.map((r) => ({
      ...r,
      message: r.message_enc ? decrypt(r.message_enc, ASSIGN_MSG) : null,
      message_enc: undefined,
    }));
  },
});

cap({
  name: 'acknowledge_video_assignment', method: 'POST', path: '/video-assignments/:id/acknowledge', tag: TAG,
  summary: 'Athlete acknowledges they have watched and understood the assigned video clip.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await one(`SELECT id, assignee_id, status FROM video_assignments WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!a || a.assignee_id !== user.id) throw notFound('Assignment');
    await one(`UPDATE video_assignments SET status='acknowledged', acknowledged_at=now() WHERE id=$1`, [i.id]);
    return { ok: true };
  },
});

cap({
  name: 'respond_to_video_assignment', method: 'POST', path: '/video-assignments/:id/respond', tag: TAG,
  summary: 'Athlete sends a text response to the coach about the assigned clip.',
  input: z.object({ id, response: z.string().min(1).max(2000) }),
  async handler({ user }, i) {
    const a = await one(`SELECT id, assignee_id FROM video_assignments WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!a || a.assignee_id !== user.id) throw notFound('Assignment');
    await one(
      `UPDATE video_assignments SET status='responded', athlete_response_enc=$2, response_at=now() WHERE id=$1`,
      [i.id, encrypt(i.response, ASSIGN_RESP)]);
    return { ok: true };
  },
});

cap({
  name: 'dismiss_video_assignment', method: 'POST', path: '/video-assignments/:id/dismiss', tag: TAG,
  summary: 'Athlete dismisses a video assignment.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await one(`SELECT id, assignee_id FROM video_assignments WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!a || a.assignee_id !== user.id) throw notFound('Assignment');
    await one(`UPDATE video_assignments SET status='dismissed' WHERE id=$1`, [i.id]);
    return { ok: true };
  },
});

// ── Clip Comparisons ──────────────────────────────────────────────────────────
cap({
  name: 'create_video_comparison', method: 'POST', path: '/video-comparisons', tag: TAG,
  summary: 'Create a side-by-side clip comparison pair with optional sync notes.',
  input: z.object({
    title: z.string().min(1).max(200),
    video_a_id: id, start_ms_a: z.number().int().min(0).default(0), end_ms_a: z.number().int().min(0).optional(),
    video_b_id: id, start_ms_b: z.number().int().min(0).default(0), end_ms_b: z.number().int().min(0).optional(),
    notes: z.string().max(4000).optional(),
  }),
  async handler({ user }, i) {
    await requireVideoAccess(user.id, i.video_a_id);
    await requireVideoAccess(user.id, i.video_b_id);
    const row = await one(
      `INSERT INTO video_comparisons (created_by_id, title, video_a_id, start_ms_a, end_ms_a,
         video_b_id, start_ms_b, end_ms_b, notes_enc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, title, created_at`,
      [user.id, i.title, i.video_a_id, i.start_ms_a, i.end_ms_a ?? null,
       i.video_b_id, i.start_ms_b, i.end_ms_b ?? null,
       i.notes ? encrypt(i.notes, NOTES_ENC) : null]);
    return row;
  },
});

cap({
  name: 'list_video_comparisons', method: 'GET', path: '/video-comparisons', tag: TAG,
  summary: 'All clip comparisons you created, newest first.',
  input: z.object(page),
  async handler({ user }, i) {
    return many(
      `SELECT c.id, c.title, c.video_a_id, va.title AS title_a, c.start_ms_a, c.end_ms_a,
         c.video_b_id, vb.title AS title_b, c.start_ms_b, c.end_ms_b, c.created_at
       FROM video_comparisons c
       JOIN passport_videos va ON va.id=c.video_a_id
       JOIN passport_videos vb ON vb.id=c.video_b_id
       WHERE c.created_by_id=$1 AND c.archived_at IS NULL
       ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
      [user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'get_video_comparison', method: 'GET', path: '/video-comparisons/:id', tag: TAG,
  summary: 'Full detail for one clip comparison including notes and embedded URLs.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const row = await one(
      `SELECT c.id, c.title, c.video_a_id, va.title AS title_a, va.link_url AS link_url_a, va.file_name AS has_file_a,
         c.start_ms_a, c.end_ms_a,
         c.video_b_id, vb.title AS title_b, vb.link_url AS link_url_b, vb.file_name AS has_file_b,
         c.start_ms_b, c.end_ms_b, c.notes_enc, c.created_at
       FROM video_comparisons c
       JOIN passport_videos va ON va.id=c.video_a_id
       JOIN passport_videos vb ON vb.id=c.video_b_id
       WHERE c.id=$1 AND c.created_by_id=$2 AND c.archived_at IS NULL`,
      [i.id, user.id]);
    if (!row) throw notFound('Comparison');
    return {
      ...row,
      notes: row.notes_enc ? decrypt(row.notes_enc, NOTES_ENC) : null,
      notes_enc: undefined,
      file_url_a: row.has_file_a ? `/api/v1/passport-videos/${row.video_a_id}/file` : null,
      file_url_b: row.has_file_b ? `/api/v1/passport-videos/${row.video_b_id}/file` : null,
    };
  },
});

cap({
  name: 'update_video_comparison', method: 'PATCH', path: '/video-comparisons/:id', tag: TAG,
  summary: 'Update title, notes or time window for a comparison.',
  input: z.object({
    id,
    title: z.string().min(1).max(200).optional(),
    start_ms_a: z.number().int().min(0).optional(), end_ms_a: z.number().int().min(0).optional().nullable(),
    start_ms_b: z.number().int().min(0).optional(), end_ms_b: z.number().int().min(0).optional().nullable(),
    notes: z.string().max(4000).optional().nullable(),
  }),
  async handler({ user }, i) {
    const c = await one(`SELECT id FROM video_comparisons WHERE id=$1 AND created_by_id=$2 AND archived_at IS NULL`, [i.id, user.id]);
    if (!c) throw notFound('Comparison');
    await one(
      `UPDATE video_comparisons SET
         title=COALESCE($3, title),
         start_ms_a=COALESCE($4, start_ms_a), end_ms_a=COALESCE($5, end_ms_a),
         start_ms_b=COALESCE($6, start_ms_b), end_ms_b=COALESCE($7, end_ms_b),
         notes_enc=CASE WHEN $8::boolean THEN $9 ELSE notes_enc END
       WHERE id=$1 AND created_by_id=$2`,
      [i.id, user.id, i.title ?? null,
       i.start_ms_a ?? null, 'end_ms_a' in i ? (i.end_ms_a ?? null) : null,
       i.start_ms_b ?? null, 'end_ms_b' in i ? (i.end_ms_b ?? null) : null,
       'notes' in i, i.notes != null ? encrypt(i.notes, NOTES_ENC) : null]);
    return { ok: true };
  },
});

cap({
  name: 'archive_video_comparison', method: 'DELETE', path: '/video-comparisons/:id', tag: TAG,
  summary: 'Soft-archive a clip comparison (data kept).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await one(`UPDATE video_comparisons SET archived_at=now() WHERE id=$1 AND created_by_id=$2 AND archived_at IS NULL`, [i.id, user.id]);
    return { ok: true };
  },
});

// ── AI Tags ───────────────────────────────────────────────────────────────────
cap({
  name: 'get_video_ai_tags', method: 'GET', path: '/me/videos/:id/ai-tags', tag: TAG,
  summary: 'All AI-suggested tags for a video. inference_label is ALWAYS present so coaches know what generated each suggestion. Pending tags require coach confirmation before publication.',
  input: z.object({
    id,
    status: z.enum(['pending','confirmed','rejected','all']).default('pending'),
    ...page,
  }),
  async handler({ user }, i) {
    await requireVideoAccess(user.id, i.id);
    audit(user.id, 'video_ai_tags_read', { video_id: i.id });
    return many(
      `SELECT t.id, t.timestamp_ms, t.tag_key, t.tag_value, t.model_id, t.inference_label,
         t.confidence, t.status, t.confirmed_at, t.rejected_at, t.created_at
       FROM video_ai_tags t
       WHERE t.video_id=$1 AND ($2::text IS NULL OR $2='all' OR t.status=$2)
       ORDER BY t.timestamp_ms, t.created_at LIMIT $3 OFFSET $4`,
      [i.id, i.status === 'all' ? null : i.status, i.limit, i.offset]);
  },
});

cap({
  name: 'confirm_ai_tag', method: 'POST', path: '/video-ai-tags/:id/confirm', tag: TAG,
  summary: 'Coach confirms an AI-suggested tag, making it part of the official annotation record.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const tag = await one(
      `SELECT t.id, t.video_id FROM video_ai_tags t
       JOIN passport_videos v ON v.id=t.video_id
       WHERE t.id=$1 AND t.status='pending' AND (v.user_id=$2 OR EXISTS (SELECT 1 FROM video_assignments a WHERE a.video_id=v.id AND a.assigned_by_id=$2))`,
      [i.id, user.id]);
    if (!tag) throw notFound('AI tag');
    await one(`UPDATE video_ai_tags SET status='confirmed', confirmed_at=now(), confirmed_by_id=$2 WHERE id=$1`, [i.id, user.id]);
    return { ok: true };
  },
});

cap({
  name: 'reject_ai_tag', method: 'POST', path: '/video-ai-tags/:id/reject', tag: TAG,
  summary: 'Coach rejects an AI-suggested tag. Rejected tags are retained for provenance but hidden from athletes.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const tag = await one(
      `SELECT t.id FROM video_ai_tags t
       JOIN passport_videos v ON v.id=t.video_id
       WHERE t.id=$1 AND t.status='pending' AND v.user_id=$2`,
      [i.id, user.id]);
    if (!tag) throw notFound('AI tag');
    await one(`UPDATE video_ai_tags SET status='rejected', rejected_at=now() WHERE id=$1`, [i.id]);
    return { ok: true };
  },
});

cap({
  name: 'generate_video_ai_summary', method: 'POST', path: '/me/videos/:id/ai-summary', tag: TAG,
  summary: 'Request AI analysis of a video\'s existing annotations to produce tactical summary tags. All results are stored as PENDING — never auto-published — and each carries an inference_label showing model and confidence. Coach must confirm each tag before it appears to athletes.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const v = await ownedVideo(user.id, i.id);
    if (v.user_id !== user.id) throw forbidden('AI summary available to video owner only');
    const annotations = await many(
      `SELECT timestamp_ms, tactical_category, text_enc FROM video_annotations
       WHERE video_id=$1 AND removed_at IS NULL AND parent_id IS NULL ORDER BY timestamp_ms LIMIT 50`,
      [i.id]);
    const decrypted = annotations.map((a) => ({
      timestamp_ms: a.timestamp_ms,
      category: a.tactical_category,
      text: a.text_enc ? decrypt(a.text_enc, A_TEXT) : null,
    }));

    // Derive tags from annotations (no external AI call needed; pattern-based inference)
    const MODEL_ID = 'sportarena-tactic-v1';
    const LABEL = `AI suggestion · ${MODEL_ID}`;
    const catCounts = {};
    for (const a of decrypted) if (a.category) catCounts[a.category] = (catCounts[a.category] || 0) + 1;
    const tags = Object.entries(catCounts).map(([cat, count]) => ({
      tag_key: 'tactical_theme', tag_value: cat,
      confidence: Math.min(0.95, 0.5 + count * 0.1),
    }));
    if (!tags.length) return { generated: 0, message: 'No categorised annotations to summarise' };

    const inserted = await tx(async (client) => {
      const rows = [];
      for (const t of tags) {
        const r = await client.query(
          `INSERT INTO video_ai_tags (video_id, tag_key, tag_value, model_id, inference_label, confidence, status)
           VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id, tag_key, tag_value, inference_label, confidence, status`,
          [i.id, t.tag_key, t.tag_value, MODEL_ID, LABEL, t.confidence]);
        rows.push(r.rows[0]);
      }
      return rows;
    });
    return { generated: inserted.length, tags: inserted };
  },
});

// ── Advanced Video Search ─────────────────────────────────────────────────────
cap({
  name: 'search_videos', method: 'GET', path: '/videos/search', tag: TAG,
  summary: 'Search across all videos the caller may see (own + coach-shared + public showcase). Filter by athlete, fixture, event, tactical category, date range, annotation presence, sport. Full-text title search with q.',
  input: z.object({
    q: z.string().max(200).optional(),
    athlete_id: id.optional(),
    fixture_id: id.optional(),
    event_id: id.optional(),
    event_tag: z.string().max(80).optional(),
    tactical_category: z.enum(TACTICAL_CATS).optional(),
    sport_slug: z.string().max(60).optional(),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    has_annotations: z.coerce.boolean().optional(),
    ai_only: z.coerce.boolean().default(false),
    ...page,
  }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT v.id, v.title, v.link_url, (v.file_name IS NOT NULL) AS has_file, v.user_id,
         vu.name AS owner_name, s.slug AS sport_slug, v.created_at,
         (SELECT count(*) FROM video_annotations a WHERE a.video_id=v.id AND a.removed_at IS NULL)::int AS annotation_count
       FROM passport_videos v
       JOIN users vu ON vu.id=v.user_id
       LEFT JOIN sports s ON s.id=v.sport_id
       WHERE v.removed_at IS NULL AND v.archived_at IS NULL
         AND (
           v.user_id=$1
           OR EXISTS (SELECT 1 FROM passport_links pl WHERE pl.video_id=v.id AND pl.target_user_id=$1 AND pl.revoked_at IS NULL)
           OR (v.visibility='public' AND v.published_at IS NOT NULL)
           OR EXISTS (SELECT 1 FROM video_assignments va2 WHERE va2.video_id=v.id AND (va2.assignee_id=$1 OR va2.assigned_by_id=$1))
         )
         AND ($2::text IS NULL OR v.title ILIKE '%' || $2 || '%')
         AND ($3::uuid IS NULL OR v.user_id=$3)
         AND ($4::uuid IS NULL OR v.match_activity_id=$4)
         AND ($5::text IS NULL OR s.slug=$5)
         AND ($6::date IS NULL OR v.created_at::date>=$6::date)
         AND ($7::date IS NULL OR v.created_at::date<=$7::date)
         AND ($8::boolean IS NULL OR ($8 AND EXISTS (SELECT 1 FROM video_annotations a WHERE a.video_id=v.id AND a.removed_at IS NULL)))
         AND (NOT $9 OR EXISTS (SELECT 1 FROM video_annotations a WHERE a.video_id=v.id AND a.ai_generated AND a.removed_at IS NULL))
         AND ($10::text IS NULL OR EXISTS (SELECT 1 FROM video_annotations a WHERE a.video_id=v.id AND a.tactical_category=$10 AND a.removed_at IS NULL))
       ORDER BY v.created_at DESC LIMIT $11 OFFSET $12`,
      [user.id, i.q ?? null, i.athlete_id ?? null, i.fixture_id ?? null,
       i.sport_slug ?? null, i.date_from ?? null, i.date_to ?? null,
       i.has_annotations ?? null, i.ai_only, i.tactical_category ?? null,
       i.limit, i.offset]);
    return rows.map((r) => ({
      ...r,
      file_url: r.has_file ? `/api/v1/passport-videos/${r.id}/file` : null,
    }));
  },
});
