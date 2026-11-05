// PS-29: Country/jurisdiction-aware para-sport governance metadata.
// Stores per-country federation connection status (verified API / manual / pending MOU),
// event divisions, accreditation references and source URLs — all subject to human review.
// No official partnerships or state funding are invented: sources are marked and disclaimers are mandatory.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'Para regional governance';
const t = (n) => z.string().trim().max(n);
const iso2 = z.string().trim().length(2).toUpperCase();
const CONNECTION_TYPES = ['verified_api', 'manual_offline', 'pending_mou'];
const REVIEW_STATUSES = ['pending', 'sourced', 'verified', 'flagged', 'rejected'];

const COLS = `r.id, r.sport_id, r.country_iso, r.governing_body, r.source_url, r.source_ref,
  r.effective_from::text AS effective_from, r.effective_to::text AS effective_to,
  r.event_divisions, r.accreditation_refs, r.federation_connection_type, r.review_status,
  r.reviewed_at, r.reviewed_by, r.notes, r.created_at, r.updated_at`;

cap({
  name: 'list_para_regional_governance', method: 'GET', path: '/para/regional-governance', tag: TAG, auth: 'public',
  summary: 'List country-aware para-sport governance metadata for discovery and regional rules display. Filter by country_iso, sport_id or review_status. Only verified and sourced records are returned for public callers; platform admins see all.',
  input: z.object({
    country_iso:  iso2.optional(),
    sport_id:     t(80).optional(),
    review_status: z.enum(REVIEW_STATUSES).optional(),
    limit:        z.number().int().min(1).max(200).default(50),
    offset:       z.number().int().min(0).default(0),
  }),
  handler: async ({ user }, i) => {
    const isPlatAdmin = !!user?.roles?.includes('platform_admin');
    const statusFilter = i.review_status ?? null;
    const rows = await many(
      `SELECT ${COLS} FROM para_regional_governance r
        WHERE ($1::text IS NULL OR r.country_iso = $1)
          AND ($2::text IS NULL OR r.sport_id = $2)
          AND ($3::text IS NULL OR r.review_status = $3)
          AND ($4 OR r.review_status IN ('sourced','verified'))
        ORDER BY r.country_iso, r.sport_id
        LIMIT $5 OFFSET $6`,
      [i.country_iso ?? null, i.sport_id ?? null, statusFilter, isPlatAdmin, i.limit, i.offset]);
    return { governance: rows };
  },
});

cap({
  name: 'upsert_para_regional_governance', method: 'PUT', path: '/para/regional-governance', tag: TAG, scope: 'admin', status: 200,
  summary: 'Create or update a para-sport regional governance record for a country. Platform admin only. Claims about state funding must include a source URL and are marked pending until reviewed.',
  input: z.object({
    sport_id:                 t(80).min(1),
    country_iso:              iso2,
    governing_body:           t(200).min(2),
    source_url:               z.string().trim().url().max(500).regex(/^https?:\/\//),
    source_ref:               t(500).optional(),
    effective_from:           z.string().date().optional(),
    effective_to:             z.string().date().optional(),
    event_divisions:          z.array(z.object({ code: t(20).min(1), name: t(120).min(1), rule: t(300).optional() })).max(50).default([]),
    accreditation_refs:       z.record(z.string().trim().max(200)).default({}),
    federation_connection_type: z.enum(CONNECTION_TYPES).default('manual_offline'),
  }).strict(),
  handler: async ({ user }, i) => {
    await mustBePlatformAdmin(user);
    const r = await tx(async (c) => {
      const existing = (await c.query('SELECT id FROM para_regional_governance WHERE sport_id=$1 AND country_iso=$2', [i.sport_id, i.country_iso])).rows[0];
      if (existing) {
        const updated = (await c.query(
          `UPDATE para_regional_governance SET governing_body=$3, source_url=$4, source_ref=$5, effective_from=$6, effective_to=$7,
             event_divisions=$8, accreditation_refs=$9, federation_connection_type=$10, review_status='pending', updated_at=now()
           WHERE sport_id=$1 AND country_iso=$2 RETURNING ${COLS}`,
          [i.sport_id, i.country_iso, i.governing_body, i.source_url, i.source_ref ?? null,
           i.effective_from ?? null, i.effective_to ?? null,
           JSON.stringify(i.event_divisions), JSON.stringify(i.accreditation_refs), i.federation_connection_type])).rows[0];
        await audit(c, user.id, 'para_regional_governance.update', 'para_regional_governance', updated.id);
        return updated;
      }
      const created = (await c.query(
        `INSERT INTO para_regional_governance(sport_id, country_iso, governing_body, source_url, source_ref, effective_from, effective_to,
           event_divisions, accreditation_refs, federation_connection_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
        [i.sport_id, i.country_iso, i.governing_body, i.source_url, i.source_ref ?? null,
         i.effective_from ?? null, i.effective_to ?? null,
         JSON.stringify(i.event_divisions), JSON.stringify(i.accreditation_refs), i.federation_connection_type])).rows[0];
      await audit(c, user.id, 'para_regional_governance.create', 'para_regional_governance', created.id);
      return created;
    });
    return r;
  },
});

cap({
  name: 'review_para_regional_governance', method: 'POST', path: '/para/regional-governance/:id/review', tag: TAG, scope: 'admin',
  summary: 'Set the review status of a governance record (sourced/verified/flagged/rejected) with optional notes. Platform admin only. Verified means the platform team has checked the source URL and the claim is current.',
  input: z.object({
    id,
    review_status: z.enum(['sourced', 'verified', 'flagged', 'rejected']),
    notes:         t(1000).optional(),
  }).strict(),
  handler: async ({ user }, i) => {
    await mustBePlatformAdmin(user);
    const r = await tx(async (c) => {
      const existing = (await c.query('SELECT id FROM para_regional_governance WHERE id=$1', [i.id])).rows[0];
      if (!existing) throw notFound('Governance record');
      const updated = (await c.query(
        `UPDATE para_regional_governance SET review_status=$2, reviewed_at=now(), reviewed_by=$3, notes=coalesce($4, notes), updated_at=now()
         WHERE id=$1 RETURNING ${COLS}`,
        [i.id, i.review_status, user.id, i.notes ?? null])).rows[0];
      await audit(c, user.id, `para_regional_governance.review_${i.review_status}`, 'para_regional_governance', i.id);
      return updated;
    });
    return r;
  },
});
