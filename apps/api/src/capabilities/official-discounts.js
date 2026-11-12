// Referee pricing discounts and promotions (Issue #1017 / R36).
// Flexible controlled discounts: percentage/fixed for academy recurring contracts, events, bulk
// games, early commitment, loyalty and first booking; referee-funded vs platform-funded offers,
// validity, usage limits, eligibility, stacking, automatic vs coupon entry, minimum price floors.
// Tax is computed on the post-discount taxable consideration. Floor override requests require
// explicit platform-admin approval. Private terms are field-encrypted.
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { many, one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, isAdmin } from '../helpers.js';
import { notify } from '../notify.js';
import { mustBePlatformAdmin } from '../platform.js';
import { encrypt, decrypt } from '../crypto.js';

const TAG = 'Official discounts';

const cur = z.string().regex(/^[A-Z]{3}$/);
const bp  = z.number().int().min(1).max(10000);
const pct = z.number().int().min(0).max(100);

const DISCOUNT_TYPES = ['recurring_contract','event','bulk_games','early_commitment','loyalty','first_booking','coupon','referral'];
const CUSTOMER_TYPES = ['academy','event_organiser','venue','individual'];
const FUNDED_BY      = ['referee','platform','organisation'];

const bookingContextSchema = z.object({
  game_count:            z.number().int().min(1).optional(),
  booking_days_advance:  z.number().int().min(0).optional(),
  prior_bookings_count:  z.number().int().min(0).optional(),
  contract_value_minor:  z.number().int().min(0).optional(),
  sport_id:              id.optional(),
  grade_level:           z.string().trim().max(60).optional(),
  customer_type:         z.enum(CUSTOMER_TYPES).optional(),
  coupon_code:           z.string().trim().max(32).optional(),
});

// ── helpers ───────────────────────────────────────────────────────────────────

function computeDiscount(d, listMinor) {
  if (d.kind === 'percent') {
    return Math.round(listMinor * d.value_bp / 10000);
  }
  return Math.min(Number(d.value_minor), listMinor);
}

function floorCheck(d, discountedMinor) {
  if (d.min_price_floor_minor != null && discountedMinor < d.min_price_floor_minor) return true;
  return false;
}

function floorCheckPct(d, discountedMinor, listMinor) {
  if (d.min_price_floor_pct != null && listMinor > 0) {
    const floorMinor = Math.ceil(listMinor * d.min_price_floor_pct / 100);
    if (discountedMinor < floorMinor) return true;
  }
  return false;
}

function isEligible(d, ctx) {
  const now = new Date();
  if (d.status !== 'active') return { ok: false, reason: 'discount_not_active' };
  if (d.archived_at) return { ok: false, reason: 'discount_archived' };
  if (d.valid_from && new Date(d.valid_from) > now) return { ok: false, reason: 'not_yet_valid' };
  if (d.valid_to   && new Date(d.valid_to)   < now) return { ok: false, reason: 'expired' };

  if (ctx) {
    if (d.eligible_customer_types?.length && ctx.customer_type &&
        !d.eligible_customer_types.includes(ctx.customer_type))
      return { ok: false, reason: 'customer_type_ineligible' };

    if (d.min_booking_count != null && (ctx.game_count ?? 0) < d.min_booking_count)
      return { ok: false, reason: 'below_min_booking_count' };

    if (d.min_contract_value_minor != null && (ctx.contract_value_minor ?? 0) < d.min_contract_value_minor)
      return { ok: false, reason: 'below_min_contract_value' };

    if (d.days_advance != null && (ctx.booking_days_advance ?? 0) < d.days_advance)
      return { ok: false, reason: 'insufficient_advance_days' };

    if (d.loyalty_min_prior_bookings != null && (ctx.prior_bookings_count ?? 0) < d.loyalty_min_prior_bookings)
      return { ok: false, reason: 'insufficient_prior_bookings' };

    if (d.eligible_sports?.length && ctx.sport_id && !d.eligible_sports.includes(ctx.sport_id))
      return { ok: false, reason: 'sport_ineligible' };

    if (d.eligible_grade_levels?.length && ctx.grade_level &&
        !d.eligible_grade_levels.includes(ctx.grade_level))
      return { ok: false, reason: 'grade_ineligible' };

    if (d.code_normalized && d.discount_type === 'coupon') {
      if (!ctx.coupon_code || ctx.coupon_code.trim().toUpperCase() !== d.code_normalized)
        return { ok: false, reason: 'coupon_code_mismatch' };
    }
  }
  return { ok: true };
}

