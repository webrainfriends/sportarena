// Communities (issue #66): local and sport communities with owner / moderator roles, invitations, public / private / hidden visibility,
// posts, achievement shares and cursor-paginated feeds. Posts and comments live in the existing market_posts / market_comments tables
// (community_id), so reactions, comments and media are the same ones the member feed already uses. All rules are in src/communities.js.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { isYouth } from '../youth.js';
import { notify } from '../notify.js';
import { reach, activityItem, KINDS } from '../social.js';
import { marketMediaUrl } from '../market-media.js';
import { CURSOR_TS, LIMITS, POST_CTX, blockedBetween, communityFor, cursorOf, loadCommunity, membership, mutedBy, parseCursor, slugify, spend } from '../communities.js';

const TAG = 'Communities';
const ref = z.string().min(2).max(80).describe('community id or slug');
const limit = z.coerce.number().int().min(1).max(50).default(20);
const before = z.string().max(100).optional().describe('cursor: the `next` value of the previous page');
const personCols = 'u.id, u.handle, u.display_name, u.avatar_emoji, u.avatar_color, u.avatar_url';

const card = (c, extra = {}) => ({
  id: c.id, slug: c.slug, name: c.name, description: c.description, city: c.city, sport: c.sport_slug ? { slug: c.sport_slug, name: c.sport_name, emoji: c.sport_emoji } : null,
  visibility: c.visibility, join_mode: c.join_mode, audience: c.audience, members: c.members ?? undefined, created_at: c.created_at, ...extra,
});
const CARD_SQL = `c.*, s.slug AS sport_slug, s.name AS sport_name, s.emoji AS sport_emoji,
  (SELECT count(*)::int FROM community_members m WHERE m.community_id=c.id AND m.status='active') AS members,
  ${CURSOR_TS('c.created_at')} AS created_at_cursor`;
const cardFrom = 'FROM communities c LEFT JOIN sports s ON s.id=c.sport_id';

async function sportId(v) {
  if (!v) return null;
  const s = await sportBySlugOrId(v);
  if (!s) throw notFound('Sport');
  return s.id;
}
const tell = (c, userId, kind, title, body, data, dedupe) => notify(c, userId, { kind, title, body, data, dedupe_key: dedupe ?? null });

const shapeRules = (i) => {
  if (i.visibility === 'hidden' && i.join_mode !== 'invite') throw badRequest('A hidden community is by invitation only');
  if (i.audience === 'all' && (i.visibility === 'public' || i.join_mode === 'open')) throw badRequest('A community that admits young people must be private or hidden and by invitation or approval');
};

// ------------------------------------------------------------------------------------------------ communities
cap({
  name: 'create_community', method: 'POST', path: '/communities', tag: TAG, status: 201,
  summary: 'Start a community around a sport or a place. Choose who can see it (public, private or hidden) and how people join (open, by request, or by invitation). You become its owner. Communities admit adults only unless you choose audience=all, which lets guardian-approved young people join by invitation. Young people cannot start communities.',
  input: z.object({
    name: z.string().min(3).max(80), slug: z.string().min(3).max(60).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/).optional(), description: z.string().max(600).optional(),
    sport: z.string().max(60).optional(), city: z.string().max(80).optional(),
    visibility: z.enum(['public', 'private', 'hidden']).default('public'), join_mode: z.enum(['open', 'request', 'invite']).default('open'), audience: z.enum(['adults', 'all']).default('adults'),
  }),
  async handler({ user }, i) {
    if (await isYouth(user.id)) throw forbidden('Young people cannot start communities');
    shapeRules(i);
    const sport = await sportId(i.sport);
    const slug = i.slug ?? slugify(i.name);
    if (slug.length < 3) throw badRequest('Choose a name with letters or numbers');
    return tx(async (c) => {
      await spend(c, user.id, 'community_create', 10);
      const owned = (await c.query("SELECT count(*)::int AS n FROM communities WHERE owner_id=$1 AND archived_at IS NULL", [user.id])).rows[0].n;
      if (owned >= LIMITS.communitiesOwned) throw conflict('You already run the maximum number of communities');
      const row = (await c.query(
        `INSERT INTO communities(slug, name, description, sport_id, city, visibility, join_mode, audience, owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING RETURNING id, slug`, [slug, i.name, i.description ?? null, sport, i.city ?? null, i.visibility, i.join_mode, i.audience, user.id])).rows[0];
      if (!row) throw conflict('That address is taken — choose another name or address');
      await c.query("INSERT INTO community_members(community_id, user_id, role, status) VALUES ($1,$2,'owner','active')", [row.id, user.id]);
      await audit(c, user.id, 'create_community', 'communities', row.id);
      return row;
    });
  },
});

