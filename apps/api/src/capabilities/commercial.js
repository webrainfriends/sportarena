// Commercial catalogue & entitlement engine (#504). One definition -> REST + OpenAPI + MCP.
//  * /admin/commercial/*  : the platform admin's console (catalogue, versions, promotions, overrides, subscriptions, simulation, audit). Platform admin only.
//  * /commercial/*        : what a customer (or a module acting for one) may do for a subject it manages: read the public catalogue,
//                           its own entitlements and usage, get a frozen quote, subscribe / cancel / change, record metered usage.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { mustBePlatformAdmin } from '../platform.js';
import { hasOrgGrant } from '../org-access.js';
import { canManage } from '../booking/engine.js';
import { canManageTeam } from './teams.js';
import { isOrganiserOf } from '../media-rights.js';
import {
  SUBJECT_TYPES, resolveEntitlements, decide, consume, usageSummary, createQuote, subscribe, activateSubscription, cancelSubscription,
  scheduleChange, applyDueChanges, isGoverned, applyPromotion, offerAppliesTo, versionCode, subscribeBundle, priceVersion, selectVersion, commercialAudit,
} from '../commercial/engine.js';
import {
  catalogueTree, createProduct, createPlan, setPromotionPricePoints, createBundle, createBundleVersion, publishBundleVersion, retireBundleVersion, bundleTree, bundleInput, bundleVersionInput, createVersionDraft, updateVersionDraft, publishVersion, retireVersion, createPromotion, importCatalogue,
  productInput, planInput, versionInput, promotionInput, meterInput, catalogueDoc,
} from '../commercial/catalogue.js';

const TAG = 'Commercial';
const subjectType = z.enum(SUBJECT_TYPES);
const subject = { subject_type: subjectType, subject_id: id };
const quantities = z.record(z.enum(['seat', 'team', 'location', 'event', 'athlete']), z.number().int().min(0).max(1_000_000)).default({});
const adminOnly = (user) => mustBePlatformAdmin(user);

/** Who may act for a subject: themselves, or the people who run it. 404 (not 403) for outsiders so existence is not leaked. */
async function mustManageSubject(user, type, subjectId) {
  let ok = false;
  if (type === 'user') ok = subjectId === user.id;
  else if (type === 'organisation') ok = !!(await one('SELECT 1 AS x FROM organisations WHERE id=$1', [subjectId])) && await hasOrgGrant(user, subjectId, ['owner', 'admin', 'finance']);
  else if (type === 'team') { const t = await one('SELECT * FROM teams WHERE id=$1', [subjectId]); ok = !!t && await canManageTeam(user, t); }
  else if (type === 'venue') ok = await canManage(user, subjectId);
  else if (type === 'event') { const ev = await one('SELECT * FROM events WHERE id=$1', [subjectId]); ok = !!ev && await isOrganiserOf(user, ev); }
  if (!ok) throw notFound('Account');
}
async function subjectExists(type, subjectId) {
  const table = { user: 'users', organisation: 'organisations', team: 'teams', venue: 'venues', event: 'events' }[type];
  if (!(await one(`SELECT 1 AS x FROM ${table} WHERE id=$1`, [subjectId]))) throw notFound('Account');
}


// ------------------------------------------------------------------ public catalogue
cap({
  name: 'commercial_catalogue', method: 'GET', path: '/commercial/catalogue', tag: TAG, auth: 'public',
  summary: 'The published price list in force today (or on `at`): products, plans, prices, billing intervals, components and the entitlements each plan grants, plus the bundles (several profiles of one person sold together) with their saving. Prices are configuration, never screen constants.',
  input: z.object({ region: z.string().regex(/^[A-Z]{2}$/).default('IN'), at: z.string().date().optional() }),
  handler: async (_ctx, i) => ({ region: i.region, at: i.at ?? new Date().toISOString().slice(0, 10), products: await catalogueTree({ publishedOnly: true, at: i.at ?? new Date().toISOString().slice(0, 10), region: i.region }), bundles: await bundleTree({ publishedOnly: true, at: i.at ?? new Date().toISOString().slice(0, 10), region: i.region }) }),
});

