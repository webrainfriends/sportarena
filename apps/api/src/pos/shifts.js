// The cash drawer: open with a float, take and pay back cash through sales, move cash by hand with a reason, then close on a count.
// Expected cash is always recomputed from the sale payments and the cash movements; a closed shift's figures are frozen (and the database refuses edits).
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notifyVenueTeam } from '../notify.js';
import { toMajor } from '../currency.js';
import { posRole, getSettings, requireApproval } from './access.js';

/** Where the drawer should stand right now, and how it got there. */
export async function cashTotals(c, shift) {
  const n = async (sql) => Number((await c.query(sql, [shift.id])).rows[0].n);
  const cash_in = await n("SELECT coalesce(sum(amount_cents),0) AS n FROM pos_sale_payments WHERE shift_id=$1 AND method='cash' AND kind='payment' AND status='confirmed'");
  const cash_out = await n("SELECT coalesce(sum(amount_cents),0) AS n FROM pos_sale_payments WHERE shift_id=$1 AND method='cash' AND kind='refund' AND status='confirmed'");
  const moves = Object.fromEntries((await c.query('SELECT kind, coalesce(sum(amount_cents),0)::bigint AS n FROM pos_cash_moves WHERE shift_id=$1 GROUP BY kind', [shift.id])).rows.map((r) => [r.kind, Number(r.n)]));
  const opening = Number(shift.opening_float_cents);
  const expected = opening + cash_in - cash_out - (moves.paid_out ?? 0) - (moves.cash_drop ?? 0) + (moves.float_added ?? 0);
  return { opening_float_cents: opening, cash_received_cents: cash_in, cash_refunded_cents: cash_out, paid_out_cents: moves.paid_out ?? 0, cash_drop_cents: moves.cash_drop ?? 0, float_added_cents: moves.float_added ?? 0, expected_cash_cents: expected };
}

export async function shiftView(c, shiftId) {
  const s = (await c.query(
    `SELECT s.*, o.display_name AS opened_by_name, cl.display_name AS closed_by_name, rv.display_name AS reviewed_by_name
       FROM pos_shifts s JOIN users o ON o.id=s.opened_by LEFT JOIN users cl ON cl.id=s.closed_by LEFT JOIN users rv ON rv.id=s.reviewed_by WHERE s.id=$1`, [shiftId])).rows[0];
  if (!s) throw notFound('Shift');
  const live = await cashTotals(c, s);
  const moves = (await c.query('SELECT m.id, m.kind, m.amount_cents, m.reason, m.created_at, u.display_name AS actor, a.display_name AS approved_by FROM pos_cash_moves m JOIN users u ON u.id=m.actor_id LEFT JOIN users a ON a.id=m.approved_by WHERE m.shift_id=$1 ORDER BY m.created_at', [shiftId])).rows;
  const sales = (await c.query("SELECT count(*)::int AS n, coalesce(sum(total_cents) FILTER (WHERE status='paid'),0)::bigint AS paid FROM pos_sales WHERE shift_id=$1", [shiftId])).rows[0];
  const byMethod = (await c.query("SELECT method, coalesce(sum(amount_cents) FILTER (WHERE kind='payment'),0)::bigint AS taken, coalesce(sum(amount_cents) FILTER (WHERE kind='refund'),0)::bigint AS returned FROM pos_sale_payments WHERE shift_id=$1 AND status='confirmed' GROUP BY method ORDER BY method", [shiftId])).rows;
  return { ...s, ...live, expected_cash_cents: s.status === 'closed' ? Number(s.expected_cash_cents) : live.expected_cash_cents, cash_moves: moves, sales_count: sales.n, sales_paid_cents: Number(sales.paid), by_method: byMethod.map((r) => ({ method: r.method, taken_cents: Number(r.taken), returned_cents: Number(r.returned) })) };
}

export async function openShift(user, { venue_id, opening_float_cents, note }) {
  await posRole(user, venue_id);
  try {
    return await tx(async (c) => {
      const s = (await c.query('INSERT INTO pos_shifts(venue_id, opened_by, opening_float_cents, open_note) VALUES ($1,$2,$3,$4) RETURNING id', [venue_id, user.id, opening_float_cents, note ?? null])).rows[0];
      await audit(c, user.id, 'pos_open_shift', 'pos_shifts', s.id);
      return shiftView(c, s.id);
    });
  } catch (e) {
    if (e.code === '23505') throw conflict('A shift is already open at this front desk — close it first');
    throw e;
  }
}

