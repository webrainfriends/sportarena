// Platform admin: all user accounts with login ID, storage, AI token usage, API usage, last login.
// Accessible only to platform admins (mustBePlatformAdmin). Emails are decrypted here and audit-logged.
import { z } from 'zod';
import { cap, page } from '../registry.js';
import { many, one } from '../db.js';
import { mustBePlatformAdmin } from '../platform.js';
import { decrypt, blindIndex } from '../crypto.js';
import { audit } from '../helpers.js';

const TAG = 'Platform admin';

// Storage: aggregate size_bytes from every table that tracks uploads against a user.
// Grouped in a single CTE so the page query is one round-trip.
const STORAGE_CTE = `
  SELECT user_id, SUM(bytes)::bigint AS storage_bytes, SUM(cnt)::bigint AS doc_count FROM (
    SELECT uploaded_by AS user_id, SUM(size_bytes) AS bytes, COUNT(*)::bigint AS cnt
      FROM venue_media WHERE size_bytes IS NOT NULL GROUP BY uploaded_by
    UNION ALL
    SELECT uploaded_by, SUM(size_bytes), COUNT(*) FROM insurance_documents WHERE size_bytes IS NOT NULL GROUP BY uploaded_by
    UNION ALL
    SELECT uploaded_by, SUM(size_bytes), COUNT(*) FROM subject_documents WHERE size_bytes IS NOT NULL GROUP BY uploaded_by
    UNION ALL
    SELECT uploaded_by, SUM(size_bytes), COUNT(*) FROM event_staff_documents WHERE size_bytes IS NOT NULL GROUP BY uploaded_by
    UNION ALL
    SELECT uploaded_by, SUM(size_bytes), COUNT(*) FROM coaching_evidence WHERE size_bytes IS NOT NULL GROUP BY uploaded_by
    UNION ALL
    SELECT uploader_id, SUM(size_bytes), COUNT(*) FROM team_chat_media WHERE size_bytes IS NOT NULL GROUP BY uploader_id
    UNION ALL
    SELECT user_id, SUM(size_bytes), COUNT(*) FROM passport_videos WHERE size_bytes IS NOT NULL GROUP BY user_id
    UNION ALL
    SELECT added_by, SUM(size_bytes), COUNT(*) FROM verification_evidence WHERE size_bytes IS NOT NULL AND added_by IS NOT NULL GROUP BY added_by
  ) sub GROUP BY user_id`;

function fmtUser(r) {
  return {
    id: r.id, handle: r.handle, email: r.email,
    display_name: r.display_name, roles: r.roles,
    avatar_emoji: r.avatar_emoji, avatar_color: r.avatar_color,
    created_at: r.created_at, last_login_at: r.last_login_at ?? null,
    storage_bytes: Number(r.storage_bytes ?? 0),
    doc_count: Number(r.doc_count ?? 0),
    ai_tokens_30d: Number(r.ai_tokens_30d ?? 0),
    api_calls_30d: Number(r.api_calls_30d ?? 0),
  };
}

