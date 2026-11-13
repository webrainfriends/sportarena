// Academy OS P1 / Gap 16 (#796): Structured Guardian Conferences & Academy Reviews.
// Multi-stakeholder development conferences: coach/guardian/admin/athlete attend; agendas, evidence packs,
// decisions, authenticated acknowledgements, PDF outcome reports. staff_notes_enc is NEVER decrypted for guardian callers.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { orgRole, hasOrgGrant } from '../org-access.js';
import { guardianLink, guardiansOf } from '../youth.js';
import { notify } from '../notify.js';
import { saveEncrypted, loadEncrypted } from '../doc-store.js';
import { createHash } from 'node:crypto';

const TAG = 'Academy';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const text = (n, m = 2000) => z.string().trim().min(n).max(m);
const STAFF_ROLES = ['owner', 'admin', 'staff', 'coach', 'manager'];
const CONF_KINDS = ['annual_review', 'termly', 'progress_check', 'welfare', 'emergency', 'guardian_request', 'other'];
const LOCATION_TYPES = ['in_person', 'video', 'phone', 'hybrid'];
const ATTENDEE_ROLES = ['lead_coach', 'coach', 'guardian', 'admin', 'athlete', 'external'];
const EVIDENCE_KINDS = ['dev_review', 'objective', 'intervention', 'assessment', 'external', 'media'];
const AGENDA_KINDS = ['review_domain', 'objective_progress', 'welfare', 'guardian_concern', 'admin', 'aob', 'general'];
const DECISION_KINDS = ['decision', 'action', 'recommendation', 'follow_up', 'concern_noted'];
const DECISION_STATUSES = ['open', 'in_progress', 'done', 'deferred', 'cancelled'];
const CONF_STATUSES = ['draft', 'scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'rescheduled'];

const enc  = (v, col) => v ? encrypt(v, `academy_conferences.${col}`) : null;
const dec  = (v, col) => v ? decrypt(v, `academy_conferences.${col}`) : null;
const encA = (v, col) => v ? encrypt(v, `academy_conference_attendees.${col}`) : null;
const decA = (v, col) => v ? decrypt(v, `academy_conference_attendees.${col}`) : null;
const encI = (v, col) => v ? encrypt(v, `academy_conference_agenda_items.${col}`) : null;
const decI = (v, col) => v ? decrypt(v, `academy_conference_agenda_items.${col}`) : null;
const encD = (v, col) => v ? encrypt(v, `academy_conference_decisions.${col}`) : null;
const decD = (v, col) => v ? decrypt(v, `academy_conference_decisions.${col}`) : null;

/** Resolve the caller's relationship to a conference: 'staff' | 'guardian' | null (→ 404) */
async function accessTo(user, conf, c) {
  if (isAdmin(user)) return 'staff';
  const role = await orgRole(user, conf.org_id, c);
  if (role && STAFF_ROLES.includes(role)) return 'staff';
  if (conf.plan_id && conf.family_visible) {
    const plan = (await c.query('SELECT athlete_id FROM academy_dev_plans WHERE id=$1', [conf.plan_id])).rows[0];
    if (plan) {
      const link = await guardianLink(user.id, plan.athlete_id, c);
      if (link) {
        const att = (await c.query('SELECT 1 FROM academy_conference_attendees WHERE conference_id=$1 AND user_id=$2', [conf.id, user.id])).rows[0];
        if (att) return 'guardian';
      }
    }
  }
  return null;
}

async function requireConf(c, orgId, confId) {
  const conf = (await c.query('SELECT * FROM academy_conferences WHERE id=$1 AND org_id=$2', [confId, orgId])).rows[0];
  if (!conf) throw notFound('Conference');
  return conf;
}

async function requireStaff(user, orgId, c) {
  if (isAdmin(user)) return;
  const ok = await hasOrgGrant(user, orgId, STAFF_ROLES, c);
  if (!ok) throw forbidden();
}

function viewConf(conf, role) {
  const base = {
    id: conf.id,
    org_id: conf.org_id,
    plan_id: conf.plan_id,
    title: conf.title,
    kind: conf.kind,
    status: conf.status,
    scheduled_at: conf.scheduled_at,
    duration_minutes: conf.duration_minutes,
    location_type: conf.location_type,
    location_detail: dec(conf.location_detail_enc, 'location_detail'),
    initiated_by: conf.initiated_by,
    family_visible: conf.family_visible,
    agenda: dec(conf.agenda_enc, 'agenda'),
    outcome_summary: dec(conf.outcome_summary_enc, 'outcome_summary'),
    row_version: conf.row_version,
    created_at: conf.created_at,
    updated_at: conf.updated_at,
  };
  // staff_notes_enc: NEVER shown to guardian callers — enforced here and in SQL (never SELECT staff_notes_enc for guardian queries)
  if (role === 'staff') base.staff_notes = dec(conf.staff_notes_enc, 'staff_notes');
  return base;
}

function viewAttendee(a) {
  return {
    id: a.id, conference_id: a.conference_id, user_id: a.user_id, role: a.role, status: a.status,
    invite_sent_at: a.invite_sent_at, responded_at: a.responded_at,
    notes: decA(a.notes_enc, 'notes'), created_at: a.created_at,
  };
}

function viewAgendaItem(i) {
  return {
    id: i.id, conference_id: i.conference_id, seq: i.seq, title: i.title,
    description: decI(i.description_enc, 'description'), kind: i.kind,
    time_minutes: i.time_minutes, owner_user_id: i.owner_user_id, created_at: i.created_at,
  };
}

function viewDecision(d) {
  return {
    id: d.id, conference_id: d.conference_id, agenda_item_id: d.agenda_item_id, kind: d.kind,
    body: decD(d.body_enc, 'body'), responsible_user_id: d.responsible_user_id,
    deadline_on: d.deadline_on, status: d.status, source_link: d.source_link,
    visible_to_guardian: d.visible_to_guardian, created_by: d.created_by, created_at: d.created_at,
    resolved_at: d.resolved_at, resolved_by: d.resolved_by,
  };
}

const logEvent = (c, confId, actorId, action, detail) =>
  c.query('INSERT INTO academy_conference_events(conference_id, actor_id, action, detail_json) VALUES ($1,$2,$3,$4)',
    [confId, actorId ?? null, action, detail ? JSON.stringify(detail) : null]);

// ---- 1. Create conference -----------------------------------------------------------------------------------------
cap({
  name: 'create_academy_conference', method: 'POST', path: '/orgs/:org_id/conferences', tag: TAG, status: 201,
  summary: 'Schedule a new multi-stakeholder development conference for one athlete, linked to their development plan.',
  input: z.object({
    org_id: id, plan_id: id.optional(), title: text(1, 200), kind: z.enum(CONF_KINDS),
    scheduled_at: z.string().datetime({ offset: true }).optional(),
    duration_minutes: z.coerce.number().int().min(5).max(480).default(60),
    location_type: z.enum(LOCATION_TYPES).default('video'),
    location_detail: z.string().max(500).optional(),
    agenda: z.string().max(5000).optional(),
    staff_notes: z.string().max(5000).optional(),
    family_visible: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = (await c.query(
        `INSERT INTO academy_conferences(org_id, plan_id, title, kind, scheduled_at, duration_minutes, location_type,
           location_detail_enc, initiated_by, agenda_enc, staff_notes_enc, family_visible)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [i.org_id, i.plan_id ?? null, i.title, i.kind, i.scheduled_at ?? null, i.duration_minutes, i.location_type,
         enc(i.location_detail, 'location_detail'), user.id, enc(i.agenda, 'agenda'),
         enc(i.staff_notes, 'staff_notes'), i.family_visible],
      )).rows[0];
      await logEvent(c, conf.id, user.id, 'created', { title: i.title, kind: i.kind });
      return viewConf(conf, 'staff');
    });
  },
});

// ---- 2. Update conference -----------------------------------------------------------------------------------------
cap({
  name: 'update_academy_conference', method: 'PATCH', path: '/orgs/:org_id/conferences/:conference_id', tag: TAG,
  summary: 'Update conference details, status, agenda or staff notes.',
  input: z.object({
    org_id: id, conference_id: id,
    title: text(1, 200).optional(), kind: z.enum(CONF_KINDS).optional(), status: z.enum(CONF_STATUSES).optional(),
    scheduled_at: z.string().datetime({ offset: true }).optional(),
    duration_minutes: z.coerce.number().int().min(5).max(480).optional(),
    location_type: z.enum(LOCATION_TYPES).optional(),
    location_detail: z.string().max(500).optional(),
    agenda: z.string().max(5000).optional(),
    staff_notes: z.string().max(5000).optional(),
    outcome_summary: z.string().max(5000).optional(),
    family_visible: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const sets = ['row_version = row_version + 1', 'updated_at = now()'];
      const vals = [conf.id];
      let n = 2;
      const add = (col, val) => { sets.push(`${col}=$${n++}`); vals.push(val); };
      if (i.title !== undefined) add('title', i.title);
      if (i.kind !== undefined) add('kind', i.kind);
      if (i.status !== undefined) add('status', i.status);
      if (i.scheduled_at !== undefined) add('scheduled_at', i.scheduled_at);
      if (i.duration_minutes !== undefined) add('duration_minutes', i.duration_minutes);
      if (i.location_type !== undefined) add('location_type', i.location_type);
      if (i.location_detail !== undefined) add('location_detail_enc', enc(i.location_detail, 'location_detail'));
      if (i.agenda !== undefined) add('agenda_enc', enc(i.agenda, 'agenda'));
      if (i.staff_notes !== undefined) add('staff_notes_enc', enc(i.staff_notes, 'staff_notes'));
      if (i.outcome_summary !== undefined) add('outcome_summary_enc', enc(i.outcome_summary, 'outcome_summary'));
      if (i.family_visible !== undefined) add('family_visible', i.family_visible);
      const updated = (await c.query(`UPDATE academy_conferences SET ${sets.join(',')} WHERE id=$1 RETURNING *`, vals)).rows[0];
      await logEvent(c, conf.id, user.id, 'updated', {});
      return viewConf(updated, 'staff');
    });
  },
});

// ---- 3. List conferences ------------------------------------------------------------------------------------------
cap({
  name: 'list_academy_conferences', method: 'GET', path: '/orgs/:org_id/conferences', tag: TAG,
  summary: 'List conferences for an organisation. Staff see all; guardians see only family-visible ones where they are an attendee.',
  input: z.object({
    org_id: id,
    status: z.enum(CONF_STATUSES).optional(),
    kind: z.enum(CONF_KINDS).optional(),
    plan_id: id.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const isStaff = isAdmin(user) || (await hasOrgGrant(user, i.org_id, STAFF_ROLES));
    let rows;
    if (isStaff) {
      const wheres = ['org_id=$1'];
      const vals = [i.org_id];
      let n = 2;
      if (i.status) { wheres.push(`status=$${n++}`); vals.push(i.status); }
      if (i.kind) { wheres.push(`kind=$${n++}`); vals.push(i.kind); }
      if (i.plan_id) { wheres.push(`plan_id=$${n++}`); vals.push(i.plan_id); }
      vals.push(i.limit, i.offset);
      rows = await many(
        `SELECT * FROM academy_conferences WHERE ${wheres.join(' AND ')} ORDER BY scheduled_at NULLS LAST, created_at DESC LIMIT $${n} OFFSET $${n + 1}`,
        vals,
      );
      return rows.map((r) => viewConf(r, 'staff'));
    }
    // guardian: only family_visible=true conferences where they are an attendee
    rows = await many(
      `SELECT c.* FROM academy_conferences c
         JOIN academy_conference_attendees a ON a.conference_id=c.id AND a.user_id=$2
         WHERE c.org_id=$1 AND c.family_visible=true
         ORDER BY c.scheduled_at NULLS LAST, c.created_at DESC LIMIT $3 OFFSET $4`,
      [i.org_id, user.id, i.limit, i.offset],
    );
    return rows.map((r) => viewConf(r, 'guardian'));
  },
});

// ---- 4. Get conference --------------------------------------------------------------------------------------------
cap({
  name: 'get_academy_conference', method: 'GET', path: '/orgs/:org_id/conferences/:conference_id', tag: TAG,
  summary: 'Get full conference detail. Staff receive staff notes; guardians never receive staff notes.',
  input: z.object({ org_id: id, conference_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const role = await accessTo(user, conf, c);
      if (!role) throw notFound('Conference');
      if (role === 'staff' && conf.staff_notes_enc) {
        await audit(c, user.id, 'read_conference_staff_notes', 'academy_conferences', conf.id);
      }
      return viewConf(conf, role);
    });
  },
});

// ---- 5. Cancel conference -----------------------------------------------------------------------------------------
cap({
  name: 'cancel_academy_conference', method: 'POST', path: '/orgs/:org_id/conferences/:conference_id/cancel', tag: TAG,
  summary: 'Cancel a conference and notify all attendees.',
  input: z.object({ org_id: id, conference_id: id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = await requireConf(c, i.org_id, i.conference_id);
      if (conf.status === 'completed') throw badRequest('Cannot cancel a completed conference');
      if (conf.status === 'cancelled') throw conflict('Already cancelled');
      const updated = (await c.query(
        `UPDATE academy_conferences SET status='cancelled', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [conf.id],
      )).rows[0];
      await logEvent(c, conf.id, user.id, 'cancelled', { reason: i.reason ?? null });
      const attendees = await many('SELECT user_id FROM academy_conference_attendees WHERE conference_id=$1', [conf.id]);
      await Promise.all(attendees.map((a) =>
        notify(c, a.user_id, { kind: 'conference_cancelled', title: `Conference cancelled: ${conf.title}`, body: i.reason ?? 'The conference has been cancelled.', data: { conference_id: conf.id } }),
      ));
      return viewConf(updated, 'staff');
    });
  },
});

