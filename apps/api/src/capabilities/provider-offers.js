// Physio/doctor offers (#210): time-limited percentage/fixed discounts on services, with a server-authoritative quote.
// One offer per booking (no stacking): the best of the automatic offers and the code the patient entered.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { SERVICE_SELECT } from './provider-services.js';

const TAG = 'Health';
const dt = z.string().datetime({ offset: true });
const LIVE = "(o.valid_from IS NULL OR o.valid_from <= now()) AND (o.valid_to IS NULL OR o.valid_to > now())";

const amountOf = (o, price, currency) => {
  if (o.kind === 'percent') return Math.floor((price * o.percent_bp) / 10000);
  return o.currency === currency ? Math.min(Number(o.amount_cents), price) : 0;
};

/**
 * Pick the offer for a service price. `code` is optional; an entered code that cannot be used is an error, never silently ignored.
 * Counts only redemptions on appointments that still stand. Callers that redeem must hold the provider booking lock (book_appointment does).
 */
export async function bestOffer(c, { providerId, svc, userId, code }) {
  const rows = (await c.query(
    `SELECT o.*, (SELECT count(*)::int FROM provider_offer_redemptions r JOIN appointments a ON a.id=r.appointment_id WHERE r.offer_id=o.id AND a.status NOT IN ('cancelled','expired')) AS used,
            (SELECT count(*)::int FROM provider_offer_redemptions r JOIN appointments a ON a.id=r.appointment_id WHERE r.offer_id=o.id AND r.user_id=$2 AND a.status NOT IN ('cancelled','expired')) AS used_by_user
       FROM provider_offers o WHERE o.provider_id=$1 AND o.archived_at IS NULL AND ${LIVE} AND (o.service_ids = '{}' OR $3::uuid = ANY(o.service_ids)) AND (o.code IS NULL OR upper(o.code) = upper($4))`,
    [providerId, userId, svc.id, code ?? ''])).rows;
  const usable = rows.filter((o) => (o.max_redemptions == null || o.used < o.max_redemptions) && (o.per_user_limit == null || o.used_by_user < o.per_user_limit));
  if (code && !usable.some((o) => o.code && o.code.toUpperCase() === code.toUpperCase())) throw badRequest('That offer code cannot be used for this service');
  let best = null;
  for (const o of usable) {
    const amount = amountOf(o, Number(svc.price_cents), svc.currency);
    if (amount > 0 && (!best || amount > best.amount)) best = { offer: o, amount };
  }
  return best;
}

export const priced = (svc, best) => ({
  service_id: svc.id, currency: svc.currency, list_price_cents: Number(svc.price_cents), discount_cents: best?.amount ?? 0, total_cents: Number(svc.price_cents) - (best?.amount ?? 0),
  offer: best ? { id: best.offer.id, title: best.offer.title } : null, tax_class: svc.tax_class,
});

cap({
  name: 'upsert_provider_offer', method: 'POST', path: '/me/provider-offers', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: create a time-limited percentage or fixed-amount offer (or edit one by `id`). No `code` = applied automatically; with a `code` the patient enters it. `service_ids` limits it to chosen services (empty = all). One offer applies per booking; offers never stack.',
  input: z.object({
    id: id.optional(), title: z.string().trim().min(2).max(120), code: z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/).nullable().optional(),
    kind: z.enum(['percent', 'fixed']), percent: z.number().min(0.01).max(100).optional().describe('percentage off, e.g. 10 for 10%'), amount_cents: z.number().int().min(1).optional(), currency: z.string().length(3).toUpperCase().optional(),
    service_ids: z.array(id).max(50).default([]), valid_from: dt.nullable().optional(), valid_to: dt.nullable().optional(), max_redemptions: z.number().int().min(1).nullable().optional(), per_user_limit: z.number().int().min(1).nullable().optional(),
  }),
  async handler({ user }, i) {
    if (i.kind === 'percent' && i.percent == null) throw badRequest('Enter the percentage');
    if (i.kind === 'fixed' && (i.amount_cents == null || !i.currency)) throw badRequest('Enter the amount and currency');
    if (i.valid_from && i.valid_to && Date.parse(i.valid_to) <= Date.parse(i.valid_from)) throw badRequest('The end must be after the start');
    if (i.service_ids.length) {
      const n = (await one('SELECT count(*)::int AS n FROM provider_services WHERE provider_id=$1 AND id = ANY($2)', [user.id, i.service_ids])).n;
      if (n !== new Set(i.service_ids).size) throw badRequest('Choose your own services');
    }
    const v = [user.id, i.title, i.code ?? null, i.kind, i.kind === 'percent' ? Math.round(i.percent * 100) : null, i.kind === 'fixed' ? i.amount_cents : null, i.kind === 'fixed' ? i.currency : null, i.service_ids, i.valid_from ?? null, i.valid_to ?? null, i.max_redemptions ?? null, i.per_user_limit ?? null];
    try {
      if (i.id) {
        const r = await one('UPDATE provider_offers SET title=$3, code=$4, kind=$5, percent_bp=$6, amount_cents=$7, currency=$8, service_ids=$9, valid_from=$10, valid_to=$11, max_redemptions=$12, per_user_limit=$13 WHERE id=$2 AND provider_id=$1 AND archived_at IS NULL RETURNING *', [v[0], i.id, ...v.slice(1)]);
        if (!r) throw notFound('Offer');
        return r;
      }
      return await one('INSERT INTO provider_offers(provider_id, title, code, kind, percent_bp, amount_cents, currency, service_ids, valid_from, valid_to, max_redemptions, per_user_limit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', v);
    } catch (e) {
      if (e.code === '23505') throw badRequest('You already have an offer with that code');
      throw e;
    }
  },
});

cap({
  name: 'archive_provider_offer', method: 'POST', path: '/me/provider-offers/:id/archive', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: stop an offer. It is kept, and appointments already booked with it keep their discount.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE provider_offers SET archived_at=COALESCE(archived_at, now()) WHERE id=$1 AND provider_id=$2 RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Offer');
    return r;
  },
});

cap({
  name: 'list_my_provider_offers', method: 'GET', path: '/me/provider-offers', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: your offers with how many times each has been used (cancelled appointments do not count).',
  input: z.object({}),
  handler: ({ user }) => many(
    `SELECT o.*, (SELECT count(*)::int FROM provider_offer_redemptions r JOIN appointments a ON a.id=r.appointment_id WHERE r.offer_id=o.id AND a.status NOT IN ('cancelled','expired')) AS used
       FROM provider_offers o WHERE o.provider_id=$1 ORDER BY (o.archived_at IS NOT NULL), o.created_at DESC, o.id`, [user.id]),
});

cap({
  name: 'quote_appointment', method: 'GET', path: '/providers/:id/quote', tag: TAG,
  summary: 'The server-authoritative price of a service for you: list price, the offer that applies (automatic or the `offer_code` you enter), discount and total. Booking with the same inputs charges exactly this.',
  input: z.object({ id, service_id: id, offer_code: z.string().trim().max(30).optional() }),
  async handler({ user }, i) {
    const svc = await one(`${SERVICE_SELECT} WHERE s.id=$1 AND s.provider_id=$2`, [i.service_id, i.id]);
    if (!svc || svc.archived_at || !svc.price_id) throw badRequest('That service is not available');
    return tx(async (c) => priced(svc, await bestOffer(c, { providerId: i.id, svc, userId: user.id, code: i.offer_code })));
  },
});
