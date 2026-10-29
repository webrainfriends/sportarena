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
import { MAX_KNOCKOUT_TEAMS } from '../tournament/bracket.js';
import { buildPlan, orderField, coverageOf, FORMATS, STAGE_KIND } from '../tournament/plan.js';
import { writeItems, recordRevision, snapshotOf } from '../tournament/stage.js';
import { newDrawSeed } from '../tournament/formats/rng.js';
import { SWISS_POLICIES, SWISS_TIEBREAKS, FIRST_ROUND, DEFAULT_SWISS } from '../tournament/formats/swiss.js';
import { POOL_TIEBREAKS, DEFAULT_POOLS } from '../tournament/formats/pools.js';
import { assertEventReadable, bracketOf } from '../spectator.js';
import { planSchedule } from '../tournament/scheduler.js';
import { seededTeams, acceptedTeams } from '../tournament/data.js';
import { standings, audit } from '../helpers.js';
import { eventWindow, windowFit, consentNeeded } from '../event-fit.js';

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
  id, format: z.enum(FORMATS),
  from_date: date, to_date: date.optional(),
  venue_id: id.optional(), resource_ids: z.array(id).max(50).optional(),
  match_duration_min: z.number().int().min(10).max(600).default(90), rest_min: z.number().int().min(0).max(1440).default(60),
  max_per_team_per_day: z.number().int().min(1).max(10).default(1),
  day_start_min: z.number().int().min(0).max(1439).optional(), day_end_min: z.number().int().min(1).max(1440).optional(),
  weekdays_off: z.array(z.number().int().min(0).max(6)).max(6).default([]), respect_holidays: z.boolean().default(true),
  // knockout only
  team_ids: z.array(id).max(128).optional(), from: z.enum(['seeds', 'standings']).default('seeds'), top_n: z.number().int().min(2).max(128).optional(),
  third_place: z.boolean().default(false),
  format_config: z.object({
    reset: z.boolean().optional().describe('double elimination: add the conditional grand-final reset game (played only if the losers-bracket champion wins the first grand final)'),
    placement_up_to: z.union([z.literal(3), z.literal(4), z.literal(8), z.literal(16)]).optional().describe('knockout: play-offs for every place up to this one (3/4 = third place, 8 = 5th-8th too, 16 = 9th-16th too)'),
    consolation: z.boolean().optional().describe('knockout: a second-chance bracket for first-round losers'),
    tie: z.object({ mode: z.enum(['best_of', 'legs']), best_of: z.number().int().optional(), legs: z.number().int().min(2).max(4).optional(), home_rotation: z.enum(['alternate', 'two_two_one_one_one', 'fixed_a', 'fixed_b']).optional(),
      away_goals: z.boolean().optional().describe('count away goals on a level aggregate. Never assumed: only when true'), decider: z.enum(['extra_time_then_penalties', 'penalties', 'golden_point', 'replay', 'manual']).optional(), apply_to: z.enum(['all', 'except_final']).optional() }).optional()
      .describe('every tie becomes a best-of-N series or a multi-leg aggregate tie made of ordinary games'),
    swiss: z.object({ rounds: z.number().int().min(1).max(15).optional(), policy: z.enum(Object.keys(SWISS_POLICIES)).optional(), first_round: z.enum(FIRST_ROUND).optional(), tie_breaks: z.array(z.enum(SWISS_TIEBREAKS)).max(7).optional(),
      bye_points: z.enum(['win', 'draw', 'none']).optional(), allow_rematch: z.boolean().optional(), balance_home_away: z.boolean().optional() }).optional(),
    pools: z.object({ pool_count: z.number().int().min(2).max(16).optional(), draw: z.enum(['snake', 'pots', 'manual']).optional(), advance_per_pool: z.number().int().min(1).max(8).optional(), wildcards: z.number().int().min(0).max(8).optional(),
      wildcard_from_place: z.number().int().min(1).max(9).optional(), tie_breaks: z.array(z.enum(POOL_TIEBREAKS)).max(6).optional(), avoid_same_pool_round_one: z.boolean().optional(), third_place: z.boolean().optional(),
      manual: z.array(z.object({ team: id, pool: z.string().max(3) })).max(128).optional() }).optional(),
    repechage_template: z.string().max(80).optional().describe('a template id from get_bracket_formats; the repechage ladder is generated once both finalists are known'),
    manual_pairings: z.array(z.object({ home: id, away: id })).max(64).optional().describe('swiss round 1 set by hand (recorded as a manual draw)'),
  }).default({}),
  draw: z.object({ mode: z.enum(['seeded', 'random']).default('seeded'), protect_top: z.number().int().min(0).max(64).default(0), draw_seed: z.string().min(4).max(64).optional().describe('persisted randomness: pass the seed a preview returned to get exactly that draw') }).default({ mode: 'seeded', protect_top: 0 }),
  publish: z.boolean().default(true).describe('false keeps the stage as a draft: seeds and the draw stay editable and spectators see no bracket until it is published'),
  accept_mismatch: z.boolean().default(false).describe('consent to schedule games on days outside the event’s start/end dates'),
};
export const scheduleInput = z.object(SCHEDULE_INPUT);

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

