// Local rules: validate the values a competition changes, work out what is in force, and carry the settings that matter to scoring
// into a ruleset. Pure functions, no database. The standard values live in catalog.js and are never edited: a local rule set stores only
// the values that differ from the standard, and each published version is immutable.
import { createHash } from 'node:crypto';
import { rulesetSchema } from '../scoring/rulesets.js';
import { bookFor, cardsFor, paramsOf } from './catalog.js';

/** @returns {{ok:true, values:object}|{ok:false, error:string}} Only keys that exist for the format, inside range, and different from the standard are kept. */
export function cleanValues(slug, format, raw) {
  const b = bookFor(slug, format);
  if (!b) return { ok: false, error: 'There is no rulebook for this sport yet' };
  const params = new Map(paramsOf(b.book, b.format).map((p) => [p.key, p]));
  const out = {};
  for (const [key, v] of Object.entries(raw ?? {})) {
    const p = params.get(key);
    if (!p) return { ok: false, error: `"${key}" is not a setting of the ${b.book.name} rulebook${b.format ? ` (${b.format})` : ''}` };
    if (p.type === 'int') {
      if (!Number.isInteger(v) || v < p.min || v > p.max) return { ok: false, error: `${p.label} must be a whole number from ${p.min} to ${p.max}` };
      if (/bestof$/.test(p.key) && v % 2 === 0) return { ok: false, error: `${p.label} must be an odd number of games` };
    } else if (p.type === 'choice') {
      if (!p.options.includes(v)) return { ok: false, error: `${p.label} must be one of: ${p.options.join(', ')}` };
    } else if (typeof v !== 'boolean') return { ok: false, error: `${p.label} must be on or off` };
    if (v !== p.std) out[key] = v;
  }
  return { ok: true, values: out };
}

/** The book for a format with every setting resolved: its value now, the standard, and whether it is a local change. */
export function resolveBook(slug, format, values = {}) {
  const b = bookFor(slug, format);
  if (!b) return null;
  const cards = cardsFor(b.book, b.format).map((c) => ({
    ...c,
    params: c.params.map((p) => { const value = p.key in values ? values[p.key] : p.std; return { ...p, value, changed: value !== p.std }; }),
  }));
  return { slug: b.slug, format: b.format, name: b.book.name, emoji: b.book.emoji, body: b.book.body, official_url: b.book.official_url, note: b.book.note, formats: b.book.formats ?? null, cards, changes: cards.flatMap((c) => c.params.filter((p) => p.changed).map((p) => ({ card: c.title, key: p.key, label: p.label, value: p.value, std: p.std, unit: p.unit }))) };
}

const show = (v, unit) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : `${v}${unit ? ` ${unit}` : ''}`);

/** Lines printed in the "rules in force" box of a sheet or the rulebook PDF. */
export function rulesLines(slug, format, values = {}) {
  const r = resolveBook(slug, format, values);
  if (!r) return [];
  return r.changes.map((x) => `${x.card}: ${x.label} ${show(x.value, x.unit)} (standard ${show(x.std, x.unit)})`);
}

// How a setting reaches the scoring ruleset. Only settings that change how a game is scored do; the rest are shown on the sheet.
const SETS = {
  'table-tennis': { points: 'points_to_win', bestof: 'best_of' },
  pickleball: { points: 'points_to_win', bestof: 'best_of', winby: 'win_by' },
  racquetball: { points: 'points_to_win', tiebreak: 'deciding_points', bestof: 'best_of' },
  squash: { points: 'points_to_win', bestof: 'best_of', winby: 'win_by' },
  badminton: { points: 'points_to_win', bestof: 'best_of', cap: 'cap' },
};
const PERIODS = { hockey: { key: 'quarters', label: (n) => (n === 2 ? 'Half' : 'Quarter') }, 'ice-hockey': { key: 'periods', label: () => 'Period' }, baseball: { key: 'innings', label: () => 'Inning' } };

/** The ruleset a standalone sheet is scored under, with the local values that affect scoring applied. Returns the ruleset unchanged when none do. */
export function applyToRuleset(slug, ruleset, values = {}, format) {
  const b = bookFor(slug, format);
  if (!b || !Object.keys(values).length) return ruleset;
  let next = ruleset;
  const map = SETS[b.slug];
  if (map && ruleset.kind === 'sets') {
    const sets = { ...ruleset.sets };
    for (const [key, field] of Object.entries(map)) if (key in values) sets[field] = values[key];
    next = { ...ruleset, sets };
  }
  const per = PERIODS[b.slug];
  if (per && per.key in values && ruleset.kind === 'points_events') next = { ...next, periods: { count: values[per.key], label: per.label(values[per.key]) } };
  return next === ruleset ? ruleset : rulesetSchema.parse(next);
}

/** Settings that disagree with a game's pinned ruleset (a linked sheet always keeps the event's rules): [{label, local, pinned}]. */
export function conflictsWith(slug, ruleset, values = {}, format) {
  const b = bookFor(slug, format);
  if (!b) return [];
  const out = [];
  const map = SETS[b.slug];
  if (map && ruleset.kind === 'sets') for (const [key, field] of Object.entries(map)) if (key in values && ruleset.sets[field] !== values[key]) out.push({ key, local: values[key], pinned: ruleset.sets[field] });
  const per = PERIODS[b.slug];
  if (per && per.key in values && ruleset.kind === 'points_events' && ruleset.periods.count !== values[per.key]) out.push({ key: per.key, local: values[per.key], pinned: ruleset.periods.count });
  return out;
}

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
/** Fingerprint of the standard values a version was made against, so a later change to the standard text is detectable. */
export const standardHash = (slug, format) => {
  const b = bookFor(slug, format);
  return createHash('sha256').update(JSON.stringify(canon(b ? paramsOf(b.book, b.format).map((p) => [p.key, p.std]) : []))).digest('hex').slice(0, 16);
};
