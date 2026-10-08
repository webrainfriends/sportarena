// Thin REST client. The app only ever talks to the public API (/api/v1) — same surface agents get over MCP.
import { Platform } from 'react-native';
import { storage } from './storage';

const guess = () => {
  // '' (set but empty) means same-origin: the web build is served by nginx next to /api (see docs/deployment.md)
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv !== undefined) return fromEnv;
  if (Platform.OS === 'web' && typeof location !== 'undefined') return `${location.protocol}//${location.hostname}:4000`;
  return Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';
};
export const API = `${guess().replace(/\/$/, '')}/api/v1`;
/** Absolute MCP endpoint for display (API may be a same-origin relative path on web). */
export const MCP_URL = (API.startsWith('/') && typeof location !== 'undefined' ? location.origin : '') + API.replace('/api/v1', '/mcp');

let token = null;
export const setToken = (t) => { token = t; };
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, body) {
    const first = body?.error?.details?.[0];
    super(first?.message ? `${first.path ? first.path + ': ' : ''}${first.message}` : body?.error?.message ?? `Request failed (${status})`);
    this.status = status; this.code = body?.error?.code; this.details = body?.error?.details;
  }
}

async function request(method, path, data) {
  const qs = (method === 'GET' || method === 'DELETE') && data ? '?' + new URLSearchParams(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])) : '';
  let res;
  try {
    res = await fetch(`${API}${path}${qs}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: method !== 'GET' && method !== 'DELETE' && data ? JSON.stringify(data) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { message: `Can't reach the SportArena server at ${API}` } });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, body);
  }
  return body;
}

export const api = {
  get: (p, q) => request('GET', p, q),
  post: (p, b) => request('POST', p, b ?? {}),
  patch: (p, b) => request('PATCH', p, b ?? {}),
  del: (p, q) => request('DELETE', p, q),
};
export { storage };
