// Public landing page manifest pointer (#1213).
// Returns the CDN URL of the current published manifest for the home page.
// No database-heavy queries — just a single row lookup of the latest version pointer.
// auth: 'public' so the client can fetch it without a session.
import { z } from 'zod';
import { cap } from '../registry.js';
import { one } from '../db.js';

cap({
  name: 'lp_get_manifest',
  method: 'GET',
  path: '/landing/manifest',
  summary: 'Get the current published manifest URL for the GotMyGame home page',
  tag: 'Landing',
  auth: 'public',
  input: z.object({
    slug: z.string().default('home'),
  }),
  async handler(_, { slug }) {
    const row = await one(`
      SELECT v.id, v.version_number, v.cdn_manifest_url, v.cdn_assets_url, v.published_at
        FROM lp_versions v
        JOIN lp_pages p ON p.id = v.page_id
       WHERE p.slug = $1
         AND v.rolled_back_at IS NULL
       ORDER BY v.version_number DESC
       LIMIT 1
    `, [slug]);
    // Return null manifest gracefully when no version has been published yet
    if (!row) return { slug, published: false, cdn_manifest_url: null, version_number: 0 };
    return {
      slug,
      published: true,
      cdn_manifest_url: row.cdn_manifest_url,
      cdn_assets_url: row.cdn_assets_url,
      version_number: row.version_number,
      published_at: row.published_at,
      cached_at: new Date().toISOString(),
    };
  },
});
