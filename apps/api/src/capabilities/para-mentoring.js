// PS-25 Para-athlete peer mentoring (#855): mentor profiles, mentorship lifecycle, session scheduling, feedback, moderation.
// Security invariants:
//   - bio_enc / goal_enc / notes_enc encrypted at rest; decryption audit-logged
//   - FORBIDDEN_TERMS blocks medical language from all public-facing text fields
//   - goal visible only to the mentee who wrote it; feedback visible only to its author
//   - Classification outcome data is NEVER read or surfaced here
//   - Youth: requireConsent for 'contact', guardiansOf notified and their reads audit-logged
//   - blockedBetween checked on every request and session creation
//   - Consent revoked → mentorship ended immediately; blocked party cannot request mentoring
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { requireConsent, guardiansOf, isYouth } from '../youth.js';
import { blockedBetween } from '../communities.js';

const TAG = 'Para mentoring';
const t = (n) => z.string().trim().max(n);

// Medical / classification language is never allowed in public mentor profiles or stated goals
const FORBIDDEN_TERMS = /\b(diagnosis|diagnos|impairment|impaired|condition|disability|classification|class\b|disorder|disability|syndrome)\b/i;
const guardForbidden = (text, field) => { if (text && FORBIDDEN_TERMS.test(text)) throw badRequest(`${field} must not include medical or classification language`); };

const BIO_CTX   = 'para_mentor_profiles.bio_enc';
const GOAL_CTX  = 'para_mentorships.goal_enc';
const TITLE_CTX = 'para_mentorship_sessions.title_enc';
const NOTES_CTX = 'para_mentorship_sessions.notes_enc';
const FB_CTX    = 'para_mentorship_feedback.body_enc';

// ---------- mentor profile shape
const profileRow = async (c, row, { self = false } = {}) => {
  const bio = row.bio_enc ? decrypt(row.bio_enc, BIO_CTX) : null;
  if (self || bio) await audit(c, row.athlete_id, 'para_mentor_profile.bio.read', 'para_mentor_profiles', row.id);
  return {
    id: row.id, athlete_id: row.athlete_id, athlete_name: row.athlete_name ?? undefined,
    bio: self ? bio : undefined,
    sports: row.sports, disciplines: row.disciplines, peer_years: row.peer_years,
    comm_formats: row.comm_formats, availability: row.availability, languages: row.languages,
    accepting: row.accepting, listed: row.listed, created_at: row.created_at, updated_at: row.updated_at,
  };
};

cap({
  name: 'upsert_para_mentor_profile', method: 'POST', path: '/para/mentors/me', tag: TAG, status: 200,
  summary: 'Create or update your para-mentor profile (sport experience, communication formats, availability). Bio must not include medical or classification language.',
  input: z.object({
    bio: t(500).optional().describe('Your para-sport background — no diagnoses or classifications'),
    sports: z.array(z.string().max(60)).max(10).optional(),
    disciplines: z.array(z.string().max(60)).max(20).optional(),
    peer_years: z.number().int().min(0).max(60).optional(),
    comm_formats: z.array(z.enum(['video','phone','in_person','async_message','bsl','auslan','makaton'])).max(7).optional(),
    availability: t(100).optional(),
    languages: z.array(z.string().max(10)).max(10).optional(),
    accepting: z.boolean().optional(),
    listed: z.boolean().optional(),
  }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    guardForbidden(i.bio, 'Bio');
    if (i.disciplines) for (const d of i.disciplines) guardForbidden(d, 'Discipline');
    const bio_enc = i.bio !== undefined ? (i.bio ? encrypt(i.bio, BIO_CTX) : null) : undefined;
    await c.query(
      `INSERT INTO para_mentor_profiles (athlete_id, bio_enc, sports, disciplines, peer_years, comm_formats, availability, languages, accepting, listed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (athlete_id) DO UPDATE SET
         bio_enc       = COALESCE($2, para_mentor_profiles.bio_enc),
         sports        = COALESCE($3, para_mentor_profiles.sports),
         disciplines   = COALESCE($4, para_mentor_profiles.disciplines),
         peer_years    = COALESCE($5, para_mentor_profiles.peer_years),
         comm_formats  = COALESCE($6, para_mentor_profiles.comm_formats),
         availability  = COALESCE($7, para_mentor_profiles.availability),
         languages     = COALESCE($8, para_mentor_profiles.languages),
         accepting     = COALESCE($9, para_mentor_profiles.accepting),
         listed        = COALESCE($10, para_mentor_profiles.listed),
         updated_at    = now()`,
      [user.id, bio_enc ?? null, i.sports ?? null, i.disciplines ?? null, i.peer_years ?? null,
        i.comm_formats ?? null, i.availability ?? null, i.languages ?? null, i.accepting ?? null, i.listed ?? null]);
    const row = (await c.query('SELECT p.*, u.display_name AS athlete_name FROM para_mentor_profiles p JOIN users u ON u.id=p.athlete_id WHERE p.athlete_id=$1', [user.id])).rows[0];
    return profileRow(c, row, { self: true });
  }),
});

