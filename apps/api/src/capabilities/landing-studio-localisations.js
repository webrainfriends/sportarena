// Experience Studio — per-block per-locale key overrides and native-speaker review workflow (#1213).
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, query } from '../db.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'ExperienceStudio';
const LOCALES = ['en', 'ta', 'te', 'ml', 'mr', 'kn', 'bn', 'or', 'hi', 'si', 'ur', 'id'];

cap({
  name: 'lp_list_localisations',
  method: 'GET',
  path: '/admin/landing/blocks/:blockId/localisations',
  summary: 'List all locale overrides for a block',
  tag: TAG,
  auth: 'user',
  input: z.object({ blockId: id }),
  async handler({ user }, { blockId }) {
    await mustBePlatformAdmin(user);
    const rows = await many(
      'SELECT locale, key, value, reviewed, updated_at FROM lp_localisations WHERE block_id = $1 ORDER BY locale, key',
      [blockId],
    );
    // Group by locale for convenience
    const by_locale = {};
    for (const r of rows) {
      if (!by_locale[r.locale]) by_locale[r.locale] = {};
      by_locale[r.locale][r.key] = { value: r.value, reviewed: r.reviewed, updated_at: r.updated_at };
    }
    return { by_locale };
  },
});

cap({
  name: 'lp_upsert_localisation',
  method: 'PUT',
  path: '/admin/landing/blocks/:blockId/localisations/:locale',
  summary: 'Upsert a set of key/value pairs for a block+locale (marks reviewed=false for machine drafts)',
  tag: TAG,
  auth: 'user',
  input: z.object({
    blockId: id,
    locale: z.enum(LOCALES),
    keys: z.record(z.string(), z.string()),
  }),
  async handler({ user }, { blockId, locale, keys }) {
    await mustBePlatformAdmin(user);
    for (const [k, v] of Object.entries(keys)) {
      await query(
        `INSERT INTO lp_localisations(block_id, locale, key, value, reviewed, updated_by)
         VALUES ($1, $2, $3, $4, false, $5)
         ON CONFLICT (block_id, locale, key) DO UPDATE
           SET value = EXCLUDED.value, reviewed = false, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [blockId, locale, k, v, user.id],
      );
    }
    return { saved: Object.keys(keys).length, locale };
  },
});

cap({
  name: 'lp_review_localisation',
  method: 'POST',
  path: '/admin/landing/blocks/:blockId/localisations/:locale/review',
  summary: 'Mark all keys for a block+locale as reviewed by a native speaker',
  tag: TAG,
  auth: 'user',
  input: z.object({
    blockId: id,
    locale: z.enum(LOCALES),
  }),
  async handler({ user }, { blockId, locale }) {
    await mustBePlatformAdmin(user);
    const result = await query(
      'UPDATE lp_localisations SET reviewed = true, updated_by = $1, updated_at = now() WHERE block_id = $2 AND locale = $3',
      [user.id, blockId, locale],
    );
    return { reviewed: result.rowCount };
  },
});

cap({
  name: 'lp_localisation_coverage',
  method: 'GET',
  path: '/admin/landing/localisations/coverage',
  summary: 'Per-locale coverage: % of keys that are reviewed across all blocks',
  tag: TAG,
  auth: 'user',
  input: z.object({}),
  async handler({ user }) {
    await mustBePlatformAdmin(user);
    const rows = await many(`
      SELECT locale,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE reviewed) AS reviewed_count
        FROM lp_localisations
       GROUP BY locale
       ORDER BY locale
    `);
    const coverage = rows.map((r) => ({
      locale: r.locale,
      total: Number(r.total),
      reviewed: Number(r.reviewed_count),
      pct: r.total > 0 ? Math.round((r.reviewed_count / r.total) * 100) : 0,
    }));
    return { coverage };
  },
});
