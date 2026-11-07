// Family-facing live stream and replay hub (gaps audit, feature 5).
// Platform stores REFERENCES to external streams (YouTube Live, Mux, Twitch, etc.) — it does not host video.
// event_markers enable per-sport timeline scrubbing. Stream chat messages are encrypted.
// get_family_stream_feed personalises the feed by guardian-child relationships.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { hasOrgGrant } from '../org-access.js';
import { canManageTeam } from './teams.js';

const TAG = 'Stream hub';
const MARKER_TYPES = ['goal','card','sub','try','wicket','point','other'];

// Streams live in mr_streams (the media-rights registry). A stream belongs to an event and optionally one fixture.
// Its teams are the fixture's home/away sides, or (event-wide streams) the teams with an accepted entry in the event.
const STREAM_TEAMS = `(
  SELECT s.id AS stream_id, f.home_team_id AS team_id FROM mr_streams s JOIN fixtures f ON f.id=s.fixture_id WHERE f.home_team_id IS NOT NULL
  UNION
  SELECT s.id, f.away_team_id FROM mr_streams s JOIN fixtures f ON f.id=s.fixture_id WHERE f.away_team_id IS NOT NULL
  UNION
  SELECT s.id, ee.team_id FROM mr_streams s JOIN event_entries ee ON ee.event_id=s.event_id AND ee.status='accepted' AND ee.team_id IS NOT NULL WHERE s.fixture_id IS NULL
)`;
// Response shape the app reads: is_live / stream_url are aliases over state / playback_ref.
const STREAM_COLS = `es.id, es.event_id, es.fixture_id, es.provider, es.access_policy, es.state, es.is_replay, es.replay_url,
  es.replay_available_at, es.duration_seconds, es.event_markers, es.camera_feeds, es.quality_options, es.allow_family_chat,
  es.offline_download_url, (es.state='live') AS is_live, es.playback_ref AS stream_url,
  e.name AS event_name, sp.slug AS sport_slug,
  COALESCE(es.scheduled_start, fx.scheduled_at, e.starts_on::timestamptz) AS starts_at,
  st.team_id, t.name AS team_name, t.emoji AS team_emoji, t.color AS team_color`;
const STREAM_FROM = `mr_streams es JOIN events e ON e.id=es.event_id JOIN sports sp ON sp.id=e.sport_id
  LEFT JOIN fixtures fx ON fx.id=es.fixture_id
  LEFT JOIN ${STREAM_TEAMS} st ON st.stream_id=es.id LEFT JOIN teams t ON t.id=st.team_id`;

const dedupe = (rows) => { const seen = new Set(); return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id))); };

async function streamTeamIds(streamId) {
  return (await many(`SELECT team_id FROM ${STREAM_TEAMS} x WHERE stream_id=$1`, [streamId])).map((r) => r.team_id);
}

async function loadStream(streamId) {
  const s = await one('SELECT es.*, e.organizer_id, e.organisation_id FROM mr_streams es JOIN events e ON e.id=es.event_id WHERE es.id=$1 AND es.status=\'active\'', [streamId]);
  if (!s) throw notFound('Stream');
  s.team_ids = await streamTeamIds(streamId);
  return s;
}

/** Runs the stream: platform admin, the event organiser / organisation owner or admin, or a manager of one of its teams. */
async function canManageStream(user, s) {
  if (isAdmin(user) || s.organizer_id === user.id) return true;
  if (await hasOrgGrant(user, s.organisation_id, ['owner', 'admin'])) return true;
  for (const tid of s.team_ids) {
    const team = await one('SELECT * FROM teams WHERE id=$1', [tid]);
    if (team && await canManageTeam(user, team)) return true;
  }
  return false;
}

