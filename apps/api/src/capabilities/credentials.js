// Education pathways, part 3: certificates and badges. An institution issues one to a person it enrolled; the person decides whether it
// shows on their profile and passport; anyone with the code can check it is genuine and not revoked. Revoking keeps the record.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, sportBySlugOrId } from '../helpers.js';
import { notify } from '../notify.js';
import { orgFor } from '../org-access.js';
import { ADMISSIONS, addMessage, enquiryFor } from '../education.js';
import { guardianLink, guardiansOf, isYouth } from '../youth.js';

const TAG = 'Education';
const KINDS = ['certificate', 'badge', 'diploma', 'degree', 'course'];
const day = z.string().date();
const newCode = () => `GMG-${randomBytes(6).toString('hex').toUpperCase()}`;

const MINE = `c.id, c.kind, c.title, c.description, c.issued_on, c.expires_on, c.code, c.status, c.revoke_reason, c.show_on_profile, c.sport_id, c.programme_id, c.academy_programme_id, c.enrolment_id,
  (c.expires_on IS NOT NULL AND c.expires_on < current_date) AS expired, o.name AS institution, s.name AS sport, s.emoji AS sport_emoji`;

cap({
  name: 'issue_credential', method: 'POST', path: '/organisations/:id/credentials', tag: TAG, status: 201,
  summary: 'Admissions staff: issue a certificate, badge, diploma, degree or course credential to someone you enrolled: either an education enquiry at "enrolled" (enquiry_id), or an academy enrolment that is completed or graduated (enrolment_id). It gets a verification code anyone can check; the person (or their guardian, for a young person) is told and decides whether to show it on their profile.',
  input: z.object({ id, enquiry_id: id.optional(), enrolment_id: id.optional().describe('an academy enrolment that is completed or graduated'), kind: z.enum(KINDS), title: z.string().trim().min(2).max(120), description: z.string().max(1000).optional(), sport_id: id.optional().describe('defaults to the enquiry\'s or the programme\'s sport'), issued_on: day.optional(), expires_on: day.optional() })
    .refine((i) => !!i.enquiry_id !== !!i.enrolment_id, 'Give either enquiry_id or enrolment_id'),
  handler: ({ user }, i) => tx(async (c) => {
    const { org } = await orgFor(user, i.id, ADMISSIONS, { write: true, c });
    if (i.issued_on && i.expires_on && i.expires_on < i.issued_on) throw badRequest('expires_on is before issued_on');
    let holder, sportId = i.sport_id ?? null, source;
    if (i.enrolment_id) {
      const e = (await c.query(
        `SELECT e.*, k.organisation_id, p.title AS programme_title, p.sport FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN academy_programmes p ON p.id=e.programme_id WHERE e.id=$1 FOR UPDATE OF e`, [i.enrolment_id])).rows[0];
      if (!e || e.organisation_id !== org.id) throw notFound('Enrolment');
      if (!['completed', 'graduated'].includes(e.status)) throw conflict('Mark the enrolment completed or graduated before issuing a certificate');
      holder = e.user_id;
      sportId ??= (await sportBySlugOrId(e.sport))?.id ?? null;
      source = { enrolment_id: e.id, academy_programme_id: e.programme_id, enquiry_id: null, programme_id: null };
    } else {
      const { enq } = await enquiryFor(user, i.enquiry_id, { c, side: 'staff' });
      if (enq.organisation_id !== org.id) throw notFound('Enquiry');
      if (enq.status !== 'enrolled') throw conflict('Move the enquiry to "enrolled" before issuing a credential');
      holder = enq.athlete_id;
      sportId ??= enq.sport_id ?? null;
      source = { enrolment_id: null, academy_programme_id: null, enquiry_id: enq.id, programme_id: enq.programme_id };
    }
    if (sportId && !(await c.query('SELECT 1 FROM sports WHERE id=$1', [sportId])).rowCount) throw notFound('Sport');
    const youth = await isYouth(holder, c);
    let row;
    try {
      row = (await c.query(
        `INSERT INTO credentials(user_id, organisation_id, programme_id, enquiry_id, enrolment_id, academy_programme_id, sport_id, kind, title, description, issued_on, expires_on, code, issued_by, show_on_profile)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::date, current_date),$12,$13,$14,$15) RETURNING id, kind, title, issued_on, expires_on, code, status`,
        [holder, org.id, source.programme_id, source.enquiry_id, source.enrolment_id, source.academy_programme_id, sportId, i.kind, i.title, i.description ?? null, i.issued_on ?? null, i.expires_on ?? null, newCode(), user.id, !youth])).rows[0];   // a young person's credential is hidden from their profile until a guardian decides
    } catch (e) { if (e.code === '23505' && /credentials_enrolment_kind/.test(e.constraint ?? '')) throw conflict(`This enrolment already has a ${i.kind}`); throw e; }
    if (i.enquiry_id) await addMessage(c, (await enquiryFor(user, i.enquiry_id, { c, side: 'staff' })).enq, { senderId: user.id, side: 'system', kind: 'status', body: `${org.name} issued you: ${i.title}` });
    for (const uid of youth ? await guardiansOf(holder, c) : [holder]) {
      await notify(c, uid, { kind: 'credential_issued', title: `${org.name} issued a ${i.kind}`, body: youth ? 'Open Gotmygame to see it. You decide whether it shows on the profile.' : `${i.title}. It is on your profile; you can hide it any time in Pathways.`, data: { credential_id: row.id, organisation_id: org.id } });
    }
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
      `SELECT c.id, c.kind, c.title, c.issued_on, c.expires_on, c.code, c.status, c.revoke_reason, c.created_at, u.handle AS holder_handle, u.display_name AS holder_name, coalesce(p.title, ap.title) AS programme_title
         FROM credentials c JOIN users u ON u.id=c.user_id LEFT JOIN programmes p ON p.id=c.programme_id LEFT JOIN academy_programmes ap ON ap.id=c.academy_programme_id
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
  summary: 'Choose whether one of your credentials shows on your public profile and passport (a verified guardian chooses for a young person). Revoked or expired credentials never show.',
  input: z.object({ id, show_on_profile: z.boolean() }),
  async handler({ user }, i) {
    const cur = await one('SELECT id, user_id FROM credentials WHERE id=$1', [i.id]);
    if (!cur) throw notFound('Credential');
    // the holder decides; for a young person their verified guardian does (checked now, so revoking the link ends it)
    if (cur.user_id !== user.id && !(await guardianLink(user.id, cur.user_id))) throw notFound('Credential');
    return one('UPDATE credentials SET show_on_profile=$2 WHERE id=$1 RETURNING id, show_on_profile', [i.id, i.show_on_profile]);
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
