// Some para-sport suites were written against vitest (describe / it / expect / beforeAll / afterAll). The repo runs `node --test`, and vitest
// is not installed, so those files failed to load and never ran. This maps the handful of vitest calls they use onto node:test and
// node:assert so they run under `npm test` unchanged. It is not a general vitest replacement: only the matchers those files use exist.
import { describe, it, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const has = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(Object(obj), key);
const matchers = (actual, negate) => {
  const check = (pass, message) => { if (negate ? pass : !pass) assert.fail(`${negate ? 'not ' : ''}${message}`); };
  return {
    toBe: (x) => check(Object.is(actual, x), `expected ${JSON.stringify(actual)} to be ${JSON.stringify(x)}`),
    toEqual: (x) => check(isDeepStrictEqual(actual, x), `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(x)}`),
    toContain: (x) => check(actual != null && (typeof actual === 'string' ? actual.includes(x) : [...actual].includes(x)), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(x)}`),
    toHaveLength: (n) => check(actual?.length === n, `expected length ${actual?.length} to be ${n}`),
    toHaveProperty: (k, v) => check(has(actual, k) && (v === undefined || isDeepStrictEqual(actual[k], v)), `expected object to have property ${k}`),
    toMatch: (re) => check(typeof actual === 'string' && (re instanceof RegExp ? re.test(actual) : actual.includes(re)), `expected ${JSON.stringify(actual)} to match ${re}`),
    toBeNull: () => check(actual === null, `expected ${JSON.stringify(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `expected ${JSON.stringify(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, 'expected a defined value'),
    toBeTruthy: () => check(Boolean(actual), `expected ${JSON.stringify(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, `expected ${JSON.stringify(actual)} to be falsy`),
    toBeGreaterThan: (n) => check(actual > n, `expected ${actual} to be greater than ${n}`),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, `expected ${actual} to be at least ${n}`),
    toBeLessThan: (n) => check(actual < n, `expected ${actual} to be less than ${n}`),
    toThrow: (want) => {
      let threw = false, err;
      try { actual(); } catch (e) { threw = true; err = e; }
      check(threw && (want === undefined || (want instanceof RegExp ? want.test(String(err?.message)) : String(err?.message).includes(want))), `expected function to throw${want ? ` ${want}` : ''}`);
    },
  };
};
export const expect = (actual) => ({ ...matchers(actual, false), not: matchers(actual, true) });
export { describe, it, test, before as beforeAll, after as afterAll, beforeEach, afterEach };
