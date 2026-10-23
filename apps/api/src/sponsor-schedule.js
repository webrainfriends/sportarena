// Sponsorship contribution lines -> a deterministic, reviewable schedule of dated obligations.
//
// Rules (also in docs/sponsorship-agreements.md):
//  * Dates are calendar dates ('YYYY-MM-DD'); the agreement's timezone says which zone they are meant in.
//  * Monthly/quarterly occurrences are anchored to the FIRST due date, not chained: 31 Jan -> 28/29 Feb -> 31 Mar (month-end clamp).
//  * Both the agreement's starts_on and ends_on are inclusive. A due date outside them is rejected: nothing is ever scheduled past the term.
//  * Money: either `amount_cents` per instalment or a `total_cents` split; a split gives every instalment floor(total/n) and the
//    LAST one the remainder, so the occurrences always add up to the committed total exactly.
//  * Goods: the committed quantity is split the same way (last occurrence absorbs the remainder).
import { z } from 'zod';
import { badRequest } from './errors.js';
import { isSupportedCurrency } from './currency.js';

const date = z.string().date();
export const LINE = z.object({
  kind: z.enum(['money', 'goods', 'endorsement', 'service']),
  label: z.string().min(1).max(160),
  currency: z.string().length(3).toUpperCase().optional(),
  amount_cents: z.coerce.number().int().positive().optional().describe('money: per instalment, minor units'),
  total_cents: z.coerce.number().int().positive().optional().describe('money: committed total, split across the instalments'),
  estimate_cents: z.coerce.number().int().min(0).optional().describe('goods valuation / endorsement estimate. An estimate, never counted as cash paid'),
  quantity: z.coerce.number().int().positive().optional().describe('goods: units to deliver; service: vouchers (sessions / slots / trips) funded'),
  service_type: z.enum(['coaching', 'venue', 'travel', 'medical']).optional().describe('service lines only. Funding a service pays for it; it never grants access to the recipient\'s health or other private data'),
  unit: z.string().max(30).optional(),
  cadence: z.enum(['once', 'weekly', 'monthly', 'quarterly', 'custom']).default('once'),
  first_due_on: date.optional(),
  instalments: z.coerce.number().int().min(1).max(120).optional(),
  custom_dates: z.array(date).min(1).max(120).optional(),
  promoter: z.enum(['sponsor', 'recipient']).optional().describe('endorsement: who promotes the brand; the other party reviews the evidence'),
  terms: z.object({
    channels: z.array(z.string().max(40)).max(10).optional(), placement: z.string().max(300).optional(), approval_criteria: z.string().max(600).optional(),
    asset_usage: z.string().max(600).optional(), exclusivity: z.string().max(600).optional(),
  }).default({}),
});

const parts = (iso) => iso.split('-').map(Number);
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addDays(d, n) { const [y, m, dd] = parts(d); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); }
/** Same day-of-month `n` months later, clamped to the last day of a shorter month. */
export function addMonths(d, n) {
  const [y, m, dd] = parts(d), t = m - 1 + n, ty = y + Math.floor(t / 12), tm = ((t % 12) + 12) % 12 + 1;
  return iso(ty, tm, Math.min(dd, daysIn(ty, tm)));
}

