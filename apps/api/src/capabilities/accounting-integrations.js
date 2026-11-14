// India Accounting Integrations (#513): export lifecycle, effective-dated ledger/tax mapping, Tally TDL/XML and
// Zoho Books OAuth2 push. Reads from the canonical finance ledger; never writes to fin_transactions or any other
// canonical finance table. The GST profile is read-only. The Integration Hub credential/install tables are read-only.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { atLeast, financeLevel } from '../finance.js';
import { PROVIDERS, providerOf } from '../integrations/registry.js';
import { loadConfig } from '../integrations/engine.js';
import * as tallyProv from '../integrations/providers/tally.js';
import * as zohoBooksProv from '../integrations/providers/zoho-books.js';

const TAG = 'Accounting';
const ACCT_PROVIDERS = ['accounting_tally', 'accounting_zoho_books'];
const MAPPING_TYPES = ['ledger', 'tax', 'clearing', 'cost_centre'];
const DOC_TYPES = ['invoice', 'credit_note', 'payment', 'journal'];
const STATUSES = ['eligible', 'queued', 'exported', 'reconciled', 'failed', 'review'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const providerEnum = z.enum(['accounting_tally', 'accounting_zoho_books']);

/** Resolve the caller's finance access level for an org, with a minimum requirement. 404 for outsiders. */
async function acctScope(user, orgId, need = 'viewer') {
  const org = await one('SELECT id FROM organisations WHERE id=$1', [orgId]);
  if (!org) throw notFound('Organisation');
  const level = await financeLevel(user, orgId);
  if (!level) throw notFound('Organisation');
  if (!atLeast(level, need)) throw forbidden('Your finance access in this organisation does not allow that');
  return level;
}

/** Load the connected integration install + config for an accounting provider of this org, or null. */
async function installCfg(orgId, providerKey) {
  const install = await one(
    "SELECT * FROM integration_installs WHERE organisation_id=$1 AND provider_key=$2 AND status='connected' ORDER BY created_at DESC LIMIT 1",
    [orgId, providerKey]
  );
  if (!install) return null;
  const cfg = await loadConfig(install);
  return { install, cfg };
}

cap({
  name: 'get_accounting_integration_status', method: 'GET', path: '/organisations/:organisation_id/accounting/status', tag: TAG,
  summary: 'Connection health, last sync timestamp, and export counts (by status) for each accounting provider connected to this organisation. Finance viewer or above.',
  input: z.object({ organisation_id: id }),
  async handler({ user }, i) {
    await acctScope(user, i.organisation_id);
    const providers = await Promise.all(ACCT_PROVIDERS.map(async (key) => {
      const ic = await installCfg(i.organisation_id, key);
      const counts = await many(
        "SELECT status, count(*)::int FROM accounting_exports WHERE org_id=$1 AND provider=$2 GROUP BY status",
        [i.organisation_id, key]
      );
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const r of counts) byStatus[r.status] = r.count;
      const prov = providerOf(key);
      return {
        provider_key: key, provider_name: prov?.name ?? key,
        connected: !!ic?.install,
        last_sync_at: ic?.install?.last_success_at ?? null,
        last_error: ic?.install?.last_error ?? null,
        status: ic?.install?.status ?? 'not_connected',
        counts: byStatus,
      };
    }));
    return { providers };
  },
});

