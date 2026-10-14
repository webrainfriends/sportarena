// Exercise library and individual treatment plans (#210). The plan is clinical: only a verified physio/doctor with the patient's active
// FULL consent can prescribe or read it; the patient always keeps their own. Published versions are immutable; edits make a new draft.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';

const TAG = 'Health';
export const REGIONS = ['neck', 'shoulder', 'elbow', 'wrist_hand', 'upper_back', 'lower_back', 'hip', 'knee', 'ankle_foot', 'core', 'full_body'];
export const GOALS = ['mobility', 'strength', 'stability', 'balance', 'endurance', 'pain_relief', 'return_to_sport'];
const TAGS = z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9_ -]{2,30}$/)).max(10);

// ------------------------------------------------------------------ exercise library (provider-owned)
const EX_COLS = `e.id, e.owner_id, e.archived_at, v.id AS version_id, v.version, v.title, v.body_region, v.equipment, v.difficulty, v.goal, v.language, v.instructions, v.precautions, v.media_url, v.media_source, v.media_licence`;
const EX_FROM = 'FROM exercises e JOIN LATERAL (SELECT * FROM exercise_versions WHERE exercise_id=e.id ORDER BY version DESC LIMIT 1) v ON true';

cap({
  name: 'upsert_exercise', method: 'POST', path: '/me/exercises', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: add an exercise to your library or, with `id`, save a new version of one (plans already published keep the version they used). Instructions are generic teaching content: never put patient information in them. A media link needs its source and licence.',
  input: z.object({
    id: id.optional(), title: z.string().trim().min(2).max(120), body_region: z.enum(REGIONS), equipment: TAGS.default([]), difficulty: z.enum(['beginner', 'intermediate', 'advanced']), goal: z.enum(GOALS),
    language: z.string().trim().min(2).max(8).default('en'), instructions: z.string().trim().min(5).max(3000), precautions: z.string().max(1000).nullable().optional(),
    media_url: z.string().url().startsWith('https://').nullable().optional(), media_source: z.string().max(120).nullable().optional(), media_licence: z.string().max(120).nullable().optional(),
  }),
  async handler({ user }, i) {
    if (i.media_url && (!i.media_source || !i.media_licence)) throw badRequest('A media link needs its source and licence (use "original" for your own)');
    return tx(async (c) => {
      let ex;
      if (i.id) {
        ex = (await c.query('SELECT * FROM exercises WHERE id=$1 AND owner_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
        if (!ex) throw notFound('Exercise');
        if (ex.archived_at) throw badRequest('This exercise is archived');
      } else ex = (await c.query('INSERT INTO exercises(owner_id) VALUES ($1) RETURNING *', [user.id])).rows[0];
      const n = (await c.query('SELECT coalesce(max(version),0)+1 AS n FROM exercise_versions WHERE exercise_id=$1', [ex.id])).rows[0].n;
      await c.query('INSERT INTO exercise_versions(exercise_id, version, title, body_region, equipment, difficulty, goal, language, instructions, precautions, media_url, media_source, media_licence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [ex.id, n, i.title, i.body_region, i.equipment, i.difficulty, i.goal, i.language, i.instructions, i.precautions ?? null, i.media_url ?? null, i.media_source ?? null, i.media_licence ?? null]);
      return (await c.query(`SELECT ${EX_COLS} ${EX_FROM} WHERE e.id=$1`, [ex.id])).rows[0];
    });
  },
});

cap({
  name: 'archive_exercise', method: 'POST', path: '/me/exercises/:id/archive', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: hide an exercise from new plans. It is kept; plans that use it are unchanged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE exercises SET archived_at=COALESCE(archived_at, now()) WHERE id=$1 AND owner_id=$2 RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Exercise');
    return r;
  },
});

cap({
  name: 'list_my_exercises', method: 'GET', path: '/me/exercises', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: search your exercise library by text, body region, equipment, difficulty, goal and language. Returns the latest version of each plus the real catalogue count.',
  input: z.object({ q: z.string().trim().max(60).optional(), body_region: z.enum(REGIONS).optional(), equipment: z.string().trim().toLowerCase().max(30).optional(), difficulty: z.enum(['beginner', 'intermediate', 'advanced']).optional(), goal: z.enum(GOALS).optional(), language: z.string().max(8).optional(), include_archived: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const where = `e.owner_id=$1 AND ($2::boolean OR e.archived_at IS NULL) AND ($3::text IS NULL OR v.title ILIKE '%' || $3 || '%' OR v.instructions ILIKE '%' || $3 || '%') AND ($4::text IS NULL OR v.body_region=$4) AND ($5::text IS NULL OR $5 = ANY(v.equipment)) AND ($6::text IS NULL OR v.difficulty=$6) AND ($7::text IS NULL OR v.goal=$7) AND ($8::text IS NULL OR v.language=$8)`;
    const a = [user.id, i.include_archived, i.q ?? null, i.body_region ?? null, i.equipment ?? null, i.difficulty ?? null, i.goal ?? null, i.language ?? null];
    const total = (await one(`SELECT count(*)::int AS n ${EX_FROM} WHERE ${where}`, a)).n;
    return { total, items: await many(`SELECT ${EX_COLS} ${EX_FROM} WHERE ${where} ORDER BY v.title, e.id LIMIT $9 OFFSET $10`, [...a, i.limit, i.offset]) };
  },
});

// ------------------------------------------------------------------ treatment plans
const item = z.object({
  exercise_id: id, phase: z.number().int().min(1).max(12).default(1), side: z.enum(['left', 'right', 'both']).optional(), sets: z.number().int().min(1).max(20).optional(), reps: z.number().int().min(1).max(200).optional(),
  hold_sec: z.number().int().min(0).max(600).optional(), rest_sec: z.number().int().min(0).max(600).optional(), times_per_week: z.number().int().min(1).max(14).optional(),
  load_value: z.number().min(0).optional(), load_unit: z.enum(['kg', 'lb', 'band_level', 'percent_1rm', 'bodyweight']).optional(), tempo: z.string().max(20).optional(),
  notes: z.string().max(500).optional().describe('shown to the patient'), stop_instructions: z.string().max(500).optional().describe('shown to the patient: when to stop or call you'),
});
const content = {
  goals: z.string().max(1500).optional().describe('shown to the patient'), patient_instructions: z.string().max(3000).optional().describe('shown to the patient'),
  private_notes: z.string().max(3000).optional().describe('only you see these'), review_date: z.string().date().optional(), items: z.array(item).max(60).default([]),
};

/** Provider gate: current credential + active FULL consent, rechecked under lock inside the write's transaction. */
async function gateWrite(c, user, patientId, cred) {
  await lockCredential(c, cred);
  if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [patientId, user.id])).rows[0]) throw forbidden('The patient has not granted you access');
}
async function providerPre(user, patientId, action) {
  const cred = await requireVerifiedProvider(user.id, { action, athleteId: patientId });
  if (!(await hasGrant(patientId, user.id))) throw forbidden('The patient has not granted you access');
  return cred;
}

