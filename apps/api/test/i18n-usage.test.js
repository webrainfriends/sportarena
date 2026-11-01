import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanAll } from '../../../scripts/i18n-extract.mjs';

// A ratchet, not a wall: the app still has hard-coded English that bypasses t() (scripts/i18n-baseline.json records how much, per file).
// A file may never get worse, and a file with no entry may never gain a hard-coded string. When you convert a file, lower the baseline:
//   node scripts/i18n-extract.mjs --write-baseline
const baseline = JSON.parse(fs.readFileSync(new URL('../../../scripts/i18n-baseline.json', import.meta.url), 'utf8'));

test('no screen or component gains hard-coded user-facing English (use t() and add the key to all 12 packs)', () => {
  const found = scanAll();
  const worse = Object.entries(found)
    .filter(([file, hits]) => hits.length > (baseline[file] ?? 0))
    .map(([file, hits]) => `${file}: ${hits.length} (baseline ${baseline[file] ?? 0}) e.g. "${hits[hits.length - 1].text}" line ${hits[hits.length - 1].line}`);
  assert.deepEqual(worse, [], 'new hard-coded strings — translate them with t(); if you removed some, run: node scripts/i18n-extract.mjs --write-baseline');
});

test('the baseline only lists files that still have hard-coded strings (lower it when a file is converted)', () => {
  const found = scanAll();
  const stale = Object.entries(baseline).filter(([file, n]) => (found[file]?.length ?? 0) < n).map(([file, n]) => `${file}: baseline ${n}, now ${found[file]?.length ?? 0}`);
  assert.deepEqual(stale, [], 'baseline is out of date — run: node scripts/i18n-extract.mjs --write-baseline');
});
