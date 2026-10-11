// Scoring rulesets: how a match in a sport is scored, in the style of Olympic / Asian Games rules.
// A ruleset is plain data, so organisers can define their own (stored per event) with the same shape.
import { z } from 'zod';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);

export const rulesetSchema = z.object({
  kind: z.enum(['points_events', 'sets', 'manual']).describe('points_events: score adds up from scoring events; sets: rally points make sets make a match; manual: the referee enters the totals'),
  label: z.string().min(2).max(60),
  periods: z.object({ count: z.number().int().min(1).max(12), label: z.string().min(1).max(20) }).default({ count: 1, label: 'Period' }),
  events: z.array(z.object({ kind: key, label: z.string().min(1).max(30), points: z.number().int().min(0).max(20), icon: z.string().max(8).optional() })).max(20).default([])
    .describe('scoring events and what each is worth (points_events only)'),
  stats: z.array(z.object({ kind: key, label: z.string().min(1).max(30), icon: z.string().max(8).optional() })).max(30).default([])
    .describe('non-scoring parameters the referee tracks: fouls, cards, timeouts, aces …'),
  sets: z.object({
    best_of: z.number().int().min(1).max(9).refine((n) => n % 2 === 1, 'best_of must be odd'),
    points_to_win: z.number().int().min(1).max(100), win_by: z.number().int().min(1).max(2),
    cap: z.number().int().min(1).max(200).nullable().default(null), deciding_points: z.number().int().min(1).max(100).nullable().default(null),
  }).optional(),
  draw_allowed: z.boolean().default(true),
}).superRefine((r, ctx) => {
  if (r.kind === 'sets' && !r.sets) ctx.addIssue({ code: 'custom', message: 'a sets ruleset needs sets{}', path: ['sets'] });
  if (r.kind === 'points_events' && !r.events.length) ctx.addIssue({ code: 'custom', message: 'a points_events ruleset needs at least one scoring event', path: ['events'] });
  const kinds = [...r.events, ...r.stats].map((x) => x.kind);
  if (new Set(kinds).size !== kinds.length) ctx.addIssue({ code: 'custom', message: 'event and stat kinds must be unique', path: ['events'] });
});

const R = (r) => rulesetSchema.parse(r);
const goals = (label, count, periodLabel, extra = []) => R({
  kind: 'points_events', label, periods: { count, label: periodLabel },
  events: [{ kind: 'goal', label: 'Goal', points: 1, icon: '⚽' }],
  stats: [{ kind: 'foul', label: 'Foul' }, { kind: 'yellow_card', label: 'Yellow card', icon: '🟨' }, { kind: 'red_card', label: 'Red card', icon: '🟥' }, { kind: 'timeout', label: 'Timeout' }, ...extra],
});
const rally = (label, best_of, points_to_win, win_by, cap, deciding_points, stats = []) => R({
  kind: 'sets', label, sets: { best_of, points_to_win, win_by, cap, deciding_points }, draw_allowed: false,
  events: [], stats: [{ kind: 'timeout', label: 'Timeout' }, { kind: 'fault', label: 'Fault' }, ...stats],
});
const MANUAL = R({ kind: 'manual', label: 'Manual totals', events: [], stats: [{ kind: 'foul', label: 'Foul' }, { kind: 'warning', label: 'Warning' }] });