async function writeDraft(c, user, versionId, i) {
  const ids = [...new Set(i.items.map((x) => x.exercise_id))];
  let byEx = new Map();
  if (ids.length) {
    const ok = (await c.query('SELECT e.id, v.id AS version_id FROM exercises e JOIN LATERAL (SELECT id FROM exercise_versions WHERE exercise_id=e.id ORDER BY version DESC LIMIT 1) v ON true WHERE e.owner_id=$1 AND e.archived_at IS NULL AND e.id = ANY($2)', [user.id, ids])).rows;
    if (ok.length !== ids.length) throw badRequest('Use your own active exercises');
    byEx = new Map(ok.map((r) => [r.id, r.version_id]));
  }
  await c.query('UPDATE treatment_plan_versions SET goals_enc=$2, patient_instructions_enc=$3, private_notes_enc=$4, review_date=$5 WHERE id=$1', [versionId, encrypt(i.goals, 'treatment_plans.goals'), encrypt(i.patient_instructions, 'treatment_plans.instructions'), encrypt(i.private_notes, 'treatment_plans.private'), i.review_date ?? null]);
  await c.query('DELETE FROM treatment_plan_items WHERE plan_version_id=$1', [versionId]); // only ever a draft: published versions are immutable
  let pos = 0;
  for (const x of i.items) {
    await c.query('INSERT INTO treatment_plan_items(plan_version_id, position, phase, exercise_version_id, side, sets, reps, hold_sec, rest_sec, times_per_week, load_value, load_unit, tempo, notes_enc, stop_instructions_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [versionId, ++pos, x.phase, byEx.get(x.exercise_id), x.side ?? null, x.sets ?? null, x.reps ?? null, x.hold_sec ?? null, x.rest_sec ?? null, x.times_per_week ?? null, x.load_value ?? null, x.load_unit ?? null, x.tempo ?? null, encrypt(x.notes, 'treatment_plans.item_notes'), encrypt(x.stop_instructions, 'treatment_plans.item_stop')]);
  }
}

async function render(planId, viewer) {
  const plan = await one('SELECT p.*, pu.display_name AS patient_name, du.display_name AS provider_name FROM treatment_plans p JOIN users pu ON pu.id=p.patient_id JOIN users du ON du.id=p.provider_id WHERE p.id=$1', [planId]);
  const isProvider = viewer === plan.provider_id;
  // the patient sees published versions only; the provider also sees the working draft
  const versions = await many(`SELECT * FROM treatment_plan_versions WHERE plan_id=$1 ${isProvider ? '' : "AND status IN ('published','superseded')"} ORDER BY version DESC`, [planId]);
  const out = [];
  for (const v of versions) {
    const items = await many(`SELECT i.*, x.exercise_id, x.title, x.body_region, x.instructions, x.precautions, x.media_url, x.version AS exercise_version FROM treatment_plan_items i JOIN exercise_versions x ON x.id=i.exercise_version_id WHERE i.plan_version_id=$1 ORDER BY i.position`, [v.id]);
    out.push({
      id: v.id, version: v.version, status: v.status, review_date: v.review_date, material_change: v.material_change, published_at: v.published_at, acknowledged_at: v.acknowledged_at,
      goals: decrypt(v.goals_enc, 'treatment_plans.goals'), patient_instructions: decrypt(v.patient_instructions_enc, 'treatment_plans.instructions'),
      ...(isProvider ? { private_notes: decrypt(v.private_notes_enc, 'treatment_plans.private') } : {}),
      items: items.map(({ notes_enc, stop_instructions_enc, id: itemId, plan_version_id, exercise_version_id, ...r }) => ({ id: itemId, ...r, notes: decrypt(notes_enc, 'treatment_plans.item_notes'), stop_instructions: decrypt(stop_instructions_enc, 'treatment_plans.item_stop') })),
    });
  }
  return { id: plan.id, title: plan.title, status: plan.status, patient_id: plan.patient_id, patient_name: plan.patient_name, provider_id: plan.provider_id, provider_name: plan.provider_name, updated_at: plan.updated_at, versions: out };
}

cap({
  name: 'create_treatment_plan', credential: true, method: 'POST', path: '/treatment-plans', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Physio/doctor: start an individual treatment plan for a patient who granted you full access (needs a current verified credential). Creates version 1 as a draft; nothing reaches the patient until you publish it. Goals, instructions and notes are encrypted.',
  input: z.object({ patient_id: id, title: z.string().trim().min(2).max(120), ...content }),
  async handler({ user }, i) {
    if (i.patient_id === user.id) throw badRequest('Choose a patient');
    const cred = await providerPre(user, i.patient_id, 'create_treatment_plan');
    const planId = await tx(async (c) => {
      await gateWrite(c, user, i.patient_id, cred);
      const p = (await c.query('INSERT INTO treatment_plans(provider_id, patient_id, title) VALUES ($1,$2,$3) RETURNING id', [user.id, i.patient_id, i.title])).rows[0];
      const v = (await c.query('INSERT INTO treatment_plan_versions(plan_id, version) VALUES ($1,1) RETURNING id', [p.id])).rows[0];
      await writeDraft(c, user, v.id, i);
      return p.id;
    });
    await audit(null, user.id, 'write_clinical', 'treatment_plans', planId);
    return render(planId, user.id);
  },
});

cap({
  name: 'update_plan_draft', credential: true, method: 'PATCH', path: '/treatment-plans/:id/draft', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: replace the content of the plan\'s working draft. Send `base_version` (the draft version you loaded); if a newer one exists the save is refused so a stale edit cannot overwrite it. Published versions are never changed: use revise_treatment_plan to start a new draft.',
  input: z.object({ id, base_version: z.number().int().min(1), ...content }),
  async handler({ user }, i) {
    const plan = await mustPlan(i.id, user);
    const cred = await providerPre(user, plan.patient_id, 'update_plan_draft');
    await tx(async (c) => {
      await gateWrite(c, user, plan.patient_id, cred);
      const v = (await c.query("SELECT * FROM treatment_plan_versions WHERE plan_id=$1 AND status='draft' FOR UPDATE", [plan.id])).rows[0];
      if (!v) throw conflict('There is no draft to edit; revise the plan first');
      if (v.version !== i.base_version) throw conflict('The draft changed since you loaded it; reload and try again');
      await writeDraft(c, user, v.id, i);
      await c.query('UPDATE treatment_plans SET updated_at=now() WHERE id=$1', [plan.id]);
    });
    await audit(null, user.id, 'write_clinical', 'treatment_plans', plan.id);
    return render(plan.id, user.id);
  },
});

async function mustPlan(planId, user) {
  const plan = await one('SELECT * FROM treatment_plans WHERE id=$1', [planId]);
  if (!plan || plan.provider_id !== user.id) throw notFound('Treatment plan');
  return plan;
}

cap({
  name: 'revise_treatment_plan', credential: true, method: 'POST', path: '/treatment-plans/:id/revise', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Physio/doctor: start a new draft from the latest published version so you can amend the prescription. The published version stays in force until you publish the new one.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const plan = await mustPlan(i.id, user);
    const cred = await providerPre(user, plan.patient_id, 'revise_treatment_plan');
    await tx(async (c) => {
      await gateWrite(c, user, plan.patient_id, cred);
      if ((await c.query("SELECT 1 FROM treatment_plan_versions WHERE plan_id=$1 AND status='draft'", [plan.id])).rows[0]) throw conflict('There is already a draft');
      const cur = (await c.query("SELECT * FROM treatment_plan_versions WHERE plan_id=$1 AND status='published'", [plan.id])).rows[0];
      if (!cur) throw conflict('Nothing is published yet');
      const nv = (await c.query('INSERT INTO treatment_plan_versions(plan_id, version, goals_enc, patient_instructions_enc, private_notes_enc, review_date) SELECT plan_id, (SELECT max(version)+1 FROM treatment_plan_versions WHERE plan_id=$1), goals_enc, patient_instructions_enc, private_notes_enc, review_date FROM treatment_plan_versions WHERE id=$2 RETURNING id', [plan.id, cur.id])).rows[0];
      await c.query('INSERT INTO treatment_plan_items(plan_version_id, position, phase, exercise_version_id, side, sets, reps, hold_sec, rest_sec, times_per_week, load_value, load_unit, tempo, notes_enc, stop_instructions_enc) SELECT $1, position, phase, exercise_version_id, side, sets, reps, hold_sec, rest_sec, times_per_week, load_value, load_unit, tempo, notes_enc, stop_instructions_enc FROM treatment_plan_items WHERE plan_version_id=$2', [nv.id, cur.id]);
    });
    await audit(null, user.id, 'write_clinical', 'treatment_plans', plan.id);
    return render(plan.id, user.id);
  },
});

