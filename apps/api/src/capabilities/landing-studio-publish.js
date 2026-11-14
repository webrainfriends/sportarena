// Experience Studio — manifest compile + publish pipeline + rollback + version history (#1213).
// Builds an immutable versioned manifest from DB state, writes to LANDING_MANIFEST_DIR, creates lp_versions row.
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { notFound, badRequest } from '../errors.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'ExperienceStudio';
const MANIFEST_DIR = process.env.LANDING_MANIFEST_DIR ?? '/tmp/landing-manifests';

async function buildManifest(pageId) {
  const page = await one('SELECT * FROM lp_pages WHERE id = $1', [pageId]);
  if (!page) throw notFound('page');

  const blocks = await many(
    'SELECT * FROM lp_blocks WHERE page_id = $1 AND visible = true ORDER BY position ASC',
    [pageId],
  );

  const news = await many(
    "SELECT * FROM lp_news_items WHERE page_id = $1 AND status = 'published' ORDER BY published_at DESC",
    [pageId],
  );

  const seo = await one('SELECT * FROM lp_seo_metadata WHERE page_id = $1', [pageId]) ?? {};

  // Per-block localisations
  const locRows = await many(
    'SELECT block_id, locale, key, value FROM lp_localisations WHERE block_id = ANY($1)',
    [blocks.map((b) => b.id)],
  );
  const locByBlock = {};
  for (const r of locRows) {
    if (!locByBlock[r.block_id]) locByBlock[r.block_id] = {};
    if (!locByBlock[r.block_id][r.locale]) locByBlock[r.block_id][r.locale] = {};
    locByBlock[r.block_id][r.locale][r.key] = r.value;
  }

  // Block assets
  const assetRows = await many(`
    SELECT ba.block_id, ba.role, a.id, a.storage_key AS url, a.mime_type, a.filename
      FROM lp_block_assets ba
      JOIN lp_assets a ON a.id = ba.asset_id
     WHERE ba.block_id = ANY($1) AND a.archived_at IS NULL
  `, [blocks.map((b) => b.id)]);
  const assetsByBlock = {};
  for (const r of assetRows) {
    if (!assetsByBlock[r.block_id]) assetsByBlock[r.block_id] = [];
    assetsByBlock[r.block_id].push({ id: r.id, url: r.url, role: r.role, mime_type: r.mime_type });
  }

  return {
    schema_version: '1',
    page_slug: page.slug,
    page_title: page.title,
    published_at: new Date().toISOString(),
    seo: {
      meta_title: seo.meta_title ?? null,
      meta_description: seo.meta_description ?? null,
      og_title: seo.og_title ?? null,
      og_description: seo.og_description ?? null,
      og_image_asset_id: seo.og_image_asset_id ?? null,
      canonical_url: seo.canonical_url ?? null,
      structured_data: seo.structured_data ?? null,
    },
    locales: ['en', 'ta', 'te', 'ml', 'mr', 'kn', 'bn', 'or', 'hi', 'si', 'ur', 'id'],
    blocks: blocks.map((b) => ({
      id: b.id,
      block_type: b.block_type,
      position: b.position,
      config: b.config,
      assets: assetsByBlock[b.id] ?? [],
      i18n: locByBlock[b.id] ?? {},
    })),
    news: news.map((n) => ({
      id: n.id,
      sport_id: n.sport_id,
      category: n.category,
      headline: n.headline,
      deck: n.deck,
      body_md: n.body_md,
      hero_asset_id: n.hero_asset_id,
      published_at: n.published_at,
    })),
  };
}

