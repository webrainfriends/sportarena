// PS-24 Para-sport insurance: insurer-authored discipline attributes, exclusion/unknown disclosure,
// and equipment asset linkage on existing policies. All endpoints are additive; existing insurance.*
// capabilities are unchanged. Never invent coverage — all para attributes are insurer-authored only.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit, isAdmin, mustFind } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { actsFor, myInsurer, PLAN_SQL, card, COVER_FOR, insurerOfPolicy, loadPlan, mask, standing } from './insurance.js';

export const PARA_EVENT_TYPES = ['sanctioned_competition', 'recreational', 'training_camp', 'trial', 'mixed_ability'];

const DISCLOSURE_NOTE = 'Coverage details for para-sport are provided by the insurer and have not been verified or endorsed by the platform. Contact the insurer before purchasing.';

function neverInventCoverage(plan) {
  const hasParaDisciplines = Array.isArray(plan.para_disciplines) && plan.para_disciplines.length > 0;
  const hasExclusions = plan.para_exclusions != null;
  const disclosure_gap = hasParaDisciplines && !hasExclusions;
  return { ...plan, disclosure_gap, disclosure_note: disclosure_gap ? DISCLOSURE_NOTE : null };
}

/** Extend a plan row with para-sport columns from insurance_plans. */
const PARA_PLAN_SQL = `${PLAN_SQL}, pl.para_disciplines, pl.para_event_types, pl.para_equipment_cover, pl.para_travel_cover, pl.para_exclusions, pl.para_coverage_unknowns`;

/** Validate that every slug in an array exists as a para sport in the catalogue. Throws badRequest if any are unknown. */
async function validateParaDisciplines(slugs) {
  if (!slugs || slugs.length === 0) return;
  const known = await many(
    'SELECT slug FROM sports WHERE slug = ANY($1) AND is_para = true',
    [slugs],
  );
  const knownSet = new Set(known.map((r) => r.slug));
  const unknown = slugs.filter((s) => !knownSet.has(s));
  if (unknown.length) throw badRequest(`Unknown para-sport discipline(s): ${unknown.join(', ')}`);
}

/** Insurer column subset safe for public responses — no licence, no owner_id. */
const PARA_INSURER_COLS = `i.id, i.name, i.headline, i.website, i.regions, i.sports, (i.verified_at IS NOT NULL) AS verified, i.para_capable, i.para_disciplines`;

cap({
  name: 'list_para_capable_insurers', method: 'GET', path: '/insurance/para/insurers', tag: 'Insurance', auth: 'public',
  summary: 'Insurers that have declared para-sport capability, with the disciplines they cover. Filter by discipline, event type, equipment or travel cover. No personal or licence data.',
  input: z.object({
    q: z.string().max(80).optional(),
    discipline: z.string().max(80).optional(),
    event_type: z.enum(PARA_EVENT_TYPES).optional(),
    equipment_cover: z.coerce.boolean().optional(),
    travel_cover: z.coerce.boolean().optional(),
    ...page,
  }),
  handler: (_, i) => many(
    `SELECT ${PARA_INSURER_COLS}
       FROM insurers i
      WHERE i.status = 'active'
        AND i.para_capable = true
        AND ($1::text IS NULL OR i.name ILIKE '%' || $1 || '%' OR i.headline ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR i.para_disciplines @> ARRAY[$2::text])
      ORDER BY i.name
      LIMIT $3 OFFSET $4`,
    [i.q ? i.q.replace(/[%_\\]/g, '\\$&') : null, i.discipline ?? null, i.limit, i.offset],
  ),
});

