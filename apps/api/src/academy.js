// Academy OS: the rules shared by every academy capability (REST, OpenAPI and MCP all go through them).
// Athletes, guardians, consent, money and notifications stay in their canonical modules; this file only decides
// admissions stages, seats, charges and who is told.
import { z } from 'zod';
import { audit, isAdmin } from './helpers.js';
import { conflict, forbidden, notFound, unprocessable } from './errors.js';
import { guardianLink, guardiansOf, isYouth, requireConsent, ageOf } from './youth.js';
import { decrypt, encrypt } from './crypto.js';
import { notify } from './notify.js';
import { addMonths } from './sponsor-schedule.js';
import { allocate } from './settlement.js';

/** A boolean that also arrives as the text "true"/"false" in a query string (z.coerce.boolean would read "false" as true). */
export const flag = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
export const STAGES = ['enquiry', 'trial_requested', 'trial_booked', 'trial_completed', 'application_draft', 'submitted', 'under_review', 'offered', 'waitlisted', 'declined', 'offer_accepted', 'enrolled', 'withdrawn', 'expired', 'cancelled'];
export const TERMINAL = ['enrolled', 'declined', 'withdrawn', 'expired', 'cancelled'];
const HOLD_SEAT = ['offered', 'offer_accepted'];
export const STAFF = ['owner', 'admin'];
/** Sessions left for an enrolment `e`: held by the shared plan engine (a pack is a pass), the old enrolment column only for rows from before. */
export const SESSIONS_SQL = "coalesce((SELECT up.sessions_left FROM user_plans up WHERE up.enrolment_id=e.id AND up.kind='pass' AND up.status IN ('active','awaiting_payment','used_up') ORDER BY up.created_at DESC LIMIT 1), e.sessions_left)";
/** The live invoice (open or paid) of a charge `ch`. */
export const INVOICE_NO_SQL = "(SELECT i.number FROM invoices i WHERE i.academy_charge_id=ch.id AND i.kind='invoice' AND i.status IN ('open','paid') LIMIT 1)";
export const INVOICE_SQL = "(SELECT i.id FROM invoices i WHERE i.academy_charge_id=ch.id AND i.kind='invoice' AND i.status IN ('open','paid') LIMIT 1)";
export const STAFF_MONEY = ['owner', 'admin', 'finance'];

/** Allowed moves. The server decides; clients only ask. */
export const NEXT = {
  enquiry: ['trial_requested', 'application_draft', 'submitted', 'withdrawn', 'cancelled'],
  trial_requested: ['trial_booked', 'trial_completed', 'withdrawn', 'cancelled'],
  trial_booked: ['trial_completed', 'trial_requested', 'withdrawn', 'cancelled'],
  trial_completed: ['application_draft', 'submitted', 'trial_requested', 'withdrawn'],
  application_draft: ['submitted', 'withdrawn', 'cancelled'],
  submitted: ['under_review', 'offered', 'waitlisted', 'declined', 'withdrawn'],
  under_review: ['offered', 'waitlisted', 'declined', 'withdrawn'],
  waitlisted: ['offered', 'declined', 'withdrawn'],
  offered: ['offer_accepted', 'declined', 'expired', 'withdrawn'],
  offer_accepted: ['enrolled', 'withdrawn'],
};

export const questionShape = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(2).max(160),
  type: z.enum(['text', 'longtext', 'number', 'yesno', 'choice', 'date']),
  options: z.array(z.string().min(1).max(80)).max(20).optional(),
  required: z.boolean().default(false),
});
export const questionsShape = z.array(questionShape).max(25);

/** Validate answers against a safe question schema (data only, never executable). Clinical questions are refused. */
const CLINICAL = /\b(diagnos|medical|medication|allerg|injur|condition|illness|disabilit|therapy)/i;
export function checkQuestions(questions) {
  for (const q of questions) if (CLINICAL.test(q.label) || CLINICAL.test(q.key)) throw unprocessable('Admissions questions cannot collect health information. Health details stay in the Health area under guardian consent.');
}
export function validateAnswers(questions, answers = {}) {
  const out = {};
  for (const q of questions) {
    const v = answers[q.key];
    const empty = v === undefined || v === null || v === '';
    if (empty) { if (q.required) throw unprocessable(`Please answer: ${q.label}`); continue; }
    if (q.type === 'number' && typeof v !== 'number') throw unprocessable(`"${q.label}" needs a number`);
    if (q.type === 'yesno' && typeof v !== 'boolean') throw unprocessable(`"${q.label}" needs yes or no`);
    if (q.type === 'choice' && !(q.options ?? []).includes(v)) throw unprocessable(`"${q.label}" needs one of the listed choices`);
    if (['text', 'longtext', 'date'].includes(q.type) && (typeof v !== 'string' || v.length > 2000)) throw unprocessable(`"${q.label}" needs text under 2000 characters`);
    out[q.key] = v;
  }
  return out;
}
export const sealAnswers = (a) => encrypt(JSON.stringify(a ?? {}), 'academy_applications.answers');
export const openAnswers = (s) => (s ? JSON.parse(decrypt(s, 'academy_applications.answers')) : {});

