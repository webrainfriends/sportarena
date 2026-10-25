// Player contract money (issue #333): earned fees, expenses, the append-only ledger, payout runs, statements and the club desk.
// Reuses the existing building blocks: appearances (#322) trigger earnings, payout accounts and verification (#71) decide who can be paid,
// team_payouts (the team's settlement ledger) records what was actually paid. No escrow: the club records each transfer it makes.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { hiddenYouth } from '../youth.js';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { toCsv } from '../csv.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { requireApproved } from '../access.js';
import { toErrorBody } from '../invoke.js';
import { AppError, unauthorized } from '../errors.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { toMajor } from '../currency.js';
import { notify } from '../notify.js';
import {
  KINDS, LADDER_SQL, accessFor, dayOf, accrueContract, blockFor, conflictStale, isSoleAuthority, ladderFor, loadContract, loadPayer, readinessFor, staffRoleFor, todayIso, versionAt, versionsOf,
} from '../player-contracts.js';
import { notifyParties } from './player-contracts.js';

const TAG = 'Player contract money';
const LIVE = ['active', 'completed', 'terminated'];

// ------------------------------------------------------------------ ledger
const ENTRY_COLS = 'e.id, e.seq, e.kind, e.amount_cents, e.currency, e.component_key, e.source_type, e.source_id, e.version_no, e.occurred_on::text AS occurred_on, e.label, e.reason, e.run_line_id, e.created_by, e.created_at';

cap({
  name: 'accrue_contract_fees', method: 'POST', path: '/player-contracts/:id/accrue', tag: TAG,
  summary: 'Bring a contract\'s earnings up to date from the record: verified appearances, goals and results (#322), monthly periods and due dates. Posts only the difference (a correction is a compensating line, never an edit), so it is safe to repeat. The club\'s managers only; the contract is also brought up to date whenever it is read.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { contract, access } = await loadContract(user, i.id, c, { lock: true });
      if (!access.staff.manage) throw forbidden('Only the team\'s managers can do that');
      if (!LIVE.includes(contract.status)) throw conflict(`This contract is ${contract.status}; nothing is earned yet`);
      const r = await accrueContract(c, contract.id, user.id);
      return { ...r, ladder: await ladderFor(c, contract.id) };
    });
  },
});

cap({
  name: 'get_contract_ledger', method: 'GET', path: '/player-contracts/:id/ledger', tag: TAG,
  summary: 'The contract\'s money ledger, newest first and in a fixed order: fees earned, tax withheld, approved expenses, adjustments, payments and refunds, each signed in the payee\'s favour with its source and reason. The ladder separates earned, withheld, expenses, paid, refunded and owed. format=csv returns an export (audit-logged). Only the person paid, their guardian and the club\'s managers.',
  input: z.object({ id, kind: z.enum(['fee', 'withholding', 'expense', 'payment', 'refund', 'adjustment']).optional(), from: z.string().date().optional(), to: z.string().date().optional(), format: z.enum(['json', 'csv']).default('json'), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { contract, access } = await loadContract(user, i.id, c);
      const args = [contract.id, i.kind ?? null, i.from ?? null, i.to ?? null];
      const where = 'e.contract_id=$1 AND ($2::text IS NULL OR e.kind=$2) AND ($3::date IS NULL OR e.occurred_on >= $3) AND ($4::date IS NULL OR e.occurred_on <= $4)';
      if (i.format === 'csv') {
        const rows = (await c.query(`SELECT ${ENTRY_COLS} FROM player_contract_entries e WHERE ${where} ORDER BY e.seq LIMIT 5000`, args)).rows;
        await audit(c, user.id, 'export_contract_ledger', 'player_contracts', contract.id);
        return { filename: `${contract.contract_no}-ledger.csv`, content_type: 'text/csv', rows: rows.length, csv: toCsv(['occurred_on', 'kind', 'label', 'amount', 'currency', 'reason'], rows.map((r) => ({ ...r, amount: toMajor(Number(r.amount_cents), r.currency) }))) };
      }
      if (access.role !== 'payee') await audit(c, user.id, 'read_pii', 'player_contracts', contract.id);
      const entries = (await c.query(`SELECT ${ENTRY_COLS} FROM player_contract_entries e WHERE ${where} ORDER BY e.seq DESC LIMIT $5 OFFSET $6`, [...args, i.limit, i.offset])).rows;
      return { contract_id: contract.id, currency: contract.currency, ladder: await ladderFor(c, contract.id), entries };
    });
  },
});

const reasonText = z.string().trim().min(3).max(500);

cap({
  name: 'add_contract_adjustment', method: 'POST', path: '/player-contracts/:id/adjustments', tag: TAG, status: 201,
  summary: 'Post a correction to the ledger: a positive amount increases what the club owes, a negative amount reduces it. A reason is required and shown to the person paid; the earlier lines stay untouched. Finance only. Send a client_key so a retry posts once.',
  input: z.object({ id, amount_cents: z.coerce.number().int().refine((n) => n !== 0 && Math.abs(n) <= 10_000_000_000, 'Enter a non-zero amount'), label: z.string().trim().min(1).max(120), reason: reasonText, occurred_on: z.string().date().optional(), client_key: z.string().min(1).max(64) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { contract, access } = await loadContract(user, i.id, c, { lock: true });
      if (!access.staff.finance) throw forbidden('Only the owner or finance team can post an adjustment');
      if (!LIVE.includes(contract.status)) throw conflict(`This contract is ${contract.status}`);
      if (i.occurred_on && i.occurred_on > todayIso()) throw badRequest('An adjustment cannot be dated in the future');
      const r = (await c.query(
        `INSERT INTO player_contract_entries(contract_id, payee_id, currency, kind, amount_cents, occurred_on, label, reason, idem_key, created_by)
         VALUES ($1,$2,$3,'adjustment',$4,coalesce($5::date, current_date),$6,$7,$8,$9) ON CONFLICT (contract_id, idem_key) DO NOTHING RETURNING id`,
        [contract.id, contract.payee_id, contract.currency, i.amount_cents, i.occurred_on ?? null, i.label, i.reason, `adj:${i.client_key}`, user.id])).rows[0];
      if (r) {
        await audit(c, user.id, 'contract_adjustment', 'player_contracts', contract.id);
        await notify(c, contract.payee_id, { kind: 'player_contract_adjustment', title: `Adjustment on ${contract.contract_no}`, body: `${i.label}: ${i.reason}`, data: { contract_id: contract.id }, dedupe_key: `adj:${r.id}` });
      }
      return { duplicate: !r, ladder: await ladderFor(c, contract.id) };
    });
  },
});

