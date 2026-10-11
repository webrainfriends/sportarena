/**
 * Match templates: which columns an athlete fills in when logging a match, per sport AND per match type.
 *
 * Grounded in the IPTC Sport Schema statistics (sportTemplates, association scope) and reviewed against the Olympic and Asian Games
 * programmes (sports.programmes) so every catalogue sport gets sensible columns. Claude tailors the columns to the match type
 * (badminton singles vs doubles, T20 vs Test…); the built-in rules are the fallback, so a missing key or a bad answer never blocks
 * logging. Whatever the model says is validated: keys are plain metric names, counts are capped, and sports that do not score goals
 * never get goal columns invented for them.
 */
import { z } from 'zod';
import { askJson, AI_RULES, quoteData } from './ai.js';
import { sportTemplates } from './ontology/iptc.js';

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_COLUMNS = 12;
const GOAL_KEY = /^(goals?|assists?)$/;
const col = (key, label, kind = 'count', extra = {}) => ({ key, label, kind, ...extra });

/** Match types per sport; categories cover the rest of the catalogue. */
const TYPES = {
  badminton: ['singles', 'doubles', 'mixed_doubles'],
  tennis: ['singles', 'doubles', 'mixed_doubles'],
  'table-tennis': ['singles', 'doubles', 'mixed_doubles', 'team'],
  'soft-tennis': ['singles', 'doubles'],
  squash: ['singles', 'doubles'],
  cricket: ['t20', 'odi', 'test', 'tape_ball'],
  'beach-volleyball': ['pairs'],
};
const CATEGORY_TYPES = { racquet: ['singles', 'doubles'], team_ball: ['full_match'], combat: ['bout'], athletics: ['race'], aquatics: ['race'] };
export const matchTypesFor = (sport) => TYPES[sport.slug] ?? CATEGORY_TYPES[sport.category] ?? ['match'];

const SCORE_LABELS = {
  sets: ['Games won', 'Games lost'],
  goals: ['Goals for', 'Goals against'],
  points: ['Points for', 'Points against'],
  combat: ['Points scored', 'Points conceded'],
};
export const scoreLabelsFor = (sport) => {
  const [score_for, score_against] = SCORE_LABELS[sport.scoring] ?? ['Your score', 'Their score'];
  return { score_for, score_against };
};

/** Fallback columns by scoring family, used when the sport has no IPTC template. Goals only appear for goal sports. */
const BY_SCORING = {
  goals: [col('goals', 'Goals'), col('assists', 'Assists'), col('shots', 'Shots'), col('saves', 'Saves')],
  sets: [col('points_won', 'Points won'), col('winners', 'Winners'), col('unforced_errors', 'Unforced errors'), col('aces', 'Aces')],
  points: [col('points', 'Points'), col('assists', 'Assists'), col('fouls', 'Fouls')],
  combat: [col('points_scored', 'Points scored'), col('warnings', 'Warnings'), col('penalties', 'Penalties')],
  time: [col('personal_best', 'Personal best set', 'count', { max: 1 })],
  distance: [col('personal_best', 'Personal best set', 'count', { max: 1 })],
  judged: [col('execution_score', 'Execution score', 'decimal'), col('difficulty_score', 'Difficulty score', 'decimal')],
  weight: [col('best_lift_kg', 'Best lift (kg)', 'decimal'), col('attempts_made', 'Attempts made', 'count', { max: 6 })],
};

const fromIptc = (sport) => (sportTemplates[sport.slug]?.association ?? [])
  .filter((f) => f.datatype === 'integer' || f.datatype === 'number')
  .map((f) => col(f.key, f.label, f.datatype === 'number' ? 'decimal' : 'count', f.max != null ? { max: f.max } : {}));

/** Deterministic columns: the IPTC statistics of the sport, else the scoring family's. */
export function builtInColumns(sport) {
  const base = fromIptc(sport);
  const cols = base.length ? base : (BY_SCORING[sport.scoring] ?? []);
  return cols.slice(0, MAX_COLUMNS);
}

const aiColumns = z.object({
  columns: z.array(z.object({
    key: z.string().regex(KEY), label: z.string().min(2).max(40), kind: z.enum(['count', 'decimal']).default('count'), max: z.number().int().min(1).max(1000).optional(),
  })).min(1).max(MAX_COLUMNS),
});

const cache = new Map();
export const clearTemplateCache = () => cache.clear();

export async function matchTemplate(sport, matchType) {
  const types = matchTypesFor(sport);
  const type = types.includes(matchType) ? matchType : null;
  const builtIn = builtInColumns(sport);
  const goalOk = sport.scoring === 'goals' || builtIn.some((c) => GOAL_KEY.test(c.key));
  const out = { sport: { slug: sport.slug, name: sport.name, scoring: sport.scoring }, match_type: type, match_types: types, score_labels: scoreLabelsFor(sport), columns: builtIn, source: 'iptc' };

  const cacheKey = `${sport.slug}:${type ?? ''}`;
  if (cache.has(cacheKey)) return { ...out, ...cache.get(cacheKey) };

  const ai = await askJson({
    system: `You design the stat columns an amateur or professional athlete fills in after one match. Base them on the IPTC Sport Schema statistics for the sport and on what the sport's official Olympic and Asian Games scoring sheets record. Every column must be something the athlete themself did in that match and a number (count or decimal). ${AI_RULES}`,
    user: `<data>Sport: ${quoteData(sport.name)} (${sport.slug}); scoring: ${sport.scoring}; category: ${quoteData(sport.category ?? '')}; programmes: ${(sport.programmes ?? []).join(', ') || 'none'}.\nMatch type: ${type ?? 'any'}.\nIPTC-based starting columns: ${builtIn.map((c) => `${c.key} (${c.label})`).join(', ') || 'none'}.</data>\nReturn 4 to 10 columns for THIS match type. Never include goals or assists unless the sport scores goals.`,
    shape: '{"columns":[{"key":"snake_case_metric","label":"Short label","kind":"count|decimal","max":optional integer}]}',
    schema: aiColumns, maxTokens: 700,
  });
  if (ai) {
    const seen = new Set();
    const cols = ai.columns.filter((c) => (goalOk || !GOAL_KEY.test(c.key)) && !seen.has(c.key) && seen.add(c.key))
      .map((c) => col(c.key, c.label, c.kind, c.max ? { max: c.max } : {}));
    if (cols.length >= 2) {
      const value = { columns: cols, source: 'ai' };
      cache.set(cacheKey, value);
      return { ...out, ...value };
    }
  }
  return out;
}
