// Para rule packs (#834): declarative, publisher-versioned sport rules evaluated on top of the registration engine (#477) using the governed
// classification outcome (#488). A pack is DATA (validators + parameters), never code, and no rule is assumed to hold for every sport: each
// pack states its own validators. The engine reads a class code and an administrative status per person and nothing clinical.
import { z } from 'zod';
import { outcomeAt, verifiedExternalAt } from './para.js';

const code = z.string().trim().min(1).max(20);
const tag = z.string().trim().min(1).max(40);
const rid = z.string().trim().regex(/^[a-z][a-z0-9_]{0,59}$/);
const base = { id: rid, label: z.string().trim().min(2).max(160).optional(), scope: z.enum(['court', 'all']).default('court') };

export const VALIDATORS = {
  /** Sum of class points of the people in scope must not exceed `max` (e.g. wheelchair basketball). `adjust` applies declared tags (never inferred). */
  class_points_cap: z.object({ ...base, type: z.literal('class_points_cap'), max: z.number().positive().max(1000), adjust: z.array(z.object({ tag, delta: z.number().min(-50).max(50) }).strict()).max(10).default([]) }).strict(),
  /** Number of people in scope holding any of `classes` (or tag) must lie within min..max. */
  class_quota: z.object({ ...base, type: z.literal('class_quota'), classes: z.array(code).max(60).default([]), tag: tag.optional(), min: z.number().int().min(0).max(100).optional(), max: z.number().int().min(0).max(100).optional() }).strict(),
  /** At most `max` people of the same class (team compositions where one class may not dominate). */
  same_class_max: z.object({ ...base, type: z.literal('same_class_max'), max: z.number().int().min(1).max(100) }).strict(),
  /** A discipline-specific role (e.g. a sport assistant, a coach) must be present `min` times. */
  role_required: z.object({ ...base, type: z.literal('role_required'), role: z.string().trim().min(1).max(40), min: z.number().int().min(1).max(20).default(1), when_classes: z.array(code).max(60).default([]) }).strict(),
  /** Lineup size in scope. */
  composition: z.object({ ...base, type: z.literal('composition'), min: z.number().int().min(0).max(100).optional(), max: z.number().int().min(0).max(100).optional() }).strict(),
};
const RULE = z.discriminatedUnion('type', Object.values(VALIDATORS));

export const DEFINITION = z.object({
  classes: z.array(z.object({ code, points: z.number().min(0).max(100).optional(), category: z.array(tag).max(10).default([]) }).strict()).min(1).max(120),
  categories: z.array(z.object({ key: tag, label: z.string().trim().min(1).max(80), classes: z.array(code).max(120) }).strict()).max(40).default([]),
  status_required: z.array(z.enum(['confirmed', 'temporary'])).min(1).default(['confirmed', 'temporary']),
  accept_external_reference: z.boolean().default(false),
  rules: z.array(RULE).min(1).max(40),
}).strict().superRefine((d, ctx) => {
  const known = new Set(d.classes.map((c) => c.code.toUpperCase()));
  const dup = d.rules.map((r) => r.id).find((x, i, a) => a.indexOf(x) !== i);
  if (dup) ctx.addIssue({ code: 'custom', message: `Rule id "${dup}" is used twice` });
  if (known.size !== d.classes.length) ctx.addIssue({ code: 'custom', message: 'A class is listed twice' });
  for (const r of d.rules) {
    for (const k of r.classes ?? r.when_classes ?? []) if (!known.has(k.toUpperCase())) ctx.addIssue({ code: 'custom', message: `Rule "${r.id}" names class ${k}, which is not a class of this pack` });
    if (r.type === 'class_points_cap' && d.classes.some((c) => c.points == null)) ctx.addIssue({ code: 'custom', message: `Rule "${r.id}" needs a points value on every class` });
    if (r.min != null && r.max != null && r.min > r.max) ctx.addIssue({ code: 'custom', message: `Rule "${r.id}" has a minimum above its maximum` });
  }
});

const up = (s) => String(s ?? '').toUpperCase();
const ok = (rule, reason, extra = {}) => ({ rule, status: 'pass', code: `${rule}.pass`, reason, ...extra });
const bad = (rule, reason, remediation, extra = {}) => ({ rule, status: 'fail', code: `${rule}.fail`, reason, remediation, ...extra });
const wait = (rule, reason, remediation, extra = {}) => ({ rule, status: 'pending', code: `${rule}.pending`, reason, remediation, ...extra });

