// Commercial side of an event: retail / catering vendors, sponsors and the goods sold at the event.
import { z } from 'zod';
import { cap, id, money } from '../registry.js';
import { pool, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, mustFind } from '../helpers.js';
import { eventForOrganizer } from './events.js';
import { notify } from '../notify.js';

const KINDS = ['retail', 'catering', 'sponsor', 'other'];

cap({
  name: 'invite_event_vendor', method: 'POST', path: '/events/:id/vendors', tag: 'Event vendors', status: 201,
  summary: 'Invite a retailer, caterer, sponsor or other vendor to the event (organiser). For a sponsor pass sponsor_id; fee_cents is the pitch fee (retail/catering) or the sponsorship amount. Accepting a sponsor invite creates an active event sponsorship.',
  input: z.object({ id, kind: z.enum(KINDS), vendor_user_id: id.optional(), sponsor_id: id.optional(), fee_cents: money.default(0), currency: z.string().length(3).optional(), in_kind: z.string().max(200).optional(), notes: z.string().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await eventForOrganizer(user, i.id, c);
      if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      let vendor = i.vendor_user_id;
      if (i.kind === 'sponsor') {
        if (!i.sponsor_id) throw badRequest('A sponsor invitation needs sponsor_id');
        vendor = (await mustFind('sponsors', i.sponsor_id, 'owner_id', c)).owner_id;
        if (i.vendor_user_id && i.vendor_user_id !== vendor) throw badRequest('vendor_user_id is not the owner of that sponsor');
      } else {
        if (!vendor) throw badRequest('vendor_user_id is required');
        if (i.sponsor_id) throw badRequest('sponsor_id only applies to sponsor invitations');
        await mustFind('users', vendor, 'id', c);
      }
      const dup = await c.query("SELECT 1 FROM event_vendors WHERE event_id=$1 AND kind=$2 AND vendor_user_id=$3 AND status IN ('invited','accepted')", [ev.id, i.kind, vendor]);
      if (dup.rowCount) throw conflict('That vendor already has an open invitation or place at this event');
      const v = (await c.query('INSERT INTO event_vendors(event_id, kind, vendor_user_id, sponsor_id, fee_cents, currency, in_kind, notes, invited_by) VALUES ($1,$2,$3,$4,$5,upper($6),$7,$8,$9) RETURNING *',
        [ev.id, i.kind, vendor, i.sponsor_id ?? null, i.fee_cents, i.currency ?? ev.currency, i.in_kind ?? null, i.notes ?? null, user.id])).rows[0];
      await notify(c, vendor, { kind: 'event_vendor', title: `${i.kind === 'sponsor' ? 'Sponsorship' : 'Vendor'} invitation: ${ev.name}`, body: i.notes || `${ev.name} invites you as ${i.kind}.`, data: { event_id: ev.id, vendor_id: v.id } });
      return v;
    });
  },
});

