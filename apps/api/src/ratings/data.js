// Skill rating evidence, runs and lookups (#633). The engine (engine.js) is pure; everything that touches the database lives here.
// Only verified results count: games with a published score sheet and completed event sessions, in tournaments and leagues. Practice, imported and
// self-reported results, friendlies, camps and trials never count. Youth accounts and accounts not approved are never rated.
import { createHash } from 'node:crypto';
import { query, many, one, tx } from '../db.js';
import { NOT_YOUTH_SQL } from '../youth.js';
import { replay, present, toLevel, bucketOf, RELIABLE_RD, inflate, reliabilityOf } from './engine.js';
import { modelOf, usesMargin } from './models.js';

const q = (c) => c ?? { query };
const RATED_KINDS = ['tournament', 'league'];
const MODEL_VERSION = 1;

/** The sets' points when the sheet carries them (6-4 6-3 is 12-7 on points), else null so the game's score is used. */
const setPoints = (totals) => {
  const sets = Array.isArray(totals?.sets) ? totals.sets.filter((s) => Number.isFinite(s?.home) && Number.isFinite(s?.away)) : [];
  return sets.length ? [sets.reduce((a, s) => a + s.home, 0), sets.reduce((a, s) => a + s.away, 0)] : null;
};

async function eligibleUsers(ids, c) {
  if (!ids.length) return new Set();
  return new Set((await q(c).query(`SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND ${NOT_YOUTH_SQL} AND u.access_status = 'approved'`, [ids])).rows.map((r) => r.id));
}

/** Every verified game of a sport as engine input, plus where each came from (for the ledger). Deterministic for a given database state. */
export async function loadEvidence(sport, c) {
  const family = modelOf(sport), margin = usesMargin(family);
  const games = [], origin = new Map();

  const fx = (await q(c).query(
    `SELECT f.id, f.event_id, f.home_team_id AS home, f.away_team_id AS away, ss.home_score AS hs, ss.away_score AS "as", ss.totals,
            coalesce(f.finished_at, ss.published_at, f.scheduled_at) AS played_at
       FROM fixtures f
       JOIN events e ON e.id = f.event_id
       JOIN score_sheets ss ON ss.fixture_id = f.id AND ss.status = 'published'
       JOIN teams h ON h.id = f.home_team_id
       JOIN teams a ON a.id = f.away_team_id
      WHERE e.sport_id = $1 AND e.kind = ANY($2::text[]) AND ss.home_score IS NOT NULL AND ss.away_score IS NOT NULL
        AND h.owner_id IS DISTINCT FROM a.owner_id
      ORDER BY f.id`, [sport.id, RATED_KINDS])).rows;

  const sess = (await q(c).query(
    `SELECT s.id, s.event_id, coalesce(s.completed_at, s.scheduled_at) AS played_at,
            json_agg(json_build_object('user', p.user_id, 'position', en.position, 'score', en.score) ORDER BY en.id) AS entries
       FROM event_sessions s
       JOIN event_disciplines d ON d.id = s.discipline_id
       JOIN events e ON e.id = s.event_id
       JOIN event_session_entries en ON en.session_id = s.id AND en.result_status = 'finished' AND en.position IS NOT NULL AND en.participant_id IS NOT NULL
       JOIN event_participants p ON p.id = en.participant_id AND p.user_id IS NOT NULL
      WHERE d.sport_id = $1 AND s.status = 'completed' AND e.kind = ANY($2::text[]) AND coalesce(s.completed_at, s.scheduled_at) IS NOT NULL
      GROUP BY s.id ORDER BY s.id`, [sport.id, RATED_KINDS])).rows;

  // who stood on each side: verified appearances; a racket team of one or two with no appearances is a singles or doubles pair
  const ids = fx.map((f) => f.id);
  const apps = ids.length ? (await q(c).query(
    `SELECT fixture_id, team_id, user_id FROM match_appearances WHERE fixture_id = ANY($1::uuid[]) AND archived_at IS NULL AND verified_at IS NOT NULL AND status IN ('started','substitute_on') ORDER BY user_id`, [ids])).rows : [];
  const side = new Map();
  for (const a of apps) { const k = `${a.fixture_id}:${a.team_id}`; side.set(k, [...(side.get(k) ?? []), a.user_id]); }
  const pairTeams = family === 'racket' ? new Map() : null;
  if (pairTeams) {
    const teams = [...new Set(fx.flatMap((f) => [f.home, f.away]))];
    for (const r of (await q(c).query("SELECT team_id, array_agg(user_id ORDER BY user_id) AS users FROM team_members WHERE team_id = ANY($1::uuid[]) AND status = 'active' AND role IN ('captain','player') GROUP BY team_id", [teams])).rows) if (r.users.length <= 2) pairTeams.set(r.team_id, r.users);
  }

  const everyone = [...new Set([...side.values(), ...(pairTeams ? [...pairTeams.values()] : []), ...sess.flatMap((s) => s.entries.map((e) => e.user))].flat())];
  const ok = await eligibleUsers(everyone, c);
  const keep = (users) => (users ?? []).filter((u) => ok.has(u));

  for (const f of fx) {
    const a = keep(side.get(`${f.id}:${f.home}`) ?? pairTeams?.get(f.home)), b = keep(side.get(`${f.id}:${f.away}`) ?? pairTeams?.get(f.away));
    if (!a.length || !b.length) continue;
    const pts = family === 'racket' ? setPoints(f.totals) : null;
    games.push({ id: f.id, played_at: new Date(f.played_at).toISOString(), sides: [{ players: a, score: f.hs }, { players: b, score: f.as }], margin: margin ? (pts ?? [f.hs, f.as]) : [null, null] });
    origin.set(f.id, { kind: 'fixture', event_id: f.event_id });
  }
  for (const s of sess) {
    const list = s.entries.filter((e) => ok.has(e.user));
    if (list.length < 2 || new Set(list.map((e) => e.user)).size !== list.length) continue;
    const played_at = new Date(s.played_at).toISOString();
    if (list.length === 2 && list.every((e) => e.score != null)) { // a match inside a multi-sport programme
      games.push({ id: s.id, played_at, sides: [{ players: [list[0].user], score: list[0].score }, { players: [list[1].user], score: list[1].score }], margin: margin ? [list[0].score, list[1].score] : [null, null] });
    } else games.push({ id: s.id, played_at, field: list.map((e) => ({ player: e.user, position: e.position })) });
    origin.set(s.id, { kind: 'session', event_id: s.event_id });
  }
  return { games, origin, family };
}

