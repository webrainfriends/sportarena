// Background maintenance: reminders + queued email, release of unpaid holds, credit-note refunds.
import { notificationCycle } from './notify.js';
import { expireUnpaidHolds } from './booking/holds.js';
import { processRefunds } from './booking/refunds.js';
import { checkSlotAlerts } from './booking/alerts.js';
import { processWaitlist } from './booking/waitlist.js';
import { expireLoyalty } from './booking/loyalty.js';
import { expireUserPlans } from './booking/plans.js';
import { expireQuotes, sendRenewalReminders } from './insurance-cycle.js';

export async function maintenanceCycle() {
  const holds = await expireUnpaidHolds();
  const refunds = await processRefunds();
  const waitlist = await processWaitlist();
  const points_expired = await expireLoyalty();
  const plans_expired = await expireUserPlans();
  const alerts = await checkSlotAlerts();
  const quotes_expired = await expireQuotes();
  const renewal_reminders = await sendRenewalReminders();
  return { holds_released: holds, refunds, waitlist, points_expired, plans_expired, alerts_fulfilled: alerts, quotes_expired, renewal_reminders, ...(await notificationCycle()) };
}
