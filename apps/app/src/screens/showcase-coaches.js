import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T } from '../ui';

const SPORTS = ['Football', 'Tennis', 'Cricket', 'Basketball', 'Badminton'];
const OBJECTIVES = ['Technique', 'Fitness', 'Tactics', 'Mental Strength'];
const BADGES = ['✓ Verified', '🛡 DBS Checked', '🏅 Level 2 Licensed'];
const isWeb = Platform.OS === 'web';

function TacticalBoard({ sport }) {
  const color = c.pink;
  const bg = c.violetSoft;
  const isTennis = sport === 'Tennis';

  if (isWeb) {
    return (
      <View accessibilityLabel={`${sport} tactical board`} style={{ marginVertical: 8 }}>
        {/* eslint-disable-next-line react-native/no-inline-styles */}
        <div dangerouslySetInnerHTML={{ __html: isTennis
          ? `<svg viewBox="0 0 200 100" width="100%" height="110" xmlns="http://www.w3.org/2000/svg">
              <rect x="2" y="2" width="196" height="96" rx="4" fill="${bg}" stroke="${color}" stroke-width="2"/>
              <line x1="100" y1="2" x2="100" y2="98" stroke="${color}" stroke-width="1.5"/>
              <line x1="2" y1="50" x2="198" y2="50" stroke="${color}" stroke-width="1.5"/>
              <circle cx="40" cy="30" r="6" fill="${color}" opacity="0.9"/>
              <circle cx="160" cy="30" r="6" fill="${color}" opacity="0.9"/>
              <circle cx="100" cy="70" r="6" fill="${color}" opacity="0.9"/>
            </svg>`
          : `<svg viewBox="0 0 200 130" width="100%" height="130" xmlns="http://www.w3.org/2000/svg">
              <rect x="2" y="2" width="196" height="126" rx="4" fill="${bg}" stroke="${color}" stroke-width="2"/>
              <line x1="100" y1="2" x2="100" y2="128" stroke="${color}" stroke-width="1.5"/>
              <circle cx="100" cy="65" r="20" fill="none" stroke="${color}" stroke-width="1.5"/>
              <rect x="2" y="38" width="30" height="54" rx="2" fill="none" stroke="${color}" stroke-width="1.5"/>
              <rect x="168" y="38" width="30" height="54" rx="2" fill="none" stroke="${color}" stroke-width="1.5"/>
              <circle cx="40" cy="40" r="7" fill="${color}" opacity="0.85"/>
              <circle cx="100" cy="30" r="7" fill="${color}" opacity="0.85"/>
              <circle cx="160" cy="40" r="7" fill="${color}" opacity="0.85"/>
              <circle cx="70" cy="90" r="7" fill="#fff" stroke="${color}" stroke-width="2" opacity="0.9"/>
            </svg>`
        }} />
      </View>
    );
  }

  // Native fallback
  return (
    <View accessibilityLabel={`${sport} tactical board`} style={{ height: 100, backgroundColor: bg, borderRadius: r.card, borderWidth: 2, borderColor: color, margin: 8, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <T size={12} color={color} weight="700">{sport} Tactical Board</T>
      <View style={{ flexDirection: 'row', gap: 24 }}>
        {[0, 1, 2].map((i) => <View key={i} style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: color }} />)}
      </View>
    </View>
  );
}

export function ShowcaseCoaches({ block, manifest, onCta }) {
  const [sport, setSport] = useState('Football');
  const [objective, setObjective] = useState('Technique');

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>Coaches</T>

      <View style={{ gap: 10 }}>
        <T size={12} weight="600" color={c.mute}>SPORT</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {SPORTS.map((s) => {
            const sel = sport === s;
            return (
              <Pressable key={s} onPress={() => setSport(s)} accessibilityRole="button" accessibilityLabel={s} accessibilityState={{ selected: sel }}>
                <View style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: r.pill, backgroundColor: sel ? c.pink : c.paper, borderWidth: 1, borderColor: sel ? c.pink : c.line, minHeight: 44, justifyContent: 'center' }}>
                  <T size={13} weight="600" color={sel ? '#fff' : c.mute}>{s}</T>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <T size={12} weight="600" color={c.mute}>OBJECTIVE</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {OBJECTIVES.map((o) => {
            const sel = objective === o;
            return (
              <Pressable key={o} onPress={() => setObjective(o)} accessibilityRole="button" accessibilityLabel={o} accessibilityState={{ selected: sel }}>
                <View style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: r.pill, backgroundColor: sel ? c.violet : c.paper, borderWidth: 1, borderColor: sel ? c.violet : c.line, minHeight: 44, justifyContent: 'center' }}>
                  <T size={13} weight="600" color={sel ? '#fff' : c.mute}>{o}</T>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Card pad={0} style={{ overflow: 'hidden' }}>
        <TacticalBoard sport={sport} />
        <View style={{ padding: 12 }}>
          <T weight="700" size={14}>{sport} · {objective}</T>
          <T size={12} color={c.mute}>Tactical board — illustrative positions</T>
        </View>
      </Card>

      {/* Session template */}
      <Card>
        <T weight="700" size={14} style={{ marginBottom: 8 }}>Sample session</T>
        <View style={{ backgroundColor: c.pinkSoft, borderRadius: r.card, padding: 14, flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {['60 min', objective, '1:1', 'Intermediate'].map((tag) => (
            <View key={tag} style={{ backgroundColor: c.paper, borderRadius: r.pill, paddingVertical: 4, paddingHorizontal: 12 }}>
              <T size={12} weight="600" color={c.pink}>{tag}</T>
            </View>
          ))}
        </View>
      </Card>

      {/* Credential badges */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {BADGES.map((b) => (
          <View key={b} style={{ backgroundColor: c.pinkSoft, borderRadius: r.pill, paddingVertical: 8, paddingHorizontal: 14 }}>
            <T size={13} weight="700" color={c.pink}>{b}</T>
          </View>
        ))}
      </View>

      <Btn title="Find coaches →" onPress={() => onCta('coach-discovery')} />
    </View>
  );
}