async function loadDiscount(c, discountId) {
  const d = (await c.query(
    'SELECT * FROM official_discounts WHERE id=$1 AND archived_at IS NULL',
    [discountId],
  )).rows[0];
  if (!d) throw notFound('official discount');
  return d;
}

function assertOwnerOrAdmin(user, d) {
  if (user.id !== d.owner_id && !isAdmin(user)) throw notFound('official discount');
}

// ── create ────────────────────────────────────────────────────────────────────

cap({
  name: 'create_official_discount',
  method: 'POST',
  path: '/official-discounts',
  tag: TAG,
  status: 201,
  summary: 'Create a new discount/promotion offer for official booking. kind=percent requires value_bp (basis points, 100=1%); kind=fixed requires value_minor + currency. funded_by=platform requires platform-admin role.',
  input: z.object({
    name:                     z.string().trim().min(2).max(120),
    description:              z.string().trim().max(1000).optional(),
    kind:                     z.enum(['percent','fixed']),
    value_bp:                 bp.optional(),
    value_minor:              z.number().int().min(1).optional(),
    currency:                 cur.optional(),
    discount_type:            z.enum(DISCOUNT_TYPES),
    funded_by:                z.enum(FUNDED_BY),
    code:                     z.string().trim().min(3).max(32).optional(),
    auto_apply:               z.boolean().optional().default(false),
    eligible_sports:          z.array(id).max(50).optional(),
    eligible_grade_levels:    z.array(z.string().trim().max(60)).max(20).optional(),
    eligible_customer_types:  z.array(z.enum(CUSTOMER_TYPES)).min(1).max(4).optional(),
    min_booking_count:        z.number().int().min(1).optional(),
    min_contract_value_minor: z.number().int().min(0).optional(),
    days_advance:             z.number().int().min(1).optional(),
    loyalty_min_prior_bookings: z.number().int().min(1).optional(),
    max_redemptions:          z.number().int().min(1).optional(),
    per_official_limit:       z.number().int().min(1).optional(),
    per_customer_limit:       z.number().int().min(1).optional(),
    valid_from:               z.string().datetime().optional(),
    valid_to:                 z.string().datetime().optional(),
    min_price_floor_minor:    z.number().int().min(0).optional(),
    min_price_floor_pct:      pct.optional(),
    stackable:                z.boolean().optional().default(false),
    stack_priority:           z.number().int().min(0).optional().default(0),
    max_stack_discount_bp:    bp.optional(),
    requires_approval:        z.boolean().optional().default(false),
    terms:                    z.string().trim().max(5000).optional(),
  }),
  async handler({ user }, i) {
    if (i.kind === 'percent' && !i.value_bp) throw badRequest('value_bp required for percent discount');
    if (i.kind === 'fixed' && (!i.value_minor || !i.currency)) throw badRequest('value_minor and currency required for fixed discount');
    if (i.funded_by === 'platform' && !isAdmin(user)) throw forbidden('Only platform admins may create platform-funded discounts');
    if (i.valid_from && i.valid_to && new Date(i.valid_from) >= new Date(i.valid_to))
      throw badRequest('valid_to must be after valid_from');

    const termsEnc = i.terms ? encrypt(i.terms, 'official_discounts.terms') : null;
    const customerTypes = i.eligible_customer_types ?? CUSTOMER_TYPES;

    const row = (await one(
      `INSERT INTO official_discounts
        (owner_id, owner_type, funded_by, name, description, kind, value_bp, value_minor, currency,
         discount_type, code, auto_apply, eligible_sports, eligible_grade_levels, eligible_customer_types,
         min_booking_count, min_contract_value_minor, days_advance, loyalty_min_prior_bookings,
         max_redemptions, per_official_limit, per_customer_limit, valid_from, valid_to,
         min_price_floor_minor, min_price_floor_pct, stackable, stack_priority, max_stack_discount_bp,
         requires_approval, terms_enc, created_by)
       VALUES ($1,'referee',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
       RETURNING *`,
      [
        user.id, i.funded_by, i.name, i.description ?? null, i.kind,
        i.value_bp ?? null, i.value_minor ?? null, i.currency ?? null,
        i.discount_type, i.code ?? null, i.auto_apply,
        i.eligible_sports ?? null, i.eligible_grade_levels ?? null, customerTypes,
        i.min_booking_count ?? null, i.min_contract_value_minor ?? null,
        i.days_advance ?? null, i.loyalty_min_prior_bookings ?? null,
        i.max_redemptions ?? null, i.per_official_limit ?? null, i.per_customer_limit ?? null,
        i.valid_from ?? null, i.valid_to ?? null,
        i.min_price_floor_minor ?? null, i.min_price_floor_pct ?? null,
        i.stackable, i.stack_priority ?? 0, i.max_stack_discount_bp ?? null,
        i.requires_approval, termsEnc, user.id,
      ],
    ));

    const { terms_enc, ...rest } = row;
    return rest;
  },
});