cap({
  name: 'publish_plan_version', credential: true, method: 'POST', path: '/treatment-plans/:id/publish', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: publish the draft to the patient. It becomes immutable and the previous published version is superseded (completed sessions keep the version they followed). Set `material_change` when the patient must acknowledge the change. The patient is notified with a generic message.',
  input: z.object({ id, base_version: z.number().int().min(1), material_change: z.boolean().default(true) }),
  async handler({ user }, i) {
    const plan = await mustPlan(i.id, user);
    const cred = await providerPre(user, plan.patient_id, 'publish_plan_version');
    await tx(async (c) => {
      await gateWrite(c, user, plan.patient_id, cred);
      const v = (await c.query("SELECT * FROM treatment_plan_versions WHERE plan_id=$1 AND status='draft' FOR UPDATE", [plan.id])).rows[0];
      if (!v) throw conflict('There is no draft to publish');
      if (v.version !== i.base_version) throw conflict('The draft changed since you loaded it; reload and try again');
      if (!(await c.query('SELECT 1 FROM treatment_plan_items WHERE plan_version_id=$1 LIMIT 1', [v.id])).rows[0]) throw badRequest('Add at least one exercise before publishing');
      await c.query("UPDATE treatment_plan_versions SET status='superseded' WHERE plan_id=$1 AND status='published'", [plan.id]);
      await c.query("UPDATE treatment_plan_versions SET status='published', published_at=now(), published_by=$2, material_change=$3 WHERE id=$1", [v.id, user.id, i.material_change]);
      await c.query("UPDATE treatment_plans SET status=CASE WHEN status IN ('draft','paused') THEN 'active' ELSE status END, updated_at=now() WHERE id=$1", [plan.id]);
      await notify(c, plan.patient_id, { kind: 'treatment_plan', title: 'Your exercise plan was updated', body: 'Open Health to review it.', data: { plan_id: plan.id } });
    });
    await audit(null, user.id, 'write_clinical', 'treatment_plans', plan.id);
    return render(plan.id, user.id);
  },
});

