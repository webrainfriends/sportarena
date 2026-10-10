import { query, one } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';

export const PUBLIC_USER = 'u.id, u.handle, u.display_name, u.roles, u.bio, u.avatar_emoji, u.avatar_color, u.avatar_url';

export const isAdmin = (user) => user?.roles?.includes('admin');
export const hasRole = (user, ...r) => isAdmin(user) || r.some((x) => user?.roles?.includes(x));

/** Record a read of decrypted personal/clinical data (who, what — never the values). */
export const audit = (client, actor, action, entity, entityId) =>
  (client ?? { query }).query('INSERT INTO audit_log(actor_id, action, entity, entity_id) VALUES ($1,$2,$3,$4)', [actor, action, entity, entityId ?? null]);

export async function mustFind(table, id, cols = '*', client) {
  const row = (await (client ?? { query }).query(`SELECT ${cols} FROM ${table} WHERE id = $1`, [id])).rows[0];
  if (!row) throw notFound(table.replace(/s$/, '').replace(/_/g, ' '));
  return row;
}

export function mustOwn(user, ownerId, what = 'resource') {
  if (!isAdmin(user) && user.id !== ownerId) throw forbidden(`Only the owner can change this ${what}`);
}

export const sportBySlugOrId = async (v) =>
  /^[0-9a-f-]{36}$/.test(v) ? one('SELECT * FROM sports WHERE id = $1', [v]) : one('SELECT * FROM sports WHERE slug = $1', [v]);

/** Standings for an event from completed fixtures, using the event's points rules. */
export async function standings(eventId, client) {
  const ev = await mustFind('events', eventId, '*', client);
  const { rows } = await (client ?? { query }).query(
    `WITH sides AS (
       SELECT home_team_id AS team_id, home_score AS gf, away_score AS ga FROM fixtures WHERE event_id=$1 AND status='completed' AND home_team_id IS NOT NULL AND coalesce(round_kind,'group')='group'
       UNION ALL
       SELECT away_team_id, away_score, home_score FROM fixtures WHERE event_id=$1 AND status='completed' AND away_team_id IS NOT NULL AND coalesce(round_kind,'group')='group')
     SELECT t.id AS team_id, t.name, t.emoji, t.color,
            count(s.team_id)::int AS played,
            count(*) FILTER (WHERE s.gf > s.ga)::int AS won,
            count(*) FILTER (WHERE s.gf = s.ga)::int AS drawn,
            count(*) FILTER (WHERE s.gf < s.ga)::int AS lost,
            coalesce(sum(s.gf),0)::int AS goals_for, coalesce(sum(s.ga),0)::int AS goals_against,
            (count(*) FILTER (WHERE s.gf > s.ga) * $2 + count(*) FILTER (WHERE s.gf = s.ga) * $3 + count(*) FILTER (WHERE s.gf < s.ga) * $4)::int AS points
       FROM event_entries e JOIN teams t ON t.id = e.team_id LEFT JOIN sides s ON s.team_id = t.id
      WHERE e.event_id = $1 AND e.status = 'accepted'
      GROUP BY t.id ORDER BY points DESC, (coalesce(sum(s.gf),0) - coalesce(sum(s.ga),0)) DESC, coalesce(sum(s.gf),0) DESC, t.name`,
    [eventId, ev.points_win, ev.points_draw, ev.points_loss],
  );
  return rows.map((r, i) => ({ rank: i + 1, ...r, goal_diff: r.goals_for - r.goals_against }));
}

/** Build a partial UPDATE from the allowed input keys that were actually sent. Returns the updated row, or throws if nothing was sent. */
export async function patchRow(table, id, input, allowed, client) {
  const keys = allowed.filter((k) => input[k] !== undefined);
  if (!keys.length) throw badRequest('Nothing to update');
  const row = (await (client ?? { query }).query(`UPDATE ${table} SET ${keys.map((k, n) => `${k}=$${n + 2}`).join(', ')} WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => input[k])])).rows[0];
  if (!row) throw notFound(table.replace(/s$/, '').replace(/_/g, ' '));
  return row;
}
