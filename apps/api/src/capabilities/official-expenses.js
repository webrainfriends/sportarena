// Official expense claims and reimbursement batches (#1008). Referees and other match officials can claim
// travel, accommodation, subsistence, equipment and other expenses per assignment, upload receipts (via doc store),
// and group approved claims into a batch for organiser approval and payout. Descriptions are encrypted at rest;
// every decrypt is audit-logged. The payout flows through the canonical settlement path (#71, #701).
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';

const TAG = 'Officials';
const cur = z.string().regex(/^[A-Z]{3}$/);
const CATEGORIES = ['travel', 'accommodation', 'subsistence', 'equipment', 'other'];

// ── helpers ────────────────────────────────────────────────────────────────

async function loadExpense(c, expId) {
  const exp = (await c.query(
    `SELECT oe.*, fo.user_id AS official_user_id, f.event_id, e.organizer_id
     FROM official_expenses oe
     JOIN fixture_officials fo ON fo.id = oe.fixture_official_id
     JOIN fixtures f ON f.id = fo.fixture_id
     JOIN events e ON e.id = f.event_id
     WHERE oe.id = $1 FOR UPDATE OF oe`,
    [expId],
  )).rows[0];
  if (!exp) throw notFound('expense');
  return exp;
}

async function loadBatch(c, batchId) {
  const batch = (await c.query('SELECT * FROM official_expense_batches WHERE id=$1 FOR UPDATE', [batchId])).rows[0];
  if (!batch) throw notFound('expense batch');
  return batch;
}

function canReadExpense(user, exp) {
  return isAdmin(user) || user.id === exp.official_id || user.id === exp.organizer_id;
}

function safeExpenseView(exp) {
  const { description_enc, rejection_reason_enc, ...rest } = exp;
  return rest;
}

// ── create expense ─────────────────────────────────────────────────────────

