// Academy OS P1 / Gap 13 (#793): video review & coach feedback. There is NO video service here. The clip stays the athlete's own library item
// (passport_videos: storage, encoding, sharing and takedown are owned by the player video library, #317/#565); the academy only holds a governed
// REFERENCE (academy_clip_links) tying that clip to a session, a curriculum objective, a coach observation, an assessment and a shared development
// action (academy_dev_interventions, kind video_review: the #785 plan owns actions). Every read re-evaluates the gate live: revoked or expired link,
// clip unshared/archived/removed, or (for a young athlete) no current verified-guardian media consent. Nothing about access is cached.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { config } from '../config.js';
import { authenticate } from '../auth.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { toErrorBody } from '../invoke.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { orgRole } from '../org-access.js';
import { guardianLink, guardiansOf, hasConsent } from '../youth.js';
import { notify } from '../notify.js';
import { docHeaders, loadEncrypted } from '../doc-store.js';
import { withEmbed } from '../passport-sections.js';
import { sessionFor } from '../academy-ops.js';

const TAG = 'Academy';
const BROAD = ['owner', 'admin', 'manager'];
const COACHING = ['owner', 'admin', 'manager', 'coach', 'evaluator'];
const NOTE = 'academy_clip.note';
const sealN = (s, ctx) => (s ? encrypt(s, ctx) : null);
const openN = (s, ctx) => (s ? decrypt(s, ctx) : null);
const text = (n, m = 600) => z.string().trim().min(n).max(m);
export const REVIEW = ['understood', 'need_help', 'question'];

// ------------------------------------------------------------------------------------------------ access + live gate
const LINK = `SELECT l.*, v.title AS video_title, v.link_url, v.file_name, v.content_type, v.visibility AS video_visibility, v.archived_at AS video_archived_at, v.unpublished_at AS video_unpublished_at,
  v.removed_at AS video_removed_at, au.display_name AS athlete_name, sx.title AS session_title, sx.starts_at AS session_starts_at,
  i.title AS action_title, i.status AS action_status, i.due_on AS action_due_on, i.visibility AS action_visibility,
  (SELECT count(*)::int FROM academy_clip_annotations a WHERE a.link_id=l.id AND a.removed_at IS NULL) AS annotation_count
  FROM academy_clip_links l JOIN passport_videos v ON v.id=l.video_id JOIN users au ON au.id=l.athlete_id
  LEFT JOIN academy_sessions sx ON sx.id=l.session_id LEFT JOIN academy_dev_interventions i ON i.id=l.intervention_id`;

/** Why this link cannot be played right now, or null. Evaluated live on every read. */
export async function gateOf(l) {
  if (l.status === 'revoked') return 'revoked';
  if (l.expires_at && new Date(l.expires_at) <= new Date()) return 'expired';
  if (l.video_removed_at || l.video_archived_at || l.video_unpublished_at || l.video_visibility === 'private') return 'unshared';
  if (!(await hasConsent(l.athlete_id, 'media'))) return 'consent_withdrawn';
  return null;
}

/** Who is the caller to this link's athlete? Staff (scoped), the athlete, or a guardian; otherwise null so the caller gets a 404. */
async function viewerOf(user, l) {
  if (user.id === l.athlete_id) return { kind: 'athlete' };
  if (await guardianLink(user.id, l.athlete_id)) return { kind: 'guardian' };
  const role = await orgRole(user, l.organisation_id);
  if (!role || !COACHING.includes(role)) return null;
  if (BROAD.includes(role) || l.created_by === user.id) return { kind: 'staff', role };
  const mine = await one(`SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.user_id=$2 AND k.coach_id=$3 AND e.status IN ('enrolled','paused')
    UNION SELECT 1 FROM academy_session_staff st WHERE st.session_id=$4 AND st.user_id=$3 AND st.status IN ('assigned','confirmed') LIMIT 1`, [l.organisation_id, l.athlete_id, user.id, l.session_id]);
  return mine ? { kind: 'staff', role } : null;
}
async function linkFor(user, linkId, c) {
  const q = c ? (t, p) => c.query(t, p).then((r) => r.rows[0]) : one;
  const l = await q(`${LINK} WHERE l.id=$1${c ? ' FOR UPDATE OF l' : ''}`, [linkId]);
  if (!l) throw notFound('Clip');
  const v = await viewerOf(user, l);
  if (!v || (v.kind !== 'staff' && !l.athlete_visible)) throw notFound('Clip');
  return { l, v };
}
const isStaff = (v) => v.kind === 'staff';
const needStaff = (v) => { if (!isStaff(v)) throw forbidden('Only the academy coaching staff can do that'); };

