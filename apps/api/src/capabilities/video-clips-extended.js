// Extended clip workspace (issue #565): trim sessions, athlete assignment with coaching notes,
// and named clip groups. Extends the AI event-console clips (#505); does not duplicate them.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { orgFor } from '../org-access.js';

const TAG = 'Video';
const text = (n) => z.string().trim().min(1).max(n);

const REVIEW_STATES = ['pending', 'understood', 'question', 'resolved'];

async function orgMember(user, orgId) {
  const m = await one(
    `SELECT id FROM organisation_members WHERE organisation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [orgId, user.id]
  );
  if (!m && !isAdmin(user)) throw forbidden();
}

async function clipSessionAccess(user, clipId) {
  const clip = await one(
    `SELECT cs.*, om.organisation_id
     FROM video_clip_sessions cs
     JOIN organisation_members om ON om.organisation_id = cs.org_id AND om.user_id = $2 AND om.left_at IS NULL
     WHERE cs.id = $1 AND cs.archived_at IS NULL`,
    [clipId, user.id]
  );
  if (!clip && !isAdmin(user)) throw notFound();
  if (!clip) {
    const bare = await one(`SELECT * FROM video_clip_sessions WHERE id = $1 AND archived_at IS NULL`, [clipId]);
    if (!bare) throw notFound();
    return bare;
  }
  return clip;
}

cap({
  name: 'create_clip_session',
  method: 'POST',
  path: '/organisations/:org_id/video/clip-sessions',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 201,
  summary: 'Create a trim clip session from a source video',
  input: z.object({
    org_id: id,
    source_video_id: id,
    title: text(200),
    start_ms: z.number().int().min(0),
    end_ms: z.number().int().min(1),
    notes_enc: z.string().optional(),
    sport_tag_id: id.optional(),
  }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    if (i.end_ms <= i.start_ms) throw badRequest('end_ms must be greater than start_ms');
    const v = await one(`SELECT id FROM passport_videos WHERE id = $1 AND archived_at IS NULL`, [i.source_video_id]);
    if (!v) throw notFound('Source video not found');
    return one(
      `INSERT INTO video_clip_sessions (org_id, source_video_id, title, start_ms, end_ms, notes_enc, sport_tag_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [i.org_id, i.source_video_id, i.title, i.start_ms, i.end_ms, i.notes_enc ?? null, i.sport_tag_id ?? null, user.id]
    );
  },
});

cap({
  name: 'list_clip_sessions',
  method: 'GET',
  path: '/organisations/:org_id/video/clip-sessions',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'List clip sessions for an organisation',
  input: z.object({
    org_id: id,
    group_id: id.optional(),
    include_archived: z.boolean().default(false),
    ...page.shape,
  }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return many(
      `SELECT cs.*,
              pv.title AS source_title,
              COUNT(DISTINCT ca.id) FILTER (WHERE ca.revoked_at IS NULL) AS assignment_count
       FROM video_clip_sessions cs
       JOIN passport_videos pv ON pv.id = cs.source_video_id
       LEFT JOIN video_clip_assignments ca ON ca.clip_session_id = cs.id
       LEFT JOIN video_clip_group_items cgi ON cgi.clip_session_id = cs.id AND cgi.removed_at IS NULL
       WHERE cs.org_id = $1
         AND ($3::uuid IS NULL OR cgi.group_id = $3)
         AND ($4 OR cs.archived_at IS NULL)
       GROUP BY cs.id, pv.title
       ORDER BY cs.created_at DESC
       LIMIT $5 OFFSET $6`,
      [i.org_id, user.id, i.group_id ?? null, i.include_archived, i.limit, i.offset]
    );
  },
});

cap({
  name: 'get_clip_session',
  method: 'GET',
  path: '/video/clip-sessions/:id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Get a clip session with its assignments',
  input: z.object({ id }),
  async handler({ user }, i) {
    const clip = await clipSessionAccess(user, i.id);
    const assignments = await many(
      `SELECT ca.*, u.display_name, u.avatar_url
       FROM video_clip_assignments ca
       JOIN users u ON u.id = ca.athlete_id
       WHERE ca.clip_session_id = $1 AND ca.revoked_at IS NULL
       ORDER BY ca.assigned_at`,
      [i.id]
    );
    return { ...clip, assignments };
  },
});

