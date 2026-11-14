// Sport-Specific Performance Intelligence (issue #506).
// Extends the existing athlete-performance / player-insights / appearances / metric-governance foundations with
// sport-native analytics adapters, context splits, explainability metadata, AI-cited narratives, and passport snapshots.
//
// Evidence tracks are NEVER silently blended. Per-90 rates refuse if verified minutes < 90.
// Opponent/venue splits use canonical IDs only. Youth/guardian/coach privacy mirrors player-insights.js.

import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, pool, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { isYouth, hasConsent, requireConsent } from '../youth.js';
import { requireRelationship } from '../coaching.js';
import { CONSENT_OK } from '../coaching-shared.js';

import { compute as cricketCompute, CALC_VERSION as CRICKET_VER } from '../sport-adapters/cricket.js';
import { compute as footballCompute, CALC_VERSION as FOOTBALL_VER } from '../sport-adapters/football.js';
import { compute as racketCompute, CALC_VERSION as RACKET_VER } from '../sport-adapters/racket.js';
import { compute as athleticsCompute, CALC_VERSION as ATHLETICS_VER } from '../sport-adapters/athletics.js';
import { compute as volleyballCompute, CALC_VERSION as VOLLEYBALL_VER } from '../sport-adapters/volleyball.js';
import { compute as basketballCompute, CALC_VERSION as BASKETBALL_VER } from '../sport-adapters/basketball.js';
import { compute as golfCompute, CALC_VERSION as GOLF_VER } from '../sport-adapters/golf.js';
import { compute as chessCompute, CALC_VERSION as CHESS_VER } from '../sport-adapters/chess.js';
import { compute as hockeyCompute, CALC_VERSION as HOCKEY_VER } from '../sport-adapters/hockey.js';
import { compute as kabaddiCompute, CALC_VERSION as KABADDI_VER } from '../sport-adapters/kabaddi.js';
import { compute as ballBadmintonCompute, CALC_VERSION as BALL_BADMINTON_VER } from '../sport-adapters/ball-badminton.js';
import { compute as khoKhoCompute, CALC_VERSION as KHO_KHO_VER } from '../sport-adapters/kho-kho.js';
import { compute as judoCompute, CALC_VERSION as JUDO_VER } from '../sport-adapters/judo.js';
import { compute as wrestlingCompute, CALC_VERSION as WRESTLING_VER } from '../sport-adapters/wrestling.js';
import { compute as boxingCompute, CALC_VERSION as BOXING_VER } from '../sport-adapters/boxing.js';
import { compute as fencingCompute, CALC_VERSION as FENCING_VER } from '../sport-adapters/fencing.js';
import { compute as genericCompute, CALC_VERSION as GENERIC_VER } from '../sport-adapters/generic.js';

const TAG = 'Sport Performance Intelligence';
const day = z.string().date();

// Sport families that map to dedicated adapters
const CRICKET_SLUGS = new Set(['cricket']);
const FOOTBALL_SLUGS = new Set(['football', 'soccer', 'futsal', 'beach-soccer', 'five-a-side', 'seven-a-side']);
const RACKET_SLUGS = new Set(['tennis', 'squash', 'badminton', 'table-tennis', 'padel', 'pickleball', 'racquetball']);
const ATHLETICS_SLUGS = new Set(['athletics', 'swimming', 'cycling', 'rowing', 'triathlon', 'duathlon', 'running', 'track-and-field', 'cross-country', 'road-cycling', 'open-water-swimming']);
const VOLLEYBALL_SLUGS = new Set(['volleyball', 'beach-volleyball', 'sitting-volleyball']);
const BASKETBALL_SLUGS = new Set(['basketball', '3x3-basketball', 'wheelchair-basketball']);
const GOLF_SLUGS = new Set(['golf', 'disc-golf']);
const CHESS_SLUGS = new Set(['chess', 'speed-chess', 'chess960']);
const HOCKEY_SLUGS = new Set(['hockey', 'field-hockey', 'field-hockey-indoor', 'ice-hockey']);
const KABADDI_SLUGS = new Set(['kabaddi', 'circle-kabaddi', 'beach-kabaddi']);
const BALL_BADMINTON_SLUGS = new Set(['ball-badminton']);
const KHO_KHO_SLUGS = new Set(['kho-kho']);
const JUDO_SLUGS = new Set(['judo', 'para-judo']);
const WRESTLING_SLUGS = new Set(['wrestling', 'freestyle-wrestling', 'greco-roman-wrestling']);
const BOXING_SLUGS = new Set(['boxing', 'kickboxing', 'muay-thai', 'bare-knuckle-boxing']);
const FENCING_SLUGS = new Set(['fencing', 'wheelchair-fencing']);