// ------------------------------------------------------------------ customer
cap({
  name: 'commercial_my_account', method: 'GET', path: '/commercial/account', tag: TAG,
  summary: 'Plan, add-ons, resolved entitlements (with the sources that shaped each) and usage against limits for a user, organisation, team, venue or event you manage.',
  input: z.object({ ...subject }),
  async handler({ user }, i) {
    await mustManageSubject(user, i.subject_type, i.subject_id);
    await applyDueChanges(i.subject_type, i.subject_id);
    const [resolved, usage, subscriptions] = await Promise.all([
      resolveEntitlements(i.subject_type, i.subject_id), usageSummary(i.subject_type, i.subject_id),
      many(`SELECT s.id, s.kind, s.status, s.quantities, s.bundle_group, s.allocated_minor, s.started_at, s.current_period_end, s.trial_ends_at, s.cancel_at_period_end, s.scheduled_for, p.key AS plan_key, p.name AS plan_name,
                   v.version, v.billing_interval, v.currency, v.amount_minor, sv.version AS scheduled_version, sp.name AS scheduled_plan_name
              FROM commercial_subscriptions s JOIN commercial_plans p ON p.id = s.plan_id JOIN commercial_price_versions v ON v.id = s.version_id
              LEFT JOIN commercial_price_versions sv ON sv.id = s.scheduled_version_id LEFT JOIN commercial_plans sp ON sp.id = sv.plan_id
             WHERE s.subject_type=$1 AND s.subject_id=$2 AND s.status NOT IN ('ended') ORDER BY s.created_at DESC`, [i.subject_type, i.subject_id]),
    ]);
    return { subject_type: i.subject_type, subject_id: i.subject_id, subscriptions, entitlements: resolved.entitlements, sources: resolved.sources, usage };
  },
});

cap({
  name: 'commercial_check_entitlement', method: 'GET', path: '/commercial/entitlement', tag: TAG,
  summary: 'Does this subject hold an entitlement right now, and what limit applies? The call modules and agents make instead of testing plan names.',
  input: z.object({ ...subject, key: z.string().regex(/^[a-z0-9_.]{2,60}$/) }),
  async handler({ user }, i) {
    await mustManageSubject(user, i.subject_type, i.subject_id);
    const governed = await isGoverned(i.key);
    return governed ? { governed, ...decide(await resolveEntitlements(i.subject_type, i.subject_id), i.key) } : { governed, key: i.key, allowed: true, limit: null };
  },
});

cap({
  name: 'commercial_quote', method: 'POST', path: '/commercial/quotes', tag: TAG, status: 201,
  summary: 'Get a frozen, authoritative quote (lines, discount, tax, total, the price-version ids used). Payments take this quote; the client never recomputes prices. Valid 7 days.',
  input: z.object({
    ...subject, region: z.string().regex(/^[A-Z]{2}$/).default('IN'), currency: z.string().regex(/^[A-Z]{3}$/).optional(), promotion_key: z.string().max(60).optional(),
    items: z.array(z.object({ plan_key: z.string().max(60).optional(), bundle_key: z.string().max(60).optional(), billing_interval: z.enum(['one_time', 'monthly', 'annual', 'per_event', 'usage']).optional(), quantities })
      .refine((x) => !!x.plan_key !== !!x.bundle_key, 'Give either plan_key or bundle_key')).min(1).max(10),
    usage: z.record(z.string(), z.number().min(0)).optional(), gmv_minor: z.number().int().min(0).optional().describe('expected sales, only to show what a percentage fee would be'),
  }),
  async handler({ user }, i) {
    await mustManageSubject(user, i.subject_type, i.subject_id);
    return createQuote({ subjectType: i.subject_type, subjectId: i.subject_id, user, items: i.items, region: i.region, currency: i.currency, promotionKey: i.promotion_key, usage: i.usage, gmv_minor: i.gmv_minor });
  },
});

cap({
  name: 'commercial_get_quote', method: 'GET', path: '/commercial/quotes/:id', tag: TAG,
  summary: 'Read a quote you requested (what payments will charge).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const q = await one('SELECT * FROM commercial_quotes WHERE id=$1', [i.id]);
    if (!q || q.requested_by !== user.id) throw notFound('Quote');
    return q;
  },
});

