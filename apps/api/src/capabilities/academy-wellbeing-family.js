// Academy student wellbeing & personal development (#795), part 2 - the athlete's and the guardian's side. Everything a family needs in one call
// (who mentors, when the check-ins are, what is open, which goals and referrals are waiting for them, and exactly who has looked at the record),
// and the decisions that are theirs alone: what to take part in (revocable at any moment), agreeing a goal, saying yes or no to a specialist.
// A young person acts through a verified guardian holding the consent scope; the server re-checks that on every call.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { tx } from '../db.js';
import { notify } from '../notify.js';
import { audit } from '../helpers.js';
import { isYouth } from '../youth.js';
import { SCOPES, CONSENT_MONTHS, actingFor, familyOf, fitsAge, ageBand, liveConsent, log, mentorOf, nameOf, notFound, conflict, requireScope, enrolled } from '../wellbeing.js';
import { shapeCheckin } from './academy-wellbeing.js';

const TAG = 'Academy wellbeing';

cap({
  name: 'set_wellbeing_consent', method: 'POST', path: '/me/wellbeing/consent', tag: TAG, status: 201,
  summary: 'Decide what the academy may do for an athlete: personal-development tracks, mentoring, wellbeing check-ins, development goals, progress updates to guardians, and specialist suggestions. An adult athlete decides for themself; a verified guardian with the consent scope decides for a young person (the young person cannot, and a guardian\'s choice lapses if their authority ends). Send fewer scopes to narrow it and an empty list to withdraw everything: the change is immediate, scheduled check-ins are cancelled, mentoring pauses and open specialist suggestions are withdrawn. The earlier choice is kept as history.',
  input: z.object({ organisation_id: id, athlete_id: id, scopes: z.array(z.enum(SCOPES)).max(SCOPES.length), months: z.number().int().min(1).max(CONSENT_MONTHS).default(CONSENT_MONTHS) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const as = await actingFor(c, user, i.athlete_id, 'consent');
      const org = (await c.query("SELECT id FROM organisations WHERE id=$1 AND kind='academy'", [i.organisation_id])).rows[0];
      if (!org) throw notFound('Academy');
      const known = await enrolled(c, i.organisation_id, i.athlete_id) || (await c.query('SELECT 1 FROM academy_wellbeing_consents WHERE organisation_id=$1 AND athlete_id=$2', [i.organisation_id, i.athlete_id])).rowCount;
      if (!known) throw notFound('Academy');
      const scopes = [...new Set(i.scopes)];
      const prev = await liveConsent(c, i.organisation_id, i.athlete_id);
      await c.query('UPDATE academy_wellbeing_consents SET revoked_at=now(), revoked_by=$3 WHERE organisation_id=$1 AND athlete_id=$2 AND revoked_at IS NULL', [i.organisation_id, i.athlete_id, user.id]);
      let row = null;
      if (scopes.length) row = (await c.query("INSERT INTO academy_wellbeing_consents(organisation_id, athlete_id, scopes, granted_by, granted_as, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(months => $6)) RETURNING *", [i.organisation_id, i.athlete_id, scopes, user.id, as, i.months])).rows[0];
      const removed = (prev?.scopes ?? []).filter((s) => !scopes.includes(s));
      if (removed.includes('checkins') || removed.includes('mentoring')) await c.query("UPDATE academy_wellbeing_checkins SET status='cancelled', row_version=row_version+1 WHERE organisation_id=$1 AND athlete_id=$2 AND status='scheduled'", [i.organisation_id, i.athlete_id]);
      if (removed.includes('mentoring')) {
        const m = await c.query("UPDATE academy_mentor_assignments SET status='paused' WHERE organisation_id=$1 AND athlete_id=$2 AND status='active' RETURNING id, mentor_id", [i.organisation_id, i.athlete_id]);
        for (const r of m.rows) await notify(c, r.mentor_id, { kind: 'academy_wellbeing', title: 'A mentee\'s sharing choices changed', body: 'Open Wellbeing in Gotmygame. Nothing further is shown to you for that athlete until they choose otherwise.', data: { organisation_id: i.organisation_id }, dedupe_key: `wb:consent-change:${r.id}:${Date.now()}` });
      }
      if (removed.includes('referrals')) await c.query("UPDATE academy_wellbeing_referrals SET status='withdrawn', decided_at=now(), row_version=row_version+1 WHERE organisation_id=$1 AND athlete_id=$2 AND status IN ('proposed','consented')", [i.organisation_id, i.athlete_id]);
      await log(c, i.organisation_id, i.athlete_id, !scopes.length ? 'consent_revoked' : prev ? 'consent_changed' : 'consent_granted', user.id, { type: 'consent', id: row?.id ?? prev?.id }, scopes.join(','));
      await audit(c, user.id, scopes.length ? 'set_wellbeing_consent' : 'revoke_wellbeing_consent', 'academy_wellbeing_consents', row?.id ?? prev?.id ?? i.athlete_id);
      return { organisation_id: i.organisation_id, athlete_id: i.athlete_id, scopes, granted_as: row?.granted_as ?? null, expires_at: row?.expires_at ?? null, withdrawn: !scopes.length };
    });
  },
});

