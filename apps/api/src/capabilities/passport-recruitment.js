import express from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page, money } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { one, many } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit } from '../helpers.js';
import { encrypt } from '../crypto.js';
import { requireApproved } from '../access.js';
import { requireConsent } from '../youth.js';
import { RELATIONSHIP_SQL } from '../coaching.js';
import { DOC_LIMITS, docHeaders, loadEncrypted, readBody, saveEncrypted, sniffDoc } from '../doc-store.js';
import { sniff } from '../media.js';
import { sha256 } from '../crypto.js';
import { coachesAthlete, openLink, videoEmbed, withEmbed } from '../passport-sections.js';

// Recruitment evidence behind the player passport (issue #312). The athlete owns every row; coaches approve videos and write references;
// nothing reaches a recipient until the right person approved it. Files are encrypted on disk and never deleted - removing only hides.
const TAG = 'Passport';
const STALE = { code: 'stale_version' };
const VIDEO_BYTES = 50 * 2 ** 20; // uploaded clips: separate from the 10 MB document limit

const sportId = async (slug) => {
  if (!slug) return null;
  const s = await one('SELECT id FROM sports WHERE slug=$1', [slug]);
  if (!s) throw notFound('Sport');
  return s.id;
};
const stale = () => conflict('This was changed elsewhere; reload and try again', STALE);

// ───── video ─────
const VIDEO_COLS = 'v.id, v.title, s.slug AS sport_slug, v.link_url, (v.file_name IS NOT NULL) AS has_file, v.content_type, v.size_bytes, v.status, v.review_note, v.reviewed_at, v.version, v.created_at';

cap({
  name: 'list_my_passport_videos', method: 'GET', path: '/me/passport-videos', tag: TAG,
  summary: 'Your recruitment videos and where each is in approval (pending, approved or rejected). Only approved videos can appear on a shared passport. Upload a clip with PUT /me/passport-videos/upload?title= (raw MP4, MOV or WebM, up to 50 MB) or add a YouTube or Vimeo link.',
  input: z.object({ ...page }),
  handler: async ({ user }, i) => (await many(`SELECT ${VIDEO_COLS} FROM passport_videos v LEFT JOIN sports s ON s.id=v.sport_id WHERE v.user_id=$1 AND v.removed_at IS NULL ORDER BY v.created_at DESC, v.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset])).map(withEmbed),
});

cap({
  name: 'add_passport_video_link', method: 'POST', path: '/me/passport-videos', tag: TAG, status: 201,
  summary: 'Add a recruitment video by YouTube or Vimeo link (it plays inside the app). It stays pending until a coach who coaches you approves it.',
  input: z.object({ title: z.string().trim().min(1).max(120), link_url: z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'Use an https link').refine((u) => !!videoEmbed(u), 'Use a YouTube or Vimeo video link'), sport_slug: z.string().max(60).optional() }),
  async handler({ user }, i) {
    return one(`INSERT INTO passport_videos(user_id, sport_id, title, link_url) VALUES ($1,$2,$3,$4) RETURNING id, title, link_url, status, version, created_at`, [user.id, await sportId(i.sport_slug), i.title, i.link_url]).then(withEmbed);
  },
});

cap({
  name: 'remove_passport_video', method: 'DELETE', path: '/me/passport-videos/:id', tag: TAG,
  summary: 'Take a video off your passport. The record and any file are kept (never deleted) but nobody can open it.', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE passport_videos SET removed_at=coalesce(removed_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id, removed_at', [i.id, user.id]);
    if (!r) throw notFound('Video');
    return r;
  },
});

cap({
  name: 'list_passport_video_reviews', method: 'GET', path: '/coach/passport-videos', tag: TAG, auth: ['coach'],
  summary: 'Pending recruitment videos from athletes you coach (teammates you coach or people you have a hire, cohort or plan with), oldest first, for you to approve or reject.',
  input: z.object({ ...page }),
  handler: async ({ user }, i) => (await many(
    `SELECT v.id, v.title, s.slug AS sport_slug, v.link_url, (v.file_name IS NOT NULL) AS has_file, v.version, v.created_at, u.id AS athlete_id, u.display_name AS athlete_name, u.handle AS athlete_handle
       FROM passport_videos v JOIN users u ON u.id=v.user_id LEFT JOIN sports s ON s.id=v.sport_id
      WHERE v.status='pending' AND v.removed_at IS NULL AND (
            EXISTS (SELECT 1 FROM team_members a JOIN team_members c ON c.team_id=a.team_id WHERE a.user_id=v.user_id AND c.user_id=$1 AND a.status='active' AND c.status='active' AND c.role IN ('coach','manager'))
         OR EXISTS (SELECT 1 FROM (${RELATIONSHIP_SQL}) r WHERE r.coach_id=$1 AND r.athlete_id=v.user_id))
      ORDER BY v.created_at, v.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset])).map(withEmbed),
});