cap({
  name: 'commercial_subscribe', method: 'POST', path: '/commercial/subscriptions', tag: TAG, status: 201,
  summary: 'Take a plan or add-on for a subject you manage. Free plans and trials start at once; a paid plan is created awaiting payment against its frozen quote. The version bought is pinned: later price changes never touch it.',
  input: z.object({
    ...subject, plan_key: z.string().max(60).optional(), bundle_key: z.string().max(60).optional().describe('instead of plan_key: take a bundle (several profiles of one person at the bundle price)'),
    billing_interval: z.enum(['one_time', 'monthly', 'annual', 'per_event', 'usage']).optional(), region: z.string().regex(/^[A-Z]{2}$/).default('IN'),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(), quantities, promotion_key: z.string().max(60).optional(),
  }),
  async handler({ user }, i) {
    await mustManageSubject(user, i.subject_type, i.subject_id);
    if (!!i.plan_key === !!i.bundle_key) throw badRequest('Give either plan_key or bundle_key');
    if (i.bundle_key) return subscribeBundle({ subjectType: i.subject_type, subjectId: i.subject_id, user, bundleKey: i.bundle_key, promotionKey: i.promotion_key });
    return subscribe({ subjectType: i.subject_type, subjectId: i.subject_id, user, planKey: i.plan_key, billingInterval: i.billing_interval, region: i.region, currency: i.currency, quantities: i.quantities, promotionKey: i.promotion_key });
  },
});

async function mustManageSubscription(user, subId) {
  const s = await one('SELECT * FROM commercial_subscriptions WHERE id=$1', [subId]);
  if (!s) throw notFound('Subscription');
  await mustManageSubject(user, s.subject_type, s.subject_id);
  return s;
}

cap({
  name: 'commercial_cancel_subscription', method: 'POST', path: '/commercial/subscriptions/:id/cancel', tag: TAG,
  summary: 'Stop renewal. A running plan lasts to the end of the paid period; nothing you created is deleted, creating new premium items is simply no longer included afterwards.',
  input: z.object({ id }),
  async handler({ user }, i) { await mustManageSubscription(user, i.id); return cancelSubscription(i.id, user.id); },
});

cap({
  name: 'commercial_change_subscription', method: 'POST', path: '/commercial/subscriptions/:id/change', tag: TAG,
  summary: 'Upgrade or downgrade: the new plan/price takes effect now or at the end of the period (proration shown per the version\'s policy). The current pinned version stays until then.',
  input: z.object({ id, plan_key: z.string().max(60), billing_interval: z.enum(['one_time', 'monthly', 'annual', 'per_event', 'usage']).optional(), region: z.string().regex(/^[A-Z]{2}$/).default('IN'), currency: z.string().regex(/^[A-Z]{3}$/).optional(), effective: z.enum(['now', 'period_end']).default('period_end') }),
  async handler({ user }, i) {
    await mustManageSubscription(user, i.id);
    return scheduleChange({ id: i.id, actorId: user.id, planKey: i.plan_key, billingInterval: i.billing_interval, region: i.region, currency: i.currency, effective: i.effective });
  },
});

cap({
  name: 'commercial_record_usage', method: 'POST', path: '/commercial/usage', tag: TAG,
  summary: 'Meter usage (AI credits, API/MCP calls, storage, paid messages, verifications) against the subject\'s limit. Atomic; the idempotency_key makes a retried call count once; a hard limit refuses the whole call with 402 limit_reached.',
  input: z.object({ ...subject, meter: z.string().regex(/^[a-z0-9_]{2,40}$/), quantity: z.number().positive().max(1_000_000_000).default(1), idempotency_key: z.string().min(8).max(120) }),
  async handler({ user }, i) {
    await mustManageSubject(user, i.subject_type, i.subject_id);
    return consume({ subjectType: i.subject_type, subjectId: i.subject_id, key: i.meter, quantity: i.quantity, idempotencyKey: i.idempotency_key, actorId: user.id });
  },
});

// ------------------------------------------------------------------ platform admin console
cap({
  name: 'commercial_admin_catalogue', method: 'GET', path: '/admin/commercial/catalogue', tag: TAG,
  summary: 'Platform admin: the whole catalogue including drafts and retired versions, plus meters, promotions and which plans still need a price.',
  async handler({ user }) {
    await adminOnly(user);
    const [products, meters, promotions, bundles] = await Promise.all([catalogueTree(), many('SELECT * FROM commercial_meters ORDER BY key'), many(`SELECT p.*, coalesce((SELECT array_agg(t.price_point_code ORDER BY t.price_point_code) FROM commercial_promotion_price_points t WHERE t.promotion_id = p.id AND t.removed_at IS NULL), '{}') AS price_points FROM commercial_promotions p ORDER BY p.created_at DESC`), bundleTree()]);
    return { products, meters, promotions, bundles };
  },
});

cap({
  name: 'commercial_admin_create_product', method: 'POST', path: '/admin/commercial/products', tag: TAG, status: 201,
  summary: 'Platform admin: add a commercial product family.', input: productInput,
  async handler({ user }, i) { await adminOnly(user); return tx((c) => createProduct(c, i, user.id)); },
});

