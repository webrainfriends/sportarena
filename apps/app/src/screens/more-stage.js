import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, Platform, Pressable, ScrollView, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { Avatar, T } from '../ui';
import { mediaUrl } from '../api';
import { c, dark } from '../theme';
import { TileArt, tileColors } from './more-art';

// Entrance: fade and rise in sequence; skipped when the person asked for reduced motion.
export function Pop({ i, style, children }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().catch(() => false).then((reduce) => {
      if (!live) return;
      if (reduce) v.setValue(1);
      else Animated.timing(v, { toValue: 1, duration: 380, delay: Math.min(i, 10) * 45, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
    });
    return () => { live = false; };
  }, [v, i]);
  return <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }]}>{children}</Animated.View>;
}

// Night-court scene used when there is no real photo to show.
function CourtScene({ w, h }) {
  return (
    <Svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
      <Rect width={w} height={h} fill="#1E1B4B" />
      <Circle cx={w * 0.2} cy={h * 0.1} r={h * 0.5} fill="#4F46E5" opacity={0.35} />
      <Circle cx={w * 0.85} cy={h * 0.95} r={h * 0.45} fill="#7C3AED" opacity={0.35} />
      <Path d={`M${w * 0.05} ${h * 0.7}H${w * 0.95}M${w * 0.5} ${h * 0.55}V${h * 0.95}`} stroke="#fff" strokeOpacity={0.18} strokeWidth={2} />
      <Circle cx={w * 0.5} cy={h * 0.75} r={h * 0.14} stroke="#fff" strokeOpacity={0.18} strokeWidth={2} fill="none" />
    </Svg>
  );
}

/**
 * Immersive top of More: a big circular "window" (the person's favourite venue photo when there is one, else an
 * illustrated court) holding their name and live numbers, with the main modules orbiting it on an arc.
 */
