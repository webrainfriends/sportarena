import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, pool, tx } from '../db.js';
import { notFound, badRequest } from '../errors.js';
import { audit } from '../helpers.js';
import { sha256 } from '../crypto.js';
import { askJson, aiConfigured, aiModel, AI_RULES } from '../ai.js';
import { MIN_MATCHES, EVIDENCE, nice, round, loadSelf, loadOfficial, compare, selfRatingTrend } from '../benchmarks.js';
import { matchTypesFor } from '../match-template.js';
import { CONSENT_OK } from '../coaching-shared.js';
import { requireRelationship } from '../coaching.js';
import { guardianLink, isYouth, requireConsent } from '../youth.js';

const TAG = 'Player insights';
// Everything here is derived from one evidence track at a time (see src/benchmarks.js), for me and for the cohort alike, so a
// comparison is always like with like. Only aggregates leave this module: no other player's name, id or single match.

function formOf(matches) {
  const part = (xs) => {
    const decided = xs.filter((m) => m.result);
    const rated = xs.filter((m) => m.rating !== null);
    return { matches: xs.length, win_rate: decided.length ? round(decided.filter((m) => m.result === 'win').length / decided.length * 100, 0) : null, avg_rating: rated.length ? round(rated.reduce((a, m) => a + Number(m.rating), 0) / rated.length, 1) : null };
  };
  return { recent: part(matches.slice(0, 5)), previous: part(matches.slice(5, 10)) };
}

/** Plain rules over the numbers: used when AI is off or fails, and as the facts the model is asked to explain. */
function ruleInsights({ sport, me, form, scopes }) {
  const out = [];
  const best = scopes.find((s) => s.available) ?? null;
  if (best) {
    const where = best.scope === 'region' ? `players in ${best.label}` : best.scope === 'level' ? `${best.label} players` : `all ${sport} players here`;
    const strong = best.comparisons.filter((c) => c.percentile >= 75).sort((a, b) => b.percentile - a.percentile)[0];
    const weak = best.comparisons.filter((c) => c.key !== 'matches' && c.percentile <= 35).sort((a, b) => a.percentile - b.percentile)[0];
    if (strong) out.push({ tone: 'good', title: `${strong.label} is a strength`, body: `You are ahead of ${strong.percentile}% of ${where} (${strong.mine}${strong.unit === '%' ? '%' : ''} against a typical ${strong.cohort_median}${strong.unit === '%' ? '%' : ''}).` });
    if (weak) out.push({ tone: 'watch', title: `${weak.label} is the gap to close`, body: `You are ahead of only ${weak.percentile}% of ${where}. The middle player records ${weak.cohort_median}${weak.unit === '%' ? '%' : ''}; you record ${weak.mine}${weak.unit === '%' ? '%' : ''}.` });
  }
  const { recent, previous } = form;
  if (recent.matches >= 3 && previous.matches >= 3) {
    if (recent.win_rate !== null && previous.win_rate !== null && recent.win_rate !== previous.win_rate) out.push({ tone: recent.win_rate > previous.win_rate ? 'good' : 'watch', title: recent.win_rate > previous.win_rate ? 'Your results are improving' : 'Results have dipped lately', body: `You won ${recent.win_rate}% of your last ${recent.matches} matches, against ${previous.win_rate}% in the ${previous.matches} before.` });
    else if (recent.avg_rating !== null && previous.avg_rating !== null && recent.avg_rating !== previous.avg_rating) out.push({ tone: recent.avg_rating > previous.avg_rating ? 'good' : 'watch', title: recent.avg_rating > previous.avg_rating ? 'Your self-ratings are rising' : 'Your self-ratings have slipped', body: `Average rating ${recent.avg_rating} over your last ${recent.matches} matches, against ${previous.avg_rating} before.` });
  }
  if (!out.length) out.push({ tone: 'info', title: 'Keep logging', body: `${me.matches} ${sport} matches logged so far. Insights sharpen as you log more matches and as more players near you do.` });
  return out.slice(0, 5);
}

