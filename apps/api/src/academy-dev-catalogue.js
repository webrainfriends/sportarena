// Development plan: the competency frameworks. A competency is what a coach actually develops, and it differs by sport: a tennis serve is not a football
// first touch is not a cricket innings. Each sport in the catalogue belongs to ONE family with its own native competencies for the four sporting domains
// (technical, tactical, physical, mental); academic and personal competencies are universal. A sport with no native model uses the labelled `generic`
// family (fallback: true) so it is never silently treated as another sport, and the screen says so. test/academy-dev-plan.test.js walks the whole
// catalogue and reports which sports are native and which fall back.
//
// Each competency may carry intervention templates (what the coach typically schedules for it) and `match` words used to find the coach rubric
// dimension that already measures it (so the figure is read from the coach's own rubric, never invented here).

const c = (key, label, match, tasks = []) => ({ key, label, match, tasks });
const t = (kind, title) => ({ kind, title });

const FAMILIES = {
  racquet: {
    label: 'Racquet and net sports',
    sports: ['tennis', 'padel', 'pickleball', 'squash', 'badminton', 'table-tennis', 'racquetball', 'beach-tennis', 'soft-tennis', 'speedminton'],
    technical: [c('serve', 'Serve', ['serve', 'service'], [t('training_block', 'Serve mechanics and placement block'), t('video_review', 'Serve video review')]),
      c('return', 'Return of serve', ['return'], [t('training_block', 'Return positioning and block-return drill')]),
      c('forehand', 'Forehand', ['forehand', 'fh'], [t('training_block', 'Forehand pattern block'), t('video_review', 'Forehand video review')]),
      c('backhand', 'Backhand', ['backhand', 'bh'], [t('training_block', 'Backhand stability block')]),
      c('net_play', 'Net play and volleys', ['volley', 'net'], [t('training_block', 'Net transition block')]),
      c('variation', 'Slice, spin and variation', ['slice', 'spin', 'variation'])],
    tactical: [c('point_construction', 'Point construction', ['construction', 'pattern', 'point'], [t('video_review', 'Point-pattern analysis')]), c('shot_selection', 'Shot selection under pressure', ['selection', 'pressure']), c('opponent_reading', 'Reading the opponent', ['opponent', 'scout'], [t('video_review', 'Opponent scouting review')]), c('court_positioning', 'Court positioning', ['position'])],
    physical: [c('footwork', 'Footwork and movement', ['footwork', 'movement', 'agility'], [t('conditioning', 'Footwork and split-step session')]), c('speed_power', 'Speed and power', ['speed', 'power'], [t('conditioning', 'Power and rotation strength block')]), c('court_endurance', 'On-court endurance', ['endurance', 'stamina'], [t('conditioning', 'Repeated-effort endurance block')]), c('robustness', 'Robustness and load tolerance', ['robust', 'load'], [t('load_adjustment', 'Review weekly load and recovery')])],
    mental: [c('emotion_regulation', 'Emotional regulation', ['emotion', 'composure'], [t('psychology_session', 'Between-point routine session')]), c('focus', 'Focus between points', ['focus', 'concentration']), c('resilience', 'Resilience and comeback', ['resilien', 'comeback'], [t('psychology_session', 'Resilience and pressure-scoring session')]), c('routines', 'Match routines', ['routine'])],
  },
  invasion: {
    label: 'Invasion team sports',
    sports: ['football', 'futsal', 'beach-soccer', 'basketball', '3x3-basketball', 'netball', 'handball', 'beach-handball', 'field-hockey-indoor', 'hockey', 'ice-hockey', 'roller-hockey', 'floorball', 'bandy', 'rugby', 'rugby-sevens', 'american-football', 'australian-rules', 'gaelic-football', 'hurling', 'lacrosse', 'water-polo', 'korfball', 'ultimate-frisbee', 'wheelchair-basketball', 'kabaddi', 'kho-kho', 'dodgeball', 'polo', 'canoe-polo', 'sepak-takraw'],
    technical: [c('passing', 'Passing and distribution', ['pass'], [t('training_block', 'Passing under pressure block')]), c('first_touch', 'First touch and receiving', ['touch', 'receiv', 'control'], [t('training_block', 'Receiving on the half-turn block')]), c('carrying', 'Ball carrying and 1v1', ['carry', 'dribbl', '1v1']), c('finishing', 'Finishing and shooting', ['finish', 'shoot', 'shot'], [t('training_block', 'Finishing under fatigue block')]), c('set_skills', 'Set-piece and dead-ball skills', ['set', 'dead'])],
    tactical: [c('positioning', 'Positioning and spacing', ['position', 'spacing'], [t('video_review', 'Positioning clips review')]), c('pressing', 'Pressing and defensive triggers', ['press', 'trigger', 'defen'], [t('video_review', 'Pressing triggers review')]), c('transitions', 'Transitions', ['transition'], [t('training_block', 'Transition games block')]), c('decision_making', 'Scanning and decision-making', ['scan', 'decision'], [t('video_review', 'Decision clips review')])],
    physical: [c('speed', 'Speed and acceleration', ['speed', 'accel', 'sprint'], [t('conditioning', 'Sprint mechanics session')]), c('agility', 'Agility and change of direction', ['agility', 'direction'], [t('conditioning', 'Change-of-direction session')]), c('endurance', 'Aerobic and repeated-sprint endurance', ['endurance', 'aerobic', 'stamina'], [t('conditioning', 'Repeated-sprint block')]), c('strength', 'Strength and robustness', ['strength', 'robust'], [t('conditioning', 'Strength base block'), t('load_adjustment', 'Review weekly load and recovery')])],
    mental: [c('composure', 'Composure under pressure', ['compos', 'pressure'], [t('psychology_session', 'Pressure-moments session')]), c('leadership', 'Leadership and communication', ['leader', 'communicat']), c('resilience', 'Resilience after mistakes', ['resilien', 'mistake'], [t('psychology_session', 'Reset routine session')]), c('focus', 'Concentration across 90 minutes', ['focus', 'concentration'])],
  },
  bat_ball: {
    label: 'Bat and ball sports',
    sports: ['cricket', 'baseball', 'softball', 'rounders'],
    technical: [c('batting_technique', 'Batting technique', ['bat', 'hitting'], [t('training_block', 'Net batting block')]), c('bowling_pitching', 'Bowling / pitching control', ['bowl', 'pitch'], [t('training_block', 'Line-and-length block')]), c('fielding', 'Fielding and catching', ['field', 'catch'], [t('training_block', 'Catching and ground-fielding block')]), c('wicketkeeping_catching', 'Wicketkeeping / receiving', ['keep', 'receiv'])],
    tactical: [c('innings_building', 'Innings building and game awareness', ['innings', 'awareness'], [t('video_review', 'Innings review')]), c('field_placement', 'Field placement and match-ups', ['placement', 'match-up']), c('shot_selection', 'Shot selection', ['selection'])],
    physical: [c('power', 'Power and rotation', ['power', 'rotation'], [t('conditioning', 'Rotational power block')]), c('speed_running', 'Speed between the wickets / bases', ['speed', 'running']), c('shoulder_robustness', 'Shoulder and back robustness', ['robust', 'shoulder'], [t('load_adjustment', 'Review bowling / throwing load')]), c('endurance', 'Endurance', ['endurance'])],
    mental: [c('patience', 'Patience and shot discipline', ['patience', 'discipline']), c('pressure', 'Handling pressure overs / innings', ['pressure'], [t('psychology_session', 'Pressure-situations session')]), c('routines', 'Routines', ['routine'])],
  },
  combat: {
    label: 'Combat sports',
    sports: ['boxing', 'kickboxing', 'muay-thai', 'mma', 'judo', 'ju-jitsu', 'karate', 'taekwondo', 'wrestling', 'sambo', 'sumo', 'fencing', 'kendo', 'kung-fu', 'wushu', 'aikido', 'pencak-silat', 'kurash', 'martial-arts'],
    technical: [c('striking_grappling', 'Core technique (strikes, throws, blade work)', ['strik', 'throw', 'technique', 'blade'], [t('training_block', 'Technical drilling block')]), c('combinations', 'Combinations and counters', ['combination', 'counter']), c('defence', 'Defence and guard', ['defen', 'guard']), c('ground_clinch', 'Clinch and ground work', ['clinch', 'ground'])],
    tactical: [c('distance_timing', 'Distance and timing', ['distance', 'timing']), c('ring_craft', 'Ring / mat craft and game plan', ['craft', 'plan'], [t('video_review', 'Fight video review')]), c('opponent_reading', 'Reading the opponent', ['opponent'])],
    physical: [c('power', 'Explosive power', ['power', 'explos'], [t('conditioning', 'Power block')]), c('conditioning_rounds', 'Round-by-round conditioning', ['conditioning', 'endurance'], [t('conditioning', 'Interval conditioning block')]), c('mobility', 'Mobility and flexibility', ['mobility', 'flexib']), c('weight_management', 'Weight-class planning (with the athlete\'s providers)', ['weight'], [t('provider_referral', 'Weight-management plan with a qualified provider')])],
    mental: [c('composure', 'Composure and aggression control', ['compos', 'aggress']), c('resilience', 'Resilience under fatigue', ['resilien'], [t('psychology_session', 'Fatigue-pressure session')]), c('visualisation', 'Visualisation and routines', ['visual', 'routine'])],
  },
  aquatic: {
    label: 'Swimming and water sports',
    sports: ['swimming', 'diving', 'artistic-swimming', 'marathon-swimming', 'open-water-swimming', 'freediving', 'stand-up-paddleboarding', 'wakeboarding', 'water-skiing', 'windsurfing', 'kitesurfing', 'surfing', 'sailing', 'rowing', 'kayaking', 'canoe-slalom', 'canoe-sprint', 'dragon-boat', 'white-water-rafting'],
    technical: [c('stroke_technique', 'Stroke / paddle / board technique', ['stroke', 'technique', 'paddle'], [t('video_review', 'Underwater and stroke video review')]), c('starts_turns', 'Starts, turns and transitions', ['start', 'turn']), c('rhythm', 'Rhythm and efficiency', ['rhythm', 'efficien'])],
    tactical: [c('race_plan', 'Race plan and pacing', ['race', 'pacing'], [t('training_block', 'Pacing set')]), c('conditions_reading', 'Reading water and conditions', ['condition', 'water'])],
    physical: [c('aerobic_base', 'Aerobic base', ['aerobic', 'endurance'], [t('conditioning', 'Aerobic base block')]), c('strength_power', 'Strength and power', ['strength', 'power'], [t('conditioning', 'Dryland strength block')]), c('shoulder_robustness', 'Shoulder robustness', ['shoulder', 'robust'], [t('load_adjustment', 'Review weekly volume')])],
    mental: [c('race_focus', 'Race focus and pressure', ['focus', 'pressure'], [t('psychology_session', 'Race-routine session')]), c('consistency', 'Training consistency', ['consisten'])],
  },
  athletics: {
    label: 'Athletics, running and jumps',
    sports: ['athletics', 'decathlon', 'high-jump', 'long-jump', 'pole-vault', 'javelin-throw', 'shot-put', 'marathon', 'running', 'race-walking', 'relay-running', 'trail-running', 'cross-country-skiing', 'triathlon', 'modern-pentathlon'],
    technical: [c('event_technique', 'Event technique', ['technique', 'form'], [t('video_review', 'Technique video review')]), c('start_acceleration', 'Start and acceleration', ['start', 'accel']), c('rhythm_run_up', 'Rhythm and run-up / transitions', ['rhythm', 'run-up', 'transition'])],
    tactical: [c('race_plan', 'Race plan and pacing', ['race', 'pacing'], [t('training_block', 'Pacing session')]), c('competition_management', 'Competition management', ['competition'])],
    physical: [c('speed', 'Maximal speed', ['speed', 'sprint'], [t('conditioning', 'Speed session')]), c('strength_power', 'Strength and power', ['strength', 'power'], [t('conditioning', 'Strength and power block')]), c('aerobic_base', 'Aerobic base', ['aerobic', 'endurance'], [t('conditioning', 'Aerobic base block')]), c('robustness', 'Robustness and load tolerance', ['robust', 'load'], [t('load_adjustment', 'Review weekly load')])],
    mental: [c('competition_focus', 'Competition focus', ['focus'], [t('psychology_session', 'Competition-routine session')]), c('pain_effort_tolerance', 'Effort tolerance', ['tolerance', 'effort'])],
  },
  precision: {
    label: 'Precision and target sports',
    sports: ['golf', 'archery', 'shooting', 'darts', 'bowling', 'snooker', 'pool', 'curling', 'petanque', 'lawn-bowls', 'croquet', 'cornhole', 'disc-golf', 'boccia', 'carrom', 'biathlon'],
    technical: [c('fundamental_technique', 'Fundamental technique (stance, release, stroke)', ['technique', 'stance', 'release', 'stroke'], [t('video_review', 'Technique video review')]), c('consistency', 'Repeatability and grouping', ['consisten', 'group']), c('short_game', 'Short game / touch', ['short', 'touch'])],
    tactical: [c('course_management', 'Course / shot management', ['course', 'management', 'selection']), c('game_plan', 'Game plan and match-play', ['plan', 'match'])],
    physical: [c('stability', 'Postural stability', ['stabil', 'posture']), c('endurance', 'Endurance for long competition days', ['endurance']), c('mobility', 'Mobility', ['mobility'])],
    mental: [c('pre_shot_routine', 'Pre-shot routine', ['routine'], [t('psychology_session', 'Pre-shot routine session')]), c('pressure', 'Scoring under pressure', ['pressure']), c('focus', 'Focus and emotional control', ['focus', 'emotion'])],
  },
  gymnastic: {
    label: 'Gymnastics, skating and aesthetic sports',
    sports: ['gymnastics', 'artistic-gymnastics', 'rhythmic-gymnastics', 'aerobic-gymnastics', 'trampoline', 'figure-skating', 'skating', 'dancesport', 'breaking', 'parkour', 'skateboarding', 'cheer', 'calisthenics', 'zumba', 'pilates', 'yoga'],
    technical: [c('execution', 'Execution and form', ['execution', 'form'], [t('video_review', 'Routine video review')]), c('difficulty', 'Skill difficulty and progression', ['difficult', 'progress']), c('landings_edges', 'Landings, edges and control', ['landing', 'edge', 'control'])],
    tactical: [c('routine_design', 'Routine composition', ['routine', 'composition']), c('competition_prep', 'Competition preparation', ['competition'])],
    physical: [c('strength', 'Relative strength', ['strength'], [t('conditioning', 'Strength block')]), c('flexibility', 'Flexibility and mobility', ['flexib', 'mobility']), c('power', 'Power and elevation', ['power'])],
    mental: [c('fear_management', 'Confidence with new skills', ['fear', 'confidence'], [t('psychology_session', 'Confidence-building session')]), c('performance_composure', 'Performing under judging', ['compos', 'pressure'])],
  },
  strength: {
    label: 'Strength and power sports',
    sports: ['weightlifting', 'powerlifting', 'bodybuilding', 'crossfit', 'fitness', 'tug-of-war'],
    technical: [c('lift_technique', 'Lift technique', ['technique', 'lift'], [t('video_review', 'Bar-path video review')]), c('positions', 'Positions and bracing', ['position', 'brac'])],
    tactical: [c('attempt_selection', 'Attempt selection and peaking', ['attempt', 'peak'])],
    physical: [c('max_strength', 'Maximal strength', ['strength'], [t('conditioning', 'Strength cycle')]), c('power', 'Rate of force development', ['power']), c('recovery_capacity', 'Recovery capacity', ['recover'], [t('load_adjustment', 'Review weekly load')])],
    mental: [c('competition_focus', 'Competition focus', ['focus']), c('consistency', 'Training consistency', ['consisten'])],
  },
  wheeled_winter: {
    label: 'Cycling, snow, ice and speed sports',
    sports: ['cycling', 'track-cycling', 'team-pursuit-cycling', 'mountain-biking', 'bmx-racing', 'bmx-freestyle', 'virtual-cycling', 'alpine-skiing', 'freestyle-skiing', 'snowboarding', 'ski-jumping', 'nordic-combined', 'ski-mountaineering', 'short-track', 'speed-skating', 'bobsleigh', 'skeleton', 'luge', 'sledding', 'roller-sports', 'motocross', 'karting', 'motorsport', 'formula-racing', 'skydiving', 'paragliding', 'snowshoeing', 'hiking'],
    technical: [c('line_technique', 'Technique and line choice', ['technique', 'line'], [t('video_review', 'Run / lap video review')]), c('starts', 'Starts and transitions', ['start', 'transition']), c('equipment_handling', 'Equipment and bike / board handling', ['handling', 'equipment'])],
    tactical: [c('race_craft', 'Race craft and drafting', ['race', 'draft']), c('course_reading', 'Course reading and conditions', ['course', 'condition'])],
    physical: [c('aerobic_base', 'Aerobic base', ['aerobic', 'endurance'], [t('conditioning', 'Base block')]), c('power', 'Peak power', ['power'], [t('conditioning', 'Power block')]), c('robustness', 'Robustness and load tolerance', ['robust', 'load'], [t('load_adjustment', 'Review weekly load')])],
    mental: [c('risk_calibration', 'Risk calibration and confidence', ['risk', 'confidence'], [t('psychology_session', 'Risk and confidence session')]), c('race_focus', 'Race focus', ['focus'])],
  },
  volleyball: {
    label: 'Volleyball family',
    sports: ['volleyball', 'beach-volleyball', 'sitting-volleyball'],
    technical: [c('serve', 'Serve', ['serve'], [t('training_block', 'Serve accuracy and float / jump block')]), c('serve_receive', 'Serve receive and passing', ['receiv', 'pass', 'dig'], [t('training_block', 'Serve-receive block')]), c('setting', 'Setting', ['set'], [t('training_block', 'Setting consistency block')]), c('attack', 'Attack and spike', ['attack', 'spike'], [t('video_review', 'Attack video review')]), c('block', 'Block', ['block'])],
    tactical: [c('rotation_systems', 'Rotation and serve-receive systems', ['rotation', 'system']), c('shot_selection', 'Shot selection and court reading', ['selection', 'read'], [t('video_review', 'Opposition tendencies review')])],
    physical: [c('vertical_jump', 'Jump and explosive power', ['jump', 'power', 'explos'], [t('conditioning', 'Plyometric and jump-landing block')]), c('lateral_speed', 'Lateral movement and agility', ['lateral', 'agility']), c('shoulder_robustness', 'Shoulder and knee robustness', ['shoulder', 'knee', 'robust'], [t('load_adjustment', 'Review weekly jump and swing load')])],
    mental: [c('composure', 'Composure after errors', ['compos', 'error'], [t('psychology_session', 'Reset routine session')]), c('communication', 'Communication', ['communicat']), c('focus', 'Focus across long matches', ['focus'])],
  },
  climbing: {
    label: 'Climbing',
    sports: ['climbing', 'rock-climbing-bouldering', 'ice-climbing'],
    technical: [c('movement', 'Movement and footwork', ['movement', 'footwork'], [t('video_review', 'Movement video review')]), c('route_reading', 'Route reading', ['route', 'read']), c('grip_efficiency', 'Grip efficiency and body tension', ['grip', 'tension'])],
    tactical: [c('attempt_strategy', 'Attempt strategy and rest management', ['attempt', 'strateg', 'rest'])],
    physical: [c('finger_strength', 'Finger and pulling strength', ['finger', 'strength'], [t('conditioning', 'Finger-strength block')]), c('power_endurance', 'Power-endurance', ['endurance', 'power']), c('mobility', 'Mobility and tendon health', ['mobility', 'tendon'], [t('load_adjustment', 'Review finger and shoulder load')])],
    mental: [c('fear_management', 'Fear and risk management', ['fear', 'risk'], [t('psychology_session', 'Fall-fear and commitment session')]), c('focus', 'Focus and commitment', ['focus'])],
  },
  mind_esports: {
    label: 'Mind sports and esports',
    sports: ['chess', 'online-chess', 'go', 'shogi', 'xiangqi', 'checkers', 'othello', 'backgammon', 'contract-bridge', 'mahjong', 'poker', 'rummy', 'sudoku', 'rubiks-cube', 'scrabble', 'trivia-quiz', 'esports', 'ea-fc', 'nba-2k', 'valorant', 'counter-strike', 'dota-2', 'league-of-legends', 'overwatch', 'rocket-league', 'fortnite', 'pubg', 'apex-legends', 'call-of-duty', 'free-fire', 'mobile-legends', 'honor-of-kings', 'mobile-games', 'clash-royale', 'hearthstone', 'starcraft', 'street-fighter', 'tekken', 'super-smash-bros', 'sim-racing', 'tabletop-rpg', 'catan', 'monopoly', 'uno', 'ludo', 'dominoes'],
    technical: [c('mechanics', 'Core mechanics / calculation', ['mechanic', 'calculat'], [t('training_block', 'Focused mechanics block')]), c('preparation', 'Opening / map / deck preparation', ['prepar', 'opening'])],
    tactical: [c('strategy', 'Strategy and adaptation', ['strateg', 'adapt'], [t('video_review', 'Game / replay review')]), c('decision_speed', 'Decision quality under time pressure', ['decision', 'time'])],
    physical: [c('screen_health', 'Sustained-focus stamina and recovery habits', ['stamina', 'recover'], [t('conditioning', 'Stamina and posture routine')]), c('sleep_routine', 'Sleep and routine regularity', ['sleep'])],
    mental: [c('tilt_control', 'Tilt control and emotional regulation', ['tilt', 'emotion'], [t('psychology_session', 'Tilt-management session')]), c('focus', 'Sustained concentration', ['focus']), c('team_communication', 'Communication (team titles)', ['communicat'])],
  },
};

