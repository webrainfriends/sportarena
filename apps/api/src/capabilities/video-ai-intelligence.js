// Video AI intelligence (issue #565): AI-suggested tags, highlight proposals and summaries.
// AI inference is ALWAYS clearly distinguished from verified match data: ai_suggested=true
// is set on every AI-generated entity and displayed prominently in the UI.
// AI suggestions are never automatically applied; each requires explicit coach review.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';

const TAG = 'Video';
const SUGGESTION_TYPES = ['tag', 'highlight', 'summary', 'clip', 'annotation'];
const STATUSES = ['pending', 'accepted', 'rejected', 'modified'];
const RUN_TRIGGERS = ['manual', 'on_upload', 'scheduled'];

async function ownVideo(user, videoId) {
  const v = await one(
    `SELECT id, user_id FROM passport_videos WHERE id = $1 AND archived_at IS NULL`,
    [videoId]
  );
  if (!v) throw notFound();
  if (v.user_id !== user.id && !isAdmin(user)) throw forbidden();
  return v;
}

async function runAccess(user, runId) {
  const run = await one(`SELECT * FROM video_ai_runs WHERE id = $1`, [runId]);
  if (!run) throw notFound();
  await ownVideo(user, run.video_id);
  return run;
}

cap({
  name: 'trigger_ai_run',
  method: 'POST',
  path: '/me/videos/:video_id/ai/run',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 202,
  summary: 'Trigger an AI analysis run on a video to generate tag and highlight suggestions',
  input: z.object({
    video_id: id,
    run_types: z.array(z.enum(SUGGESTION_TYPES)).min(1).default(['tag', 'highlight']),
    sport_id: id.optional(),
    template_id: id.optional(),
    notes: z.string().trim().max(300).optional(),
  }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    const existing = await one(
      `SELECT id FROM video_ai_runs WHERE video_id = $1 AND status IN ('queued','running') LIMIT 1`,
      [i.video_id]
    );
    if (existing) throw conflict('An AI run is already in progress for this video');
    const run = await one(
      `INSERT INTO video_ai_runs (video_id, trigger, run_types, sport_id, template_id, notes, requested_by, status)
       VALUES ($1,'manual',$2::text[],$3,$4,$5,$6,'queued') RETURNING id, status, created_at`,
      [i.video_id, i.run_types, i.sport_id ?? null, i.template_id ?? null, i.notes ?? null, user.id]
    );
    return { run_id: run.id, status: run.status, queued_at: run.created_at };
  },
});