cap({
  name: 'create_official_expense',
  method: 'POST',
  path: '/official-assignments/:id/expenses',
  tag: TAG,
  status: 201,
  summary: 'Official creates an expense claim for an assignment: travel, accommodation, subsistence, equipment or other. The description is encrypted. Attach a receipt via receipt_doc_id from the doc store.',
  input: z.object({
    id,
    category: z.enum(CATEGORIES),
    amount_minor: money,
    currency: cur,
    description: z.string().trim().max(500).optional(),
    receipt_doc_id: id.optional(),
    idempotency_key: z.string().max(128).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const fo = (await c.query(
        `SELECT fo.*, f.event_id, e.organizer_id FROM fixture_officials fo
         JOIN fixtures f ON f.id = fo.fixture_id JOIN events e ON e.id = f.event_id
         WHERE fo.id = $1 FOR UPDATE OF fo`,
        [i.id],
      )).rows[0];
      if (!fo || fo.user_id !== user.id) throw notFound('official assignment');
      if (!['invited', 'accepted', 'completed'].includes(fo.status)) throw conflict(`Assignment is ${fo.status}`);

      if (i.idempotency_key) {
        const existing = (await c.query('SELECT * FROM official_expenses WHERE idempotency_key=$1', [i.idempotency_key])).rows[0];
        if (existing) return safeExpenseView(existing);
      }

      const descEnc = i.description ? encrypt(i.description, 'official_expenses.description') : null;

      const exp = (await c.query(
        `INSERT INTO official_expenses
           (fixture_official_id, official_id, organisation_id, currency, amount_minor, category, description_enc, receipt_doc_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [fo.id, user.id, fo.organizer_id, i.currency, i.amount_minor, i.category, descEnc, i.receipt_doc_id ?? null, i.idempotency_key ?? null],
      )).rows[0];

      return safeExpenseView(exp);
    });
  },
});

// ── update expense ─────────────────────────────────────────────────────────

cap({
  name: 'update_official_expense',
  method: 'PATCH',
  path: '/official-expenses/:id',
  tag: TAG,
  summary: 'Update a draft expense claim. Only allowed in draft status.',
  input: z.object({
    id,
    category: z.enum(CATEGORIES).optional(),
    amount_minor: money.optional(),
    description: z.string().trim().max(500).optional(),
    receipt_doc_id: id.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const exp = await loadExpense(c, i.id);
      if (exp.official_user_id !== user.id && !isAdmin(user)) throw notFound('expense');
      if (exp.status !== 'draft') throw conflict('Only draft expenses can be updated');

      const fields = [];
      const params = [];
      const push = (col, val) => { fields.push(`${col}=$${params.push(val)}`); };

      if (i.category != null) push('category', i.category);
      if (i.amount_minor != null) push('amount_minor', i.amount_minor);
      if (i.receipt_doc_id != null) push('receipt_doc_id', i.receipt_doc_id);
      if (i.description != null) push('description_enc', encrypt(i.description, 'official_expenses.description'));

      if (!fields.length) return safeExpenseView(exp);
      push('updated_at', new Date());

      const updated = (await c.query(
        `UPDATE official_expenses SET ${fields.join(', ')} WHERE id=$${params.push(i.id)} RETURNING *`,
        params,
      )).rows[0];

      return safeExpenseView(updated);
    });
  },
});

// ── submit expense ─────────────────────────────────────────────────────────

cap({
  name: 'submit_official_expense',
  method: 'POST',
  path: '/official-expenses/:id/submit',
  tag: TAG,
  summary: 'Official submits an expense claim for organiser review.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const exp = await loadExpense(c, i.id);
      if (exp.official_user_id !== user.id) throw notFound('expense');
      if (exp.status !== 'draft') throw conflict(`Expense is ${exp.status}`);

      await c.query(`UPDATE official_expenses SET status='submitted', submitted_at=now(), updated_at=now() WHERE id=$1`, [exp.id]);
      await notify(c, exp.organizer_id, { kind: 'official_expense', title: 'Expense claim submitted', body: `${exp.category} · ${(exp.amount_minor / 100).toFixed(2)} ${exp.currency}`, data: { expense_id: exp.id, fixture_official_id: exp.fixture_official_id } });

      return { id: exp.id, status: 'submitted', submitted_at: new Date() };
    });
  },
});

// ── approve expense ────────────────────────────────────────────────────────

cap({
  name: 'approve_official_expense',
  method: 'POST',
  path: '/official-expenses/:id/approve',
  tag: TAG,
  summary: 'Organiser approves a submitted expense claim.',
  input: z.object({ id, notes: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const exp = await loadExpense(c, i.id);
      if (exp.organizer_id !== user.id && !isAdmin(user)) throw notFound('expense');
      if (exp.status !== 'submitted') throw conflict(`Expense is ${exp.status}`);

      await c.query(`UPDATE official_expenses SET status='approved', approved_at=now(), updated_at=now() WHERE id=$1`, [exp.id]);
      await notify(c, exp.official_id, { kind: 'official_expense', title: 'Expense approved', body: `${exp.category} · ${(exp.amount_minor / 100).toFixed(2)} ${exp.currency} approved.`, data: { expense_id: exp.id } });

      return { id: exp.id, status: 'approved', approved_at: new Date() };
    });
  },
});

// ── reject expense ─────────────────────────────────────────────────────────

cap({
  name: 'reject_official_expense',
  method: 'POST',
  path: '/official-expenses/:id/reject',
  tag: TAG,
  summary: 'Organiser rejects an expense claim with a mandatory reason (encrypted).',
  input: z.object({ id, reason: z.string().trim().min(5).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const exp = await loadExpense(c, i.id);
      if (exp.organizer_id !== user.id && !isAdmin(user)) throw notFound('expense');
      if (exp.status !== 'submitted') throw conflict(`Expense is ${exp.status}`);

      const reasonEnc = encrypt(i.reason, 'official_expenses.rejection_reason');
      await c.query(
        `UPDATE official_expenses SET status='rejected', rejected_at=now(), rejection_reason_enc=$2, updated_at=now() WHERE id=$1`,
        [exp.id, reasonEnc],
      );
      await notify(c, exp.official_id, { kind: 'official_expense', title: 'Expense rejected', body: i.reason, data: { expense_id: exp.id } });

      return { id: exp.id, status: 'rejected', rejected_at: new Date() };
    });
  },
});

// ── get expense (with decryption) ──────────────────────────────────────────

cap({
  name: 'get_official_expense',
  method: 'GET',
  path: '/official-expenses/:id',
  tag: TAG,
  summary: 'Full expense detail: decrypts description and rejection reason for authorised callers. Every decrypt is audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const exp = await one(
      `SELECT oe.*, fo.user_id AS official_user_id, e.organizer_id
       FROM official_expenses oe
       JOIN fixture_officials fo ON fo.id = oe.fixture_official_id
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       WHERE oe.id = $1`,
      [i.id],
    );
    if (!exp || !canReadExpense(user, exp)) throw notFound('expense');

    await audit(null, user.id, 'read_official_expense', 'official_expenses', exp.id);

    const { description_enc, rejection_reason_enc, ...rest } = exp;
    return {
      ...rest,
      description: description_enc ? decrypt(description_enc) : null,
      rejection_reason: rejection_reason_enc ? decrypt(rejection_reason_enc) : null,
    };
  },
});

// ── list expenses ──────────────────────────────────────────────────────────

cap({
  name: 'list_official_expenses',
  method: 'GET',
  path: '/official-expenses',
  tag: TAG,
  summary: 'Paginated list of expense claims. Official sees own; organiser sees claims for their events.',
  input: z.object({
    official_id: id.optional(),
    fixture_official_id: id.optional(),
    batch_id: id.optional(),
    status: z.enum(['draft', 'submitted', 'approved', 'rejected']).optional(),
    category: z.enum(CATEGORIES).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const params = [];
    const wheres = [];

    if (!isAdmin(user)) {
      wheres.push(`(oe.official_id=$${params.push(user.id)} OR e.organizer_id=$${params.push(user.id)})`);
    }
    if (i.official_id) wheres.push(`oe.official_id=$${params.push(i.official_id)}`);
    if (i.fixture_official_id) wheres.push(`oe.fixture_official_id=$${params.push(i.fixture_official_id)}`);
    if (i.batch_id) wheres.push(`oe.batch_id=$${params.push(i.batch_id)}`);
    if (i.status) wheres.push(`oe.status=$${params.push(i.status)}`);
    if (i.category) wheres.push(`oe.category=$${params.push(i.category)}`);

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const rows = await many(
      `SELECT oe.id, oe.category, oe.amount_minor, oe.currency, oe.status,
              oe.fixture_official_id, oe.official_id, oe.batch_id, oe.receipt_doc_id,
              oe.submitted_at, oe.approved_at, oe.rejected_at, oe.created_at,
              fo.role, f.name AS fixture_name, e.name AS event_name
       FROM official_expenses oe
       JOIN fixture_officials fo ON fo.id = oe.fixture_official_id
       JOIN fixtures f ON f.id = fo.fixture_id
       JOIN events e ON e.id = f.event_id
       ${where}
       ORDER BY oe.created_at DESC
       LIMIT $${params.push(i.limit)} OFFSET $${params.push(i.offset)}`,
      params,
    );

    return { expenses: rows, limit: i.limit, offset: i.offset };
  },
});

// ── create batch ───────────────────────────────────────────────────────────

cap({
  name: 'create_expense_batch',
  method: 'POST',
  path: '/official-expense-batches',
  tag: TAG,
  status: 201,
  summary: 'Official groups approved expense claims into a reimbursement batch. All expenses must be in approved status and share the same currency.',
  input: z.object({
    expense_ids: z.array(id).min(1).max(50),
    idempotency_key: z.string().max(128).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      if (i.idempotency_key) {
        const existing = (await c.query('SELECT * FROM official_expense_batches WHERE idempotency_key=$1', [i.idempotency_key])).rows[0];
        if (existing) return existing;
      }

      const expenses = (await c.query(
        `SELECT oe.*, e.organizer_id FROM official_expenses oe
         JOIN fixture_officials fo ON fo.id = oe.fixture_official_id
         JOIN fixtures f ON f.id = fo.fixture_id
         JOIN events e ON e.id = f.event_id
         WHERE oe.id = ANY($1) FOR UPDATE OF oe`,
        [i.expense_ids],
      )).rows;

      if (expenses.length !== i.expense_ids.length) throw notFound('one or more expenses');
      if (expenses.some((e) => e.official_id !== user.id)) throw notFound('one or more expenses');
      if (expenses.some((e) => e.status !== 'approved')) throw conflict('All expenses must be in approved status before batching');
      if (expenses.some((e) => e.batch_id)) throw conflict('Some expenses are already in a batch');

      const currencies = [...new Set(expenses.map((e) => e.currency))];
      if (currencies.length > 1) throw badRequest(`All expenses must share the same currency (found ${currencies.join(', ')})`);

      const orgIds = [...new Set(expenses.map((e) => e.organisation_id))];
      if (orgIds.length > 1) throw badRequest('All expenses must belong to the same organiser');

      const totalMinor = expenses.reduce((s, e) => s + Number(e.amount_minor), 0);
      const currency = currencies[0];
      const organisationId = orgIds[0];
      const organizerId = expenses[0].organizer_id;

      const batch = (await c.query(
        `INSERT INTO official_expense_batches(official_id, organisation_id, currency, total_minor, idempotency_key)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [user.id, organisationId, currency, totalMinor, i.idempotency_key ?? null],
      )).rows[0];

      await c.query('UPDATE official_expenses SET batch_id=$1, updated_at=now() WHERE id = ANY($2)', [batch.id, i.expense_ids]);

      await notify(c, organizerId, { kind: 'official_expense', title: 'Expense batch created', body: `${expenses.length} expenses · ${(totalMinor / 100).toFixed(2)} ${currency} awaiting your approval.`, data: { batch_id: batch.id } });

      return batch;
    });
  },
});

