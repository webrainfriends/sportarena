// Event Control Tower: the landing page of a person working as an event manager / organiser (#599 role workspace).
//
// It owns no data. Every number is read live from the capability or table that already owns it (readiness, live board, registration,
// staffing, accreditation, tickets, commercials, venues, tenders, compliance, streams ...), so the landing page can never disagree with the
// screen it opens. Each section is computed on its own and degrades to `{ available: false }` when the caller may not see it (a department
// lead sees operations but not the money), so a partial viewer still gets a useful page. Counts only: no personal data leaves this file.
// Text is returned as structured `kind` + numbers, never as English sentences, so every language pack can render it.
import { z } from 'zod';
import { cap, capabilities, id } from '../registry.js';
import { many, one, pool } from '../db.js';
import { notFound } from '../errors.js';
import { invoke } from '../invoke.js';
import { stageOf } from '../tender/core.js';
import { boardOf, opsAccess, readinessOf } from './event-ops.js';
import { isOrganiser } from './event-departments.js';

const TAG = 'Event operations';
const SEV = { critical: 0, high: 1, medium: 2, low: 3 };
const dstr = (d) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/** Where each readiness area is fixed: the Event Console tab (and sub-tab) that owns it. */
export const FIX = {
  programme: { tab: 'games' }, venue: { tab: 'venue' }, participants: { tab: 'teams' }, officials: { tab: 'people', sub: 'departments' }, staff: { tab: 'people', sub: 'hiring' },
  suppliers: { tab: 'business', sub: 'services' }, procurement: { tab: 'business', sub: 'services' }, accreditation: { tab: 'accreditation' }, tickets: { tab: 'tickets' },
  transport: { tab: 'travel' }, safety: { tab: 'compliance' }, medical: { tab: 'compliance' }, media: { tab: 'broadcast' }, sponsors: { tab: 'business', sub: 'partners' },
  finance: { tab: 'business', sub: 'budget' }, tasks: { tab: 'boards' }, other: { tab: 'operations', sub: 'readiness' },
};

/** The lifecycle phase drives the order of the cards: same cards, different emphasis (no three dashboards). */
export const PHASE_ORDER = {
  before: ['readiness', 'attention', 'today_next', 'participants', 'finance', 'operations', 'workforce', 'venue', 'procurement', 'commercial', 'tickets', 'compliance', 'media', 'travel', 'results', 'ai'],
  during: ['operations', 'attention', 'today_next', 'results', 'tickets', 'venue', 'workforce', 'participants', 'readiness', 'compliance', 'media', 'travel', 'finance', 'commercial', 'procurement', 'ai'],
  after: ['results', 'finance', 'commercial', 'workforce', 'attention', 'procurement', 'participants', 'tickets', 'operations', 'compliance', 'media', 'travel', 'readiness', 'today_next', 'venue', 'ai'],
};
const phaseOf = (status) => (['ongoing', 'paused'].includes(status) ? 'during' : ['completed', 'cancelled'].includes(status) ? 'after' : 'before');
const STAGES = ['setup', 'registration', 'event_day', 'close'];
const stageIndex = (status) => ({ draft: 0, open: 1, ongoing: 2, paused: 2, completed: 3, cancelled: 3 }[status] ?? 0);

/** How serious an open readiness item is: safety and medical cover are never "low"; everything tightens as the event approaches. */
export function severityOf(item, daysToGo, onDate = today()) {
  const due = dstr(item.due_on);
  if (due && due < onDate) return 'critical';
  if (['safety', 'medical'].includes(item.area)) return daysToGo != null && daysToGo <= 14 ? 'critical' : 'high';
  if (due && daysBetween(onDate, due) <= 7) return 'high';
  if (daysToGo != null && daysToGo <= 7) return 'high';
  return daysToGo != null && daysToGo <= 30 ? 'medium' : 'low';
}

const call = async (name, user, input) => invoke(capabilities.find((c) => c.name === name), user, input);
/** Run one section; any failure (no permission, nothing set up) makes just that section unavailable. */
const section = async (fn) => { try { return await fn(); } catch { return { available: false }; } };

