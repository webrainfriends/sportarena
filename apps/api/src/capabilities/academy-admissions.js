// Academy OS 1/3: admissions funnel, offers/waitlist, enrolment lifecycle and the academy CRM view.
// Server-authoritative: clients ask for a move, `moveStage` decides, every move is written to an append-only history.
// People, guardians and consent come from the canonical identity modules; contact data is never copied or returned here.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt, blindIndex } from '../crypto.js';
import { requireConsent, guardianLink } from '../youth.js';
import { enqueue } from '../jobs.js';
import { orgFor } from '../org-access.js';
import {
  STAGES, STAFF, actFor, tell, lockProgramme, seatsFree, moveStage, checkEligibility, validateAnswers, sealAnswers, openAnswers,
  enrol, promoteWaitlist, waitlistPosition, nextWaitlistSeq, insertCharges, findPromo,
} from '../academy.js';
import { cancelUnpaidCharges } from '../academy-invoices.js';

const key = z.string().min(8).max(80).optional().describe('client-chosen key so a retry cannot create a duplicate');
const stale = () => conflict('This application was changed by someone else. Reload and try again.');
const versionOf = async (c, programme) => (await c.query('SELECT * FROM academy_programme_versions WHERE programme_id=$1 AND version=$2', [programme.id, programme.current_version])).rows[0];

