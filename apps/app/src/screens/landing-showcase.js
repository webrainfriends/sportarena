import React, { useState, useRef } from 'react';
import { View, ScrollView, TouchableOpacity, Dimensions, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { T } from '../ui';
import { palette } from '../theme';
import { ShowcaseNews } from './showcase-news';
import { ShowcaseAthletes } from './showcase-athletes';
import { ShowcaseVenues } from './showcase-venues';
import { ShowcaseAcademies } from './showcase-academies';
import { ShowcaseMatches } from './showcase-matches';
import { ShowcaseCoaches } from './showcase-coaches';
import { ShowcasePhysios } from './showcase-physios';
import { ShowcaseSponsors } from './showcase-sponsors';
import { ShowcaseSuppliers } from './showcase-suppliers';
import { ShowcaseLearn } from './showcase-learn';

const CHAPTERS = [
  { key: 'news',      emoji: '📰', label: 'News',      Component: ShowcaseNews },
  { key: 'athletes',  emoji: '🏃', label: 'Athletes',  Component: ShowcaseAthletes },
  { key: 'venues',    emoji: '🏟', label: 'Venues',    Component: ShowcaseVenues },
  { key: 'academies', emoji: '🎓', label: 'Academies', Component: ShowcaseAcademies },
  { key: 'matches',   emoji: '🏆', label: 'Matches',   Component: ShowcaseMatches },
  { key: 'coaches',   emoji: '👨‍🏫', label: 'Coaches',  Component: ShowcaseCoaches },
  { key: 'physios',   emoji: '⚕️', label: 'Physios',   Component: ShowcasePhysios },
  { key: 'sponsors',  emoji: '🤝', label: 'Sponsors',  Component: ShowcaseSponsors },
  { key: 'suppliers', emoji: '📦', label: 'Suppliers', Component: ShowcaseSuppliers },
  { key: 'learn',     emoji: '📚', label: 'Learn',     Component: ShowcaseLearn },
];

const W = Dimensions.get('window').width;
const WIDE = W >= 768;

export function ShowcaseLanding({ manifest, onNavigate }) {
  const [active, setActive] = useState('news');
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const switchChapter = (key) => {
    if (key === active) return;
    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0, duration: 100, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();
    setActive(key);
  };

  const { Component } = CHAPTERS.find((ch) => ch.key === active);
  const chapterBlock = manifest?.blocks?.find((b) => b.config?.chapter === active);

  return (
    <LinearGradient colors={[palette.p0, palette.p1, '#1a1c27']} style={{ borderRadius: 20, overflow: 'hidden', marginVertical: 16 }}>
      <View style={{ flexDirection: WIDE ? 'row' : 'column', minHeight: WIDE ? 520 : undefined }}>
        {WIDE ? (
          <View style={{ width: 160, backgroundColor: palette.p0, paddingVertical: 12, paddingHorizontal: 8 }}>
            <T style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 10, marginStart: 4 }}>EXPLORE</T>
            {CHAPTERS.map((ch) => {
              const sel = ch.key === active;
              return (
                <TouchableOpacity
                  key={ch.key}
                  onPress={() => switchChapter(ch.key)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: sel }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 8,
                    paddingVertical: 10, paddingHorizontal: 10, borderRadius: 10, marginBottom: 2,
                    backgroundColor: sel ? palette.p2 : 'transparent',
                  }}>
                  <T style={{ fontSize: 16 }}>{ch.emoji}</T>
                  <T style={{ color: sel ? '#fff' : 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: sel ? '700' : '500' }}>{ch.label}</T>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ backgroundColor: palette.p0, paddingVertical: 10 }}
            contentContainerStyle={{ paddingHorizontal: 12, gap: 6, flexDirection: 'row' }}>
            {CHAPTERS.map((ch) => {
              const sel = ch.key === active;
              return (
                <TouchableOpacity
                  key={ch.key}
                  onPress={() => switchChapter(ch.key)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: sel }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 5,
                    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 20,
                    backgroundColor: sel ? palette.p2 : 'rgba(255,255,255,0.10)',
                    borderWidth: sel ? 0 : 1, borderColor: 'rgba(255,255,255,0.18)',
                  }}>
                  <T style={{ fontSize: 14 }}>{ch.emoji}</T>
                  <T style={{ color: '#fff', fontSize: 12, fontWeight: sel ? '700' : '500' }}>{ch.label}</T>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
          <Component manifest={manifest} block={chapterBlock} onNavigate={onNavigate} />
        </Animated.View>
      </View>
    </LinearGradient>
  );
}
