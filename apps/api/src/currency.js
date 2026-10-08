// Currencies a venue can price and invoice in. Amounts are stored in minor units (paise, cents; whole yen for JPY).
// Three-decimal currencies (KWD, BHD, OMR …) are left out: card providers need special rounding for them.
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
export const isSupportedCurrency = (c) => Object.hasOwn(CURRENCIES, c);
export const exponent = (c) => CURRENCIES[c]?.exp ?? 2;
/** Minor units -> decimal string in major units ('1234' INR paise -> '12.34'; JPY stays whole). */
export const toMajor = (minor, c) => (minor / 10 ** exponent(c)).toFixed(exponent(c));
/** Decimal major-unit string/number -> minor units. */
export const fromMajor = (major, c) => Math.round(Number(major) * 10 ** exponent(c));
