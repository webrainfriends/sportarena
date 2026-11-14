// Experience Studio — landing page asset manager (#1213).
// alt_text is PII-adjacent (may describe a person); encrypted at rest and audit-logged on read.
import { z } from 'zod';
import { cap, id, page as pagination } from '../registry.js';
import { one, many, query } from '../db.js';
import { notFound } from '../errors.js';
import { mustBePlatformAdmin } from '../platform.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';

const TAG = 'ExperienceStudio';

async function logAsset(actorId, actorIp, assetId, action, payload = null) {
  await query(
    'INSERT INTO lp_audit_log(asset_id, action, actor_id, actor_ip, payload) VALUES ($1,$2,$3,$4,$5)',
    [assetId, action, actorId, actorIp ?? null, payload ? JSON.stringify(payload) : null],
  );
}

cap({
  name: 'lp_list_assets',
  method: 'GET',
  path: '/admin/landing/assets',
  summary: 'List landing page assets',
  tag: TAG,
  auth: 'user',
  input: z.object({
    mime_type: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  async handler({ user }, { mime_type, limit, offset }) {
    await mustBePlatformAdmin(user);
    const assets = await many(
      `SELECT id, filename, mime_type, storage_key, size_bytes, created_at, archived_at
         FROM lp_assets
        WHERE archived_at IS NULL
          AND ($1::text IS NULL OR mime_type LIKE $1)
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [mime_type ? `${mime_type}%` : null, limit, offset],
    );
    return { assets };
  },
});

cap({
  name: 'lp_create_asset',
  method: 'POST',
  path: '/admin/landing/assets',
  summary: 'Register an uploaded asset in the studio',
  tag: TAG,
  auth: 'user',
  input: z.object({
    filename: z.string().trim().min(1).max(255),
    mime_type: z.string().trim().min(1).max(100),
    storage_key: z.string().trim().min(1).max(500),
    size_bytes: z.number().int().min(0),
    alt_text: z.string().trim().max(300).optional(),
  }),
  async handler({ user, req }, { filename, mime_type, storage_key, size_bytes, alt_text }) {
    await mustBePlatformAdmin(user);
    const alt_text_enc = alt_text ? encrypt(alt_text) : null;
    const asset = await one(
      'INSERT INTO lp_assets(filename, mime_type, storage_key, size_bytes, alt_text_enc, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, filename, mime_type, storage_key, size_bytes, created_at',
      [filename, mime_type, storage_key, size_bytes, alt_text_enc, user.id],
    );
    await logAsset(user.id, req.ip, asset.id, 'asset_uploaded', { filename, mime_type, size_bytes });
    return { asset };
  },
});

cap({
  name: 'lp_get_asset',
  method: 'GET',
  path: '/admin/landing/assets/:id',
  summary: 'Get an asset including its decrypted alt text',
  tag: TAG,
  auth: 'user',
  input: z.object({ id }),
  async handler({ user, req }, { id: assetId }) {
    await mustBePlatformAdmin(user);
    const row = await one('SELECT * FROM lp_assets WHERE id = $1', [assetId]);
    if (!row) throw notFound('asset');
    const alt_text = row.alt_text_enc ? decrypt(row.alt_text_enc) : null;
    await audit(null, user.id, 'read_landing_asset_alt', 'lp_assets', assetId);
    await logAsset(user.id, req.ip, assetId, 'asset_read');
    return { asset: { ...row, alt_text_enc: undefined, alt_text } };
  },
});

cap({
  name: 'lp_update_asset',
  method: 'PATCH',
  path: '/admin/landing/assets/:id',
  summary: 'Update asset alt text or filename',
  tag: TAG,
  auth: 'user',
  input: z.object({
    id,
    alt_text: z.string().trim().max(300).optional(),
    filename: z.string().trim().min(1).max(255).optional(),
  }),
  async handler({ user, req }, { id: assetId, alt_text, filename }) {
    await mustBePlatformAdmin(user);
    const sets = [], vals = [assetId];
    if (filename !== undefined) sets.push(`filename = $${vals.push(filename)}`);
    if (alt_text !== undefined) sets.push(`alt_text_enc = $${vals.push(encrypt(alt_text))}`);
    if (!sets.length) throw notFound('nothing to update');
    const asset = await one(
      `UPDATE lp_assets SET ${sets.join(', ')} WHERE id = $1 AND archived_at IS NULL RETURNING id, filename, mime_type, storage_key, size_bytes, created_at`,
      vals,
    );
    if (!asset) throw notFound('asset');
    await logAsset(user.id, req.ip, assetId, 'updated', { filename });
    return { asset };
  },
});

cap({
  name: 'lp_archive_asset',
  method: 'POST',
  path: '/admin/landing/assets/:id/archive',
  summary: 'Archive an asset (soft-delete)',
  tag: TAG,
  auth: 'user',
  input: z.object({ id }),
  async handler({ user, req }, { id: assetId }) {
    await mustBePlatformAdmin(user);
    const asset = await one(
      'UPDATE lp_assets SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id',
      [assetId],
    );
    if (!asset) throw notFound('asset');
    await logAsset(user.id, req.ip, assetId, 'asset_archived');
    return { archived: true };
  },
});
