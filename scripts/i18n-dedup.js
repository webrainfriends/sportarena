#!/usr/bin/env node
// Deduplicates keys in i18n language files, keeping the FIRST occurrence.
// The bug: English blocks were appended to non-English files, so the last
// definition (English) silently overwrites the earlier translated value.
// Running this script restores ~2,500-2,821 strings per language file.
//
// Usage: node scripts/i18n-dedup.js [--dry-run]
//
// Safe to re-run: idempotent once duplicates are removed.

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const DRY = process.argv.includes('--dry-run');

const LANGS = ['hi', 'mr', 'ta', 'te', 'ml', 'kn', 'bn', 'or', 'si', 'ur', 'id'];

function dedup(code) {
  const file = resolve(root, 'apps/app/src/i18n', `${code}.js`);
  const src = readFileSync(file, 'utf8');

  // Extract the object body between `export default {` and the final `};`
  const bodyStart = src.indexOf('{') + 1;
  const bodyEnd = src.lastIndexOf('}');
  const body = src.slice(bodyStart, bodyEnd);

  // Parse key-value pairs. Each pair is:  'key': 'value',
  // Values may contain escaped quotes and interpolation {param}.
  // Strategy: scan token by token; track seen keys; skip duplicate definitions.
  const seen = new Set();
  const lines = body.split('\n');
  const kept = [];
  let dupeCount = 0;
  let commentBlock = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Keep blank lines and standalone comment lines as-is (attached to their block)
    if (!trimmed || trimmed.startsWith('//')) {
      commentBlock.push(line);
      continue;
    }

    // Extract key from lines of the form:  'some.key': ...,
    const keyMatch = trimmed.match(/^'([^']+)':/);
    if (!keyMatch) {
      // Not a key-value line (could be a continuation or multi-line value) — keep
      kept.push(...commentBlock, line);
      commentBlock = [];
      continue;
    }

    const key = keyMatch[1];
    if (seen.has(key)) {
      // Duplicate — skip this line and discard any preceding comments that
      // belong to this duplicate block (comment lines accumulated above)
      commentBlock = [];
      dupeCount++;
    } else {
      seen.add(key);
      kept.push(...commentBlock, line);
      commentBlock = [];
    }
  }

  // Flush any trailing comments
  kept.push(...commentBlock);

  const newBody = kept.join('\n');
  const header = src.slice(0, bodyStart);
  const footer = src.slice(bodyEnd);
  const newSrc = header + newBody + footer;

  if (newSrc === src) {
    console.log(`${code}: no duplicates found`);
    return { dupeCount: 0 };
  }

  if (!DRY) {
    writeFileSync(file, newSrc, 'utf8');
  }
  console.log(`${code}: removed ${dupeCount} duplicate key${dupeCount === 1 ? '' : 's'}${DRY ? ' (dry run)' : ''}`);
  return { dupeCount };
}

let total = 0;
for (const code of LANGS) {
  const { dupeCount } = dedup(code);
  total += dupeCount;
}
console.log(`\nTotal duplicates removed: ${total}`);
