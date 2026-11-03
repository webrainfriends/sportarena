// Unified Finance control plane (#564) and its organisation edition (#593): the one place to see, trace, age, export and reconcile every money
// movement of an organisation (or, for the platform admin, of the whole platform). Read models over the canonical fin_transactions ledger;
// nothing here edits a movement or computes a figure of its own. Modules post to the ledger from their own money paths (src/finance.js,
// src/finance-sync.js); this file only reads, exports, reconciles and manages who may look.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';
import { BUCKETS, CATEGORY_LABEL, LEVELS, MODULE_LABEL, ageing, atLeast, auditTrail, financeLevel, filterOptions, getTransaction, listReconciliation, listTransactions, obligations, reconcileFinance, settlements, summary } from '../finance.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const cur = z.string().regex(/^[A-Z]{3}$/);
const mod = z.enum(Object.keys(MODULE_LABEL));
// the organisation filters: comma-separated ids, so one value or a multi-select travels the same way over REST, MCP and the app
const idList = z.string().regex(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,49}$/i, 'Comma-separated ids (up to 50)');
const catList = z.string().regex(/^[a-z_]+(,[a-z_]+){0,9}$/);
const dimFilters = {
  season_ids: idList.optional().describe('organisation seasons'), event_ids: idList.optional(), team_ids: idList.optional(), workspace_ids: idList.optional().describe('organisation workspaces (departments)'),
  categories: catList.optional().describe(`canonical views: ${Object.keys(CATEGORY_LABEL).join(', ')}`),
};
const filters = { from: day.optional(), to: day.optional(), currency: cur.optional(), module: mod.optional(), ...dimFilters };
const split = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
/** REST/MCP filter input -> the ledger's dimension filters. */
function withDims(i) {
  const { season_ids, event_ids, team_ids, workspace_ids, categories, ...rest } = i;
  const cats = split(categories);
  if (cats?.some((x) => !CATEGORY_LABEL[x])) throw badRequest('Unknown category');
  return { ...rest, season_id: split(season_ids), event_id: split(event_ids), team_id: split(team_ids), workspace_id: split(workspace_ids), category: cats };
}
const KINDS = z.enum(['charge', 'payment', 'refund', 'credit_note', 'chargeback', 'payout', 'payout_reversal', 'adjustment']);
const STATUSES = z.enum(['open', 'settled', 'failed', 'cancelled', 'disputed', 'reversed']);
const TAG = 'Finance';
const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+@-]/.test(s) ? `"${(/^[=+@-]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };

/**
 * The books a caller may read, and at which level: an organisation where they hold a finance level (owner/admin: controller, finance role: accountant,
 * or a grant), or the whole platform for the platform admin. Outsiders get 404 so existence is not leaked; a level that is too low gets 403.
 */
async function scopeOf(user, organisationId, need = 'viewer') {
  if (organisationId) {
    const org = await one('SELECT id FROM organisations WHERE id=$1', [organisationId]);
    const level = org ? await financeLevel(user, organisationId) : null;
    if (!level) {   // a member without a finance level is told so (403); anyone else learns nothing about the organisation (404)
      if (org && (await one("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [organisationId, user.id]))) throw forbidden('Your role in this organisation does not allow that');
      throw notFound('Organisation');
    }
    if (!atLeast(level, need)) throw forbidden('Your finance access in this organisation does not allow that');
    return { orgId: organisationId, level };
  }
  await mustBePlatformAdmin(user);
  return { orgId: null, level: 'controller' };
}

cap({
  name: 'get_finance_summary', method: 'GET', path: '/finance/summary', tag: TAG,
  summary: 'Finance dashboard for an organisation (owner/admin/finance role or a finance grant) or, without organisation_id, for the whole platform (platform admin only). Per currency, never summed across currencies: gross, tax, fees/commissions, refunds, chargebacks, net revenue, receivables (still owed to you, net of what was already paid), payables (you owe), spend, a per-module split and a per-category split (registration & membership, event & ticket income, venue & service income, sponsorship, supplier spend, event budget spend, settlements). Filter by period, currency, module, season_ids, event_ids, team_ids, workspace_ids and categories. `needs_review` counts unmatched or failed items in the reconciliation queue. Amounts are minor units. Tax figures are informational, not tax advice.',
  input: z.object({ organisation_id: id.optional(), ...filters }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    return { scope: scope.orgId ? 'organisation' : 'platform', level: scope.level, modules: MODULE_LABEL, categories: CATEGORY_LABEL, ...(await summary(scope, withDims(i))) };
  },
});

cap({
  name: 'list_finance_transactions', method: 'GET', path: '/finance/transactions', tag: TAG,
  summary: 'Canonical money movements (finance access of the organisation, or platform admin without organisation_id), newest first: charges, payments, refunds, chargebacks and payouts, each with its source module/object, parties, currency, gross/tax/fee/discount/net, provider reference, status, category, season/event/team/workspace and the ledger key. Filter by dates, module, kind, status, currency and the organisation filters.',
  input: z.object({ organisation_id: id.optional(), ...filters, kind: KINDS.optional(), status: STATUSES.optional(), direction: z.enum(['in', 'out']).optional().describe('with organisation_id: money coming to the organisation (in) or going out from it (out)'), ...page }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    return listTransactions(scope, withDims(i));
  },
});

cap({
  name: 'export_finance_transactions', method: 'GET', path: '/finance/transactions/export', tag: TAG,
  summary: 'Export the filtered canonical transactions as CSV (accountant level or above, or platform admin). Audit-logged. Every row keeps its provenance (source module / type / id, ledger key, payment id, provider reference) and the response carries a manifest with who generated it, when, the filters, the row count and a SHA-256 of the CSV so the file can be checked against the ledger later. Formula-looking cells are neutralised. Amounts are minor units, one row per movement; currencies are never added together.',
  input: z.object({ organisation_id: id.optional(), ...filters, kind: KINDS.optional(), status: STATUSES.optional() }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id, 'accountant');
    const rows = await listTransactions(scope, { ...withDims(i), limit: 5000, offset: 0 });
    const head = ['id', 'occurred_at', 'kind', 'status', 'module', 'category', 'source_type', 'source_id', 'ledger_key', 'direction', 'currency', 'gross_minor', 'tax_minor', 'fee_minor', 'discount_minor', 'net_minor', 'provider', 'provider_ref', 'payment_id', 'due_on', 'season_id', 'event_id', 'team_id', 'workspace_id'];
    const csv = [head, ...rows.map((r) => head.map((h) => r[h]))].map((row) => row.map(cell).join(',')).join('\n');
    const manifest = {
      generated_at: new Date().toISOString(), generated_by: user.id, scope: scope.orgId ? 'organisation' : 'platform', organisation_id: scope.orgId, ledger: 'fin_transactions (append-only canonical ledger)',
      filters: Object.fromEntries(Object.entries(i).filter(([k, v]) => v != null && k !== 'organisation_id')), rows: rows.length, truncated: rows.length >= 5000, columns: head, sha256: createHash('sha256').update(csv).digest('hex'),
    };
    await audit(null, user.id, 'export_finance_transactions', scope.orgId ? 'organisations' : 'platform', scope.orgId);
    return { filename: `finance-${i.from ?? 'start'}-${i.to ?? 'today'}.csv`, rows: rows.length, csv, manifest };
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
  name: 'get_finance_filters', method: 'GET', path: '/finance/filters', tag: TAG,
  summary: 'The values you can filter the finance books by, from the organisation\'s own data: its seasons and workspaces, the events and teams that appear in its ledger, and the canonical categories. Use them as season_ids / workspace_ids / event_ids / team_ids / categories on the other finance reads.',
  input: z.object({ organisation_id: id.optional() }),
  async handler({ user }, i) {
    return filterOptions(await scopeOf(user, i.organisation_id));
  },
});

cap({
  name: 'get_finance_ageing', method: 'GET', path: '/finance/ageing', tag: TAG,
  summary: "Receivable and payable ageing for an organisation (or the platform admin's platform view): what is still outstanding on open charges, in buckets current, 1-30, 31-60, 61-90 and 90+ days past due, per currency (never summed across currencies). Outstanding is the charge less the payments the ledger already holds for the same source. Drill into a bucket with list_finance_obligations.",
  input: z.object({ organisation_id: id.optional(), currency: cur.optional(), module: mod.optional(), ...dimFilters }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    return ageing(scope, withDims(i));
  },
});

cap({
  name: 'list_finance_obligations', method: 'GET', path: '/finance/obligations', tag: TAG,
  summary: 'Upcoming cash obligations: the open receivables (in) and payables (out) of an organisation, overdue first then by due date, each with what is outstanding, days overdue, its source (module/type/id) and ledger key for drill-down. Filter by direction, ageing bucket, due-date window, currency, module and the organisation filters.',
  input: z.object({ organisation_id: id.optional(), direction: z.enum(['in', 'out']).optional(), bucket: z.enum(BUCKETS).optional(), from_due: day.optional(), to_due: day.optional(), currency: cur.optional(), module: mod.optional(), ...dimFilters, ...page }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    return obligations(scope, withDims(i));
  },
});

cap({
  name: 'list_finance_settlements', method: 'GET', path: '/finance/settlements', tag: TAG,
  summary: 'Settlement status of the money that reaches an organisation: provider payouts and payout items with where each stands (in progress, paid, failed, reversed, on hold), their gross / fee / net, provider reference and source, plus totals per currency and status.',
  input: z.object({ organisation_id: id.optional(), from: day.optional(), to: day.optional(), currency: cur.optional(), ...page }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    return settlements(scope, i);
  },
});

cap({
  name: 'list_finance_reconciliation', method: 'GET', path: '/finance/reconciliation', tag: TAG,
  summary: 'The reconciliation queue (finance access of the organisation, or platform admin without organisation_id): payments the canonical ledger has not recorded, refund or amount drift, and the provider-settlement exceptions (amount mismatches, disputes, failed payouts, unrecorded provider refunds) in one list. Items resolve themselves when the records agree again.',
  input: z.object({ organisation_id: id.optional(), status: z.enum(['open', 'resolved']).default('open'), ...page }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    return listReconciliation(scope, i);
  },
});

cap({
  name: 'resolve_organisation_finance_reconciliation_item', method: 'POST', path: '/finance/reconciliation/:id/resolve', tag: TAG,
  summary: 'Close a canonical reconciliation item of your organisation with a written reason (accountant level or above). It stays on record and is audit-logged. Provider-settlement exceptions are resolved with resolve_settlement_exception, which holds the dispute rules. A platform admin can close any item with resolve_finance_reconciliation_item.',
  input: z.object({ id, organisation_id: id, reason: z.string().trim().min(5).max(500) }),
  async handler({ user }, i) {
    await scopeOf(user, i.organisation_id, 'accountant');
    return tx(async (c) => {
      const x = (await c.query(
        `SELECT x.* FROM fin_recon_items x WHERE x.id=$1 AND (x.organisation_id=$2 OR EXISTS (SELECT 1 FROM fin_transactions f WHERE f.payment_id=x.payment_id AND (f.payee_org_id=$2 OR f.payer_org_id=$2))) FOR UPDATE OF x`, [i.id, i.organisation_id])).rows[0];
      if (!x) throw notFound('Reconciliation item');
      if (x.status === 'resolved') return { ...x, replayed: true };
      const row = (await c.query("UPDATE fin_recon_items SET status='resolved', resolution=$2, resolved_by=$3, resolved_at=now(), organisation_id=coalesce(organisation_id,$4) WHERE id=$1 RETURNING *", [x.id, i.reason, user.id, i.organisation_id])).rows[0];
      await audit(c, user.id, 'resolve_finance_reconciliation_item', 'organisations', i.organisation_id);
      return row;
    });
  },
});

cap({
  name: 'list_finance_audit', method: 'GET', path: '/finance/audit', tag: TAG,
  summary: 'Finance audit history of an organisation (accountant level or above): who opened a transaction, exported, closed a reconciliation item or changed finance access, and every status change on its ledger rows. Newest first. Reading it is itself audit-logged.',
  input: z.object({ organisation_id: id, ...page }),
  async handler({ user }, i) {
    await scopeOf(user, i.organisation_id, 'accountant');
    const rows = await auditTrail(i.organisation_id, i);
    await audit(null, user.id, 'view_finance_audit', 'organisations', i.organisation_id);
    return rows;
  },
});

cap({
  name: 'list_finance_access', method: 'GET', path: '/finance/access', tag: TAG,
  summary: 'Who can see the finance books of an organisation (any finance level may read): members by their organisation role (owner/admin: controller, finance: accountant) and people granted viewer, accountant or controller access. Your own level is returned too.',
  input: z.object({ organisation_id: id }),
  async handler({ user }, i) {
    const scope = await scopeOf(user, i.organisation_id);
    const members = await many(
      `SELECT m.user_id, u.display_name, m.role, CASE m.role WHEN 'finance' THEN 'accountant' ELSE 'controller' END AS level FROM organisation_members m JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = $1 AND m.status = 'active' AND m.role IN ('owner','admin','finance') ORDER BY u.display_name`, [i.organisation_id]);
    const grants = await many(
      `SELECT a.id, a.user_id, u.display_name, a.level, a.created_at, g.display_name AS granted_by FROM fin_finance_access a JOIN users u ON u.id = a.user_id LEFT JOIN users g ON g.id = a.granted_by
        WHERE a.organisation_id = $1 AND a.status = 'active' ORDER BY u.display_name`, [i.organisation_id]);
    return { my_level: scope.level, levels: LEVELS, members, grants };
  },
});

cap({
  name: 'set_finance_access', method: 'POST', path: '/finance/access', tag: TAG,
  summary: "Grant, change or revoke a person's finance access to an organisation (controller level only): viewer (read), accountant (read, export, close reconciliation items) or controller (also manages access); level \"none\" revokes. Takes effect on the person's next call; the grant is kept as history, never deleted. Owners and admins always keep full control and cannot be reduced here. Audit-logged.",
  input: z.object({ organisation_id: id, user_id: id, level: z.enum([...LEVELS, 'none']) }),
  async handler({ user }, i) {
    await scopeOf(user, i.organisation_id, 'controller');
    if (!(await one('SELECT 1 FROM users WHERE id=$1', [i.user_id]))) throw notFound('Person');
    const member = await one("SELECT role FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.organisation_id, i.user_id]);
    if (member && ['owner', 'admin'].includes(member.role)) throw conflict('Owners and admins always have full finance control');
    return tx(async (c) => {
      const cur = (await c.query("SELECT * FROM fin_finance_access WHERE organisation_id=$1 AND user_id=$2 AND status='active' FOR UPDATE", [i.organisation_id, i.user_id])).rows[0];
      if (cur && cur.level === i.level) return { ...cur, replayed: true };
      if (cur) await c.query("UPDATE fin_finance_access SET status='revoked', revoked_by=$2, revoked_at=now() WHERE id=$1", [cur.id, user.id]);
      let row = null;
      if (i.level !== 'none') row = (await c.query('INSERT INTO fin_finance_access(organisation_id, user_id, level, granted_by) VALUES ($1,$2,$3,$4) RETURNING *', [i.organisation_id, i.user_id, i.level, user.id])).rows[0];
      await audit(c, user.id, 'set_finance_access', 'organisations', i.organisation_id);
      return row ?? { organisation_id: i.organisation_id, user_id: i.user_id, level: 'none', status: 'revoked' };
    });
  },
});

cap({
  name: 'run_finance_reconciliation', method: 'POST', path: '/admin/finance/reconcile', tag: TAG, auth: ['admin'],
  summary: 'Platform admin: catch the canonical ledger up with the provider payment records (backfills payments and payouts made before the control plane, brings refunds in line), puts obligations, staff-recorded receipts and event budget spend from the modules onto the ledger, fills season / event / team / workspace on every row, and opens items for anything that still does not add up. Idempotent: running it twice, or beside live traffic, posts nothing twice. Nothing is ever deleted or edited.',
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
  summary: 'Platform admin: close any canonical reconciliation item with a written reason (it stays on record). An organisation closes its own with resolve_organisation_finance_reconciliation_item. Provider-settlement exceptions are resolved with resolve_settlement_exception, which holds the dispute rules.',
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
