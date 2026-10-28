// Role-based command centres (#562): one Home for every role. A role switcher, then the same six sections for each role:
// Today, Actions, Calendar, Inbox, Work, Insights (plus the community feed). Everything shown is a live projection from the API
// (get_command_centre); this file only renders it and calls the capabilities the API names for one-tap answers.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Row, Sheet, T, Tag } from '../ui';
import { HScroll } from '../pickers';
import { c } from '../theme';
import { dateTimeIn } from '../vtime';
import { locale } from '../locale';
import { HomeSchedule, Item } from './athlete-home';

export const SECTIONS = [['today', 'Today'], ['actions', 'Actions'], ['calendar', 'Calendar'], ['inbox', 'Inbox'], ['work', 'Work'], ['insights', 'Insights'], ['community', 'Community']];
// the global account role that matches a persona, so the rest of the app's role-aware tools follow the switch
const ACCOUNT_ROLE = { athlete: 'athlete', coach: 'coach', official: 'referee', event_manager: 'organizer', doctor: 'doctor', physio: 'physio', sponsor: 'sponsor', supplier: 'supplier', venue_operator: 'venue_manager', agent: 'recruiter' };
const PINNABLE = { team: 'team', event: 'event', venue: 'venue', org: 'org' };

/** Open the exact record a link names: a pushed screen, or a tab section. */
export function openLink(nav, link) {
  if (!link) return false;
  if (link.tab) nav.goTab(link.tab, link.params ?? {});
  else if (link.screen) nav.push(link.screen, link.params ?? {});
  else return false;
  return true;
}

/** Which role and scope the person is working as. Lives above the section so it survives switching between sections. */
export function useWorkspace() {
  const { setActiveRole } = useSession();
  const list = useLoad(() => api.get('/me/workspace'), []);
  const [role, setRole] = useState(null);
  const [scope, setScope] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (list.data && !role) { setRole(list.data.prefs.active_role); setScope(list.data.prefs.active_scope_id); }
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const contexts = list.data?.contexts ?? [];
  const ctx = contexts.find((x) => x.key === role) ?? null;
  const choose = useCallback((r, s = null) => {
    setRole(r); setScope(s);
    if (ACCOUNT_ROLE[r]) setActiveRole(ACCOUNT_ROLE[r]);
    api.patch('/me/workspace/prefs', { active_role: r, active_scope_id: s }).catch(() => {});
  }, [setActiveRole]);
  const refresh = useCallback(() => { setTick((t) => t + 1); list.reload(); }, [list]);
  return { list, contexts, ctx, role, scope, tick, choose, refresh, prefs: list.data?.prefs, unread: list.data?.unread ?? 0 };
}

function Badge({ n, urgent }) {
  if (!n) return null;
  return <View accessible={false} style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: urgent ? c.red : c.pink }}><T size={11} weight="700" color="#fff">{n > 99 ? '99+' : n}</T></View>;
}

/** Role switcher, scope picker, pinned shortcuts and the section tabs. */
export function WorkspaceHeader({ ws, section, onSection, onSettings }) {
  const nav = useNav();
  if (ws.list.loading && !ws.list.data) return <Loading />;
  if (ws.list.error) return <ErrorBox error={ws.list.error} onRetry={ws.list.reload} />;
  const { ctx } = ws;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <T size={19} weight="700" style={{ letterSpacing: -0.3 }}>{ctx ? `${ctx.emoji} ${ctx.label}` : 'Your workspace'}</T>
        <Btn small title="⚙ Settings" color={c.paper} ink={c.ink} accessibilityLabel="Workspace settings" onPress={onSettings} />
      </View>
      {ws.contexts.length > 1 ? (
        <View accessibilityRole="tablist" accessibilityLabel="Work as">
          <HScroll>
            {ws.contexts.map((x) => (
              <Pressable key={x.key} onPress={() => ws.choose(x.key)} accessibilityRole="tab" accessibilityState={{ selected: x.key === ws.role }} accessibilityLabel={`${x.label}${x.actions ? `, ${x.actions} actions waiting` : ''}`}
                style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: x.key === ws.role ? c.ink : c.line, backgroundColor: x.key === ws.role ? c.ink : c.paper }}>
                <T size={13} weight="600" color={x.key === ws.role ? c.inkOn : c.mute}>{x.emoji} {x.label}</T>
                <Badge n={x.actions} urgent={x.urgent > 0} />
              </Pressable>
            ))}
          </HScroll>
        </View>
      ) : null}
      {ctx && ctx.scopes.length > 1 ? (
        <HScroll>
          <Chip label={`All · ${ctx.scopes.length}`} active={!ws.scope} onPress={() => ws.choose(ws.role, null)} />
          {ctx.scopes.map((s) => <Chip key={s.id} label={s.label} active={ws.scope === s.id} onPress={() => ws.choose(ws.role, s.id)} />)}
        </HScroll>
      ) : null}
      {ws.prefs?.pins?.length ? (
        <HScroll>
          {ws.prefs.pins.map((p) => <Chip key={`${p.type}${p.id}`} label={`📌 ${p.name}`} onPress={() => openLink(nav, p.link)} />)}
        </HScroll>
      ) : null}
      <View accessibilityRole="tablist">
        <HScroll>
          {SECTIONS.map(([k, l]) => (
            <Chip key={k} label={k === 'actions' && ctx?.actions ? `${l} · ${ctx.actions}` : k === 'inbox' && ws.unread ? `${l} · ${ws.unread}` : l} active={section === k} onPress={() => onSection(k)} />
          ))}
        </HScroll>
      </View>
    </View>
  );
}