// ---- 6. Reschedule conference -------------------------------------------------------------------------------------
cap({
  name: 'reschedule_academy_conference', method: 'POST', path: '/orgs/:org_id/conferences/:conference_id/reschedule', tag: TAG,
  summary: 'Set a new date/time for a conference and notify attendees.',
  input: z.object({
    org_id: id, conference_id: id,
    new_scheduled_at: z.string().datetime({ offset: true }),
    duration_minutes: z.coerce.number().int().min(5).max(480).optional(),
    reason: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = await requireConf(c, i.org_id, i.conference_id);
      if (conf.status === 'completed' || conf.status === 'cancelled') throw badRequest('Cannot reschedule a completed or cancelled conference');
      const sets = [`status='rescheduled'`, `scheduled_at=$2`, `row_version=row_version+1`, `updated_at=now()`];
      const vals = [conf.id, i.new_scheduled_at];
      if (i.duration_minutes !== undefined) { sets.push(`duration_minutes=$${vals.length + 1}`); vals.push(i.duration_minutes); }
      const updated = (await c.query(`UPDATE academy_conferences SET ${sets.join(',')} WHERE id=$1 RETURNING *`, vals)).rows[0];
      await logEvent(c, conf.id, user.id, 'rescheduled', { new_scheduled_at: i.new_scheduled_at, reason: i.reason ?? null });
      const attendees = await many('SELECT user_id FROM academy_conference_attendees WHERE conference_id=$1', [conf.id]);
      await Promise.all(attendees.map((a) =>
        notify(c, a.user_id, { kind: 'conference_rescheduled', title: `Conference rescheduled: ${conf.title}`, body: `New time: ${new Date(i.new_scheduled_at).toLocaleString()}`, data: { conference_id: conf.id, new_scheduled_at: i.new_scheduled_at } }),
      ));
      return viewConf(updated, 'staff');
    });
  },
});