export async function towerOf(user, ev) {
  const access = await opsAccess(user, ev);
  if (!access.crew) throw notFound('Event');
  const organiser = access.organiser || (await isOrganiser(user, ev));
  const t0 = today();
  const starts = dstr(ev.starts_on), ends = dstr(ev.ends_on) ?? starts;
  const daysToGo = starts ? daysBetween(t0, starts) : null;
  const phase = phaseOf(ev.status);
  const [board, ready] = await Promise.all([section(() => boardOf(ev)), section(() => readinessOf(ev))]);
  const okBoard = board && board.available !== false ? board : null, okReady = ready && ready.available !== false ? ready : null;

  const readiness = okReady && (() => {
    const blockers = okReady.items.filter((x) => x.required && x.state === 'open').map((x) => ({
      id: x.id, title: x.title, area: x.area, area_label: x.area_label, detail: x.detail, due_on: dstr(x.due_on), derive_key: x.derive_key, severity: severityOf(x, daysToGo, t0), fix: FIX[x.area] ?? FIX.other,
    })).sort((a, b) => SEV[a.severity] - SEV[b.severity] || String(a.due_on ?? '9').localeCompare(String(b.due_on ?? '9')));
    const nextDue = blockers.filter((b) => b.due_on).sort((a, b) => a.due_on.localeCompare(b.due_on))[0] ?? null;
    return {
      percent: okReady.percent, met: okReady.met, total: okReady.total, needs_setup: okReady.items.length === 0,
      critical: blockers.filter((b) => b.severity === 'critical').length, due_soon: blockers.filter((b) => b.severity === 'high').length,
      blockers: blockers.slice(0, 5), blocker_count: blockers.length, top_blocker: blockers[0] ?? null, next_due: nextDue, areas: okReady.areas,
    };
  })();

  const [participants, finance, venue, workforce, tickets, commercial, procurement, compliance, media, travel, results] = await Promise.all([
    section(async () => {
      const [entries, invites, regs, acc] = await Promise.all([
        many('SELECT status, count(*)::int AS n FROM event_entries WHERE event_id=$1 GROUP BY status', [ev.id]),
        organiser ? many('SELECT status, count(*)::int AS n FROM event_invitations WHERE event_id=$1 GROUP BY status', [ev.id]) : [],
        many('SELECT status, count(*)::int AS n FROM reg_registrations WHERE event_id=$1 GROUP BY status', [ev.id]).catch(() => []),
        call('accreditation_report', user, { id: ev.id }).catch(() => null),
      ]);
      const by = (rows) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
      const e = by(entries), r = by(regs), inv = by(invites);
      return {
        teams: e.accepted ?? 0, entries: { accepted: e.accepted ?? 0, pending: e.pending ?? 0, rejected: e.rejected ?? 0 },
        athletes: (r.registered ?? 0) + (r.suspended ?? 0), registrations: { confirmed: r.registered ?? 0, pending: (r.submitted ?? 0) + (r.under_review ?? 0) },
        invitations: { waiting: inv.invited ?? 0, accepted: inv.accepted ?? 0, declined: inv.declined ?? 0 },
        accreditation: acc ? { approved: acc.totals.approved, pending: acc.totals.outstanding_approvals, checked_in: acc.totals.checked_in, refused_24h: acc.totals.refused_last_24h } : null,
        capacity: ev.capacity ?? null, registration_deadline: dstr(ev.registration_deadline),
      };
    }),
    organiser ? section(async () => {
      const [com, bud] = await Promise.all([call('get_event_commercials', user, { id: ev.id }), call('get_event_budget', user, { id: ev.id }).catch(() => null)]);
      return {
        currency: com.currency, income_cents: com.income_cents, cost_cents: com.expected_cost_cents, net_cents: com.net_cents,
        split: { entry_cents: com.entry_fees_cents, sponsor_cents: com.sponsors.cents, vendor_cents: com.vendors.pitch_fees_cents },
        budget_used_pct: bud?.summary?.cap_used_pct ?? null, paid_cents: bud?.summary?.expense?.paid_cents ?? null, still_to_pay_cents: bud?.summary?.expense?.still_to_pay_cents ?? null,
      };
    }) : { available: false },
    organiser ? section(async () => {
      const venues = await call('get_event_venues', user, { id: ev.id });
      const live = venues.flatMap((v) => v.bookings.filter((b) => b.status === 'confirmed'));
      const next = live.filter((b) => new Date(b.starts_at) > new Date()).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0] ?? null;
      const open = okReady ? okReady.items.filter((x) => x.required && x.state === 'open' && ['venue'].includes(x.area)) : [];
      const pendingRequests = venues.reduce((n, v) => n + v.requests.filter((r) => ['sent', 'quoted'].includes(r.status)).length, 0);
      return {
        venues: venues.length, areas: new Set(live.map((b) => b.resource_id)).size, bookings: live.length, pending_requests: pendingRequests,
        issues: open.map((x) => ({ title: x.title, detail: x.detail })), ready: Math.max(0, venues.length - (open.length ? 1 : 0)),
        next_booking: next ? { at: next.starts_at, resource: next.resource_name, venue: venues.find((v) => v.id === next.venue_id)?.name ?? null } : null,
        names: venues.slice(0, 3).map((v) => v.name),
      };
    }) : { available: false },
    section(async () => {
      const [roles, deps, officials] = await Promise.all([
        call('list_staff_roles', user, { id: ev.id }),
        one("SELECT count(*)::int AS departments, (SELECT count(*)::int FROM event_department_members WHERE event_id=$1 AND status='active') AS members FROM event_departments WHERE event_id=$1 AND status='active'", [ev.id]),
        many("SELECT o.status, count(*)::int AS n FROM fixture_officials o JOIN fixtures f ON f.id=o.fixture_id WHERE f.event_id=$1 GROUP BY o.status", [ev.id]),
      ]);
      const open = roles.filter((r) => !r.closed_at);
      const needed = open.reduce((n, r) => n + Number(r.needed), 0), filled = open.reduce((n, r) => n + Math.min(Number(r.filled), Number(r.needed)), 0);
      const gaps = open.map((r) => ({ title: r.title ?? r.role, role: r.role, open: Math.max(Number(r.needed) - Number(r.filled), 0), applicants: Number(r.applicants ?? 0) })).filter((g) => g.open > 0).sort((a, b) => b.open - a.open);
      const off = Object.fromEntries(officials.map((x) => [x.status, x.n]));
      return {
        departments: deps.departments, members: deps.members, needed, filled, open_positions: gaps.reduce((n, g) => n + g.open, 0), applicants: open.reduce((n, r) => n + Number(r.applicants ?? 0), 0),
        officials: { confirmed: off.accepted ?? 0, invited: off.invited ?? 0 }, most_urgent: gaps[0] ?? null,
      };
    }),
    organiser ? section(async () => {
      const r = await call('ticket_report', user, { id: ev.id });
      return { sold: r.counts.sold, issued: r.counts.issued, refunded: r.counts.refunded, scanned_in: r.counts.scanned_in, checked_in_crew: okBoard?.access.checked_in ?? 0, refused: okBoard?.access.refused ?? 0 };
    }) : { available: false },
    organiser ? section(async () => {
      const [vendors, placements] = await Promise.all([
        many('SELECT kind, status, count(*)::int AS n, coalesce(sum(fee_cents),0)::bigint AS cents FROM event_vendors WHERE event_id=$1 GROUP BY kind, status', [ev.id]),
        call('list_sponsor_inventory', user, { target_type: 'event', target_id: ev.id }).catch(() => null),
      ]);
      const sp = vendors.filter((v) => v.kind === 'sponsor'), ven = vendors.filter((v) => v.kind !== 'sponsor');
      const sum = (rows, st) => rows.filter((r) => r.status === st).reduce((n, r) => n + r.n, 0);
      const units = placements?.units ?? [];
      return {
        sponsors: { active: sum(sp, 'accepted'), awaiting: sum(sp, 'invited'), value_cents: sp.filter((r) => r.status === 'accepted').reduce((n, r) => n + Number(r.cents), 0) },
        vendors: { accepted: sum(ven, 'accepted'), invited: sum(ven, 'invited'), by_kind: ['retail', 'catering', 'other'].map((k) => ({ kind: k, accepted: sum(ven.filter((r) => r.kind === k), 'accepted'), invited: sum(ven.filter((r) => r.kind === k), 'invited') })) },
        inventory: units.length ? { allocated: units.reduce((n, u) => n + Number(u.window?.booked_peak ?? 0), 0), total: units.reduce((n, u) => n + Number(u.capacity ?? 0), 0) } : null,
        currency: ev.currency, seeking: !!ev.seeking_sponsors,
      };
    }) : { available: false },
    organiser ? section(async () => {
      const rows = await many('SELECT p.*, (SELECT count(*)::int FROM proc_proposals x WHERE x.project_id=p.id AND x.status=\'submitted\') AS proposals FROM proc_projects p WHERE p.event_id=$1 AND p.status NOT IN (\'draft\',\'cancelled\',\'archived\') ORDER BY p.closes_at NULLS LAST', [ev.id]);
      const list = rows.map((p) => ({ id: p.id, ref: p.ref, title: p.title, stage: stageOf(p), proposals: p.proposals, closes_at: p.closes_at, awarded: p.status === 'awarded' }));
      const active = list.filter((p) => !p.awarded && !['closed', 'archived', 'cancelled'].includes(p.stage) || ['evaluation', 'award'].includes(rows.find((r) => r.id === p.id)?.status));
      const soon = (p) => p.closes_at && ['open', 'submission'].includes(p.stage) && new Date(p.closes_at) - Date.now() < 48 * 36e5 && new Date(p.closes_at) > new Date();
      return {
        active: active.length, proposals: list.reduce((n, p) => n + p.proposals, 0), awaiting_evaluation: list.filter((p) => p.proposals > 0 && (p.stage === 'closed' || rows.find((r) => r.id === p.id)?.status === 'evaluation')).length,
        closing_soon: list.filter(soon).length, awarded: list.filter((p) => p.awarded).length, latest: active.slice(0, 2),
      };
    }) : { available: false },
    section(async () => {
      const r = await call('get_compliance_status', user, { subject_kind: 'event', subject_id: ev.id });
      const c = r.counts, total = c.met + c.expiring + c.pending + c.blocked + c.unknown;
      return {
        percent: total ? Math.round((c.met / total) * 100) : null, decision: r.decision, counts: c, total,
        actions: c.blocked + c.pending + c.expiring + c.unknown,
        items: r.items.filter((x) => x.blocking || x.state !== 'met').slice(0, 4).map((x) => ({ title: x.title ?? x.name ?? x.label ?? x.key, state: x.state, blocking: !!x.blocking })),
      };
    }),
    organiser ? section(async () => {
      const [pub, streams] = await Promise.all([call('get_event_public_settings', user, { id: ev.id }), call('list_event_streams', user, { id: ev.id }).catch(() => [])]);
      return { visibility: pub.visibility, published: pub.visibility === 'public', streams: streams.length, live_streams: streams.filter((s) => s.display_state === 'live').length, modules: (pub.modules ?? []).length, open_media_incidents: okBoard?.incidents.media_open ?? 0 };
    }) : { available: false },
    organiser ? section(async () => {
      const r = await one("SELECT count(DISTINCT te.trip_id)::int AS trips FROM trip_events te WHERE te.event_id=$1 AND te.unlinked_at IS NULL", [ev.id]);
      return { trips: r.trips, open_issues: okBoard?.incidents.travel_open ?? 0 };
    }) : { available: false },
    section(async () => {
      const g = await many('SELECT status, count(*)::int AS n FROM fixtures WHERE event_id=$1 GROUP BY status', [ev.id]);
      const x = Object.fromEntries(g.map((r) => [r.status, r.n]));
      const done = (x.finished ?? 0) + (x.completed ?? 0), total = g.reduce((n, r) => n + r.n, 0);
      const unpublished = await one("SELECT count(*)::int AS n FROM fixtures WHERE event_id=$1 AND status='finished'", [ev.id]);
      return { total, completed: done, live: x.live ?? 0, remaining: (x.scheduled ?? 0) + (x.paused ?? 0) + (x.postponed ?? 0), postponed: x.postponed ?? 0, awaiting_confirmation: unpublished.n };
    }),
  ]);

  // ------------------------------------------------------------ what needs the manager (exceptions, not notifications)
  const attention = [];
  const add = (kind, severity, n, fix, extra = {}) => { if (n > 0) attention.push({ kind, severity, n, fix, ...extra }); };
  for (const b of readiness?.blockers.filter((x) => ['critical', 'high'].includes(x.severity)).slice(0, 3) ?? []) attention.push({ kind: 'requirement', severity: b.severity, n: 1, title: b.title, area: b.area, fix: b.fix });
  if (okBoard) {
    add('incident', okBoard.incidents.worst === 'critical' || okBoard.incidents.worst === 'high' ? 'critical' : 'high', okBoard.incidents.open, { tab: 'operations' });
    add('task_overdue', 'high', okBoard.tasks.overdue, { tab: 'boards' });
    add('task_blocked', 'medium', okBoard.tasks.blocked, { tab: 'boards' });
  }
  if (participants.entries) add('entries_pending', 'high', participants.entries.pending, { tab: 'teams' });
  if (participants.registrations) add('rosters_pending', 'medium', participants.registrations.pending, { tab: 'registration' });
  if (participants.accreditation) add('badges_pending', 'medium', participants.accreditation.pending, { tab: 'accreditation' });
  if (procurement.active !== undefined) { add('tender_evaluate', 'high', procurement.awaiting_evaluation, { tab: 'business', sub: 'services' }); add('tender_closing', 'medium', procurement.closing_soon, { tab: 'business', sub: 'services' }); }
  if (commercial.sponsors) add('sponsor_awaiting', 'medium', commercial.sponsors.awaiting, { tab: 'business', sub: 'partners' });
  if (workforce.open_positions !== undefined && phase === 'before' && daysToGo != null && daysToGo <= 14) add('positions_open', 'high', workforce.open_positions, { tab: 'people', sub: 'hiring' });
  if (compliance.actions) add('compliance_actions', compliance.counts.blocked ? 'critical' : 'medium', compliance.actions, { tab: 'compliance' });
  attention.sort((a, b) => SEV[a.severity] - SEV[b.severity]);

  // ------------------------------------------------------------ today / up next
  const milestones = [];
  const push = (kind, at, extra = {}) => { if (at && at >= t0) milestones.push({ kind, at, days: daysBetween(t0, at), ...extra }); };
  push('registration_closes', dstr(ev.registration_deadline));
  push('event_starts', phase === 'before' ? starts : null);
  for (const b of readiness?.blockers.filter((x) => x.due_on) ?? []) push('requirement_due', b.due_on, { title: b.title, fix: b.fix });
  milestones.sort((a, b) => a.at.localeCompare(b.at));
  const today_next = {
    live: (okBoard?.next_up ?? []).filter((g) => g.status === 'live').map((g) => ({ id: g.id, home: g.home, away: g.away, round_kind: g.round_kind })),
    live_count: okBoard?.games.live ?? 0,
    next: (okBoard?.next_up ?? []).find((g) => g.status !== 'live') ?? null,
    milestone: milestones[0] ?? null, deadlines_this_week: milestones.filter((m) => m.days <= 7).length,
  };

  // ------------------------------------------------------------ operations headline
  const operations = okBoard ? {
    ...okBoard, state: okBoard.event.status === 'paused' ? 'paused' : okBoard.incidents.worst === 'critical' ? 'critical' : okBoard.incidents.open || okBoard.tasks.overdue ? 'attention' : 'normal',
    remaining: okBoard.games.scheduled + okBoard.games.paused + okBoard.games.postponed,
  } : { available: false };

  // ------------------------------------------------------------ risks and opportunities from the numbers above (rules, never a model on page load)
  const recs = [];
  const rec = (kind, severity, params, fix) => recs.push({ kind, severity, params, fix });
  const med = readiness?.blockers.find((b) => b.area === 'medical');
  if (med && daysToGo != null && daysToGo <= 21) rec('medical_gap', 'critical', { days: daysToGo }, med.fix);
  if (procurement.closing_soon) rec('tender_closing', 'high', { n: procurement.closing_soon }, { tab: 'business', sub: 'services' });
  if (procurement.awaiting_evaluation) rec('tender_unevaluated', 'high', { n: procurement.awaiting_evaluation }, { tab: 'business', sub: 'services' });
  if (participants.accreditation?.pending) rec('accreditation_pending', 'medium', { n: participants.accreditation.pending }, { tab: 'accreditation' });
  if (workforce.open_positions && daysToGo != null && daysToGo <= 30 && phase === 'before') rec('staff_gap', 'high', { n: workforce.open_positions, days: daysToGo }, { tab: 'people', sub: 'hiring' });
  if (readiness?.needs_setup) rec('checklist_missing', 'medium', {}, { tab: 'operations', sub: 'readiness' });
  if (phase === 'before' && !participants.entries?.accepted && ev.status === 'open') rec('no_entries', 'medium', {}, { tab: 'teams' });
  if (finance.net_cents != null && finance.net_cents < 0) rec('negative_net', 'medium', { cents: finance.net_cents }, { tab: 'business', sub: 'budget' });
  recs.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const aiSection = { recommendations: recs.slice(0, 5), total: recs.length, can_plan: organiser && phase === 'before' };

  const sport = await one('SELECT name FROM sports WHERE id=$1', [ev.sport_id]).catch(() => null);
  return {
    event: {
      id: ev.id, name: ev.name, status: ev.status, kind: ev.kind, sport: sport?.name ?? null, city: ev.city ?? null, emoji: ev.banner_emoji, starts_on: starts, ends_on: ends, days_to_go: daysToGo,
      registration_deadline: dstr(ev.registration_deadline), currency: ev.currency, paused: ev.status === 'paused', pause_reason: ev.pause_reason ?? null, public_visible: media.published ?? null,
    },
    phase, stage: { steps: STAGES, index: stageIndex(ev.status), paused: ev.status === 'paused' }, card_order: PHASE_ORDER[phase],
    access: { organiser, manager: access.manager }, as_of: new Date().toISOString(),
    cards: { readiness: readiness ?? { available: false }, attention: { items: attention.slice(0, 8), total: attention.length, critical: attention.filter((a) => a.severity === 'critical').length }, today_next, operations, participants, finance, venue, workforce, tickets, commercial, procurement, compliance, media, travel, results, ai: aiSection },
  };
}

