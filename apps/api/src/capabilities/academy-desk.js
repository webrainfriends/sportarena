// Academy OS 1/3: the staff-side read models that make the academy desk useful: a programme desk (versions, groups, waitlist, roster),
// a directory of athletes and families with an operational 360, and the announcement history. Read-only views over the canonical records:
// names come from the athlete profile at read time, contact details are never returned, and reading an athlete 360 is audit-logged.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { guardiansOf, isYouth } from '../youth.js';
import { STAFF, SESSIONS_SQL, INVOICE_SQL, INVOICE_NO_SQL } from '../academy.js';

cap({
  name: 'get_academy_programme_desk', method: 'GET', path: '/academy/programmes/:id/desk', tag: 'Academy',
  summary: 'Everything a programme manager needs on one screen (owner/admin; coaches see their own programme groups): seats, version history with how many people accepted each, groups with capacity, the ordered waitlist, the roster, held offers, money by currency and required agreements.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await one('SELECT * FROM academy_programmes WHERE id=$1', [i.id]);
    if (!p) throw notFound('Programme');
    const { role } = await orgFor(user, p.organisation_id, ['owner', 'admin', 'coach', 'finance']);
    const staff = STAFF.includes(role);
    const versions = await many(
      `SELECT v.*, (SELECT count(*)::int FROM org_enrolments e WHERE e.version_id=v.id) AS enrolled_under,
              (SELECT count(*)::int FROM academy_applications a WHERE a.version_id=v.id AND a.stage NOT IN ('declined','withdrawn','expired','cancelled')) AS open_under
         FROM academy_programme_versions v WHERE v.programme_id=$1 ORDER BY v.version DESC`, [p.id]);
    const policies = versions[0]?.policy_version_ids?.length ? await many(
      `SELECT pv.id AS version_id, pol.id AS policy_id, pol.title, pol.kind, pv.version,
              (SELECT count(*)::int FROM org_acknowledgements a WHERE a.policy_version_id=pv.id) AS acknowledged
         FROM org_policy_versions pv JOIN org_policies pol ON pol.id=pv.policy_id WHERE pv.id = ANY($1) ORDER BY pol.title`, [versions[0].policy_version_ids]) : [];
    const groups = await many(
      `SELECT k.id, k.name, k.capacity, k.coach_id, co.display_name AS coach_name, k.status,
              (SELECT count(*)::int FROM org_enrolments e WHERE e.cohort_id=k.id AND e.status IN ('enrolled','paused')) AS enrolled
         FROM org_cohorts k LEFT JOIN users co ON co.id=k.coach_id WHERE k.programme_id=$1 AND ($2 OR k.coach_id=$3) ORDER BY k.name, k.id`, [p.id, staff, user.id]);
    const roster = role === 'finance' ? [] : await many(
      `SELECT e.id AS enrolment_id, e.status, e.enrolled_at, e.cohort_id, k.name AS group_name, ${SESSIONS_SQL} AS sessions_left, e.version_id, u.id AS athlete_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color,
              (SELECT count(*)::int FROM academy_charges ch WHERE ch.enrolment_id=e.id AND ch.status='awaiting_payment' AND ch.due_on < current_date) AS overdue
         FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id
        WHERE e.programme_id=$1 AND e.status IN ('enrolled','paused') AND ($2 OR k.coach_id=$3) ORDER BY u.display_name, u.id LIMIT 300`, [p.id, staff, user.id]);
    const alumni = !staff ? [] : await many(
      `SELECT e.id AS enrolment_id, e.status, e.enrolled_at, e.ended_reason, k.name AS group_name, u.id AS athlete_id, u.display_name, u.avatar_emoji, u.avatar_color,
              (SELECT json_build_object('id', cr.id, 'kind', cr.kind, 'code', cr.code, 'title', cr.title) FROM credentials cr WHERE cr.enrolment_id=e.id AND cr.status='issued' ORDER BY cr.created_at DESC LIMIT 1) AS credential
         FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id
        WHERE e.programme_id=$1 AND e.status IN ('completed','graduated') ORDER BY u.display_name, u.id LIMIT 300`, [p.id]);
    const waitlist = !staff ? [] : await many(
      `SELECT a.id AS application_id, a.waitlist_seq, a.row_version, a.created_at, u.id AS athlete_id, u.display_name, u.avatar_emoji, u.avatar_color, ap.display_name AS applicant_name, (a.applicant_id <> a.athlete_id) AS via_guardian
         FROM academy_applications a JOIN users u ON u.id=a.athlete_id JOIN users ap ON ap.id=a.applicant_id
        WHERE a.programme_id=$1 AND a.stage='waitlisted' ORDER BY a.waitlist_seq, a.id LIMIT 200`, [p.id]);
    const offers = !staff ? [] : await many(
      `SELECT a.id AS application_id, a.offer_expires_at, u.id AS athlete_id, u.display_name FROM academy_applications a JOIN users u ON u.id=a.athlete_id
        WHERE a.programme_id=$1 AND a.stage IN ('offered','offer_accepted') ORDER BY a.offer_expires_at NULLS LAST, a.id`, [p.id]);
    const stages = await many("SELECT stage, count(*)::int AS n FROM academy_applications WHERE programme_id=$1 GROUP BY stage", [p.id]);
    const money = role === 'coach' ? [] : await many(
      `SELECT ch.currency, coalesce(sum(ch.amount_minor) FILTER (WHERE ch.status IN ('awaiting_payment','paid','refunded')),0)::bigint AS billed_minor, coalesce(sum(ch.amount_minor) FILTER (WHERE ch.status='paid'),0)::bigint AS paid_minor,
              coalesce(sum(ch.amount_minor) FILTER (WHERE ch.status='awaiting_payment'),0)::bigint AS outstanding_minor
         FROM academy_charges ch JOIN org_enrolments e ON e.id=ch.enrolment_id WHERE e.programme_id=$1 GROUP BY ch.currency ORDER BY ch.currency`, [p.id]);
    const held = offers.length;
    const enrolled = roster.length || (await one("SELECT count(*)::int AS n FROM org_enrolments WHERE programme_id=$1 AND status IN ('enrolled','paused')", [p.id])).n;
    return { programme: p, versions, policies, groups, roster, alumni, waitlist, offers, stages, money, seats: { capacity: p.capacity, enrolled, offers_held: held, free: p.capacity == null ? null : Math.max(0, p.capacity - enrolled - held), waitlisted: waitlist.length }, my_role: role };
  },
});

