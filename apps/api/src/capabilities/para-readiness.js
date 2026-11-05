// PS-10 (#840): Accessible tournament operational-readiness gate.
// Para-sport events have safety, support, facility and medical requirements beyond the standard
// event-ops readiness check. This module adds:
//   – a preflight checklist bound to real records (bookings, staff assignments, supplier confirmations, classification)
//   – documented exceptions with second-officer approval for safety-critical items (no silent bypass)
//   – sign-off trail with evidence references
//   – role-appropriate notifications (organiser, venue, official, athlete)
//   – athlete-facing approved arrival/access information (operational minimum; no clinical data)
//   – assertParaReadiness() gate called by events.js when opening a para event
// Normal (non-para) events are entirely unaffected: items only appear when added explicitly.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { pool, many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { opsAccess } from './event-ops.js';

const TAG = 'Event para-sport';
const date = z.string().date();
const text = (max) => z.string().trim().min(1).max(max);

const PARA_CATEGORIES = ['accessible_facilities', 'classification', 'support_roles', 'medical', 'equipment', 'incident_response', 'transport_access', 'communication'];
const CAT_LABEL = {
  accessible_facilities: 'Accessible Facilities',
  classification: 'Classification',
  support_roles: 'Support Roles',
  medical: 'Medical Coverage',
  equipment: 'Specialised Equipment',
  incident_response: 'Incident Response',
  transport_access: 'Accessible Transport',
  communication: 'Communication Access',
};

/** Standard para readiness items. Manual items have no derive_key; derived ones read live records. */
export const PARA_STANDARD = [
  { key: 'para_accessible_entrance', para_category: 'accessible_facilities', is_safety_critical: false, title: 'Accessible entrance confirmed' },
  { key: 'para_accessible_facilities', para_category: 'accessible_facilities', is_safety_critical: false, title: 'Adapted changing rooms and bathrooms confirmed' },
  { key: 'para_accessible_parking', para_category: 'accessible_facilities', is_safety_critical: false, title: 'Accessible parking allocated' },
  { key: 'para_medical_station', para_category: 'accessible_facilities', is_safety_critical: true, title: 'Accessible medical station confirmed' },
  { key: 'para_classification_complete', para_category: 'classification', is_safety_critical: false, title: 'All para entries classified or provisionally approved', derive_key: 'para_classification_complete' },
  { key: 'para_support_roles', para_category: 'support_roles', is_safety_critical: false, title: 'Required support roles assigned (guides, pushers, callers)' },
  { key: 'para_medical_specialist', para_category: 'medical', is_safety_critical: false, title: 'Para-sport qualified medical staff confirmed', derive_key: 'para_medical_specialist' },
  { key: 'para_evacuation_plan', para_category: 'medical', is_safety_critical: true, title: 'Emergency evacuation plan for wheelchair users filed' },
  { key: 'para_equipment_delivered', para_category: 'equipment', is_safety_critical: false, title: 'Specialised para equipment delivery confirmed', derive_key: 'para_equipment_delivered' },
  { key: 'para_transport_accessible', para_category: 'transport_access', is_safety_critical: false, title: 'Accessible transport arrangements confirmed' },
  { key: 'para_communication_access', para_category: 'communication', is_safety_critical: false, title: 'Accessible communication (interpreter/adapted materials) in place' },
];
const PARA_STANDARD_BY_KEY = Object.fromEntries(PARA_STANDARD.map((s) => [s.key, s]));

async function loadParaEvent(user, eventId, need, c) {
  const ev = (await (c ?? pool).query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev) throw notFound('Event');
  const a = await opsAccess(user, ev, c);
  if (!a.crew) throw notFound('Event para readiness');
  if (need === 'manager' && !a.manager) throw forbidden('Only the organiser or a department lead can do this');
  if (need === 'organiser' && !a.organiser) throw forbidden('Only the organiser can do this');
  return { ev, access: a };
}

