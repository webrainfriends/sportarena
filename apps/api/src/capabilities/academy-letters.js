// Academy enrolment letters: the branded confirmation of a place, produced by the shared branded-document stack (templates, brand kits, encrypted
// PDF storage, append-only `generated_documents`). Nothing new is stored: the words are a snapshot taken from the enrolment, the programme version it
// was accepted under, the charges as snapshotted at enrolment and the agreements accepted, and the PDF bytes are the record. No contact details,
// date of birth or clinical data are ever printed.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { requireApproved } from '../access.js';
import { saveEncrypted } from '../doc-store.js';
import { orgFor } from '../org-access.js';
import { isYouth } from '../youth.js';
import { toMajor } from '../currency.js';
import { STAFF, actFor, INVOICE_NO_SQL } from '../academy.js';
import { starterFor } from '../documents/layout.js';
import { renderEnrolmentLetter } from '../documents/render.js';
import { loadLogo, mustAccess } from './branded-documents.js';

const TAG = 'Academy';
const KIND = { registration: 'Joining fee', deposit: 'Deposit', tuition: 'Tuition', instalment: 'Instalment', trial: 'Trial fee', pack: 'Session pack' };
const BILLING = { one_time: 'One payment', instalments: 'Instalments', monthly: 'Monthly', pack: 'Session pack' };
const STATUS = { awaiting_payment: 'Awaiting payment', paid: 'Paid', waived: 'Waived', refunded: 'Refunded', partially_refunded: 'Part refunded', cancelled: 'Cancelled' };
const ds = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const money = (m, cur) => `${cur} ${toMajor(Number(m), cur)}`;

async function enrolmentFor(enrolmentId) {
  const e = await one(
    `SELECT e.*, k.organisation_id, k.name AS group_name, u.display_name AS athlete_name FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id
      WHERE e.id=$1 AND e.programme_id IS NOT NULL`, [enrolmentId]);
  if (!e) throw notFound('Enrolment');
  return e;
}
/** Staff of the academy (owner/admin), or the enrolled adult / the verified guardian of the young person. 404 for anyone else. */
async function access(user, e, { write = false } = {}) {
  const staff = await orgFor(user, e.organisation_id, STAFF, { write }).then(() => true, () => false);
  if (staff) return { staff: true };
  const family = await actFor(user, e.user_id).then(() => true, () => false);
  if (!family) throw notFound('Enrolment');
  return { staff: false };
}
/** Live check on every download (a revoked guardian or removed staff member loses access at once). */
export async function canReadEnrolmentLetter(user, enrolmentId) {
  const e = await enrolmentFor(enrolmentId);
  await access(user, e);
}

/** Everything the letter says, frozen at the moment it is issued. */
async function snapshotOf(e, { note }) {
  const p = await one('SELECT * FROM academy_programmes WHERE id=$1', [e.programme_id]);
  const v = await one('SELECT * FROM academy_programme_versions WHERE id=$1', [e.version_id]);
  const org = await one('SELECT o.name, ap.legal_name, ap.billing_address FROM organisations o LEFT JOIN academy_profiles ap ON ap.organisation_id=o.id WHERE o.id=$1', [e.organisation_id]);
  const venues = p.venue_ids?.length ? await many('SELECT name, city FROM venues WHERE id = ANY($1) ORDER BY name', [p.venue_ids]) : [];
  const charges = await many(
    `SELECT ch.kind, ch.due_on, ch.currency, ch.amount_minor, ch.status, ${INVOICE_NO_SQL} AS invoice_number FROM academy_charges ch
      WHERE ch.enrolment_id=$1 OR (ch.application_id IS NOT NULL AND ch.application_id=$2) ORDER BY ch.due_on, ch.id`, [e.id, e.application_id]);
  const agreed = v?.policy_version_ids?.length ? await many(
    `SELECT pol.title, pv.version, a.created_at FROM org_acknowledgements a JOIN org_policy_versions pv ON pv.id=a.policy_version_id JOIN org_policies pol ON pol.id=pv.policy_id
      WHERE a.subject_id=$1 AND a.policy_version_id = ANY($2) ORDER BY pol.title`, [e.user_id, v.policy_version_ids]) : [];
  const youth = await isYouth(e.user_id);
  const place = [
    { title: 'Programme', value: p.title }, { title: 'Athlete', value: e.athlete_name }, { title: 'Group', value: e.group_name },
    { title: 'Programme dates', value: p.starts_on && p.ends_on ? `${ds(p.starts_on)} to ${ds(p.ends_on)}` : p.starts_on ? `from ${ds(p.starts_on)}` : 'Ongoing' },
    ...(p.cadence ? [{ title: 'When', value: `${p.cadence}${p.session_minutes ? ` · ${p.session_minutes} minutes` : ''}` }] : []),
    ...(venues.length ? [{ title: 'Where', value: venues.map((x) => [x.name, x.city].filter(Boolean).join(', ')).join(' · ') }] : []),
    { title: 'Place confirmed', value: ds(e.enrolled_at) },
    ...(v ? [{ title: 'Terms', value: `Version ${v.version} · ${BILLING[v.billing_model] ?? v.billing_model}${v.sessions_in_pack ? ` · ${v.sessions_in_pack} sessions` : ''}` }] : []),
  ];
  const sections = [
    { title: 'Welcome', body: note?.trim() || `We are delighted to confirm ${e.athlete_name}'s place in ${p.title} at ${org.name}. This letter sets out the details of the place and what to expect.` },
    { title: 'Your place', items: place },
  ];
  if (charges.length) sections.push({ title: 'Fees and payment', items: charges.map((ch) => ({ title: `${KIND[ch.kind] ?? ch.kind} · due ${ds(ch.due_on)}`, value: money(ch.amount_minor, ch.currency), meta: `${STATUS[ch.status] ?? ch.status}${ch.invoice_number ? ` · invoice ${ch.invoice_number}` : ''}` })) });
  if (agreed.length) sections.push({ title: 'Agreements accepted', items: agreed.map((a) => ({ title: a.title, value: `Version ${a.version}`, meta: `Accepted ${ds(a.created_at)}` })) });
  if (p.equipment?.trim()) sections.push({ title: 'What to bring', body: p.equipment.trim() });
  sections.push({ title: 'Changes and questions', body: 'If anything here is not right, or you need to change or withdraw, please contact the academy through Gotmygame. Fees shown are as agreed at enrolment and do not change if the programme price changes later.' });
  return {
    title: 'Enrolment confirmation', organisation: org.name, legal_name: org.legal_name ?? null, address: org.billing_address ?? null,
    addressee: youth ? `Parent / guardian of ${e.athlete_name}` : e.athlete_name, reference: `ENR-${e.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`, issued_at: new Date().toISOString(), sections,
  };
}

