// SportArena ontology, modelled on the IPTC Sport Schema (https://github.com/iptc/sport-schema,
// CC-BY 4.0, (c) IPTC). The ontology is code, not data: classes, properties and controlled
// vocabularies are the app's shared language; instances (games, teams, people, associations)
// live in Postgres and are mapped onto these classes via `table`/`mapsTo`.
export const NS = {
  sport: 'https://sportschema.org/ontologies/main/',
  spstat: 'https://sportschema.org/ontologies/corestatistics/',
  sa: 'https://sportarena.app/ontology/',
};
const sport = (n) => `sport:${n}`;

/** TBox: classes. `table` = where instances live in this app (null = modelled only). */
export const classes = {
  Agent:               { label: 'Agent', parent: null, abstract: true, comment: 'Anything that can take part in sport: individuals, teams, clubs, governing bodies.' },
  Individual:          { label: 'Individual', parent: 'Agent', table: 'users', comment: 'A person with a SportArena profile.' },
  Athlete:             { label: 'Athlete', parent: 'Individual', roleKind: 'athlete', comment: 'Individual taking part as a competitor (player).' },
  Associate:           { label: 'Associate', parent: 'Individual', roleKind: 'associate', comment: 'Non-competing person tied to a team/game: coach, manager, physio, doctor…' },
  Official:            { label: 'Official', parent: 'Individual', roleKind: 'official', comment: 'Referee, umpire, scorer, timekeeper…' },
  Team:                { label: 'Team', parent: 'Agent', table: 'teams', comment: 'A group of athletes competing together.' },
  Club:                { label: 'Club', parent: 'Agent', table: null, comment: 'Organisation that may field several teams.' },
  GoverningBody:       { label: 'Governing body', parent: 'Agent', table: null, comment: 'Federation/association that governs competitions.' },
  Site:                { label: 'Site', parent: null, table: 'venues', comment: 'Venue or a bookable part of it (ground, court, pool).' },
  Competition:         { label: 'Competition', parent: null, table: 'events', comment: 'League, tournament, camp or trial: a collection of games.' },
  CompetitionPhase:    { label: 'Competition phase', parent: null, table: null, comment: 'Round, group, heat, knockout stage… (see vocabulary tournamentPhase).' },
  Event:               { label: 'Event (game)', parent: null, table: 'games', comment: 'A single game/match/race/session — the thing people play.' },
  Action:              { label: 'Action', parent: null, table: 'game_actions', comment: 'Something that happens inside an event: score, substitution, card, timeout.' },
  Participation:       { label: 'Participation', parent: null, abstract: true, comment: 'An agent taking part in an event, competition or team.' },
  CompetitorParticipation: { label: 'Competitor participation', parent: 'Participation', table: 'game_participants', comment: 'A team or individual competing in a game (with result).' },
  IndividualParticipation: { label: 'Individual participation', parent: 'Participation', table: 'associations', comment: 'A person taking part in a game in a role, with per-game stats.' },
  Membership:          { label: 'Membership', parent: null, table: 'associations', comment: 'A person belonging to a team/club in a role, for a period of time.' },
  TeamMembership:      { label: 'Team membership', parent: 'Membership', table: 'associations', comment: 'Membership of a team (player, captain, coach…).' },
  AssociateMembership: { label: 'Associate membership', parent: 'Membership', table: 'associations', comment: 'Non-playing staff role for a team/event/venue.' },
};

