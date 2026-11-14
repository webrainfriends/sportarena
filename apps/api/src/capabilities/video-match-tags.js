// Video match tagging (issue #565): sport-specific configurable timeline tags on a video,
// linking canonical match events to timestamps with version-safe correction handling.
// Reuses passport_videos ownership; never stores tag values as match facts.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { orgFor } from '../org-access.js';

const TAG = 'Video';
const text = (n) => z.string().trim().min(1).max(n);
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const TAG_CATEGORIES = ['attacking', 'defending', 'transition', 'set_piece', 'discipline', 'tactical', 'custom'];

async function ownVideo(user, videoId) {
  const v = await one(
    `SELECT id, user_id FROM passport_videos WHERE id = $1 AND archived_at IS NULL`,
    [videoId]
  );
  if (!v) throw notFound();
  if (v.user_id !== user.id && !isAdmin(user)) throw forbidden();
  return v;
}

async function orgMember(user, orgId) {
  const m = await one(
    `SELECT id FROM organisation_members WHERE organisation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [orgId, user.id]
  );
  if (!m && !isAdmin(user)) throw forbidden();
}

cap({
  name: 'list_tag_templates',
  method: 'GET',
  path: '/organisations/:org_id/video/tag-templates',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'List sport-specific tag templates for an organisation',
  input: z.object({ org_id: id, sport_id: id.optional(), include_archived: z.boolean().default(false) }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    const rows = await many(
      `SELECT t.*, s.name AS sport_name
       FROM video_tag_templates t
       LEFT JOIN sports s ON s.id = t.sport_id
       WHERE t.org_id = $1
         AND ($2::uuid IS NULL OR t.sport_id = $2)
         AND ($3 OR t.archived_at IS NULL)
       ORDER BY t.category, t.name`,
      [i.org_id, i.sport_id ?? null, i.include_archived]
    );
    return rows;
  },
});

cap({
  name: 'create_tag_template',
  method: 'POST',
  path: '/organisations/:org_id/video/tag-templates',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 201,
  summary: 'Create a configurable sport tag template for an organisation',
  input: z.object({
    org_id: id,
    name: text(80),
    code: z.string().trim().regex(/^[a-z_]{1,40}$/),
    colour: colour.default('#8458B3'),
    icon: z.string().trim().max(40).optional(),
    category: z.enum(TAG_CATEGORIES),
    sport_id: id.nullable().default(null),
    keyboard_shortcut: z.string().trim().max(1).optional(),
    is_default: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    const existing = await one(
      `SELECT id FROM video_tag_templates WHERE org_id = $1 AND code = $2 AND archived_at IS NULL`,
      [i.org_id, i.code]
    );
    if (existing) throw conflict('A template with this code already exists');
    const row = await one(
      `INSERT INTO video_tag_templates (org_id, name, code, colour, icon, category, sport_id, keyboard_shortcut, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [i.org_id, i.name, i.code, i.colour, i.icon ?? null, i.category, i.sport_id, i.keyboard_shortcut ?? null, i.is_default, user.id]
    );
    return row;
  },
});

