// The standard rulebook for each supported sport: plain-language rule cards plus the few settings a competition may localise.
// This is reference content written for SportArena (a summary, not the governing body's text) with a link to the official book.
// A card's params are the only things a local rule set may change; everything else is the standard and is never edited.
// Pure data, no database. rulebook/apply.js turns local values into scoring-ruleset changes and printed "rules in force" lines.

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
/** A whole-number setting: shown as a stepper. */
const num = (key, label, std, min, max, unit = '', o = {}) => ({ key, label, type: 'int', std, min, max, unit, step: o.step ?? 1, ...(o.help ? { help: o.help } : {}), ...(o.formats ? { formats: o.formats } : {}) });
/** A fixed choice: shown as chips. */
const pick = (key, label, std, options, o = {}) => ({ key, label, type: 'choice', std, options, ...(o.help ? { help: o.help } : {}), ...(o.formats ? { formats: o.formats } : {}) });
/** An on/off setting: shown as a switch. */
const flag = (key, label, std, o = {}) => ({ key, label, type: 'bool', std, ...(o.help ? { help: o.help } : {}), ...(o.formats ? { formats: o.formats } : {}) });
const card = (no, title, body, params = [], formats) => ({ key: slug(title), no, title, body, params, ...(formats ? { formats } : {}) });

const NOTE = 'A summary for scorers and players, not the full text. The official book decides any dispute.';

