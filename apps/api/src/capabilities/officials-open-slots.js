// REF-R14: Open match self-assignment (#1006).
// Organisers publish per-fixture-role open slots on a self-service board.
// Eligible officials browse, claim (instant-confirm) or apply (organiser-approval mode), and join a waitlist.
// Claiming is atomic and subject to licence eligibility, conflict rules and competition permission.
// Privacy: private_notes_enc, apply_note_enc and decision_note_enc are encrypted; pay info is hidden from
// non-parties; browsing shows only grade eligibility, not the full eligibility breakdown.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { OFFICIAL_ROLES, lockOfficial, assertOfficialEligible, recordHistory, credentialFor, officialAgeOn } from '../officials.js';
import { eventForOrganizer } from './events.js';
import { isOrganiser } from './event-departments.js';
import { assess } from '../official-availability.js';
import { loadAvailability } from '../official-availability.js';

const TAG = 'Officials';
const OFFICIAL_ROLES_ENUM = z.enum(OFFICIAL_ROLES);

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Load a slot, ensuring the caller is the event organiser or admin. */
async function requireOrganiserOnSlot(c, slotId, user) {
  const slot = (await c.query('SELECT s.*, e.organizer_id FROM open_match_slots s JOIN events e ON e.id=s.event_id WHERE s.id=$1', [slotId])).rows[0];
  if (!slot) throw notFound('Open slot');
  const ok = isAdmin(user) || slot.organizer_id === user.id || await isOrganiser(user, { id: slot.event_id, organizer_id: slot.organizer_id }, c);
  if (!ok) throw forbidden('Only the event organiser can manage open slots');
  return slot;
}

/** Load a slot for the organiser's fixture view. */
async function requireOrganiserOnFixture(c, fixtureId, user) {
  const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [fixtureId])).rows[0];
  if (!f) throw notFound('Fixture');
  const ev = await eventForOrganizer(user, f.event_id, c);
  return { f, ev };
}

/** Record an application status transition. */
async function transitionApp(c, appId, actor, fromStatus, toStatus, reason) {
  await c.query('INSERT INTO open_slot_application_history(application_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [appId, actor, fromStatus, toStatus, reason ?? null]);
  await c.query('UPDATE open_slot_applications SET status=$2, decided_at=now(), decided_by=$3 WHERE id=$1', [appId, toStatus, actor]);
}

/** Next waitlist position on a slot. */
async function nextWaitlistPos(c, slotId) {
  const r = (await c.query("SELECT coalesce(max(waitlist_position),0)+1 AS pos FROM open_slot_applications WHERE slot_id=$1 AND status='waitlisted'", [slotId])).rows[0];
  return r.pos;
}

/**
 * Promote the first waitlisted applicant when a slot opens.
 * In instant mode: auto-approve (creates fixture_official, notifies).
 * In approval mode: move to pending, notify official.
 */
async function promoteWaitlist(c, slot, actor) {
  const next = (await c.query("SELECT a.* FROM open_slot_applications a WHERE a.slot_id=$1 AND a.status='waitlisted' ORDER BY a.waitlist_position LIMIT 1 FOR UPDATE SKIP LOCKED", [slot.id])).rows[0];
  if (!next) return;
  const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [slot.fixture_id])).rows[0];
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [slot.event_id])).rows[0];
  if (slot.approval_mode === 'instant') {
    await approveClaim(c, next, slot, f, ev, actor, 'waitlist_promoted');
  } else {
    await c.query("UPDATE open_slot_applications SET status='pending', decided_at=null, decided_by=null, waitlist_position=null WHERE id=$1", [next.id]);
    await c.query('INSERT INTO open_slot_application_history(application_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [next.id, actor, 'waitlisted', 'pending', 'Slot reopened — moved to pending approval']);
    await notify(c, next.user_id, { kind: 'open_slot', title: 'Slot available — awaiting approval', body: `A slot for ${ROLE_LABEL[slot.role] ?? slot.role} at ${ev.name} has opened. The organiser will decide shortly.`, data: { slot_id: slot.id, application_id: next.id } });
  }
}