cap({
  name: 'update_clip_session',
  method: 'PATCH',
  path: '/video/clip-sessions/:id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Update a clip session title, trim points or notes',
  input: z.object({
    id,
    title: text(200).optional(),
    start_ms: z.number().int().min(0).optional(),
    end_ms: z.number().int().min(1).optional(),
    notes_enc: z.string().optional(),
  }),
  async handler({ user }, i) {
    const clip = await clipSessionAccess(user, i.id);
    if (i.start_ms != null && i.end_ms != null && i.end_ms <= i.start_ms) throw badRequest('end_ms must be greater than start_ms');
    return one(
      `UPDATE video_clip_sessions
       SET title = COALESCE($2, title),
           start_ms = COALESCE($3, start_ms),
           end_ms = COALESCE($4, end_ms),
           notes_enc = COALESCE($5, notes_enc),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.title ?? null, i.start_ms ?? null, i.end_ms ?? null, i.notes_enc ?? null]
    );
  },
});

cap({
  name: 'archive_clip_session',
  method: 'POST',
  path: '/video/clip-sessions/:id/archive',
  tag: TAG,
  auth: ['coach'],
  status: 200,
  summary: 'Soft-archive a clip session',
  input: z.object({ id }),
  async handler({ user }, i) {
    await clipSessionAccess(user, i.id);
    await one(`UPDATE video_clip_sessions SET archived_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { archived: true };
  },
});

cap({
  name: 'assign_clip_to_athlete',
  method: 'POST',
  path: '/video/clip-sessions/:id/assignments',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 201,
  summary: 'Assign a clip to an athlete with a coaching note',
  input: z.object({
    id,
    athlete_id: id,
    coaching_note_enc: z.string().optional(),
    due_by: z.string().datetime().optional(),
  }),
  async handler({ user }, i) {
    await clipSessionAccess(user, i.id);
    const existing = await one(
      `SELECT id FROM video_clip_assignments
       WHERE clip_session_id = $1 AND athlete_id = $2 AND revoked_at IS NULL`,
      [i.id, i.athlete_id]
    );
    if (existing) throw conflict('Athlete already assigned to this clip');
    return one(
      `INSERT INTO video_clip_assignments (clip_session_id, athlete_id, coaching_note_enc, assigned_by, due_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [i.id, i.athlete_id, i.coaching_note_enc ?? null, user.id, i.due_by ?? null]
    );
  },
});

cap({
  name: 'list_clip_assignments',
  method: 'GET',
  path: '/video/clip-sessions/:id/assignments',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'List athlete assignments for a clip session',
  input: z.object({ id }),
  async handler({ user }, i) {
    await clipSessionAccess(user, i.id);
    return many(
      `SELECT ca.*, u.display_name, u.avatar_url
       FROM video_clip_assignments ca
       JOIN users u ON u.id = ca.athlete_id
       WHERE ca.clip_session_id = $1 AND ca.revoked_at IS NULL
       ORDER BY ca.assigned_at`,
      [i.id]
    );
  },
});

cap({
  name: 'update_clip_assignment',
  method: 'PATCH',
  path: '/video/clip-assignments/:id',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'Update a clip assignment coaching note or revoke it',
  input: z.object({
    id,
    coaching_note_enc: z.string().optional(),
    revoke: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    const a = await one(`SELECT * FROM video_clip_assignments WHERE id = $1 AND revoked_at IS NULL`, [i.id]);
    if (!a) throw notFound();
    await clipSessionAccess(user, a.clip_session_id);
    if (i.revoke) {
      return one(`UPDATE video_clip_assignments SET revoked_at = now() WHERE id = $1 RETURNING *`, [i.id]);
    }
    return one(
      `UPDATE video_clip_assignments SET coaching_note_enc = COALESCE($2, coaching_note_enc), updated_at = now() WHERE id = $1 RETURNING *`,
      [i.id, i.coaching_note_enc ?? null]
    );
  },
});

cap({
  name: 'respond_to_clip',
  method: 'POST',
  path: '/me/clip-assignments/:id/respond',
  tag: TAG,
  auth: ['athlete'],
  status: 200,
  summary: 'Athlete responds to a clip assignment',
  input: z.object({
    id,
    review_state: z.enum(['understood', 'question', 'resolved']),
  }),
  async handler({ user }, i) {
    const a = await one(
      `SELECT * FROM video_clip_assignments WHERE id = $1 AND athlete_id = $2 AND revoked_at IS NULL`,
      [i.id, user.id]
    );
    if (!a) throw notFound();
    return one(
      `UPDATE video_clip_assignments
       SET review_state = $2, first_viewed_at = COALESCE(first_viewed_at, now()), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.review_state]
    );
  },
});

