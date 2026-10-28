// Team member finance: dues, season and match fees, shared expenses and fundraising. A contribution ledger, not a bank account.
// Nothing here owns cash. What a member owes is a team_charge (one row per member, fixed when raised); every change after that - an adjustment,
// a waiver, an offline receipt, an online payment - is an append-only row in team_charge_entries, so the balance can always be explained.
// Online money is the canonical `payments` row (purpose_type team_charge / team_contribution) through the platform checkout; this module is
// only called back to fulfil it (payments/service.js). A young member is never the payer: a currently verified guardian is.
import { many, one, tx } from './db.js';
import { conflict } from './errors.js';
import { notify } from './notify.js';
import { encrypt, decrypt } from './crypto.js';
import { guardiansOf, isYouth } from './youth.js';
import { allocate } from './settlement.js';
import { toMajor } from './currency.js';
import { addMonths } from './sponsor-schedule.js';
import { settleTeamChargeInvoice, syncTeamChargeInvoice } from './team-invoices.js';
import { hasOrgGrant } from './org-access.js';
import { canManageTeam } from './capabilities/teams.js';

export const sealReason = (t) => (t ? encrypt(t, 'team_charge_entries.reason') : null);
export const openReason = (s) => (s ? decrypt(s, 'team_charge_entries.reason') : null);
export const balanceOf = (ch) => Number(ch.amount_minor) - Number(ch.adjusted_minor) - Number(ch.settled_minor);
/** Managers, and finance staff of the team's organisation. They reconcile and run collections; ordinary members never get this. */
export const financeStaff = async (user, team) => (await canManageTeam(user, team)) || (await hasOrgGrant(user, team.organisation_id, ['owner', 'admin', 'finance']));
const money = (minor, currency) => `${currency} ${toMajor(Number(minor), currency)}`;
const today = () => new Date().toISOString().slice(0, 10);

/** Who pays for this member: themselves, or - for a young person - their first currently verified guardian. null = nobody can be asked yet. */
export async function payerFor(c, memberId) {
  if (!(await isYouth(memberId, c))) return memberId;
  return (await guardiansOf(memberId, c))[0] ?? null;
}

/**
 * Split `total` over members so the shares add up to the minor unit, the same way every time: members are ordered by id and rounding is
 * cumulative (settlement.allocate). `weights` and `exact` are keyed by user id; a member left out of them takes no share.
 */
export function splitShares(total, memberIds, { mode, weights = {}, exact = {} }) {
  const ids = [...memberIds].sort();
  if (mode === 'exact') {
    const sum = ids.reduce((t, u) => t + Number(exact[u] ?? 0), 0);
    if (sum !== total) throw conflict(`The shares add up to ${sum}, not the expense total ${total}`, { code: 'shares_mismatch', shares_minor: sum, total_minor: total });
    return ids.map((u) => [u, Number(exact[u] ?? 0)]);
  }
  const w = ids.map((u) => (mode === 'weights' ? Number(weights[u] ?? 0) : 1));
  const parts = allocate(total, w);
  return ids.map((u, k) => [u, parts[k]]);
}

/** Insert a batch's charges and tell each payer once. `members` = [{ user_id, amount_minor, settled_minor? }]. Returns { charges, skipped }. */
export async function raiseBatch(c, { team, batch, members, actor, notifyPayers = true }) {
  const charges = [], skipped = [];
  for (const m of members) {
    const payer = await payerFor(c, m.user_id);
    if (!payer) { skipped.push({ user_id: m.user_id, reason: 'no_verified_guardian' }); continue; }
    const ch = (await c.query(
      `INSERT INTO team_charges(batch_id, team_id, member_id, payer_id, amount_minor, due_on) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (batch_id, member_id) DO NOTHING RETURNING *`,
      [batch.id, team.id, m.user_id, payer, m.amount_minor, batch.due_text ?? null])).rows[0];
    if (!ch) continue;
    await c.query("INSERT INTO team_charge_entries(charge_id, kind, amount_minor, actor_id, idempotency_key) VALUES ($1,'raised',$2,$3,'raised')", [ch.id, m.amount_minor, actor]);
    await syncTeamChargeInvoice(c, ch.id);
    if (m.settled_minor) {   // the person who fronted an expense already carries their own share
      await c.query("INSERT INTO team_charge_entries(charge_id, kind, amount_minor, method, actor_id, idempotency_key) VALUES ($1,'receipt',$2,'fronted',$3,'fronted')", [ch.id, m.settled_minor, actor]);
      if (m.settled_minor >= m.amount_minor) await settleTeamChargeInvoice(c, ch.id, 'fronted');
      await c.query("UPDATE team_charges SET settled_minor=$2, status=CASE WHEN $2 >= amount_minor THEN 'paid' ELSE status END, paid_at=CASE WHEN $2 >= amount_minor THEN now() END WHERE id=$1", [ch.id, m.settled_minor]);
      continue;
    }
    if (notifyPayers && m.amount_minor > 0) {
      await notify(c, payer, { kind: 'team_charge_raised', title: `${team.name}: ${batch.title}`, body: `${money(m.amount_minor, batch.currency)}${batch.due_text ? ` due ${batch.due_text}` : ''}${payer !== m.user_id ? ' (for your young player)' : ''}`,
        data: { team_id: team.id, charge_id: ch.id }, dedupe_key: `team_charge:raised:${ch.id}` });
    }
    charges.push(ch);
  }
  return { charges, skipped };
}

