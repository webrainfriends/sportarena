#!/usr/bin/env node
// For every t('key', { a, b: x }) call in the app, compares the parameter names passed with the {placeholders} in the English text.
// A mismatch shows a literal "{name}" (or drops a value) to the person, and no other check catches it.
import fs from 'node:fs';
import { walk } from './i18n-extract.mjs';
import en from '../apps/app/src/i18n/en.js';

/** Top-level property names of the object literal that starts at s[i] === '{'. */
function propNames(s, i) {
  let depth = 0, names = [], cur = '', inStr = null, expectKey = true, esc = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === inStr) inStr = null; if (depth === 1 && expectKey) cur += ch; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ')' || ch === ']') { depth--; if (depth === 0) { if (cur.trim()) names.push(cur.trim().split(/[:\s]/)[0]); return names; } continue; }
    if (depth === 1) {
      if (ch === ',') { if (cur.trim()) names.push(cur.trim().split(/[:\s]/)[0]); cur = ''; expectKey = true; }
      else if (ch === ':' && expectKey) { names.push(cur.trim()); cur = ''; expectKey = false; }
      else if (expectKey) cur += ch;
    }
  }
  return names;
}

const problems = [];
let calls = 0;
for (const file of walk()) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?<![\w.$])t\(\s*(?:'([A-Za-z0-9_.]+)'|\w+\s*===\s*\d+\s*\?\s*'([A-Za-z0-9_.]+)'\s*:\s*'([A-Za-z0-9_.]+)')\s*(,\s*\{)?/g)) {
    const keys = [m[1], m[2], m[3]].filter(Boolean);
    const passed = m[4] ? propNames(src, m.index + m[0].length - 1) : [];
    for (const key of keys) {
      if (!(key in en)) continue;
      calls++;
      const want = [...new Set([...en[key].matchAll(/\{(\w+)\}/g)].map((x) => x[1]))].sort();
      const got = [...new Set(passed)].sort();
      if (want.join() !== got.join()) problems.push(`${file.split('/apps/app/src/')[1]}: ${key} expects {${want}} but passes {${got}}`);
    }
  }
}
console.log(`${calls} calls checked, ${problems.length} problems`);
for (const p of problems) console.log(' ', p);
process.exit(problems.length ? 1 : 0);
