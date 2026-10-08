import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, conflict, notFound } from '../errors.js';
import { config } from '../config.js';
import { notify } from '../notify.js';
import { audit, hasRole, isAdmin, mustFind } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { randomBytes } from 'node:crypto';
import { canManageTeam } from './teams.js';
import { paymentsEnabled } from '../payments/service.js';

export const mask = (n) => (n ? `••••${n.slice(-4)}` : null);

const PLAN_STATUS = ['active', 'retired'];
export const ageOf = (dob) => { const d = new Date(dob); if (isNaN(d)) return null; const n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };

/** One normalised plan card. Exclusions and conditions are always part of it: they are never hidden by sorting or ranking. */
export const PLAN_SQL = `SELECT pl.id, pl.name, pl.cover_for, pl.status, pl.emoji, pl.description, pl.premium_cents, pl.coverage_cents, coalesce(pl.currency, $CUR) AS currency,
    pl.deductible_cents, pl.waiting_period_days, pl.term_months_min, pl.term_months_max, pl.min_age, pl.max_age, pl.sports, pl.exclusions, pl.conditions,
    CASE WHEN pl.promo_text IS NOT NULL AND (pl.promo_ends_on IS NULL OR pl.promo_ends_on >= current_date) THEN pl.promo_text END AS offer, pl.promo_ends_on AS offer_ends_on,
    pl.insurer_id, coalesce(i.name, pl.insurer) AS insurer, (i.verified_at IS NOT NULL) AS insurer_verified
  FROM insurance_plans pl LEFT JOIN insurers i ON i.id = pl.insurer_id`;
export const card = ({ min_age, max_age, term_months_min, term_months_max, sports, ...r }) => ({
  ...r, term_months: { min: term_months_min, max: term_months_max }, eligibility: { min_age, max_age, sports },
});

/** The insurer a signed-in `insurer` account runs (one account, one insurer). Admins have none of their own. */
export async function myInsurer(user, { required = true } = {}) {
  const ins = await one('SELECT * FROM insurers WHERE owner_id=$1', [user.id]);
  if (!ins && required) throw notFound('Your insurer profile (set it up first)');
  return ins;
}
/** Is this person allowed to act for that insurer (its owner, or the platform team)? */
export const actsFor = (user, insurer) => isAdmin(user) || (!!insurer && insurer.owner_id === user.id && hasRole(user, 'insurer'));

const INSURER_COLS = `i.id, i.name, i.description, i.headline, i.website, i.regions, i.sports, i.accepting_requests, (i.verified_at IS NOT NULL) AS verified, i.verified_at, i.status,
  (SELECT count(*)::int FROM insurance_plans p WHERE p.insurer_id=i.id AND p.status='active') AS active_plans`;

cap({
  name: 'list_insurers', method: 'GET', path: '/insurance/insurers', tag: 'Insurance', auth: 'public',
  summary: 'Active insurers with their verification status (licence checked by the platform team) and how many active plans they offer.',
  input: z.object({ q: z.string().max(80).optional(), verified: z.coerce.boolean().optional(), sport: z.string().max(60).optional().describe('sport slug; insurers for all sports also match'), accepting: z.coerce.boolean().optional().describe('only insurers taking quote requests'), ...page }),
  handler: (_, i) => many(
    `SELECT ${INSURER_COLS} FROM insurers i WHERE i.status='active' AND ($1::text IS NULL OR i.name ILIKE '%' || $1 || '%' OR i.headline ILIKE '%' || $1 || '%') AND (NOT $2 OR i.verified_at IS NOT NULL)
       AND ($5::text IS NULL OR cardinality(i.sports)=0 OR $5 = ANY(i.sports)) AND (NOT $6 OR i.accepting_requests) ORDER BY i.name LIMIT $3 OFFSET $4`,
    [i.q ? i.q.replace(/[%_\\]/g, '\\$&') : null, !!i.verified, i.limit, i.offset, i.sport ?? null, !!i.accepting]),
});

cap({
  name: 'get_insurer', method: 'GET', path: '/insurance/insurers/:id', tag: 'Insurance', auth: 'public',
  summary: 'One insurer\'s public profile: what they do, where and for which sports, verification, and their active plans (with any labelled offer). No personal or licence data.',
  input: z.object({ id }),
  async handler(_, i) {
    const ins = await one(`SELECT ${INSURER_COLS}, i.owner_id FROM insurers i WHERE i.id=$1 AND i.status='active'`, [i.id]);
    if (!ins) throw notFound('Insurer');
    const plans = await many(`${PLAN_SQL.replace('$CUR', '$2')} WHERE pl.insurer_id=$1 AND pl.status='active' ORDER BY pl.premium_cents, pl.name`, [ins.id, config.payments.currency]);
    return { ...ins, plans: plans.map(card) };
  },
});

