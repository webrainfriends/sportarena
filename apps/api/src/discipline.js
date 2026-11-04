// Sporting discipline as pure functions (#479 / #563): policy schema, deterministic accumulation thresholds, served-match counting and per-sport vocabulary.
// Nothing here touches the database; capabilities feed facts in and act on the answer, so the same inputs always give the same decision and a
// published policy version replays identically later.
import { z } from 'zod';
import { familyOf } from './rankings/families.js';

export const INCIDENTS = ['caution', 'dismissal', 'misconduct'];
export const SANCTION_KINDS = ['warning', 'match_suspension', 'date_suspension', 'competition_ban', 'role_suspension', 'fine', 'points_deduction', 'other'];
export const BLOCKING_KINDS = ['match_suspension', 'date_suspension', 'competition_ban', 'role_suspension'];
export const FINE_FLOW = { imposed: ['invoiced', 'waived'], invoiced: ['paid', 'waived'], paid: [], waived: [] };

const cnt = z.number().int().min(1).max(100);
/** The versioned rule set. Unknown keys are refused so a typo can never silently disable a rule. */
export const POLICY = z.object({
  caution_thresholds: z.array(z.object({ count: z.number().int().min(1).max(200), suspension_matches: cnt }).strict()).max(10).default([]),
  dismissal: z.object({ suspension_matches: cnt.default(1), interim: z.boolean().default(true) }).strict().default({ suspension_matches: 1, interim: true }),
  scope: z.enum(['competition', 'sport']).default('competition'),
  carry_over: z.enum(['none', 'next_season']).default('none'),
  expiry_days: z.number().int().min(1).max(3650).optional(),
  appeal_window_days: z.number().int().min(0).max(60).default(3),
  stay_on_appeal: z.boolean().default(false),
  fine_authority: z.boolean().default(false),
  points_deduction_authority: z.boolean().default(false),
  public_disclosure: z.enum(['none', 'sanctions']).default('none'),
}).strict().superRefine((p, ctx) => {
  const counts = p.caution_thresholds.map((t) => t.count);
  if (new Set(counts).size !== counts.length) ctx.addIssue({ code: 'custom', message: 'Each caution threshold count must be different' });
  const sorted = [...p.caution_thresholds].sort((a, b) => a.count - b.count);
  sorted.forEach((t, i) => { if (i && t.suspension_matches < sorted[i - 1].suspension_matches) ctx.addIssue({ code: 'custom', message: 'A higher threshold cannot carry a shorter suspension' }); });
});

/**
 * Cautions accumulate; reaching a threshold EXACTLY triggers its suspension once (the next caution moves on to the next threshold), so recomputing
 * from the same history never issues a second suspension. `cautions` = how many counted cautions the person now has under this policy.
 */
export function thresholdFor(rules, cautions) {
  const t = (rules.caution_thresholds ?? []).find((x) => x.count === cautions);
  return t ? { count: t.count, suspension_matches: t.suspension_matches } : null;
}

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10));
/** Fixtures that count as served: the sanctioned team's COMPLETED fixtures on/after the start. Postponed, cancelled, abandoned and live games do not count. */
export const COUNTS = new Set(['completed']);
export function serviceOf(sanction, fixtures) {
  const from = ymd(sanction.starts_on); const after = sanction.starts_after ? new Date(sanction.starts_after).getTime() : null;
  const late = (f) => (after != null ? new Date(f.scheduled_at).getTime() > after : ymd(f.scheduled_at) >= from);
  const counted = fixtures.filter((f) => COUNTS.has(f.status) && late(f)).sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  const skipped = fixtures.filter((f) => !COUNTS.has(f.status) && ['postponed', 'cancelled', 'abandoned'].includes(f.status));
  const served = Math.min(sanction.matches ?? 0, counted.length);
  return { served, remaining: Math.max(0, (sanction.matches ?? 0) - served), done: !!sanction.matches && served >= sanction.matches, counted_fixture_ids: counted.slice(0, sanction.matches ?? 0).map((f) => f.id), not_counted: skipped.map((f) => ({ id: f.id, status: f.status })) };
}

/** Is a sanction blocking on a given day? Interim and active block; stayed, served, overturned and expired do not. */
export function blocksOn(s, onDay, service = null) {
  if (!['interim', 'active'].includes(s.status) || s.superseded_at) return false;
  if (!BLOCKING_KINDS.includes(s.kind)) return false;
  if (s.starts_on && ymd(s.starts_on) > onDay) return false;
  if (s.ends_on && ymd(s.ends_on) < onDay) return false;
  if (s.kind === 'match_suspension' && service?.done) return false;
  return true;
}

/** Appeal deadline = decision day + window. A 0-day window means no appeal. */
export function appealDeadline(decidedOn, rules) {
  if (!rules.appeal_window_days) return null;
  const d = new Date(`${ymd(decidedOn)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + rules.appeal_window_days);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ per-sport vocabulary
// Each family names its own incidents; a sport with no native vocabulary uses the generic one and is labelled a fallback, never silently defaulted.
export const MODELS = {
  goal_game: { native: true, caution: 'Yellow card / caution', dismissal: 'Red card / sending-off', misconduct: 'Misconduct report', note: 'Cards and sending-offs, counted per competition.' },
  cricket:   { native: true, caution: 'Level 1 offence / demerit point', dismissal: 'Level 3-4 offence / ban', misconduct: 'Code of conduct report', note: 'Offence levels and demerit points.' },
  racket:    { native: true, caution: 'Code violation / warning', dismissal: 'Default / disqualification', misconduct: 'Unsportsmanlike conduct report', note: 'Code violations escalate to point, game and default.' },
  measured:  { native: true, caution: 'Warning / false start', dismissal: 'Disqualification', misconduct: 'Misconduct report', note: 'Warnings and disqualifications for timed and measured events.' },
  generic:   { native: false, caution: 'Caution', dismissal: 'Dismissal', misconduct: 'Misconduct report', note: 'This sport has no dedicated discipline vocabulary yet: generic cautions and dismissals are used. Labelled as a fallback.' },
};
export const modelFor = (sport) => { const family = familyOf(sport); const m = MODELS[family] ?? MODELS.generic; return { family: MODELS[family] ? family : 'generic', ...m }; };