/** Create the fixture_official and mark the application approved. */
async function approveClaim(c, app, slot, f, ev, actor, reason) {
  const synthetic = { id: actor };
  // Reuse existing inviteOfficial path: creates fixture_officials row and notifies official
  const { inviteOfficial } = await import('./events.js');
  const fo = await inviteOfficial(c, synthetic, ev, f, app.user_id, slot.role);
  // Auto-accept (official has already agreed by claiming)
  await c.query("UPDATE fixture_officials SET status='accepted', responded_at=now(), reporting_min=$2 WHERE id=$1", [fo.id, slot.reporting_min]);
  await recordHistory(c, fo.id, app.user_id, 'invited', 'accepted', 'Self-claim confirmed');
  if (slot.role === 'referee') await c.query('UPDATE fixtures SET referee_id=$2 WHERE id=$1 AND referee_id IS NULL', [f.id, app.user_id]);
  // Update application
  await c.query("UPDATE open_slot_applications SET status='approved', fixture_official_id=$2, decided_at=now(), decided_by=$3 WHERE id=$1", [app.id, fo.id, actor]);
  await c.query('INSERT INTO open_slot_application_history(application_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [app.id, actor, app.status, 'approved', reason ?? 'approved']);
  await c.query('UPDATE open_match_slots SET filled=filled+1, status=CASE WHEN filled+1>=slots THEN \'full\' ELSE status END WHERE id=$1', [slot.id]);
  await notify(c, app.user_id, {
    kind: 'open_slot', title: 'Slot confirmed',
    body: `You are confirmed as ${ROLE_LABEL[slot.role] ?? slot.role} for ${ev.name} on ${new Date(f.scheduled_at).toLocaleString()}.`,
    data: { slot_id: slot.id, application_id: app.id, fixture_id: f.id, fixture_official_id: fo.id },
  });
  await audit(c, app.user_id, 'open_slot.approved', 'open_slot_applications', app.id);
}

/** Evaluate caller's eligibility for a slot without throwing; returns { eligible, factors }. */
async function softEligibility(c, slot, user) {
  const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [slot.fixture_id])).rows[0];
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [slot.event_id])).rows[0];
  const cred = await credentialFor(c, user.id, ev.sport_id);
  const factors = [];

  // Grade check
  const gradeOk = !slot.min_grade_rank || (cred.licence?.grade_rank ?? 0) >= slot.min_grade_rank;
  factors.push({ key: 'grade', label: 'Grade requirement', state: gradeOk ? 'eligible' : 'ineligible', detail: slot.min_grade ? `Required: ${slot.min_grade}` : null });

  // Licence check
  const licOk = !!cred.licence || !!cred.verified;
  factors.push({ key: 'licence', label: 'Active licence / verification', state: licOk ? 'eligible' : 'ineligible', detail: cred.licence ? `${cred.licence.body_name} ${cred.licence.licence_type} (exp ${cred.licence.expires_on})` : cred.verified ? 'Platform-verified' : null });

  // Availability check (soft)
  let availOk = true;
  let availDetail = null;
  if (f?.scheduled_at && f?.duration_min) {
    const { prefs, rows } = await loadAvailability(c, user.id);
    const a = await assess(prefs, rows, { start: new Date(f.scheduled_at), durationMin: f.duration_min + slot.reporting_min, mode: 'invite' });
    availOk = a.ok !== false;
    availDetail = availOk ? null : a.reason ?? 'You appear unavailable at this time';
  }
  factors.push({ key: 'availability', label: 'Available at match time', state: availOk ? 'eligible' : 'ineligible', detail: availDetail });

  // COI check
  const coiBlocking = (await c.query("SELECT count(*)::int AS n FROM official_conflicts oc JOIN fixture_officials fo ON fo.id=oc.fixture_official_id WHERE fo.fixture_id=$1 AND fo.user_id=$2 AND oc.status='open'", [slot.fixture_id, user.id])).rows[0].n;
  factors.push({ key: 'coi', label: 'No open conflict of interest', state: coiBlocking === 0 ? 'eligible' : 'blocked', detail: coiBlocking > 0 ? 'You have an open conflict declaration on this fixture' : null });

  const eligible = factors.every((f) => f.state !== 'ineligible' && f.state !== 'blocked');
  return { eligible, factors };
}

const ROLE_LABEL = {
  referee: 'Referee', umpire: 'Umpire', linesman: 'Assistant Referee', scorer: 'Scorer / Timekeeper',
  video_assistant_referee: 'VAR', fourth_official: 'Fourth Official', reserve_assistant_referee: 'Reserve AR',
  shot_clock_operator: 'Shot Clock', timekeeper: 'Timekeeper', goal_line_official: 'Goal-line Official',
  technical_official: 'Technical Official', chair_umpire: 'Chair Umpire', match_commissioner: 'Match Commissioner',
  technical_delegate: 'Technical Delegate', starter: 'Starter', marshal: 'Marshal',
};

const slotOut = (s, myApp = null, myElig = null) => ({
  id: s.id, fixture_id: s.fixture_id, event_id: s.event_id, role: s.role, role_label: ROLE_LABEL[s.role] ?? s.role,
  min_grade: s.min_grade, min_grade_rank: s.min_grade_rank, required_credentials: s.required_credentials,
  min_experience_months: s.min_experience_months, reporting_min: s.reporting_min,
  fee_minor: s.fee_minor, fee_currency: s.fee_currency, pay_direction: s.pay_direction,
  approval_mode: s.approval_mode, allow_waitlist: s.allow_waitlist,
  slots: s.slots, filled: s.filled, open_places: Math.max(s.slots - s.filled, 0),
  notes: s.notes, application_deadline: s.application_deadline,
  status: s.status, published_at: s.published_at,
  // enrichment
  event_name: s.event_name ?? null, sport: s.sport ?? null, sport_emoji: s.sport_emoji ?? null,
  sport_slug: s.sport_slug ?? null, fixture_scheduled_at: s.fixture_scheduled_at ?? null,
  fixture_duration_min: s.fixture_duration_min ?? null, fixture_status: s.fixture_status ?? null,
  venue_name: s.venue_name ?? null, venue_city: s.venue_city ?? null, venue_lat: s.venue_lat ?? null, venue_lng: s.venue_lng ?? null,
  home_name: s.home_name ?? null, away_name: s.away_name ?? null,
  organiser_name: s.organiser_name ?? null, organiser_handle: s.organiser_handle ?? null,
  pending_applications: s.pending_applications ?? null,
  // caller-scoped
  my_application: myApp ?? null,
  my_eligibility: myElig ?? null,
});

