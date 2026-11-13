// Officials Services & Opportunity Marketplace (Issue #1003, REF-R11)
// Closes the remaining gap: officials list themselves as freelance providers; organisers discover, shortlist,
// quote, contract, pay and review them.  The reverse flow (organiser posts slot → official applies) lives in
// officials-open-slots.js and is not touched here.
//
// Architecture:
//  • The 'official' family already exists in marketplace/families.js.
//  • marketplace.js handles the base listing CRUD and search.
//  • marketplace-engagements.js handles the full quote → contract → invoice → pay lifecycle.
//  • This capability adds official-specific metadata (roles, grades, event types, equipment, travel),
//    official-specific search with extra filters, the assignment link (booking → fixture_officials),
//    structured 5-criteria reviews and the opportunity board for officials.
//  • We call the existing helpers rather than duplicating their logic.

import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { CURRENCIES } from '../currency.js';
import { FAMILY } from '../marketplace/families.js';
import { mustHoldCredential, mustBeAdult, credentialState, loadEngagement, need, raiseInvoice, describe, sideOf, logEvent } from '../marketplace/engine.js';
import { assertOfficialEligible, lockOfficial, OFFICIAL_ROLES } from '../officials.js';

const TAG = 'Officials';
const LISTING_FAMILY = 'official';

const OFFICIAL_ROLES_ENUM = z.enum([
  'referee','umpire','linesman','fourth_official','video_assistant_referee',
  'reserve_assistant_referee','scorer','timekeeper','goal_line_official',
  'technical_official','shot_clock_operator',
]);
const EVENT_TYPES_ENUM = z.enum([
  'league','cup','friendly','tournament','international',
  'school','university','amateur','corporate','volunteer',
]);
const EQUIPMENT_ENUM = z.enum([
  'whistle','flag_set','vanishing_spray','board','timing_equipment',
  'uniform_formal','uniform_casual','kit_bag','comms_headset',
]);

// Shared SQL to hydrate a listing with its official_listing_meta
const WITH_META = `
  SELECT
    l.id, l.status, l.accepting, l.headline, l.summary, l.rate_minor, l.rate_currency, l.rate_unit,
    l.remote, l.locations, l.created_at, l.updated_at, l.view_count,
    u.display_name, u.handle, u.avatar_url,
    osp.completeness_score,
    COALESCE(olm.roles,     '{}')    AS roles,
    COALESCE(olm.grades,    '{}')    AS grades,
    COALESCE(olm.event_types,'{}')   AS event_types,
    COALESCE(olm.equipment_own,'{}') AS equipment_own,
    olm.max_travel_km,
    olm.insurance_valid_until,
    COALESCE(olm.volunteer_available, false) AS volunteer_available,
    creds.state                              AS credential_state,
    COALESCE(ROUND(AVG(t.score),2),0)        AS rating,
    COUNT(t.id)::int                         AS rating_count,
    COUNT(DISTINCT me.id) FILTER (WHERE me.status IN ('paid','reviewed'))::int AS completed
  FROM marketplace_listings l
  JOIN users u ON u.id = l.provider_id
  LEFT JOIN official_profile_wizard_state osp ON osp.user_id = l.provider_id
  LEFT JOIN official_listing_meta olm ON olm.listing_id = l.id
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN vc.id IS NULL THEN 'none'
      WHEN vc.status='approved' AND (vc.valid_until IS NULL OR vc.valid_until > current_date) THEN 'verified'
      WHEN vc.status='approved' AND vc.valid_until <= current_date THEN 'expired'
      WHEN vc.status='approved' AND vc.valid_until <= current_date + interval '30 days' THEN 'expiring'
      WHEN vc.status='pending'  THEN 'pending'
      WHEN vc.status='rejected' THEN 'rejected'
      WHEN vc.status='revoked'  THEN 'revoked'
      ELSE 'self_declared'
    END AS state
    FROM verification_cases vc
    WHERE vc.subject_id=l.provider_id AND vc.credential_type='referee' AND vc.deleted_at IS NULL
    ORDER BY vc.created_at DESC LIMIT 1
  ) creds ON true
  LEFT JOIN testimonials t ON t.subject_id=l.provider_id AND t.subject_type='user' AND t.status='approved'
  LEFT JOIN marketplace_engagements me ON me.listing_id=l.id
`;

// ─────────────────────────────────────────────────────────────────────────────
// OFFICIAL SIDE: manage own service listing
// ─────────────────────────────────────────────────────────────────────────────

