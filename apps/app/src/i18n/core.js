// The light, always-loaded part of the translations: language metadata, the pack registry and t()'s lookup. Only English is bundled here;
// every other pack is a separate chunk that load.js fetches for the chosen language before the app starts (the packs are ~1.3 MB each).
// catalogue.js imports every pack (for the API tests, which check coverage) and registers them here.
import en from './en.js';

/**
 * code, default locale tag, name in its own script, script, right-to-left, whether a native speaker has reviewed the text,
 * and optional reviewMeta recording who reviewed it and when.
 * reviewed: true requires reviewMeta.reviewer to be non-null; i18n-catalogues.test.js enforces this.
 */
export const LANGUAGES = [
  { code: 'en', tag: 'en-IN', name: 'English', script: 'Latn', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'hi', tag: 'hi-IN', name: 'हिन्दी', script: 'Deva', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'mr', tag: 'mr-IN', name: 'मराठी', script: 'Deva', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'ta', tag: 'ta-IN', name: 'தமிழ்', script: 'Taml', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'te', tag: 'te-IN', name: 'తెలుగు', script: 'Telu', rtl: false, reviewed: true,
    reviewMeta: { reviewer: 'rrajas1978@icloud.com', reviewedAt: '2026-11-07', scope: 'full' } },
  { code: 'ml', tag: 'ml-IN', name: 'മലയാളം', script: 'Mlym', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'kn', tag: 'kn-IN', name: 'ಕನ್ನಡ', script: 'Knda', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'bn', tag: 'bn-IN', name: 'বাংলা', script: 'Beng', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'or', tag: 'or-IN', name: 'ଓଡ଼ିଆ', script: 'Orya', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'si', tag: 'si-LK', name: 'සිංහල', script: 'Sinh', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'ur', tag: 'ur-PK', name: 'اردو', script: 'Arab', rtl: true, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
  { code: 'id', tag: 'id-ID', name: 'Bahasa Indonesia', script: 'Latn', rtl: false, reviewed: false,
    reviewMeta: { reviewer: null, reviewedAt: null, scope: 'machine-drafted' } },
];
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

/** Packs that are loaded right now: English always, the chosen language once load.js has fetched it. */
export const PACKS = { en };
export const registerPack = (code, pack) => { PACKS[code] = pack; };

/** The language of a BCP 47 tag, or English when we have no pack for it. */
export const languageOf = (tag) => { const code = String(tag ?? '').split(/[-_]/)[0].toLowerCase(); return LANGUAGE_CODES.includes(code) ? code : 'en'; };
export const languageInfo = (code) => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];

/** Translate a key into a language, falling back to English (never to the raw key unless it does not exist anywhere). */
export function translate(code, key, params) {
  const text = PACKS[code]?.[key] ?? en[key] ?? key;
  // some packs were written with {{name}}: both spellings fill the same way, so a stray brace never reaches the screen
  return params ? text.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (m, a, b) => (params[a ?? b] === undefined ? m : String(params[a ?? b]))) : text;
}

/** True when a key exists in the English pack (used to fall back gracefully for values the server sends that we have no key for). */
export const hasKey = (key) => key in en;
/** An enum value from the server (left_early, skill_drill…) as readable text: the translated enum.<value> key when we have one, else the value humanised. */
export function translateEnum(code, value) {
  const key = `enum.${String(value ?? '').toLowerCase().replace(/[\s-]+/g, '_')}`;
  if (hasKey(key)) return translate(code, key);
  return String(value ?? '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
}