const BROWSE_COLS = `
  s.*, e.name AS event_name, sp.name AS sport, sp.emoji AS sport_emoji, sp.slug AS sport_slug,
  f.scheduled_at AS fixture_scheduled_at, f.duration_min AS fixture_duration_min, f.status AS fixture_status,
  t1.name AS home_name, t2.name AS away_name,
  u.display_name AS organiser_name, u.handle AS organiser_handle,
  r.name AS resource_name, ve.name AS venue_name, ve.city AS venue_city, ve.lat AS venue_lat, ve.lng AS venue_lng,
  (SELECT count(*)::int FROM open_slot_applications a WHERE a.slot_id=s.id AND a.status IN ('pending','waitlisted')) AS pending_applications`;
const BROWSE_FROM = `
  FROM open_match_slots s
  JOIN events e ON e.id=s.event_id
  JOIN fixtures f ON f.id=s.fixture_id
  JOIN sports sp ON sp.id=e.sport_id
  JOIN users u ON u.id=e.organizer_id
  LEFT JOIN teams t1 ON t1.id=f.home_team_id
  LEFT JOIN teams t2 ON t2.id=f.away_team_id
  LEFT JOIN resources r ON r.id=f.resource_id
  LEFT JOIN venues ve ON ve.id=r.venue_id`;

// ─────────────────────────────────────────── ORGANISER ENDPOINTS ─────────────

cap({
  name: 'publish_open_match_slot', method: 'POST', path: '/fixtures/:id/open-slots', tag: TAG, status: 201,
  summary: 'Organiser publishes an open slot for a specific role on a fixture. Officials can browse and claim (or apply). Set approval_mode="instant" for self-confirm, "approval" for organiser review. Private notes are encrypted and shown only to approved officials.',
  input: z.object({
    id,
    role: OFFICIAL_ROLES_ENUM,
    min_grade: z.string().max(60).optional(),
    min_grade_rank: z.number().int().min(0).optional(),
    required_credentials: z.array(z.object({ kind: z.string().max(60), label: z.string().max(80), required: z.boolean() })).max(10).default([]),
    min_experience_months: z.number().int().min(0).max(600).default(0),
    reporting_min: z.number().int().min(0).max(300).default(30),
    fee_minor: z.number().int().min(0).optional(),
    fee_currency: z.string().length(3).optional(),
    pay_direction: z.enum(['organiser_pays', 'official_invoices']).default('organiser_pays'),
    approval_mode: z.enum(['instant', 'approval']).default('instant'),
    allow_waitlist: z.boolean().default(true),
    slots: z.number().int().min(1).max(20).default(1),
    notes: z.string().max(1000).optional(),
    private_notes: z.string().max(500).optional(),
    application_deadline: z.string().datetime({ offset: true }).optional(),
    publish: z.boolean().default(true),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { f, ev } = await requireOrganiserOnFixture(c, i.id, user);
      if (['completed', 'cancelled'].includes(f.status)) throw conflict(`Fixture is ${f.status}`);
      const existing = (await c.query('SELECT id FROM open_match_slots WHERE fixture_id=$1 AND role=$2', [f.id, i.role])).rows[0];
      if (existing) throw conflict(`An open slot for ${i.role} already exists on this fixture. Update or close it first.`);
      const status = i.publish ? 'open' : 'draft';
      const row = (await c.query(
        `INSERT INTO open_match_slots(fixture_id, event_id, role, min_grade, min_grade_rank, required_credentials, min_experience_months,
           reporting_min, fee_minor, fee_currency, pay_direction, approval_mode, allow_waitlist, slots, notes, private_notes_enc,
           application_deadline, status, published_at, published_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
           CASE WHEN $18='open' THEN now() ELSE NULL END, CASE WHEN $18='open' THEN $19::uuid ELSE NULL END) RETURNING *`,
        [f.id, ev.id, i.role, i.min_grade ?? null, i.min_grade_rank ?? null, JSON.stringify(i.required_credentials),
         i.min_experience_months, i.reporting_min, i.fee_minor ?? null, i.fee_currency ?? null,
         i.pay_direction, i.approval_mode, i.allow_waitlist, i.slots,
         i.notes ?? null, i.private_notes ? encrypt(i.private_notes, 'open_slot.private_notes') : null,
         i.application_deadline ?? null, status, user.id],
      )).rows[0];
      await audit(c, user.id, 'open_slot.published', 'open_match_slots', row.id);
      return slotOut(row);
    });
  },
});

