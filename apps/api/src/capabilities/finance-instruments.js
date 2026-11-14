// Finance Stage 2 — invoices, credit notes, instalments, deposits (#564)
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { atLeast, financeLevel } from '../finance.js';
import { encrypt, decrypt } from '../crypto.js';

const TAG = 'Finance';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const cur = z.string().regex(/^[A-Z]{3}$/);
const posAmount = z.number().positive();

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

async function nextNumber(client, orgId, prefix) {
  const r = (await client.query(
    `INSERT INTO fin_invoice_counters(organisation_id, prefix, next_seq) VALUES ($1,$2,2)
     ON CONFLICT (organisation_id, prefix) DO UPDATE SET next_seq = fin_invoice_counters.next_seq + 1
     RETURNING next_seq - 1 AS seq`,
    [orgId, prefix]
  )).rows[0];
  return `${prefix}-${String(r.seq).padStart(4, '0')}`;
}

function decryptInvoice(row) {
  if (!row) return row;
  return {
    ...row,
    billing_name: row.billing_name_enc ? decrypt(row.billing_name_enc, 'fin_invoices.billing_name_enc') : null,
    billing_email: row.billing_email_enc ? decrypt(row.billing_email_enc, 'fin_invoices.billing_email_enc') : null,
    billing_address: row.billing_address_enc ? decrypt(row.billing_address_enc, 'fin_invoices.billing_address_enc') : null,
    notes: row.notes_enc ? decrypt(row.notes_enc, 'fin_invoices.notes_enc') : null,
  };
}

// ─── Invoices ────────────────────────────────────────────────────────────────

