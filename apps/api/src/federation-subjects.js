// Federation & Governing Body OS (#475): who may see and act on an affiliation, a licence or a sanction, and the evidence attached to them.
// Two sides only: the body's staff (scoped roles, read live) and the other party (the club's owner/admin, the licence holder or their verified guardian,
// the event's organiser). Anyone else gets a 404, so existence of a record is never leaked.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.js';
import { orgRole, hasOrgGrant } from './org-access.js';
import { encrypt, decrypt } from './crypto.js';
import { audit } from './helpers.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { authority, can, isGuardianOf, plain } from './federation.js';

export const TABLE = { affiliation: 'fed_affiliations', licence: 'fed_licences', sanction: 'fed_sanctions' };
// While the other party may still add or remove evidence.
const EDITABLE = { affiliation: ['draft', 'needs_info'], licence: ['draft', 'needs_info'], sanction: ['requested', 'needs_info'] };
const MAX_FILE = 5 * 2 ** 20, MAX_EVIDENCE = 30;

/** The record, the caller's staff authority over its body (if any) and whether the caller is the other party. 404 if neither. */
export async function subjectFor(user, type, subjectId, { c = pool, lock = false } = {}) {
  const row = plain((await c.query(`SELECT * FROM ${TABLE[type]} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [subjectId])).rows[0]);
  if (!row) throw notFound(type[0].toUpperCase() + type.slice(1));
  const auth = await authority(user, row.body_id, { c, optional: true });
  let party = false, sportId = null, extra = {};
  if (type === 'affiliation') {
    party = ['owner', 'admin'].includes(await orgRole(user, row.organisation_id, c));
    sportId = (await c.query('SELECT sport_id FROM fed_affiliation_categories WHERE id=$1', [row.category_id])).rows[0]?.sport_id ?? null;
  } else if (type === 'licence') {
    party = row.holder_id === user.id || await isGuardianOf(user.id, row.holder_id, c);
    sportId = (await c.query('SELECT sport_id FROM fed_licence_types WHERE id=$1', [row.type_id])).rows[0]?.sport_id ?? null;
  } else {
    const ev = plain((await c.query('SELECT id, name, sport_id, organizer_id AS organiser_id, organisation_id, venue_id, starts_on, ends_on, status FROM events WHERE id=$1', [row.event_id])).rows[0]);
    party = ev.organiser_id === user.id || await hasOrgGrant(user, ev.organisation_id, ['owner', 'admin'], c);
    sportId = ev.sport_id; extra = { event: ev };
  }
  if (!auth && !party) throw notFound(type[0].toUpperCase() + type.slice(1));
  return { type, row, auth, party, sportId, ...extra };
}
/** Staff with the given permission on this record's body and sport. */
export const staffCan = (s, perm) => !!s.auth && can(s.auth, perm, s.sportId);
export function needStaff(s, perm) { if (!staffCan(s, perm)) throw forbidden(`Your role on ${s.auth?.body?.name ?? 'this body'} does not allow that`); }

/** Everyone who should hear about a body's new work: owners/admins plus holders of the matching role. */
export async function staffRecipients(c, body, roles) {
  const r = await c.query(
    `SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('owner','admin')
     UNION SELECT user_id FROM governing_body_roles WHERE body_id=$2 AND status='active' AND role = ANY($3)`, [body.organisation_id, body.id, roles]);
  return r.rows.map((x) => x.user_id);
}

// ------------------------------------------------------------------ evidence
export const evidenceIn = z.object({
  requirement: z.string().trim().min(1).max(80).describe('which requirement this evidences, e.g. "Constitution" or "First-aid certificate"'),
  reference: z.string().trim().min(2).max(500).optional().describe('registration number or https link'),
  file_name: z.string().max(120).optional(), data: z.string().max(7_200_000).optional().describe('base64 file: PDF, JPEG, PNG or WebP, up to 5 MB'),
}).refine((e) => e.reference || e.data, 'Give a reference (number or link) or attach a file');

function sniffDoc(b) {
  const hex = b.subarray(0, 8).toString('hex'), txt = b.subarray(0, 12).toString('latin1');
  if (txt.startsWith('%PDF-')) return 'application/pdf';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex === '89504e470d0a1a0a') return 'image/png';
  if (txt.startsWith('RIFF') && txt.slice(8) === 'WEBP') return 'image/webp';
  return null;
}
export const EVIDENCE_COLS = `e.id, e.requirement, e.file_name, e.content_type, e.size_bytes, e.sha256, e.created_at, (e.reference_enc IS NOT NULL) AS has_reference, (e.file_enc IS NOT NULL) AS has_file`;

export function editableBy(s) {
  if (!s.party) throw forbidden('Only the applicant can change the evidence');
  if (!EDITABLE[s.type].includes(s.row.status)) throw conflict(`Evidence can only be changed while the application is ${EDITABLE[s.type].join(' or ')}`);
}

export async function addEvidence(c, s, user, e) {
  editableBy(s);
  const n = (await c.query('SELECT count(*)::int AS n FROM fed_evidence WHERE subject_type=$1 AND subject_id=$2 AND removed_at IS NULL', [s.type, s.row.id])).rows[0].n;
  if (n >= MAX_EVIDENCE) throw conflict(`At most ${MAX_EVIDENCE} items per application`);
  if (e.reference && /^[a-z]+:\/\//i.test(e.reference) && !/^https:\/\//i.test(e.reference)) throw badRequest('Links must use https');
  const out = { reference_enc: e.reference ? encrypt(e.reference, 'fed_evidence.reference') : null, file_name: null, content_type: null, size_bytes: null, sha256: null, file_enc: null };
  if (e.data) {
    const b64 = e.data.replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 16) throw badRequest('That file is empty');
    if (buf.length > MAX_FILE) throw badRequest(`Files can be up to ${MAX_FILE / 2 ** 20} MB`);
    const type = sniffDoc(buf);
    if (!type) throw badRequest('Unsupported file. Use PDF, JPEG, PNG or WebP.');
    Object.assign(out, { file_name: (e.file_name ?? 'document').replace(/[^\w. -]/g, '_').slice(0, 120), content_type: type, size_bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), file_enc: encrypt(b64, 'fed_evidence.file') });
  }
  const r = (await c.query(
    `INSERT INTO fed_evidence(body_id, subject_type, subject_id, requirement, reference_enc, file_name, content_type, size_bytes, sha256, file_enc, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, requirement, file_name, content_type, size_bytes, created_at`,
    [s.row.body_id, s.type, s.row.id, e.requirement, out.reference_enc, out.file_name, out.content_type, out.size_bytes, out.sha256, out.file_enc, user.id])).rows[0];
  return r;
}
export const evidenceList = async (type, id, c = pool) => (await c.query(`SELECT ${EVIDENCE_COLS} FROM fed_evidence e WHERE e.subject_type=$1 AND e.subject_id=$2 AND e.removed_at IS NULL ORDER BY e.created_at, e.id`, [type, id])).rows;

/** Decrypt one item for a reviewer (or the applicant). Every read is audit-logged. */
export async function readEvidence(c, s, user, evidenceId) {
  if (!s.party && !staffCan(s, 'evidence')) throw forbidden('Your role does not allow reading evidence');
  const e = (await c.query('SELECT * FROM fed_evidence WHERE id=$1 AND subject_type=$2 AND subject_id=$3 AND removed_at IS NULL', [evidenceId, s.type, s.row.id])).rows[0];
  if (!e) throw notFound('Evidence');
  await audit(c, user.id, 'read_pii', 'fed_evidence', e.id);
  return { id: e.id, requirement: e.requirement, reference: e.reference_enc ? decrypt(e.reference_enc, 'fed_evidence.reference') : null,
    file: e.file_enc ? { name: e.file_name, content_type: e.content_type, size_bytes: e.size_bytes, sha256: e.sha256, data: decrypt(e.file_enc, 'fed_evidence.file') } : null };
}
export async function removeEvidence(c, s, evidenceId) {
  editableBy(s);
  const r = await c.query('UPDATE fed_evidence SET removed_at=now() WHERE id=$1 AND subject_type=$2 AND subject_id=$3 AND removed_at IS NULL RETURNING id', [evidenceId, s.type, s.row.id]);
  if (!r.rowCount) throw notFound('Evidence');
  return { removed: true };
}
/** Which of the required labels have at least one live evidence item. */
export async function missingDocuments(c, type, id, required) {
  if (!required?.length) return [];
  const have = new Set((await c.query('SELECT lower(requirement) AS r FROM fed_evidence WHERE subject_type=$1 AND subject_id=$2 AND removed_at IS NULL', [type, id])).rows.map((x) => x.r));
  return required.filter((l) => !have.has(l.toLowerCase()));
}