/** Live check for a derived para requirement. Returns [met: boolean, detail: string]. */
async function checkDerived(c, ev, deriveKey) {
  const q = (s, p) => (c ?? pool).query(s, p);
  if (deriveKey === 'para_classification_complete') {
    const unclassified = Number(((await q(
      `SELECT count(*)::int AS n FROM reg_registrations r
        WHERE r.event_id=$1 AND r.status IN ('submitted','under_review','registered')
          AND NOT EXISTS (
            SELECT 1 FROM para_entry_snapshots s
            WHERE s.registration_id=r.id AND s.check_status='pass'
          )`, [ev.id])).rows[0]?.n ?? 0));
    return [unclassified === 0, unclassified === 0 ? 'All entries classified' : `${unclassified} entr${unclassified === 1 ? 'y' : 'ies'} without confirmed class`];
  }
  if (deriveKey === 'para_medical_specialist') {
    const k = Number(((await q(
      `SELECT count(*)::int AS n FROM event_staff_assignments a
        JOIN event_staff_roles r ON r.id=a.role_id
        WHERE a.event_id=$1 AND a.status='accepted'
          AND r.role IN ('doctor','physio','medic')`, [ev.id])).rows[0]?.n ?? 0));
    return [k > 0, k > 0 ? `${k} medical staff confirmed` : 'No para-qualified medical staff assigned'];
  }
  if (deriveKey === 'para_equipment_delivered') {
    const k = Number(((await q(
      `SELECT count(*)::int AS n FROM event_requests
        WHERE event_id=$1 AND kind='supplier' AND status='finalized'`, [ev.id])).rows[0]?.n ?? 0));
    return [k > 0, k > 0 ? `${k} supplier record(s) finalized` : 'No supplier delivery confirmed'];
  }
  return [false, 'Unknown derived check'];
}

/** Load the approved exception for a requirement, if any. */
async function approvedException(c, reqId) {
  return (await (c ?? pool).query(
    `SELECT id, status, evidence_ref, valid_until, approved_by, second_officer_id, second_officer_approved_at, created_at
       FROM para_readiness_exceptions
      WHERE requirement_id=$1 AND status='approved'
        AND (valid_until IS NULL OR valid_until >= current_date)
      ORDER BY created_at DESC LIMIT 1`, [reqId])).rows[0] ?? null;
}

