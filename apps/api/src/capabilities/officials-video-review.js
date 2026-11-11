// Authorised video & incident review workspace (#1023, R25).
// Match footage with timestamps, multi-angle incident markers, human-authorised review sessions and controlled exports.
// Never automated decision engine — all conclusions are human-authorised. Reuses fixture_officials, game_actions, cases, audit patterns.
import crypto from 'crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, notFound, forbidden } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { fixtureContext } from './match-tracking.js';

const TAG = 'OfficialVideoReview';

const PURPOSES = ['match_record', 'incident_evidence', 'dispute_evidence', 'assessment_footage', 'federation_inquiry'];
const MARKER_TYPES = ['incident', 'warning', 'decision', 'disputed', 'evidence', 'performance', 'advantage'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const REVIEW_TYPES = ['incident_review', 'performance_review', 'dispute_review', 'federation_inquiry', 'appeal_review'];
const REVIEW_STATUSES = ['open', 'in_progress', 'pending_evidence', 'concluded', 'appealed', 'closed'];
const PARTICIPANT_ROLES = ['chair', 'referee', 'umpire', 'organiser', 'assessor', 'federation', 'observer', 'legal'];
const GRANT_ROLES = ['assessor', 'federation', 'legal', 'external_body', 'independent_witness'];
const OUTCOMES = ['upheld', 'dismissed', 'inconclusive', 'deferred', 'referred_to_federation'];

/** Resolve caller's standing on a fixture: organiser/admin, or accepted crew. 404 for anyone else. */
async function standing(user, fixtureId) {
  const x = await fixtureContext(user, fixtureId, pool);
  const crew = await one(
    `SELECT role FROM fixture_officials WHERE fixture_id=$1 AND user_id=$2 AND status='accepted' LIMIT 1`,
    [fixtureId, user.id]
  );
  const admin = isAdmin(user);
  const isRef = x.f.referee_id === user.id;
  if (!x.organiser && !crew && !isRef && !admin) throw notFound('Fixture');
  return { ...x, crew: crew ?? (isRef ? { role: 'referee' } : null), admin, may: x.organiser || admin };
}

/** Check the caller is authorised to access a specific video (crew/organiser/admin OR explicit access grant). */
async function authorised(user, videoId) {
  const vid = await one(`SELECT * FROM official_match_videos WHERE id=$1 AND archived_at IS NULL`, [videoId]);
  if (!vid) throw notFound('Video');
  // Youth consent check
  if (vid.youth_consent_required && !vid.youth_consent_ref) throw forbidden('Youth consent reference required to access this footage');
  const st = await standing(user, vid.fixture_id);
  if (st.may || st.crew) return { vid, st };
  // Explicit access grant
  const grant = await one(
    `SELECT * FROM official_video_access_grants WHERE video_id=$1 AND grantee_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [videoId, user.id]
  );
  if (!grant) throw forbidden('No access to this footage');
  return { vid, st, grant };
}

/** SHA-256 chain: hash(prev_hash || actor_id || action || ts) */
function chainHash(prevHash, actorId, action) {
  return crypto.createHash('sha256').update(`${prevHash ?? ''}:${actorId}:${action}:${Date.now()}`).digest('hex');
}

/** Append one audit entry to official_video_audit. */
async function auditVideo(c, { videoId, sessionId, actorId, action, reason, metadata }) {
  const prev = await one(
    `SELECT hash FROM official_video_audit WHERE ${videoId ? 'video_id=$1' : 'session_id=$1'} ORDER BY created_at DESC LIMIT 1`,
    [videoId ?? sessionId], c
  );
  const hash = chainHash(prev?.hash, actorId, action);
  await c.query(
    `INSERT INTO official_video_audit (video_id, session_id, actor_id, action, reason_enc, metadata, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [videoId ?? null, sessionId ?? null, actorId, action, reason ? encrypt(reason) : null, metadata ? JSON.stringify(metadata) : null, prev?.hash ?? null, hash]
  );
}

// ─── VIDEO UPLOAD & MANAGEMENT ───────────────────────────────────────────────

cap({
  name: 'upload_match_video', method: 'POST', path: '/fixtures/:id/match-videos', tag: TAG,
  summary: 'Upload or register match footage against a fixture. Requires media_rights_clearance. Youth consent ref required when youth_consent_required is true. Accepted crew or organiser only.',
  input: z.object({
    id,
    angle_label: z.enum(['main', 'end-zone', 'sideline', 'broadcast', 'body-cam']).default('main'),
    purpose: z.enum(PURPOSES).default('match_record'),
    game_id: z.string().uuid().optional(),
    federation_code: z.string().max(80).optional(),
    file_key: z.string().min(1).max(500),
    file_size_bytes: z.number().int().positive().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    mime_type: z.string().default('video/mp4'),
    thumbnail_key: z.string().max(500).optional(),
    media_rights_clearance: z.boolean(),
    youth_consent_required: z.boolean().default(false),
    youth_consent_ref: z.string().uuid().optional(),
    retention_days: z.number().int().min(30).max(3650).default(365),
  }),
  async handler({ user }, i) {
    const st = await standing(user, i.id);
    if (!st.may && !st.crew) throw forbidden('Accepted crew or organiser required');
    if (!i.media_rights_clearance) throw badRequest('Media rights clearance must be confirmed before uploading footage');
    if (i.youth_consent_required && !i.youth_consent_ref) throw badRequest('youth_consent_ref required when youth_consent_required is true');
    if (i.game_id) {
      const g = await one(`SELECT id FROM games WHERE id=$1 AND fixture_id=$2`, [i.game_id, i.id]);
      if (!g) throw badRequest('game_id does not belong to this fixture');
    }
    const sport = await one(`SELECT s.slug FROM fixtures f JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id WHERE f.id=$1`, [i.id]);
    const vid = await tx(async (c) => {
      const row = await one(
        `INSERT INTO official_match_videos (fixture_id, game_id, angle_label, purpose, sport, federation_code, file_key, file_size_bytes, duration_ms, mime_type, thumbnail_key, uploaded_by, media_rights_clearance, youth_consent_required, youth_consent_ref, retention_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [i.id, i.game_id ?? null, i.angle_label, i.purpose, sport?.slug ?? 'unknown', i.federation_code ?? null, i.file_key, i.file_size_bytes ?? null, i.duration_ms ?? null, i.mime_type, i.thumbnail_key ?? null, user.id, i.media_rights_clearance, i.youth_consent_required, i.youth_consent_ref ?? null, i.retention_days],
        c
      );
      await auditVideo(c, { videoId: row.id, actorId: user.id, action: 'video_uploaded', metadata: { angle_label: i.angle_label, purpose: i.purpose, file_size_bytes: i.file_size_bytes } });
      return row;
    });
    return { video: serializeVideo(vid) };
  },
});

cap({
  name: 'list_match_videos', method: 'GET', path: '/fixtures/:id/match-videos', tag: TAG,
  summary: 'List all match footage for a fixture, grouped by game. Accepted crew and organiser only.',
  input: z.object({ id, game_id: z.string().uuid().optional() }),
  async handler({ user }, i) {
    await standing(user, i.id);
    const rows = await many(
      `SELECT v.*, u.display_name AS uploader_name,
         (SELECT count(*) FROM official_video_incident_markers m WHERE m.video_id=v.id AND m.archived_at IS NULL)::int AS marker_count,
         (SELECT count(*) FROM official_video_access_grants g WHERE g.video_id=v.id AND g.revoked_at IS NULL)::int AS grant_count
       FROM official_match_videos v JOIN users u ON u.id=v.uploaded_by
       WHERE v.fixture_id=$1 ${i.game_id ? 'AND v.game_id=$2' : ''} AND v.archived_at IS NULL
       ORDER BY v.game_id NULLS LAST, v.angle_label, v.created_at`,
      i.game_id ? [i.id, i.game_id] : [i.id]
    );
    return { videos: rows.map(serializeVideo) };
  },
});

cap({
  name: 'get_match_video', method: 'GET', path: '/match-videos/:id', tag: TAG,
  summary: 'Get a single match video. Audit-logs every access. Access requires fixture crew, organiser, admin, or explicit grant.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { vid } = await authorised(user, i.id);
    await tx(async (c) => {
      await auditVideo(c, { videoId: i.id, actorId: user.id, action: 'video_accessed' });
    });
    const markers = await many(
      `SELECT m.*, u.display_name AS creator_name FROM official_video_incident_markers m JOIN users u ON u.id=m.created_by WHERE m.video_id=$1 AND m.archived_at IS NULL ORDER BY m.timestamp_ms`,
      [i.id]
    );
    return { video: serializeVideo(vid), markers: markers.map(serializeMarker) };
  },
});

cap({
  name: 'update_match_video', method: 'PATCH', path: '/match-videos/:id', tag: TAG,
  summary: 'Update video metadata (angle_label, purpose, federation_code, retention_days). Organiser or admin only.',
  input: z.object({
    id,
    angle_label: z.enum(['main', 'end-zone', 'sideline', 'broadcast', 'body-cam']).optional(),
    purpose: z.enum(PURPOSES).optional(),
    federation_code: z.string().max(80).nullable().optional(),
    retention_days: z.number().int().min(30).max(3650).optional(),
  }),
  async handler({ user }, i) {
    const { vid, st } = await authorised(user, i.id);
    if (!st.may) throw forbidden('Organiser or admin required');
    const fields = [];
    const vals = [];
    let idx = 1;
    for (const f of ['angle_label', 'purpose', 'federation_code', 'retention_days']) {
      if (i[f] !== undefined) { fields.push(`${f}=$${idx++}`); vals.push(i[f]); }
    }
    if (!fields.length) throw badRequest('Nothing to update');
    vals.push(i.id);
    const updated = await one(`UPDATE official_match_videos SET ${fields.join(',')}, updated_at=now(), row_version=row_version+1 WHERE id=$${idx} RETURNING *`, vals);
    await tx(async (c) => { await auditVideo(c, { videoId: i.id, actorId: user.id, action: 'video_metadata_updated', metadata: { fields } }); });
    return { video: serializeVideo(updated) };
  },
});

cap({
  name: 'archive_match_video', method: 'POST', path: '/match-videos/:id/archive', tag: TAG,
  summary: 'Archive a video. Cannot archive before retain_until unless admin. Organiser or admin only.',
  input: z.object({ id, reason: z.string().min(1).max(500) }),
  async handler({ user }, i) {
    const { vid, st } = await authorised(user, i.id);
    if (!st.may) throw forbidden('Organiser or admin required');
    if (vid.archived_at) throw badRequest('Already archived');
    const retainUntil = new Date(vid.created_at);
    retainUntil.setDate(retainUntil.getDate() + vid.retention_days);
    if (!st.admin && new Date() < retainUntil) throw badRequest(`Retention period active until ${retainUntil.toISOString().split('T')[0]}`);
    await tx(async (c) => {
      await c.query(`UPDATE official_match_videos SET archived_at=now(), updated_at=now() WHERE id=$1`, [i.id]);
      await auditVideo(c, { videoId: i.id, actorId: user.id, action: 'video_archived', reason: i.reason });
    });
    return { archived: true };
  },
});

cap({
  name: 'grant_video_access', method: 'POST', path: '/match-videos/:id/access', tag: TAG,
  summary: 'Grant access to a specific video for an assessor, federation, or legal representative. Encrypted reason and expiry required.',
  input: z.object({
    id,
    grantee_id: z.string().uuid(),
    access_role: z.enum(GRANT_ROLES),
    grant_reason: z.string().min(1).max(2000),
    expires_at: z.string().datetime(),
  }),
  async handler({ user }, i) {
    const { st } = await authorised(user, i.id);
    if (!st.may) throw forbidden('Organiser or admin required');
    if (new Date(i.expires_at) <= new Date()) throw badRequest('expires_at must be in the future');
    const grantee = await one(`SELECT id FROM users WHERE id=$1`, [i.grantee_id]);
    if (!grantee) throw notFound('User');
    const grant = await one(
      `INSERT INTO official_video_access_grants (video_id, grantee_id, granted_by, access_role, grant_reason_enc, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (video_id, grantee_id) DO UPDATE SET access_role=EXCLUDED.access_role, grant_reason_enc=EXCLUDED.grant_reason_enc, expires_at=EXCLUDED.expires_at, revoked_at=NULL, revoked_by=NULL
       RETURNING *`,
      [i.id, i.grantee_id, user.id, i.access_role, encrypt(i.grant_reason), i.expires_at]
    );
    await tx(async (c) => { await auditVideo(c, { videoId: i.id, actorId: user.id, action: 'access_granted', metadata: { grantee_id: i.grantee_id, role: i.access_role } }); });
    await notify(i.grantee_id, { kind: 'official_video_access_granted', video_id: i.id, role: i.access_role, expires_at: i.expires_at });
    return { grant: { id: grant.id, grantee_id: grant.grantee_id, access_role: grant.access_role, expires_at: grant.expires_at } };
  },
});

cap({
  name: 'revoke_video_access', method: 'DELETE', path: '/match-videos/:videoId/access/:grantId', tag: TAG,
  summary: 'Revoke an access grant. The original granter or admin may revoke.',
  input: z.object({ videoId: id, grantId: id }),
  async handler({ user }, i) {
    const grant = await one(`SELECT * FROM official_video_access_grants WHERE id=$1 AND video_id=$2`, [i.grantId, i.videoId]);
    if (!grant) throw notFound('Grant');
    const { st } = await authorised(user, i.videoId);
    if (!st.admin && grant.granted_by !== user.id) throw forbidden('Only the granter or admin may revoke');
    await tx(async (c) => {
      await c.query(`UPDATE official_video_access_grants SET revoked_at=now(), revoked_by=$1 WHERE id=$2`, [user.id, i.grantId]);
      await auditVideo(c, { videoId: i.videoId, actorId: user.id, action: 'access_revoked', metadata: { grantee_id: grant.grantee_id } });
    });
    await notify(grant.grantee_id, { kind: 'official_video_access_revoked', video_id: i.videoId });
    return { revoked: true };
  },
});

cap({
  name: 'list_video_access_grants', method: 'GET', path: '/match-videos/:id/access', tag: TAG,
  summary: 'List all access grants on a video. Organiser or admin only.',
  input: z.object({ id, include_revoked: z.boolean().default(false) }),
  async handler({ user }, i) {
    const { st } = await authorised(user, i.id);
    if (!st.may) throw forbidden('Organiser or admin required');
    const rows = await many(
      `SELECT g.id, g.grantee_id, u.display_name AS grantee_name, g.granted_by, g.access_role, g.expires_at, g.revoked_at, g.created_at
       FROM official_video_access_grants g JOIN users u ON u.id=g.grantee_id
       WHERE g.video_id=$1 ${i.include_revoked ? '' : 'AND g.revoked_at IS NULL'}
       ORDER BY g.created_at DESC`,
      [i.id]
    );
    return { grants: rows };
  },
});

// ─── INCIDENT MARKERS ────────────────────────────────────────────────────────

cap({
  name: 'add_incident_marker', method: 'POST', path: '/match-videos/:id/markers', tag: TAG,
  summary: 'Add a timestamped incident marker to a match video. Optionally links to a game_action. Note is encrypted.',
  input: z.object({
    id,
    timestamp_ms: z.number().int().nonnegative(),
    end_timestamp_ms: z.number().int().nonnegative().optional(),
    marker_type: z.enum(MARKER_TYPES),
    sport_event_code: z.string().max(80).optional(),
    angle_ref: z.string().max(80).optional(),
    severity: z.enum(SEVERITIES).default('medium'),
    note: z.string().max(5000).optional(),
    game_action_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    const { vid, st } = await authorised(user, i.id);
    if (!st.may && !st.crew) throw forbidden('Accepted crew or organiser required');
    if (i.end_timestamp_ms != null && i.end_timestamp_ms <= i.timestamp_ms) throw badRequest('end_timestamp_ms must be after timestamp_ms');
    if (i.game_action_id) {
      const ga = await one(`SELECT id FROM game_actions WHERE id=$1 AND game_id IN (SELECT id FROM games WHERE fixture_id=$2)`, [i.game_action_id, vid.fixture_id]);
      if (!ga) throw badRequest('game_action_id does not belong to this fixture');
    }
    const marker = await tx(async (c) => {
      const row = await one(
        `INSERT INTO official_video_incident_markers (video_id, game_action_id, timestamp_ms, end_timestamp_ms, marker_type, sport_event_code, angle_ref, severity, note_enc, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [i.id, i.game_action_id ?? null, i.timestamp_ms, i.end_timestamp_ms ?? null, i.marker_type, i.sport_event_code ?? null, i.angle_ref ?? null, i.severity, i.note ? encrypt(i.note) : null, user.id],
        c
      );
      await auditVideo(c, { videoId: i.id, actorId: user.id, action: 'incident_marker_added', metadata: { marker_type: i.marker_type, severity: i.severity, timestamp_ms: i.timestamp_ms } });
      return row;
    });
    return { marker: serializeMarker(marker) };
  },
});

cap({
  name: 'list_incident_markers', method: 'GET', path: '/match-videos/:id/markers', tag: TAG,
  summary: 'List all incident markers on a video, ordered by timestamp. Authorised access required.',
  input: z.object({ id, marker_type: z.enum(MARKER_TYPES).optional(), severity: z.enum(SEVERITIES).optional() }),
  async handler({ user }, i) {
    await authorised(user, i.id);
    let where = 'WHERE m.video_id=$1 AND m.archived_at IS NULL';
    const vals = [i.id];
    if (i.marker_type) { vals.push(i.marker_type); where += ` AND m.marker_type=$${vals.length}`; }
    if (i.severity) { vals.push(i.severity); where += ` AND m.severity=$${vals.length}`; }
    const markers = await many(
      `SELECT m.*, u.display_name AS creator_name FROM official_video_incident_markers m JOIN users u ON u.id=m.created_by ${where} ORDER BY m.timestamp_ms`,
      vals
    );
    return { markers: markers.map(serializeMarker) };
  },
});

cap({
  name: 'update_incident_marker', method: 'PATCH', path: '/incident-markers/:id', tag: TAG,
  summary: 'Update an incident marker. Append-only note revision — original is preserved in audit.',
  input: z.object({
    id,
    marker_type: z.enum(MARKER_TYPES).optional(),
    sport_event_code: z.string().max(80).optional(),
    severity: z.enum(SEVERITIES).optional(),
    note: z.string().max(5000).optional(),
    angle_ref: z.string().max(80).optional(),
  }),
  async handler({ user }, i) {
    const marker = await one(`SELECT * FROM official_video_incident_markers WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!marker) throw notFound('Marker');
    const { st } = await authorised(user, marker.video_id);
    if (!st.may && marker.created_by !== user.id) throw forbidden('Creator or organiser required');
    const fields = [];
    const vals = [];
    let idx = 1;
    for (const f of ['marker_type', 'sport_event_code', 'severity', 'angle_ref']) {
      if (i[f] !== undefined) { fields.push(`${f}=$${idx++}`); vals.push(i[f]); }
    }
    if (i.note !== undefined) { fields.push(`note_enc=$${idx++}`); vals.push(encrypt(i.note)); }
    if (!fields.length) throw badRequest('Nothing to update');
    fields.push(`row_version=row_version+1`);
    vals.push(i.id);
    const updated = await one(`UPDATE official_video_incident_markers SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, vals);
    await tx(async (c) => { await auditVideo(c, { videoId: marker.video_id, actorId: user.id, action: 'incident_marker_updated', metadata: { marker_id: i.id, fields } }); });
    return { marker: serializeMarker(updated) };
  },
});

cap({
  name: 'resolve_incident_marker', method: 'POST', path: '/incident-markers/:id/resolve', tag: TAG,
  summary: 'Mark an incident marker as resolved. Accepted crew or organiser only.',
  input: z.object({ id, resolution_note: z.string().min(1).max(2000).optional() }),
  async handler({ user }, i) {
    const marker = await one(`SELECT * FROM official_video_incident_markers WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!marker) throw notFound('Marker');
    if (marker.resolved_at) throw badRequest('Already resolved');
    const { st } = await authorised(user, marker.video_id);
    if (!st.may && !st.crew) throw forbidden('Accepted crew or organiser required');
    await tx(async (c) => {
      await c.query(`UPDATE official_video_incident_markers SET resolved_at=now(), resolved_by=$1, row_version=row_version+1 WHERE id=$2`, [user.id, i.id]);
      await auditVideo(c, { videoId: marker.video_id, actorId: user.id, action: 'incident_marker_resolved', metadata: { marker_id: i.id }, reason: i.resolution_note });
    });
    return { resolved: true };
  },
});

cap({
  name: 'get_markers_by_game_action', method: 'GET', path: '/games/:id/incident-markers', tag: TAG,
  summary: 'Get all incident markers linked to actions in a game, across all angles.',
  input: z.object({ id, game_action_id: z.string().uuid().optional() }),
  async handler({ user }, i) {
    const game = await one(`SELECT id, fixture_id FROM games WHERE id=$1`, [i.id]);
    if (!game) throw notFound('Game');
    await standing(user, game.fixture_id);
    let where = `m.archived_at IS NULL AND v.game_id=$1`;
    const vals = [i.id];
    if (i.game_action_id) { vals.push(i.game_action_id); where += ` AND m.game_action_id=$${vals.length}`; }
    const markers = await many(
      `SELECT m.*, v.angle_label, u.display_name AS creator_name
       FROM official_video_incident_markers m
       JOIN official_match_videos v ON v.id=m.video_id
       JOIN users u ON u.id=m.created_by
       WHERE ${where} ORDER BY m.timestamp_ms`,
      vals
    );
    return { markers: markers.map((m) => ({ ...serializeMarker(m), angle_label: m.angle_label })) };
  },
});

cap({
  name: 'bulk_tag_game_actions', method: 'POST', path: '/games/:id/incident-markers/bulk', tag: TAG,
  summary: 'Log multiple incident markers in a single call during live review.',
  input: z.object({
    id,
    markers: z.array(z.object({
      video_id: z.string().uuid(),
      timestamp_ms: z.number().int().nonnegative(),
      marker_type: z.enum(MARKER_TYPES),
      severity: z.enum(SEVERITIES).default('medium'),
      game_action_id: z.string().uuid().optional(),
      sport_event_code: z.string().max(80).optional(),
      note: z.string().max(5000).optional(),
    })).min(1).max(50),
  }),
  async handler({ user }, i) {
    const game = await one(`SELECT id, fixture_id FROM games WHERE id=$1`, [i.id]);
    if (!game) throw notFound('Game');
    const st = await standing(user, game.fixture_id);
    if (!st.may && !st.crew) throw forbidden('Accepted crew or organiser required');
    const created = await tx(async (c) => {
      const rows = [];
      for (const m of i.markers) {
        const vid = await one(`SELECT id, fixture_id FROM official_match_videos WHERE id=$1 AND archived_at IS NULL`, [m.video_id], c);
        if (!vid || vid.fixture_id !== game.fixture_id) throw badRequest(`video_id ${m.video_id} not found on this fixture`);
        const row = await one(
          `INSERT INTO official_video_incident_markers (video_id, game_action_id, timestamp_ms, marker_type, severity, sport_event_code, note_enc, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [m.video_id, m.game_action_id ?? null, m.timestamp_ms, m.marker_type, m.severity, m.sport_event_code ?? null, m.note ? encrypt(m.note) : null, user.id],
          c
        );
        await auditVideo(c, { videoId: m.video_id, actorId: user.id, action: 'incident_marker_added', metadata: { bulk: true, marker_type: m.marker_type } });
        rows.push(row);
      }
      return rows;
    });
    return { markers: created.map(serializeMarker), count: created.length };
  },
});

// ─── REVIEW SESSIONS ─────────────────────────────────────────────────────────

cap({
  name: 'open_review_session', method: 'POST', path: '/fixtures/:id/video-review-sessions', tag: TAG,
  summary: 'Open a human-authorised video review session on a fixture. Never automated — all conclusions require human sign-off.',
  input: z.object({
    id,
    review_type: z.enum(REVIEW_TYPES),
    game_id: z.string().uuid().optional(),
    federation_ref: z.string().max(200).optional(),
  }),
  async handler({ user }, i) {
    const st = await standing(user, i.id);
    if (!st.may && !st.crew) throw forbidden('Accepted crew or organiser required');
    const sport = await one(`SELECT s.slug FROM fixtures f JOIN events e ON e.id=f.event_id JOIN sports s ON s.id=e.sport_id WHERE f.id=$1`, [i.id]);
    const session = await tx(async (c) => {
      const row = await one(
        `INSERT INTO official_video_review_sessions (fixture_id, game_id, initiated_by, review_type, sport, federation_ref)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [i.id, i.game_id ?? null, user.id, i.review_type, sport?.slug ?? 'unknown', i.federation_ref ?? null],
        c
      );
      // Initiator is auto-added as chair
      await c.query(
        `INSERT INTO official_video_review_participants (session_id, user_id, role, added_by, joined_at) VALUES ($1,$2,'chair',$3,now())`,
        [row.id, user.id, user.id]
      );
      await auditVideo(c, { sessionId: row.id, actorId: user.id, action: 'review_session_opened', metadata: { review_type: i.review_type } });
      return row;
    });
    return { session: serializeSession(session) };
  },
});

cap({
  name: 'get_review_session', method: 'GET', path: '/video-review-sessions/:id', tag: TAG,
  summary: 'Get a review session. Participants and fixture crew/organiser may view.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const session = await one(`SELECT * FROM official_video_review_sessions WHERE id=$1`, [i.id]);
    if (!session) throw notFound('Review session');
    const participant = await one(`SELECT role FROM official_video_review_participants WHERE session_id=$1 AND user_id=$2 AND removed_at IS NULL`, [i.id, user.id]);
    const st = await standing(user, session.fixture_id);
    if (!participant && !st.may && !st.crew) throw forbidden('No access to this review session');
    const participants = await many(
      `SELECT p.id, p.user_id, u.display_name, u.avatar_emoji, u.avatar_color, p.role, p.joined_at, p.last_seen_at
       FROM official_video_review_participants p JOIN users u ON u.id=p.user_id
       WHERE p.session_id=$1 AND p.removed_at IS NULL ORDER BY p.joined_at`,
      [i.id]
    );
    const videos = await many(
      `SELECT rv.video_id, v.angle_label, v.purpose, v.duration_ms, v.game_id FROM official_video_review_videos rv JOIN official_match_videos v ON v.id=rv.video_id WHERE rv.session_id=$1`,
      [i.id]
    );
    // Touch last_seen
    await pool.query(`UPDATE official_video_review_participants SET last_seen_at=now() WHERE session_id=$1 AND user_id=$2`, [i.id, user.id]);
    return { session: serializeSession(session), participants, videos };
  },
});

cap({
  name: 'list_review_sessions', method: 'GET', path: '/fixtures/:id/video-review-sessions', tag: TAG,
  summary: 'List all review sessions for a fixture.',
  input: z.object({ id, status: z.enum(REVIEW_STATUSES).optional() }),
  async handler({ user }, i) {
    await standing(user, i.id);
    let where = `fixture_id=$1`;
    const vals = [i.id];
    if (i.status) { vals.push(i.status); where += ` AND status=$${vals.length}`; }
    const sessions = await many(
      `SELECT s.*, (SELECT count(*) FROM official_video_review_participants p WHERE p.session_id=s.id AND p.removed_at IS NULL)::int AS participant_count
       FROM official_video_review_sessions s WHERE ${where} ORDER BY s.created_at DESC`,
      vals
    );
    return { sessions: sessions.map(serializeSession) };
  },
});

cap({
  name: 'add_session_participant', method: 'POST', path: '/video-review-sessions/:id/participants', tag: TAG,
  summary: 'Add a participant to a review session. Chair or organiser only.',
  input: z.object({ id, user_id: z.string().uuid(), role: z.enum(PARTICIPANT_ROLES) }),
  async handler({ user }, i) {
    const session = await one(`SELECT * FROM official_video_review_sessions WHERE id=$1 AND status NOT IN ('concluded','closed')`, [i.id]);
    if (!session) throw notFound('Active review session');
    const chair = await one(`SELECT role FROM official_video_review_participants WHERE session_id=$1 AND user_id=$2 AND role='chair' AND removed_at IS NULL`, [i.id, user.id]);
    const st = await standing(user, session.fixture_id);
    if (!chair && !st.may) throw forbidden('Chair or organiser required');
    const target = await one(`SELECT id FROM users WHERE id=$1`, [i.user_id]);
    if (!target) throw notFound('User');
    await tx(async (c) => {
      await c.query(
        `INSERT INTO official_video_review_participants (session_id, user_id, role, added_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (session_id, user_id) DO UPDATE SET role=EXCLUDED.role, removed_at=NULL`,
        [i.id, i.user_id, i.role, user.id]
      );
      await auditVideo(c, { sessionId: i.id, actorId: user.id, action: 'participant_added', metadata: { user_id: i.user_id, role: i.role } });
    });
    await notify(i.user_id, { kind: 'official_video_review_invited', session_id: i.id, review_type: session.review_type });
    return { added: true };
  },
});

cap({
  name: 'remove_session_participant', method: 'DELETE', path: '/video-review-sessions/:sessionId/participants/:userId', tag: TAG,
  summary: 'Remove a participant from a review session. Chair or admin only.',
  input: z.object({ sessionId: id, userId: id }),
  async handler({ user }, i) {
    const session = await one(`SELECT * FROM official_video_review_sessions WHERE id=$1`, [i.sessionId]);
    if (!session) throw notFound('Review session');
    const chair = await one(`SELECT role FROM official_video_review_participants WHERE session_id=$1 AND user_id=$2 AND role='chair' AND removed_at IS NULL`, [i.sessionId, user.id]);
    const admin = isAdmin(user);
    if (!chair && !admin) throw forbidden('Chair or admin required');
    await tx(async (c) => {
      await c.query(`UPDATE official_video_review_participants SET removed_at=now() WHERE session_id=$1 AND user_id=$2`, [i.sessionId, i.userId]);
      await auditVideo(c, { sessionId: i.sessionId, actorId: user.id, action: 'participant_removed', metadata: { user_id: i.userId } });
    });
    return { removed: true };
  },
});

cap({
  name: 'attach_video_to_session', method: 'POST', path: '/video-review-sessions/:id/videos', tag: TAG,
  summary: 'Attach a match video to a review session. Must be from the same fixture. Authorised access to the video required.',
  input: z.object({ id, video_id: z.string().uuid(), note: z.string().max(2000).optional() }),
  async handler({ user }, i) {
    const session = await one(`SELECT * FROM official_video_review_sessions WHERE id=$1 AND status NOT IN ('concluded','closed')`, [i.id]);
    if (!session) throw notFound('Active review session');
    const { vid } = await authorised(user, i.video_id);
    if (vid.fixture_id !== session.fixture_id) throw badRequest('Video does not belong to the same fixture as this session');
    await tx(async (c) => {
      await c.query(
        `INSERT INTO official_video_review_videos (session_id, video_id, added_by, note_enc) VALUES ($1,$2,$3,$4) ON CONFLICT (session_id, video_id) DO NOTHING`,
        [i.id, i.video_id, user.id, i.note ? encrypt(i.note) : null]
      );
      await auditVideo(c, { sessionId: i.id, actorId: user.id, action: 'video_attached', metadata: { video_id: i.video_id } });
    });
    return { attached: true };
  },
});

cap({
  name: 'add_session_note', method: 'POST', path: '/video-review-sessions/:id/notes', tag: TAG,
  summary: 'Add an encrypted note to a review session. Stored in the audit trail. Participants only.',
  input: z.object({ id, note: z.string().min(1).max(5000) }),
  async handler({ user }, i) {
    const session = await one(`SELECT fixture_id FROM official_video_review_sessions WHERE id=$1 AND status NOT IN ('concluded','closed')`, [i.id]);
    if (!session) throw notFound('Active review session');
    const p = await one(`SELECT id FROM official_video_review_participants WHERE session_id=$1 AND user_id=$2 AND removed_at IS NULL`, [i.id, user.id]);
    if (!p) {
      const st = await standing(user, session.fixture_id);
      if (!st.may) throw forbidden('Not a session participant');
    }
    await tx(async (c) => {
      await auditVideo(c, { sessionId: i.id, actorId: user.id, action: 'session_note', reason: i.note });
    });
    return { noted: true };
  },
});

cap({
  name: 'conclude_review_session', method: 'POST', path: '/video-review-sessions/:id/conclude', tag: TAG,
  summary: 'Conclude a review session with a human-authorised outcome. Chair or organiser only. Sets a 14-day appeal window.',
  input: z.object({
    id,
    outcome: z.string().min(1).max(5000),
    outcome_category: z.enum(OUTCOMES),
    appeal_days: z.number().int().min(1).max(90).default(14),
  }),
  async handler({ user }, i) {
    const session = await one(`SELECT * FROM official_video_review_sessions WHERE id=$1 AND status NOT IN ('concluded','closed')`, [i.id]);
    if (!session) throw notFound('Active review session');
    const chair = await one(`SELECT role FROM official_video_review_participants WHERE session_id=$1 AND user_id=$2 AND role='chair' AND removed_at IS NULL`, [i.id, user.id]);
    const st = await standing(user, session.fixture_id);
    if (!chair && !st.may) throw forbidden('Chair or organiser required');
    const appealDeadline = new Date();
    appealDeadline.setDate(appealDeadline.getDate() + i.appeal_days);
    await tx(async (c) => {
      await c.query(
        `UPDATE official_video_review_sessions SET status='concluded', outcome_enc=$1, outcome_category=$2, concluded_at=now(), concluded_by=$3, appeal_deadline=$4, updated_at=now(), row_version=row_version+1 WHERE id=$5`,
        [encrypt(i.outcome), i.outcome_category, user.id, appealDeadline.toISOString(), i.id]
      );
      await auditVideo(c, { sessionId: i.id, actorId: user.id, action: 'review_session_concluded', metadata: { outcome_category: i.outcome_category, appeal_days: i.appeal_days } });
    });
    // Notify all participants
    const participants = await many(`SELECT user_id FROM official_video_review_participants WHERE session_id=$1 AND removed_at IS NULL`, [i.id]);
    for (const p of participants) {
      if (p.user_id !== user.id) {
        await notify(p.user_id, { kind: 'official_video_review_concluded', session_id: i.id, outcome_category: i.outcome_category, appeal_deadline: appealDeadline.toISOString() });
      }
    }
    return { concluded: true, appeal_deadline: appealDeadline.toISOString() };
  },
});

cap({
  name: 'appeal_review_session', method: 'POST', path: '/video-review-sessions/:id/appeal', tag: TAG,
  summary: 'Appeal a concluded review session. Any participant may appeal before the appeal deadline.',
  input: z.object({ id, appeal_reason: z.string().min(10).max(5000) }),
  async handler({ user }, i) {
    const session = await one(`SELECT * FROM official_video_review_sessions WHERE id=$1 AND status='concluded'`, [i.id]);
    if (!session) throw notFound('Concluded review session');
    if (new Date() > new Date(session.appeal_deadline)) throw forbidden('Appeal deadline has passed');
    const p = await one(`SELECT id FROM official_video_review_participants WHERE session_id=$1 AND user_id=$2 AND removed_at IS NULL`, [i.id, user.id]);
    const st = await standing(user, session.fixture_id);
    if (!p && !st.may && !st.crew) throw forbidden('Not a session participant');
    await tx(async (c) => {
      await c.query(`UPDATE official_video_review_sessions SET status='appealed', appeal_at=now(), updated_at=now(), row_version=row_version+1 WHERE id=$1`, [i.id]);
      await auditVideo(c, { sessionId: i.id, actorId: user.id, action: 'review_session_appealed', reason: i.appeal_reason });
    });
    return { appealed: true };
  },
});

cap({
  name: 'list_session_audit', method: 'GET', path: '/video-review-sessions/:id/audit', tag: TAG,
  summary: 'List the SHA-256 chained audit trail for a review session.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const session = await one(`SELECT fixture_id FROM official_video_review_sessions WHERE id=$1`, [i.id]);
    if (!session) throw notFound('Review session');
    await standing(user, session.fixture_id);
    const rows = await many(
      `SELECT a.id, a.actor_id, u.display_name AS actor_name, a.action, a.prev_hash, a.hash, a.created_at
       FROM official_video_audit a JOIN users u ON u.id=a.actor_id
       WHERE a.session_id=$1 ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`,
      [i.id, i.limit ?? 50, i.offset ?? 0]
    );
    return { audit: rows };
  },
});

// ─── EXPORT WORKFLOW ──────────────────────────────────────────────────────────

cap({
  name: 'request_video_export', method: 'POST', path: '/match-videos/:id/export-requests', tag: TAG,
  summary: 'Request a controlled watermarked export of a match video. Purpose and recipient are required.',
  input: z.object({
    id,
    purpose: z.string().min(10).max(2000),
    recipient_org: z.string().max(200).optional(),
    recipient_name: z.string().max(200).optional(),
  }),
  async handler({ user }, i) {
    const { vid } = await authorised(user, i.id);
    const watermark = `OFFICIAL-EXPORT | ${vid.angle_label.toUpperCase()} | ${new Date().toISOString().split('T')[0]} | REQUESTED BY ${user.id}`;
    const req = await one(
      `INSERT INTO official_video_export_requests (video_id, requested_by, purpose_enc, recipient_org, recipient_name_enc, watermark_text)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [i.id, user.id, encrypt(i.purpose), i.recipient_org ?? null, i.recipient_name ? encrypt(i.recipient_name) : null, watermark]
    );
    await tx(async (c) => { await auditVideo(c, { videoId: i.id, actorId: user.id, action: 'export_requested', metadata: { export_id: req.id } }); });
    // Notify organiser
    const vid2 = await one(`SELECT fixture_id FROM official_match_videos WHERE id=$1`, [i.id]);
    const org = await one(`SELECT organizer_id FROM events e JOIN fixtures f ON f.event_id=e.id WHERE f.id=$1`, [vid2.fixture_id]);
    if (org) await notify(org.organizer_id, { kind: 'official_video_export_requested', video_id: i.id, export_id: req.id });
    return { export_request: serializeExport(req) };
  },
});

cap({
  name: 'list_export_requests', method: 'GET', path: '/match-videos/:id/export-requests', tag: TAG,
  summary: 'List export requests for a video. Organiser or admin only.',
  input: z.object({ id, status: z.string().optional() }),
  async handler({ user }, i) {
    const { st } = await authorised(user, i.id);
    if (!st.may) throw forbidden('Organiser or admin required');
    let where = 'video_id=$1';
    const vals = [i.id];
    if (i.status) { vals.push(i.status); where += ` AND status=$${vals.length}`; }
    const rows = await many(
      `SELECT r.*, u.display_name AS requester_name FROM official_video_export_requests r JOIN users u ON u.id=r.requested_by WHERE ${where} ORDER BY r.created_at DESC`,
      vals
    );
    return { export_requests: rows.map(serializeExport) };
  },
});

cap({
  name: 'approve_export_request', method: 'POST', path: '/export-requests/:id/approve', tag: TAG,
  summary: 'Approve an export request. Sets expiry (max 7 days) and max_downloads. Organiser or admin only.',
  input: z.object({
    id,
    max_downloads: z.number().int().min(1).max(10).default(1),
    expiry_hours: z.number().int().min(1).max(168).default(48),
  }),
  async handler({ user }, i) {
    const req = await one(`SELECT * FROM official_video_export_requests WHERE id=$1 AND status='pending'`, [i.id]);
    if (!req) throw notFound('Pending export request');
    const { st } = await authorised(user, req.video_id);
    if (!st.may) throw forbidden('Organiser or admin required');
    const expires = new Date();
    expires.setHours(expires.getHours() + i.expiry_hours);
    const token = crypto.randomBytes(32).toString('hex');
    await tx(async (c) => {
      await c.query(
        `UPDATE official_video_export_requests SET status='approved', approved_by=$1, download_token=$2, expires_at=$3, max_downloads=$4 WHERE id=$5`,
        [user.id, token, expires.toISOString(), i.max_downloads, i.id]
      );
      await auditVideo(c, { videoId: req.video_id, actorId: user.id, action: 'export_approved', metadata: { export_id: i.id, max_downloads: i.max_downloads, expiry_hours: i.expiry_hours } });
    });
    await notify(req.requested_by, { kind: 'official_video_export_approved', export_id: i.id, expires_at: expires.toISOString() });
    return { approved: true, download_token: token, expires_at: expires.toISOString() };
  },
});

cap({
  name: 'reject_export_request', method: 'POST', path: '/export-requests/:id/reject', tag: TAG,
  summary: 'Reject an export request with an encrypted reason. Organiser or admin only.',
  input: z.object({ id, reason: z.string().min(10).max(2000) }),
  async handler({ user }, i) {
    const req = await one(`SELECT * FROM official_video_export_requests WHERE id=$1 AND status='pending'`, [i.id]);
    if (!req) throw notFound('Pending export request');
    const { st } = await authorised(user, req.video_id);
    if (!st.may) throw forbidden('Organiser or admin required');
    await tx(async (c) => {
      await c.query(`UPDATE official_video_export_requests SET status='rejected', rejected_by=$1, reject_reason_enc=$2 WHERE id=$3`, [user.id, encrypt(i.reason), i.id]);
      await auditVideo(c, { videoId: req.video_id, actorId: user.id, action: 'export_rejected', metadata: { export_id: i.id } });
    });
    await notify(req.requested_by, { kind: 'official_video_export_rejected', export_id: i.id });
    return { rejected: true };
  },
});

cap({
  name: 'download_video_export', method: 'GET', path: '/export-requests/:id/download', tag: TAG,
  summary: 'Download an approved export. Validates token, expiry and download count. Audit-logged.',
  input: z.object({ id, token: z.string().length(64) }),
  async handler({ user }, i) {
    const req = await one(`SELECT * FROM official_video_export_requests WHERE id=$1`, [i.id]);
    if (!req) throw notFound('Export request');
    if (req.status !== 'approved') throw forbidden('Export not approved');
    if (req.download_token !== i.token) throw forbidden('Invalid download token');
    if (req.expires_at && new Date() > new Date(req.expires_at)) throw forbidden('Download link expired');
    if (req.download_count >= req.max_downloads) throw forbidden('Maximum download count reached');
    const vid = await one(`SELECT * FROM official_match_videos WHERE id=$1`, [req.video_id]);
    await tx(async (c) => {
      await c.query(`UPDATE official_video_export_requests SET download_count=download_count+1, delivered_at=COALESCE(delivered_at,now()), status=CASE WHEN download_count+1>=$1 THEN 'delivered' ELSE status END WHERE id=$2`, [req.max_downloads, i.id]);
      await auditVideo(c, { videoId: req.video_id, actorId: user.id, action: 'export_downloaded', metadata: { export_id: i.id, download_count: req.download_count + 1 } });
    });
    return {
      file_key: vid.file_key,
      watermark_text: req.watermark_text,
      angle_label: vid.angle_label,
      mime_type: vid.mime_type,
      download_count: req.download_count + 1,
      max_downloads: req.max_downloads,
    };
  },
});

cap({
  name: 'list_video_audit', method: 'GET', path: '/match-videos/:id/audit', tag: TAG,
  summary: 'List the full SHA-256 chained audit trail for a match video. Organiser or admin only.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { st } = await authorised(user, i.id);
    if (!st.may) throw forbidden('Organiser or admin required');
    const rows = await many(
      `SELECT a.id, a.actor_id, u.display_name AS actor_name, a.action, a.prev_hash, a.hash, a.created_at
       FROM official_video_audit a JOIN users u ON u.id=a.actor_id
       WHERE a.video_id=$1 ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`,
      [i.id, i.limit ?? 50, i.offset ?? 0]
    );
    return { audit: rows };
  },
});

// ─── SERIALIZERS ─────────────────────────────────────────────────────────────

function serializeVideo(v) {
  return {
    id: v.id, fixture_id: v.fixture_id, game_id: v.game_id,
    angle_label: v.angle_label, purpose: v.purpose, sport: v.sport,
    federation_code: v.federation_code, duration_ms: v.duration_ms,
    file_size_bytes: v.file_size_bytes, mime_type: v.mime_type,
    thumbnail_key: v.thumbnail_key, uploaded_by: v.uploaded_by,
    uploader_name: v.uploader_name,
    media_rights_clearance: v.media_rights_clearance,
    youth_consent_required: v.youth_consent_required,
    retention_days: v.retention_days,
    archived_at: v.archived_at,
    marker_count: v.marker_count ?? undefined,
    grant_count: v.grant_count ?? undefined,
    row_version: v.row_version, created_at: v.created_at, updated_at: v.updated_at,
  };
}

function serializeMarker(m) {
  return {
    id: m.id, video_id: m.video_id, game_action_id: m.game_action_id,
    timestamp_ms: m.timestamp_ms, end_timestamp_ms: m.end_timestamp_ms,
    marker_type: m.marker_type, sport_event_code: m.sport_event_code,
    angle_ref: m.angle_ref, severity: m.severity,
    created_by: m.created_by, creator_name: m.creator_name,
    resolved_at: m.resolved_at, resolved_by: m.resolved_by,
    has_note: !!m.note_enc,
    row_version: m.row_version, created_at: m.created_at,
  };
}

function serializeSession(s) {
  return {
    id: s.id, fixture_id: s.fixture_id, game_id: s.game_id,
    initiated_by: s.initiated_by, review_type: s.review_type,
    sport: s.sport, federation_ref: s.federation_ref,
    status: s.status, outcome_category: s.outcome_category,
    concluded_at: s.concluded_at, appeal_deadline: s.appeal_deadline,
    appeal_at: s.appeal_at,
    participant_count: s.participant_count ?? undefined,
    row_version: s.row_version, created_at: s.created_at, updated_at: s.updated_at,
  };
}

function serializeExport(r) {
  return {
    id: r.id, video_id: r.video_id, session_id: r.session_id,
    requested_by: r.requested_by, requester_name: r.requester_name,
    recipient_org: r.recipient_org, status: r.status,
    approved_by: r.approved_by, watermark_text: r.watermark_text,
    expires_at: r.expires_at, download_count: r.download_count,
    max_downloads: r.max_downloads, delivered_at: r.delivered_at,
    created_at: r.created_at,
  };
}