cap({
  name: 'list_communities', method: 'GET', path: '/communities', tag: TAG,
  summary: 'Find communities (newest first, cursor-paged). scope=discover lists public and private communities you are not blocked from; scope=mine lists the ones you belong to. Hidden communities appear only to their members and invitees. Private communities show their card but never their content.',
  input: z.object({ scope: z.enum(['discover', 'mine']).default('discover'), q: z.string().max(80).optional(), sport: z.string().max(60).optional(), city: z.string().max(80).optional(), limit, before }),
  async handler({ user }, i) {
    const [ts, cid] = parseCursor(i.before);
    if (ts === undefined) throw badRequest('before must be a cursor from a previous page');
    const sport = i.sport ? await sportId(i.sport) : null;
    const rows = await many(
      `SELECT ${CARD_SQL}, mm.role AS my_role, mm.status AS my_status,
              EXISTS (SELECT 1 FROM community_invitations v WHERE v.community_id=c.id AND v.invitee_id=$1 AND v.status='pending') AS invited
         ${cardFrom}
         LEFT JOIN community_members mm ON mm.community_id=c.id AND mm.user_id=$1 AND mm.status IN ('active','pending')
        WHERE c.archived_at IS NULL
          AND (($2 = 'mine' AND mm.status = 'active')
            OR ($2 = 'discover' AND (c.visibility IN ('public','private') OR mm.status='active' OR EXISTS (SELECT 1 FROM community_invitations v WHERE v.community_id=c.id AND v.invitee_id=$1 AND v.status='pending'))))
          AND (mm.status = 'active' OR NOT ${blockedBetween('c.owner_id', '$1')})
          AND (mm.status = 'active' OR c.audience = 'all' OR NOT EXISTS (SELECT 1 FROM users yu WHERE yu.id=$1 AND yu.youth_until IS NOT NULL AND yu.youth_until > current_date))
          AND ($3::text IS NULL OR c.name ILIKE '%'||$3||'%' OR c.description ILIKE '%'||$3||'%')
          AND ($4::uuid IS NULL OR c.sport_id=$4) AND ($5::text IS NULL OR c.city ILIKE $5)
          AND ($6::timestamptz IS NULL OR (c.created_at, c.id) < ($6::timestamptz, $7::uuid))
        ORDER BY c.created_at DESC, c.id DESC LIMIT $8`,
      [user.id, i.scope, i.q ?? null, sport, i.city ?? null, ts, cid, i.limit + 1]);
    const page = rows.slice(0, i.limit);
    return { items: page.map((c) => card(c, { my_role: c.my_status === 'active' ? c.my_role : null, my_status: c.my_status ?? null, invited: c.invited })), next: rows.length > i.limit ? cursorOf(page.at(-1)) : null };
  },
});

cap({
  name: 'get_community', method: 'GET', path: '/communities/:ref', tag: TAG,
  summary: 'One community: its card, your role and what you may do. A hidden community is a 404 unless you belong to it or were invited.',
  input: z.object({ ref }),
  async handler({ user }, i) {
    const { community, m, invited } = await communityFor(user, i.ref);
    const full = await one(`SELECT ${CARD_SQL} ${cardFrom} WHERE c.id=$1`, [community.id]);
    const pending = !m && !!(await one("SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2 AND status='pending'", [community.id, user.id]));
    const staff = m?.role === 'owner' || m?.role === 'moderator';
    const canRead = !!m || community.visibility === 'public';
    return card(full, { my_role: m?.role ?? null, my_status: m ? 'active' : pending ? 'pending' : null, invited, can: { read: canRead, post: !!m && !m.silenced, manage: staff, own: m?.role === 'owner', join: !m && !pending && community.join_mode !== 'invite' } });
  },
});

