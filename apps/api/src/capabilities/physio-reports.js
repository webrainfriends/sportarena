// Physio progress reports (the physio's counterpart of coaching reports). A report is an editable draft (who, which plan, which period,
// who may read it, the clinician's own words); publishing freezes a numbered snapshot built on the server from the live records, so later
// readings, goals or notes never alter an issued version. A private report stays with the clinician; a patient-audience one is also
// readable by the patient (who can mark it read). Narrative and snapshot are encrypted.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { requireVerifiedProvider } from '../clinical-access.js';
import { ACCESS, buildSnapshot, ctx, sha256, ymd } from '../physio.js';
import { lockGate, providerGate } from './physio-tracking.js';

const TAG = 'Physio tracking';
const PROVIDER = ['physio', 'doctor'];
const day = z.string().date();
const COLS = 'r.id, r.provider_id, r.patient_id, r.plan_id, r.kind, r.title, r.audience, r.period_from, r.period_to, r.narrative_enc, r.latest_version, r.row_version, r.created_at, r.updated_at, u.display_name AS patient_name, pr.display_name AS provider_name';
const FROM = 'FROM physio_reports r JOIN users u ON u.id=r.patient_id JOIN users pr ON pr.id=r.provider_id';

const shape = (r) => {
  const { narrative_enc, ...m } = r;
  return { ...m, period_from: ymd(r.period_from), period_to: ymd(r.period_to), narrative: narrative_enc ? decrypt(narrative_enc, ctx.reportNarrative) : null, status: r.latest_version ? 'published' : 'draft' };
};
const own = async (providerId, reportId) => {
  const r = await one(`SELECT ${COLS} ${FROM} WHERE r.id=$1`, [reportId]);
  if (!r || r.provider_id !== providerId) throw notFound('Report');
  return r;
};