cap({
  name: 'list_accounting_export_mappings', method: 'GET', path: '/organisations/:organisation_id/accounting/mappings', tag: TAG,
  summary: 'Paginated list of effective-dated ledger/tax/clearing/cost-centre mappings for this organisation. Filter by provider and mapping_type.',
  input: z.object({ organisation_id: id, provider: providerEnum.optional(), mapping_type: z.enum(MAPPING_TYPES).optional(), ...page }),
  async handler({ user }, i) {
    await acctScope(user, i.organisation_id);
    const wheres = ['org_id=$1'];
    const params = [i.organisation_id];
    if (i.provider) { params.push(i.provider); wheres.push(`provider=$${params.length}`); }
    if (i.mapping_type) { params.push(i.mapping_type); wheres.push(`mapping_type=$${params.length}`); }
    const limit = Math.min(i.limit ?? 50, 200);
    const offset = i.offset ?? 0;
    params.push(limit + 1, offset);
    const rows = await many(`SELECT * FROM accounting_export_mappings WHERE ${wheres.join(' AND ')} ORDER BY provider, mapping_type, source_key, effective_from DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.slice(0, limit), more: rows.length > limit };
  },
});

cap({
  name: 'upsert_accounting_export_mapping', method: 'POST', path: '/organisations/:organisation_id/accounting/mappings', tag: TAG,
  summary: 'Create or update an effective-dated ledger/tax/clearing/cost-centre mapping. Automatically closes any overlapping open row (sets effective_to = new effective_from − 1 day). Controller access required. Conflicts if the overlap would retroactively change already-exported documents.',
  input: z.object({
    organisation_id: id, provider: providerEnum,
    mapping_type: z.enum(MAPPING_TYPES),
    source_key: z.string().min(1).max(200),
    target_account: z.string().min(1).max(200),
    effective_from: day,
    effective_to: day.optional(),
  }),
  async handler({ user }, i) {
    await acctScope(user, i.organisation_id, 'controller');
    return tx(async (c) => {
      const existing = await c.query(
        'SELECT * FROM accounting_export_mappings WHERE org_id=$1 AND provider=$2 AND mapping_type=$3 AND source_key=$4 AND effective_to IS NULL FOR UPDATE',
        [i.organisation_id, i.provider, i.mapping_type, i.source_key]
      );
      for (const row of existing.rows) {
        if (row.effective_from >= i.effective_from) {
          const hasExported = await c.query(
            "SELECT 1 FROM accounting_exports WHERE org_id=$1 AND provider=$2 AND status IN ('exported','reconciled') AND exported_at::date >= $3 LIMIT 1",
            [i.organisation_id, i.provider, row.effective_from]
          );
          if (hasExported.rows.length) throw conflict('A mapping change would retroactively affect already-exported documents. Adjust the effective_from date.');
        }
        const closeDate = new Date(i.effective_from);
        closeDate.setDate(closeDate.getDate() - 1);
        await c.query('UPDATE accounting_export_mappings SET effective_to=$1 WHERE id=$2', [closeDate.toISOString().slice(0, 10), row.id]);
      }
      await c.query(
        'INSERT INTO accounting_export_mappings(org_id, provider, mapping_type, source_key, target_account, effective_from, effective_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [i.organisation_id, i.provider, i.mapping_type, i.source_key, i.target_account, i.effective_from, i.effective_to ?? null, user.id]
      );
      await audit(c, user.id, 'accounting.mapping.upsert', 'organisation', i.organisation_id);
      return { ok: true };
    });
  },
});

cap({
  name: 'list_accounting_exports', method: 'GET', path: '/organisations/:organisation_id/accounting/exports', tag: TAG,
  summary: 'Paginated export log for this organisation. Filter by status, provider, document_type, and date range.',
  input: z.object({
    organisation_id: id,
    provider: providerEnum.optional(), status: z.enum(STATUSES).optional(),
    document_type: z.enum(DOC_TYPES).optional(),
    from: day.optional(), to: day.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    await acctScope(user, i.organisation_id);
    const wheres = ['org_id=$1'];
    const params = [i.organisation_id];
    if (i.provider) { params.push(i.provider); wheres.push(`provider=$${params.length}`); }
    if (i.status) { params.push(i.status); wheres.push(`status=$${params.length}`); }
    if (i.document_type) { params.push(i.document_type); wheres.push(`document_type=$${params.length}`); }
    if (i.from) { params.push(i.from); wheres.push(`created_at::date >= $${params.length}`); }
    if (i.to) { params.push(i.to); wheres.push(`created_at::date <= $${params.length}`); }
    const limit = Math.min(i.limit ?? 50, 200);
    const offset = i.offset ?? 0;
    params.push(limit + 1, offset);
    const rows = await many(`SELECT * FROM accounting_exports WHERE ${wheres.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.slice(0, limit), more: rows.length > limit };
  },
});

cap({
  name: 'queue_accounting_export', method: 'POST', path: '/organisations/:organisation_id/accounting/exports/queue', tag: TAG,
  summary: 'Queue a list of finance document IDs for export to an accounting provider. Documents must exist in fin_transactions or the invoices table. Only eligible, failed or review documents may be queued. Accountant or above.',
  input: z.object({
    organisation_id: id,
    provider: providerEnum,
    document_type: z.enum(DOC_TYPES),
    document_ids: z.array(id).min(1).max(200),
  }),
  async handler({ user }, i) {
    await acctScope(user, i.organisation_id, 'accountant');
    return tx(async (c) => {
      const table = i.document_type === 'payment' ? 'payments' : 'fin_transactions';
      const idCol = 'id';
      const verified = await c.query(
        `SELECT ${idCol} FROM ${table} WHERE ${idCol} = ANY($1::uuid[])`,
        [i.document_ids]
      );
      const verifiedIds = new Set(verified.rows.map((r) => r.id));
      const missing = i.document_ids.filter((did) => !verifiedIds.has(did));
      if (missing.length) throw badRequest(`Documents not found: ${missing.slice(0, 5).join(', ')}`);

      let queued = 0;
      for (const docId of i.document_ids) {
        await c.query(`
          INSERT INTO accounting_exports(org_id, provider, document_type, document_id, status)
          VALUES ($1,$2,$3,$4,'queued')
          ON CONFLICT (org_id, provider, document_type, document_id)
          DO UPDATE SET status='queued', payload_version=accounting_exports.payload_version+1, row_version=accounting_exports.row_version+1
          WHERE accounting_exports.status IN ('eligible','failed','review')
        `, [i.organisation_id, i.provider, i.document_type, docId]);
        queued++;
      }
      await audit(c, user.id, 'accounting.export.queue', 'organisation', i.organisation_id);
      return { queued };
    });
  },
});

cap({
  name: 'retry_accounting_export', method: 'POST', path: '/accounting/exports/:id/retry', tag: TAG,
  summary: 'Transition a failed or review export back to queued for re-processing. Increments payload_version. Accountant or above.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await c.query('SELECT * FROM accounting_exports WHERE id=$1 FOR UPDATE', [i.id]);
      if (!row.rows.length) throw notFound('Export');
      const exp = row.rows[0];
      await acctScope(user, exp.org_id, 'accountant');
      if (!['failed', 'review'].includes(exp.status)) throw badRequest('Only failed or review exports can be retried');
      await c.query('UPDATE accounting_exports SET status=\'queued\', payload_version=payload_version+1, row_version=row_version+1, error_message=NULL WHERE id=$1', [i.id]);
      return { ok: true };
    });
  },
});