// ── get ───────────────────────────────────────────────────────────────────────

cap({
  name: 'get_official_discount',
  method: 'GET',
  path: '/official-discounts/:id',
  tag: TAG,
  summary: 'Full discount detail. Terms are decrypted only for the owner or platform admin (audit-logged).',
  input: z.object({ id }),
  async handler({ user }, i) {
    const d = await tx(async (c) => loadDiscount(c, i.id));
    if (d.owner_id !== user.id && !isAdmin(user)) throw notFound('official discount');

    const result = { ...d };
    delete result.terms_enc;

    if (d.terms_enc && (d.owner_id === user.id || isAdmin(user))) {
      result.terms = decrypt(d.terms_enc, 'official_discounts.terms');
      await audit(null, user.id, 'read_official_discount_terms', 'official_discounts', d.id);
    }

    const counts = await one(
      `SELECT COUNT(*)::int AS total_redemptions,
              COUNT(*) FILTER (WHERE voided_at IS NULL)::int AS active_redemptions
       FROM official_discount_redemptions WHERE discount_id=$1`,
      [d.id],
    );
    return { ...result, ...counts };
  },
});

// ── list own ──────────────────────────────────────────────────────────────────

cap({
  name: 'list_official_discounts',
  method: 'GET',
  path: '/official-discounts',
  tag: TAG,
  summary: 'List all discount/promotion offers owned by the calling official. Includes redemption counts.',
  input: z.object({
    status:        z.enum(['draft','active','paused','expired','cancelled']).optional(),
    discount_type: z.enum(DISCOUNT_TYPES).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const filters = ['d.owner_id=$1','d.archived_at IS NULL'];
    const params  = [user.id];
    if (i.status)        { params.push(i.status);        filters.push(`d.status=$${params.length}`); }
    if (i.discount_type) { params.push(i.discount_type); filters.push(`d.discount_type=$${params.length}`); }
    const where = filters.join(' AND ');
    const limit = i.limit ?? 20;
    const offset = i.offset ?? 0;
    params.push(limit, offset);

    const rows = await many(
      `SELECT d.*,
              COUNT(r.id) FILTER (WHERE r.voided_at IS NULL)::int AS active_redemptions,
              COUNT(r.id)::int AS total_redemptions
       FROM official_discounts d
       LEFT JOIN official_discount_redemptions r ON r.discount_id=d.id
       WHERE ${where}
       GROUP BY d.id
       ORDER BY d.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params,
    );

    return rows.map(({ terms_enc, ...rest }) => rest);
  },
});

// ── list platform (admin) ─────────────────────────────────────────────────────

cap({
  name: 'list_platform_discounts',
  method: 'GET',
  path: '/official-discounts/platform',
  tag: TAG,
  summary: 'Platform-admin view of all official discounts across all owners. Filterable by status, funded_by, discount_type, free-text search.',
  input: z.object({
    status:        z.enum(['draft','active','paused','expired','cancelled']).optional(),
    funded_by:     z.enum(FUNDED_BY).optional(),
    discount_type: z.enum(DISCOUNT_TYPES).optional(),
    search:        z.string().trim().max(100).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    const filters = ['d.archived_at IS NULL'];
    const params  = [];
    if (i.status)        { params.push(i.status);        filters.push(`d.status=$${params.length}`); }
    if (i.funded_by)     { params.push(i.funded_by);     filters.push(`d.funded_by=$${params.length}`); }
    if (i.discount_type) { params.push(i.discount_type); filters.push(`d.discount_type=$${params.length}`); }
    if (i.search)        { params.push(`%${i.search}%`); filters.push(`(d.name ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`); }
    const where = filters.join(' AND ');
    const limit = i.limit ?? 25;
    const offset = i.offset ?? 0;
    params.push(limit, offset);

    return many(
      `SELECT d.id, d.owner_id, d.owner_type, d.funded_by, d.name, d.kind, d.value_bp, d.value_minor,
              d.currency, d.discount_type, d.code_normalized, d.auto_apply, d.status,
              d.valid_from, d.valid_to, d.max_redemptions, d.per_customer_limit,
              d.min_price_floor_minor, d.min_price_floor_pct, d.stackable, d.requires_approval,
              d.created_at,
              u.display_name AS owner_name,
              COUNT(r.id) FILTER (WHERE r.voided_at IS NULL)::int AS active_redemptions,
              COUNT(r.id)::int AS total_redemptions,
              COALESCE(SUM(r.saving_minor) FILTER (WHERE r.voided_at IS NULL),0)::bigint AS total_savings_minor
       FROM official_discounts d
       JOIN users u ON u.id=d.owner_id
       LEFT JOIN official_discount_redemptions r ON r.discount_id=d.id
       WHERE ${where}
       GROUP BY d.id, u.display_name
       ORDER BY d.created_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params,
    );
  },
});

// ── update ────────────────────────────────────────────────────────────────────

cap({
  name: 'update_official_discount',
  method: 'PATCH',
  path: '/official-discounts/:id',
  tag: TAG,
  summary: 'Update mutable fields of a discount. kind, value_bp and value_minor cannot be changed once the discount is active — create a new version instead.',
  input: z.object({
    id,
    name:              z.string().trim().min(2).max(120).optional(),
    description:       z.string().trim().max(1000).optional(),
    valid_to:          z.string().datetime().nullable().optional(),
    max_redemptions:   z.number().int().min(1).nullable().optional(),
    per_customer_limit:z.number().int().min(1).nullable().optional(),
    status:            z.enum(['draft','active','paused','cancelled']).optional(),
    terms:             z.string().trim().max(5000).nullable().optional(),
    min_price_floor_minor: z.number().int().min(0).nullable().optional(),
    min_price_floor_pct:   pct.nullable().optional(),
    stackable:         z.boolean().optional(),
    max_stack_discount_bp: bp.nullable().optional(),
    requires_approval: z.boolean().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await loadDiscount(c, i.id);
      assertOwnerOrAdmin(user, d);

      if (d.status === 'cancelled') throw conflict('Cancelled discounts cannot be updated');

      const sets = ['updated_at=now()'];
      const params = [];

      function set(col, val) {
        if (val !== undefined) { params.push(val); sets.push(`${col}=$${params.length}`); }
      }

      set('name', i.name);
      set('description', i.description);
      set('valid_to', i.valid_to);
      set('max_redemptions', i.max_redemptions);
      set('per_customer_limit', i.per_customer_limit);
      set('status', i.status);
      set('min_price_floor_minor', i.min_price_floor_minor);
      set('min_price_floor_pct', i.min_price_floor_pct);
      set('stackable', i.stackable);
      set('max_stack_discount_bp', i.max_stack_discount_bp);
      set('requires_approval', i.requires_approval);

      if (i.terms !== undefined) {
        const enc = i.terms ? encrypt(i.terms, 'official_discounts.terms') : null;
        params.push(enc); sets.push(`terms_enc=$${params.length}`);
      }

      if (sets.length === 1) return { ...d, terms_enc: undefined };

      params.push(i.id);
      const updated = (await c.query(
        `UPDATE official_discounts SET ${sets.join(',')} WHERE id=$${params.length} RETURNING *`,
        params,
      )).rows[0];

      const { terms_enc, ...rest } = updated;
      return rest;
    });
  },
});

// ── activate ──────────────────────────────────────────────────────────────────

cap({
  name: 'activate_official_discount',
  method: 'POST',
  path: '/official-discounts/:id/activate',
  tag: TAG,
  summary: 'Activate a draft or paused discount. Validates code uniqueness (coupon type), floor requirements and extreme-value safety checks.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await loadDiscount(c, i.id);
      assertOwnerOrAdmin(user, d);

      if (!['draft','paused'].includes(d.status))
        throw conflict(`Cannot activate a discount with status ${d.status}`);

      // coupon: code must be set
      if (d.discount_type === 'coupon' && !d.code_normalized)
        throw badRequest('Coupon discounts require a code before activation');

      // safety: very high percent without a floor needs explicit requires_approval
      if (d.kind === 'percent' && d.value_bp > 5000 && !d.requires_approval && !d.min_price_floor_minor && !d.min_price_floor_pct)
        throw badRequest('Discounts above 50% must set a minimum price floor or requires_approval=true');

      await c.query(
        'UPDATE official_discounts SET status=$1, updated_at=now() WHERE id=$2',
        ['active', d.id],
      );

      return { id: d.id, status: 'active' };
    });
  },
});

