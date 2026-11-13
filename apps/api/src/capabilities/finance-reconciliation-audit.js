// Six-role financial reconciliation audit capability (#1128).
// Provides REST + OpenAPI + MCP endpoints for the cross-role audit console.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';
import { runSixRoleAudit, listSixRoleGaps, listAuditRuns, resolveGap } from '../finance-audit.js';

const ROLES = ['coach', 'referee', 'academy', 'organisation', 'sponsor', 'physio'];

cap({
  name: 'finance.six_role_audit.run',
  method: 'POST', path: '/finance/six-role-audit/run',
  tag: 'Finance', summary: 'Trigger a six-role financial reconciliation audit',
  input: z.object({
    org_id: id.optional(),
  }),
  async handler({ user }, { org_id }) {
    mustBePlatformAdmin(user);
    const summary = await runSixRoleAudit({ orgId: org_id ?? null, triggeredBy: user.person_id, source: 'api' });
    await audit(user, 'finance.six_role_audit.run', { org_id: org_id ?? null, summary });
    return summary;
  },
});

cap({
  name: 'finance.six_role_audit.gaps',
  method: 'GET', path: '/finance/six-role-audit/gaps',
  tag: 'Finance', summary: 'List cross-role reconciliation gap items',
  input: z.object({
    org_id: id.optional(),
    role: z.enum(ROLES).optional(),
    status: z.enum(['open', 'resolved', 'dismissed']).optional().default('open'),
    ...page,
  }),
  async handler({ user }, { org_id, role, status, limit, offset }) {
    if (!user.roles.includes('platform_admin') && !user.roles.includes('finance') && !user.roles.includes('admin')) {
      throw notFound();
    }
    const rows = await listSixRoleGaps({ orgId: org_id ?? null, role, status, limit, offset });
    return rows;
  },
});

cap({
  name: 'finance.six_role_audit.runs',
  method: 'GET', path: '/finance/six-role-audit/runs',
  tag: 'Finance', summary: 'List recent six-role audit runs',
  input: z.object({
    org_id: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  }),
  async handler({ user }, { org_id, limit }) {
    mustBePlatformAdmin(user);
    return listAuditRuns({ orgId: org_id ?? null, limit });
  },
});

cap({
  name: 'finance.six_role_audit.resolve',
  method: 'POST', path: '/finance/six-role-audit/gaps/:gap_id/resolve',
  tag: 'Finance', summary: 'Mark a reconciliation gap as resolved',
  input: z.object({
    gap_id: id,
    note: z.string().max(1000).optional(),
  }),
  async handler({ user }, { gap_id, note }) {
    mustBePlatformAdmin(user);
    const gap = (await many(`SELECT id, status FROM fin_recon_items WHERE id = $1`, [gap_id]))[0];
    if (!gap) throw notFound();
    if (gap.status !== 'open') throw badRequest('Gap is already resolved.');
    await resolveGap({ id: gap_id, resolvedBy: user.person_id, note });
    await audit(user, 'finance.six_role_audit.resolve', { gap_id, note });
    return { ok: true };
  },
});

cap({
  name: 'finance.six_role_audit.lineage',
  method: 'GET', path: '/finance/six-role-audit/lineage',
  tag: 'Finance', summary: 'Show cross-role lineage for a transaction or entity',
  input: z.object({
    transaction_id: id.optional(),
    entity_id: id.optional(),
    role: z.enum(ROLES).optional(),
  }),
  async handler({ user }, { transaction_id, entity_id, role }) {
    mustBePlatformAdmin(user);
    if (!transaction_id && !entity_id) throw badRequest('Provide transaction_id or entity_id.');
    const where = transaction_id
      ? 'l.transaction_id = $1'
      : role
        ? 'l.entity_id = $1 AND l.role = $2'
        : 'l.entity_id = $1';
    const params = transaction_id ? [transaction_id] : role ? [entity_id, role] : [entity_id];
    const rows = await many(
      `SELECT l.*, f.source_type, f.source_id AS f_source_id, f.kind, f.status AS tx_status,
              f.gross_minor, f.currency, f.created_at AS tx_at
       FROM fin_role_links l JOIN fin_transactions f ON f.id = l.transaction_id
       WHERE ${where} ORDER BY l.linked_at DESC LIMIT 200`, params);
    return rows;
  },
});

cap({
  name: 'finance.six_role_audit.summary',
  method: 'GET', path: '/finance/six-role-audit/summary',
  tag: 'Finance', summary: 'High-level six-role reconciliation health metrics',
  input: z.object({ org_id: id.optional() }),
  async handler({ user }, { org_id }) {
    mustBePlatformAdmin(user);
    const orgClause = org_id ? 'AND coalesce(r.organisation_id::text,\'\') = $1' : '';
    const params = org_id ? [org_id] : [];
    const byRole = await many(
      `SELECT r.kind,
              count(*) FILTER (WHERE r.status = 'open') AS open_count,
              count(*) FILTER (WHERE r.status = 'resolved') AS resolved_count,
              coalesce(sum(r.amount_cents) FILTER (WHERE r.status = 'open'),0)::bigint AS open_amount
       FROM fin_recon_items r
       WHERE r.kind LIKE '%\_unlinked' OR r.kind = 'six_role_gap'
         ${orgClause}
       GROUP BY r.kind ORDER BY open_count DESC`, params);
    const latestRun = org_id
      ? (await many(`SELECT * FROM fin_six_role_audit_runs WHERE organisation_id = $1 ORDER BY ran_at DESC LIMIT 1`, [org_id]))[0]
      : (await many(`SELECT * FROM fin_six_role_audit_runs WHERE organisation_id IS NULL ORDER BY ran_at DESC LIMIT 1`, []))[0];
    return { by_role: byRole, latest_run: latestRun ?? null };
  },
});
