// Everything a scoreboard needs about one game, derived from the match event log.
import { pool } from '../db.js';
import { notFound } from '../errors.js';
import { builtinRuleset, rulesetSchema } from './rulesets.js';
import { computeScore, matchPhase } from './engine.js';
import { YOUTH_SQL, hasConsent } from '../youth.js';

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
  const sport = (await q(c).query('SELECT s.id, s.slug, s.name, s.scoring, s.category FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1', [eventId])).rows[0];
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

/** The game's events in play order. A correction sits where the event it replaces sat (position_seq); seq is the arrival order the live cursor follows. */
export const loggedEvents = async (fixtureId, c) =>
  (await q(c).query(`SELECT id, seq, kind, side, team_id, player_id, period, clock_seconds, payload, recorded_at, voided_at, void_reason, supersedes_id, position_seq, source_authority
                       FROM match_events WHERE fixture_id=$1 ORDER BY coalesce(position_seq, seq), seq`, [fixtureId])).rows;


// ------------------------------------------------------------------ spectator privacy
const PLAYER_KEYS = new Set(['player_id', 'assist_player_id']);
const collect = (v, out) => {
  if (Array.isArray(v)) v.forEach((x) => collect(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (PLAYER_KEYS.has(k) && typeof x === 'string') out.add(x); else if (k === 'lineup' && x && typeof x === 'object') for (const side of Object.values(x)) (Array.isArray(side) ? side : []).forEach((id) => typeof id === 'string' && out.add(id)); else collect(x, out); }
};
const strip = (v, ok) => {
  if (Array.isArray(v)) return v.map((x) => strip(x, ok));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (PLAYER_KEYS.has(k)) out[k] = typeof x === 'string' && !ok.has(x) ? null : x;
    else if (k === 'lineup' && x && typeof x === 'object') out[k] = Object.fromEntries(Object.entries(x).map(([side, ids]) => [side, Array.isArray(ids) ? ids.map((id) => (ok.has(id) ? id : null)) : ids]));
    else out[k] = strip(x, ok);
  }
  return out;
};
/** People who may be named to the public: adults always, a young person only while a guardian currently consents to participation. One query for youth, a consent check only for them. */
export async function publiclyNameable(ids, c) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Set();
  const youth = new Set((await q(c).query(`SELECT u.id FROM users u WHERE u.id = ANY($1) AND ${YOUTH_SQL}`, [list])).rows.map((r) => r.id));
  const ok = new Set(list.filter((x) => !youth.has(x)));
  for (const y of youth) if (await hasConsent(y, 'participation', c)) ok.add(y);
  return ok;
}
/** A copy of `value` with every player a spectator may not be told about replaced by null. Officials are never passed through this. */
export async function redactForPublic(value, c) {
  const ids = new Set(); collect(value, ids);
  if (!ids.size) return value;
  return strip(value, await publiclyNameable([...ids], c));
}

const side = (f, prefix) => (f[`${prefix}_team_id`] ? { id: f[`${prefix}_team_id`], name: f[`${prefix}_name`], emoji: f[`${prefix}_emoji`], color: f[`${prefix}_color`] } : null);

/** What a spectator is told about a game: scheduled, live, provisional (full time, sheet not published), final, or corrected after publication. */
export function publicStatus(f, { corrected = false, superseded = false } = {}) {
  const base = { scheduled: 'scheduled', live: 'live', paused: 'live', finished: 'provisional', completed: superseded ? 'corrected' : 'final' }[f.status] ?? f.status;
  return { state: base, paused: f.status === 'paused', corrected: corrected || superseded };
}

export async function liveState(fixtureId, c, { sinceSeq = 0, limit = 50, includeVoided = false } = {}) {
  const f = (await q(c).query(
    `SELECT f.*, e.name AS event_name, e.status AS event_status, e.pause_reason,
            h.name AS home_name, h.emoji AS home_emoji, h.color AS home_color, a.name AS away_name, a.emoji AS away_emoji, a.color AS away_color
       FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1`, [fixtureId])).rows[0];
  if (!f) throw notFound('Fixture');
  const { ruleset, source, version, format_key } = await rulesetForEvent(f.event_id, c, fixtureId);
  const all = await loggedEvents(fixtureId, c);
  const phase = matchPhase(ruleset, all);
  const revisions = (await q(c).query('SELECT count(*)::int AS n FROM match_event_revisions WHERE fixture_id=$1', [fixtureId])).rows[0].n;
  const superseded = f.status === 'completed' && (await q(c).query("SELECT 1 FROM score_sheets WHERE fixture_id=$1 AND status='superseded' LIMIT 1", [fixtureId])).rowCount > 0;
  // spectators get the facts of what counts; void reasons, the capacity an event was entered in and ordering internals stay with officials
  const spectator = ({ voided_at, void_reason, source_authority, position_seq, ...e }) => e;
  const shown = all.filter((e) => e.seq > sinceSeq && (includeVoided || !e.voided_at)).sort((a, b) => a.seq - b.seq).map((e) => (includeVoided ? e : spectator(e)));
  const lastSeq = all.reduce((m, e) => Math.max(m, e.seq), 0);
  const view = includeVoided ? { score: phase.score, events: shown } : await redactForPublic({ score: phase.score, events: shown }, c);
  return {
    fixture: { id: f.id, event_id: f.event_id, event_name: f.event_name, event_status: f.event_status, pause_reason: f.pause_reason, status: f.status, round: f.round, scheduled_at: f.scheduled_at, started_at: f.started_at, finished_at: f.finished_at,
      home: side(f, 'home'), away: side(f, 'away'), final: f.status === 'completed' ? { home: f.home_score, away: f.away_score } : null },
    ruleset: { source, version: version ?? null, format_key: format_key ?? null, ...ruleset },
    score: view.score, phase: { ...phase, score: undefined },
    live: publicStatus(f, { corrected: revisions > 0, superseded }),
    last_seq: lastSeq,
    // cursor/version for reconnect and stale-state detection: it moves on every new event AND on every void/correction
    version: lastSeq + revisions,
    // events whose void must be applied by a client holding an older cursor (reasons stay with officials)
    voided_seqs: all.filter((e) => e.voided_at).map((e) => e.seq),
    events: view.events.slice(-limit),
  };
}
