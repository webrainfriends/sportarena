// Official payout account onboarding and management (#1018).
// Extends the platform's existing payout_accounts table (settlement.js / payouts.js).
// Adds the official-specific journey: payee identity, country-aware method selection,
// payout schedule preference, KYC tracking, hold/release, fee disclosure and failure recovery.
// Never duplicates set_payout_account / list_payout_accounts / decide_payout_account from settlement.js.
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { mustBePlatformAdmin } from '../platform.js';
import { config } from '../config.js';

const TAG = 'Officials';
const cur = z.string().trim().toUpperCase().length(3).regex(/^[A-Z]{3}$/);
const SCHEDULES = ['weekly', 'fortnightly', 'monthly', 'on_demand'];
const PAYEE_TYPES = ['individual', 'business'];
const METHODS = ['bank_transfer', 'stripe_connect', 'digital_wallet', 'paypal', 'other'];
const HOLD_ACTIONS = ['reveal_legal_name', 'reveal_tax_id', 'reveal_account_number', 'admin_hold', 'admin_release', 'admin_verify', 'admin_reject'];

// ---- helpers ----------------------------------------------------------------

const assertOwnerOrAdmin = async (c, officialId, user) => {
  if (isAdmin(user) || user.id === officialId) return;
  // allow a verified guardian with 'pay' scope
  const link = (await c.query(
    "SELECT 1 FROM guardian_links WHERE guardian_id=$1 AND child_id=$2 AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND 'pay' = ANY(scopes)",
    [user.id, officialId])).rowCount;
  if (!link) throw notFound('official payout account');
};

const maskAccount = ({ details_enc, legal_name_enc, tax_id_enc, ...rest }) => rest;

const addAudit = (c, accountId, actorId, action, ip = null) =>
  c.query('INSERT INTO official_payout_audit(account_id, actor_id, action, ip_address) VALUES ($1,$2,$3,$4)', [accountId, actorId, action, ip]);

// fee_bp and fee_flat_minor come from the platform payout settings for the currency.
const feeDisclosure = async (currency) => {
  const s = await one('SELECT withholding_bp, fee_bp, fee_flat_minor FROM payout_settings WHERE currency=$1', [currency]).catch(() => null);
  return {
    platform_fee_bp:    s?.fee_bp        ?? 0,
    platform_fee_flat:  s?.fee_flat_minor ?? 0,
    withholding_bp:     s?.withholding_bp ?? 0,
    currency,
    payor:              'GotMyGame',
    tax_note:           'Tax treatment depends on your local rules. GotMyGame does not withhold income tax on official fees unless local law requires it.',
  };
};

// ---- official: get own account ---------------------------------------------

cap({
  name: 'get_official_payout_account', method: 'GET', path: '/officials/:officialId/payout-account', tag: TAG,
  summary: 'Official (or their guardian): the current live payout account for the given currency, with masked bank details and verification status. Returns 404 when no account exists yet or the caller has no access — the status codes are identical to prevent leaking existence.',
  input: z.object({ officialId: id, currency: cur.optional() }),
  async handler({ user }, i) {
    await tx(async (c) => assertOwnerOrAdmin(c, i.officialId, user));
    const currency = i.currency ?? config.settlement?.currencies?.[0] ?? 'GBP';
    const row = await one(
      `SELECT id, owner_id, currency, method, last4, status, payee_type, payout_schedule, kyc_provider, kyc_provider_ref,
              hold_reason, held_at, released_at, source_role, decided_at, decision_reason, created_at,
              terms_accepted_at, settlement_config_ok
         FROM payout_accounts WHERE owner_id=$1 AND currency=$2 AND status IN ('pending','verified') ORDER BY created_at DESC LIMIT 1`,
      [i.officialId, currency]).catch(() => null);
    if (!row) throw notFound('official payout account');
    return row;
  },
});

// ---- official: set/replace payout account ----------------------------------

