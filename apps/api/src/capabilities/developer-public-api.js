// Developer Platform (#569): governed canonical read-only public API endpoints.
// All handlers SELECT explicit columns (never SELECT *). No health/clinical tables are joined.
// Rate-limited per developer app. guardClinicalForDeveloperToken called on every handler
// that could transitively reach medical data (prophylactically on all).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { notFound } from '../errors.js';
import { guardClinicalForDeveloperToken } from '../scopes.js';
import { allowDeveloperCall, countDeveloperError } from '../integrations/developer-webhooks.js';

const TAG = 'Public API';

// Rate limit guard: call at the top of each public API handler
async function rateGuard(user) {
  guardClinicalForDeveloperToken(user?.credential);
  if (user?.credential?.type === 'oauth_token') {
    await allowDeveloperCall(user.credential.developer_app_id);
  }
}

cap({
  name: 'get_public_person',
  method: 'GET',
  path: '/public/people/:id',
  tag: TAG,
  scope: 'read',
  summary: 'Public profile: name, roles, sports and organisations. No PII, no health data.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await rateGuard(user);
    const row = await one(
      `SELECT p.id, p.display_name, p.country_code, p.sports, p.athlete_bio,
              array_agg(DISTINCT ur.role) FILTER (WHERE ur.role IS NOT NULL) AS roles,
              array_agg(DISTINCT json_build_object('id', o.id, 'name', o.name, 'type', o.type)) FILTER (WHERE o.id IS NOT NULL) AS organisations
         FROM people p
         LEFT JOIN user_roles ur ON ur.user_id = p.user_id AND ur.role NOT IN ('admin','platform_admin')
         LEFT JOIN organisation_members om ON om.user_id = p.user_id AND om.left IS NULL
         LEFT JOIN organisations o ON o.id = om.organisation_id
        WHERE p.id = $1 AND p.visibility = 'public'
        GROUP BY p.id`,
      [i.id],
    );
    if (!row) throw notFound('Person');
    return row;
  },
});

cap({
  name: 'get_public_organisation',
  method: 'GET',
  path: '/public/organisations/:id',
  tag: TAG,
  scope: 'read',
  summary: 'Public organisation profile: name, type, sports, country, member count.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await rateGuard(user);
    const row = await one(
      `SELECT o.id, o.name, o.type, o.sports, o.country_code, o.website_url, o.logo_url, o.description,
              (SELECT count(*) FROM organisation_members WHERE organisation_id=o.id AND left IS NULL) AS member_count
         FROM organisations o
        WHERE o.id = $1 AND o.visibility = 'public'`,
      [i.id],
    );
    if (!row) throw notFound('Organisation');
    return row;
  },
});

cap({
  name: 'list_public_teams',
  method: 'GET',
  path: '/public/teams',
  tag: TAG,
  scope: 'read',
  summary: 'Browse public teams with sport, competition and organisation filters.',
  input: z.object({
    ...page,
    sport: z.string().optional(),
    organisation_id: z.string().uuid().optional(),
    competition_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    await rateGuard(user);
    const rows = await many(
      `SELECT t.id, t.name, t.sport, t.age_group, t.gender, t.logo_url,
              t.organisation_id, o.name AS organisation_name
         FROM teams t
         JOIN organisations o ON o.id = t.organisation_id
        WHERE t.visibility = 'public'
          AND ($3::text IS NULL OR t.sport = $3)
          AND ($4::uuid IS NULL OR t.organisation_id = $4::uuid)
          AND ($5::uuid IS NULL OR t.competition_id = $5::uuid)
        ORDER BY t.name LIMIT $1 OFFSET $2`,
      [i.limit, i.offset, i.sport ?? null, i.organisation_id ?? null, i.competition_id ?? null],
    );
    return { items: rows };
  },
});

cap({
  name: 'get_public_team',
  method: 'GET',
  path: '/public/teams/:id',
  tag: TAG,
  scope: 'read',
  summary: 'Public team detail with public squad list.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await rateGuard(user);
    const team = await one(
      `SELECT t.id, t.name, t.sport, t.age_group, t.gender, t.logo_url, t.description,
              t.organisation_id, o.name AS organisation_name
         FROM teams t JOIN organisations o ON o.id = t.organisation_id
        WHERE t.id = $1 AND t.visibility = 'public'`,
      [i.id],
    );
    if (!team) throw notFound('Team');
    const squad = await many(
      `SELECT tm.id, p.display_name, tm.position, tm.shirt_number, tm.role
         FROM team_members tm JOIN people p ON p.user_id = tm.user_id
        WHERE tm.team_id = $1 AND p.visibility = 'public'`,
      [i.id],
    );
    return { ...team, squad };
  },
});