cap({
  name: 'get_my_official_service_listing',
  method: 'GET',
  path: '/me/official-service-listing',
  tag: TAG,
  summary: 'Official: load own marketplace listing and official-specific metadata.',
  input: z.object({}),
  async handler({ user }) {
    const row = await one(
      `${WITH_META} WHERE l.provider_id=$1 AND l.family='official' AND l.archived_at IS NULL
       GROUP BY l.id, u.display_name, u.handle, u.avatar_url, osp.completeness_score,
                olm.roles, olm.grades, olm.event_types, olm.equipment_own,
                olm.max_travel_km, olm.insurance_valid_until, olm.volunteer_available, creds.state
       ORDER BY l.created_at DESC LIMIT 1`,
      [user.id],
    );
    // Also return incoming engagement requests (open engagements where this user is the provider)
    const incoming = await many(
      `SELECT e.id, e.status, e.title, e.created_at,
              u.display_name AS buyer_name, u.avatar_url AS buyer_avatar,
              e.budget_minor, e.currency, e.sport_id,
              s.name AS sport_name
       FROM marketplace_engagements e
       JOIN users u ON u.id=e.buyer_id
       LEFT JOIN sports s ON s.id=e.sport_id
       WHERE e.provider_id=$1 AND e.status NOT IN ('paid','reviewed','declined','cancelled')
         AND e.family='official'
       ORDER BY e.created_at DESC LIMIT 20`,
      [user.id],
    );
    // Metric strip
    const metrics = await one(
      `SELECT
        COALESCE(l.view_count,0)                                          AS views_month,
        (SELECT COUNT(*)::int FROM marketplace_shortlists WHERE listing_id=l.id) AS shortlists,
        (SELECT COUNT(*)::int FROM marketplace_engagements
          WHERE provider_id=$1 AND family='official' AND status NOT IN ('declined','cancelled')) AS active_bookings,
        (SELECT COALESCE(SUM(q.fee_minor),0)::bigint FROM marketplace_quotes q
          JOIN marketplace_engagements e ON e.id=q.engagement_id
          WHERE e.provider_id=$1 AND e.family='official' AND q.status='accepted'
            AND q.created_at >= date_trunc('month',now())) AS earned_mtd
       FROM marketplace_listings l
       WHERE l.provider_id=$1 AND l.family='official' AND l.archived_at IS NULL
       ORDER BY l.created_at DESC LIMIT 1`,
      [user.id],
    );
    return { listing: row ?? null, incoming, metrics: metrics ?? { views_month: 0, shortlists: 0, active_bookings: 0, earned_mtd: 0 } };
  },
});

