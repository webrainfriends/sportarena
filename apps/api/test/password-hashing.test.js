import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config } from '../src/config.js';
import { hashPassword, verifyPassword, hashingStats } from '../src/crypto.js';

// What the pre-async implementation (scryptSync) produced; stored hashes in production look like this.
const legacyHash = (pw) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url')}`;
};

test('hashes written by the old synchronous function still verify', async () => {
  const stored = legacyHash('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
});

test('new hashes keep the format and match the legacy algorithm', async () => {
  const h = await hashPassword('s3cret-pass');
  const [alg, salt, hash] = h.split('$');
  assert.equal(alg, 'scrypt');
  const expected = scryptSync('s3cret-pass', Buffer.from(salt, 'base64url'), 64, { N: 16384, r: 8, p: 1 }).toString('base64url');
  assert.equal(hash, expected);
  assert.equal(await verifyPassword('s3cret-pass', h), true);
  assert.equal(await verifyPassword('s3cret-pasS', h), false);
});

test('malformed or foreign stored hashes are rejected, not thrown', async () => {
  for (const bad of ['x', '', null, undefined, 'bcrypt$a$b', 'scrypt$only']) assert.equal(await verifyPassword('p', bad), false);
});

test('concurrency is bounded and the event loop stays responsive', async () => {
  const prev = { ...config.hashing };
  config.hashing.concurrency = 2; config.hashing.maxQueue = 64;
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  let maxActive = 0;
  const poll = setInterval(() => { maxActive = Math.max(maxActive, hashingStats().active); }, 1);
  const stored = legacyHash('pw-12345678');
  const results = await Promise.all(Array.from({ length: 12 }, () => verifyPassword('pw-12345678', stored)));
  clearInterval(poll); h.disable();
  Object.assign(config.hashing, prev);
  assert.ok(results.every(Boolean));
  assert.ok(maxActive <= 2, `active ${maxActive}`);
  assert.ok(h.max / 1e6 < 250, `event loop max delay ${(h.max / 1e6).toFixed(0)}ms`);
  assert.equal(hashingStats().active, 0);
});

test('overload returns a fast 503 busy error instead of queueing without bound', async () => {
  const prev = { ...config.hashing };
  config.hashing.concurrency = 1; config.hashing.maxQueue = 1;
  const stored = legacyHash('pw-12345678');
  const before = hashingStats().rejected;
  const settled = await Promise.allSettled(Array.from({ length: 5 }, () => verifyPassword('pw-12345678', stored)));
  Object.assign(config.hashing, prev);
  const rejected = settled.filter((s) => s.status === 'rejected');
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 2); // 1 running + 1 queued
  assert.equal(rejected.length, 3);
  assert.equal(rejected[0].reason.status, 503);
  assert.equal(rejected[0].reason.code, 'busy');
  assert.equal(hashingStats().rejected - before, 3);
  assert.equal(hashingStats().active, 0);
  assert.equal(hashingStats().queued, 0);
});

// hashPassword/verifyPassword return Promises: using one un-awaited makes `!verifyPassword(...)` always false
// (any password accepted) and stores a Promise as the new hash. Guard every call site in src/.
test('every hashPassword/verifyPassword call in src is awaited or returned', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') && files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname);
  const bad = [];
  for (const f of files.filter((p) => !p.endsWith('/crypto.js'))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(hashPassword|verifyPassword)\(/g)) {
        const before = line.slice(0, m.index).trimEnd().replace(/\($/, '');
        const cached = /\?\?=$/.test(before);   // `x ??= hashPassword(...)` caches the promise and callers await it
        if (!/(await|return)$/.test(before) && !cached && !/^(import|export)/.test(line.trim())) bad.push(`${f}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});
