// Scoring rulesets: how a match in a sport is scored, in the style of Olympic / Asian Games rules.
// A ruleset is plain data, so organisers can define their own (stored per event) with the same shape.
import { z } from 'zod';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);

export const rulesetSchema = z.object({
  kind: z.enum(['points_events', 'sets', 'manual', 'cricket']).describe('points_events: score adds up from scoring events; sets: rally points make sets make a match; manual: the referee enters the totals; cricket: ball-by-ball innings (see scoring/cricket.js)'),
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
  cricket: z.object({
    format: z.enum(['T10', 'T20', 'ODI', 'Test']),
    overs: z.number().int().min(1).max(100).nullable().describe('overs per innings, null when an innings has no limit (Test)'),
    innings: z.number().int().min(2).max(4).describe('innings in the whole match: 2 limited overs, 4 Test'),
    bowler_max: z.number().int().min(1).max(100).nullable(),
    wide_runs: z.number().int().min(1).max(2).default(1), noball_runs: z.number().int().min(1).max(2).default(1),
    free_hit: z.boolean().default(true), follow_on: z.number().int().min(50).max(400).nullable().default(null),
    min_overs_day: z.number().int().min(1).max(120).nullable().default(null), days: z.number().int().min(1).max(5).nullable().default(null),
    reviews: z.number().int().min(0).max(5).default(0),
  }).optional(),
  draw_allowed: z.boolean().default(true),
}).superRefine((r, ctx) => {
  if (r.kind === 'cricket' && !r.cricket) ctx.addIssue({ code: 'custom', message: 'a cricket ruleset needs cricket{}', path: ['cricket'] });
  if (r.kind === 'sets' && !r.sets) ctx.addIssue({ code: 'custom', message: 'a sets ruleset needs sets{}', path: ['sets'] });
  if (r.kind === 'points_events' && !r.events.length) ctx.addIssue({ code: 'custom', message: 'a points_events ruleset needs at least one scoring event', path: ['events'] });
  const kinds = [...r.events, ...r.stats].map((x) => x.kind);
  if (new Set(kinds).size !== kinds.length) ctx.addIssue({ code: 'custom', message: 'event and stat kinds must be unique', path: ['events'] });
});