cap({
  name: 'set_treatment_plan_status', credential: true, method: 'POST', path: '/treatment-plans/:id/status', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: pause, resume (active), complete or discharge a plan. Discharged and completed plans are final.',
  input: z.object({ id, status: z.enum(['active', 'paused', 'completed', 'discharged']) }),
  async handler({ user }, i) {
    const plan = await mustPlan(i.id, user);
    const cred = await providerPre(user, plan.patient_id, 'set_treatment_plan_status');
    await tx(async (c) => {
      await gateWrite(c, user, plan.patient_id, cred);
      const cur = (await c.query('SELECT status FROM treatment_plans WHERE id=$1 FOR UPDATE', [plan.id])).rows[0].status;
      if (['completed', 'discharged'].includes(cur)) throw conflict(`This plan is already ${cur}`);
      if (cur === 'draft') throw conflict('Publish the plan first');
      await c.query('UPDATE treatment_plans SET status=$2, updated_at=now() WHERE id=$1', [plan.id, i.status]);
    });
    return render(plan.id, user.id);
  },
});

cap({
  name: 'acknowledge_plan_version', method: 'POST', path: '/treatment-plans/:id/acknowledge', tag: TAG,
  summary: 'Patient: confirm you have read the current published plan version.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one("UPDATE treatment_plan_versions v SET acknowledged_at=COALESCE(acknowledged_at, now()) FROM treatment_plans p WHERE p.id=v.plan_id AND p.id=$1 AND p.patient_id=$2 AND v.status='published' RETURNING v.id, v.version, v.acknowledged_at", [i.id, user.id]);
    if (!r) throw notFound('Published plan');
    return r;
  },
});

