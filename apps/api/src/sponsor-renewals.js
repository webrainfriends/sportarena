// Term expiry, final settlement and explicit renewals (#299). The END DATE of an agreement and the SETTLEMENT of what is owed under it are two
// facts: the worker moves an agreement to `term_expired` when its last day (in the agreement's own timezone) has passed, and to `completed` only
// when every due is fulfilled or cancelled. Passing the date never marks a due paid, cancels it or waives it. A renewal is never silent: it is a
// NEW agreement (a linked successor, `renews_id`) that goes through the normal offer / exact-version acceptance flow.
import { pool, tx } from './db.js';
import { logHistory, completeIfSettled } from './sponsor-agreements.js';
import { closePauseOnEnd, pingParties } from './sponsor-pause.js';

export const RENEWAL_WINDOW_DAYS = 90;
export const RENEWAL_INTENTS = ['renew', 'renegotiate', 'not_renew'];
export const RENEWABLE = ['active', 'term_expired', 'completed'];
const MILESTONES = [[7, 'd7'], [30, 'd30'], [60, 'd60']];

/** The agreement's own "today": an unknown or missing timezone name falls back to UTC instead of failing the whole sweep. */
export const localToday = (a = 's') => `(now() AT TIME ZONE (CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = ${a}.timezone) THEN ${a}.timezone ELSE 'UTC' END))::date`;
const LOCAL_TODAY = localToday();
const LIVE_SUCCESSOR = `EXISTS (SELECT 1 FROM sponsorships n WHERE n.renews_id = s.id AND n.status NOT IN ('declined','withdrawn'))`;

/** Dues still open under an agreement, with per-currency money; currencies are never combined. */
export async function openDues(q, sponsorshipId) {
  const dues = (await q.query("SELECT count(*)::int AS n FROM sponsorship_obligations WHERE sponsorship_id=$1 AND status='scheduled'", [sponsorshipId])).rows[0].n;
  const money = await q.query("SELECT currency, sum(amount_cents)::bigint AS cents FROM sponsorship_obligations WHERE sponsorship_id=$1 AND status='scheduled' AND kind='money' GROUP BY currency ORDER BY currency", [sponsorshipId]);
  return { open_dues: dues, open_cents: Object.fromEntries(money.rows.map((r) => [r.currency, Number(r.cents)])) };
}

/** What the agreement screen shows about expiry, settlement, both sides' renewal plans and the linked agreements. */
export async function renewalView(q, d) {
  const one = async (sql, p) => (await q.query(sql, p)).rows[0] ?? null;
  const assessments = (await q.query(
    `SELECT a.side, a.intent, a.note, a.decided_at, u.display_name AS decided_by FROM sponsorship_renewal_assessments a JOIN users u ON u.id=a.decided_by WHERE a.sponsorship_id=$1 ORDER BY a.side`, [d.id])).rows;
  const successor = await one(
    "SELECT id, agreement_ref, status, terms_version, accepted_version, terms_side, starts_on::text AS starts_on, ends_on::text AS ends_on FROM sponsorships WHERE renews_id=$1 AND status NOT IN ('declined','withdrawn')", [d.id]);
  const predecessor = d.renews_id ? await one('SELECT id, agreement_ref, status, ends_on::text AS ends_on FROM sponsorships WHERE id=$1', [d.renews_id]) : null;
  const t = await one(`SELECT (s.ends_on - ${LOCAL_TODAY})::int AS days_left FROM sponsorships s WHERE s.id=$1`, [d.id]);
  const open = d.accepted_version ? await openDues(q, d.id) : { open_dues: 0, open_cents: {} };
  const days = d.ends_on ? t.days_left : null;
  const inWindow = d.status === 'active' ? days != null && days <= RENEWAL_WINDOW_DAYS : ['term_expired', 'completed'].includes(d.status);
  return {
    renewal_rev: d.renewal_rev, window_days: RENEWAL_WINDOW_DAYS, days_left: days,
    // the term and its settlement are separate: an expired term can still have dues that are owed
    settlement: ['term_expired', 'completed'].includes(d.status) ? { state: d.status, term_expired_at: d.term_expired_at, settled_at: d.settled_at, ...open } : null,
    can_renew: !!d.accepted_version && !!d.ends_on && RENEWABLE.includes(d.status) && inWindow && !successor,
    assessments, successor, predecessor, opened_by_side: d.renews_id ? await proposerSide(q, d) : null,
  };
}

/** Which side wrote the opening terms of a renewal: that side may withdraw it, the other side may decline it. */
export async function proposerSide(c, d) {
  return (await c.query('SELECT authored_side FROM sponsorship_versions WHERE sponsorship_id=$1 AND version=1', [d.id])).rows[0]?.authored_side ?? 'sponsor';
}

