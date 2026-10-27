import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { dark } from '../theme';

// Gradient identity per More tile: [from, to]. Saturated enough for white text in both themes.
const LIGHT = {
  // play: crimson to wine
  Leaderboard: ['#8458B3', '#2A5B7E'], Awards: ['#8A62B8', '#5E4A86'], MyPlans: ['#8458B3', '#363B48'], MyDevelopment: ['#8458B3', '#363B48'], ToolsHome: ['#7B4EAE', '#363B48'], Pathways: ['#7B4EAE', '#3F285A'],
  // care: slate blues
  Health: ['#3D84B6', '#234C69'], Insure: ['#397DAC', '#363B48'], Insurance: ['#5BA0C8', '#234C69'], Legal: ['#2A5B7E', '#2B2E39'], Family: ['#3676A3', '#323642'],
  // money: peach to crimson
  Wallet: ['#4F96C0', '#8458B3'], Earnings: ['#4A8FBA', '#6E4A9E'], Shop: ['#5A9CC6', '#6E4A9E'], Billboard: ['#6AA8D0', '#8458B3'], Sponsors: ['#8961B8', '#59397E'], Supply: ['#8961B8', '#6A4496'],
  // community: navy with a warm edge
  Openings: ['#5E86AE', '#234C69'], EventInbox: ['#4F7FA8', '#234C69'], Orgs: ['#5A83AD', '#234C69'], Federations: ['#4F7FA8', '#2B2E39'], MediaWorkspace: ['#3E8FB0', '#2B2E39'], MyLicences: ['#7B4EAE', '#2A5B7E'], Support: ['#7C86A2', '#2A5B7E'], Schedule: ['#336F9A', '#2D303B'], Workspace: ['#8458B3', '#363B48'], Notifications: ['#5A9CC6', '#5E4A86'],
};
// Dark mode: deeper stops so a bright card never glares against the night background.
const DARK = Object.fromEntries(Object.entries(LIGHT).map(([k, [a, b]]) => [k, [shade(a), shade(b)]]));
function shade(hex, k = 0.68) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}
export const tileColors = (name) => (dark ? DARK : LIGHT)[name] ?? (dark ? DARK : LIGHT).Support;

