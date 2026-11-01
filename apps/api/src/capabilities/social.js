// Social graph (issue #695): followers, friends, mutes, suggestions, privacy and the activity feed.
// Following reuses follow_subject (subject_type=athlete) and blocking reuses set_user_block; this file adds only what did not exist.
// Every rule lives in src/social.js and is enforced on the server; unknown or unreachable people are always a 404.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { conflict, notFound, tooMany } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { isYouth, YOUTH_SQL } from '../youth.js';
import { mustBePlatformAdmin } from '../platform.js';
import { isBlocked } from '../inbox.js';
import { spendAllowance } from '../spectator.js';
import { activityFeed, decideFollowRequest, effectiveSettings, getSettings, KINDS, reach, requestFriend, respondFriend, socialLive, VISIBILITIES, WRITES_PER_HOUR } from '../social.js';

const TAG = 'Social';
const person = 'u.id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color';
// rows that carry a request id: the person's id is `person_id`, so it never shadows the row's own id
const pcols = 'u.id AS person_id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color';
const visibility = z.enum(VISIBILITIES);

// ------------------------------------------------------------------------------------------------ privacy
cap({
  name: 'get_social_settings', method: 'GET', path: '/me/social-settings', tag: TAG,
  summary: 'Your social privacy: who may see your activity items by default (public, followers, friends, private; the safe default is followers), whether people can follow you freely, only with your approval, or not at all, and whether you appear in suggestions. A young person is always private, closed and undiscoverable whatever is stored.',
  async handler({ user }) { return effectiveSettings(user.id); },
});

cap({
  name: 'update_social_settings', method: 'PATCH', path: '/me/social-settings', tag: TAG,
  summary: 'Change your social privacy. A young person\'s settings cannot be loosened.',
  input: z.object({ default_item_visibility: visibility.optional(), follow_mode: z.enum(['open', 'approval', 'closed']).optional(), discoverable: z.boolean().optional() }),
  async handler({ user }, i) {
    if (await isYouth(user.id)) throw conflict('A young person\'s social settings are always private; a guardian manages social links');
    const cur = await getSettings(user.id);
    const n = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) };
    await one(`INSERT INTO social_settings(user_id, default_item_visibility, follow_mode, discoverable) VALUES ($1,$2,$3,$4)
               ON CONFLICT (user_id) DO UPDATE SET default_item_visibility=$2, follow_mode=$3, discoverable=$4, updated_at=now() RETURNING 1`, [user.id, n.default_item_visibility, n.follow_mode, n.discoverable]);
    return effectiveSettings(user.id);
  },
});

