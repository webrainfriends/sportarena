import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, PanResponder, Platform, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Avatar, T } from '../ui';
import { Icon } from '../icons';
import { c, day, locale } from '../theme';
import { TileArt, tileColors } from './more-art';
import { GROUP_COLOR, orderedModules } from './more-catalog';

const STEP = 20;        // degrees between neighbouring modules on the wheel
const VISIBLE = 78;     // modules beyond this angle from the centre are hidden
const PX_PER_STEP = 60; // vertical drag needed to turn the wheel by one module

// Night-court scene used when there is no real photo to show.
function CourtScene({ w, h }) {
  return (
    <Svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
      <Rect width={w} height={h} fill="#1E1B4B" />
      <Circle cx={w * 0.2} cy={h * 0.1} r={h * 0.5} fill="#4F46E5" opacity={0.35} />
      <Circle cx={w * 0.85} cy={h * 0.95} r={h * 0.45} fill="#7C3AED" opacity={0.35} />
      <Path d={`M${w * 0.05} ${h * 0.72}H${w * 0.95}M${w * 0.5} ${h * 0.55}V${h * 0.96}`} stroke="#fff" strokeOpacity={0.14} strokeWidth={2} />
      <Circle cx={w * 0.5} cy={h * 0.78} r={h * 0.12} stroke="#fff" strokeOpacity={0.14} strokeWidth={2} fill="none" />
    </Svg>
  );
}

const wrap = (rel, n) => ((rel + n / 2) % n + n) % n - n / 2; // signed distance on a ring of n

/**
 * The More experience: tapping the raised centre tab button opens this full-screen wheel. Your profile sits in a big
 * circle on the left; every module is on a wheel you drag (or scroll / arrow-key) to swivel. The module at the centre
 * is enlarged; tapping it opens it. Counts come from real data and are shown on the modules themselves.
 */
