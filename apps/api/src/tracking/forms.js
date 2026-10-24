// Printable scoresheet forms (Tools > Scoring & Game Tracking). A form is plain data describing what a scorer fills in WHILE the game is
// played (running score, ball-by-ball, round cards, attempt grids ...). It only controls what is printed: scoring rules, results and
// validation still come from scoring/rulesets.js and scoring/engine.js. Pure functions, no database.
//
// Section types (drawn by documents/sheet-forms.js):
//   fields   { items:[label], per }                 blank write-in lines
//   table    { title, cols:[{t,w,fixed?}], rows, h, width }
//   pair     { title, cols, rows, h }               the same table for HOME and AWAY, side by side
//   running  { title, sides:true, max, per }        numbered boxes to strike through as points are scored
//   ticks    { title, items:[{label,n}] }           small boxes per side (timeouts, team fouls, substitutions)
//   choices  { title, items:[label] }               tick-one options (winner, method of victory)
//   cricket  { innings, overs }                     ball-by-ball grid + batting card + bowling card + fall of wickets

const col = (t, w = 1, fixed) => ({ t, w, ...(fixed ? { fixed } : {}) });
const cols = (...list) => list.map((c) => (Array.isArray(c) ? col(...c) : col(c)));
const nums = (n, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));

const fields = (items, per = 3) => ({ t: 'fields', items, per });
const table = (title, c, rows, o = {}) => ({ t: 'table', title, cols: cols(...c), rows, h: o.h ?? 16, width: o.width ?? 1 });
const pair = (title, c, rows, o = {}) => ({ t: 'pair', title, cols: cols(...c), rows, h: o.h ?? 15 });
const running = (title, max, per, o = {}) => ({ t: 'running', title, max, per, ...o });
const ticks = (title, ...items) => ({ t: 'ticks', title, items: items.map(([label, n]) => ({ label, n })) });
const choices = (title, ...items) => ({ t: 'choices', title, items });

const SIGN_INDIVIDUAL = ['Chief judge / referee', 'Scorer', 'Competitor / team rep'];
const WINNER = choices('Winner', 'Home', 'Away', 'Draw / no result');
const finalResult = (extra = []) => [
  table('Final result', [['', 2, ['Result as recorded by the official']], ['Home', 1.5], ['Away', 1.5]], 1, { h: 26, width: 0.7 }),
  WINNER, ...extra,
];
const officials = (...names) => fields(names.length ? names : ['Referee / umpire', 'Scorer', 'Timekeeper'], 3);

/** How many periods (and what they are called) for sports whose ruleset is not built in. */
const PERIODS = {
  'american-football': [4, 'Quarter'], 'australian-rules': [4, 'Quarter'], 'ice-hockey': [3, 'Period'], 'roller-hockey': [2, 'Half'],
  'gaelic-football': [2, 'Half'], hurling: [2, 'Half'], 'kho-kho': [2, 'Inning'], dodgeball: [1, 'Game'], 'ultimate-frisbee': [2, 'Half'],
  'wheelchair-basketball': [4, 'Quarter'], rounders: [2, 'Inning'], korfball: [4, 'Quarter'], polo: [4, 'Chukka'], 'canoe-polo': [2, 'Half'],
  'tug-of-war': [3, 'Pull'], 'beach-handball': [2, 'Half'], 'beach-soccer': [3, 'Period'], bandy: [2, 'Half'], floorball: [3, 'Period'],
  'field-hockey-indoor': [2, 'Half'], 'table-soccer': [1, 'Game'], 'rocket-league': [1, 'Game'], 'ea-fc': [2, 'Half'], 'sitting-volleyball': [5, 'Set'],
};

// ------------------------------------------------------------------------------------------------------------------ team games
function periodTable(count, label) {
  return table(`${label} scores`, [[label, 1, [...nums(count), 'Extra time']], ['Home', 2], ['Away', 2]], count + 1, { h: 17, width: 0.6 });
}

