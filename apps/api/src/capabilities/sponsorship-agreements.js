// Sponsorship agreement operation (#145): schedule preview, exact-version revision, dues, payments, goods and endorsement fulfilment.
// All of it hangs off the canonical `sponsorships` row (see sponsors.js); nothing here is a second sponsorship system.
import { z } from 'zod';
import { notifyRecipient, assertYouthAuthority, assertYouthContact, liveAuthority, guardedAthleteSql, livePayee } from '../youth-sponsorship.js';
import { requireConsent, hasConsent, guardianLink, guardiansOf } from '../youth.js';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { LINE, buildSchedule } from '../sponsor-schedule.js';
import { snapshotIdentity } from '../sponsor-identity-access.js';
import { saveLines, loadLines, generateObligations, logHistory, dealContext, obligationContext, recordVersion, settleMoney, settleGoods, completeIfSettled, goodsPosition, heldCents, releaseStaleCheckouts } from '../sponsor-agreements.js';
import { enabledProviders, startCheckout } from '../payments/service.js';
import { config } from '../config.js';
import { beneficiaryScopeSql, payeeSnapshot } from '../sponsor-beneficiaries.js';
import { notifySponsor, sponsorStaffSql, actionsFor } from '../sponsor-access.js';
import { costOf } from '../sponsorship-budgets.js';
import { currentPause } from '../sponsor-pause.js';
import { renewalView } from '../sponsor-renewals.js';

const date = z.string().date();
const url = z.string().url().max(500).refine((u) => /^https:\/\//i.test(u), 'evidence must be an https link');
/** Who is to be paid for a young athlete's agreement (frozen on each payment); null for everyone else. A young athlete's money is never paid to the minor. */
async function payeeFor(c, ctx) {
  if (!ctx.youth) return null;
  const to = await livePayee(c, ctx.d);
  if (!to && !(await guardiansOf(ctx.d.target_id, c)).length) return null; // an agreement made before any guardian existed keeps paying the recipient as before
  if (!to) throw conflict('No verified guardian is set to receive this money yet. Ask the guardian to confirm who is paid.', { code: 'payee_required' });
  return to;
}
const other = (ctx) => (ctx.role === 'sponsor' ? ctx.recipientId : 'sponsor');
// Notifications never carry amounts, references or terms: those stay behind the participant-scoped reads.
// `to` is a user id, or 'sponsor' for the brand's owner and the staff whose role is concerned (`action`).
export const ping = (c, to, title, ctx, kind = 'sponsorship_update', action = 'read') => {
  const msg = { kind, title, body: `Open the ${ctx.sp.name} agreement to see the update.`, data: { sponsorship_id: ctx.d.id } };
  return to === 'sponsor' ? notifySponsor(c, ctx.sp, action, msg, ctx.d.department_id) : notifyRecipient(c, to, msg);
};

cap({
  name: 'preview_sponsorship_schedule', method: 'POST', path: '/sponsorship-schedule/preview', tag: 'Sponsors',
  summary: 'Review the complete dated schedule a set of contribution lines produces, before proposing or accepting. Month-end dates clamp (31 Jan, 28/29 Feb, 31 Mar), both ends of the period are inclusive, nothing may fall outside the period, and a split total puts the rounding remainder on the last instalment. Cash is totalled per currency; estimates are kept separate and are never cash.',
  input: z.object({ lines: z.array(LINE).min(1).max(12), starts_on: date.optional(), ends_on: date.optional() }),
  handler: async (_, i) => {
    if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
    return buildSchedule(i.lines, { starts_on: i.starts_on, ends_on: i.ends_on });
  },
});

cap({
  name: 'revise_sponsorship', method: 'POST', path: '/sponsorships/:id/revise', tag: 'Sponsors',
  summary: 'Negotiate the terms of an offer that has not been answered, from either side. The sponsor revises its own offer; the recipient makes a counteroffer (`expected_version` is required for them, and a stale one is rejected). Either way this creates a new numbered version, the OTHER side must sign off that exact version, and nothing becomes active until it does. (Changing an accepted agreement needs a mutually accepted amendment, which is not available yet.)',
  input: z.object({ id, lines: z.array(LINE).min(1).max(12), starts_on: date.optional(), ends_on: date.optional(), timezone: z.string().max(60).optional(), reason: z.string().max(500).optional(),
    expected_version: z.coerce.number().int().positive().optional().describe('the version these changes are based on; required for a recipient counteroffer') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (ctx.role !== 'sponsor' && ctx.role !== 'recipient') throw forbidden('Only the sponsor or the recipient can negotiate the terms');
      if (ctx.role === 'sponsor') ctx.need('revise', 'revise the terms of an offer');
      await assertYouthAuthority(c, ctx);
      if (ctx.d.status !== 'proposed') throw conflict('Only an unanswered offer can be negotiated');
      if ((ctx.role === 'recipient' || i.expected_version != null) && i.expected_version !== ctx.d.terms_version) {
        if (i.expected_version == null) throw badRequest('Say which version your counteroffer is based on (expected_version)');
        throw conflict(`These terms changed (now version ${ctx.d.terms_version}); review them again before making changes`);
      }
      const starts = i.starts_on ?? ctx.d.starts, ends = i.ends_on ?? ctx.d.ends;
      if (starts && ends && ends < starts) throw badRequest('ends_on is before starts_on');
      const plan = buildSchedule(i.lines, { starts_on: starts, ends_on: ends });
      const cash = Object.entries(plan.committed), v = ctx.d.terms_version + 1, tz = i.timezone ?? ctx.d.timezone;
      await saveLines(c, ctx.d.id, v, i.lines);
      if (ctx.role === 'sponsor') await snapshotIdentity(c, ctx.d.id, v, ctx.sp.id, user.id); // a counteroffer freezes the brand only once the brand signs it off
      await recordVersion(c, ctx.d.id, v, ctx.role, user.id, { reason: i.reason, starts, ends, tz });
      const row = (await c.query('UPDATE sponsorships SET terms_version=$2, terms_side=$8, starts_on=$3, ends_on=$4, timezone=$5, amount_cents=$6, currency=$7, agreement_ref=coalesce(agreement_ref, \'SPA-\'||upper(substr(id::text,1,8))) WHERE id=$1 RETURNING *',
        [ctx.d.id, v, starts ?? null, ends ?? null, tz, cash.length === 1 ? cash[0][1] : 0, cash.length === 1 ? cash[0][0] : null, ctx.role])).rows[0];
      await logHistory(c, ctx.d.id, v, user.id, ctx.role === 'recipient' ? 'counter_offered' : 'revised', i.reason);
      // a budget-controlled offer is re-checked at its new size: one currency, a sourced rate, and a fresh approval when it is above the threshold (#293)
      let held = false;
      if (ctx.d.budget_id) {
        if (cash.length !== 1) throw unprocessable('A budget-controlled offer needs money lines in exactly one currency');
        const b = (await c.query('SELECT * FROM sponsorship_budgets WHERE id=$1', [ctx.d.budget_id])).rows[0];
        const cost = await costOf(c, b, cash[0][0], cash[0][1]);
        held = b.approval_over_cents != null && cost.cents > Number(b.approval_over_cents);
        await c.query('UPDATE sponsorships SET budget_fx_rate_id=$2, budget_approval=$3, budget_approval_by=NULL, budget_approval_at=NULL, budget_approval_note=NULL WHERE id=$1', [ctx.d.id, cost.rateId, held ? 'pending' : null]);
        if (held) await notifySponsor(c, ctx.sp, 'budget_approve', { kind: 'sponsorship_budget', title: 'A revised offer needs budget approval', body: `A revised offer is above the approval threshold of "${b.name}".`, data: { sponsorship_id: ctx.d.id, budget_id: b.id } }, ctx.d.department_id, user.id);
      }
      if (!held) {
        if (ctx.role === 'recipient') await ping(c, 'sponsor', 'The recipient made a counteroffer', ctx, 'sponsorship_update', 'sign_off');
        else await ping(c, ctx.recipientId, 'A sponsorship offer was revised', ctx);
      }
      return { ...row, schedule: plan };
    });
  },
});