const BUILTIN = {
  football: goals('Football', 2, 'Half', [{ kind: 'corner', label: 'Corner' }, { kind: 'offside', label: 'Offside' }]),
  futsal: goals('Futsal', 2, 'Half'),
  handball: goals('Handball', 2, 'Half', [{ kind: 'two_minute', label: '2-minute suspension' }]),
  hockey: goals('Hockey', 4, 'Quarter', [{ kind: 'penalty_corner', label: 'Penalty corner' }, { kind: 'green_card', label: 'Green card', icon: '🟩' }]),
  'water-polo': goals('Water polo', 4, 'Quarter', [{ kind: 'exclusion', label: 'Exclusion' }]),
  netball: goals('Netball', 4, 'Quarter'),
  lacrosse: goals('Lacrosse', 4, 'Quarter'),
  basketball: R({
    kind: 'points_events', label: 'Basketball', periods: { count: 4, label: 'Quarter' }, draw_allowed: false,
    events: [{ kind: 'free_throw', label: 'Free throw', points: 1 }, { kind: 'two_pointer', label: '2-pointer', points: 2, icon: '🏀' }, { kind: 'three_pointer', label: '3-pointer', points: 3, icon: '🎯' }],
    stats: [{ kind: 'foul', label: 'Foul' }, { kind: 'timeout', label: 'Timeout' }, { kind: 'rebound', label: 'Rebound' }, { kind: 'assist', label: 'Assist' }, { kind: 'turnover', label: 'Turnover' }],
  }),
  '3x3-basketball': R({
    kind: 'points_events', label: '3x3 Basketball', periods: { count: 1, label: 'Game' }, draw_allowed: false,
    events: [{ kind: 'one_pointer', label: 'Inside the arc', points: 1 }, { kind: 'two_pointer', label: 'Beyond the arc', points: 2 }, { kind: 'free_throw', label: 'Free throw', points: 1 }],
    stats: [{ kind: 'foul', label: 'Foul' }, { kind: 'timeout', label: 'Timeout' }],
  }),
  kabaddi: R({
    kind: 'points_events', label: 'Kabaddi', periods: { count: 2, label: 'Half' }, draw_allowed: true,
    events: [{ kind: 'raid_point', label: 'Raid point', points: 1, icon: '🤼' }, { kind: 'tackle_point', label: 'Tackle point', points: 1 }, { kind: 'bonus_point', label: 'Bonus point', points: 1 }, { kind: 'all_out', label: 'All-out (+2)', points: 2, icon: '💥' }, { kind: 'technical_point', label: 'Technical point', points: 1 }],
    stats: [{ kind: 'super_raid', label: 'Super raid' }, { kind: 'super_tackle', label: 'Super tackle' }, { kind: 'empty_raid', label: 'Empty raid' }, { kind: 'review', label: 'Review' }, { kind: 'timeout', label: 'Timeout' }],
  }),
  rugby: R({
    kind: 'points_events', label: 'Rugby', periods: { count: 2, label: 'Half' },
    events: [{ kind: 'try', label: 'Try', points: 5, icon: '🏉' }, { kind: 'conversion', label: 'Conversion', points: 2 }, { kind: 'penalty_goal', label: 'Penalty goal', points: 3 }, { kind: 'drop_goal', label: 'Drop goal', points: 3 }],
    stats: [{ kind: 'yellow_card', label: 'Yellow card', icon: '🟨' }, { kind: 'red_card', label: 'Red card', icon: '🟥' }, { kind: 'scrum', label: 'Scrum' }],
  }),
  'rugby-sevens': R({
    kind: 'points_events', label: 'Rugby sevens', periods: { count: 2, label: 'Half' },
    events: [{ kind: 'try', label: 'Try', points: 5, icon: '🏉' }, { kind: 'conversion', label: 'Conversion', points: 2 }, { kind: 'penalty_goal', label: 'Penalty goal', points: 3 }, { kind: 'drop_goal', label: 'Drop goal', points: 3 }],
    stats: [{ kind: 'yellow_card', label: 'Yellow card', icon: '🟨' }, { kind: 'red_card', label: 'Red card', icon: '🟥' }],
  }),
  baseball: R({ kind: 'points_events', label: 'Baseball', periods: { count: 9, label: 'Inning' }, draw_allowed: false, events: [{ kind: 'run', label: 'Run', points: 1, icon: '⚾' }], stats: [{ kind: 'hit', label: 'Hit' }, { kind: 'error', label: 'Error' }, { kind: 'strikeout', label: 'Strikeout' }] }),
  softball: R({ kind: 'points_events', label: 'Softball', periods: { count: 7, label: 'Inning' }, draw_allowed: false, events: [{ kind: 'run', label: 'Run', points: 1, icon: '🥎' }], stats: [{ kind: 'hit', label: 'Hit' }, { kind: 'error', label: 'Error' }, { kind: 'strikeout', label: 'Strikeout' }] }),
  volleyball: rally('Volleyball', 5, 25, 2, null, 15, [{ kind: 'ace', label: 'Ace' }, { kind: 'block', label: 'Block' }, { kind: 'substitution', label: 'Substitution' }]),
  'beach-volleyball': rally('Beach volleyball', 3, 21, 2, null, 15, [{ kind: 'ace', label: 'Ace' }, { kind: 'block', label: 'Block' }]),
  badminton: rally('Badminton', 3, 21, 2, 30, null, [{ kind: 'service_fault', label: 'Service fault' }]),
  'table-tennis': rally('Table tennis', 5, 11, 2, null, null, [{ kind: 'ace', label: 'Ace' }]),
  squash: rally('Squash', 5, 11, 2, null, null, [{ kind: 'let', label: 'Let' }, { kind: 'stroke', label: 'Stroke' }]),
  pickleball: rally('Pickleball', 3, 11, 2, null, null),
  'sepak-takraw': rally('Sepak takraw', 3, 21, 2, 25, 15),
  tennis: rally('Tennis (games)', 3, 6, 2, 7, null, [{ kind: 'ace', label: 'Ace' }, { kind: 'double_fault', label: 'Double fault' }]),
  padel: rally('Padel (games)', 3, 6, 2, 7, null),
  'soft-tennis': rally('Soft tennis (games)', 3, 4, 2, null, null),
};

/** Built-in ruleset for a sport row ({slug, scoring}); sports with no specific rules fall back on their scoring family, then manual. */
export function builtinRuleset(sport) {
  if (sport?.slug && BUILTIN[sport.slug]) return BUILTIN[sport.slug];
  if (sport?.scoring === 'goals') return goals(sport.name ?? 'Goals', 2, 'Half');
  if (sport?.scoring === 'sets') return rally(sport.name ?? 'Sets', 3, 21, 2, 30, null);
  return MANUAL;
}
export const builtinSlugs = () => Object.keys(BUILTIN);
export const MANUAL_RULESET = MANUAL;
