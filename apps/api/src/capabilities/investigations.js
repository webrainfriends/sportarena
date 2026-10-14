// Doctor workspace (issue #212, slice 2b): investigation requests and results review.
//   requested (awaiting result) -> received -> reviewed -> patient_informed -> closed
// Receiving or opening a result is never a review: only the responsible doctor's explicit `review_result` moves it on. An amended result is a
// new version that reopens review; earlier versions and every action stay (append-only). Values are stored exactly as supplied - nothing is
// normalised, flagged against generic ranges or inferred. Nothing here claims a lab order was transmitted: requests are manual/external records.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { notify } from '../notify.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt, sha256 } from '../crypto.js';
import { clinicalCredential, lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';

const t = (n) => z.string().trim().max(n);
const day = z.string().date();
const value = z.object({ name: t(200).min(1), value: t(200).min(1).describe('as printed on the report'), unit: t(40).optional(), reference_interval: t(120).optional().describe('the source report\'s own interval'), specimen_date: day.optional() }).strict();
const EV = 'investigation';
const seal = (o, f) => encrypt(JSON.stringify(o), `clinical_${EV}.${f}`);
const open = (e, f) => (e == null ? null : JSON.parse(decrypt(e, `clinical_${EV}.${f}`)));
const COLS = 'id, athlete_id, requested_by, responsible_id, encounter_id, priority, external_provider, external_reference, requested_on, review_due, status, version, created_at, updated_at';
const lockGrant = async (c, athleteId, providerId) => {
  if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [athleteId, providerId])).rows[0]) throw forbidden('The athlete has not granted you access');
};
const logEvent = (c, invId, actor, action, resultId = null, note = null) => c.query('INSERT INTO clinical_investigation_events(investigation_id, result_id, actor_id, action, note_enc) VALUES ($1,$2,$3,$4,$5)', [invId, resultId, actor, action, note ? seal({ note }, 'note') : null]);