/**
 * Money received against a charge. Idempotent (key, or the payment). Never lets the charge go past its amount; closes it when nothing is left.
 * Returns false when it cannot be applied (cancelled, already settled, or more than is owed) so an online payment is refunded rather than lost.
 */
export async function applyReceipt(c, chargeId, { amount, method, payment = null, actor = null, key = null, note = null }) {
  const ch = (await c.query('SELECT * FROM team_charges WHERE id=$1 FOR UPDATE', [chargeId])).rows[0];
  if (!ch) return false;
  const dupe = payment ? (await c.query('SELECT 1 FROM team_charge_entries WHERE payment_id=$1', [payment.id])).rowCount : key ? (await c.query('SELECT 1 FROM team_charge_entries WHERE charge_id=$1 AND idempotency_key=$2', [chargeId, key])).rowCount : 0;
  if (dupe) return true;
  if (ch.status !== 'awaiting_payment' || amount <= 0 || amount > balanceOf(ch)) return false;
  await c.query("INSERT INTO team_charge_entries(charge_id, kind, amount_minor, method, payment_id, reason_enc, actor_id, idempotency_key) VALUES ($1,'receipt',$2,$3,$4,$5,$6,$7)",
    [chargeId, amount, method, payment?.id ?? null, sealReason(note), actor, key ?? (payment ? `payment:${payment.id}` : null)]);
  const after = (await c.query(
    `UPDATE team_charges SET settled_minor = settled_minor + $2 WHERE id=$1 RETURNING *`, [chargeId, amount])).rows[0];
  if (balanceOf(after) === 0) {
    await settleTeamChargeInvoice(c, chargeId, method);   // the invoice is settled before the charge itself closes
    await c.query("UPDATE team_charges SET status='paid', paid_at=now() WHERE id=$1", [chargeId]);
  }
  const team = (await c.query('SELECT t.name FROM teams t WHERE t.id=$1', [ch.team_id])).rows[0];
  await notify(c, ch.payer_id, { kind: 'team_charge_paid', title: `${team.name}: payment received`, body: `${money(amount, (await c.query('SELECT currency FROM team_charge_batches WHERE id=$1', [ch.batch_id])).rows[0].currency)} recorded.`, data: { team_id: ch.team_id, charge_id: ch.id }, dedupe_key: `team_charge:receipt:${chargeId}:${payment?.id ?? key}` });
  return true;
}

/** Called by the canonical payment when the provider confirms it. */
export const fulfilTeamChargePaid = (c, chargeId, payment) => applyReceipt(c, chargeId, { amount: Number(payment.amount_cents), method: 'online', payment });

/** A fundraising gift paid online. */
export async function fulfilContributionPaid(c, contributionId, payment) {
  const r = await c.query("UPDATE team_contributions SET status='paid', paid_at=now(), method='online' WHERE id=$1 AND status='awaiting_payment' AND amount_minor=$2 RETURNING id", [contributionId, Number(payment.amount_cents)]);
  return r.rowCount > 0;
}

