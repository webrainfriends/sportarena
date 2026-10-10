import { Platform } from 'react-native';
// Language, region, time zone and the date / time / number conventions that go with them.
// We follow the BCP 47 / CLDR conventions through Intl: the locale comes from the person's choice, else the device
// (browser language list or OS setting); if the device only gives a bare language ("en"), the region is inferred from
// the device time zone ("en" + Asia/Kolkata -> en-IN), so day/month order, 12/24-hour clock and digits match the place.
// Times are shown in the device's time zone (venue-local times use the venue's zone, see vtime.js).
// Resolved once at load (screens format at import/render time); changing the choice reloads the app (appearance.js).

export const LOCALE_KEY = 'locale'; // BCP 47 tag, or absent = follow the device

const readPref = (k) => {
  try {
    if (Platform.OS === 'web') return localStorage.getItem(k);
    return require('expo-secure-store').getItem(k);
  } catch { return null; }
};

export const deviceZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

// zone -> default region, for devices that report a language without a region
const REGION = {
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dubai': 'AE', 'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD', 'Asia/Colombo': 'LK', 'Asia/Kathmandu': 'NP',
  'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH', 'Asia/Bangkok': 'TH', 'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Riyadh': 'SA', 'Asia/Tehran': 'IR', 'Asia/Jerusalem': 'IL',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Lisbon': 'PT',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL', 'Europe/Istanbul': 'TR', 'Europe/Moscow': 'RU', 'Europe/Athens': 'GR',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Toronto': 'CA',
  'America/Vancouver': 'CA', 'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'America/Argentina/Buenos_Aires': 'AR', 'America/Bogota': 'CO',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ', 'Africa/Johannesburg': 'ZA',
  'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE', 'Africa/Cairo': 'EG',
};

const valid = (tag) => { try { return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0; } catch { return false; } };

const detect = () => {
  let tag = null;
  try { tag = (Platform.OS === 'web' && navigator.languages?.[0]) || Intl.DateTimeFormat().resolvedOptions().locale; } catch { /* default below */ }
  tag = tag || 'en';
  try {
    const l = new Intl.Locale(tag);
    if (!l.region) { const region = REGION[deviceZone]; if (region) tag = new Intl.Locale(l.language, { region, script: l.script }).toString(); }
  } catch { /* keep tag */ }
  return valid(tag) ? tag : 'en';
};

const chosenLocale = readPref(LOCALE_KEY);
export const locale = chosenLocale && valid(chosenLocale) ? chosenLocale : detect();
export const timeZone = deviceZone; // always the device's own zone; venue times are shown in the venue's zone by vtime.js
export const followsDevice = !chosenLocale;

/** Languages offered in the picker (the app's own text is English for now; dates, times, numbers and currency follow the pick). */
export const LOCALES = [
  'en-IN', 'en-GB', 'en-US', 'en-AU', 'en-CA', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN', 'ur-PK', 'ar-AE', 'ar-SA',
  'fr-FR', 'de-DE', 'es-ES', 'es-MX', 'pt-BR', 'pt-PT', 'it-IT', 'nl-NL', 'sv-SE', 'pl-PL', 'tr-TR', 'ru-RU', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'id-ID', 'th-TH', 'vi-VN',
].filter(valid);
export const localeLabel = (tag) => {
  try { return `${new Intl.DisplayNames([tag], { type: 'language', languageDisplay: 'standard' }).of(tag)} (${tag})`; } catch { return tag; }
};

// ---- formatters: always the chosen locale and zone, never a hard-coded one ----
const d = (v) => (v instanceof Date ? v : new Date(v));
const fmt = (v, opts, tz) => d(v).toLocaleString(locale, { timeZone: tz ?? timeZone, ...opts });
/** 12 Oct 2026 / Oct 12, 2026 … in the person's order. */
export const fmtDate = (v, tz) => fmt(v, { day: 'numeric', month: 'short', year: 'numeric' }, tz);
/** 6:30 PM / 18:30 … in the person's clock. */
export const fmtTime = (v, tz) => fmt(v, { hour: 'numeric', minute: '2-digit' }, tz);
export const fmtDateTime = (v, tz) => fmt(v, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }, tz);
export const fmtNumber = (n, opts) => new Intl.NumberFormat(locale, opts).format(n);
