// Cover: someone else pays a person's bills under an agreement both sides approved. The agreement ("mandate") names who pays, whom for, which kinds of
// bill, and the term: one time, for a period, or unlimited, optionally with a per-bill and a total cap. It is checked on EVERY use and can be ended
// at any time. The bill keeps its own type and id, so refunds, receipts and settlement are unchanged; the payment just records who paid.
import { config } from './config.js';
import { notify } from './notify.js';
import { toMajor } from './currency.js';
import { guardianLink, isYouth } from './youth.js';

const FRESH = "created_at > now() - interval '30 minutes'";   // a checkout nobody finished stops counting after half an hour

/** The kinds of bill that can be covered. Labels are deliberately generic: a payer never learns a provider, a diagnosis or a service. */
export const COVER_PURPOSES = {
  venue_invoice: { label: 'Venue booking', list: "SELECT i.id, i.total_cents - i.credits_cents AS amount, i.currency, i.issued_at AS at FROM invoices i JOIN venues v ON v.id=i.venue_id WHERE i.user_id=$1 AND i.kind='invoice' AND i.status='open' AND v.payment_mode <> 'pay_at_venue' AND i.total_cents - i.credits_cents > 0 ORDER BY i.issued_at DESC LIMIT 50" },
  venue_plan: { label: 'Membership or pass', list: "SELECT up.id, up.price_cents AS amount, up.currency, up.created_at AS at FROM user_plans up WHERE up.user_id=$1 AND up.status='awaiting_payment' AND up.organisation_id IS NULL ORDER BY up.created_at DESC LIMIT 50" },
  coach_hire: { label: 'Coaching session', list: "SELECT h.id, h.total_cents - h.loyalty_credit_cents AS amount, $2::text AS currency, h.starts_at AS at FROM coach_hires h WHERE h.hirer_id=$1 AND h.payment_status='unpaid' AND h.status IN ('requested','confirmed') AND h.total_cents - h.loyalty_credit_cents > 0 ORDER BY h.starts_at LIMIT 50" },
  appointment: { label: 'Health appointment', list: "SELECT a.id, a.fee_cents AS amount, a.currency, a.created_at AS at FROM appointments a WHERE a.athlete_id=$1 AND a.payment_status='unpaid' AND a.status IN ('requested','confirmed') AND a.fee_cents > 0 ORDER BY a.created_at DESC LIMIT 50" },
  physio_package: { label: 'Health session package', list: "SELECT k.id, k.price_cents AS amount, k.currency, k.created_at AS at FROM patient_packages k WHERE k.patient_id=$1 AND k.status='awaiting_payment' AND k.price_cents > 0 ORDER BY k.created_at DESC LIMIT 50" },
  academy_charge: { label: 'Academy fee', list: "SELECT ch.id, ch.amount_minor AS amount, ch.currency, ch.due_on::timestamptz AS at FROM academy_charges ch WHERE ch.payer_id=$1 AND ch.status='awaiting_payment' AND ch.amount_minor > 0 ORDER BY ch.due_on LIMIT 50" },
  insurance_policy: { label: 'Insurance cover', list: "SELECT p.id, p.amount_cents AS amount, $2::text AS currency, p.created_at AS at FROM insurance_policies p WHERE p.holder_id=$1 AND p.status='pending_payment' AND p.amount_cents > 0 ORDER BY p.created_at DESC LIMIT 50" },
  shop_order: { label: 'Shop order', list: "SELECT o.id, o.total_cents AS amount, $2::text AS currency, o.created_at AS at FROM shop_orders o WHERE o.buyer_id=$1 AND o.status='awaiting_payment' AND o.total_cents > 0 ORDER BY o.created_at DESC LIMIT 50" },
};
export const COVER_KINDS = Object.keys(COVER_PURPOSES);
/** Bill lists that need the default currency (the record itself has none) take it as $2. */
const NEEDS_CURRENCY = new Set(['coach_hire', 'insurance_policy', 'shop_order']);
const listBills = async (c, kind, beneficiaryId) => (await c.query(COVER_PURPOSES[kind].list, NEEDS_CURRENCY.has(kind) ? [beneficiaryId, config.payments.currency] : [beneficiaryId])).rows;
export const billLabel = (type) => COVER_PURPOSES[type]?.label ?? 'Bill';

const today = () => new Date().toISOString().slice(0, 10);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Is the agreement in force right now? (active, and inside its dates) */
export const isLive = (m) => m.status === 'active' && (!m.valid_from || day(m.valid_from) <= today()) && (!m.valid_until || day(m.valid_until) >= today());

export async function usage(c, mandateId) {
  const r = (await c.query(`SELECT coalesce(sum(amount_minor),0)::bigint AS minor, count(*)::int AS n FROM cover_uses WHERE mandate_id=$1 AND (status='paid' OR (status='pending' AND ${FRESH}))`, [mandateId])).rows[0];
  return { used_minor: Number(r.minor), uses: r.n };
}