cap({
  name: 'review_passport_video', method: 'POST', path: '/passport-videos/:id/review', tag: TAG, auth: ['coach'],
  summary: 'Approve or reject a pending recruitment video of an athlete you coach. Approving says the clip shows this athlete and is fair to share. Send the version you saw; a stale one is refused.',
  input: z.object({ id, version: z.number().int().min(1), decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    const v = await one('SELECT user_id FROM passport_videos WHERE id=$1 AND removed_at IS NULL', [i.id]);
    if (!v || !(await coachesAthlete(user.id, v.user_id))) throw notFound('Video');
    const r = await one(`UPDATE passport_videos SET status=$3, reviewed_by=$4, reviewed_at=now(), review_note=$5, version=version+1
                          WHERE id=$1 AND version=$2 AND status='pending' AND removed_at IS NULL RETURNING id, status, reviewed_at, version`, [i.id, i.version, i.decision, user.id, i.note || null]);
    if (!r) throw stale();
    await audit(null, user.id, `passport_video_${i.decision}`, 'passport_videos', i.id);
    return r;
  },
});

// ───── coach references ─────
const REF_COLS = 'r.id, r.body, s.slug AS sport_slug, r.status, r.version, r.created_at, r.decided_at, u.display_name AS coach_name, u.handle AS coach_handle';

cap({
  name: 'write_passport_reference', method: 'POST', path: '/athletes/:athlete_id/passport-references', tag: TAG, auth: ['coach'], status: 201,
  summary: 'Write a recruitment reference for an athlete you coach. It is shown to the athlete first; it can appear on a shared passport only after they approve it. For a young athlete a guardian\'s recruitment_sharing consent is needed.',
  input: z.object({ athlete_id: id, body: z.string().trim().min(20).max(1500), sport_slug: z.string().max(60).optional() }),
  async handler({ user }, i) {
    if (i.athlete_id === user.id || !(await coachesAthlete(user.id, i.athlete_id))) throw forbidden('You can write references for athletes you coach');
    await requireConsent(i.athlete_id, 'recruitment_sharing', 'a recruitment reference');
    return one(`INSERT INTO passport_references(user_id, coach_id, sport_id, body) VALUES ($1,$2,$3,$4) RETURNING id, status, version, created_at`, [i.athlete_id, user.id, await sportId(i.sport_slug), i.body]);
  },
});

cap({
  name: 'list_my_passport_references', method: 'GET', path: '/me/passport-references', tag: TAG,
  summary: 'Coach references written about you, with the ones waiting for your approval first.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(`SELECT ${REF_COLS} FROM passport_references r JOIN users u ON u.id=r.coach_id LEFT JOIN sports s ON s.id=r.sport_id WHERE r.user_id=$1 AND r.removed_at IS NULL
    ORDER BY (r.status='pending_athlete') DESC, r.created_at DESC, r.id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'decide_passport_reference', method: 'POST', path: '/me/passport-references/:id/decision', tag: TAG,
  summary: 'Approve (it can then be shared) or decline a coach reference written about you. Send the version you saw.',
  input: z.object({ id, version: z.number().int().min(1), decision: z.enum(['approved', 'declined']) }),
  async handler({ user }, i) {
    const r = await one(`UPDATE passport_references SET status=$4, decided_at=now(), version=version+1 WHERE id=$1 AND user_id=$2 AND version=$3 AND status='pending_athlete' AND removed_at IS NULL RETURNING id, status, decided_at, version`, [i.id, user.id, i.version, i.decision]);
    if (!r) throw stale();
    return r;
  },
});

cap({
  name: 'withdraw_passport_reference', method: 'DELETE', path: '/passport-references/:id', tag: TAG,
  summary: 'Take a reference off the passport: the athlete it is about, or the coach who wrote it. It is hidden at once, never deleted.', input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE passport_references SET removed_at=coalesce(removed_at, now()) WHERE id=$1 AND (user_id=$2 OR coach_id=$2) RETURNING id, removed_at', [i.id, user.id]);
    if (!r) throw notFound('Reference');
    return r;
  },
});