const view = (r) => ({ ...r, url: `/api/v1/branded-documents/${r.id}/file` });
const COLS = 'id, family, source_type, source_id, template_version_id, size_bytes, sha256, pages, generated_by, created_at';

cap({
  name: 'generate_academy_enrolment_letter', method: 'POST', path: '/academy/enrolments/:id/letter', tag: TAG, status: 201,
  summary: 'Issue the branded enrolment letter for an enrolment. Academy staff (owner/admin) may add a welcome note and pick a published enrolment_letter template; each issue is a new immutable document. The enrolled adult or a verified guardian gets the standard letter (the existing one if it was already issued). The letter shows the programme terms accepted, group, fees as charged and agreements accepted; never contact details, date of birth or health data.',
  input: z.object({ id, note: z.string().trim().min(1).max(1000).optional(), template_id: id.optional() }),
  async handler({ user }, i) {
    requireApproved(user);
    const e = await enrolmentFor(i.id);
    const { staff } = await access(user, e);
    if (!staff && (i.note || i.template_id)) throw forbidden('Only academy staff can customise the letter');
    if (e.status === 'withdrawn' || e.status === 'transferred') throw conflict('This enrolment has ended, so no confirmation letter is issued');
    if (!staff) {
      const existing = await one(`SELECT ${COLS} FROM generated_documents WHERE source_type='academy_enrolment' AND source_id=$1 ORDER BY created_at DESC, id LIMIT 1`, [e.id]);
      if (existing) return view(existing);
    }
    let ver = null;
    if (i.template_id) {
      const t = await one('SELECT * FROM document_templates WHERE id=$1', [i.template_id]);
      await mustAccess(user, t, 'Template');
      if (t.family !== 'enrolment_letter' || t.organisation_id !== e.organisation_id) throw badRequest('Pick one of this academy\'s enrolment letter templates');
      if (t.status === 'retired' || t.archived_at) throw conflict('That template is retired');
      ver = await one('SELECT * FROM document_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1', [t.id]);
      if (!ver) throw conflict('Publish the template before generating documents from it');
    }
    const layout = ver ? ver.layout : starterFor('enrolment_letter', 'classic');
    const snapshot = await snapshotOf(e, { note: i.note });
    const { buffer, pages } = await renderEnrolmentLetter({ layout, kit: ver?.kit_snapshot ?? null, logo: await loadLogo(ver?.logo_asset_id), snapshot });
    const { id: did, file } = await saveEncrypted('documents', 'generated_documents.file', buffer);
    const row = await one(
      `INSERT INTO generated_documents(id, family, source_type, source_id, template_version_id, logo_asset_id, file_name, size_bytes, sha256, pages, generated_by)
       VALUES ($1,'enrolment_letter','academy_enrolment',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
      [did, e.id, ver?.id ?? null, ver?.logo_asset_id ?? null, file, buffer.length, createHash('sha256').update(buffer).digest('hex'), pages, user.id]);
    await audit(null, user.id, 'generate_document', 'generated_documents', did);
    return view(row);
  },
});

cap({
  name: 'list_academy_enrolment_letters', method: 'GET', path: '/academy/enrolments/:id/letters', tag: TAG,
  summary: 'The letters issued for one enrolment, newest first (academy staff, the enrolled adult or the verified guardian).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const e = await enrolmentFor(i.id);
    await access(user, e);
    const rows = await many(`SELECT ${COLS} FROM generated_documents WHERE source_type='academy_enrolment' AND source_id=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`, [e.id, i.limit, i.offset]);
    return rows.map(view);
  },
});
