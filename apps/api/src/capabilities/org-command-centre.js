// Organisation Command Centre (#573): one operational home for an organisation. It only COMPOSES the canonical records that already exist
// (teams, enrolments, staff, registrations, events, venues, charges, sponsorships, procurement, affiliations, agreements, tasks); it keeps no
// copy of any module's data. The decision queue returns, for every pending item, the existing capability that acts on it, so the app and MCP
// agents call the same domain handlers (with their own role checks, separation of duties and audit) instead of a parallel approval path.
//
//   owner/admin  everything                  finance  money, sponsors' payments and procurement   coach  their own groups, teams and tasks
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { orgFor, lockOrg } from '../org-access.js';
import { ensureCases } from '../collections.js';

const CC_ROLES = ['owner', 'admin', 'coach', 'finance'];
const STAFF = ['owner', 'admin'];
const DOMAINS = ['admissions', 'registrations', 'staff', 'compliance', 'procurement', 'finance', 'sponsors', 'documents', 'tasks'];
const DAY = 864e5;
const num = (n) => Number(n ?? 0);
const sev = (bad, warn) => (bad ? 'bad' : warn ? 'warn' : 'ok');
const plural = (n, one_, many_ = `${one_}s`) => `${n} ${n === 1 ? one_ : many_}`;

// The role a caller may see which domains with. Coaches never see money, staff records or other people's groups.
const SEES = {
  owner: ['teams', 'athletes', 'staff', 'registrations', 'events', 'venues', 'finance', 'sponsors', 'suppliers', 'compliance', 'documents', 'tasks'],
  finance: ['finance', 'sponsors', 'suppliers'],
  coach: ['teams', 'athletes', 'tasks'],
};
SEES.admin = SEES.owner;

// ---------------------------------------------------------------- overview tiles
/** Events this organisation runs, and teams it holds: the two joins most domains hang off. */
const ORG_EVENTS = 'SELECT id FROM events WHERE organisation_id=$1';
const ORG_TEAMS = 'SELECT id FROM teams WHERE organisation_id=$1 AND archived_at IS NULL';
/** Compliance records that belong to this organisation's rulebook or to the rulebook of one of its events. */
const COMP_SCOPE = `((q.scope_kind='organisation' AND q.scope_id=$1) OR (q.scope_kind='event' AND q.scope_id IN (${ORG_EVENTS})))`;