cap({
  name: 'list_invoices', method: 'GET', path: '/finance/invoices', tag: TAG,
  summary: 'List invoices for an organisation. Filter by status, currency, customer or date range. Requires viewer finance access.',
  input: z.object({
    organisation_id: id,
    status: z.enum(['draft','sent','partial','paid','void','overdue']).optional(),
    currency: cur.optional(),
    customer_id: id.optional(),
    from: day.optional(),
    to: day.optional(),
    ...page.shape,
  }),
  handler: async ({ user }, i) => {
    await scopeOf(user, i.organisation_id);
    const conds = ['i.organisation_id=$1'];
    const args = [i.organisation_id];
    if (i.status) { args.push(i.status); conds.push(`i.status=$${args.length}`); }
    if (i.currency) { args.push(i.currency); conds.push(`i.currency=$${args.length}`); }
    if (i.customer_id) { args.push(i.customer_id); conds.push(`i.customer_id=$${args.length}`); }
    if (i.from) { args.push(i.from); conds.push(`i.issue_date >= $${args.length}`); }
    if (i.to) { args.push(i.to); conds.push(`i.issue_date <= $${args.length}`); }
    const lim = Math.min(i.limit ?? 25, 100);
    const off = i.offset ?? 0;
    args.push(lim + 1, off);
    const rows = await many(
      `SELECT i.id, i.number, i.status, i.currency, i.issue_date, i.due_date, i.total, i.amount_paid, i.amount_due,
              u.display_name AS customer_name
         FROM fin_invoices i LEFT JOIN users u ON u.id = i.customer_id
        WHERE ${conds.join(' AND ')} ORDER BY i.issue_date DESC, i.number DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    const more = rows.length > lim;
    return { invoices: rows.slice(0, lim).map((r) => ({ ...r, total: Number(r.total), amount_paid: Number(r.amount_paid), amount_due: Number(r.amount_due) })), more };
  },
});

cap({
  name: 'get_invoice', method: 'GET', path: '/finance/invoices/:invoice_id', tag: TAG,
  summary: 'Get invoice details including line items, payment history, credit note allocations and offline receipts. Encrypted fields are decrypted for authorised viewers. Sensitive read is audit-logged.',
  input: z.object({ invoice_id: id, organisation_id: id }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id);
    const inv = await one('SELECT * FROM fin_invoices WHERE id=$1 AND organisation_id=$2', [i.invoice_id, orgId]);
    if (!inv) throw notFound('Invoice');
    await audit(null, user.id, 'fin.invoice.viewed', 'fin_invoices', inv.id);
    const lines = await many('SELECT * FROM fin_invoice_lines WHERE invoice_id=$1 ORDER BY position', [inv.id]);
    const allocs = await many(
      `SELECT a.id, a.amount, a.allocated_at, cn.number AS credit_note_number, cn.id AS credit_note_id
         FROM fin_allocations a JOIN fin_credit_notes cn ON cn.id = a.credit_note_id WHERE a.invoice_id=$1`,
      [inv.id]
    );
    const receipts = await many(
      `SELECT id, receipt_number, amount, method, received_at, status FROM fin_offline_receipts WHERE invoice_id=$1 ORDER BY received_at DESC`,
      [inv.id]
    );
    const d = decryptInvoice(inv);
    return {
      invoice: {
        ...d,
        total: Number(d.total), amount_paid: Number(d.amount_paid), amount_due: Number(d.amount_due),
        subtotal: Number(d.subtotal), tax_amount: Number(d.tax_amount), discount_amount: Number(d.discount_amount),
        lines: lines.map((l) => ({ ...l, unit_price: Number(l.unit_price), tax_amount: Number(l.tax_amount), line_total: Number(l.line_total) })),
        allocations: allocs.map((a) => ({ ...a, amount: Number(a.amount) })),
        receipts: receipts.map((r) => ({ ...r, amount: Number(r.amount) })),
      },
    };
  },
});

cap({
  name: 'create_invoice', method: 'POST', path: '/finance/invoices', tag: TAG,
  summary: 'Create a new invoice for a customer of this organisation. Billing contact fields are encrypted at rest. Requires accountant or above.',
  input: z.object({
    organisation_id: id,
    customer_id: id.optional(),
    customer_org_id: id.optional(),
    billing_name: z.string().max(200).optional(),
    billing_email: z.string().email().optional(),
    billing_address: z.string().max(500).optional(),
    currency: cur,
    issue_date: day.optional(),
    due_date: day.optional(),
    notes: z.string().max(2000).optional(),
    reference: z.string().max(100).optional(),
    lines: z.array(z.object({
      description: z.string().min(1).max(500),
      quantity: z.number().positive().default(1),
      unit_price: posAmount,
      tax_rate_bp: z.number().int().min(0).max(99999).default(0),
    })).min(1).max(100),
  }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    return tx(async (client) => {
      const number = await nextNumber(client, orgId, 'INV');
      const lines = i.lines.map((l) => {
        const taxAmt = Math.round(l.unit_price * l.quantity * l.tax_rate_bp) / 10000;
        return { ...l, tax_amount: Math.round(taxAmt * 100) / 100, line_total: Math.round((l.unit_price * l.quantity + taxAmt) * 100) / 100 };
      });
      const subtotal = Math.round(lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) * 100) / 100;
      const taxTotal = Math.round(lines.reduce((s, l) => s + l.tax_amount, 0) * 100) / 100;
      const total = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
      const r = (await client.query(
        `INSERT INTO fin_invoices(organisation_id, number, currency, issue_date, due_date, customer_id, customer_org_id,
           billing_name_enc, billing_email_enc, billing_address_enc, notes_enc, reference, subtotal, tax_amount, total, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [orgId, number, i.currency,
         i.issue_date ?? new Date().toISOString().slice(0, 10),
         i.due_date ?? null, i.customer_id ?? null, i.customer_org_id ?? null,
         i.billing_name ? encrypt(i.billing_name, 'fin_invoices.billing_name_enc') : null,
         i.billing_email ? encrypt(i.billing_email, 'fin_invoices.billing_email_enc') : null,
         i.billing_address ? encrypt(i.billing_address, 'fin_invoices.billing_address_enc') : null,
         i.notes ? encrypt(i.notes, 'fin_invoices.notes_enc') : null,
         i.reference ?? null, subtotal, taxTotal, total, user.id]
      )).rows[0];
      for (let pos = 0; pos < lines.length; pos++) {
        const l = lines[pos];
        await client.query(
          `INSERT INTO fin_invoice_lines(invoice_id, position, description, quantity, unit_price, tax_rate_bp, tax_amount, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [r.id, pos, l.description, l.quantity, l.unit_price, l.tax_rate_bp, l.tax_amount, l.line_total]
        );
      }
      await audit(client, user.id, 'fin.invoice.created', 'fin_invoices', r.id);
      return { invoice_id: r.id, number };
    });
  },
});

cap({
  name: 'send_invoice', method: 'POST', path: '/finance/invoices/:invoice_id/send', tag: TAG,
  summary: 'Mark invoice as sent (transitions from draft → sent). Requires accountant or above.',
  input: z.object({ invoice_id: id, organisation_id: id }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    const inv = await one("SELECT id, status FROM fin_invoices WHERE id=$1 AND organisation_id=$2", [i.invoice_id, orgId]);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'draft') throw conflict('Invoice is not in draft status');
    await tx(async (c) => {
      await c.query("UPDATE fin_invoices SET status='sent', sent_at=now() WHERE id=$1", [inv.id]);
      await audit(c, user.id, 'fin.invoice.sent', 'fin_invoices', inv.id);
    });
    return { ok: true };
  },
});

cap({
  name: 'void_invoice', method: 'POST', path: '/finance/invoices/:invoice_id/void', tag: TAG,
  summary: 'Void an invoice (draft, sent or overdue only — a paid invoice cannot be voided). Requires controller.',
  input: z.object({ invoice_id: id, organisation_id: id, reason: z.string().max(500).optional() }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'controller');
    const inv = await one("SELECT id, status FROM fin_invoices WHERE id=$1 AND organisation_id=$2", [i.invoice_id, orgId]);
    if (!inv) throw notFound('Invoice');
    if (!['draft','sent','overdue'].includes(inv.status)) throw conflict('Only draft, sent or overdue invoices can be voided');
    await tx(async (c) => {
      await c.query("UPDATE fin_invoices SET status='void', voided_at=now() WHERE id=$1", [inv.id]);
      await audit(c, user.id, 'fin.invoice.voided', 'fin_invoices', inv.id);
    });
    return { ok: true };
  },
});

cap({
  name: 'record_invoice_payment', method: 'POST', path: '/finance/invoices/:invoice_id/payment', tag: TAG,
  summary: 'Record a manual payment against an invoice (bank transfer, etc.). Updates invoice status to partial or paid. Requires accountant or above.',
  input: z.object({ invoice_id: id, organisation_id: id, amount: posAmount, received_at: z.string().optional(), notes: z.string().max(500).optional() }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    return tx(async (client) => {
      const inv = (await client.query("SELECT * FROM fin_invoices WHERE id=$1 AND organisation_id=$2 FOR UPDATE", [i.invoice_id, orgId])).rows[0];
      if (!inv) throw notFound('Invoice');
      if (inv.status === 'void') throw conflict('Cannot record payment on a voided invoice');
      const newPaid = Math.min(Number(inv.amount_paid) + i.amount, Number(inv.total));
      const newStatus = newPaid >= Number(inv.total) ? 'paid' : 'partial';
      await client.query(
        `UPDATE fin_invoices SET amount_paid=$2, status=$3, paid_at=CASE WHEN $3='paid' THEN now() ELSE paid_at END WHERE id=$1`,
        [inv.id, newPaid, newStatus]
      );
      await audit(client, user.id, 'fin.invoice.payment_recorded', 'fin_invoices', inv.id);
      return { ok: true, new_status: newStatus, amount_paid: newPaid };
    });
  },
});

// ─── Credit Notes ─────────────────────────────────────────────────────────────

cap({
  name: 'list_credit_notes', method: 'GET', path: '/finance/credit-notes', tag: TAG,
  summary: 'List credit notes for an organisation. Filter by status, currency or linked invoice.',
  input: z.object({
    organisation_id: id,
    status: z.enum(['draft','issued','applied','void']).optional(),
    invoice_id: id.optional(),
    ...page.shape,
  }),
  handler: async ({ user }, i) => {
    await scopeOf(user, i.organisation_id);
    const conds = ['cn.organisation_id=$1'];
    const args = [i.organisation_id];
    if (i.status) { args.push(i.status); conds.push(`cn.status=$${args.length}`); }
    if (i.invoice_id) { args.push(i.invoice_id); conds.push(`cn.invoice_id=$${args.length}`); }
    const lim = Math.min(i.limit ?? 25, 100);
    const off = i.offset ?? 0;
    args.push(lim + 1, off);
    const rows = await many(
      `SELECT cn.id, cn.number, cn.status, cn.currency, cn.issue_date, cn.total, cn.amount_applied, cn.amount_remaining, cn.reason,
              u.display_name AS customer_name
         FROM fin_credit_notes cn LEFT JOIN users u ON u.id = cn.customer_id
        WHERE ${conds.join(' AND ')} ORDER BY cn.issue_date DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    const more = rows.length > lim;
    return { credit_notes: rows.slice(0, lim).map((r) => ({ ...r, total: Number(r.total), amount_applied: Number(r.amount_applied), amount_remaining: Number(r.amount_remaining) })), more };
  },
});

cap({
  name: 'create_credit_note', method: 'POST', path: '/finance/credit-notes', tag: TAG,
  summary: 'Create a credit note (optionally linked to an invoice). Notes are encrypted at rest. Requires accountant or above.',
  input: z.object({
    organisation_id: id,
    customer_id: id.optional(),
    invoice_id: id.optional(),
    currency: cur,
    reason: z.string().max(500).optional(),
    notes: z.string().max(2000).optional(),
    lines: z.array(z.object({
      description: z.string().min(1).max(500),
      quantity: z.number().positive().default(1),
      unit_price: posAmount,
      tax_rate_bp: z.number().int().min(0).max(99999).default(0),
    })).min(1).max(50),
  }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    if (i.invoice_id) {
      const inv = await one('SELECT id FROM fin_invoices WHERE id=$1 AND organisation_id=$2', [i.invoice_id, orgId]);
      if (!inv) throw notFound('Invoice');
    }
    return tx(async (client) => {
      const number = await nextNumber(client, orgId, 'CN');
      const lines = i.lines.map((l) => {
        const taxAmt = Math.round(l.unit_price * l.quantity * l.tax_rate_bp) / 10000;
        return { ...l, tax_amount: Math.round(taxAmt * 100) / 100, line_total: Math.round((l.unit_price * l.quantity + taxAmt) * 100) / 100 };
      });
      const subtotal = Math.round(lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) * 100) / 100;
      const taxTotal = Math.round(lines.reduce((s, l) => s + l.tax_amount, 0) * 100) / 100;
      const total = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
      const r = (await client.query(
        `INSERT INTO fin_credit_notes(organisation_id, number, currency, customer_id, invoice_id, reason, notes_enc, subtotal, tax_amount, total, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [orgId, number, i.currency, i.customer_id ?? null, i.invoice_id ?? null, i.reason ?? null,
         i.notes ? encrypt(i.notes, 'fin_credit_notes.notes_enc') : null,
         subtotal, taxTotal, total, user.id]
      )).rows[0];
      for (let pos = 0; pos < lines.length; pos++) {
        const l = lines[pos];
        await client.query(
          `INSERT INTO fin_credit_note_lines(credit_note_id, position, description, quantity, unit_price, tax_rate_bp, tax_amount, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [r.id, pos, l.description, l.quantity, l.unit_price, l.tax_rate_bp, l.tax_amount, l.line_total]
        );
      }
      await audit(client, user.id, 'fin.credit_note.created', 'fin_credit_notes', r.id);
      return { credit_note_id: r.id, number };
    });
  },
});

cap({
  name: 'issue_credit_note', method: 'POST', path: '/finance/credit-notes/:credit_note_id/issue', tag: TAG,
  summary: 'Issue a draft credit note (draft → issued), making it available for allocation. Requires accountant or above.',
  input: z.object({ credit_note_id: id, organisation_id: id }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    const cn = await one("SELECT id, status FROM fin_credit_notes WHERE id=$1 AND organisation_id=$2", [i.credit_note_id, orgId]);
    if (!cn) throw notFound('Credit note');
    if (cn.status !== 'draft') throw conflict('Credit note is not in draft status');
    await tx(async (c) => {
      await c.query("UPDATE fin_credit_notes SET status='issued' WHERE id=$1", [cn.id]);
      await audit(c, user.id, 'fin.credit_note.issued', 'fin_credit_notes', cn.id);
    });
    return { ok: true };
  },
});

cap({
  name: 'allocate_credit_note', method: 'POST', path: '/finance/credit-notes/:credit_note_id/allocate', tag: TAG,
  summary: 'Apply a credit note amount against an open invoice, reducing its balance. Requires accountant or above.',
  input: z.object({ credit_note_id: id, organisation_id: id, invoice_id: id, amount: posAmount }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    return tx(async (client) => {
      const cn = (await client.query("SELECT * FROM fin_credit_notes WHERE id=$1 AND organisation_id=$2 FOR UPDATE", [i.credit_note_id, orgId])).rows[0];
      if (!cn) throw notFound('Credit note');
      if (cn.status !== 'issued') throw conflict('Credit note must be in issued status to allocate');
      if (i.amount > Number(cn.amount_remaining)) throw badRequest(`Only ${cn.amount_remaining} ${cn.currency} remaining on this credit note`);
      const inv = (await client.query("SELECT * FROM fin_invoices WHERE id=$1 AND organisation_id=$2 FOR UPDATE", [i.invoice_id, orgId])).rows[0];
      if (!inv) throw notFound('Invoice');
      if (inv.status === 'void') throw conflict('Cannot allocate to a voided invoice');
      const allocAmt = Math.min(i.amount, Number(inv.amount_due));
      await client.query(
        `INSERT INTO fin_allocations(credit_note_id, invoice_id, amount, allocated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (credit_note_id, invoice_id) DO UPDATE SET amount = fin_allocations.amount + $3, allocated_by=$4`,
        [cn.id, inv.id, allocAmt, user.id]
      );
      const newCnApplied = Number(cn.amount_applied) + allocAmt;
      const newCnStatus = newCnApplied >= Number(cn.total) ? 'applied' : 'issued';
      await client.query('UPDATE fin_credit_notes SET amount_applied=$2, status=$3 WHERE id=$1', [cn.id, newCnApplied, newCnStatus]);
      const newInvPaid = Math.min(Number(inv.amount_paid) + allocAmt, Number(inv.total));
      const newInvStatus = newInvPaid >= Number(inv.total) ? 'paid' : 'partial';
      await client.query('UPDATE fin_invoices SET amount_paid=$2, status=$3 WHERE id=$1', [inv.id, newInvPaid, newInvStatus]);
      await audit(client, user.id, 'fin.allocation.created', 'fin_allocations', cn.id);
      return { ok: true, allocated: allocAmt };
    });
  },
});

// ─── Instalment Plans ─────────────────────────────────────────────────────────

cap({
  name: 'list_instalment_plans', method: 'GET', path: '/finance/instalments', tag: TAG,
  summary: 'List instalment plans for an organisation. Filter by status or customer. Shows overdue item count per plan.',
  input: z.object({
    organisation_id: id,
    status: z.enum(['active','completed','cancelled','defaulted']).optional(),
    customer_id: id.optional(),
    ...page.shape,
  }),
  handler: async ({ user }, i) => {
    await scopeOf(user, i.organisation_id);
    const conds = ['s.organisation_id=$1'];
    const args = [i.organisation_id];
    if (i.status) { args.push(i.status); conds.push(`s.status=$${args.length}`); }
    if (i.customer_id) { args.push(i.customer_id); conds.push(`s.customer_id=$${args.length}`); }
    const lim = Math.min(i.limit ?? 25, 100);
    const off = i.offset ?? 0;
    args.push(lim + 1, off);
    const rows = await many(
      `SELECT s.id, s.currency, s.total_amount, s.amount_paid, s.amount_due, s.status, s.schedule_type, s.start_date, s.end_date,
              u.display_name AS customer_name,
              (SELECT count(*) FROM fin_instalment_items ii WHERE ii.instalment_id=s.id AND ii.status='overdue')::int AS overdue_count
         FROM fin_instalments s LEFT JOIN users u ON u.id = s.customer_id
        WHERE ${conds.join(' AND ')} ORDER BY s.created_at DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    const more = rows.length > lim;
    return { instalments: rows.slice(0, lim).map((r) => ({ ...r, total_amount: Number(r.total_amount), amount_paid: Number(r.amount_paid), amount_due: Number(r.amount_due) })), more };
  },
});

cap({
  name: 'create_instalment_plan', method: 'POST', path: '/finance/instalments', tag: TAG,
  summary: 'Create an instalment plan with a custom payment schedule. Minimum 2 items. Requires accountant or above.',
  input: z.object({
    organisation_id: id,
    invoice_id: id.optional(),
    customer_id: id.optional(),
    currency: cur,
    schedule_type: z.enum(['weekly','fortnightly','monthly','custom']).default('monthly'),
    start_date: day,
    items: z.array(z.object({ due_date: day, amount: posAmount })).min(2).max(60),
  }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    const total = Math.round(i.items.reduce((s, x) => s + x.amount, 0) * 100) / 100;
    return tx(async (client) => {
      const r = (await client.query(
        `INSERT INTO fin_instalments(organisation_id, invoice_id, customer_id, currency, total_amount, schedule_type, start_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [orgId, i.invoice_id ?? null, i.customer_id ?? null, i.currency, total, i.schedule_type, i.start_date, user.id]
      )).rows[0];
      for (let pos = 0; pos < i.items.length; pos++) {
        await client.query('INSERT INTO fin_instalment_items(instalment_id, position, due_date, amount) VALUES ($1,$2,$3,$4)', [r.id, pos, i.items[pos].due_date, i.items[pos].amount]);
      }
      await audit(client, user.id, 'fin.instalment.created', 'fin_instalments', r.id);
      return { instalment_id: r.id, total_amount: total, item_count: i.items.length };
    });
  },
});

