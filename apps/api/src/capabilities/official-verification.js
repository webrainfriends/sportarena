// Official verification of a person's standing (#479): an entitled organiser, official or academy asks the platform for a verified statement; an Official verifier
// (platform staff whose only job is these requests) answers it. The answer is a standing ATTESTATION - eligible / not eligible as of a date, with an expiry - and
// never the sanction type, the reason, the evidence or the competition it came from. Suspensions are not on any public surface; this is the one controlled outlet.
// The service is a platform report: it is open only to subjects that hold the `reports.official_verification` entitlement, and it stays closed until the platform
// has published a plan that grants it (an unpriced install denies, it does not allow).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound, AppError } from '../errors.js';
import { encrypt } from '../crypto.js';
import { audit, hasRole } from '../helpers.js';
import { requireApproved } from '../access.js';
import { mustBePlatformAdmin } from '../platform.js';
import { hasOrgGrant } from '../org-access.js';
import { notify } from '../notify.js';
import { requireConsent, isYouth } from '../youth.js';
import { resolveEntitlements, decide } from '../commercial/engine.js';
import { canManageCompetition } from './competitions.js';
import { blocksOn, BLOCKING_KINDS } from '../discipline.js';
import { serviceFor } from '../discipline-live.js';
import { activeSportingSanction } from '../integrity.js';

const TAG = 'Official verification';
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const SCOPE = 'admin';
export const ENTITLEMENT = 'reports.official_verification';
export const ATTESTATION_DAYS = 30;
const PURPOSES = ['event_entry', 'tournament_selection', 'academy_admission', 'official_appointment', 'other'];
const text = (n) => z.string().trim().max(n);

/** Platform staff who work the queue: the Official verifier role, or a platform admin (who keeps override access). */
const needVerifier = (user) => { if (!hasRole(user, 'official_verifier')) throw forbidden('Only an Official verifier can do that'); };

async function entitled(user, organisationId) {
  const asks = [['user', user.id], ...(organisationId ? [['organisation', organisationId]] : [])];
  for (const [type, sid] of asks) if (decide(await resolveEntitlements(type, sid), ENTITLEMENT).allowed) return { type, id: sid };
  throw new AppError(402, 'not_entitled', 'Official verification is a platform report: subscribe to the plan that includes it, then ask again', { key: ENTITLEMENT });
}
const nextNo = async (c) => `OV-${new Date().getUTCFullYear()}-${String((await c.query("SELECT nextval('disc_vreq_seq')::int AS n")).rows[0].n).padStart(5, '0')}`;
/** Is the person barred from a sport today? An integrity decision with a sporting sanction, or a live blocking disciplinary sanction in a competition of that sport. */
async function standingBlock(c, userId, sportId, day) {
  if (await activeSportingSanction(c, userId, sportId, day)) return true;
  const rows = (await c.query(
    `SELECT s.* FROM disc_sanctions s JOIN comp_competitions k ON k.id=s.competition_id
      WHERE s.subject_user_id=$1 AND s.superseded_at IS NULL AND s.status IN ('interim','active') AND s.kind = ANY($2::text[]) AND COALESCE(s.sport_id, k.sport_id)=$3`, [userId, BLOCKING_KINDS, sportId])).rows;
  for (const s of rows) if (blocksOn(s, day, s.kind === 'match_suspension' ? await serviceFor(c, s) : null)) return true;
  return false;
}
const REQ = `r.id, r.request_no, r.purpose, r.status, r.sport_id, r.competition_id, r.organisation_id, r.created_at, r.decided_at, s.name AS sport_name`;