// ── archive ───────────────────────────────────────────────────────────────────

cap({
  name: 'archive_official_discount',
  method: 'POST',
  path: '/official-discounts/:id/archive',
  tag: TAG,
  summary: 'Soft-delete a discount. Cannot archive if there are pending (non-voided) redemptions.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const d = await loadDiscount(c, i.id);
      assertOwnerOrAdmin(user, d);

      const { rows: [{ n }] } = await c.query(
        'SELECT COUNT(*)::int AS n FROM official_discount_redemptions WHERE discount_id=$1 AND voided_at IS NULL',
        [d.id],
      );
      if (n > 0) throw conflict(`Cannot archive: ${n} active redemption(s) exist`);

      await c.query(
        'UPDATE official_discounts SET archived_at=now(), status=$1, updated_at=now() WHERE id=$2',
        ['cancelled', d.id],
      );
      return { id: d.id, archived: true };
    });
  },
});

// ── preview (read-only, no DB write) ─────────────────────────────────────────

cap({
  name: 'preview_discount',
  method: 'POST',
  path: '/official-discounts/preview',
  tag: TAG,
  summary: 'Preview all eligible discounts for a booking without committing any redemption. Returns best non-stackable discount and/or combined stackable discounts. Floor breaches are flagged.',
  input: z.object({
    official_id:     id,
    list_price_minor: z.number().int().min(1),
    currency:        cur,
    context:         bookingContextSchema.optional(),
  }),
  async handler({ user }, i) {
    const ctx = i.context ?? {};

    const discounts = await many(
      `SELECT * FROM official_discounts
       WHERE owner_id=$1 AND status='active' AND archived_at IS NULL
         AND (valid_from IS NULL OR valid_from <= now())
         AND (valid_to   IS NULL OR valid_to   >= now())
       ORDER BY stack_priority DESC, created_at DESC`,
      [i.official_id],
    );

    const eligible = [];
    for (const d of discounts) {
      const check = isEligible(d, ctx);
      if (!check.ok) continue;

      const savingMinor = computeDiscount(d, i.list_price_minor);
      const discountedMinor = i.list_price_minor - savingMinor;
      const floorBreach = floorCheck(d, discountedMinor) || floorCheckPct(d, discountedMinor, i.list_price_minor);

      eligible.push({
        discount_id:           d.id,
        name:                  d.name,
        kind:                  d.kind,
        value_bp:              d.value_bp,
        value_minor:           d.value_minor,
        currency:              d.currency,
        funded_by:             d.funded_by,
        is_auto_apply:         d.auto_apply,
        stackable:             d.stackable,
        stack_priority:        d.stack_priority,
        saving_minor:          savingMinor,
        discounted_price_minor: discountedMinor,
        is_floor_breach:       floorBreach,
        needs_approval:        floorBreach && d.requires_approval,
        code:                  d.code_normalized ?? null,
      });
    }

    // Best single (non-stackable or fallback)
    const nonStack = eligible.filter(e => !e.stackable).sort((a,b) => b.saving_minor - a.saving_minor);
    const stackable = eligible.filter(e => e.stackable).sort((a,b) => b.stack_priority - a.stack_priority);

    let recommendation = null;
    if (stackable.length) {
      // Combine stackable discounts up to max_stack cap
      let remaining = i.list_price_minor;
      let totalSaving = 0;
      const applied = [];
      for (const s of stackable) {
        const saving = computeDiscount(s, remaining);
        remaining -= saving;
        totalSaving += saving;
        applied.push(s.discount_id);
        // Check combined cap (use the lowest max_stack_discount_bp among applied stackable)
        const maxCap = stackable.reduce((m, x) => x.max_stack_discount_bp ? Math.min(m, x.max_stack_discount_bp) : m, 10000);
        if (Math.round(totalSaving / i.list_price_minor * 10000) >= maxCap) break;
      }
      recommendation = {
        type: 'stacked',
        applied_discount_ids: applied,
        total_saving_minor: totalSaving,
        discounted_price_minor: i.list_price_minor - totalSaving,
      };
    } else if (nonStack.length) {
      const best = nonStack[0];
      recommendation = {
        type: 'single',
        applied_discount_ids: [best.discount_id],
        total_saving_minor: best.saving_minor,
        discounted_price_minor: best.discounted_price_minor,
      };
    }

    return {
      list_price_minor:  i.list_price_minor,
      currency:          i.currency,
      eligible_discounts: eligible,
      recommendation,
    };
  },
});

