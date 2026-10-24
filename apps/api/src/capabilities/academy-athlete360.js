// Academy OS 3/3: the Athlete 360 and the partner panels (care network, legal signals, sponsorship). All of it is resolved at read time from the
// canonical domains, one section at a time, by the caller's role. No copy of an athlete, a clinical fact, a legal matter or a sponsorship is stored here;
// the only things persisted are a provider business association and the athlete's consent to share a minimal clearance status.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { requireGuardian, isYouth, hasConsent, requireConsent, guardiansOf } from '../youth.js';
import { STAFF, STAFF_MONEY } from '../academy.js';
import { currentClearance } from '../clearance.js';
import { clinicalCredential } from '../clinical-access.js';
import { beneficiaryScopeSql } from '../sponsor-beneficiaries.js';
import { notify } from '../notify.js';
import { observationEvidence, officialEvidence, attendanceEvidence } from '../academy-outcomes.js';

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const ALL = ['owner', 'admin', 'coach', 'finance'];
const COACHING = ['owner', 'admin', 'coach'];
const MONEY = ['owner', 'admin', 'finance'];

async function known(orgId, athleteId, role, user) {
  const q = role === 'coach'
    ? "SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND k.coach_id=$3 AND e.status IN ('enrolled','paused') LIMIT 1"
    : 'SELECT 1 FROM academy_applications WHERE organisation_id=$1 AND athlete_id=$2 UNION SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND e.programme_id IS NOT NULL LIMIT 1';
  return !!(await one(q, role === 'coach' ? [orgId, athleteId, user.id] : [orgId, athleteId]));
}

/** Minimal clearance the athlete (or a guardian) chose to share with this academy: status, validity, source. Never restrictions text, notes or providers. */
export async function sharedClearance(orgId, athleteId) {
  const share = await one('SELECT 1 FROM academy_clearance_shares WHERE organisation_id=$1 AND athlete_id=$2 AND revoked_at IS NULL', [orgId, athleteId]);
  if (!share) return { state: 'not_shared' };
  if ((await isYouth(athleteId)) && !(await hasConsent(athleteId, 'medical'))) return { state: 'not_shared', reason: 'guardian_consent_lapsed' };
  const c = await currentClearance(athleteId);
  return { state: 'shared', status: c.status, valid_until: c.valid_until, review_due: c.review_due, as_of: c.as_of, source: c.source === 'none' ? 'none' : 'verified clinical decision' };
}