cap({
  name: 'save_physio_report', credential: true, method: 'POST', path: '/physio/reports', tag: TAG, auth: PROVIDER, status: 201,
  summary: 'Physio/doctor: start a progress or discharge report for a patient who granted full access (optionally for one treatment plan), or, with `id` and the `row_version` you loaded, edit its draft. Choose the period, who may read it (private to you, or the patient too) and write the narrative yourself. Nothing reaches the patient until you publish.',
  input: z.object({
    id: id.optional(), row_version: z.number().int().min(1).optional(), patient_id: id.optional(), plan_id: id.optional(), kind: z.enum(['progress', 'discharge']).default('progress'),
    title: z.string().trim().min(2).max(160), audience: z.enum(['private', 'patient']).default('private'), period_from: day, period_to: day, narrative: z.string().trim().max(6000).optional(),
  }),
  async handler({ user }, i) {
    if (i.period_to < i.period_from) throw badRequest('The period ends before it starts');
    if (new Date(i.period_to) - new Date(i.period_from) > 731 * 864e5) throw badRequest('Choose a period of at most two years');
    let patientId = i.patient_id;
    if (i.id) { const r = await own(user.id, i.id); patientId = r.patient_id; if (i.patient_id && i.patient_id !== r.patient_id) throw badRequest('A report cannot move to another patient'); if (i.row_version == null) throw badRequest('row_version is required to edit a report'); }
    else if (!patientId) throw badRequest('patient_id is required');
    const cred = await providerGate(user, patientId, 'save_physio_report');
    const out = await tx(async (c) => {
      await lockGate(c, cred, patientId, user.id);
      if (i.plan_id && !(await c.query('SELECT 1 FROM treatment_plans WHERE id=$1 AND provider_id=$2 AND patient_id=$3', [i.plan_id, user.id, patientId])).rows[0]) throw notFound('Treatment plan');
      if (!i.id) return (await c.query('INSERT INTO physio_reports(provider_id, patient_id, plan_id, kind, title, audience, period_from, period_to, narrative_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [user.id, patientId, i.plan_id ?? null, i.kind, i.title, i.audience, i.period_from, i.period_to, encrypt(i.narrative, ctx.reportNarrative)])).rows[0];
      const row = (await c.query('SELECT row_version FROM physio_reports WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (row.row_version !== i.row_version) throw conflict('This report was changed since you loaded it; reload and try again');
      return (await c.query('UPDATE physio_reports SET row_version=row_version+1, updated_at=now(), plan_id=$2, kind=$3, title=$4, audience=$5, period_from=$6, period_to=$7, narrative_enc=$8 WHERE id=$1 RETURNING id', [i.id, i.plan_id ?? null, i.kind, i.title, i.audience, i.period_from, i.period_to, encrypt(i.narrative, ctx.reportNarrative)])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'physio_reports', out.id);
    return shape(await one(`SELECT ${COLS} ${FROM} WHERE r.id=$1`, [out.id]));
  },
});

cap({
  name: 'preview_physio_report', credential: true, method: 'GET', path: '/physio/reports/:id/preview', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: see exactly what publishing would freeze right now (sessions, outcome changes, goals, home-exercise adherence, your narrative) without publishing it.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await own(user.id, i.id);
    await providerGate(user, r.patient_id, 'preview_physio_report');
    const snap = await buildSnapshot(r, { providerName: r.provider_name, patientName: r.patient_name });
    await audit(null, user.id, 'read_clinical', 'physio_reports', r.id);
    return { ...snap, narrative: r.narrative_enc ? decrypt(r.narrative_enc, ctx.reportNarrative) : null };
  },
});

cap({
  name: 'publish_physio_report', credential: true, method: 'POST', path: '/physio/reports/:id/publish', tag: TAG, auth: PROVIDER, status: 201,
  summary: 'Physio/doctor: publish the report as the next numbered, immutable version. The figures are rebuilt on the server at this moment. With patient audience the patient is notified and can read it; a private report stays with you. Publish again after edits to issue version 2; earlier versions stay readable.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  async handler({ user }, i) {
    const r0 = await own(user.id, i.id);
    const cred = await providerGate(user, r0.patient_id, 'publish_physio_report');
    const v = await tx(async (c) => {
      await lockGate(c, cred, r0.patient_id, user.id);
      const row = (await c.query(`SELECT ${COLS} ${FROM} WHERE r.id=$1 FOR UPDATE OF r`, [i.id])).rows[0];
      if (row.row_version !== i.row_version) throw conflict('This report was changed since you loaded it; reload, review and publish again');
      const snap = { ...(await buildSnapshot(row, { providerName: row.provider_name, patientName: row.patient_name })), narrative: row.narrative_enc ? decrypt(row.narrative_enc, ctx.reportNarrative) : null };
      const json = JSON.stringify(snap), version = row.latest_version + 1;
      await c.query('INSERT INTO physio_report_versions(report_id, version, audience, snapshot_enc, snapshot_sha256, published_by) VALUES ($1,$2,$3,$4,$5,$6)', [i.id, version, row.audience, encrypt(json, ctx.reportSnapshot), sha256(json), user.id]);
      await c.query('UPDATE physio_reports SET latest_version=$2, row_version=row_version+1, updated_at=now() WHERE id=$1', [i.id, version]);
      if (row.audience === 'patient') await notify(c, row.patient_id, { kind: 'physio_report', title: 'A progress report is ready', body: `${row.provider_name} shared "${row.title}" with you.`, data: { report_id: i.id, version } });
      return { report_id: i.id, version, audience: row.audience, snapshot_sha256: sha256(json), notified_patient: row.audience === 'patient' };
    });
    await audit(null, user.id, 'write_clinical', 'physio_reports', i.id);
    return v;
  },
});

cap({
  name: 'list_physio_reports', credential: true, method: 'GET', path: '/physio/reports', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: your reports (drafts and published) for patients whose consent is active, newest change first; filter by patient. Includes how many versions are issued and whether the patient has read the latest.',
  input: z.object({ patient_id: id.optional(), ...page }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'list_physio_reports', athleteId: i.patient_id ?? null, types: PROVIDER });
    const rows = await many(`SELECT ${COLS}, (SELECT read_at FROM physio_report_reads x WHERE x.report_id=r.id AND x.version=r.latest_version) AS latest_read_at ${FROM}
       WHERE r.provider_id=$1 AND r.patient_id IN (${ACCESS}) AND ($2::uuid IS NULL OR r.patient_id=$2) ORDER BY r.updated_at DESC, r.id LIMIT $3 OFFSET $4`, [user.id, i.patient_id ?? null, i.limit, i.offset]);
    return rows.map(({ latest_read_at, ...r }) => ({ ...shape(r), latest_read_at }));
  },
});

cap({
  name: 'get_physio_report', credential: true, method: 'GET', path: '/physio/reports/:id', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: a report with its issued versions (when, for whom, whether the patient read each). Pass `version` to include that frozen snapshot (default: the latest). Audit-logged.',
  input: z.object({ id, version: z.coerce.number().int().min(1).optional() }),
  async handler({ user }, i) {
    const r = await own(user.id, i.id);
    await providerGate(user, r.patient_id, 'get_physio_report');
    const versions = await many('SELECT v.version, v.audience, v.published_at, v.snapshot_sha256, x.read_at FROM physio_report_versions v LEFT JOIN physio_report_reads x ON x.report_id=v.report_id AND x.version=v.version WHERE v.report_id=$1 ORDER BY v.version DESC', [i.id]);
    let snapshot = null;
    const want = i.version ?? r.latest_version;
    if (want) {
      const v = await one('SELECT snapshot_enc FROM physio_report_versions WHERE report_id=$1 AND version=$2', [i.id, want]);
      if (!v) throw notFound('Report version');
      snapshot = { version: want, ...JSON.parse(decrypt(v.snapshot_enc, ctx.reportSnapshot)) };
    }
    await audit(null, user.id, 'read_clinical', 'physio_reports', r.id);
    return { ...shape(r), versions, snapshot };
  },
});

cap({
  name: 'my_physio_reports', method: 'GET', path: '/me/physio-reports', tag: TAG,
  summary: 'Patient: progress reports your clinician published to you, newest first, each with its frozen figures and whether you have marked it read. Private reports are never included. Works even after you withdraw access from the clinician.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    const rows = await many(
      `SELECT DISTINCT ON (r.id) r.id AS report_id, v.version, r.kind, r.title, pr.display_name AS provider_name, v.published_at, v.snapshot_enc, x.read_at
         FROM physio_reports r JOIN physio_report_versions v ON v.report_id=r.id AND v.audience='patient' JOIN users pr ON pr.id=r.provider_id LEFT JOIN physio_report_reads x ON x.report_id=v.report_id AND x.version=v.version
        WHERE r.patient_id=$1 ORDER BY r.id, v.version DESC`, [user.id]);
    const sorted = rows.sort((a, b) => b.published_at - a.published_at).slice(i.offset, i.offset + i.limit);
    return sorted.map(({ snapshot_enc, ...r }) => ({ ...r, snapshot: JSON.parse(decrypt(snapshot_enc, ctx.reportSnapshot)) }));
  },
});

cap({
  name: 'mark_physio_report_read', method: 'POST', path: '/me/physio-reports/:id/read', tag: TAG,
  summary: 'Patient: confirm you have read a report your clinician shared. This records only that it was read, not agreement. Repeating it keeps the first time.',
  input: z.object({ id, version: z.number().int().min(1).optional() }),
  async handler({ user }, i) {
    const v = await one("SELECT v.version FROM physio_report_versions v JOIN physio_reports r ON r.id=v.report_id WHERE r.id=$1 AND r.patient_id=$2 AND v.audience='patient' AND ($3::int IS NULL OR v.version=$3) ORDER BY v.version DESC LIMIT 1", [i.id, user.id, i.version ?? null]);
    if (!v) throw notFound('Report');
    await one('INSERT INTO physio_report_reads(report_id, version, patient_id) VALUES ($1,$2,$3) ON CONFLICT (report_id, version) DO NOTHING RETURNING report_id', [i.id, v.version, user.id]);
    return one('SELECT report_id, version, read_at FROM physio_report_reads WHERE report_id=$1 AND version=$2', [i.id, v.version]);
  },
});
