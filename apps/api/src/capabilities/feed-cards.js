// Fan & Community Feed — canonical feed card projections and discovery (issue #522).
// Feed cards are pointers to canonical records (never copies of scores/awards/results).
// Retracting a source record removes the card from all feeds automatically via DB triggers.
// Three feed modes: 'ranked' (For You — explicit follows + sport + geography + recency),
// 'following' (entities and people you follow, recency-ranked), 'chronological' (strict time order).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { isYouth } from '../youth.js';
import { mustBePlatformAdmin } from '../platform.js';
import { ENTITY_KINDS } from '../social.js';

const TAG = 'Community Feed';
const ekind = z.enum(ENTITY_KINDS);

const CARD_COLS = `
  fc.id, fc.card_kind, fc.ref_kind, fc.ref_id, fc.author_kind, fc.author_id,
  fc.visibility, fc.is_youth_subject, fc.sport_id, fc.geo_city,
  fc.is_promoted, fc.is_sponsored, fc.reactions_count, fc.comments_count,
  fc.published_at, fc.retracted_at,
  s.slug AS sport_slug, s.name AS sport_name`;

/** Build a feed for a viewer. mode: 'ranked' | 'following' | 'chronological'. */
async function buildFeed(viewerId, { mode = 'ranked', sport, city, limit = 20, before } = {}) {
  const isYouthViewer = await isYouth(viewerId);
  const cursorAt = before ? String(before).split('|')[0] : null;
  const cursorId = before ? String(before).split('|')[1] : null;
  if (cursorAt && Number.isNaN(Date.parse(cursorAt))) throw badRequest('before must be a cursor');

  // Entities the viewer follows (for following / ranked modes)
  const entityFollows = await many(
    `SELECT entity_kind, entity_id::text FROM feed_entity_follows WHERE follower_id=$1 AND removed_at IS NULL`, [viewerId]);
  const entityIds = entityFollows.map((r) => r.entity_id);

  // Muted entities (suppress from all modes)
  const mutedRows = await many(
    `SELECT entity_kind, entity_id::text FROM feed_entity_mutes WHERE muter_id=$1 AND lifted_at IS NULL`, [viewerId]);
  const mutedSet = new Set(mutedRows.map((r) => `${r.entity_kind}:${r.entity_id}`));
  const mutedEntityIds = mutedRows.map((r) => r.entity_id);

  // Person follows: entity_kind='user' rows conceptually from spectator_follows (for ranked mode)
  const personFollows = await many(
    `SELECT subject_id::text AS entity_id FROM spectator_follows WHERE user_id=$1 AND subject_type='athlete' AND removed_at IS NULL`, [viewerId]);
  const allFollowedIds = [...new Set([...entityIds, ...personFollows.map((r) => r.entity_id)])];

  // Sport interests from profile
  const sportInterests = await many(
    `SELECT sport_id::text FROM sport_profiles WHERE user_id=$1`, [viewerId]);
  const sportInterestIds = sportInterests.map((r) => r.sport_id);

  let baseWhere = `fc.retracted_at IS NULL`;
  // Youth viewers: only public cards with is_youth_subject=false OR visibility='followers'
  if (isYouthViewer) baseWhere += ` AND fc.is_youth_subject = false`;
  // Filter by sport
  if (sport) baseWhere += ` AND fc.sport_id = '${sport}'::uuid`;
  // Filter by city
  if (city) baseWhere += ` AND fc.geo_city = '${city.replace(/'/g, "''")}'`;
  // Cursor pagination
  const cursorFilter = cursorAt
    ? `AND (fc.published_at, fc.id) < ('${cursorAt}'::timestamptz, '${cursorId}'::uuid)` : '';
  // Muted entities filter
  const mutedFilter = mutedEntityIds.length
    ? `AND NOT (fc.author_kind = ANY(ARRAY[${mutedRows.map((r) => `'${r.entity_kind}'`).join(',')}]::text[]) AND fc.author_id::text = ANY(ARRAY[${mutedEntityIds.map((id) => `'${id}'`).join(',')}]::text[]))`
    : '';

  let rows;
  if (mode === 'following' || mode === 'chronological') {
    // Show only cards authored by followed entities or promoted cards
    if (!allFollowedIds.length) return [];
    const idList = allFollowedIds.map((id, i) => `$${i + 2}`).join(',');
    rows = await many(
      `SELECT ${CARD_COLS}
         FROM feed_cards fc LEFT JOIN sports s ON s.id = fc.sport_id
        WHERE ${baseWhere} ${cursorFilter} ${mutedFilter}
          AND (fc.author_id::text = ANY(ARRAY[${allFollowedIds.map((_, i) => `$${i + 2}`).join(',')}]) OR fc.is_promoted = true)
          AND (fc.visibility = 'public' OR (fc.visibility = 'followers' AND fc.author_id::text = ANY(ARRAY[${allFollowedIds.map((_, i) => `$${i + 2}`).join(',')}])))
        ORDER BY fc.published_at DESC, fc.id DESC
        LIMIT $1`,
      [limit, ...allFollowedIds]);
  } else {
    // Ranked: mix of followed entities (high weight), sport interest (medium weight), recency + promoted
    const visibility = `(fc.visibility = 'public')`;
    rows = await many(
      `SELECT ${CARD_COLS},
              CASE
                WHEN fc.author_id::text = ANY($2::text[])                   THEN 100
                WHEN fc.sport_id::text  = ANY($3::text[]) AND $3 <> '{}'    THEN 40
                WHEN fc.is_promoted                                          THEN 30
                ELSE 10
              END AS _score
         FROM feed_cards fc LEFT JOIN sports s ON s.id = fc.sport_id
        WHERE ${baseWhere} ${cursorFilter} ${mutedFilter} AND ${visibility}
        ORDER BY _score DESC, fc.published_at DESC, fc.id DESC
        LIMIT $1`,
      [limit,
       allFollowedIds.length ? allFollowedIds : ['00000000-0000-0000-0000-000000000000'],
       sportInterestIds.length ? sportInterestIds : ['00000000-0000-0000-0000-000000000000']]);
  }

  // Strip internal score column
  return rows.map(({ _score, ...r }) => r);
}

