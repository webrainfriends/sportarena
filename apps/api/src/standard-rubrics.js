import { many } from './db.js';

/**
 * Standard coaching rubrics, one framework per governing body, given to a coach for the sports they coach.
 * They are starting points aligned with the assessment areas those bodies publish for player/athlete development
 * (FIFA, ICC, FIBA, FIVB, FIH, BWF, ITF, World Aquatics, World Athletics, the Olympic and Asian Games programmes);
 * they are not official documents and, like every rubric, their scores are the coach's own and never official statistics.
 * A coach can rename, add or remove dimensions (a new version is saved) or archive a standard they do not want.
 * Keys are permanent: they identify a standard for a coach, so never reuse or renumber one.
 */
const d = (key, name, description) => ({ key, name, description, scale_min: 1, scale_max: 5, direction: 'higher_is_better' });
const PHYSICAL = [d('speed_agility', 'Speed and agility'), d('strength_power', 'Strength and power'), d('endurance', 'Endurance')];
const MENTAL = [d('focus', 'Focus and composure'), d('resilience', 'Resilience under pressure'), d('coachability', 'Coachability')];

export const STANDARD_RUBRICS = [
  { key: 'fifa_technical', source: 'FIFA', name: 'FIFA technical skills', sports: ['football', 'futsal', 'beach-soccer'],
    dimensions: [d('first_touch', 'First touch'), d('passing', 'Passing'), d('dribbling', 'Dribbling and ball control'), d('shooting', 'Shooting and finishing'), d('defending_1v1', '1v1 defending'), d('aerial_ability', 'Aerial ability')] },
  { key: 'fifa_tactical', source: 'FIFA', name: 'FIFA tactical and mental', sports: ['football', 'futsal', 'beach-soccer'],
    dimensions: [d('positioning', 'Positioning'), d('decision_making', 'Decision-making'), d('game_reading', 'Reading the game'), d('work_rate', 'Work rate'), d('communication', 'Communication')] },
  { key: 'icc_batting', source: 'ICC', name: 'ICC batting', sports: ['cricket'],
    dimensions: [d('technique', 'Technique and balance'), d('shot_selection', 'Shot selection'), d('running_between_wickets', 'Running between the wickets'), d('temperament', 'Temperament and match awareness')] },
  { key: 'icc_bowling', source: 'ICC', name: 'ICC bowling', sports: ['cricket'],
    dimensions: [d('action', 'Action and run-up'), d('line_length', 'Line and length'), d('variation', 'Variations'), d('plans_control', 'Plans and control')] },
  { key: 'icc_fielding', source: 'ICC', name: 'ICC fielding and wicketkeeping', sports: ['cricket'],
    dimensions: [d('catching', 'Catching'), d('ground_fielding', 'Ground fielding'), d('throwing', 'Throwing accuracy'), d('wicketkeeping', 'Wicketkeeping')] },
  { key: 'fiba_skills', source: 'FIBA', name: 'FIBA skills and game sense', sports: ['basketball', '3x3-basketball', 'wheelchair-basketball'],
    dimensions: [d('shooting', 'Shooting'), d('ball_handling', 'Ball handling'), d('passing', 'Passing'), d('team_defence', 'Defence'), d('rebounding', 'Rebounding'), d('game_sense', 'Game sense')] },
  { key: 'fivb_skills', source: 'FIVB', name: 'FIVB skills and game sense', sports: ['volleyball', 'beach-volleyball', 'sitting-volleyball'],
    dimensions: [d('serve', 'Serve'), d('receive', 'Receive and pass'), d('set', 'Setting'), d('attack', 'Attack'), d('block_defence', 'Block and floor defence'), d('game_sense', 'Game sense')] },
  { key: 'fih_skills', source: 'FIH', name: 'FIH skills and game sense', sports: ['hockey', 'field-hockey-indoor'],
    dimensions: [d('stick_skills', 'Stick skills'), d('passing', 'Passing and receiving'), d('shooting', 'Shooting'), d('defending', 'Defending and tackling'), d('game_sense', 'Game sense')] },
  { key: 'bwf_skills', source: 'BWF', name: 'BWF technical and tactical', sports: ['badminton', 'speedminton'],
    dimensions: [d('footwork', 'Footwork'), d('strokes', 'Stroke quality'), d('serve_receive', 'Serve and return'), d('court_tactics', 'Court tactics'), d('consistency', 'Consistency')] },
  { key: 'itf_skills', source: 'ITF', name: 'ITF technical and tactical', sports: ['tennis', 'padel', 'pickleball', 'table-tennis', 'squash', 'soft-tennis', 'beach-tennis', 'racquetball'],
    dimensions: [d('groundstrokes', 'Groundstrokes'), d('serve_return', 'Serve and return'), d('net_play', 'Net play'), d('footwork', 'Footwork and movement'), d('tactics', 'Point construction and tactics')] },
  { key: 'wa_aquatics', source: 'World Aquatics', name: 'World Aquatics technique', sports: ['swimming', 'open-water-swimming', 'marathon-swimming', 'water-polo', 'diving', 'artistic-swimming'],
    dimensions: [d('stroke_technique', 'Stroke technique'), d('starts_turns', 'Starts and turns'), d('pacing', 'Pacing and race plan'), d('water_feel', 'Water feel and body position')] },
  { key: 'wa_athletics', source: 'World Athletics', name: 'World Athletics technique', sports: ['athletics', 'marathon', 'race-walking', 'relay-running', 'running', 'trail-running', 'javelin-throw', 'shot-put', 'high-jump', 'long-jump', 'pole-vault', 'decathlon'],
    dimensions: [d('technique', 'Event technique'), d('start_run_up', 'Start or run-up'), d('rhythm', 'Rhythm and pacing'), d('mechanics', 'Running or movement mechanics')] },
  { key: 'asian_kabaddi', source: 'Asian Games', name: 'Kabaddi raiding and defence', sports: ['kabaddi', 'kho-kho'],
    dimensions: [d('raiding', 'Raiding skills'), d('hand_foot_touch', 'Hand and foot touch'), d('ankle_chain_hold', 'Ankle, chain and hold'), d('escape', 'Escape and recovery'), d('team_coordination', 'Team coordination')] },
  { key: 'olympic_physical', source: 'Olympic Movement', name: 'Olympic physical profile', sports: '*', dimensions: PHYSICAL },
  { key: 'olympic_mental', source: 'Olympic Movement', name: 'Olympic mental performance', sports: '*', dimensions: MENTAL },
];

