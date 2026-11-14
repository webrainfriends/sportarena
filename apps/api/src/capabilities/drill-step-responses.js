// Drill step responses: athletes submit voice or text replies to individual drill steps, coaches give per-step feedback.
// Transcription of an audio step (coach's uploaded MP3/M4A/WAV/OGG) is handled via the existing coaching/voice-note bridge.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { AppError } from '../errors.js';
import { authenticate } from '../auth.js';
import { saveEncrypted, loadEncrypted } from '../doc-store.js';
import { sniffAudio } from '../team-chat-stream.js';
import { encrypt, decrypt } from '../crypto.js';
import { config } from '../config.js';
import { audit } from '../helpers.js';

const TAG = 'Coach';
const COACH = ['coach'];
const ATHLETE = ['athlete', 'coach'];
const FOLDER = 'drill-media';
const AUDIO_LIMIT = 10 * 2 ** 20; // 10 MB for athlete voice responses

// ── helpers ────────────────────────────────────────────────────────────────

async function requireCoachingRelationship(coachId, athleteId, sessionId) {
  const ok = await one(
    `SELECT 1 FROM coaching_session_records r
     WHERE r.id=$1 AND r.coach_id=$2
       AND EXISTS (
         SELECT 1 FROM coaching_session_athletes sa WHERE sa.session_record_id=r.id AND sa.athlete_id=$3 AND sa.removed_at IS NULL
       )`,
    [sessionId, coachId, athleteId]);
  return !!ok;
}

async function requireAthleteInSession(athleteId, sessionId) {
  const ok = await one(
    `SELECT 1 FROM coaching_session_athletes sa
      JOIN coaching_session_records r ON r.id=sa.session_record_id
     WHERE sa.session_record_id=$1 AND sa.athlete_id=$2 AND sa.removed_at IS NULL`,
    [sessionId, athleteId]);
  return !!ok;
}

// ── Transcribe a drill step's audio instruction ────────────────────────────

cap({
  name: 'transcribe_drill_step_audio', method: 'POST', path: '/coaching/drills/:id/steps/:stepIndex/transcribe', tag: TAG, auth: COACH,
  summary: 'Send the audio file of a drill step to the speech-to-text service and return a transcript for review. Nothing is stored; the coach reviews and saves the text via update_coaching_template.',
  input: z.object({ id, stepIndex: z.coerce.number().int().min(0).max(29), language: z.string().length(2).default('en') }),
  async handler({ user }, i) {
    if (!config.transcribe?.url) throw new AppError(501, 'not_available', 'Voice-to-text is not configured on this server. Type the transcript instead.');
    const tpl = await one("SELECT id, coach_id, steps FROM coach_templates WHERE id=$1 AND archived_at IS NULL AND scope='block'", [i.id]);
    if (!tpl) throw notFound('Drill');
    if (tpl.coach_id !== user.id) throw forbidden('Not your drill');
    const step = (tpl.steps ?? [])[i.stepIndex];
    if (!step) throw notFound('Step');
    if (step.type !== 'audio' && step.type !== 'video') throw badRequest('Only audio or video steps can be transcribed');
    if (!step.media_id) throw badRequest('This step has no audio attached yet');
    const m = await one('SELECT * FROM drill_media WHERE id=$1 AND template_id=$2 AND removed_at IS NULL', [step.media_id, i.id]);
    if (!m) throw notFound('Media');
    const buf = await loadEncrypted(FOLDER, 'drill_media.file_name', m.file_name);
    const url = new URL(config.transcribe.url);
    url.searchParams.set('language', i.language);
    const resp = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': m.content_type, 'x-language': i.language, ...(config.transcribe.secret ? { authorization: `Bearer ${config.transcribe.secret}` } : {}) },
      body: buf,
    });
    if (!resp.ok) throw new AppError(502, 'transcription_failed', 'The audio could not be transcribed. Type the text instead.');
    const out = await resp.json().catch(() => null);
    const textOut = typeof out?.transcript === 'string' ? out.transcript.trim() : typeof out === 'string' ? out.trim() : '';
    if (!textOut) throw new AppError(502, 'transcription_failed', 'The transcription returned no text. Type it instead.');
    await audit(null, user.id, 'drill_step_transcribe', 'coach_templates', i.id);
    return { transcript: textOut, language: out?.language ?? i.language, step_index: i.stepIndex, note: 'Review and edit this text, then save it via update_coaching_template.' };
  },
});

