import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, StatusBar, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from './session';
import { NavProvider, useNav } from './nav';
import { Loading } from './ui';
import { Icon } from './icons';
import { useLayout } from './layout';
import { installWebShell } from './web';
import { api } from './api';
import { parseTarget, targetFor } from './push';
import { c, fam } from './theme';

installWebShell();
import Home from './screens/feed';
import Landing from './screens/landing';
import { Play, Event, Team, Person } from './screens/play';
import { EventAdmin } from './screens/event-admin';
import { TeamManage } from './screens/team-manage';
import { TeamWorkspace } from './screens/team-workspace';
import { TeamChat } from './screens/team-chat';
import { Book, Venue } from './screens/book';
import { BookFlow } from './screens/bookflow';
import { Basket, Reservation, Compare, Notifications, Invoice } from './screens/reserve';
import { Manage, OwnerSummary } from './screens/manage';
import { Wallet } from './screens/wallet';
import { BasketProvider } from './basket';
import { Hub, Leaderboard, Awards, Health, Sponsors, Supply } from './screens/hub';
import { Insurance, InsurerPage } from './screens/insurance';
import { InsurerDesk } from './screens/insurer';
import { PartnerConsole, MyPartner } from './screens/partners';
import { Me } from './screens/me';
import { Support } from './screens/cases';
import { Family } from './screens/family';
import { Orgs, Org } from './screens/org';
import { Games } from './screens/games';
import { EventPlan, EventInbox } from './screens/event-plan';
import { CoachHome, CoachAthletes, CoachPlan, CoachCalendar, MyPlans } from './screens/coach';

import { PlayerHome, SportProfile, ImportMatches } from './screens/player';

const TABS = [['Home', Home], ['Play', Play], ['Player', PlayerHome], ['Book', Book], ['Hub', Hub], ['Me', Me]];
const LABEL = { Hub: 'Ecosystem' };
const PAGES = { Event, Team, TeamManage, TeamWorkspace, TeamChat, Person, Venue, Wallet, BookFlow, Invoice, Basket, Reservation, Compare, Notifications, Manage, OwnerSummary, Leaderboard, Awards, Health, Insurance, InsurerPage, InsurerDesk, Sponsors, Supply, SportProfile, ImportMatches, Support, Family, CoachHome, CoachAthletes, CoachPlan, CoachCalendar, MyPlans, Orgs, Org, Games, EventPlan, EventInbox };
const TITLES = { Event: 'Event', Team: 'Team', TeamManage: 'Manage team', TeamWorkspace: 'Team workspace', TeamChat: 'Team chat', Person: 'Profile', Venue: 'Venue', Wallet: 'Wallet', BookFlow: 'Book', Invoice: 'Invoice', Basket: 'Basket', Reservation: 'Booking', Compare: 'Compare', Notifications: 'Notifications', Manage: 'Manage venue', OwnerSummary: 'All my venues', Leaderboard: 'Leaderboard', Awards: 'Trophy room', Health: 'Health', Insurance: 'Insurance', InsurerPage: 'Insurer', InsurerDesk: 'Insurer desk', Sponsors: 'Sponsors', Supply: 'Supply chain', SportProfile: 'Sport profile', ImportMatches: 'Import matches', Support: 'Support', Family: 'Family & guardians', CoachHome: 'Coach home', CoachAthletes: 'My athletes', CoachPlan: 'Training plan', CoachCalendar: 'Coach calendar', MyPlans: 'Training plans', Orgs: 'My organisations', Org: 'Organisation', Games: 'Games programme', EventPlan: 'Plan & budget', EventInbox: 'Event requests' };

const TAB_LABEL = { Hub: 'More' };
// order in the bar; Book is the raised centre action, Me opens from the hero avatar and from More
const BAR = ['Home', 'Play', 'Book', 'Player', 'Hub'];