export function HeroStage({ user, line, sub, photo, orbit, onProfile }) {
  const [w, setW] = useState(0);
  const H = 420, cy = H / 2;
  const R = Math.min(128, w * 0.36), cx = R * 0.5, R2 = R + 56;
  const ang = orbit.map((_, i) => ((-62 + (124 / Math.max(1, orbit.length - 1)) * i) * Math.PI) / 180);
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: H, borderRadius: 28, overflow: 'hidden', backgroundColor: '#1E1B4B' }}>
      {w ? (
        <>
          {photo ? <Image source={{ uri: mediaUrl(photo) }} resizeMode="cover" accessibilityIgnoresInvertColors style={{ position: 'absolute', width: w, height: H }} /> : <CourtScene w={w} h={H} />}
          <LinearGradient colors={['rgba(15,23,42,0.55)', 'rgba(15,23,42,0.82)']} style={{ position: 'absolute', width: w, height: H }} />
          <Svg width={w} height={H} style={{ position: 'absolute' }} pointerEvents="none">
            <Circle cx={cx} cy={cy} r={R2} stroke="#fff" strokeOpacity={0.35} strokeWidth={1.5} fill="none" />
            <Circle cx={cx} cy={cy} r={R + 14} stroke="#fff" strokeOpacity={0.18} strokeWidth={1} fill="none" />
          </Svg>
          <Pressable onPress={onProfile} accessibilityRole="button" accessibilityLabel={`${user.display_name}. My profile, roles and settings`}
            style={{ position: 'absolute', left: cx - R, top: cy - R, width: R * 2, height: R * 2, borderRadius: R, overflow: 'hidden', borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)', backgroundColor: '#312E81' }}>
            {photo ? <Image source={{ uri: mediaUrl(photo) }} resizeMode="cover" accessibilityIgnoresInvertColors style={{ position: 'absolute', width: R * 2, height: R * 2 }} /> : <LinearGradient colors={['#4F46E5', '#7C3AED']} style={{ position: 'absolute', width: R * 2, height: R * 2 }} />}
            <LinearGradient colors={['rgba(15,23,42,0.05)', 'rgba(15,23,42,0.78)']} style={{ position: 'absolute', width: R * 2, height: R * 2 }} />
            <View style={{ position: 'absolute', left: R * 0.5 + 10, right: 8, bottom: R * 0.42 }}>
              <View style={{ marginBottom: 8 }}><Avatar user={user} size={40} /></View>
              <T weight="800" size={20} color="#fff" numberOfLines={1} style={{ letterSpacing: -0.4 }}>{user.display_name}</T>
              {line ? <T weight="500" size={12} color="rgba(255,255,255,0.9)" numberOfLines={1}>{line}</T> : null}
              {sub ? <T weight="700" size={13} color="#FDE68A" numberOfLines={1} style={{ marginTop: 2 }}>{sub}</T> : null}
            </View>
          </Pressable>
          {orbit.map((o, i) => {
            const x = cx + R2 * Math.cos(ang[i]), y = cy + R2 * Math.sin(ang[i]);
            const [from, to] = tileColors(o.name);
            return (
              <Pop key={o.name} i={i + 2} style={{ position: 'absolute', left: x - 27, top: y - 27 }}>
                <Pressable onPress={o.onPress} accessibilityRole="button" accessibilityLabel={o.badge ? `${o.label}, ${o.badge} need attention` : o.label} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, transform: [{ scale: pressed ? 0.94 : 1 }] })}>
                  <LinearGradient colors={[from, to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: 54, height: 54, borderRadius: 27, borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    <TileArt name={o.name} size={40} />
                  </LinearGradient>
                  {o.badge ? <View style={{ position: 'absolute', left: 36, top: -6, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: c.red, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' }}><T weight="800" size={11} color="#fff">{o.badge}</T></View> : null}
                  <T weight="700" size={13} color="#fff" style={{ letterSpacing: 0.2, ...(Platform.OS === 'web' ? { textShadow: '0 1px 6px rgba(0,0,0,0.6)' } : null) }}>{o.label}</T>
                </Pressable>
              </Pop>
            );
          })}
        </>
      ) : null}
    </View>
  );
}

/** Swipeable bold cards for what needs the person now. `items`: { name, title, chip, action, onPress }. Renders nothing when empty. */
export function FeatureCarousel({ items }) {
  const [i, setI] = useState(0);
  if (!items.length) return null;
  const W = 252, GAP = 12;
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={W + GAP} decelerationRate="fast" contentContainerStyle={{ gap: GAP, paddingRight: 8 }}
        onScroll={(e) => setI(Math.round(e.nativeEvent.contentOffset.x / (W + GAP)))} scrollEventThrottle={32}>
        {items.map((it, k) => {
          const [from, to] = tileColors(it.name);
          return (
            <Pop key={it.title} i={k}>
              <Pressable onPress={it.onPress} accessibilityRole="button" accessibilityLabel={`${it.title}. ${it.chip}`} style={({ pressed }) => ({ width: W, transform: [{ scale: pressed ? 0.98 : 1 }] })}>
                <LinearGradient colors={[from, to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ height: 196, borderRadius: 26, padding: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' }}>
                  <View pointerEvents="none" style={{ position: 'absolute', right: -40, bottom: -50, width: 190, height: 190, borderRadius: 95, backgroundColor: '#fff', opacity: 0.14 }} />
                  <TileArt name={it.name} size={128} style={{ position: 'absolute', right: -10, top: 8, transform: [{ rotate: '-8deg' }], opacity: dark ? 0.9 : 1 }} />
                  <View style={{ alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}><T weight="700" size={12} color="#fff">{it.chip}</T></View>
                  <View style={{ marginTop: 'auto' }}>
                    <T weight="800" size={22} color="#fff" numberOfLines={2} style={{ letterSpacing: -0.4, maxWidth: '78%' }}>{it.title}</T>
                    <View style={{ alignSelf: 'flex-start', marginTop: 10, backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 }}><T weight="800" size={13} color={to}>{it.action}</T></View>
                  </View>
                </LinearGradient>
              </Pressable>
            </Pop>
          );
        })}
      </ScrollView>
      {items.length > 1 ? (
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 10 }}>
          {items.map((it, k) => <View key={it.title} style={{ width: k === i ? 18 : 6, height: 6, borderRadius: 3, backgroundColor: k === i ? c.pink : c.line }} />)}
        </View>
      ) : null}
    </View>
  );
}
