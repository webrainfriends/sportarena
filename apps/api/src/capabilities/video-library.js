import { z } from 'zod';
import { createHash } from 'node:crypto';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { guardianLink, hasConsent, requireConsent } from '../youth.js';
import { ACTIVITIES_CTE } from '../athlete-history.js';
import { canReadObservation } from '../coaching-observation-access.js';
import { loadEncrypted, saveEncrypted } from '../doc-store.js';
import { coachesAthlete, withEmbed } from '../passport-sections.js';
import { VIDEO_LIMIT, checkMatchRef } from './passport-recruitment.js';

// Player video library and highlight showcase (issue #317). ONE store: passport_videos (the clips) and passport_links (sharing).
// This file adds the library views, playlists/highlight reels, match references, consent-controlled publishing and the takedown paths.
// Private coaching evidence is never public by itself: the player must promote a copy, and every share is re-checked live on read.
const TAG = 'Video library';
const VIS = ['private', 'shared', 'public'];
const DESC = 'passport_videos.description';
const PL_DESC = 'video_playlists.description';
const stale = () => conflict('This was changed elsewhere; reload and try again', { code: 'stale_version' });

const COLS = `v.id, v.title, v.description_enc, s.slug AS sport_slug, s.name AS sport, v.link_url, (v.file_name IS NOT NULL) AS has_file, v.content_type, v.size_bytes,
  v.source, v.match_activity_id, v.visibility, v.published_at, v.unpublished_at, v.status, v.review_note, v.version, v.created_at, v.archived_at,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title) ORDER BY p.title) FROM video_playlist_items i JOIN video_playlists p ON p.id=i.playlist_id AND p.archived_at IS NULL
             WHERE i.video_id=v.id AND i.removed_at IS NULL), '[]'::jsonb) AS playlists`;
const FROM = 'FROM passport_videos v LEFT JOIN sports s ON s.id=v.sport_id';

/** Row for the owner: description decrypted, embed url added, the match it belongs to resolved from the canonical history (never copied). */
async function present(userId, rows) {
  const ids = [...new Set(rows.map((r) => r.match_activity_id).filter(Boolean))];
  const matches = ids.length ? new Map((await many(`${ACTIVITIES_CTE} SELECT a.activity_id, a.title, a.opponent, a.result, to_char(a.played_on,'YYYY-MM-DD') AS played_on FROM acts a WHERE a.activity_id = ANY($2)`, [userId, ids])).map((m) => [m.activity_id, m])) : new Map();
  return rows.map(({ description_enc, ...r }) => withEmbed({ ...r, description: description_enc ? decrypt(description_enc, DESC) : null, match: r.match_activity_id ? matches.get(r.match_activity_id) ?? null : null, file_url: r.has_file ? `/api/v1/passport-videos/${r.id}/file` : null }));
}
const owned = async (userId, vid) => { const v = await one(`SELECT ${COLS} ${FROM} WHERE v.id=$1 AND v.user_id=$2 AND v.removed_at IS NULL`, [vid, userId]); if (!v) throw notFound('Video'); return v; };
const sportId = async (slug) => { if (!slug) return null; const s = await one('SELECT id FROM sports WHERE slug=$1', [slug]); if (!s) throw notFound('Sport'); return s.id; };

