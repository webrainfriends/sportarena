// Education pathways, part 3: certificates and badges. An institution issues one to a person it enrolled; the person decides whether it
// shows on their profile and passport; anyone with the code can check it is genuine and not revoked. Revoking keeps the record.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { orgFor } from '../org-access.js';
import { ADMISSIONS, addMessage, enquiryFor } from '../education.js';

const TAG = 'Education';
const KINDS = ['certificate', 'badge', 'diploma', 'degree', 'course'];
const day = z.string().date();
const newCode = () => `GMG-${randomBytes(6).toString('hex').toUpperCase()}`;

const MINE = `c.id, c.kind, c.title, c.description, c.issued_on, c.expires_on, c.code, c.status, c.revoke_reason, c.show_on_profile, c.sport_id, c.programme_id,
  (c.expires_on IS NOT NULL AND c.expires_on < current_date) AS expired, o.name AS institution, s.name AS sport, s.emoji AS sport_emoji`;

cap({
  name: 'issue_credential', method: 'POST', path: '/organisations/:id/credentials', tag: TAG, status: 201,
  summary: 'Admissions staff: issue a certificate, badge, diploma, degree or course credential to someone you enrolled (their enquiry must be at "enrolled"). It gets a verification code anyone can check; the person is told and decides whether to show it on their profile.',
  input: z.object({ id, enquiry_id: id, kind: z.enum(KINDS), title: z.string().trim().min(2).max(120), description: z.string().max(1000).optional(), sport_id: id.optional().describe('defaults to the enquiry\'s sport'), issued_on: day.optional(), expires_on: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { org } = await orgFor(user, i.id, ADMISSIONS, { write: true, c });
    const { enq } = await enquiryFor(user, i.enquiry_id, { c, side: 'staff' });
    if (enq.organisation_id !== org.id) throw notFound('Enquiry');
    if (enq.status !== 'enrolled') throw conflict('Move the enquiry to "enrolled" before issuing a credential');
    const sportId = i.sport_id ?? enq.sport_id ?? null;
    if (sportId && !(await c.query('SELECT 1 FROM sports WHERE id=$1', [sportId])).rowCount) throw notFound('Sport');
    if (i.issued_on && i.expires_on && i.expires_on < i.issued_on) throw badRequest('expires_on is before issued_on');
    const row = (await c.query(
      `INSERT INTO credentials(user_id, organisation_id, programme_id, enquiry_id, sport_id, kind, title, description, issued_on, expires_on, code, issued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::date, current_date),$10,$11,$12) RETURNING id, kind, title, issued_on, expires_on, code, status`,
      [enq.athlete_id, org.id, enq.programme_id, enq.id, sportId, i.kind, i.title, i.description ?? null, i.issued_on ?? null, i.expires_on ?? null, newCode(), user.id])).rows[0];
    await addMessage(c, enq, { senderId: user.id, side: 'system', kind: 'status', body: `${org.name} issued you: ${i.title}` });
    await notify(c, enq.athlete_id, { kind: 'credential_issued', title: `${org.name} issued you a ${i.kind}`, body: `${i.title}. It is on your profile; you can hide it any time in Pathways.`, data: { credential_id: row.id } });
    await audit(c, user.id, 'issue_credential', 'credentials', row.id);
    return row;
  }),
});

