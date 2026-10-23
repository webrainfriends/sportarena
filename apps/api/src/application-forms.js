// Sponsorship application forms (#286): the definition schema, conditional visibility and answer validation. Pure functions, no I/O,
// so the server (which is the authority) and the app (live show/hide) share exactly one set of rules.
import { z } from 'zod';

export const FIELD_TYPES = ['text', 'longtext', 'number', 'money', 'date', 'choice', 'multi', 'yesno', 'file', 'budget', 'references'];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const OPS = ['eq', 'ne', 'in', 'filled'];

const when = z.object({ field: z.string().regex(KEY), op: z.enum(OPS), value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.string().max(200)).max(30)]).optional() });
const option = z.object({ value: z.string().min(1).max(60), label: z.string().min(1).max(120) });
const field = z.object({
  key: z.string().regex(KEY, 'lowercase letters, digits and underscores, starting with a letter'),
  label: z.string().min(1).max(160),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  hint: z.string().max(300).optional(),
  options: z.array(option).max(30).optional(),        // choice, multi
  min: z.number().optional(), max: z.number().optional(), // number, money (cents), text length
  max_files: z.number().int().min(1).max(10).optional(),  // file
  max_items: z.number().int().min(1).max(10).optional(), // references
  confidential: z.boolean().default(false),           // stored encrypted; reads by staff are audit-logged
  profile_key: z.string().regex(KEY).optional(),      // prefilled from the applicant's reusable profile
  when: when.optional(),                              // shown only while the condition holds
});
export const formDefinition = z.object({
  sections: z.array(z.object({ id: z.string().regex(KEY), title: z.string().min(1).max(120), fields: z.array(field).min(1).max(40) })).min(1).max(10),
}).superRefine((d, ctx) => {
  const seen = new Set(); let budget = 0, refs = 0, n = 0;
  d.sections.forEach((s, si) => s.fields.forEach((f, fi) => {
    const at = ['sections', si, 'fields', fi];
    n++;
    if (seen.has(f.key)) ctx.addIssue({ code: 'custom', path: [...at, 'key'], message: `Duplicate field key "${f.key}"` });
    if (['choice', 'multi'].includes(f.type) && !f.options?.length) ctx.addIssue({ code: 'custom', path: [...at, 'options'], message: 'Add at least one option' });
    if (f.type === 'budget' && ++budget > 1) ctx.addIssue({ code: 'custom', path: at, message: 'A form can have one budget' });
    if (f.type === 'references' && ++refs > 1) ctx.addIssue({ code: 'custom', path: at, message: 'A form can have one references block' });
    if (f.confidential && ['file', 'budget', 'references'].includes(f.type)) ctx.addIssue({ code: 'custom', path: at, message: 'Files, budget and references are always kept confidential' });
    if (f.when && !seen.has(f.when.field)) ctx.addIssue({ code: 'custom', path: [...at, 'when'], message: 'A condition can only depend on a field that comes earlier in the form' });
    if (f.when && f.when.op !== 'filled' && f.when.value === undefined) ctx.addIssue({ code: 'custom', path: [...at, 'when', 'value'], message: 'Give the value to compare with' });
    seen.add(f.key);
  }));
  if (n > 60) ctx.addIssue({ code: 'custom', message: 'A form can have up to 60 fields' });
});

export const fieldsOf = (def) => def.sections.flatMap((s) => s.fields);
const filled = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

/** Is the field's condition met, given the answers so far? A field whose parent is hidden is hidden too. */
export function visibleKeys(def, answers) {
  const vis = new Set();
  for (const f of fieldsOf(def)) {
    if (!f.when) { vis.add(f.key); continue; }
    if (!vis.has(f.when.field)) continue;
    const v = answers[f.when.field], w = f.when.value;
    const ok = f.when.op === 'filled' ? filled(v) : f.when.op === 'eq' ? v === w : f.when.op === 'ne' ? v !== w : Array.isArray(w) && (Array.isArray(v) ? v.some((x) => w.includes(x)) : w.includes(v));
    if (ok) vis.add(f.key);
  }
  return vis;
}

const refShape = z.object({ name: z.string().min(1).max(120), relationship: z.string().min(1).max(120), email: z.string().email().max(200).optional(), phone: z.string().max(40).optional(), may_contact: z.boolean() })
  .refine((r) => r.email || r.phone, { message: 'Give an email or a phone number' });
