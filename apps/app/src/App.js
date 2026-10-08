import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from './session';
import { NavProvider, useNav } from './nav';
import { Loading } from './ui';
import { Icon } from './icons';
import { useLayout } from './layout';
import { installWebShell } from './web';
import { api } from './api';
import { c, fam } from './theme';

installWebShell();
import Auth from './screens/auth';
import Home from './screens/home';
import { Play, Event, Team, Person } from './screens/play';
import { Book, Venue } from './screens/book';
import { Hub, Leaderboard, Awards, Health, Insurance, Sponsors, Supply } from './screens/hub';
import { Me } from './screens/me';

import { PlayerHome, SportProfile, ImportMatches } from './screens/player';

const TABS = [['Home', Home], ['Play', Play], ['Player', PlayerHome], ['Book', Book], ['Hub', Hub], ['Me', Me]];
const LABEL = { Hub: 'Ecosystem' };
const PAGES = { Event, Team, Person, Venue, Leaderboard, Awards, Health, Insurance, Sponsors, Supply, SportProfile, ImportMatches };
const TITLES = { Event: 'Event', Team: 'Team', Person: 'Profile', Venue: 'Venue', Leaderboard: 'Leaderboard', Awards: 'Trophy room', Health: 'Health', Insurance: 'Insurance', Sponsors: 'Sponsors', Supply: 'Supply chain', SportProfile: 'Sport profile', ImportMatches: 'Import matches' };

const TAB_LABEL = { Hub: 'More' };

/** Bottom tab bar. Phone: edge-to-edge bar. Tablet / large screens: a floating pill, like an iPad app. */
function TabBar() {
  const { tab, goTab } = useNav();
  const ins = useSafeAreaInsets();
  const { tablet, width } = useLayout();
  const items = TABS.map(([name]) => {
    const on = tab === name;
    return (
      <Pressable key={name} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => goTab(name)} style={({ pressed }) => ({ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 52, opacity: pressed ? 0.6 : 1 })}>
        <Icon name={name} on={on} color={on ? c.pink : c.mute} size={tablet ? 26 : 24} />
        <Text numberOfLines={1} style={[fam, { fontSize: tablet ? 12 : 10.5, fontWeight: on ? '700' : '600', color: on ? c.pink : c.mute, marginTop: 3 }]}>{TAB_LABEL[name] ?? name}</Text>
      </Pressable>
    );
  });
  if (!tablet) {
    return (
      <View style={{ backgroundColor: 'rgba(255,255,255,0.97)', borderTopWidth: 1, borderColor: c.line, paddingBottom: ins.bottom, paddingTop: 4 }}>
        <View style={{ flexDirection: 'row' }}>{items}</View>
      </View>
    );
  }
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(ins.bottom, 14), alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', width: Math.min(620, width - 48), paddingHorizontal: 10, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 30, borderWidth: 1, borderColor: c.line, ...(Platform.OS === 'web' ? { boxShadow: '0 10px 40px rgba(15,23,42,0.16), 0 2px 6px rgba(15,23,42,0.06)' } : { shadowColor: '#0F172A', shadowOpacity: 0.16, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8 }) }}>
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
  const { tab, stack, back, goTab } = useNav();
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
    api.post(`/payments/${id}/confirm`).then((r) => toast(r.status === 'paid' ? 'Payment received ✓' : 'Payment is still processing — check back shortly')).catch((e) => toast(e.message));
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ready) return <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: 24 }}><Loading /></View>;
  if (!user) return <View style={{ flex: 1, paddingTop: ins.top, backgroundColor: c.bg }}><Auth /></View>;
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
      <SessionProvider><NavProvider><Shell /></NavProvider></SessionProvider>
    </SafeAreaProvider>
  );
}