// ------------------------------------------------------------------------------------------------ people lists
cap({
  name: 'list_followers', method: 'GET', path: '/me/followers', tag: TAG,
  summary: 'The people who follow you (active follows only). Blocked people never appear; a young follower appears only while their guardian\'s approval is live.',
  input: z.object(page),
  async handler({ user }, i) {
    return many(
      `SELECT ${person}, (${YOUTH_SQL}) AS young, f.created_at AS since FROM spectator_follows f JOIN users u ON u.id=f.user_id
        WHERE f.subject_type='athlete' AND f.subject_id=$1 AND f.removed_at IS NULL AND ${socialLive('u.id')}
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.lifted_at IS NULL AND ((b.blocker_id=u.id AND b.blocked_id=$1) OR (b.blocker_id=$1 AND b.blocked_id=u.id)))
        ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'list_following', method: 'GET', path: '/me/following', tag: TAG,
  summary: 'The people you follow (active follows only), with whether you have muted them. For events, teams and games use list_my_follows.',
  input: z.object(page),
  async handler({ user }, i) {
    return many(
      `SELECT ${person}, (${YOUTH_SQL}) AS young, f.id AS follow_id, f.created_at AS since,
              EXISTS (SELECT 1 FROM social_mutes m WHERE m.muter_id=$1 AND m.muted_id=u.id AND m.lifted_at IS NULL) AS muted
         FROM spectator_follows f JOIN users u ON u.id=f.subject_id
        WHERE f.user_id=$1 AND f.subject_type='athlete' AND f.removed_at IS NULL AND ${socialLive('u.id')}
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.lifted_at IS NULL AND ((b.blocker_id=u.id AND b.blocked_id=$1) OR (b.blocker_id=$1 AND b.blocked_id=u.id)))
        ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'list_follow_requests', method: 'GET', path: '/me/follow-requests', tag: TAG,
  summary: 'Follow requests waiting on you: people who asked to follow you, and requests that need your approval as the guardian of a young person. Also the requests you sent that are still waiting.',
  async handler({ user }) {
    const incoming = await many(
      `SELECT r.id, r.status, r.created_at, ${pcols} FROM social_follow_requests r JOIN users u ON u.id=r.follower_id WHERE r.target_id=$1 AND r.status='pending'
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.lifted_at IS NULL AND ((b.blocker_id=u.id AND b.blocked_id=$1) OR (b.blocker_id=$1 AND b.blocked_id=u.id))) ORDER BY r.created_at DESC LIMIT 100`, [user.id]);
    const guardian = await many(
      `SELECT r.id, r.status, r.created_at, f.display_name AS follower_name, t.display_name AS target_name,
              CASE WHEN fy THEN f.id ELSE t.id END AS child_id
         FROM social_follow_requests r JOIN users f ON f.id=r.follower_id JOIN users t ON t.id=r.target_id
         CROSS JOIN LATERAL (SELECT (f.youth_until IS NOT NULL AND f.youth_until > current_date) AS fy) y
        WHERE r.status='guardian_pending' AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$1 AND l.child_id = CASE WHEN fy THEN f.id ELSE t.id END
              AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND 'social' = ANY(l.scopes)) ORDER BY r.created_at DESC LIMIT 100`, [user.id]);
    const sent = await many(`SELECT r.id, r.status, r.created_at, ${pcols} FROM social_follow_requests r JOIN users u ON u.id=r.target_id WHERE r.follower_id=$1 AND r.status IN ('pending','guardian_pending') ORDER BY r.created_at DESC LIMIT 100`, [user.id]);
    return { incoming, guardian, sent };
  },
});

cap({
  name: 'decide_follow_request', method: 'POST', path: '/me/follow-requests/:id', tag: TAG,
  summary: 'Approve or decline a follow request: as the person being followed, or as the verified guardian (with the social scope) of a young person on either side. Approval is re-checked live; revoking the guardian link ends the follow\'s visibility at once.',
  input: z.object({ id, approve: z.boolean() }),
  async handler({ user }, i) { return tx((c) => decideFollowRequest(c, user, i.id, i.approve)); },
});

// ------------------------------------------------------------------------------------------------ friends
cap({
  name: 'request_friend', method: 'POST', path: '/me/friends', tag: TAG, status: 201,
  summary: 'Send a friend request. A young person (or an adult befriending one) first needs an approval from a live guardian; two young people can never be friends directly. Unknown, blocked or unreachable people are a 404.',
  input: z.object({ user_id: id }),
  async handler({ user }, i) { return tx((c) => requestFriend(c, user, i.user_id)); },
});

cap({
  name: 'respond_friend', method: 'PATCH', path: '/me/friends/:id', tag: TAG,
  summary: 'Answer a friend request: accept or decline (the person asked), or guardian_approve / guardian_decline (the verified guardian of the young person involved).',
  input: z.object({ id, decision: z.enum(['accept', 'decline', 'guardian_approve', 'guardian_decline']) }),
  async handler({ user }, i) { return tx((c) => respondFriend(c, user, i.id, i.decision)); },
});

cap({
  name: 'end_friend', method: 'DELETE', path: '/me/friends/:id', tag: TAG,
  summary: 'End a friendship or withdraw a request you sent. The record is kept as history; nothing is deleted.',
  input: z.object({ id }),
  async handler({ user }, i) {
    if (!(await one(`UPDATE friendships SET status='ended', ended_at=now() WHERE id=$1 AND status IN ('guardian_pending','pending','accepted') AND $2 IN (requester_id, addressee_id) RETURNING id`, [i.id, user.id]))) throw notFound('Friendship');
    return { ok: true };
  },
});

cap({
  name: 'list_friends', method: 'GET', path: '/me/friends', tag: TAG,
  summary: 'Your friends and friend requests: `friends`, `incoming` (waiting on you), `outgoing` (waiting on them) and `guardian` (waiting on you as a guardian). Blocked people never appear.',
  async handler({ user }) {
    const rows = await many(
      `SELECT f.id, f.status, f.created_at, f.requester_id = $1 AS mine, ${pcols}, (${YOUTH_SQL}) AS young
         FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END
        WHERE f.status IN ('pending','accepted') AND $1 IN (f.requester_id, f.addressee_id) AND ${socialLive('u.id')}
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.lifted_at IS NULL AND ((b.blocker_id=u.id AND b.blocked_id=$1) OR (b.blocker_id=$1 AND b.blocked_id=u.id)))
        ORDER BY f.created_at DESC LIMIT 300`, [user.id]);
    const guardian = await many(
      `SELECT f.id, f.status, f.created_at, r.display_name AS requester_name, a.display_name AS addressee_name,
              CASE WHEN (r.youth_until IS NOT NULL AND r.youth_until > current_date) THEN r.id ELSE a.id END AS child_id
         FROM friendships f JOIN users r ON r.id=f.requester_id JOIN users a ON a.id=f.addressee_id
        WHERE f.status='guardian_pending' AND EXISTS (SELECT 1 FROM guardian_links l WHERE l.guardian_id=$1
              AND l.child_id = CASE WHEN (r.youth_until IS NOT NULL AND r.youth_until > current_date) THEN r.id ELSE a.id END
              AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND 'social' = ANY(l.scopes)) ORDER BY f.created_at DESC LIMIT 100`, [user.id]);
    return {
      friends: rows.filter((r) => r.status === 'accepted'),
      incoming: rows.filter((r) => r.status === 'pending' && !r.mine),
      outgoing: rows.filter((r) => r.status === 'pending' && r.mine),
      guardian,
    };
  },
});

// ------------------------------------------------------------------------------------------------ mute and the blocked list
cap({
  name: 'set_user_mute', method: 'PATCH', path: '/me/mutes/:user_id', tag: TAG,
  summary: 'Mute a person\'s items in your feed without telling them or changing the follow (and unmute again). To stop all contact use set_user_block.',
  input: z.object({ user_id: id, muted: z.boolean() }),
  async handler({ user }, i) {
    if (i.user_id === user.id || !(await one('SELECT 1 FROM users WHERE id=$1', [i.user_id])) || (await isBlocked(user.id, i.user_id))) throw notFound('Person');
    await one(`INSERT INTO social_mutes(muter_id, muted_id, lifted_at) VALUES ($1,$2, CASE WHEN $3 THEN NULL ELSE now() END)
               ON CONFLICT (muter_id, muted_id) DO UPDATE SET lifted_at = CASE WHEN $3 THEN NULL ELSE now() END RETURNING 1`, [user.id, i.user_id, i.muted]);
    return { ok: true, muted: i.muted };
  },
});

cap({
  name: 'list_blocked_and_muted', method: 'GET', path: '/me/blocked-muted', tag: TAG,
  summary: 'The people you have blocked or muted, so you can lift either.',
  async handler({ user }) {
    return {
      blocked: await many(`SELECT ${person} FROM user_blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=$1 AND b.lifted_at IS NULL ORDER BY b.created_at DESC LIMIT 300`, [user.id]),
      muted: await many(`SELECT ${person} FROM social_mutes m JOIN users u ON u.id=m.muted_id WHERE m.muter_id=$1 AND m.lifted_at IS NULL ORDER BY m.created_at DESC LIMIT 300`, [user.id]),
    };
  },
});

// ------------------------------------------------------------------------------------------------ suggestions
cap({
  name: 'get_social_suggestions', method: 'GET', path: '/me/social-suggestions', tag: TAG,
  summary: 'People you may know, from what you actually share: a team, an open game you both played, a venue you both favourite. Adults only, never a young person, never someone who is blocked, muted, already followed, a friend, pending or not discoverable. Each suggestion says why.',
  input: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
  async handler({ user }, i) {
    if (await isYouth(user.id)) return [];
    return many(
      `WITH shared AS (
         SELECT m2.user_id AS other, 'team' AS reason FROM team_members m1 JOIN team_members m2 ON m2.team_id=m1.team_id AND m2.user_id <> m1.user_id WHERE m1.user_id=$1 AND m1.status='active' AND m2.status='active'
         UNION ALL
         SELECT g2.user_id, 'game' FROM open_game_members g1 JOIN open_game_members g2 ON g2.open_game_id=g1.open_game_id AND g2.user_id <> g1.user_id WHERE g1.user_id=$1 AND g1.status='confirmed' AND g2.status='confirmed'
         UNION ALL
         SELECT v2.user_id, 'venue' FROM favourite_venues v1 JOIN favourite_venues v2 ON v2.venue_id=v1.venue_id AND v2.user_id <> v1.user_id WHERE v1.user_id=$1 AND v1.removed_at IS NULL AND v2.removed_at IS NULL)
       SELECT ${person}, array_agg(DISTINCT s.reason ORDER BY s.reason) AS reasons, count(*)::int AS score
         FROM shared s JOIN users u ON u.id=s.other LEFT JOIN social_settings st ON st.user_id=u.id
        WHERE NOT (${YOUTH_SQL}) AND coalesce(st.discoverable, true) AND coalesce(st.follow_mode, 'open') <> 'closed'
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.lifted_at IS NULL AND ((b.blocker_id=u.id AND b.blocked_id=$1) OR (b.blocker_id=$1 AND b.blocked_id=u.id)))
          AND NOT EXISTS (SELECT 1 FROM social_mutes m WHERE m.lifted_at IS NULL AND m.muter_id=$1 AND m.muted_id=u.id)
          AND NOT EXISTS (SELECT 1 FROM spectator_follows f WHERE f.user_id=$1 AND f.subject_type='athlete' AND f.subject_id=u.id AND f.removed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM social_follow_requests r WHERE r.follower_id=$1 AND r.target_id=u.id AND r.status IN ('guardian_pending','pending'))
          AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.status IN ('guardian_pending','pending','accepted') AND ((f.requester_id=$1 AND f.addressee_id=u.id) OR (f.requester_id=u.id AND f.addressee_id=$1)))
        GROUP BY u.id ORDER BY score DESC, u.display_name LIMIT $2`, [user.id, i.limit]);
  },
});

// ------------------------------------------------------------------------------------------------ the activity feed
cap({
  name: 'get_activity_feed', method: 'GET', path: '/me/activity-feed', tag: TAG,
  summary: 'The activity of the people you follow and your friends, built only from verified records: approved competition results, awards, weekly streaks (3+ weeks), public open games they host and their verified rating moves, in every sport. Each item carries its visibility; items a person made private, hid or that were removed by moderation never appear, and a young person never appears. scope=mine lists your own items with the visibility each has.',
  input: z.object({ scope: z.enum(['following', 'mine']).default('following'), sport: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), before: z.string().max(200).optional().describe('cursor: the `at` and `source_id` of the last item, joined with |') }),
  async handler({ user }, i) { return activityFeed(user, i); },
});