/** Bottom tab bar. Phone: edge-to-edge bar. Tablet / large screens: a floating pill, like an iPad app. */
function TabBar() {
  const { tab, goTab } = useNav();
  const ins = useSafeAreaInsets();
  const { tablet, width } = useLayout();
  const items = BAR.map((name) => {
    const on = tab === name || (name === 'Hub' && tab === 'Me');
    const centre = name === 'Book';
    return (
      <Pressable key={name} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={TAB_LABEL[name] ?? name} onPress={() => goTab(name)} style={({ pressed }) => ({ flex: 1, alignItems: 'center', justifyContent: 'flex-end', minHeight: 52, opacity: pressed ? 0.6 : 1 })}>
        {centre ? (
          <LinearGradient colors={['#4F46E5', '#7C3AED']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', marginTop: -26, borderWidth: 4, borderColor: '#fff', ...(Platform.OS === 'web' ? { boxShadow: '0 8px 20px rgba(79,70,229,0.4)' } : { shadowColor: '#4F46E5', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8 }) }}>
            <Icon name={name} on color="#fff" size={26} />
          </LinearGradient>
        ) : (
          <View style={{ alignItems: 'center', justifyContent: 'center', paddingHorizontal: tablet ? 18 : 14, paddingVertical: 5, borderRadius: 16, backgroundColor: on ? c.pinkSoft : 'transparent' }}>
            <Icon name={name} on={on} color={on ? c.pink : c.mute} size={tablet ? 26 : 23} />
          </View>
        )}
        <Text numberOfLines={1} style={[fam, { fontSize: tablet ? 12 : 10.5, fontWeight: on ? '700' : '600', color: on ? c.pink : c.mute, marginTop: 2, marginBottom: 2 }]}>{TAB_LABEL[name] ?? name}</Text>
      </Pressable>
    );
  });
  if (!tablet) {
    return (
      <View style={{ backgroundColor: '#fff', borderTopWidth: 1, borderColor: c.line, paddingBottom: ins.bottom, paddingTop: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>{items}</View>
      </View>
    );
  }
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(ins.bottom, 14), alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', width: Math.min(620, width - 48), paddingHorizontal: 10, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 30, borderWidth: 1, borderColor: c.line, ...(Platform.OS === 'web' ? { boxShadow: '0 10px 40px rgba(15,23,42,0.16), 0 2px 6px rgba(15,23,42,0.06)' } : { shadowColor: '#0F172A', shadowOpacity: 0.16, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8 }) }}>
        {items}
      </View>
    </View>
  );
}

/** Compact navigation bar for pushed screens: back chevron + title. */
function NavBar({ title, onBack, backLabel }) {
  const { gutter, contentMax } = useLayout();
  return (
    <View style={{ backgroundColor: c.bg }}>
      <View style={{ width: '100%', maxWidth: contentMax, alignSelf: 'center', height: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: gutter - 6 }}>
        <Pressable onPress={onBack} hitSlop={12} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minWidth: 72, height: 44, opacity: pressed ? 0.5 : 1 })}>
          <Icon name="Back" color={c.pink} size={26} />
          <Text style={[fam, { color: c.pink, fontSize: 16, fontWeight: '600', marginLeft: -2 }]}>{backLabel}</Text>
        </Pressable>
        <Text numberOfLines={1} style={[fam, { position: 'absolute', left: 90, right: 90, textAlign: 'center', fontWeight: '700', fontSize: 16, color: c.ink }]} pointerEvents="none">{title}</Text>
      </View>
    </View>
  );
}

/** Screen change: tabs cross-fade, pushed screens slide in from the right (like a native stack). */
function Transition({ id, push, children }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    v.setValue(0);
    Animated.timing(v, { toValue: 1, duration: push ? 260 : 160, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Animated.View style={{ flex: 1, opacity: v, transform: [{ translateX: push ? v.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) : 0 }, { translateY: push ? 0 : v.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}>
      {children}
    </Animated.View>
  );
}

function Shell() {
  const { ready, user, toast } = useSession();
  const { tab, stack, back, goTab, push } = useNav();
  const ins = useSafeAreaInsets();
  // Back from Stripe/PayPal checkout (web): ?payment=<id>&result=success|cancel
  useEffect(() => {
    if (Platform.OS !== 'web' || !user) return;
    const q = new URLSearchParams(window.location.search);
    const id = q.get('payment');
    if (!id) return;
    window.history.replaceState({}, '', window.location.pathname);
    goTab('Player');
    if (q.get('result') !== 'success') return toast('Payment cancelled — nothing was charged');
    api.post(`/payments/${id}/confirm`).then(async (r) => {
      toast(r.status === 'paid' ? 'Payment received ✓' : 'Payment is still processing — check back shortly');
      if (r.purpose_type === 'venue_invoice') { const inv = await api.get(`/invoices/${r.purpose_id}`).catch(() => null); if (inv) { goTab('Book'); push('Reservation', { id: inv.reservation_id }); } }
    }).catch((e) => toast(e.message));
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  // A tapped push notification opens the right screen: from the web service worker (?open= or a message) or from the phone.
  useEffect(() => {
    if (!user) return undefined;
    const go = ([name, params]) => { goTab('Book'); setTimeout(() => push(name, params), 0); };
    if (Platform.OS === 'web') {
      const q = new URLSearchParams(window.location.search);
      if (q.get('open')) { window.history.replaceState({}, '', window.location.pathname); go(parseTarget(q.get('open'))); }
      const onMsg = (e) => { if (e.data?.type === 'open') go(parseTarget(e.data.target)); };
      navigator.serviceWorker?.addEventListener('message', onMsg);
      return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
    }
    let sub;
    import('expo-notifications').then((N) => {
      N.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
      sub = N.addNotificationResponseReceivedListener((r) => go(targetFor(r.notification.request.content.data)));
    }).catch(() => {});
    return () => sub?.remove();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ready) return <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: 24 }}><Loading /></View>;
  if (!user) return <View style={{ flex: 1, backgroundColor: c.bg }}><Landing /></View>;
  const top = stack[stack.length - 1];
  const Page = top ? PAGES[top.name] : TABS.find((t) => t[0] === tab)[1];
  const prev = stack.length > 1 ? TITLES[stack[stack.length - 2].name] : tab === 'Hub' ? 'More' : tab;
  const pageKey = top ? `${top.name}:${stack.length}:${top.params?.id ?? ''}` : tab;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: ins.top, paddingLeft: ins.left, paddingRight: ins.right }}>
      {top ? <NavBar title={TITLES[top.name]} backLabel={prev} onBack={back} /> : null}
      <Transition id={pageKey} push={!!top}><Page key={pageKey} {...(top?.params ?? {})} /></Transition>
      <TabBar />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SessionProvider><BasketProvider><NavProvider><Shell /></NavProvider></BasketProvider></SessionProvider>
    </SafeAreaProvider>
  );
}