cap({
  name: 'list_my_videos', method: 'GET', path: '/me/videos', tag: TAG,
  summary: 'Your video library, newest first: uploaded clips, YouTube/Vimeo links and clips you promoted from coaching notes, each with its sport, the match it shows, who can see it (private | shared | public), its playlists and where it is in coach approval. Filter by sport, match, playlist or visibility. Archived clips are hidden unless include_archived is true.',
  input: z.object({ sport_slug: z.string().max(60).optional(), match_activity_id: z.string().max(80).optional(), playlist_id: id.optional(), visibility: z.enum(VIS).optional(), include_archived: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${COLS} ${FROM} WHERE v.user_id=$1 AND v.removed_at IS NULL AND ($2::boolean OR v.archived_at IS NULL) AND ($3::text IS NULL OR s.slug=$3) AND ($4::text IS NULL OR v.match_activity_id=$4)
          AND ($5::text IS NULL OR v.visibility=$5) AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM video_playlist_items x WHERE x.video_id=v.id AND x.playlist_id=$6 AND x.removed_at IS NULL))
        ORDER BY v.created_at DESC, v.id LIMIT $7 OFFSET $8`,
      [user.id, i.include_archived, i.sport_slug ?? null, i.match_activity_id ?? null, i.visibility ?? null, i.playlist_id ?? null, i.limit, i.offset]);
    return present(user.id, rows);
  },
});

cap({
  name: 'get_my_video', method: 'GET', path: '/me/videos/:id', tag: TAG, input: z.object({ id }),
  summary: 'One clip from your library with everything you can change.',
  async handler({ user }, i) { return (await present(user.id, [await owned(user.id, i.id)]))[0]; },
});

cap({
  name: 'update_my_video', method: 'PATCH', path: '/me/videos/:id', tag: TAG,
  summary: 'Rename a clip, change its description or sport, or link it to (or unlink it from) one of your matches. Send the version you last saw; a stale version is refused (409) so two devices never overwrite each other.',
  input: z.object({ id, version: z.number().int().min(1), title: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(500).nullable().optional(), sport_slug: z.string().max(60).nullable().optional(),
    match_activity_id: z.string().max(80).nullable().optional().describe('an id from GET /me/matches; null removes the link') }),
  async handler({ user }, i) {
    await owned(user.id, i.id);
    const sets = [], vals = [i.id, user.id, i.version];
    const set = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (i.title !== undefined) set('title', i.title);
    if (i.description !== undefined) set('description_enc', i.description ? encrypt(i.description, DESC) : null);
    if (i.sport_slug !== undefined) set('sport_id', await sportId(i.sport_slug));
    if (i.match_activity_id !== undefined) set('match_activity_id', await checkMatchRef(user.id, i.match_activity_id));
    if (!sets.length) throw badRequest('Nothing to change');
    const r = await one(`UPDATE passport_videos SET ${sets.join(', ')}, version=version+1 WHERE id=$1 AND user_id=$2 AND version=$3 AND removed_at IS NULL RETURNING id`, vals);
    if (!r) throw stale();
    return (await present(user.id, [await owned(user.id, i.id)]))[0];
  },
});

cap({
  name: 'set_my_video_visibility', method: 'POST', path: '/me/videos/:id/visibility', tag: TAG,
  summary: 'Publish or take back a clip. private = only you; shared = on passport links you create (and to coaches who coach you, once approved); public = on your public showcase. Publishing a young person\'s clip needs a verified guardian\'s current `media` consent. Going private takes effect at once everywhere: showcase, links, exports and file downloads. A verified guardian can take a young person\'s clip private by passing athlete_id.',
  input: z.object({ id, version: z.number().int().min(1), visibility: z.enum(VIS), athlete_id: id.optional() }),
  async handler({ user }, i) {
    let owner = user.id;
    if (i.athlete_id && i.athlete_id !== user.id) {
      if (!(await guardianLink(user.id, i.athlete_id))) throw notFound('Video');
      if (i.visibility !== 'private') throw forbidden('A guardian can take a young person\'s clip private; the young person publishes it');
      owner = i.athlete_id;
    }
    await owned(owner, i.id);
    if (i.visibility !== 'private') await requireConsent(owner, 'media', 'publishing this video');
    const r = await one(
      `UPDATE passport_videos SET visibility=$4, version=version+1,
              published_at = CASE WHEN $4='private' THEN published_at ELSE coalesce(published_at, now()) END,
              unpublished_at = CASE WHEN $4='private' THEN now() ELSE NULL END
        WHERE id=$1 AND user_id=$2 AND version=$3 AND removed_at IS NULL AND archived_at IS NULL RETURNING id`, [i.id, owner, i.version, i.visibility]);
    if (!r) throw stale();
    await audit(null, user.id, `video_visibility_${i.visibility}`, 'passport_videos', i.id);
    return (await present(owner, [await owned(owner, i.id)]))[0];
  },
});

cap({
  name: 'archive_my_video', method: 'POST', path: '/me/videos/:id/archive', tag: TAG, input: z.object({ id, restore: z.boolean().default(false) }),
  summary: 'Archive a clip (or restore it with restore=true). An archived clip disappears from every share, showcase and playlist link at once but the clip and its file are kept; nothing is deleted. Archiving also makes it private; restoring does not re-publish it.',
  async handler({ user }, i) {
    const r = await one(
      i.restore
        ? 'UPDATE passport_videos SET archived_at=NULL, version=version+1 WHERE id=$1 AND user_id=$2 AND removed_at IS NULL AND archived_at IS NOT NULL RETURNING id'
        : `UPDATE passport_videos SET archived_at=now(), visibility='private', unpublished_at=now(), version=version+1 WHERE id=$1 AND user_id=$2 AND removed_at IS NULL AND archived_at IS NULL RETURNING id`, [i.id, user.id]);
    if (!r) await owned(user.id, i.id); // repeating is a no-op; unknown ids are 404
    await audit(null, user.id, i.restore ? 'video_restore' : 'video_archive', 'passport_videos', i.id);
    return (await present(user.id, [await owned(user.id, i.id)]))[0];
  },
});

cap({
  name: 'promote_coaching_video', method: 'POST', path: '/me/videos/from-coaching', tag: TAG, status: 201,
  summary: 'Copy a video a coach attached to a coaching note into your own library. Only you can do this, only for a note the coach has shared with you (and, if you are young, only while a guardian\'s coaching consent is in force). The copy starts private, keeps a reference to where it came from, and the coach\'s original stays private to the note. Repeating it returns the same clip.',
  input: z.object({ evidence_id: id, title: z.string().trim().min(1).max(120).optional() }),
  async handler({ user }, i) {
    const dup = await one('SELECT id FROM passport_videos WHERE user_id=$1 AND provenance_ref=$2 AND removed_at IS NULL', [user.id, i.evidence_id]);
    if (dup) return (await present(user.id, [await owned(user.id, dup.id)]))[0]; // the copy is already the player's own
    const e = await one("SELECT * FROM coaching_evidence WHERE id=$1 AND removed_at IS NULL AND kind='video'", [i.evidence_id]);
    const o = e && (await one('SELECT id, coach_id, athlete_id, team_id, visibility FROM coaching_observations WHERE id=$1', [e.observation_id]));
    if (!e || !o || o.athlete_id !== user.id || o.visibility !== 'player' || !(await canReadObservation(user, o))) throw notFound('Video');
    if ((await one('SELECT count(*)::int AS n FROM passport_videos WHERE user_id=$1 AND removed_at IS NULL AND archived_at IS NULL', [user.id])).n >= VIDEO_LIMIT) throw badRequest(`You can keep up to ${VIDEO_LIMIT} videos; archive one first`);
    let bytes;
    try { bytes = await loadEncrypted('coaching', 'coaching_evidence.file', e.file_name); } catch (err) { throw err.code === 'ENOENT' ? notFound('Video') : err; }
    const { id: vid, file } = await saveEncrypted('passport', 'passport_videos.file', bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const row = await one(
      `INSERT INTO passport_videos(id, user_id, title, file_name, content_type, size_bytes, sha256, source, provenance_ref, visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,'coaching_evidence',$8,'private')
       ON CONFLICT DO NOTHING RETURNING id`, [vid, user.id, i.title ?? e.title ?? 'Coaching clip', file, e.content_type, bytes.length, sha, e.id]);
    if (!row) throw conflict('You already have this clip in your library');
    await audit(null, user.id, 'promote_coaching_video', 'passport_videos', row.id);
    return (await present(user.id, [await owned(user.id, row.id)]))[0];
  },
});

// ───── playlists and highlight reels ─────
const PL_COLS = `p.id, p.title, p.kind, p.description_enc, s.slug AS sport_slug, p.version, p.created_at,
  (SELECT count(*)::int FROM video_playlist_items i JOIN passport_videos v ON v.id=i.video_id AND v.removed_at IS NULL AND v.archived_at IS NULL WHERE i.playlist_id=p.id AND i.removed_at IS NULL) AS video_count`;
const plOut = ({ description_enc, ...p }) => ({ ...p, description: description_enc ? decrypt(description_enc, PL_DESC) : null });
const ownedPl = async (userId, pid) => { const p = await one(`SELECT ${PL_COLS} FROM video_playlists p LEFT JOIN sports s ON s.id=p.sport_id WHERE p.id=$1 AND p.user_id=$2 AND p.archived_at IS NULL`, [pid, userId]); if (!p) throw notFound('Playlist'); return p; };
async function playlistWithVideos(userId, pid) {
  const p = plOut(await ownedPl(userId, pid));
  const rows = await many(`SELECT ${COLS} ${FROM} JOIN video_playlist_items i ON i.video_id=v.id AND i.playlist_id=$1 AND i.removed_at IS NULL WHERE v.removed_at IS NULL AND v.archived_at IS NULL ORDER BY i.position, i.id`, [pid]);
  return { ...p, videos: await present(userId, rows) };
}

cap({
  name: 'list_my_playlists', method: 'GET', path: '/me/playlists', tag: TAG, input: z.object({ ...page }),
  summary: 'Your playlists and highlight reels with how many clips each holds.',
  handler: async ({ user }, i) => (await many(`SELECT ${PL_COLS} FROM video_playlists p LEFT JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND p.archived_at IS NULL ORDER BY p.created_at DESC, p.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset])).map(plOut),
});