cap({
  name: 'list_para_plans', method: 'GET', path: '/insurance/para/plans', tag: 'Insurance', auth: 'public',
  summary: 'Insurance plans with insurer-authored para-sport discipline attributes. Each card carries a disclosure_gap flag when the insurer has not stated para exclusions, and a mandatory disclosure_note — never platform-inferred coverage.',
  input: z.object({
    discipline: z.string().max(80).optional(),
    event_type: z.enum(PARA_EVENT_TYPES).optional(),
    equipment_cover: z.coerce.boolean().optional(),
    travel_cover: z.coerce.boolean().optional(),
    cover_for: z.enum(COVER_FOR).optional(),
    ...page,
  }),
  async handler(_, i) {
    const rows = await many(
      `${PARA_PLAN_SQL.replace('$CUR', '$7')}
        WHERE pl.status = 'active'
          AND ($1::text IS NULL OR pl.para_disciplines @> ARRAY[$1::text])
          AND ($2::text IS NULL OR pl.para_event_types @> ARRAY[$2::text])
          AND (NOT $3 OR pl.para_equipment_cover = true)
          AND (NOT $4 OR pl.para_travel_cover = true)
          AND ($5::text IS NULL OR pl.cover_for = $5::text)
        ORDER BY pl.premium_cents, pl.name
        LIMIT $6 OFFSET $8`,
      [i.discipline ?? null, i.event_type ?? null, !!i.equipment_cover, !!i.travel_cover, i.cover_for ?? null, i.limit, config.payments.currency, i.offset],
    );
    return rows.map(card).map(neverInventCoverage);
  },
});

cap({
  name: 'compare_para_plans', method: 'GET', path: '/insurance/para/plan-comparison', tag: 'Insurance', auth: 'public',
  summary: 'Compare 2–5 plans side by side on para-sport coverage: disciplines, event types, equipment and travel cover, insurer-authored exclusions and coverage unknowns. A disclosure block flags plans that have not stated their para exclusions. Never invents or supplements insurer-provided terms.',
  input: z.object({
    ids: z.string().describe('comma-separated plan ids (2-5)'),
    discipline: z.string().max(80).optional(),
  }),
  async handler(_, i) {
    const ids = [...new Set(i.ids.split(',').map((x) => x.trim()).filter(Boolean))];
    if (ids.length < 2 || ids.length > 5 || ids.some((x) => !z.string().uuid().safeParse(x).success)) throw badRequest('Give 2 to 5 plan ids, separated by commas');
    const rows = (await many(`${PARA_PLAN_SQL.replace('$CUR', '$2')} WHERE pl.id = ANY($1)`, [ids, config.payments.currency])).map(card).map(neverInventCoverage);
    if (rows.length !== ids.length) throw notFound('Plan');
    const plans = ids.map((x) => rows.find((r) => r.id === x));
    const paraFields = ['para_disciplines', 'para_event_types', 'para_equipment_cover', 'para_travel_cover', 'para_exclusions', 'para_coverage_unknowns'];
    const para_differences = paraFields.filter((f) => new Set(plans.map((p) => JSON.stringify(p[f] ?? null))).size > 1);
    const plans_with_no_exclusions = plans.filter((p) => p.disclosure_gap).map((p) => p.id);
    const plans_with_unknowns = plans.filter((p) => p.para_coverage_unknowns != null).map((p) => p.id);
    return {
      plans,
      para_differences,
      disclosure: {
        plans_with_no_para_exclusions_stated: plans_with_no_exclusions,
        plans_with_unknowns,
        disclosure_note: DISCLOSURE_NOTE,
      },
    };
  },
});