/** Build the full readiness picture for a para event. */
async function paraReadinessOf(ev, c) {
  const q = (s, p) => (c ?? pool).query(s, p);
  const rows = (await q(
    `SELECT r.*, u.display_name AS owner_name, sb.display_name AS signoff_by_name
       FROM event_ops_requirements r
       LEFT JOIN users u ON u.id=r.owner_id
       LEFT JOIN users sb ON sb.id=r.signoff_by
      WHERE r.event_id=$1 AND r.para_category IS NOT NULL AND r.archived_at IS NULL
      ORDER BY r.created_at, r.title`, [ev.id])).rows;

  const items = [];
  for (const r of rows) {
    let met = false, detail = r.waived_reason ?? null;
    if (r.status === 'waived') {
      met = false; // waived doesn't count as met but doesn't block
    } else if (r.derive_key) {
      [met, detail] = await checkDerived(c, ev, r.derive_key);
    } else {
      met = r.status === 'done' && !!r.done_at;
      if (!detail) detail = met ? (r.evidence_ref ?? 'Completed') : 'Not yet confirmed';
    }
    const state = r.status === 'waived' ? 'waived' : met ? 'met' : 'open';
    const exc = state === 'open' ? await approvedException(c, r.id) : null;
    const pendingExc = state === 'open' ? (await q(
      `SELECT id, status FROM para_readiness_exceptions WHERE requirement_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [r.id])).rows[0] ?? null : null;
    items.push({
      id: r.id, para_category: r.para_category, category_label: CAT_LABEL[r.para_category] ?? r.para_category,
      title: r.title, is_safety_critical: r.is_safety_critical, derive_key: r.derive_key ?? null,
      state, detail, evidence_ref: r.evidence_ref ?? null,
      signoff_at: r.signoff_at ?? null, signoff_by_name: r.signoff_by_name ?? null,
      changed_since_signoff: r.changed_since_signoff,
      owner_id: r.owner_id ?? null, owner_name: r.owner_name ?? null, due_on: r.due_on ?? null,
      exception: exc ?? null, pending_exception: pendingExc ?? null,
    });
  }

  const counted = items.filter((i) => i.state !== 'waived');
  const metCount = counted.filter((i) => i.state === 'met').length;
  const blockers = items.filter((i) => i.is_safety_critical && i.state === 'open' && !i.exception);
  const byCategory = {};
  for (const i of items) {
    const cat = (byCategory[i.para_category] ??= { para_category: i.para_category, label: i.category_label, met: 0, total: 0, has_blocker: false });
    if (i.state !== 'waived') { cat.total++; if (i.state === 'met') cat.met++; }
    if (i.state === 'open' && i.is_safety_critical && !i.exception) cat.has_blocker = true;
  }
  return {
    percent: counted.length ? Math.round((metCount / counted.length) * 100) : 0,
    met: metCount, total: counted.length,
    safety_critical_open: blockers.length,
    other_open: items.filter((i) => !i.is_safety_critical && i.state === 'open').length,
    exceptions_pending: items.filter((i) => !!i.pending_exception).length,
    waived: items.filter((i) => i.state === 'waived').length,
    can_open: blockers.length === 0,
    blockers: blockers.map((b) => ({ id: b.id, title: b.title })),
    categories: Object.values(byCategory),
    items,
    note: 'Normal (non-para) events are not affected. Items only appear when added explicitly.',
  };
}

// ---------------------------------------------------------------- capabilities

cap({
  name: 'get_para_readiness', method: 'GET', path: '/events/:id/ops/para-readiness', tag: TAG,
  summary: 'Accessibility readiness dashboard for a para-sport event: every para-specific requirement with its live state (derived from real records where possible), safety-critical blockers, exceptions and sign-off trail. Visible to the organiser, department leads and crew. `can_open` is false while any safety-critical item is unmet and has no approved exception — this gate is checked when the event is opened.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { ev } = await loadParaEvent(user, i.id);
    return paraReadinessOf(ev);
  },
});

cap({
  name: 'add_para_standard_requirements', method: 'POST', path: '/events/:id/ops/para-readiness/requirements/standard', tag: TAG, status: 201,
  summary: 'Add the standard para-sport accessibility requirements for this event. Safe to repeat: items already there (even waived or done) are kept and none are duplicated. Pass `keys` for a subset.',
  input: z.object({ id, keys: z.array(z.string()).max(20).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadParaEvent(user, i.id, 'organiser', c);
      const want = i.keys ?? PARA_STANDARD.map((s) => s.key);
      const bad = want.filter((k) => !PARA_STANDARD_BY_KEY[k]);
      if (bad.length) throw badRequest(`Unknown para requirement key: ${bad.join(', ')}`);
      let added = 0;
      for (const k of want) {
        const s = PARA_STANDARD_BY_KEY[k];
        const r = await c.query(
          `INSERT INTO event_ops_requirements(event_id, area, title, derive_key, para_category, is_safety_critical, required, created_by)
           VALUES ($1,'safety',$2,$3,$4,$5,true,$6)
           ON CONFLICT (event_id, derive_key) WHERE derive_key IS NOT NULL AND archived_at IS NULL DO NOTHING`,
          [ev.id, s.title, s.derive_key ?? null, s.para_category, s.is_safety_critical, user.id]);
        if (!s.derive_key) {
          // manual items use title as the unique signal (no derive_key conflict guard)
          const exists = (await c.query(
            `SELECT 1 FROM event_ops_requirements WHERE event_id=$1 AND title=$2 AND para_category=$3 AND archived_at IS NULL`, [ev.id, s.title, s.para_category])).rowCount;
          if (!exists) {
            await c.query(
              `INSERT INTO event_ops_requirements(event_id, area, title, para_category, is_safety_critical, required, created_by)
               VALUES ($1,'safety',$2,$3,$4,true,$5)`, [ev.id, s.title, s.para_category, s.is_safety_critical, user.id]);
            added++;
          }
        } else {
          added += r.rowCount;
        }
      }
      return { added, readiness: await paraReadinessOf(ev, c) };
    });
  },
});

cap({
  name: 'sign_off_para_requirement', method: 'POST', path: '/events/:id/ops/para-readiness/signoff', tag: TAG, status: 201,
  summary: 'Sign off a manual para readiness requirement with an evidence reference (booking ID, supplier contract, staff assignment, document ref). Marks the requirement done and stores the evidence trail. The organiser or the requirement owner may sign off.',
  input: z.object({ id, requirement_id: id, evidence_ref: text(500).min(5), note: text(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, access } = await loadParaEvent(user, i.id, null, c);
      const r = (await c.query('SELECT * FROM event_ops_requirements WHERE id=$1 AND event_id=$2 AND para_category IS NOT NULL AND archived_at IS NULL FOR UPDATE', [i.requirement_id, ev.id])).rows[0];
      if (!r) throw notFound('Para readiness requirement');
      if (r.derive_key) throw badRequest('This requirement is derived from live records and cannot be manually signed off; it updates automatically');
      if (!access.organiser && r.owner_id !== user.id) throw forbidden('Only the organiser or the requirement owner may sign off');
      await c.query(
        `UPDATE event_ops_requirements SET status='done', done_at=now(), done_by=$2, evidence_ref=$3, signoff_at=now(), signoff_by=$2, changed_since_signoff=false WHERE id=$1`,
        [r.id, user.id, i.evidence_ref]);
      await c.query(
        `INSERT INTO para_readiness_signoffs(event_id, requirement_id, signed_by, evidence_ref, note_enc)
         VALUES ($1,$2,$3,$4,$5)`,
        [ev.id, r.id, user.id, i.evidence_ref, i.note ? encrypt(i.note, 'para_readiness_signoffs.note_enc') : null]);
      await audit(c, user.id, 'signoff_para_requirement', 'event_ops_requirements', r.id);
      if (r.owner_id && r.owner_id !== user.id) {
        await notify(c, r.owner_id, { kind: 'para_readiness', title: 'Para requirement signed off', body: `${r.title} — ${ev.name}`, data: { event_id: ev.id } });
      }
      return { signed_off: true, requirement_id: r.id, evidence_ref: i.evidence_ref, at: new Date().toISOString() };
    });
  },
});

cap({
  name: 'create_para_readiness_exception', method: 'POST', path: '/events/:id/ops/para-readiness/exceptions', tag: TAG, status: 201,
  summary: 'Document a governed exception for a para readiness item that cannot be met in its standard form. Safety-critical items require a named second officer who must independently approve — silent bypass is never allowed. The justification is encrypted at rest and audit-logged on every read.',
  input: z.object({
    id, requirement_id: id,
    justification: z.string().trim().min(20).max(2000).describe('why the standard cannot be met and what alternative arrangement is in place; encrypted at rest'),
    evidence_ref: text(500).optional().describe('supplier contract, document reference, booking confirmation supporting the exception'),
    valid_until: date.optional(),
    second_officer_id: id.optional().describe('required for safety-critical items'),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadParaEvent(user, i.id, 'organiser', c);
      const r = (await c.query('SELECT * FROM event_ops_requirements WHERE id=$1 AND event_id=$2 AND para_category IS NOT NULL AND archived_at IS NULL', [i.requirement_id, ev.id])).rows[0];
      if (!r) throw notFound('Para readiness requirement');
      if (r.is_safety_critical && !i.second_officer_id) throw badRequest('Safety-critical items require a second officer to review the exception');
      if (i.second_officer_id && i.second_officer_id === user.id) throw badRequest('The second officer must be a different person');
      if (i.second_officer_id) {
        const officer = (await c.query('SELECT 1 FROM event_staff_assignments WHERE event_id=$1 AND user_id=$2 AND status=\'accepted\' LIMIT 1', [ev.id, i.second_officer_id])).rowCount;
        const isOrg = (await c.query('SELECT 1 FROM events WHERE id=$1 AND (organizer_id=$2 OR organisation_id IN (SELECT organisation_id FROM org_members WHERE user_id=$2 AND role IN (\'owner\',\'admin\')))', [ev.id, i.second_officer_id])).rowCount;
        if (!officer && !isOrg) throw badRequest('The second officer must be an accepted staff member or organiser of this event');
      }
      const exc = (await c.query(
        `INSERT INTO para_readiness_exceptions(event_id, requirement_id, justification_enc, evidence_ref, second_officer_id, approved_by, valid_until, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [ev.id, r.id, encrypt(i.justification, 'para_readiness_exceptions.justification_enc'), i.evidence_ref ?? null,
          i.second_officer_id ?? null, user.id, i.valid_until ?? null,
          r.is_safety_critical ? 'pending' : 'approved'])).rows[0];
      await audit(c, user.id, 'create_para_readiness_exception', 'para_readiness_exceptions', exc.id);
      if (i.second_officer_id) {
        await notify(c, i.second_officer_id, {
          kind: 'para_readiness_exception',
          title: `Exception review needed: ${r.title}`,
          body: `You are named as second officer for a safety-critical para readiness exception at ${ev.name}. Please review and approve or reject.`,
          data: { event_id: ev.id, exception_id: exc.id },
        });
      }
      return { id: exc.id, requirement_id: r.id, status: exc.status, justification: i.justification, evidence_ref: i.evidence_ref ?? null, valid_until: i.valid_until ?? null, second_officer_notified: !!i.second_officer_id };
    });
  },
});

