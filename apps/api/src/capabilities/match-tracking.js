import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind } from '../helpers.js';
import { canManageTeam } from './teams.js';
import { isOrganiser } from './event-departments.js';
import { eventForOrganizer } from './events.js';
import { publish } from '../live.js';
import { liveState, loggedEvents, rulesetForEvent } from '../scoring/state.js';
import { rejectReason, matchPhase, CONTROL_KINDS } from '../scoring/engine.js';
import { rulesetSchema, builtinSlugs } from '../scoring/rulesets.js';

const TAG = 'Match tracking';
const kindKey = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
const SCORERS = ['referee', 'umpire', 'scorer'];
const q = (c) => c ?? pool;

/** What the caller is on this game: organiser, an accepted match official, and/or manager of the home or away team. */
export async function fixtureContext(user, fixtureId, c, { lock = false } = {}) {
  const f = (await q(c).query(`SELECT * FROM fixtures WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [fixtureId])).rows[0];
  if (!f) throw notFound('Fixture');
  const ev = await mustFind('events', f.event_id, '*', c);
  const organiser = !!user && await isOrganiser(user, ev, c);
  const official = !!user && (isAdmin(user) || f.referee_id === user.id || (await q(c).query("SELECT 1 FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status='accepted' AND role = ANY($3)", [f.id, user.id, SCORERS])).rowCount > 0);
  let side = null;
  if (user) for (const s of ['home', 'away']) if (f[`${s}_team_id`] && await canManageTeam(user, await mustFind('teams', f[`${s}_team_id`], '*', c))) side = side ? 'both' : s;
  return { f, ev, organiser, official, side, canScore: organiser || official };
}
const needScorer = (x) => { if (!x.canScore) throw forbidden('Only the organiser or the match officials can do that'); };
const broadcast = async (fixtureId) => { const s = await liveState(fixtureId); publish(`fixture:${fixtureId}`, s); return s; };

// ------------------------------------------------------------------ rulesets
cap({
  name: 'get_scoring_ruleset', method: 'GET', path: '/events/:id/scoring-ruleset', tag: TAG, auth: 'public',
  summary: 'How games of this event are scored: periods, what each scoring event is worth, which parameters referees track, set rules. Comes from the organiser\'s template or the sport\'s built-in rules.',
  input: z.object({ id }),
  async handler(_, i) { await mustFind('events', i.id, 'id'); const r = await rulesetForEvent(i.id); return { source: r.source, ...r.ruleset }; },
});

cap({
  name: 'list_builtin_rulesets', method: 'GET', path: '/scoring/rulesets', tag: TAG, auth: 'public',
  summary: 'Sports that ship with Olympic / Asian Games style scoring rules (all others fall back on their scoring family or manual totals).', input: z.object({}),
  handler: async () => builtinSlugs(),
});

cap({
  name: 'set_event_scoring_template', method: 'POST', path: '/events/:id/scoring-template', tag: TAG, status: 201,
  summary: 'Replace the built-in scoring rules for your event with your own ruleset (e.g. house rules, shorter sets, custom point values). The previous template is archived. Not allowed once any game of the event has logged events.',
  input: z.object({ id, ruleset: rulesetSchema }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await eventForOrganizer(user, i.id, c);
      if ((await c.query('SELECT 1 FROM match_events WHERE event_id=$1 LIMIT 1', [i.id])).rowCount) throw conflict('Games have already been scored under the current rules; they cannot change mid-event');
      await c.query("UPDATE scoring_templates SET status='archived', archived_at=now() WHERE event_id=$1 AND status='active'", [i.id]);
      return (await c.query('INSERT INTO scoring_templates(event_id, ruleset, created_by) VALUES ($1,$2,$3) RETURNING id, event_id, ruleset, created_at', [i.id, JSON.stringify(i.ruleset), user.id])).rows[0];
    });
  },
});

// ------------------------------------------------------------------ match control
cap({
  name: 'start_match', method: 'POST', path: '/fixtures/:id/start', tag: TAG,
  summary: 'Kick off a game (organiser or match official). Both teams must be decided and the event must be running.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await tx(async (c) => {
      const x = await fixtureContext(user, i.id, c, { lock: true });
      needScorer(x);
      if (x.f.status !== 'scheduled') throw conflict(`A game that is ${x.f.status} cannot be started`);
      if (!x.f.home_team_id || !x.f.away_team_id) throw conflict('The teams for this game are not decided yet');
      if (['draft', 'paused', 'completed', 'cancelled'].includes(x.ev.status)) throw conflict(`Event is ${x.ev.status}`);
      await c.query("UPDATE fixtures SET status='live', started_at=now() WHERE id=$1", [i.id]);
    });
    return broadcast(i.id);
  },
});

cap({
  name: 'pause_match', method: 'POST', path: '/fixtures/:id/pause', tag: TAG,
  summary: 'Stop play in a live game (injury, weather, protest).', input: z.object({ id }),
  async handler({ user }, i) {
    await tx(async (c) => {
      const x = await fixtureContext(user, i.id, c, { lock: true });
      needScorer(x);
      if (x.f.status !== 'live') throw conflict(`Only a live game can be paused; this one is ${x.f.status}`);
      await c.query("UPDATE fixtures SET status='paused', paused_by_event=false WHERE id=$1", [i.id]);
    });
    return broadcast(i.id);
  },
});

cap({
  name: 'resume_match', method: 'POST', path: '/fixtures/:id/resume', tag: TAG,
  summary: 'Restart play in a paused game. A game frozen by an event pause restarts with the event.', input: z.object({ id }),
  async handler({ user }, i) {
    await tx(async (c) => {
      const x = await fixtureContext(user, i.id, c, { lock: true });
      needScorer(x);
      if (x.f.status !== 'paused') throw conflict(`Only a paused game can be resumed; this one is ${x.f.status}`);
      if (x.ev.status === 'paused') throw conflict('The whole event is paused; resume the event first');
      await c.query("UPDATE fixtures SET status='live', paused_by_event=false WHERE id=$1", [i.id]);
    });
    return broadcast(i.id);
  },
});

cap({
  name: 'log_match_event', method: 'POST', path: '/fixtures/:id/events', tag: TAG, status: 201,
  summary: 'Log what just happened in a live game: a scoring event (goal, 3-pointer, raid point, rally point …) or a tracked parameter (foul, card, timeout, ace …), plus period_start / period_end / note. The score is computed from the ruleset, never typed in. Send a client_key to make retries safe.',
  input: z.object({ id, kind: kindKey, side: z.enum(['home', 'away']).optional(), period: z.number().int().min(1).max(20).optional(), clock_seconds: z.number().int().min(0).max(36000).optional(),
    player_id: id.optional(), payload: z.record(z.string(), z.any()).optional(), client_key: z.string().min(1).max(64).optional() }),
  async handler({ user }, i) {
    let duplicate = false;
    const row = await tx(async (c) => {
      const x = await fixtureContext(user, i.id, c, { lock: true });
      needScorer(x);
      if (i.client_key) {
        const dup = (await c.query('SELECT * FROM match_events WHERE fixture_id=$1 AND client_key=$2', [i.id, i.client_key])).rows[0];
        if (dup) { duplicate = true; return dup; }
      }
      if (x.f.status === 'paused') throw conflict('The game is paused');
      if (x.f.status !== 'live') throw conflict(x.f.status === 'scheduled' ? 'Start the match first' : `The game is ${x.f.status}`);
      const { ruleset } = await rulesetForEvent(x.f.event_id, c);
      const logged = await loggedEvents(i.id, c);
      const phase = matchPhase(ruleset, logged);
      const control = CONTROL_KINDS.includes(i.kind);
      const bad = rejectReason(ruleset, logged, { kind: i.kind, side: i.side });
      if (bad) throw badRequest(bad);
      let period = i.period ?? (phase.period || 1);
      if (i.kind === 'period_start') {
        if (phase.period_open) throw conflict(`${ruleset.periods.label} ${phase.period} is still running`);
        period = i.period ?? phase.period + 1;
      }
      if (i.kind === 'period_end' && !phase.period_open) throw conflict('No period is running');
      const scoring = !control && (ruleset.events.some((e) => e.kind === i.kind) || (ruleset.kind === 'sets' && i.kind === 'point'));
      if (scoring && ruleset.kind === 'points_events' && phase.period > 0 && !phase.period_open) throw conflict(`Between periods: start ${ruleset.periods.label.toLowerCase()} ${phase.period + 1} before scoring`);
      if (i.player_id) await mustFind('users', i.player_id, 'id', c);
      const seq = (await c.query('SELECT coalesce(max(seq),0)+1 AS n FROM match_events WHERE fixture_id=$1', [i.id])).rows[0].n;
      return (await c.query(
        `INSERT INTO match_events(fixture_id, event_id, seq, client_key, kind, side, team_id, player_id, period, clock_seconds, payload, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [i.id, x.f.event_id, seq, i.client_key ?? null, i.kind, i.side ?? null, i.side ? x.f[`${i.side}_team_id`] : null, i.player_id ?? null, period, i.clock_seconds ?? null, JSON.stringify(i.payload ?? {}), user.id])).rows[0];
    });
    return { duplicate, event: row, state: await broadcast(i.id) };
  },
});

