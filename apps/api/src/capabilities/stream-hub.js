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
import { canManageTeam } from './teams.js';

const TAG = 'Stream hub';
const MARKER_TYPES = ['goal','card','sub','try','wicket','point','other'];

cap({
  name: 'get_family_stream_feed', method: 'GET', path: '/me/stream-feed', tag: TAG,
  summary: 'Personalised stream feed for a guardian: live, upcoming, replays, discover',
  auth: 'user',
  input: z.object({}),
  handler: async ({ user }) => {
    // teams where user's guardian-linked children play
    const childTeams = await many(
      `SELECT DISTINCT tm.team_id, c.id AS child_id, c.display_name AS child_name
       FROM guardian_links gl
       JOIN users c ON c.id=gl.youth_id
       JOIN team_members tm ON tm.user_id=c.id AND tm.left_at IS NULL
       WHERE gl.guardian_id=$1 AND gl.status='active'`,
      [user.id]
    );
    const teamIds = [...new Set(childTeams.map(r => r.team_id))];
    const childByTeam = {};
    for (const r of childTeams) { childByTeam[r.team_id] = { id: r.child_id, name: r.child_name }; }

    const annotate = (streams) => streams.map(s => ({
      ...s,
      child_playing: !!(childByTeam[s.team_id]),
      child_name: childByTeam[s.team_id]?.name ?? null,
    }));

    const teamFilter = teamIds.length > 0 ? `AND e.team_id = ANY($1::uuid[])` : 'AND false';
    const p = teamIds.length > 0 ? [teamIds] : [];

    const liveNow = teamIds.length > 0 ? await many(
      `SELECT es.*, e.name AS event_name, e.starts_at, e.team_id, t.name AS team_name, t.emoji AS team_emoji
       FROM event_streams es JOIN events e ON e.id=es.event_id JOIN teams t ON t.id=e.team_id
       WHERE es.is_live=true ${teamFilter}`,
      p
    ) : [];

    const upcoming = teamIds.length > 0 ? await many(
      `SELECT es.*, e.name AS event_name, e.starts_at, e.team_id, t.name AS team_name, t.emoji AS team_emoji
       FROM event_streams es JOIN events e ON e.id=es.event_id JOIN teams t ON t.id=e.team_id
       WHERE es.is_live=false AND es.is_replay=false AND e.starts_at BETWEEN now() AND now()+interval'7 days' ${teamFilter}
       ORDER BY e.starts_at LIMIT 20`,
      p
    ) : [];

    const replays = teamIds.length > 0 ? await many(
      `SELECT es.*, e.name AS event_name, e.starts_at, e.team_id, t.name AS team_name, t.emoji AS team_emoji
       FROM event_streams es JOIN events e ON e.id=es.event_id JOIN teams t ON t.id=e.team_id
       WHERE es.is_replay=true AND es.replay_url IS NOT NULL AND es.replay_available_at > now()-interval'30 days' ${teamFilter}
       ORDER BY es.replay_available_at DESC LIMIT 20`,
      p
    ) : [];

    // Discover: 10 latest public live streams from other orgs (no team filter)
    const discover = await many(
      `SELECT es.*, e.name AS event_name, e.starts_at, e.team_id, t.name AS team_name, t.emoji AS team_emoji
       FROM event_streams es JOIN events e ON e.id=es.event_id JOIN teams t ON t.id=e.team_id
       WHERE es.is_live=true AND es.stream_url IS NOT NULL
       ORDER BY e.starts_at DESC LIMIT 10`
    );

    return {
      live_now: annotate(liveNow),
      upcoming: annotate(upcoming),
      recently_ended: annotate(replays),
      discover: discover.map(s => ({ ...s, child_playing: false, child_name: null })),
    };
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
    const stream = await one('SELECT es.*, e.team_id FROM event_streams es JOIN events e ON e.id=es.event_id WHERE es.id=$1', [streamId]);
    if (!stream) throw notFound('Stream');
    const team = await one('SELECT * FROM teams WHERE id=$1', [stream.team_id]);
    if (!await canManageTeam(user, team) && !isAdmin(user)) throw forbidden('Manager access required');
    await one(
      `UPDATE event_streams SET is_replay=true, replay_url=$1, replay_available_at=now(),
         duration_seconds=$2, event_markers=COALESCE($3::jsonb,'[]'::jsonb),
         offline_download_url=$4
       WHERE id=$5`,
      [replay_url, duration_seconds ?? null, event_markers ? JSON.stringify(event_markers) : null, offline_download_url ?? null, streamId]
    );
    // notify all subscribers following this team
    const subs = await many('SELECT user_id FROM stream_alert_subscriptions WHERE team_id=$1', [stream.team_id]);
    for (const s of subs) {
      await notify(s.user_id, {
        title: 'Replay available',
        body: `${team.name} replay is now available to watch`,
        data: { type: 'replay_available', stream_id: streamId, team_id: stream.team_id },
      });
    }
    return { saved: true, notified: subs.length };
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
    const stream = await one('SELECT es.*, e.team_id FROM event_streams es JOIN events e ON e.id=es.event_id WHERE es.id=$1', [streamId]);
    if (!stream) throw notFound('Stream');
    const team = await one('SELECT * FROM teams WHERE id=$1', [stream.team_id]);
    if (!await canManageTeam(user, team) && !isAdmin(user)) throw forbidden('Manager access required');
    await one('UPDATE event_streams SET camera_feeds=$1::jsonb WHERE id=$2', [JSON.stringify(camera_feeds), streamId]);
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
    const stream = await one('SELECT es.*, e.team_id FROM event_streams es JOIN events e ON e.id=es.event_id WHERE es.id=$1', [streamId]);
    if (!stream) throw notFound('Stream');
    const team = await one('SELECT * FROM teams WHERE id=$1', [stream.team_id]);
    if (!await canManageTeam(user, team) && !isAdmin(user)) throw forbidden('Manager access required');
    await one('UPDATE event_streams SET quality_options=$1::jsonb WHERE id=$2', [JSON.stringify(quality_options), streamId]);
    return { saved: true };
  },
});

