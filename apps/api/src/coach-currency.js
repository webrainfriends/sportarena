// Coach money follows the coach's country: the country of their default address (the same source payments use) decides the currency
// they price in. Falls back to the platform currency when no country is set or its currency is not one the platform supports.
// A rate card stores the currency it was priced in; sessions, classes, packages and subscriptions booked from it inherit that currency.
import { one, many } from './db.js';
import { config } from './config.js';
import { CURRENCIES } from './currency.js';
import { countryOfCurrency } from './payments/countries.js';

const EURO = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
const BY_COUNTRY = { ...Object.fromEntries(Object.keys(CURRENCIES).map((cur) => [countryOfCurrency(cur), cur]).filter(([cc]) => cc)), ...Object.fromEntries(EURO.map((cc) => [cc, 'EUR'])) };
/** The currency people in this country use, when the platform prices in it (else null). */
export const currencyOfCountry = (cc) => BY_COUNTRY[String(cc ?? '').toUpperCase()] ?? null;
export const platformCurrency = () => config.payments.currency;
/** What a stored card/commitment currency means: NULL is the platform currency it was priced in before currencies were recorded. */
export const effective = (cur) => cur ?? platformCurrency();

const COUNTRY_SQL = "SELECT DISTINCT ON (owner_id) owner_id, country FROM addresses WHERE owner_kind='user' AND owner_id = ANY($1::uuid[]) AND country IS NOT NULL AND archived_at IS NULL ORDER BY owner_id, is_default DESC, created_at";

/** Currency for each person id, as a Map. One query for any number of coaches. */
export async function currenciesFor(ids, run = many) {
  const list = [...new Set(ids)];
  const rows = list.length ? await run(COUNTRY_SQL, [list]) : [];
  const out = new Map(list.map((x) => [x, platformCurrency()]));
  for (const r of rows) { const cur = currencyOfCountry(r.country); if (cur) out.set(r.owner_id, cur); }
  return out;
}
export const coachCurrency = async (userId) => (await currenciesFor([userId])).get(userId);
