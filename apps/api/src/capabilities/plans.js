// Memberships and multi-session passes: venues define plans, customers buy them (hosted checkout) and use them on bookings.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { mustFind } from '../helpers.js';
import { mustManage } from '../booking/engine.js';
import { markInvoicePaid } from '../booking/invoices.js';
import { lockPayableInvoice } from '../booking/credits.js';

const TAG = 'Memberships & passes';
const PUBLIC = 'id, venue_id, kind, name, description, price_cents, duration_days, discount_bp, sessions, session_value_cents, valid_days, active';

const planFields = {
  name: z.string().min(2).max(80), description: z.string().max(400).optional(),
  price_cents: z.number().int().min(1).max(1_000_000_000).describe('price in minor units of the venue currency'),
  duration_days: z.number().int().min(1).max(3650).optional().describe('membership: how long it lasts'),
  discount_bp: z.number().int().min(100).max(9000).optional().describe('membership: percentage off every booking at the venue, in basis points (1000 = 10%)'),
  sessions: z.number().int().min(1).max(1000).optional().describe('pass: number of sessions'),
  session_value_cents: z.number().int().min(1).optional().describe('pass: the most one session pays toward a booking (default: price ÷ sessions)'),
  valid_days: z.number().int().min(1).max(3650).optional().describe('pass: usable for this many days after purchase'),
};
const shape = (i) => {
  if (i.kind === 'membership') {
    if (!i.duration_days || !i.discount_bp) throw badRequest('A membership needs duration_days and discount_bp');
    return { duration_days: i.duration_days, discount_bp: i.discount_bp, sessions: null, session_value_cents: null, valid_days: null };
  }
  if (!i.sessions || !i.valid_days) throw badRequest('A pass needs sessions and valid_days');
  return { duration_days: null, discount_bp: null, sessions: i.sessions, valid_days: i.valid_days, session_value_cents: i.session_value_cents ?? Math.max(1, Math.floor(i.price_cents / i.sessions)) };
};

cap({
  name: 'list_venue_plans', method: 'GET', path: '/venues/:id/plans', tag: TAG,
  summary: 'The memberships (a % off every booking for a period) and multi-session passes (prepaid sessions) a venue sells. Buy one with buy_plan.',
  input: z.object({ id }),
  handler: async (_ctx, i) => many(`SELECT ${PUBLIC} FROM venue_plans WHERE venue_id=$1 AND active ORDER BY kind DESC, price_cents`, [i.id]),
});

cap({
  name: 'create_venue_plan', method: 'POST', path: '/venues/:id/plans', tag: TAG, status: 201,
  summary: 'Venue team: sell a membership (kind "membership": duration_days + discount_bp off every booking) or a pass (kind "pass": sessions, valid_days, optional session_value_cents). Priced in the venue currency.',
  input: z.object({ id, kind: z.enum(['membership', 'pass']), ...planFields }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const s = shape(i);
    return one(`INSERT INTO venue_plans(venue_id, kind, name, description, price_cents, duration_days, discount_bp, sessions, session_value_cents, valid_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${PUBLIC}`,
      [i.id, i.kind, i.name, i.description ?? null, i.price_cents, s.duration_days, s.discount_bp, s.sessions, s.session_value_cents, s.valid_days]);
  },
});

cap({
  name: 'update_venue_plan', method: 'PATCH', path: '/venue-plans/:id', tag: TAG,
  summary: 'Venue team: edit a plan or stop selling it (active=false). Changes apply to future purchases only; people who already bought keep the terms they paid for.',
  input: z.object({ id, name: planFields.name.optional(), description: planFields.description, price_cents: planFields.price_cents.optional(), active: z.boolean().optional() }),
  async handler({ user }, i) {
    const p = await mustFind('venue_plans', i.id, 'id, venue_id, sessions');
    await mustManage(user, p.venue_id);
    return one(`UPDATE venue_plans SET name=coalesce($2,name), description=coalesce($3,description), price_cents=coalesce($4,price_cents), active=coalesce($5,active),
                  session_value_cents = CASE WHEN $4::int IS NOT NULL AND kind='pass' THEN greatest(1, floor($4::int / sessions)) ELSE session_value_cents END WHERE id=$1 RETURNING ${PUBLIC}`,
      [i.id, i.name ?? null, i.description ?? null, i.price_cents ?? null, i.active ?? null]);
  },
});

cap({
  name: 'buy_plan', method: 'POST', path: '/venue-plans/:id/buy', tag: TAG, status: 201,
  summary: 'Start buying a membership or pass. Pay it with create_payment (purpose_type "venue_plan", purpose_id = the returned id); it activates when the payment is confirmed. A membership can be renewed in its last 30 days and then starts when the current one ends.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = (await c.query('SELECT p.*, v.currency FROM venue_plans p JOIN venues v ON v.id=p.venue_id WHERE p.id=$1 AND p.active', [i.id])).rows[0];
      if (!p) throw notFound('Plan');
      if (p.kind === 'membership') {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`member:${user.id}:${p.venue_id}`]);
        if ((await c.query("SELECT 1 FROM user_plans WHERE user_id=$1 AND venue_id=$2 AND kind='membership' AND status='awaiting_payment' AND created_at > now() - interval '1 day'", [user.id, p.venue_id])).rowCount)
          throw conflict('You already have a membership waiting for payment at this venue');
        if ((await c.query("SELECT 1 FROM user_plans WHERE user_id=$1 AND venue_id=$2 AND kind='membership' AND status='active' AND expires_at > now() + interval '30 days'", [user.id, p.venue_id])).rowCount)
          throw conflict('You are already a member here — you can renew in the last 30 days');
      }
      return (await c.query(
        `INSERT INTO user_plans(plan_id, venue_id, user_id, kind, name, price_cents, currency, discount_bp, sessions_total, sessions_left, session_value_cents, duration_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11) RETURNING id, kind, name, status, price_cents, currency`,
        [p.id, p.venue_id, user.id, p.kind, p.name, p.price_cents, p.currency, p.discount_bp, p.sessions, p.session_value_cents, p.duration_days ?? p.valid_days])).rows[0];
    });
  },
});