export async function recordCashMove(user, shiftId, { kind, amount_cents, reason, approval_id }) {
  const sh = await one('SELECT venue_id FROM pos_shifts WHERE id=$1', [shiftId]);
  if (!sh) throw notFound('Shift');
  const { role } = await posRole(user, sh.venue_id);
  return tx(async (c) => {
    const shift = (await c.query('SELECT * FROM pos_shifts WHERE id=$1 FOR UPDATE', [shiftId])).rows[0];
    if (shift.status !== 'open') throw conflict('This shift is closed');
    if (kind === 'float_added' && role !== 'manager') throw forbidden('Only a manager can add to the float');
    let approvedBy = null;
    if (kind === 'paid_out') {
      const settings = await getSettings(c, shift.venue_id);
      if (role !== 'manager' && (settings.paid_out_limit_cents == null || amount_cents > settings.paid_out_limit_cents)) approvedBy = await requireApproval(c, { role, user, venueId: shift.venue_id, kind: 'paid_out', amountCents: amount_cents, approvalId: approval_id, usedFor: shiftId });
    }
    if (kind !== 'float_added') {
      const t = await cashTotals(c, shift);
      if (amount_cents > t.expected_cash_cents) throw conflict(`The drawer should hold only ${t.expected_cash_cents} — you cannot take out more than that`);
    }
    const m = (await c.query('INSERT INTO pos_cash_moves(shift_id, venue_id, kind, amount_cents, reason, actor_id, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [shiftId, shift.venue_id, kind, amount_cents, reason, user.id, approvedBy])).rows[0];
    await audit(c, user.id, `pos_cash_${kind}`, 'pos_cash_moves', m.id);
    return shiftView(c, shiftId);
  });
}

export async function closeShift(user, shiftId, { counted_cash_cents, note }) {
  const sh = await one('SELECT venue_id FROM pos_shifts WHERE id=$1', [shiftId]);
  if (!sh) throw notFound('Shift');
  await posRole(user, sh.venue_id);
  return tx(async (c) => {
    const shift = (await c.query('SELECT * FROM pos_shifts WHERE id=$1 FOR UPDATE', [shiftId])).rows[0];
    if (shift.status !== 'open') throw conflict('This shift is already closed');
    // taking the row exclusively waits for every tender that holds it in shared mode, so the count includes all cash that was accepted
    const settings = await getSettings(c, shift.venue_id);
    const t = await cashTotals(c, shift);
    const variance = counted_cash_cents - t.expected_cash_cents;
    if (variance !== 0 && !note) throw badRequest('The count does not match what the drawer should hold — add a note explaining the difference');
    const review = Math.abs(variance) > settings.variance_tolerance_cents ? 'pending' : 'none';
    await c.query("UPDATE pos_shifts SET status='closed', closed_by=$2, closed_at=now(), expected_cash_cents=$3, counted_cash_cents=$4, variance_cents=$5, close_note=$6, review_status=$7 WHERE id=$1",
      [shiftId, user.id, t.expected_cash_cents, counted_cash_cents, variance, note ?? null, review]);
    await audit(c, user.id, 'pos_close_shift', 'pos_shifts', shiftId);
    if (review === 'pending') {
      const venue = (await c.query('SELECT * FROM venues WHERE id=$1', [shift.venue_id])).rows[0];
      await notifyVenueTeam(c, venue, user.id, { kind: 'pos_variance', title: 'Cash drawer needs a review', body: `${venue.name}: the count was ${variance < 0 ? 'short' : 'over'} by ${venue.currency} ${toMajor(Math.abs(variance), venue.currency)}.`, data: { venue_id: venue.id, shift_id: shiftId } });
    }
    return shiftView(c, shiftId);
  });
}

export async function reviewShift(user, shiftId, { decision, note }) {
  const sh = await one('SELECT venue_id FROM pos_shifts WHERE id=$1', [shiftId]);
  if (!sh) throw notFound('Shift');
  const { role } = await posRole(user, sh.venue_id);
  if (role !== 'manager') throw forbidden('Only a venue manager can review a cash variance');
  return tx(async (c) => {
    const shift = (await c.query('SELECT * FROM pos_shifts WHERE id=$1 FOR UPDATE', [shiftId])).rows[0];
    if (shift.status !== 'closed' || shift.review_status !== 'pending') throw conflict('This shift has no variance waiting for review');
    await c.query('UPDATE pos_shifts SET review_status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1', [shiftId, decision === 'approve' ? 'approved' : 'disputed', user.id, note]);
    await audit(c, user.id, shift.closed_by === user.id ? 'pos_review_shift_self' : 'pos_review_shift', 'pos_shifts', shiftId);
    return shiftView(c, shiftId);
  });
}

export const openShiftFor = async (user, venueId) => {
  await posRole(user, venueId);
  const s = await one("SELECT id FROM pos_shifts WHERE venue_id=$1 AND status='open'", [venueId]);
  return s ? tx((c) => shiftView(c, s.id)) : null;
};

export async function listShifts(user, i) {
  await posRole(user, i.venue_id);
  return many(
    `SELECT s.id, s.status, s.opened_at, s.closed_at, s.opening_float_cents, s.expected_cash_cents, s.counted_cash_cents, s.variance_cents, s.review_status, o.display_name AS opened_by_name
       FROM pos_shifts s JOIN users o ON o.id=s.opened_by WHERE s.venue_id=$1 AND ($2::text IS NULL OR s.status=$2) AND ($3::text IS NULL OR s.review_status=$3) ORDER BY s.opened_at DESC LIMIT $4 OFFSET $5`,
    [i.venue_id, i.status ?? null, i.review_status ?? null, i.limit, i.offset]);
}
