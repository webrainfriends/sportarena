import React from 'react';
import { Platform, Pressable, StatusBar, Text, View } from 'react-native';
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

function TabBar() {
  const { tab, goTab } = useNav();
  const ins = useSafeAreaInsets();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.violet, paddingBottom: Math.max(ins.bottom, 6), justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row', flex: 1, maxWidth: 720 }}>
        {TABS.map(([name]) => {
          const on = tab === name;
          return (
            <Pressable key={name} onPress={() => goTab(name)} style={{ flex: 1, alignItems: 'center', paddingVertical: 14 }}>
              <View style={{ position: 'absolute', top: 0, width: 28, height: 3, borderRadius: 2, backgroundColor: on ? c.lime : 'transparent' }} />
              <Text style={[fam, { fontSize: 12, fontWeight: '700', letterSpacing: 1, color: on ? '#fff' : '#7F8BA8' }]}>{name.toUpperCase()}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Shell() {
  const { ready, user } = useSession();
  const { tab, stack, back } = useNav();
  const ins = useSafeAreaInsets();
  if (!ready) return <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center' }}><Loading /></View>;
  if (!user) return <View style={{ flex: 1, paddingTop: ins.top, backgroundColor: c.bg }}><Auth /></View>;
  const top = stack[stack.length - 1];
  const Page = top ? PAGES[top.name] : TABS.find((t) => t[0] === tab)[1];
  return (
    <View style={{ flex: 1, paddingTop: ins.top, backgroundColor: top ? c.paper : c.violet }}>
      {top ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 12, backgroundColor: c.paper, borderBottomWidth: 1, borderColor: c.line }}>
          <Pressable onPress={back} hitSlop={10} style={{ paddingVertical: 4, paddingRight: 8 }}><Text style={[fam, { fontWeight: '700', color: c.pink, fontSize: 15 }]}>‹ Back</Text></Pressable>
          <Text style={[fam, { fontWeight: '700', fontSize: 16, color: c.ink }]}>{TITLES[top.name]}</Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.violet, gap: 8 }}>
          <View style={{ width: 8, height: 22, backgroundColor: c.lime, borderRadius: 2, transform: [{ skewX: '-14deg' }] }} />
          <Text style={[fam, { color: '#fff', fontWeight: '800', fontSize: 18, letterSpacing: 1.5 }]}>SPORT<Text style={{ color: c.lime }}>ARENA</Text></Text>
        </View>
      )}
      <View style={{ flex: 1 }}><Page key={top ? `${top.name}:${stack.length}:${top.params?.id ?? ''}` : tab} {...(top?.params ?? {})} /></View>
      <TabBar />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SessionProvider><NavProvider><Shell /></NavProvider></SessionProvider>
    </SafeAreaProvider>
  );
}
