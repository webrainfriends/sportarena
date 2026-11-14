// Opponent analysis workspace (issue #565): profiles, recent games, key players, set pieces
// and curated video playlists for pre-match preparation. Per-org, per-season.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';

const TAG = 'Opponent Analysis';
const text = (n) => z.string().trim().min(1).max(n);

const THREAT_LEVELS = ['high', 'medium', 'low', 'unknown'];
const SET_PIECE_KINDS = ['corner', 'free_kick', 'throw_in', 'penalty', 'kick_off', 'goal_kick'];
const MATCH_RESULTS = ['win', 'draw', 'loss', 'unknown'];

async function orgMember(user, orgId) {
  const m = await one(
    `SELECT id FROM organisation_members WHERE organisation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [orgId, user.id]
  );
  if (!m && !isAdmin(user)) throw forbidden();
}

async function profileAccess(user, profileId) {
  const p = await one(
    `SELECT op.*, om.organisation_id AS _org
     FROM opponent_profiles op
     JOIN organisation_members om ON om.organisation_id = op.org_id AND om.user_id = $2 AND om.left_at IS NULL
     WHERE op.id = $1 AND op.archived_at IS NULL`,
    [profileId, user.id]
  );
  if (!p && !isAdmin(user)) throw notFound();
  if (!p) {
    const bare = await one(`SELECT * FROM opponent_profiles WHERE id = $1 AND archived_at IS NULL`, [profileId]);
    if (!bare) throw notFound();
    return bare;
  }
  return p;
}

cap({
  name: 'list_opponent_profiles',
  method: 'GET',
  path: '/organisations/:org_id/opponent-analysis',
  tag: TAG,
  auth: ['admin', 'coach', 'analyst'],
  status: 200,
  summary: 'List opponent analysis profiles for an organisation',
  input: z.object({ org_id: id, season: z.string().trim().max(40).optional(), ...page.shape }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return many(
      `SELECT op.*,
              COUNT(DISTINCT og.id) AS game_count,
              COUNT(DISTINCT okp.id) FILTER (WHERE okp.removed_at IS NULL) AS key_player_count
       FROM opponent_profiles op
       LEFT JOIN opponent_games og ON og.profile_id = op.id
       LEFT JOIN opponent_key_players okp ON okp.profile_id = op.id
       WHERE op.org_id = $1
         AND op.archived_at IS NULL
         AND ($2::text IS NULL OR op.season = $2)
       GROUP BY op.id
       ORDER BY op.created_at DESC
       LIMIT $3 OFFSET $4`,
      [i.org_id, i.season ?? null, i.limit, i.offset]
    );
  },
});

cap({
  name: 'create_opponent_profile',
  method: 'POST',
  path: '/organisations/:org_id/opponent-analysis',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 201,
  summary: 'Create an opponent analysis profile',
  input: z.object({
    org_id: id,
    opponent_name: text(120),
    opponent_team_id: id.optional(),
    season: z.string().trim().max(40).optional(),
    formation: z.string().trim().max(20).optional(),
    style_notes_enc: z.string().optional(),
    tendencies_enc: z.string().optional(),
    source_fixture_ids: z.array(id).max(20).optional(),
  }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return one(
      `INSERT INTO opponent_profiles
         (org_id, opponent_name, opponent_team_id, season, formation, style_notes_enc, tendencies_enc, analyst_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [i.org_id, i.opponent_name, i.opponent_team_id ?? null, i.season ?? null, i.formation ?? null, i.style_notes_enc ?? null, i.tendencies_enc ?? null, user.id]
    );
  },
});