cap({
  name: 'update_open_match_slot', method: 'PATCH', path: '/open-match-slots/:id', tag: TAG,
  summary: 'Organiser edits an open slot (grade requirements, fee, notes, approval mode, deadline, slots count). Cannot reduce slots below filled count. Cannot change role.',
  input: z.object({
    id,
    min_grade: z.string().max(60).optional(),
    min_grade_rank: z.number().int().min(0).optional(),
    reporting_min: z.number().int().min(0).max(300).optional(),
    fee_minor: z.number().int().min(0).optional(),
    fee_currency: z.string().length(3).optional(),
    pay_direction: z.enum(['organiser_pays', 'official_invoices']).optional(),
    approval_mode: z.enum(['instant', 'approval']).optional(),
    allow_waitlist: z.boolean().optional(),
    slots: z.number().int().min(1).max(20).optional(),
    notes: z.string().max(1000).optional(),
    private_notes: z.string().max(500).optional(),
    application_deadline: z.string().datetime({ offset: true }).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const slot = await requireOrganiserOnSlot(c, i.id, user);
      if (slot.status === 'cancelled') throw conflict('Slot is cancelled');
      if (i.slots !== undefined && i.slots < slot.filled) throw badRequest(`Cannot reduce slots to ${i.slots} — ${slot.filled} already filled`);
      const sets = [];
      const vals = [];
      let p = 1;
      const set = (col, val) => { sets.push(`${col}=$${p++}`); vals.push(val); };
      if (i.min_grade !== undefined) set('min_grade', i.min_grade);
      if (i.min_grade_rank !== undefined) set('min_grade_rank', i.min_grade_rank);
      if (i.reporting_min !== undefined) set('reporting_min', i.reporting_min);
      if (i.fee_minor !== undefined) set('fee_minor', i.fee_minor);
      if (i.fee_currency !== undefined) set('fee_currency', i.fee_currency);
      if (i.pay_direction !== undefined) set('pay_direction', i.pay_direction);
      if (i.approval_mode !== undefined) set('approval_mode', i.approval_mode);
      if (i.allow_waitlist !== undefined) set('allow_waitlist', i.allow_waitlist);
      if (i.slots !== undefined) set('slots', i.slots);
      if (i.notes !== undefined) set('notes', i.notes);
      if (i.private_notes !== undefined) set('private_notes_enc', i.private_notes ? encrypt(i.private_notes, 'open_slot.private_notes') : null);
      if (i.application_deadline !== undefined) set('application_deadline', i.application_deadline);
      if (!sets.length) return slotOut(slot);
      // Re-compute status after slots change
      sets.push(`status=CASE WHEN status='full' AND COALESCE($${p},slots)>filled THEN 'open' WHEN status<>'cancelled' AND status<>'closed' AND COALESCE($${p},slots)<=filled THEN 'full' ELSE status END`);
      vals.push(i.slots ?? null);
      p++;
      vals.push(slot.id);
      const updated = (await c.query(`UPDATE open_match_slots SET ${sets.join(',')} WHERE id=$${p} RETURNING *`, vals)).rows[0];
      await audit(c, user.id, 'open_slot.updated', 'open_match_slots', slot.id);
      return slotOut(updated);
    });
  },
});

cap({
  name: 'close_open_match_slot', method: 'POST', path: '/open-match-slots/:id/close', tag: TAG,
  summary: 'Organiser closes a slot (no more applications accepted). Existing approved applications are unaffected. Pending/waitlisted applicants are notified.',
  input: z.object({ id, reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const slot = await requireOrganiserOnSlot(c, i.id, user);
      if (['closed', 'cancelled'].includes(slot.status)) throw conflict(`Slot is already ${slot.status}`);
      await c.query("UPDATE open_match_slots SET status='closed', closed_at=now(), closed_by=$2 WHERE id=$1", [slot.id, user.id]);
      // Notify pending/waitlisted
      const apps = (await c.query("SELECT user_id FROM open_slot_applications WHERE slot_id=$1 AND status IN ('pending','waitlisted')", [slot.id])).rows;
      const ev = (await c.query('SELECT name FROM events WHERE id=$1', [slot.event_id])).rows[0];
      for (const a of apps) await notify(c, a.user_id, { kind: 'open_slot', title: 'Slot closed', body: `The ${ROLE_LABEL[slot.role] ?? slot.role} slot at ${ev?.name} has been closed by the organiser.`, data: { slot_id: slot.id } });
      await audit(c, user.id, 'open_slot.closed', 'open_match_slots', slot.id);
      return { closed: true, slot_id: slot.id };
    });
  },
});

cap({
  name: 'list_open_match_slots_for_fixture', method: 'GET', path: '/fixtures/:id/open-slots', tag: TAG,
  summary: 'Organiser view of all open slots for a fixture — includes private notes (decrypted), applicant counts, waitlist size and application list.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const f = (await pool.query('SELECT * FROM fixtures WHERE id=$1', [i.id])).rows[0];
    if (!f) throw notFound('Fixture');
    const ev = await eventForOrganizer(user, f.event_id, pool);
    const slots = await many(
      `SELECT ${BROWSE_COLS},
              (SELECT count(*)::int FROM open_slot_applications a WHERE a.slot_id=s.id AND a.status='approved') AS approved_count,
              (SELECT count(*)::int FROM open_slot_applications a WHERE a.slot_id=s.id AND a.status='waitlisted') AS waitlist_count
       ${BROWSE_FROM} WHERE s.fixture_id=$1 ORDER BY s.role`, [i.id]);
    return Promise.all(slots.map(async (s) => {
      const apps = await many(
        `SELECT a.id, a.user_id, a.status, a.waitlist_position, a.applied_at, a.decided_at,
                u.display_name, u.handle, u.avatar_emoji, u.avatar_color, a.eligibility_snapshot, a.fee_snapshot
           FROM open_slot_applications a JOIN users u ON u.id=a.user_id WHERE a.slot_id=$1
           ORDER BY a.status, a.waitlist_position, a.applied_at`, [s.id]);
      const pn = s.private_notes_enc ? decrypt(s.private_notes_enc, 'open_slot.private_notes') : null;
      return { ...slotOut(s), private_notes: pn, applications: apps };
    }));
  },
});

