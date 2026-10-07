import React from 'react';
import { Platform, Pressable, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from './session';
import { NavProvider, useNav } from './nav';
import { Loading } from './ui';
import { c } from './theme';
import Auth from './screens/auth';
import Home from './screens/home';
import { Play, Event, Team, Person } from './screens/play';
import { Book, Venue } from './screens/book';
import { Hub, Leaderboard, Awards, Health, Insurance, Sponsors, Supply } from './screens/hub';
import { Me } from './screens/me';

const TABS = [['Home', '🏠', Home, c.pink], ['Play', '🎮', Play, c.violet], ['Book', '📅', Book, c.cyan], ['Hub', '🌈', Hub, c.orange], ['Me', '😎', Me, c.mint]];
const PAGES = { Event, Team, Person, Venue, Leaderboard, Awards, Health, Insurance, Sponsors, Supply };
const TITLES = { Event: 'Event', Team: 'Team', Person: 'Profile', Venue: 'Venue', Leaderboard: 'Leaderboard', Awards: 'Trophy room', Health: 'Health', Insurance: 'Insurance', Sponsors: 'Sponsors', Supply: 'Supply chain' };

function TabBar() {
  const { tab, goTab } = useNav();
  const ins = useSafeAreaInsets();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.paper, borderTopWidth: 2.5, borderColor: c.ink, paddingBottom: Math.max(ins.bottom, 8), paddingTop: 8, justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row', flex: 1, maxWidth: 720 }}>
        {TABS.map(([name, emoji, , color]) => {
          const on = tab === name;
          return (
            <Pressable key={name} onPress={() => goTab(name)} style={{ flex: 1, alignItems: 'center' }}>
              <View style={{ backgroundColor: on ? color : 'transparent', borderWidth: on ? 2.5 : 0, borderColor: c.ink, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 4 }}>
                <Text style={{ fontSize: 22 }}>{emoji}</Text>
              </View>
              <Text style={{ fontSize: 11, fontWeight: '900', color: c.ink, marginTop: 2 }}>{name}</Text>
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
  const Page = top ? PAGES[top.name] : TABS.find((t) => t[0] === tab)[2];
  return (
    <View style={{ flex: 1, paddingTop: ins.top, backgroundColor: c.bg }}>
      {top ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 10 }}>
          <Pressable onPress={back} style={{ backgroundColor: c.sun, borderWidth: 2.5, borderColor: c.ink, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 6 }}><Text style={{ fontWeight: '900', color: c.ink }}>← Back</Text></Pressable>
          <Text style={{ fontWeight: '900', fontSize: 16, color: c.ink }}>{TITLES[top.name]}</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }}><Page key={top ? `${top.name}:${stack.length}:${top.params?.id ?? ''}` : tab} {...(top?.params ?? {})} /></View>
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
