// Doctor workspace (issue #212, slice 2a): problems, allergies and medications with provenance and reconciliation.
// Patients report what they have and take; a verified doctor with the athlete's full consent confirms, disputes or corrects. Entries are
// append-only (a correction supersedes, the old row stays). Unknown vs "none reported" are explicit; nothing infers adherence, allergy
// absence or medication safety, and there is deliberately no prescribing, dose or interaction logic here.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';

const t = (n) => z.string().trim().max(n);
const day = z.string().date();
const flag = z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]); // query strings: "false" must mean false
const entry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('problem'), name: t(200).min(1), status: z.enum(['active', 'resolved', 'uncertain']).default('active'), onset: day.optional(), note: t(1000).optional() }),
  z.object({ kind: z.literal('allergy'), name: t(200).min(1).describe('substance'), status: z.enum(['active', 'resolved', 'uncertain']).default('active'), reaction: t(500).optional(), note: t(1000).optional() }),
  z.object({ kind: z.literal('medication'), name: t(200).min(1), status: z.enum(['active', 'stopped', 'uncertain']).default('active'), form: t(80).optional(), strength: t(80).optional(), route: t(80).optional(), frequency: t(120).optional(),
    started_on: day.optional(), stopped_on: day.optional(), prescriber: t(200).optional().describe('as reported; recording a medicine is not prescribing it'), note: t(1000).optional() }),
]);
const seal = (o) => encrypt(JSON.stringify(o), 'clinical_context.detail');
const COLS = 'id, athlete_id, kind, status, source, verification, recorded_by, reconciled_by, reconciled_at, supersedes_id, superseded_at, review_date, created_at';
const shape = (r) => { const { label_enc, detail_enc, ...m } = r; return { ...m, name: decrypt(label_enc, 'clinical_context.label'), detail: detail_enc ? JSON.parse(decrypt(detail_enc, 'clinical_context.detail')) : {} }; };
const split = ({ kind, name, status, ...detail }) => ({ kind, status, label: name, detail });
const insert = (c, athleteId, by, source, e, extra = {}) => {
  const { kind, status, label, detail } = split(e);
  return c.query(`INSERT INTO clinical_context_entries(athlete_id, kind, status, source, label_enc, detail_enc, recorded_by, supersedes_id, review_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}, label_enc, detail_enc`,
    [athleteId, kind, status, source, encrypt(label, 'clinical_context.label'), Object.keys(detail).length ? seal(detail) : null, by, extra.supersedes ?? null, extra.review_date ?? null]);
};
const lockGrant = async (c, athleteId, providerId) => {
  if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [athleteId, providerId])).rows[0]) throw forbidden('The athlete has not granted you access');
};
/** Doctor gate shared by writes: verified doctor credential now, consent now. Returns the credential for the in-transaction re-check. */
async function doctorGate(user, athleteId, action) {
  if (athleteId === user.id) throw badRequest('Use your own athlete view for your own entries');
  const cred = await requireVerifiedProvider(user.id, { action, athleteId, types: ['doctor'] });
  if (!(await hasGrant(athleteId, user.id))) throw forbidden('The athlete has not granted you access');
  return cred;
}

cap({
  name: 'add_context_entry', credential: true, method: 'POST', path: '/medical/context', tag: 'Health', status: 201,
  summary: 'Record a problem, allergy/intolerance or medication. Athletes record their own (source patient_reported, unverified until a doctor reconciles it). A verified doctor with full consent records for the athlete (source clinician_recorded). Recording a medicine is not prescribing it. Encrypted; audit-logged.',
  input: z.object({ athlete_id: id.optional().describe('doctors only; omit to record your own'), entry, review_date: day.optional().describe('doctors only: when to review this entry') }),
  async handler({ user }, i) {
    const athlete = i.athlete_id ?? user.id;
    if (athlete === user.id) {
      if (i.review_date) throw badRequest('Only a doctor sets a review date');
      const r = (await insert(pool, user.id, user.id, 'patient_reported', i.entry)).rows[0];
      await audit(null, user.id, 'write_clinical', 'clinical_context_entries', r.id);
      return shape(r);
    }
    const cred = await doctorGate(user, athlete, 'add_context_entry');
    const r = await tx(async (c) => { await lockCredential(c, cred); await lockGrant(c, athlete, user.id); return (await insert(c, athlete, user.id, 'clinician_recorded', i.entry, { review_date: i.review_date })).rows[0]; });
    await audit(null, user.id, 'write_clinical', 'clinical_context_entries', r.id);
    return shape(r);
  },
});

