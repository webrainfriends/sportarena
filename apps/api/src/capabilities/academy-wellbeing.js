// Academy student wellbeing & personal development (#795), part 1 - the staff side: development tracks, mentor assignments, check-in scheduling with
// transparent follow-up, human-reviewed goals, consented specialist referrals and guardian updates. Rules live in src/wellbeing.js.
// The academy keeps no counselling, diagnosis or confidential safeguarding content here: free text is screened and short, and a concern is raised into the
// existing safety-event workflow (encrypted, safeguarding staff only). Students and guardians act in academy-wellbeing-family.js; the director's view is academy-wellbeing-overview.js.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx, many } from '../db.js';
import { invoke } from '../invoke.js';
import { capabilities } from '../registry.js';
import { audit } from '../helpers.js';
import { opsAccess } from '../academy-ops.js';
import { openSafetyEvent, policyFor, safeguardingOfficers } from '../pickup.js';
import { MIN_GROUP, suppress, AppError, badRequest, conflict, forbidden, notFound, CATEGORIES, TOPICS, SETTINGS, SPECIALTIES, REASONS, UPDATE_TEMPLATES, ageBand, consentSql, enrolled, fitsAge, log, mentorEligible, mentorOf, mustBeEnrolled, nameOf, requireScope, screen, seal, tellFamily, unseal, hasScope } from '../wellbeing.js';

const TAG = 'Academy wellbeing';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n, from = today()) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** The caller's standing in this academy's wellbeing work. oversight = owner/admin or safeguarding staff (statuses and actions due, never content); a mentor reads only their own mentees. */
export async function wbAccess(user, orgId, c, write = false) {
  const a = await opsAccess(user, orgId, { write, c });
  if (!a.has('wellbeing')) throw forbidden('You do not have wellbeing access to this academy');
  a.oversight = a.admin || a.has('safeguarding');
  return a;
}
const requireAdmin = (a) => { if (!a.admin) throw forbidden('Only an owner or admin can do this'); };
/** 'mentor' when the caller is the athlete's current mentor, 'oversight' for the director and safeguarding staff, otherwise 404 (no existence leak). */
async function standing(c, a, user, orgId, athleteId) {
  const m = await mentorOf(c, orgId, athleteId);
  if (m?.mentor_id === user.id) return { role: 'mentor', assignment: m };
  if (a.oversight) return { role: 'oversight', assignment: m };
  throw notFound('Athlete');
}

// ------------------------------------------------------------------------------------------------------------------ tracks
const moduleShape = z.object({ title: z.string().trim().min(2).max(120), outcome: z.string().trim().max(240).optional() });
const trackBody = {
  category: z.enum(CATEGORIES), title: z.string().trim().min(2).max(120), summary: z.string().trim().max(600).optional(), age_min: z.number().int().min(4).max(40), age_max: z.number().int().min(4).max(60),
  delivery: z.enum(['group', 'one_to_one', 'blended']).default('group'), sports: z.array(z.string().max(60)).max(30).default([]), modules: z.array(moduleShape).min(1).max(30), status: z.enum(['draft', 'active']).default('active'),
};

cap({
  name: 'save_dev_track', method: 'POST', path: '/organisations/:id/academy/wellbeing/tracks', tag: TAG, status: 201,
  summary: 'Owner/admin: create an optional personal-development track (values, leadership, life skills, nutrition education, study skills) with an age band, sports, delivery and ordered modules with outcomes. Send track_id to edit; modules can be added or reworded but not removed once the track exists (archive it and start a new one), so recorded progress never points at a different module. Joining is always optional and needs the athlete\'s (or guardian\'s) consent.',
  input: z.object({ id, track_id: id.optional(), ...trackBody }).refine((v) => v.age_min <= v.age_max, 'The minimum age cannot be above the maximum'),
  async handler({ user }, i) {
    return tx(async (c) => {
      requireAdmin(await wbAccess(user, i.id, c, true));
      const cols = [i.category, i.title, i.summary ?? null, i.age_min, i.age_max, i.delivery, i.sports, JSON.stringify(i.modules), i.status];
      if (!i.track_id) {
        const r = (await c.query('INSERT INTO academy_dev_tracks(organisation_id, category, title, summary, age_min, age_max, delivery, sports, modules, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [i.id, ...cols, user.id])).rows[0];
        await audit(c, user.id, 'create_dev_track', 'academy_dev_tracks', r.id);
        return r;
      }
      const cur = (await c.query('SELECT * FROM academy_dev_tracks WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.track_id, i.id])).rows[0];
      if (!cur) throw notFound('Track');
      if (cur.status === 'archived') throw conflict('This track is archived');
      if (i.modules.length < cur.modules.length) throw conflict('Modules cannot be removed from a track that exists. Archive it and create a new one.', { code: 'modules_append_only' });
      const r = (await c.query('UPDATE academy_dev_tracks SET category=$2, title=$3, summary=$4, age_min=$5, age_max=$6, delivery=$7, sports=$8, modules=$9, status=$10, version=version+1, updated_at=now() WHERE id=$1 RETURNING *', [i.track_id, ...cols])).rows[0];
      await audit(c, user.id, 'update_dev_track', 'academy_dev_tracks', r.id);
      return r;
    });
  },
});

cap({
  name: 'archive_dev_track', method: 'POST', path: '/academy/wellbeing/tracks/:id/archive', tag: TAG,
  summary: 'Owner/admin: archive a track. It is kept with everyone\'s progress, hidden from new enrolments, and members are marked completed or withdrawn only by their facilitator.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM academy_dev_tracks WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!t) throw notFound('Track');
      try { requireAdmin(await wbAccess(user, t.organisation_id, c, true)); } catch (e) { if (e instanceof AppError && e.status === 403) throw notFound('Track'); throw e; }
      await c.query("UPDATE academy_dev_tracks SET status='archived', archived_at=now(), updated_at=now() WHERE id=$1", [t.id]);
      await audit(c, user.id, 'archive_dev_track', 'academy_dev_tracks', t.id);
      return { id: t.id, status: 'archived' };
    });
  },
});

cap({
  name: 'list_dev_tracks', method: 'GET', path: '/organisations/:id/academy/wellbeing/tracks', tag: TAG,
  summary: 'The academy\'s development tracks with modules, age band, sports and how many consenting athletes take part (a group under five is shown as null so a figure never points at one child). Needs wellbeing access.',
  input: z.object({ id, status: z.enum(['draft', 'active', 'archived']).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await wbAccess(user, i.id, c);
      return (await c.query(
        `SELECT t.*, n.n AS participants FROM academy_dev_tracks t
           CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM academy_dev_track_members m WHERE m.track_id=t.id AND m.status='enrolled' AND ${consentSql('t.organisation_id', 'm.athlete_id', 'tracks')}) n
          WHERE t.organisation_id=$1 AND ($2::text IS NULL OR t.status=$2) AND ($2::text IS NOT NULL OR t.status <> 'archived') ORDER BY t.category, t.title`, [i.id, i.status ?? null]))
        .rows.map((t) => ({ ...t, participants_hidden: t.participants > 0 && t.participants < MIN_GROUP, participants: suppress(t.participants) }));
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ track membership
cap({
  name: 'get_dev_track', method: 'GET', path: '/academy/wellbeing/tracks/:id', tag: TAG,
  summary: 'One track with the athletes taking part and the modules each has completed. Only athletes whose guardian or own consent currently covers tracks appear. Needs wellbeing access.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM academy_dev_tracks WHERE id=$1', [i.id])).rows[0];
      if (!t) throw notFound('Track');
      try { await wbAccess(user, t.organisation_id, c); } catch (e) { if (e instanceof AppError && e.status === 403) throw notFound('Track'); throw e; }
      const members = (await c.query(
        `SELECT m.athlete_id, u.display_name, u.avatar_emoji, u.avatar_color, m.status, m.modules_done, m.joined_at, m.last_activity_at FROM academy_dev_track_members m JOIN users u ON u.id=m.athlete_id
          WHERE m.track_id=$1 AND ${consentSql('$2::uuid', 'm.athlete_id', 'tracks')} ORDER BY u.display_name, m.athlete_id`, [t.id, t.organisation_id])).rows;
      return { ...t, members };
    });
  },
});

