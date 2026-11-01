// Platform admin: manage the payment provider keys in the app instead of on the server (#694). Write-only: a stored value is never returned,
// only its last four characters and whether the live value comes from the app, the environment or nowhere. Encrypted at rest (crypto.js),
// every change audit-logged (who, which provider and key — never the value). A cleared value is kept as a soft-cleared row.
import { z } from 'zod';
import { cap } from '../registry.js';
import { many, tx } from '../db.js';
import { badRequest } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { mustBePlatformAdmin } from '../platform.js';
import { FIELDS, refreshProviderConfig, sourceOf } from '../payments/provider-config.js';
import { configuredProviders } from '../payments/providers.js';

const TAG = 'Payments';
const provider = z.enum(Object.keys(FIELDS));

const view = (rows) => Object.entries(FIELDS).map(([name, keys]) => ({
  provider: name, ready: configuredProviders().includes(name),
  fields: Object.entries(keys).map(([key, f]) => {
    const row = rows.find((r) => r.provider === name && r.key === key);
    const source = sourceOf(name, key);
    return { key, secret: f.secret, source, last4: source === 'app' ? row?.last4 ?? null : null, updated_at: source === 'app' ? row?.updated_at ?? null : null };
  }),
}));
const load = () => many('SELECT provider, key, last4, updated_at FROM payment_provider_config WHERE value_enc IS NOT NULL AND cleared_at IS NULL');

cap({
  name: 'list_payment_provider_config', method: 'GET', path: '/admin/payments/providers', tag: TAG, auth: ['admin'],
  summary: 'Platform admin only. Which keys each payment provider (Stripe, PayPal, Razorpay) has, where each live value comes from (app, environment or none) and whether the provider is ready. Secrets are never returned, only the last four characters of a value stored in the app.',
  input: z.object({}),
  async handler({ user }) { await mustBePlatformAdmin(user); return { providers: view(await load()) }; },
});

cap({
  name: 'set_payment_provider_key', method: 'POST', path: '/admin/payments/providers/:provider/keys/:key', tag: TAG, auth: ['admin'],
  summary: 'Platform admin only. Store one provider key (for example razorpay key_id, key_secret, webhook_secret). Encrypted at rest and write-only: it can be replaced or cleared but never read back. Takes effect immediately and overrides the environment value. Audit-logged without the value. Pass value null to clear it (the environment value, if any, applies again).',
  input: z.object({ provider, key: z.string().regex(/^[a-z_]{2,40}$/), value: z.string().trim().min(4).max(500).nullable() }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    if (!FIELDS[i.provider][i.key]) throw badRequest(`${i.provider} has no key called ${i.key}`);
    await tx(async (c) => {
      if (i.value === null) {
        await c.query('UPDATE payment_provider_config SET value_enc=NULL, last4=NULL, cleared_at=now(), updated_by=$3, updated_at=now() WHERE provider=$1 AND key=$2', [i.provider, i.key, user.id]);
      } else {
        await c.query(
          `INSERT INTO payment_provider_config(provider, key, value_enc, last4, updated_by, updated_at, cleared_at) VALUES ($1,$2,$3,$4,$5,now(),NULL)
           ON CONFLICT (provider, key) DO UPDATE SET value_enc=EXCLUDED.value_enc, last4=EXCLUDED.last4, updated_by=EXCLUDED.updated_by, updated_at=now(), cleared_at=NULL`,
          [i.provider, i.key, encrypt(i.value, 'payment_provider_config.value'), i.value.slice(-4), user.id]);
      }
      await audit(c, user.id, `payment_provider_key_${i.value === null ? 'clear' : 'set'}:${i.provider}:${i.key}`, 'payment_provider_config', null);
    });
    await refreshProviderConfig();
    return { providers: view(await load()).filter((p) => p.provider === i.provider) };
  },
});
