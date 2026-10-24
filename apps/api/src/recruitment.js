// Player recruitment pipeline engine (issue #314). Shared by the Billboard capabilities (legacy accept/decline) and the recruitment
// capabilities so every path goes through the same stage rules, versioning, history and roster side-effects.
import { one } from './db.js';
import { conflict, forbidden } from './errors.js';
import { isAdmin } from './helpers.js';
import { notify } from './notify.js';
import { openRosterStint } from './career.js';
import { guardianLink, guardiansOf, hasConsent, isYouth } from './youth.js';
import { canManageTeam } from './capabilities/teams.js';

export const STAGES = ['applied', 'shortlisted', 'trial', 'evaluated', 'offered', 'accepted', 'declined', 'withdrawn'];
export const OPEN_STAGES = ['applied', 'shortlisted', 'trial', 'evaluated', 'offered'];
export const CONSENT_PURPOSE = 'recruitment_sharing';

/** Where staff may move a candidate. Offers, evaluations, trials and the applicant's own decisions have their own capabilities. */
export const STAFF_MOVES = {
  applied: ['shortlisted', 'declined'],
  shortlisted: ['declined'],
  trial: ['declined'],
  evaluated: ['declined'],
  offered: ['declined'],
};

/** The legacy billboard_responses.status that matches a stage (older screens, queries and tests still read it). */
export const legacyStatus = (stage) => (stage === 'accepted' || stage === 'declined' || stage === 'withdrawn' ? stage : 'pending');

export const stale = (cur) => conflict('This application was changed elsewhere. Reload and try again.', { code: 'stale_version', row_version: cur.row_version });
export const badStage = (from, to) => conflict(`An application at "${from}" cannot move to "${to}"`, { code: 'invalid_transition', from, to });

/** Post authors, platform admins and people who manage the post's team may run its pipeline. */
export async function isStaff(user, post) {
  if (!user) return false;
  if (isAdmin(user) || post.author_id === user.id) return true;
  if (!post.team_id) return false;
  const team = await one('SELECT * FROM teams WHERE id=$1', [post.team_id]);
  return !!team && (await canManageTeam(user, team));
}

/** Staff may only act on (or see) a young applicant while a guardian's consent is current; revocation takes effect on the next call. */
export const consentOk = (userId, client) => hasConsent(userId, CONSENT_PURPOSE, client);

/**
 * How is `user` related to this application? 'self' (the applicant), 'guardian' (verified guardian of a young applicant) or 'admin'.
 * A young person may always read and withdraw their own application; accepting an offer is a guardian decision.
 */
export async function applicantRole(user, resp, { decide = false } = {}, client) {
  if (isAdmin(user)) return 'admin';
  if (user.id === resp.responder_id) {
    // reading and withdrawing never depend on consent (ending recruitment sharing must always be possible); only accepting an offer is a guardian's decision
    if (decide && (await isYouth(user.id, client))) throw forbidden('A parent or guardian needs to decide on an offer for you');
    return 'self';
  }
  if (await guardianLink(user.id, resp.responder_id, client)) return 'guardian';
  throw forbidden();
}

/** The earlier answer to a retried request (same idempotency key), if any. */
export const replayed = (c, responseId, key) => (key ? c.query('SELECT * FROM recruitment_events WHERE response_id=$1 AND idempotency_key=$2', [responseId, key]).then((r) => r.rows[0] ?? null) : null);

