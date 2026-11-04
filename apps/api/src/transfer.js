// Transfer rules as pure functions (#478 / #563): who must approve, whether a movement date is inside the transfer window, and which status moves are legal.
// Nothing here reads the database; the capability supplies facts and acts on the answer, so the same inputs always give the same decision.

export const KINDS = ['permanent', 'loan', 'loan_extension', 'loan_recall', 'release', 'dual_registration', 'international'];
export const KIND_LABEL = {
  permanent: 'Permanent transfer', loan: 'Loan', loan_extension: 'Loan extension', loan_recall: 'Loan recall', release: 'Release / free agent',
  dual_registration: 'Dual registration', international: 'International clearance',
};
export const PARTIES = ['player', 'guardian', 'source_club', 'destination_club', 'authority'];
export const PARTY_LABEL = { player: 'Player', guardian: 'Guardian', source_club: 'Current club', destination_club: 'Destination club', authority: 'Competition authority' };
export const OPEN = ['draft', 'submitted', 'approved'];
export const FLOW = {
  draft: ['submitted', 'withdrawn', 'cancelled'],
  submitted: ['approved', 'rejected', 'withdrawn', 'cancelled', 'draft'],
  approved: ['completed', 'withdrawn', 'cancelled', 'submitted'],
  completed: [], rejected: [], withdrawn: [], cancelled: [],
};
export const canMove = (from, to) => (FLOW[from] ?? []).includes(to);
export const FEE_FLOW = { none: ['agreed'], agreed: ['invoiced', 'none'], invoiced: ['paid'], paid: ['cleared'], cleared: [] };

/**
 * The parties whose approval of the CURRENT version is required. A recall is the parent club exercising its clause, so the player does not consent;
 * a release needs no destination; the competition authority is required whenever the movement is made in a competition season.
 */
export function requiredParties(t, { youth = false, seasoned = false } = {}) {
  const out = [];
  if (t.kind !== 'loan_recall') { out.push('player'); if (youth) out.push('guardian'); }
  if (t.from_team_id) out.push('source_club');
  if (t.to_team_id) out.push('destination_club');
  if (seasoned) out.push('authority');
  return out;
}

/** Where a set of approvals (for the current version only) stands: approved when every required party said yes, rejected on any no. */
export function approvalState(required, decisions) {
  const by = new Map(decisions.map((d) => [d.party, d.decision]));
  const rejected = required.filter((p) => by.get(p) === 'rejected');
  const approved = required.filter((p) => by.get(p) === 'approved');
  const waiting = required.filter((p) => !by.has(p));
  return { required, approved, rejected, waiting, complete: !rejected.length && !waiting.length };
}

const ymd = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v == null ? null : String(v).slice(0, 10));
/** Is `onDay` inside the season's transfer window? No window configured = no restriction (stated, not guessed). */
export function windowCheck(season, onDay) {
  const o = ymd(season?.transfer_opens_on), c = ymd(season?.transfer_closes_on), d = ymd(onDay);
  if (!season) return { ok: true, code: 'no_season', reason: 'No competition season, so no transfer window applies' };
  if (!o && !c) return { ok: true, code: 'no_window', reason: 'This season has no transfer window configured' };
  if (o && d < o) return { ok: false, code: 'window_not_open', reason: `The transfer window opens on ${o}`, opens_on: o, closes_on: c };
  if (c && d > c) return { ok: false, code: 'window_closed', reason: `The transfer window closed on ${c}`, opens_on: o, closes_on: c };
  return { ok: true, code: 'window_open', reason: 'Inside the transfer window', opens_on: o, closes_on: c };
}

/** Facts about the movement that can stop completion, each with a stable machine-readable code. */
export function completionBlockers(t, { approvals, window, sanction = null, clearance = true } = {}) {
  const b = [];
  if (!approvals.complete) b.push({ code: 'approvals_missing', reason: `Waiting for: ${approvals.waiting.concat(approvals.rejected).join(', ')}` });
  if (!window.ok && !t.window_exception_by) b.push({ code: window.code, reason: window.reason });
  if (sanction && !t.window_exception_by) b.push({ code: 'sporting_sanction', reason: 'The player has an active sporting sanction that blocks the movement' });
  if (t.kind === 'international' && !(t.clearance_status === 'received')) b.push({ code: 'clearance_missing', reason: 'International clearance has not been received' });
  if (t.clearance_status === 'refused') b.push({ code: 'clearance_refused', reason: 'The clearance was refused' });
  if (!clearance) b.push({ code: 'clearance_unknown', reason: 'Clearance state could not be established' });
  return b;
}
