// Commercial engine (#504): price versions -> quotes, entitlement resolution, metered usage, subscriptions.
// Every monetised capability asks this module ("may this subject do X, how much is left"); nothing else tests a plan name.
import { createHash, randomBytes } from 'node:crypto';
import { one, many, query, tx } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';

export const SUBJECT_TYPES = ['user', 'organisation', 'team', 'venue', 'event'];
const MAX_DEPTH = 5;
const DAY = 86_400_000;

export const commercialAudit = (c, actor, action, entity, entityId, detail = {}) =>
  (c ?? { query }).query('INSERT INTO commercial_audit(actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)', [actor ?? null, action, entity, entityId ?? null, JSON.stringify(detail)]);

const day = (d) => new Date(d).toISOString().slice(0, 10);
const addInterval = (from, interval) => {
  const d = new Date(from);
  if (interval === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (interval === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else return null;
  return d;
};

// ------------------------------------------------------------------ pricing
/** The stable code of a price point (a sellable slot): plan + billing interval + currency + region. Every version of the slot shares it. */
export const pricePointCode = (planKey, interval, currency, region) => `${planKey}:${interval}:${currency}:${region}`;
export const versionCode = (v) => pricePointCode(v.plan_key, v.billing_interval, v.currency, v.region);
export const parsePricePointCode = (code) => { const [plan_key, billing_interval, currency, region] = String(code).split(':'); return { plan_key, billing_interval, currency, region }; };
/** Does an offer apply to this price point? (no attached price points = all of them) */
export const offerAppliesTo = (promo, code) => !promo?.price_points?.length || promo.price_points.includes(code);
/**
 * Price one version for the given quantities. Pure. Returns billable lines (they add up to the subtotal) and informational
 * percentage terms (a transaction fee or commission is a rate on future sales, never a charge at quote time; 0% is just `bp: 0`).
 */
export function priceVersion(v, { quantities = {}, usage = {}, gmv_minor = 0 } = {}) {
  const lines = [];
  const terms = [];
  const base = Number(v.amount_minor);
  if (base > 0) lines.push({ kind: 'base', label: v.plan_name ?? 'Plan', quantity: 1, amount_minor: base });
  for (const c of v.components ?? []) {
    if (c.kind === 'fixed') lines.push({ kind: 'fixed', label: c.label, category: c.category ?? null, quantity: 1, amount_minor: c.amount_minor });
    else if (c.kind === 'per_unit') {
      const q = Math.max(0, Number(quantities[c.unit] ?? 0) - (c.included ?? 0));
      if (q > 0) lines.push({ kind: 'per_unit', label: c.label, unit: c.unit, quantity: q, unit_amount_minor: c.unit_amount_minor, amount_minor: q * c.unit_amount_minor });
    } else if (c.kind === 'band') {
      const q = Number(quantities[c.unit] ?? 0);
      const band = c.bands.find((b) => b.up_to == null || q <= b.up_to);
      if (!band) throw badRequest(`${c.label}: ${q} is above the largest band; a custom contract is needed`);
      if (band.amount_minor > 0) lines.push({ kind: 'band', label: `${c.label} (${band.up_to == null ? 'more' : `up to ${band.up_to}`})`, unit: c.unit, quantity: q, amount_minor: band.amount_minor });
    } else if (c.kind === 'usage') {
      const q = Math.max(0, Number(usage[c.meter] ?? 0) - (c.included ?? 0));
      if (q > 0) lines.push({ kind: 'usage', label: c.label, meter: c.meter, quantity: q, unit_amount_minor: c.unit_amount_minor, amount_minor: Math.round(q * c.unit_amount_minor) });
    } else if (c.kind === 'percent_fee') {
      const raw = Math.round((Number(gmv_minor) * c.bp) / 10000);
      terms.push({ kind: 'percent_fee', label: c.label, applies_to: c.applies_to ?? 'transaction', bp: c.bp, cap_minor: c.cap_minor ?? null, example_on_minor: Number(gmv_minor), example_fee_minor: c.cap_minor != null ? Math.min(raw, c.cap_minor) : raw });
    }
  }
  const subtotal = lines.reduce((s, l) => s + l.amount_minor, 0);
  return { lines, terms, subtotal_minor: subtotal };
}

/** The published version of a plan that is in force on `at` for a region/currency (exact region beats the '*' fallback; newest wins). */
export async function selectVersion(planId, { region = 'IN', currency, interval, at = new Date(), c } = {}) {
  const rows = (await (c ?? { query }).query(
    `SELECT v.*, p.name AS plan_name, p.key AS plan_key, p.kind AS plan_kind, p.eligible_actors, p.requires
       FROM commercial_price_versions v JOIN commercial_plans p ON p.id = v.plan_id
      WHERE v.plan_id = $1 AND v.status = 'published' AND v.effective_from <= $2::date AND (v.effective_to IS NULL OR v.effective_to >= $2::date)
        AND (v.region = $3 OR v.region = '*') AND ($4::text IS NULL OR v.currency = $4) AND ($5::text IS NULL OR v.billing_interval = $5)
      ORDER BY (v.region = $3) DESC, v.effective_from DESC, v.version DESC`, [planId, day(at), region, currency ?? null, interval ?? null])).rows;
  if (!rows.length) return null;
  const top = rows[0];
  // several intervals/currencies in force and none asked for: refuse to guess
  const distinct = new Set(rows.filter((r) => r.region === top.region && r.effective_from.getTime?.() === top.effective_from.getTime?.()).map((r) => `${r.currency}/${r.billing_interval}`));
  if (distinct.size > 1 && (!interval || !currency)) throw badRequest(`Several prices are in force (${[...distinct].join(', ')}); say which currency and billing_interval`);
  return top;
}

// ------------------------------------------------------------------ entitlement resolution
/*
 * Deterministic precedence, lowest to highest; each later layer overrides the earlier one for the keys it names:
 *   1 default plan (the free plan of the actor type)      replace
 *   2 parent subject's resolved entitlements (enterprise) replace
 *   3 own base plan, on its pinned (or due scheduled) version  replace
 *   4 add-ons                                             add   (limits sum, unlimited absorbs, features OR)
 *   5 promotion grants while the promotion is in force    add
 *   6 contract override (this subject)                    set | add
 *   7 enterprise override (set on an ancestor)            set | add     <- highest
 * Within a layer, several rows are applied in created order. The result lists the sources that shaped each key.
 */
const empty = () => ({ enabled: true, limit: null, behaviour: 'hard', warn_at_pct: 80, sources: [] });
const addLimit = (a, b) => (a == null || b == null ? null : Number(a) + Number(b));

function applyReplace(map, ent, source) {
  map[ent.key] = { enabled: true, limit: ent.limit_value == null ? null : Number(ent.limit_value), behaviour: ent.limit_behaviour ?? 'hard', warn_at_pct: ent.warn_at_pct ?? 80, sources: [source] };
}
function applyAdd(map, ent, source) {
  const cur = map[ent.key] ?? { ...empty(), limit: 0, sources: [] };
  map[ent.key] = { ...cur, enabled: true, limit: addLimit(cur.limit, ent.limit_value ?? null), sources: [...cur.sources, source] };
}
function applyOverride(map, o, source) {
  const cur = map[o.key] ?? { ...empty(), limit: 0, sources: [] };
  if (o.mode === 'add') map[o.key] = { ...cur, enabled: cur.enabled && o.enabled, limit: addLimit(cur.limit, o.limit_value ?? null), sources: [...cur.sources, source] };
  else map[o.key] = { enabled: o.enabled, limit: o.limit_value == null ? null : Number(o.limit_value), behaviour: o.limit_behaviour ?? cur.behaviour, warn_at_pct: cur.warn_at_pct, sources: [...cur.sources, source] };
}

const entitlementsOf = (versionId) => many('SELECT key, limit_value, limit_behaviour, warn_at_pct FROM commercial_version_entitlements WHERE version_id = $1 ORDER BY key', [versionId]);

async function ancestors(subjectType, subjectId) {
  const chain = [];
  let cur = { type: subjectType, id: subjectId };
  for (let i = 0; i < MAX_DEPTH; i++) {
    const l = await one('SELECT parent_type, parent_id FROM commercial_subject_links WHERE child_type = $1 AND child_id = $2 AND ended_at IS NULL', [cur.type, cur.id]);
    if (!l || chain.some((a) => a.type === l.parent_type && a.id === l.parent_id)) break;
    cur = { type: l.parent_type, id: l.parent_id };
    chain.push(cur);
  }
  return chain;
}

/** Subscriptions that are in force on `at` (trial not lapsed, not ended, not cancelled past its period). */
function inForce(s, at) {
  if (!['trial', 'active'].includes(s.status)) return false;
  if (s.started_at && new Date(s.started_at) > at) return false;
  if (s.status === 'trial' && (!s.trial_ends_at || new Date(s.trial_ends_at) <= at)) return false;
  if (s.cancel_at_period_end && s.current_period_end && new Date(s.current_period_end) <= at) return false;
  return !s.ended_at || new Date(s.ended_at) > at;
}
const effectiveVersionId = (s, at) => (s.scheduled_version_id && s.scheduled_for && new Date(s.scheduled_for) <= at ? s.scheduled_version_id : s.version_id);

/** Resolve everything a subject may do on `at`. Returns { entitlements: {key: {...}}, sources: [...] }. */
export async function resolveEntitlements(subjectType, subjectId, { at = new Date(), depth = 0 } = {}) {
  const map = {};
  const sources = [];
  const t = at.toISOString();

  // 1 default plan of this actor type
  const def = await one(`SELECT id, key FROM commercial_plans WHERE is_default AND status = 'active' AND $1 = ANY(eligible_actors) ORDER BY created_at LIMIT 1`, [subjectType]);
  if (def) {
    const v = await selectVersion(def.id, { at, currency: null, interval: null }).catch(() => null);
    if (v) { for (const e of await entitlementsOf(v.id)) applyReplace(map, e, `default:${def.key}@v${v.version}`); sources.push(`default:${def.key}@v${v.version}`); }
  }
  // 2 parent
  if (depth < MAX_DEPTH) {
    const link = await one('SELECT parent_type, parent_id FROM commercial_subject_links WHERE child_type = $1 AND child_id = $2 AND ended_at IS NULL', [subjectType, subjectId]);
    if (link) {
      const parent = await resolveEntitlements(link.parent_type, link.parent_id, { at, depth: depth + 1 });
      for (const [k, v] of Object.entries(parent.entitlements)) map[k] = { ...v, sources: [`parent:${link.parent_type}`, ...v.sources] };
      sources.push(`parent:${link.parent_type}`);
    }
  }
  // 3-5 own subscriptions
  const subs = (await many(`SELECT s.*, p.key AS plan_key FROM commercial_subscriptions s JOIN commercial_plans p ON p.id = s.plan_id
                              WHERE s.subject_type = $1 AND s.subject_id = $2 AND s.status IN ('trial','active') ORDER BY s.created_at`, [subjectType, subjectId])).filter((s) => inForce(s, at));
  // one live base plan per profile family (athlete, coach, organiser…): the first replaces the layer below, every further one adds to it
  const bases = subs.filter((s) => s.kind === 'base').sort((x, y) => x.plan_key.localeCompare(y.plan_key));
  const heldKeys = new Set([...bases.map((x) => x.plan_key), def?.key].filter(Boolean));
  for (const [n, base] of bases.entries()) {
    const vid = effectiveVersionId(base, at);
    const v = await one('SELECT v.version, p.key FROM commercial_price_versions v JOIN commercial_plans p ON p.id = v.plan_id WHERE v.id = $1', [vid]);
    for (const e of await entitlementsOf(vid)) (n === 0 ? applyReplace : applyAdd)(map, e, `base:${v.key}@v${v.version}`);
    sources.push(`base:${v.key}@v${v.version}`);
  }
  for (const s of subs.filter((x) => x.kind === 'addon')) {
    const plan = await one('SELECT requires FROM commercial_plans WHERE id = $1', [s.plan_id]);
    if (plan.requires?.length && !plan.requires.some((k) => heldKeys.has(k))) continue; // dependency not met: the add-on grants nothing
    const vid = effectiveVersionId(s, at);
    const v = await one('SELECT v.version, p.key FROM commercial_price_versions v JOIN commercial_plans p ON p.id = v.plan_id WHERE v.id = $1', [vid]);
    for (const e of await entitlementsOf(vid)) applyAdd(map, e, `addon:${v.key}@v${v.version}`);
    sources.push(`addon:${v.key}@v${v.version}`);
  }
  for (const s of subs.filter((x) => x.promotion_id)) {
    const promo = await one(`SELECT key, grants FROM commercial_promotions WHERE id = $1 AND status = 'active' AND starts_on <= $2::date AND (ends_on IS NULL OR ends_on >= $2::date)`, [s.promotion_id, day(at)]);
    if (!promo) continue;
    for (const g of promo.grants ?? []) applyAdd(map, { key: g.key, limit_value: g.limit_value ?? null }, `promotion:${promo.key}`);
    sources.push(`promotion:${promo.key}`);
  }
  // 6 contract override, 7 enterprise override (set on an ancestor)
  const live = `status = 'active' AND starts_on <= $1::date AND (ends_on IS NULL OR ends_on >= $1::date)`;
  for (const o of await many(`SELECT * FROM commercial_overrides WHERE scope = 'contract' AND subject_type = $2 AND subject_id = $3 AND ${live} ORDER BY created_at`, [day(at), subjectType, subjectId])) applyOverride(map, o, `contract_override:${o.id.slice(0, 8)}`);
  for (const a of await ancestors(subjectType, subjectId)) {
    for (const o of await many(`SELECT * FROM commercial_overrides WHERE scope = 'enterprise' AND subject_type = $2 AND subject_id = $3 AND ${live} ORDER BY created_at`, [day(at), a.type, a.id])) applyOverride(map, o, `enterprise_override:${o.id.slice(0, 8)}`);
  }
  return { subject_type: subjectType, subject_id: subjectId, at: t, entitlements: map, sources };
}

/** A key is governed once any version or override defines it; an ungoverned key is not monetised and is always allowed (so modules can adopt the engine gradually). */
export async function isGoverned(key) {
  return !!(await one('SELECT 1 FROM commercial_version_entitlements WHERE key = $1 UNION ALL SELECT 1 FROM commercial_overrides WHERE key = $1 LIMIT 1', [key]));
}

export function decide(resolved, key) {
  const e = resolved.entitlements[key];
  const allowed = !!e && e.enabled && (e.limit == null || e.limit > 0);
  return { key, allowed, limit: e?.limit ?? null, behaviour: e?.behaviour ?? 'hard', warn_at_pct: e?.warn_at_pct ?? 80, sources: e?.sources ?? [] };
}

/** Throws 402 `not_entitled` unless the subject holds the entitlement (ungoverned keys pass). The one call modules make instead of testing plan names. */
export async function requireEntitlement(subjectType, subjectId, key, opts = {}) {
  if (!(await isGoverned(key))) return { key, allowed: true, governed: false };
  const d = decide(await resolveEntitlements(subjectType, subjectId, opts), key);
  if (!d.allowed) throw new AppError(402, 'not_entitled', `Your plan does not include ${key}`, { key, sources: d.sources });
  return { ...d, governed: true };
}

// ------------------------------------------------------------------ usage
const GAUGES = {
  staff_seats: {
    organisation: "SELECT count(*)::int AS n FROM organisation_members WHERE organisation_id = $1 AND status = 'active'",
    venue: 'SELECT count(*)::int AS n FROM venue_staff WHERE venue_id = $1 AND removed_at IS NULL',
  },
  teams: { organisation: 'SELECT count(*)::int AS n FROM teams WHERE organisation_id = $1', user: 'SELECT count(*)::int AS n FROM teams WHERE owner_id = $1' },
  active_athletes: {
    organisation: "SELECT count(DISTINCT m.user_id)::int AS n FROM team_members m JOIN teams t ON t.id = m.team_id WHERE t.organisation_id = $1 AND m.status = 'active'",
    team: "SELECT count(DISTINCT user_id)::int AS n FROM team_members WHERE team_id = $1 AND status = 'active'",
  },
  locations: { user: 'SELECT count(*)::int AS n FROM venues WHERE owner_id = $1' },
};

export async function liveCount(subjectType, subjectId, key) {
  const sql = GAUGES[key]?.[subjectType];
  if (!sql) throw badRequest(`${key} cannot be counted live for a ${subjectType}`);
  return (await one(sql, [subjectId])).n;
}

const periodStart = (meter, at) => {
  const d = new Date(at);
  if (meter.period === 'month') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  if (meter.period === 'year') return `${d.getUTCFullYear()}-01-01`;
  return '2000-01-01';
};

const limitError = (key, used, limit) => new AppError(402, 'limit_reached', `The ${key} limit of your plan is reached (${used}/${limit})`, { key, used, limit });

/**
 * Add `quantity` to a counter meter. Atomic and retry safe: the usage row is locked for the whole step, a repeated idempotency key replays
 * the first answer without counting again, and a hard limit refuses the whole step (nothing is recorded). soft/warn only flag.
 */
export async function consume({ subjectType, subjectId, key, quantity = 1, idempotencyKey, actorId = null, at = new Date() }) {
  if (!(quantity > 0)) throw badRequest('quantity must be positive');
  const meter = await one('SELECT * FROM commercial_meters WHERE key = $1', [key]);
  if (!meter) throw notFound('Meter');
  if (meter.mode === 'gauge') throw badRequest(`${key} is counted live; use assertCapacity`);
  const governed = await isGoverned(key);
  const d = governed ? decide(await resolveEntitlements(subjectType, subjectId, { at }), key) : { allowed: true, limit: null, behaviour: 'hard', warn_at_pct: 80 };
  if (!d.allowed) throw new AppError(402, 'not_entitled', `Your plan does not include ${key}`, { key });
  const ps = periodStart(meter, at);
  try {
    return await tx(async (c) => {
      await c.query('INSERT INTO commercial_usage(subject_type, subject_id, meter_key, period_start) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [subjectType, subjectId, key, ps]);
      const row = (await c.query('SELECT id, used FROM commercial_usage WHERE subject_type=$1 AND subject_id=$2 AND meter_key=$3 AND period_start=$4 FOR UPDATE', [subjectType, subjectId, key, ps])).rows[0];
      const prior = (await c.query('SELECT meter_key, used_after, over_limit, quantity FROM commercial_usage_events WHERE subject_type=$1 AND subject_id=$2 AND idempotency_key=$3', [subjectType, subjectId, idempotencyKey])).rows[0];
      if (prior) {
        if (prior.meter_key !== key || Number(prior.quantity) !== Number(quantity)) throw conflict('That idempotency key was already used for a different request');
        return { key, used: Number(prior.used_after), limit: d.limit, remaining: d.limit == null ? null : Math.max(0, d.limit - Number(row.used)), over_limit: prior.over_limit, warning: false, replayed: true };
      }
      const next = Number(row.used) + Number(quantity);
      const over = d.limit != null && next > d.limit;
      if (over && d.behaviour === 'hard') throw limitError(key, Number(row.used), d.limit);
      await c.query('UPDATE commercial_usage SET used = $2, updated_at = now() WHERE id = $1', [row.id, next]);
      await c.query('INSERT INTO commercial_usage_events(subject_type, subject_id, meter_key, period_start, quantity, idempotency_key, used_after, over_limit, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [subjectType, subjectId, key, ps, quantity, idempotencyKey, next, over, actorId]);
      const warning = d.limit != null && (over || next >= (d.limit * d.warn_at_pct) / 100);
      return { key, used: next, limit: d.limit, remaining: d.limit == null ? null : Math.max(0, d.limit - next), over_limit: over, warning, replayed: false };
    });
  } catch (e) {
    if (e.code === '23505') throw conflict('That idempotency key was already used for a different request');
    throw e;
  }
}

/** Authoritative capacity check for gauge meters (seats, athletes, teams, locations): counts live rows, never an estimate. */
export async function assertCapacity(subjectType, subjectId, key, { delta = 1, at = new Date() } = {}) {
  if (!(await isGoverned(key))) return { key, governed: false, allowed: true };
  const d = decide(await resolveEntitlements(subjectType, subjectId, { at }), key);
  if (!d.allowed) throw new AppError(402, 'not_entitled', `Your plan does not include ${key}`, { key });
  const used = await liveCount(subjectType, subjectId, key);
  const over = d.limit != null && used + delta > d.limit;
  if (over && d.behaviour === 'hard') throw limitError(key, used, d.limit);
  return { key, governed: true, allowed: true, used, limit: d.limit, over_limit: over, warning: d.limit != null && (over || used + delta >= (d.limit * d.warn_at_pct) / 100) };
}

/** Everything a subject has used: counters for the current period plus live gauges, next to the limits that apply. */
export async function usageSummary(subjectType, subjectId, { at = new Date() } = {}) {
  const resolved = await resolveEntitlements(subjectType, subjectId, { at });
  const meters = await many('SELECT * FROM commercial_meters ORDER BY key');
  const out = [];
  for (const m of meters) {
    const e = resolved.entitlements[m.key];
    let used = 0;
    if (m.mode === 'gauge') used = GAUGES[m.key]?.[subjectType] ? await liveCount(subjectType, subjectId, m.key) : null;
    else used = Number((await one('SELECT used FROM commercial_usage WHERE subject_type=$1 AND subject_id=$2 AND meter_key=$3 AND period_start=$4', [subjectType, subjectId, m.key, periodStart(m, at)]))?.used ?? 0);
    if (used == null && !e) continue;
    const limit = e?.limit ?? null;
    out.push({ key: m.key, name: m.name, unit: m.unit, mode: m.mode, period: m.period, used, limit, behaviour: e?.behaviour ?? null, governed: !!e, over_limit: limit != null && used != null && used > limit, warning: limit != null && used != null && used >= (limit * (e?.warn_at_pct ?? 80)) / 100 });
  }
  return out;
}

// ------------------------------------------------------------------ quotes & subscriptions
const digestOf = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

async function loadPromotion(key, at) {
  if (!key) return null;
  const p = await one('SELECT * FROM commercial_promotions WHERE key = $1', [key]);
  if (!p || p.status !== 'active' || new Date(p.starts_on) > at || (p.ends_on && new Date(p.ends_on) < at)) throw badRequest('That offer is not available');
  if (p.max_redemptions != null) {
    const n = (await one('SELECT count(*)::int AS n FROM commercial_subscriptions WHERE promotion_id = $1', [p.id])).n;
    if (n >= p.max_redemptions) throw badRequest('That offer has been fully redeemed');
  }
  p.price_points = (await many('SELECT price_point_code FROM commercial_promotion_price_points WHERE promotion_id = $1 AND removed_at IS NULL ORDER BY 1', [p.id])).map((r) => r.price_point_code);
  return p;
}

/**
 * What an offer does to one priced version: a per-term schedule for the terms the offer covers, then the regular price.
 *  free_months   monthly price: the first N terms cost nothing; annual / one-off: the first term is full price but lasts N months longer
 *  percent_off   that % off every term for duration_months;  flat_off  that amount (capped at the price) off every term for duration_months
 * "Terms" are billing periods: a monthly plan has duration_months terms, an annual plan ceil(duration_months / 12).
 */
export function applyPromotion(version, subtotalMinor, promo) {
  const tax = (n) => Math.round((n * version.tax_bp) / 10000);
  const termsOf = (months) => (version.billing_interval === 'monthly' ? months : version.billing_interval === 'annual' ? Math.ceil(months / 12) : 1);
  const empty = { schedule: [], first_discount_minor: 0, extra_free_months: 0, terms_covered: 0 };
  if (!promo || promo.benefit === 'none') return empty;
  let n = 0; let extra = 0; let off = () => 0;
  if (promo.benefit === 'free_months') {
    if (version.billing_interval === 'monthly') { n = promo.free_months; off = () => subtotalMinor; } else extra = promo.free_months;
  } else if (promo.benefit === 'percent_off') { n = termsOf(promo.duration_months); off = () => Math.round((subtotalMinor * promo.discount_bp) / 10000); }
  else if (promo.benefit === 'flat_off') {
    if (promo.flat_currency !== version.currency) throw badRequest(`That offer is in ${promo.flat_currency}; this price is in ${version.currency}`);
    n = termsOf(promo.duration_months); off = () => Math.min(subtotalMinor, Number(promo.flat_off_minor));
  }
  const schedule = Array.from({ length: n }, (_, i) => { const d = off(); return { term: i + 1, subtotal_minor: subtotalMinor, discount_minor: d, tax_minor: tax(subtotalMinor - d), total_minor: subtotalMinor - d + tax(subtotalMinor - d) }; });
  return { schedule, first_discount_minor: schedule[0]?.discount_minor ?? 0, extra_free_months: extra, terms_covered: n };
}

// ------------------------------------------------------------------ bundles
/** The price-point code of a bundle: offers attach to it exactly like to a plan's price point. */
export const bundleCode = (b) => `bundle.${b.key}:${b.billing_interval}:${b.currency}:${b.region}`;
export const isBundleCode = (code) => String(code).startsWith('bundle.');

/** Split an amount across weights (largest remainder, so the parts add up exactly). All-zero weights share equally. */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const wsum = w.reduce((a, b) => a + b, 0);
  const raw = w.map((x) => (total * x) / wsum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - Math.floor(r), i]).sort((x, y) => y[0] - x[0] || x[1] - y[1]).forEach(([, i]) => { if (left > 0) { out[i] += 1; left -= 1; } });
  return out;
}

/** The published bundle price in force on `at`. */
export async function selectBundleVersion(bundleId, at = new Date(), c) {
  return (await (c ?? { query }).query(
    `SELECT * FROM commercial_bundle_versions WHERE bundle_id = $1 AND status = 'published' AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC, version DESC LIMIT 1`, [bundleId, day(at)])).rows[0] ?? null;
}

/** Price a bundle: the members' list prices, the bundle price (fixed, % off or flat off the list) and each member's share of it. */
export async function priceBundle(bundle, at = new Date()) {
  const bv = await selectBundleVersion(bundle.id, at);
  if (!bv) throw badRequest(`${bundle.name} has no price in force`);
  const codes = (await many('SELECT price_point_code FROM commercial_bundle_items WHERE bundle_id = $1 ORDER BY price_point_code', [bundle.id])).map((r) => r.price_point_code);
  const members = [];
  for (const code of codes) {
    const x = parsePricePointCode(code);
    const plan = await one("SELECT * FROM commercial_plans WHERE key = $1 AND status = 'active'", [x.plan_key]);
    if (!plan) throw badRequest(`${code} is no longer on sale`);
    const v = await selectVersion(plan.id, { region: x.region, currency: x.currency, interval: x.billing_interval, at });
    if (!v) throw badRequest(`${code} has no price in force`);
    members.push({ plan, v, code, list_minor: priceVersion(v, {}).subtotal_minor });
  }
  const list = members.reduce((a, m) => a + m.list_minor, 0);
  const subtotal = bv.price_mode === 'fixed' ? Number(bv.amount_minor) : bv.price_mode === 'percent_off' ? Math.round((list * (10000 - bv.discount_bp)) / 10000) : Math.max(0, list - Number(bv.amount_minor));
  const shares = allocate(subtotal, members.map((m) => m.list_minor));
  return { bundle, bv, members: members.map((m, i) => ({ ...m, share_minor: shares[i] })), list_minor: list, subtotal_minor: subtotal, saving_minor: list - subtotal };
}

async function createBundleQuote({ subjectType, subjectId, user, bundleKey, promotionKey, at = new Date(), persist = true }) {
  const bundle = await one("SELECT * FROM commercial_bundles WHERE key = $1 AND status = 'active'", [bundleKey]);
  if (!bundle) throw notFound('Bundle');
  if (!bundle.eligible_actors.includes(subjectType)) throw badRequest(`${bundle.name} is not offered to a ${subjectType}`);
  const pr = await priceBundle(bundle, at);
  const code = bundleCode(bundle);
  const promo = await loadPromotion(promotionKey, at);
  if (promo && !offerAppliesTo(promo, code)) throw badRequest(`That offer does not apply to bundle ${code} (it is attached to: ${promo.price_points.join(', ')})`);
  const pseudo = { tax_bp: pr.bv.tax_bp, billing_interval: bundle.billing_interval, currency: bundle.currency };
  const ap = applyPromotion(pseudo, pr.subtotal_minor, promo);
  const discount = ap.first_discount_minor;
  const tax = Math.round(((pr.subtotal_minor - discount) * pr.bv.tax_bp) / 10000);
  const total = pr.subtotal_minor - discount + tax;
  const trialDays = Math.max(promo?.trial_days ?? 0, ...pr.members.map((m) => m.v.trial_days));
  const lines = pr.members.map((m) => ({ kind: 'bundle_member', label: m.plan.name, plan_key: m.plan.key, price_point_code: m.code, version_id: m.v.id, version: m.v.version, billing_interval: bundle.billing_interval, quantity: 1, list_minor: m.list_minor, amount_minor: m.share_minor }));
  const bundleInfo = { key: bundle.key, name: bundle.name, price_point_code: code, version_id: pr.bv.id, version: pr.bv.version, price_mode: pr.bv.price_mode, list_minor: pr.list_minor, saving_minor: pr.saving_minor };
  const schedule = promo ? [{ bundle_key: bundle.key, price_point_code: code, regular_total_minor: pr.subtotal_minor + Math.round((pr.subtotal_minor * pr.bv.tax_bp) / 10000), terms: ap.schedule }] : [];
  const body = { subject_type: subjectType, subject_id: subjectId, currency: bundle.currency, lines, terms: [], subtotal_minor: pr.subtotal_minor, discount_minor: discount, tax_minor: tax, total_minor: total, version_ids: pr.members.map((m) => m.v.id), promotion: promo?.key ?? null, trial_days: trialDays, extra_free_months: ap.extra_free_months, promotion_terms: ap.terms_covered, schedule, bundle: bundleInfo };
  if (!persist) return { ...body, persisted: false };
  const quoteNo = `Q-${day(at).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const row = await one(
    `INSERT INTO commercial_quotes(quote_no, subject_type, subject_id, requested_by, currency, lines, subtotal_minor, discount_minor, tax_minor, total_minor, version_ids, promotion_id, inputs, expires_at, digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + interval '7 days', $14) RETURNING *`,
    [quoteNo, subjectType, subjectId, user.id, bundle.currency, JSON.stringify({ lines, terms: [], trial_days: trialDays, extra_free_months: ap.extra_free_months, schedule, bundle: bundleInfo }), pr.subtotal_minor, discount, tax, total, body.version_ids, promo?.id ?? null, JSON.stringify({ bundle_key: bundleKey }), digestOf(body)]);
  return { ...body, id: row.id, quote_no: row.quote_no, expires_at: row.expires_at, status: row.status, digest: row.digest, persisted: true };
}

/** Freeze a quote for a subject: the lines, tax and total payments take as given. Persisted and immutable. */
export async function createQuote({ subjectType, subjectId, user, items, region = 'IN', currency, promotionKey, usage, gmv_minor, at = new Date(), persist = true }) {
  if (!items?.length) throw badRequest('Nothing to quote');
  if (items.some((x) => x.bundle_key)) {
    if (items.length > 1) throw badRequest('A bundle is quoted on its own');
    return createBundleQuote({ subjectType, subjectId, user, bundleKey: items[0].bundle_key, promotionKey, at, persist });
  }
  const lines = []; const terms = []; const versionIds = [];
  let subtotal = 0; let discount = 0; let tax = 0; let applied = null; const promo = await loadPromotion(promotionKey, at); let cur = currency ?? null; let trialDays = 0; let extraFree = 0; let termsCovered = 0; const schedules = [];
  for (const it of items) {
    const plan = await one('SELECT * FROM commercial_plans WHERE key = $1 AND status = $2', [it.plan_key, 'active']);
    if (!plan) throw notFound('Plan');
    if (!plan.eligible_actors.includes(subjectType)) throw badRequest(`${plan.name} is not offered to a ${subjectType}`);
    const v = await selectVersion(plan.id, { region, currency: cur, interval: it.billing_interval, at });
    if (!v) throw badRequest(`${plan.name} has no price in force for ${region}${cur ? ` in ${cur}` : ''}`);
    if (cur && v.currency !== cur) throw badRequest('All items in a quote must use one currency');
    cur = v.currency;
    const priced = priceVersion(v, { quantities: it.quantities, usage, gmv_minor });
    const p = promo && offerAppliesTo(promo, versionCode(v)) ? promo : null;
    const ap = applyPromotion(v, priced.subtotal_minor, p);
    const itemDiscount = ap.first_discount_minor;
    if (p) { applied = p; trialDays = Math.max(trialDays, p.trial_days); extraFree = Math.max(extraFree, ap.extra_free_months); termsCovered = Math.max(termsCovered, ap.terms_covered); schedules.push({ plan_key: plan.key, price_point_code: versionCode(v), version_id: v.id, regular_total_minor: priced.subtotal_minor + Math.round((priced.subtotal_minor * v.tax_bp) / 10000), terms: ap.schedule }); }
    if (v.trial_days) trialDays = Math.max(trialDays, v.trial_days);
    versionIds.push(v.id);
    for (const l of priced.lines) lines.push({ ...l, plan_key: plan.key, price_point_code: versionCode(v), version_id: v.id, version: v.version, billing_interval: v.billing_interval });
    for (const t of priced.terms) terms.push({ ...t, plan_key: plan.key, version_id: v.id });
    subtotal += priced.subtotal_minor; discount += itemDiscount;
    tax += Math.round(((priced.subtotal_minor - itemDiscount) * v.tax_bp) / 10000);
  }
  if (promo && !applied) throw badRequest(`That offer does not apply to this price point (it is attached to: ${promo.price_points.join(', ')})`);
  const total = subtotal - discount + tax;
  const body = { subject_type: subjectType, subject_id: subjectId, currency: cur, lines, terms, subtotal_minor: subtotal, discount_minor: discount, tax_minor: tax, total_minor: total, version_ids: versionIds, promotion: applied?.key ?? null, trial_days: trialDays, extra_free_months: extraFree, promotion_terms: termsCovered, schedule: schedules };
  if (!persist) return { ...body, persisted: false };
  const quoteNo = `Q-${day(at).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const row = await one(
    `INSERT INTO commercial_quotes(quote_no, subject_type, subject_id, requested_by, currency, lines, subtotal_minor, discount_minor, tax_minor, total_minor, version_ids, promotion_id, inputs, expires_at, digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + interval '7 days', $14) RETURNING *`,
    [quoteNo, subjectType, subjectId, user.id, cur, JSON.stringify({ lines, terms, trial_days: trialDays, extra_free_months: extraFree, schedule: schedules }), subtotal, discount, tax, total, versionIds, applied?.id ?? null, JSON.stringify({ items, region, usage: usage ?? {}, gmv_minor: gmv_minor ?? 0 }), digestOf(body)]);
  return { ...body, id: row.id, quote_no: row.quote_no, expires_at: row.expires_at, status: row.status, digest: row.digest, persisted: true };
}

/** Insert one subscription row (shared by a single plan and by each member of a bundle). */
async function insertSubscription(c, { subjectType, subjectId, plan, versionId, promoId, status, quantities = {}, at, interval, quote, userId, bundleVersionId = null, bundleGroup = null, allocated = null }) {
  const trial = status === 'trial';
  const start = status === 'pending_payment' ? null : at;
  let end = start ? addInterval(start, interval) : null;
  if (end && quote.extra_free_months) end = new Date(new Date(end).setUTCMonth(end.getUTCMonth() + quote.extra_free_months)); // free months on an annual / one-off price extend the first period
  const trialEnd = trial ? new Date(at.getTime() + quote.trial_days * DAY) : null;
  const s = (await c.query(
    `INSERT INTO commercial_subscriptions(subject_type, subject_id, plan_id, product_id, kind, version_id, promotion_id, status, quantities, started_at, current_period_start, current_period_end, trial_ends_at, quote_id, created_by,
                                          promotion_terms_total, promotion_terms_used, bundle_version_id, bundle_group, allocated_minor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [subjectType, subjectId, plan.id, plan.product_id, plan.kind, versionId, promoId, status, JSON.stringify(quantities), start, trial ? trialEnd : end, trialEnd, quote.id, userId,
      quote.promotion_terms, quote.promotion_terms && status !== 'pending_payment' && !trial ? 1 : 0, bundleVersionId, bundleGroup, allocated])).rows[0];
  return s;
}

/** An add-on needs one of its `requires` plans among what the subject holds (or its default plan). */
async function checkAddonRequires(c, plan, subjectType, subjectId, alsoHeld = []) {
  if (plan.kind !== 'addon' || !plan.requires?.length) return;
  const have = (await c.query(`SELECT p.key FROM commercial_subscriptions s JOIN commercial_plans p ON p.id = s.plan_id WHERE s.subject_type=$1 AND s.subject_id=$2 AND s.kind='base' AND s.status IN ('trial','active','pending_payment')`, [subjectType, subjectId])).rows.map((r) => r.key);
  const def = (await c.query(`SELECT key FROM commercial_plans WHERE is_default AND status='active' AND $1 = ANY(eligible_actors)`, [subjectType])).rows.map((r) => r.key);
  if (!plan.requires.some((k) => [...have, ...def, ...alsoHeld].includes(k))) throw badRequest(`${plan.name} needs one of: ${plan.requires.join(', ')}`);
}

const startStatus = (quote) => (quote.trial_days > 0 ? 'trial' : quote.total_minor === 0 ? 'active' : 'pending_payment');

/** Subscribe a subject to a plan. Free (or fully trialled) plans start at once; a paid plan waits for payment against its frozen quote. */
export async function subscribe({ subjectType, subjectId, user, planKey, billingInterval, region = 'IN', currency, quantities = {}, promotionKey, at = new Date() }) {
  const plan = await one("SELECT * FROM commercial_plans WHERE key = $1 AND status = 'active'", [planKey]);
  if (!plan) throw notFound('Plan');
  if (!plan.eligible_actors.includes(subjectType)) throw badRequest(`${plan.name} is not offered to a ${subjectType}`);
  const quote = await createQuote({ subjectType, subjectId, user, items: [{ plan_key: planKey, billing_interval: billingInterval, quantities }], region, currency, promotionKey, at });
  const v = await one('SELECT * FROM commercial_price_versions WHERE id = $1', [quote.version_ids[0]]);
  const status = startStatus(quote);
  const promo = quote.promotion ? await one('SELECT id FROM commercial_promotions WHERE key = $1', [quote.promotion]) : null;
  try {
    return await tx(async (c) => {
      await checkAddonRequires(c, plan, subjectType, subjectId);
      const s = await insertSubscription(c, { subjectType, subjectId, plan, versionId: v.id, promoId: promo?.id ?? null, status, quantities, at, interval: v.billing_interval, quote, userId: user.id });
      await commercialAudit(c, user.id, 'subscribe', 'commercial_subscriptions', s.id, { plan: plan.key, version: v.version, status });
      return { subscription: s, quote };
    });
  } catch (e) {
    if (e.code === '23505') throw conflict(plan.kind === 'base' ? 'This account already has a plan for that profile; schedule a change instead' : 'This add-on is already held');
    throw e;
  }
}

/** Subscribe a subject to a bundle: one subscription per member (each pinned to the version bought), sharing the bundle price and a bundle group. */
export async function subscribeBundle({ subjectType, subjectId, user, bundleKey, promotionKey, at = new Date() }) {
  const quote = await createQuote({ subjectType, subjectId, user, items: [{ bundle_key: bundleKey }], promotionKey, at });
  const status = startStatus(quote);
  const promo = quote.promotion ? await one('SELECT id FROM commercial_promotions WHERE key = $1', [quote.promotion]) : null;
  const group = crypto.randomUUID();
  try {
    return await tx(async (c) => {
      const plans = [];
      for (const l of quote.lines) plans.push((await c.query('SELECT * FROM commercial_plans WHERE key = $1', [l.plan_key])).rows[0]);
      const bases = plans.filter((p) => p.kind === 'base').map((p) => p.key);
      for (const p of plans.filter((x) => x.kind === 'addon')) await checkAddonRequires(c, p, subjectType, subjectId, bases);
      const subs = [];
      for (const [i, l] of quote.lines.entries()) {
        subs.push(await insertSubscription(c, { subjectType, subjectId, plan: plans[i], versionId: l.version_id, promoId: promo?.id ?? null, status, at, interval: quote.bundle ? l.billing_interval : l.billing_interval, quote, userId: user.id, bundleVersionId: quote.bundle.version_id, bundleGroup: group, allocated: l.amount_minor }));
      }
      await commercialAudit(c, user.id, 'subscribe_bundle', 'commercial_subscriptions', subs[0].id, { bundle: bundleKey, version: quote.bundle.version, members: subs.length, status });
      return { subscriptions: subs, quote, bundle_group: group };
    });
  } catch (e) {
    if (e.code === '23505') throw conflict('One of the profiles in this bundle already has a plan; end it or change it first');
    throw e;
  }
}

/** Payment confirmed (the hook payments #498 calls): a pending subscription starts. */
export async function activateSubscription(id, actorId, at = new Date()) {
  return tx(async (c) => {
    const s = (await c.query('SELECT * FROM commercial_subscriptions WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!s) throw notFound('Subscription');
    if (s.status !== 'pending_payment') throw conflict('Only a subscription awaiting payment can be activated');
    // a bundle is paid once: every member of its group starts together
    const members = s.bundle_group ? (await c.query("SELECT * FROM commercial_subscriptions WHERE bundle_group = $1 AND status = 'pending_payment' FOR UPDATE", [s.bundle_group])).rows : [s];
    let mine = null;
    for (const m of members) {
      const iv = (await c.query('SELECT billing_interval FROM commercial_price_versions WHERE id = $1', [m.version_id])).rows[0].billing_interval;
      const u = (await c.query("UPDATE commercial_subscriptions SET status='active', started_at=$2, current_period_start=$2, current_period_end=$3 WHERE id=$1 RETURNING *", [m.id, at, addInterval(at, iv)])).rows[0];
      if (m.id === id) mine = u;
      await commercialAudit(c, actorId, 'activate', 'commercial_subscriptions', m.id);
    }
    if (s.quote_id) await c.query("UPDATE commercial_quotes SET status='accepted' WHERE id=$1", [s.quote_id]);
    return mine;
  });
}

/** Stop renewal: an unpaid one is cancelled outright; a running one ends at the end of its paid period. History and data are kept. */
export async function cancelSubscription(id, actorId, at = new Date()) {
  return tx(async (c) => {
    const s = (await c.query('SELECT * FROM commercial_subscriptions WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!s) throw notFound('Subscription');
    if (['cancelled', 'ended'].includes(s.status)) return s;
    // a bundle is ended as a whole
    const members = s.bundle_group ? (await c.query("SELECT * FROM commercial_subscriptions WHERE bundle_group = $1 AND status NOT IN ('cancelled','ended') FOR UPDATE", [s.bundle_group])).rows : [s];
    let mine = s;
    for (const m of members) {
      const outright = m.status === 'pending_payment' || !m.current_period_end;
      const u = (await c.query(
        `UPDATE commercial_subscriptions SET cancel_at_period_end = true, non_renewing = true,
                status = CASE WHEN $2 THEN 'cancelled' ELSE status END, ended_at = CASE WHEN $2 THEN $3::timestamptz ELSE ended_at END WHERE id = $1 RETURNING *`, [m.id, outright, at])).rows[0];
      if (m.id === id) mine = u;
      await commercialAudit(c, actorId, 'cancel', 'commercial_subscriptions', m.id, { outright, bundle_group: m.bundle_group });
    }
    return mine;
  });
}

/** Upgrade / downgrade / re-price: the new version takes effect now or at the period end; the old pinned version stays until then. */
export async function scheduleChange({ id, actorId, planKey, billingInterval, region = 'IN', currency, effective = 'period_end', at = new Date() }) {
  return tx(async (c) => {
    const s = (await c.query('SELECT s.*, v.amount_minor, v.proration_policy FROM commercial_subscriptions s JOIN commercial_price_versions v ON v.id = s.version_id WHERE s.id = $1 FOR UPDATE', [id])).rows[0];
    if (!s) throw notFound('Subscription');
    if (!['trial', 'active'].includes(s.status)) throw conflict('Only a running subscription can change');
    if (s.bundle_group) throw conflict('This plan is part of a bundle: end the bundle to change it');
    const plan = (await c.query("SELECT * FROM commercial_plans WHERE key = $1 AND status = 'active'", [planKey])).rows[0];
    if (!plan || plan.kind !== s.kind || !plan.eligible_actors.includes(s.subject_type)) throw badRequest('That plan cannot replace the current one');
    const v = await selectVersion(plan.id, { region, currency, interval: billingInterval, at, c });
    if (!v) throw badRequest('That plan has no price in force');
    const when = effective === 'now' ? at : (s.current_period_end ?? at);
    let credit = 0;
    if (effective === 'now' && ['prorate', 'credit'].includes(v.proration_policy) && s.current_period_end && s.current_period_start) {
      const left = Math.max(0, new Date(s.current_period_end) - at) / Math.max(1, new Date(s.current_period_end) - new Date(s.current_period_start));
      credit = Math.round(Number(s.amount_minor) * left);
    }
    const u = (await c.query('UPDATE commercial_subscriptions SET scheduled_version_id=$2, scheduled_for=$3, cancel_at_period_end=false, non_renewing=false WHERE id=$1 RETURNING *', [id, v.id, when])).rows[0];
    await commercialAudit(c, actorId, 'schedule_change', 'commercial_subscriptions', id, { to_plan: plan.key, to_version: v.version, effective: when, proration_policy: v.proration_policy, credit_minor: credit });
    return { subscription: u, effective_at: when, proration: { policy: v.proration_policy, credit_minor: credit } };
  });
}

/** Make a due scheduled change permanent (the pinned version becomes the new one). Called before reading a subject's account. */
export async function applyDueChanges(subjectType, subjectId, at = new Date()) {
  const due = await many(`SELECT s.id, s.scheduled_version_id, v.plan_id FROM commercial_subscriptions s JOIN commercial_price_versions v ON v.id = s.scheduled_version_id
                            WHERE s.subject_type=$1 AND s.subject_id=$2 AND s.scheduled_version_id IS NOT NULL AND s.scheduled_for <= $3 AND s.status IN ('trial','active')`, [subjectType, subjectId, at]);
  for (const d of due) {
    await tx(async (c) => {
      await c.query('UPDATE commercial_subscriptions SET version_id=scheduled_version_id, plan_id=$2, scheduled_version_id=NULL, scheduled_for=NULL, current_period_start=$3 WHERE id=$1', [d.id, d.plan_id, at]);
      await commercialAudit(c, null, 'apply_change', 'commercial_subscriptions', d.id);
    });
  }
  return due.length;
}