/** TBox: properties. `domain`/`range` are class keys or datatype names. */
export const properties = {
  sport:               { iri: sport('sport'), domain: ['Competition', 'Event', 'Team'], range: 'Sport', comment: 'The sport played.' },
  competitionType:     { iri: sport('competitionType'), domain: ['Competition'], range: 'vocab:competitionKind' },
  competitionFormat:   { iri: sport('competitionFormat'), domain: ['Competition'], range: 'vocab:tournamentForm' },
  eventInCompetition:  { iri: sport('eventInCompetition'), domain: ['Event'], range: 'Competition', inverse: 'containsEvent' },
  eventInCompetitionPhase: { iri: sport('eventInCompetitionPhase'), domain: ['Event'], range: 'vocab:tournamentPhase' },
  eventStatus:         { iri: sport('eventStatus'), domain: ['Event'], range: 'vocab:eventStatus' },
  eventOutcome:        { iri: sport('eventOutcome'), domain: ['CompetitorParticipation'], range: 'vocab:eventOutcome' },
  eventOutcomeType:    { iri: sport('eventOutcomeType'), domain: ['CompetitorParticipation'], range: 'vocab:eventOutcomeType' },
  startDateTime:       { iri: sport('startDateTime'), domain: ['Event', 'Membership'], range: 'xsd:dateTime' },
  endDateTime:         { iri: sport('endDateTime'), domain: ['Event', 'Membership'], range: 'xsd:dateTime' },
  location:            { iri: sport('location'), domain: ['Event'], range: 'Site', inverse: 'locationOf' },
  participationIn:     { iri: sport('participationIn'), domain: ['Participation'], range: 'Event', inverse: 'participation' },
  participationBy:     { iri: sport('participationBy'), domain: ['Participation'], range: 'Agent', inverse: 'participantOf' },
  teamParticipation:   { iri: sport('teamParticipation'), domain: ['Athlete'], range: 'Team' },
  member:              { iri: sport('member'), domain: ['Membership'], range: 'Agent', inverse: 'memberOf' },
  membershipOf:        { iri: sport('membershipOf'), domain: ['Membership'], range: 'Team' },
  membershipStatus:    { iri: sport('membershipStatus'), domain: ['Membership'], range: 'vocab:membershipStatus' },
  role:                { iri: sport('role'), domain: ['Membership', 'Participation'], range: 'vocab:role' },
  playerStatus:        { iri: sport('playerStatus'), domain: ['IndividualParticipation'], range: 'vocab:playerStatus' },
  positionRegular:     { iri: sport('positionRegular'), domain: ['Membership'], range: 'xsd:string' },
  uniformNumber:       { iri: sport('uniformNumber'), domain: ['Membership'], range: 'xsd:integer' },
  score:               { iri: sport('score'), domain: ['CompetitorParticipation'], range: 'xsd:decimal' },
  scoreUnits:          { iri: sport('scoreUnits'), domain: ['CompetitorParticipation'], range: 'vocab:scoreUnits' },
  rank:                { iri: sport('rank'), domain: ['CompetitorParticipation'], range: 'xsd:integer' },
  actionInEvent:       { iri: sport('actionInEvent'), domain: ['Action'], range: 'Event', inverse: 'containsAction' },
  actionType:          { iri: sport('actionType'), domain: ['Action'], range: 'xsd:string' },
  minutesElapsed:      { iri: sport('minutesElapsed'), domain: ['Action'], range: 'xsd:decimal' },
  periodValue:         { iri: sport('periodValue'), domain: ['Action'], range: 'xsd:integer' },
  governedBy:          { iri: sport('governedBy'), domain: ['Competition'], range: 'GoverningBody', inverse: 'governs' },
  dateOfBirth:         { iri: sport('dateOfBirth'), domain: ['Individual'], range: 'xsd:date', sensitive: true, comment: 'Personal data: never exposed publicly; encrypted at rest.' },
};

