// Experience Studio — page inventory and workflow management (#1213).
// Platform-admin-only. All writes are audit-logged.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, query } from '../db.js';
import { notFound } from '../errors.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'ExperienceStudio';

const VALID_STATUS = ['draft', 'review', 'approved', 'published', 'archived'];

async function logPage(actorId, actorIp, pageId, action, payload = null) {
  await query(
    'INSERT INTO lp_audit_log(page_id, action, actor_id, actor_ip, payload) VALUES ($1,$2,$3,$4,$5)',
    [pageId, action, actorId, actorIp ?? null, payload ? JSON.stringify(payload) : null],
  );
}

cap({
  name: 'lp_list_pages',
  method: 'GET',
  path: '/admin/landing/pages',
  summary: 'List all landing pages in the Experience Studio',
  tag: TAG,
  auth: 'user',
  input: z.object({}),
  async handler({ user }) {
    await mustBePlatformAdmin(user);
    const rows = await many(`
      SELECT p.id, p.slug, p.title, p.status, p.created_at, p.updated_at, p.archived_at,
             COUNT(b.id) FILTER (WHERE b.visible) AS block_count,
             MAX(v.version_number) AS latest_version
        FROM lp_pages p
        LEFT JOIN lp_blocks b ON b.page_id = p.id
        LEFT JOIN lp_versions v ON v.page_id = p.id
       WHERE p.archived_at IS NULL
       GROUP BY p.id
       ORDER BY p.updated_at DESC
    `);
    return { pages: rows };
  },
});

cap({
  name: 'lp_create_page',
  method: 'POST',
  path: '/admin/landing/pages',
  summary: 'Create a new landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({
    slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/),
    title: z.string().trim().min(1).max(200),
  }),
  async handler({ user, req }, { slug, title }) {
    await mustBePlatformAdmin(user);
    const page = await one(
      'INSERT INTO lp_pages(slug, title, created_by) VALUES ($1,$2,$3) RETURNING *',
      [slug, title, user.id],
    );
    await logPage(user.id, req.ip, page.id, 'created', { slug, title });
    return { page };
  },
});

cap({
  name: 'lp_get_page',
  method: 'GET',
  path: '/admin/landing/pages/:id',
  summary: 'Get a single landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({ id }),
  async handler({ user }, { id: pageId }) {
    await mustBePlatformAdmin(user);
    const page = await one('SELECT * FROM lp_pages WHERE id = $1', [pageId]);
    if (!page) throw notFound('page');
    return { page };
  },
});

cap({
  name: 'lp_update_page',
  method: 'PATCH',
  path: '/admin/landing/pages/:id',
  summary: 'Update page title or status',
  tag: TAG,
  auth: 'user',
  input: z.object({
    id,
    title: z.string().trim().min(1).max(200).optional(),
    status: z.enum(VALID_STATUS).optional(),
  }),
  async handler({ user, req }, { id: pageId, title, status }) {
    await mustBePlatformAdmin(user);
    const existing = await one('SELECT id FROM lp_pages WHERE id = $1', [pageId]);
    if (!existing) throw notFound('page');
    const sets = [], vals = [pageId];
    if (title !== undefined) { sets.push(`title = $${vals.push(title)}`); }
    if (status !== undefined) { sets.push(`status = $${vals.push(status)}`); }
    if (!sets.length) return { page: existing };
    sets.push(`updated_at = now()`);
    const page = await one(`UPDATE lp_pages SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    await logPage(user.id, req.ip, pageId, 'updated', { title, status });
    return { page };
  },
});

cap({
  name: 'lp_submit_page',
  method: 'POST',
  path: '/admin/landing/pages/:id/submit',
  summary: 'Submit page draft for review',
  tag: TAG,
  auth: 'user',
  input: z.object({ id }),
  async handler({ user, req }, { id: pageId }) {
    await mustBePlatformAdmin(user);
    const page = await one(
      "UPDATE lp_pages SET status = 'review', updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING *",
      [pageId],
    );
    if (!page) throw notFound('page or invalid status transition');
    await logPage(user.id, req.ip, pageId, 'submitted');
    return { page };
  },
});

cap({
  name: 'lp_approve_page',
  method: 'POST',
  path: '/admin/landing/pages/:id/approve',
  summary: 'Approve a page under review',
  tag: TAG,
  auth: 'user',
  input: z.object({ id }),
  async handler({ user, req }, { id: pageId }) {
    await mustBePlatformAdmin(user);
    const page = await one(
      "UPDATE lp_pages SET status = 'approved', updated_at = now() WHERE id = $1 AND status = 'review' RETURNING *",
      [pageId],
    );
    if (!page) throw notFound('page or invalid status transition');
    await logPage(user.id, req.ip, pageId, 'approved');
    return { page };
  },
});

cap({
  name: 'lp_archive_page',
  method: 'POST',
  path: '/admin/landing/pages/:id/archive',
  summary: 'Archive a landing page',
  tag: TAG,
  auth: 'user',
  input: z.object({ id }),
  async handler({ user, req }, { id: pageId }) {
    await mustBePlatformAdmin(user);
    const page = await one(
      "UPDATE lp_pages SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
      [pageId],
    );
    if (!page) throw notFound('page');
    await logPage(user.id, req.ip, pageId, 'archived');
    return { page };
  },
});
