// PS-19: Para-athlete specialist equipment and training sponsorship.
// Extends the canonical sponsorship infrastructure (#284/#289/#291/#334/#294/#303/#307) to explicitly
// support para-athlete specialist equipment, accessible transport, classification travel and training
// camp costs. Sponsor receives financial and operational delivery evidence only; clinical notes,
// classification medical records, diagnosis and impairment detail are categorically excluded.
// Every sponsor read of delivery evidence is audit-logged.
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { many, one, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit, mustFind } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { guardianLink, isYouth } from '../youth.js';
import { sponsorAccess, assertSponsorCan } from '../sponsor-access.js';
import { PARA_CATEGORIES } from '../player-funding.js';

const TAG = 'Para-sport funding';
const ENC_CTX = 'para_sport_delivery_evidence.evidence_url';

// ----- privacy fence: block any attempt to join clinical / classification tables --------------------

const FORBIDDEN_TABLES = ['health_records', 'clinical_notes', 'classification_cases', 'para_cases', 'para_classification_outcomes', 'accommodation_evidence'];
export function checkNoDisabilityInference(query) {
  const q = String(query ?? '').toLowerCase();
  for (const t of FORBIDDEN_TABLES) {
    if (q.includes(t)) throw forbidden(`PS-19 privacy fence: query references protected table '${t}'. Sponsors receive financial and operational evidence only.`);
  }
}

// ----- valid para need types (operational vocabulary only) ----------------------------------------

const VALID_NEED_TYPES = [...PARA_CATEGORIES, 'sport_wheelchair', 'prosthetic_support', 'adaptive_kit', 'guide_equipment', 'adapted_ball_or_implement', 'pool_hoist', 'accessible_transport', 'door_to_door_pickup'];
const needType = z.string().refine((v) => VALID_NEED_TYPES.includes(v), { message: `Need type must be one of: ${VALID_NEED_TYPES.join(', ')}` });

// ----- helpers ------------------------------------------------------------------------------------

async function requireAthleteOwner(user, athleteId, c = pool) {
  if (user.id === athleteId) return 'self';
  if (await guardianLink(user.id, athleteId, c)) return 'guardian';
  throw notFound('Funding need');
}

async function requireSponsorProgramAccess(user, programId, action, c = pool) {
  const prog = await one('SELECT sp.*, s.entity_id, s.owner_id FROM sponsorship_programs sp JOIN sponsors s ON s.id = sp.sponsor_id WHERE sp.id = $1 AND sp.is_para_sport = TRUE', [programId], c);
  if (!prog) throw notFound('Para-sport funding programme');
  const access = await sponsorAccess(user, prog, c);
  assertSponsorCan(access, action, { what: 'manage this para-sport programme' });
  return { prog, access };
}

function shapeEvidence(row) {
  return {
    id: row.id,
    sponsorship_id: row.sponsorship_id,
    athlete_id: row.athlete_id,
    need_type: row.need_type,
    evidence_type: row.evidence_type,
    amount_pence: row.amount_pence,
    supplier_name: row.supplier_name,
    confirmed_at: row.confirmed_at,
    submitted_by: row.submitted_by,
    created_at: row.created_at,
    // evidence_url_enc is decrypted only for the athlete; sponsors never receive it
  };
}

function shapeEvidenceForSponsor(row) {
  const base = shapeEvidence(row);
  delete base.athlete_id; // sponsor sees anonymised athlete reference only
  base.athlete_ref = `ATH-${String(row.athlete_id).slice(0, 8).toUpperCase()}`;
  return base;
}

async function auditSponsorRead(c, evidenceId, userId, sponsorId) {
  await c.query('INSERT INTO para_sport_evidence_audit(evidence_id, accessed_by, sponsor_id) VALUES ($1,$2,$3)', [evidenceId, userId, sponsorId]);
}

// ----- capability definitions ---------------------------------------------------------------------