cap({
  name: 'void_match_event', method: 'POST', path: '/match-events/:id/void', tag: TAG,
  summary: 'Cancel a wrongly logged event with a reason (organiser or match official, while the game is live or paused). The event stays in the log, marked void, and the score is recomputed.',
  input: z.object({ id, reason: z.string().min(2).max(300) }),
  async handler({ user }, i) {
    const m = (await pool.query('SELECT * FROM match_events WHERE id=$1', [i.id])).rows[0];
    if (!m) throw notFound('Match event');
    await tx(async (c) => {
      const x = await fixtureContext(user, m.fixture_id, c, { lock: true });
      needScorer(x);
      if (!['live', 'paused'].includes(x.f.status)) throw conflict('Events can only be voided while the game is live or paused; after full time, correct the score sheet instead');
      if (m.voided_at) throw conflict('Already voided');
      await c.query('UPDATE match_events SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1', [i.id, user.id, i.reason]);
    });
    return broadcast(m.fixture_id);
  },
});

// ------------------------------------------------------------------ reading
cap({
  name: 'get_live_fixture', method: 'GET', path: '/fixtures/:id/live', tag: TAG, auth: 'public',
  summary: 'A game\'s live state: score (sets and periods where they apply), phase, rules and recent events. Poll with since_seq for new events, or stream /live/fixtures/:id (Server-Sent Events). Void events are only shown to officials.',
  input: z.object({ id, since_seq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(50) }),
  async handler({ user }, i) {
    const f = (await pool.query("SELECT f.id, e.status AS es FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1", [i.id])).rows[0];
    if (!f || f.es === 'draft') throw notFound('Fixture');
    const x = user ? await fixtureContext(user, i.id) : null;
    return liveState(i.id, null, { sinceSeq: i.since_seq, limit: i.limit, includeVoided: !!x?.canScore });
  },
});