cap({
  name: 'list_public_competitions',
  method: 'GET',
  path: '/public/competitions',
  tag: TAG,
  scope: 'read',
  summary: 'Active and recent public competitions with sport and country filters.',
  input: z.object({ ...page, sport: z.string().optional(), country_code: z.string().length(2).optional(), status: z.enum(['upcoming', 'active', 'completed', 'all']).default('active') }),
  async handler({ user }, i) {
    await rateGuard(user);
    const rows = await many(
      `SELECT c.id, c.name, c.sport, c.format, c.country_code, c.start_date, c.end_date, c.status,
              c.organisation_id, o.name AS organisation_name, count(t.id) AS team_count
         FROM competitions c
         JOIN organisations o ON o.id = c.organisation_id
         LEFT JOIN competition_teams t ON t.competition_id = c.id
        WHERE c.visibility = 'public'
          AND ($3::text IS NULL OR c.sport = $3)
          AND ($4::text IS NULL OR c.country_code = $4)
          AND ($5 = 'all' OR c.status = $5)
        GROUP BY c.id, o.name
        ORDER BY c.start_date DESC LIMIT $1 OFFSET $2`,
      [i.limit, i.offset, i.sport ?? null, i.country_code ?? null, i.status],
    );
    return { items: rows };
  },
});

cap({
  name: 'get_public_competition',
  method: 'GET',
  path: '/public/competitions/:id',
  tag: TAG,
  scope: 'read',
  summary: 'Competition detail with standings and teams.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await rateGuard(user);
    const comp = await one(
      `SELECT c.id, c.name, c.sport, c.format, c.country_code, c.start_date, c.end_date, c.status, c.description, c.rules,
              c.organisation_id, o.name AS organisation_name
         FROM competitions c JOIN organisations o ON o.id = c.organisation_id
        WHERE c.id = $1 AND c.visibility = 'public'`,
      [i.id],
    );
    if (!comp) throw notFound('Competition');
    const teams = await many(
      `SELECT ct.id, t.id AS team_id, t.name, t.logo_url, ct.group_name, ct.standing_points, ct.standing_rank
         FROM competition_teams ct JOIN teams t ON t.id = ct.team_id
        WHERE ct.competition_id = $1 ORDER BY ct.standing_rank NULLS LAST`,
      [i.id],
    );
    return { ...comp, teams };
  },
});