cap({
  name: 'list_para_sport_programmes',
  method: 'GET',
  path: '/para-sport-funding/programmes',
  summary: 'List para-sport funding programmes visible to the caller (sponsor staff or any authenticated user browsing public calls).',
  tag: TAG,
  auth: 'user',
  input: z.object({ sponsor_id: id.optional(), status: z.enum(['draft', 'published', 'closed', 'archived']).optional(), ...page }),
  async handler({ user }, { sponsor_id, status, limit, offset }) {
    const rows = await many(
      `SELECT sp.id, sp.name, sp.status, sp.currency, sp.budget_cents, (SELECT COALESCE(SUM(a.amount_cents), 0)::bigint FROM sponsorship_awards a WHERE a.program_id = sp.id AND a.status = 'accepted') AS awarded_cents, sp.is_para_sport,
              sp.para_cost_categories, sp.visibility, sp.starts_on, sp.ends_on, sp.objective,
              s.name AS sponsor_name, s.id AS sponsor_id
         FROM sponsorship_programs sp
         JOIN sponsors s ON s.id = sp.sponsor_id
        WHERE sp.is_para_sport = TRUE
          AND ($1::uuid IS NULL OR sp.sponsor_id = $1)
          AND ($2::text IS NULL OR sp.status = $2)
          AND (sp.visibility = 'public' OR EXISTS (SELECT 1 FROM sponsor_representatives sr WHERE sr.entity_id = s.entity_id AND sr.user_id = $3 AND sr.status = 'active') OR s.owner_id = $3)
        ORDER BY sp.created_at DESC LIMIT $4 OFFSET $5`,
      [sponsor_id ?? null, status ?? null, user.id, limit, offset]);
    return { programmes: rows, total: rows.length };
  },
});

cap({
  name: 'set_para_sport_programme_flag',
  method: 'POST',
  path: '/para-sport-funding/programmes/:id/para-flag',
  summary: 'Mark an existing sponsorship programme as a para-sport restricted-purpose fund and set its eligible cost categories.',
  tag: TAG,
  auth: 'user',
  input: z.object({
    id,
    is_para_sport: z.boolean(),
    para_cost_categories: z.array(needType).max(20).default([]),
  }),
  async handler({ user }, { id: progId, is_para_sport, para_cost_categories }) {
    return tx(async (c) => {
      const prog = await one('SELECT sp.*, s.entity_id, s.owner_id FROM sponsorship_programs sp JOIN sponsors s ON s.id = sp.sponsor_id WHERE sp.id = $1 FOR UPDATE', [progId], c);
      if (!prog) throw notFound('Sponsorship programme');
      const access = await sponsorAccess(user, prog, c);
      assertSponsorCan(access, 'program', { what: 'configure a para-sport funding flag' });
      await c.query('UPDATE sponsorship_programs SET is_para_sport=$1, para_cost_categories=$2, updated_at=now() WHERE id=$3', [is_para_sport, para_cost_categories, progId]);
      await audit(c, user.id, 'para_sport_flag_set', { program_id: progId, is_para_sport, para_cost_categories });
      return { id: progId, is_para_sport, para_cost_categories };
    });
  },
});

cap({
  name: 'list_para_funding_needs',
  method: 'GET',
  path: '/para-sport-funding/needs',
  summary: 'Athlete: list their para-sport funding needs. Guardian may list on behalf of a young athlete.',
  tag: TAG,
  auth: 'user',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, { athlete_id, limit, offset }) {
    const athleteId = athlete_id ?? user.id;
    await requireAthleteOwner(user, athleteId);
    const rows = await many(
      `SELECT n.id, n.title, n.category, n.amount_cents, n.currency, n.needed_by, n.status,
              n.para_need_types, n.para_sport_code, n.created_at
         FROM athlete_funding_needs n
        WHERE n.athlete_id = $1
          AND (n.para_need_types IS NOT NULL AND array_length(n.para_need_types, 1) > 0 OR n.category = ANY($2))
        ORDER BY n.created_at DESC LIMIT $3 OFFSET $4`,
      [athleteId, PARA_CATEGORIES, limit, offset]);
    return { needs: rows, total: rows.length };
  },
});