cap({
  name: 'decide_open_slot_application', method: 'POST', path: '/open-slot-applications/:id/decide', tag: TAG,
  summary: 'Organiser approves or rejects an application (approval_mode=approval). Approving creates the fixture_official and notifies the official. Rejecting notifies and may promote the next waitlist entry.',
  input: z.object({ id, decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const app = (await c.query('SELECT a.*, s.fixture_id, s.event_id, s.role, s.approval_mode, s.fee_minor, s.fee_currency, s.pay_direction, s.reporting_min, s.slots, s.filled, s.allow_waitlist FROM open_slot_applications a JOIN open_match_slots s ON s.id=a.slot_id WHERE a.id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!app) throw notFound('Application');
      await requireOrganiserOnSlot(c, app.slot_id, user);
      if (app.status !== 'pending') throw conflict(`Application is ${app.status}`);
      const slot = (await c.query('SELECT * FROM open_match_slots WHERE id=$1 FOR UPDATE', [app.slot_id])).rows[0];
      const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [slot.fixture_id])).rows[0];
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [slot.event_id])).rows[0];
      if (i.decision === 'approve') {
        if (slot.filled >= slot.slots) throw conflict('No open places remain on this slot');
        await approveClaim(c, app, slot, f, ev, user.id, 'organiser_approved');
      } else {
        const noteEnc = i.note ? encrypt(i.note, 'open_slot.decision_note') : null;
        await c.query("UPDATE open_slot_applications SET status='rejected', decided_at=now(), decided_by=$2, decision_note_enc=$3, withdrawn_at=NULL WHERE id=$1", [app.id, user.id, noteEnc]);
        await c.query('INSERT INTO open_slot_application_history(application_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [app.id, user.id, 'pending', 'rejected', i.note ?? null]);
        await notify(c, app.user_id, { kind: 'open_slot', title: 'Application not approved', body: `Your application for ${ROLE_LABEL[slot.role] ?? slot.role} at ${ev.name} was not approved.`, data: { slot_id: slot.id, application_id: app.id } });
        await audit(c, user.id, 'open_slot.rejected', 'open_slot_applications', app.id);
        // If slot not full, promote from waitlist if applicable
        if (slot.allow_waitlist && slot.filled < slot.slots) await promoteWaitlist(c, slot, user.id);
      }
      return (await c.query('SELECT * FROM open_slot_applications WHERE id=$1', [i.id])).rows[0];
    });
  },
});

// ─────────────────────────────────────────── OFFICIAL ENDPOINTS ──────────────