cap({
  name: 'get_accounting_export', method: 'GET', path: '/accounting/exports/:id', tag: TAG,
  summary: 'Full detail of a single accounting export: status, document info, payload hash, version, line breakdown and error message. Finance viewer or above.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const exp = await one('SELECT * FROM accounting_exports WHERE id=$1', [i.id]);
    if (!exp) throw notFound('Export');
    await acctScope(user, exp.org_id);
    const lines = await many('SELECT * FROM accounting_export_lines WHERE export_id=$1 ORDER BY line_no', [i.id]);
    return { ...exp, lines };
  },
});

cap({
  name: 'run_accounting_sync', method: 'POST', path: '/organisations/:organisation_id/accounting/sync', tag: TAG,
  summary: 'Trigger an immediate sync: exports all queued documents for the given provider using the provider\'s push() adapter. Returns immediately with a count; individual row statuses update during processing. Accountant or above. Audit-logged.',
  input: z.object({ organisation_id: id, provider: providerEnum }),
  async handler({ user }, i) {
    await acctScope(user, i.organisation_id, 'accountant');
    const ic = await installCfg(i.organisation_id, i.provider);
    if (!ic) throw badRequest(`${i.provider} is not connected to this organisation`);

    const queued = await many(
      "SELECT * FROM accounting_exports WHERE org_id=$1 AND provider=$2 AND status='queued' ORDER BY created_at LIMIT 500",
      [i.organisation_id, i.provider]
    );
    if (!queued.length) return { queued: 0, started: false, message: 'No documents queued' };

    const exportIds = queued.map((e) => e.id);
    const allLines = await many('SELECT * FROM accounting_export_lines WHERE export_id = ANY($1::uuid[])', [exportIds]);
    const linesByExport = {};
    for (const ln of allLines) { (linesByExport[ln.export_id] ??= []).push(ln); }

    const mappings = await many(
      'SELECT * FROM accounting_export_mappings WHERE org_id=$1 AND provider=$2',
      [i.organisation_id, i.provider]
    );
    const gstProfile = await one(
      "SELECT * FROM gst_profiles WHERE owner_kind='organisation' AND owner_id=$1 AND archived_at IS NULL",
      [i.organisation_id]
    );

    let result;
    try {
      if (i.provider === 'accounting_tally') {
        result = await tallyProv.push(queued, linesByExport, mappings, gstProfile, ic.cfg);
      } else {
        result = await zohoBooksProv.push(queued, linesByExport, mappings, gstProfile, ic.cfg);
      }
    } catch (err) {
      await audit(null, user.id, 'accounting.sync.error', 'organisation', i.organisation_id);
      throw err;
    }

    await tx(async (c) => {
      const now = new Date().toISOString();
      for (const exp of queued) {
        if (exp._exported) {
          await c.query(
            "UPDATE accounting_exports SET status='exported', payload_hash=$1, exported_at=$2, external_ref=COALESCE($3, external_ref), row_version=row_version+1 WHERE id=$4",
            [exp._newHash ?? exp.payload_hash, now, exp._externalRef ?? null, exp.id]
          );
        } else if (exp._failed) {
          const errMsg = result.errors?.find((e) => e.includes(exp.document_id)) ?? 'Export failed';
          const newStatus = exp._permanent ? 'review' : 'failed';
          await c.query(
            'UPDATE accounting_exports SET status=$1, error_message=$2, row_version=row_version+1 WHERE id=$3',
            [newStatus, errMsg.slice(0, 2000), exp.id]
          );
        }
      }
    });

    await audit(null, user.id, 'accounting.sync.run', 'organisation', i.organisation_id);
    return { queued: queued.length, started: true, ...result };
  },
});

