// Advertising engine (#524): campaign access and lifecycle, funds and spend, serving, clicks and reports.
// Paid placements live ONLY here and in the `ad_*` tables. Nothing in this file is imported by, or writes to, a ranking, tender, eligibility,
// selection or review-score module (a test walks the source tree to keep it that way).
//
// Money model. A campaign is prepaid: the advertiser funds it through the hosted checkout (ad_fundings → payments 'ad_funding'). Delivery
// spends from the funded amount in micro-units (1 minor unit = 1,000,000 micro) so a price per thousand impressions can be charged per
// impression. Every charge is one conditional UPDATE (`spent + cost <= ceiling`), so concurrent requests can never overspend; the
// immutable delivery rows are the facts both the advertiser's and the platform's numbers are added up from.
import { blindIndex } from '../crypto.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hasOrgGrant } from '../org-access.js';
import { canManage } from '../booking/engine.js';
import { isOrganiserOf } from '../media-rights.js';
import { isYouthEvent } from '../spectator.js';
import { YOUTH_SQL } from '../youth.js';
import { requireEntitlement } from '../commercial/engine.js';
import { PLACEMENTS, PLACEMENT_CODES, isCategoryAllowed, METRIC_DEFINITIONS } from './policy.js';

export const MICRO = 1_000_000;
export const IMPRESSION_BUCKET_SECONDS = 20;     // the same person asking again inside this window is the same impression
export const RATE_LIMIT_PER_MINUTE = 40;          // more than this from one viewer is not served at all
export const CLICK_WINDOW_MINUTES = 60;           // a click must follow its impression within this long

/** Campaign columns with the two dates as plain YYYY-MM-DD strings (the driver would otherwise hand back time-zone dependent Date objects). */
export const CAMP = '*, starts_on::text AS starts_on, ends_on::text AS ends_on';
const MANAGE = ['owner', 'admin'];
const MONEY = ['owner', 'admin', 'finance'];
const db = (c) => c ?? pool;
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ policy and inventory
export async function getPolicy(c) {
  return (await db(c).query('SELECT * FROM ad_policy WHERE id')).rows[0];
}
export async function inventoryOf(c) {
  const rows = (await db(c).query('SELECT * FROM ad_inventory')).rows;
  return PLACEMENT_CODES.map((code) => {
    const r = rows.find((x) => x.placement_code === code);
    // a placement whose organic list does not exist in the app yet starts switched off: nothing is sold that cannot be shown
    return { code, ...PLACEMENTS[code], enabled: r ? r.enabled : PLACEMENTS[code].app !== false, max_slots: r ? r.max_slots : 1 };
  });
}

// ------------------------------------------------------------------ advertisers and access
/** Everything that can advertise for `user`: themselves and the organisations they run. Read-only helper for the console. */
export async function advertisersOf(user) {
  const orgs = await many(
    `SELECT o.id, o.name, o.kind, m.role, a.id AS advertiser_id, a.status
       FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id AND o.status='active' LEFT JOIN ad_advertisers a ON a.organisation_id=o.id
      WHERE m.user_id=$1 AND m.status='active' AND m.role = ANY($2) ORDER BY o.name`, [user.id, MONEY]);
  const me = await one('SELECT id, status FROM ad_advertisers WHERE user_id=$1', [user.id]);
  return { me: { advertiser_id: me?.id ?? null, status: me?.status ?? null }, organisations: orgs.map((o) => ({ organisation_id: o.id, name: o.name, kind: o.kind, role: o.role, advertiser_id: o.advertiser_id, status: o.status, can_manage: MANAGE.includes(o.role) })) };
}

/** Load an advertiser the caller may act for (404 for outsiders so existence is not leaked). */
export async function advertiserAccess(user, advertiserId, { write = false, money = false, c } = {}) {
  const a = (await db(c).query('SELECT * FROM ad_advertisers WHERE id=$1', [advertiserId])).rows[0];
  if (!a) throw notFound('Advertiser');
  const ok = a.user_id ? a.user_id === user.id : await hasOrgGrant(user, a.organisation_id, write ? MANAGE : MONEY, c);
  if (!ok && !(a.organisation_id && !write && await hasOrgGrant(user, a.organisation_id, MONEY, c))) throw notFound('Advertiser');
  if (money && a.organisation_id && !(await hasOrgGrant(user, a.organisation_id, MONEY, c))) throw forbidden('Your role in this organisation does not allow that');
  return a;
}

export async function loadCampaign(user, id, { write = false, money = false, c } = {}) {
  const camp = (await db(c).query(`SELECT ${CAMP} FROM ad_campaigns WHERE id=$1`, [id])).rows[0];
  if (!camp) throw notFound('Campaign');
  const advertiser = await advertiserAccess(user, camp.advertiser_id, { write, money, c });
  return { camp, advertiser };
}

