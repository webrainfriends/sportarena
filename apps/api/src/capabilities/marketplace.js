// Sports Services & Opportunity Marketplace (#600): discover, verify and shortlist. Listings front the canonical identity (user / organisation);
// the quote -> contract -> pay -> review lifecycle is in marketplace-engagements.js. Paid placement is only ever served by the existing ads engine
// (search_sponsored), returned in its own `sponsored` list and never mixed into the organic ranking.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { orgFor } from '../org-access.js';
import { YOUTH_SQL } from '../youth.js';
import { serveAds } from '../ads/engine.js';
import { CURRENCIES } from '../currency.js';
import { FAMILIES, FAMILY, FAMILY_SLUGS, RATE_UNITS, catalogue, mayList } from '../marketplace/families.js';
import { credentialState, mustBeAdult } from '../marketplace/engine.js';

const TAG = 'Marketplace';
const money = z.number().int().min(0).max(100_000_000_000);
const cur = z.string().refine((c) => c in CURRENCIES, 'Unknown currency');

cap({
  name: 'get_marketplace_catalogue', method: 'GET', path: '/marketplace/catalogue', tag: TAG, auth: 'public',
  summary: 'The marketplace reference data: provider families (and which need a verified credential to be contracted), rate units and the engagement stages. The app renders its filters and timeline from this.',
  handler: () => catalogue(),
});

const sports = async (slugs) => {
  if (!slugs?.length) return [];
  const rows = await many('SELECT id, slug FROM sports WHERE slug = ANY($1)', [slugs]);
  if (rows.length !== new Set(slugs).size) throw badRequest('Unknown sport');
  return rows.map((r) => r.id);
};

