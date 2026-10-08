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
/** Turn a relative media path from the API (/api/v1/media/…) into a loadable URL; absolute links pass through. */
export const mediaUrl = (u) => (!u ? null : /^https?:/.test(u) ? u : `${API.replace(/\/api\/v1$/, '')}${u}`);
/** Absolute MCP endpoint for display (API may be a same-origin relative path on web). */
export const MCP_URL = (API.startsWith('/') && typeof location !== 'undefined' ? location.origin : '') + API.replace('/api/v1', '/mcp');

let token = null;
export const setToken = (t) => { token = t; };
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, body) {
    const first = body?.error?.details?.[0];
    const nice = (path) => String(path).split('.').filter((x) => !/^\d+$/.test(x)).join(' › ').replace(/_(cents|bp)$/, '').replace(/_/g, ' ');
    const plain = (m) => (/expected (number|int)/i.test(m) ? 'enter a number' : /received undefined|required/i.test(m) ? 'is required' : /^invalid input$/i.test(m) ? 'is not valid' : m);
    const all = (body?.error?.details ?? []).filter((d) => d?.message).map((d) => `${d.path ? `${nice(d.path)}: ` : ''}${plain(d.message)}`);
    super(all.length ? [...new Set(all)].join('; ') : body?.error?.message ?? `Request failed (${status})`);
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

/** Stream a file (Blob) to the API as the raw request body — used for photo/video uploads. */
async function upload(path, blob, query = {}) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString();
  let res;
  try { res = await fetch(`${API}${path}${qs ? `?${qs}` : ''}`, { method: 'PUT', headers: { 'content-type': blob.type || 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: blob }); }
  catch { throw new ApiError(0, { error: { message: `Can't reach the SportArena server at ${API}` } }); }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export const api = {
  get: (p, q) => request('GET', p, q),
  post: (p, b) => request('POST', p, b ?? {}),
  patch: (p, b) => request('PATCH', p, b ?? {}),
  del: (p, q) => request('DELETE', p, q),
  upload,
};
export { storage };
