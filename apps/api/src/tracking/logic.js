// Pure logic for Tools > Scoring & Game Tracking (#416): template layouts derived from the governed rulesets, the result of a
// sheet, validation of typed-in/extracted totals, the result-approval policy and the signed round-trip code. No database here.
// Scoring itself is never reimplemented: results come from scoring/engine.js (computeScore / rejectReason).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { computeScore, rejectReason } from '../scoring/engine.js';
import { config } from '../config.js';
import { formFor, variantsOf } from './forms.js';

// keys sorted, so a value hashes the same whether it came from JS or back out of a jsonb column
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(canon(v))).digest('hex');
export const hashOf = sha;
const SIDES = ['home', 'away'];

// ------------------------------------------------------------------ layouts
/** What the sport records: points/sets rulesets are tracked live; time/distance sports use a results table. */
export const trackingMode = (sport, ruleset) => (['time', 'distance'].includes(sport.scoring) ? 'results' : ruleset.kind === 'manual' ? 'manual' : ruleset.kind);

/** Variants offered per sport: racket sports have singles/doubles, the rest a single standard format. Labels only - never scoring rules. */
export const variantsFor = (sport, ruleset) => variantsOf(sport.slug) ?? (ruleset.kind === 'sets' && !['volleyball', 'beach-volleyball'].includes(sport.slug) ? ['Singles', 'Doubles'] : ['Standard']);

export const BEST_OF = [1, 3, 5];

/** Apply a standalone format choice (best of N) to a sets ruleset. Linked sheets never do: they use the event's pinned ruleset. */
export function withFormat(ruleset, { best_of } = {}) {
  if (ruleset.kind !== 'sets' || !best_of || !BEST_OF.includes(best_of)) return ruleset;
  return { ...ruleset, sets: { ...ruleset.sets, best_of } };
}

export const customiseBase = z.object({
  hidden_stats: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,23}$/)).max(30).default([]),
  stat_order: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,23}$/)).max(30).default([]),
  labels: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,23}$/), z.string().trim().min(1).max(30)).default({}),
  notes_fields: z.array(z.string().trim().min(1).max(40)).max(6).default([]),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  paper: z.enum(['A4', 'Letter']).default('A4'),
  signatures: z.boolean().default(true),
});
export const customiseSchema = customiseBase.default({ hidden_stats: [], stat_order: [], labels: {}, notes_fields: [], orientation: 'portrait', paper: 'A4', signatures: true });

/** The printable/on-screen layout for a ruleset. Scoring events can never be hidden or renamed away; only non-scoring stats, labels and notes can. */
export function buildLayout(sport, ruleset, variant = '', custom = {}) {
  const c = customiseBase.parse(custom ?? {});
  const mode = trackingMode(sport, ruleset);
  const scoring = ruleset.events.map((e) => ({ kind: e.kind, label: c.labels[e.kind] ?? e.label, points: e.points, icon: e.icon ?? null, governed: true }));
  let stats = ruleset.stats.filter((s) => !c.hidden_stats.includes(s.kind)).map((s) => ({ kind: s.kind, label: c.labels[s.kind] ?? s.label, icon: s.icon ?? null, governed: true }));
  if (c.stat_order.length) stats = [...stats].sort((a, b) => (c.stat_order.indexOf(a.kind) + 1 || 99) - (c.stat_order.indexOf(b.kind) + 1 || 99));
  const form = formFor(sport, ruleset, variant);
  const title = ruleset.kind === 'manual' ? `${sport.name ?? ruleset.label} · ${form.title}` : `${ruleset.label}${variant && variant !== 'Standard' ? ` · ${variant}` : ''}`;
  return {
    v: 2, mode, sport: sport.slug, variant, title, form,
    periods: mode === 'points_events' ? ruleset.periods : null, sets: mode === 'sets' ? ruleset.sets : null,
    scoring, stats, results: mode === 'results' ? { unit: sport.scoring === 'time' ? 'time' : 'distance', rows: 12 } : null,
    custom: c,
    notes_fields: c.notes_fields.map((label) => ({ label, custom: true, official: false })),
    orientation: custom && 'orientation' in custom ? c.orientation : (form.orientation ?? c.orientation), paper: c.paper, signatures: c.signatures,
  };
}

// ------------------------------------------------------------------ results
const bySeq = (entries) => [...entries].sort((a, b) => a.seq - b.seq);