cap({
  name: 'enrol_in_dev_track', method: 'POST', path: '/academy/wellbeing/tracks/:id/members', tag: TAG,
  summary: 'Enrol up to 50 of the academy\'s athletes in a track. Each is checked on its own: not an academy athlete, no current consent for tracks, outside the track\'s age band (checked from birth year only; no date of birth is read) or already in the track. The result says which, so nothing is skipped silently. The family is told once, in generic words.',
  input: z.object({ id, athlete_ids: z.array(id).min(1).max(50) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM academy_dev_tracks WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!t) throw notFound('Track');
      try { await wbAccess(user, t.organisation_id, c, true); } catch (e) { if (e instanceof AppError && e.status === 403) throw notFound('Track'); throw e; }
      if (t.status !== 'active') throw conflict('Only an active track takes new members', { code: 'track_not_active' });
      const results = [];
      for (const athleteId of i.athlete_ids) {
        if (!(await enrolled(c, t.organisation_id, athleteId))) { results.push({ athlete_id: athleteId, result: 'skipped', reason: 'not_an_academy_athlete' }); continue; }
        if (!(await hasScope(c, t.organisation_id, athleteId, 'tracks'))) { results.push({ athlete_id: athleteId, result: 'skipped', reason: 'consent_missing' }); continue; }
        if (!fitsAge(await ageBand(c, athleteId), t)) { results.push({ athlete_id: athleteId, result: 'skipped', reason: 'outside_age_band' }); continue; }
        const r = await c.query("INSERT INTO academy_dev_track_members(track_id, athlete_id, enrolled_by) VALUES ($1,$2,$3) ON CONFLICT (track_id, athlete_id) DO UPDATE SET status='enrolled', ended_at=NULL WHERE academy_dev_track_members.status='withdrawn' RETURNING id", [t.id, athleteId, user.id]);
        if (!r.rowCount) { results.push({ athlete_id: athleteId, result: 'skipped', reason: 'already_in_track' }); continue; }
        await log(c, t.organisation_id, athleteId, 'track_enrolled', user.id, { type: 'track', id: t.id });
        await tellFamily(c, athleteId, { kind: 'academy_wellbeing', title: 'A personal-development track', body: 'Open Wellbeing in GotMyGame to see what it covers. You can leave at any time.', key: `wb:track:${t.id}:${athleteId}`, data: { organisation_id: t.organisation_id } });
        results.push({ athlete_id: athleteId, result: 'enrolled' });
      }
      return { results };
    });
  },
});

cap({
  name: 'record_dev_track_progress', method: 'POST', path: '/academy/wellbeing/tracks/:id/members/:athlete_id', tag: TAG,
  summary: 'Facilitator: tick a module as done (or undo it), mark the athlete as having completed the track, or record that they left. Progress is always entered by a person; nothing completes automatically.',
  input: z.object({ id, athlete_id: id, action: z.enum(['module_done', 'module_undone', 'complete', 'withdraw']), module_index: z.number().int().min(0).max(29).optional() })
    .refine((v) => !v.action.startsWith('module_') || v.module_index !== undefined, 'Say which module'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const t = (await c.query('SELECT * FROM academy_dev_tracks WHERE id=$1', [i.id])).rows[0];
      if (!t) throw notFound('Track');
      try { await wbAccess(user, t.organisation_id, c, true); } catch (e) { if (e instanceof AppError && e.status === 403) throw notFound('Track'); throw e; }
      const m = (await c.query('SELECT * FROM academy_dev_track_members WHERE track_id=$1 AND athlete_id=$2 FOR UPDATE', [t.id, i.athlete_id])).rows[0];
      if (!m) throw notFound('Athlete');
      await requireScope(c, t.organisation_id, i.athlete_id, 'tracks');
      if (m.status !== 'enrolled') throw conflict('This athlete is no longer in the track', { code: 'not_enrolled' });
      let done = m.modules_done, status = m.status;
      if (i.action.startsWith('module_')) {
        if (i.module_index >= t.modules.length) throw badRequest('That module does not exist');
        done = i.action === 'module_done' ? [...new Set([...done, i.module_index])].sort((a, b) => a - b) : done.filter((x) => x !== i.module_index);
      } else status = i.action === 'complete' ? 'completed' : 'withdrawn';
      const r = (await c.query('UPDATE academy_dev_track_members SET modules_done=$2, status=$3, last_activity_at=now(), ended_at=CASE WHEN $3=\'enrolled\' THEN NULL ELSE now() END WHERE id=$1 RETURNING *', [m.id, done, status])).rows[0];
      await log(c, t.organisation_id, i.athlete_id, i.action, user.id, { type: 'track', id: t.id }, i.module_index !== undefined ? String(i.module_index) : null);
      return { athlete_id: r.athlete_id, status: r.status, modules_done: r.modules_done, of: t.modules.length };
    });
  },
});

