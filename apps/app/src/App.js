import React from 'react';
import { Platform, Pressable, StatusBar, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from './session';
import { NavProvider, useNav } from './nav';
import { Loading } from './ui';
import { fam } from './theme';
import { c } from './theme';
import Auth from './screens/auth';
import Home from './screens/home';
import { Play, Event, Team, Person } from './screens/play';
import { Book, Venue } from './screens/book';
import { Hub, Leaderboard, Awards, Health, Insurance, Sponsors, Supply } from './screens/hub';
import { Me } from './screens/me';

const TABS = [['Home', Home], ['Play', Play], ['Book', Book], ['Hub', Hub], ['Me', Me]];
const PAGES = { Event, Team, Person, Venue, Leaderboard, Awards, Health, Insurance, Sponsors, Supply };
const TITLES = { Event: 'Event', Team: 'Team', Person: 'Profile', Venue: 'Venue', Leaderboard: 'Leaderboard', Awards: 'Trophy room', Health: 'Health', Insurance: 'Insurance', Sponsors: 'Sponsors', Supply: 'Supply chain' };

const Wordmark = ({ light }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
    <View style={{ width: 9, height: 22, backgroundColor: c.pink, transform: [{ skewX: '-16deg' }] }} />
    <Text style={[fam, { color: light ? '#fff' : c.ink, fontWeight: '800', fontSize: 19, letterSpacing: -0.4 }]}>SportArena</Text>
  </View>
);

function TabBar() {
  const { tab, goTab } = useNav();
  const ins = useSafeAreaInsets();
  return (
    <View style={{ backgroundColor: c.paper, borderTopWidth: 1, borderColor: c.line, paddingBottom: Math.max(ins.bottom, 6), alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', width: '100%', maxWidth: 560 }}>
        {TABS.map(([name]) => {
          const on = tab === name;
          return (
            <Pressable key={name} onPress={() => goTab(name)} style={{ flex: 1, alignItems: 'center', paddingTop: 14, paddingBottom: 12 }}>
              <View style={{ position: 'absolute', top: 0, width: 26, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, backgroundColor: on ? c.pink : 'transparent' }} />
              <Text style={[fam, { fontSize: 12, fontWeight: on ? '800' : '600', letterSpacing: 0.8, color: on ? c.ink : c.mute }]}>{name.toUpperCase()}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function SideNav() {
  const { tab, goTab } = useNav();
  const { user, signOut } = useSession();
  return (
    <View style={{ width: 232, backgroundColor: c.violet, padding: 20, paddingTop: 28 }}>
      <Wordmark light />
      <View style={{ marginTop: 36, gap: 4 }}>
        {TABS.map(([name]) => {
          const on = tab === name;
          return (
            <Pressable key={name} onPress={() => goTab(name)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: on ? 'rgba(255,255,255,0.1)' : 'transparent' }}>
              <View style={{ width: 4, height: 16, borderRadius: 2, backgroundColor: on ? c.pink : 'transparent' }} />
              <Text style={[fam, { fontSize: 15, fontWeight: on ? '700' : '500', color: on ? '#fff' : '#9A9FAB' }]}>{name === 'Hub' ? 'Ecosystem' : name}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flex: 1 }} />
      <Text style={[fam, { color: '#9A9FAB', fontSize: 13 }]} numberOfLines={1}>{user?.display_name}</Text>
      <Pressable onPress={signOut}><Text style={[fam, { color: '#fff', fontWeight: '700', fontSize: 13, marginTop: 6 }]}>Log out</Text></Pressable>
    </View>
  );
}

function Shell() {
  const { ready, user } = useSession();
  const { tab, stack, back } = useNav();
  const ins = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = Platform.OS === 'web' && width >= 900;
  if (!ready) return <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: 24 }}><Loading /></View>;
  if (!user) return <View style={{ flex: 1, paddingTop: ins.top, backgroundColor: c.bg }}><Auth /></View>;
  const top = stack[stack.length - 1];
  const Page = top ? PAGES[top.name] : TABS.find((t) => t[0] === tab)[1];
  const body = (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {top ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 12 }}>
          <Pressable onPress={back} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.paper, borderRadius: 999, borderWidth: 1, borderColor: c.line, paddingVertical: 7, paddingHorizontal: 14 }}>
            <Text style={[fam, { fontWeight: '700', color: c.ink, fontSize: 14 }]}>‹  Back</Text>
          </Pressable>
          <Text style={[fam, { fontWeight: '700', fontSize: 15, color: c.mute }]}>{TITLES[top.name]}</Text>
        </View>
      ) : wide ? null : (
        <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}><Wordmark /></View>
      )}
      <View style={{ flex: 1 }}><Page key={top ? `${top.name}:${stack.length}:${top.params?.id ?? ''}` : tab} {...(top?.params ?? {})} /></View>
    </View>
  );
  return (
    <View style={{ flex: 1, flexDirection: 'row', paddingTop: ins.top, backgroundColor: c.bg }}>
      {wide ? <SideNav /> : null}
      <View style={{ flex: 1 }}>{body}{wide ? null : <TabBar />}</View>
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