async function present(l, v, { annotations = false } = {}) {
  const reason = await gateOf(l);
  const staff = isStaff(v);
  const out = {
    id: l.id, organisation_id: l.organisation_id, athlete: { id: l.athlete_id, display_name: l.athlete_name }, session: l.session_id ? { id: l.session_id, title: l.session_title, starts_at: l.session_starts_at } : null,
    status: l.status, expires_at: l.expires_at, athlete_visible: l.athlete_visible, review_state: l.review_state, reviewed_at: l.reviewed_at, first_viewed_at: l.first_viewed_at, annotation_count: l.annotation_count,
    objective_key: l.objective_key, dev_objective_id: l.dev_objective_id, observation_id: l.observation_id, assessment_ref: l.assessment_ref, start_ms: l.start_ms, end_ms: l.end_ms, row_version: l.row_version, created_at: l.created_at,
    action: l.intervention_id && (staff || l.action_visibility === 'athlete') ? { id: l.intervention_id, title: l.action_title, status: l.action_status, due_on: l.action_due_on } : null,
    access: { ok: !reason, reason, consent_checked_live: true },
    viewer: v.kind, revoked_at: l.revoked_at, revoke_reason: staff ? l.revoke_reason : null,
  };
  if (reason) return { ...out, video: { id: l.video_id, title: staff ? l.video_title : null }, ...(staff ? { coach_note: openN(l.coach_note_enc, NOTE) } : {}) };
  Object.assign(out, withEmbed({ link_url: l.link_url }), { video: { id: l.video_id, title: l.video_title, play_url: l.file_name ? `/api/v1/academy/clip-links/${l.id}/file` : null, embed_url: withEmbed({ link_url: l.link_url }).embed_url ?? null }, coach_note: openN(l.coach_note_enc, NOTE) });
  delete out.link_url;
  if (annotations) out.annotations = (await many('SELECT a.id, a.at_ms, a.kind, a.note_enc, a.created_at, u.display_name AS author FROM academy_clip_annotations a JOIN users u ON u.id=a.author_id WHERE a.link_id=$1 AND a.removed_at IS NULL ORDER BY a.at_ms, a.id', [l.id]))
    .map(({ note_enc, ...a }) => ({ ...a, note: openN(note_enc, `${NOTE}.annotation`) }));
  return out;
}

const dev = async (c, orgId, athleteId) => (await c.query("SELECT * FROM academy_dev_plans WHERE organisation_id=$1 AND athlete_id=$2 AND archived_at IS NULL AND status<>'closed' ORDER BY ends_on DESC, id LIMIT 1", [orgId, athleteId])).rows[0];

// ------------------------------------------------------------------------------------------------ coach side
cap({
  name: 'list_academy_linkable_clips', method: 'GET', path: '/academy/sessions/:id/linkable-clips', tag: TAG, input: z.object({ id, athlete_id: id.optional(), ...page }),
  summary: 'Clips a coach may link to this session: library videos that athletes enrolled in the session\'s cohort have shared, not archived, and (for young athletes) with current guardian media consent. Read-only; audit-logged.',
  async handler({ user }, i) {
    const { s } = await sessionFor(user, i.id, 'view');
    const rows = await many(
      `SELECT v.id, v.title, v.visibility, (v.file_name IS NOT NULL) AS has_file, v.link_url, v.size_bytes, v.created_at, v.user_id AS athlete_id, u.display_name AS athlete_name,
              EXISTS (SELECT 1 FROM academy_clip_links l WHERE l.session_id=$1 AND l.video_id=v.id AND l.status='active') AS linked
         FROM passport_videos v JOIN users u ON u.id=v.user_id
        WHERE v.removed_at IS NULL AND v.archived_at IS NULL AND v.unpublished_at IS NULL AND v.visibility IN ('shared','public') AND v.status<>'rejected'
          AND EXISTS (SELECT 1 FROM org_enrolments e WHERE e.cohort_id=$2 AND e.user_id=v.user_id AND e.status IN ('enrolled','paused')) AND ($3::uuid IS NULL OR v.user_id=$3)
        ORDER BY v.created_at DESC, v.id LIMIT $4 OFFSET $5`, [s.id, s.cohort_id, i.athlete_id ?? null, i.limit, i.offset]);
    const out = [];
    for (const r of rows) if (await hasConsent(r.athlete_id, 'media')) out.push(r);
    await audit(null, user.id, 'list_academy_linkable_clips', 'academy_sessions', s.id);
    return out;
  },
});