cap({
  name: 'save_official_service_listing',
  method: 'PUT',
  path: '/me/official-service-listing',
  tag: TAG,
  status: 200,
  summary: 'Official: create or update own service listing with official-specific metadata. Only one active listing per official.',
  input: z.object({
    headline:             z.string().min(5).max(140),
    summary:              z.string().max(1000).optional(),
    rate_minor:           z.number().int().min(0).max(100_000_000_000).optional(),
    rate_currency:        z.string().refine((c) => c in CURRENCIES, 'Unknown currency').optional(),
    rate_unit:            z.enum(['hour','session','day','match','project','month']).optional(),
    remote:               z.boolean().optional(),
    locations:            z.array(z.string().max(120)).max(10).optional(),
    // Official-specific metadata
    roles:                z.array(OFFICIAL_ROLES_ENUM).min(1),
    grades:               z.array(z.string().max(80)).max(20).optional(),
    event_types:          z.array(EVENT_TYPES_ENUM).optional(),
    equipment_own:        z.array(EQUIPMENT_ENUM).optional(),
    max_travel_km:        z.number().int().min(1).max(50000).optional().nullable(),
    insurance_valid_until:z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional().nullable(),
    volunteer_available:  z.boolean().optional(),
    state:                z.enum(['active','paused']).optional(),
    accepting:            z.boolean().optional(),
  }),
  async handler({ user }, i) {
    // Must have referee role and completeness ≥ 60
    if (!user.roles?.includes('referee')) throw forbidden('You need a published official profile to list your services. Add the Referee role in your profile first.');
    const wizard = await one("SELECT completeness_score FROM official_profile_wizard_state WHERE user_id=$1", [user.id]);
    if (!wizard || wizard.completeness_score < 60) throw forbidden('Complete your official profile to at least 60% before publishing a service listing.');
    // mayList guard from families.js — reuses same credential check
    const fam = FAMILY[LISTING_FAMILY];
    if (fam.credential) {
      const cred = await credentialState(user.id, fam.credential, { query: (sql, p) => one(sql, p) });
      if (!['verified','pending','self_declared','expiring'].includes(cred)) throw forbidden(`Your ${fam.credential} credential is ${cred}. You cannot list while it is in that state.`);
    }
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0] ?? null;
      // Upsert the base marketplace_listings row
      const existing = await q("SELECT id FROM marketplace_listings WHERE provider_id=$1 AND family='official' AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1", [user.id]);
      let listingId;
      if (existing) {
        await c.query(
          `UPDATE marketplace_listings SET
            headline=$2, summary=$3, rate_minor=$4, rate_currency=$5, rate_unit=$6,
            remote=$7, locations=$8, status=$9, accepting=$10, updated_at=now()
           WHERE id=$1`,
          [existing.id, i.headline, i.summary ?? null, i.rate_minor ?? null, i.rate_currency ?? null,
           i.rate_unit ?? null, i.remote ?? false, JSON.stringify(i.locations ?? []),
           i.state ?? 'active', i.accepting ?? true],
        );
        listingId = existing.id;
      } else {
        const row = await q(
          `INSERT INTO marketplace_listings(family, provider_id, headline, summary, rate_minor, rate_currency, rate_unit, remote, locations, status, accepting)
           VALUES ('official',$1,$2,$3,$4,$5,$6,$7,$8,'active',true) RETURNING id`,
          [user.id, i.headline, i.summary ?? null, i.rate_minor ?? null, i.rate_currency ?? null,
           i.rate_unit ?? null, i.remote ?? false, JSON.stringify(i.locations ?? [])],
        );
        listingId = row.id;
      }
      // Upsert official_listing_meta
      await c.query(
        `INSERT INTO official_listing_meta(listing_id, roles, grades, event_types, equipment_own, max_travel_km, insurance_valid_until, volunteer_available)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (listing_id) DO UPDATE SET
           roles=$2, grades=$3, event_types=$4, equipment_own=$5,
           max_travel_km=$6, insurance_valid_until=$7, volunteer_available=$8, updated_at=now()`,
        [listingId, i.roles, i.grades ?? [], i.event_types ?? [], i.equipment_own ?? [],
         i.max_travel_km ?? null, i.insurance_valid_until ?? null, i.volunteer_available ?? false],
      );
      return { listing_id: listingId };
    });
  },
});

