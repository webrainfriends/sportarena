// Elite Sports Medicine — Injury Episode lifecycle (issue #584).
// The central organising concept that ties all clinical artefacts together:
// injury → assessment → treatment → rehab → milestones → restricted training → RTT → RTP → closed.
// Every clinical write requires a verified provider credential AND the athlete's active full consent.
// Cross-athlete reads return 404 to avoid existence leaks. All clinical text is field-encrypted.
// Nothing is deleted: cancelled/closed episodes stay in history.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, query, tx } from '../db.js';
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

// Extended body regions covering all injury-relevant anatomical areas
export const BODY_REGIONS = [
  'head', 'face', 'neck', 'chest', 'abdomen', 'upper_back', 'lower_back',
  'shoulder', 'elbow', 'wrist_hand', 'groin', 'hip', 'thigh', 'hamstring',
  'quadriceps', 'knee', 'calf', 'achilles', 'ankle_foot', 'core', 'full_body',
];

const INJURY_TYPES = ['strain', 'sprain', 'fracture', 'contusion', 'laceration', 'tendinopathy', 'concussion', 'dislocation', 'nerve', 'other'];
const MECHANISMS = ['contact', 'non_contact', 'overuse', 'acute_on_chronic', 'unknown'];
const SEVERITIES = ['minor', 'moderate', 'significant', 'severe'];
const SIDES = ['left', 'right', 'bilateral', 'central', 'na'];
const STATUSES = ['active', 'rehabilitation', 'restricted_training', 'return_to_train', 'return_to_play', 'closed', 'cancelled'];
const ARTIFACT_TYPES = ['encounter', 'treatment_plan', 'care_plan', 'investigation', 'referral', 'clearance', 'rtp_approval'];
const IMPACT_TYPES = ['session', 'fixture', 'training_day'];

// Valid status transitions for clinical gate
const TRANSITIONS = {
  active: ['rehabilitation', 'cancelled'],
  rehabilitation: ['restricted_training', 'active', 'cancelled'],
  restricted_training: ['return_to_train', 'rehabilitation', 'cancelled'],
  return_to_train: ['return_to_play', 'rehabilitation', 'cancelled'],
  return_to_play: ['closed', 'rehabilitation'],
};

/** Requires a verified provider credential and the athlete's active full consent. */
async function clinicianGate(user, athleteId, action) {
  if (athleteId === user.id) throw badRequest('You cannot manage your own injury episode');
  const cred = await requireVerifiedProvider(user.id, { action, athleteId, types: PROVIDER });
  if (!(await hasGrant(athleteId, user.id))) throw forbidden('The athlete has not granted you access');
  return cred;
}

/** Re-check under lock inside the write transaction. */
async function lockGate(c, cred, athleteId, providerId) {
  await lockCredential(c, cred);
  if (!(await c.query(
    "SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE",
    [athleteId, providerId],
  )).rows[0]) throw forbidden('The athlete has not granted you access');
}

/** Fetch an episode and verify the requesting user may access it (clinician or own athlete). Returns { episode, isClinician }. */
async function fetchAccessible(episodeId, user) {
  const ep = await one(
    `SELECT e.*, u.display_name AS athlete_name FROM injury_episodes e JOIN users u ON u.id = e.athlete_id WHERE e.id = $1`,
    [episodeId],
  );
  if (!ep) throw notFound('Injury episode');
  const isAthlete = ep.athlete_id === user.id;
  const isClinician = !isAthlete && PROVIDER.some((r) => user.roles?.includes(r));
  if (!isAthlete && !isClinician) throw notFound('Injury episode');
  if (isClinician && !(await hasGrant(ep.athlete_id, user.id))) throw notFound('Injury episode');
  return { ep, isAthlete, isClinician };
}

