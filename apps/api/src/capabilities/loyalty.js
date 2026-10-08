// Venue loyalty points: balances, history, spending on invoices, venue-side summary and goodwill bonuses.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { audit, mustFind } from '../helpers.js';
import { mustManage } from '../booking/engine.js';
import { markInvoicePaid } from '../booking/invoices.js';
import { lockPayableInvoice } from '../booking/credits.js';
import { availablePoints, spendPoints } from '../booking/loyalty.js';
import { notify } from '../notify.js';
import { toMajor } from '../currency.js';

const TAG = 'Loyalty';

cap({
  name: 'get_loyalty', method: 'GET', path: '/me/loyalty', tag: TAG,
  summary: 'Your loyalty points, per venue: points, what they are worth (1 point = 1 minor unit of the venue currency), and what expires within 30 days. Venues give back a percentage of what you pay as points; spend them on a later booking at the same venue.',
  handler: ({ user }) => many(
    `SELECT v.id AS venue_id, v.name AS venue_name, v.emoji, v.currency, v.loyalty_earn_bp, sum(l.remaining)::int AS points,
            coalesce(sum(l.remaining) FILTER (WHERE l.expires_at < now() + interval '30 days'), 0)::int AS expiring_soon, min(l.expires_at) AS next_expiry
       FROM loyalty_lots l JOIN venues v ON v.id=l.venue_id WHERE l.user_id=$1 AND l.remaining > 0 AND l.expires_at > now() GROUP BY v.id ORDER BY points DESC`, [user.id]),
});