cap({
  name: 'get_academy_athlete_360', method: 'GET', path: '/organisations/:id/academy/athletes/:athlete_id/360', tag: 'Academy',
  summary: 'Academy view of one athlete, assembled from the canonical sources each time and split into sections that are each decided by the caller\'s role (owner/admin: everything the athlete shared; a coach: coaching, attendance and pathway for their own athletes only; finance: billing and funding only). Coach-private notes, clinical records, legal and sponsor terms never appear; clearance is only the minimal status the athlete or guardian chose to share. Audit-logged.',
  input: z.object({ id, athlete_id: id }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, ALL);
    if (!(await known(i.id, i.athlete_id, role, user))) throw notFound('Athlete');
    await audit(null, user.id, 'read_academy_360', 'users', i.athlete_id);
    const denied = { access: 'forbidden', reason: 'Your role does not include this section' };
    const athlete = await one('SELECT id, handle, display_name, avatar_emoji, avatar_color FROM users WHERE id=$1', [i.athlete_id]);
    const youth = await isYouth(i.athlete_id);
    const from = daysAgo(90), to = today();
    const sections = {};
    sections.memberships = !COACHING.includes(role) ? denied : { access: 'ok', source: 'org_enrolments', data: await many(
      `SELECT e.id, e.status, e.enrolled_at, k.name AS group_name, pr.id AS programme_id, pr.title AS programme, pr.sport FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id LEFT JOIN academy_programmes pr ON pr.id=e.programme_id
        WHERE k.organisation_id=$1 AND e.user_id=$2 AND ($3 <> 'coach' OR k.coach_id=$4) ORDER BY e.enrolled_at DESC, e.id`, [i.id, i.athlete_id, role, user.id]) };
    sections.attendance = !COACHING.includes(role) ? denied : { access: 'ok', source: 'org_attendance', data: await attendanceEvidence(i.id, i.athlete_id, from, to) };
    sections.pathway = !COACHING.includes(role) ? denied : { access: 'ok', source: 'academy_progression_decisions', data: await many(
      `SELECT DISTINCT ON (d.pathway_id) d.pathway_id, p.title AS pathway, coalesce(d.to_level, d.from_level) AS level, d.decision, d.created_at,
              (SELECT a.outcome FROM academy_assessments a WHERE a.pathway_id=d.pathway_id AND a.athlete_id=d.athlete_id AND a.status='approved' ORDER BY a.created_at DESC LIMIT 1) AS latest_approved_assessment
         FROM academy_progression_decisions d JOIN academy_pathways p ON p.id=d.pathway_id WHERE d.organisation_id=$1 AND d.athlete_id=$2 ORDER BY d.pathway_id, d.created_at DESC, d.id DESC`, [i.id, i.athlete_id]) };
    if (!COACHING.includes(role)) sections.coaching = denied;
    else if (!(await hasConsent(i.athlete_id, 'coaching'))) sections.coaching = { access: 'no_consent', reason: 'A guardian has not allowed coaching material to be shared' };
    else {
      const obs = await observationEvidence(i.id, i.athlete_id, daysAgo(180), to);
      const goals = await many(
        `SELECT g.id, g.title, g.status, g.athlete_text, g.review_on FROM coaching_goals g WHERE g.athlete_id=$1 AND g.athlete_text IS NOT NULL AND g.status IN ('planned','active','achieved')
            AND g.coach_id IN (SELECT coach_id FROM org_cohorts WHERE organisation_id=$2 AND coach_id IS NOT NULL) ORDER BY g.updated_at DESC, g.id LIMIT 20`, [i.athlete_id, i.id]);
      sections.coaching = { access: 'ok', source: 'coaching_observations (shared with the athlete only), coaching_goals (athlete wording)', origin: 'coach_observed', data: { rubric_dimensions: obs.dimensions, shared_goals: goals } };
    }
    sections.official = !COACHING.includes(role) ? denied : { access: 'ok', source: 'performances (approved competition)', origin: 'official', data: await officialEvidence(i.athlete_id, daysAgo(365), to) };
    sections.clearance = !STAFF.includes(role) && role !== 'coach' ? denied : { access: 'ok', source: 'clinical_clearances (athlete-shared minimal status)', data: await sharedClearance(i.id, i.athlete_id) };
    sections.billing = !MONEY.includes(role) ? denied : { access: 'ok', source: 'academy_charges', data: await many(
      `SELECT ch.currency, count(*)::int AS charges, coalesce(sum(ch.amount_minor) FILTER (WHERE ch.status='awaiting_payment'),0)::bigint AS outstanding_minor,
              coalesce(sum(ch.amount_minor) FILTER (WHERE ch.status='awaiting_payment' AND ch.due_on < current_date),0)::bigint AS overdue_minor, coalesce(sum(ch.amount_minor) FILTER (WHERE ch.status='paid'),0)::bigint AS paid_minor
         FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
        WHERE ch.organisation_id=$1 AND coalesce(e.user_id, a.athlete_id)=$2 AND ch.status <> 'cancelled' GROUP BY ch.currency ORDER BY ch.currency`, [i.id, i.athlete_id]) };
    sections.funding = !MONEY.includes(role) ? denied : { access: 'ok', source: 'academy_charges (funding)', data: await many(
      `SELECT ch.funding_source, ch.currency, count(*)::int AS charges, sum(ch.funded_minor)::bigint AS funded_minor, bool_or(ch.funding_sponsorship_id IS NOT NULL) AS sponsorship_linked
         FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
        WHERE ch.organisation_id=$1 AND coalesce(e.user_id, a.athlete_id)=$2 AND ch.funded_minor > 0 GROUP BY ch.funding_source, ch.currency`, [i.id, i.athlete_id]) };
    return { athlete, is_youth: youth, responsible: youth && STAFF.includes(role) ? await many('SELECT id, display_name FROM users WHERE id = ANY($1) ORDER BY display_name', [await guardiansOf(i.athlete_id)]) : [], my_role: role, sections };
  },
});