export async function logEvent(c, resp, kind, { from = null, to = null, actor = null, note = null, key = null } = {}) {
  await c.query('INSERT INTO recruitment_events(response_id, kind, from_stage, to_stage, actor_id, note, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [resp.id, kind, from, to, actor, note, key]);
}

/** Lock the application row; a stale row_version is rejected so two staff members never overwrite each other. */
export async function lockResponse(c, id, version) {
  const r = (await c.query('SELECT * FROM billboard_responses WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!r) return null;
  if (version != null && r.row_version !== version) throw stale(r);
  return r;
}

/** Move to a new stage: keeps the legacy status in sync, bumps row_version and writes the history event. */
export async function setStage(c, resp, to, { kind = 'stage', actor, note, key, set = '', params = [] } = {}) {
  const { rows: [row] } = await c.query(
    `UPDATE billboard_responses SET stage=$2, status=$3, row_version=row_version+1, stage_changed_at=now()${set} WHERE id=$1 RETURNING *`,
    [resp.id, to, legacyStatus(to), ...params]);
  await logEvent(c, resp, kind, { from: resp.stage, to, actor, note, key });
  return row;
}

/** Tell the applicant, and the verified guardians of a young applicant. Generic wording only; detail stays in the authenticated app. */
export async function notifyApplicant(c, resp, post, kind, title, body, dedupe) {
  const to = new Set([resp.responder_id, ...(await guardiansOf(resp.responder_id, c))]);
  for (const uid of to) {
    await notify(c, uid, { kind, title, body, data: { post_id: post.id, response_id: resp.id }, dedupe_key: `recruit:${resp.id}:${dedupe}:${uid}` });
  }
}

/** Offers past their deadline lapse. The application returns to the stage before the offer so staff can re-offer; history is kept. */
export async function sweepExpired(c, responseId = null) {
  // same lock order as every mutation: the application row first, then its offer (ordered by id so two sweeps never wait on each other)
  const { rows: due } = await c.query(
    `SELECT DISTINCT response_id FROM recruitment_offers WHERE status='open' AND deadline_at < now() AND ($1::uuid IS NULL OR response_id=$1) ORDER BY response_id`, [responseId]);
  let n = 0;
  for (const { response_id } of due) {
    const r = (await c.query('SELECT * FROM billboard_responses WHERE id=$1 FOR UPDATE', [response_id])).rows[0];
    const o = (await c.query("SELECT id, version FROM recruitment_offers WHERE response_id=$1 AND status='open' AND deadline_at < now() FOR UPDATE", [response_id])).rows[0];
    if (!o) continue; // answered or replaced while we waited for the lock
    await c.query("UPDATE recruitment_offers SET status='expired', decided_at=now() WHERE id=$1", [o.id]);
    if (r.stage === 'offered') {
      const evaluated = (await c.query('SELECT 1 FROM recruitment_evaluations WHERE response_id=$1 LIMIT 1', [r.id])).rows.length;
      await setStage(c, r, evaluated ? 'evaluated' : 'shortlisted', { kind: 'offer_expired', note: `Offer v${o.version} expired` });
    }
    n++;
  }
  return n;
}

/** Take the person on: team roster + career stint (same path the Billboard has always used), then fill the post when all positions are taken. */
export async function acceptIntoTeam(c, post, resp, { role, rate_cents, rate_unit, fromOffer = false } = {}) {
  if (post.status !== 'open') throw conflict('This post is no longer open');
  if ((post.kind === 'team_recruiting' || post.kind === 'coach_wanted') && post.team_id) {
    const r = role ?? (post.kind === 'coach_wanted' ? 'coach' : 'player');
    await c.query(
      `INSERT INTO team_members(team_id, user_id, role, status, rate_cents, rate_unit) VALUES ($1,$2,$3,'active',$4,coalesce($5,'match'))
       ON CONFLICT (team_id, user_id) DO UPDATE SET status='active', role=CASE WHEN team_members.status='active' AND team_members.role IN ('manager','captain') THEN team_members.role ELSE EXCLUDED.role END, rate_cents=coalesce(EXCLUDED.rate_cents, team_members.rate_cents), rate_unit=EXCLUDED.rate_unit`,
      // a versioned offer's terms are final (an offer that leaves the rate open stays open); only the legacy direct accept falls back to the post's advertised rate
      [post.team_id, resp.responder_id, r, fromOffer ? rate_cents : (rate_cents ?? post.budget_cents), fromOffer ? rate_unit : (rate_unit ?? post.rate_unit)]);
    await openRosterStint(c, (await c.query('SELECT * FROM teams WHERE id=$1', [post.team_id])).rows[0], resp.responder_id, r, null, null, resp.responder_id);
  }
}

/** After an acceptance is stored: mark the post filled once every position is taken. */
export async function fillIfFull(c, post) {
  const n = (await c.query("SELECT count(*)::int AS n FROM billboard_responses WHERE post_id=$1 AND stage='accepted'", [post.id])).rows[0].n;
  if (n >= post.positions_needed) await c.query("UPDATE billboard_posts SET status='filled' WHERE id=$1", [post.id]);
}
