// Multi-sport events, part 1: programme setup, houses/groups, participants, disciplines, nominations and teams.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind, sportBySlugOrId } from '../helpers.js';
import { hasOrgGrant } from '../org-access.js';
import { eventForOrganizer } from './events.js';
import { lockEvent, programmeFor, scopeFor, canActFor } from '../multisport.js';

const TAG = 'Multi-sport events';
export const placePoints = z.record(z.string().regex(/^\d{1,3}$/), z.number().int().min(0).max(1000)).describe('place -> points, e.g. {"1":5,"2":3,"3":1}');
const gender = z.enum(['male', 'female', 'other']);

/** Can this user see the event's management data (organiser, house master, crew, a participant)? Returns { ev, scope }. */
export async function eventAccess(c, user, eventId) {
  const ev = await mustFind('events', eventId, '*', c);
  const organizer = isAdmin(user) || ev.organizer_id === user.id || (await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c));
  return { ev, scope: await scopeFor(c, user, ev, organizer) };
}
export async function organizerOnly(c, user, eventId) {
  const ev = await eventForOrganizer(user, eventId, c);
  return { ev, scope: await scopeFor(c, user, ev, true) };
}
const involved = (s) => s.organizer || s.houseIds.length || s.participantIds.length || s.staff.length;

// ---------------------------------------------------------------- programme

cap({
  name: 'setup_multi_sport', method: 'PATCH', path: '/events/:id/programme', tag: TAG,
  summary: 'Turn an event into a multi-sport programme (sports day, Olympics-style games) or change its rules: nomination limits per person, rest gap between a person\'s games, default points per place, participation points, public names, nominations open/closed. Create the event with sport "multi-sport".',
  input: z.object({
    id, max_individual_entries: z.number().int().min(1).max(50).optional(), max_team_entries: z.number().int().min(1).max(50).optional(),
    rest_gap_min: z.number().int().min(0).max(240).optional(), default_points: placePoints.optional(),
    participation_points: z.number().int().min(0).max(100).optional(), public_names: z.boolean().optional(), nominations_open: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await organizerOnly(c, user, i.id);
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      return (await c.query(
        `INSERT INTO event_programmes(event_id, max_individual_entries, max_team_entries, rest_gap_min, default_points, participation_points, public_names, nominations_open)
         VALUES ($1, coalesce($2,3), coalesce($3,2), coalesce($4,15), coalesce($5::jsonb,'{"1":5,"2":3,"3":1}'), coalesce($6,0), coalesce($7,false), coalesce($8,true))
         ON CONFLICT (event_id) DO UPDATE SET max_individual_entries=coalesce($2, event_programmes.max_individual_entries), max_team_entries=coalesce($3, event_programmes.max_team_entries),
           rest_gap_min=coalesce($4, event_programmes.rest_gap_min), default_points=coalesce($5::jsonb, event_programmes.default_points), participation_points=coalesce($6, event_programmes.participation_points),
           public_names=coalesce($7, event_programmes.public_names), nominations_open=coalesce($8, event_programmes.nominations_open), updated_at=now() RETURNING *`,
        [i.id, i.max_individual_entries, i.max_team_entries, i.rest_gap_min, i.default_points ? JSON.stringify(i.default_points) : null, i.participation_points, i.public_names, i.nominations_open])).rows[0];
    });
  },
});

cap({
  name: 'get_multi_sport', method: 'GET', path: '/events/:id/programme', tag: TAG, auth: 'public',
  summary: 'Public programme card of a multi-sport event: rules, houses with points and medals, and its disciplines. No participant names.',
  input: z.object({ id }),
  async handler(_, i) {
    const ev = await one('SELECT id, name, status, starts_on, ends_on, banner_emoji, city FROM events WHERE id=$1', [i.id]);
    if (!ev) throw notFound('Event');
    const prog = await one('SELECT * FROM event_programmes WHERE event_id=$1', [i.id]);
    if (!prog) throw notFound('Multi-sport programme');
    const [disciplines, houses] = await Promise.all([
      many(`SELECT d.id, d.name, d.mode, d.gender, d.eligible_grades, d.status, s.slug AS sport, s.name AS sport_name, s.emoji,
                   (SELECT count(*)::int FROM discipline_nominations n WHERE n.discipline_id=d.id AND n.status IN ('nominated','confirmed')) AS entrants
              FROM event_disciplines d JOIN sports s ON s.id=d.sport_id WHERE d.event_id=$1 AND d.status <> 'cancelled' ORDER BY d.name`, [i.id]),
      houseBoard(null, i.id),
    ]);
    return { event: ev, programme: prog, disciplines, houses };
  },
});

/** House league table: points + medal counts. */
export async function houseBoard(c, eventId) {
  const q = c ? (t, p) => c.query(t, p).then((r) => r.rows) : many;
  return q(
    `SELECT h.id AS house_id, h.name, h.color, h.emoji, h.kind,
            coalesce(sum(p.points) FILTER (WHERE p.voided_at IS NULL),0)::int AS points,
            count(*) FILTER (WHERE p.voided_at IS NULL AND p.kind='placement' AND p.rank=1)::int AS gold,
            count(*) FILTER (WHERE p.voided_at IS NULL AND p.kind='placement' AND p.rank=2)::int AS silver,
            count(*) FILTER (WHERE p.voided_at IS NULL AND p.kind='placement' AND p.rank=3)::int AS bronze
       FROM event_houses h LEFT JOIN event_points p ON p.house_id=h.id
      WHERE h.event_id=$1 AND h.archived_at IS NULL GROUP BY h.id ORDER BY points DESC, gold DESC, silver DESC, bronze DESC, h.name`, [eventId])
    .then((rows) => { rows.forEach((r, i) => { const p = rows[i - 1]; r.rank = p && p.points === r.points && p.gold === r.gold && p.silver === r.silver && p.bronze === r.bronze ? p.rank : i + 1; }); return rows; });
}

