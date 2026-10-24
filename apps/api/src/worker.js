// Background maintenance: reminders + queued email, release of unpaid holds, credit-note refunds.
// Every category runs in its own try/catch: a failure in one (say, the email bridge) never blocks holds, refunds or waitlists.
import { notificationCycle, isolated } from './notify.js';
import { expireUnpaidHolds } from './booking/holds.js';
import { processRefunds } from './booking/refunds.js';
import { checkSlotAlerts } from './booking/alerts.js';
import { processWaitlist } from './booking/waitlist.js';
import { expireLoyalty } from './booking/loyalty.js';
import { expireUserPlans, raiseSubscriptionRenewals } from './booking/plans.js';
import { venueOpsReminders } from './booking/venue-ops.js';
import { expireStaleRequests } from './lifecycle.js';
import { expireQuotes, sendRenewalReminders } from './insurance-cycle.js';
import { sendCallNotices } from './sponsorship-calls.js';
import { expireAwards } from './sponsorship-awards.js';
import { endDueTerminations } from './sponsor-termination.js';
import { activateDuePauses } from './sponsor-pause.js';
import { processSponsorshipTerms } from './sponsor-renewals.js';
import { processSponsorTasks } from './sponsor-collaboration.js';
import { expireAcademyOffers, runAcademyJobs } from './academy-sweeps.js';
import { sendTaskReminders } from './sponsor-collaboration.js';
import { deliverDueReports } from './sponsor-report-schedules.js';

export const STEPS = [
  ['holds', 'holds_released', expireUnpaidHolds, 0],
  ['refunds', 'refunds', processRefunds, { done: 0, failed: 0, manual: 0 }],
  ['waitlist', 'waitlist', processWaitlist, null],
  ['loyalty', 'points_expired', expireLoyalty, 0],
  ['plans', 'plans_expired', expireUserPlans, 0],
  ['subscriptions', 'subscriptions_renewed', raiseSubscriptionRenewals, 0],
  ['venue_ops', 'venue_ops_reminders', venueOpsReminders, 0],
  ['requests', 'requests_expired', expireStaleRequests, 0],
  ['alerts', 'alerts_fulfilled', checkSlotAlerts, 0],
  ['quotes', 'quotes_expired', expireQuotes, 0],
  ['renewals', 'renewal_reminders', sendRenewalReminders, 0],
  ['sponsor_calls', 'sponsor_call_notices', sendCallNotices, 0],
  ['sponsor_awards', 'sponsor_awards_expired', expireAwards, 0],
  ['sponsor_pauses', 'sponsor_pauses_started', activateDuePauses, 0],
  ['sponsor_terminations', 'sponsor_terminations_ended', endDueTerminations, 0],
  ['sponsor_terms', 'sponsor_terms_processed', processSponsorshipTerms, 0],
  ['academy_offers', 'academy_offers_expired', expireAcademyOffers, 0],
  ['academy_jobs', 'academy_jobs', runAcademyJobs, null],
  ['sponsor_tasks', 'sponsor_task_reminders', sendTaskReminders, 0],
  ['sponsor_reports', 'sponsor_reports_delivered', deliverDueReports, 0],
];

export async function maintenanceCycle() {
  const out = {};
  const errors = {};
  for (const [name, key, fn, fallback] of STEPS) {
    const r = await isolated(name, fn, fallback);
    out[key] = r.value;
    if (!r.ok) errors[name] = r.error;
  }
  // Notifications run isolated too (it isolates its own sub-steps and reports them in `errors`).
  const notif = await isolated('notifications', () => notificationCycle(), {});
  const { errors: notifErrors, ...notifRest } = notif.value || {};
  Object.assign(out, notifRest);
  Object.assign(errors, notifErrors || {});
  if (!notif.ok) errors.notifications = notif.error;
  return Object.keys(errors).length ? { ...out, errors } : out;
}
