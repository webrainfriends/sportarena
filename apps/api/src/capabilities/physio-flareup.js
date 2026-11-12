import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { forbidden, notFound } from '../errors.js';

const CTX = 'physio_flareup_reports';
const enc = (v, k) => (v != null ? encrypt(v, `${CTX}.${k}`) : null);
const dec = (v, k) => (v ? decrypt(v, `${CTX}.${k}`) : null);

function decRow(r) {
  if (!r) return r;
  return {
    ...r,
    description: dec(r.description_enc, 'description'),
    triggers: dec(r.triggers_enc, 'triggers'),
    resolution_notes: dec(r.resolution_notes_enc, 'resolution_notes'),
    description_enc: undefined,
    triggers_enc: undefined,
    resolution_notes_enc: undefined,
  };
}

cap({
  name: 'report_physio_flareup', method: 'POST', path: '/physio/flareups',
  tag: 'Physio', auth: true, summary: 'Patient self-reports a pain flare-up',
  input: z.object({
    treatment_plan_id: z.string().uuid().optional(),
    pain_scale: z.number().int().min(0).max(10).optional(),
    region: z.string().max(100).optional(),
    description: z.string().min(1).max(3000),
    triggers: z.string().max(1000).optional(),
    action_taken: z.string().max(500).optional(),
  }),
  handler: async ({ user }, i) => {
    const row = await one(
      `INSERT INTO physio_flareup_reports (patient_id, treatment_plan_id, pain_scale, region, description_enc, triggers_enc, action_taken)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [user.id, i.treatment_plan_id ?? null, i.pain_scale ?? null, i.region ?? null, enc(i.description, 'description'), enc(i.triggers, 'triggers'), i.action_taken ?? null],
    );
    return decRow(row);
  },
});

cap({
  name: 'assign_physio_flareup_provider', method: 'POST', path: '/physio/flareups/:id/assign',
  tag: 'Physio', auth: true, summary: 'Provider assigns themselves to a flare-up report',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const row = await one(`SELECT patient_id FROM physio_flareup_reports WHERE id=$1`, [i.id]);
    if (!row) throw notFound();
    return one(`UPDATE physio_flareup_reports SET provider_id=$2 WHERE id=$1 RETURNING id, provider_id`, [i.id, user.id]);
  },
});

cap({
  name: 'resolve_physio_flareup', method: 'POST', path: '/physio/flareups/:id/resolve',
  tag: 'Physio', auth: true, summary: 'Mark a flare-up report as resolved',
  input: z.object({ id: z.string().uuid(), resolution_notes: z.string().max(2000).optional() }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT patient_id, provider_id FROM physio_flareup_reports WHERE id=$1`, [i.id]);
    if (!existing) throw notFound();
    if (existing.patient_id !== user.id && existing.provider_id !== user.id) throw forbidden();
    const row = await one(
      `UPDATE physio_flareup_reports SET resolved_at=now(), resolution_notes_enc=$2 WHERE id=$1 RETURNING *`,
      [i.id, enc(i.resolution_notes, 'resolution_notes')],
    );
    return decRow(row);
  },
});

cap({
  name: 'list_physio_flareups', method: 'GET', path: '/physio/patients/:patient_id/flareups',
  tag: 'Physio', auth: true, summary: 'List flare-up reports for a patient',
  input: z.object({
    patient_id: z.string().uuid(),
    open_only: z.boolean().default(false),
  }),
  handler: async ({ user }, i) => {
    const rows = await many(
      `SELECT * FROM physio_flareup_reports
       WHERE patient_id=$1 AND (patient_id=$2 OR provider_id=$2 OR provider_id IS NULL)
         AND ($3::boolean IS FALSE OR resolved_at IS NULL)
       ORDER BY reported_at DESC`,
      [i.patient_id, user.id, i.open_only],
    );
    return rows.map(decRow);
  },
});

cap({
  name: 'list_my_physio_flareups', method: 'GET', path: '/physio/my-flareups',
  tag: 'Physio', auth: true, summary: 'Current patient: my own flare-up history',
  input: z.object({}),
  handler: async ({ user }) => {
    const rows = await many(
      `SELECT * FROM physio_flareup_reports WHERE patient_id=$1 ORDER BY reported_at DESC LIMIT 50`,
      [user.id],
    );
    return rows.map(decRow);
  },
});
