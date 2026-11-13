// Social graph rules (issue #695): one place for who may reach, follow, befriend and see whom. Every rule is enforced here on the server;
// the app only calls the capabilities. Following reuses spectator_follows (athlete subjects) and blocking reuses user_blocks.
//
// Safeguards (all re-checked on every read, so a revoked guardian or a block takes effect at once):
//  - a young person is never discoverable, never suggested, and never has activity items for anyone but themselves;
//  - any follow or friendship with a young person needs an approval from a live guardian holding the 'social' scope;
//  - two young people never become friends or follow each other directly;
//  - an unknown, blocked or unreachable person is a 404, never a "forbidden" that would leak that they exist.
import { one, many } from './db.js';
import { badRequest, notFound, conflict, tooMany, forbidden } from './errors.js';
import { YOUTH_SQL, guardianLink, guardianCan, guardiansOf, isYouth } from './youth.js';
import { isBlocked, sharesContext, assertMayContact } from './inbox.js';
import { notify } from './notify.js';
import { audit } from './helpers.js';
import { spendAllowance } from './spectator.js';

export const FOLLOW_LIMIT = 500;
export const WRITES_PER_HOUR = 60;
export const VISIBILITIES = ['public', 'followers', 'friends', 'private'];
export const KINDS = ['result', 'streak', 'achievement', 'hosted_game', 'rating'];

const LIVE_LINK = `l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())`;
/** SQL: this user is an adult, or is young with a live guardian link that still holds the 'social' scope. */
export const socialLive = (col) => `(NOT EXISTS (SELECT 1 FROM users yu WHERE yu.id=${col} AND yu.youth_until IS NOT NULL AND yu.youth_until > current_date)
  OR EXISTS (SELECT 1 FROM guardian_links l WHERE l.child_id=${col} AND ${LIVE_LINK} AND 'social' = ANY(l.scopes)))`;

export const getSettings = async (userId) => ({
  default_item_visibility: 'followers', follow_mode: 'open', discoverable: true,
  ...((await one('SELECT default_item_visibility, follow_mode, discoverable FROM social_settings WHERE user_id=$1', [userId])) ?? {}),
});

/** Effective settings: a young person is always private, closed and undiscoverable whatever was stored. */
export async function effectiveSettings(userId) {
  const s = await getSettings(userId);
  return (await isYouth(userId)) ? { ...s, default_item_visibility: 'private', follow_mode: 'closed', discoverable: false, young: true } : s;
}

const personCols = 'u.id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color';

/**
 * The person `viewerId` is trying to reach, or a 404. Unknown, blocked (either way) and non-discoverable strangers are all the same 404.
 * A young person is reachable only by an adult who already shares a team, organisation, event or guardian link with them.
 */
export async function reach(viewerId, targetId, { forFollow = false } = {}) {
  if (viewerId === targetId) throw notFound('Person');
  const t = await one(`SELECT ${personCols}, (${YOUTH_SQL}) AS young FROM users u WHERE u.id=$1`, [targetId]);
  if (!t || (await isBlocked(viewerId, targetId))) throw notFound('Person');
  const st = await effectiveSettings(targetId);
  const known = (await sharesContext(viewerId, targetId)) || !!(await one(
    `SELECT 1 FROM friendships WHERE status IN ('accepted','pending','guardian_pending') AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))`, [viewerId, targetId]));
  if (t.young) { if (!known || (await isYouth(viewerId))) throw notFound('Person'); }
  else if (!st.discoverable && !known) throw notFound('Person');
  if (forFollow && st.follow_mode === 'closed' && !t.young) throw notFound('Person');
  return { ...t, settings: st };
}

const spend = async (c, userId, kind) => { if (!(await spendAllowance(c, userId, kind, WRITES_PER_HOUR))) throw tooMany('Slow down — try again in a little while'); };

async function tell(c, userId, kind, title, body, data, dedupe) {
  if (await isBlocked(userId, data.person_id)) return;
  await notify(c, userId, { kind, title, body, data, dedupe_key: dedupe });
}

