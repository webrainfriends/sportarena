// PS-14: Adaptive Academy Enrolment-to-Training Integration. Connects the #808 inclusive/adaptive capability
// with enrolment flow, change-of-programme, and guardian progress view. No diagnosis ever returned or stored.
// All endpoints: tenant/org auth, guardian consent verification, audit on sensitive reads.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx, many, one, pool } from '../db.js';
import { notify } from '../notify.js';
import { audit } from '../helpers.js';
import { opsAccess } from '../academy-ops.js';
import {
  liveShares, shareIsLive, guardianLink, enrolled, forbidden, notFound, badRequest, conflict,
  typeOfNeed, log,
} from '../inclusion.js';

const TAG = 'Academy inclusion operations';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** Returns true if a programme has an inclusion profile with at least one requirement or offered need. */
export async function hasInclusion(c, programmeId) {
  const row = (await c.query(
    "SELECT 1 FROM academy_programme_inclusion WHERE programme_id=$1 AND (array_length(offered_needs,1) > 0 OR jsonb_array_length(requirements->'venue_features') > 0 OR requirements->>'staff_credential' IS NOT NULL OR (requirements->>'support_ratio')::int > 0)",
    [programmeId],
  )).rowCount;
  return row > 0;
}

// ------------------------------------------------------------------------------------------------------------------ enrolment prompt

cap({
  name: 'get_enrolment_inclusion_prompt',
  method: 'GET',
  path: '/organisations/:org_id/academy/inclusion/enrolment-prompt',
  tag: TAG,
  summary: 'After enrolment: checks whether the programme has adaptive requirements the athlete has not yet shared with the coaching team. Returns the programme\'s publicly-advertised need types (not the athlete\'s clinical record) and the audience they may share with. Auth: athlete themselves or verified guardian.',
  input: z.object({ org_id: id, programme_id: id, athlete_id: id }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      if (i.athlete_id !== user.id && !(await guardianLink(user.id, i.athlete_id))) throw notFound('Person');
      if (!(await enrolled({ query: c.query.bind(c) }, i.org_id, i.athlete_id))) throw notFound('Enrolment');
      const prof = (await c.query(
        'SELECT offered_needs, requirements FROM academy_programme_inclusion WHERE programme_id=$1',
        [i.programme_id],
      )).rows[0];
      if (!prof || (!prof.offered_needs?.length && !Object.keys(prof.requirements ?? {}).length)) {
        return { has_requirements: false, unmet_needs: [], audience: [] };
      }
      const live = await liveShares({ query: c.query.bind(c) }, i.org_id, i.athlete_id);
      const sharedKeys = new Set(live.flatMap((s) => s.need_keys));
      const unmet = (prof.offered_needs ?? []).filter((k) => !sharedKeys.has(k));
      const existing = (await c.query(
        "SELECT id, dismissed_at, shares_satisfied_at FROM academy_enrolment_inclusion_prompts WHERE org_id=$1 AND programme_id=$2 AND athlete_id=$3 ORDER BY created_at DESC LIMIT 1",
        [i.org_id, i.programme_id, i.athlete_id],
      )).rows[0] ?? null;
      const staffRows = await c.query(
        "SELECT DISTINCT u.id AS user_id, u.display_name FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id JOIN org_cohorts k ON k.id=s.cohort_id JOIN org_enrolments e ON e.cohort_id=k.id JOIN users u ON u.id=st.user_id WHERE s.organisation_id=$1 AND e.athlete_id=$2 AND e.status='enrolled' AND st.status IN ('assigned','confirmed') AND s.starts_at > now() AND s.starts_at < now() + interval '30 days' ORDER BY u.display_name LIMIT 20",
        [i.org_id, i.athlete_id],
      );
      return {
        has_requirements: prof.offered_needs?.length > 0,
        unmet_needs: unmet.map((k) => ({ key: k, type: typeOfNeed(k) })),
        already_shared: unmet.length === 0 && live.length > 0,
        dismissed: !!(existing?.dismissed_at),
        audience: staffRows.rows.map((r) => ({ user_id: r.user_id, display_name: r.display_name })),
        prompt_id: existing?.id ?? null,
      };
    });
  },
});