async function tiles(orgId, role, user) {
  const own = role === 'coach' ? user.id : null; // a coach's counts are limited to groups assigned to them
  const want = new Set(SEES[role]);
  const out = [];
  const add = (t) => out.push(t);

  if (want.has('teams')) {
    const r = await one(
      `SELECT (SELECT count(*)::int FROM teams t WHERE t.organisation_id=$1 AND t.archived_at IS NULL AND ($2::uuid IS NULL OR t.id IN (SELECT team_id FROM org_cohorts WHERE organisation_id=$1 AND coach_id=$2 AND team_id IS NOT NULL))) AS teams,
              (SELECT count(*)::int FROM team_members m WHERE m.status='invited' AND m.team_id IN (${ORG_TEAMS})) AS invited`, [orgId, own]);
    add({ key: 'teams', label: 'Teams', severity: 'ok', count: r.teams, summary: r.teams ? `${plural(r.teams, 'team')}${r.invited && !own ? ` · ${r.invited} invitation${r.invited === 1 ? '' : 's'} not answered` : ''}` : 'No teams linked yet', link: { tab: 'assets' } });
  }
  if (want.has('athletes')) {
    const r = await one(
      `SELECT (SELECT count(DISTINCT e.user_id)::int FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.status IN ('enrolled','paused') AND ($2::uuid IS NULL OR k.coach_id=$2)) AS active,
              (SELECT count(*)::int FROM academy_applications WHERE organisation_id=$1 AND stage IN ('submitted','under_review')) AS review,
              (SELECT count(*)::int FROM academy_applications WHERE organisation_id=$1 AND stage='waitlisted') AS waiting`, [orgId, own]);
    add({ key: 'athletes', label: 'Athletes', severity: sev(false, !own && r.review > 0), count: r.active, summary: `${r.active} enrolled${!own ? ` · ${r.review} to review · ${r.waiting} waiting` : ''}`, link: { tab: 'cohorts' } });
  }
  if (want.has('staff')) {
    const r = await one(
      `SELECT (SELECT count(*)::int FROM organisation_members WHERE organisation_id=$1 AND status='active') AS active,
              (SELECT count(*)::int FROM organisation_members WHERE organisation_id=$1 AND status='invited') AS invited,
              (SELECT count(*)::int FROM org_staff_engagements WHERE organisation_id=$1 AND state='active' AND ends_on BETWEEN current_date AND current_date + 30) AS ending,
              (SELECT count(*)::int FROM academy_staff_availability WHERE organisation_id=$1 AND kind='time_off' AND status='pending') AS time_off,
              (SELECT count(*)::int FROM academy_timesheets WHERE organisation_id=$1 AND status='submitted') AS timesheets`, [orgId]);
    add({ key: 'staff', label: 'Coaches & staff', severity: sev(false, r.ending || r.time_off || r.timesheets), count: r.active,
      summary: `${r.active} active${r.invited ? ` · ${r.invited} invited` : ''}${r.ending ? ` · ${plural(r.ending, 'contract')} ending within 30 days` : ''}${r.time_off + r.timesheets ? ` · ${r.time_off + r.timesheets} to approve` : ''}`, link: { tab: 'people' } });
  }
  if (want.has('registrations')) {
    const r = await one(
      `SELECT count(*) FILTER (WHERE r.status IN ('submitted','under_review'))::int AS pending, count(*) FILTER (WHERE r.status='registered')::int AS live,
              count(*) FILTER (WHERE r.status IN ('submitted','under_review') AND r.window_kind IN ('late','emergency','exception'))::int AS late
         FROM reg_registrations r WHERE r.event_id IN (${ORG_EVENTS}) OR r.team_id IN (${ORG_TEAMS})`, [orgId]);
    const ent = await one(`SELECT count(*)::int AS n FROM event_entries WHERE status='pending' AND event_id IN (${ORG_EVENTS})`, [orgId]);
    const n = r.pending + ent.n;
    add({ key: 'registrations', label: 'Registrations', severity: sev(false, n), count: n, summary: `${r.live} registered · ${n} awaiting a decision${r.late ? ` (${r.late} in a late window)` : ''}`, link: { tab: 'assets' } });
  }
  if (want.has('events')) {
    const r = await one(
      `SELECT count(*) FILTER (WHERE status IN ('open','ongoing'))::int AS live, count(*) FILTER (WHERE status='draft')::int AS draft,
              count(*) FILTER (WHERE status IN ('open','draft') AND starts_on BETWEEN current_date AND current_date + 30)::int AS soon
         FROM events WHERE organisation_id=$1`, [orgId]);
    add({ key: 'events', label: 'Competitions & events', severity: 'ok', count: r.live, summary: `${r.live} open or running · ${r.soon} start within 30 days${r.draft ? ` · ${r.draft} in draft` : ''}`, link: { tab: 'assets' } });
  }
  if (want.has('venues')) {
    const r = await one(
      `SELECT (SELECT count(*)::int FROM venues WHERE organisation_id=$1) AS venues,
              (SELECT count(*)::int FROM venue_maintenance m WHERE m.venue_id IN (SELECT id FROM venues WHERE organisation_id=$1) AND m.status IN ('scheduled','in_progress') AND m.due_on < current_date) AS overdue`, [orgId]);
    add({ key: 'venues', label: 'Venues', severity: sev(false, r.overdue), count: r.venues, summary: r.venues ? `${plural(r.venues, 'venue')}${r.overdue ? ` · ${plural(r.overdue, 'maintenance job')} overdue` : ''}` : 'No venues linked yet', link: { tab: 'assets' } });
  }
  if (want.has('finance')) {
    const ac = await many(
      `SELECT currency, count(*)::int AS n, sum(amount_minor - settled_minor - adjusted_minor)::bigint AS minor FROM academy_charges
        WHERE organisation_id=$1 AND status='awaiting_payment' AND due_on < current_date GROUP BY currency`, [orgId]);
    const tc = await many(
      `SELECT b.currency, count(*)::int AS n, sum(c.amount_minor - c.settled_minor - c.adjusted_minor)::bigint AS minor FROM team_charges c JOIN team_charge_batches b ON b.id=c.batch_id
        WHERE c.team_id IN (${ORG_TEAMS}) AND c.status='awaiting_payment' AND c.due_on < current_date GROUP BY b.currency`, [orgId]);
    const by = {};
    for (const r of [...ac, ...tc]) { by[r.currency] ??= { currency: r.currency, items: 0, overdue_minor: 0 }; by[r.currency].items += r.n; by[r.currency].overdue_minor += num(r.minor); }
    const overdue = Object.values(by);
    add({ key: 'finance', label: 'Finance', severity: sev(overdue.length, false), count: overdue.reduce((a, x) => a + x.items, 0), overdue_by_currency: overdue,
      summary: overdue.length ? `Overdue: ${overdue.map((x) => `${x.currency} ${(x.overdue_minor / 100).toFixed(2)}`).join(' · ')}` : 'Nothing overdue', link: { tab: 'collections' } });
  }
  if (want.has('sponsors')) {
    const scope = `(ss.target_type='organisation' AND ss.target_id=$1 OR ss.target_type='group' AND ss.target_id IN (SELECT id FROM org_cohorts WHERE organisation_id=$1)
                    OR ss.target_type='team' AND ss.target_id IN (${ORG_TEAMS}) OR ss.target_type='event' AND ss.target_id IN (${ORG_EVENTS}))`;
    const r = await one(
      `SELECT count(*) FILTER (WHERE ss.status='active')::int AS active, count(*) FILTER (WHERE ss.status='proposed')::int AS offers,
              (SELECT count(*)::int FROM sponsorship_obligations o JOIN sponsorships s2 ON s2.id=o.sponsorship_id WHERE o.status='scheduled' AND o.due_on < current_date AND o.held_by_pause_id IS NULL AND s2.id IN (SELECT ss.id FROM sponsorships ss WHERE ${scope})) AS overdue,
              (SELECT count(*)::int FROM sponsorship_payments p JOIN sponsorship_obligations o ON o.id=p.obligation_id WHERE p.status='reported' AND o.sponsorship_id IN (SELECT ss.id FROM sponsorships ss WHERE ${scope})) AS to_confirm
         FROM sponsorships ss WHERE ${scope}`, [orgId]);
    add({ key: 'sponsors', label: 'Sponsors', severity: sev(false, r.overdue || r.to_confirm || r.offers), count: r.active,
      summary: `${plural(r.active, 'active deal')}${r.offers ? ` · ${plural(r.offers, 'offer')} to answer` : ''}${r.to_confirm ? ` · ${r.to_confirm} payment${r.to_confirm === 1 ? '' : 's'} to confirm` : ''}${r.overdue ? ` · ${plural(r.overdue, 'obligation')} overdue` : ''}`, link: { tab: 'sponsor' } });
  }
  if (want.has('suppliers')) {
    const buyers = `SELECT id FROM svc_buyers WHERE status='active' AND (organisation_id=$1 OR event_id IN (${ORG_EVENTS}))`;
    const r = await one(
      `SELECT (SELECT count(*)::int FROM svc_orders WHERE buyer_id IN (${buyers}) AND status IN ('confirmed','in_progress','pending_supplier')) AS orders,
              (SELECT count(*)::int FROM svc_approvals WHERE buyer_id IN (${buyers}) AND status='pending') AS approvals,
              (SELECT count(*)::int FROM svc_orders WHERE buyer_id IN (${buyers}) AND fulfilment IN ('submitted_for_acceptance','partially_accepted')) AS accept,
              (SELECT count(*)::int FROM svc_invoices WHERE buyer_id IN (${buyers}) AND status='issued' AND pay_status<>'paid' AND due_on < current_date) AS overdue,
              (SELECT count(*)::int FROM proc_approvals a JOIN proc_projects p ON p.id=a.project_id WHERE a.status='pending' AND p.organisation_id=$1) AS tenders`, [orgId]);
    const todo = r.approvals + r.accept + r.tenders;
    add({ key: 'suppliers', label: 'Suppliers & procurement', severity: sev(r.overdue, todo), count: r.orders,
      summary: `${plural(r.orders, 'order')} in progress${todo ? ` · ${todo} to decide` : ''}${r.overdue ? ` · ${plural(r.overdue, 'supplier invoice')} overdue` : ''}`, link: { tab: 'assets' } });
  }
  if (want.has('compliance')) {
    const r = await one(
      `SELECT (SELECT count(*)::int FROM fed_affiliations WHERE organisation_id=$1 AND status='approved' AND effective_to BETWEEN current_date AND current_date + 60) AS ending,
              (SELECT count(*)::int FROM fed_affiliations WHERE organisation_id=$1 AND status IN ('needs_info','expired','suspended')) AS attention,
              (SELECT count(*)::int FROM org_agreements WHERE organisation_id=$1 AND archived_at IS NULL AND status IN ('approved','signed') AND effective_to BETWEEN current_date AND current_date + 60) AS agreements_ending,
              (SELECT count(*)::int FROM accreditations WHERE event_id IN (${ORG_EVENTS}) AND status IN ('submitted','under_review')) AS accreditations,
              (SELECT count(*)::int FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id WHERE k.status='submitted' AND ${COMP_SCOPE}) AS evidence,
              (SELECT count(*)::int FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id WHERE k.status='valid' AND k.expires_on BETWEEN current_date AND current_date + 30 AND ${COMP_SCOPE}) AS evidence_ending,
              (SELECT count(*)::int FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id WHERE k.status='valid' AND k.expires_on < current_date AND ${COMP_SCOPE}) AS evidence_expired`, [orgId]);
    const n = r.ending + r.attention + r.agreements_ending + r.evidence_ending + r.evidence_expired;
    add({ key: 'compliance', label: 'Compliance', severity: sev(r.attention || r.evidence_expired, n || r.accreditations || r.evidence), count: n + r.accreditations + r.evidence,
      summary: n + r.accreditations + r.evidence ? [r.ending && `${plural(r.ending, 'affiliation')} ending within 60 days`, r.attention && `${plural(r.attention, 'affiliation')} needing attention`, r.agreements_ending && `${plural(r.agreements_ending, 'agreement')} ending within 60 days`, r.accreditations && `${plural(r.accreditations, 'accreditation')} to review`, r.evidence && `${plural(r.evidence, 'compliance submission')} to review`, r.evidence_expired && `${r.evidence_expired} expired`, r.evidence_ending && `${r.evidence_ending} expiring within 30 days`].filter(Boolean).join(' · ') : 'Nothing expiring or needing attention', link: { tab: 'compliance' } });
  }
  if (want.has('documents')) {
    const r = await one(
      `SELECT (SELECT count(*)::int FROM org_agreements WHERE organisation_id=$1 AND archived_at IS NULL AND status='submitted') AS approval,
              (SELECT count(*)::int FROM sponsorship_contracts c JOIN sponsorships ss ON ss.id=c.sponsorship_id WHERE c.status='awaiting_signatures' AND (ss.target_type='organisation' AND ss.target_id=$1 OR ss.target_type='team' AND ss.target_id IN (${ORG_TEAMS}) OR ss.target_type='event' AND ss.target_id IN (${ORG_EVENTS}))) AS contracts,
              (SELECT count(*)::int FROM svc_orders WHERE agreement_status='pending_signature' AND buyer_id IN (SELECT id FROM svc_buyers WHERE organisation_id=$1 OR event_id IN (${ORG_EVENTS}))) AS supplier`, [orgId]);
    const n = r.approval + r.contracts + r.supplier;
    add({ key: 'documents', label: 'Documents', severity: sev(false, n), count: n, summary: n ? `${r.approval} to approve · ${r.contracts + r.supplier} awaiting signature` : 'Nothing waiting for approval or signature', link: { tab: 'agreements' } });
  }
  if (want.has('tasks')) {
    const t = await taskRows(orgId, own, 200);
    const overdue = t.filter((x) => x.overdue).length;
    add({ key: 'tasks', label: 'Open tasks', severity: sev(false, overdue), count: t.length, summary: t.length ? `${plural(t.length, 'open task')}${overdue ? ` · ${overdue} overdue` : ''}` : 'No open tasks', link: { filter: 'tasks' } });
  }
  return out;
}