cap({
  name: 'get_my_wellbeing', method: 'GET', path: '/me/wellbeing', tag: TAG,
  summary: 'For the athlete or a verified guardian: for each academy, the choices made (and by whom, until when), the mentor, upcoming and past check-ins with their follow-up status, track progress, goals to agree, specialist suggestions waiting for a decision and the transparency log of everything done on this record, including each time staff opened it. Outcomes that belong to safeguarding are never shown here. Send athlete_id to look at a young person you are a guardian of.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const athleteId = i.athlete_id ?? user.id;
      const who = await familyOf(c, user, athleteId);
      if (!who) throw notFound('Person');
      const young = await isYouth(athleteId, c);
      const acting = (!young && who === 'self') || who === 'guardian';
      const orgs = (await c.query(
        `SELECT o.id, o.name FROM organisations o WHERE o.kind='academy' AND o.id IN (
           SELECT k.organisation_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.user_id=$1 AND e.status IN ('enrolled','paused')
           UNION SELECT organisation_id FROM academy_wellbeing_consents WHERE athlete_id=$1 UNION SELECT organisation_id FROM academy_mentor_assignments WHERE athlete_id=$1) ORDER BY o.name`, [athleteId])).rows;
      const band = await ageBand(c, athleteId);
      const academies = [];
      for (const o of orgs) {
        const consent = await liveConsent(c, o.id, athleteId);
        const scopes = consent?.scopes ?? [];
        const mentor = scopes.includes('mentoring') ? await mentorOf(c, o.id, athleteId) : null;
        const checkins = scopes.includes('checkins') ? (await c.query(
          `SELECT k.*, u.display_name AS athlete_name, m.display_name AS mentor_name FROM academy_wellbeing_checkins k JOIN users u ON u.id=k.athlete_id JOIN users m ON m.id=k.mentor_id
            WHERE k.organisation_id=$1 AND k.athlete_id=$2 AND (k.scheduled_for >= now() - interval '120 days') ORDER BY k.scheduled_for DESC LIMIT 30`, [o.id, athleteId])).rows.map((k) => shapeCheckin(k, 'family')) : [];
        const goals = scopes.includes('goals') ? (await c.query('SELECT g.*, r.display_name AS reviewer_name FROM academy_dev_goals g JOIN users r ON r.id=g.reviewer_id WHERE g.organisation_id=$1 AND g.athlete_id=$2 ORDER BY g.created_at DESC LIMIT 30', [o.id, athleteId])).rows : [];
        const tracks = scopes.includes('tracks') ? (await c.query(
          `SELECT t.id, t.category, t.title, t.summary, t.delivery, t.modules, t.age_min, t.age_max, m.status AS member_status, m.modules_done FROM academy_dev_tracks t LEFT JOIN academy_dev_track_members m ON m.track_id=t.id AND m.athlete_id=$2
            WHERE t.organisation_id=$1 AND (m.id IS NOT NULL OR t.status='active') ORDER BY t.category, t.title`, [o.id, athleteId])).rows.filter((t) => t.member_status || fitsAge(band, t)) : [];
        const referrals = scopes.includes('referrals') ? (await c.query(
          `SELECT r.id, r.specialty, r.reason, r.urgency, r.status, r.consent_as, r.consent_at, r.created_at, u.display_name AS proposed_by_name, p.display_name AS provider_name
             FROM academy_wellbeing_referrals r JOIN users u ON u.id=r.proposed_by LEFT JOIN org_provider_associations a ON a.id=r.association_id LEFT JOIN users p ON p.id=a.provider_id
            WHERE r.organisation_id=$1 AND r.athlete_id=$2 ORDER BY r.created_at DESC LIMIT 20`, [o.id, athleteId])).rows : [];
        const timeline = (await c.query(
          `SELECT e.id, e.kind, e.created_at, e.detail, u.display_name AS actor_name FROM academy_wellbeing_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.organisation_id=$1 AND e.athlete_id=$2 ORDER BY e.created_at DESC, e.id DESC LIMIT 40`, [o.id, athleteId])).rows;
        academies.push({
          organisation: o, consent: consent ? { scopes, granted_as: consent.granted_as, granted_at: consent.granted_at, expires_at: consent.expires_at } : null,
          mentor: mentor ? { id: mentor.id, name: await nameOf(c, mentor.mentor_id), status: mentor.status, cadence_days: mentor.cadence_days, review_on: mentor.review_on, started_at: mentor.started_at } : null,
          checkins, follow_ups: checkins.filter((k) => k.follow_up_status === 'open'), goals, tracks, referrals, timeline,
        });
      }
      return { athlete: { id: athleteId, name: await nameOf(c, athleteId), is_youth: young }, acting, viewer: who, academies };
    });
  },
});