cap({
  name: 'get_opponent_profile',
  method: 'GET',
  path: '/opponent-analysis/:id',
  tag: TAG,
  auth: ['admin', 'coach', 'analyst'],
  status: 200,
  summary: 'Get a full opponent analysis profile with games, key players and set pieces',
  input: z.object({ id }),
  async handler({ user }, i) {
    const profile = await profileAccess(user, i.id);
    const [games, keyPlayers, setPieces, playlists] = await Promise.all([
      many(`SELECT * FROM opponent_games WHERE profile_id = $1 ORDER BY match_date DESC LIMIT 10`, [i.id]),
      many(`SELECT * FROM opponent_key_players WHERE profile_id = $1 AND removed_at IS NULL ORDER BY threat_level, name`, [i.id]),
      many(`SELECT * FROM opponent_set_pieces WHERE profile_id = $1 AND archived_at IS NULL ORDER BY kind`, [i.id]),
      many(`SELECT * FROM opponent_playlists WHERE profile_id = $1 AND archived_at IS NULL ORDER BY created_at`, [i.id]),
    ]);
    return { ...profile, games, key_players: keyPlayers, set_pieces: setPieces, playlists };
  },
});

cap({
  name: 'update_opponent_profile',
  method: 'PATCH',
  path: '/opponent-analysis/:id',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Update opponent profile formation, notes and tendencies',
  input: z.object({
    id,
    opponent_name: text(120).optional(),
    formation: z.string().trim().max(20).optional(),
    style_notes_enc: z.string().optional(),
    tendencies_enc: z.string().optional(),
  }),
  async handler({ user }, i) {
    await profileAccess(user, i.id);
    return one(
      `UPDATE opponent_profiles
       SET opponent_name = COALESCE($2, opponent_name),
           formation = COALESCE($3, formation),
           style_notes_enc = COALESCE($4, style_notes_enc),
           tendencies_enc = COALESCE($5, tendencies_enc),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.opponent_name ?? null, i.formation ?? null, i.style_notes_enc ?? null, i.tendencies_enc ?? null]
    );
  },
});

cap({
  name: 'archive_opponent_profile',
  method: 'POST',
  path: '/opponent-analysis/:id/archive',
  tag: TAG,
  auth: ['admin'],
  status: 200,
  summary: 'Soft-archive an opponent profile',
  input: z.object({ id }),
  async handler({ user }, i) {
    if (!isAdmin(user)) throw forbidden();
    const p = await one(`SELECT id FROM opponent_profiles WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!p) throw notFound();
    await one(`UPDATE opponent_profiles SET archived_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { archived: true };
  },
});

cap({
  name: 'add_opponent_game',
  method: 'POST',
  path: '/opponent-analysis/:id/games',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 201,
  summary: 'Record a recent opponent game for analysis',
  input: z.object({
    id,
    match_date: z.string().date(),
    opponent_score: z.number().int().min(0).optional(),
    their_opponent_score: z.number().int().min(0).optional(),
    result: z.enum(MATCH_RESULTS).default('unknown'),
    formation_used: z.string().trim().max(20).optional(),
    notes_enc: z.string().optional(),
    fixture_id: id.optional(),
  }),
  async handler({ user }, i) {
    await profileAccess(user, i.id);
    return one(
      `INSERT INTO opponent_games
         (profile_id, match_date, opponent_score, their_opponent_score, result, formation_used, notes_enc, fixture_id, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [i.id, i.match_date, i.opponent_score ?? null, i.their_opponent_score ?? null, i.result, i.formation_used ?? null, i.notes_enc ?? null, i.fixture_id ?? null, user.id]
    );
  },
});

cap({
  name: 'list_opponent_games',
  method: 'GET',
  path: '/opponent-analysis/:id/games',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 200,
  summary: 'List recent games for an opponent profile',
  input: z.object({ id, ...page.shape }),
  async handler({ user }, i) {
    await profileAccess(user, i.id);
    return many(
      `SELECT * FROM opponent_games WHERE profile_id = $1 ORDER BY match_date DESC LIMIT $2 OFFSET $3`,
      [i.id, i.limit, i.offset]
    );
  },
});

cap({
  name: 'add_key_player',
  method: 'POST',
  path: '/opponent-analysis/:id/key-players',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 201,
  summary: 'Add a key player to track in an opponent profile',
  input: z.object({
    id,
    name: text(120),
    user_id: id.optional(),
    position: z.string().trim().max(60).optional(),
    shirt_number: z.number().int().min(1).max(99).optional(),
    role: z.string().trim().max(80).optional(),
    threat_level: z.enum(THREAT_LEVELS).default('medium'),
    notes_enc: z.string().optional(),
    strengths_enc: z.string().optional(),
    weaknesses_enc: z.string().optional(),
  }),
  async handler({ user }, i) {
    await profileAccess(user, i.id);
    return one(
      `INSERT INTO opponent_key_players
         (profile_id, name, user_id, position, shirt_number, role, threat_level, notes_enc, strengths_enc, weaknesses_enc, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [i.id, i.name, i.user_id ?? null, i.position ?? null, i.shirt_number ?? null, i.role ?? null, i.threat_level, i.notes_enc ?? null, i.strengths_enc ?? null, i.weaknesses_enc ?? null, user.id]
    );
  },
});

cap({
  name: 'update_key_player',
  method: 'PATCH',
  path: '/opponent-key-players/:id',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 200,
  summary: 'Update a key player threat level or notes',
  input: z.object({
    id,
    threat_level: z.enum(THREAT_LEVELS).optional(),
    notes_enc: z.string().optional(),
    strengths_enc: z.string().optional(),
    weaknesses_enc: z.string().optional(),
    position: z.string().trim().max(60).optional(),
    role: z.string().trim().max(80).optional(),
  }),
  async handler({ user }, i) {
    const kp = await one(`SELECT * FROM opponent_key_players WHERE id = $1 AND removed_at IS NULL`, [i.id]);
    if (!kp) throw notFound();
    await profileAccess(user, kp.profile_id);
    return one(
      `UPDATE opponent_key_players
       SET threat_level = COALESCE($2, threat_level),
           notes_enc = COALESCE($3, notes_enc),
           strengths_enc = COALESCE($4, strengths_enc),
           weaknesses_enc = COALESCE($5, weaknesses_enc),
           position = COALESCE($6, position),
           role = COALESCE($7, role),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.threat_level ?? null, i.notes_enc ?? null, i.strengths_enc ?? null, i.weaknesses_enc ?? null, i.position ?? null, i.role ?? null]
    );
  },
});