cap({
  name: 'record_contract_refund', method: 'POST', path: '/player-contracts/:id/refunds', tag: TAG, status: 201,
  summary: 'Record money the person paid back to the club (an overpayment, a reversed fee). It reduces what they owe the club; nothing is deleted. Finance only. Send a client_key so a retry posts once.',
  input: z.object({ id, amount_cents: z.coerce.number().int().min(1).max(10_000_000_000), reason: reasonText, reference: z.string().trim().min(3).max(120), occurred_on: z.string().date().optional(), client_key: z.string().min(1).max(64) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { contract, access } = await loadContract(user, i.id, c, { lock: true });
      if (!access.staff.finance) throw forbidden('Only the owner or finance team can record a refund');
      if (!LIVE.includes(contract.status)) throw conflict(`This contract is ${contract.status}`);
      if (i.occurred_on && i.occurred_on > todayIso()) throw badRequest('A refund cannot be dated in the future');
      const owed = (await ladderFor(c, contract.id)).owed_cents;
      if (Number(owed) + i.amount_cents > 0) throw conflict('That is more than the person owes the club. A refund can only bring a negative balance back to zero.', { code: 'exceeds_balance' });
      const r = (await c.query(
        `INSERT INTO player_contract_entries(contract_id, payee_id, currency, kind, amount_cents, occurred_on, label, reason, idem_key, created_by)
         VALUES ($1,$2,$3,'refund',$4,coalesce($5::date, current_date),$6,$7,$8,$9) ON CONFLICT (contract_id, idem_key) DO NOTHING RETURNING id`,
        [contract.id, contract.payee_id, contract.currency, i.amount_cents, i.occurred_on ?? null, `Refund received, ref ${i.reference}`, i.reason, `refund:${i.client_key}`, user.id])).rows[0];
      if (r) await audit(c, user.id, 'contract_refund', 'player_contracts', contract.id);
      return { duplicate: !r, ladder: await ladderFor(c, contract.id) };
    });
  },
});

// ------------------------------------------------------------------ expenses
const EXP = 'x.id, x.contract_id, x.payee_id, x.fixture_id, x.category, x.incurred_on::text AS incurred_on, x.amount_cents, x.currency, x.over_limit, (x.receipt_file IS NOT NULL) AS has_receipt, x.receipt_type, x.status, x.decided_by, x.decided_at, x.decision_reason, x.paid_at, x.row_version, x.created_at';
const CATEGORIES = ['travel', 'meals', 'kit', 'accommodation', 'other'];

