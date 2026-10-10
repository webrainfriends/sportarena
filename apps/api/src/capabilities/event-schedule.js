// Tournament scheduling: holiday/blackout calendars, venue-aware non-overlapping schedules, knockout brackets (quarter → semi → final).
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind } from '../helpers.js';
import { eventForOrganizer } from './events.js';
import { reserve } from './venues.js';
import { loadVenueCtx, loadBusy, daySlots, lockResources } from '../booking/engine.js';
import { toLocal, fromLocal, addDays, weekdayOf } from '../booking/time.js';
import { buildBracket, ROUND_LABEL, MAX_KNOCKOUT_TEAMS } from '../tournament/bracket.js';
import { planSchedule, roundRobinPairs } from '../tournament/scheduler.js';
import { seededTeams, acceptedTeams } from '../tournament/data.js';
import { standings } from '../helpers.js';

const date = z.string().date();
const MAX_SPAN_DAYS = 120;

// ---------------------------------------------------------------- calendar
cap({
  name: 'add_event_calendar_days', method: 'POST', path: '/events/:id/calendar', tag: 'Tournament', status: 201,
  summary: 'Mark days no game may be scheduled (holiday, blackout, rest day) for the whole event or one venue. Scheduling skips them.',
  input: z.object({ id, days: z.array(z.object({ on_date: date, kind: z.enum(['holiday', 'blackout', 'rest_day']).default('blackout'), label: z.string().max(100).optional(), venue_id: id.optional() })).min(1).max(400) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await eventForOrganizer(user, i.id, c);
      const out = [];
      for (const d of i.days) out.push((await c.query('INSERT INTO event_calendar_days(event_id, venue_id, on_date, kind, label, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id, d.venue_id ?? null, d.on_date, d.kind, d.label ?? null, user.id])).rows[0]);
      return out;
    });
  },
});

cap({
  name: 'list_event_calendar_days', method: 'GET', path: '/events/:id/calendar', tag: 'Tournament', auth: 'public', summary: 'Blackout/holiday days of an event.',
  input: z.object({ id }),
  async handler(_, i) { await mustFind('events', i.id, 'id'); return many('SELECT * FROM event_calendar_days WHERE event_id=$1 AND removed_at IS NULL ORDER BY on_date', [i.id]); },
});

cap({
  name: 'remove_event_calendar_day', method: 'DELETE', path: '/events/:id/calendar/:day_id', tag: 'Tournament', summary: 'Lift a blackout day (kept as removed history).',
  input: z.object({ id, day_id: id }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    const r = await pool.query('UPDATE event_calendar_days SET removed_at=now() WHERE id=$1 AND event_id=$2 AND removed_at IS NULL RETURNING *', [i.day_id, i.id]);
    if (!r.rowCount) throw notFound('Calendar day');
    return r.rows[0];
  },
});

cap({
  name: 'add_holidays', method: 'POST', path: '/holidays', tag: 'Tournament', status: 201,
  summary: 'Record public holidays for a country (optionally a city/region). Event scheduling skips the holidays of the venue’s country/city automatically. Entering a date twice is a no-op.',
  input: z.object({ country: z.string().min(2).max(60), region: z.string().max(80).optional(), days: z.array(z.object({ on_date: date, label: z.string().min(1).max(100) })).min(1).max(400) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const out = [];
      for (const d of i.days) {
        const r = await c.query(`INSERT INTO holiday_calendar_days(country, region, on_date, label, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`, [i.country, i.region ?? null, d.on_date, d.label, user.id]);
        if (r.rows[0]) out.push(r.rows[0]);
      }
      return out;
    });
  },
});

cap({
  name: 'list_holidays', method: 'GET', path: '/holidays', tag: 'Tournament', auth: 'public', summary: 'Public holidays on record for a country (and optionally a city/region), within a date range.',
  input: z.object({ country: z.string().min(2).max(60), region: z.string().max(80).optional(), from: date.optional(), to: date.optional() }),
  handler: (_, i) => many(
    `SELECT * FROM holiday_calendar_days WHERE removed_at IS NULL AND upper(country)=upper($1) AND ($2::text IS NULL OR region IS NULL OR lower(region)=lower($2))
        AND ($3::date IS NULL OR on_date >= $3) AND ($4::date IS NULL OR on_date <= $4) ORDER BY on_date`, [i.country, i.region ?? null, i.from ?? null, i.to ?? null]),
});

cap({
  name: 'remove_holiday', method: 'DELETE', path: '/holidays/:id', tag: 'Tournament', summary: 'Retract a holiday you entered (kept as removed history).', input: z.object({ id }),
  async handler({ user }, i) {
    const h = await mustFind('holiday_calendar_days', i.id);
    if (h.created_by !== user.id && !isAdmin(user)) throw forbidden('Only the person who entered a holiday can retract it');
    return (await pool.query('UPDATE holiday_calendar_days SET removed_at=now() WHERE id=$1 RETURNING *', [i.id])).rows[0];
  },
});

// ---------------------------------------------------------------- planning
const SCHEDULE_INPUT = {
  id, format: z.enum(['round_robin', 'knockout']),
  from_date: date, to_date: date.optional(),
  venue_id: id.optional(), resource_ids: z.array(id).max(50).optional(),
  match_duration_min: z.number().int().min(10).max(600).default(90), rest_min: z.number().int().min(0).max(1440).default(60),
  max_per_team_per_day: z.number().int().min(1).max(10).default(1),
  day_start_min: z.number().int().min(0).max(1439).optional(), day_end_min: z.number().int().min(1).max(1440).optional(),
  weekdays_off: z.array(z.number().int().min(0).max(6)).max(6).default([]), respect_holidays: z.boolean().default(true),
  // knockout only
  team_ids: z.array(id).max(MAX_KNOCKOUT_TEAMS).optional(), from: z.enum(['seeds', 'standings']).default('seeds'), top_n: z.number().int().min(2).max(MAX_KNOCKOUT_TEAMS).optional(),
  third_place: z.boolean().default(false),
};
const scheduleInput = z.object(SCHEDULE_INPUT);

/** Days the venue cannot host this event: event blackout days, the venue's public holidays, switched-off weekdays. */
export async function skippedDates(c, ev, venue, i, from, to) {
  const out = new Map();
  for (const r of (await c.query('SELECT on_date::text AS d, kind, label FROM event_calendar_days WHERE event_id=$1 AND removed_at IS NULL AND (venue_id IS NULL OR venue_id=$2) AND on_date BETWEEN $3 AND $4', [ev.id, venue.id, from, to])).rows) out.set(r.d, `${r.kind}${r.label ? `: ${r.label}` : ''}`);
  if (i.respect_holidays && venue.country) {
    for (const r of (await c.query("SELECT on_date::text AS d, label FROM holiday_calendar_days WHERE removed_at IS NULL AND upper(country)=upper($1) AND (region IS NULL OR lower(region)=lower($2)) AND on_date BETWEEN $3 AND $4", [venue.country, venue.city ?? '', from, to])).rows) if (!out.has(r.d)) out.set(r.d, `public holiday: ${r.label}`);
  }
  for (let d = from; d <= to; d = addDays(d, 1)) if (i.weekdays_off.includes(weekdayOf(d)) && !out.has(d)) out.set(d, 'day off');
  return out;
}

async function pickTeams(c, ev, i) {
  if (i.format === 'round_robin') {
    const t = await acceptedTeams(c, ev.id);
    return t.map((x) => x.team_id);
  }
  if (i.team_ids) {
    const ok = new Set((await acceptedTeams(c, ev.id)).map((t) => t.team_id));
    const bad = i.team_ids.find((t) => !ok.has(t));
    if (bad) throw badRequest('team_ids must all be accepted entrants of this event');
    return i.team_ids;
  }
  if (i.from === 'standings') {
    const table = (await standings(ev.id, c)).filter((r) => r.played > 0);
    if (table.length < 2) throw badRequest('Standings are empty; complete some group games first or pass team_ids');
    return table.slice(0, i.top_n ?? table.length).map((r) => r.team_id);
  }
  const t = (await seededTeams(c, ev)).map((x) => x.team_id);
  return i.top_n ? t.slice(0, i.top_n) : t;
}

/** Build (without writing) the fixtures for a stage and place them on the venue's free slots. */
async function planStage(c, ev, i) {
  const venueId = i.venue_id ?? ev.venue_id;
  if (!venueId) throw badRequest('Choose a venue: pass venue_id or set the event’s venue');
  const ctx = await loadVenueCtx(c, venueId), tz = ctx.venue.timezone;
  const resources = (await c.query(
    'SELECT * FROM resources WHERE venue_id=$1 AND active AND (sport_id IS NULL OR sport_id=$2) AND ($3::uuid[] IS NULL OR id = ANY($3)) ORDER BY name, id', [venueId, ev.sport_id, i.resource_ids ?? null])).rows;
  if (!resources.length) throw badRequest('That venue has no active courts/grounds for this sport');
  if (i.resource_ids && resources.length !== new Set(i.resource_ids).size) throw badRequest('resource_ids must be active areas of that venue for this sport');
  const from = i.from_date, to = i.to_date ?? addDays(from, 30);
  if (to < from) throw badRequest('to_date is before from_date');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > MAX_SPAN_DAYS) throw badRequest(`Scheduling window is limited to ${MAX_SPAN_DAYS} days`);

  const teamIds = await pickTeams(c, ev, i);
  if (teamIds.length < 2) throw badRequest('Need at least 2 accepted teams');

  // build matches
  let matches = [], items = [], byes = [];
  if (i.format === 'round_robin') {
    matches = roundRobinPairs(teamIds).map((m, n) => ({ key: `rr:${n}`, home: m.home, away: m.away, after: [], order: m.round }));
    items = matches.map((m) => ({ key: m.key, round: `Round ${m.order}`, round_kind: 'group', slot: null, home_team_id: m.home, away_team_id: m.away, home_placeholder: null, away_placeholder: null }));
  } else {
    if (teamIds.length > MAX_KNOCKOUT_TEAMS) throw badRequest(`A knockout supports at most ${MAX_KNOCKOUT_TEAMS} teams`);
    const b = buildBracket(teamIds, { thirdPlace: i.third_place });
    byes = b.byes;
    const feeders = new Map(b.fixtures.map((f) => [f.key, []]));
    for (const f of b.fixtures) for (const x of [f.win_feeds, f.lose_feeds]) if (x) feeders.get(x.key).push(f.key);
    const sorted = b.fixtures.slice().sort((x, y) => x.round_index - y.round_index || (x.round_kind === 'third_place' ? -1 : 0) - (y.round_kind === 'third_place' ? -1 : 0) || x.slot - y.slot);
    matches = sorted.map((f) => ({ key: f.key, home: f.home, away: f.away, after: feeders.get(f.key) }));
    items = sorted.map((f) => ({ key: f.key, round: `${ROUND_LABEL[f.round_kind]}${f.round_kind === 'final' || f.round_kind === 'third_place' ? '' : ` ${f.slot + 1}`}`, round_kind: f.round_kind, slot: f.slot,
      home_team_id: f.home, away_team_id: f.away, home_placeholder: f.home_placeholder, away_placeholder: f.away_placeholder, win_feeds: f.win_feeds, lose_feeds: f.lose_feeds }));
  }

  // free slots per day
  const skip = await skippedDates(c, ev, ctx.venue, i, from, to);
  const busy = await loadBusy(c, venueId, fromLocal(from, 0, tz), fromLocal(addDays(to, 1), 0, tz));
  const now = new Date();
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (skip.has(d)) continue;
    const runs = resources.map((r) => ({
      resourceId: r.id,
      slots: daySlots(ctx, r, d, { ...busy, now }).filter((s) => ['free', 'too_soon', 'too_far'].includes(s.status)).filter((s) => {
        const l = toLocal(s.starts_at, tz);
        return (i.day_start_min === undefined || l.minutes >= i.day_start_min) && (i.day_end_min === undefined || l.minutes + (s.ends_at - s.starts_at) / 60000 <= i.day_end_min);
      }).map((s) => ({ start: s.starts_at, end: s.ends_at })),
    }));
    days.push({ date: d, runs });
  }
  // games the teams already have elsewhere
  const involved = [...new Set(matches.flatMap((m) => [m.home, m.away]).filter(Boolean))];
  const teamBusy = new Map();
  for (const f of (await c.query("SELECT home_team_id, away_team_id, scheduled_at, duration_min FROM fixtures WHERE status IN ('scheduled','live') AND (home_team_id = ANY($1) OR away_team_id = ANY($1))", [involved])).rows) {
    for (const t of [f.home_team_id, f.away_team_id]) if (t && involved.includes(t)) {
      if (!teamBusy.has(t)) teamBusy.set(t, []);
      teamBusy.get(t).push({ start: f.scheduled_at, end: new Date(+f.scheduled_at + f.duration_min * 60000) });
    }
  }

  const { placed, unplaced } = planSchedule({ matches, days, durationMin: i.match_duration_min, restMin: i.rest_min, maxPerTeamPerDay: i.max_per_team_per_day, teamBusy });
  const where = new Map(placed.map((p) => [p.key, p]));
  const names = new Map(resources.map((r) => [r.id, r.name]));
  return {
    venue: { id: ctx.venue.id, name: ctx.venue.name, timezone: tz },
    format: i.format, teams: teamIds.length, byes,
    skipped_dates: Object.fromEntries(skip),
    items: items.map((it) => { const p = where.get(it.key); return { ...it, scheduled_at: p?.start.toISOString() ?? null, ends_at: p?.end.toISOString() ?? null, duration_min: p?.minutes ?? null, local_date: p?.date ?? null, resource_id: p?.resource_id ?? null, resource_name: p ? names.get(p.resource_id) : null }; }),
    unplaced: unplaced.map((u) => ({ ...u })),
    placed: placed.length,
  };
}