// ------------------------------------------------------------------ the role (platform admin only)
cap({
  name: 'grant_official_verifier', method: 'POST', path: '/admin/official-verifiers', tag: TAG, status: 201, scope: SCOPE,
  summary: 'Platform admin only: give an existing account the Official verifier role - platform staff who handle official verification requests and nothing else. Never self-assignable, never shown publicly; the account must use two-step sign-in.',
  input: z.object({ user_id: id }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    return tx(async (c) => {
      const u = (await c.query('SELECT id, handle, display_name, roles FROM users WHERE id=$1 FOR UPDATE', [i.user_id])).rows[0];
      if (!u) throw notFound('Person');
      if (!u.roles.includes('official_verifier')) await c.query("UPDATE users SET roles = array_append(roles, 'official_verifier') WHERE id=$1", [u.id]);
      await audit(c, user.id, 'grant_official_verifier', 'users', u.id);
      return { id: u.id, handle: u.handle, display_name: u.display_name, official_verifier: true };
    });
  },
});
cap({
  name: 'revoke_official_verifier', method: 'DELETE', path: '/admin/official-verifiers/:id', tag: TAG, scope: SCOPE,
  summary: 'Platform admin only: take the Official verifier role away. The account, its other roles and every attestation it issued are kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);
    return tx(async (c) => {
      const u = (await c.query("UPDATE users SET roles = CASE WHEN cardinality(array_remove(roles,'official_verifier'))=0 THEN ARRAY['athlete'] ELSE array_remove(roles,'official_verifier') END WHERE id=$1 AND 'official_verifier' = ANY(roles) RETURNING id", [i.id])).rows[0];
      if (!u) throw notFound('Official verifier');
      await c.query("UPDATE disc_verification_requests SET status='submitted', verifier_id=NULL WHERE verifier_id=$1 AND status='in_review'", [i.id]);   // their open claims return to the queue
      await audit(c, user.id, 'revoke_official_verifier', 'users', u.id);
      return { id: u.id, official_verifier: false };
    });
  },
});
cap({
  name: 'list_official_verifiers', method: 'GET', path: '/admin/official-verifiers', tag: TAG, scope: SCOPE,
  summary: 'Platform admin only: who holds the Official verifier role and how many requests each has decided.',
  input: z.object({}),
  async handler({ user }) {
    await mustBePlatformAdmin(user);
    return many("SELECT u.id, u.handle, u.display_name, (SELECT count(*)::int FROM disc_verification_requests r WHERE r.verifier_id=u.id AND r.status='decided') AS decided FROM users u WHERE 'official_verifier' = ANY(u.roles) ORDER BY u.display_name");
  },
});

