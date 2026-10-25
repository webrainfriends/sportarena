// Who may act for a supplier or a buyer. Everything is read live, so removing a person revokes future access at once while the business
// records they created are kept. Outsiders get 404 (existence is not leaked); insiders without the role get 403.
import { pool } from '../db.js';
import { isAdmin } from '../helpers.js';
import { forbidden, notFound, conflict } from '../errors.js';
import { orgRole } from '../org-access.js';
import { canManage } from '../booking/engine.js';
import { eventForOrganizer } from '../capabilities/events.js';

export const SUPPLIER_ROLES = ['owner', 'sales', 'scheduler', 'supervisor', 'finance', 'crew'];
export const BUYER_ROLES = ['requester', 'evaluator', 'approver', 'purchaser', 'acceptor', 'finance'];
const q = (c, t, a) => c.query(t, a).then((r) => r.rows);

/** The supplier profile + the caller's roles on it. `roles` = any of these suffices (owner always does). */
export async function supplierAccess(user, profileId, roles, c = pool) {
  const profile = (await q(c, 'SELECT * FROM svc_profiles WHERE id=$1', [profileId]))[0];
  if (!profile) throw notFound('Supplier');
  const mine = new Set();
  if (isAdmin(user) || profile.owner_id === user.id) mine.add('owner');
  for (const r of await q(c, "SELECT role FROM svc_staff WHERE profile_id=$1 AND user_id=$2 AND status='active'", [profileId, user.id])) mine.add(r.role);
  if (!mine.size && profile.organisation_id) { const r = await orgRole(user, profile.organisation_id, c); if (['owner', 'admin'].includes(r)) mine.add('owner'); }
  if (!mine.size) throw notFound('Supplier');
  if (roles && !mine.has('owner') && !roles.some((x) => mine.has(x))) throw forbidden(`That needs the ${roles.join(' or ')} role at this supplier`);
  return { profile, roles: [...mine] };
}
/** Profiles the user acts for (any role). */
export const myProfileIds = async (user, c = pool) => (await q(c,
  `SELECT id FROM svc_profiles WHERE status <> 'archived' AND (owner_id=$1 OR id IN (SELECT profile_id FROM svc_staff WHERE user_id=$1 AND status='active')
     OR organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin')))`, [user.id])).map((r) => r.id);

/** Roles the caller holds on a buyer. Organisation membership alone grants nothing; an org owner/admin, the event organiser, the venue team or the person themself may request/purchase/evaluate/accept. */
export async function buyerRoles(user, buyer, c = pool) {
  const mine = new Set();
  const lim = {};
  for (const r of await q(c, "SELECT role, limit_minor FROM svc_buyer_roles WHERE buyer_id=$1 AND user_id=$2 AND status='active'", [buyer.id, user.id])) { mine.add(r.role); lim[r.role] = r.limit_minor === null ? null : Number(r.limit_minor); }
  const base = ['requester', 'purchaser', 'evaluator', 'acceptor', 'finance'];
  let owner = isAdmin(user) || buyer.owner_id === user.id;
  if (!owner && buyer.event_id) { try { await eventForOrganizer(user, buyer.event_id, c); owner = true; } catch { /* not the organiser */ } }
  if (!owner && buyer.venue_id) owner = await canManage(user, buyer.venue_id, c);
  if (buyer.organisation_id) {
    const r = await orgRole(user, buyer.organisation_id, c);
    if (['owner', 'admin'].includes(r)) owner = true;
    if (r === 'finance') mine.add('finance');
  }
  if (owner) for (const r of base) if (!mine.has(r)) { mine.add(r); lim[r] = lim[r] ?? null; }
  return { roles: mine, limits: lim, owner };
}
export async function buyerAccess(user, buyerId, roles, c = pool) {
  const buyer = (await q(c, 'SELECT * FROM svc_buyers WHERE id=$1', [buyerId]))[0];
  if (!buyer) throw notFound('Buyer');
  const a = await buyerRoles(user, buyer, c);
  if (!a.roles.size && !a.owner) throw notFound('Buyer');
  if (roles && !roles.some((r) => a.roles.has(r))) throw forbidden(`That needs the ${roles.join(' or ')} role for this buyer`);
  return { buyer, ...a };
}
/** Buyers the user can see (any role). */
export const myBuyerIds = async (user, c = pool) => (await q(c,
  `SELECT b.id FROM svc_buyers b WHERE b.status='active' AND (b.owner_id=$1
     OR b.id IN (SELECT buyer_id FROM svc_buyer_roles WHERE user_id=$1 AND status='active')
     OR b.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin','finance'))
     OR b.event_id IN (SELECT e.id FROM events e WHERE e.organizer_id=$1 OR e.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin')))
     OR b.venue_id IN (SELECT v.id FROM venues v WHERE v.owner_id=$1 OR v.id IN (SELECT venue_id FROM venue_staff WHERE user_id=$1 AND removed_at IS NULL)))`, [user.id])).map((r) => r.id);