cap({
  name: 'share_clearance_with_academy', method: 'POST', path: '/academy/clearance-shares', tag: 'Academy', status: 201, scope: 'clinical',
  summary: 'The athlete, or a verified guardian of a young athlete (who must have given medical consent), lets one academy see ONLY the minimal fit status: cleared / restricted / not cleared / expired / unknown and its valid-through date. No diagnosis, notes or provider details are ever shared. Revoke any time.',
  input: z.object({ organisation_id: id, athlete_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id) await requireGuardian(user, athleteId, c);
    await requireConsent(athleteId, 'medical', 'sharing a fit-to-play status', c);
    const ok = (await c.query('SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 UNION SELECT 1 FROM academy_applications WHERE organisation_id=$1 AND athlete_id=$2 LIMIT 1', [i.organisation_id, athleteId])).rows.length;
    if (!ok) throw notFound('Academy');
    const live = (await c.query('SELECT * FROM academy_clearance_shares WHERE organisation_id=$1 AND athlete_id=$2 AND revoked_at IS NULL', [i.organisation_id, athleteId])).rows[0];
    if (live) return live;
    const r = (await c.query('INSERT INTO academy_clearance_shares(organisation_id, athlete_id, granted_by) VALUES ($1,$2,$3) RETURNING *', [i.organisation_id, athleteId, user.id])).rows[0];
    await audit(c, user.id, 'share_clearance_with_academy', 'users', athleteId);
    return r;
  }),
});

cap({
  name: 'revoke_clearance_share', method: 'POST', path: '/academy/clearance-shares/:id/revoke', tag: 'Academy', scope: 'clinical',
  summary: 'Stop sharing the minimal fit status with an academy (the athlete or their verified guardian). The academy sees nothing from that moment.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT * FROM academy_clearance_shares WHERE id=$1', [i.id]);
    if (!s) throw notFound('Share');
    if (s.athlete_id !== user.id) await requireGuardian(user, s.athlete_id);
    const r = await one('UPDATE academy_clearance_shares SET revoked_at=coalesce(revoked_at, now()), revoked_by=$2 WHERE id=$1 RETURNING *', [s.id, user.id]);
    await audit(null, user.id, 'revoke_clearance_share', 'users', s.athlete_id);
    return r;
  },
});

cap({
  name: 'list_my_clearance_shares', method: 'GET', path: '/academy/clearance-shares', tag: 'Academy',
  summary: 'The academies the signed-in athlete (or a child they guard) currently shares a minimal fit status with.',
  input: z.object({ athlete_id: id.optional() }),
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id) await requireGuardian(user, athleteId);
    return many('SELECT s.id, s.organisation_id, o.name AS organisation, s.created_at, s.revoked_at FROM academy_clearance_shares s JOIN organisations o ON o.id=s.organisation_id WHERE s.athlete_id=$1 ORDER BY s.created_at DESC, s.id', [athleteId]);
  },
});

