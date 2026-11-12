import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { forbidden, notFound } from '../errors.js';

const CTX = 'physio_education_items';
const enc = (v) => encrypt(v, `${CTX}.body`);
const dec = (v) => (v ? decrypt(v, `${CTX}.body`) : null);
const decRow = (r) => r ? { ...r, body: dec(r.body_enc), body_enc: undefined } : r;

cap({
  name: 'create_physio_education_item', method: 'POST', path: '/physio/education',
  tag: 'Physio', auth: true, summary: 'Create a patient education content item',
  input: z.object({
    title: z.string().min(1).max(300),
    body: z.string().min(1).max(20000),
    category: z.string().max(100).default('general'),
    tags: z.array(z.string()).default([]),
    media_urls: z.array(z.string().url()).default([]),
    is_public: z.boolean().default(false),
  }),
  handler: async ({ user }, i) => {
    return one(
      `INSERT INTO physio_education_items (provider_id, title, body_enc, category, tags, media_urls, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, provider_id, title, category, tags, is_public, created_at`,
      [user.id, i.title, enc(i.body), i.category, JSON.stringify(i.tags), JSON.stringify(i.media_urls), i.is_public],
    );
  },
});

cap({
  name: 'update_physio_education_item', method: 'PATCH', path: '/physio/education/:id',
  tag: 'Physio', auth: true, summary: 'Update an education item',
  input: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).max(300).optional(),
    body: z.string().min(1).max(20000).optional(),
    category: z.string().max(100).optional(),
    tags: z.array(z.string()).optional(),
    is_public: z.boolean().optional(),
  }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id FROM physio_education_items WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    return one(
      `UPDATE physio_education_items SET
        title    = COALESCE($2, title),
        body_enc = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE body_enc END,
        category = COALESCE($4, category),
        tags     = COALESCE($5::jsonb, tags),
        is_public = COALESCE($6, is_public),
        updated_at = now()
       WHERE id=$1 RETURNING id, provider_id, title, category, tags, is_public, updated_at`,
      [i.id, i.title ?? null, i.body !== undefined ? enc(i.body) : null, i.category ?? null, i.tags ? JSON.stringify(i.tags) : null, i.is_public ?? null],
    );
  },
});

cap({
  name: 'archive_physio_education_item', method: 'POST', path: '/physio/education/:id/archive',
  tag: 'Physio', auth: true, summary: 'Archive an education item',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id FROM physio_education_items WHERE id=$1`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    return one(`UPDATE physio_education_items SET archived_at=now() WHERE id=$1 RETURNING id`, [i.id]);
  },
});

cap({
  name: 'list_physio_education_library', method: 'GET', path: '/physio/education',
  tag: 'Physio', auth: true, summary: 'Provider: list own education items',
  input: z.object({ category: z.string().optional() }),
  handler: async ({ user }, i) => {
    return many(
      `SELECT id, title, category, tags, is_public, created_at, archived_at
       FROM physio_education_items
       WHERE provider_id=$1 AND archived_at IS NULL
         AND ($2::text IS NULL OR category=$2)
       ORDER BY created_at DESC`,
      [user.id, i.category ?? null],
    );
  },
});

cap({
  name: 'assign_physio_education', method: 'POST', path: '/physio/education/:id/assign',
  tag: 'Physio', auth: true, summary: 'Assign an education item to a patient',
  input: z.object({ id: z.string().uuid(), patient_id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    return one(
      `INSERT INTO physio_education_assignments (item_id, patient_id, provider_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *`,
      [i.id, i.patient_id, user.id],
    );
  },
});

cap({
  name: 'list_my_physio_education', method: 'GET', path: '/physio/my-education',
  tag: 'Physio', auth: true, summary: 'Education items assigned to me (patient)',
  input: z.object({}),
  handler: async ({ user }) => {
    return many(
      `SELECT ea.id, ea.assigned_at, ea.read_at, ea.acknowledged_at,
              ei.id AS item_id, ei.title, ei.category, ei.tags, ei.media_urls
       FROM physio_education_assignments ea
       JOIN physio_education_items ei ON ei.id=ea.item_id
       WHERE ea.patient_id=$1 AND ei.archived_at IS NULL
       ORDER BY ea.assigned_at DESC`,
      [user.id],
    );
  },
});

cap({
  name: 'acknowledge_physio_education', method: 'POST', path: '/physio/education/assignments/:id/acknowledge',
  tag: 'Physio', auth: true, summary: 'Mark an education assignment as read and acknowledged',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    return one(
      `UPDATE physio_education_assignments
       SET read_at=COALESCE(read_at,now()), acknowledged_at=now()
       WHERE id=$1 AND patient_id=$2 RETURNING id, acknowledged_at`,
      [i.id, user.id],
    );
  },
});
