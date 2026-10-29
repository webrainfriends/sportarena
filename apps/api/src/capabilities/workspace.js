// Role-based command centres (#562). One capability set serves the app, REST and MCP: which roles you hold right now, and for the
// chosen role the six common sections (Today, Actions, Calendar, Inbox, Work, Insights). Everything is a live projection over the
// canonical modules (see src/workspace.js); the only thing stored is the person's own preferences (workspace_prefs).
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { hasConsent } from '../youth.js';
import { inbox } from '../notify.js';
import { buildSchedule } from './athlete-schedule.js';
import { CALENDAR_KINDS, PERSONA_KEYS, SECTIONS, actionsFor, canPin, contextsFor, insightsFor, linkFor, resolvePins, workFor } from '../workspace.js';

const TAG = 'Workspace';
const role = z.enum(PERSONA_KEYS);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PIN_TYPES = ['team', 'event', 'venue', 'org'];

const loadPrefs = async (userId, c) => {
  const q = c ? (t, p) => c.query(t, p).then((r) => r.rows[0]) : one;
  return (await q('SELECT * FROM workspace_prefs WHERE user_id=$1', [userId])) ?? { user_id: userId, active_role: null, active_scope_id: null, default_org_id: null, pins: [], saved_filters: [], version: 0 };
};

/** The role (and optional scope) a call is about. Roles and scopes are re-derived from live memberships on every call. */
async function resolve(user, wantRole, wantScope) {
  const [contexts, prefs] = await Promise.all([contextsFor(user), loadPrefs(user.id)]);
  if (!contexts.length) throw notFound('Workspace');
  const key = wantRole ?? (contexts.some((c) => c.key === prefs.active_role) ? prefs.active_role : contexts[0].key);
  const ctx = contexts.find((c) => c.key === key);
  if (!ctx) throw forbidden('You do not hold that role');
  if (wantScope && !ctx.scopes.some((s) => s.id === wantScope)) throw notFound('Scope');
  return { ctx, contexts, prefs, scope: wantScope ?? null };
}

const withLinks = (rows) => rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, read_at: n.read_at, created_at: n.created_at, link: linkFor(n.kind, n.data) }));

/** What a guardian may see of their children's day: selections only, and only while participation consent is live. Each read is audited. */
async function childrenToday(user, scope, from, to) {
  const kids = await many("SELECT l.child_id AS id, c.display_name AS name FROM guardian_links l JOIN users c ON c.id=l.child_id WHERE l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) AND ($2::uuid IS NULL OR l.child_id=$2)", [user.id, scope]);
  const items = [];
  for (const k of kids) {
    if (!(await hasConsent(k.id, 'participation'))) continue;
    await audit(null, user.id, 'read_child_schedule', 'users', k.id);
    const rows = await many(
      `SELECT q.id, q.status, f.scheduled_at AS starts_at, t.name AS team, h.name AS home_name, a.name AS away_name FROM team_squads q JOIN fixtures f ON f.id=q.fixture_id JOIN teams t ON t.id=q.team_id JOIN teams h ON h.id=f.home_team_id JOIN teams a ON a.id=f.away_team_id
        WHERE q.user_id=$1 AND q.status IN ('selected','confirmed') AND f.status='scheduled' AND f.scheduled_at >= $2::date AND f.scheduled_at < $3::date + 1 ORDER BY f.scheduled_at`, [k.id, from, to]);
    items.push(...rows.map((r) => ({ source_type: 'child_selection', source_id: r.id, kind: 'match', title: `${k.name}: ${r.home_name} v ${r.away_name}`, starts_at: r.starts_at, status: r.status, context: r.team, link: { screen: 'Family', params: {} } })));
  }
  return { items, conflicts: 0 };
}

const scheduleFor = (user, ctx, scope, from, to, kinds) => (ctx.key === 'guardian'
  ? childrenToday(user, scope, from, to)
  : buildSchedule(user, { from, to, kinds: (kinds?.length ? kinds : CALENDAR_KINDS[ctx.key]).join(',') }));

const iso = (d) => d.toISOString().slice(0, 10);