cap({
  name: 'submit_contract_expense', method: 'POST', path: '/player-contracts/:id/expenses', tag: TAG, status: 201,
  summary: 'Claim an expense against your active contract: type, date, amount in the contract currency, optionally the game. Attach the receipt afterwards with PUT /player-contract-expenses/{id}/receipt (raw PDF or photo body, up to 10 MB, once per claim). Over the cap in your contract it is still accepted, flagged "over limit" for the club. The note is encrypted. Safe to retry with the same client_key.',
  input: z.object({ id, category: z.enum(CATEGORIES), incurred_on: z.string().date(), amount_cents: z.coerce.number().int().min(1).max(1_000_000_000), fixture_id: id.optional(), note: z.string().trim().max(500).optional(), client_key: z.string().min(1).max(64) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const dup = (await c.query(`SELECT ${EXP} FROM player_contract_expenses x WHERE x.payee_id=$1 AND x.client_key=$2`, [user.id, i.client_key])).rows[0];
      if (dup) return dup;
      const { contract, access } = await loadContract(user, i.id, c, { lock: true });
      if (access.role !== 'payee') throw forbidden('Only the person on the contract can claim an expense');
      if (contract.status !== 'active') throw conflict(`Expenses are claimed on an active contract; this one is ${contract.status}`);
      const versions = await versionsOf(c, contract.id);
      const v = versionAt(versions, i.incurred_on) ?? versions.find((x) => x.status === 'in_force');
      if (!v || i.incurred_on < versions[0].starts_on || i.incurred_on > v.ends_on) throw badRequest('The expense date must fall inside the contract term');
      if (i.incurred_on > todayIso()) throw badRequest('The expense date cannot be in the future');
      if (i.fixture_id) {
        if (!contract.team_id || !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND (home_team_id=$2 OR away_team_id=$2)', [i.fixture_id, contract.team_id])).rowCount) throw badRequest('That game does not belong to this team');
      }
      const over = v.expense_cap_cents != null && i.amount_cents > Number(v.expense_cap_cents);
      const x = (await c.query(
        `INSERT INTO player_contract_expenses(contract_id, payee_id, fixture_id, category, incurred_on, amount_cents, currency, over_limit, note_enc, client_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [contract.id, user.id, i.fixture_id ?? null, i.category, i.incurred_on, i.amount_cents, contract.currency, over, i.note ? encrypt(i.note, 'player_contract_expenses.note') : null, i.client_key])).rows[0];
      const payerOwner = access.payer.type === 'team' ? access.payer.row.owner_id : access.payer.row.organizer_id;
      await notify(c, payerOwner, { kind: 'player_contract_expense', title: 'Expense to review', body: `${contract.contract_no}: ${i.category}${over ? ' (over the limit)' : ''}`, data: { contract_id: contract.id, expense_id: x.id }, dedupe_key: `exp:${x.id}` });
      return (await c.query(`SELECT ${EXP} FROM player_contract_expenses x WHERE x.id=$1`, [x.id])).rows[0];
    });
  },
});

cap({
  name: 'list_contract_expenses', method: 'GET', path: '/player-contract-expenses', tag: TAG,
  summary: 'Expense claims. With contract_id: that contract\'s (the person paid or the club\'s managers). With team_id or event_id: the club\'s queue, oldest waiting first. Without either: your own. Claims of a young person without current guardian consent are hidden from the club.',
  input: z.object({ contract_id: id.optional(), team_id: id.optional(), event_id: id.optional(), status: z.enum(['submitted', 'approved', 'declined', 'reimbursed', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    if ([i.contract_id, i.team_id, i.event_id].filter(Boolean).length > 1) throw badRequest('Give one of contract_id, team_id or event_id');
    let where = 'x.payee_id=$1', arg = user.id, order = 'x.created_at DESC, x.id', queue = false;
    if (i.contract_id) { const { contract } = await loadContract(user, i.contract_id); where = 'x.contract_id=$1'; arg = contract.id; }
    else if (i.team_id || i.event_id) {
      const payer = await loadPayer({ team_id: i.team_id ?? null, event_id: i.event_id ?? null });
      if (!payer.row) throw notFound(i.team_id ? 'Team' : 'Event');
      if (!(await staffRoleFor(user, payer)).manage) throw forbidden('Only the team\'s managers can see the expense queue');
      where = 'k.' + (i.team_id ? 'team_id' : 'event_id') + '=$1'; arg = i.team_id ?? i.event_id; order = "(x.status='submitted') DESC, x.created_at, x.id"; queue = true;
    }
    const rows = await many(
      `SELECT ${EXP}, k.contract_no, k.title, u.display_name AS payee_name FROM player_contract_expenses x JOIN player_contracts k ON k.id=x.contract_id JOIN users u ON u.id=x.payee_id
        WHERE ${where} AND ($2::text IS NULL OR x.status=$2) ORDER BY ${order} LIMIT $3 OFFSET $4`, [arg, i.status ?? null, i.limit, i.offset]);
    const hidden = queue ? await hiddenYouth(user, rows.map((r) => r.payee_id)) : new Set();
    return rows.map((r) => (hidden.has(r.payee_id) ? { id: r.id, hidden: true, status: r.status } : r));
  },
});

cap({
  name: 'decide_contract_expense', method: 'POST', path: '/contract-expenses/:id/decision', tag: TAG,
  summary: 'Approve or decline an expense claim (the club\'s managers; an expense over the contract limit needs the owner or finance team). Declining needs a reason the person can read. Approving adds the amount to what the club owes; it is paid in the next payout run. The person can withdraw their own claim while it is waiting. Nobody decides their own claim.',
  input: z.object({ id, decision: z.enum(['approve', 'decline', 'withdraw']), reason: z.string().trim().max(500).optional(), row_version: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const x0 = (await c.query('SELECT contract_id FROM player_contract_expenses WHERE id=$1', [i.id])).rows[0];
      if (!x0) throw notFound('Expense');
      const { contract, access } = await loadContract(user, x0.contract_id, c, { lock: true });
      const x = (await c.query('SELECT * FROM player_contract_expenses WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      const target = { approve: 'approved', decline: 'declined', withdraw: 'withdrawn' }[i.decision];
      if (x.status === target && (i.decision === 'withdraw' ? access.role === 'payee' : access.staff.manage)) return { id: x.id, status: x.status };
      if (x.row_version !== i.row_version) throw conflictStale('claim');
      if (i.decision === 'withdraw') {
        if (access.role !== 'payee') throw forbidden('Only the person who claimed it can withdraw it');
        if (x.status === 'withdrawn') return { id: x.id, status: 'withdrawn' };
        if (x.status !== 'submitted') throw conflict(`This claim is already ${x.status}`);
        await c.query("UPDATE player_contract_expenses SET status='withdrawn', row_version=row_version+1 WHERE id=$1", [x.id]);
        return { id: x.id, status: 'withdrawn' };
      }
      if (!access.staff.manage) throw forbidden('Only the club\'s managers can decide an expense');
      if (x.status === (i.decision === 'approve' ? 'approved' : 'declined')) return { id: x.id, status: x.status };
      if (x.status !== 'submitted') throw conflict(`This claim is already ${x.status}`);
      if (i.decision === 'decline' && !i.reason) throw badRequest('Tell the person why it was declined');
      if (i.decision === 'approve' && x.over_limit && !access.staff.finance) throw forbidden('This claim is over the limit in the contract. The owner or finance team must approve it.');
      await c.query('UPDATE player_contract_expenses SET status=$2, decided_by=$3, decided_at=now(), decision_reason=$4, row_version=row_version+1 WHERE id=$1', [x.id, i.decision === 'approve' ? 'approved' : 'declined', user.id, i.reason ?? null]);
      if (i.decision === 'approve') {
        await c.query(
          `INSERT INTO player_contract_entries(contract_id, payee_id, currency, kind, amount_cents, source_type, source_id, occurred_on, label, idem_key, created_by)
           VALUES ($1,$2,$3,'expense',$4,'expense',$5,current_date,$6,$7,$8) ON CONFLICT (contract_id, idem_key) DO NOTHING`,
          [contract.id, contract.payee_id, contract.currency, x.amount_cents, x.id, `Expense: ${x.category}, ${dayOf(x.incurred_on)}`, `exp:${x.id}`, user.id]);
      }
      await audit(c, user.id, `contract_expense_${i.decision}`, 'player_contract_expenses', x.id);
      await notify(c, contract.payee_id, { kind: 'player_contract_expense_decided', title: i.decision === 'approve' ? 'Expense approved' : 'Expense declined', body: i.decision === 'approve' ? `${contract.contract_no}: it will be paid in the next payout run.` : `${contract.contract_no}: ${i.reason}`, data: { contract_id: contract.id, expense_id: x.id } });
      return { id: x.id, status: i.decision === 'approve' ? 'approved' : 'declined' };
    });
  },
});

// ------------------------------------------------------------------ payout runs
const RUN_COLS = 'r.id, r.run_no, r.team_id, r.event_id, r.currency, r.as_of::text AS as_of, r.status, r.note, r.prepared_by, r.approved_by, r.approved_at, r.approval_basis, r.exported_at, r.closed_at, r.cancel_reason, r.row_version, r.created_at';

async function payerFor(user, input, c) {
  if (!!input.team_id === !!input.event_id) throw badRequest('Give either team_id or event_id');
  const payer = await loadPayer({ team_id: input.team_id ?? null, event_id: input.event_id ?? null }, c);
  if (!payer.row) throw notFound(input.team_id ? 'Team' : 'Event');
  return { payer, staff: await staffRoleFor(user, payer, c) };
}

/** Balance of one contract up to a date, and how much tax has been withheld that no earlier paid line has accounted for. */
async function balanceOf(c, contractId, asOf) {
  const r = (await c.query(
    `SELECT coalesce(sum(amount_cents),0)::bigint AS net, coalesce(-sum(amount_cents) FILTER (WHERE kind='withholding'),0)::bigint AS withheld
       FROM player_contract_entries WHERE contract_id=$1 AND occurred_on <= $2`, [contractId, asOf])).rows[0];
  const prior = (await c.query("SELECT coalesce(sum(withheld_cents),0)::bigint AS w FROM player_payout_lines WHERE contract_id=$1 AND status='paid'", [contractId])).rows[0].w;
  return { net: Number(r.net), withheld: Math.max(0, Number(r.withheld) - Number(prior)) };
}

async function runView(c, user, runId) {
  const r = (await c.query(`SELECT ${RUN_COLS} FROM player_payout_runs r WHERE r.id=$1`, [runId])).rows[0];
  if (!r) throw notFound('Payout run');
  const lines = (await c.query(
    `SELECT l.id, l.contract_id, l.payee_id, l.gross_cents, l.withheld_cents, l.net_cents, l.status, l.block_code, l.reference, l.failure_code, l.failure_reason, l.paid_at, k.contract_no, k.title, u.display_name AS payee_name
       FROM player_payout_lines l JOIN player_contracts k ON k.id=l.contract_id JOIN users u ON u.id=l.payee_id WHERE l.run_id=$1 ORDER BY u.display_name, l.id`, [runId])).rows;
  const hidden = await hiddenYouth(user, lines.map((l) => l.payee_id));
  const t = (st) => lines.filter((l) => st.includes(l.status));
  const sum = (arr, k) => arr.reduce((s, l) => s + Number(l[k]), 0);
  const counted = t(['ready', 'paid', 'failed']);
  return {
    ...r,
    totals: { gross_cents: sum(counted, 'gross_cents'), withheld_cents: sum(counted, 'withheld_cents'), net_cents: sum(counted, 'net_cents'), ready: t(['ready']).length, blocked: t(['blocked']).length, paid: t(['paid']).length, failed: t(['failed']).length, paid_cents: sum(t(['paid']), 'net_cents') },
    lines: lines.map((l) => (hidden.has(l.payee_id) ? { id: l.id, hidden: true, status: l.status, block_code: l.block_code, net_cents: null } : l)),
  };
}

const sequenceNo = async (c, prefix, seq) => (await c.query(`SELECT $1::text || '-' || to_char(now(),'YYYY') || '-' || lpad(nextval('${seq}')::text, 4, '0') AS n`, [prefix])).rows[0].n;

cap({
  name: 'create_payout_run', method: 'POST', path: '/player-payout-runs', tag: TAG, status: 201,
  summary: 'Prepare a payout run for a team or event: for every live contract in the currency, bring earnings up to date and list what is owed up to as_of (today or earlier). Each line shows gross, tax withheld and net, and is checked for a signed contract, current guardian consent and a verified bank account. Lines that fail a check are listed as blocked and stay owed; nothing is dropped. One open run per team/event and currency. Finance only.',
  input: z.object({ team_id: id.optional(), event_id: id.optional(), currency: z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase()), as_of: z.string().date().optional(), note: z.string().trim().max(500).optional(), client_key: z.string().min(1).max(64).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      if (i.client_key) {
        const dup = (await c.query('SELECT id FROM player_payout_runs WHERE prepared_by=$1 AND client_key=$2', [user.id, i.client_key])).rows[0];
        if (dup) return runView(c, user, dup.id);
      }
      const { payer, staff } = await payerFor(user, i, c);
      if (!staff.finance) throw forbidden('Only the owner or finance team can prepare a payout run');
      const asOf = i.as_of ?? todayIso();
      if (asOf > todayIso()) throw badRequest('A run can only pay what is already due. Choose today or an earlier date.');
      const scope = i.team_id ? 'team_id' : 'event_id';
      const open = (await c.query(`SELECT id, run_no FROM player_payout_runs WHERE ${scope}=$1 AND currency=$2 AND status IN ('draft','approved','exported')`, [i.team_id ?? i.event_id, i.currency])).rows[0];
      if (open) throw conflict(`Run ${open.run_no} is still open for ${i.currency}. Finish or cancel it first.`, { code: 'run_open', run_id: open.id });
      const contracts = (await c.query(
        `SELECT k.* FROM player_contracts k WHERE k.${scope}=$1 AND k.currency=$2 AND k.status = ANY($3) AND k.current_version IS NOT NULL ORDER BY k.created_at, k.id LIMIT 501`, [i.team_id ?? i.event_id, i.currency, LIVE])).rows;
      if (contracts.length > 500) throw badRequest('More than 500 contracts. Prepare the run per team instead.');
      const run = (await c.query(
        `INSERT INTO player_payout_runs(run_no, team_id, event_id, currency, as_of, note, prepared_by, client_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [await sequenceNo(c, 'PR', 'player_payout_run_seq'), i.team_id ?? null, i.event_id ?? null, i.currency, asOf, i.note ?? null, user.id, i.client_key ?? null])).rows[0];
      let owesClub = 0;
      for (const k of contracts) {
        await accrueContract(c, k.id, user.id);
        const b = await balanceOf(c, k.id, asOf);
        if (b.net < 0) { owesClub++; continue; }
        if (b.net === 0) continue;
        const block = blockFor(await readinessFor(c, k));
        const line = (await c.query(
          `INSERT INTO player_payout_lines(run_id, contract_id, payee_id, gross_cents, withheld_cents, net_cents, status, block_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [run.id, k.id, k.payee_id, b.net + b.withheld, b.withheld, b.net, block ? 'blocked' : 'ready', block?.code ?? null])).rows[0];
        await c.query("UPDATE player_contract_expenses SET run_line_id=$2 WHERE contract_id=$1 AND status='approved' AND run_line_id IS NULL", [k.id, line.id]);
      }
      await audit(c, user.id, 'create_payout_run', 'player_payout_runs', run.id);
      return { ...(await runView(c, user, run.id)), people_owing_club: owesClub, payer: { type: payer.type, name: payer.row.name } };
    });
  },
});

cap({
  name: 'list_payout_runs', method: 'GET', path: '/player-payout-runs', tag: TAG,
  summary: 'Payout runs for a team or event, newest first, with their totals. The club\'s managers only.',
  input: z.object({ team_id: id.optional(), event_id: id.optional(), status: z.enum(['draft', 'approved', 'exported', 'closed', 'cancelled']).optional(), ...page }),
  async handler({ user }, i) {
    const { staff } = await payerFor(user, i);
    if (!staff.manage) throw forbidden('Only the team\'s managers can see payout runs');
    return many(
      `SELECT ${RUN_COLS}, (SELECT coalesce(sum(net_cents) FILTER (WHERE status IN ('ready','paid','failed')),0) FROM player_payout_lines l WHERE l.run_id=r.id)::bigint AS net_cents,
              (SELECT count(*) FROM player_payout_lines l WHERE l.run_id=r.id)::int AS lines,
              (SELECT count(*) FROM player_payout_lines l WHERE l.run_id=r.id AND l.status='blocked')::int AS blocked
         FROM player_payout_runs r WHERE ${i.team_id ? 'r.team_id' : 'r.event_id'}=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC, r.id LIMIT $3 OFFSET $4`, [i.team_id ?? i.event_id, i.status ?? null, i.limit, i.offset]);
  },
});

async function loadRun(user, runId, c, { lock = false, finance = false } = {}) {
  const run = (await c.query(`SELECT * FROM player_payout_runs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [runId])).rows[0];
  if (!run) throw notFound('Payout run');
  const { payer, staff } = await payerFor(user, { team_id: run.team_id ?? undefined, event_id: run.event_id ?? undefined }, c);
  if (!(finance ? staff.finance : staff.manage)) throw notFound('Payout run');
  return { run, payer, staff };
}

cap({
  name: 'get_payout_run', method: 'GET', path: '/player-payout-runs/:id', tag: TAG,
  summary: 'One payout run with every line: gross, tax withheld, net, checks that failed, the bank reference once paid, and totals. Lines of a young person without current guardian consent are hidden placeholders.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { run, staff } = await loadRun(user, i.id, c);
      return { ...(await runView(c, user, run.id)), can_approve: staff.finance && run.status === 'draft' && (run.prepared_by !== user.id || await isSoleAuthority(user, (await payerFor(user, { team_id: run.team_id ?? undefined, event_id: run.event_id ?? undefined }, c)).payer, c)) };
    });
  },
});

cap({
  name: 'approve_payout_run', method: 'POST', path: '/player-payout-runs/:id/approve', tag: TAG,
  summary: 'Approve a prepared run (finance). A second person must approve: the preparer cannot, unless nobody else has finance authority (then the approval is marked sole_authority). Nobody approves a run that contains their own pay. Every line is checked again; lines that now fail are blocked. Approving twice changes nothing.',
  input: z.object({ id, row_version: z.coerce.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { run, payer } = await loadRun(user, i.id, c, { lock: true, finance: true });
      if (run.status === 'approved' || run.status === 'exported') return runView(c, user, run.id);
      if (run.status !== 'draft') throw conflict(`This run is ${run.status}`);
      if (run.row_version !== i.row_version) throw conflictStale('run');
      let basis = 'second_person';
      if (run.prepared_by === user.id) {
        if (!(await isSoleAuthority(user, payer, c))) throw forbidden('A second person must approve a run you prepared');
        basis = 'sole_authority';
      }
      const lines = (await c.query('SELECT l.*, k.status AS contract_status FROM player_payout_lines l JOIN player_contracts k ON k.id=l.contract_id WHERE l.run_id=$1 FOR UPDATE OF l', [run.id])).rows;
      if (lines.some((l) => l.payee_id === user.id)) throw forbidden('You cannot approve a run that contains your own pay');
      let ready = 0;
      for (const l of lines) {
        if (!['ready', 'blocked'].includes(l.status)) continue;
        const k = (await c.query('SELECT * FROM player_contracts WHERE id=$1', [l.contract_id])).rows[0];
        const block = blockFor(await readinessFor(c, k));
        await c.query('UPDATE player_payout_lines SET status=$2, block_code=$3 WHERE id=$1', [l.id, block ? 'blocked' : 'ready', block?.code ?? null]);
        if (!block) ready++;
      }
      if (!ready) throw conflict('No line is ready to pay. Fix the blocked lines (bank account, consent, signatures), then prepare a new run.', { code: 'nothing_ready' });
      await c.query("UPDATE player_payout_runs SET status='approved', approved_by=$2, approved_at=now(), approval_basis=$3, row_version=row_version+1 WHERE id=$1", [run.id, user.id, basis]);
      await audit(c, user.id, 'approve_payout_run', 'player_payout_runs', run.id);
      return runView(c, user, run.id);
    });
  },
});

cap({
  name: 'export_payout_run', method: 'POST', path: '/player-payout-runs/:id/export', tag: TAG,
  summary: 'Download the bank file (CSV) for an approved run: one row per ready line with the verified bank details of the person (decrypted for this export; every row read is audit-logged), the amount in the contract currency and a reference to quote. SportArena does not send the money: make the transfers from your bank, then record each result. Finance only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { run } = await loadRun(user, i.id, c, { lock: true, finance: true });
      if (!['approved', 'exported'].includes(run.status)) throw conflict(`Only an approved run can be exported; this one is ${run.status}`);
      const lines = (await c.query(
        `SELECT l.id, l.net_cents, k.contract_no, u.display_name FROM player_payout_lines l JOIN player_contracts k ON k.id=l.contract_id JOIN users u ON u.id=l.payee_id WHERE l.run_id=$1 AND l.status='ready' ORDER BY u.display_name, l.id`, [run.id])).rows;
      const rows = [], skipped = [];
      for (const l of lines) {
        const full = (await c.query('SELECT l.payee_id, l.contract_id FROM player_payout_lines l WHERE l.id=$1', [l.id])).rows[0];
        const owner = full.payee_id;
        // anything that stopped being true since approval (guardian consent withdrawn, account replaced) holds the line back, listed and still owed
        const block = blockFor(await readinessFor(c, (await c.query('SELECT * FROM player_contracts WHERE id=$1', [full.contract_id])).rows[0]));
        if (block) { await c.query("UPDATE player_payout_lines SET status='blocked', block_code=$2 WHERE id=$1", [l.id, block.code]); skipped.push({ line_id: l.id, reason: block.message }); continue; }
        const a = (await c.query("SELECT * FROM payout_accounts WHERE owner_id=$1 AND currency=$2 AND status='verified'", [owner, run.currency])).rows[0];
        if (!a) throw conflict(`${l.display_name} no longer has a verified ${run.currency} account. Cancel this run and prepare a new one.`, { code: 'account_changed' });
        await audit(c, user.id, 'read_payout_account', 'payout_accounts', a.id);
        const d = JSON.parse(decrypt(a.details_enc, 'payout_accounts.details'));
        rows.push({ reference: `${run.run_no}/${l.id.slice(0, 8)}`, payee: d.holder_name, account_number: d.account_number, bank_code: d.bank_code, currency: run.currency, amount: toMajor(Number(l.net_cents), run.currency), contract: l.contract_no });
      }
      if (run.status === 'approved') await c.query("UPDATE player_payout_runs SET status='exported', exported_by=$2, exported_at=now(), row_version=row_version+1 WHERE id=$1", [run.id, user.id]);
      await audit(c, user.id, 'export_payout_run', 'player_payout_runs', run.id);
      const sent = new Set(rows.map((r) => r.reference));
      return { filename: `${run.run_no}.csv`, content_type: 'text/csv', rows: rows.length, held_back: skipped, total: toMajor(lines.filter((l) => sent.has(`${run.run_no}/${l.id.slice(0, 8)}`)).reduce((s, l) => s + Number(l.net_cents), 0), run.currency), csv: toCsv(['reference', 'payee', 'account_number', 'bank_code', 'currency', 'amount', 'contract'], rows) };
    });
  },
});