cap({
  name: 'set_activity_visibility', method: 'PATCH', path: '/me/activity/:kind/:source_id', tag: TAG,
  summary: 'Choose who may see one of your own activity items (public, followers, friends, private) or hide it. Only items that are really yours can be set; anything else is a 404.',
  input: z.object({ kind: z.enum(KINDS), source_id: z.string().min(1).max(120), visibility: visibility.optional(), hidden: z.boolean().optional() }),
  async handler({ user }, i) {
    if (await isYouth(user.id)) throw conflict('A young person\'s items are always private');
    if (!(await ownsItem(user.id, i.kind, i.source_id))) throw notFound('Item');
    await one(`INSERT INTO activity_item_settings(actor_id, kind, source_id, visibility, hidden_at) VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN now() END)
               ON CONFLICT (actor_id, kind, source_id) DO UPDATE SET visibility=coalesce($4, activity_item_settings.visibility), hidden_at = CASE WHEN $5::boolean IS NULL THEN activity_item_settings.hidden_at WHEN $5 THEN coalesce(activity_item_settings.hidden_at, now()) END, updated_at=now() RETURNING 1`,
      [user.id, i.kind, i.source_id, i.visibility ?? null, i.hidden ?? null]);
    return { ok: true };
  },
});

/** Does this derived item belong to this person (checked against the canonical record, not the feed page)? */
async function ownsItem(userId, kind, sourceId) {
  const q = {
    result: ["SELECT 1 FROM performances WHERE id::text=$2 AND user_id=$1 AND provenance='approved_competition' AND status='approved'"],
    achievement: ['SELECT 1 FROM awards WHERE id::text=$2 AND user_id=$1'],
    hosted_game: ["SELECT 1 FROM open_games WHERE id::text=$2 AND host_id=$1 AND visibility='public' AND audience <> 'youth'"],
    rating: ['SELECT 1 FROM skill_rating_changes WHERE id::text=$2 AND user_id=$1'],
    streak: ['SELECT 1 WHERE $2 LIKE $1::text || \':%\''],
  }[kind];
  return !!(await one(q[0], [userId, sourceId]));
}