const W = (o = 1) => ({ fill: '#fff', fillOpacity: o });
const S = (o = 1, w = 3.5) => ({ stroke: '#fff', strokeOpacity: o, strokeWidth: w, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' });
const GOLD = '#D0BDF4'; // palette p4: the one accent in each illustration

// Layered white shapes plus one warm accent, drawn on a 96×96 grid.
const ART = {
  Leaderboard: <><Rect x="10" y="52" width="22" height="34" rx="5" {...W(0.45)} /><Rect x="37" y="30" width="22" height="56" rx="5" {...W(0.95)} /><Rect x="64" y="42" width="22" height="44" rx="5" {...W(0.65)} /><Path d="m48 8 3.4 7 7.6 1-5.5 5.3 1.3 7.6-6.8-3.6-6.8 3.6 1.3-7.6L37 16l7.6-1z" fill={GOLD} /></>,
  Awards: <><Path d="M28 14h40v26a20 20 0 0 1-40 0z" {...W(0.95)} /><Path d="M28 22H14v6a14 14 0 0 0 15 14M68 22h14v6a14 14 0 0 1-15 14" {...S(0.6, 5)} /><Rect x="43" y="58" width="10" height="14" {...W(0.7)} /><Rect x="30" y="72" width="36" height="10" rx="4" {...W(0.85)} /><Path d="M48 24l3 6 6.5 1-4.7 4.5 1.1 6.5-5.9-3.1-5.9 3.1 1.1-6.5-4.7-4.5 6.5-1z" fill={GOLD} /></>,
  MyPlans: <><Rect x="18" y="12" width="60" height="74" rx="10" {...W(0.95)} /><Rect x="34" y="6" width="28" height="14" rx="6" {...W(0.55)} /><Path d="M30 40l6 6 11-12M30 62l6 6 11-12" stroke={GOLD} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" /><Rect x="54" y="38" width="16" height="6" rx="3" {...W(0.5)} /><Rect x="54" y="60" width="16" height="6" rx="3" {...W(0.5)} /></>,

  MyDevelopment: <><Rect x="18" y="12" width="60" height="74" rx="10" {...W(0.95)} /><Rect x="34" y="6" width="28" height="14" rx="6" {...W(0.55)} /><Path d="M30 40l6 6 11-12M30 62l6 6 11-12" stroke={GOLD} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" /><Rect x="54" y="38" width="16" height="6" rx="3" {...W(0.5)} /><Rect x="54" y="60" width="16" height="6" rx="3" {...W(0.5)} /></>,
  Pathways: <><Path d="M4 38 48 16l44 22-44 22z" {...W(0.95)} /><Path d="M22 52v18c0 6 12 12 26 12s26-6 26-12V52L48 64z" {...W(0.6)} /><Path d="M86 42v22" stroke={GOLD} strokeWidth="5" strokeLinecap="round" /><Circle cx="86" cy="68" r="5" fill={GOLD} /></>,
  Health: <><Path d="M48 86S10 64 10 36a19 19 0 0 1 38-6 19 19 0 0 1 38 6c0 28-38 50-38 50z" {...W(0.95)} /><Path d="M16 48h16l8-16 12 28 8-12h20" stroke={GOLD} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></>,
  Insure: <><Path d="M48 8 82 20v26c0 20-14 34-34 42C28 80 14 66 14 46V20z" {...W(0.95)} /><Path d="M48 8 82 20v26c0 20-14 34-34 42z" {...W(0.35)} /><Path d="m33 48 11 11 20-22" stroke={GOLD} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none" /></>,
  Insurance: <><Circle cx="62" cy="40" r="30" {...W(0.25)} /><Path d="M40 12 70 22v22c0 17-12 29-30 36C22 73 10 61 10 44V22z" {...W(0.95)} /><Path d="M27 44l9 9 17-18" stroke={GOLD} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none" /><Circle cx="76" cy="70" r="12" fill={GOLD} /><Path d="M76 63v14M69 70h14" {...S(0.9, 3.5)} stroke="#5C3B82" /></>,
  Legal: <><Rect x="44" y="12" width="8" height="60" rx="4" {...W(0.95)} /><Rect x="26" y="76" width="44" height="10" rx="5" {...W(0.85)} /><Rect x="10" y="22" width="76" height="6" rx="3" {...W(0.95)} /><Path d="M16 28 4 54a14 12 0 0 0 24 0zM80 28 68 54a14 12 0 0 0 24 0z" {...W(0.55)} /><Circle cx="48" cy="12" r="6" fill={GOLD} /></>,
  Family: <><Circle cx="34" cy="26" r="13" {...W(0.95)} /><Circle cx="66" cy="32" r="10" {...W(0.7)} /><Path d="M8 82c1-18 11-28 26-28s25 10 26 28z" {...W(0.95)} /><Path d="M56 62c14-4 28 2 32 20H64z" {...W(0.6)} /><Circle cx="48" cy="60" r="6" fill={GOLD} /></>,
  Wallet: <><Rect x="10" y="22" width="76" height="56" rx="12" {...W(0.95)} /><Path d="M10 36c0-8 6-14 14-14h40" {...S(0.5, 4)} /><Rect x="56" y="42" width="30" height="20" rx="8" {...W(0.5)} /><Circle cx="68" cy="52" r="4.5" fill={GOLD} /><Circle cx="74" cy="14" r="11" fill={GOLD} /><Path d="M74 9v10M70 12.5c0-2 8-2 8 0s-8 2-8 4.5 8 2.5 8 0" {...S(0.9, 2.2)} stroke="#5C3B82" /></>,
  Earnings: <><Circle cx="48" cy="48" r="36" {...W(0.95)} /><Circle cx="48" cy="48" r="27" {...W(0.35)} /><Path d="M58 36c-2-4-6-6-10-6-6 0-10 3-10 8 0 11 21 5 21 17 0 5-5 8-11 8-5 0-9-2-11-6M48 24v6M48 66v6" stroke={GOLD} strokeWidth="5" strokeLinecap="round" fill="none" /></>,
  Shop: <><Path d="M16 32h64l-6 52H22z" {...W(0.95)} /><Path d="M34 32v-6a14 14 0 0 1 28 0v6" {...S(0.8, 6)} /><Circle cx="38" cy="48" r="4.5" fill={GOLD} /><Circle cx="58" cy="48" r="4.5" fill={GOLD} /><Path d="M16 32h64l-3 14H19z" {...W(0.4)} /></>,
  Billboard: <><Path d="M14 38v20h16l34 20V18L30 38z" {...W(0.95)} /><Rect x="12" y="36" width="20" height="24" rx="6" {...W(0.6)} /><Path d="M74 34a18 18 0 0 1 0 28M82 24a32 32 0 0 1 0 48" stroke={GOLD} strokeWidth="5" strokeLinecap="round" fill="none" /><Path d="M28 64l6 22h12l-6-20z" {...W(0.7)} /></>,
  Sponsors: <><Path d="M26 12h44l22 28-44 50L4 40z" {...W(0.95)} /><Path d="M4 40h88M36 12l-8 28 20 50 20-50-8-28" {...S(0.45, 3)} /><Path d="M26 12h44l-8 28H34z" {...W(0.35)} /><Path d="M80 6l2.5 5 5.5.8-4 3.9 1 5.5-5-2.6-5 2.6 1-5.5-4-3.9 5.5-.8z" fill={GOLD} /></>,
  Supply: <><Path d="M10 30 48 12l38 18v38L48 86 10 68z" {...W(0.95)} /><Path d="m10 30 38 18 38-18M48 48v38" {...S(0.45, 3.5)} /><Path d="M28 21l38 18v14" stroke={GOLD} strokeWidth="5" strokeLinecap="round" fill="none" /></>,
  Openings: <><Rect x="8" y="30" width="80" height="54" rx="12" {...W(0.95)} /><Path d="M34 30v-6a8 8 0 0 1 8-8h12a8 8 0 0 1 8 8v6" {...S(0.8, 5)} /><Path d="M8 54h80" {...S(0.4, 4)} /><Rect x="40" y="48" width="16" height="14" rx="4" fill={GOLD} /></>,
  EventInbox: <><Rect x="8" y="22" width="80" height="58" rx="12" {...W(0.95)} /><Path d="m12 30 36 28 36-28" {...S(0.55, 4.5)} /><Circle cx="80" cy="22" r="13" fill={GOLD} /><Path d="M80 15v9" {...S(0.95, 4)} stroke="#5C3B82" /><Circle cx="80" cy="29" r="2" fill="#5C3B82" /></>,
  Orgs: <><Rect x="14" y="14" width="42" height="72" rx="6" {...W(0.95)} /><Rect x="56" y="36" width="28" height="50" rx="6" {...W(0.6)} /><Path d="M24 28h8M38 28h8M24 42h8M38 42h8M24 56h8M38 56h8" {...S(0.45, 4)} /><Rect x="26" y="68" width="18" height="18" rx="4" fill={GOLD} /></>,
  Workspace: <><Rect x="8" y="30" width="80" height="54" rx="12" {...W(0.95)} /><Path d="M34 30v-6a8 8 0 0 1 8-8h12a8 8 0 0 1 8 8v6" {...S(0.8, 5)} /><Path d="M8 56h80" {...S(0.4, 4)} /><Rect x="38" y="50" width="20" height="14" rx="4" fill={GOLD} /><Path d="M20 70h14M62 70h14" {...S(0.45, 4)} /></>,
  Schedule: <><Rect x="10" y="18" width="76" height="68" rx="12" {...W(0.95)} /><Rect x="10" y="18" width="76" height="22" rx="12" {...W(0.55)} /><Path d="M30 8v16M66 8v16" {...S(0.95, 6)} /><Circle cx="34" cy="58" r="5" {...W(0.5)} /><Circle cx="62" cy="58" r="5" {...W(0.5)} /><Circle cx="48" cy="72" r="6" fill={GOLD} /></>,
  Notifications: <><Path d="M20 66V46a28 28 0 0 1 56 0v20l8 8H12z" {...W(0.95)} /><Path d="M38 80a10 10 0 0 0 20 0z" {...W(0.7)} /><Circle cx="70" cy="22" r="11" fill={GOLD} /></>,
  ToolsHome: <><Rect x="14" y="22" width="68" height="54" rx="10" {...W(0.95)} /><Path d="M30 22v-6a6 6 0 0 1 6-6h24a6 6 0 0 1 6 6v6" {...S(0.7, 6)} /><Path d="M14 46h68" {...S(0.35, 4)} /><Rect x="40" y="40" width="16" height="14" rx="4" fill={GOLD} /></>,
  Support: <><Circle cx="48" cy="48" r="38" {...W(0.95)} /><Circle cx="48" cy="48" r="15" fill="none" stroke={GOLD} strokeWidth="7" /><Path d="m20 20 18 18M76 20 58 38M20 76l18-18M76 76 58 58" {...S(0.5, 7)} /></>,
};

export function TileArt({ name, size = 96, style }) {
  const art = ART[name] ?? ART.Support;
  return <Svg width={size} height={size} viewBox="0 0 96 96" style={style}>{art}</Svg>;
}
