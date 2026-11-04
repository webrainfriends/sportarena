// Academy OS 3/3 close-out: carry a human progression decision through to the canonical workflow that owns the result. This file performs no
// certificate, team or enrolment logic itself: it calls issue_credential, invite_team_member and transfer_academy_enrolment AS THE ACTING USER, so
// their own permission, consent and capacity checks apply. It never runs on its own: a person chooses the action for a decision they can see.
import { z } from 'zod';
import { cap, capabilities, id } from '../registry.js';
import { invoke } from '../invoke.js';
import { tx, many } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor } from '../org-access.js';
import { STAFF } from '../academy.js';

const canonical = (name) => { const c = capabilities.find((x) => x.name === name); if (!c) throw new Error(`capability ${name} is not registered`); return c; };
/** Which decision each action may follow. A certificate follows a graduation, a squad invitation an invitation decision, a cohort move a programme move. */
const FOR = { issue_certificate: 'graduate', invite_squad: 'invite_squad', move_cohort: 'move_programme' };

cap({
  name: 'follow_through_academy_decision', method: 'POST', path: '/academy/decisions/:id/follow-through', tag: 'Academy', status: 201,
  summary: 'Carry a recorded progression decision through (owner/admin): issue the certificate for a graduation (canonical credentials), invite the athlete to a squad for an invite_squad decision (canonical team invitation, which asks for the athlete / guardian consent), or move the athlete to another cohort for a move_programme decision (canonical enrolment transfer). Each action runs once per decision; repeating it returns the first result. Nothing happens unless a person calls this.',
  input: z.object({
    id, action: z.enum(['issue_certificate', 'invite_squad', 'move_cohort']),
    enrolment_id: id.optional().describe('issue_certificate / move_cohort: the athlete\'s academy enrolment'),
    kind: z.enum(['certificate', 'badge', 'diploma']).default('certificate').describe('issue_certificate'), title: z.string().trim().min(2).max(120).optional().describe('issue_certificate'),
    team_id: id.optional().describe('invite_squad'), role: z.enum(['player', 'captain']).default('player').describe('invite_squad'), message: z.string().max(300).optional().describe('invite_squad'),
    to_cohort_id: id.optional().describe('move_cohort'), reason: z.string().max(300).optional().describe('move_cohort'),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const d = (await c.query('SELECT * FROM academy_progression_decisions WHERE id=$1', [i.id])).rows[0];
    if (!d) throw notFound('Decision');
    await orgFor(user, d.organisation_id, STAFF, { write: true, c });
    if (d.decision !== FOR[i.action]) throw conflict(`"${i.action}" follows a "${FOR[i.action]}" decision, not "${d.decision}"`);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`follow:${d.id}:${i.action}`]);
    const prior = (await c.query('SELECT * FROM academy_decision_follow_ups WHERE decision_id=$1 AND kind=$2', [d.id, i.action])).rows[0];
    if (prior) return { ...prior, replayed: true };
    if ((i.action === 'issue_certificate' || i.action === 'move_cohort') && i.enrolment_id) {
      const e = (await c.query('SELECT e.user_id, k.organisation_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1', [i.enrolment_id])).rows[0];
      if (!e || e.organisation_id !== d.organisation_id || e.user_id !== d.athlete_id) throw badRequest('That enrolment is not this athlete\'s enrolment in this academy');
    }
    let out, target;
    if (i.action === 'issue_certificate') {
      if (!i.enrolment_id) throw badRequest('Choose the completed or graduated enrolment the certificate is for');
      const pathway = (await c.query('SELECT title FROM academy_pathways WHERE id=$1', [d.pathway_id])).rows[0];
      out = await invoke(canonical('issue_credential'), user, { id: d.organisation_id, enrolment_id: i.enrolment_id, kind: i.kind, title: i.title ?? `${pathway?.title ?? 'Academy pathway'} - graduate` });
      target = { type: 'credential', id: out.id };
    } else if (i.action === 'invite_squad') {
      if (!i.team_id) throw badRequest('Choose the team or squad');
      out = await invoke(canonical('invite_team_member'), user, { id: i.team_id, user_id: d.athlete_id, role: i.role, message: i.message });
      target = { type: 'team_invitation', id: i.team_id };
    } else {
      if (!i.enrolment_id || !i.to_cohort_id) throw badRequest('Choose the enrolment and the cohort to move to');
      out = await invoke(canonical('transfer_academy_enrolment'), user, { id: i.enrolment_id, to_cohort_id: i.to_cohort_id, reason: i.reason });
      target = { type: 'academy_enrolment', id: out.id ?? i.enrolment_id };
    }
    const row = (await c.query('INSERT INTO academy_decision_follow_ups(decision_id, kind, target_type, target_id, detail, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [d.id, i.action, target.type, String(target.id), JSON.stringify({ athlete_id: d.athlete_id }), user.id])).rows[0];
    await audit(c, user.id, `academy_follow_through_${i.action}`, 'academy_progression_decisions', d.id);
    return row;
  }),
});

cap({
  name: 'list_academy_decision_follow_ups', method: 'GET', path: '/academy/decisions/:id/follow-ups', tag: 'Academy',
  summary: 'What a progression decision has already caused (owner/admin; a coach for their own athletes): the certificate, squad invitation or cohort move, each with the record it points at.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const d = (await many('SELECT organisation_id FROM academy_progression_decisions WHERE id=$1', [i.id]))[0];
    if (!d) throw notFound('Decision');
    await orgFor(user, d.organisation_id, [...STAFF, 'coach']);
    return many('SELECT kind, target_type, target_id, created_at FROM academy_decision_follow_ups WHERE decision_id=$1 ORDER BY created_at, id', [i.id]);
  },
});