// ------------------------------------------------------------------------------------------------ reports and moderation
cap({
  name: 'report_social', method: 'POST', path: '/social/reports', tag: TAG, status: 201,
  summary: 'Report a person or one of their activity items (harassment, unsafe contact, impersonation, spam, privacy, inaccurate). The note is encrypted and one report per target counts. Reporting a person you can not see is a 404.',
  input: z.object({ target_type: z.enum(['user', 'activity']), target_id: z.string().min(1).max(160), reason: z.enum(['harassment', 'unsafe_contact', 'impersonation', 'spam', 'privacy', 'inaccurate', 'other']), note: z.string().max(1000).optional() }),
  async handler({ user }, i) {
    let actorId = i.target_id;
    if (i.target_type === 'activity') {
      const [kind, ...rest] = i.target_id.split(':'), sourceId = rest.join(':');
      const f = (await activityFeed(user, { scope: 'following', limit: 50 })).find((x) => x.kind === kind && x.source_id === sourceId);
      if (!f) throw notFound('Item');
      actorId = f.actor.id;
    } else {
      if (!/^[0-9a-f-]{36}$/i.test(i.target_id)) throw notFound('Person');
      await reach(user.id, i.target_id);
    }
    return tx(async (c) => {
      if (!(await spendAllowance(c, user.id, 'report', WRITES_PER_HOUR))) throw tooMany('Slow down — try again in a little while');
      const r = (await c.query(
        `INSERT INTO social_reports(reporter_id, target_type, target_id, actor_id, reason, note_enc) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (reporter_id, target_type, target_id) DO UPDATE SET reason=$5, note_enc=coalesce($6, social_reports.note_enc) RETURNING id, status`,
        [user.id, i.target_type, i.target_id, actorId, i.reason, i.note ? encrypt(i.note, 'social_reports.note') : null])).rows[0];
      await audit(c, user.id, 'social_report', 'users', actorId);
      return r;
    });
  },
});

