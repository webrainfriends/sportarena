// Doctor workspace (issue #212, slice 3a): sports clearance decisions - issue, supersede, withdraw, list.
// Only a currently verified doctor with the athlete's full consent can decide; the decision is separate from a consultation being paid/completed
// and from rehab progress. Decisions are immutable; a newer decision supersedes the live one for the same athlete+sport (both stay), and a doctor
// can withdraw one. Expiry makes the fit-to-play projection `expired` (see src/clearance.js) instead of leaving a stale "cleared".
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { notify } from '../notify.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';

const t = (n) => z.string().trim().max(n);
const day = z.string().date();
const lockGrant = async (c, athleteId, providerId) => {
  if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [athleteId, providerId])).rows[0]) throw forbidden('The athlete has not granted you access');
};
const COLS = 'c.id, c.athlete_id, c.doctor_id, c.sport_id, c.activity, c.status, c.assessed_on, c.valid_until, c.review_by, c.supersedes_id, c.superseded_at, c.withdrawn_at, c.created_at';
const shape = (r, full) => ({ ...Object.fromEntries(COLS.replaceAll('c.', '').split(', ').map((k) => [k, r[k]])), doctor_name: r.doctor_name, state: r.withdrawn_at ? 'withdrawn' : r.superseded_at ? 'superseded' : r.valid_until && new Date(r.valid_until) < new Date(new Date().toDateString()) ? 'expired' : 'current',
  restrictions: r.restrictions_enc ? JSON.parse(decrypt(r.restrictions_enc, 'clinical_clearances.restrictions')) : [], ...(full ? { internal_note: r.internal_note_enc ? decrypt(r.internal_note_enc, 'clinical_clearances.note') : null, withdrawn_reason: r.withdrawn_reason_enc ? decrypt(r.withdrawn_reason_enc, 'clinical_clearances.withdrawn') : null } : {}) });

cap({
  name: 'issue_clearance', credential: true, method: 'POST', path: '/medical/clearances', tag: 'Health', auth: ['doctor'], status: 201,
  summary: 'Doctor records a sports clearance decision: cleared / restricted / not_cleared, with the assessment date, sport/activity context, graded restrictions, a validity end (required unless not_cleared) and optional review date. `restrictions` are shared with authorised coaches and team staff - write what the athlete may or may not do, never a diagnosis; use `internal_note` for anything private. A new decision supersedes the live one for the same athlete and sport (both kept). Not tied to payment or rehab completion.',
  input: z.object({ athlete_id: id, sport_id: id.optional(), activity: t(120).optional(), status: z.enum(['cleared', 'restricted', 'not_cleared']), restrictions: z.array(z.object({ activity: t(120).min(1), limit: t(300).min(1) }).strict()).max(20).default([]), internal_note: t(2000).optional(),
    assessed_on: day, valid_until: day.optional(), review_by: day.optional() }),
  async handler({ user }, i) {
    if (i.athlete_id === user.id) throw badRequest('You cannot clear yourself');
    if (i.status === 'restricted' && !i.restrictions.length) throw badRequest('A restricted clearance needs at least one restriction');
    if (i.status !== 'not_cleared' && !i.valid_until) throw badRequest('Give a validity end (valid_until) so the clearance cannot silently go stale');
    if (i.valid_until && i.valid_until < i.assessed_on) throw badRequest('valid_until is before the assessment date');
    if (i.review_by && i.review_by < i.assessed_on) throw badRequest('review_by is before the assessment date');
    if (i.assessed_on > new Date().toISOString().slice(0, 10)) throw badRequest('The assessment date cannot be in the future');
    const cred = await requireVerifiedProvider(user.id, { action: 'issue_clearance', athleteId: i.athlete_id, sportId: i.sport_id ?? null, types: ['doctor'] });
    if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    const r = await tx(async (c) => {
      await lockCredential(c, cred); await lockGrant(c, i.athlete_id, user.id);
      const prev = (await c.query("SELECT id FROM clinical_clearances WHERE athlete_id=$1 AND sport_id IS NOT DISTINCT FROM $2 AND superseded_at IS NULL AND withdrawn_at IS NULL FOR UPDATE", [i.athlete_id, i.sport_id ?? null])).rows[0];
      if (prev) await c.query('UPDATE clinical_clearances SET superseded_at=now() WHERE id=$1', [prev.id]);
      const row = (await c.query(`INSERT INTO clinical_clearances(athlete_id, doctor_id, sport_id, activity, status, restrictions_enc, internal_note_enc, assessed_on, valid_until, review_by, supersedes_id, credential_case_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, athlete_id, status, assessed_on, valid_until, review_by, supersedes_id, created_at`,
      [i.athlete_id, user.id, i.sport_id ?? null, i.activity ?? null, i.status, i.restrictions.length ? encrypt(JSON.stringify(i.restrictions), 'clinical_clearances.restrictions') : null, i.internal_note ? encrypt(i.internal_note, 'clinical_clearances.note') : null,
        i.assessed_on, i.valid_until ?? null, i.review_by ?? null, prev?.id ?? null, cred.case_id])).rows[0];
      await notify(c, i.athlete_id, { kind: 'clearance', title: 'Your fit-to-play status was updated', body: 'Open Health to see it.', data: { clearance_id: row.id } });
      return row;
    });
    await audit(null, user.id, 'write_clinical', 'clinical_clearances', r.id);
    return r;
  },
});

