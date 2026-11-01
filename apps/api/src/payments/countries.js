// Country-wise payment methods. The platform admin switches each method on or off per country (payment_method_countries);
// a country/method with no row is OFF. A method is offered only when it is ON for the country AND a provider that can serve it
// has its keys configured on this server. Every paying module reads its options from here, never from a hard-coded list.
import { one, many } from '../db.js';
import { configuredProviders } from './providers.js';

/** The method families an admin can switch, and the providers able to serve each. */
export const METHODS = {
  card: { providers: ['stripe', 'razorpay'], label: 'Cards' },
  paypal: { providers: ['paypal'], label: 'PayPal' },
  upi: { providers: ['razorpay'], label: 'UPI' },
  netbanking: { providers: ['razorpay'], label: 'Netbanking' },
  wallet: { providers: ['razorpay'], label: 'Wallets' },
};
export const METHOD_KEYS = Object.keys(METHODS);

/** Home country of each currency the platform prices in (used only when nothing better is known about where a payment happens). */
const HOME = {
  INR: 'IN', USD: 'US', GBP: 'GB', AED: 'AE', SAR: 'SA', QAR: 'QA', SGD: 'SG', MYR: 'MY', THB: 'TH', IDR: 'ID', PHP: 'PH', VND: 'VN', JPY: 'JP', KRW: 'KR', CNY: 'CN', HKD: 'HK', TWD: 'TW',
  AUD: 'AU', NZD: 'NZ', CAD: 'CA', CHF: 'CH', SEK: 'SE', NOK: 'NO', DKK: 'DK', PLN: 'PL', CZK: 'CZ', HUF: 'HU', TRY: 'TR', ILS: 'IL', ZAR: 'ZA', NGN: 'NG', KES: 'KE', EGP: 'EG', BRL: 'BR',
  MXN: 'MX', ARS: 'AR', CLP: 'CL', COP: 'CO', PKR: 'PK', BDT: 'BD', LKR: 'LK', NPR: 'NP',
};
/** Single-country currencies only (EUR is shared by many countries, so it answers null and callers then fall back to the real country at checkout). */
export const countryOfCurrency = (cur) => HOME[String(cur ?? '').toUpperCase()] ?? null;
export const isCountry = (x) => /^[A-Z]{2}$/.test(String(x ?? ''));

// ---- cache: the sync "does this need online payment?" decisions made while creating orders read it, so they never block on the DB.
const TTL_MS = 30_000;
let cache = { at: 0, loaded: false, map: new Map() };
let loading = null;
export async function refreshCountryMethods() {
  if (loading) return loading;
  loading = (async () => {
    const rows = await many('SELECT country, method FROM payment_method_countries WHERE enabled');
    const map = new Map();
    for (const r of rows) { if (!map.has(r.country)) map.set(r.country, new Set()); map.get(r.country).add(r.method); }
    cache = { at: Date.now(), loaded: true, map };
  })().finally(() => { loading = null; });
  return loading;
}
const warm = () => { if (!loading && Date.now() - cache.at > TTL_MS) refreshCountryMethods().catch(() => {}); };

/** Providers that can serve at least one of these methods and have keys on this server. */
const providersFor = (methods) => {
  const have = new Set(configuredProviders());
  return [...new Set(methods.flatMap((m) => METHODS[m].providers))].filter((p) => have.has(p));
};

/** Sync check used while a module decides whether something needs online payment. With a country, only that country counts. */
export function paymentsEnabled(country) {
  warm();
  const have = configuredProviders();
  if (!have.length) return false;
  if (!cache.loaded) return true;   // cold start: the gate in startCheckout still enforces the real answer
  const sets = country ? [cache.map.get(country)].filter(Boolean) : [...cache.map.values()];
  return sets.some((s) => providersFor([...s]).length > 0);
}

/** Sync list of providers offered (in this country, or anywhere when none is given) from the cache; same cold-start rule as paymentsEnabled. */
export function enabledProviders(country) {
  warm();
  if (!cache.loaded) return configuredProviders();
  const sets = country ? [cache.map.get(country)].filter(Boolean) : [...cache.map.values()];
  return providersFor([...new Set(sets.flatMap((x) => [...x]))]);
}

/** Authoritative (DB) answer: the methods and providers offered in this country right now. */
export async function enabledMethods(country) {
  if (!isCountry(country)) return { country: null, methods: [], providers: [] };
  const on = (await many('SELECT method FROM payment_method_countries WHERE country=$1 AND enabled', [country])).map((r) => r.method);
  const have = new Set(configuredProviders());
  const methods = on.filter((m) => METHODS[m]?.providers.some((p) => have.has(p)));
  return { country, methods, providers: providersFor(methods) };
}

/** Where a payment happens: an explicit country, else the payer's default address, else the home country of the currency. */
export async function resolveCountry({ country, userId, currency, venueId } = {}) {
  if (isCountry(country)) return country;
  if (venueId) {
    const v = await one("SELECT country FROM addresses WHERE owner_kind='venue' AND owner_id=$1 AND country IS NOT NULL AND archived_at IS NULL ORDER BY is_default DESC LIMIT 1", [venueId]);
    if (v?.country) return v.country;
  }
  if (userId) {
    const a = await one("SELECT country FROM addresses WHERE owner_kind='user' AND owner_id=$1 AND country IS NOT NULL AND archived_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1", [userId]);
    if (a?.country) return a.country;
  }
  return countryOfCurrency(currency);
}

/** The venue a payable thing belongs to, when it has one (so the venue's country, not the payer's, decides). */
export async function venueOfPurpose(c, type, id) {
  const sql = {
    venue_invoice: 'SELECT venue_id FROM invoices WHERE id=$1',
    venue_plan: 'SELECT venue_id FROM user_plans WHERE id=$1',
    pos_sale: 'SELECT venue_id FROM pos_sales WHERE id=$1',
    ticket_order: 'SELECT e.venue_id FROM ticket_orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1',
  }[type];
  if (!sql) return null;
  return (await c.query(sql, [id])).rows[0]?.venue_id ?? null;
}

/** Which family a provider's checkout is recorded under when the person has not narrowed it further. */
export const defaultMethodFor = (provider) => (provider === 'paypal' ? 'paypal' : 'card');
