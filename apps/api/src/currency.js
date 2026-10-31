// Currencies a venue can price and invoice in. Amounts are stored in minor units (paise, cents; whole yen for JPY).
// Three-decimal currencies (KWD, BHD, OMR …) are left out of this platform list: card providers need special rounding for them. See THREE_DECIMAL below.
export const CURRENCIES = {
  INR: { name: 'Indian rupee', symbol: '₹', exp: 2 }, USD: { name: 'US dollar', symbol: '$', exp: 2 }, EUR: { name: 'Euro', symbol: '€', exp: 2 }, GBP: { name: 'Pound sterling', symbol: '£', exp: 2 },
  AED: { name: 'UAE dirham', symbol: 'AED', exp: 2 }, SAR: { name: 'Saudi riyal', symbol: 'SAR', exp: 2 }, QAR: { name: 'Qatari riyal', symbol: 'QAR', exp: 2 },
  SGD: { name: 'Singapore dollar', symbol: 'S$', exp: 2 }, MYR: { name: 'Malaysian ringgit', symbol: 'RM', exp: 2 }, THB: { name: 'Thai baht', symbol: '฿', exp: 2 }, IDR: { name: 'Indonesian rupiah', symbol: 'Rp', exp: 2 },
  PHP: { name: 'Philippine peso', symbol: '₱', exp: 2 }, VND: { name: 'Vietnamese dong', symbol: '₫', exp: 0 }, JPY: { name: 'Japanese yen', symbol: '¥', exp: 0 }, KRW: { name: 'South Korean won', symbol: '₩', exp: 0 },
  CNY: { name: 'Chinese yuan', symbol: 'CN¥', exp: 2 }, HKD: { name: 'Hong Kong dollar', symbol: 'HK$', exp: 2 }, TWD: { name: 'New Taiwan dollar', symbol: 'NT$', exp: 2 },
  AUD: { name: 'Australian dollar', symbol: 'A$', exp: 2 }, NZD: { name: 'New Zealand dollar', symbol: 'NZ$', exp: 2 }, CAD: { name: 'Canadian dollar', symbol: 'CA$', exp: 2 },
  CHF: { name: 'Swiss franc', symbol: 'CHF', exp: 2 }, SEK: { name: 'Swedish krona', symbol: 'kr', exp: 2 }, NOK: { name: 'Norwegian krone', symbol: 'kr', exp: 2 }, DKK: { name: 'Danish krone', symbol: 'kr', exp: 2 },
  PLN: { name: 'Polish złoty', symbol: 'zł', exp: 2 }, CZK: { name: 'Czech koruna', symbol: 'Kč', exp: 2 }, HUF: { name: 'Hungarian forint', symbol: 'Ft', exp: 2 }, TRY: { name: 'Turkish lira', symbol: '₺', exp: 2 },
  ILS: { name: 'Israeli shekel', symbol: '₪', exp: 2 }, ZAR: { name: 'South African rand', symbol: 'R', exp: 2 }, NGN: { name: 'Nigerian naira', symbol: '₦', exp: 2 }, KES: { name: 'Kenyan shilling', symbol: 'KSh', exp: 2 },
  EGP: { name: 'Egyptian pound', symbol: 'E£', exp: 2 }, BRL: { name: 'Brazilian real', symbol: 'R$', exp: 2 }, MXN: { name: 'Mexican peso', symbol: 'MX$', exp: 2 }, ARS: { name: 'Argentine peso', symbol: 'AR$', exp: 2 },
  CLP: { name: 'Chilean peso', symbol: 'CL$', exp: 0 }, COP: { name: 'Colombian peso', symbol: 'COL$', exp: 2 }, PKR: { name: 'Pakistani rupee', symbol: 'Rs', exp: 2 }, BDT: { name: 'Bangladeshi taka', symbol: '৳', exp: 2 },
  LKR: { name: 'Sri Lankan rupee', symbol: 'Rs', exp: 2 }, NPR: { name: 'Nepalese rupee', symbol: 'Rs', exp: 2 },
};
/** Three-decimal currencies (1 dinar = 1000 fils). Not in the platform list above (no online card payment), but accepted for service procurement (svc/money.js) and always read and written with three decimals. */
export const THREE_DECIMAL = {
  KWD: { name: 'Kuwaiti dinar', symbol: 'KD', exp: 3 }, BHD: { name: 'Bahraini dinar', symbol: 'BD', exp: 3 }, OMR: { name: 'Omani rial', symbol: 'OMR', exp: 3 },
  JOD: { name: 'Jordanian dinar', symbol: 'JD', exp: 3 }, TND: { name: 'Tunisian dinar', symbol: 'DT', exp: 3 },
};
export const isSupportedCurrency = (c) => Object.hasOwn(CURRENCIES, c);
export const exponent = (c) => THREE_DECIMAL[c]?.exp ?? CURRENCIES[c]?.exp ?? 2;
/** Minor units -> decimal string in major units ('1234' INR paise -> '12.34'; JPY stays whole; KWD '12345' -> '12.345'). Integer arithmetic only, so large amounts stay exact. */
export const toMajor = (minor, c) => {
  const e = exponent(c);
  const n = BigInt(Math.trunc(Number(minor))); // minor units are integers by contract
  const neg = n < 0n; const abs = (neg ? -n : n).toString().padStart(e + 1, '0');
  return `${neg ? '-' : ''}${e ? `${abs.slice(0, -e)}.${abs.slice(-e)}` : abs}`;
};
/** Decimal major-unit string/number -> minor units, or null when it is not a plain amount with at most the currency's decimals ('12.345' USD -> null, not a silent round). */
export const parseMajor = (major, c) => {
  const e = exponent(c);
  const m = /^(-?)(\d{1,15})(?:\.(\d+))?$/.exec(String(major).trim());
  if (!m || (m[3]?.length ?? 0) > e) return null;
  const minor = Number(`${m[2]}${(m[3] ?? '').padEnd(e, '0')}`);
  return Number.isSafeInteger(minor) ? (m[1] ? -minor : minor) : null;
};
/** Decimal major-unit string/number -> minor units; invalid input throws instead of becoming NaN. Providers report amounts like '12.50', so this is exact (no floating point). */
export const fromMajor = (major, c) => {
  const e = exponent(c);
  const exact = parseMajor(major, c);
  if (exact != null) return exact;
  const n = Number(major);
  if (!Number.isFinite(n)) throw new RangeError(`Not an amount: ${major}`);
  return Math.round(n * 10 ** e);
};
/** 'SGD 12.50' / 'KWD 12.345' / 'JPY 1200': code plus exact major units, for notifications, CSV and logs where the app formatter is not available. */
export const formatMinor = (minor, c) => `${c} ${toMajor(minor, c)}`;
