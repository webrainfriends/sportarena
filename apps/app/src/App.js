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
    <View style={{ alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: Math.max(ins.bottom, 12), backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', width: '100%', maxWidth: 520, backgroundColor: c.paper, borderRadius: 999, padding: 6, borderWidth: 1, borderColor: c.line }}>
        {TABS.map(([name]) => {
          const on = tab === name;
          return (
            <Pressable key={name} onPress={() => goTab(name)} style={{ flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 999, backgroundColor: on ? c.lime : 'transparent' }}>
              <Text style={[fam, { fontSize: 12, fontWeight: '700', letterSpacing: 1, color: on ? c.on : c.mute }]}>{name.toUpperCase()}</Text>
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
    <View style={{ flex: 1, paddingTop: ins.top, backgroundColor: c.bg }}>
      {top ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 12, backgroundColor: c.bg }}>
          <Pressable onPress={back} hitSlop={10} style={{ paddingVertical: 4, paddingRight: 8 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.paper, borderRadius: 999, borderWidth: 1, borderColor: c.line, paddingVertical: 7, paddingHorizontal: 14 }}><Text style={[fam, { fontWeight: '700', color: c.lime, fontSize: 14 }]}>‹  Back</Text></View></Pressable>
          <Text style={[fam, { fontWeight: '700', fontSize: 16, color: c.ink }]}>{TITLES[top.name]}</Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: c.bg, gap: 8 }}>
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