cap({
  name: 'respond_dev_goal', method: 'POST', path: '/me/wellbeing/goals/:id/respond', tag: TAG,
  summary: 'Agree to a development goal or turn it down. The athlete agrees for themself; for a young person the guardian\'s agreement is what starts it (the young person may add their own). Nothing starts until a person agrees, and the reviewer is told. Declining drops the proposal; the academy can propose another.',
  input: z.object({ id, decision: z.enum(['agree', 'decline']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const g = (await c.query('SELECT * FROM academy_dev_goals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!g) throw notFound('Goal');
      const who = await familyOf(c, user, g.athlete_id);
      if (!who) throw notFound('Goal');
      const young = await isYouth(g.athlete_id, c);
      if (who === 'guardian') await actingFor(c, user, g.athlete_id, 'consent');
      await requireScope(c, g.organisation_id, g.athlete_id, 'goals');
      if (g.status !== 'proposed') throw conflict('This goal is not waiting for an answer', { code: 'not_proposed' });
      let r;
      if (i.decision === 'decline') r = (await c.query("UPDATE academy_dev_goals SET status='dropped', decision_note='Declined by the family', updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *", [g.id])).rows[0];
      else {
        const athleteAt = who === 'self' ? new Date() : g.athlete_agreed_at, guardianAt = who === 'guardian' ? new Date() : g.guardian_agreed_at;
        const agreed = young ? !!guardianAt : !!athleteAt;
        r = (await c.query('UPDATE academy_dev_goals SET athlete_agreed_at=$2, guardian_agreed_at=$3, guardian_agreed_by=CASE WHEN $4 THEN $5::uuid ELSE guardian_agreed_by END, status=CASE WHEN $6 THEN \'agreed\' ELSE status END, updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *', [g.id, athleteAt, guardianAt, who === 'guardian', user.id, agreed])).rows[0];
      }
      await log(c, g.organisation_id, g.athlete_id, `goal_${i.decision === 'agree' ? 'agreed' : 'declined'}`, user.id, { type: 'goal', id: g.id });
      await notify(c, g.reviewer_id, { kind: 'academy_wellbeing', title: 'A development goal has an answer', body: 'Open Wellbeing in Gotmygame.', data: { organisation_id: g.organisation_id, goal_id: g.id }, dedupe_key: `wb:goal-answer:${g.id}:${r.row_version}` });
      return r;
    });
  },
});

cap({
  name: 'respond_wellbeing_referral', method: 'POST', path: '/me/wellbeing/referrals/:id/respond', tag: TAG,
  summary: 'Say yes or no to a specialist the academy suggested, or take a yes back while it is not handed over. Only the athlete (an adult) or a verified guardian with the consent scope decides. A yes lets the academy hand the suggestion on; it shares no notes because there are none.',
  input: z.object({ id, decision: z.enum(['consent', 'decline', 'withdraw']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const rf = (await c.query('SELECT * FROM academy_wellbeing_referrals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!rf) throw notFound('Referral');
      if (!(await familyOf(c, user, rf.athlete_id))) throw notFound('Referral');
      const as = await actingFor(c, user, rf.athlete_id, 'consent');
      const from = { consent: ['proposed'], decline: ['proposed'], withdraw: ['proposed', 'consented'] }[i.decision];
      if (!from.includes(rf.status)) throw conflict(`This suggestion is ${rf.status}`, { code: 'bad_transition' });
      if (i.decision === 'consent') await requireScope(c, rf.organisation_id, rf.athlete_id, 'referrals');
      const next = { consent: 'consented', decline: 'declined', withdraw: 'withdrawn' }[i.decision];
      const r = (await c.query("UPDATE academy_wellbeing_referrals SET status=$2, decided_at=now(), consent_by=CASE WHEN $2='consented' THEN $3::uuid ELSE consent_by END, consent_as=CASE WHEN $2='consented' THEN $4 ELSE consent_as END, consent_at=CASE WHEN $2='consented' THEN now() ELSE consent_at END, row_version=row_version+1 WHERE id=$1 RETURNING id, status, consent_as, consent_at", [rf.id, next, user.id, as])).rows[0];
      await log(c, rf.organisation_id, rf.athlete_id, `referral_${next}`, user.id, { type: 'referral', id: rf.id });
      await notify(c, rf.proposed_by, { kind: 'academy_wellbeing', title: 'A specialist suggestion has an answer', body: 'Open Wellbeing in Gotmygame.', data: { organisation_id: rf.organisation_id, referral_id: rf.id }, dedupe_key: `wb:referral-answer:${rf.id}:${next}` });
      await audit(c, user.id, `${i.decision}_wellbeing_referral`, 'academy_wellbeing_referrals', rf.id);
      return r;
    });
  },
});

cap({
  name: 'leave_dev_track', method: 'POST', path: '/me/wellbeing/tracks/:id/leave', tag: TAG,
  summary: 'Leave a development track. Tracks are always optional: the athlete, or a guardian of a young person, can leave at any time without giving a reason. Progress so far is kept for the athlete.',
  input: z.object({ id, athlete_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const athleteId = i.athlete_id ?? user.id;
      if (!(await familyOf(c, user, athleteId))) throw notFound('Track');
      const r = await c.query("UPDATE academy_dev_track_members SET status='withdrawn', ended_at=now() WHERE track_id=$1 AND athlete_id=$2 AND status='enrolled' RETURNING track_id", [i.id, athleteId]);
      if (!r.rowCount) throw notFound('Track');
      const t = (await c.query('SELECT organisation_id FROM academy_dev_tracks WHERE id=$1', [i.id])).rows[0];
      await log(c, t.organisation_id, athleteId, 'track_left', user.id, { type: 'track', id: i.id });
      return { track_id: i.id, status: 'withdrawn' };
    });
  },
});