cap({
  name: 'list_para_readiness_exceptions', method: 'GET', path: '/events/:id/ops/para-readiness/exceptions', tag: TAG,
  summary: 'All exceptions for para readiness items on this event, with decrypted justifications. Reading justifications is audit-logged. Manager only.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { ev } = await loadParaEvent(user, i.id, 'manager');
    const rows = await many(
      `SELECT e.*, r.title AS requirement_title, r.is_safety_critical,
              u.display_name AS approved_by_name, so.display_name AS second_officer_name
         FROM para_readiness_exceptions e
         JOIN event_ops_requirements r ON r.id=e.requirement_id
         JOIN users u ON u.id=e.approved_by
         LEFT JOIN users so ON so.id=e.second_officer_id
        WHERE e.event_id=$1
        ORDER BY e.created_at DESC LIMIT $2 OFFSET $3`, [ev.id, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'read_para_readiness_exceptions', 'para_readiness_exceptions', null);
    return rows.map((r) => ({
      id: r.id, requirement_id: r.requirement_id, requirement_title: r.requirement_title,
      is_safety_critical: r.is_safety_critical, status: r.status,
      justification: decrypt(r.justification_enc, 'para_readiness_exceptions.justification_enc'),
      evidence_ref: r.evidence_ref, valid_until: r.valid_until,
      approved_by_name: r.approved_by_name, second_officer_name: r.second_officer_name,
      second_officer_approved_at: r.second_officer_approved_at, rejection_reason: r.rejection_reason,
      created_at: r.created_at,
    }));
  },
});

