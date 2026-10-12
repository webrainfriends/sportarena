// Background maintenance: reminders + queued email, release of unpaid holds, credit-note refunds.
// Every category runs in its own try/catch: a failure in one (say, the email bridge) never blocks holds, refunds or waitlists.
import { notificationCycle, isolated } from './notify.js';
import { expireUnpaidHolds } from './booking/holds.js';
import { processRefunds } from './booking/refunds.js';
import { checkSlotAlerts } from './booking/alerts.js';
import { processWaitlist } from './booking/waitlist.js';
import { expireLoyalty } from './booking/loyalty.js';
import { expireUserPlans } from './booking/plans.js';
import { expireStaleRequests } from './lifecycle.js';
import { expireQuotes, sendRenewalReminders } from './insurance-cycle.js';

export const STEPS = [
  ['holds', 'holds_released', expireUnpaidHolds, 0],
  ['refunds', 'refunds', processRefunds, { done: 0, failed: 0, manual: 0 }],
  ['waitlist', 'waitlist', processWaitlist, null],
  ['loyalty', 'points_expired', expireLoyalty, 0],
  ['plans', 'plans_expired', expireUserPlans, 0],
  ['requests', 'requests_expired', expireStaleRequests, 0],
  ['alerts', 'alerts_fulfilled', checkSlotAlerts, 0],
  ['quotes', 'quotes_expired', expireQuotes, 0],
  ['renewals', 'renewal_reminders', sendRenewalReminders, 0],
];

export async function maintenanceCycle() {
  const out = {}; const errors = {};
  for (const [category, key, fn, fallback] of STEPS) {
    const r = await isolated(category, () => fn(), fallback);
    out[key] = r.value;
    if (!r.ok) errors[category] = r.error;
  }
  const notif = await isolated('notifications', () => notificationCycle(), {});
  if (!notif.ok) errors.notifications = notif.error;
  if (notif.value?.errors) Object.assign(errors, notif.value.errors);
  const { errors: _drop, ...rest } = notif.value ?? {};
  return { ...out, ...rest, ...(Object.keys(errors).length ? { errors } : {}) };
}
