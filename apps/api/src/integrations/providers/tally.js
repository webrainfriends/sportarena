// Tally ERP provider for the Accounting Integration layer (#513).
// Operates in two modes: file-export-only (no gateway_url) and live-gateway (gateway_url set).
// generateTDL() is the canonical serialiser; push() wraps it with idempotency and optional gateway delivery.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { badRequest } from '../../errors.js';
import { send } from '../http.js';

export const fields = z.object({
  company_name: z.string().max(120).optional().describe('Tally company name exactly as registered — used in SVCURRENTCOMPANY'),
  gateway_url:  z.string().url().max(500).optional().describe('Tally HTTP gateway URL (e.g. http://localhost:9000); omit for file-export-only mode'),
}).strict();

export const secrets = [];

export const sandbox = { ledgers: 18, vouchers: 45, groups: 12 };

/** Cheap connectivity test. Gateway mode: sends a minimal TDL request and checks for XML response. File mode: returns config-verified. */
export async function test(cfg) {
  if (!cfg.gateway_url) return { ok: true, message: 'File-export mode — connect a Tally HTTP gateway to enable live push' };
  let r;
  try {
    r = await send('POST', cfg.gateway_url, {
      headers: { 'Content-Type': 'text/xml' },
      body: '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC></DESC></BODY></ENVELOPE>',
    });
  } catch (err) {
    throw Object.assign(new Error(`Tally gateway unreachable: ${err.message}`), { permanent: false });
  }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Tally gateway rejected the request'), { permanent: true });
  if (r.status !== 200) throw new Error(`Tally gateway answered ${r.status}`);
  if (!r.text?.includes('<ENVELOPE>') && !r.text?.includes('<envelope>')) throw Object.assign(new Error('Tally gateway did not return XML'), { permanent: true });
  return { ok: true, message: 'Tally gateway reachable' };
}

/** Pull: lightweight health / stats summary (used by Integration Hub sync health display). */
export async function pull(cfg) {
  if (!cfg.gateway_url) return { summary: { ledgers: 0, vouchers: 0, mode: 'file_export' } };
  try {
    const r = await send('POST', cfg.gateway_url, {
      headers: { 'Content-Type': 'text/xml' },
      body: '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Ledgers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:ASCII</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>',
    });
    if (r.status !== 200) return { summary: { ledgers: 0, vouchers: 0 } };
    const ledgerCount = (r.text.match(/<NAME>/gi) || []).length;
    return { summary: { ledgers: ledgerCount, vouchers: 0 } };
  } catch {
    return { summary: { ledgers: 0, vouchers: 0 } };
  }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const tallyDate = (iso) => (iso ? String(iso).slice(0, 10).replace(/-/g, '') : '');
const DOC_VCHTYPE = { invoice: 'Sales', credit_note: 'Credit Note', payment: 'Receipt', journal: 'Journal' };

/**
 * Resolve the tax mapping key → target ledger account name. Throws if missing.
 * mappings: array of accounting_export_mappings rows.
 */
function taxLedger(mappings, component, docDate) {
  const row = mappings.find(
    (m) => m.mapping_type === 'tax' && m.source_key === component
      && m.effective_from <= docDate && (m.effective_to === null || m.effective_to >= docDate)
  );
  if (!row) throw badRequest(`No tax ledger mapping for '${component}' — configure the accounting mapping first`);
  return row.target_account;
}

function saleLedger(mappings, sourceKey, docDate) {
  const row = mappings.find(
    (m) => m.mapping_type === 'ledger' && m.source_key === sourceKey
      && m.effective_from <= docDate && (m.effective_to === null || m.effective_to >= docDate)
  );
  return row?.target_account ?? 'Sales';
}

function partyLedger(mappings, docDate) {
  const row = mappings.find(
    (m) => m.mapping_type === 'clearing' && m.source_key === 'receivable'
      && m.effective_from <= docDate && (m.effective_to === null || m.effective_to >= docDate)
  );
  return row?.target_account ?? 'Sundry Debtors';
}

/**
 * Serialise a single export row into a Tally TALLYMESSAGE XML fragment.
 * exportRow: { document_type, document_id, exported_at, ... }
 * lines: accounting_export_lines for this export
 * gstProfile: { state_code, gstin }
 * buyerStateCode: state code from the invoice/fin_transaction (optional — falls back to inter-state if unknown)
 */
function voucher(exportRow, lines, mappings, gstProfile, companyName) {
  const docDate = exportRow.exported_at ? String(exportRow.exported_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const vchType = DOC_VCHTYPE[exportRow.document_type] ?? 'Journal';
  const intraState = gstProfile?.state_code && exportRow.buyer_state_code
    ? gstProfile.state_code === exportRow.buyer_state_code
    : false;

  const lineXml = (lines || []).map((ln) => {
    const isCredit = exportRow.document_type !== 'payment';
    const sign = isCredit ? -1 : 1;
    return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ln.ledger_account)}</LEDGERNAME><AMOUNT>${sign * (ln.amount ?? 0)}</AMOUNT><ISPARTYLEDGER>No</ISPARTYLEDGER></ALLLEDGERENTRIES.LIST>`;
  }).join('\n');

  const taxLines = (() => {
    if (!lines?.length) return '';
    const taxAmt = lines.reduce((sum, l) => l.tax_component && l.tax_component !== 'none' ? sum + (l.amount ?? 0) : sum, 0);
    if (!taxAmt) return '';
    if (intraState) {
      const half = Math.floor(taxAmt / 2);
      const cgstLedger = taxLedger(mappings, 'cgst', docDate);
      const sgstLedger = taxLedger(mappings, 'sgst', docDate);
      return [
        `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(cgstLedger)}</LEDGERNAME><AMOUNT>-${half}</AMOUNT><ISPARTYLEDGER>No</ISPARTYLEDGER></ALLLEDGERENTRIES.LIST>`,
        `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(sgstLedger)}</LEDGERNAME><AMOUNT>-${taxAmt - half}</AMOUNT><ISPARTYLEDGER>No</ISPARTYLEDGER></ALLLEDGERENTRIES.LIST>`,
      ].join('\n');
    }
    const igstLedger = taxLedger(mappings, 'igst', docDate);
    return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(igstLedger)}</LEDGERNAME><AMOUNT>-${taxAmt}</AMOUNT><ISPARTYLEDGER>No</ISPARTYLEDGER></ALLLEDGERENTRIES.LIST>`;
  })();

  const totalAmt = (lines || []).reduce((s, l) => s + (l.amount ?? 0), 0);
  const partyName = partyLedger(mappings, docDate);
  const refNum = exportRow.external_ref ?? exportRow.document_id;

  return `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="${esc(vchType)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
<DATE>${tallyDate(docDate)}</DATE>
<VOUCHERNUMBER>${esc(refNum)}</VOUCHERNUMBER>
<NARRATION>Exported from GotMyGame — ${esc(exportRow.document_type)}</NARRATION>
<PARTYLEDGERNAME>${esc(partyName)}</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(partyName)}</LEDGERNAME><AMOUNT>${totalAmt}</AMOUNT><ISPARTYLEDGER>Yes</ISPARTYLEDGER></ALLLEDGERENTRIES.LIST>
${lineXml}
${taxLines}
</VOUCHER>
</TALLYMESSAGE>`;
}