cap({
  name: 'set_official_payout_account', method: 'PUT', path: '/officials/:officialId/payout-account', tag: TAG, status: 201, scope: 'payment',
  summary: 'Official (or their guardian): create or replace the payout account. Encrypts bank details and personal identity fields. Supersedes any existing live account for that currency (kept as history). The account requires platform-team verification before any payout is sent.',
  input: z.object({
    officialId:     id,
    currency:       cur,
    payee_type:     z.enum(PAYEE_TYPES).default('individual'),
    legal_name:     z.string().trim().min(2).max(200),
    tax_country:    z.string().length(2).transform(x => x.toUpperCase()),
    tax_id:         z.string().trim().max(50).optional(),
    method:         z.enum(METHODS).default('bank_transfer'),
    holder_name:    z.string().trim().min(2).max(120),
    account_number: z.string().trim().regex(/^[A-Za-z0-9 \-]{5,34}$/, 'Enter the account number or IBAN'),
    bank_code:      z.string().trim().regex(/^[A-Za-z0-9 \-]{3,20}$/, 'Enter the bank code (sort code, IFSC, SWIFT/BIC)').optional(),
    stripe_account_id: z.string().trim().max(100).optional(),
    payout_schedule:   z.enum(SCHEDULES).default('monthly'),
  }),
  async handler({ user }, i) {
    await tx(async (c) => assertOwnerOrAdmin(c, i.officialId, user));
    if (!config.settlement.currencies.includes(i.currency)) throw badRequest(`Payouts are supported in ${config.settlement.currencies.join(', ')} only`);
    const details = { holder_name: i.holder_name, account_number: i.account_number, bank_code: i.bank_code ?? '', stripe_account_id: i.stripe_account_id ?? null };
    const acc = await tx(async (c) => {
      await c.query("UPDATE payout_accounts SET status='superseded' WHERE owner_id=$1 AND currency=$2 AND status IN ('pending','verified')", [i.officialId, i.currency]);
      const row = (await c.query(
        `INSERT INTO payout_accounts(owner_id, currency, method, details_enc, last4, payee_type, legal_name_enc, tax_id_enc, payout_schedule, source_role)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'official') RETURNING *`,
        [i.officialId, i.currency, i.method,
         encrypt(JSON.stringify(details), 'payout_accounts.details'),
         i.account_number.replace(/[^A-Za-z0-9]/g, '').slice(-4),
         i.payee_type,
         encrypt(i.legal_name, 'payout_accounts.legal_name'),
         i.tax_id ? encrypt(i.tax_id, 'payout_accounts.tax_id') : null,
         i.payout_schedule,
        ])).rows[0];
      await audit(c, user.id, 'write_official_payout_account', 'payout_accounts', row.id);
      await notify(c, i.officialId, { kind: 'payout_account', title: 'Payout account submitted', body: `Your ${i.currency} payout account has been submitted and is pending verification.`, data: { account_id: row.id } });
      return row;
    });
    return maskAccount(acc);
  },
});

// ---- official: update schedule preference ----------------------------------

cap({
  name: 'set_official_payout_schedule', method: 'PATCH', path: '/officials/:officialId/payout-account/schedule', tag: TAG, scope: 'payment',
  summary: 'Official: update the payout schedule preference on the current live account without replacing bank details.',
  input: z.object({ officialId: id, payout_schedule: z.enum(SCHEDULES) }),
  async handler({ user }, i) {
    await tx(async (c) => assertOwnerOrAdmin(c, i.officialId, user));
    const updated = await one(
      "UPDATE payout_accounts SET payout_schedule=$1 WHERE owner_id=$2 AND status IN ('pending','verified') RETURNING id, payout_schedule, status, currency",
      [i.payout_schedule, i.officialId]).catch(() => null);
    if (!updated) throw notFound('official payout account');
    return updated;
  },
});

// ---- official: fee disclosure -----------------------------------------------

cap({
  name: 'get_official_fee_disclosure', method: 'GET', path: '/officials/:officialId/payout-account/fee-disclosure', tag: TAG,
  summary: 'Official: the fee schedule for their payout currency — platform fee basis points, flat fee, withholding basis points and who the payor is. This is what GotMyGame deducts before the net amount lands in the account.',
  input: z.object({ officialId: id, currency: cur }),
  async handler({ user }, i) {
    await tx(async (c) => assertOwnerOrAdmin(c, i.officialId, user));
    return feeDisclosure(i.currency);
  },
});

// ---- official: payout history ----------------------------------------------