cap({
  name: 'get_accounting_reconciliation', method: 'GET', path: '/organisations/:organisation_id/accounting/reconciliation', tag: TAG,
  summary: 'Show export reconciliation state: unmatched (exported but no external_ref), changed (payload_hash would differ now), and failed/review items. Never modifies canonical records.',
  input: z.object({ organisation_id: id, provider: providerEnum.optional() }),
  async handler({ user }, i) {
    await acctScope(user, i.organisation_id);
    const pFilter = i.provider ? `AND provider=$2` : '';
    const params = i.provider ? [i.organisation_id, i.provider] : [i.organisation_id];
    const unmatched = await many(
      `SELECT * FROM accounting_exports WHERE org_id=$1 ${pFilter} AND status='exported' AND external_ref IS NULL ORDER BY exported_at`,
      params
    );
    const failed = await many(
      `SELECT * FROM accounting_exports WHERE org_id=$1 ${pFilter} AND status IN ('failed','review') ORDER BY created_at DESC`,
      params
    );
    return {
      unmatched: unmatched.slice(0, 100),
      failed: failed.slice(0, 100),
      counts: { unmatched: unmatched.length, failed: failed.length },
    };
  },
});

cap({
  name: 'resolve_accounting_export', method: 'POST', path: '/accounting/exports/:id/resolve', tag: TAG,
  summary: 'Manually mark an export as reconciled (providing the provider external_ref) or write it off (marking it review with a reason). Controller access required. Audit-logged.',
  input: z.object({
    id,
    action: z.enum(['reconcile', 'write_off']),
    external_ref: z.string().max(200).optional(),
    reason: z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = await c.query('SELECT * FROM accounting_exports WHERE id=$1 FOR UPDATE', [i.id]);
      if (!row.rows.length) throw notFound('Export');
      const exp = row.rows[0];
      await acctScope(user, exp.org_id, 'controller');
      const now = new Date().toISOString();
      if (i.action === 'reconcile') {
        await c.query(
          "UPDATE accounting_exports SET status='reconciled', external_ref=COALESCE($1,external_ref), reconciled_at=$2, row_version=row_version+1 WHERE id=$3",
          [i.external_ref ?? null, now, i.id]
        );
      } else {
        await c.query(
          "UPDATE accounting_exports SET status='review', error_message=$1, row_version=row_version+1 WHERE id=$2",
          [i.reason ?? 'Written off', i.id]
        );
      }
      await audit(c, user.id, `accounting.export.${i.action}`, 'accounting_exports', i.id);
      return { ok: true };
    });
  },
});