const dueText = (iso) => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(+d) ? null : d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' }); };

/** One decision waiting on the person: what it is, when it is due, the exact record, and a one-tap answer where the API offers one. */
export function ActionCard({ x, onDone }) {
  const nav = useNav();
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const run = async (q) => {
    setBusy(true);
    try { await api[q.method.toLowerCase()](q.path, q.body); toast(`${q.label} · done`); await onDone(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const due = dueText(x.due);
  return (
    <Card onPress={() => openLink(nav, x.link)} accessibilityLabel={`${x.title}. ${x.sub ?? ''}${due ? `. Due ${due}` : ''}${x.urgent ? '. Urgent' : ''}. Opens the record`} style={{ minHeight: 44, borderLeftWidth: 4, borderLeftColor: x.urgent ? c.red : c.line }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <T weight="700" numberOfLines={2}>{x.title}</T>
            {x.sub ? <T size={13} color={c.mute}>{x.sub}{due ? ` · ${due}` : ''}</T> : null}
          </View>
          {x.urgent ? <Tag label="Urgent" color={c.sunSoft} /> : null}
        </View>
        {x.quick?.length ? (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {x.quick.map((q) => <Btn key={q.label} small title={q.label} disabled={busy} color={q.tone === 'quiet' ? c.paper : c.pink} ink={c.ink} accessibilityLabel={`${q.label}: ${x.title}`} onPress={() => run(q)} />)}
          </View>
        ) : null}
      </View>
    </Card>
  );
}

const useSection = (ws, section, extra = {}, deps = []) => useLoad(
  () => (ws.role ? api.get(`/me/workspace/${section}`, { role: ws.role, ...(ws.scope ? { scope_id: ws.scope } : {}), ...extra }) : Promise.resolve(null)),
  [ws.role, ws.scope, ws.tick, ...deps],
);

function Frame({ q, children, empty }) {
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return empty ?? null;
  return children(q.data);
}

function ActionsList({ items, onDone }) {
  return items.length
    ? <View style={{ gap: 10 }}>{items.map((x) => <ActionCard key={x.id} x={x} onDone={onDone} />)}</View>
    : <Empty emoji="✅" title="You are all caught up" sub="Decisions that need you land here, with the exact record to open." />;
}

function TodaySection({ ws }) {
  const L = useLayout();
  const q = useSection(ws, 'today');
  return (
    <Frame q={q}>
      {(d) => {
        const schedule = (
          <View style={{ gap: 10 }}>
            <T size={13} weight="800" color={c.mute}>ON TODAY</T>
            {d.conflicts ? <T size={13} weight="700" color={c.red}>⚠ {d.conflicts} overlapping commitment{d.conflicts === 1 ? '' : 's'}</T> : null}
            {d.schedule.length ? d.schedule.map((x) => <Item key={`${x.source_type}${x.source_id}${x.starts_at}`} x={x} reload={async () => { await q.reload(); ws.refresh(); }} />) : <Empty emoji="🗓️" title="Nothing scheduled today" sub="Matches, sessions, duty and bookings for this role show here." />}
          </View>
        );
        const needs = (
          <View style={{ gap: 10 }}>
            <T size={13} weight="800" color={d.urgent ? c.red : c.mute}>NEEDS YOU · {d.actions_total}{d.urgent ? ` · ${d.urgent} urgent` : ''}</T>
            <ActionsList items={d.actions} onDone={async () => { await q.reload(); ws.refresh(); }} />
            {d.actions_total > d.actions.length ? <T size={13} color={c.mute}>+ {d.actions_total - d.actions.length} more in Actions</T> : null}
          </View>
        );
        return L.tablet ? <View style={{ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }}><View style={{ flex: 1.2 }}>{schedule}</View><View style={{ flex: 1 }}>{needs}</View></View> : <View style={{ gap: 18 }}>{needs}{schedule}</View>;
      }}
    </Frame>
  );
}

function ActionsSection({ ws }) {
  const q = useSection(ws, 'actions');
  return <Frame q={q}>{(d) => <ActionsList items={d.items} onDone={async () => { await q.reload(); ws.refresh(); }} />}</Frame>;
}

/** The one calendar (HomeSchedule), limited to what this role cares about, with saved filters. */
function CalendarSection({ ws }) {
  const { toast } = useSession();
  const [kind, setKind] = useState(null);
  const [initial, setInitial] = useState(null);
  const [n, setN] = useState(0);
  const [name, setName] = useState(null);
  const saved = (ws.prefs?.saved_filters ?? []).filter((f) => f.role === ws.role && f.section === 'calendar');
  const save = async () => {
    try { await api.post('/me/workspace/filters', { name: name.trim(), role: ws.role, section: 'calendar', kinds: [kind] }); setName(null); toast('Filter saved'); ws.refresh(); } catch (e) { toast(e.message); }
  };
  const fetcher = useCallback((p) => api.get('/me/workspace/calendar', { ...p, role: ws.role, ...(ws.scope ? { scope_id: ws.scope } : {}) }), [ws.role, ws.scope]);
  return (
    <View style={{ gap: 12 }}>
      {saved.length || kind ? (
        <HScroll>
          {saved.map((f) => <Chip key={f.id} label={`★ ${f.name}`} active={kind === f.kinds?.[0]} onPress={() => { setInitial(f.kinds?.[0] ?? null); setKind(f.kinds?.[0] ?? null); setN((x) => x + 1); }} />)}
          {kind ? <Chip label="＋ Save this filter" onPress={() => setName('')} /> : null}
        </HScroll>
      ) : null}
      <HomeSchedule key={`${ws.role}${ws.scope}${n}`} fetcher={fetcher} initialKind={initial} onKindChange={setKind} />
      <Sheet visible={name !== null} onClose={() => setName(null)} title="Save filter" footer={<Btn title="Save" disabled={!name?.trim()} onPress={save} />}>
        <Field label="Name" value={name} onChangeText={setName} maxLength={40} placeholder="e.g. Matches only" />
      </Sheet>
    </View>
  );
}

/** The notification inbox. Used on Home and on the Notifications screen, so there is one inbox with deep links resolved by the API. */
export function InboxList({ role, limit = 30 }) {
  const nav = useNav();
  const { toast } = useSession();
  const { user } = useSession();
  const [unread, setUnread] = useState(false);
  const q = useLoad(() => api.get('/me/workspace/inbox', { ...(role ? { role } : {}), unread, limit }), [role, unread, limit]);
  const open = async (n) => {
    if (!n.read_at) { try { await api.post('/notifications/read', { ids: [n.id] }); q.reload(); } catch (e) { toast(e.message); } }
    openLink(nav, n.link);
  };
  const readAll = async () => { try { await api.post('/notifications/read', {}); q.reload(); } catch (e) { toast(e.message); } };
  if (!user) return null;
  return (
    <View style={{ gap: 10 }}>
      <HScroll>
        <Chip label="All" active={!unread} onPress={() => setUnread(false)} />
        <Chip label={`Unread${q.data?.unread ? ` · ${q.data.unread}` : ''}`} active={unread} onPress={() => setUnread(true)} />
        {q.data?.unread ? <Chip label="Mark all read" onPress={readAll} /> : null}
      </HScroll>
      <Frame q={q}>
        {(d) => (d.items.length ? d.items.map((n) => (
          <Row key={n.id} onPress={() => open(n)} color={n.read_at ? c.paper : c.pinkSoft} title={n.title}
            sub={`${n.body ? `${n.body} · ` : ''}${new Date(n.created_at).toLocaleString(locale)}${n.link ? ' · opens the record' : ''}`} />
        )) : <Empty emoji="🔕" title={unread ? 'Nothing unread' : 'Nothing yet'} sub="Decisions, reminders and changes land here and open the exact record." />)}
      </Frame>
    </View>
  );
}

function InboxSection({ ws }) { return <InboxList role={ws.role} />; }

function WorkSection({ ws }) {
  const nav = useNav();
  const { toast } = useSession();
  const q = useSection(ws, 'work');
  const scope = ws.ctx?.scopes.find((s) => s.id === ws.scope);
  const type = scope && PINNABLE[scope.type];
  const pinned = type && ws.prefs?.pins?.some((p) => p.type === type && p.id === scope.id);
  const toggle = async () => {
    try { await (pinned ? api.del(`/me/workspace/pins/${type}/${scope.id}`) : api.post('/me/workspace/pins', { type, id: scope.id })); ws.refresh(); } catch (e) { toast(e.message); }
  };
  return (
    <View style={{ gap: 10 }}>
      {type ? <Btn small title={pinned ? `📌 Unpin ${scope.label}` : `📌 Pin ${scope.label}`} color={c.paper} ink={c.ink} onPress={toggle} style={{ alignSelf: 'flex-start' }} /> : null}
      <Frame q={q}>
        {(d) => d.items.map((w) => (
          <Row key={w.label} onPress={() => openLink(nav, w.link)} title={w.label} sub={w.sub} right={<T size={22} weight="700">{w.count}</T>} />
        ))}
      </Frame>
      {ws.ctx ? <Btn small title={`Open ${ws.ctx.label} workspace`} color={c.paper} ink={c.ink} onPress={() => openLink(nav, ws.ctx.home)} style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
}

function InsightsSection({ ws }) {
  const nav = useNav();
  const q = useSection(ws, 'insights');
  return (
    <Frame q={q}>
      {(d) => (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {d.items.map((w) => (
            <Pressable key={w.label} onPress={() => openLink(nav, w.link)} accessibilityRole="button" accessibilityLabel={`${w.label}: ${w.count}`} style={{ flexGrow: 1, flexBasis: 150, minHeight: 44 }}>
              <Card><T size={28} weight="700">{w.count}</T><T size={13} color={c.mute}>{w.label}</T></Card>
            </Pressable>
          ))}
        </View>
      )}
    </Frame>
  );
}

/** The body for the chosen section. Community is rendered by Home itself (it is the existing feed). */
export function WorkspaceBody({ ws, section }) {
  if (!ws.ctx) return ws.list.loading ? null : <Empty emoji="🧭" title="Your workspace is empty" sub="Add a role under Me → Add or remove roles, or join a team, to see your command centre." />;
  return (
    <View style={{ marginTop: 16 }}>
      {section === 'today' ? <TodaySection ws={ws} /> : section === 'actions' ? <ActionsSection ws={ws} /> : section === 'calendar' ? <CalendarSection ws={ws} /> : section === 'inbox' ? <InboxSection ws={ws} /> : section === 'work' ? <WorkSection ws={ws} /> : <InsightsSection ws={ws} />}
    </View>
  );
}

/** Default organisation and saved filters. */
export function WorkspaceSettings({ ws, visible, onClose }) {
  const { toast } = useSession();
  const orgs = useMemo(() => ws.contexts.filter((x) => x.key === 'org_admin').flatMap((x) => x.scopes), [ws.contexts]);
  const filters = ws.prefs?.saved_filters ?? [];
  const setOrg = async (id) => { try { await api.patch('/me/workspace/prefs', { default_org_id: id }); ws.refresh(); } catch (e) { toast(e.message); } };
  const drop = async (id) => { try { await api.del(`/me/workspace/filters/${id}`); ws.refresh(); } catch (e) { toast(e.message); } };
  return (
    <Sheet visible={visible} onClose={onClose} title="Workspace settings">
      <View style={{ gap: 14 }}>
        <T size={13} color={c.mute}>One login, several roles. Switching role changes what you see; your permissions in each team, organisation, event or venue stay exactly as they are.</T>
        {orgs.length ? (
          <View style={{ gap: 8 }}>
            <T weight="700">Default organisation</T>
            <HScroll>
              <Chip label="None" active={!ws.prefs?.default_org} onPress={() => setOrg(null)} />
              {orgs.map((o) => <Chip key={o.id} label={o.label} active={ws.prefs?.default_org?.id === o.id} onPress={() => setOrg(o.id)} />)}
            </HScroll>
          </View>
        ) : null}
        <View style={{ gap: 8 }}>
          <T weight="700">Saved filters</T>
          {filters.length ? filters.map((f) => <Row key={f.id} title={f.name} sub={`${f.role.replace('_', ' ')} · ${f.section}`} right={<Btn small title="Remove" color={c.paper} ink={c.ink} accessibilityLabel={`Remove filter ${f.name}`} onPress={() => drop(f.id)} />} />) : <T size={13} color={c.mute}>Filter a calendar by kind, then choose “Save this filter”.</T>}
        </View>
      </View>
    </Sheet>
  );
}
