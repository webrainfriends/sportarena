// Hiring for an event: open positions (referees, doctors, physios, scorers, volunteers ...), invitations, acceptance, release.
// Nothing is deleted: every assignment moves through statuses and each transition is appended to event_staff_history.
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isAdmin, mustFind } from '../helpers.js';
import { eventForOrganizer } from './events.js';
import { notify } from '../notify.js';

const ROLES = ['referee', 'umpire', 'linesman', 'scorer', 'doctor', 'physio', 'medic', 'volunteer', 'security', 'other'];
const OFFICIAL = ['referee', 'umpire', 'linesman'];
const OPEN = ['invited', 'accepted'];

const lockPerson = (c, userId) => c.query("SELECT pg_advisory_xact_lock(hashtextextended('event_staff:' || $1::text, 0))", [userId]);
const history = (c, assignmentId, actor, from, to, reason) => c.query('INSERT INTO event_staff_history(assignment_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [assignmentId, actor, from, to, reason ?? null]);

/** Credential, time-off and double-booking checks for a person on an event's dates. Call after lockPerson. */
async function assertEligible(c, ev, role, userId) {
  if (OFFICIAL.includes(role)) {
    if (!(await c.query("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role='referee' AND sport_id=$2", [userId, ev.sport_id])).rowCount) throw badRequest('That person is not a referee for this sport');
  } else if (['doctor', 'physio', 'medic'].includes(role)) {
    const p = (await c.query('SELECT provider_type FROM provider_profiles WHERE user_id=$1', [userId])).rows[0];
    if (!p || (role !== 'medic' && p.provider_type !== role)) throw badRequest(role === 'medic' ? 'That person has no doctor/physio profile' : `That person is not a registered ${role}`);
  }
  if (!ev.starts_on) return;
  const from = ev.starts_on, to = ev.ends_on ?? ev.starts_on;
  if ((await c.query("SELECT 1 FROM provider_time_off WHERE provider_id=$1 AND removed_at IS NULL AND starts_at < ($3::date + 1) AND ends_at > $2::date", [userId, from, to])).rowCount) throw conflict('That person has time off during the event');
  const clash = await c.query(
    `SELECT e.name FROM event_staff_assignments a JOIN events e ON e.id=a.event_id
      WHERE a.user_id=$1 AND a.status='accepted' AND a.event_id <> $2 AND e.status NOT IN ('cancelled','completed') AND e.starts_on IS NOT NULL
        AND e.starts_on <= $4::date AND coalesce(e.ends_on, e.starts_on) >= $3::date LIMIT 1`, [userId, ev.id, from, to]);
  if (clash.rowCount) throw conflict(`That person is already committed to ${clash.rows[0].name} on those dates`);
}

cap({
  name: 'define_staff_role', method: 'POST', path: '/events/:id/staff-roles', tag: 'Event staff', status: 201,
  summary: 'Open a position for the event (referee, umpire, linesman, scorer, doctor, physio, medic, volunteer, security, other) with a headcount and fee.',
  input: z.object({ id, role: z.enum(ROLES), title: z.string().max(100).optional(), needed: z.number().int().min(1).max(500).default(1), fee_cents: money.default(0), currency: z.string().length(3).optional(), notes: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    return (await pool.query('INSERT INTO event_staff_roles(event_id, role, title, needed, fee_cents, currency, notes, created_by) VALUES ($1,$2,$3,$4,$5,upper($6),$7,$8) RETURNING *',
      [i.id, i.role, i.title ?? null, i.needed, i.fee_cents, i.currency ?? ev.currency, i.notes ?? null, user.id])).rows[0];
  },
});

cap({
  name: 'list_staff_roles', method: 'GET', path: '/events/:id/staff-roles', tag: 'Event staff', auth: 'public', summary: 'Open and filled positions for an event, with how many are confirmed.',
  input: z.object({ id }),
  async handler(_, i) {
    await mustFind('events', i.id, 'id');
    return many(
      `SELECT r.*, (SELECT count(*)::int FROM event_staff_assignments a WHERE a.role_id=r.id AND a.status='accepted') AS filled,
              (SELECT count(*)::int FROM event_staff_assignments a WHERE a.role_id=r.id AND a.status='invited') AS pending
         FROM event_staff_roles r WHERE r.event_id=$1 ORDER BY r.created_at`, [i.id]);
  },
});

cap({
  name: 'close_staff_role', method: 'POST', path: '/staff-roles/:id/close', tag: 'Event staff', summary: 'Stop filling a position (kept as closed). Open invitations are not affected.', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await mustFind('event_staff_roles', i.id);
    await eventForOrganizer(user, r.event_id);
    return (await pool.query('UPDATE event_staff_roles SET closed_at=coalesce(closed_at, now()) WHERE id=$1 RETURNING *', [i.id])).rows[0];
  },
});

cap({
  name: 'search_staff_candidates', method: 'GET', path: '/events/:id/staff-candidates', tag: 'Event staff',
  summary: 'Find people for a position: referees by sport profile, doctors/physios by provider profile (optionally by city). People with time off or a clashing commitment on the event dates are left out.',
  input: z.object({ id, role: z.enum(ROLES), city: z.string().max(80).optional(), q: z.string().max(80).optional(), ...page }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const from = ev.starts_on, to = ev.ends_on ?? ev.starts_on;
    const free = `AND ($4::date IS NULL OR (
        NOT EXISTS (SELECT 1 FROM provider_time_off t WHERE t.provider_id=u.id AND t.removed_at IS NULL AND t.starts_at < ($5::date + 1) AND t.ends_at > $4::date)
        AND NOT EXISTS (SELECT 1 FROM event_staff_assignments a JOIN events x ON x.id=a.event_id WHERE a.user_id=u.id AND a.status='accepted' AND a.event_id <> $1 AND x.status NOT IN ('cancelled','completed')
                          AND x.starts_on IS NOT NULL AND x.starts_on <= $5::date AND coalesce(x.ends_on, x.starts_on) >= $4::date)))`;
    const q = i.q ? `%${i.q}%` : null;
    if (OFFICIAL.includes(i.role)) {
      return many(
        `SELECT u.id AS user_id, u.handle, u.display_name, sp.level, sp.hourly_rate_cents FROM sport_profiles sp JOIN users u ON u.id=sp.user_id
          WHERE sp.sport_id=$2 AND sp.role='referee' AND ($3::text IS NULL OR u.display_name ILIKE $3 OR u.handle ILIKE $3) ${free}
            AND NOT EXISTS (SELECT 1 FROM event_staff_assignments a WHERE a.event_id=$1 AND a.user_id=u.id AND a.status IN ('invited','accepted') AND a.role_id IN (SELECT id FROM event_staff_roles WHERE role=$8))
          ORDER BY u.display_name LIMIT $6 OFFSET $7`, [i.id, ev.sport_id, q, from, to, i.limit, i.offset, i.role]);
    }
    if (['doctor', 'physio', 'medic'].includes(i.role)) {
      return many(
        `SELECT u.id AS user_id, u.handle, u.display_name, pp.provider_type, pp.clinic, pp.city, pp.specialties FROM provider_profiles pp JOIN users u ON u.id=pp.user_id
          WHERE ($8::text = 'medic' OR pp.provider_type=$8) AND ($2::text IS NULL OR lower(pp.city)=lower($2)) AND ($3::text IS NULL OR u.display_name ILIKE $3 OR u.handle ILIKE $3) ${free}
          ORDER BY u.display_name LIMIT $6 OFFSET $7`, [i.id, i.city ?? null, q, from, to, i.limit, i.offset, i.role]);
    }
    return many(
      `SELECT u.id AS user_id, u.handle, u.display_name FROM users u WHERE $2::text IS NULL AND $8::text IS NOT NULL AND ($3::text IS NULL OR u.display_name ILIKE $3 OR u.handle ILIKE $3) ${free} ORDER BY u.display_name LIMIT $6 OFFSET $7`,
      [i.id, null, q, from, to, i.limit, i.offset, i.role]);
  },
});

cap({
  name: 'invite_staff', method: 'POST', path: '/staff-roles/:id/invite', tag: 'Event staff', status: 201,
  summary: 'Invite a person to fill a position. Credentials (referee / doctor / physio profile), time off and clashes with their other events are checked; they accept or decline.',
  input: z.object({ id, user_id: id, fee_cents: money.optional(), message: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const role = (await c.query('SELECT * FROM event_staff_roles WHERE id=$1', [i.id])).rows[0];
      if (!role) throw notFound('Position');
      const ev = await eventForOrganizer(user, role.event_id, c);
      if (role.closed_at) throw conflict('This position is closed');
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      await mustFind('users', i.user_id, 'id', c);
      await lockPerson(c, i.user_id);
      await assertEligible(c, ev, role.role, i.user_id);
      const dup = await c.query("SELECT 1 FROM event_staff_assignments WHERE role_id=$1 AND user_id=$2 AND status IN ('invited','accepted')", [role.id, i.user_id]);
      if (dup.rowCount) throw conflict('That person already has this position');
      const a = (await c.query('INSERT INTO event_staff_assignments(role_id, event_id, user_id, fee_cents, message, invited_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [role.id, ev.id, i.user_id, i.fee_cents ?? role.fee_cents, i.message ?? null, user.id])).rows[0];
      await history(c, a.id, user.id, null, 'invited', null);
      await notify(c, i.user_id, { kind: 'event_staff', title: `Role offer: ${ev.name}`, body: i.message || `You are invited to work ${ev.name} as ${role.title || role.role}.`, data: { event_id: ev.id, assignment_id: a.id } });
      return a;
    });
  },
});

cap({
  name: 'respond_staff_assignment', method: 'POST', path: '/staff-assignments/:id/respond', tag: 'Event staff',
  summary: 'Accept or decline a role offer (the invited person). Accepting is refused when the position is already filled or the dates now clash.',
  input: z.object({ id, accept: z.boolean(), reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a0 = await mustFind('event_staff_assignments', i.id, '*', c);
      if (a0.user_id !== user.id && !isAdmin(user)) throw notFound('Assignment');
      await lockPerson(c, a0.user_id);
      const role = (await c.query('SELECT * FROM event_staff_roles WHERE id=$1 FOR UPDATE', [a0.role_id])).rows[0];
      const a = (await c.query('SELECT * FROM event_staff_assignments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (a.status !== 'invited') throw conflict(`Assignment is already ${a.status}`);
      const ev = await mustFind('events', a.event_id, '*', c);
      if (i.accept) {
        if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
        if ((await c.query("SELECT count(*)::int AS n FROM event_staff_assignments WHERE role_id=$1 AND status='accepted'", [role.id])).rows[0].n >= role.needed) throw conflict('All places for this position are filled');
        await assertEligible(c, ev, role.role, a.user_id);
      }
      const to = i.accept ? 'accepted' : 'declined';
      const out = (await c.query('UPDATE event_staff_assignments SET status=$2, responded_at=now() WHERE id=$1 RETURNING *', [a.id, to])).rows[0];
      await history(c, a.id, user.id, 'invited', to, i.reason);
      await notify(c, a.invited_by, { kind: 'event_staff', title: `Role offer ${to}`, body: `${ev.name}: a ${role.role} offer was ${to}.`, data: { event_id: ev.id, assignment_id: a.id } });
      return out;
    });
  },
});

cap({
  name: 'end_staff_assignment', method: 'POST', path: '/staff-assignments/:id/end', tag: 'Event staff',
  summary: 'Release someone from the event (organiser) or withdraw from it (the person). Kept in history; the place reopens.',
  input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM event_staff_assignments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a) throw notFound('Assignment');
      const mine = a.user_id === user.id;
      if (!mine) await eventForOrganizer(user, a.event_id, c);
      if (!OPEN.includes(a.status)) throw conflict(`Assignment is already ${a.status}`);
      const to = mine ? 'withdrawn' : 'released';
      const out = (await c.query('UPDATE event_staff_assignments SET status=$2, responded_at=coalesce(responded_at, now()) WHERE id=$1 RETURNING *', [a.id, to])).rows[0];
      await history(c, a.id, user.id, a.status, to, i.reason);
      const ev = await mustFind('events', a.event_id, 'name, organizer_id', c);
      await notify(c, mine ? ev.organizer_id : a.user_id, { kind: 'event_staff', title: mine ? 'Staff member withdrew' : 'Role released', body: `${ev.name}: assignment ${to}.`, data: { event_id: a.event_id, assignment_id: a.id } });
      return out;
    });
  },
});

cap({
  name: 'list_tournament_staff', method: 'GET', path: '/events/:id/staff-assignments', tag: 'Event staff', summary: 'Everyone invited or confirmed for the event, by position (organiser).',
  input: z.object({ id, status: z.enum(['invited', 'accepted', 'declined', 'released', 'withdrawn', 'completed']).optional() }),
  async handler({ user }, i) {
    await eventForOrganizer(user, i.id);
    return many(
      `SELECT a.*, r.role, r.title, u.handle, u.display_name FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id JOIN users u ON u.id=a.user_id
        WHERE a.event_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY r.created_at, a.created_at`, [i.id, i.status ?? null]);
  },
});

cap({
  name: 'list_my_staff_assignments', method: 'GET', path: '/me/staff-assignments', tag: 'Event staff', summary: 'Event roles offered to you or confirmed for you.',
  input: z.object({ status: z.enum(['invited', 'accepted', 'declined', 'released', 'withdrawn', 'completed']).optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT a.*, r.role, r.title, e.name AS event_name, e.starts_on, e.ends_on, e.city FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id JOIN events e ON e.id=a.event_id
      WHERE a.user_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY e.starts_on NULLS LAST, a.created_at DESC LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]),
});
