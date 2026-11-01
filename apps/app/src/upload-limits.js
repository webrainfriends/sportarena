// One document size limit for every upload field, set by the platform admin (Platform > Uploads) and read from the API (GET /upload-limits).
// The server is the authority and enforces it again; the apps use the same number to fail early and to say it in every hint.
import { useEffect, useState } from 'react';
import { api } from './api';

const FALLBACK = { document_max_mb: 10, min_mb: 1, max_mb: 50 };
let limits = FALLBACK;
const listeners = new Set();

/** Largest size of one document, in MB, as the platform admin set it. */
export const docMaxMb = () => limits.document_max_mb;
export const docMaxBytes = () => limits.document_max_mb * 2 ** 20;
export const docLimitRange = () => ({ min: limits.min_mb, max: limits.max_mb });

export async function loadUploadLimits() {
  try {
    const r = await api.get('/upload-limits');
    if (r && Number.isFinite(r.document_max_mb)) { limits = r; listeners.forEach((f) => f(limits)); }
  } catch { /* keep the last known value; the server still enforces the real one */ }
  return limits;
}
export const setKnownUploadLimits = (r) => { limits = { ...limits, ...r }; listeners.forEach((f) => f(limits)); };

/** Re-renders the screen when the limit is loaded or changed. */
export function useUploadLimit() {
  const [v, setV] = useState(limits);
  useEffect(() => { listeners.add(setV); setV(limits); return () => { listeners.delete(setV); }; }, []);
  return v;
}