const aiSchema = z.object({
  headline: z.string().min(3).max(160),
  insights: z.array(z.object({ title: z.string().min(2).max(80), body: z.string().min(2).max(300), tone: z.enum(['good', 'watch', 'info']) })).min(1).max(5),
  next_step: z.string().min(3).max(260),
});
const AI_SHAPE = '{"headline": string, "insights": [{"title": string, "body": string, "tone": "good"|"watch"|"info"}], "next_step": string}';

async function narrate({ user, profile, facts, fallback }) {
  const hash = sha256(JSON.stringify({ facts, model: aiModel() }));
  const hit = await one('SELECT output FROM ai_outputs WHERE kind=$1 AND subject_id=$2 AND input_hash=$3', ['player_insights', profile.id, hash]);
  if (hit) return { ...hit.output, ai: true, cached: true };
  let out = null;
  if (aiConfigured()) {
    await audit(null, user.id, 'ai_player_insights', 'sport_profile', profile.id);
    out = await askJson({
      system: `You are a sports performance analyst writing for one amateur or club athlete. Compare their numbers with the cohort percentiles in the data and explain what they mean in plain, encouraging, specific language. Mention the region or sport cohort by name when you compare. Never give medical advice, never mention other individuals, and keep every claim traceable to the data. ${AI_RULES}`,
      user: `<data>${JSON.stringify(facts)}</data>`, schema: aiSchema, shape: AI_SHAPE, maxTokens: 700,
    });
  }
  if (!out) return { ...fallback, ai: false, cached: false };
  await pool.query('INSERT INTO ai_outputs(kind, subject_id, input_hash, model, output, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', ['player_insights', profile.id, hash, aiModel(), JSON.stringify(out), user.id]);
  return { ...out, ai: true, cached: false };
}

cap({
  name: 'list_regions', method: 'GET', path: '/regions', tag: TAG,
  summary: 'Cities and areas to pick from when saying where you play: the cities of listed venues plus areas other players already use. Type to narrow.',
  input: z.object({ q: z.string().max(60).optional() }),
  async handler(_ctx, i) {
    const q = `%${(i.q ?? '').trim().replace(/[%_\\]/g, '\\$&')}%`;
    return many(
      `SELECT name FROM (
         SELECT btrim(city) AS name, count(*) AS n FROM venues WHERE city IS NOT NULL AND btrim(city) <> '' GROUP BY btrim(city)
         UNION ALL SELECT btrim(region), count(*) FROM active_sport_profiles WHERE region IS NOT NULL AND btrim(region) <> '' GROUP BY btrim(region)
       ) r WHERE name ILIKE $1 GROUP BY name ORDER BY sum(n) DESC, name LIMIT 15`, [q]).then((rows) => rows.map((r) => r.name));
  },
});

const filterShape = {
  evidence: z.enum(['self_reported', 'official']).default('self_reported').describe('self_reported = matches the player logged or imported; official = approved competition results. Never blended.'),
  position: z.string().trim().min(1).max(40).optional().describe('only compare with players who list this position'),
  match_type: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/).optional().describe('only compare matches of this format (singles, doubles, t20 …); self-logged evidence only'),
};

const PROFILE_SQL = `SELECT p.id, p.sport_id, p.level, nullif(btrim(p.region), '') AS region, p.positions, p.position, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji, s.category
                       FROM active_sport_profiles p JOIN sports s ON s.id = p.sport_id
                      WHERE p.user_id = $1 AND p.role = 'athlete' AND ($2::uuid IS NULL OR p.id = $2)
                      ORDER BY p.is_default DESC, p.created_at LIMIT 1`;

