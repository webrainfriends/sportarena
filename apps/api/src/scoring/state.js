// Everything a scoreboard needs about one game, derived from the match event log.
import { pool } from '../db.js';
import { notFound } from '../errors.js';
import { builtinRuleset, rulesetSchema } from './rulesets.js';
import { computeScore, matchPhase } from './engine.js';

const q = (c) => c ?? pool;

/**
 * The ruleset that applies to an event: the version a started game pinned, else the organiser's template, else the sport's governed
 * default ruleset (latest published version), else the built-in rules. Pass fixtureId so a game started under one version keeps it.
 */
export async function rulesetForEvent(eventId, c, fixtureId) {
  if (fixtureId) {
    const pinned = (await q(c).query('SELECT rv.id, rv.version, rv.format_key, rv.ruleset FROM fixtures f JOIN ruleset_versions rv ON rv.id=f.ruleset_version_id WHERE f.id=$1', [fixtureId])).rows[0];
    if (pinned) return { ruleset: rulesetSchema.parse(pinned.ruleset), source: 'governed', ruleset_version_id: pinned.id, version: pinned.version, format_key: pinned.format_key };
  }
  const t = (await q(c).query("SELECT t.ruleset, t.ruleset_version_id, rv.version, rv.format_key FROM scoring_templates t LEFT JOIN ruleset_versions rv ON rv.id=t.ruleset_version_id WHERE t.event_id=$1 AND t.status='active'", [eventId])).rows[0];
  if (t) return { ruleset: rulesetSchema.parse(t.ruleset), source: 'template', ruleset_version_id: t.ruleset_version_id ?? null, version: t.version ?? null, format_key: t.format_key ?? null };
  const sport = (await q(c).query('SELECT s.id, s.slug, s.name, s.scoring FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [eventId])).rows[0];
  const gov = (await q(c).query("SELECT id, version, format_key, ruleset FROM ruleset_versions WHERE sport_id=$1 AND format_key='default' ORDER BY version DESC LIMIT 1", [sport.id])).rows[0];
  if (gov) return { ruleset: rulesetSchema.parse(gov.ruleset), source: 'governed', ruleset_version_id: gov.id, version: gov.version, format_key: gov.format_key };
  return { ruleset: builtinRuleset(sport), source: 'builtin', ruleset_version_id: null, version: null, format_key: null };
}

/** When a game starts, remember the governed ruleset version it will be scored under (history is never re-scored if the rules change later). */
export async function pinFixtureRuleset(fixtureId, eventId, c) {
  const r = await rulesetForEvent(eventId, c, fixtureId);
  if (r.source === 'governed') await q(c).query('UPDATE fixtures SET ruleset_version_id=$2 WHERE id=$1 AND ruleset_version_id IS NULL', [fixtureId, r.ruleset_version_id]);
  return r;
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
  const { ruleset, source, version, format_key } = await rulesetForEvent(f.event_id, c, fixtureId);
  const all = await loggedEvents(fixtureId, c);
  const phase = matchPhase(ruleset, all);
  const shown = all.filter((e) => e.seq > sinceSeq && (includeVoided || !e.voided_at));
  return {
    fixture: { id: f.id, event_id: f.event_id, event_name: f.event_name, event_status: f.event_status, pause_reason: f.pause_reason, status: f.status, round: f.round, scheduled_at: f.scheduled_at, started_at: f.started_at, finished_at: f.finished_at,
      home: side(f, 'home'), away: side(f, 'away'), final: f.status === 'completed' ? { home: f.home_score, away: f.away_score } : null },
    ruleset: { source, version: version ?? null, format_key: format_key ?? null, ...ruleset },
    score: phase.score, phase: { period: phase.period, period_open: phase.period_open, periods_total: phase.periods_total, can_score: phase.can_score },
    last_seq: all.length ? all[all.length - 1].seq : 0,
    events: shown.slice(-limit),
  };
}
