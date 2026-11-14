import React, { useState, useRef, useEffect } from 'react';
import { View, ScrollView, TouchableOpacity, Dimensions, Animated, Platform, AccessibilityInfo } from 'react-native';
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

const CHAPTER_BG = {
  news:      ['#0d1117', '#1a1c27'],
  athletes:  ['#1a0a2e', '#2a1a3e'],
  venues:    ['#0a1a24', '#0d2030'],
  academies: ['#0d0f20', '#1a1c3a'],
  matches:   ['#1a0a0a', '#2a1010'],
  coaches:   ['#0a1a0a', '#152015'],
  physios:   ['#1a0a1a', '#2a102a'],
  sponsors:  ['#1a1a00', '#2a2800'],
  suppliers: ['#1a1200', '#2a1f00'],
  learn:     ['#0a0a1a', '#10102a'],
};

const W = Dimensions.get('window').width;
const WIDE = W >= 768;

const STARS = Array.from({ length: 22 }, (_, i) => ({
  x: (i * 37 + 11) % 100,
  y: (i * 53 + 7) % 100,
  size: 1.5 + (i % 3),
  dur: 3000 + (i % 5) * 1000,
  delay: i * 200,
}));

function StarField({ reduceMotion }) {
  const anims = useRef(STARS.map(() => new Animated.Value(0.1))).current;
  useEffect(() => {
    if (reduceMotion) return;
    anims.forEach((a, i) => {
      Animated.loop(Animated.sequence([
        Animated.delay(STARS[i].delay),
        Animated.timing(a, { toValue: 0.6, duration: STARS[i].dur, useNativeDriver: true }),
        Animated.timing(a, { toValue: 0.1, duration: STARS[i].dur, useNativeDriver: true }),
      ])).start();
    });
  }, [reduceMotion]);
  return (
    <View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}
      pointerEvents="none">
      {STARS.map((s, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: s.size,
            height: s.size,
            borderRadius: s.size / 2,
            backgroundColor: '#D0BDF4',
            opacity: anims[i],
          }}
        />
      ))}
    </View>
  );
}

export function ShowcaseLanding({ manifest, onNavigate }) {
  const [active, setActive] = useState('news');
  const [reduceMotion, setReduceMotion] = useState(false);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const bgOpacA  = useRef(new Animated.Value(1)).current;
  const bgOpacB  = useRef(new Animated.Value(0)).current;
  const bgColsRef = useRef({ a: CHAPTER_BG.news, b: CHAPTER_BG.news });
  const isA = useRef(true);
  const chipScales = useRef(CHAPTERS.map(() => new Animated.Value(1))).current;
  const tabGlows   = useRef(CHAPTERS.map(() => new Animated.Value(0.0))).current;
  const tabGlowLoops = useRef([]);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
  }, []);

  const startTabGlow = (idx) => {
    tabGlowLoops.current.forEach((l) => l && l.stop && l.stop());
    if (reduceMotion) return;
    tabGlows.forEach((g, i) => g.setValue(i === idx ? 0.3 : 0));
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(tabGlows[idx], { toValue: 0.7, duration: 1200, useNativeDriver: true }),
      Animated.timing(tabGlows[idx], { toValue: 0.3, duration: 1200, useNativeDriver: true }),
    ]));
    tabGlowLoops.current[idx] = loop;
    loop.start();
  };

  useEffect(() => {
    const idx = CHAPTERS.findIndex((c) => c.key === 'news');
    startTabGlow(idx);
  }, [reduceMotion]);

  const switchChapter = (key) => {
    if (key === active) return;
    const nextIdx = CHAPTERS.findIndex((c) => c.key === key);
    const bg = CHAPTER_BG[key] || CHAPTER_BG.news;

    if (reduceMotion) {
      setActive(key);
      startTabGlow(nextIdx);
      return;
    }

    if (isA.current) {
      bgColsRef.current.b = bg;
      Animated.parallel([
        Animated.timing(bgOpacA, { toValue: 0, duration: 400, useNativeDriver: true }),
        Animated.timing(bgOpacB, { toValue: 1, duration: 400, useNativeDriver: true }),
      ]).start(() => { isA.current = false; });
    } else {
      bgColsRef.current.a = bg;
      Animated.parallel([
        Animated.timing(bgOpacA, { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.timing(bgOpacB, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start(() => { isA.current = true; });
    }

    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0, duration: 100, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();

    setActive(key);
    startTabGlow(nextIdx);
  };

  const bounceChip = (idx) => {
    if (reduceMotion) return;
    Animated.sequence([
      Animated.spring(chipScales[idx], { toValue: 1.08, useNativeDriver: true, tension: 200, friction: 5 }),
      Animated.spring(chipScales[idx], { toValue: 1.0, useNativeDriver: true, tension: 200, friction: 5 }),
    ]).start();
  };

  const { Component } = CHAPTERS.find((ch) => ch.key === active);
  const chapterBlock = manifest?.blocks?.find((b) => b.config?.chapter === active);
  const bgA = bgColsRef.current.a;
  const bgB = bgColsRef.current.b;

  return (
    <View style={{ borderRadius: 20, overflow: 'hidden', marginVertical: 16 }}>
      <LinearGradient colors={[palette.p0, '#1a1c27']} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: bgOpacA }}>
        <LinearGradient colors={bgA} style={{ flex: 1 }} />
      </Animated.View>
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: bgOpacB }}>
        <LinearGradient colors={bgB} style={{ flex: 1 }} />
      </Animated.View>

      <View style={{ flexDirection: WIDE ? 'row' : 'column', minHeight: WIDE ? 520 : undefined }}>
        {WIDE ? (
          <View style={{ width: 160, backgroundColor: 'rgba(0,0,0,0.3)', paddingVertical: 12, paddingHorizontal: 8 }}>
            <T style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 10, marginStart: 4 }}>EXPLORE</T>
            {CHAPTERS.map((ch, idx) => {
              const sel = ch.key === active;
              return (
                <TouchableOpacity
                  key={ch.key}
                  onPress={() => switchChapter(ch.key)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: sel }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 10, marginBottom: 2, overflow: 'hidden' }}>
                  {sel && (
                    <Animated.View style={{
                      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                      borderRadius: 10, backgroundColor: palette.p2,
                      opacity: tabGlows[idx].interpolate({ inputRange: [0, 0.7], outputRange: [0.6, 1.0] }),
                    }} />
                  )}
                  {sel && (
                    <Animated.View style={{
                      position: 'absolute', top: -4, left: -4, right: -4, bottom: -4,
                      borderRadius: 14, backgroundColor: palette.p2,
                      opacity: tabGlows[idx],
                    }} />
                  )}
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
            style={{ backgroundColor: 'rgba(0,0,0,0.3)', paddingVertical: 10 }}
            contentContainerStyle={{ paddingHorizontal: 12, gap: 6, flexDirection: 'row' }}>
            {CHAPTERS.map((ch, idx) => {
              const sel = ch.key === active;
              return (
                <Animated.View key={ch.key} style={{ transform: [{ scale: chipScales[idx] }] }}>
                  <TouchableOpacity
                    onPress={() => { bounceChip(idx); switchChapter(ch.key); }}
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
                </Animated.View>
              );
            })}
          </ScrollView>
        )}

        <Animated.View style={{ flex: 1, opacity: fadeAnim, position: 'relative' }}>
          <StarField reduceMotion={reduceMotion} />
          <Component manifest={manifest} block={chapterBlock} onNavigate={onNavigate} />
        </Animated.View>
      </View>
    </View>
  );
}
