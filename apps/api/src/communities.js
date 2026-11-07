// Communities (issue #66): the rules for who may see, join, post in and run a community. One place, enforced on the server for REST, OpenAPI and MCP.
//
//  - A community is public (content readable by any signed-in member), private (listed, content for members only) or hidden (not even listed).
//  - Anything an outsider may not read answers 404, never 403, so a private or hidden community cannot be probed.
//  - Roles: owner > moderator > member. Moderators run the member list and reports of their community; only the owner appoints moderators.
//  - Blocks apply in both directions to invitations, join requests, member lists, posts and comments; mutes hide a person from the feed.
//  - Young people: never in an adults-only community (the default); in an 'all' community only by invitation, only while a guardian link with the
//    'social' scope is live (re-checked on every read, so a revoked guardian removes access at once), and they are listed to staff only.
//  - Text of community posts and comments is encrypted at rest; nothing is deleted (archived_at / hidden_at / status).
import { one, many } from './db.js';
import { conflict, forbidden, notFound, tooMany } from './errors.js';
import { isYouth } from './youth.js';
import { socialLive } from './social.js';
import { spendKindAllowance } from './spectator.js';

export const ROLES = ['owner', 'moderator', 'peer_mentor', 'member'];
export const POST_CTX = 'market_posts.body';
export const COMMENT_CTX = 'market_comments.body';
export const REPORT_CTX = 'social_reports.decision';
export const LIMITS = { communitiesOwned: 20, postsPerHour: 30, commentsPerHour: 120, invitesPerHour: 30, joinsPerHour: 30, messagesPerHour: 300, mentorshipsPerMonth: 20 };
/** Notification kinds grouped for the person's "what do you want to hear about" switches (each maps onto the existing muted_kinds list). */
export const SOCIAL_CATEGORIES = {
  people: ['follow_new', 'follow_request', 'friend_request', 'friend_accepted'],
  communities: ['community_invite', 'community_request', 'community_member'],
  comments: ['market_comment'],
};

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** SQL: `col` (a user id) and the viewer have a live block between them, in either direction. */
export const blockedBetween = (col, viewer) => `EXISTS (SELECT 1 FROM user_blocks b WHERE b.lifted_at IS NULL AND ((b.blocker_id=${col} AND b.blocked_id=${viewer}) OR (b.blocker_id=${viewer} AND b.blocked_id=${col})))`;
export const mutedBy = (col, viewer) => `EXISTS (SELECT 1 FROM social_mutes m WHERE m.lifted_at IS NULL AND m.muter_id=${viewer} AND m.muted_id=${col})`;

const UUID = /^[0-9a-f-]{36}$/i;
export async function loadCommunity(ref) {
  const r = String(ref);
  return one(`SELECT c.* FROM communities c WHERE c.archived_at IS NULL AND ${UUID.test(r) ? 'c.id=$1::uuid' : 'lower(c.slug)=lower($1)'}`, [r]);
}

/** The person's live membership (active, and for a young person only while a guardian's 'social' authority is live). */
export const membership = (userId, communityId) => one(
  `SELECT m.role, m.status, m.muted_until, (m.muted_until IS NOT NULL AND m.muted_until > now()) AS silenced FROM community_members m
    WHERE m.community_id=$1 AND m.user_id=$2 AND m.status='active' AND ${socialLive('m.user_id')}`, [communityId, userId]);

const pendingInvite = (userId, communityId) => one("SELECT 1 FROM community_invitations WHERE community_id=$1 AND invitee_id=$2 AND status='pending'", [communityId, userId]);

/**
 * The community `ref` (id or slug) as `user` may use it, or a 404.
 *  read:   content (feed, posts, comments, members) — public: any signed-in person who is not blocked by the owner; private/hidden: members only
 *  post:   an active member who has not been silenced
 *  manage: owner or moderator (a member who is not staff gets 403: they already know it exists)
 *  owner:  the owner only
 * A hidden community is a 404 to everyone who is neither a member nor invited.
 */
