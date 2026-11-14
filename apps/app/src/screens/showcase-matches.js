import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T } from '../ui';

const FORMATS = ['Knockout', 'League', 'Groups', 'Round Robin'];
const TIMELINE = ['Create', 'Register', 'Schedule', 'Officiate', 'Results'];

const QF = [['Team A', 'Team B'], ['Team C', 'Team D'], ['Team E', 'Team F'], ['Team G', 'Team H']];
const SF = [['Winner QF1', 'Winner QF2'], ['Winner QF3', 'Winner QF4']];
const FINAL = [['Winner SF1', 'Winner SF2']];

const LEAGUE_ROWS = [
  { pos: 1, team: 'Team A', p: 10, w: 7, d: 2, l: 1, pts: 23 },
  { pos: 2, team: 'Team B', p: 10, w: 6, d: 2, l: 2, pts: 20 },
  { pos: 3, team: 'Team C', p: 10, w: 5, d: 3, l: 2, pts: 18 },
  { pos: 4, team: 'Team D', p: 10, w: 4, d: 2, l: 4, pts: 14 },
];

function MatchBox({ home, away }) {
  return (
    <View style={{ backgroundColor: c.paper, borderRadius: 10, borderWidth: 1, borderColor: c.line, paddingVertical: 8, paddingHorizontal: 12, width: 180, gap: 4 }}>
      <T size={12} weight="600" color={c.mute}>{home}</T>
      <View style={{ height: 1, backgroundColor: c.line }} />
      <T size={12} weight="600" color={c.mute}>{away}</T>
    </View>
  );
}

function KnockoutBracket() {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ flexDirection: 'row', gap: 24, alignItems: 'center', paddingVertical: 8 }}>
        <View style={{ gap: 12 }}>
          <T size={10} weight="700" color={c.mute} style={{ marginBottom: 4 }}>QUARTER-FINALS</T>
          {QF.map(([h, a], i) => <MatchBox key={i} home={h} away={a} />)}
        </View>
        <View style={{ gap: 48, marginTop: 32 }}>
          <T size={10} weight="700" color={c.mute} style={{ marginBottom: 4 }}>SEMI-FINALS</T>
          {SF.map(([h, a], i) => <MatchBox key={i} home={h} away={a} />)}
        </View>
        <View style={{ marginTop: 72 }}>
          <T size={10} weight="700" color={c.mute} style={{ marginBottom: 4 }}>FINAL</T>
          <MatchBox home={FINAL[0][0]} away={FINAL[0][1]} />
        </View>
      </View>
    </ScrollView>
  );
}

function LeagueTable() {
  return (
    <View>
      <View style={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6, backgroundColor: c.pinkSoft, borderRadius: 8, marginBottom: 4 }}>
        {['#', 'Team', 'P', 'W', 'D', 'L', 'Pts'].map((h, i) => (
          <T key={h} size={11} weight="700" color={c.pink} style={{ flex: i === 1 ? 3 : 1, textAlign: i > 1 ? 'center' : 'left' }}>{h}</T>
        ))}
      </View>
      {LEAGUE_ROWS.map((row) => (
        <View key={row.pos} style={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.line }}>
          {[row.pos, row.team, row.p, row.w, row.d, row.l, row.pts].map((v, i) => (
            <T key={i} size={13} weight={i === 6 ? '700' : '500'} color={i === 6 ? c.pink : c.ink} style={{ flex: i === 1 ? 3 : 1, textAlign: i > 1 ? 'center' : 'left' }}>{v}</T>
          ))}
        </View>
      ))}
    </View>
  );
}

export function ShowcaseMatches({ block, manifest, onCta }) {
  const [format, setFormat] = useState('Knockout');
  const [timelineStep, setTimelineStep] = useState(0);

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>Matches & Tournaments</T>

      {/* Format selector */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {FORMATS.map((f) => {
          const sel = format === f;
          return (
            <Pressable key={f} onPress={() => setFormat(f)} accessibilityRole="button" accessibilityLabel={f} accessibilityState={{ selected: sel }}>
              <View style={{ paddingVertical: 10, paddingHorizontal: 16, borderRadius: r.pill, backgroundColor: sel ? c.pink : c.paper, borderWidth: 1, borderColor: sel ? c.pink : c.line, minHeight: 44, justifyContent: 'center' }}>
                <T size={13} weight="600" color={sel ? '#fff' : c.mute}>{f}</T>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Bracket or table */}
      <Card pad={12}>
        <T weight="700" size={14} style={{ marginBottom: 12 }}>{format} · Example bracket</T>
        {format === 'Knockout' && <KnockoutBracket />}
        {format === 'League' && <LeagueTable />}
        {(format === 'Groups' || format === 'Round Robin') && (
          <View style={{ padding: 12, alignItems: 'center' }}>
            <T size={13} color={c.mute}>{format} format — groups drawn from registered teams</T>
          </View>
        )}
      </Card>

      {/* Tournament timeline */}
      <Card>
        <T weight="700" size={14} style={{ marginBottom: 12 }}>Tournament journey</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', gap: 0 }}>
          {TIMELINE.map((s, i) => (
            <React.Fragment key={s}>
              <Pressable onPress={() => setTimelineStep(i)} accessibilityRole="button" accessibilityLabel={`${s} phase`} accessibilityState={{ selected: i === timelineStep }}>
                <View style={{ alignItems: 'center', paddingHorizontal: 4 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: i <= timelineStep ? c.pink : c.line, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={12} weight="800" color={i <= timelineStep ? '#fff' : c.mute}>{i + 1}</T>
                  </View>
                  <T size={10} weight="600" color={i === timelineStep ? c.pink : c.mute} style={{ marginTop: 4 }}>{s}</T>
                </View>
              </Pressable>
              {i < TIMELINE.length - 1 && <View style={{ width: 20, height: 2, backgroundColor: i < timelineStep ? c.pink : c.line, marginBottom: 16 }} />}
            </React.Fragment>
          ))}
        </ScrollView>
      </Card>

      <Btn title="Find tournaments →" onPress={() => onCta('tournament-discovery')} />
    </View>
  );
}
