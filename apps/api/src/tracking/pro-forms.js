// Scorer-grade printable sheets for the sports with an official or widely used match record: the FIFA-style match report, the
// ICC scorebook for T20 / ODI / Test, IIHF and NFL style game sheets, a FIDE scoresheet, athletics heat cards and so on.
// Like forms.js these only describe what is printed; scoring and validation stay in scoring/. `rv(ctx, key, std)` reads a local rule
// value so a sheet printed under local rules shows the right number of periods, rounds and boxes.
import { choices, fields, finalResult, nums, officials, pair, table, ticks } from './form-kit.js';

export const rv = (ctx, key, std) => ctx?.rules?.values?.[key] ?? std;
const note = (title, lines) => ({ t: 'note', title, lines });
const rulesNote = (ctx) => (ctx?.rules?.lines?.length ? [note('Local rules in force (they change the standard rules)', ctx.rules.lines)] : []);
const matchInfo = (extra = []) => fields(['Competition', 'Match no.', 'Round / group', ...extra], 3); // date, time, venue and the team names are already printed in the page header

const lineup = (title, starters, subs, o = {}) => pair(title, [['No', 0.6], ['Player', 3], ['C', 0.4], ...(o.gk ? [['GK', 0.45]] : []), ['Yellow', 0.7], ['Red', 0.6], ['On / off', 1.1]], starters + subs, { h: 13.5 });

// ------------------------------------------------------------------------------------------------------------------ football (FIFA match report)
export function footballReport(ctx) {
  const half = rv(ctx, 'half', 45), subs = rv(ctx, 'subs', 5), tie = rv(ctx, 'tie', 'Extra time then penalties');
  const sections = [
    ...rulesNote(ctx),
    matchInfo(['Weather / pitch']),
    fields([`Half length (${half} min)`, 'Kick-off first half', 'Half-time starts', 'Second half kick-off', 'Full time', 'Added time H1 / H2'], 6),
    lineup('Line-up: starting 11, then substitutes', 11, Math.max(Math.min(rv(ctx, 'named', 12), 14), 5), { gk: true }),
    fields(['Team officials: head coach', 'Assistant coach', 'Medical / physio'], 3),
    table('Goals (write the minute; add +added time; type: OP open play, PK penalty, OG own goal, FK free kick, H header)', [['#', 0.5], ['Minute', 0.9], ['Team H/A', 0.9], ['Scorer no.', 1], ['Scorer name', 3], ['Type', 1], ['Assist no.', 1], ['Score H-A', 1]], 8, { h: 14 }),
    table('Cautions and send-offs (Y yellow, 2Y second yellow, R red; give the offence code)', [['#', 0.5], ['Minute', 0.9], ['Team H/A', 0.9], ['No.', 0.8], ['Player / official', 3], ['Card', 0.8], ['Reason (offence code)', 3.4]], 6, { h: 14 }),
    table(`Substitutions (up to ${subs} each; write the minute and the numbers)`, [['#', 0.5], ['Minute', 0.9], ['Team H/A', 0.9], ['Off no.', 1], ['On no.', 1], ['Concussion sub', 1.4], ['Notes', 3]], Math.min(subs * 2, 10), { h: 14 }),
    table('Result by period', [['', 1.6, ['First half', 'Second half', 'Full time (90 min)', ...(tie !== 'Draw stands' && tie !== 'Penalties only' ? ['Extra time'] : []), ...(tie !== 'Draw stands' ? ['Penalty shoot-out'] : [])]], ['Home', 1], ['Away', 1]], 2 + 1 + (tie !== 'Draw stands' && tie !== 'Penalties only' ? 1 : 0) + (tie !== 'Draw stands' ? 1 : 0), { h: 17, width: 0.6 }),
    ...(tie !== 'Draw stands' ? [table('Penalty shoot-out (write the taker\'s number and tick scored / cross missed)', [['', 1.4, ['Home', 'Away']], ...nums(5).map((n) => [`Kick ${n}`, 1]), ['Sudden death 6-10', 3], ['Total', 0.8]], 2, { h: 22 })] : []),
    officials('Referee', 'Assistant referee 1', 'Assistant referee 2', 'Fourth official', 'VAR', 'Assistant VAR'),
    fields(['Match commissioner / delegate', 'Timekeeper', 'Medical / doping control'], 3),
    fields(['Referee report: incidents, misconduct, abandonment (write on the back if needed)', 'Match ball / equipment notes'], 1),
    ...finalResult(),
  ];
  return { title: 'Match report (FIFA style)', signatures: ['Referee', 'Home captain', 'Away captain'], sections };
}