/** One player's benchmarks for one evidence track, in a single read-only snapshot so every number comes from the same moment. */
async function build(userId, profile, f) {
  if (f.match_type && f.evidence === 'official') throw badRequest('Match format applies to self-logged matches only; approved competition results are not split by format');
  if (f.match_type && !matchTypesFor({ slug: profile.sport_slug, category: profile.category }).includes(f.match_type)) throw badRequest(`Unknown match format for ${profile.sport}`);
  const mine_positions = [...new Set([...(profile.positions ?? []), profile.position].map((x) => x?.trim()).filter(Boolean))];
  const head = {
    profile: { id: profile.id, sport: profile.sport, sport_slug: profile.sport_slug, sport_emoji: profile.sport_emoji, level: profile.level, region: profile.region },
    evidence: f.evidence, evidence_label: EVIDENCE[f.evidence], filters: { position: f.position ?? null, match_type: f.match_type ?? null },
    options: { evidences: Object.entries(EVIDENCE).map(([key, label]) => ({ key, label })), positions: mine_positions, match_types: matchTypesFor({ slug: profile.sport_slug, category: profile.category }) },
  };
  const basis = f.evidence === 'official'
    ? 'Approved competition results only. Self-logged matches are never mixed in. Only totals and averages are compared, never another player\'s data.'
    : 'Matches that players logged or imported on Gotmygame, not official results. Each number uses only the matches that recorded it. Only totals and averages are compared, never another player\'s data.';
  const snap = await tx(async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const opts = { position: f.position ?? null, matchType: f.match_type ?? null };
    const everyone = f.evidence === 'official' ? await loadOfficial(db, profile.sport_id, opts) : await loadSelf(db, profile.sport_id, opts);
    const ratings = (await db.query(`SELECT rating::float8 AS rating FROM player_matches WHERE user_id=$1 AND sport_profile_id=$2 AND archived_at IS NULL AND rating IS NOT NULL ORDER BY played_on DESC, created_at DESC, id LIMIT 10`, [userId, profile.id])).rows.map((r) => r.rating);
    const recent = (await db.query(`SELECT result, rating FROM player_matches WHERE user_id=$1 AND sport_profile_id=$2 AND archived_at IS NULL ORDER BY played_on DESC, created_at DESC, id LIMIT 10`, [userId, profile.id])).rows;
    const allowed = (await db.query(`SELECT ${CONSENT_OK('$1::uuid')} AS ok`, [userId])).rows[0].ok;
    return { everyone, ratings, recent, allowed };
  });
  const trend = selfRatingTrend(snap.ratings);
  if (!snap.allowed) return { ...head, ready: false, code: 'guardian_consent_required', matches: 0, needed: MIN_MATCHES, reason: 'A verified guardian has not given current consent for coaching data, so benchmarks are switched off for this young person.', basis, scopes: [], summary: null, self_rating_trend: trend };
  const mine = snap.everyone.get(userId);
  if (!mine || mine.matches < MIN_MATCHES) {
    const why = f.position && !mine ? `You do not list ${f.position} on this sport card.` : f.evidence === 'official'
      ? `You need at least ${MIN_MATCHES} approved competition results in ${profile.sport} to compare.` : `Log at least ${MIN_MATCHES} ${profile.sport} matches${f.match_type ? ` of this format` : ''} to see how you compare.`;
    return { ...head, ready: false, code: 'not_enough_data', matches: mine?.matches ?? 0, needed: MIN_MATCHES, reason: why, basis, scopes: [], summary: null, self_rating_trend: trend };
  }
  const others = [...snap.everyone.entries()].filter(([uid]) => uid !== userId).map(([, p]) => p);
  const scopeDefs = [
    ...(profile.region ? [['region', profile.region, others.filter((p) => p.region === profile.region.toLowerCase())]] : []),
    ['level', nice(profile.level).toLowerCase(), others.filter((p) => p.level === profile.level)],
    ['sport', `all ${profile.sport} players`, others],
  ];
  const scopes = scopeDefs.map(([scope, label, cohort]) => { const { all: _all, ...c } = compare(mine, cohort, f.evidence); return { scope, label, ...c }; });
  const statKeys = Object.keys(mine.metrics).filter((k) => !['win_rate', 'avg_rating', 'matches'].includes(k)).sort();
  const me = {
    matches: mine.matches, win_rate: mine.metrics.win_rate ? round(mine.metrics.win_rate.value, 0) : null, avg_rating: mine.metrics.avg_rating ? round(mine.metrics.avg_rating.value, 1) : null,
    per_match: Object.fromEntries(statKeys.map((k) => [k, round(mine.metrics[k].value)])),
  };
  return { ...head, ready: true, me, form: formOf(snap.recent), self_rating_trend: trend, scopes, my_metrics: compare(mine, [], f.evidence).all, basis, region_hint: profile.region ? null : 'Add the region you play in to compare with players nearby.' };
}