async function programmeFor(c, programmeId, { forUpdate = false } = {}) {
  const p = forUpdate ? await lockProgramme(c, programmeId) : (await c.query('SELECT * FROM academy_programmes WHERE id=$1', [programmeId])).rows[0];
  if (!p || p.status !== 'published') throw notFound('Programme');
  const org = (await c.query("SELECT 1 FROM organisations WHERE id=$1 AND status='active'", [p.organisation_id])).rows.length;
  if (!org) throw conflict('This academy is not taking applications');
  return p;
}
/** Load an application for its applicant/athlete side or for the academy staff. 404 for everyone else. */
async function appFor(user, appId, { c, staff = false, lock = false } = {}) {
  const q = c ?? { query: async (s, a) => ({ rows: [await one(s, a)].filter(Boolean) }) };
  const a = (await q.query(`SELECT * FROM academy_applications WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [appId])).rows[0];
  if (!a) throw notFound('Application');
  if (staff) { const { org } = await orgFor(user, a.organisation_id, STAFF, { write: true, c }); return { a, org, staff: true }; }
  if (a.applicant_id === user.id || a.athlete_id === user.id) { await actFor(user, a.athlete_id, c); return { a, staff: false }; }
  if (await guardianLink(user.id, a.athlete_id, c)) return { a, staff: false };
  throw notFound('Application');
}
const clean = ({ answers_enc, assignee_id, next_action, next_action_on, tags, decision_reason, ...a }) => a;
const dupe = (e) => (e.code === '23505' && /academy_applications_live/.test(e.constraint ?? '') ? conflict('This athlete already has an open application for this programme') : e);

async function replay(c, user, k) {
  if (!k) return null;
  return (await c.query('SELECT * FROM academy_applications WHERE applicant_id=$1 AND idempotency_key=$2', [user.id, k])).rows[0] ?? null;
}

// ------------------------------------------------------------------ applying
cap({
  name: 'enquire_academy_programme', method: 'POST', path: '/academy/programmes/:id/applications', tag: 'Academy', status: 201,
  summary: 'Start an enquiry for a programme as an adult athlete or as the verified guardian of a child (athlete_id). One open application per athlete and programme; a repeat with the same idempotency_key returns the original.',
  input: z.object({ id, athlete_id: id.optional().describe('the athlete (default: you); a guardian passes their child'), idempotency_key: key }),
  handler: ({ user }, i) => tx(async (c) => {
    const athlete = i.athlete_id ?? user.id;
    const again = await replay(c, user, i.idempotency_key);
    if (again) return { ...clean(again), replayed: true };
    await actFor(user, athlete, c);
    const p = await programmeFor(c, i.id);
    const v = await versionOf(c, p);
    await checkEligibility(c, p, athlete, user.id);
    try {
      const a = (await c.query(
        'INSERT INTO academy_applications(organisation_id, programme_id, version_id, athlete_id, applicant_id, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [p.organisation_id, p.id, v?.id ?? null, athlete, user.id, i.idempotency_key ?? null])).rows[0];
      await c.query("INSERT INTO academy_application_events(application_id, to_stage, actor_id) VALUES ($1,'enquiry',$2)", [a.id, user.id]);
      await audit(c, user.id, 'enquire_academy_programme', 'academy_applications', a.id);
      return clean(a);
    } catch (e) { throw dupe(e); }
  }),
});

cap({
  name: 'request_academy_trial', method: 'POST', path: '/academy/applications/:id/trial', tag: 'Academy',
  summary: 'Ask for a trial (programmes that offer one). If the programme has a trial fee a payable charge is raised; staff book the trial once it is settled. The trial is scheduled in the academy timetable, not a separate calendar.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await appFor(user, i.id, { c, lock: true });
    if (a.row_version !== i.row_version) throw stale();
    const p = await programmeFor(c, a.programme_id);
    if (!p.trial_enabled) throw conflict('This programme does not offer a trial');
    const v = await versionOf(c, p);
    const row = await moveStage(c, a, 'trial_requested', { actor: user.id });
    if (v && Number(v.trial_fee_minor) > 0) await insertCharges(c, { applicationId: row.id, orgId: row.organisation_id, payerId: row.applicant_id, rows: [{ kind: 'trial', due_on: new Date().toISOString().slice(0, 10), currency: v.currency, gross_minor: Number(v.trial_fee_minor), discount_minor: 0, funded_minor: 0, tax_minor: 0, amount_minor: Number(v.trial_fee_minor), terms: { version: v.version } }] });
    await tell(c, row, 'trial_requested', 'Trial request received');
    return clean(row);
  }),
});

cap({
  name: 'advance_academy_trial', method: 'POST', path: '/academy/applications/:id/trial/advance', tag: 'Academy',
  summary: 'Staff: book the trial, then mark it completed (owner/admin). Booking waits for a trial fee to be paid or waived. Records who and why.',
  input: z.object({ id, row_version: z.number().int().min(1), step: z.enum(['book', 'complete']), note: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await appFor(user, i.id, { c, staff: true, lock: true });
    if (a.row_version !== i.row_version) throw stale();
    if (i.step === 'book' && (await c.query("SELECT 1 FROM academy_charges WHERE application_id=$1 AND kind='trial' AND status='awaiting_payment'", [a.id])).rows.length) throw conflict('The trial fee has not been paid yet');
    const row = await moveStage(c, a, i.step === 'book' ? 'trial_booked' : 'trial_completed', { actor: user.id, reason: i.note ?? null });
    await tell(c, row, i.step === 'book' ? 'trial_booked' : 'trial_completed', i.step === 'book' ? 'Your trial is booked' : 'Trial completed');
    return clean(row);
  }),
});

/** Place a submitted application according to the programme's admission mode. Programme row must be locked. */
async function place(c, app, p, actor) {
  const free = await seatsFree(c, p);
  const v = await versionOf(c, p);
  const hold = () => new Date(Date.now() + (v?.offer_valid_hours ?? 72) * 3600e3);
  if (p.admission_mode === 'waitlist_only' || free <= 0) {
    if (!p.waitlist_enabled || p.admission_mode === 'invite_only') throw conflict('This programme is full');
    const row = await moveStage(c, app, 'waitlisted', { actor, reason: free <= 0 ? 'Programme is full' : 'Waitlist only', set: { waitlist_seq: await nextWaitlistSeq(c) } });
    await tell(c, row, 'waitlisted', 'You are on the waitlist');
    return row;
  }
  if (p.admission_mode === 'direct') {
    let row = await moveStage(c, app, 'offered', { actor, reason: 'Direct enrolment', set: { offer_expires_at: hold() } });
    row = await moveStage(c, row, 'offer_accepted', { actor });
    const e = await enrol(c, row, { actor });
    row = await moveStage(c, row, 'enrolled', { actor });
    await tell(c, row, 'enrolled', 'Enrolment confirmed');
    return { ...row, enrolment_id: e.id };
  }
  const row = await moveStage(c, app, 'under_review', { actor });
  await tell(c, row, 'submitted', 'Application received');
  return row;
}

cap({
  name: 'submit_academy_application', method: 'POST', path: '/academy/applications/:id/submit', tag: 'Academy',
  summary: 'Save a draft or submit the application (athlete or verified guardian). Answers follow the programme\'s question schema; clinical data is never collected here. Direct-enrolment programmes enrol immediately (when agreements are acknowledged and consent is current), others go to review or the waitlist.',
  input: z.object({ id, row_version: z.number().int().min(1), answers: z.record(z.string(), z.any()).default({}), draft: z.boolean().default(false), promo_code: z.string().trim().min(3).max(24).optional().describe('a promo code of this academy; checked now, and the price shown with it is honoured at enrolment') }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a: cur } = await appFor(user, i.id, { c });
    const p = await programmeFor(c, cur.programme_id, { forUpdate: true });
    const { a } = await appFor(user, i.id, { c, lock: true });
    if (a.row_version !== i.row_version) throw stale();
    if (a.stage === 'application_draft' || ['enquiry', 'trial_completed'].includes(a.stage)) { /* ok */ } else throw conflict(`This application is already "${a.stage.replaceAll('_', ' ')}"`);
    const v = (await c.query('SELECT * FROM academy_programme_versions WHERE id=$1', [a.version_id])).rows[0] ?? await versionOf(c, p);
    const answers = validateAnswers(v?.questions ?? [], i.answers);
    const promo = await findPromo(c, { orgId: a.organisation_id, programmeId: a.programme_id, code: i.promo_code, userId: a.applicant_id, version: v, excludeApplicationId: a.id });
    const set = { answers_enc: sealAnswers(answers), version_id: v?.id ?? null, ...(promo ? { promo_discount_id: promo.id } : {}) };
    if (i.draft) {
      if (a.stage === 'application_draft') { const r = (await c.query('UPDATE academy_applications SET answers_enc=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *', [a.id, a.row_version, set.answers_enc])).rows[0]; if (!r) throw stale(); return clean(r); }
      return clean(await moveStage(c, a, 'application_draft', { actor: user.id, set }));
    }
    if (p.admission_mode === 'invite_only') throw forbidden('This programme is by invitation only');
    if (p.admission_mode === 'trial_then_enrol' && p.trial_enabled && a.stage !== 'trial_completed') throw conflict('Complete a trial before applying to this programme');
    await requireConsent(a.athlete_id, 'participation', 'applying to this programme');
    await checkEligibility(c, p, a.athlete_id, user.id);
    const submitted = await moveStage(c, a, 'submitted', { actor: user.id, set });
    const row = await place(c, submitted, p, user.id);
    await audit(c, user.id, 'submit_academy_application', 'academy_applications', a.id);
    return clean(row);
  }),
});

cap({
  name: 'invite_to_academy_programme', method: 'POST', path: '/academy/programmes/:id/invitations', tag: 'Academy', status: 201,
  summary: 'Invite a registered athlete (handle or email) to a programme and hold a place for them (owner/admin). They accept or decline the offer.',
  input: z.object({ id, person: z.string().min(2).max(200), cohort_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = await programmeFor(c, i.id, { forUpdate: true });
    await orgFor(user, p.organisation_id, STAFF, { write: true, c });
    const ref = i.person.trim();
    const u = (await c.query(ref.includes('@') ? 'SELECT id FROM users WHERE email_idx=$1' : 'SELECT id FROM users WHERE lower(handle)=lower($1)', [ref.includes('@') ? blindIndex(ref) : ref.replace(/^@/, '')])).rows[0];
    if (!u) throw notFound('Person');
    if (i.cohort_id && !(await c.query('SELECT 1 FROM org_cohorts WHERE id=$1 AND organisation_id=$2 AND status=$3', [i.cohort_id, p.organisation_id, 'active'])).rows.length) throw badRequest('That group is not part of this academy');
    if ((await seatsFree(c, p)) <= 0) throw conflict('No place is free. Add them to the waitlist by applying on their behalf, or raise the capacity.');
    const v = await versionOf(c, p);
    if (!v) throw conflict('Publish the programme terms first');
    let a;
    try {
      a = (await c.query("INSERT INTO academy_applications(organisation_id, programme_id, version_id, athlete_id, applicant_id, stage, offer_expires_at, cohort_id) VALUES ($1,$2,$3,$4,$4,'offered',$5,$6) RETURNING *",
        [p.organisation_id, p.id, v.id, u.id, new Date(Date.now() + v.offer_valid_hours * 3600e3), i.cohort_id ?? null])).rows[0];
    } catch (e) { throw dupe(e); }
    await c.query("INSERT INTO academy_application_events(application_id, to_stage, actor_id, reason) VALUES ($1,'offered',$2,'Invitation')", [a.id, user.id]);
    await tell(c, a, 'offer', 'You have been offered a place');
    return clean(a);
  }),
});

cap({
  name: 'decide_academy_application', method: 'POST', path: '/academy/applications/:id/decision', tag: 'Academy',
  summary: 'Staff decision on a submitted application (owner/admin): start review, offer a place (holds a seat for the offer window), waitlist or decline. Send row_version; a manual decision records the actor and reason.',
  input: z.object({ id, row_version: z.number().int().min(1), decision: z.enum(['review', 'offer', 'waitlist', 'decline']), reason: z.string().max(500).optional(), cohort_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a: cur } = await appFor(user, i.id, { c, staff: true });
    const p = await lockProgramme(c, cur.programme_id);
    const { a } = await appFor(user, i.id, { c, staff: true, lock: true });
    if (a.row_version !== i.row_version) throw stale();
    if (i.decision === 'decline' && !i.reason) throw badRequest('Give a reason for declining');
    if (i.cohort_id && !(await c.query('SELECT 1 FROM org_cohorts WHERE id=$1 AND organisation_id=$2 AND status=$3', [i.cohort_id, a.organisation_id, 'active'])).rows.length) throw badRequest('That group is not part of this academy');
    const v = await versionOf(c, p);
    let row;
    if (i.decision === 'review') row = await moveStage(c, a, 'under_review', { actor: user.id, reason: i.reason ?? null });
    else if (i.decision === 'decline') {
      row = await moveStage(c, a, 'declined', { actor: user.id, reason: i.reason, set: { decision_reason: i.reason, waitlist_seq: null } });
      await tell(c, row, 'declined', 'Update on your application');
      await promoteWaitlist(c, p, { actor: user.id });
    } else if (i.decision === 'waitlist') {
      if (!p.waitlist_enabled) throw conflict('This programme has no waitlist');
      row = await moveStage(c, a, 'waitlisted', { actor: user.id, reason: i.reason ?? null, set: { waitlist_seq: await nextWaitlistSeq(c) } });
      await tell(c, row, 'waitlisted', 'You are on the waitlist');
    } else {
      if ((await seatsFree(c, p)) <= 0 && a.stage !== 'waitlisted') throw conflict('No place is free. Waitlist this applicant or raise the capacity.');
      row = await moveStage(c, a, 'offered', { actor: user.id, reason: i.reason ?? null, set: { offer_expires_at: new Date(Date.now() + (v?.offer_valid_hours ?? 72) * 3600e3), cohort_id: i.cohort_id ?? a.cohort_id, waitlist_seq: null, version_id: a.version_id ?? v?.id ?? null } });
      await tell(c, row, 'offer', 'You have been offered a place');
    }
    await audit(c, user.id, 'decide_academy_application', 'academy_applications', a.id);
    return clean(row);
  }),
});

cap({
  name: 'respond_academy_offer', method: 'POST', path: '/academy/applications/:id/offer', tag: 'Academy',
  summary: 'Accept or decline an offered place (athlete or verified guardian). Accepting enrols at once under the terms of the version offered; it fails cleanly if the offer expired, an agreement is outstanding or consent lapsed.',
  input: z.object({ id, row_version: z.number().int().min(1), accept: z.boolean() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a: cur } = await appFor(user, i.id, { c });
    const p = await lockProgramme(c, cur.programme_id);
    const { a } = await appFor(user, i.id, { c, lock: true });
    if (a.row_version !== i.row_version) throw stale();
    if (a.stage !== 'offered') throw conflict('There is no open offer on this application');
    if (a.offer_expires_at && new Date(a.offer_expires_at) <= new Date()) {
      await moveStage(c, a, 'expired', { reason: 'Offer expired' });
      await promoteWaitlist(c, p);
      throw conflict('This offer has expired');
    }
    if (!i.accept) {
      const row = await moveStage(c, a, 'declined', { actor: user.id, reason: 'Offer declined' });
      await promoteWaitlist(c, p, { actor: user.id });
      return clean(row);
    }
    let row = await moveStage(c, a, 'offer_accepted', { actor: user.id });
    const e = await enrol(c, row, { actor: user.id });
    row = await moveStage(c, row, 'enrolled', { actor: user.id });
    await tell(c, row, 'enrolled', 'Enrolment confirmed');
    await audit(c, user.id, 'respond_academy_offer', 'academy_applications', a.id);
    return { ...clean(row), enrolment_id: e.id };
  }),
});

cap({
  name: 'withdraw_academy_application', method: 'POST', path: '/academy/applications/:id/withdraw', tag: 'Academy',
  summary: 'Withdraw an application (athlete or verified guardian). History is kept; a held place goes to the next person on the waitlist.',
  input: z.object({ id, row_version: z.number().int().min(1), reason: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a: cur } = await appFor(user, i.id, { c });
    const p = await lockProgramme(c, cur.programme_id);
    const { a } = await appFor(user, i.id, { c, lock: true });
    if (a.row_version !== i.row_version) throw stale();
    const row = await moveStage(c, a, 'withdrawn', { actor: user.id, reason: i.reason ?? null, set: { waitlist_seq: null } });
    await cancelUnpaidCharges(c, 'application_id=$1', [a.id]);
    await promoteWaitlist(c, p, { actor: user.id });
    return clean(row);
  }),
});

// ------------------------------------------------------------------ reading applications
cap({
  name: 'get_academy_application', method: 'GET', path: '/academy/applications/:id', tag: 'Academy',
  summary: 'One application with its lifecycle history. The applicant sees their own answers and waitlist position; staff also see CRM fields and internal notes (reading answers is audit-logged).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const staffRole = await (async () => { const a0 = await one('SELECT organisation_id FROM academy_applications WHERE id=$1', [i.id]); if (!a0) throw notFound('Application'); try { await orgFor(user, a0.organisation_id, STAFF); return true; } catch (e) { if (e.status === 404) return false; throw e; } })();
    const { a } = staffRole ? { a: await one('SELECT * FROM academy_applications WHERE id=$1', [i.id]) } : await appFor(user, i.id);
    const events = await many('SELECT from_stage, to_stage, actor_id, reason, created_at FROM academy_application_events WHERE application_id=$1 ORDER BY created_at, id', [a.id]);
    const base = { ...clean(a), answers: openAnswers(a.answers_enc), history: events, waitlist_position: await waitlistPosition({ query: async (s, p) => ({ rows: [await one(s, p)] }) }, a) };
    if (!staffRole) return base;
    await audit(null, user.id, 'read_pii', 'academy_applications', a.id);
    const notes = await many('SELECT n.id, n.author_id, n.body_enc, n.created_at FROM academy_notes n WHERE n.application_id=$1 ORDER BY n.created_at, n.id', [a.id]);
    return { ...base, assignee_id: a.assignee_id, assignee_name: a.assignee_id ? (await one('SELECT display_name FROM users WHERE id=$1', [a.assignee_id]))?.display_name ?? null : null, next_action: a.next_action, next_action_on: a.next_action_on, tags: a.tags, decision_reason: a.decision_reason,
      notes: notes.map(({ body_enc, ...n }) => ({ ...n, body: decrypt(body_enc, 'academy_notes.body') })),
      athlete: await one('SELECT id, handle, display_name FROM users WHERE id=$1', [a.athlete_id]), applicant: await one('SELECT id, handle, display_name FROM users WHERE id=$1', [a.applicant_id]) };
  },
});

cap({
  name: 'list_academy_applications', method: 'GET', path: '/organisations/:id/academy/applications', tag: 'Academy',
  summary: 'The admissions pipeline (owner/admin): filter by stage, programme, assignee or a name search. Names come from the athlete profile at read time; no contact details are returned.',
  input: z.object({ id, stage: z.enum(STAGES).optional(), programme_id: id.optional(), assignee_id: id.optional(), q: z.string().max(80).optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    return many(
      `SELECT a.id, a.stage, a.programme_id, p.title AS programme, p.sport, a.athlete_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, a.applicant_id, ap.display_name AS applicant_name, a.assignee_id, asg.display_name AS assignee_name,
              a.next_action, a.next_action_on, a.tags, a.offer_expires_at, a.waitlist_seq, a.row_version, a.created_at, a.updated_at,
              GREATEST(0, floor(extract(epoch FROM (now() - a.updated_at)) / 86400))::int AS days_in_stage,
              (a.applicant_id <> a.athlete_id) AS via_guardian,
              (SELECT count(*)::int FROM academy_charges ch WHERE (ch.application_id=a.id OR ch.enrolment_id IN (SELECT id FROM org_enrolments WHERE application_id=a.id)) AND ch.status='awaiting_payment') AS unpaid_charges,
              (SELECT count(*)::int FROM academy_notes n WHERE n.application_id=a.id) AS notes
         FROM academy_applications a JOIN academy_programmes p ON p.id=a.programme_id JOIN users u ON u.id=a.athlete_id JOIN users ap ON ap.id=a.applicant_id LEFT JOIN users asg ON asg.id=a.assignee_id
        WHERE a.organisation_id=$1 AND ($2::text IS NULL OR a.stage=$2) AND ($3::uuid IS NULL OR a.programme_id=$3) AND ($4::uuid IS NULL OR a.assignee_id=$4)
          AND ($5::text IS NULL OR u.display_name ILIKE '%'||$5||'%' OR u.handle ILIKE '%'||$5||'%')
        ORDER BY a.updated_at DESC, a.id LIMIT $6 OFFSET $7`, [i.id, i.stage ?? null, i.programme_id ?? null, i.assignee_id ?? null, i.q ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_academy_pipeline', method: 'GET', path: '/organisations/:id/pipeline', tag: 'Academy',
  summary: 'Counts per funnel stage, conversion rates, offers about to expire and renewals due in the next 30 days (owner/admin).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    const rows = await many('SELECT stage, count(*)::int AS n FROM academy_applications WHERE organisation_id=$1 GROUP BY stage', [i.id]);
    const n = (s) => rows.find((r) => r.stage === s)?.n ?? 0;
    const reached = (stages) => rows.filter((r) => stages.includes(r.stage)).reduce((t, r) => t + r.n, 0);
    const everEnq = (await one('SELECT count(DISTINCT application_id)::int AS n FROM academy_application_events e JOIN academy_applications a ON a.id=e.application_id WHERE a.organisation_id=$1 AND e.to_stage=$2', [i.id, 'enquiry'])).n;
    const ever = async (st) => (await one('SELECT count(DISTINCT application_id)::int AS n FROM academy_application_events e JOIN academy_applications a ON a.id=e.application_id WHERE a.organisation_id=$1 AND e.to_stage = ANY($2)', [i.id, st])).n;
    const stages = { enquiry: n('enquiry'), trial: n('trial_requested') + n('trial_booked') + n('trial_completed'), incomplete_application: n('application_draft'), awaiting_review: n('submitted') + n('under_review'), offered: n('offered') + n('offer_accepted'), waitlisted: n('waitlisted'), enrolled: n('enrolled') };
    const funnel = { enquiries: everEnq, trials: await ever(['trial_requested']), applications: await ever(['submitted']), offers: await ever(['offered']), enrolled: await ever(['enrolled']) };
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    return {
      stages, funnel, conversion: { enquiry_to_application: pct(funnel.applications, funnel.enquiries), application_to_offer: pct(funnel.offers, funnel.applications), offer_to_enrolled: pct(funnel.enrolled, funnel.offers) },
      expiring_offers: await many("SELECT id, programme_id, athlete_id, offer_expires_at FROM academy_applications WHERE organisation_id=$1 AND stage='offered' AND offer_expires_at < now() + interval '48 hours' ORDER BY offer_expires_at, id LIMIT 50", [i.id]),
      renewals_due: await many("SELECT e.id AS enrolment_id, e.user_id AS athlete_id, p.id AS programme_id, p.title, p.ends_on FROM org_enrolments e JOIN academy_programmes p ON p.id=e.programme_id WHERE p.organisation_id=$1 AND e.status='enrolled' AND p.ends_on BETWEEN current_date AND current_date + 30 ORDER BY p.ends_on, e.id LIMIT 100", [i.id]),
      recently_left: await many("SELECT e.id AS enrolment_id, e.user_id AS athlete_id, p.title, e.withdrawn_at, e.ended_reason FROM org_enrolments e JOIN academy_programmes p ON p.id=e.programme_id WHERE p.organisation_id=$1 AND e.status='withdrawn' AND e.withdrawn_at > now() - interval '30 days' ORDER BY e.withdrawn_at DESC, e.id LIMIT 50", [i.id]),
      incomplete_total: reached(['application_draft']),
    };
  },
});

// ------------------------------------------------------------------ CRM: ownership, tags, next action, notes
cap({
  name: 'update_academy_application_crm', method: 'PATCH', path: '/academy/applications/:id/crm', tag: 'Academy',
  summary: 'Assign an owner, set tags and a next action/reminder date on an application (owner/admin). Academy-operations metadata only; no contact data.',
  input: z.object({ id, assignee_id: id.nullable().optional(), tags: z.array(z.string().min(1).max(30)).max(10).optional(), next_action: z.string().max(200).nullable().optional(), next_action_on: z.string().date().nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await appFor(user, i.id, { c, staff: true, lock: true });
    if (i.assignee_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin','coach')", [a.organisation_id, i.assignee_id])).rows.length) throw badRequest('The assignee must be active staff');
    const r = (await c.query(
      `UPDATE academy_applications SET assignee_id = CASE WHEN $2::boolean THEN $3 ELSE assignee_id END, tags = coalesce($4, tags), next_action = CASE WHEN $5::boolean THEN $6 ELSE next_action END,
              next_action_on = CASE WHEN $7::boolean THEN $8 ELSE next_action_on END, updated_at=now() WHERE id=$1 RETURNING *`,
      [a.id, i.assignee_id !== undefined, i.assignee_id ?? null, i.tags, i.next_action !== undefined, i.next_action ?? null, i.next_action_on !== undefined, i.next_action_on ?? null])).rows[0];
    return clean(r);
  }),
});

cap({
  name: 'add_academy_note', method: 'POST', path: '/academy/applications/:id/notes', tag: 'Academy', status: 201,
  summary: 'Add an internal note to an application (owner/admin). Notes are encrypted, show their author, and are never visible to the athlete or guardian or in notifications.',
  input: z.object({ id, body: z.string().min(1).max(2000) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { a } = await appFor(user, i.id, { c, staff: true });
    const n = (await c.query('INSERT INTO academy_notes(organisation_id, application_id, author_id, body_enc) VALUES ($1,$2,$3,$4) RETURNING id, author_id, created_at', [a.organisation_id, a.id, user.id, encrypt(i.body, 'academy_notes.body')])).rows[0];
    return n;
  }),
});

// ------------------------------------------------------------------ enrolment lifecycle (org_enrolments stays the single enrolment table)
async function enrolmentFor(user, enrId, { c, staff = true } = {}) {
  const e = (await c.query('SELECT e.*, k.organisation_id, k.programme_id AS cohort_programme FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1 FOR UPDATE OF e', [enrId])).rows[0];
  if (!e) throw notFound('Enrolment');
  if (staff) { await orgFor(user, e.organisation_id, STAFF, { write: true, c }); return e; }
  if (e.user_id !== user.id && !(await guardianLink(user.id, e.user_id, c))) throw notFound('Enrolment');
  if (e.user_id === user.id) await actFor(user, e.user_id, c);
  return e;
}
async function endEnrolment(c, e, status, reason) {
  const r = (await c.query(`UPDATE org_enrolments SET status=$2, ended_reason=$3, withdrawn_at = CASE WHEN $2='withdrawn' THEN now() ELSE withdrawn_at END WHERE id=$1 RETURNING *`, [e.id, status, reason ?? null])).rows[0];
  // leaving cancels what is not yet due or paid; finishing or graduating forgives nothing: what is owed stays owed
  if (status === 'withdrawn') await cancelUnpaidCharges(c, 'enrolment_id=$1', [e.id]);
  // the pack or subscription that belonged to the enrolment ends with it (a finished or graduated one simply stops renewing)
  await c.query(status === 'withdrawn' ? "UPDATE user_plans SET status='cancelled', auto_renew=false WHERE enrolment_id=$1 AND status IN ('awaiting_payment','active')" : 'UPDATE user_plans SET auto_renew=false WHERE enrolment_id=$1', [e.id]);
  if (e.programme_id) await promoteWaitlist(c, await lockProgramme(c, e.programme_id));
  return r;
}

cap({
  name: 'set_academy_enrolment_status', method: 'POST', path: '/academy-enrolments/:id/status', tag: 'Academy',
  summary: 'Change an enrolment (owner/admin): pause (a non-clinical hold, no health details), resume, complete, graduate or withdraw, with a reason. Unpaid charges are cancelled on withdrawal; paid ones are refunded through the payments flow, never silently.',
  input: z.object({ id, status: z.enum(['paused', 'enrolled', 'completed', 'graduated', 'withdrawn']), reason: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const e = await enrolmentFor(user, i.id, { c });
    if (e.status === i.status) return e;
    if (['withdrawn', 'transferred', 'completed', 'graduated'].includes(e.status)) throw conflict('This enrolment has ended. Start a new enrolment instead.');
    if (i.status === 'enrolled' && e.status === 'paused' && e.programme_id) await lockProgramme(c, e.programme_id);
    const r = ['paused', 'enrolled'].includes(i.status)
      ? (await c.query('UPDATE org_enrolments SET status=$2, ended_reason=$3 WHERE id=$1 RETURNING *', [e.id, i.status, i.status === 'paused' ? (i.reason ?? null) : null])).rows[0]
      : await endEnrolment(c, e, i.status, i.reason);
    await audit(c, user.id, 'set_academy_enrolment_status', 'org_enrolments', e.id);
    return r;
  }),
});

cap({
  name: 'withdraw_my_academy_enrolment', method: 'POST', path: '/academy-enrolments/:id/withdraw', tag: 'Academy',
  summary: 'Withdraw from a programme (the athlete or their verified guardian). Unpaid charges are cancelled and the place is offered to the waitlist; paid fees follow the refund policy via the academy.',
  input: z.object({ id, reason: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const e = await enrolmentFor(user, i.id, { c, staff: false });
    if (e.status === 'withdrawn') return e;
    return endEnrolment(c, e, 'withdrawn', i.reason ?? 'Withdrawn by athlete or guardian');
  }),
});

cap({
  name: 'transfer_academy_enrolment', method: 'POST', path: '/academy-enrolments/:id/transfer', tag: 'Academy', status: 201,
  summary: 'Move an athlete to another group of the same programme (owner/admin). The old enrolment is kept as "transferred" and the new one links back to it; the group\'s capacity is enforced.',
  input: z.object({ id, to_cohort_id: id, reason: z.string().max(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const e = await enrolmentFor(user, i.id, { c });
    if (e.status !== 'enrolled' && e.status !== 'paused') throw conflict('Only a current enrolment can be transferred');
    const to = (await c.query('SELECT * FROM org_cohorts WHERE id=$1 FOR UPDATE', [i.to_cohort_id])).rows[0];
    if (!to || to.organisation_id !== e.organisation_id || to.status !== 'active') throw badRequest('Choose an active group of this academy');
    if (to.programme_id !== e.programme_id) throw badRequest('Transfers stay within one programme; start a new application for a different programme');
    if (to.capacity != null && (await c.query("SELECT count(*)::int AS n FROM org_enrolments WHERE cohort_id=$1 AND status IN ('enrolled','paused')", [to.id])).rows[0].n >= to.capacity) throw conflict('That group is full');
    await c.query("UPDATE org_enrolments SET status='transferred', ended_reason=$2 WHERE id=$1", [e.id, i.reason ?? 'Transferred']);
    const n = (await c.query(
      `INSERT INTO org_enrolments(cohort_id, user_id, consent_at, enrolled_by, programme_id, version_id, application_id, sessions_left, renewed_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (cohort_id, user_id) DO UPDATE SET status='enrolled', ended_reason=NULL, withdrawn_at=NULL, renewed_from=$9, enrolled_by=$4 RETURNING *`,
      [to.id, e.user_id, e.consent_at, user.id, e.programme_id, e.version_id, e.application_id, e.sessions_left, e.id])).rows[0];
    await c.query('UPDATE academy_charges SET enrolment_id=$2 WHERE enrolment_id=$1 AND status=$3', [e.id, n.id, 'awaiting_payment']);
    await c.query('UPDATE user_plans SET enrolment_id=$2 WHERE enrolment_id=$1', [e.id, n.id]);
    await audit(c, user.id, 'transfer_academy_enrolment', 'org_enrolments', e.id);
    return n;
  }),
});

// ------------------------------------------------------------------ announcements (shared notification outbox, never a synchronous loop)
cap({
  name: 'announce_to_academy', method: 'POST', path: '/organisations/:id/announcements', tag: 'Academy', status: 202,
  summary: 'Send an announcement to the people in a programme or funnel stage (owner/admin). dry_run counts the audience. Delivery is queued on the shared outbox; recipients are resolved guardian-vs-athlete at send time, de-duplicated, and the message deep-links to the academy.',
  input: z.object({ id, programme_id: id.optional(), stages: z.array(z.enum(STAGES)).max(15).default(['enrolled']), title: z.string().min(2).max(100), body: z.string().min(1).max(500), dry_run: z.boolean().default(false), idempotency_key: key }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    if (i.programme_id && !(await c.query('SELECT 1 FROM academy_programmes WHERE id=$1 AND organisation_id=$2', [i.programme_id, i.id])).rows.length) throw badRequest('That programme is not part of this academy');
    const audience = (await c.query('SELECT count(*)::int AS n FROM academy_applications WHERE organisation_id=$1 AND stage = ANY($2) AND ($3::uuid IS NULL OR programme_id=$3)', [i.id, i.stages, i.programme_id ?? null])).rows[0].n;
    if (i.dry_run) return { audience };
    if (!audience) throw conflict('No one matches that audience');
    const dedupeKey = i.idempotency_key ? `announce:${i.id}:${i.idempotency_key}` : null;
    if (dedupeKey && (await c.query("SELECT 1 FROM jobs WHERE kind='academy.announce' AND dedupe_key=$1", [dedupeKey])).rows.length) return { queued: true, audience, replayed: true };
    const rec = (await c.query('INSERT INTO academy_announcements(organisation_id, programme_id, stages, title, body, audience, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [i.id, i.programme_id ?? null, i.stages, i.title, i.body, audience, user.id])).rows[0];
    await enqueue(c, { category: 'academy', kind: 'academy.announce', payload: { announcement_id: rec.id, organisation_id: i.id, programme_id: i.programme_id ?? null, stages: i.stages, title: i.title, body: i.body, by: user.id }, dedupeKey });
    await audit(c, user.id, 'announce_to_academy', 'organisations', i.id);
    return { queued: true, audience };
  }),
});