cap({
  name: 'commercial_admin_create_plan', method: 'POST', path: '/admin/commercial/plans', tag: TAG, status: 201,
  summary: 'Platform admin: add a plan/offer (base or add-on with dependencies) to a product, with the actor types it is eligible for.',
  input: planInput.extend({ product_key: z.string().regex(/^[a-z0-9_]{2,40}$/) }),
  async handler({ user }, i) {
    await adminOnly(user);
    return tx(async (c) => {
      const prod = (await c.query('SELECT id FROM commercial_products WHERE key=$1', [i.product_key])).rows[0];
      if (!prod) throw notFound('Product');
      return createPlan(c, prod.id, i, user.id);
    });
  },
});

cap({
  name: 'commercial_admin_create_version', method: 'POST', path: '/admin/commercial/plans/:plan_key/versions', tag: TAG, status: 201,
  summary: 'Platform admin: draft a new price version (region, currency, interval, amount, components, tax, trial, proration, effective dates, entitlements). Nothing is live until it is published.',
  input: versionInput.extend({ plan_key: z.string().max(60) }),
  async handler({ user }, i) {
    await adminOnly(user);
    return tx(async (c) => {
      const plan = (await c.query('SELECT id FROM commercial_plans WHERE key=$1', [i.plan_key])).rows[0];
      if (!plan) throw notFound('Plan');
      return createVersionDraft(c, plan.id, i, user.id);
    });
  },
});

cap({
  name: 'commercial_admin_update_draft', method: 'PATCH', path: '/admin/commercial/versions/:id', tag: TAG,
  summary: 'Platform admin: edit a DRAFT version. A published version is immutable; publish a new one instead.',
  input: versionInput.extend({ id }),
  async handler({ user }, i) { await adminOnly(user); return tx((c) => updateVersionDraft(c, i.id, i, user.id)); },
});

cap({
  name: 'commercial_admin_publish_version', method: 'POST', path: '/admin/commercial/versions/:id/publish', tag: TAG,
  summary: 'Platform admin: publish a draft. It freezes; the previous version of the same price slot ends the day before this one starts, so a future date is a scheduled price. Existing subscriptions keep the version they bought.',
  input: z.object({ id }),
  async handler({ user }, i) { await adminOnly(user); return tx((c) => publishVersion(c, i.id, user.id)); },
});

cap({
  name: 'commercial_admin_retire_version', method: 'POST', path: '/admin/commercial/versions/:id/retire', tag: TAG,
  summary: 'Platform admin: stop selling a published version. Subscriptions already on it keep it.',
  input: z.object({ id }),
  async handler({ user }, i) { await adminOnly(user); return tx((c) => retireVersion(c, i.id, user.id)); },
});

cap({
  name: 'commercial_admin_create_promotion', method: 'POST', path: '/admin/commercial/promotions', tag: TAG, status: 201,
  summary: 'Platform admin: add a trial, launch offer, first-term discount or coupon reference (optionally with extra entitlements while it runs).', input: promotionInput,
  async handler({ user }, i) { await adminOnly(user); return tx((c) => createPromotion(c, i, user.id)); },
});

cap({
  name: 'commercial_admin_set_offer_price_points', method: 'PATCH', path: '/admin/commercial/promotions/:id/price-points', tag: TAG,
  summary: 'Platform admin: attach an offer to one or more price points (codes like team_pro:monthly:INR:IN) or to all of them. Detached rows are kept; existing subscriptions keep the offer they took.',
  input: z.object({ id, all_price_points: z.boolean().default(false), price_points: z.array(z.string().max(100)).max(200).default([]) }),
  async handler({ user }, i) { await adminOnly(user); return tx((c) => setPromotionPricePoints(c, i.id, i, user.id)); },
});

cap({
  name: 'commercial_admin_create_bundle', method: 'POST', path: '/admin/commercial/bundles', tag: TAG, status: 201,
  summary: 'Platform admin: define a bundle: two or more price points (one plan per profile family: athlete, coach, organiser…) that one person takes together, all in the bundle\'s billing interval, currency and region. Price it with a bundle price version.',
  input: bundleInput,
  async handler({ user }, i) {
    await adminOnly(user);
    try { return await tx((c) => createBundle(c, i, user.id)); } catch (e) { if (e.code === '23505') throw conflict('That bundle code is taken'); throw e; }
  },
});

