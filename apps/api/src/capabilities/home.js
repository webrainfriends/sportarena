import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { PUBLIC_USER } from '../helpers.js';
import { NOT_YOUTH_SQL } from '../youth.js';

cap({
  name: 'get_home_feed', method: 'GET', path: '/feed', tag: 'Discover', auth: 'public',
  summary: 'Home screen payload: upcoming events, next games, top athletes, latest trophies, platform counters.',
  async handler() {
    const [events, games, athletes, awards, stats] = await Promise.all([
      many("SELECT e.id, e.name, e.banner_emoji, e.kind, e.starts_on, s.name AS sport, s.emoji AS sport_emoji FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.status IN ('open','ongoing') ORDER BY e.starts_on NULLS LAST LIMIT 6"),
      many("SELECT f.id, f.scheduled_at, f.status, f.home_score, f.away_score, h.name AS home_name, h.emoji AS home_emoji, a.name AS away_name, a.emoji AS away_emoji, e.name AS event_name FROM fixtures f JOIN events e ON e.id=f.event_id JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id WHERE f.status IN ('scheduled','live') AND f.scheduled_at > now() - interval '3 hours' ORDER BY f.scheduled_at LIMIT 6"),
      many(`SELECT ${PUBLIC_USER}, sum(p.points) AS points FROM performances p JOIN users u ON u.id=p.user_id WHERE ${NOT_YOUTH_SQL} GROUP BY u.id ORDER BY points DESC LIMIT 5`),
      many('SELECT a.id, a.name, a.kind, a.awarded_at, t.name AS team_name, u.display_name FROM awards a LEFT JOIN teams t ON t.id=a.team_id LEFT JOIN users u ON u.id=a.user_id ORDER BY a.awarded_at DESC LIMIT 5'),
      one('SELECT (SELECT count(*)::int FROM users) AS people, (SELECT count(*)::int FROM teams) AS teams, (SELECT count(*)::int FROM events) AS events, (SELECT count(*)::int FROM venues) AS venues'),
    ]);
    return { events, games, top_athletes: athletes, latest_awards: awards, stats };
  },
});

cap({
  name: 'get_dashboard', method: 'GET', path: '/dashboard', tag: 'Discover',
  summary: 'Your personal dashboard: teams, next games, bookings, points, trophies, insurance status, fit-to-play.',
  async handler({ user }) {
    const [teams, games, bookings, pts, awards, policies, clearance, events] = await Promise.all([
      many("SELECT t.id, t.name, t.emoji, t.color, m.role FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 AND m.status='active'", [user.id]),
      many("SELECT f.id, f.scheduled_at, h.name AS home_name, a.name AS away_name, e.name AS event_name FROM fixtures f JOIN events e ON e.id=f.event_id JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id WHERE f.status='scheduled' AND f.scheduled_at > now() AND (f.referee_id=$1 OR f.home_team_id IN (SELECT team_id FROM team_members WHERE user_id=$1 AND status='active') OR f.away_team_id IN (SELECT team_id FROM team_members WHERE user_id=$1 AND status='active')) ORDER BY f.scheduled_at LIMIT 5", [user.id]),
      many("SELECT b.id, b.starts_at, b.ends_at, r.name AS resource_name, v.name AS venue_name FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN venues v ON v.id=r.venue_id WHERE b.user_id=$1 AND b.status='confirmed' AND b.ends_at > now() ORDER BY b.starts_at LIMIT 5", [user.id]),
      one('SELECT coalesce(sum(points),0) AS points, count(*)::int AS entries FROM performances WHERE user_id=$1', [user.id]),
      one('SELECT count(*)::int AS n FROM awards WHERE user_id=$1 OR team_id IN (SELECT team_id FROM team_members WHERE user_id=$1)', [user.id]),
      one("SELECT count(*)::int AS active FROM insurance_policies WHERE holder_id=$1 AND status='active' AND ends_on >= current_date", [user.id]),
      one('SELECT clearance FROM medical_records WHERE athlete_id=$1 AND clearance IS NOT NULL ORDER BY created_at DESC LIMIT 1', [user.id]),
      many("SELECT id, name, status, banner_emoji FROM events WHERE organizer_id=$1 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 5", [user.id]),
    ]);
    return { user, teams, next_games: games, bookings, points: pts.points, score_entries: pts.entries, trophies: awards.n, active_policies: policies.active, fit_to_play: clearance?.clearance ?? 'unknown', my_events: events };
  },
});