cap({
  name: 'update_community', method: 'PATCH', path: '/communities/:ref', tag: TAG,
  summary: 'Owner only: change the name, description, place, sport, visibility or how people join. The audience (adults / all) is fixed when the community is created.',
  input: z.object({ ref, name: z.string().min(3).max(80).optional(), description: z.string().max(600).nullable().optional(), sport: z.string().max(60).nullable().optional(), city: z.string().max(80).nullable().optional(),
    visibility: z.enum(['public', 'private', 'hidden']).optional(), join_mode: z.enum(['open', 'request', 'invite']).optional() }),
  async handler({ user }, i) {
    const { community } = await communityFor(user, i.ref, { need: 'owner' });
    const next = { visibility: i.visibility ?? community.visibility, join_mode: i.join_mode ?? community.join_mode, audience: community.audience };
    shapeRules(next);
    const sport = i.sport === undefined ? undefined : i.sport === null ? null : await sportId(i.sport);
    return tx(async (c) => {
      const r = (await c.query(
        `UPDATE communities SET name=coalesce($2,name), description=CASE WHEN $3::boolean THEN $4 ELSE description END, city=CASE WHEN $5::boolean THEN $6 ELSE city END,
                sport_id=CASE WHEN $7::boolean THEN $8::uuid ELSE sport_id END, visibility=$9, join_mode=$10 WHERE id=$1 RETURNING id, slug, name, visibility, join_mode`,
        [community.id, i.name ?? null, i.description !== undefined, i.description ?? null, i.city !== undefined, i.city ?? null, sport !== undefined, sport ?? null, next.visibility, next.join_mode])).rows[0];
      await audit(c, user.id, 'update_community', 'communities', community.id);
      return r;
    });
  },
});

cap({
  name: 'archive_community', method: 'POST', path: '/communities/:ref/archive', tag: TAG,
  summary: 'Owner only: close a community. It disappears for everyone; its posts and members are kept, nothing is deleted.',
  input: z.object({ ref }),
  async handler({ user }, i) {
    const { community } = await communityFor(user, i.ref, { need: 'owner' });
    await tx(async (c) => { await c.query('UPDATE communities SET archived_at=now() WHERE id=$1', [community.id]); await audit(c, user.id, 'archive_community', 'communities', community.id); });
    return { ok: true };
  },
});

// ------------------------------------------------------------------------------------------------ membership
const staffIds = async (c, communityId) => (await c.query("SELECT user_id FROM community_members WHERE community_id=$1 AND status='active' AND role IN ('owner','moderator')", [communityId])).rows.map((r) => r.user_id);

cap({
  name: 'join_community', method: 'POST', path: '/communities/:ref/join', tag: TAG, status: 201,
  summary: 'Join an open community at once, or ask to join one that approves requests (the owner and moderators are told). Communities by invitation cannot be joined — accept your invitation instead. Joining again is harmless. Young people join only by invitation.',
  input: z.object({ ref }),
  async handler({ user }, i) {
    const { community, m } = await communityFor(user, i.ref);
    if (m) return { status: 'active', role: m.role };
    if (community.visibility === 'hidden' || community.join_mode === 'invite') throw conflict('This community is by invitation only', { code: 'invite_only' });
    if (await isYouth(user.id)) throw forbidden('Young people join a community when a guardian-approved invitation is accepted');
    return tx(async (c) => {
      await spend(c, user.id, 'community_join', LIMITS.joinsPerHour);
      const prev = (await c.query('SELECT status FROM community_members WHERE community_id=$1 AND user_id=$2 FOR UPDATE', [community.id, user.id])).rows[0];
      if (prev?.status === 'removed') throw notFound('Community');          // removed by a moderator: only a moderator can bring them back
      const status = community.join_mode === 'open' ? 'active' : 'pending';
      if (prev?.status === 'pending') return { status: 'pending' };
      await c.query(
        `INSERT INTO community_members(community_id, user_id, role, status) VALUES ($1,$2,'member',$3)
         ON CONFLICT (community_id, user_id) DO UPDATE SET status=$3, left_at=NULL, joined_at=now(), role='member'`, [community.id, user.id, status]);
      if (status === 'pending') for (const s of await staffIds(c, community.id)) await tell(c, s, 'community_request', 'Request to join', `${user.display_name} asked to join ${community.name}`, { community_id: community.id, person_id: user.id }, `community_request:${community.id}:${user.id}`);
      return { status };
    });
  },
});

