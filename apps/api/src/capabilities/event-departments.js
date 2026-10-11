import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind, PUBLIC_USER } from '../helpers.js';
import { encrypt, decrypt, blindIndex } from '../crypto.js';
import { hasOrgGrant } from '../org-access.js';
import { notify } from '../notify.js';
import { eventForOrganizer } from './events.js';

export const DEPARTMENT_KINDS = {
  operations: 'Run the day: gates, schedule, runners, control room',
  medical: 'First aid, doctors, physios, ambulance cover',
  media: 'Photo, video, social, live commentary',
  hospitality: 'Food, water, teams and VIP care',
  security: 'Crowd, access control, safety',
  volunteers: 'Marshals, ushers, help desk',
  officials: 'Referees, umpires, scorers, timekeepers',
  logistics: 'Equipment, transport, stay, kit',
  tech: 'Scoreboards, streaming, power, networks',
  ceremonies: 'Opening, closing, podium and awards',
  custom: 'Anything else you need',
};
const kind = z.enum(Object.keys(DEPARTMENT_KINDS));
const colour = z.string().regex(/^#[0-9A-Fa-f]{6}$/).describe('hex colour, e.g. from the colour picker');
const PII = ['phone', 'dob', 'id_number'];

export const isOrganiser = async (user, ev, c) => isAdmin(user) || user.id === ev.organizer_id || (await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c));

/** Who the caller is for this event: organiser, lead of some departments, or just a member of some. */
export async function departmentScope(user, ev, c) {
  const organiser = await isOrganiser(user, ev, c);
  const mine = (await (c ?? pool).query(
    "SELECT department_id, role FROM event_department_members WHERE event_id=$1 AND user_id=$2 AND status='active'", [ev.id, user.id])).rows;
  const led = new Set(mine.filter((m) => m.role === 'lead').map((m) => m.department_id));
  const leadDepts = (await (c ?? pool).query("SELECT id FROM event_departments WHERE event_id=$1 AND lead_user_id=$2 AND status='active'", [ev.id, user.id])).rows;
  for (const d of leadDepts) led.add(d.id);
  return { organiser, led, member: new Set(mine.map((m) => m.department_id)) };
}
const canRun = (scope, deptId) => scope.organiser || scope.led.has(deptId);

async function dept(deptId, c) {
  const d = (await (c ?? pool).query('SELECT * FROM event_departments WHERE id=$1', [deptId])).rows[0];
  if (!d) throw notFound('Department');
  return d;
}

cap({
  name: 'list_department_kinds', method: 'GET', path: '/department-kinds', tag: 'Departments', auth: 'public',
  summary: 'The kinds of department an event can have, with what each one does.', input: z.object({}),
  handler: async () => Object.entries(DEPARTMENT_KINDS).map(([key, description]) => ({ key, description })),
});

cap({
  name: 'create_department', method: 'POST', path: '/events/:id/departments', tag: 'Departments', status: 201,
  summary: 'Add a department to an event you organise. Optionally name its lead, who is invited like any member and may then run the department.',
  input: z.object({ id, name: z.string().min(2).max(80), kind: kind.default('custom'), description: z.string().max(500).optional(), colour: colour.optional(), lead_user_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      if ((await c.query("SELECT 1 FROM event_departments WHERE event_id=$1 AND lower(name)=lower($2) AND status='active'", [i.id, i.name])).rowCount) throw conflict('A department with that name already exists');
      const d = (await c.query(
        `INSERT INTO event_departments(event_id, name, kind, description, colour, lead_user_id, created_by) VALUES ($1,$2,$3,$4,coalesce($5,'#7C3AED'),$6,$7) RETURNING *`,
        [i.id, i.name, i.kind, i.description ?? null, i.colour ?? null, i.lead_user_id ?? null, user.id])).rows[0];
      if (i.lead_user_id) {
        await mustFind('users', i.lead_user_id, 'id', c);
        await c.query("INSERT INTO event_department_members(department_id, event_id, user_id, role, status, invited_by, joined_at) VALUES ($1,$2,$3,'lead','invited',$4,NULL)", [d.id, i.id, i.lead_user_id, user.id]);
        await notify(c, i.lead_user_id, { kind: 'department_invite', title: 'You are asked to lead a department', body: `${ev.name}: ${d.name}`, data: { event_id: ev.id, department_id: d.id } });
      }
      return d;
    });
  },
});

