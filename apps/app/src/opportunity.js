// Opportunity wording shared by the Billboard and the application screens (issue #67): what the work is, what it pays (or that it does not),
// what an applicant must share. The server stays authoritative; this only says it plainly.
import { fmtMoney } from './application-forms';

export const TYPE_LABEL = { trial: 'Trial', paid_assignment: 'Paid assignment', volunteering: 'Volunteering', sponsorship: 'Sponsorship', team_role: 'Team role' };
export const COMPENSATION_LABEL = { paid: 'Paid', unpaid: 'Unpaid', expenses: 'Expenses only', in_kind: 'In-kind reward' };
export const UNIT = { match: 'per match', hour: 'per hour', month: 'per month', season: 'per season' };
export const SECTION_LABEL = { video: 'Highlight videos', references: 'Coach references', preferences: 'Recruitment preferences', availability: 'Availability', academic: 'Academic evidence' };
export const SECTION_OPTIONS = Object.entries(SECTION_LABEL).map(([value, label]) => ({ value, label }));

/** One honest line about money. Unstated pay is said to be unstated, never hidden. */
export function payLine(p) {
  const amount = p.budget_cents != null ? fmtMoney(Number(p.budget_cents), p.currency ?? 'INR') : null;
  if (p.opportunity_type === 'sponsorship' || p.kind === 'sponsorship_wanted' || p.kind === 'sponsor_call') return amount ? `Funding ${amount}` : 'Funding amount not stated';
  if (p.compensation === 'paid') return amount ? `Paid ${amount}${p.rate_unit ? ` ${UNIT[p.rate_unit]}` : ''}` : 'Paid, amount not stated';
  if (p.compensation === 'unpaid') return 'Unpaid';
  if (p.compensation === 'expenses') return 'No fee, expenses covered';
  if (p.compensation === 'in_kind') return 'No fee, in-kind reward';
  return amount ? `Budget ${amount}${p.rate_unit ? ` ${UNIT[p.rate_unit]}` : ''}` : 'Pay not stated';
}

/** 'Closes in 3 days' / 'Applications closed' for a post, or null when it has no deadline. */
export function closing(p, now = Date.now()) {
  if (!p.closes_at) return null;
  const ms = new Date(p.closes_at) - now;
  if (p.is_expired || ms <= 0) return 'Applications closed';
  const d = Math.floor(ms / 86400000);
  return d >= 1 ? `Closes in ${d} day${d > 1 ? 's' : ''}` : `Closes in ${Math.max(1, Math.round(ms / 3600000))} h`;
}

export const ENGAGEMENT_LABEL = { team_member: 'Joined the team roster', association: 'Linked to the event or game' };
export const say = (e) => {
  const code = e?.details?.code;
  if (code === 'opportunity_closed') return 'Applications for this opportunity have closed.';
  if (code === 'positions_filled') return 'All places on this post are filled.';
  if (code === 'evidence_required') return `This post asks you to share: ${(e.details.missing ?? []).map((x) => SECTION_LABEL[x] ?? x).join(', ')}.`;
  return e?.message ?? 'Something went wrong';
};