cap({
  name: 'set_plan_para_attributes', method: 'PATCH', path: '/insurance/para/plans/:id/para', tag: 'Insurance', auth: ['insurer'],
  summary: 'Insurer: set or update the para-sport coverage attributes on one of your plans — disciplines covered, event types, equipment and travel cover, public exclusions, public coverage unknowns, and private coverage notes (encrypted). All text is authored by the insurer; the platform never modifies or supplements it.',
  input: z.object({
    id,
    para_disciplines: z.array(z.string().max(80)).max(30).optional(),
    para_event_types: z.array(z.enum(PARA_EVENT_TYPES)).optional(),
    para_equipment_cover: z.boolean().optional(),
    para_travel_cover: z.boolean().optional(),
    para_exclusions: z.string().max(4000).nullable().optional(),
    para_coverage_unknowns: z.string().max(2000).nullable().optional(),
    para_coverage_notes: z.string().max(2000).nullable().optional(),
  }),
  async handler({ user }, i) {
    const plan = await mustFind('insurance_plans', i.id);
    const ins = await one('SELECT * FROM insurers WHERE id=$1', [plan.insurer_id]);
    if (!actsFor(user, ins)) throw forbidden('That plan belongs to another insurer');
    if (i.para_disciplines) await validateParaDisciplines(i.para_disciplines);
    const notesEnc = i.para_coverage_notes !== undefined
      ? (i.para_coverage_notes ? encrypt(i.para_coverage_notes, 'insurance_plans.para_coverage_notes') : null)
      : undefined;
    const updates = {
      ...(i.para_disciplines !== undefined && { para_disciplines: i.para_disciplines }),
      ...(i.para_event_types !== undefined && { para_event_types: i.para_event_types }),
      ...(i.para_equipment_cover !== undefined && { para_equipment_cover: i.para_equipment_cover }),
      ...(i.para_travel_cover !== undefined && { para_travel_cover: i.para_travel_cover }),
      ...(i.para_exclusions !== undefined && { para_exclusions: i.para_exclusions }),
      ...(i.para_coverage_unknowns !== undefined && { para_coverage_unknowns: i.para_coverage_unknowns }),
      ...(notesEnc !== undefined && { para_coverage_notes_enc: notesEnc }),
    };
    if (!Object.keys(updates).length) throw badRequest('No para attributes to update');
    const setClauses = Object.keys(updates).map((k, idx) => `${k}=$${idx + 2}`).join(', ');
    const values = [plan.id, ...Object.values(updates)];
    const updated = await one(`UPDATE insurance_plans SET ${setClauses}, updated_at=now() WHERE id=$1 RETURNING id, name, para_disciplines, para_event_types, para_equipment_cover, para_travel_cover, para_exclusions, para_coverage_unknowns, insurer_id`, values);
    await audit(null, user.id, 'update_plan_para', 'insurance_plans', plan.id);
    return neverInventCoverage(updated);
  },
});

cap({
  name: 'get_plan_para_notes', method: 'GET', path: '/insurance/para/plans/:id/notes', tag: 'Insurance', auth: ['insurer'],
  summary: 'Insurer: read the private coverage notes you stored on this plan. Encrypted at rest; decrypted only here, audit-logged on every read.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const plan = await mustFind('insurance_plans', i.id, 'id, insurer_id, para_coverage_notes_enc');
    const ins = await one('SELECT * FROM insurers WHERE id=$1', [plan.insurer_id]);
    if (!actsFor(user, ins)) throw forbidden('That plan belongs to another insurer');
    await audit(null, user.id, 'read_para_notes', 'insurance_plans', plan.id);
    return { notes: plan.para_coverage_notes_enc ? decrypt(plan.para_coverage_notes_enc, 'insurance_plans.para_coverage_notes') : null };
  },
});

cap({
  name: 'set_insurer_para_capability', method: 'PATCH', path: '/insurance/para/insurers/:id/para', tag: 'Insurance', auth: ['insurer'],
  summary: 'Insurer: declare or update your para-sport capability flag and the disciplines you are prepared to cover. Disciplines are validated against the para-sport catalogue.',
  input: z.object({
    id,
    para_capable: z.boolean(),
    para_disciplines: z.array(z.string().max(80)).max(30).optional(),
  }),
  async handler({ user }, i) {
    const ins = await mustFind('insurers', i.id);
    if (!actsFor(user, ins)) throw forbidden('That insurer profile belongs to another account');
    if (i.para_disciplines) await validateParaDisciplines(i.para_disciplines);
    const updated = await one(
      `UPDATE insurers SET para_capable=$2, para_disciplines=coalesce($3, para_disciplines), updated_at=now()
        WHERE id=$1 RETURNING id, name, para_capable, para_disciplines`,
      [ins.id, i.para_capable, i.para_disciplines ?? null],
    );
    await audit(null, user.id, 'update_insurer_para', 'insurers', ins.id);
    return updated;
  },
});

