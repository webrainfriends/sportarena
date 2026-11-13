// Physio practice setup wizard (#1126): 7-step profile for physio/clinician roles.
// PII fields (licence, indemnity, bank) encrypted; audit-logged on admin read.
import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { encrypt } from '../crypto.js';
import { requireApproved } from '../access.js';
import { isYouth } from '../youth.js';

const TAG = 'Physio profile';
const text = (n) => z.string().trim().max(n);
const SPECIALISMS = ['sports_physio','musculoskeletal','orthopaedic','neurological','cardiorespiratory','paediatric','womens_health','oncology','geriatric','mental_performance','other'];
const DELIVERY_MODES = ['in_clinic','home_visits','remote','facility','poolside','pitch_side'];
const SERVICE_CATS = ['initial_assessment','follow_up','treatment','rehabilitation','sports_massage','performance_screening','injury_prevention','nutrition_consult','other'];
const PAYOUT_METHODS = ['bank_transfer','stripe','other'];
const PRONOUNS = ['he/him','she/her','they/them','prefer_not_to_say'];

function computeCompleteness(p) {
  let score = 0;
  if (p.display_name) score += 15;
  if ((p.specialisms ?? []).length > 0) score += 10;
  if (p.licence_number_enc) score += 20;
  if (p.clinic_name) score += 15;
  if ((p.delivery_modes ?? []).length > 0) score += 5;
  if ((p.services ?? []).length > 0) score += 15;
  if (p.appointment_availability) score += 10;
  if (p.privacy_notice_accepted_at) score += 10;
  return Math.min(100, score);
}

function cleanSensitive(row) {
  const { licence_number_enc, indemnity_policy_enc, safeguarding_cert_enc, dbs_check_enc, bank_account_enc, bank_name_enc, vat_number_enc, ...rest } = row;
  return rest;
}

cap({
  name: 'get_physio_profile_options', method: 'GET', path: '/me/physio-profile/options', tag: TAG,
  summary: 'Wizard dropdown data: specialisms, delivery modes, service categories, payout methods.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    return { specialisms: SPECIALISMS, delivery_modes: DELIVERY_MODES, service_categories: SERVICE_CATS, payout_methods: PAYOUT_METHODS, pronouns: PRONOUNS };
  },
});

cap({
  name: 'get_my_physio_profile', method: 'GET', path: '/me/physio-profile', tag: TAG,
  summary: 'Full draft physio profile for wizard resume. Returns 404 if none exists.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT * FROM physio_profiles WHERE user_id=$1', [user.id]);
    if (!p) throw notFound('Physio profile');
    return cleanSensitive(p);
  },
});

const UPSERT_INPUT = z.object({
  row_version: z.number().int().optional(),
  step_reached: z.number().int().min(0).max(6).optional(),
  display_name: text(120).optional(),
  pronouns: z.enum(PRONOUNS).optional(),
  bio: text(1000).optional(),
  photo_url: z.string().url().optional(),
  specialisms: z.array(z.enum(SPECIALISMS)).optional(),
  licence_number: text(100).optional(),
  licence_body: text(200).optional(),
  licence_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  indemnity_insurer: text(200).optional(),
  indemnity_policy: text(100).optional(),
  indemnity_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  safeguarding_cert: text(100).optional(),
  dbs_check: text(100).optional(),
  clinic_name: text(200).optional(),
  clinic_address: z.any().optional(),
  clinic_lat: z.number().optional(),
  clinic_lng: z.number().optional(),
  delivery_modes: z.array(z.enum(DELIVERY_MODES)).optional(),
  services: z.array(z.object({
    category: z.enum(SERVICE_CATS),
    name: text(200),
    duration_minutes: z.number().int().min(15).max(240),
    fee_minor: z.number().int().min(0),
    fee_currency: z.string().length(3),
    tax_class: text(50).optional(),
    booking_buffer_minutes: z.number().int().min(0).max(60).optional(),
  })).optional(),
  appointment_availability: z.any().optional(),
  payout_method: z.enum(PAYOUT_METHODS).optional(),
  bank_name: text(200).optional(),
  bank_account: text(100).optional(),
  tax_country: z.string().length(2).optional(),
  vat_number: text(50).optional(),
  privacy_notice_accepted: z.boolean().optional(),
});