/**
 * Generate a full Tally TDL/XML import envelope from an array of export rows.
 * Returns the XML string and a per-row hash map { [export.id]: payloadHash }.
 */
export function generateTDL(exports, linesByExport, mappings, gstProfile, companyName) {
  const hashes = {};
  const messages = exports.map((exp) => {
    const lines = linesByExport[exp.id] ?? [];
    const xml = voucher(exp, lines, mappings, gstProfile, companyName);
    hashes[exp.id] = createHash('sha256').update(xml).digest('hex');
    return xml;
  }).join('\n');

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
<HEADER>
<TALLYREQUEST>Import Data</TALLYREQUEST>
</HEADER>
<BODY>
<IMPORTDATA>
<REQUESTDESC>
<REPORTNAME>Vouchers</REPORTNAME>
<STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName ?? '')}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
${messages}
</REQUESTDATA>
</IMPORTDATA>
</BODY>
</ENVELOPE>`;

  return { xml: envelope, hashes };
}

/**
 * Push export rows to Tally (gateway mode) or return generated XML (file mode).
 * Returns { exported, skipped, failed, errors }.
 */
export async function push(exports, linesByExport, mappings, gstProfile, cfg) {
  const { xml, hashes } = generateTDL(exports, linesByExport, mappings, gstProfile, cfg.company_name);

  let exported = 0; let skipped = 0; let failed = 0; const errors = [];

  for (const exp of exports) {
    const hash = hashes[exp.id];
    if (exp.payload_hash && exp.payload_hash === hash && exp.external_ref) {
      skipped++;
      continue;
    }
    exp._newHash = hash;
    exp._exported = true;
    exported++;
  }

  if (!cfg.gateway_url || exported === 0) return { exported, skipped, failed, errors, xml };

  try {
    const r = await send('POST', cfg.gateway_url, { headers: { 'Content-Type': 'text/xml' }, body: xml });
    if (r.status !== 200) {
      failed = exported; exported = 0;
      errors.push(`Tally gateway answered ${r.status}`);
      for (const exp of exports) { if (exp._exported) { exp._exported = false; exp._failed = true; } }
    } else if (r.text?.includes('<LINEERROR>')) {
      const lineErrors = r.text.match(/<LINEERROR>(.*?)<\/LINEERROR>/gs) ?? [];
      errors.push(...lineErrors.map((e) => e.replace(/<\/?LINEERROR>/g, '')));
      if (lineErrors.length) { failed = lineErrors.length; exported = Math.max(0, exported - failed); }
    }
  } catch (err) {
    failed = exported; exported = 0;
    errors.push(err.message);
    for (const exp of exports) { if (exp._exported) { exp._exported = false; exp._failed = true; } }
  }

  return { exported, skipped, failed, errors, xml };
}