/** The labelled fallback for a sport with no native model. Never treated as another sport. */
const GENERIC = {
  label: 'General athlete development (no sport-specific model yet)', fallback: true,
  technical: [c('core_skill', 'Core skill execution', ['skill', 'technique']), c('skill_consistency', 'Consistency under fatigue', ['consisten'])],
  tactical: [c('game_understanding', 'Game understanding and decisions', ['decision', 'game', 'tactic'])],
  physical: [c('general_fitness', 'General fitness and robustness', ['fitness', 'endurance', 'strength'], [t('conditioning', 'General conditioning block')])],
  mental: [c('focus_composure', 'Focus and composure', ['focus', 'compos'], [t('psychology_session', 'Focus and routine session')])],
};

/** Academic and personal competencies are universal: they are about the person, not the sport. */
const UNIVERSAL = {
  academic: [c('grades', 'Academic standing', ['grade', 'academic'], [t('tutoring', 'Subject tutoring')]), c('exam_readiness', 'Exam readiness and workload planning', ['exam'], [t('tutoring', 'Exam-period study plan'), t('load_adjustment', 'Training-load plan for the exam window')]), c('attendance_school', 'School attendance and engagement', ['attendance', 'engag']), c('education_pathway', 'Education pathway and next steps', ['pathway', 'university', 'college'], [t('guardian_meeting', 'Education pathway meeting with the family')])],
  personal: [c('wellbeing_routines', 'Routines: sleep, nutrition, study-sport balance', ['routine', 'sleep', 'nutrition'], [t('guardian_meeting', 'Routines check-in with the family')]), c('independence', 'Independence and life skills', ['independen', 'life']), c('leadership_character', 'Leadership and character', ['leader', 'character']), c('residence_settling', 'Settling in and support network', ['settl', 'residence', 'support'])],
};