cap({
  name: 'upsert_physio_profile', method: 'POST', path: '/me/physio-profile', tag: TAG,
  summary: 'Create or update physio profile draft. Auto-saves each step. row_version OCC; step_reached never decremented.',
  input: UPSERT_INPUT,
  async handler({ user, body }) {
    await requireApproved(user);
    if (await isYouth(user.id)) throw badRequest('Managed/youth profiles cannot hold a physio profile');
    const existing = await one('SELECT id, row_version, step_reached FROM physio_profiles WHERE user_id=$1', [user.id]);
    if (existing && body.row_version != null && body.row_version !== existing.row_version) {
      throw { status: 409, message: 'Physio profile was updated elsewhere. Please reload.' };
    }
    const enc = (v) => v ? encrypt(v) : null;
    const newStep = Math.max(existing?.step_reached ?? 0, body.step_reached ?? 0);
    const fields = {
      display_name: body.display_name,
      pronouns: body.pronouns,
      bio: body.bio,
      photo_url: body.photo_url,
      specialisms: body.specialisms !== undefined ? body.specialisms : undefined,
      licence_number_enc: body.licence_number !== undefined ? enc(body.licence_number) : undefined,
      licence_body: body.licence_body,
      licence_expiry: body.licence_expiry,
      indemnity_insurer: body.indemnity_insurer,
      indemnity_policy_enc: body.indemnity_policy !== undefined ? enc(body.indemnity_policy) : undefined,
      indemnity_expiry: body.indemnity_expiry,
      safeguarding_cert_enc: body.safeguarding_cert !== undefined ? enc(body.safeguarding_cert) : undefined,
      dbs_check_enc: body.dbs_check !== undefined ? enc(body.dbs_check) : undefined,
      clinic_name: body.clinic_name,
      clinic_address: body.clinic_address !== undefined ? JSON.stringify(body.clinic_address) : undefined,
      clinic_lat: body.clinic_lat,
      clinic_lng: body.clinic_lng,
      delivery_modes: body.delivery_modes !== undefined ? body.delivery_modes : undefined,
      services: body.services !== undefined ? JSON.stringify(body.services) : undefined,
      appointment_availability: body.appointment_availability !== undefined ? JSON.stringify(body.appointment_availability) : undefined,
      payout_method: body.payout_method,
      bank_name_enc: body.bank_name !== undefined ? enc(body.bank_name) : undefined,
      bank_account_enc: body.bank_account !== undefined ? enc(body.bank_account) : undefined,
      tax_country: body.tax_country,
      vat_number_enc: body.vat_number !== undefined ? enc(body.vat_number) : undefined,
      privacy_notice_accepted_at: body.privacy_notice_accepted ? new Date() : undefined,
      step_reached: newStep,
      updated_at: new Date(),
    };
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    let row;
    if (!existing) {
      const cols = ['user_id', ...Object.keys(defined)];
      const vals = [user.id, ...Object.values(defined)];
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
      row = await one(`INSERT INTO physio_profiles (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    } else {
      const setClauses = Object.keys(defined).map((k, i) => `${k}=$${i + 2}`).join(', ');
      row = await one(
        `UPDATE physio_profiles SET ${setClauses}, row_version=row_version+1 WHERE user_id=$1 RETURNING *`,
        [user.id, ...Object.values(defined)]
      );
    }
    const pct = computeCompleteness(row);
    if (pct !== row.completeness_pct) {
      row = await one('UPDATE physio_profiles SET completeness_pct=$1 WHERE user_id=$2 RETURNING *', [pct, user.id]);
    }
    return cleanSensitive(row);
  },
});

cap({
  name: 'publish_physio_profile', method: 'POST', path: '/me/physio-profile/publish', tag: TAG,
  summary: 'Publish physio profile. Requires licence_number and privacy_notice_accepted.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT * FROM physio_profiles WHERE user_id=$1', [user.id]);
    if (!p) throw notFound('Physio profile');
    if (!p.licence_number_enc) throw badRequest('Licence number is required to publish');
    if (!p.privacy_notice_accepted_at) throw badRequest('Privacy notice must be accepted to publish');
    const row = await tx(async (client) => {
      const updated = await client.query(
        "UPDATE physio_profiles SET status='published', published_at=now(), updated_at=now(), row_version=row_version+1 WHERE user_id=$1 RETURNING *",
        [user.id]
      );
      await client.query(
        "UPDATE users SET roles=array_append(COALESCE(roles,'{}'), 'physio') WHERE id=$1 AND NOT ('physio'=ANY(COALESCE(roles,'{}')))",
        [user.id]
      );
      return updated.rows[0];
    });
    return cleanSensitive(row);
  },
});

cap({
  name: 'retract_physio_profile', method: 'POST', path: '/me/physio-profile/retract', tag: TAG,
  summary: 'Retract published physio profile back to draft. Keeps all data.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT id, status FROM physio_profiles WHERE user_id=$1', [user.id]);
    if (!p) throw notFound('Physio profile');
    if (p.status !== 'published') throw badRequest('Profile is not published');
    const row = await one(
      "UPDATE physio_profiles SET status='draft', published_at=NULL, updated_at=now(), row_version=row_version+1 WHERE user_id=$1 RETURNING *",
      [user.id]
    );
    return cleanSensitive(row);
  },
});

cap({
  name: 'get_physio_profile_completeness', method: 'GET', path: '/me/physio-profile/completeness', tag: TAG,
  summary: 'Completeness score 0–100 with per-checkpoint guidance.',
  input: z.object({}),
  async handler({ user }) {
    await requireApproved(user);
    const p = await one('SELECT * FROM physio_profiles WHERE user_id=$1', [user.id]);
    if (!p) return { score: 0, guidance: ['Start by filling in your identity'] };
    const checks = [
      { key: 'identity', done: !!p.display_name, label: 'Display name and bio' },
      { key: 'specialisms', done: (p.specialisms ?? []).length > 0, label: 'At least one specialism' },
      { key: 'licence', done: !!p.licence_number_enc, label: 'Professional licence number' },
      { key: 'clinic', done: !!p.clinic_name, label: 'Practice name and location' },
      { key: 'services', done: (p.services ?? []).length > 0, label: 'At least one service with pricing' },
      { key: 'availability', done: !!p.appointment_availability, label: 'Appointment availability' },
      { key: 'privacy', done: !!p.privacy_notice_accepted_at, label: 'Privacy notice accepted (required to publish)' },
    ];
    return { score: p.completeness_pct, checks, guidance: checks.filter(c => !c.done).map(c => c.label) };
  },
});
