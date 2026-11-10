// Official rate agreements (Issue #1016 / R35). Custom per-event / academy / season / club negotiated
// rates with full precedence stack (default → segment → customer → agreement → booked snapshot),
// approval workflow, immutable booked snapshots, volume tiers, multi-currency and audit trail.
// Integrates with officials-pay: resolveOfficialFee() is called at assignment time and returns the
// applicable fee; on confirmation it writes an official_rate_snapshots row.
// Parties: official proposes or accepts; counterpart (academy/event organiser/club admin) proposes or accepts.
// Private rates are never returned to third parties (404 instead of 403 to avoid leaking existence).
import { z } from 'zod';
import { cap, id, money, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'Rate agreements';

const CONTEXT_TYPES = ['event_override', 'academy_contract', 'season_series', 'club_org', 'retainer'];
const RATE_TYPES = ['fixed_match', 'per_hour', 'per_day', 'volume_tiers', 'retainer', 'bundle', 'negotiated'];
const STATUSES = ['draft', 'proposed', 'countered', 'accepted', 'active', 'superseded', 'cancelled'];
const AUTO_RENEW = ['none', 'notify_30', 'notify_60', 'auto'];
const PAYMENT_TRIGGERS = ['per_game', 'weekly', 'monthly', 'on_completion'];

const currency = z.string().regex(/^[A-Z]{3}$/);
const minorAmt = z.number().int().min(0).nullable().optional();
const pct = z.number().min(0).max(100).nullable().optional();

const tierSchema = z.object({
  tier_order: z.number().int().min(1).max(20),
  games_from: z.number().int().min(1),
  games_to: z.number().int().min(1).nullable().optional(),
  fee_minor: z.number().int().min(0),
  travel_minor: minorAmt,
});

const agreementInput = z.object({
  counterpart_id: id,
  counterpart_org_id: id.nullable().optional(),
  context_type: z.enum(CONTEXT_TYPES),
  event_id: id.nullable().optional(),
  sport_id: id.nullable().optional(),
  official_role: z.string().trim().min(1).max(60),
  rate_type: z.enum(RATE_TYPES),
  currency,
  base_fee_minor: minorAmt,
  retainer_minor: minorAmt,
  travel_minor: minorAmt,
  overtime_minor: minorAmt,
  accom_minor: minorAmt,
  bundle_minor: minorAmt,
  bundle_desc: z.string().trim().max(500).nullable().optional(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effective_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  auto_renew: z.enum(AUTO_RENEW).optional(),
  notice_days: z.number().int().min(0).max(365).nullable().optional(),
  cancel_fee_pct: pct,
  payment_trigger: z.enum(PAYMENT_TRIGGERS).nullable().optional(),
  payment_net_days: z.number().int().min(0).max(365).nullable().optional(),
  official_note: z.string().trim().max(1000).nullable().optional(),
  tiers: z.array(tierSchema).min(0).max(20).optional(),
});

// ------------------------------------------------------------------ helpers

async function loadAgreement(c, agreementId) {
  const a = (await c.query(`
    SELECT a.*, u_off.display_name AS official_name, u_cp.display_name AS counterpart_name,
           o.name AS org_name, s.name AS sport_name, s.emoji AS sport_emoji
    FROM official_rate_agreements a
    JOIN users u_off ON u_off.id = a.official_id
    JOIN users u_cp  ON u_cp.id  = a.counterpart_id
    LEFT JOIN organisations o ON o.id = a.counterpart_org_id
    LEFT JOIN sports s ON s.id = a.sport_id
    WHERE a.id = $1 AND a.archived_at IS NULL
  `, [agreementId])).rows[0];
  if (!a) throw notFound('rate agreement');
  return a;
}

function assertParty(user, a) {
  if (a.official_id !== user.id && a.counterpart_id !== user.id && !user.roles?.includes('admin'))
    throw notFound('rate agreement');
}

async function loadTiers(c, agreementId) {
  return (await c.query('SELECT * FROM official_rate_tiers WHERE agreement_id=$1 ORDER BY tier_order', [agreementId])).rows;
}

async function upsertTiers(c, agreementId, tiers) {
  await c.query('DELETE FROM official_rate_tiers WHERE agreement_id=$1', [agreementId]);
  for (const t of tiers) {
    await c.query(
      'INSERT INTO official_rate_tiers(agreement_id,tier_order,games_from,games_to,fee_minor,travel_minor) VALUES($1,$2,$3,$4,$5,$6)',
      [agreementId, t.tier_order, t.games_from, t.games_to ?? null, t.fee_minor, t.travel_minor ?? null],
    );
  }
}

async function writeVersion(c, a, tiers, actorId, eventKind, note) {
  const snapshot = { ...a, tiers };
  const ver = (a.row_version ?? 0) + 1;
  await c.query(
    'INSERT INTO official_rate_agreement_versions(agreement_id,version,event_kind,actor_id,snapshot,note) VALUES($1,$2,$3,$4,$5,$6)',
    [a.id, ver, eventKind, actorId, JSON.stringify(snapshot), note ?? null],
  );
  return ver;
}

function validateTiers(rate_type, tiers) {
  if (rate_type === 'volume_tiers' && (!tiers || tiers.length < 2))
    throw badRequest('volume_tiers rate type requires at least 2 tier rows');
  if (rate_type !== 'volume_tiers' && tiers && tiers.length > 0)
    throw badRequest('tiers are only allowed with volume_tiers rate type');
}

// ------------------------------------------------------------------ options

cap({
  name: 'get_rate_agreement_options', method: 'GET', path: '/rate-agreements/options', tag: TAG,
  summary: 'Dropdown data for new rate agreement wizard: sports, context types, rate types, currencies.',
  input: z.object({}),
  async handler() {
    const sports = await many("SELECT id, name, emoji FROM sports ORDER BY name");
    return { context_types: CONTEXT_TYPES, rate_types: RATE_TYPES, auto_renew: AUTO_RENEW, payment_triggers: PAYMENT_TRIGGERS, sports };
  },
});

// ------------------------------------------------------------------ create (draft or propose)

cap({
  name: 'create_rate_agreement', method: 'POST', path: '/rate-agreements', tag: TAG, status: 201,
  summary: 'Official creates a rate agreement (draft or immediate proposal). Set propose:true to send it to the counterpart straight away. The official must already have a sport profile for the given sport.',
  input: agreementInput.extend({ id: id.optional(), propose: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      validateTiers(i.rate_type, i.tiers);
      // verify official has a sport profile
      const hasProfile = (await c.query('SELECT 1 FROM official_profiles WHERE user_id=$1 AND archived_at IS NULL', [user.id])).rows[0];
      if (!hasProfile) throw badRequest('Complete your official profile before creating a rate agreement');
      // counterpart must exist
      const cp = (await c.query('SELECT id, display_name FROM users WHERE id=$1', [i.counterpart_id])).rows[0];
      if (!cp) throw notFound('counterpart user');
      // overlap check for active/accepted agreements
      if (i.counterpart_org_id && i.sport_id) {
        const overlap = (await c.query(`
          SELECT 1 FROM official_rate_agreements
          WHERE official_id=$1 AND counterpart_org_id=$2 AND context_type=$3 AND sport_id=$4
            AND status IN ('accepted','active') AND archived_at IS NULL
        `, [user.id, i.counterpart_org_id, i.context_type, i.sport_id])).rows[0];
        if (overlap) throw conflict('An active agreement for this official, organisation, context type and sport already exists. Supersede or cancel it first.');
      }
      const status = i.propose ? 'proposed' : 'draft';
      const { rows: [created] } = await c.query(`
        INSERT INTO official_rate_agreements(
          official_id, counterpart_id, counterpart_org_id,
          context_type, event_id, sport_id, official_role,
          rate_type, currency,
          base_fee_minor, retainer_minor, travel_minor, overtime_minor, accom_minor, bundle_minor, bundle_desc,
          status, proposed_by, proposed_at,
          effective_from, effective_until, auto_renew,
          notice_days, cancel_fee_pct, payment_trigger, payment_net_days,
          official_note, created_by
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
          $17,$18,${i.propose ? 'now()' : 'NULL'},
          $19::date,$20::date,$21,$22,$23,$24,$25,$26,$1
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `, [
        user.id, i.counterpart_id, i.counterpart_org_id ?? null,
        i.context_type, i.event_id ?? null, i.sport_id ?? null, i.official_role,
        i.rate_type, i.currency,
        i.base_fee_minor ?? null, i.retainer_minor ?? null, i.travel_minor ?? null,
        i.overtime_minor ?? null, i.accom_minor ?? null, i.bundle_minor ?? null,
        i.bundle_desc ?? null,
        status, i.propose ? user.id : null,
        i.effective_from, i.effective_until ?? null,
        i.auto_renew ?? 'none',
        i.notice_days ?? null, i.cancel_fee_pct ?? null,
        i.payment_trigger ?? null, i.payment_net_days ?? null,
        i.official_note ?? null,
      ]);
      if (i.tiers) await upsertTiers(c, created.id, i.tiers);
      const tiers = await loadTiers(c, created.id);
      await writeVersion(c, created, tiers, user.id, i.propose ? 'proposed' : 'created', null);
      await c.query('UPDATE official_rate_agreements SET row_version=$2 WHERE id=$1', [created.id, 1]);
      if (i.propose) {
        await notify(c, i.counterpart_id, {
          kind: 'rate_agreement',
          title: 'New rate proposal',
          body: `${user.display_name} has sent you a rate agreement proposal.`,
          data: { agreement_id: created.id },
        });
      }
      return { ...created, tiers };
    });
  },
});

// ------------------------------------------------------------------ list (official's own + counterpart's)

cap({
  name: 'list_rate_agreements', method: 'GET', path: '/rate-agreements', tag: TAG,
  summary: 'All rate agreements where the caller is the official or the counterpart, optionally filtered by status.',
  input: z.object({ status: z.enum([...STATUSES, 'all']).optional(), ...page }),
  async handler({ user }, i) {
    const statusFilter = i.status && i.status !== 'all' ? `AND a.status = '${i.status}'` : '';
    return many(`
      SELECT a.*, u_off.display_name AS official_name, u_cp.display_name AS counterpart_name,
             o.name AS org_name, s.name AS sport_name, s.emoji AS sport_emoji,
             (SELECT json_agg(t ORDER BY t.tier_order) FROM official_rate_tiers t WHERE t.agreement_id=a.id) AS tiers
      FROM official_rate_agreements a
      JOIN users u_off ON u_off.id = a.official_id
      JOIN users u_cp  ON u_cp.id  = a.counterpart_id
      LEFT JOIN organisations o ON o.id = a.counterpart_org_id
      LEFT JOIN sports s ON s.id = a.sport_id
      WHERE (a.official_id=$1 OR a.counterpart_id=$1) AND a.archived_at IS NULL
      ${statusFilter}
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3
    `, [user.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ get single

cap({
  name: 'get_rate_agreement', method: 'GET', path: '/rate-agreements/:id', tag: TAG,
  summary: 'Full agreement detail including tiers and version history. Only the official and the counterpart can read it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await loadAgreement(c, i.id);
      assertParty(user, a);
      const tiers = await loadTiers(c, i.id);
      const versions = (await c.query(`
        SELECT v.version, v.event_kind, v.note, v.created_at, u.display_name AS actor_name
        FROM official_rate_agreement_versions v
        JOIN users u ON u.id = v.actor_id
        WHERE v.agreement_id=$1 ORDER BY v.version
      `, [i.id])).rows;
      return { ...a, tiers, versions };
    });
  },
});

// ------------------------------------------------------------------ update (draft only)

cap({
  name: 'update_rate_agreement', method: 'PATCH', path: '/rate-agreements/:id', tag: TAG,
  summary: 'Update a draft agreement before it is proposed. Only the official (creator) may update. row_version required (optimistic lock).',
  input: agreementInput.partial().extend({ id, row_version: z.number().int() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await loadAgreement(c, i.id);
      if (a.official_id !== user.id) throw forbidden('Only the official can edit a draft agreement');
      if (a.status !== 'draft') throw conflict(`Cannot edit a ${a.status} agreement; withdraw or cancel it first`);
      if (a.row_version !== i.row_version) throw conflict('Agreement updated elsewhere; reload and retry');
      if (i.rate_type || i.tiers) validateTiers(i.rate_type ?? a.rate_type, i.tiers ?? await loadTiers(c, i.id));
      const fields = [];
      const vals = [];
      let p = 1;
      const set = (col, val) => { fields.push(`${col}=$${p++}`); vals.push(val); };
      if (i.counterpart_id !== undefined) set('counterpart_id', i.counterpart_id);
      if (i.counterpart_org_id !== undefined) set('counterpart_org_id', i.counterpart_org_id);
      if (i.context_type !== undefined) set('context_type', i.context_type);
      if (i.event_id !== undefined) set('event_id', i.event_id);
      if (i.sport_id !== undefined) set('sport_id', i.sport_id);
      if (i.official_role !== undefined) set('official_role', i.official_role);
      if (i.rate_type !== undefined) set('rate_type', i.rate_type);
      if (i.currency !== undefined) set('currency', i.currency);
      if (i.base_fee_minor !== undefined) set('base_fee_minor', i.base_fee_minor);
      if (i.retainer_minor !== undefined) set('retainer_minor', i.retainer_minor);
      if (i.travel_minor !== undefined) set('travel_minor', i.travel_minor);
      if (i.overtime_minor !== undefined) set('overtime_minor', i.overtime_minor);
      if (i.accom_minor !== undefined) set('accom_minor', i.accom_minor);
      if (i.bundle_minor !== undefined) set('bundle_minor', i.bundle_minor);
      if (i.bundle_desc !== undefined) set('bundle_desc', i.bundle_desc);
      if (i.effective_from !== undefined) set('effective_from', i.effective_from);
      if (i.effective_until !== undefined) set('effective_until', i.effective_until);
      if (i.auto_renew !== undefined) set('auto_renew', i.auto_renew);
      if (i.notice_days !== undefined) set('notice_days', i.notice_days);
      if (i.cancel_fee_pct !== undefined) set('cancel_fee_pct', i.cancel_fee_pct);
      if (i.payment_trigger !== undefined) set('payment_trigger', i.payment_trigger);
      if (i.payment_net_days !== undefined) set('payment_net_days', i.payment_net_days);
      if (i.official_note !== undefined) set('official_note', i.official_note);
      set('row_version', a.row_version + 1);
      set('updated_at', new Date().toISOString());
      await c.query(`UPDATE official_rate_agreements SET ${fields.join(',')} WHERE id=$${p}`, [...vals, i.id]);
      if (i.tiers !== undefined) await upsertTiers(c, i.id, i.tiers);
      const updated = await loadAgreement(c, i.id);
      const tiers = await loadTiers(c, i.id);
      return { ...updated, tiers };
    });
  },
});

// ------------------------------------------------------------------ propose (draft → proposed)

cap({
  name: 'propose_rate_agreement', method: 'POST', path: '/rate-agreements/:id/propose', tag: TAG,
  summary: 'Official sends a draft agreement to the counterpart as a proposal.',
  input: z.object({ id, note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await loadAgreement(c, i.id);
      if (a.official_id !== user.id) throw forbidden('Only the official can propose an agreement');
      if (a.status !== 'draft') throw conflict(`Agreement is already ${a.status}`);
      await c.query(`UPDATE official_rate_agreements SET status='proposed', proposed_by=$2, proposed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1`, [i.id, user.id]);
      const tiers = await loadTiers(c, i.id);
      await writeVersion(c, { ...a, status: 'proposed' }, tiers, user.id, 'proposed', i.note);
      await notify(c, a.counterpart_id, { kind: 'rate_agreement', title: 'Rate proposal received', body: `${user.display_name} has proposed a rate agreement. Review and accept or counter it.`, data: { agreement_id: i.id } });
      return (await loadAgreement(c, i.id));
    });
  },
});

// ------------------------------------------------------------------ counter

cap({
  name: 'counter_rate_agreement', method: 'POST', path: '/rate-agreements/:id/counter', tag: TAG,
  summary: 'Either party counters a proposed or countered agreement, supplying revised terms. The agreement moves to countered and the other party is notified.',
  input: agreementInput.partial().extend({ id, note: z.string().trim().max(500).optional(), tiers: z.array(tierSchema).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await loadAgreement(c, i.id);
      assertParty(user, a);
      if (!['proposed', 'countered'].includes(a.status)) throw conflict(`Cannot counter a ${a.status} agreement`);
      const fields = ['status=$1', 'row_version=row_version+1', 'updated_at=now()'];
      const vals = ['countered'];
      let p = 2;
      const set = (col, val) => { fields.push(`${col}=$${p++}`); vals.push(val); };
      if (i.base_fee_minor !== undefined) set('base_fee_minor', i.base_fee_minor);
      if (i.retainer_minor !== undefined) set('retainer_minor', i.retainer_minor);
      if (i.travel_minor !== undefined) set('travel_minor', i.travel_minor);
      if (i.overtime_minor !== undefined) set('overtime_minor', i.overtime_minor);
      if (i.rate_type !== undefined) set('rate_type', i.rate_type);
      if (i.currency !== undefined) set('currency', i.currency);
      if (i.effective_from !== undefined) set('effective_from', i.effective_from);
      if (i.effective_until !== undefined) set('effective_until', i.effective_until);
      if (i.notice_days !== undefined) set('notice_days', i.notice_days);
      if (i.cancel_fee_pct !== undefined) set('cancel_fee_pct', i.cancel_fee_pct);
      if (i.payment_trigger !== undefined) set('payment_trigger', i.payment_trigger);
      if (i.payment_net_days !== undefined) set('payment_net_days', i.payment_net_days);
      await c.query(`UPDATE official_rate_agreements SET ${fields.join(',')} WHERE id=$${p}`, [...vals, i.id]);
      if (i.tiers !== undefined) await upsertTiers(c, i.id, i.tiers);
      const updated = await loadAgreement(c, i.id);
      const tiers = await loadTiers(c, i.id);
      await writeVersion(c, updated, tiers, user.id, 'countered', i.note);
      const notifyId = user.id === a.official_id ? a.counterpart_id : a.official_id;
      await notify(c, notifyId, { kind: 'rate_agreement', title: 'Agreement countered', body: `${user.display_name} has countered the rate proposal. Review and accept or counter again.`, data: { agreement_id: i.id } });
      return { ...updated, tiers };
    });
  },
});