// ---- 7. Invite attendee ------------------------------------------------------------------------------------------
cap({
  name: 'invite_conference_attendee', method: 'POST', path: '/orgs/:org_id/conferences/:conference_id/attendees', tag: TAG, status: 201,
  summary: 'Invite a person to a conference as a specific role (coach, guardian, athlete, etc.).',
  input: z.object({
    org_id: id, conference_id: id,
    user_id: id, role: z.enum(ATTENDEE_ROLES),
    notes: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const existing = (await c.query('SELECT id FROM academy_conference_attendees WHERE conference_id=$1 AND user_id=$2', [conf.id, i.user_id])).rows[0];
      let att;
      if (existing) {
        att = (await c.query(
          `UPDATE academy_conference_attendees SET role=$3, notes_enc=$4, invite_sent_at=now() WHERE id=$1 RETURNING *`,
          [existing.id, i.role, encA(i.notes, 'notes')],
        )).rows[0];
      } else {
        att = (await c.query(
          `INSERT INTO academy_conference_attendees(conference_id, user_id, role, notes_enc, invite_sent_at) VALUES ($1,$2,$3,$4,now()) RETURNING *`,
          [conf.id, i.user_id, i.role, encA(i.notes, 'notes')],
        )).rows[0];
      }
      await notify(c, i.user_id, { kind: 'conference_invited', title: `You are invited: ${conf.title}`, body: `Scheduled: ${conf.scheduled_at ? new Date(conf.scheduled_at).toLocaleString() : 'TBD'}`, data: { conference_id: conf.id, org_id: i.org_id } });
      await logEvent(c, conf.id, user.id, 'attendee_invited', { user_id: i.user_id, role: i.role });
      return viewAttendee(att);
    });
  },
});

