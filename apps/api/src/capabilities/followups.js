// Follow-ups and external booking for health appointments (SPOR-75, 76, 77).
// A follow-up is agreed at an appointment: the athlete sees a plain instruction summary, due date/window and status. Anything
// sensitive is kept encrypted in details_enc and is only readable by the athlete, or by a provider with an active full consent
// (every read is audit-logged). Provider-private clinical notes live in medical_records and never appear here.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { DISCLOSURE, adapterFor } from '../health/external-booking.js';

const TAG = 'Health';
const date = z.string().date();
const today = () => new Date().toISOString().slice(0, 10);
const SUMMARY = `f.id, f.appointment_id, f.athlete_id, f.provider_id, f.status, f.due_on, f.window_end, f.instruction_summary, f.booked_appointment_id, f.completed_at, f.created_at,
  (f.details_enc IS NOT NULL) AS has_details, (f.status = 'due' AND coalesce(f.window_end, f.due_on) < current_date) AS overdue,
  ua.display_name AS athlete_name, up.display_name AS provider_name`;
const JOIN = 'FROM appointment_followups f JOIN users ua ON ua.id=f.athlete_id JOIN users up ON up.id=f.provider_id';

const hasFullGrant = async (athleteId, providerId, c) => !!(await (c ? (t, p) => c.query(t, p).then((r) => r.rows[0]) : one)(
  "SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND scope='full' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [athleteId, providerId]));

cap({
  name: 'create_followup', method: 'POST', path: '/followups', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Provider: agree a follow-up with the athlete after an appointment. `instruction_summary` is what the athlete reads (keep it practical, not a diagnosis); optional `details` are sensitive, stored encrypted and need the athlete\'s active full consent to write. The athlete is notified without any detail.',
  input: z.object({ appointment_id: id, due_on: date, window_end: date.optional(), instruction_summary: z.string().min(3).max(500), details: z.string().max(3000).optional() }),
  async handler({ user }, i) {
    if (i.due_on < today()) throw badRequest('The follow-up date is in the past');
    if (i.window_end && i.window_end < i.due_on) throw badRequest('window_end is before due_on');
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [i.appointment_id])).rows[0];
      if (!a || a.provider_id !== user.id) throw notFound('Appointment');
      if (!['confirmed', 'completed'].includes(a.status)) throw conflict('Follow-ups can be agreed once the appointment is confirmed');
      if (i.details && !(await hasFullGrant(a.athlete_id, user.id, c))) throw forbidden('The athlete has not granted you access to sensitive details');
      const row = (await c.query(
        'INSERT INTO appointment_followups(appointment_id, athlete_id, provider_id, due_on, window_end, instruction_summary, details_enc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, appointment_id, status, due_on, window_end, instruction_summary',
        [a.id, a.athlete_id, user.id, i.due_on, i.window_end ?? null, i.instruction_summary, i.details ? encrypt(i.details, 'appointment_followups.details') : null])).rows[0];
      if (i.details) await audit(c, user.id, 'write_clinical', 'appointment_followups', row.id);
      await notify(c, a.athlete_id, { kind: 'followup_created', title: 'A follow-up was agreed', body: 'Open Health to see when and what to do.', data: { followup_id: row.id } });
      return row;
    });
  },
});

cap({
  name: 'list_my_followups', method: 'GET', path: '/followups', tag: TAG,
  summary: 'Your follow-ups as athlete or provider: status, due date or window, the instruction summary, and whether it is overdue. Sensitive details are not listed; use get_followup.',
  input: z.object({ status: z.enum(['due', 'booked', 'done', 'cancelled', 'open']).optional().describe('open = due or booked'), ...page }),
  handler: ({ user }, i) => many(
    `SELECT ${SUMMARY}, (f.athlete_id=$1) AS i_am_athlete ${JOIN}
      WHERE (f.athlete_id=$1 OR f.provider_id=$1) AND ($2::text IS NULL OR f.status=$2 OR ($2='open' AND f.status IN ('due','booked')))
      ORDER BY (f.status IN ('due','booked')) DESC, f.due_on LIMIT $3 OFFSET $4`, [user.id, i.status ?? null, i.limit, i.offset]),
});