/** Why an entry cannot be added now, or null: delegates to the canonical engine. */
export const entryRejection = (ruleset, live, next) => rejectReason(ruleset, bySeq(live), next);

/**
 * The result a sheet stands for. Live entries go through computeScore; uploaded/typed sheets carry manual_totals
 * ({home, away, sets?, periods?, stats?}). Sets and points are never trusted as typed: see validateTotals.
 */
export function sheetResult(ruleset, entries, manual) {
  const live = entries.filter((e) => !e.voided_at);
  if (live.length || !manual) {
    if (ruleset.kind === 'manual') return { source: 'manual', home: manual?.home ?? null, away: manual?.away ?? null, winner: winnerOf(manual?.home, manual?.away), sets: null, periods: null, stats: manual?.stats ?? { home: {}, away: {} } };
    const s = computeScore(ruleset, bySeq(live));
    return { source: 'entries', home: s.home, away: s.away, winner: s.winner, sets: s.sets ?? null, current_set: s.current_set ?? null, periods: s.periods ?? null, stats: s.stats, over: s.over ?? false };
  }
  return { source: 'manual', home: manual.home ?? null, away: manual.away ?? null, winner: winnerOf(manual.home, manual.away), sets: manual.sets ?? null, periods: manual.periods ?? null, stats: manual.stats ?? { home: {}, away: {} } };
}
const winnerOf = (h, a) => (h == null || a == null || h === a ? null : h > a ? 'home' : 'away');

/** Replay declared set scores through the engine: each set must be a legal finish and the sets won must match the totals. */
function replaySets(ruleset, sets) {
  const events = [];
  for (const s of sets) {
    const lo = Math.min(s.home, s.away);
    for (let i = 0; i < lo; i++) { events.push({ kind: 'point', side: 'home' }); events.push({ kind: 'point', side: 'away' }); }
    const w = s.home > s.away ? 'home' : 'away';
    for (let i = lo; i < Math.max(s.home, s.away); i++) events.push({ kind: 'point', side: w });
  }
  return computeScore(ruleset, events);
}

/** Checks typed-in or extracted totals against the ruleset. Errors stop a proposal; warnings go to the reviewer. */
export function validateTotals(ruleset, result) {
  const out = [];
  const add = (code, severity, message) => out.push({ code, severity, message });
  const { home: h, away: a } = result;
  if (ruleset.kind === 'manual') { if (h == null || a == null) add('no_score', 'error', 'The sheet has no final score yet'); return out; }
  if (h == null || a == null) { add('no_score', 'error', 'The sheet has no final score yet'); return out; }
  if (h < 0 || a < 0) add('negative_score', 'error', 'A score cannot be negative');
  if (h === a && ruleset.draw_allowed === false) add('draw_not_allowed', 'error', `${ruleset.label} games cannot end level`);
  if (ruleset.kind === 'sets') {
    const need = Math.ceil(ruleset.sets.best_of / 2);
    if (Math.max(h, a) !== need || Math.min(h, a) >= need) add('impossible_sets', 'error', `A best-of-${ruleset.sets.best_of} match ends with one side on exactly ${need} sets and the other on fewer`);
    if (result.sets?.length) {
      const played = replaySets(ruleset, result.sets);
      const same = played.sets.length === result.sets.length && played.sets.every((s, i) => s.home === result.sets[i].home && s.away === result.sets[i].away);
      if (!same) add('illegal_set_score', 'error', `A set score is not a legal finish under the ${ruleset.label} rules`);
      else if (played.home !== h || played.away !== a) add('sets_total_mismatch', 'error', `The set scores give ${played.home}–${played.away} in sets, the sheet says ${h}–${a}`);
    }
  } else if (result.periods?.length) {
    const sh = result.periods.reduce((n, p) => n + (p.home ?? 0), 0), sa = result.periods.reduce((n, p) => n + (p.away ?? 0), 0);
    if (sh !== h || sa !== a) add('periods_total_mismatch', 'error', `The ${ruleset.periods.label.toLowerCase()} scores add up to ${sh}–${sa}, the total says ${h}–${a}`);
    if (result.periods.length > ruleset.periods.count) add('too_many_periods', 'warn', `${result.periods.length} ${ruleset.periods.label.toLowerCase()}s recorded; ${ruleset.label} has ${ruleset.periods.count}`);
  }
  return out;
}
export const hasErrors = (list) => list.some((x) => x.severity === 'error');

