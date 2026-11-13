// Issue #1024: verified, moderated referee reputation — testimony, visibility prefs, anti-retaliation.
// Aggregates signals ONLY from existing verified tables (fixture_officials, off_assessments, off_cpd_records,
// official_feedback, sport_profiles, fed_licences). No single AI score stored.
import { cap } from '../registry.js';
import { encrypt, decrypt } from '../crypto.js';
import { audit } from '../helpers.js';
import { tx, one, many } from '../db.js';
import { feedbackSummary } from './officials-feedback.js';

const DIMENSIONS = ['completed_matches','on_time_rate','feedback_averages','assessments','cpd','grade','testimony'];
const DEFAULT_VIS = {
  completed_matches: 'public',
  on_time_rate: 'public',
  feedback_averages: 'organiser_only',
  assessments: 'organiser_only',
  cpd: 'organiser_only',
  grade: 'public',
  testimony: 'public',
};

async function loadVisibility(userId, c) {
  const rows = await many(c, 'SELECT dimension, visibility FROM off_reputation_visibility WHERE user_id=$1', [userId]);
  const vis = { ...DEFAULT_VIS };
  for (const r of rows) vis[r.dimension] = r.visibility;
  return vis;
}

function eff(vis, level, isOrg) {
  if (level === 'public') return true;
  if (level === 'organiser_only') return isOrg;
  return false;
}

async function completedMatchStats(userId, c) {
  const r = await one(c, `
    SELECT COUNT(*) FILTER (WHERE status='completed') AS total,
           COUNT(*) FILTER (WHERE status='completed' AND arrived_on_time=true) AS on_time
    FROM fixture_officials WHERE user_id=$1`, [userId]);
  return { total: Number(r?.total ?? 0), on_time: Number(r?.on_time ?? 0) };
}

async function assessmentStats(userId, c) {
  const r = await one(c, `
    SELECT COUNT(*) FILTER (WHERE a.status='published') AS published,
           COUNT(*) FILTER (WHERE ap.status='upheld') AS upheld
    FROM off_assessments a
    LEFT JOIN off_appeals ap ON ap.assessment_id=a.id
    WHERE a.official_id=$1`, [userId]);
  return { published: Number(r?.published ?? 0), upheld: Number(r?.upheld ?? 0) };
}

async function cpdStats(userId, c) {
  const r = await one(c, `
    SELECT COALESCE(SUM(cpd_hours),0) AS hours
    FROM off_cpd_records WHERE holder_id=$1 AND archived_at IS NULL AND verified_at IS NOT NULL`, [userId]);
  return { verified_hours: Number(r?.hours ?? 0) };
}

async function gradeInfo(userId, c) {
  const r = await one(c, `
    SELECT sp.level, flt.name AS licence_type, fl.body_name, fl.expires_on, flt.rank
    FROM sport_profiles sp
    LEFT JOIN fed_licences fl ON fl.user_id=sp.user_id AND fl.sport_id=sp.sport_id AND fl.archived_at IS NULL
    LEFT JOIN fed_licence_types flt ON flt.id=fl.licence_type_id
    WHERE sp.user_id=$1 AND sp.role='referee' AND sp.archived_at IS NULL
    ORDER BY flt.rank DESC NULLS LAST
    LIMIT 1`, [userId]);
  return r ?? { level: null, licence_type: null, body_name: null, expires_on: null, rank: null };
}

async function yearsActive(userId, c) {
  const r = await one(c, `
    SELECT MIN(f.scheduled_at) AS first_match
    FROM fixture_officials fo
    JOIN fixtures f ON f.id=fo.fixture_id
    WHERE fo.user_id=$1 AND fo.status='completed'`, [userId]);
  if (!r?.first_match) return 0;
  return Math.floor((Date.now() - new Date(r.first_match)) / (365.25 * 86400 * 1000));
}