cap({
  name: 'get_followup', method: 'GET', path: '/followups/:id', tag: TAG,
  summary: 'One follow-up. The athlete always sees their own sensitive details; a provider sees them only while the athlete\'s full consent is active. Every read of details is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const f = await one(`SELECT ${SUMMARY}, f.details_enc ${JOIN} WHERE f.id=$1`, [i.id]);
    if (!f || (f.athlete_id !== user.id && f.provider_id !== user.id && !isAdmin(user))) throw notFound('Follow-up');
    const { details_enc, ...pub } = f;
    let details = null, details_visible = true;
    if (details_enc) {
      if (f.athlete_id === user.id || (f.provider_id === user.id && await hasFullGrant(f.athlete_id, user.id))) {
        details = decrypt(details_enc, 'appointment_followups.details');
        await audit(null, user.id, 'read_clinical', 'appointment_followups', f.id);
      } else details_visible = false;
    }
    return { ...pub, details, details_visible };
  },
});

cap({
  name: 'update_followup', method: 'PATCH', path: '/followups/:id', tag: TAG,
  summary: 'Complete, cancel or reschedule an open follow-up. Either party can mark it done or cancel it; reschedule (a new due_on / window_end) is allowed for the athlete or the provider while it is due. To book the visit use book_appointment with followup_id: the follow-up becomes `booked`, then `done` when that appointment is completed (or back to `due` if it is cancelled).',
  input: z.object({ id, status: z.enum(['done', 'cancelled']).optional(), due_on: date.optional(), window_end: date.nullable().optional() }).refine((v) => v.status || v.due_on || v.window_end !== undefined, 'Give a status or a new date'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT * FROM appointment_followups WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!f || (f.athlete_id !== user.id && f.provider_id !== user.id && !isAdmin(user))) throw notFound('Follow-up');
      if (!['due', 'booked'].includes(f.status)) throw conflict(`This follow-up is already ${f.status}`);
      if (i.status === 'done') {
        await c.query("UPDATE appointment_followups SET status='done', completed_at=now(), closed_by=$2, updated_at=now() WHERE id=$1", [f.id, user.id]);
      } else if (i.status === 'cancelled') {
        await c.query("UPDATE appointment_followups SET status='cancelled', closed_by=$2, updated_at=now() WHERE id=$1", [f.id, user.id]);
      } else {
        if (f.status !== 'due') throw conflict('A follow-up that is already booked is rescheduled by changing its appointment');
        const due = i.due_on ?? f.due_on, end = i.window_end === undefined ? f.window_end : i.window_end;
        if (due < today()) throw badRequest('The new date is in the past');
        if (end && end < due) throw badRequest('window_end is before due_on');
        await c.query('UPDATE appointment_followups SET due_on=$2, window_end=$3, reminder_sent_at=NULL, updated_at=now() WHERE id=$1', [f.id, due, end]);
      }
      await audit(c, user.id, 'update_followup', 'appointment_followups', f.id);
      const other = f.athlete_id === user.id ? f.provider_id : f.athlete_id;
      if (other !== user.id) await notify(c, other, { kind: 'followup_update', title: 'A follow-up was updated', body: 'Open Health to see the change.', data: { followup_id: f.id } });
      return (await c.query('SELECT id, status, due_on, window_end FROM appointment_followups WHERE id=$1', [f.id])).rows[0];
    });
  },
});

// ------------------------------------------------------------------ external booking (SPOR-77)
cap({
  name: 'start_external_booking', method: 'GET', path: '/providers/:id/external-booking', tag: TAG,
  summary: 'If this provider takes bookings on another site, get the address to send the person to, plus the notice that must be shown before they leave SportArena. Nothing personal is added to the link. Afterwards call link_external_booking to record the booking here.',
  input: z.object({ id }),
  async handler(_, i) {
    const p = await one('SELECT external_provider, external_booking_url, listed FROM provider_profiles WHERE user_id=$1', [i.id]);
    const ad = p?.listed && p.external_booking_url && adapterFor(p.external_provider);
    if (!ad) throw notFound('External booking');
    return { provider_id: i.id, external: { provider: ad.id, label: ad.label, url: ad.deepLink({ url: p.external_booking_url }) }, disclosure: DISCLOSURE, next: { capability: 'link_external_booking' } };
  },
});