const R = (r) => rulesetSchema.parse(r);
const goals = (label, count, periodLabel, extra = []) => R({
  kind: 'points_events', label, periods: { count, label: periodLabel },
  events: [{ kind: 'goal', label: 'Goal', points: 1, icon: '⚽' }],
  stats: [{ kind: 'foul', label: 'Foul' }, { kind: 'yellow_card', label: 'Yellow card', icon: '🟨' }, { kind: 'red_card', label: 'Red card', icon: '🟥' }, { kind: 'timeout', label: 'Timeout' }, { kind: 'substitution', label: 'Substitution' }, ...extra],
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
    stats: [{ kind: 'yellow_card', label: 'Yellow card', icon: '🟨' }, { kind: 'red_card', label: 'Red card', icon: '🟥' }, { kind: 'scrum', label: 'Scrum' }, { kind: 'substitution', label: 'Replacement' }],
  }),
  'rugby-sevens': R({
    kind: 'points_events', label: 'Rugby sevens', periods: { count: 2, label: 'Half' },
    events: [{ kind: 'try', label: 'Try', points: 5, icon: '🏉' }, { kind: 'conversion', label: 'Conversion', points: 2 }, { kind: 'penalty_goal', label: 'Penalty goal', points: 3 }, { kind: 'drop_goal', label: 'Drop goal', points: 3 }],
    stats: [{ kind: 'yellow_card', label: 'Yellow card', icon: '🟨' }, { kind: 'red_card', label: 'Red card', icon: '🟥' }, { kind: 'substitution', label: 'Replacement' }],
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

const CRICKET_FORMATS = {
  T10: { overs: 10, innings: 2 }, T20: { overs: 20, innings: 2 }, ODI: { overs: 50, innings: 2 }, Test: { overs: null, innings: 4 },
};
/** The cricket ruleset for a format; `values` are rulebook settings (local rules), which can shorten overs, set bowler limits and so on. */
export function cricketRuleset(format = 'T20', values = {}) {
  const f = CRICKET_FORMATS[format] ?? CRICKET_FORMATS.T20, fmt = CRICKET_FORMATS[format] ? format : 'T20';
  const key = fmt === 'ODI' ? 'odi' : 't20', limited = f.overs != null;
  const overs = limited && fmt !== 'T10' ? (values[`ov_${key}`] ?? f.overs) : f.overs;
  const bowler = limited ? (fmt !== 'T10' && values[`bq_${key}`]) || Math.max(1, Math.floor(overs / 5)) : null;
  return R({
    kind: 'cricket', label: `Cricket ${fmt}`, periods: { count: f.innings, label: 'Innings' }, draw_allowed: true, events: [], stats: [],
    cricket: {
      format: fmt, overs, innings: f.innings, bowler_max: bowler, wide_runs: values.pen ?? 1, noball_runs: values.pen ?? 1,
      free_hit: limited ? values.freehit ?? true : false, follow_on: limited ? null : values.fo ?? 200, min_overs_day: limited ? null : values.mo ?? 90,
      days: limited ? null : values.days ?? 5, reviews: values[`drs_${fmt === 'Test' ? 'test' : key}`] ?? (fmt === 'ODI' || fmt === 'Test' ? 2 : 1),
    },
  });
}

/** Built-in ruleset for a sport row ({slug, scoring}); sports with no specific rules fall back on their scoring family, then manual. */
export function builtinRuleset(sport) {
  if (sport?.slug === 'cricket') return cricketRuleset('T20');
  if (sport?.slug && BUILTIN[sport.slug]) return BUILTIN[sport.slug];
  if (sport?.scoring === 'goals') return goals(sport.name ?? 'Goals', 2, 'Half');
  if (sport?.scoring === 'sets') return rally(sport.name ?? 'Sets', 3, 21, 2, 30, null);
  return MANUAL;
}
export const builtinSlugs = () => [...Object.keys(BUILTIN), 'cricket'];
export const MANUAL_RULESET = MANUAL;

/** Plain-language summary of a ruleset, for people learning the sport: [{title, body}]. Manual rulesets say nothing about scoring. */
export function describeRuleset(rs) {
  if (rs.kind === 'manual') return [];
  if (rs.kind === 'cricket') {
    const c = rs.cricket, limited = c.overs != null;
    return [
      { title: 'Format', body: limited ? `Each side bats once for up to ${c.overs} overs. ${c.bowler_max ? `No bowler may bowl more than ${c.bowler_max} overs.` : ''}` : `Each side bats twice over up to ${c.days ?? 5} days; an innings has no over limit.` },
      { title: 'How runs and results work', body: `A wide or no-ball costs ${c.wide_runs} run${c.wide_runs === 1 ? '' : 's'} and is bowled again. ${c.free_hit ? 'A no-ball is followed by a free hit. ' : ''}The side with more runs wins; an equal total is a tie${limited ? '' : ', and a Test that is not finished in time is a draw'}.` },
    ];
  }
  const out = [];
  const per = rs.periods.count > 1 ? `${rs.periods.count} ${rs.periods.label.toLowerCase()}s` : `a single ${rs.periods.label.toLowerCase()}`;
  if (rs.kind === 'sets') {
    const { best_of, points_to_win, win_by, cap, deciding_points } = rs.sets;
    const unit = /games/.test(rs.label) ? 'games' : 'points';
    out.push({ title: 'How a match is won', body: `A match is the best of ${best_of} sets; win ${Math.ceil(best_of / 2)} to take it. A set goes to the first side to ${points_to_win} ${unit}, and it must be won by ${win_by === 2 ? `a two-${unit.slice(0, -1)} margin` : `at least one ${unit.slice(0, -1)}`}${cap ? `, up to a cap of ${cap}` : ''}.${deciding_points ? ` The deciding set is played to ${deciding_points}.` : ''} There are no draws.` });
  } else {
    out.push({ title: 'Format', body: `Played over ${per}. ${rs.draw_allowed ? 'A draw is a valid result.' : 'There are no draws; a winner is always decided.'}` });
    out.push({ title: 'How points are scored', body: rs.events.map((e) => `${e.label}: ${e.points} ${e.points === 1 ? 'point' : 'points'}`).join('\n') });
  }
  if (rs.stats.length) out.push({ title: 'Also recorded in a match', body: rs.stats.map((x) => x.label).join(', ') + '.' });
  return out;
}
