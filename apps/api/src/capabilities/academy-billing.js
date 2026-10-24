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
import { STAFF_MONEY, outstandingPolicies, waitlistPosition, planCharges, actFor } from '../academy.js';

const money = (rows, key = 'currency') => Object.fromEntries(rows.map((r) => [r[key], r]));

cap({
  name: 'list_academy_charges', method: 'GET', path: '/organisations/:id/charges', tag: 'Academy',
  summary: 'Tuition, deposit and instalment charges of the academy by status (owner/admin/finance). Amounts are the snapshot taken at enrolment.',
  input: z.object({ id, status: z.enum(['awaiting_payment', 'paid', 'cancelled', 'waived', 'refunded']).optional(), overdue: z.boolean().optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    return many(
      `SELECT ch.id, ch.enrolment_id, ch.application_id, ch.kind, ch.seq, ch.due_on, ch.currency, ch.gross_minor, ch.discount_minor, ch.funded_minor, ch.funding_source, ch.tax_minor, ch.amount_minor, ch.status, ch.paid_at,
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
    const give = await refundPartial(pay, i.amount_minor ?? Number(pay.amount_cents), `academy-refund:${ch.id}:${i.idempotency_key}`);
    const after = await one('SELECT * FROM payments WHERE id=$1', [pay.id]);
    if (Number(after.refunded_cents) >= Number(after.amount_cents)) await one("UPDATE academy_charges SET status='refunded' WHERE id=$1 RETURNING id", [ch.id]);
    await audit(null, user.id, 'refund_academy_charge', 'academy_charges', ch.id);
    return { refunded_minor: give, currency: pay.currency, charge_status: Number(after.refunded_cents) >= Number(after.amount_cents) ? 'refunded' : 'paid' };
  },
});

cap({
  name: 'quote_academy_enrolment', method: 'GET', path: '/academy/programmes/:id/quote', tag: 'Academy',
  summary: 'The exact price and due dates an athlete would be charged if enrolled today, with any sibling / second-programme discount already applied. Nothing is created. The athlete themselves or their verified guardian can ask.',
  input: z.object({ id, athlete_id: id.optional() }),
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
    const lines = planCharges(v, { today, sibling, multi, programme: p }).map((r) => ({ kind: r.kind, due_on: r.due_on, currency: r.currency, gross_minor: r.gross_minor, discount_minor: r.discount_minor, amount_minor: r.amount_minor, discount_reason: r.terms.discount_reason ?? null }));
    const total = lines.reduce((t, r) => t + r.amount_minor, 0);
    return { programme_id: p.id, version: v.version, billing_model: v.billing_model, currency: v.currency, lines, total_minor: total, today_minor: lines.filter((r) => r.due_on <= today).reduce((t, r) => t + r.amount_minor, 0), renewal_terms: v.renewal_terms, discount_applied: lines.some((r) => r.discount_minor > 0), note: v.billing_model === 'monthly' ? 'Later months are raised a week before each is due. Nothing is charged automatically.' : 'Nothing is charged until you are enrolled, and nothing is charged automatically.' };
  },
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
      }
      const enrolments = await many(
        `SELECT e.id, e.status, e.cohort_id, k.name AS cohort, e.programme_id, pr.title AS programme, pr.sport, pr.starts_on, pr.ends_on, o.name AS organisation, k.organisation_id, e.sessions_left, e.enrolled_at
           FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN academy_programmes pr ON pr.id=e.programme_id JOIN organisations o ON o.id=k.organisation_id
          WHERE e.user_id=$1 ORDER BY e.enrolled_at DESC, e.id LIMIT 50`, [p.id]);
      const charges = await many(
        `SELECT ch.id, ch.kind, ch.due_on, ch.currency, ch.amount_minor, ch.gross_minor, ch.discount_minor, ch.funded_minor, ch.funding_source, ch.status, ch.paid_at, ch.enrolment_id, ch.application_id, (ch.status='awaiting_payment' AND ch.due_on < current_date) AS overdue
           FROM academy_charges ch LEFT JOIN org_enrolments e ON e.id=ch.enrolment_id LEFT JOIN academy_applications a ON a.id=ch.application_id
          WHERE ch.payer_id=$1 AND coalesce(e.user_id, a.athlete_id)=$2 ORDER BY ch.due_on, ch.id LIMIT 100`, [user.id, p.id]);
      const todo = [];
      for (const a of apps.filter((x) => ['enquiry', 'application_draft', 'trial_completed', 'offered'].includes(x.stage))) {
        const v = await one('SELECT v.policy_version_ids FROM academy_applications a JOIN academy_programme_versions v ON v.id=a.version_id WHERE a.id=$1', [a.id]);
        const missing = v ? await outstandingPolicies(pool, p.id, v.policy_version_ids) : [];
        if (missing.length) todo.push({ application_id: a.id, programme: a.programme, agreements: missing.map((m) => ({ version_id: m.version_id, title: m.title })) });
      }
      out.push({ athlete: p, applications: apps, enrolments, charges, to_do: todo });
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

