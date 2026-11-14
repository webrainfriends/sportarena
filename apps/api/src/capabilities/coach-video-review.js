// Coach Video Review service (issue #517). Remote coaching via video analysis:
// coach creates a request → athlete uploads evidence to the existing coaching-evidence router →
// coach reviews and adds timestamped notes → athlete reads and acknowledges.
// NEVER stores video bytes — all file I/O goes through the existing coachingEvidenceRouter().
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { decrypt, encrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { canReadObservation } from '../coaching-observation-access.js';
import { isYouth, guardiansOf } from '../youth.js';

const TAG = 'Coach video review';
const COACH = ['coach'];
const STATUSES = ['awaiting_upload','uploaded','under_review','review_complete','acknowledged','archived'];
const isoDate = z.string().date();

const tsItemSchema = z.object({ t_secs: z.number().nonnegative(), label: z.string().min(1).max(80), action_text: z.string().max(500) });
const assignmentSchema = z.object({ id: z.string().uuid(), description: z.string().min(1).max(500), due_on: isoDate.optional(), completed_at: z.string().datetime().optional().nullable() });

// ── 1. create_video_review_request ────────────────────────────────────────────
cap({
  name: 'create_video_review_request', method: 'POST', path: '/coach/video-review', tag: TAG, auth: COACH, status: 201,
  summary: 'Coach creates a video review request. For youth athletes, guardian consent is required. The athlete uploads their video to the coaching observation the request references via PUT /coaching/observations/:id/evidence.',
  input: z.object({
    athlete_id: id,
    sport_id: id.optional(),
    observation_id: id,
    title: z.string().trim().min(2).max(120),
    brief: z.string().trim().min(1).max(2000),
    rate_card_id: id.optional(),
    hire_id: id.optional(),
    package_purchase_id: id.optional(),
  }),
  async handler({ user }, i) {
    const athlete = await one('SELECT id FROM users WHERE id=$1', [i.athlete_id]);
    if (!athlete) throw notFound('Athlete');
    if (i.athlete_id === user.id) throw badRequest('You cannot create a video review for yourself');
    const youth = await isYouth(i.athlete_id);
    if (youth) {
      const guardians = await guardiansOf(i.athlete_id);
      if (!guardians.length) throw conflict('guardian_consent_required', { code: 'guardian_consent_required' });
    }
    const obs = await one('SELECT id, coach_id FROM coaching_observations WHERE id=$1', [i.observation_id]);
    if (!obs) throw notFound('Observation');
    const briefEnc = encrypt(i.brief, 'coach_video_review_requests.brief');
    const rows = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO coach_video_review_requests(coach_id, athlete_id, sport_id, observation_id, title, brief_enc, rate_card_id, hire_id, package_purchase_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status, row_version`,
        [user.id, i.athlete_id, i.sport_id ?? null, i.observation_id, i.title, briefEnc, i.rate_card_id ?? null, i.hire_id ?? null, i.package_purchase_id ?? null]);
      await audit(c, user.id, 'coach_video_review.created', { review_id: r.rows[0].id });
      return r.rows;
    });
    await notify(null, i.athlete_id, { kind: 'video_review_requested', title: `Video review: ${i.title}`, body: 'Upload your video to get started.', data: { review_id: rows[0].id }, dedupe_key: `vr_requested:${rows[0].id}` });
    return { id: rows[0].id, status: rows[0].status, row_version: rows[0].row_version };
  },
});

// ── 2. list_video_review_requests ─────────────────────────────────────────────
cap({
  name: 'list_video_review_requests', method: 'GET', path: '/coach/video-review', tag: TAG, auth: COACH,
  summary: 'Coach: list all their video review requests filtered by status.',
  input: z.object({ status: z.enum([...STATUSES, 'all']).default('all') }),
  async handler({ user }, i) {
    const filter = i.status !== 'all' ? ' AND r.status=$2' : '';
    return many(
      `SELECT r.id, r.title, r.status, r.athlete_id, r.sport_id, r.observation_id,
              r.submitted_at, r.completed_at, r.athlete_acknowledged_at, r.row_version,
              u.display_name AS athlete_name, s.name AS sport_name
         FROM coach_video_review_requests r
         JOIN users u ON u.id = r.athlete_id
         LEFT JOIN sports s ON s.id = r.sport_id
        WHERE r.coach_id=$1 AND r.archived_at IS NULL${filter}
        ORDER BY r.created_at DESC LIMIT 50`,
      i.status !== 'all' ? [user.id, i.status] : [user.id]);
  },
});

// ── 3. my_video_review_requests ───────────────────────────────────────────────
cap({
  name: 'my_video_review_requests', method: 'GET', path: '/me/video-review', tag: TAG, auth: 'user',
  summary: 'Athlete: their video review requests and coach feedback (once review_complete). Youth: guardian must hold active coaching consent.',
  input: z.object({ status: z.enum([...STATUSES, 'all']).default('all') }),
  async handler({ user }, i) {
    const filter = i.status !== 'all' ? ' AND r.status=$2' : '';
    const rows = await many(
      `SELECT r.id, r.title, r.status, r.coach_id, r.observation_id,
              r.submitted_at, r.completed_at, r.athlete_acknowledged_at,
              r.feedback_enc, r.timestamps_json, r.assignments_json, r.row_version,
              u.display_name AS coach_name
         FROM coach_video_review_requests r
         JOIN users u ON u.id = r.coach_id
        WHERE r.athlete_id=$1 AND r.archived_at IS NULL${filter}
        ORDER BY r.created_at DESC LIMIT 50`,
      i.status !== 'all' ? [user.id, i.status] : [user.id]);
    return rows.map((r) => ({
      ...r,
      feedback: r.status === 'review_complete' || r.status === 'acknowledged' ? (r.feedback_enc ? (() => { try { return decrypt(r.feedback_enc, 'coach_video_review_requests.feedback'); } catch { return null; } })() : null) : null,
      feedback_enc: undefined,
    }));
  },
});

// ── 4. get_video_review_request ───────────────────────────────────────────────
cap({
  name: 'get_video_review_request', method: 'GET', path: '/coach/video-review/:id', tag: TAG, auth: 'user',
  summary: 'Full review record. Brief always decrypted. Feedback decrypted only once review_complete. Access re-derived via canReadObservation() on every request.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one(
      `SELECT r.*, u.display_name AS athlete_name, cu.display_name AS coach_name, s.name AS sport_name
         FROM coach_video_review_requests r
         JOIN users u ON u.id = r.athlete_id
         JOIN users cu ON cu.id = r.coach_id
         LEFT JOIN sports s ON s.id = r.sport_id
        WHERE r.id=$1 AND r.archived_at IS NULL`, [i.id]);
    if (!r) throw notFound('Review');
    if (r.coach_id !== user.id && r.athlete_id !== user.id) throw forbidden('Access denied');
    const obs = await one('SELECT id, coach_id, athlete_id, team_id, visibility FROM coaching_observations WHERE id=$1', [r.observation_id]);
    if (!obs || !(await canReadObservation(user, obs))) throw notFound('Observation');
    const dec = (enc, path) => { if (!enc) return null; try { return decrypt(enc, path); } catch { return null; } };
    const feedbackReady = r.status === 'review_complete' || r.status === 'acknowledged';
    return {
      ...r,
      brief: dec(r.brief_enc, 'coach_video_review_requests.brief'),
      feedback: feedbackReady ? dec(r.feedback_enc, 'coach_video_review_requests.feedback') : null,
      brief_enc: undefined,
      feedback_enc: undefined,
    };
  },
});

// ── 5. submit_video_for_review ─────────────────────────────────────────────────
cap({
  name: 'submit_video_for_review', method: 'PATCH', path: '/coach/video-review/:id/submit', tag: TAG, auth: 'user',
  summary: 'Athlete confirms the evidence upload is done. The observation must have at least one attached evidence file.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM coach_video_review_requests WHERE id=$1 AND athlete_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, user.id])).rows[0];
      if (!r) throw notFound('Review');
      if (r.row_version !== i.row_version) throw conflict('Changed elsewhere — reload and retry.');
      if (r.status !== 'awaiting_upload') throw badRequest(`Review is already ${r.status}`);
      const evidence = (await c.query('SELECT id FROM coaching_evidence WHERE observation_id=$1 AND removed_at IS NULL LIMIT 1', [r.observation_id])).rows[0];
      if (!evidence) throw badRequest('Upload your video first. Use PUT /coaching/observations/:id/evidence.');
      const { rows } = await c.query(
        `UPDATE coach_video_review_requests SET status='uploaded', submitted_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id]);
      await notify(c, r.coach_id, { kind: 'video_review_uploaded', title: `Video review ready: ${r.title}`, body: 'The athlete has uploaded their video for review.', data: { review_id: i.id }, dedupe_key: `vr_uploaded:${i.id}` });
      return { status: 'uploaded', row_version: rows[0].row_version };
    });
  },
});