cap({
  name: 'list_workspace_contexts', method: 'GET', path: '/me/workspace', tag: TAG,
  summary: 'The roles you hold right now (athlete, guardian, coach, team manager, club/academy/federation admin, event manager, official, doctor, physio, sponsor, supplier, venue operator, agent, media, volunteer), the records each acts for (team, organisation, event, venue ...), how many actions wait in each, and your workspace preferences: active role, default organisation, pinned teams and events, saved filters. Roles are derived live from your memberships, so a revoked membership disappears at once.',
  async handler({ user }) {
    const [contexts, prefs, unread] = await Promise.all([contextsFor(user), loadPrefs(user.id), one('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id])]);
    const withCounts = await Promise.all(contexts.map(async (c) => {
      const items = await actionsFor(user, c.key, null);
      return { ...c, actions: items.length, urgent: items.filter((x) => x.urgent).length };
    }));
    const active = withCounts.some((c) => c.key === prefs.active_role) ? prefs.active_role : withCounts[0]?.key ?? null;
    const scopeOk = prefs.active_scope_id && withCounts.find((c) => c.key === active)?.scopes.some((s) => s.id === prefs.active_scope_id);
    const org = prefs.default_org_id && (await one("SELECT o.id, o.name FROM organisations o JOIN organisation_members m ON m.organisation_id=o.id WHERE o.id=$1 AND m.user_id=$2 AND m.status='active'", [prefs.default_org_id, user.id]));
    return {
      contexts: withCounts, unread: unread.n,
      prefs: { active_role: active, active_scope_id: scopeOk ? prefs.active_scope_id : null, default_org: org ?? null, pins: await resolvePins(user, prefs.pins), saved_filters: prefs.saved_filters, version: prefs.version },
    };
  },
});

cap({
  name: 'get_command_centre', method: 'GET', path: '/me/workspace/:section', tag: TAG,
  summary: 'One section of a role\'s command centre. today = the next things on your calendar plus your most urgent actions; actions = decisions waiting on you, each with the exact record to open and, where it is safe, a one-tap answer that calls the existing capability; calendar = your calendar limited to what that role cares about; inbox = notifications with the exact screen and record each opens; work = the queues you run; insights = counts that match those queues. `role` defaults to your active role; `scope_id` narrows to one team, organisation, event, venue or child you act for.',
  input: z.object({
    section: z.enum(SECTIONS), role: role.optional(), scope_id: id.optional(),
    from: date.optional(), to: date.optional(), kinds: z.string().optional().describe('calendar: comma separated schedule kinds (a saved filter)'),
    unread: z.coerce.boolean().default(false).describe('inbox: unread only'), limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0),
  }),
  async handler({ user }, i) {
    const { ctx, scope } = await resolve(user, i.role, i.scope_id);
    const base = { role: ctx.key, label: ctx.label, scope_id: scope };
    const today = iso(new Date());
    const kinds = i.kinds ? i.kinds.split(',').map((k) => k.trim()).filter(Boolean) : null;
    switch (i.section) {
      case 'today': {
        const [actions, sched, unread] = await Promise.all([actionsFor(user, ctx.key, scope), scheduleFor(user, ctx, scope, today, today, null), one('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id])]);
        return { ...base, section: 'today', date: today, schedule: sched.items, conflicts: sched.conflicts, actions: actions.slice(0, 5), actions_total: actions.length, urgent: actions.filter((x) => x.urgent).length, unread: unread.n };
      }
      case 'actions': return { ...base, section: 'actions', items: await actionsFor(user, ctx.key, scope) };
      case 'calendar': {
        const from = i.from ?? today, to = i.to ?? iso(new Date(Date.parse(from) + 13 * 864e5));
        if (to < from) throw badRequest('to is before from');
        const sched = await scheduleFor(user, ctx, scope, from, to, kinds);
        return { ...base, section: 'calendar', from, to, kinds: kinds ?? CALENDAR_KINDS[ctx.key], ...sched };
      }
      case 'inbox': {
        const [items, c] = await Promise.all([inbox(user.id, { unread: i.unread, limit: i.limit, offset: i.offset }), one('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id])]);
        return { ...base, section: 'inbox', unread: c.n, items: withLinks(items) };
      }
      case 'work': return { ...base, section: 'work', items: await workFor(user, ctx.key, scope) };
      default: return { ...base, section: 'insights', items: await insightsFor(user, ctx.key, scope) };
    }
  },
});

cap({
  name: 'update_workspace_prefs', method: 'PATCH', path: '/me/workspace/prefs', tag: TAG,
  summary: 'Choose the role (and the team, organisation, event, venue or child) you are working as, and your default organisation. Switching role changes only what you see: every call still checks your live permissions in that workspace.',
  input: z.object({ active_role: role.optional(), active_scope_id: id.nullable().optional(), default_org_id: id.nullable().optional() }),
  async handler({ user }, i) {
    if (i.active_role || i.active_scope_id) {
      const wantRole = i.active_role ?? (await loadPrefs(user.id)).active_role;
      const ctx = (await contextsFor(user)).find((c) => c.key === wantRole);
      if (!ctx) throw forbidden('You do not hold that role');
      if (i.active_scope_id && !ctx.scopes.some((s) => s.id === i.active_scope_id)) throw notFound('Scope');
    }
    if (i.default_org_id && !(await one("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.default_org_id, user.id]))) throw notFound('Organisation');
    const sets = { active_role: i.active_role, active_scope_id: i.active_role && i.active_scope_id === undefined ? null : i.active_scope_id, default_org_id: i.default_org_id };
    return tx(async (c) => {
      await c.query('INSERT INTO workspace_prefs(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
      const keys = Object.keys(sets).filter((k) => sets[k] !== undefined);
      if (!keys.length) return loadPrefs(user.id, c);
      const row = (await c.query(`UPDATE workspace_prefs SET ${keys.map((k, n) => `${k}=$${n + 2}`).join(', ')}, version=version+1, updated_at=now() WHERE user_id=$1 RETURNING active_role, active_scope_id, default_org_id, version`, [user.id, ...keys.map((k) => sets[k])])).rows[0];
      return row;
    });
  },
});

cap({
  name: 'pin_workspace_item', method: 'POST', path: '/me/workspace/pins', tag: TAG, status: 201,
  summary: 'Pin a team, event, venue or organisation you act for to the top of your workspace (up to 24). You can only pin records you already have a role in.',
  input: z.object({ type: z.enum(PIN_TYPES), id }),
  async handler({ user }, i) {
    if (!(await canPin(user, i.type, i.id))) throw notFound('Record');
    return tx(async (c) => {
      await c.query('INSERT INTO workspace_prefs(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
      const p = (await c.query('SELECT pins FROM workspace_prefs WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0].pins;
      if (p.some((x) => x.type === i.type && x.id === i.id)) return { pins: p };
      if (p.length >= 24) throw badRequest('You can pin up to 24 items');
      const next = [...p, { type: i.type, id: i.id }];
      await c.query('UPDATE workspace_prefs SET pins=$2, version=version+1, updated_at=now() WHERE user_id=$1', [user.id, JSON.stringify(next)]);
      return { pins: next };
    });
  },
});

cap({
  name: 'unpin_workspace_item', method: 'DELETE', path: '/me/workspace/pins/:type/:id', tag: TAG,
  summary: 'Remove a pin. Only the shortcut is removed, never the team, event, venue or organisation.',
  input: z.object({ type: z.enum(PIN_TYPES), id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT pins FROM workspace_prefs WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0];
      const next = (row?.pins ?? []).filter((x) => !(x.type === i.type && x.id === i.id));
      if (row) await c.query('UPDATE workspace_prefs SET pins=$2, version=version+1, updated_at=now() WHERE user_id=$1', [user.id, JSON.stringify(next)]);
      return { pins: next };
    });
  },
});

cap({
  name: 'save_workspace_filter', method: 'POST', path: '/me/workspace/filters', tag: TAG, status: 201,
  summary: 'Save a filter for a section of a role\'s workspace (calendar kinds, unread inbox), to re-apply in one tap. Up to 24.',
  input: z.object({ name: z.string().trim().min(1).max(40), role, section: z.enum(['calendar', 'inbox', 'actions']), kinds: z.array(z.string().max(20)).max(12).optional(), unread: z.boolean().optional() }),
  async handler({ user }, i) {
    if (!(await contextsFor(user)).some((c) => c.key === i.role)) throw forbidden('You do not hold that role');
    return tx(async (c) => {
      await c.query('INSERT INTO workspace_prefs(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
      const f = (await c.query('SELECT saved_filters FROM workspace_prefs WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0].saved_filters;
      if (f.length >= 24) throw badRequest('You can save up to 24 filters');
      const filter = { id: crypto.randomUUID(), name: i.name, role: i.role, section: i.section, ...(i.kinds ? { kinds: i.kinds } : {}), ...(i.unread !== undefined ? { unread: i.unread } : {}) };
      await c.query('UPDATE workspace_prefs SET saved_filters=$2, version=version+1, updated_at=now() WHERE user_id=$1', [user.id, JSON.stringify([...f, filter])]);
      return filter;
    });
  },
});

cap({
  name: 'delete_workspace_filter', method: 'DELETE', path: '/me/workspace/filters/:id', tag: TAG,
  summary: 'Remove one of your saved filters (a personal shortcut; no records are touched).', input: z.object({ id: z.string().uuid() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const row = (await c.query('SELECT saved_filters FROM workspace_prefs WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0];
      const f = row?.saved_filters ?? [];
      if (!f.some((x) => x.id === i.id)) throw notFound('Filter');
      await c.query('UPDATE workspace_prefs SET saved_filters=$2, version=version+1, updated_at=now() WHERE user_id=$1', [user.id, JSON.stringify(f.filter((x) => x.id !== i.id))]);
      return { deleted: true };
    });
  },
});