cap({
  name: 'get_ai_run_status',
  method: 'GET',
  path: '/video/ai-runs/:run_id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Poll the status of an AI analysis run',
  input: z.object({ run_id: id }),
  async handler({ user }, i) {
    const run = await runAccess(user, i.run_id);
    const counts = await one(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
         COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_count,
         COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_count
       FROM video_ai_suggestions WHERE run_id = $1`,
      [i.run_id]
    );
    return { ...run, suggestion_counts: counts };
  },
});

cap({
  name: 'list_ai_suggestions',
  method: 'GET',
  path: '/me/videos/:video_id/ai/suggestions',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'List AI suggestions for a video — all marked ai_suggested=true',
  input: z.object({
    video_id: id,
    status: z.enum(STATUSES).optional(),
    suggestion_type: z.enum(SUGGESTION_TYPES).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    ...page.shape,
  }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    return many(
      `SELECT vas.*,
              true AS ai_suggested,
              var.run_types,
              var.sport_id
       FROM video_ai_suggestions vas
       JOIN video_ai_runs var ON var.id = vas.run_id
       WHERE var.video_id = $1
         AND ($2::text IS NULL OR vas.status = $2)
         AND ($3::text IS NULL OR vas.suggestion_type = $3)
         AND ($4::float IS NULL OR vas.confidence >= $4)
       ORDER BY vas.confidence DESC, vas.timestamp_ms ASC NULLS LAST
       LIMIT $5 OFFSET $6`,
      [i.video_id, i.status ?? null, i.suggestion_type ?? null, i.min_confidence ?? null, i.limit, i.offset]
    );
  },
});

cap({
  name: 'review_ai_suggestion',
  method: 'POST',
  path: '/video/ai-suggestions/:id/review',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Accept, reject or modify an AI suggestion; on accept creates the actual entity',
  input: z.object({
    id,
    action: z.enum(['accept', 'reject', 'modify']),
    modifications: z.record(z.string(), z.unknown()).optional(),
    reject_reason: z.string().trim().max(200).optional(),
  }),
  async handler({ user }, i) {
    const sug = await one(`SELECT * FROM video_ai_suggestions WHERE id = $1 AND status = 'pending'`, [i.id]);
    if (!sug) throw notFound('Suggestion not found or already reviewed');
    const run = await runAccess(user, sug.run_id);

    return tx(async (c) => {
      let createdEntityId = null;

      if (i.action === 'accept' || i.action === 'modify') {
        const payload = i.action === 'modify' && i.modifications
          ? { ...sug.payload, ...i.modifications }
          : sug.payload;

        if (sug.suggestion_type === 'tag') {
          const tag = await c.one(
            `INSERT INTO video_sport_tags
               (video_id, template_id, timestamp_ms, duration_ms, notes_enc, ai_suggested, author_id)
             VALUES ($1,$2,$3,$4,$5,true,$6)
             RETURNING id`,
            [run.video_id, payload.template_id, payload.timestamp_ms, payload.duration_ms ?? null, payload.notes_enc ?? null, user.id]
          );
          createdEntityId = tag.id;
        } else if (sug.suggestion_type === 'clip') {
          const clip = await c.one(
            `INSERT INTO video_clip_sessions
               (org_id, source_video_id, title, start_ms, end_ms, notes_enc, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING id`,
            [payload.org_id, run.video_id, payload.title, payload.start_ms, payload.end_ms, payload.notes_enc ?? null, user.id]
          );
          createdEntityId = clip.id;
        }
      }

      await c.one(
        `UPDATE video_ai_suggestions
         SET status = $2, reviewed_by = $3, reviewed_at = now(),
             applied_modifications = $4::jsonb,
             reject_reason = $5,
             created_entity_id = $6
         WHERE id = $1 RETURNING id`,
        [
          i.id,
          i.action === 'accept' ? 'accepted' : i.action === 'modify' ? 'modified' : 'rejected',
          user.id,
          i.modifications ? JSON.stringify(i.modifications) : null,
          i.reject_reason ?? null,
          createdEntityId,
        ]
      );

      return {
        suggestion_id: i.id,
        status: i.action === 'accept' ? 'accepted' : i.action === 'modify' ? 'modified' : 'rejected',
        created_entity_id: createdEntityId,
        ai_suggested: true,
      };
    });
  },
});

cap({
  name: 'bulk_review_ai_suggestions',
  method: 'POST',
  path: '/me/videos/:video_id/ai/suggestions/bulk-review',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Accept or reject multiple AI suggestions at once',
  input: z.object({
    video_id: id,
    suggestion_ids: z.array(id).min(1).max(100),
    action: z.enum(['accept', 'reject']),
    reject_reason: z.string().trim().max(200).optional(),
  }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    const newStatus = i.action === 'accept' ? 'accepted' : 'rejected';
    return tx(async (c) => {
      const updated = await c.many(
        `UPDATE video_ai_suggestions
         SET status = $2, reviewed_by = $3, reviewed_at = now(), reject_reason = $4
         WHERE id = ANY($1::uuid[]) AND status = 'pending'
         RETURNING id, status, suggestion_type`,
        [i.suggestion_ids, newStatus, user.id, i.reject_reason ?? null]
      );
      return { updated: updated.length, status: newStatus, ai_suggested: true };
    });
  },
});

cap({
  name: 'get_ai_summary',
  method: 'GET',
  path: '/me/videos/:video_id/ai/summary',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Get a summary of AI suggestions and confidence distribution for a video',
  input: z.object({ video_id: id }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    const summary = await one(
      `SELECT
         COUNT(*) FILTER (WHERE vas.status = 'pending') AS pending_count,
         COUNT(*) FILTER (WHERE vas.status = 'accepted') AS accepted_count,
         COUNT(*) FILTER (WHERE vas.status = 'rejected') AS rejected_count,
         COUNT(*) FILTER (WHERE vas.status = 'modified') AS modified_count,
         COUNT(*) FILTER (WHERE vas.suggestion_type = 'tag' AND vas.status = 'pending') AS pending_tags,
         COUNT(*) FILTER (WHERE vas.suggestion_type = 'highlight' AND vas.status = 'pending') AS pending_highlights,
         COUNT(*) FILTER (WHERE vas.suggestion_type = 'clip' AND vas.status = 'pending') AS pending_clips,
         ROUND(AVG(vas.confidence) FILTER (WHERE vas.status = 'pending'), 3) AS avg_confidence,
         ROUND(MIN(vas.confidence) FILTER (WHERE vas.status = 'pending'), 3) AS min_confidence,
         ROUND(MAX(vas.confidence) FILTER (WHERE vas.status = 'pending'), 3) AS max_confidence
       FROM video_ai_suggestions vas
       JOIN video_ai_runs var ON var.id = vas.run_id
       WHERE var.video_id = $1`,
      [i.video_id]
    );
    const latestRun = await one(
      `SELECT id, status, started_at, finished_at, model_version
       FROM video_ai_runs WHERE video_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [i.video_id]
    );
    return { summary, latest_run: latestRun, ai_suggested: true };
  },
});
