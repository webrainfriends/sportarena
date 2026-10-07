import React, { useEffect } from 'react';
import { Platform, Pressable, StatusBar, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from './session';
import { NavProvider, useNav } from './nav';
import { Avatar, Loading } from './ui';
import { api } from './api';
import { c, fam } from './theme';
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

const Wordmark = () => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
    <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={[fam, { color: '#fff', fontWeight: '800', fontSize: 16 }]}>S</Text>
    </View>
    <Text style={[fam, { color: c.ink, fontWeight: '800', fontSize: 18, letterSpacing: -0.4 }]}>SportArena</Text>
  </View>
);

/** One light header for every size: wordmark, (wide) pill navigation, account. */
function TopBar({ wide }) {
  const { tab, goTab } = useNav();
  const { user } = useSession();
  return (
    <View style={{ backgroundColor: c.paper, borderBottomWidth: 1, borderColor: c.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, width: '100%', maxWidth: 1120, alignSelf: 'center' }}>
        <Wordmark />
        {wide ? (
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {TABS.map(([name]) => {
              const on = tab === name;
              return (
                <Pressable key={name} onPress={() => goTab(name)} style={{ paddingVertical: 8, paddingHorizontal: 16, borderRadius: 999, backgroundColor: on ? c.pinkSoft : 'transparent' }}>
                  <Text style={[fam, { fontSize: 14, fontWeight: on ? '700' : '600', color: on ? c.pink : c.mute }]}>{LABEL[name] ?? name}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <Pressable onPress={() => goTab('Me')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {wide ? <Text style={[fam, { fontSize: 13, fontWeight: '600', color: c.mute }]} numberOfLines={1}>{user?.display_name}</Text> : null}
          <Avatar user={user} size={34} />
        </Pressable>
      </View>
    </View>
  );
}

function TabBar() {
  const { tab, goTab } = useNav();
  const ins = useSafeAreaInsets();
  return (
    <View style={{ backgroundColor: c.paper, borderTopWidth: 1, borderColor: c.line, paddingBottom: Math.max(ins.bottom, 6), paddingTop: 6 }}>
      <View style={{ flexDirection: 'row', width: '100%' }}>
        {TABS.map(([name]) => {
          const on = tab === name;
          return (
            <Pressable key={name} onPress={() => goTab(name)} style={{ flex: 1, alignItems: 'center', paddingVertical: 4 }}>
              <View style={{ paddingVertical: 6, paddingHorizontal: 8, borderRadius: 999, backgroundColor: on ? c.pinkSoft : 'transparent', minWidth: 52, alignItems: 'center' }}>
                <Text numberOfLines={1} style={[fam, { fontSize: 11.5, fontWeight: on ? '800' : '600', color: on ? c.pink : c.mute }]}>{name === 'Hub' ? 'More' : name}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Shell() {
  const { ready, user } = useSession();
  const { tab, stack, back, goTab } = useNav();
  const { toast } = useSession();
  const ins = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 820;
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
  return (
    <View style={{ flex: 1, paddingTop: ins.top, backgroundColor: c.bg }}>
      <TopBar wide={wide} />
      {top ? (
        <View style={{ width: '100%', maxWidth: 1120, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 10, gap: 12 }}>
          <Pressable onPress={back} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.paper, borderRadius: 999, borderWidth: 1, borderColor: c.line, paddingVertical: 6, paddingHorizontal: 14 }}>
            <Text style={[fam, { fontWeight: '700', color: c.ink, fontSize: 14 }]}>‹  Back</Text>
          </Pressable>
          <Text style={[fam, { fontWeight: '700', fontSize: 14, color: c.mute }]}>{TITLES[top.name]}</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }}><Page key={top ? `${top.name}:${stack.length}:${top.params?.id ?? ''}` : tab} {...(top?.params ?? {})} /></View>
      {wide ? null : <TabBar />}
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
