import React from 'react';
import { Pressable, View } from 'react-native';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { useGo, useWorkspace } from '../workspace';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, Tag, T } from '../ui';
import { HScroll } from '../pickers';
import { c, day, when } from '../theme';

// Home and Work: the two role-driven tabs of the mobile shell (issue #599). Both read the one workspace the API composes for the active
// role. Home answers "what is on today and what is waiting on me"; Work is the whole queue plus the fast actions of the role.
const EMOJI = { calendar: '📅', qr: '🎟️', edit: '✍️', search: '🔎', check: '✅', people: '👥', inbox: '📨', event: '🏆', scan: '📷', add: '➕', clock: '🕒', whistle: '🏅', cash: '💳', home: '🏠' };
const DOT = { now: c.red, soon: c.sun, info: c.mute };
// a date-only value (an event with no start time) shows the date, not a made-up midnight
const at = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? day(iso) : when(iso));
const URGENCY = { now: 'Needs you now', soon: 'Soon', info: '' };

/** Role chips (only when the person holds several), organisation chips, and the offline / waiting notices. */
function Context({ ws }) {
  const { setActiveRole } = useSession();
  const { push } = useNav();
  const d = ws.data;
  if (!d) return null;
  return (
    <View style={{ gap: 10 }}>
      {d.roles.length > 1 || d.organisations.length ? (
        <HScroll>
          {d.roles.length > 1 ? d.roles.map((r) => <Chip key={r.key} label={r.label} active={r.key === d.role} onPress={() => setActiveRole(r.key)} />) : null}
          {d.organisations.map((o) => <Chip key={o.id} label={`🏢 ${o.name}`} onPress={() => push('Org', { id: o.id })} />)}
        </HScroll>
      ) : null}
      {ws.offlineSince ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ backgroundColor: c.sunSoft, borderRadius: 12, padding: 12 }}>
          <T weight="700" size={13}>You are offline</T>
          <T size={12.5} color={c.mute}>Showing what was loaded at {when(d.as_of)}. Answers you give are saved here and sent as soon as the connection is back.</T>
        </View>
      ) : null}
      {ws.queued ? <T size={12.5} color={c.mute} accessibilityLiveRegion="polite">{ws.queued} answer{ws.queued === 1 ? '' : 's'} waiting to send…</T> : null}
      {d.unavailable?.length ? <T size={12.5} color={c.mute}>Some of this could not be loaded. Pull down to try again.</T> : null}
    </View>
  );
}

function Tiles({ items }) {
  if (!items?.length) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      {items.map((s) => (
        <View key={s.key} accessible accessibilityLabel={`${s.label}: ${s.value}`} style={{ flex: 1, minHeight: 76, backgroundColor: c.paper, borderRadius: 16, borderWidth: 1, borderColor: c.line, padding: 12, justifyContent: 'center' }}>
          <T weight="800" size={26} style={{ letterSpacing: -0.8 }}>{s.value}</T>
          <T size={12} weight="700" color={c.mute} numberOfLines={1}>{s.label}</T>
        </View>
      ))}
    </View>
  );
}