cap({
  name: 'respond_event_vendor', method: 'POST', path: '/event-vendors/:id/respond', tag: 'Event vendors',
  summary: 'Accept or decline an event invitation (the invited vendor/sponsor owner). Accepting a sponsor invitation records an active sponsorship for the event.',
  input: z.object({ id, accept: z.boolean() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v = (await c.query('SELECT * FROM event_vendors WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!v || (v.vendor_user_id !== user.id && !isAdmin(user))) throw notFound('Invitation');
      if (v.status !== 'invited') throw conflict(`Invitation is already ${v.status}`);
      const ev = await mustFind('events', v.event_id, '*', c);
      if (i.accept && ['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`);
      let sponsorshipId = null;
      if (i.accept && v.kind === 'sponsor') {
        sponsorshipId = (await c.query(
          `INSERT INTO sponsorships(sponsor_id, target_type, target_id, amount_cents, in_kind, status, proposed_by, starts_on, ends_on, decided_at, decided_by)
           VALUES ($1,'event',$2,$3,$4,'active',$5,$6,$7,now(),$8) RETURNING id`, [v.sponsor_id, ev.id, v.fee_cents, v.in_kind, v.invited_by, ev.starts_on, ev.ends_on, user.id])).rows[0].id;
      }
      const out = (await c.query('UPDATE event_vendors SET status=$2, responded_at=now(), sponsorship_id=$3 WHERE id=$1 RETURNING *', [v.id, i.accept ? 'accepted' : 'declined', sponsorshipId])).rows[0];
      await notify(c, v.invited_by, { kind: 'event_vendor', title: `Invitation ${out.status}`, body: `${ev.name}: a ${v.kind} invitation was ${out.status}.`, data: { event_id: ev.id, vendor_id: v.id } });
      return out;
    });
  },
});

cap({
  name: 'end_event_vendor', method: 'POST', path: '/event-vendors/:id/end', tag: 'Event vendors',
  summary: 'End a vendor/sponsor place at the event (organiser or the vendor). Kept as ended; an event sponsorship it created is ended too.', input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v = (await c.query('SELECT * FROM event_vendors WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!v) throw notFound('Vendor');
      if (v.vendor_user_id !== user.id) await eventForOrganizer(user, v.event_id, c);
      if (v.status !== 'accepted') throw conflict(`Only accepted vendors can be ended (this one is ${v.status})`);
      if (v.sponsorship_id) await c.query("UPDATE sponsorships SET status='ended' WHERE id=$1", [v.sponsorship_id]);
      await c.query('UPDATE event_products SET removed_at=now() WHERE event_id=$1 AND removed_at IS NULL AND product_id IN (SELECT id FROM shop_products WHERE seller_id=$2)', [v.event_id, v.vendor_user_id]);
      return (await c.query("UPDATE event_vendors SET status='ended' WHERE id=$1 RETURNING *", [v.id])).rows[0];
    });
  },
});

cap({
  name: 'list_event_vendors', method: 'GET', path: '/events/:id/vendors', tag: 'Event vendors', auth: 'public',
  summary: 'Vendors and sponsors of an event. The organiser sees every invitation; everyone else only confirmed ones.',
  input: z.object({ id, kind: z.enum(KINDS).optional() }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    const organiser = !!user && (isAdmin(user) || user.id === ev.organizer_id);
    return many(
      `SELECT v.id, v.kind, v.status, v.fee_cents, v.currency, v.in_kind, v.notes, v.vendor_user_id, v.sponsor_id, u.display_name AS vendor_name, s.name AS sponsor_name, s.emoji AS sponsor_emoji
         FROM event_vendors v JOIN users u ON u.id=v.vendor_user_id LEFT JOIN sponsors s ON s.id=v.sponsor_id
        WHERE v.event_id=$1 AND ($2::text IS NULL OR v.kind=$2) AND ($3 OR v.status='accepted' OR v.vendor_user_id=$4) ORDER BY v.created_at`, [i.id, i.kind ?? null, organiser, user?.id ?? null]);
  },
});

cap({
  name: 'attach_event_product', method: 'POST', path: '/events/:id/products', tag: 'Event vendors', status: 201,
  summary: 'List a shop product as on sale at the event. The seller must be a confirmed retail vendor of the event (or the organiser); the organiser or that seller can attach it.',
  input: z.object({ id, product_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ev = await mustFind('events', i.id, '*', c);
      const p = await mustFind('shop_products', i.product_id, '*', c);
      const organiser = await eventForOrganizer(user, i.id, c).then(() => true, () => false);
      if (!organiser && user.id !== p.seller_id) throw forbidden('Only the organiser or the product’s seller can list it at this event');
      if (p.seller_id !== ev.organizer_id) {
        const ok = await c.query("SELECT 1 FROM event_vendors WHERE event_id=$1 AND kind='retail' AND vendor_user_id=$2 AND status='accepted'", [ev.id, p.seller_id]);
        if (!ok.rowCount) throw conflict('The seller is not a confirmed retail vendor of this event');
      }
      const row = (await c.query('INSERT INTO event_products(event_id, product_id, added_by) VALUES ($1,$2,$3) ON CONFLICT (event_id, product_id) WHERE removed_at IS NULL DO NOTHING RETURNING *', [ev.id, p.id, user.id])).rows[0];
      if (!row) throw conflict('Already listed for this event');
      return row;
    });
  },
});

cap({
  name: 'detach_event_product', method: 'DELETE', path: '/events/:id/products/:product_id', tag: 'Event vendors', summary: 'Take a product off the event’s retail list (kept as removed).',
  input: z.object({ id, product_id: id }),
  async handler({ user }, i) {
    const p = await mustFind('shop_products', i.product_id, 'seller_id');
    if (p.seller_id !== user.id) await eventForOrganizer(user, i.id);
    const r = await pool.query('UPDATE event_products SET removed_at=now() WHERE event_id=$1 AND product_id=$2 AND removed_at IS NULL RETURNING *', [i.id, i.product_id]);
    if (!r.rowCount) throw notFound('Listed product');
    return r.rows[0];
  },
});

cap({
  name: 'list_event_products', method: 'GET', path: '/events/:id/products', tag: 'Event vendors', auth: 'public', summary: 'Goods on sale at the event (from confirmed retail vendors and the organiser).',
  input: z.object({ id }),
  async handler(_, i) {
    await mustFind('events', i.id, 'id');
    return many(
      `SELECT p.id, p.name, p.category, p.description, p.price_cents, p.stock, p.emoji, p.seller_id, u.display_name AS seller_name FROM event_products ep JOIN shop_products p ON p.id=ep.product_id JOIN users u ON u.id=p.seller_id
        WHERE ep.event_id=$1 AND ep.removed_at IS NULL ORDER BY p.name`, [i.id]);
  },
});

cap({
  name: 'get_event_commercials', method: 'GET', path: '/events/:id/commercials', tag: 'Event vendors',
  summary: 'Organiser summary of event money in/out (minor units): entry fees expected, sponsorship, vendor pitch fees, and the cost of confirmed staff.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await eventForOrganizer(user, i.id);
    const [entries, sponsors, vendors, staff, open] = await Promise.all([
      pool.query("SELECT count(*)::int AS n FROM event_entries WHERE event_id=$1 AND status='accepted'", [i.id]),
      pool.query("SELECT coalesce(sum(fee_cents),0)::bigint AS cents, count(*)::int AS n FROM event_vendors WHERE event_id=$1 AND kind='sponsor' AND status='accepted'", [i.id]),
      pool.query("SELECT coalesce(sum(fee_cents),0)::bigint AS cents, count(*)::int AS n FROM event_vendors WHERE event_id=$1 AND kind <> 'sponsor' AND status='accepted'", [i.id]),
      pool.query("SELECT coalesce(sum(a.fee_cents),0)::bigint AS cents, count(*)::int AS n FROM event_staff_assignments a JOIN event_staff_roles r ON r.id=a.role_id WHERE a.event_id=$1 AND a.status='accepted' AND r.pay_direction='event_pays'", [i.id]),
      pool.query("SELECT coalesce(sum(r.needed - (SELECT count(*) FROM event_staff_assignments a WHERE a.role_id=r.id AND a.status='accepted')), 0)::int AS n FROM event_staff_roles r WHERE r.event_id=$1 AND r.closed_at IS NULL AND r.pay_direction='event_pays'", [i.id]),
    ]);
    const entry_fees = Number(ev.entry_fee_cents) * entries.rows[0].n, sponsorship = Number(sponsors.rows[0].cents), pitch = Number(vendors.rows[0].cents), staffCost = Number(staff.rows[0].cents);
    return {
      currency: ev.currency, entrants: entries.rows[0].n, entry_fees_cents: entry_fees,
      sponsors: { count: sponsors.rows[0].n, cents: sponsorship }, vendors: { count: vendors.rows[0].n, pitch_fees_cents: pitch },
      staff: { confirmed: staff.rows[0].n, cost_cents: staffCost, open_places: open.rows[0].n },
      income_cents: entry_fees + sponsorship + pitch, expected_cost_cents: staffCost, net_cents: entry_fees + sponsorship + pitch - staffCost,
    };
  },
});