/** Shape an episode row for the response. `full` = clinician view. */
const shapeEp = (ep, full) => ({
  id: ep.id,
  episode_ref: ep.episode_ref,
  athlete_id: ep.athlete_id,
  athlete_name: ep.athlete_name ?? undefined,
  organisation_id: ep.organisation_id,
  sport_id: ep.sport_id,
  status: ep.status,
  body_region: ep.body_region,
  side: ep.side,
  injury_type: ep.injury_type,
  mechanism: full ? ep.mechanism : undefined,
  severity: full ? ep.severity : undefined,
  occurred_on: ep.occurred_on,
  first_assessment_on: ep.first_assessment_on,
  expected_return_on: ep.expected_return_on,
  actual_return_on: ep.actual_return_on,
  is_recurrence: ep.is_recurrence,
  prior_episode_id: ep.prior_episode_id,
  opened_by: ep.opened_by,
  created_at: ep.created_at,
  archived_at: ep.archived_at,
});

// ------------------------------------------------------------------ open episode
cap({
  name: 'open_injury_episode', credential: true, method: 'POST', path: '/athletes/:athleteId/injury-episodes',
  tag: TAG, auth: PROVIDER, status: 201,
  summary: 'Clinician opens a new longitudinal injury episode for an athlete who has granted full consent. The episode becomes the single home for all clinical artefacts — encounters, treatment plans, investigations, clearances — through the full rehabilitation lifecycle to return-to-play. A human-readable episode reference is auto-generated (INJ-YYYY-NNN). Requires a verified provider credential and the athlete\'s active full consent. The athlete is notified immediately.',
  input: z.object({
    athleteId: id,
    occurred_on: day,
    body_region: z.enum(BODY_REGIONS),
    side: z.enum(SIDES).optional(),
    injury_type: z.enum(INJURY_TYPES),
    mechanism: z.enum(MECHANISMS).optional(),
    severity: z.enum(SEVERITIES).optional(),
    sport_id: id.optional(),
    expected_return_on: day.optional(),
    is_recurrence: z.boolean().default(false),
    prior_episode_id: id.optional(),
    first_assessment_on: day.optional(),
    organisation_id: id.optional(),
  }),
  async handler({ user }, i) {
    if (i.occurred_on > new Date().toISOString().slice(0, 10)) throw badRequest('Injury date cannot be in the future');
    if (i.first_assessment_on && i.first_assessment_on < i.occurred_on) throw badRequest('First assessment cannot be before the injury date');
    if (i.expected_return_on && i.expected_return_on < i.occurred_on) throw badRequest('Expected return cannot be before the injury date');
    if (i.is_recurrence && !i.prior_episode_id) throw badRequest('Provide the prior episode id when marking as recurrence');
    const cred = await clinicianGate(user, i.athleteId, 'open_injury_episode');
    const r = await tx(async (c) => {
      await lockGate(c, cred, i.athleteId, user.id);
      if (i.prior_episode_id) {
        const prior = (await c.query('SELECT id FROM injury_episodes WHERE id=$1 AND athlete_id=$2', [i.prior_episode_id, i.athleteId])).rows[0];
        if (!prior) throw notFound('Prior episode');
      }
      // Auto-generate episode reference: INJ-YYYY-NNN unique per athlete
      const year = new Date().getFullYear();
      const count = (await c.query(
        "SELECT COUNT(*) AS n FROM injury_episodes WHERE athlete_id=$1 AND episode_ref LIKE $2",
        [i.athleteId, `INJ-${year}-%`],
      )).rows[0].n;
      const episode_ref = `INJ-${year}-${String(Number(count) + 1).padStart(3, '0')}`;
      const ep = (await c.query(
        `INSERT INTO injury_episodes(athlete_id, organisation_id, sport_id, episode_ref, body_region, side, injury_type, mechanism, severity, occurred_on, first_assessment_on, expected_return_on, is_recurrence, prior_episode_id, opened_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, episode_ref, status, body_region, occurred_on, created_at`,
        [i.athleteId, i.organisation_id ?? null, i.sport_id ?? null, episode_ref, i.body_region, i.side ?? null,
          i.injury_type, i.mechanism ?? null, i.severity ?? null, i.occurred_on, i.first_assessment_on ?? null,
          i.expected_return_on ?? null, i.is_recurrence, i.prior_episode_id ?? null, user.id],
      )).rows[0];
      await c.query(
        `INSERT INTO injury_episode_events(episode_id, event_type, to_status, by_user_id) VALUES ($1,'opened','active',$2)`,
        [ep.id, user.id],
      );
      await notify(c, i.athleteId, { kind: 'injury_episode_opened', title: 'An injury episode has been opened on your record', body: 'Open Health › My Injuries to view it.', data: { episode_id: ep.id } });
      return ep;
    });
    await audit(null, user.id, 'write_clinical', 'injury_episodes', r.id);
    return r;
  },
});