cap({
  name: 'review_para_readiness_exception', method: 'POST', path: '/events/:id/ops/para-readiness/exceptions/:exception_id/review', tag: TAG,
  summary: 'Second officer: approve or reject a pending safety-critical exception. Only the designated second officer may call this. Approval is permanent and audit-logged; rejection sends the organiser back to the drawing board.',
  input: z.object({ id, exception_id: id, approved: z.boolean(), note: text(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadParaEvent(user, i.id, null, c);
      const exc = (await c.query('SELECT * FROM para_readiness_exceptions WHERE id=$1 AND event_id=$2 AND status=\'pending\' FOR UPDATE', [i.exception_id, ev.id])).rows[0];
      if (!exc) throw notFound('Pending exception');
      if (exc.second_officer_id !== user.id && !isAdmin(user)) throw forbidden('Only the designated second officer can review this exception');
      const status = i.approved ? 'approved' : 'rejected';
      await c.query(
        `UPDATE para_readiness_exceptions SET status=$2, second_officer_approved_at=now(),
           second_officer_note_enc=$3, rejection_reason=$4, updated_at=now()
         WHERE id=$1`,
        [exc.id, status, i.note ? encrypt(i.note, 'para_readiness_exceptions.second_officer_note_enc') : null, !i.approved ? (i.note ?? 'Rejected by second officer') : null]);
      await audit(c, user.id, 'review_para_readiness_exception', 'para_readiness_exceptions', exc.id);
      await notify(c, exc.approved_by, {
        kind: 'para_readiness_exception',
        title: `Exception ${status}: ${(await c.query('SELECT title FROM event_ops_requirements WHERE id=$1', [exc.requirement_id])).rows[0]?.title ?? ''}`,
        body: i.approved ? 'Your exception has been approved by the second officer.' : `Your exception was rejected: ${i.note ?? 'No reason given'}`,
        data: { event_id: ev.id, exception_id: exc.id },
      });
      return { id: exc.id, status, reviewed_at: new Date().toISOString() };
    });
  },
});

