// Premium live game centre (#578). Pure projections over the CANONICAL game state (match_events via liveState, match_appearances, match_substitutions, standings):
// nothing here stores match state. Every projection is public-safe: young people are never named and a youth event shows no player names at all.
import { many, one } from './db.js';
import { standings } from './helpers.js';
import { isYouthEvent, publicPeople } from './spectator.js';

export const FAN_MODULES = ['lineups', 'substitutions', 'discipline', 'stats', 'standings_impact', 'highlights', 'partners'];
/** Which modules the organiser enabled: NULL means all of them. Unknown names are ignored. */
export const enabledModules = (ev) => (ev.public_modules == null ? FAN_MODULES : FAN_MODULES.filter((m) => ev.public_modules.includes(m)));

const DISCIPLINE = /(card|penalty|suspension|exclusion|sent_off|sin_bin|hansoku|keikoku|chukoku|disqualif|point_deduction|warning)/;
const isDiscipline = (kind) => DISCIPLINE.test(kind) && kind !== 'penalty_goal' && kind !== 'penalty_corner' && kind !== 'penalty_try';

/**
 * The game clock. `official` is true only when the events were entered by an organiser / official / admin (or the sheet is approved);
 * an unofficial clock is shown but labelled, never presented as the referee's time. Elapsed time is the last recorded clock reading, so the
 * client can tick locally while `running` and is corrected by every new frame.
 */
export async function clockOf(state) {
  const f = state.fixture;
  const authority = await one(
    `SELECT bool_or(source_authority IN ('organiser','official','admin')) AS official FROM match_events WHERE fixture_id=$1 AND voided_at IS NULL`, [f.id]);
  const sheet = await one("SELECT 1 AS ok FROM score_sheets WHERE fixture_id=$1 AND status IN ('approved','published')", [f.id]);
  const timed = state.events.filter((e) => e.clock_seconds != null);
  const last = timed.length ? timed[timed.length - 1] : null;
  return {
    state: f.status === 'live' ? 'running' : f.status === 'paused' ? 'paused' : f.status === 'scheduled' ? 'not_started' : 'stopped',
    official: !!(authority?.official || sheet),
    elapsed_seconds: last?.clock_seconds ?? null,
    period: state.phase?.period ?? null,
    started_at: f.started_at,
    // a sport without a running clock (racket and rally sports, cricket) shows its own state instead: say so rather than inventing a timer
    timed: state.ruleset?.kind === 'points_events' && !!state.ruleset?.periods,
  };
}

export async function lineupsOf(ev, fixtureId, f) {
  if (isYouthEvent(ev)) return { available: false, reason: 'youth_event', teams: [] };
  const rows = await many(
    `SELECT a.team_id, a.user_id, a.status, a.on_clock_seconds, a.off_clock_seconds FROM match_appearances a
      WHERE a.fixture_id=$1 AND a.archived_at IS NULL AND a.status IN ('started','substitute_on','unused_sub') ORDER BY a.team_id, a.status, a.created_at`, [fixtureId]);
  const people = await publicPeople(ev, rows.map((r) => r.user_id));
  const teams = [f.home_team_id, f.away_team_id].filter(Boolean).map((teamId) => ({
    team_id: teamId, side: teamId === f.home_team_id ? 'home' : 'away',
    players: rows.filter((r) => r.team_id === teamId && people.has(r.user_id)).map((r) => ({ ...people.get(r.user_id), role: r.status === 'started' ? 'starter' : r.status === 'substitute_on' ? 'came_on' : 'bench', on_clock_seconds: r.on_clock_seconds, off_clock_seconds: r.off_clock_seconds })),
    hidden_young_players: rows.filter((r) => r.team_id === teamId && !people.has(r.user_id)).length,
  }));
  return { available: teams.some((t) => t.players.length > 0), teams };
}