cap({
  name: 'link_academy_clip', method: 'POST', path: '/academy/sessions/:id/clips', tag: TAG, status: 201,
  summary: 'Link an athlete\'s shared library clip to this session, with the curriculum objective, coach observation, assessment and a shared development action it belongs to (an existing action, or a new "video review" action in the athlete\'s plan). Checks live: the clip is shared and the athlete is enrolled in the session\'s cohort; a young athlete needs current guardian media consent. The share expires (default 14 days) and can be revoked at any time. The athlete and guardians are told with a generic message.',
  input: z.object({
    id, video_id: id, objective_key: z.string().trim().min(1).max(80).optional(), dev_objective_id: id.optional(), observation_id: id.optional(), assessment_ref: text(2, 120).optional(),
    start_ms: z.number().int().min(0).optional(), end_ms: z.number().int().min(1).optional(), coach_note: text(2, 600).optional(), athlete_visible: z.boolean().default(true), expires_in_days: z.number().int().min(1).max(60).default(14),
    intervention_id: id.optional(), new_action: z.object({ title: text(3, 140), due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), owner_id: id.optional(), visibility: z.enum(['staff', 'athlete']).default('athlete') }).optional(),
  }).refine((x) => !(x.intervention_id && x.new_action), 'Choose an existing action or create a new one, not both').refine((x) => x.end_ms == null || x.start_ms == null || x.end_ms > x.start_ms, 'end_ms must be after start_ms'),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'view', { c });
    const role = await orgRole(user, s.organisation_id, c);
    if (!role || !COACHING.includes(role)) throw forbidden('Only coaching staff can link video');
    const v = (await c.query('SELECT * FROM passport_videos WHERE id=$1 AND removed_at IS NULL AND archived_at IS NULL AND unpublished_at IS NULL AND visibility IN (\'shared\',\'public\')', [i.video_id])).rows[0];
    if (!v) throw conflict("This clip isn't shared with the academy. Ask the athlete to share it, then try again.", { code: 'clip_not_shared' });
    if (!(await c.query("SELECT 1 FROM org_enrolments WHERE cohort_id=$1 AND user_id=$2 AND status IN ('enrolled','paused')", [s.cohort_id, v.user_id])).rowCount) throw badRequest('This athlete is not enrolled in the session\'s group');
    if (!(await hasConsent(v.user_id, 'media', c))) throw conflict('A verified guardian has not given current media consent for this athlete. Ask a guardian to allow it under Family & guardians.', { code: 'guardian_consent_required', purpose: 'media' });
    if (i.objective_key && !(await c.query("SELECT 1 FROM academy_session_objectives WHERE session_id=$1 AND objective_key=$2 AND status<>'removed'", [s.id, i.objective_key])).rowCount) throw badRequest('That objective is not mapped to this session');
    const plan = i.dev_objective_id || i.intervention_id || i.new_action ? await dev(c, s.organisation_id, v.user_id) : null;
    if ((i.dev_objective_id || i.intervention_id || i.new_action) && !plan) throw conflict('This athlete has no active development plan to attach an action to', { code: 'no_dev_plan' });
    if (i.dev_objective_id && !(await c.query('SELECT 1 FROM academy_dev_objectives WHERE id=$1 AND plan_id=$2 AND archived_at IS NULL', [i.dev_objective_id, plan.id])).rowCount) throw badRequest('That objective is not in the athlete\'s plan');
    if (i.observation_id && !(await c.query('SELECT 1 FROM coaching_observations WHERE id=$1 AND athlete_id=$2', [i.observation_id, v.user_id])).rowCount) throw badRequest('That observation is not for this athlete');
    let actionId = i.intervention_id ?? null;
    if (actionId && !(await c.query('SELECT 1 FROM academy_dev_interventions WHERE id=$1 AND plan_id=$2', [actionId, plan.id])).rowCount) throw badRequest('That action is not in the athlete\'s plan');
    if (i.new_action) {
      const owner = i.new_action.owner_id ?? user.id;
      if (!(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [s.organisation_id, owner])).rowCount) throw badRequest('The action owner must be an active member of this academy');
      actionId = (await c.query(
        `INSERT INTO academy_dev_interventions(plan_id, objective_id, kind, title, owner_id, due_on, visibility, created_by) VALUES ($1,$2,'video_review',$3,$4,$5,$6,$7) RETURNING id`,
        [plan.id, i.dev_objective_id ?? null, i.new_action.title, owner, i.new_action.due_on ?? null, i.new_action.visibility, user.id])).rows[0].id;
    }
    let l;
    try {
      l = (await c.query(
        `INSERT INTO academy_clip_links(organisation_id, athlete_id, video_id, session_id, objective_key, dev_objective_id, observation_id, assessment_ref, intervention_id, start_ms, end_ms, coach_note_enc, athlete_visible, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + make_interval(days => $14), $15) RETURNING id`,
        [s.organisation_id, v.user_id, v.id, s.id, i.objective_key ?? null, i.dev_objective_id ?? null, i.observation_id ?? null, i.assessment_ref ?? null, actionId, i.start_ms ?? null, i.end_ms ?? null, sealN(i.coach_note, NOTE), i.athlete_visible, i.expires_in_days, user.id])).rows[0];
    } catch (e) { if (e.code === '23505') throw conflict('This clip is already linked to this session'); throw e; }
    if (i.athlete_visible) for (const to of [v.user_id, ...(await guardiansOf(v.user_id, c))]) await notify(c, to, { kind: 'academy_clip', title: 'A coach shared a video with you', body: 'Open Gotmygame to watch it and respond.', data: { clip_link_id: l.id }, dedupe_key: `academy:clip:${l.id}:${to}` });
    await audit(c, user.id, 'link_academy_clip', 'academy_clip_links', l.id);
    const row = await linkFor(user, l.id, c);
    return present(row.l, row.v, { annotations: true });
  }),
});

