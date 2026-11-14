// Experience Studio — editorial news authoring for Chapter 1 (Sports News) showcase (#1213).
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, query } from '../db.js';
import { notFound } from '../errors.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'ExperienceStudio';

async function logNews(actorId, actorIp, pageId, newsId, action) {
  await query(
    'INSERT INTO lp_audit_log(page_id, action, actor_id, actor_ip, payload) VALUES ($1,$2,$3,$4,$5)',
    [pageId, action, actorId, actorIp ?? null, JSON.stringify({ news_id: newsId })],
  );
}

cap({
  name: 'lp_list_news',
  method: 'GET',
  path: '/admin/landing/pages/:pageId/news',
  summary: 'List news items for a landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({
    pageId: id,
    status: z.enum(['draft', 'published', 'archived']).optional(),
  }),
  async handler({ user }, { pageId, status }) {
    await mustBePlatformAdmin(user);
    const items = await many(
      `SELECT * FROM lp_news_items WHERE page_id = $1 ${status ? 'AND status = $2' : ''} ORDER BY updated_at DESC`,
      status ? [pageId, status] : [pageId],
    );
    return { items };
  },
});

cap({
  name: 'lp_create_news',
  method: 'POST',
  path: '/admin/landing/pages/:pageId/news',
  summary: 'Create a news item in the studio',
  tag: TAG,
  auth: 'user',
  input: z.object({
    pageId: id,
    category: z.string().trim().min(1).max(60).default('general'),
    headline: z.string().trim().min(2).max(200),
    deck: z.string().trim().max(500).optional(),
    body_md: z.string().max(50000).optional(),
    hero_asset_id: id.optional(),
    sport_id: id.optional(),
  }),
  async handler({ user, req }, { pageId, category, headline, deck, body_md, hero_asset_id, sport_id }) {
    await mustBePlatformAdmin(user);
    const page = await one('SELECT id FROM lp_pages WHERE id = $1', [pageId]);
    if (!page) throw notFound('page');
    const item = await one(
      'INSERT INTO lp_news_items(page_id, category, headline, deck, body_md, hero_asset_id, sport_id, author_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [pageId, category, headline, deck ?? null, body_md ?? null, hero_asset_id ?? null, sport_id ?? null, user.id],
    );
    await logNews(user.id, req.ip, pageId, item.id, 'created');
    return { item };
  },
});

cap({
  name: 'lp_update_news',
  method: 'PATCH',
  path: '/admin/landing/news/:id',
  summary: 'Update a news item',
  tag: TAG,
  auth: 'user',
  input: z.object({
    id,
    headline: z.string().trim().min(2).max(200).optional(),
    deck: z.string().trim().max(500).optional(),
    body_md: z.string().max(50000).optional(),
    hero_asset_id: id.optional(),
    category: z.string().trim().min(1).max(60).optional(),
    sport_id: id.optional(),
  }),
  async handler({ user, req }, { id: newsId, headline, deck, body_md, hero_asset_id, category, sport_id }) {
    await mustBePlatformAdmin(user);
    const sets = [], vals = [newsId];
    if (headline !== undefined) sets.push(`headline = $${vals.push(headline)}`);
    if (deck !== undefined) sets.push(`deck = $${vals.push(deck)}`);
    if (body_md !== undefined) sets.push(`body_md = $${vals.push(body_md)}`);
    if (hero_asset_id !== undefined) sets.push(`hero_asset_id = $${vals.push(hero_asset_id)}`);
    if (category !== undefined) sets.push(`category = $${vals.push(category)}`);
    if (sport_id !== undefined) sets.push(`sport_id = $${vals.push(sport_id)}`);
    if (!sets.length) return { item: await one('SELECT * FROM lp_news_items WHERE id = $1', [newsId]) };
    sets.push('updated_at = now()');
    const item = await one(`UPDATE lp_news_items SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!item) throw notFound('news item');
    await logNews(user.id, req.ip, item.page_id, newsId, 'updated');
    return { item };
  },
});

cap({
  name: 'lp_publish_news',
  method: 'POST',
  path: '/admin/landing/news/:id/publish',
  summary: 'Publish a news item',
  tag: TAG,
  auth: 'user',
  input: z.object({ id }),
  async handler({ user, req }, { id: newsId }) {
    await mustBePlatformAdmin(user);
    const item = await one(
      "UPDATE lp_news_items SET status = 'published', published_at = now(), updated_at = now() WHERE id = $1 AND status != 'archived' RETURNING *",
      [newsId],
    );
    if (!item) throw notFound('news item');
    await logNews(user.id, req.ip, item.page_id, newsId, 'published');
    return { item };
  },
});

cap({
  name: 'lp_archive_news',
  method: 'POST',
  path: '/admin/landing/news/:id/archive',
  summary: 'Archive a news item',
  tag: TAG,
  auth: 'user',
  input: z.object({ id }),
  async handler({ user, req }, { id: newsId }) {
    await mustBePlatformAdmin(user);
    const item = await one(
      "UPDATE lp_news_items SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING *",
      [newsId],
    );
    if (!item) throw notFound('news item');
    await logNews(user.id, req.ip, item.page_id, newsId, 'archived');
    return { item };
  },
});