cap({
  name: 'leave_community', method: 'POST', path: '/communities/:ref/leave', tag: TAG,
  summary: 'Leave a community, or withdraw a request to join. The owner cannot leave — archive the community instead. Your earlier posts stay.',
  input: z.object({ ref }),
  async handler({ user }, i) {
    const community = await loadCommunity(i.ref);
    if (!community) throw notFound('Community');
    if (community.owner_id === user.id) throw conflict('Owners cannot leave — archive the community instead');
    const r = await one("UPDATE community_members SET status='left', left_at=now() WHERE community_id=$1 AND user_id=$2 AND status IN ('active','pending') RETURNING 1", [community.id, user.id]);
    if (!r) throw notFound('Community');
    return { ok: true };
  },
});

cap({
  name: 'list_community_members', method: 'GET', path: '/communities/:ref/members', tag: TAG,
  summary: 'Members of a community you may read (people who blocked you or whom you blocked are left out). Young members are shown to the owner and moderators only. status=pending lists join requests, for the owner and moderators.',
  input: z.object({ ref, status: z.enum(['active', 'pending']).default('active'), limit, before }),
  async handler({ user }, i) {
    const { community, m } = await communityFor(user, i.ref, { need: i.status === 'pending' ? 'manage' : 'read' });
    const staff = m?.role === 'owner' || m?.role === 'moderator';
    const [ts, uid] = parseCursor(i.before);
    if (ts === undefined) throw badRequest('before must be a cursor from a previous page');
    const rows = await many(
      `SELECT ${personCols}, cm.role, cm.status, cm.joined_at, ${CURSOR_TS('cm.joined_at')} AS created_at_cursor, (cm.muted_until IS NOT NULL AND cm.muted_until > now()) AS silenced
         FROM community_members cm JOIN users u ON u.id=cm.user_id
        WHERE cm.community_id=$1 AND cm.status=$2 AND ($3::boolean OR NOT (u.youth_until IS NOT NULL AND u.youth_until > current_date))
          AND (cm.user_id=$4 OR NOT ${blockedBetween('cm.user_id', '$4')})
          AND ($5::timestamptz IS NULL OR (cm.joined_at, cm.user_id) < ($5::timestamptz, $6::uuid))
        ORDER BY cm.joined_at DESC, cm.user_id DESC LIMIT $7`, [community.id, i.status, staff, user.id, ts, uid, i.limit + 1]);
    const page = rows.slice(0, i.limit);
    return { items: page.map(({ created_at_cursor, silenced, ...p }) => ({ ...p, ...(staff ? { silenced } : {}), cursor: `${created_at_cursor}|${p.id}` })), next: rows.length > i.limit ? `${page.at(-1).created_at_cursor}|${page.at(-1).id}` : null };
  },
});

