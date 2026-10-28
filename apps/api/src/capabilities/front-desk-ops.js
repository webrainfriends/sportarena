// Front desk back office: drawer shifts and cash movements, manager approvals and desk rules, rental returns and the reconciled report.
// (Stock and its sale/rental terms live in the existing Supply Chain capabilities: create_inventory_item, list_inventory, update_inventory_item, adjust_stock.)
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { openShift, openShiftFor, recordCashMove, closeShift, reviewShift, listShifts, shiftView } from '../pos/shifts.js';
import { grantApproval, readSettings, writeSettings, addCashier, removeCashier, listCashiers } from '../pos/catalogue.js';
import { issueRental, closeRental, listRentals } from '../pos/rentals.js';
import { posReport } from '../pos/report.js';
import { posRole, myDesks, MANUAL_METHODS } from '../pos/access.js';
import { tx, one } from '../db.js';
import { notFound } from '../errors.js';

const TAG = 'Front desk';
const dt = z.string().datetime({ offset: true });
const approvalRef = z.string().trim().min(4).max(40).optional().describe('a manager\'s approval: its 6-digit code (or id)');

// ------------------------------------------------------------------ shifts & cash
cap({
  name: 'open_pos_shift', method: 'POST', path: '/venues/:id/pos/shifts', tag: TAG, status: 201,
  summary: 'Open the cash drawer with its starting float. One shift can be open per front desk. Cash taken and paid back on sales attach to it automatically.',
  input: z.object({ id, opening_float_cents: money, note: z.string().trim().max(200).optional() }),
  handler: ({ user }, i) => openShift(user, { venue_id: i.id, opening_float_cents: i.opening_float_cents, note: i.note }),
});

cap({
  name: 'current_pos_shift', method: 'GET', path: '/venues/:id/pos/shift', tag: TAG,
  summary: 'The open shift with where the drawer should stand right now (float + cash received − cash refunded − paid-outs − drops), or null when no shift is open.',
  input: z.object({ id }),
  handler: ({ user }, i) => openShiftFor(user, i.id),
});

cap({
  name: 'list_pos_shifts', method: 'GET', path: '/venues/:id/pos/shifts', tag: TAG,
  summary: 'Shifts, newest first, with expected cash, counted cash and variance. Filter by status or by variance review state.',
  input: z.object({ id, status: z.enum(['open', 'closed']).optional(), review_status: z.enum(['none', 'pending', 'approved', 'disputed']).optional(), ...page }),
  handler: ({ user }, i) => listShifts(user, { ...i, venue_id: i.id }),
});

cap({
  name: 'get_pos_shift', method: 'GET', path: '/pos/shifts/:id', tag: TAG,
  summary: 'One shift: the cash reconciliation, every cash movement with who and why, tenders by method and the sales count.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const s = await one('SELECT venue_id FROM pos_shifts WHERE id=$1', [i.id]);
    if (!s) throw notFound('Shift');
    await posRole(user, s.venue_id);
    return tx((c) => shiftView(c, i.id));
  },
});

cap({
  name: 'record_pos_cash_move', method: 'POST', path: '/pos/shifts/:id/cash-moves', tag: TAG, status: 201, scope: 'payment',
  summary: 'Move cash without a sale: a paid-out (supplier, petty cash), a drop to the safe, or a float top-up (managers only). A reason is mandatory. A cashier\'s paid-out above the venue limit needs a manager approval. You cannot take out more than the drawer should hold.',
  input: z.object({ id, kind: z.enum(['paid_out', 'cash_drop', 'float_added']), amount_cents: money.refine((n) => n > 0, 'must be more than zero'), reason: z.string().trim().min(3).max(200), approval_id: approvalRef }),
  handler: ({ user }, i) => recordCashMove(user, i.id, i),
});

cap({
  name: 'close_pos_shift', method: 'POST', path: '/pos/shifts/:id/close', tag: TAG, scope: 'payment',
  summary: 'Close the drawer on a count. The expected cash is computed from the sales and cash movements, the variance (counted − expected) is stored immutably, and a variance beyond the venue\'s tolerance goes to a manager review. A difference needs a note.',
  input: z.object({ id, counted_cash_cents: money, note: z.string().trim().max(300).optional() }),
  handler: ({ user }, i) => closeShift(user, i.id, { counted_cash_cents: i.counted_cash_cents, note: i.note }),
});

cap({
  name: 'review_pos_shift', method: 'POST', path: '/pos/shifts/:id/review', tag: TAG,
  summary: 'A manager accepts or disputes a cash variance. The review is final and recorded with who and why (a manager reviewing their own close is flagged in the audit log).',
  input: z.object({ id, decision: z.enum(['approve', 'dispute']), note: z.string().trim().min(3).max(300) }),
  handler: ({ user }, i) => reviewShift(user, i.id, { decision: i.decision, note: i.note }),
});

// ------------------------------------------------------------------ approvals & rules
cap({
  name: 'grant_pos_approval', method: 'POST', path: '/venues/:id/pos/approvals', tag: TAG, status: 201,
  summary: 'A manager approves one thing a cashier cannot do alone (a discount, refund, paid-out or void above the limit): single-use, for this venue and kind, up to a maximum amount, and it expires. Pass the returned id as approval_id on the cashier\'s call.',
  input: z.object({ id, kind: z.enum(['discount', 'refund', 'paid_out', 'void']), max_amount_cents: money, reason: z.string().trim().min(3).max(200), granted_to: id.optional().describe('limit it to one team member'), valid_minutes: z.number().int().min(1).max(60).default(10) }),
  handler: ({ user }, i) => grantApproval(user, { ...i, venue_id: i.id }),
});