/** Football-style and other team sports: line-ups with their own columns, timed event log, discipline and timeout boxes. */
function teamGame({ ruleset, count = 2, label = 'Half', slug = '' }) {
  const events = ruleset?.kind === 'points_events' ? ruleset.events : [];
  const pLabel = ruleset?.kind === 'points_events' ? ruleset.periods.label : label;
  const pCount = ruleset?.kind === 'points_events' ? ruleset.periods.count : count;
  const basket = ['basketball', '3x3-basketball', 'wheelchair-basketball'].includes(slug);
  const evCols = events.slice(0, 3).map((e) => [e.label.slice(0, 12), 1.3]);
  const roster = basket
    ? pair('Players (fouls: strike through 1-5)', [['No', 0.7], ['Player', 3], ['Pts', 0.9], ...nums(5).map((n) => [n, 0.5])], slug === '3x3-basketball' ? 6 : 14, { h: 14 })
    : pair('Line-up', [['No', 0.7], ['Player', 3], ...(evCols.length ? evCols : [['Score', 1]]), ['Cards', 1], ['In / out', 1.2]], 16, { h: 14 });
  const legend = events.length ? `Scoring (${events.map((e) => `${e.label} = ${e.points}`).join(', ')})` : 'Scoring log';
  const sections = [periodTable(pCount, pLabel), roster];
  if (basket) {
    sections.push(running('Running score (strike through each point as scored)', slug === '3x3-basketball' ? 21 : 160, slug === '3x3-basketball' ? 21 : 40, { sides: true }));
    sections.push(ticks(`Team fouls per ${pLabel.toLowerCase()}`, [`${pLabel} 1-2`, 5], [`${pLabel} 3-4`, 5]));
    sections.push(ticks('Timeouts', ['Timeouts', slug === '3x3-basketball' ? 1 : 5]));
  } else {
    sections.push(ticks('Timeouts and discipline', ['Timeouts', 3], ['Team fouls', 10], ['Substitutions', 8]));
    sections.push(table(legend, [['#', 0.5], ['Time', 0.8], [pLabel, 0.9], ['Side H/A', 0.9], ['Event', 2], ['Player no.', 1], ['Running H-A', 1.2]], 18, { h: 14 }));
  }
  sections.push(...finalResult(), officials());
  return { title: 'Team match scoresheet', sections };
}

// ------------------------------------------------------------------------------------------------------------------ rally sets
function rallyGame({ ruleset, slug, variant }) {
  const s = ruleset.sets, n = s.best_of;
  const racket = ruleset.kind === 'sets' && !['volleyball', 'beach-volleyball', 'sitting-volleyball', 'sepak-takraw'].includes(slug);
  const doubles = variant === 'Doubles';
  const max = s.cap ?? s.points_to_win + 8;
  const sections = [];
  sections.push(racket ? pair(doubles ? 'Players (doubles)' : 'Player', [['Name', 3], ['Club / ID', 1.5]], doubles ? 2 : 1, { h: 16 })
    : pair('Players', [['No', 0.7], ['Name', 3], ['Role', 1]], slug.includes('beach') ? 2 : 12, { h: 13 }));
  sections.push(fields(['Toss won by', 'First server / receiver', 'Court / table'], 3));
  for (let i = 1; i <= n; i++) {
    sections.push(running(`Set ${i}: running points (first to ${i === n && s.deciding_points ? s.deciding_points : s.points_to_win}${s.win_by > 1 ? ', win by 2' : ''}${s.cap ? `, cap ${s.cap}` : ''}). Strike through each point; circle the server.`, max, max, { sides: true, compact: true }));
  }
  sections.push(table(`Sets (best of ${n})`, [['Set', 0.8, nums(n)], ['Home pts', 1.2], ['Away pts', 1.2], ['Winner H/A', 1], ['Start / end time', 1.6]], n, { h: 17 }));
  sections.push(slug.includes('volleyball') ? ticks('Timeouts and cautions', ['Timeouts', 2], ['Substitutions', 6], ['Cautions / faults', 6]) : ticks('Timeouts and cautions', ['Timeouts', 2], ['Cautions / faults', 6]));
  sections.push(...finalResult(), officials('Umpire / referee', 'Scorer', 'Line judge'));
  return { title: 'Rally scoresheet', sections };
}