// ---------------------------------------------------------------- open tasks (team board, event plan, sponsor deals)
async function taskRows(orgId, ownUserId, limit) {
  const rows = await many(
    `SELECT * FROM (
       SELECT 'team' AS source, t.id, t.title, t.due_on, tm.name AS context, t.team_id AS context_id FROM team_tasks t JOIN teams tm ON tm.id=t.team_id
        WHERE tm.organisation_id=$1 AND t.archived_at IS NULL AND t.status<>'done' AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM team_task_assignees a WHERE a.task_id=t.id AND a.user_id=$2))
       UNION ALL
       SELECT 'event', t.id, t.title, t.due_on, ev.name, t.event_id FROM event_tasks t JOIN events ev ON ev.id=t.event_id
        WHERE ev.organisation_id=$1 AND t.status NOT IN ('done','dropped') AND ($2::uuid IS NULL OR t.owner_id=$2)
       UNION ALL
       SELECT 'sponsor', t.id, t.title, t.due_on, 'Sponsor deal', t.sponsorship_id FROM sponsorship_tasks t JOIN sponsorships ss ON ss.id=t.sponsorship_id
        WHERE t.status='open' AND t.side='recipient' AND ($2::uuid IS NULL OR t.assignee_id=$2)
          AND (ss.target_type='organisation' AND ss.target_id=$1 OR ss.target_type='team' AND ss.target_id IN (${ORG_TEAMS}) OR ss.target_type='event' AND ss.target_id IN (${ORG_EVENTS}) OR ss.target_type='group' AND ss.target_id IN (SELECT id FROM org_cohorts WHERE organisation_id=$1))
     ) x ORDER BY due_on NULLS LAST, title LIMIT $3`, [orgId, ownUserId, limit]);
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => ({ ...r, due_on: r.due_on ? new Date(r.due_on).toISOString().slice(0, 10) : null, overdue: !!r.due_on && new Date(r.due_on).toISOString().slice(0, 10) < today }));
}

cap({
  name: 'get_org_command_centre', method: 'GET', path: '/organisations/:id/command-centre', tag: 'Organisations',
  summary: 'Command Centre overview for your role: one tile per area (teams, athletes, coaches & staff, registrations, competitions & events, venues, finance, sponsors, suppliers & procurement, compliance, documents, open tasks) with a plain-language summary, a severity (ok, warn, bad) and where it opens, plus the alerts that need attention and how many decisions are waiting. Owners and admins see everything; finance sees money, sponsor payments and procurement; a coach sees only their own groups, teams and tasks. Money is per currency and never added across currencies. It reads the canonical records and stores nothing of its own.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { org, role } = await orgFor(user, i.id, CC_ROLES);
    const list = await tiles(i.id, role, user);
    const queue = await queueItems(org, role, user, null);
    const order = { bad: 0, warn: 1, ok: 2 };
    const out = {
      organisation: { id: org.id, name: org.name, kind: org.kind, status: org.status }, role,
      tiles: list.sort((a, b) => order[a.severity] - order[b.severity]),
      alerts: list.filter((t) => t.severity !== 'ok').map((t) => ({ key: t.key, label: t.label, severity: t.severity, summary: t.summary, link: t.link })),
      waiting: { total: queue.length, by_domain: Object.fromEntries(DOMAINS.map((d) => [d, queue.filter((x) => x.domain === d).length]).filter(([, n]) => n)) },
    };
    await audit(null, user.id, 'read_org_command_centre', 'organisations', i.id);
    return out;
  },
});

cap({
  name: 'list_org_open_tasks', method: 'GET', path: '/organisations/:id/command-centre/tasks', tag: 'Organisations',
  summary: 'Open tasks across the organisation\'s team boards, event plans and sponsor deals, soonest due first, each with the record it belongs to. Owners and admins see all; a coach sees tasks assigned to them. Update a task with update_team_task, update_event_task or the sponsorship task capability.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id, ['owner', 'admin', 'coach']);
    return (await taskRows(i.id, role === 'coach' ? user.id : null, 500)).slice(i.offset, i.offset + i.limit);
  },
});

