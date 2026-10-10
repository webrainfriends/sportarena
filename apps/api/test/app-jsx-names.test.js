import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A component used in JSX but neither imported nor declared throws "X is not defined" at render and white-screens the
// screen. Merges have dropped import lines more than once, so check every app source file statically.
const root = new URL('../../app/src/', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });

test('every JSX component in the app is imported or declared in its file', () => {
  const problems = [];
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    const used = new Set([...src.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]));
    if (!used.size) continue;
    const declared = new Set([...src.matchAll(/\b(?:function|const|let|var|class)\s+([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]));
    for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
      const spec = m[1];
      const def = spec.match(/^([A-Za-z_$][\w$]*)/)?.[1]; if (def) declared.add(def);
      const ns = spec.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)?.[1]; if (ns) declared.add(ns);
      for (const name of (spec.match(/\{([^}]*)\}/)?.[1] ?? '').split(',')) { const n = name.trim().split(/\s+as\s+/).pop(); if (n) declared.add(n); }
    }
    // destructured declarations: const { A, B } = x
    for (const m of src.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=/g)) for (const n of m[1].split(',')) { const x = n.trim().split(':').pop().trim(); if (x) declared.add(x); }
    const missing = [...used].filter((n) => !declared.has(n));
    if (missing.length) problems.push(`${file.replace(root, '')}: ${missing.join(', ')}`);
  }
  assert.deepEqual(problems, [], `used in JSX but not imported or declared:\n${problems.join('\n')}`);
});