/** One person against the pack: is there an acceptable class, and is it a class of this competition? Pure. */
export function memberCheck(def, m) {
  const label = m.name ? `${m.name}: ` : '';
  if (!m.class_code && !m.status) return { user_id: m.user_id, ...bad('member_class', `${label}no authorised classification on record`, 'Ask the athlete to request a classification from the sport authority, or request an override.') };
  if (m.status === 'not_eligible') return { user_id: m.user_id, ...bad('member_class', `${label}not eligible for this sport`, 'This person cannot be entered under this pack.') };
  if (m.status === 'review_required' || m.review_lapsed) return { user_id: m.user_id, ...wait('member_class', `${label}classification ${m.class_code ?? ''} needs review`.replace('  ', ' '), 'Ask the sport authority to confirm the review; no clinical detail is shown here.') };
  if (!def.status_required.includes(m.status)) return { user_id: m.user_id, ...bad('member_class', `${label}status ${m.status} is not accepted by this pack`, `Accepted: ${def.status_required.join(', ')}.`) };
  if (!def.classes.some((c) => up(c.code) === up(m.class_code))) return { user_id: m.user_id, ...bad('member_class', `${label}class ${m.class_code} is not a class of this competition`, `Classes of this pack: ${def.classes.map((c) => c.code).join(', ')}.`) };
  return { user_id: m.user_id, ...ok('member_class', `${label}class ${m.class_code} accepted`) };
}

/**
 * Evaluate a lineup. members: [{ user_id, class_code, status, slot: 'court'|'bench'|'staff', role, tags: [] }].
 * Deterministic and side-effect free: the same pack and members always give the same result.
 */
export function evaluateLineup(def, members) {
  const per = members.filter((m) => m.slot !== 'staff').map((m) => memberCheck(def, m));
  const checks = [];
  const pts = (m) => (def.classes.find((c) => up(c.code) === up(m.class_code))?.points ?? 0);
  for (const r of def.rules) {
    const inScope = members.filter((m) => m.slot !== 'staff' && (r.scope === 'all' || m.slot === 'court'));
    const L = r.label;
    if (r.type === 'class_points_cap') {
      const total = inScope.reduce((s, m) => s + pts(m) + (r.adjust ?? []).reduce((a, x) => a + ((m.tags ?? []).includes(x.tag) ? x.delta : 0), 0), 0);
      checks.push(total > r.max + 1e-9
        ? bad(r.id, `${L ?? 'Class points'}: ${total} exceeds the limit of ${r.max}`, `Remove or swap players so the total is ${r.max} or less (over by ${+(total - r.max).toFixed(2)}).`, { value: total, limit: r.max })
        : ok(r.id, `${L ?? 'Class points'}: ${total} of ${r.max}`, { value: total, limit: r.max }));
    } else if (r.type === 'class_quota') {
      const n = inScope.filter((m) => (r.classes.length ? r.classes.some((k) => up(k) === up(m.class_code)) : true) && (!r.tag || (m.tags ?? []).includes(r.tag))).length;
      const what = r.classes.length ? `class ${r.classes.join('/')}` : `tag ${r.tag}`;
      if (r.min != null && n < r.min) checks.push(bad(r.id, `${L ?? 'Quota'}: ${n} of ${what}, at least ${r.min} required`, `Add ${r.min - n} more player(s) of ${what}.`, { value: n, limit: r.min }));
      else if (r.max != null && n > r.max) checks.push(bad(r.id, `${L ?? 'Quota'}: ${n} of ${what}, at most ${r.max} allowed`, `Remove ${n - r.max} player(s) of ${what}.`, { value: n, limit: r.max }));
      else checks.push(ok(r.id, `${L ?? 'Quota'}: ${n} of ${what}`, { value: n }));
    } else if (r.type === 'same_class_max') {
      const by = {}; for (const m of inScope) by[up(m.class_code)] = (by[up(m.class_code)] ?? 0) + 1;
      const [k, n] = Object.entries(by).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
      checks.push(n > r.max ? bad(r.id, `${L ?? 'Class balance'}: ${n} players of class ${k}, at most ${r.max} allowed`, `Replace ${n - r.max} player(s) of class ${k}.`, { value: n, limit: r.max }) : ok(r.id, `${L ?? 'Class balance'}: no class above ${r.max}`));
    } else if (r.type === 'role_required') {
      const need = r.when_classes.length ? inScope.some((m) => r.when_classes.some((k) => up(k) === up(m.class_code))) : true;
      const n = members.filter((m) => up(m.role) === up(r.role)).length;
      checks.push(need && n < r.min ? bad(r.id, `${L ?? 'Required role'}: ${r.role} needed (${n} of ${r.min})`, `Add a ${r.role} to the team sheet.`, { value: n, limit: r.min }) : ok(r.id, `${L ?? 'Required role'}: ${need ? `${n} ${r.role}` : 'not required for this lineup'}`));
    } else if (r.type === 'composition') {
      const n = inScope.length;
      if (r.min != null && n < r.min) checks.push(bad(r.id, `${L ?? 'Lineup size'}: ${n}, at least ${r.min} required`, `Select ${r.min - n} more.`, { value: n, limit: r.min }));
      else if (r.max != null && n > r.max) checks.push(bad(r.id, `${L ?? 'Lineup size'}: ${n}, at most ${r.max} allowed`, `Select ${n - r.max} fewer.`, { value: n, limit: r.max }));
      else checks.push(ok(r.id, `${L ?? 'Lineup size'}: ${n}`, { value: n }));
    }
  }
  const all = [...per, ...checks];
  const valid = !all.some((k) => k.status === 'fail');
  const pending = !all.some((k) => k.status === 'fail') && all.some((k) => k.status === 'pending');
  return { valid, pending, members: per, checks };
}