/**
 * The adult who may act for `athleteId`: the athlete if an adult, otherwise a currently verified guardian.
 * Checked on every call, so revoking a guardian link takes effect immediately.
 */
export async function actFor(user, athleteId, c) {
  if (user.id === athleteId) {
    if (await isYouth(athleteId, c)) throw forbidden('Young people are enrolled by a verified guardian. Ask your guardian to apply for you.');
    return { self: true };
  }
  if (isAdmin(user)) return { admin: true };
  if (!(await guardianLink(user.id, athleteId, c))) throw forbidden('You are not a verified guardian of this young person');
  return { guardian: true };
}

/** People who may be told about an athlete's application: the applicant, the athlete if an adult, guardians if a youth. De-duplicated. */
export async function recipients(c, app) {
  const set = new Set([app.applicant_id]);
  if (await isYouth(app.athlete_id, c)) for (const g of await guardiansOf(app.athlete_id, c)) set.add(g);
  else set.add(app.athlete_id);
  return [...set];
}
/** Generic wording on purpose: no names, fees or youth details in a lock-screen or email preview. Every message deep-links to the source. */
export async function tell(c, app, kind, title) {
  for (const uid of await recipients(c, app)) {
    await notify(c, uid, { kind: `academy_${kind}`, title, body: 'Open Gotmygame to see the details.', data: { organisation_id: app.organisation_id, application_id: app.id, programme_id: app.programme_id }, dedupe_key: `academy:${kind}:${app.id}:${app.row_version ?? 0}:${uid}` });
  }
}

