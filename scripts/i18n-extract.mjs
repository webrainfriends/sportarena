#!/usr/bin/env node
// Finds user-facing strings in apps/app/src that bypass t(). Shared by the usage test and used to drive conversion.
//   node scripts/i18n-extract.mjs            -> per-file counts (descending) and a total
//   node scripts/i18n-extract.mjs <file>     -> every hit in that file with line numbers
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/app/src');
const SKIP_DIRS = new Set(['i18n', 'node_modules']);

// props / fields that carry text a person reads
const PROPS = 'title|label|placeholder|hint|subtitle|accessibilityLabel|accessibilityHint|text|message|body|heading|empty|caption|description|cta';
const RES = [
  ['jsx-text', />\s*([A-Za-z][^<>{}\n]*[A-Za-z.!?:)])\s*</g],
  ['prop', new RegExp(`\\b(?:${PROPS})\\s*=\\s*(?:"([^"]*[A-Za-z]{2,}[^"]*)"|'([^']*[A-Za-z]{2,}[^']*)')`, 'g')],
  ['field', new RegExp(`\\b(?:${PROPS}):\\s*'([A-Z][^']*[a-z][^']*)'`, 'g')],
  ['say', /\b(?:say|setErr|setMsg|toast)\(\s*'([^']*[A-Za-z]{3,}[^']*)'/g],
  ['error', /new Error\(\s*'([^']*[A-Za-z]{3,}[^']*)'/g],
];
// words that are not prose: identifiers, units, brand, symbols, urls
const NOT_PROSE = /^(?:[a-z][a-zA-Z0-9_.:/-]*|[A-Z0-9_]+|https?:.*|\W+|Gotmygame|[a-z]{1,3})$/;

export function* walk(dir = ROOT) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name)); }
    else if (e.name.endsWith('.js')) yield path.join(dir, e.name);
  }
}

export function scan(file) {
  const src = fs.readFileSync(file, 'utf8');
  const hits = [];
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|import )/.test(line) || /t\(['"`]/.test(line) && !/>[^<{]*[A-Za-z]{3,}[^<]*</.test(line)) return;
    for (const [kind, re] of RES) {
      for (const m of line.matchAll(new RegExp(re.source, re.flags))) {
        const s = (m[1] ?? m[2] ?? '').trim();
        if (!s || NOT_PROSE.test(s) || !/[A-Za-z]{2,}/.test(s)) continue;
        if (kind === 'jsx-text' && /[=;]|=>|\b(?:return|const|let)\b/.test(s)) continue;
        hits.push({ line: i + 1, kind, text: s });
      }
    }
  });
  return hits;
}

export function scanAll() {
  const out = {};
  for (const f of walk()) { const h = scan(f); if (h.length) out[path.relative(ROOT, f)] = h; }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg) {
    for (const h of scan(path.resolve(ROOT, arg))) console.log(`${h.line}\t${h.kind}\t${h.text}`);
  } else {
    const all = scanAll();
    const rows = Object.entries(all).map(([f, h]) => [f, h.length]).sort((a, b) => b[1] - a[1]);
    for (const [f, n] of rows) console.log(`${String(n).padStart(5)}  ${f}`);
    console.log(`\n${rows.reduce((s, r) => s + r[1], 0)} hard-coded strings in ${rows.length} files`);
  }
}
