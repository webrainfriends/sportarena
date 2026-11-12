import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { forbidden, notFound } from '../errors.js';

const enc = (v) => encrypt(v, 'physio_reminders.message');
const dec = (v) => (v ? decrypt(v, 'physio_reminders.message') : null);
const decRow = (r) => r ? { ...r, message: dec(r.message_enc), message_enc: undefined } : r;

cap({
  name: 'create_physio_reminder', method: 'POST', path: '/physio/reminders',
  tag: 'Physio', auth: true, summary: 'Schedule a clinical reminder for a patient',
  input: z.object({
    patient_id: z.string().uuid(),
    treatment_plan_id: z.string().uuid().optional(),
    reminder_type: z.enum(['exercise', 'medication', 'appointment', 'activity', 'custom']).default('exercise'),
    message: z.string().min(1).max(1000),
    scheduled_for: z.string(),
    recurrence: z.string().max(100).optional(),
  }),
  handler: async ({ user }, i) => {
    const row = await one(
      `INSERT INTO physio_reminders (patient_id, provider_id, treatment_plan_id, reminder_type, message_enc, scheduled_for, recurrence)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [i.patient_id, user.id, i.treatment_plan_id ?? null, i.reminder_type, enc(i.message), i.scheduled_for, i.recurrence ?? null],
    );
    return decRow(row);
  },
});

cap({
  name: 'list_provider_reminders', method: 'GET', path: '/physio/reminders',
  tag: 'Physio', auth: true, summary: 'Provider: list reminders I created',
  input: z.object({ patient_id: z.string().uuid().optional() }),
  handler: async ({ user }, i) => {
    const rows = await many(
      `SELECT * FROM physio_reminders
       WHERE provider_id=$1 AND archived_at IS NULL
         AND ($2::uuid IS NULL OR patient_id=$2)
       ORDER BY scheduled_for`,
      [user.id, i.patient_id ?? null],
    );
    return rows.map(decRow);
  },
});

cap({
  name: 'list_my_physio_reminders', method: 'GET', path: '/physio/my-reminders',
  tag: 'Physio', auth: true, summary: 'Patient: upcoming reminders for me',
  input: z.object({}),
  handler: async ({ user }) => {
    const rows = await many(
      `SELECT * FROM physio_reminders
       WHERE patient_id=$1 AND archived_at IS NULL AND acknowledged_at IS NULL
       ORDER BY scheduled_for`,
      [user.id],
    );
    return rows.map(decRow);
  },
});

cap({
  name: 'acknowledge_physio_reminder', method: 'POST', path: '/physio/reminders/:id/acknowledge',
  tag: 'Physio', auth: true, summary: 'Acknowledge (dismiss) a reminder',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    return one(
      `UPDATE physio_reminders SET acknowledged_at=now() WHERE id=$1 AND patient_id=$2 RETURNING id, acknowledged_at`,
      [i.id, user.id],
    );
  },
});

cap({
  name: 'archive_physio_reminder', method: 'POST', path: '/physio/reminders/:id/archive',
  tag: 'Physio', auth: true, summary: 'Archive a reminder (provider)',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id FROM physio_reminders WHERE id=$1`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    return one(`UPDATE physio_reminders SET archived_at=now() WHERE id=$1 RETURNING id`, [i.id]);
  },
});