cap({
  name: 'lp_publish',
  method: 'POST',
  path: '/admin/landing/pages/:pageId/publish',
  summary: 'Compile and publish the manifest for a landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({ pageId: id }),
  async handler({ user, req }, { pageId }) {
    await mustBePlatformAdmin(user);

    const manifest = await buildManifest(pageId);
    const manifestJson = JSON.stringify(manifest);
    const manifestHash = createHash('sha256').update(manifestJson).digest('hex');

    // next version number
    const prev = await one('SELECT COALESCE(MAX(version_number),0) AS n FROM lp_versions WHERE page_id = $1', [pageId]);
    const versionNumber = Number(prev.n) + 1;

    const slug = manifest.page_slug;
    const dir = join(MANIFEST_DIR, slug, `v${versionNumber}`);
    await mkdir(dir, { recursive: true });
    const filename = `${manifestHash}.json`;
    await writeFile(join(dir, filename), manifestJson, 'utf8');

    const cdnManifestUrl = `/landing/manifest/${slug}/v${versionNumber}/${filename}`;
    const cdnAssetsUrl = `/landing/assets/${slug}/v${versionNumber}/`;
    const assetBundleHash = createHash('sha256').update(cdnAssetsUrl).digest('hex');

    let versionId;
    await tx(async (client) => {
      const ver = await client.query(
        'INSERT INTO lp_versions(page_id, version_number, manifest_hash, asset_bundle_hash, cdn_manifest_url, cdn_assets_url, published_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [pageId, versionNumber, manifestHash, assetBundleHash, cdnManifestUrl, cdnAssetsUrl, user.id],
      );
      versionId = ver.rows[0].id;
      await client.query(
        "UPDATE lp_pages SET status = 'published', updated_at = now() WHERE id = $1",
        [pageId],
      );
      await client.query(
        'INSERT INTO lp_audit_log(page_id, version_id, action, actor_id, actor_ip, payload) VALUES ($1,$2,$3,$4,$5,$6)',
        [pageId, versionId, 'published', user.id, req.ip ?? null, JSON.stringify({ version_number: versionNumber, manifest_hash: manifestHash })],
      );
    });

    return { version_id: versionId, version_number: versionNumber, manifest_hash: manifestHash, cdn_manifest_url: cdnManifestUrl };
  },
});

cap({
  name: 'lp_rollback',
  method: 'POST',
  path: '/admin/landing/pages/:pageId/rollback',
  summary: 'Roll back to a previous published version',
  tag: TAG,
  auth: 'user',
  input: z.object({
    pageId: id,
    version_id: id,
  }),
  async handler({ user, req }, { pageId, version_id }) {
    await mustBePlatformAdmin(user);
    const target = await one('SELECT * FROM lp_versions WHERE id = $1 AND page_id = $2 AND rolled_back_at IS NULL', [version_id, pageId]);
    if (!target) throw notFound('version or already rolled back');

    await tx(async (client) => {
      await client.query(
        'UPDATE lp_versions SET rolled_back_at = now(), rolled_back_by = $1 WHERE page_id = $2 AND rolled_back_at IS NULL AND id != $3',
        [user.id, pageId, version_id],
      );
      await client.query(
        "UPDATE lp_pages SET updated_at = now(), status = 'published' WHERE id = $1",
        [pageId],
      );
      await client.query(
        'INSERT INTO lp_audit_log(page_id, version_id, action, actor_id, actor_ip, payload) VALUES ($1,$2,$3,$4,$5,$6)',
        [pageId, version_id, 'rolled_back', user.id, req.ip ?? null, JSON.stringify({ to_version: target.version_number })],
      );
    });

    return { rolled_back_to: target.version_number, cdn_manifest_url: target.cdn_manifest_url };
  },
});

cap({
  name: 'lp_list_versions',
  method: 'GET',
  path: '/admin/landing/pages/:pageId/versions',
  summary: 'List published version history for a landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({ pageId: id }),
  async handler({ user }, { pageId }) {
    await mustBePlatformAdmin(user);
    const versions = await many(
      'SELECT id, version_number, manifest_hash, cdn_manifest_url, published_at, rolled_back_at FROM lp_versions WHERE page_id = $1 ORDER BY version_number DESC',
      [pageId],
    );
    return { versions };
  },
});
