// Settlement schedule management (#697): scheduled per-venue payout statement generation, reconciliation sweeps,
// and failed-payout resolution. Settlement generation logic lives in partner-contracts.js (generateSettlement);
// this file owns the schedule table, the process sweep, and the failed-payout action path.
// Additive only. Platform-admin gated throughout.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { isPlatform, isPlatformOwner } from '../platform.js';
import { encrypt } from '../crypto.js';
import { generateSettlement } from './partner-contracts.js';
import { retryItem } from '../payouts.js';

const TAG = 'Settlement schedules';
const platformOnly = (user) => { if (!isPlatform(user)) throw forbidden('Only the platform team can do that'); };

// ------------------------------------------------------------------ helpers

const today = () => new Date().toISOString().slice(0, 10);

/** Advance a date by one cycle (weekly = +7d, biweekly = +14d, monthly = +1 calendar month). */
function nextDate(from, cycle) {
  const d = new Date(`${from}T00:00:00Z`);
  if (cycle === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (cycle === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export function scheduleView(s) {
  return {
    id: s.id, contract_id: s.contract_id, partner_id: s.partner_id, partner_name: s.partner_name,
    venue_id: s.venue_id, venue_name: s.venue_name, cycle: s.cycle, delay_days: s.delay_days,
    auto_approve: s.auto_approve, tolerance_minor: s.tolerance_minor, paused: s.paused,
    paused_reason: s.paused_reason, next_run_at: s.next_run_at, last_run_at: s.last_run_at,
    last_settlement_id: s.last_settlement_id, error_log: s.error_log, created_at: s.created_at,
  };
}

// ------------------------------------------------------------------ create

cap({
  name: 'create_settlement_schedule', method: 'POST', path: '/admin/settlement-schedules', tag: TAG, status: 201,
  summary: 'Platform team: attach an automatic settlement schedule to an accepted contract. The scheduler then generates a settlement at the end of each cycle and optionally auto-approves it when it reconciles cleanly. One schedule per contract.',
  input: z.object({
    contract_id: id,
    cycle: z.enum(['weekly', 'biweekly', 'monthly']).describe('How often settlements are generated'),
    delay_days: z.number().int().min(0).max(60).default(0).describe('Days after cycle end to wait before generating (lets late invoices settle)'),
    auto_approve: z.boolean().default(true).describe('Approve the settlement automatically when variance ≤ tolerance'),
    tolerance_minor: z.number().int().min(0).default(500).describe('Max acceptable reconciliation variance in minor currency units (default 5.00)'),
  }),
  async handler({ user }, i) {
    platformOnly(user);
    return tx(async (c) => {
      const k = (await c.query(
        `SELECT k.*, p.id AS pid, p.name AS partner_name, v.id AS vid, v.name AS venue_name, v.partner_id
           FROM partner_contracts k
           JOIN partners p ON p.id=k.partner_id
           LEFT JOIN venues v ON v.id=k.venue_id
          WHERE k.id=$1`, [i.contract_id])).rows[0];
      if (!k) throw notFound('Contract');
      if (k.status !== 'active') throw conflict('Only an accepted (active) contract can have a settlement schedule');
      if (!k.vid) throw badRequest('This contract covers all venues of the partner — a settlement schedule needs a contract tied to one venue');
      const existing = (await c.query('SELECT id FROM settlement_schedules WHERE contract_id=$1', [i.contract_id])).rows[0];
      if (existing) throw conflict('This contract already has a settlement schedule — update it instead');
      const next = nextDate(today(), i.cycle);
      const row = (await c.query(
        `INSERT INTO settlement_schedules(contract_id, partner_id, venue_id, cycle, delay_days, auto_approve, tolerance_minor, next_run_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [i.contract_id, k.pid, k.vid ?? null, i.cycle, i.delay_days, i.auto_approve, i.tolerance_minor, next, user.id])).rows[0];
      await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
        [k.pid, user.id, 'settlement_schedule_created', JSON.stringify({ schedule_id: row.id, cycle: i.cycle, next_run_at: next })]);
      return scheduleView({ ...row, partner_name: k.partner_name, venue_name: k.venue_name });
    });
  },
});

// ------------------------------------------------------------------ list / get

cap({
  name: 'list_settlement_schedules', method: 'GET', path: '/admin/settlement-schedules', tag: TAG,
  summary: 'Platform team: settlement schedules with partner/venue context, filterable by pause state, cycle or partner.',
  input: z.object({
    paused: z.boolean().optional(), partner_id: id.optional(), venue_id: id.optional(),
    cycle: z.enum(['weekly', 'biweekly', 'monthly']).optional(),
    next_run_at_before: z.string().date().optional(), ...page,
  }),
  async handler({ user }, i) {
    platformOnly(user);
    return many(
      `SELECT ss.*, p.name AS partner_name, v.name AS venue_name,
              s.settlement_no AS last_settlement_no, s.net_payable_cents AS last_net_payable_cents, s.net_payable_cents AS last_payout_cents,
              s.currency AS currency, s.status AS last_settlement_status
         FROM settlement_schedules ss
         JOIN partners p ON p.id=ss.partner_id
         LEFT JOIN venues v ON v.id=ss.venue_id
         LEFT JOIN settlements s ON s.id=ss.last_settlement_id
        WHERE ($1::bool IS NULL OR ss.paused=$1)
          AND ($2::uuid IS NULL OR ss.partner_id=$2)
          AND ($3::uuid IS NULL OR ss.venue_id=$3)
          AND ($4::text IS NULL OR ss.cycle=$4)
          AND ($5::date IS NULL OR ss.next_run_at <= $5)
        ORDER BY ss.next_run_at ASC LIMIT $6 OFFSET $7`,
      [i.paused ?? null, i.partner_id ?? null, i.venue_id ?? null, i.cycle ?? null, i.next_run_at_before ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'get_settlement_schedule', method: 'GET', path: '/admin/settlement-schedules/:id', tag: TAG,
  summary: 'Platform team: one schedule with its last 5 settlement runs and error log.',
  input: z.object({ id }),
  async handler({ user }, i) {
    platformOnly(user);
    const s = await one(
      `SELECT ss.*, p.name AS partner_name, v.name AS venue_name
         FROM settlement_schedules ss
         JOIN partners p ON p.id=ss.partner_id
         LEFT JOIN venues v ON v.id=ss.venue_id
        WHERE ss.id=$1`, [i.id]);
    if (!s) throw notFound('Settlement schedule');
    const recent = await many(
      `SELECT id, settlement_no, period_end, net_payable_cents, currency, status, created_at FROM settlements
        WHERE contract_id=$1 ORDER BY created_at DESC LIMIT 5`, [s.contract_id]);
    return { ...scheduleView(s), recent_settlements: recent };
  },
});

// ------------------------------------------------------------------ update

cap({
  name: 'update_settlement_schedule', method: 'PATCH', path: '/admin/settlement-schedules/:id', tag: TAG,
  summary: 'Platform team: adjust a schedule\'s cycle, approval settings, or pause it. Changing the cycle recomputes next_run_at from today.',
  input: z.object({
    id,
    cycle: z.enum(['weekly', 'biweekly', 'monthly']).optional(),
    delay_days: z.number().int().min(0).max(60).optional(),
    auto_approve: z.boolean().optional(),
    tolerance_minor: z.number().int().min(0).optional(),
    paused: z.boolean().optional(),
    paused_reason: z.string().max(300).optional(),
  }),
  async handler({ user }, i) {
    platformOnly(user);
    return tx(async (c) => {
      const s = (await c.query('SELECT * FROM settlement_schedules WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!s) throw notFound('Settlement schedule');
      const fields = {};
      if (i.cycle !== undefined) { fields.cycle = i.cycle; fields.next_run_at = nextDate(today(), i.cycle); }
      if (i.delay_days !== undefined) fields.delay_days = i.delay_days;
      if (i.auto_approve !== undefined) fields.auto_approve = i.auto_approve;
      if (i.tolerance_minor !== undefined) fields.tolerance_minor = i.tolerance_minor;
      if (i.paused !== undefined) { fields.paused = i.paused; fields.paused_reason = i.paused ? (i.paused_reason ?? null) : null; }
      if (!Object.keys(fields).length) return scheduleView(s);
      const sets = Object.entries(fields).map(([k], n) => `${k}=$${n + 2}`).join(', ');
      const vals = Object.values(fields);
      const updated = (await c.query(`UPDATE settlement_schedules SET ${sets}, updated_at=now() WHERE id=$1 RETURNING *`, [i.id, ...vals])).rows[0];
      await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
        [s.partner_id, user.id, 'settlement_schedule_updated', JSON.stringify({ schedule_id: i.id, changes: fields })]);
      return scheduleView(updated);
    });
  },
});

// ------------------------------------------------------------------ manual run

cap({
  name: 'run_settlement_schedule', method: 'POST', path: '/admin/settlement-schedules/:id/run', tag: TAG, status: 201,
  summary: 'Platform team: trigger an immediate out-of-band settlement run for this schedule (does not affect the normal schedule cadence).',
  input: z.object({ id, period_end: z.string().date().optional(), notes: z.string().max(300).optional() }),
  async handler({ user }, i) {
    platformOnly(user);
    const s = await one('SELECT * FROM settlement_schedules WHERE id=$1', [i.id]);
    if (!s) throw notFound('Settlement schedule');
    const end = i.period_end ?? today();
    const settlement = await generateSettlement(user, { contract_id: s.contract_id, period_end: end, dry_run: false, notes: i.notes });
    await pool.query('UPDATE settlement_schedules SET last_run_at=now(), last_settlement_id=$2, next_run_at=$3, updated_at=now() WHERE id=$1',
      [i.id, settlement.id, nextDate(end, s.cycle)]);
    await audit(pool, user.id, 'schedule_run', 'settlement_schedule', i.id);
    return { schedule_id: i.id, settlement };
  },
});

// ------------------------------------------------------------------ due schedules / batch process

cap({
  name: 'list_due_schedules', method: 'GET', path: '/admin/settlement-schedules/due', tag: TAG,
  summary: 'Platform team: schedules whose next_run_at ≤ today and that are not paused. Used by the nightly worker sweep.',
  input: z.object({}),
  async handler({ user }) {
    platformOnly(user);
    return many(
      `SELECT ss.*, p.name AS partner_name, v.name AS venue_name
         FROM settlement_schedules ss
         JOIN partners p ON p.id=ss.partner_id
         LEFT JOIN venues v ON v.id=ss.venue_id
        WHERE NOT ss.paused AND ss.next_run_at <= current_date
        ORDER BY ss.next_run_at ASC`);
  },
});

cap({
  name: 'process_due_schedules', method: 'POST', path: '/admin/settlement-schedules/process', tag: TAG,
  summary: 'Platform team: generate settlements for every due schedule in one sweep. Schedules that error are logged and skipped — the rest still run. Returns a summary: processed, succeeded, failed, skipped.',
  input: z.object({ dry_run: z.boolean().default(false) }),
  async handler({ user }, i) {
    platformOnly(user);
    const due = await many(
      `SELECT ss.* FROM settlement_schedules ss WHERE NOT ss.paused AND ss.next_run_at <= current_date ORDER BY ss.next_run_at ASC`);
    const results = [];
    let succeeded = 0, failed = 0, skipped = 0;

    for (const s of due) {
      const end = today();
      try {
        const settlement = await generateSettlement(user, { contract_id: s.contract_id, period_end: end, dry_run: i.dry_run });
        // Auto-approve when reconciled within tolerance
        let status = 'drafted';
        if (!i.dry_run && s.auto_approve) {
          // Recompute the net from the settlement's own components (the net is built from what the platform collected, not from sales).
          const variance = Math.abs(settlement.net_payable_cents - (settlement.platform_collected_cents - settlement.commission_cents - settlement.commission_tax_cents - settlement.gateway_fee_cents - settlement.reserve_held_cents + settlement.reserve_released_cents + settlement.adjustments_cents));
          if (variance <= s.tolerance_minor) {
            const approved = await tx(async (c) => {
              const r = await c.query("UPDATE settlements SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 AND status='draft' RETURNING partner_id, settlement_no", [settlement.id, user.id]);
              if (!r.rowCount) return false;
              await c.query('INSERT INTO partner_events(partner_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
                [r.rows[0].partner_id, user.id, 'settlement_approve', JSON.stringify({ settlement_no: r.rows[0].settlement_no, schedule_id: s.id, auto: true })]);
              await audit(c, user.id, 'settlement_auto_approved', 'settlements', settlement.id);
              return true;
            });
            status = approved ? 'approved' : 'drafted';
          } else {
            // Variance too large: notify platform team, don't auto-approve
            await notify(null, user.id, { kind: 'settlement_variance', title: `Settlement variance for ${settlement.settlement_no}`, body: `Variance ${variance} exceeds tolerance ${s.tolerance_minor} — manual review needed`, data: { settlement_id: settlement.id, schedule_id: s.id } });
            status = 'pending_review';
          }
        }
        if (!i.dry_run) {
          await pool.query('UPDATE settlement_schedules SET last_run_at=now(), last_settlement_id=$2, next_run_at=$3, updated_at=now() WHERE id=$1',
            [s.id, settlement.id, nextDate(end, s.cycle)]);
        }
        results.push({ schedule_id: s.id, settlement_id: settlement.id ?? null, status });
        succeeded++;
      } catch (err) {
        failed++;
        const entry = { ts: new Date().toISOString(), error: String(err.message ?? err), period_end: end };
        if (!i.dry_run) {
          const log = (Array.isArray(s.error_log) ? s.error_log : []).concat(entry).slice(-20);
          await pool.query('UPDATE settlement_schedules SET error_log=$2::jsonb, updated_at=now() WHERE id=$1', [s.id, JSON.stringify(log)]);
        }
        results.push({ schedule_id: s.id, settlement_id: null, status: 'failed', error: entry.error });
      }
    }

    return { processed: due.length, succeeded, failed, skipped, settlements: results };
  },
});

// ------------------------------------------------------------------ failed payouts

const FAILED_ACTIONS = ['retry', 'request_new_account', 'override_account', 'hold', 'escalate', 'resolved'];
// A failed item stays 'failed' (the payout_items status has no on-hold state); a hold is the latest hold/escalate entry in the action trail, cleared by a later retry/resolved.
const HELD = `coalesce((SELECT a.action IN ('hold','escalate') FROM settlement_failed_payout_actions a WHERE a.payout_item_id=pi.id ORDER BY a.id DESC LIMIT 1), false)`;

cap({
  name: 'list_failed_payouts', method: 'GET', path: '/admin/failed-payouts', tag: TAG,
  summary: 'Platform team: venue settlement payout items that have failed, with bank error details, partner/venue context, attempt count, last failure time and whether the platform team put it on hold.',
  input: z.object({ partner_id: id.optional(), ...page }),
  async handler({ user }, i) {
    platformOnly(user);
    return many(
      `SELECT pi.id, pi.batch_id, pi.source_type, pi.source_id, pi.status, pi.net_minor AS amount_cents, pi.net_minor AS amount_minor, pi.currency,
              pi.failure_code, pi.failure_reason, pi.attempt AS attempt_count, pi.decided_at AS last_attempted_at,
              ${HELD} AS held,
              (SELECT a.action FROM settlement_failed_payout_actions a WHERE a.payout_item_id=pi.id ORDER BY a.id DESC LIMIT 1) AS last_action,
              s.settlement_no, s.period_end, to_char(s.period_end, 'DD Mon YYYY') AS period, s.net_payable_cents,
              p.id AS partner_id, p.name AS partner_name, p.payout_last4,
              v.id AS venue_id, v.name AS venue_name
         FROM payout_items pi
         JOIN settlements s ON s.id=pi.source_id
         JOIN partners p ON p.id=s.partner_id
         JOIN venues v ON v.id=s.venue_id
        WHERE pi.source_type='venue_settlement'
          AND pi.status='failed'
          AND ($1::uuid IS NULL OR p.id=$1)
        ORDER BY pi.decided_at DESC NULLS LAST, pi.id LIMIT $2 OFFSET $3`,
      [i.partner_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'handle_failed_payout', method: 'POST', path: '/admin/failed-payouts/:payout_item_id/action', tag: TAG,
  summary: 'Platform team: resolve a failed venue-settlement payout. retry runs it again as a new attempt (the payout service re-checks the verified account and amounts); request_new_account notifies the partner to update bank details; override_account (platform owner only) supersedes the payee\'s account with a new one that must then be verified before a retry; hold freezes it (no retry until released); escalate holds it and alerts the team; resolved releases a hold.',
  input: z.object({
    payout_item_id: id,
    action: z.enum(FAILED_ACTIONS),
    note: z.string().max(500).optional(),
    new_account: z.object({
      account_holder: z.string().min(2).max(120),
      account_number: z.string().min(4).max(40),
      bank_code: z.string().max(30).optional(),
    }).optional(),
  }),
  async handler({ user }, i) {
    platformOnly(user);
    if (i.action === 'override_account' && !isPlatformOwner(user)) throw forbidden('Overriding bank account details requires platform owner access');
    if (i.action === 'override_account' && !i.new_account) throw badRequest('Provide new_account for override_account action');
    const record = (c, itemId) => c.query(
      'INSERT INTO settlement_failed_payout_actions(payout_item_id, actor_id, action, note) VALUES ($1,$2,$3,$4)', [itemId, user.id, i.action, i.note ?? null]);
    const load = (c, lock) => c.query(
      `SELECT pi.id, pi.status, pi.attempt, pi.currency, pi.net_minor, pi.payee_id, s.partner_id, s.venue_id, s.settlement_no, p.owner_id AS partner_owner_id, p.name AS partner_name,
              ${HELD} AS held
         FROM payout_items pi
         JOIN settlements s ON s.id=pi.source_id
         JOIN partners p ON p.id=s.partner_id
        WHERE pi.id=$1 AND pi.source_type='venue_settlement' ${lock ? 'FOR UPDATE OF pi' : ''}`, [i.payout_item_id]).then((r) => r.rows[0]);
    const checks = (pi) => {
      if (!pi) throw notFound('Payout item');
      if (pi.status !== 'failed') throw conflict(`This payout item is ${pi.status} — only failed items can be actioned`);
    };

    if (i.action === 'retry') {
      // The payout service owns the retry (new attempt, new idempotency key, verified account, own transaction and audit); this path adds the guard and the trail.
      const pi = await load(pool, false);
      checks(pi);
      if (pi.held) throw conflict('This payout is on hold — release it (resolved) before retrying');
      if ((pi.attempt ?? 1) >= 3) throw conflict('Maximum retry attempts (3) reached — override the account or escalate');
      await retryItem(user, { item_id: pi.id });
      await record(pool, pi.id);
      return { id: pi.id, status: 'pending', action: i.action, settlement_no: pi.settlement_no };
    }

    return tx(async (c) => {
      const pi = await load(c, true);
      checks(pi);
      let held = pi.held;

      if (i.action === 'request_new_account') {
        await notify(c, pi.partner_owner_id, {
          kind: 'failed_payout_account',
          title: `Action required: update bank details for payout ${pi.settlement_no}`,
          body: `The payout of ${(Math.abs(pi.net_minor) / 100).toFixed(2)} ${pi.currency} failed due to a bank error. Please update your bank account details to receive your payout.`,
          data: { payout_item_id: pi.id, settlement_no: pi.settlement_no },
        });
      }

      if (i.action === 'override_account') {
        // The payee's live account is superseded and the new details enter the normal verification queue (payout_accounts, pending), so a second
        // team member still verifies them before any retry can pay out. The partner record is kept in step.
        const details = encrypt(JSON.stringify({ holder_name: i.new_account.account_holder, account_number: i.new_account.account_number, bank_code: i.new_account.bank_code ?? '' }), 'payout_accounts.details');
        await c.query("UPDATE payout_accounts SET status='superseded' WHERE owner_id=$1 AND currency=$2 AND status IN ('pending','verified')", [pi.payee_id, pi.currency]);
        const acc = (await c.query('INSERT INTO payout_accounts(owner_id, currency, details_enc, last4) VALUES ($1,$2,$3,$4) RETURNING id',
          [pi.payee_id, pi.currency, details, i.new_account.account_number.replace(/[^A-Za-z0-9]/g, '').slice(-4)])).rows[0];
        await c.query('UPDATE partners SET payout_enc=$2, payout_last4=$3, updated_at=now() WHERE id=$1',
          [pi.partner_id, encrypt(JSON.stringify(i.new_account), 'partners.payout'), i.new_account.account_number.slice(-4)]);
        await audit(c, user.id, 'payout_account_overridden', 'partner', pi.partner_id);
        await audit(c, user.id, 'payout_account_override_submitted', 'payout_accounts', acc.id);
      }

      if (i.action === 'hold') held = true;

      if (i.action === 'escalate') {
        held = true;
        await notify(c, user.id, { kind: 'payout_escalation', title: `Payout escalated: ${pi.settlement_no}`, body: `${i.note ?? 'Escalated for review'}`, data: { payout_item_id: pi.id } });
      }

      if (i.action === 'resolved') held = false;

      // Always record action
      await record(c, pi.id);
      await audit(c, user.id, `failed_payout_${i.action}`, 'payout_items', pi.id);

      return { id: pi.id, status: pi.status, held, action: i.action, settlement_no: pi.settlement_no };
    });
  },
});

// ------------------------------------------------------------------ partner settlement summary

cap({
  name: 'partner_settlement_summary', method: 'GET', path: '/partners/:partner_id/settlement-summary', tag: TAG,
  summary: 'Partner owner or platform team: summary of a partner\'s settlement activity — active schedule, last 12 settlements, year-to-date payout, failed payouts and next scheduled run.',
  input: z.object({ partner_id: id }),
  async handler({ user }, i) {
    const p = await one('SELECT * FROM partners WHERE id=$1', [i.partner_id]);
    if (!p || (!isPlatform(user) && p.owner_id !== user.id)) throw notFound('Partner');

    const [schedule, settlements, ytd, failed, pending] = await Promise.all([
      one(`SELECT ss.*, v.name AS venue_name FROM settlement_schedules ss LEFT JOIN venues v ON v.id=ss.venue_id WHERE ss.partner_id=$1 AND NOT ss.paused ORDER BY ss.created_at DESC LIMIT 1`, [i.partner_id]),
      many(`SELECT id, settlement_no, period_start, period_end, sales_cents, commission_cents, net_payable_cents, status, currency, created_at FROM settlements WHERE partner_id=$1 AND status IN ('approved','paid','draft') ORDER BY created_at DESC LIMIT 12`, [i.partner_id]),
      one(`SELECT coalesce(sum(net_payable_cents),0)::bigint AS total FROM settlements WHERE partner_id=$1 AND status='paid' AND date_part('year', paid_at) = date_part('year', current_date)`, [i.partner_id]),
      one(`SELECT count(*)::int AS n FROM payout_items pi JOIN settlements s ON s.id=pi.source_id WHERE s.partner_id=$1 AND pi.source_type='venue_settlement' AND pi.status='failed'`, [i.partner_id]),
      many(`SELECT id, settlement_no, net_payable_cents, currency, status FROM settlements WHERE partner_id=$1 AND status IN ('draft','approved') ORDER BY created_at DESC`, [i.partner_id]),
    ]);

    return {
      partner_id: i.partner_id,
      active_schedule: schedule ?? null,
      next_run_at: schedule?.next_run_at ?? null,
      last_12_settlements: settlements,
      ytd_paid_minor: ytd?.total ?? 0,
      pending_settlements: pending,
      failed_payouts_count: failed?.n ?? 0,
    };
  },
});