// ------------------------------------------------------------------ the requester
cap({
  name: 'request_official_verification', method: 'POST', path: '/official-verifications', tag: TAG, status: 201, scope: SCOPE,
  summary: 'Ask the platform to officially verify a person’s standing for a sport. For an event organiser, competition official or an academy that holds the platform-reports plan: you must act for a competition you run or an organisation you own/administer. A young person needs current guardian consent. The result is an attestation (eligible / not eligible as of a date), never the reason.',
  input: z.object({ subject_user_id: id, sport_id: id, purpose: z.enum(PURPOSES), competition_id: id.optional(), organisation_id: id.optional(), note: text(1000).optional() }),
  async handler({ user }, i) {
    await requireApproved(user);
    if (i.subject_user_id === user.id) throw badRequest('You cannot request an official verification of yourself');
    if (!i.competition_id && !i.organisation_id) throw badRequest('Say which competition or organisation you are asking for');
    return tx(async (c) => {
      let orgId = i.organisation_id ?? null;
      if (i.competition_id) {
        const cm = (await c.query('SELECT * FROM comp_competitions WHERE id=$1', [i.competition_id])).rows[0];
        if (!cm || !(await canManageCompetition(user, cm, c))) throw notFound('Competition');
        orgId ??= cm.organisation_id ?? null;
      } else if (!(await hasOrgGrant(user, i.organisation_id, ['owner', 'admin'], c))) throw notFound('Organisation');
      await entitled(user, orgId);
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.subject_user_id])).rowCount) throw notFound('Person');
      if (!(await c.query('SELECT 1 FROM sports WHERE id=$1', [i.sport_id])).rowCount) throw notFound('Sport');
      if (await isYouth(i.subject_user_id, c)) await requireConsent(i.subject_user_id, 'participation', 'an official verification of their standing', c);
      const r = (await c.query(
        'INSERT INTO disc_verification_requests(request_no, requester_id, organisation_id, subject_user_id, sport_id, competition_id, purpose, note_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, request_no, status, purpose, created_at',
        [await nextNo(c), user.id, orgId, i.subject_user_id, i.sport_id, i.competition_id ?? null, i.purpose, i.note ? encrypt(i.note, 'disc_verification_requests.note') : null])).rows[0];
      const verifiers = (await c.query("SELECT id FROM users WHERE 'official_verifier' = ANY(roles) AND id <> $1", [user.id])).rows;
      for (const v of verifiers) await notify(c, v.id, { kind: 'official_verification_request', title: 'A verification request is waiting', body: `Request ${r.request_no} is in the queue.`, data: { request_id: r.id }, dedupe_key: `ov:${r.id}:${v.id}` });
      await audit(c, user.id, 'official_verification_requested', 'disc_verification_requests', r.id);
      return r;
    });
  },
});
cap({
  name: 'list_my_official_verifications', method: 'GET', path: '/me/official-verifications', tag: TAG, scope: SCOPE,
  summary: 'The verification requests I made, with the attestation once decided (result, date and expiry only).',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT ${REQ}, u.display_name AS subject_name, a.id AS attestation_id, a.result, a.as_of::text AS as_of, a.valid_until::text AS valid_until, (a.revoked_at IS NOT NULL) AS revoked,
              (a.id IS NOT NULL AND a.revoked_at IS NULL AND a.valid_until >= current_date) AS valid
         FROM disc_verification_requests r JOIN sports s ON s.id=r.sport_id JOIN users u ON u.id=r.subject_user_id
         LEFT JOIN disc_attestations a ON a.request_id=r.id AND a.revoked_at IS NULL
        WHERE r.requester_id=$1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);
    return rows;
  },
});
cap({
  name: 'withdraw_official_verification', method: 'POST', path: '/official-verifications/:id/withdraw', tag: TAG, scope: SCOPE,
  summary: 'Withdraw a request that has not been decided.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one("UPDATE disc_verification_requests SET status='withdrawn' WHERE id=$1 AND requester_id=$2 AND status IN ('submitted','in_review') RETURNING id, status", [i.id, user.id]);
    if (!r) throw notFound('Request');
    return r;
  },
});

