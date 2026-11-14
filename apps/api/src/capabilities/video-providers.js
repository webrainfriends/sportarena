// Provider-neutral video adapter (issue #565): connect Hudl, Veo, Catapult, StatsPerform,
// YouTube and custom providers via encrypted OAuth tokens, sync external video sources and
// map them to local passport_videos entries. Tokens are NEVER returned in responses.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';

const TAG = 'Video';
const PROVIDERS = ['hudl', 'veo', 'catapult', 'statsperform', 'youtube', 'vimeo', 'wyscout', 'instat', 'custom'];
const SYNC_STATES = ['idle', 'syncing', 'done', 'error', 'partial'];

async function requireAdmin(user) {
  if (!isAdmin(user)) throw forbidden();
}

async function orgAdmin(user, orgId) {
  if (isAdmin(user)) return;
  const m = await one(
    `SELECT id, role FROM organisation_members WHERE organisation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [orgId, user.id]
  );
  if (!m) throw forbidden();
  if (!['owner', 'admin'].includes(m.role)) throw forbidden();
}

async function orgMember(user, orgId) {
  const m = await one(
    `SELECT id FROM organisation_members WHERE organisation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [orgId, user.id]
  );
  if (!m && !isAdmin(user)) throw forbidden();
}

cap({
  name: 'list_providers',
  method: 'GET',
  path: '/organisations/:org_id/video/providers',
  tag: TAG,
  auth: ['admin'],
  status: 200,
  summary: 'List connected video providers for an organisation (tokens never returned)',
  input: z.object({ org_id: id }),
  async handler({ user }, i) {
    await orgAdmin(user, i.org_id);
    const rows = await many(
      `SELECT
         vpt.provider,
         vpt.id AS token_id,
         vpt.scopes,
         vpt.revoked_at IS NULL AS connected,
         vpt.expires_at,
         vpt.created_at AS connected_at,
         COALESCE(stats.source_count, 0) AS source_count,
         COALESCE(stats.imported_count, 0) AS imported_count,
         COALESCE(stats.last_synced_at, NULL) AS last_synced_at,
         COALESCE(stats.sync_state, 'idle') AS sync_state
       FROM video_provider_tokens vpt
       LEFT JOIN (
         SELECT provider, org_id,
                COUNT(*) AS source_count,
                COUNT(*) FILTER (WHERE local_video_id IS NOT NULL) AS imported_count,
                MAX(last_synced_at) AS last_synced_at,
                MAX(sync_state) AS sync_state
         FROM video_provider_sources
         WHERE org_id = $1
         GROUP BY provider, org_id
       ) stats ON stats.provider = vpt.provider
       WHERE vpt.org_id = $1 AND vpt.revoked_at IS NULL
       ORDER BY vpt.provider`,
      [i.org_id]
    );
    return rows;
  },
});

cap({
  name: 'connect_provider',
  method: 'POST',
  path: '/organisations/:org_id/video/providers/:provider/connect',
  tag: TAG,
  auth: ['admin'],
  status: 201,
  summary: 'Connect a video provider by storing a client-encrypted OAuth token',
  input: z.object({
    org_id: id,
    provider: z.enum(PROVIDERS),
    token_enc: z.string().min(1),
    scopes: z.array(z.string().trim().max(80)).default([]),
    expires_at: z.string().datetime().optional(),
    external_account_id: z.string().trim().max(200).optional(),
  }),
  async handler({ user }, i) {
    await orgAdmin(user, i.org_id);
    const existing = await one(
      `SELECT id FROM video_provider_tokens WHERE org_id = $1 AND provider = $2 AND revoked_at IS NULL`,
      [i.org_id, i.provider]
    );
    if (existing) throw conflict('Provider already connected; disconnect first');
    const row = await one(
      `INSERT INTO video_provider_tokens
         (org_id, provider, token_enc, scopes, expires_at, external_account_id, connected_by)
       VALUES ($1,$2,$3,$4::text[],$5,$6,$7) RETURNING id, org_id, provider, scopes, expires_at, created_at`,
      [i.org_id, i.provider, i.token_enc, i.scopes, i.expires_at ?? null, i.external_account_id ?? null, user.id]
    );
    return row;
  },
});

cap({
  name: 'disconnect_provider',
  method: 'POST',
  path: '/organisations/:org_id/video/providers/:provider/disconnect',
  tag: TAG,
  auth: ['admin'],
  status: 200,
  summary: 'Disconnect a video provider by revoking its token',
  input: z.object({ org_id: id, provider: z.enum(PROVIDERS) }),
  async handler({ user }, i) {
    await orgAdmin(user, i.org_id);
    const token = await one(
      `SELECT id FROM video_provider_tokens WHERE org_id = $1 AND provider = $2 AND revoked_at IS NULL`,
      [i.org_id, i.provider]
    );
    if (!token) throw notFound('Provider not connected');
    await one(
      `UPDATE video_provider_tokens SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING id`,
      [token.id, user.id]
    );
    return { disconnected: true };
  },
});