// ── Athlete: submit a voice or text response to a drill step ───────────────

cap({
  name: 'submit_drill_step_response', method: 'POST', path: '/coaching/sessions/:id/drills/:drillId/steps/:stepIndex/respond', tag: TAG, auth: 'user',
  summary: 'Submit a voice or text response to a specific drill step in an active coaching session. Voice responses are stored encrypted. Text is encrypted at rest.',
  input: z.object({
    id,
    drillId: id,
    stepIndex: z.coerce.number().int().min(0).max(29),
    text: z.string().trim().max(2000).optional(),
    audio_media_id: id.optional(),
  }),
  async handler({ user }, i) {
    if (!i.text && !i.audio_media_id) throw badRequest('Provide a text response or an audio recording');
    const rec = await one('SELECT id, coach_id FROM coaching_session_records WHERE id=$1', [i.id]);
    if (!rec) throw notFound('Session');
    const inSession = await requireAthleteInSession(user.id, i.id);
    if (!inSession) throw forbidden('You are not in this session');
    const tpl = await one("SELECT id, steps FROM coach_templates WHERE id=$1 AND archived_at IS NULL AND scope='block'", [i.drillId]);
    if (!tpl) throw notFound('Drill');
    const step = (tpl.steps ?? [])[i.stepIndex];
    if (!step) throw notFound('Step');
    if (step.allow_athlete_response === false) throw forbidden('Responses are not enabled for this step');
    if (i.audio_media_id) {
      const m = await one('SELECT id FROM drill_media WHERE id=$1 AND template_id=$2 AND kind=\'audio\' AND removed_at IS NULL', [i.audio_media_id, i.drillId]);
      if (!m) throw notFound('Audio');
    }
    const textEnc = i.text ? encrypt(i.text, 'drill_step_responses.response_text_enc') : null;
    const row = await one(
      `INSERT INTO drill_step_responses(session_record_id,template_id,step_index,athlete_id,audio_media_id,response_text_enc)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_record_id,template_id,step_index,athlete_id) WHERE archived_at IS NULL
       DO UPDATE SET audio_media_id=EXCLUDED.audio_media_id, response_text_enc=EXCLUDED.response_text_enc, submitted_at=now()
       RETURNING id, step_index, submitted_at`,
      [i.id, i.drillId, i.stepIndex, user.id, i.audio_media_id ?? null, textEnc]);
    return row;
  },
});

// ── Coach: list responses for a drill step ─────────────────────────────────

cap({
  name: 'list_drill_step_responses', method: 'GET', path: '/coaching/sessions/:id/drills/:drillId/steps/:stepIndex/responses', tag: TAG, auth: COACH,
  summary: 'List all athlete responses to a drill step in a session. Includes auto-transcripts where available. Text is decrypted for the coach.',
  input: z.object({ id, drillId: id, stepIndex: z.coerce.number().int().min(0).max(29) }),
  async handler({ user }, i) {
    const rec = await one('SELECT id, coach_id FROM coaching_session_records WHERE id=$1', [i.id]);
    if (!rec) throw notFound('Session');
    if (rec.coach_id !== user.id) throw forbidden('Not your session');
    const rows = await many(
      `SELECT r.id, r.step_index, r.athlete_id, r.audio_media_id, r.response_text_enc, r.feedback_text_enc, r.feedback_audio_id, r.feedback_rating, r.feedback_at, r.submitted_at,
              u.full_name AS athlete_name
       FROM drill_step_responses r
       JOIN users u ON u.id=r.athlete_id
       WHERE r.session_record_id=$1 AND r.template_id=$2 AND r.step_index=$3 AND r.archived_at IS NULL
       ORDER BY r.submitted_at`,
      [i.id, i.drillId, i.stepIndex]);
    await audit(null, user.id, 'drill_step_responses_read', 'coaching_session_records', i.id);
    return rows.map((r) => ({
      ...r,
      response_text: r.response_text_enc ? decrypt(r.response_text_enc, 'drill_step_responses.response_text_enc') : null,
      feedback_text: r.feedback_text_enc ? decrypt(r.feedback_text_enc, 'drill_step_responses.feedback_text_enc') : null,
      response_text_enc: undefined,
      feedback_text_enc: undefined,
      audio_file_url: r.audio_media_id ? `/api/v1/coaching/drills/${i.drillId}/media/${r.audio_media_id}/file` : null,
      feedback_audio_file_url: r.feedback_audio_id ? `/api/v1/coaching/drills/${i.drillId}/media/${r.feedback_audio_id}/file` : null,
    }));
  },
});