export const subjectOf = (a) => (a.user_id ? { type: 'user', id: a.user_id } : { type: 'organisation', id: a.organisation_id });

export async function advertiserName(a, c) {
  if (a.organisation_id) return (await db(c).query('SELECT name FROM organisations WHERE id=$1', [a.organisation_id])).rows[0]?.name ?? 'Advertiser';
  return (await db(c).query('SELECT display_name FROM users WHERE id=$1', [a.user_id])).rows[0]?.display_name ?? 'Advertiser';
}

// ------------------------------------------------------------------ what a campaign may point at
const NOT_FOUND_ENTITY = 'That is not something you can promote';

/** May `user`, advertising as `advertiser`, promote this entity? Returns its display name or throws. */
export async function checkEntity(user, advertiser, type, entityId, c) {
  const q = (sql, p) => db(c).query(sql, p).then((r) => r.rows[0]);
  if (type === 'venue') {
    const v = await q('SELECT id, name FROM venues WHERE id=$1', [entityId]);
    if (!v || !(await canManage(user, v.id, c))) throw badRequest(NOT_FOUND_ENTITY);
    return v.name;
  }
  if (type === 'coach') {
    const u = await q("SELECT id, display_name FROM users WHERE id=$1 AND 'coach' = ANY(roles)", [entityId]);
    const mine = u && (u.id === user.id || (advertiser.organisation_id && (await q("SELECT 1 AS x FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [advertiser.organisation_id, u.id]))));
    if (!mine) throw badRequest(NOT_FOUND_ENTITY);
    return u.display_name;
  }
  if (type === 'academy') {
    const o = await q("SELECT o.id, o.name FROM organisations o JOIN academy_profiles ap ON ap.organisation_id=o.id AND ap.listed WHERE o.id=$1 AND o.kind='academy' AND o.status='active'", [entityId]);
    if (!o || !(o.id === advertiser.organisation_id || await hasOrgGrant(user, o.id, MANAGE, c))) throw badRequest(NOT_FOUND_ENTITY);
    return o.name;
  }
  if (type === 'event') {
    const ev = await q('SELECT * FROM events WHERE id=$1', [entityId]);
    if (!ev || !(await isOrganiserOf(user, ev, c))) throw badRequest(NOT_FOUND_ENTITY);
    if (ev.public_visibility !== 'public' || ev.archived_at || ['draft', 'cancelled', 'completed'].includes(ev.status)) throw badRequest('Only a public, open event can be promoted');
    if (isYouthEvent(ev)) throw badRequest('Youth events cannot be promoted');
    return ev.name;
  }
  if (type === 'supplier') {
    const s = await q("SELECT id, owner_id, organisation_id, coalesce(trading_name, legal_name) AS name FROM svc_profiles WHERE id=$1 AND status='active'", [entityId]);
    if (!s || !(s.owner_id === user.id || (s.organisation_id && await hasOrgGrant(user, s.organisation_id, MANAGE, c)))) throw badRequest(NOT_FOUND_ENTITY);
    return s.name;
  }
  throw badRequest(NOT_FOUND_ENTITY);
}

/** Is the entity still something that may be advertised right now? (Checked again on every serve and click, so a withdrawn page stops at once.) */
export async function entityLive(type, entityId, c) {
  const q = (sql) => db(c).query(sql, [entityId]).then((r) => r.rows.length > 0);
  if (type === 'venue') return q('SELECT 1 FROM venues WHERE id=$1');
  if (type === 'coach') return q("SELECT 1 FROM users WHERE id=$1 AND 'coach' = ANY(roles)");
  if (type === 'academy') return q("SELECT 1 FROM organisations o JOIN academy_profiles ap ON ap.organisation_id=o.id AND ap.listed WHERE o.id=$1 AND o.kind='academy' AND o.status='active'");
  if (type === 'event') return q("SELECT 1 FROM events WHERE id=$1 AND public_visibility='public' AND archived_at IS NULL AND status NOT IN ('draft','cancelled','completed') AND (max_age IS NULL OR max_age >= 18)");
  if (type === 'supplier') return q("SELECT 1 FROM svc_profiles WHERE id=$1 AND status='active'");
  return false;
}

// ------------------------------------------------------------------ money helpers
export const costMicro = (camp, kind) => (camp.billing_model === 'cpm' && kind === 'impression' ? Number(camp.rate_minor) * 1000 : camp.billing_model === 'cpc' && kind === 'click' ? Number(camp.rate_minor) * MICRO : 0);
/** The most this campaign may ever spend: the lower of its budget and what is funded and not refunded. */
export const ceilingMicro = (camp) => Math.min(Number(camp.budget_minor), Number(camp.funded_minor) - Number(camp.refunded_minor)) * MICRO;
export const remainingMicro = (camp) => Math.max(0, ceilingMicro(camp) - Number(camp.spent_micro));

/** Flat fee, billing model rate floor: how much funding must exist before the campaign can go live. */
export const minimumFunding = (camp) => Number(camp.rate_minor);

export async function logCampaign(c, campaignId, actorId, action, detail = {}) {
  await c.query('INSERT INTO ad_campaign_log(campaign_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [campaignId, actorId, action, detail]);
}

// ------------------------------------------------------------------ lifecycle
const ACTIONS = {
  submit: { from: ['draft', 'rejected'], to: 'submitted' },
  withdraw: { from: ['draft', 'submitted', 'rejected', 'approved', 'scheduled', 'active', 'paused'], to: 'withdrawn' },
  pause: { from: ['scheduled', 'active'], to: 'paused' },
  end: { from: ['scheduled', 'active', 'paused'], to: 'ended' },
};
export const canTransition = (action, status) => ACTIONS[action]?.from.includes(status) === true;

/** Everything a campaign needs before it can be sent for review. Returns the list of problems (empty = ready). */
export async function readiness(user, camp, advertiser, c) {
  const problems = [];
  if (advertiser.status !== 'active') problems.push('The advertiser account is suspended');
  if (!isCategoryAllowed(camp.category)) problems.push('That category cannot be advertised');
  const placements = (await db(c).query('SELECT placement_code FROM ad_campaign_placements WHERE campaign_id=$1 AND removed_at IS NULL', [camp.id])).rows.map((r) => r.placement_code);
  if (!placements.length) problems.push('Choose where the ad should appear');
  const inv = await inventoryOf(c);
  for (const code of placements) {
    const p = PLACEMENTS[code];
    if (!inv.find((i) => i.code === code)?.enabled) problems.push(`${p.label} is not on sale right now`);
    if (p.entity && camp.landing_entity_type !== p.entity) problems.push(`${p.label} promotes a ${p.entity}: pick one`);
    if (p.keywords && !camp.keywords.length) problems.push('A sponsored search slot needs at least one keyword');
  }
  const creative = camp.current_creative_id ? (await db(c).query('SELECT * FROM ad_creatives WHERE id=$1', [camp.current_creative_id])).rows[0] : null;
  if (!creative) problems.push('Add the ad itself: a headline and a button');
  if (camp.objective === 'traffic' && !camp.landing_entity_type && !camp.landing_url) problems.push('A traffic campaign needs a destination');
  if (camp.landing_entity_type) { if (!(await entityLive(camp.landing_entity_type, camp.landing_entity_id, c))) problems.push('The page this ad points at is not available'); }
  if (camp.starts_on < today()) problems.push('The start date has passed');
  if (camp.audience === 'followers' && !['venue', 'event'].includes(camp.landing_entity_type)) problems.push('Followers can only be reached for a venue or an event');
  return problems;
}

/** Take the campaign live: charge the flat fee atomically, then schedule or activate it. */
export async function goLive(c, camp, actorId) {
  const funded = Number(camp.funded_minor) - Number(camp.refunded_minor);
  if (funded < minimumFunding(camp)) throw conflict(`Add funds first: at least ${minimumFunding(camp)} (in minor units) is needed before this can start`, { needs: 'funding' });
  if (camp.billing_model === 'flat') {
    const charged = (await c.query(
      `UPDATE ad_campaigns SET spent_micro = spent_micro + $2 WHERE id=$1 AND spent_micro = 0 AND (funded_minor - refunded_minor) * $3 >= $2 RETURNING id`,
      [camp.id, Number(camp.rate_minor) * MICRO, MICRO])).rows[0];
    if (!charged) throw conflict('The flat fee cannot be taken from the funds on this campaign');
    await c.query("INSERT INTO ad_ledger(campaign_id, kind, amount_minor, note) VALUES ($1,'flat_charge',$2,'Flat placement fee')", [camp.id, -Number(camp.rate_minor)]);
  }
  const next = camp.starts_on > today() ? 'scheduled' : 'active';
  await c.query("UPDATE ad_campaigns SET status=$2, activated_at=coalesce(activated_at, now()), updated_at=now() WHERE id=$1", [camp.id, next]);
  await logCampaign(c, camp.id, actorId, next === 'active' ? 'activated' : 'scheduled', {});
  return next;
}

/** A flat fee is credited back when the campaign ends before anything was shown. */
export async function creditUnusedFlat(c, camp) {
  if (camp.billing_model !== 'flat' || Number(camp.spent_micro) === 0) return 0;
  const shown = Number((await c.query("SELECT count(*) AS n FROM ad_delivery_events WHERE campaign_id=$1 AND kind='impression' AND billable", [camp.id])).rows[0].n);
  if (shown > 0) return 0;
  const credited = (await c.query('UPDATE ad_campaigns SET spent_micro = 0 WHERE id=$1 AND spent_micro = $2 RETURNING id', [camp.id, Number(camp.rate_minor) * MICRO])).rows[0];
  if (!credited) return 0;
  await c.query("INSERT INTO ad_ledger(campaign_id, kind, amount_minor, note) VALUES ($1,'flat_credit',$2,'Flat fee credited: nothing was shown')", [camp.id, Number(camp.rate_minor)]);
  return Number(camp.rate_minor);
}

export async function moveCampaign(c, camp, action, actorId, { reason = null } = {}) {
  if (!canTransition(action, camp.status)) throw conflict(`A ${camp.status} campaign cannot be ${action === 'end' ? 'ended' : action === 'pause' ? 'paused' : action === 'submit' ? 'submitted' : 'withdrawn'}`);
  const to = ACTIONS[action].to;
  if (to === 'ended' || to === 'withdrawn') await creditUnusedFlat(c, camp);
  await c.query(
    `UPDATE ad_campaigns SET status=$2, updated_at=now(), submitted_at = CASE WHEN $2='submitted' THEN now() ELSE submitted_at END,
            ended_at = CASE WHEN $2 IN ('ended','withdrawn') THEN now() ELSE ended_at END, end_reason = CASE WHEN $2 IN ('ended','withdrawn') THEN $3 ELSE end_reason END WHERE id=$1`, [camp.id, to, reason]);
  if (action === 'submit') await c.query("UPDATE ad_creatives SET status='submitted' WHERE id=$1 AND status IN ('draft','rejected')", [camp.current_creative_id]);
  if (to === 'withdrawn' && camp.current_creative_id) await c.query("UPDATE ad_creatives SET status='withdrawn' WHERE id=$1", [camp.current_creative_id]);
  await logCampaign(c, camp.id, actorId, to === 'submitted' ? 'submitted' : to, reason ? { reason } : {});
  return to;
}

export async function requireAdsEntitlement(advertiser) {
  const s = subjectOf(advertiser);
  return requireEntitlement(s.type, s.id, 'advertising.campaigns');
}

// ------------------------------------------------------------------ serving
/** The keyed hash that stands in for a person in the frequency cap. Signed-in: their account. Anonymous: a per-day hash of network details, never stored raw. */
export function viewerHash(user, meta = {}) {
  if (user) return blindIndex(`ad-viewer:${user.id}`);
  return blindIndex(`ad-anon:${meta.ip ?? ''}|${meta.userAgent ?? ''}|${today()}`);
}

export async function eventContext(eventId) {
  if (!eventId) return null;
  return one('SELECT id, max_age, public_visibility, public_ads, status, archived_at, organizer_id FROM events WHERE id=$1', [eventId]);
}

const DESTINATION = (r) => (r.landing_entity_type ? { type: 'entity', entity_type: r.landing_entity_type, entity_id: r.landing_entity_id } : r.landing_url ? { type: 'external' } : null);

/**
 * Pick and record the paid placements for one request. Returns [] when nothing eligible (never an error: the page simply has no ad).
 * Selection is a fair rotation — the campaign shown least today goes first — so the price paid never buys a better position.
 */
export async function serveAds({ user, meta, placement, sport = null, country = null, city = null, q = null, eventId = null }) {
  if (!PLACEMENTS[placement]) throw badRequest('Unknown placement');
  const policy = await getPolicy();
  const inv = (await inventoryOf()).find((i) => i.code === placement);
  if (!inv.enabled) return { ads: [], reason: 'not_on_sale' };
  let ev = null;
  if (PLACEMENTS[placement].rights === 'event') {
    ev = await eventContext(eventId);
    if (!ev || !ev.public_ads || ev.public_visibility === 'private' || ev.status === 'draft') return { ads: [], reason: 'organiser_has_not_allowed_ads' };
  } else if (eventId) ev = await eventContext(eventId);
  const youthViewer = user ? !!(await one(`SELECT 1 FROM users u WHERE u.id=$1 AND ${YOUTH_SQL}`, [user.id])) : false;
  const youthContext = youthViewer || (ev && isYouthEvent(ev));
  if (youthContext && !policy.youth_contextual) return { ads: [], reason: 'youth_protection' };

  const hash = youthContext ? null : viewerHash(user, meta);
  if (hash) {
    const minute = Number((await one("SELECT count(*) AS n FROM ad_delivery_events WHERE viewer_hash=$1 AND occurred_at > now() - interval '1 minute'", [hash])).n);
    if (minute >= RATE_LIMIT_PER_MINUTE) return { ads: [], reason: 'rate_limited' };
  }
  const rows = await many(
    `SELECT c.*, cr.id AS cr_id, cr.headline, cr.body, cr.cta, cr.media_id, cr.alt_text, a.organisation_id, a.user_id,
            coalesce(o.name, u.display_name) AS advertiser_name,
            (SELECT count(*) FROM ad_delivery_events d WHERE d.campaign_id=c.id AND d.day=current_date AND d.kind='impression')::int AS shown_today,
            CASE WHEN $8::text IS NULL THEN 0 ELSE (SELECT count(*) FROM ad_delivery_events d WHERE d.campaign_id=c.id AND d.viewer_hash=$8 AND d.kind='impression' AND d.occurred_at > now() - interval '24 hours')::int END AS seen_by_viewer
       FROM ad_campaigns c
       JOIN ad_advertisers a ON a.id=c.advertiser_id AND a.status='active'
       LEFT JOIN organisations o ON o.id=a.organisation_id LEFT JOIN users u ON u.id=a.user_id
       JOIN ad_campaign_placements p ON p.campaign_id=c.id AND p.placement_code=$1 AND p.removed_at IS NULL
       JOIN ad_creatives cr ON cr.id=c.current_creative_id AND cr.status='approved'
      WHERE c.status IN ('scheduled','active') AND c.starts_on <= current_date AND c.ends_on >= current_date
        AND LEAST(c.budget_minor, c.funded_minor - c.refunded_minor) * ${MICRO}::bigint - c.spent_micro >=
            (CASE c.billing_model WHEN 'cpm' THEN c.rate_minor * 1000 WHEN 'cpc' THEN c.rate_minor * ${MICRO}::bigint ELSE 0 END)
        AND (cardinality(c.sports) = 0 OR ($2::text IS NOT NULL AND $2 = ANY(c.sports)))
        AND (CASE WHEN cardinality(c.cities) > 0 THEN $4::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(c.cities) x WHERE lower(x) = lower($4))
                  WHEN cardinality(c.countries) > 0 THEN $3::text IS NOT NULL AND upper($3) = ANY(c.countries) ELSE true END)
        AND ($1 <> 'search_sponsored' OR ($5::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(c.keywords) k WHERE position(lower(k) IN lower($5)) > 0)))
        AND ($6::boolean = false OR c.youth_contextual)
        AND (c.audience = 'everyone' OR ($7::uuid IS NOT NULL AND (
              (c.landing_entity_type = 'venue' AND EXISTS (SELECT 1 FROM favourite_venues f WHERE f.user_id=$7 AND f.venue_id=c.landing_entity_id AND f.removed_at IS NULL))
              OR (c.landing_entity_type = 'event' AND EXISTS (SELECT 1 FROM spectator_follows s WHERE s.user_id=$7 AND s.subject_type='event' AND s.subject_id=c.landing_entity_id)))))
        AND ($7::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM ad_hides h WHERE h.user_id=$7 AND h.removed_at IS NULL AND (h.campaign_id=c.id OR h.advertiser_id=c.advertiser_id)))
      ORDER BY shown_today ASC, random() LIMIT 12`,
    [placement, sport, country, city, q, !!youthContext, user?.id ?? null, hash]);

  const out = [];
  const seenAdvertisers = new Set();
  for (const r of rows) {
    if (out.length >= inv.max_slots) break;
    if (seenAdvertisers.has(r.advertiser_id)) continue;
    if (!isCategoryAllowed(r.category)) continue;                       // a prohibited category never serves, whatever was approved
    const cappedAt = Math.min(r.frequency_per_day ?? policy.default_frequency, policy.max_frequency);
    if (hash && r.seen_by_viewer >= cappedAt) continue;
    if (r.landing_entity_type && !(await entityLive(r.landing_entity_type, r.landing_entity_id))) continue;
    const served = await recordImpression(r, { placement, hash, sport, city, country });
    if (!served) continue;
    seenAdvertisers.add(r.advertiser_id);
    out.push(adPayload(r, placement, served));
  }
  return { ads: out };
}

const matchedCell = (r, city, country) => (r.cities.length ? (city ?? null) : r.countries.length ? (country ? String(country).toUpperCase() : null) : null);

async function recordImpression(r, { placement, hash, sport, city, country }) {
  const bucket = Math.floor(Date.now() / 1000 / IMPRESSION_BUCKET_SECONDS);
  const dedupe = hash ? `${hash}:${placement}:${r.cr_id}:${bucket}` : null;
  return tx(async (c) => {
    if (dedupe) {
      const again = (await c.query("SELECT id FROM ad_delivery_events WHERE campaign_id=$1 AND kind='impression' AND dedupe_key=$2", [r.id, dedupe])).rows[0];
      if (again) return { id: again.id, repeat: true };   // the same impression, shown again: same id, nothing charged
    }
    const cost = costMicro(r, 'impression');
    if (cost > 0) {
      const ok = (await c.query(
        `UPDATE ad_campaigns SET spent_micro = spent_micro + $2 WHERE id=$1 AND status IN ('scheduled','active') AND spent_micro + $2 <= LEAST(budget_minor, funded_minor - refunded_minor) * $3::bigint RETURNING id`, [r.id, cost, MICRO])).rows[0];
      if (!ok) return null;                                  // funds ran out under concurrent delivery: not shown, not charged
    }
    const ins = (await c.query(
      `INSERT INTO ad_delivery_events(campaign_id, creative_id, placement_code, kind, viewer_hash, sport, geo_cell, cost_micro, dedupe_key)
       VALUES ($1,$2,$3,'impression',$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`, [r.id, r.cr_id, placement, hash, sport ?? null, matchedCell(r, city, country), cost, dedupe])).rows[0];
    if (!ins) throw conflict('repeat');
    return { id: ins.id, repeat: false };
  }).catch((e) => { if (e?.message === 'repeat') return null; throw e; });
}

function adPayload(r, placement, served) {
  const label = r.disclosure === 'promoted' ? 'Promoted' : 'Sponsored';
  return {
    token: served.id,                                          // the impression id: the only way to follow, hide or report this ad
    placement,
    label,
    advertiser: { name: r.advertiser_name },
    headline: r.headline, body: r.body, cta: r.cta, image_url: r.media_id ? `/api/v1/market/media/${r.media_id}` : null, image_alt: r.alt_text,
    destination: DESTINATION(r),
    why: `${label} by ${r.advertiser_name}. Shown because of where you are in the app${r.sports.length ? ` (${r.sports.join(', ')})` : ''} — not because of anything private about you.`,
  };
}

// ------------------------------------------------------------------ clicks
export async function followAd({ user, meta, token }) {
  const imp = await one(
    `SELECT d.*, c.status, c.billing_model, c.rate_minor, c.landing_entity_type, c.landing_entity_id, c.landing_url, c.category, c.advertiser_id, cr.status AS creative_status
       FROM ad_delivery_events d JOIN ad_campaigns c ON c.id=d.campaign_id JOIN ad_creatives cr ON cr.id=d.creative_id WHERE d.id=$1 AND d.kind='impression'`, [token]);
  if (!imp) throw notFound('Ad');
  const hash = imp.viewer_hash ? viewerHash(user, meta) : null;
  if (imp.viewer_hash && hash !== imp.viewer_hash) throw notFound('Ad');          // an impression id only works for the person it was served to
  // withdrawal and pausing take effect at once: a stale page cannot send anyone to a withdrawn ad's destination
  if (!['scheduled', 'active'].includes(imp.status) || imp.creative_status !== 'approved' || !isCategoryAllowed(imp.category)) throw notFound('Ad');
  if (imp.landing_entity_type && !(await entityLive(imp.landing_entity_type, imp.landing_entity_id))) throw notFound('Ad');
  const fresh = Date.now() - new Date(imp.occurred_at).getTime() <= CLICK_WINDOW_MINUTES * 60_000;
  const cost = costMicro(imp, 'click');
  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [imp.id]);                      // two taps on the same ad at once count once
    if ((await c.query("SELECT 1 FROM ad_delivery_events WHERE parent_id=$1 AND kind='click'", [imp.id])).rowCount) return;
    let billable = fresh, reason = fresh ? null : 'expired_impression', paid = 0;
    if (billable && cost > 0) {
      const ok = (await c.query(
        `UPDATE ad_campaigns SET spent_micro = spent_micro + $2 WHERE id=$1 AND status IN ('scheduled','active') AND spent_micro + $2 <= LEAST(budget_minor, funded_minor - refunded_minor) * $3::bigint RETURNING id`, [imp.campaign_id, cost, MICRO])).rows[0];
      if (ok) paid = cost; else { billable = false; reason = 'budget_exhausted'; }
    }
    await c.query(
      `INSERT INTO ad_delivery_events(campaign_id, creative_id, placement_code, kind, parent_id, viewer_hash, sport, geo_cell, billable, invalid_reason, cost_micro)
       VALUES ($1,$2,$3,'click',$4,$5,$6,$7,$8,$9,$10)`, [imp.campaign_id, imp.creative_id, imp.placement_code, imp.id, imp.viewer_hash, imp.sport, imp.geo_cell, billable, reason, paid]);
  });
  return imp.landing_entity_type ? { type: 'entity', entity_type: imp.landing_entity_type, entity_id: imp.landing_entity_id } : imp.landing_url ? { type: 'external', url: imp.landing_url } : { type: 'none' };
}

// ------------------------------------------------------------------ reports: one set of facts for the advertiser and the platform
/** Totals added up from the immutable delivery rows (and the ledger), for one campaign or every campaign. */
export async function reportFor({ campaignId = null, advertiserId = null, from = null, to = null } = {}) {
  const where = [campaignId ? 'd.campaign_id = $1' : advertiserId ? 'c.advertiser_id = $1' : 'true', from ? `d.day >= $${campaignId || advertiserId ? 2 : 1}` : 'true', to ? `d.day <= $${(campaignId || advertiserId ? 1 : 0) + (from ? 2 : 1)}` : 'true'];
  const params = [campaignId ?? advertiserId, from, to].filter((x) => x !== null);
  const t = await one(
    `SELECT count(*) FILTER (WHERE d.kind='impression' AND d.billable)::int AS impressions, count(*) FILTER (WHERE d.kind='click' AND d.billable)::int AS clicks,
            count(*) FILTER (WHERE NOT d.billable)::int AS invalid, coalesce(sum(d.cost_micro),0)::bigint AS delivery_micro
       FROM ad_delivery_events d JOIN ad_campaigns c ON c.id=d.campaign_id WHERE ${where.join(' AND ')}`, params);
  const byDay = await many(
    `SELECT d.day::text AS day, count(*) FILTER (WHERE d.kind='impression' AND d.billable)::int AS impressions, count(*) FILTER (WHERE d.kind='click' AND d.billable)::int AS clicks, coalesce(sum(d.cost_micro),0)::bigint AS micro
       FROM ad_delivery_events d JOIN ad_campaigns c ON c.id=d.campaign_id WHERE ${where.join(' AND ')} GROUP BY d.day ORDER BY d.day`, params);
  const byPlacement = await many(
    `SELECT d.placement_code AS placement, count(*) FILTER (WHERE d.kind='impression' AND d.billable)::int AS impressions, count(*) FILTER (WHERE d.kind='click' AND d.billable)::int AS clicks
       FROM ad_delivery_events d JOIN ad_campaigns c ON c.id=d.campaign_id WHERE ${where.join(' AND ')} GROUP BY d.placement_code ORDER BY d.placement_code`, params);
  const invalidBy = await many(
    `SELECT coalesce(d.invalid_reason,'unknown') AS reason, count(*)::int AS n FROM ad_delivery_events d JOIN ad_campaigns c ON c.id=d.campaign_id WHERE ${where.join(' AND ')} AND NOT d.billable GROUP BY 1 ORDER BY 1`, params);
  return {
    impressions: t.impressions, clicks: t.clicks, ctr: t.impressions ? Math.round((t.clicks / t.impressions) * 10000) / 100 : null,
    not_charged: t.invalid, not_charged_reasons: invalidBy, delivery_spend_micro: Number(t.delivery_micro),
    by_day: byDay.map((x) => ({ ...x, micro: Number(x.micro) })), by_placement: byPlacement,
    definitions: METRIC_DEFINITIONS, unique_reach: null, conversions: null,
  };
}

/** Funds, charges and the check that the running counter equals the sum of the facts. */
export async function moneyFor(campaignId) {
  const camp = await one('SELECT * FROM ad_campaigns WHERE id=$1', [campaignId]);
  if (!camp) throw notFound('Campaign');
  const facts = await one("SELECT coalesce(sum(cost_micro),0)::bigint AS micro FROM ad_delivery_events WHERE campaign_id=$1", [campaignId]);
  const flat = await one("SELECT coalesce(sum(-amount_minor) FILTER (WHERE kind IN ('flat_charge','flat_credit')),0)::bigint AS minor FROM ad_ledger WHERE campaign_id=$1", [campaignId]);
  const funded = await one("SELECT coalesce(sum(amount_minor) FILTER (WHERE status='paid'),0)::bigint AS paid, coalesce(sum(refunded_minor),0)::bigint AS refunded, count(*) FILTER (WHERE status='awaiting_payment')::int AS open FROM ad_fundings WHERE campaign_id=$1", [campaignId]);
  const factsMicro = Number(facts.micro) + Number(flat.minor) * MICRO;
  return {
    currency: camp.currency, budget_minor: Number(camp.budget_minor), funded_minor: Number(camp.funded_minor), refunded_minor: Number(camp.refunded_minor),
    spent_minor: Math.ceil(Number(camp.spent_micro) / MICRO), spent_micro: Number(camp.spent_micro),
    remaining_minor: Math.floor(remainingMicro(camp) / MICRO), unpaid_fundings: funded.open,
    reconciliation: {
      paid_fundings_minor: Number(funded.paid), refunded_minor: Number(funded.refunded), flat_fees_net_minor: Number(flat.minor), delivery_spend_micro: Number(facts.micro), facts_total_micro: factsMicro,
      counter_micro: Number(camp.spent_micro), funds_match: Number(funded.paid) === Number(camp.funded_minor) && Number(funded.refunded) === Number(camp.refunded_minor), spend_matches: factsMicro === Number(camp.spent_micro),
    },
  };
}

// ------------------------------------------------------------------ payments hooks
/** The hosted checkout reported this funding paid: add it to the campaign's funds. False when it can no longer be applied, so the payment is refunded. */
export async function fulfilAdFundingPaid(c, fundingId) {
  const f = (await c.query("UPDATE ad_fundings SET status='paid', paid_at=now() WHERE id=$1 AND status='awaiting_payment' RETURNING *", [fundingId])).rows[0];
  if (!f) return false;
  const camp = (await c.query('SELECT * FROM ad_campaigns WHERE id=$1 FOR UPDATE', [f.campaign_id])).rows[0];
  if (['ended', 'withdrawn'].includes(camp.status)) { await c.query("UPDATE ad_fundings SET status='void', paid_at=NULL WHERE id=$1", [f.id]); return false; }
  await c.query('UPDATE ad_campaigns SET funded_minor = funded_minor + $2, updated_at = now() WHERE id=$1', [camp.id, f.amount_minor]);
  await c.query("INSERT INTO ad_ledger(campaign_id, funding_id, kind, amount_minor, note) VALUES ($1,$2,'funding',$3,$4)", [camp.id, f.id, f.amount_minor, `Funding ${f.number}`]);
  await logCampaign(c, camp.id, f.payer_id, 'funded', { number: f.number, amount_minor: Number(f.amount_minor) });
  return true;
}

/** A payment for a funding was (partly) refunded: move the refunded amount onto the funding and the campaign, once. */
export async function syncAdFundingRefund(c, payment) {
  if (payment.purpose_type !== 'ad_funding') return;
  const f = (await c.query('SELECT * FROM ad_fundings WHERE id=$1 FOR UPDATE', [payment.purpose_id])).rows[0];
  if (!f || f.status !== 'paid') return;
  const delta = Number(payment.refunded_cents) - Number(f.refunded_minor);
  if (delta <= 0) return;
  await c.query('UPDATE ad_fundings SET refunded_minor = refunded_minor + $2 WHERE id=$1', [f.id, delta]);
  const camp = (await c.query('UPDATE ad_campaigns SET refunded_minor = refunded_minor + $2, updated_at = now() WHERE id=$1 RETURNING *', [f.campaign_id, delta])).rows[0];
  await c.query("INSERT INTO ad_ledger(campaign_id, funding_id, kind, amount_minor, note) VALUES ($1,$2,'refund',$3,$4)", [f.campaign_id, f.id, -delta, `Refund of ${f.number}`]);
  await logCampaign(c, f.campaign_id, null, 'refunded', { number: f.number, amount_minor: delta });
  // if the refund took the funds below what was already spent, delivery stops at once (the charge condition already refuses more spend)
  if (remainingMicro(camp) <= 0 && ['scheduled', 'active'].includes(camp.status)) await c.query("UPDATE ad_campaigns SET status='paused' WHERE id=$1", [camp.id]);
}

/** What is left to give back on a campaign: funded and not refunded, minus everything spent (rounded up to a whole minor unit). */
export async function refundableMinor(campaignId, c) {
  const camp = (await db(c).query('SELECT * FROM ad_campaigns WHERE id=$1', [campaignId])).rows[0];
  return Math.max(0, Number(camp.funded_minor) - Number(camp.refunded_minor) - Math.ceil(Number(camp.spent_micro) / MICRO));
}

// ------------------------------------------------------------------ sweeps
/** Start scheduled campaigns on their day; end campaigns past their end date or out of money. Idempotent. */
export async function adSweeps() {
  let started = 0, ended = 0;
  const due = await many("SELECT * FROM ad_campaigns WHERE status = 'scheduled' AND starts_on <= current_date");
  for (const camp of due) { await tx(async (c) => { await c.query("UPDATE ad_campaigns SET status='active', updated_at=now() WHERE id=$1 AND status='scheduled'", [camp.id]); await logCampaign(c, camp.id, null, 'activated', {}); }); started++; }
  const over = await many("SELECT * FROM ad_campaigns WHERE status IN ('scheduled','active','paused') AND ends_on < current_date");
  for (const camp of over) { await tx(async (c) => { await c.query("UPDATE ad_campaigns SET status='ended', ended_at=now(), end_reason='finished', updated_at=now() WHERE id=$1", [camp.id]); await logCampaign(c, camp.id, null, 'ended', { reason: 'finished' }); }); ended++; }
  const spent = await many(
    `SELECT * FROM ad_campaigns WHERE status = 'active' AND billing_model <> 'flat' AND LEAST(budget_minor, funded_minor - refunded_minor) * ${MICRO}::bigint - spent_micro <
       (CASE billing_model WHEN 'cpm' THEN rate_minor * 1000 ELSE rate_minor * ${MICRO}::bigint END)`);
  for (const camp of spent) { await tx(async (c) => { await c.query("UPDATE ad_campaigns SET status='ended', ended_at=now(), end_reason='budget_spent', updated_at=now() WHERE id=$1 AND status='active'", [camp.id]); await logCampaign(c, camp.id, null, 'ended', { reason: 'budget_spent' }); }); ended++; }
  return { started, ended };
}