cap({
  name: 'get_para_mentor_profile', method: 'GET', path: '/para/mentors/:id', tag: TAG,
  summary: 'Public mentor profile. Returns 404 if not listed or if the viewer is blocked. Bio is returned only to the profile owner.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const row = (await c.query(
      `SELECT p.*, u.display_name AS athlete_name FROM para_mentor_profiles p JOIN users u ON u.id=p.athlete_id
       WHERE p.athlete_id=$1 AND (p.listed OR p.athlete_id=$2) AND NOT (${blockedBetween('p.athlete_id', '$2::uuid')})`,
      [i.id, user.id])).rows[0];
    if (!row) throw notFound('Mentor profile');
    return profileRow(c, row, { self: row.athlete_id === user.id });
  }),
});

cap({
  name: 'list_para_mentors', method: 'GET', path: '/para/mentors', tag: TAG,
  summary: 'Paginated directory of listed para mentors. Filters: sport slug, discipline, comm_format, language. Excludes blocked profiles and non-listed profiles.',
  input: z.object({ sport: z.string().max(60).optional(), discipline: z.string().max(60).optional(), comm_format: z.string().max(60).optional(), language: z.string().max(10).optional(), ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT p.id, p.athlete_id, u.display_name AS athlete_name, p.sports, p.disciplines, p.peer_years,
              p.comm_formats, p.availability, p.languages, p.accepting, p.listed, p.created_at, p.updated_at
       FROM para_mentor_profiles p JOIN users u ON u.id=p.athlete_id
       WHERE p.listed = true AND p.accepting = true
         AND NOT (${blockedBetween('p.athlete_id', '$1::uuid')})
         AND ($2::text IS NULL OR p.sports @> ARRAY[$2::text])
         AND ($3::text IS NULL OR p.disciplines @> ARRAY[$3::text])
         AND ($4::text IS NULL OR p.comm_formats @> ARRAY[$4::text])
         AND ($5::text IS NULL OR p.languages @> ARRAY[$5::text])
       ORDER BY p.peer_years DESC NULLS LAST, p.created_at DESC
       LIMIT $6 OFFSET $7`,
      [user.id, i.sport ?? null, i.discipline ?? null, i.comm_format ?? null, i.language ?? null, i.limit, i.offset]);
    const total = await one(
      `SELECT count(*)::int AS n FROM para_mentor_profiles p
       WHERE p.listed=true AND p.accepting=true AND NOT (${blockedBetween('p.athlete_id', '$1::uuid')})
         AND ($2::text IS NULL OR p.sports @> ARRAY[$2::text])
         AND ($3::text IS NULL OR p.disciplines @> ARRAY[$3::text])
         AND ($4::text IS NULL OR p.comm_formats @> ARRAY[$4::text])
         AND ($5::text IS NULL OR p.languages @> ARRAY[$5::text])`,
      [user.id, i.sport ?? null, i.discipline ?? null, i.comm_format ?? null, i.language ?? null]);
    return { total: total.n, items: rows.map((r) => ({ ...r, bio: undefined })) };
  },
});

// ---------- mentorship lifecycle
const MENT_COLS = `m.id, m.mentor_id, mu.display_name AS mentor_name, m.mentee_id, eu.display_name AS mentee_name,
  m.sport_id, s.name AS sport_name, s.slug AS sport_slug, s.emoji AS sport_emoji, m.discipline,
  m.goal_enc, m.status, m.mentor_accepted_at, m.mentee_accepted_at, m.start_on, m.end_on, m.end_reason, m.created_at`;
const MENT_FROM = `para_mentorships m
  JOIN users mu ON mu.id=m.mentor_id
  JOIN users eu ON eu.id=m.mentee_id
  LEFT JOIN sports s ON s.id=m.sport_id`;

const mentRow = async (c, m, viewerId) => {
  const goal = (m.goal_enc && viewerId === m.mentee_id) ? decrypt(m.goal_enc, GOAL_CTX) : undefined;
  if (goal) await audit(c, viewerId, 'para_mentorship.goal.read', 'para_mentorships', m.id);
  const { goal_enc, ...rest } = m;
  return { ...rest, goal };
};

const loadMentorship = async (c, mid) => {
  const r = (await c.query(`SELECT ${MENT_COLS} FROM ${MENT_FROM} WHERE m.id=$1`, [mid])).rows[0];
  if (!r) throw notFound('Mentorship');
  return r;
};

const assertParty = (m, userId) => { if (![m.mentor_id, m.mentee_id].includes(userId)) throw notFound('Mentorship'); };

cap({
  name: 'request_para_mentorship', method: 'POST', path: '/para/mentorships', tag: TAG, status: 201,
  summary: 'Request a para mentoring relationship. The mentor must have a listed, accepting profile. For athletes under 18, guardian consent for the \'contact\' purpose is required.',
  input: z.object({ mentor_id: id, sport_id: id.optional(), discipline: t(60).optional(), goal: t(600).optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    guardForbidden(i.goal, 'Goal');
    if (i.mentor_id === user.id) throw badRequest('You cannot request mentoring from yourself');

    // Check mentor profile exists and is accepting
    const mentor = (await c.query('SELECT id, accepting, listed FROM para_mentor_profiles WHERE athlete_id=$1', [i.mentor_id])).rows[0];
    if (!mentor || !mentor.listed || !mentor.accepting) throw notFound('Mentor profile');

    // Check blocks
    if ((await one(`SELECT 1 FROM user_blocks WHERE lifted_at IS NULL AND ((blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))`, [user.id, i.mentor_id]))) throw notFound('Mentor profile');

    // Youth consent
    if (await isYouth(user.id)) await requireConsent(user.id, 'contact', `para mentoring from ${i.mentor_id}`, c);

    // Prevent duplicate open requests
    const dup = (await c.query("SELECT 1 FROM para_mentorships WHERE mentor_id=$1 AND mentee_id=$2 AND status IN ('requested','accepted','active')", [i.mentor_id, user.id])).rows[0];
    if (dup) throw conflict('You already have an open mentorship request or relationship with this mentor');

    const goal_enc = i.goal ? encrypt(i.goal, GOAL_CTX) : null;
    const m = (await c.query(
      `INSERT INTO para_mentorships (mentor_id, mentee_id, sport_id, discipline, goal_enc, created_by, mentee_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
      [i.mentor_id, user.id, i.sport_id ?? null, i.discipline ?? null, goal_enc, user.id])).rows[0];

    await notify(c, i.mentor_id, { kind: 'para_mentorship_requested', title: 'New mentoring request', body: 'Someone has requested para mentoring from you.', data: { mentorship_id: m.id }, dedupe_key: `pam-req:${m.id}` });

    // Notify guardians of youth mentee
    if (await isYouth(user.id)) {
      for (const gid of await guardiansOf(user.id, c)) {
        await audit(c, gid, 'para_mentorship.guardian.read', 'para_mentorships', m.id);
        await notify(c, gid, { kind: 'para_mentorship_guardian', title: 'Mentoring request made', body: 'Your young person has requested para mentoring.', data: { mentorship_id: m.id }, dedupe_key: `pam-g:${m.id}:${gid}` });
      }
    }
    return mentRow(c, await loadMentorship(c, m.id), user.id);
  }),
});