export async function lockProgramme(c, id) {
  const p = (await c.query('SELECT * FROM academy_programmes WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!p) throw notFound('Programme');
  return p;
}
/** Seats taken = live enrolments + places held by an unexpired offer. Call with the programme row locked. */
export async function seatsTaken(c, programmeId) {
  const r = (await c.query(
    `SELECT (SELECT count(*)::int FROM org_enrolments WHERE programme_id=$1 AND status IN ('enrolled','paused')) +
            (SELECT count(*)::int FROM academy_applications WHERE programme_id=$1 AND stage = ANY($2) AND (offer_expires_at IS NULL OR offer_expires_at > now())) AS n`, [programmeId, HOLD_SEAT])).rows[0];
  return r.n;
}
export const seatsFree = async (c, p) => (p.capacity == null ? Infinity : p.capacity - (await seatsTaken(c, p.id)));

/** Move an application one step, record who/why, bump the version. Rejects moves the lifecycle does not allow. */
export async function moveStage(c, app, to, { actor = null, reason = null, set = {} } = {}) {
  if (!(NEXT[app.stage] ?? []).includes(to)) throw conflict(`An application in "${app.stage.replaceAll('_', ' ')}" cannot move to "${to.replaceAll('_', ' ')}"`);
  const cols = { stage: to, ...set };
  const keys = Object.keys(cols);
  const row = (await c.query(
    `UPDATE academy_applications SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(', ')}, row_version=row_version+1, updated_at=now() WHERE id=$1 AND row_version=$2 RETURNING *`,
    [app.id, app.row_version, ...keys.map((k) => cols[k])])).rows[0];
  if (!row) throw conflict('This application was changed by someone else. Reload and try again.');
  await c.query('INSERT INTO academy_application_events(application_id, from_stage, to_stage, actor_id, reason) VALUES ($1,$2,$3,$4,$5)', [app.id, app.stage, to, actor, reason]);
  return row;
}

/** Age in years from the encrypted date of birth. The decryption is audit-logged. null when no date of birth is stored. */
export async function athleteAge(c, athleteId, actorId) {
  const u = (await c.query('SELECT dob_enc FROM users WHERE id=$1', [athleteId])).rows[0];
  if (!u?.dob_enc) return null;
  await audit(c, actorId, 'read_pii', 'users', athleteId);
  return ageOf(decrypt(u.dob_enc, 'users.dob'));
}
export async function checkEligibility(c, programme, athleteId, actorId) {
  if (programme.age_min != null || programme.age_max != null) {
    const age = await athleteAge(c, athleteId, actorId);
    if (age == null) throw unprocessable('Add a date of birth to the athlete profile so eligibility can be checked');
    if (programme.age_min != null && age < programme.age_min) throw unprocessable(`This programme is for ages ${programme.age_min}${programme.age_max != null ? `–${programme.age_max}` : '+'}`);
    if (programme.age_max != null && age > programme.age_max) throw unprocessable(`This programme is for ages ${programme.age_min ?? 0}–${programme.age_max}`);
  }
  if (programme.prerequisite_ids?.length) {
    const done = (await c.query("SELECT DISTINCT programme_id FROM org_enrolments WHERE user_id=$1 AND programme_id = ANY($2) AND status IN ('completed','graduated')", [athleteId, programme.prerequisite_ids])).rows.length;
    if (done < programme.prerequisite_ids.length) throw unprocessable('A prerequisite programme has not been completed yet');
  }
}

/** Policy versions the athlete still has to acknowledge for these required versions (re-consent only when a newer version demands it). */
export async function outstandingPolicies(c, athleteId, policyVersionIds) {
  if (!policyVersionIds?.length) return [];
  const rows = (await c.query(
    `SELECT p.id AS policy_id, p.title, p.kind, lv.id AS version_id, lv.version,
            EXISTS (SELECT 1 FROM org_acknowledgements a JOIN org_policy_versions av ON av.id=a.policy_version_id
                     WHERE a.subject_id=$2 AND av.policy_id=p.id
                       AND (av.version = lv.version OR (av.version < lv.version AND NOT EXISTS (SELECT 1 FROM org_policy_versions nv WHERE nv.policy_id=p.id AND nv.version > av.version AND nv.requires_reconsent)))) AS ok
       FROM org_policy_versions rv JOIN org_policies p ON p.id=rv.policy_id
       JOIN org_policy_versions lv ON lv.policy_id=p.id AND lv.version = p.current_version
      WHERE rv.id = ANY($1) ORDER BY p.title, p.id`, [policyVersionIds, athleteId])).rows;
  return rows.filter((r) => !r.ok).map(({ ok, ...r }) => r);
}

const tax = (amount, bp) => Math.round((amount * bp) / (10000 + bp)); // the price already contains its tax

/**
 * The promo code an applicant entered, if it is usable today. Promo codes are rows of the shared discounts framework owned by the organisation
 * (optionally one programme): percent or fixed, validity window, total and per-person limits. Limits count redemptions plus other open
 * applications that already hold the code, so two people cannot both take the last use. Errors never say whether a code exists.
 */
export async function findPromo(c, { orgId, programmeId, code, userId, version, excludeApplicationId = null }) {
  const bad = () => unprocessable('That promo code is not valid for this programme');
  if (!code) return null;
  if (!version || version.billing_model === 'free') throw bad();
  const d = (await c.query('SELECT * FROM discounts WHERE organisation_id=$1 AND active AND upper(code)=upper($2) FOR UPDATE', [orgId, code.trim()])).rows[0];
  if (!d) throw bad();
  if (d.programme_id && d.programme_id !== programmeId) throw bad();
  const today = new Date().toISOString().slice(0, 10);
  if ((d.valid_from && String(d.valid_from).slice(0, 10) > today) || (d.valid_to && String(d.valid_to).slice(0, 10) < today)) throw bad();
  if (d.kind === 'fixed' && d.currency !== version.currency) throw bad();
  const held = `SELECT count(*)::int FROM academy_applications a WHERE a.promo_discount_id=d.id AND a.stage NOT IN ('declined','withdrawn','expired','cancelled','enrolled') AND ($2::uuid IS NULL OR a.id <> $2)`;
  const used = (await c.query(`SELECT (SELECT count(*)::int FROM discount_redemptions x WHERE x.discount_id=d.id) + (${held}) AS n,
                                      (SELECT count(*)::int FROM discount_redemptions x WHERE x.discount_id=d.id AND x.user_id=$3) + (${held} AND a.applicant_id=$3) AS mine
                                 FROM discounts d WHERE d.id=$1`, [d.id, excludeApplicationId, userId])).rows[0];
  if ((d.max_redemptions && used.n >= d.max_redemptions) || (d.per_user_limit && used.mine >= d.per_user_limit)) throw bad();
  return d;
}

/**
 * Build the charges for an enrolment from the version the applicant accepted (price, discount, tax and terms are snapshotted into
 * each row, so later programme edits never touch them). One discount applies: the best of sibling, second-programme and a promo code.
 */
export function planCharges(v, { today, sibling, multi, promo = null }) {
  const rows = [];
  const fee = Number(v.fee_minor);
  const autoBp = Math.max(sibling ? v.sibling_discount_bp : 0, multi ? v.multi_programme_discount_bp : 0);
  const autoD = Math.round((fee * autoBp) / 10000);
  const promoD = promo ? (promo.kind === 'percent' ? Math.round((fee * promo.value) / 100) : Math.min(promo.value, fee)) : 0;
  const usePromo = promoD > autoD;
  const D = Math.min(fee, usePromo ? promoD : autoD);
  const reason = usePromo ? 'promo' : sibling && autoBp === v.sibling_discount_bp ? 'sibling' : 'multi_programme';
  const base = { programme_id: v.programme_id, version: v.version, billing_model: v.billing_model, renewal_terms: v.renewal_terms ?? null, tax_rate_bp: v.tax_rate_bp };
  const why = D > 0 ? { discount_reason: reason, ...(usePromo ? { promo: { id: promo.id, code: promo.code } } : { discount_bp: autoBp }) } : {};
  const row = (kind, gross, discount, due, extra = {}) => {
    const amount = gross - discount;
    return { kind, due_on: due, currency: v.currency, gross_minor: gross, discount_minor: discount, funded_minor: 0, tax_minor: tax(amount, v.tax_rate_bp), amount_minor: amount, terms: { ...base, ...extra } };
  };
  if (Number(v.registration_fee_minor) > 0) rows.push(row('registration', Number(v.registration_fee_minor), 0, today));
  if (fee > 0 && (v.billing_model === 'pack' || v.billing_model === 'one_time' || (v.billing_model === 'term' && v.instalments === 1))) rows.push(row(v.billing_model === 'pack' ? 'pack' : 'tuition', fee, D, today, why));
  else if (fee > 0 && v.billing_model === 'monthly') rows.push(row('instalment', fee, D, today, { ...why, discount_bp_recurring: usePromo ? 0 : autoBp })); // a sibling discount lasts for every month, a promo code only the first
  else if (fee > 0 && v.billing_model === 'term') {
    const dep = Math.min(Number(v.deposit_minor), fee);
    const rest = fee - dep;
    const disc = Math.min(rest, D);                                   // the discount comes off the instalments, never the deposit
    const gross = allocate(rest, Array.from({ length: v.instalments }, () => 1));
    const off = allocate(disc, gross);
    if (dep > 0) rows.push(row('deposit', dep, 0, today));
    gross.forEach((g, n) => { if (g > 0) rows.push(row('instalment', g, off[n], addMonths(today, n + (dep > 0 ? 1 : 0)), { instalment_of: v.instalments, ...(off[n] ? why : {}) })); });
  }
  return rows;
}

export async function insertCharges(c, { enrolmentId = null, applicationId = null, orgId, payerId, rows, seqStart = 0 }) {
  const { syncChargeInvoice } = await import('./academy-invoices.js');
  const out = [];
  for (const [n, r] of rows.entries()) {
    const ch = (await c.query(
      `INSERT INTO academy_charges(enrolment_id, application_id, organisation_id, payer_id, seq, kind, due_on, currency, gross_minor, discount_minor, funded_minor, tax_minor, amount_minor, terms, status, user_plan_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [enrolmentId, applicationId, orgId, payerId, seqStart + n, r.kind, r.due_on, r.currency, r.gross_minor, r.discount_minor, r.funded_minor, r.tax_minor, r.amount_minor, JSON.stringify(r.terms), r.amount_minor === 0 ? 'waived' : 'awaiting_payment', r.user_plan_id ?? null])).rows[0];
    await syncChargeInvoice(c, ch.id);                 // every fee that needs paying gets its numbered invoice
    out.push(ch);
  }
  return out;
}

/** The next period of an academy subscription (raised by the shared plan renewal a week early): its charge, at the plan's current price. */
export async function raiseRenewalCharge(c, up, planId) {
  const prev = (await c.query('SELECT * FROM academy_charges WHERE user_plan_id=$1 ORDER BY seq DESC LIMIT 1', [up.id])).rows[0];
  if (!prev) return null;
  const bp = Number(prev.terms?.discount_bp_recurring ?? 0);
  const gross = Number(up.new_price), discount = Math.round((gross * bp) / 10000);
  const seq = (await c.query('SELECT coalesce(max(seq), -1) + 1 AS n FROM academy_charges WHERE enrolment_id=$1', [up.enrolment_id])).rows[0].n;
  const rate = Number(prev.terms?.tax_rate_bp ?? 0);
  const { discount_bp_recurring, discount_reason, discount_bp, promo, ...keep } = prev.terms ?? {};
  void discount_bp_recurring; void promo; void discount_bp; void discount_reason;
  return insertCharges(c, { enrolmentId: up.enrolment_id, orgId: up.organisation_id, payerId: up.user_id, seqStart: seq, rows: [{
    kind: 'instalment', due_on: new Date(up.expires_at).toISOString().slice(0, 10), currency: up.currency, gross_minor: gross, discount_minor: discount, funded_minor: 0, tax_minor: tax(gross - discount, rate), amount_minor: gross - discount,
    terms: { ...keep, ...(bp ? { discount_bp: bp, discount_reason: prev.terms.discount_reason, discount_bp_recurring: bp } : { discount_bp_recurring: 0 }) }, user_plan_id: planId }] });
}

/** Turn an accepted offer into an enrolment (seat is already reserved by the offer). Idempotent per application. */
export async function enrol(c, app, { actor }) {
  const programme = (await c.query('SELECT * FROM academy_programmes WHERE id=$1', [app.programme_id])).rows[0];
  await requireConsent(app.athlete_id, 'participation', 'joining this programme', c);
  const v = (await c.query('SELECT * FROM academy_programme_versions WHERE id=$1', [app.version_id])).rows[0];
  const missing = await outstandingPolicies(c, app.athlete_id, v.policy_version_ids);
  if (missing.length) throw conflict('Required agreements have not been acknowledged yet', { code: 'agreements_required', policies: missing });
  const cohortId = app.cohort_id ?? await defaultCohort(c, programme);
  const cohort = (await c.query('SELECT * FROM org_cohorts WHERE id=$1 FOR UPDATE', [cohortId])).rows[0];
  if (cohort.capacity != null) {
    const n = (await c.query("SELECT count(*)::int AS n FROM org_enrolments WHERE cohort_id=$1 AND status IN ('enrolled','paused')", [cohortId])).rows[0].n;
    if (n >= cohort.capacity) throw conflict('This group is full');
  }
  const e = (await c.query(
    `INSERT INTO org_enrolments(cohort_id, user_id, consent_at, enrolled_by, programme_id, version_id, application_id)
     VALUES ($1,$2,now(),$3,$4,$5,$6)
     ON CONFLICT (cohort_id, user_id) DO UPDATE SET status='enrolled', consent_at=now(), enrolled_by=$3, withdrawn_at=NULL, ended_reason=NULL, programme_id=$4, version_id=$5, application_id=$6
       WHERE org_enrolments.status IN ('withdrawn','transferred','completed','graduated') RETURNING *`,
    [cohortId, app.athlete_id, actor, app.programme_id, app.version_id, app.id])).rows[0];
  if (!e) throw conflict('This athlete is already in that group');
  const today = new Date().toISOString().slice(0, 10);
  const orgId = programme.organisation_id;
  const sibling = (await c.query(
    "SELECT 1 FROM org_enrolments e JOIN academy_charges ch ON ch.enrolment_id=e.id WHERE ch.payer_id=$1 AND ch.organisation_id=$2 AND e.user_id<>$3 AND e.status IN ('enrolled','paused') LIMIT 1", [app.applicant_id, orgId, app.athlete_id])).rows.length > 0;
  const multi = (await c.query("SELECT 1 FROM org_enrolments WHERE user_id=$1 AND programme_id<>$2 AND status IN ('enrolled','paused') AND programme_id IN (SELECT id FROM academy_programmes WHERE organisation_id=$3) LIMIT 1", [app.athlete_id, app.programme_id, orgId])).rows.length > 0;
  const promo = app.promo_discount_id ? (await c.query('SELECT * FROM discounts WHERE id=$1', [app.promo_discount_id])).rows[0] ?? null : null;   // the price shown at application is the price honoured
  // charges raised before enrolment (trial fee) stay as they are; the enrolment's own start here
  const rows = Number(v.fee_minor) + Number(v.registration_fee_minor) > 0 ? planCharges(v, { today, sibling, multi, promo }) : [];
  // a pack or a monthly fee is an entitlement with a period, sessions and renewals: the shared plan engine holds it, the charge below pays for it
  if (v.plan_id && ['pack', 'monthly'].includes(v.billing_model)) {
    const plan = (await c.query('SELECT * FROM venue_plans WHERE id=$1', [v.plan_id])).rows[0];
    const up = (await c.query(
      `INSERT INTO user_plans(plan_id, organisation_id, enrolment_id, user_id, kind, name, price_cents, currency, discount_bp, sessions_total, sessions_left, session_value_cents, duration_days, duration_months, resource_ids, includes, auto_renew)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [plan.id, orgId, e.id, app.applicant_id, plan.kind, `${programme.title}`, Number(v.fee_minor), plan.currency, plan.sessions, plan.session_value_cents, plan.duration_days ?? plan.valid_days, plan.duration_months, plan.resource_ids, plan.includes, plan.auto_renew])).rows[0];
    const first = rows.find((r) => r.kind === 'pack' || r.kind === 'instalment');
    if (first) first.user_plan_id = up.id;
  }
  const made = await insertCharges(c, { enrolmentId: e.id, orgId, payerId: app.applicant_id, rows });
  const given = made.filter((m) => m.terms?.promo?.id === promo?.id && Number(m.discount_minor) > 0).reduce((t, m) => t + Number(m.discount_minor), 0);
  if (promo && given > 0) await c.query('INSERT INTO discount_redemptions(discount_id, enrolment_id, user_id, amount_cents) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [promo.id, e.id, app.applicant_id, given]);
  return e;
}
async function defaultCohort(c, programme) {
  const have = (await c.query('SELECT id FROM org_cohorts WHERE programme_id=$1 AND status=$2 ORDER BY created_at, id LIMIT 1', [programme.id, 'active'])).rows[0];
  if (have) return have.id;
  const name = (await c.query('SELECT 1 FROM org_cohorts WHERE organisation_id=$1 AND name=$2', [programme.organisation_id, programme.title])).rows.length ? `${programme.title} (${programme.id.slice(0, 6)})` : programme.title;
  return (await c.query('INSERT INTO org_cohorts(organisation_id, name, season_id, programme_id) VALUES ($1,$2,$3,$4) RETURNING id', [programme.organisation_id, name.slice(0, 80), programme.season_id, programme.id])).rows[0].id;
}

/** Offer the next waitlisted people while seats are free. Deterministic (waitlist_seq) and idempotent. Call with the programme locked. */
export async function promoteWaitlist(c, programme, { actor = null } = {}) {
  const v = (await c.query('SELECT * FROM academy_programme_versions WHERE programme_id=$1 AND version=$2', [programme.id, programme.current_version])).rows[0];
  const promoted = [];
  while (await seatsFree(c, programme) > 0) {
    const next = (await c.query("SELECT * FROM academy_applications WHERE programme_id=$1 AND stage='waitlisted' ORDER BY waitlist_seq, id LIMIT 1 FOR UPDATE SKIP LOCKED", [programme.id])).rows[0];
    if (!next) break;
    const hours = v?.offer_valid_hours ?? 72;
    const row = await moveStage(c, next, 'offered', { actor, reason: 'Place became available', set: { offer_expires_at: new Date(Date.now() + hours * 3600e3), version_id: next.version_id ?? v?.id ?? null, waitlist_seq: null } });
    await tell(c, row, 'waitlist_promoted', 'A place is available');
    promoted.push(row.id);
  }
  return promoted;
}

/** Waitlist position, honestly: the number of people ahead plus one. No estimate of when a place will open. */
export const waitlistPosition = async (c, app) => (app.stage !== 'waitlisted' ? null : 1 + (await c.query("SELECT count(*)::int AS n FROM academy_applications WHERE programme_id=$1 AND stage='waitlisted' AND (waitlist_seq, id) < ($2, $3)", [app.programme_id, app.waitlist_seq, app.id])).rows[0].n);

export const nextWaitlistSeq = async (c) => (await c.query("SELECT nextval('academy_waitlist_seq') AS n")).rows[0].n;

export { notFound };
