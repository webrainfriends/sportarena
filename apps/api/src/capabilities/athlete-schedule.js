import { z } from 'zod';
import { venueText } from '../session-links.js';
import { cap } from '../registry.js';
import { many } from '../db.js';
import { badRequest } from '../errors.js';
import { hasConsent, isYouth } from '../youth.js';
import { loggedMap, occurrences, plain } from '../coach-commitments.js';

const TAG = 'Athlete';
const DEFAULT_MATCH_MIN = 90;
const KINDS = ['match', 'team', 'event', 'venue', 'training', 'health', 'duty', 'recovery', 'external'];
const BLOCK_LABEL = { recovery: 'Recovery', gym: 'Gym', rest: 'Rest', other: 'Personal time', travel: 'Travel' };
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// A derived read projection over canonical records. Nothing is copied or stored; health items stay generic
// (no reason, notes or instructions) so the payload is safe to render anywhere without an audit trail.
cap({
  name: 'get_my_sport_schedule', method: 'GET', path: '/me/sport-schedule', tag: TAG,
  summary: 'Everything on your calendar in one list, whatever your roles: team fixtures and selections, games, events and tournaments you play, organise or work at, officiating and crew duty, venue bookings, coaching sessions (booked, plan sessions and your coaching commitments), your own physio/doctor appointments and the patient appointments you hold as a provider, and follow-ups, with overlap warnings.',
  input: z.object({
    from: day.optional(), to: day.optional(),
    kinds: z.string().optional().describe('Comma separated: match, team, event, venue, training, health, duty, recovery, external'),
    sport: z.string().optional().describe('Sport slug'),
  }),
  handler: ({ user }, i) => buildSchedule(user, i),
});