// ── Coach: send feedback on an athlete's drill step response ───────────────

cap({
  name: 'send_drill_step_feedback', method: 'POST', path: '/coaching/sessions/:id/drills/:drillId/steps/:stepIndex/athletes/:athleteId/feedback', tag: TAG, auth: COACH,
  summary: 'Send written or audio feedback (and an optional rating) on an athlete\'s drill step response. The athlete will see this when they next open the step.',
  input: z.object({
    id, drillId: id, stepIndex: z.coerce.number().int().min(0).max(29), athleteId: id,
    text: z.string().trim().max(2000).optional(),
    audio_media_id: id.optional(),
    rating: z.enum(['excellent', 'good', 'redo', 'issue']).optional(),
  }),
  async handler({ user }, i) {
    if (!i.text && !i.audio_media_id && !i.rating) throw badRequest('Provide feedback text, an audio recording, or a rating');
    const rec = await one('SELECT id, coach_id FROM coaching_session_records WHERE id=$1', [i.id]);
    if (!rec) throw notFound('Session');
    if (rec.coach_id !== user.id) throw forbidden('Not your session');
    if (i.audio_media_id) {
      const m = await one('SELECT id FROM drill_media WHERE id=$1 AND template_id=$2 AND kind=\'audio\' AND removed_at IS NULL', [i.audio_media_id, i.drillId]);
      if (!m) throw notFound('Feedback audio');
    }
    const textEnc = i.text ? encrypt(i.text, 'drill_step_responses.feedback_text_enc') : null;
    const r = await one(
      `UPDATE drill_step_responses
       SET feedback_text_enc=coalesce($4,feedback_text_enc),
           feedback_audio_id=coalesce($5,feedback_audio_id),
           feedback_rating=coalesce($6,feedback_rating),
           feedback_at=now()
       WHERE session_record_id=$1 AND template_id=$2 AND step_index=$3 AND athlete_id=$7 AND archived_at IS NULL
       RETURNING id, feedback_rating, feedback_at`,
      [i.id, i.drillId, i.stepIndex, textEnc, i.audio_media_id ?? null, i.rating ?? null, i.athleteId]);
    if (!r) throw notFound('Response');
    await audit(null, user.id, 'drill_step_feedback_sent', 'drill_step_responses', r.id);
    return r;
  },
});

// ── Athlete: read own responses with coach feedback ────────────────────────

