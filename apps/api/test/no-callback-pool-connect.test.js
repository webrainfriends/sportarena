import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// pg's `pool.connect(fn)` is the callback form: fn receives (err, client, release), not a client, and the call returns nothing. A handler written as
// `return pool.connect(async (c) => { ...c.query... })` therefore answers an empty 200, never runs its checks, and the TypeError inside the
// discarded promise is an unhandled rejection, which kills the Node process. Use withClient(fn) (or tx) from src/db.js instead.
const root = new URL('../src/', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });

test('no handler passes a function to pool.connect (callback form)', () => {
  const bad = [];
  for (const file of walk(root)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/\.connect\(\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/.test(line) || /\.connect\(\s*(async\s+)?function/.test(line)) bad.push(`${file.replace(root, '')}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [], `pool.connect(fn) is the callback form, use withClient(fn):\n${bad.join('\n')}`);
});
