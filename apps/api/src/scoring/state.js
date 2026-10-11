// Everything a scoreboard needs about one game, derived from the match event log.
import { pool } from '../db.js';
import { notFound } from '../errors.js';
import { builtinRuleset, rulesetSchema } from './rulesets.js';
import { computeScore, matchPhase } from './engine.js';

const q = (c) => c ?? pool;

/** The ruleset that applies to an event: the organiser's template if there is one, else the sport's built-in rules. */
export async function rulesetForEvent(eventId, c) {
  const t = (await q(c).query("SELECT ruleset FROM scoring_templates WHERE event_id=$1 AND status='active'", [eventId])).rows[0];
  if (t) return { ruleset: rulesetSchema.parse(t.ruleset), source: 'template' };
  const sport = (await q(c).query('SELECT s.slug, s.name, s.scoring FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [eventId])).rows[0];
  return { ruleset: builtinRuleset(sport), source: 'builtin' };
}

export const loggedEvents = async (fixtureId, c) =>
  (await q(c).query('SELECT id, seq, kind, side, team_id, player_id, period, clock_seconds, payload, recorded_at, voided_at, void_reason FROM match_events WHERE fixture_id=$1 ORDER BY seq', [fixtureId])).rows;

const side = (f, prefix) => (f[`${prefix}_team_id`] ? { id: f[`${prefix}_team_id`], name: f[`${prefix}_name`], emoji: f[`${prefix}_emoji`], color: f[`${prefix}_color`] } : null);

export async function liveState(fixtureId, c, { sinceSeq = 0, limit = 50, includeVoided = false } = {}) {
  const f = (await q(c).query(
    `SELECT f.*, e.name AS event_name, e.status AS event_status, e.pause_reason,
            h.name AS home_name, h.emoji AS home_emoji, h.color AS home_color, a.name AS away_name, a.emoji AS away_emoji, a.color AS away_color
       FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1`, [fixtureId])).rows[0];
  if (!f) throw notFound('Fixture');
  const { ruleset, source } = await rulesetForEvent(f.event_id, c);
  const all = await loggedEvents(fixtureId, c);
  const phase = matchPhase(ruleset, all);
  const shown = all.filter((e) => e.seq > sinceSeq && (includeVoided || !e.voided_at));
  return {
    fixture: { id: f.id, event_id: f.event_id, event_name: f.event_name, event_status: f.event_status, pause_reason: f.pause_reason, status: f.status, round: f.round, scheduled_at: f.scheduled_at, started_at: f.started_at, finished_at: f.finished_at,
      home: side(f, 'home'), away: side(f, 'away'), final: f.status === 'completed' ? { home: f.home_score, away: f.away_score } : null },
    ruleset: { source, ...ruleset },
    score: phase.score, phase: { period: phase.period, period_open: phase.period_open, periods_total: phase.periods_total, can_score: phase.can_score },
    last_seq: all.length ? all[all.length - 1].seq : 0,
    events: shown.slice(-limit),
  };
}