/** Why this agreement does not cover this bill (null when it does). */
export async function whyNot(c, m, { purposeType, purposeId, amount, currency }) {
  if (!isLive(m)) return 'not_active';
  if (!m.purposes.includes(purposeType)) return 'kind_not_covered';
  if (m.bill_type && (m.bill_type !== purposeType || m.bill_id !== purposeId)) return 'other_bill';
  if (m.currency && m.currency !== currency) return 'currency';
  if (m.max_per_bill_minor && amount > Number(m.max_per_bill_minor)) return 'over_per_bill_cap';
  const u = await usage(c, m.id);
  if (m.term === 'one_time' && u.uses > 0) return 'already_used';
  if (m.max_total_minor && u.used_minor + amount > Number(m.max_total_minor)) return 'over_total_cap';
  return null;
}

/** The orgs where `user` may pay (owner/admin/finance) or manage agreements (owner/admin). */
export async function orgsOf(c, userId, manage = false) {
  const roles = manage ? ['owner', 'admin'] : ['owner', 'admin', 'finance'];
  return (await c.query("SELECT m.organisation_id AS id FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id AND o.status='active' WHERE m.user_id=$1 AND m.status='active' AND m.role = ANY($2)", [userId, roles])).rows.map((r) => r.id);
}

/** What `user` can do on the payer side of this agreement: 'manage' (approve, end), 'pay', or null. Platform admins have no hand in other people's agreements. */
export async function payerSide(c, user, m) {
  if (m.payer_user_id) return m.payer_user_id === user.id ? 'manage' : null;
  if ((await orgsOf(c, user.id, true)).includes(m.payer_org_id)) return 'manage';
  if ((await orgsOf(c, user.id, false)).includes(m.payer_org_id)) return 'pay';
  return null;
}

