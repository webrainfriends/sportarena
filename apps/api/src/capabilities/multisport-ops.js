// Multi-sport events, part 3: hiring referees/physios/doctors, shifts and medical cover, on-site incidents,
// announcements, certificates, trophies and the organiser dashboard.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { NOT_YOUTH_SQL, guardiansOf } from '../youth.js';
import { eventAccess, organizerOnly, houseBoard } from './multisport.js';
import {
  lockEvent, programmeFor, scheduleConflicts, assertStaffFree, assertCanHold, STAFF_ROLES, MEDICAL_ROLES, OFFICIATING_ROLES,
} from '../multisport.js';

const TAG = 'Multi-sport events';
const dt = z.string().datetime({ offset: true });
const staffRole = z.enum(STAFF_ROLES);

const mustStaff = async (c, staffId, lock = false) => {
  const s = (await c.query(`SELECT * FROM event_staff WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [staffId])).rows[0];
  if (!s) throw notFound('Crew member');
  return s;
};

// ---------------------------------------------------------------- crew: find, invite, respond

cap({
  name: 'find_event_crew', method: 'GET', path: '/events/:id/crew/search', tag: TAG,
  summary: 'Find people to hire for an event: referees by sport, physios and doctors by city, or anyone by name for volunteer/first-aider posts. Public profile fields and a rate hint; people already on the crew are marked.',
  input: z.object({ id, role: staffRole, sport: z.string().optional(), city: z.string().max(80).optional(), q: z.string().max(80).optional(), ...page }),
  async handler({ user }, i) {
    await organizerOnly(pool, user, i.id);
    const need = { referee: 'referee', umpire: 'referee', judge: 'referee', starter: 'referee', timekeeper: 'referee', physio: 'physio', doctor: 'doctor' }[i.role];
    const sport = i.sport ? await one('SELECT id FROM sports WHERE slug=$1 OR id::text=$1', [i.sport]) : null;
    if (i.sport && !sport) return [];
    const args = [i.id];
    const p = (v) => { args.push(v); return `$${args.length}`; };
    const joins = [], where = [NOT_YOUTH_SQL];
    let rate = 'NULL', city = 'NULL';
    if (need === 'referee') {
      joins.push(`JOIN sport_profiles sp ON sp.user_id=u.id AND sp.role='referee'${sport ? ` AND sp.sport_id=${p(sport.id)}` : ''}`);
      rate = 'max(sp.hourly_rate_cents)';
    } else if (need) {
      joins.push(`JOIN provider_profiles pp ON pp.user_id=u.id AND pp.provider_type='${need}' AND pp.listed${i.city ? ` AND lower(pp.city)=lower(${p(i.city)})` : ''}`);
      rate = 'max(pp.consult_fee_cents)'; city = 'max(pp.city)';
    }
    if (i.q) where.push(`(u.handle ILIKE ${p(i.q)} || '%' OR u.display_name ILIKE '%' || $${args.length} || '%')`);
    return many(
      `SELECT u.id, u.handle, u.display_name, u.avatar_emoji, u.avatar_url, u.roles, ${rate} AS rate_hint_cents, ${city} AS city,
              EXISTS (SELECT 1 FROM event_staff s WHERE s.event_id=$1 AND s.user_id=u.id AND s.status IN ('invited','accepted')) AS on_crew
         FROM users u ${joins.join(' ')} WHERE ${where.join(' AND ')} GROUP BY u.id ORDER BY u.display_name LIMIT ${p(i.limit)} OFFSET ${p(i.offset)}`, args);
  },
});

cap({
  name: 'invite_event_staff', method: 'POST', path: '/events/:id/staff', tag: TAG, status: 201,
  summary: 'Hire a referee, umpire, judge, scorer, physio, doctor, first aider or volunteer for the event with an agreed rate. They must accept. A doctor post needs the doctor role on SportArena, a physio post the physio role, officiating posts the referee role.',
  input: z.object({ id, user_id: id, role: staffRole, sport: z.string().optional().describe('officials: the sport they will officiate; omit for any'), rate_cents: z.number().int().min(0).max(100000000).default(0), currency: z.string().length(3).optional(), notes: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await organizerOnly(c, user, i.id);
      await programmeFor(c, ev.id);
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      const target = (await c.query('SELECT id, roles, display_name FROM users WHERE id=$1', [i.user_id])).rows[0];
      if (!target) throw notFound('User');
      assertCanHold(target.roles, i.role);
      let sportId = null;
      if (i.sport) {
        const sp = (await c.query('SELECT id FROM sports WHERE slug=$1 OR id::text=$1', [i.sport])).rows[0];
        if (!sp) throw notFound('Sport');
        sportId = sp.id;
        if (['referee', 'umpire', 'judge', 'starter', 'timekeeper'].includes(i.role) && !(await c.query("SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role='referee' AND sport_id=$2", [i.user_id, sp.id])).rowCount) throw badRequest('That person is not a referee for this sport');
      }
      let row;
      try {
        row = (await c.query('INSERT INTO event_staff(event_id, user_id, role, sport_id, rate_cents, currency, notes, invited_by) VALUES ($1,$2,$3,$4,$5,upper($6),$7,$8) RETURNING *',
          [ev.id, i.user_id, i.role, sportId, i.rate_cents, i.currency ?? ev.currency ?? 'INR', i.notes ?? null, user.id])).rows[0];
      } catch (e) { if (e.code === '23505') throw conflict('That person already has this post on the event'); throw e; }
      await notify(c, i.user_id, { kind: 'event_staff', title: `Invitation: ${i.role} at ${ev.name}`, body: `${ev.name} would like you as ${i.role}${i.rate_cents ? ` (${(i.rate_cents / 100).toFixed(2)} ${row.currency})` : ''}.`, data: { event_id: ev.id, staff_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'respond_event_staff', method: 'POST', path: '/event-staff/:id/respond', tag: TAG,
  summary: 'The invited person accepts or declines a crew post. An accepted post can later be left with decline (open shifts are released).',
  input: z.object({ id, response: z.enum(['accept', 'decline']), reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await mustStaff(c, i.id, true);
      if (s.user_id !== user.id) throw forbidden('This invitation is not yours');
      if (!['invited', 'accepted'].includes(s.status)) throw conflict(`Post is ${s.status}`);
      if (i.response === 'accept' && s.status === 'accepted') return s;
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [s.event_id])).rows[0];
      const status = i.response === 'accept' ? 'accepted' : 'declined';
      const row = (await c.query('UPDATE event_staff SET status=$2, responded_at=now(), notes=coalesce(notes,$3) WHERE id=$1 RETURNING *', [s.id, status, i.reason ?? null])).rows[0];
      if (status === 'declined') await c.query("UPDATE event_shifts SET status='cancelled' WHERE staff_id=$1 AND status='assigned'", [s.id]);
      await notify(c, ev.organizer_id, { kind: 'event_staff', title: `${s.role} ${status}`, body: `A ${s.role} ${status} the post at ${ev.name}.`, data: { event_id: ev.id, staff_id: s.id } });
      return row;
    });
  },
});

cap({
  name: 'release_event_staff', method: 'POST', path: '/event-staff/:id/release', tag: TAG,
  summary: 'Organiser ends a crew post: open shifts are cancelled and the person is told. Payment history is kept.',
  input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await mustStaff(c, i.id, true);
      const { ev } = await organizerOnly(c, user, s.event_id);
      if (!['invited', 'accepted'].includes(s.status)) throw conflict(`Post is ${s.status}`);
      await c.query("UPDATE event_shifts SET status='cancelled' WHERE staff_id=$1 AND status='assigned'", [s.id]);
      const row = (await c.query("UPDATE event_staff SET status='released', responded_at=coalesce(responded_at, now()), notes=coalesce($2,notes) WHERE id=$1 RETURNING *", [s.id, i.reason ?? null])).rows[0];
      await notify(c, s.user_id, { kind: 'event_staff', title: `Released from ${ev.name}`, body: i.reason ?? `You are no longer needed as ${s.role} at ${ev.name}.`, data: { event_id: ev.id, staff_id: s.id } });
      return row;
    });
  },
});

cap({
  name: 'list_event_staff', method: 'GET', path: '/events/:id/staff', tag: TAG,
  summary: 'The crew of an event with status, rate, payment and shift counts (organiser). Crew members see only their own posts.',
  input: z.object({ id, role: staffRole.optional(), status: z.enum(['invited', 'accepted', 'declined', 'released']).optional() }),
  async handler({ user }, i) {
    const { scope } = await eventAccess(pool, user, i.id);
    return many(
      `SELECT s.id, s.user_id, u.display_name, u.handle, s.role, s.sport_id, sp.name AS sport, s.status, s.rate_cents, s.currency, s.paid_cents, s.paid_at, s.notes, s.responded_at,
              (SELECT count(*)::int FROM event_shifts sh WHERE sh.staff_id=s.id AND sh.status='assigned') AS shifts
         FROM event_staff s JOIN users u ON u.id=s.user_id LEFT JOIN sports sp ON sp.id=s.sport_id
        WHERE s.event_id=$1 AND ($2::text IS NULL OR s.role=$2) AND ($3::text IS NULL OR s.status=$3) AND ($4 OR s.user_id=$5) ORDER BY s.role, u.display_name`,
      [i.id, i.role ?? null, i.status ?? null, scope.organizer, user.id]);
  },
});

cap({
  name: 'record_staff_payment', method: 'POST', path: '/event-staff/:id/payments', tag: TAG,
  summary: 'Record money paid to a crew member (cumulative). The platform does not move the money; this keeps the event\'s books and tells them.',
  input: z.object({ id, amount_cents: z.number().int().min(1).max(100000000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s = await mustStaff(c, i.id, true);
      const { ev } = await organizerOnly(c, user, s.event_id);
      const row = (await c.query('UPDATE event_staff SET paid_cents = paid_cents + $2, paid_at=now() WHERE id=$1 RETURNING *', [s.id, i.amount_cents])).rows[0];
      await notify(c, s.user_id, { kind: 'event_staff', title: 'Payment recorded', body: `${(i.amount_cents / 100).toFixed(2)} ${s.currency} recorded for ${ev.name}.`, data: { event_id: ev.id, staff_id: s.id } });
      return row;
    });
  },
});

// ---------------------------------------------------------------- shifts & coverage

cap({
  name: 'assign_shift', method: 'POST', path: '/event-staff/:id/shifts', tag: TAG, status: 201,
  summary: 'Put an accepted crew member to work: officiate a scheduled session (times follow the session) or cover a window (medical cover / duty). Refused if they have another shift or a fixture at the same time.',
  input: z.object({ id, session_id: id.optional(), starts_at: dt.optional(), ends_at: dt.optional(), location: z.string().max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s0 = await mustStaff(c, i.id);
      const { ev } = await organizerOnly(c, user, s0.event_id);
      await lockEvent(c, ev.id);
      const st = await mustStaff(c, i.id, true);
      if (st.status !== 'accepted') throw conflict('Only accepted crew can be assigned');
      let kind, start, end, location = i.location ?? null, sessionId = null;
      if (i.session_id) {
        const sess = (await c.query('SELECT s.*, d.sport_id FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id WHERE s.id=$1 AND s.event_id=$2', [i.session_id, ev.id])).rows[0];
        if (!sess) throw notFound('Session');
        if (!OFFICIATING_ROLES.includes(st.role)) throw badRequest('Only officiating roles are assigned to sessions; use a time window for cover');
        if (!sess.scheduled_at || !['scheduled', 'live'].includes(sess.status)) throw conflict('Schedule the session first');
        if (st.sport_id && st.sport_id !== sess.sport_id) throw badRequest('This official is hired for a different sport');
        kind = 'officiating'; sessionId = sess.id; start = sess.scheduled_at.toISOString(); end = new Date(sess.scheduled_at.getTime() + sess.duration_min * 60000).toISOString(); location = location ?? sess.location;
      } else {
        if (!i.starts_at || !i.ends_at) throw badRequest('Give session_id or starts_at/ends_at');
        if (new Date(i.ends_at) <= new Date(i.starts_at)) throw badRequest('ends_at must be after starts_at');
        kind = MEDICAL_ROLES.includes(st.role) ? 'medical_cover' : 'duty'; start = i.starts_at; end = i.ends_at;
      }
      if (sessionId && (await c.query("SELECT 1 FROM event_shifts WHERE staff_id=$1 AND session_id=$2 AND status='assigned'", [st.id, sessionId])).rowCount) throw conflict('Already assigned to this session');
      await assertStaffFree(c, st.user_id, start, end);
      const row = (await c.query('INSERT INTO event_shifts(event_id, staff_id, session_id, kind, starts_at, ends_at, location, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [ev.id, st.id, sessionId, kind, start, end, location, user.id])).rows[0];
      await notify(c, st.user_id, { kind: 'event_staff', title: `Shift at ${ev.name}`, body: `${kind.replace('_', ' ')} · ${new Date(start).toISOString().replace('T', ' ').slice(0, 16)} UTC${location ? ` · ${location}` : ''}`, data: { event_id: ev.id, shift_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'cancel_shift', method: 'POST', path: '/shifts/:id/cancel', tag: TAG,
  summary: 'Organiser removes a shift; the person is told.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const sh = (await c.query('SELECT * FROM event_shifts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!sh) throw notFound('Shift');
      const { ev } = await organizerOnly(c, user, sh.event_id);
      if (sh.status === 'cancelled') return sh;
      const row = (await c.query("UPDATE event_shifts SET status='cancelled' WHERE id=$1 RETURNING *", [i.id])).rows[0];
      const st = await mustStaff(c, sh.staff_id);
      await notify(c, st.user_id, { kind: 'event_staff', title: 'Shift cancelled', body: `A shift at ${ev.name} was cancelled.`, data: { event_id: ev.id, shift_id: sh.id } });
      return row;
    });
  },
});

cap({
  name: 'list_event_shifts', method: 'GET', path: '/events/:id/shifts', tag: TAG,
  summary: 'The duty roster: every shift with who, where and when (organiser). Crew see their own shifts.',
  input: z.object({ id, kind: z.enum(['officiating', 'medical_cover', 'duty']).optional(), include_cancelled: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const { scope } = await eventAccess(pool, user, i.id);
    return many(
      `SELECT sh.id, sh.kind, sh.starts_at, sh.ends_at, sh.location, sh.status, sh.session_id, s.label AS session, st.id AS staff_id, st.role, u.display_name
         FROM event_shifts sh JOIN event_staff st ON st.id=sh.staff_id JOIN users u ON u.id=st.user_id LEFT JOIN event_sessions s ON s.id=sh.session_id
        WHERE sh.event_id=$1 AND ($2::text IS NULL OR sh.kind=$2) AND ($3 OR sh.status='assigned') AND ($4 OR st.user_id=$5) ORDER BY sh.starts_at, u.display_name`,
      [i.id, i.kind ?? null, i.include_cancelled, scope.organizer, user.id]);
  },
});

cap({
  name: 'get_staffing_gaps', method: 'GET', path: '/events/:id/staffing-gaps', tag: TAG,
  summary: 'What is still uncovered: scheduled sessions with fewer officials than the discipline needs, and scheduled sessions with no doctor/physio/first-aider on cover during them.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await organizerOnly(pool, user, i.id);
    const [officials, medical] = await Promise.all([
      many(
        `SELECT s.id AS session_id, s.label, s.scheduled_at, d.name AS discipline, d.officials_required AS required,
                (SELECT count(*)::int FROM event_shifts sh WHERE sh.session_id=s.id AND sh.status='assigned') AS assigned
           FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id
          WHERE s.event_id=$1 AND s.status IN ('scheduled','live') AND s.scheduled_at IS NOT NULL
            AND (SELECT count(*) FROM event_shifts sh WHERE sh.session_id=s.id AND sh.status='assigned') < d.officials_required ORDER BY s.scheduled_at`, [i.id]),
      many(
        `SELECT s.id AS session_id, s.label, s.scheduled_at, s.duration_min, s.location, d.name AS discipline
           FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id
          WHERE s.event_id=$1 AND s.status IN ('scheduled','live') AND s.scheduled_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM event_shifts sh WHERE sh.event_id=s.event_id AND sh.kind='medical_cover' AND sh.status='assigned'
                              AND sh.starts_at <= s.scheduled_at AND sh.ends_at >= s.scheduled_at + s.duration_min * interval '1 minute'
                              AND (sh.location IS NULL OR s.location IS NULL OR lower(sh.location)=lower(s.location))) ORDER BY s.scheduled_at`, [i.id]),
    ]);
    return { sessions_missing_officials: officials, sessions_without_medical_cover: medical, ok: !officials.length && !medical.length };
  },
});

cap({
  name: 'list_my_event_duties', method: 'GET', path: '/me/event-duties', tag: TAG,
  summary: 'Your crew invitations and upcoming shifts across all multi-sport events (referees, physios, doctors, volunteers).',
  input: z.object({ include_past: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const [posts, shifts] = await Promise.all([
      many(`SELECT s.id, s.event_id, e.name AS event, e.starts_on, s.role, s.status, s.rate_cents, s.currency, s.paid_cents FROM event_staff s JOIN events e ON e.id=s.event_id WHERE s.user_id=$1 AND s.status IN ('invited','accepted') ORDER BY e.starts_on NULLS LAST`, [user.id]),
      many(`SELECT sh.id, sh.event_id, e.name AS event, sh.kind, sh.starts_at, sh.ends_at, sh.location, st.role, s.label AS session
              FROM event_shifts sh JOIN event_staff st ON st.id=sh.staff_id JOIN events e ON e.id=sh.event_id LEFT JOIN event_sessions s ON s.id=sh.session_id
             WHERE st.user_id=$1 AND sh.status='assigned' AND ($2 OR sh.ends_at > now()) ORDER BY sh.starts_at`, [user.id, i.include_past]),
    ]);
    return { posts, shifts };
  },
});

// ---------------------------------------------------------------- medical incidents

cap({
  name: 'report_medical_incident', method: 'POST', path: '/events/:id/medical-incidents', tag: TAG, status: 201,
  summary: 'On-site doctor, physio or first aider logs an injury/illness. Clinical text is encrypted; every read is audit-logged. A "not_cleared" outcome puts the participant on a medical hold (they cannot be nominated and are flagged on the timetable) until a later "cleared".',
  input: z.object({
    id, participant_id: id.optional(), session_id: id.optional(), severity: z.enum(['minor', 'moderate', 'serious', 'emergency']), outcome: z.enum(['treated_on_site', 'referred', 'ambulance', 'hospital']),
    return_to_play: z.enum(['cleared', 'restricted', 'not_cleared']).optional(), summary: z.string().min(2).max(500), details: z.string().max(5000).optional(), occurred_at: dt.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, scope } = await eventAccess(c, user, i.id);
      const medic = scope.staff.some((s) => MEDICAL_ROLES.includes(s.role));
      if (!medic && !isAdmin(user)) throw forbidden('Only the event\'s accepted doctors, physios and first aiders can log incidents');
      let p = null;
      if (i.participant_id) {
        p = (await c.query('SELECT * FROM event_participants WHERE id=$1 AND event_id=$2 FOR UPDATE', [i.participant_id, ev.id])).rows[0];
        if (!p) throw badRequest('Unknown participant');
      }
      if (i.session_id && !(await c.query('SELECT 1 FROM event_sessions WHERE id=$1 AND event_id=$2', [i.session_id, ev.id])).rowCount) throw badRequest('Unknown session');
      const row = (await c.query(
        `INSERT INTO event_medical_incidents(event_id, session_id, participant_id, reporter_id, severity, outcome, return_to_play, summary_enc, details_enc, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10, now())) RETURNING id, event_id, session_id, participant_id, severity, outcome, return_to_play, occurred_at, created_at`,
        [ev.id, i.session_id ?? null, i.participant_id ?? null, user.id, i.severity, i.outcome, i.return_to_play ?? null, encrypt(i.summary, 'event_medical_incidents.summary'), encrypt(i.details, 'event_medical_incidents.details'), i.occurred_at ?? null])).rows[0];
      await audit(c, user.id, 'write_clinical', 'event_medical_incidents', row.id);
      if (p && i.return_to_play) {
        const hold = i.return_to_play === 'not_cleared';
        if (hold !== p.medical_hold) {
          await c.query('UPDATE event_participants SET medical_hold=$2 WHERE id=$1', [p.id, hold]);
          const tell = [ev.organizer_id];
          if (p.house_id) { const h = (await c.query('SELECT manager_user_id FROM event_houses WHERE id=$1', [p.house_id])).rows[0]; if (h?.manager_user_id) tell.push(h.manager_user_id); }
          for (const u of new Set(tell)) await notify(c, u, { kind: 'event_medical', title: hold ? 'Medical hold' : 'Medical hold lifted', body: `${p.full_name} is ${hold ? 'not cleared to play' : 'cleared to play again'} (${ev.name}).`, data: { event_id: ev.id, participant_id: p.id } });
        }
      }
      return row;
    });
  },
});

cap({
  name: 'list_medical_incidents', method: 'GET', path: '/events/:id/medical-incidents', tag: TAG,
  summary: 'Incident log. Event doctors/physios/first aiders see the clinical text (audit-logged); the organiser sees severity, outcome and fitness status only; a participant sees their own.',
  input: z.object({ id, participant_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const { scope } = await eventAccess(pool, user, i.id);
    const medic = scope.staff.some((s) => MEDICAL_ROLES.includes(s.role)) || isAdmin(user);
    if (!medic && !scope.organizer && !scope.participantIds.length) throw forbidden();
    const rows = await many(
      `SELECT m.id, m.session_id, m.participant_id, p.full_name, m.severity, m.outcome, m.return_to_play, m.occurred_at, m.reporter_id, m.summary_enc, m.details_enc
         FROM event_medical_incidents m LEFT JOIN event_participants p ON p.id=m.participant_id
        WHERE m.event_id=$1 AND ($2::uuid IS NULL OR m.participant_id=$2) AND ($3 OR $4 OR m.participant_id = ANY($5::uuid[]))
        ORDER BY m.occurred_at DESC LIMIT $6 OFFSET $7`, [i.id, i.participant_id ?? null, medic, scope.organizer, scope.participantIds, i.limit, i.offset]);
    const out = [];
    let read = false;
    for (const { summary_enc, details_enc, reporter_id, ...r } of rows) {
      const own = scope.participantIds.includes(r.participant_id);
      if (medic || own) { read = true; out.push({ ...r, summary: decrypt(summary_enc, 'event_medical_incidents.summary'), details: decrypt(details_enc, 'event_medical_incidents.details') }); }
      else out.push(r); // organiser: no clinical text
    }
    if (read) await audit(null, user.id, 'read_clinical', 'event_medical_incidents', i.id);
    return out;
  },
});

// ---------------------------------------------------------------- announcements

async function audienceUsers(c, ev, a) {
  const set = new Set();
  const add = (rows) => rows.forEach((r) => r.u && set.add(r.u));
  const participants = async (where, args) => {
    const rows = (await c.query(`SELECT DISTINCT p.user_id AS u FROM event_participants p WHERE p.event_id=$1 AND p.status='active' AND p.user_id IS NOT NULL ${where}`, [ev.id, ...args])).rows;
    add(rows);
    for (const r of rows) for (const g of await guardiansOf(r.u, c)) set.add(g);
  };
  if (a.audience === 'all') {
    await participants('', []);
    add((await c.query('SELECT manager_user_id AS u FROM event_houses WHERE event_id=$1 AND archived_at IS NULL', [ev.id])).rows);
    add((await c.query("SELECT user_id AS u FROM event_staff WHERE event_id=$1 AND status='accepted'", [ev.id])).rows);
  } else if (a.audience === 'house') {
    await participants('AND p.house_id=$2', [a.house_id]);
    add((await c.query('SELECT manager_user_id AS u FROM event_houses WHERE id=$1', [a.house_id])).rows);
  } else if (a.audience === 'discipline') {
    await participants("AND EXISTS (SELECT 1 FROM discipline_nominations n WHERE n.participant_id=p.id AND n.discipline_id=$2 AND n.status IN ('nominated','confirmed'))", [a.discipline_id]);
    add((await c.query("SELECT h.manager_user_id AS u FROM event_houses h WHERE h.event_id=$1 AND EXISTS (SELECT 1 FROM discipline_nominations n WHERE n.house_id=h.id AND n.discipline_id=$2 AND n.status IN ('nominated','confirmed'))", [ev.id, a.discipline_id])).rows);
  } else if (a.audience === 'session') {
    const rows = (await c.query(`WITH pe AS (SELECT se.participant_id FROM event_session_entries se WHERE se.session_id=$1 AND se.participant_id IS NOT NULL AND se.result_status <> 'scratched'
        UNION SELECT n.participant_id FROM event_session_entries se JOIN discipline_nominations n ON n.team_id=se.team_id AND n.status IN ('nominated','confirmed') WHERE se.session_id=$1 AND se.result_status <> 'scratched')
      SELECT DISTINCT p.user_id AS u FROM pe JOIN event_participants p ON p.id=pe.participant_id WHERE p.user_id IS NOT NULL`, [a.session_id])).rows;
    add(rows);
    for (const r of rows) for (const g of await guardiansOf(r.u, c)) set.add(g);
    add((await c.query("SELECT st.user_id AS u FROM event_shifts sh JOIN event_staff st ON st.id=sh.staff_id WHERE sh.session_id=$1 AND sh.status='assigned'", [a.session_id])).rows);
  } else add((await c.query("SELECT user_id AS u FROM event_staff WHERE event_id=$1 AND status='accepted'", [ev.id])).rows);
  return [...set];
}

cap({
  name: 'send_announcement', method: 'POST', path: '/events/:id/announcements', tag: TAG, status: 201,
  summary: 'Tell people: everyone, one house, the entrants of a discipline, one session, or the crew. Reaches participants with accounts, house masters, assigned crew and the active guardians of young participants. The organiser can write to any audience; a house master only to their own house.',
  input: z.object({
    id, audience: z.enum(['all', 'house', 'discipline', 'session', 'staff']), house_id: id.optional(), discipline_id: id.optional(), session_id: id.optional(),
    title: z.string().min(2).max(120), body: z.string().min(2).max(2000), urgent: z.boolean().default(false),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev, scope } = await eventAccess(c, user, i.id);
      if (!scope.organizer && !(i.audience === 'house' && i.house_id && scope.houseIds.includes(i.house_id))) throw forbidden('Only the organiser (or a house master for their own house) can send this');
      if (i.audience === 'house' && !i.house_id) throw badRequest('house_id is required');
      if (i.audience === 'discipline' && !i.discipline_id) throw badRequest('discipline_id is required');
      if (i.audience === 'session' && !i.session_id) throw badRequest('session_id is required');
      if (i.house_id && !(await c.query('SELECT 1 FROM event_houses WHERE id=$1 AND event_id=$2', [i.house_id, ev.id])).rowCount) throw badRequest('Unknown house');
      if (i.discipline_id && !(await c.query('SELECT 1 FROM event_disciplines WHERE id=$1 AND event_id=$2', [i.discipline_id, ev.id])).rowCount) throw badRequest('Unknown discipline');
      if (i.session_id && !(await c.query('SELECT 1 FROM event_sessions WHERE id=$1 AND event_id=$2', [i.session_id, ev.id])).rowCount) throw badRequest('Unknown session');
      const users = (await audienceUsers(c, ev, i)).filter((u) => u !== user.id);
      const row = (await c.query(
        'INSERT INTO event_announcements(event_id, audience, house_id, discipline_id, session_id, title, body, urgent, recipients, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [ev.id, i.audience, i.house_id ?? null, i.discipline_id ?? null, i.session_id ?? null, i.title, i.body, i.urgent, users.length, user.id])).rows[0];
      for (const u of users) await notify(c, u, { kind: 'event_announcement', title: `${i.urgent ? '🚨 ' : ''}${i.title}`, body: i.body, data: { event_id: ev.id, announcement_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'list_announcements', method: 'GET', path: '/events/:id/announcements', tag: TAG,
  summary: 'Announcements you are entitled to read: the organiser sees all; everyone else sees those sent to everyone, their house, a discipline or session they are in, or the crew if they are crew.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { scope } = await eventAccess(pool, user, i.id);
    return many(
      `SELECT a.id, a.audience, a.house_id, a.discipline_id, a.session_id, a.title, a.body, a.urgent, a.recipients, a.created_at, u.display_name AS sent_by
         FROM event_announcements a JOIN users u ON u.id=a.sent_by
        WHERE a.event_id=$1 AND ($2 OR a.audience='all'
          OR (a.audience='house' AND (a.house_id = ANY($3::uuid[]) OR a.house_id IN (SELECT house_id FROM event_participants WHERE id = ANY($4::uuid[]))))
          OR (a.audience='discipline' AND EXISTS (SELECT 1 FROM discipline_nominations n WHERE n.discipline_id=a.discipline_id AND n.participant_id = ANY($4::uuid[]) AND n.status IN ('nominated','confirmed')))
          OR (a.audience='session' AND EXISTS (SELECT 1 FROM event_session_entries e WHERE e.session_id=a.session_id AND e.participant_id = ANY($4::uuid[])))
          OR (a.audience='staff' AND $5))
        ORDER BY a.created_at DESC LIMIT $6 OFFSET $7`, [i.id, scope.organizer, scope.houseIds, scope.participantIds, scope.staff.length > 0, i.limit, i.offset]);
  },
});

// ---------------------------------------------------------------- certificates

const newCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = randomBytes(12); return [...b].map((x) => A[x % A.length]).join(''); };
const KIND_BY_RANK = { 1: 'winner', 2: 'runner_up', 3: 'third' };
const ORD = (n) => ({ 1: 'Winner', 2: 'Runner-up', 3: 'Third place' }[n] ?? `Place ${n}`);

async function insertCert(c, ev, v) {
  for (let k = 0; k < 3; k++) {
    const r = await c.query(
      `INSERT INTO event_certificates(event_id, discipline_id, kind, title, citation, recipient_name, participant_id, team_id, house_id, rank, code, issued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING *`,
      [ev.id, v.discipline_id ?? null, v.kind, v.title, v.citation ?? null, v.recipient_name, v.participant_id ?? null, v.team_id ?? null, v.house_id ?? null, v.rank ?? null, newCode(), v.issued_by]);
    if (r.rowCount) return r.rows[0];
    const dup = await c.query(
      `SELECT 1 FROM event_certificates WHERE event_id=$1 AND discipline_id IS NOT DISTINCT FROM $2 AND kind=$3 AND title=$4 AND participant_id IS NOT DISTINCT FROM $5 AND team_id IS NOT DISTINCT FROM $6 AND house_id IS NOT DISTINCT FROM $7 AND revoked_at IS NULL`,
      [ev.id, v.discipline_id ?? null, v.kind, v.title, v.participant_id ?? null, v.team_id ?? null, v.house_id ?? null]);
    if (dup.rowCount) return null; // already issued
  }
  throw conflict('Could not allocate a certificate code, try again');
}

cap({
  name: 'issue_certificates', method: 'POST', path: '/disciplines/:id/certificates', tag: TAG, status: 201,
  summary: 'Issue winner / runner-up / third-place certificates (and optionally participation) for a finalized discipline, one per person — every member of a winning team gets theirs. Each carries a verification code; re-running never duplicates.',
  input: z.object({ id, places: z.number().int().min(1).max(8).default(3), participation: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = (await c.query('SELECT * FROM event_disciplines WHERE id=$1', [i.id])).rows[0];
      if (!d) throw notFound('Discipline');
      const { ev } = await organizerOnly(c, user, d.event_id);
      if (!d.finalized_at) throw conflict('Finalize the discipline first (finalize_discipline)');
      const placed = (await c.query(
        `SELECT p.rank, p.participant_id, p.team_id, p.house_id FROM event_points p WHERE p.discipline_id=$1 AND p.kind='placement' AND p.voided_at IS NULL AND p.rank <= $2 ORDER BY p.rank`, [d.id, i.places])).rows;
      const issued = [];
      const people = async (r) => (r.participant_id
        ? (await c.query('SELECT id, full_name FROM event_participants WHERE id=$1', [r.participant_id])).rows
        : (await c.query("SELECT p.id, p.full_name FROM discipline_nominations n JOIN event_participants p ON p.id=n.participant_id WHERE n.team_id=$1 AND n.status IN ('nominated','confirmed')", [r.team_id])).rows);
      const teamName = async (tid) => tid ? (await c.query('SELECT name FROM discipline_teams WHERE id=$1', [tid])).rows[0]?.name : null;
      const placedKeys = new Set();
      for (const r of placed) {
        const tn = await teamName(r.team_id);
        for (const p of await people(r)) {
          placedKeys.add(p.id);
          const cert = await insertCert(c, ev, { discipline_id: d.id, kind: KIND_BY_RANK[r.rank] ?? 'finalist', title: `${d.name} – ${ORD(r.rank)}`, citation: tn ? `Member of ${tn}` : null, recipient_name: p.full_name, participant_id: p.id, team_id: r.team_id, house_id: r.house_id, rank: r.rank, issued_by: user.id });
          if (cert) issued.push(cert);
        }
      }
      if (i.participation) {
        const took = (await c.query(
          `WITH pe AS (
             SELECT e.participant_id FROM event_session_entries e JOIN event_sessions s ON s.id=e.session_id
              WHERE s.discipline_id=$1 AND s.status='completed' AND e.result_status='finished' AND e.participant_id IS NOT NULL
             UNION SELECT n.participant_id FROM event_session_entries e JOIN event_sessions s ON s.id=e.session_id
               JOIN discipline_nominations n ON n.team_id=e.team_id AND n.status IN ('nominated','confirmed')
              WHERE s.discipline_id=$1 AND s.status='completed' AND e.result_status='finished')
           SELECT p.id, p.full_name, p.house_id FROM pe JOIN event_participants p ON p.id=pe.participant_id ORDER BY p.full_name`, [d.id])).rows;
        for (const p of took) {
          if (placedKeys.has(p.id)) continue;
          const cert = await insertCert(c, ev, { discipline_id: d.id, kind: 'participation', title: `${d.name} – Participation`, recipient_name: p.full_name, participant_id: p.id, house_id: p.house_id, issued_by: user.id });
          if (cert) issued.push(cert);
        }
      }
      return { discipline_id: d.id, issued: issued.length, certificates: issued };
    });
  },
});

cap({
  name: 'issue_certificate', method: 'POST', path: '/events/:id/certificates', tag: TAG, status: 201,
  summary: 'Issue a single certificate: MVP, house champion, spirit award or any custom title, to a participant, a team or a house.',
  input: z.object({ id, kind: z.enum(['mvp', 'house_champion', 'finalist', 'custom']).default('custom'), title: z.string().min(2).max(160), citation: z.string().max(400).optional(), participant_id: id.optional(), team_id: id.optional(), house_id: id.optional(), discipline_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await organizerOnly(c, user, i.id);
      let name;
      if (i.participant_id) name = (await c.query('SELECT full_name FROM event_participants WHERE id=$1 AND event_id=$2', [i.participant_id, ev.id])).rows[0]?.full_name;
      else if (i.team_id) name = (await c.query('SELECT t.name FROM discipline_teams t JOIN event_disciplines d ON d.id=t.discipline_id WHERE t.id=$1 AND d.event_id=$2', [i.team_id, ev.id])).rows[0]?.name;
      else if (i.house_id) name = (await c.query('SELECT name FROM event_houses WHERE id=$1 AND event_id=$2', [i.house_id, ev.id])).rows[0]?.name;
      else throw badRequest('Give a participant, team or house');
      if (!name) throw badRequest('Unknown recipient for this event');
      const cert = await insertCert(c, ev, { ...i, recipient_name: name, issued_by: user.id });
      if (!cert) throw conflict('That certificate was already issued');
      return cert;
    });
  },
});

cap({
  name: 'list_certificates', method: 'GET', path: '/events/:id/certificates', tag: TAG,
  summary: 'Certificates issued in an event: the organiser sees all, a house master their house, a participant their own.',
  input: z.object({ id, discipline_id: id.optional(), house_id: id.optional(), include_revoked: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const { scope } = await eventAccess(pool, user, i.id);
    return many(
      `SELECT c.id, c.kind, c.title, c.citation, c.recipient_name, c.participant_id, c.team_id, c.house_id, c.discipline_id, c.rank, c.code, c.issued_at, c.revoked_at
         FROM event_certificates c LEFT JOIN event_participants p ON p.id=c.participant_id
        WHERE c.event_id=$1 AND ($2::uuid IS NULL OR c.discipline_id=$2) AND ($3::uuid IS NULL OR c.house_id=$3 OR p.house_id=$3) AND ($4 OR c.revoked_at IS NULL)
          AND ($5 OR c.house_id = ANY($6::uuid[]) OR p.house_id = ANY($6::uuid[]) OR c.participant_id = ANY($7::uuid[]))
        ORDER BY c.issued_at DESC, c.recipient_name LIMIT $8 OFFSET $9`,
      [i.id, i.discipline_id ?? null, i.house_id ?? null, i.include_revoked, scope.organizer, scope.houseIds, scope.participantIds, i.limit, i.offset]);
  },
});

cap({
  name: 'list_my_certificates', method: 'GET', path: '/me/certificates', tag: TAG,
  summary: 'Your certificates across all events (participants with a linked account).',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(
    `SELECT c.id, c.event_id, e.name AS event, c.kind, c.title, c.citation, c.recipient_name, c.rank, c.code, c.issued_at
       FROM event_certificates c JOIN event_participants p ON p.id=c.participant_id JOIN events e ON e.id=c.event_id
      WHERE p.user_id=$1 AND c.revoked_at IS NULL ORDER BY c.issued_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'get_certificate', method: 'GET', path: '/certificates/:code', tag: TAG, auth: 'public',
  summary: 'Verify a certificate by the code printed on it: who it was awarded to, for what, by which event, and whether it is still valid.',
  input: z.object({ code: z.string().min(8).max(20) }),
  async handler(_, i) {
    const c = await one(
      `SELECT c.code, c.kind, c.title, c.citation, c.recipient_name, c.rank, c.issued_at, c.revoked_at, e.id AS event_id, e.name AS event, e.starts_on, d.name AS discipline, u.display_name AS issued_by
         FROM event_certificates c JOIN events e ON e.id=c.event_id LEFT JOIN event_disciplines d ON d.id=c.discipline_id LEFT JOIN users u ON u.id=c.issued_by WHERE c.code=$1`, [i.code.toUpperCase()]);
    if (!c) throw notFound('Certificate');
    return { ...c, valid: !c.revoked_at };
  },
});

