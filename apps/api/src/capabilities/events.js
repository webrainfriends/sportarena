import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hasRole, isAdmin, mustFind, mustOwn, sportBySlugOrId, standings } from '../helpers.js';
import { canManageTeam } from './teams.js';
import { reserve } from './venues.js';

const dt = z.string().datetime({ offset: true });
const date = z.string().date();

async function eventForOrganizer(user, eventId, c) {
  const ev = await mustFind('events', eventId, '*', c);
  mustOwn(user, ev.organizer_id, 'event');
  return ev;
}

cap({
  name: 'create_event', method: 'POST', path: '/events', tag: 'Events', auth: ['organizer'], status: 201,
  summary: 'Create a tournament, league, friendly, camp or trial. Points rules drive the standings.',
  input: z.object({
    name: z.string().min(2).max(100), sport: z.string(), kind: z.enum(['tournament', 'league', 'friendly', 'camp', 'trial']).default('tournament'),
    description: z.string().max(2000).optional(), venue_id: id.optional(), starts_on: date.optional(), ends_on: date.optional(),
    points_win: z.number().int().default(3), points_draw: z.number().int().default(1), points_loss: z.number().int().default(0),
    entry_fee_cents: money.default(0), banner_emoji: z.string().max(8).optional(),
  }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
    return one(
      `INSERT INTO events(name, sport_id, organizer_id, kind, description, venue_id, starts_on, ends_on, points_win, points_draw, points_loss, entry_fee_cents, banner_emoji, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13,'🏆'),'open') RETURNING *`,
      [i.name, sport.id, user.id, i.kind, i.description, i.venue_id, i.starts_on, i.ends_on, i.points_win, i.points_draw, i.points_loss, i.entry_fee_cents, i.banner_emoji]);
  },
});

