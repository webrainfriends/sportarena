// Programme rules: what a published version of a loyalty programme says. A version is immutable once published (see migration 120);
// the ledger remembers which version each row was earned under, so changing future rates never rewrites history.
import { z } from 'zod';

/** Canonical completed business events a rule can listen to. Each is emitted once, from the place the business fact becomes true. */
export const EARN_EVENTS = {
  venue_booking_paid: 'A venue booking invoice is paid',
  academy_payment_paid: 'An academy fee or charge is paid',
  coach_session_completed: 'A paid coaching session is completed',
  event_participation: 'An accepted entry in an event that finishes',
  membership_tenure: 'A paid membership stays active for another month',
  sponsored_challenge: 'A sponsor-funded challenge is verified by the programme team',
};
/** Short names for chips and one-line summaries. */
export const EARN_SHORT = {
  venue_booking_paid: 'Booking paid', academy_payment_paid: 'Fee paid', coach_session_completed: 'Session completed',
  event_participation: 'Event played', membership_tenure: 'Membership month', sponsored_challenge: 'Sponsored challenge',
};
export const SPEND_EVENTS = ['venue_booking_paid', 'academy_payment_paid', 'coach_session_completed'];
export const REDEEM_PURPOSES = { venue_invoice: 'Venue booking invoice', academy_charge: 'Academy fee or charge', coach_hire: 'Coaching session' };
/** Programme owner kind -> the purposes it can be spent on. */
export const OWNER_PURPOSES = { venue: ['venue_invoice'], organisation: ['academy_charge'], coach: ['coach_hire'], event: [], platform: Object.keys(REDEEM_PURPOSES) };
/** Programme owner kind -> the earning events that can happen in its scope. */
export const OWNER_EVENTS = {
  venue: ['venue_booking_paid', 'membership_tenure', 'sponsored_challenge'],
  organisation: ['academy_payment_paid', 'event_participation', 'sponsored_challenge'],
  coach: ['coach_session_completed', 'sponsored_challenge'],
  event: ['event_participation', 'sponsored_challenge'],
  platform: Object.keys(EARN_EVENTS),
};

const period = z.enum(['day', 'month', 'year', 'lifetime']);
const earnRule = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  event: z.enum(Object.keys(EARN_EVENTS)),
  label: z.string().trim().max(80).optional(),
  mode: z.enum(['percent', 'fixed']),
  percent_bp: z.number().int().min(1).max(5000).optional().describe('share of the amount paid, in basis points (500 = 5%)'),
  points: z.number().int().min(1).max(1_000_000).optional().describe('fixed points per qualifying event'),
  min_spend_minor: z.number().int().min(0).default(0),
  max_points_per_award: z.number().int().min(1).max(10_000_000).optional(),
  member_cap: z.object({ points: z.number().int().min(1), per: period }).optional(),
}).refine((r) => (r.mode === 'percent' ? r.percent_bp != null : r.points != null), 'a percent rule needs percent_bp, a fixed rule needs points')
  .refine((r) => r.event !== 'sponsored_challenge' || r.mode === 'fixed', 'a challenge awards fixed points');

export const rulesSchema = z.object({
  earn: z.array(earnRule).max(12).default([]),
  redeem: z.object({
    max_redeem_bp: z.number().int().min(100).max(10000).default(5000).describe('largest share of one bill the points may pay'),
    min_points: z.number().int().min(1).default(1),
    purposes: z.array(z.enum(Object.keys(REDEEM_PURPOSES))).default([]),
    restore_expiry: z.enum(['fresh', 'original']).default('fresh').describe('when a cancelled payment gives points back: a fresh expiry, or the original one (at least 30 days)'),
    restore_on_cancel: z.enum(['full', 'none']).default('full').describe('whether points paid onto a cancelled bill come back'),
  }).default({ max_redeem_bp: 5000, min_points: 1, purposes: [], restore_expiry: 'fresh', restore_on_cancel: 'full' }),
  expiry_months: z.number().int().min(1).max(60).default(12),
  caps: z.object({
    member_points_per_month: z.number().int().min(1).optional(),
    programme_points_total: z.number().int().min(1).optional().describe('budget: the most points this programme will ever issue'),
  }).default({}),
  eligibility: z.object({
    youth: z.enum(['excluded', 'guardian_linked']).default('excluded').describe('young people: excluded, or allowed only while a verified guardian link is live'),
  }).default({ youth: 'excluded' }),
  referral: z.object({
    enabled: z.boolean().default(false),
    qualifying_event: z.enum(Object.keys(EARN_EVENTS).filter((e) => !['sponsored_challenge', 'membership_tenure'].includes(e))).optional(),
    min_spend_minor: z.number().int().min(0).default(0),
    referrer_points: z.number().int().min(0).max(1_000_000).default(0),
    invitee_points: z.number().int().min(0).max(1_000_000).default(0),
    holdback_days: z.number().int().min(0).max(90).default(14).describe('days the qualifying payment must stay un-refunded before the reward is released'),
    claim_window_days: z.number().int().min(1).max(365).default(30).describe('how long after signing up an invitee may enter a code'),
    max_referrals_per_member: z.number().int().min(1).max(1000).default(50),
    daily_velocity_flag: z.number().int().min(1).max(500).default(10).describe('more invites than this in a day are held for review'),
  }).default({ enabled: false, min_spend_minor: 0, referrer_points: 0, invitee_points: 0, holdback_days: 14, claim_window_days: 30, max_referrals_per_member: 50, daily_velocity_flag: 10 }),
}).superRefine((r, ctx) => {
  if (r.referral.enabled && !r.referral.qualifying_event) ctx.addIssue({ code: 'custom', path: ['referral', 'qualifying_event'], message: 'a referral reward needs a qualifying event' });
  if (r.referral.enabled && r.referral.referrer_points + r.referral.invitee_points <= 0) ctx.addIssue({ code: 'custom', path: ['referral'], message: 'a referral reward must give someone points' });
  const keys = r.earn.map((e) => e.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['earn'], message: 'rule keys must be unique' });
});

export const parseRules = (raw) => rulesSchema.parse(raw ?? {});

/** Rules a programme owner kind may publish: events must exist in that owner's scope and spend purposes must be ones it can be spent on. */
export function checkScope(ownerKind, rules) {
  const events = OWNER_EVENTS[ownerKind] ?? [], purposes = OWNER_PURPOSES[ownerKind] ?? [];
  const bad = [...rules.earn.map((e) => e.event), ...(rules.referral.enabled ? [rules.referral.qualifying_event] : [])].find((e) => !events.includes(e));
  if (bad) return `${EARN_EVENTS[bad]} cannot earn points in a ${ownerKind} programme`;
  const badP = rules.redeem.purposes.find((p) => !purposes.includes(p));
  if (badP) return `${REDEEM_PURPOSES[badP]} is not something a ${ownerKind} programme can be spent on`;
  return null;
}