// ---------------------------------------------------------------- decision queue
const act = (label, cap_, method, path, body, extra = {}) => ({ label, cap: cap_, method, path, body, ...extra });
const dstr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const ago = (d) => (d ? new Date(d).toISOString() : null);
/** The screen that owns a record, opened on exactly that record: { screen, params } is an app route (push(screen, params)). */
const rec = (screen, params) => ({ screen, params });
/** Fields an action needs from the person (shown as a small form): kind is text, date, amount (major units, sent as minor) or choice. */
const F = {
  reason: { key: 'reason', label: 'Reason', kind: 'text', required: true },
  optReason: { key: 'reason', label: 'Reason (optional)', kind: 'text' },
  note: { key: 'note', label: 'Note', kind: 'text', required: true },
};
const orgTab = (org, tab, focusTab) => rec('Org', { id: org.id, tab: org.kind === 'academy' ? 'academy' : tab, ...(org.kind === 'academy' && focusTab ? { focus: { tab: focusTab } } : {}) });
const money = (minor, cur) => `${cur} ${(num(minor) / 100).toFixed(2)}`;

/** Every pending decision, each carrying the existing capability that resolves it. `can_act` is false when the caller's role cannot decide it (they can still open the record). */
async function queueItems(org, role, user, only) {
  const orgId = org.id;
  const staff = STAFF.includes(role);
  const items = [];
  const run = (domain, fn) => (only && only !== domain ? null : fn());
  const SCOPE = `(ss.target_type='organisation' AND ss.target_id=$1 OR ss.target_type='group' AND ss.target_id IN (SELECT id FROM org_cohorts WHERE organisation_id=$1)
                   OR ss.target_type='team' AND ss.target_id IN (${ORG_TEAMS}) OR ss.target_type='event' AND ss.target_id IN (${ORG_EVENTS}))`;
  const BUYERS = `SELECT id FROM svc_buyers WHERE status='active' AND (organisation_id=$1 OR event_id IN (${ORG_EVENTS}))`;

  if (staff) {
    await run('admissions', async () => {
      const rows = await many(
        `SELECT a.id, a.stage, a.row_version, a.created_at, a.updated_at, p.title, u.display_name AS athlete FROM academy_applications a
           JOIN academy_programmes p ON p.id=a.programme_id LEFT JOIN users u ON u.id=a.athlete_id
          WHERE a.organisation_id=$1 AND a.stage IN ('submitted','under_review') ORDER BY a.updated_at LIMIT 50`, [orgId]);
      for (const r of rows) items.push({ key: `admissions:${r.id}`, domain: 'admissions', title: `${r.athlete ?? 'An applicant'} · ${r.title}`, sub: r.stage === 'submitted' ? 'Application to review' : 'Application under review', at: ago(r.updated_at), can_act: true,
        record: org.kind === 'academy' ? rec('Org', { id: orgId, tab: 'academy', focus: { tab: 'admissions', open: r.id } }) : rec('Org', { id: orgId, tab: 'admissions' }), actions: [
          act('Offer a place', 'decide_academy_application', 'POST', `/academy/applications/${r.id}/decision`, { row_version: r.row_version, decision: 'offer' }, { tone: 'primary' }),
          act('Waitlist', 'decide_academy_application', 'POST', `/academy/applications/${r.id}/decision`, { row_version: r.row_version, decision: 'waitlist' }),
          act('Decline', 'decide_academy_application', 'POST', `/academy/applications/${r.id}/decision`, { row_version: r.row_version, decision: 'decline' }, { tone: 'danger', ask: [F.reason] }),
        ] });
    });
    await run('registrations', async () => {
      const rows = await many(
        `SELECT r.id, r.event_id, r.status, r.row_version, r.window_kind, r.updated_at, ev.organisation_id AS event_org, ev.name AS event, t.name AS team, u.display_name AS person FROM reg_registrations r
           JOIN events ev ON ev.id=r.event_id LEFT JOIN teams t ON t.id=r.team_id LEFT JOIN users u ON u.id=r.user_id
          WHERE r.status IN ('submitted','under_review') AND (ev.organisation_id=$1 OR t.organisation_id=$1) ORDER BY r.updated_at LIMIT 50`, [orgId]);
      for (const r of rows) {
        const canDecide = r.event_org === orgId; // only the organising side decides; the entering club just sees it
        items.push({ key: `registrations:${r.id}`, domain: 'registrations', title: `${r.team ?? r.person ?? 'Entry'} · ${r.event}`, sub: `Registration ${r.status === 'submitted' ? 'submitted' : 'under review'}${r.window_kind !== 'regular' && r.window_kind !== 'open' ? ` · ${r.window_kind} window` : ''}`, at: ago(r.updated_at), can_act: canDecide,
          record: rec('EventCommand', { id: r.event_id, tab: 'registration' }), actions: canDecide ? [
            act('Register', 'review_registration', 'POST', `/registrations/${r.id}/review`, { action: 'register', row_version: r.row_version }, { tone: 'primary' }),
            act('Reject', 'review_registration', 'POST', `/registrations/${r.id}/review`, { action: 'reject', row_version: r.row_version }, { tone: 'danger', ask: [F.reason] }),
          ] : [] });
      }
      const ent = await many(
        `SELECT e.id, e.event_id, e.created_at, ev.name AS event, t.name AS team, u.display_name AS person FROM event_entries e JOIN events ev ON ev.id=e.event_id LEFT JOIN teams t ON t.id=e.team_id LEFT JOIN users u ON u.id=e.user_id
          WHERE e.status='pending' AND ev.organisation_id=$1 ORDER BY e.created_at LIMIT 50`, [orgId]);
      for (const r of ent) items.push({ key: `registrations:entry:${r.id}`, domain: 'registrations', title: `${r.team ?? r.person ?? 'Entry'} · ${r.event}`, sub: 'Entry request', at: ago(r.created_at), can_act: true, record: rec('EventCommand', { id: r.event_id, tab: 'teams' }), actions: [
        act('Accept', 'decide_entry', 'PATCH', `/entries/${r.id}`, { status: 'accepted' }, { tone: 'primary' }), act('Reject', 'decide_entry', 'PATCH', `/entries/${r.id}`, { status: 'rejected' }, { tone: 'danger' })] });
    });
    await run('staff', async () => {
      const off = await many(
        `SELECT s.id, s.on_date, s.ends_on, s.created_at, u.display_name AS person FROM academy_staff_availability s JOIN users u ON u.id=s.user_id
          WHERE s.organisation_id=$1 AND s.kind='time_off' AND s.status='pending' AND s.user_id<>$2 ORDER BY s.created_at LIMIT 50`, [orgId, user.id]);
      for (const r of off) items.push({ key: `staff:off:${r.id}`, domain: 'staff', title: `${r.person} · time off`, sub: `${dstr(r.on_date)}${r.ends_on ? ` to ${dstr(r.ends_on)}` : ''} · approving opens cover for affected sessions`, at: ago(r.created_at), can_act: true, record: orgTab(org, 'people', 'ops'), actions: [
        act('Approve', 'decide_academy_time_off', 'POST', `/academy/time-off/${r.id}/decision`, { approve: true }, { tone: 'primary' }), act('Decline', 'decide_academy_time_off', 'POST', `/academy/time-off/${r.id}/decision`, { approve: false }, { tone: 'danger' })] });
      const ts = await many(
        `SELECT t.id, t.work_date, t.minutes, t.updated_at, u.display_name AS person FROM academy_timesheets t JOIN users u ON u.id=t.user_id
          WHERE t.organisation_id=$1 AND t.status='submitted' AND t.user_id<>$2 ORDER BY t.updated_at LIMIT 50`, [orgId, user.id]);
      for (const r of ts) items.push({ key: `staff:ts:${r.id}`, domain: 'staff', title: `${r.person} · timesheet`, sub: `${dstr(r.work_date)} · ${Math.round(num(r.minutes) / 6) / 10} h`, at: ago(r.updated_at), can_act: true, record: orgTab(org, 'people', 'ops'), actions: [
        act('Approve', 'decide_academy_timesheet', 'POST', `/academy/timesheets/${r.id}/decision`, { action: 'approve' }, { tone: 'primary' }), act('Reject', 'decide_academy_timesheet', 'POST', `/academy/timesheets/${r.id}/decision`, { action: 'reject' }, { tone: 'danger', ask: [F.reason] })] });
    });
    await run('compliance', async () => {
      if (role === 'owner') {
        const ag = await many("SELECT id, title, kind, submitted_at FROM org_agreements WHERE organisation_id=$1 AND archived_at IS NULL AND status='submitted' ORDER BY submitted_at LIMIT 50", [orgId]);
        for (const r of ag) items.push({ key: `compliance:agreement:${r.id}`, domain: 'compliance', title: r.title, sub: 'Agreement submitted for approval', at: ago(r.submitted_at), can_act: true, record: orgTab(org, 'agreements', 'agreements'), actions: [
          act('Approve', 'decide_org_agreement', 'POST', `/org-agreements/${r.id}/decision`, { decision: 'approve' }, { tone: 'primary' }),
          act('Request changes', 'decide_org_agreement', 'POST', `/org-agreements/${r.id}/decision`, { decision: 'request_changes' }, { ask: [F.note] }),
          act('Reject', 'decide_org_agreement', 'POST', `/org-agreements/${r.id}/decision`, { decision: 'reject' }, { tone: 'danger', ask: [F.note] })] });
      }
      const evid = await many(
        `SELECT k.id, k.submitted_at, q.name AS requirement, q.category, k.subject_kind, k.subject_id, (CASE k.subject_kind WHEN 'person' THEN (SELECT display_name FROM users WHERE id=k.subject_id) WHEN 'organisation' THEN (SELECT name FROM organisations WHERE id=k.subject_id) ELSE (SELECT name FROM events WHERE id=k.subject_id) END) AS who
           FROM comp_records k JOIN comp_requirements q ON q.id=k.requirement_id WHERE k.status='submitted' AND k.submitted_by<>$2 AND NOT (k.subject_kind='person' AND k.subject_id=$2) AND ${COMP_SCOPE} ORDER BY k.submitted_at LIMIT 50`, [orgId, user.id]);
      for (const r of evid) items.push({ key: `compliance:record:${r.id}`, domain: 'compliance', title: `${r.who} · ${r.requirement}`, sub: 'Evidence to review', at: ago(r.submitted_at), can_act: true, record: { screen: 'Org', tab: 'compliance' }, actions: [
        act('Approve', 'decide_compliance_record', 'POST', `/compliance/records/${r.id}/decision`, { decision: 'approve' }, { tone: 'primary' }),
        act('Reject', 'decide_compliance_record', 'POST', `/compliance/records/${r.id}/decision`, { decision: 'reject' }, { tone: 'danger', ask: 'reason' })] });
      const acc = await many(
        `SELECT a.id, a.event_id, a.status, a.submitted_at, ev.name AS event, u.display_name AS person FROM accreditations a JOIN events ev ON ev.id=a.event_id JOIN users u ON u.id=a.holder_id
          WHERE ev.organisation_id=$1 AND a.status IN ('submitted','under_review') AND a.holder_id<>$2 ORDER BY a.submitted_at LIMIT 50`, [orgId, user.id]);
      for (const r of acc) items.push({ key: `compliance:accreditation:${r.id}`, domain: 'compliance', title: `${r.person} · ${r.event}`, sub: 'Accreditation to review', at: ago(r.submitted_at), can_act: true, record: rec('EventCommand', { id: r.event_id, tab: 'accreditation' }), actions: [
        act('Approve', 'decide_accreditation', 'POST', `/accreditations/${r.id}/decision`, { decision: 'approve' }, { tone: 'primary' }), act('Reject', 'decide_accreditation', 'POST', `/accreditations/${r.id}/decision`, { decision: 'reject' }, { tone: 'danger', ask: [F.reason] })] });
    });
  }

  if (staff || role === 'finance') {
    await run('sponsors', async () => {
      const pay = await many(
        `SELECT p.id, p.amount_cents, p.currency, p.reference, p.created_at, o.sponsorship_id FROM sponsorship_payments p JOIN sponsorship_obligations o ON o.id=p.obligation_id JOIN sponsorships ss ON ss.id=o.sponsorship_id
          WHERE p.status='reported' AND ${SCOPE} ORDER BY p.created_at LIMIT 50`, [orgId]);
      for (const r of pay) items.push({ key: `sponsors:payment:${r.id}`, domain: 'sponsors', title: `${money(r.amount_cents, r.currency)} reported by a sponsor`, sub: `Reference ${r.reference} · confirm it arrived`, at: ago(r.created_at), can_act: staff, record: rec('SponsorDeal', { id: r.sponsorship_id }),
        actions: staff ? [act('Confirm received', 'decide_sponsorship_payment', 'PATCH', `/sponsorship-payments/${r.id}`, { status: 'confirmed' }, { tone: 'primary' }), act('Not received', 'decide_sponsorship_payment', 'PATCH', `/sponsorship-payments/${r.id}`, { status: 'rejected' }, { tone: 'danger', ask: [F.note] })] : [] });
      // offers made by a sponsor that this organisation has not answered (an offer its own staff proposed is waiting on the sponsor, not on us)
      const offers = await many(
        `SELECT ss.id, ss.target_type, ss.amount_cents, ss.currency, ss.terms_version, ss.created_at, sp.name AS sponsor FROM sponsorships ss JOIN sponsors sp ON sp.id=ss.sponsor_id
          WHERE ss.status='proposed' AND coalesce(ss.budget_approval,'') NOT IN ('pending','rejected') AND ${SCOPE}
            AND NOT EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=$1 AND m.user_id=ss.proposed_by AND m.status='active') ORDER BY ss.created_at LIMIT 50`, [orgId]);
      for (const r of offers) {
        const direct = staff && ['organisation', 'group'].includes(r.target_type); // for a team or event target the team owner / organiser decides in the deal screen
        items.push({ key: `sponsors:offer:${r.id}`, domain: 'sponsors', title: `${r.sponsor} · ${money(r.amount_cents, r.currency ?? 'INR')}`, sub: 'Sponsorship offer to answer', at: ago(r.created_at), can_act: direct, record: rec('SponsorDeal', { id: r.id }), open_label: direct ? undefined : 'Review offer',
          actions: direct ? [act('Accept offer', 'decide_sponsorship', 'PATCH', `/sponsorships/${r.id}`, { status: 'active', version: r.terms_version }, { tone: 'primary' }), act('Decline', 'decide_sponsorship', 'PATCH', `/sponsorships/${r.id}`, { status: 'declined', version: r.terms_version }, { tone: 'danger', ask: [F.optReason] })] : [] });
      }
    });
    await run('procurement', async () => {
      const ap = await many(
        `SELECT a.id, a.subject_type, a.amount_minor, a.currency, a.created_at, b.organisation_id AS b_org, b.event_id AS b_event FROM svc_approvals a JOIN svc_buyers b ON b.id=a.buyer_id
          WHERE a.status='pending' AND a.requested_by<>$2 AND a.buyer_id IN (${BUYERS}) ORDER BY a.created_at LIMIT 50`, [orgId, user.id]);
      for (const r of ap) items.push({ key: `procurement:approval:${r.id}`, domain: 'procurement', title: `${r.subject_type.replace('_', ' ')} · ${money(r.amount_minor, r.currency)}`, sub: 'Supplier approval', at: ago(r.created_at), can_act: staff, record: r.b_event ? rec('ServicesBuyer', { event_id: r.b_event }) : rec('ServicesBuyer', { organisation_id: orgId }),
        actions: staff ? [act('Approve', 'decide_service_approval', 'POST', `/service-approvals/${r.id}/decision`, { approve: true }, { tone: 'primary' }), act('Reject', 'decide_service_approval', 'POST', `/service-approvals/${r.id}/decision`, { approve: false }, { tone: 'danger', ask: [F.note] })] : [] });
      // an order whose agreement is waiting for this side's signature
      const ag = await many(
        `SELECT o.id, o.number, o.gross_minor, o.currency, o.updated_at, b.event_id AS b_event FROM svc_orders o JOIN svc_buyers b ON b.id=o.buyer_id
          WHERE o.agreement_status='pending_signature' AND o.buyer_id IN (${BUYERS}) ORDER BY o.updated_at LIMIT 50`, [orgId]);
      for (const r of ag) items.push({ key: `procurement:agreement:${r.id}`, domain: 'procurement', title: `Order ${r.number} · ${money(r.gross_minor, r.currency)}`, sub: 'Service agreement to sign', at: ago(r.updated_at), can_act: staff, record: r.b_event ? rec('ServicesBuyer', { event_id: r.b_event }) : rec('ServicesBuyer', { organisation_id: orgId }),
        actions: staff ? [act('Sign', 'sign_service_agreement', 'POST', `/service-orders/${r.id}/agreement`, {}, { tone: 'primary', ask: [{ key: 'typed_name', label: 'Type your full name to sign', kind: 'line', required: true }] })] : [] });
      // supplier invoices past their due date
      const inv = await many(
        `SELECT i.id, i.supplier_number, i.currency, i.payable_minor, i.paid_minor, i.due_on, b.event_id AS b_event FROM svc_invoices i JOIN svc_buyers b ON b.id=i.buyer_id
          WHERE i.status='issued' AND i.pay_status<>'paid' AND i.due_on < current_date AND i.buyer_id IN (${BUYERS}) ORDER BY i.due_on LIMIT 50`, [orgId]);
      for (const r of inv) {
        const owing = num(r.payable_minor) - num(r.paid_minor);
        items.push({ key: `procurement:invoice:${r.id}`, domain: 'procurement', title: `Invoice ${r.supplier_number} · ${money(owing, r.currency)} owing`, sub: `Supplier invoice overdue since ${dstr(r.due_on)}`, at: ago(r.due_on), can_act: staff || role === 'finance', record: r.b_event ? rec('ServicesBuyer', { event_id: r.b_event }) : rec('ServicesBuyer', { organisation_id: orgId }),
          actions: [act('Record payment', 'record_service_payment', 'POST', `/service-invoices/${r.id}/payments`, { source: 'manual_bank' }, { tone: 'primary', ask: [
            { key: 'amount_minor', label: `Amount paid (${r.currency})`, kind: 'amount', currency: r.currency, default_minor: owing, required: true },
            { key: 'paid_on', label: 'Paid on', kind: 'date', default: new Date().toISOString().slice(0, 10), required: true },
            { key: 'reference', label: 'Bank reference', kind: 'line', required: true },
            { key: 'evidence', label: 'Evidence (for example "bank statement 12 March")', kind: 'line', required: true }] })] });
      }
    });
    await run('finance', async () => {
      // unpaid charges that have gone overdue: the collections cases nobody has a promise or a hold on (cases are opened from unpaid charges, as the collections screen does)
      await tx(async (c) => { await ensureCases(c, 'organisation', orgId); for (const t of (await c.query(ORG_TEAMS, [orgId])).rows) await ensureCases(c, 'team', t.id); });
      const cases = await many(
        `SELECT cs.id, cs.owner_type, cs.owner_id, cs.state, cs.currency, cs.due_on, u.display_name AS payer,
                CASE cs.source_type WHEN 'academy_charge' THEN (SELECT ac.amount_minor - ac.settled_minor - ac.adjusted_minor FROM academy_charges ac WHERE ac.id=cs.source_id)
                                    ELSE (SELECT tc.amount_minor - tc.settled_minor - tc.adjusted_minor FROM team_charges tc WHERE tc.id=cs.source_id) END AS balance
           FROM collection_cases cs LEFT JOIN users u ON u.id=cs.payer_id
          WHERE ((cs.owner_type='organisation' AND cs.owner_id=$1) OR (cs.owner_type='team' AND cs.owner_id IN (${ORG_TEAMS}))) AND cs.state IN ('overdue','escalated','failed','retrying')
            AND (cs.promised_on IS NULL OR cs.promised_on < current_date) AND (cs.hold_until IS NULL OR cs.hold_until < current_date) ORDER BY cs.due_on LIMIT 50`, [orgId]);
      for (const r of cases) items.push({ key: `finance:case:${r.id}`, domain: 'finance', title: `${r.payer ?? 'A payer'} · ${money(r.balance, r.currency)} overdue`, sub: `Due ${dstr(r.due_on)} · ${r.state}`, at: ago(r.due_on), can_act: true,
        record: r.owner_type === 'team' ? rec('TeamDues', { id: r.owner_id }) : orgTab(org, 'collections', 'billing'), actions: [
          act('Record a promise to pay', 'act_on_collection_case', 'POST', `/collections/cases/${r.id}/actions`, { action: 'promise' }, { tone: 'primary', ask: [{ key: 'promised_on', label: 'Promised to pay by', kind: 'date', required: true }] }),
          act('Add a note', 'act_on_collection_case', 'POST', `/collections/cases/${r.id}/actions`, { action: 'note' }, { ask: [F.note] })] });
    });
    if (staff) await run('documents', async () => {
      // a sponsor contract is signed on the contract screen: the text and its fingerprint must be reviewed, so there is no one-tap signature
      const ct = await many(
        `SELECT c.id, c.sponsorship_id, c.requested_at, sp.name AS sponsor, EXISTS (SELECT 1 FROM sponsorship_signatories g WHERE g.contract_id=c.id AND g.user_id=$2 AND g.status='pending') AS mine
           FROM sponsorship_contracts c JOIN sponsorships ss ON ss.id=c.sponsorship_id JOIN sponsors sp ON sp.id=ss.sponsor_id WHERE c.status='awaiting_signatures' AND ${SCOPE} ORDER BY c.requested_at LIMIT 50`, [orgId, user.id]);
      for (const r of ct) items.push({ key: `documents:contract:${r.id}`, domain: 'documents', title: `${r.sponsor} · sponsorship contract`, sub: r.mine ? 'Waiting for your signature' : 'Waiting for signatures', at: ago(r.requested_at), can_act: r.mine, record: rec('SponsorDeal', { id: r.sponsorship_id }), open_label: r.mine ? 'Review & sign' : 'Open', actions: [] });
    });
  }

  if (staff || role === 'coach') {
    await run('tasks', async () => {
      const ts = await taskRows(orgId, role === 'coach' ? user.id : null, 100);
      for (const t of ts.filter((x) => x.overdue)) items.push({ key: `tasks:${t.source}:${t.id}`, domain: 'tasks', title: t.title, sub: `${t.context} · was due ${t.due_on}`, at: t.due_on ? `${t.due_on}T00:00:00.000Z` : null, can_act: false,
        record: t.source === 'team' ? rec('TeamWorkspace', { id: t.context_id }) : t.source === 'event' ? rec('EventCommand', { id: t.context_id, tab: 'boards' }) : rec('SponsorDeal', { id: t.context_id }), actions: [] });
    });
  }
  return items.sort((a, b) => (a.at ?? '9').localeCompare(b.at ?? '9'));
}