async function checkEligibleAuthor(authorId, subjectId, sportId, c) {
  // 1. worked together as officials on same fixture
  const worked = await one(c, `
    SELECT 1 FROM fixture_officials fo1
    JOIN fixture_officials fo2 ON fo2.fixture_id=fo1.fixture_id AND fo2.user_id=$2
    WHERE fo1.user_id=$1 AND fo1.status='completed' AND fo2.status='completed'
    LIMIT 1`, [authorId, subjectId]);
  if (worked) return true;
  // 2. appointed assessor
  const assessor = await one(c, `
    SELECT 1 FROM off_assessments WHERE assessor_id=$1 AND official_id=$2 LIMIT 1`, [authorId, subjectId]);
  if (assessor) return true;
  // 3. grade rank >= subject's grade rank (senior can vouch for junior)
  const authorGrade = await one(c, `
    SELECT flt.rank FROM sport_profiles sp
    LEFT JOIN fed_licences fl ON fl.user_id=sp.user_id AND fl.sport_id=sp.sport_id AND fl.archived_at IS NULL
    LEFT JOIN fed_licence_types flt ON flt.id=fl.licence_type_id
    WHERE sp.user_id=$1 AND sp.sport_id=$3 AND sp.role='referee' AND sp.archived_at IS NULL
    ORDER BY flt.rank DESC NULLS LAST LIMIT 1`, [authorId, subjectId, sportId]);
  const subjectGrade = await one(c, `
    SELECT flt.rank FROM sport_profiles sp
    LEFT JOIN fed_licences fl ON fl.user_id=sp.user_id AND fl.sport_id=sp.sport_id AND fl.archived_at IS NULL
    LEFT JOIN fed_licence_types flt ON flt.id=fl.licence_type_id
    WHERE sp.user_id=$1 AND sp.sport_id=$2 AND sp.role='referee' AND sp.archived_at IS NULL
    ORDER BY flt.rank DESC NULLS LAST LIMIT 1`, [subjectId, sportId]);
  if (authorGrade?.rank != null && subjectGrade?.rank != null && authorGrade.rank >= subjectGrade.rank) return true;
  return false;
}

async function authorSnapshot(authorId, sportId, c) {
  const g = await gradeInfo(authorId, c);
  return { level: g.level, licence_type: g.licence_type, sport_id: sportId };
}

function maskTestimony(t, forSubject = false) {
  const { author_user_id, body_enc, ...rest } = t;
  const out = { ...rest };
  if (forSubject && t.moderation_reason) out.moderation_reason = t.moderation_reason;
  return out;
}

async function maybePublishPending(c) {
  await tx(c, async (tx) => {
    const due = await many(tx, `
      SELECT t.id FROM off_testimony t
      WHERE t.status='pending_dispute' AND t.dispute_window_ends_at < now()
        AND NOT EXISTS (
          SELECT 1 FROM off_testimony_disputes d WHERE d.testimony_id=t.id AND d.status='open'
        )
      FOR UPDATE SKIP LOCKED`, []);
    for (const { id } of due) {
      await tx.query(`UPDATE off_testimony SET status='active', published_at=now() WHERE id=$1`, [id]);
    }
  });
}

async function buildProfile(userId, visibilityFilter, c, isOrg) {
  const vis = await loadVisibility(userId, c);
  const show = (dim) => eff(vis, vis[dim], isOrg || visibilityFilter === 'self');
  const matchStats = show('completed_matches') ? await completedMatchStats(userId, c) : null;
  const onTime = show('on_time_rate') ? matchStats : null;
  const fb = show('feedback_averages') ? await feedbackSummary(userId, {}, c) : null;
  const assess = show('assessments') ? await assessmentStats(userId, c) : null;
  const cpd = show('cpd') ? await cpdStats(userId, c) : null;
  const grade = show('grade') ? await gradeInfo(userId, c) : null;
  const years = await yearsActive(userId, c);
  const user = await one(c, `SELECT id, display_name, avatar_url FROM users WHERE id=$1`, [userId]);
  return { user, years_active: years, completed_matches: matchStats, on_time_rate: onTime, feedback: fb, assessments: assess, cpd, grade, visibility: vis };
}

