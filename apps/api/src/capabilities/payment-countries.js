// Platform admin: switch each payment method on or off, country by country (#694). The only place this is decided.
// Everything that takes payment reads the result through payments/countries.js, so one switch governs every module.
import { z } from 'zod';
import { cap } from '../registry.js';
import { many, tx } from '../db.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';
import { configuredProviders } from '../payments/providers.js';
import { METHODS, METHOD_KEYS, refreshCountryMethods } from '../payments/countries.js';

const TAG = 'Payments';
const iso = z.string().length(2).transform((x) => x.toUpperCase()).refine((x) => /^[A-Z]{2}$/.test(x), 'Use a two-letter country code');

/** One row per method family: is it on here, and could this server serve it if it were (provider keys present)? */
const catalogue = (on = new Set()) => {
  const have = new Set(configuredProviders());
  return METHOD_KEYS.map((m) => ({ method: m, label: METHODS[m].label, enabled: on.has(m), providers: METHODS[m].providers, server_ready: METHODS[m].providers.some((p) => have.has(p)) }));
};

cap({
  name: 'list_payment_country_settings', method: 'GET', path: '/admin/payments/countries', tag: TAG, auth: ['admin'],
  summary: 'Platform admin only. Which payment methods (cards, PayPal, UPI, netbanking, wallets) are switched on in each country, and whether this server has the provider keys to serve them. Pass country for one country\'s full method list; without it you get every country that has at least one setting. A country with no setting has everything off.',
  input: z.object({ country: iso.optional() }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    const rows = await many('SELECT country, method, enabled, updated_at FROM payment_method_countries WHERE ($1::text IS NULL OR country=$1) ORDER BY country, method', [i.country ?? null]);
    const by = new Map();
    for (const r of rows) { if (!by.has(r.country)) by.set(r.country, new Set()); if (r.enabled) by.get(r.country).add(r.method); }
    if (i.country && !by.has(i.country)) by.set(i.country, new Set());
    return { providers_configured: configuredProviders(), countries: [...by].map(([country, on]) => ({ country, methods: catalogue(on), enabled_count: on.size })) };
  },
});

cap({
  name: 'set_payment_country_method', method: 'PATCH', path: '/admin/payments/countries/:country/methods/:method', tag: TAG, auth: ['admin'],
  summary: 'Platform admin only. Switch one payment method on or off for one country. Takes effect for every module that takes payment (bookings, classes, tickets, registrations, shop, wallet, memberships and more) and is enforced again when a checkout starts. Existing payments are never changed; turning a method off only stops new checkouts. Audit-logged.',
  input: z.object({ country: iso, method: z.enum(METHOD_KEYS), enabled: z.boolean() }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    await tx(async (c) => {
      await c.query(
        `INSERT INTO payment_method_countries(country, method, enabled, updated_by, updated_at) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (country, method) DO UPDATE SET enabled=EXCLUDED.enabled, updated_by=EXCLUDED.updated_by, updated_at=now()`, [i.country, i.method, i.enabled, user.id]);
      await audit(c, user.id, `payment_method_${i.enabled ? 'enable' : 'disable'}:${i.country}:${i.method}`, 'payment_method_countries', null);
    });
    await refreshCountryMethods();
    const on = new Set((await many('SELECT method FROM payment_method_countries WHERE country=$1 AND enabled', [i.country])).map((r) => r.method));
    return { country: i.country, methods: catalogue(on) };
  },
});