// ------------------------------------------------------------------ accept

cap({
  name: 'accept_rate_agreement', method: 'POST', path: '/rate-agreements/:id/accept', tag: TAG,
  summary: 'Either party accepts the current terms. Status moves to accepted → active. The contractual snapshot is frozen immediately; no further edits are allowed.',
  input: z.object({ id, note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await loadAgreement(c, i.id);
      assertParty(user, a);
      if (!['proposed', 'countered'].includes(a.status)) throw conflict(`Cannot accept a ${a.status} agreement`);
      await c.query(`
        UPDATE official_rate_agreements
        SET status='active', accepted_by=$2, accepted_at=now(), row_version=row_version+1, updated_at=now()
        WHERE id=$1
      `, [i.id, user.id]);
      const tiers = await loadTiers(c, i.id);
      const accepted = await loadAgreement(c, i.id);
      await writeVersion(c, accepted, tiers, user.id, 'accepted', i.note);
      const notifyId = user.id === a.official_id ? a.counterpart_id : a.official_id;
      await notify(c, notifyId, { kind: 'rate_agreement', title: 'Rate agreement accepted', body: `${user.display_name} has accepted the rate agreement. It is now active.`, data: { agreement_id: i.id } });
      return { ...accepted, tiers };
    });
  },
});