// ── apply ─────────────────────────────────────────────────────────────────────

cap({
  name: 'apply_discount',
  method: 'POST',
  path: '/official-discounts/:id/apply',
  tag: TAG,
  status: 201,
  summary: 'Apply a discount to a booking. Checks all eligibility rules and redemption limits under a lock. If the discounted price breaches the floor and requires_approval is true, creates a pending floor override approval instead of a live redemption.',
  input: z.object({
    id,
    official_id:      id,
    customer_id:      id,
    customer_type:    z.enum(CUSTOMER_TYPES),
    customer_org_id:  id.nullable().optional(),
    booking_ref_id:   id,
    booking_ref_type: z.enum(['rate_agreement','invoice','engagement','education']),
    list_price_minor: z.number().int().min(1),
    currency:         cur,
    context:          bookingContextSchema.optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      // Lock the discount row for the duration of this transaction
      const d = (await c.query(
        'SELECT * FROM official_discounts WHERE id=$1 AND archived_at IS NULL FOR UPDATE',
        [i.id],
      )).rows[0];
      if (!d) throw notFound('official discount');

      // Eligibility
      const ctx = { ...(i.context ?? {}), customer_type: i.customer_type };
      const check = isEligible(d, ctx);
      if (!check.ok) throw badRequest(`Discount not eligible: ${check.reason}`);

      // Idempotency: same booking_ref_id + discount already redeemed?
      const existing = (await c.query(
        'SELECT * FROM official_discount_redemptions WHERE discount_id=$1 AND booking_ref_id=$2 AND booking_ref_type=$3 AND voided_at IS NULL',
        [d.id, i.booking_ref_id, i.booking_ref_type],
      )).rows[0];
      if (existing) return { status: 'already_applied', redemption: existing };

      // Redemption limit checks
      if (d.max_redemptions != null) {
        const { rows: [{ n }] } = await c.query(
          'SELECT COUNT(*)::int AS n FROM official_discount_redemptions WHERE discount_id=$1 AND voided_at IS NULL',
          [d.id],
        );
        if (n >= d.max_redemptions) throw conflict('Discount has reached its maximum redemption limit');
      }
      if (d.per_customer_limit != null) {
        const { rows: [{ n }] } = await c.query(
          'SELECT COUNT(*)::int AS n FROM official_discount_redemptions WHERE discount_id=$1 AND customer_id=$2 AND voided_at IS NULL',
          [d.id, i.customer_id],
        );
        if (n >= d.per_customer_limit) throw conflict('Customer has reached the per-customer limit for this discount');
      }
      if (d.per_official_limit != null) {
        const { rows: [{ n }] } = await c.query(
          'SELECT COUNT(*)::int AS n FROM official_discount_redemptions WHERE discount_id=$1 AND redeemed_by=$2 AND voided_at IS NULL',
          [d.id, d.owner_id],
        );
        if (n >= d.per_official_limit) throw conflict('Official has reached the per-official limit for this discount');
      }

      const savingMinor = computeDiscount(d, i.list_price_minor);
      const discountedMinor = i.list_price_minor - savingMinor;
      const floorBreach = floorCheck(d, discountedMinor) || floorCheckPct(d, discountedMinor, i.list_price_minor);

      if (floorBreach) {
        if (!d.requires_approval)
          throw badRequest('Discount would breach the minimum price floor. Set requires_approval=true on the discount to allow override requests.');

        // Create pending approval
        const approval = (await c.query(
          `INSERT INTO official_discount_approvals
             (discount_id, requested_by, floor_override_reason, expires_at)
           VALUES ($1,$2,$3,now() + interval '7 days')
           RETURNING *`,
          [d.id, user.id, `Discounted price ${discountedMinor} breaches floor`],
        )).rows[0];

        await notify(c, d.owner_id, 'official_discount_floor_approval_requested', {
          discount_id: d.id,
          approval_id: approval.id,
          discounted_minor: discountedMinor,
          floor_minor: d.min_price_floor_minor,
        });

        return { status: 'pending_approval', approval };
      }

      // Write redemption
      const r = (await c.query(
        `INSERT INTO official_discount_redemptions
           (discount_id, redeemed_by, customer_id, customer_org_id, customer_type,
            booking_ref_id, booking_ref_type, applied_kind, applied_value_bp, applied_value_minor,
            list_price_minor, discounted_price_minor, currency, funded_by_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          d.id, d.owner_id, i.customer_id, i.customer_org_id ?? null, i.customer_type,
          i.booking_ref_id, i.booking_ref_type,
          d.kind, d.value_bp ?? null, d.value_minor ?? null,
          i.list_price_minor, discountedMinor, i.currency, d.funded_by,
        ],
      )).rows[0];

      await notify(c, d.owner_id, 'official_discount_applied', {
        discount_id: d.id, redemption_id: r.id, saving_minor: r.saving_minor,
      });
      await notify(c, i.customer_id, 'official_discount_applied_customer', {
        discount_id: d.id, redemption_id: r.id, saving_minor: r.saving_minor,
      });

      return { status: 'applied', redemption: r };
    });
  },
});

// ── void redemption ───────────────────────────────────────────────────────────

cap({
  name: 'void_discount_redemption',
  method: 'POST',
  path: '/official-discount-redemptions/:id/void',
  tag: TAG,
  summary: 'Void a discount redemption. Can be done by the official owner, the customer, or platform admin.',
  input: z.object({
    id,
    reason: z.string().trim().min(2).max(500),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query(
        'SELECT r.*, d.owner_id FROM official_discount_redemptions r JOIN official_discounts d ON d.id=r.discount_id WHERE r.id=$1 FOR UPDATE OF r',
        [i.id],
      )).rows[0];
      if (!r) throw notFound('redemption');
      if (r.redeemed_by !== user.id && r.customer_id !== user.id && !isAdmin(user))
        throw notFound('redemption');
      if (r.voided_at) throw conflict('Redemption already voided');

      await c.query(
        'UPDATE official_discount_redemptions SET voided_at=now(), void_reason=$1 WHERE id=$2',
        [i.reason, i.id],
      );

      await notify(c, r.owner_id, 'official_discount_redemption_voided', { redemption_id: r.id, reason: i.reason });
      await notify(c, r.customer_id, 'official_discount_redemption_voided', { redemption_id: r.id, reason: i.reason });

      return { id: r.id, voided: true };
    });
  },
});

// ── get redemption ────────────────────────────────────────────────────────────

cap({
  name: 'get_discount_redemption',
  method: 'GET',
  path: '/official-discount-redemptions/:id',
  tag: TAG,
  summary: 'Full redemption detail including linked discount snapshot.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one(
      `SELECT r.*, d.name AS discount_name, d.kind, d.value_bp, d.value_minor, d.currency AS discount_currency,
              d.funded_by, d.discount_type, d.owner_id,
              u_ref.display_name AS official_name, u_cust.display_name AS customer_name
       FROM official_discount_redemptions r
       JOIN official_discounts d ON d.id=r.discount_id
       JOIN users u_ref  ON u_ref.id=r.redeemed_by
       JOIN users u_cust ON u_cust.id=r.customer_id
       WHERE r.id=$1`,
      [i.id],
    );
    if (!r) throw notFound('redemption');
    if (r.redeemed_by !== user.id && r.customer_id !== user.id && !isAdmin(user))
      throw notFound('redemption');
    return r;
  },
});

// ── list redemptions ──────────────────────────────────────────────────────────

cap({
  name: 'list_discount_redemptions',
  method: 'GET',
  path: '/official-discount-redemptions',
  tag: TAG,
  summary: 'List redemptions for the calling user, as the official whose discounts were used (as_role=official) or as the customer (as_role=customer).',
  input: z.object({
    as_role:          z.enum(['official','customer']).default('official'),
    discount_id:      id.optional(),
    booking_ref_type: z.enum(['rate_agreement','invoice','engagement','education']).optional(),
    date_from:        z.string().date().optional(),
    date_to:          z.string().date().optional(),
    include_voided:   z.boolean().optional().default(false),
    ...page,
  }),
  async handler({ user }, i) {
    const filters = [];
    const params  = [];

    if (i.as_role === 'official') {
      params.push(user.id); filters.push(`r.redeemed_by=$${params.length}`);
    } else {
      params.push(user.id); filters.push(`r.customer_id=$${params.length}`);
    }
    if (!i.include_voided) filters.push('r.voided_at IS NULL');
    if (i.discount_id)      { params.push(i.discount_id);      filters.push(`r.discount_id=$${params.length}`); }
    if (i.booking_ref_type) { params.push(i.booking_ref_type); filters.push(`r.booking_ref_type=$${params.length}`); }
    if (i.date_from)        { params.push(i.date_from);        filters.push(`r.applied_at >= $${params.length}::date`); }
    if (i.date_to)          { params.push(i.date_to);          filters.push(`r.applied_at <  ($${params.length}::date + interval '1 day')`); }

    const limit = i.limit ?? 20;
    const offset = i.offset ?? 0;
    params.push(limit, offset);

    return many(
      `SELECT r.*, d.name AS discount_name, d.kind, d.discount_type, d.funded_by
       FROM official_discount_redemptions r
       JOIN official_discounts d ON d.id=r.discount_id
       WHERE ${filters.join(' AND ')}
       ORDER BY r.applied_at DESC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params,
    );
  },
});

// ── analytics ─────────────────────────────────────────────────────────────────

cap({
  name: 'get_discount_analytics',
  method: 'GET',
  path: '/official-discounts/:id/analytics',
  tag: TAG,
  summary: 'Redemption analytics for a discount: totals, monthly breakdown, funded-by cost split and top customers.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const d = await tx(async (c) => loadDiscount(c, i.id));
    assertOwnerOrAdmin(user, d);

    const [totals, byMonth, fundedBy, topCustomers] = await Promise.all([
      one(
        `SELECT COUNT(*)::int AS total_redemptions,
                COUNT(*) FILTER (WHERE voided_at IS NULL)::int AS active_redemptions,
                COALESCE(SUM(saving_minor) FILTER (WHERE voided_at IS NULL),0)::bigint AS total_savings_minor,
                COALESCE(AVG(saving_minor) FILTER (WHERE voided_at IS NULL),0)::bigint AS avg_saving_minor
         FROM official_discount_redemptions WHERE discount_id=$1`,
        [i.id],
      ),
      many(
        `SELECT date_trunc('month', applied_at) AS month,
                COUNT(*) FILTER (WHERE voided_at IS NULL)::int AS redemptions,
                COALESCE(SUM(saving_minor) FILTER (WHERE voided_at IS NULL),0)::bigint AS savings_minor
         FROM official_discount_redemptions WHERE discount_id=$1
         GROUP BY 1 ORDER BY 1 DESC LIMIT 24`,
        [i.id],
      ),
      many(
        `SELECT funded_by_snapshot, COUNT(*)::int AS n,
                COALESCE(SUM(saving_minor),0)::bigint AS cost_minor
         FROM official_discount_redemptions WHERE discount_id=$1 AND voided_at IS NULL
         GROUP BY funded_by_snapshot`,
        [i.id],
      ),
      many(
        `SELECT r.customer_id, u.display_name AS customer_name, COUNT(*)::int AS redemptions,
                COALESCE(SUM(r.saving_minor),0)::bigint AS savings_minor
         FROM official_discount_redemptions r
         JOIN users u ON u.id=r.customer_id
         WHERE r.discount_id=$1 AND r.voided_at IS NULL
         GROUP BY r.customer_id, u.display_name
         ORDER BY savings_minor DESC LIMIT 10`,
        [i.id],
      ),
    ]);

    return {
      discount_id: i.id,
      name: d.name,
      status: d.status,
      ...totals,
      by_month: byMonth,
      funded_by_breakdown: fundedBy,
      top_customers: topCustomers,
    };
  },
});

// ── list floor approvals (admin) ──────────────────────────────────────────────

cap({
  name: 'list_floor_approvals',
  method: 'GET',
  path: '/official-discount-approvals',
  tag: TAG,
  summary: 'Platform-admin: list floor override approval requests.',
  input: z.object({
    status: z.enum(['pending','approved','rejected','expired']).optional().default('pending'),
    ...page,
  }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    const limit = i.limit ?? 20;
    const offset = i.offset ?? 0;
    return many(
      `SELECT a.*, d.name AS discount_name, d.kind, d.value_bp, d.value_minor, d.funded_by,
              u_req.display_name AS requester_name
       FROM official_discount_approvals a
       JOIN official_discounts d ON d.id=a.discount_id
       JOIN users u_req ON u_req.id=a.requested_by
       WHERE a.status=$1
       ORDER BY a.requested_at ASC
       LIMIT $2 OFFSET $3`,
      [i.status, limit, offset],
    );
  },
});

// ── decide floor approval (admin) ─────────────────────────────────────────────

cap({
  name: 'decide_floor_approval',
  method: 'POST',
  path: '/official-discount-approvals/:id/decide',
  tag: TAG,
  summary: 'Platform-admin approves or rejects a floor override request. On approval the redemption is written; on rejection the requester is notified.',
  input: z.object({
    id,
    decision: z.enum(['approved','rejected']),
    notes:    z.string().trim().max(1000).optional(),
  }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    return tx(async (c) => {
      const a = (await c.query(
        'SELECT a.*, d.owner_id, d.funded_by, d.kind, d.value_bp, d.value_minor FROM official_discount_approvals a JOIN official_discounts d ON d.id=a.discount_id WHERE a.id=$1 FOR UPDATE OF a',
        [i.id],
      )).rows[0];
      if (!a) throw notFound('approval');
      if (a.status !== 'pending') throw conflict(`Approval is already ${a.status}`);

      await c.query(
        'UPDATE official_discount_approvals SET status=$1, approved_by=$2, decided_at=now(), notes=$3 WHERE id=$4',
        [i.decision, user.id, i.notes ?? null, i.id],
      );

      if (i.decision === 'approved' && a.redemption_id == null) {
        // The redemption will be re-run by the caller after approval — notify them
        await notify(c, a.requested_by, 'official_discount_floor_approval_decided', {
          approval_id: a.id, decision: 'approved', discount_id: a.discount_id,
        });
      } else {
        await notify(c, a.requested_by, 'official_discount_floor_approval_decided', {
          approval_id: a.id, decision: 'rejected', notes: i.notes,
        });
      }

      return { id: a.id, decision: i.decision };
    });
  },
});