cap({
  name: 'list_academy_clips', method: 'GET', path: '/organisations/:id/academy/clips', tag: TAG,
  input: z.object({ id, session_id: id.optional(), cohort_id: id.optional(), athlete_id: id.optional(), review_state: z.enum(['pending', 'understood', 'need_help', 'question']).optional(), include_revoked: z.coerce.boolean().default(false), ...page }),
  summary: 'Clips linked in an academy, with a live access state and review state, for the session, cohort and athlete-progress views plus the coach feedback queue. Coaches see their own groups; owners, admins and managers see all. Totals cover the same filter.',
  async handler({ user }, i) {
    const role = await orgRole(user, i.id);
    if (!role || !COACHING.includes(role)) throw notFound('Organisation');
    const w = ['l.organisation_id=$1', '($2::uuid IS NULL OR l.session_id=$2)', '($3::uuid IS NULL OR l.athlete_id=$3)', '($4::text IS NULL OR l.review_state=$4)', '($5::boolean OR l.status=\'active\')',
      '($6::uuid IS NULL OR EXISTS (SELECT 1 FROM org_enrolments e WHERE e.cohort_id=$6 AND e.user_id=l.athlete_id AND e.status IN (\'enrolled\',\'paused\')))'];
    const args = [i.id, i.session_id ?? null, i.athlete_id ?? null, i.review_state ?? null, i.include_revoked, i.cohort_id ?? null];
    if (!BROAD.includes(role)) { args.push(user.id); w.push(`(l.created_by=$7 OR EXISTS (SELECT 1 FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=l.organisation_id AND e.user_id=l.athlete_id AND k.coach_id=$7 AND e.status IN ('enrolled','paused')))`); }
    const where = w.join(' AND ');
    const rows = await many(`${LINK} WHERE ${where} ORDER BY l.created_at DESC, l.id LIMIT ${i.limit} OFFSET ${i.offset}`, args);
    const items = [];
    for (const l of rows) items.push(await present(l, { kind: 'staff', role }));
    const t = await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE l.review_state<>'pending')::int AS reviewed, count(*) FILTER (WHERE l.review_state IN ('need_help','question'))::int AS needs_reply,
        count(*) FILTER (WHERE i.status IN ('open','in_progress'))::int AS open_actions
       FROM academy_clip_links l LEFT JOIN academy_dev_interventions i ON i.id=l.intervention_id WHERE ${where}`, args);
    await audit(null, user.id, 'list_academy_clips', 'organisations', i.id);
    return { totals: t, items };
  },
});

cap({
  name: 'get_academy_clip', method: 'GET', path: '/academy/clip-links/:id', tag: TAG, input: z.object({ id }),
  summary: 'One governed clip with its annotations, links and live access state. Staff, the athlete and a guardian can open it; the access gate (revoked, expired, unshared, consent withdrawn) is re-evaluated now. Every view is audit-logged; the athlete or guardian\'s first view is recorded.',
  async handler({ user }, i) {
    const { l, v } = await linkFor(user, i.id);
    if (!isStaff(v) && !l.first_viewed_at && !(await gateOf(l))) await one('UPDATE academy_clip_links SET first_viewed_at=now() WHERE id=$1 AND first_viewed_at IS NULL RETURNING id', [l.id]);
    await audit(null, user.id, 'view_academy_clip', 'academy_clip_links', l.id);
    return present(l, v, { annotations: true });
  },
});

cap({
  name: 'update_academy_clip', method: 'PATCH', path: '/academy/clip-links/:id', tag: TAG,
  summary: 'Edit a clip link (coaching staff): coach note, the objective/observation/assessment/action it evidences, whether the athlete sees it, or extend the expiry. Send row_version; a stale version is refused.',
  input: z.object({ id, row_version: z.number().int().min(1), coach_note: text(2, 600).optional(), athlete_visible: z.boolean().optional(), expires_in_days: z.number().int().min(1).max(60).optional(),
    objective_key: z.string().trim().min(1).max(80).optional(), observation_id: id.optional(), assessment_ref: text(2, 120).optional(), intervention_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { l, v } = await linkFor(user, i.id, c);
    needStaff(v);
    if (l.status !== 'active') throw conflict('This link was revoked; link the clip again to share it');
    if (l.row_version !== i.row_version) throw conflict('This clip changed since you opened it. Reload and try again.', { code: 'stale_version', row_version: l.row_version });
    if (i.objective_key && !(await c.query("SELECT 1 FROM academy_session_objectives WHERE session_id=$1 AND objective_key=$2 AND status<>'removed'", [l.session_id, i.objective_key])).rowCount) throw badRequest('That objective is not mapped to this session');
    if (i.observation_id && !(await c.query('SELECT 1 FROM coaching_observations WHERE id=$1 AND athlete_id=$2', [i.observation_id, l.athlete_id])).rowCount) throw badRequest('That observation is not for this athlete');
    if (i.intervention_id) { const p = await dev(c, l.organisation_id, l.athlete_id); if (!p || !(await c.query('SELECT 1 FROM academy_dev_interventions WHERE id=$1 AND plan_id=$2', [i.intervention_id, p.id])).rowCount) throw badRequest('That action is not in the athlete\'s plan'); }
    await c.query(
      `UPDATE academy_clip_links SET coach_note_enc=coalesce($2,coach_note_enc), athlete_visible=coalesce($3,athlete_visible), expires_at=CASE WHEN $4::int IS NULL THEN expires_at ELSE now() + make_interval(days => $4) END,
          objective_key=coalesce($5,objective_key), observation_id=coalesce($6,observation_id), assessment_ref=coalesce($7,assessment_ref), intervention_id=coalesce($8,intervention_id), row_version=row_version+1, updated_at=now() WHERE id=$1`,
      [l.id, sealN(i.coach_note, NOTE), i.athlete_visible ?? null, i.expires_in_days ?? null, i.objective_key ?? null, i.observation_id ?? null, i.assessment_ref ?? null, i.intervention_id ?? null]);
    await audit(c, user.id, 'update_academy_clip', 'academy_clip_links', l.id);
    const n = await linkFor(user, l.id, c);
    return present(n.l, n.v, { annotations: true });
  }),
});

cap({
  name: 'add_academy_clip_annotation', method: 'POST', path: '/academy/clip-links/:id/annotations', tag: TAG, status: 201,
  summary: 'Pin a coach annotation (note, praise or fix) at a moment in the clip. Only while the clip is viewable; up to 200 per clip. The note is encrypted at rest.',
  input: z.object({ id, at_ms: z.number().int().min(0).max(14_400_000), kind: z.enum(['note', 'praise', 'fix']).default('note'), note: text(2, 400) }),
  handler: ({ user }, i) => tx(async (c) => {
    const { l, v } = await linkFor(user, i.id, c);
    needStaff(v);
    const reason = await gateOf(l);
    if (reason) throw conflict('This clip cannot be viewed right now, so it cannot be annotated', { code: 'clip_blocked', reason });
    if ((await c.query('SELECT count(*)::int AS n FROM academy_clip_annotations WHERE link_id=$1 AND removed_at IS NULL', [l.id])).rows[0].n >= 200) throw badRequest('This clip has the maximum of 200 annotations');
    const a = (await c.query('INSERT INTO academy_clip_annotations(link_id, at_ms, kind, note_enc, author_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, at_ms, kind, created_at', [l.id, i.at_ms, i.kind, encrypt(i.note, `${NOTE}.annotation`), user.id])).rows[0];
    await audit(c, user.id, 'add_academy_clip_annotation', 'academy_clip_links', l.id);
    return { ...a, note: i.note };
  }),
});

cap({
  name: 'remove_academy_clip_annotation', method: 'DELETE', path: '/academy/clip-annotations/:id', tag: TAG, input: z.object({ id }),
  summary: 'Remove an annotation (its author or an owner/admin/manager). It is soft-removed, never deleted.',
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT a.*, l.id AS lid FROM academy_clip_annotations a JOIN academy_clip_links l ON l.id=a.link_id WHERE a.id=$1 AND a.removed_at IS NULL', [i.id])).rows[0];
    if (!a) throw notFound('Annotation');
    const { v } = await linkFor(user, a.lid, c);
    needStaff(v);
    if (a.author_id !== user.id && !BROAD.includes(v.role)) throw forbidden('Only the author or a manager can remove this annotation');
    await c.query('UPDATE academy_clip_annotations SET removed_at=now() WHERE id=$1', [a.id]);
    await audit(c, user.id, 'remove_academy_clip_annotation', 'academy_clip_annotations', a.id);
    return { removed: true };
  }),
});

// ------------------------------------------------------------------------------------------------ revoke + athlete / guardian review
cap({
  name: 'revoke_academy_clip', method: 'POST', path: '/academy/clip-links/:id/revoke', tag: TAG, input: z.object({ id, reason: text(2, 300).optional() }),
  summary: 'Stop academy viewing of this clip now. Coaching staff, the athlete or a guardian can revoke. The link, notes and the development action are kept (nothing is deleted); the clip itself stays in the athlete\'s library. To share it again, link it again.',
  handler: ({ user }, i) => tx(async (c) => {
    const { l } = await linkFor(user, i.id, c);
    if (l.status === 'revoked') return { id: l.id, status: 'revoked', revoked_at: l.revoked_at };
    const r = (await c.query("UPDATE academy_clip_links SET status='revoked', revoked_at=now(), revoked_by=$2, revoke_reason=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id, status, revoked_at", [l.id, user.id, i.reason ?? null])).rows[0];
    await audit(c, user.id, 'revoke_academy_clip', 'academy_clip_links', l.id);
    return r;
  }),
});

cap({
  name: 'respond_academy_clip_review', method: 'POST', path: '/academy/clip-links/:id/review', tag: TAG,
  input: z.object({ id, state: z.enum(REVIEW), note: text(2, 400).optional() }),
  summary: 'The athlete or a guardian answers a shared clip: understood, need help, or a question (with an optional note). The coach who linked it is told when help or an answer is needed. Only while the clip is viewable.',
  handler: ({ user }, i) => tx(async (c) => {
    const { l, v } = await linkFor(user, i.id, c);
    if (isStaff(v)) throw forbidden('Only the athlete or a guardian answers a review');
    const reason = await gateOf(l);
    if (reason) throw conflict('This clip cannot be viewed right now', { code: 'clip_blocked', reason });
    const r = (await c.query("UPDATE academy_clip_links SET review_state=$2, review_note_enc=$3, reviewed_by=$4, reviewed_at=now(), first_viewed_at=coalesce(first_viewed_at, now()), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING id, review_state, reviewed_at", [l.id, i.state, sealN(i.note, `${NOTE}.review`), user.id])).rows[0];
    if (i.state !== 'understood') await notify(c, l.created_by, { kind: 'academy_clip_reply', title: 'An athlete replied to a video', body: 'Open Gotmygame to read the reply.', data: { clip_link_id: l.id }, dedupe_key: `academy:clip:reply:${l.id}:${i.state}` });
    await audit(c, user.id, 'respond_academy_clip_review', 'academy_clip_links', l.id);
    return r;
  }),
});

cap({
  name: 'list_my_academy_clips', method: 'GET', path: '/me/academy/clips', tag: TAG,
  input: z.object({ athlete_id: id.optional(), state: z.enum(['to_review', 'reviewed', 'blocked']).optional(), ...page }),
  summary: 'Your academy video review queue: clips coaches linked and made visible to you (a guardian passes athlete_id for their child). Each carries its live access state, its development action and your response. Blocked clips show why viewing stopped, never the video.',
  async handler({ user }, i) {
    const athleteId = i.athlete_id ?? user.id;
    if (athleteId !== user.id && !(await guardianLink(user.id, athleteId))) throw notFound('Athlete');
    const rows = await many(`${LINK} WHERE l.athlete_id=$1 AND l.athlete_visible ORDER BY l.created_at DESC, l.id LIMIT 200`, [athleteId]);
    const v = { kind: athleteId === user.id ? 'athlete' : 'guardian' };
    let items = [];
    for (const l of rows) items.push(await present(l, v));
    items = items.filter((x) => (i.state === 'to_review' ? x.access.ok && x.review_state === 'pending' : i.state === 'reviewed' ? x.access.ok && x.review_state !== 'pending' : i.state === 'blocked' ? !x.access.ok : true));
    await audit(null, user.id, 'list_my_academy_clips', 'users', athleteId);
    return { totals: { to_review: items.filter((x) => x.access.ok && x.review_state === 'pending').length, blocked: items.filter((x) => !x.access.ok).length, total: items.length }, items: items.slice(i.offset, i.offset + i.limit) };
  },
});

// ------------------------------------------------------------------------------------------------ binary: playback through the same live gate
export function academyClipFilesRouter() {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: config.isProd ? 120 : 2000, standardHeaders: true, legacyHeaders: false });
  r.get('/academy/clip-links/:id/file', limiter, async (req, res) => {
    try {
      const user = await authenticate(req.headers.authorization);
      if (!user) throw unauthorized();
      if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Clip');
      const { l } = await linkFor(user, req.params.id);
      if (await gateOf(l)) throw notFound('Clip');
      if (!l.file_name) throw notFound('Clip');
      await audit(null, user.id, 'play_academy_clip', 'academy_clip_links', l.id);
      let bytes;
      try { bytes = await loadEncrypted('passport', 'passport_videos.file', l.file_name); } catch (e) { throw e.code === 'ENOENT' ? notFound('File') : e; }
      res.set(docHeaders(l.content_type, bytes));
      res.end(bytes);
    } catch (e) { const { status, code, message, details } = toErrorBody(e); res.status(status).json({ error: { code, message, details } }); }
  });
  return r;
}