// ---- 8. Respond to invite ----------------------------------------------------------------------------------------
cap({
  name: 'respond_conference_invite', method: 'POST', path: '/orgs/:org_id/conferences/:conference_id/attendees/:attendee_id/respond', tag: TAG,
  summary: 'Confirm or decline attendance at a conference. The caller must be the invited attendee or a staff member.',
  input: z.object({
    org_id: id, conference_id: id, attendee_id: id,
    status: z.enum(['confirmed', 'declined']),
    notes: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const att = (await c.query('SELECT * FROM academy_conference_attendees WHERE id=$1 AND conference_id=$2', [i.attendee_id, conf.id])).rows[0];
      if (!att) throw notFound('Attendee');
      const isStaff = isAdmin(user) || await hasOrgGrant(user, i.org_id, STAFF_ROLES, c);
      if (!isStaff && att.user_id !== user.id) throw forbidden();
      const updated = (await c.query(
        `UPDATE academy_conference_attendees SET status=$2, responded_at=now(), notes_enc=$3 WHERE id=$1 RETURNING *`,
        [att.id, i.status, encA(i.notes, 'notes')],
      )).rows[0];
      await logEvent(c, conf.id, user.id, `attendee_${i.status}`, { user_id: att.user_id });
      return viewAttendee(updated);
    });
  },
});

