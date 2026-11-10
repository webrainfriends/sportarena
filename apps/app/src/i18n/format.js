/** Locale-aware formatting helpers using the Intl API. Import from i18n/index.js. */

/** Format a number in the given BCP 47 locale. */
export function fmtNumber(value, locale, options = {}) {
  try { return new Intl.NumberFormat(locale, options).format(value); }
  catch { return String(value); }
}

/** Format a currency amount in the given BCP 47 locale. */
export function fmtCurrency(value, currency = 'INR', locale, options = {}) {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(value); }
  catch { return `${currency} ${value}`; }
}

/** Format a Date (or timestamp) in the given BCP 47 locale. */
export function fmtDate(value, locale, options = { dateStyle: 'medium' }) {
  try { return new Intl.DateTimeFormat(locale, options).format(value instanceof Date ? value : new Date(value)); }
  catch { return String(value); }
}

/**
 * Locale-aware plural selection.
 * @param {number} n
 * @param {string} locale - BCP 47 tag
 * @param {{ one?: string, other: string, zero?: string, two?: string, few?: string, many?: string }} forms
 */
export function fmtPlural(n, locale, forms) {
  try {
    const rule = new Intl.PluralRules(locale).select(n);
    return (forms[rule] ?? forms.other).replace('{n}', String(n));
  } catch {
    return (n === 1 ? (forms.one ?? forms.other) : forms.other).replace('{n}', String(n));
  }
}