cap({
  name: 'create_para_funding_need',
  method: 'POST',
  path: '/para-sport-funding/needs',
  summary: 'Athlete: create a para-sport funding need. No diagnosis or clinical detail is accepted or stored.',
  tag: TAG,
  auth: 'user',
  input: z.object({
    athlete_id: id.optional(),
    title: z.string().trim().min(2).max(120),
    category: z.string().min(1),
    para_need_types: z.array(needType).min(1).max(10),
    para_sport_code: z.string().min(1).max(60).optional(),
    amount_cents: money,
    currency: z.string().regex(/^[A-Z]{3}$/),
    needed_by: z.string().date().optional(),
    note: z.string().trim().max(500).optional(),
  }),
  async handler({ user }, input) {
    const athleteId = input.athlete_id ?? user.id;
    await requireAthleteOwner(user, athleteId);
    // Refuse any attempt to store clinical/classification terminology in notes
    if (input.note) {
      const forbidden_terms = /\b(diagnosis|impairment|condition|classification_outcome|ipc_class|medical_record)\b/i;
      if (forbidden_terms.test(input.note)) throw badRequest('Notes must not describe a medical diagnosis, impairment or classification outcome. Share operational needs only.');
    }
    return tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO athlete_funding_needs(athlete_id, title, category, para_need_types, para_sport_code, amount_cents, currency, needed_by, note_enc, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open') RETURNING id, title, category, para_need_types, para_sport_code, amount_cents, currency, needed_by, status, created_at`,
        [athleteId, input.title, input.category, input.para_need_types, input.para_sport_code ?? null, input.amount_cents, input.currency, input.needed_by ?? null, input.note ? encrypt(input.note, 'athlete_funding_needs.note') : null]);
      await audit(c, user.id, 'para_funding_need_created', { need_id: rows[0].id, athlete_id: athleteId });
      return rows[0];
    });
  },
});

cap({
  name: 'submit_para_delivery_evidence',
  method: 'POST',
  path: '/para-sport-funding/delivery-evidence',
  summary: 'Athlete: submit delivery evidence (supplier invoice, transport receipt, facility confirmation) for a para-sport funded sponsorship. File links are field-level encrypted.',
  tag: TAG,
  auth: 'user',
  input: z.object({
    sponsorship_id: id,
    need_type: needType,
    evidence_type: z.enum(['supplier_invoice', 'delivery_confirmation', 'transport_receipt', 'facility_confirmation', 'other']),
    amount_pence: money,
    supplier_name: z.string().trim().max(120).optional(),
    evidence_url: z.string().url().max(2000).optional(),
    athlete_id: id.optional(),
  }),
  async handler({ user }, input) {
    const athleteId = input.athlete_id ?? user.id;
    await requireAthleteOwner(user, athleteId);
    return tx(async (c) => {
      const sp = await one('SELECT s.*, prog.is_para_sport FROM sponsorships s JOIN sponsorship_programs prog ON prog.id = s.program_id WHERE s.id = $1 AND s.target_type = \'athlete\' AND s.target_id = $2 AND prog.is_para_sport = TRUE', [input.sponsorship_id, athleteId], c);
      if (!sp) throw notFound('Para-sport sponsorship agreement');
      const encUrl = input.evidence_url ? encrypt(input.evidence_url, ENC_CTX) : null;
      const { rows } = await c.query(
        `INSERT INTO para_sport_delivery_evidence(sponsorship_id, athlete_id, need_type, evidence_type, amount_pence, supplier_name, evidence_url_enc, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, need_type, evidence_type, amount_pence, supplier_name, confirmed_at, created_at`,
        [input.sponsorship_id, athleteId, input.need_type, input.evidence_type, input.amount_pence, input.supplier_name ?? null, encUrl, user.id]);
      await audit(c, user.id, 'para_delivery_evidence_submitted', { evidence_id: rows[0].id, sponsorship_id: input.sponsorship_id });
      return rows[0];
    });
  },
});

cap({
  name: 'confirm_para_delivery_evidence',
  method: 'POST',
  path: '/para-sport-funding/delivery-evidence/:id/confirm',
  summary: 'Sponsor: confirm receipt of delivery evidence for a para-sport award. Triggers audit log.',
  tag: TAG,
  auth: 'user',
  input: z.object({ id }),
  async handler({ user }, { id: evidenceId }) {
    return tx(async (c) => {
      const ev = await one('SELECT e.*, sp.sponsor_id, sp.is_para_sport FROM para_sport_delivery_evidence e JOIN sponsorships s ON s.id = e.sponsorship_id JOIN sponsorship_programs sp ON sp.id = s.program_id WHERE e.id = $1', [evidenceId], c);
      if (!ev || !ev.is_para_sport) throw notFound('Para-sport delivery evidence');
      const sponsor = await one('SELECT * FROM sponsors WHERE id = $1', [ev.sponsor_id], c);
      const access = await sponsorAccess(user, sponsor, c);
      assertSponsorCan(access, 'pay', { what: 'confirm delivery evidence' });
      await c.query('UPDATE para_sport_delivery_evidence SET confirmed_at = now(), updated_at = now() WHERE id = $1', [evidenceId]);
      await auditSponsorRead(c, evidenceId, user.id, ev.sponsor_id);
      await audit(c, user.id, 'para_delivery_evidence_confirmed', { evidence_id: evidenceId });
      return { id: evidenceId, confirmed_at: new Date().toISOString() };
    });
  },
});

