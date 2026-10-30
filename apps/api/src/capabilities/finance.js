// Unified Finance control plane (#564): the one place to see, trace, export and reconcile every money movement of an organisation (or,
// for the platform admin, of the whole platform). Read models over the canonical fin_transactions ledger; nothing here edits a movement.
// Modules post to the ledger from their own money paths (see src/finance.js); this file only reads, exports and reconciles.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx } from '../db.js';
import { notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { mustBePlatformAdmin } from '../platform.js';
import { MODULE_LABEL, getTransaction, listReconciliation, listTransactions, reconcileFinance, summary } from '../finance.js';

const FINANCE_ROLES = ['owner', 'admin', 'finance'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const cur = z.string().regex(/^[A-Z]{3}$/);
const mod = z.enum(Object.keys(MODULE_LABEL));
const filters = { from: day.optional(), to: day.optional(), currency: cur.optional(), module: mod.optional() };
const TAG = 'Finance';
const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+@-]/.test(s) ? `"${(/^[=+@-]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };

/** The books a caller may read: an organisation they hold a finance role in (404 for outsiders), or the whole platform for the platform admin. */
async function scopeOf(user, organisationId) {
  if (organisationId) { await orgFor(user, organisationId, FINANCE_ROLES); return { orgId: organisationId }; }
  await mustBePlatformAdmin(user);
  return { orgId: null };
}

cap({
  name: 'get_finance_summary', method: 'GET', path: '/finance/summary', tag: TAG,
  summary: 'Finance dashboard for an organisation (owner/admin/finance) or, without organisation_id, for the whole platform (platform admin only). Per currency, never summed across currencies: gross, tax, fees, refunds, chargebacks, net revenue, receivables (charges awaiting payment to you), payables (charges you owe), spend, and a per-module split (registration, venue, coaching, health, shop, sponsorship, suppliers, wallet, media, advertising ...). `needs_review` counts unmatched or failed items in the reconciliation queue. Amounts are minor units. Tax figures are informational, not tax advice.',
  input: z.object({ organisation_id: id.optional(), ...filters }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    return { scope: scope.orgId ? 'organisation' : 'platform', modules: MODULE_LABEL, ...(await summary(scope, i)) };
  },
});

cap({
  name: 'list_finance_transactions', method: 'GET', path: '/finance/transactions', tag: TAG,
  summary: 'Canonical money movements (owner/admin/finance of the organisation, or platform admin without organisation_id), newest first: charges, payments, refunds, chargebacks and payouts, each with its source module/object, parties, currency, gross/tax/fee/discount/net, provider reference and status. Filter by dates, module, kind, status and currency.',
  input: z.object({ organisation_id: id.optional(), ...filters, kind: z.enum(['charge', 'payment', 'refund', 'credit_note', 'chargeback', 'payout', 'payout_reversal', 'adjustment']).optional(), status: z.enum(['open', 'settled', 'failed', 'cancelled', 'disputed', 'reversed']).optional(), direction: z.enum(['in', 'out']).optional().describe('with organisation_id: money coming to the organisation (in) or going out from it (out)'), ...page }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    return listTransactions(scope, i);
  },
});

cap({
  name: 'export_finance_transactions', method: 'GET', path: '/finance/transactions/export', tag: TAG,
  summary: 'Export the filtered canonical transactions as CSV (owner/admin/finance, or platform admin). Audit-logged. Formula-looking cells are neutralised. Amounts are minor units, one row per movement; currencies are never added together.',
  input: z.object({ organisation_id: id.optional(), ...filters, kind: z.enum(['charge', 'payment', 'refund', 'credit_note', 'chargeback', 'payout', 'payout_reversal', 'adjustment']).optional(), status: z.enum(['open', 'settled', 'failed', 'cancelled', 'disputed', 'reversed']).optional() }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    const rows = await listTransactions(scope, { ...i, limit: 5000, offset: 0 });
    await audit(null, user.id, 'export_finance_transactions', scope.orgId ? 'organisations' : 'platform', scope.orgId);
    const head = ['id', 'occurred_at', 'kind', 'status', 'module', 'source_type', 'source_id', 'direction', 'currency', 'gross_minor', 'tax_minor', 'fee_minor', 'discount_minor', 'net_minor', 'provider', 'provider_ref', 'payment_id'];
    return { filename: `finance-${i.from ?? 'start'}-${i.to ?? 'today'}.csv`, rows: rows.length, csv: [head, ...rows.map((r) => head.map((h) => r[h]))].map((row) => row.map(cell).join(',')).join('\n') };
  },
});

cap({
  name: 'get_finance_transaction', method: 'GET', path: '/finance/transactions/:id', tag: TAG,
  summary: 'One canonical transaction with its trace from the source workflow through charge, invoice, payment, allocation, settlement and reconciliation, and its audit history. Opening it is audit-logged. A transaction outside your organisation is a 404.',
  input: z.object({ id, organisation_id: id.optional() }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    const t = await getTransaction(scope, i.id);
    if (!t) throw notFound('Transaction');
    await audit(null, user.id, 'view_finance_transaction', 'fin_transactions', t.id);
    return t;
  },
});

cap({
  name: 'list_finance_reconciliation', method: 'GET', path: '/finance/reconciliation', tag: TAG,
  summary: 'The reconciliation queue (owner/admin/finance of the organisation, or platform admin without organisation_id): payments the canonical ledger has not recorded, refund or amount drift, and the provider-settlement exceptions (amount mismatches, disputes, failed payouts, unrecorded provider refunds) in one list. Items resolve themselves when the records agree again.',
  input: z.object({ organisation_id: id.optional(), status: z.enum(['open', 'resolved']).default('open'), ...page }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    return listReconciliation(scope, i);
  },
});

cap({
  name: 'run_finance_reconciliation', method: 'POST', path: '/admin/finance/reconcile', tag: TAG, auth: ['admin'],
  summary: 'Platform admin: catch the canonical ledger up with the provider payment records (backfills payments and payouts made before the control plane, brings refunds in line) and open items for anything that still does not add up. Idempotent: running it twice, or beside live traffic, posts nothing twice. Nothing is ever deleted or edited.',
  input: z.object({ limit: z.coerce.number().int().min(1).max(2000).default(500) }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const out = await reconcileFinance({ limit: i.limit });
    await audit(null, user.id, 'run_finance_reconciliation', 'platform', null);
    return out;
  },
});

cap({
  name: 'resolve_finance_reconciliation_item', method: 'POST', path: '/admin/finance/reconciliation/:id/resolve', tag: TAG, auth: ['admin'],
  summary: 'Platform admin: close a canonical reconciliation item with a written reason (it stays on record). Provider-settlement exceptions are resolved with resolve_settlement_exception, which holds the dispute rules.',
  input: z.object({ id, reason: z.string().trim().min(5).max(500) }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    return tx(async (c) => {
      const x = (await c.query('SELECT * FROM fin_recon_items WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!x) throw notFound('Reconciliation item');
      if (x.status === 'resolved') return { ...x, replayed: true };
      const row = (await c.query("UPDATE fin_recon_items SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now() WHERE id=$1 RETURNING *", [x.id, i.reason, user.id])).rows[0];
      await audit(c, user.id, 'resolve_finance_reconciliation_item', 'fin_recon_items', x.id);
      return row;
    });
  },
});
