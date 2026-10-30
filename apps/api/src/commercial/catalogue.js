// Catalogue authoring: draft -> published price versions with their entitlements, plus the idempotent import of a catalogue document.
import { z } from 'zod';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { bundleCode, commercialAudit, parsePricePointCode, pricePointCode, priceBundle, priceVersion, selectVersion } from './engine.js';

const label = z.string().min(2).max(80);
const minor = z.number().int().min(0).max(100_000_000_000);

export const component = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), label, category: z.enum(['setup', 'white_label', 'verification', 'platform_fee', 'promoted_listing', 'other']).optional(), amount_minor: minor }),
  z.object({ kind: z.literal('per_unit'), label, unit: z.enum(['seat', 'team', 'location', 'event', 'athlete']), unit_amount_minor: minor, included: z.number().int().min(0).default(0) }),
  z.object({ kind: z.literal('band'), label, unit: z.enum(['seat', 'team', 'location', 'athlete']),
    bands: z.array(z.object({ up_to: z.number().int().min(1).nullable(), amount_minor: minor })).min(1).max(20) }),
  z.object({ kind: z.literal('usage'), label, meter: z.string().regex(/^[a-z0-9_]{2,40}$/), unit_amount_minor: z.number().min(0), included: z.number().min(0).default(0) }),
  z.object({ kind: z.literal('percent_fee'), label, applies_to: z.enum(['transaction', 'booking', 'commission', 'sale']).default('transaction'), bp: z.number().int().min(0).max(10000), cap_minor: minor.optional() }),
]);

export const entitlement = z.object({
  key: z.string().regex(/^[a-z0-9_.]{2,60}$/),
  limit_value: z.number().min(0).nullable().default(null).describe('null = unlimited (or simply "included" for a feature)'),
  limit_behaviour: z.enum(['warn', 'soft', 'hard']).default('hard').describe('warn: flag only · soft: allow but flag over-limit · hard: refuse past the limit'),
  warn_at_pct: z.number().int().min(1).max(100).default(80),
});

const date = z.string().date();
export const versionFields = {
  region: z.string().regex(/^[A-Z]{2}$|^\*$/).default('IN'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  billing_interval: z.enum(['one_time', 'monthly', 'annual', 'per_event', 'usage']),
  amount_minor: minor.default(0),
  components: z.array(component).max(30).default([]),
  tax_bp: z.number().int().min(0).max(10000).default(0),
  tax_ref: z.string().max(60).optional(),
  trial_days: z.number().int().min(0).max(365).default(0),
  proration_policy: z.enum(['none', 'prorate', 'credit', 'at_period_end']).default('none'),
  effective_from: date,
  effective_to: date.optional(),
  entitlements: z.array(entitlement).max(60).default([]),
};
export const versionInput = z.object(versionFields);

const key = z.string().regex(/^[a-z0-9_]{2,60}$/);
const actors = z.array(z.enum(['user', 'organisation', 'team', 'venue', 'event'])).min(1);
export const planInput = z.object({
  key, name: label, kind: z.enum(['base', 'addon']).default('base'), eligible_actors: actors, requires: z.array(key).max(10).default([]), is_default: z.boolean().default(false),
});
export const productInput = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: label,
  family: z.enum(['athlete', 'professional', 'team', 'club', 'academy', 'venue', 'event', 'supplier', 'sponsor', 'education', 'enterprise', 'usage', 'other']),
  description: z.string().max(500).optional(),
});
const promotionBase = z.object({
  key, name: label, kind: z.enum(['trial', 'launch_offer', 'first_term_discount', 'coupon']), all_price_points: z.boolean().default(true).describe('true = every price point; false = only the price_points listed'), price_points: z.array(z.string().max(100)).max(200).default([]).describe('price point codes <plan_key>:<interval>:<currency>:<region>, e.g. team_pro:monthly:INR:IN'), coupon_ref: z.string().max(60).optional(),
  trial_days: z.number().int().min(0).max(365).default(0),
  benefit: z.enum(['none', 'free_months', 'percent_off', 'flat_off']).default('none').describe('free_months: the first N months cost nothing · percent_off / flat_off: that discount on every billing term for duration_months'),
  free_months: z.number().int().min(0).max(60).default(0), discount_bp: z.number().int().min(0).max(10000).default(0),
  flat_off_minor: z.number().int().min(0).default(0), flat_currency: z.string().regex(/^[A-Z]{3}$/).optional(), duration_months: z.number().int().min(1).max(60).default(1),
  grants: z.array(z.object({ key: z.string().regex(/^[a-z0-9_.]{2,60}$/), limit_value: z.number().min(0).nullable().default(null) })).max(30).default([]),
  starts_on: date, ends_on: date.optional(), max_redemptions: z.number().int().min(1).optional(),
  auto_apply: z.boolean().default(false).describe('true = applied automatically to every purchase it fits, no code needed; false = the customer keys in its short code. Offers stack.'),
});
export const promotionInput = promotionBase;
function checkPromotion(i) {
  if (i.benefit === 'free_months' && !(i.free_months > 0)) throw badRequest('Say how many months are free');
  if (i.benefit === 'percent_off' && !(i.discount_bp > 0)) throw badRequest('Say the percentage');
  if (i.benefit === 'flat_off' && !(i.flat_off_minor > 0 && i.flat_currency)) throw badRequest('Give the flat amount and its currency');
  if (i.kind === 'trial' && !(i.trial_days > 0)) throw badRequest('A trial needs its number of days');
}
export const meterInput = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: label, unit: z.string().min(1).max(24), mode: z.enum(['counter', 'gauge']).default('counter'), period: z.enum(['month', 'year', 'lifetime']).default('month'),
});

