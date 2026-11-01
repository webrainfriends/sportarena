// Universal registration engine (#575): the pure rules shared by every registration scenario (athlete, team, event, competition, membership,
// course/camp, federation licence). No I/O here: the form comes from application-forms.js (one question model for the whole platform), and
// the fee quote, instalment schedule, waiver and capacity maths are deterministic so the server, the tests and the app all agree.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { formDefinition, fieldsOf, visibleKeys } from './application-forms.js';

export const KINDS = ['athlete', 'team', 'event', 'competition', 'membership', 'course', 'licence'];
export const KIND_LABEL = { athlete: 'Athlete registration', team: 'Team registration', event: 'Event entry', competition: 'Competition registration', membership: 'Membership', course: 'Course or camp', licence: 'Federation licence' };
/** Kinds whose registered party is a team rather than a person. */
export const TEAM_KINDS = ['team'];
export const LIVE_STATUSES = ['submitted', 'under_review', 'info_requested', 'waitlisted', 'approved'];
/** Statuses that hold a seat (a waitlisted entry does not). */
export const SEAT_STATUSES = ['submitted', 'under_review', 'info_requested', 'approved'];
export const OPEN_FOR_EDIT = ['draft', 'info_requested'];

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const cents = z.number().int().min(0).max(1e9);
const when = z.object({ field: z.string().regex(KEY), op: z.enum(['eq', 'ne', 'in', 'filled']), value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.string().max(200)).max(30)]).optional() });

/** The registration form is the platform's one question model, minus the sponsorship-only blocks (budget, references). */
export const registrationForm = formDefinition.superRefine((d, ctx) => {
  for (const f of fieldsOf(d)) if (['budget', 'references'].includes(f.type)) ctx.addIssue({ code: 'custom', message: `"${f.label}": budget and references questions are only for sponsorship applications` });
});

export const feesSchema = z.object({
  items: z.array(z.object({ key: z.string().regex(KEY), label: z.string().min(1).max(120), amount_cents: cents, when: when.optional() })).max(20).default([]),
  discounts: z.array(z.object({
    key: z.string().regex(KEY), label: z.string().min(1).max(120),
    kind: z.enum(['percent', 'amount']), value: z.number().int().min(1).max(1e9),
    code: z.string().regex(/^[A-Z0-9_-]{3,24}$/, 'Codes are 3–24 capital letters, digits, - or _').optional(),
    auto: z.enum(['early_bird', 'additional_participant']).optional(), // applied without a code
    before: z.string().date().optional(),                              // early_bird: registration submitted on or before this day
    max_uses: z.number().int().min(1).optional(), valid_until: z.string().date().optional(),
  }).superRefine((d, ctx) => {
    if (!d.code && !d.auto) ctx.addIssue({ code: 'custom', message: 'A discount needs a code or an automatic rule' });
    if (d.auto === 'early_bird' && !d.before) ctx.addIssue({ code: 'custom', path: ['before'], message: 'Give the early-bird closing day' });
    if (d.kind === 'percent' && d.value > 100) ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage is at most 100' });
  })).max(20).default([]),
  instalments: z.object({ count: z.number().int().min(2).max(12), interval_days: z.number().int().min(7).max(92) }).optional(),
}).strict().superRefine((d, ctx) => {
  const keys = new Set();
  for (const x of [...d.items, ...d.discounts]) { if (keys.has(x.key)) ctx.addIssue({ code: 'custom', message: `Duplicate key "${x.key}"` }); keys.add(x.key); }
});

export const waiversSchema = z.array(z.object({
  key: z.string().regex(KEY), title: z.string().min(1).max(160), body: z.string().min(1).max(8000),
  required: z.boolean().default(true), guardian_required: z.boolean().default(false), // guardian_required: for a young participant a verified guardian must sign
})).max(12).superRefine((d, ctx) => { if (new Set(d.map((w) => w.key)).size !== d.length) ctx.addIssue({ code: 'custom', message: 'Duplicate waiver key' }); });

export const quotasSchema = z.array(z.object({ field: z.string().regex(KEY), limits: z.record(z.string().max(60), z.number().int().min(0).max(1e6)) })).max(5);

export const sha = (x) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
export const versionHash = (form, fees, waivers) => sha({ form, fees, waivers });
export const waiverHash = (w) => sha(`${w.key}\n${w.title}\n${w.body}`);