// ---------------------------------------------------------------- houses

cap({
  name: 'create_house', method: 'POST', path: '/events/:id/houses', tag: TAG, status: 201,
  summary: 'Add a house / group / class / region that points roll up to. Optionally name a house master who can nominate and build teams for it.',
  input: z.object({ id, name: z.string().min(1).max(60), kind: z.enum(['house', 'group', 'class', 'region', 'club']).default('house'), color: z.string().max(20).optional(), emoji: z.string().max(8).optional(), manager_user_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await organizerOnly(c, user, i.id);
      await programmeFor(c, i.id);
      if (i.manager_user_id) await mustFind('users', i.manager_user_id, 'id', c);
      try {
        return (await c.query('INSERT INTO event_houses(event_id, name, kind, color, emoji, manager_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id, i.name, i.kind, i.color ?? null, i.emoji ?? null, i.manager_user_id ?? null])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('A house with that name already exists'); throw e; }
    });
  },
});

cap({
  name: 'update_house', method: 'PATCH', path: '/houses/:id', tag: TAG,
  summary: 'Rename, recolour, change the house master of a house, or archive it (archived houses keep their points history).',
  input: z.object({ id, name: z.string().min(1).max(60).optional(), color: z.string().max(20).optional(), emoji: z.string().max(8).optional(), manager_user_id: id.nullable().optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const h = (await c.query('SELECT * FROM event_houses WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!h) throw notFound('House');
      await organizerOnly(c, user, h.event_id);
      if (i.manager_user_id) await mustFind('users', i.manager_user_id, 'id', c);
      try {
        return (await c.query(
          `UPDATE event_houses SET name=coalesce($2,name), color=coalesce($3,color), emoji=coalesce($4,emoji),
             manager_user_id = CASE WHEN $5::boolean THEN $6::uuid ELSE manager_user_id END,
             archived_at = CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 RETURNING *`,
          [i.id, i.name ?? null, i.color ?? null, i.emoji ?? null, i.manager_user_id !== undefined, i.manager_user_id ?? null, i.archived ?? null])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('A house with that name already exists'); throw e; }
    });
  },
});

cap({
  name: 'list_houses', method: 'GET', path: '/events/:id/houses', tag: TAG, auth: 'public',
  summary: 'Houses/groups of a multi-sport event, ranked by points with gold/silver/bronze counts and member counts.',
  input: z.object({ id }),
  async handler(_, i) {
    const board = await houseBoard(null, i.id);
    const counts = await many("SELECT house_id, count(*)::int AS n FROM event_participants WHERE event_id=$1 AND status='active' GROUP BY house_id", [i.id]);
    const mgr = await many('SELECT id, manager_user_id FROM event_houses WHERE event_id=$1', [i.id]);
    return board.map((h) => ({ ...h, members: counts.find((x) => x.house_id === h.house_id)?.n ?? 0, manager_user_id: mgr.find((x) => x.id === h.house_id)?.manager_user_id ?? null }));
  },
});

// ---------------------------------------------------------------- participants

const participantInput = z.object({
  full_name: z.string().min(1).max(120), house_id: id.optional(), user_id: id.optional(), gender: gender.optional(), grade: z.string().max(30).optional(), roll_no: z.string().max(40).optional(),
});

async function assertHouse(c, eventId, houseId) {
  const h = (await c.query('SELECT * FROM event_houses WHERE id=$1 AND event_id=$2 AND archived_at IS NULL', [houseId, eventId])).rows[0];
  if (!h) throw badRequest('That house is not part of this event');
  return h;
}
const dupe = (e) => { if (e.code === '23505') throw conflict('That person, account or roll number is already registered in this event'); throw e; };

cap({
  name: 'add_participant', method: 'POST', path: '/events/:id/participants', tag: TAG, status: 201,
  summary: 'Register a participant in a multi-sport event (organiser or the house master of that house). They need no account; link one with user_id when they have it.',
  input: participantInput.extend({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { scope } = await eventAccess(c, user, i.id);
      await programmeFor(c, i.id);
      if (!scope.organizer && !(i.house_id && scope.houseIds.includes(i.house_id))) throw forbidden('Only the organiser or the house master can register people');
      if (i.house_id) await assertHouse(c, i.id, i.house_id);
      if (i.user_id) await mustFind('users', i.user_id, 'id', c);
      try {
        return (await c.query('INSERT INTO event_participants(event_id, user_id, full_name, house_id, gender, grade, roll_no, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [i.id, i.user_id ?? null, i.full_name, i.house_id ?? null, i.gender ?? null, i.grade ?? null, i.roll_no ?? null, user.id])).rows[0];
      } catch (e) { dupe(e); }
    });
  },
});

cap({
  name: 'import_participants', method: 'POST', path: '/events/:id/participants/import', tag: TAG,
  summary: 'Bulk register a roster (up to 2000 rows) with a dry run and row-level errors. Houses are matched by name and created when missing. Existing roll numbers are skipped, never overwritten.',
  input: z.object({
    id, dry_run: z.boolean().default(true), create_houses: z.boolean().default(true),
    rows: z.array(z.object({ full_name: z.string().min(1).max(120), house: z.string().max(60).optional(), gender: gender.optional(), grade: z.string().max(30).optional(), roll_no: z.string().max(40).optional() })).min(1).max(2000),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await organizerOnly(c, user, i.id);
      await programmeFor(c, i.id);
      const houses = new Map((await c.query('SELECT id, lower(name) AS k FROM event_houses WHERE event_id=$1 AND archived_at IS NULL', [i.id])).rows.map((h) => [h.k, h.id]));
      const rolls = new Set((await c.query('SELECT roll_no FROM event_participants WHERE event_id=$1 AND roll_no IS NOT NULL', [i.id])).rows.map((r) => r.roll_no));
      const errors = [], seen = new Set(), created = { participants: 0, houses: 0 };
      for (const [n, r] of i.rows.entries()) {
        if (r.roll_no && (rolls.has(r.roll_no) || seen.has(r.roll_no))) { errors.push({ row: n + 1, error: `roll number ${r.roll_no} already exists` }); continue; }
        if (r.roll_no) seen.add(r.roll_no);
        let houseId = null;
        if (r.house) {
          const k = r.house.toLowerCase();
          if (!houses.has(k)) {
            if (!i.create_houses) { errors.push({ row: n + 1, error: `unknown house ${r.house}` }); continue; }
            if (!i.dry_run) houses.set(k, (await c.query("INSERT INTO event_houses(event_id, name) VALUES ($1,$2) RETURNING id", [i.id, r.house])).rows[0].id); else houses.set(k, null);
            created.houses++;
          }
          houseId = houses.get(k);
        }
        if (!i.dry_run) await c.query('INSERT INTO event_participants(event_id, full_name, house_id, gender, grade, roll_no, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [i.id, r.full_name, houseId, r.gender ?? null, r.grade ?? null, r.roll_no ?? null, user.id]);
        created.participants++;
      }
      return { dry_run: i.dry_run, would_create: created, errors, committed: !i.dry_run };
    });
  },
});

cap({
  name: 'list_participants', method: 'GET', path: '/events/:id/participants', tag: TAG,
  summary: 'Roster of a multi-sport event with each person\'s nominations. Organisers see everyone; a house master sees their house; a participant sees only themself.',
  input: z.object({ id, house_id: id.optional(), q: z.string().max(80).optional(), discipline_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const { scope } = await eventAccess(pool, user, i.id);
    if (!involved(scope)) throw forbidden();
    const w = ['p.event_id=$1', "p.status='active'"], args = [i.id];
    const p = (v) => { args.push(v); return `$${args.length}`; };
    if (!scope.organizer && !scope.staff.length) {
      const parts = [];
      if (scope.houseIds.length) parts.push(`p.house_id = ANY(${p(scope.houseIds)}::uuid[])`);
      if (scope.participantIds.length) parts.push(`p.id = ANY(${p(scope.participantIds)}::uuid[])`);
      w.push(`(${parts.join(' OR ')})`);
    }
    if (i.house_id) w.push(`p.house_id=${p(i.house_id)}`);
    if (i.q) w.push(`(p.full_name ILIKE ${p(`%${i.q}%`)} OR p.roll_no ILIKE $${args.length})`);
    if (i.discipline_id) w.push(`EXISTS (SELECT 1 FROM discipline_nominations n WHERE n.participant_id=p.id AND n.discipline_id=${p(i.discipline_id)} AND n.status IN ('nominated','confirmed'))`);
    return many(
      `SELECT p.id, p.full_name, p.user_id, p.house_id, h.name AS house, p.gender, p.grade, p.roll_no, p.medical_hold,
              coalesce((SELECT json_agg(json_build_object('discipline_id', n.discipline_id, 'name', d.name, 'status', n.status, 'team_id', n.team_id) ORDER BY d.name)
                          FROM discipline_nominations n JOIN event_disciplines d ON d.id=n.discipline_id WHERE n.participant_id=p.id AND n.status IN ('nominated','confirmed')), '[]') AS nominations
         FROM event_participants p LEFT JOIN event_houses h ON h.id=p.house_id WHERE ${w.join(' AND ')} ORDER BY p.full_name LIMIT ${p(i.limit)} OFFSET ${p(i.offset)}`, args);
  },
});

cap({
  name: 'update_participant', method: 'PATCH', path: '/participants/:id', tag: TAG,
  summary: 'Edit a participant, move them to another house, link their account, or withdraw them (withdrawn people drop out of unplayed sessions; history is kept).',
  input: z.object({ id, full_name: z.string().min(1).max(120).optional(), house_id: id.nullable().optional(), user_id: id.nullable().optional(), gender: gender.optional(), grade: z.string().max(30).optional(), roll_no: z.string().max(40).optional(), withdrawn: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM event_participants WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!p) throw notFound('Participant');
      const { scope } = await eventAccess(c, user, p.event_id);
      if (!canActFor(scope, p) || (!scope.organizer && (i.house_id !== undefined || i.user_id !== undefined))) throw forbidden('Only the organiser can move or link people; you can edit your own details');
      await lockEvent(c, p.event_id);
      if (i.house_id) await assertHouse(c, p.event_id, i.house_id);
      if (i.user_id) await mustFind('users', i.user_id, 'id', c);
      let row;
      try {
        row = (await c.query(
          `UPDATE event_participants SET full_name=coalesce($2,full_name), gender=coalesce($3,gender), grade=coalesce($4,grade), roll_no=coalesce($5,roll_no),
             house_id = CASE WHEN $6::boolean THEN $7::uuid ELSE house_id END, user_id = CASE WHEN $8::boolean THEN $9::uuid ELSE user_id END,
             status = CASE WHEN $10::boolean IS NULL THEN status WHEN $10 THEN 'withdrawn' ELSE 'active' END WHERE id=$1 RETURNING *`,
          [i.id, i.full_name ?? null, i.gender ?? null, i.grade ?? null, i.roll_no ?? null, i.house_id !== undefined, i.house_id ?? null, i.user_id !== undefined, i.user_id ?? null, i.withdrawn ?? null])).rows[0];
      } catch (e) { dupe(e); }
      if (i.house_id !== undefined) await c.query("UPDATE discipline_nominations SET house_id=$2 WHERE participant_id=$1 AND status IN ('nominated','confirmed')", [i.id, i.house_id ?? null]);
      if (i.withdrawn) {
        await c.query("UPDATE discipline_nominations SET status='withdrawn', team_id=NULL WHERE participant_id=$1 AND status IN ('nominated','confirmed')", [i.id]);
        await c.query("UPDATE event_session_entries e SET result_status='scratched' FROM event_sessions s WHERE s.id=e.session_id AND e.participant_id=$1 AND s.status IN ('draft','scheduled','live')", [i.id]);
      }
      return row;
    });
  },
});

// ---------------------------------------------------------------- disciplines

const disciplineFields = {
  gender: z.enum(['any', 'male', 'female']).optional(), eligible_grades: z.array(z.string().max(30)).max(30).nullable().optional(),
  team_size_min: z.number().int().min(1).max(50).optional(), team_size_max: z.number().int().min(1).max(50).optional(),
  max_per_house: z.number().int().min(1).max(500).optional(), points: placePoints.nullable().optional(),
  officials_required: z.number().int().min(0).max(20).optional(), venue_id: id.optional(),
};

cap({
  name: 'create_discipline', method: 'POST', path: '/events/:id/disciplines', tag: TAG, status: 201,
  summary: 'Add a sport to the event: 100m sprint, U14 football, relay… Choose individual or team, gender/grade eligibility, team size, entries per house, points per place and officials needed.',
  input: z.object({ id, sport: z.string(), name: z.string().min(2).max(100), mode: z.enum(['individual', 'team']).default('individual'), result_type: z.enum(['time', 'distance', 'score']).optional(), ...disciplineFields }),
  async handler({ user }, i) {
    const sport = await sportBySlugOrId(i.sport);
    if (!sport) throw notFound('Sport');
    return tx(async (c) => {
      await organizerOnly(c, user, i.id);
      await programmeFor(c, i.id);
      if (i.mode === 'team' && !i.team_size_min && !i.team_size_max) throw badRequest('Team disciplines need team_size_min / team_size_max');
      const resultType = i.result_type ?? (i.mode === 'team' ? 'score' : sport.scoring === 'time' ? 'time' : sport.scoring === 'distance' ? 'distance' : 'score');
      return (await c.query(
        `INSERT INTO event_disciplines(event_id, sport_id, name, mode, gender, eligible_grades, team_size_min, team_size_max, result_type, max_per_house, points, officials_required, venue_id, created_by)
         VALUES ($1,$2,$3,$4,coalesce($5,'any'),$6,$7,$8,$9,$10,$11,coalesce($12,1),$13,$14) RETURNING *`,
        [i.id, sport.id, i.name, i.mode, i.gender ?? null, i.eligible_grades ?? null, i.team_size_min ?? i.team_size_max ?? null, i.team_size_max ?? i.team_size_min ?? null, resultType, i.max_per_house ?? null,
          i.points ? JSON.stringify(i.points) : null, i.officials_required ?? null, i.venue_id ?? null, user.id])).rows[0];
    });
  },
});

cap({
  name: 'update_discipline', method: 'PATCH', path: '/disciplines/:id', tag: TAG,
  summary: 'Edit a discipline\'s rules, close/open nominations on it (status nominations → scheduled → ongoing) or cancel it. Cancelling withdraws all nominations and cancels its unplayed sessions; history is kept.',
  input: z.object({ id, name: z.string().min(2).max(100).optional(), status: z.enum(['nominations', 'scheduled', 'ongoing', 'cancelled']).optional(), ...disciplineFields }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM event_disciplines WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!d) throw notFound('Discipline');
      await organizerOnly(c, user, d.event_id);
      if (['completed', 'cancelled'].includes(d.status)) throw conflict(`Discipline is ${d.status}`);
      const min = i.team_size_min ?? d.team_size_min, max = i.team_size_max ?? d.team_size_max;
      if (min && max && max < min) throw badRequest('team_size_max is below team_size_min');
      const row = (await c.query(
        `UPDATE event_disciplines SET name=coalesce($2,name), status=coalesce($3,status), gender=coalesce($4,gender), eligible_grades = CASE WHEN $5::boolean THEN $6::text[] ELSE eligible_grades END,
           team_size_min=coalesce($7,team_size_min), team_size_max=coalesce($8,team_size_max), max_per_house=coalesce($9,max_per_house),
           points = CASE WHEN $10::boolean THEN $11::jsonb ELSE points END, officials_required=coalesce($12,officials_required), venue_id=coalesce($13,venue_id) WHERE id=$1 RETURNING *`,
        [i.id, i.name ?? null, i.status ?? null, i.gender ?? null, i.eligible_grades !== undefined, i.eligible_grades ?? null, i.team_size_min ?? null, i.team_size_max ?? null, i.max_per_house ?? null,
          i.points !== undefined, i.points ? JSON.stringify(i.points) : null, i.officials_required ?? null, i.venue_id ?? null])).rows[0];
      if (i.status === 'cancelled') {
        await c.query("UPDATE discipline_nominations SET status='withdrawn' WHERE discipline_id=$1 AND status IN ('nominated','confirmed')", [i.id]);
        await c.query("UPDATE event_sessions SET status='cancelled' WHERE discipline_id=$1 AND status IN ('draft','scheduled','live')", [i.id]);
        await c.query("UPDATE event_shifts SET status='cancelled' WHERE status='assigned' AND session_id IN (SELECT id FROM event_sessions WHERE discipline_id=$1)", [i.id]);
      }
      return row;
    });
  },
});

cap({
  name: 'list_disciplines', method: 'GET', path: '/events/:id/disciplines', tag: TAG, auth: 'public',
  summary: 'Disciplines of a multi-sport event with entrant, team and session counts, per-house fielding limits and the points table.',
  input: z.object({ id, include_cancelled: z.boolean().default(false) }),
  async handler(_, i) {
    const prog = await one('SELECT * FROM event_programmes WHERE event_id=$1', [i.id]);
    if (!prog) throw notFound('Multi-sport programme');
    const rows = await many(
      `SELECT d.*, s.slug AS sport, s.name AS sport_name, s.emoji,
              (SELECT count(*)::int FROM discipline_nominations n WHERE n.discipline_id=d.id AND n.status IN ('nominated','confirmed')) AS entrants,
              (SELECT count(*)::int FROM discipline_teams t WHERE t.discipline_id=d.id AND t.status='active') AS teams,
              (SELECT count(*)::int FROM event_sessions x WHERE x.discipline_id=d.id AND x.status <> 'cancelled') AS sessions,
              (SELECT count(*)::int FROM event_sessions x WHERE x.discipline_id=d.id AND x.status = 'completed') AS sessions_done
         FROM event_disciplines d JOIN sports s ON s.id=d.sport_id WHERE d.event_id=$1 AND ($2 OR d.status <> 'cancelled') ORDER BY d.name`, [i.id, i.include_cancelled]);
    return rows.map((d) => ({ ...d, points_table: d.points ?? prog.default_points }));
  },
});

// ---------------------------------------------------------------- nominations

async function nominateOne(c, { user, scope, ev, prog, d, p, seed, teamId = null, status = 'nominated' }) {
  if (p.event_id !== ev.id || p.status !== 'active') throw badRequest('That participant is not active in this event');
  if (!canActFor(scope, p)) throw forbidden('You cannot nominate this person');
  if (d.event_id !== ev.id) throw badRequest('That discipline belongs to another event');
  if (['completed', 'cancelled', 'draft'].includes(d.status)) throw conflict(`Discipline is ${d.status}`);
  if (!scope.organizer && (!prog.nominations_open || d.status !== 'nominations')) throw conflict('Nominations are closed for this discipline');
  if (p.medical_hold) throw conflict(`${p.full_name} is on a medical hold and cannot be nominated`);
  if (d.gender !== 'any' && p.gender !== d.gender) throw badRequest(`${d.name} is for ${d.gender} participants only`);
  if (d.eligible_grades && !d.eligible_grades.includes(p.grade)) throw badRequest(`${d.name} is open to grades ${d.eligible_grades.join(', ')} only`);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('nominate:' || $1::text, 0))", [p.id]);
  const existing = (await c.query('SELECT * FROM discipline_nominations WHERE discipline_id=$1 AND participant_id=$2 FOR UPDATE', [d.id, p.id])).rows[0];
  if (existing && ['nominated', 'confirmed'].includes(existing.status)) {
    if (teamId && existing.team_id !== teamId) return (await c.query("UPDATE discipline_nominations SET team_id=$2, status='confirmed' WHERE id=$1 RETURNING *", [existing.id, teamId])).rows[0];
    throw conflict(`${p.full_name} is already nominated for ${d.name}`);
  }
  const limit = d.mode === 'team' ? prog.max_team_entries : prog.max_individual_entries;
  const used = (await c.query(
    `SELECT count(*)::int AS n FROM discipline_nominations n JOIN event_disciplines x ON x.id=n.discipline_id
      WHERE n.participant_id=$1 AND n.status IN ('nominated','confirmed') AND x.mode=$2 AND x.status <> 'cancelled'`, [p.id, d.mode])).rows[0].n;
  if (used >= limit) throw conflict(`${p.full_name} is already in ${used} ${d.mode} discipline(s); the limit is ${limit}`);
  if (d.mode === 'individual' && d.max_per_house && p.house_id) {
    const n = (await c.query("SELECT count(*)::int AS n FROM discipline_nominations WHERE discipline_id=$1 AND house_id=$2 AND status IN ('nominated','confirmed')", [d.id, p.house_id])).rows[0].n;
    if (n >= d.max_per_house) throw conflict(`That house already fields ${n} entrants in ${d.name} (max ${d.max_per_house})`);
  }
  if (existing) return (await c.query('UPDATE discipline_nominations SET status=$2, team_id=$3, house_id=$4, seed=coalesce($5,seed) WHERE id=$1 RETURNING *', [existing.id, status, teamId, p.house_id, seed ?? null])).rows[0];
  return (await c.query('INSERT INTO discipline_nominations(discipline_id, participant_id, house_id, team_id, status, seed, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [d.id, p.id, p.house_id, teamId, status, seed ?? null, user.id])).rows[0];
}

async function nominationContext(c, user, disciplineId) {
  const d = (await c.query('SELECT * FROM event_disciplines WHERE id=$1', [disciplineId])).rows[0];
  if (!d) throw notFound('Discipline');
  const { ev, scope } = await eventAccess(c, user, d.event_id);
  return { d, ev, scope, prog: await programmeFor(c, ev.id) };
}

cap({
  name: 'nominate_participant', method: 'POST', path: '/disciplines/:id/nominations', tag: TAG, status: 201,
  summary: 'Nominate a participant into a discipline (organiser, their house master, or the person themself). Enforces gender/grade eligibility, the per-person limit across disciplines, entrants per house and medical holds. One person can be in several disciplines.',
  input: z.object({ id, participant_id: id, seed: z.number().optional().describe('personal best used to balance heats (seconds, metres or points)') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { d, ev, scope, prog } = await nominationContext(c, user, i.id);
      const p = (await c.query('SELECT * FROM event_participants WHERE id=$1', [i.participant_id])).rows[0];
      if (!p) throw notFound('Participant');
      if (d.mode === 'team') throw badRequest('Team disciplines are entered by building a team (create_discipline_team)');
      return nominateOne(c, { user, scope, ev, prog, d, p, seed: i.seed });
    });
  },
});

cap({
  name: 'nominate_many', method: 'POST', path: '/disciplines/:id/nominations/bulk', tag: TAG,
  summary: 'Nominate several participants into one discipline (individual: entered directly; team: put in the pool that build_house_teams draws from). Returns a result per person; one failure does not block the rest.',
  input: z.object({ id, participant_ids: z.array(id).min(1).max(500) }),
  async handler({ user }, i) {
    const results = [];
    for (const pid of i.participant_ids) {
      try {
        const n = await tx(async (c) => {
          const { d, ev, scope, prog } = await nominationContext(c, user, i.id);
          const p = (await c.query('SELECT * FROM event_participants WHERE id=$1', [pid])).rows[0];
          if (!p) throw notFound('Participant');
          return nominateOne(c, { user, scope, ev, prog, d, p });
        });
        results.push({ participant_id: pid, ok: true, nomination_id: n.id });
      } catch (e) { results.push({ participant_id: pid, ok: false, error: e.message }); }
    }
    return { requested: results.length, nominated: results.filter((r) => r.ok).length, results };
  },
});

cap({
  name: 'withdraw_nomination', method: 'POST', path: '/nominations/:id/withdraw', tag: TAG,
  summary: 'Take a participant out of a discipline. They leave their team and their unplayed sessions (marked scratched); completed results stay.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const n = (await c.query('SELECT * FROM discipline_nominations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!n) throw notFound('Nomination');
      const d = (await c.query('SELECT * FROM event_disciplines WHERE id=$1', [n.discipline_id])).rows[0];
      const p = (await c.query('SELECT * FROM event_participants WHERE id=$1', [n.participant_id])).rows[0];
      const { scope } = await eventAccess(c, user, d.event_id);
      if (!canActFor(scope, p)) throw forbidden();
      if (['withdrawn', 'rejected'].includes(n.status)) return n;
      await lockEvent(c, d.event_id);
      const row = (await c.query("UPDATE discipline_nominations SET status='withdrawn', team_id=NULL WHERE id=$1 RETURNING *", [i.id])).rows[0];
      await c.query(
        `UPDATE event_session_entries e SET result_status='scratched' FROM event_sessions s
          WHERE s.id=e.session_id AND s.discipline_id=$1 AND e.participant_id=$2 AND s.status IN ('draft','scheduled','live')`, [n.discipline_id, n.participant_id]);
      return row;
    });
  },
});