// ---- 9. Add evidence ---------------------------------------------------------------------------------------------
cap({
  name: 'add_conference_evidence', method: 'POST', path: '/orgs/:org_id/conferences/:conference_id/evidence', tag: TAG, status: 201,
  summary: 'Attach a development review, assessment, objective or external item as evidence for the conference.',
  input: z.object({
    org_id: id, conference_id: id,
    source_kind: z.enum(EVIDENCE_KINDS),
    source_id: id.optional(),
    label: text(1, 200),
    visible_to_roles: z.array(z.string()).default(['coach', 'admin', 'guardian']),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const ev = (await c.query(
        `INSERT INTO academy_conference_evidence(conference_id, source_kind, source_id, label, visible_to_roles, added_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [conf.id, i.source_kind, i.source_id ?? null, i.label, i.visible_to_roles, user.id],
      )).rows[0];
      return { id: ev.id, conference_id: ev.conference_id, source_kind: ev.source_kind, source_id: ev.source_id, label: ev.label, visible_to_roles: ev.visible_to_roles, added_by: ev.added_by, added_at: ev.added_at };
    });
  },
});

// ---- 10. Remove evidence -----------------------------------------------------------------------------------------
cap({
  name: 'remove_conference_evidence', method: 'DELETE', path: '/orgs/:org_id/conferences/:conference_id/evidence/:evidence_id', tag: TAG,
  summary: 'Remove an evidence link from a conference. Only removes the link, not the underlying source record.',
  input: z.object({ org_id: id, conference_id: id, evidence_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const res = await c.query('DELETE FROM academy_conference_evidence WHERE id=$1 AND conference_id=$2', [i.evidence_id, conf.id]);
      if (res.rowCount === 0) throw notFound('Evidence');
      return { ok: true };
    });
  },
});

// ---- 11. Add agenda item -----------------------------------------------------------------------------------------
cap({
  name: 'add_conference_agenda_item', method: 'POST', path: '/orgs/:org_id/conferences/:conference_id/agenda', tag: TAG, status: 201,
  summary: 'Add a structured agenda item to a conference.',
  input: z.object({
    org_id: id, conference_id: id,
    title: text(1, 200), description: z.string().max(2000).optional(),
    kind: z.enum(AGENDA_KINDS).default('general'),
    time_minutes: z.coerce.number().int().min(1).max(240).optional(),
    owner_user_id: id.optional(),
    seq: z.coerce.number().int().min(0).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const nextSeq = i.seq !== undefined ? i.seq : (await c.query('SELECT coalesce(max(seq),0)+1 AS s FROM academy_conference_agenda_items WHERE conference_id=$1', [conf.id])).rows[0].s;
      const item = (await c.query(
        `INSERT INTO academy_conference_agenda_items(conference_id, seq, title, description_enc, kind, time_minutes, owner_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [conf.id, nextSeq, i.title, encI(i.description, 'description'), i.kind, i.time_minutes ?? null, i.owner_user_id ?? null],
      )).rows[0];
      return viewAgendaItem(item);
    });
  },
});

