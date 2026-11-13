// E-invoice adapter boundary — provider-neutral stub (#503).
// A real IRP adapter would implement the EInvoiceAdapter interface and be injected via Organisation Settings.
// Until one is configured, every request_einvoice call fails clearly rather than silently returning false success.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { notFound } from '../errors.js';
import { one } from '../db.js';

/**
 * @typedef {Object} EInvoiceAdapter
 * @property {string} name - Adapter identifier (e.g. 'cleartax', 'mastersindia')
 * @property {function(invoice: object): Promise<{irn: string, ack_number: string, ack_at: string, qr_code: string}>} requestIrn
 * @property {function(irn: string): Promise<void>} cancelIrn
 */

cap({
  name: 'get_einvoice_adapter_status', method: 'GET', path: '/einvoice/status', tag: 'GST billing',
  summary: 'Returns the e-invoice adapter connection status for this organisation.',
  input: z.object({ org_id: id.optional() }),
  handler: async () => ({ connected: false, reason: 'no_adapter_configured' }),
});

cap({
  name: 'request_einvoice', method: 'POST', path: '/einvoice/request', tag: 'GST billing',
  summary: 'Request IRN generation for an issued invoice via the configured e-invoice adapter. Requires an adapter to be connected in Organisation Settings → India Tax.',
  input: z.object({ invoice_id: id }),
  async handler({ user }, i) {
    const invoice = await one('SELECT id, organisation_id FROM invoices WHERE id=$1', [i.invoice_id]);
    if (!invoice) throw notFound('Invoice');
    const err = new Error('No e-invoice adapter is configured. Connect a GST-compliant IRP adapter in Organisation Settings → India Tax.');
    err.code = 'NO_EINVOICE_ADAPTER';
    err.status = 501;
    throw err;
  },
});
