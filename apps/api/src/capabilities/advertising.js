// Sports advertising & promoted marketplace (#524) — the advertiser's side, serving, and the controls people have over what they are shown.
// Paid placements are explicitly labelled inventory (`Sponsored` / `Promoted`) that sits beside organic results and never inside them: nothing here
// reads or writes a ranking, tender, eligibility, selection or review-score table. The platform's review desk is in advertising-admin.js.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { audit } from '../helpers.js';
import { isSupportedCurrency } from '../currency.js';
import { encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { hasOrgGrant } from '../org-access.js';
import { refundPartial } from '../payments/service.js';
import {
  PLACEMENTS, PLACEMENT_CODES, ENTITY_TYPES, CTAS, CATEGORIES, ALLOWED_CATEGORIES, PROHIBITED_CATEGORIES, CLAIM_TYPES, METRIC_DEFINITIONS, REPORT_REASONS,
  TARGETING_ALLOWED, TARGETING_FORBIDDEN, safeLandingUrl, screenCopy,
} from '../ads/policy.js';
import {
  advertisersOf, advertiserAccess, loadCampaign, advertiserName, checkEntity, readiness, moveCampaign, goLive, logCampaign, getPolicy, inventoryOf, requireAdsEntitlement,
  CAMP, serveAds, followAd, viewerHash, reportFor, moneyFor, refundableMinor, minimumFunding, canTransition, remainingMicro, MICRO, subjectOf,
} from '../ads/engine.js';

const TAG = 'Advertising';
const MANAGE = ['owner', 'admin'];
const day = z.string().date();
const money = z.number().int().min(1).max(100_000_000_000);

const creativeShape = {
  headline: z.string().trim().min(2).max(60),
  body: z.string().trim().max(150).optional(),
  cta: z.enum(Object.keys(CTAS)),
  media_id: id.optional().describe('a photo uploaded with PUT /market/media'),
  alt_text: z.string().trim().max(140).optional().describe('describes the picture for screen readers; required with a picture'),
  claims: z.array(z.enum(Object.keys(CLAIM_TYPES))).max(6).default([]).describe('the kinds of factual claim the ad makes, so the reviewer knows what to check'),
};
const creativeInput = z.object(creativeShape).refine((x) => !x.media_id || !!x.alt_text, { message: 'Describe the picture', path: ['alt_text'] });

const campaignShape = {
  name: z.string().trim().min(2).max(80),
  objective: z.enum(['awareness', 'traffic']).describe('awareness = be seen; traffic = send people to the destination'),
  category: z.string().describe(`what is being promoted; one of ${ALLOWED_CATEGORIES.join(', ')}. Prohibited categories are refused.`),
  placements: z.array(z.enum(PLACEMENT_CODES)).min(1).max(PLACEMENT_CODES.length),
  billing_model: z.enum(['flat', 'cpm', 'cpc']).describe('flat = one fee for the whole run; cpm = price per 1,000 impressions; cpc = price per click'),
  rate_minor: money.describe('the flat fee, the price per 1,000 impressions, or the price per click, in minor units'),
  currency: z.string().length(3).transform((x) => x.toUpperCase()).refine(isSupportedCurrency, 'Unsupported currency'),
  budget_minor: money.describe('the most to spend; for a flat fee it equals the fee'),
  starts_on: day, ends_on: day,
  sports: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(12).default([]).describe('sport slugs the page must be about; empty = any sport'),
  countries: z.array(z.string().length(2).transform((x) => x.toUpperCase())).max(30).default([]).describe('coarse geography; empty = anywhere'),
  cities: z.array(z.string().trim().min(2).max(60)).max(30).default([]),
  keywords: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(5).default([]).describe('for a sponsored search slot: what the visitor searched for'),
  audience: z.enum(['everyone', 'followers']).default('everyone').describe('followers = people who follow the venue or event you promote'),
  frequency_per_day: z.number().int().min(1).max(100).optional().describe('most times one person sees this ad in a day'),
  landing_entity_type: z.enum(ENTITY_TYPES).optional(), landing_entity_id: id.optional(),
  landing_url: z.string().max(300).optional().describe('an https page; only when the destination is not a Gotmygame page'),
};

// ------------------------------------------------------------------ shaping
const cta = (k) => CTAS[k] ?? k;
async function creativeRows(campaignId) {
  return many('SELECT id, version, headline, body, cta, media_id, alt_text, claims, status, created_at FROM ad_creatives WHERE campaign_id=$1 ORDER BY version DESC', [campaignId]);
}
function present(camp, extra = {}) {
  return {
    id: camp.id, advertiser_id: camp.advertiser_id, name: camp.name, objective: camp.objective, category: camp.category, category_label: CATEGORIES[camp.category]?.label ?? camp.category,
    status: camp.status, held_by_platform: camp.held_by_platform, billing_model: camp.billing_model, rate_minor: Number(camp.rate_minor), currency: camp.currency,
    budget_minor: Number(camp.budget_minor), funded_minor: Number(camp.funded_minor), refunded_minor: Number(camp.refunded_minor),
    spent_minor: Math.ceil(Number(camp.spent_micro) / MICRO), remaining_minor: Math.floor(remainingMicro(camp) / MICRO),
    starts_on: camp.starts_on, ends_on: camp.ends_on, sports: camp.sports, countries: camp.countries, cities: camp.cities, keywords: camp.keywords,
    audience: camp.audience, frequency_per_day: camp.frequency_per_day, disclosure: camp.disclosure === 'promoted' ? 'Promoted' : 'Sponsored',
    landing: camp.landing_entity_type ? { type: 'entity', entity_type: camp.landing_entity_type, entity_id: camp.landing_entity_id } : camp.landing_url ? { type: 'external', url: camp.landing_url } : null,
    current_creative_id: camp.current_creative_id, end_reason: camp.end_reason, created_at: camp.created_at, ...extra,
  };
}
const withPlacements = async (camp) => present(camp, { placements: (await many('SELECT placement_code FROM ad_campaign_placements WHERE campaign_id=$1 AND removed_at IS NULL ORDER BY placement_code', [camp.id])).map((r) => r.placement_code) });
const disclosureFor = (placements) => (placements.every((p) => PLACEMENTS[p].disclosure === 'promoted') ? 'promoted' : 'sponsored');

/** Validate the parts of a campaign that depend on data: sports, landing, entity, placements, category, copy. Throws a plain message. */
async function validate(user, advertiser, v, c) {
  if (v.starts_on < new Date().toISOString().slice(0, 10)) throw badRequest('The start date has passed');
  if (v.ends_on < v.starts_on) throw badRequest('The end date is before the start date');
  if (v.billing_model === 'flat' && v.budget_minor !== v.rate_minor) throw badRequest('A flat fee campaign spends exactly its fee: set the budget equal to the fee');
  if (v.budget_minor < v.rate_minor) throw badRequest('The budget cannot be less than one billing unit');
  if (!CATEGORIES[v.category]) throw badRequest('Choose what you are promoting from the list');
  if (!CATEGORIES[v.category].allowed) throw unprocessable(`${CATEGORIES[v.category].label} cannot be advertised on Gotmygame`, { category: v.category });
  if (v.sports.length) {
    const have = (await c.query('SELECT slug FROM sports WHERE slug = ANY($1)', [v.sports])).rows.map((r) => r.slug);
    const missing = v.sports.filter((s) => !have.includes(s));
    if (missing.length) throw badRequest(`Unknown sport: ${missing.join(', ')}`);
  }
  const landing = [v.landing_entity_type || v.landing_entity_id ? 'entity' : null, v.landing_url ? 'url' : null].filter(Boolean);
  if (landing.length > 1) throw badRequest('Choose one destination: a Gotmygame page or an external link');
  if (!!v.landing_entity_type !== !!v.landing_entity_id) throw badRequest('Pick the page this ad promotes');
  if (v.landing_url && !safeLandingUrl(v.landing_url)) throw badRequest('The destination must be a secure https link to a public website');
  if (v.landing_entity_type) await checkEntity(user, advertiser, v.landing_entity_type, v.landing_entity_id, c);
  for (const code of v.placements) {
    const p = PLACEMENTS[code];
    if (p.entity && v.landing_entity_type !== p.entity) throw badRequest(`${p.label} promotes a ${p.entity}: pick the ${p.entity} (it must be yours)`);
  }
  if (v.placements.includes('search_sponsored') && !v.keywords.length) throw badRequest('A sponsored search slot needs at least one keyword');
  if (v.keywords.length && !v.placements.includes('search_sponsored')) throw badRequest('Keywords only apply to a sponsored search slot');
  if (v.audience === 'followers' && !['venue', 'event'].includes(v.landing_entity_type)) throw badRequest('Followers can only be reached for a venue or an event you promote');
  const bad = screenCopy(v.name);
  if (bad) throw unprocessable('That looks like a category that cannot be advertised', { category: bad.category });
}

async function attachMedia(c, user, creative, campaignId) {
  if (!creative.media_id) return;
  const m = (await c.query('SELECT id, uploader_id, kind, content_type, post_id, product_id, purpose, removed_at FROM market_media WHERE id=$1', [creative.media_id])).rows[0];
  if (!m || m.removed_at || m.uploader_id !== user.id || m.kind !== 'photo' || m.content_type === 'image/gif' || m.post_id || m.product_id || (m.purpose && m.purpose !== 'ad_creative')) throw badRequest('Use a JPEG, PNG or WebP photo that you uploaded and have not used elsewhere');
  await c.query("UPDATE market_media SET purpose='ad_creative' WHERE id=$1", [m.id]);
}

async function addCreative(c, user, camp, input) {
  const bad = screenCopy(input.headline, input.body);
  if (bad) throw unprocessable('The wording looks like a category that cannot be advertised', { category: bad.category, term: bad.term });
  await attachMedia(c, user, input, camp.id);
  const version = Number((await c.query('SELECT coalesce(max(version),0)+1 AS v FROM ad_creatives WHERE campaign_id=$1', [camp.id])).rows[0].v);
  const cr = (await c.query(
    `INSERT INTO ad_creatives(campaign_id, version, headline, body, cta, media_id, alt_text, claims, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [camp.id, version, input.headline, input.body ?? null, input.cta, input.media_id ?? null, input.alt_text ?? null, input.claims ?? [], user.id])).rows[0];
  // the previous draft version, if never submitted, is superseded (kept, marked withdrawn)
  await c.query("UPDATE ad_creatives SET status='withdrawn' WHERE campaign_id=$1 AND id <> $2 AND status IN ('draft','rejected')", [camp.id, cr.id]);
  await c.query('UPDATE ad_campaigns SET current_creative_id=$2, updated_at=now() WHERE id=$1', [camp.id, cr.id]);
  await logCampaign(c, camp.id, user.id, 'creative_saved', { version });
  return cr;
}

/** Editing an ad that is waiting, rejected or paused sends it back to draft: it must be reviewed again before it can show. */
const EDITABLE = ['draft', 'rejected', 'paused'];
async function editableCampaign(user, campaignId, c) {
  const { camp, advertiser } = await loadCampaign(user, campaignId, { write: true, c });
  if (!EDITABLE.includes(camp.status)) throw conflict(camp.status === 'submitted' ? 'This campaign is with the review desk. Withdraw it to change it.' : 'Pause the campaign to change it: changes are reviewed again before the ad shows.');
  if (camp.held_by_platform) throw forbidden('The platform has paused this campaign; resolve it with the review desk first');
  return { camp, advertiser };
}

// ================================================================================================== catalogue and policy
cap({
  name: 'get_advertising_policy', method: 'GET', path: '/advertising/policy', tag: TAG, auth: 'public',
  summary: 'What can be advertised and where: the placement catalogue (each with the organic surface it sits beside, who may buy it and how it is measured, and whether it is on sale), the allowed and prohibited categories, what a campaign may be targeted on and what it never may, the platform\'s youth rule, creative review and disclosure rules, and the published measurement definitions.',
  async handler() {
    const policy = await getPolicy();
    return {
      placements: (await inventoryOf()).map((p) => ({ code: p.code, label: p.label, surface: p.surface, organic_source_left_untouched: p.organic, advertiser_eligibility: p.eligibility, measurement: p.measurement, disclosure: p.disclosure === 'promoted' ? 'Promoted' : 'Sponsored', needs: p.entity ?? (p.keywords ? 'keywords' : null), organiser_must_allow: p.rights === 'event', on_sale: p.enabled, in_app: p.app !== false, slots: p.max_slots })),
      categories: { allowed: ALLOWED_CATEGORIES.map((k) => ({ code: k, label: CATEGORIES[k].label })), prohibited: PROHIBITED_CATEGORIES.map((k) => ({ code: k, label: CATEGORIES[k].label })) },
      targeting: { allowed: TARGETING_ALLOWED, never: TARGETING_FORBIDDEN },
      billing_models: { flat: 'One fee for the whole run, taken when the campaign starts; credited back if it ends before anything was shown.', cpm: 'A price per 1,000 impressions, charged per impression served.', cpc: 'A price per click, charged per click.' },
      integrity: ['Paid placements are separate, labelled slots. They never change an organic list, ranking, standing, tender evaluation, sponsor application score, eligibility or selection, or a rating.', 'Position among paid ads is a fair rotation, not a bid: paying more never shows you more often.'],
      youth: { contextual_allowed: policy.youth_contextual, rule: 'Young people and youth events are not shown ads unless the platform allows approved, contextual-only campaigns; there is no behavioural profiling of a young person either way.' },
      review: ['draft', 'submitted', 'approved / rejected', 'scheduled', 'active', 'paused', 'ended / withdrawn'],
      frequency: { default_per_day: policy.default_frequency, max_per_day: policy.max_frequency },
      metrics: METRIC_DEFINITIONS, call_to_actions: CTAS, report_reasons: REPORT_REASONS,
    };
  },
});

cap({
  name: 'get_advertising_home', method: 'GET', path: '/advertising', tag: TAG,
  summary: 'Your advertising workspace: the accounts you can advertise for (you, and the organisations you own, administer or handle finance for), their campaigns with status and spend, and anything waiting on you (rejected, needing funds).',
  async handler({ user }) {
    const who = await advertisersOf(user);
    const ids = [who.me.advertiser_id, ...who.organisations.map((o) => o.advertiser_id)].filter(Boolean);
    const campaigns = ids.length ? await many(`SELECT ${CAMP} FROM ad_campaigns WHERE advertiser_id = ANY($1) ORDER BY created_at DESC LIMIT 200`, [ids]) : [];
    const cards = [];
    for (const camp of campaigns) cards.push(await withPlacements(camp));
    const needs = cards.filter((x) => x.status === 'rejected' || (x.status === 'approved' && x.funded_minor - x.refunded_minor < minimumFunding({ rate_minor: x.rate_minor }))).map((x) => ({ campaign_id: x.id, name: x.name, why: x.status === 'rejected' ? 'Rejected: see the reviewer\'s reason' : 'Approved: add funds to start' }));
    return { ...who, campaigns: cards, waiting_on_you: needs };
  },
});

// ================================================================================================== advertiser account
cap({
  name: 'open_advertiser_account', method: 'POST', path: '/advertising/advertisers', tag: TAG, status: 201,
  summary: 'Start advertising as yourself or as an organisation you own or administer, by accepting the advertising policy. Everything you promote must be yours to promote, and prohibited categories are refused. Idempotent.',
  input: z.object({ organisation_id: id.optional(), accept_policy: z.literal(true, { error: 'Accept the advertising policy to continue' }) }),
  async handler({ user }, i) {
    const policy = await getPolicy();
    return tx(async (c) => {
      if (i.organisation_id && !(await hasOrgGrant(user, i.organisation_id, MANAGE, c))) throw notFound('Organisation');
      const key = i.organisation_id ? 'organisation_id' : 'user_id';
      const existing = (await c.query(`SELECT * FROM ad_advertisers WHERE ${key}=$1`, [i.organisation_id ?? user.id])).rows[0];
      if (existing) return { id: existing.id, status: existing.status, policy_version: existing.policy_version };
      const a = (await c.query(`INSERT INTO ad_advertisers(${key}, policy_version, accepted_by) VALUES ($1,$2,$3) RETURNING *`, [i.organisation_id ?? user.id, policy.version, user.id])).rows[0];
      await audit(c, user.id, 'open_advertiser_account', 'ad_advertisers', a.id);
      return { id: a.id, status: a.status, policy_version: a.policy_version };
    });
  },
});

// ================================================================================================== campaigns
cap({
  name: 'create_ad_campaign', method: 'POST', path: '/advertising/campaigns', tag: TAG, status: 201,
  summary: 'Create a campaign (draft): what you promote and its category, where it appears (one or several placements), the objective, the billing model and budget, the dates, and who may see it — only sport, coarse country or city, search keywords, followers of the venue or event you promote, and a daily frequency cap. Anything about health, legal matters, insurance claims, sensitive characteristics, young people\'s data, private messages or precise location is not an option and is refused. A campaign promotes only what you manage. Add the creative next, then submit it for review.',
  input: z.object({ advertiser_id: id, ...campaignShape, creative: creativeInput.optional() }).strict(),
  async handler({ user }, i) {
    const { creative, advertiser_id, placements, ...v } = i;
    return tx(async (c) => {
      const advertiser = await advertiserAccess(user, advertiser_id, { write: true, c });
      if (advertiser.status !== 'active') throw forbidden('This advertiser account is suspended');
      await validate(user, advertiser, { ...v, placements }, c);
      const camp = (await c.query(
        `INSERT INTO ad_campaigns(advertiser_id, name, objective, category, billing_model, rate_minor, currency, budget_minor, starts_on, ends_on, countries, cities, sports, keywords, audience, frequency_per_day,
                                  disclosure, landing_entity_type, landing_entity_id, landing_url, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [advertiser.id, v.name, v.objective, v.category, v.billing_model, v.rate_minor, v.currency, v.budget_minor, v.starts_on, v.ends_on, v.countries, v.cities, v.sports, v.keywords, v.audience, v.frequency_per_day ?? null,
          disclosureFor(placements), v.landing_entity_type ?? null, v.landing_entity_id ?? null, v.landing_url ?? null, user.id])).rows[0];
      for (const code of placements) await c.query('INSERT INTO ad_campaign_placements(campaign_id, placement_code) VALUES ($1,$2)', [camp.id, code]);
      await logCampaign(c, camp.id, user.id, 'created', {});
      if (creative) await addCreative(c, user, camp, creative);
      return withPlacements((await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0]);
    });
  },
});

