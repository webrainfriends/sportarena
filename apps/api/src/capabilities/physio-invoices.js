import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { forbidden, notFound } from '../errors.js';

const encNotes = (v) => (v ? encrypt(v, 'physio_invoices.notes') : null);
const decNotes = (v) => (v ? decrypt(v, 'physio_invoices.notes') : null);
const decRow = (r) => r ? { ...r, notes: decNotes(r.notes_enc), notes_enc: undefined } : r;

const lineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive().default(1),
  unit_cents: z.number().int().positive(),
  tax_class: z.string().max(50).default('unspecified'),
});

cap({
  name: 'create_physio_invoice', method: 'POST', path: '/physio/invoices',
  tag: 'Physio', auth: true, summary: 'Create a physio invoice (draft)',
  input: z.object({
    patient_id: z.string().uuid(),
    appointment_id: z.string().uuid().optional(),
    currency: z.string().length(3).default('AUD'),
    line_items: z.array(lineItemSchema).min(1),
    tax_rate_bp: z.number().int().min(0).max(10000).default(0),
    due_date: z.string().optional(),
    notes: z.string().max(2000).optional(),
  }),
  handler: async ({ user }, i) => {
    const subtotal = i.line_items.reduce((s, l) => s + Math.round(l.unit_cents * l.quantity), 0);
    const tax = Math.round(subtotal * i.tax_rate_bp / 10000);
    const total = subtotal + tax;
    const num = `PHY-${Date.now()}`;
    const row = await one(
      `INSERT INTO physio_invoices (invoice_number, provider_id, patient_id, appointment_id, currency, subtotal_cents, tax_cents, total_cents, tax_rate_bp, due_date, notes_enc, line_items, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft') RETURNING *`,
      [num, user.id, i.patient_id, i.appointment_id ?? null, i.currency, subtotal, tax, total, i.tax_rate_bp, i.due_date ?? null, encNotes(i.notes), JSON.stringify(i.line_items)],
    );
    return decRow(row);
  },
});

cap({
  name: 'update_physio_invoice', method: 'PATCH', path: '/physio/invoices/:id',
  tag: 'Physio', auth: true, summary: 'Update a draft invoice',
  input: z.object({
    id: z.string().uuid(),
    line_items: z.array(lineItemSchema).min(1).optional(),
    tax_rate_bp: z.number().int().min(0).max(10000).optional(),
    due_date: z.string().optional(),
    notes: z.string().max(2000).optional(),
  }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id, status, line_items, tax_rate_bp, currency FROM physio_invoices WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    const lines = i.line_items ?? existing.line_items;
    const taxBp = i.tax_rate_bp ?? existing.tax_rate_bp;
    const subtotal = lines.reduce((s, l) => s + Math.round(l.unit_cents * l.quantity), 0);
    const tax = Math.round(subtotal * taxBp / 10000);
    const row = await one(
      `UPDATE physio_invoices SET
        line_items=COALESCE($2::jsonb, line_items),
        tax_rate_bp=COALESCE($3, tax_rate_bp),
        subtotal_cents=$4, tax_cents=$5, total_cents=$6,
        due_date=COALESCE($7::date, due_date),
        notes_enc=CASE WHEN $8::text IS NOT NULL THEN $8 ELSE notes_enc END,
        updated_at=now()
       WHERE id=$1 RETURNING *`,
      [i.id, i.line_items ? JSON.stringify(i.line_items) : null, i.tax_rate_bp ?? null, subtotal, tax, subtotal + tax, i.due_date ?? null, i.notes !== undefined ? encNotes(i.notes) : null],
    );
    return decRow(row);
  },
});

cap({
  name: 'issue_physio_invoice', method: 'POST', path: '/physio/invoices/:id/issue',
  tag: 'Physio', auth: true, summary: 'Issue (send) a physio invoice to the patient',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id, status FROM physio_invoices WHERE id=$1`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    const row = await one(`UPDATE physio_invoices SET status='issued', issued_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [i.id]);
    return decRow(row);
  },
});

cap({
  name: 'mark_physio_invoice_paid', method: 'POST', path: '/physio/invoices/:id/paid',
  tag: 'Physio', auth: true, summary: 'Mark a physio invoice as paid',
  input: z.object({ id: z.string().uuid(), payment_method: z.string().max(100).optional() }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id FROM physio_invoices WHERE id=$1`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    const row = await one(`UPDATE physio_invoices SET status='paid', paid_at=now(), payment_method=$2, updated_at=now() WHERE id=$1 RETURNING *`, [i.id, i.payment_method ?? null]);
    return decRow(row);
  },
});

cap({
  name: 'void_physio_invoice', method: 'POST', path: '/physio/invoices/:id/void',
  tag: 'Physio', auth: true, summary: 'Void a physio invoice (soft-delete, keeps data)',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id FROM physio_invoices WHERE id=$1`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    return one(`UPDATE physio_invoices SET status='void', archived_at=now(), updated_at=now() WHERE id=$1 RETURNING id, status`, [i.id]);
  },
});

cap({
  name: 'list_physio_invoices', method: 'GET', path: '/physio/invoices',
  tag: 'Physio', auth: true, summary: 'Provider: list invoices I issued',
  input: z.object({
    status: z.string().optional(),
    patient_id: z.string().uuid().optional(),
  }),
  handler: async ({ user }, i) => {
    const rows = await many(
      `SELECT id, invoice_number, patient_id, currency, subtotal_cents, tax_cents, total_cents,
              tax_rate_bp, status, issued_at, paid_at, due_date, created_at
       FROM physio_invoices
       WHERE provider_id=$1 AND status != 'void'
         AND ($2::text IS NULL OR status=$2)
         AND ($3::uuid IS NULL OR patient_id=$3)
       ORDER BY created_at DESC`,
      [user.id, i.status ?? null, i.patient_id ?? null],
    );
    return rows;
  },
});

cap({
  name: 'list_my_physio_invoices', method: 'GET', path: '/physio/my-invoices',
  tag: 'Physio', auth: true, summary: 'Patient: invoices issued to me',
  input: z.object({}),
  handler: async ({ user }) => {
    return many(
      `SELECT id, invoice_number, provider_id, currency, total_cents, status, issued_at, paid_at, due_date
       FROM physio_invoices
       WHERE patient_id=$1 AND status IN ('issued','paid')
       ORDER BY created_at DESC`,
      [user.id],
    );
  },
});

cap({
  name: 'get_physio_invoice', method: 'GET', path: '/physio/invoices/:id',
  tag: 'Physio', auth: true, summary: 'Get a physio invoice by ID',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const row = await one(`SELECT * FROM physio_invoices WHERE id=$1`, [i.id]);
    if (!row) throw notFound();
    if (row.provider_id !== user.id && row.patient_id !== user.id) throw forbidden();
    return decRow(row);
  },
});