cap({
  name: 'get_my_reputation_profile',
  description: 'Full private reputation profile for the authenticated official (all dimensions, raw testimony, visibility settings).',
  method: 'GET', path: '/official-reputation/me',
  auth: ['user'],
  async handler(c) {
    const userId = c.user.id;
    await maybePublishPending(c);
    const profile = await buildProfile(userId, 'self', c, false);
    const testimony = await many(c, `
      SELECT id, sport_id, status, dispute_window_ends_at, published_at, moderation_reason, created_at,
             body_enc
      FROM off_testimony WHERE subject_user_id=$1 AND archived_at IS NULL
      ORDER BY created_at DESC`, [userId]);
    const decrypted = await Promise.all(testimony.map(async (t) => ({
      ...maskTestimony(t, true),
      body: await decrypt(t.body_enc, 'off_testimony.body_enc'),
    })));
    await audit(c, userId, 'read_own_reputation', 'users', userId);
    return { ...profile, testimony: decrypted };
  },
});

cap({
  name: 'update_reputation_visibility',
  description: 'Set public/organiser_only/private per reputation dimension.',
  method: 'PUT', path: '/official-reputation/visibility',
  auth: ['user'],
  body: {
    type: 'object',
    properties: {
      dimension: { type: 'string', enum: DIMENSIONS },
      visibility: { type: 'string', enum: ['public','organiser_only','private'] },
    },
    required: ['dimension','visibility'],
  },
  async handler(c) {
    const { dimension, visibility } = c.body;
    const userId = c.user.id;
    await tx(c, async (tx) => {
      await tx.query(`
        INSERT INTO off_reputation_visibility (user_id, dimension, visibility)
        VALUES ($1,$2,$3)
        ON CONFLICT ON CONSTRAINT off_rep_vis_uniq
        DO UPDATE SET visibility=$3, updated_at=now()`, [userId, dimension, visibility]);
    });
    return { dimension, visibility };
  },
});

cap({
  name: 'get_public_reputation',
  description: 'Public reputation card for an official. Respects per-dimension visibility prefs. Returns 404 if no referee sport profile exists.',
  method: 'GET', path: '/official-reputation/:userId',
  auth: ['public'],
  async handler(c) {
    const { userId } = c.params;
    await maybePublishPending(c);
    const profile_exists = await one(c, `SELECT 1 FROM sport_profiles WHERE user_id=$1 AND role='referee' AND archived_at IS NULL LIMIT 1`, [userId]);
    if (!profile_exists) return c.notFound();
    const isOrg = c.user ? !!(await one(c, `
      SELECT 1 FROM fixture_officials fo1
      JOIN fixture_officials fo2 ON fo2.fixture_id=fo1.fixture_id AND fo2.user_id=$2
      WHERE fo1.user_id=$1 AND fo1.status='completed' LIMIT 1`, [c.user.id, userId])) : false;
    return buildProfile(userId, 'public', c, isOrg);
  },
});

