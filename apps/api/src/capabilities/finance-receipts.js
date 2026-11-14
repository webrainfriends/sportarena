// Finance Stage 2 — offline receipts: cash, bank transfer, cheque, UPI (#564)
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { atLeast, financeLevel, recordOfflineReceipt } from '../finance.js';
import { encrypt, decrypt } from '../crypto.js';

const TAG = 'Finance';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const cur = z.string().regex(/^[A-Z]{3}$/);

async function scopeOf(user, organisationId, need = 'viewer') {
  const org = await one('SELECT id FROM organisations WHERE id=$1', [organisationId]);
  const level = org ? await financeLevel(user, organisationId) : null;
  if (!level) {
    if (org && (await one("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [organisationId, user.id]))) throw forbidden('Your role in this organisation does not allow that');
    throw notFound('Organisation');
  }
  if (!atLeast(level, need)) throw forbidden('Your finance access in this organisation does not allow that');
  return { orgId: organisationId, level };
}

cap({
  name: 'list_offline_receipts', method: 'GET', path: '/finance/offline-receipts', tag: TAG,
  summary: 'List offline payment receipts (cash, bank transfer, cheque, UPI). Filter by status, method, invoice or date.',
  input: z.object({
    organisation_id: id,
    status: z.enum(['pending','confirmed','bounced','reversed']).optional(),
    method: z.enum(['cash','bank_transfer','cheque','upi','other']).optional(),
    invoice_id: id.optional(),
    from: day.optional(),
    to: day.optional(),
    ...page.shape,
  }),
  handler: async ({ user }, i) => {
    await scopeOf(user, i.organisation_id);
    const conds = ['r.organisation_id=$1'];
    const args = [i.organisation_id];
    if (i.status) { args.push(i.status); conds.push(`r.status=$${args.length}`); }
    if (i.method) { args.push(i.method); conds.push(`r.method=$${args.length}`); }
    if (i.invoice_id) { args.push(i.invoice_id); conds.push(`r.invoice_id=$${args.length}`); }
    if (i.from) { args.push(i.from); conds.push(`r.received_at::date >= $${args.length}`); }
    if (i.to) { args.push(i.to); conds.push(`r.received_at::date <= $${args.length}`); }
    const lim = Math.min(i.limit ?? 25, 100);
    const off = i.offset ?? 0;
    args.push(lim + 1, off);
    const rows = await many(
      `SELECT r.id, r.receipt_number, r.amount, r.currency, r.method, r.status, r.received_at, r.confirmed_at,
              r.invoice_id, inv.number AS invoice_number,
              u.display_name AS customer_name, ru.display_name AS received_by_name
         FROM fin_offline_receipts r
         LEFT JOIN users u ON u.id = r.customer_id
         LEFT JOIN users ru ON ru.id = r.received_by
         LEFT JOIN fin_invoices inv ON inv.id = r.invoice_id
        WHERE ${conds.join(' AND ')} ORDER BY r.received_at DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    const more = rows.length > lim;
    return { receipts: rows.slice(0, lim).map((r) => ({ ...r, amount: Number(r.amount) })), more };
  },
});

cap({
  name: 'create_offline_receipt', method: 'POST', path: '/finance/offline-receipts', tag: TAG,
  summary: 'Record an offline payment (cash, bank transfer, cheque, UPI). Starts as pending until confirmed. Reference and notes are encrypted at rest. Requires accountant or above.',
  input: z.object({
    organisation_id: id,
    customer_id: id.optional(),
    invoice_id: id.optional(),
    instalment_id: id.optional(),
    currency: cur,
    amount: z.number().positive(),
    method: z.enum(['cash','bank_transfer','cheque','upi','other']).default('cash'),
    reference: z.string().max(200).optional(),
    notes: z.string().max(1000).optional(),
    received_at: z.string().optional(),
  }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    return tx(async (client) => {
      const seq = (await client.query(
        `INSERT INTO fin_invoice_counters(organisation_id, prefix, next_seq) VALUES ($1,'REC',2)
         ON CONFLICT (organisation_id, prefix) DO UPDATE SET next_seq = fin_invoice_counters.next_seq + 1
         RETURNING next_seq - 1 AS seq`,
        [orgId]
      )).rows[0].seq;
      const number = `REC-${String(seq).padStart(4, '0')}`;
      const r = (await client.query(
        `INSERT INTO fin_offline_receipts(organisation_id, receipt_number, invoice_id, instalment_id, customer_id, currency, amount, method, reference_enc, notes_enc, received_at, received_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [orgId, number, i.invoice_id ?? null, i.instalment_id ?? null, i.customer_id ?? null,
         i.currency, i.amount, i.method,
         i.reference ? encrypt(i.reference, 'fin_offline_receipts.reference_enc') : null,
         i.notes ? encrypt(i.notes, 'fin_offline_receipts.notes_enc') : null,
         i.received_at ? new Date(i.received_at) : new Date(), user.id]
      )).rows[0];
      await audit(client, user.id, 'fin.offline_receipt.created', 'fin_offline_receipts', r.id);
      return { receipt_id: r.id, receipt_number: number };
    });
  },
});

cap({
  name: 'confirm_offline_receipt', method: 'POST', path: '/finance/offline-receipts/:receipt_id/confirm', tag: TAG,
  summary: 'Confirm an offline receipt: transitions it from pending → confirmed and posts to the canonical ledger. If linked to an invoice, updates its paid amount. Requires accountant or above.',
  input: z.object({ receipt_id: id, organisation_id: id }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    return tx(async (client) => {
      const rec = (await client.query('SELECT * FROM fin_offline_receipts WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.receipt_id, orgId])).rows[0];
      if (!rec) throw notFound('Receipt');
      if (rec.status !== 'pending') throw conflict('Receipt is not pending');
      await client.query("UPDATE fin_offline_receipts SET status='confirmed', confirmed_at=now(), confirmed_by=$2 WHERE id=$1", [rec.id, user.id]);
      const confirmed = { ...rec, status: 'confirmed', confirmed_at: new Date(), organisation_id: orgId };
      const txId = await recordOfflineReceipt(client, confirmed);
      if (txId) await client.query('UPDATE fin_offline_receipts SET tx_id=$2 WHERE id=$1', [rec.id, txId]);
      if (rec.invoice_id) {
        const invRow = (await client.query('SELECT * FROM fin_invoices WHERE id=$1 FOR UPDATE', [rec.invoice_id])).rows[0];
        if (invRow) {
          const newPaid = Math.min(Number(invRow.amount_paid) + Number(rec.amount), Number(invRow.total));
          const newStatus = newPaid >= Number(invRow.total) ? 'paid' : 'partial';
          await client.query('UPDATE fin_invoices SET amount_paid=$2, status=$3, paid_at=CASE WHEN $3=$4 THEN now() ELSE paid_at END WHERE id=$1', [invRow.id, newPaid, newStatus, 'paid']);
        }
      }
      await audit(client, user.id, 'fin.offline_receipt.confirmed', 'fin_offline_receipts', rec.id);
      return { ok: true, tx_id: txId };
    });
  },
});

cap({
  name: 'get_offline_receipt', method: 'GET', path: '/finance/offline-receipts/:receipt_id', tag: TAG,
  summary: 'Get offline receipt details. Reference and notes are decrypted for authorised viewers. Sensitive read is audit-logged.',
  input: z.object({ receipt_id: id, organisation_id: id }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id);
    const rec = await one('SELECT * FROM fin_offline_receipts WHERE id=$1 AND organisation_id=$2', [i.receipt_id, orgId]);
    if (!rec) throw notFound('Receipt');
    await audit(null, user.id, 'fin.offline_receipt.viewed', 'fin_offline_receipts', rec.id);
    return {
      receipt: {
        ...rec,
        amount: Number(rec.amount),
        reference: rec.reference_enc ? decrypt(rec.reference_enc, 'fin_offline_receipts.reference_enc') : null,
        notes: rec.notes_enc ? decrypt(rec.notes_enc, 'fin_offline_receipts.notes_enc') : null,
      },
    };
  },
});