cap({
  name: 'set_official_service_listing_state',
  method: 'PATCH',
  path: '/me/official-service-listing/state',
  tag: TAG,
  summary: 'Official: pause, resume or archive own service listing.',
  input: z.object({
    state: z.enum(['active','paused','archived']),
  }),
  async handler({ user }, i) {
    const listing = await one("SELECT id FROM marketplace_listings WHERE provider_id=$1 AND family='official' AND archived_at IS NULL", [user.id]);
    if (!listing) throw notFound('Service listing');
    if (i.state === 'archived') {
      await one("UPDATE marketplace_listings SET archived_at=now(), updated_at=now(), accepting=false WHERE id=$1 RETURNING id", [listing.id]);
    } else {
      await one("UPDATE marketplace_listings SET status=$2, accepting=$3, updated_at=now() WHERE id=$1", [listing.id, i.state, i.state === 'active']);
    }
    return { state: i.state };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// OFFICIAL SIDE: opportunity board (organiser-posted service requests)
// ─────────────────────────────────────────────────────────────────────────────

cap({
  name: 'list_official_opportunities',
  method: 'GET',
  path: '/me/official-opportunities',
  tag: TAG,
  summary: 'Official: browse organiser-posted service requests (billboard kind=service_request filtered for official family).',
  input: z.object({
    sport:    z.string().max(60).optional(),
    page:     z.number().int().min(1).optional(),
    per_page: z.number().int().min(1).max(50).optional(),
  }),
  async handler({ user }, i) {
    // Load the official's sports to rank by relevance
    const myRoles = await many(
      "SELECT sport_id FROM official_profile_sports WHERE user_id=$1 AND archived_at IS NULL",
      [user.id],
    );
    const mySportIds = myRoles.map((r) => r.sport_id);
    const lim = Math.min(i.per_page ?? 20, 50);
    const off = ((i.page ?? 1) - 1) * lim;
    const rows = await many(
      `SELECT p.id, p.kind, p.title, p.body, p.sport_id, p.budget_cents, p.currency, p.location_text,
              p.created_at, p.expires_at, u.display_name AS poster_name, u.avatar_url AS poster_avatar,
              s.name AS sport_name, s.emoji AS sport_emoji,
              (p.sport_id = ANY($4::uuid[])) AS relevance_match,
              (SELECT COUNT(*)::int FROM billboard_responses WHERE post_id=p.id AND status!='rejected') AS response_count,
              (SELECT 1 FROM billboard_responses br WHERE br.post_id=p.id AND br.responder_id=$1 AND br.status!='rejected' LIMIT 1) IS NOT NULL AS already_responded
       FROM billboard_posts p
       JOIN users u ON u.id=p.author_id
       LEFT JOIN sports s ON s.id=p.sport_id
       WHERE p.kind='service_request'
         AND (p.expires_at IS NULL OR p.expires_at > now())
         AND p.archived_at IS NULL
         AND ($2::text IS NULL OR s.slug=$2)
       ORDER BY relevance_match DESC, p.created_at DESC
       LIMIT $3 OFFSET $5`,
      [user.id, i.sport ?? null, lim, mySportIds.length ? mySportIds : [null], off],
    );
    return { opportunities: rows };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ORGANISER SIDE: discovery
// ─────────────────────────────────────────────────────────────────────────────

cap({
  name: 'search_official_services',
  method: 'GET',
  path: '/official-services',
  tag: TAG,
  summary: 'Organiser: search officials who have published a marketplace service listing. Official-specific filters (role, grade, event type, equipment, volunteer) layered on top of the base marketplace search.',
  input: z.object({
    q:              z.string().max(200).optional().describe('Full-text query on headline, name, summary'),
    sport:          z.string().max(60).optional(),
    role:           OFFICIAL_ROLES_ENUM.optional(),
    grade:          z.string().max(80).optional(),
    event_type:     EVENT_TYPES_ENUM.optional(),
    equipment:      EQUIPMENT_ENUM.optional(),
    volunteer_only: z.boolean().optional(),
    verified_only:  z.boolean().optional(),
    available_on:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    max_fee_minor:  z.number().int().min(0).optional(),
    city:           z.string().max(120).optional(),
    country:        z.string().max(80).optional(),
    remote:         z.boolean().optional(),
    page:           z.number().int().min(1).optional(),
    per_page:       z.number().int().min(1).max(50).optional(),
  }),
  async handler({ user }, i) {
    const lim = Math.min(i.per_page ?? 20, 50);
    const off = ((i.page ?? 1) - 1) * lim;
    const rows = await many(
      `${WITH_META}
       WHERE l.family='official'
         AND l.status='active'
         AND l.archived_at IS NULL
         AND l.accepting = true
         -- Youth exclusion
         AND NOT EXISTS (SELECT 1 FROM users yu WHERE yu.id=l.provider_id AND yu.youth_until IS NOT NULL AND yu.youth_until > current_date)
         AND ($1::text IS NULL OR l.headline ILIKE '%'||$1||'%' OR l.summary ILIKE '%'||$1||'%' OR u.display_name ILIKE '%'||$1||'%' OR u.handle ILIKE '%'||$1||'%')
         AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM sports sp WHERE sp.slug=$2 AND sp.id=l.sport_id)
              OR EXISTS (SELECT 1 FROM official_profile_sports ops WHERE ops.user_id=l.provider_id AND ops.sport_id=(SELECT id FROM sports WHERE slug=$2 LIMIT 1) AND ops.archived_at IS NULL))
         AND ($3::text IS NULL OR olm.roles @> ARRAY[$3])
         AND ($4::text IS NULL OR olm.grades @> ARRAY[$4])
         AND ($5::text IS NULL OR olm.event_types @> ARRAY[$5])
         AND ($6::text IS NULL OR olm.equipment_own @> ARRAY[$6])
         AND ($7::bool IS NULL OR ($7=true AND olm.volunteer_available=true))
         AND ($8::bool IS NULL OR ($8=true AND creds.state='verified'))
         AND ($9::text IS NULL OR NOT EXISTS (
              SELECT 1 FROM marketplace_engagements me2
              WHERE me2.provider_id=l.provider_id AND me2.status IN ('contracted','scheduled')
                AND $9::date BETWEEN me2.starts_at::date AND COALESCE(me2.ends_at::date, me2.starts_at::date)
         ))
         AND ($10::bigint IS NULL OR l.rate_minor IS NULL OR l.rate_minor <= $10)
         AND ($11::text IS NULL OR l.locations::text ILIKE '%'||$11||'%')
         AND ($12::text IS NULL OR l.locations::text ILIKE '%'||$12||'%')
         AND ($13::bool IS NULL OR l.remote=$13)
       GROUP BY l.id, u.display_name, u.handle, u.avatar_url, osp.completeness_score,
                olm.roles, olm.grades, olm.event_types, olm.equipment_own,
                olm.max_travel_km, olm.insurance_valid_until, olm.volunteer_available, creds.state
       ORDER BY
         (creds.state='verified')::int DESC,
         COALESCE(ROUND(AVG(t.score),2),0) DESC,
         COUNT(DISTINCT me.id) FILTER (WHERE me.status IN ('paid','reviewed')) DESC,
         l.updated_at DESC
       LIMIT $14 OFFSET $15`,
      [i.q ?? null, i.sport ?? null, i.role ?? null, i.grade ?? null, i.event_type ?? null,
       i.equipment ?? null, i.volunteer_only ?? null, i.verified_only ?? null, i.available_on ?? null,
       i.max_fee_minor ?? null, i.city ?? null, i.country ?? null, i.remote ?? null, lim, off],
    );
    return { results: rows, page: i.page ?? 1, per_page: lim };
  },
});

cap({
  name: 'get_official_service_listing',
  method: 'GET',
  path: '/official-services/:listing_id',
  tag: TAG,
  summary: 'Public official service profile. Returns listing + meta + profile snippet. Official completeness must be ≥ 60. Private PII is never returned.',
  input: z.object({ listing_id: id }),
  async handler({ user }, i) {
    const row = await one(
      `${WITH_META}
       WHERE l.id=$1 AND l.family='official' AND l.archived_at IS NULL
       GROUP BY l.id, u.display_name, u.handle, u.avatar_url, osp.completeness_score,
                olm.roles, olm.grades, olm.event_types, olm.equipment_own,
                olm.max_travel_km, olm.insurance_valid_until, olm.volunteer_available, creds.state`,
      [i.listing_id],
    );
    if (!row) throw notFound('Official service listing');
    if ((row.completeness_score ?? 0) < 60) throw notFound('Official service listing');
    // Rate card (public fields only — no payout details, no tax info, no private notes)
    const rates = await many(
      `SELECT sport_id, role, fixture_type, level_label, fee_minor, fee_currency,
              includes_travel, travel_allowance_per_km_minor, valid_from, valid_until
       FROM official_profile_rates WHERE user_id=$1 AND (valid_until IS NULL OR valid_until >= current_date)`,
      [row.provider_id ?? await one('SELECT provider_id FROM marketplace_listings WHERE id=$1', [i.listing_id]).then((r) => r?.provider_id)],
    );
    // Recent reviews (public, no reviewer PII)
    const reviews = await many(
      `SELECT osr.punctuality, osr.communication, osr.officiating_quality, osr.professionalism,
              osr.rules_adherence, osr.overall, osr.public_note, osr.created_at
       FROM official_service_reviews osr WHERE osr.official_id=$1
       ORDER BY osr.created_at DESC LIMIT 10`,
      [row.provider_id ?? null],
    );
    return { ...row, rate_cards: rates, recent_reviews: reviews };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ORGANISER SIDE: request & booking management
// ─────────────────────────────────────────────────────────────────────────────

cap({
  name: 'request_official_service',
  method: 'POST',
  path: '/official-services/:listing_id/request',
  tag: TAG,
  status: 201,
  summary: 'Organiser: start a marketplace engagement with an official from their service listing. Auto-fills brief with listing context. The engagement lifecycle then uses the standard marketplace-engagements endpoints.',
  input: z.object({
    listing_id:           id,
    title:                z.string().min(3).max(140),
    brief:                z.string().max(2000).optional(),
    sport:                z.string().max(60).optional(),
    budget_minor:         z.number().int().min(0).optional(),
    currency:             z.string().refine((c) => c in CURRENCIES, 'Unknown currency').optional(),
    buyer_organisation_id:id.optional(),
    // Optional fixture context (pre-fills, not enforced at this stage)
    fixture_id:           id.optional(),
    role_wanted:          OFFICIAL_ROLES_ENUM.optional(),
    event_date:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  async handler({ user }, i) {
    await mustBeAdult(user, { query: (sql, p) => one(sql, p) });
    const listing = await one("SELECT * FROM marketplace_listings WHERE id=$1 AND family='official' AND status='active' AND archived_at IS NULL AND accepting=true", [i.listing_id]);
    if (!listing) throw notFound('Official service listing');
    if (listing.provider_id === user.id) throw badRequest('You cannot request yourself');
    // Delegate to the canonical engagement creation
    const brief = [i.brief, i.role_wanted ? `Role: ${i.role_wanted}` : null, i.event_date ? `Date: ${i.event_date}` : null].filter(Boolean).join('\n');
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0] ?? null;
      let sport = null;
      if (i.sport) { sport = await q('SELECT id FROM sports WHERE slug=$1', [i.sport]); }
      if (i.buyer_organisation_id && !(await q("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')", [i.buyer_organisation_id, user.id]))) throw notFound('Organisation');
      let e;
      try {
        e = await q(
          `INSERT INTO marketplace_engagements(listing_id, family, buyer_id, buyer_org_id, provider_id, provider_org_id,
            title, sport_id, brief_enc, budget_minor, currency, origin_type, origin_id)
           VALUES ($1,'official',$2,$3,$4,$5,$6,$7,$8,$9,$10,'listing',$1) RETURNING *`,
          [listing.id, user.id, i.buyer_organisation_id ?? null, listing.provider_id, listing.organisation_id ?? null,
           i.title, sport?.id ?? null, brief ? (await import('../crypto.js').then((m) => m.encrypt(brief, 'marketplace_engagements.brief'))) : null,
           i.budget_minor ?? listing.rate_minor ?? null, i.currency ?? listing.rate_currency ?? 'INR'],
        );
      } catch (err) { if (err.code === '23505') throw conflict('You already have an open request with this official'); throw err; }
      await c.query("INSERT INTO marketplace_events(engagement_id, actor_id, kind, detail) VALUES ($1,$2,'requested',$3)", [e.id, user.id, { family: 'official', listing_id: listing.id }]);
      // Notify official
      await notify(c, listing.provider_id, { kind: 'marketplace_engagement', title: `New booking request: ${i.title}`, body: `${user.display_name ?? 'An organiser'} wants to book your officiating services.`, data: { marketplace_engagement_id: e.id } });
      // Store fixture context hint (soft link; not an assignment yet)
      if (i.fixture_id) {
        await c.query("INSERT INTO official_service_bookings(engagement_id, fixture_id, engagement_id_snapshot) VALUES ($1,$2,$1) ON CONFLICT (engagement_id) DO NOTHING", [e.id, i.fixture_id]);
      }
      return { engagement_id: e.id };
    });
  },
});

cap({
  name: 'assign_official_service_booking',
  method: 'POST',
  path: '/official-service-bookings/:engagement_id/assign',
  tag: TAG,
  status: 200,
  summary: 'Organiser: once an engagement reaches contracted status, link it to a fixture_officials assignment. Idempotent. Runs eligibility checks server-side.',
  input: z.object({
    engagement_id: id,
    fixture_id:    id,
    role:          OFFICIAL_ROLES_ENUM,
    reporting_min: z.number().int().min(0).max(240).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0] ?? null;
      const e = await q("SELECT * FROM marketplace_engagements WHERE id=$1 AND family='official'", [i.engagement_id]);
      if (!e) throw notFound('Engagement');
      if (e.buyer_id !== user.id) throw forbidden('Only the buyer can assign');
      if (e.status !== 'contracted') throw conflict('The engagement must be in contracted status to assign the official to a fixture');
      const fixture = await q('SELECT fi.*, ev.id AS event_id FROM fixtures fi JOIN events ev ON ev.id=fi.event_id WHERE fi.id=$1', [i.fixture_id]);
      if (!fixture) throw notFound('Fixture');
      // Check organiser has permission on this event
      if (!(await q("SELECT 1 FROM event_members WHERE event_id=$1 AND user_id=$2 AND role IN ('owner','admin','organiser') AND status='active'", [fixture.event_id, user.id]))) throw forbidden('You are not an organiser of this event');
      // Idempotency: if already assigned, return existing
      const existing = await q("SELECT * FROM official_service_bookings WHERE engagement_id=$1", [i.engagement_id]);
      if (existing?.fixture_official_id) {
        return { fixture_official_id: existing.fixture_official_id, booking_id: existing.id, already_assigned: true };
      }
      // Run eligibility check (uses the same guard as open-slots)
      await lockOfficial(c, e.provider_id);
      await assertOfficialEligible(c, {
        event: { id: fixture.event_id }, fixtureId: fixture.id, userId: e.provider_id,
        role: i.role, start: fixture.scheduled_at, durationMin: (fixture.duration_min ?? 90) + (i.reporting_min ?? 30), mode: 'invite',
      });
      // Agreed fee from latest accepted quote
      const quote = await q("SELECT fee_minor, currency FROM marketplace_quotes WHERE engagement_id=$1 AND status='accepted' ORDER BY created_at DESC LIMIT 1", [e.id]);
      // Create fixture_officials row (invitation flow — official has already agreed via contract)
      const fo = await q(
        `INSERT INTO fixture_officials(fixture_id, user_id, role, status, reporting_min, invited_by, source, source_engagement_id)
         VALUES ($1,$2,$3,'accepted',$4,$5,'marketplace_booking',$6) RETURNING id`,
        [i.fixture_id, e.provider_id, i.role, i.reporting_min ?? 30, user.id, e.id],
      );
      // Upsert booking record
      await c.query(
        `INSERT INTO official_service_bookings(engagement_id, fixture_official_id, fixture_id, status, agreed_fee_minor, agreed_fee_currency, engagement_id_snapshot)
         VALUES ($1,$2,$3,'assigned',$4,$5,$1)
         ON CONFLICT (engagement_id) DO UPDATE SET fixture_official_id=$2, fixture_id=$3, status='assigned', agreed_fee_minor=$4, agreed_fee_currency=$5, updated_at=now()`,
        [e.id, fo.id, i.fixture_id, quote?.fee_minor ?? null, quote?.currency ?? null],
      );
      // Notify official
      await notify(c, e.provider_id, { kind: 'fixture_assignment', title: 'You have been assigned to a fixture', body: `Your marketplace booking has been confirmed as a fixture assignment.`, data: { fixture_id: i.fixture_id, fixture_official_id: fo.id } });
      return { fixture_official_id: fo.id, booking_id: existing?.id ?? e.id };
    });
  },
});

cap({
  name: 'list_official_service_bookings',
  method: 'GET',
  path: '/me/official-service-bookings',
  tag: TAG,
  summary: 'Organiser: list official service bookings (contracted and beyond) with status, assignment link and fee.',
  input: z.object({
    status: z.enum(['booked','assigned','completed','cancelled','all']).optional(),
    page:   z.number().int().min(1).optional(),
  }),
  async handler({ user }, i) {
    const lim = 20;
    const off = ((i.page ?? 1) - 1) * lim;
    const rows = await many(
      `SELECT osb.id, osb.status, osb.agreed_fee_minor, osb.agreed_fee_currency,
              osb.fixture_id, osb.fixture_official_id, osb.created_at,
              e.title, e.status AS engagement_status, e.id AS engagement_id,
              u.display_name AS official_name, u.avatar_url AS official_avatar,
              olm.roles, olm.grades,
              fi.scheduled_at, fi.home_name, fi.away_name
       FROM official_service_bookings osb
       JOIN marketplace_engagements e ON e.id=osb.engagement_id
       JOIN users u ON u.id=e.provider_id
       LEFT JOIN official_listing_meta olm ON olm.listing_id=e.listing_id
       LEFT JOIN fixtures fi ON fi.id=osb.fixture_id
       WHERE e.buyer_id=$1
         AND ($2::text IS NULL OR $2='all' OR osb.status=$2)
       ORDER BY osb.created_at DESC LIMIT $3 OFFSET $4`,
      [user.id, i.status === 'all' ? null : (i.status ?? null), lim, off],
    );
    return { bookings: rows };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW: 5-criteria structured review
// ─────────────────────────────────────────────────────────────────────────────

cap({
  name: 'review_official_service',
  method: 'POST',
  path: '/official-service-bookings/:engagement_id/review',
  tag: TAG,
  status: 201,
  summary: 'Organiser: submit a 5-criteria review for an official after an engagement reaches delivered status. Also creates a testimonial so the official\'s public rating updates.',
  input: z.object({
    engagement_id:      id,
    punctuality:        z.number().int().min(1).max(5),
    communication:      z.number().int().min(1).max(5),
    officiating_quality:z.number().int().min(1).max(5),
    professionalism:    z.number().int().min(1).max(5),
    rules_adherence:    z.number().int().min(1).max(5),
    public_note:        z.string().max(1000).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0] ?? null;
      const e = await q("SELECT * FROM marketplace_engagements WHERE id=$1 AND family='official' AND buyer_id=$2", [i.engagement_id, user.id]);
      if (!e) throw notFound('Engagement');
      if (!['delivered','invoiced','paid','reviewed'].includes(e.status)) throw conflict(`You can only review after the engagement is delivered (current status: ${e.status})`);
      // Idempotency
      const exists = await q("SELECT id FROM official_service_reviews WHERE engagement_id=$1 AND reviewer_id=$2", [i.engagement_id, user.id]);
      if (exists) throw conflict('You have already reviewed this engagement');
      const overall = (i.punctuality + i.communication + i.officiating_quality + i.professionalism + i.rules_adherence) / 5;
      // Create testimonial for the official's public rating
      const testimonial = await q(
        `INSERT INTO testimonials(author_id, subject_id, subject_type, score, body, status)
         VALUES ($1,$2,'user',$3,$4,'approved') RETURNING id`,
        [user.id, e.provider_id, overall, i.public_note ?? null],
      );
      // Create detailed review row
      const review = await q(
        `INSERT INTO official_service_reviews(engagement_id, reviewer_id, official_id, testimonial_id, punctuality, communication, officiating_quality, professionalism, rules_adherence, public_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, overall`,
        [i.engagement_id, user.id, e.provider_id, testimonial?.id ?? null,
         i.punctuality, i.communication, i.officiating_quality, i.professionalism, i.rules_adherence, i.public_note ?? null],
      );
      // Mark engagement as reviewed
      await c.query("UPDATE marketplace_engagements SET status='reviewed', updated_at=now() WHERE id=$1", [i.engagement_id]);
      await c.query("INSERT INTO marketplace_events(engagement_id, actor_id, kind, detail) VALUES ($1,$2,'reviewed',$3)", [i.engagement_id, user.id, { overall }]);
      // Notify official
      await notify(c, e.provider_id, { kind: 'marketplace_review', title: 'New service review', body: `You received a ${overall.toFixed(1)}/5.0 review for "${e.title}"`, data: { engagement_id: i.engagement_id } });
      return { review_id: review.id, overall: review.overall };
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// ORGANISER SIDE: post an official service request to the billboard
// ─────────────────────────────────────────────────────────────────────────────

cap({
  name: 'post_official_opportunity',
  method: 'POST',
  path: '/official-opportunities',
  tag: TAG,
  status: 201,
  summary: 'Organiser: post a service_request on the billboard seeking an official. Officials browse this via list_official_opportunities and respond via the billboard.',
  input: z.object({
    title:          z.string().min(5).max(140),
    body:           z.string().max(2000).optional(),
    sport:          z.string().max(60).optional(),
    role_wanted:    OFFICIAL_ROLES_ENUM.optional(),
    event_type:     EVENT_TYPES_ENUM.optional(),
    budget_minor:   z.number().int().min(0).optional(),
    currency:       z.string().refine((c) => c in CURRENCIES, 'Unknown currency').optional(),
    location_text:  z.string().max(200).optional(),
    expires_at:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    organisation_id:id.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const q = async (sql, p) => (await c.query(sql, p)).rows[0] ?? null;
      let sport = null;
      if (i.sport) { sport = await q('SELECT id FROM sports WHERE slug=$1', [i.sport]); if (!sport) throw badRequest('Unknown sport'); }
      if (i.organisation_id && !(await q("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')", [i.organisation_id, user.id]))) throw notFound('Organisation');
      const body = [i.body, i.role_wanted ? `Role: ${i.role_wanted}` : null, i.event_type ? `Event type: ${i.event_type}` : null].filter(Boolean).join('\n');
      const post = await q(
        `INSERT INTO billboard_posts(author_id, organisation_id, kind, title, body, sport_id, budget_cents, currency, location_text, expires_at)
         VALUES ($1,$2,'service_request',$3,$4,$5,$6,$7,$8,$9::date) RETURNING id`,
        [user.id, i.organisation_id ?? null, i.title, body || null, sport?.id ?? null,
         i.budget_minor ?? null, i.currency ?? null, i.location_text ?? null, i.expires_at ?? null],
      );
      return { post_id: post.id };
    });
  },
});