cap({
  name: 'withdraw_sponsorship_counter', method: 'POST', path: '/sponsorships/:id/withdraw-counter', tag: 'Sponsors',
  summary: 'Take back your own latest change while the offer is still open: the earlier terms the other side wrote are re-issued as a new version (nothing is deleted); the side that wrote those terms cannot sign them off itself, so the other side decides next. To take the whole offer back, a sponsor uses withdraw_sponsorship.',
  input: z.object({ id, expected_version: z.coerce.number().int().positive(), reason: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (ctx.role !== 'sponsor' && ctx.role !== 'recipient') throw forbidden('Only the sponsor or the recipient can negotiate the terms');
      if (ctx.role === 'sponsor') ctx.need('revise', 'withdraw a change to the terms');
      if (ctx.d.status !== 'proposed') throw conflict('Only an unanswered offer can be negotiated');
      if (i.expected_version !== ctx.d.terms_version) throw conflict(`These terms changed (now version ${ctx.d.terms_version}); review them again first`);
      if (ctx.d.terms_side !== ctx.role) throw conflict('The current terms are not yours to take back');
      const back = (await c.query("SELECT version, authored_side, authored_by FROM sponsorship_versions WHERE sponsorship_id=$1 AND version < $2 AND authored_side <> $3 ORDER BY version DESC LIMIT 1", [ctx.d.id, ctx.d.terms_version, ctx.role])).rows[0];
      if (!back) throw conflict('There are no earlier terms from the other side to go back to');
      const v = ctx.d.terms_version + 1;
      await c.query(
        `INSERT INTO sponsorship_lines(sponsorship_id, version, position, kind, label, currency, amount_cents, total_cents, estimate_cents, quantity, unit, cadence, first_due_on, instalments, custom_dates, promoter, terms)
         SELECT sponsorship_id, $3, position, kind, label, currency, amount_cents, total_cents, estimate_cents, quantity, unit, cadence, first_due_on, instalments, custom_dates, promoter, terms
           FROM sponsorship_lines WHERE sponsorship_id=$1 AND version=$2`, [ctx.d.id, back.version, v]);
      await c.query(
        `INSERT INTO sponsorship_identity_snapshots(sponsorship_id, version, sponsor_id, entity_id, display_name, legal_name, sponsor_type, signed_by)
         SELECT sponsorship_id, $3, sponsor_id, entity_id, display_name, legal_name, sponsor_type, signed_by FROM sponsorship_identity_snapshots WHERE sponsorship_id=$1 AND version=$2 ON CONFLICT DO NOTHING`, [ctx.d.id, back.version, v]);
      const old = (await c.query('SELECT starts_on::text AS starts, ends_on::text AS ends, timezone FROM sponsorship_versions WHERE sponsorship_id=$1 AND version=$2', [ctx.d.id, back.version])).rows[0];
      const starts = old.starts ?? ctx.d.starts, ends = old.ends ?? ctx.d.ends, tz = old.timezone ?? ctx.d.timezone;
      const lines = await loadLines(c, ctx.d.id, v), plan = buildSchedule(lines, { starts_on: starts, ends_on: ends }), cash = Object.entries(plan.committed);
      await recordVersion(c, ctx.d.id, v, back.authored_side, back.authored_by, { reason: i.reason, restores: back.version, starts, ends, tz });
      const row = (await c.query('UPDATE sponsorships SET terms_version=$2, terms_side=$8, starts_on=$3, ends_on=$4, timezone=$5, amount_cents=$6, currency=$7 WHERE id=$1 RETURNING *',
        [ctx.d.id, v, starts ?? null, ends ?? null, tz, cash.length === 1 ? cash[0][1] : 0, cash.length === 1 ? cash[0][0] : null, back.authored_side])).rows[0];
      await logHistory(c, ctx.d.id, v, user.id, 'change_withdrawn', i.reason ?? `Version ${back.version} terms re-issued`);
      if (ctx.role === 'recipient') await ping(c, 'sponsor', 'The recipient withdrew their counteroffer', ctx);
      else await ping(c, ctx.recipientId, 'The sponsor withdrew their latest change', ctx);
      return { ...row, schedule: plan };
    });
  },
});

cap({
  name: 'comment_on_sponsorship', method: 'POST', path: '/sponsorships/:id/comments', tag: 'Sponsors', status: 201,
  summary: 'Comment on the terms of an offer (a version, optionally one contribution line). A `shared` comment is visible to both sides and, for the brand, needs the right to speak for it (not an evaluator or finance role); an `internal` note is a private working note visible only to your own side: the other side and platform admins never see it.',
  input: z.object({ id, body: z.string().min(1).max(2000), version: z.coerce.number().int().positive().optional(), line_position: z.coerce.number().int().positive().optional(), visibility: z.enum(['shared', 'internal']).default('shared') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await dealContext(c, i.id, user, { lock: true });
      if (ctx.role !== 'sponsor' && ctx.role !== 'recipient') throw forbidden('Only the sponsor or the recipient can comment on the terms');
      if (ctx.role === 'sponsor' && i.visibility === 'shared') { ctx.need('revise', 'speak for the brand in a negotiation'); await assertYouthContact(c, ctx); }
      if (i.visibility === 'shared' && ctx.d.status !== 'proposed') throw conflict('Terms can only be discussed with the other side while the offer is open');
      const version = i.version ?? ctx.d.terms_version;
      if (version > ctx.d.terms_version) throw badRequest('That version does not exist');
      if (i.line_position != null && !(await c.query('SELECT 1 FROM sponsorship_lines WHERE sponsorship_id=$1 AND version=$2 AND position=$3', [ctx.d.id, version, i.line_position])).rowCount) throw badRequest('That line is not part of this version');
      const row = (await c.query('INSERT INTO sponsorship_comments(sponsorship_id, version, line_position, side, visibility, author_id, body) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version, line_position, side, visibility, body, created_at',
        [ctx.d.id, version, i.line_position ?? null, ctx.role, i.visibility, user.id, i.body])).rows[0];
      if (i.visibility === 'shared') await ping(c, ctx.role === 'sponsor' ? ctx.recipientId : 'sponsor', 'New comment on a sponsorship offer', ctx);
      return row;
    });
  },
});

