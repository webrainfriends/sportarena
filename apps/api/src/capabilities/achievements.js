import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one } from '../db.js';
import { notFound } from '../errors.js';
import { familyOf, FAMILIES } from '../rankings/families.js';
import { evaluate, modelFor, FAMILY_MILESTONES } from '../achievements/engine.js';

const TAG = 'Performance';

// Derived read models (nothing is stored, so a reversed result removes its streak or badge by itself and no data is ever changed). Only
// approved competition results and granted medals count; the athlete's own practice and imported figures never do.
async function factsFor(userId, sportSlug) {
  const rows = await many(
    `SELECT p.id, s.slug, s.scoring, s.category, p.metric, p.value::float8 AS value, coalesce(p.direction,'higher') AS direction,
            to_char(coalesce(p.achieved_on, p.recorded_at::date),'YYYY-MM-DD') AS on_day, p.event_id
       FROM performances p JOIN sports s ON s.id=p.sport_id
      WHERE p.user_id=$1 AND p.provenance='approved_competition' AND p.status='approved' AND ($2::text IS NULL OR s.slug=$2)
      ORDER BY coalesce(p.achieved_on, p.recorded_at::date), p.recorded_at LIMIT 5000`, [userId, sportSlug ?? null]);
  const medals = sportSlug ? [] : await many(
    `SELECT a.id, a.kind, to_char(a.awarded_at::date,'YYYY-MM-DD') AS on_day FROM awards a WHERE a.user_id=$1 AND a.kind LIKE 'medal\\_%' ORDER BY a.awarded_at LIMIT 1000`, [userId]);
  return evaluate({
    today: new Date().toISOString().slice(0, 10),
    results: rows.map((r) => ({ id: r.id, sport: r.slug, family: familyOf({ slug: r.slug, scoring: r.scoring, category: r.category }), metric: r.metric, value: r.value, direction: r.direction, on: r.on_day, event_id: r.event_id })),
    medals: medals.map((m) => ({ id: m.id, kind: m.kind, on: m.on_day })),
  });
}

const sportFilter = z.object({ sport: z.string().max(60).optional().describe('sport slug; omit for all sports') });

cap({
  name: 'get_my_streaks', method: 'GET', path: '/me/streaks', tag: TAG,
  summary: 'Your streaks from verified results only: consecutive weeks with an approved competition result (Monday to Sunday; the run survives this week and the last) and, per sport and metric, consecutive results that each beat your previous best. Practice and imported figures never count.',
  input: sportFilter,
  async handler({ user }, i) { return (await factsFor(user.id, i.sport)).streaks; },
});

cap({
  name: 'get_my_achievements', method: 'GET', path: '/me/achievements', tag: TAG,
  summary: 'Your achievements, each tier with the verified results that earned it (the "why"), the next tier of each group with your progress, and your totals. Milestones follow the sport family (runs and wickets for cricket, goals and assists for goal games) and shared ones apply to every sport.',
  input: sportFilter,
  async handler({ user }, i) { const { streaks, ...rest } = await factsFor(user.id, i.sport); return { ...rest, streak_summary: { weekly_current: streaks.weekly.current, weekly_longest: streaks.weekly.longest } }; },
});

cap({
  name: 'get_athlete_achievements', method: 'GET', path: '/people/:id/achievements', tag: TAG, auth: 'public',
  summary: 'An athlete\'s earned achievements and streak totals from verified results, for their public profile. Young people\'s accounts return nothing, and an unknown person is a 404.',
  input: z.object({ id }),
  async handler(_, i) {
    const u = await one('SELECT id, (youth_until IS NOT NULL AND youth_until > current_date) AS youth FROM users WHERE id=$1', [i.id]);
    if (!u) throw notFound('Person');
    if (u.youth) return { achievements: [], streaks: { weekly: { current: 0, longest: 0 } }, totals: { results: 0, sports: 0, events: 0, medals: 0 } };
    const { achievements, streaks, totals } = await factsFor(u.id);
    return { achievements: achievements.map(({ evidence, ...a }) => a), streaks: { weekly: { current: streaks.weekly.current, longest: streaks.weekly.longest } }, totals };
  },
});

cap({
  name: 'list_achievement_models', method: 'GET', path: '/achievements/models', tag: TAG, auth: 'public',
  summary: 'How achievements work for every sport in the catalogue: the model of each sport family, whether it is native or a labelled fallback, and the milestones and tiers it offers.',
  input: z.object({}),
  async handler() {
    const sports = await many('SELECT slug, name, emoji, scoring, category FROM sports ORDER BY name');
    const families = Object.keys(FAMILIES).filter((f) => f !== 'team_form');
    return { families: families.map((f) => modelFor(f)), milestone_metrics: Object.fromEntries(Object.entries(FAMILY_MILESTONES).map(([k, v]) => [k, v.map(([key]) => key)])),
      sports: sports.map((s) => { const family = familyOf(s); return { slug: s.slug, name: s.name, emoji: s.emoji, family, native: FAMILIES[family].native }; }) };
  },
});
