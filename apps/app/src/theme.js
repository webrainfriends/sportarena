import { Appearance, Platform } from 'react-native';
import { locale } from './locale';
import { HAS_SPORT_THEME, sportTheme } from './sport-theme';
// Gotmygame design tokens — "Moon dust": a bright, airy light theme. Lavender-white canvas, white cards with
// soft shadows, one confident indigo accent plus a small family of sport colours. Colourful hero panels carry white text.
// Token names are stable (pink = primary accent, ink = text, paper = card, violet = strong slate for dark buttons)
// so every screen inherits the theme.
// Light / dark: resolved once, synchronously, when the app loads (stored choice, else the OS setting), because
// screens read these tokens at import time. Changing the choice stores it and reloads the app (see appearance.js).
// Palette: Moon dust (#D3D3FF, #CEB5FF, #8EC1DE, #80A8FF) with deep indigo shades for ink and buttons. Light mode puts the dark shades on a pale canvas, dark mode flips them.
export const palette = { p0: '#14123A', p1: '#1D1A52', p2: '#2A2773', p3: '#4A5FD9', p4: '#80A8FF', p5: '#D3D3FF' };
const LIGHT = {
  bg: '#EEEEFF', paper: '#FFFFFF', ink: '#14123A', mute: '#5A5C8A', line: '#CDCBF5', on: '#FFFFFF', inkOn: '#FFFFFF', onAccent: '#FFFFFF',
  pink: '#4A5FD9', violet: '#2A2773', cyan: '#3F8DB5', lime: '#2F8F5F', sun: '#D97706', orange: '#EA580C', mint: '#3E9A82', red: '#E11D48', blue: '#3F8DB5',
  pinkSoft: '#D3D3FF', violetSoft: '#E4E2FF', cyanSoft: '#D8EBF5', limeSoft: '#D9F0E1', sunSoft: '#FEF3C7', mintSoft: '#DDF1EA', orangeSoft: '#FFEDD5', redSoft: '#FFE4E6',
};
const DARK = {
  bg: '#14123A', paper: '#1D1A52', ink: '#D3D3FF', mute: '#A3A6D6', line: '#2A2773', on: '#FFFFFF', inkOn: '#14123A', onAccent: '#14123A',
  pink: '#80A8FF', violet: '#4A5FD9', cyan: '#8EC1DE', lime: '#5FD39A', sun: '#FBBF24', orange: '#FB923C', mint: '#7ADBC4', red: '#FB7185', blue: '#8EC1DE',
  pinkSoft: '#2A2773', violetSoft: '#26235F', cyanSoft: '#17324A', limeSoft: '#0F3A2C', sunSoft: '#3D3012', mintSoft: '#0F3D35', orangeSoft: '#42250F', redSoft: '#4A1A28',
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
  hero: ['#4A5FD9', '#1D1A52'],
  sunset: ['#5B6FE0', '#4A5FD9'],
  fresh: ['#5B7FE8', '#3F8DB5'],
  candy: dark ? ['#1D1A52', '#14123A', '#1D1A52'] : ['#FFFFFF', '#EEEEFF', '#FFFFFF'],
  night: ['#1D1A52', '#2A2773'],
};
// translucent surfaces for the player hero (white text on a deep gradient)
export const glass = { fill: 'rgba(255,255,255,0.14)', line: 'rgba(255,255,255,0.22)', text: '#FFFFFF', sub: 'rgba(255,255,255,0.72)' };
export const heroGrad = (tone = '#4A5FD9') => ['#14123A', '#1D1A52', tone];
// one colour family per sport card: [solid, soft tint, deep text-on-tint]
export const sportTones = [
  ['#4A5FD9', '#D3D3FF', '#2A2773'], ['#059669', '#DCFCE7', '#047857'], ['#EA580C', '#FFEDD5', '#C2410C'], ['#0284C7', '#E0F2FE', '#075985'],
  ['#DB2777', '#FCE7F3', '#9D174D'], ['#D97706', '#FEF3C7', '#92400E'], ['#6577E0', '#E4E2FF', '#4A5FD9'],
];
export const toneFor = (s = '') => HAS_SPORT_THEME(s) ? sportTheme(s).tone : sportTones[[...String(s)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % sportTones.length];
export const accents = [c.pink, c.violet, c.cyan, c.lime, c.sun, c.orange, c.mint];
export const softOf = { [c.pink]: c.pinkSoft, [c.violet]: c.violetSoft, [c.cyan]: c.cyanSoft, [c.lime]: c.limeSoft, [c.sun]: c.sunSoft, [c.orange]: c.orangeSoft, [c.mint]: c.mintSoft };
export const accentFor = (s = '') => accents[[...String(s)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % accents.length];
export const r = { card: 18, pill: 999, input: 12 };
export const fam = Platform.OS === 'web' ? { fontFamily: '"Inter", "SF Pro Display", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif' } : null;
export const font = { black: { fontWeight: '800' }, bold: { fontWeight: '700' }, med: { fontWeight: '600' } };
export const money = (cents = 0) => `₹${(cents / 100).toLocaleString(locale, { maximumFractionDigits: 0 })}`;
export const when = (iso) => new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
/** A result value with its unit: seconds and metres get a suffix, counts stay plain. */
export const withUnit = (value, unit) => (value === null || value === undefined ? '–' : unit === 's' ? `${value} s` : unit === 'm' ? `${value} m` : `${value}`);
export const unitName = (unit) => (unit === 's' ? 'seconds' : unit === 'm' ? 'metres' : 'a whole number');
export const day = (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