cap({
  name: 'add_academy_provider', method: 'POST', path: '/organisations/:id/academy/providers', tag: 'Academy', status: 201,
  summary: 'Associate a verified physio or doctor with the academy (owner/admin): preferred, retained, on-call, programme cover, event cover or referral partner. It is a business relationship only: it gives the academy no access to any clinical record.',
  input: z.object({ id, provider_id: id, relation: z.enum(['preferred', 'retained', 'on_call', 'programme_cover', 'event_cover', 'referral_partner']), programme_id: id.optional(), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF, { write: true });
    const prof = await one('SELECT user_id FROM provider_profiles WHERE user_id=$1', [i.provider_id]);
    if (!prof) throw notFound('Provider');
    const cred = await clinicalCredential(i.provider_id);
    if (!cred.ok) throw badRequest('Only a provider with a current verified credential can be associated');
    if (i.programme_id && !(await one('SELECT 1 AS x FROM academy_programmes WHERE id=$1 AND organisation_id=$2', [i.programme_id, i.id]))) throw badRequest('That programme is not in this academy');
    const dup = await one("SELECT id FROM org_provider_associations WHERE organisation_id=$1 AND provider_id=$2 AND relation=$3 AND status='active' AND programme_id IS NOT DISTINCT FROM $4", [i.id, i.provider_id, i.relation, i.programme_id ?? null]);
    if (dup) throw conflict('This provider is already associated in that way');
    const r = await one('INSERT INTO org_provider_associations(organisation_id, provider_id, relation, programme_id, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [i.id, i.provider_id, i.relation, i.programme_id ?? null, i.note ?? null, user.id]);
    await audit(null, user.id, 'add_academy_provider', 'org_provider_associations', r.id);
    return r;
  },
});

cap({
  name: 'revoke_academy_provider', method: 'POST', path: '/academy/providers/:id/revoke', tag: 'Academy',
  summary: 'End a provider association (owner/admin). The row is kept as history.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await one('SELECT * FROM org_provider_associations WHERE id=$1', [i.id]);
    if (!a) throw notFound('Association');
    await orgFor(user, a.organisation_id, STAFF, { write: true });
    return one("UPDATE org_provider_associations SET status='revoked', revoked_at=coalesce(revoked_at, now()), revoked_by=$2 WHERE id=$1 RETURNING *", [a.id, user.id]);
  },
});

cap({
  name: 'list_academy_providers', method: 'GET', path: '/organisations/:id/academy/providers', tag: 'Academy',
  summary: 'The academy\'s provider directory (owner/admin/coach): the physios and doctors associated with it, their type, clinic and city, whether their verification is current today and how they relate to the academy. Business-safe details only; no clinical data and no athlete information.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, COACHING);
    const rows = await many(
      `SELECT a.id, a.provider_id, a.relation, a.programme_id, pr.title AS programme, a.note, a.created_at, u.display_name, p.provider_type, p.headline, p.clinic, p.city, p.in_person, p.remote_ok, p.specialties, p.accepting_patients
         FROM org_provider_associations a JOIN users u ON u.id=a.provider_id JOIN provider_profiles p ON p.user_id=a.provider_id LEFT JOIN academy_programmes pr ON pr.id=a.programme_id
        WHERE a.organisation_id=$1 AND a.status='active' ORDER BY u.display_name, a.relation, a.id`, [i.id]);
    for (const r of rows) r.verified_now = (await clinicalCredential(r.provider_id)).ok;
    return rows;
  },
});

cap({
  name: 'refer_academy_athlete_to_provider', method: 'POST', path: '/organisations/:id/academy/providers/:association_id/refer', tag: 'Academy', status: 201,
  summary: 'Suggest an associated provider to an athlete or their guardians (owner/admin, or a coach for their own athlete). It sends a generic notification only; booking, consent and any clinical conversation stay in the Health workflow under the athlete\'s or guardian\'s control.',
  input: z.object({ id, association_id: id, athlete_id: id }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, COACHING, { write: true });
    if (!(await known(i.id, i.athlete_id, role, user))) throw notFound('Athlete');
    const a = await one("SELECT * FROM org_provider_associations WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.association_id, i.id]);
    if (!a) throw notFound('Association');
    const to = (await isYouth(i.athlete_id)) ? await guardiansOf(i.athlete_id) : [i.athlete_id];
    for (const uid of to) await notify(null, uid, { kind: 'academy_provider_referral', title: 'Your academy suggested a health professional', body: 'Open Gotmygame to look at the suggestion. Nothing is shared with them unless you book.', data: { organisation_id: i.id, provider_id: a.provider_id }, dedupe_key: `academy:referral:${a.id}:${i.athlete_id}:${uid}:${today()}` });
    await audit(null, user.id, 'refer_academy_athlete_to_provider', 'org_provider_associations', a.id);
    return { referred: to.length, provider_id: a.provider_id };
  },
});