cap({
  name: 'get_my_insights', method: 'GET', path: '/me/insights', tag: TAG,
  summary: 'How you are doing in one sport compared with other players: win rate, ratings and per-match numbers against players in your region, at your level and across the sport (percentiles over aggregates only, never fewer than 5 other players). Percentiles respect each metric\'s direction (fewer errors is better), every figure averages only the matches that recorded it and says how many, and self-logged matches and approved competition results are compared separately. Optionally narrow by position or match format. Includes your own self-rating trend (never peer or coach ratings) and a plain-language read-out (AI when switched on, built-in rules otherwise).',
  input: z.object({ sport_profile_id: id.optional().describe('defaults to your default sport profile'), ...filterShape }),
  async handler({ user }, i) {
    const profile = await one(PROFILE_SQL, [user.id, i.sport_profile_id ?? null]);
    if (!profile) throw notFound('Sport profile');
    const out = await build(user.id, profile, i);
    if (!out.ready) return out;
    const fallbackItems = ruleInsights({ sport: profile.sport, me: out.me, form: out.form, scopes: out.scopes });
    const fallback = { headline: `${out.me.matches} ${profile.sport} ${out.evidence === 'official' ? 'official results' : 'matches logged'}${out.me.win_rate === null ? '' : `, ${out.me.win_rate}% won`}`, insights: fallbackItems, next_step: fallbackItems.some((x) => x.tone === 'watch') ? 'Work on the gap above in your next few matches, then log them to see it move.' : 'Keep logging every match so the comparison stays current.' };
    const facts = {
      sport: profile.sport, level: profile.level, region: profile.region, evidence: out.evidence_label, filters: out.filters, me: out.me, form: out.form,
      cohorts: out.scopes.map((s) => ({ scope: s.scope, label: s.label, players: s.size, comparisons: s.available ? s.comparisons.filter((c) => c.status === 'ranked').map(({ label, mine: m, cohort_median, percentile: pc, unit, direction, coverage }) => ({ metric: label, you: m, typical: cohort_median, ahead_of_percent: pc, unit, better: direction, recorded_in: `${coverage.recorded} of ${coverage.total}` })) : 'not enough players to compare' })),
    };
    return { ...out, summary: await narrate({ user, profile, facts, fallback }) };
  },
});

cap({
  name: 'get_athlete_benchmarks', method: 'GET', path: '/athletes/:athlete_id/benchmarks', tag: TAG,
  summary: 'An athlete\'s benchmarks (same aggregates as get_my_insights, no AI read-out) for a coach with a current coaching relationship or a verified guardian of a young person. For a young person a guardian\'s current coaching consent is required, re-checked on every read, so withdrawing it blocks access at once. Each read is audit-logged.',
  input: z.object({ athlete_id: id, sport_profile_id: id.optional(), ...filterShape }),
  async handler({ user }, i) {
    const self = user.id === i.athlete_id;
    const guardian = !self && !!(await guardianLink(user.id, i.athlete_id));
    if (!self && !guardian) await requireRelationship(user, i.athlete_id);
    if (!self && (guardian || await isYouth(i.athlete_id))) await requireConsent(i.athlete_id, 'coaching', 'viewing benchmarks');
    const profile = await one(PROFILE_SQL, [i.athlete_id, i.sport_profile_id ?? null]);
    if (!profile) throw notFound('Sport profile');
    await audit(null, user.id, 'view_player_benchmarks', 'sport_profile', profile.id);
    return { ...(await build(i.athlete_id, profile, i)), viewer: self ? 'self' : guardian ? 'guardian' : 'coach' };
  },
});