cap({
  name: 'list_official_payout_history', method: 'GET', path: '/officials/:officialId/payout-account/history', tag: TAG,
  summary: 'Official: paginated list of payouts sent to them, newest first, with status and gross/net amounts.',
  input: z.object({ officialId: id, currency: cur.optional(), ...page }),
  async handler({ user }, i) {
    await tx(async (c) => assertOwnerOrAdmin(c, i.officialId, user));
    const args = [i.officialId, i.limit, i.offset];
    const currClause = i.currency ? ' AND pi.currency=$4' : '';
    if (i.currency) args.splice(1, 0, i.currency);
    return many(
      `SELECT pi.id, pi.currency, pi.gross_minor, pi.fee_minor, pi.tax_minor, pi.net_minor, pi.status,
              pi.reference, pi.failure_code, pi.decided_at, pi.created_at,
              fo.fixture_id, e.name AS event_name, fo.role AS official_role
         FROM payout_items pi
         JOIN fixture_officials fo ON fo.id=pi.source_id AND pi.source_type='official_fee'
         JOIN fixtures f ON f.id=fo.fixture_id
         JOIN events e ON e.id=f.event_id
        WHERE pi.payee_id=$1${currClause}
        ORDER BY pi.created_at DESC, pi.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args);
  },
});

// ---- official: payout failures ---------------------------------------------

cap({
  name: 'list_official_payout_failures', method: 'GET', path: '/officials/:officialId/payout-account/failures', tag: TAG,
  summary: 'Official: open payout failures on their account with what went wrong and what to do next.',
  input: z.object({ officialId: id, resolved: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    await tx(async (c) => assertOwnerOrAdmin(c, i.officialId, user));
    const resolvedClause = i.resolved ? '' : 'AND f.resolved_at IS NULL';
    return many(
      `SELECT f.id, f.failure_code, f.failure_message, f.amount_cents, f.currency, f.attempted_at, f.resolved_at
         FROM official_payout_failures f WHERE f.official_id=$1 ${resolvedClause}
        ORDER BY f.attempted_at DESC, f.id DESC LIMIT $2 OFFSET $3`,
      [i.officialId, i.limit, i.offset]);
  },
});

cap({
  name: 'resolve_official_payout_failure', method: 'POST', path: '/officials/:officialId/payout-account/failures/:failureId/resolve', tag: TAG,
  summary: 'Official (or admin): mark a payout failure as resolved (e.g. after replacing the bank account). Does not trigger a retry — the platform team retries via the payout-batch flow.',
  input: z.object({ officialId: id, failureId: id }),
  async handler({ user }, i) {
    await tx(async (c) => assertOwnerOrAdmin(c, i.officialId, user));
    const updated = await one(
      'UPDATE official_payout_failures SET resolved_at=now(), resolved_by=$1 WHERE id=$2 AND official_id=$3 AND resolved_at IS NULL RETURNING id, resolved_at',
      [user.id, i.failureId, i.officialId]).catch(() => null);
    if (!updated) throw notFound('payout failure');
    return updated;
  },
});

// ---- admin: list all official payout accounts ------------------------------

cap({
  name: 'list_admin_official_payout_accounts', method: 'GET', path: '/admin/officials/payout-accounts', tag: TAG, auth: ['admin'],
  summary: 'Platform team: all official payout accounts filterable by status. Bank details not shown here.',
  input: z.object({
    status: z.enum(['pending', 'verified', 'rejected', 'superseded', 'held']).optional(),
    currency: cur.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const args = [];
    const where = [];
    if (i.status === 'held') { where.push('a.held_at IS NOT NULL AND a.released_at IS NULL'); }
    else if (i.status) { args.push(i.status); where.push(`a.status=$${args.length}`); }
    if (i.currency) { args.push(i.currency); where.push(`a.currency=$${args.length}`); }
    where.push("a.source_role='official'");
    const whereStr = where.length ? `WHERE ${where.join(' AND ')}` : '';
    args.push(i.limit, i.offset);
    return many(
      `SELECT a.id, a.owner_id, u.display_name AS owner, a.currency, a.method, a.last4, a.status,
              a.payee_type, a.payout_schedule, a.hold_reason, a.held_at, a.released_at,
              a.decided_at, a.decision_reason, a.created_at
         FROM payout_accounts a JOIN users u ON u.id=a.owner_id
         ${whereStr} ORDER BY a.created_at, a.id LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args);
  },
});