/** The beneficiary side: the person, or (for a young person) a verified guardian. A young person with a guardian cannot act alone. */
export async function beneficiarySide(c, user, m) {
  if (user.id === m.beneficiary_id) {
    if (await isYouth(user.id, c)) {
      const g = (await c.query("SELECT 1 FROM guardian_links WHERE child_id=$1 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [user.id])).rowCount;
      if (g) return null;
    }
    return 'self';
  }
  return (await guardianLink(user.id, m.beneficiary_id, c)) ? 'guardian' : null;
}

export const payerName = async (c, m) => (m.payer_user_id
  ? (await c.query('SELECT display_name AS n FROM users WHERE id=$1', [m.payer_user_id])).rows[0]?.n
  : (await c.query('SELECT name AS n FROM organisations WHERE id=$1', [m.payer_org_id])).rows[0]?.n) ?? 'Someone';

/** Who should hear about a bill on the payer side: the person, or the organisation's owners, admins and finance staff. */
export async function payerRecipients(c, m) {
  if (m.payer_user_id) return [m.payer_user_id];
  return (await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin','finance')", [m.payer_org_id])).rows.map((r) => r.user_id);
}

export const logEvent = (c, mandateId, actorId, action, note) => c.query('INSERT INTO cover_events(mandate_id, actor_id, action, note) VALUES ($1,$2,$3,$4)', [mandateId, actorId ?? null, action, note ?? null]);

/**
 * Called by checkout when the person paying is not the bill's owner. Returns the agreement that lets `user` pay this bill (locked), or null.
 * Needs the bill to have reached the payer: the agreement is auto-send, bound to this bill, or the beneficiary sent it.
 */
export async function coverFor(c, user, d, { purposeType, purposeId, currency }) {
  const orgs = await orgsOf(c, user.id, false);
  const { rows } = await c.query(
    `SELECT * FROM cover_mandates WHERE beneficiary_id=$1 AND status='active' AND (payer_user_id=$2 OR payer_org_id = ANY($3::uuid[])) ORDER BY created_at, id FOR UPDATE`, [d.payerId, user.id, orgs]);
  for (const m of rows) {
    if (await whyNot(c, m, { purposeType, purposeId, amount: d.amount, currency })) continue;
    const reached = m.auto_send || m.bill_id === purposeId
      || (await c.query("SELECT 1 FROM cover_bills WHERE mandate_id=$1 AND purpose_type=$2 AND purpose_id=$3 AND status='sent'", [m.id, purposeType, purposeId])).rowCount;
    if (reached) return m;
  }
  return null;
}

export const startUse = (c, m, { paymentId, userId, purposeType, purposeId, amount, currency }) => c.query(
  'INSERT INTO cover_uses(mandate_id, payment_id, purpose_type, purpose_id, paid_by, amount_minor, currency) VALUES ($1,$2,$3,$4,$5,$6,$7)', [m.id, paymentId, purposeType, purposeId, userId, amount, currency]);

/** The covered payment settled (or failed): finish the use, close a one-time or fully used agreement, tell the beneficiary. */
export async function settleUse(c, paymentId, paid) {
  const u = (await c.query("UPDATE cover_uses SET status=$2, settled_at=now() WHERE payment_id=$1 AND status='pending' RETURNING *", [paymentId, paid ? 'paid' : 'cancelled'])).rows[0];
  if (!u || !paid) return;
  const m = (await c.query('SELECT * FROM cover_mandates WHERE id=$1 FOR UPDATE', [u.mandate_id])).rows[0];
  const total = await usage(c, m.id);
  const done = m.term === 'one_time' || (m.max_total_minor && total.used_minor >= Number(m.max_total_minor));
  if (done && m.status === 'active') { await c.query("UPDATE cover_mandates SET status='used_up', ended_at=now(), end_reason='fully used' WHERE id=$1", [m.id]); await logEvent(c, m.id, null, 'used_up'); }
  await logEvent(c, m.id, u.paid_by, 'paid', `${billLabel(u.purpose_type)} ${u.currency} ${toMajor(Number(u.amount_minor), u.currency)}`);
  await notify(c, m.beneficiary_id, { kind: 'cover_paid', title: `${await payerName(c, m)} paid for your ${billLabel(u.purpose_type).toLowerCase()}`, body: `${u.currency} ${toMajor(Number(u.amount_minor), u.currency)} was paid under your cover agreement.`, data: { cover_id: m.id }, dedupe_key: `cover:paid:${u.id}` });
}

/** Active, in-force agreements on the payer side for `user` (the person's own, plus those of organisations they can pay for). */
export async function payerMandates(c, user) {
  const orgs = await orgsOf(c, user.id, false);
  return (await c.query("SELECT * FROM cover_mandates WHERE status='active' AND (payer_user_id=$1 OR payer_org_id = ANY($2::uuid[])) ORDER BY created_at DESC", [user.id, orgs])).rows.filter(isLive);
}

/** Candidate open bills of the beneficiary within an agreement: all in scope when auto-send, plus any the beneficiary sent. */
export async function billsFor(c, m) {
  const out = [];
  const kinds = m.bill_type ? [m.bill_type] : m.purposes;
  if (m.auto_send || m.bill_type) {
    for (const k of kinds) {
      const rows = await listBills(c, k, m.beneficiary_id);
      for (const r of rows) if (!m.bill_type || r.id === m.bill_id) out.push({ purpose_type: k, purpose_id: r.id, amount: Number(r.amount), currency: r.currency, at: r.at });
    }
  }
  const sent = (await c.query("SELECT purpose_type, purpose_id FROM cover_bills WHERE mandate_id=$1 AND status='sent'", [m.id])).rows;
  for (const s of sent) {
    if (out.some((o) => o.purpose_type === s.purpose_type && o.purpose_id === s.purpose_id)) continue;
    if (!COVER_PURPOSES[s.purpose_type]) continue;
    const rows = await listBills(c, s.purpose_type, m.beneficiary_id);
    const r = rows.find((x) => x.id === s.purpose_id);
    if (r) out.push({ purpose_type: s.purpose_type, purpose_id: r.id, amount: Number(r.amount), currency: r.currency, at: r.at });
  }
  return out;
}

/** Tell the payer side that a bill is waiting (a renewal was raised, or the beneficiary sent one). */
export async function notifyPayers(c, m, { purposeType, purposeId, amount, currency }) {
  const who = (await c.query('SELECT display_name AS n FROM users WHERE id=$1', [m.beneficiary_id])).rows[0]?.n ?? 'Someone';
  for (const userId of await payerRecipients(c, m)) {
    await notify(c, userId, { kind: 'cover_bill', title: `${who} has a ${billLabel(purposeType).toLowerCase()} for you to pay`, body: `${currency} ${toMajor(amount, currency)} — open Cover to review and pay.`, data: { cover_id: m.id }, dedupe_key: `cover:bill:${m.id}:${purposeType}:${purposeId}:${userId}` });
  }
}

/** A new bill appeared for someone with auto-send cover (e.g. a membership renewal): tell their payers. */
export async function notifyCoveringPayers(c, beneficiaryId, { purposeType, purposeId, amount, currency }) {
  const { rows } = await c.query("SELECT * FROM cover_mandates WHERE beneficiary_id=$1 AND status='active' AND auto_send ORDER BY created_at", [beneficiaryId]);
  for (const m of rows) if (!(await whyNot(c, m, { purposeType, purposeId, amount, currency }))) await notifyPayers(c, m, { purposeType, purposeId, amount, currency });
}

/** Worker: agreements past their end date become 'expired'. Nothing is deleted; uses and events stay. */
export async function expireCover(c) {
  const r = await c.query("UPDATE cover_mandates SET status='expired', ended_at=now(), end_reason='term ended' WHERE status='active' AND valid_until IS NOT NULL AND valid_until < current_date RETURNING id");
  for (const m of r.rows) await logEvent(c, m.id, null, 'expired');
  return r.rowCount;
}
