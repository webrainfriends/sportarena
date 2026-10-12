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

// REST/OpenAPI/MCP parity for token scopes: the OpenAPI document states the scope each operation needs.
test('OpenAPI exposes each capability\'s required token scope', async () => {
  const { buildOpenApi } = await import('../src/openapi.js');
  const { capabilities } = await import('../src/capabilities/index.js');
  const doc = buildOpenApi();
  const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
  const byId = Object.fromEntries(ops.map((o) => [o.operationId, o]));
  for (const c of capabilities) {
    const op = byId[c.name];
    assert.ok(op, `${c.name} is in the OpenAPI document`);
    if (c.auth === 'public') { assert.equal(op['x-required-scope'], undefined, `${c.name} is public`); continue; }
    assert.ok(['read', 'write', 'payment', 'clinical', 'admin'].includes(c.scope), `${c.name} has a scope`);
    assert.equal(op['x-required-scope'], c.scope, c.name);
    assert.match(op.description, new RegExp(`\\\`${c.scope}\\\``), `${c.name} description names its scope`);
  }
  assert.equal(byId.create_payment['x-required-scope'], 'payment');
  assert.equal(byId.list_medical_records['x-required-scope'], 'clinical');
});