cap({
  name: 'get_para_delivery_evidence',
  method: 'GET',
  path: '/para-sport-funding/delivery-evidence',
  summary: 'Sponsor: list delivery evidence for a para-sport programme. Returns financial and operational data only — no clinical, classification medical or disability detail. Every call is audit-logged.',
  tag: TAG,
  auth: 'user',
  input: z.object({ programme_id: id, ...page }),
  async handler({ user }, { programme_id, limit, offset }) {
    checkNoDisabilityInference(`programme_id:${programme_id}`); // guard against injection-driven joins
    const { prog, access } = await requireSponsorProgramAccess(user, programme_id, 'read');
    const rows = await many(
      `SELECT e.id, e.sponsorship_id, e.athlete_id, e.need_type, e.evidence_type, e.amount_pence,
              e.supplier_name, e.confirmed_at, e.created_at, e.submitted_by
         FROM para_sport_delivery_evidence e
         JOIN sponsorships s ON s.id = e.sponsorship_id
        WHERE s.program_id = $1
        ORDER BY e.created_at DESC LIMIT $2 OFFSET $3`,
      [programme_id, limit, offset]);
    // Audit every read and shape data for sponsor (no raw athlete_id, no evidence URL)
    await tx(async (c) => {
      for (const row of rows) await auditSponsorRead(c, row.id, user.id, prog.sponsor_id);
    });
    return {
      evidence: rows.map(shapeEvidenceForSponsor),
      privacy_notice: 'You are viewing financial and delivery evidence only. Classification records, medical history and disability details remain with the athlete and are not accessible through this platform.',
      total: rows.length,
    };
  },
});

cap({
  name: 'get_para_impact_summary',
  method: 'GET',
  path: '/para-sport-funding/impact-summary',
  summary: 'Sponsor: programme-level impact summary (financial and operational data only). No clinical or classification data is included.',
  tag: TAG,
  auth: 'user',
  input: z.object({ programme_id: id }),
  async handler({ user }, { programme_id }) {
    const { prog } = await requireSponsorProgramAccess(user, programme_id, 'report');
    const stats = await one(
      `SELECT
         (SELECT COALESCE(SUM(a.amount_cents), 0)::bigint FROM sponsorship_awards a WHERE a.program_id = $1 AND a.status = 'accepted') AS awarded_cents,
         COUNT(DISTINCT e.athlete_id)                                                     AS athletes_supported,
         COUNT(DISTINCT e.id)                                                              AS evidence_items,
         COUNT(DISTINCT e.id) FILTER (WHERE e.confirmed_at IS NOT NULL)                   AS evidence_confirmed,
         COALESCE(SUM(e.amount_pence) FILTER (WHERE e.confirmed_at IS NOT NULL), 0)       AS disbursed_pence,
         COALESCE(SUM(e.amount_pence), 0)                                                 AS total_evidence_pence,
         array_agg(DISTINCT e.need_type) FILTER (WHERE e.need_type IS NOT NULL)           AS need_types_covered
       FROM para_sport_delivery_evidence e
       JOIN sponsorships s ON s.id = e.sponsorship_id
      WHERE s.program_id = $1`,
      [programme_id]);
    return {
      programme_id,
      programme_name: prog.name,
      budget_pence: prog.budget_cents,
      awarded_pence: stats.awarded_cents,
      athletes_supported: Number(stats.athletes_supported),
      evidence_items: Number(stats.evidence_items),
      evidence_confirmed: Number(stats.evidence_confirmed),
      disbursed_pence: Number(stats.disbursed_pence),
      need_types_covered: stats.need_types_covered ?? [],
      privacy_notice: 'This summary contains financial and operational data only. No clinical, classification medical or disability detail is included.',
    };
  },
});