async function writeFollow(c, followerId, targetId) {
  const row = (await c.query(
    `INSERT INTO spectator_follows(user_id, subject_type, subject_id, alerts) VALUES ($1,'athlete',$2,'{start,result,schedule}')
     ON CONFLICT (user_id, subject_type, subject_id) DO UPDATE SET removed_at=NULL, updated_at=now() RETURNING id, subject_type, subject_id, alerts, created_at`, [followerId, targetId])).rows[0];
  return row;
}

/**
 * Follow a person. Returns `{ status: 'active' | 'pending' | 'guardian_pending', ... }`.
 *  - young follower → waits for their guardian;  followed young person → waits for their guardian;
 *  - a person who approves followers → waits for them;  otherwise it is active at once.
 */
export async function followPerson(c, user, targetId) {
  const target = await reach(user.id, targetId, { forFollow: true });
  const existing = (await c.query('SELECT id, removed_at FROM spectator_follows WHERE user_id=$1 AND subject_type=\'athlete\' AND subject_id=$2 FOR UPDATE', [user.id, targetId])).rows[0];
  if (existing && !existing.removed_at) return { id: existing.id, subject_type: 'athlete', subject_id: targetId, status: 'active' };
  const open = (await c.query(`SELECT id, status FROM social_follow_requests WHERE follower_id=$1 AND target_id=$2 AND status IN ('guardian_pending','pending')`, [user.id, targetId])).rows[0];
  if (open) return { id: open.id, subject_type: 'athlete', subject_id: targetId, status: open.status };
  const n = (await c.query('SELECT count(*)::int AS n FROM spectator_follows WHERE user_id=$1 AND removed_at IS NULL', [user.id])).rows[0].n;
  if (n >= FOLLOW_LIMIT) throw conflict(`You can follow up to ${FOLLOW_LIMIT} people and things — unfollow one first`);
  await spend(c, user.id, 'follow');
  const followerYoung = await isYouth(user.id, c);
  const needsGuardian = followerYoung || target.young;
  const needsApproval = target.settings.follow_mode === 'approval';
  if (!needsGuardian && !needsApproval) {
    const f = await writeFollow(c, user.id, targetId);
    await audit(c, user.id, 'social_follow', 'users', targetId);
    await tell(c, targetId, 'follow_new', 'New follower', `${user.display_name} started following you`, { person_id: user.id, section: 'followers' }, `follow_new:${user.id}:${targetId}`);
    return { ...f, status: 'active' };
  }
  const status = needsGuardian ? 'guardian_pending' : 'pending';
  const r = (await c.query(`INSERT INTO social_follow_requests(follower_id, target_id, status) VALUES ($1,$2,$3) RETURNING id`, [user.id, targetId, status])).rows[0];
  await audit(c, user.id, 'social_follow_request', 'users', targetId);
  if (needsGuardian) {
    const child = followerYoung ? user.id : targetId;
    for (const g of await guardiansOf(child, c)) await tell(c, g, 'follow_request', 'Approval needed', `A follow involving ${followerYoung ? user.display_name : target.display_name} needs your approval`, { person_id: followerYoung ? targetId : user.id, request_id: r.id, section: 'requests' }, `follow_req:${r.id}:${g}`);
  } else {
    await tell(c, targetId, 'follow_request', 'Follow request', `${user.display_name} would like to follow you`, { person_id: user.id, request_id: r.id, section: 'requests' }, `follow_req:${r.id}`);
  }
  return { id: r.id, subject_type: 'athlete', subject_id: targetId, status };
}