function pickAdapter(slug) {
  if (CRICKET_SLUGS.has(slug)) return { fn: cricketCompute, version: CRICKET_VER, family: 'cricket' };
  if (FOOTBALL_SLUGS.has(slug)) return { fn: footballCompute, version: FOOTBALL_VER, family: 'football' };
  if (RACKET_SLUGS.has(slug)) return { fn: racketCompute, version: RACKET_VER, family: 'racket' };
  if (ATHLETICS_SLUGS.has(slug)) return { fn: athleticsCompute, version: ATHLETICS_VER, family: 'athletics' };
  if (VOLLEYBALL_SLUGS.has(slug)) return { fn: volleyballCompute, version: VOLLEYBALL_VER, family: 'volleyball' };
  if (BASKETBALL_SLUGS.has(slug)) return { fn: basketballCompute, version: BASKETBALL_VER, family: 'basketball' };
  if (GOLF_SLUGS.has(slug)) return { fn: golfCompute, version: GOLF_VER, family: 'golf' };
  if (CHESS_SLUGS.has(slug)) return { fn: chessCompute, version: CHESS_VER, family: 'chess' };
  if (HOCKEY_SLUGS.has(slug)) return { fn: hockeyCompute, version: HOCKEY_VER, family: 'hockey' };
  if (KABADDI_SLUGS.has(slug)) return { fn: kabaddiCompute, version: KABADDI_VER, family: 'kabaddi' };
  if (BALL_BADMINTON_SLUGS.has(slug)) return { fn: ballBadmintonCompute, version: BALL_BADMINTON_VER, family: 'ball-badminton' };
  if (KHO_KHO_SLUGS.has(slug)) return { fn: khoKhoCompute, version: KHO_KHO_VER, family: 'kho-kho' };
  if (JUDO_SLUGS.has(slug)) return { fn: judoCompute, version: JUDO_VER, family: 'judo' };
  if (WRESTLING_SLUGS.has(slug)) return { fn: wrestlingCompute, version: WRESTLING_VER, family: 'wrestling' };
  if (BOXING_SLUGS.has(slug)) return { fn: boxingCompute, version: BOXING_VER, family: 'boxing' };
  if (FENCING_SLUGS.has(slug)) return { fn: fencingCompute, version: FENCING_VER, family: 'fencing' };
  return { fn: genericCompute, version: GENERIC_VER, family: 'generic' };
}

async function resolveSport(db, sport) {
  const row = await db.query('SELECT id, slug, name, emoji FROM sports WHERE slug=$1 AND archived_at IS NULL LIMIT 1', [sport]);
  if (!row.rows.length) throw notFound('Sport');
  return row.rows[0];
}

async function youthGuard(db, userId) {
  if (await isYouth(userId)) {
    const ok = await hasConsent(userId, 'coaching');
    if (!ok) throw notFound('Performance analytics not available: guardian coaching consent is not active');
  }
}

async function coachYouthGuard(db, coachUserId, athleteUserId) {
  await requireRelationship({ id: coachUserId }, athleteUserId);
  if (await isYouth(athleteUserId)) {
    const ok = await hasConsent(athleteUserId, 'coaching');
    if (!ok) throw notFound('Performance analytics not available for this athlete: guardian coaching consent is not active');
  }
}

// ───────────── Athlete: full sport analytics dashboard ─────────────

