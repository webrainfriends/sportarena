// Academy OS 3/3 close-out: leadership insights. Read-only projections (see src/academy-insights.js). The finance role gets the money fields only.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { orgFor } from '../org-access.js';
import { audit } from '../helpers.js';
import { badRequest } from '../errors.js';
import { STAFF, STAFF_MONEY } from '../academy.js';
import { pnlTrend, branchScorecard, dataQuality } from '../academy-insights.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const span = (i) => {
  const from = i.from ?? daysAgo(180), to = i.to ?? today();
  if (to < from) throw badRequest('The end date is before the start date');
  if (Date.parse(to) - Date.parse(from) > 800 * 864e5) throw badRequest('Choose a period of at most about two years');
  return { from, to };
};

cap({
  name: 'get_academy_pnl_trend', method: 'GET', path: '/organisations/:id/academy/pnl/trend', tag: 'Academy',
  summary: 'Monthly management trend (owner/admin/finance), per currency and never summed across currencies: revenue (invoice basis), cash collected, staff cost (approved payroll), venue cost (confirmed bookings), other cost, result, the totals, the prior window of equal length and the percentage change. Optional branch filter.',
  input: z.object({ id, from: day.optional(), to: day.optional(), branch_id: id.optional() }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF_MONEY);
    return pnlTrend(i.id, { ...span(i), branchId: i.branch_id ?? null });
  },
});

cap({
  name: 'get_academy_branch_scorecard', method: 'GET', path: '/organisations/:id/academy/branch-scorecard', tag: 'Academy',
  summary: 'Branch comparison (owner/admin; finance sees the money columns only): athletes against target and capacity, delivery (sessions, attendance, cancellations, staffing exceptions), retention indicators and per-currency finance with margin. Every status is a stated rule over a measured figure (the rules are returned); there is no score and nothing is decided automatically. Includes how complete the underlying evidence is.',
  input: z.object({ id, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, STAFF_MONEY);
    const p = span({ from: i.from ?? daysAgo(90), to: i.to });
    const out = await branchScorecard(i.id, { ...p, moneyOnly: !STAFF.includes(role) });
    out.data_quality = STAFF.includes(role) ? await dataQuality(i.id, p) : null;
    await audit(null, user.id, 'read_academy_branch_scorecard', 'organisations', i.id);
    return out;
  },
});