cap({
  name: 'update_tag_template',
  method: 'PATCH',
  path: '/video/tag-templates/:id',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Update a tag template (code is immutable after creation)',
  input: z.object({
    id,
    name: text(80).optional(),
    colour: colour.optional(),
    icon: z.string().trim().max(40).optional(),
    category: z.enum(TAG_CATEGORIES).optional(),
    keyboard_shortcut: z.string().trim().max(1).optional(),
    is_default: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    const tpl = await one(`SELECT * FROM video_tag_templates WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!tpl) throw notFound();
    await orgMember(user, tpl.org_id);
    const row = await one(
      `UPDATE video_tag_templates
       SET name = COALESCE($2, name),
           colour = COALESCE($3, colour),
           icon = COALESCE($4, icon),
           category = COALESCE($5, category),
           keyboard_shortcut = COALESCE($6, keyboard_shortcut),
           is_default = COALESCE($7, is_default),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [i.id, i.name ?? null, i.colour ?? null, i.icon ?? null, i.category ?? null, i.keyboard_shortcut ?? null, i.is_default ?? null]
    );
    return row;
  },
});

cap({
  name: 'archive_tag_template',
  method: 'POST',
  path: '/video/tag-templates/:id/archive',
  tag: TAG,
  auth: ['admin'],
  status: 200,
  summary: 'Soft-archive a tag template',
  input: z.object({ id }),
  async handler({ user }, i) {
    const tpl = await one(`SELECT * FROM video_tag_templates WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!tpl) throw notFound();
    if (!isAdmin(user)) throw forbidden();
    await one(`UPDATE video_tag_templates SET archived_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { archived: true };
  },
});

cap({
  name: 'add_sport_tag',
  method: 'POST',
  path: '/me/videos/:video_id/tags',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 201,
  summary: 'Place a sport event tag at a timestamp on a video',
  input: z.object({
    video_id: id,
    template_id: id,
    timestamp_ms: z.number().int().min(0),
    duration_ms: z.number().int().min(0).optional(),
    match_event_id: id.optional(),
    notes_enc: z.string().optional(),
    ai_suggested: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    const tpl = await one(`SELECT id FROM video_tag_templates WHERE id = $1 AND archived_at IS NULL`, [i.template_id]);
    if (!tpl) throw notFound('Tag template not found');
    const row = await one(
      `INSERT INTO video_sport_tags
         (video_id, template_id, timestamp_ms, duration_ms, match_event_id, notes_enc, ai_suggested, author_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [i.video_id, i.template_id, i.timestamp_ms, i.duration_ms ?? null, i.match_event_id ?? null, i.notes_enc ?? null, i.ai_suggested, user.id]
    );
    return row;
  },
});

cap({
  name: 'list_sport_tags',
  method: 'GET',
  path: '/me/videos/:video_id/tags',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'List all sport tags on a video ordered by timestamp',
  input: z.object({ video_id: id }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    return many(
      `SELECT st.*, t.name AS template_name, t.code, t.colour, t.category, t.icon
       FROM video_sport_tags st
       JOIN video_tag_templates t ON t.id = st.template_id
       WHERE st.video_id = $1 AND st.archived_at IS NULL
       ORDER BY st.timestamp_ms`,
      [i.video_id]
    );
  },
});

cap({
  name: 'update_sport_tag',
  method: 'PATCH',
  path: '/video/sport-tags/:id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Correct a sport tag — creates a versioned replacement and archives the old one',
  input: z.object({
    id,
    timestamp_ms: z.number().int().min(0).optional(),
    duration_ms: z.number().int().min(0).optional(),
    notes_enc: z.string().optional(),
    match_event_id: id.optional(),
  }),
  async handler({ user }, i) {
    const old = await one(`SELECT * FROM video_sport_tags WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!old) throw notFound();
    await ownVideo(user, old.video_id);
    return tx(async (c) => {
      await c.one(`UPDATE video_sport_tags SET archived_at = now() WHERE id = $1 RETURNING id`, [i.id]);
      return c.one(
        `INSERT INTO video_sport_tags
           (video_id, template_id, timestamp_ms, duration_ms, match_event_id, notes_enc, ai_suggested, author_id, corrected_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          old.video_id, old.template_id,
          i.timestamp_ms ?? old.timestamp_ms,
          i.duration_ms ?? old.duration_ms,
          i.match_event_id ?? old.match_event_id,
          i.notes_enc ?? old.notes_enc,
          false,
          user.id,
          i.id,
        ]
      );
    });
  },
});

cap({
  name: 'delete_sport_tag',
  method: 'DELETE',
  path: '/video/sport-tags/:id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Soft-delete a sport tag',
  input: z.object({ id }),
  async handler({ user }, i) {
    const tag = await one(`SELECT * FROM video_sport_tags WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!tag) throw notFound();
    await ownVideo(user, tag.video_id);
    await one(`UPDATE video_sport_tags SET archived_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { deleted: true };
  },
});

cap({
  name: 'bulk_import_match_tags',
  method: 'POST',
  path: '/me/videos/:video_id/tags/bulk-import',
  tag: TAG,
  auth: ['coach'],
  status: 201,
  summary: 'Bulk-create sport tags from match events at their corresponding video timestamps',
  input: z.object({
    video_id: id,
    tags: z.array(z.object({
      template_id: id,
      timestamp_ms: z.number().int().min(0),
      duration_ms: z.number().int().min(0).optional(),
      match_event_id: id.optional(),
      notes_enc: z.string().optional(),
    })).min(1).max(500),
  }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    return tx(async (c) => {
      const created = [];
      for (const t of i.tags) {
        const row = await c.one(
          `INSERT INTO video_sport_tags
             (video_id, template_id, timestamp_ms, duration_ms, match_event_id, notes_enc, ai_suggested, author_id)
           VALUES ($1,$2,$3,$4,$5,$6,false,$7)
           RETURNING id, timestamp_ms, template_id`,
          [i.video_id, t.template_id, t.timestamp_ms, t.duration_ms ?? null, t.match_event_id ?? null, t.notes_enc ?? null, user.id]
        );
        created.push(row);
      }
      return { created: created.length, tags: created };
    });
  },
});

cap({
  name: 'link_video_to_match',
  method: 'POST',
  path: '/me/videos/:video_id/match-link',
  tag: TAG,
  auth: ['coach'],
  status: 201,
  summary: 'Link a video to a fixture or match with a start-time offset',
  input: z.object({
    video_id: id,
    fixture_id: id.nullable().default(null),
    match_activity_id: id.nullable().default(null),
    start_offset_ms: z.number().int().default(0),
    angle: z.enum(['main', 'tactical', 'player_cam', 'drone', 'other']).default('main'),
    notes: z.string().trim().max(500).optional(),
  }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    if (!i.fixture_id && !i.match_activity_id) throw badRequest('fixture_id or match_activity_id required');
    const existing = await one(
      `SELECT id FROM video_match_video_links WHERE video_id = $1 AND archived_at IS NULL
       AND ($2::uuid IS NULL OR fixture_id = $2)
       AND ($3::uuid IS NULL OR match_activity_id = $3)`,
      [i.video_id, i.fixture_id, i.match_activity_id]
    );
    if (existing) {
      return one(
        `UPDATE video_match_video_links
         SET start_offset_ms = $2, angle = $3, notes = $4, updated_at = now()
         WHERE id = $5 RETURNING *`,
        [null, i.start_offset_ms, i.angle, i.notes ?? null, existing.id]
      );
    }
    return one(
      `INSERT INTO video_match_video_links
         (video_id, fixture_id, match_activity_id, start_offset_ms, angle, notes, linked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [i.video_id, i.fixture_id, i.match_activity_id, i.start_offset_ms, i.angle, i.notes ?? null, user.id]
    );
  },
});

cap({
  name: 'list_video_match_links',
  method: 'GET',
  path: '/me/videos/:video_id/match-links',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'List match links for a video',
  input: z.object({ video_id: id }),
  async handler({ user }, i) {
    await ownVideo(user, i.video_id);
    return many(
      `SELECT * FROM video_match_video_links WHERE video_id = $1 AND archived_at IS NULL ORDER BY created_at`,
      [i.video_id]
    );
  },
});