cap({
  name: 'create_insurer', method: 'POST', path: '/insurance/insurers', tag: 'Insurance', auth: ['admin'], status: 201,
  summary: 'Admin: add an insurer profile. The licence number is encrypted. Use verify_insurer after checking it.',
  input: z.object({ name: z.string().min(2).max(120), description: z.string().max(1000).optional(), website: z.string().url().optional(), licence_no: z.string().max(80).optional(), owner_id: id.optional().describe('hand the profile to an account with the insurer role') }),
  async handler(_, i) {
    if (await one('SELECT 1 FROM insurers WHERE lower(name)=lower($1)', [i.name])) throw conflict('That insurer already exists');
    if (i.owner_id) {
      const o = await mustFind('users', i.owner_id, 'id, roles');
      if (!o.roles.includes('insurer')) throw badRequest('That account does not hold the insurer role');
      if (await one('SELECT 1 FROM insurers WHERE owner_id=$1', [o.id])) throw conflict('That account already runs an insurer');
    }
    return one('INSERT INTO insurers(name, description, website, licence_no_enc, owner_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, status, description, website, owner_id, verified_at, created_at', [i.name, i.description ?? null, i.website ?? null, i.licence_no ? encrypt(i.licence_no, 'insurers.licence_no') : null, i.owner_id ?? null]);
  },
});

cap({
  name: 'verify_insurer', method: 'POST', path: '/insurance/insurers/:id/verify', tag: 'Insurance', auth: ['admin'],
  summary: 'Admin: mark an insurer as verified (or remove the mark) after checking its licence. The licence number is only read here, audit-logged.',
  input: z.object({ id, verified: z.boolean().default(true) }),
  async handler({ user }, i) {
    const ins = await mustFind('insurers', i.id);
    if (i.verified && !ins.licence_no_enc) throw badRequest('Add the licence number before verifying this insurer');
    if (i.verified) await audit(null, user.id, 'read_pii', 'insurers', ins.id);
    return one('UPDATE insurers SET verified_at=$2, verified_by=$3 WHERE id=$1 RETURNING id, name, verified_at', [ins.id, i.verified ? new Date() : null, i.verified ? user.id : null]);
  },
});

cap({
  name: 'list_insurance_plans', method: 'GET', path: '/insurance/plans', tag: 'Insurance', auth: 'public',
  summary: 'Search insurance plans. Filter by what is covered (individual/team/event), sport, insurer, verified insurers, premium range, policy term, the buyer\'s age, and text; sort by premium, coverage, deductible or name. Every card carries the same normalised terms including exclusions and conditions, and nothing here is personal data. Only active plans unless you ask for retired ones.',
  input: z.object({
    cover_for: z.enum(['individual', 'team', 'event']).optional(), q: z.string().max(80).optional(), sport: z.string().max(60).optional().describe('sport slug; plans for all sports also match'),
    insurer_id: id.optional(), verified_insurer: z.coerce.boolean().optional(), max_premium_cents: z.coerce.number().int().min(0).optional(), min_premium_cents: z.coerce.number().int().min(0).optional(),
    min_coverage_cents: z.coerce.number().int().min(0).optional(), term_months: z.coerce.number().int().min(1).max(120).optional(), age: z.coerce.number().int().min(0).max(120).optional().describe('only plans this age may buy'),
    status: z.enum(PLAN_STATUS).default('active'), sort: z.enum(['premium', 'coverage', 'deductible', 'name']).default('premium'), ...page,
  }),
  handler: async (_, i) => {
    const order = { premium: 'pl.premium_cents, pl.name', coverage: 'pl.coverage_cents DESC, pl.name', deductible: 'pl.deductible_cents, pl.name', name: 'pl.name' }[i.sort];
    const rows = await many(
      `${PLAN_SQL.replace('$CUR', '$10')} WHERE pl.status=$1 AND ($2::text IS NULL OR pl.cover_for=$2)
         AND ($3::text IS NULL OR pl.name ILIKE '%' || $3 || '%' OR coalesce(i.name, pl.insurer) ILIKE '%' || $3 || '%' OR pl.description ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR cardinality(pl.sports)=0 OR $4 = ANY(pl.sports)) AND ($5::uuid IS NULL OR pl.insurer_id=$5) AND (NOT $6 OR i.verified_at IS NOT NULL)
         AND ($7::bigint IS NULL OR pl.premium_cents <= $7) AND ($8::bigint IS NULL OR pl.premium_cents >= $8) AND ($9::bigint IS NULL OR pl.coverage_cents >= $9)
         AND ($11::int IS NULL OR ($11 BETWEEN pl.term_months_min AND pl.term_months_max)) AND ($12::int IS NULL OR ((pl.min_age IS NULL OR $12 >= pl.min_age) AND (pl.max_age IS NULL OR $12 <= pl.max_age)))
       ORDER BY ${order} LIMIT $13 OFFSET $14`,
      [i.status, i.cover_for ?? null, i.q ? i.q.replace(/[%_\\]/g, '\\$&') : null, i.sport ?? null, i.insurer_id ?? null, !!i.verified_insurer, i.max_premium_cents ?? null, i.min_premium_cents ?? null, i.min_coverage_cents ?? null, config.payments.currency, i.term_months ?? null, i.age ?? null, i.limit, i.offset]);
    return rows.map(card);
  },
});