cap({
  name: 'list_nominations', method: 'GET', path: '/disciplines/:id/nominations', tag: TAG,
  summary: 'Who is entered in a discipline (organiser/house master/crew), with their house, seed and team. House masters see their own house.',
  input: z.object({ id, house_id: id.optional() }),
  async handler({ user }, i) {
    const { d, scope } = await nominationContext(pool, user, i.id);
    if (!involved(scope)) throw forbidden();
    const all = scope.organizer || scope.staff.length;
    return many(
      `SELECT n.id, n.status, n.seed, n.team_id, t.name AS team_name, p.id AS participant_id, p.full_name, p.gender, p.grade, p.house_id, h.name AS house
         FROM discipline_nominations n JOIN event_participants p ON p.id=n.participant_id LEFT JOIN event_houses h ON h.id=p.house_id LEFT JOIN discipline_teams t ON t.id=n.team_id
        WHERE n.discipline_id=$1 AND n.status IN ('nominated','confirmed') AND ($2::uuid IS NULL OR p.house_id=$2)
          AND ($3 OR p.house_id = ANY($4::uuid[]) OR p.id = ANY($5::uuid[])) ORDER BY h.name NULLS LAST, p.full_name`,
      [d.id, i.house_id ?? null, !!all, scope.houseIds, scope.participantIds]);
  },
});