// ------------------------------------------------------------------ the Official verifier's queue
cap({
  name: 'list_verifier_queue', method: 'GET', path: '/verifier/queue', tag: TAG, auth: ['official_verifier'], scope: SCOPE,
  summary: 'Official verifier only: the verification requests waiting (submitted) or claimed by me (in review). Shows who asked, for what and why; never a date of birth or contact details.',
  input: z.object({ status: z.enum(['submitted', 'in_review', 'decided']).default('submitted'), ...page }),
  async handler({ user }, i) {
    needVerifier(user);
    return many(
      `SELECT ${REQ}, r.requester_id, rq.display_name AS requester_name, org.name AS organisation_name, c.name AS competition_name, u.display_name AS subject_name, (r.verifier_id = $2) AS mine
         FROM disc_verification_requests r JOIN sports s ON s.id=r.sport_id JOIN users u ON u.id=r.subject_user_id JOIN users rq ON rq.id=r.requester_id
         LEFT JOIN organisations org ON org.id=r.organisation_id LEFT JOIN comp_competitions c ON c.id=r.competition_id
        WHERE r.status=$1 AND ($1 = 'submitted' OR r.verifier_id=$2 OR $3::boolean) ORDER BY r.created_at LIMIT $4 OFFSET $5`, [i.status, user.id, user.roles.includes('admin'), i.limit, i.offset]);
  },
});
cap({
  name: 'claim_verification_request', method: 'POST', path: '/verifier/requests/:id/claim', tag: TAG, auth: ['official_verifier'], scope: SCOPE,
  summary: 'Official verifier only: take a request. You cannot take a request you made or one about yourself. Two verifiers cannot take the same request.',
  input: z.object({ id }),
  async handler({ user }, i) {
    needVerifier(user);
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM disc_verification_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      if (r.requester_id === user.id || r.subject_user_id === user.id) throw forbidden('You cannot verify a request you made or one about yourself');
      if (r.status !== 'submitted') throw conflict('That request has already been taken or decided');
      await c.query("UPDATE disc_verification_requests SET status='in_review', verifier_id=$2 WHERE id=$1", [i.id, user.id]);
      await audit(c, user.id, 'official_verification_claimed', 'disc_verification_requests', i.id);
      return { id: i.id, status: 'in_review' };
    });
  },
});
cap({
  name: 'decide_verification_request', method: 'POST', path: '/verifier/requests/:id/decision', tag: TAG, status: 201, auth: ['official_verifier'], scope: SCOPE,
  summary: 'Official verifier only: issue the attestation for a request you claimed. The server reads the person’s disciplinary and integrity standing itself and records eligible / not eligible as of today, valid for 30 days; you may instead record unable_to_verify. Neither the verifier’s screen nor the attestation shows a sanction, reason or evidence.',
  input: z.object({ id, unable_to_verify: z.boolean().default(false), note: text(1000).optional() }),
  async handler({ user }, i) {
    needVerifier(user);
    return tx(async (c) => {
      const r = (await c.query('SELECT * FROM disc_verification_requests WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!r) throw notFound('Request');
      if (r.verifier_id !== user.id || r.status !== 'in_review') throw conflict('Claim the request first; only its verifier can decide it');
      if (r.requester_id === user.id || r.subject_user_id === user.id) throw forbidden('You cannot verify a request you made or one about yourself');
      const blocked = i.unable_to_verify ? null : await standingBlock(c, r.subject_user_id, r.sport_id, today());
      const result = i.unable_to_verify ? 'unable_to_verify' : blocked ? 'not_eligible' : 'eligible';
      const a = (await c.query('INSERT INTO disc_attestations(request_id, result, as_of, valid_until, issued_by) VALUES ($1,$2,current_date,$3::date,$4) RETURNING id, result, as_of::text AS as_of, valid_until::text AS valid_until',
        [r.id, result, addDays(today(), ATTESTATION_DAYS), user.id])).rows[0];
      await c.query("UPDATE disc_verification_requests SET status='decided', decided_at=now() WHERE id=$1", [r.id]);
      await notify(c, r.requester_id, { kind: 'official_verification_ready', title: 'Your verification is ready', body: `Request ${r.request_no} has been answered.`, data: { request_id: r.id }, dedupe_key: `ovr:${r.id}` });
      await audit(c, user.id, 'official_verification_decided', 'disc_verification_requests', r.id);
      return a;
    });
  },
});
cap({
  name: 'revoke_verification_attestation', method: 'POST', path: '/verifier/attestations/:id/revoke', tag: TAG, auth: ['official_verifier'], scope: SCOPE,
  summary: 'Official verifier only: withdraw an attestation that should not stand (for example the standing changed). The record is kept as revoked; the requester is told only that it is no longer valid.',
  input: z.object({ id, reason: text(500).min(3) }),
  async handler({ user }, i) {
    needVerifier(user);
    return tx(async (c) => {
      const a = (await c.query('UPDATE disc_attestations SET revoked_at=now(), revoked_by=$2 WHERE id=$1 AND revoked_at IS NULL RETURNING id, request_id', [i.id, user.id])).rows[0];
      if (!a) throw notFound('Attestation');
      const r = (await c.query('SELECT requester_id, request_no FROM disc_verification_requests WHERE id=$1', [a.request_id])).rows[0];
      await notify(c, r.requester_id, { kind: 'official_verification_revoked', title: 'A verification is no longer valid', body: `The result for request ${r.request_no} no longer stands.`, data: { request_id: a.request_id }, dedupe_key: `ovx:${a.id}` });
      await audit(c, user.id, 'official_verification_revoked', 'disc_attestations', a.id);
      return { id: a.id, revoked: true };
    });
  },
});
