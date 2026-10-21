import { Appearance, Platform } from 'react-native';
import { locale } from './locale';
import { HAS_SPORT_THEME, sportTheme } from './sport-theme';
// Gotmygame design tokens — "Fresh Court": a bright, airy light theme. Cool off-white canvas, white cards with
// soft shadows, one confident indigo accent plus a small family of sport colours. Colourful hero panels carry white text.
// Token names are stable (pink = primary accent, ink = text, paper = card, violet = strong slate for dark buttons)
// so every screen inherits the theme.
// Light / dark: resolved once, synchronously, when the app loads (stored choice, else the OS setting), because
// screens read these tokens at import time. Changing the choice stores it and reloads the app (see appearance.js).
// Palette: deep forest to pale mint. Light mode puts the dark greens on a pale canvas, dark mode flips them.
export const palette = { p0: '#051F20', p1: '#0B2B26', p2: '#163832', p3: '#235347', p4: '#8EB69B', p5: '#DAF1DE' };
const LIGHT = {
  bg: '#EDF7EF', paper: '#FFFFFF', ink: '#051F20', mute: '#4F6B61', line: '#CFE3D3', on: '#FFFFFF', inkOn: '#FFFFFF', onAccent: '#FFFFFF',
  pink: '#235347', violet: '#163832', cyan: '#1F8A86', lime: '#2F8F5F', sun: '#D97706', orange: '#EA580C', mint: '#3E9A82', red: '#E11D48', blue: '#1F8A86',
  pinkSoft: '#DAF1DE', violetSoft: '#E4F0E7', cyanSoft: '#D5EFEC', limeSoft: '#D9F0E1', sunSoft: '#FEF3C7', mintSoft: '#DDF1EA', orangeSoft: '#FFEDD5', redSoft: '#FFE4E6',
};
const DARK = {
  bg: '#051F20', paper: '#0B2B26', ink: '#DAF1DE', mute: '#8FB09C', line: '#163832', on: '#FFFFFF', inkOn: '#051F20', onAccent: '#051F20',
  pink: '#8EB69B', violet: '#235347', cyan: '#5CC8C0', lime: '#5FD39A', sun: '#FBBF24', orange: '#FB923C', mint: '#7ADBC4', red: '#FB7185', blue: '#5CC8C0',
  pinkSoft: '#163832', violetSoft: '#12332D', cyanSoft: '#0E3A3A', limeSoft: '#0F3A2C', sunSoft: '#3D3012', mintSoft: '#0F3D35', orangeSoft: '#42250F', redSoft: '#4A1A28',
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
  hero: ['#235347', '#0B2B26'],
  sunset: ['#2E6B5A', '#235347'],
  fresh: ['#27795A', '#1B6F6B'],
  candy: dark ? ['#0B2B26', '#051F20', '#0B2B26'] : ['#FFFFFF', '#EDF7EF', '#FFFFFF'],
  night: ['#0B2B26', '#163832'],
};
// translucent surfaces for the player hero (white text on a deep gradient)
export const glass = { fill: 'rgba(255,255,255,0.14)', line: 'rgba(255,255,255,0.22)', text: '#FFFFFF', sub: 'rgba(255,255,255,0.72)' };
export const heroGrad = (tone = '#235347') => ['#051F20', '#0B2B26', tone];
// one colour family per sport card: [solid, soft tint, deep text-on-tint]
export const sportTones = [
  ['#235347', '#DAF1DE', '#163832'], ['#059669', '#DCFCE7', '#047857'], ['#EA580C', '#FFEDD5', '#C2410C'], ['#0284C7', '#E0F2FE', '#075985'],
  ['#DB2777', '#FCE7F3', '#9D174D'], ['#D97706', '#FEF3C7', '#92400E'], ['#3E7A5F', '#E4F0E7', '#235347'],
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