// ---- 12. Update agenda item --------------------------------------------------------------------------------------
cap({
  name: 'update_conference_agenda_item', method: 'PATCH', path: '/orgs/:org_id/conferences/:conference_id/agenda/:item_id', tag: TAG,
  summary: 'Update a conference agenda item.',
  input: z.object({
    org_id: id, conference_id: id, item_id: id,
    title: text(1, 200).optional(), description: z.string().max(2000).optional(),
    kind: z.enum(AGENDA_KINDS).optional(),
    time_minutes: z.coerce.number().int().min(1).max(240).optional(),
    owner_user_id: id.optional(),
    seq: z.coerce.number().int().min(0).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      await requireConf(c, i.org_id, i.conference_id);
      const item = (await c.query('SELECT * FROM academy_conference_agenda_items WHERE id=$1 AND conference_id=$2', [i.item_id, i.conference_id])).rows[0];
      if (!item) throw notFound('Agenda item');
      const sets = []; const vals = [item.id]; let n = 2;
      const add = (col, val) => { sets.push(`${col}=$${n++}`); vals.push(val); };
      if (i.title !== undefined) add('title', i.title);
      if (i.description !== undefined) add('description_enc', encI(i.description, 'description'));
      if (i.kind !== undefined) add('kind', i.kind);
      if (i.time_minutes !== undefined) add('time_minutes', i.time_minutes);
      if (i.owner_user_id !== undefined) add('owner_user_id', i.owner_user_id);
      if (i.seq !== undefined) add('seq', i.seq);
      if (!sets.length) return viewAgendaItem(item);
      const updated = (await c.query(`UPDATE academy_conference_agenda_items SET ${sets.join(',')} WHERE id=$1 RETURNING *`, vals)).rows[0];
      return viewAgendaItem(updated);
    });
  },
});

// ---- 13. Reorder agenda ------------------------------------------------------------------------------------------
cap({
  name: 'reorder_conference_agenda', method: 'PATCH', path: '/orgs/:org_id/conferences/:conference_id/agenda/order', tag: TAG,
  summary: 'Set the display order for all agenda items at once.',
  input: z.object({ org_id: id, conference_id: id, item_ids: z.array(id).min(1).max(50) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      await requireConf(c, i.org_id, i.conference_id);
      await Promise.all(i.item_ids.map((itemId, seq) =>
        c.query('UPDATE academy_conference_agenda_items SET seq=$3 WHERE id=$1 AND conference_id=$2', [itemId, i.conference_id, seq]),
      ));
      return { ok: true };
    });
  },
});