/** A self-billed statement for one payment: every ledger line since the last statement, with the tax withheld and the net paid. */
async function issueStatement(c, line, contract, actor) {
  const scope = contract.team_id ? `team:${contract.team_id}` : `event:${contract.event_id}`;
  const entries = (await c.query(
    `SELECT e.* FROM player_contract_entries e WHERE e.contract_id=$1 AND e.kind <> 'payment' AND NOT EXISTS (SELECT 1 FROM player_contract_invoice_entries x WHERE x.entry_id=e.id) ORDER BY e.seq`, [contract.id])).rows;
  const net = entries.reduce((s, e) => s + Number(e.amount_cents), 0);
  const withheld = -entries.filter((e) => e.kind === 'withholding').reduce((s, e) => s + Number(e.amount_cents), 0);
  const year = new Date().getUTCFullYear();
  const key = `${scope}:INV:${year}`;
  const n = (await c.query('INSERT INTO player_contract_counters(scope_key, last_no) VALUES ($1,1) ON CONFLICT (scope_key) DO UPDATE SET last_no = player_contract_counters.last_no + 1 RETURNING last_no', [key])).rows[0].last_no;
  const inv = (await c.query(
    `INSERT INTO player_contract_invoices(number, scope_key, kind, contract_id, payee_id, run_line_id, currency, gross_cents, withheld_cents, net_cents, lines, status, issued_by, paid_at)
     VALUES ($1,$2,'statement',$3,$4,$5,$6,$7,$8,$9,$10,'paid',$11,now()) RETURNING id, number`,
    [`INV-${year}-${String(n).padStart(4, '0')}`, scope, contract.id, contract.payee_id, line.id, contract.currency, net + withheld, withheld, net,
      JSON.stringify(entries.map((e) => ({ date: dayOf(e.occurred_on), kind: e.kind, label: e.label, amount_cents: Number(e.amount_cents) }))), actor])).rows[0];
  for (const e of entries) await c.query('INSERT INTO player_contract_invoice_entries(invoice_id, entry_id) VALUES ($1,$2)', [inv.id, e.id]);
  return inv;
}

