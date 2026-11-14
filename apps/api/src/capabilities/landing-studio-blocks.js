// Experience Studio — block library management for a landing page (#1213).
// Platform-admin-only. Reorder is atomic via a transaction.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { mustBePlatformAdmin } from '../platform.js';
import { query } from '../db.js';

const TAG = 'ExperienceStudio';

async function logBlock(actorId, actorIp, pageId, blockId, action, payload = null) {
  await query(
    'INSERT INTO lp_audit_log(page_id, block_id, action, actor_id, actor_ip, payload) VALUES ($1,$2,$3,$4,$5,$6)',
    [pageId, blockId, action, actorId, actorIp ?? null, payload ? JSON.stringify(payload) : null],
  );
}

cap({
  name: 'lp_list_blocks',
  method: 'GET',
  path: '/admin/landing/pages/:pageId/blocks',
  summary: 'List blocks for a landing page, ordered by position',
  tag: TAG,
  auth: 'user',
  input: z.object({ pageId: id }),
  async handler({ user }, { pageId }) {
    await mustBePlatformAdmin(user);
    const blocks = await many(
      'SELECT * FROM lp_blocks WHERE page_id = $1 ORDER BY position ASC, created_at ASC',
      [pageId],
    );
    return { blocks };
  },
});

cap({
  name: 'lp_create_block',
  method: 'POST',
  path: '/admin/landing/pages/:pageId/blocks',
  summary: 'Add a block to a landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({
    pageId: id,
    block_type: z.string().trim().min(1).max(80),
    position: z.number().int().min(0).optional(),
    config: z.record(z.unknown()).optional(),
  }),
  async handler({ user, req }, { pageId, block_type, position, config }) {
    await mustBePlatformAdmin(user);
    const page = await one('SELECT id FROM lp_pages WHERE id = $1', [pageId]);
    if (!page) throw notFound('page');
    const pos = position ?? (
      (await one('SELECT COALESCE(MAX(position),0)+1 AS next FROM lp_blocks WHERE page_id = $1', [pageId])).next
    );
    const block = await one(
      'INSERT INTO lp_blocks(page_id, block_type, position, config, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [pageId, block_type, pos, JSON.stringify(config ?? {}), user.id],
    );
    await one('UPDATE lp_pages SET updated_at = now() WHERE id = $1', [pageId]);
    await logBlock(user.id, req.ip, pageId, block.id, 'created', { block_type, position: pos });
    return { block };
  },
});

cap({
  name: 'lp_update_block',
  method: 'PATCH',
  path: '/admin/landing/pages/:pageId/blocks/:id',
  summary: 'Update a block\'s config, visibility, or position',
  tag: TAG,
  auth: 'user',
  input: z.object({
    pageId: id,
    id,
    config: z.record(z.unknown()).optional(),
    visible: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  }),
  async handler({ user, req }, { pageId, id: blockId, config, visible, position }) {
    await mustBePlatformAdmin(user);
    const sets = [], vals = [blockId];
    if (config !== undefined) sets.push(`config = $${vals.push(JSON.stringify(config))}`);
    if (visible !== undefined) sets.push(`visible = $${vals.push(visible)}`);
    if (position !== undefined) sets.push(`position = $${vals.push(position)}`);
    if (!sets.length) throw badRequest('Nothing to update');
    sets.push('updated_at = now()');
    const block = await one(
      `UPDATE lp_blocks SET ${sets.join(', ')} WHERE id = $1 AND page_id = $${vals.push(pageId)} RETURNING *`,
      vals,
    );
    if (!block) throw notFound('block');
    await one('UPDATE lp_pages SET updated_at = now() WHERE id = $1', [pageId]);
    await logBlock(user.id, req.ip, pageId, blockId, 'updated', { config, visible, position });
    return { block };
  },
});

cap({
  name: 'lp_reorder_blocks',
  method: 'POST',
  path: '/admin/landing/pages/:pageId/blocks/reorder',
  summary: 'Reorder blocks atomically for a landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({
    pageId: id,
    order: z.array(id).min(1),
  }),
  async handler({ user, req }, { pageId, order }) {
    await mustBePlatformAdmin(user);
    await tx(async (client) => {
      for (let i = 0; i < order.length; i++) {
        await client.query(
          'UPDATE lp_blocks SET position = $1, updated_at = now() WHERE id = $2 AND page_id = $3',
          [i, order[i], pageId],
        );
      }
      await client.query('UPDATE lp_pages SET updated_at = now() WHERE id = $1', [pageId]);
    });
    await logBlock(user.id, req.ip, pageId, null, 'reordered', { order });
    const blocks = await many(
      'SELECT * FROM lp_blocks WHERE page_id = $1 ORDER BY position ASC',
      [pageId],
    );
    return { blocks };
  },
});

cap({
  name: 'lp_delete_block',
  method: 'DELETE',
  path: '/admin/landing/pages/:pageId/blocks/:id',
  summary: 'Hide a block (sets visible=false; never hard-deletes)',
  tag: TAG,
  auth: 'user',
  input: z.object({ pageId: id, id }),
  async handler({ user, req }, { pageId, id: blockId }) {
    await mustBePlatformAdmin(user);
    const block = await one(
      'UPDATE lp_blocks SET visible = false, updated_at = now() WHERE id = $1 AND page_id = $2 RETURNING *',
      [blockId, pageId],
    );
    if (!block) throw notFound('block');
    await one('UPDATE lp_pages SET updated_at = now() WHERE id = $1', [pageId]);
    await logBlock(user.id, req.ip, pageId, blockId, 'deleted');
    return { block };
  },
});