// ---------------------------------------------------------------- teams

async function loadTeamMembers(c, teamId) {
  return (await c.query(
    `SELECT n.id AS nomination_id, p.id AS participant_id, p.full_name, p.grade, p.gender, p.house_id
       FROM discipline_nominations n JOIN event_participants p ON p.id=n.participant_id WHERE n.team_id=$1 AND n.status IN ('nominated','confirmed') ORDER BY p.full_name`, [teamId])).rows;
}
function assertTeamSize(d, count, label = 'Team') {
  if (d.team_size_min && count < d.team_size_min) throw badRequest(`${label} needs at least ${d.team_size_min} players (has ${count})`);
  if (d.team_size_max && count > d.team_size_max) throw badRequest(`${label} can have at most ${d.team_size_max} players (has ${count})`);
}

cap({
  name: 'create_discipline_team', method: 'POST', path: '/disciplines/:id/teams', tag: TAG, status: 201,
  summary: 'Build a team for a team discipline (organiser or the house master). Members are nominated as part of this, with the same limits (one person can play in several team sports). Checks team size, house membership and teams per house.',
  input: z.object({ id, name: z.string().min(1).max(80), house_id: id.optional(), member_ids: z.array(id).min(1).max(60), captain_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { d, ev, scope, prog } = await nominationContext(c, user, i.id);
      if (d.mode !== 'team') throw badRequest('This discipline is individual');
      if (!scope.organizer && !(i.house_id && scope.houseIds.includes(i.house_id))) throw forbidden('Only the organiser or the house master can build this team');
      if (i.house_id) await assertHouse(c, ev.id, i.house_id);
      if (i.captain_id && !i.member_ids.includes(i.captain_id)) throw badRequest('The captain must be a member');
      if (new Set(i.member_ids).size !== i.member_ids.length) throw badRequest('A player is listed twice');
      assertTeamSize(d, i.member_ids.length);
      if (d.max_per_house && i.house_id) {
        const n = (await c.query("SELECT count(*)::int AS n FROM discipline_teams WHERE discipline_id=$1 AND house_id=$2 AND status='active'", [d.id, i.house_id])).rows[0].n;
        if (n >= d.max_per_house) throw conflict(`That house already fields ${n} team(s) in ${d.name} (max ${d.max_per_house})`);
      }
      let team;
      try {
        team = (await c.query('INSERT INTO discipline_teams(discipline_id, house_id, name, captain_participant_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [d.id, i.house_id ?? null, i.name, i.captain_id ?? null, user.id])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('A team with that name already exists in this discipline'); throw e; }
      for (const pid of i.member_ids) {
        const p = (await c.query('SELECT * FROM event_participants WHERE id=$1', [pid])).rows[0];
        if (!p) throw notFound('Participant');
        if (i.house_id && p.house_id !== i.house_id) throw badRequest(`${p.full_name} is not in that house`);
        await nominateOne(c, { user, scope, ev, prog, d, p, teamId: team.id, status: 'confirmed' });
      }
      return { ...team, members: await loadTeamMembers(c, team.id) };
    });
  },
});

cap({
  name: 'update_discipline_team', method: 'PATCH', path: '/teams-in-discipline/:id', tag: TAG,
  summary: 'Rename a discipline team, change its captain, add or remove members, or withdraw it (not once it is in a completed session).',
  input: z.object({ id, name: z.string().min(1).max(80).optional(), captain_id: id.nullable().optional(), add_member_ids: z.array(id).max(60).optional(), remove_member_ids: z.array(id).max(60).optional(), withdraw: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM discipline_teams WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!t) throw notFound('Team');
      const { d, ev, scope, prog } = await nominationContext(c, user, t.discipline_id);
      if (!scope.organizer && !(t.house_id && scope.houseIds.includes(t.house_id))) throw forbidden();
      if (t.status !== 'active') throw conflict('Team is withdrawn');
      await lockEvent(c, ev.id);
      const played = (await c.query("SELECT 1 FROM event_session_entries e JOIN event_sessions s ON s.id=e.session_id WHERE e.team_id=$1 AND s.status='completed'", [t.id])).rowCount;
      if (played && (i.withdraw || i.remove_member_ids?.length || i.add_member_ids?.length)) throw conflict('This team has already played; its line-up is locked');
      for (const pid of i.remove_member_ids ?? []) await c.query("UPDATE discipline_nominations SET team_id=NULL, status='withdrawn' WHERE discipline_id=$1 AND participant_id=$2 AND team_id=$3", [d.id, pid, t.id]);
      for (const pid of i.add_member_ids ?? []) {
        const p = (await c.query('SELECT * FROM event_participants WHERE id=$1', [pid])).rows[0];
        if (!p) throw notFound('Participant');
        if (t.house_id && p.house_id !== t.house_id) throw badRequest(`${p.full_name} is not in that house`);
        await nominateOne(c, { user, scope, ev, prog, d, p, teamId: t.id, status: 'confirmed' });
      }
      const members = await loadTeamMembers(c, t.id);
      if (!i.withdraw) assertTeamSize(d, members.length);
      if (i.captain_id && !members.some((m) => m.participant_id === i.captain_id)) throw badRequest('The captain must be a member');
      if (i.withdraw) {
        await c.query("UPDATE discipline_nominations SET team_id=NULL, status='withdrawn' WHERE team_id=$1", [t.id]);
        await c.query("UPDATE event_session_entries SET result_status='scratched' WHERE team_id=$1 AND session_id IN (SELECT id FROM event_sessions WHERE status IN ('draft','scheduled','live'))", [t.id]);
      }
      const row = (await c.query(
        `UPDATE discipline_teams SET name=coalesce($2,name), captain_participant_id = CASE WHEN $3::boolean THEN $4::uuid ELSE captain_participant_id END, status = CASE WHEN $5::boolean THEN 'withdrawn' ELSE status END WHERE id=$1 RETURNING *`,
        [t.id, i.name ?? null, i.captain_id !== undefined, i.captain_id ?? null, !!i.withdraw])).rows[0];
      return { ...row, members: i.withdraw ? [] : members };
    });
  },
});