cap({
  name: 'list_departments', method: 'GET', path: '/events/:id/departments', tag: 'Departments',
  summary: 'Departments of an event with head-counts. The organiser sees all; others see the departments they belong to.',
  input: z.object({ id, include_archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    const scope = await departmentScope(user, ev);
    const rows = await many(
      `SELECT d.*, lu.display_name AS lead_name,
              (SELECT count(*)::int FROM event_department_members m WHERE m.department_id=d.id AND m.status='active') AS active_members,
              (SELECT count(*)::int FROM event_department_members m WHERE m.department_id=d.id AND m.status='invited') AS invited_members
         FROM event_departments d LEFT JOIN users lu ON lu.id=d.lead_user_id
        WHERE d.event_id=$1 AND ($2 OR d.status='active') ORDER BY d.created_at`, [i.id, i.include_archived]);
    return scope.organiser ? rows : rows.filter((d) => scope.member.has(d.id) || scope.led.has(d.id));
  },
});

cap({
  name: 'update_department', method: 'PATCH', path: '/departments/:id', tag: 'Departments',
  summary: 'Edit a department (organiser or its lead). Only the organiser can change the lead or archive it; archiving keeps the roster and releases nobody\'s records.',
  input: z.object({ id, name: z.string().min(2).max(80).optional(), description: z.string().max(500).optional(), colour: colour.optional(), lead_user_id: id.optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await dept(i.id, c);
      const ev = await mustFind('events', d.event_id, '*', c);
      const scope = await departmentScope(user, ev, c);
      if (!canRun(scope, d.id)) throw forbidden('Only the organiser or the department lead can change this');
      if ((i.lead_user_id || i.archived !== undefined) && !scope.organiser) throw forbidden('Only the organiser can change the lead or archive a department');
      if (i.name && (await c.query("SELECT 1 FROM event_departments WHERE event_id=$1 AND lower(name)=lower($2) AND status='active' AND id<>$3", [d.event_id, i.name, d.id])).rowCount) throw conflict('A department with that name already exists');
      if (i.lead_user_id) await mustFind('users', i.lead_user_id, 'id', c);
      const status = i.archived === undefined ? null : i.archived ? 'archived' : 'active';
      const out = (await c.query(
        `UPDATE event_departments SET name=coalesce($2,name), description=coalesce($3,description), colour=coalesce($4,colour), lead_user_id=coalesce($5,lead_user_id),
           status=coalesce($6,status), archived_at=CASE WHEN $6='archived' THEN now() WHEN $6='active' THEN NULL ELSE archived_at END WHERE id=$1 RETURNING *`,
        [i.id, i.name ?? null, i.description ?? null, i.colour ?? null, i.lead_user_id ?? null, status])).rows[0];
      if (i.lead_user_id && i.lead_user_id !== d.lead_user_id) {
        await c.query(
          `INSERT INTO event_department_members(department_id, event_id, user_id, role, status, invited_by)
           SELECT $1,$2,$3,'lead','invited',$4 WHERE NOT EXISTS (SELECT 1 FROM event_department_members WHERE department_id=$1 AND user_id=$3 AND status IN ('invited','active'))`,
          [d.id, d.event_id, i.lead_user_id, user.id]);
        await notify(c, i.lead_user_id, { kind: 'department_invite', title: 'You are asked to lead a department', body: `${ev.name}: ${out.name}`, data: { event_id: ev.id, department_id: d.id } });
      }
      return out;
    });
  },
});

cap({
  name: 'invite_department_member', method: 'POST', path: '/departments/:id/members', tag: 'Departments', status: 201,
  summary: 'Invite a person into a department (organiser or its lead). They accept or decline; personal details are only given by the person themself when they accept.',
  input: z.object({ id, user_id: id, role: z.enum(['lead', 'member']).default('member'), title: z.string().max(60).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await dept(i.id, c);
      if (d.status !== 'active') throw conflict('Department is archived');
      const ev = await mustFind('events', d.event_id, '*', c);
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      const scope = await departmentScope(user, ev, c);
      if (!canRun(scope, d.id)) throw forbidden('Only the organiser or the department lead can invite');
      if (i.role === 'lead' && !scope.organiser) throw forbidden('Only the organiser can appoint a lead');
      await mustFind('users', i.user_id, 'id', c);
      if ((await c.query("SELECT 1 FROM event_department_members WHERE department_id=$1 AND user_id=$2 AND status IN ('invited','active')", [d.id, i.user_id])).rowCount) throw conflict('Already in this department or already invited');
      const m = (await c.query("INSERT INTO event_department_members(department_id, event_id, user_id, role, title, invited_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, department_id, user_id, role, title, status, accreditation, invited_at", [d.id, d.event_id, i.user_id, i.role, i.title ?? null, user.id])).rows[0];
      await notify(c, i.user_id, { kind: 'department_invite', title: `Join ${d.name}`, body: `${ev.name} invites you to the ${d.name} department.`, data: { event_id: ev.id, department_id: d.id, member_id: m.id } });
      return m;
    });
  },
});