cap({
  name: 'decide_community_member', method: 'POST', path: '/communities/:ref/members/:user_id', tag: TAG,
  summary: 'Owner or moderator: approve or decline a join request, remove a member, silence one for a while (silence_minutes up to 30 days) or lift the silence. Only the owner can make or remove a moderator. A removed person is told, and cannot rejoin on their own.',
  input: z.object({ ref, user_id: id, action: z.enum(['approve', 'decline', 'remove', 'silence', 'unsilence', 'make_moderator', 'make_member']), silence_minutes: z.number().int().min(5).max(43200).optional() }),
  async handler({ user }, i) {
    const { community, m } = await communityFor(user, i.ref, { need: 'manage' });
    if (i.user_id === user.id) throw badRequest('Use leave instead of changing yourself');
    if (i.action === 'silence' && !i.silence_minutes) throw badRequest('Say how long (silence_minutes)');
    return tx(async (c) => {
      const t = (await c.query('SELECT role, status FROM community_members WHERE community_id=$1 AND user_id=$2 FOR UPDATE', [community.id, i.user_id])).rows[0];
      if (!t || (await isBlockedPair(c, user.id, i.user_id))) throw notFound('Member');
      if (t.role === 'owner') throw forbidden('The owner cannot be changed');
      const owner = m.role === 'owner';
      if ((t.role === 'moderator' || i.action === 'make_moderator' || i.action === 'make_member') && !owner) throw forbidden('Only the owner can appoint or remove moderators');
      const set = async (sql, args) => { const r = await c.query(sql, [community.id, i.user_id, user.id, ...args]); if (!r.rowCount) throw conflict('That member is not in a state to change'); };
      if (i.action === 'approve') { await set("UPDATE community_members SET status='active', decided_by=$3, joined_at=now() WHERE community_id=$1 AND user_id=$2 AND status='pending'", []);
        await tell(c, i.user_id, 'community_member', 'Request approved', `You can now join in on ${community.name}`, { community_id: community.id }); }
      else if (i.action === 'decline') { await set("UPDATE community_members SET status='left', decided_by=$3, left_at=now() WHERE community_id=$1 AND user_id=$2 AND status='pending'", []);
        await tell(c, i.user_id, 'community_member', 'Request declined', `${community.name} did not accept your request`, { community_id: community.id }); }
      else if (i.action === 'remove') { await set("UPDATE community_members SET status='removed', decided_by=$3, left_at=now() WHERE community_id=$1 AND user_id=$2 AND status IN ('active','pending')", []);
        await tell(c, i.user_id, 'community_member', 'Removed from a community', `You were removed from ${community.name}`, { community_id: community.id }); }
      else if (i.action === 'silence') await set("UPDATE community_members SET muted_until=now() + make_interval(mins => $4), decided_by=$3 WHERE community_id=$1 AND user_id=$2 AND status='active'", [i.silence_minutes]);
      else if (i.action === 'unsilence') await set("UPDATE community_members SET muted_until=NULL, decided_by=$3 WHERE community_id=$1 AND user_id=$2 AND status='active'", []);
      else await set("UPDATE community_members SET role=$4, decided_by=$3 WHERE community_id=$1 AND user_id=$2 AND status='active'", [i.action === 'make_moderator' ? 'moderator' : 'member']);
      await audit(c, user.id, `community_${i.action}`, 'community_members', i.user_id);
      return { ok: true };
    });
  },
});
const isBlockedPair = async (c, a, b) => (await c.query('SELECT 1 FROM user_blocks WHERE lifted_at IS NULL AND ((blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))', [a, b])).rowCount > 0;