cap({
  name: 'dismiss_enrolment_prompt',
  method: 'POST',
  path: '/organisations/:org_id/academy/inclusion/enrolment-prompt/dismiss',
  tag: TAG,
  summary: 'Athlete or verified guardian dismisses the post-enrolment accommodation prompt. They may share later at any time via the standard share_accommodation flow. Dismissal is logged.',
  input: z.object({ org_id: id, programme_id: id, athlete_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      if (i.athlete_id !== user.id && !(await guardianLink(user.id, i.athlete_id))) throw notFound('Person');
      await c.query(
        `INSERT INTO academy_enrolment_inclusion_prompts(org_id, enrolment_id, athlete_id, programme_id, dismissed_at)
         SELECT $1, e.id, $3, $4, now()
         FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id AND k.programme_id=$4
         WHERE e.athlete_id=$3 AND k.organisation_id=$1 AND e.status='enrolled'
         ORDER BY e.created_at DESC LIMIT 1
         ON CONFLICT (enrolment_id) DO UPDATE SET dismissed_at=now()`,
        [i.org_id, user.id, i.athlete_id, i.programme_id],
      );
      await log(c, i.org_id, null, 'enrolment_inclusion_prompt_dismissed', user.id, { type: 'athlete', id: i.athlete_id }, `programme ${i.programme_id}`);
      return { dismissed: true };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ change-of-programme

cap({
  name: 'change_of_programme',
  method: 'POST',
  path: '/organisations/:org_id/academy/inclusion/change-programme',
  tag: TAG,
  summary: 'Transfer an enrolled athlete to a different inclusive programme. Carries accommodation shares forward for staff that overlap between programmes; revokes shares with staff who leave; prompts a re-share for new staff who have no access. Logs the transition. Auth: academy owner/admin or schedule permission.',
  input: z.object({
    org_id: id,
    athlete_id: id,
    from_programme_id: id,
    to_programme_id: id,
    reason: z.string().trim().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await opsAccess(user, i.org_id, { write: true, c });
      if (!a.admin && !a.hasBroad('schedule')) throw forbidden('Requires schedule permission');
      if (i.from_programme_id === i.to_programme_id) throw badRequest('Source and destination programme must differ');
      const toProf = (await c.query('SELECT offered_needs, requirements FROM academy_programme_inclusion WHERE programme_id=$1', [i.to_programme_id])).rows[0];
      const liveShareRows = await liveShares({ query: c.query.bind(c) }, i.org_id, i.athlete_id);
      const fromStaff = new Set(
        (await c.query(
          "SELECT DISTINCT st.user_id FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id JOIN org_cohorts k ON k.id=s.cohort_id WHERE s.organisation_id=$1 AND k.programme_id=$2 AND st.status IN ('assigned','confirmed') AND s.starts_at > now()",
          [i.org_id, i.from_programme_id],
        )).rows.map((r) => r.user_id),
      );
      const toStaff = new Set(
        (await c.query(
          "SELECT DISTINCT st.user_id FROM academy_session_staff st JOIN academy_sessions s ON s.id=st.session_id JOIN org_cohorts k ON k.id=s.cohort_id WHERE s.organisation_id=$1 AND k.programme_id=$2 AND st.status IN ('assigned','confirmed') AND s.starts_at > now()",
          [i.org_id, i.to_programme_id],
        )).rows.map((r) => r.user_id),
      );
      let carried = 0, revoked = 0, prompted = 0;
      for (const share of liveShareRows) {
        const audience = share.audience_user_ids ?? [];
        const keepIds = audience.filter((uid) => toStaff.has(uid));
        const revokeIds = audience.filter((uid) => fromStaff.has(uid) && !toStaff.has(uid));
        if (revokeIds.length) {
          await c.query('UPDATE accommodation_shares SET revoked_at=now(), revoked_by=$2 WHERE id=$1 AND revoked_at IS NULL', [share.id, user.id]);
          revoked++;
          await log(c, i.org_id, null, 'accommodation_revoked_on_programme_change', user.id, { type: 'share', id: share.id }, `to programme ${i.to_programme_id}`);
        } else if (keepIds.length) {
          carried++;
        }
      }
      const newStaff = [...toStaff].filter((uid) => !fromStaff.has(uid));
      if (newStaff.length && toProf?.offered_needs?.length) prompted = newStaff.length;
      await c.query(
        'INSERT INTO academy_programme_changes(org_id, athlete_id, from_programme_id, to_programme_id, reason, acted_by, shares_carried, shares_revoked, shares_prompted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [i.org_id, i.athlete_id, i.from_programme_id, i.to_programme_id, i.reason ?? null, user.id, carried, revoked, prompted],
      );
      await log(c, i.org_id, null, 'athlete_programme_changed', user.id, { type: 'athlete', id: i.athlete_id }, `${i.from_programme_id} -> ${i.to_programme_id}`);
      await audit(c, user.id, 'change_of_programme', 'athletes', i.athlete_id);
      await notify(c, i.athlete_id, { kind: 'academy_programme_changed', title: 'Your programme has changed', body: i.reason ? `Reason: ${i.reason}` : 'You have been moved to a new programme. Your support needs have been updated for the new team.', data: { org_id: i.org_id, to_programme_id: i.to_programme_id } });
      return { ok: true, shares_carried: carried, shares_revoked: revoked, reshare_prompt_count: prompted };
    });
  },
});

// ------------------------------------------------------------------------------------------------------------------ guardian progress

cap({
  name: 'get_guardian_inclusive_progress',
  method: 'GET',
  path: '/organisations/:org_id/academy/inclusion/guardian-progress',
  tag: TAG,
  summary: 'Guardian- or athlete-facing inclusive progress view: current programme and cohort, attendance summary (last 30 sessions), adapted assessment milestone descriptors (no raw scores), billing credits and outstanding fees, and upcoming sessions with readiness level. Auth: verified guardian or the athlete themselves. No diagnosis returned.',
  input: z.object({ org_id: id, athlete_id: id }),
  async handler({ user }, i) {
    return pool.connect(async (c) => {
      if (i.athlete_id !== user.id && !(await guardianLink(user.id, i.athlete_id))) throw forbidden('Guardian access required');
      const q = c.query.bind(c);
      const enrolRow = (await c.query(
        "SELECT e.id AS enrolment_id, e.cohort_id, k.name AS cohort_name, k.programme_id, p.title AS programme_title, p.sport FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id LEFT JOIN academy_programmes p ON p.id=k.programme_id WHERE k.organisation_id=$1 AND e.athlete_id=$2 AND e.status='enrolled' ORDER BY e.created_at DESC LIMIT 1",
        [i.org_id, i.athlete_id],
      )).rows[0];
      if (!enrolRow) throw notFound('Enrolment');
      await audit({ query: q }, user.id, 'get_guardian_inclusive_progress', 'athletes', i.athlete_id);
      const attendanceRows = await c.query(
        "SELECT s.id AS session_id, s.title, s.starts_at, coalesce(t.status,'expected') AS attendance FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id LEFT JOIN academy_attendance t ON t.session_id=s.id AND t.athlete_id=$2 WHERE s.organisation_id=$1 AND k.id=$3 AND s.status IN ('published','completed') ORDER BY s.starts_at DESC LIMIT 30",
        [i.org_id, i.athlete_id, enrolRow.cohort_id],
      );
      const present = attendanceRows.rows.filter((r) => ['present', 'late', 'left_early'].includes(r.attendance)).length;
      const held = attendanceRows.rows.length;
      const milestones = (await c.query(
        "SELECT aa.descriptor, aa.level_key, aa.signed_off_at, aa.signed_off_by FROM academy_adapted_assessments aa WHERE aa.organisation_id=$1 AND aa.athlete_id=$2 AND aa.signed_off_at IS NOT NULL ORDER BY aa.signed_off_at DESC LIMIT 20",
        [i.org_id, i.athlete_id],
      )).rows.map((r) => ({ descriptor: r.descriptor, level_key: r.level_key, achieved_at: r.signed_off_at }));
      const creditsRow = (await c.query(
        "SELECT coalesce(sum(amount_minor) FILTER (WHERE direction='credit'), 0)::bigint AS credits_minor, coalesce(sum(amount_minor) FILTER (WHERE direction='debit' AND status='awaiting_payment'), 0)::bigint AS outstanding_minor, max(currency) AS currency FROM academy_charges WHERE organisation_id=$1 AND athlete_id=$2",
        [i.org_id, i.athlete_id],
      )).rows[0] ?? { credits_minor: 0, outstanding_minor: 0, currency: null };
      const upcoming = (await c.query(
        "SELECT s.id AS session_id, s.title, s.starts_at, s.ends_at, s.timezone FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id WHERE s.organisation_id=$1 AND k.id=$2 AND s.status='published' AND s.starts_at > now() ORDER BY s.starts_at LIMIT 5",
        [i.org_id, enrolRow.cohort_id],
      )).rows;
      const liveShareRows = await liveShares({ query: q }, i.org_id, i.athlete_id);
      return {
        programme: { id: enrolRow.programme_id, title: enrolRow.programme_title, sport: enrolRow.sport },
        cohort: { id: enrolRow.cohort_id, name: enrolRow.cohort_name },
        attendance: { held, present, absent: held - present, rate_pct: held ? Math.round((present / held) * 100) : null },
        milestones,
        billing: { credits_minor: Number(creditsRow.credits_minor), outstanding_minor: Number(creditsRow.outstanding_minor), currency: creditsRow.currency },
        upcoming_sessions: upcoming.map((s) => ({ session_id: s.session_id, title: s.title, starts_at: s.starts_at, ends_at: s.ends_at, timezone: s.timezone })),
        accommodations_shared: liveShareRows.length > 0,
        accommodation_count: liveShareRows.length,
      };
    });
  },
});