cap({
  name: 'commercial_admin_create_bundle_version', method: 'POST', path: '/admin/commercial/bundles/:bundle_key/versions', tag: TAG, status: 201,
  summary: 'Platform admin: draft a bundle price: a fixed bundle price, or a % / flat amount off the members\' list prices, with tax and effective dates. Frozen once published; a fixed price may not exceed the members\' list total.',
  input: bundleVersionInput.extend({ bundle_key: z.string().max(40) }),
  async handler({ user }, i) { await adminOnly(user); return tx((c) => createBundleVersion(c, i.bundle_key, i, user.id)); },
});

cap({
  name: 'commercial_admin_publish_bundle_version', method: 'POST', path: '/admin/commercial/bundle-versions/:id/publish', tag: TAG,
  summary: 'Platform admin: publish a bundle price (it freezes; the previous one ends the day before). Existing bundle subscriptions keep the price they bought.', input: z.object({ id }),
  async handler({ user }, i) { await adminOnly(user); return tx((c) => publishBundleVersion(c, i.id, user.id)); },
});

cap({
  name: 'commercial_admin_retire_bundle_version', method: 'POST', path: '/admin/commercial/bundle-versions/:id/retire', tag: TAG,
  summary: 'Platform admin: stop selling a published bundle price.', input: z.object({ id }),
  async handler({ user }, i) { await adminOnly(user); return tx((c) => retireBundleVersion(c, i.id, user.id)); },
});