// ------------------------------------------------------------------ round-trip code
const secret = () => config.jwtSecret ?? process.env.JWT_SECRET ?? 'dev-tracking-secret';
/** Human-readable unique sheet reference, e.g. TS-7K3M9QXA. */
export const newRef = () => `TS-${[...randomBytes(8)].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('')}`;
const mac = (ref, versionId) => createHmac('sha256', secret()).update(`tracking:${ref}:${versionId}`).digest('hex').slice(0, 10).toUpperCase();
/** Printed on the sheet (and in its QR). It names the sheet and template version; it grants no access: results still need an authorised review. */
export const sheetCode = (ref, versionId) => `${ref}-${mac(ref, versionId)}`;
export function parseSheetCode(code) {
  const m = /^(TS-[A-Z2-9]{8})-([0-9A-F]{10})$/.exec(String(code ?? '').trim().toUpperCase());
  return m ? { ref: m[1], mac: m[2] } : null;
}
export const verifySheetCode = (code, ref, versionId) => { const p = parseSheetCode(code); return !!p && p.ref === ref && p.mac === mac(ref, versionId); };

// ------------------------------------------------------------------ approval policy
export const REVIEW_ROLES = ['organiser', 'official', 'home_manager', 'away_manager'];
export const policySchema = z.object({
  mode: z.enum(['sequential', 'parallel']).default('parallel'),
  requirements: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/), label: z.string().trim().max(40).optional(), roles: z.array(z.enum(REVIEW_ROLES)).min(1) })).min(1).max(6),
  quorum: z.number().int().min(1).max(6).nullable().default(null),
  allow_organiser_override: z.boolean().default(false),
  no_self_approval: z.boolean().default(true),
  allow_public_submission: z.boolean().default(true),
}).superRefine((p, ctx) => {
  const keys = p.requirements.map((r) => r.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'requirement keys must be unique', path: ['requirements'] });
  if (p.quorum && p.quorum > p.requirements.length) ctx.addIssue({ code: 'custom', message: 'quorum cannot exceed the number of requirements', path: ['quorum'] });
});

/** The policy in force: the event's own, else the default for its kind. */
export function policyFor(event) {
  if (event.result_approval_policy) return policySchema.parse(event.result_approval_policy);
  const R = (key, label, ...roles) => ({ key, label, roles });
  const preset = {
    friendly: { mode: 'parallel', requirements: [R('official_or_organiser', 'Referee or organiser', 'official', 'organiser')] },
    league: { mode: 'parallel', requirements: [R('official', 'Referee', 'official'), R('home_manager', 'Home manager', 'home_manager'), R('away_manager', 'Away manager', 'away_manager')] },
  }[event.kind] ?? { mode: 'sequential', requirements: [R('official', 'Referee or scorer', 'official'), R('organiser', 'Organiser', 'organiser')] };
  return policySchema.parse(preset);
}

/** Next requirement a reviewer holding `roles` may act on, honouring sequential order. */
export function nextRequirement(policy, reviews, roles, wanted) {
  const done = new Set(reviews.filter((r) => r.decision === 'approve').map((r) => r.requirement_key));
  const open = policy.requirements.filter((r) => !done.has(r.key));
  const eligible = (r) => r.roles.some((x) => roles.includes(x));
  if (policy.mode === 'sequential') {
    const first = open[0];
    if (!first || !eligible(first)) return null;
    return !wanted || wanted === first.key ? first : null;
  }
  return open.find((r) => eligible(r) && (!wanted || r.key === wanted)) ?? null;
}

/** Deterministic state from the reviews of the current round: a negative decision blocks until the submitter resubmits (new round). */
export function evaluateProposal(policy, reviews) {
  if (reviews.some((r) => r.decision === 'reject')) return { state: 'rejected', approved: [], pending: policy.requirements.map((r) => r.key) };
  const approved = [...new Set(reviews.filter((r) => r.decision === 'approve').map((r) => r.requirement_key))];
  const pending = policy.requirements.map((r) => r.key).filter((k) => !approved.includes(k));
  if (reviews.some((r) => r.decision === 'dispute')) return { state: 'disputed', approved, pending };
  if (reviews.some((r) => r.decision === 'changes_requested')) return { state: 'changes_requested', approved, pending };
  const ok = policy.quorum ? approved.length >= policy.quorum : pending.length === 0;
  return { state: ok ? 'approved' : reviews.length ? 'under_review' : 'proposed', approved, pending };
}

export { SIDES };
