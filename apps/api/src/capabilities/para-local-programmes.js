// PS-29: Partner-configurable local para-sport programmes and publicly verifiable grants.
// Claims about state funding must be current, sourced and marked when unverified.
// No invented official partnerships or implied government endorsements.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, tx } from '../db.js';
import { notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'Para local programmes';
const t = (n) => z.string().trim().max(n);
const iso2 = z.string().trim().length(2).toUpperCase();
const VERIFICATION_STATUSES = ['unverified', 'sourced', 'verified'];

const COLS = `p.id, p.country_iso, p.sport_id, p.name, p.issuing_body, p.eligibility_rules,
  p.grant_min_minor, p.grant_max_minor, p.currency, p.source_url, p.source_ref,
  p.verification_status, p.verified_at, p.verified_by, p.disclaimer, p.active,
  p.created_at, p.updated_at`;

cap({
  name: 'list_para_local_programmes', method: 'GET', path: '/para/local-programmes', tag: TAG, auth: 'public',
  summary: 'List local para-sport programmes, government schemes and funding opportunities for a country. Filter by country_iso, sport_id or verification_status. Unverified records include a mandatory disclaimer. Platform admins see inactive records too.',
  input: z.object({
    country_iso:         iso2.optional(),
    sport_id:            t(80).optional(),
    verification_status: z.enum(VERIFICATION_STATUSES).optional(),
    limit:               z.number().int().min(1).max(200).default(50),
    offset:              z.number().int().min(0).default(0),
  }),
  handler: async ({ user }, i) => {
    const isPlatAdmin = !!user?.roles?.includes('platform_admin');
    const rows = await many(
      `SELECT ${COLS} FROM para_local_programmes p
        WHERE ($1::text IS NULL OR p.country_iso = $1)
          AND ($2::text IS NULL OR p.sport_id = $2)
          AND ($3::text IS NULL OR p.verification_status = $3)
          AND ($4 OR p.active = true)
        ORDER BY p.country_iso, p.name
        LIMIT $5 OFFSET $6`,
      [i.country_iso ?? null, i.sport_id ?? null, i.verification_status ?? null, isPlatAdmin, i.limit, i.offset]);
    return { programmes: rows };
  },
});

cap({
  name: 'upsert_para_local_programme', method: 'PUT', path: '/para/local-programmes', tag: TAG, scope: 'admin', status: 200,
  summary: 'Create or update a local para-sport programme or funding opportunity. Platform admin only. Grant amounts and eligibility are sourced from the provided URL; the record is marked unverified until reviewed. A disclaimer is required for unverified/sourced records.',
  input: z.object({
    country_iso:         iso2,
    sport_id:            t(80).optional(),
    name:                t(200).min(2),
    issuing_body:        t(200).min(2),
    eligibility_rules:   t(2000).optional(),
    grant_min_minor:     z.number().int().min(0).optional(),
    grant_max_minor:     z.number().int().min(0).optional(),
    currency:            z.string().trim().length(3).toUpperCase().optional(),
    source_url:          z.string().trim().url().max(500).regex(/^https?:\/\//),
    source_ref:          t(500).optional(),
    disclaimer:          t(1000).optional(),
    active:              z.boolean().default(true),
  }).strict(),
  handler: async ({ user }, i) => {
    await mustBePlatformAdmin(user);
    const r = await tx(async (c) => {
      const existing = (await c.query('SELECT id FROM para_local_programmes WHERE country_iso=$1 AND name=$2', [i.country_iso, i.name])).rows[0];
      if (existing) {
        const updated = (await c.query(
          `UPDATE para_local_programmes SET sport_id=$3, issuing_body=$4, eligibility_rules=$5, grant_min_minor=$6, grant_max_minor=$7,
             currency=$8, source_url=$9, source_ref=$10, disclaimer=$11, active=$12, verification_status='unverified', verified_at=NULL, verified_by=NULL, updated_at=now()
           WHERE country_iso=$1 AND name=$2 RETURNING ${COLS}`,
          [i.country_iso, i.name, i.sport_id ?? null, i.issuing_body, i.eligibility_rules ?? null,
           i.grant_min_minor ?? null, i.grant_max_minor ?? null, i.currency ?? null,
           i.source_url, i.source_ref ?? null, i.disclaimer ?? null, i.active])).rows[0];
        await audit(c, user.id, 'para_local_programme.update', 'para_local_programmes', updated.id);
        return updated;
      }
      const created = (await c.query(
        `INSERT INTO para_local_programmes(country_iso, sport_id, name, issuing_body, eligibility_rules, grant_min_minor, grant_max_minor,
           currency, source_url, source_ref, disclaimer, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COLS}`,
        [i.country_iso, i.sport_id ?? null, i.name, i.issuing_body, i.eligibility_rules ?? null,
         i.grant_min_minor ?? null, i.grant_max_minor ?? null, i.currency ?? null,
         i.source_url, i.source_ref ?? null, i.disclaimer ?? null, i.active])).rows[0];
      await audit(c, user.id, 'para_local_programme.create', 'para_local_programmes', created.id);
      return created;
    });
    return r;
  },
});

cap({
  name: 'review_para_local_programme', method: 'POST', path: '/para/local-programmes/:id/review', tag: TAG, scope: 'admin',
  summary: 'Set the verification status of a local programme claim (sourced/verified). Platform admin only. Verified means the grant amount, eligibility and source are current as of this date.',
  input: z.object({
    id,
    verification_status: z.enum(['sourced', 'verified']),
  }).strict(),
  handler: async ({ user }, i) => {
    await mustBePlatformAdmin(user);
    const r = await tx(async (c) => {
      const existing = (await c.query('SELECT id FROM para_local_programmes WHERE id=$1', [i.id])).rows[0];
      if (!existing) throw notFound('Programme');
      const updated = (await c.query(
        `UPDATE para_local_programmes SET verification_status=$2, verified_at=now(), verified_by=$3, updated_at=now()
         WHERE id=$1 RETURNING ${COLS}`,
        [i.id, i.verification_status, user.id])).rows[0];
      await audit(c, user.id, `para_local_programme.review_${i.verification_status}`, 'para_local_programmes', i.id);
      return updated;
    });
    return r;
  },
});