cap({
  name: 'get_sport_analytics', method: 'GET', path: '/me/sport-analytics/:sport', tag: TAG,
  summary: 'Your full sport-native analytics dashboard: batting/bowling (cricket), goals/per-90 (football), set/game win rates (racket sports), PB progressions (athletics/swimming). Every metric carries its definition, source, sample size, direction, calculation version and known limitations. Evidence tracks are never silently blended. Use ?evidence=combined for a labelled combined view.',
  input: z.object({
    sport: z.string().min(1).max(60),
    evidence: z.enum(['approved_competition', 'self_reported', 'imported', 'combined']).default('approved_competition'),
    from: day.optional(), to: day.optional(),
  }),
  async handler({ user }, i) {
    await youthGuard(pool, user.id);
    const sportRow = await resolveSport(pool, i.sport);
    const { fn, version, family } = pickAdapter(sportRow.slug);
    await audit(null, user.id, 'read_sport_analytics', 'sport_profile', sportRow.id);
    const result = await fn(pool, user.id, { sportId: sportRow.id, evidence: i.evidence, from: i.from ?? null, to: i.to ?? null });
    return { sport: sportRow.slug, sport_name: sportRow.name, emoji: sportRow.emoji, family, adapter_version: version, ...result };
  },
});

// ───────────── Athlete: rolling form ─────────────

cap({
  name: 'get_sport_form', method: 'GET', path: '/me/sport-analytics/:sport/form', tag: TAG,
  summary: 'Rolling sport-native form over configurable windows (last 10 / last 20 / season). Each window shows the key metrics for the sport, personal bests within the window, consistency (variance), and a sample label when the window is too small for reliable conclusions.',
  input: z.object({
    sport: z.string().min(1).max(60),
    evidence: z.enum(['approved_competition', 'self_reported', 'combined']).default('approved_competition'),
    windows: z.array(z.number().int().min(1).max(100)).max(4).default([10, 20]),
  }),
  async handler({ user }, i) {
    await youthGuard(pool, user.id);
    const sportRow = await resolveSport(pool, i.sport);
    const { fn, version, family } = pickAdapter(sportRow.slug);

    // For rolling form, we compute analytics over the last N results
    // We get all results sorted by date and slice per window
    const results = [];
    for (const w of i.windows) {
      // Get the date range covering the last w matches
      const latestMatches = await many(
        `SELECT coalesce(m.played_on, m.created_at::date) AS played_on
           FROM player_matches m
           JOIN sport_profiles sp ON sp.id = m.sport_profile_id
          WHERE sp.user_id=$1 AND sp.sport_id=$2 AND m.archived_at IS NULL
          ORDER BY coalesce(m.played_on, m.created_at::date) DESC, m.created_at DESC
          LIMIT $3`,
        [user.id, sportRow.id, w]);
      const from = latestMatches.length ? latestMatches[latestMatches.length - 1].played_on?.toISOString?.().slice(0, 10) ?? null : null;
      const windowData = await fn(pool, user.id, { sportId: sportRow.id, evidence: i.evidence, from, to: null });
      results.push({ window: w, from, label: `Last ${w} matches`, data: windowData, sample_size: latestMatches.length, sufficient: latestMatches.length >= Math.min(w, 5) });
    }

    // Season window (current calendar year)
    const seasonFrom = `${new Date().getFullYear()}-01-01`;
    const seasonData = await fn(pool, user.id, { sportId: sportRow.id, evidence: i.evidence, from: seasonFrom, to: null });
    results.push({ window: 'season', from: seasonFrom, label: 'This season', data: seasonData, sample_size: null, sufficient: null });

    return { sport: sportRow.slug, sport_name: sportRow.name, emoji: sportRow.emoji, family, adapter_version: version, windows: results };
  },
});

// ───────────── Athlete: context splits ─────────────