const COMPARED = ['kind', 'currency', 'amount_cents', 'total_cents', 'estimate_cents', 'quantity', 'unit', 'cadence', 'first_due_on', 'instalments', 'custom_dates', 'promoter', 'terms'];
const norm = (l) => Object.fromEntries(COMPARED.map((k) => [k, l[k] ?? null]));
cap({
  name: 'compare_sponsorship_versions', method: 'GET', path: '/sponsorships/:id/compare', tag: 'Sponsors',
  summary: 'What changed between two versions of the terms: lines added, removed or changed (matched by label) with each changed field before and after, and the period. Amounts are shown per currency and never combined. Defaults to the previous version against the current one.',
  input: z.object({ id, from: z.coerce.number().int().positive().optional(), to: z.coerce.number().int().positive().optional() }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    const to = i.to ?? ctx.d.terms_version, from = i.from ?? to - 1;
    if (from < 1 || to > ctx.d.terms_version || from === to) throw badRequest(`Choose two different versions between 1 and ${ctx.d.terms_version}`);
    const meta = (v) => one("SELECT v.version, v.authored_side, v.reason, v.restores, v.starts_on::text AS starts_on, v.ends_on::text AS ends_on, v.timezone, v.created_at, v.signed_off_at, u.display_name AS author FROM sponsorship_versions v LEFT JOIN users u ON u.id=v.authored_by WHERE v.sponsorship_id=$1 AND v.version=$2", [ctx.d.id, v]);
    const [a, b, la, lb] = await Promise.all([meta(from), meta(to), loadLines(pool, ctx.d.id, from), loadLines(pool, ctx.d.id, to)]);
    if (!a || !b) throw notFound('Version');
    const key = (l) => `${l.kind}:${l.label.trim().toLowerCase()}`;
    const left = new Map(la.map((l) => [key(l), l])), changes = [];
    for (const l of lb) {
      const o = left.get(key(l));
      if (!o) { changes.push({ type: 'added', label: l.label, kind: l.kind, to: norm(l) }); continue; }
      left.delete(key(l));
      const x = norm(o), y = norm(l), fields = COMPARED.filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])).map((k) => ({ field: k, from: x[k], to: y[k] }));
      if (fields.length) changes.push({ type: 'changed', label: l.label, kind: l.kind, currency: l.currency ?? o.currency ?? null, fields });
    }
    for (const o of left.values()) changes.push({ type: 'removed', label: o.label, kind: o.kind, from: norm(o) });
    const period = ['starts_on', 'ends_on', 'timezone'].filter((k) => a[k] && b[k] && a[k] !== b[k]).map((k) => ({ field: k, from: a[k], to: b[k] }));
    return { from: a, to: b, period, period_comparable: !!(a.starts_on || a.ends_on) && !!(b.starts_on || b.ends_on) || a.timezone != null, changes, unchanged: !changes.length && !period.length };
  },
});

cap({
  name: 'get_sponsorship', method: 'GET', path: '/sponsorships/:id', tag: 'Sponsors',
  summary: 'One agreement, for its sponsor or its recipient (or an admin): the exact terms version, contribution lines, the schedule (a preview until accepted, then the real dues with payments, deliveries and endorsement submissions), and the history. Estimates are labelled as such and never counted as cash.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await dealContext(pool, i.id, user);
    const { d, sp } = ctx;
    if (ctx.role === 'recipient' && ['pending', 'rejected'].includes(d.budget_approval)) throw notFound('Sponsorship'); // still the brand's internal business
    const version = d.accepted_version ?? d.terms_version;
    const lines = await many('SELECT id, position, kind, service_type, label, currency, amount_cents, total_cents, estimate_cents, quantity, unit, cadence, first_due_on, instalments, custom_dates, promoter, terms FROM sponsorship_lines WHERE sponsorship_id=$1 AND version=$2 ORDER BY position', [d.id, version]);
    const out = { id: d.id, agreement_ref: d.agreement_ref, status: d.status, role: ctx.role, my_sponsor_role: ctx.staff, can: ctx.staff ? actionsFor(ctx.staff) : undefined, sponsor: { id: sp.id, name: sp.name }, target_type: d.target_type, target_id: d.target_id, starts_on: d.starts_on, ends_on: d.ends_on, timezone: d.timezone, terms_version: d.terms_version, accepted_version: d.accepted_version, currency: d.currency, pause_rev: d.pause_rev, legacy_amount_cents: lines.length ? undefined : d.amount_cents, legacy_in_kind: lines.length ? undefined : d.in_kind, objectives: d.objectives, deliverables: d.deliverables, lines };
    if (ctx.youth) { // a young athlete's agreement: who acts for them and what the guardian currently allows (separate from the agreement itself)
      out.youth = { guardian_acting: ctx.guardian, minor_self: ctx.minorSelf, guardian_decided_at: d.guardian_decided_at ?? null,
        authority_live: !!(await liveAuthority(pool, d.sponsor_id, d.target_id)), results_shared: !!d.performance_access && !!(await liveAuthority(pool, d.sponsor_id, d.target_id)) && !!(d.performance_access_by && await guardianLink(d.performance_access_by, d.target_id)),
        media_allowed: await hasConsent(d.target_id, 'media'), contact_allowed: await hasConsent(d.target_id, 'contact'),
        payee_set: !!(await livePayee(pool, d)) };
      if (ctx.guardian || isAdmin(user)) { // names of the verified guardians, so one of them can be chosen as payee
        const ids = await guardiansOf(d.target_id, pool);
        out.youth.guardians = (await many('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[]) ORDER BY display_name, id', [ids])).map((g) => ({ id: g.id, name: g.display_name, payee: g.id === d.payee_guardian_id }));
      }
    }
    if (['organisation', 'group'].includes(d.target_type)) out.beneficiary = { type: d.target_type, id: d.target_id, name: (await one(d.target_type === 'group' ? 'SELECT name FROM org_cohorts WHERE id=$1' : 'SELECT name FROM organisations WHERE id=$1', [d.target_id]))?.name ?? null, my_role: ctx.beneficiary?.representative ? 'representative' : ctx.beneficiary?.payee ? 'payee' : null };
    // who the sponsor was at this exact version (frozen): later renames or representative changes never alter it. Never registration/tax/billing data.
    const snap = (await pool.query('SELECT s.display_name, s.legal_name, s.sponsor_type, u.display_name AS signed_by FROM sponsorship_identity_snapshots s LEFT JOIN users u ON u.id=s.signed_by WHERE s.sponsorship_id=$1 AND s.version=$2', [d.id, version])).rows[0];
    out.sponsor_identity = snap ?? null;
    if (d.program_id) out.program = await one('SELECT p.id, p.name, r.seq AS round_seq, r.name AS round_name FROM sponsorship_programs p JOIN sponsorship_rounds r ON r.id=$2 WHERE p.id=$1', [d.program_id, d.round_id]);
    // who the sponsor was at this exact version (frozen): later renames or representative changes never alter it. Never registration/tax/billing data.
    out.sponsor_identity = (await pool.query('SELECT s.display_name, s.legal_name, s.sponsor_type, u.display_name AS signed_by FROM sponsorship_identity_snapshots s LEFT JOIN users u ON u.id=s.signed_by WHERE s.sponsorship_id=$1 AND s.version=$2', [d.id, version])).rows[0] ?? null;
    if (!d.accepted_version && lines.length) out.schedule = buildSchedule(await loadLines(pool, d.id, version), { starts_on: d.starts, ends_on: d.ends });
    if (d.accepted_version) {
      out.obligations = await obligationRows('o.sponsorship_id = $1', [d.id]);
      const kids = (t, cols) => many(`SELECT x.obligation_id, ${cols} FROM ${t} x JOIN sponsorship_obligations o ON o.id=x.obligation_id WHERE o.sponsorship_id=$1 ORDER BY x.created_at, x.id`, [d.id]);
      const [pay, del, sub, ret, vou] = await Promise.all([
        kids('sponsorship_payments', 'x.id, x.amount_cents, x.currency, x.method, x.reference, x.paid_on::text AS paid_on, x.evidence_url, x.status, x.decision_note, x.payee_snapshot'),
        kids('sponsorship_deliveries', 'x.id, x.version, x.quantity, x.reference, x.note, x.status, x.received_quantity, x.decision_note, x.dispatch_evidence_url, x.receipt_evidence_url, x.rejection_reason, x.replaces_return_id'),
        kids('sponsorship_submissions', 'x.id, x.evidence_url, x.note, x.status, x.review_note'),
        kids('sponsorship_delivery_returns', 'x.id, x.delivery_id, x.version, x.quantity, x.reason, x.resolution, x.note, x.evidence_url, x.status, x.decision_note'),
        // a voucher's redemption detail (reference, booking) belongs to the recipient; the sponsor sees only that it was used, and when. Medical vouchers never carry detail at all.
        kids('sponsorship_vouchers', `x.id, x.version, x.service_type, x.valid_until::text AS valid_until, (CASE WHEN x.status='issued' AND x.valid_until < current_date THEN 'expired' ELSE x.status END) AS status, x.void_reason,
          (SELECT r.redeemed_at FROM sponsorship_voucher_redemptions r WHERE r.voucher_id=x.id) AS redeemed_at,
          ${ctx.role === 'sponsor' ? 'NULL::text' : '(SELECT r.reference FROM sponsorship_voucher_redemptions r WHERE r.voucher_id=x.id)'} AS reference,
          ${ctx.role === 'sponsor' ? 'false' : '(SELECT r.booking_id IS NOT NULL FROM sponsorship_voucher_redemptions r WHERE r.voucher_id=x.id)'} AS has_booking`)]);
      for (const o of out.obligations) {
        o.payments = pay.filter((r) => r.obligation_id === o.id); o.deliveries = del.filter((r) => r.obligation_id === o.id); o.returns = ret.filter((r) => r.obligation_id === o.id); o.vouchers = vou.filter((r) => r.obligation_id === o.id); o.submissions = sub.filter((r) => r.obligation_id === o.id);
        o.promoter = lines.find((l) => l.id === o.line_id)?.promoter ?? null;
      }
    }
    if (ctx.role !== 'recipient' && d.budget_id) out.budget = await one('SELECT b.id, b.code, b.name, b.kind, b.currency, $2::text AS approval FROM sponsorship_budgets b WHERE b.id=$1', [d.budget_id, d.budget_approval]);
    out.negotiation = await negotiationFor(ctx);
    out.amendments = await amendmentsFor(ctx);
    out.renewal = await renewalView(pool, d);
    if (d.accepted_version) out.pauses = await currentPause(pool, d.id); // both parties see the same agreed policy
    out.history = await many('SELECT h.id, h.version, h.action, h.reason, h.created_at, u.display_name AS actor FROM sponsorship_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.sponsorship_id=$1 ORDER BY h.id', [d.id]);
    return out;
  },
});

