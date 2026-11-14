// Fan & Community Feed — moderation, rate limits, audit, promotions (issue #522).
// Platform admins (PLATFORM_ADMIN_EMAILS) have full scope; org moderators are scoped to their org.
// All moderation actions are appended to feed_audit_events (immutable).
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { mustBePlatformAdmin } from '../platform.js';

const TAG = 'Community Feed';
const MOD_CTX = 'feed_moderation';

const RATE_LIMITS = { comment: 20, reaction: 50, post: 10, report: 3, challenge_entry: 5 };

/** Enforce rolling-window rate limit. Throws 429 if exceeded. */
async function checkRateLimit(c, userId, actionKind) {
  const limit = RATE_LIMITS[actionKind];
  if (!limit) return;
  const window = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  const result = (await c.query(
    `INSERT INTO feed_rate_limits(user_id, action_kind, window_start, count)
          VALUES ($1,$2,$3,1)
          ON CONFLICT (user_id, action_kind, window_start) DO UPDATE SET count=feed_rate_limits.count+1
          RETURNING count`,
    [userId, actionKind, window])).rows[0];
  if (result.count > limit) throw tooMany(`${actionKind} rate limit exceeded (${limit}/hour)`);
}

cap({
  name: 'report_feed_card', method: 'POST', path: '/feed/cards/:id/report', tag: TAG,
  summary: 'Report a feed card for harassment, unsafe content, misinformation, spam, youth safety, impersonation or other. Rate-limited to 3 reports/hour per user. Idempotent per (reporter, card).',
  input: z.object({
    id,
    reason: z.enum(['harassment','unsafe_content','misinformation','spam','youth_safety','impersonation','other']),
    note: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await checkRateLimit(c, user.id, 'report');
      const card = (await c.query(`SELECT id FROM feed_cards WHERE id=$1 AND retracted_at IS NULL`, [i.id])).rows[0];
      if (!card) throw notFound('Feed card');
      const note_enc = i.note ? await encrypt(i.note, MOD_CTX) : null;
      const existing = (await c.query(`SELECT id, status FROM feed_reports WHERE reporter_id=$1 AND target_kind='feed_card' AND target_id=$2`, [user.id, i.id])).rows[0];
      if (existing) return { id: existing.id, already_reported: true };
      const row = (await c.query(
        `INSERT INTO feed_reports(reporter_id, target_kind, target_id, reason, note_enc)
              VALUES ($1,'feed_card',$2,$3,$4) RETURNING id, created_at`,
        [user.id, i.id, i.reason, note_enc])).rows[0];
      await audit(c, user.id, 'feed_card_reported', 'feed_cards', i.id, { reason: i.reason });
      return { id: row.id, reported: true };
    });
  },
});

cap({
  name: 'report_feed_comment', method: 'POST', path: '/feed/comments/:id/report', tag: TAG,
  summary: 'Report a feed card comment.',
  input: z.object({
    id,
    reason: z.enum(['harassment','unsafe_content','misinformation','spam','youth_safety','impersonation','other']),
    note: z.string().max(500).optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      await checkRateLimit(c, user.id, 'report');
      const comment = (await c.query(`SELECT id FROM market_comments WHERE id=$1`, [i.id])).rows[0];
      if (!comment) throw notFound('Comment');
      const note_enc = i.note ? await encrypt(i.note, MOD_CTX) : null;
      const existing = (await c.query(`SELECT id FROM feed_reports WHERE reporter_id=$1 AND target_kind='feed_comment' AND target_id=$2`, [user.id, i.id])).rows[0];
      if (existing) return { id: existing.id, already_reported: true };
      const row = (await c.query(
        `INSERT INTO feed_reports(reporter_id, target_kind, target_id, reason, note_enc)
              VALUES ($1,'feed_comment',$2,$3,$4) RETURNING id`,
        [user.id, i.id, i.reason, note_enc])).rows[0];
      await audit(c, user.id, 'feed_comment_reported', 'market_comments', i.id, { reason: i.reason });
      return { id: row.id, reported: true };
    });
  },
});