/** Doctor gate for one investigation: they are the requester or the responsible doctor, verified now, with consent now. Returns { inv, cred }. */
async function doctorOn(user, invId, action) {
  const inv = await one(`SELECT ${COLS} FROM clinical_investigations WHERE id=$1`, [invId]);
  if (!inv || (inv.athlete_id !== user.id && inv.responsible_id !== user.id && inv.requested_by !== user.id)) throw notFound('Investigation');
  if (inv.athlete_id === user.id) throw forbidden('Only the responsible doctor can do this');
  const cred = await requireVerifiedProvider(user.id, { action, athleteId: inv.athlete_id, types: ['doctor'] });
  if (!(await hasGrant(inv.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
  if (inv.responsible_id !== user.id && action !== 'read_history') throw forbidden('This investigation is assigned to another doctor');
  return { inv, cred };
}
const guarded = async (c, cred, inv, user) => { await lockCredential(c, cred); await lockGrant(c, inv.athlete_id, user.id); return (await c.query('SELECT * FROM clinical_investigations WHERE id=$1 FOR UPDATE', [inv.id])).rows[0]; };

const shapeInv = (r, results = [], events = []) => ({
  ...Object.fromEntries(COLS.split(', ').map((k) => [k, r[k]])), test: open(r.test_enc, 'test')?.v, indication: open(r.indication_enc, 'indication')?.v ?? null,
  overdue: !!r.review_due && r.status !== 'closed' && r.status !== 'patient_informed' && r.status !== 'reviewed' && new Date(r.review_due) < new Date(new Date().toDateString()),
  results, events,
});
const shapeRes = (r, reviewedIds) => ({ id: r.id, version_no: r.version_no, source: r.source, extraction: r.extraction, document_ref: r.document_ref, values: open(r.values_enc, 'values'), uploaded_by: r.uploaded_by, created_at: r.created_at, doctor_reviewed: reviewedIds.has(r.id),
  ...(r.extraction === 'unverified_extraction' ? { note: 'Extracted automatically and unverified until a doctor reviews it against the original document' } : {}) });

cap({
  name: 'request_investigation', credential: true, method: 'POST', path: '/medical/investigations', tag: 'Health', auth: ['doctor'], status: 201,
  summary: 'Doctor records an investigation (blood test, scan, ...) for an athlete who granted full access, with indication, external provider/reference, a clinician-chosen priority and a review due date. This is a manual/external record: it does not send an order to any lab. You become the responsible doctor.',
  input: z.object({ athlete_id: id, test: t(200).min(1), indication: t(1000).optional(), priority: z.enum(['routine', 'priority', 'urgent']).default('routine'), external_provider: t(200).optional(), external_reference: t(200).optional(), requested_on: day.optional(), review_due: day.optional() }),
  async handler({ user }, i) {
    if (i.athlete_id === user.id) throw badRequest('You cannot request an investigation for yourself');
    const cred = await requireVerifiedProvider(user.id, { action: 'request_investigation', athleteId: i.athlete_id, types: ['doctor'] });
    if (!(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
    const r = await tx(async (c) => {
      await lockCredential(c, cred); await lockGrant(c, i.athlete_id, user.id);
      const row = (await c.query(`INSERT INTO clinical_investigations(athlete_id, requested_by, responsible_id, test_enc, indication_enc, priority, external_provider, external_reference, requested_on, review_due)
        VALUES ($1,$2,$2,$3,$4,$5,$6,$7,COALESCE($8::date, current_date),$9) RETURNING ${COLS}, test_enc, indication_enc`,
      [i.athlete_id, user.id, seal({ v: i.test }, 'test'), i.indication ? seal({ v: i.indication }, 'indication') : null, i.priority, i.external_provider ?? null, i.external_reference ?? null, i.requested_on ?? null, i.review_due ?? null])).rows[0];
      await logEvent(c, row.id, user.id, 'requested');
      await notify(c, i.athlete_id, { kind: 'investigation_requested', title: 'A test was requested', body: 'Open Health for details.', data: { investigation_id: row.id } });
      return row;
    });
    await audit(null, user.id, 'write_clinical', 'clinical_investigations', r.id);
    return shapeInv(r);
  },
});

cap({
  name: 'upload_investigation_result', credential: true, method: 'POST', path: '/medical/investigations/:id/results', tag: 'Health', status: 201,
  summary: 'Add a result (the athlete for their own test, or the responsible doctor on their behalf). Values are stored exactly as supplied with the report\'s own units and reference intervals. Re-sending identical content returns the existing result (no duplicate work). A new, different result after review is an amended version: earlier versions stay and doctor review reopens. Automatic extraction must be flagged `unverified_extraction`.',
  input: z.object({ id, values: z.array(value).min(1).max(100), document_ref: t(500).optional().describe('reference to the original document in private report storage'), source: z.enum(['patient', 'provider', 'external']).optional().describe('doctors only; athletes are always `patient`'), extraction: z.enum(['manual', 'unverified_extraction']).default('manual') }),
  async handler({ user }, i) {
    const inv = await one(`SELECT ${COLS} FROM clinical_investigations WHERE id=$1`, [i.id]);
    if (!inv) throw notFound('Investigation');
    const mine = inv.athlete_id === user.id;
    let cred = null;
    if (!mine) { if (inv.responsible_id !== user.id) throw notFound('Investigation'); cred = (await doctorOn(user, i.id, 'upload_investigation_result')).cred; }
    const hash = sha256(JSON.stringify({ v: i.values, d: i.document_ref ?? null }));
    const out = await tx(async (c) => {
      const cur = cred ? await guarded(c, cred, inv, user) : (await c.query('SELECT * FROM clinical_investigations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (cur.status === 'closed') throw conflict('This investigation is closed');
      const dup = (await c.query('SELECT * FROM clinical_results WHERE investigation_id=$1 AND content_hash=$2', [i.id, hash])).rows[0];
      if (dup) return { result: dup, inv: cur, duplicate: true };
      const prev = (await c.query('SELECT max(version_no) AS n FROM clinical_results WHERE investigation_id=$1', [i.id])).rows[0].n ?? 0;
      const res = (await c.query('INSERT INTO clinical_results(investigation_id, version_no, uploaded_by, source, values_enc, document_ref, content_hash, extraction) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [i.id, prev + 1, user.id, mine ? 'patient' : (i.source ?? 'provider'), seal(i.values, 'values'), i.document_ref ?? null, hash, i.extraction])).rows[0];
      const reopened = prev > 0 && ['reviewed', 'patient_informed'].includes(cur.status);
      const row = (await c.query("UPDATE clinical_investigations SET status='received', version=version+1, updated_at=now() WHERE id=$1 RETURNING *", [i.id])).rows[0];
      await logEvent(c, i.id, user.id, reopened ? 'reopened' : 'result_received', res.id);
      await notify(c, inv.responsible_id, { kind: 'result_received', title: reopened ? 'A result was amended' : 'A result was received', body: 'Open Health to review it.', data: { investigation_id: i.id } });
      return { result: res, inv: row, duplicate: false };
    });
    await audit(null, user.id, 'write_clinical', 'clinical_results', out.result.id);
    return { investigation: shapeInv(out.inv), result: shapeRes(out.result, new Set()), duplicate: out.duplicate };
  },
});

cap({
  name: 'review_investigation_result', credential: true, method: 'POST', path: '/medical/investigations/:id/review', tag: 'Health', auth: ['doctor'],
  summary: 'The responsible doctor records that they reviewed a specific result version (pass `result_id`; reviewing a superseded version is refused). Only this explicit action sets the investigation to `reviewed` - receiving or the patient opening a document never does. The note is encrypted; owner and time are kept.',
  input: z.object({ id, result_id: id, note: t(2000).optional() }),
  async handler({ user }, i) {
    const { inv, cred } = await doctorOn(user, i.id, 'review_investigation_result');
    const row = await tx(async (c) => {
      const cur = await guarded(c, cred, inv, user);
      if (cur.status !== 'received') throw conflict(cur.status === 'requested' ? 'No result has been received yet' : `This investigation is already ${cur.status}`);
      const latest = (await c.query('SELECT id FROM clinical_results WHERE investigation_id=$1 ORDER BY version_no DESC LIMIT 1', [i.id])).rows[0];
      if (latest.id !== i.result_id) throw conflict('A newer version of this result exists; review that one');
      await logEvent(c, i.id, user.id, 'reviewed', i.result_id, i.note);
      return (await c.query(`UPDATE clinical_investigations SET status='reviewed', version=version+1, updated_at=now() WHERE id=$1 RETURNING ${COLS}, test_enc, indication_enc`, [i.id])).rows[0];
    });
    await audit(null, user.id, 'review_clinical', 'clinical_investigations', i.id);
    return shapeInv(row);
  },
});

cap({
  name: 'update_investigation_outcome', credential: true, method: 'POST', path: '/medical/investigations/:id/outcome', tag: 'Health', auth: ['doctor'],
  summary: 'After review, the responsible doctor records that the patient was informed (`patient_informed`, with how/what was agreed in the note) and later closes it (`closed`, e.g. follow-up arranged). The athlete gets a generic notification with no result content.',
  input: z.object({ id, action: z.enum(['patient_informed', 'closed']), note: t(2000).optional() }),
  async handler({ user }, i) {
    const { inv, cred } = await doctorOn(user, i.id, 'update_investigation_outcome');
    const row = await tx(async (c) => {
      const cur = await guarded(c, cred, inv, user);
      const need = i.action === 'patient_informed' ? ['reviewed'] : ['reviewed', 'patient_informed'];
      if (!need.includes(cur.status)) throw conflict(cur.status === 'closed' ? 'Already closed' : `Review the latest result before this step (currently ${cur.status})`);
      await logEvent(c, i.id, user.id, i.action, null, i.note);
      if (i.action === 'patient_informed') await notify(c, cur.athlete_id, { kind: 'result_update', title: 'Your doctor has an update', body: 'Open Health to read it.', data: { investigation_id: i.id } });
      return (await c.query(`UPDATE clinical_investigations SET status=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${COLS}, test_enc, indication_enc`, [i.id, i.action])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_investigations', i.id);
    return shapeInv(row);
  },
});

cap({
  name: 'reassign_investigation', credential: true, method: 'POST', path: '/medical/investigations/:id/reassign', tag: 'Health', auth: ['doctor'],
  summary: 'Hand review to another doctor (absence cover). The new doctor must be verified now and hold the athlete\'s full consent - sharing is the athlete\'s decision, not implied by the same clinic. The change is logged with the reason.',
  input: z.object({ id, to_doctor_id: id, reason: t(500).min(1) }),
  async handler({ user }, i) {
    const { inv, cred } = await doctorOn(user, i.id, 'reassign_investigation');
    if (i.to_doctor_id === user.id) throw badRequest('Already yours');
    const target = await clinicalCredential(i.to_doctor_id, { types: ['doctor'], athleteId: inv.athlete_id });
    if (!target.ok) throw forbidden('That doctor does not hold a current verified doctor credential');
    if (!(await hasGrant(inv.athlete_id, i.to_doctor_id))) throw forbidden('The athlete has not granted that doctor access');
    const row = await tx(async (c) => {
      const cur = await guarded(c, cred, inv, user);
      if (cur.status === 'closed') throw conflict('Already closed');
      await lockGrant(c, inv.athlete_id, i.to_doctor_id);
      await logEvent(c, i.id, user.id, 'reassigned', null, `${i.to_doctor_id}: ${i.reason}`);
      await notify(c, i.to_doctor_id, { kind: 'investigation_assigned', title: 'A result review was assigned to you', body: 'Open Health to see it.', data: { investigation_id: i.id } });
      return (await c.query(`UPDATE clinical_investigations SET responsible_id=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING ${COLS}, test_enc, indication_enc`, [i.id, i.to_doctor_id])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_investigations', i.id);
    return shapeInv(row);
  },
});

cap({
  name: 'list_investigations', credential: true, method: 'GET', path: '/medical/investigations', tag: 'Health',
  summary: 'Athletes: your tests with results and review status. Doctors: pass athlete_id for one patient, or omit it for your review queue (investigations you are responsible for across consenting patients, urgent and overdue first). `doctor_reviewed` per result is true only after an explicit review. Audit-logged.',
  input: z.object({ athlete_id: id.optional(), status: z.enum(['requested', 'received', 'reviewed', 'patient_informed', 'closed']).optional(), open_only: z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]).default(false), ...page }),
  async handler({ user }, i) {
    const doctor = !!i.athlete_id && i.athlete_id !== user.id || (!i.athlete_id && user.roles?.includes('doctor'));
    let rows;
    const base = `SELECT ${COLS}, test_enc, indication_enc FROM clinical_investigations WHERE ($4::text IS NULL OR status=$4) AND ($5::boolean IS FALSE OR status <> 'closed')`;
    if (!doctor) {
      rows = await many(`${base} AND athlete_id=$3 ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`, [i.limit, i.offset, user.id, i.status ?? null, i.open_only]);
    } else {
      await requireVerifiedProvider(user.id, { action: 'list_investigations', athleteId: i.athlete_id ?? null, types: ['doctor'] });
      if (i.athlete_id && !(await hasGrant(i.athlete_id, user.id))) throw forbidden('The athlete has not granted you access');
      rows = await many(`${base} AND (responsible_id=$3 OR requested_by=$3) AND ($6::uuid IS NULL OR athlete_id=$6)
        AND EXISTS (SELECT 1 FROM medical_grants g WHERE g.athlete_id=clinical_investigations.athlete_id AND g.provider_id=$3 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND g.scope='full')
        ORDER BY (status='closed'), CASE priority WHEN 'urgent' THEN 0 WHEN 'priority' THEN 1 ELSE 2 END, review_due NULLS LAST, created_at DESC, id LIMIT $1 OFFSET $2`, [i.limit, i.offset, user.id, i.status ?? null, i.open_only, i.athlete_id ?? null]);
    }
    const ids = rows.map((r) => r.id);
    const results = ids.length ? await many('SELECT * FROM clinical_results WHERE investigation_id = ANY($1::uuid[]) ORDER BY version_no', [ids]) : [];
    const reviewed = new Set((ids.length ? await many("SELECT result_id FROM clinical_investigation_events WHERE investigation_id = ANY($1::uuid[]) AND action='reviewed'", [ids]) : []).map((e) => e.result_id));
    await audit(null, user.id, 'read_clinical', 'clinical_investigations', i.athlete_id ?? user.id);
    return rows.map((r) => shapeInv(r, results.filter((x) => x.investigation_id === r.id).map((x) => shapeRes(x, reviewed))));
  },
});

cap({
  name: 'get_investigation_history', credential: true, method: 'GET', path: '/medical/investigations/:id/history', tag: 'Health',
  summary: 'The append-only trail of one investigation (requested, result received/amended, reviewed by whom and when, patient informed, reassigned, closed), oldest first. Visible to the athlete (notes withheld) and to the responsible/requesting doctor with notes. Audit-logged.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const inv = await one(`SELECT ${COLS} FROM clinical_investigations WHERE id=$1`, [i.id]);
    if (!inv) throw notFound('Investigation');
    const mine = inv.athlete_id === user.id;
    if (!mine) await doctorOn(user, i.id, 'read_history');
    const ev = await many('SELECT e.id, e.result_id, e.actor_id, u.display_name AS actor_name, e.action, e.note_enc, e.created_at FROM clinical_investigation_events e JOIN users u ON u.id=e.actor_id WHERE e.investigation_id=$1 ORDER BY e.created_at, e.id', [i.id]);
    await audit(null, user.id, 'read_clinical', 'clinical_investigations', inv.athlete_id);
    return { investigation_id: i.id, status: inv.status, events: ev.map(({ note_enc, ...e }) => ({ ...e, ...(mine ? {} : { note: note_enc ? open(note_enc, 'note').note : null }) })) };
  },
});