// ------------------------------------------------------------------ update episode
cap({
  name: 'update_injury_episode', credential: true, method: 'PATCH', path: '/injury-episodes/:id',
  tag: TAG, auth: PROVIDER,
  summary: 'Clinician updates non-status fields of an injury episode: severity, expected return date, sport context, first assessment date, organisation. Each change appends a history event. Requires the original opener or any consented provider with a verified credential.',
  input: z.object({
    id,
    severity: z.enum(SEVERITIES).optional(),
    expected_return_on: day.nullable().optional(),
    sport_id: id.nullable().optional(),
    first_assessment_on: day.optional(),
    organisation_id: id.nullable().optional(),
  }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id, status, occurred_on FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    if (ep.status === 'closed' || ep.status === 'cancelled') throw conflict('Episode is ' + ep.status);
    if (i.expected_return_on && i.expected_return_on < ep.occurred_on) throw badRequest('Expected return cannot be before the injury date');
    const cred = await clinicianGate(user, ep.athlete_id, 'update_injury_episode');
    await tx(async (c) => {
      await lockGate(c, cred, ep.athlete_id, user.id);
      const sets = [];
      const vals = [];
      let p = 1;
      const push = (col, val) => { sets.push(`${col}=$${p++}`); vals.push(val); };
      if (i.severity !== undefined) push('severity', i.severity);
      if (i.expected_return_on !== undefined) push('expected_return_on', i.expected_return_on);
      if (i.sport_id !== undefined) push('sport_id', i.sport_id);
      if (i.first_assessment_on !== undefined) push('first_assessment_on', i.first_assessment_on);
      if (i.organisation_id !== undefined) push('organisation_id', i.organisation_id);
      if (sets.length) {
        vals.push(i.id);
        await c.query(`UPDATE injury_episodes SET ${sets.join(', ')} WHERE id=$${p}`, vals);
      }
      const eventType = i.severity !== undefined ? 'severity_set' : i.expected_return_on !== undefined ? 'expected_return_set' : 'note_added';
      await c.query(`INSERT INTO injury_episode_events(episode_id, event_type, by_user_id) VALUES ($1,$2,$3)`, [i.id, eventType, user.id]);
    });
    await audit(null, user.id, 'write_clinical', 'injury_episodes', i.id);
    return { id: i.id, updated: true };
  },
});

// ------------------------------------------------------------------ transition status
cap({
  name: 'transition_episode_status', credential: true, method: 'POST', path: '/injury-episodes/:id/transition',
  tag: TAG, auth: PROVIDER,
  summary: 'Advance or roll back an injury episode through its lifecycle: active → rehabilitation → restricted_training → return_to_train → return_to_play → closed. Setbacks allow rolling back (e.g. return_to_train → rehabilitation). An optional encrypted clinical note is recorded with every transition. The athlete is notified of each stage change.',
  input: z.object({ id, to_status: z.enum(STATUSES), note: tOpt(2000) }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id, status FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    if (ep.status === i.to_status) throw conflict('Episode is already in that status');
    if (ep.status === 'closed' || ep.status === 'cancelled') throw conflict('Episode is ' + ep.status);
    const allowed = TRANSITIONS[ep.status] ?? [];
    if (!allowed.includes(i.to_status)) throw badRequest(`Cannot transition from ${ep.status} to ${i.to_status}`);
    const cred = await clinicianGate(user, ep.athlete_id, 'transition_episode_status');
    await tx(async (c) => {
      await lockGate(c, cred, ep.athlete_id, user.id);
      await c.query('UPDATE injury_episodes SET status=$1 WHERE id=$2', [i.to_status, i.id]);
      await c.query(
        `INSERT INTO injury_episode_events(episode_id, event_type, from_status, to_status, note_enc, by_user_id) VALUES ($1,'status_change',$2,$3,$4,$5)`,
        [i.id, ep.status, i.to_status, i.note ? encrypt(i.note, 'injury_episode_events.note') : null, user.id],
      );
      await notify(c, ep.athlete_id, { kind: 'injury_episode_status', title: 'Your injury episode status was updated', body: 'Open Health › My Injuries to view the latest update.', data: { episode_id: i.id, to_status: i.to_status } });
    });
    await audit(null, user.id, 'write_clinical', 'injury_episodes', i.id);
    return { id: i.id, from_status: ep.status, to_status: i.to_status };
  },
});