cap({
  name: 'browse_open_match_slots', method: 'GET', path: '/open-match-slots', tag: TAG,
  summary: 'Official\'s self-assign board: browse all published open slots, filtered by sport, date, grade, role, fee, location and claim mode. Each row includes a live eligibility summary and the caller\'s application status. Private notes and pay info are hidden unless the caller is approved. Sorted by: eligible-instant-claim first, then date.',
  input: z.object({
    sport_id: id.optional(), sport: z.string().max(60).optional(),
    role: OFFICIAL_ROLES_ENUM.optional(),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    min_fee: z.number().int().min(0).optional(),
    max_fee: z.number().int().min(0).optional(),
    approval_mode: z.enum(['instant', 'approval']).optional(),
    eligible_only: z.boolean().default(false),
    venue_city: z.string().max(80).optional(),
    q: z.string().max(100).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${BROWSE_COLS}
       ${BROWSE_FROM}
        WHERE s.status='open'
          AND f.status IN ('scheduled','postponed')
          AND (s.application_deadline IS NULL OR s.application_deadline > now())
          AND ($2::uuid IS NULL OR e.sport_id=$2)
          AND ($3::text IS NULL OR sp.slug=$3 OR sp.name ILIKE '%'||$3||'%')
          AND ($4::text IS NULL OR s.role=$4)
          AND ($5::date IS NULL OR f.scheduled_at::date >= $5::date)
          AND ($6::date IS NULL OR f.scheduled_at::date <= $6::date)
          AND ($7::bigint IS NULL OR s.fee_minor >= $7)
          AND ($8::bigint IS NULL OR s.fee_minor <= $8)
          AND ($9::text IS NULL OR s.approval_mode=$9)
          AND ($10::text IS NULL OR ve.city ILIKE '%'||$10||'%')
          AND ($11::text IS NULL OR e.name ILIKE '%'||$11||'%' OR sp.name ILIKE '%'||$11||'%' OR s.role ILIKE '%'||$11||'%')
          AND e.organizer_id <> $1
        ORDER BY
          CASE WHEN s.approval_mode='instant' THEN 0 ELSE 1 END,
          f.scheduled_at,
          s.created_at
        LIMIT $12 OFFSET $13`,
      [user.id, i.sport_id ?? null, i.sport ?? null, i.role ?? null,
       i.date_from ?? null, i.date_to ?? null, i.min_fee ?? null, i.max_fee ?? null,
       i.approval_mode ?? null, i.venue_city ?? null, i.q ?? null, i.limit, i.offset]);

    const myApps = await many("SELECT slot_id, id, status, fee_snapshot, waitlist_position FROM open_slot_applications WHERE user_id=$1 AND status NOT IN ('withdrawn','cancelled')", [user.id]);
    const appBySlot = Object.fromEntries(myApps.map((a) => [a.slot_id, a]));

    return Promise.all(rows.map(async (s) => {
      const myApp = appBySlot[s.id] ?? null;
      const elig = await softEligibility(pool, s, user);
      return slotOut(s, myApp ? { id: myApp.id, status: myApp.status, waitlist_position: myApp.waitlist_position, fee_snapshot: myApp.fee_snapshot } : null, { eligible: elig.eligible, factors: elig.factors });
    }));
  },
});

cap({
  name: 'get_open_match_slot', method: 'GET', path: '/open-match-slots/:id', tag: TAG,
  summary: 'Full detail of an open slot for the calling official: eligibility breakdown, conflict advisories, fee terms. Private notes shown only to approved officials.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const rows = await many(`SELECT ${BROWSE_COLS} ${BROWSE_FROM} WHERE s.id=$1`, [i.id]);
    const s = rows[0];
    if (!s || (s.status !== 'open' && s.status !== 'full')) throw notFound('Open slot');
    const myApp = (await pool.query("SELECT id, status, fee_snapshot, waitlist_position, applied_at, eligibility_snapshot FROM open_slot_applications WHERE slot_id=$1 AND user_id=$2", [s.id, user.id])).rows[0] ?? null;
    const elig = await softEligibility(pool, s, user);
    // Conflict advisories (non-blocking): same-day assignments
    const f = (await pool.query('SELECT * FROM fixtures WHERE id=$1', [s.fixture_id])).rows[0];
    const conflictAdvisories = [];
    if (f?.scheduled_at) {
      const day = new Date(f.scheduled_at).toISOString().slice(0, 10);
      const sameDayWork = await many(
        `SELECT fo.role, fi.scheduled_at, fi.duration_min, e.name AS event_name
           FROM fixture_officials fo JOIN fixtures fi ON fi.id=fo.fixture_id JOIN events e ON e.id=fi.event_id
          WHERE fo.user_id=$1 AND fo.status='accepted' AND fi.id<>$2
            AND fi.scheduled_at::date=$3::date`,
        [user.id, s.fixture_id, day]);
      for (const w of sameDayWork) {
        conflictAdvisories.push({ kind: 'same_day', label: 'Same-day assignment', detail: `${ROLE_LABEL[w.role] ?? w.role} at ${w.event_name} on ${new Date(w.scheduled_at).toLocaleString()}` });
      }
    }
    const isApproved = myApp?.status === 'approved';
    const pn = isApproved && s.private_notes_enc ? decrypt(s.private_notes_enc, 'open_slot.private_notes') : null;
    return { ...slotOut(s, myApp ? { id: myApp.id, status: myApp.status, waitlist_position: myApp.waitlist_position, fee_snapshot: myApp.fee_snapshot, applied_at: myApp.applied_at } : null, { eligible: elig.eligible, factors: elig.factors }), private_notes: pn, conflict_advisories: conflictAdvisories };
  },
});

cap({
  name: 'claim_open_match_slot', method: 'POST', path: '/open-match-slots/:id/claim', tag: TAG, status: 201,
  summary: 'Official claims or applies for an open slot. Atomic: runs assertOfficialEligible under a lock. Instant mode + eligible = confirmed immediately. Approval mode = pending. Full slot + allow_waitlist = waitlisted. Second call by the same official is idempotent (returns existing application).',
  input: z.object({ id, note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await lockOfficial(c, user.id);
      const slot = (await c.query('SELECT s.*, e.organizer_id FROM open_match_slots s JOIN events e ON e.id=s.event_id WHERE s.id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!slot) throw notFound('Open slot');
      if (slot.status === 'cancelled' || slot.status === 'closed') throw conflict('This slot is no longer accepting applications');
      if (slot.application_deadline && new Date() > new Date(slot.application_deadline)) throw conflict('The application deadline has passed');
      if (slot.organizer_id === user.id) throw forbidden('You cannot claim your own slot');

      // Idempotency: return existing live application
      const existing = (await c.query("SELECT * FROM open_slot_applications WHERE slot_id=$1 AND user_id=$2 AND status NOT IN ('withdrawn','cancelled','rejected')", [i.id, user.id])).rows[0];
      if (existing) return existing;

      const f = (await c.query('SELECT * FROM fixtures WHERE id=$1', [slot.fixture_id])).rows[0];
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [slot.event_id])).rows[0];

      // Full eligibility check (throws on failure)
      await assertOfficialEligible(c, { event: ev, fixtureId: f.id, userId: user.id, role: slot.role, start: f.scheduled_at, durationMin: f.duration_min + slot.reporting_min, mode: 'invite' });

      // Soft eligibility snapshot
      const { eligible, factors } = await softEligibility(c, slot, user);
      const feeSnap = { minor: slot.fee_minor, currency: slot.fee_currency, pay_direction: slot.pay_direction };
      const noteEnc = i.note ? encrypt(i.note, 'open_slot.apply_note') : null;

      let targetStatus;
      let waitlistPos = null;
      if (slot.filled >= slot.slots) {
        if (!slot.allow_waitlist) throw conflict('This slot is full and has no waitlist');
        targetStatus = 'waitlisted';
        waitlistPos = await nextWaitlistPos(c, slot.id);
        if (slot.status !== 'full') await c.query("UPDATE open_match_slots SET status='full' WHERE id=$1", [slot.id]);
      } else if (slot.approval_mode === 'instant') {
        targetStatus = 'approved';
      } else {
        targetStatus = 'pending';
      }

      const app = (await c.query(
        `INSERT INTO open_slot_applications(slot_id, user_id, status, fee_snapshot, eligibility_snapshot, apply_note_enc, waitlist_position, applied_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now()) RETURNING *`,
        [slot.id, user.id, targetStatus, JSON.stringify(feeSnap), JSON.stringify({ eligible, factors, checked_at: new Date().toISOString() }), noteEnc, waitlistPos],
      )).rows[0];

      await c.query('INSERT INTO open_slot_application_history(application_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [app.id, user.id, null, targetStatus, null]);

      if (targetStatus === 'approved') {
        await approveClaim(c, app, slot, f, ev, user.id, 'instant_claim');
      } else if (targetStatus === 'waitlisted') {
        await notify(c, slot.organizer_id, { kind: 'open_slot', title: 'New waitlist entry', body: `An official joined the waitlist for ${ROLE_LABEL[slot.role] ?? slot.role} at ${ev.name}.`, data: { slot_id: slot.id, application_id: app.id } });
        await notify(c, user.id, { kind: 'open_slot', title: 'Added to waitlist', body: `You are #${waitlistPos} on the waitlist for ${ROLE_LABEL[slot.role] ?? slot.role} at ${ev.name}. You will be notified if a place opens.`, data: { slot_id: slot.id, application_id: app.id } });
      } else {
        await notify(c, slot.organizer_id, { kind: 'open_slot', title: 'New application', body: `An official applied for ${ROLE_LABEL[slot.role] ?? slot.role} at ${ev.name}.`, data: { slot_id: slot.id, application_id: app.id } });
        await notify(c, user.id, { kind: 'open_slot', title: 'Application submitted', body: `Your application for ${ROLE_LABEL[slot.role] ?? slot.role} at ${ev.name} has been submitted. The organiser will review shortly.`, data: { slot_id: slot.id, application_id: app.id } });
      }

      await audit(c, user.id, `open_slot.${targetStatus}`, 'open_slot_applications', app.id);
      return (await c.query('SELECT * FROM open_slot_applications WHERE id=$1', [app.id])).rows[0];
    });
  },
});