cap({
  name: 'list_org_approvals', method: 'GET', path: '/organisations/:id/command-centre/approvals', tag: 'Organisations',
  summary: 'Everything waiting on this organisation, oldest first: admissions to review, registrations and entries, staff time off and timesheets, agreements and accreditations, sponsor payments, supplier and tender approvals, and overdue tasks. Each item names the area, the record, and the actions that resolve it: every action is an existing capability (cap, method, path, body) you call yourself; where `ask` is set (reason or note) the caller must supply it. Items you may view but not decide have no actions. Filter with `domain`.',
  input: z.object({ id, domain: z.enum(DOMAINS).optional(), ...page }),
  async handler({ user }, i) {
    const { org, role } = await orgFor(user, i.id, CC_ROLES);
    const all = await queueItems(org, role, user, i.domain ?? null);
    await audit(null, user.id, 'read_org_approvals', 'organisations', i.id);
    return { total: all.length, items: all.slice(i.offset, i.offset + i.limit) };
  },
});

// ---------------------------------------------------------------- season rollover
const carry = z.object({ cohorts: z.boolean().default(true), coaches: z.boolean().default(true), team_links: z.boolean().default(true) });
const isoDay = z.string().date();

cap({
  name: 'rollover_org_season', method: 'POST', path: '/organisations/:id/seasons/:season_id/rollover', tag: 'Organisations', status: 201,
  summary: 'Start the next season from an existing one (owner/admin). The groups of the source season are copied into the new season with the same name and capacity; coaches (only if still active staff) and team links carry over if you leave them on. Enrolments, attendance and charges are NOT copied: they stay with the old season. Nothing is deleted. Use `dry_run` to see exactly what would be created. A group is rolled once per season, so repeating the call cannot duplicate it.',
  input: z.object({ id, season_id: id, name: z.string().trim().min(2).max(80), starts_on: isoDay, ends_on: isoDay, carry: carry.default({ cohorts: true, coaches: true, team_links: true }), archive_previous: z.boolean().default(false).describe('mark the source season archived once the new one exists'), dry_run: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    await lockOrg(c, i.id);
    await orgFor(user, i.id, STAFF, { write: true, c });
    const src = (await c.query('SELECT * FROM org_seasons WHERE id=$1 AND organisation_id=$2', [i.season_id, i.id])).rows[0];
    if (!src) throw notFound('Season');
    if (i.ends_on < i.starts_on) throw badRequest('A season cannot end before it starts');
    if (i.starts_on <= dstr(src.ends_on)) throw badRequest('The new season should start after the source season ends');
    const groups = i.carry.cohorts ? (await c.query("SELECT * FROM org_cohorts WHERE organisation_id=$1 AND season_id=$2 AND status='active' ORDER BY name", [i.id, src.id])).rows : [];
    const staff = new Set((await c.query("SELECT user_id FROM organisation_members WHERE organisation_id=$1 AND status='active' AND role IN ('coach','admin','owner')", [i.id])).rows.map((r) => r.user_id));
    const teams = new Set((await c.query('SELECT id FROM teams WHERE organisation_id=$1', [i.id])).rows.map((r) => r.id));
    const plan = groups.map((g) => ({ source_id: g.id, name: g.name, capacity: g.capacity, programme_id: g.programme_id, coach_id: i.carry.coaches && g.coach_id && staff.has(g.coach_id) ? g.coach_id : null, team_id: i.carry.team_links && g.team_id && teams.has(g.team_id) ? g.team_id : null,
      dropped: [g.coach_id && i.carry.coaches && !staff.has(g.coach_id) ? 'coach is no longer active staff' : null, g.team_id && i.carry.team_links && !teams.has(g.team_id) ? 'team is no longer linked' : null].filter(Boolean) }));
    if (i.dry_run) return { dry_run: true, season: { name: i.name, starts_on: i.starts_on, ends_on: i.ends_on, rolled_from_id: src.id }, cohorts: plan, not_copied: ['enrolments', 'attendance', 'charges'] };
    const season = (await c.query('INSERT INTO org_seasons(organisation_id, name, starts_on, ends_on, rolled_from_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organisation_id, name) DO NOTHING RETURNING *', [i.id, i.name, i.starts_on, i.ends_on, src.id])).rows[0];
    if (!season) throw conflict('A season with that name already exists');
    const created = [];
    for (const p of plan) {
      const k = (await c.query('INSERT INTO org_cohorts(organisation_id, name, season_id, team_id, coach_id, programme_id, capacity, rolled_from_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name', [i.id, p.name, season.id, p.team_id, p.coach_id, p.programme_id, p.capacity, p.source_id])).rows[0];
      created.push({ ...k, source_id: p.source_id, dropped: p.dropped });
    }
    if (i.archive_previous) await c.query("UPDATE org_seasons SET status='archived' WHERE id=$1", [src.id]);
    await audit(c, user.id, 'rollover_org_season', 'organisations', i.id);
    return { season, cohorts: created, not_copied: ['enrolments', 'attendance', 'charges'] };
  }),
});