cap({
  name: 'list_my_clip_assignments',
  method: 'GET',
  path: '/me/clip-assignments',
  tag: TAG,
  auth: ['athlete'],
  status: 200,
  summary: "List the athlete's assigned clip queue",
  input: z.object({ review_state: z.enum(REVIEW_STATES).optional(), ...page.shape }),
  async handler({ user }, i) {
    return many(
      `SELECT ca.*, cs.title, cs.start_ms, cs.end_ms, pv.title AS source_title,
              u.display_name AS coach_name
       FROM video_clip_assignments ca
       JOIN video_clip_sessions cs ON cs.id = ca.clip_session_id AND cs.archived_at IS NULL
       JOIN passport_videos pv ON pv.id = cs.source_video_id
       JOIN users u ON u.id = ca.assigned_by
       WHERE ca.athlete_id = $1
         AND ca.revoked_at IS NULL
         AND ($2::text IS NULL OR ca.review_state = $2)
       ORDER BY ca.assigned_at DESC
       LIMIT $3 OFFSET $4`,
      [user.id, i.review_state ?? null, i.limit, i.offset]
    );
  },
});

cap({
  name: 'create_clip_group',
  method: 'POST',
  path: '/organisations/:org_id/video/clip-groups',
  tag: TAG,
  auth: ['coach'],
  status: 201,
  summary: 'Create a named clip group',
  input: z.object({ org_id: id, name: text(120), description: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return one(
      `INSERT INTO video_clip_groups (org_id, name, description, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [i.org_id, i.name, i.description ?? null, user.id]
    );
  },
});

cap({
  name: 'list_clip_groups',
  method: 'GET',
  path: '/organisations/:org_id/video/clip-groups',
  tag: TAG,
  auth: ['coach', 'staff'],
  status: 200,
  summary: 'List clip groups for an organisation',
  input: z.object({ org_id: id }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return many(
      `SELECT cg.*, COUNT(cgi.id) FILTER (WHERE cgi.removed_at IS NULL) AS clip_count
       FROM video_clip_groups cg
       LEFT JOIN video_clip_group_items cgi ON cgi.group_id = cg.id
       WHERE cg.org_id = $1 AND cg.archived_at IS NULL
       GROUP BY cg.id ORDER BY cg.created_at`,
      [i.org_id]
    );
  },
});

cap({
  name: 'add_clip_to_group',
  method: 'POST',
  path: '/video/clip-groups/:group_id/clips',
  tag: TAG,
  auth: ['coach'],
  status: 201,
  summary: 'Add a clip session to a group at a given position',
  input: z.object({ group_id: id, clip_session_id: id, position: z.number().int().min(0).default(0) }),
  async handler({ user }, i) {
    const grp = await one(`SELECT * FROM video_clip_groups WHERE id = $1 AND archived_at IS NULL`, [i.group_id]);
    if (!grp) throw notFound();
    await orgMember(user, grp.org_id);
    const existing = await one(
      `SELECT id FROM video_clip_group_items WHERE group_id = $1 AND clip_session_id = $2 AND removed_at IS NULL`,
      [i.group_id, i.clip_session_id]
    );
    if (existing) throw conflict('Clip already in group');
    return one(
      `INSERT INTO video_clip_group_items (group_id, clip_session_id, position, added_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [i.group_id, i.clip_session_id, i.position, user.id]
    );
  },
});

cap({
  name: 'remove_clip_from_group',
  method: 'DELETE',
  path: '/video/clip-groups/:group_id/clips/:clip_session_id',
  tag: TAG,
  auth: ['coach'],
  status: 200,
  summary: 'Remove a clip from a group',
  input: z.object({ group_id: id, clip_session_id: id }),
  async handler({ user }, i) {
    const grp = await one(`SELECT * FROM video_clip_groups WHERE id = $1 AND archived_at IS NULL`, [i.group_id]);
    if (!grp) throw notFound();
    await orgMember(user, grp.org_id);
    const item = await one(
      `SELECT id FROM video_clip_group_items WHERE group_id = $1 AND clip_session_id = $2 AND removed_at IS NULL`,
      [i.group_id, i.clip_session_id]
    );
    if (!item) throw notFound();
    await one(`UPDATE video_clip_group_items SET removed_at = now() WHERE id = $1 RETURNING id`, [item.id]);
    return { removed: true };
  },
});