/** Obligations with what has actually happened to them. Reported (unverified) money is shown apart from confirmed money. */
async function obligationRows(where, params, tail = '') {
  return many(
    `SELECT o.id, o.sponsorship_id, o.line_id, o.version, o.seq, o.kind, o.cancelled_by_amendment, o.created_by_amendment, o.due_on::text AS due_on, o.amount_cents, o.currency, o.quantity, o.status,
            (o.status = 'scheduled' AND o.due_on < current_date AND o.held_by_pause_id IS NULL) AS overdue, (o.held_by_pause_id IS NOT NULL) AS held, o.original_due_on::text AS original_due_on, l.label,
            coalesce((SELECT sum(amount_cents - refunded_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed'),0)::bigint AS confirmed_cents,
            coalesce((SELECT sum(amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='awaiting_payment'),0)::bigint AS checkout_in_progress_cents,
            coalesce((SELECT sum(refunded_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id),0)::bigint AS refunded_cents, o.conceded_cents,
            coalesce((SELECT sum(amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='reported'),0)::bigint AS reported_unverified_cents,
            coalesce((SELECT sum(CASE x.status WHEN 'received' THEN x.received_quantity WHEN 'dispatched' THEN 0 ELSE 0 END) FROM sponsorship_deliveries x WHERE x.obligation_id=o.id),0)::int AS received_quantity,
            coalesce((SELECT sum(x.quantity) FROM sponsorship_deliveries x WHERE x.obligation_id=o.id AND x.status='dispatched'),0)::int AS in_transit_quantity,
            coalesce((SELECT sum(r.quantity) FROM sponsorship_delivery_returns r WHERE r.obligation_id=o.id AND r.status='accepted'),0)::int AS returned_quantity,
            coalesce((SELECT sum(r.quantity) FROM sponsorship_delivery_returns r WHERE r.obligation_id=o.id AND r.status='accepted' AND r.resolution='credit'),0)::int AS credited_quantity,
            coalesce((SELECT sum(r.quantity) FROM sponsorship_delivery_returns r WHERE r.obligation_id=o.id AND r.status='requested'),0)::int AS return_pending_quantity,
            coalesce((SELECT count(*) FROM sponsorship_vouchers v WHERE v.obligation_id=o.id AND v.status='redeemed'),0)::int AS vouchers_redeemed,
            coalesce((SELECT count(*) FROM sponsorship_vouchers v WHERE v.obligation_id=o.id AND v.status='issued' AND (v.valid_until IS NULL OR v.valid_until >= current_date)),0)::int AS vouchers_open,
            (SELECT s.status FROM sponsorship_submissions s WHERE s.obligation_id=o.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS submission_status
       FROM sponsorship_obligations o JOIN sponsorship_lines l ON l.id=o.line_id WHERE ${where} ORDER BY o.due_on, o.id ${tail}`, params);
}

const SCOPE = `(${sponsorStaffSql(1)} OR $2::boolean
  OR (ss.target_type='event' AND ss.target_id IN (SELECT id FROM events WHERE organizer_id=$1))
  OR (ss.target_type='team' AND ss.target_id IN (SELECT id FROM teams WHERE owner_id=$1)) OR (ss.target_type='athlete' AND ss.target_id=$1) OR ${guardedAthleteSql('ss')} OR ${beneficiaryScopeSql('$1')})`;

cap({
  name: 'list_sponsorship_obligations', method: 'GET', path: '/sponsorship-obligations', tag: 'Sponsors',
  summary: 'Dues across your agreements (as sponsor or recipient). Filters: agreement, brand, target type, kind, state (upcoming / overdue / open / fulfilled), due-date range. `totals` is per currency over every match, not just the page: committed, confirmed received, reported-but-unverified, outstanding. Currencies are never added together.',
  input: z.object({ sponsorship_id: id.optional(), sponsor_id: id.optional(), target_type: z.enum(['event', 'team', 'athlete', 'organisation', 'group']).optional(), kind: z.enum(['money', 'goods', 'endorsement', 'service']).optional(), state: z.enum(['upcoming', 'overdue', 'open', 'fulfilled', 'cancelled']).optional(), from: date.optional(), to: date.optional(), ...page }),
  async handler({ user }, i) {
    const params = [user.id, !!isAdmin(user), i.sponsorship_id ?? null, i.sponsor_id ?? null, i.target_type ?? null, i.kind ?? null, i.state ?? null, i.from ?? null, i.to ?? null];
    const where = `${SCOPE} AND ($3::uuid IS NULL OR o.sponsorship_id=$3) AND ($4::uuid IS NULL OR ss.sponsor_id=$4) AND ($5::text IS NULL OR ss.target_type=$5) AND ($6::text IS NULL OR o.kind=$6)
      AND ($8::date IS NULL OR o.due_on >= $8) AND ($9::date IS NULL OR o.due_on <= $9)
      AND ($7::text IS NULL OR ($7='overdue' AND o.status='scheduled' AND o.due_on < current_date AND o.held_by_pause_id IS NULL) OR ($7='upcoming' AND o.status='scheduled' AND o.due_on >= current_date)
           OR ($7='open' AND o.status='scheduled') OR ($7='fulfilled' AND o.status='fulfilled') OR ($7='cancelled' AND o.status='cancelled'))`;
    const base = `FROM sponsorship_obligations o JOIN sponsorships ss ON ss.id=o.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${where}`;
    const ids = (await many(`SELECT o.id ${base} ORDER BY o.due_on, o.id LIMIT $10 OFFSET $11`, [...params, i.limit, i.offset])).map((r) => r.id);
    const rows = ids.length ? await obligationRows('o.id = ANY($1::uuid[])', [ids]) : [];
    const totals = await many(
      `SELECT o.currency, sum(o.amount_cents) FILTER (WHERE o.status <> 'cancelled')::bigint AS committed_cents,
              coalesce(sum((SELECT sum(p.amount_cents - p.refunded_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='confirmed')),0)::bigint AS confirmed_cents,
              coalesce(sum((SELECT sum(p.amount_cents) FROM sponsorship_payments p WHERE p.obligation_id=o.id AND p.status='reported')),0)::bigint AS reported_unverified_cents,
              coalesce(sum(o.amount_cents) FILTER (WHERE o.status='scheduled' AND o.due_on < current_date AND o.held_by_pause_id IS NULL),0)::bigint AS overdue_cents,
              coalesce(sum(o.conceded_cents) FILTER (WHERE o.status <> 'cancelled'),0)::bigint AS conceded_cents
         ${base} AND o.kind='money' GROUP BY o.currency ORDER BY o.currency`, params);
    for (const t of totals) t.outstanding_cents = t.committed_cents - t.confirmed_cents - t.conceded_cents; // a due conceded by an agreed termination refund is no longer owed (#298)
    return { obligations: rows, totals };
  },
});

