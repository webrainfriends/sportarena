// Doctor workspace (issue #212, slice 2d): versioned care plans.
// A doctor drafts a plan (goals, baseline, patient-visible instructions, actions with a responsible person, due date and completion criteria),
// publishes it (immutable version; a later revision supersedes it and the old version stays), and can pause/complete it. The athlete records
// done / unable / symptom entries in a separate append-only log - they never change the instructions. "Done" is the patient's report of a task,
// not medically confirmed resolution; only a doctor's `confirm_action` says that. Overdue only means a date passed - there is no adherence score
// and nothing is adjusted automatically. Same gates as records: verified doctor + the athlete's full consent, re-checked in the writing transaction.
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { notify } from '../notify.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';

const t = (n) => z.string().trim().max(n);
const day = z.string().date();
const action = z.object({ key: z.string().uuid().optional().describe('keep the key of an existing action when revising so its history carries over'), title: t(300).min(1), responsible: z.enum(['patient', 'doctor', 'other']).default('patient'),
  due_date: day.optional(), completion_criteria: t(500).optional() }); // derived fields (state, overdue) echoed back by clients are dropped, never stored
const body = z.object({ goals: z.array(z.object({ text: t(500).min(1), baseline: t(500).optional() }).strict()).max(20).default([]), instructions: t(4000).optional().describe('patient-visible, plain language'),
  review_interval_days: z.number().int().min(1).max(365).optional(), actions: z.array(action).max(50).default([]) }).strict();