cap({
  name: 'compare_insurance_plans', method: 'GET', path: '/insurance/plan-comparison', tag: 'Insurance', auth: 'public',
  summary: 'Compare 2-5 plans side by side with the same normalised terms (including exclusions and conditions, shown in full), which fields differ, and who is best on premium, coverage, deductible and waiting period. Highlights are informational; read the exclusions before choosing.',
  input: z.object({ ids: z.string().describe('comma-separated plan ids (2-5)') }),
  async handler(_, i) {
    const ids = [...new Set(i.ids.split(',').map((x) => x.trim()).filter(Boolean))];
    if (ids.length < 2 || ids.length > 5 || ids.some((x) => !id.safeParse(x).success)) throw badRequest('Give 2 to 5 plan ids, separated by commas');
    const rows = (await many(`${PLAN_SQL.replace('$CUR', '$2')} WHERE pl.id = ANY($1)`, [ids, config.payments.currency])).map(card);
    if (rows.length !== ids.length) throw notFound('Plan');
    const plans = ids.map((x) => rows.find((r) => r.id === x));
    if (new Set(plans.map((p) => p.currency)).size > 1) throw badRequest('These plans are priced in different currencies');
    const best = (key, dir) => { const v = plans.map((p) => Number(p[key])); const t = dir === 'min' ? Math.min(...v) : Math.max(...v); return plans.filter((p) => Number(p[key]) === t).map((p) => p.id); };
    const fields = ['cover_for', 'premium_cents', 'coverage_cents', 'deductible_cents', 'waiting_period_days', 'term_months', 'eligibility', 'exclusions', 'conditions', 'insurer_verified'];
    return {
      plans, differences: fields.filter((f) => new Set(plans.map((p) => JSON.stringify(p[f] ?? null))).size > 1),
      highlights: { lowest_premium: best('premium_cents', 'min'), highest_coverage: best('coverage_cents', 'max'), lowest_deductible: best('deductible_cents', 'min'), shortest_waiting_period: best('waiting_period_days', 'min') },
    };
  },
});

const planFields = {
  name: z.string().min(2).max(120), cover_for: z.enum(['individual', 'team', 'event']), premium_cents: money, coverage_cents: money, description: z.string().max(1000).optional(), emoji: z.string().max(8).optional(),
  currency: z.string().length(3).transform((x) => x.toUpperCase()).optional(), sports: z.array(z.string().max(60)).max(30).optional(), min_age: z.number().int().min(0).max(120).nullable().optional(), max_age: z.number().int().min(0).max(120).nullable().optional(),
  term_months_min: z.number().int().min(1).max(120).optional(), term_months_max: z.number().int().min(1).max(120).optional(), waiting_period_days: z.number().int().min(0).max(730).optional(), deductible_cents: money.optional(),
  exclusions: z.string().max(4000).nullable().optional(), conditions: z.string().max(4000).nullable().optional(),
  promo_text: z.string().max(200).nullable().optional().describe('a labelled offer shown on the plan card, e.g. "2 months free for new squads"'), promo_ends_on: z.string().date().nullable().optional(),
};
const checkPlan = (p) => {
  if (p.term_months_min && p.term_months_max && p.term_months_min > p.term_months_max) throw badRequest('term_months_min is above term_months_max');
  if (p.min_age != null && p.max_age != null && p.min_age > p.max_age) throw badRequest('min_age is above max_age');
};

