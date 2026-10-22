import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hasOrgGrant } from '../org-access.js';
import { block, openSession, ownRecord, savePlan, requireTeam } from './coaching-journal.js';

// Session and block templates (issue #269). They live in the existing coach_templates table. A template holds blocks only: anything
// aimed at particular people (block scope, unit, coach-only notes) is stripped on save, so a template can never carry player data.
// Applying a template copies its blocks into a new plan version, so editing a template later never rewrites a session that used it.
const TAG = 'Coach';
const COACH = ['coach'];
const text = (n) => z.string().trim().max(n);

/** Remove everything that points at a person or is for the coach's eyes only. */
const scrub = (b) => ({ id: undefined, kind: b.kind, title: b.title, objective: b.objective, duration_min: b.duration_min, instructions: b.instructions, setup: b.setup, cues: b.cues ?? [], success_criteria: b.success_criteria, target_rpe: b.target_rpe, tags: b.tags ?? [] });
const clean = (blocks) => blocks.map(scrub).map((b) => JSON.parse(JSON.stringify(b)));

/** A template the coach may read: their own, or one shared with a team they coach or an organisation where they hold a coaching grant. */
async function readable(user, templateId) {
  const t = await one('SELECT * FROM coach_templates WHERE id=$1 AND archived_at IS NULL', [templateId]);
  if (!t) throw notFound('Template');
  if (t.coach_id === user.id) return t;
  if (t.shared_team_id && (await one("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active' AND role='coach'", [t.shared_team_id, user.id]))) return t;
  if (t.shared_organisation_id && (await hasOrgGrant(user, t.shared_organisation_id, ['owner', 'admin', 'coach']))) return t;
  throw notFound('Template');
}

