import { z } from 'zod';
import { cap } from '../registry.js';
import { many } from '../db.js';
import { badRequest } from '../errors.js';

const TAG = 'Athlete';
const DEFAULT_MATCH_MIN = 90;
const KINDS = ['match', 'team', 'event', 'venue', 'training', 'health'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// A derived read projection over canonical records. Nothing is copied or stored; health items stay generic
// (no reason, notes or instructions) so the payload is safe to render anywhere without an audit trail.
cap({
  name: 'get_my_sport_schedule', method: 'GET', path: '/me/sport-schedule', tag: TAG,
  summary: 'Your unified sport schedule: team fixtures and selections, games, events, venue bookings, coach sessions, appointments and follow-ups, with overlap warnings.',
  input: z.object({
    from: day.optional(), to: day.optional(),
    kinds: z.string().optional().describe('Comma separated: match, team, event, venue, training, health'),
    sport: z.string().optional().describe('Sport slug'),
  }),
  async handler({ user }, i) {
    const from = i.from ?? new Date().toISOString().slice(0, 10);
    const to = i.to ?? new Date(Date.parse(from) + 14 * 86400000).toISOString().slice(0, 10);
    if (to < from) throw badRequest('to is before from');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw badRequest('Range is limited to 92 days');
    const kinds = i.kinds ? i.kinds.split(',').map((k) => k.trim()).filter(Boolean) : KINDS;
    if (kinds.some((k) => !KINDS.includes(k))) throw badRequest(`kinds must be among ${KINDS.join(', ')}`);
    const win = [user.id, from, to];
    const D = `${DEFAULT_MATCH_MIN} minutes`;

    const [squads, games, entries, organised, bookings, hires, appts, follows] = await Promise.all([
      many(`SELECT q.id, q.status, f.id AS fixture_id, f.scheduled_at AS starts_at, f.scheduled_at + interval '${D}' AS ends_at, e.name AS event_name, s.slug AS sport,
                   t.name AS team_name, h.name AS home_name, a.name AS away_name, rs.timezone AS tz
            FROM team_squads q JOIN fixtures f ON f.id=q.fixture_id JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id
            JOIN teams t ON t.id=q.team_id JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id
            LEFT JOIN resources r ON r.id=f.resource_id LEFT JOIN venues rs ON rs.id=r.venue_id
            WHERE q.user_id=$1 AND q.status IN ('selected','confirmed') AND f.status IN ('scheduled','live')
              AND f.scheduled_at >= $2::date AND f.scheduled_at < $3::date + 1`, win),
      many(`SELECT g.id, g.title, g.status, g.starts_at, coalesce(g.ends_at, g.starts_at + interval '${D}') AS ends_at, s.slug AS sport, v.timezone AS tz
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
                   CASE WHEN h.hirer_id=$1 THEN cu.display_name ELSE hu.display_name END AS other_name, (h.coach_id=$1) AS as_coach
            FROM coach_hires h JOIN users cu ON cu.id=h.coach_id JOIN users hu ON hu.id=h.hirer_id LEFT JOIN sports s ON s.id=h.sport_id
            WHERE (h.hirer_id=$1 OR h.coach_id=$1) AND h.status IN ('requested','confirmed') AND h.starts_at >= $2::date AND h.starts_at < $3::date + 1`, win),
      many(`SELECT a.id, a.status, a.starts_at, a.starts_at + a.duration_min * interval '1 minute' AS ends_at, p.provider_type, p.timezone AS tz
            FROM appointments a LEFT JOIN provider_profiles p ON p.user_id=a.provider_id
            WHERE a.athlete_id=$1 AND a.status IN ('requested','confirmed') AND a.starts_at >= $2::date AND a.starts_at < $3::date + 1`, win),
      many(`SELECT id, status, due_on, window_end FROM appointment_followups
            WHERE athlete_id=$1 AND status='due' AND coalesce(window_end, due_on) >= $2::date AND due_on <= $3::date`, win),
    ]);

    const items = [];
    const add = (o) => items.push({ sport: null, ends_at: null, timezone: 'UTC', action_required: false, all_day: false, conflict: false, ...o });
    for (const r of squads) add({ kind: 'team', source_type: 'team_squad', source_id: r.id, sport: r.sport, title: `${r.home_name} v ${r.away_name}`, context: `${r.team_name} · ${r.event_name}`, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: r.status === 'confirmed' ? 'confirmed' : 'awaiting_response', action_required: r.status === 'selected', link: { screen: 'Team', params: {} }, actions: r.status === 'selected' ? ['respond_to_selection'] : [] });
    for (const r of games) add({ kind: 'match', source_type: 'game', source_id: r.id, sport: r.sport, title: r.title, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: r.status === 'pre-event' ? 'confirmed' : r.status, actions: [] });
    const seen = new Set();
    for (const [rows, mine] of [[organised, true], [entries, false]]) {
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        add({ kind: 'event', source_type: 'event', source_id: r.id, sport: r.sport, title: r.name, context: mine ? 'Organising' : 'Entered', starts_at: `${r.starts_on.toISOString?.().slice(0, 10) ?? r.starts_on}T00:00:00Z`, ends_at: r.ends_on ? `${r.ends_on.toISOString?.().slice(0, 10) ?? r.ends_on}T23:59:59Z` : null, all_day: true, status: mine ? r.status : r.entry_status === 'accepted' ? 'confirmed' : 'awaiting_response', link: { screen: 'Event', params: { id: r.id } }, actions: [] });
      }
    }
    for (const r of bookings) add({ kind: 'venue', source_type: 'booking', source_id: r.id, title: r.venue_name, context: r.resource_name, starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: 'confirmed', link: { screen: 'Reservation', params: {} }, actions: [] });
    for (const r of hires) add({ kind: 'training', source_type: 'coach_hire', source_id: r.id, sport: r.sport, title: r.as_coach ? 'Coaching session' : 'Session with your coach', context: r.other_name, starts_at: r.starts_at, ends_at: r.ends_at, status: r.status === 'confirmed' ? 'confirmed' : 'proposed', action_required: r.as_coach && r.status === 'requested', link: { screen: 'Hub', params: {} }, actions: [] });
    for (const r of appts) add({ kind: 'health', source_type: 'appointment', source_id: r.id, title: r.provider_type === 'physio' ? 'Physio appointment' : r.provider_type === 'doctor' ? 'Doctor appointment' : 'Appointment', starts_at: r.starts_at, ends_at: r.ends_at, timezone: r.tz ?? 'UTC', status: r.status === 'confirmed' ? 'confirmed' : 'proposed', link: { screen: 'Health', params: {} }, actions: [] });
    for (const r of follows) add({ kind: 'health', source_type: 'followup', source_id: r.id, title: 'Health follow-up due', starts_at: `${r.due_on.toISOString?.().slice(0, 10) ?? r.due_on}T00:00:00Z`, ends_at: r.window_end ? `${r.window_end.toISOString?.().slice(0, 10) ?? r.window_end}T23:59:59Z` : null, all_day: true, status: 'awaiting_response', action_required: true, link: { screen: 'Health', params: {} }, actions: [] });

    let out = items.filter((x) => kinds.includes(x.kind) && (!i.sport || x.sport === i.sport));
    out.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || a.source_type.localeCompare(b.source_type) || a.source_id.localeCompare(b.source_id));
    // Overlap warning between timed commitments only; flagging never changes the underlying records.
    const timed = out.filter((x) => !x.all_day && x.ends_at);
    for (const a of timed) for (const b of timed) if (a !== b && new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at)) a.conflict = true;
    return { from, to, items: out, conflicts: out.filter((x) => x.conflict).length, action_required: out.filter((x) => x.action_required).length };
  },
});
