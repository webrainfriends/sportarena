import { Platform } from 'react-native';
// SportArena design tokens — "Ink & Signal": warm paper canvas, true-black ink, one vermilion signal accent.
// Broadcast-scoreboard feel: big tabular numerals, tight heavy headlines, quiet surfaces.
// Token names are stable (pink = signal accent, ink = text, paper = card, violet = ink-black surface) so every screen inherits it.
export const c = {
  bg: '#F4F2EC', paper: '#FFFFFF', ink: '#0E1014', mute: '#6C7079', line: '#E4E0D6', on: '#FFFFFF',
  pink: '#FF4B1F', violet: '#14171C', cyan: '#2D62F5', lime: '#14935A', sun: '#F2A516', orange: '#FF4B1F', mint: '#14935A', red: '#D92D3A', blue: '#2D62F5',
  pinkSoft: '#FFE8E0', violetSoft: '#ECE9E1', cyanSoft: '#E3EAFE', limeSoft: '#DFF3E8', sunSoft: '#FFF0D0', mintSoft: '#DFF3E8', orangeSoft: '#FFE8E0',
};
export const grad = {
  hero: ['#12151A', '#1A1D26', '#2B1912'],
  sunset: ['#12151A', '#1C1F29', '#3A1B10'],
  fresh: ['#12151A', '#142A22', '#14935A'],
  candy: ['#FFFFFF', '#F4F2EC', '#FFFFFF'],
  night: ['#0E1014', '#1A1D26'],
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