/** Public streams are open; private/subscriber streams need a link to the stream: a team member, their guardian, an alert subscriber, or the managers. */
async function canViewStream(user, s) {
  if (s.access_policy === 'public') return true;
  if (await canManageStream(user, s)) return true;
  if (!s.team_ids.length) return false;
  const r = await one(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = ANY($2::uuid[]) AND tm.status='active' AND tm.user_id=$1)
       OR EXISTS (SELECT 1 FROM team_members tm JOIN guardian_links gl ON gl.child_id=tm.user_id
                  WHERE tm.team_id = ANY($2::uuid[]) AND tm.status='active' AND gl.guardian_id=$1 AND gl.status='active'
                    AND gl.revoked_at IS NULL AND (gl.expires_at IS NULL OR gl.expires_at > now()))
       OR ($3 = 'subscriber' AND EXISTS (SELECT 1 FROM stream_alert_subscriptions a WHERE a.user_id=$1 AND a.team_id = ANY($2::uuid[])))`,
    [user.id, s.team_ids, s.access_policy]
  );
  return !!r;
}

cap({
  name: 'get_family_stream_feed', method: 'GET', path: '/me/stream-feed', tag: TAG,
  summary: 'Personalised stream feed for a guardian: live, upcoming, replays, discover',
  auth: 'user',
  input: z.object({}),
  handler: async ({ user }) => {
    // teams where the guardian's linked children (active, unrevoked, unexpired link) play
    const childTeams = await many(
      `SELECT DISTINCT tm.team_id, c.id AS child_id, c.display_name AS child_name
       FROM guardian_links gl
       JOIN users c ON c.id=gl.child_id
       JOIN team_members tm ON tm.user_id=c.id AND tm.status='active'
       WHERE gl.guardian_id=$1 AND gl.status='active' AND gl.revoked_at IS NULL AND (gl.expires_at IS NULL OR gl.expires_at > now())`,
      [user.id]
    );
    const teamIds = [...new Set(childTeams.map(r => r.team_id))];
    const childByTeam = {};
    for (const r of childTeams) { if (!childByTeam[r.team_id]) childByTeam[r.team_id] = { id: r.child_id, name: r.child_name }; }

    const annotate = (streams) => dedupe(streams.map(s => ({
      ...s,
      child_playing: !!(childByTeam[s.team_id]),
      child_name: childByTeam[s.team_id]?.name ?? null,
    })));

    const base = `SELECT ${STREAM_COLS} FROM ${STREAM_FROM} WHERE es.status='active' AND st.team_id = ANY($1::uuid[])`;
    const liveNow = teamIds.length ? await many(`${base} AND es.state='live' ORDER BY starts_at DESC LIMIT 50`, [teamIds]) : [];
    const upcoming = teamIds.length ? await many(
      `${base} AND es.state='scheduled' AND es.is_replay=false
         AND COALESCE(es.scheduled_start, fx.scheduled_at, e.starts_on::timestamptz) BETWEEN now() AND now()+interval '7 days'
       ORDER BY starts_at LIMIT 40`, [teamIds]) : [];
    const replays = teamIds.length ? await many(
      `${base} AND es.is_replay=true AND es.replay_url IS NOT NULL AND es.replay_available_at > now()-interval '30 days'
       ORDER BY es.replay_available_at DESC LIMIT 40`, [teamIds]) : [];

    // Discover: latest live streams anyone may watch (public and active only)
    const discover = await many(
      `SELECT ${STREAM_COLS} FROM ${STREAM_FROM}
       WHERE es.state='live' AND es.access_policy='public' AND es.status='active' AND es.playback_ref IS NOT NULL
       ORDER BY starts_at DESC LIMIT 30`
    );

    return {
      live_now: annotate(liveNow).slice(0, 20),
      upcoming: annotate(upcoming).slice(0, 20),
      recently_ended: annotate(replays).slice(0, 20),
      discover: dedupe(discover).slice(0, 10).map(s => ({ ...s, child_playing: false, child_name: null })),
    };
  },
});

cap({
  name: 'get_event_stream', method: 'GET', path: '/event-streams/:id', tag: TAG,
  summary: 'One stream with its replay, camera, quality and marker details (if you may watch it)',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: streamId }) => {
    const s = await loadStream(streamId);
    if (!await canViewStream(user, s)) throw notFound('Stream');
    const stream = await one(
      `SELECT ${STREAM_COLS} FROM ${STREAM_FROM} WHERE es.id=$1 ORDER BY (st.team_id IS NULL), t.name LIMIT 1`, [streamId]
    );
    return { stream };
  },
});

cap({
  name: 'save_replay_reference', method: 'POST', path: '/event-streams/:id/replay', tag: TAG,
  summary: 'Save a replay URL for a stream and notify subscribers',
  auth: 'user',
  input: z.object({
    id,
    replay_url: z.string().url(),
    duration_seconds: z.number().int().min(0).optional(),
    event_markers: z.array(z.object({
      type: z.enum(MARKER_TYPES),
      minute: z.number().int().min(0),
      label: z.string().max(100),
      team: z.enum(['home','away']).optional(),
    })).optional(),
    offline_download_url: z.string().url().optional(),
  }),
  handler: async ({ user }, { id: streamId, replay_url, duration_seconds, event_markers, offline_download_url }) => {
    const stream = await loadStream(streamId);
    if (!await canManageStream(user, stream)) throw forbidden('Manager access required');
    await one(
      `UPDATE mr_streams SET is_replay=true, replay_url=$1, replay_available_at=now(),
         duration_seconds=$2, event_markers=COALESCE($3::jsonb, event_markers),
         offline_download_url=$4
       WHERE id=$5 RETURNING id`,
      [replay_url, duration_seconds ?? null, event_markers ? JSON.stringify(event_markers) : null, offline_download_url ?? null, streamId]
    );
    await audit(null, user.id, 'stream_replay_saved', 'mr_streams', streamId);
    // notify everyone following one of this stream's teams
    const subs = stream.team_ids.length
      ? await many('SELECT DISTINCT user_id, team_id FROM stream_alert_subscriptions WHERE team_id = ANY($1::uuid[])', [stream.team_ids])
      : [];
    const names = Object.fromEntries((await many('SELECT id, name FROM teams WHERE id = ANY($1::uuid[])', [stream.team_ids])).map(r => [r.id, r.name]));
    const notified = new Set();
    for (const s of subs) {
      if (notified.has(s.user_id)) continue;
      notified.add(s.user_id);
      await notify(s.user_id, {
        title: 'Replay available',
        body: `${names[s.team_id] ?? 'A match'} replay is now available to watch`,
        data: { type: 'replay_available', stream_id: streamId, team_id: s.team_id },
      });
    }
    return { saved: true, notified: notified.size };
  },
});

cap({
  name: 'save_stream_camera_feeds', method: 'PATCH', path: '/event-streams/:id/cameras', tag: TAG,
  summary: 'Set camera feed options for a stream (manager)',
  auth: 'user',
  input: z.object({
    id,
    camera_feeds: z.array(z.object({ label: z.string().max(50), url: z.string().url() })),
  }),
  handler: async ({ user }, { id: streamId, camera_feeds }) => {
    const stream = await loadStream(streamId);
    if (!await canManageStream(user, stream)) throw forbidden('Manager access required');
    await one('UPDATE mr_streams SET camera_feeds=$1::jsonb WHERE id=$2 RETURNING id', [JSON.stringify(camera_feeds), streamId]);
    return { saved: true };
  },
});

cap({
  name: 'save_stream_quality_options', method: 'PATCH', path: '/event-streams/:id/quality', tag: TAG,
  summary: 'Set quality options for a stream (manager)',
  auth: 'user',
  input: z.object({
    id,
    quality_options: z.array(z.object({ label: z.string().max(20), url: z.string().url() })),
  }),
  handler: async ({ user }, { id: streamId, quality_options }) => {
    const stream = await loadStream(streamId);
    if (!await canManageStream(user, stream)) throw forbidden('Manager access required');
    await one('UPDATE mr_streams SET quality_options=$1::jsonb WHERE id=$2 RETURNING id', [JSON.stringify(quality_options), streamId]);
    return { saved: true };
  },
});

cap({
  name: 'list_team_stream_archive', method: 'GET', path: '/teams/:team_id/stream-archive', tag: TAG,
  summary: 'Get all streams (live, replay) for a team, paginated',
  auth: 'user',
  input: z.object({ team_id: id, ...page }),
  handler: async ({ user }, { team_id, limit = 20, offset = 0 }) => {
    const team = await one('SELECT * FROM teams WHERE id=$1', [team_id]);
    if (!team) throw notFound('Team');
    const manager = await canManageTeam(user, team);
    // non-managers only see what they may watch: public streams, or any stream of a team they (or their child) belong to
    const member = manager || !!(await one(
      `SELECT 1 FROM team_members tm WHERE tm.team_id=$2 AND tm.status='active' AND (tm.user_id=$1 OR EXISTS (
         SELECT 1 FROM guardian_links gl WHERE gl.guardian_id=$1 AND gl.child_id=tm.user_id AND gl.status='active'
           AND gl.revoked_at IS NULL AND (gl.expires_at IS NULL OR gl.expires_at > now())))`, [user.id, team_id]));
    const where = `st.team_id=$1 AND es.status='active' AND ($2::boolean OR es.access_policy='public')`;
    const streams = await many(
      `SELECT ${STREAM_COLS} FROM ${STREAM_FROM} WHERE ${where}
       ORDER BY starts_at DESC NULLS LAST LIMIT $3 OFFSET $4`,
      [team_id, member, limit, offset]
    );
    const total = await one(`SELECT COUNT(*) AS n FROM mr_streams es JOIN ${STREAM_TEAMS} st ON st.stream_id=es.id WHERE ${where}`, [team_id, member]);
    return { streams, total: Number(total.n) };
  },
});

cap({
  name: 'subscribe_stream_alert', method: 'POST', path: '/stream-alerts/:team_id', tag: TAG,
  summary: 'Subscribe to live stream alerts for a team',
  auth: 'user',
  input: z.object({ team_id: id }),
  handler: async ({ user }, { team_id }) => {
    const team = await one('SELECT id FROM teams WHERE id=$1', [team_id]);
    if (!team) throw notFound('Team');
    await one(
      'INSERT INTO stream_alert_subscriptions(user_id,team_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',
      [user.id, team_id]
    );
    return { subscribed: true };
  },
});

cap({
  name: 'unsubscribe_stream_alert', method: 'DELETE', path: '/stream-alerts/:team_id', tag: TAG,
  summary: 'Unsubscribe from live stream alerts for a team',
  auth: 'user',
  input: z.object({ team_id: id }),
  handler: async ({ user }, { team_id }) => {
    await one('DELETE FROM stream_alert_subscriptions WHERE user_id=$1 AND team_id=$2 RETURNING id', [user.id, team_id]);
    return { unsubscribed: true };
  },
});

cap({
  name: 'list_stream_alert_subscriptions', method: 'GET', path: '/me/stream-alerts', tag: TAG,
  summary: 'Get my stream alert subscriptions',
  auth: 'user',
  input: z.object({}),
  handler: async ({ user }) => {
    const subs = await many(
      `SELECT s.*, t.name AS team_name, t.emoji AS team_emoji, t.color AS team_color
       FROM stream_alert_subscriptions s JOIN teams t ON t.id=s.team_id
       WHERE s.user_id=$1 ORDER BY t.name`,
      [user.id]
    );
    return { subscriptions: subs };
  },
});

cap({
  name: 'send_stream_chat_message', method: 'POST', path: '/event-streams/:id/chat', tag: TAG,
  summary: 'Send a message in the parent chat for a live stream',
  auth: 'user',
  input: z.object({
    id,
    message: z.string().min(1).max(280),
  }),
  handler: async ({ user }, { id: streamId, message }) => {
    const stream = await loadStream(streamId);
    if (!await canViewStream(user, stream)) throw notFound('Stream');
    if (!stream.allow_family_chat) throw forbidden('Chat is disabled for this stream');
    // simple rate limit: 5 messages per minute per user per stream
    const recent = await one(
      'SELECT COUNT(*) AS n FROM stream_chat_messages WHERE stream_id=$1 AND user_id=$2 AND sent_at > now()-interval \'1 minute\'',
      [streamId, user.id]
    );
    if (Number(recent.n) >= 5) throw badRequest('Rate limit: max 5 messages per minute');
    const msg = await one(
      'INSERT INTO stream_chat_messages(stream_id,user_id,message_enc) VALUES($1,$2,$3) RETURNING *',
      [streamId, user.id, encrypt(message)]
    );
    return { message: { id: msg.id, sent_at: msg.sent_at } };
  },
});

cap({
  name: 'list_stream_chat', method: 'GET', path: '/event-streams/:id/chat', tag: TAG,
  summary: 'Get last 50 chat messages for a stream',
  auth: 'user',
  input: z.object({ id }),
  handler: async ({ user }, { id: streamId }) => {
    const stream = await loadStream(streamId);
    if (!await canViewStream(user, stream)) throw notFound('Stream');
    const msgs = await many(
      `SELECT m.id, m.sent_at, m.message_enc, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color
       FROM stream_chat_messages m JOIN users u ON u.id=m.user_id
       WHERE m.stream_id=$1 ORDER BY m.sent_at DESC LIMIT 50`,
      [streamId]
    );
    await audit(null, user.id, 'stream_chat_viewed', 'mr_streams', streamId);
    return {
      messages: msgs.reverse().map(m => ({
        id: m.id,
        sent_at: m.sent_at,
        message: decrypt(m.message_enc),
        display_name: m.display_name,
        avatar_url: m.avatar_url,
        avatar_emoji: m.avatar_emoji,
        avatar_color: m.avatar_color,
      })),
    };
  },
});

cap({
  name: 'add_stream_event_marker', method: 'POST', path: '/event-streams/:id/markers', tag: TAG,
  summary: 'Add an event marker to the stream timeline (manager)',
  auth: 'user',
  input: z.object({
    id,
    type: z.enum(MARKER_TYPES),
    minute: z.number().int().min(0),
    label: z.string().min(1).max(100),
    team: z.enum(['home','away']).optional(),
  }),
  handler: async ({ user }, { id: streamId, type, minute, label, team }) => {
    const stream = await loadStream(streamId);
    if (!await canManageStream(user, stream)) throw forbidden('Manager access required');
    const marker = { type, minute, label, team: team ?? null, added_at: new Date().toISOString() };
    await one(
      'UPDATE mr_streams SET event_markers=event_markers || $1::jsonb WHERE id=$2 RETURNING id',
      [JSON.stringify([marker]), streamId]
    );
    return { marker };
  },
});