cap({
  name: 'send_para_readiness_notification', method: 'POST', path: '/events/:id/ops/para-readiness/notify', tag: TAG, status: 201,
  summary: 'Send a role-appropriate notification about accessibility readiness or contingency plans. `role` controls who receives it: organiser = organiser + dept leads; venue = venue department members; official = accepted referees/umpires; athlete = accepted registrants (operational access info only — never readiness blockers or clinical data).',
  input: z.object({ id, role: z.enum(['organiser', 'venue', 'official', 'athlete']), message: text(1000), contingency_plan: text(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await loadParaEvent(user, i.id, 'organiser', c);
      let recipients = [];
      if (i.role === 'organiser') {
        const leads = (await c.query(
          `SELECT DISTINCT user_id FROM (
             SELECT d.lead_user_id AS user_id FROM event_departments d WHERE d.event_id=$1 AND d.status='active' AND d.lead_user_id IS NOT NULL
             UNION SELECT m.user_id FROM event_department_members m WHERE m.event_id=$1 AND m.status='active' AND m.role='lead'
           ) x`, [ev.id])).rows.map((r) => r.user_id);
        recipients = [...new Set([ev.organizer_id, ...leads].filter(Boolean))];
      } else if (i.role === 'venue') {
        recipients = (await c.query(
          `SELECT DISTINCT m.user_id FROM event_department_members m JOIN event_departments d ON d.id=m.department_id WHERE m.event_id=$1 AND m.status='active' AND d.kind='venue' AND d.status='active'`, [ev.id])).rows.map((r) => r.user_id);
      } else if (i.role === 'official') {
        recipients = (await c.query(
          `SELECT DISTINCT a.user_id FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE a.event_id=$1 AND a.status='accepted' AND r.role IN ('referee','umpire','linesman','scorer')`, [ev.id])).rows.map((r) => r.user_id);
      } else if (i.role === 'athlete') {
        recipients = (await c.query(
          `SELECT DISTINCT coalesce(t.owner_id, e.user_id) AS uid FROM event_entries e LEFT JOIN teams t ON t.id=e.team_id WHERE e.event_id=$1 AND e.status='accepted'`, [ev.id])).rows.map((r) => r.uid).filter(Boolean);
      }
      for (const uid of recipients) {
        await notify(c, uid, { kind: 'para_readiness', title: `Accessibility update: ${ev.name}`, body: i.message, data: { event_id: ev.id } });
      }
      await c.query(
        `INSERT INTO para_readiness_notifications(event_id, role, message, contingency_plan, recipient_ids, sent_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ev.id, i.role, i.message, i.contingency_plan ?? null, recipients, user.id]);
      return { sent: recipients.length, role: i.role };
    });
  },
});

cap({
  name: 'get_para_athlete_access', method: 'GET', path: '/events/:id/para/athlete-access', tag: TAG,
  summary: 'Approved arrival and access information for a registered athlete: accessible entrance, parking, warm-up route, medical support and support contact. Operational minimum only — no clinical data, no classification details, no readiness blockers. Audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = (await pool.query('SELECT id, name, starts_on, ends_on, venue_id, organizer_id, status FROM events WHERE id=$1', [i.id])).rows[0];
    if (!ev) throw notFound('Event');
    const isOrganiser = isAdmin(user) || ev.organizer_id === user.id ||
      (await pool.query('SELECT 1 FROM org_members om JOIN events e ON e.organisation_id=om.organisation_id WHERE e.id=$1 AND om.user_id=$2 AND om.role IN (\'owner\',\'admin\')', [i.id, user.id])).rowCount > 0;
    const isAthlete = (await pool.query(
      `SELECT 1 FROM event_entries e WHERE e.event_id=$1 AND e.status='accepted' AND (e.user_id=$2 OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id=e.team_id AND tm.user_id=$2 AND tm.status='active'))`, [i.id, user.id])).rowCount > 0;
    if (!isAthlete && !isOrganiser) throw notFound('Event access information');
    // Pull met accessible_facilities items as the access information
    const metItems = await many(
      `SELECT r.title, r.evidence_ref, r.para_category FROM event_ops_requirements r
        WHERE r.event_id=$1 AND r.para_category IN ('accessible_facilities','transport_access','medical','support_roles','communication')
          AND r.archived_at IS NULL AND (r.status='done' OR r.derive_key IS NOT NULL)
        ORDER BY r.para_category, r.created_at`, [i.id]);
    await audit(null, user.id, 'read_para_athlete_access', 'events', i.id);
    return {
      event: { id: ev.id, name: ev.name, starts_on: ev.starts_on, ends_on: ev.ends_on },
      access_items: metItems.map((r) => ({ category: r.para_category, title: r.title, detail: r.evidence_ref ?? null })),
      note: 'Operational access information approved for competing athletes. Clinical details are never included. Contact the event team for changes to your access needs.',
    };
  },
});

/**
 * Gate called by events.js when transitioning a para event to 'open'.
 * Throws conflict (para_readiness_blocked) if any safety-critical item is unmet and has no approved exception.
 * Does nothing (returns immediately) for events with no para readiness items — normal events are unaffected.
 */
export async function assertParaReadiness(c, ev) {
  const blockers = (await c.query(
    `SELECT r.id, r.title FROM event_ops_requirements r
      WHERE r.event_id=$1 AND r.is_safety_critical=true AND r.archived_at IS NULL
        AND r.para_category IS NOT NULL AND r.status NOT IN ('done','waived')
        AND NOT EXISTS (
          SELECT 1 FROM para_readiness_exceptions e
          WHERE e.requirement_id=r.id AND e.status='approved'
            AND (e.valid_until IS NULL OR e.valid_until >= current_date)
        )`, [ev.id])).rows;
  if (blockers.length) throw conflict(
    `${blockers.length} safety-critical accessibility requirement${blockers.length === 1 ? '' : 's'} must be met or have an approved exception before opening this event`,
    { code: 'para_readiness_blocked', blockers: blockers.map((b) => ({ id: b.id, title: b.title })) });
}