export async function pickTeams(c, ev, i) {
  if (i.format === 'round_robin' && !i.team_ids) {
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
export async function planStage(c, ev, i, ov = {}) {
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

  // the field, drawn: seeded as given, or random with the top seeds protected; the seed is persisted so the draw can be replayed
  const field = ov.field ?? await pickTeams(c, ev, i);
  if (field.length < 2) throw badRequest('Need at least 2 accepted teams');
  const drawSeed = ov.drawSeed ?? i.draw?.draw_seed ?? newDrawSeed();
  const { order: teamIds } = ov.field ? { order: field } : orderField(field, i.draw, drawSeed);
  const cfg = { ...i.format_config, third_place: i.third_place || i.format_config?.third_place };
  let built = ov.plan;
  if (!built) {
    try { built = buildPlan(i.format, teamIds, cfg, { drawSeed, points: { pointsWin: ev.points_win, pointsDraw: ev.points_draw, pointsLoss: ev.points_loss } }); }
    catch (e) { throw e.code ? badRequest(e.message, { code: e.code }) : badRequest(e.message); }
  }
  const { matches, items, byes } = built;
  const sportRow = ev.sport_id ? (await c.query('SELECT slug, name, category, scoring FROM sports WHERE id=$1', [ev.sport_id])).rows[0] : null;
  const coverage = coverageOf(sportRow);
  const warnings = [...(built.warnings ?? []), ...(i.format !== 'round_robin' && coverage.mode === 'fallback' ? [coverage.note] : [])];

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
  const teamInfo = new Map((await c.query('SELECT id, name, emoji, color FROM teams WHERE id = ANY($1)', [involved])).rows.map((t) => [t.id, t]));
  return {
    venue: { id: ctx.venue.id, name: ctx.venue.name, timezone: tz },
    alignment: windowFit(await eventWindow(c, ev.id), placed.map((p) => ({ date: p.date, cents: 0 })), [], [], ctx.venue.currency, { edges: false }),
    format: i.format, teams: teamIds.length, byes, draw_seed: drawSeed, field: teamIds, algorithm: built.algorithm, warnings, coverage, stage_kind: built.stageKind, stage_name: built.stageName, pools: built.pools ?? null, pairing: built.pairing ?? null, bye: built.bye ?? null, config: cfg,
    skipped_dates: Object.fromEntries(skip),
    items: items.map((it) => { const p = where.get(it.key); const h = teamInfo.get(it.home_team_id), a = teamInfo.get(it.away_team_id); return { ...it, home_name: h?.name ?? null, home_emoji: h?.emoji ?? null, home_color: h?.color ?? null, away_name: a?.name ?? null, away_emoji: a?.emoji ?? null, away_color: a?.color ?? null, scheduled_at: p?.start.toISOString() ?? null, ends_at: p?.end.toISOString() ?? null, duration_min: p?.minutes ?? null, local_date: p?.date ?? null, resource_id: p?.resource_id ?? null, resource_name: p ? names.get(p.resource_id) : null }; }),
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
      const groupLike = GROUP_FORMATS.includes(i.format);
      const existing = groupLike
        ? (await c.query(`SELECT 1 FROM fixtures WHERE event_id=$1 AND ${ACTIVE_FIXTURE} AND coalesce(round_kind,'group')='group' LIMIT 1`, [i.id])).rowCount
        : (await c.query(`SELECT 1 FROM fixtures WHERE event_id=$1 AND ${ACTIVE_FIXTURE} AND round_kind IS NOT NULL AND round_kind <> 'group' AND stage_id IN (SELECT id FROM event_stages WHERE kind IN ('knockout','double_elimination')) LIMIT 1`, [i.id])).rowCount;
      if (existing) throw conflict(`This event already has ${groupLike ? 'group-stage' : 'knockout'} fixtures; cancel them first`);
      // serialise against other bookings on the same courts
      const venueId = i.venue_id ?? ev.venue_id;
      if (venueId) await lockResources(c, (await c.query('SELECT id FROM resources WHERE venue_id=$1', [venueId])).rows.map((r) => r.id));
      const plan = await planStage(c, ev, i);
      if (plan.unplaced.length) throw conflict(`${plan.unplaced.length} of ${plan.items.length} games do not fit in that window`, { unplaced: plan.unplaced, placed: plan.placed });
      if (plan.alignment.consent_required && !i.accept_mismatch) throw conflict(plan.alignment.verdict, consentNeeded(plan.alignment));
      if (plan.alignment.consent_required) await audit(c, user.id, 'accept_event_schedule_mismatch', 'events', ev.id);

      const stage = await createStage(c, user, ev, i, plan);
      await writeItems(c, user, ev, stage, plan.items);
      const out = (await c.query('SELECT * FROM event_stages WHERE id=$1', [stage.id])).rows[0];
      return { stage: out, created: plan.items.length, byes: plan.byes, skipped_dates: plan.skipped_dates, draw_seed: plan.draw_seed, algorithm: plan.algorithm, warnings: plan.warnings,
        fixtures: (await c.query('SELECT * FROM fixtures WHERE stage_id=$1 ORDER BY scheduled_at, bracket_slot', [stage.id])).rows };
    });
  },
});