cap({
  name: 'get_treatment_plan', credential: true, method: 'GET', path: '/treatment-plans/:id', tag: TAG,
  summary: 'The plan with its versions. The patient sees published versions and patient-facing text only (and keeps access after consent changes). The prescribing provider also sees the draft and private notes, and needs a current credential and consent. Reads are audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const plan = await one('SELECT * FROM treatment_plans WHERE id=$1', [i.id]);
    if (!plan) throw notFound('Treatment plan');
    if (plan.patient_id !== user.id) {
      if (plan.provider_id !== user.id) throw notFound('Treatment plan');
      await providerPre(user, plan.patient_id, 'get_treatment_plan');
    } else if ((await one("SELECT 1 FROM treatment_plan_versions WHERE plan_id=$1 AND status IN ('published','superseded')", [plan.id])) == null) throw notFound('Treatment plan');
    await audit(null, user.id, 'read_clinical', 'treatment_plans', plan.id);
    return render(plan.id, user.id);
  },
});

cap({
  name: 'list_treatment_plans', credential: true, method: 'GET', path: '/treatment-plans', tag: TAG,
  summary: 'Your treatment plans: as a patient the ones published to you; as a provider the ones you prescribed for patients whose consent is still active (pass `patient_id` to filter). Titles and status only; open one for the content.',
  input: z.object({ patient_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const asPatient = await many("SELECT p.id, p.title, p.status, p.provider_id, u.display_name AS provider_name, p.updated_at, 'patient' AS as FROM treatment_plans p JOIN users u ON u.id=p.provider_id WHERE p.patient_id=$1 AND p.status<>'draft' AND EXISTS (SELECT 1 FROM treatment_plan_versions v WHERE v.plan_id=p.id AND v.status IN ('published','superseded')) ORDER BY p.updated_at DESC, p.id LIMIT $2 OFFSET $3", [user.id, i.limit, i.offset]);
    if (!user.roles.some((r) => ['physio', 'doctor'].includes(r))) return asPatient;
    await requireVerifiedProvider(user.id, { action: 'list_treatment_plans', athleteId: i.patient_id ?? null });
    const asProvider = await many(
      `SELECT p.id, p.title, p.status, p.patient_id, u.display_name AS patient_name, p.updated_at, 'provider' AS as FROM treatment_plans p JOIN users u ON u.id=p.patient_id
        WHERE p.provider_id=$1 AND ($2::uuid IS NULL OR p.patient_id=$2) AND EXISTS (SELECT 1 FROM medical_grants g WHERE g.athlete_id=p.patient_id AND g.provider_id=$1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND g.scope='full')
        ORDER BY p.updated_at DESC, p.id LIMIT $3 OFFSET $4`, [user.id, i.patient_id ?? null, i.limit, i.offset]);
    return [...asPatient, ...asProvider];
  },
});