cap({
  name: 'get_sponsorship_summary', method: 'GET', path: '/sponsorship-summary', tag: 'Sponsors',
  summary: 'Sponsor / recipient home: agreements by status, dues in the next 30 days, overdue dues, goods still outstanding, endorsements waiting for your review and payments waiting for your confirmation.',
  async handler({ user }) {
    const a = [user.id, !!isAdmin(user)];
    const base = `FROM sponsorship_obligations o JOIN sponsorships ss ON ss.id=o.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${SCOPE}`;
    const recipient = `(ss.target_type='event' AND ss.target_id IN (SELECT id FROM events WHERE organizer_id=$1) OR ss.target_type='team' AND ss.target_id IN (SELECT id FROM teams WHERE owner_id=$1) OR ss.target_type='athlete' AND ss.target_id=$1 OR ${guardedAthleteSql('ss')} OR ${beneficiaryScopeSql('$1')})`;
    const [agreements, counts] = await Promise.all([
      many(`SELECT ss.status, count(*)::int AS n FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${SCOPE} GROUP BY ss.status ORDER BY ss.status`, a),
      one(`SELECT count(*) FILTER (WHERE o.status='scheduled' AND o.due_on < current_date AND o.held_by_pause_id IS NULL)::int AS overdue,
                  count(*) FILTER (WHERE o.status='scheduled' AND o.due_on BETWEEN current_date AND current_date + 30 AND o.held_by_pause_id IS NULL)::int AS due_30_days,
                  count(*) FILTER (WHERE o.kind='goods' AND o.status='scheduled')::int AS goods_outstanding,
                  count(*) FILTER (WHERE o.kind='service' AND o.status='scheduled')::int AS services_outstanding,
                  (SELECT count(*) FROM sponsorship_payments p JOIN sponsorship_obligations po ON po.id=p.obligation_id JOIN sponsorships pss ON pss.id=po.sponsorship_id WHERE p.status='reported' AND ${recipient.replace(/ss\./g, 'pss.')})::int AS payments_to_confirm,
                  (SELECT count(*) FROM sponsorship_submissions s JOIN sponsorship_obligations so ON so.id=s.obligation_id JOIN sponsorship_lines sl ON sl.id=so.line_id JOIN sponsorships sss ON sss.id=so.sponsorship_id JOIN sponsors ssp ON ssp.id=sss.sponsor_id
                    WHERE s.status='submitted' AND ((sl.promoter='recipient' AND ${sponsorStaffSql(1, 'evaluate').replace(/\bsp\./g, 'ssp.').replace(/\bss\./g, 'sss.')}) OR (sl.promoter='sponsor' AND ${recipient.replace(/ss\./g, 'sss.')})))::int AS endorsements_to_review
             ${base}`, a)]);
    return { agreements, ...counts };
  },
});

export const open = (ctx, kind) => {
  if (ctx.o.kind !== kind) throw badRequest(`This obligation is ${ctx.o.kind}, not ${kind}`);
  if (ctx.o.status !== 'scheduled') throw conflict(`This obligation is already ${ctx.o.status}`);
  if (!['active', 'paused', 'ended', 'term_expired'].includes(ctx.d.status)) throw conflict('The agreement is not active');
  if (ctx.o.held_by_pause_id) throw conflict('This due is on hold while the agreement is paused. It can be paid once the agreement resumes.', { code: 'held_by_pause' });
};

cap({
  name: 'report_sponsorship_payment', method: 'POST', path: '/sponsorship-obligations/:id/payments', tag: 'Sponsors', status: 201,
  summary: 'Sponsor owner: report a bank/cash payment against a money due (reference, amount, currency, date, optional https evidence). It stays UNVERIFIED until the recipient confirms it. Partial and multiple payments are allowed, bounded by the amount due; the same reference cannot be reported twice. This does not move money; sportarena does not hold funds or pay recipients out here.',
  input: z.object({ id, amount_cents: z.coerce.number().int().positive(), currency: z.string().length(3).toUpperCase(), method: z.enum(['bank_transfer', 'cash', 'other']), reference: z.string().min(2).max(120), paid_on: date, evidence_url: url.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await obligationContext(c, i.id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor reports its payments');
      ctx.need('pay', 'report payments');
      open(ctx, 'money');
      const unmet = (await c.query("SELECT x.text FROM sponsorship_award_conditions x JOIN sponsorship_awards w ON w.id=x.award_id WHERE w.sponsorship_id=$1 AND x.removed_at IS NULL AND x.blocks_payment AND x.met_at IS NULL ORDER BY x.position LIMIT 1", [ctx.d.id])).rows[0];
      if (unmet) throw conflict(`A condition of the award must be met before payment: ${unmet.text}`); // conditional awards (#289)
      if (i.currency !== ctx.o.currency) throw badRequest(`This due is in ${ctx.o.currency}`);
      const payee = await payeeFor(c, ctx);
      await releaseStaleCheckouts(c, ctx.o.id);
      const held = await heldCents(c, ctx.o.id);
      if (held + i.amount_cents > ctx.o.amount_cents) throw conflict(`Only ${ctx.o.amount_cents - held} is still due on this instalment`);
      try {
        const p = (await c.query('INSERT INTO sponsorship_payments(obligation_id, amount_cents, currency, method, reference, paid_on, evidence_url, reported_by, payee_guardian_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [ctx.o.id, i.amount_cents, i.currency, i.method, i.reference, i.paid_on, i.evidence_url ?? null, user.id, payee])).rows[0];
        await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'payment_reported');
        await ping(c, ctx.recipientId, 'A sponsorship payment needs your confirmation', ctx, 'sponsorship_payment');
        return p;
      } catch (e) { if (e.code === '23505') throw conflict('That payment reference was already reported for this instalment'); throw e; }
    });
  },
});

cap({
  name: 'start_sponsorship_checkout', method: 'POST', path: '/sponsorship-obligations/:id/checkout', tag: 'Sponsors', status: 201,
  summary: 'Sponsor (finance/manager): pay a money due online through Stripe or PayPal, in full or in part (an instalment can be paid in several checkouts, bounded by what is still due). The amount is held against the due while the checkout is open; the due counts the money only when the verified provider result arrives (never from the redirect or a client claim), so retries and webhooks cannot double-charge or double-settle. The platform collects the money and the recipient is paid out through the earnings and payout flow, which is a separate later step. Refused until the recipient has a payout account in that currency. Send the person to checkout_url, then call confirm_payment (or wait for the webhook).',
  input: z.object({ id, provider: z.enum(['stripe', 'paypal']), amount_cents: z.coerce.number().int().positive().optional().describe('defaults to everything still due'), return_url: z.string().url().optional() }),
  async handler({ user }, i) {
    if (!enabledProviders().includes(i.provider)) throw conflict(`${i.provider} is not switched on for online payments yet`);
    // the recipient must be able to be paid in this currency, or the money would be collected and stuck
    const pre = await obligationContext(pool, i.id, user);
    if (pre.role !== 'sponsor') throw forbidden('Only the sponsor pays a due');
    pre.need('pay', 'pay online');
    if (!config.settlement.currencies.includes(pre.o.currency)) throw conflict(`Online payouts are not available in ${pre.o.currency} yet. Report a bank payment instead.`, { code: 'currency_unsupported' });
    const payeeId = (await payeeFor(pool, pre)) ?? pre.recipientId;
    if (!(await one("SELECT 1 FROM payout_accounts WHERE owner_id=$1 AND currency=$2 AND status IN ('pending','verified')", [payeeId, pre.o.currency]))) {
      await tx((c) => notify(c, payeeId, { kind: 'sponsorship_payment', title: 'Add a payout account to receive sponsorship money', body: `A sponsor tried to pay you online in ${pre.o.currency}. Add a payout account in that currency under Earnings.`, data: { sponsorship_id: pre.d.id } }));
      throw conflict(`The recipient has not set up payouts in ${pre.o.currency} yet. They have been asked to; meanwhile you can report a bank payment.`, { code: 'recipient_not_onboarded' });
    }
    const row = await tx(async (c) => {
      const ctx = await obligationContext(c, i.id, user);
      ctx.need('pay', 'pay online');
      open(ctx, 'money');
      const unmet = (await c.query("SELECT x.text FROM sponsorship_award_conditions x JOIN sponsorship_awards w ON w.id=x.award_id WHERE w.sponsorship_id=$1 AND x.removed_at IS NULL AND x.blocks_payment AND x.met_at IS NULL ORDER BY x.position LIMIT 1", [ctx.d.id])).rows[0];
      if (unmet) throw conflict(`A condition of the award must be met before payment: ${unmet.text}`);
      await releaseStaleCheckouts(c, ctx.o.id);
      const left = Number(ctx.o.amount_cents) - await heldCents(c, ctx.o.id);
      if (left <= 0) throw conflict('Nothing is left to pay on this due (it is covered, or a payment or checkout is already open)');
      const amount = i.amount_cents ?? left;
      if (amount > left) throw conflict(`Only ${left} is still due on this instalment`);
      const x = (await c.query("INSERT INTO sponsorship_payments(obligation_id, amount_cents, currency, method, reference, paid_on, status, reported_by, payee_guardian_id) VALUES ($1,$2,$3,'online','pending',current_date,'awaiting_payment',$4,$5) RETURNING id", [ctx.o.id, amount, ctx.o.currency, user.id, await payeeFor(c, ctx)])).rows[0];
      await c.query("UPDATE sponsorship_payments SET reference='online-'||id::text WHERE id=$1", [x.id]);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'checkout_started');
      return { id: x.id, amount };
    });
    try {
      const out = await startCheckout(user, { purpose_type: 'sponsorship_payment', purpose_id: row.id, provider: i.provider, return_url: i.return_url });
      await one('UPDATE sponsorship_payments SET payment_id=$2 WHERE id=$1', [row.id, out.id]);
      return { ...out, sponsorship_payment_id: row.id, obligation_id: i.id };
    } catch (e) {
      await one("UPDATE sponsorship_payments SET status='failed', decided_at=now(), decision_note='Checkout could not be opened' WHERE id=$1 AND status='awaiting_payment'", [row.id]);
      throw e;
    }
  },
});