cap({
  name: 'update_ad_campaign', method: 'PATCH', path: '/advertising/campaigns/:id', tag: TAG,
  summary: 'Change a campaign that is a draft, rejected or paused. A change to a paused or rejected campaign puts it back to draft: it is reviewed again before it can show. Not allowed while it is with the review desk or live — pause it first.',
  input: z.object({ id, ...Object.fromEntries(Object.entries(campaignShape).map(([k, sch]) => [k, sch.optional()])) }).strict(),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { camp, advertiser } = await editableCampaign(user, i.id, c);
      const cur = await withPlacements(camp);
      const patch = Object.fromEntries(Object.entries(i).filter(([k, x]) => k !== 'id' && x !== undefined));
      const v = {
        name: cur.name, objective: cur.objective, category: cur.category, billing_model: cur.billing_model, rate_minor: cur.rate_minor, currency: cur.currency, budget_minor: cur.budget_minor,
        starts_on: cur.starts_on, ends_on: cur.ends_on, sports: cur.sports, countries: cur.countries, cities: cur.cities, keywords: cur.keywords, audience: cur.audience,
        frequency_per_day: cur.frequency_per_day ?? undefined, landing_entity_type: camp.landing_entity_type ?? undefined, landing_entity_id: camp.landing_entity_id ?? undefined, landing_url: camp.landing_url ?? undefined,
        placements: cur.placements, ...patch,
      };
      if (patch.landing_url) { v.landing_entity_type = undefined; v.landing_entity_id = undefined; }
      if (patch.landing_entity_type) v.landing_url = undefined;
      if (Number(camp.funded_minor) > 0 && patch.currency && patch.currency !== camp.currency) throw conflict('The currency cannot change once funds were added');
      if (Number(camp.funded_minor) > 0 && patch.billing_model && patch.billing_model !== camp.billing_model) throw conflict('The billing model cannot change once funds were added');
      await validate(user, advertiser, v, c);
      const next = (await c.query(
        `UPDATE ad_campaigns SET name=$2, objective=$3, category=$4, billing_model=$5, rate_minor=$6, currency=$7, budget_minor=$8, starts_on=$9, ends_on=$10, countries=$11, cities=$12, sports=$13, keywords=$14,
                audience=$15, frequency_per_day=$16, disclosure=$17, landing_entity_type=$18, landing_entity_id=$19, landing_url=$20, status='draft', updated_at=now() WHERE id=$1 RETURNING ${CAMP}`,
        [camp.id, v.name, v.objective, v.category, v.billing_model, v.rate_minor, v.currency, v.budget_minor, v.starts_on, v.ends_on, v.countries, v.cities, v.sports, v.keywords, v.audience, v.frequency_per_day ?? null,
          disclosureFor(v.placements), v.landing_entity_type ?? null, v.landing_entity_id ?? null, v.landing_url ?? null])).rows[0];
      if (patch.placements) {
        await c.query('UPDATE ad_campaign_placements SET removed_at=now() WHERE campaign_id=$1 AND removed_at IS NULL AND NOT (placement_code = ANY($2))', [camp.id, patch.placements]);
        for (const code of patch.placements) await c.query('INSERT INTO ad_campaign_placements(campaign_id, placement_code) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM ad_campaign_placements WHERE campaign_id=$1 AND placement_code=$2 AND removed_at IS NULL)', [camp.id, code]);
      }
      if (camp.status !== 'draft') await logCampaign(c, camp.id, user.id, 'returned_to_draft', { was: camp.status });
      await logCampaign(c, camp.id, user.id, 'edited', {});
      return withPlacements(next);
    });
  },
});