cap({
  name: 'create_insurance_plan', method: 'POST', path: '/insurance/plans', tag: 'Insurance', auth: ['insurer'], status: 201,
  summary: 'Publish an insurance plan. An insurer publishes under its own profile (set it up with onboard_insurer first); the platform team can publish under any insurer (insurer_id, or an insurer name that is created/matched). Set the terms buyers compare: eligibility, term, waiting period, deductible, exclusions and conditions, plus an optional labelled offer.',
  input: z.object({ ...planFields, insurer: z.string().min(2).max(120).optional(), insurer_id: id.optional() }),
  async handler({ user }, i) {
    checkPlan(i);
    return tx(async (c) => {
      let ins;
      if (isAdmin(user)) {
        if (!i.insurer && !i.insurer_id) throw badRequest('Give insurer or insurer_id');
        ins = i.insurer_id ? (await c.query('SELECT * FROM insurers WHERE id=$1', [i.insurer_id])).rows[0] : (await c.query('SELECT * FROM insurers WHERE lower(name)=lower($1)', [i.insurer])).rows[0];
        if (i.insurer_id && !ins) throw notFound('Insurer');
        if (!ins) ins = (await c.query('INSERT INTO insurers(name) VALUES ($1) RETURNING *', [i.insurer])).rows[0];
      } else {
        ins = (await c.query('SELECT * FROM insurers WHERE owner_id=$1', [user.id])).rows[0];
        if (!ins) throw notFound('Your insurer profile (set it up first)');
        if (i.insurer_id && i.insurer_id !== ins.id) throw forbidden('You can only publish plans for your own insurer');
      }
      if (ins.status !== 'active') throw conflict('That insurer is suspended');
      return (await c.query(
        `INSERT INTO insurance_plans(name, insurer, insurer_id, cover_for, premium_cents, coverage_cents, description, emoji, currency, sports, min_age, max_age, term_months_min, term_months_max, waiting_period_days, deductible_cents, exclusions, conditions, promo_text, promo_ends_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'🛡️'),$9,$10,$11,$12,coalesce($13,1),coalesce($14,36),coalesce($15,0),coalesce($16,0),$17,$18,$19,$20) RETURNING *`,
        [i.name, ins.name, ins.id, i.cover_for, i.premium_cents, i.coverage_cents, i.description, i.emoji, i.currency ?? null, i.sports ?? [], i.min_age ?? null, i.max_age ?? null, i.term_months_min, i.term_months_max, i.waiting_period_days, i.deductible_cents, i.exclusions ?? null, i.conditions ?? null, i.promo_text ?? null, i.promo_ends_on ?? null])).rows[0];
    });
  },
});

cap({
  name: 'update_insurance_plan', method: 'PATCH', path: '/insurance/plans/:id', tag: 'Insurance', auth: ['insurer'],
  summary: 'Change a plan\'s terms or offer, or retire it (status=retired stops new sales; retired plans can be put back on sale). Insurers manage their own plans; the platform team can manage any. Policies already sold keep the terms they were bought on.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(planFields).map(([k, v]) => [k, v.optional()])), status: z.enum(PLAN_STATUS).optional() }),
  async handler({ user }, i) {
    const cur = await mustFind('insurance_plans', i.id);
    if (!isAdmin(user) && !actsFor(user, await one('SELECT * FROM insurers WHERE id=$1', [cur.insurer_id]))) throw forbidden('That plan belongs to another insurer');
    const next = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== undefined && k !== 'id')) };
    checkPlan(next);
    const row = await one(
      `UPDATE insurance_plans SET name=$2, cover_for=$3, premium_cents=$4, coverage_cents=$5, description=$6, emoji=$7, currency=$8, sports=$9, min_age=$10, max_age=$11, term_months_min=$12, term_months_max=$13,
         waiting_period_days=$14, deductible_cents=$15, exclusions=$16, conditions=$17, status=$18, promo_text=$19, promo_ends_on=$20, updated_at=now() WHERE id=$1 RETURNING *`,
      [cur.id, next.name, next.cover_for, next.premium_cents, next.coverage_cents, next.description, next.emoji, next.currency, next.sports, next.min_age, next.max_age, next.term_months_min, next.term_months_max, next.waiting_period_days, next.deductible_cents, next.exclusions, next.conditions, next.status, next.promo_text ?? null, next.promo_ends_on ?? null]);
    await audit(null, user.id, 'update_insurance_plan', 'insurance_plans', cur.id);
    return row;
  },
});

/** Who is being covered: you, a team you manage or an event you organise. Throws if you may not insure that subject; returns its id. */
export async function checkSubject(user, coverFor, subjectId) {
  if (coverFor !== 'individual' && !subjectId) throw badRequest('subject_id is required for team/event cover');
  const subject = coverFor === 'individual' ? user.id : subjectId;
  if (coverFor === 'team' && !(await canManageTeam(user, await mustFind('teams', subject)))) throw forbidden('You do not manage that team');
  if (coverFor === 'event') {
    const ev = await mustFind('events', subject);
    if (!isAdmin(user) && ev.organizer_id !== user.id) throw forbidden('You do not organise that event');
  }
  return subject;
}
export const subjectName = (typeCol, idCol) => `CASE ${typeCol} WHEN 'team' THEN (SELECT name FROM teams WHERE id=${idCol}) WHEN 'event' THEN (SELECT name FROM events WHERE id=${idCol}) END`;