cap({
  name: 'record_payout_line_result', method: 'POST', path: '/player-payout-lines/:id/result', tag: TAG,
  summary: 'Record what happened to one line after you made the bank transfer. paid needs the bank reference (unique across payments) and posts a payment to the ledger, issues the statement, marks the expenses reimbursed and records the payment in the team ledger. failed needs a reason and leaves the amount owed, ready for the next run. The amount cannot exceed what is still owed. Repeating the same result changes nothing. Finance only.',
  input: z.object({ id, result: z.enum(['paid', 'failed']), reference: z.string().trim().min(3).max(120).optional(), failure_code: z.string().trim().min(2).max(60).optional(), failure_reason: z.string().trim().min(3).max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const l0 = (await c.query('SELECT run_id FROM player_payout_lines WHERE id=$1', [i.id])).rows[0];
      if (!l0) throw notFound('Payout line');
      const { run } = await loadRun(user, l0.run_id, c, { lock: true, finance: true });
      const line = (await c.query('SELECT * FROM player_payout_lines WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!['approved', 'exported'].includes(run.status) && line.status !== i.result) throw conflict(`The run is ${run.status}; results are recorded after approval`);
      if (line.status === i.result && (i.result === 'failed' || line.reference === i.reference)) return runView(c, user, run.id);
      if (line.status !== 'ready') throw conflict(`This line is ${line.status}`);
      const contract = (await c.query('SELECT * FROM player_contracts WHERE id=$1 FOR UPDATE', [line.contract_id])).rows[0];
      if (i.result === 'failed') {
        if (!i.failure_reason) throw badRequest('Say why the transfer failed');
        await c.query("UPDATE player_payout_lines SET status='failed', failure_code=$2, failure_reason=$3, recorded_by=$4 WHERE id=$1", [line.id, i.failure_code ?? 'bank_rejected', i.failure_reason, user.id]);
        await c.query('UPDATE player_contract_expenses SET run_line_id=NULL WHERE run_line_id=$1 AND status=\'approved\'', [line.id]);
        await notify(c, line.payee_id, { kind: 'player_payout_failed', title: 'A payment to you could not be completed', body: `${contract.contract_no}: ${i.failure_reason}. The amount is still owed; check your bank details.`, data: { contract_id: contract.id } });
      } else {
        if (!i.reference) throw badRequest('Enter the bank reference of the transfer');
        const owed = Number((await ladderFor(c, contract.id)).owed_cents);
        if (owed < Number(line.net_cents)) throw conflict('The amount owed has changed since this run was prepared and is now lower than the line. Cancel the run and prepare a new one.', { code: 'balance_changed', owed_cents: owed });
        try {
          await c.query('SAVEPOINT paid_sp');
          await c.query("UPDATE player_payout_lines SET status='paid', reference=$2, paid_at=now(), recorded_by=$3 WHERE id=$1", [line.id, i.reference, user.id]);
        } catch (e) {
          if (e.code === '23505') { await c.query('ROLLBACK TO SAVEPOINT paid_sp'); throw conflict('That bank reference is already recorded on another payment', { code: 'duplicate_reference' }); }
          throw e;
        }
        await c.query(
          `INSERT INTO player_contract_entries(contract_id, payee_id, currency, kind, amount_cents, source_type, source_id, occurred_on, label, run_line_id, idem_key, created_by)
           VALUES ($1,$2,$3,'payment',$4,'payout_line',$5,current_date,$6,$5,$7,$8) ON CONFLICT (contract_id, idem_key) DO NOTHING`,
          [contract.id, contract.payee_id, contract.currency, -Number(line.net_cents), line.id, `Payment, ref ${i.reference}`, `pay:${line.id}`, user.id]);
        await c.query("UPDATE player_contract_expenses SET status='reimbursed', paid_at=now(), row_version=row_version+1 WHERE run_line_id=$1 AND status='approved'", [line.id]);
        const inv = await issueStatement(c, line, contract, user.id);
        // the team's settlement ledger records the payment too, so existing finance reports stay complete
        if (contract.team_id) {
          await c.query(
            "INSERT INTO team_payouts(team_id, user_id, kind, amount_cents, currency, status, note, created_by, paid_by, paid_at) VALUES ($1,$2,'other',$3,$4,'paid',$5,$6,$6,now())",
            [contract.team_id, contract.payee_id, line.net_cents, contract.currency, `Contract ${contract.contract_no} · ${run.run_no} · ${inv.number}`.slice(0, 200), user.id]);
        }
        await audit(c, user.id, 'record_contract_payment', 'player_payout_lines', line.id);
        await notify(c, line.payee_id, { kind: 'player_payout_paid', title: 'You have been paid', body: `${contract.contract_no}: ${toMajor(Number(line.net_cents), contract.currency)} ${contract.currency} sent. Statement ${inv.number}.`, data: { contract_id: contract.id, invoice_id: inv.id }, dedupe_key: `pay:${line.id}` });
      }
      const left = (await c.query("SELECT count(*)::int AS n FROM player_payout_lines WHERE run_id=$1 AND status='ready'", [run.id])).rows[0].n;
      if (!left) await c.query("UPDATE player_payout_runs SET status='closed', closed_at=now(), row_version=row_version+1 WHERE id=$1 AND status IN ('approved','exported')", [run.id]);
      return runView(c, user, run.id);
    });
  },
});

cap({
  name: 'cancel_payout_run', method: 'POST', path: '/player-payout-runs/:id/cancel', tag: TAG,
  summary: 'Cancel a run that has no payment recorded yet. It is kept with the reason; every amount stays owed and appears in the next run. Finance only.',
  input: z.object({ id, reason: reasonText }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { run } = await loadRun(user, i.id, c, { lock: true, finance: true });
      if (run.status === 'cancelled') return runView(c, user, run.id);
      if (!['draft', 'approved', 'exported'].includes(run.status)) throw conflict(`This run is ${run.status}`);
      if ((await c.query("SELECT 1 FROM player_payout_lines WHERE run_id=$1 AND status='paid'", [run.id])).rowCount) throw conflict('A payment was already recorded in this run. Record the remaining results instead of cancelling.', { code: 'has_payments' });
      await c.query("UPDATE player_payout_runs SET status='cancelled', cancel_reason=$2, row_version=row_version+1 WHERE id=$1", [run.id, i.reason]);
      await c.query("UPDATE player_contract_expenses SET run_line_id=NULL WHERE run_line_id IN (SELECT id FROM player_payout_lines WHERE run_id=$1) AND status='approved'", [run.id]);
      await audit(c, user.id, 'cancel_payout_run', 'player_payout_runs', run.id);
      return runView(c, user, run.id);
    });
  },
});