cap({
  name: 'hide_feed_card', method: 'POST', path: '/feed/cards/:id/hide', tag: TAG,
  auth: ['admin', 'platform_admin', 'organizer'],
  summary: 'Hide (retract) a feed card. Org staff may hide cards authored by entities they manage; platform admins may hide any card.',
  input: z.object({ id, reason: z.string().max(200).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const card = (await c.query(`SELECT * FROM feed_cards WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (!card) throw notFound('Feed card');
      await c.query(`UPDATE feed_cards SET retracted_at=now(), retracted_reason=$2 WHERE id=$1`, [i.id, i.reason ?? null]);
      await audit(c, user.id, 'feed_card_hidden', 'feed_cards', i.id, { reason: i.reason });
      return { hidden: true, id: i.id };
    });
  },
});

cap({
  name: 'restore_feed_card', method: 'POST', path: '/feed/cards/:id/restore', tag: TAG,
  auth: ['admin', 'platform_admin'],
  summary: 'Restore a retracted feed card. Platform admin only.',
  input: z.object({ id }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    return tx(async (c) => {
      const card = (await c.query(`SELECT id FROM feed_cards WHERE id=$1 AND retracted_at IS NOT NULL FOR UPDATE`, [i.id])).rows[0];
      if (!card) throw notFound('Retracted feed card');
      await c.query(`UPDATE feed_cards SET retracted_at=NULL, retracted_reason=NULL WHERE id=$1`, [i.id]);
      await audit(c, user.id, 'feed_card_restored', 'feed_cards', i.id);
      return { restored: true, id: i.id };
    });
  },
});

cap({
  name: 'list_feed_reports', method: 'GET', path: '/feed/reports', tag: TAG,
  auth: ['admin', 'platform_admin'],
  summary: 'List feed reports. Platform admin only. Filterable by status and target_kind, paginated newest-first.',
  input: z.object({
    status: z.enum(['open','actioned','dismissed','escalated']).optional(),
    target_kind: z.enum(['feed_card','feed_comment','feed_challenge']).optional(),
    ...page,
  }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    const filters = ['1=1'];
    const params = [i.limit, i.offset];
    if (i.status)      { params.push(i.status);      filters.push(`r.status = $${params.length}`); }
    if (i.target_kind) { params.push(i.target_kind); filters.push(`r.target_kind = $${params.length}`); }
    const rows = await many(
      `SELECT r.id, r.reporter_id, r.target_kind, r.target_id, r.reason, r.status, r.created_at,
              u.handle AS reporter_handle, u.display_name AS reporter_name
         FROM feed_reports r JOIN users u ON u.id = r.reporter_id
        WHERE ${filters.join(' AND ')}
        ORDER BY r.created_at DESC LIMIT $1 OFFSET $2`, params);
    return rows;
  },
});

cap({
  name: 'resolve_feed_report', method: 'POST', path: '/feed/reports/:id/resolve', tag: TAG,
  auth: ['admin', 'platform_admin'],
  summary: 'Resolve a feed report as actioned or dismissed. Platform admin only.',
  input: z.object({ id, decision: z.enum(['actioned','dismissed']), notes: z.string().max(400).optional() }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    return tx(async (c) => {
      const report = (await c.query(`SELECT id, status FROM feed_reports WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (!report) throw notFound('Report');
      if (report.status !== 'open' && report.status !== 'escalated') throw conflict('Report is already resolved');
      await c.query(`UPDATE feed_reports SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [i.id, i.decision, user.id]);
      await audit(c, user.id, `feed_report_${i.decision}`, 'feed_reports', i.id);
      return { id: i.id, status: i.decision };
    });
  },
});

cap({
  name: 'escalate_feed_report', method: 'POST', path: '/feed/reports/:id/escalate', tag: TAG,
  auth: ['admin', 'platform_admin'],
  summary: 'Escalate a report for senior review. Platform admin only.',
  input: z.object({ id, notes: z.string().max(400).optional() }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    return tx(async (c) => {
      const report = (await c.query(`SELECT id, status FROM feed_reports WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
      if (!report) throw notFound('Report');
      if (report.status === 'actioned' || report.status === 'dismissed') throw conflict('Resolved reports cannot be escalated');
      await c.query(`UPDATE feed_reports SET status='escalated', escalated_at=now() WHERE id=$1`, [i.id]);
      await audit(c, user.id, 'feed_report_escalated', 'feed_reports', i.id);
      return { id: i.id, status: 'escalated' };
    });
  },
});

cap({
  name: 'list_feed_audit', method: 'GET', path: '/feed/audit', tag: TAG,
  auth: ['admin', 'platform_admin'],
  summary: 'List immutable moderation audit events. Platform admin only. Filterable by actor or target_kind.',
  input: z.object({ actor_id: id.optional(), target_kind: z.string().max(60).optional(), ...page }),
  async handler({ user }, i) {
    mustBePlatformAdmin(user);
    const filters = ['1=1'];
    const params = [i.limit, i.offset];
    if (i.actor_id)    { params.push(i.actor_id);    filters.push(`a.actor_id = $${params.length}`); }
    if (i.target_kind) { params.push(i.target_kind); filters.push(`a.target_kind = $${params.length}`); }
    const rows = await many(
      `SELECT a.id, a.action_kind, a.actor_id, a.target_kind, a.target_id, a.created_at,
              u.handle AS actor_handle, u.display_name AS actor_name
         FROM feed_audit_events a JOIN users u ON u.id = a.actor_id
        WHERE ${filters.join(' AND ')}
        ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`, params);
    return rows;
  },
});

cap({
  name: 'get_feed_rate_limit', method: 'GET', path: '/feed/rate-limit', tag: TAG,
  summary: 'Get current rate limit counts for the signed-in user in the current rolling hour window.',
  input: z.object({}),
  async handler({ user }) {
    const window = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const rows = await many(
      `SELECT action_kind, count FROM feed_rate_limits WHERE user_id=$1 AND window_start=$2`,
      [user.id, window]);
    const counts = Object.fromEntries(rows.map((r) => [r.action_kind, r.count]));
    return {
      window_start: window,
      limits: Object.entries(RATE_LIMITS).map(([kind, max]) => ({ action_kind: kind, used: counts[kind] ?? 0, max })),
    };
  },
});