const GROUP_FORMATS = ['round_robin', 'pools', 'swiss'];
/** The scheduling window and venue a stage was planned with, kept so later rounds / generated stages reuse them. */
export const SCHEDULE_KEYS = ['from_date', 'to_date', 'venue_id', 'resource_ids', 'match_duration_min', 'rest_min', 'max_per_team_per_day', 'day_start_min', 'day_end_min', 'weekdays_off', 'respect_holidays', 'accept_mismatch'];

/** Insert the stage row (with its pinned format config, algorithm and persisted draw seed) and its first audit entries. */
export async function createStage(c, user, ev, i, plan, { parent = null, name = null, kind = null } = {}) {
  const sched = Object.fromEntries(SCHEDULE_KEYS.filter((k) => i[k] !== undefined).map((k) => [k, i[k]]));
  const config = { ...plan.config, third_place: i.third_place, from: i.from, top_n: i.top_n ?? null, venue_id: plan.venue.id, schedule_args: sched, field: plan.field, format: i.format, schema: 1 };
  if (plan.stage_kind === 'swiss') { config.swiss = { ...DEFAULT_SWISS, ...(plan.config.swiss ?? {}) }; config.swiss_state = { rounds_total: config.swiss.rounds, byes: plan.bye ? { 1: plan.bye.team } : {} }; }
  if (plan.pools) { config.pools = { ...DEFAULT_POOLS, ...(plan.config.pools ?? {}) }; config.pools_drawn = plan.pools; }
  const stage = (await c.query(
    `INSERT INTO event_stages(event_id, kind, name, position, config, created_by, published_at, published_by, algorithm, draw_seed, parent_stage_id)
     VALUES ($1,$2,$3,(SELECT count(*) FROM event_stages WHERE event_id=$1),$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ev.id, kind ?? STAGE_KIND[i.format], name ?? plan.stage_name, JSON.stringify(config), user.id, i.publish ? new Date() : null, i.publish ? user.id : null, plan.algorithm, plan.draw_seed, parent])).rows[0];
  await recordRevision(c, stage.id, 'generated', { actor: user.id, algorithm: plan.algorithm, inputs: { format: i.format, field: plan.field, draw_seed: plan.draw_seed, draw: i.draw, config: plan.config }, snapshot: { games: snapshotOf(plan.items), byes: plan.byes, pairing: plan.pairing, pools: plan.pools } });
  if (i.publish) await recordRevision(c, stage.id, 'published', { actor: user.id });
  return stage;
}

// ---------------------------------------------------------------- bracket view
cap({
  name: 'get_event_bracket', method: 'GET', path: '/events/:id/bracket', tag: 'Tournament', auth: 'public',
  summary: 'The knockout bracket as rounds of games (teams or placeholders, times, courts, scores, winners), plus the champion once the final is played.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustFind('events', i.id, 'id');
    await assertEventReadable(user, i.id);
    const ev = await mustFind('events', i.id, 'organizer_id');
    return bracketOf(i.id, { organiser: !!user && (isAdmin(user) || ev.organizer_id === user.id) });
  },
});