cap({
  name: 'my_drill_step_responses', method: 'GET', path: '/me/drill-step-responses', tag: TAG, auth: 'user',
  summary: 'All drill step responses the athlete has submitted, with any coach feedback attached. Text is decrypted.',
  input: z.object({ session_id: id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).default(0) }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT r.id, r.session_record_id, r.template_id, r.step_index, r.audio_media_id, r.response_text_enc, r.feedback_text_enc, r.feedback_audio_id, r.feedback_rating, r.feedback_at, r.submitted_at,
              t.title AS drill_title
       FROM drill_step_responses r
       JOIN coach_templates t ON t.id=r.template_id
       WHERE r.athlete_id=$1 AND r.archived_at IS NULL
         AND ($2::uuid IS NULL OR r.session_record_id=$2)
       ORDER BY r.submitted_at DESC
       LIMIT $3 OFFSET $4`,
      [user.id, i.session_id ?? null, i.limit, i.offset]);
    await audit(null, user.id, 'my_drill_step_responses_read', 'users', user.id);
    return rows.map((r) => ({
      ...r,
      response_text: r.response_text_enc ? decrypt(r.response_text_enc, 'drill_step_responses.response_text_enc') : null,
      feedback_text: r.feedback_text_enc ? decrypt(r.feedback_text_enc, 'drill_step_responses.feedback_text_enc') : null,
      response_text_enc: undefined,
      feedback_text_enc: undefined,
      audio_file_url: r.audio_media_id ? `/api/v1/coaching/drills/${r.template_id}/media/${r.audio_media_id}/file` : null,
      feedback_audio_file_url: r.feedback_audio_id ? `/api/v1/coaching/drills/${r.template_id}/media/${r.feedback_audio_id}/file` : null,
    }));
  },
});

// ── Binary router: upload athlete voice response as audio ─────────────────
// PUT /coaching/sessions/:id/drills/:drillId/steps/:stepIndex/response-audio
// The resulting drill_media row is then referenced via submit_drill_step_response.

export function drillResponseAudioRouter() {
  const r = express.Router();
  const fail = (res, e) => res.status(e.statusCode ?? e.status ?? 500).json({ error: { code: e.code ?? 'error', message: e.message } });

  r.put(
    '/coaching/sessions/:sessionId/drills/:drillId/steps/:stepIndex/response-audio',
    rateLimit({ windowMs: 60_000, limit: config.isProd ? 20 : 1000, standardHeaders: true, legacyHeaders: false }),
    async (req, res) => {
      try {
        const { createWriteStream } = await import('node:fs');
        const { mkdir, rm, readFile } = await import('node:fs/promises');
        const { createHash, randomUUID } = await import('node:crypto');
        const { dirname, join, resolve } = await import('node:path');
        const { Transform } = await import('node:stream');
        const { pipeline } = await import('node:stream/promises');

        const user = await authenticate(req.headers.authorization);
        if (!user) throw unauthorized();

        const { sessionId, drillId, stepIndex } = req.params;
        if (!/^[0-9a-f-]{36}$/.test(sessionId) || !/^[0-9a-f-]{36}$/.test(drillId)) throw notFound('Session');
        const inSession = await requireAthleteInSession(user.id, sessionId);
        if (!inSession) throw forbidden('You are not in this session');

        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > AUDIO_LIMIT) throw new AppError(413, 'too_large', 'Voice responses can be up to 10 MB');

        const root = resolve(config.mediaDir);
        const tmp = join(root, 'tmp', `${randomUUID()}.part`);
        await mkdir(dirname(tmp), { recursive: true });

        const hash = createHash('sha256');
        let size = 0, head = Buffer.alloc(0);
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > AUDIO_LIMIT) return cb(new AppError(413, 'too_large', 'Voice response too large'));
            if (head.length < 32) head = Buffer.concat([head, chunk]).subarray(0, 32);
            hash.update(chunk); cb(null, chunk);
          },
        });
        try { await pipeline(req, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o640 })); }
        catch (e) { await rm(tmp, { force: true }); throw e; }
        if (!size) { await rm(tmp, { force: true }); throw badRequest('Empty upload'); }

        const t = sniffAudio(head);
        if (!t) { await rm(tmp, { force: true }); throw badRequest('Upload MP3, M4A, WAV, OGG or WebM audio files only.'); }

        const raw = await readFile(tmp);
        await rm(tmp, { force: true });
        const { file } = await saveEncrypted(FOLDER, 'drill_media.file_name', raw);

        const row = await one(
          'INSERT INTO drill_media(template_id,uploaded_by,kind,content_type,file_name,size_bytes,sha256,original_name) VALUES($1,$2,\'audio\',$3,$4,$5,$6,$7) RETURNING id,kind,content_type,size_bytes,created_at',
          [drillId, user.id, t.type, file, size, hash.digest('hex'), 'response-audio.' + t.ext]);
        res.status(201).json({ ...row, size_bytes: Number(row.size_bytes), file_url: `/api/v1/coaching/drills/${drillId}/media/${row.id}/file` });
      } catch (e) { fail(res, e); }
    },
  );

  return r;
}