cap({
  name: 'revoke_certificate', method: 'POST', path: '/certificates/:code/revoke', tag: TAG,
  summary: 'Withdraw a certificate issued by mistake. It stays on record as revoked, so verification shows it is no longer valid.',
  input: z.object({ code: z.string().min(8).max(20), reason: z.string().min(2).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cert = (await c.query('SELECT * FROM event_certificates WHERE code=$1 FOR UPDATE', [i.code.toUpperCase()])).rows[0];
      if (!cert) throw notFound('Certificate');
      await organizerOnly(c, user, cert.event_id);
      if (cert.revoked_at) return cert;
      return (await c.query('UPDATE event_certificates SET revoked_at=now(), revoked_reason=$2 WHERE id=$1 RETURNING *', [cert.id, i.reason])).rows[0];
    });
  },
});

// ---------------------------------------------------------------- trophies

cap({
  name: 'create_trophy', method: 'POST', path: '/events/:id/trophies', tag: TAG, status: 201,
  summary: 'Register a trophy: overall house champion, a discipline cup, best athlete… for houses, individuals or teams.',
  input: z.object({ id, name: z.string().min(2).max(120), scope: z.enum(['house', 'individual', 'team']), description: z.string().max(500).optional(), discipline_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { ev } = await organizerOnly(c, user, i.id);
      if (i.discipline_id && !(await c.query('SELECT 1 FROM event_disciplines WHERE id=$1 AND event_id=$2', [i.discipline_id, ev.id])).rowCount) throw badRequest('Unknown discipline');
      return (await c.query('INSERT INTO event_trophies(event_id, name, description, scope, discipline_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [ev.id, i.name, i.description ?? null, i.scope, i.discipline_id ?? null, user.id])).rows[0];
    });
  },
});

cap({
  name: 'award_trophy', method: 'POST', path: '/trophies/:id/award', tag: TAG, status: 201,
  summary: 'Hand a trophy to a house, participant or team — or let it be decided from the points (`auto`): overall trophies go to the top of the table. A tie is never broken silently: you are told who tied and must choose. Optionally issues the matching certificate. The previous holder stays in the trophy\'s history.',
  input: z.object({ id, house_id: id.optional(), participant_id: id.optional(), team_id: id.optional(), auto: z.boolean().default(false), note: z.string().max(300).optional(), issue_certificate: z.boolean().default(true) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM event_trophies WHERE id=$1', [i.id])).rows[0];
      if (!t) throw notFound('Trophy');
      const { ev } = await organizerOnly(c, user, t.event_id);
      let who = { house_id: i.house_id ?? null, participant_id: i.participant_id ?? null, team_id: i.team_id ?? null };
      if (i.auto) {
        const col = { house: 'house_id', individual: 'participant_id', team: 'team_id' }[t.scope];
        const rows = (await c.query(
          `SELECT ${col} AS subject, sum(points)::int AS points FROM event_points WHERE event_id=$1 AND voided_at IS NULL AND ${col} IS NOT NULL AND ($2::uuid IS NULL OR discipline_id=$2)
            GROUP BY ${col} ORDER BY points DESC LIMIT 3`, [ev.id, t.discipline_id])).rows;
        if (!rows.length) throw conflict('No points have been awarded yet');
        if (rows[1] && rows[1].points === rows[0].points) throw conflict('Tied on points — choose the winner yourself', { tied: rows.filter((r) => r.points === rows[0].points) });
        who = { house_id: null, participant_id: null, team_id: null, [col]: rows[0].subject };
      }
      if (!who.house_id && !who.participant_id && !who.team_id) throw badRequest('Give a recipient or use auto');
      if ({ house: !who.house_id, individual: !who.participant_id, team: !who.team_id }[t.scope]) throw badRequest(`This is a ${t.scope} trophy`);
      let name = null;
      if (who.house_id) name = (await c.query('SELECT name FROM event_houses WHERE id=$1 AND event_id=$2', [who.house_id, ev.id])).rows[0]?.name;
      else if (who.participant_id) { const p = (await c.query('SELECT full_name, house_id FROM event_participants WHERE id=$1 AND event_id=$2', [who.participant_id, ev.id])).rows[0]; name = p?.full_name; who.house_id = p?.house_id ?? null; }
      else { const tm = (await c.query('SELECT t.name, t.house_id FROM discipline_teams t JOIN event_disciplines d ON d.id=t.discipline_id WHERE t.id=$1 AND d.event_id=$2', [who.team_id, ev.id])).rows[0]; name = tm?.name; who.house_id = tm?.house_id ?? null; }
      if (!name) throw badRequest('Unknown recipient for this event');
      const award = (await c.query('INSERT INTO event_trophy_awards(trophy_id, house_id, participant_id, team_id, note, awarded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [t.id, who.house_id, who.participant_id, who.team_id, i.note ?? null, user.id])).rows[0];
      let certificate = null;
      if (i.issue_certificate) {
        certificate = await insertCert(c, ev, {
          discipline_id: t.discipline_id, kind: t.scope === 'house' ? 'house_champion' : t.scope === 'individual' ? 'mvp' : 'custom', title: t.name, citation: i.note, recipient_name: name,
          participant_id: t.scope === 'individual' ? who.participant_id : null, team_id: t.scope === 'team' ? who.team_id : null, house_id: t.scope === 'house' ? who.house_id : null, issued_by: user.id,
        });
      }
      return { ...award, trophy: t.name, recipient: name, certificate };
    });
  },
});

cap({
  name: 'list_trophies', method: 'GET', path: '/events/:id/trophies', tag: TAG, auth: 'public',
  summary: 'The trophy cabinet of an event: each trophy with its current holder and past holders. Individual names follow the programme\'s privacy setting.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const prog = await programmeFor(pool, i.id);
    const { scope } = user ? await eventAccess(pool, user, i.id) : { scope: { organizer: false } };
    const trophies = await many('SELECT * FROM event_trophies WHERE event_id=$1 ORDER BY created_at', [i.id]);
    const awards = await many(
      `SELECT a.*, h.name AS house, t.name AS team, p.full_name FROM event_trophy_awards a LEFT JOIN event_houses h ON h.id=a.house_id LEFT JOIN discipline_teams t ON t.id=a.team_id LEFT JOIN event_participants p ON p.id=a.participant_id
        WHERE a.trophy_id = ANY($1::uuid[]) ORDER BY a.awarded_at DESC`, [trophies.map((t) => t.id)]);
    const show = prog.public_names || scope.organizer;
    return trophies.map((t) => {
      const hist = awards.filter((a) => a.trophy_id === t.id).map((a) => ({ id: a.id, house: a.house, team: a.team, participant: show ? a.full_name : null, note: a.note, awarded_at: a.awarded_at }));
      return { ...t, holder: hist[0] ?? null, history: hist.slice(1) };
    });
  },
});

// ---------------------------------------------------------------- dashboards

cap({
  name: 'get_games_dashboard', method: 'GET', path: '/events/:id/dashboard', tag: TAG,
  summary: 'Organiser control room for a multi-sport event: counts of houses, people, disciplines, sessions by status, timetable clashes, unscheduled sessions, staffing and medical-cover gaps, certificates issued, and a checklist of what to do next.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { ev } = await organizerOnly(pool, user, i.id);
    const prog = await programmeFor(pool, i.id);
    const [counts, sessions, disc, gaps, certs, crew] = await Promise.all([
      one(`SELECT (SELECT count(*)::int FROM event_houses WHERE event_id=$1 AND archived_at IS NULL) AS houses,
                  (SELECT count(*)::int FROM event_participants WHERE event_id=$1 AND status='active') AS participants,
                  (SELECT count(*)::int FROM event_participants WHERE event_id=$1 AND status='active' AND house_id IS NULL) AS without_house,
                  (SELECT count(*)::int FROM event_participants WHERE event_id=$1 AND status='active' AND medical_hold) AS on_medical_hold,
                  (SELECT count(*)::int FROM event_participants p WHERE p.event_id=$1 AND p.status='active' AND NOT EXISTS (SELECT 1 FROM discipline_nominations n WHERE n.participant_id=p.id AND n.status IN ('nominated','confirmed'))) AS not_nominated`, [i.id]),
      many("SELECT status, count(*)::int AS n FROM event_sessions WHERE event_id=$1 GROUP BY status", [i.id]),
      many("SELECT status, count(*)::int AS n FROM event_disciplines WHERE event_id=$1 GROUP BY status", [i.id]),
      one(`SELECT (SELECT count(*)::int FROM event_sessions s JOIN event_disciplines d ON d.id=s.discipline_id WHERE s.event_id=$1 AND s.status IN ('scheduled','live') AND (SELECT count(*) FROM event_shifts sh WHERE sh.session_id=s.id AND sh.status='assigned') < d.officials_required) AS missing_officials,
                  (SELECT count(*)::int FROM event_sessions s WHERE s.event_id=$1 AND s.status IN ('scheduled','live') AND NOT EXISTS (SELECT 1 FROM event_shifts sh WHERE sh.event_id=s.event_id AND sh.kind='medical_cover' AND sh.status='assigned' AND sh.starts_at <= s.scheduled_at AND sh.ends_at >= s.scheduled_at + s.duration_min * interval '1 minute')) AS no_medical_cover`, [i.id]),
      one("SELECT count(*)::int AS issued FROM event_certificates WHERE event_id=$1 AND revoked_at IS NULL", [i.id]),
      many("SELECT role, status, count(*)::int AS n FROM event_staff WHERE event_id=$1 GROUP BY role, status", [i.id]),
    ]);
    const clashes = (await scheduleConflicts(pool, i.id, prog.rest_gap_min)).length;
    const st = Object.fromEntries(sessions.map((s) => [s.status, s.n]));
    const ds = Object.fromEntries(disc.map((s) => [s.status, s.n]));
    const todo = [];
    if (!counts.houses) todo.push('Create houses/groups');
    if (!counts.participants) todo.push('Register participants');
    if (!disc.length) todo.push('Add disciplines');
    if (counts.not_nominated) todo.push(`${counts.not_nominated} participant(s) are not nominated for anything`);
    if (st.draft) todo.push(`${st.draft} session(s) are not on the timetable`);
    if (clashes) todo.push(`${clashes} timetable clash(es)`);
    if (gaps.missing_officials) todo.push(`${gaps.missing_officials} session(s) need officials`);
    if (gaps.no_medical_cover) todo.push(`${gaps.no_medical_cover} session(s) have no medical cover`);
    return { event: { id: ev.id, name: ev.name, status: ev.status }, programme: prog, ...counts, sessions: st, disciplines: ds, clashes, ...gaps, certificates_issued: certs.issued, crew, houses_table: await houseBoard(null, i.id), todo };
  },
});