cap({
  name: 'remove_key_player',
  method: 'DELETE',
  path: '/opponent-key-players/:id',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 200,
  summary: 'Soft-remove a key player',
  input: z.object({ id }),
  async handler({ user }, i) {
    const kp = await one(`SELECT * FROM opponent_key_players WHERE id = $1 AND removed_at IS NULL`, [i.id]);
    if (!kp) throw notFound();
    await profileAccess(user, kp.profile_id);
    await one(`UPDATE opponent_key_players SET removed_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { removed: true };
  },
});

cap({
  name: 'add_set_piece',
  method: 'POST',
  path: '/opponent-analysis/:id/set-pieces',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 201,
  summary: 'Add a set piece scheme to an opponent profile',
  input: z.object({
    id,
    kind: z.enum(SET_PIECE_KINDS),
    side: z.enum(['left', 'right', 'central', 'both', 'n_a']).default('n_a'),
    pattern_notes_enc: z.string().optional(),
    counter_notes_enc: z.string().optional(),
    video_clip_id: id.optional(),
    danger_level: z.enum(THREAT_LEVELS).default('medium'),
  }),
  async handler({ user }, i) {
    await profileAccess(user, i.id);
    return one(
      `INSERT INTO opponent_set_pieces
         (profile_id, kind, side, pattern_notes_enc, counter_notes_enc, video_clip_id, danger_level, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [i.id, i.kind, i.side, i.pattern_notes_enc ?? null, i.counter_notes_enc ?? null, i.video_clip_id ?? null, i.danger_level, user.id]
    );
  },
});

cap({
  name: 'update_set_piece',
  method: 'PATCH',
  path: '/opponent-set-pieces/:id',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 200,
  summary: 'Update set piece notes and linked clip',
  input: z.object({
    id,
    pattern_notes_enc: z.string().optional(),
    counter_notes_enc: z.string().optional(),
    video_clip_id: id.optional(),
    danger_level: z.enum(THREAT_LEVELS).optional(),
  }),
  async handler({ user }, i) {
    const sp = await one(`SELECT * FROM opponent_set_pieces WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!sp) throw notFound();
    await profileAccess(user, sp.profile_id);
    return one(
      `UPDATE opponent_set_pieces
       SET pattern_notes_enc = COALESCE($2, pattern_notes_enc),
           counter_notes_enc = COALESCE($3, counter_notes_enc),
           video_clip_id = COALESCE($4, video_clip_id),
           danger_level = COALESCE($5, danger_level),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.pattern_notes_enc ?? null, i.counter_notes_enc ?? null, i.video_clip_id ?? null, i.danger_level ?? null]
    );
  },
});

