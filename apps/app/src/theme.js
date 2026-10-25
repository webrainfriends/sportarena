import { Appearance, Platform } from 'react-native';
import { locale } from './locale';
import { HAS_SPORT_THEME, sportTheme } from './sport-theme';
// Gotmygame design tokens — "Ember": a bright, airy light theme. Lavender-white canvas, white cards with
// soft shadows, one confident indigo accent plus a small family of sport colours. Colourful hero panels carry white text.
// Token names are stable (pink = primary accent, ink = text, paper = card, violet = strong slate for dark buttons)
// so every screen inherits the theme.
// Light / dark: resolved once, synchronously, when the app loads (stored choice, else the OS setting), because
// screens read these tokens at import time. Changing the choice stores it and reloads the app (see appearance.js).
// Palette: Dusk (#A0D2EB, #E5EAF5, #D0BDF4, #8458B3, #494D5F): sky blue, mist, lavender, amethyst and slate. Light mode puts mist on the canvas with amethyst as the accent, dark mode flips them onto deep slate.
export const palette = { p0: '#2A2D3A', p1: '#494D5F', p2: '#8458B3', p3: '#D0BDF4', p4: '#A0D2EB', p5: '#E5EAF5' };
const LIGHT = {
  bg: '#E5EAF5', paper: '#FFFFFF', ink: '#2F3242', mute: '#5F6580', line: '#CDD5E8', on: '#FFFFFF', inkOn: '#FFFFFF', onAccent: '#FFFFFF',
  pink: '#8458B3', violet: '#494D5F', cyan: '#3E8AB5', lime: '#2F8F5F', sun: '#D97706', orange: '#EA580C', mint: '#3E9A82', red: '#E11D48', blue: '#3E8AB5',
  pinkSoft: '#D0BDF4', violetSoft: '#E5EAF5', cyanSoft: '#DCEEF8', limeSoft: '#D9F0E1', sunSoft: '#FEF3C7', mintSoft: '#DDF1EA', orangeSoft: '#FFEDD5', redSoft: '#FFE4E6',
};
const DARK = {
  bg: '#2A2D3A', paper: '#3B3F51', ink: '#E5EAF5', mute: '#B3B9CC', line: '#494D5F', on: '#FFFFFF', inkOn: '#2A2D3A', onAccent: '#2A2D3A',
  pink: '#D0BDF4', violet: '#8458B3', cyan: '#A0D2EB', lime: '#5FD39A', sun: '#FBBF24', orange: '#FB923C', mint: '#7ADBC4', red: '#FB7185', blue: '#A0D2EB',
  pinkSoft: '#494D5F', violetSoft: '#33364A', cyanSoft: '#2F3A4A', limeSoft: '#0F3A2C', sunSoft: '#3D3012', mintSoft: '#0F3D35', orangeSoft: '#42250F', redSoft: '#4A1A28',
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
  hero: ['#8458B3', '#494D5F'],
  sunset: ['#9B72C6', '#8458B3'],
  fresh: ['#A0D2EB', '#8458B3'],
  candy: dark ? ['#3B3F51', '#2A2D3A', '#3B3F51'] : ['#FFFFFF', '#E5EAF5', '#FFFFFF'],
  night: ['#3B3F51', '#494D5F'],
};
// translucent surfaces for the player hero (white text on a deep gradient)
export const glass = { fill: 'rgba(255,255,255,0.14)', line: 'rgba(255,255,255,0.22)', text: '#FFFFFF', sub: 'rgba(255,255,255,0.72)' };
export const heroGrad = (tone = '#8458B3') => ['#2A2D3A', '#494D5F', tone];
// one colour family per sport card: [solid, soft tint, deep text-on-tint]
export const sportTones = [
  ['#8458B3', '#EADFFA', '#494D5F'], ['#059669', '#DCFCE7', '#047857'], ['#EA580C', '#FFEDD5', '#C2410C'], ['#0284C7', '#E0F2FE', '#075985'],
  ['#DB2777', '#FCE7F3', '#9D174D'], ['#D97706', '#FEF3C7', '#92400E'], ['#3E8AB5', '#DCEEF8', '#2F6F96'],
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
