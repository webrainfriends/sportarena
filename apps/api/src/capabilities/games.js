import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { MANAGER_ROLES, roles as roleDefs, vocabularies } from '../ontology/iptc.js';
import { validateAttributes, mergeAttributes } from '../ontology/fields.js';
import { gameToJsonLd } from '../ontology/jsonld.js';
import { canManageTeam } from './teams.js';
import { NOT_YOUTH_SQL } from '../youth.js';

const dt = z.string().datetime({ offset: true });
const attrs = z.record(z.string(), z.any());
const term = (v) => z.enum(vocabularies[v].terms);

/** Load whatever an association points at. Games/events/venues/teams all resolve to a row with its sport (if any). */
export async function loadTarget(type, targetId) {
  const row = await one(
    { game: 'SELECT * FROM games WHERE id=$1', team: 'SELECT * FROM teams WHERE id=$1', event: 'SELECT * FROM events WHERE id=$1', venue: 'SELECT * FROM venues WHERE id=$1' }[type], [targetId]);
  if (!row) throw notFound(type);
  return row;
}

export async function canManageGame(user, game) {
  if (isAdmin(user) || game.created_by === user.id) return true;
  if (await one("SELECT 1 FROM associations WHERE target_type='game' AND target_id=$1 AND user_id=$2 AND status='active' AND role = ANY($3)", [game.id, user.id, MANAGER_ROLES])) return true;
  if (game.competition_id) return !!(await one('SELECT 1 FROM events WHERE id=$1 AND organizer_id=$2', [game.competition_id, user.id]));
  return false;
}

/** Can `user` edit the thing an association points at? */
export async function canManageTarget(user, type, row) {
  if (isAdmin(user)) return true;
  if (type === 'game') return canManageGame(user, row);
  if (type === 'team') return canManageTeam(user, row);
  if (type === 'event') return row.organizer_id === user.id;
  return row.owner_id === user.id; // venue
}

const sportOf = (id_) => one('SELECT * FROM sports WHERE id=$1', [id_]);

async function loadGame(gameId) {
  const g = await one('SELECT g.*, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji FROM games g JOIN sports s ON s.id=g.sport_id WHERE g.id=$1', [gameId]);
  if (!g) throw notFound('Game');
  return g;
}
const participantsOf = (gameId) => many(
  `SELECT p.*, t.name AS team_name, t.emoji AS team_emoji, t.color AS team_color, u.handle, u.display_name AS person_name
     FROM game_participants p LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN users u ON u.id=p.user_id
    WHERE p.game_id=$1 AND (u.id IS NULL OR ${NOT_YOUTH_SQL}) ORDER BY p.side NULLS LAST, p.created_at`, [gameId]);
const peopleOf = (gameId) => many(
  `SELECT a.id AS association_id, a.role, a.position, a.uniform_no, a.player_status, a.attributes, a.user_id, ${PUBLIC_USER}
     FROM associations a JOIN users u ON u.id=a.user_id WHERE a.target_type='game' AND a.target_id=$1 AND a.status='active' AND ${NOT_YOUTH_SQL} ORDER BY a.role, u.display_name`, [gameId]);
const actionsOf = (gameId) => many('SELECT * FROM game_actions WHERE game_id=$1 ORDER BY minute NULLS LAST, created_at LIMIT 1000', [gameId]);

async function checkParticipant(c, game, p) {
  if (p.team_id) {
    const t = await c.query('SELECT sport_id FROM teams WHERE id=$1', [p.team_id]);
    if (!t.rows[0]) throw notFound('Team');
    if (t.rows[0].sport_id !== game.sport_id) throw badRequest('Team plays a different sport than this game');
  } else {
    const u = await c.query('SELECT 1 FROM users WHERE id=$1', [p.user_id]);
    if (!u.rows[0]) throw notFound('Person');
  }
}
const participantInput = z.object({ team_id: id.optional(), user_id: id.optional(), side: term('side').optional() })
  .refine((p) => !!p.team_id !== !!p.user_id, 'Give exactly one of team_id or user_id');
async function insertParticipant(c, game, sport, p, stats = {}) {
  await checkParticipant(c, game, p);
  const clean = await validateAttributes(sport, 'participant', stats);
  return (await c.query('INSERT INTO game_participants(game_id, team_id, user_id, side, stats) VALUES ($1,$2,$3,$4,$5) RETURNING *', [game.id, p.team_id ?? null, p.user_id ?? null, p.side ?? null, clean])).rows[0];
}

