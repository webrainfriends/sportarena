// Return-to-Play (RTP) protocol for injury episodes (issue #584).
// Milestone stage gates + formal RTT/RTP approval records.
// RTP approval with type='return_to_play' and status='approved' auto-chains to issue a clinical_clearances record
// so the athlete's fit-to-play projection updates immediately via currentClearance().
// All clinical detail encrypted. Coach-visible load restrictions decrypted only on the coach endpoint (injury-coach-view.js).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';

const TAG = 'Sports Medicine';
const PROVIDER = ['physio', 'doctor'];
const t = (n) => z.string().trim().min(1).max(n);
const tOpt = (n) => z.string().trim().max(n).optional();
const day = z.string().date();

const MILESTONE_STATUSES = ['pending', 'in_progress', 'achieved', 'failed', 'skipped'];
const APPROVAL_TYPES = ['return_to_train', 'return_to_play'];
const APPROVAL_STATUSES = ['approved', 'conditional', 'deferred'];

/** Shared credential + consent gate. */
async function clinicianGate(user, athleteId, action) {
  if (athleteId === user.id) throw badRequest('You cannot manage your own RTP protocol');
  const cred = await requireVerifiedProvider(user.id, { action, athleteId, types: PROVIDER });
  if (!(await hasGrant(athleteId, user.id))) throw forbidden('The athlete has not granted you access');
  return cred;
}

async function lockGate(c, cred, athleteId, providerId) {
  await lockCredential(c, cred);
  if (!(await c.query(
    "SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE",
    [athleteId, providerId],
  )).rows[0]) throw forbidden('The athlete has not granted you access');
}

async function getEpisodeForClinician(episodeId, user) {
  const ep = await one('SELECT id, athlete_id, status FROM injury_episodes WHERE id=$1', [episodeId]);
  if (!ep) throw notFound('Injury episode');
  await clinicianGate(user, ep.athlete_id, 'rtp_protocol');
  return ep;
}

const shapeMilestone = (m, full) => ({
  id: m.id, stage_order: m.stage_order, stage_name: m.stage_name,
  criteria: full && m.criteria_enc ? decrypt(m.criteria_enc, 'injury_rtp_milestones.criteria') : undefined,
  target_date: m.target_date, status: m.status, achieved_on: m.achieved_on,
  evidence: full && m.evidence_enc ? decrypt(m.evidence_enc, 'injury_rtp_milestones.evidence') : undefined,
  linked_encounter_id: full ? m.linked_encounter_id : undefined,
  assessed_by: m.assessed_by,
  overdue: m.target_date && m.status === 'pending' && m.target_date < new Date().toISOString().slice(0, 10),
  created_at: m.created_at,
});

