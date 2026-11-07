// Venue command centre: one read that tells a venue owner what is happening today, what needs them, what is earning and what is
// available to sell. It composes what already exists (venue_report, venue_operations_overview, readinessBoard, venue_waitlist, the
// asset / maintenance / shift / review / RFQ tables) and adds nothing parallel; the only new storage is the compliance register
// (venue_compliance_items) for licences and permits that had no home. Every section is computed independently, so one failing
// section is reported in `unavailable` and never blanks the page. Insights are deterministic rules over real history, each carrying
// the numbers behind it; with too little history the section is empty rather than invented.
import { z } from 'zod';
import { cap, capabilities, id } from '../registry.js';
import { one, many } from '../db.js';
import { notFound } from '../errors.js';
import { audit, mustFind } from '../helpers.js';
import { encryptFields, decryptFields } from '../crypto.js';
import { mustManage } from '../booking/engine.js';
import { toLocal, fromLocal, addDays } from '../booking/time.js';
import { readinessBoard } from './venue-facility.js';

const TAG = 'Venue command centre';
const day = z.string().date();
export const COMPLIANCE_KINDS = ['licence', 'fire', 'safety', 'pool', 'food', 'accessibility', 'tax', 'permit', 'other'];
const SOON_DAYS = 30;
const round1 = (x) => Math.round(x * 10) / 10;
const sibling = (name) => capabilities.find((c) => c.name === name).handler;
const daysUntil = (date, today) => Math.round((Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);

/** Run one section; a failure is recorded and the section is null, never a 500 for the whole page. */
async function section(unavailable, name, fn) {
  try { return await fn(); } catch (e) { unavailable.push(name); console.error(`venue_command_centre.${name}`, e.message); return null; }
}

const complianceStatus = (days) => (days < 0 ? 'expired' : days <= SOON_DAYS ? 'soon' : 'ok');

async function complianceRegister(venueId, today) {
  const [items, policies, contracts] = await Promise.all([
    many('SELECT id, kind, title, issued_on::text, expires_on::text FROM venue_compliance_items WHERE venue_id=$1 AND archived_at IS NULL ORDER BY expires_on NULLS LAST, title', [venueId]),
    many("SELECT id, ends_on::text AS expires_on FROM insurance_policies WHERE subject_type='venue' AND subject_id=$1 AND status='active' ORDER BY ends_on", [venueId]),
    many("SELECT id, title, ends_on::text AS expires_on FROM venue_contracts WHERE venue_id=$1 AND status='active' AND ends_on IS NOT NULL ORDER BY ends_on", [venueId]),
  ]);
  const rows = [
    ...items.map((x) => ({ source: 'compliance', id: x.id, kind: x.kind, title: x.title, expires_on: x.expires_on })),
    ...policies.map((x) => ({ source: 'insurance', id: x.id, kind: 'insurance', title: null, expires_on: x.expires_on })),
    ...contracts.map((x) => ({ source: 'contract', id: x.id, kind: 'contract', title: x.title, expires_on: x.expires_on })),
  ].map((x) => (x.expires_on ? { ...x, days_left: daysUntil(x.expires_on, today), status: complianceStatus(daysUntil(x.expires_on, today)) } : { ...x, days_left: null, status: 'ok' }));
  rows.sort((a, b) => (a.days_left ?? 1e9) - (b.days_left ?? 1e9));
  return { items: rows, expired: rows.filter((r) => r.status === 'expired').length, expiring_soon: rows.filter((r) => r.status === 'soon').length, has_insurance: policies.length > 0 };
}

cap({
  name: 'venue_command_centre', method: 'GET', path: '/venues/:id/command-centre', tag: TAG,
  summary: 'The venue owner\'s home in one read (venue team managers only): today at the venue (bookings, revenue, next booking), headline numbers, a severity-ranked attention list with the action for each, live state of every area (occupied until, available, maintenance, event), a 7-day occupancy picture with peak window and quiet slots, revenue (today, month to date, projected month end, outstanding, refunds, per area), upcoming events with a readiness checklist, unserved demand, supplier RFQ counts, asset and maintenance health, staff on duty, customer experience, a compliance register with expiry warnings, and rule-based insights. Sections that cannot be computed are listed in `unavailable`. Money is in the venue currency, minor units; projections are labelled as such.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const venue = await mustFind('venues', i.id);
    const tz = venue.timezone;
    const now = new Date();
    const today = toLocal(now, tz).date;
    const [dayStart, dayEnd] = [fromLocal(today, 0, tz), fromLocal(addDays(today, 1), 0, tz)];
    const monthStart = `${today.slice(0, 8)}01`;
    const report = sibling('venue_report');
    const rep = (from, to, group_by = 'day') => report({ user }, { id: i.id, from, to, group_by });
    const unavailable = [];
    const S = (name, fn) => section(unavailable, name, fn);

    const [repToday, repMonth, rep7, rep28, repPrev28, board] = await Promise.all([
      S('report_today', () => rep(today, today)),
      S('report_month', () => rep(monthStart, today)),
      S('report_week', () => rep(addDays(today, -6), today)),
      S('report_28', () => rep(addDays(today, -27), today, 'week')),
      S('report_prev_28', () => rep(addDays(today, -55), addDays(today, -28), 'week')),
      S('readiness', () => readinessBoard(i.id)),
    ]);

    // ---- today
    const todayBlock = await S('today', async () => {
      const [pos, next, expected] = await Promise.all([
        one("SELECT coalesce(sum(total_cents),0)::int AS cents, count(*)::int AS sales FROM pos_sales WHERE venue_id=$1 AND status='paid' AND created_at >= $2 AND created_at < $3", [i.id, dayStart, dayEnd]),
        one(`SELECT b.starts_at, b.ends_at, r.name AS area FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.status='confirmed' AND b.starts_at > $2 AND b.starts_at < $3 ORDER BY b.starts_at LIMIT 1`, [i.id, now, dayEnd]),
        one("SELECT coalesce(sum(b.quantity),0)::int AS n FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.status='confirmed' AND b.starts_at >= $2 AND b.starts_at < $3", [i.id, dayStart, dayEnd]),
      ]);
      const hours = await one('SELECT opens_min, closes_min FROM venue_hours WHERE venue_id=$1 AND weekday=$2 AND removed_at IS NULL ORDER BY opens_min LIMIT 1', [i.id, toLocal(now, tz).weekday]);
      const mins = toLocal(now, tz).minutes;
      return {
        date: today, timezone: tz, currency: venue.currency,
        status: !hours ? 'closed' : mins >= hours.opens_min && mins < hours.closes_min ? 'open' : 'closed',
        bookings: repToday?.summary.bookings ?? 0, expected_visitors: expected.n,
        revenue_cents: (repToday?.summary.revenue_cents ?? 0) + pos.cents, pos_cents: pos.cents, next_booking: next ?? null,
      };
    });

    // ---- facilities (live)
    let dayHours = null;
    const facilities = await S('facilities', async () => {
      const [areas, busy, blocks, work, upcoming] = await Promise.all([
        many('SELECT id, name, kind, sport_id FROM resources WHERE venue_id=$1 AND active ORDER BY name', [i.id]),
        many("SELECT b.resource_id, b.ends_at, b.event_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.status='confirmed' AND b.starts_at <= $2 AND b.ends_at > $2", [i.id, now]),
        many('SELECT resource_id, ends_at, kind FROM venue_blocks WHERE venue_id=$1 AND released_at IS NULL AND starts_at <= $2 AND ends_at > $2', [i.id, now]),
        many("SELECT DISTINCT resource_id FROM venue_maintenance WHERE venue_id=$1 AND status='in_progress' AND resource_id IS NOT NULL", [i.id]),
        many("SELECT DISTINCT ON (b.resource_id) b.resource_id, b.starts_at FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.status='confirmed' AND b.starts_at > $2 ORDER BY b.resource_id, b.starts_at", [i.id, now]),
      ]);
      const [dayBooks, dayBlocks, hrs] = await Promise.all([
        many("SELECT b.resource_id, b.starts_at, b.ends_at, b.event_id FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.status IN ('confirmed','no_show') AND b.starts_at < $3 AND b.ends_at > $2", [i.id, dayStart, dayEnd]),
        many('SELECT resource_id, starts_at, ends_at, kind FROM venue_blocks WHERE venue_id=$1 AND released_at IS NULL AND starts_at < $3 AND ends_at > $2', [i.id, dayStart, dayEnd]),
        many('SELECT opens_min, closes_min FROM venue_hours WHERE venue_id=$1 AND weekday=$2 AND removed_at IS NULL ORDER BY opens_min', [i.id, toLocal(now, tz).weekday]),
      ]);
      const mins = (at) => Math.max(0, Math.min(1440, Math.round((new Date(at) - dayStart) / 60000)));
      const slotsFor = (rid) => [
        ...dayBooks.filter((x) => x.resource_id === rid).map((x) => ({ from_min: mins(x.starts_at), to_min: mins(x.ends_at), kind: x.event_id ? 'event' : 'booking' })),
        ...dayBlocks.filter((x) => x.resource_id === rid || x.resource_id === null).map((x) => ({ from_min: mins(x.starts_at), to_min: mins(x.ends_at), kind: x.kind === 'maintenance' ? 'maintenance' : 'block' })),
      ].sort((a, b) => a.from_min - b.from_min);
      dayHours = hrs.length ? { open_min: hrs[0].opens_min, close_min: hrs[hrs.length - 1].closes_min } : null;
      return areas.map((a) => {
        const blk = blocks.find((x) => x.resource_id === a.id || x.resource_id === null);
        const bk = busy.find((x) => x.resource_id === a.id);
        const rd = board?.find((x) => x.resource_id === a.id || x.id === a.id);
        const state = work.some((w) => w.resource_id === a.id) || blk?.kind === 'maintenance' ? 'maintenance'
          : bk?.event_id || blk?.kind === 'event' ? 'event' : bk ? 'occupied' : blk ? 'blocked' : 'available';
        return { id: a.id, name: a.name, kind: a.kind, sport_id: a.sport_id, state, until: bk?.ends_at ?? blk?.ends_at ?? null, slots: slotsFor(a.id), next_at: upcoming.find((u) => u.resource_id === a.id)?.starts_at ?? null, readiness: rd?.status ?? null };
      });
    });

    // ---- occupancy + revenue
    const w28 = rep28?.summary;
    const peak = rep28?.by_hour?.length ? [...rep28.by_hour].sort((a, b) => b.bookings - a.bookings)[0] : null;
    const occupancy = rep7 && {
      utilisation: rep7.summary.utilisation, cancellation_rate: rep7.summary.cancellation_rate, bookings_week: rep7.summary.bookings,
      series: rep7.series.map((s) => ({ date: s.period, bookings: s.bookings, unit_hours: s.unit_hours })),
      peak_hour: peak && peak.bookings > 0 ? peak.hour : null,
      by_weekday: rep28?.by_weekday ?? [],
    };
    const revenue = repMonth && await S('revenue', async () => {
      const elapsed = Number(today.slice(8)); const dim = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
      return {
        currency: venue.currency, today_cents: todayBlock?.revenue_cents ?? 0, month_to_date_cents: repMonth.summary.revenue_cents,
        projected_month_end_cents: elapsed >= 3 ? Math.round((repMonth.summary.revenue_cents / elapsed) * dim) : null, projection_basis: elapsed >= 3 ? 'run_rate' : 'too_early',
        outstanding_cents: repMonth.summary.outstanding_cents, refunds_owed_cents: repMonth.summary.refunds_owed_cents,
        categories: [{ key: 'facility_rental', cents: repMonth.summary.revenue_cents }, { key: 'front_desk_sales', cents: (await one("SELECT coalesce(sum(total_cents),0)::int AS c FROM pos_sales WHERE venue_id=$1 AND status='paid' AND created_at >= $2", [i.id, fromLocal(monthStart, 0, tz)])).c }],
        by_facility: repMonth.by_resource.map((r) => ({ id: r.resource_id, name: r.name, kind: r.kind, revenue_cents: r.net_cents, utilisation: r.utilisation })),
      };
    });

    // ---- events at the venue with a readiness checklist
    const events = await S('events', async () => {
      const rows = await many(
        `SELECT ev.id, ev.name, ev.starts_on::text, ev.ends_on::text, count(*)::int AS bookings, array_agg(DISTINCT b.resource_id) AS resource_ids, min(b.starts_at) AS first_at, max(b.ends_at) AS last_at
           FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN events ev ON ev.id=b.event_id
          WHERE r.venue_id=$1 AND b.status='confirmed' AND b.ends_at > $2 AND b.starts_at < $3 GROUP BY ev.id ORDER BY min(b.starts_at) LIMIT 10`, [i.id, now, new Date(now.getTime() + 30 * 86400_000)]);
      return Promise.all(rows.map(async (e) => {
        const [work, shifts, incidents] = await Promise.all([
          one("SELECT count(*)::int AS n FROM venue_maintenance WHERE venue_id=$1 AND status IN ('scheduled','in_progress') AND resource_id = ANY($2)", [i.id, e.resource_ids]),
          one("SELECT count(*)::int AS n FROM venue_shifts WHERE venue_id=$1 AND status IN ('scheduled','clocked_in') AND starts_at < $3 AND ends_at > $2", [i.id, e.first_at, e.last_at]),
          one("SELECT count(*)::int AS n FROM venue_incidents WHERE venue_id=$1 AND status <> 'resolved' AND resource_id = ANY($2)", [i.id, e.resource_ids]).catch(() => ({ n: 0 })),
        ]);
        const notReady = (board ?? []).filter((a) => e.resource_ids.includes(a.resource_id ?? a.id) && ['not_ready', 'attention'].includes(a.status)).length;
        const checklist = [
          { key: 'areas_ready', done: notReady === 0 }, { key: 'no_open_work', done: work.n === 0 },
          { key: 'staff_rostered', done: shifts.n > 0 }, { key: 'no_open_incidents', done: incidents.n === 0 },
        ];
        return { id: e.id, name: e.name, starts_on: e.starts_on, ends_on: e.ends_on, bookings: e.bookings, first_at: e.first_at, checklist, complete_pct: Math.round((checklist.filter((c) => c.done).length / checklist.length) * 100) };
      }));
    });

    // ---- upcoming normal bookings
    const upcoming = await S('upcoming', () => many(
      `SELECT b.id, b.starts_at, b.ends_at, b.payment_status, b.price_cents, r.name AS area, b.event_id, coalesce(u.display_name, u.handle) AS customer
         FROM bookings b JOIN resources r ON r.id=b.resource_id JOIN users u ON u.id=b.user_id
        WHERE r.venue_id=$1 AND b.status='confirmed' AND b.starts_at >= $2 AND b.event_id IS NULL ORDER BY b.starts_at LIMIT 8`, [i.id, now]));

    // ---- demand (what could not be served, who wants in)
    const demand = await S('demand', async () => {
      const [wait, coaches] = await Promise.all([
        sibling('venue_waitlist')({ user }, { id: i.id }),
        many("SELECT t.id, t.kind, t.created_at, coalesce(u.display_name, u.handle) AS coach FROM venue_coach_ties t JOIN users u ON u.id=t.coach_id WHERE t.venue_id=$1 AND t.status='proposed' AND t.proposed_by='coach' ORDER BY t.created_at LIMIT 10", [i.id]),
      ]);
      return { waitlist: wait.slice(0, 8), waiting_total: wait.reduce((s, w) => s + w.waiting, 0), coach_requests: coaches };
    });

    // ---- procurement (supplier RFQs + tenders for this venue)
    const procurement = await S('procurement', async () => {
      const [rfq, quotes, tender] = await Promise.all([
        one(`SELECT count(*) FILTER (WHERE q.status IN ('issued','quoting'))::int AS open, count(*) FILTER (WHERE q.status IN ('evaluation','approval_pending'))::int AS evaluation, count(*) FILTER (WHERE q.status IN ('awarded','partially_awarded'))::int AS awarded
               FROM svc_rfqs q JOIN svc_buyers b ON b.id=q.buyer_id WHERE b.venue_id=$1`, [i.id]),
        one(`SELECT count(*)::int AS n FROM svc_quotes s JOIN svc_rfqs q ON q.id=s.rfq_id JOIN svc_buyers b ON b.id=q.buyer_id WHERE b.venue_id=$1 AND s.status IN ('submitted','shortlisted') AND q.status IN ('issued','quoting','evaluation','approval_pending')`, [i.id]),
        one(`SELECT count(*) FILTER (WHERE status IN ('published'))::int AS open, count(*) FILTER (WHERE status IN ('evaluation','award'))::int AS evaluation, count(*) FILTER (WHERE status='awarded')::int AS awarded FROM proc_projects WHERE venue_id=$1`, [i.id]),
      ]);
      return { open: rfq.open + tender.open, responses: quotes.n, evaluation: rfq.evaluation + tender.evaluation, awarded: rfq.awarded + tender.awarded };
    });

    // ---- assets + maintenance
    const assets = await S('assets', async () => {
      const [cond, warranty, pm, work, spend] = await Promise.all([
        many('SELECT condition, count(*)::int AS n FROM inventory_items WHERE venue_id=$1 AND condition IS NOT NULL GROUP BY condition', [i.id]),
        one("SELECT count(*)::int AS n FROM inventory_items WHERE venue_id=$1 AND warranty_until IS NOT NULL AND warranty_until BETWEEN current_date AND current_date + 60", [i.id]),
        one('SELECT count(*)::int AS n FROM venue_pm_templates WHERE venue_id=$1 AND next_due_on IS NOT NULL AND next_due_on < current_date', [i.id]),
        many(`SELECT m.id, m.title, m.priority, m.status, m.due_on::text, r.name AS area FROM venue_maintenance m LEFT JOIN resources r ON r.id=m.resource_id WHERE m.venue_id=$1 AND m.status IN ('scheduled','in_progress') ORDER BY (m.due_on IS NULL), m.due_on, m.priority LIMIT 6`, [i.id]),
        one("SELECT coalesce(sum(actual_cost_cents),0)::int AS c FROM venue_maintenance WHERE venue_id=$1 AND status='done' AND completed_at >= now() - interval '30 days'", [i.id]).catch(() => ({ c: 0 })),
      ]);
      return { condition: Object.fromEntries(cond.map((c) => [c.condition, c.n])), warranty_expiring: warranty.n, pm_overdue: pm.n, open_work: work, spend_30d_cents: spend.c };
    });

    // ---- staff
    const staff = await S('staff', async () => {
      const [team, onShift, missed] = await Promise.all([
        many('SELECT duty, count(*)::int AS n FROM venue_staff WHERE venue_id=$1 AND removed_at IS NULL GROUP BY duty', [i.id]),
        many("SELECT duty, count(*)::int AS n FROM venue_shifts WHERE venue_id=$1 AND status='clocked_in' GROUP BY duty", [i.id]),
        one("SELECT count(*)::int AS n FROM venue_shifts WHERE venue_id=$1 AND status IN ('scheduled','missed') AND starts_at < now() - interval '15 minutes' AND ends_at > now()", [i.id]),
      ]);
      return { team, on_shift: onShift, late_or_missed: missed.n };
    });

    // ---- customers
    const customer = await S('customer', async () => {
      const [r, rep90] = await Promise.all([
        one(`SELECT round(avg(rating),2)::float8 AS avg, count(*)::int AS count, count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS new_30d, count(*) FILTER (WHERE reply_body IS NULL)::int AS awaiting_reply, count(*) FILTER (WHERE reply_body IS NULL AND rating <= 2)::int AS low_unanswered
               FROM testimonials WHERE subject_type='venue' AND subject_id=$1 AND status='published'`, [i.id]),
        one(`SELECT count(*)::int AS customers, count(*) FILTER (WHERE n >= 2)::int AS repeat FROM (SELECT b.user_id, count(*) AS n FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.status IN ('confirmed','no_show') AND b.starts_at >= now() - interval '90 days' GROUP BY b.user_id) x`, [i.id]),
      ]);
      return { rating: r.avg, reviews: r.count, new_reviews_30d: r.new_30d, awaiting_reply: r.awaiting_reply, low_unanswered: r.low_unanswered, repeat_rate: rep90.customers ? Math.round((rep90.repeat / rep90.customers) * 1000) / 1000 : null, customers_90d: rep90.customers };
    });

    const opportunities = await S('opportunities', async () => {
      const [ties, plans] = await Promise.all([
        one("SELECT count(*)::int AS n FROM venue_coach_ties WHERE venue_id=$1 AND status='agreed'", [i.id]),
        one('SELECT count(*)::int AS n FROM venue_plans WHERE venue_id=$1', [i.id]),
      ]);
      return [
        ...(ties.n === 0 && (facilities?.length ?? 0) > 0 ? [{ key: 'coaching_packages', action: { route: 'Manage', params: { id: i.id, tab: 'coaches' } } }] : []),
        ...(plans.n === 0 && (facilities?.length ?? 0) > 0 ? [{ key: 'memberships', action: { route: 'Manage', params: { id: i.id, tab: 'plans' } } }] : []),
        ...((occupancy?.utilisation ?? 0) >= 0.9 ? [{ key: 'price_up', action: { route: 'Manage', params: { id: i.id, tab: 'pricing' } } }] : []),
        ...((w28 && w28.bookings >= 20 && rep28.by_weekday.length >= 3 && Math.min(...rep28.by_weekday.map((x) => x.bookings)) <= (w28.bookings / 7) * 0.5) ? [{ key: 'quiet_package', action: { route: 'Manage', params: { id: i.id, tab: 'plans' } } }] : []),
      ];
    });
    const compliance = await S('compliance', () => complianceRegister(i.id, today));
    const inbox = await S('inbox', () => one('SELECT count(*)::int AS unread FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id]));

    // ---- attention (merged, severity ranked: 0 = now, 1 = soon, 2 = watch)
    const attention = [];
    const add = (key, severity, count, action) => count > 0 && attention.push({ key, severity, count, action });
    const ops = await S('operations', () => sibling('venue_operations_overview')({ user }, { id: i.id }));
    for (const a of ops?.attention ?? []) {
      const n = Number(/\d+/.exec(a.text)?.[0] ?? 1);
      if (a.key === 'maintenance_overdue') add('maintenance_overdue', 0, n, { route: 'Manage', params: { id: i.id, tab: 'maintenance' } });
      else if (a.key === 'maintenance_urgent') add('maintenance_urgent', 0, n, { route: 'Manage', params: { id: i.id, tab: 'maintenance' } });
      else if (a.key === 'no_insurance') add('no_insurance', 1, 1, { route: 'Manage', params: { id: i.id, tab: 'docs' } });
    }
    add('compliance_expired', 0, compliance?.expired ?? 0, { route: 'Manage', params: { id: i.id, tab: 'docs' } });
    add('compliance_expiring', 1, compliance?.expiring_soon ?? 0, { route: 'Manage', params: { id: i.id, tab: 'docs' } });
    add('areas_not_ready', 0, (board ?? []).filter((a) => a.status === 'not_ready').length, { route: 'Manage', params: { id: i.id, tab: 'maintenance' } });
    add('review_unanswered', customer?.low_unanswered ? 0 : 2, customer?.awaiting_reply ?? 0, { route: 'Manage', params: { id: i.id, tab: 'reviews' } });
    add('coach_requests', 1, demand?.coach_requests.length ?? 0, { route: 'Manage', params: { id: i.id, tab: 'coaches' } });
    add('rfq_decision', 1, procurement?.evaluation ?? 0, { route: 'TenderZone', params: { venue_id: i.id } });
    add('unpaid_bookings', 1, (await S('unpaid', () => one("SELECT count(*)::int AS n FROM bookings b JOIN resources r ON r.id=b.resource_id WHERE r.venue_id=$1 AND b.status='confirmed' AND b.payment_status='unpaid' AND b.ends_at < now()", [i.id])))?.n ?? 0, { route: 'Manage', params: { id: i.id, tab: 'schedule' } });
    add('staff_gap', 1, staff?.late_or_missed ?? 0, { route: 'Manage', params: { id: i.id, tab: 'frontdesk' } });
    add('refunds_owed', 1, revenue?.refunds_owed_cents > 0 ? 1 : 0, { route: 'Manage', params: { id: i.id, tab: 'schedule' } });
    add('event_not_ready', 1, (events ?? []).filter((e) => e.complete_pct < 100).length, { route: 'Manage', params: { id: i.id, tab: 'schedule' } });
    attention.sort((a, b) => a.severity - b.severity);

    // ---- insights: rules over real history only
    const insights = [];
    if (w28 && w28.bookings >= 20 && rep28.by_weekday.length >= 3) {
      const avg = w28.bookings / 7;
      const quiet = [...rep28.by_weekday].sort((a, b) => a.bookings - b.bookings)[0];
      if (quiet.bookings <= avg * 0.5) insights.push({ key: 'weekday_quiet', data: { weekday: quiet.weekday, bookings: quiet.bookings, average: round1(avg) } });
      const top = rep28.by_resource?.[0];
      if (top && top.net_cents > 0 && rep28.by_resource.length > 1) insights.push({ key: 'top_facility', data: { name: top.name, revenue_cents: top.net_cents, currency: venue.currency } });
    }
    if (w28 && repPrev28 && w28.bookings + w28.cancellations >= 20 && repPrev28.summary.bookings + repPrev28.summary.cancellations >= 20) {
      const delta = Math.round((w28.cancellation_rate - repPrev28.summary.cancellation_rate) * 1000) / 10;
      if (delta >= 3) insights.push({ key: 'cancellations_up', data: { delta_points: delta, rate: Math.round(w28.cancellation_rate * 1000) / 10 } });
    }
    if ((demand?.waiting_total ?? 0) > 0) insights.push({ key: 'unmet_demand', data: { waiting: demand.waiting_total } });
    if (occupancy?.utilisation != null && occupancy.utilisation >= 0.9) insights.push({ key: 'near_capacity', data: { utilisation: Math.round(occupancy.utilisation * 1000) / 10 } });

    const kpis = {
      revenue_cents: todayBlock?.revenue_cents ?? 0, currency: venue.currency, bookings: todayBlock?.bookings ?? 0,
      occupancy_now: facilities?.length ? Math.round((facilities.filter((f) => ['occupied', 'event'].includes(f.state)).length / facilities.length) * 1000) / 1000 : null,
      occupancy_today: repToday?.summary.utilisation ?? null, actions_required: attention.length,
    };
    return {
      venue: { id: venue.id, name: venue.name, currency: venue.currency, timezone: tz }, generated_at: now.toISOString(),
      today: todayBlock, kpis, attention, facilities, day_hours: dayHours, opportunities, occupancy, revenue, events, upcoming, demand, procurement, assets, staff, customer, compliance, inbox, insights,
      ai_manager: { things_to_review: attention.length + insights.length, top: attention.slice(0, 3).map((a) => a.key), insight_keys: insights.map((x) => x.key) },
      unavailable,
    };
  },
});

// ------------------------------------------------------------------ compliance register
export const COMPLIANCE_CATEGORIES = ['operating', 'safety', 'sports_grade', 'food_bev', 'health_medical', 'environmental', 'finance_tax', 'employment', 'events', 'other'];
export const RENEWAL_STAGES = ['not_started', 'applied', 'in_review', 'issued'];
export const VERIFICATION_STATUSES = ['self_reported', 'third_party', 'certified'];

const money = z.coerce.number().int().min(0);
const itemInput = {
  kind: z.enum(COMPLIANCE_KINDS), title: z.string().trim().min(2).max(160),
  reference: z.string().trim().max(120).optional(),
  issued_on: day.optional(), expires_on: day.optional(), document_id: id.optional(),
  // Elite fields
  category: z.enum(COMPLIANCE_CATEGORIES).optional(),
  sub_type: z.string().trim().max(80).optional(),
  issuing_authority: z.string().trim().max(200).optional(),
  jurisdiction_country: z.string().length(2).toUpperCase().optional(),
  jurisdiction_region: z.string().trim().max(80).optional(),
  verification_status: z.enum(VERIFICATION_STATUSES).optional(),
  coverage_scope: z.array(z.string().uuid()).max(50).optional(),
  responsible_user_id: id.optional(),
  alert_recipient_ids: z.array(id).max(20).optional(),
  reminder_days: z.array(z.number().int().min(1).max(365)).max(10).optional(),
  renewal_stage: z.enum(RENEWAL_STAGES).optional(),
  renewal_ref: z.string().trim().max(120).optional(),
  renewal_expected_on: day.optional(),
  annual_fee_cents: money.optional(),
  annual_fee_currency: z.string().length(3).toUpperCase().optional(),
  renewal_estimate_cents: money.optional(),
  last_paid_on: day.optional(),
  conditions_notes: z.string().trim().max(2000).optional(),
};

const ELITE_COLS = ['category', 'sub_type', 'issuing_authority', 'jurisdiction_country', 'jurisdiction_region',
  'verification_status', 'responsible_user_id', 'renewal_stage', 'renewal_expected_on',
  'annual_fee_cents', 'annual_fee_currency', 'renewal_estimate_cents', 'last_paid_on', 'conditions_notes'];

/** Build the elite column assignments for INSERT/UPDATE; jsonb and array fields handled separately. */
function eliteVals(rest) {
  return {
    cols: ELITE_COLS.filter((k) => rest[k] !== undefined),
    vals: ELITE_COLS.filter((k) => rest[k] !== undefined).map((k) => rest[k] ?? null),
    coverageScope: rest.coverage_scope !== undefined ? JSON.stringify(rest.coverage_scope ?? []) : undefined,
    alertRecipients: rest.alert_recipient_ids !== undefined ? rest.alert_recipient_ids ?? [] : undefined,
    reminderDays: rest.reminder_days !== undefined ? rest.reminder_days ?? [90, 60, 30, 14, 7, 1] : undefined,
    renewalRef: rest.renewal_ref,
  };
}

/** Full item read with all elite fields; reference_enc / renewal_ref_enc returned opaque unless reveal=true. */
const ITEM_SELECT = `
  id, kind, category, sub_type, title,
  issuing_authority, jurisdiction_country, jurisdiction_region, verification_status,
  coverage_scope, responsible_user_id, alert_recipient_ids, reminder_days,
  renewal_stage, renewal_expected_on, renewal_ref_enc,
  annual_fee_cents, annual_fee_currency, renewal_estimate_cents, last_paid_on,
  conditions_notes, issued_on::text, expires_on::text, document_id,
  reference_enc, archived_at, created_at, updated_at`;

cap({
  name: 'add_venue_compliance_item', method: 'POST', path: '/venues/:id/compliance', tag: TAG, status: 201,
  summary: 'Record a licence, certificate or permit for a venue. Supports full elite fields: category, sub-type, issuing authority, jurisdiction (country + region), verification status, coverage scope (whole venue or specific courts), responsible person, alert recipients, configurable reminder cadence (default: 90/60/30/14/7/1 days before expiry), renewal workflow stage, finance tracking (annual fee, renewal estimate, last paid), and conditions notes. The licence/reference number and renewal reference are stored encrypted. Venue managers only.',
  input: z.object({ id, ...itemInput }).refine((i) => !i.expires_on || !i.issued_on || i.expires_on >= i.issued_on, 'expires_on is before issued_on'),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const { id: venueId, reference, renewal_ref, ...rest } = i;
    const ev = eliteVals(rest);
    const baseCols = ['venue_id', 'kind', 'title', 'reference_enc', 'issued_on', 'expires_on', 'document_id', 'created_by'];
    const baseVals = [venueId, rest.kind, rest.title,
      reference ? encryptFields({ reference }, 'venue_compliance_items', ['reference']).reference_enc : null,
      rest.issued_on ?? null, rest.expires_on ?? null, rest.document_id ?? null, user.id];
    const extraCols = [...ev.cols,
      ...(ev.coverageScope !== undefined ? ['coverage_scope'] : []),
      ...(ev.alertRecipients !== undefined ? ['alert_recipient_ids'] : []),
      ...(ev.reminderDays !== undefined ? ['reminder_days'] : []),
      ...(ev.renewalRef ? ['renewal_ref_enc'] : [])];
    const extraVals = [...ev.vals,
      ...(ev.coverageScope !== undefined ? [ev.coverageScope] : []),
      ...(ev.alertRecipients !== undefined ? [ev.alertRecipients] : []),
      ...(ev.reminderDays !== undefined ? [ev.reminderDays] : []),
      ...(ev.renewalRef ? [encryptFields({ renewal_ref: ev.renewalRef }, 'venue_compliance_items', ['renewal_ref']).renewal_ref_enc] : [])];
    const allCols = [...baseCols, ...extraCols];
    const allVals = [...baseVals, ...extraVals];
    const row = await one(
      `INSERT INTO venue_compliance_items (${allCols.join(',')}) VALUES (${allVals.map((_, n) => `$${n + 1}`).join(',')})
       RETURNING ${ITEM_SELECT}`,
      allVals);
    await audit(null, user.id, 'venue_compliance_add', 'venue_compliance_items', row.id);
    return row;
  },
});

cap({
  name: 'list_venue_compliance_items', method: 'GET', path: '/venues/:id/compliance', tag: TAG,
  summary: 'The venue compliance register: licences and permits plus the venue\'s insurance policies and contracts, each with days left and a status (ok, soon within 30 days, expired). Includes compliance score (0-100), expiry forecast by month, total annual cost, and category breakdown. Reference numbers are decrypted only with reveal=true, which is audit-logged. Optionally filter by category. Venue managers only.',
  input: z.object({ id, reveal: z.coerce.boolean().default(false), include_archived: z.coerce.boolean().default(false), category: z.enum(COMPLIANCE_CATEGORIES).optional() }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const venue = await mustFind('venues', i.id);
    const today = toLocal(new Date(), venue.timezone).date;
    const register = await complianceRegister(i.id, today);
    const catFilter = i.category ? ` AND category=$2` : '';
    const rows = await many(
      `SELECT ${ITEM_SELECT} FROM venue_compliance_items WHERE venue_id=$1 ${i.include_archived ? '' : 'AND archived_at IS NULL'}${catFilter} ORDER BY expires_on NULLS LAST, title`,
      i.category ? [i.id, i.category] : [i.id]);
    if (i.reveal) await audit(null, user.id, 'read_pii', 'venue_compliance_items', i.id);
    const enriched = rows.map((r) => ({
      ...r,
      has_reference: Boolean(r.reference_enc),
      reference: i.reveal && r.reference_enc ? decryptFields(r, 'venue_compliance_items', ['reference']).reference : null,
      renewal_ref: i.reveal && r.renewal_ref_enc ? decryptFields(r, 'venue_compliance_items', ['renewal_ref']).renewal_ref : null,
    }));
    // Compliance analytics
    const ownItems = enriched.filter((r) => !r.archived_at);
    const withExpiry = ownItems.filter((r) => r.expires_on);
    const valid = withExpiry.filter((r) => daysUntil(r.expires_on, today) > SOON_DAYS).length;
    const expiring = withExpiry.filter((r) => { const d = daysUntil(r.expires_on, today); return d >= 0 && d <= SOON_DAYS; }).length;
    const expired = withExpiry.filter((r) => daysUntil(r.expires_on, today) < 0).length;
    const total = withExpiry.length;
    const score = total === 0 ? 100 : Math.max(0, Math.round(((valid + expiring * 0.5) / total) * 100));
    const totalAnnualCents = ownItems.reduce((s, r) => s + (r.annual_fee_cents ?? 0), 0);
    const currency = ownItems.find((r) => r.annual_fee_currency)?.annual_fee_currency ?? null;
    // 12-month expiry forecast: count items expiring in each of the next 12 calendar months
    const forecast = Array.from({ length: 12 }, (_, mo) => {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + mo);
      const ym = d.toISOString().slice(0, 7);
      return { month: ym, count: withExpiry.filter((r) => r.expires_on.slice(0, 7) === ym).length };
    });
    // Category breakdown
    const byCategory = {};
    for (const cat of COMPLIANCE_CATEGORIES) {
      const items = ownItems.filter((r) => (r.category ?? 'other') === cat);
      if (items.length) byCategory[cat] = { total: items.length, expired: items.filter((r) => r.expires_on && daysUntil(r.expires_on, today) < 0).length };
    }
    return {
      ...register,
      items: enriched,
      analytics: { score, total: ownItems.length, valid, expiring, expired, total_annual_cents: totalAnnualCents, annual_currency: currency, forecast, by_category: byCategory },
    };
  },
});

