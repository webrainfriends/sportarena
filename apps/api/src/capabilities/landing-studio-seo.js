// Experience Studio — per-page SEO and structured data management (#1213).
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, query } from '../db.js';
import { notFound } from '../errors.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'ExperienceStudio';

cap({
  name: 'lp_get_seo',
  method: 'GET',
  path: '/admin/landing/pages/:pageId/seo',
  summary: 'Get SEO metadata for a landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({ pageId: id }),
  async handler({ user }, { pageId }) {
    await mustBePlatformAdmin(user);
    const seo = await one('SELECT * FROM lp_seo_metadata WHERE page_id = $1', [pageId]);
    return { seo: seo ?? null };
  },
});

cap({
  name: 'lp_upsert_seo',
  method: 'PUT',
  path: '/admin/landing/pages/:pageId/seo',
  summary: 'Upsert SEO metadata for a landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({
    pageId: id,
    meta_title: z.string().trim().max(120).optional(),
    meta_description: z.string().trim().max(300).optional(),
    og_title: z.string().trim().max(120).optional(),
    og_description: z.string().trim().max(300).optional(),
    og_image_asset_id: id.optional(),
    canonical_url: z.string().url().max(500).optional(),
    structured_data: z.record(z.unknown()).optional(),
  }),
  async handler({ user }, { pageId, meta_title, meta_description, og_title, og_description, og_image_asset_id, canonical_url, structured_data }) {
    await mustBePlatformAdmin(user);
    const page = await one('SELECT id FROM lp_pages WHERE id = $1', [pageId]);
    if (!page) throw notFound('page');
    const seo = await one(`
      INSERT INTO lp_seo_metadata(page_id, meta_title, meta_description, og_title, og_description, og_image_asset_id, canonical_url, structured_data, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (page_id) DO UPDATE SET
        meta_title = COALESCE(EXCLUDED.meta_title, lp_seo_metadata.meta_title),
        meta_description = COALESCE(EXCLUDED.meta_description, lp_seo_metadata.meta_description),
        og_title = COALESCE(EXCLUDED.og_title, lp_seo_metadata.og_title),
        og_description = COALESCE(EXCLUDED.og_description, lp_seo_metadata.og_description),
        og_image_asset_id = COALESCE(EXCLUDED.og_image_asset_id, lp_seo_metadata.og_image_asset_id),
        canonical_url = COALESCE(EXCLUDED.canonical_url, lp_seo_metadata.canonical_url),
        structured_data = COALESCE(EXCLUDED.structured_data, lp_seo_metadata.structured_data),
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING *
    `, [pageId, meta_title ?? null, meta_description ?? null, og_title ?? null, og_description ?? null,
        og_image_asset_id ?? null, canonical_url ?? null, structured_data ? JSON.stringify(structured_data) : null, user.id]);
    return { seo };
  },
});
