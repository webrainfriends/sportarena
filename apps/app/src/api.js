// Thin REST client. The app only ever talks to the public API (/api/v1) — same surface agents get over MCP.
import { Platform } from 'react-native';
import { storage } from './storage';

const guess = () => {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  if (Platform.OS === 'web' && typeof location !== 'undefined') return `${location.protocol}//${location.hostname}:4000`;
  return Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';
};
export const API = `${guess().replace(/\/$/, '')}/api/v1`;

let token = null;
export const setToken = (t) => { token = t; };
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, body) {
    const first = body?.error?.details?.[0];
    super(first ? `${first.path ? first.path + ': ' : ''}${first.message}` : body?.error?.message ?? `Request failed (${status})`);
    this.status = status; this.code = body?.error?.code;
  }
}

async function request(method, path, data) {
  const qs = method === 'GET' && data ? '?' + new URLSearchParams(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])) : '';
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
  del: (p) => request('DELETE', p),
};
export { storage };
