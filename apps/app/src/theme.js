import { Platform } from 'react-native';
// SportArena design tokens — "Fresh Court": a bright, airy light theme. Cool off-white canvas, white cards with
// soft shadows, one confident indigo accent plus a small family of sport colours. Colourful hero panels carry white text.
// Token names are stable (pink = primary accent, ink = text, paper = card, violet = strong slate for dark buttons)
// so every screen inherits the theme.
export const c = {
  bg: '#F5F7FB', paper: '#FFFFFF', ink: '#0F172A', mute: '#64748B', line: '#E6EAF2', on: '#FFFFFF',
  pink: '#4F46E5', violet: '#1E293B', cyan: '#0284C7', lime: '#059669', sun: '#D97706', orange: '#EA580C', mint: '#059669', red: '#E11D48', blue: '#0284C7',
  pinkSoft: '#EEF0FF', violetSoft: '#EEF1F7', cyanSoft: '#E0F2FE', limeSoft: '#DCFCE7', sunSoft: '#FEF3C7', mintSoft: '#DCFCE7', orangeSoft: '#FFEDD5',
};
export const grad = {
  hero: ['#4F46E5', '#7C3AED'],
  sunset: ['#6366F1', '#EC4899'],
  fresh: ['#059669', '#0EA5E9'],
  candy: ['#FFFFFF', '#F5F7FB', '#FFFFFF'],
  night: ['#1E293B', '#334155'],
};
// translucent surfaces for the player hero (white text on a deep gradient)
export const glass = { fill: 'rgba(255,255,255,0.14)', line: 'rgba(255,255,255,0.22)', text: '#FFFFFF', sub: 'rgba(255,255,255,0.72)' };
export const heroGrad = (tone = '#4F46E5') => ['#0B1020', '#1E1B4B', tone];
// one colour family per sport card: [solid, soft tint, deep text-on-tint]
export const sportTones = [
  ['#4F46E5', '#EEF0FF', '#3730A3'], ['#059669', '#DCFCE7', '#047857'], ['#EA580C', '#FFEDD5', '#C2410C'], ['#0284C7', '#E0F2FE', '#075985'],
  ['#DB2777', '#FCE7F3', '#9D174D'], ['#D97706', '#FEF3C7', '#92400E'], ['#7C3AED', '#F3E8FF', '#5B21B6'],
];
export const toneFor = (s = '') => sportTones[[...String(s)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % sportTones.length];
export const accents = [c.pink, c.violet, c.cyan, c.lime, c.sun, c.orange, c.mint];
export const softOf = { [c.pink]: c.pinkSoft, [c.violet]: c.violetSoft, [c.cyan]: c.cyanSoft, [c.lime]: c.limeSoft, [c.sun]: c.sunSoft, [c.orange]: c.orangeSoft, [c.mint]: c.mintSoft };
export const accentFor = (s = '') => accents[[...String(s)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % accents.length];
export const r = { card: 18, pill: 999, input: 12 };
export const fam = Platform.OS === 'web' ? { fontFamily: '"Inter", "SF Pro Display", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif' } : null;
export const font = { black: { fontWeight: '800' }, bold: { fontWeight: '700' }, med: { fontWeight: '600' } };
export const money = (cents = 0) => `₹${(cents / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
export const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
