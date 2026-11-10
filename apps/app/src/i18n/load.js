import { locale } from '../locale';
import { languageOf, registerPack } from './core';

// One chunk per language: only the chosen one is downloaded (the web build fetches it before the app starts; native reads it from the bundle).
const LOADERS = {
  hi: () => import('./hi.js'), mr: () => import('./mr.js'), ta: () => import('./ta.js'), te: () => import('./te.js'), ml: () => import('./ml.js'), kn: () => import('./kn.js'),
  bn: () => import('./bn.js'), or: () => import('./or.js'), si: () => import('./si.js'), ur: () => import('./ur.js'), id: () => import('./id.js'),
};

/** Fetches the pack for the chosen language. English is always loaded; if a pack cannot be fetched, the app falls back to English. */
export async function loadLanguage() {
  const code = languageOf(locale);
  if (code === 'en' || !LOADERS[code]) return code;
  try { registerPack(code, (await LOADERS[code]()).default); } catch { /* offline or blocked: English text */ }
  return code;
}
