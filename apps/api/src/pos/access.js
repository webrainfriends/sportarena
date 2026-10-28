// Who may do what at a venue's front desk, the venue's desk rules, and one-time manager approvals.
// Enforced on the server for REST, OpenAPI and MCP alike; the app only hides what the server would refuse.
import { pool } from '../db.js';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';

export const MANUAL_METHODS = ['cash', 'card_terminal', 'upi_manual', 'bank_manual', 'other_manual'];

/**
 * 'manager' (owner, platform admin, organisation owner/admin, venue_staff manager) or 'cashier' (venue_staff staff).
 * Anyone else gets a 404 for the venue so its existence is not leaked.
 */
export async function posRole(user, venueId, c = pool) {
  if (!user) throw notFound('Venue');
  const v = (await c.query('SELECT id, owner_id, organisation_id FROM venues WHERE id=$1', [venueId])).rows[0];
  if (!v) throw notFound('Venue');
  if (user.roles?.includes('admin') || v.owner_id === user.id) return { role: 'manager', venue: v };
  // venue_staff rows are the venue's own team (they already run bookings, pricing and reports), so at the desk they are managers
  if ((await c.query('SELECT 1 FROM venue_staff WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL', [venueId, user.id])).rowCount) return { role: 'manager', venue: v };
  if (v.organisation_id && (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')", [v.organisation_id, user.id])).rowCount) return { role: 'manager', venue: v };
  if ((await c.query('SELECT 1 FROM pos_cashiers WHERE venue_id=$1 AND user_id=$2 AND removed_at IS NULL', [venueId, user.id])).rowCount) return { role: 'cashier', venue: v };
  throw notFound('Venue');
}

/** The venues this person works the front desk of, with their desk role. */
export const myDesks = async (user, c = pool) => (await c.query(
  `SELECT v.id, v.name, v.emoji, v.city, 'manager' AS role FROM venues v
    WHERE v.owner_id=$1 OR EXISTS (SELECT 1 FROM venue_staff s WHERE s.venue_id=v.id AND s.user_id=$1 AND s.removed_at IS NULL)
       OR EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=v.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin'))
   UNION ALL
   SELECT v.id, v.name, v.emoji, v.city, 'cashier' FROM pos_cashiers pc JOIN venues v ON v.id=pc.venue_id WHERE pc.user_id=$1 AND pc.removed_at IS NULL
      AND NOT (v.owner_id=$1 OR EXISTS (SELECT 1 FROM venue_staff s WHERE s.venue_id=v.id AND s.user_id=$1 AND s.removed_at IS NULL))
   ORDER BY name`, [user.id])).rows;

export async function mustBeManager(user, venueId, c = pool) {
  const r = await posRole(user, venueId, c);
  if (r.role !== 'manager') throw forbidden('Only a venue manager can do that');
  return r;
}

export const DEFAULT_SETTINGS = { require_shift: false, cashier_discount_max_bp: 1000, refund_limit_cents: null, paid_out_limit_cents: null, variance_tolerance_cents: 0, manual_methods: ['cash'], offline_cash_allowed: true };

export async function getSettings(c, venueId) {
  const s = (await c.query('SELECT * FROM pos_settings WHERE venue_id=$1', [venueId])).rows[0];
  return { ...DEFAULT_SETTINGS, ...(s ?? {}), venue_id: venueId };
}

/**
 * A cashier needs a manager's approval for what exceeds the venue's limit. The approval is single-use, short-lived, for this venue and kind,
 * and large enough for the amount. Managers need none. Returns the approving manager (or null when none was needed).
 */
export async function requireApproval(c, { role, user, venueId, kind, amountCents, approvalId, usedFor }) {
  if (role === 'manager') return null;
  if (!approvalId) throw new AppError(403, 'approval_required', `A manager's approval is needed for this ${kind.replace('_', ' ')}`, { kind });
  // wrong codes are counted outside this transaction (it is about to roll back), so 6 digits cannot be guessed
  const wrong = Number((await pool.query("SELECT count(*) AS n FROM pos_approval_attempts WHERE venue_id=$1 AND user_id=$2 AND at > now() - interval '15 minutes'", [venueId, user.id])).rows[0].n);
  if (wrong >= 5) throw new AppError(429, 'too_many_requests', 'Too many wrong approval codes — wait a few minutes or ask the manager for a new one');
  const a = (await c.query(
    `UPDATE pos_approvals SET used_at=now(), used_by=$5, used_for=$6
      WHERE (id::text=$1 OR code=$1) AND venue_id=$2 AND kind=$3 AND used_at IS NULL AND expires_at > now() AND max_amount_cents >= $4 AND (granted_to IS NULL OR granted_to=$5) RETURNING granted_by`,
    [approvalId, venueId, kind, amountCents, user.id, usedFor ?? null])).rows[0];
  if (!a) {
    await pool.query('INSERT INTO pos_approval_attempts(venue_id, user_id) VALUES ($1,$2)', [venueId, user.id]);
    throw new AppError(403, 'approval_invalid', 'That approval is not valid for this amount (it may be used, expired, or for something else)', { kind });
  }
  return a.granted_by;
}

/** Tenders the venue allows staff to record by hand. Online payments are never "recorded": the provider confirms them. */
export function assertManualMethod(settings, method) {
  if (!MANUAL_METHODS.includes(method)) throw badRequest('Online payments are confirmed by the payment provider, not recorded by staff');
  if (!settings.manual_methods.includes(method)) throw badRequest(`${method.replace('_', ' ')} is not enabled for this front desk — a manager can switch it on in the desk settings`);
}