cap({
  name: 'record_instalment_payment', method: 'POST', path: '/finance/instalments/:instalment_id/pay', tag: TAG,
  summary: 'Mark an instalment item as paid, updating the plan total and posting to the ledger. Requires accountant or above.',
  input: z.object({ instalment_id: id, organisation_id: id, item_id: id, paid_amount: posAmount, paid_at: z.string().optional() }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    return tx(async (client) => {
      const plan = (await client.query('SELECT * FROM fin_instalments WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.instalment_id, orgId])).rows[0];
      if (!plan) throw notFound('Instalment plan');
      const item = (await client.query('SELECT * FROM fin_instalment_items WHERE id=$1 AND instalment_id=$2 FOR UPDATE', [i.item_id, i.instalment_id])).rows[0];
      if (!item) throw notFound('Instalment item');
      if (item.status === 'paid') throw conflict('Item is already paid');
      const paidAt = i.paid_at ? new Date(i.paid_at) : new Date();
      await client.query("UPDATE fin_instalment_items SET status='paid', paid_at=$2, paid_amount=$3 WHERE id=$1", [item.id, paidAt, i.paid_amount]);
      const newPaid = Number(plan.amount_paid) + i.paid_amount;
      const allItems = (await client.query('SELECT status FROM fin_instalment_items WHERE instalment_id=$1', [plan.id])).rows;
      const allDone = allItems.every((r) => r.status === 'paid' || r.status === 'waived');
      await client.query(
        "UPDATE fin_instalments SET amount_paid=$2, status=CASE WHEN $3 THEN 'completed' ELSE status END, updated_at=now() WHERE id=$1",
        [plan.id, newPaid, allDone]
      );
      await audit(client, user.id, 'fin.instalment.payment_recorded', 'fin_instalment_items', item.id);
      return { ok: true, item_id: item.id, new_plan_status: allDone ? 'completed' : plan.status };
    });
  },
});

// ─── Deposits ─────────────────────────────────────────────────────────────────

cap({
  name: 'list_deposits', method: 'GET', path: '/finance/deposits', tag: TAG,
  summary: 'List security deposits for an organisation. Filter by status or customer.',
  input: z.object({
    organisation_id: id,
    status: z.enum(['requested','received','partially_released','released','forfeited']).optional(),
    customer_id: id.optional(),
    ...page.shape,
  }),
  handler: async ({ user }, i) => {
    await scopeOf(user, i.organisation_id);
    const conds = ['d.organisation_id=$1'];
    const args = [i.organisation_id];
    if (i.status) { args.push(i.status); conds.push(`d.status=$${args.length}`); }
    if (i.customer_id) { args.push(i.customer_id); conds.push(`d.customer_id=$${args.length}`); }
    const lim = Math.min(i.limit ?? 25, 100);
    const off = i.offset ?? 0;
    args.push(lim + 1, off);
    const rows = await many(
      `SELECT d.id, d.currency, d.amount, d.amount_held, d.amount_released, d.amount_forfeited, d.status,
              d.purpose, d.reference, d.received_at, d.release_due_at, u.display_name AS customer_name
         FROM fin_deposits d LEFT JOIN users u ON u.id = d.customer_id
        WHERE ${conds.join(' AND ')} ORDER BY d.created_at DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args
    );
    const more = rows.length > lim;
    return { deposits: rows.slice(0, lim).map((r) => ({ ...r, amount: Number(r.amount), amount_held: Number(r.amount_held), amount_released: Number(r.amount_released), amount_forfeited: Number(r.amount_forfeited) })), more };
  },
});

cap({
  name: 'create_deposit', method: 'POST', path: '/finance/deposits', tag: TAG,
  summary: 'Create a security deposit record for a customer. Starts as requested until payment is received. Requires accountant or above.',
  input: z.object({
    organisation_id: id,
    customer_id: id.optional(),
    currency: cur,
    amount: posAmount,
    purpose: z.string().max(300).optional(),
    reference: z.string().max(100).optional(),
    release_due_at: day.optional(),
  }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'accountant');
    return tx(async (client) => {
      const r = (await client.query(
        `INSERT INTO fin_deposits(organisation_id, customer_id, currency, amount, purpose, reference, release_due_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [orgId, i.customer_id ?? null, i.currency, i.amount, i.purpose ?? null, i.reference ?? null, i.release_due_at ?? null, user.id]
      )).rows[0];
      await audit(client, user.id, 'fin.deposit.created', 'fin_deposits', r.id);
      return { deposit_id: r.id };
    });
  },
});

