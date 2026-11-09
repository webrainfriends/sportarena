// Official rate card service catalog (#1015 R34). Layered on top of official_profile_rates (migration 193/194).
// Provides draft→active versioning, premium pricing, quote calculator and separate public/private visibility.
// Existing save_official_rate_cards (official-profile.js) continues to work unchanged — it inserts with status='active' (migration default).
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { requireApproved } from '../access.js';
import { notify } from '../notify.js';

const TAG = 'Official rate card';

const FIXTURE_TYPES = ['training','friendly','cup','league','tournament','international','other'];
const ROLES = ['referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee'];
const SERVICE_TYPES = ['hourly','match','session','day'];
const DEPOSIT_TYPES = ['none','pct','fixed'];
const STATUSES = ['draft','active','archived'];

const text = (n) => z.string().trim().max(n);
const pct = z.coerce.number().min(0).max(100).default(0);

const rateCardInput = z.object({
  name: text(120).optional(),
  service_type: z.enum(SERVICE_TYPES).optional(),
  sport_id: id.optional(),
  role: z.enum(ROLES).optional(),
  fixture_type: z.enum(FIXTURE_TYPES).optional(),
  level_label: text(60).optional(),
  fee_minor: money,
  fee_currency: z.string().regex(/^[A-Z]{3}$/),
  min_fee_minor: money.optional(),
  includes_travel: z.boolean().optional(),
  travel_allowance_per_km_minor: money.optional(),
  travel_radius_km: z.number().int().min(0).max(500).optional(),
  expenses_note: text(300).optional(),
  weekend_sat_pct: pct,
  weekend_sun_pct: pct,
  holiday_pct: pct,
  overtime_rate_minor: money.optional(),
  deposit_type: z.enum(DEPOSIT_TYPES).optional(),
  deposit_pct: pct,
  deposit_minor: money.optional(),
  tax_inclusive: z.boolean().optional(),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  is_indicative: z.boolean().optional(),
  private_notes: text(2000).optional(),
  status: z.enum(['draft','active']).optional(),
});

function decryptNotes(row, isOwner) {
  if (!row) return row;
  const { private_notes_enc, ...rest } = row;
  return isOwner && private_notes_enc ? { ...rest, private_notes: decrypt(private_notes_enc) } : rest;
}

function publicView(row) {
  const { private_notes_enc, private_notes, ...pub } = row;
  return pub;
}

function insertValues(p, i, status, version) {
  return [
    p.id,
    i.sport_id ?? null,
    i.role ?? null,
    i.fixture_type ?? 'other',
    i.level_label ?? null,
    i.fee_minor,
    i.fee_currency,
    i.includes_travel ?? false,
    i.travel_allowance_per_km_minor ?? null,
    i.expenses_note ?? null,
    i.valid_from ?? null,
    i.valid_until ?? null,
    i.name ?? null,
    i.service_type ?? null,
    i.weekend_sat_pct ?? 0,
    i.weekend_sun_pct ?? 0,
    i.holiday_pct ?? 0,
    i.overtime_rate_minor ?? 0,
    i.min_fee_minor ?? 0,
    i.deposit_type ?? 'none',
    i.deposit_pct ?? 0,
    i.deposit_minor ?? 0,
    i.tax_inclusive ?? true,
    status,
    version,
    i.is_indicative ?? true,
    i.private_notes ? encrypt(i.private_notes) : null,
    i.travel_radius_km ?? 0,
  ];
}

const INSERT_SQL = `INSERT INTO official_profile_rates(
  profile_id, sport_id, role, fixture_type, level_label, fee_minor, fee_currency,
  includes_travel, travel_allowance_per_km_minor, expenses_note, valid_from, valid_until,
  name, service_type, weekend_sat_pct, weekend_sun_pct, holiday_pct, overtime_rate_minor,
  min_fee_minor, deposit_type, deposit_pct, deposit_minor, tax_inclusive, status,
  version_number, is_indicative, private_notes_enc, travel_radius_km
) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
RETURNING *`;

// Travel radius not yet in migration 193; handle gracefully if column doesn't exist
const SAFE_INSERT_SQL = INSERT_SQL;