cap({
  name: 'list_org_credentials', method: 'GET', path: '/organisations/:id/credentials', tag: TAG,
  summary: 'Admissions staff: credentials your institution issued, newest first, with the holder and whether each is still valid.',
  input: z.object({ id, status: z.enum(['issued', 'revoked']).optional(), ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, ADMISSIONS);
    return many(
      `SELECT c.id, c.kind, c.title, c.issued_on, c.expires_on, c.code, c.status, c.revoke_reason, c.created_at, u.handle AS holder_handle, u.display_name AS holder_name, p.title AS programme_title
         FROM credentials c JOIN users u ON u.id=c.user_id LEFT JOIN programmes p ON p.id=c.programme_id
        WHERE c.organisation_id=$1 AND ($2::text IS NULL OR c.status=$2) ORDER BY c.created_at DESC, c.id LIMIT $3 OFFSET $4`, [i.id, i.status ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'revoke_credential', method: 'POST', path: '/credentials/:id/revoke', tag: TAG,
  summary: 'Admissions staff: withdraw a credential you issued (for example issued in error). It stops showing on profiles and verifies as revoked. The record and the reason are kept.',
  input: z.object({ id, reason: z.string().trim().min(2).max(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM credentials WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Credential');
    const { org } = await orgFor(user, cur.organisation_id, ADMISSIONS, { write: true, c });
    if (cur.status === 'revoked') throw conflict('Already revoked');
    const row = (await c.query("UPDATE credentials SET status='revoked', revoked_at=now(), revoke_reason=$2 WHERE id=$1 RETURNING id, status, revoked_at", [cur.id, i.reason])).rows[0];
    await notify(c, cur.user_id, { kind: 'credential_revoked', title: `${org.name} withdrew a credential`, body: `"${cur.title}" was withdrawn: ${i.reason}`, data: { credential_id: cur.id } });
    await audit(c, user.id, 'revoke_credential', 'credentials', cur.id);
    return row;
  }),
});

cap({
  name: 'list_my_credentials', method: 'GET', path: '/me/credentials', tag: TAG,
  summary: 'Your certificates and badges, with the institution that issued each, whether it is still valid and whether it shows on your profile.',
  input: z.object({ ...page }),
  handler: ({ user }, i) => many(`SELECT ${MINE} FROM credentials c JOIN organisations o ON o.id=c.organisation_id LEFT JOIN sports s ON s.id=c.sport_id WHERE c.user_id=$1 ORDER BY c.issued_on DESC, c.created_at DESC LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]),
});

cap({
  name: 'set_credential_visibility', method: 'PATCH', path: '/me/credentials/:id', tag: TAG,
  summary: 'Choose whether one of your credentials shows on your public profile and passport. Revoked or expired credentials never show.',
  input: z.object({ id, show_on_profile: z.boolean() }),
  async handler({ user }, i) {
    const row = await one('UPDATE credentials SET show_on_profile=$3 WHERE id=$1 AND user_id=$2 RETURNING id, show_on_profile', [i.id, user.id, i.show_on_profile]);
    if (!row) throw notFound('Credential');
    return row;
  },
});

cap({
  name: 'verify_credential', method: 'GET', path: '/credentials/verify/:code', tag: TAG, auth: 'public',
  summary: 'Check a credential by its code: who issued it, what it is, and whether it is valid, expired or revoked. The holder\'s name is shown only if they chose to show the credential on their profile.',
  input: z.object({ code: z.string().trim().min(6).max(40) }),
  async handler(_, i) {
    const c = await one(
      `SELECT c.kind, c.title, c.issued_on, c.expires_on, c.status, c.show_on_profile, o.name AS institution, s.name AS sport, u.handle, u.display_name
         FROM credentials c JOIN organisations o ON o.id=c.organisation_id JOIN users u ON u.id=c.user_id LEFT JOIN sports s ON s.id=c.sport_id WHERE c.code=upper($1)`, [i.code]);
    if (!c) throw notFound('Credential');
    const expired = !!c.expires_on && new Date(c.expires_on) < new Date(new Date().toISOString().slice(0, 10));
    return {
      valid: c.status === 'issued' && !expired, status: c.status === 'revoked' ? 'revoked' : expired ? 'expired' : 'valid',
      kind: c.kind, title: c.title, institution: c.institution, sport: c.sport, issued_on: c.issued_on, expires_on: c.expires_on,
      holder: c.show_on_profile ? { handle: c.handle, display_name: c.display_name } : null,
    };
  },
});