export const latestPack = (c, eventId, packId = null) =>
  c.query(packId ? 'SELECT * FROM para_rule_packs WHERE id=$1 AND event_id=$2' : 'SELECT * FROM para_rule_packs WHERE event_id=$1 ORDER BY version DESC LIMIT 1', packId ? [packId, eventId] : [eventId]).then((r) => r.rows[0] ?? null);

/** The pack a policy is locked to: policy.rules.para_pack_id (the version lock). No reference = para rules do not apply to the competition. */
export const packOfPolicy = (c, event, policy) => (policy?.rules?.para_pack_id ? latestPack(c, event.id, policy.rules.para_pack_id) : Promise.resolve(null));

/** The class in force for a person at an instant (governed outcome first, then a verified external reference when the pack allows it). Class code and status only. */
export async function classOf(c, def, event, userId, at) {
  const day = (at instanceof Date ? at : new Date(at)).toISOString().slice(0, 10);
  const o = await outcomeAt(c, userId, event.sport_id, at);
  if (o) return { class_code: o.class_code, status: o.status, review_lapsed: !!(o.review_by && o.review_by < day), source: 'outcome' };
  if (def.accept_external_reference) { const x = await verifiedExternalAt(c, userId, event.sport_id, at); if (x) return { class_code: x.class_code, status: x.status, review_lapsed: !!(x.review_by && x.review_by < day), source: 'external_reference' }; }
  return { class_code: null, status: null, review_lapsed: false, source: null };
}

/** Squad rows → members. Substitutes are on the bench, staff roles are staff; `position` carries a discipline role (e.g. "assistant"). */
export async function loadMembers(c, def, event, rows, at, names = new Map()) {
  const out = [];
  for (const r of rows) {
    const staff = ['coach', 'manager', 'physio'].includes(r.role);
    const cls = staff ? { class_code: null, status: null, review_lapsed: false } : await classOf(c, def, event, r.user_id, at);
    out.push({ user_id: r.user_id, name: names.get(r.user_id) ?? null, slot: staff ? 'staff' : r.slot ?? (r.role === 'substitute' ? 'bench' : 'court'), role: r.discipline_role ?? r.position ?? r.role, tags: r.tags ?? [], ...cls });
  }
  return out;
}

/** Live approved overrides of a team (fixture-specific or competition-wide) at an instant, by rule id. */
export const liveOverrides = (c, eventId, teamId, fixtureId, at = new Date()) =>
  c.query(`SELECT id, rule_id, fixture_id, decided_by, effective_to FROM para_overrides WHERE event_id=$1 AND team_id=$2 AND status='approved' AND (fixture_id IS NULL OR fixture_id=$3) AND (effective_to IS NULL OR effective_to > $4)`, [eventId, teamId, fixtureId, at]).then((r) => r.rows);

/** Apply approved overrides: a failed (or pending) check named by a live override becomes `waived`, never silently passed. */
export function applyOverrides(result, overrides) {
  const by = new Map(overrides.map((o) => [o.rule_id, o]));
  const checks = result.checks.map((k) => (k.status !== 'pass' && by.has(k.rule) ? { ...k, status: 'waived', code: `${k.rule}.waived`, reason: `${k.reason} (waived by an approved override)`, source: { kind: 'para_override', id: by.get(k.rule).id } } : k));
  const valid = !checks.some((k) => k.status === 'fail') && !result.members.some((k) => k.status === 'fail');
  return { ...result, checks, valid, pending: valid && [...checks, ...result.members].some((k) => k.status === 'pending'), applied_overrides: overrides.filter((o) => result.checks.some((k) => k.rule === o.rule_id && k.status !== 'pass')).map((o) => o.id) };
}
