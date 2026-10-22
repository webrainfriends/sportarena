import express from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { one, many } from '../db.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit } from '../helpers.js';
import { requireApproved } from '../access.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted } from '../doc-store.js';
import { sniff } from '../media.js';
import { requireRelationship } from '../coaching.js';
import { requireTeam } from './coaching-journal.js';
import { canReadObservation } from '../coaching-observation-access.js';

// Evidence on a coaching observation (issue #269): a photo, a short video or a PDF, kept encrypted and shown to exactly the people who
// may read the note - nobody else. Access is re-derived on every request from the note's current visibility, the coach's authority
// and, for a young person, the guardian's coaching consent. Files are never deleted; removing only hides.
const TAG = 'Coaching journal';
const COACH = ['coach'];
const PER_OBSERVATION = 10;
const COLS = 'e.id, e.observation_id, e.kind, e.content_type, e.title, e.size_bytes, e.uploaded_by, e.created_at';

/** Photo, video or PDF - decided from the bytes, never from what the client says. */
function sniffEvidence(b) {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'document', type: 'application/pdf' };
  const t = sniff(b);
  return t ? { kind: t.kind, type: t.type } : null;
}

const observationFor = (oid) => one('SELECT id, coach_id, athlete_id, team_id, visibility FROM coaching_observations WHERE id=$1', [oid]);

cap({
  name: 'list_coaching_evidence', method: 'GET', path: '/coaching/observations/:id/evidence', tag: TAG, auth: 'user',
  summary: 'Files attached to a coaching note, if you may read that note. Upload with PUT /coaching/observations/{id}/evidence (the raw file as the body; query: title) and download with GET /coaching/evidence/{id}/file.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const o = await observationFor(i.id);
    if (!o || !(await canReadObservation(user, o))) throw notFound('Observation');
    return many(`SELECT ${COLS} FROM coaching_evidence e WHERE e.observation_id=$1 AND e.removed_at IS NULL ORDER BY e.created_at, e.id`, [o.id]);
  },
});

cap({
  name: 'remove_coaching_evidence', method: 'DELETE', path: '/coaching/evidence/:id', tag: TAG, auth: COACH,
  summary: 'Hide a file you attached to your own note. The file is kept (never deleted) but nobody can open it any more.', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE coaching_evidence e SET removed_at=coalesce(removed_at, now()) FROM coaching_observations o WHERE e.id=$1 AND o.id=e.observation_id AND o.coach_id=$2 RETURNING e.id, e.removed_at', [i.id, user.id]);
    if (!r) throw notFound('Evidence');
    return r;
  },
});