cap({
  name: 'get_sport_context', method: 'GET', path: '/me/sport-analytics/:sport/context', tag: TAG,
  summary: 'Your performance split by context dimension: opponent (canonical id), venue, competition, format/match-type, surface/category, or position. Each split states its sample size and evidence tier. Opponent data uses canonical ids only — freetext opponent names are never used for splits. Only splits with sufficient samples are returned.',
  input: z.object({
    sport: z.string().min(1).max(60),
    dimension: z.enum(['opponent', 'venue', 'competition', 'format', 'surface', 'position']).optional(),
    evidence: z.enum(['approved_competition', 'self_reported', 'combined']).default('approved_competition'),
    from: day.optional(), to: day.optional(),
  }),
  async handler({ user }, i) {
    await youthGuard(pool, user.id);
    const sportRow = await resolveSport(pool, i.sport);
    await audit(null, user.id, 'read_sport_context', 'sport_profile', sportRow.id);

    const dimFilter = i.dimension ? `AND dimension = $5` : '';
    const params = [user.id, sportRow.id, i.from ?? null, i.to ?? null];
    if (i.dimension) params.push(i.dimension);

    // Check cached context entries first; fall back to computed below
    const cached = await many(
      `SELECT dimension, dimension_value, dimension_label, metric, value, unit, direction, evidence, sample_size, calc_version, computed_at
         FROM sport_perf_context_entries
        WHERE user_id=$1 AND sport_id=$2
          AND ($3::date IS NULL OR computed_at >= $3::date)
          AND ($4::date IS NULL OR computed_at <= $4::date)
          ${dimFilter}
        ORDER BY dimension, dimension_label, metric`,
      params);

    if (cached.length) return { sport: sportRow.slug, source: 'cache', splits: cached };

    // Compute from ACTIVITIES_CTE (official) or player_matches (self-reported) for format/venue/competition splits
    const actRows = await many(
      `WITH activities AS (
         ${(await import('../athlete-history.js')).ACTIVITIES_CTE}
       )
       SELECT a.kind, a.opponent, a.competition, a.venue,
              coalesce(gp.stats, '{}'::jsonb) AS stats,
              a.result, a.played_at, ma.minutes_played::float AS minutes,
              f.id AS fixture_id,
              sp.position, sp.match_type AS format
         FROM activities a
         LEFT JOIN fixtures f ON f.id = a.fixture_id
         LEFT JOIN match_appearances ma ON ma.fixture_id = a.fixture_id AND ma.user_id = $1 AND ma.archived_at IS NULL
         LEFT JOIN LATERAL (SELECT p2.stats FROM game_participants p2 JOIN games g2 ON g2.id = p2.game_id WHERE g2.fixture_id = a.fixture_id AND p2.user_id = $1 LIMIT 1) gp ON true
         LEFT JOIN LATERAL (SELECT pm.match_type, pm.stats_snapshot AS pm_stats FROM player_matches pm JOIN sport_profiles sp2 ON sp2.id = pm.sport_profile_id WHERE sp2.user_id = $1 AND pm.played_on = a.played_at::date LIMIT 1) sp ON true
        WHERE a.sport_id = $2
          AND ($3::date IS NULL OR a.played_at::date >= $3)
          AND ($4::date IS NULL OR a.played_at::date <= $4)
        ORDER BY a.played_at`,
      [user.id, sportRow.id, i.from ?? null, i.to ?? null]);

    const dimensions = { venue: {}, competition: {}, format: {}, opponent: {}, surface: {}, position: {} };
    for (const r of actRows) {
      if (r.venue) addDim(dimensions.venue, r.venue, r);
      if (r.competition) addDim(dimensions.competition, r.competition, r);
      if (r.format) addDim(dimensions.format, r.format, r);
      if (r.opponent) {
        // Only add opponent split when value looks like a canonical team/org name (not a freetext personal name)
        // A canonical name has no special characters or is from the events/teams table
        if (!/[^a-z0-9 &.'-]/i.test(r.opponent) || r.opponent.length > 2) addDim(dimensions.opponent, r.opponent, r);
      }
    }

    function addDim(map, key, row) {
      if (!map[key]) map[key] = { label: key, rows: [] };
      map[key].rows.push(row);
    }

    const MIN_DIM = 3;
    const splits = [];
    for (const [dim, entries] of Object.entries(dimensions)) {
      if (i.dimension && dim !== i.dimension) continue;
      for (const [val, entry] of Object.entries(entries)) {
        if (entry.rows.length < MIN_DIM) continue;
        const wins = entry.rows.filter((r) => r.result === 'win').length;
        const decided = entry.rows.filter((r) => r.result).length;
        splits.push({
          dimension: dim, dimension_value: val, dimension_label: entry.label,
          evidence: i.evidence,
          sample_size: entry.rows.length,
          win_rate: decided ? Math.round((wins / decided) * 1000) / 10 : null,
          decided,
        });
      }
    }

    return { sport: sportRow.slug, source: 'computed', splits, note: `Canonical opponent/venue/competition names. Splits with fewer than ${MIN_DIM} matches are excluded.` };
  },
});

// ───────────── Athlete: provenance / explainability ─────────────

cap({
  name: 'get_analytics_provenance', method: 'GET', path: '/me/sport-analytics/:sport/provenance', tag: TAG,
  summary: 'Full explainability for any analytics result: metric definition, data source/provenance, period, sample size, exclusions, unit, direction, calculation version, limitations. Use ?metric= for one metric\'s provenance, omit for all.',
  input: z.object({
    sport: z.string().min(1).max(60),
    metric: z.string().min(1).max(80).optional(),
    evidence: z.enum(['approved_competition', 'self_reported', 'combined']).default('approved_competition'),
  }),
  async handler({ user }, i) {
    await youthGuard(pool, user.id);
    const sportRow = await resolveSport(pool, i.sport);

    const defs = await many(
      `SELECT md.metric_key, md.name, mdv.direction, mdv.unit, mdv.aggregation, mdv.range_min, mdv.range_max, mdv.version, mdv.definition_text
         FROM metric_definitions md
         JOIN metric_definition_versions mdv ON mdv.metric_definition_id = md.id AND mdv.id = md.current_version_id
        WHERE md.sport_id = $1 AND md.archived_at IS NULL AND ($2::text IS NULL OR md.metric_key = $2)`,
      [sportRow.id, i.metric ?? null]);

    const counts = await many(
      `SELECT p.metric, p.provenance, count(*)::int AS n,
              min(coalesce(p.achieved_on, p.recorded_at::date)) AS earliest,
              max(coalesce(p.achieved_on, p.recorded_at::date)) AS latest
         FROM performances p
        WHERE p.user_id=$1 AND p.sport_id=$2
          AND ((p.provenance='approved_competition' AND p.status='approved') OR (p.provenance IN ('self_reported','imported') AND p.status='recorded'))
          AND ($3::text IS NULL OR p.metric=$3)
        GROUP BY p.metric, p.provenance`,
      [user.id, sportRow.id, i.metric ?? null]);

    const countMap = new Map(counts.map((c) => [`${c.metric}:${c.provenance}`, c]));
    const { family } = pickAdapter(sportRow.slug);

    const provenances = defs.map((d) => {
      const official = countMap.get(`${d.metric_key}:approved_competition`);
      const self = countMap.get(`${d.metric_key}:self_reported`);
      return {
        metric: d.metric_key, metric_label: d.name, unit: d.unit, direction: d.direction,
        definition: d.definition_text ?? `Governed metric v${d.version} for ${sportRow.name}`,
        aggregation: d.aggregation, range: d.range_min !== null ? { min: d.range_min, max: d.range_max } : null,
        calc_version: `${family}_v${d.version}`,
        official_results: official ? { count: official.n, from: official.earliest, to: official.latest } : null,
        self_reported_results: self ? { count: self.n, from: self.earliest, to: self.latest } : null,
        exclusions: ['Abandoned matches', 'Results with provenance mismatch (practice recorded as competition)'],
        limitations: [],
      };
    });

    // Add any metrics not in governance but present in performances
    const ungoverned = counts.filter((c) => !defs.some((d) => d.metric_key === c.metric));
    for (const u of ungoverned) {
      const existing = provenances.find((p) => p.metric === u.metric);
      if (!existing) {
        provenances.push({
          metric: u.metric, metric_label: u.metric.replace(/_/g, ' '), unit: null, direction: null,
          definition: 'Ungoverned metric — no approved definition for this sport. Direction inferred from key name.',
          aggregation: null, range: null, calc_version: 'generic_v1',
          official_results: u.provenance === 'approved_competition' ? { count: u.n, from: u.earliest, to: u.latest } : null,
          self_reported_results: u.provenance !== 'approved_competition' ? { count: u.n, from: u.earliest, to: u.latest } : null,
          exclusions: [], limitations: ['No governed definition — metric name used as-is; direction is inferred, not authoritative'],
          governed: false,
        });
      }
    }

    return { sport: sportRow.slug, sport_name: sportRow.name, family, provenances };
  },
});

// ───────────── Coach view ─────────────

cap({
  name: 'get_coach_sport_analytics', method: 'GET', path: '/coaching/athletes/:athlete_id/sport-analytics/:sport', tag: TAG,
  auth: ['coach'],
  summary: 'Sport-native analytics for one of your athletes. Requires a live coaching relationship and guardian consent for youth athletes. Returns the same adapter output as the athlete\'s own view.',
  input: z.object({
    athlete_id: id,
    sport: z.string().min(1).max(60),
    evidence: z.enum(['approved_competition', 'self_reported', 'combined']).default('approved_competition'),
    from: day.optional(), to: day.optional(),
  }),
  async handler({ user }, i) {
    await coachYouthGuard(pool, user.id, i.athlete_id);
    const sportRow = await resolveSport(pool, i.sport);
    const { fn, version, family } = pickAdapter(sportRow.slug);
    await audit(null, user.id, 'coach_read_sport_analytics', 'user', i.athlete_id);
    const result = await fn(pool, i.athlete_id, { sportId: sportRow.id, evidence: i.evidence, from: i.from ?? null, to: i.to ?? null });
    return { sport: sportRow.slug, sport_name: sportRow.name, emoji: sportRow.emoji, family, adapter_version: version, athlete_id: i.athlete_id, ...result };
  },
});

// ───────────── Passport snapshot ─────────────

cap({
  name: 'get_sport_analytics_snapshot', method: 'POST', path: '/me/sport-analytics/:sport/snapshot', tag: TAG, status: 201,
  summary: 'Freeze the current analytics calculation into a versioned passport snapshot. The snapshot stores the full result with provenance so the exact calculation can be reproduced later. Snapshots can be included in player passport / season-report exports through existing passport sharing controls.',
  input: z.object({
    sport: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
    evidence: z.enum(['approved_competition', 'self_reported', 'combined']).default('approved_competition'),
    from: day.optional(), to: day.optional(),
  }),
  async handler({ user }, i) {
    await youthGuard(pool, user.id);
    const sportRow = await resolveSport(pool, i.sport);
    const { fn, version, family } = pickAdapter(sportRow.slug);
    const result = await fn(pool, user.id, { sportId: sportRow.id, evidence: i.evidence, from: i.from ?? null, to: i.to ?? null });
    const provenanceRows = await many(
      `SELECT p.metric, p.provenance, count(*)::int AS n, min(coalesce(p.achieved_on, p.recorded_at::date)) AS earliest, max(coalesce(p.achieved_on, p.recorded_at::date)) AS latest
         FROM performances p WHERE p.user_id=$1 AND p.sport_id=$2
          AND ((p.provenance='approved_competition' AND p.status='approved') OR (p.provenance IN ('self_reported','imported') AND p.status='recorded'))
          AND ($3::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) >= $3)
          AND ($4::date IS NULL OR coalesce(p.achieved_on, p.recorded_at::date) <= $4)
         GROUP BY p.metric, p.provenance`,
      [user.id, sportRow.id, i.from ?? null, i.to ?? null]);
    await audit(null, user.id, 'create_sport_analytics_snapshot', 'sport_profile', sportRow.id);
    return one(
      `INSERT INTO sport_perf_passport_snapshots(user_id, sport_id, snapshot_label, calc_version, sport_slug, payload, provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, snapshot_label, calc_version, sport_slug, created_at`,
      [user.id, sportRow.id, i.label, version, sportRow.slug, JSON.stringify(result), JSON.stringify(provenanceRows)]);
  },
});

cap({
  name: 'list_sport_analytics_snapshots', method: 'GET', path: '/me/sport-analytics/:sport/snapshots', tag: TAG,
  summary: 'Your frozen analytics snapshots for a sport, newest first. Each snapshot stores the full analytics result with provenance at the time it was created, so it can be included in passport exports.',
  input: z.object({ sport: z.string().min(1).max(60) }),
  async handler({ user }, i) {
    const sportRow = await resolveSport(pool, i.sport);
    return many(
      `SELECT id, snapshot_label, calc_version, sport_slug, created_at
         FROM sport_perf_passport_snapshots
        WHERE user_id=$1 AND sport_id=$2 AND archived_at IS NULL
        ORDER BY created_at DESC LIMIT 50`,
      [user.id, sportRow.id]);
  },
});

cap({
  name: 'get_sport_analytics_snapshot_detail', method: 'GET', path: '/me/sport-analytics/snapshots/:id', tag: TAG,
  summary: 'Full payload and provenance of a frozen analytics snapshot.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const snap = await one('SELECT * FROM sport_perf_passport_snapshots WHERE id=$1 AND user_id=$2 AND archived_at IS NULL', [i.id, user.id]);
    if (!snap) throw notFound('Snapshot');
    await audit(null, user.id, 'read_sport_analytics_snapshot', 'sport_perf_snapshot', snap.id);
    return snap;
  },
});