// ------------------------------------------------------------------------------------------------ invitations
cap({
  name: 'invite_to_community', method: 'POST', path: '/communities/:ref/invitations', tag: TAG, status: 201,
  summary: 'Invite a person. The owner and moderators can always invite; members can invite to an open community. You can only invite someone you could reach on the platform: people who blocked you, or whom you blocked, are a 404, and a young person can be invited only to an audience=all community, with a live guardian approval when they accept. Inviting twice is harmless.',
  input: z.object({ ref, user_id: id }),
  async handler({ user }, i) {
    const { community, m } = await communityFor(user, i.ref);
    const staff = m?.role === 'owner' || m?.role === 'moderator';
    if (!m || (!staff && community.join_mode !== 'open')) throw m ? forbidden('Only the owner or a moderator can invite here') : notFound('Community');
    const target = await reach(user.id, i.user_id);              // 404 for unknown, blocked or unreachable people
    if (target.young && community.audience !== 'all') throw notFound('Person');
    if (await membership(i.user_id, community.id)) throw conflict('Already a member');
    if ((await one("SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2 AND status='removed'", [community.id, i.user_id]))) {
      if (!staff) throw notFound('Person');
    }
    return tx(async (c) => {
      await spend(c, user.id, 'community_invite', LIMITS.invitesPerHour);
      const row = (await c.query(
        `INSERT INTO community_invitations(community_id, invitee_id, invited_by) VALUES ($1,$2,$3) ON CONFLICT (community_id, invitee_id) WHERE status='pending' DO NOTHING RETURNING id, status`,
        [community.id, i.user_id, user.id])).rows[0];
      if (!row) return { ...(await c.query("SELECT id, status FROM community_invitations WHERE community_id=$1 AND invitee_id=$2 AND status='pending'", [community.id, i.user_id])).rows[0], already: true };
      await tell(c, i.user_id, 'community_invite', 'Community invitation', `${user.display_name} invited you to ${community.name}`, { community_id: community.id, invitation_id: row.id, person_id: user.id }, `community_invite:${row.id}`);
      await audit(c, user.id, 'community_invite', 'communities', community.id);
      return row;
    });
  },
});

cap({
  name: 'list_my_community_invitations', method: 'GET', path: '/me/community-invitations', tag: TAG,
  summary: 'Invitations waiting for you (from people who have not blocked you and whom you have not blocked).',
  input: z.object({ limit }),
  async handler({ user }, i) {
    return many(
      `SELECT v.id, v.created_at, c.id AS community_id, c.slug, c.name, c.visibility, inv.id AS inviter_id, inv.handle AS inviter_handle, inv.display_name AS inviter_name, inv.avatar_emoji AS inviter_emoji, inv.avatar_color AS inviter_color
         FROM community_invitations v JOIN communities c ON c.id=v.community_id AND c.archived_at IS NULL JOIN users inv ON inv.id=v.invited_by
        WHERE v.invitee_id=$1 AND v.status='pending' AND NOT ${blockedBetween('v.invited_by', '$1')} ORDER BY v.created_at DESC, v.id DESC LIMIT $2`, [user.id, i.limit]);
  },
});

cap({
  name: 'respond_community_invitation', method: 'POST', path: '/me/community-invitations/:id', tag: TAG,
  summary: 'Accept or decline an invitation. A young person can accept only while a guardian who holds the social authority is linked, and only into an audience=all community.',
  input: z.object({ id, decision: z.enum(['accept', 'decline']) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const v = (await c.query(
        `SELECT v.*, cm.name, cm.audience, cm.owner_id, cm.archived_at FROM community_invitations v JOIN communities cm ON cm.id=v.community_id WHERE v.id=$1 AND v.invitee_id=$2 FOR UPDATE OF v`, [i.id, user.id])).rows[0];
      if (!v || v.archived_at || (await isBlockedPair(c, user.id, v.invited_by))) throw notFound('Invitation');
      if (v.status !== 'pending') throw conflict(`This invitation is already ${v.status}`);
      if (i.decision === 'accept') {
        if ((await isYouth(user.id)) && (v.audience !== 'all' || !(await one(`SELECT 1 FROM guardian_links l WHERE l.child_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND 'social' = ANY(l.scopes) LIMIT 1`, [user.id])))) {
          throw conflict('A guardian needs to approve social activity before you can join', { code: 'guardian_required' });
        }
        await c.query(
          `INSERT INTO community_members(community_id, user_id, role, status) VALUES ($1,$2,'member','active')
           ON CONFLICT (community_id, user_id) DO UPDATE SET status='active', left_at=NULL, joined_at=now(), role='member'`, [v.community_id, user.id]);
        // an invitation from staff is how a removed person is welcomed back
      }
      await c.query('UPDATE community_invitations SET status=$2, decided_at=now() WHERE id=$1', [v.id, i.decision === 'accept' ? 'accepted' : 'declined']);
      return { status: i.decision === 'accept' ? 'accepted' : 'declined', community_id: v.community_id };
    });
  },
});