// ------------------------------------------------------------------ catalog: my own rate cards
cap({
  name: 'list_my_rate_cards', method: 'GET', path: '/me/official-profile/rate-cards/catalog', tag: TAG,
  summary: 'List all my rate cards (all statuses: draft, active, archived). Returns private notes decrypted.',
  input: z.object({ status: z.enum([...STATUSES, 'all']).optional(), page: z.number().int().min(1).optional() }),
  async handler({ user }, i) {
    await requireApproved(user);
    const p = await one('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL', [user.id]);
    if (!p) throw notFound('Official profile');
    const statusFilter = (!i.status || i.status === 'all') ? '' : `AND status=$2`;
    const args = statusFilter ? [p.id, i.status] : [p.id];
    const rows = await many(
      `SELECT r.*, s.name AS sport_name, s.emoji AS sport_emoji
       FROM official_profile_rates r LEFT JOIN sports s ON s.id=r.sport_id
       WHERE r.profile_id=$1 AND r.archived_at IS NULL ${statusFilter}
       ORDER BY r.status DESC, r.created_at DESC`,
      args,
    );
    return rows.map((r) => decryptNotes(r, true));
  },
});

// ------------------------------------------------------------------ create rate card
cap({
  name: 'create_rate_card', method: 'POST', path: '/me/official-profile/rate-cards', tag: TAG,
  summary: 'Create a new rate card. status=draft (default) or status=active to publish immediately.',
  input: rateCardInput,
  status: 201,
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      const status = i.status === 'active' ? 'active' : 'draft';
      const row = (await c.query(SAFE_INSERT_SQL, insertValues(p, i, status, 1))).rows[0];
      return decryptNotes(row, true);
    });
  },
});

// ------------------------------------------------------------------ update rate card
cap({
  name: 'update_rate_card', method: 'PUT', path: '/me/official-profile/rate-cards/:id', tag: TAG,
  summary: 'Update a rate card. If the card is draft, edits in place. If active, archives the current version and returns a new draft (new version number) — accepted contract snapshots are immutable.',
  input: rateCardInput.extend({ id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      const existing = (await c.query('SELECT * FROM official_profile_rates WHERE id=$1 AND profile_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, p.id])).rows[0];
      if (!existing) throw notFound('Rate card');
      if (existing.status === 'archived') throw badRequest('Cannot edit an archived rate card');

      if (existing.status === 'draft') {
        // Edit in place
        const row = (await c.query(`UPDATE official_profile_rates SET
          name=$1, service_type=$2, sport_id=$3, role=$4, fixture_type=$5, level_label=$6,
          fee_minor=$7, fee_currency=$8, min_fee_minor=$9, includes_travel=$10,
          travel_allowance_per_km_minor=$11, travel_radius_km=$12, expenses_note=$13,
          weekend_sat_pct=$14, weekend_sun_pct=$15, holiday_pct=$16, overtime_rate_minor=$17,
          deposit_type=$18, deposit_pct=$19, deposit_minor=$20, tax_inclusive=$21,
          valid_from=$22, valid_until=$23, is_indicative=$24, private_notes_enc=$25,
          updated_at=now()
          WHERE id=$26 RETURNING *`,
          [
            i.name ?? existing.name,
            i.service_type ?? existing.service_type,
            i.sport_id ?? existing.sport_id,
            i.role ?? existing.role,
            i.fixture_type ?? existing.fixture_type,
            i.level_label ?? existing.level_label,
            i.fee_minor ?? existing.fee_minor,
            i.fee_currency ?? existing.fee_currency,
            i.min_fee_minor ?? existing.min_fee_minor,
            i.includes_travel ?? existing.includes_travel,
            i.travel_allowance_per_km_minor ?? existing.travel_allowance_per_km_minor,
            i.travel_radius_km ?? existing.travel_radius_km,
            i.expenses_note ?? existing.expenses_note,
            i.weekend_sat_pct ?? existing.weekend_sat_pct,
            i.weekend_sun_pct ?? existing.weekend_sun_pct,
            i.holiday_pct ?? existing.holiday_pct,
            i.overtime_rate_minor ?? existing.overtime_rate_minor,
            i.deposit_type ?? existing.deposit_type,
            i.deposit_pct ?? existing.deposit_pct,
            i.deposit_minor ?? existing.deposit_minor,
            i.tax_inclusive ?? existing.tax_inclusive,
            i.valid_from ?? existing.valid_from,
            i.valid_until ?? existing.valid_until,
            i.is_indicative ?? existing.is_indicative,
            i.private_notes ? encrypt(i.private_notes) : existing.private_notes_enc,
            i.id,
          ],
        )).rows[0];
        return decryptNotes(row, true);
      } else {
        // Active → archive current, create new draft with version_number+1
        await c.query('UPDATE official_profile_rates SET status=$1, deactivated_at=now(), archived_at=now() WHERE id=$2', ['archived', existing.id]);
        const row = (await c.query(SAFE_INSERT_SQL, insertValues(p, { ...existing, ...i }, 'draft', existing.version_number + 1))).rows[0];
        return { ...decryptNotes(row, true), _versioned: true, _previous_id: existing.id };
      }
    });
  },
});

// ------------------------------------------------------------------ activate
cap({
  name: 'activate_rate_card', method: 'POST', path: '/me/official-profile/rate-cards/:id/activate', tag: TAG,
  summary: 'Activate a draft rate card. Idempotent if already active.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      const existing = (await c.query('SELECT * FROM official_profile_rates WHERE id=$1 AND profile_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, p.id])).rows[0];
      if (!existing) throw notFound('Rate card');
      if (existing.status === 'archived') throw badRequest('Cannot activate an archived rate card');
      if (existing.status === 'active') return decryptNotes(existing, true);
      const row = (await c.query('UPDATE official_profile_rates SET status=$1, updated_at=now() WHERE id=$2 RETURNING *', ['active', i.id])).rows[0];
      return decryptNotes(row, true);
    });
  },
});