/**
 * Is `user` allowed to buy this plan for this subject? Throws a clear error otherwise; returns the subject id.
 * Used by buying, accepting a quote and renewing, so the rules cannot drift apart.
 */
export async function checkCover(user, plan, subjectId) {
  const subject = await checkSubject(user, plan.cover_for, subjectId);
  if (plan.cover_for === 'event' && plan.sports.length && !(await one('SELECT 1 FROM events e JOIN sports s ON s.id=e.sport_id WHERE e.id=$1 AND s.slug = ANY($2)', [subject, plan.sports]))) throw badRequest('This plan does not cover that sport');
  if (plan.cover_for === 'team' && plan.sports.length && !(await one('SELECT 1 FROM teams t JOIN sports s ON s.id=t.sport_id WHERE t.id=$1 AND s.slug = ANY($2)', [subject, plan.sports]))) throw badRequest('This plan does not cover that sport');
  if (plan.cover_for === 'individual') {
    if (plan.min_age != null || plan.max_age != null) {
      const me = await one('SELECT dob_enc FROM users WHERE id=$1', [user.id]);
      const age = me?.dob_enc ? ageOf(decrypt(me.dob_enc, 'users.dob')) : null;
      if (age === null) throw badRequest('This plan has an age limit: add your date of birth to your profile first');
      await audit(null, user.id, 'read_pii', 'users', user.id);
      if ((plan.min_age != null && age < plan.min_age) || (plan.max_age != null && age > plan.max_age)) throw badRequest(`This plan is for ages ${plan.min_age ?? 0} to ${plan.max_age ?? 'any'}`);
    }
    if (plan.sports.length && !(await one('SELECT 1 FROM sport_profiles sp JOIN sports s ON s.id=sp.sport_id WHERE sp.user_id=$1 AND s.slug = ANY($2)', [user.id, plan.sports]))) throw badRequest(`This plan covers ${plan.sports.join(', ')}: add that sport to your profile first`);
  }
  return subject;
}

/** The terms a policy is bought on, copied from the plan (and any quote overrides) so later plan edits cannot change cover. */
export const termsOf = (plan, over = {}) => ({
  plan_name: plan.name, insurer: plan.insurer, premium_cents: Number(over.premium_cents ?? plan.premium_cents), coverage_cents: Number(over.coverage_cents ?? plan.coverage_cents), currency: plan.currency,
  deductible_cents: Number(over.deductible_cents ?? plan.deductible_cents), waiting_period_days: over.waiting_period_days ?? plan.waiting_period_days, exclusions: plan.exclusions, conditions: plan.conditions, ...(over.extra ?? {}),
});

/** Insert a policy for `holder` inside a transaction. The cost is premium x months; it is pending_payment until paid when payments are on. */
export async function insertPolicy(c, { plan, holderId, subject, months, beneficiary, terms, startsOn, quoteId, renewedFrom }) {
  const policyNo = `SA-${randomBytes(5).toString('hex').toUpperCase()}`;
  const premium = terms.premium_cents;
  const p = (await c.query(
    `INSERT INTO insurance_policies(plan_id, holder_id, subject_type, subject_id, policy_no_enc, beneficiary_enc, starts_on, ends_on, amount_cents, status, terms, quote_id, renewed_from)
     VALUES ($1,$2,$3,$4,$5,$6, coalesce($7::date, current_date), coalesce($7::date, current_date) + make_interval(months => $8)::interval, $9, $10, $11, $12, $13)
     RETURNING id, plan_id, subject_type, subject_id, status, starts_on, ends_on, quote_id, renewed_from`,
    [plan.id, holderId, plan.cover_for, subject, encrypt(policyNo, 'insurance_policies.policy_no'), encrypt(beneficiary, 'insurance_policies.beneficiary'), startsOn ?? null, months, premium * months,
      paymentsEnabled() && premium > 0 ? 'pending_payment' : 'active', JSON.stringify(terms), quoteId ?? null, renewedFrom ?? null])).rows[0];
  return { ...p, policy_no: mask(policyNo), premium_cents: premium * months, coverage_cents: terms.coverage_cents, terms };
}