// ------------------------------------------------------------------------------------------------ posts and the feed
const SHARE_LABEL = { result: 'Shared a result', achievement: 'Shared an award', hosted_game: 'Hosted a game', rating: 'Rating moved', streak: 'Training streak' };

async function shapePost(row, viewerId) {
  const body = row.body_enc ? decrypt(row.body_enc, POST_CTX) : row.body;
  let share = null;
  if (row.ref_kind) {
    const item = await activityItem(row.author_id, row.ref_kind, row.ref_id);
    share = item ? { ...item } : { kind: row.ref_kind, source_id: row.ref_id, unavailable: true };      // a reversed or removed record is reported as unavailable, never shown
  }
  return {
    id: row.id, kind: row.kind, community_id: row.community_id, text: body, share, created_at: row.created_at,
    author: { id: row.author_id, handle: row.handle, display_name: row.display_name, avatar_emoji: row.avatar_emoji, avatar_color: row.avatar_color, avatar_url: row.avatar_url },
    reactions: row.reactions, comments: row.comments, my_reaction: row.my_reaction, is_mine: row.author_id === viewerId,
    media: (row.media ?? []).map((x) => ({ ...x, url: marketMediaUrl(x) })), cursor: cursorOf(row),
  };
}

cap({
  name: 'post_to_community', method: 'POST', path: '/communities/:ref/posts', tag: TAG, status: 201,
  summary: 'Post to a community you belong to: text, photos or videos (upload with PUT /market/media first and pass the ids), and optionally share one of your own verified achievements (ref_kind + ref_id from your activity). Only your own approved record can be shared, in every sport, and the share disappears if that record is reversed. Text is stored encrypted.',
  input: z.object({ ref, text: z.string().max(2000).default(''), ref_kind: z.enum(KINDS).optional(), ref_id: z.string().min(1).max(120).optional(), media_ids: z.array(id).max(8).default([]) }),
  async handler({ user }, i) {
    const { community } = await communityFor(user, i.ref, { need: 'post' });
    if (!!i.ref_kind !== !!i.ref_id) throw badRequest('Give both ref_kind and ref_id to share an achievement');
    const text = i.text.trim();
    if (!text && !i.ref_kind && !i.media_ids.length) throw badRequest('Write something, add a photo, or share an achievement');
    if (i.ref_kind) {
      if (await isYouth(user.id)) throw forbidden('A young person\'s achievements are private');
      if (!(await activityItem(user.id, i.ref_kind, i.ref_id))) throw notFound('Achievement');
    }
    return tx(async (c) => {
      await spend(c, user.id, 'community_post', LIMITS.postsPerHour);
      const post = (await c.query(
        `INSERT INTO market_posts(author_id, kind, title, body_enc, visibility, community_id, ref_kind, ref_id) VALUES ($1,$2,$3,$4,'members',$5,$6,$7) RETURNING id, kind, community_id, created_at`,
        [user.id, i.ref_kind ? 'share' : 'post', i.ref_kind ? SHARE_LABEL[i.ref_kind] : 'Community post', text ? encrypt(text, POST_CTX) : null, community.id, i.ref_kind ?? null, i.ref_id ?? null])).rows[0];
      for (const [pos, mid] of i.media_ids.entries()) {
        const r = await c.query('UPDATE market_media SET post_id=$1, position=$2 WHERE id=$3 AND uploader_id=$4 AND post_id IS NULL AND product_id IS NULL AND removed_at IS NULL', [post.id, pos, mid, user.id]);
        if (!r.rowCount) throw badRequest('One of the attached files is not yours or is already used');
      }
      await audit(c, user.id, 'post_to_community', 'market_posts', post.id);
      return post;
    });
  },
});