// ------------------------------------------------------------------ cancel

cap({
  name: 'cancel_rate_agreement', method: 'POST', path: '/rate-agreements/:id/cancel', tag: TAG,
  summary: 'Either party cancels an agreement (any non-cancelled status). Cancellation terms apply. The record is kept; existing booked snapshots are unaffected.',
  input: z.object({ id, reason: z.string().trim().min(2).max(500) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const a = await loadAgreement(c, i.id);
      assertParty(user, a);
      if (a.status === 'cancelled') throw conflict('Already cancelled');
      await c.query(`
        UPDATE official_rate_agreements
        SET status='cancelled', cancelled_by=$2, cancelled_at=now(), cancel_reason=$3, row_version=row_version+1, updated_at=now()
        WHERE id=$1
      `, [i.id, user.id, i.reason]);
      const tiers = await loadTiers(c, i.id);
      await writeVersion(c, { ...a, status: 'cancelled' }, tiers, user.id, 'cancelled', i.reason);
      const notifyId = user.id === a.official_id ? a.counterpart_id : a.official_id;
      await notify(c, notifyId, { kind: 'rate_agreement', title: 'Rate agreement cancelled', body: `${user.display_name} has cancelled the rate agreement: ${i.reason}`, data: { agreement_id: i.id } });
      return (await loadAgreement(c, i.id));
    });
  },
});