cap({
  name: 'create_game', method: 'POST', path: '/games', tag: 'Games', status: 201,
  summary: 'Add a game (match, race, session) for any sport. Any signed-in user can; you become its organizer. `attributes` use the keys from get_game_fields (scope game). Optionally attach it to a competition you organize, a venue/court, and the competing teams or athletes.',
  input: z.object({
    sport: z.string(), title: z.string().min(2).max(120), starts_at: dt, ends_at: dt.optional(), status: term('eventStatus').default('pre-event'),
    competition_id: id.optional().describe('an event you organize'), venue_id: id.optional(), resource_id: id.optional(), location: z.string().max(200).optional(),
    participants: z.array(participantInput).max(64).default([]), attributes: attrs.default({}),
  }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    if (i.ends_at && Date.parse(i.ends_at) < Date.parse(i.starts_at)) throw badRequest('ends_at is before starts_at');
    if (i.competition_id) {
      const ev = await mustFind('events', i.competition_id);
      if (ev.sport_id !== sport.id) throw badRequest('The competition is for a different sport');
      if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('Only the competition organizer can add games to it');
    }
    let venueId = i.venue_id ?? null;
    if (i.resource_id) {
      const r = await mustFind('resources', i.resource_id);
      if (venueId && venueId !== r.venue_id) throw badRequest('resource_id is not part of venue_id');
      venueId = r.venue_id;
    } else if (venueId) await mustFind('venues', venueId, 'id');
    const sides = i.participants.map((p) => `${p.team_id ?? ''}/${p.user_id ?? ''}`);
    if (new Set(sides).size !== sides.length) throw badRequest('A participant is listed twice');
    const attributes = await validateAttributes(sport, 'game', i.attributes);
    const gameId = await tx(async (c) => {
      const g = (await c.query('INSERT INTO games(sport_id, created_by, title, status, competition_id, venue_id, resource_id, location, starts_at, ends_at, attributes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [sport.id, user.id, i.title, i.status, i.competition_id ?? null, venueId, i.resource_id ?? null, i.location ?? null, i.starts_at, i.ends_at ?? null, attributes])).rows[0];
      for (const p of i.participants) await insertParticipant(c, g, sport, p);
      await c.query("INSERT INTO associations(user_id, role, target_type, target_id, status, started_at) VALUES ($1,'organizer','game',$2,'active',now())", [user.id, g.id]);
      return g.id;
    });
    return getGameDetail(gameId);
  },
});

async function getGameDetail(gameId) {
  const [game, participants, people, actions] = await Promise.all([loadGame(gameId), participantsOf(gameId), peopleOf(gameId), actionsOf(gameId)]);
  return { ...game, participants, people, actions };
}

cap({
  name: 'list_games', method: 'GET', path: '/games', tag: 'Games', auth: 'public',
  summary: 'Browse games. Filter by sport, status, competition, team, person (playing or associated), date range, or `mine`.',
  input: z.object({ sport: z.string().optional(), status: term('eventStatus').optional(), competition_id: id.optional(), team_id: id.optional(), user_id: id.optional(), from: dt.optional(), to: dt.optional(), q: z.string().max(80).optional(), mine: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const who = i.mine && user ? user.id : i.user_id ?? null;
    return many(
      `SELECT g.id, g.title, g.status, g.starts_at, g.ends_at, g.location, g.competition_id, g.venue_id, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji,
              (SELECT coalesce(json_agg(json_build_object('side', p.side, 'team_id', p.team_id, 'user_id', p.user_id, 'name', coalesce(t.name, u.display_name), 'score', p.score, 'outcome', p.outcome) ORDER BY p.side NULLS LAST), '[]'::json)
                 FROM game_participants p LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN users u ON u.id=p.user_id WHERE p.game_id=g.id) AS participants
         FROM games g JOIN sports s ON s.id=g.sport_id
        WHERE ($1::uuid IS NULL OR g.sport_id=$1) AND ($2::text IS NULL OR g.status=$2) AND ($3::uuid IS NULL OR g.competition_id=$3)
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM game_participants p WHERE p.game_id=g.id AND p.team_id=$4))
          AND ($5::uuid IS NULL OR g.created_by=$5 OR EXISTS (SELECT 1 FROM game_participants p WHERE p.game_id=g.id AND p.user_id=$5)
               OR EXISTS (SELECT 1 FROM associations a WHERE a.target_type='game' AND a.target_id=g.id AND a.user_id=$5 AND a.status='active')
               OR EXISTS (SELECT 1 FROM game_participants p JOIN team_members m ON m.team_id=p.team_id AND m.status='active' WHERE p.game_id=g.id AND m.user_id=$5))
          AND ($6::timestamptz IS NULL OR g.starts_at >= $6) AND ($7::timestamptz IS NULL OR g.starts_at <= $7)
          AND ($8::text IS NULL OR g.title ILIKE '%'||$8||'%')
        ORDER BY g.starts_at DESC LIMIT $9 OFFSET $10`,
      [sport?.id ?? null, i.status ?? null, i.competition_id ?? null, i.team_id ?? null, who, i.from ?? null, i.to ?? null, i.q ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_game', method: 'GET', path: '/games/:id', tag: 'Games', auth: 'public',
  summary: 'A game with its competitors/results, the people associated with it (players, coaches, referees…) and its action log.', input: z.object({ id }),
  async handler(_, i) { return getGameDetail(i.id); },
});

cap({
  name: 'get_game_jsonld', method: 'GET', path: '/games/:id/jsonld', tag: 'Ontology', auth: 'public',
  summary: 'The game as a JSON-LD graph in the IPTC Sport Schema vocabulary (Event, Participation, Athlete/Official/Associate, Action). Public identity only.', input: z.object({ id }),
  async handler(_, i) {
    const game = await loadGame(i.id);
    const [participants, people, actions] = await Promise.all([participantsOf(i.id), peopleOf(i.id), actionsOf(i.id)]);
    return gameToJsonLd(game, { participants: participants.map((p) => ({ ...p, person_name: p.person_name })), people, actions });
  },
});

cap({
  name: 'update_game', method: 'PATCH', path: '/games/:id', tag: 'Games',
  summary: 'Edit a game (organizer/manager, competition organizer, or admin). `attributes` are merged; send a key as null to clear it.',
  input: z.object({ id, title: z.string().min(2).max(120).optional(), status: term('eventStatus').optional(), starts_at: dt.optional(), ends_at: dt.nullable().optional(), venue_id: id.nullable().optional(), resource_id: id.nullable().optional(), location: z.string().max(200).nullable().optional(), attributes: attrs.optional() }),
  async handler({ user }, i) {
    const g = await mustFind('games', i.id);
    if (!(await canManageGame(user, g))) throw forbidden('Only a game organizer can edit it');
    let attributes = g.attributes;
    if (i.attributes) attributes = mergeAttributes(g.attributes, i.attributes, await validateAttributes(await sportOf(g.sport_id), 'game', i.attributes, { partial: true }));
    let { venue_id: venueId, resource_id: resourceId } = { venue_id: i.venue_id === undefined ? g.venue_id : i.venue_id, resource_id: i.resource_id === undefined ? g.resource_id : i.resource_id };
    if (resourceId) {
      const r = await mustFind('resources', resourceId);
      if (i.venue_id && i.venue_id !== r.venue_id) throw badRequest('resource_id is not part of venue_id');
      venueId = r.venue_id;
    } else if (venueId) await mustFind('venues', venueId, 'id');
    const starts = i.starts_at ?? g.starts_at, ends = i.ends_at === undefined ? g.ends_at : i.ends_at;
    if (ends && Date.parse(ends) < Date.parse(starts)) throw badRequest('ends_at is before starts_at');
    await query('UPDATE games SET title=$2, status=$3, starts_at=$4, ends_at=$5, venue_id=$6, resource_id=$7, location=$8, attributes=$9, updated_at=now() WHERE id=$1',
      [g.id, i.title ?? g.title, i.status ?? g.status, starts, ends, venueId, resourceId, i.location === undefined ? g.location : i.location, attributes]);
    return getGameDetail(g.id);
  },
});

cap({
  name: 'add_game_participant', method: 'POST', path: '/games/:id/participants', tag: 'Games', status: 201,
  summary: 'Add a competing team or athlete to a game (game manager).',
  input: z.object({ id, team_id: id.optional(), user_id: id.optional(), side: term('side').optional(), stats: attrs.default({}) }),
  async handler({ user }, i) {
    const g = await mustFind('games', i.id);
    if (!(await canManageGame(user, g))) throw forbidden();
    const p = participantInput.parse({ team_id: i.team_id, user_id: i.user_id, side: i.side });
    const sport = await sportOf(g.sport_id);
    return tx((c) => insertParticipant(c, g, sport, p, i.stats));
  },
});

cap({
  name: 'update_game_participant', method: 'PATCH', path: '/games/:id/participants/:participant_id', tag: 'Games',
  summary: 'Record a competitor\'s result: outcome, score, rank and sport-specific stats (keys from get_game_fields, scope participant). Game manager, or an active referee/scorer of the game.',
  input: z.object({ id, participant_id: id, side: term('side').nullable().optional(), outcome: term('eventOutcome').nullable().optional(), outcome_type: term('eventOutcomeType').nullable().optional(), score: z.number().nullable().optional(), score_units: term('scoreUnits').nullable().optional(), rank: z.number().int().min(1).nullable().optional(), stats: attrs.optional() }),
  async handler({ user }, i) {
    const g = await mustFind('games', i.id);
    if (!(await canManageGame(user, g)) && !(await isGameOfficial(user, g.id))) throw forbidden('Only organizers, referees or scorers can record results');
    const p = await one('SELECT * FROM game_participants WHERE id=$1 AND game_id=$2', [i.participant_id, g.id]);
    if (!p) throw notFound('Participant');
    let stats = p.stats;
    if (i.stats) stats = mergeAttributes(p.stats, i.stats, await validateAttributes(await sportOf(g.sport_id), 'participant', i.stats, { partial: true }));
    const pick = (k) => (i[k] === undefined ? p[k] : i[k]);
    return one('UPDATE game_participants SET side=$2, outcome=$3, outcome_type=$4, score=$5, score_units=$6, rank=$7, stats=$8 WHERE id=$1 RETURNING *',
      [p.id, pick('side'), pick('outcome'), pick('outcome_type'), pick('score'), pick('score_units'), pick('rank'), stats]);
  },
});

cap({
  name: 'remove_game_participant', method: 'DELETE', path: '/games/:id/participants/:participant_id', tag: 'Games',
  summary: 'Remove a competitor from a game (game manager).', input: z.object({ id, participant_id: id }),
  async handler({ user }, i) {
    const g = await mustFind('games', i.id);
    if (!(await canManageGame(user, g))) throw forbidden();
    const r = await query('DELETE FROM game_participants WHERE id=$1 AND game_id=$2', [i.participant_id, g.id]);
    if (!r.rowCount) throw notFound('Participant');
    return { ok: true };
  },
});

const isGameOfficial = async (user, gameId) =>
  !!(await one("SELECT 1 FROM associations WHERE target_type='game' AND target_id=$1 AND user_id=$2 AND status='active' AND role IN ('referee','umpire','linesman','scorer')", [gameId, user.id]));

cap({
  name: 'log_game_action', method: 'POST', path: '/games/:id/actions', tag: 'Games', status: 201,
  summary: 'Log something that happened in a game (goal, substitution, card, timeout…). Game manager or an active referee/umpire/scorer. `team_id`/`user_id` must be part of the game.',
  input: z.object({ id, action_class: term('actionClass'), action_type: z.string().min(1).max(60).describe('e.g. goal, yellow_card, wicket, try, ace'), minute: z.number().min(0).max(600).optional(), period: z.number().int().min(0).max(20).optional(), team_id: id.optional(), user_id: id.optional(), attributes: attrs.default({}) }),
  async handler({ user }, i) {
    const g = await mustFind('games', i.id);
    if (!(await canManageGame(user, g)) && !(await isGameOfficial(user, g.id))) throw forbidden('Only organizers, referees or scorers can log actions');
    if (i.team_id && !(await one('SELECT 1 FROM game_participants WHERE game_id=$1 AND team_id=$2', [g.id, i.team_id]))) throw badRequest('team_id is not a participant of this game');
    if (i.user_id && !(await one(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM game_participants WHERE game_id=$1 AND user_id=$2)
          OR EXISTS (SELECT 1 FROM associations WHERE target_type='game' AND target_id=$1 AND user_id=$2 AND status='active')
          OR EXISTS (SELECT 1 FROM game_participants p JOIN team_members m ON m.team_id=p.team_id AND m.status='active' WHERE p.game_id=$1 AND m.user_id=$2)`, [g.id, i.user_id]))) throw badRequest('user_id is not part of this game');
    return one('INSERT INTO game_actions(game_id, action_class, action_type, minute, period, user_id, team_id, attributes, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [g.id, i.action_class, i.action_type, i.minute ?? null, i.period ?? null, i.user_id ?? null, i.team_id ?? null, i.attributes, user.id]);
  },
});

cap({
  name: 'delete_game', method: 'DELETE', path: '/games/:id', tag: 'Games',
  summary: 'Delete a game with its competitors, associations and action log (creator or admin).', input: z.object({ id }),
  async handler({ user }, i) {
    const g = await mustFind('games', i.id);
    if (!isAdmin(user) && g.created_by !== user.id) throw forbidden('Only the creator can delete a game');
    await tx(async (c) => {
      await c.query("DELETE FROM associations WHERE target_type='game' AND target_id=$1", [g.id]);
      await c.query('DELETE FROM games WHERE id=$1', [g.id]);
    });
    return { ok: true };
  },
});