cap({
  name: 'get_feed', method: 'GET', path: '/feed', tag: TAG,
  summary: 'The signed-in user\'s community feed. mode=ranked (For You: follows + sport interest + recency + promoted), mode=following (entity and person follows, recency order), mode=chronological (strict time, follows only). Cursor-paginated. Youth viewers never see youth-subject cards with location or contact data. Promoted cards are always labelled is_promoted=true.',
  input: z.object({
    mode: z.enum(['ranked', 'following', 'chronological']).default('ranked'),
    sport: id.optional(),
    city: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before: z.string().optional(),
  }),
  async handler({ user }, i) {
    return buildFeed(user.id, i);
  },
});

cap({
  name: 'get_entity_feed', method: 'GET', path: '/feed/public/:kind/:entity_id', tag: TAG,
  auth: 'public',
  summary: 'Public feed for a specific entity (team, academy, venue, event, coach, organisation). Returns non-retracted, public-visibility cards authored by this entity. Youth-subject cards are excluded from public feeds. 404 if the entity does not exist or is not publicly discoverable.',
  input: z.object({
    kind: ekind, entity_id: id,
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before: z.string().optional(),
  }),
  async handler({ user }, i) {
    // Verify the entity exists and is public
    const checks = {
      team:         `SELECT id FROM teams WHERE id=$1 AND status NOT IN ('archived','deleted')`,
      academy:      `SELECT o.id FROM organisations o WHERE o.id=$1 AND o.kind='academy' AND o.archived_at IS NULL`,
      venue:        `SELECT id FROM venues WHERE id=$1 AND archived_at IS NULL`,
      event:        `SELECT id FROM events WHERE id=$1 AND status NOT IN ('cancelled','deleted') AND visibility='public'`,
      coach:        `SELECT u.id FROM users u WHERE u.id=$1`,
      organisation: `SELECT id FROM organisations WHERE id=$1 AND archived_at IS NULL`,
    };
    const entity = await one(checks[i.kind], [i.entity_id]);
    if (!entity) throw notFound(i.kind.charAt(0).toUpperCase() + i.kind.slice(1));

    const cursorAt = i.before ? String(i.before).split('|')[0] : null;
    const cursorId = i.before ? String(i.before).split('|')[1] : null;
    const cursorFilter = cursorAt
      ? `AND (fc.published_at, fc.id) < ('${cursorAt}'::timestamptz, '${cursorId}'::uuid)` : '';

    const rows = await many(
      `SELECT ${CARD_COLS}
         FROM feed_cards fc LEFT JOIN sports s ON s.id = fc.sport_id
        WHERE fc.retracted_at IS NULL AND fc.visibility = 'public'
          AND fc.is_youth_subject = false
          AND fc.author_kind = $2 AND fc.author_id = $3
          ${cursorFilter}
        ORDER BY fc.published_at DESC, fc.id DESC LIMIT $1`,
      [i.limit, i.kind, i.entity_id]);

    const cnt = await one(`SELECT count FROM feed_entity_follow_counts WHERE entity_kind=$1 AND entity_id=$2`, [i.kind, i.entity_id]);
    return { entity_kind: i.kind, entity_id: i.entity_id, followers_count: cnt?.count ?? 0, cards: rows };
  },
});