cap({
  name: 'get_coaching_capture_options', method: 'GET', path: '/coaching/capture-options', tag: TAG, auth: COACH,
  summary: 'What the capture tools can do on this server: evidence file types and limits, and whether voice notes can be turned into text. Voice-to-text is only available when the platform has a speech-to-text bridge configured.',
  handler: () => ({
    evidence: { types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm', 'application/pdf'], max_bytes: DOC_LIMITS.bytes, per_note: PER_OBSERVATION },
    voice_note: config.transcribe.url ? { available: true, max_bytes: 5 * 2 ** 20, note: 'The audio is sent to the configured speech-to-text service for this request only, is not stored, and you review the text before saving.' } : { available: false, reason: 'No speech-to-text service is configured on this server. Type the note instead.' },
  }),
});

/** Binary routes: raw evidence upload/download and the voice-to-text bridge. Same auth and the same live access checks as the capabilities. */
export function coachingEvidenceRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 40 : 1000, standardHeaders: true, legacyHeaders: false });
  const who = async (req) => { const u = await authenticate(req.headers.authorization); if (!u) throw unauthorized(); return u; };
  const uuid = (v, what) => { if (!/^[0-9a-f-]{36}$/.test(v)) throw notFound(what); return v; };

  // PUT /api/v1/coaching/observations/:id/evidence?title=   body = the raw file
  r.put('/coaching/observations/:id/evidence', limiter, async (req, res) => {
    try {
      const user = await who(req); requireApproved(user);
      const o = await observationFor(uuid(req.params.id, 'Observation'));
      if (!o || o.coach_id !== user.id) throw notFound('Observation');
      if (o.athlete_id) await requireRelationship(user, o.athlete_id); else await requireTeam(user, o.team_id);
      if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', `Files can be up to ${DOC_LIMITS.bytes / 2 ** 20} MB`);
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniffEvidence(buf);
      if (!t) throw badRequest('Unsupported file. Use a JPEG, PNG, WebP or GIF photo, an MP4, MOV or WebM video, or a PDF.');
      if ((await one('SELECT count(*)::int AS n FROM coaching_evidence WHERE observation_id=$1 AND removed_at IS NULL', [o.id])).n >= PER_OBSERVATION) throw badRequest(`A note can have up to ${PER_OBSERVATION} files`);
      const { id: eid, file } = await saveEncrypted('coaching', 'coaching_evidence.file', buf);
      const title = String(req.query.title ?? '').slice(0, 120) || null;
      const row = await one(
        `INSERT INTO coaching_evidence(id, observation_id, uploaded_by, kind, content_type, file_name, title, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, observation_id, kind, content_type, title, size_bytes, created_at`, [eid, o.id, user.id, t.kind, t.type, file, title, buf.length, createHash('sha256').update(buf).digest('hex')]);
      await audit(null, user.id, 'upload_coaching_evidence', 'coaching_evidence', eid);
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  r.get('/coaching/evidence/:id/file', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const e = await one('SELECT * FROM coaching_evidence WHERE id=$1 AND removed_at IS NULL', [uuid(req.params.id, 'Evidence')]);
      const o = e && (await observationFor(e.observation_id));
      if (!e || !(await canReadObservation(user, o))) throw notFound('Evidence');
      const bytes = await loadEncrypted('coaching', 'coaching_evidence.file', e.file_name);
      if (o.coach_id !== user.id) await audit(null, user.id, 'read_coaching_evidence', 'coaching_evidence', e.id);
      res.set(docHeaders(e.content_type, bytes));
      res.end(bytes);
    } catch (e) { fail(res, e.code === 'ENOENT' ? notFound('Evidence') : e); }
  });

  // POST /api/v1/coaching/voice-note   body = raw audio. Returns a TRANSCRIPT TO REVIEW; nothing is saved here.
  r.post('/coaching/voice-note', limiter, async (req, res) => {
    try {
      const user = await who(req); requireApproved(user);
      if (!user.roles.includes('coach')) throw forbidden('Only coaches can use voice notes');
      if (!config.transcribe.url) throw new AppError(501, 'not_available', 'Voice-to-text is not set up on this server. Type the note instead.');
      const buf = await readBody(req);
      if (!buf.length) throw badRequest('Empty recording');
      if (buf.length > 5 * 2 ** 20) throw new AppError(413, 'too_large', 'Recordings can be up to 5 MB');
      let out;
      try {
        const resp = await fetch(config.transcribe.url, { method: 'POST', signal: AbortSignal.timeout(25_000), headers: { 'content-type': String(req.headers['content-type'] ?? 'application/octet-stream'), ...(config.transcribe.secret ? { authorization: `Bearer ${config.transcribe.secret}` } : {}) }, body: buf });
        if (!resp.ok) throw new Error(String(resp.status));
        out = await resp.json();
      } catch { throw new AppError(502, 'transcription_failed', 'The recording could not be turned into text. Type the note instead.'); }
      const textOut = String(out?.text ?? '').trim().slice(0, 2000);
      if (!textOut) throw new AppError(422, 'nothing_heard', 'No speech was found in the recording.');
      await audit(null, user.id, 'coaching_voice_note', 'users', user.id);
      res.json({ transcript: textOut, saved: false, note: 'Review and edit this text, then save it as a note.' });
    } catch (e) { fail(res, e); }
  });
  return r;
}