const POST_COLS = `p.id, p.kind, p.body, p.body_enc, p.ref_kind, p.ref_id, p.community_id, p.created_at, ${CURSOR_TS('p.created_at')} AS created_at_cursor,
  ${personCols.replace(/u\./g, 'a.').replace(/a\.id/, 'a.id AS author_id')},
  (SELECT count(*)::int FROM market_reactions r WHERE r.post_id=p.id AND r.active) AS reactions,
  (SELECT count(*)::int FROM market_comments cc WHERE cc.post_id=p.id AND cc.archived_at IS NULL AND cc.hidden_at IS NULL) AS comments,
  EXISTS (SELECT 1 FROM market_reactions r WHERE r.post_id=p.id AND r.user_id=$1 AND r.active) AS my_reaction,
  coalesce((SELECT json_agg(json_build_object('id', x.id, 'kind', x.kind, 'content_type', x.content_type) ORDER BY x.position) FROM market_media x WHERE x.post_id=p.id AND x.removed_at IS NULL), '[]'::json) AS media`;

cap({
  name: 'list_community_feed', method: 'GET', path: '/communities/:ref/feed', tag: TAG,
  summary: 'The posts of a community you may read, newest first, cursor-paged (pass `next` back as `before`; the order is stable even when posts arrive between pages). Posts by people you blocked or who blocked you, people you muted, hidden and removed posts, and shares whose record was reversed never appear. A private or hidden community is a 404 to outsiders.',
  input: z.object({ ref, limit, before }),
  async handler({ user }, i) {
    const { community } = await communityFor(user, i.ref, { need: 'read' });
    const [ts, pid] = parseCursor(i.before);
    if (ts === undefined) throw badRequest('before must be a cursor from a previous page');
    const rows = await many(
      `SELECT ${POST_COLS} FROM market_posts p JOIN users a ON a.id=p.author_id
        WHERE p.community_id=$2 AND p.archived_at IS NULL AND p.hidden_at IS NULL
          AND NOT ${blockedBetween('p.author_id', '$1')} AND NOT ${mutedBy('p.author_id', '$1')}
          AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $5`, [user.id, community.id, ts, pid, i.limit + 1]);
    const page = rows.slice(0, i.limit);
    const items = [];
    for (const r of page) items.push(await shapePost(r, user.id));
    return { items, next: rows.length > i.limit ? cursorOf(page.at(-1)) : null };
  },
});

cap({
  name: 'remove_community_post', method: 'POST', path: '/communities/:ref/posts/:post_id/remove', tag: TAG,
  summary: 'Take a community post down: the author can remove their own, the owner and moderators can remove anyone\'s (with a reason that the author is told). The post is hidden, never deleted, so reports and appeals can still refer to it.',
  input: z.object({ ref, post_id: id, reason: z.string().min(3).max(300).optional() }),
  async handler({ user }, i) {
    const { community, m } = await communityFor(user, i.ref, { need: 'read' });
    const p = await one('SELECT id, author_id FROM market_posts WHERE id=$1 AND community_id=$2 AND archived_at IS NULL AND hidden_at IS NULL', [i.post_id, community.id]);
    if (!p) throw notFound('Post');
    const staff = m?.role === 'owner' || m?.role === 'moderator';
    if (p.author_id !== user.id && !staff) throw forbidden('Only the author or a moderator can remove a post');
    if (p.author_id !== user.id && !i.reason) throw badRequest('Give the author a reason');
    await tx(async (c) => {
      if (p.author_id === user.id) await c.query('UPDATE market_posts SET archived_at=now() WHERE id=$1', [p.id]);
      else {
        await c.query('UPDATE market_posts SET hidden_at=now(), hidden_by=$2, hidden_reason=$3 WHERE id=$1', [p.id, user.id, i.reason]);
        await notify(c, p.author_id, { kind: 'moderation_decision', title: 'A post was removed', body: `${community.name}: ${i.reason}`, data: { community_id: community.id } });
      }
      await audit(c, user.id, 'remove_community_post', 'market_posts', p.id);
    });
    return { ok: true };
  },
});