// ───── preferences & availability ─────
const OPEN_TO = ['scholarship', 'trial', 'academy', 'club', 'college', 'relocation'];

cap({
  name: 'get_my_recruitment_preferences', method: 'GET', path: '/me/recruitment-preferences', tag: TAG,
  summary: 'What you are looking for: sports, levels, regions, kinds of opportunity and whether recruiters may contact you. Empty until you set it.',
  async handler({ user }) {
    return (await one('SELECT sport_slugs, levels, regions, open_to, open_to_contact, notes, budget_cents::float8 AS budget_cents, budget_currency, version FROM recruitment_preferences WHERE user_id=$1', [user.id]))
      ?? { sport_slugs: [], levels: [], regions: [], open_to: [], open_to_contact: false, notes: null, budget_cents: null, budget_currency: null, version: 0 };
  },
});

cap({
  name: 'set_my_recruitment_preferences', method: 'POST', path: '/me/recruitment-preferences', tag: TAG,
  summary: 'Save your recruitment preferences. Send the version you last saw (0 the first time); a stale version is refused (409).',
  input: z.object({ version: z.number().int().min(0), sport_slugs: z.array(z.string().max(60)).max(10), levels: z.array(z.string().max(30)).max(8), regions: z.array(z.string().max(80)).max(20),
    open_to: z.array(z.enum(OPEN_TO)).max(6), open_to_contact: z.boolean(), notes: z.string().trim().max(500).optional(),
    budget_cents: money.nullable().optional().describe('the most you can pay for one opportunity, in minor units; leave out to keep what you saved, null to clear'), budget_currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional() })
    .refine((v) => (v.budget_cents === undefined) === (v.budget_currency === undefined) && (v.budget_cents == null) === (v.budget_currency == null), { message: 'Give the budget amount together with its currency (or both null to clear it)', path: ['budget_currency'] }),
  async handler({ user }, i) {
    const setBudget = i.budget_cents !== undefined; // left out = keep what is saved
    const vals = [user.id, i.sport_slugs, i.levels, i.regions, i.open_to, i.open_to_contact, i.notes || null, setBudget, i.budget_cents ?? null, i.budget_currency ?? null];
    const COLS = 'sport_slugs, levels, regions, open_to, open_to_contact, notes, budget_cents::float8 AS budget_cents, budget_currency, version';
    const row = i.version === 0
      ? await one(`INSERT INTO recruitment_preferences(user_id, sport_slugs, levels, regions, open_to, open_to_contact, notes, budget_cents, budget_currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id) DO NOTHING
                   RETURNING ${COLS}`, [user.id, i.sport_slugs, i.levels, i.regions, i.open_to, i.open_to_contact, i.notes || null, i.budget_cents ?? null, i.budget_currency ?? null])
      : await one(`UPDATE recruitment_preferences SET sport_slugs=$2, levels=$3, regions=$4, open_to=$5, open_to_contact=$6, notes=$7, budget_cents=CASE WHEN $8::boolean THEN $9::bigint ELSE budget_cents END, budget_currency=CASE WHEN $8::boolean THEN $10::text ELSE budget_currency END, version=version+1, updated_at=now()
                    WHERE user_id=$1 AND version=$11 RETURNING ${COLS}`, [...vals, i.version]);
    if (!row) throw stale();
    return row;
  },
});