const BY_SPORT = new Map();
for (const [fam, def] of Object.entries(FAMILIES)) for (const s of def.sports) BY_SPORT.set(s, fam);

/** The framework for one sport: { family, label, fallback, domains: { technical:[…], …, academic:[…], personal:[…] } }. */
export function frameworkFor(sportSlug) {
  const fam = BY_SPORT.get(sportSlug);
  const def = fam ? FAMILIES[fam] : GENERIC;
  return { family: fam ?? 'generic', label: def.label, fallback: !fam, domains: { technical: def.technical, tactical: def.tactical, physical: def.physical, mental: def.mental, academic: UNIVERSAL.academic, personal: UNIVERSAL.personal } };
}
export const familyOf = (sportSlug) => BY_SPORT.get(sportSlug) ?? 'generic';
export const nativeSports = () => [...BY_SPORT.keys()];

/** The coach rubric dimension that already measures a competency: word match on its key / name. Returns { rubric_id, dimension_key } or null. */
export function matchDimension(competency, rubrics) {
  const words = competency.match ?? [];
  let best = null;
  for (const r of rubrics) for (const d of r.dimensions ?? []) {
    const hay = `${d.key} ${d.name ?? ''}`.toLowerCase();
    const hit = words.filter((w) => hay.includes(w)).length + (hay.includes(competency.key.replace(/_/g, ' ')) || hay.includes(competency.key) ? 2 : 0);
    if (hit && (!best || hit > best.hit)) best = { hit, rubric_id: r.id, rubric: r.name, dimension_key: d.key, dimension: d.name ?? d.key };
  }
  return best;
}

export const PHASE_KINDS = ['pre_season', 'competition', 'exams', 'recovery', 'transition', 'camp'];
/** Phases in which new load or milestones should be flagged to the lead. */
export const PROTECTED_PHASES = ['exams', 'recovery', 'transition'];