// ---------------------------------------------------------------- templates
const STRUCT = z.object({ departments: z.array(z.string()).default([]), cohorts: z.array(z.object({ name: z.string(), capacity: z.number().int().nullable().optional() })).default([]) });

cap({
  name: 'save_org_template', method: 'POST', path: '/organisations/:id/templates', tag: 'Organisations', status: 201,
  summary: 'Save this organisation\'s structure (its departments and the group names and capacities of one season) as a reusable template (owner/admin). A template holds no people, money or personal data. Owners and admins of the organisation can apply it to another organisation they run.',
  input: z.object({ id, name: z.string().trim().min(2).max(80), season_id: id.optional().describe('the season whose groups to save; omit to save departments only') }),
  handler: ({ user }, i) => tx(async (c) => {
    const { org } = await orgFor(user, i.id, STAFF, { write: true, c });
    const deps = (await c.query('SELECT name FROM org_departments WHERE organisation_id=$1 AND archived_at IS NULL ORDER BY lower(name)', [i.id])).rows.map((r) => r.name);
    let cohorts = [];
    if (i.season_id) {
      if (!(await c.query('SELECT 1 FROM org_seasons WHERE id=$1 AND organisation_id=$2', [i.season_id, i.id])).rowCount) throw notFound('Season');
      cohorts = (await c.query("SELECT name, capacity FROM org_cohorts WHERE organisation_id=$1 AND season_id=$2 AND status='active' ORDER BY name", [i.id, i.season_id])).rows;
    }
    const t = (await c.query('INSERT INTO org_templates(organisation_id, name, kind, structure, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id, organisation_id, name, kind, structure, created_at', [i.id, i.name, org.kind, { departments: deps, cohorts }, user.id])).rows[0];
    if (!t) throw conflict('A template with that name already exists');
    await audit(c, user.id, 'save_org_template', 'organisations', i.id);
    return t;
  }),
});