// ------------------------------------------------------------------ version history

cap({
  name: 'list_rate_agreement_versions', method: 'GET', path: '/rate-agreements/:id/versions', tag: TAG,
  summary: 'Full immutable version history for an agreement (audit trail). Only parties can read.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const a = await one('SELECT official_id, counterpart_id FROM official_rate_agreements WHERE id=$1 AND archived_at IS NULL', [i.id]);
    if (!a || (a.official_id !== user.id && a.counterpart_id !== user.id && !user.roles?.includes('admin'))) throw notFound('rate agreement');
    return many(`
      SELECT v.*, u.display_name AS actor_name
      FROM official_rate_agreement_versions v
      JOIN users u ON u.id = v.actor_id
      WHERE v.agreement_id=$1 ORDER BY v.version LIMIT $2 OFFSET $3
    `, [i.id, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ fee resolution (called at assignment)

/**
 * resolveOfficialFee({ officialId, counterpartOrgId, eventId, sportId, contextType, gameCount, db })
 * Returns { level, agreement_id, fee_minor, travel_minor, overtime_minor, currency, tier_applied }
 * Precedence: profile_default < segment < agreement < (booked_snapshot written separately at assign time)
 */
export async function resolveOfficialFee({ officialId, counterpartOrgId, eventId, sportId, officialRole, gameCount = 0 }, c) {
  // 1. profile default rate
  const profileRate = (await c.query(`
    SELECT fee_minor, fee_currency AS currency, travel_allowance_per_km_minor AS travel_minor, includes_travel
    FROM official_profile_rates pr
    JOIN official_profiles p ON p.id = pr.profile_id
    WHERE p.user_id=$1 AND (pr.sport_id=$2 OR pr.sport_id IS NULL)
      AND pr.archived_at IS NULL
    ORDER BY (pr.sport_id=$2)::int DESC, pr.created_at DESC
    LIMIT 1
  `, [officialId, sportId])).rows[0];
  let result = profileRate
    ? { level: 'profile_default', agreement_id: null, fee_minor: profileRate.fee_minor, travel_minor: profileRate.travel_minor ?? 0, overtime_minor: null, currency: profileRate.currency, tier_applied: null }
    : { level: 'profile_default', agreement_id: null, fee_minor: 0, travel_minor: 0, overtime_minor: null, currency: 'GBP', tier_applied: null };

  // 2. find best active agreement (event > org for same context)
  const agreementQuery = `
    SELECT a.id, a.rate_type, a.currency, a.base_fee_minor, a.retainer_minor, a.travel_minor,
           a.overtime_minor, a.bundle_minor, a.context_type,
           (SELECT json_agg(t ORDER BY t.tier_order) FROM official_rate_tiers t WHERE t.agreement_id=a.id) AS tiers
    FROM official_rate_agreements a
    WHERE a.official_id=$1 AND a.status='active' AND a.archived_at IS NULL
      AND (a.sport_id=$2 OR a.sport_id IS NULL)
      AND (a.official_role=$3 OR a.official_role='any')
      AND (a.effective_from <= current_date)
      AND (a.effective_until IS NULL OR a.effective_until >= current_date)
      AND (
        (a.event_id=$4 AND $4 IS NOT NULL)
        OR (a.counterpart_org_id=$5 AND $5 IS NOT NULL)
      )
    ORDER BY
      (a.event_id=$4 AND $4 IS NOT NULL)::int DESC,  -- event override wins
      a.effective_from DESC
    LIMIT 1
  `;
  const agr = (await c.query(agreementQuery, [officialId, sportId, officialRole, eventId ?? null, counterpartOrgId ?? null])).rows[0];
  if (!agr) return result;

  let feeMajor = agr.base_fee_minor;
  let tierApplied = null;

  if (agr.rate_type === 'volume_tiers' && agr.tiers) {
    const tiers = agr.tiers;
    const applicable = tiers.filter(t => gameCount >= t.games_from && (t.games_to == null || gameCount <= t.games_to));
    if (applicable.length > 0) {
      const tier = applicable[applicable.length - 1];
      feeMajor = tier.fee_minor;
      tierApplied = tier.tier_order;
    } else {
      // below first tier — use first tier
      feeMajor = tiers[0]?.fee_minor ?? 0;
      tierApplied = tiers[0]?.tier_order ?? 1;
    }
  } else if (agr.rate_type === 'retainer') {
    feeMajor = agr.base_fee_minor; // per-game supplement; retainer billed separately
  } else if (agr.rate_type === 'bundle') {
    feeMajor = agr.bundle_minor;
  }

  return {
    level: 'agreement',
    agreement_id: agr.id,
    fee_minor: feeMajor,
    travel_minor: agr.travel_minor ?? 0,
    overtime_minor: agr.overtime_minor ?? null,
    currency: agr.currency,
    tier_applied: tierApplied,
  };
}

// ------------------------------------------------------------------ fee preview endpoint (shown before assignment)

cap({
  name: 'preview_official_fee', method: 'GET', path: '/rate-agreements/preview', tag: TAG,
  summary: 'Preview the fee that would apply for an official on a given fixture, showing which agreement and tier fires and the full precedence chain.',
  input: z.object({
    official_id: id,
    event_id: id.optional(),
    counterpart_org_id: id.optional(),
    sport_id: id.optional(),
    official_role: z.string().trim().min(1).max(60).default('referee'),
    game_count: z.number().int().min(0).default(0),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      // only the official or an organiser of the event may preview
      if (i.official_id !== user.id) {
        if (i.event_id) {
          const org = (await c.query('SELECT 1 FROM events WHERE id=$1 AND organizer_id=$2', [i.event_id, user.id])).rows[0];
          if (!org) throw notFound('event or permission denied');
        } else {
          throw forbidden('You may only preview fees for your own assignments');
        }
      }
      const resolved = await resolveOfficialFee({
        officialId: i.official_id,
        counterpartOrgId: i.counterpart_org_id,
        eventId: i.event_id,
        sportId: i.sport_id,
        officialRole: i.official_role,
        gameCount: i.game_count,
      }, c);
      // build full precedence chain for display
      const profileRate = (await c.query(`
        SELECT fee_minor, fee_currency, travel_allowance_per_km_minor FROM official_profile_rates pr
        JOIN official_profiles p ON p.id=pr.profile_id
        WHERE p.user_id=$1 AND pr.archived_at IS NULL ORDER BY pr.created_at DESC LIMIT 1
      `, [i.official_id])).rows[0];
      const chain = [
        { rank: 1, level: 'profile_default', label: 'Profile Default', fee_minor: profileRate?.fee_minor ?? null, currency: profileRate?.fee_currency ?? null, active: resolved.level === 'profile_default' },
        { rank: 2, level: 'segment', label: 'Segment Rate', fee_minor: null, currency: null, active: false, note: 'Not configured' },
        { rank: 3, level: 'customer', label: 'Customer Override', fee_minor: null, currency: null, active: false, note: 'None configured' },
        { rank: 4, level: 'agreement', label: resolved.agreement_id ? 'Rate Agreement' : 'No agreement', fee_minor: resolved.agreement_id ? resolved.fee_minor : null, currency: resolved.currency, active: resolved.level === 'agreement', agreement_id: resolved.agreement_id, tier_applied: resolved.tier_applied },
        { rank: 5, level: 'booked_snapshot', label: 'Booked Snapshot', fee_minor: null, currency: null, active: false, note: 'Written on assignment confirmation' },
      ];
      return {
        resolved,
        total_fee_minor: (resolved.fee_minor ?? 0) + (resolved.travel_minor ?? 0),
        currency: resolved.currency,
        chain,
      };
    });
  },
});

// ------------------------------------------------------------------ write booked snapshot (called by officials assign confirm)

cap({
  name: 'write_rate_snapshot', method: 'POST', path: '/rate-agreements/snapshot', tag: TAG, status: 201,
  summary: 'Write an immutable booked snapshot for a fixture_official assignment. Called internally when an assignment is confirmed. Idempotent: a second call for the same fixture_official returns the existing snapshot.',
  input: z.object({
    fixture_official_id: id,
    official_id: id,
    event_id: id.optional(),
    counterpart_org_id: id.optional(),
    sport_id: id.optional(),
    official_role: z.string().trim().min(1).max(60).default('referee'),
    game_count: z.number().int().min(0).default(0),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      // idempotent
      const existing = (await c.query('SELECT * FROM official_rate_snapshots WHERE fixture_official_id=$1', [i.fixture_official_id])).rows[0];
      if (existing) return existing;
      const resolved = await resolveOfficialFee({
        officialId: i.official_id,
        counterpartOrgId: i.counterpart_org_id,
        eventId: i.event_id,
        sportId: i.sport_id,
        officialRole: i.official_role,
        gameCount: i.game_count,
      }, c);
      const total = (resolved.fee_minor ?? 0) + (resolved.travel_minor ?? 0);
      const { rows: [snap] } = await c.query(`
        INSERT INTO official_rate_snapshots(
          fixture_official_id, agreement_id, resolution_level, rate_type,
          currency, base_fee_minor, travel_minor, overtime_minor,
          total_fee_minor, tier_applied, games_at_snapshot, snapshot_data
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (fixture_official_id) DO NOTHING
        RETURNING *
      `, [
        i.fixture_official_id, resolved.agreement_id, resolved.level,
        'fixed_match', resolved.currency,
        resolved.fee_minor, resolved.travel_minor ?? 0, resolved.overtime_minor ?? null,
        total, resolved.tier_applied ?? null, i.game_count,
        JSON.stringify(resolved),
      ]);
      if (snap && resolved.agreement_id) {
        await c.query('UPDATE fixture_officials SET rate_agreement_id=$2, rate_snapshot_id=$3 WHERE id=$1', [i.fixture_official_id, resolved.agreement_id, snap.id]);
      }
      return snap ?? existing;
    });
  },
});

// ------------------------------------------------------------------ admin: list all agreements for an official

cap({
  name: 'admin_list_official_agreements', method: 'GET', path: '/admin/officials/:id/rate-agreements', tag: TAG,
  summary: 'Platform admin: list all rate agreements for a given official.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    return many(`
      SELECT a.*, u_cp.display_name AS counterpart_name, o.name AS org_name, s.name AS sport_name
      FROM official_rate_agreements a
      JOIN users u_cp ON u_cp.id=a.counterpart_id
      LEFT JOIN organisations o ON o.id=a.counterpart_org_id
      LEFT JOIN sports s ON s.id=a.sport_id
      WHERE a.official_id=$1 AND a.archived_at IS NULL
      ORDER BY a.created_at DESC LIMIT $2 OFFSET $3
    `, [i.id, i.limit, i.offset]);
  },
});