cap({
  name: 'get_tally_export_file', method: 'GET', path: '/organisations/:organisation_id/accounting/tally/export', tag: TAG,
  summary: 'Generate and stream a Tally TDL/XML import file for a date range. All exported or queued Tally documents are included. Stores the payload_hash on matching rows. Audit-logged. Accountant or above.',
  input: z.object({
    organisation_id: id,
    from: day.optional(),
    to: day.optional(),
    document_type: z.enum(DOC_TYPES).optional(),
  }),
  async handler({ user, res }, i) {
    await acctScope(user, i.organisation_id, 'accountant');
    const ic = await installCfg(i.organisation_id, 'accounting_tally');

    const wheres = ["org_id=$1 AND provider='accounting_tally' AND status IN ('queued','exported')"];
    const params = [i.organisation_id];
    if (i.from) { params.push(i.from); wheres.push(`created_at::date >= $${params.length}`); }
    if (i.to) { params.push(i.to); wheres.push(`created_at::date <= $${params.length}`); }
    if (i.document_type) { params.push(i.document_type); wheres.push(`document_type=$${params.length}`); }

    const exports = await many(`SELECT * FROM accounting_exports WHERE ${wheres.join(' AND ')} ORDER BY created_at`, params);
    const exportIds = exports.map((e) => e.id);
    const allLines = exportIds.length ? await many('SELECT * FROM accounting_export_lines WHERE export_id = ANY($1::uuid[])', [exportIds]) : [];
    const linesByExport = {};
    for (const ln of allLines) { (linesByExport[ln.export_id] ??= []).push(ln); }

    const mappings = await many('SELECT * FROM accounting_export_mappings WHERE org_id=$1 AND provider=\'accounting_tally\'', [i.organisation_id]);
    const gstProfile = await one("SELECT * FROM gst_profiles WHERE owner_kind='organisation' AND owner_id=$1 AND archived_at IS NULL", [i.organisation_id]);

    const { xml, hashes } = tallyProv.generateTDL(exports, linesByExport, mappings, gstProfile, ic?.cfg?.company_name);

    if (exportIds.length) {
      await tx(async (c) => {
        for (const exp of exports) {
          if (hashes[exp.id]) {
            await c.query('UPDATE accounting_exports SET payload_hash=$1 WHERE id=$2', [hashes[exp.id], exp.id]);
          }
        }
      });
    }

    await audit(null, user.id, 'accounting.tally.export_file', 'organisation', i.organisation_id);

    if (res) {
      const filename = `tally-export-${new Date().toISOString().slice(0, 10)}.xml`;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(xml);
      return;
    }
    return { xml, row_count: exports.length };
  },
});

