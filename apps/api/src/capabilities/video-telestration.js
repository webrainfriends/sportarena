// Video telestration workspace (issue #565): freeze-frame annotations with shapes (lines, arrows,
// zones, markers, text) layered on video frames. drawing_data_enc field in video_annotations
// already stores per-annotation drawings; this module adds multi-shape layer sessions.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';

const TAG = 'Video';
const SHAPE_TYPES = ['line', 'arrow', 'zone', 'marker', 'text', 'circle', 'spotlight'];
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

async function ownVideo(user, videoId) {
  const v = await one(
    `SELECT id, user_id FROM passport_videos WHERE id = $1 AND archived_at IS NULL`,
    [videoId]
  );
  if (!v) throw notFound();
  if (v.user_id !== user.id && !isAdmin(user)) throw forbidden();
  return v;
}

async function frameAccess(user, frameId) {
  const f = await one(
    `SELECT tf.* FROM video_telestration_frames tf
     JOIN passport_videos pv ON pv.id = tf.video_id
     WHERE tf.id = $1 AND tf.archived_at IS NULL`,
    [frameId]
  );
  if (!f) throw notFound();
  if (f.author_id !== user.id && !isAdmin(user)) {
    const v = await one(`SELECT user_id FROM passport_videos WHERE id = $1`, [f.video_id]);
    if (!v || v.user_id !== user.id) throw forbidden();
  }
  return f;
}

cap({
  name: 'create_telestration_frame',
  method: 'POST',
  path: '/me/videos/:video_id/telestration-frames',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 201,
  summary: 'Create a telestration frame at a video timestamp',
  input: z.object({
    video_id: id,
    timestamp_ms: z.number().int().min(0),
    title: z.string().trim().max(120).optional(),
    freeze_frame: z.boolean().default(true),
  }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    return one(
      `INSERT INTO video_telestration_frames (video_id, timestamp_ms, title, freeze_frame, author_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [i.video_id, i.timestamp_ms, i.title ?? null, i.freeze_frame, user.id]
    );
  },
});

cap({
  name: 'list_telestration_frames',
  method: 'GET',
  path: '/me/videos/:video_id/telestration-frames',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'List telestration frames for a video ordered by timestamp',
  input: z.object({ video_id: id }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    return many(
      `SELECT tf.*, COUNT(ts.id) FILTER (WHERE ts.removed_at IS NULL) AS shape_count
       FROM video_telestration_frames tf
       LEFT JOIN video_telestration_shapes ts ON ts.frame_id = tf.id
       WHERE tf.video_id = $1 AND tf.archived_at IS NULL
       GROUP BY tf.id
       ORDER BY tf.timestamp_ms`,
      [i.video_id]
    );
  },
});

cap({
  name: 'get_telestration_frame',
  method: 'GET',
  path: '/video/telestration-frames/:id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Get a telestration frame with all its shapes',
  input: z.object({ id }),
  async handler({ user }, i) {
    const frame = await frameAccess(user, i.id);
    const shapes = await many(
      `SELECT * FROM video_telestration_shapes WHERE frame_id = $1 AND removed_at IS NULL ORDER BY layer, created_at`,
      [i.id]
    );
    return { ...frame, shapes };
  },
});

cap({
  name: 'update_telestration_frame',
  method: 'PATCH',
  path: '/video/telestration-frames/:id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Update a telestration frame title or freeze-frame setting',
  input: z.object({
    id,
    title: z.string().trim().max(120).optional(),
    freeze_frame: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    await frameAccess(user, i.id);
    return one(
      `UPDATE video_telestration_frames
       SET title = COALESCE($2, title),
           freeze_frame = COALESCE($3, freeze_frame),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.title ?? null, i.freeze_frame ?? null]
    );
  },
});

cap({
  name: 'archive_telestration_frame',
  method: 'POST',
  path: '/video/telestration-frames/:id/archive',
  tag: TAG,
  auth: ['coach'],
  status: 200,
  summary: 'Soft-archive a telestration frame and all its shapes',
  input: z.object({ id }),
  async handler({ user }, i) {
    await frameAccess(user, i.id);
    await one(`UPDATE video_telestration_frames SET archived_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { archived: true };
  },
});

cap({
  name: 'add_telestration_shape',
  method: 'POST',
  path: '/video/telestration-frames/:id/shapes',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 201,
  summary: 'Add a shape to a telestration frame',
  input: z.object({
    id,
    type: z.enum(SHAPE_TYPES),
    layer: z.string().trim().max(60).default('default'),
    coords_enc: z.string(),
    colour: colour.default('#FF0000'),
    label: z.string().trim().max(200).optional(),
    stroke_width: z.number().int().min(1).max(20).default(3),
    opacity: z.number().min(0).max(1).default(1),
    filled: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    await frameAccess(user, i.id);
    return one(
      `INSERT INTO video_telestration_shapes
         (frame_id, type, layer, coords_enc, colour, label, stroke_width, opacity, filled, author_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.id, i.type, i.layer, i.coords_enc, i.colour, i.label ?? null, i.stroke_width, i.opacity, i.filled, user.id]
    );
  },
});

cap({
  name: 'update_telestration_shape',
  method: 'PATCH',
  path: '/video/telestration-shapes/:id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Update a telestration shape position, colour or label',
  input: z.object({
    id,
    coords_enc: z.string().optional(),
    colour: colour.optional(),
    label: z.string().trim().max(200).optional(),
    stroke_width: z.number().int().min(1).max(20).optional(),
    opacity: z.number().min(0).max(1).optional(),
    layer: z.string().trim().max(60).optional(),
    filled: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    const shape = await one(`SELECT * FROM video_telestration_shapes WHERE id = $1 AND removed_at IS NULL`, [i.id]);
    if (!shape) throw notFound();
    await frameAccess(user, shape.frame_id);
    return one(
      `UPDATE video_telestration_shapes
       SET coords_enc = COALESCE($2, coords_enc),
           colour = COALESCE($3, colour),
           label = COALESCE($4, label),
           stroke_width = COALESCE($5, stroke_width),
           opacity = COALESCE($6, opacity),
           layer = COALESCE($7, layer),
           filled = COALESCE($8, filled),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.coords_enc ?? null, i.colour ?? null, i.label ?? null, i.stroke_width ?? null, i.opacity ?? null, i.layer ?? null, i.filled ?? null]
    );
  },
});

cap({
  name: 'remove_telestration_shape',
  method: 'DELETE',
  path: '/video/telestration-shapes/:id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Soft-remove a telestration shape',
  input: z.object({ id }),
  async handler({ user }, i) {
    const shape = await one(`SELECT * FROM video_telestration_shapes WHERE id = $1 AND removed_at IS NULL`, [i.id]);
    if (!shape) throw notFound();
    await frameAccess(user, shape.frame_id);
    await one(`UPDATE video_telestration_shapes SET removed_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { removed: true };
  },
});

cap({
  name: 'export_telestration_frame',
  method: 'GET',
  path: '/video/telestration-frames/:id/export',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Export a telestration frame with all shapes for client-side rendering',
  input: z.object({ id }),
  async handler({ user }, i) {
    const frame = await frameAccess(user, i.id);
    const shapes = await many(
      `SELECT * FROM video_telestration_shapes WHERE frame_id = $1 AND removed_at IS NULL ORDER BY layer, created_at`,
      [i.id]
    );
    const video = await one(`SELECT id, title, source FROM passport_videos WHERE id = $1`, [frame.video_id]);
    return {
      frame,
      video,
      shapes,
      exported_at: new Date().toISOString(),
    };
  },
});
