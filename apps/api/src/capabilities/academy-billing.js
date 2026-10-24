// Academy OS 1/3: enrolment billing views, explicit funded seats, refunds, the family self-service view and the operational dashboard.
// Payment itself is the canonical create_payment flow (purpose_type "academy_charge"); money rules: amounts come from the charge snapshot,
// currencies are never summed together, and "customer paid" is not reported as "academy received a payout".
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { refundPartial } from '../payments/service.js';
import { flag, STAFF, STAFF_MONEY, outstandingPolicies, waitlistPosition, planCharges, actFor, findPromo, SESSIONS_SQL, INVOICE_SQL, INVOICE_NO_SQL } from '../academy.js';
import { syncChargeInvoice, creditChargeInvoice, fulfilChargePaid } from '../academy-invoices.js';
import { localView } from '../academy-trials.js';

const money = (rows, key = 'currency') => Object.fromEntries(rows.map((r) => [r[key], r]));

cap({
  name: 'list_academy_charges', method: 'GET', path: '/organisations/:id/charges', tag: 'Academy',
  summary: 'Tuition, deposit and instalment charges of the academy by status (owner/admin/finance). Amounts are the snapshot taken at enrolment.',
  input: z.object({ id, status: z.enum(['awaiting_payment', 'paid', 'cancelled', 'waived', 'refunded']).optional(), overdue: flag.optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    return many(
      `SELECT ch.id, ch.enrolment_id, ch.application_id, ch.kind, ch.seq, ch.due_on, ch.currency, ch.gross_minor, ch.discount_minor, ch.funded_minor, ch.funding_source, ch.tax_minor, ch.amount_minor, ch.status, ch.paid_at, ${INVOICE_SQL} AS invoice_id, ${INVOICE_NO_SQL} AS invoice_number,
              u.id AS athlete_id, u.display_name, (ch.status='awaiting_payment' AND ch.due_on < current_date) AS overdue
         FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
         JOIN users u ON u.id = coalesce(e.user_id, a.athlete_id)
        WHERE ch.organisation_id=$1 AND ($2::text IS NULL OR ch.status=$2) AND ($3::boolean IS NULL OR (ch.status='awaiting_payment' AND ch.due_on < current_date) = $3)
        ORDER BY ch.due_on, ch.id LIMIT $4 OFFSET $5`, [i.id, i.status ?? null, i.overdue ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'set_academy_charge_funding', method: 'POST', path: '/academy-charges/:id/funding', tag: 'Academy',
  summary: 'Record a scholarship, bursary or sponsor-funded amount against an unpaid charge (owner/admin/finance). It is an explicit funded source on the charge, not an edited price; a fully funded charge is marked waived.',
  input: z.object({ id, funding_source: z.enum(['scholarship', 'bursary', 'sponsor']), funded_minor: z.number().int().min(1), funding_ref: z.string().max(120).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const ch = (await c.query('SELECT * FROM academy_charges WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!ch) throw notFound('Charge');
    await orgFor(user, ch.organisation_id, STAFF_MONEY, { write: true, c });
    if (ch.status !== 'awaiting_payment') throw conflict('Only an unpaid charge can be funded');
    if (i.funded_minor + Number(ch.discount_minor) > Number(ch.gross_minor)) throw badRequest('Funding and discounts cannot exceed the charge');
    const amount = Number(ch.gross_minor) - Number(ch.discount_minor) - i.funded_minor;
    const tax = ch.amount_minor > 0 ? Math.round(Number(ch.tax_minor) * amount / Number(ch.amount_minor)) : 0;
    const r = (await c.query("UPDATE academy_charges SET funded_minor=$2, funding_source=$3, funding_ref=$4, amount_minor=$5::bigint, tax_minor=$6, status=CASE WHEN $5::bigint=0 THEN 'waived' ELSE status END WHERE id=$1 RETURNING *",
      [ch.id, i.funded_minor, i.funding_source, i.funding_ref ?? null, amount, tax])).rows[0];
    await syncChargeInvoice(c, ch.id);                  // the open invoice shows the funded part (or is voided when nothing is left to pay)
    await audit(c, user.id, 'set_academy_charge_funding', 'academy_charges', ch.id);
    return r;
  }),
});

cap({
  name: 'refund_academy_charge', method: 'POST', path: '/academy-charges/:id/refund', tag: 'Academy',
  summary: 'Refund a paid academy charge, in full or part (owner/admin/finance), through the canonical payment refund. The refund key makes a retry safe; the charge is marked refunded only when fully refunded.',
  input: z.object({ id, amount_minor: z.number().int().min(1).optional(), reason: z.string().max(300).optional(), idempotency_key: z.string().min(8).max(80) }),
  async handler({ user }, i) {
    const ch = await one('SELECT * FROM academy_charges WHERE id=$1', [i.id]);
    if (!ch) throw notFound('Charge');
    await orgFor(user, ch.organisation_id, STAFF_MONEY, { write: true });
    const pay = await one("SELECT * FROM payments WHERE purpose_type='academy_charge' AND purpose_id=$1 AND status IN ('paid','refunded') ORDER BY paid_at DESC NULLS LAST LIMIT 1", [ch.id]);
    if (!pay) throw conflict('This charge has no completed payment to refund');
    const key = `academy-refund:${ch.id}:${i.idempotency_key}`;
    const give = await refundPartial(pay, i.amount_minor ?? Number(pay.amount_cents), key);
    const after = await one('SELECT * FROM payments WHERE id=$1', [pay.id]);
    await tx(async (c) => {
      if (give > 0) await creditChargeInvoice(c, ch.id, give, key);       // a numbered credit note against the invoice; a retry with the same key adds nothing
      if (Number(after.refunded_cents) >= Number(after.amount_cents)) await c.query("UPDATE academy_charges SET status='refunded' WHERE id=$1", [ch.id]);
    });
    await audit(null, user.id, 'refund_academy_charge', 'academy_charges', ch.id);
    return { refunded_minor: give, currency: pay.currency, charge_status: Number(after.refunded_cents) >= Number(after.amount_cents) ? 'refunded' : 'paid' };
  },
});

cap({
  name: 'quote_academy_enrolment', method: 'GET', path: '/academy/programmes/:id/quote', tag: 'Academy',
  summary: 'The exact price and due dates an athlete would be charged if enrolled today, with any sibling / second-programme discount already applied. Nothing is created. The athlete themselves or their verified guardian can ask.',
  input: z.object({ id, athlete_id: id.optional(), promo_code: z.string().trim().min(3).max(24).optional().describe('a promo code of this academy') }),
  async handler({ user }, i) {
    const athlete = i.athlete_id ?? user.id;
    await actFor(user, athlete, pool);
    const p = await one("SELECT * FROM academy_programmes WHERE id=$1 AND status='published'", [i.id]);
    if (!p) throw notFound('Programme');
    const v = await one('SELECT * FROM academy_programme_versions WHERE programme_id=$1 AND version=$2', [p.id, p.current_version]);
    if (!v) throw notFound('Programme terms');
    const sibling = !!(await one("SELECT 1 FROM org_enrolments e JOIN academy_charges ch ON ch.enrolment_id=e.id WHERE ch.payer_id=$1 AND ch.organisation_id=$2 AND e.user_id<>$3 AND e.status IN ('enrolled','paused') LIMIT 1", [user.id, p.organisation_id, athlete]));
    const multi = !!(await one("SELECT 1 FROM org_enrolments e WHERE e.user_id=$1 AND e.programme_id<>$2 AND e.status IN ('enrolled','paused') AND e.programme_id IN (SELECT id FROM academy_programmes WHERE organisation_id=$3) LIMIT 1", [athlete, p.id, p.organisation_id]));
    const today = new Date().toISOString().slice(0, 10);
    const promo = await findPromo(pool, { orgId: p.organisation_id, programmeId: p.id, code: i.promo_code, userId: user.id, version: v });
    const lines = planCharges(v, { today, sibling, multi, promo }).map((r) => ({ kind: r.kind, due_on: r.due_on, currency: r.currency, gross_minor: r.gross_minor, discount_minor: r.discount_minor, amount_minor: r.amount_minor, discount_reason: r.terms.discount_reason ?? null, promo_code: r.terms.promo?.code ?? null }));
    const total = lines.reduce((t, r) => t + r.amount_minor, 0);
    return { programme_id: p.id, version: v.version, billing_model: v.billing_model, currency: v.currency, lines, total_minor: total, today_minor: lines.filter((r) => r.due_on <= today).reduce((t, r) => t + r.amount_minor, 0), renewal_terms: v.renewal_terms, discount_applied: lines.some((r) => r.discount_minor > 0), promo_applied: lines.some((r) => r.promo_code), promo_code: promo?.code ?? null, note: v.billing_model === 'monthly' ? 'Later months are raised a week before each is due. Nothing is charged automatically.' : 'Nothing is charged until you are enrolled, and nothing is charged automatically.' };
  },
});

const METHODS = ['cash', 'card', 'upi', 'bank', 'other'];
cap({
  name: 'record_academy_payment', method: 'POST', path: '/academy-charges/:id/paid', tag: 'Academy',
  summary: 'Staff record that a charge was paid at the academy desk (cash, card, UPI, bank transfer) (owner/admin/finance). The invoice becomes a paid receipt and a pack or subscription period it buys starts. Online payments do this automatically.',
  input: z.object({ id, method: z.enum(METHODS).default('cash') }),
  handler: ({ user }, i) => tx(async (c) => {
    const ch = (await c.query('SELECT * FROM academy_charges WHERE id=$1', [i.id])).rows[0];
    if (!ch) throw notFound('Charge');
    await orgFor(user, ch.organisation_id, STAFF_MONEY, { write: true, c });
    if (await fulfilChargePaid(c, i.id, { method: i.method }) === false) throw conflict('That charge is not waiting for payment');
    await audit(c, user.id, 'record_academy_payment', 'academy_charges', i.id);
    return (await c.query('SELECT id, status, paid_at FROM academy_charges WHERE id=$1', [i.id])).rows[0];
  }),
});

cap({
  name: 'adjust_academy_sessions', method: 'POST', path: '/academy-enrolments/:id/sessions', tag: 'Academy',
  summary: 'Use or give back sessions of a pack (owner/admin; delta -1 uses one, +1 gives one back) with a reason. Attendance in the academy schedule will do this automatically later; until then staff keep the count honest. The pack runs out at zero.',
  input: z.object({ id, delta: z.number().int().min(-50).max(50).refine((d) => d !== 0, 'delta cannot be 0'), reason: z.string().trim().min(2).max(200) }),
  handler: ({ user }, i) => tx(async (c) => {
    const e = (await c.query('SELECT e.*, k.organisation_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1', [i.id])).rows[0];
    if (!e) throw notFound('Enrolment');
    await orgFor(user, e.organisation_id, STAFF, { write: true, c });
    const up = (await c.query("SELECT * FROM user_plans WHERE enrolment_id=$1 AND kind='pass' AND status IN ('active','used_up') ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [i.id])).rows[0];
    if (!up) throw conflict('This enrolment has no active session pack');
    const left = up.sessions_left + i.delta;
    if (left < 0) throw conflict(`Only ${up.sessions_left} session${up.sessions_left === 1 ? '' : 's'} left`);
    if (left > up.sessions_total) throw conflict(`A pack holds ${up.sessions_total} sessions`);
    const r = (await c.query("UPDATE user_plans SET sessions_left=$2, status = CASE WHEN $2 = 0 THEN 'used_up' ELSE 'active' END WHERE id=$1 RETURNING id, sessions_total, sessions_left, status, expires_at", [up.id, left])).rows[0];
    await audit(c, user.id, 'adjust_academy_sessions', 'user_plans', up.id);
    return r;
  }),
});

// promo codes are rows of the shared discounts framework, owned by the organisation
const promoFields = {
  name: z.string().trim().min(2).max(60), code: z.string().regex(/^[A-Za-z0-9_-]{3,24}$/, '3–24 letters, digits, - or _'),
  kind: z.enum(['percent', 'fixed']), value: z.number().int().min(1), currency: z.string().length(3).transform((s) => s.toUpperCase()).optional().describe('required for a fixed amount'),
  programme_id: id.optional().describe('limit to one programme'), valid_from: z.string().date().optional(), valid_to: z.string().date().optional(),
  max_redemptions: z.number().int().min(1).optional(), per_user_limit: z.number().int().min(1).optional(),
};
cap({
  name: 'create_academy_promo', method: 'POST', path: '/organisations/:id/academy/promos', tag: 'Academy', status: 201,
  summary: 'Create a promo code (owner/admin): percent or a fixed amount off, optionally for one programme, with dates and total or per-family limits. The better of the code and the sibling / second-programme discount applies, never both.',
  input: z.object({ id, ...promoFields }).refine((i) => i.kind !== 'percent' || i.value <= 100, 'percent is at most 100').refine((i) => i.kind !== 'fixed' || !!i.currency, 'a fixed amount needs a currency'),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    if (i.valid_from && i.valid_to && i.valid_to < i.valid_from) throw badRequest('The code cannot end before it starts');
    if (i.programme_id && !(await c.query('SELECT 1 FROM academy_programmes WHERE id=$1 AND organisation_id=$2', [i.programme_id, i.id])).rows.length) throw badRequest('That programme is not part of this academy');
    try {
      const d = (await c.query(
        `INSERT INTO discounts(organisation_id, programme_id, name, code, kind, value, currency, valid_from, valid_to, max_redemptions, per_user_limit, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [i.id, i.programme_id ?? null, i.name, i.code, i.kind, i.value, i.kind === 'fixed' ? i.currency : null, i.valid_from ?? null, i.valid_to ?? null, i.max_redemptions ?? null, i.per_user_limit ?? null, user.id])).rows[0];
      await audit(c, user.id, 'create_academy_promo', 'discounts', d.id);
      return d;
    } catch (e) { if (e.code === '23505') throw conflict('This academy already has a promo code with that name'); throw e; }
  }),
});

cap({
  name: 'list_academy_promos', method: 'GET', path: '/organisations/:id/academy/promos', tag: 'Academy',
  summary: 'The academy\'s promo codes with how often each was used and how much it gave (owner/admin/finance). Codes are not public.',
  input: z.object({ id, include_inactive: flag.default(false), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    return many(
      `SELECT d.id, d.name, d.code, d.kind, d.value, d.currency, d.programme_id, p.title AS programme, d.valid_from, d.valid_to, d.max_redemptions, d.per_user_limit, d.active, d.created_at,
              (SELECT count(*)::int FROM discount_redemptions x WHERE x.discount_id=d.id) AS redemptions, (SELECT coalesce(sum(amount_cents),0)::bigint FROM discount_redemptions x WHERE x.discount_id=d.id) AS given_minor
         FROM discounts d LEFT JOIN academy_programmes p ON p.id=d.programme_id WHERE d.organisation_id=$1 AND ($2 OR d.active) ORDER BY d.active DESC, d.created_at DESC, d.id LIMIT $3 OFFSET $4`, [i.id, i.include_inactive, i.limit, i.offset]);
  },
});

cap({
  name: 'update_academy_promo', method: 'PATCH', path: '/academy/promos/:id', tag: 'Academy',
  summary: 'Stop or restart a promo code, change its end date or limits (owner/admin). People who already hold it keep the price they were shown; its history is kept.',
  input: z.object({ id, active: z.boolean().optional(), valid_to: z.string().date().nullable().optional(), max_redemptions: z.number().int().min(1).nullable().optional(), per_user_limit: z.number().int().min(1).nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const d = (await c.query('SELECT * FROM discounts WHERE id=$1 AND organisation_id IS NOT NULL FOR UPDATE', [i.id])).rows[0];
    if (!d) throw notFound('Promo code');
    await orgFor(user, d.organisation_id, STAFF, { write: true, c });
    const r = (await c.query(
      `UPDATE discounts SET active = coalesce($2, active), valid_to = CASE WHEN $3::boolean THEN $4::date ELSE valid_to END, max_redemptions = CASE WHEN $5::boolean THEN $6::int ELSE max_redemptions END,
              per_user_limit = CASE WHEN $7::boolean THEN $8::int ELSE per_user_limit END WHERE id=$1 RETURNING *`,
      [i.id, i.active ?? null, i.valid_to !== undefined, i.valid_to ?? null, i.max_redemptions !== undefined, i.max_redemptions ?? null, i.per_user_limit !== undefined, i.per_user_limit ?? null])).rows[0];
    await audit(c, user.id, 'update_academy_promo', 'discounts', d.id);
    return r;
  }),
});

// ------------------------------------------------------------------ family / athlete self-service
cap({
  name: 'get_my_academy_family', method: 'GET', path: '/me/academy', tag: 'Academy',
  summary: 'Your academy commitments and your children\'s (verified guardians only): applications, trials, offers, waitlist position, enrolments, charges due and agreements still to acknowledge. Identity data comes from the canonical profile; nothing is copied.',
  input: z.object({}),
  async handler({ user }) {
    const kids = await many(
      `SELECT u.id, u.handle, u.display_name FROM guardian_links l JOIN users u ON u.id=l.child_id
        WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND u.youth_until IS NOT NULL AND u.youth_until > current_date ORDER BY u.display_name, u.id`, [user.id]);
    const people = [{ id: user.id, handle: user.handle, display_name: user.display_name, is_me: true }, ...kids.map((k) => ({ ...k, is_me: false }))];
    const pool = { query: async (s, a) => ({ rows: [await one(s, a)] }) };
    const out = [];
    for (const p of people) {
      const apps = await many(
        `SELECT a.id, a.stage, a.programme_id, pr.title AS programme, o.name AS organisation, a.organisation_id, a.offer_expires_at, a.waitlist_seq, a.row_version
           FROM academy_applications a JOIN academy_programmes pr ON pr.id=a.programme_id JOIN organisations o ON o.id=a.organisation_id
          WHERE a.athlete_id=$1 AND (a.applicant_id=$2 OR a.athlete_id=$2) ORDER BY a.updated_at DESC, a.id LIMIT 50`, [p.id, user.id]);
      for (const a of apps) {
        a.waitlist_position = await waitlistPosition(pool, { ...a, id: a.id });
        a.history = await many('SELECT to_stage, reason, created_at FROM academy_application_events WHERE application_id=$1 ORDER BY created_at, id', [a.id]);
        const pr = await one('SELECT p.sport, p.format, p.starts_on, p.ends_on, p.trial_enabled, p.admission_mode, v.billing_model, v.currency, v.fee_minor FROM academy_programmes p LEFT JOIN academy_programme_versions v ON v.programme_id=p.id AND v.version=p.current_version WHERE p.id=$1', [a.programme_id]);
        Object.assign(a, { programme_info: pr });
        if (['trial_requested', 'trial_booked'].includes(a.stage)) {
          const seat = await one(`SELECT s.id, s.title, s.starts_at, s.ends_at, s.timezone FROM academy_attendance t JOIN academy_sessions s ON s.id=t.session_id WHERE t.application_id=$1 AND t.status IN ('expected','present','late','left_early') ORDER BY t.id DESC LIMIT 1`, [a.id]);
          a.trial = seat ? { session: { ...seat, ...localView(seat) } } : null;
        }
      }
      const enrolments = await many(
        `SELECT e.id, e.status, e.cohort_id, k.name AS cohort, e.programme_id, pr.title AS programme, pr.sport, pr.starts_on, pr.ends_on, o.name AS organisation, k.organisation_id, ${SESSIONS_SQL} AS sessions_left, e.enrolled_at
           FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN academy_programmes pr ON pr.id=e.programme_id JOIN organisations o ON o.id=k.organisation_id
          WHERE e.user_id=$1 ORDER BY e.enrolled_at DESC, e.id LIMIT 50`, [p.id]);
      const charges = await many(
        `SELECT ch.id, ch.kind, ch.due_on, ch.currency, ch.amount_minor, ch.gross_minor, ch.discount_minor, ch.funded_minor, ch.funding_source, ch.status, ch.paid_at, ch.enrolment_id, ch.application_id, (ch.status='awaiting_payment' AND ch.due_on < current_date) AS overdue, ${INVOICE_SQL} AS invoice_id, ${INVOICE_NO_SQL} AS invoice_number
           FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
          WHERE ch.payer_id=$1 AND coalesce(e.user_id, a.athlete_id)=$2 ORDER BY ch.due_on, ch.id LIMIT 100`, [user.id, p.id]);
      const todo = [];
      for (const a of apps.filter((x) => ['enquiry', 'application_draft', 'trial_completed', 'offered'].includes(x.stage))) {
        const v = await one('SELECT v.policy_version_ids FROM academy_applications a JOIN academy_programme_versions v ON v.id=a.version_id WHERE a.id=$1', [a.id]);
        const missing = v ? await outstandingPolicies(pool, p.id, v.policy_version_ids) : [];
        if (missing.length) todo.push({ application_id: a.id, programme: a.programme, agreements: missing.map((m) => ({ version_id: m.version_id, title: m.title })) });
      }
      const certificates = await many(
        `SELECT c.id, c.kind, c.title, c.code, c.issued_on, c.show_on_profile, o.name AS institution FROM credentials c JOIN organisations o ON o.id=c.organisation_id
          WHERE c.user_id=$1 AND c.status='issued' AND c.enrolment_id IS NOT NULL ORDER BY c.issued_on DESC, c.id LIMIT 20`, [p.id]);
      out.push({ athlete: p, applications: apps, enrolments, charges, certificates, to_do: todo });
    }
    return { people: out, due: money(await many("SELECT currency, sum(amount_minor)::bigint AS due_minor, count(*)::int AS charges FROM academy_charges WHERE payer_id=$1 AND status='awaiting_payment' GROUP BY currency ORDER BY currency", [user.id])) };
  },
});

// ------------------------------------------------------------------ operational dashboard (not the academy P&L)
cap({
  name: 'get_academy_dashboard', method: 'GET', path: '/organisations/:id/academy/dashboard', tag: 'Academy',
  summary: 'Live admissions and commercial dashboard (owner/admin; finance sees the money section): programmes, capacity/filled/waitlisted, funnel, enrolments, billed/paid/outstanding per currency, funded seats, families and weekly fill. Operational reporting, not profit and loss.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, STAFF_MONEY);
    const money_ = {
      by_currency: await many(
        `SELECT currency, coalesce(sum(amount_minor) FILTER (WHERE status IN ('awaiting_payment','paid','refunded')),0)::bigint AS billed_minor, coalesce(sum(amount_minor) FILTER (WHERE status='paid'),0)::bigint AS paid_minor,
                coalesce(sum(amount_minor) FILTER (WHERE status='awaiting_payment'),0)::bigint AS outstanding_minor, coalesce(sum(amount_minor) FILTER (WHERE status='awaiting_payment' AND due_on < current_date),0)::bigint AS overdue_minor,
                coalesce(sum(amount_minor) FILTER (WHERE status='awaiting_payment' AND due_on BETWEEN current_date AND current_date + 14),0)::bigint AS due_14d_minor
           FROM academy_charges WHERE organisation_id=$1 GROUP BY currency ORDER BY currency`, [i.id]),
      funded: await many("SELECT funding_source, currency, count(*)::int AS charges, sum(funded_minor)::bigint AS funded_minor FROM academy_charges WHERE organisation_id=$1 AND funded_minor > 0 GROUP BY funding_source, currency ORDER BY funding_source, currency", [i.id]),
      note: 'Paid means the customer paid. It does not mean the academy has been paid out.',
    };
    if (role === 'finance') return { money: money_ };
    const programmes = await many(
      `SELECT p.id, p.title, p.status, p.capacity, (SELECT count(*)::int FROM org_enrolments e WHERE e.programme_id=p.id AND e.status IN ('enrolled','paused')) AS filled,
              (SELECT count(*)::int FROM academy_applications a WHERE a.programme_id=p.id AND a.stage IN ('offered','offer_accepted') AND (a.offer_expires_at IS NULL OR a.offer_expires_at>now())) AS offers_held,
              (SELECT count(*)::int FROM academy_applications a WHERE a.programme_id=p.id AND a.stage='waitlisted') AS waitlisted
         FROM academy_programmes p WHERE p.organisation_id=$1 AND p.status IN ('published','closed') ORDER BY p.title, p.id`, [i.id]);
    const stages = await many('SELECT stage, count(*)::int AS n FROM academy_applications WHERE organisation_id=$1 GROUP BY stage ORDER BY stage', [i.id]);
    const flow = await one(
      `SELECT count(*) FILTER (WHERE e.status='enrolled' AND e.enrolled_at > now() - interval '30 days')::int AS new_30d, count(*) FILTER (WHERE e.status='withdrawn' AND e.withdrawn_at > now() - interval '30 days')::int AS withdrawn_30d,
              count(*) FILTER (WHERE e.status IN ('enrolled','paused'))::int AS active
         FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.programme_id IS NOT NULL`, [i.id]);
    const families = await one(
      `SELECT count(DISTINCT ch.payer_id)::int AS payers, count(DISTINCT ch.payer_id) FILTER (WHERE kids.n > 1)::int AS multi_child
         FROM academy_charges ch LEFT JOIN LATERAL (SELECT count(DISTINCT e2.user_id)::int AS n FROM academy_charges c2 JOIN org_enrolments e2 ON e2.id=c2.enrolment_id WHERE c2.payer_id=ch.payer_id AND c2.organisation_id=ch.organisation_id) kids ON true
        WHERE ch.organisation_id=$1`, [i.id]);
    const trend = await many(
      `SELECT date_trunc('week', e.enrolled_at)::date AS week, count(*)::int AS enrolled FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id
        WHERE k.organisation_id=$1 AND e.programme_id IS NOT NULL AND e.enrolled_at > now() - interval '8 weeks' GROUP BY 1 ORDER BY 1`, [i.id]);
    const outstanding_actions = await one(
      `SELECT count(*) FILTER (WHERE stage IN ('submitted','under_review'))::int AS applications_to_review, count(*) FILTER (WHERE stage='offered' AND offer_expires_at < now() + interval '48 hours')::int AS offers_expiring,
              count(*) FILTER (WHERE next_action_on <= current_date AND stage NOT IN ('enrolled','declined','withdrawn','expired','cancelled'))::int AS follow_ups_due
         FROM academy_applications WHERE organisation_id=$1`, [i.id]);
    const inbox = [
      ...(await many("SELECT a.id, u.display_name, p.title, a.stage, a.updated_at FROM academy_applications a JOIN users u ON u.id=a.athlete_id JOIN academy_programmes p ON p.id=a.programme_id WHERE a.organisation_id=$1 AND a.stage IN ('submitted','under_review') ORDER BY a.updated_at, a.id LIMIT 8", [i.id])).map((r) => ({ kind: 'review', application_id: r.id, title: `Review ${r.display_name}`, sub: `${r.title} · waiting ${Math.max(0, Math.floor((Date.now() - new Date(r.updated_at)) / 864e5))} days`, at: r.updated_at })),
      ...(await many("SELECT a.id, u.display_name, p.title, a.offer_expires_at FROM academy_applications a JOIN users u ON u.id=a.athlete_id JOIN academy_programmes p ON p.id=a.programme_id WHERE a.organisation_id=$1 AND a.stage='offered' AND a.offer_expires_at < now() + interval '48 hours' ORDER BY a.offer_expires_at, a.id LIMIT 8", [i.id])).map((r) => ({ kind: 'offer_expiring', application_id: r.id, title: `${r.display_name}'s offer is about to expire`, sub: r.title, at: r.offer_expires_at })),
      ...(await many("SELECT a.id, u.display_name, a.next_action, a.next_action_on FROM academy_applications a JOIN users u ON u.id=a.athlete_id WHERE a.organisation_id=$1 AND a.next_action_on <= current_date AND a.stage NOT IN ('enrolled','declined','withdrawn','expired','cancelled') ORDER BY a.next_action_on, a.id LIMIT 8", [i.id])).map((r) => ({ kind: 'follow_up', application_id: r.id, title: `${r.next_action || 'Follow up'} · ${r.display_name}`, sub: `Due ${String(r.next_action_on).slice(0, 10)}`, at: r.next_action_on })),
      ...(await many("SELECT ch.currency, count(*)::int AS n, sum(ch.amount_minor)::bigint AS total FROM academy_charges ch WHERE ch.organisation_id=$1 AND ch.status='awaiting_payment' AND ch.due_on < current_date GROUP BY ch.currency ORDER BY ch.currency", [i.id])).map((r) => ({ kind: 'overdue', title: `${r.n} overdue payment${r.n === 1 ? '' : 's'} (${r.currency})`, sub: `${r.total} minor units outstanding`, currency: r.currency, amount_minor: r.total })),
    ];
    return { programmes, stages, enrolments: flow, families, fill_trend: trend, outstanding_actions, inbox, money: money_ };
  },
});

