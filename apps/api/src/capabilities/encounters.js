// Doctor workspace (issue #212), slice 1: structured, signed clinical encounters. Physios use the same encounters as their session notes
// (one place for clinical notes), under their own verified physio credential.
// A clinician-owned encounter (draft -> ready -> signed, or voided with a reason) linked to the athlete and, optionally, an appointment.
// Working notes (content) are clinician-only; the visit summary is what the athlete sees once the encounter is signed. Signed rows are
// immutable (also enforced by a DB trigger): corrections are separate `amendment` encounters that link to the original.
// Same gates as medical records: current verified doctor credential + the athlete's active full consent, re-checked atomically on writes.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { notify } from '../notify.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';

const dt = z.string().datetime({ offset: true });
const text = (n) => z.string().trim().max(n);
const TEXT_FIELDS = ['history', 'examination', 'assessment', 'plan'];
const content = z.object({
  history: text(8000).optional(), examination: text(8000).optional(), assessment: text(8000).optional(), plan: text(8000).optional(),
  observations: z.array(z.object({ type: text(80).min(1), value: z.number(), unit: text(20).min(1), measured_at: dt })).max(50).optional()
    .describe('vitals/measurements; unit and measurement time are required so a value is never read without them'),
  copied_forward: z.object({ fields: z.array(z.enum(TEXT_FIELDS)).min(1), from_encounter_id: id.optional(), reviewed: z.boolean().default(false) }).optional()
    .describe('text carried over from an earlier encounter; it must be marked reviewed before signing and is never treated as a new examination'),
}).strict();
const summary = z.object({
  problem: text(2000).optional(), plan: text(4000).optional(), actions: text(4000).optional(), follow_up_date: z.string().date().optional(), escalation: text(2000).optional(),
}).strict().describe('plain-language visit summary the athlete sees once the encounter is signed');

const seal = (obj, field) => (obj == null ? null : encrypt(JSON.stringify(obj), `clinical_encounters.${field}`));
const open = (enc, field) => (enc == null ? null : JSON.parse(decrypt(enc, `clinical_encounters.${field}`)));
const hasText = (c) => TEXT_FIELDS.some((f) => c?.[f]?.length) || !!c?.observations?.length;
const lockGrant = async (c, athleteId, providerId) => {
  if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [athleteId, providerId])).rows[0]) throw forbidden('The athlete has not granted you access');
};
const META = 'id, athlete_id, provider_id, appointment_id, sport_id, kind, amends_id, template, status, version, signed_at, signed_by, voided_at, patient_ack_at, created_at, updated_at';

/** Shape one row for its reader: the author sees everything; the athlete only a signed visit summary; other consented doctors only signed notes. */
function shape(r, viewerId) {
  const meta = Object.fromEntries(META.split(', ').map((k) => [k, r[k]]));
  if (r.provider_id === viewerId) return { ...meta, provider_name: r.provider_name, content: open(r.content_enc, 'content'), visit_summary: open(r.summary_enc, 'summary'), void_reason: r.void_reason_enc ? decrypt(r.void_reason_enc, 'clinical_encounters.void') : null };
  if (r.athlete_id === viewerId) {
    return { ...meta, provider_name: r.provider_name, visit_summary: r.status === 'signed' ? open(r.summary_enc, 'summary') : null };
  }
  return { ...meta, provider_name: r.provider_name, content: r.status === 'signed' ? open(r.content_enc, 'content') : null, visit_summary: r.status === 'signed' ? open(r.summary_enc, 'summary') : null };
}

/** Which encounters of `athleteId` this viewer may see (SQL fragment on alias e). */
async function readScope(user, athleteId) {
  if (athleteId === user.id) return { where: "e.status IN ('signed','voided')", args: [] };
  await requireVerifiedProvider(user.id, { action: 'read_encounters', athleteId, types: ['physio', 'doctor'] });
  if (!(await hasGrant(athleteId, user.id))) throw forbidden('The athlete has not granted you access');
  const g = await one('SELECT history_scope, granted_at FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2', [athleteId, user.id]);
  // own encounters in any state; others' only once signed, and only back to the grant unless the athlete shared the whole history
  return { where: "(e.provider_id=$PROV OR (e.status='signed' AND ($SINCE::timestamptz IS NULL OR e.created_at >= $SINCE)))", prov: user.id, since: g.history_scope === 'all' ? null : g.granted_at };
}

