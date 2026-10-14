// Physio/doctor services & price catalogue (#210). Public-safe: titles, durations, delivery modes and prices only.
// Prices are append-only versions; booking snapshots the version used (see book_appointment in medical.js).
import { z } from 'zod';
import { cap, id, money } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { config } from '../config.js';

const TAG = 'Health';
export const TAX_CLASSES = ['unspecified', 'taxable', 'exempt', 'zero_rated', 'out_of_scope'];
const MODES = z.array(z.enum(['in_person', 'remote'])).min(1).max(2);

/** services with their price in force right now (latest version whose effective_from has passed) */
export const SERVICE_SELECT = `SELECT s.id, s.provider_id, s.title, s.description, s.category, s.delivery_modes, s.duration_min, s.cancellation_policy, s.archived_at,
    p.id AS price_id, p.price_cents, p.currency, p.tax_class, p.effective_from
  FROM provider_services s LEFT JOIN LATERAL (SELECT * FROM provider_service_prices WHERE service_id=s.id AND effective_from <= now() ORDER BY effective_from DESC, created_at DESC LIMIT 1) p ON true`;

const requireProvider = (user) => { if (!user.roles.some((r) => ['physio', 'doctor', 'admin'].includes(r))) throw badRequest('Only physios and doctors can manage services'); };

cap({
  name: 'upsert_provider_service', method: 'POST', path: '/me/provider-services', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: create a service (assessment, follow-up, sports rehab, remote consultation, home visit…) or update one by `id`. Changing the price appends a new price version; existing appointments keep the price they were booked at. Descriptions are public: never put clinical or patient information in them.',
  input: z.object({
    id: id.optional(), title: z.string().trim().min(2).max(120), description: z.string().max(1000).nullable().optional(), category: z.string().trim().min(2).max(40).default('consultation'),
    delivery_modes: MODES.default(['in_person']), duration_min: z.number().int().min(10).max(240).default(30), cancellation_policy: z.string().max(500).nullable().optional(),
    price_cents: money, currency: z.string().length(3).toUpperCase().optional(), tax_class: z.enum(TAX_CLASSES).default('unspecified'),
  }),
  async handler({ user }, i) {
    requireProvider(user);
    return tx(async (c) => {
      let svc;
      if (i.id) {
        svc = (await c.query('SELECT * FROM provider_services WHERE id=$1 AND provider_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
        if (!svc) throw notFound('Service');
        if (svc.archived_at) throw badRequest('This service is archived');
        await c.query('UPDATE provider_services SET title=$2, description=$3, category=$4, delivery_modes=$5, duration_min=$6, cancellation_policy=$7, updated_at=now() WHERE id=$1',
          [svc.id, i.title, i.description ?? null, i.category, i.delivery_modes, i.duration_min, i.cancellation_policy ?? null]);
      } else {
        svc = (await c.query('INSERT INTO provider_services(provider_id, title, description, category, delivery_modes, duration_min, cancellation_policy) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [user.id, i.title, i.description ?? null, i.category, i.delivery_modes, i.duration_min, i.cancellation_policy ?? null])).rows[0];
      }
      const cur = (await c.query('SELECT * FROM provider_service_prices WHERE service_id=$1 ORDER BY effective_from DESC, created_at DESC LIMIT 1', [svc.id])).rows[0];
      const currency = i.currency ?? cur?.currency ?? (await c.query('SELECT currency FROM provider_profiles WHERE user_id=$1', [user.id])).rows[0]?.currency ?? config.payments.currency;
      if (!cur || Number(cur.price_cents) !== i.price_cents || cur.currency !== currency || cur.tax_class !== i.tax_class) {
        await c.query('INSERT INTO provider_service_prices(service_id, price_cents, currency, tax_class) VALUES ($1,$2,$3,$4)', [svc.id, i.price_cents, currency, i.tax_class]);
      }
      return (await c.query(`${SERVICE_SELECT} WHERE s.id=$1`, [svc.id])).rows[0];
    });
  },
});

cap({
  name: 'archive_provider_service', method: 'POST', path: '/me/provider-services/:id/archive', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: archive a service so it can no longer be booked. It is kept, so historical appointments and charges still show it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE provider_services SET archived_at=COALESCE(archived_at, now()), updated_at=now() WHERE id=$1 AND provider_id=$2 RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Service');
    return r;
  },
});

cap({
  name: 'list_my_provider_services', method: 'GET', path: '/me/provider-services', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: your services (active first, then archived) with the price in force and the full price history.',
  input: z.object({}),
  async handler({ user }) {
    const rows = await many(`${SERVICE_SELECT} WHERE s.provider_id=$1 ORDER BY (s.archived_at IS NOT NULL), s.created_at, s.id`, [user.id]);
    const prices = await many('SELECT id, service_id, price_cents, currency, tax_class, effective_from FROM provider_service_prices WHERE service_id = ANY($1) ORDER BY effective_from DESC, created_at DESC', [rows.map((r) => r.id)]);
    return rows.map((r) => ({ ...r, price_history: prices.filter((p) => p.service_id === r.id) }));
  },
});

cap({
  name: 'list_provider_services', method: 'GET', path: '/providers/:id/services', tag: TAG, auth: 'public',
  summary: 'The bookable services of a physio/doctor with their current price. Pass the service `id` to book_appointment as `service_id`.',
  input: z.object({ id }),
  handler: (_, i) => many(`${SERVICE_SELECT} WHERE s.provider_id=$1 AND s.archived_at IS NULL AND p.id IS NOT NULL ORDER BY s.created_at, s.id`, [i.id]),
});
