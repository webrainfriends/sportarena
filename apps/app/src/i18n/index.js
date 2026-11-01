import { I18nManager, Platform } from 'react-native';
import { locale } from '../locale';
import { LANGUAGES, languageInfo, languageOf, translate } from './catalogue';

// The language follows the chosen locale (account sheet) or the device, resolved once at load like the theme and locale.
export const language = languageOf(locale);
export const languageMeta = languageInfo(language);
export const isRtl = languageMeta.rtl;
export { LANGUAGES };

/** t('account.logout') or t('welcome.hello', { name }) — falls back to English for anything not yet translated. */
export const t = (key, params) => translate(language, key, params);

// Right-to-left (Urdu): web gets dir/lang on <html>; native flips the layout and applies it on the next launch (the app reloads when the language changes).
if (Platform.OS === 'web') {
  try { document.documentElement.lang = language; document.documentElement.dir = isRtl ? 'rtl' : 'ltr'; } catch { /* no DOM */ }
} else {
  try { I18nManager.allowRTL(true); if (I18nManager.isRTL !== isRtl) I18nManager.forceRTL(isRtl); } catch { /* applies next launch */ }
}
