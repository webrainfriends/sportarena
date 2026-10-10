import { Appearance, Platform } from 'react-native';
import { locale } from './locale';
// SportArena design tokens — "Fresh Court": a bright, airy light theme. Cool off-white canvas, white cards with
// soft shadows, one confident indigo accent plus a small family of sport colours. Colourful hero panels carry white text.
// Token names are stable (pink = primary accent, ink = text, paper = card, violet = strong slate for dark buttons)
// so every screen inherits the theme.
// Light / dark: resolved once, synchronously, when the app loads (stored choice, else the OS setting), because
// screens read these tokens at import time. Changing the choice stores it and reloads the app (see appearance.js).
const LIGHT = {
  bg: '#F5F7FB', paper: '#FFFFFF', ink: '#0F172A', mute: '#64748B', line: '#E6EAF2', on: '#FFFFFF', inkOn: '#FFFFFF',
  pink: '#4F46E5', violet: '#1E293B', cyan: '#0284C7', lime: '#059669', sun: '#D97706', orange: '#EA580C', mint: '#059669', red: '#E11D48', blue: '#0284C7',
  pinkSoft: '#EEF0FF', violetSoft: '#EEF1F7', cyanSoft: '#E0F2FE', limeSoft: '#DCFCE7', sunSoft: '#FEF3C7', mintSoft: '#DCFCE7', orangeSoft: '#FFEDD5', redSoft: '#FFE4E6',
};
const DARK = {
  bg: '#0B1020', paper: '#151B2E', ink: '#E6EAF5', mute: '#93A0B8', line: '#263049', on: '#FFFFFF', inkOn: '#0B1020',
  pink: '#818CF8', violet: '#334263', cyan: '#38BDF8', lime: '#34D399', sun: '#FBBF24', orange: '#FB923C', mint: '#34D399', red: '#FB7185', blue: '#38BDF8',
  pinkSoft: '#22275A', violetSoft: '#1D2640', cyanSoft: '#0E3247', limeSoft: '#0F3A2C', sunSoft: '#3D3012', mintSoft: '#0F3A2C', orangeSoft: '#42250F', redSoft: '#4A1A28',
};
export const THEME_KEY = 'theme'; // 'system' | 'light' | 'dark'
const storedMode = () => {
  try {
    if (Platform.OS === 'web') return localStorage.getItem(THEME_KEY);
    return require('expo-secure-store').getItem(THEME_KEY); // sync read, so the first paint is already themed
  } catch { return null; }
};
export const themeMode = (() => { const m = storedMode(); return m === 'light' || m === 'dark' ? m : 'system'; })();
export const systemScheme = () => {
  try {
    if (Platform.OS === 'web') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
  } catch { return 'light'; }
};
export const scheme = themeMode === 'system' ? systemScheme() : themeMode;
export const dark = scheme === 'dark';
export const c = dark ? DARK : LIGHT;
export const grad = {
  hero: ['#4F46E5', '#7C3AED'],
  sunset: ['#6366F1', '#EC4899'],
  fresh: ['#059669', '#0EA5E9'],
  candy: dark ? ['#151B2E', '#0B1020', '#151B2E'] : ['#FFFFFF', '#F5F7FB', '#FFFFFF'],
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
export const money = (cents = 0) => `₹${(cents / 100).toLocaleString(locale, { maximumFractionDigits: 0 })}`;
export const when = (iso) => new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const day = (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