cap({
  name: 'list_org_templates', method: 'GET', path: '/organisations/:id/templates', tag: 'Organisations',
  summary: 'Templates you can apply to this organisation: those saved from any organisation where you are an owner or admin (owner/admin here).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    await orgFor(user, i.id, STAFF);
    return many(
      `SELECT t.id, t.name, t.kind, t.structure, t.created_at, o.name AS from_organisation, t.organisation_id
         FROM org_templates t JOIN organisations o ON o.id=t.organisation_id
        WHERE t.archived_at IS NULL AND t.organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin'))
        ORDER BY (t.organisation_id=$2) DESC, lower(t.name), t.id LIMIT $3 OFFSET $4`, [user.id, i.id, i.limit, i.offset]);
  },
});

cap({
  name: 'apply_org_template', method: 'POST', path: '/organisations/:id/templates/:template_id/apply', tag: 'Organisations',
  summary: 'Apply a saved template to this organisation (owner/admin): missing departments are added, and the template\'s groups are created in the chosen season unless a group with that name already exists there. Existing records are never changed. Use `dry_run` to preview.',
  input: z.object({ id, template_id: id, season_id: id.optional().describe('the season to create the groups in; required if the template has groups'), dry_run: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    await lockOrg(c, i.id);
    await orgFor(user, i.id, STAFF, { write: true, c });
    const t = (await c.query(
      `SELECT * FROM org_templates WHERE id=$1 AND archived_at IS NULL AND organisation_id IN (SELECT organisation_id FROM organisation_members WHERE user_id=$2 AND status='active' AND role IN ('owner','admin'))`, [i.template_id, user.id])).rows[0];
    if (!t) throw notFound('Template');
    const s = STRUCT.parse(t.structure);
    if (s.cohorts.length) {
      if (!i.season_id) throw badRequest('Choose the season to create the template\'s groups in');
      if (!(await c.query("SELECT 1 FROM org_seasons WHERE id=$1 AND organisation_id=$2 AND status='active'", [i.season_id, i.id])).rowCount) throw badRequest('That season is not an active season of this organisation');
    }
    const haveDeps = new Set((await c.query('SELECT lower(name) AS n FROM org_departments WHERE organisation_id=$1 AND archived_at IS NULL', [i.id])).rows.map((r) => r.n));
    const haveGroups = new Set(i.season_id ? (await c.query('SELECT name FROM org_cohorts WHERE organisation_id=$1 AND season_id=$2', [i.id, i.season_id])).rows.map((r) => r.name) : []);
    const addDeps = s.departments.filter((d) => !haveDeps.has(d.toLowerCase()));
    const addGroups = s.cohorts.filter((g) => !haveGroups.has(g.name));
    if (!i.dry_run) {
      for (const d of addDeps) await c.query('INSERT INTO org_departments(organisation_id, name, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [i.id, d, user.id]);
      for (const g of addGroups) await c.query('INSERT INTO org_cohorts(organisation_id, name, season_id, capacity) VALUES ($1,$2,$3,$4)', [i.id, g.name, i.season_id, g.capacity ?? null]);
      await audit(c, user.id, 'apply_org_template', 'organisations', i.id);
    }
    return { dry_run: i.dry_run, departments_added: addDeps, cohorts_added: addGroups.map((g) => g.name), skipped: { departments: s.departments.length - addDeps.length, cohorts: s.cohorts.length - addGroups.length } };
  }),
});

cap({
  name: 'archive_org_template', method: 'DELETE', path: '/organisations/:id/templates/:template_id', tag: 'Organisations',
  summary: 'Retire a template of this organisation (owner/admin). It is hidden from the list but kept.',
  input: z.object({ id, template_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, STAFF, { write: true, c });
    const r = await c.query('UPDATE org_templates SET archived_at=now() WHERE id=$1 AND organisation_id=$2 AND archived_at IS NULL', [i.template_id, i.id]);
    if (!r.rowCount) throw notFound('Template');
    await audit(c, user.id, 'archive_org_template', 'organisations', i.id);
    return { ok: true };
  }),
});