const seal = (o, f) => encrypt(JSON.stringify(o), `clinical_care_plans.${f}`);
const open = (e, f) => JSON.parse(decrypt(e, `clinical_care_plans.${f}`));
const withKeys = (b) => ({ ...b, actions: b.actions.map((a) => ({ ...a, key: a.key ?? randomUUID() })) });
const lockGrant = async (c, athleteId, providerId) => {
  if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [athleteId, providerId])).rows[0]) throw forbidden('The athlete has not granted you access');
};
/** The owning doctor, verified and consented now. Returns { plan, cred }. */
async function ownerGate(user, planId, action) {
  const plan = await one('SELECT * FROM clinical_care_plans WHERE id=$1', [planId]);
  if (!plan || plan.provider_id !== user.id) throw notFound('Care plan');
  const cred = await requireVerifiedProvider(user.id, { action, athleteId: plan.athlete_id, types: ['doctor'] });
  if (!(await hasGrant(plan.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
  return { plan, cred };
}
const guarded = async (c, cred, plan, user) => { await lockCredential(c, cred); await lockGrant(c, plan.athlete_id, user.id); return (await c.query('SELECT * FROM clinical_care_plans WHERE id=$1 FOR UPDATE', [plan.id])).rows[0]; };
const log = (c, planId, versionNo, key, kind, actor, note) => c.query('INSERT INTO clinical_care_plan_entries(plan_id, version_no, action_key, kind, actor_id, note_enc) VALUES ($1,$2,$3,$4,$5,$6)', [planId, versionNo, key, kind, actor, note ? seal({ note }, 'note') : null]);

const STATE = { completed: 'done_reported', unable: 'unable', clinician_confirmed: 'confirmed', clinician_cancelled: 'cancelled' };
/** Derive each action's state from the log: latest entry wins; none = open. `overdue` only means the date passed. */
function withState(b, entries) {
  const today = new Date().toISOString().slice(0, 10);
  return { ...b, actions: b.actions.map((a) => {
    const last = [...entries].reverse().find((e) => e.action_key === a.key);
    const state = last ? STATE[last.kind] : 'open';
    return { ...a, state, overdue: state === 'open' && !!a.due_date && a.due_date < today, ...(state === 'done_reported' ? { note: 'Reported by the patient; not a clinical confirmation' } : {}) };
  }) };
}
const entryOut = (e) => ({ id: e.id, version_no: e.version_no, action_key: e.action_key, kind: e.kind, actor_id: e.actor_id, note: e.note_enc ? open(e.note_enc, 'note').note : null, created_at: e.created_at });

cap({
  name: 'create_care_plan', credential: true, method: 'POST', path: '/medical/care-plans', tag: 'Health', auth: ['doctor'], status: 201,
  summary: 'Doctor drafts a care plan (version 1) for an athlete who granted full access: goals with baseline, patient-visible instructions, and actions each with a responsible person, due date and completion criteria. The patient sees nothing until you publish.',
  input: z.object({ athlete_id: id, title: t(200).min(1), body: body.default({ goals: [], actions: [] }) }),
  async handler({ user }, i) {
    if (i.athlete_id === user.id) throw badRequest('You cannot create a plan for yourself');
    const cred = await requireVerifiedProvider(user.id, { action: 'create_care_plan', athleteId: i.athlete_id, types: ['doctor'] });
    if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    const r = await tx(async (c) => {
      await lockCredential(c, cred); await lockGrant(c, i.athlete_id, user.id);
      const p = (await c.query('INSERT INTO clinical_care_plans(athlete_id, provider_id, title_enc) VALUES ($1,$2,$3) RETURNING id, athlete_id, status, created_at', [i.athlete_id, user.id, seal({ v: i.title }, 'title')])).rows[0];
      const v = (await c.query('INSERT INTO clinical_care_plan_versions(plan_id, version_no, body_enc) VALUES ($1,1,$2) RETURNING version_no, row_version, status', [p.id, seal(withKeys(i.body), 'body')])).rows[0];
      return { ...p, draft: v };
    });
    await audit(null, user.id, 'write_clinical', 'clinical_care_plans', r.id);
    return r;
  },
});

cap({
  name: 'update_care_plan_draft', credential: true, method: 'PATCH', path: '/medical/care-plans/:id/draft', tag: 'Health', auth: ['doctor'],
  summary: 'Edit the plan\'s draft version (the first draft, or a revision). Send the `row_version` you loaded; a stale one is refused (409). Published versions are never edited - use revise_care_plan.',
  input: z.object({ id, row_version: z.number().int().min(1), body }),
  async handler({ user }, i) {
    const { plan, cred } = await ownerGate(user, i.id, 'update_care_plan_draft');
    const r = await tx(async (c) => {
      await guarded(c, cred, plan, user);
      const d = (await c.query("SELECT id, row_version FROM clinical_care_plan_versions WHERE plan_id=$1 AND status='draft' FOR UPDATE", [i.id])).rows[0];
      if (!d) throw conflict('There is no draft to edit; start a revision');
      if (d.row_version !== i.row_version) throw conflict('This draft was changed since you loaded it; reload and try again');
      return (await c.query('UPDATE clinical_care_plan_versions SET body_enc=$2, row_version=row_version+1 WHERE id=$1 RETURNING version_no, row_version, status', [d.id, seal(withKeys(i.body), 'body')])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_care_plans', i.id);
    return r;
  },
});

cap({
  name: 'publish_care_plan', credential: true, method: 'POST', path: '/medical/care-plans/:id/publish', tag: 'Health', auth: ['doctor'],
  summary: 'Approve and publish the draft: it becomes an immutable version visible to the athlete (who is notified generically), makes the plan active, and supersedes the previously published version, which stays in history. Needs at least one goal or action. Records your credential case.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    const { plan, cred } = await ownerGate(user, i.id, 'publish_care_plan');
    const r = await tx(async (c) => {
      const cur = await guarded(c, cred, plan, user);
      if (cur.status === 'completed') throw conflict('This plan is completed');
      const d = (await c.query("SELECT * FROM clinical_care_plan_versions WHERE plan_id=$1 AND status='draft' FOR UPDATE", [i.id])).rows[0];
      if (!d) throw conflict('There is no draft to publish');
      if (d.row_version !== i.row_version) throw conflict('This draft was changed since you loaded it; reload, review and publish again');
      const b = open(d.body_enc, 'body');
      if (!b.goals.length && !b.actions.length) throw badRequest('Add at least one goal or action before publishing');
      await c.query("UPDATE clinical_care_plan_versions SET status='superseded', superseded_at=now() WHERE plan_id=$1 AND status='published'", [i.id]);
      const v = (await c.query("UPDATE clinical_care_plan_versions SET status='published', published_at=now(), published_by=$2, credential_case_id=$3 WHERE id=$1 RETURNING version_no, published_at", [d.id, user.id, cred.case_id])).rows[0];
      await c.query("UPDATE clinical_care_plans SET status=CASE WHEN status='draft' THEN 'active' ELSE status END, updated_at=now() WHERE id=$1", [i.id]);
      await notify(c, cur.athlete_id, { kind: 'care_plan', title: v.version_no > 1 ? 'Your care plan was updated' : 'You have a care plan', body: 'Open Health to read it.', data: { care_plan_id: i.id } });
      return { id: i.id, ...v, status: (await c.query('SELECT status FROM clinical_care_plans WHERE id=$1', [i.id])).rows[0].status };
    });
    await audit(null, user.id, 'write_clinical', 'clinical_care_plans', i.id);
    return r;
  },
});

cap({
  name: 'revise_care_plan', credential: true, method: 'POST', path: '/medical/care-plans/:id/revise', tag: 'Health', auth: ['doctor'], status: 201,
  summary: 'Start a revision: a new draft copied from the published version (action keys kept so completed history carries over). Only one draft at a time. The patient keeps seeing the published version until you publish the revision.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { plan, cred } = await ownerGate(user, i.id, 'revise_care_plan');
    const r = await tx(async (c) => {
      await guarded(c, cred, plan, user);
      if ((await c.query("SELECT 1 FROM clinical_care_plan_versions WHERE plan_id=$1 AND status='draft'", [i.id])).rows[0]) throw conflict('There is already a draft revision');
      const p = (await c.query("SELECT version_no, body_enc FROM clinical_care_plan_versions WHERE plan_id=$1 AND status='published'", [i.id])).rows[0];
      if (!p) throw conflict('Nothing is published yet; edit the draft');
      const n = (await c.query('SELECT max(version_no) AS n FROM clinical_care_plan_versions WHERE plan_id=$1', [i.id])).rows[0].n;
      return (await c.query('INSERT INTO clinical_care_plan_versions(plan_id, version_no, body_enc) VALUES ($1,$2,$3) RETURNING version_no, row_version, status', [i.id, n + 1, p.body_enc])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_care_plans', i.id);
    return r;
  },
});

cap({
  name: 'set_care_plan_state', credential: true, method: 'POST', path: '/medical/care-plans/:id/state', tag: 'Health', auth: ['doctor'],
  summary: 'Pause, resume or complete a published plan. Completing the plan is the doctor\'s decision; it is not inferred from tasks being done. History is kept.',
  input: z.object({ id, state: z.enum(['paused', 'active', 'completed']) }),
  async handler({ user }, i) {
    const { plan, cred } = await ownerGate(user, i.id, 'set_care_plan_state');
    const r = await tx(async (c) => {
      const cur = await guarded(c, cred, plan, user);
      if (cur.status === 'draft') throw conflict('Publish the plan first');
      if (cur.status === 'completed') throw conflict('This plan is completed');
      return (await c.query('UPDATE clinical_care_plans SET status=$2, updated_at=now() WHERE id=$1 RETURNING id, status', [i.id, i.state])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_care_plans', i.id);
    return r;
  },
});

cap({
  name: 'log_care_plan_entry', credential: true, method: 'POST', path: '/medical/care-plans/:id/entries', tag: 'Health',
  summary: 'Athlete: record that you did an action (`completed`), could not (`unable`), or noticed a symptom (`symptom`, no action). This never changes the plan. A symptom note is not monitored in real time - for anything urgent contact your doctor or emergency services. Doctor (owner): `clinician_confirmed` or `clinician_cancelled` for an action.',
  input: z.object({ id, kind: z.enum(['completed', 'unable', 'symptom', 'clinician_confirmed', 'clinician_cancelled']), action_key: z.string().uuid().optional(), note: t(1000).optional() }),
  async handler({ user }, i) {
    const plan = await one('SELECT * FROM clinical_care_plans WHERE id=$1', [i.id]);
    if (!plan) throw notFound('Care plan');
    const mine = plan.athlete_id === user.id, owner = plan.provider_id === user.id;
    if (!mine && !owner) throw notFound('Care plan');
    const clinician = i.kind.startsWith('clinician_');
    if (clinician ? !owner : !mine) throw forbidden(clinician ? 'Only the plan\'s doctor can do this' : 'Only the patient records their own progress');
    if (i.kind === 'symptom' ? !!i.action_key : !i.action_key) throw badRequest(i.kind === 'symptom' ? 'A symptom is not tied to an action' : 'Say which action (action_key)');
    const cred = owner ? await requireVerifiedProvider(user.id, { action: 'log_care_plan_entry', athleteId: plan.athlete_id, types: ['doctor'] }) : null;
    if (owner && !(await hasGrant(plan.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    const r = await tx(async (c) => {
      const cur = cred ? await guarded(c, cred, plan, user) : (await c.query('SELECT * FROM clinical_care_plans WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (cur.status !== 'active') throw conflict(cur.status === 'paused' ? 'This plan is paused' : 'This plan is not open for entries');
      const pub = (await c.query("SELECT version_no, body_enc FROM clinical_care_plan_versions WHERE plan_id=$1 AND status='published'", [i.id])).rows[0];
      if (!pub) throw conflict('Nothing is published');
      if (i.action_key && !open(pub.body_enc, 'body').actions.some((a) => a.key === i.action_key)) throw notFound('Action');
      await log(c, i.id, pub.version_no, i.action_key ?? null, i.kind, user.id, i.note);
      if (i.kind === 'symptom') await notify(c, plan.provider_id, { kind: 'care_plan_entry', title: 'A patient added a note to a care plan', body: 'Open Health to read it. This is not an emergency alert.', data: { care_plan_id: i.id } });
      return { ok: true, version_no: pub.version_no };
    });
    await audit(null, user.id, 'write_clinical', 'clinical_care_plan_entries', i.id);
    return r;
  },
});

cap({
  name: 'list_care_plans', credential: true, method: 'GET', path: '/medical/care-plans', tag: 'Health',
  summary: 'Athletes: your plans that have a published version. Doctors: pass athlete_id for plans you own (verified credential and full consent required). Newest first.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const doctor = !!i.athlete_id && i.athlete_id !== user.id;
    if (doctor) {
      await requireVerifiedProvider(user.id, { action: 'list_care_plans', athleteId: i.athlete_id, types: ['doctor'] });
      if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    }
    const sel = 'SELECT p.id, p.athlete_id, p.provider_id, p.title_enc, p.status, p.created_at, p.updated_at FROM clinical_care_plans p';
    const rows = doctor
      ? await many(`${sel} WHERE p.athlete_id=$3 AND p.provider_id=$4 ORDER BY p.created_at DESC, p.id LIMIT $1 OFFSET $2`, [i.limit, i.offset, i.athlete_id, user.id])
      : await many(`${sel} WHERE p.athlete_id=$3 AND p.status <> 'draft' ORDER BY p.created_at DESC, p.id LIMIT $1 OFFSET $2`, [i.limit, i.offset, user.id]);
    await audit(null, user.id, 'read_clinical', 'clinical_care_plans', doctor ? i.athlete_id : user.id);
    return rows.map(({ title_enc, ...p }) => ({ ...p, title: open(title_enc, 'title').v }));
  },
});

cap({
  name: 'get_care_plan', credential: true, method: 'GET', path: '/medical/care-plans/:id', tag: 'Health',
  summary: 'One plan. The athlete sees the published version with each action\'s state and their own entries; the owning doctor also sees the draft and every earlier version. Action states: open / done_reported (patient said so) / unable / confirmed (doctor) / cancelled; `overdue` only means the date passed. Audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const plan = await one('SELECT * FROM clinical_care_plans WHERE id=$1', [i.id]);
    if (!plan) throw notFound('Care plan');
    const mine = plan.athlete_id === user.id, owner = plan.provider_id === user.id;
    if (!mine && !owner) throw notFound('Care plan');
    if (owner) {
      await requireVerifiedProvider(user.id, { action: 'get_care_plan', athleteId: plan.athlete_id, types: ['doctor'] });
      if (!(await hasGrant(plan.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    } else if (plan.status === 'draft') throw notFound('Care plan');
    const vers = await many(`SELECT version_no, status, body_enc, row_version, published_at, superseded_at FROM clinical_care_plan_versions WHERE plan_id=$1 ${owner ? '' : "AND status='published'"} ORDER BY version_no`, [i.id]);
    const entries = await many('SELECT * FROM clinical_care_plan_entries WHERE plan_id=$1 ORDER BY created_at, id', [i.id]);
    const versions = vers.map(({ body_enc, ...v }) => ({ ...v, body: v.status === 'published' ? withState(open(body_enc, 'body'), entries) : open(body_enc, 'body') }));
    await audit(null, user.id, 'read_clinical', 'clinical_care_plans', plan.athlete_id);
    return { id: plan.id, athlete_id: plan.athlete_id, provider_id: plan.provider_id, title: open(plan.title_enc, 'title').v, status: plan.status, versions, entries: entries.map(entryOut) };
  },
});