const hashOf = (family, games) => createHash('sha256').update(JSON.stringify([MODEL_VERSION, family, games.map((g) => [g.id, g.played_at, g.sides ?? g.field, g.margin ?? null]).sort((x, y) => (x[0] < y[0] ? -1 : 1))])).digest('hex');

/**
 * Replay a sport's verified games and store the outcome. An unchanged evidence hash adds nothing. A changed one adds a run; earlier runs and their
 * per-game changes are kept, and a person whose evidence no longer stands is marked 'void', never deleted.
 */
export async function recomputeSport(sport, { reason = 'sweep', userId = null } = {}) {
  const { games, origin, family } = await loadEvidence(sport);
  const input_hash = hashOf(family, games);
  const last = await one('SELECT id, input_hash FROM skill_rating_runs WHERE sport_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [sport.id]);
  if (last?.input_hash === input_hash) return { sport: sport.slug, changed: false, run_id: last.id, games: games.length };
  if (!last && !games.length) return { sport: sport.slug, changed: false, run_id: null, games: 0 };
  const { ratings, changes } = replay(games);
  return tx(async (c) => {
    const run = (await c.query(
      'INSERT INTO skill_rating_runs(sport_id, input_hash, games_n, players_n, model, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [sport.id, input_hash, games.length, ratings.size, family, last ? reason : 'first', userId])).rows[0];
    const users = [...ratings.keys()];
    await c.query("UPDATE skill_ratings SET status='void', updated_at=now() WHERE sport_id=$1 AND status='active' AND NOT (user_id = ANY($2::uuid[]))", [sport.id, users]);
    for (const [u, s] of ratings) {
      await c.query(
        `INSERT INTO skill_ratings(sport_id, user_id, rating, rd, sigma, games, wins, losses, draws, peak_rating, last_played_at, status, run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11 / 1000.0),'active',$12)
         ON CONFLICT (sport_id, user_id) DO UPDATE SET rating=$3, rd=$4, sigma=$5, games=$6, wins=$7, losses=$8, draws=$9, peak_rating=$10, last_played_at=to_timestamp($11 / 1000.0), status='active', run_id=$12, updated_at=now()`,
        [sport.id, u, s.r, s.rd, s.sigma, s.games, s.wins, s.losses, s.draws, s.peak, s.last, run.id]);
    }
    for (const ch of changes) {
      const o = origin.get(ch.game_id);
      await c.query(
        `INSERT INTO skill_rating_changes(run_id, sport_id, user_id, game_kind, game_id, event_id, played_at, result, expected, before_r, before_rd, after_r, after_rd, opponent_r)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [run.id, sport.id, ch.user_id, o.kind, ch.game_id, o.event_id, ch.played_at, ch.result, ch.expected, ch.before_r, ch.before_rd, ch.after_r, ch.after_rd, ch.opponent_r]);
    }
    return { sport: sport.slug, changed: true, run_id: run.id, games: games.length, players: ratings.size };
  });
}

/** Every sport that has any verified game or an earlier run (so a sport whose evidence was withdrawn is re-run too). */
export async function recomputeAll(reason = 'sweep', { sportId } = {}) {
  const sports = await many(
    `SELECT s.id, s.slug, s.name, s.scoring, s.category FROM sports s
      WHERE ($1::uuid IS NULL OR s.id = $1)
        AND (EXISTS (SELECT 1 FROM skill_rating_runs r WHERE r.sport_id = s.id)
          OR EXISTS (SELECT 1 FROM events e JOIN score_sheets ss ON ss.status='published' JOIN fixtures f ON f.id = ss.fixture_id AND f.event_id = e.id WHERE e.sport_id = s.id)
          OR EXISTS (SELECT 1 FROM event_sessions es JOIN event_disciplines d ON d.id = es.discipline_id WHERE d.sport_id = s.id AND es.status = 'completed'))
      ORDER BY s.slug`, [sportId ?? null]);
  let runs = 0;
  for (const s of sports) {
    try { if ((await recomputeSport(s, { reason })).changed) runs++; } catch (e) { console.error('[ratings]', s.slug, e.message); } // one sport never stops the rest
  }
  return runs;
}
/** Called after a result is approved, corrected or superseded; never blocks or fails the caller. */
export const onRatingsEvidenceChanged = (sportId) => recomputeAll('correction', { sportId }).catch(() => 0);
export const onEventResultsChanged = async (eventId) => onRatingsEvidenceChanged((await one('SELECT sport_id FROM events WHERE id=$1', [eventId]).catch(() => null))?.sport_id);

let lastSweep = 0;
/** Worker step: the worker ticks often, so re-check the evidence at most hourly; an unchanged hash writes nothing. */
export const hourlyRatingSweep = async () => {
  if (Date.now() - lastSweep < 3600_000) return 0;
  lastSweep = Date.now();
  return recomputeAll('sweep');
};

const row = (r, asOf) => r && ({
  sport: { id: r.sport_id, slug: r.sport_slug, name: r.sport_name, emoji: r.sport_emoji },
  ...present({ r: r.rating, rd: r.rd, sigma: r.sigma, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws, peak: r.peak_rating, last: r.last_played_at && new Date(r.last_played_at).getTime() }, { asOf }),
  last_played_at: r.last_played_at, as_of: r.updated_at,
});

/** A person's current ratings, one per sport. Never returns a youth account's (they are not rated, so there is nothing to return). */
export async function ratingsOf(userId, { sportId } = {}, c) {
  const asOf = new Date().toISOString();
  const rows = (await q(c).query(
    `SELECT r.*, s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji
       FROM skill_ratings r JOIN sports s ON s.id = r.sport_id JOIN users u ON u.id = r.user_id
      WHERE r.user_id = $1 AND r.status = 'active' AND ($2::uuid IS NULL OR r.sport_id = $2) AND ${NOT_YOUTH_SQL}
      ORDER BY r.games DESC, s.name`, [userId, sportId ?? null])).rows;
  return rows.map((r) => row(r, asOf));
}

/** The computed level (and its 4-step bucket) for open-game matching, only when it is reliable; otherwise null and the stated level stands. */
export async function reliableLevels(userId, c, { sportId } = {}) {
  const rows = (await q(c).query(
    `SELECT r.sport_id, r.rating, r.rd, r.sigma, r.last_played_at FROM skill_ratings r JOIN users u ON u.id = r.user_id
      WHERE r.user_id=$1 AND r.status='active' AND ($2::uuid IS NULL OR r.sport_id=$2) AND ${NOT_YOUTH_SQL}`, [userId, sportId ?? null])).rows;
  const out = new Map();
  for (const r of rows) {
    const rd = r.last_played_at ? inflate({ rd: r.rd, sigma: r.sigma }, (Date.now() - new Date(r.last_played_at).getTime()) / 86400000) : r.rd;
    if (rd > RELIABLE_RD) continue;
    const level = toLevel(r.rating);
    out.set(r.sport_id, { level, bucket: bucketOf(level) });
  }
  return out;
}
export const reliableLevel = async (userId, sportId, c) => (await reliableLevels(userId, c, { sportId })).get(sportId) ?? null;

/** One person's rating history in a sport: level after each game (newest run). With `ledger` also the evidence behind each move (owner and staff only). */
export async function historyOf(userId, sportId, { ledger, limit, offset }, c) {
  const run = (await q(c).query('SELECT run_id FROM skill_ratings WHERE user_id=$1 AND sport_id=$2 AND status=\'active\'', [userId, sportId])).rows[0];
  if (!run) return { points: [], total: 0 };
  const total = (await q(c).query('SELECT count(*)::int AS n FROM skill_rating_changes WHERE run_id=$1 AND user_id=$2', [run.run_id, userId])).rows[0].n;
  const rows = (await q(c).query(
    `SELECT ch.played_at, ch.after_r, ch.after_rd, ch.before_r, ch.result, ch.expected, ch.opponent_r, ch.game_kind, ch.game_id, ch.event_id, e.name AS event_name
       FROM skill_rating_changes ch LEFT JOIN events e ON e.id = ch.event_id
      WHERE ch.run_id=$1 AND ch.user_id=$2 ORDER BY ch.played_at DESC, ch.id DESC LIMIT $3 OFFSET $4`, [run.run_id, userId, limit, offset])).rows;
  return {
    total,
    points: rows.map((r) => ({
      played_at: r.played_at, level: toLevel(r.after_r), delta: Math.round((toLevel(r.after_r) - toLevel(r.before_r)) * 100) / 100,
      ...(ledger ? { result: r.result, expected_win_chance: Math.round(r.expected * 100), opponent_level: toLevel(r.opponent_r), event: r.event_id ? { id: r.event_id, name: r.event_name } : null, game: { kind: r.game_kind, id: r.game_id } } : {}),
    })),
  };
}

/** One verified game's effect on a person's level, in the newest run (the evidence ledger row). Null when there is no such game. */
export async function changeOf(userId, sportId, gameId, c) {
  const run = (await q(c).query("SELECT run_id FROM skill_ratings WHERE user_id=$1 AND sport_id=$2 AND status='active'", [userId, sportId])).rows[0];
  if (!run) return null;
  const r = (await q(c).query(
    `SELECT ch.*, e.name AS event_name FROM skill_rating_changes ch LEFT JOIN events e ON e.id = ch.event_id
      WHERE ch.run_id=$1 AND ch.user_id=$2 AND ch.game_id=$3 ORDER BY ch.id DESC LIMIT 1`, [run.run_id, userId, gameId])).rows[0];
  if (!r) return null;
  const before = toLevel(r.before_r), after = toLevel(r.after_r);
  return {
    played_at: r.played_at, result: r.result, event: r.event_id ? { id: r.event_id, name: r.event_name } : null, game: { kind: r.game_kind, id: r.game_id },
    level_before: before, level_after: after, delta: Math.round((after - before) * 100) / 100,
    expected_win_chance: Math.round(r.expected * 100), opponent_level: toLevel(r.opponent_r),
    reliability_before: reliabilityOf(r.before_rd), reliability_after: reliabilityOf(r.after_rd),
  };
}
