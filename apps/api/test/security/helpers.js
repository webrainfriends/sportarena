// Test helpers for multi-role IDOR and tenant isolation tests (issue #1129).
// These are thin factories over the HTTP API — same patterns as other test suites.
import assert from 'node:assert/strict';

let _counter = 0;
export const nextN = () => ++_counter;

// ---- user factories ----

/** Register a user via the HTTP API and return { id, token, ...user }. */
export async function register(base, roles = ['athlete'], extra = {}) {
  const n = nextN();
  const r = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: `iso_${n}`, display_name: `Iso ${n}`, email: `iso${n}@example.com`, password: 'correct-horse-battery', roles, ...extra }),
  });
  assert.equal(r.status, 201, `register failed: ${await r.text()}`);
  const body = await r.json();
  return { ...body.user, token: body.token };
}

/** Build a minimal in-memory user object for direct invoke() calls (no DB, no JWT). */
export function makeUser(roles = ['athlete'], overrides = {}) {
  const n = nextN();
  return { id: `usr-${n}`, handle: `u${n}`, display_name: `User ${n}`, roles, access_status: 'active', ...overrides };
}

/** Build a minimal API-token credential object for scope/resource enforcement tests. */
export function makeCredential(scopes = ['read'], resources = null) {
  return { type: 'api_token', id: `tok-${nextN()}`, scopes, resources, expires_at: null, owner_mfa_enabled: false };
}

/** Attach a credential to a user so invoke() enforces scope/resources. */
export function withCredential(user, credential) {
  const u = { ...user };
  Object.defineProperty(u, 'credential', { value: credential, enumerable: false });
  return u;
}

// ---- HTTP helper ----
export const api = (base) => async (method, path, { token, body, query } = {}) => {
  const url = `${base}/api/v1${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/** Assert an HTTP response is a 403 or 404 denial. */
export function assertDenied(r, reason = '') {
  assert.ok(
    r.status === 403 || r.status === 404,
    `Expected 403/404 (${reason}), got ${r.status}: ${JSON.stringify(r.body)}`,
  );
}

/**
 * Run an array of negative cases against an HTTP endpoint.
 * cases: Array<{ label, method, path, token, body, query }>
 * Each must resolve to 403 or 404.
 */
export async function forbiddenCases(apiCall, cases) {
  for (const c of cases) {
    const r = await apiCall(c.method, c.path, { token: c.token, body: c.body, query: c.query });
    assertDenied(r, c.label);
  }
}
