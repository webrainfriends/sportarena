// Scouting watchlists and scout assignments (issue #565): named athlete watchlists independent
// of talent campaigns, with priority-ranked members and scout assignment tracking.
// Extends academy-scouting.js (campaigns/pipeline); does not duplicate those flows.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';

const TAG = 'Scouting';
const text = (n) => z.string().trim().min(1).max(n);
const PRIORITIES = ['hot', 'warm', 'watch', 'low'];

async function orgMember(user, orgId) {
  const m = await one(
    `SELECT id FROM organisation_members WHERE organisation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [orgId, user.id]
  );
  if (!m && !isAdmin(user)) throw forbidden();
}

async function watchlistAccess(user, watchlistId) {
  const wl = await one(
    `SELECT sw.* FROM scouting_watchlists sw
     JOIN organisation_members om ON om.organisation_id = sw.org_id AND om.user_id = $2 AND om.left_at IS NULL
     WHERE sw.id = $1 AND sw.archived_at IS NULL`,
    [watchlistId, user.id]
  );
  if (!wl && !isAdmin(user)) throw notFound();
  if (!wl) {
    const bare = await one(`SELECT * FROM scouting_watchlists WHERE id = $1 AND archived_at IS NULL`, [watchlistId]);
    if (!bare) throw notFound();
    return bare;
  }
  return wl;
}

cap({
  name: 'list_watchlists',
  method: 'GET',
  path: '/organisations/:org_id/scouting/watchlists',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'List scouting watchlists for an organisation',
  input: z.object({ org_id: id, sport_id: id.optional(), season: z.string().trim().max(40).optional(), ...page.shape }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return many(
      `SELECT sw.*,
              s.name AS sport_name,
              COUNT(DISTINCT swm.id) FILTER (WHERE swm.removed_at IS NULL) AS member_count,
              u.display_name AS owner_name
       FROM scouting_watchlists sw
       LEFT JOIN sports s ON s.id = sw.sport_id
       LEFT JOIN scouting_watchlist_members swm ON swm.watchlist_id = sw.id
       LEFT JOIN users u ON u.id = sw.owner_id
       WHERE sw.org_id = $1
         AND ($3::uuid IS NULL OR sw.sport_id = $3)
         AND ($4::text IS NULL OR sw.season = $4)
         AND sw.archived_at IS NULL
       GROUP BY sw.id, s.name, u.display_name
       ORDER BY sw.created_at DESC
       LIMIT $5 OFFSET $6`,
      [i.org_id, user.id, i.sport_id ?? null, i.season ?? null, i.limit, i.offset]
    );
  },
});

cap({
  name: 'create_watchlist',
  method: 'POST',
  path: '/organisations/:org_id/scouting/watchlists',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 201,
  summary: 'Create a scouting watchlist',
  input: z.object({
    org_id: id,
    name: text(120),
    sport_id: id.nullable().default(null),
    season: z.string().trim().max(40).optional(),
    description_enc: z.string().optional(),
    shared: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return one(
      `INSERT INTO scouting_watchlists (org_id, name, sport_id, season, description_enc, shared, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [i.org_id, i.name, i.sport_id, i.season ?? null, i.description_enc ?? null, i.shared, user.id]
    );
  },
});

cap({
  name: 'get_watchlist',
  method: 'GET',
  path: '/scouting/watchlists/:id',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'Get a watchlist with member count',
  input: z.object({ id }),
  async handler({ user }, i) {
    const wl = await watchlistAccess(user, i.id);
    const stats = await one(
      `SELECT
         COUNT(*) FILTER (WHERE removed_at IS NULL) AS member_count,
         COUNT(*) FILTER (WHERE removed_at IS NULL AND priority = 'hot') AS hot_count,
         COUNT(*) FILTER (WHERE removed_at IS NULL AND priority = 'warm') AS warm_count
       FROM scouting_watchlist_members WHERE watchlist_id = $1`,
      [i.id]
    );
    return { ...wl, ...stats };
  },
});

