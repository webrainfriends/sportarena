// Relocation readiness for an international academy application (#799). Derived on every read, never stored, the same way trips.js readiness() works
// (#485): an athlete is ready only when no mandatory item is unmet. Imported by academy.js (the enrolment gate), so it depends on the database only.
import { conflict } from './errors.js';

const p2 = (n) => String(n).padStart(2, '0');
/** pg returns a date column as a Date at local midnight, so read it with local parts. */
export const plain = (d) => (!d ? null : d instanceof Date ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : String(d).slice(0, 10));
export const today = () => new Date().toISOString().slice(0, 10);
export const addMonths = (d, m) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
export const daysTo = (d) => (d ? Math.round((new Date(`${plain(d)}T12:00:00Z`) - new Date(`${today()}T12:00:00Z`)) / 864e5) : null);

export const PASSPORT_STATUS = ['held', 'not_held', 'unknown'];
export const VISA_STATUS = ['not_required', 'required', 'submitted', 'approved', 'unknown'];
/** Months a passport must stay valid after arrival. A floor for a travel document; the template may ask for more through `expiry_months`. */
export const PASSPORT_MIN_MONTHS = 6;

/** Items of a case with their live state: verified evidence that has since expired, or a linked compliance record that lapsed, no longer counts. */
export async function caseState(c, kase) {
  const items = (await c.query(
    `SELECT i.*, r.status AS rec_status, r.expires_on AS rec_expires
       FROM academy_intl_items i LEFT JOIN comp_records r ON r.id=i.comp_record_id WHERE i.case_id=$1 ORDER BY i.due_on NULLS LAST, i.key`, [kase.id])).rows;
  const docs = (await c.query('SELECT kind, status, expires_on FROM academy_intl_documents WHERE case_id=$1', [kase.id])).rows;
  const conds = (await c.query('SELECT * FROM academy_offer_conditions WHERE case_id=$1 ORDER BY created_at, id', [kase.id])).rows;
  const anchor = plain(kase.arrival_on) ?? today();
  const out = items.map((i) => {
    const issues = [];
    const exp = plain(i.rec_expires) ?? plain(i.expires_on);
    let met = i.status === 'verified' || i.status === 'waived';
    if (i.status === 'verified') {
      if (i.comp_record_id && i.rec_status !== 'valid') { met = false; issues.push('evidence_lapsed'); }
      else if (exp && exp < anchor) { met = false; issues.push('expired'); }
    }
    if (i.kind === 'travel_document' && i.status === 'verified') {
      const d = docs.find((x) => x.kind === i.key);
      if (!d) { met = false; issues.push('document_missing'); }
      else if (i.key === 'passport' && (d.status !== 'held' || !d.expires_on || plain(d.expires_on) < addMonths(anchor, PASSPORT_MIN_MONTHS))) { met = false; issues.push('passport_validity'); }
      else if (i.key === 'visa' && !['approved', 'not_required'].includes(d.status)) { met = false; issues.push('visa_not_granted'); }
    }
    if (!met && issues.length === 0) issues.push(i.status === 'rejected' ? 'rejected' : i.status === 'submitted' ? 'awaiting_review' : 'open');
    return { id: i.id, key: i.key, kind: i.kind, label: i.label, mandatory: i.mandatory, status: i.status, due_on: plain(i.due_on), expires_on: exp, comp_record_id: i.comp_record_id, decided_by: i.decided_by, decided_at: i.decided_at, met, issues: met ? [] : issues, days_left: daysTo(exp), overdue: !met && i.due_on ? plain(i.due_on) < today() : false };
  });
  const unmetConditions = conds.filter((x) => x.status === 'proposed' || x.status === 'approved');
  const blocking = [
    ...out.filter((i) => i.mandatory && !i.met).map((i) => ({ type: 'item', key: i.key, kind: i.kind, label: i.label, issues: i.issues })),
    ...unmetConditions.map((x) => ({ type: 'condition', id: x.id, label: x.status === 'proposed' ? 'Offer terms pending academy approval' : x.text, issues: [x.status === 'proposed' ? 'awaiting_owner_approval' : 'condition_unmet'] })),
  ];
  const mandatory = out.filter((i) => i.mandatory);
  return { items: out, conditions: conds, documents: docs, readiness: { ready: blocking.length === 0, blocking, mandatory_total: mandatory.length, mandatory_met: mandatory.filter((i) => i.met).length, items_total: out.length, items_met: out.filter((i) => i.met).length, conditions_total: conds.filter((x) => x.status !== 'withdrawn').length, conditions_met: conds.filter((x) => x.status === 'met').length } };
}

/** The gate: refuse enrolment of an international athlete while anything mandatory is unmet. A no-op when the application has no international case. */
export async function assertReadyToEnrol(c, applicationId) {
  const kase = (await c.query('SELECT * FROM academy_intl_cases WHERE application_id=$1', [applicationId])).rows[0];
  if (!kase) return;
  const { readiness } = await caseState(c, kase);
  if (!readiness.ready) throw conflict('This international admission is not ready: mandatory relocation items are still open', { code: 'international_readiness', blocking: readiness.blocking });
}