/** Approve or decline a follow request: the guardian of a young side first, then the person followed when they approve followers. */
export async function decideFollowRequest(c, user, requestId, approve) {
  const r = (await c.query('SELECT * FROM social_follow_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
  if (!r || !['guardian_pending', 'pending'].includes(r.status)) throw notFound('Request');
  const followerYoung = await isYouth(r.follower_id, c), targetYoung = await isYouth(r.target_id, c);
  let guardianId = r.guardian_id;
  if (r.status === 'guardian_pending') {
    const child = followerYoung ? r.follower_id : r.target_id;
    const link = await guardianLink(user.id, child, c);
    if (!link) throw notFound('Request');
    if (!(await guardianCan(link, 'social', null, c))) throw forbidden('Your guardian authority for this young person does not cover social links');
    guardianId = user.id;
    if (!approve) { await c.query(`UPDATE social_follow_requests SET status='declined', guardian_id=$2, decided_by=$2, decided_at=now() WHERE id=$1`, [r.id, user.id]); await audit(c, user.id, 'social_guardian_decline', 'users', child); return { id: r.id, status: 'declined' }; }
    const t = await effectiveSettings(r.target_id);
    if (t.follow_mode === 'approval' && !targetYoung) {
      await c.query(`UPDATE social_follow_requests SET status='pending', guardian_id=$2 WHERE id=$1`, [r.id, user.id]);
      await audit(c, user.id, 'social_guardian_approve', 'users', child);
      await tell(c, r.target_id, 'follow_request', 'Follow request', 'Someone would like to follow you', { person_id: r.follower_id, request_id: r.id, section: 'requests' }, `follow_req:${r.id}`);
      return { id: r.id, status: 'pending' };
    }
    await audit(c, user.id, 'social_guardian_approve', 'users', child);
  } else if (user.id !== r.target_id) throw notFound('Request');
  if (!approve) { await c.query(`UPDATE social_follow_requests SET status='declined', decided_by=$2, decided_at=now() WHERE id=$1`, [r.id, user.id]); return { id: r.id, status: 'declined' }; }
  if (await isBlocked(r.follower_id, r.target_id)) throw notFound('Request');
  await writeFollow(c, r.follower_id, r.target_id);
  await c.query(`UPDATE social_follow_requests SET status='approved', guardian_id=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [r.id, guardianId, user.id]);
  await tell(c, r.target_id, 'follow_new', 'New follower', 'Someone started following you', { person_id: r.follower_id, section: 'followers' }, `follow_new:${r.follower_id}:${r.target_id}`);
  return { id: r.id, status: 'approved' };
}

/** Friend request. A young person needs their guardian's approval first; two young people can never be friends directly. */
export async function requestFriend(c, user, targetId) {
  const target = await reach(user.id, targetId);
  const meYoung = await isYouth(user.id, c);
  if (meYoung && target.young) throw notFound('Person');
  if (meYoung || target.young) await assertMayContact(user.id, targetId, c);
  const live = (await c.query(`SELECT id, status FROM friendships WHERE status IN ('guardian_pending','pending','accepted') AND LEAST(requester_id,addressee_id)=LEAST($1::uuid,$2::uuid) AND GREATEST(requester_id,addressee_id)=GREATEST($1::uuid,$2::uuid) FOR UPDATE`, [user.id, targetId])).rows[0];
  if (live) return { id: live.id, status: live.status };
  await spend(c, user.id, 'friend');
  const status = meYoung || target.young ? 'guardian_pending' : 'pending';
  const f = (await c.query(`INSERT INTO friendships(requester_id, addressee_id, status) VALUES ($1,$2,$3) RETURNING id, status`, [user.id, targetId, status])).rows[0];
  await audit(c, user.id, 'social_friend_request', 'users', targetId);
  if (status === 'pending') await tell(c, targetId, 'friend_request', 'Friend request', `${user.display_name} sent you a friend request`, { person_id: user.id, friendship_id: f.id, section: 'requests' }, `friend_req:${f.id}`);
  else for (const g of await guardiansOf(meYoung ? user.id : targetId, c)) await tell(c, g, 'follow_request', 'Approval needed', 'A friend request involving your child needs your approval', { person_id: meYoung ? targetId : user.id, friendship_id: f.id, section: 'requests' }, `friend_guardian:${f.id}:${g}`);
  return f;
}

export async function respondFriend(c, user, friendshipId, decision) {
  const f = (await c.query('SELECT * FROM friendships WHERE id=$1 FOR UPDATE', [friendshipId])).rows[0];
  if (!f) throw notFound('Friend request');
  if (decision === 'accept' || decision === 'decline') {
    if (f.status !== 'pending' || f.addressee_id !== user.id) throw notFound('Friend request');
    if (await isBlocked(f.requester_id, f.addressee_id)) throw notFound('Friend request');
    const status = decision === 'accept' ? 'accepted' : 'declined';
    await c.query('UPDATE friendships SET status=$2, decided_at=now() WHERE id=$1', [f.id, status]);
    if (status === 'accepted') await tell(c, f.requester_id, 'friend_accepted', 'Friend request accepted', `${user.display_name} accepted your friend request`, { person_id: user.id, section: 'friends' }, `friend_ok:${f.id}`);
    return { id: f.id, status };
  }
  if (f.status !== 'guardian_pending') throw notFound('Friend request');
  const child = (await isYouth(f.requester_id, c)) ? f.requester_id : f.addressee_id;
  const link = await guardianLink(user.id, child, c);
  if (!link) throw notFound('Friend request');
  if (!(await guardianCan(link, 'social', null, c))) throw forbidden('Your guardian authority for this young person does not cover social links');
  await audit(c, user.id, decision === 'guardian_approve' ? 'social_guardian_approve' : 'social_guardian_decline', 'users', child);
  if (decision === 'guardian_decline') { await c.query(`UPDATE friendships SET status='declined', guardian_id=$2, decided_at=now() WHERE id=$1`, [f.id, user.id]); return { id: f.id, status: 'declined' }; }
  await c.query(`UPDATE friendships SET status='pending', guardian_id=$2, guardian_approved_at=now() WHERE id=$1`, [f.id, user.id]);
  const other = f.requester_id === child ? f.addressee_id : f.requester_id;
  if (other === f.addressee_id) await tell(c, f.addressee_id, 'friend_request', 'Friend request', 'You have a new friend request', { person_id: f.requester_id, friendship_id: f.id, section: 'requests' }, `friend_req:${f.id}`);
  else await tell(c, child, 'friend_request', 'Friend request', 'You have a new friend request', { person_id: f.requester_id, friendship_id: f.id, section: 'requests' }, `friend_req:${f.id}`);
  return { id: f.id, status: 'pending' };
}

/** Blocking ends everything between two people: friendship and follows in both directions and open requests. Rows are kept as history. */
export async function severSocial(c, a, b) {
  await c.query(`UPDATE friendships SET status='ended', ended_at=now() WHERE status IN ('guardian_pending','pending','accepted') AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))`, [a, b]);
  await c.query(`UPDATE spectator_follows SET removed_at=now(), updated_at=now() WHERE subject_type='athlete' AND removed_at IS NULL AND ((user_id=$1 AND subject_id=$2) OR (user_id=$2 AND subject_id=$1))`, [a, b]);
  await c.query(`UPDATE social_follow_requests SET status='withdrawn', decided_at=now() WHERE status IN ('guardian_pending','pending') AND ((follower_id=$1 AND target_id=$2) OR (follower_id=$2 AND target_id=$1))`, [a, b]);
}

// ------------------------------------------------------------------------------------------------ the activity feed
/** People whose items the viewer may consider: followed or friends, not blocked either way, not muted, adults with live consent. */
async function relations(viewerId) {
  const follows = (await many(`SELECT subject_id AS id FROM spectator_follows WHERE user_id=$1 AND subject_type='athlete' AND removed_at IS NULL`, [viewerId])).map((r) => r.id);
  const friends = (await many(`SELECT CASE WHEN requester_id=$1 THEN addressee_id ELSE requester_id END AS id FROM friendships WHERE status='accepted' AND $1 IN (requester_id, addressee_id)`, [viewerId])).map((r) => r.id);
  return { follows, friends };
}

const WEEK = `date_trunc('week', coalesce(p.achieved_on, p.recorded_at::date))::date`;
const ITEMS = `
  SELECT 'result'::text AS kind, p.id::text AS source_id, p.user_id AS actor_id, s.slug AS sport, s.name AS sport_name,
         coalesce(p.achieved_on::timestamptz, p.recorded_at) AS at,
         jsonb_build_object('metric', p.metric, 'value', p.value::float8, 'unit', p.unit, 'event_id', p.event_id, 'event_name', e.name) AS data
    FROM performances p JOIN sports s ON s.id=p.sport_id LEFT JOIN events e ON e.id=p.event_id
   WHERE p.provenance='approved_competition' AND p.status='approved' AND p.user_id = ANY($1)
  UNION ALL
  SELECT 'achievement', a.id::text, a.user_id, NULL, NULL, a.awarded_at, jsonb_build_object('award', a.kind, 'name', a.name, 'event_id', a.event_id, 'event_name', e.name)
    FROM awards a LEFT JOIN events e ON e.id=a.event_id WHERE a.user_id = ANY($1)
  UNION ALL
  SELECT 'hosted_game', og.id::text, og.host_id, s.slug, s.name, og.created_at,
         jsonb_build_object('open_game_id', og.id, 'title', g.title, 'starts_at', g.starts_at, 'status', og.status)
    FROM open_games og JOIN games g ON g.id=og.game_id JOIN sports s ON s.id=g.sport_id
   WHERE og.host_id = ANY($1) AND og.visibility='public' AND og.audience <> 'youth' AND og.status IN ('open','completed') AND g.starts_at > now() - interval '60 days'
  UNION ALL
  SELECT 'rating', c.id::text, c.user_id, s.slug, s.name, c.played_at,
         jsonb_build_object('before', c.before_r::float8, 'after', c.after_r::float8, 'result', c.result)
    FROM skill_rating_changes c JOIN skill_ratings sr ON sr.user_id=c.user_id AND sr.sport_id=c.sport_id AND sr.run_id=c.run_id AND sr.status='active'
    JOIN sports s ON s.id=c.sport_id WHERE c.user_id = ANY($1)
  UNION ALL
  SELECT 'streak', z.actor::text || ':' || to_char(z.first_week, 'YYYY-MM-DD'), z.actor, NULL, NULL, (z.last_week + 6)::timestamptz, jsonb_build_object('weeks', z.n)
    FROM (SELECT user_id AS actor, min(wk) AS first_week, max(wk) AS last_week, count(*)::int AS n
            FROM (SELECT user_id, wk, wk - ((row_number() OVER (PARTITION BY user_id ORDER BY wk))::int * 7) AS grp
                    FROM (SELECT DISTINCT p.user_id, ${WEEK} AS wk FROM performances p WHERE p.provenance='approved_competition' AND p.status='approved' AND p.user_id = ANY($1)) w) g
           GROUP BY user_id, grp HAVING count(*) >= 3 AND max(wk) >= date_trunc('week', now())::date - 7) z`;

/**
 * The viewer's activity feed. `scope`: 'following' (people they follow and friends), 'mine' (their own items, with the visibility each one has).
 * Items are projected from canonical records, so there is nothing to post and nothing to fake.
 */
export async function activityFeed(viewer, { scope = 'following', sport, limit = 20, before } = {}) {
  const cursor = before ? String(before).split('|') : [];
  if (cursor[0] && Number.isNaN(Date.parse(cursor[0]))) throw badRequest('before must be an item cursor');
  let actors;
  const rel = await relations(viewer.id);
  if (scope === 'mine') actors = [viewer.id];
  else {
    if (await isYouth(viewer.id) && !(await one(`SELECT 1 FROM guardian_links l WHERE l.child_id=$1 AND ${LIVE_LINK} AND 'social' = ANY(l.scopes) LIMIT 1`, [viewer.id]))) return [];
    const ids = [...new Set([...rel.follows, ...rel.friends])];
    actors = ids.length ? (await many(
      `SELECT u.id FROM users u WHERE u.id = ANY($2) AND NOT (${YOUTH_SQL})
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.lifted_at IS NULL AND ((b.blocker_id=u.id AND b.blocked_id=$1) OR (b.blocker_id=$1 AND b.blocked_id=u.id)))
          AND NOT EXISTS (SELECT 1 FROM social_mutes m WHERE m.lifted_at IS NULL AND m.muter_id=$1 AND m.muted_id=u.id)`, [viewer.id, ids])).map((r) => r.id) : [];
  }
  if (!actors.length) return [];
  const rows = await many(
    `WITH items AS (${ITEMS})
     SELECT i.kind, i.source_id, i.actor_id, i.sport, i.sport_name, i.at, i.data,
            coalesce(s.visibility, st.default_item_visibility, 'followers') AS visibility, (s.hidden_at IS NOT NULL) AS hidden,
            ${personCols}
       FROM items i JOIN users u ON u.id=i.actor_id
       LEFT JOIN activity_item_settings s ON s.actor_id=i.actor_id AND s.kind=i.kind AND s.source_id=i.source_id
       LEFT JOIN social_settings st ON st.user_id=i.actor_id
      WHERE s.moderated_at IS NULL AND (s.hidden_at IS NULL OR $3 = 'mine')
        AND ($4::text IS NULL OR i.sport = $4)
        AND ($5::timestamptz IS NULL OR (i.at, i.source_id) < ($5::timestamptz, $8::text))
        AND ($3 = 'mine' OR (coalesce(s.visibility, st.default_item_visibility, 'followers') = 'public'
              OR (coalesce(s.visibility, st.default_item_visibility, 'followers') = 'followers' AND (i.actor_id = ANY($6) OR i.actor_id = ANY($7)))
              OR (coalesce(s.visibility, st.default_item_visibility, 'followers') = 'friends' AND i.actor_id = ANY($7))))
      ORDER BY i.at DESC, i.source_id DESC LIMIT $2`,
    [actors, limit, scope, sport ?? null, cursor[0] || null, rel.follows, rel.friends, cursor[1] ?? '']);
  return rows.map((r) => ({
    key: `${r.kind}:${r.source_id}`, kind: r.kind, source_id: r.source_id, at: r.at, sport: r.sport ? { slug: r.sport, name: r.sport_name } : null, data: r.data,
    visibility: r.visibility, actor: { id: r.id, handle: r.handle, display_name: r.display_name, avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color },
    ...(scope === 'mine' ? { hidden: r.hidden } : {}),
  }));
}

/**
 * One activity item of `userId`, projected from the canonical record (or null when it is not theirs, was reversed, or was removed by moderation).
 * Used to share an achievement into a community: only the person's own verified record can be shared, and it disappears when the record does.
 */
export async function activityItem(userId, kind, sourceId) {
  if (!KINDS.includes(kind)) return null;
  const r = await one(
    `WITH items AS (${ITEMS})
     SELECT i.kind, i.source_id, i.at, i.sport, i.sport_name, i.data
       FROM items i LEFT JOIN activity_item_settings s ON s.actor_id=i.actor_id AND s.kind=i.kind AND s.source_id=i.source_id
      WHERE i.kind=$2 AND i.source_id=$3 AND s.moderated_at IS NULL`, [[userId], kind, String(sourceId)]);
  return r ? { kind: r.kind, source_id: r.source_id, at: r.at, sport: r.sport ? { slug: r.sport, name: r.sport_name } : null, data: r.data } : null;
}

// Community Feed entity follow kinds — imported by feed-graph.js and feed-cards.js.
export const ENTITY_KINDS = ['team','academy','venue','event','coach','organisation'];