// ---- 14. Add decision --------------------------------------------------------------------------------------------
cap({
  name: 'add_conference_decision', method: 'POST', path: '/orgs/:org_id/conferences/:conference_id/decisions', tag: TAG, status: 201,
  summary: 'Record a decision, action, recommendation or follow-up from a conference.',
  input: z.object({
    org_id: id, conference_id: id,
    agenda_item_id: id.optional(),
    kind: z.enum(DECISION_KINDS),
    body: text(1, 3000),
    responsible_user_id: id.optional(),
    deadline_on: day.optional(),
    source_link: z.string().url().max(500).optional(),
    visible_to_guardian: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const d = (await c.query(
        `INSERT INTO academy_conference_decisions(conference_id, agenda_item_id, kind, body_enc, responsible_user_id, deadline_on, source_link, visible_to_guardian, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [conf.id, i.agenda_item_id ?? null, i.kind, encD(i.body, 'body'), i.responsible_user_id ?? null, i.deadline_on ?? null, i.source_link ?? null, i.visible_to_guardian, user.id],
      )).rows[0];
      return viewDecision(d);
    });
  },
});

// ---- 15. Update decision -----------------------------------------------------------------------------------------
cap({
  name: 'update_conference_decision', method: 'PATCH', path: '/orgs/:org_id/conferences/:conference_id/decisions/:decision_id', tag: TAG,
  summary: 'Update a decision/action status, responsible party, deadline or body.',
  input: z.object({
    org_id: id, conference_id: id, decision_id: id,
    body: z.string().max(3000).optional(),
    responsible_user_id: id.optional(),
    deadline_on: day.optional(),
    status: z.enum(DECISION_STATUSES).optional(),
    visible_to_guardian: z.boolean().optional(),
    source_link: z.string().url().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      await requireConf(c, i.org_id, i.conference_id);
      const d = (await c.query('SELECT * FROM academy_conference_decisions WHERE id=$1 AND conference_id=$2', [i.decision_id, i.conference_id])).rows[0];
      if (!d) throw notFound('Decision');
      const sets = []; const vals = [d.id]; let n = 2;
      const add = (col, val) => { sets.push(`${col}=$${n++}`); vals.push(val); };
      if (i.body !== undefined) add('body_enc', encD(i.body, 'body'));
      if (i.responsible_user_id !== undefined) add('responsible_user_id', i.responsible_user_id);
      if (i.deadline_on !== undefined) add('deadline_on', i.deadline_on);
      if (i.visible_to_guardian !== undefined) add('visible_to_guardian', i.visible_to_guardian);
      if (i.source_link !== undefined) add('source_link', i.source_link);
      if (i.status !== undefined) {
        add('status', i.status);
        if (i.status === 'done') { add('resolved_at', new Date().toISOString()); add('resolved_by', user.id); }
      }
      if (!sets.length) return viewDecision(d);
      const updated = (await c.query(`UPDATE academy_conference_decisions SET ${sets.join(',')} WHERE id=$1 RETURNING *`, vals)).rows[0];
      return viewDecision(updated);
    });
  },
});

// ---- 16. Acknowledge outcome -------------------------------------------------------------------------------------
cap({
  name: 'acknowledge_conference_outcome', method: 'POST', path: '/orgs/:org_id/conferences/:conference_id/acknowledge', tag: TAG,
  summary: 'Guardian authenticates and acknowledges the meeting outcome. Creates an immutable acknowledgement record.',
  input: z.object({ org_id: id, conference_id: id }),
  async handler({ user, req }, i) {
    return tx(async (c) => {
      const conf = await requireConf(c, i.org_id, i.conference_id);
      if (!conf.family_visible) throw notFound('Conference');
      // Must be an active guardian of the athlete linked to this conference
      if (!conf.plan_id) throw badRequest('Conference has no linked development plan');
      const plan = (await c.query('SELECT athlete_id FROM academy_dev_plans WHERE id=$1', [conf.plan_id])).rows[0];
      if (!plan) throw notFound('Development plan');
      const link = await guardianLink(user.id, plan.athlete_id, c);
      if (!link) throw forbidden();
      // Must be listed as an attendee
      const att = (await c.query('SELECT 1 FROM academy_conference_attendees WHERE conference_id=$1 AND user_id=$2', [conf.id, user.id])).rows[0];
      if (!att) throw forbidden();
      const ipRaw = req?.ip ?? req?.socket?.remoteAddress ?? '';
      const ipHash = ipRaw ? createHash('sha256').update(ipRaw).digest('hex') : null;
      const ack = (await c.query(
        `INSERT INTO academy_conference_acknowledgements(conference_id, guardian_id, ip_hash) VALUES ($1,$2,$3)
         ON CONFLICT (conference_id, guardian_id) DO UPDATE SET acknowledged_at=EXCLUDED.acknowledged_at RETURNING *`,
        [conf.id, user.id, ipHash],
      )).rows[0];
      await audit(c, user.id, 'acknowledge_conference_outcome', 'academy_conferences', conf.id);
      await logEvent(c, conf.id, user.id, 'acknowledged', {});
      return { acknowledged: true, acknowledged_at: ack.acknowledged_at };
    });
  },
});

// ---- 17. Generate outcome report ---------------------------------------------------------------------------------
cap({
  name: 'generate_conference_outcome_report', method: 'POST', path: '/orgs/:org_id/conferences/:conference_id/report', tag: TAG, status: 201,
  summary: 'Generate and store a formatted outcome report for the conference. Staff only.',
  input: z.object({ org_id: id, conference_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await requireStaff(user, i.org_id, c);
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const attendees = await many('SELECT user_id, role, status FROM academy_conference_attendees WHERE conference_id=$1', [conf.id]);
      const agenda = await many('SELECT seq, title, kind, time_minutes FROM academy_conference_agenda_items WHERE conference_id=$1 ORDER BY seq', [conf.id]);
      const decisions = await many('SELECT kind, body_enc, responsible_user_id, deadline_on, status, visible_to_guardian FROM academy_conference_decisions WHERE conference_id=$1 ORDER BY created_at', [conf.id]);
      const acks = await many('SELECT guardian_id, acknowledged_at FROM academy_conference_acknowledgements WHERE conference_id=$1', [conf.id]);
      // Build plain-text outcome report (PDF rendering to be added when renderConferenceReport is available)
      const lines = [
        `GUARDIAN CONFERENCE OUTCOME REPORT`,
        `=====================================`,
        `Title: ${conf.title}`,
        `Kind: ${conf.kind}`,
        `Status: ${conf.status}`,
        `Date: ${conf.scheduled_at ? new Date(conf.scheduled_at).toISOString() : 'TBD'}`,
        `Duration: ${conf.duration_minutes} minutes`,
        `Location: ${conf.location_type}`,
        ``,
        `ATTENDEES (${attendees.length})`,
        ...attendees.map((a) => `  - ${a.role}: ${a.user_id} [${a.status}]`),
        ``,
        `AGENDA`,
        ...agenda.map((a, n) => `  ${n + 1}. [${a.kind}] ${a.title}${a.time_minutes ? ` (${a.time_minutes} min)` : ''}`),
        ``,
        `DECISIONS & ACTIONS`,
        ...decisions.map((d) => [
          `  [${d.kind.toUpperCase()}] ${decD(d.body_enc, 'body')}`,
          `  Status: ${d.status}${d.deadline_on ? ` | Due: ${d.deadline_on}` : ''}`,
          `  Visible to guardian: ${d.visible_to_guardian ? 'Yes' : 'No'}`,
        ].join('\n')),
        ``,
        `ACKNOWLEDGEMENTS`,
        ...acks.map((a) => `  Guardian ${a.guardian_id} acknowledged at ${a.acknowledged_at}`),
        ``,
        `Generated: ${new Date().toISOString()}`,
        `Platform: GotMyGame / Sportarena`,
      ];
      const content = lines.join('\n');
      const buffer = Buffer.from(content, 'utf8');
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const { id: docId, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
      await c.query(
        `INSERT INTO generated_documents(id, family, source_type, source_id, file_name, size_bytes, sha256, pages, generated_by) VALUES ($1,'documents','academy_conference',$2,$3,$4,$5,1,$6)`,
        [docId, conf.id, file, buffer.length, sha256, user.id],
      );
      await audit(c, user.id, 'generate_document', 'generated_documents', docId);
      return { document_id: docId, created_at: new Date().toISOString() };
    });
  },
});

// ---- 18. Get outcome report --------------------------------------------------------------------------------------
cap({
  name: 'get_conference_outcome_report', method: 'GET', path: '/orgs/:org_id/conferences/:conference_id/report', tag: TAG,
  summary: 'Get the latest outcome report for a conference. Guardians must acknowledge before downloading.',
  input: z.object({ org_id: id, conference_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const conf = await requireConf(c, i.org_id, i.conference_id);
      const role = await accessTo(user, conf, c);
      if (!role) throw notFound('Conference');
      if (role === 'guardian') {
        const ack = (await c.query('SELECT 1 FROM academy_conference_acknowledgements WHERE conference_id=$1 AND guardian_id=$2', [conf.id, user.id])).rows[0];
        if (!ack) throw badRequest('You must acknowledge the conference outcome before downloading the report');
      }
      const doc = (await c.query(
        `SELECT id, size_bytes, sha256, pages, created_at FROM generated_documents WHERE source_type='academy_conference' AND source_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [conf.id],
      )).rows[0];
      if (!doc) throw notFound('Outcome report — generate one first');
      await audit(c, user.id, 'read_conference_report', 'generated_documents', doc.id);
      return { document_id: doc.id, size_bytes: doc.size_bytes, sha256: doc.sha256, pages: doc.pages, created_at: doc.created_at, download_url: `/api/v1/branded-documents/${doc.id}/file` };
    });
  },
});

