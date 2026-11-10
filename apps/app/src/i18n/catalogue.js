// Pure (no React Native) so the API tests can check coverage. Every language here is a standing requirement: a feature that adds
// a string adds its key to en.js and to every language file below, and test/i18n-catalogues.test.js fails if one is missing.
// This file imports every pack, so the app itself imports ./core (and load.js) instead and only fetches the language in use.
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
import { PACKS, registerPack } from './core.js';

export { LANGUAGES, LANGUAGE_CODES, languageOf, languageInfo, translate, hasKey, translateEnum } from './core.js';
export const CATALOGUES = { en, hi, mr, ta, te, ml, kn, bn, or, si, ur, id };
for (const [code, pack] of Object.entries(CATALOGUES)) registerPack(code, pack);
export { PACKS };
