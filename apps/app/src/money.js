// The one amount-plus-currency formatter (and amount parser) for the whole app, bound to the person's locale. See money-core.js for the rules.
import { locale } from './locale';
import { formatMoneyIn, minorDigits, parseAmount, toMajorText } from './money-core';

export { minorDigits, parseAmount, toMajorText };
/** Minor units + the currency of the record they belong to -> "S$25.50", "¥5,000", "KWD 12.345". No currency => a bare number, never a guessed symbol. */
export const formatMoney = (minor, currency, o) => formatMoneyIn(locale, minor, currency, o);