cap({
  name: 'list_social_reports', method: 'GET', path: '/social/reports', tag: TAG, auth: 'user',
  summary: 'Platform admin only: open social reports, oldest first (without the encrypted notes).',
  input: z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open'), ...page }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    await audit(null, user.id, 'read_social_reports', 'social_reports', null);
    return many(`SELECT r.id, r.target_type, r.target_id, r.actor_id, r.reason, r.status, r.created_at, a.display_name AS actor_name FROM social_reports r LEFT JOIN users a ON a.id=r.actor_id WHERE r.status=$1 ORDER BY r.created_at LIMIT $2 OFFSET $3`, [i.status, i.limit, i.offset]);
  },
});

cap({
  name: 'decide_social_report', method: 'PATCH', path: '/social/reports/:id', tag: TAG,
  summary: 'Platform admin only: action or dismiss a report. Actioning a report about an activity item hides that item from everyone (the person cannot lift a moderation hide); nothing is deleted.',
  input: z.object({ id, action: z.enum(['actioned', 'dismissed']) }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    return tx(async (c) => {
      const r = (await c.query(`UPDATE social_reports SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='open' RETURNING *`, [i.id, i.action, user.id])).rows[0];
      if (!r) throw notFound('Report');
      if (i.action === 'actioned' && r.target_type === 'activity') {
        const [kind, ...rest] = r.target_id.split(':');
        if (KINDS.includes(kind) && r.actor_id) await c.query(
          `INSERT INTO activity_item_settings(actor_id, kind, source_id, moderated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (actor_id, kind, source_id) DO UPDATE SET moderated_at=now(), updated_at=now()`, [r.actor_id, kind, rest.join(':')]);
      }
      await audit(c, user.id, 'decide_social_report', 'social_reports', r.id);
      return { id: r.id, status: r.status };
    });
  },
});