// ------------------------------------------------------------------ close episode
cap({
  name: 'close_injury_episode', credential: true, method: 'POST', path: '/injury-episodes/:id/close',
  tag: TAG, auth: PROVIDER,
  summary: 'Formally close an injury episode with the athlete\'s actual return date and an optional outcome note. Status is set to closed. The episode and all its linked artefacts remain in history. The athlete is notified.',
  input: z.object({ id, actual_return_on: day, outcome_note: tOpt(2000) }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id, status, occurred_on FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    if (ep.status === 'closed') throw conflict('Episode is already closed');
    if (ep.status === 'cancelled') throw conflict('Episode is cancelled');
    if (i.actual_return_on < ep.occurred_on) throw badRequest('Actual return cannot be before the injury date');
    const cred = await clinicianGate(user, ep.athlete_id, 'close_injury_episode');
    await tx(async (c) => {
      await lockGate(c, cred, ep.athlete_id, user.id);
      await c.query(
        'UPDATE injury_episodes SET status=$1, actual_return_on=$2 WHERE id=$3',
        ['closed', i.actual_return_on, i.id],
      );
      await c.query(
        `INSERT INTO injury_episode_events(episode_id, event_type, from_status, to_status, note_enc, by_user_id) VALUES ($1,'status_change',$2,'closed',$3,$4)`,
        [i.id, ep.status, i.outcome_note ? encrypt(i.outcome_note, 'injury_episode_events.note') : null, user.id],
      );
      await notify(c, ep.athlete_id, { kind: 'injury_episode_closed', title: 'Your injury episode has been closed', body: 'You\'ve been cleared to return. Open Health › My Injuries to view the full record.', data: { episode_id: i.id } });
    });
    await audit(null, user.id, 'write_clinical', 'injury_episodes', i.id);
    return { id: i.id, status: 'closed', actual_return_on: i.actual_return_on };
  },
});

// ------------------------------------------------------------------ link artefact
cap({
  name: 'link_artifact_to_episode', credential: true, method: 'POST', path: '/injury-episodes/:id/links',
  tag: TAG, auth: PROVIDER, status: 201,
  summary: 'Link an existing clinical artefact (encounter, treatment plan, care plan, investigation, referral, clearance, or RTP approval) to this injury episode. Links provide the full longitudinal picture — tap through to the linked artefact for clinical detail. Duplicate links are silently ignored.',
  input: z.object({ id, artifact_type: z.enum(ARTIFACT_TYPES), artifact_id: id }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    const cred = await clinicianGate(user, ep.athlete_id, 'link_artifact_to_episode');
    await tx(async (c) => {
      await lockGate(c, cred, ep.athlete_id, user.id);
      await c.query(
        `INSERT INTO injury_episode_links(episode_id, artifact_type, artifact_id, linked_by) VALUES ($1,$2,$3,$4) ON CONFLICT (episode_id, artifact_type, artifact_id) DO NOTHING`,
        [i.id, i.artifact_type, i.artifact_id, user.id],
      );
      await c.query(
        `INSERT INTO injury_episode_events(episode_id, event_type, by_user_id) VALUES ($1,'artifact_linked',$2)`,
        [i.id, user.id],
      );
    });
    await audit(null, user.id, 'write_clinical', 'injury_episode_links', i.id);
    return { episode_id: i.id, artifact_type: i.artifact_type, artifact_id: i.artifact_id };
  },
});