cap({
  name: 'list_accounting_journal_entries', method: 'GET', path: '/organisations/:organisation_id/accounting/journals', tag: TAG,
  summary: 'Aggregated journal summary for a period: debits and credits per ledger account, reconciled to canonical fin_transactions. Filter by from/to and currency.',
  input: z.object({
    organisation_id: id,
    from: day.optional(), to: day.optional(),
    currency: z.string().length(3).optional(),
    provider: providerEnum.optional(),
    ...page,
  }),
  async handler({ user }, i) {
    await acctScope(user, i.organisation_id);
    const wheres = ['ae.org_id=$1', "ae.status IN ('exported','reconciled')"];
    const params = [i.organisation_id];
    if (i.provider) { params.push(i.provider); wheres.push(`ae.provider=$${params.length}`); }
    if (i.from) { params.push(i.from); wheres.push(`ae.exported_at::date >= $${params.length}`); }
    if (i.to) { params.push(i.to); wheres.push(`ae.exported_at::date <= $${params.length}`); }

    const rows = await many(`
      SELECT ael.ledger_account, ael.tax_component,
        sum(CASE WHEN ael.amount > 0 THEN ael.amount ELSE 0 END)::bigint AS debit_minor,
        sum(CASE WHEN ael.amount < 0 THEN ABS(ael.amount) ELSE 0 END)::bigint AS credit_minor,
        count(DISTINCT ae.id)::int AS document_count
      FROM accounting_export_lines ael
      JOIN accounting_exports ae ON ae.id = ael.export_id
      WHERE ${wheres.join(' AND ')}
      GROUP BY ael.ledger_account, ael.tax_component
      ORDER BY ael.ledger_account
      LIMIT 500
    `, params);
    return { items: rows };
  },
});

cap({
  name: 'get_accounting_mapping_template', method: 'GET', path: '/organisations/:organisation_id/accounting/mappings/template', tag: TAG,
  summary: 'Default mapping template for a provider, pre-filled from the organisation\'s GST profile and sport catalogue. Read-only: does not create any mappings.',
  input: z.object({ organisation_id: id, provider: providerEnum }),
  async handler({ user }, i) {
    await acctScope(user, i.organisation_id);
    const gst = await one("SELECT * FROM gst_profiles WHERE owner_kind='organisation' AND owner_id=$1 AND archived_at IS NULL", [i.organisation_id]);
    const taxSuggestions = [
      { mapping_type: 'tax', source_key: 'cgst', suggested_target: 'Output CGST', description: 'Central GST — intra-state only' },
      { mapping_type: 'tax', source_key: 'sgst', suggested_target: 'Output SGST', description: 'State GST — intra-state only' },
      { mapping_type: 'tax', source_key: 'igst', suggested_target: 'Output IGST', description: 'Integrated GST — inter-state' },
    ];
    const ledgerSuggestions = [
      { mapping_type: 'ledger', source_key: 'default', suggested_target: 'Sales - Sports', description: 'Default sales ledger for unclassified income' },
      { mapping_type: 'ledger', source_key: 'membership', suggested_target: 'Sales - Memberships', description: 'Membership and pass income' },
      { mapping_type: 'ledger', source_key: 'event', suggested_target: 'Sales - Events', description: 'Event registration and ticket income' },
      { mapping_type: 'ledger', source_key: 'coaching', suggested_target: 'Sales - Coaching', description: 'Coaching session income' },
    ];
    const clearingSuggestions = [
      { mapping_type: 'clearing', source_key: 'receivable', suggested_target: 'Sundry Debtors', description: 'Default receivables control account' },
      { mapping_type: 'clearing', source_key: 'payable', suggested_target: 'Sundry Creditors', description: 'Default payables control account' },
    ];
    return {
      provider: i.provider,
      gst_profile: gst ? { gstin: gst.gstin, state_code: gst.state_code } : null,
      suggestions: [...taxSuggestions, ...ledgerSuggestions, ...clearingSuggestions],
    };
  },
});