cap({
  name: 'get_my_games', method: 'GET', path: '/me/games', tag: TAG,
  summary: 'Everything for you across multi-sport events: where you compete (house, nominations, upcoming sessions, points, certificates), houses you manage, and your crew posts.',
  input: z.object({}),
  async handler({ user }) {
    const [mine, managed, duties] = await Promise.all([
      many(
        `SELECT p.id AS participant_id, p.event_id, e.name AS event, e.starts_on, p.house_id, h.name AS house, p.medical_hold,
                coalesce((SELECT json_agg(json_build_object('discipline_id', d.id, 'name', d.name, 'status', n.status, 'team', t.name) ORDER BY d.name)
                            FROM discipline_nominations n JOIN event_disciplines d ON d.id=n.discipline_id LEFT JOIN discipline_teams t ON t.id=n.team_id WHERE n.participant_id=p.id AND n.status IN ('nominated','confirmed')), '[]') AS nominations,
                coalesce((SELECT sum(points)::int FROM event_points x WHERE x.participant_id=p.id AND x.voided_at IS NULL), 0) AS points,
                (SELECT count(*)::int FROM event_certificates c WHERE c.participant_id=p.id AND c.revoked_at IS NULL) AS certificates
           FROM event_participants p JOIN events e ON e.id=p.event_id LEFT JOIN event_houses h ON h.id=p.house_id WHERE p.user_id=$1 AND p.status='active' ORDER BY e.starts_on DESC NULLS LAST`, [user.id]),
      many("SELECT h.id, h.name, h.event_id, e.name AS event FROM event_houses h JOIN events e ON e.id=h.event_id WHERE h.manager_user_id=$1 AND h.archived_at IS NULL ORDER BY e.starts_on DESC NULLS LAST", [user.id]),
      many("SELECT s.id, s.event_id, e.name AS event, s.role, s.status FROM event_staff s JOIN events e ON e.id=s.event_id WHERE s.user_id=$1 AND s.status IN ('invited','accepted')", [user.id]),
    ]);
    const sessions = await many(
      `WITH pe AS (SELECT se.session_id, se.participant_id FROM event_session_entries se WHERE se.participant_id IS NOT NULL AND se.result_status <> 'scratched'
                   UNION SELECT se.session_id, n.participant_id FROM event_session_entries se JOIN discipline_nominations n ON n.team_id=se.team_id AND n.status IN ('nominated','confirmed') WHERE se.result_status <> 'scratched')
       SELECT s.id, s.event_id, s.label, s.stage, s.scheduled_at, s.duration_min, coalesce(r.name, s.location) AS ground, s.status
         FROM pe JOIN event_participants p ON p.id=pe.participant_id JOIN event_sessions s ON s.id=pe.session_id LEFT JOIN resources r ON r.id=s.resource_id
        WHERE p.user_id=$1 AND s.status IN ('scheduled','live') AND s.scheduled_at > now() - interval '3 hours' ORDER BY s.scheduled_at LIMIT 50`, [user.id]);
    return { participating: mine, managing_houses: managed, crew: duties, upcoming_sessions: sessions };
  },
});