cap({
  name: 'commercial_admin_define_meter', method: 'POST', path: '/admin/commercial/meters', tag: TAG, status: 201,
  summary: 'Platform admin: define a usage meter (counter over a period, or a live gauge).', input: meterInput,
  async handler({ user }, i) {
    await adminOnly(user);
    try {
      return await tx(async (c) => {
        const m = (await c.query('INSERT INTO commercial_meters(key, name, unit, mode, period) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.key, i.name, i.unit, i.mode, i.period])).rows[0];
        await commercialAudit(c, user.id, 'define_meter', 'commercial_meters', null, { key: m.key });
        return m;
      });
    } catch (e) { if (e.code === '23505') throw conflict('That meter already exists'); throw e; }
  },
});

const LAUNCH_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'commercial', 'india-launch.json');
cap({
  name: 'commercial_admin_import', method: 'POST', path: '/admin/commercial/import', tag: TAG,
  summary: 'Platform admin: load a catalogue document (or the bundled India launch baseline with source=india_launch). Creates what is missing and publishes new versions; existing products, plans and published versions are never changed, so it is safe to repeat.',
  input: z.object({ source: z.enum(['india_launch']).optional(), catalogue: catalogueDoc.optional() }).refine((i) => !!i.source !== !!i.catalogue, 'Give either source or catalogue'),
  async handler({ user }, i) {
    await adminOnly(user);
    const doc = i.catalogue ?? catalogueDoc.parse(JSON.parse(readFileSync(LAUNCH_FILE, 'utf8')));
    return importCatalogue(doc, user.id);
  },
});

cap({
  name: 'commercial_admin_simulate', method: 'POST', path: '/admin/commercial/simulate', tag: TAG,
  summary: 'Platform admin: price any plan for given quantities/usage/expected sales without creating anything (pricing simulation). Shows lines, discount, tax, total and any percentage terms such as a 0% venue commission.',
  input: z.object({ plan_key: z.string().max(60).optional(), bundle_key: z.string().max(60).optional(), region: z.string().regex(/^[A-Z]{2}$/).default('IN'), currency: z.string().regex(/^[A-Z]{3}$/).optional(), billing_interval: z.enum(['one_time', 'monthly', 'annual', 'per_event', 'usage']).optional(), at: z.string().date().optional(),
    quantities, usage: z.record(z.string(), z.number().min(0)).optional(), gmv_minor: z.number().int().min(0).optional(), promotion_key: z.string().max(60).optional() }),
  async handler({ user }, i) {
    await adminOnly(user);
    if (!!i.plan_key === !!i.bundle_key) throw badRequest('Give either plan_key or bundle_key');
    if (i.bundle_key) {
      const q = await createQuote({ subjectType: 'user', subjectId: user.id, user, items: [{ bundle_key: i.bundle_key }], promotionKey: i.promotion_key, at: i.at ? new Date(`${i.at}T00:00:00Z`) : new Date(), persist: false });
      return { ...q, plan_key: q.bundle.key, bundle_key: q.bundle.key, price_point_code: q.bundle.price_point_code, version: q.bundle.version, billing_interval: q.lines[0]?.billing_interval, offer_schedule: q.schedule[0]?.terms ?? [], regular_total_minor: q.schedule[0]?.regular_total_minor ?? q.subtotal_minor + q.tax_minor };
    }
    const plan = await one('SELECT * FROM commercial_plans WHERE key=$1', [i.plan_key]);
    if (!plan) throw notFound('Plan');
    const at = i.at ? new Date(`${i.at}T00:00:00Z`) : new Date();
    const v = await selectVersion(plan.id, { region: i.region, currency: i.currency, interval: i.billing_interval, at });
    if (!v) throw badRequest('No published price is in force for that plan on that date');
    const priced = priceVersion(v, { quantities: i.quantities, usage: i.usage, gmv_minor: i.gmv_minor });
    let ap = { schedule: [], first_discount_minor: 0, extra_free_months: 0 };
    if (i.promotion_key) {
      const p = await one("SELECT * FROM commercial_promotions WHERE key=$1 AND status='active' AND starts_on <= $2::date AND (ends_on IS NULL OR ends_on >= $2::date)", [i.promotion_key, at]);
      if (!p) throw badRequest('That offer is not available');
      p.price_points = (await many('SELECT price_point_code FROM commercial_promotion_price_points WHERE promotion_id=$1 AND removed_at IS NULL', [p.id])).map((r) => r.price_point_code);
      if (!offerAppliesTo(p, versionCode(v))) throw badRequest(`That offer does not apply to price point ${versionCode(v)}`);
      ap = applyPromotion(v, priced.subtotal_minor, p);
    }
    const discount = ap.first_discount_minor;
    const tax = Math.round(((priced.subtotal_minor - discount) * v.tax_bp) / 10000);
    return { plan_key: plan.key, price_point_code: versionCode(v), version_id: v.id, version: v.version, currency: v.currency, billing_interval: v.billing_interval, lines: priced.lines, terms: priced.terms, subtotal_minor: priced.subtotal_minor, discount_minor: discount, tax_minor: tax, total_minor: priced.subtotal_minor - discount + tax, offer_schedule: ap.schedule, extra_free_months: ap.extra_free_months, regular_total_minor: priced.subtotal_minor + Math.round((priced.subtotal_minor * v.tax_bp) / 10000) };
  },
});

cap({
  name: 'commercial_admin_preview_entitlements', method: 'POST', path: '/admin/commercial/preview', tag: TAG,
  summary: 'Platform admin: what a subject resolves to on a date, with the layer that produced each value (default < parent < base plan < add-ons < promotion < contract override < enterprise override).',
  input: z.object({ ...subject, at: z.string().datetime().optional() }),
  async handler({ user }, i) {
    await adminOnly(user);
    await subjectExists(i.subject_type, i.subject_id);
    const at = i.at ? new Date(i.at) : new Date();
    return { ...(await resolveEntitlements(i.subject_type, i.subject_id, { at })), usage: await usageSummary(i.subject_type, i.subject_id, { at }) };
  },
});

cap({
  name: 'commercial_admin_subscriptions', method: 'GET', path: '/admin/commercial/subscriptions', tag: TAG,
  summary: 'Platform admin: subscriptions across accounts, filterable by subject, plan or status.',
  input: z.object({ subject_type: subjectType.optional(), subject_id: id.optional(), plan_key: z.string().max(60).optional(), status: z.enum(['pending_payment', 'trial', 'active', 'scheduled', 'cancelled', 'ended']).optional(), ...page }),
  async handler({ user }, i) {
    await adminOnly(user);
    return many(`SELECT s.*, p.key AS plan_key, p.name AS plan_name, v.version, v.currency, v.region, v.billing_interval, v.amount_minor FROM commercial_subscriptions s JOIN commercial_plans p ON p.id=s.plan_id JOIN commercial_price_versions v ON v.id=s.version_id
                  WHERE ($1::text IS NULL OR s.subject_type=$1) AND ($2::uuid IS NULL OR s.subject_id=$2) AND ($3::text IS NULL OR p.key=$3) AND ($4::text IS NULL OR s.status=$4)
                  ORDER BY s.created_at DESC LIMIT $5 OFFSET $6`, [i.subject_type ?? null, i.subject_id ?? null, i.plan_key ?? null, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'commercial_admin_assign', method: 'POST', path: '/admin/commercial/subscriptions', tag: TAG, status: 201,
  summary: 'Platform admin: put a subject on a plan (negotiated or granted), optionally already paid. The version bought is pinned.',
  input: z.object({ ...subject, plan_key: z.string().max(60).optional(), bundle_key: z.string().max(60).optional(), billing_interval: z.enum(['one_time', 'monthly', 'annual', 'per_event', 'usage']).optional(), region: z.string().regex(/^[A-Z]{2}$/).default('IN'), currency: z.string().regex(/^[A-Z]{3}$/).optional(), quantities, promotion_key: z.string().max(60).optional(), mark_paid: z.boolean().default(false) }),
  async handler({ user }, i) {
    await adminOnly(user);
    await subjectExists(i.subject_type, i.subject_id);
    if (!!i.plan_key === !!i.bundle_key) throw badRequest('Give either plan_key or bundle_key');
    if (i.bundle_key) {
      const r = await subscribeBundle({ subjectType: i.subject_type, subjectId: i.subject_id, user, bundleKey: i.bundle_key, promotionKey: i.promotion_key });
      if (i.mark_paid && r.subscriptions[0].status === 'pending_payment') r.subscriptions[0] = await activateSubscription(r.subscriptions[0].id, user.id);
      return r;
    }
    const r = await subscribe({ subjectType: i.subject_type, subjectId: i.subject_id, user, planKey: i.plan_key, billingInterval: i.billing_interval, region: i.region, currency: i.currency, quantities: i.quantities, promotionKey: i.promotion_key });
    if (i.mark_paid && r.subscription.status === 'pending_payment') r.subscription = await activateSubscription(r.subscription.id, user.id);
    return r;
  },
});

cap({
  name: 'commercial_admin_activate', method: 'POST', path: '/admin/commercial/subscriptions/:id/activate', tag: TAG,
  summary: 'Platform admin / payments hook: payment for the frozen quote is confirmed, so the pending subscription starts.',
  input: z.object({ id }),
  async handler({ user }, i) { await adminOnly(user); return activateSubscription(i.id, user.id); },
});

cap({
  name: 'commercial_admin_end_subscription', method: 'POST', path: '/admin/commercial/subscriptions/:id/cancel', tag: TAG,
  summary: 'Platform admin: stop a subscription renewing (history kept).', input: z.object({ id }),
  async handler({ user }, i) { await adminOnly(user); return cancelSubscription(i.id, user.id); },
});

cap({
  name: 'commercial_admin_override', method: 'POST', path: '/admin/commercial/overrides', tag: TAG, status: 201,
  summary: 'Platform admin: a contract override for one subject, or an enterprise override that applies to every child of an organisation/user (set replaces the resolved value, add adds to it). Needs a reason.',
  input: z.object({ ...subject, scope: z.enum(['contract', 'enterprise']), key: z.string().regex(/^[a-z0-9_.]{2,60}$/), mode: z.enum(['set', 'add']).default('set'), enabled: z.boolean().default(true),
    limit_value: z.number().min(0).nullable().default(null), limit_behaviour: z.enum(['warn', 'soft', 'hard']).optional(), reason: z.string().min(3).max(300), starts_on: z.string().date().optional(), ends_on: z.string().date().optional() }),
  async handler({ user }, i) {
    await adminOnly(user);
    await subjectExists(i.subject_type, i.subject_id);
    return tx(async (c) => {
      const o = (await c.query(
        `INSERT INTO commercial_overrides(scope, subject_type, subject_id, key, mode, enabled, limit_value, limit_behaviour, reason, starts_on, ends_on, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::date, current_date),$11,$12) RETURNING *`,
        [i.scope, i.subject_type, i.subject_id, i.key, i.mode, i.enabled, i.limit_value, i.limit_behaviour ?? null, i.reason, i.starts_on ?? null, i.ends_on ?? null, user.id])).rows[0];
      await commercialAudit(c, user.id, 'create_override', 'commercial_overrides', o.id, { scope: i.scope, key: i.key });
      return o;
    });
  },
});

cap({
  name: 'commercial_admin_revoke_override', method: 'POST', path: '/admin/commercial/overrides/:id/revoke', tag: TAG,
  summary: 'Platform admin: end an override (kept in history).', input: z.object({ id }),
  async handler({ user }, i) {
    await adminOnly(user);
    return tx(async (c) => {
      const o = (await c.query("UPDATE commercial_overrides SET status='revoked', revoked_at=now() WHERE id=$1 AND status='active' RETURNING *", [i.id])).rows[0];
      if (!o) throw notFound('Override');
      await commercialAudit(c, user.id, 'revoke_override', 'commercial_overrides', o.id);
      return o;
    });
  },
});

cap({
  name: 'commercial_admin_overrides', method: 'GET', path: '/admin/commercial/overrides', tag: TAG,
  summary: 'Platform admin: overrides for a subject (or all).', input: z.object({ subject_type: subjectType.optional(), subject_id: id.optional(), ...page }),
  async handler({ user }, i) {
    await adminOnly(user);
    return many('SELECT * FROM commercial_overrides WHERE ($1::text IS NULL OR subject_type=$1) AND ($2::uuid IS NULL OR subject_id=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4', [i.subject_type ?? null, i.subject_id ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'commercial_admin_link', method: 'POST', path: '/admin/commercial/links', tag: TAG, status: 201,
  summary: 'Platform admin: make a subject a child of an enterprise parent (organisation or user) so it inherits the parent\'s entitlements. Ending a link keeps history.',
  input: z.object({ child_type: subjectType, child_id: id, parent_type: z.enum(['organisation', 'user']).optional(), parent_id: id.optional(), end: z.boolean().default(false) })
    .refine((i) => i.end || (i.parent_type && i.parent_id), 'Say which parent to link under'),
  async handler({ user }, i) {
    await adminOnly(user);
    await subjectExists(i.child_type, i.child_id);
    if (!i.end) await subjectExists(i.parent_type, i.parent_id);
    return tx(async (c) => {
      if (i.end) {
        const r = await c.query('UPDATE commercial_subject_links SET ended_at=now() WHERE child_type=$1 AND child_id=$2 AND ended_at IS NULL RETURNING *', [i.child_type, i.child_id]);
        await commercialAudit(c, user.id, 'end_link', 'commercial_subject_links', r.rows[0]?.id);
        return r.rows[0] ?? { ended: false };
      }
      try {
        const l = (await c.query('INSERT INTO commercial_subject_links(child_type, child_id, parent_type, parent_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [i.child_type, i.child_id, i.parent_type, i.parent_id, user.id])).rows[0];
        await commercialAudit(c, user.id, 'link', 'commercial_subject_links', l.id);
        return l;
      } catch (e) { if (e.code === '23505') throw conflict('That account already has a parent'); throw e; }
    });
  },
});

const SUBJECT_SEARCH = {
  user: "SELECT id, coalesce(display_name, handle) AS name, '@' || handle AS sub FROM users WHERE (handle ILIKE $1 OR display_name ILIKE $1)",
  organisation: "SELECT id, name, kind AS sub FROM organisations WHERE name ILIKE $1",
  team: "SELECT id, name, city AS sub FROM teams WHERE name ILIKE $1",
  venue: "SELECT id, name, city AS sub FROM venues WHERE name ILIKE $1",
  event: "SELECT id, name, status AS sub FROM events WHERE name ILIKE $1",
};
cap({
  name: 'commercial_admin_find_subject', method: 'GET', path: '/admin/commercial/subjects', tag: TAG,
  summary: 'Platform admin: search-and-pick any account the engine can bill (user, organisation, team, venue, event) by name. Names only, no personal identification data.',
  input: z.object({ subject_type: subjectType, q: z.string().trim().max(60).default(''), limit: z.coerce.number().int().min(1).max(30).default(15) }),
  async handler({ user }, i) {
    await adminOnly(user);
    return many(`${SUBJECT_SEARCH[i.subject_type]} ORDER BY 2 LIMIT $2`, [`%${i.q.replace(/[%_\\]/g, '')}%`, i.limit]);
  },
});

cap({
  name: 'commercial_admin_usage', method: 'GET', path: '/admin/commercial/usage', tag: TAG,
  summary: 'Platform admin: usage meters and limits for a subject (exposed for future billing).', input: z.object({ ...subject }),
  async handler({ user }, i) { await adminOnly(user); await subjectExists(i.subject_type, i.subject_id); return usageSummary(i.subject_type, i.subject_id); },
});

cap({
  name: 'commercial_admin_audit', method: 'GET', path: '/admin/commercial/audit', tag: TAG,
  summary: 'Platform admin: the append-only audit trail of every catalogue, subscription and override change.', input: z.object({ ...page }),
  async handler({ user }, i) {
    await adminOnly(user);
    return many('SELECT a.*, u.handle AS actor_handle FROM commercial_audit a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.at DESC, a.id DESC LIMIT $1 OFFSET $2', [i.limit, i.offset]);
  },
});