cap({
  name: 'get_pos_settings', method: 'GET', path: '/venues/:id/pos/settings', tag: TAG,
  summary: 'The desk rules: whether cash needs an open shift, the cashier discount limit, refund and paid-out limits, variance tolerance, which hand-recorded tenders are on, offline cash.',
  input: z.object({ id }),
  handler: ({ user }, i) => readSettings(user, i.id),
});

cap({
  name: 'update_pos_settings', method: 'PATCH', path: '/venues/:id/pos/settings', tag: TAG,
  summary: 'Managers set the desk rules. A null refund or paid-out limit means every cashier refund / paid-out needs a manager approval.',
  input: z.object({
    id, require_shift: z.boolean().optional(), cashier_discount_max_bp: z.number().int().min(0).max(10000).optional().describe('1000 = 10%'),
    refund_limit_cents: money.nullable().optional(), paid_out_limit_cents: money.nullable().optional(), variance_tolerance_cents: money.optional(),
    manual_methods: z.array(z.enum(MANUAL_METHODS)).min(1).optional(), offline_cash_allowed: z.boolean().optional(),
  }),
  handler: ({ user }, { id: venueId, ...rest }) => writeSettings(user, venueId, rest),
});

// ------------------------------------------------------------------ rentals
cap({
  name: 'list_pos_rentals', method: 'GET', path: '/venues/:id/pos/rentals', tag: TAG,
  summary: 'Rental kit by state (reserved, issued, returned, damaged, lost) with deposits held and what is overdue.',
  input: z.object({ id, status: z.enum(['reserved', 'issued', 'returned', 'damaged', 'lost', 'cancelled']).optional(), overdue: z.coerce.boolean().optional(), ...page }),
  handler: ({ user }, i) => listRentals(user, { ...i, venue_id: i.id }),
});
cap({
  name: 'issue_pos_rental', method: 'POST', path: '/pos/rentals/:id/issue', tag: TAG,
  summary: 'Hand the kit over (the sale must be paid). Starts the rental clock and holds the deposit. Rentals of a sale that is paid when rung up are issued automatically.',
  input: z.object({ id, due_at: dt.optional() }),
  handler: ({ user }, i) => issueRental(user, i.id, { due_at: i.due_at }),
});
cap({
  name: 'close_pos_rental', method: 'POST', path: '/pos/rentals/:id/close', tag: TAG, scope: 'payment',
  summary: 'Take kit back. returned = back on the shelf and the whole deposit refunded; damaged = out of the rentable pool and the deposit forfeited by forfeit_cents (default all); lost = gone from stock and the deposit forfeited likewise. The refund is a credit note; cash comes out of the drawer.',
  input: z.object({ id, outcome: z.enum(['returned', 'damaged', 'lost']), forfeit_cents: money.optional(), note: z.string().trim().max(300).optional(), method: z.enum(['cash', 'original']).default('cash') }),
  handler: ({ user }, i) => closeRental(user, i.id, { outcome: i.outcome, forfeit_cents: i.forfeit_cents, note: i.note, method: i.method }),
});

// ------------------------------------------------------------------ report
cap({
  name: 'pos_report', method: 'GET', path: '/venues/:id/pos/report', tag: TAG,
  summary: 'Front-desk sales by category (with margin where cost is recorded), payment method, cashier and shift, refunds, discounts and tax — plus a reconciliation of the sale lines against the numbered invoices, the confirmed payments and applied credit, and the open exceptions (pending online payments, variances to review, refunds for the desk, overdue rentals). Managers only.',
  input: z.object({ id, from: dt.optional(), to: dt.optional(), shift_id: id.optional() }),
  handler: ({ user }, i) => posReport(user, { venue_id: i.id, from: i.from, to: i.to, shift_id: i.shift_id }),
});

// ------------------------------------------------------------------ who works the desk
cap({
  name: 'list_my_front_desks', method: 'GET', path: '/me/front-desks', tag: TAG,
  summary: 'The front desks you work: venues you own, help run or administer through an organisation (manager) and venues where you were added as a cashier.',
  handler: ({ user }) => myDesks(user),
});
cap({
  name: 'add_pos_cashier', method: 'POST', path: '/venues/:id/pos/cashiers', tag: TAG, status: 201,
  summary: 'Let someone (by handle) work this front desk as a cashier — and nothing else at the venue: no bookings, pricing, reports, tenders or staff management. Managers only.',
  input: z.object({ id, handle: z.string().min(3).max(24) }),
  handler: ({ user }, i) => addCashier(user, i.id, i.handle),
});
cap({
  name: 'list_pos_cashiers', method: 'GET', path: '/venues/:id/pos/cashiers', tag: TAG,
  summary: 'The cashiers of this front desk. Managers only.',
  input: z.object({ id }),
  handler: ({ user }, i) => listCashiers(user, i.id),
});
cap({
  name: 'remove_pos_cashier', method: 'DELETE', path: '/venues/:id/pos/cashiers/:user_id', tag: TAG,
  summary: 'Take a cashier off this front desk (their sales and shifts stay on record). Managers only.',
  input: z.object({ id, user_id: id }),
  handler: ({ user }, i) => removeCashier(user, i.id, i.user_id),
});
