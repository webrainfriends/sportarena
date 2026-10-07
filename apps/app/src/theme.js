// SportArena design tokens — light, loud, Gen Z. Chunky ink outlines, hard shadows, candy gradients.
export const c = {
  bg: '#FFF6FB', paper: '#FFFFFF', ink: '#1B1035', mute: '#6E6488',
  pink: '#FF2E93', violet: '#7B3FF2', cyan: '#00D4FF', lime: '#B6FF3B', sun: '#FFD23F', orange: '#FF7A1A', mint: '#00E5A8', red: '#FF4D4D', blue: '#3D6BFF',
  pinkSoft: '#FFD6EA', violetSoft: '#E5DAFF', cyanSoft: '#CFF5FF', limeSoft: '#EDFFC4', sunSoft: '#FFF1B8', mintSoft: '#C8FFEF', orangeSoft: '#FFE0C7',
};
export const grad = {
  hero: ['#FF2E93', '#7B3FF2', '#00D4FF'],
  sunset: ['#FFD23F', '#FF7A1A', '#FF2E93'],
  fresh: ['#B6FF3B', '#00E5A8', '#00D4FF'],
  candy: ['#FF9ED2', '#C9A7FF', '#9FE8FF'],
  night: ['#1B1035', '#4B1FA8'],
};
export const accents = [c.pink, c.violet, c.cyan, c.lime, c.sun, c.orange, c.mint];
export const softOf = { [c.pink]: c.pinkSoft, [c.violet]: c.violetSoft, [c.cyan]: c.cyanSoft, [c.lime]: c.limeSoft, [c.sun]: c.sunSoft, [c.orange]: c.orangeSoft, [c.mint]: c.mintSoft };
export const accentFor = (s = '') => accents[[...String(s)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % accents.length];
export const r = { card: 22, pill: 999, input: 16 };
export const font = { black: { fontWeight: '900' }, bold: { fontWeight: '800' }, med: { fontWeight: '600' } };
export const money = (cents = 0) => `₹${(cents / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
export const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