cap({
  name: 'get_my_playlist', method: 'GET', path: '/me/playlists/:id', tag: TAG, input: z.object({ id }),
  summary: 'A playlist with its clips in order.', handler: ({ user }, i) => playlistWithVideos(user.id, i.id),
});

cap({
  name: 'create_playlist', method: 'POST', path: '/me/playlists', tag: TAG, status: 201,
  summary: 'Create a playlist or a highlight reel (a playlist meant to be shown off). Share it with POST /me/passport-links and playlist_id: the link shows only this playlist.',
  input: z.object({ title: z.string().trim().min(1).max(80), kind: z.enum(['highlight', 'playlist']).default('playlist'), description: z.string().trim().max(500).optional(), sport_slug: z.string().max(60).optional() }),
  async handler({ user }, i) {
    const r = await one('INSERT INTO video_playlists(user_id, title, kind, description_enc, sport_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [user.id, i.title, i.kind, i.description ? encrypt(i.description, PL_DESC) : null, await sportId(i.sport_slug)]);
    return playlistWithVideos(user.id, r.id);
  },
});

cap({
  name: 'update_playlist', method: 'PATCH', path: '/me/playlists/:id', tag: TAG,
  summary: 'Rename a playlist, change its kind or description. Send the version you last saw; a stale version is refused (409).',
  input: z.object({ id, version: z.number().int().min(1), title: z.string().trim().min(1).max(80).optional(), kind: z.enum(['highlight', 'playlist']).optional(), description: z.string().trim().max(500).nullable().optional() }),
  async handler({ user }, i) {
    await ownedPl(user.id, i.id);
    const sets = [], vals = [i.id, user.id, i.version];
    const set = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (i.title !== undefined) set('title', i.title);
    if (i.kind !== undefined) set('kind', i.kind);
    if (i.description !== undefined) set('description_enc', i.description ? encrypt(i.description, PL_DESC) : null);
    if (!sets.length) throw badRequest('Nothing to change');
    if (!(await one(`UPDATE video_playlists SET ${sets.join(', ')}, version=version+1 WHERE id=$1 AND user_id=$2 AND version=$3 AND archived_at IS NULL RETURNING id`, vals))) throw stale();
    return playlistWithVideos(user.id, i.id);
  },
});

cap({
  name: 'set_playlist_videos', method: 'POST', path: '/me/playlists/:id/videos', tag: TAG,
  summary: 'Set which clips are in a playlist and their order in one step (add, remove and reorder together; sending the same list twice changes nothing). Clips left out are removed from the playlist, not deleted. Send the playlist version you last saw.',
  input: z.object({ id, version: z.number().int().min(1), video_ids: z.array(id).max(50) }),
  async handler({ user }, i) {
    const want = [...new Set(i.video_ids)];
    await ownedPl(user.id, i.id);
    if (want.length) {
      const have = await many('SELECT id FROM passport_videos WHERE id = ANY($1) AND user_id=$2 AND removed_at IS NULL AND archived_at IS NULL', [want, user.id]);
      if (have.length !== want.length) throw notFound('Video');
    }
    await tx(async (c) => {
      const bumped = await c.query('UPDATE video_playlists SET version=version+1 WHERE id=$1 AND user_id=$2 AND version=$3 AND archived_at IS NULL RETURNING id', [i.id, user.id, i.version]);
      if (!bumped.rows.length) throw stale();
      await c.query('UPDATE video_playlist_items SET removed_at=now() WHERE playlist_id=$1 AND removed_at IS NULL AND NOT (video_id = ANY($2))', [i.id, want]);
      for (const [pos, vid] of want.entries()) {
        const moved = await c.query('UPDATE video_playlist_items SET position=$3 WHERE playlist_id=$1 AND video_id=$2 AND removed_at IS NULL RETURNING id', [i.id, vid, pos]);
        if (!moved.rows.length) await c.query('INSERT INTO video_playlist_items(playlist_id, video_id, position) VALUES ($1,$2,$3)', [i.id, vid, pos]);
      }
    });
    return playlistWithVideos(user.id, i.id);
  },
});

cap({
  name: 'archive_playlist', method: 'DELETE', path: '/me/playlists/:id', tag: TAG, input: z.object({ id }),
  summary: 'Archive a playlist. Share links made for it stop working at once; the clips themselves stay in your library.',
  async handler({ user }, i) {
    const r = await one('UPDATE video_playlists SET archived_at=coalesce(archived_at, now()), version=version+1 WHERE id=$1 AND user_id=$2 RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Playlist');
    return r;
  },
});

// ───── public showcase, staff view, export ─────
const SHOW_COLS = 'v.id, v.title, v.description_enc, s.slug AS sport_slug, v.link_url, (v.file_name IS NOT NULL) AS has_file, v.published_at, v.match_activity_id';
const showcaseOut = (handle) => ({ description_enc, ...v }) => withEmbed({ ...v, description: description_enc ? decrypt(description_enc, DESC) : null, file_url: v.has_file ? `/api/v1/showcase/${handle}/video/${v.id}` : null });

/** Public clips of a player. A young person's show only while a guardian's media consent is in force; anything else looks like "no such player". */
export async function showcaseFor(handle) {
  const u = await one("SELECT id, display_name, handle FROM users WHERE handle=$1 AND access_status='approved'", [handle]);
  if (!u || !(await hasConsent(u.id, 'media'))) throw notFound('Player');
  const rows = await many(`SELECT ${SHOW_COLS} ${FROM} WHERE v.user_id=$1 AND v.removed_at IS NULL AND v.archived_at IS NULL AND v.unpublished_at IS NULL AND v.visibility='public' ORDER BY v.published_at DESC, v.id LIMIT 50`, [u.id]);
  return { u, rows };
}

cap({
  name: 'get_player_showcase', method: 'GET', path: '/players/:handle/showcase', tag: TAG, auth: 'public', input: z.object({ handle: z.string().min(3).max(24) }),
  summary: 'The clips a player has chosen to make public, newest first. No sign-in needed. Nothing private, archived, unpublished or consent-withdrawn is ever included, checked on every request.',
  async handler(_ctx, i) {
    const { u, rows } = await showcaseFor(i.handle);
    return { player: { handle: u.handle, display_name: u.display_name }, videos: rows.map(showcaseOut(u.handle)) };
  },
});

cap({
  name: 'list_athlete_videos', method: 'GET', path: '/athletes/:athlete_id/videos', tag: TAG, auth: ['coach'], input: z.object({ athlete_id: id, ...page }),
  summary: 'A coach\'s read-only view of the clips an athlete they coach has shared or published (never private ones). For a young athlete it needs a guardian\'s current media consent. Every call is audit-logged.',
  async handler({ user }, i) {
    if (i.athlete_id === user.id || !(await coachesAthlete(user.id, i.athlete_id)) || !(await hasConsent(i.athlete_id, 'media'))) throw notFound('Athlete');
    const rows = await many(`SELECT ${SHOW_COLS}, v.status, v.visibility ${FROM} WHERE v.user_id=$1 AND v.removed_at IS NULL AND v.archived_at IS NULL AND v.unpublished_at IS NULL AND v.visibility IN ('shared','public') ORDER BY v.created_at DESC, v.id LIMIT $2 OFFSET $3`, [i.athlete_id, i.limit, i.offset]);
    await audit(null, user.id, 'read_athlete_videos', 'passport_videos', i.athlete_id);
    return rows.map(({ description_enc, ...v }) => withEmbed({ ...v, description: description_enc ? decrypt(description_enc, DESC) : null, file_url: v.has_file ? `/api/v1/passport-videos/${v.id}/file` : null }));
  },
});

cap({
  name: 'export_my_video_library', method: 'GET', path: '/me/video-library/export', tag: TAG, input: z.object({}),
  summary: 'Your whole library as a JSON manifest (clips, visibility, match references, playlists), including archived clips. File bytes are downloaded per clip from file_url. Audit-logged.',
  async handler({ user }) {
    const rows = await many(`SELECT ${COLS} ${FROM} WHERE v.user_id=$1 AND v.removed_at IS NULL ORDER BY v.created_at, v.id`, [user.id]);
    const playlists = await many(`SELECT ${PL_COLS}, coalesce((SELECT jsonb_agg(i.video_id ORDER BY i.position, i.id) FROM video_playlist_items i WHERE i.playlist_id=p.id AND i.removed_at IS NULL), '[]'::jsonb) AS video_ids
      FROM video_playlists p LEFT JOIN sports s ON s.id=p.sport_id WHERE p.user_id=$1 AND p.archived_at IS NULL ORDER BY p.created_at, p.id`, [user.id]);
    await audit(null, user.id, 'export_video_library', 'passport_videos', user.id);
    return { format: 'sportarena.video-library.v1', exported_at: new Date().toISOString(), videos: await present(user.id, rows), playlists: playlists.map(plOut) };
  },
});

cap({
  name: 'list_my_coaching_videos', method: 'GET', path: '/me/coaching-videos', tag: TAG, input: z.object({ ...page }),
  summary: 'Videos your coaches attached to notes they chose to share with you, that you have not yet copied into your library. Copying is your choice (POST /me/videos/from-coaching); nothing here is public. A young person sees them only while a guardian\'s coaching consent is in force.',
  async handler({ user }, i) {
    if (!(await hasConsent(user.id, 'coaching'))) return [];
    return many(
      `SELECT e.id, coalesce(e.title, 'Coaching clip') AS title, e.size_bytes, e.created_at, u.display_name AS coach_name, to_char(o.observed_at,'YYYY-MM-DD') AS observed_on
         FROM coaching_evidence e JOIN coaching_observations o ON o.id=e.observation_id AND o.athlete_id=$1 AND o.visibility='player' JOIN users u ON u.id=o.coach_id
        WHERE e.kind='video' AND e.removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM passport_videos v WHERE v.user_id=$1 AND v.provenance_ref=e.id AND v.removed_at IS NULL)
        ORDER BY e.created_at DESC, e.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
  },
});