cap({
  name: 'save_ad_creative', method: 'POST', path: '/advertising/campaigns/:id/creatives', tag: TAG, status: 201,
  summary: 'Write the ad itself: a headline, optional line of text, a button from a fixed list, an optional photo (upload it first with PUT /market/media; it must come with a description for screen readers) and the kinds of claim it makes. Each save is a new version; the latest is what is submitted. Sent back to draft if it was paused or rejected.',
  input: z.object({ id, ...creativeShape }).refine((x) => !x.media_id || !!x.alt_text, { message: 'Describe the picture', path: ['alt_text'] }),
  async handler({ user }, i) {
    const { id: campaignId, ...creative } = i;
    return tx(async (c) => {
      const { camp } = await editableCampaign(user, campaignId, c);
      const cr = await addCreative(c, user, camp, creative);
      if (camp.status !== 'draft') await c.query("UPDATE ad_campaigns SET status='draft' WHERE id=$1", [camp.id]);
      return { id: cr.id, version: cr.version, status: cr.status, headline: cr.headline, body: cr.body, cta: cr.cta, cta_label: cta(cr.cta), media_id: cr.media_id, alt_text: cr.alt_text, claims: cr.claims };
    });
  },
});

cap({
  name: 'list_ad_campaigns', method: 'GET', path: '/advertising/campaigns', tag: TAG,
  summary: 'Campaigns of an advertiser account you can act for, newest first, optionally by status.',
  input: z.object({ advertiser_id: id, status: z.enum(['draft', 'submitted', 'rejected', 'approved', 'scheduled', 'active', 'paused', 'ended', 'withdrawn']).optional(), ...page }),
  async handler({ user }, i) {
    await advertiserAccess(user, i.advertiser_id);
    const rows = await many(`SELECT ${CAMP} FROM ad_campaigns WHERE advertiser_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [i.advertiser_id, i.status ?? null, i.limit, i.offset]);
    return Promise.all(rows.map(withPlacements));
  },
});

cap({
  name: 'get_ad_campaign', method: 'GET', path: '/advertising/campaigns/:id', tag: TAG,
  summary: 'One campaign in full: its settings, the ad versions, review decisions with reasons, the timeline, funds and invoices, what is needed before it can run, and the next step you can take.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { camp, advertiser } = await loadCampaign(user, i.id);
    const problems = ['draft', 'rejected'].includes(camp.status) ? await readiness(user, camp, advertiser) : [];
    const fundings = await many('SELECT id, number, amount_minor, currency, status, refunded_minor, created_at, paid_at FROM ad_fundings WHERE campaign_id=$1 ORDER BY created_at DESC', [camp.id]);
    const reviews = await many('SELECT decision, reason_category, reason, claims_checked, created_at FROM ad_reviews WHERE campaign_id=$1 ORDER BY created_at DESC', [camp.id]);
    const log = await many('SELECT action, detail, created_at FROM ad_campaign_log WHERE campaign_id=$1 ORDER BY id DESC LIMIT 40', [camp.id]);
    const funded = Number(camp.funded_minor) - Number(camp.refunded_minor);
    return {
      campaign: await withPlacements(camp), advertiser_name: await advertiserName(advertiser), creatives: (await creativeRows(camp.id)).map((x) => ({ ...x, cta_label: cta(x.cta) })), reviews, timeline: log,
      fundings, money: await moneyFor(camp.id), refundable_minor: ['ended', 'withdrawn'].includes(camp.status) ? await refundableMinor(camp.id) : 0, needs_before_submit: problems,
      can: {
        edit: ['draft', 'rejected', 'paused'].includes(camp.status) && !camp.held_by_platform, submit: ['draft', 'rejected'].includes(camp.status) && !problems.length,
        start: camp.status === 'approved' && funded >= minimumFunding(camp), fund: !['ended', 'withdrawn'].includes(camp.status),
        pause: canTransition('pause', camp.status), resume: camp.status === 'paused' && !camp.held_by_platform && !!camp.activated_at, end: canTransition('end', camp.status), withdraw: canTransition('withdraw', camp.status),
      },
    };
  },
});

const lifecycle = (name, path, summary, run) => cap({
  name, method: 'POST', path: `/advertising/campaigns/:id/${path}`, tag: TAG, summary, input: z.object({ id, reason: z.string().trim().max(300).optional() }),
  async handler({ user }, i) { return tx(async (c) => { const out = await run(c, user, i); return out; }); },
});

lifecycle('submit_ad_campaign', 'submit', 'Send a draft (or rejected) campaign to the platform\'s review desk. It needs a destination if it is a traffic campaign, the ad itself, and a plan that includes advertising. Nothing shows until it is approved, funded and started.', async (c, user, i) => {
  const { camp, advertiser } = await loadCampaign(user, i.id, { write: true, c });
  const problems = await readiness(user, camp, advertiser, c);
  if (problems.length) throw unprocessable('This campaign is not ready to submit', { problems });
  await requireAdsEntitlement(advertiser);
  await moveCampaign(c, camp, 'submit', user.id);
  return withPlacements((await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0]);
});

lifecycle('start_ad_campaign', 'start', 'Start an approved campaign once it is funded: it goes live on its start date (or now, if that has come). A flat fee is taken from the funds when it starts.', async (c, user, i) => {
  const { camp, advertiser } = await loadCampaign(user, i.id, { write: true, money: true, c });
  if (camp.status !== 'approved') throw conflict(camp.status === 'draft' || camp.status === 'submitted' ? 'The review desk has not approved this campaign yet' : `A ${camp.status} campaign cannot be started`);
  if (advertiser.status !== 'active') throw forbidden('This advertiser account is suspended');
  if (camp.ends_on < new Date().toISOString().slice(0, 10)) throw conflict('The end date has passed: change the dates and submit again');
  await c.query('SELECT id FROM ad_campaigns WHERE id=$1 FOR UPDATE', [camp.id]);
  await goLive(c, (await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0], user.id);
  return withPlacements((await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0]);
});

lifecycle('pause_ad_campaign', 'pause', 'Pause a scheduled or live campaign. Delivery stops at once; funds and settings stay.', async (c, user, i) => {
  const { camp } = await loadCampaign(user, i.id, { write: true, c });
  await moveCampaign(c, camp, 'pause', user.id, { reason: i.reason });
  return withPlacements((await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0]);
});

lifecycle('resume_ad_campaign', 'resume', 'Resume a campaign you paused. A campaign the platform paused can only be resumed by the review desk, and one you changed while paused goes back to review first.', async (c, user, i) => {
  const { camp } = await loadCampaign(user, i.id, { write: true, c });
  if (camp.status !== 'paused') throw conflict('Only a paused campaign can be resumed');
  if (camp.held_by_platform) throw forbidden('The platform paused this campaign; contact the review desk');
  if (!camp.activated_at) throw conflict('This campaign has not started yet');
  if (camp.ends_on < new Date().toISOString().slice(0, 10)) throw conflict('The end date has passed');
  const to = camp.starts_on > new Date().toISOString().slice(0, 10) ? 'scheduled' : 'active';
  await c.query('UPDATE ad_campaigns SET status=$2, updated_at=now() WHERE id=$1', [camp.id, to]);
  await logCampaign(c, camp.id, user.id, 'resumed', {});
  return withPlacements((await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0]);
});

lifecycle('end_ad_campaign', 'end', 'End a campaign for good. Unspent funds can then be refunded. A flat fee is credited back if nothing was shown.', async (c, user, i) => {
  const { camp } = await loadCampaign(user, i.id, { write: true, c });
  await moveCampaign(c, camp, 'end', user.id, { reason: i.reason ?? 'ended_by_advertiser' });
  return withPlacements((await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0]);
});

lifecycle('withdraw_ad_campaign', 'withdraw', 'Withdraw a campaign, whatever stage it is at (a draft, one in review, approved or live). It stops at once and cannot be restarted; unspent funds can be refunded.', async (c, user, i) => {
  const { camp } = await loadCampaign(user, i.id, { write: true, c });
  await moveCampaign(c, camp, 'withdraw', user.id, { reason: i.reason ?? 'withdrawn_by_advertiser' });
  return withPlacements((await c.query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [camp.id])).rows[0]);
});

// ================================================================================================== money
cap({
  name: 'fund_ad_campaign', method: 'POST', path: '/advertising/campaigns/:id/fund', tag: TAG, status: 201,
  summary: 'Add budget to a campaign. This creates a numbered funding invoice; pay it with create_payment (purpose_type `ad_funding`, purpose_id = the returned funding id) through the hosted checkout. The funds count only once the provider confirms payment, and delivery can never spend more than is funded. Owners, administrators and finance members can fund.',
  input: z.object({ id, amount_minor: money }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { camp } = await loadCampaign(user, i.id, { money: true, c });
      if (['ended', 'withdrawn'].includes(camp.status)) throw conflict('This campaign is over');
      const open = Number((await c.query("SELECT count(*) AS n FROM ad_fundings WHERE campaign_id=$1 AND status='awaiting_payment'", [camp.id])).rows[0].n);
      if (open >= 5) throw conflict('Pay or cancel the unpaid funding invoices first');
      const room = Number(camp.budget_minor) - (Number(camp.funded_minor) - Number(camp.refunded_minor));
      if (i.amount_minor > Math.max(room, 0)) throw badRequest(`This campaign's budget is ${camp.budget_minor}: you can add at most ${Math.max(room, 0)} more`);
      const n = (await c.query("SELECT nextval('ad_funding_seq') AS n")).rows[0].n;
      const number = `AD-${new Date().getUTCFullYear()}-${String(n).padStart(6, '0')}`;
      const f = (await c.query('INSERT INTO ad_fundings(number, campaign_id, payer_id, amount_minor, currency) VALUES ($1,$2,$3,$4,$5) RETURNING *', [number, camp.id, user.id, i.amount_minor, camp.currency])).rows[0];
      await logCampaign(c, camp.id, user.id, 'funding_invoice_created', { number, amount_minor: i.amount_minor });
      return { id: f.id, number, amount_minor: Number(f.amount_minor), currency: f.currency, status: f.status, pay_with: { purpose_type: 'ad_funding', purpose_id: f.id } };
    });
  },
});

