#!/usr/bin/env node
// Adds keys to en.js and every language pack in one go, so they can never drift.
//   node scripts/i18n-add.mjs keys.json      keys.json = { "key": { "en": "…", "hi": "…", … all 11 packs } }
// Refuses a key that is missing a language, or that already exists (never overwrites a string).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/app/src/i18n');
const CODES = ['en', 'hi', 'mr', 'ta', 'te', 'ml', 'kn', 'bn', 'or', 'si', 'ur', 'id'];
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const ph = (s) => (String(s).match(/\{\w+\}/g) ?? []).sort().join();

const file = process.argv[2];
if (!file) { console.error('usage: i18n-add.mjs keys.json'); process.exit(2); }
const keys = JSON.parse(fs.readFileSync(file, 'utf8'));

const src = Object.fromEntries(CODES.map((c) => [c, fs.readFileSync(path.join(DIR, `${c}.js`), 'utf8')]));
const problems = [];
for (const [k, v] of Object.entries(keys)) {
  for (const c of CODES) {
    if (!v[c]) problems.push(`${k}: missing ${c}`);
    else if (ph(v[c]) !== ph(v.en)) problems.push(`${k}: placeholders differ in ${c}`);
  }
  if (src.en.includes(`'${k}':`)) problems.push(`${k}: already exists`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

for (const c of CODES) {
  const lines = Object.entries(keys).map(([k, v]) => `  ${q(k)}: ${q(v[c])},\n`).join('');
  const i = src[c].lastIndexOf('};');
  fs.writeFileSync(path.join(DIR, `${c}.js`), src[c].slice(0, i) + lines + src[c].slice(i));
}
console.log(`added ${Object.keys(keys).length} keys to ${CODES.length} packs`);
