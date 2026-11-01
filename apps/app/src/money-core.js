// The amount-plus-currency formatter and parser, pure (no React Native) so it is unit-tested; money.js binds it to the app locale.
// Amounts are integers in minor units, always shown with the currency they were charged in: INR 1,200 · S$25.50 · ¥5,000 · KWD 12.345.
// Precision comes from the currency (0, 2 or 3 decimals), the separators and symbol position from the person's locale; the currency itself never
// comes from the locale, so an invoice reads the same whatever language or region the viewer picks. Totals are never added across currencies.

const THREE = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];
const ZERO = ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
const valid = (c) => typeof c === 'string' && /^[A-Za-z]{3}$/.test(c);

/** Decimal places of a currency's minor unit (JPY 0, SGD/INR 2, KWD 3). Intl knows it; the lists cover engines whose data is older. */
export const minorDigits = (currency) => {
  const code = String(currency ?? '').toUpperCase();
  if (THREE.includes(code)) return 3;
  if (ZERO.includes(code)) return 0;
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits; } catch { return 2; }
};

const num = (minor) => (typeof minor === 'bigint' ? Number(minor) : typeof minor === 'string' && minor.trim() !== '' ? Number(minor) : minor);

/**
 * @param {number|string|bigint|null|undefined} minor amount in minor units (the API sends bigint amounts as strings)
 * @param {string} currency ISO 4217 code of the record the amount belongs to
 * @param {{ compact?: boolean, signed?: boolean }} [o] `compact` drops ".00" on whole amounts; `signed` shows + / − for non-zero amounts
 * A missing or unknown currency is shown as a bare number with no symbol rather than guessed; a missing amount is an em dash.
 */
export function formatMoneyIn(locale, minor, currency, { compact = true, signed = false } = {}) {
  const n = num(minor);
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const d = minorDigits(currency);
  const major = n / 10 ** d;
  const frac = compact && Number.isInteger(n / 10 ** d) ? 0 : d;
  let out;
  if (valid(currency)) {
    try { out = new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: frac, maximumFractionDigits: d }).format(Math.abs(major)); } catch { out = `${currency.toUpperCase()} ${Math.abs(major).toFixed(d)}`; }
  } else out = new Intl.NumberFormat(locale, { minimumFractionDigits: frac, maximumFractionDigits: d }).format(Math.abs(major));
  const sign = major < 0 ? '−' : signed && major > 0 ? '+' : '';
  return `${sign}${out}`;
}

/** What to type for an amount: the major-unit text of a minor-unit value, with the currency's own decimals ('1250' SGD -> '12.50', KWD '12345' -> '12.345'). */
export const toMajorText = (minor, currency) => {
  const n = num(minor);
  if (!Number.isFinite(n)) return '';
  return (n / 10 ** minorDigits(currency)).toFixed(minorDigits(currency));
};

/** Typed major-unit text -> minor units, or null when it is not an amount this currency can hold (too many decimals, not a number, too large). Accepts "1,200.50" and "1 200,50". */
export function parseAmount(text, currency) {
  const d = minorDigits(currency);
  let t = String(text ?? '').trim().replace(/\s/g, '');
  if (!t) return null;
  const dots = (t.match(/\./g) ?? []).length, commas = (t.match(/,/g) ?? []).length;
  const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
  // both marks present: the last one is the decimal mark. One kind only: repeated = thousands; a single "." is a decimal mark (too many decimals is then refused,
  // never rounded); a single "," is a decimal mark only when 1..d digits follow ("12,5"), otherwise it groups thousands ("1,200").
  let decAt = -1;
  if (dots && commas) decAt = Math.max(lastDot, lastComma);
  else if (dots === 1) decAt = lastDot;
  else if (commas === 1 && t.length - lastComma - 1 >= 1 && t.length - lastComma - 1 <= Math.min(d, 2)) decAt = lastComma;
  t = decAt >= 0 ? `${t.slice(0, decAt).replace(/[.,]/g, '')}.${t.slice(decAt + 1)}` : t.replace(/[.,]/g, '');
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(t);
  if (!m || (m[2]?.length ?? 0) > d) return null;
  const minor = Number(`${m[1]}${(m[2] ?? '').padEnd(d, '0')}`);
  return Number.isSafeInteger(minor) ? minor : null;
}