cap({
  name: 'list_public_fixtures',
  method: 'GET',
  path: '/public/fixtures',
  tag: TAG,
  scope: 'read',
  summary: 'Public fixtures with optional competition, team, venue and date filters.',
  input: z.object({
    ...page,
    competition_id: z.string().uuid().optional(),
    team_id: z.string().uuid().optional(),
    venue_id: z.string().uuid().optional(),
    from_date: z.string().date().optional(),
    to_date: z.string().date().optional(),
    status: z.enum(['scheduled', 'in_progress', 'completed', 'postponed', 'cancelled', 'all']).default('all'),
  }),
  async handler({ user }, i) {
    await rateGuard(user);
    const rows = await many(
      `SELECT f.id, f.competition_id, f.round, f.match_day, f.scheduled_at, f.status, f.venue_id,
              v.name AS venue_name,
              ht.id AS home_team_id, ht.name AS home_team_name, ht.logo_url AS home_logo,
              at2.id AS away_team_id, at2.name AS away_team_name, at2.logo_url AS away_logo,
              f.home_score, f.away_score, f.result_status
         FROM fixtures f
         LEFT JOIN venues v ON v.id = f.venue_id
         LEFT JOIN teams ht ON ht.id = f.home_team_id
         LEFT JOIN teams at2 ON at2.id = f.away_team_id
        WHERE f.visibility = 'public'
          AND ($3::uuid IS NULL OR f.competition_id = $3::uuid)
          AND ($4::uuid IS NULL OR f.home_team_id = $4::uuid OR f.away_team_id = $4::uuid)
          AND ($5::uuid IS NULL OR f.venue_id = $5::uuid)
          AND ($6::date IS NULL OR f.scheduled_at::date >= $6::date)
          AND ($7::date IS NULL OR f.scheduled_at::date <= $7::date)
          AND ($8 = 'all' OR f.status = $8)
        ORDER BY f.scheduled_at DESC LIMIT $1 OFFSET $2`,
      [i.limit, i.offset, i.competition_id ?? null, i.team_id ?? null, i.venue_id ?? null, i.from_date ?? null, i.to_date ?? null, i.status],
    );
    return { items: rows };
  },
});

cap({
  name: 'get_public_fixture',
  method: 'GET',
  path: '/public/fixtures/:id',
  tag: TAG,
  scope: 'read',
  summary: 'Full fixture detail with score and result.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await rateGuard(user);
    const row = await one(
      `SELECT f.id, f.competition_id, f.round, f.match_day, f.scheduled_at, f.status, f.venue_id,
              v.name AS venue_name, v.address AS venue_address,
              ht.id AS home_team_id, ht.name AS home_team_name, ht.logo_url AS home_logo,
              at2.id AS away_team_id, at2.name AS away_team_name, at2.logo_url AS away_logo,
              f.home_score, f.away_score, f.result_status, f.result_detail
         FROM fixtures f
         LEFT JOIN venues v ON v.id = f.venue_id
         LEFT JOIN teams ht ON ht.id = f.home_team_id
         LEFT JOIN teams at2 ON at2.id = f.away_team_id
        WHERE f.id = $1 AND f.visibility = 'public'`,
      [i.id],
    );
    if (!row) throw notFound('Fixture');
    return row;
  },
});

cap({
  name: 'list_public_events',
  method: 'GET',
  path: '/public/events',
  tag: TAG,
  scope: 'read',
  summary: 'Published public events with sport, venue and date filters.',
  input: z.object({
    ...page,
    sport: z.string().optional(),
    venue_id: z.string().uuid().optional(),
    organisation_id: z.string().uuid().optional(),
    from_date: z.string().date().optional(),
    to_date: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    await rateGuard(user);
    const rows = await many(
      `SELECT e.id, e.name, e.sport, e.type, e.starts_at, e.ends_at, e.status,
              e.organisation_id, o.name AS organisation_name,
              e.venue_id, v.name AS venue_name,
              e.registration_open, e.registration_deadline, e.capacity, e.registrations_count
         FROM events e
         LEFT JOIN organisations o ON o.id = e.organisation_id
         LEFT JOIN venues v ON v.id = e.venue_id
        WHERE e.status = 'published' AND e.visibility = 'public'
          AND ($3::text IS NULL OR e.sport = $3)
          AND ($4::uuid IS NULL OR e.venue_id = $4::uuid)
          AND ($5::uuid IS NULL OR e.organisation_id = $5::uuid)
          AND ($6::date IS NULL OR e.starts_at::date >= $6::date)
          AND ($7::date IS NULL OR e.starts_at::date <= $7::date)
        ORDER BY e.starts_at LIMIT $1 OFFSET $2`,
      [i.limit, i.offset, i.sport ?? null, i.venue_id ?? null, i.organisation_id ?? null, i.from_date ?? null, i.to_date ?? null],
    );
    return { items: rows };
  },
});

cap({
  name: 'get_public_event',
  method: 'GET',
  path: '/public/events/:id',
  tag: TAG,
  scope: 'read',
  summary: 'Full public event detail with schedule and registration info.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await rateGuard(user);
    const row = await one(
      `SELECT e.id, e.name, e.sport, e.type, e.description, e.starts_at, e.ends_at, e.status,
              e.organisation_id, o.name AS organisation_name, o.logo_url AS org_logo,
              e.venue_id, v.name AS venue_name, v.address AS venue_address, v.latitude, v.longitude,
              e.registration_open, e.registration_deadline, e.capacity, e.registrations_count, e.entry_fee
         FROM events e
         LEFT JOIN organisations o ON o.id = e.organisation_id
         LEFT JOIN venues v ON v.id = e.venue_id
        WHERE e.id = $1 AND e.status = 'published' AND e.visibility = 'public'`,
      [i.id],
    );
    if (!row) throw notFound('Event');
    return row;
  },
});