cap({
  name: 'respond_para_mentorship', method: 'POST', path: '/para/mentorships/:id/respond', tag: TAG,
  summary: 'The mentor accepts or declines a mentorship request. Accepting sets the relationship to active immediately (the mentee already accepted on creation).',
  input: z.object({ id, response: z.enum(['accept', 'decline']) }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query(`SELECT * FROM para_mentorships WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
    if (!m || m.mentor_id !== user.id) throw notFound('Mentorship');
    if (m.status !== 'requested') throw conflict(`This mentorship is already ${m.status}`);

    if (i.response === 'decline') {
      await c.query("UPDATE para_mentorships SET status='declined', mentor_accepted_at=NULL WHERE id=$1", [m.id]);
    } else {
      await c.query(`UPDATE para_mentorships SET mentor_accepted_at=now(), status='active', start_on=COALESCE(start_on, current_date) WHERE id=$1`, [m.id]);
    }
    await notify(c, m.mentee_id, {
      kind: 'para_mentorship_response',
      title: i.response === 'accept' ? 'Mentoring request accepted' : 'Mentoring request declined',
      body: 'Open Para Mentoring for details.',
      data: { mentorship_id: m.id },
      dedupe_key: `pam-resp:${m.id}:${i.response}`,
    });
    return mentRow(c, await loadMentorship(c, i.id), user.id);
  }),
});

cap({
  name: 'list_my_para_mentorships', method: 'GET', path: '/para/mentorships', tag: TAG,
  summary: 'List your para mentorships as mentor or mentee. Filter by status.',
  input: z.object({ role: z.enum(['mentor','mentee','any']).default('any'), status: z.string().optional(), ...page }),
  async handler({ user }, i) {
    const statusFilter = i.status ? i.status.split(',').map((s) => s.trim()) : null;
    const rows = await many(
      `SELECT ${MENT_COLS} FROM ${MENT_FROM}
       WHERE ($1 = 'any' OR ($1='mentor' AND m.mentor_id=$2) OR ($1='mentee' AND m.mentee_id=$2))
         AND (m.mentor_id=$2 OR m.mentee_id=$2)
         AND ($3::text[] IS NULL OR m.status = ANY($3::text[]))
       ORDER BY (m.status IN ('requested','active')) DESC, m.created_at DESC
       LIMIT $4 OFFSET $5`,
      [i.role, user.id, statusFilter, i.limit, i.offset]);
    // mentRow needs a db client for audit logging; use tx to get one
    return tx(async (db) => ({ items: await Promise.all(rows.map((r) => mentRow(db, r, user.id))) }));
  },
});

cap({
  name: 'schedule_para_session', method: 'POST', path: '/para/mentorships/:id/sessions', tag: TAG, status: 201,
  summary: 'Schedule a session within an active mentorship. Creates a session record. The inbox conversation is managed separately.',
  input: z.object({ id, title: t(120).optional(), scheduled_at: z.string().datetime().optional(), format: z.enum(['video','phone','in_person','async_message']).optional(), notes: t(2000).optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query(`SELECT * FROM para_mentorships WHERE id=$1`, [i.id])).rows[0];
    if (!m) throw notFound('Mentorship');
    assertParty(m, user.id);
    if (m.status !== 'active') throw conflict(`Mentorship is ${m.status} — only active mentorships can have sessions scheduled`);
    if ((await one(`SELECT 1 FROM user_blocks WHERE lifted_at IS NULL AND ((blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))`, [m.mentor_id, m.mentee_id]))) throw conflict('Contact blocked');

    const title_enc = i.title ? encrypt(i.title, TITLE_CTX) : null;
    const notes_enc = i.notes ? encrypt(i.notes, NOTES_CTX) : null;
    const sess = (await c.query(
      `INSERT INTO para_mentorship_sessions (mentorship_id, title_enc, scheduled_at, format, notes_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id, mentorship_id, scheduled_at, format, status, created_at`,
      [m.id, title_enc, i.scheduled_at ?? null, i.format ?? null, notes_enc])).rows[0];

    const other = m.mentor_id === user.id ? m.mentee_id : m.mentor_id;
    await notify(c, other, { kind: 'para_session_scheduled', title: 'Mentoring session scheduled', body: 'Open Para Mentoring for details.', data: { mentorship_id: m.id, session_id: sess.id }, dedupe_key: `pam-sess:${sess.id}` });
    return sess;
  }),
});

cap({
  name: 'update_para_session', method: 'PATCH', path: '/para/mentorships/:id/sessions/:sid', tag: TAG,
  summary: 'Update a mentorship session status or notes (either party).',
  input: z.object({ id, sid: id, status: z.enum(['scheduled','completed','cancelled']).optional(), notes: t(2000).optional(), scheduled_at: z.string().datetime().optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const sess = (await c.query('SELECT s.*, m.mentor_id, m.mentee_id FROM para_mentorship_sessions s JOIN para_mentorships m ON m.id=s.mentorship_id WHERE s.id=$1 AND s.mentorship_id=$2', [i.sid, i.id])).rows[0];
    if (!sess) throw notFound('Session');
    assertParty(sess, user.id);
    const notes_enc = i.notes !== undefined ? (i.notes ? encrypt(i.notes, NOTES_CTX) : null) : undefined;
    await c.query(
      `UPDATE para_mentorship_sessions SET
         status = COALESCE($2, status),
         notes_enc = COALESCE($3, notes_enc),
         scheduled_at = COALESCE($4, scheduled_at)
       WHERE id=$1`,
      [i.sid, i.status ?? null, notes_enc ?? null, i.scheduled_at ?? null]);
    return (await c.query('SELECT id, mentorship_id, scheduled_at, format, status, created_at FROM para_mentorship_sessions WHERE id=$1', [i.sid])).rows[0];
  }),
});

cap({
  name: 'submit_para_feedback', method: 'POST', path: '/para/mentorships/:id/feedback', tag: TAG, status: 201,
  summary: 'Submit feedback at the end of a mentorship. Each party can submit once. Body is encrypted and visible only to the submitter.',
  input: z.object({ id, rating: z.number().int().min(1).max(5).optional(), body: t(1000).optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query('SELECT * FROM para_mentorships WHERE id=$1', [i.id])).rows[0];
    if (!m) throw notFound('Mentorship');
    assertParty(m, user.id);
    if (!['active','completed','ended'].includes(m.status)) throw conflict('Feedback can only be submitted after the mentorship is active, completed or ended');
    const body_enc = i.body ? encrypt(i.body, FB_CTX) : null;
    let fb;
    try {
      fb = (await c.query('INSERT INTO para_mentorship_feedback (mentorship_id, from_id, rating, body_enc) VALUES ($1,$2,$3,$4) RETURNING id, mentorship_id, from_id, rating, created_at', [m.id, user.id, i.rating ?? null, body_enc])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('You have already submitted feedback for this mentorship'); throw e; }
    await audit(c, user.id, 'para_feedback.submit', 'para_mentorship_feedback', fb.id);
    return fb;
  }),
});

cap({
  name: 'end_para_mentorship', method: 'POST', path: '/para/mentorships/:id/end', tag: TAG,
  summary: 'Complete or end a mentorship (either party). The goal and sessions remain with their owners.',
  input: z.object({ id, outcome: z.enum(['completed','ended']), reason: t(300).optional() }).strict(),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query('SELECT * FROM para_mentorships WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!m) throw notFound('Mentorship');
    assertParty(m, user.id);
    if (!['requested','active'].includes(m.status)) throw conflict(`Mentorship is already ${m.status}`);
    await c.query('UPDATE para_mentorships SET status=$2, end_reason=$3, end_on=COALESCE(end_on, current_date) WHERE id=$1', [m.id, i.outcome, i.reason ?? null]);
    const other = m.mentor_id === user.id ? m.mentee_id : m.mentor_id;
    await notify(c, other, { kind: 'para_mentorship_ended', title: 'Mentorship ended', body: 'Open Para Mentoring for details.', data: { mentorship_id: m.id }, dedupe_key: `pam-end:${m.id}:${user.id}` });
    return mentRow(c, await loadMentorship(c, m.id), user.id);
  }),
});
