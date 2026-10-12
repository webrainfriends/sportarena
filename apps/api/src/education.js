// Shared pieces of the education pathways: who may run admissions, how an enquiry thread is stored and who may open it.
// Staff = organisation owner/admin (membership is read live, so removing someone cuts access immediately).
import { pool, many } from './db.js';
import { conflict, forbidden, notFound } from './errors.js';
import { decrypt, encrypt } from './crypto.js';
import { audit } from './helpers.js';
import { orgRole } from './org-access.js';

export const ADMISSIONS = ['owner', 'admin'];
export const PIPELINE_OPEN = ['new', 'in_conversation', 'referred', 'applied', 'admitted'];
export const STAFF_STATUSES = ['in_conversation', 'applied', 'admitted', 'enrolled', 'declined', 'closed'];

export const sealBody = (text) => encrypt(text, 'enquiry_messages.body');
export const openBody = (enc) => decrypt(enc, 'enquiry_messages.body');

/** Admissions staff of an active organisation (the people told about new enquiries and replies). */
export async function staffIds(c, orgId) {
  const { rows } = await (c ?? pool).query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role = ANY($2)", [orgId, ADMISSIONS]);
  return rows.map((r) => r.user_id);
}

/**
 * An enquiry plus the caller's side of it: the athlete who sent it, or admissions staff of the institution. Anyone else gets 404, so
 * the existence of an enquiry is not leaked. `write` also requires the institution to be active.
 */
export async function enquiryFor(user, enquiryId, { c = pool, write = false, side } = {}) {
  const enq = (await c.query('SELECT * FROM enquiries WHERE id=$1', [enquiryId])).rows[0];
  if (!enq) throw notFound('Enquiry');
  const mine = enq.athlete_id === user.id;
  const role = mine ? null : await orgRole(user, enq.organisation_id, c);
  const staff = !!role && ADMISSIONS.includes(role);
  if (!mine && !staff) throw notFound('Enquiry');
  if (side === 'staff' && !staff) throw forbidden('Only the institution\'s admissions team can do that');
  if (side === 'athlete' && !mine) throw forbidden('Only the athlete who sent the enquiry can do that');
  const org = (await c.query('SELECT * FROM organisations WHERE id=$1', [enq.organisation_id])).rows[0];
  if (write && staff && !mine && org.status !== 'active') throw conflict('This organisation is archived and read-only');
  return { enq, org, side: mine ? 'athlete' : 'staff' };
}

/** Add a line to an enquiry thread and bump its activity time. */
export async function addMessage(c, enq, { senderId = null, side, kind = 'message', body, brochureId = null, linkUrl = null, broadcastId = null }) {
  const row = (await c.query(
    `INSERT INTO enquiry_messages(enquiry_id, sender_id, side, kind, body_enc, brochure_id, link_url, broadcast_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, side, kind, created_at`,
    [enq.id, senderId, side, kind, sealBody(body), brochureId, linkUrl, broadcastId])).rows[0];
  await c.query(
    `UPDATE enquiries SET last_message_at=now(), updated_at=now(),
            athlete_read_at = CASE WHEN $2 = 'athlete' THEN now() ELSE athlete_read_at END,
            staff_read_at = CASE WHEN $2 = 'institution' THEN now() ELSE staff_read_at END WHERE id=$1`, [enq.id, side]);
  return row;
}

/** A private audit entry whenever admissions staff open an athlete's enquiry content. */
export const auditEnquiryRead = (user, enquiryId) => audit(null, user.id, 'read_pii', 'enquiries', enquiryId);

/** Credentials that may be shown publicly on a profile or passport: issued, not expired, and the holder left them visible. */
export const profileCredentials = (userId) => many(
  `SELECT c.id, c.kind, c.title, c.description, c.issued_on, c.expires_on, c.code, o.name AS institution, s.slug AS sport_slug, s.name AS sport, s.emoji AS sport_emoji
     FROM credentials c JOIN organisations o ON o.id=c.organisation_id LEFT JOIN sports s ON s.id=c.sport_id
    WHERE c.user_id=$1 AND c.status='issued' AND c.show_on_profile AND (c.expires_on IS NULL OR c.expires_on >= current_date) ORDER BY c.issued_on DESC, c.created_at DESC LIMIT 100`, [userId]);
