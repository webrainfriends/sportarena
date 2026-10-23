// Sponsorship application forms (#286), client side. `visibleKeys` mirrors apps/api/src/application-forms.js so questions show and hide
// live while typing; the server re-checks everything on save and submit and is the authority.
export const fieldsOf = (def) => def.sections.flatMap((s) => s.fields);
export const filled = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

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

export const digitsOf = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };
export const fmtMoney = (cents, cur) => { try { const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); return f.format(cents / 10 ** f.resolvedOptions().maximumFractionDigits); } catch { return `${cents} ${cur ?? ''}`; } };
/** "12.50" typed in whole units -> minor units, or undefined when it is not an amount. */
export const toMinor = (text, cur) => { const n = Number(String(text).replace(/,/g, '')); return Number.isFinite(n) && n >= 0 && String(text).trim() !== '' ? Math.round(n * 10 ** digitsOf(cur)) : undefined; };
export const fromMinor = (cents, cur) => (cents == null ? '' : String(Number(cents) / 10 ** digitsOf(cur)));
export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/** Which step (section index, or sections.length for the review step) holds a server issue path like `answers.guardian` or `files.proof`. */
export function stepOfIssue(def, path) {
  const [kind, key] = String(path).split('.');
  const fs = def.sections.map((s) => s.fields);
  const find = (pred) => fs.findIndex((list) => list.some(pred));
  if (kind === 'answers' || kind === 'files') return Math.max(0, find((f) => f.key === key));
  if (kind === 'budget') return Math.max(0, find((f) => f.type === 'budget'));
  if (kind === 'references') return Math.max(0, find((f) => f.type === 'references'));
  return def.sections.length;
}