/** Reductions and waivers: explicit, attributed rows that lower the balance. The amount that was raised is never edited. */
export async function adjust(c, chargeId, { kind, amount, reason, actor, key }) {
  const ch = (await c.query('SELECT * FROM team_charges WHERE id=$1 FOR UPDATE', [chargeId])).rows[0];
  if (!ch) return null;
  if ((await c.query('SELECT 1 FROM team_charge_entries WHERE charge_id=$1 AND idempotency_key=$2', [chargeId, key])).rowCount) return { replay: true, charge: ch };
  if (ch.status !== 'awaiting_payment') throw conflict('Only an unpaid charge can be reduced or waived');
  const bal = balanceOf(ch);
  const give = kind === 'waiver' ? bal : amount;
  if (!give || give < 1 || give > bal) throw conflict(`Only ${bal} is still owed on this charge`, { balance_minor: bal });
  await c.query('INSERT INTO team_charge_entries(charge_id, kind, amount_minor, reason_enc, actor_id, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)', [chargeId, kind, give, sealReason(reason), actor, key]);
  const after = (await c.query('UPDATE team_charges SET adjusted_minor = adjusted_minor + $2 WHERE id=$1 RETURNING *', [chargeId, give])).rows[0];
  if (balanceOf(after) === 0) {
    if (Number(after.settled_minor) > 0) await settleTeamChargeInvoice(c, chargeId, 'other');
    await c.query("UPDATE team_charges SET status=CASE WHEN settled_minor > 0 THEN 'paid' ELSE 'waived' END, paid_at=CASE WHEN settled_minor > 0 THEN now() END WHERE id=$1", [chargeId]);
  }
  await syncTeamChargeInvoice(c, chargeId);   // revised while open, voided when nothing is left to pay
  const team = (await c.query('SELECT name FROM teams WHERE id=$1', [ch.team_id])).rows[0];
  await notify(c, ch.payer_id, { kind: 'team_charge_adjusted', title: `${team.name}: your balance changed`, body: balanceOf(after) === 0 ? 'Nothing more to pay.' : 'Open the team to see what is still due.', data: { team_id: ch.team_id, charge_id: ch.id }, dedupe_key: `team_charge:adjust:${chargeId}:${key}` });
  return { replay: false, charge: (await c.query('SELECT * FROM team_charges WHERE id=$1', [chargeId])).rows[0] };
}

// ------------------------------------------------------------------------------------------------------------------ worker sweeps
/** Raise the next period of every active recurring dues plan that is due. One batch per (plan, period), so a repeat run adds nothing. */
export async function raiseTeamDues() {
  let raised = 0;
  const due = await many("SELECT p.*, p.next_on::text AS next_text, t.name AS team_name FROM team_dues_plans p JOIN teams t ON t.id=p.team_id WHERE p.status='active' AND p.next_on <= current_date AND (p.ends_on IS NULL OR p.next_on <= p.ends_on) ORDER BY p.next_on LIMIT 200");
  for (const p of due) {
    await tx(async (c) => {
      const lock = (await c.query("SELECT *, next_on::text AS next_text FROM team_dues_plans WHERE id=$1 AND status='active' AND next_on <= current_date FOR UPDATE", [p.id])).rows[0];
      if (!lock) return;
      const period = lock.next_text;
      const dueOn = new Date(+new Date(`${period}T00:00:00Z`) + lock.due_days * 864e5).toISOString().slice(0, 10);
      const batch = (await c.query(
        `INSERT INTO team_charge_batches(team_id, kind, title, currency, total_minor, split_mode, due_on, plan_id, plan_period, created_by) VALUES ($1,'dues',$2,$3,0,'fixed',$4,$5,$6,$7)
         ON CONFLICT (plan_id, plan_period) WHERE plan_id IS NOT NULL DO NOTHING RETURNING *, due_on::text AS due_text`, [lock.team_id, `${lock.title} · ${period.slice(0, 7)}`, lock.currency, dueOn, lock.id, period, lock.created_by])).rows[0];
      if (batch) {
        const members = (await c.query("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND role IN ('captain','player') ORDER BY user_id", [lock.team_id])).rows.map((r) => ({ user_id: r.user_id, amount_minor: Number(lock.amount_minor) }));
        const out = await raiseBatch(c, { team: { id: lock.team_id, name: p.team_name }, batch, members, actor: lock.created_by });
        await c.query('UPDATE team_charge_batches SET total_minor=$2 WHERE id=$1', [batch.id, out.charges.reduce((t, x) => t + Number(x.amount_minor), 0)]);
        raised++;
      }
      await c.query("UPDATE team_dues_plans SET next_on=$2::date, status=CASE WHEN ends_on IS NOT NULL AND $2::date > ends_on THEN 'ended' ELSE status END WHERE id=$1", [lock.id, addMonths(period, lock.every_months)]);
    });
  }
  return raised;
}

export { today };
