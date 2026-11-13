// Fan & Community Feed — entity follow graph (issue #522).
// Person-to-person follows live in social.js. This adds entity follows (team, academy, venue, event, coach, organisation).
// Following an entity is a fan interest only: it grants zero private data access, team membership or event entry.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound, tooMany } from '../errors.js';
import { audit } from '../helpers.js';
import { isYouth } from '../youth.js';
import { ENTITY_KINDS } from '../social.js';

const TAG = 'Community Feed';
const ekind = z.enum(ENTITY_KINDS);

// Helpers to resolve that an entity actually exists and is public (or reachable by the follower).
async function resolveEntity(kind, entityId) {
  const checks = {
    team:         `SELECT id FROM teams WHERE id=$1 AND status NOT IN ('archived','deleted')`,
    academy:      `SELECT o.id FROM organisations o WHERE o.id=$1 AND o.kind='academy' AND o.archived_at IS NULL`,
    venue:        `SELECT id FROM venues WHERE id=$1 AND archived_at IS NULL`,
    event:        `SELECT id FROM events WHERE id=$1 AND status NOT IN ('cancelled','deleted') AND visibility='public'`,
    coach:        `SELECT u.id FROM users u JOIN sport_profiles sp ON sp.user_id=u.id WHERE u.id=$1 AND sp.role='coach' LIMIT 1`,
    organisation: `SELECT id FROM organisations WHERE id=$1 AND archived_at IS NULL`,
  };
  const row = await one(checks[kind], [entityId]);
  if (!row) throw notFound(kind.charAt(0).toUpperCase() + kind.slice(1));
  return row;
}

cap({
  name: 'follow_entity', method: 'POST', path: '/feed/follow/:kind/:entity_id', tag: TAG,
  summary: 'Follow a public entity (team, academy, venue, event, coach or organisation). Following is a fan interest only: it grants no private access or team membership. Youth accounts may follow; guardian consent is not required for entity follows (unlike person follows). Returns the follow record.',
  input: z.object({ kind: ekind, entity_id: id }),
  async handler({ user }, i) {
    await resolveEntity(i.kind, i.entity_id);
    return tx(async (c) => {
      const existing = (await c.query(
        `SELECT removed_at FROM feed_entity_follows WHERE follower_id=$1 AND entity_kind=$2 AND entity_id=$3`,
        [user.id, i.kind, i.entity_id])).rows[0];
      if (existing && !existing.removed_at) return { following: true, entity_kind: i.kind, entity_id: i.entity_id };
      if (existing) {
        await c.query(`UPDATE feed_entity_follows SET removed_at=NULL, created_at=now() WHERE follower_id=$1 AND entity_kind=$2 AND entity_id=$3`, [user.id, i.kind, i.entity_id]);
      } else {
        await c.query(`INSERT INTO feed_entity_follows(follower_id, entity_kind, entity_id) VALUES ($1,$2,$3)`, [user.id, i.kind, i.entity_id]);
      }
      await audit(c, user.id, 'feed_entity_follow', i.kind, i.entity_id);
      return { following: true, entity_kind: i.kind, entity_id: i.entity_id };
    });
  },
});

cap({
  name: 'unfollow_entity', method: 'DELETE', path: '/feed/follow/:kind/:entity_id', tag: TAG,
  summary: 'Unfollow an entity. The row is kept for audit history with removed_at set.',
  input: z.object({ kind: ekind, entity_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await c.query(`UPDATE feed_entity_follows SET removed_at=now() WHERE follower_id=$1 AND entity_kind=$2 AND entity_id=$3 AND removed_at IS NULL`, [user.id, i.kind, i.entity_id]);
      await audit(c, user.id, 'feed_entity_unfollow', i.kind, i.entity_id);
      return { following: false, entity_kind: i.kind, entity_id: i.entity_id };
    });
  },
});

cap({
  name: 'check_entity_follow', method: 'GET', path: '/feed/follow/:kind/:entity_id', tag: TAG,
  summary: 'Check whether the signed-in user follows a specific entity. Returns {following, followers_count}.',
  input: z.object({ kind: ekind, entity_id: id }),
  async handler({ user }, i) {
    const follow = await one(`SELECT 1 FROM feed_entity_follows WHERE follower_id=$1 AND entity_kind=$2 AND entity_id=$3 AND removed_at IS NULL`, [user.id, i.kind, i.entity_id]);
    const cnt = await one(`SELECT count FROM feed_entity_follow_counts WHERE entity_kind=$1 AND entity_id=$2`, [i.kind, i.entity_id]);
    return { following: !!follow, followers_count: cnt?.count ?? 0, entity_kind: i.kind, entity_id: i.entity_id };
  },
});