cap({
  name: 'list_my_department_invites', method: 'GET', path: '/me/department-invites', tag: 'Departments',
  summary: 'Departments you are invited to or belong to across events.', input: z.object({ status: z.enum(['invited', 'active', 'declined', 'left']).optional() }),
  handler: ({ user }, i) => many(
    `SELECT m.id, m.status, m.role, m.title, m.accreditation, m.invited_at, d.id AS department_id, d.name AS department, d.kind, d.colour, e.id AS event_id, e.name AS event, e.starts_on
       FROM event_department_members m JOIN event_departments d ON d.id=m.department_id JOIN events e ON e.id=m.event_id
      WHERE m.user_id=$1 AND ($2::text IS NULL OR m.status=$2) ORDER BY m.invited_at DESC`, [user.id, i.status ?? null]),
});

cap({
  name: 'respond_department_invite', method: 'POST', path: '/department-members/:id/respond', tag: 'Departments',
  summary: 'Accept or decline a department invitation. On accepting you may add your own phone, date of birth and ID number for accreditation; they are stored encrypted.',
  input: z.object({ id, accept: z.boolean(), phone: z.string().min(5).max(30).optional(), dob: z.string().date().optional(), id_number: z.string().min(3).max(40).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT * FROM event_department_members WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!m || m.user_id !== user.id) throw notFound('Invitation');
      if (m.status !== 'invited') throw conflict(`This invitation is already ${m.status}`);
      if (!i.accept) return (await c.query("UPDATE event_department_members SET status='declined' WHERE id=$1 RETURNING id, status", [i.id])).rows[0];
      const out = (await c.query(
        `UPDATE event_department_members SET status='active', joined_at=now(), phone_enc=coalesce($2,phone_enc), dob_enc=coalesce($3,dob_enc), id_number_enc=coalesce($4,id_number_enc), id_number_idx=coalesce($5,id_number_idx)
          WHERE id=$1 RETURNING id, department_id, status, role, accreditation, joined_at`,
        [i.id, encrypt(i.phone, 'event_department_members.phone'), encrypt(i.dob, 'event_department_members.dob'), encrypt(i.id_number, 'event_department_members.id_number'), i.id_number ? blindIndex(i.id_number) : null])).rows[0];
      const d = await dept(m.department_id, c);
      if (m.role === 'lead' && !d.lead_user_id) await c.query('UPDATE event_departments SET lead_user_id=$2 WHERE id=$1', [d.id, user.id]);
      return out;
    });
  },
});

cap({
  name: 'update_my_roster_details', method: 'PATCH', path: '/department-members/:id/details', tag: 'Departments',
  summary: 'Add or change your own phone, date of birth and ID number on a department roster (stored encrypted).',
  input: z.object({ id, phone: z.string().min(5).max(30).optional(), dob: z.string().date().optional(), id_number: z.string().min(3).max(40).optional() }),
  async handler({ user }, i) {
    const m = await one('SELECT * FROM event_department_members WHERE id=$1', [i.id]);
    if (!m || m.user_id !== user.id) throw notFound('Roster entry');
    if (m.status !== 'active') throw conflict('Join the department first');
    if (!i.phone && !i.dob && !i.id_number) throw badRequest('Nothing to update');
    return one(
      `UPDATE event_department_members SET phone_enc=coalesce($2,phone_enc), dob_enc=coalesce($3,dob_enc), id_number_enc=coalesce($4,id_number_enc), id_number_idx=coalesce($5,id_number_idx)
        WHERE id=$1 RETURNING id, status, accreditation`,
      [i.id, encrypt(i.phone, 'event_department_members.phone'), encrypt(i.dob, 'event_department_members.dob'), encrypt(i.id_number, 'event_department_members.id_number'), i.id_number ? blindIndex(i.id_number) : null]);
  },
});