cap({
  name: 'loyalty_history', method: 'GET', path: '/me/loyalty/history', tag: TAG, summary: 'Your points statement (earned, redeemed, restored, clawed back, expired), newest first.',
  input: z.object({ venue_id: id.optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT e.id, e.venue_id, v.name AS venue_name, e.delta, e.kind, e.note, e.created_at FROM loyalty_events e JOIN venues v ON v.id=e.venue_id
      WHERE e.user_id=$1 AND ($2::uuid IS NULL OR e.venue_id=$2) ORDER BY e.created_at DESC, e.id LIMIT $3 OFFSET $4`, [user.id, i.venue_id ?? null, i.limit, i.offset]),
});

cap({
  name: 'apply_points_to_invoice', method: 'POST', path: '/invoices/:id/points', tag: TAG,
  summary: "Pay (part of) an open invoice with your points at that venue. Points can cover up to the venue's redemption cap of one invoice; points paid this way earn no new points. If they cover everything the invoice is paid; otherwise the remainder is still due.",
  input: z.object({ id, points: z.number().int().min(1).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { inv, due } = await lockPayableInvoice(c, user, i.id);
      const venue = (await c.query('SELECT loyalty_earn_bp, loyalty_max_redeem_bp, currency FROM venues WHERE id=$1', [inv.venue_id])).rows[0];
      const cap_ = Math.floor((inv.total_cents * venue.loyalty_max_redeem_bp) / 10000);
      const have = await availablePoints(c, user.id, inv.venue_id);
      if (have <= 0) throw conflict("You have no points at this venue");
      const pointsAlready = Number((await c.query("SELECT coalesce(sum(amount_cents - returned_cents),0) AS n FROM invoice_credits WHERE invoice_id=$1 AND source='points'", [inv.id])).rows[0].n);
      const room = Math.max(0, cap_ - pointsAlready);
      const use = Math.min(due, have, room, i.points ?? Infinity);
      if (use <= 0) throw conflict(`Points can pay at most ${venue.loyalty_max_redeem_bp / 100}% of one invoice`);
      const taken = await spendPoints(c, user.id, inv.venue_id, use, inv.id, `Invoice ${inv.number}`);
      if (taken <= 0) throw conflict('Those points are no longer available');
      await c.query("INSERT INTO invoice_credits(invoice_id, user_id, source, amount_cents) VALUES ($1,$2,'points',$3)", [inv.id, user.id, taken]);
      await c.query('UPDATE invoices SET credits_cents = credits_cents + $2 WHERE id=$1', [inv.id, taken]);
      const paid = taken === due ? await markInvoicePaid(c, inv.id, { method: 'points', by: user.id }) : false;
      return { points_used: taken, value_cents: taken, due_cents: due - taken, paid, points_left: have - taken, currency: venue.currency };
    });
  },
});

cap({
  name: 'venue_loyalty', method: 'GET', path: '/venues/:id/loyalty', tag: TAG,
  summary: 'The venue team\'s view of its loyalty programme: points issued, redeemed, restored, clawed back and expired in a date range, plus what is outstanding right now (members, points, and the money value it represents).',
  input: z.object({ id, from: z.string().date().optional(), to: z.string().date().optional() }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const v = await mustFind('venues', i.id, 'currency, loyalty_earn_bp, loyalty_expiry_months, loyalty_max_redeem_bp');
    const [flow, out] = await Promise.all([
      one(`SELECT coalesce(sum(delta) FILTER (WHERE kind IN ('earn','bonus')),0)::int AS issued, coalesce(-sum(delta) FILTER (WHERE kind='redeem'),0)::int AS redeemed,
                  coalesce(sum(delta) FILTER (WHERE kind='restore'),0)::int AS restored, coalesce(-sum(delta) FILTER (WHERE kind='clawback'),0)::int AS clawed_back, coalesce(-sum(delta) FILTER (WHERE kind='expire'),0)::int AS expired
             FROM loyalty_events WHERE venue_id=$1 AND ($2::date IS NULL OR created_at >= $2) AND ($3::date IS NULL OR created_at < $3::date + 1)`, [i.id, i.from ?? null, i.to ?? null]),
      one("SELECT count(DISTINCT user_id)::int AS members, coalesce(sum(remaining),0)::int AS points FROM loyalty_lots WHERE venue_id=$1 AND remaining > 0 AND expires_at > now()", [i.id]),
    ]);
    return { currency: v.currency, programme: { earn_bp: v.loyalty_earn_bp, expiry_months: v.loyalty_expiry_months, max_redeem_bp: v.loyalty_max_redeem_bp, enabled: v.loyalty_earn_bp > 0 }, ...flow, outstanding: { members: out.members, points: out.points, value_cents: out.points } };
  },
});

cap({
  name: 'grant_loyalty_points', method: 'POST', path: '/venues/:id/loyalty/bonus', tag: TAG,
  summary: 'Venue team goodwill: give a customer bonus points (e.g. an apology or a promotion). Needs a note; audit-logged. Points are the venue\'s own liability, worth 1 minor unit each.',
  input: z.object({ id, user_handle: z.string().min(3).max(24), points: z.number().int().min(1).max(1_000_000), note: z.string().min(3).max(200) }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const venue = await mustFind('venues', i.id, 'id, name, currency, loyalty_expiry_months');
    const target = await one('SELECT id FROM users WHERE handle=$1', [i.user_handle.toLowerCase()]);
    if (!target) throw notFound('User');
    return tx(async (c) => {
      await c.query("INSERT INTO loyalty_lots(user_id, venue_id, kind, points, remaining, expires_at) VALUES ($1,$2,'bonus',$3,$3, now() + make_interval(months => $4))", [target.id, venue.id, i.points, venue.loyalty_expiry_months]);
      await c.query("INSERT INTO loyalty_events(user_id, venue_id, delta, kind, note) VALUES ($1,$2,$3,'bonus',$4)", [target.id, venue.id, i.points, i.note]);
      await audit(c, user.id, 'grant_loyalty_points', 'venues', venue.id);
      await notify(c, target.id, { kind: 'loyalty_earned', title: `${venue.name} gave you ${i.points} bonus points`, body: `${i.note} — worth ${venue.currency} ${toMajor(i.points, venue.currency)} at ${venue.name}.`, data: { venue_id: venue.id } });
      return { ok: true, points: i.points };
    });
  },
});