cap({
  name: 'save_marketplace_listing', method: 'POST', path: '/marketplace/listings', status: 200, tag: TAG,
  summary: 'List yourself (or an organisation you run) under a provider family, or update that listing. One live listing per account, family and organisation; it points at your existing account / organisation and never copies it. Sports use the catalogue slugs, rates are minor units. Pause or archive it with `status`; nothing is deleted.',
  input: z.object({
    family: z.enum(FAMILY_SLUGS), organisation_id: id.optional(), headline: z.string().min(3).max(120), summary: z.string().max(1000).optional(),
    sports: z.array(z.string().max(60)).max(300).default([]), city: z.string().max(80).optional(), country: z.string().length(2).optional(), remote_ok: z.boolean().default(false),
    currency: cur.default('INR'), rate_min_minor: money.optional(), rate_max_minor: money.optional(), rate_unit: z.enum(RATE_UNITS).optional(), accepting: z.boolean().default(true),
    status: z.enum(['active', 'paused', 'archived']).default('active'),
  }),
  async handler({ user }, i) {
    await mustBeAdult(user);
    mayList(user, i.family, i.organisation_id);
    if (i.organisation_id) await orgFor(user, i.organisation_id, ['owner', 'admin'], { write: true });
    if (i.rate_max_minor !== undefined && i.rate_min_minor !== undefined && i.rate_max_minor < i.rate_min_minor) throw badRequest('The top rate cannot be below the bottom rate');
    if ((i.rate_min_minor !== undefined || i.rate_max_minor !== undefined) && !i.rate_unit) throw badRequest('Say what the rate is per (hour, session, day ...)');
    const sport_ids = await sports(i.sports);
    const vals = [i.family, user.id, i.organisation_id ?? null, i.headline, i.summary ?? null, sport_ids, i.city ?? null, i.country ?? null, i.remote_ok, i.currency, i.rate_min_minor ?? null, i.rate_max_minor ?? null, i.rate_unit ?? null, i.accepting, i.status];
    return tx(async (c) => {
      const cur1 = (await c.query('SELECT id FROM marketplace_listings WHERE provider_id=$1 AND family=$2 AND coalesce(organisation_id, $3::uuid)=coalesce($4::uuid, $3::uuid) AND archived_at IS NULL FOR UPDATE', [user.id, i.family, '00000000-0000-0000-0000-000000000000', i.organisation_id ?? null])).rows[0];
      if (cur1) return (await c.query(`UPDATE marketplace_listings SET headline=$4, summary=$5, sport_ids=$6, city=$7, country=$8, remote_ok=$9, currency=$10, rate_min_minor=$11, rate_max_minor=$12, rate_unit=$13, accepting=$14, status=$15,
          archived_at=CASE WHEN $15='archived' THEN now() ELSE NULL END, updated_at=now() WHERE id=$16 RETURNING *`, [...vals, cur1.id])).rows[0];
      if (i.status === 'archived') throw badRequest('There is no live listing to archive');
      return (await c.query(`INSERT INTO marketplace_listings(family, provider_id, organisation_id, headline, summary, sport_ids, city, country, remote_ok, currency, rate_min_minor, rate_max_minor, rate_unit, accepting, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, vals)).rows[0];
    });
  },
});

const LISTING = `l.id, l.family, l.provider_id, l.organisation_id, l.headline, l.summary, l.city, l.country, l.remote_ok, l.currency, l.rate_min_minor, l.rate_max_minor, l.rate_unit, l.accepting, l.status, l.created_at,
  u.display_name, u.handle, u.avatar_emoji, u.avatar_color, u.avatar_url, o.name AS organisation_name,
  coalesce((SELECT array_agg(s.slug ORDER BY s.slug) FROM sports s WHERE s.id = ANY(l.sport_ids)), '{}') AS sports,
  fam.cred AS credential_type,
  (fam.cred IS NOT NULL AND EXISTS (SELECT 1 FROM verification_cases v WHERE v.subject_type='user' AND v.subject_id=l.provider_id AND v.type=fam.cred AND v.status='approved' AND (v.expires_at IS NULL OR v.expires_at > now()))) AS credential_verified,
  (SELECT round(avg(t.rating)::numeric, 2) FROM testimonials t WHERE t.subject_type='user' AND t.subject_id=l.provider_id AND t.status='published' AND t.visibility='public') AS rating,
  (SELECT count(*)::int FROM testimonials t WHERE t.subject_type='user' AND t.subject_id=l.provider_id AND t.status='published' AND t.visibility='public') AS rating_count,
  (SELECT count(*)::int FROM marketplace_engagements x WHERE x.provider_id=l.provider_id AND x.status IN ('paid','reviewed')) AS completed`;
const FROM = `FROM marketplace_listings l JOIN users u ON u.id=l.provider_id LEFT JOIN organisations o ON o.id=l.organisation_id
  JOIN (VALUES ${FAMILIES.map((f) => `('${f.slug}', ${f.credential ? `'${f.credential}'` : 'NULL::text'})`).join(',')}) fam(slug, cred) ON fam.slug=l.family`;

cap({
  name: 'search_marketplace', method: 'GET', path: '/marketplace/search', tag: TAG, auth: 'public',
  summary: 'Discover providers across every family with one filter model: family, text, sport, city / country, remote, availability on a date, rate ceiling and verified credential. `results` is the organic list, ordered by relevance (text match, then verified credential, rating, completed work, name) and nothing paid can change that order. `sponsored` is the separate, labelled paid slot from the ads engine and is empty when none applies. Providers who are under-18 are never listed.',
  input: z.object({
    family: z.enum(FAMILY_SLUGS).optional(), q: z.string().max(80).optional(), sport: z.string().max(60).optional().describe('sport slug'), city: z.string().max(80).optional(), country: z.string().length(2).optional(),
    remote: z.coerce.boolean().optional(), available_on: z.string().date().optional().describe('hide providers already booked or blocked that day'), max_rate_minor: z.coerce.number().int().min(0).optional(), currency: cur.optional(),
    verified: z.coerce.boolean().optional().describe('only providers with a current verified credential'), include_sponsored: z.coerce.boolean().default(false).describe('also return the labelled paid slot (counts as an ad impression); the app asks the ads placement search_sponsored itself'), sort: z.enum(['relevance', 'rating', 'rate', 'name']).default('relevance'), ...page,
  }),
  async handler({ user, meta }, i) {
    const esc = (x) => (x ? x.replace(/[%_\\]/g, '\\$&') : null);
    const order = { relevance: 'score DESC, credential_verified DESC, rating DESC NULLS LAST, completed DESC, display_name', rating: 'rating DESC NULLS LAST, rating_count DESC, display_name', rate: 'rate_min_minor NULLS LAST, display_name', name: 'display_name' }[i.sort];
    const q = esc(i.q);
    const rows = await many(
      `SELECT * FROM (SELECT ${LISTING}, CASE WHEN $2::text IS NULL THEN 0 WHEN l.headline ILIKE '%'||$2||'%' OR u.display_name ILIKE '%'||$2||'%' OR o.name ILIKE '%'||$2||'%' THEN 2 WHEN l.summary ILIKE '%'||$2||'%' THEN 1 ELSE 0 END AS score
         ${FROM} WHERE l.status='active' AND l.accepting AND l.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM users yu WHERE yu.id=l.provider_id AND ${YOUTH_SQL.replaceAll('u.', 'yu.')})
           AND ($1::text IS NULL OR l.family=$1)
           AND ($2::text IS NULL OR l.headline ILIKE '%'||$2||'%' OR l.summary ILIKE '%'||$2||'%' OR u.display_name ILIKE '%'||$2||'%' OR u.handle ILIKE '%'||$2||'%' OR o.name ILIKE '%'||$2||'%')
           AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM sports s WHERE s.id = ANY(l.sport_ids) AND s.slug=$3))
           AND ($4::text IS NULL OR l.city ILIKE $4) AND ($5::text IS NULL OR l.country=upper($5)) AND ($6::boolean IS NULL OR l.remote_ok=$6)
           AND ($7::bigint IS NULL OR l.rate_min_minor IS NULL OR l.rate_min_minor <= $7) AND ($8::text IS NULL OR l.currency=$8)
           AND ($9::date IS NULL OR (NOT EXISTS (SELECT 1 FROM marketplace_engagements x WHERE x.provider_id=l.provider_id AND x.status IN ('contracted','scheduled') AND x.starts_at IS NOT NULL AND x.starts_at::date <= $9 AND coalesce(x.ends_at, x.starts_at)::date >= $9)
              AND NOT EXISTS (SELECT 1 FROM athlete_blocks b WHERE b.user_id=l.provider_id AND b.status='active' AND b.starts_at::date <= $9 AND b.ends_at::date >= $9)))) q
       WHERE (NOT $10 OR q.credential_verified) ORDER BY ${order} LIMIT $11 OFFSET $12`,
      [i.family ?? null, q, i.sport ?? null, esc(i.city), i.country ?? null, i.remote ?? null, i.max_rate_minor ?? null, i.currency ?? null, i.available_on ?? null, i.verified ?? false, i.limit, i.offset]);
    let sponsored = [];
    if (i.offset === 0 && i.include_sponsored) {
      try { sponsored = (await serveAds({ user, meta, placement: 'search_sponsored', sport: i.sport ?? null, country: i.country ?? null, city: i.city ?? null, q: i.q ?? null })).ads ?? []; } catch { sponsored = []; }
    }
    return { results: rows.map(({ score, ...r }) => r), sponsored, ordering: i.sort, paid_placement_affects_results: false };
  },
});

cap({
  name: 'get_marketplace_listing', method: 'GET', path: '/marketplace/listings/:id', tag: TAG, auth: 'public',
  summary: 'One provider listing with the canonical identity, sports, rate range, credential state and rating. Archived listings read as not found.',
  input: z.object({ id }),
  async handler(_, i) {
    const l = await one(`SELECT ${LISTING} ${FROM} WHERE l.id=$1 AND l.archived_at IS NULL AND l.status <> 'archived'`, [i.id]);
    if (!l) throw notFound('Listing');
    return l;
  },
});

cap({
  name: 'list_my_marketplace_listings', method: 'GET', path: '/me/marketplace/listings', tag: TAG,
  summary: 'The listings you own (including paused ones), with what verification each family still needs from you.',
  async handler({ user }) {
    const rows = await many(`SELECT ${LISTING} ${FROM} WHERE l.provider_id=$1 AND l.archived_at IS NULL ORDER BY l.created_at DESC`, [user.id]);
    return Promise.all(rows.map(async (r) => ({ ...r, credential: await credentialState(user.id, r.family) })));
  },
});

cap({
  name: 'shortlist_marketplace_listing', method: 'POST', path: '/marketplace/listings/:id/shortlist', tag: TAG, status: 201,
  summary: 'Add a listing to your private shortlist (optional note). Safe to repeat. You cannot shortlist your own listing.',
  input: z.object({ id, note: z.string().max(300).optional() }),
  async handler({ user }, i) {
    const l = await one("SELECT id, provider_id FROM marketplace_listings WHERE id=$1 AND archived_at IS NULL AND status <> 'archived'", [i.id]);
    if (!l) throw notFound('Listing');
    if (l.provider_id === user.id) throw conflict('That is your own listing');
    return (await one(`INSERT INTO marketplace_shortlist(user_id, listing_id, note) VALUES ($1,$2,$3)
      ON CONFLICT (user_id, listing_id) WHERE removed_at IS NULL DO UPDATE SET note=coalesce(EXCLUDED.note, marketplace_shortlist.note) RETURNING *`, [user.id, i.id, i.note ?? null]));
  },
});

cap({
  name: 'unshortlist_marketplace_listing', method: 'DELETE', path: '/marketplace/listings/:id/shortlist', tag: TAG,
  summary: 'Take a listing off your shortlist (the row is kept, marked removed).',
  input: z.object({ id }),
  async handler({ user }, i) {
    await one('UPDATE marketplace_shortlist SET removed_at=now() WHERE user_id=$1 AND listing_id=$2 AND removed_at IS NULL RETURNING id', [user.id, i.id]);
    return { ok: true };
  },
});

cap({
  name: 'list_marketplace_shortlist', method: 'GET', path: '/me/marketplace/shortlist', tag: TAG,
  summary: 'Your shortlist with each provider\'s current rate, credential state and rating so you can compare side by side, and any engagement already open with them.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    return many(`SELECT ${LISTING}, sl.note, sl.created_at AS shortlisted_at,
        (SELECT x.id FROM marketplace_engagements x WHERE x.buyer_id=$1 AND x.listing_id=l.id AND x.status NOT IN ('declined','cancelled') ORDER BY x.created_at DESC LIMIT 1) AS engagement_id
      ${FROM} JOIN marketplace_shortlist sl ON sl.listing_id=l.id AND sl.user_id=$1 AND sl.removed_at IS NULL
      WHERE l.archived_at IS NULL AND l.status <> 'archived' ORDER BY sl.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
  },
});