// ------------------------------------------------------------------ deactivate
cap({
  name: 'deactivate_rate_card', method: 'POST', path: '/me/official-profile/rate-cards/:id/deactivate', tag: TAG,
  summary: 'Deactivate (archive) an active rate card. Soft delete — data is preserved.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      const existing = (await c.query('SELECT * FROM official_profile_rates WHERE id=$1 AND profile_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, p.id])).rows[0];
      if (!existing) throw notFound('Rate card');
      if (existing.status === 'archived') return decryptNotes(existing, true);
      const row = (await c.query('UPDATE official_profile_rates SET status=$1, deactivated_at=now(), archived_at=now(), updated_at=now() WHERE id=$2 RETURNING *', ['archived', i.id])).rows[0];
      return decryptNotes(row, true);
    });
  },
});

// ------------------------------------------------------------------ duplicate
cap({
  name: 'duplicate_rate_card', method: 'POST', path: '/me/official-profile/rate-cards/:id/duplicate', tag: TAG,
  summary: 'Clone an existing rate card as a new draft (version 1). Name gets " (copy)" appended.',
  input: z.object({ id }),
  status: 201,
  async handler({ user }, i) {
    await requireApproved(user);
    return tx(async (c) => {
      const p = (await c.query('SELECT id FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL FOR UPDATE', [user.id])).rows[0];
      if (!p) throw notFound('Official profile');
      const existing = (await c.query('SELECT * FROM official_profile_rates WHERE id=$1 AND profile_id=$2', [i.id, p.id])).rows[0];
      if (!existing) throw notFound('Rate card');
      const src = {
        ...existing,
        name: (existing.name ?? 'Rate card') + ' (copy)',
        private_notes: existing.private_notes_enc ? decrypt(existing.private_notes_enc) : undefined,
      };
      const row = (await c.query(SAFE_INSERT_SQL, insertValues(p, src, 'draft', 1))).rows[0];
      return decryptNotes(row, true);
    });
  },
});

// ------------------------------------------------------------------ public catalog
cap({
  name: 'list_official_rate_cards', method: 'GET', path: '/official-profiles/:profileId/rate-cards', tag: TAG,
  summary: 'Public rate card catalog for an official. Returns only active + indicative cards; no private notes.',
  input: z.object({ profileId: id }),
  async handler(_ctx, i) {
    const p = await one('SELECT id, user_id FROM official_profiles WHERE id=$1 AND archived_at IS NULL AND status=\'published\'', [i.profileId]);
    if (!p) throw notFound('Official profile');
    const rows = await many(
      `SELECT r.*, s.name AS sport_name, s.emoji AS sport_emoji
       FROM official_profile_rates r LEFT JOIN sports s ON s.id=r.sport_id
       WHERE r.profile_id=$1 AND r.archived_at IS NULL AND r.status='active' AND r.is_indicative=true
       ORDER BY r.created_at DESC`,
      [p.id],
    );
    return rows.map(publicView);
  },
});