cap({
  name: 'my_plans', method: 'GET', path: '/me/plans', tag: TAG,
  summary: 'Your memberships and passes with what is left (sessions, expiry). Waiting-for-payment ones can still be paid.',
  input: z.object({ venue_id: id.optional(), ...page }),
  handler: ({ user }, i) => many(
    `SELECT up.id, up.venue_id, v.name AS venue_name, v.emoji, up.kind, up.name, up.status, up.price_cents, up.currency, up.discount_bp, up.sessions_total, up.sessions_left, up.session_value_cents, up.starts_at, up.expires_at, up.created_at
       FROM user_plans up JOIN venues v ON v.id=up.venue_id WHERE up.user_id=$1 AND ($2::uuid IS NULL OR up.venue_id=$2) AND up.status <> 'cancelled'
      ORDER BY (up.status = 'active') DESC, (up.status = 'awaiting_payment') DESC, up.created_at DESC LIMIT $3 OFFSET $4`, [user.id, i.venue_id ?? null, i.limit, i.offset]),
});

cap({
  name: 'cancel_unpaid_plan', method: 'DELETE', path: '/me/plans/:id', tag: TAG,
  summary: 'Drop a membership or pass you started buying but have not paid for. Paid plans are not cancellable here (ask the venue).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one("UPDATE user_plans SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='awaiting_payment' RETURNING id", [i.id, user.id]);
    if (!r) throw conflict('Only a plan that is still waiting for payment can be dropped');
    return { ok: true };
  },
});

cap({
  name: 'apply_pass_to_invoice', method: 'POST', path: '/invoices/:id/pass', tag: TAG,
  summary: 'Pay an open invoice with pass sessions at that venue. Each session pays up to its value; as many sessions as needed (and left) are used, soonest-expiring pass first unless user_plan_id names one. Fully covered = paid; otherwise the rest is still due. Pass sessions earn no loyalty points.',
  input: z.object({ id, user_plan_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { inv, due } = await lockPayableInvoice(c, user, i.id);
      const pass = (await c.query(
        `SELECT * FROM user_plans WHERE user_id=$1 AND venue_id=$2 AND kind='pass' AND status='active' AND sessions_left > 0 AND expires_at > now() AND ($3::uuid IS NULL OR id=$3) ORDER BY expires_at, created_at LIMIT 1 FOR UPDATE`,
        [user.id, inv.venue_id, i.user_plan_id ?? null])).rows[0];
      if (!pass) throw conflict(i.user_plan_id ? "That pass can't be used here" : 'You have no pass with sessions left at this venue');
      const n = Math.min(pass.sessions_left, Math.ceil(due / pass.session_value_cents));
      const value = Math.min(due, n * pass.session_value_cents);
      await c.query("UPDATE user_plans SET sessions_left = sessions_left - $2, status = CASE WHEN sessions_left - $2 = 0 THEN 'used_up' ELSE status END WHERE id=$1", [pass.id, n]);
      await c.query("INSERT INTO invoice_credits(invoice_id, user_id, source, amount_cents, user_plan_id, units) VALUES ($1,$2,'pass',$3,$4,$5)", [inv.id, user.id, value, pass.id, n]);
      await c.query('UPDATE invoices SET credits_cents = credits_cents + $2 WHERE id=$1', [inv.id, value]);
      const paid = value === due ? await markInvoicePaid(c, inv.id, { method: 'pass', by: user.id }) : false;
      return { sessions_used: n, applied_cents: value, due_cents: due - value, paid, sessions_left: pass.sessions_left - n };
    });
  },
});

cap({
  name: 'venue_plan_report', method: 'GET', path: '/venues/:id/plans/report', tag: TAG,
  summary: 'Venue team: plans sold and outstanding — active members, passes with sessions left, sessions outstanding, and revenue from plan sales per plan.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const v = await mustFind('venues', i.id, 'currency');
    const plans = await many(
      `SELECT p.id, p.name, p.kind, p.active, count(up.id) FILTER (WHERE up.status IN ('active','used_up','expired'))::int AS sold,
              count(up.id) FILTER (WHERE up.status = 'active')::int AS active_holders, coalesce(sum(up.sessions_left) FILTER (WHERE up.status = 'active'),0)::int AS sessions_outstanding,
              coalesce(sum(up.price_cents) FILTER (WHERE up.status IN ('active','used_up','expired')),0)::bigint AS revenue_cents
         FROM venue_plans p LEFT JOIN user_plans up ON up.plan_id=p.id WHERE p.venue_id=$1 GROUP BY p.id ORDER BY p.created_at`, [i.id]);
    return { currency: v.currency, plans, revenue_cents: plans.reduce((s, p) => s + Number(p.revenue_cents), 0) };
  },
});
