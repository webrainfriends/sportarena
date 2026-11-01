// Pure (no React Native) so the API tests can check coverage. Every language here is a standing requirement: a feature that adds
// a string adds its key to en.js and to every language file below, and test/i18n-catalogues.test.js fails if one is missing.
import en from './en.js';
import hi from './hi.js';
import mr from './mr.js';
import ta from './ta.js';
import te from './te.js';
import ml from './ml.js';
import kn from './kn.js';
import bn from './bn.js';
import or from './or.js';
import si from './si.js';
import ur from './ur.js';
import id from './id.js';

/** code, default locale tag, name in its own script, script, right-to-left, and whether a native speaker has reviewed the text. */
export const LANGUAGES = [
  { code: 'en', tag: 'en-IN', name: 'English', script: 'Latn', rtl: false, reviewed: true },
  { code: 'hi', tag: 'hi-IN', name: 'हिन्दी', script: 'Deva', rtl: false, reviewed: false },
  { code: 'mr', tag: 'mr-IN', name: 'मराठी', script: 'Deva', rtl: false, reviewed: false },
  { code: 'ta', tag: 'ta-IN', name: 'தமிழ்', script: 'Taml', rtl: false, reviewed: false },
  { code: 'te', tag: 'te-IN', name: 'తెలుగు', script: 'Telu', rtl: false, reviewed: false },
  { code: 'ml', tag: 'ml-IN', name: 'മലയാളം', script: 'Mlym', rtl: false, reviewed: false },
  { code: 'kn', tag: 'kn-IN', name: 'ಕನ್ನಡ', script: 'Knda', rtl: false, reviewed: false },
  { code: 'bn', tag: 'bn-IN', name: 'বাংলা', script: 'Beng', rtl: false, reviewed: false },
  { code: 'or', tag: 'or-IN', name: 'ଓଡ଼ିଆ', script: 'Orya', rtl: false, reviewed: false },
  { code: 'si', tag: 'si-LK', name: 'සිංහල', script: 'Sinh', rtl: false, reviewed: false },
  { code: 'ur', tag: 'ur-PK', name: 'اردو', script: 'Arab', rtl: true, reviewed: false },
  { code: 'id', tag: 'id-ID', name: 'Bahasa Indonesia', script: 'Latn', rtl: false, reviewed: false },
];
export const CATALOGUES = { en, hi, mr, ta, te, ml, kn, bn, or, si, ur, id };
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

/** The language of a BCP 47 tag, or English when we have no pack for it. */
export const languageOf = (tag) => { const code = String(tag ?? '').split(/[-_]/)[0].toLowerCase(); return CATALOGUES[code] ? code : 'en'; };
export const languageInfo = (code) => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];

/** Translate a key into a language, falling back to English (never to the raw key unless it does not exist anywhere). */
export function translate(code, key, params) {
  const text = CATALOGUES[code]?.[key] ?? en[key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k]))) : text;
}