cap({
  name: 'list_public_venues',
  method: 'GET',
  path: '/public/venues',
  tag: TAG,
  scope: 'read',
  summary: 'Venue catalogue with sport, country and name search filters.',
  input: z.object({
    ...page,
    sport: z.string().optional(),
    country_code: z.string().length(2).optional(),
    q: z.string().max(120).optional(),
  }),
  async handler({ user }, i) {
    await rateGuard(user);
    const rows = await many(
      `SELECT v.id, v.name, v.type, v.sports, v.country_code, v.city, v.address,
              v.latitude, v.longitude, v.capacity, v.photo_url, v.website_url
         FROM venues v
        WHERE v.visibility = 'public'
          AND ($3::text IS NULL OR $3 = ANY(v.sports))
          AND ($4::text IS NULL OR v.country_code = $4)
          AND ($5::text IS NULL OR v.name ILIKE '%' || $5 || '%')
        ORDER BY v.name LIMIT $1 OFFSET $2`,
      [i.limit, i.offset, i.sport ?? null, i.country_code ?? null, i.q ?? null],
    );
    return { items: rows };
  },
});

cap({
  name: 'get_public_venue',
  method: 'GET',
  path: '/public/venues/:id',
  tag: TAG,
  scope: 'read',
  summary: 'Full venue detail including courts, facilities and open hours.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await rateGuard(user);
    const row = await one(
      `SELECT v.id, v.name, v.type, v.sports, v.country_code, v.city, v.address,
              v.latitude, v.longitude, v.capacity, v.photo_url, v.website_url, v.description,
              v.open_hours, v.amenities, v.accessibility_notes
         FROM venues v WHERE v.id = $1 AND v.visibility = 'public'`,
      [i.id],
    );
    if (!row) throw notFound('Venue');
    const courts = await many(
      `SELECT id, name, sport, surface, indoor, capacity, photo_url FROM courts WHERE venue_id=$1 AND visibility='public' ORDER BY name`,
      [i.id],
    );
    return { ...row, courts };
  },
});

cap({
  name: 'list_public_registrations',
  method: 'GET',
  path: '/public/events/:event_id/registrations',
  tag: TAG,
  scope: 'read',
  summary: 'Public registrations for an event: team/individual name, category, status. No personal details.',
  input: z.object({ event_id: id, ...page }),
  async handler({ user }, i) {
    await rateGuard(user);
    const event = await one("SELECT id, visibility FROM events WHERE id=$1 AND status='published'", [i.event_id]);
    if (!event || event.visibility !== 'public') throw notFound('Event');
    const rows = await many(
      `SELECT r.id, r.category, r.status, r.registered_at,
              CASE WHEN r.team_id IS NOT NULL THEN t.name ELSE p.display_name END AS entry_name,
              r.team_id, r.bib_number
         FROM registrations r
         LEFT JOIN teams t ON t.id = r.team_id
         LEFT JOIN people p ON p.user_id = r.user_id AND p.visibility = 'public'
        WHERE r.event_id = $1 AND r.status NOT IN ('cancelled','withdrawn')
        ORDER BY r.registered_at LIMIT $2 OFFSET $3`,
      [i.event_id, i.limit, i.offset],
    );
    return { items: rows };
  },
});
