// REF-R30: Expanded sport official role taxonomy and rule-driven crew templates (#1028).
// Defines every role a sport uses (Chair Umpire, Match Commissioner, Technical Delegate,
// Starter, Marshal, etc.) with qualifications, duties, permission scopes and governing-body
// source, all traceable to a rule-pack version. Crew templates bundle these slots into a
// versioned, immutable-once-published bundle that an organiser applies to an event in one tap.
//
// Reuses: official_crew_requirements (officials-crew.js), packOf (rule-packs.js), audit (helpers.js).
// No competing sources of truth — sport_official_role_definitions extends the taxonomy;
// event_crew_requirements remains the live per-event slot store.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { OFFICIAL_ROLES } from '../officials.js';

const TAG = 'Officials';
const mustBePlatformAdmin = (u) => { if (!isAdmin(u) || !u.roles?.includes('platform_admin')) throw forbidden('Platform admin only'); };
const mustBeOrgOrAdmin = (u) => { if (!isAdmin(u) && !u.roles?.some((r) => ['admin', 'org_owner', 'org_admin'].includes(r))) throw forbidden('Organisation admin or platform admin required'); };

const credentialSchema = z.object({
  kind: z.string().max(80),
  label: z.string().max(120),
  required: z.boolean().default(true),
});

const permissionSchema = z.object({
  key: z.string().max(80),
  label: z.string().max(120),
  granted: z.boolean(),
});

const FAMILIES = ['match_official', 'video_official', 'technical_official', 'administrative_official', 'safety_official', 'support_official'];
const LEVELS   = ['club', 'domestic', 'national', 'international', 'youth', 'para'];