/** Controlled vocabularies (IPTC NewsCodes `sp*` + SportArena roles). */
export const vocabularies = {
  eventStatus: { source: 'spEventStatus', terms: ['pre-event', 'mid-event', 'post-event', 'postponed', 'suspended', 'halted', 'forfeited', 'rescheduled', 'delayed', 'canceled', 'intermission', 'if-necessary', 'discarded'] },
  eventOutcome: { source: 'spEventOutcome', terms: ['win', 'loss', 'tie', 'undecided', 'show', 'place'] },
  eventOutcomeType: { source: 'spEventOutcomeType', terms: ['regular', 'overtime', 'shootout', 'extra-time', 'random', 'authority-decision', 'decision-unanimous'] },
  playerStatus: { source: 'spPlayerStatus', terms: ['starter', 'bench', 'scratched', 'injured', 'suspended', 'sidelined'] },
  tournamentForm: { source: 'spTournamentForm', terms: ['hosted', 'single-group', 'series', 'single-elimination', 'home-and-home'] },
  tournamentPhase: { source: 'spTournamentPhase', terms: ['elimination', 'group', 'heat', 'play-off', 'tie-breaker', 'round', 'round-of-16', 'round-robin', 'quarter-final', 'semi-final', 'third-place-final', 'final', 'qualification'] },
  competitionScope: { source: 'spCompetitionScope', terms: ['events-all', 'events-home', 'events-away', 'division', 'conference', 'round', 'tournament', 'league'] },
  scoreUnits: { source: 'spScoreUnits', terms: ['time-absolute', 'time-relative', 'against-par'] },
  actionClass: { source: 'spActionClass', terms: ['play', 'score', 'substitution', 'timeout', 'penalty', 'infraction', 'injury'] },
  membershipStatus: { source: 'sportarena', terms: ['invited', 'requested', 'active', 'declined', 'ended'] },
  competitionKind: { source: 'sportarena', terms: ['tournament', 'league', 'friendly', 'camp', 'trial'] },
  side: { source: 'sportarena', terms: ['home', 'away', 'neutral'] },
};

/**
 * Roles a person can hold towards a game/team/event/venue. `kind` ties the role to the IPTC
 * class (Athlete/Official/Associate); `profile` is the user role (profile type) required to hold it.
 */
export const roles = {
  player:          { kind: 'athlete',   label: 'Player',          profile: 'athlete',  targets: ['game', 'team', 'event'] },
  captain:         { kind: 'athlete',   label: 'Captain',         profile: 'athlete',  targets: ['game', 'team'] },
  coach:           { kind: 'associate', label: 'Coach',           profile: 'coach',    targets: ['game', 'team', 'event'] },
  assistant_coach: { kind: 'associate', label: 'Assistant coach', profile: 'coach',    targets: ['game'] },
  manager:         { kind: 'associate', label: 'Manager',         profile: null,       targets: ['game', 'team', 'event', 'venue'] },
  physio:          { kind: 'associate', label: 'Physio',          profile: 'physio',   targets: ['game', 'team', 'event'] },
  doctor:          { kind: 'associate', label: 'Doctor',          profile: 'doctor',   targets: ['game', 'event'] },
  referee:         { kind: 'official',  label: 'Referee',         profile: 'referee',  targets: ['game', 'event'] },
  umpire:          { kind: 'official',  label: 'Umpire',          profile: 'referee',  targets: ['game', 'event'] },
  linesman:        { kind: 'official',  label: 'Assistant referee', profile: 'referee', targets: ['game', 'event'] },
  scorer:          { kind: 'official',  label: 'Scorer / timekeeper', profile: null,   targets: ['game'] },
  organizer:       { kind: 'associate', label: 'Organizer',       profile: null,       targets: ['game', 'event'] },
  venue_manager:   { kind: 'associate', label: 'Venue manager',   profile: 'venue_manager', targets: ['game', 'event', 'venue'] },
  sponsor:         { kind: 'associate', label: 'Sponsor',         profile: 'sponsor',  targets: ['game', 'event'] },
  volunteer:       { kind: 'associate', label: 'Volunteer',       profile: null,       targets: ['game', 'event'] },
};
/** Roles stored in the team roster (team_members); other roles attach to games, events and venues. */
export const ROSTER_ROLES = ['player', 'captain', 'coach', 'manager', 'physio'];
/** Roles that may edit the thing they are associated with. */
export const MANAGER_ROLES = ['organizer', 'manager'];
export const TARGET_TYPES = ['game', 'team', 'event', 'venue'];
export const TARGET_CLASS = { game: 'Event', team: 'Team', event: 'Competition', venue: 'Site' };

/**
 * Game field templates. Every game has the CORE fields; each sport adds fields (derived from the IPTC
 * statistics ontologies — soccer, basketball, tennis, rugby, volleyball, baseball, golf…). Scopes:
 *   game         — about the game as a whole      (games.attributes)
 *   participant  — about a side/competitor        (game_participants.stats)
 *   association  — about a person in the game     (associations.attributes)
 */