cap({
  name: 'list_team_stream_archive', method: 'GET', path: '/teams/:team_id/stream-archive', tag: TAG,
  summary: 'Get all streams (live, replay) for a team, paginated',
  auth: 'user',
  input: z.object({ team_id: id, ...page }),
  handler: async ({ user }, { team_id, limit = 20, offset = 0 }) => {
    const streams = await many(
      `SELECT es.*, e.name AS event_name, e.starts_at
       FROM event_streams es JOIN events e ON e.id=es.event_id
       WHERE e.team_id=$1
       ORDER BY e.starts_at DESC LIMIT $2 OFFSET $3`,
      [team_id, limit, offset]
    );
    const total = await one('SELECT COUNT(*) AS n FROM event_streams es JOIN events e ON e.id=es.event_id WHERE e.team_id=$1', [team_id]);
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
      `SELECT s.*, t.name AS team_name, t.emoji AS team_emoji, t.avatar_url AS team_logo
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
    const stream = await one('SELECT id, allow_family_chat FROM event_streams WHERE id=$1', [streamId]);
    if (!stream) throw notFound('Stream');
    if (!stream.allow_family_chat) throw forbidden('Chat is disabled for this stream');
    // simple rate limit: 5 messages per minute per user per stream
    const recent = await one(
      'SELECT COUNT(*) AS n FROM stream_chat_messages WHERE stream_id=$1 AND user_id=$2 AND sent_at > now()-interval\'1 minute\'',
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
    const stream = await one('SELECT id FROM event_streams WHERE id=$1', [streamId]);
    if (!stream) throw notFound('Stream');
    const msgs = await many(
      `SELECT m.id, m.sent_at, m.message_enc, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color
       FROM stream_chat_messages m JOIN users u ON u.id=m.user_id
       WHERE m.stream_id=$1 ORDER BY m.sent_at DESC LIMIT 50`,
      [streamId]
    );
    await audit(null, user.id, 'stream_chat_viewed', 'event_streams', streamId);
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
    const stream = await one('SELECT es.*, e.team_id FROM event_streams es JOIN events e ON e.id=es.event_id WHERE es.id=$1', [streamId]);
    if (!stream) throw notFound('Stream');
    const teamRow = await one('SELECT * FROM teams WHERE id=$1', [stream.team_id]);
    if (!await canManageTeam(user, teamRow) && !isAdmin(user)) throw forbidden('Manager access required');
    const marker = { type, minute, label, team: team ?? null, added_at: new Date().toISOString() };
    await one(
      `UPDATE event_streams SET event_markers=event_markers || $1::jsonb WHERE id=$2`,
      [JSON.stringify([marker]), streamId]
    );
    return { marker };
  },
});