cap({
  name: 'get_event_live', method: 'GET', path: '/events/:id/live', tag: TAG, auth: 'public',
  summary: 'Live ticker for an event: every game that is live, paused or at full time awaiting its sheet, with the score.',
  input: z.object({ id }),
  async handler(_, i) {
    const ev = await mustFind('events', i.id, 'id, status');
    if (ev.status === 'draft') throw notFound('Event');
    const ids = (await many("SELECT id FROM fixtures WHERE event_id=$1 AND status IN ('live','paused','finished') ORDER BY started_at NULLS LAST, scheduled_at", [i.id])).map((r) => r.id);
    const games = await Promise.all(ids.map((fid) => liveState(fid, null, { limit: 5 })));
    return games.map((g) => ({ fixture: g.fixture, score: g.score, phase: g.phase, ruleset: { label: g.ruleset.label, kind: g.ruleset.kind, periods: g.ruleset.periods }, last_events: g.events }));
  },
});

// ------------------------------------------------------------------ clashes
cap({
  name: 'check_schedule_clashes', method: 'GET', path: '/events/:id/schedule-check', tag: TAG,
  summary: 'Find scheduling problems among open games: the same court used twice, a team or official in two games at once, or a team with less than min_rest_min between games (organiser).',
  input: z.object({ id, min_rest_min: z.coerce.number().int().min(0).max(600).default(30) }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    const base = `SELECT a.id AS a_id, b.id AS b_id, a.scheduled_at AS a_at, b.scheduled_at AS b_at`;
    const span = (x) => `${x}.scheduled_at + ${x}.duration_min * interval '1 minute'`;
    const live = "('scheduled','live','paused')";
    const overlap = (rest) => `a.scheduled_at < ${span('b')} + ${rest} * interval '1 minute' AND b.scheduled_at < ${span('a')} + ${rest} * interval '1 minute'`;
    const [court, team, rest, official] = await Promise.all([
      many(`${base}, a.resource_id AS who FROM fixtures a JOIN fixtures b ON a.id<b.id AND a.resource_id=b.resource_id WHERE a.event_id=$1 AND b.event_id=$1 AND a.status IN ${live} AND b.status IN ${live} AND ${overlap(0)}`, [i.id]),
      many(`${base}, t.id AS who FROM fixtures a JOIN fixtures b ON a.id<b.id JOIN teams t ON t.id IN (a.home_team_id, a.away_team_id) AND t.id IN (b.home_team_id, b.away_team_id)
            WHERE a.event_id=$1 AND b.event_id=$1 AND a.status IN ${live} AND b.status IN ${live} AND ${overlap(0)}`, [i.id]),
      many(`${base}, t.id AS who FROM fixtures a JOIN fixtures b ON a.id<b.id JOIN teams t ON t.id IN (a.home_team_id, a.away_team_id) AND t.id IN (b.home_team_id, b.away_team_id)
            WHERE a.event_id=$1 AND b.event_id=$1 AND a.status IN ${live} AND b.status IN ${live} AND NOT (${overlap(0)}) AND ${overlap('$2')}`, [i.id, i.min_rest_min]),
      many(`${base}, oa.user_id AS who FROM fixtures a JOIN fixture_officials oa ON oa.fixture_id=a.id AND oa.status IN ('invited','accepted')
            JOIN fixture_officials ob ON ob.user_id=oa.user_id AND ob.status IN ('invited','accepted') JOIN fixtures b ON b.id=ob.fixture_id AND a.id<b.id
            WHERE a.event_id=$1 AND b.event_id=$1 AND a.status IN ${live} AND b.status IN ${live} AND ${overlap(0)}`, [i.id]),
    ]);
    const tag = (kind, rows) => rows.map((r) => ({ kind, fixture_ids: [r.a_id, r.b_id], who: r.who, at: [r.a_at, r.b_at] }));
    const clashes = [...tag('court', court), ...tag('team_overlap', team), ...tag('team_rest', rest), ...tag('official', official)];
    return { ok: !clashes.length, min_rest_min: i.min_rest_min, clashes };
  },
});