cap({
  name: 'withdraw_clearance', credential: true, method: 'POST', path: '/medical/clearances/:id/withdraw', tag: 'Health', auth: ['doctor'],
  summary: 'The issuing doctor withdraws a live clearance with a reason (e.g. new information). The athlete\'s status goes back to the previous record or `unknown`; the decision and reason stay in history.',
  input: z.object({ id, reason: t(500).min(1) }),
  async handler({ user }, i) {
    const d = await one('SELECT athlete_id, doctor_id, sport_id FROM clinical_clearances WHERE id=$1', [i.id]);
    if (!d || d.doctor_id !== user.id) throw notFound('Clearance');
    const cred = await requireVerifiedProvider(user.id, { action: 'withdraw_clearance', athleteId: d.athlete_id, sportId: d.sport_id, types: ['doctor'] });
    const r = await tx(async (c) => {
      await lockCredential(c, cred);
      const cur = (await c.query('SELECT superseded_at, withdrawn_at FROM clinical_clearances WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (cur.withdrawn_at) throw conflict('Already withdrawn');
      if (cur.superseded_at) throw conflict('This decision was already superseded by a newer one');
      const row = (await c.query('UPDATE clinical_clearances SET withdrawn_at=now(), withdrawn_by=$2, withdrawn_reason_enc=$3 WHERE id=$1 RETURNING id, athlete_id, withdrawn_at', [i.id, user.id, encrypt(i.reason, 'clinical_clearances.withdrawn')])).rows[0];
      await notify(c, row.athlete_id, { kind: 'clearance', title: 'Your fit-to-play status was updated', body: 'Open Health to see it.', data: { clearance_id: i.id } });
      return row;
    });
    await audit(null, user.id, 'write_clinical', 'clinical_clearances', i.id);
    return r;
  },
});

cap({
  name: 'list_clearances', credential: true, method: 'GET', path: '/medical/clearances', tag: 'Health',
  summary: 'Clearance decisions with state (current / expired / superseded / withdrawn), newest first. Athletes see their own including private notes and withdrawal reasons; a doctor passes athlete_id (verified credential and full consent) and sees decisions with notes only for ones they issued. Audit-logged.',
  input: z.object({ athlete_id: id.optional(), ...page }),
  async handler({ user }, i) {
    const athlete = i.athlete_id ?? user.id;
    if (athlete !== user.id) {
      await requireVerifiedProvider(user.id, { action: 'list_clearances', athleteId: athlete, types: ['doctor'] });
      if (!(await hasGrant(athlete, user.id))) throw forbidden('The athlete has not granted you access');
    }
    const rows = await many(`SELECT ${COLS}, c.restrictions_enc, c.internal_note_enc, c.withdrawn_reason_enc, u.display_name AS doctor_name FROM clinical_clearances c JOIN users u ON u.id=c.doctor_id WHERE c.athlete_id=$1 ORDER BY c.created_at DESC, c.id LIMIT $2 OFFSET $3`, [athlete, i.limit, i.offset]);
    await audit(null, user.id, 'read_clinical', 'clinical_clearances', athlete);
    return rows.map((r) => shape(r, athlete === user.id || r.doctor_id === user.id));
  },
});