cap({
  name: 'update_venue_compliance_item', method: 'PATCH', path: '/venues/:id/compliance/:item_id', tag: TAG,
  summary: 'Renew or correct a compliance item. Supports all elite fields: new expiry date, renewal workflow stage, finance, responsible person, alert recipients, reminder cadence, conditions notes, and archive. Items are archived, never deleted. Venue managers only.',
  input: z.object({
    id, item_id: id,
    title: itemInput.title.optional(), kind: itemInput.kind.optional(),
    reference: itemInput.reference,
    issued_on: day.nullable().optional(), expires_on: day.nullable().optional(),
    archived: z.boolean().optional(),
    category: itemInput.category, sub_type: itemInput.sub_type,
    issuing_authority: itemInput.issuing_authority,
    jurisdiction_country: itemInput.jurisdiction_country, jurisdiction_region: itemInput.jurisdiction_region,
    verification_status: itemInput.verification_status,
    coverage_scope: itemInput.coverage_scope,
    responsible_user_id: itemInput.responsible_user_id,
    alert_recipient_ids: itemInput.alert_recipient_ids,
    reminder_days: itemInput.reminder_days,
    renewal_stage: itemInput.renewal_stage, renewal_ref: itemInput.renewal_ref,
    renewal_expected_on: itemInput.renewal_expected_on,
    annual_fee_cents: itemInput.annual_fee_cents, annual_fee_currency: itemInput.annual_fee_currency,
    renewal_estimate_cents: itemInput.renewal_estimate_cents, last_paid_on: itemInput.last_paid_on,
    conditions_notes: itemInput.conditions_notes,
  }),
  async handler({ user }, i) {
    await mustManage(user, i.id);
    const cur = await one('SELECT id FROM venue_compliance_items WHERE id=$1 AND venue_id=$2', [i.item_id, i.id]);
    if (!cur) throw notFound('Compliance item not found');
    const ev = eliteVals(i);
    // Build dynamic SET clause for elite scalar columns
    const setClauses = [
      'title=coalesce($3,title)', 'kind=coalesce($4,kind)',
      'reference_enc=CASE WHEN $5::text IS NULL THEN reference_enc ELSE $5 END',
      'issued_on=CASE WHEN $6::boolean THEN $7::date ELSE issued_on END',
      'expires_on=CASE WHEN $8::boolean THEN $9::date ELSE expires_on END',
      'reminded_at=CASE WHEN $8::boolean THEN NULL ELSE reminded_at END',
      'archived_at=CASE WHEN $10::boolean IS NULL THEN archived_at WHEN $10 THEN coalesce(archived_at, now()) ELSE NULL END',
    ];
    const baseVals = [i.item_id, i.id, i.title ?? null, i.kind ?? null,
      i.reference ? encryptFields({ reference: i.reference }, 'venue_compliance_items', ['reference']).reference_enc : null,
      i.issued_on !== undefined, i.issued_on ?? null, i.expires_on !== undefined, i.expires_on ?? null, i.archived ?? null];
    let p = baseVals.length + 1;
    const extraVals = [];
    for (const col of ev.cols) { setClauses.push(`${col}=$${p++}`); extraVals.push(ev.vals[ev.cols.indexOf(col)]); }
    if (ev.coverageScope !== undefined) { setClauses.push(`coverage_scope=$${p++}`); extraVals.push(ev.coverageScope); }
    if (ev.alertRecipients !== undefined) { setClauses.push(`alert_recipient_ids=$${p++}`); extraVals.push(ev.alertRecipients); }
    if (ev.reminderDays !== undefined) { setClauses.push(`reminder_days=$${p++}`); extraVals.push(ev.reminderDays); }
    if (ev.renewalRef) { setClauses.push(`renewal_ref_enc=$${p++}`); extraVals.push(encryptFields({ renewal_ref: ev.renewalRef }, 'venue_compliance_items', ['renewal_ref']).renewal_ref_enc); }
    setClauses.push('updated_at=now()');
    const row = await one(
      `UPDATE venue_compliance_items SET ${setClauses.join(', ')} WHERE id=$1 AND venue_id=$2 RETURNING ${ITEM_SELECT}`,
      [...baseVals, ...extraVals]);
    await audit(null, user.id, 'venue_compliance_update', 'venue_compliance_items', row.id);
    return row;
  },
});