cap({
  name: 'sync_provider',
  method: 'POST',
  path: '/organisations/:org_id/video/providers/:provider/sync',
  tag: TAG,
  auth: ['admin'],
  status: 202,
  summary: 'Trigger a background sync of videos from a connected provider',
  input: z.object({
    org_id: id,
    provider: z.enum(PROVIDERS),
    since: z.string().datetime().optional(),
    max_items: z.number().int().min(1).max(1000).default(200),
  }),
  async handler({ user }, i) {
    await orgAdmin(user, i.org_id);
    const token = await one(
      `SELECT id FROM video_provider_tokens WHERE org_id = $1 AND provider = $2 AND revoked_at IS NULL`,
      [i.org_id, i.provider]
    );
    if (!token) throw notFound('Provider not connected');
    const job = await one(
      `INSERT INTO video_provider_sync_jobs (org_id, provider, token_id, requested_by, since, max_items, status)
       VALUES ($1,$2,$3,$4,$5,$6,'queued') RETURNING id, status, created_at`,
      [i.org_id, i.provider, token.id, user.id, i.since ?? null, i.max_items]
    );
    return { job_id: job.id, status: job.status, queued_at: job.created_at };
  },
});

cap({
  name: 'list_provider_sources',
  method: 'GET',
  path: '/organisations/:org_id/video/providers/:provider/sources',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'List external video sources from a connected provider',
  input: z.object({
    org_id: id,
    provider: z.enum(PROVIDERS),
    sync_state: z.enum(SYNC_STATES).optional(),
    imported: z.boolean().optional(),
    ...page.shape,
  }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    return many(
      `SELECT vps.id, vps.provider, vps.external_id, vps.sync_state,
              vps.local_video_id, vps.last_synced_at, vps.created_at,
              pv.title AS local_title
       FROM video_provider_sources vps
       LEFT JOIN passport_videos pv ON pv.id = vps.local_video_id
       WHERE vps.org_id = $1
         AND vps.provider = $2
         AND ($3::text IS NULL OR vps.sync_state = $3)
         AND ($4::boolean IS NULL OR (vps.local_video_id IS NOT NULL) = $4)
       ORDER BY vps.last_synced_at DESC NULLS LAST
       LIMIT $5 OFFSET $6`,
      [i.org_id, i.provider, i.sync_state ?? null, i.imported ?? null, i.limit, i.offset]
    );
  },
});

cap({
  name: 'import_provider_source',
  method: 'POST',
  path: '/video/provider-sources/:id/import',
  tag: TAG,
  auth: ['admin'],
  status: 200,
  summary: 'Link an external provider source to a local passport_video entry',
  input: z.object({
    id,
    local_video_id: id.optional(),
    create_new: z.boolean().default(false),
    title: z.string().trim().max(200).optional(),
  }),
  async handler({ user }, i) {
    const src = await one(`SELECT * FROM video_provider_sources WHERE id = $1`, [i.id]);
    if (!src) throw notFound();
    await orgAdmin(user, src.org_id);
    if (!i.local_video_id && !i.create_new) throw badRequest('local_video_id or create_new=true required');
    return tx(async (c) => {
      let videoId = i.local_video_id;
      if (i.create_new && !videoId) {
        const v = await c.one(
          `INSERT INTO passport_videos (user_id, title, source, provenance_ref, visibility)
           VALUES ($1,$2,'link',$3,'private') RETURNING id`,
          [user.id, i.title ?? src.external_id, `${src.provider}:${src.external_id}`]
        );
        videoId = v.id;
      }
      return c.one(
        `UPDATE video_provider_sources
         SET local_video_id = $2, sync_state = 'done', last_synced_at = now()
         WHERE id = $1 RETURNING id, provider, external_id, local_video_id, sync_state`,
        [i.id, videoId]
      );
    });
  },
});

cap({
  name: 'get_provider_sync_status',
  method: 'GET',
  path: '/organisations/:org_id/video/providers/status',
  tag: TAG,
  auth: ['admin', 'coach'],
  status: 200,
  summary: 'Get a summary of all video provider sync states for an organisation',
  input: z.object({ org_id: id }),
  async handler({ user }, i) {
    await orgMember(user, i.org_id);
    const providers = await many(
      `SELECT
         vpt.provider,
         vpt.revoked_at IS NULL AS connected,
         vpt.expires_at,
         COALESCE(src.source_count, 0) AS source_count,
         COALESCE(src.imported_count, 0) AS imported_count,
         src.last_synced_at,
         COALESCE(jobs.last_status, 'idle') AS last_job_status,
         jobs.last_job_at
       FROM video_provider_tokens vpt
       LEFT JOIN (
         SELECT provider, org_id,
                COUNT(*) AS source_count,
                COUNT(*) FILTER (WHERE local_video_id IS NOT NULL) AS imported_count,
                MAX(last_synced_at) AS last_synced_at
         FROM video_provider_sources WHERE org_id = $1 GROUP BY provider, org_id
       ) src ON src.provider = vpt.provider
       LEFT JOIN (
         SELECT provider, org_id, status AS last_status, MAX(created_at) AS last_job_at
         FROM video_provider_sync_jobs WHERE org_id = $1
         GROUP BY provider, org_id, status
       ) jobs ON jobs.provider = vpt.provider
       WHERE vpt.org_id = $1
       ORDER BY vpt.provider`,
      [i.org_id]
    );
    return providers;
  },
});