cap({
  name: 'get_event_control_tower', method: 'GET', path: '/events/:id/control-tower', tag: TAG,
  summary: 'The event manager\'s landing page for one event: readiness with its top blockers and where to fix each, what needs you now (exceptions across tasks, incidents, registrations, tenders, sponsors, compliance), today and what is next, live operations, participants and registration, money, venue, workforce, tickets and access, sponsors and vendors, tenders, compliance, media, travel, results and rule-based risks. Cards are ordered for the event\'s phase (before, during, after). Read live from the owning modules; a section the caller may not see is returned as {available:false}. Organiser, department leads and crew only; everyone else gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ev = await one('SELECT * FROM events WHERE id=$1', [i.id]);
    if (!ev) throw notFound('Event');
    return towerOf(user, ev);
  },
});

/** The few numbers per event that the multi-event strip on the landing page needs: cheap, no cards. */
export async function eventsStrip(user, limit = 12) {
  const events = await many(
    `SELECT e.* FROM events e WHERE (e.organizer_id=$1 OR EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=e.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin')))
       AND e.status NOT IN ('cancelled','completed') ORDER BY e.starts_on NULLS LAST, e.created_at DESC LIMIT $2`, [user.id, limit]);
  const t0 = today();
  const rows = await Promise.all(events.map(async (ev) => {
    const ready = await readinessOf(ev).catch(() => null);
    const daysToGo = ev.starts_on ? daysBetween(t0, dstr(ev.starts_on)) : null;
    const blockers = ready ? ready.items.filter((x) => x.required && x.state === 'open').map((x) => severityOf(x, daysToGo, t0)) : [];
    const pending = await one("SELECT (SELECT count(*)::int FROM event_entries WHERE event_id=$1 AND status='pending') + (SELECT count(*)::int FROM event_tasks WHERE event_id=$1 AND status IN ('todo','doing') AND due_on < current_date) + (SELECT count(*)::int FROM event_incidents WHERE event_id=$1 AND status IN ('open','acknowledged','escalated')) AS n", [ev.id]);
    const needs = blockers.some((s) => s === 'critical') || pending.n > 0;
    return {
      id: ev.id, name: ev.name, status: ev.status, emoji: ev.banner_emoji, starts_on: dstr(ev.starts_on), ends_on: dstr(ev.ends_on), days_to_go: daysToGo, phase: phaseOf(ev.status),
      readiness_percent: ready && ready.items.length ? ready.percent : null, critical: blockers.filter((s) => s === 'critical').length, attention: pending.n + blockers.filter((s) => s === 'critical' || s === 'high').length,
      bucket: needs ? 'attention' : daysToGo != null && daysToGo >= 0 && daysToGo <= 7 ? 'soon' : 'on_track',
    };
  }));
  return { total: rows.length, attention: rows.filter((r) => r.bucket === 'attention').length, starting_soon: rows.filter((r) => r.bucket === 'soon' || (r.days_to_go != null && r.days_to_go >= 0 && r.days_to_go <= 7)).length, on_track: rows.filter((r) => r.bucket === 'on_track').length, events: rows };
}