export async function loadPlan(planId) {
  const plan = await one(`${PLAN_SQL.replace('$CUR', '$2')} WHERE pl.id=$1`, [planId, config.payments.currency]);
  if (!plan) throw notFound('Plan');
  return plan;
}
export function checkTerm(plan, months) {
  if (months < plan.term_months_min || months > plan.term_months_max) throw badRequest(`This plan runs ${plan.term_months_min} to ${plan.term_months_max} months`);
}

cap({
  name: 'buy_policy', method: 'POST', path: '/insurance/policies', tag: 'Insurance', status: 201,
  summary: 'Insure yourself (individual), a team you manage, or an event/tournament you organise, at the plan\'s listed premium. (For a negotiated price, request a quote and accept it instead.) The plan must be active, the term within its limits and (for individual cover) your age and sport within its eligibility. The terms are copied onto the policy so later plan edits cannot change your cover. Policy number and beneficiary are encrypted. When a payment provider is enabled the policy is pending_payment until paid (create_payment).',
  input: z.object({ plan_id: id, subject_id: id.optional().describe('team or event id; omit for individual (you)'), months: z.number().int().min(1).max(36).default(12), beneficiary: z.string().max(200).optional() }),
  async handler({ user }, i) {
    const plan = await loadPlan(i.plan_id);
    if (plan.status !== 'active') throw conflict('This plan is no longer on sale');
    checkTerm(plan, i.months);
    const subject = await checkCover(user, plan, i.subject_id);
    return tx((c) => insertPolicy(c, { plan, holderId: user.id, subject, months: i.months, beneficiary: i.beneficiary, terms: termsOf(plan) }));
  },
});

cap({
  name: 'list_policies', method: 'GET', path: '/insurance/policies', tag: 'Insurance',
  summary: 'Your policies (policy numbers masked; use get_policy for full details), each with days left, whether renewal is due (30 days before the end) or already done, and how many documents are stored. Filter renewal_due=true for the ones to renew.',
  input: z.object({ renewal_due: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT p.*, pl.name AS plan_name, pl.insurer, pl.insurer_id, pl.coverage_cents, pl.emoji, (CASE WHEN p.ends_on < current_date AND p.status='active' THEN 'expired' ELSE p.status END) AS effective_status,
         (p.ends_on - current_date) AS days_left, (SELECT id FROM insurance_policies r WHERE r.renewed_from = p.id) AS renewed_by,
         (SELECT count(*)::int FROM insurance_documents d WHERE d.policy_id=p.id AND d.removed_at IS NULL) AS documents,
         CASE p.subject_type WHEN 'team' THEN (SELECT name FROM teams WHERE id=p.subject_id) WHEN 'event' THEN (SELECT name FROM events WHERE id=p.subject_id) END AS subject_name
       FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE p.holder_id=$1
         AND (NOT $4 OR (p.status='active' AND p.ends_on <= current_date + 30 AND NOT EXISTS (SELECT 1 FROM insurance_policies r WHERE r.renewed_from = p.id)))
       ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset, !!i.renewal_due]);
    return rows.map(({ policy_no_enc, beneficiary_enc, renewal_notice_days, ...r }) => ({
      ...r, policy_no: mask(decrypt(policy_no_enc, 'insurance_policies.policy_no')), days_left: Number(r.days_left),
      renewal_due: r.status === 'active' && Number(r.days_left) <= 30 && !r.renewed_by,
    }));
  },
});

cap({
  name: 'get_policy', method: 'GET', path: '/insurance/policies/:id', tag: 'Insurance', summary: 'Full policy incl. decrypted number and beneficiary (holder only; audit-logged). The insurer that wrote the policy can read it too, without the beneficiary.', input: z.object({ id }),
  async handler({ user }, i) {
    const p = await mustFind('insurance_policies', i.id);
    const byInsurer = p.holder_id !== user.id && !isAdmin(user) && await insurerOfPolicy(user, p);
    if (!isAdmin(user) && p.holder_id !== user.id && !byInsurer) throw forbidden();
    await audit(null, user.id, 'read_pii', 'insurance_policies', p.id);
    const { policy_no_enc, beneficiary_enc, renewal_notice_days, ...r } = p;
    return { ...r, policy_no: decrypt(policy_no_enc, 'insurance_policies.policy_no'), ...(byInsurer ? {} : { beneficiary: decrypt(beneficiary_enc, 'insurance_policies.beneficiary') }) };
  },
});

/** The insurer owned by `user` when the policy was written on one of its plans, else null. */
export async function insurerOfPolicy(user, policy) {
  if (!hasRole(user, 'insurer')) return null;
  return one('SELECT i.* FROM insurers i JOIN insurance_plans pl ON pl.insurer_id=i.id WHERE pl.id=$1 AND i.owner_id=$2', [policy.plan_id, user.id]);
}