cap({
  name: 'release_deposit', method: 'POST', path: '/finance/deposits/:deposit_id/release', tag: TAG,
  summary: 'Record a deposit release (partial or full) or forfeiture, posting the movement to the ledger. Requires controller.',
  input: z.object({
    deposit_id: id,
    organisation_id: id,
    action: z.enum(['release','forfeit']),
    amount: posAmount,
    notes: z.string().max(500).optional(),
  }),
  handler: async ({ user }, i) => {
    const { orgId } = await scopeOf(user, i.organisation_id, 'controller');
    return tx(async (client) => {
      const dep = (await client.query('SELECT * FROM fin_deposits WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.deposit_id, orgId])).rows[0];
      if (!dep) throw notFound('Deposit');
      if (['released','forfeited'].includes(dep.status)) throw conflict('Deposit is already closed');
      const held = Number(dep.amount_held) || Number(dep.amount);
      if (i.amount > held) throw badRequest(`Only ${held} ${dep.currency} available on this deposit`);
      const field = i.action === 'release' ? 'amount_released' : 'amount_forfeited';
      const newVal = Number(dep[field]) + i.amount;
      const newHeld = held - i.amount;
      const newStatus = newHeld <= 0 ? (i.action === 'release' ? 'released' : 'forfeited') : 'partially_released';
      await client.query(
        `UPDATE fin_deposits SET ${field}=$2, amount_held=$3, status=$4, released_at=CASE WHEN $3<=0 THEN now() ELSE released_at END WHERE id=$1`,
        [dep.id, newVal, newHeld, newStatus]
      );
      await audit(client, user.id, `fin.deposit.${i.action}d`, 'fin_deposits', dep.id);
      return { ok: true, new_status: newStatus, amount_held: newHeld };
    });
  },
});