cap({
  name: 'submit_testimony',
  description: 'Submit testimony for an eligible official. Starts 7-day anti-retaliation dispute window. Author identity is never revealed to subject.',
  method: 'POST', path: '/official-reputation/testimony',
  auth: ['user'],
  status: 201,
  body: {
    type: 'object',
    properties: {
      subject_user_id: { type: 'string', format: 'uuid' },
      sport_id: { type: 'string', format: 'uuid' },
      body: { type: 'string', minLength: 50, maxLength: 2000 },
    },
    required: ['subject_user_id','body'],
  },
  async handler(c) {
    const { subject_user_id, sport_id, body } = c.body;
    const authorId = c.user.id;
    if (authorId === subject_user_id) return c.error(400, 'Cannot testify for yourself.');
    const eligible = await checkEligibleAuthor(authorId, subject_user_id, sport_id, c);
    if (!eligible) return c.error(403, 'You must have worked with this official, been their assessor, or hold a grade equal or higher to submit testimony.');
    const existing = await one(c, `SELECT id FROM off_testimony WHERE author_user_id=$1 AND subject_user_id=$2 AND archived_at IS NULL AND status <> 'archived' LIMIT 1`, [authorId, subject_user_id]);
    if (existing) return c.error(409, 'You have already submitted testimony for this official. Update your existing testimony instead.');
    const body_enc = await encrypt(body, 'off_testimony.body_enc');
    const snapshot = await authorSnapshot(authorId, sport_id, c);
    const dispute_window_ends_at = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    const row = await tx(c, async (tx) => {
      const { rows: [r] } = await tx.query(`
        INSERT INTO off_testimony (subject_user_id, author_user_id, sport_id, body_enc, author_grade_snapshot, dispute_window_ends_at)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status, dispute_window_ends_at, created_at`,
        [subject_user_id, authorId, sport_id ?? null, body_enc, JSON.stringify(snapshot), dispute_window_ends_at]);
      return r;
    });
    await audit(c, authorId, 'submit_testimony', 'off_testimony', row.id);
    return { id: row.id, status: row.status, dispute_window_ends_at: row.dispute_window_ends_at, created_at: row.created_at };
  },
});

cap({
  name: 'dispute_testimony',
  description: 'Subject official disputes a testimony within the 7-day anti-retaliation window. Encrypted reason stored. Notifies platform moderators.',
  method: 'POST', path: '/official-reputation/testimony/:id/dispute',
  auth: ['user'],
  body: {
    type: 'object',
    properties: { reason: { type: 'string', minLength: 20, maxLength: 2000 } },
    required: ['reason'],
  },
  async handler(c) {
    const { id } = c.params;
    const userId = c.user.id;
    const testimony = await one(c, `SELECT * FROM off_testimony WHERE id=$1 AND archived_at IS NULL FOR UPDATE`, [id]);
    if (!testimony) return c.notFound();
    if (testimony.subject_user_id !== userId) return c.notFound();
    if (testimony.status !== 'pending_dispute') return c.error(400, 'Dispute window has closed or testimony is not pending.');
    if (new Date(testimony.dispute_window_ends_at) < new Date()) return c.error(400, 'Dispute window has closed.');
    const existing = await one(c, `SELECT id FROM off_testimony_disputes WHERE testimony_id=$1 AND disputing_user_id=$2`, [id, userId]);
    if (existing) return c.error(409, 'You have already raised a dispute for this testimony.');
    const reason_enc = await encrypt(c.body.reason, 'off_testimony_disputes.reason_enc');
    const dispute = await tx(c, async (tx) => {
      const { rows: [r] } = await tx.query(`
        INSERT INTO off_testimony_disputes (testimony_id, disputing_user_id, reason_enc)
        VALUES ($1,$2,$3) RETURNING id, status, created_at`, [id, userId, reason_enc]);
      return r;
    });
    await audit(c, userId, 'dispute_testimony', 'off_testimony', id);
    return { dispute_id: dispute.id, status: dispute.status, created_at: dispute.created_at };
  },
});

cap({
  name: 'moderate_testimony',
  description: 'Platform moderator upholds (hides testimony) or dismisses (publishes testimony) a dispute.',
  method: 'POST', path: '/official-reputation/testimony/:id/moderate',
  auth: ['admin'],
  body: {
    type: 'object',
    properties: {
      dispute_id: { type: 'string', format: 'uuid' },
      decision: { type: 'string', enum: ['upheld','dismissed'] },
      note: { type: 'string', maxLength: 1000 },
    },
    required: ['dispute_id','decision'],
  },
  async handler(c) {
    const { id } = c.params;
    const { dispute_id, decision, note } = c.body;
    const moderatorId = c.user.id;
    const dispute = await one(c, `SELECT * FROM off_testimony_disputes WHERE id=$1 AND testimony_id=$2 AND status='open' FOR UPDATE`, [dispute_id, id]);
    if (!dispute) return c.notFound();
    await tx(c, async (tx) => {
      await tx.query(`UPDATE off_testimony_disputes SET status=$1, moderator_id=$2, moderator_note=$3, decided_at=now() WHERE id=$4`,
        [decision, moderatorId, note ?? null, dispute_id]);
      if (decision === 'upheld') {
        await tx.query(`UPDATE off_testimony SET status='hidden', moderation_reason=$1 WHERE id=$2`, [note ?? 'Upheld by moderator', id]);
      } else {
        await tx.query(`UPDATE off_testimony SET status='active', published_at=COALESCE(published_at,now()) WHERE id=$1`, [id]);
      }
    });
    await audit(c, moderatorId, `moderate_testimony_${decision}`, 'off_testimony', id);
    return { decision, testimony_id: id, dispute_id };
  },
});