// ------------------------------------------------------------------ statements and credit notes
const INV_COLS = 'v.id, v.number, v.kind, v.contract_id, v.payee_id, v.parent_id, v.currency, v.gross_cents, v.withheld_cents, v.net_cents, v.status, v.reason, v.issued_at, v.paid_at, k.contract_no, k.title';

cap({
  name: 'list_contract_invoices', method: 'GET', path: '/player-contract-invoices', tag: TAG,
  summary: 'Statements (self-billed invoices, one per payment) and credit notes. Without filters: yours. With contract_id: that contract\'s. With team_id or event_id: the club\'s, for its managers.',
  input: z.object({ contract_id: id.optional(), team_id: id.optional(), event_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if ([i.contract_id, i.team_id, i.event_id].filter(Boolean).length > 1) throw badRequest('Give one of contract_id, team_id or event_id');
    let where = 'v.payee_id=$1', arg = user.id;
    if (i.contract_id) { const { contract } = await loadContract(user, i.contract_id); where = 'v.contract_id=$1'; arg = contract.id; }
    else if (i.team_id || i.event_id) {
      const { staff } = await payerFor(user, i);
      if (!staff.manage) throw forbidden('Only the team\'s managers can list its statements');
      where = `k.${i.team_id ? 'team_id' : 'event_id'}=$1`; arg = i.team_id ?? i.event_id;
    }
    const rows = await many(`SELECT ${INV_COLS}, u.display_name AS payee_name FROM player_contract_invoices v JOIN player_contracts k ON k.id=v.contract_id JOIN users u ON u.id=v.payee_id WHERE ${where} ORDER BY v.issued_at DESC, v.id LIMIT $2 OFFSET $3`, [arg, i.limit, i.offset]);
    const hidden = where.startsWith('k.') ? await hiddenYouth(user, rows.map((r) => r.payee_id)) : new Set();
    return rows.map((r) => (hidden.has(r.payee_id) ? { id: r.id, hidden: true } : r));
  },
});

cap({
  name: 'get_contract_invoice', method: 'GET', path: '/player-contract-invoices/:id', tag: TAG,
  summary: 'One statement or credit note: payer, payee, every ledger line it covers, tax withheld and the net. Numbers are sequential per team or event and never reused; a correction is a credit note, never an edit. format=csv returns a file. Reads by the club are audit-logged.',
  input: z.object({ id, format: z.enum(['json', 'csv']).default('json') }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v = (await c.query(`SELECT ${INV_COLS}, v.lines FROM player_contract_invoices v JOIN player_contracts k ON k.id=v.contract_id WHERE v.id=$1`, [i.id])).rows[0];
      if (!v) throw notFound('Statement');
      const { contract, access } = await loadContract(user, v.contract_id, c);
      if (access.role !== 'payee') await audit(c, user.id, 'read_pii', 'player_contract_invoices', v.id);
      const payer = { type: access.payer.type, name: access.payer.row.name };
      const payee = (await c.query('SELECT display_name, handle FROM users WHERE id=$1', [v.payee_id])).rows[0];
      if (i.format === 'csv') return { filename: `${v.number}.csv`, content_type: 'text/csv', csv: toCsv(['date', 'kind', 'label', 'amount', 'currency'], v.lines.map((l) => ({ ...l, amount: toMajor(l.amount_cents, v.currency), currency: v.currency }))) };
      return { ...v, payer, payee, contract_no: contract.contract_no };
    });
  },
});