cap({
  name: 'void_ad_funding', method: 'POST', path: '/advertising/fundings/:id/void', tag: TAG,
  summary: 'Cancel a funding invoice that has not been paid. A paid one is refunded instead (refund_ad_balance).', input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const f = (await c.query('SELECT * FROM ad_fundings WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!f) throw notFound('Funding');
      await loadCampaign(user, f.campaign_id, { money: true, c });
      if (f.status !== 'awaiting_payment') throw conflict('Only an unpaid invoice can be cancelled');
      await c.query("UPDATE ad_fundings SET status='void' WHERE id=$1", [f.id]);
      await logCampaign(c, f.campaign_id, user.id, 'funding_invoice_void', { number: f.number });
      return { id: f.id, status: 'void' };
    });
  },
});

cap({
  name: 'refund_ad_balance', method: 'POST', path: '/advertising/campaigns/:id/refund-balance', tag: TAG,
  summary: 'Get the unspent funds of an ended or withdrawn campaign back to the original payment method: funded, minus refunded, minus everything spent. Refunds go to the cards that paid, oldest funding first, and cannot exceed what each payment received.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { camp } = await loadCampaign(user, i.id, { money: true });
    if (!['ended', 'withdrawn'].includes(camp.status)) throw conflict('End or withdraw the campaign first');
    let left = await refundableMinor(camp.id);
    if (left <= 0) return { refunded_minor: 0, currency: camp.currency, remaining_refundable_minor: 0 };
    let given = 0;
    const pays = await many(
      `SELECT p.* FROM payments p JOIN ad_fundings f ON f.id=p.purpose_id WHERE p.purpose_type='ad_funding' AND f.campaign_id=$1 AND p.status IN ('paid') ORDER BY p.created_at, p.id`, [camp.id]);
    for (const p of pays) {
      if (left <= 0) break;
      const n = await refundPartial(p, left, `ad-balance-${camp.id}-${p.id}-${p.refunded_cents}-${left}`);
      given += n; left -= n;
    }
    await tx(async (c) => { await audit(c, user.id, 'refund_ad_balance', 'ad_campaigns', camp.id); });
    return { refunded_minor: given, currency: camp.currency, remaining_refundable_minor: await refundableMinor(camp.id) };
  },
});