export async function createProduct(c, i, actor) {
  const p = (await c.query('INSERT INTO commercial_products(key, name, family, description, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.key, i.name, i.family, i.description ?? null, actor])).rows[0];
  await commercialAudit(c, actor, 'create_product', 'commercial_products', p.id, { key: p.key });
  return p;
}

export async function createPlan(c, productId, i, actor) {
  const p = (await c.query('INSERT INTO commercial_plans(product_id, key, name, kind, eligible_actors, requires, is_default, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [productId, i.key, i.name, i.kind, i.eligible_actors, i.requires, i.is_default, actor])).rows[0];
  await commercialAudit(c, actor, 'create_plan', 'commercial_plans', p.id, { key: p.key });
  return p;
}

function checkComponents(i) {
  for (const cmp of i.components ?? []) {
    if (cmp.kind === 'band') {
      const ups = cmp.bands.map((b) => b.up_to);
      if (ups.slice(0, -1).some((u) => u == null)) throw badRequest('Only the last band may be open-ended (up_to null)');
      if (ups.some((u, n) => n > 0 && ups[n - 1] != null && u != null && u <= ups[n - 1])) throw badRequest('Band limits must increase');
    }
  }
}

async function writeEntitlements(c, versionId, list) {
  await c.query('DELETE FROM commercial_version_entitlements WHERE version_id = $1', [versionId]); // draft configuration only (the guard refuses on a published version)
  for (const e of list) await c.query('INSERT INTO commercial_version_entitlements(version_id, key, limit_value, limit_behaviour, warn_at_pct) VALUES ($1,$2,$3,$4,$5)', [versionId, e.key, e.limit_value, e.limit_behaviour, e.warn_at_pct]);
}

export async function createVersionDraft(c, planId, i, actor) {
  checkComponents(i);
  const next = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM commercial_price_versions WHERE plan_id=$1 AND region=$2 AND currency=$3 AND billing_interval=$4', [planId, i.region, i.currency, i.billing_interval])).rows[0].n;
  const v = (await c.query(
    `INSERT INTO commercial_price_versions(plan_id, version, region, currency, billing_interval, amount_minor, components, tax_bp, tax_ref, trial_days, proration_policy, effective_from, effective_to, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [planId, next, i.region, i.currency, i.billing_interval, i.amount_minor, JSON.stringify(i.components), i.tax_bp, i.tax_ref ?? null, i.trial_days, i.proration_policy, i.effective_from, i.effective_to ?? null, actor])).rows[0];
  await writeEntitlements(c, v.id, i.entitlements);
  await commercialAudit(c, actor, 'create_version', 'commercial_price_versions', v.id, { plan_id: planId, version: v.version });
  return v;
}

export async function updateVersionDraft(c, id, i, actor) {
  const v = (await c.query('SELECT * FROM commercial_price_versions WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!v) throw notFound('Price version');
  if (v.status !== 'draft') throw conflict('A published version is immutable; create a new version instead');
  checkComponents(i);
  const u = (await c.query(
    `UPDATE commercial_price_versions SET region=$2, currency=$3, billing_interval=$4, amount_minor=$5, components=$6, tax_bp=$7, tax_ref=$8, trial_days=$9, proration_policy=$10, effective_from=$11, effective_to=$12 WHERE id=$1 RETURNING *`,
    [id, i.region, i.currency, i.billing_interval, i.amount_minor, JSON.stringify(i.components), i.tax_bp, i.tax_ref ?? null, i.trial_days, i.proration_policy, i.effective_from, i.effective_to ?? null])).rows[0];
  await writeEntitlements(c, id, i.entitlements);
  await commercialAudit(c, actor, 'update_draft', 'commercial_price_versions', id);
  return u;
}

/** Publish: the version freezes. The previous published version of the same price slot ends the day before this one starts (a scheduled future price keeps the old one running until then). */
export async function publishVersion(c, id, actor) {
  const v = (await c.query('SELECT * FROM commercial_price_versions WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!v) throw notFound('Price version');
  if (v.status !== 'draft') throw conflict('Only a draft can be published');
  const prev = (await c.query(`SELECT * FROM commercial_price_versions WHERE plan_id=$1 AND region=$2 AND currency=$3 AND billing_interval=$4 AND status='published' AND (effective_to IS NULL OR effective_to >= $5::date) FOR UPDATE`,
    [v.plan_id, v.region, v.currency, v.billing_interval, v.effective_from])).rows;
  for (const p of prev) {
    if (new Date(p.effective_from) >= new Date(v.effective_from)) throw conflict('A published version already starts on or after that date; choose a later effective date');
    await c.query("UPDATE commercial_price_versions SET effective_to = ($2::date - 1) WHERE id=$1", [p.id, v.effective_from]);
  }
  const u = (await c.query("UPDATE commercial_price_versions SET status='published', published_at=now(), published_by=$2 WHERE id=$1 RETURNING *", [id, actor])).rows[0];
  await commercialAudit(c, actor, 'publish_version', 'commercial_price_versions', id, { version: v.version, effective_from: v.effective_from });
  return u;
}

export async function retireVersion(c, id, actor) {
  const v = (await c.query('SELECT * FROM commercial_price_versions WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!v) throw notFound('Price version');
  if (v.status !== 'published') throw conflict('Only a published version can be retired');
  const u = (await c.query("UPDATE commercial_price_versions SET status='retired', effective_to = coalesce(effective_to, current_date) WHERE id=$1 RETURNING *", [id])).rows[0];
  await commercialAudit(c, actor, 'retire_version', 'commercial_price_versions', id);
  return u;
}

// ------------------------------------------------------------------ bundles (several price points of one person sold together)
const bundleKey = z.string().regex(/^[a-z0-9_]{2,40}$/);
export const bundleInput = z.object({
  key: bundleKey, name: label, description: z.string().max(500).optional(),
  eligible_actors: actors.default(['user']),
  billing_interval: z.enum(['monthly', 'annual']), currency: z.string().regex(/^[A-Z]{3}$/).default('INR'), region: z.string().regex(/^[A-Z]{2}$|^\*$/).default('IN'),
  price_points: z.array(z.string().max(100)).min(2).max(10).describe('the price point codes sold together, all in the bundle\'s interval, currency and region'),
});
const bundleVersionFields = {
  price_mode: z.enum(['fixed', 'percent_off', 'flat_off']).describe('fixed: the bundle price · percent_off / flat_off: taken off the members\' list prices'),
  amount_minor: minor.default(0), discount_bp: z.number().int().min(0).max(10000).default(0), tax_bp: z.number().int().min(0).max(10000).default(0),
  effective_from: date, effective_to: date.optional(),
};
export const bundleVersionInput = z.object(bundleVersionFields);

export async function createBundle(c, i, actor) {
  if ((await c.query('SELECT 1 FROM commercial_plans WHERE key=$1', [i.key])).rowCount) throw badRequest('That code is already a plan; choose another for the bundle');
  const codes = [...new Set(i.price_points)];
  if (codes.length < 2) throw badRequest('A bundle needs at least two different price points');
  const products = new Set(); const planKeys = new Set();
  for (const code of codes) {
    const x = parsePricePointCode(code);
    if (pricePointCode(x.plan_key, x.billing_interval, x.currency, x.region) !== code || String(code).startsWith('bundle.')) throw badRequest(`${code} is not a plan price point`);
    if (x.billing_interval !== i.billing_interval || x.currency !== i.currency || x.region !== i.region) throw badRequest(`${code} must be ${i.billing_interval} in ${i.currency} for ${i.region}, like the bundle`);
    const plan = (await c.query("SELECT * FROM commercial_plans WHERE key=$1 AND status='active'", [x.plan_key])).rows[0];
    const exists = plan && (await c.query('SELECT 1 FROM commercial_price_versions WHERE plan_id=$1 AND billing_interval=$2 AND currency=$3 AND region=$4 LIMIT 1', [plan.id, x.billing_interval, x.currency, x.region])).rowCount;
    if (!exists) throw badRequest(`Unknown price point ${code}`);
    if (!i.eligible_actors.every((a) => plan.eligible_actors.includes(a))) throw badRequest(`${plan.name} is not offered to every kind of account this bundle is for`);
    if (planKeys.has(plan.key)) throw badRequest(`${plan.name} appears twice`);
    planKeys.add(plan.key);
    if (plan.kind === 'base') { if (products.has(plan.product_id)) throw badRequest('Two plans of the same profile family cannot be bundled (a person holds one plan per profile)'); products.add(plan.product_id); }
  }
  const b = (await c.query('INSERT INTO commercial_bundles(key, name, description, eligible_actors, region, currency, billing_interval, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [i.key, i.name, i.description ?? null, i.eligible_actors, i.region, i.currency, i.billing_interval, actor])).rows[0];
  for (const code of codes) await c.query('INSERT INTO commercial_bundle_items(bundle_id, price_point_code) VALUES ($1,$2)', [b.id, code]);
  await commercialAudit(c, actor, 'create_bundle', 'commercial_bundles', b.id, { key: b.key, price_points: codes });
  return { ...b, price_point_code: bundleCode(b), price_points: codes };
}

export async function createBundleVersion(c, bundleKeyIn, i, actor) {
  const b = (await c.query('SELECT * FROM commercial_bundles WHERE key=$1', [bundleKeyIn])).rows[0];
  if (!b) throw notFound('Bundle');
  if (i.price_mode === 'fixed' && !(i.amount_minor > 0)) throw badRequest('Give the bundle price');
  if (i.price_mode === 'flat_off' && !(i.amount_minor > 0)) throw badRequest('Give the amount taken off');
  if (i.price_mode === 'percent_off' && !(i.discount_bp > 0)) throw badRequest('Give the percentage taken off');
  const next = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM commercial_bundle_versions WHERE bundle_id=$1', [b.id])).rows[0].n;
  const v = (await c.query(
    `INSERT INTO commercial_bundle_versions(bundle_id, version, price_mode, amount_minor, discount_bp, tax_bp, effective_from, effective_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [b.id, next, i.price_mode, i.price_mode === 'percent_off' ? 0 : i.amount_minor, i.price_mode === 'percent_off' ? i.discount_bp : 0, i.tax_bp, i.effective_from, i.effective_to ?? null, actor])).rows[0];
  await commercialAudit(c, actor, 'create_bundle_version', 'commercial_bundle_versions', v.id, { bundle: b.key, version: v.version });
  return v;
}

/** Publish: a fixed bundle price may not exceed what the members cost apart on its start date. The previous published price ends the day before. */
export async function publishBundleVersion(c, id, actor) {
  const v = (await c.query('SELECT * FROM commercial_bundle_versions WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!v) throw notFound('Bundle price');
  if (v.status !== 'draft') throw conflict('Only a draft can be published');
  const b = (await c.query('SELECT * FROM commercial_bundles WHERE id=$1', [v.bundle_id])).rows[0];
  if (v.price_mode === 'fixed') {
    let list = 0;
    for (const code of (await c.query('SELECT price_point_code FROM commercial_bundle_items WHERE bundle_id=$1', [b.id])).rows.map((r) => r.price_point_code)) {
      const x = parsePricePointCode(code);
      const plan = (await c.query('SELECT id, name FROM commercial_plans WHERE key=$1', [x.plan_key])).rows[0];
      const pv = await selectVersion(plan.id, { region: x.region, currency: x.currency, interval: x.billing_interval, at: new Date(`${String(v.effective_from instanceof Date ? v.effective_from.toISOString() : v.effective_from).slice(0, 10)}T00:00:00Z`), c });
      if (!pv) throw badRequest(`${plan.name} has no price in force on the bundle's start date`);
      list += priceVersion(pv, {}).subtotal_minor;
    }
    if (Number(v.amount_minor) > list) throw badRequest(`The bundle price is above the members' list prices (${list}); a bundle must not cost more than buying separately`);
  }
  const prev = (await c.query("SELECT * FROM commercial_bundle_versions WHERE bundle_id=$1 AND status='published' AND (effective_to IS NULL OR effective_to >= $2::date) FOR UPDATE", [b.id, v.effective_from])).rows;
  for (const p of prev) {
    if (new Date(p.effective_from) >= new Date(v.effective_from)) throw conflict('A published bundle price already starts on or after that date; choose a later effective date');
    await c.query('UPDATE commercial_bundle_versions SET effective_to = ($2::date - 1) WHERE id=$1', [p.id, v.effective_from]);
  }
  const u = (await c.query("UPDATE commercial_bundle_versions SET status='published', published_at=now(), published_by=$2 WHERE id=$1 RETURNING *", [id, actor])).rows[0];
  await commercialAudit(c, actor, 'publish_bundle_version', 'commercial_bundle_versions', id, { bundle: b.key, version: v.version });
  return u;
}

export async function retireBundleVersion(c, id, actor) {
  const v = (await c.query('SELECT * FROM commercial_bundle_versions WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!v) throw notFound('Bundle price');
  if (v.status !== 'published') throw conflict('Only a published bundle price can be retired');
  const u = (await c.query("UPDATE commercial_bundle_versions SET status='retired', effective_to = coalesce(effective_to, current_date) WHERE id=$1 RETURNING *", [id])).rows[0];
  await commercialAudit(c, actor, 'retire_bundle_version', 'commercial_bundle_versions', id);
  return u;
}

/** Bundles for the console (all) or the public price list (published and in force on `at`), each with its members, code, list total and saving. */
export async function bundleTree({ publishedOnly = false, at = null, region = null } = {}) {
  const bundles = await many('SELECT * FROM commercial_bundles WHERE ($1::boolean = false OR status = $2) AND ($3::text IS NULL OR region = $3 OR region = $4) ORDER BY name', [publishedOnly, 'active', region, '*']);
  const out = [];
  for (const b of bundles) {
    const items = (await many('SELECT price_point_code FROM commercial_bundle_items WHERE bundle_id=$1 ORDER BY price_point_code', [b.id])).map((r) => r.price_point_code);
    const versions = await many(`SELECT * FROM commercial_bundle_versions WHERE bundle_id=$1 AND ($2::boolean = false OR status='published') AND ($3::date IS NULL OR (effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date))) ORDER BY version DESC`, [b.id, publishedOnly, at]);
    const priced = [];
    for (const v of versions) {
      let list = null; let subtotal = null;
      if (v.status === 'published') {
        const pr = await priceBundle(b, new Date(`${(at ?? new Date().toISOString()).slice(0, 10)}T00:00:00Z`)).catch(() => null);
        if (pr && pr.bv.id === v.id) { list = pr.list_minor; subtotal = pr.subtotal_minor; }
      }
      priced.push({ ...v, list_minor: list, price_minor: subtotal, saving_minor: list == null ? null : list - subtotal });
    }
    if (publishedOnly && !priced.length) continue;
    out.push({ ...b, price_point_code: bundleCode(b), price_points: items, versions: priced });
  }
  return out;
}

/** Check every code names a price slot that exists (any status) and return the cleaned, unique list. */
async function checkPricePoints(c, i) {
  const codes = [...new Set(i.price_points ?? [])];
  if (i.all_price_points && codes.length) throw badRequest('Either apply the offer to all price points or list the ones it applies to, not both');
  if (!i.all_price_points && !codes.length) throw badRequest('Pick at least one price point, or apply the offer to all price points');
  for (const code of codes) {
    if (code.startsWith('bundle.')) {
      const [k, interval, currency, region] = code.slice(7).split(':');
      if (!(await c.query('SELECT 1 FROM commercial_bundles WHERE key=$1 AND billing_interval=$2 AND currency=$3 AND region=$4', [k, interval, currency, region])).rowCount) throw badRequest(`Unknown bundle ${code}`);
      continue;
    }
    const x = parsePricePointCode(code);
    const ok = (await c.query(`SELECT 1 FROM commercial_price_versions v JOIN commercial_plans p ON p.id = v.plan_id WHERE p.key=$1 AND v.billing_interval=$2 AND v.currency=$3 AND v.region=$4 LIMIT 1`, [x.plan_key, x.billing_interval, x.currency, x.region])).rowCount;
    if (!ok || pricePointCode(x.plan_key, x.billing_interval, x.currency, x.region) !== code) throw badRequest(`Unknown price point ${code}`);
  }
  return codes;
}

/** Replace the price points an offer is attached to (detached ones are kept with removed_at; subscriptions keep the offer they took). */
export async function setPromotionPricePoints(c, promotionId, i, actor) {
  const promo = (await c.query('SELECT id, key FROM commercial_promotions WHERE id=$1 FOR UPDATE', [promotionId])).rows[0];
  if (!promo) throw notFound('Offer');
  const codes = await checkPricePoints(c, i);
  const live = (await c.query('SELECT price_point_code FROM commercial_promotion_price_points WHERE promotion_id=$1 AND removed_at IS NULL', [promotionId])).rows.map((r) => r.price_point_code);
  const drop = live.filter((x) => !codes.includes(x)); const add = codes.filter((x) => !live.includes(x));
  if (drop.length) await c.query('UPDATE commercial_promotion_price_points SET removed_at = now() WHERE promotion_id=$1 AND removed_at IS NULL AND price_point_code = ANY($2)', [promotionId, drop]);
  for (const code of add) await c.query('INSERT INTO commercial_promotion_price_points(promotion_id, price_point_code, added_by) VALUES ($1,$2,$3)', [promotionId, code, actor]);
  await commercialAudit(c, actor, 'set_offer_price_points', 'commercial_promotions', promotionId, { key: promo.key, all: codes.length === 0, added: add, removed: drop });
  return { id: promotionId, key: promo.key, all_price_points: codes.length === 0, price_points: codes };
}

export async function createPromotion(c, i, actor) {
  checkPromotion(i);
  const codes = await checkPricePoints(c, i);
  const p = (await c.query(
    `INSERT INTO commercial_promotions(key, name, kind, coupon_ref, trial_days, benefit, free_months, discount_bp, flat_off_minor, flat_currency, duration_months, grants, starts_on, ends_on, max_redemptions, auto_apply, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [i.key, i.name, i.kind, i.coupon_ref ?? null, i.trial_days, i.benefit, i.free_months, i.discount_bp, i.flat_off_minor, i.flat_currency ?? null, i.duration_months, JSON.stringify(i.grants), i.starts_on, i.ends_on ?? null, i.max_redemptions ?? null, !!i.auto_apply, actor])).rows[0];
  for (const code of codes) await c.query('INSERT INTO commercial_promotion_price_points(promotion_id, price_point_code, added_by) VALUES ($1,$2,$3)', [p.id, code, actor]);
  await commercialAudit(c, actor, 'create_promotion', 'commercial_promotions', p.id, { key: p.key, price_points: codes });
  return { ...p, price_points: codes, all_price_points: codes.length === 0 };
}

// ------------------------------------------------------------------ import of a catalogue document
export const catalogueDoc = z.object({
  meters: z.array(meterInput).default([]),
  products: z.array(productInput.extend({
    plans: z.array(planInput.extend({ versions: z.array(versionInput).default([]) })).default([]),
  })).default([]),
  promotions: z.array(promotionInput).default([]),
});

/**
 * Create whatever the document names that does not exist yet (by key; versions by price slot + effective date) and publish new versions.
 * Existing products, plans and published versions are never changed, so re-importing is safe and never touches purchased terms.
 */
export function importCatalogue(doc, actor) {
  return tx(async (c) => {
    const out = { meters: 0, products: 0, plans: 0, versions: 0, promotions: 0, skipped: 0 };
    for (const m of doc.meters) {
      const r = await c.query('INSERT INTO commercial_meters(key, name, unit, mode, period) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [m.key, m.name, m.unit, m.mode, m.period]);
      r.rowCount ? out.meters++ : out.skipped++;
    }
    for (const p of doc.products) {
      let prod = (await c.query('SELECT * FROM commercial_products WHERE key=$1', [p.key])).rows[0];
      if (!prod) { prod = await createProduct(c, p, actor); out.products++; } else out.skipped++;
      for (const pl of p.plans) {
        let plan = (await c.query('SELECT * FROM commercial_plans WHERE key=$1', [pl.key])).rows[0];
        if (!plan) { plan = await createPlan(c, prod.id, pl, actor); out.plans++; } else out.skipped++;
        for (const v of pl.versions) {
          const exists = (await c.query('SELECT 1 FROM commercial_price_versions WHERE plan_id=$1 AND region=$2 AND currency=$3 AND billing_interval=$4 AND effective_from=$5::date', [plan.id, v.region, v.currency, v.billing_interval, v.effective_from])).rowCount;
          if (exists) { out.skipped++; continue; }
          const draft = await createVersionDraft(c, plan.id, v, actor);
          await publishVersion(c, draft.id, actor);
          out.versions++;
        }
      }
    }
    for (const pr of doc.promotions) {
      if ((await c.query('SELECT 1 FROM commercial_promotions WHERE key=$1', [pr.key])).rowCount) { out.skipped++; continue; }
      await createPromotion(c, pr, actor); out.promotions++;
    }
    await commercialAudit(c, actor, 'import_catalogue', 'commercial_products', null, out);
    return out;
  });
}

/** The whole catalogue for the console: products -> plans -> versions (with entitlements). */
export async function catalogueTree({ publishedOnly = false, at = null, region = null } = {}) {
  const products = await many('SELECT * FROM commercial_products ORDER BY family, name');
  const plans = await many('SELECT * FROM commercial_plans ORDER BY name');
  const versions = await many(
    `SELECT v.*, (SELECT coalesce(json_agg(json_build_object('key', e.key, 'limit_value', e.limit_value, 'limit_behaviour', e.limit_behaviour, 'warn_at_pct', e.warn_at_pct) ORDER BY e.key), '[]'::json)
                    FROM commercial_version_entitlements e WHERE e.version_id = v.id) AS entitlements
       FROM commercial_price_versions v
      WHERE ($1::boolean = false OR v.status = 'published')
        AND ($2::date IS NULL OR (v.effective_from <= $2::date AND (v.effective_to IS NULL OR v.effective_to >= $2::date)))
        AND ($3::text IS NULL OR v.region = $3 OR v.region = '*')
      ORDER BY v.plan_id, v.region, v.currency, v.billing_interval, v.version DESC`, [publishedOnly, at, region]);
  return products.map((p) => ({
    ...p,
    plans: plans.filter((pl) => pl.product_id === p.id && (!publishedOnly || pl.status === 'active'))
      .map((pl) => ({ ...pl, versions: versions.filter((v) => v.plan_id === pl.id).map((v) => ({ ...v, price_point_code: pricePointCode(pl.key, v.billing_interval, v.currency, v.region) })) }))
      .filter((pl) => !publishedOnly || pl.versions.length),
  })).filter((p) => !publishedOnly || p.plans.length);
}