cap({
  name: 'reconcile_context_entry', credential: true, method: 'POST', path: '/medical/context/:id/reconcile', tag: 'Health', status: 201,
  summary: 'Doctor reconciles an entry: `confirm` or `dispute` it, or `correct` it with a replacement. Corrections add a new entry that supersedes the old one, which stays in history. An athlete may `correct` only their own entry that no doctor has reconciled yet. Concurrent corrections of the same entry: one wins, the other gets 409.',
  input: z.object({ id, action: z.enum(['confirm', 'dispute', 'correct']), entry: entry.optional().describe('required for correct (same kind as the original)'), review_date: day.optional() }),
  async handler({ user }, i) {
    const o = await one(`SELECT ${COLS} FROM clinical_context_entries WHERE id=$1`, [i.id]);
    if (!o) throw notFound('Entry');
    const own = o.athlete_id === user.id;
    if (i.action === 'correct' && (!i.entry || i.entry.kind !== o.kind)) throw badRequest('A correction needs a replacement entry of the same kind');
    if (own) {
      if (i.action !== 'correct') throw forbidden('Only a doctor can confirm or dispute an entry');
      if (o.source !== 'patient_reported' || o.verification !== 'unverified') throw forbidden('A doctor has already reviewed this entry; ask them to correct it');
    }
    const cred = own ? null : await doctorGate(user, o.athlete_id, 'reconcile_context_entry');
    const r = await tx(async (c) => {
      if (cred) { await lockCredential(c, cred); await lockGrant(c, o.athlete_id, user.id); }
      const cur = (await c.query('SELECT superseded_at, verification FROM clinical_context_entries WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (cur.superseded_at) throw conflict('This entry was already corrected; reload to see the current one');
      if (own && cur.verification !== 'unverified') throw conflict('A doctor reviewed this entry in the meantime');
      if (i.action !== 'correct') {
        return (await c.query(`UPDATE clinical_context_entries SET verification=$2, reconciled_by=$3, reconciled_at=now(), review_date=COALESCE($4, review_date) WHERE id=$1 RETURNING ${COLS}, label_enc, detail_enc`,
          [i.id, i.action === 'confirm' ? 'confirmed' : 'disputed', user.id, i.review_date ?? null])).rows[0];
      }
      await c.query('UPDATE clinical_context_entries SET superseded_at=now() WHERE id=$1', [i.id]);
      const n = (await insert(c, o.athlete_id, user.id, own ? 'patient_reported' : 'clinician_recorded', i.entry, { supersedes: i.id, review_date: i.review_date })).rows[0];
      if (!own) await c.query("UPDATE clinical_context_entries SET verification='confirmed', reconciled_by=$2, reconciled_at=now() WHERE id=$1", [n.id, user.id]);
      return (await c.query(`SELECT ${COLS}, label_enc, detail_enc FROM clinical_context_entries WHERE id=$1`, [n.id])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_context_entries', r.id);
    return shape(r);
  },
});

cap({
  name: 'set_context_declaration', credential: true, method: 'POST', path: '/medical/context/declarations', tag: 'Health', status: 201,
  summary: 'State explicitly that no allergies / no medicines are reported, or reset to unknown. Without a declaration or entries the state is `unknown`, never "none". Athletes declare for themselves (patient_reported); a verified doctor with full consent may record one after asking. History is kept.',
  input: z.object({ athlete_id: id.optional(), kind: z.enum(['allergy', 'medication']), state: z.enum(['none_reported', 'unknown']) }),
  async handler({ user }, i) {
    const athlete = i.athlete_id ?? user.id;
    const mine = athlete === user.id;
    const cred = mine ? null : await doctorGate(user, athlete, 'set_context_declaration');
    const r = await tx(async (c) => {
      if (cred) { await lockCredential(c, cred); await lockGrant(c, athlete, user.id); }
      if (i.state === 'none_reported' && (await c.query("SELECT 1 FROM clinical_context_entries WHERE athlete_id=$1 AND kind=$2 AND superseded_at IS NULL AND status IN ('active','uncertain')", [athlete, i.kind])).rows[0]) throw conflict(`There are ${i.kind} entries on record; resolve or stop them before declaring none`);
      return (await c.query('INSERT INTO clinical_context_declarations(athlete_id, kind, state, source, recorded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, athlete_id, kind, state, source, created_at', [athlete, i.kind, i.state, mine ? 'patient_reported' : 'clinician_recorded', user.id])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'clinical_context_declarations', r.id);
    return r;
  },
});

cap({
  name: 'list_context', credential: true, method: 'GET', path: '/medical/context', tag: 'Health',
  summary: 'Current problems, allergies and medications with source and verification, plus per-kind state: `entries`, `none_reported` or `unknown` (the default - missing data is never "none"). Athletes see their own; physios/doctors pass athlete_id (verified credential + full consent; entries by others only back to the grant unless history `all`). include_history adds superseded corrections. Audit-logged.',
  input: z.object({ athlete_id: id.optional(), include_history: flag.default(false), ...page }),
  async handler({ user }, i) {
    const athlete = i.athlete_id ?? user.id;
    let since = null;
    if (athlete !== user.id) {
      await requireVerifiedProvider(user.id, { action: 'list_context', athleteId: athlete });
      if (!(await hasGrant(athlete, user.id))) throw forbidden('The athlete has not granted you access');
      const g = await one('SELECT history_scope, granted_at FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2', [athlete, user.id]);
      if (g.history_scope !== 'all') since = g.granted_at;
    }
    const rows = await many(`SELECT ${COLS}, label_enc, detail_enc FROM clinical_context_entries WHERE athlete_id=$1 AND ($4::boolean OR superseded_at IS NULL) AND ($5::timestamptz IS NULL OR recorded_by=$6 OR created_at >= $5)
      ORDER BY kind, created_at DESC, id LIMIT $2 OFFSET $3`, [athlete, i.limit, i.offset, i.include_history, since, user.id]);
    const entries = rows.map(shape);
    const decl = await many('SELECT DISTINCT ON (kind) kind, state, source, created_at FROM clinical_context_declarations WHERE athlete_id=$1 ORDER BY kind, created_at DESC, id', [athlete]);
    const state = {};
    for (const k of ['problem', 'allergy', 'medication']) {
      const live = (await many("SELECT 1 FROM clinical_context_entries WHERE athlete_id=$1 AND kind=$2 AND superseded_at IS NULL LIMIT 1", [athlete, k])).length;
      const d = decl.find((x) => x.kind === k);
      state[k] = live ? 'entries' : d?.state ?? 'unknown';
    }
    await audit(null, user.id, 'read_clinical', 'clinical_context_entries', athlete);
    return { athlete_id: athlete, state, declarations: decl, entries };
  },
});