cap({
  name: 'list_academy_athletes', method: 'GET', path: '/organisations/:id/academy/athletes', tag: 'Academy',
  summary: 'Directory of the athletes and families who have applied or enrolled (owner/admin): programmes, status, money outstanding. Search by name or handle. Names only; no contact details.',
  input: z.object({ id, q: z.string().max(80).optional(), status: z.enum(['enrolled', 'applicant', 'former']).optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    return many(
      `WITH ppl AS (
         SELECT a.athlete_id FROM academy_applications a WHERE a.organisation_id=$1
         UNION SELECT e.user_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.programme_id IS NOT NULL)
       SELECT u.id AS athlete_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color,
              (SELECT count(*)::int FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.user_id=u.id AND k.organisation_id=$1 AND e.status IN ('enrolled','paused')) AS enrolled,
              (SELECT count(*)::int FROM academy_applications a WHERE a.athlete_id=u.id AND a.organisation_id=$1 AND a.stage NOT IN ('enrolled','declined','withdrawn','expired','cancelled')) AS open_applications,
              (SELECT array_agg(DISTINCT pr.title) FROM academy_applications a JOIN academy_programmes pr ON pr.id=a.programme_id WHERE a.athlete_id=u.id AND a.organisation_id=$1 AND a.stage NOT IN ('declined','withdrawn','expired','cancelled')) AS programmes,
              (SELECT count(*)::int FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id WHERE ch.organisation_id=$1 AND coalesce(e.user_id,a.athlete_id)=u.id AND ch.status='awaiting_payment' AND ch.due_on < current_date) AS overdue,
              EXISTS (SELECT 1 FROM academy_applications a WHERE a.athlete_id=u.id AND a.organisation_id=$1 AND a.applicant_id <> a.athlete_id) AS via_guardian
         FROM ppl JOIN users u ON u.id=ppl.athlete_id
        WHERE ($2::text IS NULL OR u.display_name ILIKE '%'||$2||'%' OR u.handle ILIKE '%'||$2||'%')
        ORDER BY u.display_name, u.id LIMIT $3 OFFSET $4`, [i.id, i.q ?? null, i.limit, i.offset]).then((rows) => rows.filter((r) => !i.status || (i.status === 'enrolled' ? r.enrolled > 0 : i.status === 'applicant' ? r.enrolled === 0 && r.open_applications > 0 : r.enrolled === 0 && r.open_applications === 0)));
  },
});

cap({
  name: 'get_academy_athlete', method: 'GET', path: '/organisations/:id/academy/athletes/:athlete_id', tag: 'Academy',
  summary: 'Operational 360 of one athlete in this academy (owner/admin): who is responsible (names only), applications, enrolments, charges and agreements. Not health data; the athlete must have applied or enrolled here. Audit-logged.',
  input: z.object({ id, athlete_id: id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    const known = await one(`SELECT 1 FROM academy_applications WHERE organisation_id=$1 AND athlete_id=$2 UNION SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND e.programme_id IS NOT NULL LIMIT 1`, [i.id, i.athlete_id]);
    if (!known) throw notFound('Athlete');
    await audit(null, user.id, 'read_pii', 'users', i.athlete_id);
    const athlete = await one('SELECT id, handle, display_name, avatar_emoji, avatar_color FROM users WHERE id=$1', [i.athlete_id]);
    const youth = await isYouth(i.athlete_id);
    const guardians = youth ? await many('SELECT id, handle, display_name FROM users WHERE id = ANY($1) ORDER BY display_name', [await guardiansOf(i.athlete_id)]) : [];
    const applications = await many(
      `SELECT a.id, a.stage, a.row_version, pr.id AS programme_id, pr.title AS programme, a.offer_expires_at, a.created_at, a.updated_at, ap.display_name AS applicant_name
         FROM academy_applications a JOIN academy_programmes pr ON pr.id=a.programme_id JOIN users ap ON ap.id=a.applicant_id WHERE a.organisation_id=$1 AND a.athlete_id=$2 ORDER BY a.updated_at DESC, a.id`, [i.id, i.athlete_id]);
    const enrolments = await many(
      `SELECT e.id, e.status, e.enrolled_at, e.ended_reason, ${SESSIONS_SQL} AS sessions_left, k.name AS group_name, pr.id AS programme_id, pr.title AS programme, v.version
         FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN academy_programmes pr ON pr.id=e.programme_id LEFT JOIN academy_programme_versions v ON v.id=e.version_id
        WHERE k.organisation_id=$1 AND e.user_id=$2 ORDER BY e.enrolled_at DESC, e.id`, [i.id, i.athlete_id]);
    const charges = await many(
      `SELECT ch.id, ch.kind, ch.due_on, ch.currency, ch.gross_minor, ch.discount_minor, ch.funded_minor, ch.funding_source, ch.amount_minor, ch.status, ch.paid_at, (ch.status='awaiting_payment' AND ch.due_on < current_date) AS overdue, ${INVOICE_SQL} AS invoice_id, ${INVOICE_NO_SQL} AS invoice_number
         FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
        WHERE ch.organisation_id=$1 AND coalesce(e.user_id,a.athlete_id)=$2 ORDER BY ch.due_on, ch.id`, [i.id, i.athlete_id]);
    const agreements = await many(
      `SELECT ak.created_at, ak.as_guardian, pol.title, pv.version, ab.display_name AS acknowledged_by
         FROM org_acknowledgements ak JOIN org_policy_versions pv ON pv.id=ak.policy_version_id JOIN org_policies pol ON pol.id=pv.policy_id JOIN users ab ON ab.id=ak.acknowledged_by
        WHERE pol.organisation_id=$1 AND ak.subject_id=$2 ORDER BY ak.created_at DESC`, [i.id, i.athlete_id]);
    return { athlete, is_youth: youth, responsible: guardians, applications, enrolments, charges, agreements };
  },
});

cap({
  name: 'list_academy_announcements', method: 'GET', path: '/organisations/:id/academy/announcements', tag: 'Academy',
  summary: 'Announcements the academy has sent, with their audience size (owner/admin).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    return many(
      `SELECT n.id, n.title, n.body, n.audience, n.stages, n.created_at, p.title AS programme, u.display_name AS sent_by
         FROM academy_announcements n LEFT JOIN academy_programmes p ON p.id=n.programme_id JOIN users u ON u.id=n.created_by
        WHERE n.organisation_id=$1 ORDER BY n.created_at DESC, n.id LIMIT $2 OFFSET $3`, [i.id, i.limit, i.offset]);
  },
});