// ------------------------------------------------------------------------------------------------------------------ cricket
const CRICKET_OVERS = { T10: 10, T20: 20, ODI: 50 };
export const CRICKET_VARIANTS = Object.keys(CRICKET_OVERS);
function cricket({ variant }) {
  const overs = CRICKET_OVERS[variant] ?? 20;
  return {
    title: `Scorebook (${CRICKET_OVERS[variant] ? variant : 'T20'})`, orientation: 'landscape',
    sections: [
      fields(['Toss won by', 'Elected to', 'Overs per innings', 'Umpire 1', 'Umpire 2', 'Scorers'], 6),
      table('Match summary (fill in at the end of each innings)', [['', 2, ['Innings 1', 'Innings 2']], ['Batting team', 2], ['Runs', 1], ['Wickets', 1], ['Overs', 1], ['Extras', 1], ['Run rate', 1]], 2, { h: 22 }),
      table('Final result', [['', 2, ['Result as recorded by the official']], ['Home', 1.5], ['Away', 1.5]], 1, { h: 26, width: 0.7 }),
      choices('Result', 'Home won', 'Away won', 'Tie', 'No result', 'Abandoned'),
      fields(['Player of the match', 'Won by (runs / wickets)', 'DLS / revised target notes'], 3),
      { t: 'cricket', innings: 1, overs }, { t: 'cricket', innings: 2, overs },
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ baseball family
function baseball({ ruleset, slug }) {
  const innings = ruleset?.periods?.count ?? (slug === 'rounders' ? 2 : 7);
  return {
    title: 'Baseball / softball scorebook',
    sections: [
      table('Line score', [['Team', 2.2, ['Home', 'Away']], ...nums(innings).map((n) => [n, 0.7]), ['R', 0.8], ['H', 0.8], ['E', 0.8]], 2, { h: 20 }),
      pair('Batting order', [['#', 0.5], ['Player', 3], ['Pos', 0.8], ...nums(innings).slice(0, 9).map((n) => [n, 0.7]), ['AB', 0.7], ['R', 0.7], ['H', 0.7], ['RBI', 0.7]], 10, { h: 15 }),
      table('Pitchers', [['Side H/A', 0.8], ['Pitcher', 3], ['IP', 1], ['H', 1], ['R', 1], ['ER', 1], ['BB', 1], ['K', 1]], 6, { h: 15 }),
      ...finalResult(), officials('Umpire (plate)', 'Scorer', 'Umpire (base)'),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ individual sports
const STRIKING = new Set(['boxing', 'kickboxing', 'muay-thai', 'mma']);
const TECHNICAL = new Set(['judo', 'karate', 'taekwondo', 'wrestling', 'sambo', 'ju-jitsu', 'kendo', 'kurash', 'pencak-silat', 'aikido', 'martial-arts']);
const boutHeader = () => [pair('Competitor', [['Name', 3], ['Club / country', 2], ['Wt kg', 0.8], ['Corner', 1]], 1, { h: 18 }), fields(['Weight class', 'Bout no.', 'Scheduled rounds / time'], 3)];

function combat({ slug }) {
  const sections = [...boutHeader()];
  if (STRIKING.has(slug)) {
    const rounds = slug === 'mma' ? 5 : 12;
    sections.push(table('Round scores (10-point must: winner 10, loser 9 or less; write penalty points taken)', [['Round', 0.8, [...nums(rounds), 'Total']], ...['Judge 1', 'Judge 2', 'Judge 3'].flatMap((j) => [[`${j} H`, 1], [`${j} A`, 1]]), ['Knockdown H/A', 1.1], ['Warning / penalty', 1.4]], rounds + 1, { h: 15 }));
  } else if (TECHNICAL.has(slug)) {
    sections.push(table('Scoring actions (write the time and tick each action as it is awarded)', [['#', 0.5], ['Time', 0.9], ['Side H/A', 0.9], ['Score / technique', 2.2], ['Penalty (shido / hansoku / warning)', 2.4], ['Running H-A', 1.2]], 20, { h: 15 }));
    sections.push(ticks('Penalties and cautions', ['Penalties', 4], ['Medical / injury time', 2]));
  } else if (slug === 'fencing') {
    sections.push(running('Touches (strike through each touch; bout to 15 or at time)', 15, 15, { sides: true }));
    sections.push(ticks('Cards and passivity', ['Yellow card', 2], ['Red card', 2], ['Passivity', 2]), table('Periods', [['Period', 1, ['1', '2', '3']], ['Home', 1.5], ['Away', 1.5], ['Time', 1.5]], 3, { h: 16 }));
  } else {
    sections.push(table('Rounds / bouts', [['Round', 1, nums(5)], ['Home', 1.4], ['Away', 1.4], ['Winner H/A', 1], ['Time', 1], ['Technique / notes', 2.4]], 5, { h: 18 }));
    sections.push(ticks('Warnings and penalties', ['Penalties', 4]));
  }
  sections.push(...finalResult(), choices('Method of victory', 'KO', 'TKO / stoppage', 'Decision', 'Points / ippon', 'Submission', 'Disqualification', 'Withdrawal / walkover'), officials('Referee', 'Judges / corner officials', 'Timekeeper'));
  return { title: STRIKING.has(slug) ? 'Bout scorecard' : 'Bout scoresheet', signatures: ['Referee', 'Scorer', 'Corner / coach'], sections };
}

function judged({ slug }) {
  const judgesN = ['diving', 'figure-skating', 'artistic-gymnastics', 'gymnastics', 'rhythmic-gymnastics', 'aerobic-gymnastics', 'trampoline', 'artistic-swimming'].includes(slug) ? 7 : 5;
  return {
    title: 'Judging panel sheet', signatures: SIGN_INDIVIDUAL, orientation: 'landscape',
    sections: [
      fields(['Round / phase', 'Apparatus / event / discipline', 'Panel chair'], 3),
      table('Panel scores (write each judge\'s mark; note the dropped high and low if the rules drop them)', [['Order', 0.6, nums(10)], ['Competitor', 2.4], ...nums(judgesN).map((n) => [`J${n}`, 0.7]), ['D / difficulty', 1], ['E / execution', 1], ['Deductions', 1], ['Total', 1], ['Rank', 0.7]], 10, { h: 19 }),
      table('Element / run log', [['Order', 0.6], ['Competitor', 2], ['Element / skill / dive code', 3], ['Value', 1], ['Run / attempt', 1], ['Comments', 2.4]], 8, { h: 17 }),
      choices('Result status', 'Completed', 'Protest lodged', 'Re-score ordered'),
      officials('Head judge', 'Recorder', 'Referee'),
    ],
  };
}

const JUDGED = new Set(['artistic-gymnastics', 'gymnastics', 'rhythmic-gymnastics', 'aerobic-gymnastics', 'trampoline', 'diving', 'artistic-swimming', 'figure-skating', 'freestyle-skiing', 'snowboarding', 'surfing', 'skateboarding', 'bmx-freestyle', 'breaking', 'parkour', 'dancesport', 'equestrian', 'wushu', 'kung-fu', 'bodybuilding', 'skydiving', 'wakeboarding', 'water-skiing']);
const STRENGTH = {
  weightlifting: [['Snatch', 3], ['C&J', 3]],
  powerlifting: [['Squat', 3], ['Bench', 3], ['Deadlift', 3]],
};
function weight({ slug }) {
  const groups = STRENGTH[slug] ?? [['Attempt', 3]];
  const attempts = groups.flatMap(([g, n]) => nums(n).map((i) => [`${g} ${i}`, 1.05]));
  return {
    title: 'Lifting attempt card', signatures: SIGN_INDIVIDUAL, orientation: 'landscape',
    sections: [
      fields(['Session / group', 'Bodyweight class', 'Platform / referee panel'], 3),
      table('Attempts (write the weight; mark G = good lift, X = no lift, R1 R2 R3 = referee lights)', [['Lot', 0.55], ['Athlete', 2.2], ['Body kg', 0.8], ...attempts, ['Best total', 1], ['Rank', 0.7]], 14, { h: 21 }),
      table('Weight changes', [['Lot', 0.6], ['Attempt', 1], ['From kg', 1], ['To kg', 1], ['Time', 1], ['Notes', 3]], 5, { h: 15 }),
      officials('Jury', 'Technical controller', 'Recorder'),
    ],
  };
}

const LADDER = new Set(['high-jump', 'pole-vault']);
const FIELD_ATTEMPTS = new Set(['long-jump', 'shot-put', 'javelin-throw']);
function distanceEvent({ slug }) {
  if (LADDER.has(slug)) {
    return {
      title: 'Height ladder (high jump / vault)', signatures: SIGN_INDIVIDUAL, orientation: 'landscape',
      sections: [
        fields(['Event / round', 'Opening height', 'Jury'], 3),
        table('Heights (write each height in the first row; X = fail, O = clear, - = pass)', [['Athlete', 2.4, ['Height (m)']], ['Bib', 0.7], ...nums(14).map((n) => ['', 0.55]), ['Best', 0.9], ['Rank', 0.7]], 13, { h: 22 }),
        table('Jump-off', [['Height', 1], ['Athlete', 3], ['Attempt', 1], ['Result', 1]], 3, { h: 15 }),
        officials('Chief judge', 'Recorder', 'Wind / measurement'),
      ],
    };
  }
  const six = FIELD_ATTEMPTS.has(slug);
  return {
    title: six ? 'Field event attempt sheet' : 'Distance results sheet', signatures: SIGN_INDIVIDUAL,
    sections: [
      fields(['Event / round', 'Implement / wind gauge', 'Jury'], 3),
      table(six ? 'Attempts (write distance in metres; X = foul; add wind for jumps)' : 'Results (write each round)', [['Order', 0.6], ['Bib', 0.7], ['Name', 2.3], ...(six ? nums(6).map((n) => [`Try ${n}`, 0.95]) : [['Round 1', 1.2], ['Round 2', 1.2], ['Points', 1]]), ['Best', 0.9], ['Rank', 0.7]], 14, { h: 19 }),
      officials('Chief judge', 'Recorder', 'Measurer'),
    ],
  };
}

function timeEvent({ slug }) {
  const splits = ['swimming', 'marathon-swimming', 'rowing', 'track-cycling', 'team-pursuit-cycling', 'speed-skating', 'short-track', 'athletics', 'running', 'relay-running', 'dragon-boat'].includes(slug);
  const wind = ['athletics', 'running', 'relay-running'].includes(slug);
  return {
    title: 'Heat / race result sheet', signatures: SIGN_INDIVIDUAL, orientation: 'landscape',
    sections: [
      fields(['Event / distance', 'Heat / round', 'Start time', 'Conditions (wind / water / track)'], 4),
      table('Results (write lane / bib, split times and final time as the finish is called)', [['Order', 0.6], ['Lane', 0.6], ['Bib', 0.7], ['Participant / team', 2.6], ...(splits ? [['Reaction', 0.9], ['Split 1', 0.9], ['Split 2', 0.9]] : []), ['Time', 1.1], ...(wind ? [['Wind', 0.7]] : []), ['DNS / DNF / DQ', 1.1], ['Rank', 0.7]], 12, { h: 20 }),
      table('Qualifiers / next round', [['Rank', 0.7], ['Participant', 3], ['Time', 1], ['Q / q', 0.8], ['Notes', 3]], 4, { h: 15 }),
      officials('Chief timekeeper', 'Starter', 'Recorder'),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ precision, board, esports
function precision({ slug }) {
  const officialsRow = officials('Marker / scorer', 'Judge / umpire', 'Referee');
  const players = pair('Players / teams', [['Name', 3], ['Club / ID', 1.5], ['Start no.', 1]], 1, { h: 16 });
  const total = finalResult();
  switch (slug) {
    case 'archery':
      return { title: 'Archery scorecard', signatures: SIGN_INDIVIDUAL, sections: [players, table('Ends (write each arrow: X, 10 ... 1, M)', [['End', 0.6, nums(10)], ...nums(6).map((n) => [`A${n}`, 0.8]), ['End total', 1], ['Running', 1], ['10s / X', 0.9]], 10, { h: 19 }), table('Set points (match play)', [['End', 1, nums(5)], ['Home', 1], ['Away', 1], ['Set pts H', 1], ['Set pts A', 1]], 5, { h: 15 }), ...total, officialsRow] };
    case 'golf': {
      const holes = (from) => table(from === 1 ? 'Front nine' : 'Back nine', [['', 1.6, ['Hole', 'Par', 'Player A', 'Player B', 'Player C', 'Player D']], ...nums(9, from).map((n) => [n, 0.9]), [from === 1 ? 'Out' : 'In', 1]], 6, { h: 16 });
      return { title: 'Golf scorecard', signatures: SIGN_INDIVIDUAL, sections: [fields(['Course / tees', 'Round', 'Marker'], 3), holes(1), holes(10), table('Totals', [['Player', 2], ['Out', 1], ['In', 1], ['Total', 1], ['Net / points', 1], ['Rank', 1]], 4, { h: 16 }), officialsRow] };
    }
    case 'bowling':
      return { title: 'Bowling scoresheet', signatures: SIGN_INDIVIDUAL, sections: [fields(['Lane', 'Game', 'Pair / team'], 3), table('Frames (small box: each ball; X strike, / spare, - miss; large box: running total)', [['Player', 2], ...nums(10).map((n) => [n, 1.1]), ['Total', 1]], 5, { h: 30 }), ...total, officialsRow] };
    case 'darts':
      return { title: 'Darts leg tracker', signatures: SIGN_INDIVIDUAL, sections: [players, table('Leg tracker (write the score remaining after each visit)', [['Visit', 0.7, ['Start', ...nums(14)]], ['Home remaining', 1.5], ['Home darts', 0.9], ['Away remaining', 1.5], ['Away darts', 0.9]], 15, { h: 15 }), table('Legs / sets', [['Leg / set', 1, nums(5)], ['Home', 1], ['Away', 1], ['Winner H/A', 1]], 5, { h: 15 }), ...total, officialsRow] };
    case 'snooker': case 'pool':
      return { title: slug === 'pool' ? 'Pool frame sheet' : 'Snooker frame sheet', signatures: SIGN_INDIVIDUAL, sections: [players, table('Frames', [['Frame', 0.8, nums(11)], ['Home', 1], ['Away', 1], ['Breaks 30+ (who / score)', 2.6], ['Winner H/A', 1], ['Time', 1]], 11, { h: 16 }), ...total, officialsRow] };
    case 'curling':
      return { title: 'Curling line score', signatures: SIGN_INDIVIDUAL, sections: [players, table('Ends (write points; mark the hammer with H)', [['', 1.6, ['Home', 'Away']], ...nums(10).map((n) => [n, 0.8]), ['Total', 1]], 2, { h: 24 }), ticks('Timeouts', ['Timeouts', 1]), ...total, officialsRow] };
    default:
      return { title: 'Scored match sheet', signatures: SIGN_INDIVIDUAL, sections: [players, table('Ends / rounds / frames', [['No', 0.7, nums(12)], ['Home', 1.4], ['Away', 1.4], ['Winner H/A', 1], ['Notes', 3]], 12, { h: 16 }), table('Cautions and penalties', [['#', 0.5], ['Time', 1], ['Side H/A', 1], ['Reason', 4]], 4, { h: 15 }), ...total, officialsRow] };
  }
}

function board() {
  return {
    title: 'Board / card game record', signatures: SIGN_INDIVIDUAL,
    sections: [
      pair('Players', [['Name', 3], ['Rating / ID', 1.2], ['Colour / seat', 1.2]], 1, { h: 17 }),
      fields(['Time control', 'Board / table', 'Round'], 3),
      table('Games', [['Game', 0.7, nums(6)], ['Home colour / side', 1.4], ['Moves / hands', 1], ['Result (1-0, 0-1, draw)', 1.6], ['Clock H', 1], ['Clock A', 1]], 6, { h: 18 }),
      table('Move / score log', [['No', 0.6, nums(24)], ['Home', 1.4], ['Away', 1.4], ['No', 0.6, nums(24, 25)], ['Home', 1.4], ['Away', 1.4]], 24, { h: 13 }),
      ticks('Warnings and time forfeits', ['Warnings', 3], ['Time forfeits', 2]),
      ...finalResult(), officials('Arbiter', 'Scorer', 'Table judge'),
    ],
  };
}

function esports() {
  return {
    title: 'Esports match sheet', signatures: SIGN_INDIVIDUAL,
    sections: [
      pair('Roster', [['Seat', 0.6], ['Player tag', 3], ['Role / character', 2]], 5, { h: 15 }),
      fields(['Title / patch', 'Format (bo1/bo3/bo5)', 'Server / lobby'], 3),
      table('Maps / rounds', [['Map', 0.8, nums(5)], ['Map / mode', 2], ['Home', 1], ['Away', 1], ['Winner H/A', 1], ['Bans / picks', 2.4]], 5, { h: 19 }),
      pair('Player stats for the match', [['Player', 3], ['K', 0.8], ['D', 0.8], ['A', 0.8], ['Objective', 1.2]], 5, { h: 15 }),
      table('Pauses and rule events', [['#', 0.5], ['Map', 0.8], ['Side H/A', 1], ['Reason', 4], ['Time', 1]], 5, { h: 15 }),
      ...finalResult(), officials('Admin / referee', 'Scorer', 'Observer'),
    ],
  };
}

function multiEvent() {
  return {
    title: 'Multi-event score sheet', signatures: SIGN_INDIVIDUAL,
    sections: [
      fields(['Category / class', 'Round / session', 'Venue / station'], 3),
      table('Events (write the result and the points awarded for each)', [['No', 0.5, nums(10)], ['Event / discipline', 2.4], ['Result (time, reps, distance)', 2], ['Points', 1], ['Running total', 1.2], ['Notes', 2]], 10, { h: 17 }),
      table('Participants', [['Order', 0.6], ['Bib', 0.7], ['Name', 3], ['Total', 1.2], ['Rank', 0.8]], 10, { h: 16 }),
      officials('Chief judge', 'Recorder', 'Referee'),
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------ selection
/** Cricket formats (overs) are labels for the printed sheet only. */
export const variantsOf = (slug) => (slug === 'cricket' ? CRICKET_VARIANTS : null);

const BASEBALL = new Set(['baseball', 'softball', 'rounders']);

/**
 * The scoresheet form for a sport: its own slug first, then its ruleset kind, then its scoring family and play type. Every sport gets a
 * form that can be used during play; the plain "Manual totals" page is only the last resort for a sport the catalogue does not know.
 * @param {{slug?:string, scoring?:string, play_type?:string, name?:string}} sport
 */
export function formFor(sport, ruleset, variant = '') {
  const slug = sport?.slug ?? '', kind = ruleset?.kind;
  if (slug === 'cricket') return cricket({ variant });
  if (BASEBALL.has(slug)) return baseball({ ruleset, slug });
  if (kind === 'sets') return rallyGame({ ruleset, slug, variant });
  if (kind === 'points_events') return teamGame({ ruleset, slug });
  // the sport's own slug wins: the catalogue's scoring family is coarse and some sports were first seeded as plain "points"
  if (STRIKING.has(slug) || TECHNICAL.has(slug) || slug === 'fencing' || sport?.scoring === 'combat') return combat({ slug });
  if (JUDGED.has(slug) || sport?.scoring === 'judged') return judged({ slug });
  if (STRENGTH[slug] || sport?.scoring === 'weight') return weight({ slug });
  if (LADDER.has(slug) || FIELD_ATTEMPTS.has(slug) || sport?.scoring === 'distance') return distanceEvent({ slug });
  if (sport?.scoring === 'time') return timeEvent({ slug });
  if (sport?.scoring === 'goals') { const [count, label] = PERIODS[slug] ?? [2, 'Half']; return teamGame({ ruleset, count, label, slug }); }
  if (sport?.play_type === 'board') return board();
  if (sport?.play_type === 'esports') return esports();
  if (['archery', 'golf', 'bowling', 'darts', 'snooker', 'pool', 'curling', 'petanque', 'lawn-bowls', 'croquet', 'cornhole', 'boccia', 'shooting', 'disc-golf'].includes(slug)) return precision({ slug });
  if (sport?.play_type === 'team' || PERIODS[slug]) { const [count, label] = PERIODS[slug] ?? [2, 'Half']; return teamGame({ ruleset, count, label, slug }); }
  if (['decathlon', 'modern-pentathlon', 'crossfit', 'calisthenics', 'fitness', 'yoga', 'pilates', 'zumba'].includes(slug) || sport?.play_type === 'individual') return multiEvent();
  return precision({ slug });
}

/** Every string a form prints, so the renderer can check the font covers it. */
export function formStrings(form) {
  const out = [];
  const walk = (v) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(form);
  return out;
}