const EXT_STATUS = z.enum(['requested', 'confirmed']);
const NEXT = { requested: ['confirmed', 'cancelled'], confirmed: ['completed', 'cancelled'], completed: [], cancelled: [] };

cap({
  name: 'link_external_booking', method: 'POST', path: '/appointments/external', tag: TAG, status: 201,
  summary: 'Record a booking made on the provider\'s own site as a SportArena appointment. The athlete calls it with provider_id after booking; the provider calls it with athlete_id to register one for a patient. Only the external reference, address and times are stored. The same reference is always the same appointment (calling again updates it, never duplicates it). No reason or clinical text is taken here.',
  input: z.object({ provider_id: id.optional(), athlete_id: id.optional(), external_reference: z.string().min(2).max(120), starts_at: z.string().datetime({ offset: true }), duration_min: z.number().int().min(10).max(240).default(30), mode: z.enum(['in_person', 'remote']).default('in_person'), status: EXT_STATUS.default('requested'), external_url: z.string().max(500).optional() }),
  async handler({ user }, i) {
    const asProvider = !!i.athlete_id && !i.provider_id;
    const providerId = asProvider ? user.id : i.provider_id, athleteId = asProvider ? i.athlete_id : user.id;
    if (!providerId) throw badRequest('Give provider_id (athlete) or athlete_id (provider)');
    if (asProvider && !user.roles.some((r) => ['physio', 'doctor'].includes(r))) throw forbidden('Only a physio or doctor can register a booking for a patient');
    if (providerId === athleteId) throw badRequest('A provider cannot book themselves');
    if (!asProvider && i.status !== 'requested') throw forbidden('Only the provider can mark a booking confirmed');
    return tx(async (c) => {
      const prof = (await c.query('SELECT external_provider, external_booking_url FROM provider_profiles WHERE user_id=$1', [providerId])).rows[0];
      const ad = prof?.external_booking_url && adapterFor(prof.external_provider);
      if (!ad) throw conflict('This provider does not take bookings on another site');
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [athleteId])).rows[0]) throw notFound('Athlete');
      let url = prof.external_booking_url;
      if (i.external_url) { ad.check(i.external_url); url = i.external_url; }
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`appt:${providerId}`]);
      const cur = (await c.query('SELECT * FROM appointments WHERE provider_id=$1 AND external_provider=$2 AND external_reference=$3 FOR UPDATE', [providerId, ad.id, i.external_reference])).rows[0];
      if (cur) {
        if (cur.athlete_id !== athleteId) throw conflict('That booking reference is already linked to someone else');
        const moved = +new Date(cur.starts_at) !== +new Date(i.starts_at) || cur.duration_min !== i.duration_min;
        if (moved && ['requested', 'confirmed'].includes(cur.status)) {
          const clash = (await c.query("SELECT 1 FROM appointments WHERE provider_id=$1 AND id<>$2 AND status IN ('requested','confirmed') AND starts_at < $3::timestamptz + make_interval(mins => $4) AND starts_at + make_interval(mins => duration_min) > $3", [providerId, cur.id, i.starts_at, i.duration_min])).rows[0];
          if (clash) throw conflict('Provider is not free then');
          await c.query("UPDATE appointments SET starts_at=$2, duration_min=$3, external_url=$4, external_sync_status='linked', external_synced_at=now(), updated_at=now() WHERE id=$1", [cur.id, i.starts_at, i.duration_min, url]);
        }
        return { ...(await c.query('SELECT id, athlete_id, provider_id, starts_at, duration_min, status, source, external_provider, external_reference, external_sync_status FROM appointments WHERE id=$1', [cur.id])).rows[0], existing: true };
      }
      const clash = (await c.query("SELECT 1 FROM appointments WHERE provider_id=$1 AND status IN ('requested','confirmed') AND starts_at < $2::timestamptz + make_interval(mins => $3) AND starts_at + make_interval(mins => duration_min) > $2", [providerId, i.starts_at, i.duration_min])).rows[0];
      if (clash) throw conflict('Provider is not free then');
      const row = (await c.query(
        `INSERT INTO appointments(athlete_id, provider_id, starts_at, duration_min, mode, status, source, external_provider, external_reference, external_url, external_sync_status, external_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,'external',$7,$8,$9,'linked',now()) RETURNING id, athlete_id, provider_id, starts_at, duration_min, status, source, external_provider, external_reference, external_sync_status`,
        [athleteId, providerId, i.starts_at, i.duration_min, i.mode, i.status, ad.id, i.external_reference, url])).rows[0];
      await notify(c, asProvider ? athleteId : providerId, { kind: 'appointment_requested', title: asProvider ? 'An appointment was added for you' : 'New appointment request', body: 'Open Health to see it.', data: { appointment_id: row.id } });
      return { ...row, existing: false };
    });
  },
});