export function futsalReport(ctx) {
  const half = rv(ctx, 'half', 20), fouls = rv(ctx, 'fouls', 5), to = rv(ctx, 'to', 1);
  return {
    title: 'Futsal match report', signatures: ['Referee', 'Home captain', 'Away captain'],
    sections: [
      ...rulesNote(ctx), matchInfo(),
      fields([`Period length (${half} min stopped time)`, 'Start first period', 'Start second period', 'Extra time / shoot-out'], 4),
      lineup('Players (5 on court incl. goalkeeper, rest are substitutes)', 5, Math.min(rv(ctx, 'named', 9), 9), { gk: true }),
      ticks(`Accumulated team fouls (the ${fouls + 1}th foul in a period gives a free kick without a wall)`, ['First period', fouls + 1], ['Second period', fouls + 1], ['Extra time', fouls + 1]),
      ticks('Timeouts', ['First period', to], ['Second period', to]),
      table('Goals', [['#', 0.5], ['Minute', 0.9], ['Period', 0.8], ['Team H/A', 0.9], ['Scorer no.', 1], ['Assist no.', 1], ['Type', 1.2], ['Score H-A', 1]], 12, { h: 14.5 }),
      table('Cards and fouls log', [['#', 0.5], ['Minute', 0.9], ['Period', 0.8], ['Team H/A', 0.9], ['No.', 0.8], ['Foul / card', 2], ['Team foul no.', 1.2]], 14, { h: 14.5 }),
      officials('Referee', 'Second referee', 'Third referee', 'Timekeeper'), ...finalResult(),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ cricket (ICC scorebook)
const CRICKET = {
  T10: { overs: 10, innings: 2, label: 'T10' },
  T20: { overs: 20, innings: 2, label: 'T20' },
  ODI: { overs: 50, innings: 2, label: 'ODI' },
  Test: { overs: null, innings: 4, label: 'Test' },
};
export const CRICKET_FORMATS = Object.keys(CRICKET);

export function cricketBook(ctx) {
  const f = CRICKET[ctx.variant] ?? CRICKET.T20, test = f.overs == null;
  const keyed = f.label === 'ODI' || f.label === 'T20';
  const overs = test ? 90 : keyed ? rv(ctx, f.label === 'ODI' ? 'ov_odi' : 'ov_t20', f.overs) : f.overs;
  const bowlerMax = test ? null : keyed ? rv(ctx, f.label === 'ODI' ? 'bq_odi' : 'bq_t20', Math.floor(overs / 5)) : Math.floor(overs / 5);
  const sections = [
    ...rulesNote(ctx),
    fields(['Competition / series', 'Match no.', 'Date(s)', 'Venue', 'Toss won by', 'Elected to', test ? 'Scheduled days' : 'Overs per innings', 'Umpires', 'Third umpire / match referee', 'Scorers'], 5),
    ...(test ? [fields(['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5'], 5), table('Daily record (write overs bowled, runs and wickets at the end of each session)', [['Day', 0.8, nums(5)], ['Session 1 ov / runs / wkts', 2], ['Session 2 ov / runs / wkts', 2], ['Session 3 ov / runs / wkts', 2], ['Total overs', 1], ['New ball (over)', 1], ['Light / rain lost', 1.4]], 5, { h: 20 })] : [fields([bowlerMax ? `Max overs per bowler: ${bowlerMax}` : 'Overs per bowler: no limit', 'Powerplay overs', 'Reviews per innings'], 3)]),
    table('Match summary (fill in at the end of each innings)', [['', 1.4, nums(f.innings).map((n) => `Innings ${n}`)], ['Batting team', 2.4], ['Runs', 1], ['Wickets', 1], ['Overs', 1], ['Extras', 1], ['Run rate', 1], ...(test ? [['Declared / follow-on', 1.6]] : [['Target', 1]])], f.innings, { h: 22 }),
    choices('Result', 'Home won', 'Away won', 'Tie', 'Draw', 'No result', 'Abandoned', 'Won by runs', 'Won by wickets', 'Won by an innings'),
    fields(['Won by', 'Player of the match', 'DLS / revised target notes', test ? 'Follow-on enforced? Innings declared at' : 'Super Over / tie-break'], 4),
    ...Array.from({ length: f.innings }, (_, i) => ({ t: 'cricket', innings: i + 1, overs, test })),
    ...finalResult(),
  ];
  return { title: `Scorebook (${f.label})`, orientation: 'landscape', signatures: ['Umpire', 'Umpire', 'Scorer'], sections };
}

// ------------------------------------------------------------------------------------------------------------------ hockey, ice hockey
export function fieldHockeyReport(ctx) {
  const q = rv(ctx, 'quarters', 4), len = rv(ctx, 'quarter', 15), green = rv(ctx, 'green', 2), yellow = rv(ctx, 'yellow', 5);
  const label = q === 2 ? 'Half' : 'Quarter';
  return {
    title: 'Hockey match report', signatures: ['Umpire', 'Home captain', 'Away captain'],
    sections: [
      ...rulesNote(ctx), matchInfo(),
      fields([`${q} x ${len} min ${label.toLowerCase()}s`, 'Start', 'End of each break', 'Extra time / shoot-out'], 4),
      lineup('Squad (up to 16: 11 on the pitch, the rest are rolling substitutes)', 11, 5, { gk: true }),
      table(`${label} scores and tallies`, [[label, 1, [...nums(q), 'Extra time', 'Shoot-out', 'Total']], ['Home goals', 1], ['Away goals', 1], ['Penalty corners H', 1], ['Penalty corners A', 1], ['Shots H', 0.8], ['Shots A', 0.8]], q + 3, { h: 16 }),
      table('Goals (G field goal, PC penalty corner, PS penalty stroke)', [['#', 0.5], ['Time', 0.9], [label, 0.8], ['Team H/A', 0.9], ['Scorer no.', 1], ['Assist no.', 1], ['Type', 1], ['Score H-A', 1]], 10, { h: 14.5 }),
      table(`Cards (green ${green} min, yellow at least ${yellow} min, red off for the match)`, [['#', 0.5], ['Time', 0.9], [label, 0.8], ['Team H/A', 0.9], ['No.', 0.8], ['Card G/Y/R', 1], ['Reason', 3], ['Back on at', 1]], 8, { h: 14.5 }),
      table('Penalty corners and strokes awarded', [['#', 0.5], ['Time', 0.9], [label, 0.8], ['Team H/A', 0.9], ['Corner / stroke', 1.4], ['Outcome', 2.4]], 8, { h: 14.5 }),
      ...(rv(ctx, 'tie', 'Shoot-out') !== 'Draw stands' ? [table('Shoot-out (each attempt within 8 s; tick scored, cross missed)', [['', 1.2, ['Home', 'Away']], ...nums(5).map((n) => [`Attempt ${n}`, 1]), ['Sudden death', 3]], 2, { h: 22 })] : []),
      officials('Umpire 1', 'Umpire 2', 'Video umpire', 'Technical officer', 'Timekeeper'), ...finalResult(),
    ],
  };
}

export function iceHockeySheet(ctx) {
  const periods = rv(ctx, 'periods', 3), len = rv(ctx, 'period', 20), minor = rv(ctx, 'minor', 2), major = rv(ctx, 'major', 5);
  return {
    title: 'Ice hockey game sheet (IIHF style)', signatures: ['Referee', 'Home manager', 'Away manager'],
    sections: [
      ...rulesNote(ctx), matchInfo(),
      fields([`${periods} x ${len} min stopped time`, 'Overtime', 'Shoot-out'], 3),
      pair('Roster (G goalkeeper, C captain, A alternate)', [['No', 0.6], ['Player', 3], ['Pos', 0.6], ['G', 0.5], ['A', 0.5], ['PIM', 0.6]], 22, { h: 12.5 }),
      table('Goals by period', [['', 1.6, [...nums(periods).map((n) => `Period ${n}`), 'Overtime', 'Shoot-out', 'Final']], ['Home', 1], ['Away', 1], ['Shots H', 1], ['Shots A', 1]], periods + 3, { h: 16 }),
      table('Scoring summary (strength: EV even, PP power play, SH short-handed, EN empty net, PS penalty shot)', [['#', 0.5], ['Per.', 0.6], ['Time', 0.9], ['Team H/A', 0.9], ['Scorer no.', 1], ['Assist 1', 1], ['Assist 2', 1], ['Strength', 1], ['Score H-A', 1]], 12, { h: 14 }),
      table(`Penalty summary (minor ${minor} min, major ${major} min, misconduct 10 min)`, [['#', 0.5], ['Per.', 0.6], ['Start', 0.9], ['Team H/A', 0.9], ['No.', 0.7], ['Infraction', 2.4], ['Min', 0.7], ['Served by', 1], ['End', 0.9]], 14, { h: 14 }),
      table('Goalkeepers', [['Team H/A', 0.9], ['No.', 0.7], ['Goalkeeper', 3], ['Time on', 1], ['Time off', 1], ['Shots against', 1.2], ['Saves', 0.9], ['Goals', 0.9]], 6, { h: 15 }),
      ticks('Timeouts (one per team)', ['Timeout', 1]),
      officials('Referee 1', 'Referee 2', 'Linesman 1', 'Linesman 2', 'Official scorer', 'Timekeeper'), ...finalResult(),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ american football, rugby
export function americanFootballSheet(ctx) {
  const to = rv(ctx, 'timeouts', 3), qlen = rv(ctx, 'quarter', 15);
  return {
    title: 'American football game sheet', signatures: ['Referee', 'Home head coach', 'Away head coach'],
    sections: [
      ...rulesNote(ctx), matchInfo(),
      fields([`4 x ${qlen} min quarters`, 'Coin toss won by', 'Opening kickoff received by'], 3),
      table('Score by quarter', [['', 1.6, ['Home', 'Away']], ['Q1', 1], ['Q2', 1], ['Q3', 1], ['Q4', 1], ['OT', 1], ['Final', 1]], 2, { h: 22 }),
      table('Scoring summary (TD touchdown 6, FG field goal 3, XP extra point 1, 2PT conversion 2, S safety 2)', [['#', 0.5], ['Qtr', 0.6], ['Time left', 0.9], ['Team H/A', 0.9], ['Play', 1], ['Player(s)', 3], ['Yards', 0.8], ['Home', 0.8], ['Away', 0.8]], 14, { h: 14.5 }),
      ticks('Timeouts', ['First half', to], ['Second half', to], ['Overtime', 2]),
      table('Team statistics', [['', 2, ['First downs', 'Rushing yards', 'Passing yards', 'Turnovers', 'Penalties / yards', 'Time of possession']], ['Home', 1.5], ['Away', 1.5]], 6, { h: 15 }),
      table('Penalty log', [['#', 0.5], ['Qtr', 0.6], ['Time', 0.8], ['Team H/A', 0.9], ['No.', 0.7], ['Foul', 2.6], ['Yards', 0.8], ['Accepted / declined', 1.4]], 10, { h: 14 }),
      table('Rosters (jersey numbers who played, with starters marked)', [['Home no.', 4], ['Away no.', 4]], 3, { h: 40 }),
      officials('Referee', 'Umpire', 'Head linesman', 'Line judge', 'Back judge', 'Field judge', 'Side judge'), ...finalResult(),
    ],
  };
}

export function rugbyReport(ctx) {
  const sevens = ctx.variant === 'Sevens', half = rv(ctx, sevens ? 'half_sevens' : 'half_union', sevens ? 7 : 40), yellow = rv(ctx, sevens ? 'yellow_sevens' : 'yellow_union', sevens ? 2 : 10), bench = rv(ctx, sevens ? 'bench_sevens' : 'bench_union', sevens ? 5 : 8);
  const starters = sevens ? 7 : 15;
  return {
    title: `Rugby ${sevens ? 'sevens' : 'union'} match report`, signatures: ['Referee', 'Home captain', 'Away captain'],
    sections: [
      ...rulesNote(ctx), matchInfo(),
      fields([`2 x ${half} min halves`, 'Kick-off', 'Half-time', 'Second half starts', 'Full time', 'Extra time'], 6),
      pair(`Teams (${sevens ? '1 to 7' : '1 to 15'}, then replacements)`, [['No', 0.6], ['Player', 3], ['C', 0.4], ['Tries', 0.7], ['Pts', 0.7], ['On / off', 1.1]], starters + bench, { h: 13 }),
      table('Scoring (T try 5, C conversion 2, PG penalty goal 3, DG drop goal 3, PT penalty try 7)', [['#', 0.5], ['Min', 0.8], ['Team H/A', 0.9], ['Score', 0.9], ['Scorer no.', 1], ['Name', 3], ['Score H-A', 1]], 14, { h: 14 }),
      table(`Cards (yellow ${yellow} min in the sin bin, red is a permanent dismissal)`, [['#', 0.5], ['Min', 0.8], ['Team H/A', 0.9], ['No.', 0.8], ['Card Y/R', 0.9], ['Offence', 3], ['Back on at', 1]], 6, { h: 14 }),
      table(`Replacements (${bench} each)`, [['#', 0.5], ['Min', 0.8], ['Team H/A', 0.9], ['Off no.', 1], ['On no.', 1], ['Reason (tactical / injury / blood / HIA)', 3.4]], bench, { h: 14 }),
      table('Half-time and full-time score', [['', 1.6, ['Half-time', 'Full time']], ['Home', 1], ['Away', 1], ['Tries H', 0.9], ['Tries A', 0.9]], 2, { h: 18 }),
      officials('Referee', 'Assistant referee 1', 'Assistant referee 2', 'TMO', 'Timekeeper'), ...finalResult(),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ racket sports
const RACKET_EXTRAS = {
  badminton: (ctx) => [fields([`First to ${rv(ctx, 'points', 21)} (win by 2, cap ${rv(ctx, 'cap', 30)})`, `Interval at 11 points: ${rv(ctx, 'interval', 60)} s`, `Between games: ${rv(ctx, 'gbreak', 120)} s`], 3), ticks('Faults and cautions', ['Service faults', 6], ['Cautions / warnings', 3], ['Injury or medical stops', 2])],
  'table-tennis': (ctx) => [fields([`Games to ${rv(ctx, 'points', 11)} (win by 2)`, `Serve changes every ${rv(ctx, 'serves', 2)} points`, 'First server (draw)', 'Order of play in doubles'], 4), ticks('Timeouts and cards', ['Timeout (1 minute)', rv(ctx, 'to', 1)], ['Yellow card', 2], ['Red card', 2])],
  pickleball: (ctx) => [fields([`Games to ${rv(ctx, 'points', 11)} (win by ${rv(ctx, 'winby', 2)})`, `${rv(ctx, 'scoring', 'Side-out')} scoring`, 'Score call (server score - receiver score - server number)'], 3), ticks('Timeouts and faults', ['Timeouts (1 minute)', rv(ctx, 'to', 2)], ['Kitchen faults', 6], ['Technical warnings', 3])],
  racquetball: (ctx) => [fields([`Games to ${rv(ctx, 'points', 15)}, tiebreaker to ${rv(ctx, 'tiebreak', 11)}`, 'First server (coin toss)', 'Serve order in doubles'], 3), ticks('Timeouts, hinders and technicals', ['Timeouts (30 s)', rv(ctx, 'to', 3)], ['Avoidable hinders', 4], ['Technical fouls', 3])],
  squash: (ctx) => [fields([`Games to ${rv(ctx, 'points', 11)} (win by ${rv(ctx, 'winby', 2)}), point-a-rally`, `Between games: ${rv(ctx, 'interval', 90)} s`, 'Referee decisions this match'], 3), ticks('Referee decisions', ['Let', 10], ['Stroke', 10], ['No let', 10], ['Conduct warning', 3])],
};
export const racketExtras = (slug, ctx) => RACKET_EXTRAS[slug]?.(ctx) ?? [];

// ------------------------------------------------------------------------------------------------------------------ chess
export function chessSheet(ctx) {
  const fmt = ctx.variant === 'Rapid' ? 'rapid' : ctx.variant === 'Blitz' ? 'blitz' : 'classical';
  const base = rv(ctx, `base_${fmt}`, { classical: 90, rapid: 15, blitz: 3 }[fmt]), inc = rv(ctx, `inc_${fmt}`, { classical: 30, rapid: 10, blitz: 2 }[fmt]);
  const rows = 30;
  return {
    title: 'Chess scoresheet (FIDE)', orientation: 'portrait', signatures: ['White', 'Black', 'Arbiter'],
    sections: [
      ...rulesNote(ctx),
      fields(['Event', 'Site', 'Date', 'Round', 'Board', 'Time control'], 3),
      fields(['White', 'White rating / ID', 'Black', 'Black rating / ID'], 4),
      fields([`Time control: ${base} min + ${inc} s per move`, 'Clock started at', 'Game ended at', 'Opening / ECO'], 4),
      table('Moves 1 to 60 (write each move in algebraic notation; mark a draw offer with (=) and the clock time when short of time)', [['No', 0.55, nums(rows)], ['White', 1.4], ['Black', 1.4], ['No', 0.55, nums(rows, rows + 1)], ['White', 1.4], ['Black', 1.4]], rows, { h: 12.6 }),
      table('Moves 61 to 120 (continue here for a long game)', [['No', 0.55, nums(rows, 61)], ['White', 1.4], ['Black', 1.4], ['No', 0.55, nums(rows, 91)], ['White', 1.4], ['Black', 1.4]], rows, { h: 12.6 }),
      choices('Result', 'White wins 1-0', 'Black wins 0-1', 'Draw 1/2-1/2', 'White forfeits', 'Black forfeits', 'Both forfeit'),
      choices('How it ended', 'Checkmate', 'Resignation', 'Time forfeit', 'Draw by agreement', 'Stalemate', 'Repetition', 'Fifty-move rule', 'Insufficient material'),
      ticks('Arbiter notes', ['Warnings', 3], ['Illegal moves (white)', 2], ['Illegal moves (black)', 2], ['Draw offers', 6]),
      fields(['Arbiter / table judge', 'Remarks (disputes, penalties)'], 2),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ combat
/** Rounds, round length and judges for a boxing format, with local rule values applied. */
export function boxingSetup(variant, values = {}) {
  const fmt = variant === 'Youth' ? 'youth' : variant === 'Professional' ? 'pro' : 'elite';
  return { rounds: values[`rounds_${fmt}`] ?? { elite: 3, youth: 3, pro: 10 }[fmt], minutes: values[`len_${fmt}`] ?? { elite: 3, youth: 2, pro: 3 }[fmt], judges: values.judges ?? (fmt === 'pro' ? 3 : 5), rest: values.rest ?? 1 };
}

export function boxingCard(ctx) {
  const { rounds, minutes: len, judges } = boxingSetup(ctx.variant, ctx.rules?.values);
  return {
    title: 'Bout scorecard (10-point must)', orientation: 'landscape', signatures: ['Referee', 'Supervisor', 'Corner / coach'],
    sections: [
      ...rulesNote(ctx),
      fields(['Event', 'Bout no.', 'Date', 'Weight class', `${rounds} x ${len} min rounds, ${rv(ctx, 'rest', 1)} min rest`, 'Ring / session'], 6),
      pair('Boxer', [['Name', 3], ['Club / country', 2], ['Corner', 1], ['Weight kg', 1]], 1, { h: 20 }),
      table('Round scores by judge (winner of the round 10, loser 9 or fewer; write points lost for fouls)', [['Round', 0.8, [...nums(rounds), 'Total']], ...nums(judges).flatMap((j) => [[`J${j} Red`, 0.9], [`J${j} Blue`, 0.9]]), ['Knockdowns R/B', 1.1], ['Warnings / cautions R/B', 1.4]], rounds + 1, { h: 18 }),
      ticks('Referee actions', ['Standing eight counts', 5], ['Cautions', 4], ['Warnings', 4], ['Knockdowns', 4]),
      choices('Result', 'Red wins', 'Blue wins', 'Draw', 'No contest'),
      choices('Method of victory', 'KO', 'RSC (referee stopped)', 'RSC-I (injury)', 'Points decision', 'Disqualification', 'Retirement', 'Walkover', 'Referee stopped (outclassed)'),
      fields(['Round and time of the finish', 'Winner', 'Referee', 'Timekeeper', 'Supervisor / jury'], 5),
    ],
  };
}

export function judoSheet(ctx) {
  const mins = rv(ctx, 'minutes', 4), shido = rv(ctx, 'shido', 3), ow = rv(ctx, 'osaekomi_waza', 10), oi = rv(ctx, 'osaekomi_ippon', 20);
  return {
    title: 'Judo contest sheet (IJF)', signatures: ['Referee', 'Judge', 'Scorekeeper'],
    sections: [
      ...rulesNote(ctx),
      fields(['Event', 'Weight category', 'Round / pool', 'Mat no.', 'Contest no.', `Contest time ${mins} min (golden score if level)`], 3),
      pair('Judoka (white and blue)', [['Name', 3], ['Country / club', 2], ['Judogi', 1]], 1, { h: 20 }),
      table(`Scores and penalties (waza-ari half point, ippon wins; hold-down ${ow} s waza-ari, ${oi} s ippon; write the technique name)`, [['#', 0.5], ['Clock', 0.9], ['Judoka W/B', 0.9], ['Score / penalty', 1.4], ['Technique / reason', 3], ['Hold-down s', 1], ['Golden score', 1]], 14, { h: 15 }),
      ticks(`Shidos (${shido} lose the contest)`, ['Shido', shido], ['Hansoku-make', 1]),
      table('Totals', [['', 2, ['Ippon', 'Waza-ari', 'Shido']], ['White', 1], ['Blue', 1]], 3, { h: 17, width: 0.6 }),
      choices('Result', 'White wins', 'Blue wins'), choices('Method', 'Ippon', 'Waza-ari at time', 'Shido (penalty)', 'Golden score', 'Hansoku-make', 'Fusen-gachi (walkover)', 'Kiken-gachi (injury)'),
      officials('Referee', 'Judge 1', 'Judge 2', 'Scorekeeper'),
    ],
  };
}

export function karateSheet(ctx) {
  const kata = ctx.variant === 'Kata', mins = rv(ctx, 'minutes', 3), lead = rv(ctx, 'lead', 8), judges = rv(ctx, 'judges', 5);
  if (kata) {
    return {
      title: 'Kata judging sheet (WKF)', orientation: 'landscape', signatures: ['Head judge', 'Scorer', 'Referee'],
      sections: [
        ...rulesNote(ctx),
        fields(['Event', 'Category', 'Round', 'Tatami', 'Session'], 5),
        table('Kata scores (technical 70 percent, athletic 30 percent; the highest and lowest judge scores are dropped)', [['Order', 0.6, nums(10)], ['Karateka', 2.2], ['Kata', 1.6], ...nums(judges).map((n) => [`J${n} tech`, 0.8]), ...nums(judges).map((n) => [`J${n} ath`, 0.8]), ['Tech total', 0.9], ['Ath total', 0.9], ['Final', 0.9], ['Rank', 0.7]], 10, { h: 19 }),
        officials('Head judge', 'Judges', 'Scorer'),
      ],
    };
  }
  return {
    title: 'Kumite scoresheet (WKF)', signatures: ['Referee', 'Judge', 'Scorekeeper'],
    sections: [
      ...rulesNote(ctx),
      fields(['Event', 'Category / weight', 'Round', 'Tatami', 'Bout no.', `Bout time ${mins} min`], 3),
      pair('Karateka (AKA red, AO blue)', [['Name', 3], ['Country / club', 2], ['Belt', 0.8]], 1, { h: 20 }),
      table(`Scoring (yuko 1, waza-ari 2, ippon 3; a ${lead}-point lead ends the bout; write the time left)`, [['#', 0.5], ['Time left', 0.9], ['Aka / Ao', 0.9], ['Points', 0.8], ['Technique', 2.6], ['Running AKA-AO', 1.3], ['Senshu', 0.8]], 16, { h: 15 }),
      table('Penalties (C1 contact and safety, C2 other; warn: chukoku, keikoku, hansoku-chui, hansoku)', [['', 1.2, ['AKA', 'AO']], ['Category 1', 1.4], ['Category 2', 1.4], ['Warning level reached', 1.8]], 2, { h: 20 }),
      table('Totals', [['', 2, ['Aka', 'Ao']], ['Points', 1], ['Senshu', 1], ['Penalty points', 1]], 2, { h: 18, width: 0.7 }),
      choices('Result', 'AKA wins', 'AO wins', 'Draw (flags in team events)'),
      choices('Method', 'Points', 'Lead of ' + lead + ' points', 'Senshu', 'Referee / judges (hantei)', 'Hansoku (disqualification)', 'Shikkaku', 'Kiken (withdrawal)'),
      officials('Referee', 'Judges', 'Scorekeeper'),
    ],
  };
}

export function weightliftingCard(ctx) {
  const n = rv(ctx, 'attempts', 3), clock = rv(ctx, 'clock', 60);
  const attempts = ['Snatch', 'Clean and jerk'].flatMap((g) => nums(n).flatMap((i) => [[`${g.startsWith('S') ? 'Sn' : 'C&J'} ${i} kg`, 0.9], ['Result', 0.7]]));
  return {
    title: 'Weightlifting competition card (IWF)', orientation: 'landscape', signatures: ['Technical controller', 'Referee', 'Recorder'],
    sections: [
      ...rulesNote(ctx),
      fields(['Event / session', 'Body weight category', 'Group', 'Platform', `Clock ${clock} s per attempt (${rv(ctx, 'clock2', 120)} s if consecutive)`], 5),
      table('Attempts (write the weight; result G good lift, X no lift; mark the referee lights W / R in the result box)', [['Lot', 0.5], ['Lifter', 2.2], ['Body kg', 0.8], ...attempts, ['Best Sn', 0.8], ['Best C&J', 0.8], ['Total', 0.9], ['Rank', 0.6]], 14, { h: 22 }),
      table('Weight changes (a lifter may only increase the declared weight)', [['Lot', 0.6], ['Attempt', 1], ['From kg', 1], ['To kg', 1], ['Time', 1], ['Notes', 3]], 6, { h: 15 }),
      officials('Referee (front)', 'Referee (side)', 'Referee (side)', 'Jury member', 'Technical controller', 'Recorder'),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ athletics
export const ATHLETICS_VARIANTS = ['Track heat', 'Horizontal jump / throw', 'High jump / pole vault'];

export function athleticsSheet(ctx) {
  const rt = rv(ctx, 'rt', 100), qp = rv(ctx, 'qp', 3), qt = rv(ctx, 'qt', 2), wind = rv(ctx, 'wind', 20) / 10, trials = rv(ctx, 'trials', 3), fin = rv(ctx, 'finalists', 8);
  const v = ctx.variant;
  if (v === 'High jump / pole vault') {
    return {
      title: 'Height ladder (vertical jumps)', orientation: 'landscape', signatures: ['Chief judge', 'Recorder', 'Referee'],
      sections: [
        ...rulesNote(ctx),
        fields(['Event', 'Round / group', 'Date', 'Venue', 'Opening height', 'Bar raises'], 6),
        table('Heights (write each height in the first row; X fail, O clear, - pass; three failures in a row end the competition)', [['Order', 0.5, nums(16)], ['Bib', 0.6], ['Athlete', 2.2], ['Country', 0.7], ...nums(16).map(() => ['', 0.5]), ['Best', 0.8], ['Fails', 0.6], ['Rank', 0.6]], 16, { h: 19 }),
        table('Jump-off for first place', [['Height', 1], ['Athlete', 3], ['Attempt', 1], ['Result', 1]], 4, { h: 15 }),
        officials('Chief judge', 'Judges', 'Recorder'),
      ],
    };
  }
  if (v === 'Horizontal jump / throw') {
    return {
      title: 'Field event attempt sheet', orientation: 'landscape', signatures: ['Chief judge', 'Recorder', 'Referee'],
      sections: [
        ...rulesNote(ctx),
        fields(['Event', 'Round / group', 'Date', 'Venue', 'Implement / wind gauge', `${trials} trials; the best ${fin} get ${trials} more`], 6),
        table(`Attempts (distance in metres, X foul, - pass; wind in m/s for jumps, limit ${wind.toFixed(1)})`, [['Order', 0.5], ['Bib', 0.6], ['Athlete', 2.2], ['Country', 0.7], ...nums(trials + 3).flatMap((i) => [[`T${i}`, 0.8], ['W', 0.4]]), ['Best', 0.8], ['Rank', 0.6]], 16, { h: 18 }),
        officials('Chief judge', 'Judges', 'Measurer', 'Wind gauge', 'Recorder'),
      ],
    };
  }
  return {
    title: 'Track heat sheet (Olympic style)', orientation: 'landscape', signatures: ['Chief judge', 'Starter', 'Photo-finish judge'],
    sections: [
      ...rulesNote(ctx),
      fields(['Event (e.g. 100 m)', 'Round (heat, semi, final)', 'Heat no.', 'Date', 'Start time', `Wind m/s (record limit ${wind.toFixed(1)})`], 6),
      table(`Result (reaction at least ${(rt / 1000).toFixed(3)} s; write DNS, DNF or DQ in Status; Q for the first ${qp}, q for the next ${qt} fastest)`, [['Lane', 0.55, nums(9)], ['Bib', 0.6], ['Athlete', 2.4], ['Country', 0.7], ['Reaction s', 0.9], ['Split 1', 0.9], ['Split 2', 0.9], ['Finish time', 1.1], ['Place', 0.6], ['Q / q', 0.6], ['Status', 0.8], ['Notes', 1.8]], 9, { h: 18 }),
      choices('Checks', 'False start (name the athlete in Notes)', 'Photo finish used', 'Wind gauge reading taken', 'Protest lodged'),
      officials('Chief judge', 'Starter', 'Photo-finish judge'),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ baseball
export function baseballBook(ctx) {
  const innings = rv(ctx, 'innings', 9), shown = Math.max(innings, 9);
  return {
    title: 'Baseball scorebook', orientation: 'landscape', signatures: ['Home plate umpire', 'Home scorer', 'Away scorer'],
    sections: [
      ...rulesNote(ctx), matchInfo(['Weather']),
      table(`Line score (${innings} innings, runs hits errors)`, [['Team', 2.2, ['Away', 'Home']], ...nums(shown).map((n) => [n, 0.7]), ['R', 0.8], ['H', 0.8], ['E', 0.8], ['LOB', 0.8]], 2, { h: 22 }),
      pair('Batting order (one box per plate appearance; write the result: 1B 2B 3B HR BB K F-8 6-3)', [['#', 0.5], ['Player', 2.6], ['Pos', 0.7], ...nums(Math.min(shown, 9)).map((n) => [n, 1]), ['AB', 0.6], ['R', 0.5], ['H', 0.5], ['RBI', 0.6]], 10, { h: 26 }),
      table('Pitchers', [['Side H/A', 0.8], ['Pitcher', 3], ['IP', 0.9], ['H', 0.8], ['R', 0.8], ['ER', 0.8], ['BB', 0.8], ['K', 0.8], ['Pitches', 1], ['W / L / S', 1]], 8, { h: 15 }),
      table('Play log (substitutions, errors, stolen bases, double plays)', [['Inn', 0.6], ['Top / Bot', 0.8], ['Event', 4], ['Runs scored', 1]], 8, { h: 14 }),
      officials('Home plate umpire', 'First base umpire', 'Second base umpire', 'Third base umpire', 'Official scorer'), ...finalResult(),
    ],
  };
}