cap({
  name: 'archive_set_piece',
  method: 'POST',
  path: '/opponent-set-pieces/:id/archive',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 200,
  summary: 'Soft-archive a set piece scheme',
  input: z.object({ id }),
  async handler({ user }, i) {
    const sp = await one(`SELECT * FROM opponent_set_pieces WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!sp) throw notFound();
    await profileAccess(user, sp.profile_id);
    await one(`UPDATE opponent_set_pieces SET archived_at = now() WHERE id = $1 RETURNING id`, [i.id]);
    return { archived: true };
  },
});

cap({
  name: 'create_opponent_playlist',
  method: 'POST',
  path: '/opponent-analysis/:id/playlists',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 201,
  summary: 'Create a curated video playlist for an opponent analysis profile',
  input: z.object({
    id,
    name: text(120),
    description: z.string().trim().max(300).optional(),
    clip_ids: z.array(id).max(100).default([]),
  }),
  async handler({ user }, i) {
    await profileAccess(user, i.id);
    return one(
      `INSERT INTO opponent_playlists (profile_id, name, description, clip_ids, created_by)
       VALUES ($1,$2,$3,$4::uuid[],$5) RETURNING *`,
      [i.id, i.name, i.description ?? null, i.clip_ids, user.id]
    );
  },
});

cap({
  name: 'update_opponent_playlist',
  method: 'PATCH',
  path: '/opponent-playlists/:id',
  tag: TAG,
  auth: ['coach', 'analyst'],
  status: 200,
  summary: 'Update an opponent playlist name, description or clip list',
  input: z.object({
    id,
    name: text(120).optional(),
    description: z.string().trim().max(300).optional(),
    clip_ids: z.array(id).max(100).optional(),
  }),
  async handler({ user }, i) {
    const pl = await one(`SELECT * FROM opponent_playlists WHERE id = $1 AND archived_at IS NULL`, [i.id]);
    if (!pl) throw notFound();
    await profileAccess(user, pl.profile_id);
    return one(
      `UPDATE opponent_playlists
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           clip_ids = COALESCE($4::uuid[], clip_ids),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [i.id, i.name ?? null, i.description ?? null, i.clip_ids ?? null]
    );
  },
});

cap({
  name: 'export_opponent_analysis',
  method: 'GET',
  path: '/opponent-analysis/:id/export',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Export full opponent analysis as structured data for PDF generation',
  input: z.object({ id }),
  async handler({ user }, i) {
    const profile = await profileAccess(user, i.id);
    const [games, keyPlayers, setPieces, playlists] = await Promise.all([
      many(`SELECT * FROM opponent_games WHERE profile_id = $1 ORDER BY match_date DESC`, [i.id]),
      many(`SELECT * FROM opponent_key_players WHERE profile_id = $1 AND removed_at IS NULL ORDER BY threat_level, name`, [i.id]),
      many(`SELECT * FROM opponent_set_pieces WHERE profile_id = $1 AND archived_at IS NULL ORDER BY kind`, [i.id]),
      many(`SELECT * FROM opponent_playlists WHERE profile_id = $1 AND archived_at IS NULL`, [i.id]),
    ]);
    return {
      profile,
      games,
      key_players: keyPlayers,
      set_pieces: setPieces,
      playlists,
      exported_at: new Date().toISOString(),
    };
  },
});