cap({
  name: 'reconcile_external_booking', method: 'POST', path: '/appointments/external/reconcile', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Provider (or their integration, using an API token): report what happened to a booking on your own system. Its status and time are brought into the matching SportArena appointment, with the same transition rules as everywhere else (no duplicates, no going back from completed or cancelled). Repeating the same update is harmless.',
  input: z.object({ external_reference: z.string().min(2).max(120), status: z.enum(['requested', 'confirmed', 'completed', 'cancelled']).optional(), starts_at: z.string().datetime({ offset: true }).optional(), duration_min: z.number().int().min(10).max(240).optional() }),
  async handler({ user }, i) {
    try { return await reconcile(user, i); } catch (e) {
      // the failed update is rolled back; keep a visible trace that the two systems disagree
      if (e.markSyncError) await one("UPDATE appointments SET external_sync_status='error', external_synced_at=now() WHERE id=$1", [e.markSyncError]);
      throw e;
    }
  },
});

const reconcile = (user, i) =>
  tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`appt:${user.id}`]);
      const a = (await c.query("SELECT * FROM appointments WHERE provider_id=$1 AND source='external' AND external_reference=$2 FOR UPDATE", [user.id, i.external_reference])).rows[0];
      if (!a) throw notFound('External booking');
      let status = a.status;
      if (i.status && i.status !== a.status) {
        if (!NEXT[a.status].includes(i.status)) throw Object.assign(conflict(`A ${a.status} appointment cannot become ${i.status}`), { markSyncError: a.id });
        status = i.status;
      }
      const starts = i.starts_at ?? a.starts_at, dur = i.duration_min ?? a.duration_min;
      if ((+new Date(starts) !== +new Date(a.starts_at) || dur !== a.duration_min) && ['requested', 'confirmed'].includes(status)) {
        const clash = (await c.query("SELECT 1 FROM appointments WHERE provider_id=$1 AND id<>$2 AND status IN ('requested','confirmed') AND starts_at < $3::timestamptz + make_interval(mins => $4) AND starts_at + make_interval(mins => duration_min) > $3", [user.id, a.id, starts, dur])).rows[0];
        if (clash) throw conflict('That time clashes with another appointment');
      }
      const row = (await c.query("UPDATE appointments SET status=$2, starts_at=$3, duration_min=$4, external_sync_status='synced', external_synced_at=now(), updated_at=now(), cancelled_by=CASE WHEN $2='cancelled' AND status<>'cancelled' THEN $5::uuid ELSE cancelled_by END WHERE id=$1 RETURNING id, athlete_id, provider_id, starts_at, duration_min, status, external_sync_status, external_synced_at", [a.id, status, starts, dur, user.id])).rows[0];
      if (status === 'completed' && a.status !== 'completed') await c.query("UPDATE appointment_followups SET status='done', completed_at=now(), closed_by=$2, updated_at=now() WHERE booked_appointment_id=$1 AND status='booked'", [a.id, user.id]);
      if (status === 'cancelled' && a.status !== 'cancelled') await c.query("UPDATE appointment_followups SET status='due', booked_appointment_id=NULL, updated_at=now() WHERE booked_appointment_id=$1 AND status='booked'", [a.id]);
      if (status !== a.status || row.starts_at.getTime?.() !== new Date(a.starts_at).getTime()) await notify(c, a.athlete_id, { kind: 'appointment_update', title: `Appointment ${status}`, body: 'Open Health to see the details.', data: { appointment_id: a.id } });
      return row;
  });
