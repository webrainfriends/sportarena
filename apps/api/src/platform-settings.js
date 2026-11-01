// Platform-wide settings controlled by the platform admin. Today: the one size limit every document upload in the system obeys.
// The value is cached in memory (read synchronously by upload handlers) and refreshed on every change and every 30 s, so a change
// reaches every upload field, every route and every process without a restart.
import { many, one, query } from './db.js';

export const DOC_MB = { min: 1, max: 50, default: 10 };
const KEY = 'document_max_mb';
let docMb = DOC_MB.default;

const clamp = (n) => (Number.isFinite(n) ? Math.min(DOC_MB.max, Math.max(DOC_MB.min, Math.round(n))) : DOC_MB.default);

/** The current limit for one document (PDF, photo, Word/Excel, evidence) in bytes. */
export const documentMaxBytes = () => docMb * 2 ** 20;
export const documentMaxMb = () => docMb;

export async function loadPlatformSettings() {
  const rows = await many('SELECT key, value FROM platform_settings');
  const v = rows.find((r) => r.key === KEY)?.value;
  docMb = clamp(Number(v));
  return { document_max_mb: docMb };
}

export async function setDocumentMaxMb(mb, userId) {
  const v = clamp(Number(mb));
  await query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, to_jsonb($2::int), $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [KEY, v, userId]);
  docMb = v;
  return v;
}

export async function documentLimitRow() {
  return one('SELECT updated_at, updated_by FROM platform_settings WHERE key = $1', [KEY]);
}

export function startSettingsRefresh() {
  const t = setInterval(() => { loadPlatformSettings().catch(() => {}); }, 30_000);
  t.unref?.();
}

/** Upper bound for a base64 file field in a request schema: the largest allowed document (the ceiling), encoded. The handlers enforce the live limit. */
export const B64_MAX_CHARS = Math.ceil(DOC_MB.max * 2 ** 20 * 4 / 3) + 1024;
