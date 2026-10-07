import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Bubble, Card, ErrorBox, GradCard, H1, Loading, Row, Screen, Section, StatPill, T, Tag } from '../ui';
import { FixtureCard, awardEmoji } from '../blocks';
import { c, grad, day, accentFor } from '../theme';

export default function Home() {
  const { user } = useSession();
  const { push, goTab } = useNav();
  const feed = useLoad(() => api.get('/feed'), []);
  const dash = useLoad(() => api.get('/dashboard'), []);
  const d = dash.data, f = feed.data;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <Avatar user={user} size={54} />
        <View style={{ flex: 1 }}><T size={13} color={c.mute} weight="800">WELCOME BACK</T><H1 style={{ fontSize: 28 }}>{user.display_name} 👋</H1></View>
      </View>

      <GradCard colors={grad.sunset} style={{ marginTop: 16 }}>
        <Text style={{ position: 'absolute', right: 0, top: -6, fontSize: 64 }}>🔥</Text>
        <T color="#fff" weight="900" size={13}>YOUR SEASON</T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <StatPill value={d?.points ?? '–'} label="POINTS" color={c.lime} />
          <StatPill value={d?.trophies ?? '–'} label="TROPHIES" color={c.sun} />
          <StatPill value={d?.teams?.length ?? '–'} label="TEAMS" color={c.cyan} />
          <StatPill value={d?.fit_to_play === 'cleared' ? '✅' : d?.fit_to_play === 'restricted' ? '⚠️' : d?.fit_to_play === 'not_cleared' ? '⛔' : '❔'} label="FIT TO PLAY" color={c.mint} />
        </View>
      </GradCard>

      {feed.loading && !f ? <Loading /> : feed.error ? <ErrorBox error={feed.error} onRetry={feed.reload} /> : f && <>
        {d?.next_games?.length ? (
          <Section title="Your next games" emoji="⏰" color={c.cyan}>
            {d.next_games.slice(0, 2).map((g) => <Card key={g.id} color={c.cyanSoft} pad={12}><T weight="900">{g.home_name} <T color={c.pink} weight="900">vs</T> {g.away_name}</T><T size={12} color={c.mute}>{new Date(g.scheduled_at).toLocaleString()} · {g.event_name}</T></Card>)}
          </Section>
        ) : null}

        <Section title="Happening soon" emoji="🎟️" action="All events" onAction={() => goTab('Play')} color={c.pink}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingRight: 12, paddingBottom: 4 }}>
            {f.events.map((e, i) => (
              <Card key={e.id} color={[c.pinkSoft, c.violetSoft, c.limeSoft, c.sunSoft][i % 4]} style={{ width: 200 }} onPress={() => push('Event', { id: e.id })} tilt={i % 2 ? 1 : -1}>
                <T size={44}>{e.banner_emoji}</T>
                <T weight="900" size={17} style={{ marginTop: 4 }}>{e.name}</T>
                <T size={12} color={c.mute} style={{ marginTop: 2 }}>{e.sport_emoji} {e.sport}{e.starts_on ? ` · ${day(e.starts_on)}` : ''}</T>
                <Tag label={e.kind} color={c.ink} ink="#fff" style={{ marginTop: 8 }} />
              </Card>
            ))}
          </ScrollView>
        </Section>

        {f.games.length ? <Section title="On the pitch" emoji="⚽" color={c.lime}>{f.games.slice(0, 3).map((g) => <FixtureCard key={g.id} f={{ ...g, home_emoji: g.home_emoji, away_emoji: g.away_emoji }} />)}</Section> : null}

        <Section title="Top athletes" emoji="🚀" action="Leaderboard" onAction={() => push('Leaderboard')} color={c.violet}>
          {f.top_athletes.map((a, i) => (
            <Row key={a.id} onPress={() => push('Person', { id: a.id })} left={<Avatar user={a} />} title={`${i + 1}. ${a.display_name}`} sub={`@${a.handle}`}
              right={<View style={{ backgroundColor: c.lime, borderWidth: 2.5, borderColor: c.ink, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}><T weight="900">{a.points} pts</T></View>} />
          ))}
        </Section>

        {f.latest_awards.length ? <Section title="Fresh silverware" emoji="🏆" color={c.sun}>
          {f.latest_awards.map((a) => <Row key={a.id} left={<Bubble emoji={awardEmoji(a.kind)} color={c.sun} />} title={a.name} sub={a.team_name ?? a.display_name} />)}
        </Section> : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
          <StatPill value={f.stats.people} label="PEOPLE" color={c.pinkSoft} /><StatPill value={f.stats.teams} label="TEAMS" color={c.violetSoft} />
          <StatPill value={f.stats.events} label="EVENTS" color={c.limeSoft} /><StatPill value={f.stats.venues} label="VENUES" color={c.cyanSoft} />
        </View>
      </>}
    </Screen>
  );
}