cap({
  name: 'cancel_sponsorship_checkout', method: 'POST', path: '/sponsorship-payments/:id/cancel-checkout', tag: 'Sponsors',
  summary: 'The sponsor who opened an online checkout can abandon it so the amount is free to pay again. If the provider still completes it later, the money is refunded automatically and never kept. A checkout that has already been paid cannot be cancelled.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p0 = (await c.query('SELECT obligation_id FROM sponsorship_payments WHERE id=$1', [i.id])).rows[0];
      if (!p0) throw notFound('Payment');
      const ctx = await obligationContext(c, p0.obligation_id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor can cancel its checkout');
      ctx.need('pay', 'cancel a checkout');
      const x = (await c.query('SELECT * FROM sponsorship_payments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (x.method !== 'online' || x.status !== 'awaiting_payment') throw conflict(`This payment is ${x.status === 'awaiting_payment' ? 'not an online checkout' : x.status}`);
      // the provider payment is deliberately left pending: if the sponsor still completes it, the verified result is refunded automatically
      const row = (await c.query("UPDATE sponsorship_payments SET status='failed', decided_by=$2, decided_at=now(), decision_note='Checkout cancelled by the sponsor' WHERE id=$1 RETURNING *", [x.id, user.id])).rows[0];
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'checkout_cancelled');
      return row;
    });
  },
});

cap({
  name: 'get_sponsorship_reconciliation', method: 'GET', path: '/sponsorship-reconciliation', tag: 'Sponsors',
  summary: 'Sponsorship money reconciled per currency (never added across currencies) for the agreements you can see: committed, collected online, refunded, confirmed manual payments, reported-but-unverified, checkouts in progress and still due, next to what the earnings ledger recorded for the online payments (sale, refund, chargeback). `reconciles` is true only when the due-side and ledger-side figures agree. Payouts to the recipient are a later, separate step in the earnings and payout flow.',
  input: z.object({ sponsorship_id: id.optional(), sponsor_id: id.optional() }),
  async handler({ user }, i) {
    const params = [user.id, !!isAdmin(user), i.sponsorship_id ?? null, i.sponsor_id ?? null];
    const scope = `${SCOPE} AND ($3::uuid IS NULL OR ss.id=$3) AND ($4::uuid IS NULL OR ss.sponsor_id=$4)`;
    const from = 'FROM sponsorship_obligations o JOIN sponsorships ss ON ss.id=o.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id';
    const due = await many(`SELECT o.currency, coalesce(sum(o.amount_cents) FILTER (WHERE o.status <> 'cancelled'),0)::bigint AS committed_cents, coalesce(sum(o.conceded_cents) FILTER (WHERE o.status <> 'cancelled'),0)::bigint AS conceded_cents ${from} WHERE ${scope} AND o.kind='money' GROUP BY o.currency`, params);
    const pay = await many(
      `SELECT x.currency,
         coalesce(sum(x.amount_cents) FILTER (WHERE x.method='online' AND (x.status IN ('confirmed','reversed') OR x.refunded_cents > 0)),0)::bigint AS collected_online_cents,
         coalesce(sum(x.refunded_cents) FILTER (WHERE x.method='online'),0)::bigint AS refunded_cents,
         coalesce(sum(x.amount_cents - x.refunded_cents) FILTER (WHERE x.method<>'online' AND x.status='confirmed'),0)::bigint AS confirmed_manual_cents,
         coalesce(sum(x.amount_cents) FILTER (WHERE x.status='reported'),0)::bigint AS reported_unverified_cents,
         coalesce(sum(x.amount_cents) FILTER (WHERE x.status='awaiting_payment'),0)::bigint AS checkout_in_progress_cents
       FROM sponsorship_payments x JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorships ss ON ss.id=o.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE ${scope} GROUP BY x.currency`, params);
    const ledger = await many(
      `SELECT l.currency, coalesce(sum(l.gross_cents) FILTER (WHERE l.kind='sale'),0)::bigint AS sale_cents, coalesce(-sum(l.gross_cents) FILTER (WHERE l.kind='refund'),0)::bigint AS refund_cents, coalesce(-sum(l.gross_cents) FILTER (WHERE l.kind='chargeback'),0)::bigint AS chargeback_cents
         FROM provider_ledger l JOIN sponsorship_payments x ON x.id=l.purpose_id AND l.purpose_type='sponsorship_payment' JOIN sponsorship_obligations o ON o.id=x.obligation_id JOIN sponsorships ss ON ss.id=o.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id
        WHERE ${scope} AND l.kind IN ('sale','refund','chargeback') GROUP BY l.currency`, params);
    const cur = [...new Set([...due, ...pay].map((r) => r.currency))].sort();
    return cur.map((currency) => {
      const d = due.find((r) => r.currency === currency), p = pay.find((r) => r.currency === currency), l = ledger.find((r) => r.currency === currency);
      const committed = Number(d?.committed_cents ?? 0), online = Number(p?.collected_online_cents ?? 0), refunded = Number(p?.refunded_cents ?? 0), manual = Number(p?.confirmed_manual_cents ?? 0);
      const confirmed = online - refunded + manual;
      return { currency, committed_cents: committed, collected_online_cents: online, refunded_cents: refunded, confirmed_manual_cents: manual, confirmed_cents: confirmed,
        reported_unverified_cents: Number(p?.reported_unverified_cents ?? 0), checkout_in_progress_cents: Number(p?.checkout_in_progress_cents ?? 0), conceded_cents: Number(d?.conceded_cents ?? 0), outstanding_cents: committed - confirmed - Number(d?.conceded_cents ?? 0),
        ledger: { sale_cents: Number(l?.sale_cents ?? 0), refund_cents: Number(l?.refund_cents ?? 0), chargeback_cents: Number(l?.chargeback_cents ?? 0) },
        reconciles: Number(l?.sale_cents ?? 0) === online && Number(l?.refund_cents ?? 0) === refunded };
    });
  },
});