/** Both parties hear about it, with no terms or amounts in the message. */
async function notice(c, d, milestone, title) {
  const r = await c.query('INSERT INTO sponsorship_renewal_notices(sponsorship_id, milestone) VALUES ($1,$2) ON CONFLICT DO NOTHING', [d.id, milestone]);
  if (r.rowCount) await pingParties(c, d, title);
  return r.rowCount;
}

/** Worker: an accepted agreement whose last day has passed (in its own timezone) leaves `active`. Safe to repeat and safe on two workers. */
export async function expireAgreementTerms() {
  const due = (await pool.query(`SELECT s.id FROM sponsorships s WHERE s.status='active' AND s.accepted_version IS NOT NULL AND s.ends_on < ${LOCAL_TODAY} ORDER BY s.ends_on, s.id`)).rows;
  let n = 0;
  for (const x of due) {
    n += await tx(async (c) => {
      const d = (await c.query(`SELECT s.* FROM sponsorships s WHERE s.id=$1 AND s.status='active' AND s.ends_on < ${LOCAL_TODAY} FOR UPDATE`, [x.id])).rows[0];
      if (!d) return 0;
      const { open_dues: open } = await openDues(c, d.id);
      await c.query('UPDATE sponsorships SET status=$2, term_expired_at=now(), settled_at=CASE WHEN $2=\'completed\' THEN now() END, renewal_rev=renewal_rev+1 WHERE id=$1', [d.id, open ? 'term_expired' : 'completed']);
      await closePauseOnEnd(c, d.id); // a pause that never started is closed; a due is never touched by the date
      await logHistory(c, d.id, d.accepted_version, null, open ? 'term_expired' : 'completed', open ? `${open} due${open === 1 ? '' : 's'} still open` : 'every due settled');
      await notice(c, d, 'expired', open ? 'A sponsorship term has ended; some dues are still open' : 'A sponsorship has been completed');
      return 1;
    });
  }
  return n;
}

/** Worker: an expired term whose last open due has since been settled becomes completed, and both sides are told once. */
export async function settleExpiredAgreements() {
  const rows = (await pool.query("SELECT id FROM sponsorships WHERE status='term_expired' ORDER BY term_expired_at, id")).rows;
  let n = 0;
  for (const x of rows) {
    n += await tx(async (c) => {
      const d = (await c.query("SELECT * FROM sponsorships WHERE id=$1 AND status='term_expired' FOR UPDATE", [x.id])).rows[0];
      return d && await completeIfSettled(c, d.id) ? 1 : 0;
    });
  }
  // a term that expired with dues open and was settled later: tell both sides once (one that completed at expiry was told by the expiry notice)
  const told = (await pool.query(
    "SELECT s.* FROM sponsorships s WHERE s.status='completed' AND s.settled_at > s.term_expired_at AND NOT EXISTS (SELECT 1 FROM sponsorship_renewal_notices t WHERE t.sponsorship_id=s.id AND t.milestone='settled') ORDER BY s.id")).rows;
  for (const d of told) await tx((c) => notice(c, d, 'settled', 'A sponsorship is fully settled'));
  return n;
}

/** Worker: remind both sides at 60, 30 and 7 days before the term ends that nothing renews by itself. Each reminder is sent once. */
export async function sendRenewalNotices() {
  const rows = (await pool.query(
    `SELECT s.id, (s.ends_on - ${LOCAL_TODAY})::int AS days FROM sponsorships s
      WHERE s.status='active' AND s.accepted_version IS NOT NULL AND s.ends_on IS NOT NULL AND s.ends_on >= ${LOCAL_TODAY} AND s.ends_on - ${LOCAL_TODAY} <= 60 AND NOT ${LIVE_SUCCESSOR}
      ORDER BY s.ends_on, s.id`)).rows;
  let n = 0;
  for (const x of rows) {
    const milestone = MILESTONES.find(([days]) => x.days <= days)[1];
    n += await tx(async (c) => {
      const d = (await c.query("SELECT * FROM sponsorships WHERE id=$1 AND status='active' FOR UPDATE", [x.id])).rows[0];
      return d ? notice(c, d, milestone, `A sponsorship ends in ${milestone.slice(1)} days or fewer. It will not renew unless you both agree`) : 0;
    });
  }
  return n;
}

/** The three scheduled steps in order, as one worker step. */
export async function processSponsorshipTerms() {
  return (await expireAgreementTerms()) + (await settleExpiredAgreements()) + (await sendRenewalNotices());
}
