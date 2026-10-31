// Find & Join Games (issue #508). One capability set: host a game from a real venue/booking, discover it, request/join/waitlist, matching with
// explicit reasons, a temporary game chat, check-in/attendance with appealable facts, and youth/guardian-aware flows.
// It extends the existing records instead of copying them: the game is a `games` row, the venue state is read from `bookings`,
// players are found from `sport_profiles` + `availability_windows`, notifications go through `notify`, and a confirmed attendee
// becomes a `game_participants` row (which feeds the sports history the same way a fixture does).
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, PUBLIC_USER, sportBySlugOrId } from '../helpers.js';
import { notify } from '../notify.js';
import { badgesFor } from '../verification.js';
import { NOT_YOUTH_SQL, YOUTH_SQL, hasConsent, isYouth, requireConsent, requireGuardian, guardianLink } from '../youth.js';
import { canManageGame } from './games.js';
import { canManageTeam } from './teams.js';
import { canManage as canManageVenue } from '../booking/engine.js';
import { validTimezone } from '../booking/time.js';
import { CURRENCIES } from '../currency.js';
import { reliableLevels } from '../ratings/data.js';
import {
  CHECK_IN_EARLY_MIN, LEVELS, LEVEL_LABEL, assertCanPlay, bookingStateSql, chatClosesAt, endOf, levelFit, levelFor,
  lockOpenGame, notifyAll, notifyMember, nudgeHost, promoteWaitlist, seatsTaken, shareFor, whenWindow,
} from '../open-games.js';

const TAG = 'Find & Join Games';
const dt = z.string().datetime({ offset: true });
const level = z.enum(LEVELS);
const currency = z.string().length(3).transform((x) => x.toUpperCase()).refine((x) => Object.hasOwn(CURRENCIES, x), 'Unsupported currency');

const managesOpen = async (user, og, g) => {
  if (isAdmin(user) || og.host_id === user.id || (await canManageGame(user, g))) return true;
  return og.team_id ? canManageTeam(user, await one('SELECT * FROM teams WHERE id=$1', [og.team_id])) : false;
};

// ---------------------------------------------------------------- reading

// the host as host_* columns; platform roles are filtered inside PUBLIC_USER, so alias each expression rather than rewriting it
const HOST_USER = PUBLIC_USER.split(', ').map((x) => (/ AS (\w+)$/.test(x) ? x.replace(/u\./g, 'h.').replace(/ AS (\w+)$/, ' AS host_$1') : `${x.replace('u.', 'h.')} AS host_${x.slice(2)}`)).join(', ');
const CARD_COLS = `og.id, og.game_id, og.team_id, og.fixture_game_id, og.visibility, og.approval_mode, og.min_players, og.max_players, og.skill_min, og.skill_max, og.format, og.role_needs,
  og.audience, og.min_age, og.max_age, og.cost_mode, og.cost_cents, og.currency, og.cancel_before_hours, og.notes, og.status, og.place_city,
  g.title, g.starts_at, g.ends_at, g.location, g.venue_id, g.resource_id, s.id AS sport_id, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji,
  v.name AS venue_name, v.city AS venue_city, v.timezone AS venue_timezone, coalesce(v.latitude, og.place_latitude) AS lat, coalesce(v.longitude, og.place_longitude) AS lng,
  ${bookingStateSql} AS booking_state, og.booking_id,
  (SELECT count(*)::int FROM open_game_members m WHERE m.open_game_id=og.id AND m.status='confirmed') AS taken,
  (SELECT count(*)::int FROM open_game_members m WHERE m.open_game_id=og.id AND m.status='waitlisted') AS waitlist,
  (t.id IS NOT NULL) AS has_team, t.name AS team_name, t.emoji AS team_emoji,
  ${HOST_USER}`;
const CARD_FROM = `FROM open_games og JOIN games g ON g.id=og.game_id JOIN sports s ON s.id=g.sport_id JOIN users h ON h.id=og.host_id
  LEFT JOIN venues v ON v.id=g.venue_id LEFT JOIN bookings b ON b.id=og.booking_id LEFT JOIN teams t ON t.id=og.team_id`;

/** Public shape of a card: the host as a nested public user, venue/place only, never a participant's address, calendar or contact. */
function shape(r, badges, me) {
  const { host_id, host_handle, host_display_name, host_roles, host_bio, host_avatar_emoji, host_avatar_color, host_avatar_url, lat, lng, fits_availability: _fit, ...rest } = r;
  const slots_left = Math.max(0, r.max_players - r.taken);
  return {
    ...rest, slots_left, is_full: slots_left === 0, needs_players: Math.max(0, r.min_players - r.taken),
    host: { id: host_id, handle: host_handle, display_name: host_display_name, avatar_emoji: host_avatar_emoji, avatar_color: host_avatar_color, avatar_url: host_avatar_url, verified: (badges.get(host_id) ?? []).length > 0 },
    place: { venue_id: r.venue_id, name: r.venue_name ?? r.location, city: r.venue_city ?? r.place_city, latitude: lat, longitude: lng },
    skill: { min: r.skill_min, max: r.skill_max, label: skillLabel(r.skill_min, r.skill_max) },
    cost: { mode: r.cost_mode, per_player_cents: r.cost_mode === 'per_player' ? Number(r.cost_cents) : r.cost_mode === 'split_total' ? Math.ceil(Number(r.cost_cents) / r.max_players) : 0, total_cents: Number(r.cost_cents), currency: r.currency },
    is_mine: me ? host_id === me.id : false,
  };
}
const lvl = (p) => (p.skill_level ? `Level ${p.skill_level.toFixed(1)}` : `${LEVEL_LABEL[p.level]} level`);
const skillLabel = (lo, hi) => (!lo && !hi ? 'All levels' : lo && hi ? (lo === hi ? LEVEL_LABEL[lo] : `${LEVEL_LABEL[lo]} to ${LEVEL_LABEL[hi]}`) : lo ? `${LEVEL_LABEL[lo]}+` : `Up to ${LEVEL_LABEL[hi]}`);

/** Who may see this game at all. A link game is visible to whoever holds the id; a team game only to its team. */
async function visibleTo(user, og) {
  if (og.visibility !== 'team') return true;
  if (!user) return false;
  if (og.host_id === user.id || isAdmin(user)) return true;
  return !!(og.team_id && (await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [og.team_id, user.id])));
}

async function loadCard(openGameId, user) {
  const r = await one(`SELECT ${CARD_COLS} ${CARD_FROM} WHERE og.id=$1`, [openGameId]);
  if (!r) throw notFound('Game');
  return { row: r, card: shape(r, await badgesFor('user', [r.host_id]), user) };
}

const FACTS_SQL = `SELECT m.user_id,
    count(*) FILTER (WHERE m.attendance='attended')::int AS games_played,
    count(*) FILTER (WHERE m.attendance='no_show')::int AS no_shows,
    count(*) FILTER (WHERE m.late_cancel)::int AS late_cancellations,
    (SELECT count(*)::int FROM open_game_appeals a JOIN open_game_members x ON x.id=a.member_id WHERE x.user_id=m.user_id AND a.status='open') AS under_review
  FROM open_game_members m WHERE m.user_id = ANY($1::uuid[]) GROUP BY m.user_id`;
const factsFor = async (ids) => {
  const rows = ids.length ? await many(FACTS_SQL, [ids]) : [];
  return (uid) => rows.find((x) => x.user_id === uid) ?? { user_id: uid, games_played: 0, no_shows: 0, late_cancellations: 0, under_review: 0 };
};

// ---------------------------------------------------------------- hosting

/** The terms of a game. A new game gets defaults; an edit leaves unsent fields alone, so defaults must not apply there. */
const termsShape = (isNew) => {
  const d = (schema, v) => (isNew ? schema.default(v) : schema.optional());
  return {
    title: z.string().trim().min(2).max(120).optional(),
    starts_at: isNew ? dt : dt.optional(), duration_minutes: d(z.number().int().min(15).max(720), 90),
    venue_id: id.optional(), resource_id: id.optional(),
    location: z.string().trim().max(120).optional().describe('a public place such as a park or ground when there is no venue — never a home address'),
    place_latitude: z.number().min(-90).max(90).optional(), place_longitude: z.number().min(-180).max(180).optional(), place_city: z.string().trim().max(80).optional(),
    min_players: d(z.number().int().min(1).max(500), 2), max_players: isNew ? z.number().int().min(1).max(500) : z.number().int().min(1).max(500).optional(),
    skill_min: level.nullable().optional(), skill_max: level.nullable().optional(), format: z.string().trim().max(40).nullable().optional(), role_needs: d(z.array(z.string().trim().min(1).max(40)).max(10), []),
    audience: d(z.enum(['adults', 'all_ages', 'youth']), 'adults'), min_age: z.number().int().min(0).max(120).nullable().optional(), max_age: z.number().int().min(0).max(120).nullable().optional(),
    cost_mode: d(z.enum(['free', 'per_player', 'split_total']), 'free'), cost_cents: d(money, 0), currency: d(currency, 'INR'),
    cancel_before_hours: d(z.number().int().min(0).max(720), 6), approval_mode: d(z.enum(['auto', 'host']), 'host'),
    visibility: d(z.enum(['public', 'team', 'link']), 'public'), notes: z.string().trim().max(500).nullable().optional(),
  };
};
const hostInput = z.object({
  sport: z.string().describe('sport slug or id'), ...termsShape(true),
  booking_id: id.optional().describe('your confirmed booking of this slot (book it first through create_reservation); the game then shows the live booking state'),
  team_id: id.optional().describe('a team you manage that is hosting or needs players'), fixture_game_id: id.optional().describe('the fixture you need players for'),
  host_plays: z.boolean().default(true),
});

