// Payment provider keys that the platform admin manages in the app (#694). Stored encrypted (payment_provider_config.value_enc); the environment is the
// fallback so existing deployments keep working untouched. providers.js reads the merged result synchronously from this in-memory copy, which is
// reloaded at start-up and whenever the admin changes a value. Nothing here ever returns a stored secret to a client.
import { many } from '../db.js';
import { decrypt } from '../crypto.js';
import { config } from '../config.js';

/** Which keys each provider takes: where they live in config.payments, and whether the value is a secret (masked everywhere). */
export const FIELDS = {
  stripe: { secret_key: { path: ['stripe', 'secretKey'], secret: true }, webhook_secret: { path: ['stripe', 'webhookSecret'], secret: true } },
  paypal: { client_id: { path: ['paypal', 'clientId'], secret: false }, secret: { path: ['paypal', 'secret'], secret: true }, webhook_id: { path: ['paypal', 'webhookId'], secret: false } },
  razorpay: { key_id: { path: ['razorpay', 'keyId'], secret: false }, key_secret: { path: ['razorpay', 'keySecret'], secret: true }, webhook_secret: { path: ['razorpay', 'webhookSecret'], secret: true } },
};

let stored = new Map();   // `${provider}.${key}` -> decrypted value
export async function refreshProviderConfig() {
  const rows = await many('SELECT id, provider, key, value_enc FROM payment_provider_config WHERE value_enc IS NOT NULL AND cleared_at IS NULL');
  const next = new Map();
  for (const r of rows) { try { next.set(`${r.provider}.${r.key}`, decrypt(r.value_enc, 'payment_provider_config.value')); } catch { /* an unreadable value is ignored, the environment value (if any) is used */ } }
  stored = next;
}

const envValue = (provider, key) => FIELDS[provider][key].path.reduce((o, k) => o?.[k], config.payments);
/** The live value: the admin's stored value, else the environment's. */
export const valueOf = (provider, key) => stored.get(`${provider}.${key}`) ?? envValue(provider, key);
export const sourceOf = (provider, key) => (stored.has(`${provider}.${key}`) ? 'app' : envValue(provider, key) ? 'environment' : 'none');