// ---- admin: reveal sensitive fields (audit-logged) ------------------------

cap({
  name: 'reveal_official_payout_account', method: 'GET', path: '/admin/officials/payout-accounts/:id/reveal', tag: TAG, auth: ['admin'],
  summary: 'Platform team (platform admin only): decrypt and return the full bank details, legal name and tax ID. Every reveal is permanently audit-logged with the actor, timestamp and IP.',
  input: z.object({ id, fields: z.array(z.enum(['bank_details', 'legal_name', 'tax_id'])).min(1) }),
  async handler({ user, req }, i) {
    await mustBePlatformAdmin(user);
    const a = await one('SELECT * FROM payout_accounts WHERE id=$1', [i.id]).catch(() => null);
    if (!a) throw notFound('payout account');
    const ip = req?.ip ?? null;
    const out = {};
    await tx(async (c) => {
      if (i.fields.includes('bank_details')) {
        out.bank_details = JSON.parse(decrypt(a.details_enc, 'payout_accounts.details'));
        await addAudit(c, a.id, user.id, 'reveal_account_number', ip);
      }
      if (i.fields.includes('legal_name') && a.legal_name_enc) {
        out.legal_name = decrypt(a.legal_name_enc, 'payout_accounts.legal_name');
        await addAudit(c, a.id, user.id, 'reveal_legal_name', ip);
      }
      if (i.fields.includes('tax_id') && a.tax_id_enc) {
        out.tax_id = decrypt(a.tax_id_enc, 'payout_accounts.tax_id');
        await addAudit(c, a.id, user.id, 'reveal_tax_id', ip);
      }
    });
    return { account_id: a.id, owner_id: a.owner_id, currency: a.currency, ...out };
  },
});

// ---- admin: hold / release -------------------------------------------------