cap({
  name: 'get_academy_partners', method: 'GET', path: '/organisations/:id/academy/partners', tag: 'Academy',
  summary: 'Partners and risk signals for the academy executive (owner/admin; finance sees sponsorship only): sponsorship agreements that support the academy or its groups with obligations and funded beneficiaries (only those the caller may see under sponsorship rules), health-provider coverage and athletes\' minimal clearance states shared with the academy (counts), and legal matters opened for the academy as status and dates only. Never agreement terms, clinical data or legal content.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, MONEY);
    const sponsors = await many(
      `SELECT ss.id AS sponsorship_id, sp.name AS sponsor, ss.status, ss.target_type, ss.starts_on, ss.ends_on, ss.currency,
              (SELECT coalesce(sum(o.amount_cents),0)::bigint FROM sponsorship_obligations o WHERE o.sponsorship_id=ss.id AND o.kind='money' AND o.status <> 'cancelled') AS committed_cents,
              (SELECT coalesce(sum(o.amount_cents),0)::bigint FROM sponsorship_obligations o WHERE o.sponsorship_id=ss.id AND o.kind='money' AND o.status='fulfilled') AS received_cents,
              (SELECT count(*)::int FROM sponsorship_obligations o WHERE o.sponsorship_id=ss.id AND o.status='scheduled' AND o.due_on < current_date) AS overdue_obligations,
              (SELECT min(o.due_on) FROM sponsorship_obligations o WHERE o.sponsorship_id=ss.id AND o.status='scheduled' AND o.due_on >= current_date) AS next_due_on,
              (SELECT count(DISTINCT coalesce(e.user_id, ap.athlete_id))::int FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications ap ON ap.id=ch.application_id WHERE ch.funding_sponsorship_id=ss.id) AS beneficiaries_funded
         FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${beneficiaryScopeSql('$2', 'ss')} AND (ss.target_type='organisation' AND ss.target_id=$1 OR ss.target_type='group' AND ss.target_id IN (SELECT id FROM org_cohorts WHERE organisation_id=$1))
          AND ss.status IN ('proposed','active','ended') ORDER BY ss.status, ss.ends_on NULLS LAST, ss.id`, [i.id, user.id]);
    if (!STAFF.includes(role)) return { sponsorship: sponsors, health: null, legal: null };
    const providers = await many("SELECT relation, count(*)::int AS n FROM org_provider_associations WHERE organisation_id=$1 AND status='active' GROUP BY relation ORDER BY relation", [i.id]);
    const shared = await many("SELECT athlete_id FROM academy_clearance_shares WHERE organisation_id=$1 AND revoked_at IS NULL", [i.id]);
    const states = {};
    for (const s of shared) { const c = await sharedClearance(i.id, s.athlete_id); const k = c.state === 'shared' ? c.status : 'not_shared'; states[k] = (states[k] ?? 0) + 1; }
    const enrolled = (await one("SELECT count(DISTINCT e.user_id)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.status IN ('enrolled','paused')", [i.id])).n;
    const legal = await many(
      `SELECT i.id AS intake_id, i.practice_area, i.jurisdiction, i.status AS intake_status, m.status AS matter_status, m.activated_at, m.closed_at, i.created_at
         FROM legal_intakes i LEFT JOIN legal_matters m ON m.intake_id=i.id WHERE i.acting_as='organisation' AND i.acting_for_id=$1 ORDER BY i.created_at DESC, i.id LIMIT 50`, [i.id]);
    return { sponsorship: sponsors, health: { providers, clearance_shared_for: shared.length, enrolled_athletes: enrolled, clearance_states: states }, legal };
  },
});