/** The schedule projection for one person. Shared by the calendar read, the ICS feed and the conflict check. */
export async function buildSchedule(user, i) {
    const from = i.from ?? new Date().toISOString().slice(0, 10);
    const to = i.to ?? new Date(Date.parse(from) + 14 * 86400000).toISOString().slice(0, 10);
    if (to < from) throw badRequest('to is before from');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw badRequest('Range is limited to 92 days');
    const kinds = i.kinds ? i.kinds.split(',').map((k) => k.trim()).filter(Boolean) : KINDS;
    if (kinds.some((k) => !KINDS.includes(k))) throw badRequest(`kinds must be among ${KINDS.join(', ')}`);
    const win = [user.id, from, to];
    const D = `${DEFAULT_MATCH_MIN} minutes`;

    const [squads, games, entries, organised, bookings, hires, appts, follows, gameSessions, planSessions, teamFixtures, teamEntries, officiating, crew, patients, commitments, blocks, attendance, academy] = await Promise.all([
      many(`SELECT q.id, q.status, q.team_id, f.id AS fixture_id, f.event_id AS fx_event_id, f.scheduled_at AS starts_at, f.scheduled_at + f.duration_min * interval '1 minute' AS ends_at, e.name AS event_name, s.slug AS sport,
                   t.name AS team_name, h.name AS home_name, a.name AS away_name, rs.timezone AS tz
            FROM team_squads q JOIN fixtures f ON f.id=q.fixture_id JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id
            JOIN teams t ON t.id=q.team_id JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id
            LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues rs ON rs.id=r.venue_id
            WHERE q.user_id=$1 AND q.status IN ('selected','confirmed') AND f.status IN ('scheduled','live')
              AND f.scheduled_at >= $2::date AND f.scheduled_at < $3::date + 1`, win),
      many(`SELECT g.id, g.title, g.status, g.starts_at, coalesce(g.ends_at, g.starts_at + interval '${D}') AS ends_at, (g.ends_at IS NULL) AS assumed, s.slug AS sport, v.timezone AS tz
            FROM game_participants gp JOIN games g ON g.id=gp.game_id JOIN sports s ON s.id=g.sport_id LEFT JOIN venues v ON v.id=g.venue_id
            WHERE gp.user_id=$1 AND g.status NOT IN ('canceled','discarded','post-event') AND g.starts_at >= $2::date AND g.starts_at < $3::date + 1`, win),
      many(`SELECT e.id, e.name, e.status, e.starts_on, e.ends_on, s.slug AS sport, x.status AS entry_status
            FROM event_entries x JOIN events e ON e.id=x.event_id JOIN sports s ON s.id=e.sport_id
            WHERE x.user_id=$1 AND x.status IN ('pending','accepted') AND e.status <> 'cancelled'
              AND coalesce(e.ends_on, e.starts_on) >= $2::date AND e.starts_on <= $3::date`, win),
      many(`SELECT e.id, e.name, e.status, e.starts_on, e.ends_on, s.slug AS sport
            FROM events e JOIN sports s ON s.id=e.sport_id
            WHERE e.organizer_id=$1 AND e.status <> 'cancelled' AND coalesce(e.ends_on, e.starts_on) >= $2::date AND e.starts_on <= $3::date`, win),
      many(`SELECT b.id, b.starts_at, b.ends_at, r.name AS resource_name, v.name AS venue_name, v.timezone AS tz
            FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id
            WHERE b.user_id=$1 AND b.status='confirmed' AND b.starts_at >= $2::date AND b.starts_at < $3::date + 1`, win),
      many(`SELECT h.id, h.status, h.starts_at, h.starts_at + h.duration_min * interval '1 minute' AS ends_at, s.slug AS sport,
                   CASE WHEN h.hirer_id=$1 THEN cu.display_name ELSE hu.display_name END AS other_name, (h.coach_id=$1) AS as_coach, ${venueText('coach_hire', 'h.id')}
            FROM coach_hires h JOIN users cu ON cu.id=h.coach_id JOIN users hu ON hu.id=h.hirer_id LEFT JOIN sports s ON s.id=h.sport_id
            WHERE (h.hirer_id=$1 OR h.coach_id=$1) AND h.status IN ('requested','confirmed') AND h.starts_at >= $2::date AND h.starts_at < $3::date + 1`, win),
      many(`SELECT a.id, a.status, a.starts_at, a.starts_at + a.duration_min * interval '1 minute' AS ends_at, p.provider_type, p.timezone AS tz
            FROM appointments a LEFT JOIN provider_profiles p ON p.user_id=a.provider_id
            WHERE a.athlete_id=$1 AND a.status IN ('requested','confirmed') AND a.starts_at >= $2::date AND a.starts_at < $3::date + 1`, win),
      many(`SELECT id, status, due_on, window_end FROM appointment_followups
            WHERE athlete_id=$1 AND status='due' AND coalesce(window_end, due_on) >= $2::date AND due_on <= $3::date`, win),
      // multi-sport events: sessions of every discipline the person competes in, directly or through a team
      many(`WITH pe AS (SELECT se.session_id, se.participant_id FROM event_session_entries se WHERE se.participant_id IS NOT NULL AND se.result_status <> 'scratched'
                        UNION SELECT se.session_id, n.participant_id FROM event_session_entries se JOIN discipline_nominations n ON n.team_id=se.team_id AND n.status IN ('nominated','confirmed') WHERE se.result_status <> 'scratched')
            SELECT s.id, s.label, s.status, s.scheduled_at AS starts_at, s.scheduled_at + s.duration_min * interval '1 minute' AS ends_at, e.name AS event_name, e.id AS event_id, sp.slug AS sport, coalesce(r.name, s.location) AS ground
              FROM pe JOIN event_participants p ON p.id=pe.participant_id JOIN event_sessions s ON s.id=pe.session_id JOIN events e ON e.id=s.event_id
              JOIN event_disciplines d ON d.id=s.discipline_id JOIN sports sp ON sp.id=d.sport_id LEFT JOIN resources r ON r.id=s.resource_id
             WHERE p.user_id=$1 AND s.status IN ('scheduled','live') AND s.scheduled_at >= $2::date AND s.scheduled_at < $3::date + 1`, win),
      // training-plan sessions, as the athlete or as the coach
      many(`SELECT t.id, t.title, t.status, t.starts_at, t.starts_at + t.duration_min * interval '1 minute' AS ends_at, p.id AS plan_id, sp.slug AS sport, (p.coach_id=$1) AS as_coach,
                   CASE WHEN p.coach_id=$1 THEN ua.display_name ELSE uc.display_name END AS other_name, ${venueText('training_session', 't.id')}
              FROM training_sessions t JOIN training_plans p ON p.id=t.plan_id JOIN users ua ON ua.id=p.athlete_id JOIN users uc ON uc.id=p.coach_id LEFT JOIN sports sp ON sp.id=p.sport_id
             WHERE (p.athlete_id=$1 OR p.coach_id=$1) AND t.status='scheduled' AND t.starts_at >= $2::date AND t.starts_at < $3::date + 1`, win),
      // every fixture of every team you are an active member of (players, captains, managers and coaches alike)
      many(`SELECT DISTINCT ON (f.id) f.id, f.event_id AS fx_event_id, f.status, f.scheduled_at AS starts_at, f.scheduled_at + f.duration_min * interval '1 minute' AS ends_at, e.name AS event_name, s.slug AS sport, t.name AS team_name,
                   h.name AS home_name, a.name AS away_name, vv.timezone AS tz, m.role AS my_role, t.id AS team_id
              FROM team_members m JOIN teams t ON t.id=m.team_id JOIN fixtures f ON t.id IN (f.home_team_id, f.away_team_id) JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id
              JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues vv ON vv.id=r.venue_id
             WHERE m.user_id=$1 AND m.status='active' AND f.status IN ('scheduled','live') AND f.scheduled_at >= $2::date AND f.scheduled_at < $3::date + 1
             ORDER BY f.id`, win),
      many(`SELECT e.id, e.name, e.status, e.starts_on, e.ends_on, s.slug AS sport, t.name AS team_name, t.id AS team_id
              FROM event_entries x JOIN teams t ON t.id=x.team_id JOIN team_members m ON m.team_id=t.id AND m.user_id=$1 AND m.status='active' JOIN events e ON e.id=x.event_id JOIN sports s ON s.id=e.sport_id
             WHERE x.status IN ('pending','accepted') AND e.status <> 'cancelled' AND coalesce(e.ends_on, e.starts_on) >= $2::date AND e.starts_on <= $3::date`, win),
      // officiating: referee, umpire, linesman, scorer
      many(`SELECT o.id, o.role, o.status, f.scheduled_at AS starts_at, f.scheduled_at + f.duration_min * interval '1 minute' AS ends_at, e.name AS event_name, s.slug AS sport, h.name AS home_name, a.name AS away_name, vv.timezone AS tz
              FROM fixture_officials o JOIN fixtures f ON f.id=o.fixture_id JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id
              LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues vv ON vv.id=r.venue_id
             WHERE o.user_id=$1 AND o.status IN ('invited','accepted') AND f.status IN ('scheduled','live') AND f.scheduled_at >= $2::date AND f.scheduled_at < $3::date + 1`, win),
      // crew and vendor work at events
      many(`SELECT a.id, a.status, r.role, r.title, e.id AS event_id, e.name AS event_name, e.starts_on, e.ends_on, s.slug AS sport
              FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id JOIN events e ON e.id=a.event_id LEFT JOIN sports s ON s.id=e.sport_id
             WHERE a.user_id=$1 AND a.status IN ('invited','accepted') AND e.status NOT IN ('cancelled','completed') AND coalesce(e.ends_on, e.starts_on) >= $2::date AND e.starts_on <= $3::date`, win),
      // physio / doctor: the appointments patients have with you (no reason or notes)
      many(`SELECT a.id, a.status, a.starts_at, a.starts_at + a.duration_min * interval '1 minute' AS ends_at, u.display_name AS patient, p.provider_type, p.timezone AS tz
              FROM appointments a JOIN users u ON u.id=a.athlete_id LEFT JOIN provider_profiles p ON p.user_id=a.provider_id
             WHERE a.provider_id=$1 AND a.status IN ('requested','confirmed') AND a.starts_at >= $2::date AND a.starts_at < $3::date + 1`, win),
      many(`SELECT c.*, s.slug AS sport_slug, coalesce(t.name, e.name, u.display_name, c.client_name) AS client FROM coach_commitments c LEFT JOIN sports s ON s.id=c.sport_id LEFT JOIN teams t ON t.id=c.team_id LEFT JOIN events e ON e.id=c.event_id LEFT JOIN users u ON u.id=c.client_user_id
             WHERE c.coach_id=$1 AND c.status='active' AND c.kind NOT IN ('block') AND c.starts_on <= $3::date AND (c.ends_on IS NULL OR c.ends_on >= $2::date)`, win),
      many(`SELECT id, kind, title, starts_at, ends_at, timezone, version FROM athlete_blocks WHERE user_id=$1 AND status='active' AND starts_at >= $2::date AND starts_at < $3::date + 1`, win),
      // your own answers to "are you coming?" (team_attendance), so each team item can show In / Maybe / Out
      many(`SELECT team_id, event_id, fixture_id, rsvp FROM team_attendance WHERE user_id=$1`, [user.id]),
      // Academy OS 2/3: sessions of cohorts you are enrolled in (or added to as a make-up guest), and sessions you staff. Read from the academy session; never copied.
      many(`SELECT s.id, s.title, s.status, s.starts_at, s.ends_at, s.timezone, s.sport, k.name AS cohort, o.name AS organisation, coalesce(a.status, 'expected') AS attendance, false AS as_staff, ${venueText('academy_session', 's.id')}
              FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id JOIN organisations o ON o.id=s.organisation_id LEFT JOIN academy_attendance a ON a.session_id=s.id AND a.user_id=$1
             WHERE s.status IN ('published','cancelled') AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1
               AND (EXISTS (SELECT 1 FROM org_enrolments e WHERE e.cohort_id=s.cohort_id AND e.user_id=$1 AND e.status='enrolled') OR coalesce(a.guest, false))
             UNION ALL
            SELECT s.id, s.title, s.status, s.starts_at, s.ends_at, s.timezone, s.sport, k.name, o.name, 'expected', true, ${venueText('academy_session', 's.id')}
              FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id JOIN org_cohorts k ON k.id=s.cohort_id JOIN organisations o ON o.id=s.organisation_id
             WHERE st.user_id=$1 AND st.status IN ('assigned','confirmed') AND s.status='published' AND s.starts_at >= $2::date AND s.starts_at < $3::date + 1`, win),
    ]);

    // Busy time imported from another calendar (no titles kept). A young person's imports are hidden the moment guardian consent is withdrawn.
    const external = kinds.includes('external') && (!(await isYouth(user.id)) || (await hasConsent(user.id, 'calendar_sharing')))
      ? await many(`SELECT e.id, e.starts_at, e.ends_at, e.all_day, i.id AS import_id, coalesce(i.label, i.source_host) AS source
                      FROM calendar_import_events e JOIN calendar_imports i ON i.id=e.import_id
                     WHERE i.user_id=$1 AND i.removed_at IS NULL AND e.removed_at IS NULL AND e.ends_at > $2::date AND e.starts_at < $3::date + 1`, win) : [];
    const items = [];
    const add = (o) => items.push({ sport: null, ends_at: null, timezone: 'UTC', action_required: false, all_day: false, conflict: false, duration_assumed: false, rsvp: null, ...o });
    const answered = new Map(attendance.map((r) => [`${r.team_id}|${r.event_id ?? ''}|${r.fixture_id ?? ''}`, r.rsvp]));
    // RSVP is the existing team attendance (set_event_rsvp). The scope says which team and fixture/event the answer is for.
    // A fixture answer is stored with its event id too, but the caller sends only one of fixture_id / event_id.
    const rsvpFor = (team_id, { fixture_id = null, event_id = null, stored_event = event_id }) => ({ team_id, fixture_id, event_id, value: answered.get(`${team_id}|${stored_event ?? ''}|${fixture_id ?? ''}`) ?? 'pending' });
    for (const r of squads) add({ kind: 'team', source_type: 'team_squad', source_id: r.id, sport: r.sport, title: `${r.home_name} v ${r.away_name}`, context: `${r.team_name} · ${r.event_name}`, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: r.status === 'confirmed' ? 'confirmed' : 'awaiting_response', action_required: r.status === 'selected', link: { screen: 'Team', params: {} }, rsvp: rsvpFor(r.team_id, { fixture_id: r.fixture_id, stored_event: r.fx_event_id }), actions: r.status === 'selected' ? ['respond_to_selection'] : [] });
    for (const r of games) add({ kind: 'match', source_type: 'game', source_id: r.id, sport: r.sport, title: r.title, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', duration_assumed: r.assumed, status: r.status === 'pre-event' ? 'confirmed' : r.status, actions: [] });
    const seen = new Set();
    for (const [rows, mine] of [[organised, true], [entries, false]]) {
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        add({ kind: 'event', source_type: 'event', source_id: r.id, sport: r.sport, title: r.name, context: mine ? 'Organising' : 'Entered', starts_at: `${r.starts_on.toISOString?.().slice(0, 10) ?? r.starts_on}T00:00:00Z`, ends_at: r.ends_on ? `${r.ends_on.toISOString?.().slice(0, 10) ?? r.ends_on}T23:59:59Z` : null, all_day: true, status: mine ? r.status : r.entry_status === 'accepted' ? 'confirmed' : 'awaiting_response', link: { screen: 'Event', params: { id: r.id } }, actions: [] });
      }
    }
    for (const r of gameSessions) add({ kind: 'match', source_type: 'event_session', source_id: r.id, sport: r.sport, title: r.label, context: `${r.event_name}${r.ground ? ` · ${r.ground}` : ''}`, starts_at: r.starts_at, ends_at: r.ends_at, status: 'confirmed', link: { screen: 'Games', params: { id: r.event_id } }, actions: [] });
    for (const r of bookings) add({ kind: 'venue', source_type: 'booking', source_id: r.id, title: r.venue_name, context: r.resource_name, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: 'confirmed', link: { screen: 'Reservation', params: {} }, actions: [] });
    for (const r of hires) add({ kind: 'training', source_type: 'coach_hire', source_id: r.id, sport: r.sport, title: r.as_coach ? 'Coaching session' : 'Session with your coach', context: [r.other_name, r.venue].filter(Boolean).join(' · '), starts_at: r.starts_at, ends_at: r.ends_at, status: r.status === 'confirmed' ? 'confirmed' : 'proposed', action_required: r.as_coach && r.status === 'requested', link: { screen: 'Hub', params: {} }, actions: [] });
    for (const r of appts) add({ kind: 'health', source_type: 'appointment', source_id: r.id, title: r.provider_type === 'physio' ? 'Physio appointment' : r.provider_type === 'doctor' ? 'Doctor appointment' : 'Appointment', starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: r.status === 'confirmed' ? 'confirmed' : 'proposed', link: { screen: 'Health', params: {} }, actions: [] });
    for (const r of follows) add({ kind: 'health', source_type: 'followup', source_id: r.id, title: 'Health follow-up due', starts_at: `${r.due_on.toISOString?.().slice(0, 10) ?? r.due_on}T00:00:00Z`, ends_at: r.window_end ? `${r.window_end.toISOString?.().slice(0, 10) ?? r.window_end}T23:59:59Z` : null, all_day: true, status: 'awaiting_response', action_required: true, link: { screen: 'Health', params: {} }, actions: [] });

    const day10 = (d) => (d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    const fixtureIdsSeen = new Set(squads.map((r) => `${r.fixture_id}`));
    for (const r of planSessions) add({ kind: 'training', source_type: 'training_session', source_id: r.id, sport: r.sport, title: r.title, context: [r.as_coach ? `With ${r.other_name}` : `Coach ${r.other_name}`, r.venue].filter(Boolean).join(' · '), starts_at: r.starts_at, ends_at: r.ends_at, status: 'confirmed', link: { screen: r.as_coach ? 'CoachPlan' : 'MyPlans', params: r.as_coach ? { id: r.plan_id } : {} }, actions: [] });
    for (const r of teamFixtures) { if (fixtureIdsSeen.has(`${r.id}`)) continue; add({ kind: 'match', source_type: 'fixture', source_id: `${r.id}`, sport: r.sport, title: `${r.home_name} v ${r.away_name}`, context: `${r.team_name} · ${r.event_name}${r.my_role === 'coach' ? ' · coaching' : ''}`, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: 'confirmed', rsvp: rsvpFor(r.team_id, { fixture_id: r.id, stored_event: r.fx_event_id }), actions: [] }); }
    for (const r of teamEntries) { if (seen.has(r.id)) continue; seen.add(r.id); add({ kind: 'event', source_type: 'event', source_id: r.id, sport: r.sport, title: r.name, context: `${r.team_name} entered`, starts_at: `${day10(r.starts_on)}T00:00:00Z`, ends_at: r.ends_on ? `${day10(r.ends_on)}T23:59:59Z` : null, all_day: true, status: r.status === 'ongoing' ? 'ongoing' : 'open', link: { screen: 'Event', params: { id: r.id } }, rsvp: rsvpFor(r.team_id, { event_id: r.id }), actions: [] }); }
    for (const r of officiating) add({ kind: 'duty', source_type: 'fixture_official', source_id: r.id, sport: r.sport, title: `${r.role[0].toUpperCase()}${r.role.slice(1)} · ${r.home_name} v ${r.away_name}`, context: r.event_name, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: r.status === 'accepted' ? 'confirmed' : 'awaiting_response', action_required: r.status === 'invited', link: { screen: 'Hub', params: {} }, actions: [] });
    for (const r of crew) add({ kind: 'duty', source_type: 'event_staff', source_id: r.id, sport: r.sport, title: `${r.title ?? r.role} · ${r.event_name}`, context: 'Event crew', starts_at: `${day10(r.starts_on)}T00:00:00Z`, ends_at: r.ends_on ? `${day10(r.ends_on)}T23:59:59Z` : null, all_day: true, status: r.status === 'accepted' ? 'confirmed' : 'awaiting_response', action_required: r.status === 'invited', link: { screen: 'Event', params: { id: r.event_id } }, actions: [] });
    for (const r of patients) add({ kind: 'health', source_type: 'provider_appointment', source_id: r.id, title: `${r.patient} · ${r.provider_type === 'doctor' ? 'consultation' : 'session'}`, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: r.status === 'confirmed' ? 'confirmed' : 'awaiting_response', action_required: r.status === 'requested', link: { screen: 'Health', params: {} }, actions: [] });
    for (const r of blocks) add({ kind: 'recovery', source_type: 'athlete_block', source_id: r.id, title: r.title || BLOCK_LABEL[r.kind], context: r.title ? BLOCK_LABEL[r.kind] : null, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.timezone, status: 'confirmed', version: r.version, actions: ['update_athlete_block', 'archive_athlete_block'] });
    for (const r of academy) add({ kind: r.as_staff ? 'duty' : 'training', source_type: 'academy_session', source_id: r.id, sport: r.sport, title: r.title, context: [r.organisation, r.cohort, r.venue].filter(Boolean).join(' · '), starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.timezone, status: r.status === 'cancelled' ? 'cancelled' : ['absent', 'excused'].includes(r.attendance) ? 'declined' : 'confirmed', link: { screen: r.as_staff ? 'AcademySession' : 'AcademyFamily', params: r.as_staff ? { id: r.id } : {} }, actions: [] });
    for (const r of external) add({ kind: 'external', source_type: 'external_busy', source_id: r.id, title: 'Busy', context: r.source, starts_at: r.starts_at, ends_at: r.ends_at, all_day: r.all_day, status: 'confirmed', actions: [] });
    const clog = await loggedMap(commitments.map((c) => c.id));
    for (const raw of commitments) for (const o of occurrences(plain(raw), from, to, clog)) add({ kind: 'training', source_type: 'coach_commitment', source_id: `${raw.id}:${o.on_date}`, sport: raw.sport_slug, title: raw.title, context: [raw.client, 'Commitment'].filter(Boolean).join(' · '), starts_at: o.starts_at, ends_at: o.ends_at, timezone: raw.timezone, status: o.logged?.status === 'delivered' ? 'completed' : 'confirmed', link: { screen: 'CoachCommitments', params: {} }, actions: [] });

    let out = items.filter((x) => kinds.includes(x.kind) && (!i.sport || x.sport === i.sport));
    out.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || a.source_type.localeCompare(b.source_type) || a.source_id.localeCompare(b.source_id));
    // Overlap warning between timed commitments only; flagging never changes the underlying records.
    const timed = out.filter((x) => !x.all_day && x.ends_at);
    for (const a of timed) for (const b of timed) if (a !== b && new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at)) a.conflict = true;
    return { from, to, items: out, conflicts: out.filter((x) => x.conflict).length, action_required: out.filter((x) => x.action_required).length };
}