const budgetLine = z.object({ label: z.string().min(1).max(120), amount_cents: z.number().int().min(1).max(1e12) });
export const budgetShape = z.array(budgetLine).max(30);
export const referencesShape = z.array(refShape).max(10);

function typed(f, v) {
  switch (f.type) {
    case 'text': case 'longtext': return typeof v === 'string' && v.length <= (f.max ?? (f.type === 'text' ? 300 : 4000)) && v.length >= (f.min ?? 0) ? null : `Use ${f.min ?? 0}–${f.max ?? (f.type === 'text' ? 300 : 4000)} characters`;
    case 'number': return typeof v === 'number' && Number.isFinite(v) && v >= (f.min ?? -1e12) && v <= (f.max ?? 1e12) ? null : 'Enter a number in range';
    case 'money': return Number.isInteger(v) && v >= (f.min ?? 0) && v <= (f.max ?? 1e12) ? null : 'Enter an amount in range';
    case 'date': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? null : 'Pick a date';
    case 'choice': return f.options.some((o) => o.value === v) ? null : 'Pick one of the options';
    case 'multi': return Array.isArray(v) && v.every((x) => f.options.some((o) => o.value === x)) && new Set(v).size === v.length ? null : 'Pick from the options';
    case 'yesno': return typeof v === 'boolean' ? null : 'Answer yes or no';
    default: return 'Not an answer field';
  }
}

/**
 * Check an application against a form version. `strict` (submit) also requires every visible required field; a draft only
 * type-checks what was entered. Returns `{ issues, answers }` where `answers` keeps only visible answer fields.
 * Input: { answers, budget, references, requested_cents, fileCounts: { [field_key]: n } }.
 */
export function validateApplication(def, { answers = {}, budget = null, references = null, requested_cents = null, fileCounts = {} }, { strict = false } = {}) {
  const issues = [], fields = fieldsOf(def), byKey = new Map(fields.map((f) => [f.key, f]));
  for (const k of Object.keys(answers)) if (!byKey.has(k) || ['file', 'budget', 'references'].includes(byKey.get(k).type)) issues.push({ path: `answers.${k}`, message: 'This form has no such question' });
  const vis = visibleKeys(def, answers), kept = {};
  for (const f of fields) {
    if (!vis.has(f.key)) continue;
    if (f.type === 'file') {
      const n = fileCounts[f.key] ?? 0;
      if (strict && f.required && n < 1) issues.push({ path: `files.${f.key}`, message: `${f.label}: upload a file` });
      if (n > (f.max_files ?? 5)) issues.push({ path: `files.${f.key}`, message: `${f.label}: up to ${f.max_files ?? 5} files` });
    } else if (f.type === 'budget') {
      const p = budget == null ? null : budgetShape.safeParse(budget);
      if (p && !p.success) issues.push({ path: `budget`, message: 'Each budget line needs a label and a positive amount' });
      else if (strict && f.required && !p?.data?.length) issues.push({ path: 'budget', message: `${f.label}: add at least one line` });
      else if (p?.data?.length && requested_cents != null && p.data.reduce((s, l) => s + l.amount_cents, 0) < requested_cents) issues.push({ path: 'budget', message: 'The budget total cannot be less than the amount you request' });
    } else if (f.type === 'references') {
      const p = references == null ? null : referencesShape.safeParse(references);
      if (p && !p.success) issues.push({ path: 'references', message: p.error.issues[0]?.message ?? 'Check the references' });
      else if (p?.data && p.data.length > (f.max_items ?? 3)) issues.push({ path: 'references', message: `Up to ${f.max_items ?? 3} references` });
      else if (strict && f.required && !p?.data?.length) issues.push({ path: 'references', message: `${f.label}: add a reference` });
    } else {
      const v = answers[f.key];
      if (!filled(v)) { if (strict && f.required) issues.push({ path: `answers.${f.key}`, message: `${f.label} is required` }); continue; }
      const bad = typed(f, v);
      if (bad) issues.push({ path: `answers.${f.key}`, message: `${f.label}: ${bad}` }); else kept[f.key] = v;
    }
  }
  return { issues, answers: kept };
}

/** Split answers into the open part and the part marked confidential (kept encrypted). */
export function splitConfidential(def, answers) {
  const conf = new Set(fieldsOf(def).filter((f) => f.confidential).map((f) => f.key)), open = {}, secret = {};
  for (const [k, v] of Object.entries(answers)) (conf.has(k) ? secret : open)[k] = v;
  return { open, secret };
}
