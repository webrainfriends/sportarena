import { Platform } from 'react-native';
// SportArena design tokens — clean, athletic, professional. Cool-grey canvas, ink-navy type, one electric-blue accent and a volt highlight.
// Token names are kept stable (pink = primary accent, ink = text) so every screen inherits the palette.
export const c = {
  bg: '#F3F5F9', paper: '#FFFFFF', ink: '#0B1426', mute: '#5F6B83', line: '#E2E7F0',
  pink: '#2457F5', violet: '#0F1B3D', cyan: '#27B5E6', lime: '#C8F31D', sun: '#FFC933', orange: '#FF6B2C', mint: '#12B886', red: '#E5484D', blue: '#2457F5',
  pinkSoft: '#E8EEFF', violetSoft: '#E9ECF5', cyanSoft: '#E3F6FD', limeSoft: '#F2FBCB', sunSoft: '#FFF4D1', mintSoft: '#DDF7EE', orangeSoft: '#FFEBDF',
};
export const grad = {
  hero: ['#0B1426', '#13307F', '#2457F5'],
  sunset: ['#0F1B3D', '#1A3FB8', '#2457F5'],
  fresh: ['#0B1426', '#0E6B58', '#12B886'],
  candy: ['#E8EEFF', '#E9ECF5', '#E3F6FD'],
  night: ['#0B1426', '#13307F'],
};
export const accents = [c.pink, c.violet, c.cyan, c.lime, c.sun, c.orange, c.mint];
export const softOf = { [c.pink]: c.pinkSoft, [c.violet]: c.violetSoft, [c.cyan]: c.cyanSoft, [c.lime]: c.limeSoft, [c.sun]: c.sunSoft, [c.orange]: c.orangeSoft, [c.mint]: c.mintSoft };
export const accentFor = (s = '') => accents[[...String(s)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % accents.length];
export const r = { card: 16, pill: 999, input: 12 };
export const fam = Platform.OS === 'web' ? { fontFamily: '"Inter", "SF Pro Display", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif' } : null;
export const font = { black: { fontWeight: '800' }, bold: { fontWeight: '700' }, med: { fontWeight: '600' } };
export const money = (cents = 0) => `₹${(cents / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
export const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