export const BOOKS = {
  // ------------------------------------------------------------------------------------------------------ football
  football: {
    name: 'Football', emoji: '⚽', body: 'IFAB Laws of the Game', official_url: 'https://www.theifab.org/laws-of-the-game-documents/', note: NOTE,
    cards: [
      card('Law 1', 'Field of play', 'A rectangular natural or artificial surface marked with lines. The touchlines are longer than the goal lines, and the lines belong to the area they enclose. A ball is in play on the line.'),
      card('Law 2', 'The ball', 'Round, made of suitable material, circumference 68 to 70 cm, at the right pressure. A damaged ball is replaced at the next stoppage.'),
      card('Law 3', 'The players', 'Two teams of no more than 11 players, one of them the goalkeeper. A match cannot start or continue with fewer than 7 players in a team. Substitutes are named before kick-off and may only come on at a stoppage, from the halfway line, with the referee\'s permission.',
        [num('subs', 'Substitutions per team', 5, 0, 11, '', { help: 'The Laws allow up to 5 where the competition rules say so.' }), num('named', 'Substitutes named on the team sheet', 12, 0, 23)]),
      card('Law 4', 'Players\' equipment', 'Shirt, shorts, socks, shinguards and footwear. Nothing dangerous may be worn. A team\'s colours must be clearly different from its opponents\' and the officials\'. The captain wears an armband.'),
      card('Law 5', 'The referee', 'Has full authority to enforce the Laws. Keeps the time and a record of the match, including cautions, send-offs and incidents, and may stop, suspend or abandon the match.'),
      card('Law 6', 'Other match officials', 'Assistant referees, a fourth official, and where used a video assistant referee and assistants. They help the referee, and the referee makes the decision.'),
      card('Law 7', 'Duration of the match', 'Two equal halves. The referee adds time lost to substitutions, injuries, discipline and other delays at the end of each half. The interval between halves is not more than 15 minutes.',
        [num('half', 'Length of each half', 45, 5, 60, 'min'), num('ht', 'Half-time interval', 15, 5, 15, 'min')]),
      card('Law 8', 'Start and restart of play', 'A coin toss and a kick-off start each half and restart play after a goal. A dropped ball restarts play after a stoppage that no other restart covers. Every player must be in their own half at a kick-off.'),
      card('Law 9', 'Ball in and out of play', 'The ball is out when it wholly crosses a goal line or touchline on the ground or in the air, or when the referee stops play. At all other times it is in play.'),
      card('Law 10', 'Determining the outcome', 'A goal is scored when the whole ball passes over the line between the posts and under the crossbar. The team with more goals wins. If a knockout game is level, the competition rules may add extra time and then kicks from the penalty mark, taken alternately.',
        [pick('tie', 'If a knockout game is level', 'Extra time then penalties', ['Extra time then penalties', 'Penalties only', 'Draw stands']), num('et', 'Extra time, each half', 15, 5, 15, 'min')]),
      card('Law 11', 'Offside', 'A player is in an offside position if any part of the head, body or feet is in the opponents\' half and nearer the opponents\' goal line than both the ball and the second-last opponent. It is only an offence when the player becomes involved in active play. There is no offside from a goal kick, throw-in or corner kick.'),
      card('Law 12', 'Fouls and misconduct', 'A direct free kick or penalty kick is given for careless, reckless or excessive force. A yellow card cautions and a red card sends a player off. A second caution in the same match is a send-off. Dissent, time wasting and unsporting behaviour are cautionable.',
        [pick('bin', 'Temporary dismissal (sin bin) for cautions', 'Off', ['Off', '10 minutes', '5 minutes'], { help: 'Only used where a competition has adopted it, usually in grassroots football.' })]),
      card('Law 13', 'Free kicks', 'Direct (a goal can be scored against the offending team) or indirect (the ball must touch another player first). The ball is stationary and opponents are at least 9.15 m (10 yards) away unless they form a wall of three or more at a defended free kick.'),
      card('Law 14', 'The penalty kick', 'Taken from the penalty mark. The goalkeeper keeps at least part of one foot on the goal line until the ball is kicked. The ball must be kicked forward. Penalties in a shoot-out follow the same procedure.'),
      card('Law 15', 'The throw-in', 'Awarded to the opponents of the player who last touched the ball over the touchline. Taken with both hands from behind and over the head, standing on or behind the touchline. A goal cannot be scored directly.'),
      card('Law 16', 'The goal kick', 'Awarded when the attacking team last touches the ball before it crosses the goal line without a goal. The ball is in play once it is kicked and clearly moves. Opponents stay outside the penalty area until then.'),
      card('Law 17', 'The corner kick', 'Awarded when the defending team last touches the ball before it crosses the goal line without a goal. Taken from the corner arc. A goal can be scored directly against the opponents.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ futsal
  futsal: {
    name: 'Futsal', emoji: '⚽', body: 'FIFA Futsal Laws of the Game', official_url: 'https://www.fifa.com/', note: NOTE,
    cards: [
      card('Law 1-2', 'Court and ball', 'A hard rectangular court with touchlines and goal lines. The ball is a size 4 low-bounce ball.'),
      card('Law 3', 'The players', 'Two teams of up to five players including the goalkeeper. A team with fewer than three players cannot continue. Substitution is by rolling (flying) changes through the team\'s own substitution zone, any number of times.',
        [num('named', 'Substitutes named', 9, 0, 14)]),
      card('Law 7', 'Duration of the match', 'Two equal periods. The clock stops whenever the ball is out of play (stopped time). Each team may call one timeout of one minute in each period.',
        [num('half', 'Length of each period', 20, 5, 25, 'min'), num('ht', 'Half-time interval', 15, 5, 15, 'min'), num('to', 'Timeouts per team, per period', 1, 0, 3), num('tomin', 'Timeout length', 1, 1, 3, 'min')]),
      card('Law 10', 'Determining the outcome', 'The team with more goals wins. If a knockout game is level, the competition may add two periods of extra time and then kicks from the penalty mark.',
        [pick('tie', 'If a knockout game is level', 'Extra time then penalties', ['Extra time then penalties', 'Penalties only', 'Draw stands']), num('et', 'Extra time, each period', 5, 3, 10, 'min')]),
      card('Law 12', 'Fouls and misconduct', 'Direct free kicks for fouls as in football, plus the accumulated fouls rule: from a team\'s sixth foul in a period, every further foul gives the opponents a direct free kick with no wall from the second penalty mark. Yellow and red cards are used. A sent-off player may be replaced after two minutes or when the other team scores.',
        [num('fouls', 'Fouls a team may commit before the penalty-style free kick', 5, 3, 8, '', { help: 'The standard is five accumulated fouls; the sixth gives the free kick.' })]),
      card('Law 13-16', 'Restarts', 'Kick-ins replace throw-ins (the ball is kicked in from the touchline). A goalkeeper has four seconds to release the ball, and the four-second count also applies to kick-ins, corners and goal clearances.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ cricket
  cricket: {
    name: 'Cricket', emoji: '🏏', body: 'ICC Playing Conditions and the MCC Laws of Cricket', official_url: 'https://www.icc-cricket.com/about/cricket/rules-and-regulations/playing-conditions', note: NOTE,
    formats: ['T20', 'ODI', 'Test'],
    cards: [
      card('Format', 'Innings and overs', 'T20: each side bats once for up to 20 overs. ODI: each side bats once for up to 50 overs. Test: each side bats twice, with no limit on overs in an innings, over up to five days. An over is six legal balls.',
        [num('ov_t20', 'Overs per innings', 20, 5, 20, 'overs', { formats: ['T20'] }), num('ov_odi', 'Overs per innings', 50, 10, 50, 'overs', { formats: ['ODI'] }), num('days', 'Scheduled days', 5, 1, 5, 'days', { formats: ['Test'] })]),
      card('Teams', 'The teams', 'Eleven players a side. A captain leads each team and each team names its players before the toss. Substitute fielders may field but may not bat, bowl or captain. A concussion replacement is allowed under the playing conditions.'),
      card('Bowling', 'The over and the bowler', 'An over is six legal balls bowled from one end. A bowler cannot bowl two overs in a row. In a limited-overs match no bowler may bowl more than one fifth of the innings\' overs. In a Test there is no limit on a bowler\'s overs.',
        [num('bq_t20', 'Most overs per bowler', 4, 1, 20, 'overs', { formats: ['T20'] }), num('bq_odi', 'Most overs per bowler', 10, 1, 50, 'overs', { formats: ['ODI'] })], ['T20', 'ODI']),
      card('Fielding', 'Powerplay and fielding limits', 'T20: the first six overs are the powerplay with two fielders allowed outside the 30-yard circle, then five fielders outside it for the rest. ODI: the first 10 overs have two outside the circle, overs 11 to 40 have four, and overs 41 to 50 have five.',
        [num('pp_t20', 'Powerplay overs', 6, 0, 10, 'overs', { formats: ['T20'] }), num('pp_odi', 'First powerplay overs', 10, 0, 15, 'overs', { formats: ['ODI'] })], ['T20', 'ODI']),
      card('Extras', 'Wides, no-balls, byes and leg byes', 'A wide or a no-ball adds a penalty run to the batting side and is not a legal ball, so it is bowled again. Byes and leg byes are runs taken off the body or when the batter does not hit the ball. They are team extras, not credited to the batter. A no-ball in limited-overs cricket is followed by a free hit.',
        [num('pen', 'Penalty runs for a wide or no-ball', 1, 1, 2, 'run'), flag('freehit', 'Free hit after a no-ball', true, { formats: ['T20', 'ODI'] })]),
      card('Batting', 'Ways to be out', 'Bowled, caught, leg before wicket (lbw), run out, stumped, hit wicket, hit the ball twice, handled the ball, obstructing the field, timed out. Only a bowler is credited with bowled, caught, lbw, stumped and hit wicket. Run out is not credited to the bowler.'),
      card('Review', 'Decision review', 'Each side has a set number of unsuccessful reviews in an innings. A review is lost when the original decision stands.',
        [num('drs_t20', 'Reviews per innings', 1, 0, 3, '', { formats: ['T20'] }), num('drs_odi', 'Reviews per innings', 2, 0, 3, '', { formats: ['ODI'] }), num('drs_test', 'Reviews per innings', 2, 0, 3, '', { formats: ['Test'] })]),
      card('Result', 'Result, tie and Super Over', 'The side that scores more runs wins. A completed limited-overs match with equal scores is a tie. In a knockout it can be decided by a Super Over, one over a side. If rain interrupts play, the Duckworth-Lewis-Stern method sets a revised target. A Test that is not finished in the scheduled time is drawn, and equal runs after both sides have batted twice is a tie.',
        [pick('so', 'If a limited-overs knockout is tied', 'Super Over', ['Super Over', 'Shared result', 'Bowl-out'], { formats: ['T20', 'ODI'] }), num('minov', 'Fewest overs each side must face for a result', 5, 5, 20, 'overs', { formats: ['T20', 'ODI'] })], ['T20', 'ODI']),
      card('Test', 'The day\'s play', 'A Test day has at least 90 overs, in three sessions with a lunch and tea interval. The new ball may be taken after 80 overs. Bad light and rain can shorten the day, and lost overs are made up when possible.',
        [num('mo', 'Minimum overs per day', 90, 60, 100, 'overs'), num('newball', 'New ball available after', 80, 60, 100, 'overs')], ['Test']),
      card('Test', 'Declaration and follow-on', 'A captain may declare an innings closed at any time. If the side batting second is behind by 200 runs or more after the first innings of a match of five days or more, the other captain may enforce the follow-on, so the trailing side bats again straight away.',
        [num('fo', 'Follow-on margin', 200, 75, 250, 'runs')], ['Test']),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ athletics
  athletics: {
    name: 'Athletics', emoji: '🏃', body: 'World Athletics Competition Rules (as used at the Olympic Games)', official_url: 'https://worldathletics.org/about-iaaf/documents/book-of-rules', note: NOTE,
    cards: [
      card('Track', 'Lanes and heats', 'Races up to 400 m are run in lanes (some 800 m starts are too). Heats, semi-finals and finals are drawn or seeded by earlier results. The heat sheet lists lane, athlete and country, and the best seeds get the centre lanes.'),
      card('Start', 'False starts', 'An athlete who starts before the gun is charged with a false start and is disqualified; there is no warning in individual events. A reaction time under 0.100 seconds after the gun is treated as a false start. Starting blocks are required up to 400 m.',
        [num('rt', 'Earliest legal reaction', 100, 50, 200, 'ms', { step: 10 })]),
      card('Track', 'Timing and placing', 'Races are timed electronically to the hundredth of a second, and a photo finish decides close placings. An athlete places by the moment the torso reaches the finish line. Times that are equal to the hundredth are shared places unless the timing system separates them.'),
      card('Track', 'Qualifying for the next round', 'Athletes advance from each heat by place (Q) and the next fastest losers advance by time (q). The numbers are set in the competition regulations and published before the event.',
        [num('qp', 'Advance by place, each heat', 3, 1, 8), num('qt', 'Then advance by time', 2, 0, 8)]),
      card('Wind', 'Wind readings', 'In races up to 200 m and in the long jump and triple jump the wind is measured. A following wind over 2.0 metres per second means the result cannot be a record.',
        [num('wind', 'Wind limit (tenths of a m/s)', 20, 10, 30, '', { help: 'In tenths: 20 means 2.0 m/s.' })]),
      card('Field', 'Throws and horizontal jumps', 'Each athlete has three trials in the first round. The best athletes (usually the top eight) then get three more. The best valid mark counts. A trial is a foul if the athlete steps over the line or leaves the circle or runway incorrectly.',
        [num('trials', 'Trials in the first round', 3, 1, 6), num('finalists', 'Athletes who take the extra trials', 8, 4, 12)]),
      card('Field', 'High jump and pole vault', 'The bar goes up by a fixed amount after each round. Each height allows three attempts, and three failures in a row, at any height, end the athlete\'s competition. An athlete may pass a height. A tie for first place is settled by a jump-off.'),
      card('Rules', 'Disqualification and protests', 'An official may disqualify an athlete who breaks a rule. A protest is made verbally to the referee at the time or within 30 minutes of the result, and the athlete may compete under protest while it is settled.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ table tennis
  'table-tennis': {
    name: 'Table tennis', emoji: '🏓', body: 'ITTF Laws of Table Tennis', official_url: 'https://www.ittf.com/handbook/', note: NOTE,
    cards: [
      card('Scoring', 'A game and a match', 'A game is won by the first player or pair to 11 points, but only with a lead of two (so 11-10 continues to 12-10). A match is the best of an odd number of games, usually five and sometimes seven in finals.',
        [num('points', 'Points to win a game', 11, 5, 21, 'points'), num('bestof', 'Best of games', 5, 1, 9, 'games', { step: 2 })]),
      card('Service', 'The serve', 'Each player serves two points in turn, then the other serves two. At 10-10 each player serves one point in turn until the game is won. The ball is tossed up at least 16 cm and struck so that it bounces on the server\'s side and then the receiver\'s.',
        [num('serves', 'Serves each before changing', 2, 1, 5)]),
      card('Play', 'A good return', 'After the serve the ball is returned once by each side, straight over or around the net. A rally is lost if a player fails to return the ball, strikes it twice in succession, or touches the table with their free hand.'),
      card('Doubles', 'Doubles', 'In doubles the serve goes from the right-hand half to the opponents\' right-hand half, and partners must hit the ball in turn. Pairs change who serves and receives in each game.'),
      card('Match', 'Timeouts and intervals', 'A player or pair may take one timeout of up to one minute in a match. There is a rest of up to one minute between games, and players change ends after every game and at 5 points in a deciding game.',
        [num('to', 'Timeouts per match', 1, 0, 3)]),
      card('Conduct', 'Conduct and cards', 'A yellow card is a warning. After that, a yellow and a red card shown together give the opponent a penalty point, and a red card alone is also a penalty point. Coaching is only allowed between games or during a timeout.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ hockey
  hockey: {
    name: 'Hockey', emoji: '🏑', body: 'FIH Rules of Hockey', official_url: 'https://www.fih.hockey/', note: NOTE,
    cards: [
      card('Rule 2', 'The teams', 'Eleven players a side, up to 16 on the team sheet. Substitution is allowed at any time and any number of times. A team may play with a goalkeeper or with a kicking-back player who wears a different shirt.'),
      card('Rule 3', 'Duration of the match', 'Four quarters of 15 minutes, with a two-minute interval between the first and second quarters and between the third and fourth, and a longer half-time. The clock stops for penalty strokes and when the umpire stops play.',
        [num('quarters', 'Periods in a match', 4, 2, 4), num('quarter', 'Length of each quarter', 15, 5, 25, 'min'), num('ht', 'Half-time interval', 10, 5, 15, 'min')]),
      card('Rule 7', 'Scoring', 'A goal is scored when the ball is hit or deflected by an attacker from inside the shooting circle and passes fully over the goal line between the posts. The side with more goals wins.'),
      card('Rule 9', 'Conduct of play', 'The ball may only be played with the flat side of the stick, not with the feet or body. A player cannot obstruct another player by shielding the ball with their stick or body. A free hit is the standard restart, taken 5 metres from opponents and played to another player.'),
      card('Rule 13', 'Penalty corner and penalty stroke', 'A penalty corner is awarded for a deliberate foul in the circle or an unintentional one in the defending 23 m. A penalty stroke is awarded for a deliberate foul that stops a probable goal, taken from a spot 6.4 m from the goal.'),
      card('Rule 14', 'Cards', 'A green card suspends a player for two minutes, a yellow for a minimum of five minutes, and a red sends the player off for the rest of the match.',
        [num('green', 'Green card suspension', 2, 1, 5, 'min'), num('yellow', 'Yellow card suspension (minimum)', 5, 2, 10, 'min')]),
      card('Rule 3.5', 'Shoot-out', 'In a knockout match that is level, five one-on-one attempts are taken by each team against the goalkeeper, each in eight seconds from the 23-metre line. If it is still level, sudden death follows.',
        [pick('tie', 'If a knockout game is level', 'Shoot-out', ['Shoot-out', 'Extra time then shoot-out', 'Draw stands']), num('shootsec', 'Seconds for each attempt', 8, 5, 10, 's')]),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ ice hockey
  'ice-hockey': {
    name: 'Ice hockey', emoji: '🏒', body: 'IIHF Official Rule Book', official_url: 'https://www.iihf.com/', note: NOTE,
    cards: [
      card('Teams', 'Players on the ice', 'Six a side at a time: a goalkeeper and five skaters. Players change on the fly. A team that is penalised plays short-handed while the penalty runs.'),
      card('Time', 'Periods and clock', 'Three periods of 20 minutes of stopped time, with a 15-minute intermission. The clock stops whenever play stops.',
        [num('periods', 'Regulation periods', 3, 2, 4), num('period', 'Length of a period', 20, 5, 25, 'min'), num('int', 'Intermission', 15, 5, 20, 'min')]),
      card('Time', 'Overtime and shoot-out', 'If a game is level after regulation, a sudden-death overtime of five minutes is played three-on-three (ten minutes in medal games, and shoot-outs only in the preliminary round). Then a shoot-out of three skaters each and sudden death decides it.',
        [num('ot', 'Overtime length', 5, 0, 20, 'min'), pick('tie', 'After overtime', 'Shoot-out', ['Shoot-out', 'Draw stands'])]),
      card('Scoring', 'Goals and assists', 'A goal counts when the puck wholly crosses the goal line between the posts and under the crossbar, propelled by a stick. Up to two assists are credited to the players who touched the puck before the scorer. The side with more goals wins.'),
      card('Penalties', 'Penalties', 'A minor penalty is two minutes, a double minor four minutes, and a major five minutes. A misconduct is ten minutes and the player is replaced. A game misconduct or a match penalty sends the player off for the game. A minor ends when the opponents score, and a major does not.',
        [num('minor', 'Minor penalty', 2, 1, 5, 'min'), num('major', 'Major penalty', 5, 3, 10, 'min'), num('misc', 'Misconduct', 10, 5, 15, 'min')]),
      card('Play', 'Offside and icing', 'A team is offside if an attacker enters the attacking zone before the puck. Icing is called when a player shoots the puck from their own half across the opponents\' goal line without it being touched, and the faceoff is in the offending team\'s zone.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ baseball
  baseball: {
    name: 'Baseball', emoji: '⚾', body: 'Official Baseball Rules / WBSC Rules', official_url: 'https://www.wbsc.org/en/baseball', note: NOTE,
    cards: [
      card('Game', 'The game and innings', 'Nine players a side in the field. A regulation game is nine innings, each split into a top half (visiting team bats) and a bottom half (home team bats). Each half ends after three outs. The team with more runs after the last inning wins.',
        [num('innings', 'Innings in a game', 9, 5, 9, 'innings')]),
      card('Batting', 'Balls, strikes and outs', 'Four balls is a walk. Three strikes is a strikeout. A strike is a swing and miss, a pitch in the strike zone not swung at, or a foul ball with fewer than two strikes. A batter is out on a strikeout, a caught fly ball, or a force or tag out of a runner.'),
      card('Scoring', 'Runs', 'A run scores each time a runner legally touches first, second, third and home base before the third out. A run does not score if the third out is a force out or the batter is out before reaching first on that play.'),
      card('Extras', 'Extra innings', 'If the score is tied after the last regulation inning, extra innings are played until one team leads after a full inning. Many competitions put a runner on base at the start of each extra inning to shorten the game.',
        [pick('extra', 'Runner placed at the start of extra innings', 'None', ['None', 'Runner on second', 'Runners on first and second'])]),
      card('Mercy', 'Run-ahead (mercy) rule', 'Where the competition uses it, a game ends early when one team is far enough ahead after a set number of innings.',
        [num('mercy_runs', 'Lead that ends the game', 10, 5, 20, 'runs'), num('mercy_after', 'Not before inning', 7, 4, 9, '')]),
      card('Pitching', 'Pitchers', 'A pitcher must pitch from the rubber and may not balk. A pitcher who is replaced cannot return to the game. Competitions may limit the pitches a pitcher can throw in a game or a week.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ american football
  'american-football': {
    name: 'American football', emoji: '🏈', body: 'NFL Rulebook (college and high school rules differ)', official_url: 'https://operations.nfl.com/the-rules/', note: NOTE,
    cards: [
      card('Game', 'Teams and time', 'Eleven players a side on the field. Four quarters of 15 minutes, a 12-minute half-time, and the clock stops on incomplete passes, out of bounds and timeouts. Each team has three timeouts in each half.',
        [num('quarter', 'Length of a quarter', 15, 5, 15, 'min', { help: 'High school games usually play 12-minute quarters.' }), num('timeouts', 'Timeouts per half', 3, 0, 4), num('ht', 'Half-time', 12, 5, 20, 'min')]),
      card('Downs', 'Downs and first downs', 'The offence has four downs to move the ball ten yards. Gaining the ten yards gives a new set of four downs. If it fails after fourth down, the ball goes to the other team, who start where the ball was. The offence usually punts or kicks a field goal on fourth down.'),
      card('Scoring', 'Scoring', 'A touchdown is six points. After it, a team kicks an extra point (one point) or runs or passes for a two-point conversion. A field goal is three points and a safety is two points for the defence. Scores are by team, not by player.'),
      card('Play', 'Play clock', 'The offence must snap the ball within a set time after the previous play ends or the referee signals ready.',
        [num('playclock', 'Play clock', 40, 25, 40, 's')]),
      card('Overtime', 'Overtime', 'A tied game goes to a timed overtime period. In the regular season it is 10 minutes. In the playoffs it continues until someone wins.',
        [num('ot', 'Overtime length', 10, 0, 15, 'min')]),
      card('Penalties', 'Penalties', 'Penalties are yardage losses and sometimes loss of down: for example offside is five yards, holding is ten yards and pass interference is a spot foul. The team that did not commit the penalty may decline it.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ rugby
  rugby: {
    name: 'Rugby', emoji: '🏉', body: 'World Rugby Laws of the Game', official_url: 'https://www.world.rugby/the-game/laws', note: NOTE,
    formats: ['Union', 'Sevens'],
    cards: [
      card('Teams', 'Teams and replacements', 'Union: fifteen a side with up to eight replacements, including cover for the front row. Sevens: seven a side with up to five replacements.',
        [num('bench_union', 'Replacements', 8, 0, 8, '', { formats: ['Union'] }), num('bench_sevens', 'Replacements', 5, 0, 5, '', { formats: ['Sevens'] })]),
      card('Time', 'Match time', 'Union: two halves of 40 minutes with a half-time of up to 15 minutes. Sevens: two halves of seven minutes with a two-minute half-time (ten-minute halves in finals). Time is added for injuries and the clock continues in normal play. A half ends when the ball goes dead after time is up.',
        [num('half_union', 'Length of each half', 40, 10, 40, 'min', { formats: ['Union'] }), num('half_sevens', 'Length of each half', 7, 5, 10, 'min', { formats: ['Sevens'] })]),
      card('Scoring', 'How points are scored', 'A try is five points, scored by grounding the ball in the opponents\' in-goal area. A conversion is two points. A penalty goal or a drop goal is three points. The conversion follows a try, from a spot in line with where it was grounded.'),
      card('Play', 'Passing and the ball', 'The ball may be carried, kicked and passed, but only backwards or sideways. A forward pass or a knock-on gives the opponents a scrum. A tackled player must release the ball and a ruck forms over it.'),
      card('Discipline', 'Cards', 'A yellow card means ten minutes in the sin bin in union (two minutes in sevens). A red card is permanent dismissal, and the side plays a player down unless a replacement is allowed.',
        [num('yellow_union', 'Yellow card', 10, 5, 15, 'min', { formats: ['Union'] }), num('yellow_sevens', 'Yellow card', 2, 1, 5, 'min', { formats: ['Sevens'] })]),
      card('Restarts', 'Scrums, lineouts and kicks', 'A scrum restarts play after a knock-on or forward pass. A lineout restarts after the ball goes into touch. A penalty may be kicked at goal, kicked to touch or tapped. In sevens a conversion must be a drop kick.'),
      card('Result', 'Extra time', 'In a knockout, a level match goes to extra time, then a kicking competition where the competition rules require it.',
        [pick('tie', 'If a knockout game is level', 'Extra time', ['Extra time', 'Draw stands'])]),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ pickleball
  pickleball: {
    name: 'Pickleball', emoji: '🏓', body: 'USA Pickleball Rulebook / IFP', official_url: 'https://usapickleball.org/what-is-pickleball/official-rules/', note: NOTE,
    cards: [
      card('Scoring', 'A game and a match', 'A game is played to 11 points and must be won by two. A match is usually the best of three games, and some events play one game to 15 or 21.',
        [num('points', 'Points to win a game', 11, 7, 25, 'points'), num('bestof', 'Best of games', 3, 1, 5, 'games', { step: 2 }), num('winby', 'Win by', 2, 1, 2, 'points')]),
      card('Scoring', 'Who scores', 'In side-out scoring only the serving side scores. In rally scoring either side scores every rally. Doubles in side-out scoring has two servers per side, and the first server on the opening side serves only once.',
        [pick('scoring', 'How points are won', 'Side-out', ['Side-out', 'Rally'])]),
      card('Serve', 'The serve', 'Served underhand and diagonally from behind the baseline, so the ball lands in the opposite service court, clear of the non-volley zone. Only one serve attempt is allowed, except for a let when the ball touches the net.'),
      card('Court', 'The kitchen and the two-bounce rule', 'The non-volley zone (the kitchen) extends seven feet from the net. A player may not volley while standing in it or touching its lines. After the serve each side must let the ball bounce once before any volley (the two-bounce rule).'),
      card('Match', 'Timeouts', 'Each side has two one-minute timeouts per game. There is a short break between games, and players change ends.',
        [num('to', 'Timeouts per game', 2, 0, 3)]),
      card('Conduct', 'Faults', 'A fault ends the rally: the ball hits the net on a serve and lands out, a volley in the kitchen, a ball bounces twice, or hits out of bounds. In side-out scoring a fault by the serving side is a side-out, and a fault by the receiving side gives the server a point.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ racquetball
  racquetball: {
    name: 'Racquetball', emoji: '🎾', body: 'International Racquetball Federation / USA Racquetball Rules', official_url: 'https://internationalracquetball.com/', note: NOTE,
    cards: [
      card('Scoring', 'A game and a match', 'A match is the best of three games. The first two games are played to 15 points and a tiebreaker, if needed, is played to 11. Only the server scores points; a rally won by the receiver is a side-out.',
        [num('points', 'Points to win a game', 15, 7, 21, 'points'), num('tiebreak', 'Points to win the tiebreaker', 11, 7, 15, 'points'), num('bestof', 'Best of games', 3, 1, 5, 'games', { step: 2 })]),
      card('Serve', 'The serve', 'The server drops the ball and hits it before it bounces twice, in the service zone, so that it hits the front wall first and lands beyond the short line. A server has two chances if the first serve is a fault. Two faults in a row are a side-out.'),
      card('Play', 'A rally', 'After the serve each side hits the ball before it bounces twice, and the ball must reach the front wall before it touches the floor. A hinder is any interference that stops a fair chance to play, and the rally is replayed.'),
      card('Match', 'Timeouts', 'Each player has three timeouts of 30 seconds per game, and two in the tiebreaker. There are two minutes between games, and five minutes before a tiebreaker.',
        [num('to', 'Timeouts per game', 3, 0, 5), num('tobreak', 'Timeouts in the tiebreaker', 2, 0, 5)]),
      card('Doubles', 'Doubles', 'Each side has two players. Each side has one server at a time, and both partners serve in each service turn, except for the first side which serves with only one partner in the first turn of each game.'),
      card('Conduct', 'Penalties and avoidable hinders', 'An avoidable hinder loses the rally. A technical foul is a warning and then a point is deducted. A player must wear protective eyewear at all times.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ squash
  squash: {
    name: 'Squash', emoji: '🎾', body: 'World Squash Federation Rules of Singles Squash', official_url: 'https://www.worldsquash.org/', note: NOTE,
    cards: [
      card('Scoring', 'A game and a match', 'Games use point-a-rally scoring: the winner of every rally scores. A game is won by the first to 11 points with a lead of two. A match is the best of five games (best of three in some events).',
        [num('points', 'Points to win a game', 11, 7, 15, 'points'), num('bestof', 'Best of games', 5, 1, 7, 'games', { step: 2 }), num('winby', 'Win by', 2, 1, 2, 'points')]),
      card('Serve', 'The serve', 'The server stands with at least one foot in the service box and hits the ball above the service line and below the out line on the front wall so it lands in the opposite quarter court. The winner of a rally serves next and may choose the side.'),
      card('Play', 'Return and movement', 'After each shot, the player gives the opponent a fair view of the ball and a free swing, and room to play it directly at the front wall. The ball must be played before it bounces twice, and must hit the front wall above the tin.'),
      card('Referee', 'Let, stroke and no let', 'A let means the rally is replayed when the opponent gave no room but the player could have hit it. A stroke means the player wins the rally when the opponent stopped a winning shot, and a no let means the rally continues.'),
      card('Match', 'Intervals', 'There are 90 seconds between games, and each player may be allowed up to 90 seconds for treatment for an injury per match.',
        [num('interval', 'Interval between games', 90, 30, 120, 's', { step: 10 })]),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ badminton
  badminton: {
    name: 'Badminton', emoji: '🏸', body: 'BWF Laws of Badminton', official_url: 'https://bwfbadminton.com/', note: NOTE,
    cards: [
      card('Scoring', 'A game and a match', 'A match is the best of three games. Rally point scoring: every rally gives a point to the winner. A game is won at 21 points with a two-point lead. At 29-all the next point wins the game, so the highest score is 30.',
        [num('points', 'Points to win a game', 21, 11, 31, 'points'), num('bestof', 'Best of games', 3, 1, 5, 'games', { step: 2 }), num('cap', 'Score where the next point wins', 30, 15, 40, 'points')]),
      card('Serve', 'The serve', 'The server serves diagonally from the right service court when their side\'s score is even, and from the left when it is odd. The shuttle is hit below the waist, with the racket head below the hand. The serve must land inside the diagonal court.'),
      card('Doubles', 'Singles and doubles courts', 'The court is narrower in singles (the inner side lines) and has a shorter back boundary in doubles. In doubles, the same server keeps serving after winning a rally, and partners swap courts.'),
      card('Match', 'Intervals and change of ends', 'There is a 60-second interval when a side first reaches 11 points and a 120-second interval between games. Players change ends after each game and at 11 in a deciding game.',
        [num('interval', 'Interval at 11 points', 60, 30, 90, 's'), num('gbreak', 'Interval between games', 120, 60, 180, 's')]),
      card('Faults', 'Faults and lets', 'It is a fault if the shuttle lands out, goes through or under the net, or a player touches the net or the shuttle twice. A let (replay) is called for unforeseen events such as the shuttle catching on the net on the serve.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ chess
  chess: {
    name: 'Chess', emoji: '♟️', body: 'FIDE Laws of Chess', official_url: 'https://handbook.fide.com/', note: NOTE,
    formats: ['Classical', 'Rapid', 'Blitz'],
    cards: [
      card('Result', 'Winning, drawing and points', 'A win is one point, a draw half a point and a loss none. A game is won by checkmate, resignation or the opponent\'s flag falling (when the opponent has enough material to mate). It is drawn by stalemate, agreement, insufficient material, threefold repetition or the fifty-move rule.'),
      card('Play', 'Touch-move and moves', 'If a player deliberately touches a piece, that piece must be moved if it can be, and a piece that is touched to capture must capture. Once a piece is released on a square, the move stands. A pawn reaching the last rank is promoted at once.'),
      card('Clock', 'Time control', 'Each player has a clock. A player loses on time if their time runs out, unless the opponent cannot checkmate by any series of legal moves. Increments add time after each move.',
        [num('base_classical', 'Starting time', 90, 30, 180, 'min', { formats: ['Classical'] }), num('inc_classical', 'Added per move', 30, 0, 60, 's', { formats: ['Classical'] }),
          num('base_rapid', 'Starting time', 15, 10, 60, 'min', { formats: ['Rapid'] }), num('inc_rapid', 'Added per move', 10, 0, 30, 's', { formats: ['Rapid'] }),
          num('base_blitz', 'Starting time', 3, 1, 10, 'min', { formats: ['Blitz'] }), num('inc_blitz', 'Added per move', 2, 0, 10, 's', { formats: ['Blitz'] })]),
      card('Notation', 'Recording the game', 'In classical play each player must write down every move, clearly, on the scoresheet. A player may stop recording in the last minutes when short of time. The scoresheet is signed by both players at the end.', [], ['Classical', 'Rapid']),
      card('Arbiter', 'Arrival and default time', 'A player who arrives after the default time loses the game by forfeit. The default time is zero in most FIDE events, so players must be at the board when the round starts.',
        [num('default', 'Default time', 0, 0, 60, 'min')]),
      card('Conduct', 'Conduct and draws', 'A player may offer a draw after making a move and before pressing the clock. Illegal moves are penalised by the arbiter (extra time for the opponent, and a loss on a second illegal move in classical play).'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ boxing
  boxing: {
    name: 'Boxing', emoji: '🥊', body: 'World Boxing Technical and Competition Rules (Olympic style)', official_url: 'https://www.worldboxing.org/', note: NOTE,
    formats: ['Elite', 'Youth', 'Professional'],
    cards: [
      card('Bout', 'Rounds and timing', 'Elite bouts are three rounds of three minutes with a one-minute rest. Youth bouts are three rounds of two minutes. Professional bouts are scheduled for four to twelve rounds of three minutes.',
        [num('rounds_elite', 'Rounds', 3, 1, 5, '', { formats: ['Elite'] }), num('len_elite', 'Round length', 3, 2, 3, 'min', { formats: ['Elite'] }),
          num('rounds_youth', 'Rounds', 3, 1, 5, '', { formats: ['Youth'] }), num('len_youth', 'Round length', 2, 1, 3, 'min', { formats: ['Youth'] }),
          num('rounds_pro', 'Rounds', 10, 4, 12, '', { formats: ['Professional'] }), num('len_pro', 'Round length', 3, 2, 3, 'min', { formats: ['Professional'] }),
          num('rest', 'Rest between rounds', 1, 1, 2, 'min')]),
      card('Scoring', 'The 10-point must system', 'Each judge scores every round. The winner of the round gets 10 points and the loser nine or fewer. A round that is even is scored 10-10 in some competitions. A knockdown, a foul and an official warning may lead to points deducted. The boxer with more round points wins the bout.',
        [num('judges', 'Judges scoring the bout', 5, 3, 5)]),
      card('Result', 'How a bout ends', 'A bout ends by knockout (a boxer cannot rise before the count of ten), a referee stopping the contest, a corner retiring the boxer, disqualification, or a points decision by the judges. A walkover is awarded if an opponent does not appear.'),
      card('Referee', 'Counts and cautions', 'The referee gives a standing eight count to a boxer who is hurt and may stop the contest if a boxer cannot continue safely. A caution is a warning for a foul, and repeated or serious fouls may lead to a point deduction or disqualification.'),
      card('Safety', 'Protective rules', 'Gloves, a mouthguard and a groin protector are compulsory. Boxers weigh in within a fixed time before the bout and fight in their weight category. A medical check is required before and after.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ judo
  judo: {
    name: 'Judo', emoji: '🥋', body: 'IJF Sport and Organisation Rules', official_url: 'https://www.ijf.org/', note: NOTE,
    cards: [
      card('Contest', 'Time and golden score', 'A senior contest lasts four minutes of actual time (the clock stops at "matte"). If the score is level at the end, the golden score period begins and the first score or penalty wins. Golden score has no time limit at senior level.',
        [num('minutes', 'Contest length', 4, 2, 5, 'min'), flag('golden', 'Golden score when level', true)]),
      card('Scoring', 'Ippon and waza-ari', 'Ippon (full point) ends the contest and is awarded for a throw with force and speed onto the back, a hold-down of 20 seconds, a submission, or a choke. Waza-ari (a half point) is a throw that is almost ippon or a hold-down of ten to nineteen seconds. The side with more waza-ari wins at the end of regular time.',
        [num('osaekomi_ippon', 'Hold-down for ippon', 20, 15, 25, 's'), num('osaekomi_waza', 'Hold-down for waza-ari', 10, 5, 15, 's')]),
      card('Penalties', 'Shido and hansoku-make', 'A shido is a penalty for a minor infringement such as passivity or an incorrect grip. Hansoku-make is a direct disqualification for a grave infringement, or the result of too many shidos. Check the current IJF rules for how many shidos a contest allows.',
        [num('shido', 'Shidos before the contest is lost', 3, 2, 4, '', { help: 'A penalty count is set by the competition rules.' })]),
      card('Contest', 'Starting and stopping', 'Players bow, start on "hajime" and the contest pauses on "matte". Players must be in a good judogi, with a clean and sound uniform, and a belt tied properly.'),
      card('Weight', 'Weight categories', 'Competitors fight in weight categories, weighed in the day before or on the morning of competition. A competitor who is over the limit is disqualified from the event.'),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ karate
  karate: {
    name: 'Karate', emoji: '🥋', body: 'WKF Kumite and Kata Competition Rules', official_url: 'https://www.wkf.net/', note: NOTE,
    formats: ['Kumite', 'Kata'],
    cards: [
      card('Kumite', 'Bout time', 'A senior men\'s kumite bout is three minutes. Senior women and younger age groups fight for two minutes. The clock stops when the referee calls "yame".',
        [num('minutes', 'Bout length', 3, 1, 4, 'min', { formats: ['Kumite'] })], ['Kumite']),
      card('Kumite', 'Points', 'Ippon is three points (high kicks to the head and techniques on a thrown opponent). Waza-ari is two points (a kick to the body). Yuko is one point (punches to the head, body or back). A technique scores only if it is correct in form, distance, timing and spirit and lands on a valid target.', [], ['Kumite']),
      card('Kumite', 'Winning', 'The competitor with more points at the end wins. A lead of eight points ends the bout at once. If the score is level and no point is scored, the senshu (first unopposed point) decides it, otherwise the judges decide the winner by vote.',
        [num('lead', 'Lead that ends the bout', 8, 5, 10, 'points')], ['Kumite']),
      card('Kumite', 'Penalties', 'Penalties are in categories: Category 1 is for contact and unsafe techniques and Category 2 is for other rule violations. Warnings, then penalty points, and finally disqualification are applied in steps.', [], ['Kumite']),
      card('Kata', 'Scoring', 'Judges score the technical performance (stances, techniques, transitions, timing, kime) for 70 percent of the mark and the athletic performance (strength, speed, balance, rhythm) for 30 percent. The highest and lowest judge scores are dropped and the rest are added.', [], ['Kata']),
      card('Kata', 'Rounds', 'Competitors perform a kata from the official list in each round and cannot repeat the same kata in the same competition. The best scorers advance through the rounds to the finals, and the medal matches are decided on the final scores.', [], ['Kata']),
      card('Kata', 'Performance and judging', 'Competitors perform a set kata. Five judges score the technical performance and the athletic performance. The highest and lowest are dropped. Each competitor performs a kata from the list, and cannot repeat one in the same competition.',
        [num('judges', 'Judges on the panel', 5, 3, 7, '', { formats: ['Kata'] })], ['Kata']),
    ],
  },
  // ------------------------------------------------------------------------------------------------------ weightlifting
  weightlifting: {
    name: 'Weightlifting', emoji: '🏋️', body: 'IWF Technical and Competition Rules', official_url: 'https://iwf.sport/', note: NOTE,
    cards: [
      card('Lifts', 'The two lifts', 'Each lifter performs the snatch, then the clean and jerk. The snatch is lifting the barbell from the platform to overhead in one movement. The clean and jerk is two movements: the bar is brought to the shoulders and then driven overhead.'),
      card('Attempts', 'Attempts', 'Each lifter has three attempts in each lift. The first attempt is declared before the competition and the weight can only go up, in steps of at least one kilogram. A lifter\'s total is the best valid snatch plus the best valid clean and jerk. A lifter with no valid snatch has no total.',
        [num('attempts', 'Attempts per lift', 3, 1, 3), num('inc', 'Smallest weight increase', 1, 1, 5, 'kg')]),
      card('Clock', 'The time allowed', 'A lifter has one minute from being called to start an attempt, and two minutes if they have two consecutive attempts.',
        [num('clock', 'Time for an attempt', 60, 30, 120, 's', { step: 10 }), num('clock2', 'If the lifter follows themselves', 120, 60, 180, 's', { step: 10 })]),
      card('Judging', 'The referee decision', 'Three referees (one at the front and two at the sides) show a white light for a good lift and a red light for a no lift. Two white lights of three make a good lift. A jury may review the decision.'),
      card('Ranking', 'Ties and ranking', 'The heavier total wins. If totals are equal, the lifter with the lower bodyweight ranks first. If bodyweights are also equal, the lifter who achieved the total first ranks first.'),
      card('Weighing', 'Weigh-in', 'Lifters weigh in on the day of competition within a fixed window, and must make their category weight. The lifters are then listed by lot number.'),
    ],
  },
};

/** Sports that share another sport's rulebook, as { book, format }. Rugby sevens is the Sevens format of the rugby book. */
export const ALIASES = { 'rugby-sevens': { book: 'rugby', format: 'Sevens' } };

/** The book and format that apply to a sport slug, or null when SportArena has no written rulebook for it yet. */
export function bookFor(slugOrBook, format) {
  const a = ALIASES[slugOrBook];
  const slug = a?.book ?? slugOrBook;
  const book = BOOKS[slug];
  if (!book) return null;
  const f = book.formats ? (book.formats.includes(format) ? format : (a?.format ?? book.formats[0])) : '';
  return { slug, book, format: f };
}

export const rulebookSlugs = () => Object.keys(BOOKS);

/** Cards shown for a format: a card with `formats` is only for those formats, and a param with `formats` likewise. */
export function cardsFor(book, format) {
  return book.cards
    .filter((c) => !c.formats || !format || c.formats.includes(format))
    .map((c) => ({ ...c, params: c.params.filter((p) => !p.formats || !format || p.formats.includes(format)) }));
}

/** Every param of a book, optionally limited to a format, keyed for validation. */
export const paramsOf = (book, format) => cardsFor(book, format).flatMap((c) => c.params);