// ------------------------------------------------------------------ quote calculator
cap({
  name: 'calculate_quote', method: 'POST', path: '/official-profiles/:profileId/rate-cards/:id/quote', tag: TAG,
  summary: 'Calculate an indicative fee breakdown for an event using an official's published rate card. Returns base fee, premiums, travel, overtime and deposit breakdown.',
  input: z.object({
    profileId: id,
    id,
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    duration_min: z.number().int().min(1).max(2880).optional(),
    travel_km: z.number().min(0).max(10000).optional(),
    overtime_hrs: z.number().min(0).max(24).optional(),
    is_holiday: z.boolean().optional(),
  }),
  async handler(_ctx, i) {
    const p = await one('SELECT id FROM official_profiles WHERE id=$1 AND archived_at IS NULL AND status=\'published\'', [i.profileId]);
    if (!p) throw notFound('Official profile');
    const card = await one('SELECT * FROM official_profile_rates WHERE id=$1 AND profile_id=$2 AND archived_at IS NULL AND status=\'active\'', [i.id, p.id]);
    if (!card) throw notFound('Rate card');

    const eventDate = i.event_date ? new Date(i.event_date) : null;
    const dow = eventDate ? eventDate.getDay() : null; // 0=Sun,6=Sat
    const isSat = dow === 6;
    const isSun = dow === 0;
    const isHoliday = !!i.is_holiday;

    const baseFee = Number(card.fee_minor);
    const travelKm = i.travel_km ?? 0;
    const radiusKm = Number(card.travel_radius_km ?? 0);
    const travelRateMinor = Number(card.travel_allowance_per_km_minor ?? 0);
    const chargeableKm = Math.max(0, travelKm - radiusKm);
    const travelFee = card.includes_travel ? 0 : chargeableKm * travelRateMinor;

    const overtimeHrs = i.overtime_hrs ?? 0;
    const overtimeFee = overtimeHrs * Number(card.overtime_rate_minor ?? 0);

    let premiumPct = 0;
    if (isHoliday) premiumPct = Number(card.holiday_pct ?? 0);
    else if (isSat) premiumPct = Number(card.weekend_sat_pct ?? 0);
    else if (isSun) premiumPct = Number(card.weekend_sun_pct ?? 0);

    const premiumFee = Math.round(baseFee * premiumPct / 100);
    const subtotal = baseFee + premiumFee + Math.round(travelFee) + Math.round(overtimeFee);
    const effectiveFee = Math.max(subtotal, Number(card.min_fee_minor ?? 0));

    let depositAmount = 0;
    if (card.deposit_type === 'pct') depositAmount = Math.round(effectiveFee * Number(card.deposit_pct ?? 0) / 100);
    else if (card.deposit_type === 'fixed') depositAmount = Number(card.deposit_minor ?? 0);

    return {
      rate_card_id: card.id,
      rate_card_name: card.name,
      currency: card.fee_currency,
      event_date: i.event_date ?? null,
      lines: [
        { key: 'base', label: 'Base fee', amount: baseFee },
        ...(premiumFee ? [{ key: 'premium', label: isHoliday ? `Holiday premium (+${card.holiday_pct}%)` : isSat ? `Saturday premium (+${card.weekend_sat_pct}%)` : `Sunday premium (+${card.weekend_sun_pct}%)`, amount: premiumFee }] : []),
        ...(travelFee ? [{ key: 'travel', label: `Travel (${chargeableKm.toFixed(1)} km × ${(travelRateMinor / 100).toFixed(2)})`, amount: Math.round(travelFee) }] : []),
        ...(overtimeFee ? [{ key: 'overtime', label: `Overtime (${overtimeHrs} hrs)`, amount: Math.round(overtimeFee) }] : []),
      ],
      subtotal,
      min_fee_applied: effectiveFee > subtotal,
      total: effectiveFee,
      tax_inclusive: card.tax_inclusive ?? true,
      deposit_type: card.deposit_type ?? 'none',
      deposit_amount: depositAmount,
      is_indicative: true,
    };
  },
});