/** A booking can back a game when it is yours (or your team's), confirmed, and covers the game's time. */
async function checkBooking(c, user, bookingId, startsAt, endsAt, sportId, ownGameId = null) {
  const b = (await c.query(
    `SELECT b.*, r.venue_id AS r_venue, r.sport_id AS r_sport, rs.user_id AS owner_id FROM bookings b JOIN resources r ON r.id=b.resource_id LEFT JOIN reservations rs ON rs.id=b.reservation_id WHERE b.id=$1`, [bookingId])).rows[0];
  if (!b) throw notFound('Booking');
  if (b.user_id !== user.id && b.owner_id !== user.id && !isAdmin(user) && !(await canManageVenue(user, b.r_venue, c))) throw forbidden('That booking is not yours');
  if (b.status !== 'confirmed') throw conflict('That booking is not confirmed', { code: 'booking_not_confirmed' });
  if (new Date(b.starts_at) > new Date(startsAt) || new Date(b.ends_at) < new Date(endsAt)) throw conflict('The booking does not cover the whole game time', { code: 'booking_window' });
  if (b.r_sport && sportId && b.r_sport !== sportId) throw badRequest('That court is for a different sport');
  const taken = (await c.query("SELECT 1 FROM open_games WHERE booking_id=$1 AND status<>'cancelled' AND id IS DISTINCT FROM $2", [bookingId, ownGameId])).rows[0];
  if (taken) throw conflict('That booking already backs another game', { code: 'booking_in_use' });
  return b;
}