cap({
  name: 'preview_event_schedule', method: 'POST', path: '/events/:id/schedule/preview', tag: 'Tournament',
  summary: 'Dry-run a round-robin or knockout schedule: fits games into the venue’s free court slots (opening hours, blocks, existing bookings) skipping event blackout days, the venue’s public holidays and days off, with no team or court overlap and rest between a team’s games. Writes nothing.',
  input: scheduleInput,
  async handler({ user }, i) {
    return tx(async (c) => { await eventForOrganizer(user, i.id, c); return planStage(c, await mustFind('events', i.id, '*', c), i); });
  },
});

const ACTIVE_FIXTURE = "status <> 'cancelled'";

cap({
  name: 'generate_event_schedule', method: 'POST', path: '/events/:id/schedule', tag: 'Tournament', status: 201,
  summary: 'Create the fixtures planned by preview_event_schedule and book the courts. All games must fit (otherwise nothing is written and the unplaced games are returned): widen the date window or add courts. A knockout becomes quarter-final → semi-final → final (optionally third place) with placeholders that fill in as results are recorded.',
  input: scheduleInput,
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = (await c.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!ev) throw notFound('Event');
      await eventForOrganizer(user, i.id, c);
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      const existing = i.format === 'round_robin'
        ? (await c.query(`SELECT 1 FROM fixtures WHERE event_id=$1 AND ${ACTIVE_FIXTURE} AND coalesce(round_kind,'group')='group' LIMIT 1`, [i.id])).rowCount
        : (await c.query(`SELECT 1 FROM fixtures WHERE event_id=$1 AND ${ACTIVE_FIXTURE} AND round_kind IS NOT NULL AND round_kind <> 'group' LIMIT 1`, [i.id])).rowCount;
      if (existing) throw conflict(`This event already has ${i.format === 'round_robin' ? 'group-stage' : 'knockout'} fixtures; cancel them first`);
      // serialise against other bookings on the same courts
      const venueId = i.venue_id ?? ev.venue_id;
      if (venueId) await lockResources(c, (await c.query('SELECT id FROM resources WHERE venue_id=$1', [venueId])).rows.map((r) => r.id));
      const plan = await planStage(c, ev, i);
      if (plan.unplaced.length) throw conflict(`${plan.unplaced.length} of ${plan.items.length} games do not fit in that window`, { unplaced: plan.unplaced, placed: plan.placed });

      const stage = (await c.query('INSERT INTO event_stages(event_id, kind, name, position, config, created_by) VALUES ($1,$2,$3,(SELECT count(*) FROM event_stages WHERE event_id=$1),$4,$5) RETURNING *',
        [ev.id, i.format, i.format === 'round_robin' ? 'Group stage' : 'Knockout', { third_place: i.third_place, from: i.from, top_n: i.top_n ?? null, venue_id: plan.venue.id }, user.id])).rows[0];
      const ids = new Map();
      for (const it of plan.items) {
        await reserve(c, { resource_id: it.resource_id, user_id: user.id, event_id: ev.id, starts_at: it.scheduled_at, ends_at: it.ends_at, note: `${it.round}` });
        const dur = Math.min(600, Math.max(10, it.duration_min));
        const fx = (await c.query(
          `INSERT INTO fixtures(event_id, round, home_team_id, away_team_id, resource_id, scheduled_at, duration_min, stage_id, round_kind, bracket_slot, home_placeholder, away_placeholder)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [ev.id, it.round, it.home_team_id, it.away_team_id, it.resource_id, it.scheduled_at, dur, stage.id, it.round_kind, it.slot, it.home_placeholder, it.away_placeholder])).rows[0];
        ids.set(it.key, fx.id);
      }
      for (const it of plan.items) {
        if (!it.win_feeds && !it.lose_feeds) continue;
        await c.query('UPDATE fixtures SET win_feeds_fixture_id=$2, win_feeds_side=$3, lose_feeds_fixture_id=$4, lose_feeds_side=$5 WHERE id=$1',
          [ids.get(it.key), it.win_feeds ? ids.get(it.win_feeds.key) : null, it.win_feeds?.side ?? null, it.lose_feeds ? ids.get(it.lose_feeds.key) : null, it.lose_feeds?.side ?? null]);
      }
      return { stage, created: plan.items.length, byes: plan.byes, skipped_dates: plan.skipped_dates, fixtures: (await c.query('SELECT * FROM fixtures WHERE stage_id=$1 ORDER BY scheduled_at, bracket_slot', [stage.id])).rows };
    });
  },
});

// ---------------------------------------------------------------- bracket view
const ROUND_ORDER = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'final', 'third_place'];

cap({
  name: 'get_event_bracket', method: 'GET', path: '/events/:id/bracket', tag: 'Tournament', auth: 'public',
  summary: 'The knockout bracket as rounds of games (teams or placeholders, times, courts, scores, winners), plus the champion once the final is played.',
  input: z.object({ id }),
  async handler(_, i) {
    await mustFind('events', i.id, 'id');
    const rows = await many(
      `SELECT f.id, f.round, f.round_kind, f.bracket_slot AS slot, f.status, f.scheduled_at, f.duration_min, f.home_team_id, f.away_team_id, f.home_score, f.away_score, f.winner_team_id,
              f.home_placeholder, f.away_placeholder, f.win_feeds_fixture_id, f.lose_feeds_fixture_id, h.name AS home_name, h.emoji AS home_emoji, a.name AS away_name, a.emoji AS away_emoji, r.name AS resource_name
         FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id
        WHERE f.event_id=$1 AND f.round_kind IS NOT NULL AND f.round_kind <> 'group' AND f.status <> 'cancelled' ORDER BY f.scheduled_at, f.bracket_slot`, [i.id]);
    const rounds = ROUND_ORDER.map((kind) => ({ kind, label: ROUND_LABEL[kind], games: rows.filter((r) => r.round_kind === kind).sort((x, y) => x.slot - y.slot) })).filter((r) => r.games.length);
    const final = rows.find((r) => r.round_kind === 'final' && r.status === 'completed');
    const champion = final ? { team_id: final.winner_team_id, name: final.winner_team_id === final.home_team_id ? final.home_name : final.away_name } : null;
    return { rounds, champion };
  },
});