cap({
  name: 'issue_contract_credit_note', method: 'POST', path: '/player-contract-invoices/:id/credit-note', tag: TAG, status: 201,
  summary: 'Correct a statement without editing it: issue a credit note for an amount up to the statement\'s net, with a reason. It posts a negative adjustment to the ledger, so the person owes the club that amount (settled by the next run or a refund). Finance only.',
  input: z.object({ id, amount_cents: z.coerce.number().int().min(1).max(10_000_000_000), reason: reasonText, client_key: z.string().min(1).max(64) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const inv = (await c.query("SELECT * FROM player_contract_invoices WHERE id=$1 AND kind='statement'", [i.id])).rows[0];
      if (!inv) throw notFound('Statement');
      const { contract, access } = await loadContract(user, inv.contract_id, c, { lock: true });
      if (!access.staff.finance) throw forbidden('Only the owner or finance team can issue a credit note');
      const prior = (await c.query("SELECT coalesce(-sum(net_cents),0)::bigint AS s FROM player_contract_invoices WHERE parent_id=$1 AND kind='credit_note'", [inv.id])).rows[0].s;
      if (i.amount_cents + Number(prior) > Number(inv.net_cents)) throw conflict('Credit notes cannot exceed the statement', { code: 'exceeds_statement' });
      const dup = (await c.query('SELECT id FROM player_contract_entries WHERE contract_id=$1 AND idem_key=$2', [contract.id, `cn:${i.client_key}`])).rows[0];
      if (dup) return { duplicate: true };
      const year = new Date().getUTCFullYear();
      const key = `${inv.scope_key}:CN:${year}`;
      const n = (await c.query('INSERT INTO player_contract_counters(scope_key, last_no) VALUES ($1,1) ON CONFLICT (scope_key) DO UPDATE SET last_no = player_contract_counters.last_no + 1 RETURNING last_no', [key])).rows[0].last_no;
      const cn = (await c.query(
        `INSERT INTO player_contract_invoices(number, scope_key, kind, contract_id, payee_id, parent_id, currency, gross_cents, withheld_cents, net_cents, lines, status, reason, issued_by)
         VALUES ($1,$2,'credit_note',$3,$4,$5,$6,$7,0,$7,$8,'issued',$9,$10) RETURNING id, number`,
        [`CN-${year}-${String(n).padStart(4, '0')}`, inv.scope_key, contract.id, contract.payee_id, inv.id, contract.currency, -i.amount_cents, JSON.stringify([{ date: todayIso(), kind: 'adjustment', label: `Credit against ${inv.number}`, amount_cents: -i.amount_cents }]), i.reason, user.id])).rows[0];
      const e = (await c.query(
        `INSERT INTO player_contract_entries(contract_id, payee_id, currency, kind, amount_cents, source_type, source_id, occurred_on, label, reason, idem_key, created_by)
         VALUES ($1,$2,$3,'adjustment',$4,'credit_note',$5,current_date,$6,$7,$8,$9) RETURNING id`,
        [contract.id, contract.payee_id, contract.currency, -i.amount_cents, cn.id, `Credit note ${cn.number} against ${inv.number}`, i.reason, `cn:${i.client_key}`, user.id])).rows[0];
      await c.query('INSERT INTO player_contract_invoice_entries(invoice_id, entry_id) VALUES ($1,$2)', [cn.id, e.id]);
      await audit(c, user.id, 'issue_contract_credit_note', 'player_contract_invoices', cn.id);
      await notify(c, contract.payee_id, { kind: 'player_contract_credit_note', title: `Credit note ${cn.number}`, body: i.reason, data: { contract_id: contract.id, invoice_id: cn.id } });
      return { duplicate: false, id: cn.id, number: cn.number };
    });
  },
});