cap({
  name: 'host_open_game', method: 'POST', path: '/open-games', tag: TAG, status: 201,
  summary: 'Host an open game anyone can ask to join: a sport, date/time/duration, a venue or public place, how many players you need, the level and role you want, an age audience, who pays what, how people are approved, who can see it and the cancellation rule. Link your confirmed booking with booking_id (book the slot first with create_reservation) — an open game never holds a slot by itself. A team you manage can host or post "need players" for a fixture. Hosting does not make anyone a member of a team.',
  input: hostInput,
  async handler({ user }, i) {
    if (await isYouth(user.id)) throw forbidden('A young person cannot host a game; ask a guardian or coach to host it');
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    if (Date.parse(i.starts_at) <= Date.now()) throw badRequest('The game must start in the future');
    if (i.max_players < i.min_players) throw badRequest('max_players is below min_players');
    if (i.skill_min && i.skill_max && LEVELS.indexOf(i.skill_min) > LEVELS.indexOf(i.skill_max)) throw badRequest('skill_min is above skill_max');
    if (i.min_age != null && i.max_age != null && i.min_age > i.max_age) throw badRequest('min_age is above max_age');
    if (i.cost_mode !== 'free' && !(i.cost_cents > 0)) throw badRequest('Give the amount for a paid game');
    if ((i.place_latitude == null) !== (i.place_longitude == null)) throw badRequest('place_latitude and place_longitude go together');
    const ends = new Date(+new Date(i.starts_at) + i.duration_minutes * 6e4);
    return tx(async (c) => {
      let venueId = i.venue_id ?? null, resourceId = i.resource_id ?? null;
      if (resourceId) {
        const r = (await c.query('SELECT * FROM resources WHERE id=$1 AND active', [resourceId])).rows[0];
        if (!r) throw notFound('Court');
        if (venueId && venueId !== r.venue_id) throw badRequest('resource_id is not part of venue_id');
        if (r.sport_id && r.sport_id !== sport.id) throw badRequest('That court is for a different sport');
        venueId = r.venue_id;
      }
      if (venueId && !(await c.query('SELECT 1 FROM venues WHERE id=$1 AND active', [venueId])).rows[0]) throw notFound('Venue');
      if (i.booking_id) {
        const b = await checkBooking(c, user, i.booking_id, i.starts_at, ends, sport.id);
        resourceId = resourceId ?? b.resource_id; venueId = venueId ?? b.r_venue;
        if (resourceId !== b.resource_id) throw badRequest('The booking is for a different court');
      }
      if (!venueId && !i.location) throw badRequest('Say where: pick a venue or name a public place', { code: 'place_required' });
      if (i.team_id) {
        const t = (await c.query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
        if (!t) throw notFound('Team');
        if (!(await canManageTeam(user, t))) throw forbidden('You do not manage that team');
        if (t.sport_id !== sport.id) throw badRequest('That team plays a different sport');
      }
      if (i.visibility === 'team' && !i.team_id) throw badRequest('A team-only game needs a team');
      if (i.fixture_game_id) {
        const f = (await c.query('SELECT * FROM games WHERE id=$1', [i.fixture_game_id])).rows[0];
        if (!f) throw notFound('Fixture');
        if (f.sport_id !== sport.id) throw badRequest('The fixture is a different sport');
        if (!(await canManageGame(user, f))) throw forbidden('You do not manage that fixture');
      }
      const title = i.title ?? `${sport.name} at ${i.location ?? (await c.query('SELECT name FROM venues WHERE id=$1', [venueId])).rows[0]?.name ?? 'a local ground'}`;
      const g = (await c.query("INSERT INTO games(sport_id, created_by, title, status, venue_id, resource_id, location, starts_at, ends_at) VALUES ($1,$2,$3,'pre-event',$4,$5,$6,$7,$8) RETURNING *",
        [sport.id, user.id, title, venueId, resourceId, i.location ?? null, i.starts_at, ends])).rows[0];
      await c.query("INSERT INTO associations(user_id, role, target_type, target_id, status, started_at) VALUES ($1,'organizer','game',$2,'active',now())", [user.id, g.id]);
      const og = (await c.query(
        `INSERT INTO open_games(game_id, host_id, team_id, fixture_game_id, booking_id, visibility, approval_mode, min_players, max_players, host_plays, skill_min, skill_max, format, role_needs, audience, min_age, max_age,
            cost_mode, cost_cents, currency, cancel_before_hours, notes, place_latitude, place_longitude, place_city, last_synced_starts_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
        [g.id, user.id, i.team_id ?? null, i.fixture_game_id ?? null, i.booking_id ?? null, i.visibility, i.approval_mode, i.min_players, i.max_players, i.host_plays, i.skill_min ?? null, i.skill_max ?? null, i.format ?? null,
          i.role_needs, i.audience, i.min_age ?? null, i.max_age ?? null, i.cost_mode, i.cost_mode === 'free' ? 0 : i.cost_cents, i.currency, i.cancel_before_hours, i.notes ?? null,
          i.place_latitude ?? null, i.place_longitude ?? null, i.place_city ?? null, i.starts_at])).rows[0];
      if (i.host_plays) await c.query("INSERT INTO open_game_members(open_game_id, user_id, status, approved) VALUES ($1,$2,'confirmed',true)", [og.id, user.id]);
      return { id: og.id, game_id: g.id };
    }).then((r) => getDetail(r.id, user));
  },
});

/** The full game: card + people + what the viewer can do. Hosts also get the request list ranked by explicit, visible criteria. */
async function getDetail(openGameId, user) {
  const { row, card } = await loadCard(openGameId, user);
  if (!(await visibleTo(user, row))) throw notFound('Game');
  const g = await one('SELECT * FROM games WHERE id=$1', [row.game_id]);
  const mine = user ? await many(`SELECT m.id, m.user_id, m.applied_by, m.status, m.approved, m.position, m.share_status, m.share_cents, m.attendance, m.checked_in_at, m.late_cancel,
    (SELECT row_to_json(a) FROM (SELECT x.id, x.fact, x.status FROM open_game_appeals x WHERE x.member_id=m.id ORDER BY x.created_at DESC LIMIT 1) a) AS appeal
    FROM open_game_members m WHERE m.open_game_id=$1 AND (m.user_id=$2 OR m.applied_by=$2)`, [row.id, user.id]) : [];
  const isManager = !!user && (await managesOpen(user, row, g));
  const roster = await many(
    `SELECT m.id AS member_id, m.position, ${PUBLIC_USER} FROM open_game_members m JOIN users u ON u.id=m.user_id
      WHERE m.open_game_id=$1 AND m.status='confirmed' AND ${NOT_YOUTH_SQL} ORDER BY m.created_at, m.id`, [row.id]);
  const youthCount = Number((await one(`SELECT count(*) AS n FROM open_game_members m JOIN users u ON u.id=m.user_id WHERE m.open_game_id=$1 AND m.status='confirmed' AND ${YOUTH_SQL}`, [row.id])).n);
  const booking = row.booking_id ? await one('SELECT b.id, b.status, b.starts_at, b.ends_at, rs.id AS reservation_id, rs.code FROM bookings b LEFT JOIN reservations rs ON rs.id=b.reservation_id WHERE b.id=$1', [row.booking_id]) : null;
  const closes = chatClosesAt(g);
  const chatAccess = user ? await chatRole(user, row) : null;
  const out = {
    ...card, roster, other_players: youthCount, my: mine,
    booking: booking && { booking_id: booking.id, reservation_id: booking.reservation_id, code: booking.code, status: booking.status },
    venue_hint: card.booking_state === 'confirmed' || card.status !== 'open' ? null : { needs: card.booking_state === 'cancelled' ? 'rebook' : 'book', sport: card.sport_slug, available_from: g.starts_at, available_to: endOf(g), use: 'list_venues, then create_reservation, then update_open_game with booking_id' },
    chat: { available: !!chatAccess, open: !!chatAccess && new Date() < closes && card.status === 'open', closes_at: closes },
    can_manage: isManager,
  };
  if (isManager) {
    const members = await many(
      `SELECT m.*, (SELECT row_to_json(a) FROM (SELECT x.id, x.fact, x.reason FROM open_game_appeals x WHERE x.member_id=m.id AND x.status='open' ORDER BY x.created_at DESC LIMIT 1) a) AS open_appeal, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, ${YOUTH_SQL} AS is_youth FROM open_game_members m JOIN users u ON u.id=m.user_id WHERE m.open_game_id=$1 AND (m.status <> 'cancelled' OR m.late_cancel) ORDER BY m.created_at, m.id`, [row.id]);
    const facts = await factsFor(members.map((m) => m.user_id));
    const badges = await badgesFor('user', members.map((m) => m.user_id));
    const rows = [];
    for (const m of members) {
      const lv = await levelFor({ query }, m.user_id, row.sport_id);
      const fit = levelFit(row, lv);
      const f = facts(m.user_id);
      const verified = (badges.get(m.user_id) ?? []).length > 0;
      const role_match = !!(m.position && row.role_needs.some((r) => r.toLowerCase() === m.position.toLowerCase()));
      const rank = (fit === 'fits' ? 2 : fit === 'open' ? 1 : 0) + (role_match ? 2 : 0) + (verified ? 1 : 0);
      rows.push({
        member_id: m.id, user_id: m.user_id, status: m.status, approved: m.approved, position: m.position, message: m.message, requested_at: m.created_at, share_status: m.share_status, share_cents: Number(m.share_cents),
        attendance: m.attendance, checked_in_at: m.checked_in_at, late_cancel: m.late_cancel, applied_by_guardian: !!m.applied_by, open_appeal: m.open_appeal,
        person: m.is_youth ? { display_name: m.display_name, is_youth: true } : { handle: m.handle, display_name: m.display_name, avatar_emoji: m.avatar_emoji, avatar_color: m.avatar_color, is_youth: false },
        fit: { level: lv, level_fit: fit, role_match, verified, rank }, facts: { games_played: f.games_played, no_shows: f.no_shows, late_cancellations: f.late_cancellations, under_review: f.under_review },
      });
    }
    out.members = rows;
    out.rank_criteria = ['level fit (your stated range)', 'role you asked for', 'verified identity', 'then first come first served'];
    out.requests = rows.filter((m) => ['requested', 'waitlisted', 'guardian_pending'].includes(m.status)).sort((a, b) => b.fit.rank - a.fit.rank || (a.requested_at < b.requested_at ? -1 : 1));
  }
  return out;
}

cap({
  name: 'get_open_game', method: 'GET', path: '/open-games/:id', tag: TAG, auth: 'public',
  summary: 'One open game: when/where, seats left, level, cost per player, host, the live state of its venue booking, adult players who have joined (young players are only counted), and — for the host — the request list ranked by visible criteria with each person\'s factual history. Shows only the venue or public place, never a participant\'s address, calendar or contact details.',
  input: z.object({ id }), handler: ({ user }, i) => getDetail(i.id, user),
});

// ---------------------------------------------------------------- discovery

cap({
  name: 'find_open_games', method: 'GET', path: '/open-games', tag: TAG, auth: 'public',
  summary: 'Find games to play: filter by sport, when (now / today / tomorrow / weekend / this week, in your time zone) or dates, distance from a point you send (never stored), level, format, cost, free seats, verified host or team. sort=best_match (signed in) ranks by your sport profiles, level and weekly availability and says why each game was suggested. mine=true lists games you host or hold a place in.',
  input: z.object({
    sport: z.string().optional(), when: z.enum(['now', 'today', 'tomorrow', 'weekend', 'week']).optional(), tz: z.string().max(60).default('UTC'), from: dt.optional(), to: dt.optional(),
    lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), radius_km: z.coerce.number().min(0.5).max(20000).optional(),
    level: level.optional().describe('only games whose level range includes this level'), format: z.string().max(40).optional(), max_cost_cents: z.coerce.number().int().min(0).optional(), free_only: z.coerce.boolean().optional(),
    has_slots: z.coerce.boolean().optional(), verified_host: z.coerce.boolean().optional(), team_id: id.optional(), host_id: id.optional(), audience: z.enum(['adults', 'all_ages', 'youth']).optional(),
    q: z.string().max(80).optional(), mine: z.coerce.boolean().optional(), sort: z.enum(['soonest', 'distance', 'best_match']).default('soonest'), ...page,
  }).refine((i) => (i.lat == null) === (i.lng == null), 'lat and lng go together'),
  async handler({ user }, i) {
    if ((i.sort === 'distance') && i.lat == null) throw badRequest('sort=distance needs lat and lng');
    if (i.sort === 'best_match' && !user) throw forbidden('Sign in to get matches');
    if (i.mine && !user) throw forbidden('Sign in to see your games');
    const sport = i.sport ? await sportBySlugOrId(i.sport) : null;
    if (i.sport && !sport) throw notFound('Sport');
    let { from, to } = i;
    if (i.when) ({ from, to } = whenWindow(i.when, i.tz));
    else if (!validTimezone(i.tz)) throw badRequest('Unknown time zone');
    const uid = user?.id ?? null;
    // young players' games are for young players and their guardians; a young player is not shown adult-only games they cannot join
    const viewerYouth = !!user && (await isYouth(user.id));
    const showYouth = viewerYouth || i.audience === 'youth' || (!!user && !!(await one("SELECT 1 FROM guardian_links WHERE guardian_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [user.id])));
    const rows = await many(
      `SELECT ${CARD_COLS},
         CASE WHEN $4::float8 IS NULL OR coalesce(v.latitude, og.place_latitude) IS NULL THEN NULL ELSE round((6371 * 2 * asin(sqrt(
           power(sin(radians(coalesce(v.latitude, og.place_latitude) - $4) / 2), 2) + cos(radians($4)) * cos(radians(coalesce(v.latitude, og.place_latitude))) * power(sin(radians(coalesce(v.longitude, og.place_longitude) - $5) / 2), 2))))::numeric, 1) END AS distance_km,
         (SELECT m.status FROM open_game_members m WHERE m.open_game_id=og.id AND m.user_id=$1) AS my_status,
         EXISTS (SELECT 1 FROM availability_windows w WHERE w.user_id=$1 AND w.archived_at IS NULL AND w.weekday = extract(dow FROM g.starts_at AT TIME ZONE w.timezone)
                   AND (g.starts_at AT TIME ZONE w.timezone)::time >= w.from_time AND (coalesce(g.ends_at, g.starts_at + interval '2 hours') AT TIME ZONE w.timezone)::time <= w.to_time
                   AND (g.starts_at AT TIME ZONE w.timezone)::date = (coalesce(g.ends_at, g.starts_at + interval '2 hours') AT TIME ZONE w.timezone)::date) AS fits_availability
       ${CARD_FROM}
       WHERE (CASE WHEN coalesce($6,false) THEN (og.host_id=$1 OR EXISTS (SELECT 1 FROM open_game_members m WHERE m.open_game_id=og.id AND m.user_id=$1 AND m.status IN ('guardian_pending','requested','waitlisted','confirmed')))
                   ELSE (og.status='open' AND g.status='pre-event' AND g.starts_at > now() AND (og.booking_id IS NULL OR b.status='confirmed')
                         AND (og.visibility='public' OR (og.visibility='team' AND og.team_id IS NOT NULL AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id=og.team_id AND tm.user_id=$1 AND tm.status='active')))) END)
         AND ($2::uuid IS NULL OR g.sport_id=$2) AND ($3::timestamptz IS NULL OR g.starts_at >= $3) AND ($7::timestamptz IS NULL OR g.starts_at < $7)
         AND ($8::text IS NULL OR $8 IN ('beginner','amateur','semi_pro','pro') AND (og.skill_min IS NULL OR array_position(ARRAY['beginner','amateur','semi_pro','pro'], og.skill_min) <= array_position(ARRAY['beginner','amateur','semi_pro','pro'], $8))
              AND (og.skill_max IS NULL OR array_position(ARRAY['beginner','amateur','semi_pro','pro'], og.skill_max) >= array_position(ARRAY['beginner','amateur','semi_pro','pro'], $8)))
         AND ($9::text IS NULL OR og.format ILIKE $9) AND ($10::bigint IS NULL OR (CASE og.cost_mode WHEN 'per_player' THEN og.cost_cents WHEN 'split_total' THEN ceil(og.cost_cents::numeric / og.max_players) ELSE 0 END) <= $10)
         AND (NOT coalesce($11,false) OR og.cost_mode='free') AND (NOT coalesce($12,false) OR (SELECT count(*) FROM open_game_members m WHERE m.open_game_id=og.id AND m.status='confirmed') < og.max_players)
         AND ($13::uuid IS NULL OR og.team_id=$13) AND ($14::uuid IS NULL OR og.host_id=$14) AND ($15::text IS NULL OR og.audience=$15)
         AND (coalesce($6,false) OR ((og.audience <> 'youth' OR $17::boolean) AND (og.audience <> 'adults' OR NOT $18::boolean)))
         AND ($16::text IS NULL OR g.title ILIKE '%'||$16||'%' OR coalesce(v.name, g.location, '') ILIKE '%'||$16||'%' OR coalesce(v.city, og.place_city, '') ILIKE '%'||$16||'%')`,
      [uid, sport?.id ?? null, from ?? null, i.lat ?? null, i.lng ?? null, i.mine ?? null, to ?? null, i.level ?? null, i.format ?? null, i.max_cost_cents ?? null, i.free_only ?? null, i.has_slots ?? null, i.team_id ?? null, i.host_id ?? null, i.audience ?? null, i.q ?? null, showYouth, viewerYouth]);
    let list = rows.filter((r) => i.radius_km == null || (r.distance_km != null && Number(r.distance_km) <= i.radius_km));
    const badges = await badgesFor('user', [...new Set(list.map((r) => r.host_id))]);
    if (i.verified_host) list = list.filter((r) => (badges.get(r.host_id) ?? []).length > 0);
    const computed = user ? await reliableLevels(user.id) : new Map(); // a reliable skill level (#633) stands in for the declared one
    const profiles = (user ? await many('SELECT DISTINCT ON (sport_id) sport_id, level FROM sport_profiles WHERE user_id=$1 AND archived_at IS NULL ORDER BY sport_id, is_default DESC, created_at', [user.id]) : [])
      .map((p) => ({ ...p, level: computed.get(p.sport_id)?.bucket ?? p.level, skill_level: computed.get(p.sport_id)?.level ?? null }));
    for (const [sportId, c] of computed) if (!profiles.some((p) => p.sport_id === sportId)) profiles.push({ sport_id: sportId, level: c.bucket, skill_level: c.level });
    const out = list.map((r) => {
      const card = shape(r, badges, user);
      const prof = profiles.find((p) => p.sport_id === r.sport_id);
      card.my_level = prof?.skill_level ? { level: prof.skill_level, verified: true } : null; // the viewer's own reliable level in this sport (#633); never anyone else's
      const fit = levelFit(r, prof?.level ?? null);
      const reasons = [];
      if (user && !r.is_mine) {
        if (prof) reasons.push({ kind: 'sport', ok: true, text: `You play ${r.sport}` });
        if (prof && fit === 'fits') reasons.push({ kind: 'level', ok: true, text: `${skillLabel(r.skill_min, r.skill_max)} suits your ${lvl(prof)}` });
        else if (fit === 'open') reasons.push({ kind: 'level', ok: true, text: 'Open to all levels' });
        else if (fit === 'below' || fit === 'above') reasons.push({ kind: 'level', ok: false, text: `Asks for ${skillLabel(r.skill_min, r.skill_max)}; ${prof.skill_level ? 'your verified level is' : 'your profile says'} ${lvl(prof)}` });
        if (r.fits_availability) reasons.push({ kind: 'time', ok: true, text: 'Fits your weekly availability' });
        if (r.distance_km != null) reasons.push({ kind: 'distance', ok: true, text: Number(r.distance_km) < 1 ? 'Under 1 km away' : `About ${Math.round(Number(r.distance_km))} km away` });
      }
      const score = (prof ? 3 : 0) + (fit === 'fits' ? 2 : fit === 'open' ? 1 : fit === 'below' || fit === 'above' ? -2 : 0) + (r.fits_availability ? 2 : 0) + (r.distance_km != null && Number(r.distance_km) <= 5 ? 1 : 0);
      return { ...card, distance_km: r.distance_km == null ? null : Number(r.distance_km), my_status: r.my_status, level_fit: user ? fit : undefined, reasons, match_score: score };
    });
    const by = { soonest: (a, b) => (a.starts_at < b.starts_at ? -1 : 1), distance: (a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9) || (a.starts_at < b.starts_at ? -1 : 1), best_match: (a, b) => b.match_score - a.match_score || (a.starts_at < b.starts_at ? -1 : 1) };
    return out.sort(by[i.sort]).slice(i.offset, i.offset + i.limit);
  },
});

// ---------------------------------------------------------------- changing a game

cap({
  name: 'update_open_game', method: 'PATCH', path: '/open-games/:id', tag: TAG,
  summary: 'Change a game you host: time, duration, venue/booking link, place, seats, level, notes, approval and visibility. People holding a place are told about a time or venue change. Seats cannot drop below the confirmed players and the price cannot change once others hold a seat. Raising max_players promotes the waitlist.',
  input: z.object({ id, ...termsShape(false), booking_id: id.nullable().optional() }),
  async handler({ user }, i) {
    const out = await tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      if (!(await managesOpen(user, og, g))) throw forbidden('Only the host can change this game');
      if (og.status !== 'open') throw conflict('This game is closed');
      const startsAt = i.starts_at ?? g.starts_at;
      const ends = i.starts_at || i.duration_minutes ? new Date(+new Date(startsAt) + (i.duration_minutes ?? Math.round((+endOf(g) - +new Date(g.starts_at)) / 6e4)) * 6e4) : endOf(g);
      if (Date.parse(startsAt) <= Date.now()) throw badRequest('The game must start in the future');
      const taken = await seatsTaken(c, og.id);
      const max = i.max_players ?? og.max_players, min = i.min_players ?? og.min_players;
      if (max < taken) throw conflict(`${taken} players already hold a seat`, { code: 'seats_taken' });
      if (min > max) throw badRequest('min_players is above max_players');
      const mode = i.cost_mode ?? og.cost_mode, cost = mode === 'free' ? 0 : (i.cost_cents ?? Number(og.cost_cents));
      if (mode !== 'free' && !(cost > 0)) throw badRequest('Give the amount for a paid game');
      if ((mode !== og.cost_mode || cost !== Number(og.cost_cents) || (i.currency && i.currency !== og.currency)) && (taken > (await c.query("SELECT count(*)::int AS n FROM open_game_members WHERE open_game_id=$1 AND user_id=$2 AND status='confirmed'", [og.id, og.host_id])).rows[0].n)) {
        throw conflict('The price cannot change once other players hold a seat', { code: 'price_locked' });
      }
      const smin = i.skill_min === undefined ? og.skill_min : i.skill_min, smax = i.skill_max === undefined ? og.skill_max : i.skill_max;
      if (smin && smax && LEVELS.indexOf(smin) > LEVELS.indexOf(smax)) throw badRequest('skill_min is above skill_max');
      let venueId = g.venue_id, resourceId = g.resource_id, bookingId = i.booking_id === undefined ? og.booking_id : i.booking_id;
      if (i.resource_id) {
        const r = (await c.query('SELECT * FROM resources WHERE id=$1 AND active', [i.resource_id])).rows[0];
        if (!r) throw notFound('Court');
        if (i.venue_id && i.venue_id !== r.venue_id) throw badRequest('resource_id is not part of venue_id');
        venueId = r.venue_id; resourceId = r.id;
      } else if (i.venue_id) {
        if (!(await c.query('SELECT 1 FROM venues WHERE id=$1 AND active', [i.venue_id])).rows[0]) throw notFound('Venue');
        venueId = i.venue_id; resourceId = null;
      }
      const timeChanged = new Date(startsAt).getTime() !== new Date(g.starts_at).getTime() || ends.getTime() !== endOf(g).getTime();
      if (bookingId && (bookingId !== og.booking_id || timeChanged)) {
        const b = await checkBooking(c, user, bookingId, startsAt, ends, g.sport_id, og.id);
        if (bookingId !== og.booking_id) { venueId = b.r_venue; resourceId = b.resource_id; }
      }
      const location = i.location === undefined ? g.location : i.location;
      if (!venueId && !location) throw badRequest('Say where: pick a venue or name a public place', { code: 'place_required' });
      const placeChanged = venueId !== g.venue_id || resourceId !== g.resource_id || location !== g.location;
      await c.query('UPDATE games SET title=$2, starts_at=$3, ends_at=$4, venue_id=$5, resource_id=$6, location=$7, updated_at=now() WHERE id=$1', [g.id, i.title ?? g.title, startsAt, ends, venueId, resourceId, location]);
      await c.query(
        `UPDATE open_games SET booking_id=$2, visibility=$3, approval_mode=$4, min_players=$5, max_players=$6, skill_min=$7, skill_max=$8, format=$9, role_needs=$10, audience=$11, min_age=$12, max_age=$13,
           cost_mode=$14, cost_cents=$15, currency=$16, cancel_before_hours=$17, notes=$18, place_latitude=$19, place_longitude=$20, place_city=$21, last_synced_starts_at=$22, row_version=row_version+1, updated_at=now() WHERE id=$1`,
        [og.id, bookingId, i.visibility ?? og.visibility, i.approval_mode ?? og.approval_mode, min, max, smin, smax, i.format === undefined ? og.format : i.format, i.role_needs ?? og.role_needs, i.audience ?? og.audience,
          i.min_age === undefined ? og.min_age : i.min_age, i.max_age === undefined ? og.max_age : i.max_age, mode, cost, i.currency ?? og.currency, i.cancel_before_hours ?? og.cancel_before_hours, i.notes === undefined ? og.notes : i.notes,
          i.place_latitude ?? og.place_latitude, i.place_longitude ?? og.place_longitude, i.place_city ?? og.place_city, startsAt]);
      const next = { ...og, max_players: max, cost_mode: mode, cost_cents: cost, row_version: og.row_version + 1 };
      if (timeChanged || placeChanged) await notifyAll(c, next, { ...g, title: i.title ?? g.title }, { kind: 'open_game_changed', title: 'Game time or place changed', body: `"${i.title ?? g.title}" has a new ${timeChanged && placeChanged ? 'time and place' : timeChanged ? 'time' : 'place'}. Open the app to check it still works for you.`, key: `og_changed:${og.id}:${next.row_version}` });
      if (max > og.max_players) await promoteWaitlist(c, next, g);
      return og.id;
    });
    return getDetail(out, user);
  },
});

cap({
  name: 'cancel_open_game', method: 'POST', path: '/open-games/:id/cancel', tag: TAG,
  summary: 'Call off a game you host. Everyone holding a place is told; unsettled shares are waived. The venue booking is NOT cancelled for you — cancel it with cancel_reservation if you no longer need the slot (the response names it).',
  input: z.object({ id, reason: z.string().trim().max(200).optional() }),
  async handler({ user }, i) {
    const res = await tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      if (!(await managesOpen(user, og, g))) throw forbidden('Only the host can call this game off');
      if (og.status === 'cancelled') return { og, replay: true };
      if (og.status !== 'open') throw conflict('This game is already over');
      await c.query("UPDATE open_games SET status='cancelled', cancelled_reason=$2, row_version=row_version+1, updated_at=now() WHERE id=$1", [og.id, i.reason ?? null]);
      await c.query("UPDATE games SET status='canceled', updated_at=now() WHERE id=$1", [g.id]);
      await notifyAll(c, og, g, { kind: 'open_game_cancelled', title: 'Game cancelled', body: `"${g.title}" was cancelled by the host.${i.reason ? ` Reason: ${i.reason}` : ''}`, key: 'og_cancelled' });
      await c.query("UPDATE open_game_members SET status='cancelled', cancelled_at=now(), share_status=CASE WHEN share_status='due' THEN 'waived' ELSE share_status END, updated_at=now() WHERE open_game_id=$1 AND status IN ('guardian_pending','requested','waitlisted','confirmed') AND user_id<>$2", [og.id, og.host_id]);
      return { og };
    });
    const booking = res.og.booking_id ? await one("SELECT b.id AS booking_id, rs.id AS reservation_id, rs.code FROM bookings b LEFT JOIN reservations rs ON rs.id=b.reservation_id WHERE b.id=$1 AND b.status='confirmed'", [res.og.booking_id]) : null;
    return { ok: true, status: 'cancelled', booking_still_active: booking, note: booking ? 'The venue booking is still active. Cancel it with cancel_reservation if you do not need it.' : undefined };
  },
});

// ---------------------------------------------------------------- joining

/** Put a person in the right place for the game's rules: a seat, the waitlist, or the host's queue. Caller holds the game lock. */
async function place(c, og, g, member, { approved }) {
  const taken = await seatsTaken(c, og.id);
  let status;
  if (!approved) status = 'requested';
  else if (taken < og.max_players) status = 'confirmed';
  else status = 'waitlisted';
  const share = status === 'confirmed' ? shareFor(og) : 0;
  const row = (await c.query("UPDATE open_game_members SET status=$2, approved=$3, share_cents=$4::bigint, share_status=CASE WHEN $4::bigint > 0 THEN 'due' ELSE 'none' END, updated_at=now() WHERE id=$1 RETURNING *", [member.id, status, approved, share])).rows[0];
  if (status === 'confirmed') await nudgeHost(c, og, g);
  return row;
}

const memberView = (m, extra = {}) => ({ member_id: m.id, open_game_id: m.open_game_id, status: m.status, approved: m.approved, position: m.position, share_status: m.share_status, share_cents: Number(m.share_cents), attendance: m.attendance, ...extra });

cap({
  name: 'join_open_game', method: 'POST', path: '/open-games/:id/join', tag: TAG, status: 201,
  summary: 'Ask to join (or, when the host auto-approves and you fit the stated level, take a seat straight away). A full game puts you on the waitlist; you move up automatically when a seat frees. Joining never makes you a member of the host\'s team. A guardian can join for a young person with on_behalf_of; a young person asking for themselves waits for a guardian\'s approval. Send an idempotency_key so a retry never creates a second request.',
  input: z.object({ id, position: z.string().trim().max(40).optional().describe('the role you would play'), message: z.string().trim().max(300).optional(), on_behalf_of: id.optional(), idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    const subject = i.on_behalf_of ?? user.id;
    return tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      if (!(await visibleTo(user, og))) throw notFound('Game');
      if (subject !== user.id) await requireGuardian(user, subject, c);
      if (subject === og.host_id) throw badRequest('You are hosting this game');
      const prior = (await c.query('SELECT * FROM open_game_members WHERE open_game_id=$1 AND user_id=$2 FOR UPDATE', [og.id, subject])).rows[0];
      if (prior && ['guardian_pending', 'requested', 'waitlisted', 'confirmed'].includes(prior.status)) return memberView(prior, { replayed: true });
      if (og.status !== 'open' || g.status !== 'pre-event') throw conflict('This game is closed', { code: 'game_closed' });
      if (new Date(g.starts_at) <= new Date()) throw conflict('This game has already started', { code: 'game_started' });
      if (prior && ['declined', 'removed'].includes(prior.status)) throw conflict(prior.status === 'declined' ? 'The host declined your request' : 'The host removed you from this game', { code: prior.status });
      const { youth } = await assertCanPlay(c, og, subject, user);
      let m = prior;
      const fields = [og.id, subject, subject === user.id ? null : user.id, i.position ?? null, i.message ?? null, i.idempotency_key ?? null];
      if (m) m = (await c.query("UPDATE open_game_members SET status='requested', approved=false, applied_by=$3, position=$4, message=$5, idempotency_key=$6, cancelled_at=NULL, late_cancel=false, attendance=NULL, checked_in_at=NULL, share_status='none', share_cents=0, updated_at=now() WHERE open_game_id=$1 AND user_id=$2 RETURNING *", fields)).rows[0];
      else m = (await c.query("INSERT INTO open_game_members(open_game_id, user_id, applied_by, position, message, idempotency_key, status) VALUES ($1,$2,$3,$4,$5,$6,'requested') RETURNING *", fields)).rows[0];

      if (youth && subject === user.id) { // a young person asking for themselves: their guardians decide first
        const guardians = (await c.query("SELECT guardian_id FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [subject])).rows;
        if (!guardians.length) throw conflict('A verified guardian must be linked to your account before you can join games', { code: 'guardian_required' });
        m = (await c.query("UPDATE open_game_members SET status='guardian_pending' WHERE id=$1 RETURNING *", [m.id])).rows[0];
        for (const gl of guardians) await notify(c, gl.guardian_id, { kind: 'open_game_guardian_request', title: 'Approve a game?', body: `A young person you look after asked to join "${g.title}". Open the app to approve or decline.`, data: { open_game_id: og.id, member_id: m.id }, dedupe_key: `og_guardian:${m.id}:${gl.guardian_id}` });
        return memberView(m);
      }
      if (youth) await requireConsent(subject, 'participation', 'taking part in a game', c);
      const lv = await levelFor(c, subject, g.sport_id);
      const fits = levelFit(og, lv);
      const approved = og.approval_mode === 'auto' && fits !== 'below' && fits !== 'above';
      m = await place(c, og, g, m, { approved });
      if (m.status === 'requested') await notify(c, og.host_id, { kind: 'open_game_request', title: 'New request to join', body: `Someone asked to join "${g.title}". Open the app to review it.`, data: { open_game_id: og.id, member_id: m.id }, dedupe_key: `og_request:${m.id}:${m.updated_at.getTime()}` });
      await notifyMember(c, m, { kind: m.status === 'confirmed' ? 'open_game_confirmed' : m.status === 'waitlisted' ? 'open_game_waitlisted' : 'open_game_requested',
        title: m.status === 'confirmed' ? 'You are in!' : m.status === 'waitlisted' ? 'You are on the waitlist' : 'Request sent',
        body: m.status === 'confirmed' ? `Your seat in "${g.title}" is confirmed.` : m.status === 'waitlisted' ? `"${g.title}" is full. You move up automatically if a seat frees.` : `The host will review your request for "${g.title}".`, key: `og_self:${m.id}:${m.status}` }, og);
      return memberView(m, { level_fit: fits });
    });
  },
});

async function leaveMember(c, og, g, m, byHost) {
  const wasSeat = m.status === 'confirmed';
  const late = wasSeat && !byHost && Date.now() > +new Date(g.starts_at) - og.cancel_before_hours * 36e5;
  const owed = m.share_status === 'settled';
  const row = (await c.query("UPDATE open_game_members SET status=$2, cancelled_at=now(), late_cancel=$3, share_status=CASE WHEN share_status='due' THEN 'waived' ELSE share_status END, updated_at=now() WHERE id=$1 RETURNING *", [m.id, byHost ? 'removed' : 'cancelled', late])).rows[0];
  if (wasSeat) await promoteWaitlist(c, og, g);
  if (!byHost && og.host_id !== m.user_id) await notify(c, og.host_id, { kind: 'open_game_left', title: 'A player dropped out', body: `A player left "${g.title}"${late ? ' after the cancellation cut-off' : ''}.${owed ? ' They had already settled their share.' : ''}`, data: { open_game_id: og.id, member_id: m.id }, dedupe_key: `og_left:${m.id}:${row.cancelled_at.getTime()}` });
  if (byHost) await notifyMember(c, row, { kind: 'open_game_removed', title: 'Removed from a game', body: `The host removed you from "${g.title}".`, key: `og_removed:${m.id}` }, og);
  return { row, late, share_settled: owed };
}

cap({
  name: 'leave_open_game', method: 'POST', path: '/open-games/:id/leave', tag: TAG,
  summary: 'Drop your request, waitlist place or seat (a guardian can for a young person). A seat given up after the host\'s cancellation cut-off is recorded as a factual late cancellation you can appeal. The next approved person on the waitlist is promoted automatically. Safe to repeat.',
  input: z.object({ id, on_behalf_of: id.optional() }),
  async handler({ user }, i) {
    const subject = i.on_behalf_of ?? user.id;
    return tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      if (subject !== user.id) await requireGuardian(user, subject, c);
      const m = (await c.query('SELECT * FROM open_game_members WHERE open_game_id=$1 AND user_id=$2 FOR UPDATE', [og.id, subject])).rows[0];
      if (!m) throw notFound('Place in this game');
      if (!['guardian_pending', 'requested', 'waitlisted', 'confirmed'].includes(m.status)) return memberView(m, { replayed: true });
      if (subject === og.host_id) throw badRequest('You are hosting this game; cancel it instead');
      if (new Date(g.starts_at) <= new Date() && m.status === 'confirmed') throw conflict('The game has started; ask the host to record attendance', { code: 'game_started' });
      const out = await leaveMember(c, og, g, m, false);
      return memberView(out.row, { late_cancel: out.late });
    });
  },
});

cap({
  name: 'decide_open_game_request', method: 'POST', path: '/open-games/:id/members/:member_id/decision', tag: TAG,
  summary: 'Host: approve, decline or remove a person. Approving gives a seat when one is free, otherwise the waitlist (they are promoted in order when a seat frees). Removing a seat holder promotes the waitlist. Safe to repeat.',
  input: z.object({ id, member_id: id, action: z.enum(['approve', 'decline', 'remove']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      if (!(await managesOpen(user, og, g))) throw forbidden('Only the host can decide requests');
      const m = (await c.query('SELECT * FROM open_game_members WHERE id=$1 AND open_game_id=$2 FOR UPDATE', [i.member_id, og.id])).rows[0];
      if (!m) throw notFound('Request');
      if (m.user_id === og.host_id) throw badRequest('That is the host');
      if (i.action === 'approve') {
        if (m.status === 'guardian_pending') throw conflict('A guardian has to approve this young person first', { code: 'guardian_pending' });
        if (['confirmed', 'waitlisted'].includes(m.status)) return memberView(m, { replayed: true });
        if (m.status !== 'requested') throw conflict(`Request is ${m.status}`);
        if (og.status !== 'open' || new Date(g.starts_at) <= new Date()) throw conflict('This game is closed');
        if (await isYouth(m.user_id, c)) await requireConsent(m.user_id, 'participation', 'taking part in a game', c);
        const row = await place(c, og, g, m, { approved: true });
        await notifyMember(c, row, { kind: 'open_game_approved', title: row.status === 'confirmed' ? 'Request approved' : 'Approved — on the waitlist', body: row.status === 'confirmed' ? `Your seat in "${g.title}" is confirmed.` : `"${g.title}" is full right now; you move up when a seat frees.`, key: `og_decision:${m.id}:approve` }, og);
        return memberView(row);
      }
      if (i.action === 'decline') {
        if (m.status === 'declined') return memberView(m, { replayed: true });
        if (!['requested', 'waitlisted', 'guardian_pending'].includes(m.status)) throw conflict(`Request is ${m.status}`);
        const row = (await c.query("UPDATE open_game_members SET status='declined', updated_at=now() WHERE id=$1 RETURNING *", [m.id])).rows[0];
        await notifyMember(c, row, { kind: 'open_game_declined', title: 'Request declined', body: `The host could not take you for "${g.title}".`, key: `og_decision:${m.id}:decline` }, og);
        return memberView(row);
      }
      if (m.status === 'removed') return memberView(m, { replayed: true });
      if (!LIVE_STATES.includes(m.status)) throw conflict(`Request is ${m.status}`);
      return memberView((await leaveMember(c, og, g, m, true)).row);
    });
  },
});
const LIVE_STATES = ['guardian_pending', 'requested', 'waitlisted', 'confirmed'];

cap({
  name: 'set_open_game_share', method: 'POST', path: '/open-games/:id/members/:member_id/share', tag: TAG,
  summary: 'Host: record that a player has paid their share (settled), owes it (due) or is excused (waived). The money moves between you and the player directly or through the venue invoice; this keeps the record. Safe to repeat.',
  input: z.object({ id, member_id: id, status: z.enum(['due', 'settled', 'waived']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      if (!(await managesOpen(user, og, g))) throw forbidden();
      const m = (await c.query('SELECT * FROM open_game_members WHERE id=$1 AND open_game_id=$2 FOR UPDATE', [i.member_id, og.id])).rows[0];
      if (!m) throw notFound('Player');
      if (m.status !== 'confirmed' || Number(m.share_cents) === 0) throw conflict('That player has no share to record');
      if (m.share_status === i.status) return memberView(m, { replayed: true });
      const row = (await c.query('UPDATE open_game_members SET share_status=$2, updated_at=now() WHERE id=$1 RETURNING *', [m.id, i.status])).rows[0];
      if (i.status === 'settled') await notifyMember(c, row, { kind: 'open_game_share_settled', title: 'Share received', body: `Your share for "${g.title}" is recorded as paid.`, key: `og_share:${m.id}` }, og);
      return memberView(row);
    });
  },
});

// ---------------------------------------------------------------- guardians

cap({
  name: 'list_guardian_open_game_requests', method: 'GET', path: '/me/open-game-guardian-requests', tag: TAG,
  summary: 'Guardian: games a young person you look after has asked to join, waiting for your decision.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT m.id AS member_id, m.open_game_id, m.created_at, g.title, g.starts_at, g.location, v.name AS venue_name, s.name AS sport, og.audience, og.cost_mode, og.cost_cents, og.currency, u.id AS child_id, u.display_name AS child_name
       FROM open_game_members m JOIN users u ON u.id=m.user_id JOIN open_games og ON og.id=m.open_game_id JOIN games g ON g.id=og.game_id JOIN sports s ON s.id=g.sport_id LEFT JOIN venues v ON v.id=g.venue_id
       JOIN guardian_links l ON l.child_id=m.user_id AND l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
      WHERE m.status='guardian_pending' AND g.starts_at > now() ORDER BY g.starts_at LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'guardian_decide_open_game_join', method: 'POST', path: '/open-games/:id/members/:member_id/guardian-decision', tag: TAG,
  summary: 'Guardian: approve or decline a young person\'s request to join a game. Approving needs your current consent for taking part; it then follows the game\'s normal approval and waitlist rules.',
  input: z.object({ id, member_id: id, decision: z.enum(['approve', 'decline']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      const m = (await c.query('SELECT * FROM open_game_members WHERE id=$1 AND open_game_id=$2 FOR UPDATE', [i.member_id, og.id])).rows[0];
      if (!m) throw notFound('Request');
      await requireGuardian(user, m.user_id, c);
      if (m.status !== 'guardian_pending') return memberView(m, { replayed: true });
      if (i.decision === 'decline') return memberView((await c.query("UPDATE open_game_members SET status='declined', updated_at=now() WHERE id=$1 RETURNING *", [m.id])).rows[0]);
      await requireConsent(m.user_id, 'participation', 'taking part in a game', c);
      if (og.status !== 'open' || new Date(g.starts_at) <= new Date()) throw conflict('This game is closed');
      const fits = levelFit(og, await levelFor(c, m.user_id, g.sport_id));
      const row = await place(c, og, g, m, { approved: og.approval_mode === 'auto' && fits !== 'below' && fits !== 'above' });
      if (row.status === 'requested') await notify(c, og.host_id, { kind: 'open_game_request', title: 'New request to join', body: `A guardian-approved player asked to join "${g.title}". Open the app to review it.`, data: { open_game_id: og.id, member_id: m.id }, dedupe_key: `og_request:${m.id}:${row.updated_at.getTime()}` });
      return memberView(row);
    });
  },
});

// ---------------------------------------------------------------- playing: check-in, attendance, completion, appeals

cap({
  name: 'check_in_open_game', method: 'POST', path: '/open-games/:id/check-in', tag: TAG,
  summary: 'Check yourself in (a guardian for a young person) from an hour before the start until the game ends. Records verified attendance. Safe to repeat.',
  input: z.object({ id, on_behalf_of: id.optional() }),
  async handler({ user }, i) {
    const subject = i.on_behalf_of ?? user.id;
    return tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      if (subject !== user.id) await requireGuardian(user, subject, c);
      else if (await isYouth(subject, c)) throw forbidden('A guardian checks a young person in');
      const m = (await c.query("SELECT * FROM open_game_members WHERE open_game_id=$1 AND user_id=$2 AND status='confirmed' FOR UPDATE", [og.id, subject])).rows[0];
      if (!m) throw notFound('Seat in this game');
      if (m.attendance === 'attended') return memberView(m, { replayed: true });
      const now = Date.now();
      if (now < +new Date(g.starts_at) - CHECK_IN_EARLY_MIN * 6e4) throw conflict('Check-in opens an hour before the start', { code: 'too_early' });
      if (now > +endOf(g)) throw conflict('The game is over; ask the host to record attendance', { code: 'too_late' });
      return memberView((await c.query("UPDATE open_game_members SET attendance='attended', checked_in_at=now(), attendance_by=$2, updated_at=now() WHERE id=$1 RETURNING *", [m.id, user.id])).rows[0], { checked_in_at: new Date() });
    });
  },
});

cap({
  name: 'mark_open_game_attendance', method: 'POST', path: '/open-games/:id/members/:member_id/attendance', tag: TAG,
  summary: 'Host: record that a seat holder attended or did not show, after the game has started. This is a factual record the player can appeal; nothing is labelled automatically.',
  input: z.object({ id, member_id: id, attendance: z.enum(['attended', 'no_show']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      if (!(await managesOpen(user, og, g))) throw forbidden('Only the host records attendance');
      if (og.status === 'cancelled') throw conflict('This game was cancelled');
      if (new Date(g.starts_at) > new Date()) throw conflict('The game has not started yet', { code: 'not_started' });
      const m = (await c.query("SELECT * FROM open_game_members WHERE id=$1 AND open_game_id=$2 AND status='confirmed' FOR UPDATE", [i.member_id, og.id])).rows[0];
      if (!m) throw notFound('Seat holder');
      if (m.attendance === i.attendance) return memberView(m, { replayed: true });
      if (og.status === 'completed') throw conflict('The game is complete; the player can appeal this record', { code: 'completed' });
      const row = (await c.query("UPDATE open_game_members SET attendance=$2, attendance_by=$3, checked_in_at=CASE WHEN $2='attended' THEN coalesce(checked_in_at, now()) ELSE NULL END, updated_at=now() WHERE id=$1 RETURNING *", [m.id, i.attendance, user.id])).rows[0];
      if (i.attendance === 'no_show') await notifyMember(c, row, { kind: 'open_game_no_show', title: 'Marked as not attended', body: `The host recorded that you did not attend "${g.title}". If that is wrong you can ask for it to be reviewed.`, key: `og_noshow:${m.id}` }, og);
      return memberView(row);
    });
  },
});

cap({
  name: 'complete_open_game', method: 'POST', path: '/open-games/:id/complete', tag: TAG,
  summary: 'Host: close a game that has been played. Everyone recorded as attended becomes a participant of the game, so it counts in their sports history. People not marked are left unmarked (never counted as no-shows). Safe to repeat.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const lock = await lockOpenGame(c, i.id);
      if (!lock) throw notFound('Game');
      const { og, g } = lock;
      if (!(await managesOpen(user, og, g))) throw forbidden('Only the host can complete the game');
      if (og.status === 'completed') return { ok: true, status: 'completed', replayed: true };
      if (og.status !== 'open') throw conflict('This game was cancelled');
      if (new Date(g.starts_at) > new Date()) throw conflict('The game has not started yet', { code: 'not_started' });
      await c.query("UPDATE open_games SET status='completed', row_version=row_version+1, updated_at=now() WHERE id=$1", [og.id]);
      await c.query("UPDATE games SET status='post-event', updated_at=now() WHERE id=$1", [g.id]);
      const { rows: played } = await c.query("SELECT user_id FROM open_game_members WHERE open_game_id=$1 AND status='confirmed' AND attendance='attended'", [og.id]);
      let recorded = 0;
      for (const p of played) {
        if ((await isYouth(p.user_id, c)) && !(await hasConsent(p.user_id, 'participation', c))) continue; // no consent now, nothing is added to their record
        recorded += (await c.query('INSERT INTO game_participants(game_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.id, p.user_id])).rowCount;
      }
      return { ok: true, status: 'completed', participants_recorded: recorded };
    });
  },
});

cap({
  name: 'raise_open_game_appeal', method: 'POST', path: '/open-game-appeals', tag: TAG, status: 201,
  summary: 'Ask for a no-show or late-cancellation record to be reviewed (you, or a guardian for a young person). The host can correct it; if they do not, the platform team reviews. While a review is open the fact is shown as "under review".',
  input: z.object({ member_id: id, fact: z.enum(['no_show', 'late_cancel']), reason: z.string().trim().min(5).max(500) }),
  async handler({ user }, i) {
    const m = await one('SELECT * FROM open_game_members WHERE id=$1', [i.member_id]);
    if (!m) throw notFound('Record');
    if (m.user_id !== user.id) await requireGuardian(user, m.user_id);
    if (i.fact === 'no_show' ? m.attendance !== 'no_show' : !m.late_cancel) throw conflict('There is no such record on this game');
    try {
      const a = await one('INSERT INTO open_game_appeals(member_id, raised_by, fact, reason) VALUES ($1,$2,$3,$4) RETURNING *', [m.id, user.id, i.fact, i.reason]);
      const og = await one('SELECT og.id, og.host_id, g.title FROM open_games og JOIN games g ON g.id=og.game_id WHERE og.id=$1', [m.open_game_id]);
      await notify(null, og.host_id, { kind: 'open_game_appeal', title: 'A record was queried', body: `A player asked you to review a record on "${og.title}". Open the app to correct it or leave it for the platform team.`, data: { open_game_id: og.id, appeal_id: a.id }, dedupe_key: `og_appeal:${a.id}` });
      return a;
    } catch (e) {
      if (e.code === '23505') throw conflict('A review of this record is already open');
      throw e;
    }
  },
});

cap({
  name: 'resolve_open_game_appeal', method: 'POST', path: '/open-game-appeals/:id/resolve', tag: TAG,
  summary: 'Host or platform team: correct the record (it stops counting) or uphold it. The host can only correct; upholding is a platform decision, so a host cannot be the only judge of their own record.',
  input: z.object({ id, outcome: z.enum(['corrected', 'upheld']), resolution: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query("SELECT * FROM open_game_appeals WHERE id=$1 FOR UPDATE", [i.id])).rows[0];
      if (!a) throw notFound('Review');
      if (a.status !== 'open') return { ...a, replayed: true };
      const m = (await c.query('SELECT * FROM open_game_members WHERE id=$1 FOR UPDATE', [a.member_id])).rows[0];
      const lock = await lockOpenGame(c, m.open_game_id);
      const platform = isAdmin(user);
      if (!platform && !(await managesOpen(user, lock.og, lock.g))) throw forbidden();
      if (i.outcome === 'upheld' && !platform) throw forbidden('Only the platform team can uphold a record');
      if (i.outcome === 'corrected') await c.query(a.fact === 'no_show' ? 'UPDATE open_game_members SET attendance=NULL, attendance_by=NULL, updated_at=now() WHERE id=$1' : 'UPDATE open_game_members SET late_cancel=false, updated_at=now() WHERE id=$1', [m.id]);
      const row = (await c.query("UPDATE open_game_appeals SET status=$2, resolved_by=$3, resolution=$4, resolved_at=now() WHERE id=$1 RETURNING *", [a.id, i.outcome, user.id, i.resolution ?? null])).rows[0];
      await notify(c, a.raised_by, { kind: 'open_game_appeal_resolved', title: i.outcome === 'corrected' ? 'Record corrected' : 'Review finished', body: i.outcome === 'corrected' ? 'The record was corrected and no longer counts.' : 'The record was reviewed and stays.', data: { appeal_id: a.id }, dedupe_key: `og_appeal_done:${a.id}` });
      return row;
    });
  },
});

cap({
  name: 'get_open_game_facts', method: 'GET', path: '/people/:id/open-game-facts', tag: TAG,
  summary: 'Factual game history for deciding on a request: games played, recorded no-shows, late cancellations and records under review. Counts only — never a score or a label. Visible to the person (and their guardian), to the host of a game they asked to join or hold a seat in, and to the platform team.',
  input: z.object({ id }),
  async handler({ user }, i) {
    if (i.id !== user.id && !isAdmin(user)) {
      const guardian = await guardianLink(user.id, i.id);
      const hostOf = await one('SELECT 1 FROM open_game_members m JOIN open_games og ON og.id=m.open_game_id WHERE m.user_id=$1 AND og.host_id=$2 LIMIT 1', [i.id, user.id]);
      if (!guardian && !hostOf) throw notFound('Person');
    }
    const f = (await factsFor([i.id]))(i.id);
    const verified = ((await badgesFor('user', [i.id])).get(i.id) ?? []).length > 0;
    return { user_id: i.id, games_played: f.games_played, no_shows: f.no_shows, late_cancellations: f.late_cancellations, under_review: f.under_review, verified, note: 'Counts of recorded events. A record can be appealed.' };
  },
});

// ---------------------------------------------------------------- need players: suggestions and invitations

cap({
  name: 'open_game_preferences', method: 'GET', path: '/me/open-game-preferences', tag: TAG, summary: 'Whether hosts may suggest and invite you to games (off by default).', input: z.object({}),
  handler: async ({ user }) => (await one('SELECT discoverable, updated_at FROM open_game_prefs WHERE user_id=$1', [user.id])) ?? { discoverable: false },
});
cap({
  name: 'set_open_game_preferences', method: 'PATCH', path: '/me/open-game-preferences', tag: TAG,
  summary: 'Switch on or off being suggested to hosts who need players. Only your sport, level, verified status and weekly availability fit are used, never your location. Young people cannot be suggested.',
  input: z.object({ discoverable: z.boolean() }),
  async handler({ user }, i) {
    if (i.discoverable && (await isYouth(user.id))) throw forbidden('Young players are not suggested to hosts; a guardian can join games for you');
    return one('INSERT INTO open_game_prefs(user_id, discoverable) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET discoverable=$2, updated_at=now() RETURNING discoverable, updated_at', [user.id, i.discoverable]);
  },
});

cap({
  name: 'suggest_open_game_players', method: 'GET', path: '/open-games/:id/suggested-players', tag: TAG,
  summary: 'Host: adults who switched on suggestions, play this sport and are not already in the game, ranked by visible criteria — level fit, a weekly availability window that covers the game, verified identity — with the reason for each. Never ranked by payment or promotion; never uses location or sensitive traits.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const lock = await one('SELECT og.*, g.sport_id, g.starts_at, g.ends_at FROM open_games og JOIN games g ON g.id=og.game_id WHERE og.id=$1', [i.id]);
    if (!lock) throw notFound('Game');
    const g = await one('SELECT * FROM games WHERE id=$1', [lock.game_id]);
    if (!(await managesOpen(user, lock, g))) throw forbidden('Only the host can look for players');
    const rows = await many(
      `SELECT ${PUBLIC_USER}, p.level,
              EXISTS (SELECT 1 FROM availability_windows w WHERE w.user_id=u.id AND w.archived_at IS NULL AND w.weekday = extract(dow FROM $3::timestamptz AT TIME ZONE w.timezone)
                 AND ($3::timestamptz AT TIME ZONE w.timezone)::time >= w.from_time AND ($4::timestamptz AT TIME ZONE w.timezone)::time <= w.to_time
                 AND ($3::timestamptz AT TIME ZONE w.timezone)::date = ($4::timestamptz AT TIME ZONE w.timezone)::date) AS fits_availability,
              EXISTS (SELECT 1 FROM verification_cases vc WHERE vc.subject_type='user' AND vc.subject_id=u.id AND vc.status='approved' AND vc.expires_at > now()) AS verified
         FROM users u JOIN open_game_prefs pr ON pr.user_id=u.id AND pr.discoverable
         JOIN LATERAL (SELECT level FROM sport_profiles sp WHERE sp.user_id=u.id AND sp.sport_id=$2 AND sp.archived_at IS NULL ORDER BY sp.is_default DESC, sp.created_at LIMIT 1) p ON true
        WHERE ${NOT_YOUTH_SQL} AND u.id <> $1 AND NOT EXISTS (SELECT 1 FROM open_game_members m WHERE m.open_game_id=$5 AND m.user_id=u.id AND m.status IN ('guardian_pending','requested','waitlisted','confirmed','declined','removed'))`,
      [lock.host_id, lock.sport_id, lock.starts_at, endOf(g), lock.id]);
    return rows.map((r) => {
      const fit = levelFit(lock, r.level);
      const { level: lv, fits_availability, verified, ...person } = r;
      const reasons = [{ kind: 'sport', ok: true, text: `Plays ${LEVEL_LABEL[lv]} level in this sport` }];
      if (fit === 'fits') reasons.push({ kind: 'level', ok: true, text: 'Level is within your range' });
      else if (fit === 'below' || fit === 'above') reasons.push({ kind: 'level', ok: false, text: 'Level is outside your range' });
      if (fits_availability) reasons.push({ kind: 'time', ok: true, text: 'Free at this time each week' });
      if (verified) reasons.push({ kind: 'verified', ok: true, text: 'Verified identity' });
      return { ...person, level: lv, level_fit: fit, verified, reasons, rank: (fit === 'fits' ? 2 : fit === 'open' ? 1 : 0) + (fits_availability ? 2 : 0) + (verified ? 1 : 0) };
    }).sort((a, b) => b.rank - a.rank || (a.display_name < b.display_name ? -1 : 1)).slice(i.offset, i.offset + i.limit);
  },
});

cap({
  name: 'invite_to_open_game', method: 'POST', path: '/open-games/:id/invites', tag: TAG, status: 201,
  summary: 'Host: invite a person who switched on suggestions. They get a notification and still have to ask to join. Inviting twice is harmless.',
  input: z.object({ id, user_id: id }),
  async handler({ user }, i) {
    const og = await one('SELECT * FROM open_games WHERE id=$1', [i.id]);
    if (!og) throw notFound('Game');
    const g = await one('SELECT * FROM games WHERE id=$1', [og.game_id]);
    if (!(await managesOpen(user, og, g))) throw forbidden('Only the host can invite');
    if (og.status !== 'open') throw conflict('This game is closed');
    const target = await one(`SELECT 1 FROM users u JOIN open_game_prefs pr ON pr.user_id=u.id AND pr.discoverable WHERE u.id=$1 AND ${NOT_YOUTH_SQL}`, [i.user_id]);
    if (!target) throw notFound('Player');
    await notify(null, i.user_id, { kind: 'open_game_invite', title: 'You are invited to a game', body: `A host thinks you would fit "${g.title}". Open the app to look.`, data: { open_game_id: og.id }, dedupe_key: `og_invite:${og.id}` });
    return { ok: true };
  },
});

// ---------------------------------------------------------------- the temporary game chat

/** Chat is for the host and confirmed players; a young player's guardian takes part for them. null when the viewer has no access. */
async function chatRole(user, og) {
  if (og.host_id === user.id) return 'host';
  if (await one("SELECT 1 FROM open_game_members m JOIN users u ON u.id=m.user_id WHERE m.open_game_id=$1 AND m.user_id=$2 AND m.status='confirmed' AND " + NOT_YOUTH_SQL, [og.id, user.id])) return 'player';
  if (await one(`SELECT 1 FROM open_game_members m JOIN guardian_links l ON l.child_id=m.user_id AND l.guardian_id=$2 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
                  WHERE m.open_game_id=$1 AND m.status='confirmed'`, [og.id, user.id])) return 'guardian';
  return null;
}
async function chatGame(user, openGameId) {
  const og = await one('SELECT * FROM open_games WHERE id=$1', [openGameId]);
  if (!og) throw notFound('Game');
  const role = await chatRole(user, og);
  if (!role) throw forbidden('Only the host and confirmed players can use the game chat');
  return { og, g: await one('SELECT * FROM games WHERE id=$1', [og.game_id]), role };
}
const MSG = `SELECT m.id AS message_id, m.open_game_id, m.body, m.created_at, ${PUBLIC_USER}, (m.sender_id = $2) AS mine FROM open_game_messages m JOIN users u ON u.id = m.sender_id`;

cap({
  name: 'send_open_game_message', method: 'POST', path: '/open-games/:id/messages', tag: TAG, status: 201,
  summary: 'Post in the temporary game chat (host and confirmed players; a guardian for a young player). The chat closes 48 hours after the game ends or when it is cancelled; messages are kept but no longer shown to players.',
  input: z.object({ id, body: z.string().trim().min(1).max(1000) }),
  async handler({ user }, i) {
    const { og, g } = await chatGame(user, i.id);
    if (og.status === 'cancelled' || new Date() >= chatClosesAt(g)) throw conflict('This chat is closed', { code: 'chat_closed' });
    const m = await one('INSERT INTO open_game_messages(open_game_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id', [og.id, user.id, i.body]);
    return one(`${MSG} WHERE m.id=$1`, [m.id, user.id]);
  },
});

cap({
  name: 'list_open_game_messages', method: 'GET', path: '/open-games/:id/messages', tag: TAG,
  summary: 'The game chat, newest first, for the host and confirmed players. After the chat window closes it returns nothing and says it is archived. Poll with `after`.',
  input: z.object({ id, before: dt.optional(), after: dt.optional(), limit: page.limit }),
  async handler({ user }, i) {
    const { og, g } = await chatGame(user, i.id);
    const closes = chatClosesAt(g);
    if (new Date() >= closes) return { archived: true, closes_at: closes, messages: [] };
    const messages = await many(`${MSG} WHERE m.open_game_id=$1 AND m.deleted_at IS NULL AND ($3::timestamptz IS NULL OR date_trunc('milliseconds', m.created_at) < $3) AND ($4::timestamptz IS NULL OR date_trunc('milliseconds', m.created_at) > $4) ORDER BY m.created_at DESC LIMIT $5`, [og.id, user.id, i.before ?? null, i.after ?? null, i.limit]);
    return { archived: false, closes_at: closes, open: og.status === 'open', messages };
  },
});