export async function substitutionsOf(ev, fixtureId, f) {
  if (isYouthEvent(ev)) return [];
  const rows = await many('SELECT team_id, player_off_id, player_on_id, period, clock_seconds FROM match_substitutions WHERE fixture_id=$1 AND voided_at IS NULL ORDER BY clock_seconds, id', [fixtureId]);
  const people = await publicPeople(ev, rows.flatMap((r) => [r.player_off_id, r.player_on_id]));
  return rows.map((r) => ({ side: r.team_id === f.home_team_id ? 'home' : 'away', period: r.period, clock_seconds: r.clock_seconds, off: people.get(r.player_off_id) ?? null, on: people.get(r.player_on_id) ?? null }));
}

/** Cards, penalties, suspensions, warnings: read from the same event log the score comes from, labelled with the ruleset's own words. */
export function disciplineOf(live) { return live.timeline.filter((e) => isDiscipline(e.kind)); }

/** Key stats: counts per kind per side from the non-voided event log, named by the sport's own ruleset. Sports whose engine keeps richer stats add them under `plugin`. */
export function statsOf(state) {
  const names = new Map([...(state.ruleset?.events ?? []), ...(state.ruleset?.stats ?? [])].map((x) => [x.kind, x]));
  const by = new Map();
  for (const e of state.events) {
    if (e.kind === 'note' || !e.side) continue;
    const row = by.get(e.kind) ?? { kind: e.kind, label: names.get(e.kind)?.label ?? e.kind.replace(/_/g, ' '), icon: names.get(e.kind)?.icon ?? null, scoring: (names.get(e.kind)?.points ?? 0) > 0, home: 0, away: 0 };
    row[e.side === 'home' ? 'home' : 'away'] += 1;
    by.set(e.kind, row);
  }
  return { source: 'event_log', rows: [...by.values()].sort((a, b) => Number(b.scoring) - Number(a.scoring) || (b.home + b.away) - (a.home + a.away)) };
}

/**
 * "If it ended now": the group table with this game's current score counted as a result, next to the official table.
 * Always provisional; only for a group game between two known teams that is live, paused or at provisional full time.
 */
export async function standingsImpact(ev, f, score) {
  const live = ['live', 'paused', 'finished'].includes(f.status);
  if (!live || !f.home_team_id || !f.away_team_id || (f.round_kind ?? 'group') !== 'group') return { available: false, label: 'provisional', rows: [] };
  const base = await standings(ev.id);
  const sim = base.map((r) => ({ ...r }));
  const put = (teamId, gf, ga) => {
    const r = sim.find((x) => x.team_id === teamId); if (!r) return;
    r.played += 1; r.goals_for += gf; r.goals_against += ga; r.goal_diff = r.goals_for - r.goals_against;
    if (gf > ga) { r.won += 1; r.points += ev.points_win; } else if (gf === ga) { r.drawn += 1; r.points += ev.points_draw; } else { r.lost += 1; r.points += ev.points_loss; }
  };
  put(f.home_team_id, score.home, score.away); put(f.away_team_id, score.away, score.home);
  sim.sort((a, b) => b.points - a.points || b.goal_diff - a.goal_diff || b.goals_for - a.goals_for || a.name.localeCompare(b.name));
  const before = new Map(base.map((r) => [r.team_id, r.rank]));
  const rows = sim.map((r, i) => ({ team_id: r.team_id, name: r.name, emoji: r.emoji, rank: i + 1, was_rank: before.get(r.team_id) ?? null, moved: (before.get(r.team_id) ?? i + 1) - (i + 1), played: r.played, points: r.points, goal_diff: r.goal_diff, in_this_game: r.team_id === f.home_team_id || r.team_id === f.away_team_id }));
  return { available: true, label: 'provisional', note: 'If the game ended as it stands. Not official until the score sheet is approved.', rows };
}

/** Highlights: only clips and photos the rights engine already made public for this game (see publicMedia); the link kind is derived, nothing is stored twice. */
export const highlightsOf = (media) => media.filter((m) => m.kind === 'clip' || ((m.kind === 'video') && ['highlights', 'short_form', 'delayed_video'].includes(m.right_kind)));
