import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// A capability file that nothing imports is silently dead: its REST routes 404 and its MCP tools vanish.
// (Merges have dropped lines from index.js before.) Every file that defines capabilities must be reachable from index.js.
test('every capability file is imported, so its routes and tools exist', () => {
  const dir = new URL('../src/capabilities/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js');
  const sources = Object.fromEntries(files.map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]));
  const imports = (src) => [...src.matchAll(/from\s+'\.\/([\w-]+\.js)'|import\s+'\.\/([\w-]+\.js)'/g)].map((m) => m[1] ?? m[2]);
  const reachable = new Set();
  const visit = (f) => { if (reachable.has(f) || !sources[f] && f !== 'index.js') return; reachable.add(f); for (const g of imports(f === 'index.js' ? readFileSync(new URL('index.js', dir), 'utf8') : sources[f])) visit(g); };
  visit('index.js');
  const orphans = files.filter((f) => /\bcap\(/.test(sources[f]) && !reachable.has(f));
  assert.deepEqual(orphans, [], `not imported (directly or transitively) from capabilities/index.js: ${orphans.join(', ')}`);
});