// ── submit batch ───────────────────────────────────────────────────────────

cap({
  name: 'submit_expense_batch',
  method: 'POST',
  path: '/official-expense-batches/:id/submit',
  tag: TAG,
  summary: 'Official formally submits an expense batch for organiser approval.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const batch = await loadBatch(c, i.id);
      if (batch.official_id !== user.id) throw notFound('expense batch');
      if (batch.status !== 'draft') throw conflict(`Batch is ${batch.status}`);

      await c.query(`UPDATE official_expense_batches SET status='submitted', submitted_at=now(), updated_at=now() WHERE id=$1`, [batch.id]);

      const orgRow = (await c.query(
        'SELECT e.organizer_id FROM events e WHERE e.org_id=$1 AND e.organizer_id IS NOT NULL LIMIT 1',
        [batch.organisation_id],
      )).rows[0];

      if (orgRow) {
        await notify(c, orgRow.organizer_id, { kind: 'official_expense', title: 'Expense batch submitted', body: `${(batch.total_minor / 100).toFixed(2)} ${batch.currency} awaiting approval.`, data: { batch_id: batch.id } });
      }

      return { id: batch.id, status: 'submitted', submitted_at: new Date() };
    });
  },
});

// ── approve batch ──────────────────────────────────────────────────────────

