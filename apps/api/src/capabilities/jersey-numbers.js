// Jersey numbers per scope: the same person can wear a different number for each team, event, game or tournament. The number on a sport
// profile or a team roster stays the default; a scoped number overrides it for that scope only. You set your own; the people who run a team
// set a member's number for that team, and an event's organiser sets it for the event or tournament.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { audit, isAdmin } from '../helpers.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { hasOrgGrant } from '../org-access.js';
import { canManageTeam } from './teams.js';

const TAG = 'Jersey numbers';
const SCOPES = ['team', 'event', 'game', 'tournament'];
const scope = { scope_kind: z.enum(SCOPES), scope_id: id };
const number = z.coerce.number().int().min(0).max(999);

/** The thing the number is for, or a 404. */
async function target(kind, scopeId) {
  const q = { team: ['SELECT id, name FROM teams WHERE id=$1'], event: ['SELECT id, name FROM events WHERE id=$1'], tournament: ["SELECT id, name FROM events WHERE id=$1 AND kind IN ('tournament','league')"],
    game: ["SELECT f.id, coalesce(f.round, 'Game') AS name FROM fixtures f WHERE f.id=$1"] }[kind];
  const row = await one(q[0], [scopeId]);
  if (!row) throw notFound(kind);
  return row;
}
/** Everyone may set their own; the people who run the team (or the event) may set another person's. */
async function mayManage(user, kind, scopeId) {
  if (isAdmin(user)) return true;
  if (kind === 'team') return canManageTeam(user, await one('SELECT * FROM teams WHERE id=$1', [scopeId]));
  const ev = kind === 'game' ? await one('SELECT e.* FROM events e JOIN fixtures f ON f.event_id=e.id WHERE f.id=$1', [scopeId]) : await one('SELECT * FROM events WHERE id=$1', [scopeId]);
  return !!ev && (ev.organizer_id === user.id || (await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'])));
}

cap({
  name: 'set_jersey_number', method: 'POST', path: '/jersey-numbers', status: 200, tag: TAG,
  summary: 'Set a jersey number for one team, event, game or tournament. Defaults to you; team managers and event organisers can set it for a member (the person must belong to that team or have an entry). For a team it also updates the roster number.',
  input: z.object({ ...scope, number, user_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const who = i.user_id ?? user.id;
    await target(i.scope_kind, i.scope_id);
    if (who !== user.id) {
      if (!(await mayManage(user, i.scope_kind, i.scope_id))) throw forbidden('Only the people who run this can set someone else\'s number');
      if (!(await one('SELECT 1 FROM users WHERE id=$1', [who]))) throw notFound('Person');
    }
    const row = (await c.query(
      `INSERT INTO jersey_numbers(user_id, scope_kind, scope_id, number, set_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, scope_kind, scope_id) DO UPDATE SET number=EXCLUDED.number, set_by=EXCLUDED.set_by, updated_at=now() RETURNING *`, [who, i.scope_kind, i.scope_id, i.number, user.id])).rows[0];
    if (i.scope_kind === 'team') await c.query('UPDATE team_members SET jersey_no=$3 WHERE team_id=$1 AND user_id=$2', [i.scope_id, who, i.number]);
    await audit(c, user.id, 'set_jersey_number', 'jersey_numbers', row.id);
    return row;
  }),
});

cap({
  name: 'list_jersey_numbers', method: 'GET', path: '/jersey-numbers', tag: TAG,
  summary: 'Your jersey numbers by team, event, game and tournament, with the name of each. With scope_kind and scope_id (team managers / event organisers) it lists everyone\'s number for that one scope.',
  input: z.object({ scope_kind: z.enum(SCOPES).optional(), scope_id: id.optional() }).refine((v) => !!v.scope_kind === !!v.scope_id, { message: 'Give scope_kind and scope_id together' }),
  async handler({ user }, i) {
    if (i.scope_kind) {
      await target(i.scope_kind, i.scope_id);
      if (!(await mayManage(user, i.scope_kind, i.scope_id))) throw forbidden('Only the people who run this can see everyone\'s numbers');
      return many('SELECT j.id, j.user_id, u.display_name, j.number, j.updated_at FROM jersey_numbers j JOIN users u ON u.id=j.user_id WHERE j.scope_kind=$1 AND j.scope_id=$2 ORDER BY j.number, u.display_name', [i.scope_kind, i.scope_id]);
    }
    return many(
      `SELECT j.id, j.scope_kind, j.scope_id, j.number, j.updated_at,
              CASE j.scope_kind WHEN 'team' THEN (SELECT name FROM teams WHERE id=j.scope_id) WHEN 'game' THEN (SELECT coalesce(e.name || ' · ' || f.round, e.name) FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=j.scope_id) ELSE (SELECT name FROM events WHERE id=j.scope_id) END AS scope_name
         FROM jersey_numbers j WHERE j.user_id=$1 ORDER BY j.scope_kind, j.updated_at DESC`, [user.id]);
  },
});

cap({
  name: 'resolve_jersey_number', method: 'GET', path: '/jersey-numbers/resolve', tag: TAG,
  summary: 'The number someone wears in a game: the game\'s own, else its event or tournament\'s, else their team\'s, else their sport profile default.',
  input: z.object({ user_id: id.optional(), game_id: id.optional(), event_id: id.optional(), team_id: id.optional() }),
  async handler({ user }, i) {
    const who = i.user_id ?? user.id;
    const g = i.game_id ? await one('SELECT id, event_id FROM fixtures WHERE id=$1', [i.game_id]) : null;
    if (i.game_id && !g) throw notFound('Game');
    const eventId = i.event_id ?? g?.event_id ?? null;
    const tries = [['game', i.game_id], ['event', eventId], ['tournament', eventId], ['team', i.team_id]].filter(([, s]) => s);
    if (!tries.length) throw badRequest('Give a game, event or team');
    for (const [kind, sid] of tries) {
      const r = await one('SELECT number FROM jersey_numbers WHERE user_id=$1 AND scope_kind=$2 AND scope_id=$3', [who, kind, sid]);
      if (r) return { number: r.number, source: kind };
    }
    if (i.team_id) { const m = await one('SELECT jersey_no FROM team_members WHERE team_id=$1 AND user_id=$2', [i.team_id, who]); if (m?.jersey_no != null) return { number: m.jersey_no, source: 'team_roster' }; }
    const p = await one('SELECT jersey_no FROM sport_profiles WHERE user_id=$1 AND jersey_no IS NOT NULL ORDER BY is_default DESC, created_at LIMIT 1', [who]);
    return p ? { number: p.jersey_no, source: 'sport_profile' } : { number: null, source: null };
  },
});