/** Expand one line into its occurrences. `window` = { starts_on, ends_on } of the agreement (either may be null for a one-off). */
export function expandLine(line, window = {}) {
  const fail = (m) => { throw badRequest(`${line.label}: ${m}`); };
  const cur = line.currency;
  if (line.kind === 'money') {
    if (!cur || !isSupportedCurrency(cur)) fail('money needs a supported currency');
    if ((line.amount_cents == null) === (line.total_cents == null)) fail('give either amount_cents (per instalment) or total_cents, not both');
  } else {
    if (line.amount_cents != null || line.total_cents != null) fail('only money lines carry a cash amount; use estimate_cents for a valuation');
    if (line.estimate_cents != null && (!cur || !isSupportedCurrency(cur))) fail('an estimate needs a supported currency');
  }
  if ((line.kind === 'goods' || line.kind === 'service') && !line.quantity) fail(`${line.kind} needs a quantity`);
  if (line.kind !== 'goods' && line.kind !== 'service' && line.quantity != null) fail('quantity is only for goods and services');
  if (line.kind === 'service' && !line.service_type) fail('say which service (coaching, venue, travel or medical)');
  if (line.kind !== 'service' && line.service_type) fail('service_type is only for service lines');
  if (line.kind === 'endorsement' && !line.promoter) fail('say who promotes (sponsor or recipient)');
  if (line.kind !== 'endorsement' && (line.promoter || Object.keys(line.terms ?? {}).length)) fail('promoter and endorsement terms are only for endorsement lines');

  let dues;
  if (line.cadence === 'custom') {
    if (!line.custom_dates?.length) fail('custom cadence needs custom_dates');
    dues = [...line.custom_dates];
    if (dues.some((d, i) => i && d <= dues[i - 1])) fail('custom dates must be strictly increasing and not repeated');
    if (line.instalments != null && line.instalments !== dues.length) fail('instalments does not match the number of custom dates');
  } else {
    if (!line.first_due_on) fail('first_due_on is required');
    const n = line.cadence === 'once' ? 1 : line.instalments;
    if (!n) fail('instalments is required for a recurring line');
    if (line.cadence === 'once' && line.instalments > 1) fail('a one-off line has a single instalment');
    const step = { once: (i) => addDays(line.first_due_on, 0 * i), weekly: (i) => addDays(line.first_due_on, 7 * i), monthly: (i) => addMonths(line.first_due_on, i), quarterly: (i) => addMonths(line.first_due_on, 3 * i) }[line.cadence];
    dues = Array.from({ length: n }, (_, i) => step(i));
  }
  const { starts_on: s, ends_on: e } = window;
  if (line.cadence !== 'once' && line.cadence !== 'custom' && (!s || !e)) fail('a recurring line needs the agreement period (starts_on and ends_on)');
  if (s && dues[0] < s) fail(`first due date ${dues[0]} is before the agreement starts (${s})`);
  if (e && dues.at(-1) > e) fail(`the schedule runs to ${dues.at(-1)}, past the end of the agreement (${e}); shorten it or extend the period`);

  const n = dues.length;
  let amounts = dues.map(() => null), qty = dues.map(() => null);
  if (line.kind === 'money') {
    const base = line.amount_cents ?? Math.floor(line.total_cents / n);
    if (base < 1) fail('total_cents is too small to split into that many instalments');
    amounts = dues.map((_, i) => (line.total_cents != null && i === n - 1 ? line.total_cents - base * (n - 1) : base));
  }
  if (line.kind === 'goods' || line.kind === 'service') {
    if (line.quantity < n) fail('the quantity cannot be split into that many dues');
    const base = Math.floor(line.quantity / n);
    qty = dues.map((_, i) => (i === n - 1 ? line.quantity - base * (n - 1) : base));
  }
  return dues.map((due_on, i) => ({ seq: i + 1, kind: line.kind, due_on, amount_cents: amounts[i], currency: line.kind === 'money' ? cur : null, quantity: qty[i] }));
}

/** Validate every line and build the whole schedule plus per-currency totals. Cash and estimates are kept apart; currencies are never mixed. */
export function buildSchedule(lines, window) {
  const occurrences = lines.flatMap((l, li) => expandLine(l, window).map((o) => ({ ...o, line: li + 1, label: l.label })));
  const committed = {}, estimated = {};
  for (const o of occurrences) if (o.kind === 'money') committed[o.currency] = (committed[o.currency] ?? 0) + o.amount_cents;
  for (const l of lines) if (l.estimate_cents != null) estimated[l.currency] = (estimated[l.currency] ?? 0) + l.estimate_cents;
  occurrences.sort((a, b) => a.due_on.localeCompare(b.due_on) || a.line - b.line || a.seq - b.seq);
  return { occurrences, committed, estimated_not_cash: estimated };
}
