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
  ['alerts', 'alerts_fulfilled', checkSlotAlerts, 0],
  ['quotes', 'quotes_expired', expireQuotes, 0],
  ['renewals', 'renewal_reminders', sendRenewalReminders, 0],
];

export async function maintenanceCycle() {
  const holds = await expireUnpaidHolds();
  const refunds = await processRefunds();
  const waitlist = await processWaitlist();
  const points_expired = await expireLoyalty();
  const plans_expired = await expireUserPlans();
  const requests_expired = await expireStaleRequests();
  const alerts = await checkSlotAlerts();
  const quotes_expired = await expireQuotes();
  const renewal_reminders = await sendRenewalReminders();
  return { holds_released: holds, refunds, waitlist, points_expired, plans_expired, alerts_fulfilled: alerts, quotes_expired, requests_expired, renewal_reminders, ...(await notificationCycle()) };
}