/** The standards that apply to a sport: its own framework(s), else the general Olympic ones; the general ones also go with every sport that has its own. */
export const standardsForSport = (slug) => STANDARD_RUBRICS.filter((s) => s.sports === '*' || s.sports.includes(slug));

/** The sports a coach coaches: their coach sport profiles and the teams they coach. */
export const coachSports = (coachId) => many(
  `SELECT DISTINCT s.id, s.slug FROM sports s WHERE s.id IN (
     SELECT sport_id FROM active_sport_profiles WHERE user_id=$1 AND role='coach'
     UNION SELECT t.sport_id FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1 AND m.role='coach' AND m.status='active')`, [coachId]);

/**
 * Gives the coach every standard for their sports that they do not have yet (including archived ones: archiving is "no thanks"),
 * attached to the sports it applies to. Safe to call repeatedly. Returns how many were added.
 */
export async function provisionStandardRubrics(coachId, client) {
  const q = client ? (s, p) => client.query(s, p).then((r) => r.rows) : many;
  const sports = await coachSports(coachId);
  if (!sports.length) return 0;
  const have = new Set((await q('SELECT standard_key FROM coaching_rubrics WHERE coach_id=$1 AND standard_key IS NOT NULL', [coachId])).map((r) => r.standard_key));
  let added = 0;
  for (const std of STANDARD_RUBRICS) {
    if (have.has(std.key)) continue;
    const mine = sports.filter((s) => std.sports === '*' || std.sports.includes(s.slug));
    if (!mine.length) continue;
    const [r] = await q(
      'INSERT INTO coaching_rubrics(coach_id, sport_id, name, standard_key, standard_source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id', [coachId, mine[0].id, std.name, std.key, std.source]);
    if (!r) continue;   // a concurrent request gave it first
    await q('INSERT INTO coaching_rubric_versions(rubric_id, version, dimensions) VALUES ($1,1,$2)', [r.id, JSON.stringify(std.dimensions)]);
    // the general Olympic rubrics are for every sport the coach coaches; the rest for the sports their body governs
    await q('INSERT INTO coaching_rubric_sports(rubric_id, sport_id) SELECT $1, unnest($2::uuid[])', [r.id, mine.map((s) => s.id)]);
    added++;
  }
  return added;
}
