// Reproducible randomness for draws: the same seed string always gives the same sequence, so a draw can be replayed from what was persisted.
import { randomBytes } from 'node:crypto';

/** FNV-1a 32-bit hash of a string. */
export function hashSeed(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for draws; returns a function giving floats in [0,1). */
export function rngFor(seed) {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates on a copy. */
export function shuffled(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** A fresh draw seed to persist with the draw (so anyone can reproduce it). */
export const newDrawSeed = () => randomBytes(8).toString('hex');