const FROM = 'FROM clinical_encounters e JOIN users p ON p.id=e.provider_id';
const COLS = 'e.*, p.display_name AS provider_name';

cap({
  name: 'create_encounter', credential: true, method: 'POST', path: '/medical/encounters', tag: 'Health', auth: ['physio', 'doctor'], status: 201,
  summary: 'Doctor or physio starts a structured encounter / session note (draft) for an athlete who granted full access, optionally linked to your appointment with them. SOAP-style or free template; observations carry units and measurement time. Working notes are encrypted and visible only to the author until signed. One live encounter per appointment.',
  input: z.object({ athlete_id: id, appointment_id: id.optional(), sport_id: id.optional(), template: z.enum(['soap', 'free']).default('soap'), content: content.default({}), visit_summary: summary.optional() }),
  async handler({ user }, i) {
    if (i.athlete_id === user.id) throw badRequest('You cannot write an encounter for yourself');
    const cred = await requireVerifiedProvider(user.id, { action: 'create_encounter', athleteId: i.athlete_id, sportId: i.sport_id ?? null, types: ['physio', 'doctor'] });
    if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    const r = await tx(async (c) => {
      await lockCredential(c, cred);
      await lockGrant(c, i.athlete_id, user.id);
      if (i.appointment_id) {
        const a = (await c.query('SELECT athlete_id, provider_id, status FROM appointments WHERE id=$1', [i.appointment_id])).rows[0];
        if (!a || a.athlete_id !== i.athlete_id || a.provider_id !== user.id) throw notFound('Appointment');
        if (['cancelled', 'expired'].includes(a.status)) throw conflict(`That appointment is ${a.status}`);
        if ((await c.query("SELECT 1 FROM clinical_encounters WHERE appointment_id=$1 AND kind='encounter' AND status<>'voided'", [i.appointment_id])).rows[0]) throw conflict('This appointment already has an encounter');
      }
      return (await c.query(`INSERT INTO clinical_encounters(athlete_id, provider_id, appointment_id, sport_id, template, content_enc, summary_enc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${META}`,
        [i.athlete_id, user.id, i.appointment_id ?? null, i.sport_id ?? null, i.template, seal(i.content, 'content'), seal(i.visit_summary, 'summary')])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_encounters', r.id);
    return r;
  },
});

cap({
  name: 'update_encounter', credential: true, method: 'PATCH', path: '/medical/encounters/:id', tag: 'Health', auth: ['physio', 'doctor'],
  summary: 'Author edits a draft/ready encounter or moves it between draft and ready for review. Send the `version` you loaded: a stale version is refused (409) so nobody overwrites newer work. Signed encounters cannot be edited; use amend_encounter.',
  input: z.object({ id, version: z.number().int().min(1), status: z.enum(['draft', 'ready']).optional(), content: content.optional(), visit_summary: summary.optional() }),
  async handler({ user }, i) {
    const e = await one('SELECT athlete_id, provider_id FROM clinical_encounters WHERE id=$1', [i.id]);
    if (!e || e.provider_id !== user.id) throw notFound('Encounter');
    const cred = await requireVerifiedProvider(user.id, { action: 'update_encounter', athleteId: e.athlete_id, types: ['physio', 'doctor'] });
    const r = await tx(async (c) => {
      await lockCredential(c, cred);
      await lockGrant(c, e.athlete_id, user.id);
      const row = (await c.query('SELECT status, version FROM clinical_encounters WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!['draft', 'ready'].includes(row.status)) throw conflict(`This encounter is ${row.status} and can no longer be edited${row.status === 'signed' ? '; add an amendment instead' : ''}`);
      if (row.version !== i.version) throw conflict('This encounter was changed since you loaded it; reload and try again');
      return (await c.query(`UPDATE clinical_encounters SET version=version+1, updated_at=now(), status=COALESCE($2,status), content_enc=COALESCE($3,content_enc), summary_enc=COALESCE($4,summary_enc) WHERE id=$1 RETURNING ${META}`,
        [i.id, i.status ?? null, i.content ? seal(i.content, 'content') : null, i.visit_summary ? seal(i.visit_summary, 'summary') : null])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_encounters', r.id);
    return r;
  },
});

cap({
  name: 'sign_encounter', credential: true, method: 'POST', path: '/medical/encounters/:id/sign', tag: 'Health', auth: ['physio', 'doctor'],
  summary: 'The authoring doctor or physio signs a draft/ready encounter. Credential and consent are re-validated in the same transaction as the signature (a revocation that commits first blocks it). Needs some recorded content, and any copied-forward text must be marked reviewed. After signing the entry is immutable and the athlete sees the visit summary. The credential case relied on is recorded.',
  input: z.object({ id, version: z.number().int().min(1) }),
  async handler({ user }, i) {
    const e = await one('SELECT athlete_id, provider_id, sport_id FROM clinical_encounters WHERE id=$1', [i.id]);
    if (!e || e.provider_id !== user.id) throw notFound('Encounter');
    const cred = await requireVerifiedProvider(user.id, { action: 'sign_encounter', athleteId: e.athlete_id, sportId: e.sport_id, types: ['physio', 'doctor'] });
    const r = await tx(async (c) => {
      await lockCredential(c, cred);
      await lockGrant(c, e.athlete_id, user.id);
      const row = (await c.query('SELECT status, version, content_enc, summary_enc FROM clinical_encounters WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!['draft', 'ready'].includes(row.status)) throw conflict(`This encounter is already ${row.status}`);
      if (row.version !== i.version) throw conflict('This encounter was changed since you loaded it; reload, review and sign again');
      const body = open(row.content_enc, 'content');
      if (!hasText(body)) throw badRequest('Record some history, examination, assessment, plan or observation before signing');
      if (body.copied_forward && !body.copied_forward.reviewed) throw badRequest('Text copied forward from an earlier encounter must be reviewed (copied_forward.reviewed) before signing');
      const out = (await c.query(`UPDATE clinical_encounters SET status='signed', signed_at=now(), signed_by=$2, credential_case_id=$3, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${META}`, [i.id, user.id, cred.case_id])).rows[0];
      if (row.summary_enc) await notify(c, e.athlete_id, { kind: 'visit_summary', title: 'A visit summary is ready', body: 'Open Health to read it.', data: { encounter_id: i.id } });
      return out;
    });
    await audit(null, user.id, 'sign_clinical', 'clinical_encounters', r.id);
    return r;
  },
});

cap({
  name: 'amend_encounter', credential: true, method: 'POST', path: '/medical/encounters/:id/amend', tag: 'Health', auth: ['physio', 'doctor'], status: 201,
  summary: 'Correct or add to a signed encounter you authored. The original is never changed: this creates a linked draft amendment (with the reason) that you edit and sign like any encounter.',
  input: z.object({ id, reason: text(500).min(1), content: content.default({}), visit_summary: summary.optional() }),
  async handler({ user }, i) {
    const o = await one('SELECT athlete_id, provider_id, sport_id, status, kind, amends_id FROM clinical_encounters WHERE id=$1', [i.id]);
    if (!o || o.provider_id !== user.id) throw notFound('Encounter');
    const cred = await requireVerifiedProvider(user.id, { action: 'amend_encounter', athleteId: o.athlete_id, sportId: o.sport_id, types: ['physio', 'doctor'] });
    const r = await tx(async (c) => {
      await lockCredential(c, cred);
      await lockGrant(c, o.athlete_id, user.id);
      const st = (await c.query('SELECT status FROM clinical_encounters WHERE id=$1 FOR SHARE', [i.id])).rows[0].status;
      if (st !== 'signed') throw conflict(st === 'voided' ? 'A voided encounter cannot be amended' : 'Only a signed encounter is amended; edit the draft directly');
      const body = { ...i.content, amendment_reason: i.reason };
      return (await c.query(`INSERT INTO clinical_encounters(athlete_id, provider_id, appointment_id, sport_id, kind, amends_id, template, content_enc, summary_enc)
        SELECT athlete_id, provider_id, NULL, sport_id, 'amendment', COALESCE(amends_id, id), 'free', $2, $3 FROM clinical_encounters WHERE id=$1 RETURNING ${META}`, [i.id, seal(body, 'content'), seal(i.visit_summary, 'summary')])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_encounters', r.id);
    return r;
  },
});

cap({
  name: 'void_encounter', credential: true, method: 'POST', path: '/medical/encounters/:id/void', tag: 'Health', auth: ['physio', 'doctor'],
  summary: 'Withdraw an encounter you authored (e.g. recorded against the wrong patient) with a reason. Content is preserved for audit but is no longer shown to the athlete or other clinicians. A voided entry cannot be reopened.',
  input: z.object({ id, reason: text(500).min(1) }),
  async handler({ user }, i) {
    const e = await one('SELECT athlete_id, provider_id, sport_id FROM clinical_encounters WHERE id=$1', [i.id]);
    if (!e || e.provider_id !== user.id) throw notFound('Encounter');
    const cred = await requireVerifiedProvider(user.id, { action: 'void_encounter', athleteId: e.athlete_id, sportId: e.sport_id, types: ['physio', 'doctor'] });
    const r = await tx(async (c) => {
      await lockCredential(c, cred);
      const row = (await c.query('SELECT status FROM clinical_encounters WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (row.status === 'voided') throw conflict('Already voided');
      return (await c.query(`UPDATE clinical_encounters SET status='voided', voided_at=now(), voided_by=$2, void_reason_enc=$3, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${META}`, [i.id, user.id, encrypt(i.reason, 'clinical_encounters.void')])).rows[0];
    });
    await audit(null, user.id, 'void_clinical', 'clinical_encounters', r.id);
    return r;
  },
});

cap({
  name: 'list_encounters', credential: true, method: 'GET', path: '/medical/encounters', tag: 'Health',
  summary: 'Athletes (no athlete_id): your signed encounters as plain visit summaries - working notes are never shown to you here. Doctors and physios: pass athlete_id (current verified credential and full consent required) to see your own encounters in any state plus other clinicians\' signed ones within the consent\'s history scope. Newest first; reads are audit-logged.',
  input: z.object({ athlete_id: id.optional(), appointment_id: id.optional(), status: z.enum(['draft', 'ready', 'signed', 'voided']).optional(), ...page }),
  async handler({ user }, i) {
    const athlete = i.athlete_id ?? user.id;
    const s = await readScope(user, athlete);
    const args = [athlete, i.limit, i.offset, i.appointment_id ?? null, i.status ?? null];
    let where = s.where;
    if (s.prov) { args.push(s.prov, s.since); where = where.replace('$PROV', '$6').replaceAll('$SINCE', '$7'); }
    const rows = await many(`SELECT ${COLS} ${FROM} WHERE e.athlete_id=$1 AND ${where} AND ($4::uuid IS NULL OR e.appointment_id=$4) AND ($5::text IS NULL OR e.status=$5) ORDER BY e.created_at DESC, e.id LIMIT $2 OFFSET $3`, args);
    await audit(null, user.id, 'read_clinical', 'clinical_encounters', athlete);
    return rows.map((r) => shape(r, user.id));
  },
});

cap({
  name: 'get_encounter', credential: true, method: 'GET', path: '/medical/encounters/:id', tag: 'Health',
  summary: 'One encounter with its amendments (oldest first). The author sees working notes in every state; the athlete sees the visit summary of signed encounters; other consented clinicians see signed notes within their history scope. Audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const head = await one('SELECT athlete_id, amends_id FROM clinical_encounters WHERE id=$1', [i.id]);
    if (!head) throw notFound('Encounter');
    const s = await readScope(user, head.athlete_id);
    const root = head.amends_id ?? i.id;
    const args = [head.athlete_id, root];
    let where = s.where;
    if (s.prov) { args.push(s.prov, s.since); where = where.replace('$PROV', '$3').replaceAll('$SINCE', '$4'); }
    const rows = await many(`SELECT ${COLS} ${FROM} WHERE e.athlete_id=$1 AND (e.id=$2 OR e.amends_id=$2) AND ${where} ORDER BY e.created_at, e.id`, args);
    if (!rows.some((r) => r.id === root)) throw notFound('Encounter');
    await audit(null, user.id, 'read_clinical', 'clinical_encounters', head.athlete_id);
    const [main, ...amendments] = rows.map((r) => shape(r, user.id));
    return { ...main, amendments };
  },
});

cap({
  name: 'acknowledge_visit_summary', method: 'POST', path: '/medical/encounters/:id/acknowledge', tag: 'Health',
  summary: 'Athlete confirms they have read the visit summary of a signed encounter. This records that it was read only - not agreement with the plan or any clinical improvement. Repeating it keeps the first time.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = (await many("UPDATE clinical_encounters SET patient_ack_at=COALESCE(patient_ack_at, now()) WHERE id=$1 AND athlete_id=$2 AND status='signed' AND summary_enc IS NOT NULL RETURNING id, patient_ack_at", [i.id, user.id]))[0];
    if (!r) throw notFound('Visit summary');
    return r;
  },
});
