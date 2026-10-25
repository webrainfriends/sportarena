import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, pool } from '../db.js';
import { notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { sha256 } from '../crypto.js';
import { askJson, aiConfigured, aiModel, AI_RULES } from '../ai.js';

const TAG = 'Player insights';
const MIN_MATCHES = 3;  // a player needs this many logged matches to be compared, and to count in a cohort
const MIN_COHORT = 5;   // never show a comparison drawn from fewer other players than this: it would single people out
const nice = (k) => String(k).replace(/_/g, ' ');
const round = (n, d = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
/** Share of the cohort this player is ahead of, counting ties as half. 0-100. */
const percentile = (mine, others) => Math.round((100 * (others.filter((o) => o < mine).length + 0.5 * others.filter((o) => o === mine).length)) / others.length);

// Everything here is derived from matches players logged or imported (player_matches), for me and for the cohort alike, so a
// comparison is always like with like. Only aggregates leave this module: no other player's name, id or single match.

async function sportRows(sportId) {
  const [players, stats] = await Promise.all([
    many(`SELECT sp.user_id, sp.level, lower(btrim(sp.region)) AS region, count(*)::int AS matches,
                 count(*) FILTER (WHERE m.result IS NOT NULL)::int AS decided, count(*) FILTER (WHERE m.result = 'win')::int AS wins,
                 avg(m.rating)::float8 AS rating
            FROM player_matches m JOIN sport_profiles sp ON sp.id = m.sport_profile_id
           WHERE sp.sport_id = $1 AND sp.role = 'athlete' AND m.archived_at IS NULL
           GROUP BY sp.user_id, sp.level, lower(btrim(sp.region))`, [sportId]),
    many(`SELECT m.user_id, e.key, sum(e.value::numeric)::float8 AS total
            FROM player_matches m JOIN sport_profiles sp ON sp.id = m.sport_profile_id, jsonb_each_text(m.stats) e
           WHERE sp.sport_id = $1 AND sp.role = 'athlete' AND m.archived_at IS NULL AND e.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
           GROUP BY m.user_id, e.key`, [sportId]),
  ]);
  const byUser = new Map(players.map((p) => [p.user_id, {
    ...p, region: p.region || null, win_rate: p.decided ? p.wins / p.decided : null, per_match: {},
  }]));
  for (const s of stats) { const u = byUser.get(s.user_id); if (u) u.per_match[s.key] = s.total / u.matches; }
  return byUser;
}

/** My numbers against one cohort: only metrics both sides actually have, and only with enough other players. */
function compare(me, cohort, metricKeys) {
  const others = cohort.filter((p) => p.matches >= MIN_MATCHES);
  if (others.length < MIN_COHORT) return { available: false, size: others.length, comparisons: [] };
  const rows = [];
  const add = (key, label, mine, pick, unit) => {
    if (mine === null || mine === undefined) return;
    const vals = others.map(pick).filter((v) => v !== null && v !== undefined);
    if (vals.length < MIN_COHORT) return;
    rows.push({ key, label, unit, mine: round(mine), cohort_avg: round(vals.reduce((a, b) => a + b, 0) / vals.length), cohort_median: round(median(vals)), percentile: percentile(mine, vals), n: vals.length });
  };
  add('win_rate', 'Win rate', me.win_rate === null ? null : me.win_rate * 100, (p) => (p.win_rate === null ? null : p.win_rate * 100), '%');
  add('avg_rating', 'Average rating', me.rating, (p) => p.rating, '/10');
  add('matches', 'Matches logged', me.matches, (p) => p.matches, '');
  for (const k of metricKeys) add(k, nice(k).replace(/^./, (x) => x.toUpperCase()), me.per_match[k], (p) => p.per_match[k] ?? null, 'per match');
  return { available: true, size: others.length, comparisons: rows };
}

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
         UNION ALL SELECT btrim(locality), count(*) FROM addresses WHERE archived_at IS NULL AND locality IS NOT NULL AND btrim(locality) <> '' GROUP BY btrim(locality)
       ) r WHERE name ILIKE $1 GROUP BY name ORDER BY sum(n) DESC, name LIMIT 15`, [q]).then((rows) => rows.map((r) => r.name));
  },
});

cap({
  name: 'get_my_insights', method: 'GET', path: '/me/insights', tag: TAG,
  summary: 'How you are doing in one sport compared with other players: your win rate, ratings and per-match numbers against players in your region, at your level and across the sport (percentiles over aggregates only, never fewer than 5 other players), your recent form, and a plain-language read-out (written by AI when switched on, by built-in rules otherwise). Based on matches players logged or imported.',
  input: z.object({ sport_profile_id: id.optional().describe('defaults to your default sport profile') }),
  async handler({ user }, i) {
    const profile = await one(
      `SELECT p.id, p.sport_id, p.level, nullif(btrim(p.region), '') AS region, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji
         FROM active_sport_profiles p JOIN sports s ON s.id = p.sport_id
        WHERE p.user_id = $1 AND p.role = 'athlete' AND ($2::uuid IS NULL OR p.id = $2)
        ORDER BY p.is_default DESC, p.created_at LIMIT 1`, [user.id, i.sport_profile_id ?? null]);
    if (!profile) throw notFound('Sport profile');
    const head = { profile: { id: profile.id, sport: profile.sport, sport_slug: profile.sport_slug, sport_emoji: profile.sport_emoji, level: profile.level, region: profile.region } };
    const everyone = await sportRows(profile.sport_id);
    const mine = everyone.get(user.id);
    const basis = 'Matches that players logged or imported on Gotmygame. Only totals and averages are compared, never another player\'s data.';
    if (!mine || mine.matches < MIN_MATCHES) {
      return { ...head, ready: false, matches: mine?.matches ?? 0, needed: MIN_MATCHES, reason: `Log at least ${MIN_MATCHES} ${profile.sport} matches to see how you compare.`, basis, scopes: [], summary: null };
    }
    const others = [...everyone.entries()].filter(([uid]) => uid !== user.id).map(([, p]) => p);
    const keys = Object.keys(mine.per_match).sort();
    const recent = await many(`SELECT result, rating FROM player_matches WHERE user_id = $1 AND sport_profile_id = $2 AND archived_at IS NULL ORDER BY played_on DESC, created_at DESC LIMIT 10`, [user.id, profile.id]);
    const form = formOf(recent);
    const scopeDefs = [
      ...(profile.region ? [['region', profile.region, others.filter((p) => p.region === profile.region.toLowerCase())]] : []),
      ['level', nice(profile.level), others.filter((p) => p.level === profile.level)],
      ['sport', `all ${profile.sport} players`, others],
    ];
    const scopes = scopeDefs.map(([scope, label, cohort]) => ({ scope, label, ...compare(mine, cohort, keys) }));
    const me = { matches: mine.matches, win_rate: mine.win_rate === null ? null : round(mine.win_rate * 100, 0), avg_rating: round(mine.rating, 1), per_match: Object.fromEntries(keys.map((k) => [k, round(mine.per_match[k])])) };
    const fallbackItems = ruleInsights({ sport: profile.sport, me, form, scopes });
    const fallback = { headline: `${me.matches} ${profile.sport} matches logged${me.win_rate === null ? '' : `, ${me.win_rate}% won`}`, insights: fallbackItems, next_step: fallbackItems.some((x) => x.tone === 'watch') ? 'Work on the gap above in your next few matches, then log them to see it move.' : 'Keep logging every match so the comparison stays current.' };
    const facts = { sport: profile.sport, level: profile.level, region: profile.region, me, form, cohorts: scopes.map((s) => ({ scope: s.scope, label: s.label, players: s.size, comparisons: s.available ? s.comparisons.map(({ label, mine: m, cohort_median, percentile: pc, unit }) => ({ metric: label, you: m, typical: cohort_median, ahead_of_percent: pc, unit })) : 'not enough players to compare' })) };
    const summary = await narrate({ user, profile, facts, fallback });
    return { ...head, ready: true, me, form, scopes, summary, basis, region_hint: profile.region ? null : 'Add the region you play in to compare with players nearby.' };
  },
});