const f = (key, label, datatype, extra = {}) => ({ key, label, datatype, ...extra });
const num = (key, label, extra) => f(key, label, 'integer', { min: 0, ...extra });

export const coreFields = {
  game: [
    f('periods', 'Number of periods / halves / sets', 'integer', { min: 1, max: 20 }),
    f('period_minutes', 'Minutes per period', 'integer', { min: 1, max: 300 }),
    f('attendance', 'Attendance', 'integer', { min: 0, iri: sport('attendance') }),
    f('competition_phase', 'Phase', 'enum', { options: vocabularies.tournamentPhase.terms, iri: sport('eventInCompetitionPhase') }),
    f('outcome_type', 'How it was decided', 'enum', { options: vocabularies.eventOutcomeType.terms, iri: sport('eventOutcomeType') }),
    f('notes', 'Notes', 'text'),
  ],
  participant: [f('score_detail', 'Score breakdown (e.g. per period)', 'text')],
  association: [
    f('minutes_played', 'Minutes played', 'number', { min: 0, iri: 'spstat:minutesPlayed' }),
    f('notes', 'Notes', 'text'),
  ],
};

export const sportTemplates = {
  football: {
    game: [num('extra_time_minutes', 'Stoppage time (min)'), f('penalty_shootout', 'Decided on penalties', 'boolean')],
    participant: [num('shots', 'Shots'), num('shots_on_target', 'Shots on target'), num('corners', 'Corners'), num('fouls', 'Fouls'), num('yellow_cards', 'Yellow cards'), num('red_cards', 'Red cards'), num('possession_pct', 'Possession %', { max: 100 })],
    association: [num('goals', 'Goals'), num('assists', 'Assists'), num('yellow_cards', 'Yellow cards'), num('red_cards', 'Red cards'), num('saves', 'Saves')],
  },
  basketball: {
    game: [num('overtime_periods', 'Overtime periods')],
    participant: [num('rebounds', 'Rebounds'), num('turnovers', 'Turnovers'), num('team_fouls', 'Team fouls')],
    association: [num('points', 'Points'), num('rebounds', 'Rebounds'), num('assists', 'Assists'), num('steals', 'Steals'), num('blocks', 'Blocks'), num('fouls', 'Fouls')],
  },
  cricket: {
    game: [f('format', 'Format', 'enum', { options: ['t20', 'odi', 'test', 'tape_ball', 'other'] }), num('overs_per_innings', 'Overs per innings'), f('toss_winner_side', 'Toss won by', 'enum', { options: vocabularies.side.terms })],
    participant: [num('runs', 'Runs'), num('wickets_lost', 'Wickets lost', { max: 10 }), f('overs', 'Overs faced', 'number', { min: 0 }), num('extras', 'Extras')],
    association: [num('runs', 'Runs'), num('balls_faced', 'Balls faced'), num('fours', 'Fours'), num('sixes', 'Sixes'), num('wickets', 'Wickets'), f('overs_bowled', 'Overs bowled', 'number', { min: 0 }), num('runs_conceded', 'Runs conceded'), num('catches', 'Catches')],
  },
  tennis: {
    game: [f('surface', 'Surface', 'enum', { options: ['hard', 'clay', 'grass', 'carpet', 'other'] }), f('best_of_sets', 'Best of (sets)', 'enum', { options: ['3', '5'] })],
    participant: [f('sets_won', 'Sets won', 'integer', { min: 0, max: 5 }), f('games_won', 'Games won', 'integer', { min: 0 })],
    association: [num('aces', 'Aces'), num('double_faults', 'Double faults'), num('winners', 'Winners'), num('unforced_errors', 'Unforced errors')],
  },
  badminton: {
    game: [f('discipline', 'Discipline', 'enum', { options: ['singles', 'doubles', 'mixed_doubles'] })],
    participant: [num('games_won', 'Games won', { max: 3 }), num('points_total', 'Total points')],
    association: [num('smashes', 'Smash winners'), num('service_faults', 'Service faults')],
  },
  volleyball: {
    game: [f('beach', 'Beach volleyball', 'boolean')],
    participant: [num('sets_won', 'Sets won', { max: 5 }), num('blocks', 'Blocks'), num('aces', 'Aces'), num('attack_errors', 'Attack errors')],
    association: [num('kills', 'Kills'), num('blocks', 'Blocks'), num('aces', 'Aces'), num('digs', 'Digs')],
  },
  hockey: {
    game: [f('penalty_shootout', 'Decided on shoot-out', 'boolean')],
    participant: [num('shots', 'Shots'), num('penalty_corners', 'Penalty corners'), num('green_cards', 'Green cards'), num('yellow_cards', 'Yellow cards'), num('red_cards', 'Red cards')],
    association: [num('goals', 'Goals'), num('assists', 'Assists'), num('saves', 'Saves')],
  },
  kabaddi: {
    participant: [num('raid_points', 'Raid points'), num('tackle_points', 'Tackle points'), num('all_outs_inflicted', 'All-outs inflicted'), num('bonus_points', 'Bonus points')],
    association: [num('raid_points', 'Raid points'), num('tackle_points', 'Tackle points'), num('super_raids', 'Super raids'), num('super_tackles', 'Super tackles')],
  },
  rugby: {
    participant: [num('tries', 'Tries'), num('conversions', 'Conversions'), num('penalty_goals', 'Penalty goals'), num('drop_goals', 'Drop goals')],
    association: [num('tries', 'Tries'), num('tackles', 'Tackles'), num('carries', 'Carries'), num('yellow_cards', 'Yellow cards'), num('red_cards', 'Red cards')],
  },
  baseball: {
    game: [num('innings', 'Innings', { min: 1 })],
    participant: [num('runs', 'Runs'), num('hits', 'Hits'), num('errors', 'Errors')],
    association: [num('at_bats', 'At bats'), num('hits', 'Hits'), num('home_runs', 'Home runs'), num('rbis', 'RBIs'), num('strikeouts', 'Strikeouts')],
  },
  athletics: {
    game: [f('discipline', 'Discipline (e.g. 100m, long jump)', 'text'), f('wind_mps', 'Wind (m/s)', 'number', { iri: 'sport:wind' }), f('heat', 'Heat / flight', 'text')],
    participant: [f('result_time_s', 'Time (seconds)', 'number', { min: 0, iri: 'sport:scoreUnits' }), f('result_distance_m', 'Distance / height (m)', 'number', { min: 0 }), f('lane', 'Lane', 'integer', { min: 1 })],
    association: [f('personal_best', 'Personal best set', 'boolean')],
  },
  swimming: {
    game: [f('stroke', 'Stroke', 'enum', { options: ['freestyle', 'backstroke', 'breaststroke', 'butterfly', 'medley'] }), f('distance_m', 'Distance (m)', 'integer', { min: 25 }), f('heat', 'Heat', 'text')],
    participant: [f('result_time_s', 'Time (seconds)', 'number', { min: 0 }), f('lane', 'Lane', 'integer', { min: 1 })],
    association: [f('personal_best', 'Personal best set', 'boolean')],
  },
  esports: {
    game: [f('title', 'Game title', 'text'), f('map', 'Map', 'text'), f('best_of', 'Best of', 'integer', { min: 1, max: 9 })],
    participant: [num('rounds_won', 'Rounds won'), num('maps_won', 'Maps won')],
    association: [num('kills', 'Kills'), num('deaths', 'Deaths'), num('assists', 'Assists')],
  },
  skateboarding: {
    game: [f('discipline', 'Discipline', 'enum', { options: ['street', 'park', 'vert', 'other'] })],
    participant: [f('best_run_score', 'Best run score', 'number', { min: 0 }), f('best_trick_score', 'Best trick score', 'number', { min: 0 })],
    association: [],
  },
};

export const FIELD_SCOPES = ['game', 'participant', 'association'];
export const DATATYPES = ['text', 'integer', 'number', 'boolean', 'enum', 'datetime'];