/** Load a policy and check that `user` has at least `level` standing. Returns { policy, policyStanding }. */
async function requirePolicyStanding(user, policyId, level) {
  const policy = await mustFind('insurance_policies', policyId);
  const s = await standing(user, policy.subject_type, policy.subject_id);
  if (level === 'manage' && s !== 'manage') {
    if (!(await insurerOfPolicy(user, policy))) throw forbidden('You do not manage this policy');
  } else if (!s) {
    if (!(await insurerOfPolicy(user, policy))) throw notFound('Policy');
  }
  return { policy, policyStanding: s };
}

cap({
  name: 'add_policy_equipment', method: 'POST', path: '/insurance/para/policies/:id/equipment', tag: 'Insurance', status: 201,
  summary: 'Link a piece of specialised equipment to a para-sport policy: serial number (encrypted), insured value, optional event context and asset reference. Visible only to the policy holder and insurer.',
  input: z.object({
    id,
    asset_ref: z.string().uuid().optional(),
    serial_no: z.string().max(80).optional(),
    insured_value_cents: z.number().int().min(1),
    description: z.string().min(1).max(500),
    event_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    const { policy } = await requirePolicyStanding(user, i.id, 'manage');
    const entry = {
      id: randomUUID(),
      asset_ref: i.asset_ref ?? null,
      serial_no_enc: i.serial_no ? encrypt(i.serial_no, 'insurance_policies.equipment_serial_no') : null,
      insured_value_cents: i.insured_value_cents,
      description: i.description,
      event_id: i.event_id ?? null,
      added_at: new Date().toISOString(),
    };
    await one(
      `UPDATE insurance_policies SET para_equipment_assets = para_equipment_assets || $2::jsonb WHERE id=$1 RETURNING id`,
      [policy.id, JSON.stringify(entry)],
    );
    await audit(null, user.id, 'add_policy_equipment', 'insurance_policies', policy.id);
    return { ...entry, serial_no_enc: undefined, serial_no: i.serial_no ? mask(i.serial_no) : null };
  },
});

cap({
  name: 'list_policy_equipment', method: 'GET', path: '/insurance/para/policies/:id/equipment', tag: 'Insurance',
  summary: 'Equipment linked to a para-sport policy, with serial numbers masked. Audit-logged on every read.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { policy } = await requirePolicyStanding(user, i.id, 'member');
    const assets = Array.isArray(policy.para_equipment_assets) ? policy.para_equipment_assets : [];
    await audit(null, user.id, 'list_policy_equipment', 'insurance_policies', policy.id);
    return assets.map(({ serial_no_enc, ...entry }) => ({
      ...entry,
      serial_no: serial_no_enc ? mask(decrypt(serial_no_enc, 'insurance_policies.equipment_serial_no')) : null,
    }));
  },
});

cap({
  name: 'remove_policy_equipment', method: 'DELETE', path: '/insurance/para/policies/:id/equipment/:entry_id', tag: 'Insurance',
  summary: 'Remove a piece of equipment from a para-sport policy. Manage-level standing required.',
  input: z.object({ id, entry_id: z.string().uuid() }),
  async handler({ user }, i) {
    const { policy } = await requirePolicyStanding(user, i.id, 'manage');
    const assets = Array.isArray(policy.para_equipment_assets) ? policy.para_equipment_assets : [];
    const next = assets.filter((e) => e.id !== i.entry_id);
    if (next.length === assets.length) throw notFound('Equipment entry');
    await one(
      `UPDATE insurance_policies SET para_equipment_assets=$2::jsonb WHERE id=$1 RETURNING id`,
      [policy.id, JSON.stringify(next)],
    );
    await audit(null, user.id, 'remove_policy_equipment', 'insurance_policies', policy.id);
    return { removed: i.entry_id };
  },
});