/** The fast actions of the role: big touch targets, each opens the screen that does the job. */
export function Actions({ actions, cols }) {
  const go = useGo();
  const { tablet } = useLayout();
  const w = cols === 2 || !tablet ? '48%' : '23.5%';
  if (!actions?.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {actions.map((a) => {
        const off = !!a.disabled;
        return (
          <Pressable key={a.key} disabled={off} onPress={() => go(a.target)} accessibilityRole="button" accessibilityLabel={a.label} accessibilityHint={off ? a.disabled : a.camera ? 'Opens the camera scanner' : undefined} accessibilityState={{ disabled: off }}
            style={({ pressed }) => ({ width: w, flexGrow: 1, minHeight: 88, opacity: off ? 0.45 : pressed ? 0.8 : 1 })}>
            <View style={{ flex: 1, backgroundColor: c.paper, borderRadius: 16, borderWidth: 1, borderColor: c.line, padding: 14, justifyContent: 'space-between', gap: 6 }}>
              <T size={26}>{EMOJI[a.icon] ?? '▫️'}</T>
              <View>
                <T weight="700" size={14} numberOfLines={2}>{a.label}</T>
                {off ? <T size={11.5} color={c.mute} numberOfLines={2}>{a.disabled}</T> : a.hint ? <T size={11.5} color={c.mute} numberOfLines={2}>{a.hint}</T> : null}
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One thing waiting on me: opens where it is resolved, or is answered in place with a single tap. */
export function QueueItem({ x, ws }) {
  const go = useGo();
  const sent = x.quick?.some((q) => ws.waiting[q.path]);
  const label = `${x.title}${x.detail ? `. ${x.detail}` : ''}${x.at ? `. ${at(x.at)}` : ''}${URGENCY[x.urgency] ? `. ${URGENCY[x.urgency]}` : ''}`;
  return (
    <Card pad={14}>
      <Pressable onPress={() => go(x.target)} accessibilityRole="button" accessibilityLabel={label} style={{ minHeight: 44, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: DOT[x.urgency] ?? c.mute, marginTop: 6 }} />
        <View style={{ flex: 1 }}>
          <T weight="700" size={15}>{x.title}</T>
          {x.detail ? <T size={13} color={c.mute}>{x.detail}</T> : null}
          {x.at ? <T size={12} color={c.mute}>{at(x.at)}</T> : null}
        </View>
        <T color={c.pink} weight="700" size={20} accessibilityElementsHidden>›</T>
      </Pressable>
      {x.quick?.length ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {sent ? <Tag label="Waiting to send" color={c.sun} /> : x.quick.map((q) => <Btn key={q.label} small title={q.label} color={q.tone === 'yes' ? c.pink : c.paper} ink={c.ink} onPress={() => ws.answer(q)} />)}
        </View>
      ) : null}
    </Card>
  );
}

/** Shared loading / error shell for the two tabs: the element to show until there is a workspace, else null. */
const gate = (ws) => {
  if (ws.loading && !ws.data) return <Screen><Loading /></Screen>;
  if (!ws.data) return <Screen onRefresh={ws.reload}><ErrorBox error={ws.error} onRetry={ws.reload} /></Screen>;
  return null;
};

const Heading = ({ children, action, onAction }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, marginBottom: 10 }}>
    <T size={18} weight="800" accessibilityRole="header">{children}</T>
    {action ? <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={action} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center' }}><T size={13} weight="700" color={c.pink}>{action}  ›</T></Pressable> : null}
  </View>
);

/** Home: today and what needs me, then the fast actions. The community feed and discovery are one tap away, not the front door. */
export function RoleHome() {
  const ws = useWorkspace();
  const { user } = useSession();
  const { goTab, push } = useNav();
  const { tablet } = useLayout();
  const go = useGo();
  const d = ws.data;
  const early = gate(ws);
  if (early) return early;
  const top = d.work.slice(0, 3);
  const first = (user?.display_name ?? '').split(' ')[0];
  return (
      <Screen onRefresh={ws.reload} refreshing={ws.loading} wide>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 }}>
          <Avatar user={user} size={46} />
          <View style={{ flex: 1 }}>
            <T size={13} color={c.mute} weight="700">{d.role_label ?? 'Welcome'}{d.generic && d.role ? ' · basic workspace' : ''}</T>
            <H1 style={{ fontSize: 26, letterSpacing: -0.8 }}>{first ? `Hello, ${first}` : 'Hello'}</H1>
          </View>
        </View>
        <View style={{ marginTop: 14 }}><Context ws={ws} /></View>
        <View style={{ marginTop: 14 }}><Tiles items={d.summary} /></View>
        <View style={tablet ? { flexDirection: 'row', gap: 24, alignItems: 'flex-start' } : null}>
          <View style={{ flex: 1 }}>
            <Heading>Today</Heading>
            {d.today.length ? d.today.map((x, i) => (
              <Card key={`${x.kind}${i}`} onPress={() => go(x.target)} pad={14} style={{ marginBottom: 10 }} accessibilityLabel={`${x.title}. ${x.detail}${x.at ? `. ${at(x.at)}` : ''}`}>
                <T weight="700">{x.title}</T>
                {x.detail ? <T size={13} color={c.mute}>{x.detail}</T> : null}
                {x.at ? <T size={12} color={c.mute}>{at(x.at)}</T> : null}
              </Card>
            )) : <Empty emoji="🌤️" title="Nothing scheduled today" sub="What is coming up appears here, and in your Calendar." />}
            <Heading action={d.work.length > top.length ? `All ${d.work.length}` : undefined} onAction={() => goTab('Work')}>Needs you</Heading>
            {top.length ? top.map((x, i) => <View key={`${x.kind}${i}`} style={{ marginBottom: 10 }}><QueueItem x={x} ws={ws} /></View>) : <Empty emoji="✅" title="You are all caught up" sub="Requests, approvals and replies waiting on you show up here." />}
          </View>
          <View style={{ flex: tablet ? 0.9 : undefined, width: tablet ? undefined : '100%' }}>
            <Heading>Quick actions</Heading>
            <Actions actions={d.actions} cols={2} />
            <Heading>Beyond your role</Heading>
            <View style={{ gap: 10 }}>
              <Card onPress={() => push('Community')} pad={14} accessibilityLabel="Community: posts, wanted ads and open positions"><T weight="700">💬 Community</T><T size={13} color={c.mute}>Posts, wanted ads, matches and open positions</T></Card>
              <Card onPress={() => goTab('Explore')} pad={14} accessibilityLabel="Explore events, teams and people"><T weight="700">🧭 Explore</T><T size={13} color={c.mute}>Find events, teams, venues and people</T></Card>
            </View>
          </View>
        </View>
      </Screen>
  );
}

/** Work: everything waiting on the active role, most urgent first, with the role's fast actions on top. */
export function WorkTab() {
  const ws = useWorkspace();
  const { toggleMenu } = useNav();
  const d = ws.data;
  const early = gate(ws);
  if (early) return early;
  return (
      <Screen onRefresh={ws.reload} refreshing={ws.loading} wide>
        <H1 style={{ fontSize: 28, marginTop: 4 }}>Work</H1>
        <T color={c.mute} weight="600">{d.role_label ? `${d.role_label} · ` : ''}{d.work.length ? `${d.work.length} waiting on you` : 'Nothing waiting on you'}</T>
        <View style={{ marginTop: 12 }}><Context ws={ws} /></View>
        <Heading>Fast actions</Heading>
        <Actions actions={d.actions} />
        <Heading>Waiting on you</Heading>
        {d.work.length ? d.work.map((x, i) => <View key={`${x.kind}${i}`} style={{ marginBottom: 10 }}><QueueItem x={x} ws={ws} /></View>) : <Empty emoji="✅" title="You are all caught up" sub="Requests, approvals and replies waiting on you show up here." />}
        {d.generic && d.role ? <T size={12.5} color={c.mute} style={{ marginTop: 6 }}>This role does not have a queue here yet. Its own workspace opens from the first action.</T> : null}
        <View style={{ marginTop: 18 }}><Btn title="All tools and modules" color={c.paper} ink={c.ink} onPress={toggleMenu} accessibilityLabel="Open all tools and modules" /></View>
      </Screen>
  );
}