cap({
  name: 'list_testimony_for_official',
  description: 'Public list of active testimonies for an official. Author identity is never revealed. Respects visibility prefs.',
  method: 'GET', path: '/official-reputation/:userId/testimony',
  auth: ['public'],
  async handler(c) {
    const { userId } = c.params;
    await maybePublishPending(c);
    const vis = await loadVisibility(userId, c);
    const isOrg = c.user ? !!(await one(c, `
      SELECT 1 FROM fixture_officials fo1
      JOIN fixture_officials fo2 ON fo2.fixture_id=fo1.fixture_id AND fo2.user_id=$2
      WHERE fo1.user_id=$1 AND fo1.status='completed' LIMIT 1`, [c.user?.id, userId])) : false;
    if (!eff(vis, vis.testimony, isOrg)) return { testimony: [], hidden_by_preference: true };
    const rows = await many(c, `
      SELECT id, sport_id, status, published_at, author_grade_snapshot, body_enc
      FROM off_testimony WHERE subject_user_id=$1 AND status='active' AND archived_at IS NULL
      ORDER BY published_at DESC`, [userId]);
    const out = await Promise.all(rows.map(async (t) => ({
      id: t.id, sport_id: t.sport_id, published_at: t.published_at,
      author_grade: t.author_grade_snapshot,
      body: await decrypt(t.body_enc, 'off_testimony.body_enc'),
    })));
    await audit(c, c.user?.id ?? null, 'read_testimony', 'off_testimony', userId);
    return { testimony: out };
  },
});

cap({
  name: 'get_reputation_export',
  description: 'PDF-ready reputation summary. Audit-logged. Available to the official themselves or confirmed co-workers.',
  method: 'GET', path: '/official-reputation/:userId/export',
  auth: ['user'],
  async handler(c) {
    const { userId } = c.params;
    const requesterId = c.user.id;
    const isSelf = requesterId === userId;
    const isCoworker = !isSelf ? !!(await one(c, `
      SELECT 1 FROM fixture_officials fo1
      JOIN fixture_officials fo2 ON fo2.fixture_id=fo1.fixture_id AND fo2.user_id=$2
      WHERE fo1.user_id=$1 AND fo1.status='completed' LIMIT 1`, [requesterId, userId])) : true;
    if (!isSelf && !isCoworker) return c.notFound();
    await maybePublishPending(c);
    const profile = await buildProfile(userId, isSelf ? 'self' : 'organiser', c, !isSelf);
    const testimony = await many(c, `
      SELECT id, sport_id, published_at, author_grade_snapshot, body_enc
      FROM off_testimony WHERE subject_user_id=$1 AND status='active' AND archived_at IS NULL
      ORDER BY published_at DESC`, [userId]);
    const decrypted = await Promise.all(testimony.map(async (t) => ({
      id: t.id, sport_id: t.sport_id, published_at: t.published_at,
      author_grade: t.author_grade_snapshot,
      body: await decrypt(t.body_enc, 'off_testimony.body_enc'),
    })));
    await audit(c, requesterId, 'export_reputation', 'users', userId);
    return { ...profile, testimony: decrypted, exported_at: new Date().toISOString() };
  },
});