cap({
  name: 'update_watchlist',
  method: 'PATCH',
  path: '/scouting/watchlists/:id',
  tag: TAG,
  auth: ['admin', 'scout'],
  status: 200,
  summary: 'Update watchlist metadata',
  input: z.object({
    id,
    name: text(120).optional(),
    season: z.string().trim().max(40).optional(),
    description_enc: z.string().optional(),
    shared: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    await watchlistAccess(user, i.id);
    return one(
      `UPDATE scouting_watchlists
       SET name = COALESCE($2, name),
           season = COALESCE($3, season),
           description_enc = COALESCE($4, description_enc),
           shared = COALESCE($5, shared),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.name ?? null, i.season ?? null, i.description_enc ?? null, i.shared ?? null]
    );
  },
});

cap({
  name: 'archive_watchlist',
  method: 'POST',
  path: '/scouting/watchlists/:id/archive',
  tag: TAG,
  auth: ['admin'],
  status: 200,
  summary: 'Soft-archive a watchlist',
  input: z.object({ id }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden();
    const wl = await one(`SELECT id FROM scouting_watchlists WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!wl) throw notFound();
    await one(`UPDATE scouting_watchlists SET archived_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { archived: true };
  },
});

cap({
  name: 'add_watchlist_member',
  method: 'POST',
  path: '/scouting/watchlists/:id/members',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 201,
  summary: 'Add an athlete or prospect to a watchlist',
  input: z.object({
    id,
    user_id: id.optional(),
    external_name: z.string().trim().max(120).optional(),
    external_club: z.string().trim().max(120).optional(),
    position: z.string().trim().max(60).optional(),
    birth_year: z.number().int().min(1950).max(2100).optional(),
    priority: z.enum(PRIORITIES).default('watch'),
    notes_enc: z.string().optional(),
  }),
  async handler({ user }, i) {
    const wl = await watchlistAccess(user, i.id);
    if (!i.user_id && !i.external_name) throw badRequest('user_id or external_name required');
    if (i.user_id) {
      const existing = await one(
        `SELECT id FROM scouting_watchlist_members WHERE watchlist_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [i.id, i.user_id]
      );
      if (existing) throw conflict('Athlete already on watchlist');
    }
    return one(
      `INSERT INTO scouting_watchlist_members
         (watchlist_id, user_id, external_name, external_club, position, birth_year, priority, notes_enc, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [i.id, i.user_id ?? null, i.external_name ?? null, i.external_club ?? null, i.position ?? null, i.birth_year ?? null, i.priority, i.notes_enc ?? null, user.id]
    );
  },
});

cap({
  name: 'list_watchlist_members',
  method: 'GET',
  path: '/scouting/watchlists/:id/members',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'List members of a watchlist sorted by priority',
  input: z.object({ id, priority: z.enum(PRIORITIES).optional(), ...page.shape }),
  async handler({ user }, i) {
    await watchlistAccess(user, i.id);
    return many(
      `SELECT swm.*,
              u.display_name, u.avatar_url,
              u.handle,
              ssa.scout_id IS NOT NULL AS has_assignment
       FROM scouting_watchlist_members swm
       LEFT JOIN users u ON u.id = swm.user_id
       LEFT JOIN scouting_scout_assignments ssa ON ssa.member_id = swm.id AND ssa.revoked_at IS NULL
       WHERE swm.watchlist_id = $1
         AND swm.removed_at IS NULL
         AND ($2::text IS NULL OR swm.priority = $2)
       ORDER BY
         CASE swm.priority WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END,
         swm.added_at
       LIMIT $3 OFFSET $4`,
      [i.id, i.priority ?? null, i.limit, i.offset]
    );
  },
});

cap({
  name: 'update_watchlist_member',
  method: 'PATCH',
  path: '/scouting/watchlist-members/:id',
  tag: TAG,
  auth: ['admin', 'scout', 'coach'],
  status: 200,
  summary: 'Update a watchlist member priority or notes',
  input: z.object({
    id,
    priority: z.enum(PRIORITIES).optional(),
    notes_enc: z.string().optional(),
    position: z.string().trim().max(60).optional(),
  }),
  async handler({ user }, i) {
    const m = await one(`SELECT * FROM scouting_watchlist_members WHERE id = $1 AND removed_at IS NULL`, [i.id]);
    if (!m) throw notFound();
    await watchlistAccess(user, m.watchlist_id);
    return one(
      `UPDATE scouting_watchlist_members
       SET priority = COALESCE($2, priority),
           notes_enc = COALESCE($3, notes_enc),
           position = COALESCE($4, position),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.priority ?? null, i.notes_enc ?? null, i.position ?? null]
    );
  },
});

cap({
  name: 'remove_watchlist_member',
  method: 'DELETE',
  path: '/scouting/watchlist-members/:id',
  tag: TAG,
  auth: ['admin', 'scout'],
  status: 200,
  summary: 'Remove a member from a watchlist',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await one(`SELECT * FROM scouting_watchlist_members WHERE id = $1 AND removed_at IS NULL`, [i.id]);
    if (!m) throw notFound();
    await watchlistAccess(user, m.watchlist_id);
    await one(`UPDATE scouting_watchlist_members SET removed_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { removed: true };
  },
});

cap({
  name: 'assign_scout',
  method: 'POST',
  path: '/scouting/watchlist-members/:id/assign',
  tag: TAG,
  auth: ['admin'],
  status: 201,
  summary: 'Assign a scout to follow a watchlist member',
  input: z.object({
    id,
    scout_id: id,
    due_by: z.string().datetime().optional(),
    instructions_enc: z.string().optional(),
  }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden();
    const m = await one(`SELECT * FROM scouting_watchlist_members WHERE id = $1 AND removed_at IS NULL`, [i.id]);
    if (!m) throw notFound();
    const existing = await one(
      `SELECT id FROM scouting_scout_assignments WHERE member_id = $1 AND scout_id = $2 AND revoked_at IS NULL`,
      [i.id, i.scout_id]
    );
    if (existing) throw conflict('Scout already assigned to this member');
    return one(
      `INSERT INTO scouting_scout_assignments (member_id, scout_id, assigned_by, due_by, instructions_enc)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [i.id, i.scout_id, user.id, i.due_by ?? null, i.instructions_enc ?? null]
    );
  },
});

cap({
  name: 'list_my_scout_assignments',
  method: 'GET',
  path: '/me/scouting/assignments',
  tag: TAG,
  auth: ['scout'],
  status: 200,
  summary: "List the current scout's active assignments",
  input: z.object({ ...page.shape }),
  async handler({ user }, i) {
    return many(
      `SELECT ssa.*,
              swm.user_id AS athlete_id,
              swm.external_name,
              swm.external_club,
              swm.priority,
              u.display_name AS athlete_name,
              sw.name AS watchlist_name,
              o.name AS org_name
       FROM scouting_scout_assignments ssa
       JOIN scouting_watchlist_members swm ON swm.id = ssa.member_id
       JOIN scouting_watchlists sw ON sw.id = swm.watchlist_id
       JOIN organisations o ON o.id = sw.org_id
       LEFT JOIN users u ON u.id = swm.user_id
       WHERE ssa.scout_id = $1 AND ssa.revoked_at IS NULL
       ORDER BY
         CASE swm.priority WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END,
         ssa.assigned_at DESC
       LIMIT $2 OFFSET $3`,
      [user.id, i.limit, i.offset]
    );
  },
});