// ------------------------------------------------------------------ record impact
cap({
  name: 'record_episode_impact', credential: true, method: 'POST', path: '/injury-episodes/:id/impact',
  tag: TAG, auth: PROVIDER, status: 201,
  summary: 'Record a session, fixture, or training day that the athlete missed or had to leave early due to this injury episode. Impact records build the recovery timeline and inform squad-selection reports. Use reference_id when the event is on the platform; reference_label when it was an external event.',
  input: z.object({
    id,
    impact_type: z.enum(IMPACT_TYPES),
    reference_date: day,
    reference_label: tOpt(200),
    reference_id: id.optional(),
  }),
  async handler({ user }, i) {
    const ep = await one('SELECT id, athlete_id FROM injury_episodes WHERE id=$1', [i.id]);
    if (!ep) throw notFound('Injury episode');
    const cred = await clinicianGate(user, ep.athlete_id, 'record_episode_impact');
    const r = await tx(async (c) => {
      await lockGate(c, cred, ep.athlete_id, user.id);
      const row = (await c.query(
        `INSERT INTO injury_episode_impact(episode_id, impact_type, reference_id, reference_date, reference_label, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [i.id, i.impact_type, i.reference_id ?? null, i.reference_date, i.reference_label ?? null, user.id],
      )).rows[0];
      await c.query(
        `INSERT INTO injury_episode_events(episode_id, event_type, by_user_id) VALUES ($1,'impact_recorded',$2)`,
        [i.id, user.id],
      );
      return row;
    });
    await audit(null, user.id, 'write_clinical', 'injury_episode_impact', i.id);
    return r;
  },
});

// ------------------------------------------------------------------ get episode
cap({
  name: 'get_injury_episode', method: 'GET', path: '/injury-episodes/:id',
  tag: TAG, auth: [...PROVIDER, 'athlete'],
  summary: 'Retrieve an injury episode. Clinicians with active full consent see all fields including severity, mechanism, internal notes and all linked artefacts. Athletes see their own episode with status, expected return and body region but no internal clinical notes. Audit-logged on every access.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { ep, isAthlete, isClinician } = await fetchAccessible(i.id, user);
    const links = await many('SELECT artifact_type, artifact_id, linked_at FROM injury_episode_links WHERE episode_id=$1 ORDER BY linked_at', [i.id]);
    const impacts = await many('SELECT id, impact_type, reference_date, reference_label, reference_id FROM injury_episode_impact WHERE episode_id=$1 ORDER BY reference_date DESC', [i.id]);
    await audit(null, user.id, 'read_clinical', 'injury_episodes', i.id);
    return { ...shapeEp(ep, isClinician), links, impacts };
  },
});

// ------------------------------------------------------------------ episode timeline
cap({
  name: 'get_episode_timeline', method: 'GET', path: '/injury-episodes/:id/timeline',
  tag: TAG, auth: [...PROVIDER, 'athlete'],
  summary: 'Full chronological timeline for an injury episode: status transitions with clinical notes, artefact links, impact entries, and RTP milestone summaries. Clinical notes in transitions are only decrypted for the treating clinician. Audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { ep, isAthlete, isClinician } = await fetchAccessible(i.id, user);
    const events = await many(
      `SELECT e.id, e.event_type, e.from_status, e.to_status, e.note_enc, e.at, u.display_name AS by_name
       FROM injury_episode_events e JOIN users u ON u.id = e.by_user_id
       WHERE e.episode_id = $1 ORDER BY e.at`,
      [i.id],
    );
    const links = await many(
      `SELECT l.artifact_type, l.artifact_id, l.linked_at, u.display_name AS by_name
       FROM injury_episode_links l JOIN users u ON u.id = l.linked_by
       WHERE l.episode_id = $1 ORDER BY l.linked_at`,
      [i.id],
    );
    const impacts = await many('SELECT * FROM injury_episode_impact WHERE episode_id=$1 ORDER BY reference_date DESC', [i.id]);
    const milestones = await many(
      'SELECT id, stage_order, stage_name, status, target_date, achieved_on FROM injury_rtp_milestones WHERE episode_id=$1 ORDER BY stage_order',
      [i.id],
    );
    await audit(null, user.id, 'read_clinical', 'injury_episodes', i.id);
    return {
      episode: shapeEp(ep, isClinician),
      events: events.map((e) => ({
        id: e.id, event_type: e.event_type, from_status: e.from_status, to_status: e.to_status,
        note: isClinician && e.note_enc ? decrypt(e.note_enc, 'injury_episode_events.note') : undefined,
        at: e.at, by_name: e.by_name,
      })),
      links,
      impacts,
      milestones,
    };
  },
});

// ------------------------------------------------------------------ list episodes (clinician)
cap({
  name: 'list_injury_episodes', credential: true, method: 'GET', path: '/athletes/:athleteId/injury-episodes',
  tag: TAG, auth: PROVIDER,
  summary: 'List all injury episodes for an athlete the clinician has active full consent for. Returns summary fields (no encrypted clinical notes). Filter by status. Newest episodes first. Audit-logged.',
  input: z.object({ athleteId: id, status: z.enum(STATUSES).optional(), ...page }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'list_injury_episodes', athleteId: i.athleteId, types: PROVIDER });
    if (!(await hasGrant(i.athleteId, user.id))) throw forbidden('The athlete has not granted you access');
    const where = i.status ? 'AND e.status=$4' : '';
    const params = i.status ? [i.athleteId, i.limit, i.offset, i.status] : [i.athleteId, i.limit, i.offset];
    const rows = await many(
      `SELECT e.id, e.episode_ref, e.status, e.body_region, e.side, e.injury_type, e.severity, e.mechanism,
              e.occurred_on, e.expected_return_on, e.actual_return_on, e.is_recurrence, e.sport_id,
              e.opened_by, e.created_at,
              (SELECT COUNT(*) FROM injury_episode_impact WHERE episode_id=e.id) AS impact_count,
              (SELECT COUNT(*) FROM injury_rtp_milestones WHERE episode_id=e.id) AS milestone_count
       FROM injury_episodes e
       WHERE e.athlete_id=$1 AND e.archived_at IS NULL ${where}
       ORDER BY e.occurred_on DESC, e.created_at DESC LIMIT $2 OFFSET $3`,
      params,
    );
    await audit(null, user.id, 'read_clinical', 'injury_episodes', i.athleteId);
    return rows;
  },
});

// ------------------------------------------------------------------ my episodes (athlete)
cap({
  name: 'my_injury_episodes', method: 'GET', path: '/me/injury-episodes',
  tag: TAG, auth: [...PROVIDER, 'athlete'],
  summary: 'Athlete\'s own injury episode history — non-clinical summary (body region, status, phase label, expected return, occurred date). No internal clinical notes, severity or mechanism visible. Useful for the My Injuries section of the Health hub. Audit-logged.',
  input: z.object({ status: z.enum([...STATUSES, 'active_only']).optional(), ...page }),
  async handler({ user }, i) {
    const statusFilter = i.status === 'active_only'
      ? "AND e.status NOT IN ('closed','cancelled')"
      : i.status ? `AND e.status=$3` : '';
    const params = i.status && i.status !== 'active_only' ? [user.id, i.limit, i.offset, i.status] : [user.id, i.limit, i.offset];
    const rows = await many(
      `SELECT e.id, e.episode_ref, e.status, e.body_region, e.side, e.injury_type, e.occurred_on,
              e.expected_return_on, e.actual_return_on, e.is_recurrence, e.sport_id, e.created_at,
              (SELECT COUNT(*) FROM injury_episode_impact WHERE episode_id=e.id) AS missed_events_count,
              (SELECT COUNT(*) FROM injury_rtp_milestones WHERE episode_id=e.id AND status='achieved') AS milestones_achieved,
              (SELECT COUNT(*) FROM injury_rtp_milestones WHERE episode_id=e.id) AS milestones_total
       FROM injury_episodes e
       WHERE e.athlete_id=$1 AND e.archived_at IS NULL ${statusFilter}
       ORDER BY CASE WHEN e.status NOT IN ('closed','cancelled') THEN 0 ELSE 1 END, e.occurred_on DESC LIMIT $2 OFFSET $3`,
      params,
    );
    await audit(null, user.id, 'read_clinical', 'injury_episodes', user.id);
    return rows;
  },
});