// ================================================================================================== reporting
cap({
  name: 'get_ad_report', method: 'GET', path: '/advertising/campaigns/:id/report', tag: TAG,
  summary: 'Delivery and spend for a campaign, added up from the same immutable delivery records the platform\'s own reports use: impressions, clicks, click rate, what was not charged and why, by day and by placement, plus funds and a reconciliation of spend against the records. Reach and conversions are not measured and are returned as null with the reason in `definitions`.',
  input: z.object({ id, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const { camp } = await loadCampaign(user, i.id);
    return { campaign_id: camp.id, currency: camp.currency, ...(await reportFor({ campaignId: camp.id, from: i.from ?? null, to: i.to ?? null })), money: await moneyFor(camp.id) };
  },
});

// ================================================================================================== serving, clicks, and people's controls
const ctx = {
  placement: z.enum(PLACEMENT_CODES),
  sport: z.string().regex(/^[a-z0-9-]+$/).max(60).optional().describe('the sport slug of the page'),
  country: z.string().length(2).optional().describe('two-letter country the person chose, if any'),
  city: z.string().max(60).optional().describe('the city the person chose, if any — never coordinates'),
  q: z.string().max(80).optional().describe('what they searched for (sponsored search slot)'),
  event_id: id.optional().describe('the event whose page this is (event display / scorecard / leaderboard)'),
};
cap({
  name: 'serve_ads', method: 'GET', path: '/public/ads', tag: TAG, auth: 'public',
  summary: 'The paid, labelled ads for one placement on the page the person is looking at. Each carries `label` (Sponsored or Promoted), the advertiser, a plain reason it is shown, and a `token` to follow, hide or report it. Selection uses only the page context you pass (sport, the city or country the person chose, the search text, the event) and a keyed daily frequency count — never anything private. Young people and youth events get none unless the platform allows approved contextual campaigns. Returns an empty list, never an error, when nothing is eligible. Calling it records the impressions it returns.',
  input: z.object(ctx),
  async handler({ user, meta }, i) {
    const out = await serveAds({ user, meta, placement: i.placement, sport: i.sport, country: i.country, city: i.city, q: i.q, eventId: i.event_id });
    return { placement: i.placement, ads: out.ads, why_empty: out.ads.length ? null : out.reason ?? 'no_eligible_ad' };
  },
});

cap({
  name: 'follow_ad', method: 'POST', path: '/public/ads/:token/click', tag: TAG, auth: 'public',
  summary: 'Count a visitor following an ad\'s button and say where it leads (a Gotmygame page, or an external https link). The token only works for the person it was served to, once, shortly after it was shown, and only while the campaign is live and its ad still approved — a paused or withdrawn ad leads nowhere.',
  input: z.object({ token: id }),
  async handler({ user, meta }, i) { return followAd({ user, meta, token: i.token }); },
});

async function impressionFor(user, meta, token) {
  const imp = await one("SELECT d.id, d.campaign_id, d.creative_id, d.viewer_hash, c.advertiser_id FROM ad_delivery_events d JOIN ad_campaigns c ON c.id=d.campaign_id WHERE d.id=$1 AND d.kind='impression'", [token]);
  if (!imp || (imp.viewer_hash && imp.viewer_hash !== viewerHash(user, meta))) throw notFound('Ad');
  return imp;
}

cap({
  name: 'hide_ad', method: 'POST', path: '/ads/:token/hide', tag: TAG, status: 201,
  summary: 'Stop seeing this ad, or every ad from this advertiser. Takes effect on the next request. Undo with remove_ad_hide.',
  input: z.object({ token: id, scope: z.enum(['campaign', 'advertiser']).default('campaign') }),
  async handler({ user, meta }, i) {
    const imp = await impressionFor(user, meta, i.token);
    const col = i.scope === 'advertiser' ? 'advertiser_id' : 'campaign_id';
    const val = i.scope === 'advertiser' ? imp.advertiser_id : imp.campaign_id;
    await one(`INSERT INTO ad_hides(user_id, ${col}) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM ad_hides WHERE user_id=$1 AND ${col}=$2 AND removed_at IS NULL) RETURNING id`, [user.id, val]);
    return { hidden: i.scope };
  },
});

cap({
  name: 'list_my_ad_hides', method: 'GET', path: '/me/ad-hides', tag: TAG,
  summary: 'The ads and advertisers you chose to stop seeing.',
  async handler({ user }) {
    return many(
      `SELECT h.id, CASE WHEN h.advertiser_id IS NOT NULL THEN 'advertiser' ELSE 'campaign' END AS scope, h.created_at,
              coalesce(o.name, u.display_name, c.name) AS name
         FROM ad_hides h LEFT JOIN ad_advertisers a ON a.id=h.advertiser_id LEFT JOIN organisations o ON o.id=a.organisation_id LEFT JOIN users u ON u.id=a.user_id
         LEFT JOIN ad_campaigns c ON c.id=h.campaign_id WHERE h.user_id=$1 AND h.removed_at IS NULL ORDER BY h.created_at DESC`, [user.id]);
  },
});

cap({
  name: 'remove_ad_hide', method: 'POST', path: '/me/ad-hides/:id/remove', tag: TAG, summary: 'Show ads from them again.', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE ad_hides SET removed_at=now() WHERE id=$1 AND user_id=$2 AND removed_at IS NULL RETURNING id', [i.id, user.id]);
    if (!r) throw notFound('Hide');
    return { removed: true };
  },
});

cap({
  name: 'report_ad', method: 'POST', path: '/public/ads/:token/report', tag: TAG, auth: 'public', status: 201,
  summary: 'Report an ad you were shown (misleading, offensive, irrelevant, unsafe, not suitable for children, other). One report per impression; the optional note is encrypted and read only by the review desk, whose reads are audit-logged.',
  input: z.object({ token: id, reason: z.enum(REPORT_REASONS), note: z.string().trim().max(500).optional() }),
  async handler({ user, meta }, i) {
    const imp = await impressionFor(user, meta, i.token);
    const r = await one(
      `INSERT INTO ad_reports(campaign_id, creative_id, impression_id, reporter_id, reason, note_enc) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (impression_id) DO NOTHING RETURNING id`,
      [imp.campaign_id, imp.creative_id, imp.id, user?.id ?? null, i.reason, i.note ? encrypt(i.note, 'ad_reports.note') : null]);
    return { received: true, duplicate: !r };
  },
});