/**
 * Find or create the buyer for a context after proving the caller manages that context. Exactly one of event_id / venue_id / organisation_id,
 * or none (a personal buyer). A school / academy buys through its organisation, with no event required.
 */
export async function resolveBuyer(user, ctx, c = pool) {
  const { event_id, venue_id, organisation_id } = ctx;
  let where, name, currency = ctx.currency, owner = user.id, org = null, ev = null, ven = null;
  if (event_id) {
    const e = await eventForOrganizer(user, event_id, c);
    where = ['event_id', event_id]; name = e.name; currency = currency ?? e.currency; org = e.organisation_id ?? null; ev = event_id; owner = e.organizer_id ?? user.id;
  } else if (venue_id) {
    const v = (await q(c, 'SELECT * FROM venues WHERE id=$1', [venue_id]))[0];
    if (!v) throw notFound('Venue');
    if (!(await canManage(user, venue_id, c))) throw forbidden('Only the venue team can buy for the venue');
    where = ['venue_id', venue_id]; name = v.name; currency = currency ?? v.currency; ven = venue_id; org = v.organisation_id ?? null; owner = v.owner_id ?? user.id;
  } else if (organisation_id) {
    const o = (await q(c, 'SELECT * FROM organisations WHERE id=$1', [organisation_id]))[0];
    if (!o) throw notFound('Organisation');
    if (!['owner', 'admin'].includes(await orgRole(user, organisation_id, c))) throw forbidden('Only an organisation owner or admin can open procurement for it');
    where = ['organisation_id', organisation_id]; name = o.name; org = organisation_id;
  } else { where = ['owner_id', user.id]; name = user.display_name ?? 'Personal'; }
  if (!currency) throw conflict('Say which currency this buyer spends in');
  const col = where[0];
  const extra = col === 'owner_id' ? 'AND organisation_id IS NULL AND event_id IS NULL AND venue_id IS NULL' : col === 'organisation_id' ? 'AND event_id IS NULL AND venue_id IS NULL' : '';
  const found = (await q(c, `SELECT * FROM svc_buyers WHERE ${col}=$1 ${extra} AND status='active'`, [where[1]]))[0];
  if (found) return found;
  try {
    return (await q(c, 'INSERT INTO svc_buyers(owner_id, organisation_id, event_id, venue_id, name, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [owner, org, ev, ven, name, currency]))[0];
  } catch (e) { if (e.code === '23505') return (await q(c, `SELECT * FROM svc_buyers WHERE ${col}=$1 ${extra} AND status='active'`, [where[1]]))[0]; throw e; }
}

export const log = (c, entity, entityId, actor, action, detail = {}) => c.query('INSERT INTO svc_activity(entity, entity_id, actor_id, action, detail) VALUES ($1,$2,$3,$4,$5)', [entity, entityId, actor, action, detail]);
/** Next gapless number for a scope: e.g. PO-ARN12-2026-000004. */
export async function nextNumber(c, scopeId, kind, prefix) {
  const { seq } = (await c.query('INSERT INTO svc_counters(scope_id, kind, seq) VALUES ($1,$2,1) ON CONFLICT (scope_id, kind) DO UPDATE SET seq = svc_counters.seq + 1 RETURNING seq', [scopeId, kind])).rows[0];
  return `${prefix}-${new Date().getUTCFullYear()}-${String(seq).padStart(6, '0')}`;
}