cap({
  name: 'list_events', method: 'GET', path: '/events', tag: 'Events', auth: 'public', summary: 'Discover events.',
  input: z.object({ sport: z.string().optional(), status: z.enum(['draft', 'open', 'ongoing', 'completed', 'cancelled']).optional(), q: z.string().optional(), organizer_id: id.optional(), ...page }),
  async handler(_, i) {
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    return many(
      `SELECT e.*, s.name AS sport, s.emoji AS sport_emoji, (SELECT count(*)::int FROM event_entries n WHERE n.event_id=e.id AND n.status='accepted') AS entrants
         FROM events e JOIN sports s ON s.id=e.sport_id
        WHERE ($1::uuid IS NULL OR e.sport_id=$1) AND ($2::text IS NULL OR e.status=$2) AND ($3::text IS NULL OR e.name ILIKE '%'||$3||'%')
          AND ($4::uuid IS NULL OR e.organizer_id=$4) AND e.status <> 'draft'
        ORDER BY e.starts_on NULLS LAST, e.created_at DESC LIMIT $5 OFFSET $6`,
      [sport?.id ?? null, i.status ?? null, i.q ?? null, i.organizer_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_event', method: 'GET', path: '/events/:id', tag: 'Events', auth: 'public',
  summary: 'Event page: details, entrants, standings, sponsors, rating.', input: z.object({ id }),
  async handler(_, i) {
    const ev = await one('SELECT e.*, s.name AS sport, s.emoji AS sport_emoji FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [i.id]);
    if (!ev) throw notFound('Event');
    const [entrants, table, sponsors, rating, venue] = await Promise.all([
      many(`SELECT e.id AS entry_id, t.id AS team_id, t.name, t.emoji, t.color, u.id AS user_id, u.handle, u.display_name FROM event_entries e LEFT JOIN teams t ON t.id=e.team_id LEFT JOIN users u ON u.id=e.user_id WHERE e.event_id=$1 AND e.status='accepted'`, [i.id]),
      standings(i.id),
      many("SELECT sp.id, sp.name, sp.emoji, ss.in_kind FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ss.target_type='event' AND ss.target_id=$1 AND ss.status='active'", [i.id]),
      one("SELECT round(avg(rating),2) AS avg, count(*)::int AS n FROM testimonials WHERE subject_type='event' AND subject_id=$1", [i.id]),
      ev.venue_id ? one('SELECT id, name, city, emoji FROM venues WHERE id=$1', [ev.venue_id]) : null,
    ]);
    return { ...ev, venue, entrants, standings: table, sponsors, rating };
  },
});

cap({
  name: 'update_event', method: 'PATCH', path: '/events/:id', tag: 'Events', summary: 'Edit an event you organise (including status transitions).',
  input: z.object({ id, name: z.string().min(2).max(100).optional(), description: z.string().max(2000).optional(), status: z.enum(['open', 'ongoing', 'cancelled']).optional(), starts_on: date.optional(), ends_on: date.optional(), venue_id: id.optional() }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    return one('UPDATE events SET name=coalesce($2,name), description=coalesce($3,description), status=coalesce($4,status), starts_on=coalesce($5,starts_on), ends_on=coalesce($6,ends_on), venue_id=coalesce($7,venue_id) WHERE id=$1 RETURNING *', [i.id, i.name, i.description, i.status, i.starts_on, i.ends_on, i.venue_id]);
  },
});

cap({
  name: 'enter_event', method: 'POST', path: '/events/:id/entries', tag: 'Events', status: 201,
  summary: 'Register a team you manage (team_id) or yourself (omit team_id) for an event.',
  input: z.object({ id, team_id: id.optional() }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    if (ev.status !== 'open') throw conflict('Event is not open for registration');
    if (i.team_id) {
      const t = await mustFind('teams', i.team_id);
      if (t.sport_id !== ev.sport_id) throw badRequest('Team plays a different sport');
      if (!(await canManageTeam(user, t))) throw forbidden('You do not manage that team');
    }
    try {
      return await one('INSERT INTO event_entries(event_id, team_id, user_id) VALUES ($1,$2,$3) RETURNING *', [i.id, i.team_id ?? null, i.team_id ? null : user.id]);
    } catch (e) {
      if (e.code === '23505') throw conflict('Already registered');
      throw e;
    }
  },
});

cap({
  name: 'list_entries', method: 'GET', path: '/events/:id/entries', tag: 'Events', summary: 'Registrations for an event you organise.', input: z.object({ id, status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn']).optional() }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    return many(`SELECT e.*, t.name AS team_name, u.display_name FROM event_entries e LEFT JOIN teams t ON t.id=e.team_id LEFT JOIN users u ON u.id=e.user_id WHERE e.event_id=$1 AND ($2::text IS NULL OR e.status=$2) ORDER BY e.created_at`, [i.id, i.status ?? null]);
  },
});

cap({
  name: 'decide_entry', method: 'PATCH', path: '/entries/:id', tag: 'Events', summary: 'Accept or reject a registration (event organiser).',
  input: z.object({ id, status: z.enum(['accepted', 'rejected']) }),
  async handler({ user }, i) {
    const e = await mustFind('event_entries', i.id);
    await eventForOrganizer(user, e.event_id);
    return one('UPDATE event_entries SET status=$2 WHERE id=$1 RETURNING *', [i.id, i.status]);
  },
});

cap({
  name: 'create_fixture', method: 'POST', path: '/events/:id/fixtures', tag: 'Schedule', status: 201,
  summary: 'Schedule a game. If resource_id is given the court/ground is booked atomically; referee clashes are rejected.',
  input: z.object({ id, home_team_id: id, away_team_id: id, scheduled_at: dt, duration_min: z.number().int().min(10).max(600).default(90), round: z.string().max(40).optional(), resource_id: id.optional(), referee_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      if (i.home_team_id === i.away_team_id) throw badRequest('A team cannot play itself');
      const ok = await c.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status='accepted' AND team_id = ANY($2)", [i.id, [i.home_team_id, i.away_team_id]]);
      if (ok.rows[0].n !== 2) throw badRequest('Both teams must be accepted entrants of this event');
      const end = new Date(new Date(i.scheduled_at).getTime() + i.duration_min * 60000).toISOString();
      for (const team of [i.home_team_id, i.away_team_id]) {
        const clash = await c.query("SELECT 1 FROM fixtures WHERE status IN ('scheduled','live') AND (home_team_id=$1 OR away_team_id=$1) AND scheduled_at < $3 AND scheduled_at + interval '90 minutes' > $2", [team, i.scheduled_at, end]);
        if (clash.rowCount) throw conflict('A team already has a game in that window');
      }
      if (i.referee_id) {
        const ref = await c.query("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role='referee' AND sport_id=$2", [i.referee_id, ev.sport_id]);
        if (!ref.rowCount) throw badRequest('That person is not a referee for this sport');
        const clash = await c.query("SELECT 1 FROM fixtures WHERE referee_id=$1 AND status IN ('scheduled','live') AND scheduled_at < $3 AND scheduled_at + interval '90 minutes' > $2", [i.referee_id, i.scheduled_at, end]);
        if (clash.rowCount) throw conflict('Referee already has a game in that window');
      }
      if (i.resource_id) await reserve(c, { resource_id: i.resource_id, user_id: user.id, event_id: i.id, starts_at: i.scheduled_at, ends_at: end, note: `Fixture ${i.round ?? ''}`.trim() });
      return (await c.query(
        'INSERT INTO fixtures(event_id, round, home_team_id, away_team_id, resource_id, referee_id, scheduled_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [i.id, i.round ?? null, i.home_team_id, i.away_team_id, i.resource_id ?? null, i.referee_id ?? null, i.scheduled_at])).rows[0];
    });
  },
});

cap({
  name: 'generate_round_robin', method: 'POST', path: '/events/:id/schedule/round-robin', tag: 'Schedule', status: 201,
  summary: 'Auto-generate a single round-robin schedule for all accepted teams (circle method), one round per interval.',
  input: z.object({ id, first_round_at: dt, interval_days: z.number().int().min(1).max(30).default(7) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await eventForOrganizer(user, i.id, c);
      if ((await c.query('SELECT 1 FROM fixtures WHERE event_id=$1 LIMIT 1', [i.id])).rowCount) throw conflict('Event already has fixtures');
      const teams = (await c.query("SELECT team_id FROM event_entries WHERE event_id=$1 AND status='accepted' AND team_id IS NOT NULL ORDER BY created_at", [i.id])).rows.map((r) => r.team_id);
      if (teams.length < 2) throw badRequest('Need at least 2 accepted teams');
      const slots = teams.length % 2 ? [...teams, null] : [...teams];
      const n = slots.length, out = [];
      for (let r = 0; r < n - 1; r++) {
        const when = new Date(new Date(i.first_round_at).getTime() + r * i.interval_days * 864e5).toISOString();
        for (let k = 0; k < n / 2; k++) {
          const a = slots[k], b = slots[n - 1 - k];
          if (a && b) out.push((await c.query('INSERT INTO fixtures(event_id, round, home_team_id, away_team_id, scheduled_at) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.id, `Round ${r + 1}`, r % 2 ? b : a, r % 2 ? a : b, when])).rows[0]);
        }
        slots.splice(1, 0, slots.pop()); // rotate all but the first slot
      }
      return { created: out.length, fixtures: out };
    });
  },
});

cap({
  name: 'list_fixtures', method: 'GET', path: '/fixtures', tag: 'Schedule', auth: 'public', summary: 'Game schedule and results, filterable by event, team, referee or date.',
  input: z.object({ event_id: id.optional(), team_id: id.optional(), referee_id: id.optional(), from: dt.optional(), to: dt.optional(), status: z.enum(['scheduled', 'live', 'completed', 'cancelled']).optional(), ...page }),
  handler: (_, i) => many(
    `SELECT f.*, h.name AS home_name, h.emoji AS home_emoji, h.color AS home_color, a.name AS away_name, a.emoji AS away_emoji, a.color AS away_color, e.name AS event_name, r.name AS resource_name
       FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id
      WHERE ($1::uuid IS NULL OR f.event_id=$1) AND ($2::uuid IS NULL OR f.home_team_id=$2 OR f.away_team_id=$2) AND ($3::uuid IS NULL OR f.referee_id=$3)
        AND ($4::timestamptz IS NULL OR f.scheduled_at >= $4) AND ($5::timestamptz IS NULL OR f.scheduled_at < $5) AND ($6::text IS NULL OR f.status=$6)
      ORDER BY f.scheduled_at LIMIT $7 OFFSET $8`,
    [i.event_id ?? null, i.team_id ?? null, i.referee_id ?? null, i.from ?? null, i.to ?? null, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'reschedule_fixture', method: 'PATCH', path: '/fixtures/:id', tag: 'Schedule', summary: 'Move, assign a referee to, or cancel a fixture.',
  input: z.object({ id, scheduled_at: dt.optional(), referee_id: id.optional(), status: z.enum(['scheduled', 'live', 'cancelled']).optional() }),
  async handler({ user }, i) {
    const f = await mustFind('fixtures', i.id);
    await eventForOrganizer(user, f.event_id);
    if (f.status === 'completed') throw conflict('Completed fixtures are locked');
    return one('UPDATE fixtures SET scheduled_at=coalesce($2,scheduled_at), referee_id=coalesce($3,referee_id), status=coalesce($4,status) WHERE id=$1 RETURNING *', [i.id, i.scheduled_at, i.referee_id, i.status]);
  },
});

cap({
  name: 'record_result', method: 'POST', path: '/fixtures/:id/result', tag: 'Schedule',
  summary: 'Record the final score (event organiser or the assigned referee). Updates standings.',
  input: z.object({ id, home_score: z.number().int().min(0), away_score: z.number().int().min(0) }),
  async handler({ user }, i) {
    const f = await mustFind('fixtures', i.id);
    const ev = await mustFind('events', f.event_id);
    if (!isAdmin(user) && ![ev.organizer_id, f.referee_id].includes(user.id)) throw forbidden('Only the organiser or the assigned referee can record results');
    return one("UPDATE fixtures SET home_score=$2, away_score=$3, status='completed' WHERE id=$1 RETURNING *", [i.id, i.home_score, i.away_score]);
  },
});

cap({
  name: 'get_standings', method: 'GET', path: '/events/:id/standings', tag: 'Schedule', auth: 'public', summary: 'League table computed from completed fixtures.', input: z.object({ id }),
  handler: (_, i) => standings(i.id),
});

cap({
  name: 'complete_event', method: 'POST', path: '/events/:id/complete', tag: 'Events',
  summary: 'Close an event and auto-award the cup (1st), silver and bronze medals (2nd/3rd) from the final standings.', input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      if (ev.status === 'completed') throw conflict('Already completed');
      const table = await standings(i.id, c);
      const podium = [['cup', `${ev.name} — Champions`], ['medal_silver', `${ev.name} — Runners-up`], ['medal_bronze', `${ev.name} — Third place`]];
      const awards = [];
      for (const [n, [kind, name]] of podium.entries()) {
        if (!table[n] || table[n].played === 0) continue;
        awards.push((await c.query('INSERT INTO awards(name, kind, event_id, team_id, awarded_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, kind, i.id, table[n].team_id, user.id])).rows[0]);
      }
      await c.query("UPDATE events SET status='completed' WHERE id=$1", [i.id]);
      return { status: 'completed', standings: table, awards };
    });
  },
});