cap({
  name: 'save_coaching_template', method: 'POST', path: '/coaching/templates', tag: TAG, auth: COACH, status: 201,
  summary: 'Save a whole session plan, or one block of it, as a private template. Only the generic parts are kept - no athletes, groups or coach-only notes. Send session_record_id (and block_id for a single block), or the blocks directly.',
  input: z.object({ title: text(120).min(2), scope: z.enum(['block', 'session']).default('session'), session_record_id: id.optional(), block_id: z.string().max(60).optional(), blocks: z.array(block).max(30).optional(), sport: z.string().optional() }),
  async handler({ user }, i) {
    let blocks = i.blocks, sportId = null;
    if (i.session_record_id) {
      const rec = await ownRecord(user, i.session_record_id);
      sportId = rec.sport_id;
      const plan = await one('SELECT blocks FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version]);
      blocks = plan?.blocks ?? [];
      if (i.scope === 'block') {
        blocks = blocks.filter((b) => b.id === i.block_id);
        if (!blocks.length) throw notFound('Block');
      }
    }
    if (!blocks?.length) throw badRequest('There are no blocks to save');
    if (i.scope === 'block' && blocks.length !== 1) throw badRequest('A block template holds exactly one block');
    return one('INSERT INTO coach_templates(coach_id, sport_id, title, scope, blocks) VALUES ($1,$2,$3,$4,$5) RETURNING id, title, scope, blocks, version, created_at', [user.id, sportId, i.title, i.scope, JSON.stringify(clean(blocks))]);
  },
});

cap({
  name: 'update_coaching_template', method: 'PATCH', path: '/coaching/templates/:id', tag: TAG, auth: COACH,
  summary: 'Edit your own template (title or blocks). Its version goes up; sessions that already used it keep the blocks they were given. Needs the version you loaded.',
  input: z.object({ id, version: z.number().int().min(1), title: text(120).min(2).optional(), blocks: z.array(block).min(1).max(30).optional() }),
  async handler({ user }, i) {
    const t = await one('SELECT * FROM coach_templates WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL', [i.id, user.id]);
    if (!t) throw notFound('Template');
    const r = await one(
      'UPDATE coach_templates SET title=coalesce($3,title), blocks=coalesce($4,blocks), version=version+1, updated_at=now() WHERE id=$1 AND version=$2 RETURNING id, title, scope, blocks, version, updated_at',
      [t.id, i.version, i.title ?? null, i.blocks ? JSON.stringify(clean(i.blocks)) : null]);
    if (!r) throw conflict('This template was changed elsewhere - reload it first');
    return r;
  },
});

cap({
  name: 'share_coaching_template', method: 'POST', path: '/coaching/templates/:id/share', tag: TAG, auth: COACH,
  summary: 'Share your template with a team you coach, or with an organisation where you are an owner, admin or coach - or stop sharing. Other coaches can then apply it but never change it.',
  input: z.object({ id, with: z.enum(['private', 'team', 'organisation']), team_id: id.optional(), organisation_id: id.optional() }),
  async handler({ user }, i) {
    const t = await one('SELECT * FROM coach_templates WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL', [i.id, user.id]);
    if (!t) throw notFound('Template');
    let team = null, org = null;
    if (i.with === 'team') {
      if (!i.team_id) throw badRequest('team_id is required');
      await requireTeam(user, i.team_id); team = i.team_id;
    } else if (i.with === 'organisation') {
      if (!i.organisation_id) throw badRequest('organisation_id is required');
      if (!(await hasOrgGrant(user, i.organisation_id, ['owner', 'admin', 'coach']))) throw forbidden('You do not hold a coaching role in this organisation');
      org = i.organisation_id;
    }
    return one('UPDATE coach_templates SET shared_team_id=$2, shared_organisation_id=$3, updated_at=now() WHERE id=$1 RETURNING id, shared_team_id, shared_organisation_id', [t.id, team, org]);
  },
});

cap({
  name: 'apply_coaching_template', method: 'POST', path: '/coaching/sessions/:id/apply-template', tag: TAG, auth: COACH,
  summary: 'Copy a template\'s blocks into a session as a new plan version (append them, or replace the plan). The template is remembered on that version for reference; later edits to the template do not change the session.',
  input: z.object({ id, template_id: id, mode: z.enum(['append', 'replace']).default('append') }),
  async handler({ user }, i) {
    const t = await readable(user, i.template_id);
    if (t.scope === 'drill' || !t.blocks?.length) throw badRequest('That template has no session blocks');
    const rec = await ownRecord(user, i.id);
    const cur = await one('SELECT blocks FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [rec.id, rec.plan_version]);
    const blocks = i.mode === 'replace' || !cur ? t.blocks : [...cur.blocks, ...t.blocks];
    return savePlan(user, rec.id, blocks, { template: { id: t.id, version: t.version } });
  },
});

cap({
  name: 'clone_coaching_session', method: 'POST', path: '/coaching/sessions/:id/clone', tag: TAG, auth: COACH, status: 201,
  summary: 'Start a new session from a past one: the objective and generic plan blocks are copied; attendance, notes, summaries, actions and any player-specific aiming are not. Name the canonical source of the new session (a plan session, hire, fixture, or a new team session).',
  input: z.object({
    id, source_type: z.enum(['training_session', 'coach_hire', 'fixture', 'team_session']), source_id: z.string().max(80), team_id: id.optional(), title: text(120).min(2).optional(), scheduled_at: z.string().datetime({ offset: true }).optional(),
  }),
  async handler({ user }, i) {
    const from = await ownRecord(user, i.id);
    const created = await openSession(user, { source_type: i.source_type, source_id: i.source_id, team_id: i.team_id, title: i.title ?? from.title, objective: from.objective ?? undefined, scheduled_at: i.scheduled_at });
    if (created.id === from.id) throw badRequest('Choose a different source for the new session');
    const plan = await one('SELECT blocks FROM coaching_session_plan_versions WHERE session_record_id=$1 AND version=$2', [from.id, from.plan_version]);
    if (plan?.blocks.length && created.plan_version === 0) await savePlan(user, created.id, clean(plan.blocks));
    return one('SELECT * FROM coaching_session_records WHERE id=$1', [created.id]);
  },
});