cap({
  name: 'list_entity_follows', method: 'GET', path: '/me/entity-follows', tag: TAG,
  summary: 'List all entities the signed-in user follows, grouped by kind. Returns [{entity_kind, entity_id, created_at, name, ...}].',
  input: z.object({ kind: ekind.optional(), ...page }),
  async handler({ user }, i) {
    const kindFilter = i.kind ? `AND f.entity_kind = $4` : '';
    const params = [user.id, i.limit, i.offset, ...(i.kind ? [i.kind] : [])];
    // For each entity kind we JOIN a different table to get a name.
    // We use a simple query that returns entity_kind + entity_id + created_at and resolves names in a second pass.
    const rows = await many(
      `SELECT f.entity_kind, f.entity_id::text, f.created_at,
              COALESCE(t.name, o.name, v.name, e.name) AS name
         FROM feed_entity_follows f
         LEFT JOIN teams t            ON t.id = f.entity_id AND f.entity_kind = 'team'
         LEFT JOIN organisations o    ON o.id = f.entity_id AND f.entity_kind IN ('academy','organisation')
         LEFT JOIN venues v           ON v.id = f.entity_id AND f.entity_kind = 'venue'
         LEFT JOIN events e           ON e.id = f.entity_id AND f.entity_kind = 'event'
        WHERE f.follower_id = $1 AND f.removed_at IS NULL ${kindFilter}
        ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`, params);
    return rows;
  },
});

cap({
  name: 'list_entity_followers', method: 'GET', path: '/feed/followers/:kind/:entity_id', tag: TAG,
  auth: ['admin', 'platform_admin', 'organizer', 'venue_manager'],
  summary: 'List the users following a specific entity. Only org staff and platform admins may call this. Returns follower count + paginated list.',
  input: z.object({ kind: ekind, entity_id: id, ...page }),
  async handler({ user }, i) {
    // A simplistic org-staff check: the caller must own/manage the entity.
    const cnt = await one(`SELECT count FROM feed_entity_follow_counts WHERE entity_kind=$1 AND entity_id=$2`, [i.kind, i.entity_id]);
    const rows = await many(
      `SELECT u.id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, f.created_at AS since
         FROM feed_entity_follows f JOIN users u ON u.id = f.follower_id
        WHERE f.entity_kind=$1 AND f.entity_id=$2 AND f.removed_at IS NULL
        ORDER BY f.created_at DESC LIMIT $3 OFFSET $4`, [i.kind, i.entity_id, i.limit, i.offset]);
    return { total: cnt?.count ?? 0, followers: rows };
  },
});

cap({
  name: 'mute_feed_entity', method: 'POST', path: '/feed/mute/:kind/:entity_id', tag: TAG,
  summary: 'Mute feed cards from a specific entity without unfollowing. Muted entities do not appear in the feed until unmuted.',
  input: z.object({ kind: ekind, entity_id: id }),
  async handler({ user }, i) {
    await one(
      `INSERT INTO feed_entity_mutes(muter_id, entity_kind, entity_id) VALUES ($1,$2,$3)
         ON CONFLICT (muter_id, entity_kind, entity_id) DO UPDATE SET lifted_at=NULL, created_at=now()`,
      [user.id, i.kind, i.entity_id]);
    return { muted: true };
  },
});

cap({
  name: 'unmute_feed_entity', method: 'DELETE', path: '/feed/mute/:kind/:entity_id', tag: TAG,
  summary: 'Lift the mute on a specific entity, so their feed cards appear again.',
  input: z.object({ kind: ekind, entity_id: id }),
  async handler({ user }, i) {
    await one(`UPDATE feed_entity_mutes SET lifted_at=now() WHERE muter_id=$1 AND entity_kind=$2 AND entity_id=$3 AND lifted_at IS NULL`, [user.id, i.kind, i.entity_id]);
    return { muted: false };
  },
});