cap({
  name: 'list_my_recruitment_availability', method: 'GET', path: '/me/recruitment-availability', tag: TAG,
  summary: 'Your upcoming windows for trials, visits and start dates, soonest first.', input: z.object({ ...page }),
  handler: ({ user }, i) => many(`SELECT id, kind, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date, weekdays, to_char(from_time,'HH24:MI') AS from_time, to_char(to_time,'HH24:MI') AS to_time, note
    FROM recruitment_availability WHERE user_id=$1 AND removed_at IS NULL AND to_date >= current_date ORDER BY from_date, id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
cap({
  name: 'add_recruitment_availability', method: 'POST', path: '/me/recruitment-availability', tag: TAG, status: 201,
  summary: 'Add a window when you can attend a trial, make a visit or start. Optional weekdays (0 = Sunday) and a time range narrow it.',
  input: z.object({ kind: z.enum(['trial', 'visit', 'start']), from_date: DATE, to_date: DATE, weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]), from_time: TIME.optional(), to_time: TIME.optional(), note: z.string().trim().max(200).optional() })
    .refine((v) => v.to_date >= v.from_date, { message: 'The end date is before the start date', path: ['to_date'] })
    .refine((v) => (!v.from_time && !v.to_time) || (v.from_time && v.to_time && v.to_time > v.from_time), { message: 'Give a start and an end time, end after start', path: ['to_time'] }),
  async handler({ user }, i) {
    return one(`INSERT INTO recruitment_availability(user_id, kind, from_date, to_date, weekdays, from_time, to_time, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                RETURNING id, kind, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date, weekdays, note`, [user.id, i.kind, i.from_date, i.to_date, [...new Set(i.weekdays)].sort(), i.from_time ?? null, i.to_time ?? null, i.note || null]);
  },
});

cap({
  name: 'remove_recruitment_availability', method: 'DELETE', path: '/me/recruitment-availability/:id', tag: TAG, input: z.object({ id }),
  summary: 'Remove an availability window (hidden, not deleted).',
  async handler({ user }, i) {
    const r = await one('UPDATE recruitment_availability SET removed_at=coalesce(removed_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id, removed_at', [i.id, user.id]);
    if (!r) throw notFound('Availability');
    return r;
  },
});

// ───── academic evidence ─────
const ACADEMIC_COLS = 'id, kind, institution, to_char(period_from,\'YYYY-MM-DD\') AS period_from, to_char(period_to,\'YYYY-MM-DD\') AS period_to, (file_name IS NOT NULL) AS has_file, provenance, version, created_at';

cap({
  name: 'list_my_academic_evidence', method: 'GET', path: '/me/academic-evidence', tag: TAG,
  summary: 'Your optional academic evidence (transcripts, certificates, reports, test scores). Add a file with PUT /me/academic-evidence/{id}/file (PDF or photo, up to 10 MB). Entries you add are labelled self_reported: the passport never presents them as verified.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(`SELECT ${ACADEMIC_COLS} FROM academic_evidence WHERE user_id=$1 AND removed_at IS NULL ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'add_academic_evidence', method: 'POST', path: '/me/academic-evidence', tag: TAG, status: 201,
  summary: 'Add an academic item. The summary is stored encrypted and every read by someone else is audit-logged.',
  input: z.object({ kind: z.enum(['transcript', 'certificate', 'report', 'test_score', 'other']), institution: z.string().trim().min(1).max(120), period_from: DATE.optional(), period_to: DATE.optional(), summary: z.string().trim().max(500).optional() })
    .refine((v) => !v.period_from || !v.period_to || v.period_to >= v.period_from, { message: 'The end date is before the start date', path: ['period_to'] }),
  async handler({ user }, i) {
    return one(`INSERT INTO academic_evidence(user_id, kind, institution, period_from, period_to, summary_enc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${ACADEMIC_COLS}`,
      [user.id, i.kind, i.institution, i.period_from ?? null, i.period_to ?? null, i.summary ? encrypt(i.summary, 'academic_evidence.summary') : null]);
  },
});

cap({
  name: 'remove_academic_evidence', method: 'DELETE', path: '/me/academic-evidence/:id', tag: TAG, input: z.object({ id }),
  summary: 'Take an academic item off your passport (hidden at once; the record and file are kept).',
  async handler({ user }, i) {
    const r = await one('UPDATE academic_evidence SET removed_at=coalesce(removed_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id, removed_at', [i.id, user.id]);
    if (!r) throw notFound('Academic item');
    return r;
  },
});

// ───── binary routes: uploads and file reads, with the same live checks as the capabilities ─────
export function passportFilesRouter() {
  const r = express.Router();
  const fail = (res, e) => { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); };
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 40 : 1000, standardHeaders: true, legacyHeaders: false });
  const uuid = (v, what) => { if (!/^[0-9a-f-]{36}$/.test(v)) throw notFound(what); return v; };
  const who = async (req) => { const u = await authenticate(req.headers.authorization); if (!u) throw unauthorized(); return u; };
  const send = (res, type, bytes) => { res.set(docHeaders(type, bytes)); res.end(bytes); };
  const read = async (folder, ctx, file) => { try { return await loadEncrypted(folder, ctx, file); } catch (e) { throw e.code === 'ENOENT' ? notFound('File') : e; } };
  const body = async (req) => {
    if (Number(req.headers['content-length'] ?? 0) > DOC_LIMITS.bytes) throw new AppError(413, 'too_large', `Files can be up to ${DOC_LIMITS.bytes / 2 ** 20} MB`);
    const buf = await readBody(req);
    if (!buf.length) throw badRequest('Empty upload');
    return buf;
  };

  // PUT /api/v1/me/passport-videos/upload?title=&sport_slug=   body = the raw clip (up to 50 MB)
  r.put('/me/passport-videos/upload', limiter, async (req, res) => {
    try {
      const user = await who(req); requireApproved(user);
      const title = String(req.query.title ?? '').trim().slice(0, 120);
      if (!title) throw badRequest('Give the video a title');
      const tooBig = () => new AppError(413, 'too_large', `Clips can be up to ${VIDEO_BYTES / 2 ** 20} MB; add a YouTube or Vimeo link for longer ones`);
      if (Number(req.headers['content-length'] ?? 0) > VIDEO_BYTES) throw tooBig();
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > VIDEO_BYTES) throw tooBig(); chunks.push(chunk); }
      const buf = Buffer.concat(chunks);
      if (!buf.length) throw badRequest('Empty upload');
      const t = sniff(buf);
      if (!t || t.kind !== 'video') throw badRequest('Unsupported file. Use an MP4, MOV or WebM video.');
      if ((await one('SELECT count(*)::int AS n FROM passport_videos WHERE user_id=$1 AND removed_at IS NULL', [user.id])).n >= 10) throw badRequest('You can keep up to 10 videos; remove one first');
      const { id: vid, file } = await saveEncrypted('passport', 'passport_videos.file', buf);
      const row = await one(`INSERT INTO passport_videos(id, user_id, sport_id, title, file_name, content_type, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, title, status, version, created_at`,
        [vid, user.id, await sportId(req.query.sport_slug ? String(req.query.sport_slug) : null), title, file, t.type, buf.length, createHash('sha256').update(buf).digest('hex')]);
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  // owner, or a coach who coaches the athlete (to review it before approving)
  r.get('/passport-videos/:id/file', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const v = await one('SELECT * FROM passport_videos WHERE id=$1 AND removed_at IS NULL AND file_name IS NOT NULL', [uuid(req.params.id, 'Video')]);
      if (!v || (v.user_id !== user.id && !(await coachesAthlete(user.id, v.user_id)))) throw notFound('Video');
      if (v.user_id !== user.id) await audit(null, user.id, 'read_passport_video', 'passport_videos', v.id);
      send(res, v.content_type, await read('passport', 'passport_videos.file', v.file_name));
    } catch (e) { fail(res, e); }
  });

  // PUT /api/v1/me/academic-evidence/:id/file   body = the raw PDF or photo
  r.put('/me/academic-evidence/:id/file', limiter, async (req, res) => {
    try {
      const user = await who(req); requireApproved(user);
      const a = await one('SELECT id, version FROM academic_evidence WHERE id=$1 AND user_id=$2 AND removed_at IS NULL', [uuid(req.params.id, 'Academic item'), user.id]);
      if (!a) throw notFound('Academic item');
      const buf = await body(req);
      const t = sniffDoc(buf);
      if (!t) throw badRequest('Unsupported file. Use a PDF or a JPEG, PNG or WebP photo.');
      const { file } = await saveEncrypted('passport', 'academic_evidence.file', buf);
      const row = await one(`UPDATE academic_evidence SET file_name=$2, content_type=$3, size_bytes=$4, sha256=$5, version=version+1 WHERE id=$1 AND version=$6 RETURNING ${ACADEMIC_COLS}`,
        [a.id, file, t.type, buf.length, createHash('sha256').update(buf).digest('hex'), a.version]);
      if (!row) throw stale();
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  r.get('/academic-evidence/:id/file', limiter, async (req, res) => {
    try {
      const user = await who(req);
      const a = await one('SELECT * FROM academic_evidence WHERE id=$1 AND user_id=$2 AND removed_at IS NULL AND file_name IS NOT NULL', [uuid(req.params.id, 'Academic item'), user.id]);
      if (!a) throw notFound('Academic item');
      send(res, a.content_type, await read('passport', 'academic_evidence.file', a.file_name));
    } catch (e) { fail(res, e); }
  });

  // through a share link: the same gate as opening the passport (live revoke, expiry, recipient, consent) AND the section must be on
  const shared = (kind, column, ctx, label) => r.get(`/passport/:token/${kind}/:fid`, limiter, async (req, res) => {
    try {
      const viewer = await authenticate(req.headers.authorization);
      const link = await openLink(sha256(String(req.params.token)), viewer, kind === 'video' ? 'video' : 'academic');
      if (!link[kind === 'video' ? 'show_video' : 'show_academic']) throw notFound(label);
      const f = await one(kind === 'video'
        ? `SELECT id, file_name, content_type FROM passport_videos WHERE id=$1 AND user_id=$2 AND status='approved' AND removed_at IS NULL AND file_name IS NOT NULL`
        : `SELECT id, file_name, content_type FROM academic_evidence WHERE id=$1 AND user_id=$2 AND removed_at IS NULL AND file_name IS NOT NULL`, [uuid(req.params.fid, label), link.user_id]);
      if (!f) throw notFound(label);
      if (viewer?.id !== link.user_id) await audit(null, viewer?.id ?? null, `read_passport_${kind}`, column, f.id);
      send(res, f.content_type, await read('passport', ctx, f.file_name));
    } catch (e) { fail(res, e); }
  });
  shared('video', 'passport_videos', 'passport_videos.file', 'Video');
  shared('academic', 'academic_evidence', 'academic_evidence.file', 'Academic item');
  return r;
}