export async function communityFor(user, ref, { need = 'view' } = {}) {
  const community = await loadCommunity(ref);
  if (!community) throw notFound('Community');
  const m = await membership(user.id, community.id);
  const invited = !m && !!(await pendingInvite(user.id, community.id));
  if (community.visibility === 'hidden' && !m && !invited) throw notFound('Community');
  if (!m && (await one('SELECT 1 FROM user_blocks WHERE lifted_at IS NULL AND ((blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))', [user.id, community.owner_id]))) throw notFound('Community');
  if (need === 'view') return { community, m, invited };
  if (need === 'read') {
    if (!m && community.visibility !== 'public') throw notFound('Community');
    if (!m && (await isYouth(user.id)) && community.audience !== 'all') throw notFound('Community');
    return { community, m, invited };
  }
  if (!m) throw notFound('Community');
  if (need === 'post') {
    if (m.silenced) throw forbidden('A moderator has silenced you here for now');
    return { community, m, invited };
  }
  const staff = m.role === 'owner' || m.role === 'moderator';
  if (need === 'manage' && !staff) throw forbidden('Only the owner or a moderator can do this');
  if (need === 'owner' && m.role !== 'owner') throw forbidden('Only the owner can do this');
  return { community, m, invited };
}

/** Community staff (owner or moderator) of this community, for moderation. */
export const isStaff = async (userId, communityId) => { const m = await membership(userId, communityId); return !!m && (m.role === 'owner' || m.role === 'moderator'); };

/** Communities this person moderates (used to scope their moderation queue). */
export const staffCommunityIds = async (userId) => (await many("SELECT community_id FROM community_members WHERE user_id=$1 AND status='active' AND role IN ('owner','moderator')", [userId])).map((r) => r.community_id);

/** A cursor over (timestamp, id) with microsecond precision, so pages never skip or repeat rows that share a millisecond. */
export const cursorOf = (row, col = 'created_at') => `${row[`${col}_cursor`]}|${row.id}`;
export const CURSOR_TS = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export function parseCursor(before) {
  if (!before) return [null, null];
  const [ts, rid] = String(before).split('|');
  if (!ts || !UUID.test(rid ?? '') || Number.isNaN(Date.parse(ts))) return [undefined, undefined];
  return [ts, rid];
}

/** Hourly allowance per kind of action; stops stuffing and floods without needing an IP. */
export async function spend(c, userId, kind, perHour) {
  if (!(await spendKindAllowance(c, userId, kind, perHour))) throw tooMany('Slow down — try again in a little while');
}

export const conflictIf = (cond, msg) => { if (cond) throw conflict(msg); };

/**
 * Retention for community content: posts and comments older than COMMUNITY_RETENTION_DAYS (default 730; 0 keeps everything) are archived,
 * and their media is marked removed. Nothing is deleted, files stay on disk until the operator's own backup policy removes them, and content
 * under an open report is kept until the report is decided.
 */
export async function archiveStaleCommunityContent({ limit = 500 } = {}) {
  const days = Number(process.env.COMMUNITY_RETENTION_DAYS ?? 730);
  if (!days) return { posts: 0, comments: 0 };
  const posts = await one(
    `WITH due AS (SELECT p.id FROM market_posts p WHERE p.community_id IS NOT NULL AND p.archived_at IS NULL AND p.created_at < now() - make_interval(days => $1)
                    AND NOT EXISTS (SELECT 1 FROM social_reports r WHERE r.target_id=p.id::text AND r.status='open') ORDER BY p.created_at LIMIT $2 FOR UPDATE SKIP LOCKED),
          up AS (UPDATE market_posts p SET archived_at=now() FROM due WHERE p.id=due.id RETURNING p.id),
          md AS (UPDATE market_media m SET removed_at=now() FROM up WHERE m.post_id=up.id AND m.removed_at IS NULL RETURNING 1)
     SELECT count(*)::int AS n FROM up`, [days, limit]);
  const comments = await one(
    `WITH up AS (UPDATE market_comments c SET archived_at=now() WHERE c.archived_at IS NULL AND c.body_enc IS NOT NULL AND c.created_at < now() - make_interval(days => $1)
                    AND NOT EXISTS (SELECT 1 FROM social_reports r WHERE r.target_id=c.id::text AND r.status='open') RETURNING 1)
     SELECT count(*)::int AS n FROM up`, [days]);
  return { posts: posts.n, comments: comments.n };
}