cap({
  name: 'list_all_users', method: 'GET', path: '/admin/users', tag: TAG, auth: ['admin'],
  summary: 'Platform admin: all user accounts with their handle, decrypted email, roles, last login date/time, cumulative storage bytes, AI token usage (last 30 days) and API call count (last 30 days). Emails are audit-logged on each call. Paginated; default 50 per page.',
  input: z.object({
    ...page,
    limit: z.coerce.number().int().min(1).max(200).default(50),
    sort: z.enum(['last_login', 'storage', 'ai_tokens', 'api_calls', 'created']).default('last_login'),
    order: z.enum(['asc', 'desc']).default('desc'),
    search: z.string().max(80).optional(),
    role: z.string().max(40).optional(),
  }),
  async handler({ user }, i) {
    await mustBePlatformAdmin(user);

    const ORDER = {
      last_login: 'last_login_at',
      storage: 'storage_bytes',
      ai_tokens: 'ai_tokens_30d',
      api_calls: 'api_calls_30d',
      created: 'u.created_at',
    };
    const col = ORDER[i.sort];
    const dir = i.order === 'asc' ? 'ASC' : 'DESC';
    const nulls = i.order === 'desc' ? 'NULLS LAST' : 'NULLS FIRST';

    const wheres = ["u.id IS NOT NULL"];
    const params = [];
    const p = () => `$${params.length}`;

    if (i.search) {
      params.push(`%${i.search.toLowerCase()}%`);
      wheres.push(`(lower(u.handle) LIKE ${p()} OR u.email_idx = $${params.push(blindIndex(i.search)) - 1 + 1})`);
    }
    // role filter via postgres array contains
    if (i.role) { params.push(i.role); wheres.push(`u.roles @> ARRAY[${p()}]::text[]`); }

    const where = wheres.join(' AND ');
    const offsetVal = i.offset ?? 0;
    params.push(i.limit, offsetVal);
    const limitP = `$${params.length - 1}`;
    const offsetP = `$${params.length}`;

    const rows = await many(
      `WITH storage AS (${STORAGE_CTE}),
            ai AS (SELECT user_id, SUM(tokens_in + tokens_out)::bigint AS ai_tokens FROM ai_token_usage WHERE at >= CURRENT_DATE - 30 GROUP BY user_id),
            apicalls AS (SELECT user_id, SUM(call_count)::bigint AS api_calls FROM user_daily_api_calls WHERE date >= CURRENT_DATE - 30 GROUP BY user_id),
            ll AS (SELECT user_id, MAX(created_at) AS last_login_at FROM auth_sessions GROUP BY user_id)
       SELECT u.id, u.handle, u.display_name, u.roles, u.email_enc, u.avatar_emoji, u.avatar_color, u.created_at,
              ll.last_login_at,
              COALESCE(s.storage_bytes, 0) AS storage_bytes, COALESCE(s.doc_count, 0) AS doc_count,
              COALESCE(ai.ai_tokens, 0) AS ai_tokens_30d, COALESCE(apicalls.api_calls, 0) AS api_calls_30d
         FROM users u
         LEFT JOIN storage s ON s.user_id = u.id
         LEFT JOIN ai ON ai.user_id = u.id
         LEFT JOIN apicalls ON apicalls.user_id = u.id
         LEFT JOIN ll ON ll.user_id = u.id
        WHERE ${where}
        ORDER BY ${col} ${dir} ${nulls}, u.handle
        LIMIT ${limitP} OFFSET ${offsetP}`,
      params,
    );

    // Decrypt emails and audit the bulk read
    const users = rows.map((r) => ({ ...r, email: r.email_enc ? decrypt(r.email_enc, 'users.email') : null }));
    await audit(null, user.id, 'list_all_users', 'users', null);

    // Platform-wide totals (lightweight aggregate, computed once per page load)
    const totals = await one(
      `SELECT COUNT(*)::int AS total_users,
              COUNT(DISTINCT CASE WHEN s.created_at >= now() - interval '7 days' THEN s.user_id END)::int AS active_7d,
              COUNT(DISTINCT CASE WHEN u.created_at >= now() - interval '7 days' THEN u.id END)::int AS new_7d
         FROM users u LEFT JOIN auth_sessions s ON s.user_id = u.id`,
    );
    const usageTotals = await one(
      `SELECT COALESCE(SUM(a.tokens_in + a.tokens_out), 0)::bigint AS total_ai_tokens_30d,
              COALESCE(SUM(c.call_count), 0)::bigint AS total_api_calls_30d
         FROM (SELECT 1) x
         LEFT JOIN (SELECT SUM(tokens_in + tokens_out) AS tokens_in FROM ai_token_usage WHERE at >= CURRENT_DATE - 30) a ON true
         LEFT JOIN (SELECT SUM(call_count) FROM user_daily_api_calls WHERE date >= CURRENT_DATE - 30) c(call_count) ON true`,
    );

    return {
      users: users.map(fmtUser),
      meta: {
        total_users: totals.total_users,
        active_7d: totals.active_7d,
        new_7d: totals.new_7d,
        total_ai_tokens_30d: Number(usageTotals.total_ai_tokens_30d),
        total_api_calls_30d: Number(usageTotals.total_api_calls_30d),
        offset: offsetVal,
        limit: i.limit,
      },
    };
  },
});
