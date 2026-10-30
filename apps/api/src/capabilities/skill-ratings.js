// Skill ratings (#633): a level 1.0-7.0 and a reliability bar per person and sport, projected from verified results only. Nothing here creates a result.
// REST, OpenAPI and MCP all use these definitions, so eligibility, youth exclusion and who may see the evidence are identical everywhere.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { notFound } from '../errors.js';
import { audit, isAdmin, sportBySlugOrId } from '../helpers.js';
import { NOT_YOUTH_SQL } from '../youth.js';
import { MODELS, describeModel, modelOf } from '../ratings/models.js';
import { ratingsOf, historyOf, recomputeSport, recomputeAll } from '../ratings/data.js';
import { LEVEL_BUCKETS, RELIABLE_RD, OUTCOME_WEIGHT, bucketOf } from '../ratings/engine.js';

const TAG = 'Skill ratings';

/** The adult, approved account behind a rating; anything else is a 404 so a youth account's existence is never confirmed. */
const ratedUser = async (userId) => {
  const u = await one(`SELECT u.id FROM users u WHERE u.id = $1 AND ${NOT_YOUTH_SQL} AND u.access_status = 'approved'`, [userId]);
  if (!u) throw notFound('Player');
  return u;
};

const HOW = {
  scale: 'Level 1.0 (new) to 7.0 (elite); 4.0 is the middle of the field.',
  evidence: 'Only verified results count: games with a published score sheet and completed event sessions in tournaments and leagues. Practice, imported and self-reported results, friendlies, camps, trials and open-game results never count.',
  reliability: `Reliability grows with verified games and falls when you stop playing. A level is used to match you in open games once it is reliable (usually after 8 to 20 verified games; evenly matched games tell the system more than lopsided ones); until then your stated level is used.`,
  weighting: `${Math.round(OUTCOME_WEIGHT * 100)}% of a game's weight is who won and ${Math.round((1 - OUTCOME_WEIGHT) * 100)}% how it went. Beating a stronger side moves you more than beating a weaker one. Doubles use the average of both sides. There is no boost for paid plans.`,
  youth: 'Youth accounts are never rated. Games whose result is disputed, rejected or superseded do not count; a corrected result re-runs the ratings and the earlier run is kept.',
  matching: LEVEL_BUCKETS.map(([bucket, lo, hi]) => ({ bucket, from: Math.max(lo, 1), to: Math.min(hi, 7) })),
  reliable_below_rd: RELIABLE_RD,
};

cap({
  name: 'list_rating_models', method: 'GET', path: '/ratings/models', tag: TAG, auth: 'public',
  summary: 'How ratings work and which model each sport uses: the families with a native model (racket and set sports, goal games, cricket, timed and measured events) and which sports fall back to a labelled win/loss-only model. Use it to explain a level to a player.',
  input: z.object({ sport: z.string().optional() }),
  async handler(_ctx, i) {
    const sports = await many('SELECT id, slug, name, emoji, scoring, category FROM sports WHERE ($1::text IS NULL OR slug = $1 OR id::text = $1) ORDER BY name', [i.sport ?? null]);
    if (i.sport && !sports.length) throw notFound('Sport');
    return {
      how: HOW, models: Object.fromEntries(Object.keys(MODELS).map((k) => [k, describeModel(k)])),
      sports: sports.map((s) => { const m = describeModel(modelOf(s)); return { slug: s.slug, name: s.name, emoji: s.emoji, family: m.family, native: m.native, model: m.label }; }),
    };
  },
});

cap({
  name: 'get_skill_ratings', method: 'GET', path: '/ratings/players/:user_id', tag: TAG, auth: 'public',
  summary: 'A player’s level per sport (1.0-7.0) with how reliable it is, games, record and peak. Only adults with approved accounts are rated; a youth or unknown account is a 404. A rating always says how many verified games it rests on.',
  input: z.object({ user_id: id, sport: z.string().optional() }),
  async handler(_ctx, i) {
    await ratedUser(i.user_id);
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    const ratings = await ratingsOf(i.user_id, { sportId: sport?.id });
    return { user_id: i.user_id, ratings, how: HOW };
  },
});

cap({
  name: 'get_skill_rating_history', method: 'GET', path: '/ratings/players/:user_id/:sport/history', tag: TAG, auth: 'public',
  summary: 'The level after each verified game, newest first. The player themselves (and an admin) also see the evidence behind every move: the result, your chance of winning going in, the opposing level and the event. Everyone else sees the level over time only.',
  input: z.object({ user_id: id, sport: z.string(), ...page }),
  async handler({ user }, i) {
    await ratedUser(i.user_id);
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    const ledger = !!user && (user.id === i.user_id || isAdmin(user));
    const h = await historyOf(i.user_id, sport.id, { ledger, limit: i.limit, offset: i.offset });
    const [current] = await ratingsOf(i.user_id, { sportId: sport.id });
    return { sport: { slug: sport.slug, name: sport.name }, model: describeModel(modelOf(sport)), current: current ?? null, evidence_visible: ledger, total: h.total, history: h.points };
  },
});

cap({
  name: 'recompute_skill_ratings', method: 'POST', path: '/ratings/recompute', tag: TAG, auth: ['admin'],
  summary: 'Re-run the ratings from the verified results of one sport (or all). Deterministic: unchanged results add nothing, a corrected result adds a new run and the earlier one is kept. Normally this runs by itself after results change and in the daily worker; this is for an admin to force it.',
  input: z.object({ sport: z.string().optional() }),
  async handler({ user }, i) {
    if (i.sport) {
      const sport = await sportBySlugOrId(i.sport);
      if (!sport) throw notFound('Sport');
      const r = await recomputeSport(sport, { reason: 'manual', userId: user.id });
      await audit(null, user.id, 'recompute_skill_ratings', 'sports', sport.id);
      return { runs: r.changed ? 1 : 0, results: [r] };
    }
    const runs = await recomputeAll('manual');
    await audit(null, user.id, 'recompute_skill_ratings', 'sports', null);
    return { runs };
  },
});

export { bucketOf };