// ------------------------------------------------------------------ desk
cap({
  name: 'get_contract_desk', method: 'GET', path: '/player-contract-desk', tag: TAG,
  summary: 'The club\'s overview across all contracts of a team or event: counts by status, money per currency (committed value is separate from earned, withheld, expenses, paid, refunded and owed), a breakdown by role, what needs attention (accepted people without a contract, amendments and expenses waiting, blocked lines, failed payments, contracts ending within 30 days) and a reconciliation of ledger payments against recorded payout lines per currency. The club\'s managers only.',
  input: z.object({ team_id: id.optional(), event_id: id.optional() }),
  async handler({ user }, i) {
    const { staff } = await payerFor(user, i);
    if (!staff.manage) throw forbidden('Only the team\'s managers can open the contract desk');
    const col = i.team_id ? 'team_id' : 'event_id', arg = i.team_id ?? i.event_id;
    // the worker keeps earnings current; opening the desk also brings this payer's active contracts up to date (idempotent)
    for (const k of await many(`SELECT id FROM player_contracts WHERE ${col}=$1 AND status='active' ORDER BY id LIMIT 500`, [arg])) await tx((c) => accrueContract(c, k.id, null));
    const [status, money, byRole, waiting, candidates, ending, recon, openRun] = await Promise.all([
      many(`SELECT status, count(*)::int AS n FROM player_contracts WHERE ${col}=$1 GROUP BY status`, [arg]),
      many(`SELECT k.currency, count(DISTINCT k.id)::int AS contracts,
                   coalesce((SELECT sum(v.value_cents) FROM player_contract_versions v JOIN player_contracts k2 ON k2.id=v.contract_id AND v.version=k2.current_version WHERE k2.${col}=$1 AND k2.currency=k.currency AND k2.status='active'),0)::bigint AS committed_cents,
                   coalesce(sum(e.amount_cents) FILTER (WHERE e.kind='fee'),0)::bigint AS earned_cents, coalesce(-sum(e.amount_cents) FILTER (WHERE e.kind='withholding'),0)::bigint AS withheld_cents,
                   coalesce(sum(e.amount_cents) FILTER (WHERE e.kind='expense'),0)::bigint AS expenses_cents, coalesce(sum(e.amount_cents) FILTER (WHERE e.kind='adjustment'),0)::bigint AS adjustments_cents,
                   coalesce(-sum(e.amount_cents) FILTER (WHERE e.kind='payment'),0)::bigint AS paid_cents, coalesce(sum(e.amount_cents) FILTER (WHERE e.kind='refund'),0)::bigint AS refunded_cents,
                   coalesce(sum(e.amount_cents),0)::bigint AS owed_cents
              FROM player_contracts k LEFT JOIN player_contract_entries e ON e.contract_id=k.id WHERE k.${col}=$1 AND k.status IN ('active','completed','terminated') GROUP BY k.currency ORDER BY k.currency`, [arg]),
      many(`SELECT k.role, k.currency, count(*)::int AS contracts, coalesce(sum(v.value_cents),0)::bigint AS committed_cents,
                   coalesce((SELECT -sum(e.amount_cents) FROM player_contract_entries e WHERE e.contract_id = ANY(array_agg(k.id)) AND e.kind='payment'),0)::bigint AS paid_cents
              FROM player_contracts k LEFT JOIN player_contract_versions v ON v.contract_id=k.id AND v.version=k.current_version WHERE k.${col}=$1 AND k.status='active' GROUP BY k.role, k.currency ORDER BY k.role`, [arg]),
      one(`SELECT (SELECT count(*) FROM player_contract_versions v JOIN player_contracts k ON k.id=v.contract_id WHERE k.${col}=$1 AND v.status='proposed' AND k.status IN ('offered','active'))::int AS versions_waiting,
                  (SELECT count(*) FROM player_contract_expenses x JOIN player_contracts k ON k.id=x.contract_id WHERE k.${col}=$1 AND x.status='submitted')::int AS expenses_waiting,
                  (SELECT count(*) FROM player_payout_lines l JOIN player_payout_runs r ON r.id=l.run_id WHERE r.${col}=$1 AND r.status IN ('draft','approved','exported') AND l.status='blocked')::int AS blocked_lines,
                  (SELECT count(*) FROM player_payout_lines l JOIN player_payout_runs r ON r.id=l.run_id WHERE r.${col}=$1 AND l.status='failed' AND NOT EXISTS (SELECT 1 FROM player_payout_lines l2 WHERE l2.contract_id=l.contract_id AND l2.status='paid' AND l2.created_at > l.created_at))::int AS failed_payments`, [arg]),
      one(`SELECT count(*)::int AS n FROM billboard_responses r JOIN billboard_posts p ON p.id=r.post_id WHERE r.status='accepted' AND ${i.team_id ? 'p.team_id=$1' : "p.target_type='event' AND p.target_id=$1"}
             AND NOT EXISTS (SELECT 1 FROM player_contracts k WHERE k.response_id=r.id AND k.status<>'void')`, [arg]),
      one(`SELECT count(*)::int AS n FROM player_contracts k JOIN player_contract_versions v ON v.contract_id=k.id AND v.version=k.current_version WHERE k.${col}=$1 AND k.status='active' AND v.ends_on BETWEEN current_date AND current_date + 30`, [arg]),
      many(`SELECT k.currency, coalesce(-sum(e.amount_cents) FILTER (WHERE e.kind='payment'),0)::bigint AS ledger_paid_cents,
                   coalesce((SELECT sum(l.net_cents) FROM player_payout_lines l JOIN player_contracts k2 ON k2.id=l.contract_id WHERE k2.${col}=$1 AND k2.currency=k.currency AND l.status='paid'),0)::bigint AS runs_paid_cents
              FROM player_contracts k LEFT JOIN player_contract_entries e ON e.contract_id=k.id WHERE k.${col}=$1 GROUP BY k.currency`, [arg]),
      many(`SELECT ${RUN_COLS} FROM player_payout_runs r WHERE r.${col}=$1 AND r.status IN ('draft','approved','exported') ORDER BY r.created_at DESC`, [arg]),
    ]);
    return {
      contracts_by_status: Object.fromEntries(status.map((s) => [s.status, s.n])), money, by_role: byRole,
      attention: { accepted_without_contract: candidates.n, ...waiting, ending_within_30_days: ending.n },
      reconciliation: recon.map((r) => ({ currency: r.currency, ledger_paid_cents: Number(r.ledger_paid_cents), runs_paid_cents: Number(r.runs_paid_cents), balanced: Number(r.ledger_paid_cents) === Number(r.runs_paid_cents) })),
      open_runs: openRun,
    };
  },
});

export { KINDS, LADDER_SQL, accessFor, dayOf, notifyParties };

// ------------------------------------------------------------------ receipts (binary, so outside the JSON capability router)
export function contractReceiptsRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 30 : 1000, standardHeaders: true, legacyHeaders: false });
  const guard = (id_) => { if (!/^[0-9a-f-]{36}$/.test(id_)) throw notFound('Expense'); };

  // PUT /api/v1/player-contract-expenses/:id/receipt   body = the raw file (PDF, JPEG, PNG, WebP or GIF). The claimant only, once, while the claim is waiting.
  r.put('/player-contract-expenses/:id/receipt', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      requireApproved(user);
      guard(req.params.id);
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', 'File too large');
      const x = await one('SELECT * FROM player_contract_expenses WHERE id=$1', [req.params.id]);
      if (!x || x.payee_id !== user.id) throw notFound('Expense');
      if (x.status !== 'submitted') throw conflict(`A receipt can be added while the claim is waiting; this one is ${x.status}`);
      if (x.receipt_file) throw conflict('This claim already has a receipt. Withdraw it and claim again to attach a different one.', { code: 'receipt_exists' });
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniffDoc(buf);
      if (!t) throw badRequest('Unsupported file. Use a PDF or a JPEG, PNG, WebP or GIF image.');
      const { file } = await saveEncrypted('contract-receipts', 'player_contract_expenses.receipt', buf);
      const done = await one(
        "UPDATE player_contract_expenses SET receipt_file=$2, receipt_type=$3, receipt_size=$4, receipt_sha256=$5, receipt_at=now(), row_version=row_version+1 WHERE id=$1 AND receipt_file IS NULL AND status='submitted' RETURNING id",
        [x.id, file, t.type, buf.length, createHash('sha256').update(buf).digest('hex')]);
      if (!done) throw conflict('This claim already has a receipt', { code: 'receipt_exists' });
      await audit(null, user.id, 'upload_contract_receipt', 'player_contract_expenses', x.id);
      res.status(201).json({ id: x.id, has_receipt: true, receipt_type: t.type, size_bytes: buf.length });
    } catch (e) { req.resume(); fail(res, e); }
  });

  // GET /api/v1/player-contract-expenses/:id/receipt — the claimant, their guardian and the club's managers; every download is audit-logged.
  r.get('/player-contract-expenses/:id/receipt', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      guard(req.params.id);
      const x = await one('SELECT * FROM player_contract_expenses WHERE id=$1', [req.params.id]);
      if (!x || !x.receipt_file) throw notFound('Receipt');
      await loadContract(user, x.contract_id); // 404 for anyone who cannot see the contract
      const bytes = await loadEncrypted('contract-receipts', 'player_contract_expenses.receipt', x.receipt_file);
      await audit(null, user.id, 'read_pii', 'player_contract_expenses', x.id);
      res.set(docHeaders(x.receipt_type, bytes));
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Receipt') : e); }
  });
  return r;
}