cap({
  name: 'hold_official_payout_account', method: 'POST', path: '/admin/officials/payout-accounts/:id/hold', tag: TAG, auth: ['admin'],
  summary: 'Platform team: place an administrative hold on a payout account. No payouts will be initiated while the hold is active. The official is notified with the reason.',
  input: z.object({ id, reason: z.string().trim().min(5).max(500) }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const updated = await tx(async (c) => {
      const a = (await c.query('SELECT * FROM payout_accounts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a) throw notFound('payout account');
      if (a.held_at && !a.released_at) throw conflict('Account is already on hold');
      const r = (await c.query('UPDATE payout_accounts SET hold_reason=$1, held_at=now(), held_by=$2, released_at=NULL, released_by=NULL WHERE id=$3 RETURNING id, hold_reason, held_at', [i.reason, user.id, i.id])).rows[0];
      await addAudit(c, i.id, user.id, 'admin_hold');
      await notify(c, a.owner_id, { kind: 'payout_account', title: 'Payout account on hold', body: `Your payout account has been placed on hold. Reason: ${i.reason}`, data: { account_id: i.id } });
      return r;
    });
    return updated;
  },
});

cap({
  name: 'release_official_payout_account', method: 'POST', path: '/admin/officials/payout-accounts/:id/release', tag: TAG, auth: ['admin'],
  summary: 'Platform team: release an administrative hold. Payouts can resume at the next scheduled run.',
  input: z.object({ id, note: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const updated = await tx(async (c) => {
      const a = (await c.query('SELECT * FROM payout_accounts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a) throw notFound('payout account');
      if (!a.held_at || a.released_at) throw conflict('Account is not on hold');
      const r = (await c.query('UPDATE payout_accounts SET released_at=now(), released_by=$1 WHERE id=$2 RETURNING id, released_at', [user.id, i.id])).rows[0];
      await addAudit(c, i.id, user.id, 'admin_release');
      await notify(c, a.owner_id, { kind: 'payout_account', title: 'Payout account hold lifted', body: 'Your payout account hold has been lifted. Payouts will resume at the next scheduled run.', data: { account_id: i.id } });
      return r;
    });
    return updated;
  },
});

// ---- admin: verify / reject (official-specific) ----------------------------

cap({
  name: 'verify_official_payout_account', method: 'POST', path: '/admin/officials/payout-accounts/:id/verify', tag: TAG, auth: ['admin'],
  summary: 'Platform team: verify or reject an official payout account after KYC checks. You cannot decide your own account. The official is notified.',
  input: z.object({ id, decision: z.enum(['verify', 'reject']), reason: z.string().trim().min(5).max(500), kyc_provider: z.string().trim().max(80).optional(), kyc_provider_ref: z.string().trim().max(200).optional() }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    return tx(async (c) => {
      const a = (await c.query('SELECT * FROM payout_accounts WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!a) throw notFound('payout account');
      if (a.owner_id === user.id) throw forbidden('Another platform team member must verify your own account');
      if (a.status !== 'pending') throw conflict(`This account is already ${a.status}`);
      const status = i.decision === 'verify' ? 'verified' : 'rejected';
      const r = (await c.query(
        'UPDATE payout_accounts SET status=$1, decided_by=$2, decided_at=now(), decision_reason=$3, kyc_provider=$4, kyc_provider_ref=$5 WHERE id=$6 RETURNING id, status, decided_at',
        [status, user.id, i.reason, i.kyc_provider ?? null, i.kyc_provider_ref ?? null, i.id])).rows[0];
      await addAudit(c, i.id, user.id, `admin_${i.decision}`);
      await audit(c, user.id, `official_payout_account_${i.decision}`, 'payout_accounts', i.id);
      await notify(c, a.owner_id, { kind: 'payout_account', title: i.decision === 'verify' ? 'Payout account verified' : 'Payout account not accepted', body: i.decision === 'verify' ? 'Your payout account has been verified. You will receive earnings at the next scheduled run.' : `Payout account not accepted: ${i.reason}`, data: { account_id: i.id } });
      return r;
    });
  },
});

// ---- admin: audit trail for one account ------------------------------------

cap({
  name: 'list_official_payout_audit', method: 'GET', path: '/admin/officials/payout-accounts/:id/audit', tag: TAG, auth: ['admin'],
  summary: 'Platform team (platform admin only): full audit trail for one official payout account — all reveals, hold/release actions and verification decisions.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const a = await one('SELECT id FROM payout_accounts WHERE id=$1', [i.id]).catch(() => null);
    if (!a) throw notFound('payout account');
    return many(
      `SELECT opa.id, opa.action, opa.ip_address, opa.created_at, u.display_name AS actor
         FROM official_payout_audit opa JOIN users u ON u.id=opa.actor_id
        WHERE opa.account_id=$1 ORDER BY opa.created_at DESC, opa.id DESC LIMIT $2 OFFSET $3`,
      [i.id, i.limit, i.offset]);
  },
});

// ---- admin: record failure (called by payout batch result handler) ----------

cap({
  name: 'record_official_payout_failure', method: 'POST', path: '/admin/officials/payout-accounts/:accountId/failures', tag: TAG, auth: ['admin'], status: 201,
  summary: 'Platform team: record a payout failure on an official account (triggered when record_payout_item_result marks an official fee item as failed). The official is notified.',
  input: z.object({
    accountId: id, officialId: id, payout_item_id: id.optional(),
    failure_code: z.string().trim().max(80), failure_message: z.string().trim().max(500).optional(),
    amount_cents: z.coerce.number().int().min(0).optional(), currency: cur.optional(),
  }),
  async handler({ user }, i) {
    const r = await one(
      `INSERT INTO official_payout_failures(account_id, official_id, payout_item_id, failure_code, failure_message, amount_cents, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [i.accountId, i.officialId, i.payout_item_id ?? null, i.failure_code, i.failure_message ?? null, i.amount_cents ?? null, i.currency ?? null]);
    await notify(null, i.officialId, { kind: 'payout_account', title: 'Payout failed', body: `A payout of ${i.amount_cents ? `${(i.amount_cents / 100).toFixed(2)} ${i.currency}` : 'your earnings'} could not be completed. Update your payout account to continue receiving payments.`, data: { account_id: i.accountId, failure_id: r.id } });
    return r;
  },
});
