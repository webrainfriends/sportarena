import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { c, r } from '../theme';
import { Btn, Card, T } from '../ui';

const OBJECTIVES = ['Brand Awareness', 'Talent Support', 'Community'];
const TYPES = ['Monetary', 'In-Kind', 'Endorsement'];
const TIERS = ['Gold', 'Silver', 'Bronze'];
const isWeb = Platform.OS === 'web';

const NODES = [
  { id: 'sponsor', label: 'Your Brand', x: 100, y: 90, r: 28, main: true },
  { id: 'athlete', label: 'Athletes', x: 40, y: 30, r: 20 },
  { id: 'team', label: 'Teams', x: 160, y: 30, r: 20 },
  { id: 'event', label: 'Events', x: 100, y: 170, r: 20 },
];

function RelationshipMap({ pulse }) {
  if (!isWeb) {
    return (
      <View style={{ height: 100, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 24, alignItems: 'center' }}>
          {['Athletes', 'Your Brand', 'Teams'].map((n, i) => (
            <View key={n} style={{ width: i === 1 ? 70 : 54, height: i === 1 ? 70 : 54, borderRadius: 35, backgroundColor: i === 1 ? c.pink : c.pinkSoft, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.pink }}>
              <T size={10} weight="700" color={i === 1 ? '#fff' : c.pink} style={{ textAlign: 'center' }}>{n}</T>
            </View>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View accessibilityLabel="Sponsor relationship map">
      {/* eslint-disable-next-line react-native/no-inline-styles */}
      <div dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 200 200" width="100%" height="180" xmlns="http://www.w3.org/2000/svg">
        <line x1="100" y1="90" x2="40" y2="30" stroke="${c.pink}" stroke-width="1.5" opacity="0.5" stroke-dasharray="4"/>
        <line x1="100" y1="90" x2="160" y2="30" stroke="${c.pink}" stroke-width="1.5" opacity="0.5" stroke-dasharray="4"/>
        <line x1="100" y1="90" x2="100" y2="170" stroke="${c.pink}" stroke-width="1.5" opacity="0.5" stroke-dasharray="4"/>
        <circle cx="40" cy="30" r="20" fill="${c.pinkSoft}" stroke="${c.pink}" stroke-width="1.5"/>
        <text x="40" y="34" text-anchor="middle" font-size="9" font-weight="700" fill="${c.pink}">Athletes</text>
        <circle cx="160" cy="30" r="20" fill="${c.pinkSoft}" stroke="${c.pink}" stroke-width="1.5"/>
        <text x="160" y="34" text-anchor="middle" font-size="9" font-weight="700" fill="${c.pink}">Teams</text>
        <circle cx="100" cy="170" r="20" fill="${c.pinkSoft}" stroke="${c.pink}" stroke-width="1.5"/>
        <text x="100" y="174" text-anchor="middle" font-size="9" font-weight="700" fill="${c.pink}">Events</text>
        <circle cx="100" cy="90" r="30" fill="${c.pink}" opacity="0.9"/>
        <text x="100" y="87" text-anchor="middle" font-size="9" font-weight="800" fill="white">Your</text>
        <text x="100" y="99" text-anchor="middle" font-size="9" font-weight="800" fill="white">Brand</text>
      </svg>` }} />
    </View>
  );
}

export function ShowcaseSponsors({ block, manifest, onCta }) {
  const [objective, setObjective] = useState('Brand Awareness');
  const [type, setType] = useState('Monetary');
  const [tier, setTier] = useState('Gold');
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulseAnim]);

  const tierColors = { Gold: '#D97706', Silver: '#6B7280', Bronze: '#EA580C' };

  return (
    <View style={{ gap: 20 }}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>Sponsors</T>

      <Card pad={12}>
        <RelationshipMap pulse={pulseAnim} />
      </Card>

      {/* Strategy builder */}
      <Card>
        <T weight="700" size={15} style={{ marginBottom: 14 }}>Sponsorship strategy builder</T>

        <T size={12} weight="600" color={c.mute} style={{ marginBottom: 8 }}>OBJECTIVE</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {OBJECTIVES.map((o) => {
            const sel = objective === o;
            return (
              <Pressable key={o} onPress={() => setObjective(o)} accessibilityRole="button" accessibilityLabel={o} accessibilityState={{ selected: sel }}>
                <View style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: r.pill, backgroundColor: sel ? c.pink : c.paper, borderWidth: 1, borderColor: sel ? c.pink : c.line, minHeight: 44, justifyContent: 'center' }}>
                  <T size={13} weight="600" color={sel ? '#fff' : c.mute}>{o}</T>
                </View>
              </Pressable>
            );
          })}
        </View>

        <T size={12} weight="600" color={c.mute} style={{ marginBottom: 8 }}>TYPE</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {TYPES.map((tp) => {
            const sel = type === tp;
            return (
              <Pressable key={tp} onPress={() => setType(tp)} accessibilityRole="button" accessibilityLabel={tp} accessibilityState={{ selected: sel }}>
                <View style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: r.pill, backgroundColor: sel ? c.violet : c.paper, borderWidth: 1, borderColor: sel ? c.violet : c.line, minHeight: 44, justifyContent: 'center' }}>
                  <T size={13} weight="600" color={sel ? '#fff' : c.mute}>{tp}</T>
                </View>
              </Pressable>
            );
          })}
        </View>

        <T size={12} weight="600" color={c.mute} style={{ marginBottom: 8 }}>TIER</T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {TIERS.map((t) => {
            const sel = tier === t;
            const col = tierColors[t];
            return (
              <Pressable key={t} onPress={() => setTier(t)} accessibilityRole="button" accessibilityLabel={`${t} tier`} accessibilityState={{ selected: sel }}>
                <View style={{ paddingVertical: 8, paddingHorizontal: 16, borderRadius: r.pill, backgroundColor: sel ? col : c.paper, borderWidth: sel ? 0 : 1, borderColor: c.line, minHeight: 44, justifyContent: 'center' }}>
                  <T size={13} weight="700" color={sel ? '#fff' : c.mute}>{t}</T>
                </View>
              </Pressable>
            );
          })}
        </View>
      </Card>

      {/* Package preview */}
      <View style={{ backgroundColor: c.pinkSoft, borderRadius: r.card, padding: 16, borderWidth: 1, borderColor: c.pink }}>
        <T weight="700" size={13} color={c.pink} style={{ marginBottom: 6 }}>Your package preview</T>
        <T size={14} weight="600">{tier} · {type} · {objective}</T>
        <T size={12} color={c.mute} style={{ marginTop: 4 }}>No real commitments — explore the builder</T>
      </View>

      <Btn title="Explore sponsorship →" onPress={() => onCta('sponsor-marketplace')} />
    </View>
  );
}