// ── 6. start_video_review ─────────────────────────────────────────────────────
cap({
  name: 'start_video_review', method: 'PATCH', path: '/coach/video-review/:id/start-review', tag: TAG, auth: COACH,
  summary: 'Coach acknowledges start of review. Sets status to under_review.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM coach_video_review_requests WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, user.id])).rows[0];
      if (!r) throw notFound('Review');
      if (r.row_version !== i.row_version) throw conflict('Changed elsewhere — reload and retry.');
      if (r.status !== 'uploaded') throw badRequest(`Review is ${r.status}`);
      const { rows } = await c.query(
        `UPDATE coach_video_review_requests SET status='under_review', row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id]);
      return { status: 'under_review', row_version: rows[0].row_version };
    });
  },
});

// ── 7. complete_video_review ──────────────────────────────────────────────────
cap({
  name: 'complete_video_review', method: 'PATCH', path: '/coach/video-review/:id/complete', tag: TAG, auth: COACH,
  summary: 'Coach submits feedback (encrypted), timestamped notes and assignments. Notifies athlete or guardian.',
  input: z.object({
    id,
    feedback: z.string().trim().min(1).max(5000),
    timestamps: z.array(tsItemSchema).max(50).default([]),
    assignments: z.array(assignmentSchema).max(20).default([]),
    row_version: z.number().int().min(1),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM coach_video_review_requests WHERE id=$1 AND coach_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, user.id])).rows[0];
      if (!r) throw notFound('Review');
      if (r.row_version !== i.row_version) throw conflict('Changed elsewhere — reload and retry.');
      if (!['uploaded','under_review'].includes(r.status)) throw badRequest(`Cannot complete review with status '${r.status}'`);
      const feedbackEnc = encrypt(i.feedback, 'coach_video_review_requests.feedback');
      const { rows } = await c.query(
        `UPDATE coach_video_review_requests SET status='review_complete', feedback_enc=$2, timestamps_json=$3, assignments_json=$4, feedback_given_at=now(), completed_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id, feedbackEnc, JSON.stringify(i.timestamps), JSON.stringify(i.assignments)]);
      await audit(c, user.id, 'coach_video_review.completed', { review_id: i.id });
      const youth = await isYouth(r.athlete_id);
      const notifyId = youth ? (await guardiansOf(r.athlete_id))[0]?.id ?? r.athlete_id : r.athlete_id;
      await notify(c, notifyId, { kind: 'video_review_complete', title: `Video feedback ready: ${r.title}`, body: 'Your coach has shared feedback on your video.', data: { review_id: i.id }, dedupe_key: `vr_complete:${i.id}` });
      return { status: 'review_complete', row_version: rows[0].row_version };
    });
  },
});

// ── 8. acknowledge_video_review ───────────────────────────────────────────────
cap({
  name: 'acknowledge_video_review', method: 'PATCH', path: '/coach/video-review/:id/acknowledge', tag: TAG, auth: 'user',
  summary: 'Athlete confirms they have read the feedback.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM coach_video_review_requests WHERE id=$1 AND athlete_id=$2 AND archived_at IS NULL FOR UPDATE', [i.id, user.id])).rows[0];
      if (!r) throw notFound('Review');
      if (r.row_version !== i.row_version) throw conflict('Changed elsewhere — reload and retry.');
      if (r.status !== 'review_complete') throw badRequest(`Review is ${r.status}`);
      const { rows } = await c.query(
        `UPDATE coach_video_review_requests SET status='acknowledged', athlete_acknowledged_at=now(), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING row_version`,
        [i.id]);
      return { status: 'acknowledged', row_version: rows[0].row_version };
    });
  },
});