cap({
  name: 'build_house_teams', method: 'POST', path: '/disciplines/:id/teams/build', tag: TAG, status: 201,
  summary: 'Auto-build one team per house from the nominated pool of a team discipline (first nominated, up to the maximum team size). Houses below the minimum are reported, not built; extras stay in the pool as reserves.',
  input: z.object({ id, house_id: id.optional().describe('only this house (house masters may build their own)') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { d, ev, scope } = await nominationContext(c, user, i.id);
      if (d.mode !== 'team') throw badRequest('This discipline is individual');
      if (!scope.organizer && !(i.house_id && scope.houseIds.includes(i.house_id))) throw forbidden('Only the organiser (or a house master for their own house) can build teams');
      const houses = (await c.query('SELECT * FROM event_houses WHERE event_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id=$2) ORDER BY name', [ev.id, i.house_id ?? null])).rows;
      const built = [], skipped = [];
      for (const h of houses) {
        if ((await c.query("SELECT 1 FROM discipline_teams WHERE discipline_id=$1 AND house_id=$2 AND status='active'", [d.id, h.id])).rowCount) { skipped.push({ house_id: h.id, house: h.name, reason: 'already has a team' }); continue; }
        const pool = (await c.query(
          "SELECT n.id FROM discipline_nominations n JOIN event_participants p ON p.id=n.participant_id WHERE n.discipline_id=$1 AND n.house_id=$2 AND n.team_id IS NULL AND n.status='nominated' AND p.status='active' ORDER BY n.created_at, n.id", [d.id, h.id])).rows;
        if (d.team_size_min && pool.length < d.team_size_min) { skipped.push({ house_id: h.id, house: h.name, reason: `only ${pool.length} nominated (needs ${d.team_size_min})` }); continue; }
        if (!pool.length) { skipped.push({ house_id: h.id, house: h.name, reason: 'nobody nominated' }); continue; }
        const take = pool.slice(0, d.team_size_max ?? pool.length);
        const t = (await c.query('INSERT INTO discipline_teams(discipline_id, house_id, name, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [d.id, h.id, `${h.name} ${d.name}`.slice(0, 80), user.id])).rows[0];
        await c.query("UPDATE discipline_nominations SET team_id=$1, status='confirmed' WHERE id = ANY($2::uuid[])", [t.id, take.map((x) => x.id)]);
        built.push({ ...t, members: take.length, reserves: pool.length - take.length });
      }
      return { built, skipped };
    });
  },
});

cap({
  name: 'list_discipline_teams', method: 'GET', path: '/disciplines/:id/teams', tag: TAG,
  summary: 'Teams of a team discipline with their players. Organisers/crew see all; house masters their own house.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { d, scope } = await nominationContext(pool, user, i.id);
    if (!involved(scope)) throw forbidden();
    const all = scope.organizer || scope.staff.length;
    return many(
      `SELECT t.id, t.name, t.house_id, h.name AS house, t.captain_participant_id, t.status,
              coalesce((SELECT json_agg(json_build_object('participant_id', p.id, 'full_name', p.full_name, 'grade', p.grade) ORDER BY p.full_name)
                          FROM discipline_nominations n JOIN event_participants p ON p.id=n.participant_id WHERE n.team_id=t.id AND n.status IN ('nominated','confirmed')), '[]') AS members
         FROM discipline_teams t LEFT JOIN event_houses h ON h.id=t.house_id
        WHERE t.discipline_id=$1 AND t.status='active' AND ($2 OR t.house_id = ANY($3::uuid[])) ORDER BY h.name NULLS LAST, t.name`, [d.id, !!all, scope.houseIds]);
  },
});