// ------------------------------------------------------------------ set milestones
cap({
  name: 'set_rtp_milestones', credential: true, method: 'PUT', path: '/injury-episodes/:id/rtp/milestones',
  tag: TAG, auth: PROVIDER,
  summary: 'Set or replace the Return-to-Play milestone stages for an injury episode. Each stage has a clinician-defined pass criteria (encrypted, never shown to coaches or non-treating staff), an optional target date, and a stage name the athlete can see. Existing pending/in-progress milestones are replaced; achieved and failed milestones are preserved for history. Up to 10 stages.',
  input: z.object({
    id,
    milestones: z.array(z.object({
      stage_order: z.number().int().min(1).max(10),
      stage_name: t(200),
      criteria: t(2000),
      target_date: day.optional(),
    }).strict()).min(1).max(10),
  }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    const cred = await clinicianGate(user, ep.athlete_id, 'set_rtp_milestones');
    await tx(async (c) => {
      await lockGate(c, cred, ep.athlete_id, user.id);
      // Remove replaceable milestones only (keep achieved/failed history)
      await c.query(
        "DELETE FROM injury_rtp_milestones WHERE episode_id=$1 AND status IN ('pending','in_progress','skipped')",
        [i.id],
      );
      for (const m of i.milestones) {
        await c.query(
          `INSERT INTO injury_rtp_milestones(episode_id, stage_order, stage_name, criteria_enc, target_date, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [i.id, m.stage_order, m.stage_name, encrypt(m.criteria, 'injury_rtp_milestones.criteria'), m.target_date ?? null, user.id],
        );
      }
      await c.query(
        `INSERT INTO injury_episode_events(episode_id, event_type, by_user_id) VALUES ($1,'note_added',$2)`,
        [i.id, user.id],
      );
    });
    await audit(null, user.id, 'write_clinical', 'injury_rtp_milestones', i.id);
    return { episode_id: i.id, milestones_set: i.milestones.length };
  },
});

// ------------------------------------------------------------------ update milestone status
cap({
  name: 'update_milestone_status', credential: true, method: 'PATCH', path: '/injury-episodes/:id/rtp/milestones/:milestoneId',
  tag: TAG, auth: PROVIDER,
  summary: 'Mark a Return-to-Play milestone as in_progress, achieved, failed, or skipped. Provide the assessment date, optional encrypted evidence (clinical observations, test results), and optionally link the assessment encounter. When all milestones are achieved the response includes a suggestion flag to issue the RTP approval.',
  input: z.object({
    id,
    milestoneId: id,
    status: z.enum(MILESTONE_STATUSES),
    achieved_on: day.optional(),
    evidence: tOpt(3000),
    linked_encounter_id: id.optional(),
  }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id, status FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    const m = await one('SELECT id, status FROM injury_rtp_milestones WHERE id=$1 AND episode_id=$2', [i.milestoneId, i.id]);
    if (!m) throw notFound('Milestone');
    if (m.status === 'achieved' && i.status !== 'achieved') throw conflict('An achieved milestone cannot be changed — record a new episode instead');
    const cred = await clinicianGate(user, ep.athlete_id, 'update_milestone_status');
    if (i.achieved_on && i.status !== 'achieved') throw badRequest('achieved_on is only relevant when status=achieved');
    await tx(async (c) => {
      await lockGate(c, cred, ep.athlete_id, user.id);
      if (i.linked_encounter_id && !(await c.query('SELECT 1 FROM clinical_encounters WHERE id=$1 AND athlete_id=$2', [i.linked_encounter_id, ep.athlete_id])).rows[0]) throw notFound('Encounter');
      await c.query(
        `UPDATE injury_rtp_milestones SET status=$1, achieved_on=$2, evidence_enc=$3, linked_encounter_id=$4, assessed_by=$5, updated_at=now() WHERE id=$6`,
        [i.status, i.achieved_on ?? null, i.evidence ? encrypt(i.evidence, 'injury_rtp_milestones.evidence') : null, i.linked_encounter_id ?? null, user.id, i.milestoneId],
      );
    });
    await audit(null, user.id, 'write_clinical', 'injury_rtp_milestones', i.milestoneId);
    // Check if all milestones achieved to suggest RTP approval
    const remaining = await one(
      "SELECT COUNT(*) AS n FROM injury_rtp_milestones WHERE episode_id=$1 AND status NOT IN ('achieved','skipped')",
      [i.id],
    );
    return { id: i.milestoneId, status: i.status, all_milestones_complete: Number(remaining.n) === 0 };
  },
});

// ------------------------------------------------------------------ issue RTP approval
cap({
  name: 'issue_rtp_approval', credential: true, method: 'POST', path: '/injury-episodes/:id/rtp/approvals',
  tag: TAG, auth: PROVIDER, status: 201,
  summary: 'Issue a formal Return-to-Train or Return-to-Play approval for an injury episode. Load restrictions are stored encrypted but are explicitly flagged as shareable with coaching staff (they are decrypted on the coach-view endpoint, never the internal assessment). A Return-to-Play approval with status=approved automatically issues a clinical clearance so the athlete\'s fit-to-play status updates at once. The athlete is notified immediately.',
  input: z.object({
    id,
    approval_type: z.enum(APPROVAL_TYPES),
    status: z.enum(APPROVAL_STATUSES),
    approved_on: day,
    valid_until: day.optional(),
    load_restrictions: z.array(z.object({ activity: z.string().trim().min(1).max(200), limit: z.string().trim().min(1).max(400) }).strict()).max(20).default([]),
    internal_assessment: t(5000),
    evidence_refs: tOpt(2000),
    conditions: tOpt(2000),
    sport_id: id.optional(),
  }),
  async handler({ user }, i) {
    if (i.status !== 'deferred' && !i.valid_until) throw badRequest('Provide valid_until so the approval does not silently go stale');
    if (i.valid_until && i.valid_until < i.approved_on) throw badRequest('valid_until cannot be before approved_on');
    if (i.status === 'conditional' && !i.conditions) throw badRequest('Provide conditions for a conditional approval');
    if (i.approved_on > new Date().toISOString().slice(0, 10)) throw badRequest('approved_on cannot be in the future');
    const ep = await one('SELECT id, athlete_id, status FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    if (ep.status === 'closed' || ep.status === 'cancelled') throw conflict('Episode is ' + ep.status);
    const cred = await clinicianGate(user, ep.athlete_id, 'issue_rtp_approval');
    const r = await tx(async (c) => {
      await lockGate(c, cred, ep.athlete_id, user.id);
      // Check no live approval of same type
      const live = (await c.query(
        'SELECT id FROM injury_rtp_approvals WHERE episode_id=$1 AND approval_type=$2 AND revoked_at IS NULL AND status<>$3',
        [i.id, i.approval_type, 'deferred'],
      )).rows[0];
      if (live) throw conflict('A live ' + i.approval_type + ' approval already exists. Revoke it first.');
      const row = (await c.query(
        `INSERT INTO injury_rtp_approvals(episode_id, approval_type, status, approved_on, valid_until, load_restrictions_enc, internal_assessment_enc, evidence_refs_enc, conditions_enc, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, approval_type, status, approved_on, valid_until, created_at`,
        [i.id, i.approval_type, i.status, i.approved_on, i.valid_until ?? null,
          i.load_restrictions.length ? encrypt(JSON.stringify(i.load_restrictions), 'injury_rtp_approvals.load_restrictions') : null,
          encrypt(i.internal_assessment, 'injury_rtp_approvals.internal_assessment'),
          i.evidence_refs ? encrypt(i.evidence_refs, 'injury_rtp_approvals.evidence_refs') : null,
          i.conditions ? encrypt(i.conditions, 'injury_rtp_approvals.conditions') : null,
          user.id],
      )).rows[0];
      await c.query(`INSERT INTO injury_episode_events(episode_id, event_type, by_user_id) VALUES ($1,'artifact_linked',$2)`, [i.id, user.id]);
      // Auto-chain: RTP approval → clinical clearance so team availability updates immediately
      let clearanceId = null;
      if (i.approval_type === 'return_to_play' && i.status === 'approved') {
        const prevClearance = (await c.query(
          'SELECT id FROM clinical_clearances WHERE athlete_id=$1 AND sport_id IS NOT DISTINCT FROM $2 AND superseded_at IS NULL AND withdrawn_at IS NULL FOR UPDATE',
          [ep.athlete_id, i.sport_id ?? null],
        )).rows[0];
        if (prevClearance) await c.query('UPDATE clinical_clearances SET superseded_at=now() WHERE id=$1', [prevClearance.id]);
        const cl = (await c.query(
          `INSERT INTO clinical_clearances(athlete_id, doctor_id, sport_id, activity, status, restrictions_enc, internal_note_enc, assessed_on, valid_until, review_by, supersedes_id, credential_case_id)
           VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,NULL,$9,$10)
           RETURNING id`,
          [ep.athlete_id, user.id, i.sport_id ?? null, i.load_restrictions.length > 0 ? 'restricted' : 'cleared',
            i.load_restrictions.length ? encrypt(JSON.stringify(i.load_restrictions), 'clinical_clearances.restrictions') : null,
            null, i.approved_on, i.valid_until ?? null, prevClearance?.id ?? null, cred.case_id],
        )).rows[0];
        clearanceId = cl.id;
        await c.query('UPDATE injury_rtp_approvals SET linked_clearance_id=$1 WHERE id=$2', [cl.id, row.id]);
        await c.query(`INSERT INTO injury_episode_links(episode_id, artifact_type, artifact_id, linked_by) VALUES ($1,'clearance',$2,$3) ON CONFLICT DO NOTHING`, [i.id, cl.id, user.id]);
      }
      await notify(c, ep.athlete_id, {
        kind: i.approval_type === 'return_to_play' ? 'rtp_approval' : 'rtt_approval',
        title: i.approval_type === 'return_to_play' ? 'Return-to-Play approval issued' : 'Return-to-Train approval issued',
        body: 'Open Health › My Injuries for the details and any load restrictions.',
        data: { episode_id: i.id, approval_id: row.id },
      });
      return { ...row, clearance_id: clearanceId };
    });
    await audit(null, user.id, 'write_clinical', 'injury_rtp_approvals', r.id);
    return r;
  },
});

// ------------------------------------------------------------------ revoke RTP approval
cap({
  name: 'revoke_rtp_approval', credential: true, method: 'POST', path: '/injury-episodes/:id/rtp/approvals/:approvalId/revoke',
  tag: TAG, auth: PROVIDER,
  summary: 'Revoke a Return-to-Train or Return-to-Play approval (e.g. new information, re-injury, setback). The reason is encrypted and stored. The athlete is notified. Any linked clinical clearance is not automatically withdrawn — do that separately if required.',
  input: z.object({ id, approvalId: id, reason: t(500) }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    const appr = await one('SELECT id, approved_by, revoked_at, episode_id FROM injury_rtp_approvals WHERE id=$1', [i.approvalId]);
    if (!appr || appr.episode_id !== i.id) throw notFound('RTP approval');
    if (appr.revoked_at) throw conflict('Already revoked');
    if (appr.approved_by !== user.id) throw forbidden('Only the issuing clinician can revoke this approval');
    const cred = await clinicianGate(user, ep.athlete_id, 'revoke_rtp_approval');
    await tx(async (c) => {
      await lockGate(c, cred, ep.athlete_id, user.id);
      await c.query(
        'UPDATE injury_rtp_approvals SET revoked_at=now(), revoked_by=$1, revoked_reason_enc=$2 WHERE id=$3',
        [user.id, encrypt(i.reason, 'injury_rtp_approvals.revoked_reason'), i.approvalId],
      );
      await notify(c, ep.athlete_id, { kind: 'rtp_revoked', title: 'An approval was revised', body: 'Open Health › My Injuries for the details.', data: { episode_id: i.id, approval_id: i.approvalId } });
    });
    await audit(null, user.id, 'write_clinical', 'injury_rtp_approvals', i.approvalId);
    return { id: i.approvalId, revoked: true };
  },
});

// ------------------------------------------------------------------ get RTP protocol
cap({
  name: 'get_rtp_protocol', method: 'GET', path: '/injury-episodes/:id/rtp',
  tag: TAG, auth: [...PROVIDER, 'athlete'],
  summary: 'Full Return-to-Play protocol for an injury episode: milestones with criteria and evidence (clinician only), and all RTT/RTP approvals with load restrictions. Athletes see stage names and status but not clinical criteria or internal assessments. Audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    const isAthlete = ep.athlete_id === user.id;
    const isClinician = !isAthlete && PROVIDER.some((r) => user.roles?.includes(r));
    if (!isAthlete && !isClinician) throw notFound('Injury episode');
    if (isClinician && !(await hasGrant(ep.athlete_id, user.id))) throw notFound('Injury episode');
    const milestones = await many(
      `SELECT m.*, u.display_name AS assessor_name FROM injury_rtp_milestones m LEFT JOIN users u ON u.id=m.assessed_by WHERE m.episode_id=$1 ORDER BY m.stage_order`,
      [i.id],
    );
    const approvals = await many(
      `SELECT a.*, u.display_name AS approver_name FROM injury_rtp_approvals a LEFT JOIN users u ON u.id=a.approved_by WHERE a.episode_id=$1 ORDER BY a.created_at DESC`,
      [i.id],
    );
    await audit(null, user.id, 'read_clinical', 'injury_rtp_milestones', i.id);
    return {
      episode_id: i.id,
      milestones: milestones.map((m) => ({ ...shapeMilestone(m, isClinician), assessor_name: m.assessor_name })),
      approvals: approvals.map((a) => ({
        id: a.id, approval_type: a.approval_type, status: a.status,
        approved_on: a.approved_on, valid_until: a.valid_until, revoked_at: a.revoked_at,
        approver_name: a.approver_name,
        linked_clearance_id: a.linked_clearance_id,
        // Athletes see load_restrictions (what they may/may not do); internal assessment never shared
        load_restrictions: (isAthlete || isClinician) && a.load_restrictions_enc
          ? JSON.parse(decrypt(a.load_restrictions_enc, 'injury_rtp_approvals.load_restrictions'))
          : [],
        internal_assessment: isClinician && a.internal_assessment_enc
          ? decrypt(a.internal_assessment_enc, 'injury_rtp_approvals.internal_assessment') : undefined,
        evidence_refs: isClinician && a.evidence_refs_enc
          ? decrypt(a.evidence_refs_enc, 'injury_rtp_approvals.evidence_refs') : undefined,
        conditions: (isAthlete || isClinician) && a.conditions_enc
          ? decrypt(a.conditions_enc, 'injury_rtp_approvals.conditions') : undefined,
        created_at: a.created_at,
      })),
    };
  },
});

// ------------------------------------------------------------------ list RTP approvals (provider)
cap({
  name: 'list_rtp_approvals', credential: true, method: 'GET', path: '/me/rtp-approvals',
  tag: TAG, auth: PROVIDER,
  summary: 'All Return-to-Train and Return-to-Play approvals the current clinician has issued across all patients, newest first. Includes patient display name, episode reference, approval type, status, and validity. Useful for the clinician\'s practice overview. Audit-logged.',
  input: z.object({ approval_type: z.enum(APPROVAL_TYPES).optional(), ...page }),
  async handler({ user }, i) {
    const typeFilter = i.approval_type ? 'AND a.approval_type=$4' : '';
    const params = i.approval_type ? [user.id, i.limit, i.offset, i.approval_type] : [user.id, i.limit, i.offset];
    const rows = await many(
      `SELECT a.id, a.approval_type, a.status, a.approved_on, a.valid_until, a.revoked_at, a.created_at,
              a.episode_id, e.episode_ref,
              u.display_name AS athlete_name,
              e.body_region, e.status AS episode_status
       FROM injury_rtp_approvals a
       JOIN injury_episodes e ON e.id = a.episode_id
       JOIN users u ON u.id = e.athlete_id
       WHERE a.approved_by = $1 ${typeFilter}
       ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`,
      params,
    );
    await audit(null, user.id, 'read_clinical', 'injury_rtp_approvals', user.id);
    return rows;
  },
});