cap({
  name: 'remove_department_member', method: 'POST', path: '/department-members/:id/leave', tag: 'Departments',
  summary: 'Take someone out of a department (organiser or lead), or leave it yourself. The record stays with status "left"; if they led it, the department has no lead until you name one.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT * FROM event_department_members WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!m) throw notFound('Roster entry');
      const ev = await mustFind('events', m.event_id, '*', c);
      const scope = await departmentScope(user, ev, c);
      if (m.user_id !== user.id && !canRun(scope, m.department_id)) throw forbidden('Only the organiser, the lead or the person themself can do that');
      if (!['invited', 'active'].includes(m.status)) throw conflict(`Already ${m.status}`);
      const out = (await c.query("UPDATE event_department_members SET status='left', left_at=now() WHERE id=$1 RETURNING id, status, left_at", [i.id])).rows[0];
      await c.query('UPDATE event_departments SET lead_user_id=NULL WHERE id=$1 AND lead_user_id=$2', [m.department_id, m.user_id]);
      return out;
    });
  },
});

cap({
  name: 'set_accreditation', method: 'POST', path: '/department-members/:id/accreditation', tag: 'Departments',
  summary: 'Move a member\'s accreditation (none → requested → issued, or revoked). Organiser or the department lead. Issuing needs the person\'s ID number on file.',
  input: z.object({ id, status: z.enum(['requested', 'issued', 'revoked']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT * FROM event_department_members WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!m) throw notFound('Roster entry');
      const ev = await mustFind('events', m.event_id, '*', c);
      if (!canRun(await departmentScope(user, ev, c), m.department_id)) throw forbidden('Only the organiser or the department lead can do that');
      if (m.status !== 'active') throw conflict('Only active members can be accredited');
      if (i.status === 'issued' && !m.id_number_enc) throw conflict('The member has not given an ID number yet');
      return (await c.query('UPDATE event_department_members SET accreditation=$2 WHERE id=$1 RETURNING id, status, accreditation', [i.id, i.status])).rows[0];
    });
  },
});

cap({
  name: 'list_roster', method: 'GET', path: '/events/:id/roster', tag: 'Departments',
  summary: 'The event roster, optionally for one department. The organiser sees everyone, a lead sees their departments, a member sees their own departments. include_pii returns phone/DOB/ID number only to the organiser and leads, and the read is audit-logged.',
  input: z.object({ id, department_id: id.optional(), status: z.enum(['invited', 'active', 'declined', 'left']).optional(), include_pii: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    const scope = await departmentScope(user, ev);
    if (i.department_id) await dept(i.department_id);
    const rows = await many(
      `SELECT m.id, m.department_id, d.name AS department, d.colour, d.kind, m.role, m.title, m.status, m.accreditation, m.joined_at, m.phone_enc, m.dob_enc, m.id_number_enc, ${PUBLIC_USER}
         FROM event_department_members m JOIN event_departments d ON d.id=m.department_id JOIN users u ON u.id=m.user_id
        WHERE m.event_id=$1 AND ($2::uuid IS NULL OR m.department_id=$2) AND ($3::text IS NULL OR m.status=$3)
        ORDER BY d.created_at, m.role DESC, u.display_name LIMIT $4 OFFSET $5`, [i.id, i.department_id ?? null, i.status ?? null, i.limit, i.offset]);
    const visible = rows.filter((r) => scope.organiser || scope.led.has(r.department_id) || (scope.member.has(r.department_id) && r.status === 'active'));
    let read = false;
    const out = visible.map(({ phone_enc, dob_enc, id_number_enc, ...r }) => {
      const has_details = { phone: !!phone_enc, dob: !!dob_enc, id_number: !!id_number_enc };
      if (i.include_pii && canRun(scope, r.department_id)) {
        read = true;
        return { ...r, has_details, phone: decrypt(phone_enc, 'event_department_members.phone'), dob: decrypt(dob_enc, 'event_department_members.dob'), id_number: decrypt(id_number_enc, 'event_department_members.id_number') };
      }
      return { ...r, has_details };
    });
    if (read) await audit(null, user.id, 'read_roster_pii', 'event_department_members', i.id);
    if (!visible.length && !scope.organiser && !scope.member.size && !scope.led.size) throw forbidden('You are not part of this event\'s departments');
    return out;
  },
});
