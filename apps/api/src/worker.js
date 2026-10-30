// Background maintenance: reminders + queued email, release of unpaid holds, credit-note refunds.
// Every category runs in its own try/catch: a failure in one (say, the email bridge) never blocks holds, refunds or waitlists.
import { notificationCycle, isolated } from './notify.js';
import { expireUnpaidHolds } from './booking/holds.js';
import { expireStaleSales } from './pos/sale.js';
import { processRefunds } from './booking/refunds.js';
import { checkSlotAlerts } from './booking/alerts.js';
import { processWaitlist } from './booking/waitlist.js';
import { processBallots } from './booking/ballots.js';
import { expireLoyalty } from './booking/loyalty.js';
import { tx } from './db.js';
import { eventParticipationSweep, membershipTenureSweep } from './rewards/activity.js';
import { releaseDueReferrals } from './rewards/referrals.js';
import { expireCover } from './cover.js';
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
import { sweepAccessGrants } from './access-grants.js';
import { expireAcademyOffers, remindTrials, runAcademyJobs } from './academy-sweeps.js';
import { runTenderJobs, sendTenderReminders } from './capabilities/tender-reports.js';
import { deliverDueReports } from './sponsor-report-schedules.js';
import { deliverDueKpiReports } from './kpi/service.js';
import { accrueActiveContracts } from './player-contracts.js';
import { runRepresentationSweeps } from './representation.js';
import { raiseScheduledCharges, runCollections } from './collections.js';
import { runServiceSweeps } from './svc/sweeps.js';
import { runServiceJobs } from './capabilities/svc-reports.js';
import { runFederationSweeps } from './federation-sweeps.js';
import { runOfficialsSweeps } from './officials-sweeps.js';
import { runComplianceSweeps } from './compliance-sweeps.js';
import { runTripSweeps } from './trips-sweeps.js';
import { runMediaRightsSweeps } from './media-rights-sweeps.js';
import { sendFollowerAlerts } from './spectator.js';
import { snapshotAll } from './rankings/data.js';

/** Weekly ranking snapshots: the worker runs often, so only act once a week (Monday UTC), and a rerun on identical results adds nothing. */
const weeklyRankingSnapshots = () => (new Date().getUTCDay() === 1 ? snapshotAll('weekly') : 0);
import { syncOpenGames } from './open-games-sweeps.js';
import { adSweeps } from './ads/engine.js';
import { raiseTeamDues } from './team-money.js';

export const STEPS = [
  ['holds', 'holds_released', expireUnpaidHolds, 0],
  ['pos_sales', 'pos_sales_released', expireStaleSales, 0],
  ['refunds', 'refunds', processRefunds, { done: 0, failed: 0, manual: 0 }],
  ['waitlist', 'waitlist', processWaitlist, null],
  ['ballots', 'ballots', processBallots, null],
  ['loyalty', 'points_expired', expireLoyalty, 0],
  ['cover', 'cover_agreements_expired', () => tx((c) => expireCover(c)), 0],
  ['loyalty_referrals', 'referral_rewards_released', () => tx((c) => releaseDueReferrals(c)), 0],
  ['loyalty_events', 'event_points_awarded', () => tx((c) => eventParticipationSweep(c)), 0],
  ['loyalty_memberships', 'membership_points_awarded', () => tx((c) => membershipTenureSweep(c)), 0],
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
  ['academy_trial_reminders', 'academy_trial_reminders_sent', remindTrials, 0],
  ['academy_jobs', 'academy_jobs', runAcademyJobs, null],
  ['billing_schedules', 'billing_periods_raised', raiseScheduledCharges, 0],
  ['collections', 'collection_cases_advanced', runCollections, 0],
  ['access_grants', 'access_grants_revoked', sweepAccessGrants, 0],
  ['tender_jobs', 'tender_jobs', runTenderJobs, null],
  ['tender_reminders', 'tender_deadline_reminders', sendTenderReminders, 0],
  ['sponsor_tasks', 'sponsor_task_reminders', processSponsorTasks, 0],
  ['sponsor_reports', 'sponsor_reports_delivered', deliverDueReports, 0],
  ['kpi_reports', 'kpi_reports_delivered', deliverDueKpiReports, 0],
  ['player_contracts', 'contract_earnings_posted', accrueActiveContracts, 0],
  ['representation', 'representation_swept', runRepresentationSweeps, 0],
  ['supplier_services', 'supplier_services', runServiceSweeps, null],
  ['supplier_exports', 'supplier_exports', runServiceJobs, null],
  ['federation', 'federation', runFederationSweeps, null],
  ['officials_development', 'officials_development', runOfficialsSweeps, null],
  ['compliance', 'compliance', runComplianceSweeps, null],
  ['team_travel', 'team_travel', runTripSweeps, null],
  ['media_rights', 'media_rights', runMediaRightsSweeps, null],
  ['follower_alerts', 'follower_alerts_sent', sendFollowerAlerts, 0],
  ['ranking_snapshots', 'ranking_snapshots', weeklyRankingSnapshots, 0],
  ['open_games', 'open_games_synced', syncOpenGames, 0],
  ['team_dues', 'team_dues_raised', raiseTeamDues, 0],
  ['advertising', 'advertising', adSweeps, null],
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