cap({
  name: 'request_wellbeing_consent', method: 'POST', path: '/organisations/:id/academy/wellbeing/consent-requests', tag: TAG,
  summary: 'Ask up to 50 athletes (their guardians, for a young person) to decide what they are happy to take part in. It sends one generic notification a day per athlete and records that you asked; nothing about the athlete is revealed in it.',
  input: z.object({ id, athlete_ids: z.array(id).min(1).max(50) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await wbAccess(user, i.id, c, true);
      let asked = 0;
      for (const athleteId of i.athlete_ids) {
        if (!(await enrolled(c, i.id, athleteId))) continue;
        await tellFamily(c, athleteId, { kind: 'academy_wellbeing', title: 'Your academy would like your choices', body: 'Open Wellbeing in GotMyGame to choose what you are happy to take part in. You can change or withdraw it at any time.', key: `wb:consent-ask:${i.id}:${athleteId}:${today()}`, data: { organisation_id: i.id } });
        await log(c, i.id, athleteId, 'consent_requested', user.id);
        asked++;
      }
      return { asked };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ mentors
const assignmentCols = 'a.id, a.athlete_id, a.mentor_id, a.status, a.cadence_days, a.review_on, a.started_at, a.ended_at, a.ended_reason';

cap({
  name: 'assign_mentor', method: 'POST', path: '/organisations/:id/academy/wellbeing/mentors', tag: TAG, status: 201,
  summary: 'Director or safeguarding staff: assign a mentor to an athlete. The mentor must be an active member with the wellbeing permission and cleared by the academy\'s youth-access obligations; the athlete (or guardian) must have consented to mentoring. One live mentor per athlete: send replace=true to hand over (the earlier assignment is ended, kept). The family is told who, in generic words.',
  input: z.object({ id, athlete_id: id, mentor_id: id, cadence_days: z.number().int().min(3).max(120).default(14), review_on: day.optional(), replace: z.boolean().default(false) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c, true);
      if (!a.oversight) throw forbidden('Only the director or safeguarding staff assign mentors');
      await mustBeEnrolled(c, i.id, i.athlete_id);
      await requireScope(c, i.id, i.athlete_id, 'mentoring');
      if (!(await mentorEligible(c, i.id, i.mentor_id, i.athlete_id))) throw conflict('That person cannot mentor this athlete: they need the wellbeing permission and any youth-access clearance the academy requires.', { code: 'mentor_not_eligible' });
      const cur = await mentorOf(c, i.id, i.athlete_id);
      if (cur && !i.replace) throw conflict('This athlete already has a mentor. Send replace to hand over.', { code: 'already_mentored' });
      if (cur) { await c.query("UPDATE academy_mentor_assignments SET status='ended', ended_at=now(), ended_reason='mentor_change' WHERE id=$1", [cur.id]); await c.query("UPDATE academy_wellbeing_checkins SET status='cancelled', row_version=row_version+1 WHERE assignment_id=$1 AND status='scheduled'", [cur.id]); }
      const r = (await c.query('INSERT INTO academy_mentor_assignments(organisation_id, athlete_id, mentor_id, cadence_days, review_on, assigned_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id, i.athlete_id, i.mentor_id, i.cadence_days, i.review_on ?? plusDays(90), user.id])).rows[0];
      await log(c, i.id, i.athlete_id, cur ? 'mentor_changed' : 'mentor_assigned', user.id, { type: 'mentor', id: r.id });
      await tellFamily(c, i.athlete_id, { kind: 'academy_wellbeing', title: 'Your mentor', body: `${await nameOf(c, i.mentor_id)} is your academy mentor. Open Wellbeing in GotMyGame to see how it works and what is shared.`, key: `wb:mentor:${r.id}`, data: { organisation_id: i.id } });
      await audit(c, user.id, 'assign_mentor', 'academy_mentor_assignments', r.id);
      return r;
    });
  },
});

cap({
  name: 'update_mentor_assignment', method: 'PATCH', path: '/academy/wellbeing/mentors/:id', tag: TAG,
  summary: 'Pause, resume or end a mentor assignment, or change its check-in rhythm and review date. The mentor or the director/safeguarding staff may do it. Ending needs a reason code, cancels check-ins still scheduled and is kept as history.',
  input: z.object({ id, action: z.enum(['pause', 'resume', 'end', 'adjust']), reason: z.enum(['athlete_request', 'guardian_request', 'mentor_change', 'left_academy', 'consent_withdrawn', 'other']).optional(), cadence_days: z.number().int().min(3).max(120).optional(), review_on: day.optional() })
    .refine((v) => v.action !== 'end' || !!v.reason, 'Say why it is ending'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const m = (await c.query('SELECT * FROM academy_mentor_assignments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!m) throw notFound('Assignment');
      let a;
      try { a = await wbAccess(user, m.organisation_id, c, true); } catch (e) { if (e instanceof AppError && e.status === 403) throw notFound('Assignment'); throw e; }
      if (m.mentor_id !== user.id && !a.oversight) throw notFound('Assignment');
      if (m.status === 'ended') throw conflict('This assignment has ended', { code: 'already_ended' });
      const next = i.action === 'pause' ? 'paused' : i.action === 'resume' ? 'active' : i.action === 'end' ? 'ended' : m.status;
      if (i.action === 'resume') await requireScope(c, m.organisation_id, m.athlete_id, 'mentoring');
      const r = (await c.query('UPDATE academy_mentor_assignments SET status=$2, cadence_days=coalesce($3,cadence_days), review_on=coalesce($4,review_on), ended_at=CASE WHEN $2=\'ended\' THEN now() ELSE ended_at END, ended_reason=CASE WHEN $2=\'ended\' THEN $5 ELSE ended_reason END WHERE id=$1 RETURNING *', [m.id, next, i.cadence_days ?? null, i.review_on ?? null, i.reason ?? null])).rows[0];
      if (next === 'ended' || next === 'paused') await c.query("UPDATE academy_wellbeing_checkins SET status='cancelled', row_version=row_version+1 WHERE assignment_id=$1 AND status='scheduled'", [m.id]);
      await log(c, m.organisation_id, m.athlete_id, `mentor_${i.action}`, user.id, { type: 'mentor', id: m.id }, i.reason ?? null);
      if (next === 'ended') await tellFamily(c, m.athlete_id, { kind: 'academy_wellbeing', title: 'Mentoring has ended', body: 'Open Wellbeing in GotMyGame to see what happens next.', key: `wb:mentor-end:${m.id}`, data: { organisation_id: m.organisation_id } });
      return r;
    });
  },
});

cap({
  name: 'list_mentor_assignments', method: 'GET', path: '/organisations/:id/academy/wellbeing/mentors', tag: TAG,
  summary: 'Mentor assignments: the director and safeguarding staff see all of them (who mentors whom, rhythm, last and next check-in, whether it is on rhythm); a mentor sees only their own mentees. Consent is checked live: an athlete whose consent for mentoring has been withdrawn shows as consent withdrawn and no further detail.',
  input: z.object({ id, status: z.enum(['active', 'paused', 'ended', 'live']).default('live'), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c);
      return (await c.query(
        `SELECT ${assignmentCols}, u.display_name AS athlete_name, u.avatar_emoji, u.avatar_color, mu.display_name AS mentor_name, ${consentSql('a.organisation_id', 'a.athlete_id', 'mentoring')} AS consent_live,
                (SELECT max(k.completed_at) FROM academy_wellbeing_checkins k WHERE k.assignment_id=a.id AND k.status='completed') AS last_checkin_at,
                (SELECT min(k.scheduled_for) FROM academy_wellbeing_checkins k WHERE k.assignment_id=a.id AND k.status='scheduled' AND k.scheduled_for >= now()) AS next_checkin_at
           FROM academy_mentor_assignments a JOIN users u ON u.id=a.athlete_id JOIN users mu ON mu.id=a.mentor_id
          WHERE a.organisation_id=$1 AND ($2='live' AND a.status <> 'ended' OR a.status=$2) AND ($3::boolean OR a.mentor_id=$4) ORDER BY a.status, u.display_name, a.id LIMIT $5 OFFSET $6`,
        [i.id, i.status, a.oversight, user.id, i.limit, i.offset])).rows.map((r) => ({ ...r, on_rhythm: r.status !== 'active' ? null : new Date(r.last_checkin_at ?? r.started_at).getTime() > Date.now() - (r.cadence_days + 3) * 864e5 }));
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ check-ins
const CHECKIN_COLS = 'k.id, k.assignment_id, k.athlete_id, k.mentor_id, k.scheduled_for, k.duration_min, k.setting, k.topics, k.status, k.outcome, k.completed_at, k.follow_up_due, k.follow_up_status, k.follow_up_done_at, k.series_id, k.next_step_enc, k.row_version';
/** What each audience sees of a check-in. The director sees when and with whom and whether it happened; topics, the outcome and the agreed step are for the mentor and the family. */
export function shapeCheckin(k, who) {
  const base = { id: k.id, athlete_id: k.athlete_id, athlete_name: k.athlete_name, mentor_id: k.mentor_id, mentor_name: k.mentor_name, scheduled_for: k.scheduled_for, duration_min: k.duration_min, setting: k.setting, status: k.status, completed_at: k.completed_at, follow_up_due: k.follow_up_due, follow_up_status: k.follow_up_status, series_id: k.series_id, row_version: k.row_version };
  if (who === 'oversight') return base;
  const outcome = k.outcome === 'concern_raised' && who === 'family' ? 'on_track' : k.outcome;     // a safeguarding concern is the safeguarding team's to disclose, not the schedule's
  return { ...base, topics: k.topics, outcome, next_step: unseal(k.next_step_enc, 'next_step') };
}

cap({
  name: 'schedule_wellbeing_checkin', method: 'POST', path: '/organisations/:id/academy/wellbeing/checkins', tag: TAG, status: 201,
  summary: 'Schedule a wellbeing check-in between an athlete and their mentor, once or as a weekly-or-longer series (up to 12). Needs a live mentor assignment and current consent for check-ins. Topics come from a list; for a young person, video or phone settings are only for guardian-aware sessions. The family is told when it is, in generic words. Idempotent on idempotency_key.',
  input: z.object({ id, athlete_id: id, scheduled_for: z.string().datetime(), duration_min: z.number().int().min(5).max(120).default(20), setting: z.enum(SETTINGS).default('academy_room'), topics: z.array(z.enum(TOPICS)).max(6).default([]),
    repeat: z.number().int().min(1).max(12).default(1), every_days: z.number().int().min(1).max(60).default(14), idempotency_key: z.string().min(8).max(80).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c, true);
      const { role, assignment } = await standing(c, a, user, i.id, i.athlete_id);
      if (!assignment || assignment.status !== 'active') throw conflict('This athlete has no active mentor. Assign one first.', { code: 'no_active_mentor' });
      await requireScope(c, i.id, i.athlete_id, 'checkins');
      if (role === 'oversight' && !a.oversight) throw forbidden('Only the mentor schedules a check-in');
      if (new Date(i.scheduled_for) < new Date(Date.now() - 60_000)) throw badRequest('A check-in is scheduled in the future');
      if (i.idempotency_key) { const dup = (await c.query('SELECT id, series_id FROM academy_wellbeing_checkins WHERE created_by=$1 AND idempotency_key=$2 ORDER BY scheduled_for', [user.id, i.idempotency_key])).rows; if (dup.length) return { replayed: true, series_id: dup[0].series_id, ids: dup.map((d) => d.id) }; }
      const series = (await c.query('SELECT gen_random_uuid() AS s')).rows[0].s, ids = [];
      for (let n = 0; n < i.repeat; n++) {
        const at = new Date(new Date(i.scheduled_for).getTime() + n * i.every_days * 864e5);
        const r = await c.query('INSERT INTO academy_wellbeing_checkins(organisation_id, assignment_id, athlete_id, mentor_id, scheduled_for, duration_min, setting, topics, series_id, idempotency_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
          [i.id, assignment.id, i.athlete_id, assignment.mentor_id, at, i.duration_min, i.setting, i.topics, series, n === 0 ? (i.idempotency_key ?? null) : null, user.id]);
        ids.push(r.rows[0].id);
      }
      await log(c, i.id, i.athlete_id, 'checkin_scheduled', user.id, { type: 'checkin', id: ids[0] }, String(ids.length));
      await tellFamily(c, i.athlete_id, { kind: 'academy_wellbeing', title: 'A wellbeing check-in is booked', body: `${await nameOf(c, assignment.mentor_id)} has booked ${ids.length > 1 ? `${ids.length} check-ins` : 'a check-in'}. Open Wellbeing in GotMyGame for the time and place.`, key: `wb:checkin:${series}`, data: { organisation_id: i.id } });
      return { replayed: false, series_id: series, ids };
    });
  },
});

cap({
  name: 'update_wellbeing_checkin', method: 'PATCH', path: '/academy/wellbeing/checkins/:id', tag: TAG,
  summary: 'The mentor records what happened: complete (outcome on track / follow-up / referral suggested / concern raised, topics covered, a short non-clinical agreed next step, a follow-up date), mark done a follow-up, or mark missed. The mentor or the director may reschedule or cancel. Counselling, diagnosis and safeguarding narrative are refused in the note (422 restricted_content): a concern is raised with concern_summary into the safety-event workflow, encrypted and visible to safeguarding staff only, and the family is not told by this call. Needs the row_version you loaded.',
  input: z.object({ id, row_version: z.number().int(), action: z.enum(['complete', 'reschedule', 'cancel', 'missed', 'follow_up_done']),
    scheduled_for: z.string().datetime().optional(), outcome: z.enum(['on_track', 'follow_up', 'referral_suggested', 'concern_raised']).optional(), topics: z.array(z.enum(TOPICS)).max(6).optional(),
    next_step: z.string().trim().min(3).max(300).optional(), follow_up_due: day.optional(), concern_summary: z.string().trim().min(5).max(2000).optional(), concern_severity: z.enum(['low', 'medium', 'high']).default('medium') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const k = (await c.query('SELECT * FROM academy_wellbeing_checkins WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!k) throw notFound('Check-in');
      let a;
      try { a = await wbAccess(user, k.organisation_id, c, true); } catch (e) { if (e instanceof AppError && e.status === 403) throw notFound('Check-in'); throw e; }
      const mine = k.mentor_id === user.id;
      if (!mine && !a.oversight) throw notFound('Check-in');
      if (k.row_version !== i.row_version) throw conflict('This check-in changed since you opened it. Reload and try again.', { code: 'stale' });
      const set = {};
      if (i.action === 'complete') {
        if (!mine) throw forbidden('Only the mentor records what happened');
        if (k.status !== 'scheduled') throw conflict('This check-in is not waiting to be recorded', { code: 'not_scheduled' });
        await requireScope(c, k.organisation_id, k.athlete_id, 'checkins');
        if (!i.outcome) throw badRequest('Choose an outcome');
        if (['follow_up', 'referral_suggested'].includes(i.outcome) && !i.follow_up_due) throw badRequest('Say when the follow-up is due');
        if (i.outcome === 'concern_raised' && !i.concern_summary) throw badRequest('Describe the concern for safeguarding staff');
        Object.assign(set, { status: 'completed', outcome: i.outcome, completed_at: new Date(), topics: i.topics ?? k.topics, next_step_enc: seal(i.next_step, 'next_step'), follow_up_due: i.follow_up_due ?? null, follow_up_status: i.follow_up_due ? 'open' : 'none' });
        if (i.outcome === 'concern_raised') {
          const policy = await policyFor(c, k.organisation_id);
          const { event } = await openSafetyEvent(c, { orgId: k.organisation_id, athleteId: k.athlete_id, kind: 'welfare_concern', severity: i.concern_severity, summary: i.concern_summary, routedTo: await safeguardingOfficers(c, k.organisation_id, policy), actorId: user.id });
          set.safety_event_id = event.id;
        }
      } else if (i.action === 'follow_up_done') {
        if (!mine) throw forbidden('Only the mentor closes a follow-up');
        if (k.follow_up_status !== 'open') throw conflict('There is no open follow-up', { code: 'no_follow_up' });
        Object.assign(set, { follow_up_status: 'done', follow_up_done_at: new Date() });
      } else if (i.action === 'reschedule') {
        if (k.status !== 'scheduled') throw conflict('Only a scheduled check-in can move', { code: 'not_scheduled' });
        if (!i.scheduled_for || new Date(i.scheduled_for) < new Date()) throw badRequest('Choose a time in the future');
        await requireScope(c, k.organisation_id, k.athlete_id, 'checkins');
        set.scheduled_for = new Date(i.scheduled_for);
      } else {
        if (k.status !== 'scheduled') throw conflict('Only a scheduled check-in can be changed this way', { code: 'not_scheduled' });
        if (i.action === 'missed' && new Date(k.scheduled_for) > new Date()) throw badRequest('It has not happened yet');
        set.status = i.action === 'cancel' ? 'cancelled' : 'missed';
      }
      const keys = Object.keys(set);
      const r = (await c.query(`UPDATE academy_wellbeing_checkins SET ${keys.map((x, n) => `${x}=$${n + 3}`).join(', ')}, row_version=row_version+1 WHERE id=$1 AND row_version=$2 RETURNING id, status, outcome, follow_up_status, follow_up_due, scheduled_for, row_version`, [k.id, k.row_version, ...keys.map((x) => set[x])])).rows[0];
      await log(c, k.organisation_id, k.athlete_id, { complete: 'checkin_completed', reschedule: 'checkin_rescheduled', cancel: 'checkin_cancelled', missed: 'checkin_missed', follow_up_done: 'follow_up_done' }[i.action], user.id, { type: 'checkin', id: k.id });
      if (i.action === 'reschedule' || i.action === 'cancel') await tellFamily(c, k.athlete_id, { kind: 'academy_wellbeing', title: i.action === 'cancel' ? 'A check-in was cancelled' : 'A check-in moved', body: 'Open Wellbeing in GotMyGame for the new details.', key: `wb:checkin-${i.action}:${k.id}:${r.row_version}`, data: { organisation_id: k.organisation_id } });
      return { ...r, outcome: r.outcome === 'concern_raised' ? 'concern_raised' : r.outcome };
    });
  },
});

cap({
  name: 'list_wellbeing_checkins', method: 'GET', path: '/organisations/:id/academy/wellbeing/checkins', tag: TAG,
  summary: 'Check-ins, soonest first. A mentor sees their own mentees\' check-ins in full; the director and safeguarding staff see who, when and whether it happened plus follow-up status, never topics, outcomes or next steps. Only athletes whose consent for check-ins is live appear.',
  input: z.object({ id, status: z.enum(['scheduled', 'completed', 'missed', 'cancelled', 'overdue', 'open_follow_up']).optional(), athlete_id: id.optional(), mentor_id: id.optional(), from: day.optional(), to: day.optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c);
      const rows = (await c.query(
        `SELECT ${CHECKIN_COLS}, u.display_name AS athlete_name, mu.display_name AS mentor_name FROM academy_wellbeing_checkins k JOIN users u ON u.id=k.athlete_id JOIN users mu ON mu.id=k.mentor_id
          WHERE k.organisation_id=$1 AND ${consentSql('k.organisation_id', 'k.athlete_id', 'checkins')} AND ($2::boolean OR k.mentor_id=$3)
            AND ($4::uuid IS NULL OR k.athlete_id=$4) AND ($5::uuid IS NULL OR k.mentor_id=$5) AND ($6::date IS NULL OR k.scheduled_for >= $6) AND ($7::date IS NULL OR k.scheduled_for < $7::date + 1)
            AND (CASE $8 WHEN 'overdue' THEN k.status='scheduled' AND k.scheduled_for < now() - interval '1 day' WHEN 'open_follow_up' THEN k.follow_up_status='open' WHEN '' THEN true ELSE k.status=$8 END)
          ORDER BY k.scheduled_for, k.id LIMIT $9 OFFSET $10`, [i.id, a.oversight, user.id, i.athlete_id ?? null, i.mentor_id ?? null, i.from ?? null, i.to ?? null, i.status ?? '', i.limit, i.offset])).rows;
      return rows.map((k) => shapeCheckin(k, k.mentor_id === user.id ? 'mentor' : 'oversight'));
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ goals
const GOAL_COLS = 'g.id, g.athlete_id, g.track_id, g.title, g.measure, g.target_date, g.status, g.proposed_by, g.reviewer_id, g.athlete_agreed_at, g.guardian_agreed_at, g.last_review_at, g.next_review_on, g.decision_note, g.created_at, g.row_version';

cap({
  name: 'propose_dev_goal', method: 'POST', path: '/organisations/:id/academy/wellbeing/goals', tag: TAG, status: 201,
  summary: 'Propose a personal-development goal for an athlete: a plain-words title, what done looks like, an optional target date and track. A named reviewer (the mentor by default) is accountable for every decision on it; the athlete (and, for a young person, a guardian) must agree before it starts, and nothing marks it achieved automatically. Needs consent for goals. Clinical or counselling wording is refused.',
  input: z.object({ id, athlete_id: id, title: z.string().trim().min(3).max(160), measure: z.string().trim().max(300).optional(), target_date: day.optional(), track_id: id.optional(), reviewer_id: id.optional(), next_review_on: day.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c, true);
      const { assignment } = await standing(c, a, user, i.id, i.athlete_id);
      await requireScope(c, i.id, i.athlete_id, 'goals');
      screen(i.title); screen(i.measure);
      const reviewer = i.reviewer_id ?? assignment?.mentor_id ?? user.id;
      if (!(await mentorEligible(c, i.id, reviewer, i.athlete_id))) throw conflict('The reviewer must be an eligible member of staff for this athlete', { code: 'reviewer_not_eligible' });
      if (i.track_id && !(await c.query('SELECT 1 FROM academy_dev_tracks WHERE id=$1 AND organisation_id=$2', [i.track_id, i.id])).rowCount) throw notFound('Track');
      const r = (await c.query('INSERT INTO academy_dev_goals(organisation_id, athlete_id, track_id, title, measure, target_date, proposed_by, reviewer_id, next_review_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [i.id, i.athlete_id, i.track_id ?? null, i.title, i.measure ?? null, i.target_date ?? null, user.id, reviewer, i.next_review_on ?? plusDays(28)])).rows[0];
      await log(c, i.id, i.athlete_id, 'goal_proposed', user.id, { type: 'goal', id: r.id });
      await tellFamily(c, i.athlete_id, { kind: 'academy_wellbeing', title: 'A development goal to agree', body: 'Open Wellbeing in GotMyGame to read it and agree, or ask for changes.', key: `wb:goal:${r.id}:1`, data: { organisation_id: i.id } });
      return r;
    });
  },
});

cap({
  name: 'review_dev_goal', method: 'PATCH', path: '/academy/wellbeing/goals/:id', tag: TAG,
  summary: 'The goal\'s reviewer (or the director) records a decision: start it once agreed, mark it achieved (needs a short note saying why; never automatic), pause, resume, drop, set the next review, or edit the wording (an edit clears the agreements so the family agrees again). Needs the row_version you loaded.',
  input: z.object({ id, row_version: z.number().int(), action: z.enum(['start', 'achieve', 'pause', 'resume', 'drop', 'edit', 'schedule_review']), note: z.string().trim().max(300).optional(), title: z.string().trim().min(3).max(160).optional(), measure: z.string().trim().max(300).optional(), target_date: day.optional(), next_review_on: day.optional() })
    .refine((v) => v.action !== 'achieve' || !!v.note, 'Say why it is achieved'),
  async handler({ user }, i) {
    return tx(async (c) => {
      const g = (await c.query('SELECT * FROM academy_dev_goals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!g) throw notFound('Goal');
      let a;
      try { a = await wbAccess(user, g.organisation_id, c, true); } catch (e) { if (e instanceof AppError && e.status === 403) throw notFound('Goal'); throw e; }
      if (g.reviewer_id !== user.id && !a.oversight) throw notFound('Goal');
      if (g.row_version !== i.row_version) throw conflict('This goal changed since you opened it. Reload and try again.', { code: 'stale' });
      await requireScope(c, g.organisation_id, g.athlete_id, 'goals');
      screen(i.note); screen(i.title); screen(i.measure);
      const youth = (await c.query('SELECT (youth_until IS NOT NULL AND youth_until > current_date) AS y FROM users WHERE id=$1', [g.athlete_id])).rows[0].y;
      const set = { last_review_at: new Date() };
      if (i.action === 'edit') Object.assign(set, { title: i.title ?? g.title, measure: i.measure ?? g.measure, target_date: i.target_date ?? g.target_date, status: 'proposed', athlete_agreed_at: null, guardian_agreed_at: null, guardian_agreed_by: null });
      else if (i.action === 'schedule_review') { if (!i.next_review_on) throw badRequest('Choose a date'); set.next_review_on = i.next_review_on; }
      else {
        const from = { start: ['agreed'], achieve: ['active'], pause: ['agreed', 'active'], resume: ['paused'], drop: ['proposed', 'agreed', 'active', 'paused'] }[i.action];
        if (!from.includes(g.status)) throw conflict(`A goal that is ${g.status} cannot be ${i.action === 'start' ? 'started' : i.action === 'achieve' ? 'marked achieved' : i.action + 'd'}`, { code: 'bad_transition' });
        if (i.action === 'start' && !(youth ? g.guardian_agreed_at : g.athlete_agreed_at)) throw conflict('The athlete (and guardian) have not agreed yet', { code: 'not_agreed' });
        Object.assign(set, { status: { start: 'active', achieve: 'achieved', pause: 'paused', resume: 'active', drop: 'dropped' }[i.action], decision_note: i.note ?? null });
      }
      const keys = Object.keys(set);
      const r = (await c.query(`UPDATE academy_dev_goals SET ${keys.map((x, n) => `${x}=$${n + 3}`).join(', ')}, updated_at=now(), row_version=row_version+1 WHERE id=$1 AND row_version=$2 RETURNING *`, [g.id, g.row_version, ...keys.map((x) => set[x])])).rows[0];
      await log(c, g.organisation_id, g.athlete_id, `goal_${i.action}`, user.id, { type: 'goal', id: g.id });
      if (i.action === 'edit') await tellFamily(c, g.athlete_id, { kind: 'academy_wellbeing', title: 'A development goal changed', body: 'Open Wellbeing in GotMyGame to read the new wording and agree again.', key: `wb:goal:${g.id}:${r.row_version}`, data: { organisation_id: g.organisation_id } });
      return r;
    });
  },
});

cap({
  name: 'list_dev_goals', method: 'GET', path: '/organisations/:id/academy/wellbeing/goals', tag: TAG,
  summary: 'Development goals with status and review dates. Reviewers and mentors read the wording; the director and safeguarding staff see status, reviewer and dates only. Only athletes whose consent for goals is live appear.',
  input: z.object({ id, athlete_id: id.optional(), status: z.enum(['proposed', 'agreed', 'active', 'achieved', 'paused', 'dropped', 'review_due']).optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c);
      const rows = (await c.query(
        `SELECT ${GOAL_COLS}, u.display_name AS athlete_name, r.display_name AS reviewer_name FROM academy_dev_goals g JOIN users u ON u.id=g.athlete_id JOIN users r ON r.id=g.reviewer_id
          WHERE g.organisation_id=$1 AND ${consentSql('g.organisation_id', 'g.athlete_id', 'goals')} AND ($2::uuid IS NULL OR g.athlete_id=$2)
            AND ($3::boolean OR g.reviewer_id=$4 OR EXISTS (SELECT 1 FROM academy_mentor_assignments m WHERE m.athlete_id=g.athlete_id AND m.organisation_id=g.organisation_id AND m.mentor_id=$4 AND m.status <> 'ended'))
            AND (CASE $5 WHEN 'review_due' THEN g.status IN ('agreed','active') AND g.next_review_on <= current_date WHEN '' THEN true ELSE g.status=$5 END) ORDER BY g.next_review_on NULLS LAST, g.created_at, g.id LIMIT $6 OFFSET $7`,
        [i.id, i.athlete_id ?? null, a.oversight, user.id, i.status ?? '', i.limit, i.offset])).rows;
      return rows.map((g) => (g.reviewer_id === user.id || !a.oversight ? g : { ...g, title: null, measure: null, decision_note: null }));
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ referrals
cap({
  name: 'propose_wellbeing_referral', method: 'POST', path: '/organisations/:id/academy/wellbeing/referrals', tag: TAG, status: 201,
  summary: 'Propose a specialist for an athlete: the kind of specialist and a reason from a list (never a narrative), optionally one of the academy\'s associated providers. Nothing is shared with anyone: the family is told and decides. Needs consent for referrals; the proposer is the athlete\'s mentor or the director.',
  input: z.object({ id, athlete_id: id, specialty: z.enum(SPECIALTIES), reason: z.enum(REASONS), urgency: z.enum(['routine', 'soon']).default('routine'), association_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c, true);
      await standing(c, a, user, i.id, i.athlete_id);
      await requireScope(c, i.id, i.athlete_id, 'referrals');
      if (i.association_id && !(await c.query("SELECT 1 FROM org_provider_associations WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.association_id, i.id])).rowCount) throw notFound('Provider');
      const r = (await c.query('INSERT INTO academy_wellbeing_referrals(organisation_id, athlete_id, specialty, reason, urgency, association_id, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.id, i.athlete_id, i.specialty, i.reason, i.urgency, i.association_id ?? null, user.id])).rows[0];
      await log(c, i.id, i.athlete_id, 'referral_proposed', user.id, { type: 'referral', id: r.id });
      await tellFamily(c, i.athlete_id, { kind: 'academy_wellbeing', title: 'Your academy suggests a specialist', body: 'Open Wellbeing in GotMyGame to read the suggestion. Nothing is shared with anyone unless you say yes.', key: `wb:referral:${r.id}`, data: { organisation_id: i.id } });
      await audit(c, user.id, 'propose_wellbeing_referral', 'academy_wellbeing_referrals', r.id);
      return r;
    });
  },
});

cap({
  name: 'update_wellbeing_referral', method: 'PATCH', path: '/academy/wellbeing/referrals/:id', tag: TAG,
  summary: 'Staff: hand over a referral the family consented to (an associated provider is suggested through the existing academy provider referral, which only sends a generic notification; booking and every clinical conversation stay in the Health workflow), withdraw one before it is handed over, or close a handed-over one. The platform never records that a specialist accepted or treated anyone.',
  input: z.object({ id, action: z.enum(['hand_over', 'withdraw', 'close']) }),
  async handler({ user }, i) {
    const r = await tx(async (c) => {
      const rf = (await c.query('SELECT * FROM academy_wellbeing_referrals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!rf) throw notFound('Referral');
      let a;
      try { a = await wbAccess(user, rf.organisation_id, c, true); } catch (e) { if (e instanceof AppError && e.status === 403) throw notFound('Referral'); throw e; }
      if (rf.proposed_by !== user.id && !a.oversight) throw notFound('Referral');
      const from = { hand_over: ['consented'], withdraw: ['proposed', 'consented'], close: ['handed_over'] }[i.action];
      if (!from.includes(rf.status)) throw conflict(`A referral that is ${rf.status} cannot be ${i.action === 'hand_over' ? 'handed over' : i.action === 'withdraw' ? 'withdrawn' : 'closed'}`, { code: 'bad_transition' });
      if (i.action === 'hand_over') await requireScope(c, rf.organisation_id, rf.athlete_id, 'referrals');
      const next = { hand_over: 'handed_over', withdraw: 'withdrawn', close: 'closed' }[i.action];
      const u = (await c.query("UPDATE academy_wellbeing_referrals SET status=$2, decided_at=now(), handed_over_at=CASE WHEN $2='handed_over' THEN now() ELSE handed_over_at END, row_version=row_version+1 WHERE id=$1 RETURNING *", [rf.id, next])).rows[0];
      await log(c, rf.organisation_id, rf.athlete_id, `referral_${next}`, user.id, { type: 'referral', id: rf.id });
      return u;
    });
    if (i.action === 'hand_over' && r.association_id) {
      const refer = capabilities.find((x) => x.name === 'refer_academy_athlete_to_provider');
      try { await invoke(refer, user, { id: r.organisation_id, association_id: r.association_id, athlete_id: r.athlete_id }); }
      catch (e) { await many("UPDATE academy_wellbeing_referrals SET status='consented', handed_over_at=NULL, row_version=row_version+1 WHERE id=$1 RETURNING id", [r.id]); throw e; }
    }
    return r;
  },
});

cap({
  name: 'list_wellbeing_referrals', method: 'GET', path: '/organisations/:id/academy/wellbeing/referrals', tag: TAG,
  summary: 'Referrals with their consent status. The proposing staff member sees specialty and reason; the director and safeguarding staff see status, specialty and age of the request, never the reason. Only athletes whose consent for referrals is live appear.',
  input: z.object({ id, status: z.enum(['proposed', 'consented', 'handed_over', 'declined', 'withdrawn', 'closed']).optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c);
      const rows = (await c.query(
        `SELECT r.id, r.athlete_id, u.display_name AS athlete_name, r.specialty, r.reason, r.urgency, r.status, r.association_id, r.proposed_by, r.consent_as, r.consent_at, r.handed_over_at, r.created_at
           FROM academy_wellbeing_referrals r JOIN users u ON u.id=r.athlete_id WHERE r.organisation_id=$1 AND ($2::text IS NULL OR r.status=$2) AND ($3::boolean OR r.proposed_by=$4) AND ${consentSql('r.organisation_id', 'r.athlete_id', 'referrals')}
          ORDER BY r.created_at DESC, r.id LIMIT $5 OFFSET $6`, [i.id, i.status ?? null, a.oversight, user.id, i.limit, i.offset])).rows;
      return rows.map((r) => (r.proposed_by === user.id ? r : { ...r, reason: null }));
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ guardian communication
cap({
  name: 'send_wellbeing_update', method: 'POST', path: '/organisations/:id/academy/wellbeing/updates', tag: TAG, status: 201,
  summary: 'Tell the athlete\'s guardians (the athlete, for an adult) something from a fixed set: track progress, a goal outcome, the check-in rhythm, thanks, or an invitation to a review. An optional short note is screened for counselling or clinical wording. Needs consent for guardian updates; the athlete\'s mentor or the director sends it; it is recorded in the transparency log the family can read.',
  input: z.object({ id, athlete_id: id, template: z.enum(UPDATE_TEMPLATES), note: z.string().trim().min(3).max(240).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await wbAccess(user, i.id, c, true);
      await standing(c, a, user, i.id, i.athlete_id);
      await requireScope(c, i.id, i.athlete_id, 'guardian_updates');
      screen(i.note);
      const title = { track_progress: 'Progress in a development track', goal_outcome: 'A development goal was reviewed', checkin_rhythm: 'About your wellbeing check-ins', thank_you: 'A thank-you from your academy', review_invitation: 'You are invited to a wellbeing review' }[i.template];
      const n = await tellFamily(c, i.athlete_id, { kind: 'academy_wellbeing', title, body: `${i.note ? `${i.note} ` : ''}Open Wellbeing in GotMyGame for details.`, key: `wb:update:${i.id}:${i.athlete_id}:${i.template}:${Date.now()}`, data: { organisation_id: i.id } });
      await log(c, i.id, i.athlete_id, 'update_sent', user.id, null, i.template);
      return { sent_to: n, template: i.template };
    });
  },
});