cap({
  name: 'decide_sponsorship_payment', method: 'PATCH', path: '/sponsorship-payments/:id', tag: 'Sponsors',
  summary: 'Recipient (or admin): confirm that a reported (manual) payment arrived, reject it (reason required), or reverse a confirmed one (reason required, e.g. a refund). The sponsor can never confirm its own payment. A due is fulfilled only by confirmed payments.',
  input: z.object({ id, status: z.enum(['confirmed', 'rejected', 'reversed']), note: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p0 = (await c.query('SELECT obligation_id FROM sponsorship_payments WHERE id=$1', [i.id])).rows[0];
      if (!p0) throw notFound('Payment');
      const ctx = await obligationContext(c, p0.obligation_id, user);
      if (ctx.role !== 'recipient' && ctx.role !== 'admin') throw forbidden('Only the recipient confirms a payment');
      if (i.status !== 'confirmed' && !i.note) throw badRequest('Give a reason');
      const p = (await c.query('SELECT * FROM sponsorship_payments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (ctx.youth && ctx.role !== 'admin' && p.payee_guardian_id && p.payee_guardian_id !== user.id && await guardianLink(p.payee_guardian_id, ctx.d.target_id, c)) throw forbidden('Only the guardian who receives this money confirms it');
      if (p.method === 'online') throw conflict('An online payment is verified by the payment provider; it cannot be confirmed, rejected or reversed by hand. The platform team issues refunds.');
      if (i.status === 'reversed' ? p.status !== 'confirmed' : p.status !== 'reported') throw conflict(`This payment is already ${p.status}`);
      // the payees in force are frozen on the payment when it is confirmed, so later allocation or membership changes never rewrite who was paid
      const snap = i.status === 'confirmed' ? await payeeSnapshot(c, ctx.d.id, p.amount_cents) : null;
      const row = (await c.query('UPDATE sponsorship_payments SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, payee_snapshot=coalesce($5::jsonb, payee_snapshot) WHERE id=$1 RETURNING *', [p.id, i.status, user.id, i.note ?? null, snap ? JSON.stringify(snap) : null])).rows[0];
      await settleMoney(c, ctx.o);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, `payment_${i.status}`, i.note);
      await ping(c, 'sponsor', `A sponsorship payment was ${i.status}`, ctx, 'sponsorship_payment', 'pay');
      return row;
    });
  },
});

cap({
  name: 'dispatch_sponsorship_goods', method: 'POST', path: '/sponsorship-obligations/:id/deliveries', tag: 'Sponsors', status: 201,
  summary: 'Sponsor owner: record a dispatch of goods against a goods due, optionally with proof of dispatch (https link) or as the replacement for an accepted return. Only the recipient can mark receipt. Received (net of accepted returns) + in transit + credited quantity can never exceed the committed quantity; a rejected delivery or an accepted return frees its quantity.',
  input: z.object({ id, quantity: z.coerce.number().int().positive(), reference: z.string().max(120).optional(), note: z.string().max(500).optional(), evidence_url: url.optional().describe('proof of dispatch'),
    replaces_return_id: id.optional().describe('the accepted return this shipment replaces; each return is replaced once, by at most its own quantity') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await obligationContext(c, i.id, user);
      if (ctx.role !== 'sponsor') throw forbidden('Only the sponsor dispatches goods');
      ctx.need('pay', 'dispatch goods');
      open(ctx, 'goods');
      if (i.replaces_return_id) {
        const r = (await c.query('SELECT * FROM sponsorship_delivery_returns WHERE id=$1 AND obligation_id=$2 FOR UPDATE', [i.replaces_return_id, ctx.o.id])).rows[0];
        if (!r) throw notFound('Return');
        if (r.status !== 'accepted' || r.resolution !== 'replace') throw conflict('Only an accepted return that is to be replaced can have a replacement');
        if (i.quantity > r.quantity) throw badRequest(`A replacement for this return is at most ${r.quantity}`);
        if ((await c.query("SELECT 1 FROM sponsorship_deliveries WHERE replaces_return_id=$1 AND status <> 'rejected'", [r.id])).rowCount) throw conflict('This return already has a replacement');
      }
      const pos = await goodsPosition(c, ctx.o);
      if (i.quantity > pos.remaining) throw conflict(`Only ${Math.max(0, pos.remaining)} more can be dispatched against this delivery`);
      const row = (await c.query('INSERT INTO sponsorship_deliveries(obligation_id, quantity, reference, note, dispatched_by, dispatch_evidence_url, replaces_return_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [ctx.o.id, i.quantity, i.reference ?? null, i.note ?? null, user.id, i.evidence_url ?? null, i.replaces_return_id ?? null])).rows[0];
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, i.replaces_return_id ? 'goods_replacement_dispatched' : 'goods_dispatched');
      await ping(c, ctx.recipientId, 'Sponsored goods were dispatched', ctx, 'sponsorship_delivery');
      return row;
    });
  },
});

cap({
  name: 'decide_sponsorship_delivery', method: 'PATCH', path: '/sponsorship-deliveries/:id', tag: 'Sponsors',
  summary: 'Recipient (or admin): confirm receipt of a dispatched delivery (optionally fewer than dispatched, for a partial delivery, with proof of condition) or reject it (reason required, e.g. damaged). Pass `expected_version` to refuse a stale decision. The due is fulfilled when confirmed quantities (net of accepted returns) reach the committed quantity.',
  input: z.object({ id, status: z.enum(['received', 'rejected']), received_quantity: z.coerce.number().int().positive().optional(), note: z.string().max(500).optional(), evidence_url: url.optional().describe('proof of receipt or of the condition of the goods'),
    reason: z.enum(['damaged', 'wrong_item', 'not_as_described', 'other']).optional().describe('rejection reason'), expected_version: z.coerce.number().int().positive().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d0 = (await c.query('SELECT obligation_id FROM sponsorship_deliveries WHERE id=$1', [i.id])).rows[0];
      if (!d0) throw notFound('Delivery');
      const ctx = await obligationContext(c, d0.obligation_id, user);
      if (ctx.role !== 'recipient' && ctx.role !== 'admin') throw forbidden('Only the recipient confirms receipt');
      const dl = (await c.query('SELECT * FROM sponsorship_deliveries WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (i.expected_version != null && i.expected_version !== dl.version) throw conflict('This delivery changed; reload it and try again', { code: 'stale_version' });
      if (dl.status !== 'dispatched') throw conflict(`This delivery is already ${dl.status}`);
      if (i.status === 'rejected' && !i.note) throw badRequest('Give a reason');
      const got = i.status === 'received' ? (i.received_quantity ?? dl.quantity) : 0;
      if (got > dl.quantity) throw badRequest(`Only ${dl.quantity} were dispatched`);
      const row = (await c.query('UPDATE sponsorship_deliveries SET status=$2, received_quantity=$3, decided_by=$4, decided_at=now(), decision_note=$5, receipt_evidence_url=$6, rejection_reason=$7, version=version+1 WHERE id=$1 RETURNING *', [dl.id, i.status, got, user.id, i.note ?? null, i.evidence_url ?? null, i.status === 'rejected' ? i.reason ?? 'other' : null])).rows[0];
      await settleGoods(c, ctx.o);
      await completeIfSettled(c, ctx.d.id);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, `goods_${i.status}`, i.note);
      await ping(c, 'sponsor', `Sponsored goods were ${i.status}`, ctx, 'sponsorship_delivery', 'pay');
      return row;
    });
  },
});