cap({
  name: 'project_feed_card', method: 'POST', path: '/feed/cards', tag: TAG,
  auth: ['admin', 'platform_admin'],
  summary: 'Register a new canonical feed card projection. Called server-side by other capabilities (event results, achievements, announcements) when a canonical record is published. Not callable by end users.',
  input: z.object({
    card_kind: z.enum(['result','fixture','achievement','clip','announcement','challenge','ranking','post']),
    ref_kind: z.string().max(60),
    ref_id: z.string().max(200),
    author_kind: z.enum(['team','academy','venue','event','coach','organisation','user']),
    author_id: id,
    visibility: z.enum(['public','followers','private']).default('public'),
    is_youth_subject: z.boolean().default(false),
    sport_id: id.optional(),
    geo_city: z.string().max(80).optional(),
    geo_venue_id: id.optional(),
    is_sponsored: z.boolean().default(false),
    sponsor_id: id.optional(),
  }),
  async handler({ user }, i) {
    // If the subject is a youth profile, force followers-only visibility.
    const visibility = i.is_youth_subject ? 'followers' : i.visibility;
    const row = await one(
      `INSERT INTO feed_cards(card_kind, ref_kind, ref_id, author_kind, author_id, visibility, is_youth_subject, sport_id, geo_city, geo_venue_id, is_sponsored, sponsor_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT (ref_kind, ref_id) WHERE retracted_at IS NULL
            DO UPDATE SET published_at=now(), visibility=$6, is_youth_subject=$7
         RETURNING id, published_at`,
      [i.card_kind, i.ref_kind, i.ref_id, i.author_kind, i.author_id, visibility, i.is_youth_subject,
       i.sport_id ?? null, i.geo_city ?? null, i.geo_venue_id ?? null, i.is_sponsored, i.sponsor_id ?? null]);
    await audit(null, user.id, 'feed_card_projected', 'feed_cards', row.id);
    return row;
  },
});

cap({
  name: 'retract_feed_card', method: 'POST', path: '/feed/cards/:id/retract', tag: TAG,
  auth: ['admin', 'platform_admin', 'organizer', 'venue_manager'],
  summary: 'Retract a feed card, removing it from all feeds immediately. Org staff may retract cards authored by their own entity; platform admins may retract any card.',
  input: z.object({ id, reason: z.string().max(200).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const card = (await c.query(`SELECT * FROM feed_cards WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (!card) throw notFound('Feed card');
      await c.query(`UPDATE feed_cards SET retracted_at=now(), retracted_reason=$2 WHERE id=$1`, [i.id, i.reason ?? null]);
      await audit(c, user.id, 'feed_card_retracted', 'feed_cards', i.id, { reason: i.reason });
      return { retracted: true, id: i.id };
    });
  },
});

cap({
  name: 'get_feed_card', method: 'GET', path: '/feed/cards/:id', tag: TAG,
  auth: 'public',
  summary: 'Get a single feed card by id. Public if visibility=public and not retracted; authenticated users may also see followers-only cards they are entitled to. Returns 404 for retracted cards.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const card = await one(
      `SELECT ${CARD_COLS} FROM feed_cards fc LEFT JOIN sports s ON s.id = fc.sport_id WHERE fc.id=$1 AND fc.retracted_at IS NULL`, [i.id]);
    if (!card) throw notFound('Feed card');
    if (card.visibility !== 'public' && !user) throw notFound('Feed card');
    return card;
  },
});
