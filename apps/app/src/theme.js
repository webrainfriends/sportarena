import { Platform } from 'react-native';
// SportArena design tokens — dark "night match" look: near-black green canvas, raised charcoal cards, one neon-lime accent.
// Token names are kept stable (pink = primary accent, ink = text, paper = card surface) so every screen inherits the palette.
export const c = {
  bg: '#090D0B', paper: '#131916', ink: '#F2F6F0', mute: '#8B9892', line: '#212A25', on: '#0A1209',
  pink: '#C8FF3D', violet: '#1D2622', cyan: '#5BD6FF', lime: '#C8FF3D', sun: '#FFC933', orange: '#FF7A3D', mint: '#2EE6A6', red: '#FF5A5F', blue: '#C8FF3D',
  pinkSoft: '#222F10', violetSoft: '#1D2622', cyanSoft: '#0F2E38', limeSoft: '#222F10', sunSoft: '#33290D', mintSoft: '#0E3026', orangeSoft: '#3A2012',
};
export const grad = {
  hero: ['#0E1A12', '#14301D', '#1E4A29'],
  sunset: ['#0E1A12', '#17361F', '#25602F'],
  fresh: ['#0E1A12', '#0E3026', '#12674F'],
  candy: ['#131916', '#1D2622', '#131916'],
  night: ['#090D0B', '#14301D'],
};
/** Colours that read as "bright": text on top must be dark. */
export const bright = (col) => [c.lime, c.sun, c.cyan, c.mint, c.orange, c.ink].includes(col);
export const accents = [c.pink, c.violet, c.cyan, c.lime, c.sun, c.orange, c.mint];
export const softOf = { [c.pink]: c.pinkSoft, [c.violet]: c.violetSoft, [c.cyan]: c.cyanSoft, [c.lime]: c.limeSoft, [c.sun]: c.sunSoft, [c.orange]: c.orangeSoft, [c.mint]: c.mintSoft };
export const accentFor = (s = '') => accents[[...String(s)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % accents.length];
export const r = { card: 16, pill: 999, input: 12 };
export const fam = Platform.OS === 'web' ? { fontFamily: '"Inter", "SF Pro Display", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif' } : null;
export const font = { black: { fontWeight: '800' }, bold: { fontWeight: '700' }, med: { fontWeight: '600' } };
export const money = (cents = 0) => `₹${(cents / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
export const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