const coverageOf = (p, plan) => Number(p.terms?.coverage_cents ?? plan.coverage_cents);
const logClaim = (c, claimId, actor, action, from, to, reason) => c.query('INSERT INTO insurance_claim_events(claim_id, actor_id, action, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5,$6)', [claimId, actor, action, from, to, reason ?? null]);
const OPEN_CLAIM = ['submitted', 'under_review', 'approved', 'paid'];   // claims that count against the cover

cap({
  name: 'file_claim', method: 'POST', path: '/insurance/policies/:id/claims', tag: 'Insurance', status: 201,
  summary: 'File a claim against an active policy. The description is encrypted. The total of your open, approved and paid claims cannot exceed the cover the policy was bought with, and the incident (if you give its date) must fall inside the policy period and after any waiting period.',
  input: z.object({ id, description: z.string().min(5).max(3000), amount_cents: money.refine((n) => n > 0), incident_on: z.string().date().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = (await c.query('SELECT * FROM insurance_policies WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!p) throw notFound('Policy');
      if (p.holder_id !== user.id) throw forbidden();
      if (p.status !== 'active' || p.ends_on < new Date().toISOString().slice(0, 10)) throw conflict('Policy is not active');
      const plan = (await c.query('SELECT * FROM insurance_plans WHERE id=$1', [p.plan_id])).rows[0];
      const cover = coverageOf(p, plan);
      const used = Number((await c.query("SELECT coalesce(sum(amount_cents),0) AS s FROM insurance_claims WHERE policy_id=$1 AND status = ANY($2)", [p.id, OPEN_CLAIM])).rows[0].s);
      if (i.amount_cents > cover) throw badRequest('Claim exceeds coverage', { coverage_cents: cover });
      if (used + i.amount_cents > cover) throw conflict(`Only ${cover - used} of the cover is left after your other claims`);
      if (i.incident_on) {
        const waiting = Number(p.terms?.waiting_period_days ?? plan.waiting_period_days ?? 0);
        const start = new Date(new Date(p.starts_on).getTime() + waiting * 864e5).toISOString().slice(0, 10);
        if (i.incident_on > new Date().toISOString().slice(0, 10)) throw badRequest('The incident date is in the future');
        if (i.incident_on < new Date(p.starts_on).toISOString().slice(0, 10) || i.incident_on > new Date(p.ends_on).toISOString().slice(0, 10)) throw badRequest('The incident is outside the policy period');
        if (i.incident_on < start) throw conflict(`This policy has a ${waiting}-day waiting period: incidents before ${start} are not covered`);
      }
      const row = (await c.query('INSERT INTO insurance_claims(policy_id, claimant_id, description_enc, amount_cents, incident_on) VALUES ($1,$2,$3,$4,$5) RETURNING id, policy_id, amount_cents, incident_on, status, created_at', [i.id, user.id, encrypt(i.description, 'insurance_claims.description'), i.amount_cents, i.incident_on ?? null])).rows[0];
      await logClaim(c, row.id, user.id, 'file', null, 'submitted');
      return row;
    });
  },
});

cap({
  name: 'list_claims', method: 'GET', path: '/insurance/claims', tag: 'Insurance', summary: 'Your claims (admins see all), with the decision and the reason when there is one. As an insurer, pass as_insurer=true for the claims on policies written on your plans.',
  input: z.object({ status: z.enum(['submitted', 'under_review', 'approved', 'rejected', 'paid']).optional(), as_insurer: z.coerce.boolean().optional(), ...page }),
  async handler({ user }, i) {
    if (i.as_insurer) {
      const ins = await myInsurer(user);
      const rows = await many(`SELECT cl.* FROM insurance_claims cl JOIN insurance_policies p ON p.id=cl.policy_id JOIN insurance_plans pl ON pl.id=p.plan_id
          WHERE pl.insurer_id=$1 AND ($2::text IS NULL OR cl.status=$2) ORDER BY cl.created_at DESC LIMIT $3 OFFSET $4`, [ins.id, i.status ?? null, i.limit, i.offset]);
      if (rows.length) await audit(null, user.id, 'read_pii', 'insurance_claims', null);
      return rows.map(({ description_enc, ...r }) => ({ ...r, description: decrypt(description_enc, 'insurance_claims.description') }));
    }
    const rows = await many('SELECT * FROM insurance_claims WHERE ($1 OR claimant_id=$2) AND ($3::text IS NULL OR status=$3) ORDER BY created_at DESC LIMIT $4 OFFSET $5', [isAdmin(user), user.id, i.status ?? null, i.limit, i.offset]);
    if (rows.length) await audit(null, user.id, 'read_pii', 'insurance_claims', null);
    return rows.map(({ description_enc, ...r }) => ({ ...r, description: decrypt(description_enc, 'insurance_claims.description') }));
  },
});

cap({
  name: 'get_claim', method: 'GET', path: '/insurance/claims/:id', tag: 'Insurance', summary: 'One claim with its decrypted description and full status history (claimant, the insurer that wrote the policy, or admin; audit-logged).', input: z.object({ id }),
  async handler({ user }, i) {
    const cl = await mustFind('insurance_claims', i.id);
    if (!isAdmin(user) && cl.claimant_id !== user.id && !(await insurerOfPolicy(user, await mustFind('insurance_policies', cl.policy_id)))) throw notFound('Claim');
    await audit(null, user.id, 'read_pii', 'insurance_claims', cl.id);
    const history = await many('SELECT e.action, e.from_status, e.to_status, e.reason, e.created_at, u.display_name AS actor FROM insurance_claim_events e JOIN users u ON u.id=e.actor_id WHERE e.claim_id=$1 ORDER BY e.created_at, e.id', [cl.id]);
    const { description_enc, ...r } = cl;
    return { ...r, description: decrypt(description_enc, 'insurance_claims.description'), history };
  },
});

// submitted -> under_review -> approved | rejected, approved -> paid. A claim can also be decided straight from submitted.
const NEXT = { submitted: ['under_review', 'approved', 'rejected'], under_review: ['approved', 'rejected'], approved: ['paid'], rejected: [], paid: [] };

cap({
  name: 'review_claim', method: 'PATCH', path: '/insurance/claims/:id', tag: 'Insurance', auth: ['insurer'],
  summary: 'Insurer (for claims on its own policies) or admin: move a claim through review -> approved/rejected -> paid. Moves must follow the order (a decided claim cannot go back), a rejection needs a reason the claimant will see, you cannot review your own claim, and approving cannot push the policy over its cover. Every step is recorded and the claimant is told (generic wording).',
  input: z.object({ id, status: z.enum(['under_review', 'approved', 'rejected', 'paid']), reason: z.string().min(5).max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const cl = (await c.query('SELECT * FROM insurance_claims WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!cl) throw notFound('Claim');
      if (!isAdmin(user)) {
        const pol = (await c.query('SELECT plan_id FROM insurance_policies WHERE id=$1', [cl.policy_id])).rows[0];
        if (!(await insurerOfPolicy(user, pol))) throw notFound('Claim');
      }
      if (cl.claimant_id === user.id) throw forbidden('Another reviewer must handle your own claim');
      if (!NEXT[cl.status].includes(i.status)) throw conflict(`A ${cl.status} claim cannot move to ${i.status}`);
      if (i.status === 'rejected' && !i.reason) throw badRequest('A reason is required to reject a claim');
      if (i.status === 'approved') {
        const p = (await c.query('SELECT p.*, pl.coverage_cents AS plan_cover FROM insurance_policies p JOIN insurance_plans pl ON pl.id=p.plan_id WHERE p.id=$1', [cl.policy_id])).rows[0];
        const cover = Number(p.terms?.coverage_cents ?? p.plan_cover);
        const others = Number((await c.query("SELECT coalesce(sum(amount_cents),0) AS s FROM insurance_claims WHERE policy_id=$1 AND id<>$2 AND status IN ('approved','paid')", [cl.policy_id, cl.id])).rows[0].s);
        if (others + Number(cl.amount_cents) > cover) throw conflict('Approving this would exceed the cover of the policy');
      }
      const row = (await c.query('UPDATE insurance_claims SET status=$2::text, reviewer_id=$3, decision_reason=coalesce($4, decision_reason), decided_at=CASE WHEN $2::text IN (\'approved\',\'rejected\') THEN now() ELSE decided_at END, updated_at=now() WHERE id=$1 RETURNING id, policy_id, amount_cents, status, decision_reason, decided_at', [cl.id, i.status, user.id, i.reason ?? null])).rows[0];
      await logClaim(c, cl.id, user.id, i.status === 'under_review' ? 'start_review' : i.status, cl.status, i.status, i.reason);
      await notify(c, cl.claimant_id, { kind: 'claim_update', title: 'Your insurance claim was updated', body: i.status === 'rejected' ? 'Your claim was reviewed. Open it to see the decision.' : `Your claim is now ${i.status.replace('_', ' ')}.`, data: { claim_id: cl.id } });
      return row;
    });
  },
});
