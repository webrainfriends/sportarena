// Resolves the fields a game / participant / person-in-game can carry for a sport and validates values:
// built-in core fields + IPTC-derived sport template + user-defined field_definitions.
import { many } from '../db.js';
import { badRequest } from '../errors.js';
import { coreFields, sportTemplates } from './iptc.js';

export async function resolveFields(sport, scope) {
  const out = new Map();
  for (const x of coreFields[scope] ?? []) out.set(x.key, { ...x, origin: 'core' });
  for (const x of sportTemplates[sport.slug]?.[scope] ?? []) out.set(x.key, { ...x, origin: 'template' });
  const custom = await many('SELECT id, key, label, datatype, options, required FROM field_definitions WHERE scope=$1 AND (sport_id IS NULL OR sport_id=$2) ORDER BY created_at', [scope, sport.id]);
  for (const c of custom) out.set(c.key, { key: c.key, label: c.label, datatype: c.datatype, options: c.options ?? undefined, required: c.required, id: c.id, origin: 'custom' });
  return [...out.values()];
}

function coerce(def, v) {
  const bad = (m) => badRequest(`Field "${def.key}" ${m}`);
  switch (def.datatype) {
    case 'text': if (typeof v !== 'string') throw bad('must be text'); if (v.length > 2000) throw bad('is too long'); return v;
    case 'boolean': if (typeof v !== 'boolean') throw bad('must be true or false'); return v;
    case 'integer': case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw bad('must be a number');
      if (def.datatype === 'integer' && !Number.isInteger(n)) throw bad('must be a whole number');
      if (def.min != null && n < def.min) throw bad(`must be at least ${def.min}`);
      if (def.max != null && n > def.max) throw bad(`must be at most ${def.max}`);
      return n;
    }
    case 'enum': if (!def.options?.includes(String(v))) throw bad(`must be one of: ${def.options?.join(', ')}`); return String(v);
    case 'datetime': if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw bad('must be an ISO date-time'); return new Date(v).toISOString();
    default: throw bad('has an unsupported type');
  }
}

/** Validate `attrs` against the sport's fields for `scope`. `partial` skips the required-field check (updates). */
export async function validateAttributes(sport, scope, attrs = {}, { partial = false } = {}) {
  const defs = new Map((await resolveFields(sport, scope)).map((d) => [d.key, d]));
  const clean = {};
  for (const [k, v] of Object.entries(attrs)) {
    const def = defs.get(k);
    if (!def) throw badRequest(`Unknown ${scope} field "${k}" for ${sport.name}. See get_game_fields.`);
    if (v === null) continue; // null clears a value
    clean[k] = coerce(def, v);
  }
  if (!partial) {
    const missing = [...defs.values()].filter((d) => d.required && clean[d.key] === undefined).map((d) => d.key);
    if (missing.length) throw badRequest(`Missing required ${scope} fields: ${missing.join(', ')}`);
  }
  return clean;
}

/** Merge validated attrs into an existing jsonb object; null values (cleared) were dropped by validation, so handle them here. */
export function mergeAttributes(current, raw, clean) {
  const next = { ...current, ...clean };
  for (const [k, v] of Object.entries(raw)) if (v === null) delete next[k];
  return next;
}