cap({
  name: 'approve_expense_batch',
  method: 'POST',
  path: '/official-expense-batches/:id/approve',
  tag: TAG,
  summary: 'Organiser approves an expense batch. The batch enters the settlement payout queue.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const batch = await loadBatch(c, i.id);
      if (batch.status !== 'submitted') throw conflict(`Batch is ${batch.status}`);

      // verify organiser owns this batch's organisation
      const orgCheck = (await c.query(
        'SELECT 1 AS y FROM events WHERE org_id=$1 AND organizer_id=$2 LIMIT 1',
        [batch.organisation_id, user.id],
      )).rows[0];
      if (!orgCheck && !isAdmin(user)) throw notFound('expense batch');

      await c.query(`UPDATE official_expense_batches SET status='approved', approved_at=now(), updated_at=now() WHERE id=$1`, [batch.id]);
      await notify(c, batch.official_id, { kind: 'official_expense', title: 'Expense batch approved', body: `${(batch.total_minor / 100).toFixed(2)} ${batch.currency} has been approved for reimbursement.`, data: { batch_id: batch.id } });

      return { id: batch.id, status: 'approved', approved_at: new Date() };
    });
  },
});

// ── get batch ──────────────────────────────────────────────────────────────

cap({
  name: 'get_expense_batch',
  method: 'GET',
  path: '/official-expense-batches/:id',
  tag: TAG,
  summary: 'Full expense batch with its constituent expense claims (no PII in list view).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const batch = await one('SELECT * FROM official_expense_batches WHERE id=$1', [i.id]);
    if (!batch) throw notFound('expense batch');

    const isOrg = !!(await one('SELECT 1 AS y FROM events WHERE org_id=$1 AND organizer_id=$2 LIMIT 1', [batch.organisation_id, user.id]));
    if (!isAdmin(user) && batch.official_id !== user.id && !isOrg) throw notFound('expense batch');

    const expenses = await many(
      `SELECT oe.id, oe.category, oe.amount_minor, oe.currency, oe.status,
              oe.receipt_doc_id, oe.submitted_at, oe.approved_at, oe.created_at,
              fo.role, f.name AS fixture_name
       FROM official_expenses oe
       JOIN fixture_officials fo ON fo.id = oe.fixture_official_id
       JOIN fixtures f ON f.id = fo.fixture_id
       WHERE oe.batch_id = $1
       ORDER BY oe.created_at`,
      [batch.id],
    );

    return { ...batch, expenses };
  },
});

