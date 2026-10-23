// Contribution lines of a sponsorship offer (#309): the form state the offer builder edits, and its conversion to the API's `lines`.
// Pure functions only (no React / React Native) so they are unit-tested. The server stays the authority on every rule (schedule, money,
// quantities, period): `lineProblems` only spots what is plainly missing so the person is told before the review step.

export const KINDS = [
  { kind: 'money', emoji: '💰', title: 'Cash', add: 'Cash', label: 'Cash support' },
  { kind: 'goods', emoji: '📦', title: 'Goods', add: 'Goods', label: '' },
  { kind: 'service', emoji: '🎟️', title: 'Service', add: 'Service', label: '' },
  { kind: 'endorsement', emoji: '📣', title: 'Endorsement', add: 'Endorsement', label: 'Brand promotion' },
];
export const CADENCES = [{ value: 'once', label: 'Once' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'custom', label: 'Custom dates' }];
export const SERVICES = [{ value: 'coaching', label: 'Coaching' }, { value: 'venue', label: 'Venue time' }, { value: 'travel', label: 'Travel' }, { value: 'medical', label: 'Medical care' }];
export const CHANNELS = ['Instagram', 'Facebook', 'YouTube', 'X', 'TikTok', 'LinkedIn', 'Website', 'Match-day kit', 'Venue signage', 'Broadcast'];
export const MAX_LINES = 12;

export const digitsOf = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
/** "30,000.50" in whole currency units -> minor units; null when empty or not a positive amount. */
export function toMinor(text, cur) {
  const n = Number(String(text ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10 ** digitsOf(cur)) : null;
}
export const fromMinor = (cents, cur) => (cents == null ? '' : String(cents / 10 ** digitsOf(cur)));

let seq = 0;
export function newLine(kind, currency = 'INR') {
  const k = KINDS.find((x) => x.kind === kind);
  return {
    key: `line-${Date.now().toString(36)}-${++seq}`, kind, label: k.label, currency, mode: 'each', amount: '', estimate: '', quantity: 1, unit: '', service_type: 'coaching',
    cadence: kind === 'money' ? 'monthly' : 'once', first_due_on: undefined, instalments: 3, custom_dates: [undefined],
    promoter: 'recipient', channels: [], placement: '', approval_criteria: '', asset_usage: '', exclusivity: '',
  };
}

const text = (s) => (s ?? '').trim();
const dates = (l) => [...new Set((l.custom_dates ?? []).filter(Boolean))].sort();

/** The API line for one editing line. `currency` overrides the line's own (when a budget fixes the currency). */
export function toApiLine(l, currency = l.currency) {
  const out = { kind: l.kind, label: text(l.label) };
  if (l.kind === 'money') {
    out.currency = currency;
    const cents = toMinor(l.amount, currency);
    if (cents != null) out[l.mode === 'total' ? 'total_cents' : 'amount_cents'] = cents;
  }
  const est = l.kind === 'money' ? null : toMinor(l.estimate, currency);
  if (est != null) { out.estimate_cents = est; out.currency = currency; }
  if (l.kind === 'goods' || l.kind === 'service') out.quantity = l.quantity;
  if (l.kind === 'goods' && text(l.unit)) out.unit = text(l.unit);
  if (l.kind === 'service') out.service_type = l.service_type;
  out.cadence = l.cadence;
  if (l.cadence === 'custom') out.custom_dates = dates(l);
  else {
    if (l.first_due_on) out.first_due_on = l.first_due_on;
    if (l.cadence !== 'once') out.instalments = l.instalments;
  }
  if (l.kind === 'endorsement') {
    out.promoter = l.promoter;
    const terms = { channels: l.channels?.length ? l.channels.map((x) => x.slice(0, 40)) : undefined, placement: text(l.placement) || undefined, approval_criteria: text(l.approval_criteria) || undefined, asset_usage: text(l.asset_usage) || undefined, exclusivity: text(l.exclusivity) || undefined };
    out.terms = Object.fromEntries(Object.entries(terms).filter(([, v]) => v !== undefined));
  }
  return out;
}

/** Plain-words list of what is still missing on a line (empty when it can be previewed). */
export function lineProblems(l) {
  const p = [];
  if (!text(l.label)) p.push('give it a name');
  if (l.kind === 'money' && toMinor(l.amount, l.currency) == null) p.push('enter an amount');
  if ((l.kind === 'goods' || l.kind === 'service') && !(l.quantity >= 1)) p.push('enter a quantity');
  if (l.cadence === 'custom' ? !dates(l).length : !l.first_due_on) p.push(l.cadence === 'custom' ? 'pick at least one date' : l.kind === 'endorsement' ? 'pick the date the evidence is due' : 'pick the first due date');
  if (l.cadence !== 'once' && l.cadence !== 'custom' && !(l.instalments >= 2)) p.push('choose how many instalments');
  if (text(l.estimate) && toMinor(l.estimate, l.currency) == null) p.push('the estimated value is not a valid amount');
  return p;
}

/** All the lines of an offer: the API payload, or the first problem to show. `fixedCurrency` (an authorized budget's) replaces every currency. */
export function buildLines(lines, fixedCurrency) {
  if (!lines.length) return { problem: 'Add at least one contribution.' };
  for (const l of lines) { const p = lineProblems(l); if (p.length) return { problem: `${text(l.label) || KINDS.find((k) => k.kind === l.kind).title}: ${p.join(', ')}.` }; }
  return { lines: lines.map((l) => toApiLine(l, fixedCurrency ?? l.currency)) };
}

/** Preview totals line, each currency on its own. */
export function money(cents, cur) {
  try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`.trim(); }
}