/** The party that promotes submits evidence; the other party reviews it. */
async function endorsementCtx(c, o, user) {
  const ctx = await obligationContext(c, o, user);
  const promoter = (await c.query('SELECT promoter FROM sponsorship_lines WHERE id=$1', [ctx.o.line_id])).rows[0].promoter;
  return { ...ctx, promoter, reviewer: promoter === 'recipient' ? 'sponsor' : 'recipient' };
}

cap({
  name: 'submit_sponsorship_endorsement', method: 'POST', path: '/sponsorship-obligations/:id/submissions', tag: 'Sponsors', status: 201,
  summary: 'The promoting party submits evidence (an https link and a note) for an endorsement due. The other party reviews it. A new submission is only possible when there is none, or the last was sent back for revision. Delivery here is contractual evidence; reach or impressions are never inferred.',
  input: z.object({ id, evidence_url: url, note: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await endorsementCtx(c, i.id, user);
      open(ctx, 'endorsement');
      if (ctx.role !== ctx.promoter) throw forbidden(`Only the ${ctx.promoter} promotes under this agreement`);
      if (ctx.role === 'sponsor') ctx.need('evaluate', 'submit endorsement evidence');
      if (ctx.youth) { await assertYouthAuthority(c, ctx); await requireConsent(ctx.d.target_id, 'media', 'photos or videos of a young person', c); } // the agreement never implies image consent
      const last = (await c.query('SELECT status FROM sponsorship_submissions WHERE obligation_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [ctx.o.id])).rows[0];
      if (last && last.status !== 'revision_requested') throw conflict(`The last submission is ${last.status}`);
      const row = (await c.query('INSERT INTO sponsorship_submissions(obligation_id, evidence_url, note, submitted_by) VALUES ($1,$2,$3,$4) RETURNING *', [ctx.o.id, i.evidence_url, i.note ?? null, user.id])).rows[0];
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, 'endorsement_submitted');
      await ping(c, other(ctx), 'An endorsement is waiting for your review', ctx, 'sponsorship_endorsement');
      return row;
    });
  },
});

cap({
  name: 'review_sponsorship_endorsement', method: 'PATCH', path: '/sponsorship-submissions/:id', tag: 'Sponsors',
  summary: 'The reviewing party (the one that does not promote) accepts a submission or asks for a revision (reason required). Acceptance fulfils the due.',
  input: z.object({ id, status: z.enum(['accepted', 'revision_requested']), note: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const s0 = (await c.query('SELECT obligation_id FROM sponsorship_submissions WHERE id=$1', [i.id])).rows[0];
      if (!s0) throw notFound('Submission');
      const ctx = await endorsementCtx(c, s0.obligation_id, user);
      if (ctx.role !== ctx.reviewer && ctx.role !== 'admin') throw forbidden(`Only the ${ctx.reviewer} reviews this endorsement`);
      if (ctx.role === 'sponsor') ctx.need('evaluate', 'review endorsements');
      if (i.status === 'revision_requested' && !i.note) throw badRequest('Say what needs to change');
      const s = (await c.query('SELECT * FROM sponsorship_submissions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (s.status !== 'submitted') throw conflict(`This submission is already ${s.status}`);
      const row = (await c.query('UPDATE sponsorship_submissions SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1 RETURNING *', [s.id, i.status, user.id, i.note ?? null])).rows[0];
      if (i.status === 'accepted') await c.query("UPDATE sponsorship_obligations SET status='fulfilled', fulfilled_at=now() WHERE id=$1 AND status='scheduled'", [ctx.o.id]);
      if (i.status === 'accepted') await completeIfSettled(c, ctx.d.id);
      await logHistory(c, ctx.d.id, ctx.o.version, user.id, `endorsement_${i.status}`, i.note);
      await ping(c, ctx.promoter === 'sponsor' ? 'sponsor' : ctx.recipientId, `An endorsement was ${i.status === 'accepted' ? 'accepted' : 'sent back for revision'}`, ctx, 'sponsorship_endorsement');
      return row;
    });
  },
});

cap({
  name: 'rebuild_sponsorship_schedule', method: 'POST', path: '/sponsorships/:id/rebuild-schedule', tag: 'Sponsors', auth: ['admin'],
  summary: 'Admin recovery: regenerate the dues of an accepted agreement. Idempotent (unique per agreement/version/line/occurrence), so it only fills in what is missing and never duplicates or rewrites an existing due.',
  input: z.object({ id }),
  handler: async (_, i) => tx(async (c) => ({ created: await generateObligations(c, i.id) })),
});

/** Amendments of an accepted agreement, in short: the open proposal (if any), how many there were, and what this caller may do about it. */
async function amendmentsFor(ctx) {
  const { d, role } = ctx;
  const open = (await one("SELECT a.id, a.seq, a.rev, a.proposed_side, a.effective_from::text AS effective_from, a.reason FROM sponsorship_amendments a WHERE a.sponsorship_id=$1 AND a.status='proposed'", [d.id])) ?? null;
  const total = (await one('SELECT count(*)::int AS n FROM sponsorship_amendments WHERE sponsorship_id=$1', [d.id])).n;
  const side = role === 'sponsor' || role === 'recipient';
  const may = (a) => (role === 'recipient' ? !ctx.minorBlocked && (!['organisation', 'group'].includes(d.target_type) || !!ctx.beneficiary?.representative) : role === 'sponsor' ? actionsFor(ctx.staff).includes(a) : false);
  const live = d.status === 'active' && !!d.accepted_version;
  return { open, total, can_propose: live && side && !open && may('revise'), can_answer: !!open && live && side && open.proposed_side !== role && may('sign_off'), can_edit: !!open && live && side && open.proposed_side === role && may('revise') };
}

/** The negotiation as one side may see it: version authorship, whose turn it is, shared comments, and only THIS side's internal notes. */
async function negotiationFor(ctx) {
  const { d, role } = ctx;
  const versions = await many("SELECT v.version, v.authored_side, v.reason, v.restores, v.created_at, v.signed_off_at, u.display_name AS author FROM sponsorship_versions v LEFT JOIN users u ON u.id=v.authored_by WHERE v.sponsorship_id=$1 ORDER BY v.version", [d.id]);
  const comments = await many(
    "SELECT m.id, m.version, m.line_position, m.side, m.visibility, m.body, m.created_at, u.display_name AS author FROM sponsorship_comments m JOIN users u ON u.id=m.author_id WHERE m.sponsorship_id=$1 AND (m.visibility='shared' OR m.side=$2) ORDER BY m.id", [d.id, role]);
  const open = d.status === 'proposed', mySide = (role === 'sponsor' || role === 'recipient') && !ctx.minorBlocked ? role : null;
  return { open, terms_side: d.terms_side, awaiting: open ? (d.terms_side === 'sponsor' ? 'recipient' : 'sponsor') : null,
    my_turn: !!(open && mySide && mySide !== d.terms_side), can_counter: !!(open && mySide), can_withdraw_change: !!(open && mySide === d.terms_side && versions.some((v) => v.authored_side !== mySide && v.version < d.terms_version)), versions, comments };
}
