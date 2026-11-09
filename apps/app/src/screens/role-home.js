import React from 'react';
import { Pressable, View } from 'react-native';
import { useSession } from '../session';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { useGo, useWorkspace } from '../workspace';
import { Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, ScreenHeaderProvider, Tag, T } from '../ui';
import { roleLabel } from '../roles';
import { workspaceOf } from './more-catalog';
import { HScroll } from '../pickers';
import { SetupCard } from './setup';
import { ResidencyBanner } from './data-residency';
import { c, day, when } from '../theme';
import { t } from '../i18n';
import { actionLabel, hintText, statLabel } from '../ws-text';
import { api } from '../api';
import { useLoad } from '../hooks';
import { AthleteHub } from './athlete-hub';
import { VenueHub } from './venue-hub';
import { CoachHub } from './coach-hub';
import { PlayerHero } from '../hero';
import { EventTowerHome } from './event-tower';

// Home and Workbench: the two role-driven tabs of the mobile shell (issue #599). Both read the one workspace the API composes for the active
// role. Home answers "what is on today and what is waiting on me"; Workbench is the role's one page: its queue and fast actions on top of its own screen.
const EMOJI = { calendar: '📅', qr: '🎟️', edit: '✍️', search: '🔎', check: '✅', people: '👥', inbox: '📨', event: '🏆', scan: '📷', add: '➕', clock: '🕒', whistle: '🏅', cash: '💳', home: '🏠' };
const DOT = { now: c.red, soon: c.sun, info: c.mute };
// a date-only value (an event with no start time) shows the date, not a made-up midnight
const at = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? day(iso) : when(iso));
const URGENCY = { now: t('ws.u_now'), soon: t('ws.u_soon'), info: '' };

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
          {d.roles.length > 1 ? d.roles.map((r) => <Chip key={r.key} label={roleLabel(r.key)} active={r.key === d.role} onPress={() => setActiveRole(r.key)} />) : null}
          {d.organisations.map((o) => <Chip key={o.id} label={`🏢 ${o.name}`} onPress={() => push('Org', { id: o.id })} />)}
        </HScroll>
      ) : null}
      {ws.offlineSince ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ backgroundColor: c.sunSoft, borderRadius: 12, padding: 12 }}>
          <T weight="700" size={13}>{t('ws.offline')}</T>
          <T size={12.5} color={c.mute}>{t('ws.offline_sub', { when: when(d.as_of) })}</T>
        </View>
      ) : null}
      {ws.queued ? <T size={12.5} color={c.mute} accessibilityLiveRegion="polite">{ws.queued === 1 ? t('ws.queued_one', { n: ws.queued }) : t('ws.queued_many', { n: ws.queued })}</T> : null}
      {d.unavailable?.length ? <T size={12.5} color={c.mute}>{t('ws.unavailable')}</T> : null}
    </View>
  );
}

function Tiles({ items, role }) {
  if (!items?.length) return null;
  const many = items.length > 4; // a longer strip wraps instead of squeezing its labels; up to four tiles render exactly as before
  return (
    <View style={{ flexDirection: 'row', gap: 10, flexWrap: many ? 'wrap' : 'nowrap' }}>
      {items.map((s) => (
        <View key={s.key} accessible accessibilityLabel={`${statLabel(role, s)}: ${s.value}`} style={{ ...(many ? { flexGrow: 1, flexBasis: 120, minWidth: 120 } : { flex: 1 }), minHeight: 76, backgroundColor: c.paper, borderRadius: 16, borderWidth: 1, borderColor: c.line, padding: 12, justifyContent: 'center' }}>
          <T weight="800" size={26} style={{ letterSpacing: -0.8 }}>{s.value}</T>
          <T size={12} weight="700" color={c.mute} numberOfLines={many ? 2 : 1}>{statLabel(role, s)}</T>
        </View>
      ))}
    </View>
  );
}