// ── Seed data: governing-body standard roles by sport ─────────────────────
const GB_ROLES_SEED = [
  // Football / Soccer — FIFA
  { sport_code: 'football', role_key: 'referee',              display_name: 'Referee',              family: 'match_official',         min_count: 1, max_count: 1, mandatory: true,  min_grade: 'Grade 1', min_grade_rank: 10, governing_body: 'FIFA', source: 'FIFA Laws of the Game', source_version: '2024', duties: ['Control the match from kick-off to final whistle', 'Apply the Laws of the Game in full', 'Stop play for injuries, encroachments and infringements', 'Show yellow / red cards to manage discipline', 'Confirm result and sign the match sheet'], requires_credentials: [{ kind: 'fifa_referee_grade', label: 'FIFA Referee Grade 1', required: true }, { kind: 'safeguarding', label: 'Safeguarding Clearance', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials and credentials', granted: true }, { key: 'file_report', label: 'File referee match report', granted: true }, { key: 'issue_caution', label: 'Issue caution / send-off', granted: true }, { key: 'suspend_match', label: 'Suspend or abandon match', granted: true }, { key: 'view_fees', label: 'View fee arrangements', granted: false }] },
  { sport_code: 'football', role_key: 'linesman',             display_name: 'Assistant Referee',    family: 'match_official',         min_count: 2, max_count: 2, mandatory: true,  min_grade: 'Grade 2', min_grade_rank: 8,  governing_body: 'FIFA', source: 'FIFA Laws of the Game', source_version: '2024', duties: ['Signal offside when assistant referee has a clearer view', 'Signal for throw-ins and corner kicks', 'Signal for goal kicks', 'Assist the referee in controlling the match'], requires_credentials: [{ kind: 'fifa_referee_grade', label: 'FIFA Referee Grade 2', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File assistant referee report', granted: true }, { key: 'issue_caution', label: 'Issue caution / send-off', granted: false }] },
  { sport_code: 'football', role_key: 'fourth_official',      display_name: 'Fourth Official',      family: 'match_official',         min_count: 1, max_count: 1, mandatory: false, min_grade: 'Grade 1', min_grade_rank: 10, governing_body: 'FIFA', source: 'FIFA Laws of the Game', source_version: '2024', duties: ['Manage substitution board and procedure', 'Control technical area conduct', 'Assist the referee from the touchline', 'Take the place of an injured match official'], requires_credentials: [{ kind: 'fifa_referee_grade', label: 'FIFA Referee Grade 1', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File fourth official report', granted: true }] },
  { sport_code: 'football', role_key: 'match_commissioner',   display_name: 'Match Commissioner',   family: 'administrative_official', min_count: 1, max_count: 1, mandatory: true,  governing_body: 'FIFA', source: 'FIFA Match Commissioner Guidelines', source_version: '2024', duties: ['Pre-match inspection of venue, facilities, safety compliance and floodlighting', 'Confirm referee crew identities and documentation before kick-off', 'Liaise with both team managers on eligibility issues and protests', 'Submit match commissioner report to governing body within 24 h', 'Escalate doping control, security or integrity concerns immediately'], requires_credentials: [{ kind: 'fifa_commissioner_licence', label: 'FIFA Match Commissioner Licence', required: true }, { kind: 'safeguarding', label: 'Safeguarding Clearance', required: true }, { kind: 'fifa_ethics_training', label: 'FIFA Ethics & Integrity Training', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials and credentials', granted: true }, { key: 'file_report', label: 'File match commissioner report', granted: true }, { key: 'integrity_flag', label: 'Raise integrity flag on fixture', granted: true }, { key: 'view_fees', label: 'View fee arrangements', granted: false }, { key: 'substitute_referee', label: 'Substitute referee', granted: false }] },
  { sport_code: 'football', role_key: 'technical_delegate',   display_name: 'Technical Delegate',   family: 'administrative_official', min_count: 1, max_count: 1, mandatory: false, governing_body: 'FIFA', source: 'FIFA Technical Delegate Guidelines', source_version: '2024', duties: ['Oversee venue, safety and organisation pre-match and post-match', 'Liaise with competition organisers on logistics and protocols', 'Report deficiencies to governing body'], requires_credentials: [{ kind: 'fifa_referee_grade', label: 'Grade 1 Referee Licence', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File technical delegate report', granted: true }] },
  { sport_code: 'football', role_key: 'video_assistant_referee', display_name: 'VAR Operator',       family: 'video_official',         min_count: 1, max_count: 1, mandatory: false, governing_body: 'FIFA', source: 'FIFA VAR Protocol', source_version: '2024', duties: ['Review potential match-changing incidents: goals, penalties, red cards, mistaken identity', 'Communicate review decisions to the referee via earpiece', 'Log all check and review decisions in the VAR system'], requires_credentials: [{ kind: 'fifa_var_certificate', label: 'FIFA VAR Certificate', required: true }, { kind: 'fifa_referee_grade', label: 'FIFA Referee Grade 1', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'review_decision', label: 'Trigger VAR check / review', granted: true }] },

  // Tennis — ITF / ATP / WTA
  { sport_code: 'tennis',   role_key: 'chair_umpire',         display_name: 'Chair Umpire',          family: 'match_official',         min_count: 1, max_count: 1, mandatory: true,  governing_body: 'ITF', source: 'ITF Rules of Tennis', source_version: '2024', duties: ['Announce score after every point', 'Call lets and correct all calls', 'Manage player conduct and issue code violations', 'Decide service lets and other disputed calls', 'Sign and certify the official score sheet'], requires_credentials: [{ kind: 'itf_gold_badge', label: 'ITF Gold Badge or ATP/WTA Accreditation', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File chair umpire report', granted: true }, { key: 'code_violation', label: 'Issue code violation', granted: true }] },
  { sport_code: 'tennis',   role_key: 'umpire',               display_name: 'Line Umpire',           family: 'match_official',         min_count: 0, max_count: 10, mandatory: false, governing_body: 'ITF', source: 'ITF Rules of Tennis', source_version: '2024', duties: ['Call balls out / fault on assigned line(s)', 'Raise hand to signal own call', 'Remain stationary and focused throughout the point'], requires_credentials: [{ kind: 'itf_line_umpire_cert', label: 'ITF Line Umpire Certificate', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }] },
  { sport_code: 'tennis',   role_key: 'technical_delegate',   display_name: 'Tournament Referee',   family: 'administrative_official', min_count: 1, max_count: 1, mandatory: true,  governing_body: 'ITF', source: 'ITF Tournament Regulations', source_version: '2024', duties: ['Schedule matches and assign courts', 'Resolve all on-court disputes escalated from chair umpires', 'Manage weather and lighting suspensions', 'Issue and enforce default rulings'], requires_credentials: [{ kind: 'itf_gold_badge', label: 'ITF Gold Badge', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File tournament referee report', granted: true }, { key: 'default_player', label: 'Issue default ruling', granted: true }] },

  // Cricket — ICC
  { sport_code: 'cricket',  role_key: 'umpire',               display_name: 'On-field Umpire',       family: 'match_official',         min_count: 2, max_count: 2, mandatory: true,  governing_body: 'ICC', source: 'ICC Playing Conditions', source_version: '2024', duties: ['Adjudicate on all LBW, caught, run-out and stumping decisions', 'Count deliveries and signal wides, no-balls, byes and leg byes', 'Monitor field placement and bowling actions', 'Manage overs, light and weather breaks'], requires_credentials: [{ kind: 'icc_elite_panel', label: 'ICC Elite Panel or International Panel', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File umpire report', granted: true }, { key: 'drs_trigger', label: 'Manage DRS review', granted: true }] },
  { sport_code: 'cricket',  role_key: 'technical_official',   display_name: 'Third Umpire',          family: 'video_official',         min_count: 1, max_count: 1, mandatory: false, governing_body: 'ICC', source: 'ICC Playing Conditions', source_version: '2024', duties: ['Review DRS (Decision Review System) referrals', 'Adjudicate run-outs and stumpings when referred', 'Handle boundary decisions and obstructions'], requires_credentials: [{ kind: 'icc_elite_panel', label: 'ICC Elite Panel or International Panel', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'review_decision', label: 'Issue DRS review decision', granted: true }] },
  { sport_code: 'cricket',  role_key: 'match_commissioner',   display_name: 'Match Referee',         family: 'administrative_official', min_count: 1, max_count: 1, mandatory: true,  governing_body: 'ICC', source: 'ICC Code of Conduct', source_version: '2024', duties: ['Uphold ICC Code of Conduct throughout the match', 'Conduct post-match hearings for Level 1–4 offences', 'Submit match referee report within 24 h', 'Adjudicate on player eligibility queries'], requires_credentials: [{ kind: 'icc_match_referee_panel', label: 'ICC Match Referee Panel', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File match referee report', granted: true }, { key: 'integrity_flag', label: 'Raise integrity flag', granted: true }] },
  { sport_code: 'cricket',  role_key: 'scorer',               display_name: 'Scorer',                family: 'support_official',       min_count: 2, max_count: 2, mandatory: true,  governing_body: 'ICC', source: 'ICC Playing Conditions', source_version: '2024', duties: ['Record all runs, wickets and overs accurately', 'Synchronise scorebook with the opposition scorer', 'Agree and sign the official scorecard at close of play'], requires_credentials: [{ kind: 'icc_scorer_cert', label: 'ICC Scorer Certificate', required: false }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'submit_scorecard', label: 'Submit official scorecard', granted: true }] },

  // Athletics — World Athletics
  { sport_code: 'athletics', role_key: 'starter',             display_name: 'Starter',               family: 'technical_official',     min_count: 1, max_count: 1, mandatory: true,  governing_body: 'World Athletics', source: 'World Athletics Technical Rules', source_version: '2024', duties: ['Call athletes to marks and set positions', 'Fire the starting device', 'Recall false starts', 'Coordinate with photo-finish and timing system operators'], requires_credentials: [{ kind: 'wa_technical_official', label: 'World Athletics Technical Official Licence', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'false_start', label: 'Declare false start', granted: true }] },
  { sport_code: 'athletics', role_key: 'marshal',             display_name: 'Track Marshal',          family: 'safety_official',        min_count: 2, max_count: 20, mandatory: true,  governing_body: 'World Athletics', source: 'World Athletics Technical Rules', source_version: '2024', duties: ['Control athlete warm-up and call-room procedures', 'Manage track access and clear the infield during events', 'Assist athletes with kit and lane assignments'], requires_credentials: [{ kind: 'wa_technical_official', label: 'World Athletics Technical Official Licence', required: false }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }] },
  { sport_code: 'athletics', role_key: 'technical_delegate',  display_name: 'Technical Delegate',    family: 'administrative_official', min_count: 1, max_count: 1, mandatory: true,  governing_body: 'World Athletics', source: 'World Athletics Competition Regulations', source_version: '2024', duties: ['Verify all technical facilities meet World Athletics standards', 'Approve track and field measurements', 'Adjudicate equipment protests'], requires_credentials: [{ kind: 'wa_technical_delegate', label: 'World Athletics Technical Delegate Qualification', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File technical delegate report', granted: true }] },

  // Basketball — FIBA
  { sport_code: 'basketball', role_key: 'referee',            display_name: 'Referee',               family: 'match_official',         min_count: 1, max_count: 1, mandatory: true,  governing_body: 'FIBA', source: 'FIBA Official Basketball Rules', source_version: '2024', duties: ['Control game in full; has authority over all officials', 'Make final rulings on all matters not covered by FIBA rules', 'Confirm final score and game report'], requires_credentials: [{ kind: 'fiba_international_licence', label: 'FIBA International Referee Licence', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File referee report', granted: true }, { key: 'issue_caution', label: 'Issue technical foul / disqualification', granted: true }] },
  { sport_code: 'basketball', role_key: 'umpire',             display_name: 'Umpire',                family: 'match_official',         min_count: 1, max_count: 2, mandatory: true,  governing_body: 'FIBA', source: 'FIBA Official Basketball Rules', source_version: '2024', duties: ['Assist the referee in controlling the game', 'Make calls in their primary coverage zone', 'Handle alternating possession arrow and jump ball', 'Manage player conduct in bench areas'], requires_credentials: [{ kind: 'fiba_international_licence', label: 'FIBA International Referee Licence', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'file_report', label: 'File umpire report', granted: true }] },
  { sport_code: 'basketball', role_key: 'shot_clock_operator', display_name: 'Shot Clock Operator', family: 'technical_official',     min_count: 1, max_count: 1, mandatory: true,  governing_body: 'FIBA', source: 'FIBA Official Basketball Rules', source_version: '2024', duties: ['Operate the shot clock accurately', 'Reset on official whistles and conversions', 'Alert referee to shot clock violations'], requires_credentials: [{ kind: 'fiba_table_official', label: 'FIBA Table Official Certificate', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }] },
  { sport_code: 'basketball', role_key: 'timekeeper',         display_name: 'Timekeeper',            family: 'technical_official',     min_count: 1, max_count: 1, mandatory: true,  governing_body: 'FIBA', source: 'FIBA Official Basketball Rules', source_version: '2024', duties: ['Operate game clock; start and stop on officials\' signals', 'Sound buzzer at end of periods and half-time', 'Notify referee of any clock discrepancy'], requires_credentials: [{ kind: 'fiba_table_official', label: 'FIBA Table Official Certificate', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }] },
  { sport_code: 'basketball', role_key: 'scorer',             display_name: 'Scorer',                family: 'support_official',       min_count: 1, max_count: 1, mandatory: true,  governing_body: 'FIBA', source: 'FIBA Official Basketball Rules', source_version: '2024', duties: ['Maintain official scoresheet', 'Record personal fouls and team fouls', 'Signal referee when a player has 5 fouls', 'Sign and certify the official scoresheet'], requires_credentials: [{ kind: 'fiba_table_official', label: 'FIBA Table Official Certificate', required: true }], permissions: [{ key: 'view_crew', label: 'View match officials', granted: true }, { key: 'submit_scorecard', label: 'Submit official scoresheet', granted: true }] },
];

// Crew template seed data
const CREW_TEMPLATES_SEED = [
  {
    sport_code: 'football', match_format: '11v11', level: 'international', governing_body: 'FIFA',
    name: 'FIFA Senior Men\'s 11v11', description: 'Full crew as required by FIFA Laws of the Game 2024, Circular 1718. Governs FIFA World Cup qualifiers, Continental Championships and FIFA-endorsed club competitions.',
    source: 'FIFA', source_ref: 'FIFA Circular 1718',
    slots: [
      { role_key: 'referee',              display_name: 'Referee',                family: 'match_official',         min_count: 1, max_count: 1, mandatory: true,  min_grade: 'Grade 1', min_grade_rank: 10, requires_credentials: [{ kind: 'fifa_referee_grade', label: 'FIFA Grade 1', required: true }], duties: ['Control the match', 'Apply Laws of the Game'], permissions: [{ key: 'file_report', label: 'File referee report', granted: true }], position_order: 1 },
      { role_key: 'linesman',             display_name: 'Assistant Referee',      family: 'match_official',         min_count: 2, max_count: 2, mandatory: true,  min_grade: 'Grade 2', min_grade_rank: 8,  requires_credentials: [{ kind: 'fifa_referee_grade', label: 'FIFA Grade 2', required: true }], duties: ['Signal offside / throw-ins / corners'], permissions: [], position_order: 2 },
      { role_key: 'fourth_official',      display_name: 'Fourth Official',        family: 'match_official',         min_count: 1, max_count: 1, mandatory: true,  min_grade: 'Grade 1', min_grade_rank: 10, requires_credentials: [{ kind: 'fifa_referee_grade', label: 'FIFA Grade 1', required: true }], duties: ['Manage substitutions and technical area'], permissions: [], position_order: 3 },
      { role_key: 'match_commissioner',   display_name: 'Match Commissioner',     family: 'administrative_official', min_count: 1, max_count: 1, mandatory: true,  requires_credentials: [{ kind: 'fifa_commissioner_licence', label: 'FIFA Commissioner Licence', required: true }], duties: ['Integrity oversight', '24h governing body report'], permissions: [{ key: 'integrity_flag', label: 'Raise integrity flag', granted: true }], position_order: 4 },
      { role_key: 'video_assistant_referee', display_name: 'VAR Operator',       family: 'video_official',         min_count: 1, max_count: 1, mandatory: false, requires_credentials: [{ kind: 'fifa_var_certificate', label: 'FIFA VAR Certificate', required: true }], duties: ['Review goals/penalties/red cards/mistaken identity'], permissions: [], position_order: 5 },
      { role_key: 'technical_delegate',   display_name: 'Technical Delegate',     family: 'administrative_official', min_count: 1, max_count: 1, mandatory: false, requires_credentials: [{ kind: 'fifa_referee_grade', label: 'Grade 1 Licence', required: true }], duties: ['Venue/safety/organisation oversight'], permissions: [], position_order: 6 },
    ],
  },
  {
    sport_code: 'football', match_format: '11v11', level: 'club', governing_body: 'national',
    name: 'Club Football 11v11', description: 'Standard national federation crew for domestic club 11-a-side competitions.',
    source: 'national federation', source_ref: '',
    slots: [
      { role_key: 'referee',   display_name: 'Referee',           family: 'match_official', min_count: 1, max_count: 1, mandatory: true,  requires_credentials: [], duties: ['Control match'], permissions: [], position_order: 1 },
      { role_key: 'linesman',  display_name: 'Assistant Referee', family: 'match_official', min_count: 2, max_count: 2, mandatory: true,  requires_credentials: [], duties: ['Signal offside / throw-ins'], permissions: [], position_order: 2 },
      { role_key: 'fourth_official', display_name: 'Fourth Official', family: 'match_official', min_count: 1, max_count: 1, mandatory: false, requires_credentials: [], duties: ['Substitutions and technical area'], permissions: [], position_order: 3 },
    ],
  },
  {
    sport_code: 'tennis', match_format: 'best_of_5', level: 'international', governing_body: 'ITF',
    name: 'ATP Grand Slam Singles', description: 'Full crew per ITF Grand Slam regulations. Chair umpire, line umpires, hawk-eye operator and tournament referee.',
    source: 'ITF', source_ref: 'ITF Grand Slam Regulations 2024',
    slots: [
      { role_key: 'chair_umpire',       display_name: 'Chair Umpire',          family: 'match_official',         min_count: 1, max_count: 1, mandatory: true,  requires_credentials: [{ kind: 'itf_gold_badge', label: 'ITF Gold Badge', required: true }], duties: ['Announce score, manage conduct, sign scoresheet'], permissions: [], position_order: 1 },
      { role_key: 'umpire',             display_name: 'Line Umpire',            family: 'match_official',         min_count: 6, max_count: 10, mandatory: false, requires_credentials: [{ kind: 'itf_line_umpire_cert', label: 'ITF Line Umpire Cert', required: true }], duties: ['Call out/fault on assigned line'], permissions: [], position_order: 2 },
      { role_key: 'technical_delegate', display_name: 'Tournament Referee',     family: 'administrative_official', min_count: 1, max_count: 1, mandatory: true,  requires_credentials: [{ kind: 'itf_gold_badge', label: 'ITF Gold Badge', required: true }], duties: ['Schedule, resolve disputes, manage weather'], permissions: [], position_order: 3 },
    ],
  },
  {
    sport_code: 'cricket', match_format: 'T20', level: 'international', governing_body: 'ICC',
    name: 'ICC T20 International', description: 'ICC crew for T20 Internationals including DRS and match referee.',
    source: 'ICC', source_ref: 'ICC Playing Conditions T20I 2024',
    slots: [
      { role_key: 'umpire',           display_name: 'On-field Umpire',  family: 'match_official',         min_count: 2, max_count: 2, mandatory: true,  requires_credentials: [{ kind: 'icc_elite_panel', label: 'ICC Panel', required: true }], duties: ['Adjudicate all decisions, manage overs'], permissions: [], position_order: 1 },
      { role_key: 'technical_official', display_name: 'Third Umpire',  family: 'video_official',         min_count: 1, max_count: 1, mandatory: true,  requires_credentials: [{ kind: 'icc_elite_panel', label: 'ICC Panel', required: true }], duties: ['Handle DRS referrals'], permissions: [], position_order: 2 },
      { role_key: 'match_commissioner', display_name: 'Match Referee', family: 'administrative_official', min_count: 1, max_count: 1, mandatory: true,  requires_credentials: [{ kind: 'icc_match_referee_panel', label: 'ICC Match Referee Panel', required: true }], duties: ['Code of conduct oversight, 24h report'], permissions: [], position_order: 3 },
      { role_key: 'scorer',           display_name: 'Scorer',           family: 'support_official',       min_count: 2, max_count: 2, mandatory: true,  requires_credentials: [], duties: ['Record runs/wickets, sign scorecard'], permissions: [], position_order: 4 },
    ],
  },
];

const templateHash = (slots) => createHash('sha256').update(JSON.stringify(slots.map((s) => ({ role_key: s.role_key, min_count: s.min_count, max_count: s.max_count, mandatory: s.mandatory, min_grade_rank: s.min_grade_rank ?? null, requires_credentials: s.requires_credentials })))).digest('hex');

// ── Capabilities ──────────────────────────────────────────────────────────

cap({
  name: 'list_sport_official_roles', method: 'GET', path: '/sports/:sport_id/official-roles', tag: TAG, status: 200,
  summary: 'List all official role definitions for a sport. Returns cross-sport roles too (sport_id IS NULL rows). Active only unless ?include_archived=true.',
  input: z.object({ include_archived: z.coerce.boolean().default(false) }),
  async handler({ params, input, user }) {
    const { sport_id } = params;
    const rows = await many(
      `SELECT d.*, s.slug AS sport_slug, s.name AS sport_name
         FROM sport_official_role_definitions d
         LEFT JOIN sports s ON s.id = d.sport_id
        WHERE (d.sport_id = $1 OR d.sport_id IS NULL)
          AND ($2 OR d.status = 'active')
        ORDER BY d.family, d.position_order, d.role_key`,
      [sport_id, input.include_archived],
    );
    return { roles: rows };
  },
});

cap({
  name: 'list_all_sport_official_roles', method: 'GET', path: '/official-roles', tag: TAG, status: 200,
  summary: 'List all role definitions across all sports. Supports sport_code and family filters.',
  input: z.object({
    sport_code: z.string().optional(),
    family: z.string().optional(),
    governing_body: z.string().optional(),
    include_archived: z.coerce.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  async handler({ input }) {
    const rows = await many(
      `SELECT d.*, s.slug AS sport_slug, s.name AS sport_name
         FROM sport_official_role_definitions d
         LEFT JOIN sports s ON s.id = d.sport_id
        WHERE ($1::text IS NULL OR d.sport_code = $1)
          AND ($2::text IS NULL OR d.family = $2)
          AND ($3::text IS NULL OR d.governing_body = $3)
          AND ($4 OR d.status = 'active')
        ORDER BY d.sport_code, d.family, d.role_key
        LIMIT $5 OFFSET $6`,
      [input.sport_code ?? null, input.family ?? null, input.governing_body ?? null, input.include_archived, input.limit, input.offset],
    );
    return { roles: rows };
  },
});

cap({
  name: 'get_sport_official_role', method: 'GET', path: '/official-roles/:id', tag: TAG, status: 200,
  summary: 'Get a single official role definition by id.',
  input: z.object({}),
  async handler({ params }) {
    const row = await one(`SELECT d.*, s.slug AS sport_slug, s.name AS sport_name FROM sport_official_role_definitions d LEFT JOIN sports s ON s.id=d.sport_id WHERE d.id=$1`, [params.id]);
    if (!row) throw notFound('official_role');
    return row;
  },
});

cap({
  name: 'upsert_sport_official_role', method: 'POST', path: '/official-roles', tag: TAG, status: 200,
  summary: 'Create or update a sport official role definition. Platform admin or org admin only. Soft-updates only — never deletes existing data.',
  input: z.object({
    id: z.string().uuid().optional(),
    sport_code: z.string().min(1).max(60),
    sport_id: z.string().uuid().optional(),
    role_key: z.string().min(1).max(80).regex(/^[a-z_]+$/),
    display_name: z.string().min(1).max(120),
    display_name_translations: z.record(z.string()).default({}),
    family: z.enum(['match_official', 'video_official', 'technical_official', 'administrative_official', 'safety_official', 'support_official']),
    min_count: z.number().int().min(0).max(20).default(1),
    max_count: z.number().int().min(1).max(20).default(1),
    mandatory: z.boolean().default(true),
    requires_credentials: z.array(credentialSchema).default([]),
    min_grade: z.string().max(60).optional(),
    min_grade_rank: z.number().int().min(0).max(100).optional(),
    duties: z.array(z.string().max(300)).default([]),
    permissions: z.array(permissionSchema).default([]),
    governing_body: z.string().max(100).optional(),
    source: z.string().max(200).optional(),
    source_version: z.string().max(60).optional(),
    rule_pack_id: z.string().uuid().optional(),
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  async handler({ input, user, db }) {
    mustBeOrgOrAdmin(user);
    const i = input;
    if (i.max_count < i.min_count) throw badRequest('max_count must be >= min_count');

    return tx(async (c) => {
      let row;
      if (i.id) {
        // Update existing
        const existing = (await c.query('SELECT * FROM sport_official_role_definitions WHERE id=$1', [i.id])).rows[0];
        if (!existing) throw notFound('official_role');
        await c.query(
          `UPDATE sport_official_role_definitions SET sport_code=$2, sport_id=$3, role_key=$4, display_name=$5, display_name_translations=$6,
           family=$7, min_count=$8, max_count=$9, mandatory=$10, requires_credentials=$11, min_grade=$12, min_grade_rank=$13,
           duties=$14, permissions=$15, governing_body=$16, source=$17, source_version=$18, rule_pack_id=$19,
           effective_from=$20, effective_to=$21 WHERE id=$1`,
          [i.id, i.sport_code, i.sport_id ?? null, i.role_key, i.display_name, JSON.stringify(i.display_name_translations),
           i.family, i.min_count, i.max_count, i.mandatory, JSON.stringify(i.requires_credentials), i.min_grade ?? null, i.min_grade_rank ?? null,
           JSON.stringify(i.duties), JSON.stringify(i.permissions), i.governing_body ?? null, i.source ?? null, i.source_version ?? null, i.rule_pack_id ?? null,
           i.effective_from ?? null, i.effective_to ?? null],
        );
        row = (await c.query('SELECT * FROM sport_official_role_definitions WHERE id=$1', [i.id])).rows[0];
      } else {
        row = (await c.query(
          `INSERT INTO sport_official_role_definitions
             (sport_code, sport_id, role_key, display_name, display_name_translations, family, min_count, max_count,
              mandatory, requires_credentials, min_grade, min_grade_rank, duties, permissions, governing_body,
              source, source_version, rule_pack_id, effective_from, effective_to, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           ON CONFLICT (sport_code, role_key, governing_body) DO UPDATE
             SET display_name=$4, display_name_translations=$5, family=$6, min_count=$7, max_count=$8, mandatory=$9,
                 requires_credentials=$10, min_grade=$11, min_grade_rank=$12, duties=$13, permissions=$14,
                 source_version=$17, rule_pack_id=$18, effective_from=$19, effective_to=$20
           RETURNING *`,
          [i.sport_code, i.sport_id ?? null, i.role_key, i.display_name, JSON.stringify(i.display_name_translations),
           i.family, i.min_count, i.max_count, i.mandatory, JSON.stringify(i.requires_credentials),
           i.min_grade ?? null, i.min_grade_rank ?? null, JSON.stringify(i.duties), JSON.stringify(i.permissions),
           i.governing_body ?? null, i.source ?? null, i.source_version ?? null, i.rule_pack_id ?? null,
           i.effective_from ?? null, i.effective_to ?? null, user.id],
        )).rows[0];
      }
      await audit(c, user.id, 'upsert_official_role', 'sport_official_role_definitions', row.id);
      return row;
    });
  },
});

cap({
  name: 'archive_sport_official_role', method: 'POST', path: '/official-roles/:id/archive', tag: TAG, status: 200,
  summary: 'Soft-archive an official role definition. Platform admin only. The role remains in historical records.',
  input: z.object({ reason: z.string().max(300).optional() }),
  async handler({ params, input, user, db }) {
    mustBePlatformAdmin(user);
    return tx(async (c) => {
      const row = (await c.query(`UPDATE sport_official_role_definitions SET status='archived', archived_at=now() WHERE id=$1 AND status='active' RETURNING *`, [params.id])).rows[0];
      if (!row) throw notFound('official_role');
      await audit(c, user.id, 'archive_official_role', 'sport_official_role_definitions', row.id, input.reason);
      return { id: row.id, status: 'archived' };
    });
  },
});

// ── Crew Templates ────────────────────────────────────────────────────────

cap({
  name: 'list_crew_templates', method: 'GET', path: '/crew-templates', tag: TAG, status: 200,
  summary: 'List published crew templates. Filters: sport_code, level, match_format, governing_body.',
  input: z.object({
    sport_code: z.string().optional(),
    level: z.string().optional(),
    match_format: z.string().optional(),
    governing_body: z.string().optional(),
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  async handler({ input }) {
    const statuses = input.status ? [input.status] : ['published', 'draft'];
    const rows = await many(
      `SELECT t.*, s.slug AS sport_slug, s.name AS sport_name,
              (SELECT count(*)::int FROM crew_template_slots sl WHERE sl.template_id = t.id) AS slot_count,
              (SELECT count(*)::int FROM crew_template_slots sl WHERE sl.template_id = t.id AND sl.mandatory) AS mandatory_slot_count
         FROM crew_templates t
         LEFT JOIN sports s ON s.id = t.sport_id
        WHERE ($1::text IS NULL OR t.sport_code = $1)
          AND ($2::text IS NULL OR t.level = $2)
          AND ($3::text IS NULL OR t.match_format = $3)
          AND ($4::text IS NULL OR t.governing_body = $4)
          AND t.status = ANY($5::text[])
        ORDER BY t.sport_code, t.level, t.name
        LIMIT $6 OFFSET $7`,
      [input.sport_code ?? null, input.level ?? null, input.match_format ?? null, input.governing_body ?? null, statuses, input.limit, input.offset],
    );
    return { templates: rows };
  },
});

cap({
  name: 'get_crew_template', method: 'GET', path: '/crew-templates/:id', tag: TAG, status: 200,
  summary: 'Get a crew template with its full slot list.',
  input: z.object({}),
  async handler({ params }) {
    const tmpl = await one(
      `SELECT t.*, s.slug AS sport_slug, s.name AS sport_name FROM crew_templates t LEFT JOIN sports s ON s.id=t.sport_id WHERE t.id=$1`,
      [params.id],
    );
    if (!tmpl) throw notFound('crew_template');
    const slots = await many(`SELECT * FROM crew_template_slots WHERE template_id=$1 ORDER BY position_order, role_key`, [params.id]);
    return { ...tmpl, slots };
  },
});

cap({
  name: 'create_crew_template', method: 'POST', path: '/crew-templates', tag: TAG, status: 201,
  summary: 'Create a draft crew template. Platform admin or org admin. Slots are added with update_crew_template_slots.',
  input: z.object({
    sport_code: z.string().min(1).max(60),
    sport_id: z.string().uuid().optional(),
    match_format: z.string().min(1).max(60).default('standard'),
    level: z.enum(LEVELS),
    governing_body: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    rule_pack_id: z.string().uuid().optional(),
    rule_pack_version: z.string().max(60).optional(),
    source: z.string().max(200).optional(),
    source_ref: z.string().max(300).optional(),
  }),
  async handler({ input, user }) {
    mustBeOrgOrAdmin(user);
    return tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO crew_templates (sport_code, sport_id, match_format, level, governing_body, name, description, rule_pack_id, rule_pack_version, source, source_ref, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [input.sport_code, input.sport_id ?? null, input.match_format, input.level, input.governing_body,
         input.name, input.description ?? null, input.rule_pack_id ?? null, input.rule_pack_version ?? null,
         input.source ?? null, input.source_ref ?? null, user.id],
      )).rows[0];
      await audit(c, user.id, 'create_crew_template', 'crew_templates', row.id);
      return row;
    });
  },
});

const slotInput = z.object({
  role_key: z.string().min(1).max(80),
  display_name: z.string().min(1).max(120),
  family: z.enum(['match_official', 'video_official', 'technical_official', 'administrative_official', 'safety_official', 'support_official']),
  min_count: z.number().int().min(0).max(20).default(1),
  max_count: z.number().int().min(1).max(20).default(1),
  mandatory: z.boolean().default(true),
  min_grade: z.string().max(60).optional(),
  min_grade_rank: z.number().int().min(0).max(100).optional(),
  requires_credentials: z.array(credentialSchema).default([]),
  duties: z.array(z.string().max(300)).default([]),
  permissions: z.array(permissionSchema).default([]),
  position_order: z.number().int().min(0).default(0),
});

cap({
  name: 'update_crew_template_slots', method: 'PUT', path: '/crew-templates/:id/slots', tag: TAG, status: 200,
  summary: 'Replace all slots on a draft crew template. Only allowed while status=draft. Platform admin or org admin.',
  input: z.object({ slots: z.array(slotInput).min(1).max(30) }),
  async handler({ params, input, user }) {
    mustBeOrgOrAdmin(user);
    return tx(async (c) => {
      const tmpl = (await c.query('SELECT * FROM crew_templates WHERE id=$1', [params.id])).rows[0];
      if (!tmpl) throw notFound('crew_template');
      if (tmpl.status !== 'draft') throw badRequest('Slots can only be edited on a draft template');
      for (const s of input.slots) {
        if (s.max_count < s.min_count) throw badRequest(`Slot ${s.role_key}: max_count must be >= min_count`);
      }
      await c.query('DELETE FROM crew_template_slots WHERE template_id=$1', [params.id]);
      for (const s of input.slots) {
        await c.query(
          `INSERT INTO crew_template_slots (template_id, role_key, display_name, family, min_count, max_count, mandatory, min_grade, min_grade_rank, requires_credentials, duties, permissions, position_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [params.id, s.role_key, s.display_name, s.family, s.min_count, s.max_count, s.mandatory,
           s.min_grade ?? null, s.min_grade_rank ?? null, JSON.stringify(s.requires_credentials),
           JSON.stringify(s.duties), JSON.stringify(s.permissions), s.position_order],
        );
      }
      await audit(c, user.id, 'update_crew_template_slots', 'crew_templates', params.id);
      return { id: params.id, slot_count: input.slots.length };
    });
  },
});

cap({
  name: 'publish_crew_template', method: 'POST', path: '/crew-templates/:id/publish', tag: TAG, status: 200,
  summary: 'Publish a draft crew template. Freezes content via SHA-256 hash. Platform admin only.',
  input: z.object({}),
  async handler({ params, user }) {
    mustBePlatformAdmin(user);
    return tx(async (c) => {
      const tmpl = (await c.query('SELECT * FROM crew_templates WHERE id=$1', [params.id])).rows[0];
      if (!tmpl) throw notFound('crew_template');
      if (tmpl.status !== 'draft') throw badRequest('Only draft templates can be published');
      const slots = (await c.query('SELECT * FROM crew_template_slots WHERE template_id=$1 ORDER BY position_order', [params.id])).rows;
      if (!slots.length) throw badRequest('Cannot publish a template with no slots');
      const hash = templateHash(slots);
      const row = (await c.query(
        `UPDATE crew_templates SET status='published', published_at=now(), published_by=$2, content_hash=$3 WHERE id=$1 RETURNING *`,
        [params.id, user.id, hash],
      )).rows[0];
      await audit(c, user.id, 'publish_crew_template', 'crew_templates', params.id);
      return { id: row.id, status: 'published', content_hash: hash, published_at: row.published_at };
    });
  },
});

cap({
  name: 'archive_crew_template', method: 'POST', path: '/crew-templates/:id/archive', tag: TAG, status: 200,
  summary: 'Soft-archive a crew template. Platform admin only.',
  input: z.object({ reason: z.string().max(300).optional() }),
  async handler({ params, input, user }) {
    mustBePlatformAdmin(user);
    return tx(async (c) => {
      const row = (await c.query(`UPDATE crew_templates SET status='archived', archived_at=now() WHERE id=$1 AND status != 'archived' RETURNING *`, [params.id])).rows[0];
      if (!row) throw notFound('crew_template');
      await audit(c, user.id, 'archive_crew_template', 'crew_templates', params.id, input.reason);
      return { id: row.id, status: 'archived' };
    });
  },
});

cap({
  name: 'apply_crew_template_to_event', method: 'POST', path: '/events/:id/apply-crew-template', tag: TAG, status: 200,
  summary: 'Apply a published crew template to an event. Upserts event_crew_requirements from template slots, refreshes completeness for all fixtures, and audit-logs the application. Never deletes existing slots — only adds or raises counts.',
  input: z.object({
    template_id: z.string().uuid(),
    override_note: z.string().max(300).optional(),
  }),
  async handler({ params, input, user }) {
    return tx(async (c) => {
      // Auth: event organiser or org admin
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [params.id])).rows[0];
      if (!ev) throw notFound('event');
      if (ev.organizer_id !== user.id && !isAdmin(user)) {
        const orgRole = (await c.query("SELECT 1 FROM org_members WHERE organisation_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND status='active'", [ev.organisation_id, user.id])).rowCount;
        if (!orgRole) throw forbidden('Only the event organiser or an org admin may apply crew templates');
      }

      const tmpl = (await c.query('SELECT * FROM crew_templates WHERE id=$1 AND status=$2', [input.template_id, 'published'])).rows[0];
      if (!tmpl) throw notFound('crew_template');

      const slots = (await c.query('SELECT * FROM crew_template_slots WHERE template_id=$1 ORDER BY position_order', [input.template_id])).rows;
      if (!slots.length) throw badRequest('Template has no slots');

      // Upsert each slot into event_crew_requirements (additive — raise counts, never lower)
      for (const s of slots) {
        await c.query(
          `INSERT INTO event_crew_requirements (event_id, role, min_count, max_count, mandatory, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (event_id, role) DO UPDATE
             SET min_count = GREATEST(event_crew_requirements.min_count, EXCLUDED.min_count),
                 max_count = GREATEST(event_crew_requirements.max_count, EXCLUDED.max_count),
                 mandatory  = event_crew_requirements.mandatory OR EXCLUDED.mandatory,
                 updated_at = now()`,
          [params.id, s.role_key, s.min_count, s.max_count, s.mandatory, `From template: ${tmpl.name}`],
        );
      }

      // Audit log
      await c.query(
        `INSERT INTO event_crew_template_applications (event_id, template_id, applied_by, override_note) VALUES ($1,$2,$3,$4)`,
        [params.id, input.template_id, user.id, input.override_note ?? null],
      );
      await audit(c, user.id, 'apply_crew_template', 'events', params.id);

      // Refresh completeness for all fixtures in this event
      const fixtures = (await c.query('SELECT id FROM fixtures WHERE event_id=$1 AND status NOT IN ($2,$3)', [params.id, 'cancelled', 'void'])).rows;
      for (const fx of fixtures) {
        const reqs = (await c.query('SELECT role, min_count, mandatory FROM event_crew_requirements WHERE event_id=$1', [params.id])).rows;
        if (!reqs.length) {
          await c.query(`INSERT INTO fixture_crew_completeness(fixture_id,is_complete,missing_roles,total_slots,filled_slots,checked_at) VALUES($1,true,'{}',0,0,now()) ON CONFLICT(fixture_id) DO UPDATE SET is_complete=true,missing_roles='{}',total_slots=0,filled_slots=0,checked_at=now()`, [fx.id]);
          continue;
        }
        const counts = (await c.query(`SELECT role, count(*)::int AS n FROM fixture_officials WHERE fixture_id=$1 AND status='accepted' GROUP BY role`, [fx.id])).rows;
        const cm = Object.fromEntries(counts.map((r) => [r.role, r.n]));
        const missing = reqs.filter((r) => r.mandatory && (cm[r.role] ?? 0) < r.min_count).map((r) => r.role);
        const totalSlots = reqs.reduce((s, r) => s + r.min_count, 0);
        const filledSlots = reqs.reduce((s, r) => s + Math.min(cm[r.role] ?? 0, r.min_count), 0);
        await c.query(`INSERT INTO fixture_crew_completeness(fixture_id,is_complete,missing_roles,total_slots,filled_slots,checked_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(fixture_id) DO UPDATE SET is_complete=$2,missing_roles=$3,total_slots=$4,filled_slots=$5,checked_at=now()`, [fx.id, missing.length === 0, missing, totalSlots, filledSlots]);
      }

      return { event_id: params.id, template_id: input.template_id, slots_applied: slots.length, fixtures_updated: fixtures.length };
    });
  },
});

// ── Platform admin: seed governing-body roles ─────────────────────────────
cap({
  name: 'seed_official_role_taxonomy', method: 'POST', path: '/official-roles/seed', tag: TAG, status: 200,
  summary: 'Platform admin: seed governing-body standard official role definitions and published crew templates for all major sports.',
  input: z.object({ dry_run: z.boolean().default(false) }),
  async handler({ input, user }) {
    mustBePlatformAdmin(user);
    return tx(async (c) => {
      let roles_seeded = 0; let templates_seeded = 0;

      if (!input.dry_run) {
        for (const r of GB_ROLES_SEED) {
          await c.query(
            `INSERT INTO sport_official_role_definitions
               (sport_code, role_key, display_name, family, min_count, max_count, mandatory, requires_credentials,
                min_grade, min_grade_rank, duties, permissions, governing_body, source, source_version, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT (sport_code, role_key, governing_body) DO UPDATE
               SET display_name=$3, family=$4, min_count=$5, max_count=$6, mandatory=$7, requires_credentials=$8,
                   min_grade=$9, min_grade_rank=$10, duties=$11, permissions=$12, source_version=$15`,
            [r.sport_code, r.role_key, r.display_name, r.family, r.min_count ?? 1, r.max_count ?? 1, r.mandatory ?? true,
             JSON.stringify(r.requires_credentials ?? []), r.min_grade ?? null, r.min_grade_rank ?? null,
             JSON.stringify(r.duties ?? []), JSON.stringify(r.permissions ?? []), r.governing_body ?? null,
             r.source ?? null, r.source_version ?? null, user.id],
          );
          roles_seeded++;
        }

        for (const t of CREW_TEMPLATES_SEED) {
          const existing = (await c.query('SELECT id FROM crew_templates WHERE sport_code=$1 AND match_format=$2 AND level=$3 AND governing_body=$4', [t.sport_code, t.match_format, t.level, t.governing_body])).rows[0];
          let tmplId;
          if (existing) {
            tmplId = existing.id;
          } else {
            const row = (await c.query(
              `INSERT INTO crew_templates (sport_code, match_format, level, governing_body, name, description, source, source_ref, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
              [t.sport_code, t.match_format, t.level, t.governing_body, t.name, t.description ?? null, t.source ?? null, t.source_ref ?? null, user.id],
            )).rows[0];
            tmplId = row.id;
          }
          await c.query('DELETE FROM crew_template_slots WHERE template_id=$1', [tmplId]);
          for (const s of t.slots) {
            await c.query(
              `INSERT INTO crew_template_slots (template_id, role_key, display_name, family, min_count, max_count, mandatory, min_grade, min_grade_rank, requires_credentials, duties, permissions, position_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [tmplId, s.role_key, s.display_name, s.family, s.min_count, s.max_count, s.mandatory,
               s.min_grade ?? null, s.min_grade_rank ?? null, JSON.stringify(s.requires_credentials ?? []),
               JSON.stringify(s.duties ?? []), JSON.stringify(s.permissions ?? []), s.position_order ?? 0],
            );
          }
          const slots = (await c.query('SELECT * FROM crew_template_slots WHERE template_id=$1 ORDER BY position_order', [tmplId])).rows;
          const hash = templateHash(slots);
          await c.query(`UPDATE crew_templates SET status='published', published_at=now(), published_by=$2, content_hash=$3 WHERE id=$1`, [tmplId, user.id, hash]);
          templates_seeded++;
        }
      }

      return {
        roles_seeded: input.dry_run ? GB_ROLES_SEED.length : roles_seeded,
        templates_seeded: input.dry_run ? CREW_TEMPLATES_SEED.length : templates_seeded,
        dry_run: input.dry_run,
      };
    });
  },
});