export function MoreWheel() {
  const { push, goTab, closeMenu } = useNav();
  const { user } = useSession();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const dash = useLoad(() => api.get('/dashboard'), []);
  const note = useLoad(() => api.get('/notifications', { unread: true, limit: 1 }), []);
  const favs = useLoad(() => api.get('/me/favourites'), []);
  const d = dash.data, unread = note.data?.unread ?? 0;
  const next = d?.next_games?.[0];
  const photo = Array.isArray(favs.data) ? favs.data.find((v) => v.cover_url)?.cover_url : null;
  const mods = useMemo(() => orderedModules(user.roles), [user.roles]);
  const n = mods.length;

  const badges = { Insure: d?.policies_to_renew, Insurance: d?.policies_to_renew, Leaderboard: d?.pending_results };
  const lives = {
    Leaderboard: d?.pending_results > 0 ? `${d.pending_results} result${d.pending_results > 1 ? 's' : ''} waiting for approval` : null,
    Insure: d?.policies_to_renew > 0 ? `${d.policies_to_renew} to renew soon` : null,
    Health: d?.fit_to_play === 'restricted' ? 'Cleared with restrictions' : d?.fit_to_play === 'not_cleared' ? 'Not cleared to play' : d?.fit_to_play === 'cleared' ? 'Fit to play' : null,
  };

  // `pos` is the wheel's turn in modules (fractional while dragging). The module at index round(pos) is centred.
  const [pos, setPos] = useState(0);
  const rot = useRef(new Animated.Value(0)).current;
  const cur = useRef(0);
  const base = useRef(0);
  useEffect(() => { const id = rot.addListener(({ value }) => { cur.current = value; setPos(value); }); return () => rot.removeListener(id); }, [rot]);
  const spinTo = useCallback((to, vel = 0) => {
    rot.stopAnimation();
    Animated.spring(rot, { toValue: to, velocity: vel, stiffness: 140, damping: 18, mass: 0.9, useNativeDriver: false }).start();
  }, [rot]);
  const nudge = useCallback((k) => spinTo(Math.round(cur.current) + k), [spinTo]);

  // Open with a spin-in (skipped with reduced motion).
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().catch(() => false).then((reduce) => {
      if (!live) return;
      if (reduce) { fade.setValue(1); return; }
      rot.setValue(-5);
      Animated.timing(fade, { toValue: 1, duration: 260, useNativeDriver: Platform.OS !== 'web' }).start();
      spinTo(0);
    });
    return () => { live = false; };
  }, [fade, rot, spinTo]);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => { rot.stopAnimation((v) => { base.current = v; }); },
    onPanResponderMove: (_, g) => rot.setValue(base.current - g.dy / PX_PER_STEP),
    onPanResponderRelease: (_, g) => spinTo(Math.round(base.current - g.dy / PX_PER_STEP - g.vy * 0.25), -g.vy / PX_PER_STEP * 1000),
    onPanResponderTerminate: () => spinTo(Math.round(cur.current)),
  }), [rot, spinTo]);

  // Web: mouse wheel and arrow keys turn the wheel; Escape closes.
  const wheelLock = useRef(0);
  const onWheel = useCallback((e) => { const t = Date.now(); if (t - wheelLock.current < 120) return; wheelLock.current = t; nudge(e.deltaY > 0 ? 1 : -1); }, [nudge]);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); nudge(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(-1); } else if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudge, closeMenu]);

  const { w, h } = size;
  const R = Math.min(w > 700 ? 175 : 132, w * 0.36, h * 0.3), cx = R * 0.42, cy = h * 0.5, R2 = R + 62;
  const centred = ((Math.round(pos) % n) + n) % n;
  const dateLine = new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const statLine = [d?.points > 0 && `${d.points} points`, d?.trophies > 0 && `${d.trophies} trophies`].filter(Boolean).join(' · ');

  return (
    <Animated.View onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })} {...pan.panHandlers} {...(Platform.OS === 'web' ? { onWheel } : {})}
      style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 20, backgroundColor: '#1E1B4B', opacity: fade }}>
      {w ? (
        <>
          {photo ? <Image source={{ uri: mediaUrl(photo) }} resizeMode="cover" accessibilityIgnoresInvertColors style={{ position: 'absolute', width: w, height: h }} /> : <CourtScene w={w} h={h} />}
          <LinearGradient colors={['rgba(15,23,42,0.6)', 'rgba(15,23,42,0.88)']} style={{ position: 'absolute', width: w, height: h }} />
          <Svg width={w} height={h} style={{ position: 'absolute' }} pointerEvents="none">
            <Circle cx={cx} cy={cy} r={R2} stroke="#fff" strokeOpacity={0.35} strokeWidth={1.5} fill="none" />
            <Circle cx={cx} cy={cy} r={R + 14} stroke="#fff" strokeOpacity={0.18} strokeWidth={1} fill="none" />
          </Svg>

          <Pressable onPress={() => goTab('Me')} accessibilityRole="button" accessibilityLabel={`${user.display_name}. My profile, roles and settings`}
            style={{ position: 'absolute', left: cx - R, top: cy - R, width: R * 2, height: R * 2, borderRadius: R, overflow: 'hidden', borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)', backgroundColor: '#312E81' }}>
            {photo ? <Image source={{ uri: mediaUrl(photo) }} resizeMode="cover" accessibilityIgnoresInvertColors style={{ position: 'absolute', width: R * 2, height: R * 2 }} /> : <LinearGradient colors={['#4F46E5', '#7C3AED']} style={{ position: 'absolute', width: R * 2, height: R * 2 }} />}
            <LinearGradient colors={['rgba(15,23,42,0.05)', 'rgba(15,23,42,0.8)']} style={{ position: 'absolute', width: R * 2, height: R * 2 }} />
            <View style={{ position: 'absolute', left: R - cx + 14, right: 10, bottom: R * 0.36 }}>
              <View style={{ marginBottom: 8 }}><Avatar user={user} size={40} /></View>
              <T weight="800" size={20} color="#fff" numberOfLines={1} style={{ letterSpacing: -0.4 }}>{user.display_name}</T>
              <T weight="500" size={12} color="rgba(255,255,255,0.9)" numberOfLines={1}>{dateLine}</T>
              {statLine ? <T weight="700" size={13} color="#FDE68A" numberOfLines={1} style={{ marginTop: 2 }}>{statLine}</T> : null}
              {next ? <T weight="500" size={12} color="rgba(255,255,255,0.9)" numberOfLines={1} style={{ marginTop: 2 }}>{`Next: ${next.home_name ?? 'TBC'} vs ${next.away_name ?? 'TBC'} · ${day(next.scheduled_at)}`}</T> : null}
            </View>
          </Pressable>

          {mods.map(([name, title, sub, group], i) => {
            const rel = wrap(i - pos, n), a = rel * STEP;
            if (Math.abs(a) > VISIBLE) return null;
            const rad = (a * Math.PI) / 180;
            const near = Math.max(0, 1 - Math.abs(rel));       // 1 at the centre, 0 one module away
            const k = 1 - 0.38 * (Math.abs(a) / VISIBLE);      // shrink toward the arc ends
            const D = 54 * k + 22 * near;
            const x = cx + R2 * Math.cos(rad), y = cy + R2 * Math.sin(rad);
            const [from, to] = tileColors(name);
            const badge = name === 'Notifications' ? unread : badges[name];
            const isCentre = i === centred && Math.abs(rel) < 0.5;
            return (
              <Pressable key={name} onPress={() => (isCentre ? push(name) : spinTo(Math.round(pos) + Math.round(rel)))} accessibilityRole="button"
                accessibilityLabel={`${title}${badge > 0 ? `, ${badge} need attention` : ''}${isCentre ? ', selected. Tap to open' : ''}`}
                style={{ position: 'absolute', left: x - D / 2, top: y - D / 2, flexDirection: 'row', alignItems: 'center', opacity: 1 - 0.6 * (Math.abs(a) / VISIBLE), zIndex: Math.round(100 - Math.abs(a)) }}>
                <LinearGradient colors={[from, to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: D, height: D, borderRadius: D / 2, borderWidth: 2 + near * 1.5, borderColor: 'rgba(255,255,255,0.88)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  <TileArt name={name} size={D * 0.78} />
                </LinearGradient>
                {badge > 0 ? <View style={{ position: 'absolute', left: D - 14, top: -6, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: c.red, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' }}><T weight="800" size={11} color="#fff">{badge}</T></View> : null}
                <View style={{ marginLeft: 12, maxWidth: Math.max(80, w - (x + D / 2) - 24) }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: GROUP_COLOR[group] }} />
                    <T weight={isCentre ? '800' : '700'} size={13 + near * 5} color="#fff" numberOfLines={1} style={{ letterSpacing: 0.2, ...(Platform.OS === 'web' ? { textShadow: '0 1px 6px rgba(0,0,0,0.6)' } : null) }}>{title}</T>
                  </View>
                  {isCentre ? <T size={12} color="rgba(255,255,255,0.85)" numberOfLines={2} style={{ marginTop: 2 }}>{lives[name] ?? sub}</T> : null}
                </View>
              </Pressable>
            );
          })}

          <Pressable onPress={closeMenu} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={{ position: 'absolute', top: 14, right: 16, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
            <T color="#fff" weight="700" size={20}>×</T>
          </Pressable>
          <View pointerEvents="none" style={{ position: 'absolute', right: 18, bottom: 16, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T size={11} color="rgba(255,255,255,0.65)" weight="600" style={{ letterSpacing: 1 }}>DRAG TO SWIVEL</T>
          </View>
        </>
      ) : null}
    </Animated.View>
  );
}