/** The fast actions of the role: big touch targets, each opens the screen that does the job. */
export function Actions({ actions, cols, role }) {
  const go = useGo();
  const { tablet } = useLayout();
  const w = cols === 2 || !tablet ? '48%' : '23.5%';
  if (!actions?.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {actions.map((a) => {
        const off = !!a.disabled;
        return (
          <Pressable key={a.key} disabled={off} onPress={() => go(a.target)} accessibilityRole="button" accessibilityLabel={actionLabel(role, a)} accessibilityHint={off ? hintText(a.disabled) : a.camera ? t('ws.a11y_camera') : undefined} accessibilityState={{ disabled: off }}
            style={({ pressed }) => ({ width: w, flexGrow: 1, minHeight: 88, opacity: off ? 0.45 : pressed ? 0.8 : 1 })}>
            <View style={{ flex: 1, backgroundColor: c.paper, borderRadius: 16, borderWidth: 1, borderColor: c.line, padding: 14, justifyContent: 'space-between', gap: 6 }}>
              <T size={26}>{EMOJI[a.icon] ?? '▫️'}</T>
              <View>
                <T weight="700" size={14} numberOfLines={2}>{actionLabel(role, a)}</T>
                {off ? <T size={11.5} color={c.mute} numberOfLines={2}>{hintText(a.disabled)}</T> : a.hint ? <T size={11.5} color={c.mute} numberOfLines={2}>{hintText(a.hint)}</T> : null}
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
          {sent ? <Tag label={t('ws.waiting_send')} color={c.sun} /> : x.quick.map((q) => <Btn key={q.label} small title={q.label} color={q.tone === 'yes' ? c.pink : c.paper} ink={c.ink} onPress={() => ws.answer(q)} />)}
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
  const sports = useLoad(() => api.get('/me/sport-profiles'), []);
  const main = (sports.data ?? []).find((p) => p.is_default) ?? sports.data?.[0];
  const d = ws.data;
  const early = gate(ws);
  if (early) return early;
  const top = d.work.slice(0, 3);
  const eventHome = d.role === 'organizer' && !!d.tower; // the event role's landing page is the event control tower
  const venueHome = d.role === 'venue_manager'; // the venue owner's home is the wizard or the command centre, not the generic queue
  const athleteHome = d.role === 'athlete'; // the athlete's home leads with the nine hub cards; today and the queue come after
  // Order is chosen here, not with a reversed flex direction: a reversed container pushes its overflow out of the scrollable range on the web.
  const todayQueue = (
          <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%' }}>
            <Heading>{t('ws.today')}</Heading>
            {d.today.length ? d.today.map((x, i) => (
              <Card key={`${x.kind}${i}`} onPress={() => go(x.target)} pad={14} style={{ marginBottom: 10 }} accessibilityLabel={`${x.title}. ${x.detail}${x.at ? `. ${at(x.at)}` : ''}`}>
                <T weight="700">{x.title}</T>
                {x.detail ? <T size={13} color={c.mute}>{x.detail}</T> : null}
                {x.at ? <T size={12} color={c.mute}>{at(x.at)}</T> : null}
              </Card>
            )) : <Empty emoji="🌤️" title={t('ws.nothing_today')} sub={t('ws.nothing_today_sub')} />}
            <Heading action={d.work.length > top.length ? t('ws.all_n', { n: d.work.length }) : undefined} onAction={() => goTab('Work')}>{t('ws.needs_you')}</Heading>
            {top.length ? top.map((x, i) => <View key={`${x.kind}${i}`} style={{ marginBottom: 10 }}><QueueItem x={x} ws={ws} /></View>) : <Empty emoji="✅" title={t('ws.caught_up')} sub={t('ws.caught_up_sub')} />}
          </View>
  );
  const side = (
          <View style={{ flex: tablet ? (athleteHome ? 1.5 : 0.9) : undefined, width: tablet ? undefined : '100%' }}>
            {athleteHome ? <AthleteHub sport={main} /> : d.role === 'coach' ? <>
            <Heading>{t('ch.quick')}</Heading>
            <CoachHub />
            </> : <>
            <Heading>{t('ws.quick_actions')}</Heading>
            <Actions actions={d.actions} cols={2} role={d.role} />
            <Heading>{t('ws.beyond')}</Heading>
            <View style={{ gap: 10 }}>
              <Card onPress={() => push('Community')} pad={14} accessibilityLabel={t('ws.a11y_community')}><T weight="700">💬 {t('ws.community')}</T><T size={13} color={c.mute}>{t('ws.community_sub')}</T></Card>
              <Card onPress={() => goTab('Explore')} pad={14} accessibilityLabel={t('ws.a11y_explore')}><T weight="700">🧭 {t('ws.explore')}</T><T size={13} color={c.mute}>{t('ws.explore_sub')}</T></Card>
            </View>
            </>}
          </View>
  );
  return (
      <Screen onRefresh={ws.reload} refreshing={ws.loading} wide>
        {eventHome ? (
          <View style={{ marginTop: 4 }}>
            <H1 style={{ fontSize: 26 }}>{user.display_name}</H1>
            <T color={c.mute} weight="600">{roleLabel(d.role)}</T>
          </View>
        ) : venueHome ? null : (
          <View style={{ marginTop: 4, borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: c.line }}>
            <PlayerHero user={user} profile={main} pad={16} onAvatar={() => goTab('Me')} />
          </View>
        )}
        <View style={{ marginTop: 14 }}><Context ws={ws} /></View>
        {venueHome ? <View style={{ marginTop: 14 }}><VenueHub /></View> : <>
        <ResidencyBanner />
        {athleteHome ? null : <SetupCard />}
        {eventHome ? (
          <View style={{ marginTop: 14 }}><EventTowerHome tower={d.tower} push={push} goTab={goTab} /></View>
        ) : (
          <>
            <View style={{ marginTop: 14 }}><Tiles items={d.summary} role={d.role} /></View>
            <View style={tablet ? { flexDirection: 'row', gap: 24, alignItems: 'flex-start' } : null}>
              {athleteHome ? <>{side}{todayQueue}</> : <>{todayQueue}{side}</>}
            </View>
          </>
        )}
        </>}
      </Screen>
  );
}

/** The queue of the active role: its numbers, fast actions and everything waiting on it, most urgent first. It tops the role's own workspace screen. */
function RoleQueue({ ws }) {
  const d = ws.data;
  const own = !!workspaceOf(d.role); // the role's own screen follows, so the "Open my ..." shortcut to it would only repeat it
  const actions = own ? d.actions.filter((a) => a.key !== 'home') : d.actions;
  return (
    <View style={{ marginBottom: 8 }}>
      <H1 style={{ fontSize: 28, marginTop: 4 }}>{t('ws.workbench')}</H1>
      <T color={c.mute} weight="600">{d.role ? `${roleLabel(d.role)} · ` : ''}{d.work.length ? t('ws.n_waiting', { n: d.work.length }) : t('ws.none_waiting')}</T>
      <View style={{ marginTop: 12 }}><Context ws={ws} /></View>
      {d.summary?.length ? <View style={{ marginTop: 14 }}><Tiles items={d.summary} role={d.role} /></View> : null}
      <Heading>{t('ws.fast_actions')}</Heading>
      <Actions actions={actions} role={d.role} />
      <Heading>{t('ws.waiting_on_you')}</Heading>
      {d.work.length ? d.work.map((x, i) => <View key={`${x.kind}${i}`} style={{ marginBottom: 10 }}><QueueItem x={x} ws={ws} /></View>) : <Empty emoji="✅" title={t('ws.caught_up')} sub={t('ws.caught_up_sub')} />}
    </View>
  );
}

/**
 * Workbench (the Work tab): the one page of the active role. Its queue and fast actions on top, then that role's own screen (coach, official, venue, sponsor ...)
 * in the same page, so there is no second "workspace" to find. `pages` is the app's screen registry (passed in to avoid an import cycle).
 */
export function WorkTab({ pages }) {
  const ws = useWorkspace();
  const { goTab } = useNav();
  const early = gate(ws);
  if (early) return early;
  const space = workspaceOf(ws.data.role);
  const Space = space && !space[3] ? pages[space[1]] : null;
  const queue = <RoleQueue ws={ws} />;
  if (Space) return <ScreenHeaderProvider value={queue}><Space /></ScreenHeaderProvider>;
  return (
    <Screen onRefresh={ws.reload} refreshing={ws.loading} wide>
      {queue}
      {space ? (
        <>
          <Heading>{t('ws.tools', { role: roleLabel(space[0]) })}</Heading>
          <Card onPress={() => goTab(space[3].tab, { section: space[3].section })} pad={14} accessibilityLabel={t('ws.a11y_open_x', { name: space[2] })}><T weight="700">{space[2]}</T><T size={13} color={c.mute}>{t('ws.open')}</T></Card>
        </>
      ) : null}
    </Screen>
  );
}