const condMet = (w, answers) => {
  const v = answers[w.field];
  return w.op === 'filled' ? v !== undefined && v !== null && v !== '' : w.op === 'eq' ? v === w.value : w.op === 'ne' ? v !== w.value : Array.isArray(w.value) && (Array.isArray(v) ? v.some((x) => w.value.includes(x)) : w.value.includes(v));
};
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * The fee for one entry. Fee lines apply when their condition holds on the answers; automatic discounts apply by rule, coded discounts only when the
 * code is given, unexpired and not used up (`uses` = { code: n }). Discounts never take the total below zero. `plan: 'instalments'` splits the total.
 * Returns whole minor units; the same inputs always give the same quote.
 */
export function quote(fees, { answers = {}, codes = [], today, uses = {}, plan = 'full', priorEntries = 0 }) {
  const f = feesSchema.parse(fees ?? {});
  const lines = f.items.filter((i) => !i.when || condMet(i.when, answers)).map(({ key, label, amount_cents }) => ({ key, label, amount_cents }));
  const subtotal = lines.reduce((s, l) => s + l.amount_cents, 0);
  const want = new Set(codes.map((c) => String(c).trim().toUpperCase()).filter(Boolean));
  const known = new Set(f.discounts.map((d) => d.code).filter(Boolean));
  const rejected = [...want].filter((c) => !known.has(c));
  const discounts = [];
  for (const d of f.discounts) {
    const live = (!d.valid_until || d.valid_until >= today) && (d.max_uses == null || !d.code || (uses[d.code] ?? 0) < d.max_uses);
    let on = false;
    if (d.code) { on = want.has(d.code); if (on && !live) { rejected.push(d.code); on = false; } }
    else if (d.auto === 'early_bird') on = live && today <= d.before;
    else if (d.auto === 'additional_participant') on = live && priorEntries > 0;
    if (!on || !subtotal) continue;
    discounts.push({ key: d.key, label: d.label, code: d.code ?? null, amount_cents: d.kind === 'percent' ? Math.floor((subtotal * d.value) / 100) : Math.min(d.value, subtotal) });
  }
  let left = subtotal;
  for (const d of discounts) { d.amount_cents = Math.min(d.amount_cents, left); left -= d.amount_cents; }
  const discount = subtotal - left, total = left;
  let schedule = [];
  if (plan === 'instalments' && f.instalments && total > 0) {
    const { count, interval_days } = f.instalments, base = Math.floor(total / count);
    schedule = Array.from({ length: count }, (_, i) => ({ seq: i + 1, due_on: addDays(today, i * interval_days), amount_cents: base + (i === 0 ? total - base * count : 0) })).filter((s) => s.amount_cents > 0);
  } else if (total > 0) schedule = [{ seq: 1, due_on: today, amount_cents: total }];
  return { lines, discounts, rejected_codes: rejected, subtotal_cents: subtotal, discount_cents: discount, total_cents: total, plan: schedule.length > 1 ? 'instalments' : 'full', instalments: schedule, instalments_offered: !!f.instalments && total > 0 };
}

/** Which waivers must be signed for this participant, and by whom. A young participant's guardian_required waivers need a guardian's signature. */
export function waiversDue(waivers, { youth }) {
  return (waivers ?? []).filter((w) => w.required).map((w) => ({ key: w.key, title: w.title, sha256: waiverHash(w), signer: youth && w.guardian_required ? 'guardian' : 'any' }));
}
export const unsigned = (due, signatures) => due.filter((d) => !signatures.some((s) => s.waiver_key === d.key && s.waiver_sha256 === d.sha256 && (d.signer === 'any' || s.signer_role === 'guardian')));

/** Seat arithmetic for a programme: is there room overall and in each quota bucket, given what is already held? */
export function seatDecision({ capacity, quotas = [] }, { held, byAnswer = {} }, answers) {
  if (capacity != null && held >= capacity) return { ok: false, why: 'capacity' };
  for (const q of quotas) {
    const v = answers[q.field], lim = v == null ? undefined : q.limits[String(v)];
    if (lim != null && (byAnswer[q.field]?.[String(v)] ?? 0) >= lim) return { ok: false, why: 'quota', field: q.field, value: String(v) };
  }
  return { ok: true };
}

export { visibleKeys, fieldsOf };