cap({
  name: 'list_my_open_slot_applications', method: 'GET', path: '/me/open-slot-applications', tag: TAG,
  summary: 'All my open-slot applications (live and historical). Includes slot, fixture, event, role, fee snapshot, eligibility snapshot, status and waitlist position.',
  input: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'waitlisted', 'withdrawn', 'cancelled']).optional(),
    upcoming: z.boolean().optional(),
    ...page,
  }),
  async handler({ user }, i) {
    return many(
      `SELECT a.id, a.slot_id, a.status, a.fee_snapshot, a.waitlist_position, a.applied_at, a.decided_at, a.eligibility_snapshot,
              s.role, s.approval_mode, s.reporting_min,
              e.name AS event_name, sp.emoji AS sport_emoji, sp.slug AS sport_slug,
              f.scheduled_at, f.duration_min, f.id AS fixture_id,
              t1.name AS home_name, t2.name AS away_name,
              ve.name AS venue_name, ve.city AS venue_city,
              a.fixture_official_id
         FROM open_slot_applications a
         JOIN open_match_slots s ON s.id=a.slot_id
         JOIN events e ON e.id=s.event_id
         JOIN fixtures f ON f.id=s.fixture_id
         JOIN sports sp ON sp.id=e.sport_id
         LEFT JOIN teams t1 ON t1.id=f.home_team_id
         LEFT JOIN teams t2 ON t2.id=f.away_team_id
         LEFT JOIN resources r ON r.id=f.resource_id
         LEFT JOIN venues ve ON ve.id=r.venue_id
        WHERE a.user_id=$1
          AND ($2::text IS NULL OR a.status=$2)
          AND (NOT coalesce($3::boolean,false) OR f.scheduled_at >= now())
        ORDER BY f.scheduled_at, a.applied_at DESC
        LIMIT $4 OFFSET $5`,
      [user.id, i.status ?? null, i.upcoming ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'withdraw_open_slot_application', method: 'POST', path: '/open-slot-applications/:id/withdraw', tag: TAG,
  summary: 'Official withdraws a pending or waitlisted application. If the slot was approved (confirmed), use cancel_open_slot_application instead.',
  input: z.object({ id, reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const app = (await c.query('SELECT * FROM open_slot_applications WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!app) throw notFound('Application');
      if (app.user_id !== user.id) throw forbidden('Not your application');
      if (!['pending', 'waitlisted'].includes(app.status)) throw conflict(`Cannot withdraw an application with status ${app.status}. Use cancel for confirmed slots.`);
      await c.query("UPDATE open_slot_applications SET status='withdrawn', withdrawn_at=now() WHERE id=$1", [app.id]);
      await c.query('INSERT INTO open_slot_application_history(application_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [app.id, user.id, app.status, 'withdrawn', i.reason ?? null]);
      const slot = (await c.query('SELECT * FROM open_match_slots WHERE id=$1', [app.slot_id])).rows[0];
      const ev = (await c.query('SELECT name FROM events WHERE id=$1', [slot.event_id])).rows[0];
      await notify(c, slot.organizer_id ?? null, { kind: 'open_slot', title: 'Application withdrawn', body: `An official withdrew their application for ${ROLE_LABEL[slot.role] ?? slot.role} at ${ev?.name}.`, data: { slot_id: slot.id, application_id: app.id } });
      await audit(c, user.id, 'open_slot.withdrawn', 'open_slot_applications', app.id);
      return { withdrawn: true, application_id: app.id };
    });
  },
});

cap({
  name: 'cancel_open_slot_application', method: 'POST', path: '/open-slot-applications/:id/cancel', tag: TAG,
  summary: 'Cancel a confirmed (approved) application. The fixture_official is set to withdrawn; the slot is reopened; the next waitlist entry is auto-promoted. Both the official and the organiser can cancel.',
  input: z.object({ id, reason: z.string().min(2).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const app = (await c.query('SELECT * FROM open_slot_applications WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!app) throw notFound('Application');
      const isOrg = async () => {
        const slot = (await c.query('SELECT s.event_id, e.organizer_id FROM open_match_slots s JOIN events e ON e.id=s.event_id WHERE s.id=$1', [app.slot_id])).rows[0];
        return slot && (isAdmin(user) || slot.organizer_id === user.id);
      };
      if (app.user_id !== user.id && !(await isOrg())) throw forbidden('Only the official or the organiser can cancel');
      if (app.status !== 'approved') throw conflict(`Application is ${app.status} — only approved applications can be cancelled`);
      const slot = (await c.query('SELECT * FROM open_match_slots WHERE id=$1 FOR UPDATE', [app.slot_id])).rows[0];
      const ev = (await c.query('SELECT * FROM events WHERE id=$1', [slot.event_id])).rows[0];

      // Withdraw the fixture_official
      if (app.fixture_official_id) {
        await c.query("UPDATE fixture_officials SET status='withdrawn', responded_at=now() WHERE id=$1 AND status='accepted'", [app.fixture_official_id]);
        const fo = (await c.query('SELECT * FROM fixture_officials WHERE id=$1', [app.fixture_official_id])).rows[0];
        if (fo) await recordHistory(c, fo.id, user.id, 'accepted', 'withdrawn', `Cancelled via open slot: ${i.reason}`);
      }

      // Update application
      await c.query("UPDATE open_slot_applications SET status='cancelled', withdrawn_at=now(), decided_at=now(), decided_by=$2 WHERE id=$1", [app.id, user.id]);
      await c.query('INSERT INTO open_slot_application_history(application_id, actor_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [app.id, user.id, 'approved', 'cancelled', i.reason]);

      // Decrement filled, reopen slot if needed
      await c.query("UPDATE open_match_slots SET filled=GREATEST(filled-1,0), status=CASE WHEN status='full' THEN 'open' ELSE status END WHERE id=$1", [slot.id]);

      // Notify both sides
      const otherUserId = app.user_id === user.id ? null : app.user_id;
      if (otherUserId) await notify(c, otherUserId, { kind: 'open_slot', title: 'Slot assignment cancelled', body: `Your confirmed assignment for ${ROLE_LABEL[slot.role] ?? slot.role} at ${ev.name} was cancelled: ${i.reason}`, data: { slot_id: slot.id, application_id: app.id } });
      if (app.user_id === user.id) await notify(c, ev.organizer_id, { kind: 'open_slot', title: 'Official cancelled', body: `The confirmed ${ROLE_LABEL[slot.role] ?? slot.role} at ${ev.name} cancelled: ${i.reason}`, data: { slot_id: slot.id, application_id: app.id } });

      // Promote from waitlist
      const refreshedSlot = (await c.query('SELECT * FROM open_match_slots WHERE id=$1', [slot.id])).rows[0];
      if (refreshedSlot.allow_waitlist) await promoteWaitlist(c, refreshedSlot, user.id);

      await audit(c, user.id, 'open_slot.cancelled', 'open_slot_applications', app.id);
      return { cancelled: true, application_id: app.id };
    });
  },
});