// ── list batches ───────────────────────────────────────────────────────────

cap({
  name: 'list_expense_batches',
  method: 'GET',
  path: '/official-expense-batches',
  tag: TAG,
  summary: 'Paginated list of expense batches. Official sees own; organiser sees batches for their organisation.',
  input: z.object({
    official_id: id.optional(),
    organisation_id: id.optional(),
    status: z.enum(['draft', 'submitted', 'approved', 'rejected', 'paid']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const params = [];
    const wheres = [];

    if (!isAdmin(user)) {
      wheres.push(`(oeb.official_id=$${params.push(user.id)} OR EXISTS(SELECT 1 FROM events WHERE org_id=oeb.organisation_id AND organizer_id=$${params.push(user.id)} LIMIT 1))`);
    }
    if (i.official_id) wheres.push(`oeb.official_id=$${params.push(i.official_id)}`);
    if (i.organisation_id) wheres.push(`oeb.organisation_id=$${params.push(i.organisation_id)}`);
    if (i.status) wheres.push(`oeb.status=$${params.push(i.status)}`);

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const rows = await many(
      `SELECT oeb.id, oeb.currency, oeb.total_minor, oeb.status, oeb.official_id,
              oeb.organisation_id, oeb.submitted_at, oeb.approved_at, oeb.paid_at, oeb.created_at,
              u.display_name AS official_name,
              (SELECT COUNT(*)::int FROM official_expenses WHERE batch_id=oeb.id) AS expense_count
       FROM official_expense_batches oeb
       LEFT JOIN users u ON u.id = oeb.official_id
       ${where}
       ORDER BY oeb.created_at DESC
       LIMIT $${params.push(i.limit)} OFFSET $${params.push(i.offset)}`,
      params,
    );

    return { batches: rows, limit: i.limit, offset: i.offset };
  },
});

// ── expense summary (per official, per currency) ───────────────────────────

cap({
  name: 'get_official_expense_summary',
  method: 'GET',
  path: '/me/officials/expense-summary',
  tag: TAG,
  summary: 'Per-currency expense summary for the authenticated official: submitted, approved and reimbursed amounts.',
  input: z.object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
  async handler({ user }, i) {
    const params = [user.id];
    const filters = [];
    if (i.from) { params.push(i.from); filters.push(`oe.created_at >= $${params.length}`); }
    if (i.to) { params.push(i.to); filters.push(`oe.created_at < $${params.length}::date + 1`); }
    const extra = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const rows = await many(
      `SELECT
         oe.currency,
         COALESCE(SUM(oe.amount_minor) FILTER (WHERE oe.status IN ('submitted','approved')),0)::bigint AS submitted_minor,
         COALESCE(SUM(oe.amount_minor) FILTER (WHERE oe.status='approved'),0)::bigint AS approved_minor,
         COALESCE(SUM(oe.amount_minor) FILTER (WHERE oe.status='approved' AND oeb.status='paid'),0)::bigint AS reimbursed_minor,
         COALESCE(SUM(oe.amount_minor) FILTER (WHERE oe.status='approved' AND (oeb.id IS NULL OR oeb.status NOT IN ('paid'))),0)::bigint AS pending_minor
       FROM official_expenses oe
       LEFT JOIN official_expense_batches oeb ON oeb.id = oe.batch_id
       WHERE oe.official_id = $1 ${extra}
       GROUP BY oe.currency`,
      params,
    );

    return { expenses: rows };
  },
});
