// The money side of a coaching series: refunding one date's share and keeping the series totals true.
//  - per-date payment: each hire has its own payment, refunded in full when that date is cancelled (as before);
//  - pay-once: one payment covers the block (raised on the anchor hire); a cancelled date gets back exactly its own share.
import { one, many } from './db.js';
import { refundFor, refundPartial } from './payments/service.js';
import { refundKey, setTransitionContext } from './lifecycle.js';
import { restoreForPurpose } from './rewards/redeem.js';
import { conflict } from './errors.js';

/** What this date was actually charged: its share of the block price, less any loyalty credit applied to it. */
export const netOf = (h) => Number(h.total_cents) - Number(h.loyalty_credit_cents ?? 0);

/** The live (still to be delivered) dates of a series: not cancelled, expired or completed, and not yet started. */
export const upcomingSql = "status IN ('requested','confirmed') AND starts_at > now()";

/**
 * Give back a paid date. Returns the amount refunded (0 if it was not paid). Idempotent per hire: the provider key is stable,
 * so a retry after a crash cannot refund twice. If the provider refuses this throws and the caller's transaction rolls back.
 */
export async function refundHire(h) {
  if (h.payment_status !== 'paid') return 0;
  const key = refundKey('coach_hire', h.id);
  const s = h.series_id ? await one('SELECT pay_mode, payment_id FROM coach_series WHERE id=$1', [h.series_id]) : null;
  if (s?.pay_mode === 'once' && s.payment_id) {
    const pay = await one('SELECT * FROM payments WHERE id=$1', [s.payment_id]);
    return pay ? refundPartial(pay, netOf(h), key) : 0;
  }
  await refundFor('coach_hire', h.id, { key });
  return netOf(h);
}

/** Keep the series header true after a date drops out: totals of what is still owed, who a pay-once checkout hangs on, and its status. */
export async function resyncSeries(c, seriesId) {
  const s = (await c.query('SELECT * FROM coach_series WHERE id=$1 FOR UPDATE', [seriesId])).rows[0];
  if (!s) return;
  const t = (await c.query("SELECT coalesce(sum(list_cents) FILTER (WHERE status NOT IN ('cancelled','expired')), 0)::bigint AS list, coalesce(sum(total_cents) FILTER (WHERE status NOT IN ('cancelled','expired')), 0)::bigint AS total, count(*) FILTER (WHERE status IN ('requested','confirmed'))::int AS open, count(*) FILTER (WHERE status = 'completed')::int AS done FROM coach_hires WHERE series_id=$1", [seriesId])).rows[0];
  const anchor = s.payment_id ? s.anchor_hire_id : (await c.query("SELECT id FROM coach_hires WHERE series_id=$1 AND status IN ('requested','confirmed') AND series_state IS DISTINCT FROM 'paused' ORDER BY starts_at, id LIMIT 1", [seriesId])).rows[0]?.id ?? null;
  const held = (await c.query("SELECT 1 FROM coach_hires WHERE series_id=$1 AND series_state='paused' AND status IN ('requested','confirmed') LIMIT 1", [seriesId])).rowCount > 0;
  const status = s.status === 'cancelled' ? 'cancelled' : t.open === 0 ? (t.done > 0 ? 'completed' : 'cancelled') : held ? 'paused' : 'active';
  await c.query('UPDATE coach_series SET list_total_cents=$2, total_cents=$3, discount_cents=$2::bigint - $3::bigint, anchor_hire_id=$4, status=$5, paused_at=CASE WHEN $5=\'paused\' THEN coalesce(paused_at, now()) ELSE NULL END, cancelled_at=CASE WHEN $5=\'cancelled\' THEN coalesce(cancelled_at, now()) ELSE cancelled_at END, updated_at=now() WHERE id=$1', [seriesId, t.list, t.total, anchor, status]);
}

/**
 * Cancel one future date of a series inside the caller's transaction: refund its share, free its loyalty credit and court, and mark why.
 * `how` is 'skipped' (the series carries on) or 'cancelled' (the whole remainder is being cancelled). Returns the amount refunded.
 */
export async function cancelDate(c, actorId, hireId, { reason, how = 'skipped' } = {}) {
  const h = (await c.query('SELECT * FROM coach_hires WHERE id=$1 FOR UPDATE', [hireId])).rows[0];
  if (!h || !['requested', 'confirmed'].includes(h.status)) throw conflict('That date can no longer be changed');
  if (new Date(h.starts_at) <= new Date()) throw conflict('That date has already started');
  await setTransitionContext(c, actorId, reason);
  const refunded = await refundHire(h);
  const out = await c.query("UPDATE coach_hires SET status='cancelled', payment_status=CASE WHEN payment_status='paid' THEN 'refunded' ELSE payment_status END, cancelled_by=$2, series_state=$3 WHERE id=$1 AND status=$4", [h.id, actorId, how === 'skipped' ? 'skipped' : h.series_state, h.status]);
  if (!out.rowCount) throw conflict('This date was just changed by someone else; reload and try again');
  await restoreForPurpose(c, 'coach_hire', h.id, { reason: how === 'skipped' ? 'Coaching date skipped' : 'Coaching series cancelled' });
  await c.query("UPDATE session_venue_links SET released_at=now(), release_reason='session cancelled' WHERE session_type='coach_hire' AND session_id=$1 AND released_at IS NULL", [h.id]);
  return refunded;
}

/** What cancelling these dates would hand back, without touching anything. The same numbers cancelDate refunds. */
export const refundPreview = (hires) => hires.reduce((n, h) => n + (h.payment_status === 'paid' ? netOf(h) : 0), 0);

export const upcomingDates = (seriesId) => many(`SELECT * FROM coach_hires WHERE series_id=$1 AND ${upcomingSql} ORDER BY starts_at, id`, [seriesId]);
