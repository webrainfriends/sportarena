// Experience Studio — in-memory preview manifest + quality center (#1213).
// Preview builds the manifest without writing to disk or creating a version row.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { notFound } from '../errors.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'ExperienceStudio';
const REQUIRED_LOCALES = ['en', 'ta', 'te', 'ml', 'mr', 'kn', 'bn', 'or', 'hi', 'si', 'ur', 'id'];
const SEO_FIELDS = ['meta_title', 'meta_description', 'og_title'];

async function buildPreviewManifest(pageId) {
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
  const locRows = blocks.length ? await many(
    'SELECT block_id, locale, key, value, reviewed FROM lp_localisations WHERE block_id = ANY($1)',
    [blocks.map((b) => b.id)],
  ) : [];
  const locByBlock = {};
  for (const r of locRows) {
    if (!locByBlock[r.block_id]) locByBlock[r.block_id] = {};
    if (!locByBlock[r.block_id][r.locale]) locByBlock[r.block_id][r.locale] = {};
    locByBlock[r.block_id][r.locale][r.key] = r.value;
  }
  const assetRows = blocks.length ? await many(`
    SELECT ba.block_id, ba.role, a.id, a.storage_key AS url, a.mime_type, a.alt_text_enc IS NOT NULL AS has_alt
      FROM lp_block_assets ba
      JOIN lp_assets a ON a.id = ba.asset_id
     WHERE ba.block_id = ANY($1) AND a.archived_at IS NULL
  `, [blocks.map((b) => b.id)]) : [];
  const assetsByBlock = {};
  for (const r of assetRows) {
    if (!assetsByBlock[r.block_id]) assetsByBlock[r.block_id] = [];
    assetsByBlock[r.block_id].push({ id: r.id, url: r.url, role: r.role, mime_type: r.mime_type, has_alt: r.has_alt });
  }

  return { page, blocks, news, seo, locByBlock, assetsByBlock, locRows };
}

cap({
  name: 'lp_preview',
  method: 'GET',
  path: '/admin/landing/pages/:pageId/preview',
  summary: 'Build an in-memory preview manifest (no publish, no version row)',
  tag: TAG,
  auth: 'user',
  input: z.object({ pageId: id }),
  async handler({ user }, { pageId }) {
    await mustBePlatformAdmin(user);
    const { page, blocks, news, seo, locByBlock, assetsByBlock } = await buildPreviewManifest(pageId);
    return {
      schema_version: '1',
      page_slug: page.slug,
      page_title: page.title,
      preview: true,
      seo,
      locales: REQUIRED_LOCALES,
      blocks: blocks.map((b) => ({
        id: b.id,
        block_type: b.block_type,
        position: b.position,
        config: b.config,
        assets: assetsByBlock[b.id] ?? [],
        i18n: locByBlock[b.id] ?? {},
      })),
      news: news.map((n) => ({ id: n.id, headline: n.headline, deck: n.deck, category: n.category, published_at: n.published_at })),
    };
  },
});

cap({
  name: 'lp_quality_check',
  method: 'POST',
  path: '/admin/landing/pages/:pageId/quality-check',
  summary: 'Run quality checks: locale coverage, alt text, SEO, assets',
  tag: TAG,
  auth: 'user',
  input: z.object({ pageId: id }),
  async handler({ user }, { pageId }) {
    await mustBePlatformAdmin(user);
    const { page, blocks, seo, locByBlock, assetsByBlock, locRows } = await buildPreviewManifest(pageId);
    const issues = [];

    // Check all required locales present for each block
    for (const b of blocks) {
      for (const locale of REQUIRED_LOCALES) {
        if (locale === 'en') continue; // en is the source
        if (!locByBlock[b.id]?.[locale]) {
          issues.push({ severity: 'warning', field: `block.${b.id}.i18n.${locale}`, message: `Block "${b.block_type}" has no ${locale} translation` });
        }
      }
    }

    // Check assets have alt text
    for (const b of blocks) {
      for (const a of (assetsByBlock[b.id] ?? [])) {
        if (!a.has_alt) {
          issues.push({ severity: 'warning', field: `block.${b.id}.asset.${a.id}.alt_text`, message: `Asset in "${b.block_type}" is missing alt text` });
        }
      }
    }

    // Check SEO fields
    for (const f of SEO_FIELDS) {
      if (!seo[f]) {
        issues.push({ severity: 'error', field: `seo.${f}`, message: `SEO field "${f}" is not set` });
      }
    }

    // Check page has at least one block
    if (!blocks.length) {
      issues.push({ severity: 'error', field: 'page.blocks', message: 'Page has no visible blocks' });
    }

    const errors = issues.filter((i) => i.severity === 'error');
    return { passed: errors.length === 0, issue_count: issues.length, issues };
  },
});
