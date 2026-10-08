import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { NOT_YOUTH_SQL } from '../youth.js';

cap({
  name: 'record_performance', method: 'POST', path: '/performances', tag: 'Scores & Awards', status: 201,
  summary: 'Record an individual score/stat. Allowed for: the event organiser, the fixture referee, or the athlete themselves for practice (no event/fixture).',
  input: z.object({ user_id: id.optional().describe('defaults to you'), sport: z.string(), metric: z.string().min(1).max(40), value: z.number(), points: z.number().default(0), event_id: id.optional(), fixture_id: id.optional() }),
  async handler({ user }, i) {
    const target = i.user_id ?? user.id;
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    let allowed = isAdmin(user) || (target === user.id && !i.event_id && !i.fixture_id);
    let eventId = i.event_id;
    if (i.fixture_id) {
      const f = await mustFind('fixtures', i.fixture_id);
      eventId = f.event_id;
      allowed ||= f.referee_id === user.id;
    }
    if (eventId) {
      const ev = await mustFind('events', eventId);
      allowed ||= ev.organizer_id === user.id;
    }
    if (!allowed) throw forbidden('You cannot record scores for this athlete here');
    await mustFind('users', target, 'id');
    return one('INSERT INTO performances(user_id, sport_id, event_id, fixture_id, metric, value, points, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [target, sport.id, eventId ?? null, i.fixture_id ?? null, i.metric, i.value, i.points, user.id]);
  },
});

cap({
  name: 'get_athlete_stats', method: 'GET', path: '/people/:id/stats', tag: 'Scores & Awards', auth: 'public',
  summary: 'Aggregated stats per sport & metric: count, total, best (max), lowest (min — use for time metrics), points.', input: z.object({ id, sport: z.string().optional() }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const rows = await many(
      `SELECT s.slug AS sport, s.emoji, p.metric, count(*)::int AS entries, sum(p.value) AS total, max(p.value) AS best, min(p.value) AS lowest, sum(p.points) AS points
         FROM performances p JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND ($2::uuid IS NULL OR p.sport_id=$2) GROUP BY s.slug, s.emoji, p.metric ORDER BY s.slug, p.metric`, [i.id, sport?.id ?? null]);
    const total = await one('SELECT coalesce(sum(points),0) AS points FROM performances WHERE user_id=$1', [i.id]);
    return { total_points: total.points, by_metric: rows };
  },
});

cap({
  name: 'leaderboard', method: 'GET', path: '/leaderboard', tag: 'Scores & Awards', auth: 'public',
  summary: 'Top athletes by points for a sport, optionally within one event or metric.',
  input: z.object({ sport: z.string().optional(), event_id: id.optional(), metric: z.string().optional(), ...page }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    const rows = await many(
      `SELECT ${PUBLIC_USER}, sum(p.points) AS points, sum(p.value) AS total, count(*)::int AS entries
         FROM performances p JOIN users u ON u.id=p.user_id
        WHERE ${NOT_YOUTH_SQL} AND ($1::uuid IS NULL OR p.sport_id=$1) AND ($2::uuid IS NULL OR p.event_id=$2) AND ($3::text IS NULL OR p.metric=$3)
        GROUP BY u.id ORDER BY points DESC, total DESC LIMIT $4 OFFSET $5`, [sport?.id ?? null, i.event_id ?? null, i.metric ?? null, i.limit, i.offset]);
    return rows.map((r, n) => ({ rank: i.offset + n + 1, ...r }));
  },
});

cap({
  name: 'grant_award', method: 'POST', path: '/awards', tag: 'Scores & Awards', status: 201,
  summary: 'Give a cup, trophy, medal, MVP or badge to an athlete or team (event organiser, or admin for non-event awards).',
  input: z.object({ name: z.string().min(2).max(100), kind: z.enum(['cup', 'trophy', 'medal_gold', 'medal_silver', 'medal_bronze', 'mvp', 'badge']), event_id: id.optional(), user_id: id.optional(), team_id: id.optional(), note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    if (!i.user_id && !i.team_id) throw forbidden('Specify user_id or team_id');
    if (i.event_id) {
      const ev = await mustFind('events', i.event_id);
      if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('Only the event organiser can grant awards');
    } else if (!isAdmin(user)) throw forbidden('Awards outside an event are admin-only');
    return one('INSERT INTO awards(name, kind, event_id, user_id, team_id, note, awarded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.name, i.kind, i.event_id ?? null, i.user_id ?? null, i.team_id ?? null, i.note, user.id]);
  },
});

cap({
  name: 'list_awards', method: 'GET', path: '/awards', tag: 'Scores & Awards', auth: 'public', summary: 'Trophy cabinet for an athlete, team or event.',
  input: z.object({ user_id: id.optional(), team_id: id.optional(), event_id: id.optional(), ...page }),
  handler: (_, i) => many(
    `SELECT a.*, e.name AS event_name, t.name AS team_name, u.display_name FROM awards a LEFT JOIN events e ON e.id=a.event_id LEFT JOIN teams t ON t.id=a.team_id LEFT JOIN users u ON u.id=a.user_id
      WHERE ($1::uuid IS NULL OR a.user_id=$1) AND ($2::uuid IS NULL OR a.team_id=$2) AND ($3::uuid IS NULL OR a.event_id=$3) ORDER BY a.awarded_at DESC LIMIT $4 OFFSET $5`,
    [i.user_id ?? null, i.team_id ?? null, i.event_id ?? null, i.limit, i.offset]),
});