// ---- 19. List my guardian conferences ----------------------------------------------------------------------------
cap({
  name: 'list_my_guardian_conferences', method: 'GET', path: '/me/guardian-conferences', tag: TAG,
  summary: 'List all conferences where the caller is an invited guardian and the conference is family-visible.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT c.*, dp.athlete_id, u.display_name AS athlete_name, u.avatar_emoji, u.avatar_color,
              a.status AS attendee_status, a.responded_at,
              ack.acknowledged_at,
              (SELECT count(*) FROM academy_conference_decisions WHERE conference_id=c.id AND visible_to_guardian=true) AS guardian_decision_count
       FROM academy_conferences c
       JOIN academy_conference_attendees a ON a.conference_id=c.id AND a.user_id=$1
       LEFT JOIN academy_dev_plans dp ON dp.id=c.plan_id
       LEFT JOIN users u ON u.id=dp.athlete_id
       LEFT JOIN academy_conference_acknowledgements ack ON ack.conference_id=c.id AND ack.guardian_id=$1
       WHERE c.family_visible=true
       ORDER BY c.scheduled_at NULLS LAST, c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [user.id, i.limit, i.offset],
    );
    return rows.map((r) => ({
      ...viewConf(r, 'guardian'),
      athlete: r.athlete_id ? { id: r.athlete_id, display_name: r.athlete_name, avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color } : null,
      attendee_status: r.attendee_status,
      responded_at: r.responded_at,
      acknowledged_at: r.acknowledged_at ?? null,
      guardian_decision_count: Number(r.guardian_decision_count),
    }));
  },
});
